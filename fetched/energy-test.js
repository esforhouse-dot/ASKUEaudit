// Тест команды 0x05 (накопленная энергия) на живом счётчике.
const net = require('net');
const m = require('./domains/metering/mercuryProtocol.js');

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
function sendAndWait(sock, frame, timeoutMs = 8000, settleMs = 1000) {
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

    for (const [label, tariff] of [['СУММА', 0], ['T1', 1], ['T2', 2], ['T3', 3], ['T4', 4]]) {
      const body = await step(sock, m.cmdEnergy(ADDR, 0x0, tariff), `ENERGY ${label} (от сброса)`);
      if (body) {
        const e = m.parseEnergy16(body);
        console.log(`  ${label}: A+ =${(e.aPlus/1000).toFixed(3)} кВт*ч  A- =${(e.aMinus/1000).toFixed(3)} кВт*ч  R+ =${(e.rPlus/1000).toFixed(3)} квар*ч  R- =${(e.rMinus/1000).toFixed(3)} квар*ч`);
      }
    }
  });
  process.exit(0);
})();
