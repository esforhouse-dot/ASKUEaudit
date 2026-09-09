// Авторизация: bcrypt-хэши паролей + свои сессии в SQLite (без express-session — см. план,
// в проекте и так все протоколы написаны руками, лишняя зависимость ни к чему).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db.js');

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 дней
const COOKIE_NAME = 'askue_sid';

function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }
function verifyPassword(pw, hash) { return bcrypt.compareSync(pw, hash); }

function createSession(role, actorId, projectId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (token, role, actor_id, project_id, impersonating_project_id, created_at, expires_at)
              VALUES (?, ?, ?, ?, NULL, ?, ?)`)
    .run(token, role, actorId, projectId ?? null, now, now + SESSION_TTL_MS);
  return token;
}
function getSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); return null; }
  return row;
}
function destroySession(token) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); }
function setImpersonation(token, projectId) {
  db.prepare('UPDATE sessions SET impersonating_project_id = ? WHERE token = ?').run(projectId, token);
}
function clearImpersonation(token) {
  db.prepare('UPDATE sessions SET impersonating_project_id = NULL WHERE token = ?').run(token);
}

function parseCookies(req) {
  const h = req.headers.cookie;
  if (!h) return {};
  const out = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}
function setCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

// Пути, доступные без авторизации.
const PUBLIC_PATHS = new Set(['/login.html', '/api/login']);

function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  const session = getSession(token);
  if (!session) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'не авторизован' });
    return res.redirect('/login.html');
  }
  req.sessionToken = token;
  req.actor = session;
  if (session.role === 'admin' && session.impersonating_project_id) {
    req.projectId = session.impersonating_project_id;
    req.isImpersonating = true;
  } else if (session.role === 'user') {
    req.projectId = session.project_id;
    // Роль внутри проекта (master/limited) + срок доступа — см. db.js. Читаем на каждый запрос
    // (не кэшируем в самой сессии), чтобы смена роли/срока админом применялась немедленно, а не
    // только на следующий логин.
    const userRow = db.prepare('SELECT access_role, access_until FROM users WHERE id = ?').get(session.actor_id);
    if (!userRow || (userRow.access_until && userRow.access_until < Date.now())) {
      destroySession(token);
      clearCookie(res);
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'доступ истёк' });
      return res.redirect('/login.html');
    }
    req.accessRole = userRow.access_role;
  } else {
    req.projectId = null; // админ вне имперсонации — своего проекта нет
  }
  next();
}
function requireAdmin(req, res, next) {
  if (!req.actor || req.actor.role !== 'admin') {
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'только для администратора' });
    return res.redirect('/login.html');
  }
  next();
}
function requireProject(req, res, next) {
  if (!req.projectId) {
    if (req.path.startsWith('/api/')) return res.status(400).json({ error: 'нет активного проекта' });
    return res.redirect(req.actor && req.actor.role === 'admin' ? '/admin.html' : '/login.html');
  }
  next();
}
// Роль «Пользователь» (access_role='limited') — только чтение даже внутри разрешённого ей
// раздела «Объекты»: платформенный admin (в т.ч. в имперсонации) и project-пользователь с ролью
// 'master' проходят, 'limited' — нет. Отдельно от общего гейта на /api/objects/* в server.js —
// тот решает «пускать ли в раздел вообще», этот — «можно ли внутри него что-то менять».
function requireMaster(req, res, next) {
  if (req.actor && req.actor.role === 'user' && req.accessRole === 'limited') {
    return res.status(403).json({ error: 'недостаточно прав' });
  }
  next();
}

module.exports = {
  hashPassword, verifyPassword,
  createSession, getSession, destroySession, setImpersonation, clearImpersonation,
  parseCookies, setCookie, clearCookie,
  requireAuth, requireAdmin, requireProject, requireMaster,
  COOKIE_NAME,
};
