'use strict';
// Справочник дилеров: список, карточка, свои дилеры (добавить, изменить, удалить).
// Дилеров из Carsale меняет только синхронизация — у них редактируется лишь заметка.
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

  const text = (v, max) => D.clean(v, max);
  function checkLocal(b, selfId = null) {
    const name = text(b.name, 120);
    if (!name) throw new WmsError(400, 'NO_NAME', 'Укажите название дилера');
    const same = D.findByName(db, name);
    if (same && same.id !== selfId) throw new WmsError(409, 'DEALER_EXISTS', `Дилер «${same.name}» уже есть в справочнике`);
    return { name, code: text(b.code, 40), region: text(b.region, 80), city: text(b.city, 80), address: text(b.address, 200),
      phone: text(b.phone, 60), inn: text(b.inn, 20), note: text(b.note, 300) };
  }

  api.post('/dealers', need('docs.orders'), h((req) => {
    const d = D.insertLocal(db, checkLocal(req.body || {}));
    audit(db, req.user.username, 'Дилер добавлен', d.name);
    bump();
    return { ok: true, dealer: d };
  }));

  api.put('/dealers/:id(\\d+)', need('docs.orders'), h((req) => {
    const d = get(req.params.id), b = req.body || {};
    if (d.source === 'carsale') {
      db.prepare('UPDATE dealer SET note = ?, updated = ? WHERE id = ?').run(text(b.note, 300) || null, now(), d.id);
    } else {
      const v = checkLocal(b, d.id);
      db.transaction(() => {
        db.prepare(`UPDATE dealer SET name = ?, name_key = ?, code = ?, region = ?, city = ?, address = ?, phone = ?, inn = ?, note = ?,
          active = ?, updated = ? WHERE id = ?`)
          .run(v.name, D.nameKey(v.name), v.code || null, v.region || null, v.city || null, v.address || null, v.phone || null, v.inn || null,
            v.note || null, b.active === false ? 0 : 1, now(), d.id);
        if (v.name !== d.name) db.prepare('UPDATE orders SET dealer = ? WHERE dealer_id = ?').run(v.name, d.id);
      })();
    }
    audit(db, req.user.username, 'Дилер изменён', d.name);
    bump();
    return { ok: true, dealer: get(d.id) };
  }));

  api.delete('/dealers/:id(\\d+)', need('docs.orders'), h((req) => {
    const d = get(req.params.id);
    if (d.source === 'carsale') throw new WmsError(409, 'FROM_CARSALE', 'Дилер из Carsale удаляется только в Carsale — здесь он отключится сам при следующей проверке');
    const n = db.prepare('SELECT COUNT(*) FROM orders WHERE dealer_id = ?').pluck().get(d.id);
    if (n) throw new WmsError(409, 'HAS_ORDERS', `У дилера ${n} заказов — удалить нельзя. Снимите отметку «Активен», чтобы он не предлагался в новых заказах`);
    db.prepare('DELETE FROM dealer WHERE id = ?').run(d.id);
    audit(db, req.user.username, 'Дилер удалён', d.name);
    bump();
    return { ok: true };
  }));
};
