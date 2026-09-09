// Восстановление app.db из бэкапа (P0-06, RECONCILIATION/04_RISK_REGISTER.md R-15).
// Запуск: node scripts/restore-db.js <файл-бэкапа> <целевой-путь> [--force]
//
// Бэкап, снятый backup-db.js (P0-05, better-sqlite3 db.backup()), — это уже полный, автономный,
// зачекпойнченный файл SQLite, не активный WAL-writer, поэтому здесь безопасно копировать его
// как обычный файл (fs.copyFileSync) — в отличие от backup-db.js, который снимает копию с
// АКТИВНОЙ БД и обязан использовать db.backup(), не голое копирование.
//
// Защита от случайной перезаписи: если целевой путь уже существует, скрипт по умолчанию
// ОТКАЗЫВАЕТ (нужен явный --force) — restore это разрушительное действие по своей природе,
// не должно случайно затереть что-то живое из-за опечатки в пути.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function fail(msg) {
  console.error('restore-db: ' + msg);
  process.exit(1);
}

function quickIntegrityCheck(dbPath) {
  // Файл, который вообще не SQLite (не только "повреждённая, но опознаваемая" БД), даёт не
  // 'ok'/'not ok' от quick_check, а бросает SqliteError (SQLITE_NOTADB) — ловим здесь и
  // трактуем как "не прошёл проверку", а не даём исключению всплыть наверх сырым стектрейсом
  // (найдено тестом P0-06 — до этой правки пользователь в реальной ситуации увидел бы стектрейс
  // Node вместо понятного сообщения от fail()).
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return db.pragma('quick_check', { simple: true }) === 'ok';
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function tableRowCounts(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all().map((r) => r.name);
    const counts = {};
    for (const t of tables) {
      counts[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
    }
    return counts;
  } finally {
    db.close();
  }
}

function main() {
  const [, , backupPath, targetPath, flag] = process.argv;
  const force = flag === '--force';

  if (!backupPath || !targetPath) {
    fail('использование: node scripts/restore-db.js <файл-бэкапа> <целевой-путь> [--force]');
  }
  if (!fs.existsSync(backupPath)) {
    fail(`файл бэкапа не найден: ${backupPath}`);
  }
  if (fs.existsSync(targetPath) && !force) {
    fail(`целевой путь уже существует: ${targetPath} — передайте --force, если это осознанно (перезапись)`);
  }

  // Проверяем ЦЕЛОСТНОСТЬ БЭКАПА до восстановления — нет смысла (и небезопасно) разворачивать
  // заведомо битый файл поверх чего-либо.
  if (!quickIntegrityCheck(backupPath)) {
    fail(`бэкап не прошёл quick_check — он повреждён, восстановление ОТМЕНЕНО: ${backupPath}`);
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(backupPath, targetPath);

  // Проверяем целостность УЖЕ ВОССТАНОВЛЕННОЙ копии — копирование файла само по себе тоже
  // может пойти не так (диск переполнен на середине, обрыв и т.п.).
  if (!quickIntegrityCheck(targetPath)) {
    fail(`восстановленная копия не прошла quick_check — результат ненадёжен: ${targetPath}`);
  }

  const counts = tableRowCounts(targetPath);
  console.log(`restore-db: OK — восстановлено в ${targetPath}`);
  console.log('restore-db: количество строк по таблицам (сверьте с ожидаемым на момент снятия бэкапа):');
  for (const [t, c] of Object.entries(counts)) console.log(`  ${t}: ${c}`);
}

main();
