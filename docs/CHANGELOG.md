# Перечень изменений

Только серверная часть (Skill + Vision + опционально Knowledge).
APK, Android и интерфейс не менялись. Новых обязательных переменных окружения нет.

---

## Moon Skill 3.4.1 → 3.4.2 → 3.4.3 (`index.js`)

### 3.4.2

| Было | Стало |
|---|---|
| Любая реплика ≤ 3 слов при активном ожидании считалась опросом старой задачи (`words.length <= 3`) | Опросом считается только явное нетерпение: `isImpatientShort()` — «и что?», «а что?», «ну что там», «дальше», «ещё», «ну», «да», «ага» |
| «Я теперь играю в X», «я сейчас играю в X» не распознавались | `GAME_SET_RES` принимает «сейчас/теперь/опять/снова/уже» и «теперь я в X» |
| Токен в строке запроса: `?token=…` в 4 вызовах | Заголовок `X-Moon-Token`; при 403 — один откат на `?token=…` (совместимость) |
| `TURN_BUDGET_MS 4200`, `ASK 2800`, `ANSWER 1200`, шаг 1200, запас 250 | `3400 / 2400 / 1000 / 1100 / 300` — запас к лимиту Алисы 4,5 с |
| `VER = 9.6-a-v3.4.1` | `VER = 9.6-a-v3.4.2` |

### 3.4.3

| Было | Стало |
|---|---|
| `SHOW_WORDS = ['покаж', 'обвед', ' кто из ']` — «кто из героев сильнее?» считался командой показа | `SHOW_WORDS = ['покаж', 'обвед']` — список совпадает со списком Vision |
| `makeUid`: `user_id` **или** `application_id` (одинаков у всех пользователей) | Только `user_id`; иначе профиль не создаётся |
| `pollAnswer`: при коде ≠ 200 тело ответа не читалось, навык продолжал «собирать» мёртвую задачу | `TERMINAL_STATUSES` (`expired`, `superseded`, `cancelled`, `none`, `not_found`, `cid_conflict`) читаются при любом коде |
| `VER = 9.6-a-v3.4.2` | `VER = 9.6-a-v3.4.3` |

`_test` экспортирует `isShow`, `isGameSet`, `gameFrom`, `splitGameQuestion`,
`makeUid`, `loadState`, `isBareGameTitle`, `normGame`, `isFollowUp`,
`isImpatientShort`, `isGameInfo`, `isExit`, `authVia`.

Контракт с Vision не изменён: те же `q`, `cid`, `game`, `uid`, `supersede`,
те же параметры `answer`, `usergame`.

---

## Moon Vision 4.1.12 → 4.1.13 → 4.1.14 (`moon-vision-core.js`)

### 4.1.13

| Было | Стало |
|---|---|
| `otherGameRec(st, rec)` сравнивал с общим `st.game` | `gameForUid(st, uid)` + `otherGameRec(st, rec, uid)`; в `handleAnswer` и `progressOut` передаётся uid |
| `handleGame` вызывал `cancelOtherGameAnswers(st, game, '')` | Передаётся `cleanUid(uidValue)` — отменяются только свои вопросы |
| Проверка `Q_TTL_S` стояла после ветки восстановления | TTL проверяется **до** восстановления: старая задача сразу `409 expired` |
| Модель: таймаут всегда 35 с; поиск 8 с; добор ещё 35 с | Дедлайн стадии (`DEEP_PHASE_BUDGET_MS` 75 с, `FAST_PHASE_BUDGET_MS` 20 с); таймаут модели = min(35 с, остаток); поиск ограничен остатком; добор только при запасе ≥ 15 с |
| Исключение между `claimPhase` и `savePhase` оставляло `processing_*` навсегда | `try/catch` в `runFastPhase` и `runDeepPhase`: стадия всегда сохраняет итог |
| `BACKEND_VERSION = '4.1.12'` | `'4.1.13'` |

### 4.1.14

| Было | Стало |
|---|---|
| `rec.status='expired'` + `saveState` — слияние по рангу откатывало статус, в `state.json` оставался `processing_deep` | `expireAnswer(id)`: прямой PUT с `If-Match`; снимаются `claimedAt`/`claimId`, пишется `expiredAt` |
| Брошенная запись старше TTL по тому же CID возвращала `query` | Закрывается через `expireAnswer` и возвращается `409 expired` |
| Дубль проверки TTL ниже по функции (мёртвый код) | Удалён |
| `BACKEND_VERSION = '4.1.13'` | `'4.1.14'` |

Новые **необязательные** переменные: `MOON_DEEP_BUDGET_MS`, `MOON_FAST_BUDGET_MS`.
Существующие переменные не переименованы и не изменены.

`index.js` (адаптер асинхронных вызовов) — изменён только комментарий версии.
`VERSION` — `version=4.1.14`, `release=1.1.14-stale-state-truthful`.

---

## Moon Knowledge 0.9.2 → 0.9.3 (ОПЦИОНАЛЬНО, `index.js`)

| Было | Стало |
|---|---|
| `localizedWikiApiCandidates` предлагал только `<host>/ru/api.php` | Добавлены `https://ru.<host>/api.php` и `/w/api.php` для `*.fandom.com` и `*.wiki.gg` |
| `ensureLanguageSource` принимал только тот же хост | Принимает и языковой поддомен того же сайта (`ru.<host>`) |
| `KB_VERSION = '0.9.2'` | `'0.9.3'` |

Патч не входит в обязательную установку и требует проверки в облаке:
он меняет выбор источника (русская вики вместо английской).
