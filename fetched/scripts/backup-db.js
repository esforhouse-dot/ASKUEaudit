// Автоматический бэкап app.db (P0-05, RECONCILIATION/04_RISK_REGISTER.md R-14).
// Запуск: node scripts/backup-db.js
//
// Использует better-sqlite3 db.backup() — штатный SQLite backup API (тот же движок, что уже
// использует приложение), безопасен против активной WAL-режима БД без остановки писателя.
// НЕ копирует файл напрямую (fs.copyFile/cp) — это не гарантирует консистентность, можно
// снять снимок в момент, когда часть изменений ещё в WAL, а не в основном файле.
//
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// ВАЖНО (P0-05, обязательное предусловие из карточки задачи): каталог назначения по умолчанию
// ниже — ЗАГЛУШКА внутри той же data/, намеренно НЕ off-server. Реальное off-server расположение
// бэкапов ещё не определено владельцем — куда именно физически писать (другой VPS? облачное
// хранилище? примонтированный сетевой диск?) решает владелец, не этот скрипт. Пока
// ASKUE_BACKUP_DIR не указывает на подтверждённый off-server путь, запись идёт на тот же
// локальный диск production-сервера, что и сам app.db (риск R-16 этим скриптом самим по себе
// НЕ закрыт) — устанавливать в cron до решения этого вопроса нельзя. Заглушка нужна, чтобы
// скрипт был runnable и тестируемым локально/на staging уже сейчас, не дожидаясь решения.
const BACKUP_DIR = process.env.ASKUE_BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups');

const SOURCE_DB = path.join(__dirname, '..', 'data', 'app.db');
const RETENTION_DAYS = 14; // старые бэкапы старше этого не хранятся (acceptance criteria P0-05)
const FILE_PREFIX = 'app-';
const FILE_SUFFIX = '.db';

// Точность до миллисекунд, не до секунды — при секундной точности два запуска подряд (найдено
// живым тестом: два прогона скрипта в течение одной секунды на этой же машине) получают
// ОДИНАКОВОЕ имя файла, и второй молча ЗАТИРАЕТ бэкап первого через тот же db.backup() вызов —
// то есть можно было бы потерять единственный на тот момент бэкап, ничего об этом не узнав.
function timestampForFilename(d) {
  return d.toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

/** Лёгкая проверка целостности снятого бэкапа — не замена P0-06 (там полноценный restore-drill),
 *  а быстрый сигнал "файл вообще не побит", чтобы не копить годы битых бэкапов незамеченными. */
function quickIntegrityCheck(backupPath) {
  const bdb = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const result = bdb.pragma('quick_check', { simple: true });
    return result === 'ok';
  } finally {
    bdb.close();
  }
}

function applyRetention(dir) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  const removed = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(full);
      removed.push(name);
    }
  }
  return removed;
}

async function main() {
  if (!fs.existsSync(SOURCE_DB)) {
    console.error(`backup-db: исходная БД не найдена: ${SOURCE_DB}`);
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const now = new Date();
  const backupPath = path.join(BACKUP_DIR, `${FILE_PREFIX}${timestampForFilename(now)}${FILE_SUFFIX}`);

  const source = new Database(SOURCE_DB, { readonly: true });
  try {
    await source.backup(backupPath);
  } finally {
    source.close();
  }

  const stat = fs.statSync(backupPath);
  if (stat.size === 0) {
    console.error(`backup-db: снятый бэкап пуст (${backupPath}) — считаю задачу проваленной`);
    process.exit(1);
  }

  const ok = quickIntegrityCheck(backupPath);
  if (!ok) {
    console.error(`backup-db: бэкап не прошёл quick_check (${backupPath}) — возможна порча`);
    process.exit(1);
  }

  const removed = applyRetention(BACKUP_DIR);

  console.log(`backup-db: OK — ${backupPath} (${(stat.size / 1024 / 1024).toFixed(2)} МБ, quick_check=ok)`);
  if (removed.length) console.log(`backup-db: retention удалил ${removed.length} файл(ов) старше ${RETENTION_DAYS} дней: ${removed.join(', ')}`);
}

main().catch((e) => {
  console.error('backup-db: ошибка —', e.message);
  process.exit(1);
});
