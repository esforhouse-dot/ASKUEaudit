// Веб-панель управления и мониторинга модемов iRZ ATM42.B через iRZ Collector.
// Мультитенантная версия: один процесс обслуживает несколько проектов, у каждого — свой
// модем(ы) и счётчик(и) (см. db.js — таблицы projects/modems/meters). Состояние времени
// выполнения (кэши, очереди команд, история) — per-modem/per-meter, см. modemState.js.
//
// Архитектура (см. память проекта):
//   1. Команда пишется в таблицу irzserver4.commands (поле command — байты команды инкапсуляции),
//   2. службе Collector шлётся SENDCOMMANDS через долгоживущий Java-демон GpioDaemon
//      (одна постоянная сессия на 5010) — служба отправляет команды модему по живому соединению.
//      Один демон обслуживает ВСЕ модемы разом — очередь commands в БД уже разделена по imei,
//      SENDCOMMANDS лишь просит службу перечитать её целиком.
//   3. ответы модема читаются из commands.answer.
//
// command_id (из фирменного ПО): 1=смена вывода, 6=состояние выводов(@\x02), 13=ICCID(@\x0b),
//   14=CSQ(@\x01), 15=LBS/вышка(@\x04), 16=температура(@\x05), 21=USSD($ussd=0<код>\r).

const express = require('express');
const mysql = require('mysql2/promise');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs'); // отчёт по разделу «Объекты», см. /api/objects/export
const { pollMercury, pollEnergy, scanBus, readSerial, readEventHistory } = require('./mercury/mercuryPoll.js');
const { eventsToBitmask } = require('./mercury/mercuryProtocol.js');
const { pollProfile } = require('./mercury/mercuryProfilePoll.js');
const db = require('./db.js');
const auth = require('./auth.js');
const state = require('./modemState.js');
const mailer = require('./mailer.js'); // SMTP-отправка для «Уведомления и отклонения», см. mailer.js
const loginRateLimit = require('./loginRateLimit.js'); // P0-03: троттлинг /api/login, см. файл

const PORT = 3005;
const MODEM_SMS_PASSWORD = '5492';   // фиксированный вендорский код разблокировки iRZ ATM (не секрет конкретного устройства)
const COLLECTOR_HOST = '147.45.212.205';
const MERCURY_POLL_SEC = 60;         // период опроса GPIO/CSQ/temp модема (своя очередь, serializeGpioFor — не делит шину со счётчиками)
// Период опроса мгновенных величин СЧЁТЧИКОВ — отдельно от MERCURY_POLL_SEC (27 авг): счётчики
// делят одну RS-485 шину (serializeFor), и на объекте с 8 счётчиками полный круг опроса реально
// занимает ~60-70с даже после оптимизаций (энергия по тарифам вынесена в 10-минутный цикл, settle
// сокращён до 200мс) — с интервалом 60с шина не успевала простаивать НИКОГДА, и любое ручное
// действие ("Опросить счётчик сейчас") вставало в бесконечную очередь на десятки секунд (жалоба
// пользователя). 120с даёт реальный запас простоя.
const MERCURY_BUS_POLL_SEC = 120;
const RETENTION_MONTHS = 24;         // сколько месяцев почасовок храним, старше — удаляется
const BACKFILL_MAX_RECORDS = 24 * 31 * 48; // потолок первой догрузки истории (24 месяца с запасом)
const POLL_MAX_RECORDS = 100;        // потолок обычного (не первого) опроса — сколько новых срезов ждать за цикл
// Самозапись почасовки из 05h (см. applySelfEnergy) — ожидаемый шаг между опросами энергии равен
// интервалу tickAllProfiles (10 мин, ниже). WARN — разрыв ещё принимаем, но помечаем неполным
// (одна пропущенная итерация — бывает при заторе на шине). MAX — разрыв, где относить всю
// накопленную дельту к ОДНОМУ часу уже вводит в заблуждение (несколько часов простоя слепились бы
// в один) — тогда просто сдвигаем точку отсчёта и не пишем ничего за этот интервал (та же дыра,
// что и у профиля при простое демона — самозапись не восстанавливает историю задним числом,
// см. обсуждение с пользователем 27 авг).
const SELF_ENERGY_WARN_GAP_MS = 20 * 60 * 1000;
const SELF_ENERGY_MAX_GAP_MS = 40 * 60 * 1000;

const DB_PASSWORD = fs.readFileSync('/root/.irz_db_password', 'utf8').trim();
const WEB_PASSWORD = fs.readFileSync('/root/.irz_web_password', 'utf8').trim();
const SERVICE_JAR = '/usr/local/iRZ_Server/dist/Service.jar';
const TRIGGER_DIR = '/opt/irz-web/trigger';

// Фото лэндинга (см. /api/landing/*) — слоты фиксированы списком, а не произвольной строкой с
// клиента: slot идёт прямо в имя файла на диске, белый список закрывает путь к обходу каталога.
const LANDING_DIR = path.join(__dirname, 'public', 'landing', 'uploads');
if (!fs.existsSync(LANDING_DIR)) fs.mkdirSync(LANDING_DIR, { recursive: true });
const LANDING_SLOTS = new Set(['logo', 'overview', 'modem', 'meters', 'readings', 'askue', 'payments', 'register', 'io', 'admin']);

// Байты команд инкапсуляции
const CMD = {
  GPO_ON:  Buffer.from('$gp4=1\r', 'latin1'),
  GPO_OFF: Buffer.from('$gp4=0\r', 'latin1'),
  READ:    Buffer.from([0x40, 0x02]),   // @\x02 состояние выводов
  CSQ:     Buffer.from([0x40, 0x01]),   // @\x01 уровень сигнала
  TEMP:    Buffer.from([0x40, 0x05]),   // @\x05 температура модуля
  LBS:     Buffer.from([0x40, 0x04]),   // @\x04 базовая станция
  ICCID:   Buffer.from([0x40, 0x0b]),   // @\x0b ICCID
};
const ID = { SET: 1, READ: 6, ICCID: 13, CSQ: 14, LBS: 15, TEMP: 16, USSD: 21 };
const GPIO_NUM = { GPIO1: 1, GPIO2: 2, GPIO3: 3 };

// Задачи сканирования шины RS-485 (Фаза 6) — по модему, в памяти процесса (не переживают рестарт).
const scanJobs = new Map();
// Задачи первой догрузки истории почасовок — по счётчику, в памяти процесса.
const backfillJobs = new Map();
// Задачи чтения истории тревожных журналов (до 40 запросов, поэтому асинхронно — по счётчику.
const eventHistoryJobs = new Map();

// ── Демон-триггер (одно постоянное соединение к службе на 5010, общий на все модемы) ──────────
let daemon = null, daemonReady = false, daemonBuf = '';
const triggerQueue = [];
function startDaemon() {
  daemon = spawn('java',
    ['-cp', `${SERVICE_JAR}:${TRIGGER_DIR}`, 'service.GpioDaemon', 'webgpio', WEB_PASSWORD]);
  daemonReady = false;
  daemon.stdout.on('data', chunk => {
    daemonBuf += chunk.toString();
    let nl;
    while ((nl = daemonBuf.indexOf('\n')) >= 0) {
      const line = daemonBuf.slice(0, nl).trim();
      daemonBuf = daemonBuf.slice(nl + 1);
      if (line === 'READY') { daemonReady = true; console.log('✅ Демон-триггер подключён'); continue; }
      const w = triggerQueue.shift();
      if (w) { line === 'OK' ? w.resolve() : w.reject(new Error('служба не приняла команду (' + line + ')')); }
    }
  });
  daemon.stderr.on('data', d => console.error('daemon:', d.toString().trim()));
  daemon.on('exit', code => {
    console.error('⚠️ Демон завершился (' + code + '), перезапуск через 3с');
    daemonReady = false;
    while (triggerQueue.length) triggerQueue.shift().reject(new Error('демон перезапускается'));
    setTimeout(startDaemon, 3000);
  });
}
function waitDaemonReady(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function c() {
      if (daemonReady) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('демон-триггер не готов'));
      setTimeout(c, 200);
    })();
  });
}
function daemonCmd(cmdLine, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    triggerQueue.push({ resolve, reject });
    daemon.stdin.write(cmdLine + '\n');
    setTimeout(() => {
      const i = triggerQueue.findIndex(w => w.resolve === resolve);
      if (i >= 0) { triggerQueue.splice(i, 1); reject(new Error('таймаут ответа службы')); }
    }, timeoutMs);
  });
}
async function triggerSend() { await waitDaemonReady(); return daemonCmd('TRIGGER'); }

// Записать настройки модема (REMOTESETTINGS). Формат payload: imei=pass@@@descr@@@0@@@cmd%%%OK^^^...
// ВАЖНО: разделитель imei/пароль — «=», НЕ «;» (см. память irz-asuno-schedule).
async function writeSettings(imei, atCommands) {
  await waitDaemonReady();
  const cmds = atCommands.map(c => c + '%%%OK').join('^^^');
  const payload = `${imei}=${MODEM_SMS_PASSWORD}@@@web@@@0@@@${cmds}`;
  return daemonCmd('SET ' + payload, 20000);
}

// ── БД Collector'а (irzserver4) ────────────────────────────────────────────────
let pool;
async function initDb() {
  pool = mysql.createPool({
    host: '127.0.0.1', port: 3306, user: 'irzcollector', password: DB_PASSWORD,
    database: 'irzserver4', waitForConnections: true, connectionLimit: 5,
  });
}
async function queueCommand(imei, commandBytes, commandId) {
  const [res] = await pool.execute(
    'INSERT INTO commands (imei, queued, interrupt, command, command_id, encapsulation) VALUES (?, ?, 0, ?, ?, ?)',
    [imei, Date.now(), commandBytes, commandId, '1.3']);
  return res.insertId;
}
async function waitAnswer(commandId, timeoutMs = 22000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [rows] = await pool.execute(
      'SELECT error, ans_date, CONVERT(answer USING utf8) AS answer, HEX(answer) AS hexans FROM commands WHERE id = ?',
      [commandId]);
    const r = rows[0];
    if (r && r.ans_date && Number(r.ans_date) > 0) return { error: r.error === 1, answer: r.answer, hex: r.hexans };
    await new Promise(res => setTimeout(res, 300));
  }
  throw new Error('модем не ответил (таймаут)');
}
async function modemOnline(imei) {
  const [rows] = await pool.execute('SELECT state FROM devices WHERE imei = ?', [imei]);
  return rows[0] ? rows[0].state === 1 : false;
}
async function getCollectorPort(imei) {
  const [rows] = await pool.execute('SELECT port FROM devices WHERE imei = ?', [imei]);
  const p = rows[0] && rows[0].port ? parseInt(rows[0].port, 10) : null;
  return p || null;
}

async function batchOnce(imei, items) {
  const ids = {};
  for (const it of items) ids[it.key] = await queueCommand(imei, it.bytes, it.id);
  await triggerSend();
  const out = {};
  await Promise.all(items.map(async it => {
    try {
      const r = await waitAnswer(ids[it.key], 22000);
      out[it.key] = r.error ? null : r;
    } catch { out[it.key] = null; }
  }));
  return out;
}
async function batch(imei, items, attempts = 2) {
  let result = {};
  let pending = items;
  for (let a = 0; a < attempts && pending.length; a++) {
    const got = await batchOnce(imei, pending);
    for (const k in got) if (got[k]) result[k] = got[k];
    pending = pending.filter(it => !result[it.key]);
    if (pending.length && a < attempts - 1) await new Promise(r => setTimeout(r, 1500));
  }
  for (const it of items) if (!(it.key in result)) result[it.key] = null;
  return result;
}

// ── Статус нагрузки по состоянию выводов ──────────────────────────────────────
function loadStatus(pins, loadCfg) {
  if (!pins) return null;
  const gpo = pins.find(p => p.name === 'GPO');
  const command = gpo ? gpo.high : null;
  let feedback = null, confirmed = null;
  if (loadCfg.feedbackPin >= 1 && loadCfg.feedbackPin <= 3) {
    const fp = pins.find(p => p.name === 'GPIO' + loadCfg.feedbackPin);
    if (fp) {
      const active = loadCfg.feedbackActiveHigh ? fp.high : !fp.high;
      feedback = active;
      if (command === true) confirmed = active ? 'ok' : 'fail';
      else if (command === false) confirmed = active ? 'stuck' : 'ok';
    }
  }
  return { command, feedback, confirmed };
}

// ── Парсинг ответов ───────────────────────────────────────────────────────────
function parsePins(answer) {
  // Минимум — GPIO1-3+GPO (8 симв.); AUX (5-я пара, ещё +2 симв.) есть не на всех моделях —
  // напр. iRZ ATM.21B (в отличие от ATM42.B) отвечает всего 4 парами без AUX, что раньше
  // отбраковывалось этой проверкой целиком (была < 10) и модем выглядел "не отвечает".
  if (!answer || answer.length < 8) return null;
  const names = ['GPIO1', 'GPIO2', 'GPIO3', 'GPO', 'AUX'];
  const pins = [];
  for (let i = 0; i < 5; i++) {
    const pair = answer.substr(i * 2, 2);
    const b = parseInt(pair, 16);
    if (Number.isNaN(b)) continue;
    const isOutput = (b & 0x40) !== 0;
    const high = (b & 0x02) !== 0;
    pins.push({ name: names[i], dir: isOutput ? 'out' : 'in', high, byte: pair.toUpperCase() });
  }
  return pins;
}
function decodeUssd(answer) {
  if (!answer) return answer;
  const s = answer.trim();
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 4 === 0) {
    try {
      const buf = Buffer.from(s, 'hex').swap16();
      const txt = buf.toString('utf16le');
      if (/[0-9A-Za-zА-Яа-я]/.test(txt)) return txt;
    } catch {}
  }
  return answer;
}
function parseCsq(hexStr) {
  if (!hexStr) return null;
  const v = parseInt(hexStr.substr(0, 2), 16);
  if (Number.isNaN(v) || v > 31) return { raw: v, csq: null };
  return { csq: v, percent: Math.round(v / 31 * 100), dbm: -113 + 2 * v };
}
function parseTemp(answer) {
  if (!answer) return null;
  const v = parseInt(String(answer).trim().substr(0, 2), 16);
  if (Number.isNaN(v)) return null;
  return v - 100;
}
function parseLbs(ans) {
  if (!ans) return null;
  const raw = ans.replace(/;+$/, '');
  // Некоторые модели (напр. iRZ ATM.21B, в отличие от эталонной ATM42.B) отвечают на эту команду
  // списком СОСЕДНИХ вышек: `0,"250,20,69fd,28fc,58,38";1,"250,20,...";...` — вложенная строка в
  // кавычках, наивный split(',') резал прямо по запятым внутри неё (отсюда обрывок вида `"250`
  // в интерфейсе вместо статуса — нашли на объекте Capitalservis 26 авг). Разбираем первую
  // (обслуживающую) вышку явно через кавычки: там MCC,MNC,ID соты,LAC,диапазон,уровень.
  if (raw.includes('"')) {
    const m = raw.split(';')[0].match(/"([^"]*)"/);
    const f = m ? m[1].split(',') : [];
    return {
      net: '', state: 'зарегистрирован',
      plmn: f[0] ? f[0] + (f[1] ? ' ' + f[1] : '') : '',
      cell: f[2] || '', lac: f[3] || '', band: (f[4] || '').trim(), level: f[5] || '',
      neighborCount: raw.split(';').filter(Boolean).length, raw,
    };
  }
  const p = raw.split(',');
  return {
    net: p[0] || '', state: p[1] || '', plmn: p[2] || '', cell: p[3] || '', lac: p[4] || '',
    band: (p[5] || '').trim(), level: p[6] || '', raw,
  };
}

// Полный опрос: выводы + сигнал + температура + вышка одним триггером
async function pollAll(imei, attempts = 2) {
  const res = await batch(imei, [
    { key: 'pins', bytes: CMD.READ, id: ID.READ },
    { key: 'csq',  bytes: CMD.CSQ,  id: ID.CSQ },
    { key: 'temp', bytes: CMD.TEMP, id: ID.TEMP },
    { key: 'lbs',  bytes: CMD.LBS,  id: ID.LBS },
  ], attempts);
  return {
    pins: res.pins ? parsePins(res.pins.answer) : null,
    csq:  res.csq  ? parseCsq(res.csq.hex) : null,
    temp: res.temp ? parseTemp(res.temp.answer) : null,
    lbs:  res.lbs  ? parseLbs(res.lbs.answer) : null,
  };
}
const pollAllOnce = (imei) => pollAll(imei, 1);

async function setGpo(modem, on) {
  const st = state.getModemState(modem.id);
  st.lastUserCmd = Date.now();
  let lastErr = 'команда не прошла';
  for (let attempt = 0; attempt < 2; attempt++) {
    const setId = await queueCommand(modem.imei, on ? CMD.GPO_ON : CMD.GPO_OFF, ID.SET);
    await triggerSend();
    let setRes = null;
    try { setRes = await waitAnswer(setId, 15000); } catch { setRes = null; }
    if (setRes && !setRes.error) {
      if (st.cachedStatus.pins) {
        const pins = st.cachedStatus.pins.map(p => p.name === 'GPO'
          ? { ...p, high: on, byte: on ? 'C2' : 'C0' } : p);
        st.cachedStatus = {
          ...st.cachedStatus, online: true, reconnecting: false,
          pins, load: loadStatus(pins, st.loadCfg), loadCfg: st.loadCfg, ts: Date.now(),
        };
        return pins;
      }
      return null;
    }
    if (setRes && setRes.error) { lastErr = 'модем отклонил команду'; break; }
    if (attempt === 0) await new Promise(r => setTimeout(r, 800));
  }
  throw new Error(lastErr + ' (модем переподключается — попробуйте ещё раз)');
}

// ── Фоновый опрос модема (GPIO/CSQ/temp/LBS) ──────────────────────────────────
// Если опрос уже идёт (фоновый тик или другой вызов "Обновить"), НЕ возвращаемся тихо со старым
// кэшем — отдаём тот же промис, так что вызывающий реально дожидается свежего результата.
// Раньше второй вызов (напр. клик "Обновить" во время фонового тика) молча получал прежние
// данные без единого признака, что опрос не был свежим — выглядело как "кнопка не работает"
// (жалоба пользователя 27 авг про аналогичную кнопку у счётчика, см. backgroundMercuryPollMeter).
async function backgroundPollModem(modem) {
  const st = state.getModemState(modem.id);
  if (st.pollingPromise) return st.pollingPromise;
  if (Date.now() - st.lastUserCmd < 12000) return;   // уступаем недавним командам управления
  st.pollingPromise = (async () => {
    try {
      const online = await modemOnline(modem.imei);
      if (!online) { st.cachedStatus = { online: false, ts: Date.now() }; return; }
      const data = await state.serializeGpioFor(modem.id, () => pollAllOnce(modem.imei));
      const reconnecting = !data.pins && !data.csq && !data.temp && !data.lbs;
      saveModemSnapshot(modem.id, data.csq ? data.csq.csq : null, data.temp);
      st.cachedStatus = {
        online: true, reconnecting,
        pins: data.pins || st.cachedStatus.pins || null,
        csq:  data.csq  || st.cachedStatus.csq  || null,
        temp: data.temp != null ? data.temp : (st.cachedStatus.temp ?? null),
        lbs:  data.lbs  || st.cachedStatus.lbs  || null,
        load: loadStatus(data.pins || st.cachedStatus.pins, st.loadCfg), loadCfg: st.loadCfg,
        ts: Date.now(),
      };
    } catch (e) { /* оставляем прошлый кэш */ }
    finally { st.pollingPromise = null; }
  })();
  return st.pollingPromise;
}

// ── Фоновый опрос счётчика (мгновенные величины + профиль получасовок) ───────
// Дедупликация через общий промис (см. коммент у backgroundPollModem выше) — иначе клик
// "Опросить счётчик сейчас" во время уже идущего фонового опроса тихо получал старые данные,
// пользователю казалось, что кнопка не работает (жалоба 27 авг: "данные не поменялись").
//
// priority (ручной клик "Опросить счётчик сейчас", см. /api/mercury/refresh) — своя, ОТДЕЛЬНАЯ
// от фонового pollingPromise дедупликация (manualPollingPromise). Если бы дедуп был общим,
// ручной клик, пришедшийся на уже ИДУЩИЙ фоновый опрос ЭТОГО ЖЕ счётчика (обычная ситуация сразу
// после тика — см. tickAllMercury), просто повис бы на том же низкоприоритетном промисе и ждал
// бы своей очереди в общей очереди шины (см. modemState.js serializeFor), а не обгонял её —
// приоритет тогда достался бы только следующему тику, а не этому клику. С отдельным слотом
// ручной клик всегда стартует СВОЙ новый опрос с priority:true, который обгонит в очереди шины
// любые ещё не начатые фоновые задачи (лишний повторный опрос того же счётчика — небольшая
// цена, доли секунды на шине, зато клик гарантированно не ждёт всю очередь).
async function backgroundMercuryPollMeter(modem, meter, { priority = false } = {}) {
  const st = state.getMeterState(meter.id);
  const key = priority ? 'manualPollingPromise' : 'pollingPromise';
  if (st[key]) return st[key];
  if (!priority && Date.now() - state.getModemState(modem.id).lastUserCmd < 12000) return;
  st[key] = (async () => {
    try {
      const port = await getCollectorPort(modem.imei);
      if (!port) throw new Error('у модема ещё нет прозрачного порта Collector');
      const cfg = { host: COLLECTOR_HOST, port, addr: meter.addr, password: meter.password };
      const r = await state.serializeFor(modem.id, () => pollMercury(cfg), { priority });
      // energy теперь не приходит с обычным опросом (см. коммент в mercuryPoll.js pollMercury) —
      // сохраняем последнее известное значение из профильного цикла (см.
      // backgroundMercuryProfilePollMeter), не затираем null'ом.
      st.cachedMercury = { online: true, ...r, energy: st.cachedMercury.energy || null, ts: Date.now() };
      saveInstantSnapshot(meter.id, r);
      if (!meter.serial_number) {
        try {
          const serial = await state.serializeFor(modem.id, () => readSerial(cfg), { priority });
          if (serial) {
            const mdate = `${serial.manufactureYear}-${String(serial.manufactureMonth).padStart(2, '0')}-${String(serial.manufactureDay).padStart(2, '0')}`;
            db.prepare('UPDATE meters SET serial_number = ?, manufacture_date = ? WHERE id = ?')
              .run(serial.serial, mdate, meter.id);
          }
        } catch (e) { /* паспортные данные не критичны — не мешаем обычному опросу при сбое */ }
      }
    } catch (e) {
      st.cachedMercury = {
        online: false, error: e.message, ts: Date.now(),
        voltage: st.cachedMercury.voltage || null, current: st.cachedMercury.current || null,
        power: st.cachedMercury.power || null, powerQ: st.cachedMercury.powerQ || null,
        powerS: st.cachedMercury.powerS || null, powerFactor: st.cachedMercury.powerFactor || null,
        frequency: st.cachedMercury.frequency, temperature: st.cachedMercury.temperature,
        events: st.cachedMercury.events || null, tariff: st.cachedMercury.tariff || null,
        energy: st.cachedMercury.energy || null,
      };
    } finally { st[key] = null; }
  })();
  return st[key];
}
// Записать пачку записей профиля в БД одной транзакцией. UPSERT, а не INSERT OR REPLACE — та
// затирала бы всю строку целиком, включая колонки мгновенных величин (см. saveInstantSnapshot
// ниже) — эти два источника пишут в одну и ту же сетку readings(meter_id,date,slot) независимо,
// каждый должен трогать только свои колонки.
const insertReadingStmt = db.prepare(`
  INSERT INTO readings (meter_id, date, slot, kwh, incomplete) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(meter_id, date, slot) DO UPDATE SET kwh = excluded.kwh, incomplete = excluded.incomplete`);
const saveReadings = db.transaction((meterId, records) => {
  for (const r of records) insertReadingStmt.run(meterId, r.date, r.slot, r.kwh, r.incomplete ? 1 : 0);
});
// Условие остановки опроса профиля («эту запись я уже видел»). Проверять НАЛИЧИЕ СТРОКИ здесь
// нельзя: в readings на ту же сетку (meter_id, date, slot) пишет ещё и «Регистратор» — его
// 10-минутные слоты :00/:10/…/:50 накрывают получасовые :00/:30 профиля, и строка на нужный
// получас почти всегда уже создана мгновенным опросом, с kwh = NULL (см. saveInstantSnapshot).
// Со старым условием pollProfile упирался в такую строку на смещении 0, выходил с 'caught-up'
// и не писал НИЧЕГО — а пропущенный получас становился незаполняемым навсегда, потому что
// строка для него уже была. Так с 30 августа потерялась почти вся получасовка на восьми ПУ
// (5 сент: на 04.09 у ПУ 41 строки есть на всех 48 слотах, а kwh — только в 33).
function meterHasReading(meterId) {
  const stmt = db.prepare(
    'SELECT 1 FROM readings WHERE meter_id = ? AND date = ? AND slot = ? AND kwh IS NOT NULL');
  return (date, slot) => !!stmt.get(meterId, date, slot);
}

// ── Самозапись почасовки из накопленной энергии (05h) ──────────────────────────────────────────
// Не зависит от профиля счётчика (06h/16h) — тот на части приборов (напр. Меркурий 230, см.
// память проекта) не отдаёт историю вообще. aPlus и так читается pollEnergy() каждые 10 мин
// (см. backgroundMercuryProfilePollMeter) — новых запросов на шину не добавляет, только новая
// серверная логика поверх уже читаемого значения.
// VPS работает в Etc/UTC (см. `date`/`timezone` на сервере), объекты — в Москве (UTC+3,
// круглый год без перехода на летнее/зимнее с 2014 — сдвиг можно жёстко зашить константой).
// getHours()/getDate() без поправки считали бы час/дату по UTC, и самозапись маркировала бы
// каждый час на 3 часа РАНЬШЕ настоящего московского (баг найден 29 авг — "почасовки на 230х
// пишутся с опозданием на 3 часа": это не задержка опроса, опрос свежий, а неверная метка
// времени). Профиль счётчика (06h/16h) этим не страдает — там час берётся из часов самого
// счётчика, уже выставленных на местное время, а не из серверного Date.
const SITE_TZ_OFFSET_MS = 3 * 60 * 60 * 1000;
function hourSlot(ms) {
  const d = new Date(ms + SITE_TZ_OFFSET_MS);
  const p2 = n => String(n).padStart(2, '0');
  return { date: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`, slot: `${p2(d.getUTCHours())}:00` };
}
const getSelfBaselineStmt = db.prepare('SELECT last_energy_kwh, last_energy_at FROM meters WHERE id = ?');
const setSelfBaselineStmt = db.prepare('UPDATE meters SET last_energy_kwh = ?, last_energy_at = ? WHERE id = ?');
const addSelfEnergyStmt = db.prepare(`
  INSERT INTO readings (meter_id, date, slot, kwh_self, incomplete_self) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(meter_id, date, slot) DO UPDATE SET
    kwh_self = COALESCE(kwh_self, 0) + excluded.kwh_self,
    incomplete_self = MAX(COALESCE(incomplete_self, 0), excluded.incomplete_self)`);
// Транзакция: чтение старой точки отсчёта, запись дельты и обновление точки отсчёта — атомарно,
// иначе рестарт демона между обновлением baseline и записью дельты мог бы задвоить или потерять
// кусок энергии.
const applySelfEnergy = db.transaction((meterId, aPlusKwh, now) => {
  const prev = getSelfBaselineStmt.get(meterId);
  setSelfBaselineStmt.run(aPlusKwh, now, meterId);
  if (prev.last_energy_kwh == null || prev.last_energy_at == null) return; // первая точка — только запомнить
  const gapMs = now - prev.last_energy_at;
  const delta = aPlusKwh - prev.last_energy_kwh;
  if (delta < 0) return; // сброс/замена счётчика — не пишем отрицательную "энергию", просто перебазировались выше
  if (gapMs > SELF_ENERGY_MAX_GAP_MS) return; // слишком большой разрыв — не размазываем несколько часов простоя на один час
  if (delta === 0 && gapMs <= SELF_ENERGY_WARN_GAP_MS) return; // нечего писать, не плодим нулевые строки на ровном месте
  const { date, slot } = hourSlot(prev.last_energy_at); // относим к часу, где НАЧАЛСЯ интервал накопления
  addSelfEnergyStmt.run(meterId, date, slot, delta, gapMs > SELF_ENERGY_WARN_GAP_MS ? 1 : 0);
});

// ── «Регистратор»: история мгновенных величин (см. память проекта) ────────────────────────────
// Своя сетка времени — 10-минутные слоты (:00/:10/…/:50), НЕ совпадает с получасовыми слотами
// профиля энергии счётчика (:00/:30) — на одну и ту же дату оба источника пишут в одну таблицу
// readings, просто на разные строки (кроме :00/:30, где строка общая, но колонки не пересекаются).
// Та же поправка на московское время, что и в hourSlot() выше (сервер в UTC, объекты в MSK).
function tenMinSlot(d = new Date()) {
  const t = new Date(d.getTime() + SITE_TZ_OFFSET_MS);
  const p2 = n => String(n).padStart(2, '0');
  return {
    date: `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`,
    slot: `${p2(t.getUTCHours())}:${p2(Math.floor(t.getUTCMinutes() / 10) * 10)}`,
  };
}
// Сдвиг календарной ISO-даты ('YYYY-MM-DD') на N дней — счёт в UTC-календаре (Date.UTC), без
// парсинга строки как местной полуночи, тот же приём, что и в index.html addDaysIso (баг с
// не листающейся вперёд стрелкой регистратора, 30 авг) — здесь нужен для расчёта стоимости
// энергии по периодам с разными тарифными ставками, см. computeSiteTariffCost.
function addDaysStr(dateStr, delta) {
  const [Y, M, D] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(Y, M - 1, D + delta)).toISOString().slice(0, 10);
}
const insertInstantStmt = db.prepare(`
  INSERT INTO readings (meter_id, date, slot, u_a, u_b, u_c, i_a, i_b, i_c, p, q, s, pf, freq, temp)
  VALUES (@meterId, @date, @slot, @uA, @uB, @uC, @iA, @iB, @iC, @p, @q, @s, @pf, @freq, @temp)
  ON CONFLICT(meter_id, date, slot) DO UPDATE SET
    u_a=excluded.u_a, u_b=excluded.u_b, u_c=excluded.u_c,
    i_a=excluded.i_a, i_b=excluded.i_b, i_c=excluded.i_c,
    p=excluded.p, q=excluded.q, s=excluded.s, pf=excluded.pf, freq=excluded.freq, temp=excluded.temp`);
// Внутри 10-минутного окна пишем каждый опрос (раз в MERCURY_BUS_POLL_SEC) — последнее значение
// в окне побеждает (не среднее за интервал: проще, без накопления состояния между опросами, и
// process restart ничего не теряет — приемлемая точность для регистратора уровня "что было
// приблизительно в этот момент", не для коммерческого учёта, для него уже есть readings.kwh).
function saveInstantSnapshot(meterId, r) {
  if (!r) return;
  const { date, slot } = tenMinSlot();
  insertInstantStmt.run({
    meterId, date, slot,
    uA: r.voltage?.A ?? null, uB: r.voltage?.B ?? null, uC: r.voltage?.C ?? null,
    iA: r.current?.A ?? null, iB: r.current?.B ?? null, iC: r.current?.C ?? null,
    p: r.power?.total ?? null, q: r.powerQ?.total ?? null, s: r.powerS?.total ?? null,
    pf: r.powerFactor?.total ?? null, freq: r.frequency ?? null, temp: r.temperature ?? null,
  });
}
// Та же схема хранения — история модема (сигнал/температура модуля) тоже в БД, не в памяти
// процесса. Раньше жила отдельным JSON-файлом на диске (см. модemState.js до 27 авг) — с тем же
// ограничением в 240 точек и полной потерей при рестарте; теперь один источник правды, как и для
// счётчиков.
const insertModemInstantStmt = db.prepare(`
  INSERT INTO modem_readings (modem_id, date, slot, csq, temp)
  VALUES (@modemId, @date, @slot, @csq, @temp)
  ON CONFLICT(modem_id, date, slot) DO UPDATE SET csq=excluded.csq, temp=excluded.temp`);
function saveModemSnapshot(modemId, csq, temp) {
  if (csq == null && temp == null) return;
  const { date, slot } = tenMinSlot();
  insertModemInstantStmt.run({ modemId, date, slot, csq: csq ?? null, temp: temp ?? null });
}

// Обычный периодический опрос почасовок (счётчик уже когда-то догружен) — обычно 0-2 новых
// записи за цикл, т.к. период интегрирования 30 мин, а опрос идёт чаще.
async function backgroundMercuryProfilePollMeter(modem, meter) {
  const st = state.getMeterState(meter.id);
  if (st.profilePolling || backfillJobs.get(meter.id)?.running) return;
  if (Date.now() - state.getModemState(modem.id).lastUserCmd < 12000) return;
  st.profilePolling = true;
  try {
    const port = await getCollectorPort(modem.imei);
    if (!port) throw new Error('у модема ещё нет прозрачного порта Collector');
    const cfg = { host: COLLECTOR_HOST, port, addr: meter.addr, password: meter.password };
    const result = await state.serializeFor(modem.id, () => pollProfile(cfg, {
      alreadyHave: meterHasReading(meter.id),
      maxRecords: POLL_MAX_RECORDS,
    }));
    if (result.records.length) saveReadings(meter.id, result.records);
    if (!meter.meter_constant && result.meterConstant) {
      db.prepare('UPDATE meters SET meter_constant = ? WHERE id = ?').run(result.meterConstant, meter.id);
    }
    if (!meter.backfilled_at) startBackfill(modem, meter); // первый успешный опрос — запускаем догрузку истории
    st.profileLastError = result.stopReason === 'no-response' ? 'счётчик не ответил при опросе профиля' : null;
    // Накопленная энергия по тарифам — раз в 10 мин здесь, а не на каждом 60-секундном опросе
    // (см. mercuryPoll.js pollMercury). Свой try — сбой энергии не должен портить уже успешно
    // прочитанный профиль/meterConstant выше.
    try {
      const energy = await state.serializeFor(modem.id, () => pollEnergy(cfg));
      st.cachedMercury.energy = energy;
      if (energy?.sum?.aPlus != null) applySelfEnergy(meter.id, energy.sum.aPlus, Date.now());
    } catch (e) { /* оставляем прошлое значение energy — не критично */ }
  } catch (e) {
    st.profileLastError = e.message;
  } finally {
    st.profileLastPollTs = Date.now();
    st.profilePolling = false;
  }
}

// Первая полная догрузка истории — тот же pollProfile, но alreadyHave всегда false (идём
// вглубь, пока не наткнёмся на разрыв непрерывности — см. mercuryProfilePoll.js). Асинхронная
// задача с прогрессом (тот же паттерн, что и скан шины, см. scanJobs).
// maxRecords вынесен в параметр: та же машинерия обслуживает и первую полную догрузку истории
// (по умолчанию вся память счётчика), и точечное дозаполнение дыр за последние сутки-недели
// (см. /api/mercury/profile/repair) — там идти вглубь на 24 месяца незачем, это часы на шине.
function startBackfill(modem, meter, { maxRecords = BACKFILL_MAX_RECORDS } = {}) {
  const existing = backfillJobs.get(meter.id);
  if (existing && existing.running) return;
  const job = { running: true, offsetsRead: 0, recordsFound: 0, done: false, error: null, stopReason: null, startedAt: Date.now() };
  backfillJobs.set(meter.id, job);
  state.serializeFor(modem.id, async () => {
    const port = await getCollectorPort(modem.imei);
    if (!port) throw new Error('у модема ещё нет прозрачного порта Collector');
    const cfg = { host: COLLECTOR_HOST, port, addr: meter.addr, password: meter.password };
    return pollProfile(cfg, {
      alreadyHave: () => false,
      maxRecords,
      onProgress: (offset, found) => { job.offsetsRead = offset; job.recordsFound = found; },
    });
  }).then(result => {
    if (result.records.length) saveReadings(meter.id, result.records);
    if (result.meterConstant) db.prepare('UPDATE meters SET meter_constant = ? WHERE id = ?').run(result.meterConstant, meter.id);
    db.prepare('UPDATE meters SET backfilled_at = ? WHERE id = ?').run(Date.now(), meter.id);
    job.stopReason = result.stopReason;
    job.recordsFound = result.records.length;
  }).catch(e => {
    job.error = e.message;
  }).finally(() => {
    job.running = false;
    job.done = true;
  });
}

// Ротация: не больше RETENTION_MONTHS месяцев почасовок на счётчик — и той же политикой на
// историю модема (modem_readings), у неё раньше не было ротации вообще (недосмотр, копилась бы
// бесконечно — заметил пользователь сразу после того, как эта таблица появилась).
function rotateReadings() {
  const meters = db.prepare('SELECT id FROM meters').all();
  for (const { id } of meters) {
    const months = db.prepare(
      'SELECT DISTINCT substr(date,1,7) AS ym FROM readings WHERE meter_id = ? ORDER BY ym DESC').all(id);
    if (months.length <= RETENTION_MONTHS) continue;
    const cutoffMonth = months[RETENTION_MONTHS].ym; // первый месяц, который уже лишний
    db.prepare('DELETE FROM readings WHERE meter_id = ? AND substr(date,1,7) <= ?').run(id, cutoffMonth);
  }
  const modems = db.prepare('SELECT id FROM modems').all();
  for (const { id } of modems) {
    const months = db.prepare(
      'SELECT DISTINCT substr(date,1,7) AS ym FROM modem_readings WHERE modem_id = ? ORDER BY ym DESC').all(id);
    if (months.length <= RETENTION_MONTHS) continue;
    const cutoffMonth = months[RETENTION_MONTHS].ym;
    db.prepare('DELETE FROM modem_readings WHERE modem_id = ? AND substr(date,1,7) <= ?').run(id, cutoffMonth);
  }
}

// ── Целостность сбора: детектор пропусков и молчания ──────────────────────────
// Первый детектор раздела «Уведомления и отклонения» и единственный, которому не нужен прогрев
// статистики: пороги здесь абсолютные, а не выведенные из истории прибора, поэтому работает с
// первого дня. Поставлен первым осознанно — поломка сбора получасовок 30 авг всплыла только
// 5 сент и прожила неделю незамеченной ровно потому, что за полнотой данных никто не следил
// (профиль молча возвращал 'caught-up', см. комментарий у meterHasReading).
//
// Считает ТОЛЬКО по уже накопленной БД, на шину RS-485 не ходит — поэтому тик может быть частым
// и ни с чем не конкурирует.
const ALERT_TICK_MS = 15 * 60 * 1000;
const GAP_WINDOW_H = 6;         // глубина окна, за которое меряем полноту
const GAP_LAG_H = 1;            // ...не считая последнего часа: свежие срезы законно ещё в пути
const GAP_OPEN_BELOW = 0.80;    // ниже этой доли собранного — открываем инцидент
const GAP_CLOSE_ABOVE = 0.95;   // выше этой — закрываем; зазор между порогами и есть гистерезис
const SILENT_MS = 30 * 60 * 1000;
const ALERT_DWELL = 2;          // тиков подряд с условием до открытия (~30 мин) — антидребезг
const NEW_METER_GRACE_MS = 2 * 3600 * 1000; // только что заведённый ПУ ещё не обязан иметь данные

const alertDwell = new Map();   // 'kind|subject' -> сколько тиков подряд держится условие
const PROCESS_STARTED_AT = Date.now();

// Метка «дата + слот» в местном времени объекта — той же сеткой, что пишут saveInstantSnapshot и
// applySelfEnergy (см. SITE_TZ_OFFSET_MS). Диапазон сравнивается лексикографически по строке
// 'YYYY-MM-DD HH:MM', поэтому окно спокойно переходит через полночь.
function localStamp(ms) {
  const d = new Date(ms + SITE_TZ_OFFSET_MS);
  const p2 = n => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  return { date, key: `${date} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` };
}
const profileEverStmt = db.prepare(
  'SELECT 1 FROM readings WHERE meter_id = ? AND kwh IS NOT NULL LIMIT 1');
const countKwhStmt = db.prepare(`
  SELECT COUNT(*) n FROM readings WHERE meter_id = ? AND date >= ? AND date <= ?
     AND (date || ' ' || slot) > ? AND (date || ' ' || slot) <= ? AND kwh IS NOT NULL`);
const countSelfStmt = db.prepare(`
  SELECT COUNT(*) n FROM readings WHERE meter_id = ? AND date >= ? AND date <= ?
     AND (date || ' ' || slot) > ? AND (date || ' ' || slot) <= ? AND kwh_self IS NOT NULL`);

// Источник истины по энергии у разных приборов разный: где профиль (06h/16h) хоть раз отдавал
// данные — ждём его получасовки (2 среза в час), где не отдавал никогда (Меркурий 230) — ждём
// самозапись из дельты 05h (1 срез в час). Иначе 230-е висели бы в вечной тревоге за то, чего
// они в принципе не умеют.
function dataCoverage(meterId) {
  const to = Date.now() - GAP_LAG_H * 3600 * 1000;
  const from = to - GAP_WINDOW_H * 3600 * 1000;
  const a = localStamp(from), b = localStamp(to);
  const usesProfile = !!profileEverStmt.get(meterId);
  const stmt = usesProfile ? countKwhStmt : countSelfStmt;
  const expected = usesProfile ? GAP_WINDOW_H * 2 : GAP_WINDOW_H;
  const got = Math.min(stmt.get(meterId, a.date, b.date, a.key, b.key).n, expected);
  return { usesProfile, expected, got, ratio: got / expected };
}

const findOpenAlertStmt = db.prepare(
  'SELECT id FROM alerts WHERE kind = ? AND subject = ? AND closed_at IS NULL');
const insertAlertStmt = db.prepare(`
  INSERT INTO alerts (project_id, subject, meter_id, modem_id, kind, severity,
                      opened_at, last_seen_at, value, threshold, detail)
  VALUES (@projectId, @subject, @meterId, @modemId, @kind, @severity,
          @now, @now, @value, @threshold, @detail)`);
const touchAlertStmt = db.prepare(
  'UPDATE alerts SET last_seen_at = ?, value = ?, detail = ? WHERE id = ?');
const closeAlertStmt = db.prepare('UPDATE alerts SET closed_at = ? WHERE id = ?');

// Русские подписи вида инцидента для письма — дублирует AL_KIND в index.html (та же логика, что
// у VERIFICATION_STEPS/objDueLevel: на клиенте считает клиент, здесь для другой цели, общего
// места нет). Если добавится новый вид инцидента — обновить оба места.
const ALERT_KIND_LABEL = {
  'data-gap': 'Пропуски в сборе данных', 'meter-silent': 'Счётчик не отвечает',
  'modem-offline': 'Модем не на связи',
  'energy-day': 'Превышен суточный лимит', 'energy-week': 'Превышен недельный лимит',
  'energy-month': 'Превышен месячный лимит',
};
const notifyProjectStmt = db.prepare('SELECT name, notify_email FROM projects WHERE id = ?');
// Письмо шлём ТОЛЬКО в момент открытия НОВОГО инцидента (просьба 07.09.2026, по всем видам
// сразу) — не на touch (условие всё ещё держится) и не на закрытие: иначе, пока восьмичасовой
// data-gap на одном счётчике держится, письмо переливалось бы каждые 15 минут туда же. Ошибку
// самой отправки (SMTP недоступен, адрес не настроен) не даём уронить сам детектор — раз в 15
// минут это фоновый тик, а не запрос пользователя, падать тут не на что реагировать немедленно.
function notifyAlertByEmail(o) {
  const proj = notifyProjectStmt.get(o.projectId);
  if (!proj || !proj.notify_email) return;   // адрес не настроен — тихо пропускаем, это не ошибка
  const label = ALERT_KIND_LABEL[o.kind] || o.kind;
  mailer.sendMail({
    to: proj.notify_email,
    subject: `АСКУЭ · ${o.severity === 'crit' ? 'Критично' : 'Внимание'} · ${proj.name} · ${label}`,
    text: `${o.detail}\n\nОткрыть панель: https://askue.o-dir.ru/`,
  }).catch((e) => console.error('⚠️ письмо по инциденту не отправлено:', e.message));
}
function raiseAlert(o) {
  const now = Date.now();
  const cur = findOpenAlertStmt.get(o.kind, o.subject);
  if (cur) { touchAlertStmt.run(now, o.value, o.detail, cur.id); return; }
  const key = o.kind + '|' + o.subject;
  const n = (alertDwell.get(key) || 0) + 1;
  alertDwell.set(key, n);
  // Удержание нужно там, где замер шумит (полнота сбора, молчание прибора). Для лимита оно вредно:
  // расход внутри периода монотонно растёт, «случайно превысить и вернуться» нельзя, и лишние
  // 15 минут задержки — это просто позже узнать. Такие правила передают dwell: 1.
  if (n < (o.dwell || ALERT_DWELL)) return;
  insertAlertStmt.run({
    projectId: o.projectId, subject: o.subject, meterId: o.meterId, modemId: o.modemId,
    kind: o.kind, severity: o.severity, now, value: o.value, threshold: o.threshold,
    detail: o.detail,
  });
  notifyAlertByEmail(o);
}
// Снять с наблюдения целиком: закрыть все открытые инциденты объекта и обнулить счётчики
// удержания, чтобы после возврата в работу отсчёт начинался заново, а не с середины.
const closeSubjectAlertsStmt = db.prepare(
  'UPDATE alerts SET closed_at = ? WHERE subject = ? AND closed_at IS NULL');
function retireAlerts(subject) {
  closeSubjectAlertsStmt.run(Date.now(), subject);
  for (const k of [...alertDwell.keys()]) if (k.endsWith('|' + subject)) alertDwell.delete(k);
}
function clearAlert(kind, subject) {
  alertDwell.delete(kind + '|' + subject);
  const cur = findOpenAlertStmt.get(kind, subject);
  if (cur) closeAlertStmt.run(Date.now(), cur.id);
}

// ── Лимиты потребления ────────────────────────────────────────────────────────
// Границы периодов считаются в МЕСТНОМ времени объекта (см. localStamp): сутки — сегодняшняя
// дата, неделя — с понедельника по сегодня, месяц — с первого числа по сегодня. Период всегда
// незакрытый, «сколько уже израсходовано», а не «сколько вышло по итогу» — иначе о превышении
// узнавали бы задним числом, когда сделать уже ничего нельзя.
const LIMIT_KINDS = ['energy-day', 'energy-week', 'energy-month'];
const LIMIT_PERIOD = { 'energy-day': 'сутки', 'energy-week': 'неделю', 'energy-month': 'месяц' };

function periodBounds(kind, todayStr) {
  if (kind === 'energy-day') return { from: todayStr, to: todayStr };
  if (kind === 'energy-week') {
    const [Y, M, D] = todayStr.split('-').map(Number);
    const dow = new Date(Date.UTC(Y, M - 1, D)).getUTCDay();   // 0 — воскресенье
    return { from: addDaysStr(todayStr, -((dow + 6) % 7)), to: todayStr };
  }
  return { from: todayStr.slice(0, 8) + '01', to: todayStr };
}
const getLimitsStmt = db.prepare(
  "SELECT kind, value FROM limits WHERE scope = 'meter' AND scope_id = ? AND enabled = 1");
function meterLimits(meterId) {
  const out = {};
  for (const r of getLimitsStmt.all(meterId)) out[r.kind] = r.value;
  return out;
}
// Расход в ПЕРВИЧНЫХ кВт·ч: лимит задаётся в том, что объект реально потребляет и за что платит,
// а не во вторичной стороне трансформатора тока (та же логика, что у scaleByCtRatio в «Объектах»).
function usedInPeriod(meterId, ctRatio, kind, todayStr) {
  const b = periodBounds(kind, todayStr);
  const used = sumConsumptionKwh(meterId, b.from, b.to) * (ctRatio || 1);
  return { from: b.from, to: b.to, used: Math.round(used * 1000) / 1000 };
}

const fmtRu = n => String(Math.round(n * 100) / 100).replace('.', ',');
// Проверка лимитов одного прибора. Снятого лимита достаточно, чтобы закрыть открытый по нему
// инцидент: правила больше нет — значит и нарушения нет. Само превышение закрывается сменой
// периода (расход обнулится) или поднятием порога.
function evaluateLimits(me, todayStr) {
  if (me.decommissioned_at) return;   // выведенный прибор не наблюдаем, см. retireAlerts
  const subject = 'meter:' + me.id;
  const name = me.label || ('счётчик #' + me.id);
  const base = { projectId: me.project_id, subject, meterId: me.id, modemId: me.modem_id };
  const limits = meterLimits(me.id);
  for (const kind of LIMIT_KINDS) {
    const lim = limits[kind];
    if (lim == null) { clearAlert(kind, subject); continue; }
    const u = usedInPeriod(me.id, me.ct_ratio, kind, todayStr);
    if (u.used > lim) {
      raiseAlert(Object.assign({}, base, {
        kind, severity: u.used > lim * 1.2 ? 'crit' : 'warn', dwell: 1,
        value: u.used, threshold: lim,
        detail: `${name}: за ${LIMIT_PERIOD[kind]} израсходовано ${fmtRu(u.used)} кВт·ч `
              + `при лимите ${fmtRu(lim)}`,
      }));
    } else clearAlert(kind, subject);
  }
}

function tickAlerts() {
  const now = Date.now();
  const todayStr = localStamp(now).date;
  const meters = db.prepare(`SELECT me.id, me.label, me.modem_id, me.created_at, me.ct_ratio,
                                    me.decommissioned_at, mo.project_id
                               FROM meters me JOIN modems mo ON me.modem_id = mo.id`).all();
  for (const me of meters) {
    const subject = 'meter:' + me.id;
    const name = me.label || ('счётчик #' + me.id);
    const base = { projectId: me.project_id, subject, meterId: me.id, modemId: me.modem_id };
    // Выведенный прибор не опрашивается, значит данных по нему заведомо не будет — без этой
    // ветки он навсегда повис бы с открытым «нет данных» о счётчике, которого уже нет.
    if (me.decommissioned_at) { retireAlerts(subject); continue; }
    if (now - (me.created_at || 0) < NEW_METER_GRACE_MS) continue;  // ещё не обязан ничего накопить

    const cov = dataCoverage(me.id);
    const pct = Math.round(cov.ratio * 100);
    const src = cov.usesProfile ? 'получасовок профиля' : 'часов самозаписи';
    if (cov.ratio < GAP_OPEN_BELOW) {
      raiseAlert(Object.assign({}, base, {
        kind: 'data-gap', severity: cov.ratio < 0.5 ? 'crit' : 'warn',
        value: cov.ratio, threshold: GAP_OPEN_BELOW,
        detail: `${name}: за последние ${GAP_WINDOW_H} ч собрано ${cov.got} из ${cov.expected} ${src} (${pct}%)`,
      }));
    } else if (cov.ratio >= GAP_CLOSE_ABOVE) {
      clearAlert('data-gap', subject);
    }   // между порогами не трогаем: открытый инцидент остаётся открытым, закрытый — закрытым

    // Молчание прибора: ts=0 значит «с момента старта процесса ни одного успешного опроса» —
    // тогда точкой отсчёта служит сам старт, иначе каждый рестарт давал бы ложную тревогу.
    const st = state.getMeterState(me.id);
    const since = st.cachedMercury.ts || PROCESS_STARTED_AT;
    const mins = Math.round((now - since) / 60000);
    if (now - since > SILENT_MS) {
      raiseAlert(Object.assign({}, base, {
        kind: 'meter-silent', severity: 'crit',
        value: mins, threshold: SILENT_MS / 60000,
        detail: `${name}: не отвечает ${mins} мин`,
      }));
    } else clearAlert('meter-silent', subject);

    evaluateLimits(me, todayStr);
  }

  for (const mo of db.prepare('SELECT id, label, imei, project_id FROM modems').all()) {
    const subject = 'modem:' + mo.id;
    const name = mo.label || ('модем ' + mo.imei);
    const st = state.getModemState(mo.id);
    const ts = st.cachedStatus.ts || PROCESS_STARTED_AT;
    const offline = !!st.cachedStatus.ts && !st.cachedStatus.online;
    if (offline || now - ts > SILENT_MS) {
      raiseAlert({
        projectId: mo.project_id, subject, meterId: null, modemId: mo.id,
        kind: 'modem-offline', severity: 'crit', value: null, threshold: null,
        detail: offline ? `${name}: нет связи`
                        : `${name}: нет свежих данных ${Math.round((now - ts) / 60000)} мин`,
      });
    } else clearAlert('modem-offline', subject);
  }
}

// ── Планировщик: раз в тик читаем список модемов/счётчиков из БД заново — новые
// подключённые проекты подхватываются без перезапуска процесса.
function allModemsFromDb() { return db.prepare('SELECT * FROM modems').all(); }
// Только приборы в работе: выведенные из эксплуатации (meters.decommissioned_at) исключаются из
// ФОНОВОГО опроса — иначе шина продолжала бы каждые две минуты стучаться в демонтированный
// счётчик и ждать таймаута, отнимая время у живых. Ручной опрос по кнопке при этом работает:
// перед возвратом прибора в работу полезно проверить, отвечает ли он.
function allMetersWithModem() {
  return db.prepare(`SELECT me.*, mo.imei AS modem_imei
                      FROM meters me JOIN modems mo ON me.modem_id = mo.id
                     WHERE me.decommissioned_at IS NULL`).all();
}
async function tickAllModems() {
  await Promise.allSettled(allModemsFromDb().map(m => backgroundPollModem(m)));
}
async function tickAllMercury() {
  const rows = allMetersWithModem();
  await Promise.allSettled(rows.map(r => backgroundMercuryPollMeter({ id: r.modem_id, imei: r.modem_imei }, r)));
}
async function tickAllProfiles() {
  const rows = allMetersWithModem();
  await Promise.allSettled(rows.map(r => backgroundMercuryProfilePollMeter({ id: r.modem_id, imei: r.modem_imei }, r)));
}
// Раньше 30с — избыточно часто для модема (лишняя нагрузка на сотовый канал/демон) с тех пор,
// как история всё равно уплотняется до 10-минутных срезов (см. saveModemSnapshot); совпадает
// с MERCURY_POLL_SEC для единообразия. Ручные действия (кнопка "Обновить", GPO вкл/выкл) не
// ждут этот таймер — идут отдельным немедленным опросом, см. /api/refresh, /api/gpo/:action.
setInterval(tickAllModems, MERCURY_POLL_SEC * 1000);
setTimeout(tickAllModems, 1500);
setInterval(tickAllMercury, MERCURY_BUS_POLL_SEC * 1000);
setTimeout(tickAllMercury, 5000);
setInterval(tickAllProfiles, 10 * 60 * 1000);
setTimeout(tickAllProfiles, 20000);
setInterval(rotateReadings, 24 * 3600 * 1000);
// Детектор целостности сбора — первый прогон не сразу: ему нужен уже наполненный кэш опроса,
// иначе сразу после старта всё выглядит молчащим (см. PROCESS_STARTED_AT в tickAlerts).
setInterval(tickAlerts, ALERT_TICK_MS);
setTimeout(tickAlerts, 3 * 60 * 1000);
setTimeout(rotateReadings, 30000);

// ── Журнал критических действий (P0-09) — см. db.js audit_logs, вызывается точечно из
// маршрутов ниже (смена тарифа, удаление счётчика/модема, impersonation, сброс пароля).
// НЕ должен ронять основной запрос при сбое (try/catch) — но и не должен терять сбой молча:
// pre-commit ревью этой задачи прямо потребовало, чтобы неудачная запись была видна в
// pm2 logs с указанием, какое именно действие не залогировано, а не проглатывалась тихо.
const insertAuditLogStmt = db.prepare(
  `INSERT INTO audit_logs (at, actor_role, actor_id, actor_username, project_id, action, target, detail)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
function logAudit(req, action, target, detail) {
  try {
    const actorRole = req.actor ? req.actor.role : null;
    const actorId = req.actor ? req.actor.actor_id : null;
    let actorUsername = null;
    if (req.actor) {
      const table = req.actor.role === 'admin' ? 'admins' : 'users';
      const row = db.prepare(`SELECT username FROM ${table} WHERE id = ?`).get(req.actor.actor_id);
      actorUsername = row ? row.username : null;
    }
    insertAuditLogStmt.run(Date.now(), actorRole, actorId, actorUsername, req.projectId || null, action, target || null, detail || null);
  } catch (e) {
    console.error(`⚠️ audit_logs: не удалось записать действие "${action}" (target=${target || '—'}) —`, e.message);
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1); // за nginx (SSL терминируется там, X-Forwarded-Proto прокинут)
app.use(express.json({ limit: '10mb' })); // лимит поднят ради base64-скриншотов лэндинга, см. /api/landing/upload

// ── Авторизация ────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'логин и пароль обязательны' });
  }
  // P0-03: троттлинг по (IP, логин) — до обращения к bcrypt, не после (см. loginRateLimit.js).
  if (!loginRateLimit.checkAllowed(req.ip, username)) {
    return res.status(429).json({ error: 'слишком много неудачных попыток входа, попробуйте позже' });
  }
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (admin && auth.verifyPassword(password, admin.password_hash)) {
    loginRateLimit.recordSuccess(req.ip, username);
    const token = auth.createSession('admin', admin.id, null);
    auth.setCookie(res, token);
    return res.json({ ok: true, redirect: '/admin.html' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (user && auth.verifyPassword(password, user.password_hash)) {
    if (user.access_until && user.access_until < Date.now()) {
      // Верные учётные данные, но истёкший доступ — не признак перебора, счётчик не трогаем.
      return res.status(401).json({ error: 'доступ истёк' });
    }
    loginRateLimit.recordSuccess(req.ip, username);
    const token = auth.createSession('user', user.id, user.project_id);
    auth.setCookie(res, token);
    return res.json({ ok: true, redirect: '/' });
  }
  loginRateLimit.recordFailure(req.ip, username);
  res.status(401).json({ error: 'неверный логин или пароль' });
});
app.post('/api/logout', (req, res) => {
  const token = auth.parseCookies(req)[auth.COOKIE_NAME];
  if (token) auth.destroySession(token);
  auth.clearCookie(res);
  res.json({ ok: true });
});
app.get('/api/me', auth.requireAuth, (req, res) => {
  let projectName = null;
  if (req.projectId) {
    const p = db.prepare('SELECT name FROM projects WHERE id = ?').get(req.projectId);
    projectName = p ? p.name : null;
  }
  const table = req.actor.role === 'admin' ? 'admins' : 'users';
  const actorRow = db.prepare(`SELECT username FROM ${table} WHERE id = ?`).get(req.actor.actor_id);
  res.json({
    role: req.actor.role,
    username: actorRow ? actorRow.username : null,
    isImpersonating: !!req.isImpersonating,
    projectId: req.projectId,
    projectName,
    accessRole: req.accessRole || null,
  });
});

app.use(auth.requireAuth);

// Роль «Пользователь» (access_role='limited', см. db.js) видит в кабинете только раздел
// «Объекты» — это не просто скрытые кнопки на клиенте (index.html прячет остальные вкладки), а
// жёсткое ограничение API: без него достаточно открыть devtools, чтобы дёрнуть, например, DELETE
// счётчика или смену тарифа в обход интерфейса. Список разрешённых префиксов — ровно то, что
// реально дёргает клиент в режиме "только Объекты" (см. checkContext()/checkSession() в
// index.html): свои данные (/api/me), логаут, привязанный модем (для страницы "модем не найден")
// и сам раздел «Объекты».
const LIMITED_ROLE_ALLOWED = ['/api/me', '/api/logout', '/api/context', '/api/objects'];
app.use((req, res, next) => {
  if (req.actor && req.actor.role === 'user' && req.accessRole === 'limited' && req.path.startsWith('/api/')) {
    const allowed = LIMITED_ROLE_ALLOWED.some(p => req.path === p || req.path.startsWith(p + '/'));
    if (!allowed) return res.status(403).json({ error: 'недостаточно прав' });
  }
  next();
});

// ── Админ-кабинет ────────────────────────────────────────────────────────────
app.get('/admin.html', auth.requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/api/admin/projects', auth.requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.created_at,
           (SELECT COUNT(*) FROM users u WHERE u.project_id = p.id) AS user_count,
           (SELECT COUNT(*) FROM sites s WHERE s.project_id = p.id) AS site_count,
           (SELECT COUNT(*) FROM modems m WHERE m.project_id = p.id) AS modem_count,
           (SELECT COUNT(*) FROM meters me JOIN modems m2 ON me.modem_id = m2.id WHERE m2.project_id = p.id) AS meter_count,
           (SELECT COUNT(*) FROM readings r JOIN meters me2 ON r.meter_id = me2.id
              JOIN modems m3 ON me2.modem_id = m3.id WHERE m3.project_id = p.id) AS readings_count
    FROM projects p
    ORDER BY p.id
  `).all();

  // Размер проекта в БД — реальные занятые страницы SQLite (dbstat), а не оценка "на глаз",
  // разложенные пропорционально числу строк по проектам. readings + её индекс на 2-3 порядка
  // больше всего остального (см. память проекта — регистратор пишет туда мгновенные величины
  // каждые 10 минут); modems/meters добавлены для полноты ("вся база"), их вклад на практике
  // почти нулевой. sessions/admins/users/projects/sqlite-служебные — не данные конкретного
  // проекта, не считаем.
  let projects = rows.map(r => ({ ...r, sizeMb: null }));
  try {
    const totalReadings = db.prepare('SELECT COUNT(*) AS n FROM readings').get().n || 1;
    const totalModems = db.prepare('SELECT COUNT(*) AS n FROM modems').get().n || 1;
    const totalMeters = db.prepare('SELECT COUNT(*) AS n FROM meters').get().n || 1;
    const pageBytes = {};
    for (const s of db.prepare(`SELECT name, SUM(pgsize) AS bytes FROM dbstat
        WHERE name IN ('readings','idx_readings_meter_month','modems','meters') GROUP BY name`).all()) {
      pageBytes[s.name] = s.bytes;
    }
    const readingsBytesTotal = (pageBytes.readings || 0) + (pageBytes.idx_readings_meter_month || 0);
    projects = rows.map(r => {
      const bytes = readingsBytesTotal * (r.readings_count / totalReadings)
        + (pageBytes.modems || 0) * (r.modem_count / totalModems)
        + (pageBytes.meters || 0) * (r.meter_count / totalMeters);
      return { ...r, sizeMb: Math.round(bytes / 1048576 * 1000) / 1000 };
    });
  } catch (e) { /* dbstat недоступна в этой сборке SQLite — просто не покажем размер */ }

  res.json({ projects });
});
app.post('/api/admin/projects', auth.requireAdmin, (req, res) => {
  const { projectName, username, password } = req.body || {};
  if (!projectName || !username || !password) {
    return res.status(400).json({ error: 'название проекта, логин и пароль обязательны' });
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'такой логин уже занят' });
  }
  const now = Date.now();
  const tx = db.transaction(() => {
    const project = db.prepare('INSERT INTO projects (name, created_at) VALUES (?, ?)').run(projectName, now);
    db.prepare(`INSERT INTO users (username, password_hash, project_id, access_role, access_until, created_at)
                VALUES (?, ?, ?, 'master', NULL, ?)`)
      .run(username, auth.hashPassword(password), project.lastInsertRowid, now);
    return project.lastInsertRowid;
  });
  res.json({ ok: true, projectId: tx() });
});

// Пользователи проекта (31 авг) — раньше был ровно один пользователь на проект, теперь админ
// может добавить несколько с разными правами (см. db.js access_role) и сроком доступа.
app.get('/api/admin/projects/:id/users', auth.requireAdmin, (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  const users = db.prepare(
    'SELECT id, username, access_role, access_until, created_at FROM users WHERE project_id = ? ORDER BY id'
  ).all(projectId);
  res.json({ users });
});
app.post('/api/admin/projects/:id/users', auth.requireAdmin, (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'проект не найден' });
  const { username, password, accessRole, accessUntil } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'логин и пароль обязательны' });
  if (accessRole !== 'master' && accessRole !== 'limited') {
    return res.status(400).json({ error: 'недопустимая роль' });
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'такой логин уже занят' });
  }
  let until = null;
  if (accessUntil) {
    until = new Date(accessUntil).getTime();
    if (!Number.isFinite(until)) return res.status(400).json({ error: 'недопустимая дата' });
  }
  const now = Date.now();
  const r = db.prepare(`INSERT INTO users (username, password_hash, project_id, access_role, access_until, created_at)
                         VALUES (?, ?, ?, ?, ?, ?)`)
    .run(username, auth.hashPassword(password), projectId, accessRole, until, now);
  res.json({ ok: true, userId: r.lastInsertRowid });
});
app.patch('/api/admin/users/:id', auth.requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'пользователь не найден' });
  const { accessRole, accessUntil } = req.body || {};
  if (accessRole !== undefined) {
    if (accessRole !== 'master' && accessRole !== 'limited') {
      return res.status(400).json({ error: 'недопустимая роль' });
    }
    db.prepare('UPDATE users SET access_role = ? WHERE id = ?').run(accessRole, id);
  }
  if (accessUntil !== undefined) {
    let until = null;
    if (accessUntil) {
      until = new Date(accessUntil).getTime();
      if (!Number.isFinite(until)) return res.status(400).json({ error: 'недопустимая дата' });
    }
    db.prepare('UPDATE users SET access_until = ? WHERE id = ?').run(until, id);
  }
  res.json({ ok: true });
});
// Сброс пароля пользователя (31 авг) — вместо хранения/показа пароля в открытом виде (пароли
// в БД — только bcrypt-хеш, необратимо) админ задаёт новый и сообщает его пользователю сам.
// Заодно рвём его текущие сессии — иначе смена пароля не выглядела бы завершённой, пока старая
// сессия ещё жива где-то на другом устройстве.
app.post('/api/admin/users/:id/reset-password', auth.requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'пользователь не найден' });
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'введите новый пароль' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), id);
  db.prepare("DELETE FROM sessions WHERE role = 'user' AND actor_id = ?").run(id);
  logAudit(req, 'user.reset_password', `user:${id}`);
  res.json({ ok: true });
});
app.delete('/api/admin/users/:id', auth.requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'пользователь не найден' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  db.prepare("DELETE FROM sessions WHERE role = 'user' AND actor_id = ?").run(id);
  res.json({ ok: true });
});

// Объекты (площадки/здания) проекта (31 авг, см. db.js sites) — создаёт и удаляет только админ;
// Мастер только привязывает к ним уже существующие счётчики (см. /api/mercury/config ниже).
app.get('/api/admin/projects/:id/sites', auth.requireAdmin, (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  const sites = db.prepare('SELECT id, name, created_at FROM sites WHERE project_id = ? ORDER BY id').all(projectId);
  res.json({ sites });
});
app.post('/api/admin/projects/:id/sites', auth.requireAdmin, (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'проект не найден' });
  const name = typeof (req.body && req.body.name) === 'string' ? req.body.name.trim().slice(0, 120) : '';
  if (!name) return res.status(400).json({ error: 'укажите название объекта' });
  const r = db.prepare('INSERT INTO sites (project_id, name, created_at) VALUES (?, ?, ?)').run(projectId, name, Date.now());
  res.json({ ok: true, siteId: r.lastInsertRowid });
});
app.delete('/api/admin/sites/:id', auth.requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const site = db.prepare('SELECT id FROM sites WHERE id = ?').get(id);
  if (!site) return res.status(404).json({ error: 'объект не найден' });
  // Осиротевшие счётчики просто теряют привязку (site_id = NULL), сам счётчик не трогаем — он
  // продолжает опрашиваться, просто временно не показывается в разделе «Объекты» до перепривязки.
  db.prepare('UPDATE meters SET site_id = NULL WHERE site_id = ?').run(id);
  db.prepare('DELETE FROM sites WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.post('/api/admin/impersonate/:projectId', auth.requireAdmin, (req, res) => {
  const projectId = parseInt(req.params.projectId, 10);
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'проект не найден' });
  auth.setImpersonation(req.sessionToken, projectId);
  logAudit(req, 'impersonate.start', `project:${projectId}`);
  res.json({ ok: true });
});
app.post('/api/admin/stop-impersonate', auth.requireAdmin, (req, res) => {
  // До очистки — иначе impersonating_project_id уже NULL и нечего записать в target.
  const wasProjectId = req.actor ? req.actor.impersonating_project_id : null;
  auth.clearImpersonation(req.sessionToken);
  logAudit(req, 'impersonate.stop', wasProjectId ? `project:${wasProjectId}` : null);
  res.json({ ok: true });
});

// ── Лэндинг (офлайн, на согласовании) ─────────────────────────────────────────
// Страница сама по себе тоже за auth.requireAdmin (см. паттерн /admin.html выше) — пока не
// согласована с пользователем, посторонним её не видно вообще. Когда будем публиковать, эту
// строку и /api/landing/images (GET) нужно перенести в auth.PUBLIC_PATHS — сам факт просмотра
// готовых фото не секрет, секретна только возможность их менять (см. requireAdmin на upload/delete
// ниже, он никуда не денется).
app.get('/landing.html', auth.requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));

app.get('/api/landing/images', (req, res) => {
  const rows = db.prepare('SELECT slot, filename FROM landing_images').all();
  const images = {};
  for (const r of rows) images[r.slot] = '/landing/uploads/' + r.filename;
  res.json({ images });
});
// Загрузка через JSON data-URL (paste из буфера на клиенте), а не multipart — на объём одного
// скриншота с запасом хватает express.json({limit:'10mb'}) выше, отдельная зависимость (multer)
// ради десятка фото на статичном лэндинге ни к чему.
app.post('/api/landing/upload', auth.requireAdmin, (req, res) => {
  const { slot, dataUrl } = req.body || {};
  if (!LANDING_SLOTS.has(slot)) return res.status(400).json({ error: 'неизвестный блок' });
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return res.status(400).json({ error: 'в буфере обмена не изображение (PNG/JPEG/WebP)' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'скриншот слишком большой (максимум 8 МБ)' });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const filename = `${slot}-${Date.now()}.${ext}`;
  const old = db.prepare('SELECT filename FROM landing_images WHERE slot = ?').get(slot);
  fs.writeFileSync(path.join(LANDING_DIR, filename), buf);
  db.prepare(`INSERT INTO landing_images (slot, filename, uploaded_at) VALUES (?, ?, ?)
              ON CONFLICT(slot) DO UPDATE SET filename = excluded.filename, uploaded_at = excluded.uploaded_at`)
    .run(slot, filename, Date.now());
  if (old && old.filename !== filename) fs.unlink(path.join(LANDING_DIR, old.filename), () => {});
  res.json({ ok: true, url: '/landing/uploads/' + filename });
});
app.delete('/api/landing/images/:slot', auth.requireAdmin, (req, res) => {
  const row = db.prepare('SELECT filename FROM landing_images WHERE slot = ?').get(req.params.slot);
  if (row) {
    fs.unlink(path.join(LANDING_DIR, row.filename), () => {});
    db.prepare('DELETE FROM landing_images WHERE slot = ?').run(req.params.slot);
  }
  res.json({ ok: true });
});

// Редактируемые надписи лэндинга — админ кликает по тексту прямо на странице (contenteditable),
// правки сохраняются посегментно по ключу вида "feature.modem.item1.label" (см. landing.html).
// Разрешён только <b> (жирные слова внутри пунктов списка) — весь остальной HTML вырезается,
// а не экранируется, потому что сохранённое значение рендерится всем посетителям через innerHTML.
function sanitizeInlineHtml(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<\/?(b|strong)(\s[^>]*)?>/gi, m => (/^<\//.test(m) ? '</b>' : '<b>'));
  s = s.replace(/<(?!\/?b(?:>|\s))[^>]*>/g, '');
  return s.replace(/\s+/g, ' ').trim();
}
const LANDING_TEXT_KEY_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){1,5}$/i;
app.get('/api/landing/texts', (req, res) => {
  const rows = db.prepare('SELECT key, content FROM landing_texts').all();
  const texts = {};
  for (const r of rows) texts[r.key] = r.content;
  res.json({ texts });
});
app.post('/api/landing/text', auth.requireAdmin, (req, res) => {
  const { key, content } = req.body || {};
  if (typeof key !== 'string' || key.length > 64 || !LANDING_TEXT_KEY_RE.test(key)) {
    return res.status(400).json({ error: 'некорректный ключ блока' });
  }
  const clean = sanitizeInlineHtml(content).slice(0, 600);
  if (!clean) return res.status(400).json({ error: 'пустой текст' });
  db.prepare(`INSERT INTO landing_texts (key, content, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`)
    .run(key, clean, Date.now());
  res.json({ ok: true, content: clean });
});

// ── Привязка запроса к модему/счётчику текущего проекта ───────────────────────
// Счётчик, с которым работает запрос, выбирается через ?meterId= (панель хранит текущий
// выбранный счётчик на клиенте) — если параметр не задан/не принадлежит этому модему,
// используется первый счётчик модема (совместимость с проектами с одним счётчиком).
app.use((req, res, next) => {
  if (!req.projectId) { req.modem = null; req.meter = null; return next(); }
  req.modem = db.prepare('SELECT * FROM modems WHERE project_id = ? ORDER BY id LIMIT 1').get(req.projectId) || null;
  if (!req.modem) { req.meter = null; return next(); }
  const meterId = parseInt(req.query.meterId, 10);
  req.meter = (Number.isInteger(meterId)
    ? db.prepare('SELECT * FROM meters WHERE id = ? AND modem_id = ?').get(meterId, req.modem.id)
    : null) || db.prepare(`SELECT * FROM meters WHERE modem_id = ?
                            ORDER BY (decommissioned_at IS NOT NULL), id LIMIT 1`).get(req.modem.id) || null;
  next();
});
app.get('/api/context', (req, res) => {
  const meters = req.modem
    ? db.prepare('SELECT id, addr, label, serial_number, model, location, ct_ratio, category, site_id, verification_due, decommissioned_at FROM meters WHERE modem_id = ? ORDER BY id').all(req.modem.id)
    : [];
  res.json({
    hasModem: !!req.modem,
    hasMeter: !!req.meter,
    modem: req.modem ? { id: req.modem.id, imei: req.modem.imei, label: req.modem.label, phone: req.modem.phone } : null,
    meter: req.meter ? { id: req.meter.id, addr: req.meter.addr, label: req.meter.label } : null,
    meters,
  });
});

// ── Привязка нового модема к проекту (Фаза 5) ─────────────────────────────────
// Проверка контрольной суммы IMEI (алгоритм Луна) — ловит опечатки при вводе.
function isValidImei(s) {
  if (typeof s !== 'string' || !/^\d{15}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = parseInt(s[14 - i], 10);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
app.post('/api/modems', (req, res) => {
  if (!req.projectId) return res.status(400).json({ error: 'нет активного проекта' });
  const imei = String((req.body || {}).imei || '').trim();
  const phone = String((req.body || {}).phone || '').trim().slice(0, 24) || null;
  const force = !!(req.body || {}).force;
  if (!isValidImei(imei)) {
    return res.status(400).json({ error: 'некорректный IMEI — проверьте 15 цифр' });
  }
  const existing = db.prepare('SELECT * FROM modems WHERE imei = ?').get(imei);
  if (existing) {
    if (existing.project_id === req.projectId) {
      return res.json({ ok: true, alreadyLinked: true });
    }
    if (!(force && req.actor.role === 'admin')) {
      return res.status(409).json({
        error: 'этот модем уже привязан к другому проекту',
        conflict: true,
        canForce: req.actor.role === 'admin',
      });
    }
    db.prepare('UPDATE modems SET project_id = ?, phone = COALESCE(?, phone) WHERE id = ?')
      .run(req.projectId, phone, existing.id);
    return res.json({ ok: true, reassigned: true });
  }
  db.prepare('INSERT INTO modems (project_id, imei, label, phone, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(req.projectId, imei, 'Модем', phone, Date.now());
  res.json({ ok: true, created: true });
});

// Удалить модем и все его счётчики (каскадно) — свой модем удалить может и обычный пользователь.
app.delete('/api/modems/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const modem = db.prepare('SELECT * FROM modems WHERE id = ?').get(id);
  if (!modem || modem.project_id !== req.projectId) {
    return res.status(404).json({ error: 'модем не найден' });
  }
  const meters = db.prepare('SELECT id FROM meters WHERE modem_id = ?').all(id);
  const tx = db.transaction(() => {
    for (const m of meters) db.prepare('DELETE FROM readings WHERE meter_id = ?').run(m.id);
    db.prepare('DELETE FROM meters WHERE modem_id = ?').run(id);
    db.prepare('DELETE FROM modems WHERE id = ?').run(id);
  });
  tx();
  logAudit(req, 'modem.delete', `modem:${id}`, `imei=${modem.imei}, meters=${meters.length}`);
  for (const m of meters) { state.deleteMeterState(m.id); backfillJobs.delete(m.id); eventHistoryJobs.delete(m.id); }
  state.deleteModemState(id);
  scanJobs.delete(id);

  // Чистим и сторону Collector'а (его собственная БД irzserver4) — иначе модем "забыт" только
  // в нашем приложении, а вендорская служба продолжает помнить его регистрацию/очередь команд.
  // Best-effort: если это не удалось — само удаление у нас уже прошло, не проваливаем запрос.
  // ВАЖНО: если модем физически всё ещё настроен стучаться на этот сервер (SMS отключения не
  // отправлена), он переподключится сам и Collector заново его зарегистрирует — это уже вопрос
  // конфигурации самого устройства, а не нашего сервера.
  let collectorForgotten = true;
  const cleanupCollector = async () => {
    // deviceHistory и sessions ссылаются на devices(imei) внешним ключом — без каскада,
    // поэтому удалять надо детей раньше родителя, иначе DELETE FROM devices падает на FK.
    await pool.execute('DELETE FROM deviceHistory WHERE imei = ?', [modem.imei]);
    await pool.execute('DELETE FROM sessions WHERE imei = ?', [modem.imei]);
    await pool.execute('DELETE FROM commands WHERE imei = ?', [modem.imei]);
    await pool.execute('DELETE FROM devices WHERE imei = ?', [modem.imei]);
  };
  try {
    await cleanupCollector();
  } catch (e) {
    // Гонка: модем ещё физически переподключается, и Collector успевает вставить новую
    // deviceHistory-запись между нашими DELETE deviceHistory и DELETE devices — тогда второй
    // запрос падает на том же FK. Все запросы идемпотентны (WHERE imei = ?), поэтому пара
    // повторов с паузой перекрывает окно гонки без переупорядочивания статементов.
    let lastErr = e;
    for (let attempt = 0; attempt < 2 && lastErr; attempt++) {
      await new Promise(r => setTimeout(r, 500));
      try { await cleanupCollector(); lastErr = null; }
      catch (e2) { lastErr = e2; }
    }
    if (lastErr) {
      collectorForgotten = false;
      console.error('не удалось очистить сторону Collector при удалении модема:', lastErr.message);
    }
  }
  res.json({ ok: true, collectorForgotten });
});

// Сводка «сколько приборов учёта сейчас на связи» — для строки статуса вверху панели.
// Онлайн = последний фоновый опрос этого счётчика (см. tickAllMercury) завершился успешно;
// проверка по уже закэшированному в памяти состоянию, без обращения к самим счётчикам.
app.get('/api/meters/status', (req, res) => {
  if (!req.modem) return res.json({ total: 0, online: 0 });
  const meters = db.prepare('SELECT id FROM meters WHERE modem_id = ?').all(req.modem.id);
  const online = meters.filter(m => state.getMeterState(m.id).cachedMercury.online === true).length;
  res.json({ total: meters.length, online });
});

// ── Счётчики текущего модема (Фаза 6) ─────────────────────────────────────────
app.get('/api/meters', (req, res) => {
  if (!req.modem) return res.json({ meters: [] });
  res.json({ meters: db.prepare('SELECT id, addr, label, serial_number, model, location, ct_ratio, decommissioned_at FROM meters WHERE modem_id = ? ORDER BY id').all(req.modem.id) });
});
app.post('/api/meters', (req, res) => {
  if (!req.modem) return res.status(400).json({ error: 'к проекту не привязан модем' });
  const b = req.body || {};
  const addr = Number.isInteger(b.addr) ? b.addr : parseInt(b.addr, 10);
  if (!Number.isInteger(addr) || addr < 0 || addr > 239) {
    return res.status(400).json({ error: 'некорректный сетевой адрес (0-239)' });
  }
  const password = typeof b.password === 'string' && /^\d{1,6}$/.test(b.password) ? b.password : '111111';
  const label = String(b.label || `Счётчик ${addr}`).slice(0, 60);
  const model = typeof b.model === 'string' && b.model.trim() ? b.model.trim().slice(0, 30) : null;
  if (db.prepare('SELECT id FROM meters WHERE modem_id = ? AND addr = ?').get(req.modem.id, addr)) {
    return res.status(409).json({ error: 'счётчик с этим адресом уже добавлен' });
  }
  const info = db.prepare('INSERT INTO meters (modem_id, addr, password, label, meter_constant, model, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
    .run(req.modem.id, addr, password, label, model, Date.now());
  res.json({ ok: true, meter: { id: info.lastInsertRowid, addr, label, model } });
});
app.delete('/api/meters/:id', (req, res) => {
  if (!req.modem) return res.status(404).json({ error: 'счётчик не найден' });
  const id = parseInt(req.params.id, 10);
  const meter = db.prepare('SELECT * FROM meters WHERE id = ?').get(id);
  if (!meter || meter.modem_id !== req.modem.id) return res.status(404).json({ error: 'счётчик не найден' });
  db.transaction(() => {
    db.prepare('DELETE FROM readings WHERE meter_id = ?').run(id);
    db.prepare('DELETE FROM meters WHERE id = ?').run(id);
  })();
  logAudit(req, 'meter.delete', `meter:${id}`, `addr=${meter.addr}, label=${meter.label}`);
  state.deleteMeterState(id);
  backfillJobs.delete(id);
  eventHistoryJobs.delete(id);
  res.json({ ok: true });
});

// Сканирование шины RS-485 на предмет подключённых счётчиков (ping по диапазону адресов).
// Долгая операция (десятки секунд-минуты) — асинхронная задача с опросом прогресса, идёт
// через ту же очередь serializeFor(modem.id), что и остальной трафик модема (см. Фазу 4).
app.post('/api/modems/scan/start', (req, res) => {
  if (!req.modem) return res.status(400).json({ error: 'к проекту не привязан модем' });
  const modemId = req.modem.id;
  const existing = scanJobs.get(modemId);
  if (existing && existing.running) return res.json({ ok: true, alreadyRunning: true });
  const b = req.body || {};
  const from = Math.max(0, Math.min(239, parseInt(b.from, 10) || 1));
  const to = Math.max(from, Math.min(239, parseInt(b.to, 10) || 239));
  const job = { running: true, checked: 0, total: to - from + 1, foundAddrs: [], error: null, startedAt: Date.now() };
  scanJobs.set(modemId, job);
  state.serializeFor(modemId, async () => {
    const port = await getCollectorPort(req.modem.imei);
    if (!port) throw new Error('у модема ещё нет прозрачного порта Collector');
    return scanBus({ host: COLLECTOR_HOST, port }, from, to, (checked, total, found) => {
      job.checked = checked; job.total = total; job.foundAddrs = found;
    });
  }).then(found => {
    job.foundAddrs = found; job.running = false;
  }).catch(e => {
    job.error = e.message; job.running = false;
  });
  res.json({ ok: true, started: true });
});
app.get('/api/modems/scan/status', (req, res) => {
  if (!req.modem) return res.json({ running: false, checked: 0, total: 0, foundAddrs: [] });
  const job = scanJobs.get(req.modem.id);
  if (!job) return res.json({ running: false, checked: 0, total: 0, foundAddrs: [] });
  // не показывать уже добавленные адреса как "кандидатов"
  const existingAddrs = new Set(
    db.prepare('SELECT addr FROM meters WHERE modem_id = ?').all(req.modem.id).map(r => r.addr));
  res.json({ ...job, foundAddrs: job.foundAddrs.filter(a => !existingAddrs.has(a)) });
});

app.use(express.static(path.join(__dirname, 'public')));

// История сигнала/температуры для графиков
// Сигнал/температура модема — последние 2 суток из БД (см. saveModemSnapshot). Раньше это было
// 240 точек в памяти процесса (~2ч при опросе раз в 30с) — терялось при каждом рестарте; теперь
// не теряется и не привязано к частоте опроса модема.
app.get('/api/history', (req, res) => {
  if (!req.modem) return res.json({ points: [] });
  const since = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare('SELECT date, slot, csq, temp FROM modem_readings WHERE modem_id = ? AND date >= ? ORDER BY date, slot')
    .all(req.modem.id, since);
  res.json({ points: rows.map(r => ({ t: localTs(r.date, r.slot), csq: r.csq, temp: r.temp })) });
});

app.get('/api/status', (req, res) => {
  if (!req.modem) return res.json({ online: false, noModem: true });
  const st = state.getModemState(req.modem.id);
  const age = st.cachedStatus.ts ? Math.round((Date.now() - st.cachedStatus.ts) / 1000) : null;
  res.json({ ...st.cachedStatus, ageSec: age });
});
app.post('/api/refresh', async (req, res) => {
  if (!req.modem) return res.status(400).json({ error: 'к проекту не привязан модем' });
  await backgroundPollModem(req.modem);
  const st = state.getModemState(req.modem.id);
  const age = st.cachedStatus.ts ? Math.round((Date.now() - st.cachedStatus.ts) / 1000) : null;
  res.json({ ...st.cachedStatus, ageSec: age });
});

// ── Меркурий: API ────────────────────────────────────────────────────────────
app.get('/api/mercury/status', (req, res) => {
  if (!req.meter) return res.json({ online: false, noMeter: true });
  const st = state.getMeterState(req.meter.id);
  const age = st.cachedMercury.ts ? Math.round((Date.now() - st.cachedMercury.ts) / 1000) : null;
  const curBits = eventsToBitmask(st.cachedMercury.events);
  res.json({
    ...st.cachedMercury, ageSec: age,
    eventsNewBits: curBits & ~req.meter.ack_event_bits, // биты, которых не было в подтверждённых
    cfg: { addr: req.meter.addr, label: req.meter.label, pollIntervalSec: MERCURY_BUS_POLL_SEC, enabled: true },
    passport: { serialNumber: req.meter.serial_number, manufactureDate: req.meter.manufacture_date },
  });
});
// Подтвердить текущие тревоги — квитирование только на своей стороне (см. mercuryProtocol.js
// cmdResetEventFlags — запись на сам счётчик проверена живьём и не работает, нет ответа прибора).
// Новый баннер загорится только если появится флаг, которого не было среди подтверждённых.
app.post('/api/mercury/events/acknowledge', (req, res) => {
  if (!req.meter) return res.status(400).json({ error: 'к проекту не привязан счётчик' });
  const st = state.getMeterState(req.meter.id);
  const curBits = eventsToBitmask(st.cachedMercury.events);
  db.prepare('UPDATE meters SET ack_event_bits = ? WHERE id = ?').run(curBits, req.meter.id);
  res.json({ ok: true, ackBits: curBits });
});
// Подробная история тревог (с реальным временем) — по требованию, не на каждом обычном опросе
// (до 40 запросов к счётчику суммарно, см. mercuryPoll.js readEventHistory).
// Долгая операция (до 40 запросов к счётчику) — асинхронная задача с опросом прогресса,
// как скан шины (Фаза 6) и догрузка истории почасовок — иначе упирается в таймаут nginx (60с).
app.post('/api/mercury/events/history/start', (req, res) => {
  if (!req.meter) return res.status(400).json({ error: 'к проекту не привязан счётчик' });
  const meterId = req.meter.id;
  const existing = eventHistoryJobs.get(meterId);
  if (existing && existing.running) return res.json({ ok: true, alreadyRunning: true });
  const job = { running: true, checked: 0, total: 40, found: 0, events: null, error: null, startedAt: Date.now() };
  eventHistoryJobs.set(meterId, job);
  const modemId = req.modem.id, imei = req.modem.imei, meter = req.meter;
  (async () => {
    const port = await getCollectorPort(imei);
    if (!port) throw new Error('у модема ещё нет прозрачного порта Collector');
    const cfg = { host: COLLECTOR_HOST, port, addr: meter.addr, password: meter.password };
    return state.serializeFor(modemId, () => readEventHistory(cfg, (checked, total, found) => {
      job.checked = checked; job.total = total; job.found = found;
    }));
  })().then(events => {
    job.events = events; job.running = false;
  }).catch(e => {
    job.error = e.message; job.running = false;
  });
  res.json({ ok: true, started: true });
});
app.get('/api/mercury/events/history/status', (req, res) => {
  if (!req.meter) return res.json({ running: false, checked: 0, total: 0, events: null });
  const job = eventHistoryJobs.get(req.meter.id);
  if (!job) return res.json({ running: false, checked: 0, total: 0, events: null });
  res.json(job);
});
app.post('/api/mercury/refresh', async (req, res) => {
  if (!req.meter) return res.status(400).json({ error: 'к проекту не привязан счётчик' });
  await backgroundMercuryPollMeter(req.modem, req.meter, { priority: true });
  const st = state.getMeterState(req.meter.id);
  const age = st.cachedMercury.ts ? Math.round((Date.now() - st.cachedMercury.ts) / 1000) : null;
  res.json({ ...st.cachedMercury, ageSec: age });
});
const OBJECT_CATEGORIES = new Set(['rent', 'technical', 'commercial']);
app.get('/api/mercury/config', (req, res) => {
  if (!req.meter) return res.json({ addr: null, password: null, model: null, location: null, ct_ratio: null, category: null, site_id: null, verification_due: null, pollIntervalSec: MERCURY_BUS_POLL_SEC, enabled: true });
  res.json({ addr: req.meter.addr, password: req.meter.password, model: req.meter.model, location: req.meter.location, ct_ratio: req.meter.ct_ratio, category: req.meter.category, site_id: req.meter.site_id, verification_due: req.meter.verification_due, decommissioned_at: req.meter.decommissioned_at, pollIntervalSec: MERCURY_BUS_POLL_SEC, enabled: true });
});
app.post('/api/mercury/config', (req, res) => {
  if (!req.meter) return res.status(400).json({ error: 'к проекту не привязан счётчик' });
  const b = req.body || {};
  const addr = Number.isInteger(b.addr) && b.addr >= 0 && b.addr <= 239 ? b.addr : req.meter.addr;
  const password = typeof b.password === 'string' && /^\d{1,6}$/.test(b.password) ? b.password : req.meter.password;
  // Модель и расположение — вводятся вручную (протокол не позволяет определить модель сам,
  // см. db.js). Пустая строка из формы намеренно сбрасывает в NULL, а не сохраняет прежнее.
  const model = typeof b.model === 'string' ? (b.model.trim().slice(0, 30) || null) : req.meter.model;
  const location = typeof b.location === 'string' ? (b.location.trim().slice(0, 120) || null) : req.meter.location;
  // Коэфф. трансформации (ТТ) — та же логика "пустая строка сбрасывает в NULL", но с проверкой,
  // что это положительное число, а не текст (см. ROADMAP-заметку про Capitalservis, 30 авг).
  let ctRatio = req.meter.ct_ratio;
  if (typeof b.ct_ratio === 'string') {
    const trimmed = b.ct_ratio.trim();
    if (!trimmed) ctRatio = null;
    else { const n = Number(trimmed); if (Number.isFinite(n) && n > 0) ctRatio = n; }
  }
  // Категория для раздела «Объекты» (31 авг) — какая из 3 вкладок (Аренда/Технические/Коммерческие
  // учёты) показывает этот счётчик. Пустая строка сбрасывает в NULL (не распределён, нигде не
  // отображается), что угодно вне списка — игнорируется, а не падает ошибкой.
  let category = req.meter.category;
  if (typeof b.category === 'string') {
    const trimmed = b.category.trim();
    if (!trimmed) category = null;
    else if (OBJECT_CATEGORIES.has(trimmed)) category = trimmed;
  }
  // Привязка к объекту (31 авг, см. db.js sites) — какой из объектов проекта показывает этот
  // счётчик в разделе «Объекты». null/пустая строка сбрасывает привязку; список объектов создаёт
  // только админ, поэтому здесь просто проверяем, что такой объект вообще существует в ЭТОМ
  // проекте (иначе Мастер мог бы привязать счётчик к объекту чужого проекта, подставив id).
  let siteId = req.meter.site_id;
  if (b.site_id !== undefined) {
    if (b.site_id === null || b.site_id === '') siteId = null;
    else {
      const sid = parseInt(b.site_id, 10);
      if (Number.isInteger(sid) && db.prepare('SELECT id FROM sites WHERE id = ? AND project_id = ?').get(sid, req.projectId)) {
        siteId = sid;
      }
    }
  }
  // Срок поверки ПУ (05.09.2026) — календарная дата 'YYYY-MM-DD' из <input type="date">, см. db.js.
  // Пустая строка сбрасывает в NULL; мусор игнорируется, а не пишется в базу. Проверяем не только
  // формат регуляркой, но и что дата вообще существует (Date отматывает 2026-02-31 на март, и
  // в базу лёг бы день, которого пользователь не вводил).
  let verificationDue = req.meter.verification_due;
  if (typeof b.verification_due === 'string') {
    const trimmed = b.verification_due.trim();
    if (!trimmed) verificationDue = null;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const d = new Date(trimmed + 'T00:00:00Z');
      if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === trimmed) verificationDue = trimmed;
    }
  }
  // Вывод из эксплуатации и возврат в работу. Повторный вывод не переставляет дату — важно,
  // когда прибор сняли на самом деле, а не когда галочку нажали второй раз.
  let decommissionedAt = req.meter.decommissioned_at;
  if (typeof b.decommissioned === 'boolean') {
    decommissionedAt = b.decommissioned ? (decommissionedAt || Date.now()) : null;
  }
  db.prepare(`UPDATE meters SET addr = ?, password = ?, model = ?, location = ?, ct_ratio = ?,
                                category = ?, site_id = ?, verification_due = ?, decommissioned_at = ?
               WHERE id = ?`)
    .run(addr, password, model, location, ctRatio, category, siteId, verificationDue, decommissionedAt, req.meter.id);
  // Инциденты закрываем сразу, не дожидаясь тика детектора: пользователь только что сказал, что
  // прибора больше нет, и висящая по нему тревога в ленте выглядела бы так, будто его не услышали.
  if (decommissionedAt) retireAlerts('meter:' + req.meter.id);
  res.json({ ok: true, cfg: { addr, password, model, location, ct_ratio: ctRatio, category, site_id: siteId, verification_due: verificationDue, decommissioned_at: decommissionedAt, pollIntervalSec: MERCURY_BUS_POLL_SEC, enabled: true } });
});

// Профиль средних мощностей (получасовки) — теперь из БД (таблица readings), по месяцам.
// Список месяцев, за которые есть данные + статус первой догрузки истории.
app.get('/api/mercury/profile/months', (req, res) => {
  if (!req.meter) return res.json({ months: [], backfilled: false, backfill: null });
  const months = db.prepare(
    'SELECT DISTINCT substr(date,1,7) AS ym FROM readings WHERE meter_id = ? ORDER BY ym DESC').all(req.meter.id)
    .map(r => r.ym);
  const job = backfillJobs.get(req.meter.id) || null;
  res.json({
    months,
    backfilled: !!req.meter.backfilled_at,
    backfill: job ? { running: job.running, offsetsRead: job.offsetsRead, recordsFound: job.recordsFound,
      stopReason: job.stopReason, error: job.error } : null,
  });
});

// Данные ОДНОГО месяца (дата x час, значение = кВт*ч за час) — 'YYYY-MM', по умолчанию текущий.
app.get('/api/mercury/profile', (req, res) => {
  if (!req.meter) return res.json({ month: null, dates: [], hourly: {}, meta: {} });
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '')
    ? req.query.month
    : new Date().toISOString().slice(0, 7);
  const rows = db.prepare(
    'SELECT date, slot, kwh, incomplete, kwh_self, incomplete_self FROM readings WHERE meter_id = ? AND substr(date,1,7) = ? ORDER BY date, slot')
    .all(req.meter.id, month);
  const byDate = {};
  for (const r of rows) {
    // Профиль счётчика (kwh) — приоритетный источник, где работает. Самозапись (kwh_self, см.
    // applySelfEnergy) — только туда, где профиля нет (напр. Меркурий 230): проверяем kwh ПЕРВЫМ
    // и, если он есть, kwh_self в этой же ячейке игнорируем целиком — иначе задвоили бы значение,
    // это не два слагаемых одной величины, а два независимых способа посчитать одно и то же.
    const val = r.kwh != null ? r.kwh : r.kwh_self;
    if (val == null) continue;
    if (!byDate[r.date]) byDate[r.date] = new Array(24).fill(null);
    const hh = parseInt(r.slot.slice(0, 2), 10);
    const cell = byDate[r.date][hh];
    const estimated = r.kwh == null;
    byDate[r.date][hh] = {
      kwh: Math.round(((cell ? cell.kwh : 0) + val) * 1000) / 1000,
      incomplete: !!(cell && cell.incomplete) || !!(estimated ? r.incomplete_self : r.incomplete),
      estimated: !!(cell && cell.estimated) || estimated,
    };
  }
  const dates = Object.keys(byDate).sort();
  const st = state.getMeterState(req.meter.id);
  // "счётчик не ответил при опросе профиля" значит разное в двух случаях: (а) прибор в принципе
  // не поддерживает профиль 06h/16h (напр. Меркурий 230, см. память irz-self-write-energy — тогда
  // это не ошибка, а постоянное свойство модели, самозапись kwh_self и так покрывает почасовку) и
  // (б) прибор профиль обычно отдаёт, но именно сейчас не ответил (реальный транзиентный сбой,
  // стоит показать тревожно). Различаем по факту: был ли у этого счётчика хоть раз НЕПУСТОЙ kwh
  // (не kwh_self) за всё время — если да, профиль в принципе работает, и разовый no-response это
  // настоящая ошибка; если нет ни разу — это (а), не пугаем текстом "ошибка опроса".
  const profileEverWorked = !!db.prepare(
    'SELECT 1 FROM readings WHERE meter_id = ? AND kwh IS NOT NULL LIMIT 1').get(req.meter.id);
  res.json({
    month, dates, hourly: byDate,
    meta: {
      meterConstant: req.meter.meter_constant,
      backfilled: !!req.meter.backfilled_at,
      lastPollTs: st.profileLastPollTs,
      lastError: st.profileLastError,
      profileSupported: profileEverWorked,
      polling: st.profilePolling,
    },
  });
});
app.post('/api/mercury/profile/refresh', async (req, res) => {
  if (!req.meter) return res.status(400).json({ error: 'к проекту не привязан счётчик' });
  await backgroundMercuryProfilePollMeter(req.modem, req.meter);
  const st = state.getMeterState(req.meter.id);
  res.json({ ok: !st.profileLastError, error: st.profileLastError });
});

// Дозаполнить пропуски получасовки за последние сутки-недели. Обычный опрос (выше) идёт назад
// от текущего момента и останавливается на первой записи, которая уже есть в БД — дыры СТАРШЕ
// неё он не закроет по построению. Здесь alreadyHave отключён (это делает startBackfill), то
// есть перечитываются подряд все записи в окне глубиной maxRecords, а saveReadings кладёт их
// UPSERT'ом: имеющиеся значения перезаписываются теми же (источник тот же — память счётчика),
// пропущенные появляются. Разовая операция под кнопку/руками, не фоновая: 400 записей на шине
// это ~2 минуты на прибор, и на это время остальные ПУ ждут в очереди serializeFor.
const REPAIR_MAX_RECORDS = 400;   // ~8.3 суток получасовок
app.post('/api/mercury/profile/repair', auth.requireMaster, (req, res) => {
  if (!req.meter) return res.status(400).json({ error: 'к проекту не привязан счётчик' });
  const running = backfillJobs.get(req.meter.id);
  if (running && running.running) return res.status(409).json({ error: 'догрузка уже идёт' });
  const depth = Math.min(parseInt(req.body?.records, 10) || REPAIR_MAX_RECORDS, BACKFILL_MAX_RECORDS);
  startBackfill(req.modem, req.meter, { maxRecords: depth });
  res.json({ ok: true, records: depth, note: 'дозаполнение запущено; прогресс — в /api/mercury/months' });
});

// Расход и стоимость энергии за месяц. Показания на начало/конец периода — НЕ отдельная таблица
// снапшотов, а вычисление от уже имеющихся данных: живое текущее показание счётчика (aPlus, см.
// pollEnergy) минус сумма расхода ПОСЛЕ конца периода даёт показание НА конец периода, минус ещё
// расход ЗА период — показание на начало (см. план 30 авг). Обязательно та же формула объединения
// kwh/kwh_self, что и в /api/mercury/profile выше (kwh в приоритете, kwh_self — только замена,
// НЕ слагаемое — иначе задвоили бы расход).
const sumConsumptionStmt = db.prepare(
  'SELECT SUM(COALESCE(kwh, kwh_self)) AS total FROM readings WHERE meter_id = ? AND date >= ? AND date <= ?');
function sumConsumptionKwh(meterId, from, to) {
  if (to < from) return 0;
  return sumConsumptionStmt.get(meterId, from, to).total || 0;
}
// Показания на начало/конец ПРОИЗВОЛЬНОГО периода [periodStart, periodEnd] (обе даты включительно,
// periodEnd не позже today) — общая логика, переиспользуется и в таблице «Объектов»
// (/api/objects/table), и в экспорте из неё (/api/objects/export). liveAPlus — сырое текущее
// показание счётчика (может отличаться от endReading, если periodEnd в прошлом, а не сегодня).
function computeReadingPeriod(meterId, periodStart, periodEnd, today) {
  const consumptionKwh = Math.round(sumConsumptionKwh(meterId, periodStart, periodEnd) * 1000) / 1000;
  // Последняя известная абсолютная точка (aPlus) — из БД (meters.last_energy_kwh), НЕ из кэша
  // процесса в памяти (state.cachedMercury). Раньше брали кэш — он пустеет на каждом рестарте
  // сервиса и не восстанавливается, пока не пройдёт полный цикл опроса (до 10 мин), из-за чего
  // «Показания на конец месяца» в «Объектах» мигали в «нет данных» не столько от реальных обрывов
  // RS-485, сколько от любого деплоя/рестарта разом по всем счётчикам (жалоба 31 авг). Колонка
  // last_energy_kwh — та же самая точка отсчёта, что и в cachedMercury.energy.sum.aPlus (пишется
  // туда на каждом успешном опросе энергии, см. applySelfEnergy выше), просто уже персистентная —
  // никаких новых записей в БД, никакой доп. нагрузки на шину, только смена источника чтения.
  const liveAPlus = getSelfBaselineStmt.get(meterId)?.last_energy_kwh ?? null;
  let startReading = null, endReading = null;
  if (liveAPlus != null) {
    const trailingKwh = periodEnd >= today ? 0 : sumConsumptionKwh(meterId, addDaysStr(periodEnd, 1), today);
    endReading = Math.round((liveAPlus - trailingKwh) * 1000) / 1000;
    startReading = Math.round((endReading - consumptionKwh) * 1000) / 1000;
  }
  return { consumptionKwh, startReading, endReading, liveAPlus, liveReadingMissing: liveAPlus == null };
}
// Стоимость расхода meterId за [periodStart, periodEnd] по истории тарифов ОБЪЕКТА (см.
// db.js site_tariffs — тариф переехал с модема на объект 31 авг) — период режется на куски по
// датам смены ставки, чтобы месяц со сменой тарифа (обычно 1 июля) считался корректно, а не
// одной ставкой на весь период.
function computeSiteTariffCost(siteId, meterId, periodStart, periodEnd) {
  const tariffRows = siteId
    ? db.prepare('SELECT rate, valid_from FROM site_tariffs WHERE site_id = ? ORDER BY valid_from ASC').all(siteId)
    : [];
  if (tariffRows.length === 0) return { tariffMissing: true, costRub: null, rateAtPeriodEnd: null, rateChangedDuringPeriod: false };
  const rateAt = (date) => {
    let r = tariffRows[0].rate;
    for (const row of tariffRows) { if (row.valid_from <= date) r = row.rate; else break; }
    return r;
  };
  const rateAtPeriodEnd = rateAt(periodEnd);
  const changeDates = tariffRows.map(r => r.valid_from).filter(d => d > periodStart && d <= periodEnd);
  const rateChangedDuringPeriod = changeDates.length > 0;
  const boundaries = [...new Set([periodStart, ...changeDates, addDaysStr(periodEnd, 1)])].sort();
  let costRub = 0;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const segFrom = boundaries[i], segTo = addDaysStr(boundaries[i + 1], -1);
    costRub += sumConsumptionKwh(meterId, segFrom, segTo) * rateAt(segFrom);
  }
  costRub = Math.round(costRub * 100) / 100;
  return { tariffMissing: false, costRub, rateAtPeriodEnd, rateChangedDuringPeriod };
}
// Коэффициент трансформации (ТТ, meters.ct_ratio) — расход и стоимость за биллинговый период
// умножаются на него, в отличие от мгновенных "Показаний" счётчика (там показания сами по себе
// остаются как на приборе, множится только Ток/Мощность, см. renderMercury в index.html и
// комментарий у ct_ratio в db.js). Тариф (₽/кВт·ч) НЕ умножается — это цена за реальный кВт·ч,
// меняется только количество и итоговая сумма. Общая для /api/objects/table и /api/objects/export,
// чтобы раздел «Объекты» и выгрузка из него не разошлись в цифрах.
function scaleByCtRatio(consumptionKwh, costRub, ctRatio) {
  const r = ctRatio || 1;
  return {
    consumptionKwh: Math.round(consumptionKwh * r * 1000) / 1000,
    costRub: costRub == null ? null : Math.round(costRub * r * 100) / 100,
  };
}
// Дата в формате dd.mm.yyyy — общая для истории тарифов и экспорта из «Объектов».
function fmtDateRu(iso) { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; }
// ── «Объекты»: сводная таблица по всем счётчикам модема для Аренды/Технических/Коммерческих
// учётов (см. ROADMAP.md, обсуждение с пользователем 31 авг). Один календарный месяц на всю
// таблицу разом (не на счётчик, как «Оплаты») — переключатель месяца общий для всех 3 вкладок,
// вкладки просто фильтруют уже загруженные строки по meters.category на клиенте. Показания/расход/
// тариф/стоимость — та же общая логика (computeReadingPeriod/computeSiteTariffCost/scaleByCtRatio),
// что и в экспорте из этого же раздела, посчитанная отдельно на каждый счётчик.
// siteId — какой из «Объектов» проекта (см. db.js sites) сейчас выбран на клиенте; без него (ещё
// не выбран/не создан) отдаём пустой список, а не данные по всему модему разом — раздел «Объекты»
// теперь всегда требует явного выбора объекта первым шагом (см. index.html loadObjSites).
function parseSiteId(req) {
  const n = parseInt(req.query.siteId, 10);
  return Number.isInteger(n) ? n : null;
}
app.get('/api/objects/sites', (req, res) => {
  if (!req.projectId) return res.json({ sites: [] });
  const sites = db.prepare('SELECT id, name FROM sites WHERE project_id = ? ORDER BY id').all(req.projectId);
  res.json({ sites });
});
app.get('/api/objects/months', (req, res) => {
  const siteId = parseSiteId(req);
  if (!req.modem || !siteId) return res.json({ months: [], minDate: null, maxDate: null });
  const months = db.prepare(
    `SELECT DISTINCT substr(date,1,7) AS ym FROM readings
     WHERE meter_id IN (SELECT id FROM meters WHERE modem_id = ? AND site_id = ?) ORDER BY ym DESC`
  ).all(req.modem.id, siteId).map(r => r.ym);
  // Границы для календаря произвольного периода (см. index.html renderObjCalendar) — даты вне
  // [minDate, maxDate] по ЛЮБОМУ счётчику объекта показаны приглушённо и некликабельны. Та же
  // логика "объединения по объекту", что и у months выше (не пересечение по всем счётчикам разом).
  const bounds = db.prepare(
    `SELECT MIN(date) AS minDate, MAX(date) AS maxDate FROM readings
     WHERE meter_id IN (SELECT id FROM meters WHERE modem_id = ? AND site_id = ?)`
  ).get(req.modem.id, siteId);
  res.json({ months, minDate: bounds.minDate || null, maxDate: bounds.maxDate || null });
});
// Период таблицы «Объектов» — либо целый календарный месяц (?month=YYYY-MM, как раньше), либо
// произвольный диапазон дат (?from=YYYY-MM-DD&to=YYYY-MM-DD, календарь "Период" в index.html,
// 2 сент). from/to в приоритете, если оба присутствуют и валидны. periodEnd в обоих случаях
// не может быть позже today — та же логика "asOfToday", что раньше была только для месяца.
function resolveObjectsPeriod(req, today) {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (dateRe.test(req.query.from || '') && dateRe.test(req.query.to || '') && req.query.from <= req.query.to) {
    const periodStart = req.query.from;
    const asOfToday = req.query.to > today;
    return { month: null, periodStart, periodEnd: asOfToday ? today : req.query.to, asOfToday };
  }
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today.slice(0, 7);
  const [Y, M] = month.split('-').map(Number);
  const periodStart = `${month}-01`;
  const lastDay = new Date(Date.UTC(Y, M, 0)).getUTCDate();
  const periodEndFull = `${month}-${String(lastDay).padStart(2, '0')}`;
  const asOfToday = periodEndFull > today;
  return { month, periodStart, periodEnd: asOfToday ? today : periodEndFull, asOfToday };
}
app.get('/api/objects/table', (req, res) => {
  if (!req.modem) return res.status(400).json({ error: 'к проекту не привязан модем' });
  const siteId = parseSiteId(req);
  if (!siteId) return res.json({ month: null, periodStart: null, periodEnd: null, asOfToday: false, rows: [] });
  const today = hourSlot(Date.now()).date;
  const { month, periodStart, periodEnd, asOfToday } = resolveObjectsPeriod(req, today);

  const meters = db.prepare('SELECT * FROM meters WHERE modem_id = ? AND site_id = ? ORDER BY addr').all(req.modem.id, siteId);
  const rows = meters.map((meter) => {
    const { consumptionKwh: rawConsumptionKwh, startReading, endReading, liveReadingMissing } =
      computeReadingPeriod(meter.id, periodStart, periodEnd, today);
    const { tariffMissing, costRub: rawCostRub, rateAtPeriodEnd, rateChangedDuringPeriod } =
      computeSiteTariffCost(siteId, meter.id, periodStart, periodEnd);
    const { consumptionKwh, costRub } = scaleByCtRatio(rawConsumptionKwh, tariffMissing ? null : rawCostRub, meter.ct_ratio);
    return {
      meterId: meter.id, addr: meter.addr, model: meter.model, serial: meter.serial_number,
      location: meter.location, ctRatio: meter.ct_ratio || null, category: meter.category || null,
      // Дата поверки — сырой ISO 'YYYY-MM-DD' (см. db.js verification_due); формат и подсветку
      // «срок близко» считает клиент, см. objDueLevel в index.html.
      verificationDue: meter.verification_due || null,
      tenantName: meter.tenant_name || null, rentalName: meter.rental_name || null,
      signatoryName: meter.signatory_name || null,
      // Отчётный день (07.09.2026) — «Объектам» он не нужен, но раздел «Автоматизированные
      // отчёты» показывает ту же таблицу теми же строками и берёт их отсюда же: отдельный
      // эндпоинт-близнец рано или поздно разошёлся бы с этим в расчёте показаний.
      reportDay: meter.report_day || null,
      // Выведенный из эксплуатации прибор (07.09.2026, для красной рамки на № счётчика в
      // «Объектах»/«Автоматизированных отчётах») — этот запрос НЕ фильтрует decommissioned_at
      // (в отличие от фонового опроса, см. allMetersWithModem): прошлые показания и место в
      // отчётах такого прибора должны остаться видимыми, поэтому клиенту нужен явный признак,
      // а не тихое исчезновение строки.
      decommissioned: !!meter.decommissioned_at, decommissionedAt: meter.decommissioned_at || null,
      startReading, endReading, liveReadingMissing, consumptionKwh,
      tariffMissing, rateAtPeriodEnd, rateChangedDuringPeriod, costRub,
    };
  });
  res.json({ month, periodStart, periodEnd, asOfToday, rows });
});
app.post('/api/objects/meter/:id', auth.requireMaster, (req, res) => {
  if (!req.modem) return res.status(400).json({ error: 'к проекту не привязан модем' });
  const id = parseInt(req.params.id, 10);
  const meter = db.prepare('SELECT * FROM meters WHERE id = ?').get(id);
  if (!meter || meter.modem_id !== req.modem.id) return res.status(404).json({ error: 'счётчик не найден' });
  const b = req.body || {};
  // Те же 3 ручных поля, что в примере пользователя: Арендатор, Наименование аренды, ФИО/подпись —
  // единая структура таблицы для всех 3 вкладок (не только "Аренды"), пустая строка сбрасывает в NULL.
  const tenantName = typeof b.tenant_name === 'string' ? (b.tenant_name.trim().slice(0, 120) || null) : meter.tenant_name;
  const rentalName = typeof b.rental_name === 'string' ? (b.rental_name.trim().slice(0, 120) || null) : meter.rental_name;
  const signatoryName = typeof b.signatory_name === 'string' ? (b.signatory_name.trim().slice(0, 120) || null) : meter.signatory_name;
  db.prepare('UPDATE meters SET tenant_name = ?, rental_name = ?, signatory_name = ? WHERE id = ?')
    .run(tenantName, rentalName, signatoryName, meter.id);
  res.json({ ok: true, tenant_name: tenantName, rental_name: rentalName, signatory_name: signatoryName });
});

// Видимость столбцов «Объектов» для роли «Пользователь» (31 авг, см. db.js objects_column_prefs)
// — GET доступен обеим ролям (обеим нужно знать, что сейчас скрыто: «Пользователю» — чтобы
// отфильтровать рендер, «Мастеру» — чтобы отрисовать состояние иконок-переключателей), POST
// меняет настройку и поэтому requireMaster.
// Белый список ключей столбцов «Объектов», допустимых в hidden_columns — держать синхронно с
// objCols в index.html. 'addr' здесь был ключом старой колонки «Номер на шине RS-485», убранной
// из клиента 05.09.2026 (заменена «Датой поверки ПУ», ключ 'verification') — при удалении
// колонки список не обновили, из-за чего попытка скрыть именно «Дату поверки ПУ» получала
// 400 (ключ вне списка) и молча ничего не делала, а остальные столбцы работали нормально
// (найдено 07.09.2026 — пользователь пробовал скрыть свежедобавленный столбец).
const OBJ_COLUMN_KEYS = new Set([
  'num', 'model', 'serial', 'tenant', 'location', 'rental', 'verification',
  'startReading', 'endReading', 'ctRatio', 'consumption', 'rate', 'total', 'signatory',
]);
function getObjHiddenColumns(projectId) {
  const row = db.prepare('SELECT hidden_columns FROM objects_column_prefs WHERE project_id = ?').get(projectId);
  if (!row) return [];
  try { return JSON.parse(row.hidden_columns); } catch (e) { return []; }
}
app.get('/api/objects/column-prefs', (req, res) => {
  res.json({ hiddenColumns: getObjHiddenColumns(req.projectId) });
});
app.post('/api/objects/column-prefs', auth.requireMaster, (req, res) => {
  const cols = Array.isArray(req.body && req.body.hiddenColumns) ? req.body.hiddenColumns : null;
  if (!cols || !cols.every(c => typeof c === 'string' && OBJ_COLUMN_KEYS.has(c))) {
    return res.status(400).json({ error: 'недопустимый список столбцов' });
  }
  const now = Date.now();
  db.prepare(`INSERT INTO objects_column_prefs (project_id, hidden_columns, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(project_id) DO UPDATE SET hidden_columns = excluded.hidden_columns, updated_at = excluded.updated_at`)
    .run(req.projectId, JSON.stringify(cols), now);
  res.json({ ok: true });
});

// Экспорт «Объектов» в Excel/CSV (31 авг) — узкие колонки + wrapText в шапке, зебра, фирменная
// палитра, итоговая строка. Один календарный месяц, а не произвольный диапазон дат — «Объекты»
// и на экране всегда показывают месяц, не период. Строки — только текущий выбранный объект и
// подвкладка (category), а не все счётчики модема разом — это ровно то, что видно на экране в
// момент нажатия «Скачать». Для роли «Пользователь» набор столбцов сокращается до того же
// hidden_columns, что фильтрует и сам рендер таблицы —
// иначе выгрузка раскрывала бы то, что намеренно спрятано от этой роли в интерфейсе.
const OBJECTS_EXPORT_COLS = [
  { key: 'num', header: '№ п.п.', width: 6 },
  // Порядок обязан совпадать с objCols в index.html (арендатор, аренда и помещение — сразу за
  // № п.п.; просьба 05.09.2026, порядок внутри тройки перевёрнут 07.09.2026): иначе
  // выгрузка не совпадёт с тем, что человек видит на экране.
  { key: 'tenant', header: 'Арендатор', width: 16 },
  { key: 'rental', header: 'Наименование аренды', width: 16 },
  { key: 'location', header: '№ помещения (расположение)', width: 16 },
  { key: 'model', header: 'Модель ПУ', width: 12 },
  { key: 'serial', header: '№ счётчика', width: 12 },
  { key: 'verification', header: 'Дата поверки ПУ', width: 13 },
  // header без даты здесь — на всякий случай запасной вариант; на практике всегда перекрывается
  // HEADER_DATE_OVERRIDES ниже (дата периода известна только в момент запроса, не при
  // объявлении этого статического массива).
  // width 16, не 12 — заголовок теперь несёт ещё и дату (HEADER_DATE_OVERRIDES), у конечной
  // даты бывает суффикс «ещё не завершён» (~65 символов итогом); 12 было впритык уже под старый
  // короткий текст (headerRow.height=64pt тюнилась под 2-3 строки wrapText), у'же не хватило бы.
  { key: 'startReading', header: 'Показания на начало месяца, кВт·ч', width: 16, fmt: '0.000' },
  { key: 'endReading', header: 'Показания на конец месяца, кВт·ч', width: 16, fmt: '0.000' },
  { key: 'ctRatio', header: 'Коэф. трансформации', width: 10, fmt: '0.###' },
  { key: 'consumption', header: 'Расход, кВт·ч', width: 12, fmt: '0.000' },
  { key: 'rate', header: 'Тариф, ₽/кВт·ч', width: 10, fmt: '0.00' },
  { key: 'total', header: 'Итого за период, ₽', width: 12, fmt: '#,##0.00', moneyCol: true },
  { key: 'signatory', header: 'Примечание', width: 18 },
];
const OBJECTS_EXPORT_NUMERIC_KEYS = new Set(['num', 'startReading', 'endReading', 'ctRatio', 'consumption', 'rate', 'total']);
// Ступень срока поверки для выгрузки — те же пороги (90/30/7 дней, минус = просрочено), что и у
// objDueLevel в index.html. Дублирование намеренное: на клиенте считает клиент, в файле — сервер,
// общего места для этой логики нет, поэтому пороги вынесены в одну константу с явным именем,
// чтобы при правке было видно оба места.
// Заливки подобраны так же, как экранные (см. index.html): контраст к тексту отчёта не ниже 5:1,
// ΔE между соседними ступенями ~14 и больше — иначе жёлтая и оранжевая на печати сливаются.
// Просрочка — отдельный, четвёртый цвет (на экране её отделяет ещё и полоса слева, в Excel такого
// приёма нет, поэтому здесь разница только в тоне: ΔE 18.8 от «недели», контраст к тексту 5.36).
const VERIFICATION_OVERDUE_ARGB = 'FFE08585';
const VERIFICATION_STEPS = [{ days: 7, argb: 'FFF3B3B3' }, { days: 30, argb: 'FFF8CFA0' }, { days: 90, argb: 'FFFBE9A8' }];
function verificationFill(iso, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return null;
  const days = Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  if (days < 0) return VERIFICATION_OVERDUE_ARGB;
  const step = VERIFICATION_STEPS.find((s) => days <= s.days);
  return step ? step.argb : null;
}
const OBJECTS_CATEGORY_LABELS = { rent: 'Аренда', technical: 'Технические учёты', commercial: 'Коммерческие учёты' };

// ── Сборка отчёта: столбцы, строки, итоги, книга ExcelJS ─────────────────────────────────────
// Выделено из /api/objects/export (07.09.2026), чтобы «Автоматизированные отчёты» (tickReports
// ниже) слали ТОТ ЖЕ файл: те же цифры, те же заголовки, то же оформление. Скопированная сборка
// книги разошлась бы с экранной при первой же правке одной из копий, а отчёт, приходящий на почту,
// обязан совпадать с тем, что человек видит в кабинете.
//
// keys — какие столбцы попадают в файл (порядок берётся из OBJECTS_EXPORT_COLS, а не из keys:
// он должен совпадать с экраном). word — «месяца» для «Объектов», где период почти всегда
// календарный месяц, и «периода» для автоматических отчётов, где границы задаёт отчётный день
// и на месяц они не ложатся. Заголовки с датой подставляются в НОВЫЕ объекты через spread:
// OBJECTS_EXPORT_COLS статична на весь процесс, и мутация её элементов дала бы гонку между
// одновременными запросами с разными периодами.
function objectsExportCols(keys, periodStart, periodEnd, asOfToday, word) {
  const headers = {
    startReading: `Показания на начало ${word}, ${fmtDateRu(periodStart)}, кВт·ч`,
    endReading: `Показания на конец ${word}, ${fmtDateRu(periodEnd)}${asOfToday ? ' (ещё не завершён)' : ''}, кВт·ч`,
  };
  return OBJECTS_EXPORT_COLS
    .filter((c) => keys.includes(c.key))
    .map((c) => (headers[c.key] ? { ...c, header: headers[c.key] } : c));
}
function buildObjectsRows(meters, siteId, periodStart, periodEnd, today) {
  return meters.map((meter, idx) => {
    const { consumptionKwh: rawConsumptionKwh, startReading, endReading, liveReadingMissing } =
      computeReadingPeriod(meter.id, periodStart, periodEnd, today);
    const { tariffMissing, costRub: rawCostRub, rateAtPeriodEnd } = computeSiteTariffCost(siteId, meter.id, periodStart, periodEnd);
    const { consumptionKwh, costRub } = scaleByCtRatio(rawConsumptionKwh, tariffMissing ? null : rawCostRub, meter.ct_ratio);
    return {
      num: idx + 1, model: meter.model || 'Меркурий',
      serial: meter.serial_number || ('адрес ' + meter.addr),
      tenant: meter.tenant_name || '—', location: meter.location || '—', rental: meter.rental_name || '—',
      verification: meter.verification_due ? fmtDateRu(meter.verification_due) : '—',
      // Служебное поле, не колонка (addRow игнорирует ключи, которых нет в ws.columns) — цвет
      // заливки для ячейки срока поверки, см. styleDataRow ниже.
      _dueFill: verificationFill(meter.verification_due, today),
      startReading, endReading: liveReadingMissing ? null : endReading, ctRatio: meter.ct_ratio || 1,
      consumption: consumptionKwh, rate: tariffMissing ? null : rateAtPeriodEnd,
      total: (tariffMissing || costRub == null) ? null : costRub,
      signatory: meter.signatory_name || '—',
    };
  });
}
function objectsTotals(rows) {
  return {
    consumption: Math.round(rows.reduce((s, r) => s + (r.consumption || 0), 0) * 1000) / 1000,
    total: rows.some((r) => r.total != null) ? Math.round(rows.reduce((s, r) => s + (r.total || 0), 0) * 100) / 100 : null,
  };
}
const BRAND = { blue: 'FF008DD2', teal: 'FF73C8D7', lime: 'FFB0CB1F', ink: 'FF2B2A29', paleBlue: 'FFEAF5FB', paleLime: 'FFF5F8E3' };
function buildObjectsWorkbook(cols, rows, totals, periodLabel, sheetName) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName || 'Объекты', { views: [{ state: 'frozen', ySplit: 2 }] });
  ws.columns = cols.map((c) => ({ key: c.key, width: c.width }));
  // Альбомная ориентация + минимальные поля печати, растянуть по ширине на 1 страницу (31 авг,
  // просьба пользователя) — таблица из 13-14 колонок в книжной ориентации не влезала бы на лист.
  ws.pageSetup = {
    orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
  };

  ws.mergeCells(1, 1, 1, cols.length);
  const title = ws.getCell(1, 1);
  title.value = periodLabel;
  title.font = { bold: true, size: 13, color: { argb: 'FF008DD2' } };
  title.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 24;

  const headerRow = ws.getRow(2);
  cols.forEach((c, i) => { headerRow.getCell(i + 1).value = c.header; });
  headerRow.eachCell((c, colNumber) => {
    const isMoneyCol = cols[colNumber - 1].moneyCol;
    c.font = { bold: true, color: { argb: isMoneyCol ? BRAND.ink : 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isMoneyCol ? BRAND.teal : BRAND.blue } };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  // Выше, чем раньше (была 48) — при узких колонках (см. width в OBJECTS_EXPORT_COLS) длинные
  // заголовки вроде «Коэф. трансформации» переносятся на 2-3 строки, и на 48pt нижняя строка
  // обрезалась (жалоба 31 авг). 64pt с запасом помещает 3 строки текста.
  headerRow.height = 64;

  const styleDataRow = (row, extra) => {
    for (let colNumber = 1; colNumber <= cols.length; colNumber++) {
      const c = row.getCell(colNumber);
      const def = cols[colNumber - 1];
      if (def.fmt) c.numFmt = def.fmt;
      // По центру и по вертикали, и по горизонтали — для ВСЕХ ячеек разом, не только числовых
      // (просьба пользователя 31 авг), включая текстовые (Арендатор, ФИО и т.п.). 07.09.2026:
      // на экране был короткий эксперимент с левым краем у Арендатор/Наименование аренды/
      // № помещения — пользователь посмотрел и попросил обратно по центру, поэтому здесь
      // по-прежнему одно правило без исключений, отчёт и экран снова совпадают сами собой.
      c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: !OBJECTS_EXPORT_NUMERIC_KEYS.has(def.key) };
      if (extra) extra(c, def);
    }
  };
  for (const r of rows) {
    const row = ws.addRow(r);
    const zebra = row.number % 2 === 1;
    styleDataRow(row, (c, def) => {
      c.border = { bottom: { style: 'hair', color: { argb: 'FFDADCDD' } } };
      if (def.moneyCol) c.font = { color: { argb: 'FF1A6B7A' } };
      if (zebra) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.paleBlue } };
      // Строго после зебры — иначе полосатая заливка затёрла бы предупреждение о сроке поверки.
      if (def.key === 'verification' && r._dueFill) {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: r._dueFill } };
      }
    });
  }
  // Порядок присваивания важен: если после скрытия столбцов первым видимым оказался сам
  // consumption/total (редкая, но возможная комбинация), подпись "Итого" должна перекрыть число,
  // а не наоборот — поэтому она проставляется последней.
  const totalRowData = { consumption: totals.consumption, total: totals.total };
  totalRowData[cols[0].key] = 'Итого';
  const totalRow = ws.addRow(totalRowData);
  styleDataRow(totalRow, (c) => {
    c.font = { bold: true, color: { argb: BRAND.ink } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND.paleLime } };
    c.border = { top: { style: 'medium', color: { argb: BRAND.ink } } };
  });
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: cols.length } };
  return wb;
}

app.get('/api/objects/export', async (req, res) => {
  if (!req.modem) return res.status(400).json({ error: 'к проекту не привязан модем' });
  const siteId = parseSiteId(req);
  if (!siteId) return res.status(400).json({ error: 'сначала выберите объект' });
  const category = OBJECTS_CATEGORY_LABELS[req.query.category] ? req.query.category : 'rent';
  const today = hourSlot(Date.now()).date;
  const { month, periodStart, periodEnd, asOfToday } = resolveObjectsPeriod(req, today);
  const format = req.query.format === 'csv' ? 'csv' : 'xlsx';

  // Скрытые столбцы (см. objColVisEditMode/objHiddenColumns на клиенте) не попадают в выгрузку
  // ни в одном формате, независимо от роли (07.09.2026, по просьбе) — раньше здесь была
  // раздвоенная логика (Мастер получал ВСЕ столбцы всегда, «Пользователь» — отфильтрованные),
  // что разошлось с только что изменённым экранным поведением: закрытая шестерёнка сворачивает
  // и таблицу Мастера до набора «Пользователя» (см. renderObjTable/showAllForEdit в index.html),
  // а выгрузка так и продолжала бы отдавать всё — отчёт не совпадал бы с тем, что человек только
  // что видел на экране. `cols` дальше используется и для csv, и для xlsx — одна точка правки
  // закрывает оба формата разом.
  const hidden = getObjHiddenColumns(req.projectId);
  const visibleKeys = OBJECTS_EXPORT_COLS.map((c) => c.key).filter((k) => !hidden.includes(k));
  const cols = objectsExportCols(visibleKeys, periodStart, periodEnd, asOfToday, 'месяца');
  if (!cols.length) return res.status(400).json({ error: 'все столбцы скрыты — экспортировать нечего' });

  const meters = db.prepare('SELECT * FROM meters WHERE modem_id = ? AND site_id = ? AND category = ? ORDER BY addr').all(req.modem.id, siteId, category);
  const rows = buildObjectsRows(meters, siteId, periodStart, periodEnd, today);
  const totals = objectsTotals(rows);
  const site = db.prepare('SELECT name FROM sites WHERE id = ?').get(siteId);
  const siteName = site ? site.name : ('#' + siteId);
  const periodLabel = `${siteName} · ${OBJECTS_CATEGORY_LABELS[category]} · период: ${fmtDateRu(periodStart)} – ${fmtDateRu(periodEnd)}`;
  const filenameBase = `${siteName} - ${OBJECTS_CATEGORY_LABELS[category]} - ${month || (periodStart + '_' + periodEnd)}`;

  if (format === 'csv') {
    const escText = (v) => { const s = String(v); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const escNum = (v) => v == null ? '' : String(v).replace('.', ',');
    const cell = (col, v) => v == null ? '' : (OBJECTS_EXPORT_NUMERIC_KEYS.has(col.key) ? escNum(v) : escText(v));
    const lines = [
      escText(periodLabel),
      cols.map((c) => escText(c.header)).join(';'),
      ...rows.map((r) => cols.map((c) => cell(c, r[c.key])).join(';')),
      cols.map((c) => c.key === cols[0].key ? escText('Итого') : cell(c, totals[c.key])).join(';'),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report.csv"; filename*=UTF-8''${encodeURIComponent(filenameBase + '.csv')}`);
    return res.send('﻿' + lines.join('\r\n'));
  }

  const wb = buildObjectsWorkbook(cols, rows, totals, periodLabel, 'Объекты');
  const filename = filenameBase + '.xlsx';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  await wb.xlsx.write(res);
  res.end();
});

// ── Автоматизированные отчёты (07.09.2026) ───────────────────────────────────────────────────
// Отчётный день (meters.report_day) задаётся КАЖДОМУ прибору отдельно: у арендаторов разные
// расчётные дни по договорам, и в одном здании их одновременно несколько. В отчётный день все
// приборы ОДНОГО объекта с ОДНИМ и тем же днём собираются в один файл и уходят одним письмом
// (решение пользователя 07.09.2026). Тип учёта (Аренда/Технические/Коммерческие) на группировку
// НЕ влияет: если прибор в отчёте не нужен, ему просто не назначают отчётный день — это и есть
// фильтр, отдельного переключателя «включать в отчёт» заводить незачем.
//
// Период — от отчётного дня ПРОШЛОГО месяца по день ПЕРЕД текущим включительно (день 20 →
// 20.08–19.09). Такие периоды стыкуются встык: показания на конец одного равны показаниям на
// начало следующего, ни одни сутки не посчитаны дважды и ни одни не потеряны. К моменту отправки
// (после полуночи отчётного дня) данные за весь период уже собраны — отчёт не приходится
// пересылать уточнённым.
//
// Столбцы — те же, что в «Объектах», но без даты поверки, тарифа, стоимости и примечания
// (просьба пользователя): отчёт отвечает на вопрос «сколько потреблено», а не «сколько должен».
const REPORT_COL_KEYS = ['num', 'tenant', 'rental', 'location', 'model', 'serial',
                         'startReading', 'endReading', 'ctRatio', 'consumption'];
const REPORT_SEND_AFTER_MIN = 30;          // не раньше 00:30 местного времени объекта
const REPORT_TICK_MS = 15 * 60 * 1000;

function daysInMonthOf(dateStr) {
  const [Y, M] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(Y, M, 0)).getUTCDate();
}
// Прибор с отчётным днём 29-31 в коротком месяце обязан отработать в его последний день, иначе
// в феврале отчёт молча пропал бы. То же кламп-правило применяется и к НАЧАЛУ периода
// (reportPeriodFor), поэтому стыковка периодов сохраняется и на таких днях: период, закрытый
// 27.02, продолжается периодом, начатым 28.02.
function reportFiresOn(reportDay, dateStr) {
  const day = Number(dateStr.slice(8, 10));
  const last = daysInMonthOf(dateStr);
  return reportDay === day || (day === last && reportDay > last);
}
function reportPeriodFor(reportDay, sendDate) {
  const [Y, M] = sendDate.split('-').map(Number);
  const py = M === 1 ? Y - 1 : Y, pm = M === 1 ? 12 : M - 1;
  const prevMonth = `${py}-${String(pm).padStart(2, '0')}`;
  const startDay = Math.min(reportDay, daysInMonthOf(prevMonth + '-01'));
  return {
    periodStart: `${prevMonth}-${String(startDay).padStart(2, '0')}`,
    periodEnd: addDaysStr(sendDate, -1),
  };
}
const reportMetersStmt = db.prepare(`
  SELECT me.*, mo.project_id
    FROM meters me JOIN modems mo ON me.modem_id = mo.id
   WHERE me.report_day IS NOT NULL AND me.site_id IS NOT NULL AND me.decommissioned_at IS NULL
   ORDER BY me.addr`);
// Группы (объект + отчётный день), которым положено уйти в указанную дату. Выведенные из
// эксплуатации приборы (decommissioned_at) исключены на уровне запроса: их больше не опрашивают,
// в отчёте они дали бы застывшие показания и пустой расход.
function reportGroupsOn(dateStr) {
  const groups = new Map();
  for (const me of reportMetersStmt.all()) {
    if (!reportFiresOn(me.report_day, dateStr)) continue;
    const key = me.site_id + '|' + me.report_day;
    if (!groups.has(key)) {
      groups.set(key, { siteId: me.site_id, projectId: me.project_id, day: me.report_day, meters: [] });
    }
    groups.get(key).meters.push(me);
  }
  return [...groups.values()];
}
const siteNameStmt = db.prepare('SELECT name FROM sites WHERE id = ?');
const reportProjectStmt = db.prepare('SELECT name, report_email FROM projects WHERE id = ?');
// Сборка и отправка одного письма. asOfToday=false осознанно: период всегда заканчивается ВЧЕРА,
// то есть заведомо в прошлом, и пометка «ещё не завершён» в заголовке столбца здесь невозможна.
async function sendSiteReport({ siteId, day, meters, recipients, periodStart, periodEnd, today }) {
  const cols = objectsExportCols(REPORT_COL_KEYS, periodStart, periodEnd, false, 'периода');
  const rows = buildObjectsRows(meters, siteId, periodStart, periodEnd, today);
  const totals = objectsTotals(rows);
  const site = siteNameStmt.get(siteId);
  const siteName = site ? site.name : ('#' + siteId);
  const periodTxt = `${fmtDateRu(periodStart)} – ${fmtDateRu(periodEnd)}`;
  const wb = buildObjectsWorkbook(cols, rows, totals, `${siteName} · отчёт за период: ${periodTxt}`, 'Отчёт');
  const content = await wb.xlsx.writeBuffer();
  // Письмо уходит и текстом, и HTML (multipart/alternative). Так его лучше пропускают спам-фильтры
  // (07.09.2026: первое же письмо с отчётом попало получателю в «Спам») — письмо из одного plain
  // text со вложением и ссылкой выглядит для них хуже обычного письма с телом. HTML нарочно
  // простейший, без картинок и вёрстки-макета: тяжёлый шаблон рассылки, наоборот, поднимает балл.
  // Тема — обычной фразой, без цепочки разделителей «·»: её читает человек в списке писем, и
  // важное не должно теряться в хвосте после обрезки.
  const escHtml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const facts = [
    ['Объект', siteName],
    ['Период', periodTxt],
    ['Отчётный день', day + ' число месяца'],
    ['Приборов в отчёте', String(rows.length)],
    ['Суммарный расход', fmtRu(totals.consumption) + ' кВт·ч'],
  ];
  await mailer.sendMail({
    to: recipients,
    subject: `Отчёт о потреблении электроэнергии, ${siteName}, ${periodTxt}`,
    text: facts.map(([k, v]) => k + ': ' + v).join('\n')
        + '\n\nОтчёт во вложении.\nОткрыть панель: https://askue.o-dir.ru/',
    html: '<p>Отчёт о потреблении электроэнергии — во вложении.</p><table>'
        + facts.map(([k, v]) => `<tr><td style="padding:2px 14px 2px 0;color:#555">${escHtml(k)}</td>`
            + `<td style="padding:2px 0"><b>${escHtml(v)}</b></td></tr>`).join('')
        + '</table><p><a href="https://askue.o-dir.ru/">Открыть панель АСКУЭ</a></p>',
    attachments: [{ filename: `${siteName} - отчёт ${periodStart} - ${periodEnd}.xlsx`, content: Buffer.from(content) }],
  });
  return { siteName, metersCount: rows.length, consumption: totals.consumption, periodStart, periodEnd, periodTxt };
}
const findReportLogStmt = db.prepare(
  'SELECT status FROM report_log WHERE site_id = ? AND report_day = ? AND period_end = ?');
const upsertReportLogStmt = db.prepare(`
  INSERT INTO report_log (project_id, site_id, report_day, period_start, period_end,
                          meters_count, recipients, status, error, sent_at)
  VALUES (@projectId, @siteId, @day, @periodStart, @periodEnd, @metersCount, @recipients, @status, @error, @sentAt)
  ON CONFLICT(site_id, report_day, period_end) DO UPDATE SET
    period_start = excluded.period_start, meters_count = excluded.meters_count,
    recipients = excluded.recipients, status = excluded.status,
    error = excluded.error, sent_at = excluded.sent_at`);
// Тик планировщика: раз в 15 минут, считает только по SQLite и на шину RS-485 не ходит (как
// tickAlerts). Раньше 00:30 местного времени не отправляем — последним получасовкам вчерашнего
// дня нужно успеть долететь с профиля счётчика. Если сервер в это время лежал, отчёт уйдёт при
// первой возможности В ТОТ ЖЕ ДЕНЬ, а на следующий день его группа уже не сработает — поэтому
// пропущенный день остаётся пропущенным осознанно: слать «вчерашний» отчёт под видом сегодняшнего
// хуже, чем не слать (получатель сверяет период по дате письма).
let reportTickBusy = false;
async function tickReports() {
  if (reportTickBusy) return;   // SMTP заметно медленнее тика — второй проход поверх первого не нужен
  reportTickBusy = true;
  try {
    const stamp = localStamp(Date.now());
    const today = stamp.date;
    const [hh, mm] = stamp.key.slice(11).split(':').map(Number);
    if (hh * 60 + mm < REPORT_SEND_AFTER_MIN) return;
    for (const g of reportGroupsOn(today)) {
      const { periodStart, periodEnd } = reportPeriodFor(g.day, today);
      const prev = findReportLogStmt.get(g.siteId, g.day, periodEnd);
      if (prev && prev.status === 'sent') continue;
      const proj = reportProjectStmt.get(g.projectId);
      // Адрес не настроен — не ошибка и не повод писать в журнал (тот же принцип, что у
      // notifyAlertByEmail): раздел просто ещё не доведён до конца, ругаться не на что.
      if (!proj || !proj.report_email) continue;
      const logRow = {
        projectId: g.projectId, siteId: g.siteId, day: g.day, periodStart, periodEnd,
        metersCount: g.meters.length, recipients: proj.report_email, sentAt: Date.now(),
      };
      try {
        await sendSiteReport({ ...g, recipients: proj.report_email, periodStart, periodEnd, today });
        upsertReportLogStmt.run({ ...logRow, status: 'sent', error: null, sentAt: Date.now() });
        console.log(`✅ отчёт отправлен: объект ${g.siteId}, день ${g.day}, ${periodStart}–${periodEnd}`);
      } catch (e) {
        // Строка со status='error' не занимает ключ навсегда: следующий тик того же дня увидит
        // её и попробует снова (в журнале останется последняя попытка с текстом ошибки).
        upsertReportLogStmt.run({ ...logRow, status: 'error', error: String(e.message).slice(0, 300), sentAt: Date.now() });
        console.error('⚠️ отчёт не отправлен:', e.message);
      }
    }
  } catch (e) {
    console.error('⚠️ tickReports:', e.message);
  } finally {
    reportTickBusy = false;
  }
}
setInterval(tickReports, REPORT_TICK_MS);
setTimeout(tickReports, 90 * 1000);   // после старта — не сразу, дать процессу подняться

// Получатели отчётов — на ПРОЕКТ и отдельно от notify_email (см. db.js report_email):
// инциденты адресованы технической службе, отчёт о потреблении — бухгалтерии/собственнику.
app.get('/api/reports/email', (req, res) => {
  if (!req.projectId) return res.status(400).json({ error: 'нет активного проекта' });
  const row = db.prepare('SELECT report_email FROM projects WHERE id = ?').get(req.projectId);
  res.json({ email: row ? row.report_email : null });
});
app.post('/api/reports/email', auth.requireMaster, (req, res) => {
  if (!req.projectId) return res.status(400).json({ error: 'нет активного проекта' });
  const raw = typeof req.body.email === 'string' ? req.body.email.trim() : '';
  if (raw) {
    const addrs = parseNotifyEmails(raw);
    if (!addrs.length || !addrs.every((a) => NOTIFY_EMAIL_RE.test(a))) {
      return res.status(400).json({ error: 'некорректный email' });
    }
  }
  db.prepare('UPDATE projects SET report_email = ? WHERE id = ?').run(raw || null, req.projectId);
  res.json({ ok: true, email: raw || null });
});
// Отчётный день прибора. 0/пусто/null — снять день (прибор перестаёт попадать в отчёты).
app.post('/api/reports/meter/:id', auth.requireMaster, (req, res) => {
  if (!req.modem) return res.status(400).json({ error: 'к проекту не привязан модем' });
  const meter = db.prepare('SELECT * FROM meters WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!meter || meter.modem_id !== req.modem.id) return res.status(404).json({ error: 'счётчик не найден' });
  const raw = (req.body || {}).report_day;
  const day = (raw === null || raw === '' || raw === undefined) ? null : parseInt(raw, 10);
  if (day !== null && !(Number.isInteger(day) && day >= 1 && day <= 31)) {
    return res.status(400).json({ error: 'отчётный день должен быть числом от 1 до 31' });
  }
  db.prepare('UPDATE meters SET report_day = ? WHERE id = ?').run(day, meter.id);
  res.json({ ok: true, report_day: day });
});
// «Отправить сейчас» — та же группа и тот же файл, что уйдут планово, но период считается «как
// если бы отчётный день был сегодня». В report_log НЕ пишется намеренно: иначе ручная проверка
// заняла бы ключ идемпотентности и отменила плановую рассылку этого же дня.
app.post('/api/reports/send-now', auth.requireMaster, async (req, res) => {
  const b = req.body || {};
  const siteId = parseInt(b.siteId, 10);
  const day = parseInt(b.day, 10);
  if (!requireOwnSite(req, res, siteId)) return res.status(400).json({ error: 'объект не найден' });
  if (!(Number.isInteger(day) && day >= 1 && day <= 31)) return res.status(400).json({ error: 'некорректный отчётный день' });
  const proj = reportProjectStmt.get(req.projectId);
  if (!proj || !proj.report_email) return res.status(400).json({ error: 'сначала укажите email для отчётов' });
  const meters = db.prepare(`SELECT * FROM meters
                              WHERE site_id = ? AND report_day = ? AND decommissioned_at IS NULL
                              ORDER BY addr`).all(siteId, day);
  if (!meters.length) return res.status(400).json({ error: 'на этот день не назначено ни одного прибора' });
  const today = localStamp(Date.now()).date;
  const { periodStart, periodEnd } = reportPeriodFor(day, today);
  try {
    const r = await sendSiteReport({ siteId, day, meters, recipients: proj.report_email, periodStart, periodEnd, today });
    res.json({ ok: true, to: proj.report_email, metersCount: r.metersCount, period: r.periodTxt });
  } catch (e) {
    res.status(500).json({ error: 'письмо не отправлено: ' + e.message });
  }
});
app.get('/api/reports/log', (req, res) => {
  if (!req.projectId) return res.json({ log: [] });
  const log = db.prepare(
    'SELECT * FROM report_log WHERE project_id = ? ORDER BY sent_at DESC LIMIT 20').all(req.projectId);
  res.json({ log });
});

app.post('/api/mercury/profile/backfill/start', (req, res) => {
  if (!req.meter) return res.status(400).json({ error: 'к проекту не привязан счётчик' });
  startBackfill(req.modem, req.meter);
  res.json({ ok: true });
});


// ── Регистратор: произвольный диапазон дат по мгновенным величинам + энергии ──────────────────
// Даунсэмплинг на сервере — иначе "весь период" (до 24 мес., 10-минутные слоты — под сотню тысяч
// строк) отдавал бы под сотню тысяч точек на серию и график бы тормозил. Пороги подобраны так,
// чтобы в худшем случае отдавать не больше ~2000 точек на серию. Зум на клиенте — это просто
// повторный запрос с более узким диапазоном (тогда порог естественно смягчается сам по себе),
// отдельного механизма для zoom не нужно.
const REGISTER_METRICS = ['u_a', 'u_b', 'u_c', 'i_a', 'i_b', 'i_c', 'p', 'q', 's', 'pf', 'freq', 'temp', 'kwh'];
const REGISTER_SUM_METRICS = new Set(['kwh']); // энергия за интервал — суммируется при укрупнении, не усредняется
function localTs(dateStr, hhmm) {
  // date/slot хранятся как московское время (см. hourSlot/tenMinSlot выше) — new Date(Y,M,D,hh,mm)
  // без явного UTC трактовал бы их в таймзоне СЕРВЕРНОГО процесса (UTC), давая эпоху, отстоящую
  // от истинной на те же +3ч; браузер потом честно показывает эту уже неверную эпоху в своей
  // локальной зоне — итоговый сдвиг +3ч (баг найден 30 авг: "5:25 утра, а график показывает
  // 08:20"). Date.UTC + вычитание того же смещения, что и при записи, не зависит от таймзоны
  // серверного процесса.
  const [Y, M, D] = dateStr.split('-').map(Number);
  const [hh, mm] = (hhmm || '00:00').split(':').map(Number);
  return Date.UTC(Y, M - 1, D, hh, mm) - SITE_TZ_OFFSET_MS;
}
function pickRegisterRow(row) {
  const out = {};
  for (const m of REGISTER_METRICS) out[m] = row[m] == null ? null : Math.round(row[m] * 1000) / 1000;
  return out;
}
app.get('/api/mercury/register', (req, res) => {
  if (!req.meter) return res.json({ points: [], granularity: 'raw', from: null, to: null });
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : weekAgo;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : today;
  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1);

  let granularity, rows;
  if (days <= 14) {
    granularity = 'raw';
    const cols = REGISTER_METRICS.join(', ');
    rows = db.prepare(`SELECT date, slot, ${cols} FROM readings
        WHERE meter_id = ? AND date >= ? AND date <= ? ORDER BY date, slot`)
      .all(req.meter.id, from, to)
      .map(r => ({ t: localTs(r.date, r.slot), ...pickRegisterRow(r) }));
  } else if (days <= 92) {
    granularity = 'hourly';
    const cols = REGISTER_METRICS.map(m => `${REGISTER_SUM_METRICS.has(m) ? 'SUM' : 'AVG'}(${m}) AS ${m}`).join(', ');
    rows = db.prepare(`SELECT date, substr(slot,1,2) AS hh, ${cols} FROM readings
        WHERE meter_id = ? AND date >= ? AND date <= ? GROUP BY date, hh ORDER BY date, hh`)
      .all(req.meter.id, from, to)
      .map(r => ({ t: localTs(r.date, r.hh + ':00'), ...pickRegisterRow(r) }));
  } else {
    granularity = 'daily';
    const cols = REGISTER_METRICS.map(m => `${REGISTER_SUM_METRICS.has(m) ? 'SUM' : 'AVG'}(${m}) AS ${m}`).join(', ');
    rows = db.prepare(`SELECT date, ${cols} FROM readings
        WHERE meter_id = ? AND date >= ? AND date <= ? GROUP BY date ORDER BY date`)
      .all(req.meter.id, from, to)
      .map(r => ({ t: localTs(r.date, '00:00'), ...pickRegisterRow(r) }));
  }
  res.json({ points: rows, granularity, from, to });
});

// Конфигурация управления нагрузкой
app.get('/api/load/config', (req, res) => {
  res.json(req.modem ? state.getModemState(req.modem.id).loadCfg : state.DEFAULT_LOAD_CFG);
});
app.post('/api/load/config', (req, res) => {
  if (!req.modem) return res.status(400).json({ error: 'к проекту не привязан модем' });
  const st = state.getModemState(req.modem.id);
  const b = req.body || {};
  if (typeof b.loadName === 'string') st.loadCfg.loadName = b.loadName.slice(0, 40);
  if ([0, 1, 2, 3].includes(b.feedbackPin)) st.loadCfg.feedbackPin = b.feedbackPin;
  if (typeof b.feedbackActiveHigh === 'boolean') st.loadCfg.feedbackActiveHigh = b.feedbackActiveHigh;
  if (b.pinNames && typeof b.pinNames === 'object')
    for (const k of [1, 2, 3]) if (typeof b.pinNames[k] === 'string') st.loadCfg.pinNames[k] = b.pinNames[k].slice(0, 24);
  state.saveLoadCfg(req.modem.id);
  res.json({ ok: true, loadCfg: st.loadCfg });
});

// Тариф на электроэнергию — на ОБЪЕКТ (см. db.js site_tariffs; переехал с модема 31 авг по
// просьбе пользователя — с несколькими объектами на проекте выбор тарифа "для объекта"
// логичнее, чем "для прибора учёта"). История с датой действия, append-only: для правки
// опечатки — удалить запись, а не редактировать её на месте. requireMaster — «Пользователь»
// сюда и так не достучится (эндпоинт вне префикса /api/objects/, см. LIMITED_ROLE_ALLOWED), но
// проверка на месте явно, тем же паттерном, что у /api/objects/meter/:id и /column-prefs.
const insertSiteTariffStmt = db.prepare(
  'INSERT INTO site_tariffs (site_id, rate, valid_from, created_at) VALUES (?, ?, ?, ?)');
const listSiteTariffsStmt = db.prepare(
  'SELECT id, rate, valid_from FROM site_tariffs WHERE site_id = ? ORDER BY valid_from DESC, id DESC');
// "Текущая" — ставка, чья дата действия уже НАСТУПИЛА (valid_from <= сегодня), а не просто
// последняя добавленная/самая поздняя по дате запись: history отсортирована valid_from DESC,
// поэтому раньше здесь брали history[0], и заранее внесённый БУДУЩИЙ тариф (valid_from в
// будущем) ошибочно показывался как "текущий", хотя реальный расчёт стоимости
// (computeSiteTariffCost выше) всегда правильно брал действующую на сегодня ставку — баг был
// только в этой метке на UI (жалоба 30 авг, актуальна и после переезда на объект).
function pickCurrentTariff(historyDescByDate) {
  const today = hourSlot(Date.now()).date;
  return historyDescByDate.find(r => r.valid_from <= today) || null;
}
function requireOwnSite(req, res, siteId) {
  if (!req.projectId || !Number.isInteger(siteId)) return null;
  return db.prepare('SELECT id FROM sites WHERE id = ? AND project_id = ?').get(siteId, req.projectId) || null;
}
app.get('/api/site/tariff', (req, res) => {
  const siteId = parseInt(req.query.siteId, 10);
  if (!requireOwnSite(req, res, siteId)) return res.json({ current: null, history: [] });
  const history = listSiteTariffsStmt.all(siteId);
  res.json({ current: pickCurrentTariff(history), history });
});
app.post('/api/site/tariff', auth.requireMaster, (req, res) => {
  const siteId = parseInt((req.body || {}).siteId, 10);
  if (!requireOwnSite(req, res, siteId)) return res.status(400).json({ error: 'объект не найден' });
  const b = req.body || {};
  const rate = Number(b.rate);
  if (!Number.isFinite(rate) || rate <= 0) return res.status(400).json({ error: 'тариф должен быть положительным числом' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.validFrom || '')) return res.status(400).json({ error: 'некорректная дата действия' });
  insertSiteTariffStmt.run(siteId, rate, b.validFrom, Date.now());
  logAudit(req, 'tariff.create', `site:${siteId}`, `rate=${rate}, validFrom=${b.validFrom}`);
  const history = listSiteTariffsStmt.all(siteId);
  res.json({ ok: true, current: pickCurrentTariff(history), history });
});
app.delete('/api/site/tariff/:id', auth.requireMaster, (req, res) => {
  const siteId = parseInt(req.query.siteId, 10);
  if (!requireOwnSite(req, res, siteId)) return res.status(400).json({ error: 'объект не найден' });
  db.prepare('DELETE FROM site_tariffs WHERE id = ? AND site_id = ?').run(req.params.id, siteId);
  logAudit(req, 'tariff.delete', `site:${siteId}`, `tariffId=${req.params.id}`);
  const history = listSiteTariffsStmt.all(siteId);
  res.json({ ok: true, current: pickCurrentTariff(history), history });
});

app.post('/api/gpo/:action', (req, res) => {
  if (!req.modem) return res.status(400).json({ error: 'к проекту не привязан модем' });
  return state.serializeGpioFor(req.modem.id, async () => {
    if (req.params.action !== 'on' && req.params.action !== 'off')
      return res.status(400).json({ error: 'неизвестное действие' });
    const on = req.params.action === 'on';
    const pins = await setGpo(req.modem, on);
    const st = state.getModemState(req.modem.id);
    res.json({ ok: true, pins, load: loadStatus(pins, st.loadCfg) });
  }).catch(e => res.status(500).json({ error: e.message }));
});

app.get('/api/info', (req, res) => {
  if (!req.modem) return res.json({ online: false });
  return state.serializeGpioFor(req.modem.id, async () => {
    if (!await modemOnline(req.modem.imei)) return res.json({ online: false });
    const r = await batch(req.modem.imei, [
      { key: 'iccid', bytes: CMD.ICCID, id: ID.ICCID },
      { key: 'lbs',   bytes: CMD.LBS,   id: ID.LBS },
    ]);
    res.json({
      online: true,
      iccid: r.iccid && !r.iccid.error ? r.iccid.answer : null,
      lbs:   r.lbs   && !r.lbs.error   ? parseLbs(r.lbs.answer) : null,
    });
  }).catch(e => res.status(500).json({ error: e.message }));
});

// Сменить направление вывода GPIO1-3 (вход/выход). Применение перезагружает модем (~1 мин).
app.post('/api/pin/:name/direction', (req, res) => {
  if (!req.modem) return res.status(400).json({ error: 'к проекту не привязан модем' });
  return state.serializeGpioFor(req.modem.id, async () => {
    const n = GPIO_NUM[req.params.name];
    if (!n) return res.status(400).json({ error: 'можно менять направление только GPIO1-3' });
    const dir = req.body.dir === 'out' ? 1 : 0;
    const pull = req.body.pull ? 1 : 0;
    await writeSettings(req.modem.imei, [`AT$GPIO_SET${n}=${dir},${pull}`]);
    res.json({ ok: true, note: 'настройка отправлена; модем применит её и переподключится' });
  }).catch(e => res.status(500).json({ error: e.message }));
});

app.post('/api/pin/:name/level', (req, res) => {
  if (!req.modem) return res.status(400).json({ error: 'к проекту не привязан модем' });
  const st = state.getModemState(req.modem.id);
  st.lastUserCmd = Date.now();   // как в setGpo: фоновый опрос уступает свежей команде управления
  return state.serializeGpioFor(req.modem.id, async () => {
    const n = GPIO_NUM[req.params.name];
    if (!n) return res.status(400).json({ error: 'неизвестный вывод' });
    const lvl = req.body.level ? 1 : 0;
    const setId = await queueCommand(req.modem.imei, Buffer.from(`$gp${n}=${lvl}\r`, 'latin1'), ID.SET);
    const readId = await queueCommand(req.modem.imei, CMD.READ, ID.READ);
    await triggerSend();
    const setRes = await waitAnswer(setId);
    if (setRes.error) throw new Error(`модем отклонил команду (вывод ${req.params.name} настроен как выход?)`);
    const pins = parsePins((await waitAnswer(readId)).answer);
    // Кэш статуса обновляем ОБЯЗАТЕЛЬНО (как это делает setGpo для GPO): /api/status отдаёт
    // именно st.cachedStatus, а фронтенд перечитывает статус каждые 10с. Без этого карточка
    // вывода через несколько секунд возвращалась к ДОкомандному уровню и висела так до
    // следующего фонового опроса (до 60с) — выглядело как «выключил GPIO3, а он сам вернулся
    // в 1», хотя на модеме вывод уже был выключен (жалоба 5 сент; в БД Collector'а видно, что
    // $gp3=0 отработал без ошибки, а READ сразу за ним вернул C0, то есть уровень 0).
    if (pins) {
      st.lastUserCmd = Date.now();
      st.cachedStatus = {
        ...st.cachedStatus, online: true, reconnecting: false,
        pins, load: loadStatus(pins, st.loadCfg), loadCfg: st.loadCfg, ts: Date.now(),
      };
    }
    res.json({ ok: true, pins });
  }).catch(e => res.status(500).json({ error: e.message }));
});

app.post('/api/gpo/vcc', (req, res) => {
  if (!req.modem) return res.status(400).json({ error: 'к проекту не привязан модем' });
  return state.serializeGpioFor(req.modem.id, async () => {
    const mode = req.body.mode === 'supply' ? 0 : 1;
    await writeSettings(req.modem.imei, [`AT$GPIO_VCC4=${mode}`]);
    res.json({ ok: true, note: 'настройка отправлена; модем применит её и переподключится' });
  }).catch(e => res.status(500).json({ error: e.message }));
});

// ── Лимиты потребления: чтение, запись, диаграмма ─────────────────────────────
function limitsPayload(meter) {
  const today = localStamp(Date.now()).date;
  const limits = meterLimits(meter.id);
  const usage = {};
  for (const kind of LIMIT_KINDS) usage[kind] = usedInPeriod(meter.id, meter.ct_ratio, kind, today);
  return { limits, usage, ctRatio: meter.ct_ratio || 1, today };
}
app.get('/api/limits', (req, res) => {
  if (!req.meter) return res.json({ noMeter: true, limits: {}, usage: {} });
  res.json(limitsPayload(req.meter));
});
const upsertLimitStmt = db.prepare(`
  INSERT INTO limits (scope, scope_id, kind, value, enabled, updated_at)
  VALUES ('meter', @id, @kind, @value, 1, @now)
  ON CONFLICT(scope, scope_id, kind) DO UPDATE SET
    value = excluded.value, enabled = 1, updated_at = excluded.updated_at`);
const deleteLimitStmt = db.prepare(
  "DELETE FROM limits WHERE scope = 'meter' AND scope_id = ? AND kind = ?");
app.post('/api/limits', auth.requireMaster, (req, res) => {
  if (!req.meter) return res.status(400).json({ error: 'к проекту не привязан счётчик' });
  const now = Date.now();
  for (const kind of LIMIT_KINDS) {
    const raw = req.body ? req.body[kind] : undefined;
    if (raw === undefined) continue;              // не прислали — не трогаем
    const str = String(raw).trim().replace(',', '.');
    if (!str) { deleteLimitStmt.run(req.meter.id, kind); continue; }   // пусто — снять лимит
    const v = Number(str);
    if (!Number.isFinite(v) || v <= 0) {
      return res.status(400).json({ error: 'лимит должен быть положительным числом' });
    }
    upsertLimitStmt.run({ id: req.meter.id, kind, value: v, now });
  }
  // Перепроверяем сразу, не дожидаясь тика: пользователь только что поднял порог, и инцидент
  // про прежний лимит обязан исчезнуть в этом же ответе, а не через четверть часа.
  evaluateLimits({
    id: req.meter.id, label: req.meter.label, modem_id: req.meter.modem_id,
    ct_ratio: req.meter.ct_ratio, decommissioned_at: req.meter.decommissioned_at,
    project_id: req.modem ? req.modem.project_id : req.projectId,
  }, localStamp(Date.now()).date);
  res.json(Object.assign({ ok: true }, limitsPayload(req.meter)));
});

// ── Диаграмма потребления ─────────────────────────────────────────────────────
// Намеренно НЕ связана с лимитами: это смотровое окно по расходу, а не проверка правила.
// Раньше масштаб столбца был общий с редактируемым лимитом, и чтобы посмотреть расход по суткам
// приходилось переключаться на «День», меняя заодно и то, какой лимит правишь (жалоба 6 сент).
// Теперь диапазон задаёт и глубину, и шаг столбца — так, чтобы столбцов везде было разумное
// число, а не два на весь график.
const CONS_RANGES = {
  day:     { bucket: 'hour', days: 1 },
  week:    { bucket: 'day',  days: 7 },
  month:   { bucket: 'day',  days: 30 },
  quarter: { bucket: 'day',  days: 91 },
};
// Та же формула объединения источников, что и в «Объектах»: kwh приоритетно, kwh_self — замена,
// не слагаемое. Часовой разрез нужен только для диапазона «1 день».
const hourlyKwhStmt = db.prepare(`
  SELECT substr(slot, 1, 2) AS hh, SUM(COALESCE(kwh, kwh_self)) AS kwh
    FROM readings WHERE meter_id = ? AND date = ? GROUP BY hh ORDER BY hh`);
const dailyKwhStmt = db.prepare(`
  SELECT date, SUM(COALESCE(kwh, kwh_self)) AS kwh FROM readings
   WHERE meter_id = ? AND date >= ? AND date <= ? GROUP BY date ORDER BY date`);
const firstSeenStmt = db.prepare('SELECT MIN(date) AS d FROM readings WHERE meter_id = ?');

app.get('/api/consumption/chart', (req, res) => {
  if (!req.meter) return res.json({ range: 'month', bucket: 'day', buckets: [] });
  const range = CONS_RANGES[req.query.range] ? req.query.range : 'month';
  const cfg = CONS_RANGES[range];
  const stamp = localStamp(Date.now());
  const today = stamp.date;
  const nowHH = stamp.key.slice(11, 13);
  const ct = req.meter.ct_ratio || 1;
  const r3 = v => Math.round(v * 1000) / 1000;
  const buckets = [];

  if (cfg.bucket === 'hour') {
    const map = new Map();
    for (const r of hourlyKwhStmt.all(req.meter.id, today)) map.set(r.hh, (r.kwh || 0) * ct);
    for (let h = 0; h < 24; h++) {
      const hh = String(h).padStart(2, '0');
      if (hh > nowHH) break;   // часов, которые ещё не наступили, на графике быть не должно
      buckets.push({ key: today + ' ' + hh, label: hh, kwh: r3(map.get(hh) || 0) });
    }
  } else {
    // Недельные столбцы выравниваем по понедельникам и тянем данные от начала первой недели,
    // иначе крайний столбец — огрызок в два-три дня, который читается как провал потребления.
    const wantFrom = addDaysStr(today, -(cfg.days - 1));
    const from = cfg.bucket === 'week' ? periodBounds('energy-week', wantFrom).from : wantFrom;
    const map = new Map();
    for (const r of dailyKwhStmt.all(req.meter.id, from, today)) map.set(r.date, (r.kwh || 0) * ct);
    if (cfg.bucket === 'day') {
      for (let d = from; d <= today; d = addDaysStr(d, 1)) {
        buckets.push({ key: d, label: d.slice(8) + '.' + d.slice(5, 7), kwh: r3(map.get(d) || 0) });
      }
    } else {
      for (let w = from; w <= today; w = addDaysStr(w, 7)) {
        let sum = 0;
        for (let k = 0; k < 7; k++) {
          const d = addDaysStr(w, k);
          if (d <= today) sum += map.get(d) || 0;
        }
        buckets.push({ key: w, label: w.slice(8) + '.' + w.slice(5, 7), kwh: r3(sum) });
      }
    }
  }

  // Окно отдаём целиком за запрошенный срок, ничего не обрезая, но периоды ДО первого
  // наблюдения помечаем: сбора там не было, и это не то же самое, что нулевое потребление.
  // Отличать их — задача отрисовки (закрашенная область с подписью), а не молчаливого пропуска.
  const firstSeen = firstSeenStmt.get(req.meter.id).d;
  if (firstSeen && cfg.bucket !== 'hour') {
    for (const b of buckets) {
      const bucketEnd = cfg.bucket === 'week' ? addDaysStr(b.key, 6) : b.key;
      if (bucketEnd < firstSeen) b.nodata = true;
    }
  }
  // Последний столбец — незакрытый период (текущий час/сутки/неделя): он ещё растёт, сравнивать
  // его с соседями как равного нельзя, фронтенд рисует его блёклым.
  if (buckets.length) buckets[buckets.length - 1].current = true;
  res.json({ range, bucket: cfg.bucket, buckets, firstSeen, today });
});

// ── Уведомления и отклонения: лента инцидентов ────────────────────────────────
// Роль «Пользователь» (limited) сюда не попадает вообще — общий гейт пускает её только в
// /api/objects/* (см. LIMITED_ROLE_ALLOWED), так что раздел Мастер-only без отдельной проверки.
app.get('/api/alerts', (req, res) => {
  if (!req.projectId) return res.json({ open: [], recent: [], now: Date.now() });
  const open = db.prepare(
    'SELECT * FROM alerts WHERE project_id = ? AND closed_at IS NULL ORDER BY severity, opened_at DESC'
  ).all(req.projectId);
  const recent = db.prepare(
    'SELECT * FROM alerts WHERE project_id = ? AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 50'
  ).all(req.projectId);
  res.json({ open, recent, now: Date.now() });
});
// «Обновить» в ленте: раньше кнопка лишь перечитывала уже записанные инциденты, поэтому после
// любой правки настроек выглядела сломанной — состояние не менялось. Теперь она прогоняет сам
// детектор. Это безопасно и дёшево: тик считает только по БД и на шину RS-485 не ходит.
app.post('/api/alerts/recheck', auth.requireMaster, (req, res) => {
  if (!req.projectId) return res.status(400).json({ error: 'нет активного проекта' });
  try { tickAlerts(); } catch (e) { return res.status(500).json({ error: e.message }); }
  const open = db.prepare(
    'SELECT * FROM alerts WHERE project_id = ? AND closed_at IS NULL ORDER BY severity, opened_at DESC'
  ).all(req.projectId);
  const recent = db.prepare(
    'SELECT * FROM alerts WHERE project_id = ? AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 50'
  ).all(req.projectId);
  res.json({ open, recent, now: Date.now() });
});
// Квитирование — на своей стороне, как и у тревог счётчика (см. ack_event_bits): инцидент
// остаётся открытым, пока держится условие, просто перестаёт мозолить глаза.
app.post('/api/alerts/:id/ack', auth.requireMaster, (req, res) => {
  if (!req.projectId) return res.status(400).json({ error: 'нет активного проекта' });
  db.prepare('UPDATE alerts SET ack_at = ? WHERE id = ? AND project_id = ?')
    .run(Date.now(), req.params.id, req.projectId);
  res.json({ ok: true });
});
// Email для доставки инцидентов/уведомлений (07 сент) — на ПРОЕКТ (см. db.js notify_email):
// инциденты считаются по всем счётчикам/модемам проекта разом, у объекта своего отдельного
// набора тревог нет. Строка допускает несколько адресов через запятую/пробел/точку с запятой —
// это ещё не сама отправка писем (см. CLAUDE.md «Доступ к почте»), только место назначения.
const NOTIFY_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function parseNotifyEmails(raw) {
  return (raw || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}
app.get('/api/notify/email', (req, res) => {
  if (!req.projectId) return res.status(400).json({ error: 'нет активного проекта' });
  const row = db.prepare('SELECT notify_email FROM projects WHERE id = ?').get(req.projectId);
  res.json({ email: row ? row.notify_email : null });
});
app.post('/api/notify/email', auth.requireMaster, (req, res) => {
  if (!req.projectId) return res.status(400).json({ error: 'нет активного проекта' });
  const raw = typeof req.body.email === 'string' ? req.body.email.trim() : '';
  if (raw) {
    const addrs = parseNotifyEmails(raw);
    if (!addrs.length || !addrs.every((a) => NOTIFY_EMAIL_RE.test(a))) {
      return res.status(400).json({ error: 'некорректный email' });
    }
  }
  db.prepare('UPDATE projects SET notify_email = ? WHERE id = ?').run(raw || null, req.projectId);
  res.json({ ok: true, email: raw || null });
});

app.post('/api/ussd', (req, res) => {
  if (!req.modem) return res.status(400).json({ error: 'к проекту не привязан модем' });
  return state.serializeGpioFor(req.modem.id, async () => {
    const code = String(req.body.code || '').trim();
    if (!/^[*#0-9]{2,24}$/.test(code)) return res.status(400).json({ error: 'некорректный USSD-код' });
    const bytes = Buffer.from('$ussd=0' + code + '\r', 'latin1');
    const id = await queueCommand(req.modem.imei, bytes, ID.USSD);
    await triggerSend();
    const r = await waitAnswer(id, 30000);
    if (r.error) throw new Error('USSD-запрос отклонён');
    res.json({ ok: true, answer: decodeUssd(r.answer) });
  }).catch(e => res.status(500).json({ error: e.message }));
});

initDb().then(() => {
  startDaemon();
  // Только localhost — наружу отдаёт nginx (askue.o-dir.ru, SSL) через reverse proxy.
  app.listen(PORT, '127.0.0.1', () => console.log(`✅ Панель iRZ запущена: http://127.0.0.1:${PORT}`));
  // Проверка SMTP-логина при каждом старте — ничего не отправляет (см. mailer.verifyTransport),
  // только логинится и закрывает соединение; неудача не мешает остальному приложению работать,
  // просто видно в pm2 logs, что почта не готова, ещё до первой попытки реального письма.
  mailer.verifyTransport()
    .then(() => console.log('✅ SMTP (irz_dir2@mail.ru) готов к отправке'))
    .catch((e) => console.error('⚠️ SMTP не отвечает:', e.message));
}).catch(e => { console.error('Ошибка старта:', e); process.exit(1); });
