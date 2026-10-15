// Опрос счётчика импульсов «Пульсар» через тот же прозрачный порт iRZ Collector, что и Меркурий
// (см. mercuryPoll.js) — общая RS-485 шина, поэтому вызывающий код ОБЯЗАН гнать это через тот же
// state.serializeFor(modemId, fn) на стороне server.js, каким уже опрашивается Меркурий. Без
// очереди — коллизия и мусорные ответы на шине (см. живую проверку 22.09.2026, CLAUDE.md).
//
// withSocket/sendAndWait здесь — намеренный дубль транспортных хелперов из mercuryPoll.js, а не
// импорт оттуда: mercury*.js — KEEP AS IS (ADR-02/05), трогать/расширять экспорт нельзя, а сама
// логика (открыть сокет, писать, ждать "тишины" на линии) протокол-агностична и достаточно мала,
// чтобы не заводить ради неё общий модуль.
const net = require('net');
const p = require('./pulsarProtocol.js');

function withSocket(host, port, fn, connectTimeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    const ct = setTimeout(() => { sock.destroy(); reject(new Error('таймаут подключения к порту счётчика')); }, connectTimeoutMs);
    sock.on('connect', () => {
      clearTimeout(ct);
      fn(sock).then(
        r => { sock.destroy(); resolve(r); },
        e => { sock.destroy(); reject(e); }
      );
    });
    sock.on('error', e => { clearTimeout(ct); reject(e); });
  });
}

function sendAndWait(sock, frame, timeoutMs = 8000, settleMs = 300) {
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

// Собственный счётчик ID запросов: протокол возвращает наш ID в ответе, и это ЕДИНСТВЕННЫЙ
// штатный способ убедиться, что пришедший кадр — ответ именно на этот запрос, а не чужой кадр
// с общей шины (см. findFrame в pulsarProtocol.js — без этой сверки живьём прилетали куски
// чужого обмена, декодированные как «версия прошивки 55050» и «диагностика 0x99»).
let reqSeq = 0;
function nextReqId() {
  reqSeq = (reqSeq + 1) & 0xFFFF;
  return Buffer.from([reqSeq & 0xFF, (reqSeq >> 8) & 0xFF]);
}

/**
 * Отправить запрос и дождаться ответа ИМЕННО на него.
 * build — функция (id) => Buffer кадра (любая cmd* из pulsarProtocol).
 * Возвращает разобранный кадр либо null, если своего ответа в окне не было.
 */
async function step(sock, addr, build, settleMs = 300) {
  const id = nextReqId();
  const raw = await sendAndWait(sock, build(id), 8000, settleMs);
  if (!raw) return null;
  return p.findFrame(raw, addr, id);
}

/**
 * Опросить текущие показания каналов прибора «Пульсар».
 * cfg: {host, port, serial, channels} — serial с этикетки прибора (напр. "5015735"),
 * channels — массив каналов 1..N (по умолчанию [1] — задействован только канал 1, см. просьбу
 * пользователя 22.09.2026 начать с одного канала, 2-3 добавятся позже).
 * Бросает исключение при ошибке протокола (F=0x00) или полном отсутствии ответа.
 * Возвращает {values: {1: 0.03, ...}} — значения уже в физических единицах (прибор сам множит
 * на настроенный вес импульса, см. комментарий в pulsarProtocol.js про подтверждённый живьём
 * float32-формат этого конкретного экземпляра).
 */
async function pollPulsar(cfg) {
  const { host, port, serial, channels = [1] } = cfg;
  const addr = p.serialToAddr(serial);
  const mask = p.channelsToMask(channels);
  return withSocket(host, port, async (sock) => {
    const resp = await step(sock, addr, (id) => p.cmdReadCurrent(addr, mask, id), 300);
    if (!resp) throw new Error('нет ответа от Пульсара');
    if (p.isErrorResponse(resp)) throw new Error(`Пульсар отклонил запрос: ${p.errorMessage(resp)}`);
    const values = p.parseChannelValues(resp, mask);
    return { values };
  });
}

/** Вес импульса по каналам — читается редко (при настройке/проверке калибровки), не на каждый
 *  цикл опроса, аналогично readSerial() у Меркурия. */
async function readPulsarWeights(cfg) {
  const { host, port, serial, channels = [1] } = cfg;
  const addr = p.serialToAddr(serial);
  const mask = p.channelsToMask(channels);
  return withSocket(host, port, async (sock) => {
    const resp = await step(sock, addr, (id) => p.cmdReadWeight(addr, mask, id), 300);
    if (!resp) throw new Error('нет ответа от Пульсара');
    if (p.isErrorResponse(resp)) throw new Error(`Пульсар отклонил запрос: ${p.errorMessage(resp)}`);
    return p.parseWeights(resp, mask);
  });
}

/**
 * Живой тест входа (22.09.2026) — частый опрос текущего показания, чтобы при перемыкании клемм
 * вручную было видно, как набегают импульсы.
 * Состояние самого контакта (замкнут/разомкнут) прибор отдавать НЕ УМЕЕТ: F=0x19 на нём
 * отвечает ошибкой «нет такой функции» (проверено живьём, см. cmdTestInputs) — поэтому запрос
 * состояния делается «по возможности» и его отказ не ломает тест, а F=0x09 использовать нельзя
 * (глушит счёт на 200мс и испортил бы сам тест).
 */
async function readPulsarInputTest(cfg) {
  const { host, port, serial, channels = [1] } = cfg;
  const addr = p.serialToAddr(serial);
  const mask = p.channelsToMask(channels);
  return withSocket(host, port, async (sock) => {
    const valResp = await step(sock, addr, (id) => p.cmdReadCurrent(addr, mask, id), 300);
    if (!valResp) throw new Error('нет ответа от Пульсара');
    if (p.isErrorResponse(valResp)) throw new Error(`Пульсар отклонил запрос: ${p.errorMessage(valResp)}`);
    return { inputs: null, values: p.parseChannelValues(valResp, mask) };
  });
}

/**
 * Записать текущее показание канала в прибор (22.09.2026) — «сброс накопленных показаний» (0) и
 * «указать текущие показания» при монтаже (снять цифру с механического счётчика и внести её,
 * чтобы дальше прибор считал от неё). Прибор принимает только float32, см. cmdWriteValue.
 * После записи сразу перечитываем значение: подтверждение маской говорит лишь, что команда
 * принята, а нам важно показать пользователю, что в приборе реально лежит.
 */
async function writePulsarValue(cfg, value) {
  const { host, port, serial, channel = 1 } = cfg;
  const addr = p.serialToAddr(serial);
  const mask = p.channelsToMask([channel]);
  return withSocket(host, port, async (sock) => {
    const resp = await step(sock, addr, (id) => p.cmdWriteValue(addr, channel, value, id), 300);
    if (!resp) throw new Error('нет ответа от Пульсара');
    if (p.isErrorResponse(resp)) throw new Error(`Пульсар отклонил запись: ${p.errorMessage(resp)}`);
    if (!p.parseWriteValueResult(resp, channel)) throw new Error('прибор не подтвердил запись показаний');
    const check = await step(sock, addr, (id) => p.cmdReadCurrent(addr, mask, id), 300);
    const values = check && !p.isErrorResponse(check) ? p.parseChannelValues(check, mask) : null;
    return values ? values[channel] : null;
  });
}

/**
 * Вес импульса канала, КАК ОН ЗАДАН В САМОМ ПРИБОРЕ (22.09.2026). Это главный параметр
 * калибровки: прибор умножает на него импульсы и отдаёт уже готовый объём, поэтому расхождение
 * с тем, что записано в карточке счётчика, означает неверные показания у клиента.
 * Читается из таблицы параметров (штатная команда F=0x07 этим прибором не поддерживается,
 * см. pulsarProtocol.js) и сверяется с pulse_meters.pulse_weight на стороне приложения.
 */
async function readPulsarChannelWeight(cfg) {
  const { host, port, serial, channel = 1 } = cfg;
  const addr = p.serialToAddr(serial);
  const num = p.paramForChannelWeight(channel);
  return withSocket(host, port, async (sock) => {
    const resp = await step(sock, addr, (id) => p.cmdReadParam(addr, num, id), 300);
    if (!resp) throw new Error('нет ответа от Пульсара');
    if (p.isErrorResponse(resp)) throw new Error(`Пульсар отклонил запрос: ${p.errorMessage(resp)}`);
    const raw = p.parseParamRaw(resp);
    return raw ? p.decodeFloat32(raw) : null;
  });
}
/**
 * Записать вес импульса канала в прибор. ОПАСНАЯ операция: неверное значение искажает все
 * последующие показания в кратное число раз (живой инцидент 22.09.2026 — вес 10 вместо 0.01
 * завысил расход в 1000 раз), поэтому вызывающий код обязан спрашивать подтверждение, а не
 * писать «на всякий случай».
 */
async function writePulsarChannelWeight(cfg, weight) {
  const { host, port, serial, channel = 1 } = cfg;
  const addr = p.serialToAddr(serial);
  const num = p.paramForChannelWeight(channel);
  return withSocket(host, port, async (sock) => {
    const resp = await step(sock, addr, (id) => p.cmdWriteParam(addr, num, p.encodeFloat32(weight), id), 300);
    if (!resp) throw new Error('нет ответа от Пульсара');
    if (p.isErrorResponse(resp)) throw new Error(`Пульсар отклонил запись: ${p.errorMessage(resp)}`);
    if (!p.parseWriteParamResult(resp)) throw new Error('запись не подтверждена прибором');
    return true;
  });
}

module.exports = {
  pollPulsar,
  readPulsarWeights,
  readPulsarInputTest,
  readPulsarChannelWeight,
  writePulsarChannelWeight,
  writePulsarValue,
};
