# STAGE 2 — REPOSITORY AUDIT

## Mode
READ ONLY / FORENSIC AUDIT.

### Forbidden
- code changes
- package changes
- database changes
- production changes
- device configuration
- SMS commands
- commits
- pushes
- deletion/renaming of legacy files

## Goal
Понять фактическое состояние репозитория и отделить подтверждённое от предположений.

## Inspect
1. git history
2. repository structure
3. documentation
4. backend
5. frontend
6. database/data model
7. iRZ modem layer
8. RS-485/Mercury protocol
9. GPIO
10. auth/security
11. deployment
12. dependencies
13. tech debt
14. reusable components
15. ASKUE feature gaps

## Evidence labels
- CONFIRMED
- PARTIALLY CONFIRMED
- INFERRED
- NOT FOUND
- UNKNOWN

## Required output
Create `AUDIT/`:
- 00_EXECUTIVE_SUMMARY.md
- 01_REPOSITORY_MAP.md
- 02_ARCHITECTURE.md
- 03_BACKEND.md
- 04_FRONTEND.md
- 05_DATA_AND_DATABASE.md
- 06_IRZ_MODEMS.md
- 07_RS485_AND_METERS.md
- 08_GPIO.md
- 09_AUTH_AND_SECURITY.md
- 10_DEPLOYMENT.md
- 11_DEPENDENCIES.md
- 12_TECH_DEBT.md
- 13_REUSABLE_COMPONENTS.md
- 14_ASKUE_GAP_ANALYSIS.md
- 15_RISKS.md
- 16_RECOMMENDED_TARGET_ARCHITECTURE.md

## Security
Search for secrets, passwords, API keys, tokens, public IPs, default credentials and sensitive files. Never reproduce secret values in audit output. Record only type, location and remediation.

## Reusable component classification
- KEEP AS IS
- KEEP WITH REFACTOR
- EXTRACT
- REWRITE
- DEPRECATE
- UNKNOWN

## Final console summary
Report:
- repository health
- architecture
- production-critical components
- security findings
- ASKUE gaps
- reusable assets
- top risks
- recommended next step

STOP after audit.
