// Ограничение частоты попыток входа (P0-03, RECONCILIATION/04_RISK_REGISTER.md R-02) — защита
// /api/login от перебора пароля. Отдельный модуль, не трогает auth.js (сессии/bcrypt) — считает
// попытки ДО обращения к ним и просто отказывает в самой попытке, если лимит уже исчерпан.
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 минут

// Потолок на общее число ОДНОВРЕМЕННО отслеживаемых пар (ip, логин) — без него атакующий мог
// бы раздувать память процесса потоком запросов с разным логином на каждую попытку (сам
// rate-limit по (ip, логин) тут не защищает: у каждой такой попытки СВОЙ, новый ключ, значит
// эта конкретная попытка никогда не будет заблокирована лимитом сама по себе — обнаружено при
// pre-commit ревью P0-03, не было в первой версии). При достижении потолка перед вставкой новой
// записи вытесняется самая старая (Map хранит порядок вставки, `keys().next().value` — O(1)) —
// не "самая виноватая", а просто самая давняя, этого достаточно, чтобы держать структуру
// ограниченной.
const MAX_TRACKED_KEYS = 5000;

const attempts = new Map(); // `${ip}:${login}` -> [timestamps неудачных попыток]

function key(ip, username) {
  return `${ip}:${String(username || '').toLowerCase()}`;
}

/**
 * true = попытку можно делать (лимит не исчерпан). Только ЧИТАЕТ состояние — в отличие от
 * первой версии этой функции, не создаёт запись в Map сама по себе (это и была реальная дыра:
 * до этой правки просто ВЫЗОВ checkAllowed для ещё не встречавшейся пары уже добавлял в Map
 * пустую запись, то есть рост Map не требовал вообще ни одной неудачной попытки).
 */
function checkAllowed(ip, username) {
  const k = key(ip, username);
  const list = attempts.get(k);
  if (!list) return true;
  const fresh = list.filter((ts) => Date.now() - ts < WINDOW_MS);
  if (fresh.length === 0) { attempts.delete(k); return true; }
  attempts.set(k, fresh);
  return fresh.length < MAX_ATTEMPTS;
}

/** Зовётся после неверного логина/пароля — засчитывает попытку в счётчик. Единственное место,
 *  создающее НОВУЮ запись в Map — здесь же применяется потолок MAX_TRACKED_KEYS. */
function recordFailure(ip, username) {
  const k = key(ip, username);
  const now = Date.now();
  const isNewKey = !attempts.has(k);
  const list = (attempts.get(k) || []).filter((ts) => now - ts < WINDOW_MS);
  list.push(now);
  if (isNewKey && attempts.size >= MAX_TRACKED_KEYS) {
    const oldestKey = attempts.keys().next().value;
    if (oldestKey !== undefined) attempts.delete(oldestKey);
  }
  attempts.set(k, list);
}

/** Зовётся после успешного входа — сбрасывает счётчик для этой пары (ip, логин). */
function recordSuccess(ip, username) {
  attempts.delete(key(ip, username));
}

// Периодическая уборка — доп. защита от накопления записей, чей список уже опустел между
// вызовами (checkAllowed теперь и сам чистит пустые записи при чтении, но давно неактивная
// пара, к которой никто не обращается вообще, иначе висела бы в Map бесконечно).
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of attempts) {
    const fresh = list.filter((ts) => now - ts < WINDOW_MS);
    if (fresh.length === 0) attempts.delete(k);
    else attempts.set(k, fresh);
  }
}, 60 * 60 * 1000);

module.exports = { checkAllowed, recordFailure, recordSuccess, MAX_ATTEMPTS, WINDOW_MS, MAX_TRACKED_KEYS };
