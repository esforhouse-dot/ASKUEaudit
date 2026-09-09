# 03 — PHASES 2-7 OUTLINE (не детализировано до уровня задач)

> Обоснование, почему не в формате Phase 0/1 — см. `00_OVERVIEW_AND_GOVERNANCE.md`. Коротко:
> полная детализация сейчас означала бы либо додумывание непроработанных деталей будущих
> доменов, либо задачи, которые почти наверняка изменятся после Phase 0-3. Каждая фаза
> получает такую же детализацию, как Phase 0/1 в этом документе, **отдельным шагом**, когда
> предыдущая фаза завершена и подтверждена.

---

## Phase 2 — Metering Core

**Источник:** `RECONCILIATION/03_IMPLEMENTATION_SEQUENCE.md` Phase 2,
`RECONCILIATION/01_COMPONENT_DECISIONS.md` домен 4.

**Epic'и:**
- Физический перенос `mercury*.js` в `domains/metering/` — **без изменения содержимого**
  (KEEP AS IS). Самый безопасный extraction во всём плане — по формату идентичен `P1-01`, будет
  детализирован в этом же формате при старте фазы.
- Опционально: материализация raw/validated разделения в схеме (не обязательна для Phase 2).

**Зависимости:** все `P0-*`; технически не зависит от `P1-*`, но по порядку роадмапа идёт после.

**Риски, которые нужно будет учесть при детализации:** протокольный слой — самый зрелый и
чувствительный к малейшему изменению код базы (`AUDIT/07_RS485_AND_METERS.md`) — задачи должны
формулироваться с той же строгостью «только перенос, 0 изменений логики», что и `P1-01`.

---

## Phase 3 — Commercial Accounting and historical tariffs/assignments

**Источник:** `RECONCILIATION/03_IMPLEMENTATION_SEQUENCE.md` Phase 3,
`RECONCILIATION/02_DATA_MIGRATION.md` §3 (9 шагов),
`RECONCILIATION/05_ARCHITECTURE_DECISIONS.md` ADR-06/07 (AUTHORITATIVE, owner 2026-09-09).

**Epic'и (соответствуют 9 шагам `02_DATA_MIGRATION.md` §3):**
1. Зафиксировать текущую формулу как эталон.
2. Собрать regression fixtures на реальных исторических расчётах.
3. Реализовать новую Commercial Calculation модель рядом со старой.
4. Регрессионная проверка совпадения на fixtures.
5. Переход на Decimal для нового пути (только после совпадения).
6. `meter_assignments(valid_from, valid_to)` — NEW.
7. `tariffs`/`tariff_versions` (`valid_to` к `site_tariffs`) — NEW.
8. `calculations`/`statements` — персистентность для новых расчётов.
9. Параллельная работа обоих путей в проде ≥1 биллинговый цикл → подтверждённое совпадение на
   реальном трафике → новый путь становится единственным → **старый float-путь удаляется**
   (обязательный финальный шаг, не опция — см. ADR-06 DoD).

**Это самая формализованная и самая рискованная фаза плана.** Детализация до уровня задач
(формат Phase 0/1) должна произойти **до** начала кодирования, не параллельно с ним — учитывая
чувствительность (деньги клиентов), рекомендуется, чтобы владелец отдельно рассмотрел
детализированный план именно этой фазы перед стартом, даже если Phase 0-2 прошли гладко.

**Жёсткая блокировка:** Phase 5 (Partner Network) не начинается до завершения шага 9 целиком.

---

## Phase 4 — Multitenant SaaS / RBAC

**Источник:** `RECONCILIATION/03_IMPLEMENTATION_SEQUENCE.md` Phase 4,
`RECONCILIATION/05_ARCHITECTURE_DECISIONS.md` ADR-04/ADR-15.

**Epic'и:**
- `roles`/`permissions` поверх существующего `admin`/`master`/`limited` (additive, см. ADR-04 —
  этот ADR остаётся **PROPOSED**, не переведён в AUTHORITATIVE решением 2026-09-09 — требует
  отдельного утверждения владельца перед детализацией в задачи).
- Сущность `Organization` над `Project` — **AUTHORITATIVE** (ADR-15), additive-миграция.

**Зависимости:** Phase 5 (роль `PARTNER`) зависит от завершения этой фазы.

---

## Phase 5 — Partner Network

**Источник:** `RECONCILIATION/03_IMPLEMENTATION_SEQUENCE.md` Phase 5,
`RECONCILIATION/01_COMPONENT_DECISIONS.md` домены 9-10.

**Жёсткая зависимость:** не начинается раньше завершения Phase 3 (шаг 9) и Phase 4.

**Epic'и:**
- `subscriptions`, `revenue_events` — сначала (без них комиссии физически не от чего считать).
- `partners`, `partner_leads`, `partner_attributions`, `partner_clients`, `partner_commissions`,
  `partner_balances`, `partner_payouts`, `partner_certifications` — после.
- Переход на формальный migration-раннер вместо inline-паттерна `db.js`
  (`RECONCILIATION/02_DATA_MIGRATION.md` §2 — порог ~5-6 новых таблиц одной итерацией достигается
  именно здесь).

**Требует отдельного проектного прохода до детализации в задачи** — денежная логика комиссий
(50% партнёру) должна следовать тому же уровню строгости, что Phase 3 (regression fixtures,
Decimal с самого начала — здесь нет legacy float-пути, который нужно было бы сохранять
совместимым, можно писать сразу правильно).

---

## Phase 6 — AI Revenue Network

**Источник:** `RECONCILIATION/03_IMPLEMENTATION_SEQUENCE.md` Phase 6,
`RECONCILIATION/01_COMPONENT_DECISIONS.md` домен 11.

**Epic'и:** orchestrator + customer/partner-агенты (`customer-scout`, `customer-researcher`,
`lead-qualifier`, `sales-assistant`, `partner-scout`, `partner-researcher`, `partner-qualifier`,
`partner-activation`, `partner-success`, плюс сквозные `analytics`/`content` —
`00_MASTER_PROMPT.md`); policy/human-approval gate для чувствительных действий (мастер-промпт:
AI не выполняет финансовые операции/смену тарифов/прав доступа/destructive DB операции/смену
конфигурации устройств без approval).

**Зависимости:** реальные данные Phase 3/5 (расчёты, revenue events) — не начинается раньше их
стабилизации.

---

## Phase 7 — Product AI

**Источник:** `RECONCILIATION/03_IMPLEMENTATION_SEQUENCE.md` Phase 7.

Самая дальняя веха. Не приоритизируется этим планом — детализация откладывается до
приближения к этой фазе по календарю, содержание может существенно измениться под влиянием
результатов Phase 1-6.

---

## Сводка: что нужно ПЕРЕД детализацией каждой следующей фазы

| Фаза | Что должно быть закрыто перед детализацией задач |
|---|---|
| Phase 2 | Все `P0-*` |
| Phase 3 | Phase 2 завершена; отдельное владельческое утверждение детализированного плана этой фазы (из-за денежной чувствительности) |
| Phase 4 | Phase 3 завершена (шаг 9); ADR-04 (permission-based RBAC) отдельно утверждён владельцем — сейчас PROPOSED, не AUTHORITATIVE |
| Phase 5 | Phase 3 (шаг 9) и Phase 4 завершены |
| Phase 6 | Phase 5 стабилизирована |
| Phase 7 | Phase 6 стабилизирована |
