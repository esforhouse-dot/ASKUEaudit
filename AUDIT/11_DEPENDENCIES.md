# 11 — DEPENDENCIES

## `fetched/` (irz-web-gpio) — реальные зависимости продакшна

Источник — `/opt/irz-web/package.json`, прочитан read-only с VPS 2026-09-09 (в репозитории
своего `package.json` нет, см. [10_DEPLOYMENT.md](10_DEPLOYMENT.md)):

```json
{
  "name": "irz-web-gpio",
  "dependencies": {
    "bcryptjs": "^3.0.3",
    "better-sqlite3": "^11.10.0",
    "exceljs": "^4.4.0",
    "express": "^4.18.2",
    "mysql2": "^3.9.0",
    "nodemailer": "^9.1.1"
  }
}
```
Node.js runtime на сервере: **v18.20.8**. Нет `devDependencies` вообще — нет тестового
фреймворка, линтера, бандлера. CONFIRMED, read-only.

Транзитивные зависимости (плоский список `node_modules` верхнего уровня, ~110 пакетов) —
преимущественно дерево `exceljs` (archiver, jszip, saxes, xmlchars, tar-stream и т.п.) —
самая «тяжёлая» по количеству субпакетов зависимость проекта. Точных semver-версий
транзитивных пакетов не снималось (нет lock-файла на сервере — не проверялось, установлен ли
`package-lock.json` там; если нет, `^`-диапазоны в `package.json` означают, что фактически
установленные минорные версии могут плавать между переустановками). UNKNOWN — наличие/состав
lock-файла на сервере не проверялся в этом read-only проходе.

## Известные CVE / устаревшие мажоры — не проверялось

`npm audit` не запускался (потребовал бы `npm install`/сетевого доступа к реестру npm с
машины аудита или выполнения команды на проде — то и другое не входит в объём read-only
аудита репозитория, второе к тому же расширяет доступ за пределы «изменений не вносить»).
NOT CHECKED. Рекомендация для отдельного шага (не Stage 2): прогнать `npm audit` read-only
прямо на сервере (`cd /opt/irz-web && npm audit --omit=dev`, без `npm install`/`fix`) при
следующей сессии, где это явно попросят.

## Корневой `package.json` (старое приложение, `irz-modem-control`) — для полноты

```json
{
  "dependencies": { "axios": "^1.6.0", "body-parser": "^1.20.2", "cors": "^2.8.5", "express": "^4.18.2" },
  "devDependencies": { "nodemon": "^3.0.1" }
}
```
Относится к легаси-продукту в корне репозитория, не к `fetched/`. Упомянут здесь только для
разграничения — см. [01_REPOSITORY_MAP.md](01_REPOSITORY_MAP.md).

## Внешние сетевые зависимости времени выполнения (не npm, но часть поверхности)

- `smtp.mail.ru:465` (SSL) — исходящая почта, см. [03_BACKEND.md](03_BACKEND.md)/`mailer.js`.
- `147.45.212.205` (сам себя, localhost для процесса, но захардкожен как IP, не `127.0.0.1`,
  в качестве `COLLECTOR_HOST`) — TCP к «прозрачному порту» Меркурий-счётчиков и к MySQL
  `irzserver4` (`127.0.0.1:3306`, отдельно от `COLLECTOR_HOST`).
- Google Fonts (`fonts.googleapis.com`/`fonts.gstatic.com`) — единственная сторонняя
  зависимость фронтенда, см. [04_FRONTEND.md](04_FRONTEND.md).
- Вендорский `Service.jar` (Java) — не npm-пакет, отдельный бинарный артефакт вне
  репозитория (`/usr/local/iRZ_Server/dist/Service.jar`), не проверялся (NOT INSPECTED).
