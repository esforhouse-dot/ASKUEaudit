// Опрос счётчика Меркурий через прозрачный порт iRZ Collector (порт 35000).
// Одно постоянное TCP-соединение на весь цикл опроса — открывать новое соединение
// на каждую команду нельзя: ответ может прийти с опозданием и попасть в СЛЕДУЮЩЕЕ
// соединение вместо текущего (см. память irz-mercury-poll).
const net = require('net');
const m = require('./mercuryProtocol.js');

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

async function step(sock, frame, settleMs) {
  const resp = await sendAndWait(sock, frame, 8000, settleMs);
  if (!resp) return null;
  return m.checkResponse(resp);
}

/**
 * Опросить счётчик: авторизация + напряжение/ток/мощность/частота.
 * cfg: {host, port, addr, password}
 * Бросает исключение, если счётчик не отвечает вообще или отклонил авторизацию.
 * Отдельные параметры внутри результата могут быть null, если конкретное чтение не удалось.
 */
async function pollMercury(cfg) {
  const { host, port, addr, password } = cfg;
  return withSocket(host, port, async (sock) => {
    // 200мс — та же короткая фиксированная категория, что connect/пинг/журнал (см. CLAUDE.md);
    // раньше тут везде был дефолт 900мс, а это 8 из 9 команд опроса ОДНОГО счётчика — при 8
    // счётчиках на объекте (Capitalservis) полный круг опроса занимал ~65с, дольше собственного
    // 60-секундного интервала, и шина оставалась занята постоянно даже без догрузок/бэкфилла
    // (нашли 27 авг — ручное "Опросить счётчик сейчас" висело в очереди по 15-20с). Сводную
    // команду мгновенных величин (89 байт, крупнее прочих) не трогаем — не проверяли на такой
    // задержке, риск обрезать самый ценный сейчас поток данных того не стоит.
    const conn = await step(sock, m.cmdConnect(addr, 1, password), 200);
    if (!conn || conn.length < 2 || conn[1] !== 0x00) {
      throw new Error(conn ? `авторизация отклонена (код ${conn[1]})` : 'нет ответа на авторизацию');
    }

    // Одна сводная команда (16h/A0h) вместо семи отдельных — быстрее (меньше времени на шине,
    // важно при нескольких счётчиках на одном модеме) и, в отличие от отдельных команд на
    // ток/мощность, живьём подтверждена сверкой с U·I·cosφ (см. mercuryProtocol.js parseInstant).
    const inst = await step(sock, m.cmdInstant(addr));
    const parsed = inst ? m.parseInstant(inst) : null;
    // Температура счётчика временно не опрашивается (29 авг, разгрузка RS-485 при нескольких
    // счётчиках на шине) — отдельная команда, в отличие от cosφ (тот приходит бесплатно внутри
    // cmdInstant выше). Раскомментировать строку ниже, когда понадобится снова.
    // const temp = await step(sock, m.cmdRead11(addr, m.CMD.TEMPERATURE), 200);
    const temp = null;
    const ev = await step(sock, m.cmdEventFlags(addr), 200);
    const tar = await step(sock, m.cmdTariffState(addr), 200);
    // Накопленная энергия по тарифам — НЕ здесь: 5 отдельных команд (нет варианта "все тарифы
    // разом" в протоколе), а копится медленно, свежесть в 60с не нужна, и на "Показания" вообще
    // не выводится (только в АСКУЭ). Вынесено в pollEnergy() — раз в 10 мин, вместе с профилем
    // (см. server.js backgroundMercuryProfilePollMeter) — раньше это было ПОЛОВИНОЙ всех команд
    // обычного опроса (5 из 10), из-за чего полный круг по 8 счётчикам не укладывался в 60с и
    // ручное "Опросить счётчик сейчас" висело в очереди по 15-60с (жалоба 27 авг).

    return {
      voltage: parsed ? parsed.voltage : null,
      current: parsed ? parsed.current : null,
      power: parsed ? parsed.power : null,
      powerQ: parsed ? parsed.powerQ : null,
      powerS: parsed ? parsed.powerS : null,
      powerFactor: null, // временно скрыт по просьбе пользователя (29 авг) — данные всё равно
      // приходят бесплатно внутри parsed выше (см. коммент у cmdInstant), просто не отдаём наружу;
      // вернуть — заменить на `parsed ? parsed.powerFactor : null`.
      frequency: parsed ? parsed.frequency : null,
      temperature: temp ? m.parseTemperature(temp) : null,
      events: ev ? m.parseEventFlags(ev) : null,
      tariff: tar ? m.parseTariffState(tar) : null,
    };
  });
}

/** Накопленная энергия по тарифам (команда 0x05) — см. коммент в pollMercury про перенос сюда. */
async function pollEnergy(cfg) {
  const { host, port, addr, password } = cfg;
  return withSocket(host, port, async (sock) => {
    const conn = await step(sock, m.cmdConnect(addr, 1, password), 200);
    if (!conn || conn.length < 2 || conn[1] !== 0x00) {
      throw new Error(conn ? `авторизация отклонена (код ${conn[1]})` : 'нет ответа на авторизацию');
    }
    const energy = { sum: null, t1: null, t2: null, t3: null, t4: null };
    for (const [key, tariff] of [['sum', 0], ['t1', 1], ['t2', 2], ['t3', 3], ['t4', 4]]) {
      const body = await step(sock, m.cmdEnergy(addr, 0x0, tariff), 200);
      if (!body) continue;
      const e = m.parseEnergy16(body);
      if (!e) continue;
      const div1k = (v) => (v == null ? null : v / 1000);
      energy[key] = { aPlus: div1k(e.aPlus), aMinus: div1k(e.aMinus), rPlus: div1k(e.rPlus), rMinus: div1k(e.rMinus) };
    }
    return energy;
  });
}

/** Серийный номер и дата выпуска — читается один раз (без CONNECT), не меняется со временем. */
async function readSerial(cfg) {
  const { host, port, addr } = cfg;
  return withSocket(host, port, async (sock) => {
    const body = await step(sock, m.cmdSerial(addr));
    return body ? m.parseSerial(body) : null;
  });
}

// Журналы событий с реальным временем (код 04h), которые нам известны и полезны для тревог —
// см. mercuryProtocol.js cmdJournalRecord/parseJournalPair/parseReprogramRecord. До 10 последних
// записей на журнал (0=самая свежая). Проверено живьём (25 авг) — даёт настоящие исторические
// события (совпало с датой заводского теста, недавним монтажом счётчика и т.п.).
const EVENT_JOURNALS = [
  { code: 0x12, type: 'pair', key: 'caseOpen', label: 'Вскрытие/закрытие корпуса' },
  { code: 0x1A, type: 'pair', key: 'magneticField', label: 'Воздействие магнитного поля' },
  { code: 0x06, type: 'pair', key: 'powerLimitExceeded', label: 'Превышение лимита мощности' },
  { code: 0x13, type: 'reprogram', key: 'programmingLogEvent', label: 'Перепрограммирование' },
];
/**
 * Полная история "тревожных" журналов — до 10 записей на журнал (40 запросов суммарно),
 * поэтому только по требованию (кнопка), не на каждом обычном опросе.
 * Возвращает список {key,label,start,end|null} для парных журналов и
 * {key,label,date,requestCount} для перепрограммирования, отсортированный по дате (новые сверху).
 */
async function readEventHistory(cfg, onProgress) {
  const { host, port, addr, password } = cfg;
  return withSocket(host, port, async (sock) => {
    const conn = await step(sock, m.cmdConnect(addr, 1, password), 200);
    if (!conn || conn.length < 2 || conn[1] !== 0x00) {
      throw new Error(conn ? `авторизация отклонена (код ${conn[1]})` : 'нет ответа на авторизацию');
    }
    const events = [];
    let done = 0;
    for (const j of EVENT_JOURNALS) {
      // Записи 0..9, 0=самая свежая — читаем ВСЕ 10 без "стопа на первой пустой": проверено
      // живьём, что пустая запись может встретиться РАНЬШЕ заполненной (напр. журнал 13h:
      // rec0 пусто, rec1 — реальная запись) — ранний выход по пустой записи пропускал бы
      // реальные события. Таймаут HTTP тут не проблема — вызывается как фоновая задача с
      // прогрессом (см. server.js eventHistoryJobs), не напрямую в ответе на запрос.
      // Короткий settle (200мс, как в scanBus) вместо стандартных 900мс — ответ на 04h
      // короткий и приходит одним пакетом, ждать дольше незачем; это и есть узкое место
      // (40 запросов × 900мс ~ 36с ушли на пустое ожидание).
      for (let rec = 0; rec < 10; rec++) {
        const body = await step(sock, m.cmdJournalRecord(addr, j.code, rec), 200);
        done++;
        if (onProgress) onProgress(done, EVENT_JOURNALS.length * 10, events.length);
        if (!body) continue;
        if (j.type === 'pair') {
          const pair = m.parseJournalPair(body);
          if (!pair || !pair.start || pair.start.empty) continue;
          events.push({ key: j.key, label: j.label, start: pair.start, end: (pair.end && !pair.end.empty) ? pair.end : null });
        } else {
          const r = m.parseReprogramRecord(body);
          if (!r || r.empty) continue;
          events.push({ key: j.key, label: j.label, date: { dd: r.dd, MM: r.MM, yy: r.yy }, requestCount: r.requestCount });
        }
      }
    }
    const sortKey = (e) => {
      const t = e.start || e.date;
      return Date.UTC(t.yy, (t.MM || 1) - 1, t.dd || 1, t.hh || 0, t.mm || 0, t.ss || 0);
    };
    events.sort((a, b) => sortKey(b) - sortKey(a));
    return events;
  });
}

/**
 * Просканировать диапазон адресов RS-485 командой ping (0x00) — одно TCP-соединение на
 * весь скан (см. предупреждение вверху файла — новое соединение на каждый адрес нельзя).
 * cfg: {host, port}. onProgress(checked, total, foundSoFar) — необязательный колбэк.
 * Возвращает массив адресов, ответивших на ping.
 */
async function scanBus(cfg, from, to, onProgress) {
  const { host, port } = cfg;
  return withSocket(host, port, async (sock) => {
    const found = [];
    for (let addr = from; addr <= to; addr++) {
      const resp = await sendAndWait(sock, m.cmdPing(addr), 900, 200);
      const body = resp ? m.checkResponse(resp) : null;
      if (body) found.push(addr);
      if (onProgress) onProgress(addr - from + 1, to - from + 1, found.slice());
    }
    return found;
  }, 8000);
}

module.exports = { pollMercury, pollEnergy, scanBus, readSerial, readEventHistory };
