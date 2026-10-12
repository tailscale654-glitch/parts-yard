'use strict';
// Дашборды (конструктор), метрики для виджетов, отчёты.
const { now, audit } = require('./db');
const { DEFAULT_DASHBOARD } = require('./metrics');

module.exports = function insightsApi(api, { db, L, MET, REP, need, h, WmsError }) {
  if (!db.prepare('SELECT COUNT(*) FROM dashboards').pluck().get()) {
    db.prepare('INSERT INTO dashboards(name, owner, shared, widgets, position, created, updated) VALUES (?,?,1,?,0,?,?)')
      .run('Обзор склада', null, JSON.stringify(DEFAULT_DASHBOARD), now(), now());
  }

  const catalog = () => new Map(MET.catalog().map((m) => [m.id, m]));
  function cleanWidgets(list) {
    if (!Array.isArray(list)) throw new WmsError(400, 'BAD_WIDGETS', 'Список виджетов не распознан');
    if (list.length > 40) throw new WmsError(400, 'TOO_MANY', 'Не больше 40 виджетов на дашборде');
    const cat = catalog();
    return list.map((w, i) => {
      const m = cat.get(w.metric);
      if (!m) throw new WmsError(400, 'BAD_METRIC', `Виджет ${i + 1}: неизвестная метрика`);
      const viz = m.viz.includes(w.viz) ? w.viz : m.viz[0];
      const width = Math.min(Math.max(parseInt(w.w, 10) || 1, 1), 4);
      const p = w.params || {};
      const params = {};
      if (m.params.includes('days') && p.days) params.days = Number(p.days);
      if (m.params.includes('limit') && p.limit) params.limit = Math.min(Math.max(parseInt(p.limit, 10) || 8, 1), 50);
      if (m.params.includes('zone') && p.zone && L.zoneById.has(p.zone)) params.zone = p.zone;
      const out = { metric: w.metric, viz, w: width, params };
      if (w.title) out.title = String(w.title).slice(0, 60);
      return out;
    });
  }
  const canEdit = (req, d) => (d.shared ? req.user.can('dashboard.edit') : d.owner === req.user.username);
  const getDash = (id) => {
    const d = db.prepare('SELECT * FROM dashboards WHERE id = ?').get(id);
    if (!d) throw new WmsError(404, 'NO_DASHBOARD', 'Дашборд не найден');
    return d;
  };

  api.get('/dashboards', need('dashboard.view'), h((req) => {
    const rows = db.prepare('SELECT * FROM dashboards WHERE shared = 1 OR owner = ? ORDER BY shared DESC, position, id').all(req.user.username);
    return { dashboards: rows.map((d) => ({ ...d, widgets: JSON.parse(d.widgets), canEdit: canEdit(req, d) })),
      canShare: req.user.can('dashboard.edit') };
  }));
  api.post('/dashboards', need('dashboard.view'), h((req) => {
    const shared = req.body.shared ? 1 : 0;
    if (shared && !req.user.can('dashboard.edit')) throw new WmsError(403, 'FORBIDDEN', 'Общие дашборды может создавать только тот, у кого есть право на конструктор');
    const name = String(req.body.name || '').trim().slice(0, 60) || 'Новый дашборд';
    const widgets = cleanWidgets(req.body.widgets || []);
    const id = db.prepare('INSERT INTO dashboards(name, owner, shared, widgets, position, created, updated) VALUES (?,?,?,?,?,?,?)')
      .run(name, req.user.username, shared, JSON.stringify(widgets), Date.now() % 100000, now(), now()).lastInsertRowid;
    audit(db, req.user.username, 'Дашборд создан', { id, name, shared });
    return { ok: true, id };
  }));
  api.put('/dashboards/:id(\\d+)', need('dashboard.view'), h((req) => {
    const d = getDash(+req.params.id);
    if (!canEdit(req, d)) throw new WmsError(403, 'FORBIDDEN', 'Этот дашборд может менять только автор или начальник склада');
    const shared = req.body.shared === undefined ? d.shared : (req.body.shared ? 1 : 0);
    if (shared !== d.shared && !req.user.can('dashboard.edit')) throw new WmsError(403, 'FORBIDDEN', 'Делать дашборд общим может только тот, у кого есть право на конструктор');
    const name = req.body.name === undefined ? d.name : (String(req.body.name).trim().slice(0, 60) || d.name);
    const widgets = req.body.widgets === undefined ? JSON.parse(d.widgets) : cleanWidgets(req.body.widgets);
    db.prepare('UPDATE dashboards SET name = ?, shared = ?, widgets = ?, owner = COALESCE(owner, ?), updated = ? WHERE id = ?')
      .run(name, shared, JSON.stringify(widgets), req.user.username, now(), d.id);
    return { ok: true };
  }));
  api.delete('/dashboards/:id(\\d+)', need('dashboard.view'), h((req) => {
    const d = getDash(+req.params.id);
    if (!canEdit(req, d)) throw new WmsError(403, 'FORBIDDEN', 'Удалить дашборд может только автор или начальник склада');
    db.prepare('DELETE FROM dashboards WHERE id = ?').run(d.id);
    audit(db, req.user.username, 'Дашборд удалён', { id: d.id, name: d.name });
    return { ok: true };
  }));

  api.get('/metrics', need('dashboard.view'), h(() => ({
    metrics: MET.catalog(), periods: MET.PERIODS, zones: L.zones.map((z) => ({ id: z.id, title: z.title, sub: z.sub })),
  })));
  api.post('/metrics/batch', need('dashboard.view'), h((req) => {
    const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 60) : [];
    return { results: items.map((it) => MET.run(String(it.metric || ''), it.params || {})), at: now() };
  }));

  // ---------- отчёты ----------
  api.get('/reports', need('reports.view'), h(() => ({
    reports: REP.list(),
    zones: L.zones.map((z) => ({ id: z.id, title: z.title, sub: z.sub })),
    users: db.prepare('SELECT username, full_name FROM users ORDER BY username').all(),
    tasks: db.prepare('SELECT id, name, status, created FROM inv_task ORDER BY id DESC LIMIT 50').all(),
    kinds: REP.KIND_LABEL,
  })));
  api.get('/reports/:id', need('reports.view'), (req, res, next) => {
    try {
      const rep = REP.run(req.params.id, req.query);
      if (!rep) throw new WmsError(404, 'NO_REPORT', 'Отчёт не найден');
      if (req.query.format === 'csv') {
        const name = `${rep.title} ${rep.filters.from}_${rep.filters.to}.csv`.replace(/[\\/:*?"<>|]/g, '');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="report.csv"; filename*=UTF-8''${encodeURIComponent(name)}`);
        return res.send(REP.toCsv(rep));
      }
      const limit = 3000;
      res.json({ ...rep, total: rep.rows.length, rows: rep.rows.slice(0, limit), truncated: rep.rows.length > limit });
    } catch (e) { next(e); }
  });
};
