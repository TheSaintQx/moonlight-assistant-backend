'use strict';

// Доказательство «было / стало» на одних и тех же сценариях.
// Запуск из корня архива: node tools/evidence-before-after.js
// Нужен только Node.js 22, зависимостей и сети нет.
// Старые версии берутся из sources-before/, новые — из work/.

const path = require('path');
const h = require(path.resolve(__dirname, '..', 'tests', 'lib', 'harness'));

const OLD_SKILL = path.resolve(__dirname, '..', 'sources-before', 'skill-3.4.1', 'index.js');
const NEW_SKILL = path.resolve(__dirname, '..', 'work', 'skill', 'index.js');
const OLD_CORE = path.resolve(__dirname, '..', 'sources-before', 'vision-4.1.12', 'moon-vision-core.js');
const NEW_CORE = path.resolve(__dirname, '..', 'work', 'vision', 'moon-vision-core.js');

const AUTH = { 'X-Moon-Token': 'test-token' };
const UID_A = h.ufrom('a');
const UID_B = h.ufrom('b');

const nowS = () => Math.floor(Date.now() / 1000);

function kbOk() {
  return {
    status: 'ok',
    game: 'Cyberpunk 2077',
    gameId: 'cyberpunk-2077',
    intent: { name: 'general', section: '' },
    warm: { builtAt: '2026-11-10', pages: 40 },
    results: [{
      title: 'Пасифика',
      evidence: 'Пасифика — район Найт-Сити, построенный корпорацией Найт Корп.',
      entity: 'Пасифика'
    }]
  };
}

async function withSkill(skillPath, opts, fn) {
  h.resetEnv();
  process.env.MOON_TOKEN = 'test-token';
  process.env.MOON_UID_SALT = 'moon:';
  const world = h.createWorld({ cloud: opts.cloud });
  global.fetch = world.fetch;
  delete require.cache[skillPath];
  const skill = require(skillPath);
  return fn(skill, world);
}

function countQuestionPosts(world) {
  return world.calls.cloud.filter(c => c.init && String(c.init.method).toUpperCase() === 'POST').length;
}

function seedStuckRecord(world, o) {
  const opts = o || {};
  const ageS = opts.ageS || 400;
  world.seed('state.json', {
    game: 'Cyberpunk 2077', gameSetAt: Date.now(), lastFrameTs: 0, lastFrameSize: 0,
    qid: 9, frameSeq: 0, ring: [], lastAnswerText: '', lastAnswerAt: 0,
    marker: null, markerSetAt: 0, qcache: {}, warm: null, lastPollAt: 0, backupAt: 0,
    users: { [UID_A]: { game: 'Cyberpunk 2077', gameSetAt: Date.now() } },
    answers: {
      '9': {
        status: 'processing_deep', q: 'где находится пасифика',
        game: 'Cyberpunk 2077', uid: UID_A, cid: 'c-old',
        show: false, fastDone: true, quick: null,
        claimedAt: nowS() - ageS, claimedAtMs: Date.now() - ageS * 1000,
        createdAt: nowS() - ageS, createdAtMs: Date.now() - ageS * 1000
      }
    }
  });
}

// ---------- 1. Короткий обычный вопрос при активном ожидании ----------
async function scenarioShortQuestion(skillPath) {
  return withSkill(skillPath, {
    cloud: () => ({
      status: 200,
      body: { status: 'done', stage: 'deep', text: 'Вудуисты — банда.', unk: false, src: 'kb' }
    })
  }, async (skill, world) => {
    await h.aliceCall(skill, {
      command: 'кто такие вудуисты',
      original: 'Кто такие Вудуисты?',
      message_id: 31,
      state: {
        game: 'Cyberpunk 2077', qid: 555, cid: 'c-pending',
        followUpUntil: Date.now() + 60000, ts: 1
      }
    });
    return countQuestionPosts(world);
  });
}

// ---------- 2. Два пользователя с разными играми ----------
async function scenarioIsolation(corePath) {
  const world = h.createWorld({
    kb: kbOk,
    model: () => ({ speech: 'Пасифика — район Найт-Сити.', unk: false, conf: 0.9 })
  });
  const core = h.loadVision(world, undefined, corePath);

  const a = await h.visionCall(core, {}, {
    q: 'где находится пасифика', game: 'Cyberpunk 2077', cid: 'c-a', uid: UID_A
  }, AUTH);
  await h.visionCall(core, {}, {
    q: 'где найти дракона', game: 'Skyrim', cid: 'c-b', uid: UID_B
  }, AUTH);
  const back = await h.visionCall(core, Object.assign({
    answer: '1'
  }, { qid: a.body.qid, cid: 'c-a', uid: UID_A }), undefined, AUTH);

  return { first: a.body.status, after: back.body.status, text: String(back.body.text || '') };
}

// ---------- 3. Медленная модель при малом бюджете стадии ----------
async function scenarioBudget(corePath) {
  const world = h.createWorld({
    kb: kbOk,
    model: () => ({ delayMs: 3000, speech: 'медленный ответ', unk: false, conf: 0.8 })
  });
  const core = h.loadVision(world, { MOON_DEEP_BUDGET_MS: '1000' }, corePath);
  seedStuckRecord(world, { ageS: 5 });

  const st = world.read('state.json');
  st.answers['9'].status = 'pending';
  st.answers['9'].claimedAt = 0;
  st.answers['9'].claimedAtMs = 0;
  world.seed('state.json', st);

  const started = Date.now();
  await h.visionCall(core, Object.assign({ answer: '1', deep: '1' }, {
    qid: '9', cid: 'c-old', uid: UID_A
  }), undefined, AUTH);
  const spent = Date.now() - started;

  const rec = (world.read('state.json').answers || {})['9'] || {};
  return { status: rec.status, spent };
}

// ---------- 4. Профиль пользователя из application_id ----------
async function scenarioUid(skillPath) {
  return withSkill(skillPath, {
    cloud: () => ({ status: 200, body: { status: 'ok' } })
  }, async (skill) => {
    const t = skill._test;
    const noUser = t.makeUid({ application: { application_id: 'app-1' } });
    const a = t.makeUid({ user: { user_id: 'alice' }, application: { application_id: 'app-1' } });
    const b = t.makeUid({ user: { user_id: 'bob' }, application: { application_id: 'app-1' } });
    return { noUser: noUser, a: a, b: b };
  });
}

// ---------- 5. Честный статус «просрочено» ----------
async function scenarioExpiredTruthful(corePath) {
  const world = h.createWorld();
  const core = h.loadVision(world, undefined, corePath);
  seedStuckRecord(world, { ageS: 400 });

  const res = await h.visionCall(core, Object.assign({
    answer: '1'
  }, { qid: '9', cid: 'c-old', uid: UID_A }), undefined, AUTH);

  const rec = (world.read('state.json').answers || {})['9'] || {};
  return { code: res.code, answer: String(res.body.status || ''), stored: String(rec.status || '') };
}

// ---------- Запуск ----------
(async () => {
  const out = [];
  const say = (s) => { out.push(s); console.log(s); };

  say('1. «Кто такие Вудуисты?», когда предыдущий ответ ещё ждётся.');
  const s1old = await scenarioShortQuestion(OLD_SKILL);
  const s1new = await scenarioShortQuestion(NEW_SKILL);
  say('   Skill 3.4.1: новых запросов в Vision = ' + s1old + '  -> вопрос терялся');
  say('   Skill 3.4.3: новых запросов в Vision = ' + s1new + '  -> вопрос отправлен');
  say('   ИТОГ: ' + (s1old === 0 && s1new >= 1 ? 'ДЕФЕКТ ВОСПРОИЗВЕДЁН И ИСПРАВЛЕН' : 'НЕОЖИДАННЫЙ РЕЗУЛЬТАТ'));
  say('');

  say('2. Пользователь A (Cyberpunk) спросил, затем пользователь B сменил игру на Skyrim.');
  const s2old = await scenarioIsolation(OLD_CORE);
  const s2new = await scenarioIsolation(NEW_CORE);
  say('   Vision 4.1.12: A после вопроса B -> status=' + s2old.after +
    ', текст=' + JSON.stringify(s2old.text.slice(0, 40)));
  say('   Vision 4.1.14: A после вопроса B -> status=' + s2new.after +
    ', текст=' + JSON.stringify(s2new.text.slice(0, 40)));
  say('   ИТОГ: ' + (s2old.after === 'none' && s2new.after !== 'none'
    ? 'ДЕФЕКТ ВОСПРОИЗВЕДЁН И ИСПРАВЛЕН' : 'НЕОЖИДАННЫЙ РЕЗУЛЬТАТ'));
  say('');

  say('3. Медленная модель (3 с) при бюджете стадии 1 с.');
  const s3old = await scenarioBudget(OLD_CORE);
  const s3new = await scenarioBudget(NEW_CORE);
  say('   Vision 4.1.12: статус=' + s3old.status + ', потрачено ' + s3old.spent + ' мс');
  say('   Vision 4.1.14: статус=' + s3new.status + ', потрачено ' + s3new.spent + ' мс');
  // В стенде invocation не убивают по таймауту: он доживает до ответа модели и всё
  // же сохраняет запись. В реальной функции превышение лимита = обрыв до savePhase,
  // то есть ровно то самое «вечное processing_deep» из облачной диагностики.
  say('   ИТОГ: ' + (s3old.spent > 2500 && s3new.spent < 2500
    ? 'ПРЕВЫШЕНИЕ БЮДЖЕТА ВОСПРОИЗВЕДЕНО; НА 4.1.14 СТАДИЯ ЗАКАНЧИВАЕТСЯ ВНУТРИ БЮДЖЕТА'
    : 'НЕОЖИДАННЫЙ РЕЗУЛЬТАТ'));
  say('');

  say('4. Профиль пользователя при отсутствии user_id.');
  const s4old = await scenarioUid(OLD_SKILL);
  const s4new = await scenarioUid(NEW_SKILL);
  say('   Skill 3.4.1: uid без user_id = ' + JSON.stringify(s4old.noUser) +
    ' (стабильный, общий для всех)');
  say('   Skill 3.4.3: uid без user_id = ' + JSON.stringify(s4new.noUser) + ' (профиль не создаётся)');
  say('   ИТОГ: ' + (s4old.noUser !== '' && s4new.noUser === ''
    ? 'ДЕФЕКТ ВОСПРОИЗВЕДЁН И ИСПРАВЛЕН' : 'НЕОЖИДАННЫЙ РЕЗУЛЬТАТ'));
  say('');

  say('5. Зависшая 400 с задача опрашивается («Ну что там?»).');
  const s5old = await scenarioExpiredTruthful(OLD_CORE);
  const s5new = await scenarioExpiredTruthful(NEW_CORE);
  say('   Vision 4.1.12: ответ=' + s5old.code + '/' + s5old.answer +
    ', в состоянии осталось: ' + s5old.stored);
  say('   Vision 4.1.14: ответ=' + s5new.code + '/' + s5new.answer +
    ', в состоянии осталось: ' + s5new.stored);
  say('   ИТОГ: ' + (s5old.stored === 'processing_deep' && s5new.stored === 'expired'
    ? 'ДЕФЕКТ ВОСПРОИЗВЕДЁН И ИСПРАВЛЕН (диагностика больше не врёт)'
    : 'НЕОЖИДАННЫЙ РЕЗУЛЬТАТ'));

  const txt = out.join('\n') + '\n';
  try {
    require('fs').writeFileSync(
      path.resolve(__dirname, '..', 'results', 'evidence-before-after.txt'),
      txt
    );
  } catch (e) { /* печать уже была */ }
})();
