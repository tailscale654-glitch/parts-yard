'use strict';
// Интеграция с Carsale: состояние, настройки, запуск синхронизации, сверка, поставка на неразмещённое.
const { now, audit } = require('./db');
const { reconcile } = require('./carsale');

module.exports = function carsaleApi(api, { db, CS, need, h, WmsError }) {
  api.get('/integrations/carsale', need('admin.settings', 'catalog.manage'), h(() => CS.status()));

  api.put('/integrations/carsale/settings', need('admin.settings'), h((req) => {
    let changed;
    try { changed = CS.writeSettings(req.body || {}); } catch (e) { throw new WmsError(400, 'BAD_SETTINGS', e.message); }
    audit(db, req.user.username, 'Настройки Carsale изменены', changed);
    CS.schedule();
    return { ok: true, status: CS.status() };
  }));

  api.post('/integrations/carsale/sync', need('admin.settings', 'catalog.manage'), async (req, res, next) => {
    try {
      if (!CS.configured()) throw new WmsError(409, 'NOT_CONFIGURED', 'Интеграция не настроена: на сервере не заданы CARSALE_LOGIN и CARSALE_PASSWORD');
      const r = await CS.run({ trigger: 'manual', user: req.user.username });
      CS.schedule();
      audit(db, req.user.username, 'Синхронизация Carsale запущена вручную', r.ok ? r.stats : { error: r.error });
      if (!r.ok) return res.status(502).json({ ok: false, error: r.error, code: 'CARSALE_FAILED' });
      res.json({ ok: true, stats: r.stats, status: CS.status() });
    } catch (e) { next(e); }
  });

  api.get('/integrations/carsale/reconcile', need('stock.view'), h(() => {
    const rows = reconcile(db);
    return {
      rows,
      summary: {
        skus: rows.length,
        unplacedSkus: rows.filter((r) => r.toPlace > 0).length,
        unplacedUnits: rows.reduce((n, r) => n + r.toPlace, 0),
        surplusSkus: rows.filter((r) => r.diff < 0).length,
      },
    };
  }));

  // поставка на всё, что по Carsale есть на складе, но ещё не разложено по ячейкам и не стоит в приёмке
  api.post('/integrations/carsale/receipt', need('docs.receipts'), h((req) => {
    const rows = reconcile(db).filter((r) => r.toPlace > 0);
    if (!rows.length) throw new WmsError(409, 'NOTHING_TO_PLACE', 'Всё, что числится в Carsale, уже размещено или ждёт размещения');
    const t = now();
    const doc = `CS-${t.slice(2, 10).replace(/-/g, '')}-${t.slice(11, 16).replace(':', '')}`;
    if (db.prepare('SELECT 1 FROM receipt WHERE doc = ?').get(doc)) throw new WmsError(409, 'DOC_EXISTS', `Поставка ${doc} уже создана — подождите минуту`);
    db.transaction(() => {
      const ins = db.prepare('INSERT INTO receipt(doc, gate, art, qty, created) VALUES (?,?,?,?,?)');
      for (const r of rows) ins.run(doc, '', r.art, r.toPlace, t);
      db.prepare("INSERT INTO oplog(ts, op, kind, qty, user, ref) VALUES (?, 'Поставка создана', 'doc', ?, ?, ?)").run(t, rows.length, req.user.username, doc);
      db.exec("UPDATE meta SET v = v + 1 WHERE k = 'rev'");
    })();
    return { ok: true, doc, lines: rows.length, units: rows.reduce((n, r) => n + r.toPlace, 0) };
  }));
};
