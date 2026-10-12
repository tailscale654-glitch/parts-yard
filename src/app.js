'use strict';
const path = require('path');
const express = require('express');
const { createWarehouse, WmsError } = require('./warehouse');
const { createAuth } = require('./auth');
const { createInventory } = require('./inventory');
const { createMetrics } = require('./metrics');
const { createReports } = require('./reports');
const { seedDemo } = require('./demo');
const { now, getSetting } = require('./db');
const { PERMS } = require('./perms');
const { createCarsaleSync } = require('./carsale');

const ADDR = '[A-Za-z0-9]+-\\d{2}-\\d{2}-\\d+-\\d+';

function createApp({ db, L, cfg }) {
  const W = createWarehouse(db, L, { demo: cfg.demo });
  const auth = createAuth(db, cfg);
  const INV = createInventory(db, L);
  const MET = createMetrics(db, L);
  const REP = createReports(db, L);
  const CS = createCarsaleSync(db, L, cfg, { clientFactory: cfg.carsaleClientFactory });
  const { need } = auth;
  const app = express();
  if (cfg.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use(auth.session);

  const pub = path.join(cfg.ROOT, 'public');
  app.get('/login', (req, res) => res.sendFile(path.join(pub, 'login.html')));
  app.get(['/', '/index.html'], (req, res) => {
    if (!req.user) return res.redirect('/login');
    res.sendFile(path.join(pub, 'index.html'));
  });
  app.get('/healthz', (req, res) => res.json({ ok: true, rev: W.rev() }));
  app.get('/api/public', (req, res) => res.json({
    name: getSetting(db, 'warehouse_name', 'Адресный склад запчастей'),
    subtitle: getSetting(db, 'warehouse_subtitle', ''),
  }));
  app.post('/api/login', auth.login);
  app.post('/api/logout', auth.logout);

  const api = express.Router();
  api.use(auth.requireUser);

  // обработчик без побочных эффектов: исключение WmsError превращается в ответ с кодом
  const h = (fn) => (req, res, next) => { try { res.json(fn(req, res)); } catch (e) { next(e); } };
  const layoutRev = () => db.prepare("SELECT v FROM meta WHERE k = 'layout_rev'").pluck().get();

  // Изменение с идемпотентностью: повтор с тем же opId (X-Op-Id или поле opId) не выполняется
  // второй раз, а возвращает сохранённый ответ. Так офлайн-очередь ТСД может переотправлять операции.
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
      let out;
      try { out = run(); } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'Внутренняя ошибка сервера', code: 'INTERNAL' });
      }
      if (req.query.state === '1') out.body.state = W.state();
      res.status(out.status).json(out.body);
    };
  }
  const ctx = { db, L, cfg, W, INV, MET, REP, CS, auth, need, h, mutation, WmsError };

  // ---------- общее ----------
  api.get('/me', h((req) => ({
    user: { username: req.user.username, fullName: req.user.fullName, role: req.user.role, roleName: req.user.roleName },
    perms: req.user.permList,
    settings: {
      name: getSetting(db, 'warehouse_name', 'Адресный склад запчастей'),
      subtitle: getSetting(db, 'warehouse_subtitle', ''),
      pollSeconds: Number(getSetting(db, 'poll_seconds', '8')) || 8,
    },
    demo: !!cfg.demo,
    permCatalog: PERMS,
  })));
  api.get('/layout', h(() => ({ zones: L.zones, layoutRev: layoutRev() })));
  const badgeQ = db.prepare(`SELECT
    (SELECT COUNT(DISTINCT doc) FROM receipt WHERE done = 0) AS receipts,
    (SELECT COUNT(*) FROM orders WHERE done = 0) AS orders,
    (SELECT COUNT(*) FROM inv_task WHERE status = 'open') AS inventory`);
  api.get('/rev', h(() => ({ rev: W.rev(), layoutRev: layoutRev(), badges: badgeQ.get() })));

  // ---------- склад ----------
  const u = (req) => req.user.username;
  const addr = (req) => req.params.addr.toUpperCase();
  api.get('/state', need('stock.view'), h((req) => ({ ...W.state(), user: { username: req.user.username, role: req.user.role } })));
  api.get('/cells/:addr', need('stock.view'), h((req) => {
    const a = addr(req);
    if (!L.meta.has(a)) throw new WmsError(404, 'NO_ADDRESS', `Адреса ${a} нет на складе`);
    const c = db.prepare('SELECT c.addr, c.sku, c.qty, c.blocked, s.name, s.per FROM cell c LEFT JOIN sku s ON s.art = c.sku WHERE c.addr = ?').get(a);
    return { ...c, ...L.meta.get(a) };
  }));
  api.get('/skus/:art', need('stock.view'), h((req) => {
    const s = db.prepare('SELECT * FROM sku WHERE art = ?').get(req.params.art);
    if (!s) throw new WmsError(404, 'NO_SKU', `Артикула ${req.params.art} нет в каталоге`);
    s.cells = db.prepare('SELECT addr, qty, blocked FROM cell WHERE sku = ? ORDER BY addr').all(s.art);
    return s;
  }));
  api.get('/plan/putaway/:id(\\d+)', need('stock.view'), h((req) => W.planPutaway(+req.params.id)));
  api.get('/plan/pick/:id(\\d+)', need('stock.view'), h((req) => W.planPick(+req.params.id)));

  api.post(`/cells/:addr(${ADDR})/put`, need('stock.put'), mutation((req) => W.put({ addr: addr(req), art: req.body.art, qty: req.body.qty, receiptId: req.body.receiptId ?? null }, u(req))));
  api.post(`/cells/:addr(${ADDR})/pick`, need('stock.pick'), mutation((req) => W.pick({ addr: addr(req), art: req.body.art, qty: req.body.qty, orderId: req.body.orderId ?? null }, u(req))));
  api.post(`/cells/:addr(${ADDR})/count`, need('stock.count'), mutation((req) => W.count({ addr: addr(req), qty: req.body.qty }, u(req))));
  api.post(`/cells/:addr(${ADDR})/block`, need('stock.block'), mutation((req) => W.setBlocked({ addr: addr(req), blocked: !!req.body.blocked }, u(req))));
  api.post('/move', need('stock.move'), mutation((req) => W.move({ from: String(req.body.from || '').toUpperCase(), to: String(req.body.to || '').toUpperCase(), qty: req.body.qty }, u(req))));
  api.post('/receipts/:id(\\d+)/putaway', need('stock.put'), mutation((req) => W.confirmPutaway(+req.params.id, u(req))));
  api.post('/orders/:id(\\d+)/pick', need('stock.pick'), mutation((req) => W.confirmPick(+req.params.id, u(req))));
  api.post('/orders/:id(\\d+)/close', need('docs.orders'), mutation((req) => W.closeOrder(+req.params.id, u(req))));

  require('./api-docs')(api, ctx);
  require('./api-insights')(api, ctx);
  require('./api-admin')(api, ctx);
  require('./api-carsale')(api, ctx);

  api.post('/demo/reset', need('admin.settings'), (req, res) => {
    if (!cfg.demo) return res.status(403).json({ error: 'Сброс доступен только в демо-режиме (WMS_DEMO=1)', code: 'NOT_DEMO' });
    seedDemo(db, L);
    res.json({ ok: true, rev: W.rev(), state: W.state() });
  });

  app.use('/api', api);
  app.use('/static', express.static(pub, { index: false, maxAge: cfg.devStatic ? 0 : '10m' }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено', code: 'NOT_FOUND' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof WmsError) return res.status(err.status).json({ ok: false, error: err.message, code: err.code, ...(err.extra || {}) });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный JSON', code: 'BAD_JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Слишком большой запрос', code: 'TOO_LARGE' });
    console.error(err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера', code: 'INTERNAL' });
  });
  app.locals.carsale = CS;
  return app;
}

module.exports = { createApp };
