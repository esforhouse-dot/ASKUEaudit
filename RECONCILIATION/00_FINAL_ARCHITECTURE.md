# 00 — FINAL ARCHITECTURE

> **Статус: ЧАСТИЧНО AUTHORITATIVE (обновлено 2026-09-09).** Владелец рассмотрел Stage 2.5A и
> утвердил конкретные решения — они помечены **AUTHORITATIVE** ниже и в
> [05_ARCHITECTURE_DECISIONS.md](05_ARCHITECTURE_DECISIONS.md), встроены в реализацию как
> обязательные, не подлежат самостоятельному пересмотру Claude Code в Stage 3+. Всё остальное
> содержимое этого документа остаётся **PROPOSED** — ждёт утверждения по мере прохождения фаз.
> Ничего из PROPOSED не реализуется без отдельного явного «да» владельца.
>
> **Правило конфликтов (введено 2026-09-09, обязательно для Stage 3 и далее):** если в ходе
> реализации обнаруживается конфликт или неоднозначность между утверждённым решением владельца
> и фактами `AUDIT/*`/остальным содержимым `RECONCILIATION/*` — Claude Code **не решает конфликт
> самостоятельно**. Конфликт фиксируется как `OPEN OWNER QUESTION` (где именно, в чём
> расхождение, какие варианты) и работа по этому конкретному пункту останавливается до ответа
> владельца. Остальные, не связанные с конфликтом задачи можно продолжать.

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
- **`irz-modem-control` (корневой легаси)** — AUTHORITATIVE (владелец, 2026-09-09): не трогать
  вообще ни на одной фазе. См. §5 п.4 ниже.

## 5. Решения владельца (2026-09-09) — бывшие открытые вопросы, теперь AUTHORITATIVE

Ниже — те же 4 пункта, что были поставлены как открытые вопросы при первом проходе Stage 2.5A,
с ответами владельца. Статус каждого — **AUTHORITATIVE**, встроено в
[01_COMPONENT_DECISIONS.md](01_COMPONENT_DECISIONS.md)/[02_DATA_MIGRATION.md](02_DATA_MIGRATION.md)/
[03_IMPLEMENTATION_SEQUENCE.md](03_IMPLEMENTATION_SEQUENCE.md)/[05_ARCHITECTURE_DECISIONS.md](05_ARCHITECTURE_DECISIONS.md)
(см. ADR-14…ADR-17).

1. **«1 проект = 1 активный модем» — НЕ архитектурное ограничение.** Решено: это ограничение
   сегодняшнего middleware (`server.js`, `LIMIT 1`), не свойство продукта. Целевая модель:
   **Organization → Objects/Projects → Modems → RS-485 → Meters** — один объект может иметь
   несколько модемов, один клиент может иметь несколько объектов. Реализуется в Phase 1 (Device
   Core), не откладывается. Важный технический нюанс, снижающий риск: схема БД (`modems.project_id`)
   уже не ограничивает число модемов на проект — ограничение целиком в application-слое
   (middleware + отсутствие UI-селектора), значит это в основном не миграция схемы, а
   расширение уже существующего паттерна (`?meterId=` для счётчиков распространяется на
   `?modemId=` для модемов). См. `01_COMPONENT_DECISIONS.md` домен 3, `02_DATA_MIGRATION.md` §1.
2. **Organization вводится как сущность верхнего уровня над Project/Object.** Необходима для
   поддержки нескольких объектов одного клиента и будущей партнёрской модели. Миграция —
   **additive**, существующие `projects` и их данные не ломаются. Физическая реализация — в
   Phase 4 (Multitenant SaaS/RBAC), не раньше — вводить сущность заранее без наполнения было бы
   нарушением принципа «не выдумывать функции». См. `01_COMPONENT_DECISIONS.md` домен 2,
   `02_DATA_MIGRATION.md` §1.
3. **`modem_tariffs` — deprecated.** Исторические данные сохраняются/архивируются, **не
   удаляются** без отдельного явного решения владельца по каждому конкретному случаю переноса.
   См. `01_COMPONENT_DECISIONS.md` домен 6.
4. **`irz-modem-control` (корневой легаси-прототип) — LEGACY/UNKNOWN.** На текущем этапе **не
   трогать вообще**: не рефакторить, не переносить, не удалять, не оптимизировать «раз уж
   рядом». Вне периметра всех фаз этой реконсиляции, независимо от того, какие VPS-ресурсы он
   занимает — судьба этого приложения не решается инженерными задачами Stage 3.

**Важно для Stage 3 и далее:** это решения по ЦЕЛЯМ архитектуры, не разрешение начинать
реализацию раньше срока — пункт 1 и 2 всё равно ждут своей фазы (Phase 1 и Phase 4
соответственно) и, для Phase 1, Phase 0 как обязательного гейта (см. §4 выше и
`03_IMPLEMENTATION_SEQUENCE.md`).
