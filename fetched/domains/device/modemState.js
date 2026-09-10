// Состояние времени выполнения по модему/счётчику — замена прежним глобальным синглтонам
// однотенантной версии панели (был один модем/один счётчик на весь процесс). Теперь на каждый
// modemId/meterId — своя запись в Map, с ленивой инициализацией и собственным файлом на диске.
const fs = require('fs');
const path = require('path');

// __dirname сместился при переносе файла в domains/device/ (P1-01) — путь поднимается на два
// уровня, чтобы DATA_DIR продолжал указывать на то же fetched/data/, что и раньше (иначе кэш
// конфигурации нагрузки/состояние модемов начал бы молча писаться в новую пустую директорию).
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function modemDir(modemId) {
  const dir = path.join(DATA_DIR, 'modems', String(modemId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const DEFAULT_LOAD_CFG = {
  loadName: 'Нагрузка',
  feedbackPin: 0,
  feedbackActiveHigh: true,
  pinNames: { 1: 'GPIO1', 2: 'GPIO2', 3: 'GPIO3' },
};

// ── По модему: очередь команд (serialize), кэш GPIO/CSQ/temp/LBS, конфиг нагрузки ──
// История сигнала/температуры больше не хранится тут (была JSON-файлом, 240 точек, терялась при
// рестарте) — пишется в БД, см. server.js saveModemSnapshot/modem_readings.
const modemStates = new Map();
function getModemState(modemId) {
  let st = modemStates.get(modemId);
  if (!st) {
    const dir = modemDir(modemId);
    const loadCfgFile = path.join(dir, 'load-config.json');
    st = {
      opQueueHi: [], opQueueLo: [], opRunning: false,
      gpioChain: Promise.resolve(),
      cachedStatus: { online: false, ts: 0 },
      pollingPromise: null,
      lastUserCmd: 0,
      loadCfg: { ...DEFAULT_LOAD_CFG, ...readJson(loadCfgFile, {}) },
      loadCfgFile,
    };
    modemStates.set(modemId, st);
  }
  return st;
}
// Очередь шины RS-485 (счётчики Меркурий) — несколько счётчиков физически на одной паре
// проводов, команды к ним нельзя слать параллельно. Приоритетная очередь (hi/lo), а не простая
// цепочка промисов — нужна, чтобы ручной клик ("Опросить счётчик сейчас") не вставал в конец
// очереди позади уже поставленных фоновых задач (при 8 счётчиках на шине фоновый круг занимает
// ~65-70с, см. CLAUDE.md). Уже ВЫПОЛНЯЮЩУЮСЯ задачу прервать нельзя (физический обмен по RS-485
// в процессе, обрыв соединения на середине команды — плохая идея, см. верх mercuryPoll.js), но
// приоритетная задача обгоняет все фоновые, что ещё стоят в очереди и не начались — так что
// ручной клик ждёт максимум завершения ОДНОЙ текущей задачи, а не всей очереди (жалоба 27 авг:
// ручной опрос ждал 15-40с из-за фоновых задач впереди себя).
function serializeFor(modemId, fn, opts = {}) {
  const st = getModemState(modemId);
  return new Promise((resolve, reject) => {
    (opts.priority ? st.opQueueHi : st.opQueueLo).push({ fn, resolve, reject });
    pumpOpQueue(st);
  });
}
function pumpOpQueue(st) {
  if (st.opRunning) return;
  const task = st.opQueueHi.shift() || st.opQueueLo.shift();
  if (!task) return;
  st.opRunning = true;
  Promise.resolve().then(task.fn).then(
    (r) => { st.opRunning = false; task.resolve(r); pumpOpQueue(st); },
    (e) => { st.opRunning = false; task.reject(e); pumpOpQueue(st); }
  );
}
// Очередь собственного канала модема (GPIO/CSQ/температура/LBS/USSD — через MySQL commands +
// Java-демон, НЕ через RS-485) — отдельная от serializeFor, иначе долгая догрузка истории
// счётчиков (см. startBackfill в server.js) надолго блокирует статус модема и ручное управление
// нагрузкой, хотя эти каналы физически не пересекаются.
//
// Таймаут-предохранитель (2 сент): у самой fn (в итоге — pool.execute к MySQL коллектора)
// нет своего тайм-аута на уровне получения соединения из пула — если пул когда-либо подвиснет
// (ждём свободного коннекшна, который так и не освобождается), fn не отклонится и не
// зарезолвится НИКОГДА. gpioChain тогда навсегда виснет на этом промисе, и КАЖДЫЙ следующий
// вызов serializeGpioFor для этого modemId (и фоновый тик, и кнопка «Обновить») будет вечно
// ждать своей очереди за зависшей задачей — снимается только рестартом процесса (жалоба
// пользователя 2 сент: "Модем не отвечает" не проходит само, хотя счётчики на связи). Гонка с
// таймаутом гарантирует, что gpioChain продвинется дальше в любом случае, даже если сама fn
// так и останется висеть где-то в фоне.
function serializeGpioFor(modemId, fn, timeoutMs = 30000) {
  const st = getModemState(modemId);
  const guarded = () => Promise.race([
    Promise.resolve().then(fn),
    new Promise((_, reject) => setTimeout(() => reject(new Error('serializeGpioFor: таймаут задачи, очередь модема разблокирована')), timeoutMs)),
  ]);
  const run = st.gpioChain.then(guarded, guarded);
  st.gpioChain = run.catch(() => {});
  return run;
}
function saveLoadCfg(modemId) {
  const st = getModemState(modemId);
  fs.writeFile(st.loadCfgFile, JSON.stringify(st.loadCfg, null, 2), () => {});
}
function deleteModemState(modemId) {
  modemStates.delete(modemId);
  fs.rm(path.join(DATA_DIR, 'modems', String(modemId)), { recursive: true, force: true }, () => {});
}

// ── По счётчику: кэш мгновенных величин ────────────────────────────────────────
// Получасовки (профиль) и мгновенные величины (напряжение/ток/мощность и т.п.) больше НЕ
// хранятся здесь — единая история для всего (в т.ч. для "Регистратора") пишется напрямую в
// таблицу БД `readings` (см. db.js, server.js saveInstantSnapshot/saveReadings), а не в
// отдельный JSON-файл на процесс — чтобы не было двух параллельных хранилищ одних и тех же
// данных (было до 27 авг: свой in-memory история на счётчик, терялась при рестарте процесса,
// не пересекалась с БД). Здесь остаётся только состояние выполнения на время работы процесса.
const meterStates = new Map();
function getMeterState(meterId) {
  let st = meterStates.get(meterId);
  if (!st) {
    st = {
      cachedMercury: { online: false, ts: 0 },
      pollingPromise: null,
      manualPollingPromise: null,
      profilePolling: false,
      profileLastError: null,
      profileLastPollTs: 0,
    };
    meterStates.set(meterId, st);
  }
  return st;
}
function deleteMeterState(meterId) {
  meterStates.delete(meterId);
  fs.rm(path.join(DATA_DIR, 'meters', String(meterId)), { recursive: true, force: true }, () => {});
}

module.exports = {
  getModemState, serializeFor, serializeGpioFor, saveLoadCfg, deleteModemState,
  getMeterState, deleteMeterState,
  DEFAULT_LOAD_CFG,
};
