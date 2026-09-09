# 16 — RECOMMENDED TARGET ARCHITECTURE (входные данные для Stage 2.5A)

Это **не** формальное архитектурное решение — по правилам мастер-промпта финальную
архитектуру утверждает владелец после Stage 2.5A (`stages/STAGE_2_5A_ARCHITECTURE_RECONCILIATION.md`),
сопоставив этот аудит с целевыми документами. Ниже — черновая раскладка «что куда» на основе
фактов, собранных в этом аудите, чтобы Stage 2.5A стартовала не с чистого листа.

## Принцип

`03_TARGET_ARCHITECTURE.md` уже выбрал форму (Modular Monolith + Workers, без микросервисов/
Kafka/Redis без доказанной необходимости) — и она **совместима** с тем, что уже физически
есть: один Node-процесс + один внешний воркер (Java-демон). Это значит, что путь вперёд —
не смена платформы, а **внутреннее разделение на границы доменов** внутри уже существующего
процесса, постепенно выделяя файлы/модули по мере роста, ровно как заповедано в
`STAGE_2_5A`: «Не переписывать всё сразу. Сначала определить границы, затем постепенно
переносить/оборачивать проверенные компоненты».

## Предварительная раскладка доменов на существующий код

| Домен таргета | Что уже есть и куда переносить | Что строить с нуля |
|---|---|---|
| Device Core | `modemState.js` + GPIO-маршруты `server.js` — EXTRACT в `domains/device/` | явные сущности retry/backoff/communication-gaps как состояние, не только таймауты в коде |
| Metering Core | `mercury*.js` целиком (уже отдельные файлы, KEEP AS IS) + профильная часть `server.js` | явное разделение raw/validated на уровне схемы, если понадобится для аудируемости (сегодня разделение логическое, не табличное — решить на 2.5A, нужно ли это физически разделять, или логического достаточно) |
| Commercial Accounting | `computeReadingPeriod`/`computeSiteTariffCost`/`scaleByCtRatio` — EXTRACT в `domains/commercial/`, REFACTOR на Decimal | таблицы `calculations`/`statements` (персистентный, версионируемый результат) |
| Tariffs | `site_tariffs` — KEEP WITH REFACTOR (добавить `valid_to` или явно обосновать, почему не нужен) | — |
| Reporting | `tickReports`/XLSX-экспорт — EXTRACT в `domains/reporting/` | сравнение периодов (Planned из `01_PROJECT.md`) |
| Incidents & Notifications | `alerts`/`tickAlerts`/`mailer.js` — EXTRACT в `domains/incidents/` | SMS/Telegram/push-каналы (Planned) |
| Identity & Access | `auth.js` — KEEP WITH REFACTOR: сохранить механизм сессий, добавить permission-слой поверх enum-ролей | таблицы `roles`/`permissions`, роли PARTNER/PARTNER_MANAGER |
| Organizations/Multitenancy | `projects`/tenant-isolation middleware — KEEP WITH REFACTOR | явная сущность Organization над Project, если бизнесу нужна такая иерархия (уточнить на 2.5A — сегодня не очевидно, что 1 project ≠ 1 organization уже сейчас проблема) |
| Partner Network | — | NEW, с нуля: `partners`, `partner_leads`, `partner_attributions`, `partner_commissions`, `partner_balances`, `partner_payouts`, `partner_certifications` |
| Revenue & Subscriptions | — | NEW: `subscriptions`, `revenue_events` — первый практический шаг, вероятно, ДО Partner Network (комиссия считается от revenue event, значит сначала нужен сам revenue event) |
| AI Revenue Network | — | NEW, самая дальняя веха (Phase 6) — сознательно не форсировать раньше, чем устоятся домены 5/9/10 |
| Audit | частично `report_log`/`alerts.ack_at` | NEW: единая таблица `audit_logs`, миддлварь для критических действий (смена тарифа, удаление счётчика, impersonation, сброс пароля) |

## Что уже полностью соответствует Modular Monolith + Workers и не требует решения

- Java-демон как единственный внешний воркер — уже ровно то, что подразумевает "+ Workers"
  в названии таргетной формы. Не нужно вводить отдельную очередь задач (Bull/Celery/etc.)
  ради этого — уже есть работающий, изолированный воркер-процесс.
- SQLite как хранилище — таргет-документы нигде не требуют смены СУБД, и текущий объём
  (3.2 МБ, умеренная запись) не создаёт давления к миграции на Postgres/MySQL. Явно
  запрещено на этой стадии решать вопрос БД как предпосылку («Forbidden until owner
  approval: framework/DB replacement as a prerequisite» — `STAGE_2_5A`). Если рост числа
  клиентов/партнёров/AI-задач когда-то потребует конкурентного доступа из нескольких
  процессов — это отдельное, будущее решение с доказанной необходимостью, не сейчас.

## Первый практический шаг (согласуется с Phase 0 роадмапа)

Прежде чем резать `server.js` на домены (Phase 1 роадмапа, Device Core boundaries) —
закрыть три предпосылки безопасности/устойчивости, названные в этом же аудите как
независимые от выбора архитектуры:
1. Секреты `CLAUDE.md` — вне рабочей папки ([15_RISKS.md](15_RISKS.md) #1).
2. Регулярный бэкап `app.db` ([15_RISKS.md](15_RISKS.md) #2).
3. Диагностика 140 рестартов `irz-web-gpio` ([15_RISKS.md](15_RISKS.md) #5).

Ни одно из трёх не требует архитектурного решения Stage 2.5A и не блокируется им — можно
делать параллельно/до неё, если владелец сочтёт нужным.
