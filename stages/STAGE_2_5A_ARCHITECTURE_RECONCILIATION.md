# STAGE 2.5A — ARCHITECTURE RECONCILIATION

## Inputs
- Stage 1 project/business/architecture documents
- complete `AUDIT/*`

## Goal
Сопоставить реальный код с целевой архитектурой до начала масштабной разработки.

## Classification
Каждый значимый компонент получает одно решение:
- KEEP
- KEEP WITH REFACTOR
- EXTRACT
- REWRITE
- DEPRECATE
- NEW

## Required analysis
1. Current vs target architecture
2. Current vs target data model
3. Device/protocol boundary
4. Metering pipeline
5. Commercial calculation
6. Multitenancy
7. RBAC
8. Partner domain
9. Revenue/commission model
10. AI Revenue Network
11. Security
12. Deployment/operations

## Required output
Create `RECONCILIATION/`:
- 00_FINAL_ARCHITECTURE.md
- 01_COMPONENT_DECISIONS.md
- 02_DATA_MIGRATION.md
- 03_IMPLEMENTATION_SEQUENCE.md
- 04_RISK_REGISTER.md
- 05_ARCHITECTURE_DECISIONS.md

## Migration principle
Не переписывать всё сразу. Сначала определить границы, затем постепенно переносить/оборачивать проверенные компоненты.

## Forbidden until owner approval
- big-bang rewrite
- production DB migration without backup/rollback
- framework/DB replacement as a prerequisite
- microservices migration
- Kafka/Redis introduction without evidence
- protocol changes
- deletion of legacy production-critical functionality
- changing financial calculation semantics

## Final decision
После Stage 2.5A владелец утверждает final architecture и только затем запускается implementation planning.
