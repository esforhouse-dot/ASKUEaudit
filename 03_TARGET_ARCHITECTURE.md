# TARGET ARCHITECTURE

## Shape
Modular Monolith + Workers.

Микросервисы, Kafka, Redis и другие распределённые компоненты не вводятся без доказанной необходимости.

## Domains
1. Identity & Access
2. Organizations / Multitenancy
3. Device Core
4. Metering Core
5. Commercial Accounting
6. Tariffs
7. Reporting
8. Incidents & Notifications
9. Partner Network
10. Revenue & Subscriptions
11. AI Revenue Network
12. Audit

## Device Core
Modem → RS485 Bus → Meter #1..N
Отдельно:
- communication channel
- GPIO
- device health/state
- polling jobs
- retry/backoff
- timeout
- idempotency
- last successful reading
- communication gaps

## Measurement pipeline
RAW → VALIDATION → NORMALIZATION → CONSUMPTION → COMMERCIAL CALCULATION

## Data model principles
Исторические сущности:
- MeterAssignment(valid_from, valid_to)
- TariffVersion(valid_from, valid_to)
- AccountingPeriod

Коммерческий расчёт хранит:
- входные показания
- коэффициенты
- тариф
- правило округления
- результат
- время/версию расчёта

## Money
Использовать Decimal/детерминированную арифметику.

## RBAC
- PLATFORM_ADMIN
- MASTER
- USER
- PARTNER
- PARTNER_MANAGER

Предпочтение permission-based authorization вместо набора boolean-флагов.

## Core entities
organizations, users, roles, permissions,
objects, tenants, tenant_assignments,
modems, rs485_buses, meters, meter_assignments,
raw_readings, meter_readings, load_profiles, instant_measurements,
tariffs, tariff_versions,
accounting_periods, consumption_records, calculations, statements,
incidents, notifications, notification_rules,
reports, report_deliveries,
partners, partner_leads, partner_attributions, partner_clients,
partner_commissions, partner_balances, partner_payouts, partner_certifications,
subscriptions, revenue_events,
audit_logs,
ai_leads, ai_research, ai_tasks, ai_actions, ai_conversations, ai_sources.

## AI safety
AI не должен напрямую выполнять:
- финансовые операции
- изменение тарифов
- изменение прав доступа
- destructive DB operations
- изменение production device configuration

без policy/human approval.
