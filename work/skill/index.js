'use strict';

const crypto = require('crypto');

// moonskill v9.6-a-v3.4.3
// Hotfix: обычные вопросы «где находится X?» не должны включать визуальный режим.
// Исправления 3.4.3:
// - «кто из …» больше не считается командой показа: это обычный вопрос;
// - uid берётся только из session.user.user_id. Раньше при отсутствии user_id
//   использовался application_id навыка — он одинаков у всех, и разные
//   пользователи попадали в один профиль;
// - ответ Vision со статусом «просрочен/заменён», пришедший не с кодом 200,
//   сразу считается окончательным: Алиса не говорит лишний раз «собираю».
// Исправления 3.4.2:
// - короткий новый вопрос при активном ожидании больше не съедается как
//   «ну что там» (раньше «Кто такие Вудуисты?» уходило в опрос старой задачи);
// - «я теперь играю в X», «я сейчас играю в X» распознаются как смена игры;
// - токен передаётся заголовком X-Moon-Token, а не в адресе запроса;
//   при 403 навык один раз откатывается на старый способ (?token=);
// - бюджет реплики приведён к лимиту Алисы 4,5 с с запасом на сеть.
// Сохранено из 3.4.1:
// - распознаём установку игры как по request.command, так и по original_utterance;
// - отделяем название игры от вопроса в одной реплике;
// - передаём распознанную игру вместе с вопросом в moon-vision.

const CLOUD_URL = 'https://functions.yandexcloud.net/d4el6hpg7nh0cui52kd2';
const TOKEN = process.env.MOON_TOKEN || '';

// Алиса ждёт ответ навыка 4,5 секунды ВМЕСТЕ с сетью до сервера и обратно.
// Поэтому собственный бюджет реплики меньше лимита: 3,4 с работы + запас.
const TURN_BUDGET_MS    = 3400;
const SAFETY_MS         = 300;
const ASK_TIMEOUT_MS    = 2400;
const ANSWER_TIMEOUT_MS = 1000;
const POLL_STEP_MS      = 1100;
const FOLLOWUP_TTL_MS   = 120000;
const FOLLOWUP_CEIL_MS  = 300000;
const VER               = '9.6-a-v3.4.3';
const VOICE_MAX         = 400;

// Визуальный режим включают явные команды показа/обведения.
// Слово «где» намеренно исключено: «Где находится X?» — обычный вопрос для Wiki/KB.
const SHOW_WORDS = ['покаж', 'обвед'];
function isShow(utter) {
  const s = ' ' + String(utter || '').toLowerCase() + ' ';
  return SHOW_WORDS.some(w => s.indexOf(w) !== -1);
}

function isFollowUp(utter) {
  const s = String(utter || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[!?,.]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return false;
  return /^(ну\s+)?(что|ч[е]|как)\s+(там|вышло|получилось|у\s+нас)$/.test(s) ||
    /^(результат|ответ|готово|есть\s+ответ|а\s+что\s+там|ну\s+что)$/.test(s);
}

// Короткие реплики-нетерпение («и что?», «дальше», «ну»).
// Только они при активном ожидании считаются опросом старой задачи.
// Раньше сюда попадал ЛЮБОЙ вопрос из трёх слов, поэтому новый короткий
// вопрос («Кто такие Вудуисты?») терялся и Алиса снова говорила «собираю».
function isImpatientShort(utter) {
  const s = String(utter || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[!?,.]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return false;
  if (/^(?:и|а|ну)\s+(?:что|че)(?:\s+там)?$/.test(s)) return true;
  return /^(дальше|далее|еще|ждем|жду|ну|ага|да|давай)$/.test(s);
}

const GAME_SET_RES = [
  // «я играю в X», «я теперь играю в X», «играю сейчас в X»
  /^(?:(?:я\s+)?(?:сейчас|теперь|опять|снова|уже)?\s*игра(?:ю|ешь|ет|ем|ете|ут|ют)?\s+в|включи игру|запусти игру)\s+(.+)$/i,
  /^(?:теперь|сейчас)\s+я\s+в\s+(.+)$/i,
  /^запусти лунного[,.!]?\s*(?:я\s+)?в\s+(.+)$/i,
  /^переключи(?:сь)?\s+на\s+(.+)$/i,
  /^я\s+в\s+(.{2,60})$/i,
  /^(?:я\s+)?(?:сейчас\s+|сегодня\s+|теперь\s+)?игра(?:ю|ем)\s+(.+)$/i
];
const GAME_STOP_RE = /(?:^|\s)(порядке?|себе|курс[е]|шок[е]|отпуск[е]|настроени[ие]|движени[ие]|процесс[е]|форм[е]|ток[е]|восторг[е]|поиск[е]|очеред[и]|замешательств[е]|дел[е]|пут[и]|срок[е])/i;
function isGameSet(utter) {
  const s = String(utter || '').toLowerCase().replace(/ё/g, 'е').trim();
  return GAME_SET_RES.some(re => re.test(s));
}
const GAME_FILLER_RE = /^(?:с\s+\S+\s+|со\s+\S+\s+|вдвоем\s+|вдвоём\s+|сейчас\s+|сегодня\s+|теперь\s+)+/i;
const GAME_LEAD_PREP_RE = /^(?:на|за|у|по|про|для|из|от|к|ко|до|без|о|об|при|не|с|со)(?:\s|$)/i;
function gameFrom(utter) {
  const s = String(utter || '').trim();
  for (let i = 0; i < GAME_SET_RES.length; i++) {
    const m = s.match(GAME_SET_RES[i]);
    if (!m) continue;
    let g = m[1].replace(/[.!,?]$/, '').trim();
    if (i === GAME_SET_RES.length - 1) {
      g = g.replace(GAME_FILLER_RE, '').replace(/^в\s+/i, '').trim();
      if (!g || GAME_LEAD_PREP_RE.test(g)) return '';
    }
    g = g.slice(0, 60);
    return GAME_STOP_RE.test(g) ? '' : g;
  }
  return '';
}

// Разбирает реплику, в которой пользователь одновременно назвал игру и задал вопрос:
// «Я играю в Cyberpunk 2077. Кто такой Джонни Сильверхэнд?»
// или «Я играю в Cyberpunk 2077, кто такой Джонни?».
function splitGameQuestion(utter) {
  const raw = String(utter || '').trim();
  if (!raw) return null;
  const questionLead = '(?:кто|что|как|где|сколько|какой|какая|какое|какие|каких|почему|зачем|когда|куда|откуда|чем|чей|можно|есть|дай|скажи|расскажи|найди|покажи|обведи)';
  const separators = new RegExp('[.!?;]\\s+|,\\s+|\\s+(?=' + questionLead + '(?:\\s|[?!,.]|$))', 'ig');
  let match;
  while ((match = separators.exec(raw)) !== null) {
    const prefix = raw.slice(0, match.index).trim();
    const question = raw.slice(match.index + match[0].length).trim();
    if (!question || !isGameSet(prefix)) continue;
    const game = gameFrom(prefix);
    if (game && game.length >= 2) return { game, question };
  }
  return null;
}

function isHelp(utter) {
  const s = String(utter || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[!?,.]/g, '').replace(/\s+/g, ' ').trim()
    .replace(/^алиса,?\s*/, '');
  return /^(помощь|что ты умеешь|какие команды|как пользоваться|команды)$/.test(s);
}
function isExit(utter) {
  const s = String(utter || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[!?,.]/g, '').replace(/\s+/g, ' ').trim();
  return /^(хватит|стоп|выход|выйти|закончить|заверши(ть)?( навык)?|пока|до свидания|спасибо пока)$/.test(s);
}
function isGameInfo(utter) {
  const s = String(utter || '').toLowerCase().replace(/ё/g, 'е');
  return /какая (сейчас )?игра|во что (мы )?играем|во что играешь|какая у нас игра/.test(s);
}

const QUESTION_START_RE = /^(что|как|где|кто|сколько|какой|какая|какое|какие|каких|почему|зачем|когда|куда|откуда|чем|чей|можно|есть|дай|скажи|расскажи|найди|покажи|обведи)(\s|$)/i;
function normGame(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
}
function isBareGameTitle(utter, currentGame) {
  const s = String(utter || '').trim().replace(/[.!]$/, '');
  if (!/^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9 .:'-]{1,58}$/.test(s)) return false;
  if (!/\d/.test(s) || QUESTION_START_RE.test(s)) return false;
  if (currentGame && normGame(currentGame) === normGame(s)) return true;
  const parts = s.split(/\s+/);
  return parts.length >= 2 && parts.length <= 4;
}

function cleanVoice(text) {
  let t = String(text || '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const sents = t.split(/(?<=[.!?…])\s+/).map(s => s.trim()).filter(Boolean);
  t = sents.slice(0, 3).join(' ');
  if (t.length <= VOICE_MAX) return t;
  const cut = t.slice(0, VOICE_MAX - 1);
  return cut.replace(/\s+\S*$/, '').trim() + '…';
}

// Токен не должен попадать в адрес: он остаётся в логах прокси и истории.
// Штатный способ — заголовок X-Moon-Token. Если развёрнутая версия Vision
// его ещё не принимает (403), навык один раз переходит на старый ?token=.
let authVia = 'header';

function authPath(path) {
  if (authVia !== 'query' || !TOKEN) return path;
  return path + (path.indexOf('?') === -1 ? '?' : '&') +
    'token=' + encodeURIComponent(TOKEN);
}

async function rawFetch(path, init, timeoutMs, useHeader) {
  try {
    const headers = Object.assign({}, (init && init.headers) || {});
    if (useHeader && TOKEN) headers['X-Moon-Token'] = TOKEN;
    const res = await fetch(CLOUD_URL + authPath(path), {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = null; }
    return { status: res.status, body, kind: res.status === 200 ? 'ok' : 'http' };
  } catch (e) {
    const kind = (e && e.name === 'TimeoutError') ? 'timeout' : 'network';
    return { status: 0, body: null, kind };
  }
}

async function cloudFetch(path, init, timeoutMs) {
  const first = await rawFetch(path, init, timeoutMs, authVia === 'header');
  if (first.status !== 403 || authVia !== 'header') return first;
  authVia = 'query';
  return await rawFetch(path, init, timeoutMs, false);
}

function makeCid(session, utter) {
  const sid = String((session && session.session_id) || '');
  const hasMessageId = session && session.message_id !== undefined && session.message_id !== null;
  const mid = hasMessageId ? String(session.message_id) : '';
  const nonce = sid && hasMessageId ? sid + ':' + mid : String(Date.now()) + ':' + String(Math.random());
  const digest = crypto.createHash('sha256').update(nonce + ':' + String(utter || '')).digest('hex');
  return 'c-' + digest.slice(0, 24);
}

async function ask(q, game, cid, supersede, timeoutMs, uid) {
  const payload = { q: String(q || '').slice(0, 200), cid: String(cid || '').slice(0, 64) };
  if (game) payload.game = String(game).slice(0, 60);
  if (uid) payload.uid = uid;
  if (supersede) payload.supersede = String(supersede).slice(0, 64);
  return await cloudFetch('', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, Math.max(200, timeoutMs));
}

async function answer(qid, cid, timeoutMs, uid) {
  const p = '?answer=1' +
    (qid ? '&qid=' + encodeURIComponent(qid) : '') +
    (cid ? '&cid=' + encodeURIComponent(cid) : '') +
    (uid ? '&uid=' + encodeURIComponent(uid) : '');
  return await cloudFetch(p, { method: 'GET' },
    Math.max(150, Math.min(ANSWER_TIMEOUT_MS, timeoutMs || ANSWER_TIMEOUT_MS)));
}

async function setGame(game, supersede, timeoutMs, uid) {
  const payload = { game: String(game).slice(0, 60) };
  if (uid) payload.uid = uid;
  if (supersede) payload.supersede = String(supersede).slice(0, 64);
  return await cloudFetch('', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, Math.max(150, Math.min(1200, timeoutMs || 1200)));
}

async function fetchUserGame(uid, timeoutMs) {
  if (!uid) return '';
  const r = await cloudFetch('?usergame=1&uid=' +
    encodeURIComponent(uid), { method: 'GET' }, timeoutMs || 800);
  return (r.kind === 'ok' && r.body && typeof r.body.game === 'string') ? r.body.game.slice(0, 60) : '';
}

function clearPending(s) {
  s.qid = 0; s.cid = ''; s.followUpUntil = 0; s.followUpMax = 0; s.followUpFrom = 0;
}
function slideFollowUp(s) {
  if (!s.followUpMax || !s.followUpFrom) {
    s.followUpMax = Date.now() + FOLLOWUP_CEIL_MS;
    s.followUpFrom = Date.now();
  }
  s.followUpUntil = Math.min(Date.now() + FOLLOWUP_TTL_MS, s.followUpMax);
}
function pluralSec(n) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return 'секунд';
  if (b >= 2 && b <= 4) return 'секунды';
  return n === 1 ? 'секунда' : 'секунд';
}

// Окончательные статусы Vision. Vision отдаёт «просрочен» кодом 409, а не 200,
// поэтому статус проверяем в теле ответа при любом коде: иначе навык ещё
// несколько секунд честно «собирает» уже несуществующую задачу.
const TERMINAL_STATUSES = ['expired', 'superseded', 'cancelled', 'none', 'not_found', 'cid_conflict'];

async function pollAnswer(qid, cid, untilMs, uid) {
  while (Date.now() < untilMs) {
    const remaining = untilMs - Date.now() - SAFETY_MS;
    if (remaining < 150) return null;
    const r = await answer(qid, cid, Math.min(1200, remaining), uid);
    if (r.body && (r.body.status === 'done' || r.body.status === 'clarify')) {
      return { text: String(r.body.text || ''), clarify: r.body.status === 'clarify', meta: r.body };
    }
    if (r.body && TERMINAL_STATUSES.indexOf(String(r.body.status)) !== -1) {
      return { expired: true, why: String(r.body.status) };
    }
    if (r.kind !== 'ok') {
      if (Date.now() + POLL_STEP_MS > untilMs) return null;
      await new Promise(res => setTimeout(res, POLL_STEP_MS));
      continue;
    }
    if (Date.now() + POLL_STEP_MS > untilMs) return null;
    await new Promise(res => setTimeout(res, POLL_STEP_MS));
  }
  return null;
}

function loadState(req) {
  const st = (req && req.state) || {};
  let best = null;
  for (const c of [st.session, st.application, st.user]) {
    if (!c || typeof c !== 'object' || !Object.keys(c).length) continue;
    if (!best || (Number(c.ts) || 0) > (Number(best.ts) || 0)) best = c;
  }
  return best || {};
}

const UID_SALT = process.env.MOON_UID_SALT || 'moon:';
// Только идентификатор ПОЛЬЗОВАТЕЛЯ. application_id — это идентификатор самого
// навыка, он одинаков у всех, и использовать его как uid нельзя: разные люди
// получили бы один общий профиль, вопросы и ответы смешались бы.
function makeUid(session) {
  const s = session || {};
  const raw = (s.user && s.user.user_id) || s.user_id || '';
  if (!raw) return '';
  return 'u-' + crypto.createHash('sha256').update(UID_SALT + String(raw)).digest('hex').slice(0, 24);
}

function resp(text, session, endSession, userState) {
  const out = {
    version: '1.0',
    session: session || {},
    response: {
      text: String(text || '').slice(0, 1024),
      tts: String(text || '').slice(0, 1024),
      end_session: !!endSession
    }
  };
  if (userState) {
    const snap = Object.assign({}, userState, { ts: Date.now() });
    out.session_state = snap;
    out.application_state = snap;
    out.user_state_update = snap;
  }
  return out;
}

module.exports.handler = async function (event) {
  const t0 = Date.now();
  let req = event;
  try {
    if (event && event.body) {
      req = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    }
  } catch (e) { req = event; }

  const session = (req && req.session) || {};
  const utter = String((req && req.request &&
    (req.request.command || req.request.original_utterance)) || '').trim();
  const origUtter = String((req && req.request && req.request.original_utterance) || utter).trim();
  const mergedGameQuestion = splitGameQuestion(origUtter) || splitGameQuestion(utter);
  const activeUtter = mergedGameQuestion ? mergedGameQuestion.question : utter;

  const user = loadState(req);
  const uid = makeUid(session);
  const uState = {
    game: String(user.game || '').slice(0, 60),
    qid: user.qid || 0,
    cid: String(user.cid || '').slice(0, 64),
    followUpUntil: user.followUpUntil || 0,
    followUpMax: user.followUpMax || 0,
    followUpFrom: user.followUpFrom || 0
  };
  if (mergedGameQuestion && mergedGameQuestion.game) uState.game = mergedGameQuestion.game;
  const turnDeadline = t0 + TURN_BUDGET_MS;

  let finalRoute = 'unknown';
  const route = (name) => { finalRoute = name; };
  const reply = (text, endSession, status, meta) => {
    const v = cleanVoice(text);
    const m = meta || {};
    console.log(JSON.stringify({ s: 'moon', v: VER, route: finalRoute,
      status: status || 'ok', ms: Date.now() - t0, end: !!endSession,
      hasGame: !!uState.game, hasQid: !!uState.qid, hasUid: !!uid,
      unk: m.unk === true, src: m.src || 'none', frame_id: m.frame_id || null,
      conf: typeof m.conf === 'number' ? m.conf : null }));
    return resp(v, session, endSession, uState);
  };

  if (!uState.game && uid && ((session.new && !activeUtter) || isGameInfo(activeUtter))) {
    uState.game = await fetchUserGame(uid, 800);
  }

  if (session.new && !activeUtter) {
    route('start');
    return reply(uState.game
      ? 'Привет! Продолжаем ' + uState.game + ' — задавай вопросы, а по слову «покажи» обведу объект на экране.'
      : 'Привет! Я Лунный Ассистент: скажи, во что играешь, и задавай вопросы. По слову «покажи» обведу объект на экране.', false, 'ok');
  }

  if (isExit(activeUtter)) {
    route('exit');
    return reply('До встречи! Удачной игры.', true, 'ok');
  }

  if (isHelp(activeUtter)) {
    route('help');
    return reply('Скажи, во что играешь, и задавай вопросы. «Покажи воина» — обведу объект на экране. «Ну что там» — забрать ответ, если я сказал «собираю».', false, 'ok');
  }

  if (isGameInfo(activeUtter)) {
    route('gameinfo');
    return reply(uState.game ? 'Игра: ' + uState.game + '.' :
      'Игра пока не названа. Скажи, например, «я в Ведьмаке».', false, 'ok');
  }

  const doFollowUp = async () => {
    const hasLocal = !!(uState.followUpUntil || uState.qid || uState.cid);
    if (!hasLocal && !uid) {
      route('followup-none');
      return reply('Я пока ничего не собирал. Задай вопрос.', false, 'none');
    }
    if (uState.followUpUntil && Date.now() > uState.followUpUntil) {
      route('followup-ttl');
      clearPending(uState);
      return reply('Ответ не успел собраться. Спроси ещё раз.', false, 'expired');
    }
    const r = await answer(uState.qid || 0, uState.cid,
      turnDeadline - Date.now() - SAFETY_MS, uid);
    if (r.body && (r.body.status === 'done' || r.body.status === 'clarify')) {
      route(r.body.status === 'clarify' ? 'followup-clarify' : 'followup-done');
      clearPending(uState);
      const t = String(r.body.text || '');
      return reply(t ? t : 'Честно: пока не знаю. Спроси иначе.', false,
        r.body.status === 'clarify' ? 'clarify' : (t ? 'done' : 'done-empty'), r.body);
    }
    if (r.body && (r.body.status === 'superseded' || r.body.status === 'cancelled')) {
      route('followup-superseded');
      clearPending(uState);
      return reply('Этот запрос уже заменён новым. Скажи «ну что там» после нового вопроса.', false, 'superseded');
    }
    if (r.body && r.body.status === 'none') {
      route('followup-none');
      clearPending(uState);
      return reply(hasLocal ? 'Не нашёл запрос, который нужно проверить. Задай вопрос ещё раз.'
        : 'Я пока ничего не собирал. Задай вопрос.', false, 'none');
    }
    if (r.body && r.body.status === 'expired') {
      route('followup-expired');
      clearPending(uState);
      return reply('Ответ не успел собраться. Спроси ещё раз.', false, 'expired');
    }
    if (r.kind === 'network' || r.kind === 'http') {
      route('followup-network');
      return reply('Связь с сервером подвела. Скажи «ну что там» ещё раз.', false, 'network');
    }
    if (r.kind === 'timeout') {
      route('followup-wait');
      slideFollowUp(uState);
      return reply('Ещё собираю. Скажи «ну что там» через минуту.', false, 'wait');
    }
    route('followup-pending');
    slideFollowUp(uState);
    const seen = uState.followUpFrom ?
      Math.round((Date.now() - uState.followUpFrom) / 1000) : 0;
    if (!seen) return reply('Ещё собираю. Скажи «ну что там» через минуту.', false, 'pending');
    return reply('Ещё собираю, прошло около ' + seen + ' ' + pluralSec(seen) +
      '. Скажи «ну что там» позже.', false, 'pending');
  };

  if (isFollowUp(activeUtter)) {
    return await doFollowUp();
  }
  const words = activeUtter.split(/\s+/).filter(Boolean);
  const pendAlive = !!uState.qid || Date.now() < uState.followUpUntil;
  // Опросом старой задачи считаем только явное нетерпение. Любой другой
  // короткий вопрос — это НОВЫЙ вопрос, он должен уйти в Vision.
  if (pendAlive && isImpatientShort(activeUtter) && !isShow(activeUtter) &&
      !isGameSet(activeUtter) && !isBareGameTitle(activeUtter, uState.game)) {
    route('followup-short');
    return await doFollowUp();
  }

  // Одиночная команда установки игры. Проверяем ОБА варианта текста:
  // Алиса может изменить command, но original_utterance сохраняет произнесённую фразу.
  const gameSetByCommand = isGameSet(utter);
  const gameSetByOriginal = isGameSet(origUtter);
  const bareByCommand = isBareGameTitle(utter, uState.game);
  const bareByOriginal = isBareGameTitle(origUtter, uState.game);
  if (!mergedGameQuestion && (gameSetByCommand || gameSetByOriginal || bareByCommand || bareByOriginal) &&
      !isShow(utter) && !isShow(origUtter)) {
    const g = (gameSetByOriginal && gameFrom(origUtter)) ||
      (gameSetByCommand && gameFrom(utter)) ||
      (bareByOriginal ? origUtter : utter).trim().replace(/[.!]$/, '').slice(0, 60);
    if (g) {
      route('setgame');
      const oldCid = uState.cid || (uState.qid ? String(uState.qid) : '');
      clearPending(uState);
      uState.game = g;
      const sg = await setGame(g, oldCid, turnDeadline - Date.now() - SAFETY_MS, uid);
      if (sg.status === 200) {
        return reply('Принято, игра: ' + g + '. Спрашивай!', false, 'ok');
      }
      return reply('Записал у себя: ' + g + '. Бэкенд не подтвердил — если что-то пойдёт не так, назови игру ещё раз.', false, 'degraded');
    }
  }

  const meaningful = words.length >= 2 || isShow(activeUtter);
  if (!meaningful) {
    route('short');
    return reply('Скажи вопрос целиком, или скажи «ну что там».', false, 'short');
  }

  const oldCid = uState.cid || (uState.qid ? String(uState.qid) : '');
  const cid = makeCid(session, activeUtter);
  clearPending(uState);
  uState.cid = cid;
  const r = await ask(activeUtter, uState.game, cid, oldCid,
    Math.min(ASK_TIMEOUT_MS, turnDeadline - Date.now() - SAFETY_MS), uid);

  if (r.body && (r.body.status === 'done' || r.body.status === 'clarify')) {
    route(r.body.status === 'clarify' ? 'ask-clarify' : 'ask-done');
    clearPending(uState);
    const t = String(r.body.text || '');
    return reply(t ? t : 'Честно: пока не знаю. Спроси иначе.', false,
      r.body.status === 'clarify' ? 'clarify' : (t ? 'done' : 'done-empty'), r.body);
  }
  if (r.body && (r.body.status === 'superseded' || r.body.status === 'cancelled' || r.body.status === 'expired')) {
    route('ask-terminal');
    clearPending(uState);
    return reply('Запрос завершён до получения ответа. Задай вопрос ещё раз.', false, r.body.status);
  }
  if (r.body && r.body.status === 'query' && r.body.qid) {
    uState.qid = r.body.qid;
    const got = await pollAnswer(r.body.qid, cid, turnDeadline - SAFETY_MS, uid);
    if (got && got.text) {
      route(got.clarify ? 'poll-clarify' : 'poll-done');
      clearPending(uState);
      return reply(got.text, false, got.clarify ? 'clarify' : 'done', got.meta);
    }
    if (got && got.expired) {
      route('poll-expired');
      clearPending(uState);
      return reply('Ответ не успел собраться или запрос был заменён. Спроси ещё раз.', false, 'expired');
    }
    route('poll-filler');
    slideFollowUp(uState);
    return reply('Собираю ответ. Через минуту скажи «ну что там».', false, 'pending');
  }
  if (r.kind === 'timeout') {
    route('ask-timeout-filler');
    slideFollowUp(uState);
    return reply('Собираю ответ. Через минуту скажи «ну что там».', false, 'pending');
  }
  if (r.kind === 'ok') {
    route('ask-protocol');
    slideFollowUp(uState);
    return reply('Собираю ответ. Через минуту скажи «ну что там».', false, 'protocol');
  }
  if (r.kind === 'http' && r.body && (r.body.status === 'cid_conflict' || r.body.status === 'superseded')) {
    route('ask-cid-conflict');
    slideFollowUp(uState);
    return reply('Этот вопрос уже собирается. Через минуту скажи «ну что там».', false, 'cid-conflict');
  }
  if (r.kind === 'http' && r.body && r.body.status === 'bad_request') {
    route('ask-bad-request');
    return reply('Скажи вопрос целиком, я не поняла.', false, 'bad-request');
  }
  route('ask-network');
  return reply('Связь с сервером подвела. Скажи вопрос ещё раз.', false, 'network');
};

// Экспорт тестовых помощников, чтобы можно было проверить разбор фразы без сети.
module.exports._test = {
  isShow, isGameSet, gameFrom, splitGameQuestion, makeUid, loadState,
  isBareGameTitle, normGame, isFollowUp, isImpatientShort, isGameInfo, isExit,
  get authVia() { return authVia; }
};
