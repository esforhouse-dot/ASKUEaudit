// Чтение профиля средних мощностей (получасовки/почасовки) счётчика Меркурий.
// Официальный протокол INCOTEX (doc.incotexcom.ru/protocol/mercury/), разделы:
// "Чтение по физическим адресам физической памяти" (код 06h, память №3),
// "Чтение в режиме относительной адресации" (код 16h),
// "Параметры последней записи основного/дополнительного массива средних мощностей" (парам. 13h/15h),
// "Вариант исполнения счетчика, стандартный" (парам. 12h + расширение 00h).
const m = require('./mercuryProtocol.js');

function bcd(b) {
  return ((b >> 4) & 0x0F) * 10 + (b & 0x0F);
}

/** Параметр 12h, расширение 00h — вариант исполнения (12 байт данных). */
function cmdVariant(addr) {
  return m.buildRequest(addr, [0x08, 0x12, 0x00]);
}

/** Постоянная счётчика A (имп/кВт·ч) — младшие 4 бита 2-го байта данных ответа на cmdVariant. */
const METER_CONSTANT_MAP = { 0: 5000, 1: 25000, 2: 1250, 3: 500, 4: 1000, 5: 250 };
// Таблица "номер варианта исполнения" (байт 3, младшие 5 бит) — официальный протокол INCOTEX,
// рис. 6.22 (номинальные характеристики, не то же самое, что маркетинговая модель 230/234/236).
const EXECUTION_VARIANT_SPEC = {
  1: { nominalVoltageV: 57.7, nominalCurrentA: 5, maxCurrentA: 10, meterConstant: 5000 },
  2: { nominalVoltageV: 230, nominalCurrentA: 5, maxCurrentA: 60, meterConstant: 500 },
  3: { nominalVoltageV: 230, nominalCurrentA: 5, maxCurrentA: 100, meterConstant: 250 },
  4: { nominalVoltageV: 230, nominalCurrentA: 5, maxCurrentA: 10, meterConstant: 1000 },
};
/**
 * Разбор ответа на 12h/00h ("стандартный" вариант исполнения, 12 байт данных — рис. 6.24).
 * Байты 1-2 (meterConstant/phasesOne/profileEnabled) сверены живьём и подтверждены протоколом
 * (см. также mercuryPoll.js). Байт 3 (тип счётчика AR/A + № варианта исполнения) разобран и
 * подтверждён по ДВУМ рабочим примерам из официального протокола (25 авг 2026) — совпало точно.
 * "Код варианта исполнения" (2 байта) — сырые байты присутствуют в протоколе, но таблицы
 * соответствия код→маркетинговая модель (230/234/236) в протоколе НЕТ (это внутренний каталог
 * производителя) — отдаём как есть, для сверки с паспортом прибора. Байты 4-6 (интерфейсы/реле/
 * пломбы) в протоколе тоже описаны, но их точную битовую раскладку не удалось надёжно проверить
 * по опубликованным примерам (один пример дал противоречие) — НЕ разбираем, чтобы не гадать.
 */
function parseVariant(body) {
  if (!body || body.length < 3) return null;
  const b2 = body[2];
  const out = {
    meterConstant: METER_CONSTANT_MAP[b2 & 0x0F] ?? null,
    phasesOne: !!(b2 & 0x10),
    profileEnabled: !!(b2 & 0x20),
  };
  if (body.length >= 13) {
    const b3 = body[3];
    out.meterType = (b3 & 0x20) ? 'A' : 'AR'; // AR = актив.+реактив., A = только активная
    out.executionVariantNum = b3 & 0x1F;
    out.executionVariantSpec = EXECUTION_VARIANT_SPEC[b3 & 0x1F] || null;
    out.executionCodeHex = body.subarray(7, 9).toString('hex');
  }
  return out;
}

/** Параметр 13h (основной профиль) / 15h (дополнительный) — параметры последней записи (9 байт данных). */
function cmdLastRecord(addr, additional = false) {
  return m.buildRequest(addr, [0x08, additional ? 0x15 : 0x13]);
}
function parseLastRecord(body) {
  if (!body || body.length < 10) return null;
  return {
    // Младший байт вперёд (как и остальные 2-байтные поля протокола) — подтверждено эмпирически:
    // при обратном порядке адрес не был кратен 0x10h, как того требует протокол для памяти №3.
    lastAddress: body[1] | (body[2] << 8),
    status: body[3],
    time: { hh: bcd(body[4]), mm: bcd(body[5]), dd: bcd(body[6]), MM: bcd(body[7]), yy: bcd(body[8]) },
    periodMin: body[9],
  };
}

/** Код 06h — чтение по физическим адресам, память №3, вид энергии 0 (P+,P-,Q+,Q- одной записью, 15 байт)
 *  или numBytes=0xFF для ускоренного чтения 17 записей подряд начиная с address. */
function cmdProfileAbsolute(addr, address, numBytes = 0x0F) {
  const byte3 = 0x03; // 17-й бит адреса=0, вид энергии=0, № памяти=3
  return m.buildRequest(addr, [0x06, byte3, (address >> 8) & 0xFF, address & 0xFF, numBytes & 0xFF]);
}

/**
 * Код 16h — чтение в режиме относительной адресации (кольцевой буфер).
 * memNum=3 — память профиля средних мощностей. offset — смещение от последней записи
 * (0 = последняя), len — сколько байт данных нужно (кратно 15 на запись, до 255 суммарно = до 17 записей).
 */
function cmdProfileRelative(addr, memNum, offset, len) {
  return m.buildRequest(addr, [0x16, memNum & 0xFF, (offset >> 8) & 0xFF, offset & 0xFF, len & 0xFF]);
}

/**
 * Разбор ответа на 16h/06h (вид энергии 0) для памяти №3: серия записей по 15 байт,
 * каждая — [статус, чч,мм,дд,ММ,гг (2/10 код), период_мин, P+ P- Q+ Q- (по 2 байта, млад.байт первым)].
 * Возвращает записи в порядке ответа (см. checkResponse — CRC уже отрезан).
 */
function parseProfileRecords(body) {
  if (!body || body.length < 1) return [];
  const records = [];
  let off = 1; // body[0] = сетевой адрес
  const RECORD_LEN = 15;
  while (off + RECORD_LEN <= body.length) {
    const status = body[off];
    const time = {
      hh: bcd(body[off + 1]), mm: bcd(body[off + 2]), dd: bcd(body[off + 3]),
      MM: bcd(body[off + 4]), yy: bcd(body[off + 5]),
    };
    const periodMin = body[off + 6];
    const rd = (lo, hi) => body[off + lo] | (body[off + hi] << 8);
    records.push({
      status,
      // Биты, старший вперёд (подтверждено разбором примера из документации 0x0A=00001010=тариф1/
      // основной/зима/не инициализация/неполный срез/без переполнения):
      tariff: ((status >> 6) & 0x03) + 1,
      profile: ((status >> 5) & 0x01) ? 'additional' : 'main',
      season: ((status >> 4) & 0x01) ? 'winter' : 'summer',
      memInit: !!((status >> 3) & 0x01),
      incomplete: !!((status >> 2) & 0x01),
      overflow: !!((status >> 1) & 0x01),
      time,
      periodMin,
      raw: { pPlus: rd(7, 8), pMinus: rd(9, 10), qPlus: rd(11, 12), qMinus: rd(13, 14) },
    });
    off += RECORD_LEN;
  }
  return records;
}

/**
 * Перевод сырых значений записи в кВт (средняя мощность) и кВт·ч (энергия за интервал записи).
 * Формула из протокола: P = N*(60/T)/(2*A) кВт; т.к. E = P*(T/60) — это упрощается до E = N/(2*A) кВт·ч.
 * meterConstant — "постоянная счётчика" A (имп/кВт·ч), см. cmdVariant/parseVariant.
 */
function recordToPower(record, meterConstant) {
  const A = meterConstant;
  const T = record.periodMin;
  const kw = (n) => (n === 0xFFFF ? null : n * (60 / T) / (2 * A));
  const kwh = (n) => (n === 0xFFFF ? null : n / (2 * A));
  return {
    powerKw: { pPlus: kw(record.raw.pPlus), pMinus: kw(record.raw.pMinus), qPlus: kw(record.raw.qPlus), qMinus: kw(record.raw.qMinus) },
    energyKwh: { pPlus: kwh(record.raw.pPlus), pMinus: kwh(record.raw.pMinus), qPlus: kwh(record.raw.qPlus), qMinus: kwh(record.raw.qMinus) },
  };
}

/** Время записи как абсолютные минуты (для сравнения разницы между записями) — не привязано
 *  к реальному часовому поясу, нужно только для проверки непрерывности последовательности. */
function timeToMinutes(t) {
  return Date.UTC(2000 + t.yy, t.MM - 1, t.dd, t.hh, t.mm) / 60000;
}
/**
 * Проверка непрерывности: true, если "later" — ровно на periodMin минут позже "earlier".
 * Используется и при догрузке истории назад, и при обычном опросе вперёд — резкий скачок
 * (не ровно periodMin) означает, что дальше не настоящая непрерывная история, а случайный
 * "хвост" старых/чужих данных в кольцевом буфере (см. память irz-mercury-profile).
 */
function isNextPeriod(earlier, later, periodMin) {
  return timeToMinutes(later) - timeToMinutes(earlier) === periodMin;
}
/** Дата записи в формате 'YYYY-MM-DD' и слот 'HH:MM' — ключи для таблицы readings. */
function recordDateSlot(t) {
  const p2 = (n) => String(n).padStart(2, '0');
  return { date: `${2000 + t.yy}-${p2(t.MM)}-${p2(t.dd)}`, slot: `${p2(t.hh)}:${p2(t.mm)}` };
}

module.exports = {
  cmdVariant, parseVariant,
  cmdLastRecord, parseLastRecord,
  cmdProfileRelative, cmdProfileAbsolute, parseProfileRecords,
  recordToPower,
  timeToMinutes, isNextPeriod, recordDateSlot,
  bcd,
};
