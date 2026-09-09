// Разовое создание админ-аккаунта (без публичной формы регистрации).
// Запуск: node scripts/create-admin.js <логин> <пароль>
const db = require('../db.js');
const { hashPassword } = require('../auth.js');

const [, , username, password] = process.argv;
if (!username || !password) {
  console.error('Использование: node scripts/create-admin.js <логин> <пароль>');
  process.exit(1);
}

const exists = db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
if (exists) {
  console.error(`Админ "${username}" уже существует (id=${exists.id})`);
  process.exit(1);
}

const info = db.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)')
  .run(username, hashPassword(password), Date.now());
console.log(`Создан админ "${username}" (id=${info.lastInsertRowid})`);
