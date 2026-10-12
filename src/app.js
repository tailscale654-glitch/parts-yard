'use strict';
const path = require('path');
const express = require('express');
const { createWarehouse, WmsError } = require('./warehouse');
const { createAuth } = require('./auth');
const { seedDemo } = require('./demo');
const { now } = require('./db');

const ADDR = '[A-Za-z0-9]+-\\d{2}-\\d{2}-\\d+-\\d+';

function createApp({ db, L, cfg }) {
  const W = createWarehouse(db, L, { demo: cfg.demo });
  const auth = createAuth(db, cfg);
  const app = express();
  if (cfg.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(auth.session);

  // ---------- страницы ----------
  const pub = path.join(cfg.ROOT, 'public');
  app.get('/login', (req, res) => res.sendFile(path.join(pub, 'login.html')));
  app.get(['/', '/index.html'], (req, res) => {
    if (!req.user) return res.redirect('/login');
    res.sendFile(path.join(pub, 'index.html'));
  });
  app.get('/healthz', (req, res) => res.json({ ok: true, rev: W.rev() }));

  // ---------- вход ----------
  app.post('/api/login', auth.login);
  app.post('/api/logout', auth.logout);

  const api = express.Router();
  api.use(auth.requireUser);
  api.get('/me', (req, res) => res.json({ user: req.user }));
  api.get('/layout', (req, res) => res.json({ zones: L.zones }));
  api.get('/rev', (req, res) => res.json({ rev: W.rev() }));
  api.get('/state', (req, res) => res.json({ ...W.state(), user: req.user }));
  api.get('/cells/:addr', (req, res, next) => {
    try {
      const addr = req.params.addr.toUpperCase();
      if (!L.meta.has(addr)) throw new WmsError(404, 'NO_ADDRESS', `Адреса ${addr} нет на складе`);
      const c = db.prepare('SELECT c.addr, c.sku, c.qty, c.blocked, s.name, s.per FROM cell c LEFT JOIN sku s ON s.art = c.sku WHERE c.addr = ?').get(addr);
      res.json({ ...c, ...L.meta.get(addr) });
    } catch (e) { next(e); }
  });
  api.get('/skus/:art', (req, res, next) => {
    try {
      const s = db.prepare('SELECT * FROM sku WHERE art = ?').get(req.params.art);
      if (!s) throw new WmsError(404, 'NO_SKU', `Артикула ${req.params.art} нет в каталоге`);
      s.cells = db.prepare('SELECT addr, qty, blocked FROM cell WHERE sku = ? ORDER BY addr').all(s.art);
      res.json(s);
    } catch (e) { next(e); }
  });
  api.get('/plan/putaway/:id(\\d+)', (req, res, next) => { try { res.json(W.planPutaway(+req.params.id)); } catch (e) { next(e); } });
  api.get('/plan/pick/:id(\\d+)', (req, res, next) => { try { res.json(W.planPick(+req.params.id)); } catch (e) { next(e); } });

  // ---------- изменения ----------
  // Каждая операция может нести opId (заголовок X-Op-Id или поле opId). Повтор с тем же opId
  // не выполняется второй раз, а возвращает сохранённый ответ: так офлайн-очередь ТСД
  // может безопасно переотправлять операции после обрыва связи.
  const findOp = db.prepare('SELECT status, result FROM client_ops WHERE op_id = ?');
  const saveOp = db.prepare('INSERT INTO client_ops(op_id, user_id, ts, status, result) VALUES (?,?,?,?,?)');
  function mutation(fn) {
    return (req, res) => {
      const opId = req.get('X-Op-Id') || (req.body && req.body.opId) || null;
      if (opId && String(opId).length > 80) return res.status(400).json({ error: 'opId слишком длинный', code: 'BAD_OP_ID' });
      const run = db.transaction(() => {
        if (opId) {
          const prev = findOp.get(String(opId));
          if (prev) return { status: prev.status, body: { ...JSON.parse(prev.result), replayed: true } };
        }
        let status = 200, body;
        try {
          body = { ok: true, ...fn(req) };
        } catch (e) {
          if (!(e instanceof WmsError)) throw e;
          status = e.status;
          body = { ok: false, error: e.message, code: e.code, ...(e.extra || {}) };
        }
        body.rev = W.rev();
        if (opId) saveOp.run(String(opId), req.user.id, now(), status, JSON.stringify(body));
        return { status, body };
      });
      // ошибка бизнес-правил откатывает изменения fn (вложенная транзакция), но ответ сохраняется по opId
      let out;
      try { out = run(); } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'Внутренняя ошибка сервера', code: 'INTERNAL' });
      }
      if (req.query.state === '1') out.body.state = W.state();
      res.status(out.status).json(out.body);
    };
  }
  const u = (req) => req.user.username;
  const addr = (req) => req.params.addr.toUpperCase();

  api.post(`/cells/:addr(${ADDR})/put`, mutation((req) => W.put({ addr: addr(req), art: req.body.art, qty: req.body.qty, receiptId: req.body.receiptId ?? null }, u(req))));
  api.post(`/cells/:addr(${ADDR})/pick`, mutation((req) => W.pick({ addr: addr(req), art: req.body.art, qty: req.body.qty, orderId: req.body.orderId ?? null }, u(req))));
  api.post(`/cells/:addr(${ADDR})/count`, mutation((req) => W.count({ addr: addr(req), qty: req.body.qty }, u(req))));
  api.post(`/cells/:addr(${ADDR})/block`, mutation((req) => W.setBlocked({ addr: addr(req), blocked: !!req.body.blocked }, u(req))));
  api.post('/move', mutation((req) => W.move({ from: String(req.body.from || '').toUpperCase(), to: String(req.body.to || '').toUpperCase(), qty: req.body.qty }, u(req))));
  api.post('/receipts/:id(\\d+)/putaway', mutation((req) => W.confirmPutaway(+req.params.id, u(req))));
  api.post('/orders/:id(\\d+)/pick', mutation((req) => W.confirmPick(+req.params.id, u(req))));
  api.post('/orders/:id(\\d+)/close', mutation((req) => W.closeOrder(+req.params.id, u(req))));
  api.post('/demo/reset', auth.requireAdmin, (req, res) => {
    if (!cfg.demo) return res.status(403).json({ error: 'Сброс доступен только в демо-режиме (WMS_DEMO=1)', code: 'NOT_DEMO' });
    seedDemo(db, L);
    res.json({ ok: true, rev: W.rev(), state: W.state() });
  });

  app.use('/api', api);
  app.use('/static', express.static(pub, { index: false, maxAge: '1h' }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено', code: 'NOT_FOUND' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof WmsError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.extra || {}) });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный JSON', code: 'BAD_JSON' });
    console.error(err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера', code: 'INTERNAL' });
  });
  return app;
}

module.exports = { createApp };
