// Разовая миграция текущего единственного модема/счётчика в новую схему (проект+пользователь).
// Запуск: node scripts/migrate-to-multitenant.js [логин] [пароль]
// Без аргументов — логин "demo", пароль генерируется и выводится в консоль.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db.js');
const { hashPassword } = require('../auth.js');

const MODEM_IMEI = '866755082441009';
const METER_ADDR = 29;
const METER_PASSWORD = '111111';

const [, , argUsername, argPassword] = process.argv;
const username = argUsername || 'demo';
const password = argPassword || crypto.randomBytes(6).toString('base64url');

let meterConstant = null;
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mercury', 'mercury-profile.json'), 'utf8'));
  meterConstant = cfg.meterConstant || null;
} catch {}

const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (existingUser) {
  console.error(`Пользователь "${username}" уже существует (id=${existingUser.id}) — миграция уже выполнена?`);
  process.exit(1);
}

const now = Date.now();
const tx = db.transaction(() => {
  const project = db.prepare('INSERT INTO projects (name, created_at) VALUES (?, ?)')
    .run('Демо-объект', now);
  const projectId = project.lastInsertRowid;

  db.prepare('INSERT INTO users (username, password_hash, project_id, created_at) VALUES (?, ?, ?, ?)')
    .run(username, hashPassword(password), projectId, now);

  const modem = db.prepare('INSERT INTO modems (project_id, imei, label, created_at) VALUES (?, ?, ?, ?)')
    .run(projectId, MODEM_IMEI, 'iRZ ATM42.B', now);
  const modemId = modem.lastInsertRowid;

  db.prepare(`INSERT INTO meters (modem_id, addr, password, label, meter_constant, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(modemId, METER_ADDR, METER_PASSWORD, 'Меркурий 234', meterConstant, now);

  return projectId;
});

const projectId = tx();
console.log(`Готово: проект #${projectId} "Демо-объект", модем ${MODEM_IMEI}, счётчик addr=${METER_ADDR}.`);
console.log(`Логин пользователя: ${username}`);
console.log(`Пароль: ${password}`);
