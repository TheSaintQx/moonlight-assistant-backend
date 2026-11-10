'use strict';

// Интеграционные тесты: настоящий Moon Skill + настоящее ядро Vision,
// сеть подменена только на границах (Object Storage, Knowledge Engine, модель).
// Проверяется весь путь: реплика Алисы -> Skill -> Vision -> KB -> ответ.

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./lib/harness');

function kbFor(map) {
  return (payload) => {
    const game = String(payload.game || '');
    const hit = map[game.toLowerCase()];
    if (!hit) {
      return { status: 'no_evidence', game, results: [] };
    }
    return {
      status: 'ok',
      game,
      gameId: game.toLowerCase().replace(/\s+/g, '-'),
      intent: { name: 'general', section: '' },
      warm: { builtAt: '2026-11-09', pages: 30 },
      results: [{ title: hit.title, evidence: hit.evidence }]
    };
  };
}

function wire(options) {
  const o = options || {};
  let coreRef = null;

  const world = h.createWorld(Object.assign({}, o, {
    cloud: async (u, init) => {
      const qp = {};
      for (const [k, v] of u.searchParams.entries()) qp[k] = v;
      const event = {
        httpMethod: String((init && init.method) || 'GET').toUpperCase(),
        headers: (init && init.headers) || {},
        queryStringParameters: qp,
        body: (init && init.body) || ''
      };
      const res = await coreRef.handler(event);
      return { status: res.statusCode, body: JSON.parse(res.body) };
    },
    onSelf: async (url, init) => {
      const u = new URL(url);
      if (u.searchParams.get('deep') === '1') {
        const qp = {};
        for (const [k, v] of u.searchParams.entries()) qp[k] = v;
        await coreRef.handler({
          httpMethod: 'GET',
          headers: init && init.headers || {},
          queryStringParameters: qp,
          body: ''
        });
      }
      return new Response(JSON.stringify({ status: 'accepted' }), { status: 200 });
    }
  }));

  const core = h.loadVision(world);
  coreRef = core;
  const skill = h.loadSkill(world);
  return { world, core, skill };
}

test('I1. полный цикл: игра + вопрос -> короткий ответ -> разбор', async () => {
  const { world, core, skill } = wire({
    kb: kbFor({
      'cyberpunk 2077': {
        title: 'Пасифика',
        evidence: 'Пасифика — район Найт-Сити, построенный корпорацией Найт Корп.'
      }
    }),
    model: () => ({ speech: 'Пасифика — район Найт-Сити.', unk: false, conf: 0.9 })
  });

  const first = await h.aliceCall(skill, {
    command: 'где находится пасифика',
    original: 'Я играю в Cyberpunk 2077. Где находится Пасифика?',
    message_id: 1
  });

  assert.match(first.text, /Пасифика|район/i);
  assert.equal(first.res.session_state.game, 'Cyberpunk 2077');

  const rec = Object.values(world.read('state.json').answers)
    .find(r => r.q === 'где находится пасифика');
  assert.ok(rec, 'запрос должен быть создан');
  assert.equal(rec.game, 'Cyberpunk 2077');
  assert.equal(rec.src, 'kb');
  assert.ok(rec.uid);

  // Пользователь просит разбор — Vision отдаёт окончательный ответ.
  const second = await h.aliceCall(skill, {
    command: 'ну что там',
    original: 'Ну что там?',
    message_id: 2,
    state: first.res.session_state
  });
  assert.match(second.text, /Пасифика|район|Проверенный/i);
});

test('I2. два пользователя с разными играми не перемешиваются', async () => {
  const { world, core, skill } = wire({
    kb: kbFor({
      'cyberpunk 2077': { title: 'Пасифика', evidence: 'Пасифика — район Найт-Сити.' },
      'skyrim': { title: 'Дракон', evidence: 'Драконы в Скайриме встречаются у гор и в долинах.' }
    }),
    model: () => ({ speech: 'Ответ из базы знаний.', unk: false, conf: 0.9 })
  });

  const a = await h.aliceCall(skill, {
    command: 'где находится пасифика',
    original: 'Я играю в Cyberpunk 2077. Где находится Пасифика?',
    user_id: 'alice', message_id: 1
  });
  assert.match(a.text, /район|Ответ/i);

  const b = await h.aliceCall(skill, {
    command: 'где найти дракона',
    original: 'Где найти дракона?',
    user_id: 'bob', message_id: 1,
    state: { game: 'Skyrim', ts: 1 }
  });
  assert.match(b.text, /дракон|Ответ/i);

  // Алиса снова спрашивает у первого пользователя.
  const a2 = await h.aliceCall(skill, {
    command: 'ну что там',
    original: 'Ну что там?',
    user_id: 'alice', message_id: 2,
    state: a.res.session_state
  });
  assert.match(a2.text, /Пасифика|район|Ответ/i);
  assert.doesNotMatch(a2.text, /Скайрим/i);

  const st = world.read('state.json');
  assert.ok(Object.keys(st.users).length >= 2, 'у каждого пользователя свой профиль');
});

test('I3. зависший processing_deep восстанавливается через «ну что там»', async () => {
  const { world, core, skill } = wire({
    kb: kbFor({
      'cyberpunk 2077': { title: 'Пасифика', evidence: 'Пасифика — район Найт-Сити.' }
    }),
    model: () => ({ speech: 'Пасифика — район Найт-Сити.', unk: false, conf: 0.9 })
  });

  const skillState = { user: { user_id: 'user-1' } };
  const uid = skill._test.makeUid(skillState);
  const nowS = Math.floor(Date.now() / 1000);

  // Имитируем запись, которую бросил убитый воркер (как в облаке: claim 947 с).
  world.seed('state.json', {
    game: 'Cyberpunk 2077', gameSetAt: Date.now(), lastFrameTs: 0, lastFrameSize: 0,
    qid: 9400, frameSeq: 0, ring: [], lastAnswerText: '', lastAnswerAt: 0,
    marker: null, markerSetAt: 0, qcache: {}, warm: null, lastPollAt: 0, backupAt: 0,
    users: { [uid]: { game: 'Cyberpunk 2077', gameSetAt: Date.now() } },
    answers: {
      '9400': {
        status: 'processing_deep', q: 'где находится пасифика',
        game: 'Cyberpunk 2077', uid, cid: 'c-stuck-int', show: false,
        fastDone: true, quick: null,
        claimedAt: nowS - 200, claimedAtMs: Date.now() - 200000,
        createdAt: nowS - 200, createdAtMs: Date.now() - 200000,
        deepKickedAt: 0
      }
    }
  });

  const state = {
    game: 'Cyberpunk 2077', qid: 9400, cid: 'c-stuck-int',
    followUpUntil: Date.now() + 60000, followUpMax: Date.now() + 300000,
    followUpFrom: Date.now() - 210000, ts: 1
  };

  const first = await h.aliceCall(skill, {
    command: 'ну что там', original: 'Ну что там?', message_id: 5, state
  });
  assert.match(first.text, /собираю/i);

  const second = await h.aliceCall(skill, {
    command: 'ну что там', original: 'Ну что там?', message_id: 6,
    state: first.res.session_state
  });
  assert.match(second.text, /Пасифика|район/i, 'после восстановления должен прийти разбор');
  assert.equal(second.res.session_state.qid, 0, 'ожидание очищено');
});

test('I4. обычный вопрос не вызывает поиск по вики, если это команда показа', async () => {
  const { world, skill } = wire({
    kb: kbFor({ 'cyberpunk 2077': { title: 'X', evidence: 'Y' } })
  });

  const res = await h.aliceCall(skill, {
    command: 'покажи пасифика на карте',
    original: 'Покажи Пасифика на карте',
    state: { game: 'Cyberpunk 2077', ts: 1 }
  });

  assert.equal(world.calls.kb.length, 0);
  assert.match(res.text, /экран|выделить/i);
});

test('I5. контрольный сценарий «Вудуисты» после исправлений работает', async () => {
  const { world, skill } = wire({
    kb: kbFor({
      'cyberpunk 2077': {
        title: 'Вудуисты',
        evidence: 'Вудуисты — банда из Пасифики. Она занимается контрабандой и защищает район.'
      }
    }),
    model: () => ({ speech: 'Вудуисты — банда из Пасифики.', unk: false, conf: 0.9 })
  });

  const res = await h.aliceCall(skill, {
    command: 'кто такие вудуисты',
    original: 'Кто такие Вудуисты?',
    state: { game: 'Cyberpunk 2077', ts: 1 }
  });

  assert.match(res.text, /банда/i);
  const rec = Object.values(world.read('state.json').answers)[0];
  assert.equal(rec.src, 'kb');
  assert.equal(rec.unk, false);
});
