// Опрос профиля средних мощностей (получасовки) — назад от текущего момента через 16h
// (относительная адресация), ПО ОДНОЙ записи за раз (len=15). Большие 16h-запросы ненадёжны
// (не отвечают вовсе), но по одной записи работает стабильно — подтверждено живым тестом
// (см. память irz-mercury-profile). Адрес "последней записи" (13h) НЕ используется — его поле
// адреса на практике может указывать на устаревшие данные (подтверждено дважды на реальном
// счётчике), поэтому весь механизм построен без доверия к нему: "новое" определяется тем, что
// вызывающий код (server.js) ещё не видел эту дату+слот в своей БД (alreadyHave), а не адресом.
//
// Один и тот же алгоритм годится и для ПЕРВОЙ полной догрузки истории (alreadyHave всегда
// false — идём вглубь, пока не упрёмся в разрыв непрерывности), и для обычного периодического
// опроса (alreadyHave почти сразу вернёт true на 1-2 записи — мы всё остальное уже видели).
const net = require('net');
const m = require('./mercuryProtocol.js');
const p = require('./mercuryProfile.js');

function withSocket(host, port, fn, connectTimeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const ct = setTimeout(() => { sock.destroy(); reject(new Error('таймаут подключения к порту счётчика')); }, connectTimeoutMs);
    sock.on('connect', () => {
      clearTimeout(ct);
      fn(sock).then(r => { sock.destroy(); resolve(r); }, e => { sock.destroy(); reject(e); });
    });
    sock.on('error', e => { clearTimeout(ct); reject(e); });
  });
}
function sendAndWait(sock, frame, timeoutMs = 8000, settleMs = 900) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let settleTimer = null;
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, settleMs);
    };
    const hardTimer = setTimeout(finish, timeoutMs);
    function finish() {
      clearTimeout(hardTimer);
      if (settleTimer) clearTimeout(settleTimer);
      sock.removeListener('data', onData);
      resolve(buf.length ? buf : null);
    }
    sock.on('data', onData);
    sock.write(frame);
  });
}
async function step(sock, frame, settleMs = 900) {
  const resp = await sendAndWait(sock, frame, 8000, settleMs);
  if (!resp) return null;
  return m.checkResponse(resp);
}

// Перечитывания ОДНОГО И ТОГО ЖЕ смещения. Раньше здесь был счётчик подряд идущих промахов, а
// сам промах обрабатывался через `continue` — то есть смещение ПРОПУСКАЛОСЬ. Это гарантированно
// ломало обход: следующая прочитанная запись оказывалась старше предыдущей на два периода, не
// проходила проверку непрерывности, и обход вставал с 'discontinuity'. До счётчика промахов дело
// просто не доходило. Один неотвеченный запрос при заторе на общей шине = ложный разрыв истории
// (5 сент: шесть параллельных дозаполнений встали на 21-32% глубины, тот же прибор в одиночку
// прошёл вдвое глубже, а вторым проходом — ещё глубже).
const READ_RETRIES = 3;         // сколько раз перечитать смещение, прежде чем считать неотвеченным
const CONTINUITY_RETRIES = 2;   // перечитываний перед вердиктом «настоящий разрыв истории»
const RETRY_SETTLE_MS = 600;    // на повторе ждём дольше: при заторе короткий ответ приходит позже

// Одна запись профиля по относительному смещению. Ответ на 16h с len=15 — короткая фиксированная
// запись (18 байт), тот же случай, что и чтение записи журнала (04h): settle 200мс достаточно,
// дефолтные 900мс рассчитаны на пакетную многозаписевую выгрузку и здесь теряют время впустую
// (критично при первой догрузке истории — тысячи записей на счётчик).
async function readRecordAt(sock, addr, offset, settleMs) {
  const body = await step(sock, p.cmdProfileRelative(addr, 3, offset, 15), settleMs);
  const recs = body ? p.parseProfileRecords(body) : [];
  return recs[0] || null;
}

/**
 * cfg: {host, port, addr, password}
 * opts: { alreadyHave(date, slot) => bool, maxRecords, onProgress(offset, recordsFound) }
 * Возвращает { meterConstant, records: [{date,slot,kwh,incomplete}], stopReason, offsetsRead }.
 * stopReason: 'caught-up' (обычный опрос, дошли до уже известного) | 'discontinuity' (разрыв —
 * дальше не настоящая непрерывная история) | 'max-records' (упёрлись в лимит) | 'no-response'.
 */
async function pollProfile(cfg, opts = {}) {
  const { alreadyHave = () => false, maxRecords = 200, onProgress } = opts;
  const { host, port, addr, password } = cfg;
  return withSocket(host, port, async (sock) => {
    const conn = await step(sock, m.cmdConnect(addr, 1, password));
    if (!conn || conn.length < 2 || conn[1] !== 0x00) {
      throw new Error(conn ? `авторизация отклонена (код ${conn[1]})` : 'нет ответа на авторизацию');
    }
    const variantBody = await step(sock, p.cmdVariant(addr));
    const variant = variantBody ? p.parseVariant(variantBody) : null;
    const meterConstant = variant ? variant.meterConstant : null;
    if (!meterConstant) throw new Error('не удалось прочитать постоянную счётчика (вариант исполнения)');

    const records = [];
    let prev = null;
    let stopReason = 'ok';
    let offset = 0;
    for (; offset < maxRecords; offset++) {
      let rec = null;
      for (let attempt = 0; attempt <= READ_RETRIES && !rec; attempt++) {
        rec = await readRecordAt(sock, addr, offset, attempt === 0 ? 200 : RETRY_SETTLE_MS);
      }
      if (!rec) { stopReason = 'no-response'; break; }
      // Разрыв непрерывности обрывает ВЕСЬ обход, поэтому выносить его по одному ответу нельзя:
      // при заторе короткий ответ может прийти усечённым и разобраться как запись с чужой меткой
      // времени. Перечитываем то же смещение с увеличенным settle и верим только устойчивому
      // расхождению — настоящий разрыв воспроизведётся, случайный мусор нет.
      if (prev && !p.isNextPeriod(rec.time, prev.time, prev.periodMin)) {
        for (let r = 0; r < CONTINUITY_RETRIES; r++) {
          const again = await readRecordAt(sock, addr, offset, RETRY_SETTLE_MS);
          if (!again) continue;
          rec = again;
          if (p.isNextPeriod(rec.time, prev.time, prev.periodMin)) break;
        }
      }
      if (prev && !p.isNextPeriod(rec.time, prev.time, prev.periodMin)) { stopReason = 'discontinuity'; break; }
      const { date, slot } = p.recordDateSlot(rec.time);
      if (alreadyHave(date, slot)) { stopReason = 'caught-up'; break; }
      const conv = p.recordToPower(rec, meterConstant);
      records.push({ date, slot, kwh: conv.energyKwh.pPlus, incomplete: rec.incomplete });
      prev = rec;
      if (onProgress) onProgress(offset + 1, records.length);
    }
    if (offset >= maxRecords) stopReason = 'max-records';
    return { meterConstant, records, stopReason, offsetsRead: offset };
  }, 8000);
}

module.exports = { pollProfile };
