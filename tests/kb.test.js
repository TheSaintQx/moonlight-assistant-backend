'use strict';

// Тесты ОПЦИОНАЛЬНОГО патча Knowledge Engine 0.9.3:
// русская вики на поддомене Fandom должна попадать в кандидаты.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const KB_PATH = path.resolve(__dirname, '..', 'work', 'kb', 'index.js');
const kb = require(KB_PATH);
const t = kb._test;

test('K1. для Fandom предлагается языковой поддомен ru.<host>', () => {
  const source = {
    api: 'https://cyberpunk.fandom.com/api.php',
    server: 'https://cyberpunk.fandom.com'
  };
  const list = t.localizedWikiApiCandidates(source, 'ru');

  assert.ok(list.indexOf('https://ru.cyberpunk.fandom.com/api.php') !== -1,
    'ожидался ru.cyberpunk.fandom.com, получено: ' + list.join(', '));
  assert.ok(list.indexOf('https://cyberpunk.fandom.com/ru/api.php') !== -1,
    'старый вариант /ru/ сохранён для совместимости');
});

test('K2. для английского сохраняется основной адрес', () => {
  const source = {
    api: 'https://cyberpunk.fandom.com/api.php',
    server: 'https://cyberpunk.fandom.com'
  };
  const list = t.localizedWikiApiCandidates(source, 'en');
  assert.equal(list[0], 'https://cyberpunk.fandom.com/api.php');
});

test('K3. посторонний хост не принимается', () => {
  const source = {
    api: 'https://example.com/api.php',
    server: 'https://example.com'
  };
  assert.deepEqual(t.localizedWikiApiCandidates(source, 'ru'), []);
});

test('K4. версия KB обновлена', () => {
  assert.equal(t.KB_VERSION, '0.9.3');
});
