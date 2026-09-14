const net = require('net');
const m = require('./domains/metering/mercuryProtocol.js');
const p = require('./domains/metering/mercuryProfile.js');

const HOST = '147.45.212.205';
const PORT = 35000;
const ADDR = 29;
const PASS = '111111';

function withSocket(fn) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, HOST);
    sock.on('connect', () => fn(sock).then(r => { sock.destroy(); resolve(r); }, e => { sock.destroy(); reject(e); }));
    sock.on('error', e => reject(e));
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
async function step(sock, frame, label) {
  const resp = await sendAndWait(sock, frame);
  const hex = resp ? resp.toString('hex') : 'нет ответа';
  const body = resp ? m.checkResponse(resp) : null;
  console.log(`${label}: запрос=${frame.toString('hex')} ответ=${hex}${body ? ' CRC OK тело=' + body.toString('hex') : (resp ? ' CRC BAD' : '')}`);
  return body;
}

(async () => {
  await withSocket(async (sock) => {
    const conn = await step(sock, m.cmdConnect(ADDR, 1, PASS), 'CONNECT');
    if (!conn || conn[1] !== 0) { console.log('CONNECT FAILED'); return; }

    const lastBody = await step(sock, p.cmdLastRecord(ADDR, false), 'LAST_RECORD');
    const last = lastBody ? p.parseLastRecord(lastBody) : null;
    console.log('lastRecord (fixed byte order):', last);
    if (!last) return;

    console.log('lastAddress mod 16 =', last.lastAddress % 16);

    // Тест A: абсолютное чтение ровно последней записи (15 байт).
    const absBody = await step(sock, p.cmdProfileAbsolute(ADDR, last.lastAddress, 0x0F), 'ABS single record @lastAddress');
    if (absBody) {
      const recs = p.parseProfileRecords(absBody);
      console.log('ABS single ->', JSON.stringify(recs, null, 1));
    }

    // Тест B: ускоренное чтение 17 записей (numBytes=0xFF) начиная с адреса на 16 записей раньше последней.
    const startAddr = (last.lastAddress - 16 * 0x10 + 0x10000) % 0x10000;
    const fastBody = await step(sock, p.cmdProfileAbsolute(ADDR, startAddr, 0xFF), 'ABS fast 17 records');
    if (fastBody) {
      const recs = p.parseProfileRecords(fastBody);
      console.log(`ABS fast -> ${recs.length} records`);
      const A = 500;
      for (const r of recs) {
        const conv = p.recordToPower(r, A);
        console.log(`${String(r.time.dd).padStart(2,'0')}.${String(r.time.MM).padStart(2,'0')}.${r.time.yy} ${String(r.time.hh).padStart(2,'0')}:${String(r.time.mm).padStart(2,'0')} T=${r.periodMin} P+=${conv.energyKwh.pPlus?.toFixed(4)}кВт*ч incomplete=${r.incomplete}`);
      }
    }

    // Тест C: 16h относительная адресация ещё раз, с более длинным ожиданием ответа.
    const relBody = await step(sock, p.cmdProfileRelative(ADDR, 3, 1, 15), 'REL offset=1 len=15');
    if (relBody) console.log('REL ->', JSON.stringify(p.parseProfileRecords(relBody)));
  });
  process.exit(0);
})();
