# 01 — REPOSITORY MAP

## Верхнеуровневая структура

```
ASK/
├── 00_MASTER_PROMPT.md, 01-04_*.md    ← Stage 1 (новые, 2026-09-09) — вход для этого аудита
├── README.md                          ← README СТАРОГО irz-modem-control (см. ниже), не описывает fetched/
├── stages/                            ← STAGE_2_*.md, STAGE_2_5A_*.md — постановки задач
├── AUDIT/                             ← этот аудит (создан Stage 2)
├── CLAUDE.md                          ← оперативная шпаргалка для ассистента (доступы, деплой)
├── ROADMAP.md                         ← чек-лист функций vs конкуренты (отдельно от stages/04_ROADMAP.md!)
│
├── fetched/                           ★ ТЕКУЩИЙ ПРОДУКТ — irz-web-gpio, порт 3005
│   ├── server.js                      2778 строк, 83 маршрута — монолитный роут-файл
│   ├── db.js                          SQLite-схема + inline-миграции (ALTER TABLE IF NOT EXISTS-паттерн)
│   ├── auth.js                        сессии, bcrypt, RBAC-гейты
│   ├── modemState.js                  in-memory состояние процесса, приоритетные очереди RS-485/GPIO
│   ├── mailer.js                      SMTP (nodemailer, mail.ru)
│   ├── mercuryPoll.js / mercuryProtocol.js / mercuryProfile.js / mercuryProfilePoll.js
│   │                                  протокол Меркурий поверх TCP (iRZ Collector transparent port)
│   ├── index.html                     4733 строки — кабинет клиента (SPA, ванильный JS)
│   ├── admin.html                     404 строки — платформенный админ-кабинет
│   ├── login.html                     185 строк
│   ├── landing.html                   799 строк — редактируемый лендинг (админ правит инлайн)
│   ├── nginx-askue.conf               конфиг reverse-proxy (askue.o-dir.ru → 127.0.0.1:3005)
│   ├── scripts/                       create-admin.js, set-password.js, migrate-to-multitenant.js — разовые CLI-утилиты
│   ├── energy-test.js, profile-test.js, profile-test2.js
│   │                                  диагностические скрипты для живой проверки протокола (не часть приложения)
│   └── _backup_pre_swiss/             снятые вручную бэкапы 3 HTML до редизайна (index/admin/login.html)
│
├── public/                            ← СТАРЫЙ irz-modem-control (app.js, index.html, styles.css)
├── server.js (корень)                 ← СТАРЫЙ irz-modem-control, 129 КБ — НЕ путать с fetched/server.js
├── ecosystem.config.js                ← pm2-конфиг СТАРОГО приложения (irz-modem-control, порт 3004)
├── check-firewall.sh, fix-email-firewall.sh
├── НАСТРОЙКА_*.md, РЕШЕНИЕ_*.md, ДИАГНОСТИКА_*.md, ИНСТРУКЦИЯ.md, ...
│                                  ← ~25 md-файлов инструкций для СТАРОГО приложения (SMS-команды, GPIO)
├── package.json, package-lock.json    ← зависимости СТАРОГО приложения (axios, body-parser, cors, express)
├── .claude/                           agents (mobile-responsive-check, web-design-review), skills/frontend-design
├── .gitignore                         существует, хотя репозиторий не является git-репозиторием
└── (мусор в корне) _patch2.js, diag_modems_out.txt, id.txt, verify_journals_out2.txt
```

## Живое ↔ мёртвое — сводная таблица

| Путь | Статус | Evidence |
|---|---|---|
| `fetched/*` | ЖИВОЕ, продакшн, `irz-web-gpio:3005` | CONFIRMED — md5 совпадает с `/opt/irz-web/*` |
| `fetched/scripts/*.js` | живое, но запускается вручную (не по расписанию) | CONFIRMED (grep — нет cron/pm2-задачи на них) |
| `fetched/energy-test.js`, `profile-test*.js` | диагностика, не часть HTTP-приложения (`server.js` их не требует) | CONFIRMED |
| `fetched/_backup_pre_swiss/*` | мёртвые снапшоты, оставлены как ручной откат | INFERRED (по имени папки и содержимому — предыдущие версии тех же 3 файлов) |
| Корень: `server.js`, `public/`, `ecosystem.config.js`, все `.md` с ЗАГЛАВНЫМИ_ИМЕНАМИ | ЖИВОЕ, но ОТДЕЛЬНЫЙ продукт — `irz-modem-control:3004` | CONFIRMED (pm2 jlist на VPS показывает оба процесса online; `CLAUDE.md` явно предписывает не путать) |
| `README.md` (корень) | описывает СТАРОЕ приложение (`http://147.45.212.205:3004`, SMS-команды) | CONFIRMED — прочитан целиком |
| `ROADMAP.md` (корень) | относится к `fetched/` (упоминает PWA, роли доступа — актуальные темы) | INFERRED по содержанию, требует явного подтверждения при Stage 2.5A |
| `_patch2.js`, `diag_modems_out.txt`, `id.txt`, `verify_journals_out2.txt` | разовый мусор в корне | UNKNOWN — не читались подробно (вне области текущего продукта), похоже на выгрузки/патчи для старого приложения по именам |
| `.claude/agents/*`, `.claude/skills/*` | инструменты самого Claude Code, не код продукта | CONFIRMED |
| `Доступы.docx` | вне аудита (бинарный офисный файл) | NOT INSPECTED |

## Дублирование именования — источник потенциальной путаницы

Два несвязанных файла называются одинаково и требуют внимания при любой будущей автоматизации/скриптах поиска:
- `server.js` — есть **и в корне** (старое приложение), **и в `fetched/`** (текущее). CLAUDE.md уже
  прямо предупреждает об этом; в этом аудите везде, где не указано иное, `server.js` = `fetched/server.js`.
- Два разных `ROADMAP.md`: `ASK/ROADMAP.md` (функциональный чек-лист vs конкуренты) и
  `ASK/stages/04_ROADMAP.md` (фазы Stage-1 плана: Device Core → Metering Core → ... → AI Revenue
  Network). Смысл разный, тема пересекается (обе — про приоритеты будущей разработки) — при
  Stage 2.5A их стоит явно сверить друг с другом, чтобы не вести два параллельных бэклога.

## Дерево на сервере, отсутствующее локально

`/opt/irz-web/mercury/` содержит `mercury-connect-probe.js`, `mercury-read.js`, `mercury-test.js` —
живут только на VPS, не в этом репозитории. См. [12_TECH_DEBT.md](12_TECH_DEBT.md).
