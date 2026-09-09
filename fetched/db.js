// Собственная БД приложения (SQLite) — отдельно от irzserver4 (та принадлежит вендорской
// службе Collector, там свои таблицы заводить нельзя) и от MariaDB с чужими проектами
// (Space-cakes, neoncad_social) на этом же сервере.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS modems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  imei TEXT UNIQUE NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  modem_id INTEGER NOT NULL REFERENCES modems(id),
  addr INTEGER NOT NULL,
  password TEXT,
  label TEXT,
  meter_constant INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('admin','user')),
  actor_id INTEGER NOT NULL,
  project_id INTEGER,
  impersonating_project_id INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS readings (
  meter_id INTEGER NOT NULL REFERENCES meters(id),
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  kwh REAL,
  incomplete INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (meter_id, date, slot)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_readings_meter_month ON readings(meter_id, substr(date,1,7));
CREATE TABLE IF NOT EXISTS modem_readings (
  modem_id INTEGER NOT NULL REFERENCES modems(id),
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  csq REAL,
  temp REAL,
  PRIMARY KEY (modem_id, date, slot)
) WITHOUT ROWID;
`);

// Лёгкая миграция: опциональное поле "номер SIM" у модема (добавлено в Фазе 5, для справки —
// на логику привязки не влияет). CREATE TABLE IF NOT EXISTS не добавляет колонки в уже
// существующую таблицу, поэтому проверяем и добавляем вручную.
const modemCols = db.prepare("PRAGMA table_info(modems)").all().map(c => c.name);
if (!modemCols.includes('phone')) {
  db.exec('ALTER TABLE modems ADD COLUMN phone TEXT');
}
// Метка "история из памяти счётчика уже догружена один раз" (Фаза с почасовками/БД).
const meterCols = db.prepare("PRAGMA table_info(meters)").all().map(c => c.name);
if (!meterCols.includes('backfilled_at')) {
  db.exec('ALTER TABLE meters ADD COLUMN backfilled_at INTEGER');
}
// Паспортные данные счётчика (серийный номер, дата выпуска) — читаются один раз, не меняются.
if (!meterCols.includes('serial_number')) {
  db.exec('ALTER TABLE meters ADD COLUMN serial_number TEXT');
}
if (!meterCols.includes('manufacture_date')) {
  db.exec('ALTER TABLE meters ADD COLUMN manufacture_date TEXT');
}
// Битовая маска подтверждённых пользователем тревог (см. server.js EVENT_BIT_NAMES) — своя,
// на стороне приложения: запись сброса флагов НЕ подтвердилась на реальном счётчике (нет ответа
// от прибора на 03h/2Fh/02h), поэтому квитирование не трогает сам счётчик.
if (!meterCols.includes('ack_event_bits')) {
  db.exec('ALTER TABLE meters ADD COLUMN ack_event_bits INTEGER NOT NULL DEFAULT 0');
}
// Модель счётчика (230/234/236 и т.п.) — протокол не позволяет определить её автоматически
// (параметр 12h "вариант исполнения" отдаёт только константу счётчика и флаги фаз/профиля, не
// номер модели), поэтому вводится вручную при добавлении/в настройках. NULL — не указана.
if (!meterCols.includes('model')) {
  db.exec('ALTER TABLE meters ADD COLUMN model TEXT');
}
// Автоопределение модели по коду варианта исполнения пробовали (26 авг) и убрали по просьбе
// пользователя — не нужно, только ручной ввод. Если колонка ещё осталась от той попытки, снести.
if (meterCols.includes('model_hint')) {
  db.exec('ALTER TABLE meters DROP COLUMN model_hint');
}
// Расположение счётчика (текстом, например "ГРЩ-2, этаж 1, ячейка 3") — вводится вручную,
// показывается и редактируется прямо под выбором счётчика в index.html.
if (!meterCols.includes('location')) {
  db.exec('ALTER TABLE meters ADD COLUMN location TEXT');
}
// Самозапись почасовки (27 авг) — база для расчёта дельты энергии между опросами 05h, см.
// server.js applySelfEnergy(). Персистентно (не в памяти процесса), иначе рестарт демона обнулял
// бы точку отсчёта и следующий цикл посчитал бы дельту от старта эпохи — гарантированный мусор.
if (!meterCols.includes('last_energy_kwh')) {
  db.exec('ALTER TABLE meters ADD COLUMN last_energy_kwh REAL');
}
if (!meterCols.includes('last_energy_at')) {
  db.exec('ALTER TABLE meters ADD COLUMN last_energy_at INTEGER');
}
// Коэффициент трансформации (30 авг) — на сайтах с трансформаторами тока (Capitalservis и т.п.)
// протокол отдаёт вторичную сторону ТТ (маленькие ток/мощность), реальные значения — вторичная
// сторона × этот коэффициент. NULL = коэффициент не задан, множитель 1 (счётчик подключён напрямую).
if (!meterCols.includes('ct_ratio')) {
  db.exec('ALTER TABLE meters ADD COLUMN ct_ratio REAL');
}
// Срок поверки ПУ (05.09.2026) — дата, до которой действительна поверка счётчика. Вводится
// вручную в «Приборах учёта» (протокол её не отдаёт: в паспортных данных есть только дата
// выпуска, см. manufacture_date выше, а межповерочный интервал зависит от типа счётчика и
// решения поверителя). Хранится строкой 'YYYY-MM-DD', а не unix-временем: это календарная
// дата без времени и часового пояса, к тому же в таком виде она сравнивается и сортируется
// лексикографически прямо в SQL. NULL = не указан. Дальше по плану — вывод колонки в разделе
// «Объекты» и уведомления о приближении срока.
if (!meterCols.includes('verification_due')) {
  db.exec('ALTER TABLE meters ADD COLUMN verification_due TEXT');
}
// Вывод прибора из эксплуатации (6 сент) — снятый, демонтированный или заброшенный счётчик.
// Метка ВРЕМЕНИ, а не флаг: «когда вывели» нужно и в разборе задним числом, и в отчёте, а стоит
// это ровно столько же. NULL = в работе. Такой прибор перестаёт опрашиваться (см. server.js
// allMetersWithModem) и не поднимает инцидентов, но его история и место в отчётах за прошлые
// периоды сохраняются целиком — данные остаются, наблюдение прекращается.
if (!meterCols.includes('decommissioned_at')) {
  db.exec('ALTER TABLE meters ADD COLUMN decommissioned_at INTEGER');
}
// Раздел «Объекты» (31 авг) — сводная таблица по всем счётчикам для персонала, который сверяет
// показания с арендаторами/техническими и коммерческими учётами (см. ROADMAP.md). category относит
// счётчик к одной из 3 вкладок раздела (NULL = ещё не распределён — счётчик нигде не показывается,
// см. "Категория" в «Приборах учёта»); проверка допустимых значений — в server.js, не CHECK-ом
// (ALTER TABLE ADD COLUMN с CHECK — лишний риск на разных версиях sqlite, остальные ALTER в этом
// файле тоже без CHECK). Остальные 3 поля заполняются вручную прямо в таблице «Объекты».
if (!meterCols.includes('category')) {
  db.exec('ALTER TABLE meters ADD COLUMN category TEXT');
}
if (!meterCols.includes('tenant_name')) {
  db.exec('ALTER TABLE meters ADD COLUMN tenant_name TEXT');
}
if (!meterCols.includes('rental_name')) {
  db.exec('ALTER TABLE meters ADD COLUMN rental_name TEXT');
}
if (!meterCols.includes('signatory_name')) {
  db.exec('ALTER TABLE meters ADD COLUMN signatory_name TEXT');
}
// Раздел «Автоматизированные отчёты» (07.09.2026) — число месяца, в которое по этому прибору
// уходит отчёт на почту (1..31; проверка диапазона в server.js, не CHECK-ом — как и у category
// выше). NULL = отчёт по прибору не формируется, это же и способ исключить прибор из рассылки,
// не трогая его категорию. День принадлежит ПРИБОРУ, а не объекту: у каждого арендатора свой
// расчётный день по договору, и в одном здании их одновременно несколько (см. ROADMAP.md).
if (!meterCols.includes('report_day')) {
  db.exec('ALTER TABLE meters ADD COLUMN report_day INTEGER');
}

// «Регистратор» (27 авг) — мгновенные величины тоже с историей, не только энергия. Счётчик сам
// такую историю не ведёт (только профиль мощности/энергии, см. память проекта), поэтому пишем
// сами: раз в 10 минут поверх той же сетки readings(meter_id,date,slot) — kwh по-прежнему
// приходит от счётчика на его родных получасовых слотах (:00/:30), эти новые колонки — на более
// частых 10-минутных (:00/:10/:20/:30/:40/:50), поэтому у части строк kwh будет NULL — это
// нормально, не баг. ВАЖНО: раз в таблице теперь пишут ДВА независимых источника (профиль
// энергии и мгновенный опрос), везде далее — только точечный UPSERT нужных колонок
// (ON CONFLICT DO UPDATE SET <эти_колонки>), никогда INSERT OR REPLACE (тот стирает всю строку,
// включая колонки от другого источника).
const readingsCols = db.prepare("PRAGMA table_info(readings)").all().map(c => c.name);
const INSTANT_COLS = ['u_a', 'u_b', 'u_c', 'i_a', 'i_b', 'i_c', 'p', 'q', 's', 'pf', 'freq', 'temp'];
for (const col of INSTANT_COLS) {
  if (!readingsCols.includes(col)) db.exec(`ALTER TABLE readings ADD COLUMN ${col} REAL`);
}
// Самозапись почасовки (27 авг) — считаем сами из дельты 05h вместо чтения профиля 06h/16h из
// памяти счётчика (та не работает на части приборов, напр. Меркурий 230 — см. память проекта).
// ОТДЕЛЬНАЯ колонка от kwh, не переиспользуем её: kwh пишет профиль (родные получасовые срезы
// счётчика), kwh_self — самостоятельный расчётный час; если писать в одну kwh, при совпадении
// часа оба источника независимо перезаписывали бы/задваивали значение друг друга. Источник для
// отображения выбирается на чтении (см. /api/mercury/profile: kwh, если есть, иначе kwh_self).
if (!readingsCols.includes('kwh_self')) db.exec('ALTER TABLE readings ADD COLUMN kwh_self REAL');
if (!readingsCols.includes('incomplete_self')) db.exec('ALTER TABLE readings ADD COLUMN incomplete_self INTEGER');

// Тариф на электроэнергию (30 авг) — один на МОДЕМ (не на счётчик и не на проект): все ПУ на одной
// шине физически в одном регионе, а перепродавать электроэнергию дороже цены поставщика нельзя
// (аренда/субаренда) — ставка одна для всех этажей. История с датой действия, а не одно текущее
// значение — тариф меняется (обычно 1 июля), и без истории месяц смены ставки считался бы неверно
// задним числом. Только добавление записей (append-only), см. server.js /api/modem/tariff.
db.exec(`
CREATE TABLE IF NOT EXISTS modem_tariffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  modem_id INTEGER NOT NULL REFERENCES modems(id),
  rate REAL NOT NULL,
  valid_from TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_modem_tariffs_modem ON modem_tariffs(modem_id, valid_from);
`);

// Фото для лэндинга (30 авг) — вставляются админом через Ctrl+V прямо в блоки на странице
// (см. fetched/landing.html, server.js /api/landing/*). Один файл на именованный слот (обложка,
// модем, счётчики...) — старый файл удаляется при замене, история версий не нужна.
db.exec(`
CREATE TABLE IF NOT EXISTS landing_images (
  slot TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL
);
`);

// Редактируемые надписи лэндинга (30 авг) — тот же принцип, что и landing_images: правит только
// админ, кликая прямо по тексту на странице (см. fetched/landing.html, server.js /api/landing/text).
// content — уже очищенный от HTML сервером текст (см. sanitizeInlineHtml), кроме <b> ничего не хранится.
db.exec(`
CREATE TABLE IF NOT EXISTS landing_texts (
  key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

// Роли и ограничение доступа для пользователей проекта (31 авг) — раньше был ровно один
// пользователь на проект без разделения прав, теперь админ может добавить в проект несколько
// аккаунтов: 'master' видит весь функционал (как раньше), 'limited' — только раздел «Объекты»
// (гейтится и на клиенте, и на сервере, см. server.js). Названия значений намеренно НЕ 'user' —
// в sessions.role уже есть значение 'user' с другим смыслом (админ vs пользователь проекта),
// использование того же слова здесь запутало бы. access_until — миллисекунды эпохи, NULL = без
// срока; после этой отметки requireAuth рвёт сессию, но сам проект (опрос модема, данные) живёт
// как обычно — ограничение касается только входа конкретного аккаунта.
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('access_role')) {
  db.exec("ALTER TABLE users ADD COLUMN access_role TEXT NOT NULL DEFAULT 'master'");
}
if (!userCols.includes('access_until')) {
  db.exec('ALTER TABLE users ADD COLUMN access_until INTEGER');
}

// Видимость столбцов раздела «Объекты» (31 авг) — Мастер сам видит ВСЕГДА все столбцы, эта
// настройка только фильтрует, что видит роль 'limited' (см. access_role выше). Одна запись на
// проект (не на счётчик/подвкладку — структура таблицы одна и та же на всех 3 подвкладках, см.
// память irz-objects-section), hidden_columns — JSON-массив ключей столбцов (см. OBJ_COLUMNS в
// index.html), пустой массив по умолчанию = ничего не скрыто, «Пользователь» видит то же, что и
// «Мастер», пока тот явно что-то не спрячет.
db.exec(`
CREATE TABLE IF NOT EXISTS objects_column_prefs (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id),
  hidden_columns TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
`);

// «Объекты» (площадки/здания) — новая сущность (31 авг), НЕ путать с уже существующим разделом
// «Объекты» в index.html (та таблица показывает счётчики по категориям аренда/технические/
// коммерческие) — теперь внутри проекта может быть несколько физических объектов (напр. «Корпус
// А», «Корпус Б»), и раздел «Объекты» сначала спрашивает, какой из них смотреть, а категории —
// это подразделение УЖЕ ВНУТРИ выбранного объекта. Названа в коде `sites`, а не `objects` —
// иначе конфликтовало бы по имени с уже повсеместным префиксом obj*/Obj* для того самого раздела
// в server.js/index.html (см. objRows, objActiveTab и т.д.) и путало бы читающего код. Создаёт и
// удаляет только платформенный админ (см. server.js /api/admin/projects/:id/sites) — это
// осознанно НЕ отдано на откуп Мастеру, тот только привязывает к объекту уже существующий счётчик.
db.exec(`
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);
// site_id — какому объекту (см. sites выше) принадлежит счётчик; NULL = ещё не привязан (тогда
// счётчик нигде не показывается в разделе «Объекты», аналогично NULL у category). Удаление
// объекта админом обнуляет site_id у его счётчиков, а не удаляет сами счётчики (см. DELETE
// /api/admin/sites/:id) — счётчик физически продолжает опрашиваться независимо от привязки.
if (!meterCols.includes('site_id')) {
  db.exec('ALTER TABLE meters ADD COLUMN site_id INTEGER REFERENCES sites(id)');
}

// Тариф на электроэнергию (31 авг) — переехал с модема на объект (см. sites выше): раздел
// «Оплаты»/«Тарифы» теперь выбирает объект, а не прибор учёта, «это логичнее» (просьба
// пользователя) — тариф общий для всех счётчиков, привязанных к этому объекту. СТАРАЯ таблица
// modem_tariffs ниже НЕ удаляется и не мигрируется автоматически — у неё уже может быть реальная
// история ставок для существующих клиентов, а перенос её на конкретный объект неоднозначен (у
// модема на момент введения тарифа объектов ещё не существовало, и модем теоретически может
// делиться между несколькими объектами). Она просто перестаёт быть источником для UI/расчётов;
// если понадобится перенести старые ставки в site_tariffs для конкретного клиента — это разовая
// операция человеком (сверить даты/суммы), не автоматическая миграция.
db.exec(`
CREATE TABLE IF NOT EXISTS site_tariffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  rate REAL NOT NULL,
  valid_from TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_site_tariffs_site ON site_tariffs(site_id, valid_from);
`);

// ── Журнал инцидентов раздела «Уведомления и отклонения» (5 сент) ────────────────────────────
// Инцидент, а не событие в момент времени: у записи есть opened_at и closed_at, поэтому «сбор
// профиля встал» — это ОДНА строка со статусом «длится 3 дня», а не 300 одинаковых сообщений.
// last_seen_at — когда условие подтверждалось в последний раз (обновляется каждым тиком детектора,
// пока инцидент открыт), value/threshold — измеренное и порог, чтобы в ленте было видно «34% при
// пороге 80%», а не только текст.
//
// subject ('meter:5' / 'modem:3') дублирует meter_id/modem_id намеренно: частичный UNIQUE-индекс
// ниже гарантирует НЕ БОЛЕЕ ОДНОГО открытого инцидента на (вид, объект), а по meter_id этого не
// сделать — там NULL для инцидентов модема, а SQLite считает NULL'ы различными и пропустил бы
// сколько угодно дублей.
db.exec(`
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  subject TEXT NOT NULL,
  meter_id INTEGER REFERENCES meters(id),
  modem_id INTEGER REFERENCES modems(id),
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  closed_at INTEGER,
  value REAL,
  threshold REAL,
  detail TEXT NOT NULL,
  ack_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_project ON alerts(project_id, opened_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_one_open ON alerts(kind, subject) WHERE closed_at IS NULL;
`);

// ── Правила и лимиты раздела «Уведомления и отклонения» (5 сент) ─────────────────────────────
// Одна таблица на все виды правил: kind говорит, что именно ограничиваем, value — само число.
// Сейчас заведены только лимиты потребления ('energy-day' / 'energy-week' / 'energy-month',
// значения в ПЕРВИЧНЫХ кВт·ч), дальше сюда же лягут границы ГОСТ по напряжению и частоте.
//
// scope/scope_id, а не просто meter_id: лимит потребления — величина из договора конкретного
// арендатора, поэтому живёт на ПРИБОРЕ, а границы качества питания общие на весь ввод и будут
// жить на ОБЪЕКТЕ (sites). Тариф тут не пример для подражания — он один на здание по закону
// (см. site_tariffs), а лимит наоборот индивидуальный, наследовать его сверху нечего.
db.exec(`
CREATE TABLE IF NOT EXISTS limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  scope_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  value REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_limits_one ON limits(scope, scope_id, kind);
`);

// Email для уведомлений раздела «Уведомления и отклонения» (07 сент) — на ПРОЕКТ, не на объект
// (sites) и не на пользователя: инциденты (data-gap/meter-silent/modem-offline) и лимиты считаются
// по счётчикам/модемам всего проекта разом (см. tickAlerts), у объекта своего отдельного набора
// тревог нет — дробить адрес по объектам было бы фиктивной точностью. Строка, не JSON-массив:
// проще всего для одного адреса, но допускает и несколько через запятую (парсится на сервере
// при отправке) — без этого поле пришлось бы городить отдельной таблицей ради одной способности,
// которой, возможно, никто не воспользуется. NULL = уведомления не настроены.
const projectCols = db.prepare("PRAGMA table_info(projects)").all().map(c => c.name);
if (!projectCols.includes('notify_email')) {
  db.exec('ALTER TABLE projects ADD COLUMN notify_email TEXT');
}
// Email для «Автоматизированных отчётов» (07.09.2026) — ОТДЕЛЬНОЕ поле, а не переиспользование
// notify_email: инциденты («счётчик молчит», «превышен лимит») адресованы технической службе, а
// отчёт о потреблении — бухгалтерии или собственнику; смешивать их в одном адресе значит либо
// заваливать бухгалтерию тревогами, либо слать отчёты туда, где их не ждут. Формат тот же —
// строка с адресами через запятую, NULL = отчёты не отправляются (см. tickReports в server.js).
if (!projectCols.includes('report_email')) {
  db.exec('ALTER TABLE projects ADD COLUMN report_email TEXT');
}

// ── Журнал отправленных автоматических отчётов (07.09.2026) ──────────────────────────────────
// Существует ради ОДНОГО свойства: отчёт за период должен уйти ровно один раз. Планировщик
// (tickReports) просыпается каждые 15 минут и в отчётный день видит одну и ту же группу приборов
// снова и снова; без журнала рестарт процесса или простой сервера превратились бы в веер
// одинаковых писем. Ключ идемпотентности — (объект, отчётный день, конец периода): именно эта
// тройка описывает «тот самый отчёт», а дата отправки для неё вторична (при простое сервера
// письмо уйдёт позже того же дня, и это по-прежнему тот же отчёт).
//
// status: 'sent' — доставлено SMTP, больше не повторяем; 'error' — попытка была, но не удалась,
// следующий тик того же дня попробует снова и перепишет строку через ON CONFLICT DO UPDATE
// (ошибка сохраняется в error, чтобы её было видно в разделе, а не только в pm2 logs).
// РУЧНАЯ отправка кнопкой «Отправить сейчас» сюда НЕ пишется: иначе она заняла бы ключ и
// отменила плановую рассылку того же дня.
db.exec(`
CREATE TABLE IF NOT EXISTS report_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  report_day INTEGER NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  meters_count INTEGER NOT NULL,
  recipients TEXT,
  status TEXT NOT NULL,
  error TEXT,
  sent_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_log_once ON report_log(site_id, report_day, period_end);
CREATE INDEX IF NOT EXISTS idx_report_log_project ON report_log(project_id, sent_at);
`);

module.exports = db;
