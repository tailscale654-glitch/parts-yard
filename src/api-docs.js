'use strict';
// Каталог, поставки, заказы, инвентаризация.
const { now, audit } = require('./db');
const { resolveDealer } = require('./dealers');

const ART_RE = /^[\p{L}\p{N}][\p{L}\p{N}._\-/]{0,39}$/u;

module.exports = function docsApi(api, { db, L, INV, need, h, mutation, WmsError }) {
  const bump = () => db.exec("UPDATE meta SET v = v + 1 WHERE k = 'rev'");
  const oplog = db.prepare('INSERT INTO oplog(ts, op, kind, qty, user, ref) VALUES (?,?,?,?,?,?)');
  const posInt = (v, what) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0 || n > 1000000) throw new WmsError(400, 'BAD_QTY', `${what}: целое число больше нуля`);
    return n;
  };
  const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

  // ---------- каталог ----------
  function checkSku(r, i) {
    const where = i == null ? '' : `Строка ${i + 1}: `;
    const art = text(r.art, 40), name = text(r.name, 120), zone = text(r.zone, 3).toUpperCase();
    if (!ART_RE.test(art)) throw new WmsError(400, 'BAD_ART', `${where}артикул — буквы, цифры, точка, дефис, до 40 символов`);
    if (!name) throw new WmsError(400, 'BAD_NAME', `${where}укажите наименование`);
    if (!L.zoneById.has(zone)) throw new WmsError(400, 'BAD_ZONE', `${where}зоны «${zone}» нет на складе`);
    const per = posInt(r.per, `${where}вместимость ячейки`);
    const min = r.min_qty === '' || r.min_qty == null ? 0 : Number(r.min_qty);
    if (!Number.isInteger(min) || min < 0) throw new WmsError(400, 'BAD_MIN', `${where}минимум — целое число от 0`);
    return { art, name, zone, per, min_qty: min };
  }
  const upsertSku = db.prepare(`INSERT INTO sku(art, name, zone, per, min_qty) VALUES (@art, @name, @zone, @per, @min_qty)
    ON CONFLICT(art) DO UPDATE SET name = excluded.name, zone = excluded.zone, per = excluded.per, min_qty = excluded.min_qty`);

  api.get('/catalog', need('stock.view'), h((req) => {
    const q = text(req.query.q, 60).toLowerCase(), zone = text(req.query.zone, 3);
    let rows = db.prepare(`SELECT s.*, COALESCE(SUM(c.qty), 0) AS qty, COUNT(c.addr) AS cells
      FROM sku s LEFT JOIN cell c ON c.sku = s.art GROUP BY s.art ORDER BY s.zone, s.art`).all();
    if (q) rows = rows.filter((r) => r.art.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
    if (zone) rows = rows.filter((r) => r.zone === zone);
    return { items: rows, zones: L.zones.map((z) => ({ id: z.id, title: z.title, sub: z.sub })) };
  }));
  api.post('/catalog', need('catalog.manage'), h((req) => {
    const r = checkSku(req.body || {});
    const exists = db.prepare('SELECT * FROM sku WHERE art = ?').get(r.art);
    if (req.body.isNew && exists) throw new WmsError(409, 'SKU_EXISTS', `Артикул ${r.art} уже есть в каталоге`);
    if (exists && exists.zone !== r.zone) {
      const stocked = db.prepare('SELECT COUNT(*) FROM cell WHERE sku = ?').pluck().get(r.art);
      if (stocked) throw new WmsError(409, 'SKU_STOCKED', `Нельзя сменить зону: ${r.art} лежит в ${stocked} ячейках зоны ${exists.zone}. Сначала переместите товар.`);
    }
    db.transaction(() => {
      upsertSku.run(r);
      if (exists && exists.zone !== r.zone) db.prepare('UPDATE sku SET zone_manual = 1 WHERE art = ?').run(r.art);
      audit(db, req.user.username, exists ? 'Артикул изменён' : 'Артикул добавлен', r);
      bump();
    })();
    return { ok: true, item: r };
  }));
  api.post('/catalog/import', need('catalog.manage'), h((req) => {
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
    if (!rows.length) throw new WmsError(400, 'EMPTY', 'Нет строк для загрузки');
    if (rows.length > 20000) throw new WmsError(400, 'TOO_MANY', 'Не больше 20 000 строк за раз');
    const clean = rows.map((r, i) => checkSku(r, i));
    const before = new Set(db.prepare('SELECT art FROM sku').pluck().all());
    db.transaction(() => {
      for (const r of clean) upsertSku.run(r);
      audit(db, req.user.username, 'Каталог загружен', { rows: clean.length });
      bump();
    })();
    const added = clean.filter((r) => !before.has(r.art)).length;
    return { ok: true, added, updated: clean.length - added };
  }));
  api.delete('/catalog/:art', need('catalog.manage'), h((req) => {
    const art = req.params.art;
    if (!db.prepare('SELECT 1 FROM sku WHERE art = ?').get(art)) throw new WmsError(404, 'NO_SKU', 'Артикул не найден');
    const used = db.prepare(`SELECT (SELECT COUNT(*) FROM cell WHERE sku = ?) + (SELECT COUNT(*) FROM receipt WHERE art = ?) +
      (SELECT COUNT(*) FROM order_line WHERE art = ?)`).pluck().get(art, art, art);
    if (used) throw new WmsError(409, 'SKU_USED', `${art} лежит на складе или есть в документах — удалить нельзя. Можно поставить минимум 0 и не использовать.`);
    db.transaction(() => { db.prepare('DELETE FROM sku WHERE art = ?').run(art); audit(db, req.user.username, 'Артикул удалён', { art }); bump(); })();
    return { ok: true };
  }));

  // ---------- поставки ----------
  function checkLines(lines) {
    if (!Array.isArray(lines) || !lines.length) throw new WmsError(400, 'NO_LINES', 'Добавьте хотя бы одну строку');
    if (lines.length > 5000) throw new WmsError(400, 'TOO_MANY', 'Не больше 5000 строк');
    const known = new Set(db.prepare('SELECT art FROM sku').pluck().all());
    return lines.map((l, i) => {
      const art = text(l.art, 40);
      if (!known.has(art)) throw new WmsError(404, 'NO_SKU', `Строка ${i + 1}: артикула «${art}» нет в каталоге`);
      return { art, qty: posInt(l.qty, `Строка ${i + 1}: количество`) };
    });
  }

  api.get('/receipts', need('stock.view'), h((req) => {
    const state = req.query.state || 'open';
    const rows = db.prepare(`SELECT r.*, s.name, s.zone FROM receipt r LEFT JOIN sku s ON s.art = r.art
      ORDER BY r.created DESC, r.id`).all();
    const docs = new Map();
    for (const r of rows) {
      const d = docs.get(r.doc) || { doc: r.doc, gate: r.gate, created: r.created, lines: [], qty: 0, placed: 0, open: 0 };
      d.lines.push(r); d.qty += r.qty; d.placed += r.placed; if (!r.done) d.open++;
      docs.set(r.doc, d);
    }
    let list = [...docs.values()];
    if (state === 'open') list = list.filter((d) => d.open);
    if (state === 'done') list = list.filter((d) => !d.open);
    return { docs: list.slice(0, 300) };
  }));
  api.post('/receipts', need('docs.receipts'), h((req) => {
    const doc = text(req.body.doc, 40), gate = text(req.body.gate, 10);
    if (!doc) throw new WmsError(400, 'NO_DOC', 'Укажите номер поставки');
    if (db.prepare('SELECT 1 FROM receipt WHERE doc = ?').get(doc)) throw new WmsError(409, 'DOC_EXISTS', `Поставка ${doc} уже есть`);
    const lines = checkLines(req.body.lines);
    db.transaction(() => {
      const ins = db.prepare('INSERT INTO receipt(doc, gate, art, qty, created) VALUES (?,?,?,?,?)');
      for (const l of lines) ins.run(doc, gate, l.art, l.qty, now());
      oplog.run(now(), 'Поставка создана', 'doc', lines.length, req.user.username, doc);
      bump();
    })();
    return { ok: true, doc, lines: lines.length };
  }));
  api.delete('/receipts/doc/:doc', need('docs.receipts'), h((req) => {
    const doc = req.params.doc;
    const placed = db.prepare('SELECT COALESCE(SUM(placed), 0) FROM receipt WHERE doc = ?').pluck().get(doc);
    if (placed) throw new WmsError(409, 'DOC_STARTED', 'По поставке уже есть размещения — удалить нельзя');
    const n = db.transaction(() => {
      const r = db.prepare('DELETE FROM receipt WHERE doc = ?').run(doc).changes;
      oplog.run(now(), 'Поставка удалена', 'system', r, req.user.username, doc);
      bump();
      return r;
    })();
    if (!n) throw new WmsError(404, 'NO_DOC', 'Поставка не найдена');
    return { ok: true };
  }));

  // ---------- заказы ----------
  api.get('/orders', need('stock.view'), h((req) => {
    const state = req.query.state || 'open';
    let where = '';
    if (state === 'open') where = 'WHERE o.done = 0';
    if (state === 'done') where = 'WHERE o.done = 1';
    const orders = db.prepare(`SELECT o.*, SUM(l.qty) AS total, SUM(l.picked) AS picked, COUNT(l.id) AS line_count,
        d.region AS dealer_region, d.code AS dealer_code, d.source AS dealer_source, d.active AS dealer_active
      FROM orders o LEFT JOIN order_line l ON l.order_id = o.id LEFT JOIN dealer d ON d.id = o.dealer_id ${where} GROUP BY o.id
      ORDER BY o.done, COALESCE(NULLIF(o.due,''),'99:99'), o.id DESC LIMIT 300`).all();
    const lines = db.prepare(`SELECT l.*, s.name, COALESCE((SELECT SUM(qty) FROM cell c WHERE c.sku = l.art AND c.blocked = 0), 0) AS stock
      FROM order_line l LEFT JOIN sku s ON s.art = l.art WHERE l.order_id = ? ORDER BY l.id`);
    for (const o of orders) o.lines = lines.all(o.id);
    return { orders };
  }));
  api.post('/orders', need('docs.orders'), h((req) => {
    const number = text(req.body.number, 40), dealerName = text(req.body.dealer, 120), due = text(req.body.due, 16);
    const dealerId = req.body.dealer_id == null || req.body.dealer_id === '' ? null : Number(req.body.dealer_id);
    if (!number) throw new WmsError(400, 'NO_NUMBER', 'Укажите номер заказа');
    if (!dealerName && !dealerId) throw new WmsError(400, 'NO_DEALER', 'Укажите дилера');
    if (due && !/^\d{1,2}:\d{2}$/.test(due)) throw new WmsError(400, 'BAD_DUE', 'Срок — время в формате 15:00');
    if (db.prepare('SELECT 1 FROM orders WHERE number = ?').get(number)) throw new WmsError(409, 'ORDER_EXISTS', `Заказ ${number} уже есть`);
    const lines = checkLines(req.body.lines);
    // дилер — только из справочника Carsale
    const rd = resolveDealer(db, { id: dealerId, name: dealerName });
    if (rd.error) throw new WmsError(400, 'BAD_DEALER', rd.error);
    const id = db.transaction(() => {
      const oid = db.prepare('INSERT INTO orders(number, dealer, dealer_id, due, created) VALUES (?,?,?,?,?)')
        .run(number, rd.dealer ? rd.dealer.name : rd.name, rd.dealer ? rd.dealer.id : null, due, now()).lastInsertRowid;
      const ins = db.prepare('INSERT INTO order_line(order_id, art, qty) VALUES (?,?,?)');
      for (const l of lines) ins.run(oid, l.art, l.qty);
      oplog.run(now(), 'Заказ создан', 'doc', lines.length, req.user.username, number);
      bump();
      return oid;
    })();
    return { ok: true, id, number, dealer: rd.dealer ? rd.dealer.name : rd.name };
  }));
  api.delete('/orders/:id(\\d+)', need('docs.orders'), h((req) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(+req.params.id);
    if (!o) throw new WmsError(404, 'NO_ORDER', 'Заказ не найден');
    const picked = db.prepare('SELECT COALESCE(SUM(picked), 0) FROM order_line WHERE order_id = ?').pluck().get(o.id);
    if (picked) throw new WmsError(409, 'ORDER_STARTED', 'По заказу уже есть отбор — удалить нельзя, только закрыть');
    db.transaction(() => {
      db.prepare('DELETE FROM orders WHERE id = ?').run(o.id);
      oplog.run(now(), 'Заказ удалён', 'system', null, req.user.username, o.number);
      bump();
    })();
    return { ok: true };
  }));

  // ---------- инвентаризация ----------
  const u = (req) => req.user.username;
  api.get('/inventory', need('stock.view', 'inventory.count'), h(() => ({ tasks: INV.list() })));
  api.post('/inventory', need('inventory.manage'), h((req) => ({ ok: true, ...INV.create(req.body || {}, u(req)) })));
  api.get('/inventory/:id(\\d+)', need('stock.view', 'inventory.count'), h((req) => INV.get(+req.params.id)));
  api.post('/inventory/:id(\\d+)/lines/:line(\\d+)', need('inventory.count'),
    mutation((req) => INV.count(+req.params.id, +req.params.line, { qty: req.body.qty, art: req.body.art }, u(req))));
  api.post('/inventory/:id(\\d+)/close', need('inventory.manage'), h((req) => ({ ok: true, ...INV.close(+req.params.id, u(req)) })));
  api.post('/inventory/:id(\\d+)/cancel', need('inventory.manage'), h((req) => ({ ok: true, ...INV.cancel(+req.params.id, u(req)) })));
};
