'use strict';

// Moon Knowledge Engine v0.9.2 — Russian-first multilingual Wiki sources
// Standalone Yandex Cloud Function. Node.js 22+, zero npm dependencies.
// Stores MediaWiki pages and a compact search index in the existing Yandex Object Storage bucket.
//
// v0.9.0 — доказательный поиск и честная готовность базы:
//   (1) парсер выбрасывает межъязыковые ссылки, галереи и служебные разделы
//       («Примечания», «Ссылки», «Навигация»), из-за которых конец статьи
//       побеждал биографию;
//   (2) текст делится на разделы, и выдержка выбирается с учётом раздела,
//       которого требует вопрос («кто такая» -> биография, «способности» ->
//       способности), а не только совпадения слов;
//   (3) оценка фрагмента стала частотной и нормированной по длине
//       (BM25-подобная), поэтому список языковых ссылок больше не выигрывает
//       у содержательного абзаца;
//   (4) варианты запроса получили явные роли, и перевод на язык вики больше
//       не может быть отброшен порядком массива;
//   (5) прогрев пишет частичный итог после каждого шага, хранит статус
//       готовности в manifest.json и отдаёт его всегда — вместо warm:null;
//   (6) план прогрева покрывает все основные игровые категории и
//       подстраивается под жанр игры;
//   (7) появился refresh по revisionId: изменившиеся статьи обновляются,
//       вся вики заново не качается;
//   (8) индекс при sync пишется слиянием, как и при прогреве.
//
// v0.6.0 — быстрый локальный режим поиска:
//   (1) search с fast:true не ходит в вики, не переводит запрос в сеть,
//       не читает лишние страницы и не перезаписывает индекс;
//   (2) результат быстрого поиска кэшируется в памяти тёплого экземпляра.
//       Это нужно, чтобы ответ укладывался в реплику Алисы (~4,5 с).
//   (3) обычный режим (без fast) работает как раньше, без изменений.
//
// v0.7.0 — универсальная база и вопросы «по смыслу»:
//   (1) action:warm — по названию любой игры находит вики, регистрирует и
//       подтягивает обзорные статьи (персонажи, локации, механики, сюжет),
//       чтобы база была тёплой к началу игры;
//   (2) вопрос получает намерение (characters/locations/items/mechanics/story)
//       и обзорная статья подмешивается к выдаче даже без совпадения слов;
//   (3) «что лучше: X или Y» разбирается на две сущности и обе ищутся отдельно;
//   (4) пустой локальный ответ больше не заставляет ходить в вики на каждый
//       русский вопрос: эскалация только при слабой выдаче.
//
// v0.9.2 — русскоязычный источник в приоритете, английский как резерв.
//   (1) для существующей игры автоматически проверяется локализованный
//       MediaWiki API на том же хосте (/ru/api.php);
//   (2) русский и исходный языковой индексы/страницы хранятся раздельно
//       внутри одного канонического gameId — pageId разных Wiki не конфликтуют;
//   (3) сначала ищется и сохраняется доказательство из русской Wiki;
//       если его нет/источник недоступен — используется исходная Wiki;
//   (4) существующие manifest/index/pages исходного языка не мигрируются
//       и не перезаписываются; переменные окружения не меняются.
//
// v0.8.0 — прогрев можно безопасно запускать в фоне:
//   (1) замок warm-lock.json не даёт двум вызовам качать одну игру дважды;
//   (2) индекс пишется слиянием, чтобы параллельный поиск и прогрев не теряли
//       страницы друг друга.

const crypto = require('crypto');

const KB_VERSION = '0.9.3';

// Быстрый режим: только локальный индекс, без сети и без записи в S3.
const FAST_CANDIDATE_LIMIT = 10;
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX = 240;
const SEARCH_CACHE = new Map();
const LANGUAGE_SOURCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN = process.env.KB_TOKEN || '';
const BUCKET = process.env.KB_BUCKET || process.env.BUCKET || 'moon-assistant';
const S3_ID = process.env.ACCESS_KEY_ID || '';
const S3_SECRET = process.env.SECRET_ACCESS_KEY || '';
const REGION = process.env.S3_REGION || 'ru-central1';
const PREFIX = (process.env.KB_PREFIX || 'kb').replace(/^\/+|\/+$/g, '');
const FETCH_TIMEOUT_MS = Number(process.env.KB_FETCH_TIMEOUT_MS || 12000);
const MAX_BATCH = Math.min(50, Math.max(1, Number(process.env.KB_BATCH_SIZE || 20)));
const MAX_PAGES = Math.min(50000, Math.max(100, Number(process.env.KB_MAX_PAGES || 12000)));
const MAX_QUERY = 240;
const ON_DEMAND_SEARCH_LIMIT = 5;
const MAX_QUERY_VARIANTS = 6;
// Тёплая база: обзорные статьи по игре и бюджет на их загрузку.
const WARM_PAGES_PER_QUERY = 3;
const WARM_FORCED_PAGES = 3;
// Минимум страниц и разделов, при которых база считается готовой к быстрым
// ответам. Одного manifest.json со status:complete для этого мало.
const WARM_MIN_PAGES = Math.max(3, Number(process.env.KB_WARM_MIN_PAGES || 6));
const WARM_MIN_SECTIONS = 2;
const WARM_MAX_STEPS = Math.min(
  16,
  Math.max(4, Number(process.env.KB_WARM_MAX_STEPS || 9))
);
const WARM_LOCK_MS = Math.max(30000, Number(process.env.KB_WARM_LOCK_MS || 120000));
const WARM_BUDGET_MS = Math.min(
  90000,
  Math.max(5000, Number(process.env.KB_WARM_BUDGET_MS || 35000))
);
const KB_WARM_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.KB_WARM_TTL_MS || 12 * 3600 * 1000)
);
const MAX_PAGE_TEXT = Math.min(50000, Math.max(5000, Number(process.env.KB_MAX_PAGE_TEXT || 30000)));
const MAX_ENRICH_PAGES = Math.min(8, Math.max(1, Number(process.env.KB_MAX_ENRICH_PAGES || 5)));
const MAX_PARSE_FALLBACK_PAGES = 2;

const CONTACT = String(process.env.KB_CONTACT || '').trim();
const UA = 'MoonKnowledgeEngine/0.9.3 (Russian-first universal multilingual game knowledge' +
  (CONTACT ? '; contact: ' + CONTACT : '') + ')';
const TRANSLATION_TIMEOUT_MS = Math.min(9000, Math.max(2000, Number(process.env.KB_TRANSLATION_TIMEOUT_MS || 5500)));
const DISCOVERY_TIMEOUT_MS = Number(process.env.KB_DISCOVERY_TIMEOUT_MS || 9000);
const DISCOVERY_MAX_CANDIDATES = 6;
const CATALOG = [];

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));

  return x.length === y.length &&
    x.length > 0 &&
    crypto.timingSafeEqual(x, y);
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
const SEARCH_STOP_WORDS = new Set((
  'а без более бы был была были было быть в вам вас весь во вот все всего всех вы где да даже для до его ее если есть еще же за здесь и из или им их к как ко когда кто ли либо мне может мы на над надо наш не него нее нет ни них но ну о об один она они оно от потому по под при про с со так также такой там те тем то того тоже той только том ты у уже чем что чтобы эта эти это я этот эту ' +
  'a an and are as at be been being but by can could did do does doing for from had has have he her hers him his how i if in into is it its may me might mine my no nor not of off on once only or other our ours she should so some such than that the their theirs them then there these they this those through to too under until up very was we were what when where which who whom why will with would you your yours'
).split(/\s+/));

function stemSearchToken(raw) {
  let token=normalize(raw);
  if(token.length<5)return token;

  if(/[а-я]/i.test(token)){
    const suffixes=['иями','ями','ами','иях','ией','ию','ии','ия','ого','ему','ому','ыми','ими','его','ую','юю','ая','яя','ое','ее','ые','ие','ым','им','ом','ем','ов','ев','ей','ья','ах','ях','ам','ям','ы','и','а','я','у','ю','е','о'];
    for(const suffix of suffixes){
      if(token.endsWith(suffix)&&token.length-suffix.length>=3){
        token=token.slice(0,-suffix.length);
        break;
      }
    }
  }else{
    const suffixes=['ingly','edly','ments','ment','ation','ations','ing','ers','ies','ied','ed','es','s'];
    for(const suffix of suffixes){
      if(token.endsWith(suffix)&&token.length-suffix.length>=3){
        token=token.slice(0,-suffix.length);
        if(suffix==='ies'||suffix==='ied')token+='y';
        break;
      }
    }
  }

  return token;
}

function searchTokens(value){
  const raw=normalize(value).split(' ').filter(Boolean);
  const out=[];
  const seen=new Set();

  for(const token of raw){
    if(token.length<2||SEARCH_STOP_WORDS.has(token))continue;

    for(const candidate of [token,stemSearchToken(token)]){
      if(candidate.length<2||seen.has(candidate))continue;
      seen.add(candidate);
      out.push(candidate);
    }
  }

  return out;
}

function isRealNameIntent(query){
  const q=normalize(query);

  return /(?:\breal name\b|\bbirth name\b|\bfull name\b|\bgiven name\b|\blegal name\b|\bborn as\b|настоящ[\p{L}]*\s+им[\p{L}]*|полны[\p{L}]*\s+им[\p{L}]*|им[\p{L}]*\s+при\s+рожд[\p{L}]*|как\s+зовут|как\s+звали|реальн[\p{L}]*\s+им[\p{L}]*)/u.test(q);
}

function isEpitaphIntent(query) {
  const q = normalize(query);
  return /\b(epitaph|inscription|tombstone|gravestone)\b|эпитаф|надпис/u.test(q);
}

function queryHintTerms(query) {
  const hints = [];

  if (isRealNameIntent(query)) {
    hints.push(
      'real name', 'birth name', 'full name', 'given name', 'legal name',
      'born as', 'настоящее имя', 'полное имя'
    );
  }

  if (isEpitaphIntent(query)) {
    hints.push(
      'epitaph', 'inscription', 'tombstone', 'gravestone',
      'memorial plaque', 'эпитафия', 'эпитафии', 'надпись'
    );
  }

  return hints;
}

// ---------- разделы статьи ----------
// Вики-текст приходит без разметки заголовков, поэтому заголовок узнаётся по
// форме строки: короткая, без завершающей точки, отделена пустой строкой и
// либо входит в известный список, либо написана как заголовок.
// Смысл: поиск должен знать, что найденный фрагмент относится к «Биографии»,
// а не к «Ссылкам», и уметь выбрать нужный раздел под вопрос.

const SERVICE_HEADINGS = new Set([
  'примечания', 'примечание', 'ссылки', 'внешние ссылки', 'источники',
  'литература', 'навигация', 'галерея', 'см также', 'смотри также',
  'появления', 'озвучка', 'озвучивание', 'дубляж', 'технические детали',
  'references', 'reference', 'external links', 'external link', 'links',
  'notes', 'footnotes', 'citations', 'sources', 'bibliography', 'gallery',
  'navigation', 'see also', 'appearances', 'voice cast', 'credits'
]);

const SECTION_GROUPS = [
  {
    name: 'biography',
    headings: [
      'биография', 'ранние годы', 'ранняя жизнь', 'детство', 'прошлое',
      'история', 'сюжет', 'биография и история', 'жизнь', 'предыстория',
      'biography', 'early life', 'history', 'background', 'story', 'plot',
      'synopsis', 'life'
    ]
  },
  {
    name: 'personality',
    headings: [
      'характер', 'личность', 'внешность', 'описание', 'поведение',
      'personality', 'appearance', 'character', 'traits', 'design'
    ]
  },
  {
    name: 'abilities',
    headings: [
      'способности', 'навыки', 'умения', 'силы', 'приёмы', 'боевые качества',
      'abilities', 'skills', 'powers', 'moves', 'combat', 'perks'
    ]
  },
  {
    name: 'equipment',
    headings: [
      'снаряжение', 'экипировка', 'оружие', 'инвентарь', 'предметы',
      'equipment', 'gear', 'weapons', 'inventory', 'items'
    ]
  },
  {
    name: 'relations',
    headings: [
      'отношения', 'семья', 'друзья', 'союзники', 'relationships', 'family',
      'affiliations', 'allies'
    ]
  },
  {
    name: 'gameplay',
    headings: [
      'игровой процесс', 'механика', 'механики', 'геймплей', 'управление',
      'прокачка', 'система', 'gameplay', 'mechanics', 'controls',
      'progression', 'system'
    ]
  },
  {
    name: 'stats',
    headings: [
      'характеристики', 'параметры', 'статистика', 'свойства', 'урон',
      'stats', 'statistics', 'attributes', 'damage', 'properties'
    ]
  },
  {
    name: 'quests',
    headings: [
      'квесты', 'задания', 'миссии', 'сюжетные линии', 'quests', 'missions',
      'objectives', 'walkthrough'
    ]
  },
  {
    name: 'location',
    headings: [
      'районы', 'области', 'география', 'климат', 'население', 'экономика',
      'districts', 'regions', 'geography', 'climate', 'population', 'economy'
    ]
  }
];

const SECTION_GROUP_BY_HEADING = (() => {
  const map = new Map();

  for (const group of SECTION_GROUPS) {
    for (const heading of group.headings) {
      map.set(normalize(heading), group.name);
    }
  }

  return map;
})();

// Какие разделы нужны вопросу. Первый совпавший набор побеждает.
const INTENT_SECTION_HINTS = [
  {
    test: /(кто\s+(?:такая|такой|такие)|биограф|откуда\s+родом|как\s+зовут|настоящ[\p{L}]*\s+им|сколько\s+лет|who\s+is|biography|background)/u,
    sections: ['lead', 'biography', 'personality']
  },
  {
    test: /(характер|личность|нрав|что\s+за\s+человек|personality|traits)/u,
    sections: ['personality', 'biography']
  },
  {
    test: /(способност|умени|навык|сил[аы]|приём|прием|что\s+умеет|abilities|skills|powers|perks)/u,
    sections: ['abilities', 'gameplay']
  },
  {
    test: /(оружи|снаряжен|экипиров|инвентар|что\s+носит|equipment|gear|weapons)/u,
    sections: ['equipment', 'stats']
  },
  {
    test: /(характеристик|урон|параметр|статистик|stats|damage|лучше|сравн)/u,
    sections: ['stats', 'gameplay']
  },
  {
    test: /(квест|задани|мисси|прохожден|quest|mission)/u,
    sections: ['quests', 'biography']
  },
  {
    test: /(где\s+найти|где\s+находит|локаци|район|город|регион|карт|where|location|district)/u,
    sections: ['location', 'biography']
  },
  {
    test: /(как\s+работает|как\s+устроен|механик|прокачк|систем|gameplay|mechanics)/u,
    sections: ['gameplay', 'stats']
  },
  {
    test: /(отношени|семь|друз|союзник|relationships|family)/u,
    sections: ['relations', 'biography']
  }
];

function intentSectionHints(query) {
  const q = normalize(query);

  for (const hint of INTENT_SECTION_HINTS) {
    if (hint.test.test(q)) return hint.sections;
  }

  return [];
}

function sectionGroupOf(heading) {
  return SECTION_GROUP_BY_HEADING.get(normalize(heading)) || '';
}

function isServiceHeading(line) {
  const h = normalize(line).replace(/[.:]+$/, '');

  if (!h || h.length > 60) return false;

  return SERVICE_HEADINGS.has(h);
}

// Заголовок без разметки: короткая строка без завершающей точки, отделённая
// пустыми строками. Известные заголовки принимаются всегда, остальные —
// только если написаны как заголовок (с большой буквы, мало слов).
function looksLikeHeading(line, prevBlank, nextBlank) {
  const s = String(line || '').trim();

  if (!s || s.length < 2 || s.length > 60) return false;
  if (!prevBlank) return false;
  if (/[.!?,;:]$/.test(s)) return false;
  if (/^[•\-–—*#>|]/.test(s)) return false;
  if (/^\d+$/.test(s)) return false;

  const words = s.split(/\s+/);

  if (words.length > 6) return false;

  const known = sectionGroupOf(s) || isServiceHeading(s);

  // Известный заголовок в текстовой выгрузке идёт сразу за ним без пустой
  // строки («Биография» и следующая строка), поэтому nextBlank не требуем.
  if (known) return true;
  if (!nextBlank) return false;

  // «Ранняя жизнь и семья» — заголовок, «Она работает в мастерской» — нет.
  const capitalised = words.filter(w => /^[\p{Lu}\p{N}]/u.test(w)).length;

  return capitalised >= Math.ceil(words.length * 0.6);
}

// Делит текст статьи на разделы. Первый раздел — лид без заголовка.
function splitSections(text) {
  const clean = stripHtml(text)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!clean) return [];

  const lines = clean.split('\n');
  const sections = [];
  let heading = '';
  let buf = [];

  const flush = () => {
    const body = buf.join('\n').trim();

    if (body) {
      sections.push({
        heading: heading,
        group: heading ? sectionGroupOf(heading) : 'lead',
        service: heading ? isServiceHeading(heading) : false,
        text: body
      });
    }

    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prevBlank = i === 0 || !lines[i - 1].trim();
    const nextBlank = i === lines.length - 1 || !lines[i + 1].trim();

    if (looksLikeHeading(line, prevBlank, nextBlank)) {
      flush();
      heading = line.trim();
      continue;
    }

    buf.push(line);
  }

  flush();

  return sections.filter(s => !s.service);
}

// Оконные фрагменты внутри раздела: выдержка не должна обрывать мысль.
function chunkSectionText(text, maxChars, overlap) {
  const clean = String(text || '').trim();

  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const out = [];
  let start = 0;

  while (start < clean.length && out.length < 40) {
    let end = Math.min(clean.length, start + maxChars);

    if (end < clean.length) {
      const boundary = clean.lastIndexOf('\n', end);
      if (boundary > start + Math.floor(maxChars * 0.6)) end = boundary;
    }

    const part = clean.slice(start, end).trim();
    if (part) out.push(part);

    if (end >= clean.length) break;
    start = Math.max(start + 1, end - overlap);
  }

  return out;
}

// Фрагменты с указанием раздела — основа выбора доказательства.
function makeSectionChunks(text, maxChars, overlap) {
  const sections = splitSections(text);
  const out = [];

  for (const section of sections) {
    for (const part of chunkSectionText(section.text, maxChars, overlap)) {
      out.push({
        text: part,
        section: section.heading,
        group: section.group
      });
    }
  }

  return out;
}


// «Кто главные герои», «что это за локация», «что лучше: X или Y» нельзя
// обслужить совпадением слов: ответ часто лежит в обзорной статье
// («Персонажи», «Локации»), где слов вопроса может не быть вовсе.
// Намерение расширяет запрос обзорными терминами и подтягивает такие статьи,
// а модель уже смешивает сведения из нескольких источников в один ответ.

// ---------- намерение вопроса ----------
// «Кто главные герои», «что это за локация», «что лучше: X или Y» нельзя
// обслужить совпадением слов: ответ часто лежит в обзорной статье
// («Персонажи», «Локации»), где слов вопроса может не быть вовсе.
// Намерение расширяет запрос обзорными терминами и подтягивает такие статьи,
// а модель уже смешивает сведения из нескольких источников в один ответ.

const INTENT_RULES = [
  {
    name: 'characters',
    section: 'characters',
    re: /(главн[\p{L}]*\s+геро|геро[\p{L}]*|персонаж[\p{L}]*|протагонист[\p{L}]*|антагонист[\p{L}]*|злоде[\p{L}]*|босс[\p{L}]*|кто\s+(?:это|он|она|они|такой|такая|такие)|второстепенн[\p{L}]*|\bnpc\b|\bcharacter|\bprotagonis|\bantagonis|\bvillain|\bcast\b)/u,
    title: /(персонаж|геро|character|protagonis|antagonis|\bcast\b|список)/iu,
    queries: {
      ru: ['персонажи', 'главный герой'],
      en: ['characters', 'main characters']
    }
  },
  {
    name: 'locations',
    section: 'locations',
    re: /(локаци[\p{L}]*|местност[\p{L}]*|мир[аеу]?|карт[аеуы]|регион[\p{L}]*|зон[аыуе]|город[\p{L}]*|планет[\p{L}]*|\blocation|\bregion\b|\bworld\b|\bmap\b|\barea\b)/u,
    title: /(локаци|местност|\blocation|\bregion\b|\bworld\b|\bmap\b|\barea\b)/iu,
    queries: {
      ru: ['локации', 'мир игры'],
      en: ['locations', 'world']
    }
  },
  {
    name: 'items',
    section: 'items',
    re: /(предмет[\p{L}]*|оружи[\p{L}]*|брон[\p{L}]*|экипиров[\p{L}]*|артефакт[\p{L}]*|зель[\p{L}]*|ресурс[\p{L}]*|\bitem|\bweapon|\barmou?r|\bequipment|\bartifact)/u,
    title: /(предмет|оружи|экипиров|\bitem|\bweapon|\barmou?r|\bequipment)/iu,
    queries: {
      ru: ['предметы', 'оружие'],
      en: ['items', 'weapons']
    }
  },
  {
    name: 'mechanics',
    section: 'mechanics',
    re: /(механик[\p{L}]*|систем[\p{L}]*|прокачк[\p{L}]*|уровн[\p{L}]*|умени[\p{L}]*|навык[\p{L}]*|класс[\p{L}]*|крафт[\p{L}]*|\bmechanic|\bsystem\b|\blevel|\bskill|\bclass\b|\bcraft)/u,
    title: /(механик|систем|прокачк|\bmechanic|\bsystem\b|\bgameplay)/iu,
    queries: {
      ru: ['игровой процесс', 'механики'],
      en: ['gameplay', 'mechanics']
    }
  },
  {
    name: 'story',
    section: 'story',
    re: /(сюжет[\p{L}]*|истори[\p{L}]*|финал[\p{L}]*|концовк[\p{L}]*|\bplot\b|\bstory\b|\bending)/u,
    title: /(сюжет|истори|\bplot\b|\bstory\b)/iu,
    queries: {
      ru: ['сюжет', 'концовки'],
      en: ['plot', 'endings']
    }
  }
];

function detectIntent(query) {
  const q = normalize(query);

  if (!q) return { name: 'general', section: '', title: null };

  for (const rule of INTENT_RULES) {
    if (rule.re.test(q)) {
      return { name: rule.name, section: rule.section, title: rule.title };
    }
  }

  return { name: 'general', section: '', title: null };
}

function intentQueryTerms(name, language) {
  const rule = INTENT_RULES.find(r => r.name === name);

  if (!rule) return [];

  const lang = String(language || 'en').toLowerCase().slice(0, 2);
  const list = rule.queries[lang] || rule.queries.en || [];

  return list.slice(0, 2);
}

// Что загрузить в тёплую базу: сама игра плюс обзорные статьи по всем
// основным игровым категориям. Список игр не задаётся — категории
// универсальны, а порядок подстраивается под жанр игры.
const WARM_CATEGORIES = [
  {
    section: 'world',
    ru: ['мир игры', 'сеттинг'],
    en: ['setting', 'world'],
    genres: ['rpg', 'shooter', 'strategy', 'survival', 'simulator', 'action']
  },
  {
    section: 'characters',
    ru: ['персонажи'],
    en: ['characters'],
    genres: ['rpg', 'action', 'shooter', 'adventure']
  },
  {
    section: 'locations',
    ru: ['локации'],
    en: ['locations'],
    genres: ['rpg', 'action', 'shooter', 'strategy', 'simulator', 'survival']
  },
  {
    section: 'mechanics',
    ru: ['игровой процесс', 'механики'],
    en: ['gameplay', 'mechanics'],
    genres: ['rpg', 'strategy', 'simulator', 'survival', 'action', 'shooter']
  },
  {
    section: 'items',
    ru: ['предметы', 'оружие'],
    en: ['weapons', 'items'],
    genres: ['rpg', 'shooter', 'action', 'survival']
  },
  {
    section: 'skills',
    ru: ['навыки', 'прокачка'],
    en: ['skills', 'perks'],
    genres: ['rpg', 'action']
  },
  {
    section: 'quests',
    ru: ['квесты', 'задания'],
    en: ['quests', 'missions'],
    genres: ['rpg', 'adventure', 'action']
  },
  {
    section: 'factions',
    ru: ['фракции'],
    en: ['factions'],
    genres: ['rpg', 'shooter', 'strategy']
  },
  {
    section: 'story',
    ru: ['сюжет', 'концовки'],
    en: ['plot', 'endings'],
    genres: ['rpg', 'adventure', 'action']
  },
  {
    section: 'transport',
    ru: ['транспорт'],
    en: ['vehicles'],
    genres: ['shooter', 'simulator', 'action']
  },
  {
    section: 'resources',
    ru: ['ресурсы', 'материалы'],
    en: ['resources', 'crafting'],
    genres: ['survival', 'strategy', 'simulator', 'rpg']
  },
  {
    section: 'units',
    ru: ['юниты', 'армия'],
    en: ['units', 'army'],
    genres: ['strategy']
  },
  {
    section: 'economy',
    ru: ['экономика', 'торговля'],
    en: ['economy', 'trading'],
    genres: ['strategy', 'simulator']
  },
  {
    section: 'secrets',
    ru: ['секреты'],
    en: ['secrets', 'easter eggs'],
    genres: ['rpg', 'action', 'shooter', 'survival', 'simulator', 'strategy']
  }
];

// Жанр нужен только для порядка категорий: он не ограничивает базу.
const GENRE_SIGNS = {
  rpg: /(опыт|уровень|класс|квест|инвентар|навык|перк|характеристик|experience|level|class|quest|inventory|skill|perk|stat)/iu,
  shooter: /(оружи|патрон|стрельб|прицел|перестрел|weapon|ammo|shoot|aim|gun)/iu,
  strategy: /(юнит|армия|постройк|ресурс|экономик|территори|unit|army|build|resource|econom|territor)/iu,
  simulator: /(ферм|урожай|производств|экономик|бюджет|farm|crop|production|econom|budget|manage)/iu,
  survival: /(выжива|голод|крафт|ресурс|постройк|survival|hunger|craft|resource|base build)/iu,
  action: /(бой|сражени|удар|комбо|combat|fight|attack|combo|battle)/iu,
  adventure: /(головоломк|диалог|исследован|puzzle|dialogue|explore|adventure)/iu
};

function detectGenre(text) {
  const t = String(text || '');
  let best = '';
  let bestHits = 0;

  for (const [genre, re] of Object.entries(GENRE_SIGNS)) {
    const hits = (t.match(new RegExp(re.source, 'giu')) || []).length;

    if (hits > bestHits) {
      best = genre;
      bestHits = hits;
    }
  }

  return bestHits >= 2 ? best : '';
}

function warmPlan(game, language, genre) {
  const lang = String(language || 'en').toLowerCase().slice(0, 2);
  const plan = [
    { section: 'main', query: String(game || '').slice(0, 100) }
  ];

  const ordered = WARM_CATEGORIES.slice().sort((a, b) => {
    const aHit = a.genres.includes(genre) ? 1 : 0;
    const bHit = b.genres.includes(genre) ? 1 : 0;

    return bHit - aHit;
  });

  for (const category of ordered) {
    const terms = category[lang] || category.en || [];
    if (terms.length) plan.push({ section: category.section, query: terms[0] });
  }

  return plan.filter(step => step.query).slice(0, WARM_MAX_STEPS + 1);
}

// ---------- сравнение двух объектов ----------

const COMPARE_MARK_RE = /(лучше|хуже|сильнее|слабее|полезнее|выгоднее|сравн|выбрать|выбери|что\s+взять|что\s+брать|что\s+качать|стоит\s+ли|предпочт)/iu;
const COMPARE_SPLIT_RE = /\s+(?:или|либо|vs\.?|против)\s+/iu;
const COMPARE_LEAD_RE = /^(?:а|и|но|ну)\s+/iu;
const COMPARE_WORD_RE = /^(?:что|кто|какой|какая|какое|какие|чем|лучше|хуже|сильнее|слабее|полезнее|выгоднее|сравни|сравните|выбрать|выбери|посоветуй|подскажи|стоит\s+(?:ли\s+)?(?:брать|взять|качать))\s+/iu;

function cleanCompareSide(value) {
  let s = String(value || '').replace(/\s+/g, ' ').trim();
  let prev;

  do {
    prev = s;
    s = s.replace(COMPARE_LEAD_RE, '').replace(COMPARE_WORD_RE, '').trim();
  } while (s !== prev);

  return s
    .replace(/^[\s—–:,\-]+/u, '')
    .replace(/[?!.,;:]+$/u, '')
    .trim();
}

// «что лучше — меч или топор» -> {entities:['меч','топор']}.
// Обычный «где найти меч или топор» не является сравнением: нужен маркер выбора.
function splitComparison(query) {
  const raw = String(query || '').replace(/\s+/g, ' ').trim();

  if (raw.length < 6 || !COMPARE_MARK_RE.test(raw)) return null;

  const parts = raw.split(COMPARE_SPLIT_RE);

  if (parts.length !== 2) return null;

  const entities = parts.map(cleanCompareSide);

  if (entities.some(e => e.length < 2 || e.length > 60)) return null;
  if (normalize(entities[0]) === normalize(entities[1])) return null;

  return { raw: raw, entities: entities };
}

function slug(s) {
  return normalize(s).replace(/ /g, '-').slice(0, 80) || 'unknown-game';
}

function enc(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g,
    c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function s3Key(key) {
  return PREFIX + '/' + key.split('/').map(enc).join('/');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

async function s3(method, key, body, contentType) {
  if (!S3_ID || !S3_SECRET || !BUCKET) {
    throw new Error('Object Storage credentials are not configured');
  }

  const host = 'storage.yandexcloud.net';
  const payload = body || Buffer.alloc(0);
  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const uri = '/' + enc(BUCKET) + '/' + s3Key(key);
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders =
    'host:' + host +
    '\nx-amz-content-sha256:' + payloadHash +
    '\nx-amz-date:' + amzDate + '\n';

  const canonicalRequest = [
    method,
    uri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const scope = dateStamp + '/' + REGION + '/s3/aws4_request';

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')
  ].join('\n');

  const kDate = hmac('AWS4' + S3_SECRET, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');

  const headers = {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    'Authorization':
      'AWS4-HMAC-SHA256 Credential=' + S3_ID + '/' + scope +
      ', SignedHeaders=' + signedHeaders +
      ', Signature=' + hmac(kSigning, stringToSign, 'hex')
  };

  if (method === 'PUT') {
    headers['Content-Type'] = contentType || 'application/octet-stream';
  }

  const res = await fetch('https://' + host + uri, {
    method,
    headers,
    body: method === 'PUT' ? payload : undefined,
    signal: AbortSignal.timeout(8000)
  });

  return {
    status: res.status,
    etag: res.headers.get('etag') || '',
    body: Buffer.from(await res.arrayBuffer())
  };
}

async function readJson(key) {
  const r = await s3('GET', key);

  if (r.status === 404) return null;

  if (r.status !== 200) {
    throw new Error('Object Storage GET ' + r.status + ' for ' + key);
  }

  return JSON.parse(r.body.toString('utf8'));
}

// Индекс могут писать одновременно поиск и прогрев. Перед записью перечитываем
// его и сливаем по pageId, чтобы добавленные соседом страницы не потерялись.
async function writeIndexMerged(id, index) {
  const fresh = await readJson(indexKey(id)).catch(() => null);
  const items = new Map();

  for (const item of (fresh && fresh.items) || []) {
    if (item && item.pageId !== undefined) items.set(item.pageId, item);
  }

  for (const item of (index && index.items) || []) {
    if (item && item.pageId !== undefined) items.set(item.pageId, item);
  }

  const merged = Object.assign({}, fresh || {}, {
    schemaVersion: (fresh && fresh.schemaVersion) || 1,
    items: Array.from(items.values())
  });

  await writeJson(indexKey(id), merged);

  if (index) index.items = merged.items;

  return merged.items.length;
}

async function writeJson(key, value) {
  const r = await s3(
    'PUT',
    key,
    Buffer.from(JSON.stringify(value), 'utf8'),
    'application/json; charset=utf-8'
  );

  if (r.status < 200 || r.status >= 300) {
    throw new Error('Object Storage PUT ' + r.status + ' for ' + key);
  }
}

function gameRoot(id) {
  return 'games/' + id;
}

function manifestKey(id) {
  return gameRoot(id) + '/manifest.json';
}

function indexKey(id) {
  return gameRoot(id) + '/index.json';
}

function aliasesKey(id) {
  return gameRoot(id) + '/aliases.json';
}

function pageKey(id, pageId) {
  return gameRoot(id) + '/pages/' + String(pageId) + '.json';
}

// Внутренний namespace источника — часть одного gameId, а не отдельная игра.
// Старые index.json/pages исходного языка сохраняются без миграции.
function languageSourceStorageId(gameId, language) {
  const lang = String(language || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!lang || lang.length > 12) throw new Error('Invalid source language');
  return String(gameId) + '/sources/' + lang;
}

function localizedWikiApiCandidates(source, language) {
  const lang = String(language || '').toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(lang)) return [];

  try {
    const base = new URL(source && (source.server || source.api));
    const current = new URL(source && source.api);
    if (base.protocol !== 'https:' || current.protocol !== 'https:' ||
        base.hostname.toLowerCase() !== current.hostname.toLowerCase() ||
        !allowedWikiHost(base.hostname)) return [];

    const origin = base.origin;
    const host = base.hostname.toLowerCase();
    const out = [];

    if (lang === 'en') {
      out.push(origin + '/api.php', origin + '/w/api.php');
    }

    out.push(origin + '/' + lang + '/api.php', origin + '/' + lang + '/w/api.php');

    // Fandom/wiki.gg держат языковые вики на поддомене: ru.<host>.fandom.com,
    // а не в каталоге /ru/. Без этого русская вики не подключалась никогда.
    if (/\.fandom\.com$|\.wiki\.gg$/.test(host)) {
      const langHost = lang + '.' + host;
      if (allowedWikiHost(langHost)) {
        out.push('https://' + langHost + '/api.php');
        out.push('https://' + langHost + '/w/api.php');
      }
    }

    return out;
  } catch {
    return [];
  }
}

function languageSourceCacheFresh(record, now = Date.now()) {
  const checked = Date.parse(record && record.checkedAt || '');
  return Number.isFinite(checked) && now - checked >= 0 &&
    now - checked < LANGUAGE_SOURCE_TTL_MS;
}

// Обзорные статьи игры: какие страницы относятся к персонажам, локациям и т.д.
function warmKey(id) {
  return gameRoot(id) + '/warm.json';
}

// Замок прогрева: два запроса могут прийти одновременно (выбор игры и первый
// вопрос). Без него обе invocation тянули бы вики и дважды писали в хранилище.
function warmLockKey(id) {
  return gameRoot(id) + '/warm-lock.json';
}

function allowedWikiHost(host) {
  const h = String(host || '').toLowerCase();

  const extra = String(process.env.KB_ALLOWED_WIKI_HOSTS || '')
    .split(',')
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);

  const allow = [
    'fandom.com',
    'wiki.gg',
    'minecraft.wiki',
    'stardewvalleywiki.com',
    'mediawiki.org',
    'fextralife.com',
    'strategywiki.org',
    'bulbagarden.net'
  ];

  return extra.some(x => h === x || h.endsWith('.' + x)) ||
    allow.some(x => h === x || h.endsWith('.' + x));
}

function validateApiUrl(raw) {
  const u = new URL(raw);

  if (u.protocol !== 'https:' || !allowedWikiHost(u.hostname)) {
    throw new Error('Wiki API host is not on the HTTPS allowlist');
  }

  if (u.username || u.password || u.port) {
    throw new Error('Wiki API URL must not contain credentials or a custom port');
  }

  return u;
}

async function wikiGet(apiUrl, params, timeoutMs = FETCH_TIMEOUT_MS) {
  const u = validateApiUrl(apiUrl);

  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, String(v));
  }

  const res = await fetch(u.toString(), {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json'
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error'
  });

  if (!res.ok) {
    throw new Error('Wiki API HTTP ' + res.status);
  }

  const data = await res.json();

  if (data && data.error) {
    throw new Error(
      'Wiki API: ' +
      String(data.error.info || data.error.code || 'unknown error').slice(0, 180)
    );
  }

  return data;
}

async function verifyWiki(apiUrl) {
  const data = await wikiGet(apiUrl, {
    action: 'query',
    meta: 'siteinfo',
    siprop: 'general',
    format: 'json',
    formatversion: 2
  });

  const general = data && data.query && data.query.general;

  if (!general || !general.server || !general.sitename) {
    throw new Error('This endpoint did not identify itself as a MediaWiki API');
  }

  return {
    siteName: String(general.sitename).slice(0, 160),
    server: String(general.server).slice(0, 300),
    generator: String(general.generator || '').slice(0, 100),
    language: String(general.lang || '').slice(0, 20)
  };
}

function extraCatalog() {
  try {
    const value = JSON.parse(process.env.KB_WIKI_CATALOG_JSON || '[]');

    return Array.isArray(value)
      ? value.filter(x => x && x.api && (x.game || x.id || x.names))
      : [];
  } catch {
    return [];
  }
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function unwrapSearchUrl(raw) {
  try {
    let u = new URL(decodeHtml(raw), 'https://html.duckduckgo.com');

    if (u.hostname.endsWith('duckduckgo.com') && u.pathname.includes('/l/')) {
      const target = u.searchParams.get('uddg');
      if (target) u = new URL(target);
    }

    return u;
  } catch {
    return null;
  }
}

// Оценка кандидата: подтверждаем, что это MediaWiki нужной игры, а не
// случайная страница поиска. Один и тот же код используется и для догадок
// по адресу (cyberpunk.fandom.com), и для результатов веб-поиска.
async function probeWiki(api, game) {
  const info = await verifyWiki(api);

  const search = await wikiGet(api, {
    action: 'query',
    list: 'search',
    srsearch: game,
    srlimit: 8,
    srprop: 'size|wordcount',
    format: 'json',
    formatversion: 2
  });

  const hits = (
    search && search.query && search.query.search || []
  ).map(x => String(x.title || '')).slice(0, 8);

  const tokens = normalize(game).split(' ').filter(x => x.length > 1);
  const host = new URL(api).hostname;
  const siteText = normalize(host + ' ' + info.siteName);
  const siteMatches = tokens.filter(t => siteText.includes(t)).length;

  const titleMatches = hits.filter(title =>
    tokens.filter(t => normalize(title).includes(t)).length >=
    Math.max(1, Math.min(2, tokens.length))
  ).length;

  return {
    api: api,
    ...info,
    score: siteMatches * 3 + titleMatches * 2,
    matchingPages: hits.slice(0, 5)
  };
}

// Догадки по адресу: вики игр почти всегда живут на <slug>.fandom.com
// или <slug>.wiki.gg. Это дешевле и надёжнее, чем поиск в интернете,
// и не требует списка поддерживаемых игр.
function slugVariants(game) {
  const base = normalize(game);
  const out = new Set([
    base.replace(/ /g, ''),
    base.replace(/ /g, '-'),
    base.replace(/ /g, '_')
  ]);

  const stripped = base.replace(/^(?:the|a|an)\s+/, '');
  out.add(stripped.replace(/ /g, ''));
  out.add(stripped.replace(/ /g, '-'));

  const noYear = stripped.replace(/\b(19|20)\d{2}\b/g, '').trim();
  out.add(noYear.replace(/ /g, ''));
  out.add(noYear.replace(/ /g, '-'));

  return Array.from(out)
    .filter(x => /^[a-z0-9_-]{3,40}$/.test(x))
    .slice(0, 6);
}

async function guessWikiCandidates(game) {
  const hosts = [];

  for (const s of slugVariants(game)) {
    hosts.push(s + '.fandom.com');
    hosts.push(s + '.wiki.gg');
  }

  const out = [];

  for (const host of hosts.slice(0, 8)) {
    for (const path of ['/api.php', '/w/api.php']) {
      const api = 'https://' + host + path;

      try {
        const candidate = await probeWiki(api, game);

        if (candidate.score >= 2) {
          out.push(Object.assign(candidate, { discovery: 'host-guess' }));
        }

        break;
      } catch {
        // Пробуем следующий общепринятый путь MediaWiki API.
      }
    }
  }

  return out;
}

async function discoverWikiCandidates(game) {
  const query = encodeURIComponent(
    '"' + game + '" game wiki MediaWiki API Fandom wiki.gg'
  );

  const response = await fetch(
    'https://html.duckduckgo.com/html/?q=' + query,
    {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html'
      },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      redirect: 'follow'
    }
  );

  if (!response.ok) {
    throw new Error('Wiki discovery search HTTP ' + response.status);
  }

  const html = await response.text();
  const hrefs = [];

  const re = /<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["']/gi;
  let match;

  while ((match = re.exec(html)) && hrefs.length < 30) {
    hrefs.push(match[1]);
  }

  if (!hrefs.length) {
    const fallback = /<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*result__a[^"']*["']/gi;

    while ((match = fallback.exec(html)) && hrefs.length < 30) {
      hrefs.push(match[1]);
    }
  }

  const hosts = [];

  for (const href of hrefs) {
    const u = unwrapSearchUrl(href);

    if (!u || u.protocol !== 'https:' ||
        !allowedWikiHost(u.hostname)) {
      continue;
    }

    if (!hosts.includes(u.hostname.toLowerCase())) {
      hosts.push(u.hostname.toLowerCase());
    }
  }

  const candidates = [];

  for (const host of hosts.slice(0, DISCOVERY_MAX_CANDIDATES)) {
    const paths = [
      '/api.php',
      '/w/api.php',
      '/mediawiki/api.php'
    ];

    for (const path of paths) {
      const api = 'https://' + host + path;

      try {
        const candidate = await probeWiki(api, game);

        if (candidate.score >= 2) {
          candidates.push(Object.assign(candidate, { discovery: 'web-search' }));
        }

        break;
      } catch (e) {
        // Пробуем следующий общепринятый путь MediaWiki API.
      }
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

async function discoverWiki(game) {
  const name = String(game || '').trim().slice(0, 100);

  if (name.length < 2) {
    throw new Error('game is required');
  }

  const n = normalize(name);

  const allCatalog = CATALOG.concat(
    extraCatalog().map(x => ({
      id: x.id || slug(x.game || (x.names || [])[0]),
      names: Array.isArray(x.names)
        ? x.names
        : [x.game || x.id],
      api: x.api,
      language: x.language || 'unknown'
    }))
  );

  const known = allCatalog.find(x =>
    x.names.some(alias => normalize(alias) === n)
  );

  if (known) {
    try {
      const info = await verifyWiki(known.api);

      return {
        status: 'found',
        game: name,
        source: {
          api: known.api,
          ...info,
          discovery: 'catalog',
          catalogId: known.id,
          language: known.language
        }
      };
    } catch (e) {
      // Устаревший элемент каталога: продолжаем автоматический поиск.
    }
  }

  const cache = await readJson('wiki-catalog.json')
    .catch(() => null) || { games: {} };

  const cached = cache.games && cache.games[n];

  if (cached && cached.api) {
    try {
      const info = await verifyWiki(cached.api);

      return {
        status: 'found',
        game: name,
        source: {
          ...cached,
          ...info,
          discovery: 'saved-catalog'
        }
      };
    } catch (e) {
      // Проверяем источник заново.
    }
  }

  // Сначала догадки по адресу: они не зависят от доступности поиска в
  // интернете и не подменяют вики случайной страницей.
  let candidates = [];

  try {
    candidates = await guessWikiCandidates(name);
  } catch (e) {
    candidates = [];
  }

  if (!candidates.length) {
    try {
      candidates = await discoverWikiCandidates(name);
    } catch (e) {
      return {
        status: 'discovery_unavailable',
        game: name,
        message: String(e.message || e).slice(0, 180),
        candidates: []
      };
    }
  }

  if (!candidates.length) {
    return {
      status: 'not_found',
      game: name,
      candidates: [],
      message: 'Не удалось автоматически подтвердить подходящую MediaWiki. Можно передать wikiApi вручную.'
    };
  }

  if (candidates.length > 1 &&
      candidates[0].score === candidates[1].score) {
    return {
      status: 'needs_choice',
      game: name,
      candidates: candidates.map(({
        api,
        siteName,
        server,
        score,
        matchingPages
      }) => ({
        api,
        siteName,
        server,
        score,
        matchingPages
      }))
    };
  }

  const best = candidates[0];

  cache.games = cache.games || {};
  cache.games[n] = {
    api: best.api,
    siteName: best.siteName,
    server: best.server,
    savedAt: new Date().toISOString()
  };

  cache.updatedAt = new Date().toISOString();

  await writeJson('wiki-catalog.json', cache);

  return {
    status: 'found',
    game: name,
    source: best,
    alternatives: candidates.slice(1).map(x => ({
      api: x.api,
      siteName: x.siteName,
      score: x.score
    }))
  };
}

async function resolveWiki(game, explicitApi) {
  if (explicitApi) {
    const info = await verifyWiki(explicitApi);

    return {
      api: validateApiUrl(explicitApi).toString(),
      ...info,
      discovery: 'manual'
    };
  }

  const result = await discoverWiki(game);

  if (result.status === 'found') {
    return result.source;
  }

  if (result.status === 'needs_choice') {
    throw new Error(
      'Найдено несколько подходящих Wiki. Сначала вызови discover и выбери источник: ' +
      result.candidates.map(x => x.api).join('; ')
    );
  }

  throw new Error(
    result.message ||
    'Не удалось автоматически найти и проверить Wiki. База не создавалась.'
  );
}

function emptyManifest(game, id, wiki) {
  return {
    schemaVersion: 1,
    gameId: id,
    game,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'registered',
    source: wiki,
    pageCount: 0,
    cursor: null,
    complete: false,
    lastSyncAt: null,
    lastWarmAt: null,
    warmStatus: 'none',
    warmPages: 0,
    warmSections: {},
    errors: [],
    policy: 'MediaWiki API; page text and revision metadata retained with source URL; no model-generated facts are treated as source data.'
  };
}

async function updateRegistry(gameId) {
  const registry = await readJson('registry.json') || {
    schemaVersion: 1,
    gameIds: []
  };

  if (!registry.gameIds.includes(gameId)) {
    registry.gameIds.push(gameId);
  }

  registry.updatedAt = new Date().toISOString();

  await writeJson('registry.json', registry);
}

async function syncNextGame() {
  const registry = await readJson('registry.json') || {
    gameIds: []
  };

  for (const id of registry.gameIds || []) {
    const m = await readJson(manifestKey(id));

    if (m && !m.complete) {
      return syncGame({
        gameId: id,
        limit: MAX_BATCH
      });
    }
  }

  return {
    status: 'idle',
    message: 'No pending game databases.'
  };
}

async function registerGame(body) {
  const game = String(body.game || '').trim().slice(0, 100);

  if (game.length < 2) {
    throw new Error('game is required');
  }

  const id = slug(body.gameId || game);
  const old = await readJson(manifestKey(id));

  if (old) {
    return {
      status: 'exists',
      gameId: id,
      game: old.game,
      pageCount: old.pageCount,
      complete: old.complete,
      source: old.source
    };
  }

  const wiki = await resolveWiki(game, body.wikiApi || '');
  const manifest = emptyManifest(game, id, wiki);

  await writeJson(manifestKey(id), manifest);
  await writeJson(indexKey(id), {
    schemaVersion: 1,
    items: []
  });

  await updateRegistry(id);

  return {
    status: 'registered',
    gameId: id,
    game,
    source: wiki,
    next: 'sync'
  };
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (m, n) => {
      const v = Number(n);
      return v > 0 && v <= 0x10ffff
        ? String.fromCodePoint(v)
        : ' ';
    })
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => {
      const v = parseInt(n, 16);
      return v > 0 && v <= 0x10ffff
        ? String.fromCodePoint(v)
        : ' ';
    });
}

function removeBalancedTemplates(input, depth = 0) {
  const s = String(input || '');

  if (depth > 8) return ' ';

  let out = '';

  for (let i = 0; i < s.length;) {
    if (s.slice(i, i + 2) === '{{') {
      let level = 1;
      let j = i + 2;

      while (j < s.length && level > 0) {
        if (s.slice(j, j + 2) === '{{') {
          level++;
          j += 2;
        } else if (s.slice(j, j + 2) === '}}') {
          level--;
          j += 2;
        } else {
          j++;
        }
      }

      const body = s.slice(i + 2, Math.max(i + 2, j - 2));
      const lines = body.split(/\r?\n/);
      let key = '';
      let valueLines = [];
      const values = [];

      const excluded = /^(?:image\w*|file|icon|color|colour|background|bg|map|coordinates|coord|width|height|size|align|sort|id|class|style|border|css|logo|sound|audio|video|portrait|screenshot|tracking|nocat)$/i;

      const cleanValue = raw => {
        let value = String(raw || '')
          .replace(/<ref\b[^>]*\/?\s*>[\s\S]*?(?:<\/ref\s*>|$)/gi, ' ');

        value = removeBalancedTemplates(value, depth + 1)
          .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
          .replace(/\[\[([^\]]+)\]\]/g, '$1')
          .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1');

        return stripHtml(value)
          .replace(/[{}|]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      };

      const flush = () => {
        if (!key || excluded.test(key.trim())) {
          key = '';
          valueLines = [];
          return;
        }

        const value = cleanValue(valueLines.join(' '));

        if (value.length >= 2 &&
            value.length <= 220 &&
            /[\p{L}\p{N}]/u.test(value) &&
            !values.some(x => normalize(x) === normalize(value))) {
          values.push(value);
        }

        key = '';
        valueLines = [];
      };

      for (const line of lines) {
        const m = line.match(/^\s*\|\s*([^=|]{1,80}?)\s*=\s*(.*)$/);

        if (m) {
          flush();
          key = m[1].trim();
          valueLines = [m[2]];
        } else if (key) {
          valueLines.push(line);
        }
      }

      flush();

      out += values.slice(0, 24).join('. ') || ' ';
      i = j;
    } else {
      out += s[i];
      i++;
    }
  }

  return out;
}

function stripWikitext(input) {
  let s = String(input || '');

  s = s
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<ref\b[^>]*\/?\s*>[\s\S]*?<\/ref\s*>/gi, ' ')
    .replace(/<ref\b[^>]*\/>/gi, ' ')
    .replace(/<(nowiki|pre|source|syntaxhighlight)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, '$2')
    .replace(/<(gallery|timeline|imagemap)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/\[\[(?:File|Image|Category|Категория|Файл|Изображение):[^\]]*\]\]/gi, ' ')
    // Межъязыковые ссылки ([[en:Judy Alvarez]], [[de:...]]) — это не текст
    // статьи. Раньше они превращались в строку «en Judy Alvarez», набивали
    // конец статьи совпадениями и выигрывали у биографии.
    .replace(/\[\[\s*(?:[a-z]{2,3}(?:-[a-z0-9]{2,8})?|simple)\s*:[^\]]*\]\]/gi, ' ');

  s = removeBalancedTemplates(s);

  s = s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[(?:https?:\/\/\S+)(?:\s+([^\]]+))?\]/g, '$1')
    .replace(/^\s*\|[-|\s]+\|\s*$/gm, ' ')
    .replace(/^\s*[{|}]\s*$/gm, ' ')
    .replace(/^\s*[|!].*$/gm, ' ')
    .replace(/^\s*={1,6}\s*(.*?)\s*={1,6}\s*$/gm, '\n$1\n')
    .replace(/^\s*[*#;:]+\s?/gm, '• ')
    .replace(/'{2,5}/g, '')
    .replace(/__[A-Z]+__/g, ' ');

  return stripHtml(s);
}

function stripHtml(s) {
  return decodeEntities(String(s || '')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[\t\r]+/g, ' ')
    .replace(/[ \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function makeChunks(text) {
  const clean = stripHtml(text)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!clean) return [];

  // Служебные разделы («Примечания», «Ссылки», «Навигация») в хранилище
  // остаются частью текста статьи, но в поисковые фрагменты не попадают.
  const chunks = makeSectionChunks(clean, 1400, 220)
    .map(x => x.text)
    .filter(Boolean);

  if (chunks.length) return chunks.slice(0, 100);

  return [clean.slice(0, 1400)];
}

function wikiPages(data) {
  const pagesObj = data && data.query && data.query.pages;

  return Array.isArray(pagesObj)
    ? pagesObj
    : (pagesObj ? Object.values(pagesObj) : []);
}

function revisionContent(p) {
  const r = p && Array.isArray(p.revisions) && p.revisions[0];

  if (!r) return '';

  const slot = r.slots && r.slots.main;

  return String(
    (slot && (slot.content || slot['*'])) ||
    r.content ||
    r['*'] ||
    ''
  );
}

// Компактный текст статьи: содержательные разделы остаются с заголовками,
// служебные («Примечания», «Ссылки», «Навигация», «Галерея») убираются.
function compactArticle(text) {
  const sections = splitSections(text);

  if (!sections.length) return stripHtml(text);

  return sections
    .map(s => (s.heading ? s.heading + '\n' : '') + s.text)
    .join('\n\n')
    .trim();
}

function makePageRecord(p, manifest) {
  // Не все источники отдают server: без него ссылка всё равно должна быть
  // рабочей, поэтому берём корень из api.php.
  const source = (manifest && manifest.source) || {};
  const serverBase = String(source.server || source.api || '')
    .replace(/\/[^/]*api\.php.*$/i, '')
    .replace(/\/$/, '');
  const extractText = compactArticle(stripHtml(p.extract || ''));
  const rawRevision = revisionContent(p);
  const revisionText = rawRevision ? compactArticle(stripWikitext(rawRevision)) : '';

  const content = (
    extractText.length >= revisionText.length
      ? extractText
      : revisionText
  ).slice(0, MAX_PAGE_TEXT);

  const contentSource = extractText
    ? (
        extractText.length >= revisionText.length
          ? 'mediawiki-extract'
          : 'revision-wikitext'
      )
    : (
        revisionText
          ? 'revision-wikitext'
          : 'missing'
      );

  return {
    pageId: Number(p.pageid),
    title: String(p.title).slice(0, 300),
    url: String(
      p.fullurl ||
      (
        serverBase +
        '/wiki/' +
        encodeURIComponent(p.title.replace(/ /g, '_'))
      )
    ).slice(0, 1000),
    revisionId: p.lastrevid ||
      (p.revisions && p.revisions[0] && p.revisions[0].revid) ||
      null,
    namespace: p.ns || 0,
    categories: (p.categories || [])
      .map(c => String(c.title || '').replace(/^Category:/, ''))
      .slice(0, 40),
    fetchedAt: new Date().toISOString(),
    extract: content,
    chunks: makeChunks(content),
    contentSource,
    contentLength: content.length
  };
}

function makeIndexItem(rec){
  const extract=String(rec.extract||'');
  const head=extract.slice(0,7000);
  const tail=extract.slice(-12000);
  const common=rec.title+' '+(rec.categories||[]).join(' ')+' ';
  const headTokens=searchTokens(common+head).slice(0,400);
  // Keep tokens closest to the actual end of the article as well.
  const tailTokens=searchTokens(tail).slice(-700);

  return {
    pageId:rec.pageId,
    title:rec.title,
    url:rec.url,
    revisionId:rec.revisionId,
    categories:rec.categories,
    lead:extract.slice(0,900),
    tail:extract.slice(-900),
    tokens:Array.from(new Set(headTokens.concat(tailTokens))).slice(0,1100)
  };
}

async function storeWikiPages(id, manifest, index, pages) {
  let added = 0;

  for (const p of pages) {
    if (!p || p.pageid === undefined || !p.title) continue;

    const rec = makePageRecord(p, manifest);
    const key = pageKey(id, rec.pageId);

    if (!rec.extract) {
      const old = await readJson(key).catch(() => null);

      if (old && old.extract) {
        rec.extract = old.extract;
        rec.chunks = old.chunks || makeChunks(old.extract);
        rec.contentSource = old.contentSource || 'preserved-existing';
        rec.contentLength = rec.extract.length;
      }
    }

    await writeJson(key, rec);

    const at = index.items.findIndex(x => x.pageId === rec.pageId);
    const item = makeIndexItem(rec);

    if (at >= 0) {
      index.items[at] = item;
    } else {
      index.items.push(item);
      added++;
    }
  }

  return added;
}

// Fetch actual revision source when the Wiki's extracts module returns no usable text.
async function enrichWikiPages(id, manifest, index, pageIds) {
  const requested = Array.from(
    new Set((pageIds || []).map(Number).filter(Number.isFinite))
  );

  const ids = [];

  for (const pageId of requested) {
    const existing = await readJson(pageKey(id, pageId)).catch(() => null);

    if (!existing || !existing.extract) {
      ids.push(pageId);
    }

    if (ids.length >= MAX_ENRICH_PAGES) break;
  }

  if (!ids.length) {
    return {
      enriched: 0,
      missing: 0,
      errors: []
    };
  }

  const errors = [];
  let enriched = 0;
  let missing = 0;
  const groups = [];

  for (let i = 0; i < ids.length; i += 8) {
    groups.push(ids.slice(i, i + 8));
  }

  for (const group of groups) {
    try {
      const data = await wikiGet(manifest.source.api, {
        action: 'query',
        pageids: group.join('|'),
        prop: 'extracts|revisions|info|categories',
        exintro: 0,
        explaintext: 1,
        exsectionformat: 'plain',
        exchars: MAX_PAGE_TEXT,
        rvprop: 'content',
        rvslots: 'main',
        inprop: 'url',
        cllimit: 30,
        format: 'json',
        formatversion: 2
      });

      const pages = wikiPages(data);

      await storeWikiPages(id, manifest, index, pages);

      for (const p of pages) {
        const rec = makePageRecord(p, manifest);

        if (rec.extract) {
          enriched++;
        } else {
          missing++;
        }
      }
    } catch (e) {
      errors.push(String(e && e.message || e).slice(0, 160));
    }
  }

  // Last-resort parser path for APIs that omit revision content in a multi-page query.
  let fallbackAttempts = 0;

  for (const pageId of ids) {
    const current = await readJson(pageKey(id, pageId)).catch(() => null);

    if (current && current.extract) continue;

    if (fallbackAttempts >= MAX_PARSE_FALLBACK_PAGES) {
      missing++;
      continue;
    }

    fallbackAttempts++;

    try {
      const parsed = await wikiGet(
        manifest.source.api,
        {
          action: 'parse',
          pageid: pageId,
          prop: 'wikitext|text',
          format: 'json',
          formatversion: 2
        },
        6000
      );

      const raw = parsed && parsed.parse && parsed.parse.wikitext;

      const wikitext = typeof raw === 'string'
        ? raw
        : (raw && (raw['*'] || raw.content)) || '';

      let text = wikitext ? stripWikitext(wikitext) : '';
      let source = 'parse-wikitext';

      if (!text) {
        const html = parsed && parsed.parse && parsed.parse.text;

        text = stripHtml(
          typeof html === 'string'
            ? html
            : (html && html['*']) || ''
        );

        source = 'parse-html';
      }

      if (text) {
        const rec = Object.assign({}, current || {}, {
          extract: text.slice(0, MAX_PAGE_TEXT),
          chunks: makeChunks(text),
          contentSource: source,
          contentLength: Math.min(text.length, MAX_PAGE_TEXT),
          fetchedAt: new Date().toISOString()
        });

        await writeJson(pageKey(id, pageId), rec);

        const at = index.items.findIndex(x => x.pageId === pageId);
        const item = makeIndexItem(rec);

        if (at >= 0) {
          index.items[at] = item;
        } else {
          index.items.push(item);
        }

        enriched++;
        missing = Math.max(0, missing - 1);
      }
    } catch (e) {
      errors.push(String(e && e.message || e).slice(0, 160));
    }
  }

  if (enriched) {
    await writeIndexMerged(id, index);

    const m = await readJson(manifestKey(id)).catch(() => null) || manifest;

    m.pageCount = index.items.length;
    m.updatedAt = new Date().toISOString();

    await writeJson(manifestKey(id), m);

    manifest.pageCount = m.pageCount;
    manifest.updatedAt = m.updatedAt;
  }

  return {
    enriched,
    missing,
    errors
  };
}

function queryVariants(gameId, query, aliasMap) {
  const out = [String(query || '').trim()];
  const aliases = aliasMap && typeof aliasMap === 'object' ? aliasMap : {};
  const n = normalize(query);

  for (const [label, values] of Object.entries(aliases)) {
    const key = normalize(label);

    if (!key || !(n === key || (' ' + n + ' ').includes(' ' + key + ' '))) {
      continue;
    }

    const list = Array.isArray(values) ? values : [values];

    for (const value of list) {
      const v = String(value || '').trim().slice(0, MAX_QUERY);

      if (v && !out.some(x => normalize(x) === normalize(v))) {
        out.push(v);
      }

      if (out.length >= MAX_QUERY_VARIANTS) break;
    }

    if (out.length >= MAX_QUERY_VARIANTS) break;
  }

  return out.filter(Boolean).slice(0, MAX_QUERY_VARIANTS);
}

function translationLanguage(manifest) {
  const candidate = String(
    manifest && manifest.source && manifest.source.language ||
    process.env.KB_DEFAULT_WIKI_LANGUAGE ||
    'en'
  ).toLowerCase();

  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(candidate)
    ? candidate
    : 'en';
}

async function translateQueryToLanguage(query, targetLanguage, opts) {
  const q = String(query || '').trim();
  const target = String(targetLanguage || 'en').toLowerCase();
  // В быстром режиме перевод берём только из уже сохранённого кэша:
  // сетевой вызов переводчика не должен задерживать ответ Алисе.
  const cacheOnly = !!(opts && opts.cacheOnly);

  if (!q || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(target)) {
    return null;
  }

  const hasCyrillic = /[а-яё]/i.test(q);
  const hasNonAscii = /[^\x00-\x7F]/.test(q);

  if ((target === 'en' && !hasNonAscii) ||
      (target === 'ru' && hasCyrillic)) {
    return null;
  }

  const cacheKey = crypto.createHash('sha256')
    .update(target + '\n' + normalize(q))
    .digest('hex');

  const cachePath = 'translation-cache/' + cacheKey + '.json';

  try {
    const cached = await readJson(cachePath);

    if (cached &&
        cached.translation &&
        Date.now() - Date.parse(cached.savedAt || 0) <
          30 * 24 * 60 * 60 * 1000) {
      return cached.translation;
    }
  } catch {
    // Необязательный кэш перевода.
  }

  if (cacheOnly) return null;

  try {
    const u = new URL('https://translate.googleapis.com/translate_a/t');

    u.searchParams.set('client', 'dict-chrome-ex');
    u.searchParams.set('sl', 'auto');
    u.searchParams.set('tl', target);
    u.searchParams.set('dt', 't');
    u.searchParams.set('q', q.slice(0, MAX_QUERY));

    const response = await fetch(u.toString(), {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(TRANSLATION_TIMEOUT_MS),
      redirect: 'error'
    });

    if (!response.ok) {
      throw new Error('Translation HTTP ' + response.status);
    }

    const data = await response.json();
    let translated = '';

    if (Array.isArray(data) && Array.isArray(data[0])) {
      if (Array.isArray(data[0][0])) {
        translated = data[0]
          .map(x => Array.isArray(x) ? String(x[0] || '') : '')
          .join('');
      } else {
        translated = data
          .map(x => Array.isArray(x) ? String(x[0] || '') : '')
          .join('');
      }
    } else if (data && Array.isArray(data.sentences)) {
      translated = data.sentences
        .map(x => String(x.trans || ''))
        .join('');
    }

    translated = translated.trim().slice(0, MAX_QUERY);

    if (!translated || normalize(translated) === normalize(q)) {
      return null;
    }

    await writeJson(cachePath, {
      query: q,
      language: target,
      translation: translated,
      savedAt: new Date().toISOString()
    }).catch(() => {});

    return translated;
  } catch (e) {
    return null;
  }
}

// Роль варианта запроса: от неё зависит и порядок, и попадание в поиск по вики.
// Раньше перевод просто дописывался в конец массива и отбрасывался
// variants.slice(0, 3) — русский вопрос так и не доходил до английской вики.
const VARIANT_RANK = {
  original: 0,
  entity: 1,
  translation: 2,
  alias: 3,
  intent: 4
};

function planVariants(baseVariants, extraVariants) {
  const plan = [];

  const push = (text, kind) => {
    const v = String(text || '').trim().slice(0, MAX_QUERY);
    if (!v) return;
    if (plan.some(x => normalize(x.text) === normalize(v))) return;
    plan.push({ text: v, kind: kind });
  };

  push(baseVariants[0], 'original');

  for (const extra of extraVariants || []) {
    push(extra.text, extra.kind);
  }

  for (const value of baseVariants.slice(1)) {
    push(value, 'alias');
  }

  return plan
    .sort((a, b) => VARIANT_RANK[a.kind] - VARIANT_RANK[b.kind])
    .slice(0, MAX_QUERY_VARIANTS);
}

// Что реально уходит в поиск по вики. Перевод и обе сущности сравнения
// обязаны попасть в список, поэтому лимит шире, чем «первые три».
const WIKI_VARIANT_LIMIT = 4;

function variantsForWiki(plan) {
  return (plan || [])
    .slice()
    .sort((a, b) => VARIANT_RANK[a.kind] - VARIANT_RANK[b.kind])
    .slice(0, WIKI_VARIANT_LIMIT)
    .map(x => x.text);
}

async function buildVariantPlan(gameId, query, manifest, opts) {
  let aliasFile = null;

  try {
    aliasFile = await readJson(aliasesKey(gameId));
  } catch {
    // Необязательный файл псевдонимов.
  }

  const aliases = aliasFile &&
    aliasFile.aliases &&
    typeof aliasFile.aliases === 'object'
    ? aliasFile.aliases
    : {};

  const base = queryVariants(gameId, query, aliases);
  const target = translationLanguage(manifest);
  const plan = planVariants(base, []);

  // Переводим сам вопрос, а если перевод не вышел — первый псевдоним.
  const candidates = [query].concat(base.slice(1, 2));
  let translated = null;

  for (const candidate of candidates) {
    translated = await translateQueryToLanguage(candidate, target, opts);

    if (translated) break;
  }

  if (translated && !plan.some(x => normalize(x.text) === normalize(translated))) {
    plan.push({ text: translated, kind: 'translation' });
  }

  return plan
    .sort((a, b) => VARIANT_RANK[a.kind] - VARIANT_RANK[b.kind])
    .slice(0, MAX_QUERY_VARIANTS);
}

async function setGameAliases(body) {
  const id = slug(body.gameId || body.game || '');

  if (id === 'unknown-game') {
    throw new Error('gameId is required');
  }

  if (!(await readJson(manifestKey(id)))) {
    throw new Error('Game is not registered; call register first');
  }

  const input = body.aliases;

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(
      'aliases must be an object: {"Russian name":"source-language name"}'
    );
  }

  const current = await readJson(aliasesKey(id)) || {
    schemaVersion: 1,
    aliases: {}
  };

  current.aliases = current.aliases || {};

  let saved = 0;

  for (const [label, raw] of Object.entries(input).slice(0, 200)) {
    const key = String(label || '').trim().slice(0, 100);

    const values = (Array.isArray(raw) ? raw : [raw])
      .map(x => String(x || '').trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 4);

    if (key && values.length) {
      current.aliases[key] = values;
      saved++;
    }
  }

  current.updatedAt = new Date().toISOString();

  await writeJson(aliasesKey(id), current);

  return {
    status: 'ok',
    gameId: id,
    saved,
    totalAliases: Object.keys(current.aliases).length
  };
}

async function searchWikiOnDemand(id, manifest, index, variants) {
  let added = 0;
  let fetched = 0;
  const errors = [];
  const fetchedIds = [];

  // Список приходит уже упорядоченным по роли (оригинал, сущности сравнения,
  // перевод, псевдонимы, обзорный термин), поэтому перевод больше не теряется.
  for (const query of (variants || []).slice(0, WIKI_VARIANT_LIMIT)) {
    try {
      const data = await wikiGet(manifest.source.api, {
        action: 'query',
        generator: 'search',
        gsrsearch: query,
        gsrnamespace: 0,
        gsrwhat: 'text',
        gsrlimit: ON_DEMAND_SEARCH_LIMIT,
        prop: 'extracts|info|categories',
        exintro: 0,
        explaintext: 1,
        exsectionformat: 'plain',
        exchars: MAX_PAGE_TEXT,
        inprop: 'url',
        cllimit: 20,
        format: 'json',
        formatversion: 2
      });

      const pages = wikiPages(data);

      fetched += pages.length;

      for (const p of pages) {
        if (p && p.pageid !== undefined) {
          fetchedIds.push(Number(p.pageid));
        }
      }

      added += await storeWikiPages(id, manifest, index, pages);
    } catch (e) {
      errors.push(String(e && e.message || e).slice(0, 140));
    }
  }

  const enriched = await enrichWikiPages(
    id,
    manifest,
    index,
    fetchedIds.slice(0, MAX_ENRICH_PAGES)
  );

  errors.push(...enriched.errors);

  if (fetched || enriched.enriched) {
    manifest.pageCount = index.items.length;
    manifest.updatedAt = new Date().toISOString();
    manifest.lastSearchFetchAt = manifest.updatedAt;

    await writeIndexMerged(id, index);
    await writeJson(manifestKey(id), manifest);
  }

  return {
    added,
    fetched,
    enriched: enriched.enriched,
    missingContent: enriched.missing,
    errors
  };
}

async function syncGame(body) {
  const id = slug(body.gameId || body.game || '');

  if (id === 'unknown-game') {
    throw new Error('gameId is required');
  }

  const manifest = await readJson(manifestKey(id));

  if (!manifest) {
    throw new Error('Game is not registered; call register first');
  }

  if (manifest.complete) {
    return {
      status: 'complete',
      gameId: id,
      pageCount: manifest.pageCount,
      complete: true
    };
  }

  const index = await readJson(indexKey(id)) || {
    schemaVersion: 1,
    items: []
  };

  if ((index.items || []).length >= MAX_PAGES) {
    return {
      status: 'limit_reached',
      gameId: id,
      pageCount: index.items.length,
      complete: false,
      hasMore: !!manifest.cursor
    };
  }

  const limit = Math.min(
    MAX_BATCH,
    Math.max(1, Number(body.limit || MAX_BATCH)),
    MAX_PAGES - index.items.length
  );

  const params = {
    action: 'query',
    generator: 'allpages',
    gapnamespace: 0,
    gaplimit: limit,
    gapfilterredir: 'nonredirects',
    prop: 'extracts|info|categories',
    exintro: 0,
    explaintext: 1,
    exsectionformat: 'plain',
    exchars: MAX_PAGE_TEXT,
    inprop: 'url',
    cllimit: 20,
    format: 'json',
    formatversion: 2
  };

  if (manifest.cursor) {
    params.gapcontinue = manifest.cursor;
  }

  const data = await wikiGet(manifest.source.api, params);
  const pages = wikiPages(data);
  const added = await storeWikiPages(id, manifest, index, pages);

  const next = data && data.continue && data.continue.gapcontinue
    ? data.continue.gapcontinue
    : null;

  manifest.cursor = next;
  manifest.pageCount = index.items.length;
  manifest.complete = !next;
  manifest.status = manifest.complete
    ? 'complete'
    : (index.items.length >= MAX_PAGES ? 'limit_reached' : 'indexing');

  manifest.updatedAt = new Date().toISOString();
  manifest.lastSyncAt = manifest.updatedAt;

  if (index.items.length >= MAX_PAGES && next) {
    manifest.errors = (manifest.errors || [])
      .concat([
        'KB_MAX_PAGES reached. Increase the environment limit and call sync again to continue from the saved cursor.'
      ])
      .slice(-10);
  }

  await writeIndexMerged(id, index);
  await writeJson(manifestKey(id), manifest);

  return {
    status: manifest.status,
    gameId: id,
    batchAdded: added,
    pageCount: manifest.pageCount,
    complete: manifest.complete,
    hasMore: !!next,
    nextAction: manifest.complete ? 'ready' : 'sync'
  };
}

// ---------- актуальность ----------
// Повторная полная загрузка вики не нужна: достаточно спросить recentchanges
// и перечитать только те статьи, у которых изменился revisionId.

async function refreshGame(body) {
  const id = slug(body.gameId || body.game || '');
  const manifest = await readJson(manifestKey(id));

  if (!manifest) {
    throw new Error('Game is not registered; call register first');
  }

  const index = await readJson(indexKey(id)) || { schemaVersion: 1, items: [] };
  const limit = Math.min(50, Math.max(1, Number(body.limit || 30)));
  const errors = [];

  let changes;

  try {
    changes = await wikiGet(manifest.source.api, {
      action: 'query',
      list: 'recentchanges',
      rcprop: 'title|ids|timestamp|sizes',
      rctype: 'edit|new',
      rcnamespace: 0,
      rclimit: limit,
      format: 'json',
      formatversion: 2
    });
  } catch (e) {
    errors.push(String(e && e.message || e).slice(0, 160));

    return {
      status: 'unavailable',
      gameId: id,
      checked: 0,
      updated: 0,
      errors: errors
    };
  }

  const byTitle = new Map();

  for (const item of (index.items || [])) {
    byTitle.set(normalize(item.title || ''), item);
  }

  const known = [];
  const unknown = [];

  for (const change of (changes && changes.query && changes.query.recentchanges) || []) {
    const title = String(change.title || '').trim();
    const key = normalize(title);

    if (!title || !key) continue;

    const item = byTitle.get(key);

    if (!item) {
      unknown.push(title);
      continue;
    }

    if (Number(change.revid) && Number(item.revisionId) !== Number(change.revid)) {
      known.push({ title: title, pageId: item.pageId });
    }
  }

  let updated = 0;
  let touched = 0;

  // Изменившиеся статьи перечитываются пачками по 8 — как в enrichWikiPages.
  for (let i = 0; i < known.length; i += 8) {
    const group = known.slice(i, i + 8);

    try {
      const data = await wikiGet(manifest.source.api, {
        action: 'query',
        pageids: group.map(x => x.pageId).join('|'),
        prop: 'extracts|revisions|info|categories',
        exintro: 0,
        explaintext: 1,
        exsectionformat: 'plain',
        exchars: MAX_PAGE_TEXT,
        rvprop: 'content',
        rvslots: 'main',
        inprop: 'url',
        cllimit: 30,
        format: 'json',
        formatversion: 2
      });

      updated += await storeWikiPages(id, manifest, index, wikiPages(data));
      // storeWikiPages считает только новые страницы, а здесь важны именно
      // перезаписанные: у них изменился revisionId.
      touched += wikiPages(data).length;
    } catch (e) {
      errors.push(String(e && e.message || e).slice(0, 160));
    }
  }

  if (touched) {
    await writeIndexMerged(id, index);

    manifest.pageCount = (index.items || []).length;
    manifest.updatedAt = new Date().toISOString();
    manifest.lastRefreshAt = manifest.updatedAt;

    await writeJson(manifestKey(id), manifest);
  }

  return {
    status: 'ok',
    gameId: id,
    checked: known.length + unknown.length,
    updated: touched,
    addedNew: updated,
    newTitles: unknown.slice(0, 10),
    errors: errors
  };
}

// ---------- готовность базы ----------
// «Готово» — это не «manifest.json существует» и не «status: complete».
// Готовность = прогревочный набор загружен, страниц достаточно, разделов
// хватает на типовые вопросы. Иначе система честно говорит, что база ещё
// наполняется, вместо warm:null и ложной уверенности.

function sectionCoverage(warm, index) {
  const out = {};
  const sections = (warm && warm.sections) || {};

  for (const [name, list] of Object.entries(sections)) {
    if (Array.isArray(list) && list.length) {
      out[name] = list.length;
    }
  }

  if (!Object.keys(out).length && index && Array.isArray(index.items)) {
    out.stored = index.items.length;
  }

  return out;
}

function warmStatusOf(manifest, warm, index) {
  const m = manifest || {};
  const stored = (index && Array.isArray(index.items)) ? index.items.length : 0;

  if (warm && Array.isArray(warm.pageIds) && warm.pageIds.length) {
    const sections = sectionCoverage(warm, index);
    const named = Object.keys(sections).filter(k => k !== 'stored').length;
    const ready = warm.pageIds.length >= WARM_MIN_PAGES &&
      named >= WARM_MIN_SECTIONS &&
      String(warm.status || 'ok') !== 'error';

    return {
      status: ready ? 'ok' : (warm.status || 'partial'),
      ready: ready,
      pages: warm.pageIds.length,
      storedPages: stored,
      builtAt: warm.builtAt || m.lastWarmAt || '',
      ageS: warm.builtAt
        ? Math.max(0, Math.round((Date.now() - Date.parse(warm.builtAt)) / 1000))
        : null,
      sections: sections,
      language: warm.language || translationLanguage(m),
      genre: warm.genre || '',
      truncated: !!warm.truncated,
      source: 'warm.json'
    };
  }

  // warm.json ещё не записан, но manifest уже знает про прогрев: отдаём
  // то, что реально известно, а не null.
  if (m.lastWarmAt || m.warmStatus) {
    const pages = Number(m.warmPages) || 0;
    const sections = m.warmSections || {};

    return {
      status: m.warmStatus || 'partial',
      ready: pages >= WARM_MIN_PAGES &&
        Object.keys(sections).length >= WARM_MIN_SECTIONS,
      pages: pages,
      storedPages: stored,
      builtAt: m.lastWarmAt || '',
      ageS: m.lastWarmAt
        ? Math.max(0, Math.round((Date.now() - Date.parse(m.lastWarmAt)) / 1000))
        : null,
      sections: sections,
      language: translationLanguage(m),
      genre: m.warmGenre || '',
      truncated: !!m.warmTruncated,
      source: 'manifest'
    };
  }

  return {
    status: 'none',
    ready: false,
    pages: 0,
    storedPages: stored,
    builtAt: '',
    ageS: null,
    sections: {},
    language: translationLanguage(m),
    genre: '',
    truncated: false,
    source: 'none'
  };
}


async function warmGame(body) {
  const started = Date.now();
  const input = body || {};
  const id = slug(input.gameId || input.game || '');

  if (id === 'unknown-game') {
    throw new Error('gameId or game is required');
  }

  const refresh = input.refresh === true || input.refresh === 1 ||
    input.refresh === '1' || input.refresh === 'true';

  let manifest = await readJson(manifestKey(id));

  if (!manifest) {
    try {
      await registerGame({
        game: input.game || input.gameId,
        gameId: id,
        wikiApi: input.wikiApi || ''
      });
    } catch (e) {
      return {
        status: 'needs_wiki',
        gameId: id,
        message: String(
          e && e.message || 'Wiki source is not configured'
        ).slice(0, 240)
      };
    }

    manifest = await readJson(manifestKey(id));
  }

  if (!manifest) {
    return { status: 'needs_wiki', gameId: id };
  }

  const cached = await readJson(warmKey(id)).catch(() => null);
  const cachedAge = cached && cached.builtAt
    ? Date.now() - Date.parse(cached.builtAt)
    : Infinity;
  const cachedState = warmStatusOf(manifest, cached, null);

  if (!refresh && cached && cachedAge < KB_WARM_TTL_MS &&
      Array.isArray(cached.pageIds) && cached.pageIds.length) {
    return {
      status: cachedState.ready ? 'ok' : 'partial',
      gameId: id,
      game: manifest.game,
      cached: true,
      ready: cachedState.ready,
      builtAt: cached.builtAt,
      pages: cached.pageIds.length,
      pageCount: manifest.pageCount || 0,
      sections: cached.sections || {},
      genre: cached.genre || '',
      ageS: Math.round(cachedAge / 1000)
    };
  }

  // Прогрев уже идёт (например, стартовал при выборе игры). Второй не нужен.
  const lock = await readJson(warmLockKey(id)).catch(() => null);

  if (lock && lock.at && Date.now() - Number(lock.at) < WARM_LOCK_MS) {
    return {
      status: 'busy',
      gameId: id,
      game: manifest.game,
      cached: false,
      ready: cachedState.ready,
      pages: cachedState.pages,
      sections: cachedState.sections,
      message: 'Прогрев этой игры уже выполняется.'
    };
  }

  await writeJson(warmLockKey(id), { at: Date.now() });

  const language = translationLanguage(manifest);
  const index = await readJson(indexKey(id)) || {
    schemaVersion: 1,
    items: []
  };
  const sections = {};
  const errors = [];
  let fetched = 0;
  let added = 0;
  let truncated = false;
  let genre = '';

  // Промежуточный итог: если invocation оборвётся по таймауту, прогретые
  // статьи всё равно будут видны как «частично готово», а не как warm:null.
  const savePartial = async (status, pageIds) => {
    const at = new Date().toISOString();
    const partial = {
      schemaVersion: 2,
      gameId: id,
      game: manifest.game,
      language: language,
      genre: genre,
      status: status,
      builtAt: at,
      sections: sections,
      pageIds: pageIds,
      errors: errors.slice(-8),
      truncated: truncated
    };

    await writeJson(warmKey(id), partial).catch(() => {});

    const m = await readJson(manifestKey(id)).catch(() => null) || manifest;

    m.pageCount = (index.items || []).length;
    m.updatedAt = at;
    m.lastWarmAt = at;
    m.warmStatus = status;
    m.warmPages = pageIds.length;
    m.warmSections = Object.fromEntries(
      Object.entries(sections).map(([k, v]) => [k, v.length])
    );
    m.warmGenre = genre;
    m.warmTruncated = truncated;

    await writeJson(manifestKey(id), m).catch(() => {});

    return partial;
  };

  try {
    // Жанр определяется по уже сохранённой обзорной статье игры и влияет
    // только на порядок категорий прогрева.
    const mainId = (index.items || [])
      .filter(x => normalize(x.title || '') === normalize(manifest.game || ''))
      .map(x => x.pageId)[0];

    if (mainId !== undefined) {
      const mainPage = await readJson(pageKey(id, mainId)).catch(() => null);
      genre = detectGenre(mainPage && mainPage.extract);
    }

    for (const step of warmPlan(manifest.game || input.game, language, genre)) {
      const left = WARM_BUDGET_MS - (Date.now() - started);

      if (left < 3000) {
        truncated = true;
        break;
      }

      try {
        const data = await wikiGet(manifest.source.api, {
          action: 'query',
          generator: 'search',
          gsrsearch: step.query,
          gsrnamespace: 0,
          gsrwhat: 'text',
          gsrlimit: WARM_PAGES_PER_QUERY,
          prop: 'extracts|info|categories',
          exintro: 0,
          explaintext: 1,
          exsectionformat: 'plain',
          exchars: MAX_PAGE_TEXT,
          inprop: 'url',
          cllimit: 20,
          format: 'json',
          formatversion: 2
        }, Math.min(FETCH_TIMEOUT_MS, Math.max(3000, left - 1500)));

        const pages = wikiPages(data)
          .filter(p => p && p.pageid !== undefined && p.title);

        fetched += pages.length;
        added += await storeWikiPages(id, manifest, index, pages);

        const list = sections[step.section] || (sections[step.section] = []);

        for (const p of pages) {
          const pageId = Number(p.pageid);
          if (!list.includes(pageId)) list.push(pageId);
        }

        // Шаг за шагом фиксируем результат: прерывание не обнуляет прогресс.
        if (pages.length) {
          await savePartial('running', Array.from(new Set(
            Object.values(sections).reduce((acc, l) => acc.concat(l), [])
          )));
        }
      } catch (e) {
        errors.push(
          step.section + ': ' + String(e && e.message || e).slice(0, 120)
        );
      }
    }
  } finally {
    // Замок снимается всегда, иначе одна сетевая ошибка блокирует прогрев
    // этой игры на WARM_LOCK_MS.
    await writeJson(warmLockKey(id), { at: 0, finishedAt: Date.now() })
      .catch(() => {});
  }

  const pageIds = Array.from(new Set(
    Object.values(sections).reduce((acc, list) => acc.concat(list), [])
  ));

  // Слияние с тем, что мог записать параллельный поиск.
  const mergedPages = await writeIndexMerged(id, index);

  const finalStatus = pageIds.length
    ? (
        pageIds.length >= WARM_MIN_PAGES &&
        Object.keys(sections).length >= WARM_MIN_SECTIONS &&
        !truncated
          ? 'ok'
          : 'partial'
      )
    : 'no_evidence';

  const warm = await savePartial(finalStatus, pageIds);

  const freshManifest = await readJson(manifestKey(id)).catch(() => null) || manifest;

  freshManifest.pageCount = mergedPages;
  await writeJson(manifestKey(id), freshManifest).catch(() => {});

  manifest = freshManifest;

  const state = warmStatusOf(manifest, warm, index);

  return {
    status: finalStatus,
    gameId: id,
    game: manifest.game,
    cached: false,
    ready: state.ready,
    builtAt: warm.builtAt,
    pages: pageIds.length,
    pageCount: manifest.pageCount,
    sections: sections,
    genre: genre,
    fetched: fetched,
    added: added,
    truncated: truncated,
    errors: errors.slice(-8),
    ms: Date.now() - started
  };
}

// Частота документа по терминам запроса: редкие слова важнее частых.
// Считается одним проходом по индексу, поэтому стоит доли миллисекунды
// даже на 12 000 статьях.
function documentFrequency(items, terms) {
  const df = new Map(terms.map(t => [t, 0]));
  const list = items || [];

  for (const item of list) {
    const tokens = item && Array.isArray(item.tokens) ? item.tokens : null;

    if (!tokens) continue;

    const set = new Set(tokens);

    for (const term of terms) {
      if (set.has(term)) df.set(term, (df.get(term) || 0) + 1);
    }
  }

  return df;
}

function idfWeight(df, total, term) {
  const d = df && df.get ? (df.get(term) || 0) : 0;
  const n = Math.max(1, total || 1);

  return 0.5 + Math.min(2.2, Math.log(1 + (n - d + 0.5) / (d + 0.5))) / 2;
}

function scoreItem(item, terms, intent, ctx) {
  const title = new Set(searchTokens(item.title));
  const lead = new Set(searchTokens(item.lead));
  const tail = new Set(searchTokens(item.tail || ''));
  const tokens = new Set(item.tokens || []);
  const c = ctx || {};
  let score = 0;
  let matched = 0;

  for (const t of terms) {
    const weight = idfWeight(c.df, c.total, t);
    let base = 0;

    if (title.has(t)) {
      base = 16;
    } else if (tokens.has(t)) {
      base = 4;
    }

    if (!base) {
      if (lead.has(t)) score += 2 * weight;
      if (tail.has(t)) score += 1.5 * weight;
      continue;
    }

    score += base * weight;
    if (lead.has(t)) score += 2 * weight;
    if (tail.has(t)) score += 2 * weight;
    matched++;
  }

  if (terms.length && matched >= Math.min(2, terms.length)) score += 4;

  // Заголовок, совпавший с запросом целиком, — самый надёжный признак статьи.
  const nq = normalize(c.query || '');
  const nt = normalize(item.title || '');

  if (nq && nt && (nt === nq || nq.indexOf(nt) === 0 || nt.indexOf(nq) === 0)) {
    score += 18;
  }

  // Обзорная статья («Персонажи», «Локации») отвечает на вопрос по смыслу,
  // даже когда слов самого вопроса в ней нет.
  if (intent && intent.title) {
    const label = String(item.title || '') + ' ' +
      (Array.isArray(item.categories) ? item.categories.join(' ') : '');

    if (intent.title.test(label)) score += 22;
  }

  return score;
}

// ---------- выбор доказательства ----------
// Недостаточно найти статью: нужно вытащить из неё тот участок, который
// отвечает на вопрос. Оценка фрагмента:
//   * частотная и нормированная по длине (BM25-подобная), а не «слово есть»;
//   * бонус за раздел, которого требует вопрос (биография, способности, ...);
//   * штраф за служебные блоки (списки языковых ссылок, навигация, галереи),
//     чтобы конец статьи не побеждал содержательный абзац.

const LANG_CODE_RE = /\b(?:en|de|fr|es|it|pl|pt|ru|ja|zh|ko|nl|tr|cs|uk|sv|fi|hu|no|da|ro|el|he|ar|id|vi|th|bg|hr|sk|sr|lt|lv|et|sl|simple)\b/gi;
const BOILERPLATE_RE = /(?:редактировать|править|источник|скачать|навигация|категория|другие языки|edit this|navigation|categories|other languages)/iu;

function termWeight(term) {
  return 1 + Math.min(1.2, Math.max(0, (String(term).length - 4) / 8));
}

// Насколько фрагмент похож на служебный список, а не на текст статьи.
function boilerplateRatio(text) {
  const s = String(text || '');
  const words = s.split(/\s+/).filter(Boolean);

  if (words.length < 8) return 0;

  const lines = s.split('\n').map(x => x.trim()).filter(Boolean);
  const shortLines = lines.filter(l => l.split(/\s+/).length <= 4).length;
  const langHits = (s.match(LANG_CODE_RE) || []).length;
  const bullets = (s.match(/•/g) || []).length;
  let penalty = 0;

  if (lines.length >= 3 && shortLines / lines.length > 0.7) penalty += 0.5;
  if (langHits / Math.max(1, words.length) > 0.05) penalty += 0.6;
  if (BOILERPLATE_RE.test(s)) penalty += 0.3;
  if (bullets >= 4 && lines.length &&
      bullets / lines.length > 0.6 &&
      words.length / lines.length < 5) {
    penalty += 0.4;
  }

  return Math.min(1, penalty);
}

function scoreEvidenceChunk(chunk, terms, query, opts) {
  const o = opts || {};
  const text = normalize(chunk);
  const raw = String(chunk || '');

  if (!text) return 0;

  const tokens = searchTokens(raw);
  const len = tokens.length || 1;
  const tf = new Map();

  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }

  const k1 = 1.2;
  const b = 0.75;
  const avgLen = 220;
  let score = 0;
  let matched = 0;

  for (const term of terms) {
    const f = tf.get(term) || 0;

    if (!f) continue;

    matched++;

    const norm = (f * (k1 + 1)) /
      (f + k1 * (1 - b + b * (len / avgLen)));

    score += norm * termWeight(term);
  }

  if (!matched) {
    // Фрагмент может не совпасть словами, но быть нужным разделом
    // (обзорная статья «Персонажи» на вопрос «кто главные герои»).
    const groupHit = o.hints && o.group &&
      o.hints.indexOf(o.group) !== -1;

    return groupHit ? 3 : 0;
  }

  const coverage = terms.length ? matched / terms.length : 0;

  score += coverage * 4;

  // Точная фраза вопроса внутри фрагмента — сильный признак.
  const q = normalize(query);

  if (q && q.length >= 6 && text.indexOf(q) !== -1) score += 6;

  if (o.hints && o.group && o.hints.indexOf(o.group) !== -1) score += 12;

  // Для вопроса «кто такой/такая X» лид статьи обычно даёт самую
  // точную идентификацию персонажа; не даём биографическому эпизоду
  // вытеснить короткое вводное описание из начала статьи.
  const asksWho = /(?:кто\s+(?:такой|такая|такое|это)|who\s+is|biography)/u.test(
    normalize(query)
  );

  if (asksWho && o.group === 'lead') score += 14;

  const hasEpitaphEvidence =
    /\b(epitaph|inscription|tombstone|gravestone|memorial plaque)\b/u.test(text) ||
    /эпитаф|надпис/u.test(text);

  const hasNameEvidence =
    /\b(real name|birth name|full name|given name|born as|legal name)\b/u.test(text) ||
    /настоящ[\p{L}]*\s+имя|полное имя|имени при рождении/u.test(text);

  if (isEpitaphIntent(query) && hasEpitaphEvidence) score += 55;
  if (isRealNameIntent(query) && hasNameEvidence) score += 28;
  if (isEpitaphIntent(query) && isRealNameIntent(query) &&
      hasEpitaphEvidence && hasNameEvidence) score += 25;

  const boiler = boilerplateRatio(raw);

  if (boiler > 0) score *= Math.max(0.1, 1 - boiler);

  // Совсем короткие обрывки не должны выигрывать у абзаца.
  if (raw.length < 120) score *= 0.6;

  return score;
}

function bestEvidenceChunk(page, terms, query, opts) {
  // Фрагменты пересобираются из полного сохранённого текста: старые chunks
  // могли быть нарезаны прежним парсером и не знать о разделах.
  const rebuilt = makeSectionChunks(page.extract || '', 1200, 200);
  const chunks = rebuilt.length
    ? rebuilt
    : (Array.isArray(page.chunks) ? page.chunks : [])
      .map(text => ({ text: text, section: '', group: '' }));

  if (!chunks.length) {
    return {
      evidence: page.extract || '',
      score: 0,
      section: '',
      group: ''
    };
  }

  const hints = intentSectionHints(query);
  let best = null;
  let bestIndex = -1;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const score = scoreEvidenceChunk(chunk.text, terms, query, {
      group: chunk.group,
      hints: hints
    });

    if (!best || score > best.score) {
      best = { text: chunk.text, score: score };
      bestIndex = i;
    }
  }

  // Короткий фрагмент дополняем следующим из того же раздела: выдержка
  // не должна обрываться на середине мысли.
  const evidence = String(best.text || '');
  const next = chunks[bestIndex + 1];
  let joined = (
    evidence.length < 600 &&
    next &&
    next.group === chunks[bestIndex].group &&
    next.section === chunks[bestIndex].section
  )
    ? (evidence + '\n' + next.text).slice(0, 2000)
    : evidence.slice(0, 2000);

  // При вопросе об одном персонаже лид отвечает «кто это», а биография
  // часто подтверждает роль, происхождение или связь с сюжетом. Передаём
  // оба коротких фрагмента, чтобы не терять вводную идентификацию ради
  // более длинного биографического эпизода.
  const asksWho = /(?:кто\s+(?:такой|такая|такое|это)|who\s+is)/u.test(
    normalize(query)
  );

  if (asksWho && chunks[bestIndex].group === 'lead') {
    let supplement = null;

    for (let i = 0; i < chunks.length; i++) {
      if (i === bestIndex || chunks[i].group === 'lead') continue;

      const candidateScore = scoreEvidenceChunk(chunks[i].text, terms, query, {
        group: chunks[i].group,
        hints: hints
      });

      if (!supplement || candidateScore > supplement.score) {
        supplement = { text: chunks[i].text, score: candidateScore };
      }
    }

    if (supplement && supplement.score > 0) {
      joined = (evidence + '\n\n' + supplement.text).slice(0, 2000);
    }
  }

  return {
    evidence: joined || page.extract || '',
    score: Math.max(0, best.score),
    section: chunks[bestIndex].section || '',
    group: chunks[bestIndex].group || ''
  };
}

function searchCacheGet(key) {
  const hit = SEARCH_CACHE.get(key);

  if (!hit) return null;

  if (Date.now() - hit.at > SEARCH_CACHE_TTL_MS) {
    SEARCH_CACHE.delete(key);
    return null;
  }

  return hit.value;
}

function searchCacheSet(key, value) {
  if (SEARCH_CACHE.size >= SEARCH_CACHE_MAX) {
    const oldest = SEARCH_CACHE.keys().next();
    if (!oldest.done) SEARCH_CACHE.delete(oldest.value);
  }

  SEARCH_CACHE.set(key, { at: Date.now(), value });
}

// При сравнении двух объектов ответ должен содержать выдержки про оба,
// а не только про тот, который чаще совпал по словам.
function interleaveByEntity(list, limit) {
  const groups = {};
  let tagged = false;

  for (const x of list) {
    const key = x.entity || '';
    if (key) tagged = true;
    (groups[key] = groups[key] || []).push(x);
  }

  if (!tagged) return list.slice(0, limit);

  const keys = Object.keys(groups);
  const out = [];
  let i = 0;

  while (out.length < limit) {
    let moved = false;

    for (const key of keys) {
      if (!groups[key][i]) continue;

      out.push(groups[key][i]);
      moved = true;

      if (out.length >= limit) break;
    }

    if (!moved) break;
    i++;
  }

  return out;
}

// Извлекает только явно названную сущность из прямого вопроса. Это не
// перевод и не догадка: исходное название сохраняется и добавляется как
// отдельный поисковый вариант для Wiki на любом языке.
function extractQuestionEntity(query) {
  let q = String(query || '').trim()
    .replace(/^(?:а|ну|и)[,.]?\s+/iu, '')
    .replace(/[?!.]+$/u, '')
    .trim();
  const match = q.match(/^(?:что\s+такое|что\s+это|что\s+за|где\s+(?:находится|расположен(?:а|о|ы)?|располагается)|кто\s+(?:такой|такая|такое|это)|what\s+is|where\s+is|who\s+is)\s+(.+)$/iu);
  if (!match) return '';
  const entity = String(match[1] || '').trim().replace(/[?!.]+$/u, '').trim();
  return entity.length >= 2 && entity.length <= 100 ? entity : '';
}

async function searchGameSingleSource(body, storageIdOverride) {
  const id = slug(body.gameId || body.game || '');
  const storageId = storageIdOverride || id;
  const q = String(body.query || body.q || '').trim().slice(0, MAX_QUERY);
  // fast: только локальный индекс. Нужен для короткого ответа в реплику Алисы.
  const fast = body.fast === true || body.fast === 1 ||
    body.fast === '1' || body.fast === 'true';
  const cacheKey = id + '|' + (storageId === id ? '' : storageId + '|') +
    (fast ? 'fast|' : 'full|') + normalize(q);

  if (!q) {
    throw new Error('query is required');
  }

  const cached = searchCacheGet(cacheKey);

  if (cached) {
    return Object.assign({}, cached, {
      cached: true,
      search: Object.assign({}, cached.search, { cache: 'warm' })
    });
  }

  let manifest = await readJson(manifestKey(storageId));

  if (!manifest) {
    try {
      if (storageId !== id) throw new Error('Language source manifest is missing');
      await registerGame({
        game: body.game || body.gameId,
        gameId: id,
        wikiApi: body.wikiApi || ''
      });
    } catch (e) {
      return {
        status: 'needs_wiki',
        gameId: id,
        message: String(e && e.message || 'Wiki source is not configured')
      };
    }

    manifest = await readJson(manifestKey(storageId));
  }

  if (storageId === id && manifest &&
      !manifest.complete &&
      (manifest.status === 'registered' || manifest.status === 'indexing')) {
    try {
      await syncGame({
        gameId: id,
        limit: Math.min(10, MAX_BATCH)
      });
    } catch (e) {
      console.error('kb auto-sync:', e && e.message);
    }

    manifest = await readJson(manifestKey(storageId));
  }

  let index = await readJson(indexKey(storageId)) || {
    items: []
  };

  const comparison = splitComparison(q);
  const intent = comparison
    ? { name: 'compare', section: '', title: null }
    : detectIntent(q);
  const language = translationLanguage(manifest);

  // Варианты запроса с ролями. Перевод и обе сущности сравнения обязаны
  // попасть в поиск по вики — раньше их отбрасывал порядок массива.
  const basePlan = await buildVariantPlan(id, q, manifest, {
    cacheOnly: fast
  });
  const questionEntity = extractQuestionEntity(q);
  const extraVariants = comparison
    ? comparison.entities.map(e => ({ text: e, kind: 'entity' }))
    : (questionEntity ? [{ text: questionEntity, kind: 'entity' }] : [])
      .concat(intentQueryTerms(intent.name, language)
        .map(t => ({ text: t, kind: 'intent' })));

  const variantPlan = planVariants(
    basePlan.map(x => x.text),
    extraVariants
  );

  // planVariants помечает всё, кроме первого, как alias — возвращаем роли.
  for (const entry of variantPlan) {
    const source = basePlan.find(x => normalize(x.text) === normalize(entry.text));

    if (source) entry.kind = source.kind;

    const extra = extraVariants.find(x => normalize(x.text) === normalize(entry.text));

    if (extra) entry.kind = extra.kind;
  }

  const variants = variantPlan
    .slice()
    .sort((a, b) => VARIANT_RANK[a.kind] - VARIANT_RANK[b.kind])
    .map(x => x.text);

  const warm = await readJson(warmKey(storageId)).catch(() => null);
  const warmPages = intent.section && warm && warm.sections &&
    Array.isArray(warm.sections[intent.section])
    ? warm.sections[intent.section].map(Number).filter(Number.isFinite)
    : [];

  const terms = Array.from(new Set(
    variants.flatMap(v => searchTokens(v))
      .concat(queryHintTerms(q).flatMap(v => searchTokens(v)))
  ));

  const df = documentFrequency(index.items || [], terms);
  const rankCtx = {
    df: df,
    total: (index.items || []).length,
    query: q
  };

  const rank = () => (index.items || [])
    .map(x => ({
      item: x,
      score: scoreItem(x, terms, intent, rankCtx)
    }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  let ranked = rank();

  const hasNonLatin =
    /[^\p{Script=Latin}\p{N}\p{P}\p{Z}\p{S}]/u.test(q);
  const topScore = ranked.length ? ranked[0].score : 0;
  const hasIntentOverview = !intent.title || ranked.some(x =>
    intent.title.test(String(x.item.title || ''))
  );

  // В вики идём только при слабом локальном ответе или когда обзорной статьи
  // по намерению ещё нет. Иначе каждый русский вопрос снова тянул бы вики
  // и снова не укладывался бы в реплику Алисы.
  const needsLiveSearch =
    !fast && (
      topScore < 15 ||
      (hasNonLatin && topScore < 30) ||
      !!(intent.section && !warmPages.length && !hasIntentOverview)
    );

  let liveSearch = {
    added: 0,
    fetched: 0,
    enriched: 0,
    missingContent: 0,
    errors: []
  };

  if (needsLiveSearch) {
    liveSearch = await searchWikiOnDemand(
      storageId,
      manifest,
      index,
      variantsForWiki(variantPlan)
    );

    if (liveSearch.fetched || liveSearch.enriched) {
      ranked = rank();
    }
  }

  // Re-rank a wider set so relevant passages near article ends are not missed.
  const candidateLimit=fast
    ? Math.min(FAST_CANDIDATE_LIMIT,Math.max(4,Number(body.candidateLimit||FAST_CANDIDATE_LIMIT)))
    : Math.min(30,Math.max(10,Number(body.candidateLimit||30)));
  let candidates=ranked.slice(0,candidateLimit);
  const forcedIds=new Set();
  const entitiesOf=new Map();

  // Обзорная статья по намерению («Персонажи», «Локации») и статьи про обе
  // сущности сравнения попадают в выдачу даже без совпадения слов с вопросом.
  const pushForced=(item,entity)=>{
    if(!item||item.pageId===undefined)return;
    if(forcedIds.has(item.pageId))return;
    if(candidates.some(c=>c.item.pageId===item.pageId))return;

    candidates.push({item:item,score:0});
    forcedIds.add(item.pageId);
    if(entity)entitiesOf.set(item.pageId,entity);
  };

  for(const pageId of warmPages.slice(0,WARM_FORCED_PAGES)){
    pushForced((index.items||[]).find(x=>x.pageId===pageId),null);
  }

  if(comparison){
    for(const entity of comparison.entities){
      const entityTerms=searchTokens(entity);

      const top=(index.items||[])
        .map(x=>({item:x,score:scoreItem(x,entityTerms,null,rankCtx)}))
        .filter(x=>x.score>0)
        .sort((a,b)=>b.score-a.score)
        .slice(0,2);

      for(const hit of top){
        const at=candidates.findIndex(c=>c.item.pageId===hit.item.pageId);

        if(at>=0){
          entitiesOf.set(hit.item.pageId,entity);
          continue;
        }

        pushForced(hit.item,entity);
      }
    }
  }

  const needsContent=[];

  for(const hit of candidates){
    const page=await readJson(pageKey(storageId,hit.item.pageId)).catch(()=>null);
    if(!page||!page.extract)needsContent.push(hit.item.pageId);
  }

  if(needsContent.length&&!fast){
    const extra=await enrichWikiPages(
      storageId,
      manifest,
      index,
      needsContent.slice(0,MAX_ENRICH_PAGES)
    );

    liveSearch.enriched+=extra.enriched;
    liveSearch.missingContent+=extra.missing;
    liveSearch.errors.push(...extra.errors);

    if(extra.enriched){
      ranked=rank();
      candidates=ranked.slice(0,candidateLimit);
    }
  }

  const evaluated=[];
  let indexChanged=false;

  for(let offset=0;offset<candidates.length;offset+=8){
    const group=candidates.slice(offset,offset+8);

    const loaded=await Promise.all(group.map(async hit=>{
      const page=await readJson(
        pageKey(storageId,hit.item.pageId)
      ).catch(()=>null);

      if(!page||!page.extract)return null;

      const refreshed=makeIndexItem(page);
      const at=index.items.findIndex(x=>x.pageId===page.pageId);

      if(at>=0){
        if(JSON.stringify(index.items[at])!==JSON.stringify(refreshed)){
          index.items[at]=refreshed;
          indexChanged=true;
        }
      }else{
        index.items.push(refreshed);
        indexChanged=true;
      }

      const picked=bestEvidenceChunk(page,terms,q);
      const forced=forcedIds.has(page.pageId);

      return {
        item:refreshed,
        page,
        evidence:String(picked.evidence||'').slice(0,2000),
        evidenceScore:picked.score,
        evidenceSection:picked.section||'',
        evidenceGroup:picked.group||'',
        score:hit.score+Math.min(90,picked.score*3)+(forced?12:0),
        forced:forced,
        entity:entitiesOf.get(page.pageId)||null
      };
    }));

    evaluated.push(...loaded.filter(Boolean));
  }

  if(indexChanged&&!fast)await writeIndexMerged(storageId,index);

  evaluated.sort((a,b)=>
    b.score-a.score||b.evidenceScore-a.evidenceScore
  );

  const requestedLimit=Math.min(8,Math.max(1,Number(body.limit||5)));
  const usable=evaluated.filter(x=>x.evidenceScore>0||x.forced);
  const selected=interleaveByEntity(usable,requestedLimit);

  const results=selected.map(hit=>{
    const page=hit.page;
    const evidence=hit.evidence;
    const isRussian=/[а-яё]/i.test(page.title+' '+evidence);

    return {
      title:page.title,
      url:page.url,
      revisionId:page.revisionId,
      categories:page.categories,
      score:hit.score,
      evidenceScore:Math.round(hit.evidenceScore*100)/100,
      evidenceSection:hit.evidenceSection||'',
      entity:hit.entity||null,
      evidence,
      contentAvailable:!!page.extract,
      contentLength:page.contentLength||(page.extract||'').length,
      contentSource:page.contentSource||(page.extract?'stored':'missing'),
      source:manifest.source.siteName,
      language:isRussian?'ru':(manifest.source.language||'unknown')
    };
  });

  // Готовность базы считается, а не угадывается: одного manifest.json
  // со status:complete недостаточно. warm:null больше не возвращается.
  const warmState = warmStatusOf(manifest, warm, index);
  const sectionStats = sectionCoverage(warm, index);

  const payload = {
    status: results.length
      ? 'ok'
      : (warmState.ready ? 'no_evidence' : 'indexing'),
    gameId: id,
    game: manifest.game,
    gameVersion: manifest.gameVersion || 'unspecified',
    edition: manifest.edition || 'unspecified',
    database: {
      status: manifest.status,
      pages: manifest.pageCount || (index.items || []).length,
      maxPages: MAX_PAGES,
      initialScanComplete: !!manifest.complete,
      warmReady: warmState.ready,
      sections: sectionStats,
      complete: !!manifest.complete,
      note: 'complete означает только, что первичный обход allpages дошёл до конца; это не значит, что скачаны все статьи вики.'
    },
    intent: { name: intent.name, section: intent.section },
    comparison: comparison ? { entities: comparison.entities } : null,
    warm: warmState,
    search: {
      mode: fast
        ? 'local-fast'
        : (needsLiveSearch ? 'local+wiki' : 'local'),
      fast: fast === true,
      queryVariants: variants,
      wikiVariants: variantsForWiki(variantPlan),
      fetchedPages: liveSearch.fetched,
      addedPages: liveSearch.added,
      enrichedPages: liveSearch.enriched,
      missingContentPages: liveSearch.missingContent,
      translationTarget: translationLanguage(manifest),
      sourceLanguage: translationLanguage(manifest),
      storageNamespace: storageId === id ? 'primary' : storageId.slice(id.length + 1),
      errors: liveSearch.errors
    },
    results
  };

  // Кэшируем только содержательные ответы: пустой быстрый поиск не должен
  // блокировать более полный поиск с обращением к вики.
  if (results.length) searchCacheSet(cacheKey, payload);

  return payload;
}


// Находит локализованный API на том же хосте. Смена языка не создаёт новый
// gameId: дополнительный индекс хранится внутри games/<gameId>/sources/<lang>/.
async function ensureLanguageSource(gameId, manifest, language) {
  const wanted = String(language || '').toLowerCase();
  if (!manifest || !manifest.source || !wanted) return null;

  if (String(manifest.source.language || '').toLowerCase() === wanted) {
    return {
      source: manifest.source,
      storageId: gameId,
      primary: true
    };
  }

  const existing = manifest.languageSources && manifest.languageSources[wanted];
  if (existing && languageSourceCacheFresh(existing)) {
    if (existing.status === 'available' && existing.source && existing.source.api) {
      return {
        source: existing.source,
        storageId: languageSourceStorageId(gameId, wanted),
        primary: false
      };
    }
    if (existing.status === 'unavailable') return null;
  }

  const candidates = localizedWikiApiCandidates(manifest.source, wanted);
  let selected = null;
  let lastError = '';
  const originalHost = (() => {
    try { return new URL(manifest.source.api).hostname.toLowerCase(); }
    catch { return ''; }
  })();

  for (const api of candidates) {
    try {
      const u = validateApiUrl(api);
      const candidateHost = u.hostname.toLowerCase();
      // Тот же сайт — либо тот же хост, либо языковой поддомен Fandom:
      // ru.cyberpunk.fandom.com для cyberpunk.fandom.com.
      const sameSite = candidateHost === originalHost ||
        candidateHost === wanted + '.' + originalHost;
      if (!sameSite) continue;

      const info = await verifyWiki(api);
      const actualLanguage = String(info.language || '').toLowerCase();
      if (actualLanguage !== wanted && !actualLanguage.startsWith(wanted + '-')) continue;

      selected = {
        api: u.toString(),
        ...info,
        discovery: 'same-host-language-path',
        language: actualLanguage
      };
      break;
    } catch (e) {
      lastError = String(e && e.message || e).slice(0, 160);
    }
  }

  manifest.languageSources = manifest.languageSources || {};
  manifest.languageSources[wanted] = selected
    ? {
        status: 'available',
        source: selected,
        storage: languageSourceStorageId(gameId, wanted),
        checkedAt: new Date().toISOString(),
        error: ''
      }
    : {
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        error: lastError
      };
  manifest.languagePreference = {
    preferred: 'ru',
    fallback: String(manifest.source.language || 'unknown'),
    checkedAt: new Date().toISOString()
  };
  manifest.updatedAt = new Date().toISOString();
  await writeJson(manifestKey(gameId), manifest);

  return selected
    ? {
        source: selected,
        storageId: languageSourceStorageId(gameId, wanted),
        primary: false
      }
    : null;
}

async function ensureLanguageManifest(gameId, rootManifest, languageSource, language) {
  const storageId = languageSourceStorageId(gameId, language);
  let manifest = await readJson(manifestKey(storageId)).catch(() => null);

  if (!manifest) {
    const now = new Date().toISOString();
    manifest = {
      schemaVersion: 1,
      gameId: gameId,
      game: rootManifest.game,
      createdAt: now,
      updatedAt: now,
      status: 'complete',
      source: languageSource,
      pageCount: 0,
      cursor: null,
      complete: true,
      lastSyncAt: null,
      lastWarmAt: null,
      warmStatus: 'none',
      warmPages: 0,
      warmSections: {},
      errors: [],
      sourceParentGameId: gameId,
      sourceLanguage: language,
      policy: 'Language-specific MediaWiki pages are stored under this canonical gameId source namespace. The primary game manifest and other language indexes are not overwritten.'
    };

    await writeJson(manifestKey(storageId), manifest);
    await writeJson(indexKey(storageId), { schemaVersion: 1, items: [] });
  } else if (manifest.source && manifest.source.api !== languageSource.api) {
    // Do not silently combine page IDs from two different wikis. A changed API
    // is treated as a different source and must be reviewed before migration.
    throw new Error('Language source API changed; refusing to mix page identifiers');
  }

  return storageId;
}

// Russian-first: быстрый Alice-проход остаётся локальным и не запускает сеть.
// В полном поиске сначала пробуем ru, а старый источник игры используем как
// fallback. Это сохраняет прежний индекс/страницы и не требует новых env vars.
async function searchGame(body) {
  const id = slug(body.gameId || body.game || '');
  const q = String(body.query || body.q || '').trim();
  const fast = body.fast === true || body.fast === 1 ||
    body.fast === '1' || body.fast === 'true';

  if (!q) throw new Error('query is required');
  if (fast) return await searchGameSingleSource(body);

  let rootManifest = await readJson(manifestKey(id)).catch(() => null);
  if (!rootManifest) {
    try {
      await registerGame({
        game: body.game || body.gameId,
        gameId: id,
        wikiApi: body.wikiApi || ''
      });
      rootManifest = await readJson(manifestKey(id)).catch(() => null);
    } catch {
      return await searchGameSingleSource(body);
    }
  }
  if (!rootManifest || !rootManifest.source) {
    return await searchGameSingleSource(body);
  }

  const rootLanguage = String(rootManifest.source.language || 'unknown').toLowerCase();
  const rootIsRussian = rootLanguage === 'ru' || rootLanguage.startsWith('ru-');
  let primaryResult = null;
  let russian = null;
  let russianError = '';

  if (rootIsRussian) {
    // Если корневой источник уже русский, он и есть основной.
    primaryResult = await searchGameSingleSource(body);
    if (primaryResult && Array.isArray(primaryResult.results) && primaryResult.results.length) {
      primaryResult.search = Object.assign({}, primaryResult.search, {
        languagePreference: { preferred: 'ru', used: 'ru', fallbackUsed: false }
      });
      return primaryResult;
    }
    try {
      russian = await ensureLanguageSource(id, rootManifest, 'en');
    } catch (e) {
      russianError = String(e && e.message || e).slice(0, 180);
    }
  } else {
    // Для существующей английской/иной базы сначала пробуем русский API.
    try {
      russian = await ensureLanguageSource(id, rootManifest, 'ru');
    } catch (e) {
      russianError = String(e && e.message || e).slice(0, 180);
    }
  }

  if (russian && russian.source) {
    try {
      const language = rootIsRussian ? 'en' : 'ru';
      const storageId = await ensureLanguageManifest(
        id,
        rootManifest,
        russian.source,
        language
      );
      const alternateResult = await searchGameSingleSource(body, storageId);
      if (alternateResult && Array.isArray(alternateResult.results) && alternateResult.results.length) {
        alternateResult.search = Object.assign({}, alternateResult.search, {
          languagePreference: {
            preferred: 'ru',
            used: language,
            fallbackUsed: language !== 'ru',
            sourceApi: russian.source.api
          }
        });
        return alternateResult;
      }
    } catch (e) {
      russianError = String(e && e.message || e).slice(0, 180);
    }
  }

  const fallback = primaryResult || await searchGameSingleSource(body);
  fallback.search = Object.assign({}, fallback.search, {
    languagePreference: {
      preferred: 'ru',
      used: rootLanguage,
      fallbackUsed: !rootIsRussian,
      reason: russianError ? 'alternate_language_source_error' :
        (russian ? (rootIsRussian ? 'no_english_evidence' : 'no_russian_evidence')
          : 'alternate_language_source_unavailable'),
      error: russianError || undefined
    }
  });
  return fallback;
}

async function statusGame(body) {
  const id = slug(body.gameId || body.game || '');
  const m = await readJson(manifestKey(id));

  if (!m) {
    return {
      status: 'not_found',
      gameId: id
    };
  }

  const warm = await readJson(warmKey(id)).catch(() => null);
  const index = await readJson(indexKey(id)).catch(() => null);
  const state = warmStatusOf(m, warm, index);

  return {
    status: 'ok',
    gameId: id,
    game: m.game,
    databaseStatus: m.status,
    pageCount: m.pageCount,
    complete: m.complete,
    completeMeaning: 'Первичный обход дошёл до конца; поиск по запросу всё ещё может добавлять статьи.',
    warmReady: state.ready,
    warm: state,
    source: m.source,
    languagePreference: m.languagePreference || { preferred: 'ru', fallback: String(m.source && m.source.language || 'unknown') },
    languageSources: Object.fromEntries(Object.entries(m.languageSources || {}).map(([lang, entry]) => [lang, {
      status: entry && entry.status || 'unknown',
      checkedAt: entry && entry.checkedAt || '',
      storage: entry && entry.storage || ''
    }])),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    lastSyncAt: m.lastSyncAt,
    lastWarmAt: m.lastWarmAt || null,
    lastRefreshAt: m.lastRefreshAt || null,
    errors: m.errors || []
  };
}

async function route(event) {
  const q = event.queryStringParameters || {};
  const headers = event.headers || {};

  // HTTP-заголовки регистронезависимы.
  const normalizedHeaders = {};

  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[String(key).toLowerCase()] = value;
  }

  const authorization = String(
    normalizedHeaders.authorization || ''
  ).replace(/^Bearer\s+/i, '').trim();

  const headerToken = String(
    normalizedHeaders['x-kb-token'] || ''
  ).trim();

  // query token оставлен для совместимости с прежними клиентами.
  const auth = q.token || authorization || headerToken;

  if (!TOKEN || !safeEqual(auth, TOKEN)) {
    return json(403, { status: 'forbidden' });
  }

  if (event.httpMethod === 'GET' && q.ping === '1') {
    return json(200, {
      status: 'pong',
      version: KB_VERSION
    });
  }

  let body = {};

  if (event.body) {
    try {
      body = JSON.parse(
        event.isBase64Encoded
          ? Buffer.from(event.body, 'base64').toString('utf8')
          : event.body
      );
    } catch {
      return json(400, { status: 'bad_json' });
    }
  }

  const input = Object.assign({}, q, body);
  const action = String(input.action || '').toLowerCase();

  try {
    if (action === 'register') {
      return json(200, await registerGame(input));
    }

    if (action === 'sync') {
      return json(200, await syncGame(input));
    }

    if (action === 'syncall') {
      return json(200, await syncNextGame());
    }

    if (action === 'refresh') {
      return json(200, await refreshGame(input));
    }

    if (action === 'search') {
      return json(200, await searchGame(input));
    }

    if (action === 'warm') {
      return json(200, await warmGame(input));
    }

    if (action === 'setaliases') {
      return json(200, await setGameAliases(input));
    }

    if (action === 'status') {
      return json(200, await statusGame(input));
    }

    if (action === 'discover') {
      const game = String(input.game || '').trim();

      if (input.wikiApi) {
        const wiki = await resolveWiki(game, input.wikiApi);

        return json(200, {
          status: 'found',
          game,
          source: wiki
        });
      }

      return json(200, await discoverWiki(game));
    }

    return json(400, {
      status: 'bad_request',
      allowedActions: [
        'discover',
        'register',
        'sync',
        'syncAll',
        'refresh',
        'status',
        'search',
        'warm',
        'setAliases'
      ]
    });
  } catch (e) {
    console.error('kb error:', e && e.message);

    return json(502, {
      status: 'error',
      message: String(e && e.message || 'unknown error').slice(0, 240)
    });
  }
}

module.exports.handler = async function (event) {
  try {
    return await route(event || {});
  } catch (e) {
    console.error('kb fatal:', e && e.message);
    return json(500, { status: 'server_error' });
  }
};

module.exports._test = {
  normalize,
  searchTokens,
  stemSearchToken,
  isRealNameIntent,
  isEpitaphIntent,
  queryHintTerms,
  scoreEvidenceChunk,
  bestEvidenceChunk,
  slug,
  stripHtml,
  stripWikitext,
  removeBalancedTemplates,
  makeChunks,
  makeSectionChunks,
  splitSections,
  sectionGroupOf,
  intentSectionHints,
  boilerplateRatio,
  scoreItem,
  documentFrequency,
  detectIntent,
  intentQueryTerms,
  warmPlan,
  warmStatusOf,
  sectionCoverage,
  detectGenre,
  splitComparison,
  cleanCompareSide,
  interleaveByEntity,
  queryVariants,
  planVariants,
  variantsForWiki,
  buildVariantPlan,
  slugVariants,
  translationLanguage,
  localizedWikiApiCandidates,
  extractQuestionEntity,
  languageSourceStorageId,
  languageSourceCacheFresh,
  translateQueryToLanguage,
  wikiPages,
  revisionContent,
  makePageRecord,
  makeIndexItem,
  allowedWikiHost,
  validateApiUrl,
  decodeHtml,
  unwrapSearchUrl,
  CATALOG,
  KB_VERSION
};
