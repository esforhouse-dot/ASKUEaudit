# 00 — FINAL ARCHITECTURE (проект решения — требует утверждения владельцем)

> **Статус: PROPOSED.** Согласно `stages/STAGE_2_5A_ARCHITECTURE_RECONCILIATION.md`, финальную
> архитектуру утверждает владелец после Stage 2.5A — этот документ формирует предложение для
> утверждения, а не готовое решение. Ничего из описанного здесь не реализовано и не должно
> реализовываться до явного «да» владельца по каждому пункту, помеченному PROPOSED в
> [05_ARCHITECTURE_DECISIONS.md](05_ARCHITECTURE_DECISIONS.md).

Источники: `AUDIT/*` (факты о текущем коде, целиком, без повторного аудита кода в рамках этой
стадии — по прямому указанию), `00-04_*.md` (Stage 1 — целевая архитектура/бизнес-модель),
`stages/STAGE_2_5A_*.md` (правила этой стадии).

## 1. Current vs target architecture — итог

Форма системы, зафиксированная в `03_TARGET_ARCHITECTURE.md` (**Modular Monolith + Workers**,
без микросервисов/Kafka/Redis без доказанной необходимости), уже физически совместима с тем,
что реально работает (`AUDIT/02_ARCHITECTURE.md`, `AUDIT/16_RECOMMENDED_TARGET_ARCHITECTURE.md`):
один Node-процесс (`irz-web-gpio`) + один внешний воркер (Java-демон GpioDaemon). **Смены
платформы не требуется.** Требуется только внутреннее разделение на границы доменов внутри уже
существующего процесса — сегодня деление есть лишь частично (протокольный слой Меркурий уже
вынесен в 4 отдельных файла; весь HTTP/бизнес-слой — один файл `server.js` на 2778 строк,
`AUDIT/03_BACKEND.md`, `AUDIT/12_TECH_DEBT.md`).

**Вывод:** архитектурная форма НЕ меняется. Меняется внутренняя организация кода одного и того
же процесса — постепенно, доменами, методом strangler (см.
[03_IMPLEMENTATION_SEQUENCE.md](03_IMPLEMENTATION_SEQUENCE.md)), не единовременным переписыванием
(прямой запрет Stage 2.5A на big-bang rewrite).

## 2. Домены — целевая раскладка (12 из `03_TARGET_ARCHITECTURE.md`)

| # | Домен | Текущее покрытие (`AUDIT/14`) | Физическое сегодня |
|---|---|---|---|
| 1 | Identity & Access | ~40% | `auth.js` |
| 2 | Organizations / Multitenancy | ~70% | `server.js` middleware + `projects`/`sites` в `db.js` |
| 3 | Device Core | ~75% | `modemState.js` + GPIO-маршруты `server.js` |
| 4 | Metering Core | ~70% | `mercury*.js` (4 файла) + профильная часть `server.js` |
| 5 | Commercial Accounting | ~35% | функции расчёта в `server.js` |
| 6 | Tariffs | ~60% | `site_tariffs` (+ устаревшая `modem_tariffs`) |
| 7 | Reporting | ~60% | XLSX-экспорт + `tickReports` в `server.js` |
| 8 | Incidents & Notifications | ~50% | `alerts` + `mailer.js` + `tickAlerts` |
| 9 | Partner Network | 0% | нет |
| 10 | Revenue & Subscriptions | 0% | нет |
| 11 | AI Revenue Network | 0% | нет |
| 12 | Audit | ~15% | частично `report_log`/`alerts.ack_at` |

Подробное покомпонентное решение по каждому домену — [01_COMPONENT_DECISIONS.md](01_COMPONENT_DECISIONS.md).

## 3. Целевая физическая раскладка внутри процесса (PROPOSED)

Предлагаемая структура каталогов — ориентир для постепенного `EXTRACT` из `server.js`, не план
одномоментного переезда:

```
fetched/
├── server.js              ← остаётся точкой входа (app.listen, wiring), но перестаёт
│                             содержать бизнес-логику доменов по мере extraction
├── domains/
│   ├── identity/           ← auth.js переезжает сюда + permission-слой (NEW)
│   ├── organizations/      ← projects/sites/multitenancy middleware
│   ├── device/              ← modemState.js, GPIO-маршруты, демон-интеграция
│   ├── metering/            ← mercury*.js (переезжают как есть, без изменения логики)
│   ├── commercial/          ← computeReadingPeriod/computeSiteTariffCost/scaleByCtRatio + NEW calculations/statements
│   ├── tariffs/              ← site_tariffs CRUD
│   ├── reporting/            ← XLSX-экспорт, tickReports
│   ├── incidents/            ← alerts, tickAlerts, mailer.js
│   ├── partners/              ← NEW, Phase 5
│   ├── revenue/                ← NEW, Phase 5/6 (нужен раньше partners — см. 03)
│   ├── ai/                      ← NEW, Phase 6-7
│   └── audit/                    ← NEW, вводится рано (Phase 0/1) — многие домены на него ссылаются
├── db.js                   ← схема остаётся единой (SQLite), но миграции по доменам — см. 02
├── mailer.js
└── public/*.html
```

Каждая папка — кандидат на постепенный перенос существующего кода `AUDIT/13_REUSABLE_COMPONENTS.md`
(EXTRACT), не переписывание. `mercury*.js` переезжают в `domains/metering/` буквально без
изменения ни строчки протокольной логики (KEEP AS IS по классификации аудита) — только смена
расположения файла.

## 4. Что остаётся неизменным (явное подтверждение против forbidden-списка Stage 2.5A)

- **СУБД** — SQLite/`better-sqlite3` остаётся системой хранения на обозримый срок. Замена БД
  не рассматривается как предпосылка ни для одного домена.
- **Форма процесса** — один Node-процесс + один Java-воркер. Микросервисы не вводятся.
- **Kafka/Redis** — не вводятся; текущие `setInterval`-задачи и промис-очереди (`modemState.js`)
  признаны достаточными для текущего масштаба (`AUDIT/02_ARCHITECTURE.md`).
- **Протокол Меркурий/iRZ** — не меняется. `mercury*.js` — KEEP AS IS.
- **Существующая продовая функциональность** — ничего не удаляется. Extraction обязан
  сохранять поведение (проверяется живым прогоном + будущими тестами, см.
  [03_IMPLEMENTATION_SEQUENCE.md](03_IMPLEMENTATION_SEQUENCE.md)).
- **Семантика денежного расчёта** — формулы (`computeReadingPeriod`/`computeSiteTariffCost`/
  `scaleByCtRatio`) не меняются без отдельного явного утверждения владельца — см. риск
  «изменение семантики финансового расчёта» в [05_ARCHITECTURE_DECISIONS.md](05_ARCHITECTURE_DECISIONS.md)
  (ADR-06) и [04_RISK_REGISTER.md](04_RISK_REGISTER.md).

## 5. Открытые вопросы владельцу (не решаются этим документом)

1. **1 проект = 1 активный модем** (сегодняшнее ограничение middleware, `AUDIT/02_ARCHITECTURE.md`,
   `AUDIT/09_AUTH_AND_SECURITY.md`) — сознательное продуктовое решение или временный техдолг?
   От ответа зависит, нужно ли расширять Device Core до `N` модемов на объект уже в Phase 1.
2. **Organization над Project** — нужна ли отдельная сущность «организация» поверх текущего
   `project` (например, если у одного юрлица-клиента несколько объектов/проектов), или текущая
   модель «1 project = 1 клиент» устраивает и на масштабе Partner Network?
3. **`modem_tariffs`** (устаревшая таблица) — списываем без переноса исторических данных, или
   нужен разовый ручной перенос для конкретных существующих клиентов?
4. **Судьба корневого `irz-modem-control`** (легаси-прототип, `AUDIT/13_REUSABLE_COMPONENTS.md`,
   раздел UNKNOWN) — используется ли ещё живыми клиентами? Это вне периметра АСКУЭ SaaS
   реконсиляции, но занимает те же VPS-ресурсы.

Ответы на эти вопросы не блокируют начало Phase 0 (см. [03](03_IMPLEMENTATION_SEQUENCE.md)), но
блокируют часть решений Phase 1/4.
