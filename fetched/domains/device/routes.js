// GPIO/USSD/диагностические маршруты модема — перенесены из server.js (P1-01, strangler
// extraction, ADR-03). Физический перенос без изменения логики: тела обработчиков не менялись,
// только app.METHOD(...) -> router.METHOD(...).
//
// Низкоуровневые функции канала модема (setGpo/batch/modemOnline/writeSettings/queueCommand/
// triggerSend/waitAnswer/decodeUssd/parseLbs/parsePins/loadStatus, константы CMD/ID/GPIO_NUM)
// остаются в server.js — их использует ТАКЖЕ фоновый опрос модема, не только эти маршруты,
// поэтому они не переезжают, а передаются сюда как зависимости фабрики.
const express = require('express');

module.exports = function createDeviceRoutes(deps) {
  const {
    state, setGpo, batch, modemOnline, writeSettings, queueCommand, triggerSend, waitAnswer,
    decodeUssd, parseLbs, parsePins, loadStatus, CMD, ID, GPIO_NUM,
  } = deps;
  const router = express.Router();

  router.post('/api/gpo/:action', (req, res) => {
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

  router.get('/api/info', (req, res) => {
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
  router.post('/api/pin/:name/direction', (req, res) => {
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

  router.post('/api/pin/:name/level', (req, res) => {
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

  router.post('/api/gpo/vcc', (req, res) => {
    if (!req.modem) return res.status(400).json({ error: 'к проекту не привязан модем' });
    return state.serializeGpioFor(req.modem.id, async () => {
      const mode = req.body.mode === 'supply' ? 0 : 1;
      await writeSettings(req.modem.imei, [`AT$GPIO_VCC4=${mode}`]);
      res.json({ ok: true, note: 'настройка отправлена; модем применит её и переподключится' });
    }).catch(e => res.status(500).json({ error: e.message }));
  });

  router.post('/api/ussd', (req, res) => {
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

  return router;
};
