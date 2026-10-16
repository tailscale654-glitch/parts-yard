'use strict';
// Справочник дилеров — копия Carsale «Запчасти → Справочники → Дилеры». Добавляет, меняет и удаляет
// дилеров только синхронизация с Carsale; в WarehouseOS у дилера можно поправить лишь свою заметку.
const { audit, now } = require('./db');
const D = require('./dealers');

module.exports = function dealersApi(api, { db, CS, need, h, WmsError }) {
  const bump = () => db.exec("UPDATE meta SET v = v + 1 WHERE k = 'rev'");
  const get = (id) => {
    const d = db.prepare('SELECT * FROM dealer WHERE id = ?').get(Number(id));
    if (!d) throw new WmsError(404, 'NO_DEALER', 'Дилер не найден');
    return d;
  };

  api.get('/dealers', need('stock.view'), h(() => {
    const dealers = D.list(db);
    const last = db.prepare("SELECT started, finished, status, error FROM sync_run WHERE source = 'carsale' AND (status IN ('ok', 'partial') OR error IS NOT NULL) ORDER BY id DESC LIMIT 1").get() || null;
    const S = CS.readSettings();
    return {
      dealers,
      regions: [...new Set(dealers.map((d) => d.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')),
      carsale: { configured: CS.configured(), enabled: S.dealers, auto: S.enabled, intervalMin: S.intervalMin, last },
    };
  }));

  api.get('/dealers/:id(\\d+)', need('stock.view'), h((req) => {
    const d = get(req.params.id);
    d.orders = db.prepare(`SELECT o.id, o.number, o.due, o.done, o.created, COUNT(l.id) AS lines, COALESCE(SUM(l.qty), 0) AS ordered,
        COALESCE(SUM(l.picked), 0) AS picked FROM orders o LEFT JOIN order_line l ON l.order_id = o.id
      WHERE o.dealer_id = ? GROUP BY o.id ORDER BY o.id DESC LIMIT 30`).all(d.id);
    d.totals = db.prepare(`SELECT COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(l.qty), 0) AS ordered, COALESCE(SUM(l.picked), 0) AS picked
      FROM orders o LEFT JOIN order_line l ON l.order_id = o.id WHERE o.dealer_id = ?`).get(d.id);
    return d;
  }));

  api.put('/dealers/:id(\\d+)', need('docs.orders'), h((req) => {
    const d = get(req.params.id);
    const note = D.clean((req.body || {}).note, 300) || null;
    db.prepare('UPDATE dealer SET note = ?, updated = ? WHERE id = ?').run(note, now(), d.id);
    audit(db, req.user.username, 'Заметка о дилере изменена', d.name);
    bump();
    return { ok: true, dealer: get(d.id) };
  }));
};
