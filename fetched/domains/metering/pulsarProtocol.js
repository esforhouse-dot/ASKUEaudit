/**
 * Протокол обмена со счётчиками импульсов-регистраторами «Пульсар» (2..16 каналов, проводные,
 * НПП «Тепловодохран») по RS-485. Используется для счётчика воды через импульсный вход (канал 1
 * задействован первым, 2-3 — под будущие точки учёта на том же приборе).
 *
 * Источник: официальный "Протокол Счётчики импульсов регистраторы Пульсар 2_16.pdf" (11.07.2020),
 * скачан с pulsarm.ru вместе с паспортом прибора.
 *
 * Формат кадра — СВОЙ (не Modbus RTU), хотя CRC16 считается тем же алгоритмом MODBUS (полином
 * 0xA001), что и у Меркурия — переиспользуем crc16MODBUS оттуда, а не дублируем таблицу:
 *   ADDR(4, BCD, старшим байтом вперёд) F(1) L(1) DATA(...) ID(2) CRC16(2, младшим байтом вперёд)
 * L — общая длина ВСЕГО пакета (включая сам себя), не длина DATA.
 * ADDR — сетевой адрес устройства = серийный номер прибора (см. serialToAddr), НЕ произвольно
 * назначаемый короткий адрес, как у Меркурия — сканировать не нужно, адрес известен по этикетке.
 * Подтверждено живьём 22.09.2026 на объекте «Офис Онежская»: прибор №5015735, адрес 05 01 57 35,
 * ответил на F=0x01 корректным кадром (валидный CRC, эхо адреса/ID).
 *
 * ВАЖНОЕ РАСХОЖДЕНИЕ С ДОКУМЕНТАЦИЕЙ, найденное тем же живым тестом: документация описывает
 * ответ F=0x01 как double64_t (8 байт на канал), но конкретный проверенный экземпляр отвечает
 * float32 (4 байта на канал) — подтверждено дважды (0.02 м3, затем 0.03 м3 после одного
 * импульса на канале 1 = 0.01 м3/имп, как и задано весом импульса). Поэтому ширина значения
 * в parseChannelValues определяется ПО ФАКТИЧЕСКОЙ длине данных (data.length / n), а не жёстко
 * зашивается — чтобы не сломаться, если другой экземпляр всё же пришлёт double64.
 */
const { crc16MODBUS } = require('./mercuryProtocol.js');

/** Сетевой адрес = серийный номер прибора, BCD, 4 байта, старшим байтом вперёд.
 *  serial: строка/число цифр с этикетки (например, "5015735"). Дополняется нулями слева до 8 цифр. */
function serialToAddr(serial) {
  const digits = String(serial).replace(/\D/g, '').padStart(8, '0').slice(-8);
  const buf = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    const hi = digits.charCodeAt(i * 2) - 48;
    const lo = digits.charCodeAt(i * 2 + 1) - 48;
    buf[i] = (hi << 4) | lo;
  }
  return buf;
}
function addrToSerial(addr4) {
  let s = '';
  for (let i = 0; i < 4; i++) s += String((addr4[i] >> 4) & 0x0F) + String(addr4[i] & 0x0F);
  return s.replace(/^0+(?=\d)/, '');
}

let idCounter = 1;
function nextId() {
  idCounter = (idCounter + 1) & 0xFFFF;
  return Buffer.from([idCounter & 0xFF, (idCounter >> 8) & 0xFF]);
}

/** Битовая маска каналов (1-based список) -> uint32 LE, 4 байта. */
function channelsToMask(channels) {
  let m = 0;
  for (const ch of channels) m |= (1 << (ch - 1));
  return m >>> 0;
}
function maskBuffer(mask) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(mask >>> 0, 0);
  return b;
}
function setBitsAscending(mask) {
  const bits = [];
  for (let i = 0; i < 32; i++) if (mask & (1 << i)) bits.push(i);
  return bits;
}

/** Собрать запрос: ADDR+F+L+DATA+ID+CRC16. addr4 — Buffer(4) из serialToAddr. */
function buildRequest(addr4, func, data, id) {
  const idBuf = id || nextId();
  const dataBuf = data || Buffer.alloc(0);
  const totalLen = 4 + 1 + 1 + dataBuf.length + 2 + 2;
  const head = Buffer.concat([addr4, Buffer.from([func & 0xFF, totalLen & 0xFF]), dataBuf, idBuf]);
  const crc = crc16MODBUS(head);
  return Buffer.concat([head, Buffer.from([crc & 0xFF, (crc >> 8) & 0xFF])]);
}

/**
 * Проверить и разобрать ответ: CRC16, длина L соответствует фактическому размеру пакета.
 * Возвращает {addr(4), func, data, id(2)} либо null, если кадр битый/неполный.
 */
function checkResponse(buf) {
  if (!buf || buf.length < 4 + 1 + 1 + 2 + 2) return null;
  const body = buf.subarray(0, buf.length - 2);
  const crcGot = buf[buf.length - 2] | (buf[buf.length - 1] << 8);
  if (crc16MODBUS(body) !== crcGot) return null;
  const len = buf[5];
  if (len !== buf.length) return null;
  return {
    addr: buf.subarray(0, 4),
    func: buf[4],
    data: buf.subarray(6, buf.length - 4),
    id: buf.subarray(buf.length - 4, buf.length - 2),
  };
}

/**
 * Найти в принятом буфере кадр, который является ответом ИМЕННО на наш запрос (22.09.2026).
 * Обязателен на общей с Меркурием шине: в окно ожидания (settle) регулярно попадают чужие
 * кадры — от фонового опроса Меркурия или хвост предыдущего обмена. Одной проверки CRC мало:
 * чужой кадр тоже имеет валидную CRC и раньше молча принимался за ответ (живьём это дало
 * «версию прошивки 55050» и «диагностику 0x99», которые на деле оказались байтами чужого
 * ответа — те же грабли, что дали 5 ложных адресов при скане Меркурия).
 * Поэтому: идём по всем смещениям, берём кадр по заявленной в нём длине L, проверяем CRC и
 * сверяем адрес прибора и ЭХО ID запроса (протокол специально возвращает наш ID обратно —
 * это и есть штатный способ сопоставить ответ с запросом).
 */
function findFrame(buf, addr4, id2) {
  if (!buf) return null;
  const MIN_FRAME = 4 + 1 + 1 + 2 + 2; // ADDR+F+L+ID+CRC, без данных
  for (let off = 0; off + MIN_FRAME <= buf.length; off++) {
    const len = buf[off + 5];
    if (len < MIN_FRAME || off + len > buf.length) continue;
    const parsed = checkResponse(buf.subarray(off, off + len));
    if (!parsed) continue;
    if (addr4 && !parsed.addr.equals(addr4)) continue;
    if (id2 && !parsed.id.equals(id2)) continue;
    return parsed;
  }
  return null;
}

/** F=0x00 в ответе — код ошибки вместо данных (раздел 16 протокола). */
const ERROR_MESSAGES = {
  0x01: 'отсутствует запрашиваемый код функции',
  0x02: 'ошибка в битовой маске запроса',
  0x03: 'ошибочная длина запроса',
  0x04: 'отсутствует параметр',
  0x05: 'запись заблокирована, требуется авторизация',
  0x06: 'значение вне заданного диапазона',
  0x07: 'отсутствует запрашиваемый тип архива',
  0x08: 'превышение максимального количества архивных значений за один пакет',
};
function isErrorResponse(parsed) {
  return !!parsed && parsed.func === 0x00;
}
function errorMessage(parsed) {
  const code = parsed && parsed.data && parsed.data.length ? parsed.data[0] : null;
  return code == null ? 'неизвестная ошибка' : (ERROR_MESSAGES[code] || `код ошибки 0x${code.toString(16)}`);
}

/** F=0x01 — чтение текущих значений по каналам (битовая маска). */
function cmdReadCurrent(addr4, mask, id) {
  return buildRequest(addr4, 0x01, maskBuffer(mask), id);
}
/** Разбор значений — ширина (float32/double64) определяется фактической длиной данных, см.
 *  комментарий про расхождение с документацией вверху файла. */
function parseChannelValues(parsed, mask) {
  if (!parsed || !parsed.data) return null;
  const bits = setBitsAscending(mask);
  if (!bits.length) return {};
  const width = parsed.data.length / bits.length;
  const out = {};
  bits.forEach((bit, i) => {
    const off = i * width;
    let val = null;
    if (width === 8) val = parsed.data.readDoubleLE(off);
    else if (width === 4) val = parsed.data.readFloatLE(off);
    out[bit + 1] = val;
  });
  return out;
}

/**
 * F=0x03 — ЗАПИСЬ текущего показания канала (сброс/установка начальных показаний при монтаже).
 * ВАЖНО: протокол описывает значение как double64 (8 байт), но этот прибор принимает ТОЛЬКО
 * float32 (4 байта) — проверено живьём 22.09.2026: на кадр с double64 он просто молчит, на
 * float32 отвечает подтверждением с маской записанного канала. Та же девиация, что и на чтении
 * (F=0x01), так что для этой линейки float32 — правило, а не исключение.
 * Записывается строго ОДИН канал за запрос (ограничение протокола).
 */
function cmdWriteValue(addr4, channel, value, id) {
  const data = Buffer.concat([maskBuffer(channelsToMask([channel])), Buffer.alloc(4)]);
  data.writeFloatLE(value, 4);
  return buildRequest(addr4, 0x03, data, id);
}
/** Ответ на F=0x03 — маска успешно записанных каналов; проверяем, что наш канал в ней есть. */
function parseWriteValueResult(parsed, channel) {
  if (!parsed || !parsed.data || parsed.data.length < 4) return false;
  return !!((parsed.data.readUInt32LE(0) >>> (channel - 1)) & 1);
}

/**
 * F=0x19 — «тест входов»: состояние линий (замкнут/разомкнут), протокол §12.
 * ВНИМАНИЕ — ПРОВЕРЕНО ЖИВЬЁМ 22.09.2026 И НЕ ПОДДЕРЖИВАЕТСЯ этим прибором (№5015735):
 * на запрос приходит кадр ошибки F=0x00 с кодом 0x01 («отсутствует запрашиваемый код функции»).
 * Оставлено как задел для других моделей серии; вызывающий код обязан переживать отказ (см.
 * readPulsarInputTest в pulsarPoll.js — состояние контакта там необязательное).
 * Установленный бит = датчик РАЗОМКНУТ, сброшенный = ЗАМКНУТ.
 */
function cmdTestInputs(addr4, mask, id) {
  return buildRequest(addr4, 0x19, maskBuffer(mask), id);
}
function parseTestInputs(parsed, mask) {
  if (!parsed || !parsed.data || parsed.data.length < 4) return null;
  const out = parsed.data.readUInt32LE(0);
  const res = {};
  for (const bit of setBitsAscending(mask)) res[bit + 1] = ((out >>> bit) & 1) ? 'open' : 'closed';
  return res;
}

/** F=0x07 — чтение «веса импульса» (м3/имп и т.п.) по каналам, всегда float32 согласно протоколу. */
function cmdReadWeight(addr4, mask, id) {
  return buildRequest(addr4, 0x07, maskBuffer(mask), id);
}
function parseWeights(parsed, mask) {
  if (!parsed || !parsed.data) return null;
  const bits = setBitsAscending(mask);
  const out = {};
  bits.forEach((bit, i) => { out[bit + 1] = parsed.data.readFloatLE(i * 4); });
  return out;
}

/** F=0x08 — запись веса импульса ОДНОГО канала (протокол не позволяет несколько за раз). */
function cmdWriteWeight(addr4, channel, value, id) {
  const data = Buffer.concat([maskBuffer(channelsToMask([channel])), Buffer.alloc(4)]);
  data.writeFloatLE(value, 4);
  return buildRequest(addr4, 0x08, data, id);
}

/** F=0x04/0x05 — время прибора. Байты года/месяца/дня/часа/мин/сек — RAW-значение байта (как
 *  серийный номер у Меркурия), НЕ nibble-BCD (см. протокол §5-6). */
function cmdReadTime(addr4, id) {
  return buildRequest(addr4, 0x04, Buffer.alloc(0), id);
}
function parseTime(parsed) {
  if (!parsed || !parsed.data || parsed.data.length < 6) return null;
  const d = parsed.data;
  return { year: 2000 + d[0], month: d[1], day: d[2], hour: d[3], minute: d[4], second: d[5] };
}
function cmdWriteTime(addr4, dt, id) {
  const data = Buffer.from([
    (dt.year - 2000) & 0xFF, dt.month & 0xFF, dt.day & 0xFF,
    dt.hour & 0xFF, dt.minute & 0xFF, dt.second & 0xFF,
  ]);
  return buildRequest(addr4, 0x05, data, id);
}

/** F=0x06 — чтение архива (часовой=1/суточный=2/месячный=3) ОДНОГО канала за интервал дат.
 *  Не более 58 записей за один запрос (ограничение протокола). */
const ARCHIVE_TYPE = { HOURLY: 1, DAILY: 2, MONTHLY: 3 };
function dateBytes(dt) {
  return Buffer.from([(dt.year - 2000) & 0xFF, dt.month & 0xFF, dt.day & 0xFF, dt.hour & 0xFF, dt.minute & 0xFF, dt.second & 0xFF]);
}
function cmdReadArchive(addr4, channel, archiveType, dateStart, dateEnd, id) {
  const typeBuf = Buffer.from([archiveType & 0xFF, (archiveType >> 8) & 0xFF]);
  const data = Buffer.concat([maskBuffer(channelsToMask([channel])), typeBuf, dateBytes(dateStart), dateBytes(dateEnd)]);
  return buildRequest(addr4, 0x06, data, id);
}
/** «Нет данных» — сентинел 0xFFFFFFF1 (float32), не настоящее значение. */
const NO_DATA_SENTINEL_BYTES = Buffer.from([0xF1, 0xFF, 0xFF, 0xFF]);
function parseArchive(parsed) {
  if (!parsed || !parsed.data || parsed.data.length < 10) return null;
  const d = parsed.data;
  const start = { year: 2000 + d[4], month: d[5], day: d[6], hour: d[7], minute: d[8], second: d[9] };
  const values = [];
  for (let off = 10; off + 4 <= d.length; off += 4) {
    const chunk = d.subarray(off, off + 4);
    values.push(chunk.equals(NO_DATA_SENTINEL_BYTES) ? null : chunk.readFloatLE(0));
  }
  return { start, values };
}

/**
 * F=0x0A/0x0B — чтение/запись «настроечных параметров» (протокол §13-15). PARAM_VAL — всегда
 * 8 байт, тип и число значащих байт внутри зависит от конкретного параметра (незначащие байты
 * могут содержать случайный мусор — decode-функции ниже читают только нужное число байт с начала).
 * Используется для диагностики/настройки прибора (длительность импульса/паузы и т.п.) — то, что
 * иначе делалось бы штатным ПО производителя через локальный COM-порт; здесь — то же самое через
 * уже работающий прозрачный порт Collector, без виртуального COM-моста и риска коллизий со
 * сторонним ПО на шине.
 */
// ⚠️ ТАБЛИЦА ПАРАМЕТРОВ ЭТОГО ПРИБОРА НЕ СОВПАДАЕТ С ОБЩЕЙ ДОКУМЕНТАЦИЕЙ НА СЕРИЮ.
// Установлено живьём 22.09.2026 на приборе №5015735 ценой реального инцидента: по документации
// 0x0003/0x0004 — «длительность импульса/паузы» (10..1999 мс), и запись туда 10 (как «10 мс»)
// изменила НЕ фильтр входа, а ВЕС ИМПУЛЬСА канала 1: показание стало расти на 10 за импульс
// вместо 0.01, т.е. в 1000 раз быстрее (3 импульса дали +30 м³). Восстановлено записью 0.01.
// Фактическая раскладка по дампам:
//   0x0001 → b7 88 4c 00 = uint32 5015735 — СЕРИЙНЫЙ НОМЕР (а не «летнее время»).
//   0x0003 / 0x0004 / 0x0005 → float32 веса импульса каналов 1 / 2 / 3 соответственно
//     (для канала 1 связь доказана: запись сюда изменила именно его цену импульса; для 2 и 3 —
//     по аналогии и по тому, что 0x0005 всё это время хранил нетронутые 0.01, проверить при
//     подключении этих каналов).
//   0x0006 → 99 fe 00 00 — смысл не установлен, наружу не отдаём.
// Штатные команды веса F=0x07/F=0x08 из документации этот прибор НЕ поддерживает (отвечает
// кодом ошибки 0x01 «отсутствует запрашиваемый код функции»), поэтому вес доступен только
// через таблицу параметров ниже.
const PARAM = {
  SERIAL: 0x0001, // uint32, R (совпал с номером на этикетке)
};
/** Номер параметра с весом импульса для канала (1→0x0003, 2→0x0004, 3→0x0005). */
function paramForChannelWeight(channel) {
  return 0x0002 + channel;
}
function cmdReadParam(addr4, paramNum, id) {
  return buildRequest(addr4, 0x0A, Buffer.from([paramNum & 0xFF, (paramNum >> 8) & 0xFF]), id);
}
/** valueBuf8 — ровно 8 байт (см. encodeUint16/encodeFloat32 ниже), незначащие обнуляем сами
 *  (не «случайный мусор», как допускает протокол на чтении, — на запись это лишнее не нужно). */
function cmdWriteParam(addr4, paramNum, valueBuf8, id) {
  const data = Buffer.concat([Buffer.from([paramNum & 0xFF, (paramNum >> 8) & 0xFF]), valueBuf8]);
  return buildRequest(addr4, 0x0B, data, id);
}
function parseParamRaw(parsed) {
  if (!parsed || !parsed.data || parsed.data.length < 8) return null;
  return parsed.data.subarray(0, 8);
}
function parseWriteParamResult(parsed) {
  if (!parsed || !parsed.data || parsed.data.length < 2) return null;
  return parsed.data.readUInt16LE(0) === 0; // 0 = запись успешна
}
function encodeUint16(v) { const b = Buffer.alloc(8); b.writeUInt16LE(v & 0xFFFF, 0); return b; }
function decodeUint16(buf8) { return buf8.readUInt16LE(0); }
function encodeFloat32(v) { const b = Buffer.alloc(8); b.writeFloatLE(v, 0); return b; }
function decodeFloat32(buf8) { return buf8.readFloatLE(0); }
function decodeUint8(buf8) { return buf8[0]; }

module.exports = {
  serialToAddr,
  addrToSerial,
  channelsToMask,
  maskBuffer,
  buildRequest,
  checkResponse,
  findFrame,
  cmdTestInputs,
  parseTestInputs,
  isErrorResponse,
  errorMessage,
  cmdReadCurrent,
  parseChannelValues,
  cmdWriteValue,
  parseWriteValueResult,
  cmdReadWeight,
  parseWeights,
  cmdWriteWeight,
  cmdReadTime,
  parseTime,
  cmdWriteTime,
  ARCHIVE_TYPE,
  cmdReadArchive,
  parseArchive,
  PARAM,
  paramForChannelWeight,
  cmdReadParam,
  cmdWriteParam,
  parseParamRaw,
  parseWriteParamResult,
  encodeUint16,
  decodeUint16,
  encodeFloat32,
  decodeFloat32,
  decodeUint8,
};
