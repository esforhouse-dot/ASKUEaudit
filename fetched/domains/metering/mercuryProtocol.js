/**
 * Протокол обмена со счётчиками Меркурий 203.2TD, 204, 208, 230, 231, 234, 236, 238 по RS-485.
 * Формат: [Адрес 1 байт][Команда...][CRC16 младший][CRC16 старший].
 * CRC16 — MODBUS (стандартная таблица).
 */

const CRC16_TABLE = new Uint16Array([
  0x0000, 0xC0C1, 0xC181, 0x0140, 0xC301, 0x03C0, 0x0280, 0xC241,
  0xC601, 0x06C0, 0x0780, 0xC741, 0x0500, 0xC5C1, 0xC481, 0x0440,
  0xCC01, 0x0CC0, 0x0D80, 0xCD41, 0x0F00, 0xCFC1, 0xCE81, 0x0E40,
  0x0A00, 0xCAC1, 0xCB81, 0x0B40, 0xC901, 0x09C0, 0x0880, 0xC841,
  0xD801, 0x18C0, 0x1980, 0xD941, 0x1B00, 0xDBC1, 0xDA81, 0x1A40,
  0x1E00, 0xDEC1, 0xDF81, 0x1F40, 0xDD01, 0x1DC0, 0x1C80, 0xDC41,
  0x1400, 0xD4C1, 0xD581, 0x1540, 0xD701, 0x17C0, 0x1680, 0xD641,
  0xD201, 0x12C0, 0x1380, 0xD341, 0x1100, 0xD1C1, 0xD081, 0x1040,
  0xF001, 0x30C0, 0x3180, 0xF141, 0x3300, 0xF3C1, 0xF281, 0x3240,
  0x3600, 0xF6C1, 0xF781, 0x3740, 0xF501, 0x35C0, 0x3480, 0xF441,
  0x3C00, 0xFCC1, 0xFD81, 0x3D40, 0xFF01, 0x3FC0, 0x3E80, 0xFE41,
  0xFA01, 0x3AC0, 0x3B80, 0xFB41, 0x3900, 0xF9C1, 0xF881, 0x3840,
  0x2800, 0xE8C1, 0xE981, 0x2940, 0xEB01, 0x2BC0, 0x2A80, 0xEA41,
  0xEE01, 0x2EC0, 0x2F80, 0xEF41, 0x2D00, 0xEDC1, 0xEC81, 0x2C40,
  0xE401, 0x24C0, 0x2580, 0xE541, 0x2700, 0xE7C1, 0xE681, 0x2640,
  0x2200, 0xE2C1, 0xE381, 0x2340, 0xE101, 0x21C0, 0x2080, 0xE041,
  0xA001, 0x60C0, 0x6180, 0xA141, 0x6300, 0xA3C1, 0xA281, 0x6240,
  0x6600, 0xA6C1, 0xA781, 0x6740, 0xA501, 0x65C0, 0x6480, 0xA441,
  0x6C00, 0xACC1, 0xAD81, 0x6D40, 0xAF01, 0x6FC0, 0x6E80, 0xAE41,
  0xAA01, 0x6AC0, 0x6B80, 0xAB41, 0x6900, 0xA9C1, 0xA881, 0x6840,
  0x7800, 0xB8C1, 0xB981, 0x7940, 0xBB01, 0x7BC0, 0x7A80, 0xBA41,
  0xBE01, 0x7EC0, 0x7F80, 0xBF41, 0x7D00, 0xBDC1, 0xBC81, 0x7C40,
  0xB401, 0x74C0, 0x7580, 0xB541, 0x7700, 0xB7C1, 0xB681, 0x7640,
  0x7200, 0xB2C1, 0xB381, 0x7340, 0xB101, 0x71C0, 0x7080, 0xB041,
  0x5000, 0x90C1, 0x9181, 0x5140, 0x9301, 0x53C0, 0x5280, 0x9241,
  0x9601, 0x56C0, 0x5780, 0x9741, 0x5500, 0x95C1, 0x9481, 0x5440,
  0x9C01, 0x5CC0, 0x5D80, 0x9D41, 0x5F00, 0x9FC1, 0x9E81, 0x5E40,
  0x5A00, 0x9AC1, 0x9B81, 0x5B40, 0x9901, 0x59C0, 0x5880, 0x9841,
  0x8801, 0x48C0, 0x4980, 0x8941, 0x4B00, 0x8BC1, 0x8A81, 0x4A40,
  0x4E00, 0x8EC1, 0x8F81, 0x4F40, 0x8D01, 0x4DC0, 0x4C80, 0x8C41,
  0x4400, 0x84C1, 0x8581, 0x4540, 0x8701, 0x47C0, 0x4680, 0x8641,
  0x8201, 0x42C0, 0x4380, 0x8341, 0x4100, 0x81C1, 0x8081, 0x4040
]);

function crc16MODBUS(buf) {
  let crc = 0xFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC16_TABLE[(crc ^ buf[i]) & 0xFF];
  }
  return crc;
}

/**
 * Собрать кадр запроса: адрес + команда + CRC16.
 */
function buildRequest(addr, cmd) {
  const head = Buffer.allocUnsafe(1 + cmd.length);
  head[0] = addr & 0xFF;
  for (let i = 0; i < cmd.length; i++) head[1 + i] = cmd[i];
  const crc = crc16MODBUS(head);
  const frame = Buffer.allocUnsafe(head.length + 2);
  head.copy(frame, 0);
  frame[head.length] = crc & 0xFF;
  frame[head.length + 1] = (crc >>> 8) & 0xFF;
  return frame;
}

/**
 * Пароль: 6 байт (цифры 0–9). По умолчанию "000000" или "111111".
 */
function passwordToBytes(password) {
  const s = String(password || '000000').replace(/\D/g, '0').padEnd(6, '0').slice(0, 6);
  return Array.from(s).map(c => Math.max(0, Math.min(9, parseInt(c, 10))));
}

/** Команда поиска/проверки: 0x00 */
function cmdPing(addr) {
  return buildRequest(addr, [0x00]);
}

/** Команда входа (уровень 1 или 2, пароль 6 цифр) */
function cmdConnect(addr, level, password) {
  const bytes = passwordToBytes(password);
  return buildRequest(addr, [0x01, level, bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]]);
}

/** Команда чтения: 0x08 0x16 sub (и опционально 0x08 0x11 sub) */
function cmdRead(addr, sub) {
  return buildRequest(addr, [0x08, 0x16, sub]);
}

function cmdRead11(addr, sub) {
  return buildRequest(addr, [0x08, 0x11, sub]);
}

/** Проверка CRC ответа и возврат тела (без 2 байт CRC) */
function checkResponse(buf) {
  if (buf.length < 3) return null;
  const body = buf.subarray(0, buf.length - 2);
  const crcGot = buf[buf.length - 2] | (buf[buf.length - 1] << 8);
  const crcCalc = crc16MODBUS(body);
  if (crcGot !== crcCalc) return null;
  return body;
}

/** Разбор 4 значений по 4 байта (младший в начале), делённых на 100; первый байт может содержать флаги */
function parse4x4(body, div = 100) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const o = 1 + i * 4;
    const v = (body[o + 3] & 0x3F) | (body[o + 2] << 8) | (body[o + 1] << 16);
    out.push(v / div);
  }
  return out;
}

/** Разбор 3 значений напряжения (по 2 байта, *0.01) — отдельные запросы по 0x11, 0x12, 0x13 */
function parseVoltage2(body) {
  if (body.length < 4) return null;
  return ((body[3] << 8) | body[2]) * 0.01;
}

/** Разбор частоты: 2 байта данных (body[2], body[3]&0x3F), /100 */
function parseFrequency(body) {
  if (body.length < 4) return null;
  return ((body[3] & 0x3F) << 8 | body[2]) / 100;
}

/** Разбор температуры: один байт body[2] */
function parseTemperature(body) {
  if (body.length < 3) return null;
  return body[2];
}

/**
 * Команда 0x05 — запрос накопленной энергии (источники: официальный блог поддержки Incotex
 * incotex-support.blogspot.com/2016/05/230.html, независимо подтверждено PHP-реализацией
 * github.com/flystyle/Mercury230, оба сходятся на одном порядке байт).
 * period: 0x0 = «от сброса» (полное накопленное значение, самое полезное), 0x1=текущий год,
 * 0x2=прошлый год, 0x3=месяц (тогда month 1-12 в младшем полубайте), 0x4=текущие сутки,
 * 0x5=прошлые сутки, 0x9-0xD = значения НА НАЧАЛО периода.
 * tariff: 0 = сумма по всем тарифам, 1-4 = тариф T1-T4, 5 = технические потери.
 */
function cmdEnergy(addr, period, tariff, month) {
  const periodMonth = ((period & 0x0F) << 4) | ((month || 0) & 0x0F);
  return buildRequest(addr, [0x05, periodMonth, tariff & 0x0F]);
}

/**
 * Разбор ответа на 0x05: 16 байт данных = 4 значения по 4 байта, в порядке
 * А+ (актив. прямая), А- (актив. обратная), R+ (реактив. прямая), R- (реактив. обратная).
 * Порядок байт внутри каждого значения — «2-й байт, 1-й байт, 4-й байт, 3-й байт»
 * (подтверждено обоими источниками). Разрешающая способность 1 Вт·ч / 1 вар·ч —
 * делить на 1000 для кВт·ч / квар·ч.
 */
function parseEnergy16(body) {
  if (body.length < 17) return null;
  const vals = [];
  for (let i = 0; i < 4; i++) {
    const o = 1 + i * 4;
    const b0 = body[o], b1 = body[o + 1], b2 = body[o + 2], b3 = body[o + 3];
    const v = ((b1 << 24) | (b0 << 16) | (b3 << 8) | b2) >>> 0;
    // 0xFFFFFFFF — "регистр не задействован" (напр. обратная энергия на однонаправленном
    // счётчике), не настоящее значение — показывать как null, а не 4294967.295.
    vals.push(v === 0xFFFFFFFF ? null : v);
  }
  return { aPlus: vals[0], aMinus: vals[1], rPlus: vals[2], rMinus: vals[3] };
}

/**
 * Параметр 16h, расширение A0h — сводное чтение мгновенных величин ("чтение вспомогательных
 * параметров" по протоколу INCOTEX): в ОДНОМ ответе сразу P/Q/S (сумма+3 фазы), напряжения,
 * межфазные углы, токи, cosφ (сумма+3 фазы), частота — вместо отдельных команд на каждую
 * величину (те по отдельности либо не проверены, либо давали в разборе неверный формат —
 * см. память irz-mercury-poll, разбор "космического" тока на объекте Capitalservis 26 авг).
 * Раскладка (данные без адреса, до необязательных гармоник/температуры в хвосте):
 *  0..11  P  (сумма,A,B,C — по 3 байта)      36..44 U (A,B,C — по 3 байта)
 *  12..23 Q  (сумма,A,B,C)                    45..53 межфазные углы (не используем)
 *  24..35 S  (сумма,A,B,C)                    54..62 I (A,B,C, без суммы — берётся счётчиком
 *  63..74 cosφ (сумма,A,B,C)                          отдельно по каждой фазе)
 *  75..77 частота (одно значение)
 * Проверено живьём (26 авг, объект Capitalservis, adr=41): P1≈112.07 Вт при независимо
 * посчитанном U1·I1·cosφ1≈233.77·0.544·0.882≈112.15 Вт — сходится с точностью до десятых.
 */
function cmdInstant(addr) {
  return buildRequest(addr, [0x08, 0x16, 0xA0]);
}
/** Один 3-байтный слот: младшие 4 бита 1-го байта — старшая часть значения (биты16-19),
 *  3-й байт — средняя часть (биты8-15), 2-й байт — младшая часть (биты0-7). Верхние 4 бита
 *  1-го байта — не значение (флаги/резерв), в значение не входят. */
function val3(b0, b1, b2) {
  return ((b0 & 0x0F) << 16) | (b2 << 8) | b1;
}
function parseInstant(body) {
  if (!body || body.length < 1 + 78) return null;
  const d = body.subarray(1); // без адреса; статусного байта в этом типе ответа нет
  const g = (off) => val3(d[off], d[off + 1], d[off + 2]);
  const four = (off) => ({ sum: g(off), A: g(off + 3), B: g(off + 6), C: g(off + 9) });
  const three = (off) => ({ A: g(off), B: g(off + 3), C: g(off + 6) });
  const p = four(0), q = four(12), s = four(24), u = three(36), i = three(54), pf = four(63);
  const freq = g(75);
  // Сырое значение P/Q/S — Вт (не кВт, несмотря на похожий на прежний код делитель 100 —
  // подтверждено сверкой с U·I·cosφ, см. коммент выше), поэтому /100000 сразу до кВт.
  const kw = (v) => v / 100000;
  return {
    power:   { A: kw(p.A), B: kw(p.B), C: kw(p.C), total: kw(p.sum) },
    powerQ:  { A: kw(q.A), B: kw(q.B), C: kw(q.C), total: kw(q.sum) },
    powerS:  { A: kw(s.A), B: kw(s.B), C: kw(s.C), total: kw(s.sum) },
    voltage: { A: u.A / 100, B: u.B / 100, C: u.C / 100 },
    current: { A: i.A / 1000, B: i.B / 1000, C: i.C / 1000, total: (i.A + i.B + i.C) / 1000 },
    powerFactor: { A: pf.A / 1000, B: pf.B / 1000, C: pf.C / 1000, total: pf.sum / 1000 },
    frequency: freq / 100,
  };
}

// Коды подкоманд (0x08 0x16 xx / 0x08 0x11 xx)
const CMD = {
  POWER_P: 0x00,
  POWER_Q: 0x04,
  POWER_S: 0x08,
  POWER_FACTOR: 0x30,
  VOLTAGE_A: 0x11,
  VOLTAGE_B: 0x12,
  VOLTAGE_C: 0x13,
  CURRENT: 0x21,
  ENERGY_TOTAL_AR: 0x40,
  ENERGY_TOTAL_F: 0x44,
  FREQUENCY: 0x40,
  TEMPERATURE: 0x70
};

/**
 * Параметр 00h — серийный номер и дата выпуска. Единственная команда протокола, которая
 * читается БЕЗ открытия канала связи (без cmdConnect) — доступна сразу после подключения сокета.
 * ВАЖНО: байты здесь — НЕ "2/10 код" (не нибл-BCD, как в записях профиля/времени), а прямое
 * десятичное ЗНАЧЕНИЕ байта (0x5A=90, а не "5A"); серийный номер — конкатенация 4 таких пар как
 * строка. Подтверждено официальным примером протокола: байты "29 5A 40 43" → серийный
 * "41906467" (0x29=41,0x5A=90,0x40=64,0x43=67 → "41"+"90"+"64"+"67"); дата "16 06 14" →
 * 22.06.2020 (0x16=22,0x06=6,0x14=20) — нибл-BCD дал бы другие (неверные) числа в обоих случаях.
 */
function cmdSerial(addr) {
  return buildRequest(addr, [0x08, 0x00]);
}
function parseSerial(body) {
  if (!body || body.length < 8) return null;
  const serial = Array.from(body.subarray(1, 5)).map(b => String(b).padStart(2, '0')).join('');
  return { serial, manufactureDay: body[5], manufactureMonth: body[6], manufactureYear: 2000 + body[7] };
}

/**
 * Параметр 2Fh, расширение 00h — массив ЗАФИКСИРОВАННЫХ (текущих) событий/тревог счётчика.
 * Формат ответа: адрес(1) + массив флагов событий(4 байта: старшее слово, затем младшее;
 * внутри каждого слова младший байт первым) + резерв(12 байт). Старшее слово в этой версии
 * протокола целиком зарезервировано — значимые флаги только в младшем.
 */
function cmdEventFlags(addr) {
  return buildRequest(addr, [0x08, 0x2F, 0x00]);
}
const EVENT_BIT_NAMES = {
  0: 'selfDiagnostics', 1: 'powerOutage', 2: 'powerQualityEvent', 3: 'magneticField',
  4: 'terminalCoverOpen', 5: 'caseOpen', 6: 'powerLimitExceeded', 7: 'maxCurrentRelay',
  8: 'magneticRelay', 9: 'maxVoltageRelay', 10: 'currentImbalanceRelay', 11: 'temperatureRelay',
  12: 'inputStateChanged', 13: 'programmingLogEvent', 14: 'currentImbalanceLimitExceeded', 15: 'reserved15',
};
function parseEventFlags(body) {
  if (!body || body.length < 5) return null;
  const lowWord = body[3] | (body[4] << 8);
  const flags = {};
  for (let bit = 0; bit <= 15; bit++) flags[EVENT_BIT_NAMES[bit]] = !!((lowWord >> bit) & 1);
  return flags;
}
/** {key: bool} -> 16-битная маска (тот же порядок бит, что и parseEventFlags) — для сравнения
 *  «текущие флаги» с сохранённым на своей стороне «подтверждённые флаги» (server.js). */
function eventsToBitmask(flags) {
  if (!flags) return 0;
  let mask = 0;
  for (let bit = 0; bit <= 15; bit++) if (flags[EVENT_BIT_NAMES[bit]]) mask |= (1 << bit);
  return mask;
}

/**
 * Команда 04h — чтение записи именованного журнала (до 10 последних записей на журнал,
 * № записи 0..9, 0 — самая свежая). Формат тела ответа зависит от журнала:
 *  - "парная" запись начало/конец события (6+6 байт, 2/10-код=nibble-BCD каждый):
 *    06h=превышение лимита мощности, 12h=вскрытие/закрытие корпуса, 1Ah=магнитное поле,
 *    80h/81h/82h=обратный ток по фазе 1/2/3, 83h/84h/85h=отсутствие напряжения при токе по
 *    фазе 1/2/3, 86h=нарушение чередования фаз.
 *  - 13h=перепрограммирование: дата(3)+кол-во запросов(1)+битовая карта изменённых
 *    параметров(7, необработанная — только количество и факт, не по каждому полю).
 * Источник: официальный протокол INCOTEX (doc.incotexcom.ru/protocol/mercury/), раздел
 * "Время начала/окончания событий" / "Время перепрограммирования прибора".
 */
function cmdJournalRecord(addr, journalNum, recordNum) {
  return buildRequest(addr, [0x04, journalNum & 0xFF, recordNum & 0xFF]);
}
function bcdByte(b) { return ((b >> 4) & 0x0F) * 10 + (b & 0x0F); }
/** 6 байт 2/10-кода: секунды,минуты,часы,число,месяц,год (год — 2 последние цифры). */
function parseTimestamp6(body, off) {
  if (!body || body.length < off + 6) return null;
  const ss = bcdByte(body[off]), mm = bcdByte(body[off + 1]), hh = bcdByte(body[off + 2]);
  const dd = bcdByte(body[off + 3]), MM = bcdByte(body[off + 4]), yy = bcdByte(body[off + 5]);
  // Пустая (никогда не писавшаяся) запись — все нули или год=0; отфильтровывается вызывающим кодом.
  return { ss, mm, hh, dd, MM, yy: 2000 + yy, empty: (dd === 0 && MM === 0) };
}
/** Записи журналов "начало/конец события" (06h,12h,1Ah,80h-86h) — 12 байт данных. */
function parseJournalPair(body) {
  if (!body || body.length < 13) return null;
  return { start: parseTimestamp6(body, 1), end: parseTimestamp6(body, 7) };
}
/** Запись журнала перепрограммирования (13h) — 12 байт данных. Дата — nibble-BCD (как и в
 *  парных журналах 06h/12h/1Ah), подтверждено живьём: совпала с датой события 1Ah и датой
 *  выпуска счётчика (12.07.2024, видимо заводская калибровка/тест) — не как parseSerial. */
function parseReprogramRecord(body) {
  if (!body || body.length < 13) return null;
  const dd = bcdByte(body[1]), MM = bcdByte(body[2]), yy = 2000 + bcdByte(body[3]);
  return { dd, MM, yy, requestCount: body[4], empty: dd === 0 && MM === 0, changedRaw: Array.from(body.subarray(5, 12)) };
}

/**
 * Параметр 2Fh, расширение 02h — ЗАПИСЬ флагов сброса зафиксированных событий (очистка тревог).
 * bitsLow — 16-битная маска (та же раскладка бит, что и parseEventFlags/EVENT_BIT_NAMES):
 * бит=1 сбрасывает соответствующий флаг, бит=0 не трогает его.
 * ВНИМАНИЕ — ПРОВЕРЕНО ЖИВЬЁМ (25 авг) И НЕ РАБОТАЕТ: формат выведен по аналогии с командой
 * чтения (08h→03h с той же адресацией параметр+расширение), но живой тест дал "нет ответа"
 * (счётчик молчит на этот 03h-кадр) и флаги не сбросились. Официального примера записи именно
 * этого параметра в документации нет. НЕ ИСПОЛЬЗУЕТСЯ в продовом коде — квитирование тревог
 * сделано на своей стороне (см. meters.ack_event_bits в server.js), без обращения к счётчику.
 * Оставлено как задел, если решится точный формат записи.
 */
function cmdResetEventFlags(addr, bitsLow) {
  const hi = 0x0000; // старшее слово всегда резерв
  return buildRequest(addr, [
    0x03, 0x2F, 0x02,
    hi & 0xFF, (hi >> 8) & 0xFF,
    bitsLow & 0xFF, (bitsLow >> 8) & 0xFF,
  ]);
}

/** Параметр 17h — состояние тарификатора: текущий действующий тариф + одно/многотарифный режим.
 *  Разбор бит — предварительный по документации, не перепроверен живьём отдельно от общего
 *  смысла (плаусибл значение 1-4 для тарифа). */
function cmdTariffState(addr) {
  return buildRequest(addr, [0x08, 0x17]);
}
function parseTariffState(body) {
  if (!body || body.length < 3) return null;
  const b = body[2];
  return { currentTariff: ((b >> 1) & 0x07) + 1, singleTariffMode: !!(b & 0x01) };
}

module.exports = {
  crc16MODBUS,
  buildRequest,
  passwordToBytes,
  cmdPing,
  cmdConnect,
  cmdRead,
  cmdRead11,
  checkResponse,
  parse4x4,
  parseVoltage2,
  parseFrequency,
  parseTemperature,
  cmdEnergy,
  parseEnergy16,
  cmdInstant,
  parseInstant,
  cmdSerial,
  parseSerial,
  cmdEventFlags,
  parseEventFlags,
  eventsToBitmask,
  cmdJournalRecord,
  parseTimestamp6,
  parseJournalPair,
  parseReprogramRecord,
  cmdResetEventFlags,
  EVENT_BIT_NAMES,
  cmdTariffState,
  parseTariffState,
  CMD
};
