# 02 — ARCHITECTURE (as observed)

Область — только `fetched/` (`irz-web-gpio`). Оценка «как есть», без сравнения с таргетом
(сравнение — в [16_RECOMMENDED_TARGET_ARCHITECTURE.md](16_RECOMMENDED_TARGET_ARCHITECTURE.md)).

## Форма системы

Единый Node.js-процесс (Express), один файл маршрутов (`server.js`), без внутреннего деления
на слои/модули по доменам — фактически «Modular» здесь означает деление по **файлам**
(`db.js`/`auth.js`/`modemState.js`/`mailer.js`/`mercury*.js`), а не по бизнес-доменам с
явными границами и контрактами. CONFIRMED (весь код прочитан/прогреплен).

Второй процесс — Java-демон `GpioDaemon` (`service.GpioDaemon` из вендорского
`Service.jar`), запускается как child_process из `server.js` (`spawn('java', [...])`),
держит одно постоянное соединение к порту 5010 iRZ Collector. Это единственный воркер за
пределами основного event loop — де-факто примитивная форма «+ Workers» из таргет-архитектуры,
но нежёстко изолированная (общается через stdin/stdout текстовым построчным протоколом,
падение демона — не изолированный сбой, а состояние, которое основной процесс отслеживает и
на которое реагирует автоперезапуском). CONFIRMED.

## Потоки данных (как реализовано сейчас)

### 1. Модем / GPIO-канал (не РС-485)
```
GPIO/CSQ/temp/LBS/USSD запрос
  → server.js queueCommand() → MySQL irzserver4.commands (INSERT)
  → triggerSend() → пишет команду в TRIGGER_DIR → Java GpioDaemon → TCP:5010 → iRZ Collector → модем
  → ответ модема пишется Collector'ом обратно в irzserver4.commands.answer
  → server.js waitAnswer() читает поллингом ту же таблицу
```
Очередь на канал модема — `state.serializeGpioFor(modemId, fn)` (промис-цепочка с 30с
таймаут-гвардом, см. [06_IRZ_MODEMS.md](06_IRZ_MODEMS.md)). CONFIRMED.

### 2. Счётчики Меркурий (RS-485, отдельно от канала модема)
```
mercuryPoll.js / mercuryProfilePoll.js
  → net.connect() напрямую на "прозрачный порт" iRZ Collector (host=COLLECTOR_HOST, port из БД)
  → протокольный обмен кадрами Меркурий (CRC16, см. 07_RS485_AND_METERS.md)
  → парсинг → readings (SQLite)
```
Очередь на шину — `state.serializeFor(modemId, fn, {priority})`, отдельная от очереди GPIO
(hi/lo приоритетные списки; ручной клик обгоняет фоновые задачи, но не прерывает уже
выполняющуюся). CONFIRMED — это осознанное разделение (см. память `irz-gpio-mercury-queue-split`,
подтверждено в самом коде: два разных модуля очередей в `modemState.js`).

### 3. Измерительный конвейер факто (по сравнению с целевым RAW→VALIDATION→NORMALIZATION→CONSUMPTION→CALCULATION)

| Целевая стадия | Что есть сейчас | Where |
|---|---|---|
| RAW | ответ протокола Меркурий (байты кадра) | `mercuryProtocol.js` parse-функции |
| VALIDATION | частично: CRC16-проверка кадра, проверка непрерывности профиля (`isNextPeriod`), фильтр «регистр не задействован» (`0xFFFFFFFF`→null) | `mercuryProtocol.js`, `mercuryProfilePoll.js` |
| NORMALIZATION | вычисление кВт/кВт·ч из сырых импульсов через `meterConstant`; коэффициент ТТ (`ct_ratio`) применяется отдельно, на чтении | `mercuryProfile.js` (recordToPower), `server.js` (scaleByCtRatio) |
| CONSUMPTION | `SUM(COALESCE(kwh, kwh_self))` по диапазону дат — вычисляется на лету при каждом запросе, не материализуется | `server.js` sumConsumptionKwh() |
| COMMERCIAL CALCULATION | вычисляется на лету при каждом запросе/экспорте (тариф × расход, посегментно при смене тарифа); **результат нигде не сохраняется как отдельная неизменяемая запись** | `server.js` computeSiteTariffCost() |

Все пять стадий физически проходят внутри одного и того же файла/процесса, без отдельных
таблиц-границ между «raw» и «validated» (это единая таблица `readings`, различие —
не в структуре данных, а в том, какая функция что из неё читает). PARTIALLY CONFIRMED —
разделение по смыслу есть (см. `db.js` — комментарии явно проговаривают, что `kwh` (профиль
счётчика) и `kwh_self` (самозапись из дельты энергии) — два независимых источника с разным
доверием), но нет отдельной таблицы `raw_readings` vs `meter_readings` вроде таргетной.

## Multitenancy — как физически реализовано

Один процесс, одна SQLite-база на все проекты (`/opt/irz-web/data/app.db`), разделение —
на уровне строк (`project_id`/`modem_id` FK) плюс middleware, которое на каждый запрос
резолвит `req.projectId` (из сессии) → `req.modem` (`WHERE project_id = ?`) → `req.meter`
(`WHERE modem_id = ?`). Один проект = **ровно один активный модем** в текущей реализации
(`SELECT ... LIMIT 1`, см. `server.js:1242`) — де-факто предположение "1 объект = 1 модем",
которое таргет-архитектура (`Modem → RS485 Bus → Meter #1..N` без ограничения на число
модемов) не декларирует явно, но и не запрещает пересмотреть. CONFIRMED код,
UNKNOWN — является ли это ограничение сознательным продуктовым решением или техдолгом
(не задокументировано явно нигде, кроме самого кода).

## Фоновые задачи (единственная форма "scheduling" в системе)

`setInterval`, все в одном процессе, без внешнего шедулера/очереди задач:

| Что | Период | Назначение |
|---|---|---|
| `tickAllModems` | `MERCURY_POLL_SEC` = 60с | опрос GPIO/CSQ/temp модемов |
| `tickAllMercury` | `MERCURY_BUS_POLL_SEC` = 120с | опрос мгновенных величин счётчиков |
| `tickAllProfiles` | 10 мин | опрос профиля/энергии по тарифам (сам себя лимитирует — «дорогие» команды) |
| `rotateReadings` | 24 ч | ротация `readings` старше `RETENTION_MONTHS`=24 |
| `tickAlerts` | `ALERT_TICK_MS` (см. server.js) | детектор инцидентов (тишина/лимиты) |
| `tickReports` | `REPORT_TICK_MS` | автоматизированные email-отчёты |

CONFIRMED (grep всех `setInterval` вызовов, offset 900-912, 2292-2293). Все задачи —
in-process; при рестарте процесса частично восстанавливаемое состояние (SQLite), частично
теряемое (очереди/кэши в памяти — `scanJobs`, `backfillJobs`, `eventHistoryJobs`).

## Точка входа/безопасность периметра

`app.listen(PORT, '127.0.0.1', ...)` — процесс слушает только loopback, наружу отдаёт nginx
по TLS. CONFIRMED (`server.js:2771`, `nginx-askue.conf`).
