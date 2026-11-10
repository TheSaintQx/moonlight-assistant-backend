'use strict';

// Тесты Moon Skill. Сеть подменена: проверяется реальный разбор реплики
// и реальный протокол обмена с Moon Vision (какие поля уходят, что навык
// делает с каждым статусом ответа).

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./lib/harness');

function scripted(list) {
  let i = 0;
  return (u, init) => {
    const item = list[Math.min(i, list.length - 1)];
    i++;
    const value = typeof item === 'function' ? item(u, init) : item;
    return value;
  };
}

function lastCloud(world) {
  return world.calls.cloud[world.calls.cloud.length - 1];
}

function postCalls(world) {
  return world.calls.cloud.filter(c => c.init && String(c.init.method).toUpperCase() === 'POST');
}

function bodyOf(call) {
  return JSON.parse(call.init.body);
}

// 1. Запуск навыка и приветствие.
test('1. запуск навыка без реплики — приветствие', async () => {
  const world = h.createWorld({ cloud: () => ({ status: 200, body: { status: 'ok' } }) });
  const skill = h.loadSkill(world);
  const { text, res } = await h.aliceCall(skill, { new: true, command: '', original: '' });

  assert.match(text, /Привет/i);
  assert.equal(res.response.end_session, false);
  assert.equal(postCalls(world).length, 0, 'приветствие не должно отправлять вопрос в Vision');
});

// 2. Установка игры.
test('2. «Я играю в Cyberpunk 2077» — игра сохраняется через Vision', async () => {
  const world = h.createWorld({ cloud: () => ({ status: 200, body: { status: 'ok' } }) });
  const skill = h.loadSkill(world);
  const { text, res } = await h.aliceCall(skill, {
    command: 'я играю в cyberpunk 2077',
    original: 'Я играю в Cyberpunk 2077'
  });

  const call = lastCloud(world);
  const body = bodyOf(call);
  assert.equal(body.game, 'Cyberpunk 2077');
  assert.equal(body.q, undefined, 'команда установки игры не должна уходить как вопрос');
  assert.equal(res.session_state.game, 'Cyberpunk 2077');
  assert.match(text, /Принято, игра: Cyberpunk 2077/);
});

// 2b. Вариант с «теперь».
test('2b. «Я теперь играю в Minecraft» — смена игры', async () => {
  const world = h.createWorld({ cloud: () => ({ status: 200, body: { status: 'ok' } }) });
  const skill = h.loadSkill(world);
  const { text, res } = await h.aliceCall(skill, {
    command: 'я теперь играю в minecraft',
    original: 'Я теперь играю в Minecraft'
  });

  const body = bodyOf(lastCloud(world));
  assert.equal(body.game, 'Minecraft');
  assert.equal(res.session_state.game, 'Minecraft');
  assert.match(text, /Minecraft/);
});

// 3. Смена игры.
test('3. «Переключись на Skyrim» — смена текущей игры', async () => {
  const world = h.createWorld({ cloud: () => ({ status: 200, body: { status: 'ok' } }) });
  const skill = h.loadSkill(world);
  const { res } = await h.aliceCall(skill, {
    command: 'переключись на skyrim',
    original: 'Переключись на Skyrim',
    state: { game: 'Cyberpunk 2077', qid: 0, cid: '', followUpUntil: 0, ts: 1 }
  });

  assert.equal(bodyOf(lastCloud(world)).game, 'Skyrim');
  assert.equal(res.session_state.game, 'Skyrim');
});

// 3b. «Запусти игру Ведьмак 3».
test('3b. «Запусти игру Ведьмак 3» — установка игры', async () => {
  const world = h.createWorld({ cloud: () => ({ status: 200, body: { status: 'ok' } }) });
  const skill = h.loadSkill(world);
  await h.aliceCall(skill, {
    command: 'запусти игру ведьмак 3',
    original: 'Запусти игру Ведьмак 3'
  });
  assert.equal(bodyOf(lastCloud(world)).game, 'Ведьмак 3');
});

// 4. Определение игры из совмещённой реплики.
test('4. «Я играю в Cyberpunk 2077. Где находится Пасифика?» — игра отделена от вопроса', async () => {
  const world = h.createWorld({
    cloud: () => ({
      status: 200,
      body: { status: 'done', stage: 'deep', text: 'Пасифика — район Найт-Сити.', unk: false, src: 'kb' }
    })
  });
  const skill = h.loadSkill(world);
  const { text, res } = await h.aliceCall(skill, {
    command: 'где находится пасифика',
    original: 'Я играю в Cyberpunk 2077. Где находится Пасифика?'
  });

  const body = bodyOf(lastCloud(world));
  assert.equal(body.game, 'Cyberpunk 2077');
  assert.equal(body.q, 'Где находится Пасифика?');
  assert.equal(res.session_state.game, 'Cyberpunk 2077');
  assert.match(text, /Пасифика/);
});

// 5. Обычный вопрос «Где находится Пасифика?».
test('5. обычный вопрос «Где находится Пасифика?» уходит фактологическим запросом', async () => {
  const world = h.createWorld({
    cloud: () => ({
      status: 200,
      body: { status: 'done', stage: 'deep', text: 'Это район Найт-Сити.', unk: false, src: 'kb' }
    })
  });
  const skill = h.loadSkill(world);
  const { text } = await h.aliceCall(skill, {
    command: 'где находится пасифика',
    original: 'Где находится Пасифика?',
    state: { game: 'Cyberpunk 2077', qid: 0, cid: '', followUpUntil: 0, ts: 1 }
  });

  const body = bodyOf(lastCloud(world));
  assert.equal(body.q.toLowerCase(), 'где находится пасифика');
  assert.equal(body.game, 'Cyberpunk 2077');
  assert.equal(skill._test.isShow(body.q), false, 'слово «где» не включает визуальный режим');
  assert.match(text, /район/i);
});

// 6-7. Контрольные фактологические вопросы.
test('6. «Кто такие Вудуисты?» — обычный вопрос, ответ из KB', async () => {
  const world = h.createWorld({
    cloud: () => ({
      status: 200,
      body: { status: 'done', stage: 'deep', text: 'Вудуисты — банда из Пасифики.', unk: false, src: 'kb' }
    })
  });
  const skill = h.loadSkill(world);
  const { text } = await h.aliceCall(skill, {
    command: 'кто такие вудуисты',
    original: 'Кто такие Вудуисты?',
    state: { game: 'Cyberpunk 2077', ts: 1 }
  });

  const body = bodyOf(lastCloud(world));
  assert.equal(body.q.toLowerCase(), 'кто такие вудуисты');
  assert.equal(skill._test.isShow(body.q), false);
  assert.match(text, /банда/);
});

test('7. «Что такое Найт-Сити?» — обычный вопрос', async () => {
  const world = h.createWorld({
    cloud: () => ({ status: 200, body: { status: 'done', stage: 'deep', text: 'Найт-Сити — мегаполис.', unk: false, src: 'kb' } })
  });
  const skill = h.loadSkill(world);
  await h.aliceCall(skill, {
    command: 'что такое найт сити',
    original: 'Что такое Найт-Сити?',
    state: { game: 'Cyberpunk 2077', ts: 1 }
  });
  const body = bodyOf(lastCloud(world));
  assert.equal(skill._test.isShow(body.q), false);
  assert.equal(body.q.toLowerCase(), 'что такое найт сити');
});

// 8-9. Явные визуальные команды.
test('8. «Покажи Пасифика на карте» — визуальный режим', async () => {
  const world = h.createWorld({
    cloud: () => ({ status: 200, body: { status: 'done', stage: 'deep', text: 'Отметил район.', unk: false, src: 'screen' } })
  });
  const skill = h.loadSkill(world);
  await h.aliceCall(skill, {
    command: 'покажи пасифика на карте',
    original: 'Покажи Пасифика на карте',
    state: { game: 'Cyberpunk 2077', ts: 1 }
  });
  const body = bodyOf(lastCloud(world));
  assert.equal(skill._test.isShow(body.q), true);
});

test('9. «Обведи противника» — визуальный режим', async () => {
  const world = h.createWorld({
    cloud: () => ({ status: 200, body: { status: 'done', stage: 'deep', text: 'Обвёл противника.', unk: false, src: 'screen' } })
  });
  const skill = h.loadSkill(world);
  await h.aliceCall(skill, {
    command: 'обведи противника',
    original: 'Обведи противника',
    state: { game: 'Cyberpunk 2077', ts: 1 }
  });
  const body = bodyOf(lastCloud(world));
  assert.equal(skill._test.isShow(body.q), true);
});

test('9b. «Покажи, где находится объект» остаётся визуальной командой', () => {
  const world = h.createWorld();
  const skill = h.loadSkill(world);
  assert.equal(skill._test.isShow('Покажи, где находится объект'), true);
  assert.equal(skill._test.isShow('Где найти Джонни?'), false);
  assert.equal(skill._test.isShow('Как пройти задание?'), false);
});

// 10. Follow-up «Ну что там?».
test('10. «Ну что там?» забирает готовый ответ по qid и cid', async () => {
  const world = h.createWorld({
    cloud: () => ({ status: 200, body: { status: 'done', stage: 'deep', text: 'Готовый ответ.', unk: false, src: 'kb' } })
  });
  const skill = h.loadSkill(world);
  const { text, res } = await h.aliceCall(skill, {
    command: 'ну что там',
    original: 'Ну что там?',
    state: {
      game: 'Cyberpunk 2077', qid: 12345, cid: 'c-abc',
      followUpUntil: Date.now() + 60000, followUpMax: Date.now() + 300000,
      followUpFrom: Date.now() - 5000, ts: 1
    }
  });

  const call = lastCloud(world);
  assert.equal(call.qp.answer, '1');
  assert.equal(call.qp.qid, '12345');
  assert.equal(call.qp.cid, 'c-abc');
  assert.equal(call.qp.uid, skill._test.makeUid({ user: { user_id: 'user-1' } }));
  assert.match(text, /Готовый ответ/);
  assert.equal(res.session_state.qid, 0, 'состояние ожидания очищено');
});

// 11. Follow-up после перезапуска контекста (остался только user_state).
test('11. «Ну что там?» после нового диалога — state берётся из user_state', async () => {
  const world = h.createWorld({
    cloud: () => ({ status: 200, body: { status: 'done', stage: 'quick', text: 'Короткий ответ.', unk: false, src: 'kb' } })
  });
  const skill = h.loadSkill(world);
  const event = h.aliceEvent({
    new: true,
    command: 'ну что там',
    original: 'Ну что там?',
    message_id: 2
  });
  event.state = {
    user: {
      game: 'Cyberpunk 2077', qid: 777, cid: 'c-persist',
      followUpUntil: Date.now() + 60000, followUpMax: Date.now() + 300000, ts: 99
    }
  };

  const res = await skill.handler(event);
  const text = JSON.parse(JSON.stringify(res)).response.text;
  assert.equal(lastCloud(world).qp.qid, '777');
  assert.match(text, /Короткий ответ/);
});

// 12. Потерянный QID.
test('12. потерянный QID — понятное сообщение и очистка состояния', async () => {
  const world = h.createWorld({
    cloud: () => ({ status: 200, body: { status: 'none' } })
  });
  const skill = h.loadSkill(world);
  const { text, res } = await h.aliceCall(skill, {
    command: 'ну что там',
    original: 'Ну что там?',
    state: { game: 'Cyberpunk 2077', qid: 999, cid: 'c-lost', followUpUntil: Date.now() + 60000, ts: 1 }
  });

  assert.match(text, /Не нашёл запрос/);
  assert.equal(res.session_state.qid, 0);
  assert.equal(res.session_state.cid, '');
});

// 13. Отсутствующий CID (и qid): поиск последнего запроса пользователя по uid.
test('13. нет qid и cid — запрос ищется по uid', async () => {
  const world = h.createWorld({
    cloud: () => ({ status: 200, body: { status: 'done', stage: 'deep', text: 'Ответ по uid.', unk: false, src: 'kb' } })
  });
  const skill = h.loadSkill(world);
  const { text } = await h.aliceCall(skill, {
    command: 'ну что там',
    original: 'Ну что там?',
    state: { game: 'Cyberpunk 2077', qid: 0, cid: '', ts: 1 }
  });

  const call = lastCloud(world);
  assert.equal(call.qp.qid, undefined);
  assert.equal(call.qp.cid, undefined);
  assert.ok(call.qp.uid);
  assert.match(text, /Ответ по uid/);
});

// 14. Повторный CID.
test('14. повторный CID — «уже собирается», ожидание не теряется', async () => {
  const world = h.createWorld({
    cloud: () => ({ status: 409, body: { status: 'cid_conflict' } })
  });
  const skill = h.loadSkill(world);
  const { text, res } = await h.aliceCall(skill, {
    command: 'где находится пасифика',
    original: 'Где находится Пасифика?',
    state: { game: 'Cyberpunk 2077', ts: 1 }
  });

  assert.match(text, /уже собирается/i);
  assert.ok(res.session_state.cid, 'CID остаётся для повторного опроса');
});

// 15. Ошибка сети.
test('15. ошибка сети при вопросе — честное сообщение', async () => {
  const world = h.createWorld({
    cloud: () => {
      const e = new Error('boom');
      e.name = 'TypeError';
      throw e;
    }
  });
  const skill = h.loadSkill(world);
  const { text } = await h.aliceCall(skill, {
    command: 'где находится пасифика',
    original: 'Где находится Пасифика?',
    state: { game: 'Cyberpunk 2077', ts: 1 }
  });
  assert.match(text, /Связь с сервером подвела/);
});

// 16. Таймаут Vision.
test('16. таймаут POST в Vision — навык просит «ну что там» и не ждёт', async () => {
  const world = h.createWorld({
    cloud: () => {
      const e = new Error('timeout');
      e.name = 'TimeoutError';
      throw e;
    }
  });
  const skill = h.loadSkill(world);
  const { text, res } = await h.aliceCall(skill, {
    command: 'где находится пасифика',
    original: 'Где находится Пасифика?',
    state: { game: 'Cyberpunk 2077', ts: 1 }
  });

  assert.match(text, /Собираю ответ/);
  assert.ok(res.session_state.cid, 'CID сохранён');
  assert.ok(res.session_state.followUpUntil > Date.now(), 'ожидание включено');
});

// 17. Просроченный запрос.
test('17. просроченное ожидание — «ответ не успел собраться» и очистка', async () => {
  const world = h.createWorld({
    cloud: () => ({ status: 200, body: { status: 'expired' } })
  });
  const skill = h.loadSkill(world);
  const { text, res } = await h.aliceCall(skill, {
    command: 'ну что там',
    original: 'Ну что там?',
    state: {
      game: 'Cyberpunk 2077', qid: 5, cid: 'c-old',
      followUpUntil: Date.now() - 1000, ts: 1
    }
  });

  assert.match(text, /не успел собраться/);
  assert.equal(res.session_state.qid, 0);
});

// 18. Зависший processing_deep (ответ Vision «ещё считаю»).
test('18. долгий processing_deep — промежуточное сообщение, ожидание сохраняется', async () => {
  const world = h.createWorld({
    cloud: () => ({ status: 200, body: { status: 'query', stage: 'deep' } })
  });
  const skill = h.loadSkill(world);
  const { text, res } = await h.aliceCall(skill, {
    command: 'ну что там',
    original: 'Ну что там?',
    state: {
      game: 'Cyberpunk 2077', qid: 5, cid: 'c-deep',
      followUpUntil: Date.now() + 60000, followUpMax: Date.now() + 300000,
      followUpFrom: Date.now() - 65000, ts: 1
    }
  });

  assert.match(text, /Ещё собираю/);
  assert.match(text, /секунд/);
  assert.ok(res.session_state.followUpUntil > Date.now());
});

// 19. Одновременные запросы одного UID.
test('19. два вопроса одного UID — разные CID, старый заменяется', async () => {
  const world = h.createWorld({
    cloud: () => ({ status: 200, body: { status: 'query', qid: 111 } })
  });
  const skill = h.loadSkill(world);

  await h.aliceCall(skill, {
    command: 'где находится пасифика', original: 'Где находится Пасифика?',
    message_id: 10, state: { game: 'Cyberpunk 2077', ts: 1 }
  });
  const first = bodyOf(postCalls(world)[0]);

  await h.aliceCall(skill, {
    command: 'кто такие вудуисты', original: 'Кто такие Вудуисты?',
    message_id: 11, state: { game: 'Cyberpunk 2077', qid: 111, cid: first.cid, ts: 2 }
  });
  const second = bodyOf(postCalls(world)[1]);

  assert.notEqual(first.cid, second.cid);
  assert.equal(second.supersede, first.cid);
});

// 20. Запросы двух разных пользователей.
test('20. два пользователя — разные uid и разные игры в запросах', async () => {
  const world = h.createWorld({
    cloud: () => ({ status: 200, body: { status: 'query', qid: 42 } })
  });
  const skill = h.loadSkill(world);

  await h.aliceCall(skill, {
    command: 'где находится пасифика', original: 'Где находится Пасифика?',
    user_id: 'alice-user', state: { game: 'Cyberpunk 2077', ts: 1 }
  });
  await h.aliceCall(skill, {
    command: 'где найти дракона', original: 'Где найти дракона?',
    user_id: 'bob-user', state: { game: 'Skyrim', ts: 1 }
  });

  const a = bodyOf(postCalls(world)[0]);
  const b = bodyOf(postCalls(world)[1]);
  assert.ok(a.uid && b.uid);
  assert.notEqual(a.uid, b.uid);
  assert.equal(a.game, 'Cyberpunk 2077');
  assert.equal(b.game, 'Skyrim');
});

// 21. Восстановление игры конкретного пользователя.
test('21. «Во что мы играем?» — игра восстанавливается у своего пользователя', async () => {
  const world = h.createWorld({
    cloud: (u) => u.searchParams.get('usergame') === '1'
      ? { status: 200, body: { status: 'ok', game: 'The Witcher 3' } }
      : { status: 200, body: { status: 'ok' } }
  });
  const skill = h.loadSkill(world);
  const { text, res } = await h.aliceCall(skill, {
    command: 'во что мы играем',
    original: 'Во что мы играем?',
    state: { game: '', ts: 1 }
  });

  assert.match(text, /Игра: The Witcher 3/);
  assert.equal(res.session_state.game, 'The Witcher 3');
});

// 22. Готовый быстрый ответ при работающем глубоком этапе.
test('22. быстрый ответ при deep_pending отдаётся сразу, без ожидания', async () => {
  const world = h.createWorld({
    cloud: () => ({
      status: 200,
      body: { status: 'done', stage: 'quick', final: false, deep_pending: true, text: 'Коротко: это Пасифика.', unk: false, src: 'kb' }
    })
  });
  const skill = h.loadSkill(world);
  const { text } = await h.aliceCall(skill, {
    command: 'где находится пасифика', original: 'Где находится Пасифика?',
    state: { game: 'Cyberpunk 2077', ts: 1 }
  });
  assert.match(text, /Коротко: это Пасифика/);
});

// 23. Корректное завершение диалога.
test('23. «Хватит» — end_session и прощание', async () => {
  const world = h.createWorld();
  const skill = h.loadSkill(world);
  const { text, res } = await h.aliceCall(skill, { command: 'хватит', original: 'Хватит' });
  assert.equal(res.response.end_session, true);
  assert.match(text, /До встречи/);
});

// 24. Отсутствие ложного визуального режима на обычный вопрос.
test('24. обычные вопросы не включают визуальный режим', () => {
  const world = h.createWorld();
  const skill = h.loadSkill(world);
  const normal = [
    'Где находится Пасифика?',
    'Где найти Джонни?',
    'Что такое Найт-Сити?',
    'Кто такие Вудуисты?',
    'Как пройти задание?'
  ];
  for (const q of normal) {
    assert.equal(skill._test.isShow(q), false, q);
  }
});

// Критический дефект 3.4.1: короткий НОВЫЙ вопрос при активном ожидании
// перехватывался как «ну что там» и терялся.
test('R1. новый вопрос из трёх слов при ожидании уходит в Vision, а не в опрос', async () => {
  const world = h.createWorld({
    cloud: () => ({ status: 200, body: { status: 'done', stage: 'deep', text: 'Вудуисты — банда.', unk: false, src: 'kb' } })
  });
  const skill = h.loadSkill(world);

  const { text } = await h.aliceCall(skill, {
    command: 'кто такие вудуисты',
    original: 'Кто такие Вудуисты?',
    message_id: 31,
    state: {
      game: 'Cyberpunk 2077', qid: 555, cid: 'c-pending',
      followUpUntil: Date.now() + 60000, followUpMax: Date.now() + 300000,
      followUpFrom: Date.now() - 30000, ts: 1
    }
  });

  const posts = postCalls(world);
  assert.equal(posts.length, 1, 'должен быть новый вопрос в Vision');
  assert.equal(bodyOf(posts[0]).q.toLowerCase(), 'кто такие вудуисты');
  assert.match(text, /банда/);
});

test('R2. «И что?» при ожидании — это опрос старой задачи', async () => {
  const world = h.createWorld({
    cloud: () => ({ status: 200, body: { status: 'done', stage: 'deep', text: 'Готово.', unk: false, src: 'kb' } })
  });
  const skill = h.loadSkill(world);

  const { text } = await h.aliceCall(skill, {
    command: 'и что', original: 'И что?', message_id: 32,
    state: {
      game: 'Cyberpunk 2077', qid: 556, cid: 'c-pending2',
      followUpUntil: Date.now() + 60000, ts: 1
    }
  });

  assert.equal(postCalls(world).length, 0);
  assert.equal(lastCloud(world).qp.answer, '1');
  assert.match(text, /Готово/);
});

// Дополнительно: секрет не должен уходить в query string.
test('S. токен передаётся заголовком, а не в адресе', async () => {
  const world = h.createWorld({ cloud: () => ({ status: 200, body: { status: 'ok' } }) });
  const skill = h.loadSkill(world);
  await h.aliceCall(skill, {
    command: 'я играю в cyberpunk 2077', original: 'Я играю в Cyberpunk 2077'
  });

  const call = lastCloud(world);
  assert.equal(call.qp.token, undefined, 'в URL не должно быть токена');
  const headers = call.init.headers || {};
  const token = headers['X-Moon-Token'] || headers['x-moon-token'];
  assert.equal(token, 'test-token');
});

// Дополнительно: разбор названий игр.
test('S2. разбор названий игр и опечаток в названии', () => {
  const world = h.createWorld();
  const skill = h.loadSkill(world);
  const cases = [
    ['Я играю в Cyberpunk 2077', 'Cyberpunk 2077'],
    ['Играю в Ведьмак 3', 'Ведьмак 3'],
    ['я в Minecraft', 'Minecraft'],
    ['Запусти игру Skyrim', 'Skyrim'],
    ['Переключись на Stardew Valley', 'Stardew Valley']
  ];
  for (const [utter, expected] of cases) {
    assert.equal(skill._test.isGameSet(utter), true, utter);
    assert.equal(skill._test.gameFrom(utter), expected, utter);
  }
});

// R3. «Кто из …» — обычный вопрос, а не команда показа.
// Раньше «кто из» входило в список слов визуального режима.
test('R3. «Кто из героев сильнее?» — не визуальная команда', async () => {
  const world = h.createWorld({ cloud: () => ({ status: 200, body: { status: 'ok' } }) });
  const skill = h.loadSkill(world);
  const t = skill._test;

  assert.equal(t.isShow('кто из героев сильнее'), false);
  assert.equal(t.isShow('покажи героев'), true);
  assert.equal(t.isShow('обведи противника'), true);

  await h.aliceCall(skill, {
    command: 'кто из героев сильнее',
    original: 'Кто из героев сильнее?',
    state: { game: 'Cyberpunk 2077', ts: 1 }
  });

  const body = bodyOf(lastCloud(world));
  assert.equal(body.q, 'кто из героев сильнее', 'вопрос должен уйти в Vision');
});

// U. Профиль пользователя не должен строиться из application_id.
// application_id одинаков у всех пользователей навыка: общий uid смешал бы
// вопросы и ответы разных людей.
test('U. uid не подменяется идентификатором навыка (application_id)', async () => {
  const world = h.createWorld({ cloud: () => ({ status: 200, body: { status: 'ok' } }) });
  const skill = h.loadSkill(world);
  const t = skill._test;

  const noUser = t.makeUid({ application: { application_id: 'app-1' } });
  const userA = t.makeUid({ user: { user_id: 'alice' }, application: { application_id: 'app-1' } });
  const userB = t.makeUid({ user: { user_id: 'bob' }, application: { application_id: 'app-1' } });

  assert.equal(noUser, '', 'без user_id профиль не создаётся');
  assert.notEqual(userA, userB);
  assert.match(userA, /^u-[a-f0-9]{24}$/);
});

// T. Vision отвечает «просрочено» кодом 409 — это окончательный ответ.
// Раньше навык не читал тело такого ответа и говорил «Собираю ответ».
test('T. «просрочено» с кодом 409 — сразу честный ответ, без «собираю»', async () => {
  const world = h.createWorld({
    cloud: scripted([
      { status: 200, body: { status: 'query', qid: 7001, cid: 'c-exp' } },
      { status: 409, body: { status: 'expired' } }
    ])
  });
  const skill = h.loadSkill(world);

  const { text, res } = await h.aliceCall(skill, {
    command: 'где находится пасифика',
    original: 'Где находится Пасифика?',
    state: { game: 'Cyberpunk 2077', ts: 1 }
  });

  assert.match(text, /не успел собраться/i);
  assert.doesNotMatch(text, /собираю/i);
  assert.equal(res.session_state.qid, 0, 'ожидание очищено');
  assert.equal(res.session_state.cid, '');
});

// T2. Тот же случай, но пришёл только статус «заменён» с кодом 409.
test('T2. 409 со статусом superseded не оставляет навык ждать', async () => {
  const world = h.createWorld({
    cloud: scripted([
      { status: 200, body: { status: 'query', qid: 7002, cid: 'c-sup' } },
      { status: 409, body: { status: 'superseded' } }
    ])
  });
  const skill = h.loadSkill(world);

  const { text } = await h.aliceCall(skill, {
    command: 'что такое найт сити',
    original: 'Что такое Найт-Сити?',
    state: { game: 'Cyberpunk 2077', ts: 1 }
  });

  assert.match(text, /не успел собраться|заменён/i);
  assert.doesNotMatch(text, /собираю/i);
});
