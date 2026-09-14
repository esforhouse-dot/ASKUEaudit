// Живой тест чтения профиля средних мощностей (почасовки/получасовки) на реальном счётчике.
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

    const variantBody = await step(sock, p.cmdVariant(ADDR), 'VARIANT');
    const variant = variantBody ? p.parseVariant(variantBody) : null;
    console.log('variant:', variant);

    const lastBody = await step(sock, p.cmdLastRecord(ADDR, false), 'LAST_RECORD(main,13h)');
    const last = lastBody ? p.parseLastRecord(lastBody) : null;
    console.log('lastRecord:', last);

    // Последние 4 записи профиля (память №3), относительная адресация: offset=0 (последняя), len=4*15=60 байт.
    const profBody = await step(sock, p.cmdProfileRelative(ADDR, 3, 0, 60), 'PROFILE_REL(mem3,offset0,len60)');
    if (profBody) {
      const records = p.parseProfileRecords(profBody);
      console.log(`records=${records.length}`);
      const A = variant?.meterConstant;
      for (const r of records) {
        const conv = A ? p.recordToPower(r, A) : null;
        console.log(
          `${String(r.time.dd).padStart(2, '0')}.${String(r.time.MM).padStart(2, '0')}.${r.time.yy} ` +
          `${String(r.time.hh).padStart(2, '0')}:${String(r.time.mm).padStart(2, '0')} T=${r.periodMin}мин ` +
          `raw(P+,P-,Q+,Q-)=${r.raw.pPlus},${r.raw.pMinus},${r.raw.qPlus},${r.raw.qMinus} ` +
          (conv ? `=> P+=${conv.powerKw.pPlus?.toFixed(3)}кВт E+=${conv.energyKwh.pPlus?.toFixed(4)}кВт*ч` : '')
        );
      }
    }
  });
  process.exit(0);
})();
