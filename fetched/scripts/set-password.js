// Смена пароля существующего аккаунта.
// Запуск: node scripts/set-password.js <admin|user> <логин> <новый_пароль>
const db = require('../db.js');
const { hashPassword } = require('../auth.js');

const [, , role, username, password] = process.argv;
if (!['admin', 'user'].includes(role) || !username || !password) {
  console.error('Использование: node scripts/set-password.js <admin|user> <логин> <новый_пароль>');
  process.exit(1);
}
const table = role === 'admin' ? 'admins' : 'users';
const row = db.prepare(`SELECT id FROM ${table} WHERE username = ?`).get(username);
if (!row) { console.error(`${role} "${username}" не найден`); process.exit(1); }
db.prepare(`UPDATE ${table} SET password_hash = ? WHERE id = ?`).run(hashPassword(password), row.id);
console.log(`Пароль обновлён для ${role} "${username}"`);
