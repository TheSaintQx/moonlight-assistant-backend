'use strict';

// Тесты ядра Moon Vision: состояния задачи, восстановление зависших claim,
// вызов Knowledge Engine, изоляция пользователей, бюджет глубокого этапа.

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./lib/harness');

const AUTH = { 'X-Moon-Token': 'test-token' };

const UID_A = h.ufrom('a');
const UID_B = h.ufrom('b');

function kbOk(results, extra) {
  return () => Object.assign({
    status: 'ok',
    game: 'Cyberpunk 2077',
    gameId: 'cyberpunk-2077',
    intent: { name: 'general', section: '' },
    warm: { builtAt: '2026-11-09', pages: 40 },
    results: results || [{
      title: 'Пасифика',
      evidence: 'Пасифика — район Найт-Сити, построенный корпорацией Найт Корп.',
      entity: 'Пасифика'
    }]
  }, extra || {});
}

function state(world) {
  return world.read('state.json');
}

async function ask(core, opts) {
  const o = opts || {};
  const body = { q: o.q, cid: o.cid };
  if (o.game) body.game = o.game;
  if (o.uid) body.uid = o.uid;
  if (o.supersede) body.supersede = o.supersede;
  return h.visionCall(core, {}, body, AUTH);
}

async function poll(core, qp) {
  return h.visionCall(core, Object.assign({ answer: '1' }, qp), undefined, AUTH);
}

// ---------- базовые предикаты ----------

test('V1. «где находится X» — не визуальный вопрос, «покажи/обведи» — визуальный', () => {
  const world = h.createWorld();
  const core = h.loadVision(world);

  assert.equal(core.__test.isShow('где находится пасифика'), false);
  assert.equal(core.__test.isShow('кто такие вудуисты'), false);
  assert.equal(core.__test.isShow('что такое найт сити'), false);
  assert.equal(core.__test.isShow('покажи, где находится пасифика'), true);
  assert.equal(core.__test.isShow('обведи противника'), true);
});

test('V2. просроченный claim processing_deep можно забрать заново', () => {
  const world = h.createWorld();
  const core = h.loadVision(world);
  const t = core.__test;
  const now = 1000000;

  const stale = { status: 'processing_deep', claimedAt: now - 200, fastDone: true };
  const fresh = { status: 'processing_deep', claimedAt: now - 10, fastDone: true };

  assert.equal(t.claimIsStale(stale, now), true);
  assert.equal(t.canClaimPhase(stale, 'deep', now), true,
    'иначе зависший разбор нельзя дочинить');
  assert.equal(t.canClaimPhase(fresh, 'deep', now), false,
    'свежий claim принадлежит работающему воркеру');
  assert.equal(t.canClaimPhase({ status: 'deep_ready' }, 'deep', now), false);
});

test('V3. повторный запуск разбора ограничен паузой', () => {
  const world = h.createWorld();
  const core = h.loadVision(world);
  const t = core.__test;
  const now = 1000000;

  assert.equal(t.canKickDeep({ status: 'processing_deep', claimedAt: now - 200 }, now), true);
  assert.equal(t.canKickDeep({
    status: 'processing_deep', claimedAt: now - 200, deepKickedAt: now - 5
  }, now), false, 'пауза не даёт запускать разбор на каждый опрос');
  assert.equal(t.canKickDeep({
    status: 'processing_deep', claimedAt: now - 200, deepKickedAt: now - 120
  }, now), true);
});

// ---------- успешный контрольный сценарий ----------

test('V4. «Кто такие Вудуисты?» — ответ из KB с доказательствами', async () => {
  const evidence = 'Вудуисты — банда из Пасифики, занимающаяся контрабандой и защитой района. '
    + 'Они контролируют рынок и держатся обособленно. '.repeat(10);
  const world = h.createWorld({
    kb: kbOk([1, 2, 3, 4, 5].map(i => ({ title: 'Вудуисты ' + i, evidence }))),
    model: () => ({ speech: 'Вудуисты — банда из Пасифики.', unk: false, conf: 0.9 })
  });
  const core = h.loadVision(world);

  const res = await ask(core, {
    q: 'кто такие вудуисты', game: 'Cyberpunk 2077', cid: 'c-voodoo', uid: UID_A
  });

  assert.equal(res.code, 200);
  assert.equal(res.body.status, 'done');
  assert.equal(res.body.src, 'kb');
  assert.equal(res.body.unk, false);
  assert.match(res.body.text, /банда/i);

  // Короткий ответ приходит сразу, окончательный разбор — следующим шагом.
  if (res.body.stage !== 'deep') {
    const deep = await poll(core, { deep: '1', qid: res.body.qid, cid: 'c-voodoo', uid: UID_A });
    assert.equal(deep.body.stage, 'deep');
  }

  const rec = state(world).answers[String(res.body.qid)];
  assert.equal(rec.src, 'kb');
  assert.equal(rec.unk, false);
  assert.equal(rec.deepKb, 'ok');
  assert.equal(rec.deepSources, 5);
  assert.ok(rec.deepKbDiag.evidenceChars > 1000);
  assert.equal(rec.status, 'deep_ready');
});

test('V5. фактологический вопрос без свежего кадра всё равно отвечается из KB', async () => {
  const world = h.createWorld({ kb: kbOk() });
  const core = h.loadVision(world);

  // Старый кадр в хранилище: он не должен мешать ответу по вики.
  world.seed('state.json', {
    game: 'Cyberpunk 2077',
    gameSetAt: Date.now(),
    lastFrameTs: Math.floor(Date.now() / 1000) - 3600,
    lastFrameSize: 1000,
    ring: [{ ts: Math.floor(Date.now() / 1000) - 3600, key: 'frames/f1.jpg' }],
    answers: {},
    qcache: {},
    users: {},
    qid: 0,
    frameSeq: 1
  });

  const res = await ask(core, {
    q: 'где находится пасифика', game: 'Cyberpunk 2077', cid: 'c-old-frame', uid: UID_A
  });

  assert.equal(res.body.status, 'done');
  assert.equal(res.body.src, 'kb');
  assert.ok(world.calls.kb.length >= 1, 'Knowledge Engine должен быть вызван');
});

test('V6. визуальная команда не ходит в Knowledge Engine', async () => {
  const world = h.createWorld({ kb: kbOk() });
  const core = h.loadVision(world);

  const res = await ask(core, {
    q: 'покажи пасифика на карте', game: 'Cyberpunk 2077', cid: 'c-show', uid: UID_A
  });

  assert.equal(res.code, 200);
  assert.equal(world.calls.kb.length, 0, 'поиск по вики для визуальной команды не нужен');
  assert.equal(res.body.src, 'none');
  assert.match(res.body.text, /экран/i);
});

// ---------- изоляция пользователей ----------

test('V7. второй пользователь не скрывает и не портит ответ первого', async () => {
  const world = h.createWorld({
    kb: kbOk(),
    model: () => ({ speech: 'Пасифика — район Найт-Сити.', unk: false, conf: 0.9 })
  });
  const core = h.loadVision(world);

  const a = await ask(core, {
    q: 'где находится пасифика', game: 'Cyberpunk 2077', cid: 'c-a', uid: UID_A
  });
  assert.equal(a.body.status, 'done');

  const b = await ask(core, {
    q: 'где найти дракона', game: 'Skyrim', cid: 'c-b', uid: UID_B
  });
  assert.equal(b.code, 200);

  const back = await poll(core, { qid: a.body.qid, cid: 'c-a', uid: UID_A });
  assert.equal(back.code, 200);
  assert.notEqual(back.body.status, 'none',
    'ответ пользователя A не должен исчезать после вопроса пользователя B');
  assert.match(back.body.text, /Пасифика|район/i);
});

test('V8. чужой uid не может получить ответ', async () => {
  const world = h.createWorld({ kb: kbOk() });
  const core = h.loadVision(world);

  const a = await ask(core, {
    q: 'где находится пасифика', game: 'Cyberpunk 2077', cid: 'c-a2', uid: UID_A
  });

  const stolen = await poll(core, { qid: a.body.qid, cid: 'c-a2', uid: UID_B });
  assert.equal(stolen.code, 404);
  assert.equal(stolen.body.status, 'not_found');
});

test('V9. смена игры одним пользователем не отменяет чужие вопросы', async () => {
  const world = h.createWorld({ kb: () => ({ status: 'ok', game: 'X', results: [] }) });
  const core = h.loadVision(world);

  // Пользователь B поставил игру и задал вопрос, ответ ещё не готов.
  world.seed('state.json', Object.assign(stateSeed(), {
    game: 'Skyrim',
    users: { [UID_B]: { game: 'Skyrim', gameSetAt: Date.now() } },
    answers: {
      '9001': {
        status: 'pending', q: 'где найти дракона', game: 'Skyrim', uid: UID_B,
        cid: 'c-b3', show: false, createdAt: Math.floor(Date.now() / 1000),
        createdAtMs: Date.now()
      }
    }
  }));

  await h.visionCall(core, {}, { game: 'Cyberpunk 2077', uid: UID_A }, AUTH);

  assert.equal(state(world).answers['9001'].status, 'pending',
    'вопрос другого пользователя не должен отменяться');
});

function stateSeed() {
  return {
    game: '', gameSetAt: 0, lastFrameTs: 0, lastFrameSize: 0, qid: 0,
    frameSeq: 0, ring: [], lastAnswerText: '', lastAnswerAt: 0,
    marker: null, markerSetAt: 0, answers: {}, qcache: {}, users: {},
    warm: null, lastPollAt: 0, backupAt: 0
  };
}

// ---------- состояния ответа ----------

test('V10. готовый короткий ответ отдаётся сразу, пока разбор ещё идёт', async () => {
  const world = h.createWorld();
  const core = h.loadVision(world);

  world.seed('state.json', Object.assign(stateSeed(), {
    game: 'Cyberpunk 2077',
    users: { [UID_A]: { game: 'Cyberpunk 2077', gameSetAt: Date.now() } },
    answers: {
      '9002': {
        status: 'quick_ready', q: 'где находится пасифика', game: 'Cyberpunk 2077',
        uid: UID_A, cid: 'c-q1', show: false, fastDone: true,
        quick: { text: 'Короткий ответ про Пасифику.', src: 'kb', unk: false, at: 1 },
        doneAt: Math.floor(Date.now() / 1000), doneAtMs: Date.now(),
        createdAt: Math.floor(Date.now() / 1000), createdAtMs: Date.now()
      }
    }
  }));

  const res = await poll(core, { qid: 9002, cid: 'c-q1', uid: UID_A });
  assert.equal(res.code, 200);
  assert.equal(res.body.status, 'done');
  assert.equal(res.body.stage, 'quick');
  assert.equal(res.body.final, false);
  assert.match(res.body.text, /Короткий ответ/);
});

test('V11. запись в processing_deep с истёкшим claim — разбор перезапускается', async () => {
  const world = h.createWorld({ kb: kbOk() });
  const core = h.loadVision(world);
  const nowS = Math.floor(Date.now() / 1000);

  world.seed('state.json', Object.assign(stateSeed(), {
    game: 'Cyberpunk 2077',
    users: { [UID_A]: { game: 'Cyberpunk 2077', gameSetAt: Date.now() } },
    answers: {
      '9003': {
        status: 'processing_deep', q: 'где находится пасифика', game: 'Cyberpunk 2077',
        uid: UID_A, cid: 'c-stuck', show: false, fastDone: true,
        claimedAt: nowS - 200, claimedAtMs: Date.now() - 200000,
        createdAt: nowS - 210, createdAtMs: Date.now() - 210000,
        quick: null, deepKickedAt: 0
      }
    }
  }));

  const res = await poll(core, { qid: 9003, cid: 'c-stuck', uid: UID_A });

  assert.equal(res.code, 200);
  assert.equal(res.body.status, 'query', 'пока идёт восстановление — «ещё считаю»');
  assert.ok(world.calls.self.length >= 1, 'должен быть запущен фоновый разбор');
  assert.equal(state(world).answers['9003'].deepKickedAt > 0, true);
});

test('V12. зависшая задача старше TTL не висит вечно', async () => {
  const world = h.createWorld({ kb: kbOk() });
  const core = h.loadVision(world);
  const nowS = Math.floor(Date.now() / 1000);

  world.seed('state.json', Object.assign(stateSeed(), {
    game: 'Cyberpunk 2077',
    users: { [UID_A]: { game: 'Cyberpunk 2077', gameSetAt: Date.now() } },
    answers: {
      '9004': {
        status: 'processing_deep', q: 'где находится пасифика', game: 'Cyberpunk 2077',
        uid: UID_A, cid: 'c-old', show: false, fastDone: true,
        claimedAt: nowS - 947, claimedAtMs: Date.now() - 947000,
        createdAt: nowS - 947, createdAtMs: Date.now() - 947000
      }
    }
  }));

  const res = await poll(core, { qid: 9004, cid: 'c-old', uid: UID_A });
  assert.equal(res.code, 409);
  assert.equal(res.body.status, 'expired');
});

test('V13. восстановление завершается: фоновый разбор сохраняет ответ', async () => {
  const world = h.createWorld({
    kb: kbOk(),
    onSelf: async (url, init, calls) => {
      // Эмулируем фоновую invocation: она забирает просроченный claim.
      const u = new URL(url);
      const qid = u.searchParams.get('qid');
      if (u.searchParams.get('deep') === '1') {
        await h.visionCall(coreRef, { deep: '1', qid, token: 'test-token' }, undefined, AUTH);
      }
      return new Response(JSON.stringify({ status: 'accepted' }), { status: 200 });
    }
  });
  const core = h.loadVision(world);
  const coreRef = core;
  const nowS = Math.floor(Date.now() / 1000);

  world.seed('state.json', Object.assign(stateSeed(), {
    game: 'Cyberpunk 2077',
    users: { [UID_A]: { game: 'Cyberpunk 2077', gameSetAt: Date.now() } },
    answers: {
      '9005': {
        status: 'processing_deep', q: 'где находится пасифика', game: 'Cyberpunk 2077',
        uid: UID_A, cid: 'c-rec', show: false, fastDone: true,
        claimedAt: nowS - 200, claimedAtMs: Date.now() - 200000,
        createdAt: nowS - 200, createdAtMs: Date.now() - 200000
      }
    }
  }));

  await poll(core, { qid: 9005, cid: 'c-rec', uid: UID_A });

  const final = await poll(core, { qid: 9005, cid: 'c-rec', uid: UID_A });
  assert.equal(final.code, 200);
  assert.equal(final.body.stage, 'deep', 'после восстановления должен быть разбор');
  assert.equal(final.body.status, 'done');
  assert.ok(String(final.body.text || '').length > 0);
});

test('V14. потерянный qid — 409 expired, а не зависание', async () => {
  const world = h.createWorld();
  const core = h.loadVision(world);
  const res = await poll(core, { qid: 123456, cid: 'c-none', uid: UID_A });
  assert.equal(res.code, 409);
  assert.equal(res.body.status, 'expired');
});

test('V15. чужой CID и неверный формат CID отклоняются', async () => {
  const world = h.createWorld({ kb: kbOk() });
  const core = h.loadVision(world);

  const a = await ask(core, {
    q: 'где находится пасифика', game: 'Cyberpunk 2077', cid: 'c-ok', uid: UID_A
  });

  const wrong = await poll(core, { qid: a.body.qid, cid: 'c-other', uid: UID_A });
  assert.equal(wrong.code, 404);
  assert.equal(wrong.body.status, 'not_found');

  const bad = await ask(core, {
    q: 'что такое найт сити', game: 'Cyberpunk 2077', cid: 'плохой cid', uid: UID_A
  });
  assert.equal(bad.code, 400);
  assert.equal(bad.body.status, 'bad_request');
});

test('V16. без qid, cid и uid ответ не подбирается глобально', async () => {
  const world = h.createWorld();
  const core = h.loadVision(world);
  const res = await poll(core, {});
  assert.equal(res.body.status, 'none');
});

test('V17. опрос progress не отдаёт чужой ответ по uid', async () => {
  const world = h.createWorld({ kb: kbOk() });
  const core = h.loadVision(world);

  await ask(core, { q: 'где находится пасифика', game: 'Cyberpunk 2077', cid: 'c-p', uid: UID_A });
  const res = await h.visionCall(core, { progress: '1', uid: UID_B }, undefined, AUTH);
  assert.equal(res.body.status, 'none');
});

test('V18. глубокий этап укладывается в бюджет и не оставляет processing_deep', async () => {
  const world = h.createWorld({
    kb: kbOk(),
    model: () => ({ delayMs: 3000, speech: 'медленный ответ', unk: false, conf: 0.8 })
  });
  const core = h.loadVision(world, { MOON_DEEP_BUDGET_MS: '1000' });
  const nowS = Math.floor(Date.now() / 1000);

  world.seed('state.json', Object.assign(stateSeed(), {
    game: 'Cyberpunk 2077',
    users: { [UID_A]: { game: 'Cyberpunk 2077', gameSetAt: Date.now() } },
    answers: {
      '9100': {
        status: 'pending', q: 'где находится пасифика', game: 'Cyberpunk 2077',
        uid: UID_A, cid: 'c-budget', show: false, fastDone: true,
        createdAt: nowS, createdAtMs: Date.now()
      }
    }
  }));

  const started = Date.now();
  const res = await poll(core, { deep: '1', qid: 9100, cid: 'c-budget', uid: UID_A });
  const spent = Date.now() - started;

  assert.equal(res.code, 200);
  const rec = state(world).answers['9100'];
  assert.ok(rec, 'запись должна остаться');
  assert.notEqual(rec.status, 'processing_deep',
    'после бюджета задача обязана сохранить результат, а не зависнуть');
  assert.equal(rec.status, 'deep_ready');
  assert.ok(spent < 2500, 'стадия обязана закончиться внутри бюджета, прошло ' + spent + ' мс');
});

test('V19. повторный CID возвращает тот же запрос, а не создаёт второй', async () => {
  const world = h.createWorld({ kb: kbOk() });
  const core = h.loadVision(world);

  const first = await ask(core, {
    q: 'где находится пасифика', game: 'Cyberpunk 2077', cid: 'c-same', uid: UID_A
  });
  const second = await ask(core, {
    q: 'где находится пасифика', game: 'Cyberpunk 2077', cid: 'c-same', uid: UID_A
  });

  assert.equal(second.body.qid, first.body.qid);
  assert.equal(Object.keys(state(world).answers).length, 1);
});

test('V20. другой вопрос с тем же CID отклоняется', async () => {
  const world = h.createWorld({ kb: kbOk() });
  const core = h.loadVision(world);

  await ask(core, { q: 'где находится пасифика', game: 'Cyberpunk 2077', cid: 'c-dup', uid: UID_A });
  const res = await ask(core, { q: 'что такое найт сити', game: 'Cyberpunk 2077', cid: 'c-dup', uid: UID_A });
  assert.equal(res.code, 409);
  assert.equal(res.body.status, 'cid_conflict');
});

// ---------- состояние должно быть правдивым ----------

function seedStuck(world, opts) {
  const o = opts || {};
  const nowS = Math.floor(Date.now() / 1000);
  const ageS = o.ageS || 400;
  const rec = {
    status: o.status || 'processing_deep',
    q: 'где находится пасифика',
    game: 'Cyberpunk 2077',
    uid: o.uid || UID_A,
    cid: o.cid || 'c-old',
    show: false,
    fastDone: true,
    quick: null,
    claimedAt: nowS - ageS,
    claimedAtMs: Date.now() - ageS * 1000,
    createdAt: nowS - ageS,
    createdAtMs: Date.now() - ageS * 1000
  };
  world.seed('state.json', {
    game: 'Cyberpunk 2077', gameSetAt: Date.now(), lastFrameTs: 0, lastFrameSize: 0,
    qid: 9, frameSeq: 0, ring: [], lastAnswerText: '', lastAnswerAt: 0,
    marker: null, markerSetAt: 0, qcache: {}, warm: null, lastPollAt: 0, backupAt: 0,
    users: { [o.uid || UID_A]: { game: 'Cyberpunk 2077', gameSetAt: Date.now() } },
    answers: { '9': rec }
  });
  return rec;
}

test('V21. просроченная задача сохраняется как expired, а не висит processing_deep', async () => {
  const world = h.createWorld();
  const core = h.loadVision(world);
  seedStuck(world, { ageS: 400 });

  const res = await poll(core, { qid: '9', cid: 'c-old', uid: UID_A });
  assert.equal(res.code, 409);
  assert.equal(res.body.status, 'expired');

  const rec = state(world).answers['9'];
  assert.ok(rec, 'запись ещё в пределах хранения');
  assert.equal(rec.status, 'expired',
    'иначе в /diag навсегда видна «живая» задача, которой никто не занимается');
  assert.equal(rec.claimedAt, 0, 'claim снят');

  // Повторный опрос уже сохранённой «просроченной» записи подтверждает статус.
  const again = await poll(core, { qid: '9', cid: 'c-old', uid: UID_A });
  assert.equal(again.body.status, 'expired');
});

test('V22. повтор вопроса с тем же CID после TTL не держит в ожидании', async () => {
  const world = h.createWorld();
  const core = h.loadVision(world);
  seedStuck(world, { ageS: 400, cid: 'c-old' });

  const res = await ask(core, {
    q: 'где находится пасифика', game: 'Cyberpunk 2077', cid: 'c-old', uid: UID_A
  });

  assert.equal(res.code, 409);
  assert.equal(res.body.status, 'expired');
  assert.equal(state(world).answers['9'].status, 'expired');
});

test('V23. живая задача с тем же CID по-прежнему возвращает свой qid', async () => {
  const world = h.createWorld({
    kb: kbOk(),
    model: () => ({ speech: 'Пасифика — район Найт-Сити.', unk: false, conf: 0.9 })
  });
  const core = h.loadVision(world);

  const first = await ask(core, {
    q: 'где находится пасифика', game: 'Cyberpunk 2077', cid: 'c-live', uid: UID_A
  });
  assert.equal(first.code, 200);

  const second = await ask(core, {
    q: 'где находится пасифика', game: 'Cyberpunk 2077', cid: 'c-live', uid: UID_A
  });
  assert.equal(second.code, 200);
  assert.equal(second.body.qid, first.body.qid, 'повторный CID — тот же запрос');
});
