# 14 — ASKUE GAP ANALYSIS

Два независимых среза: (A) `01_PROJECT.md` «Existing/Planned/Explicitly not planned» против
кода, (B) 12 доменов `03_TARGET_ARCHITECTURE.md` против кода. Оба нужны — (A) это продуктовый
взгляд «пользователя», (B) это архитектурный взгляд «что нужно построить».

## A. Сверка с `01_PROJECT.md`

### Existing capabilities — подтверждение

| Заявлено | Статус | Evidence |
|---|---|---|
| modem/GSM/LTE monitoring | CONFIRMED | GPIO/CSQ/temp/LBS через демон-канал |
| meter readings и мгновенные величины | CONFIRMED | `cmdInstant`/`parseInstant`, live-verified |
| hourly consumption | CONFIRMED | `readings.kwh`/`kwh_self`, профиль + self-energy гибрид |
| 10-minute snapshots | CONFIRMED | «Регистратор», те же `readings` с доп. колонками |
| tariffs и historical tariff changes | CONFIRMED | `site_tariffs`, посегментный расчёт при смене ставки |
| rental/technical/commercial accounting | CONFIRMED | раздел «Объекты», `meters.category`/`tenant_name`/`rental_name`/`signatory_name` |
| XLSX/CSV | PARTIALLY CONFIRMED | XLSX через `exceljs` подтверждён (`/api/objects/export`); отдельного CSV-экспорта не найдено — NOT FOUND именно CSV, хотя `fast-csv` присутствует в дереве зависимостей exceljs (транзитивная, не обязательно используется приложением напрямую) |
| scheduled reports | CONFIRMED | `tickReports`, `report_log` для идемпотентности |
| incidents and notifications | CONFIRMED | `alerts` + email через `mailer.js`, детектор `tickAlerts` |
| roles Master/User | PARTIALLY CONFIRMED — реально 4 уровня (platform-admin / project-master / project-limited + отдельно impersonation), не просто пара Master/User, как сформулировано в документе |
| GPIO | CONFIRMED | см. [08_GPIO.md](08_GPIO.md) |
| multiple meters on RS-485 | CONFIRMED | приоритетная очередь `serializeFor`, скан шины 0-239 |
| multitenancy | CONFIRMED | `project_id`-scoped middleware, изоляция проверена по коду |
| responsive UI | NOT RE-VERIFIED в этом аудите (заявлено в проекте как уже проверяемое отдельными субагентами — см. [04_FRONTEND.md](04_FRONTEND.md)) |

### Planned — что реально отсутствует

| Заявлено как Planned | Статус в коде |
|---|---|
| power quality/GOST monitoring | NOT FOUND. Есть задел в схеме: комментарий у таблицы `limits` явно говорит «дальше сюда же лягут границы ГОСТ по напряжению и частоте» — то есть архитектурное место выбрано, реализации нет |
| period comparisons (сравнение периодов) | NOT FOUND — ни в UI-секциях (grep секционных маркеров), ни в API-маршрутах |
| Telegram/SMS/Push/PWA/mobile | NOT FOUND — единственный канал уведомлений — email (`mailer.js`); нет service worker/manifest.json (PWA), нет интеграции с Telegram Bot API/SMS-шлюзом для уведомлений (SMS в старом приложении относится к другому продукту — управлению модемом через SMS-команды, не уведомлениям) |

### Explicitly not planned — сверка (должно отсутствовать, и отсутствует)

1C/ERP/billing интеграция — NOT FOUND, корректно. Object maps/plans (карты объектов) —
NOT FOUND, корректно. Manual readings (ручной ввод показаний) — NOT FOUND, корректно (все
показания — только с приборов через протокол). Все три пункта подтверждают, что фактический
scope продукта соответствует заявленным границам, а не расползся за них незаметно.

## B. Сверка с 12 доменами `03_TARGET_ARCHITECTURE.md`

| # | Домен | Покрытие сейчас | Комментарий |
|---|---|---|---|
| 1 | Identity & Access | ~40% | сессии/bcrypt есть; RBAC — 2-уровневый enum, не permission-based, нет PARTNER-ролей |
| 2 | Organizations/Multitenancy | ~70% | `projects`/tenant isolation работают; нет отдельного понятия Organization над Project (сегодня 1 юрлицо клиента = 1 project, без явной иерархии organization→projects) |
| 3 | Device Core | ~75% | Modem→RS485→Meter реализовано и живьём проверено; нет явных сущностей retry/backoff/idempotency/communication-gaps как отдельного домена (логика размазана по `modemState.js`/таймаутам) |
| 4 | Metering Core | ~70% | RAW→VALIDATION→NORMALIZATION есть по факту в коде, но не как явно разделённые таблицы/слои (см. [02_ARCHITECTURE.md](02_ARCHITECTURE.md)) |
| 5 | Commercial Accounting | ~35% | расчёт корректен по формулам, но не персистентен, не версионирован, на float — три прямых расхождения с явными требованиями таргета |
| 6 | Tariffs | ~60% | история тарифов есть (`site_tariffs.valid_from`), нет `valid_to`, нет отдельной сущности `TariffVersion` с полным жизненным циклом |
| 7 | Reporting | ~60% | XLSX + scheduled email есть; сравнение периодов и другие «умные» отчёты — нет |
| 8 | Incidents & Notifications | ~50% | инциденты + email есть; только email-канал (нет SMS/Telegram/push из Planned) |
| 9 | Partner Network | **0%** | NOT FOUND — ни одной таблицы/маршрута/роли |
| 10 | Revenue & Subscriptions | **0%** | NOT FOUND — нет `subscriptions`/`revenue_events`, нет привязки к тарифному плану самого SaaS (1500₽/модем, 90₽/счётчик из `02_BUSINESS_MODEL.md` нигде не отражены в коде — это пока чисто бизнес-документ, не биллинговая логика) |
| 11 | AI Revenue Network | **0%** | NOT FOUND — ожидаемо, это Phase 6 роадмапа, самая дальняя веха |
| 12 | Audit | ~15% | частичные логи (`report_log`, `alerts.ack_at`) есть; единой `audit_logs` таблицы/домена нет |

## Вывод

Домены 3-4 (Device/Metering Core) — наиболее зрелая часть, ближе всего к тому, что уже
описывает Phase 1-2 роадмапа: там в основном требуется формализация границ уже работающего
кода, не разработка с нуля. Домены 9-11 (Partner/Revenue/AI) — buildout с нуля, ожидаемо
(это Phase 5-6-7). Домен 5 (Commercial Accounting) — единственный из «уже частично
реализованных», где расхождение с таргетом не про отсутствие функциональности, а про
фундаментальные архитектурные принципы (персистентность, детерминированная арифметика) —
стоит явно приоритизировать этот домен на Stage 2.5A, поскольку каждая новая фича поверх
текущей коммерческой логики (например, партнёрские комиссии от той же выручки) унаследует
те же архитектурные пробелы, если их не закрыть до расширения.
