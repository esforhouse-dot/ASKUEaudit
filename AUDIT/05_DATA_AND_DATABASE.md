# 05 — DATA AND DATABASE

## Движок

SQLite через `better-sqlite3` (синхронный API), один файл `/opt/irz-web/data/app.db`
(3.2 МБ на момент аудита, плюс WAL-файлы). `journal_mode = WAL`. CONFIRMED (`db.js:6-12`,
живой `ls -la` на VPS).

Отдельно существует **вендорская** MySQL-база `irzserver4` (принадлежит службе iRZ Collector,
таблицы `devices`/`commands`/`deviceHistory`/`sessions`) — приложение читает/пишет её через
`mysql2/promise` пул, но не считает своей: `db.js` явно комментирует, что заводить свои
таблицы там нельзя. CONFIRMED.

## Полная схема приложения (`app.db`)

| Таблица | Ключевые поля | Комментарий |
|---|---|---|
| `admins` | id, username UNIQUE, password_hash, created_at | платформенные админы |
| `projects` | id, name, created_at, notify_email, report_email | тенант верхнего уровня |
| `users` | id, username UNIQUE, password_hash, project_id FK, access_role ('master'\|'limited'), access_until | пользователь проекта |
| `modems` | id, project_id FK, imei UNIQUE, label, phone, created_at | 1 модем = 1 запись; проект может иметь несколько модемов в схеме, но UI/middleware сейчас работает с одним активным (см. 02_ARCHITECTURE.md) |
| `meters` | id, modem_id FK, addr, password, label, meter_constant, backfilled_at, serial_number, manufacture_date, ack_event_bits, model, location, last_energy_kwh, last_energy_at, ct_ratio, verification_due, decommissioned_at, category, tenant_name, rental_name, signatory_name, site_id FK, report_day | самая «широкая» таблица — 20 полей, вся история докручена ALTER'ами по датам |
| `sessions` | token PK, role CHECK(admin\|user), actor_id, project_id, impersonating_project_id, expires_at | 30-дневный TTL |
| `readings` | (meter_id, date, slot) PK, WITHOUT ROWID, kwh, incomplete, kwh_self, incomplete_self, + 12 полей мгновенных величин (u_a..pf, freq, temp) | одна таблица на получасовки/10-минутки/мгновенные — грид на `date+slot` |
| `modem_readings` | (modem_id, date, slot) PK, WITHOUT ROWID, csq, temp | сигнал/температура модема |
| `modem_tariffs` | id, modem_id FK, rate, valid_from | УСТАРЕВШАЯ — заменена `site_tariffs`, не удалена (данные не мигрируются автоматически, см. комментарий в коде) |
| `site_tariffs` | id, site_id FK, rate, valid_from | текущий источник тарифа — на объект, append-only история |
| `sites` | id, project_id FK, name | «объект» (площадка/здание) — не путать с разделом «Объекты» в UI (там — категории счётчиков) |
| `objects_column_prefs` | project_id PK, hidden_columns JSON | видимость столбцов для роли limited |
| `landing_images` | slot PK, filename, uploaded_at | фото лендинга |
| `landing_texts` | key PK, content, updated_at | редактируемые тексты лендинга (санитизированный HTML) |
| `alerts` | id, project_id FK, subject, meter_id FK, modem_id FK, kind, severity, opened_at, last_seen_at, closed_at, value, threshold, detail, ack_at | инцидент как интервал (не единичное событие); частичный уникальный индекс — не более одного открытого инцидента на (kind, subject) |
| `limits` | id, scope, scope_id, kind, value, enabled | лимиты потребления, задел под ГОСТ-границы качества питания |
| `report_log` | id, project_id FK, site_id FK, report_day, period_start, period_end, meters_count, recipients, status, error, sent_at | идемпотентность автоотчётов — уникальный индекс (site_id, report_day, period_end) |

CONFIRMED — полная схема прочитана из `db.js` целиком (419 строк).

## Паттерн миграций

Нет фреймворка миграций (knex/prisma/db-migrate/etc.) — **inline-паттерн**: при каждом старте
процесса `db.exec(CREATE TABLE IF NOT EXISTS ...)` для новых таблиц + ручная проверка
`PRAGMA table_info(x)` → `ALTER TABLE ADD COLUMN` для новых полей в существующих таблицах.
Каждое добавление сопровождается развёрнутым комментарием-обоснованием прямо в коде (что,
зачем, когда, какие альтернативы отвергнуты) — необычно подробно для inline-миграций,
фактически заменяет отдельный migration log. CONFIRMED, читано целиком.

Плюсы: нет отдельного шага "накатить миграцию" при деплое — код сам себя приводит в порядок
при старте, идемпотентно. Минусы относительно таргет-архитектуры/масштабирования:
- Нет отката (down-миграций) — только вперёд.
- Нет версионирования схемы как таковой (нет таблицы `schema_migrations`) — состояние схемы
  выводится по факту наличия колонок, а не по номеру применённой миграции.
- При росте количества доменов (Partner Network, Revenue, AI) такой паттерн в одном файле
  `db.js` станет нечитаемым (уже 419 строк на один процесс миграций, преимущественно
  комментарии — сам код лаконичен, но пропорция скоро развернётся).
- Данные `modem_tariffs` явно не мигрируются в `site_tariffs` — сознательное решение
  (задокументировано в комментарии), не баг, но пример «ручной» модели миграции данных вместо
  автоматической: реальный прецедент того, как в этом проекте по факту решаются такие переходы.

## `WITHOUT ROWID` и денормализация

`readings` и `modem_readings` используют `WITHOUT ROWID` с составным PK — осознанная
оптимизация под точечные upsert по `(id, date, slot)` (в SQLite это избегает дублирования
индекса поверх rowid). `readings` хранит **и** энергию (получасовка/самозапись), **и**
12 мгновенных величин («Регистратор», 10-минутные срезы) в одной широкой таблице —
осознанный компромисс, задокументированный в коде: раз в 10 минут строка обновляется точечным
`UPSERT` нужных колонок (никогда `INSERT OR REPLACE`, чтобы не затирать колонки от другого
источника записи). CONFIRMED. Это прагматичное, но не «доменное» моделирование — таргетная
схема (`raw_readings`, `meter_readings`, `load_profiles`, `instant_measurements` как отдельные
сущности) сознательно разделяет то, что здесь объединено в одной таблице ради простоты upsert.

## Ретеншн и объём

`RETENTION_MONTHS = 24` — `rotateReadings()` раз в сутки удаляет `readings` старше 24 месяцев.
`app.db` = 3.2 МБ на момент аудита (умеренный объём, соответствует малому числу активных
объектов на раннем этапе продукта). Бэкапы — обнаружены ad-hoc файлы
`app.db.bak-tz-migration-<timestamp>` (ручные снапшоты перед конкретной миграцией часовых
поясов) — не регулярный автоматический бэкап. NOT FOUND — не найдено расписания
`cron`/pm2-задачи, которая бы делала регулярные бэкапы `app.db`. См. [15_RISKS.md](15_RISKS.md).

## Исторические/версионируемые сущности — сверка с таргет-принципом

Таргет-архитектура требует `valid_from`/`valid_to` у тарифов и назначений счётчиков.
Фактически:
- `site_tariffs.valid_from` есть, `valid_to` нет — период действия выводится неявно (следующая
  запись по `valid_from` обрывает предыдущую). Работает корректно для текущей логики расчёта
  (подтверждено чтением `computeSiteTariffCost`), но не самодостаточно как модель данных
  (нельзя вставить тариф «задним числом с ограниченным сроком» без побочных эффектов на
  соседние записи). PARTIALLY CONFIRMED.
- Явной сущности `MeterAssignment(valid_from, valid_to)` (привязка счётчика к арендатору/объекту
  с историей) нет — `meters.site_id`/`tenant_name`/`category` являются **текущим** состоянием,
  без истории смены арендатора. Если счётчик переезжает между категориями/арендаторами,
  прежняя история теряет привязку к прежнему контексту (косвенно упоминается в комментариях к
  `site_id` — "объект" при удалении просто обнуляет `site_id`, не хранит, что раньше он
  принадлежал другому). NOT FOUND как отдельная историческая сущность — прямой gap относительно
  `03_TARGET_ARCHITECTURE.md`.
