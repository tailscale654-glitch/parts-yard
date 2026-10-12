'use strict';
// Метрики для конструктора дашбордов. Каждая метрика отдаёт данные одной из форм:
//   scalar   { value, unit, sub, spark? }          → плитка KPI
//   series   { labels, series:[{name, values}] }   → линия или столбцы по дням
//   category { items:[{label, value, note?}], unit } → горизонтальные полосы или столбцы
//   rows     { columns:[{key,label,align}], rows }  → таблица
const { zoneOf } = require('./layout');

const VIZ = { scalar: ['kpi'], series: ['line', 'columns'], category: ['bars', 'columns'], rows: ['table'] };
const PERIODS = [1, 7, 14, 30, 90];

function pad(n) { return String(n).padStart(2, '0'); }
function dayStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function lastDays(n) {
  const out = [], d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - (n - 1));
  for (let i = 0; i < n; i++) { out.push(dayStr(d)); d.setDate(d.getDate() + 1); }
  return out;
}
function since(days) { return lastDays(days)[0] + ' 00:00:00'; }
const today = () => dayStr(new Date());

function createMetrics(db, L) {
  const zoneFilter = (zone) => (zone && zone !== 'all' ? zone : null);
  const cellsIn = (zone) => [...L.meta.keys()].filter((a) => !zone || L.meta.get(a).zone === zone);

  function stockCells(zone) {
    const rows = db.prepare(`SELECT c.addr, c.sku, c.qty, c.blocked, s.per FROM cell c LEFT JOIN sku s ON s.art = c.sku
      WHERE c.sku IS NOT NULL OR c.blocked = 1`).all();
    return rows.filter((r) => L.meta.has(r.addr) && (!zone || L.meta.get(r.addr).zone === zone));
  }
  function daily(kind, days, zone, field = 'units') {
    const rows = db.prepare(`SELECT substr(ts, 1, 10) AS d, addr, COUNT(*) AS n, SUM(ABS(COALESCE(qty, 0))) AS u
      FROM oplog WHERE kind = ? AND ts >= ? GROUP BY d, addr`).all(kind, since(days));
    const map = new Map();
    for (const r of rows) {
      if (zone && zoneOf(r.addr) !== zone) continue;
      map.set(r.d, (map.get(r.d) || 0) + (field === 'units' ? r.u : r.n));
    }
    return lastDays(days).map((d) => map.get(d) || 0);
  }
  function sumToday(kind, zone) {
    return daily(kind, 1, zone)[0];
  }
  const zoneTitle = (z) => (L.zoneById.get(z) ? `${z} · ${L.zoneById.get(z).sub || L.zoneById.get(z).title}` : z);

  const M = {
    // ---------- плитки ----------
    occupancy_pct: {
      title: 'Занято ячеек', shape: 'scalar', params: ['zone'], group: 'Ёмкость',
      run({ zone }) {
        const total = cellsIn(zone).length, rows = stockCells(zone);
        const occ = rows.filter((r) => r.sku).length;
        return { value: total ? Math.round((occ / total) * 100) : 0, unit: '%', sub: `${occ} из ${total} ячеек` };
      },
    },
    fill_pct: {
      title: 'Заполненность по объёму', shape: 'scalar', params: ['zone'], group: 'Ёмкость',
      run({ zone }) {
        const total = cellsIn(zone).length, rows = stockCells(zone);
        const f = rows.reduce((n, r) => n + (r.sku && r.per ? r.qty / r.per : 0), 0);
        return { value: total ? Math.round((f / total) * 100) : 0, unit: '%', sub: 'штук от вместимости ячеек' };
      },
    },
    free_cells: {
      title: 'Свободных ячеек', shape: 'scalar', params: ['zone'], group: 'Ёмкость',
      run({ zone }) {
        const total = cellsIn(zone).length, rows = stockCells(zone);
        return { value: total - rows.length, unit: '', sub: `из ${total}` };
      },
    },
    blocked_cells: {
      title: 'Заблокировано ячеек', shape: 'scalar', params: ['zone'], group: 'Ёмкость', alertAbove: 0,
      run({ zone }) { return { value: stockCells(zone).filter((r) => r.blocked).length, unit: '', sub: 'недоступны для размещения' }; },
    },
    units_total: {
      title: 'Штук на складе', shape: 'scalar', params: ['zone'], group: 'Остатки',
      run({ zone }) {
        const rows = stockCells(zone).filter((r) => r.sku);
        return { value: rows.reduce((n, r) => n + r.qty, 0), unit: 'шт', sub: `${new Set(rows.map((r) => r.sku)).size} артикулов` };
      },
    },
    below_min: {
      title: 'Артикулов ниже минимума', shape: 'scalar', params: [], group: 'Остатки', alertAbove: 0,
      run() {
        const n = db.prepare(`SELECT COUNT(*) FROM sku s WHERE s.min_qty > 0 AND
          COALESCE((SELECT SUM(qty) FROM cell c WHERE c.sku = s.art), 0) < s.min_qty`).pluck().get();
        return { value: n, unit: '', sub: 'нужно пополнить' };
      },
    },
    receipts_open: {
      title: 'К размещению', shape: 'scalar', params: [], group: 'Документы',
      run() {
        const r = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(qty - placed), 0) AS u FROM receipt WHERE done = 0').get();
        return { value: r.n, unit: 'стр.', sub: `${r.u} шт ждут размещения` };
      },
    },
    orders_open: {
      title: 'Заказов к сборке', shape: 'scalar', params: [], group: 'Документы',
      run() {
        const rows = db.prepare('SELECT due FROM orders WHERE done = 0').pluck().all();
        const t = new Date(), hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
        const late = rows.filter((d) => d && /^\d{1,2}:\d{2}$/.test(d) && d.padStart(5, '0') < hm).length;
        return { value: rows.length, unit: '', sub: late ? `${late} просрочено по времени` : 'без просрочек' };
      },
    },
    picked_today: {
      title: 'Отобрано сегодня', shape: 'scalar', params: ['zone'], group: 'Операции',
      run({ zone }) { return { value: sumToday('pick', zone), unit: 'шт', sub: 'за 7 дней', spark: daily('pick', 7, zone) }; },
    },
    received_today: {
      title: 'Размещено сегодня', shape: 'scalar', params: ['zone'], group: 'Операции',
      run({ zone }) { return { value: sumToday('put', zone), unit: 'шт', sub: 'за 7 дней', spark: daily('put', 7, zone) }; },
    },
    ops_today: {
      title: 'Операций сегодня', shape: 'scalar', params: [], group: 'Операции',
      run() {
        const n = db.prepare("SELECT COUNT(*) FROM oplog WHERE ts >= ? AND kind IN ('put','pick','move','count','inv')").pluck().get(today() + ' 00:00:00');
        const users = db.prepare("SELECT COUNT(DISTINCT user) FROM oplog WHERE ts >= ? AND kind IN ('put','pick','move','count','inv')").pluck().get(today() + ' 00:00:00');
        return { value: n, unit: '', sub: `сотрудников в работе: ${users}` };
      },
    },
    inv_open: {
      title: 'Открытых инвентаризаций', shape: 'scalar', params: [], group: 'Остатки',
      run() {
        const r = db.prepare(`SELECT COUNT(DISTINCT t.id) AS n, COUNT(l.id) AS lines, COUNT(l.qty_counted) AS done
          FROM inv_task t LEFT JOIN inv_line l ON l.task_id = t.id WHERE t.status = 'open'`).get();
        return { value: r.n, unit: '', sub: r.n ? `посчитано ${r.done} из ${r.lines} ячеек` : 'нет заданий' };
      },
    },

    // ---------- по дням ----------
    flow_daily: {
      title: 'Приход и расход по дням', shape: 'series', params: ['days', 'zone'], group: 'Операции',
      run({ days, zone }) {
        return { labels: lastDays(days), unit: 'шт', series: [
          { name: 'Размещено', values: daily('put', days, zone) },
          { name: 'Отобрано', values: daily('pick', days, zone) },
        ] };
      },
    },
    ops_daily: {
      title: 'Операции по дням', shape: 'series', params: ['days'], group: 'Операции',
      run({ days }) {
        return { labels: lastDays(days), unit: 'опер.', series: [
          { name: 'Размещение', values: daily('put', days, null, 'ops') },
          { name: 'Отбор', values: daily('pick', days, null, 'ops') },
          { name: 'Перемещение', values: daily('move', days, null, 'ops') },
          { name: 'Пересчёт', values: daily('count', days, null, 'ops') },
        ] };
      },
    },
    orders_daily: {
      title: 'Собрано заказов по дням', shape: 'series', params: ['days'], group: 'Документы',
      run({ days }) {
        const rows = db.prepare("SELECT substr(ts,1,10) AS d, COUNT(DISTINCT ref) AS n FROM oplog WHERE kind = 'order' AND ts >= ? GROUP BY d").all(since(days));
        const m = new Map(rows.map((r) => [r.d, r.n]));
        return { labels: lastDays(days), unit: 'зак.', series: [{ name: 'Заказы', values: lastDays(days).map((d) => m.get(d) || 0) }] };
      },
    },

    // ---------- по категориям ----------
    occupancy_by_zone: {
      title: 'Занятость по зонам', shape: 'category', params: [], group: 'Ёмкость',
      run() {
        const rows = stockCells(null);
        return { unit: '%', max: 100, items: L.zones.map((z) => {
          const total = cellsIn(z.id).length, occ = rows.filter((r) => r.sku && L.meta.get(r.addr).zone === z.id).length;
          return { label: zoneTitle(z.id), value: total ? Math.round((occ / total) * 100) : 0, note: `${occ}/${total}` };
        }) };
      },
    },
    units_by_zone: {
      title: 'Штук по зонам', shape: 'category', params: [], group: 'Остатки',
      run() {
        const rows = stockCells(null).filter((r) => r.sku);
        return { unit: 'шт', items: L.zones.map((z) => ({
          label: zoneTitle(z.id), value: rows.filter((r) => L.meta.get(r.addr).zone === z.id).reduce((n, r) => n + r.qty, 0),
        })) };
      },
    },
    top_picked: {
      title: 'Самые ходовые артикулы', shape: 'category', params: ['days', 'limit', 'zone'], group: 'Остатки',
      run({ days, limit, zone }) {
        const rows = db.prepare(`SELECT o.art, s.name, s.zone, SUM(-o.qty) AS u FROM oplog o LEFT JOIN sku s ON s.art = o.art
          WHERE o.kind = 'pick' AND o.ts >= ? GROUP BY o.art ORDER BY u DESC`).all(since(days));
        return { unit: 'шт', items: rows.filter((r) => !zone || r.zone === zone).slice(0, limit)
          .map((r) => ({ label: `${r.art} · ${r.name || ''}`, value: r.u })) };
      },
    },
    top_stock: {
      title: 'Больше всего на складе', shape: 'category', params: ['limit', 'zone'], group: 'Остатки',
      run({ limit, zone }) {
        const rows = db.prepare(`SELECT c.sku AS art, s.name, s.zone, SUM(c.qty) AS u FROM cell c JOIN sku s ON s.art = c.sku
          GROUP BY c.sku ORDER BY u DESC`).all();
        return { unit: 'шт', items: rows.filter((r) => !zone || r.zone === zone).slice(0, limit)
          .map((r) => ({ label: `${r.art} · ${r.name}`, value: r.u })) };
      },
    },
    user_productivity: {
      title: 'Производительность сотрудников', shape: 'category', params: ['days'], group: 'Операции',
      run({ days }) {
        const rows = db.prepare(`SELECT o.user, u.full_name, COUNT(*) AS n, SUM(ABS(COALESCE(o.qty,0))) AS units
          FROM oplog o LEFT JOIN users u ON u.username = o.user
          WHERE o.kind IN ('put','pick','move','count','inv') AND o.ts >= ? AND o.user IS NOT NULL
          GROUP BY o.user ORDER BY n DESC LIMIT 15`).all(since(days));
        return { unit: 'опер.', items: rows.map((r) => ({ label: r.full_name || r.user, value: r.n, note: `${r.units} шт` })) };
      },
    },
    picks_by_zone: {
      title: 'Отбор по зонам', shape: 'category', params: ['days'], group: 'Операции',
      run({ days }) {
        const rows = db.prepare("SELECT addr, -qty AS u FROM oplog WHERE kind = 'pick' AND ts >= ?").all(since(days));
        const m = new Map();
        for (const r of rows) m.set(zoneOf(r.addr), (m.get(zoneOf(r.addr)) || 0) + r.u);
        return { unit: 'шт', items: L.zones.map((z) => ({ label: zoneTitle(z.id), value: m.get(z.id) || 0 })) };
      },
    },

    // ---------- таблицы ----------
    alerts: {
      title: 'Требует внимания', shape: 'rows', params: [], group: 'Контроль',
      run() {
        const rows = [];
        const t = new Date(), hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
        for (const o of db.prepare('SELECT number, dealer, due FROM orders WHERE done = 0').all()) {
          if (o.due && /^\d{1,2}:\d{2}$/.test(o.due) && o.due.padStart(5, '0') < hm) {
            rows.push({ level: 'Срочно', what: `Заказ ${o.number}`, detail: `${o.dealer}: срок ${o.due} прошёл` });
          }
        }
        for (const s of db.prepare(`SELECT s.art, s.name, s.min_qty, COALESCE((SELECT SUM(qty) FROM cell c WHERE c.sku = s.art), 0) AS q
          FROM sku s WHERE s.min_qty > 0`).all()) {
          if (s.q < s.min_qty) rows.push({ level: s.q === 0 ? 'Срочно' : 'Внимание', what: s.art, detail: `${s.name}: ${s.q} шт при минимуме ${s.min_qty}` });
        }
        const blocked = db.prepare('SELECT COUNT(*) FROM cell WHERE blocked = 1').pluck().get();
        if (blocked) rows.push({ level: 'Инфо', what: 'Блокировки', detail: `${blocked} ячеек заблокировано` });
        const stale = db.prepare("SELECT COUNT(*) FROM receipt WHERE done = 0 AND created < ?").pluck().get(since(2));
        if (stale) rows.push({ level: 'Внимание', what: 'Приёмка', detail: `${stale} строк поставок не размещены больше суток` });
        for (const t2 of db.prepare("SELECT name, created FROM inv_task WHERE status = 'open'").all()) {
          rows.push({ level: 'Инфо', what: 'Инвентаризация', detail: `«${t2.name}» открыта с ${t2.created.slice(0, 16)}` });
        }
        const order = { 'Срочно': 0, 'Внимание': 1, 'Инфо': 2 };
        rows.sort((a, b) => order[a.level] - order[b.level]);
        return { columns: [{ key: 'level', label: 'Уровень', type: 'level' }, { key: 'what', label: 'Объект' }, { key: 'detail', label: 'Что случилось' }], rows };
      },
    },
    low_stock: {
      title: 'Ниже минимума', shape: 'rows', params: ['limit'], group: 'Контроль',
      run({ limit }) {
        const rows = db.prepare(`SELECT s.art, s.name, s.zone, s.min_qty,
          COALESCE((SELECT SUM(qty) FROM cell c WHERE c.sku = s.art), 0) AS qty FROM sku s WHERE s.min_qty > 0`).all()
          .filter((r) => r.qty < r.min_qty).sort((a, b) => a.qty / a.min_qty - b.qty / b.min_qty).slice(0, limit);
        return { columns: [{ key: 'art', label: 'Артикул', mono: true }, { key: 'name', label: 'Наименование' },
          { key: 'qty', label: 'Есть', align: 'r' }, { key: 'min_qty', label: 'Мин.', align: 'r' }], rows };
      },
    },
    open_orders: {
      title: 'Заказы в работе', shape: 'rows', params: ['limit'], group: 'Документы',
      run({ limit }) {
        const rows = db.prepare(`SELECT o.number, o.dealer, o.due, SUM(l.qty) AS total, SUM(l.picked) AS picked
          FROM orders o JOIN order_line l ON l.order_id = o.id WHERE o.done = 0 GROUP BY o.id
          ORDER BY COALESCE(NULLIF(o.due,''),'99:99') LIMIT ?`).all(limit);
        return { columns: [{ key: 'number', label: 'Заказ', mono: true }, { key: 'dealer', label: 'Дилер' },
          { key: 'due', label: 'Срок' }, { key: 'progress', label: 'Собрано', type: 'progress' }],
        rows: rows.map((r) => ({ ...r, progress: [r.picked, r.total] })) };
      },
    },
    recent_ops: {
      title: 'Последние операции', shape: 'rows', params: ['limit'], group: 'Операции',
      run({ limit }) {
        const rows = db.prepare("SELECT ts, op, addr, art, qty, user FROM oplog WHERE kind IN ('put','pick','move','count','inv','block') ORDER BY id DESC LIMIT ?").all(limit);
        return { columns: [{ key: 'time', label: 'Время', mono: true }, { key: 'op', label: 'Операция' },
          { key: 'addr', label: 'Адрес', mono: true }, { key: 'qty', label: 'Шт', align: 'r' }, { key: 'user', label: 'Кто' }],
        rows: rows.map((r) => ({ ...r, time: r.ts.slice(11, 16) })) };
      },
    },
  };

  const catalog = () => Object.entries(M).map(([id, m]) => ({ id, title: m.title, shape: m.shape, group: m.group, params: m.params, viz: VIZ[m.shape] }));

  function run(id, raw = {}) {
    const m = M[id];
    if (!m) return { error: `Нет метрики ${id}` };
    const days = PERIODS.includes(Number(raw.days)) ? Number(raw.days) : 14;
    const limit = Math.min(Math.max(parseInt(raw.limit, 10) || 8, 1), 50);
    const zone = zoneFilter(raw.zone);
    if (zone && !L.zoneById.has(zone)) return { error: `Нет зоны ${zone}` };
    try {
      return { shape: m.shape, title: m.title, alertAbove: m.alertAbove, ...m.run({ days, limit, zone }) };
    } catch (e) {
      console.error(e);
      return { error: 'Не удалось посчитать метрику' };
    }
  }

  return { catalog, run, PERIODS };
}

const DEFAULT_DASHBOARD = [
  { metric: 'occupancy_pct', viz: 'kpi', w: 1 },
  { metric: 'units_total', viz: 'kpi', w: 1 },
  { metric: 'orders_open', viz: 'kpi', w: 1 },
  { metric: 'receipts_open', viz: 'kpi', w: 1 },
  { metric: 'flow_daily', viz: 'columns', w: 2, params: { days: 14 } },
  { metric: 'occupancy_by_zone', viz: 'bars', w: 2 },
  { metric: 'alerts', viz: 'table', w: 2 },
  { metric: 'open_orders', viz: 'table', w: 2, params: { limit: 8 } },
  { metric: 'picked_today', viz: 'kpi', w: 1 },
  { metric: 'received_today', viz: 'kpi', w: 1 },
  { metric: 'below_min', viz: 'kpi', w: 1 },
  { metric: 'blocked_cells', viz: 'kpi', w: 1 },
  { metric: 'top_picked', viz: 'bars', w: 2, params: { days: 30, limit: 8 } },
  { metric: 'user_productivity', viz: 'bars', w: 2, params: { days: 7 } },
];

module.exports = { createMetrics, DEFAULT_DASHBOARD, lastDays, since };
