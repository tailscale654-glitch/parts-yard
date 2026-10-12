'use strict';
// Отчёты: таблица на экране и выгрузка в CSV для Excel.
const { zoneOf } = require('./layout');
const { reconcile } = require('./carsale');

const KIND_LABEL = {
  put: 'Размещение', pick: 'Отбор', move: 'Перемещение', count: 'Пересчёт', block: 'Блокировка',
  inv: 'Инвентаризация', shortage: 'Недостача', order: 'Заказ', doc: 'Документ', receipt: 'Приёмка', system: 'Система',
};

function pad(n) { return String(n).padStart(2, '0'); }
function dayStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function defaultRange() {
  const to = new Date(), from = new Date();
  from.setDate(from.getDate() - 6);
  return { from: dayStr(from), to: dayStr(to) };
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function createReports(db, L) {
  const R = {
    stock_cells: {
      title: 'Остатки по адресам', group: 'Остатки',
      description: 'Что лежит в каждой ячейке, заполненность и блокировки.',
      filters: ['zone', 'art', 'only'],
      run(f) {
        let rows = db.prepare(`SELECT c.addr, c.sku AS art, s.name, c.qty, s.per, c.blocked FROM cell c
          LEFT JOIN sku s ON s.art = c.sku ORDER BY c.addr`).all().filter((r) => L.meta.has(r.addr));
        if (f.only !== 'all') rows = rows.filter((r) => r.art || r.blocked);
        if (f.zone) rows = rows.filter((r) => L.meta.get(r.addr).zone === f.zone);
        if (f.art) rows = rows.filter((r) => (r.art || '').toLowerCase().includes(f.art) || (r.name || '').toLowerCase().includes(f.art));
        return {
          columns: [
            { key: 'addr', label: 'Адрес', mono: true }, { key: 'zone', label: 'Зона' }, { key: 'art', label: 'Артикул', mono: true },
            { key: 'name', label: 'Наименование' }, { key: 'qty', label: 'Кол-во', align: 'r', sum: true },
            { key: 'per', label: 'Вмест.', align: 'r' }, { key: 'fill', label: 'Заполн., %', align: 'r' }, { key: 'blocked', label: 'Блок' },
          ],
          rows: rows.map((r) => ({ ...r, zone: L.meta.get(r.addr).zone, art: r.art || '', name: r.name || '', per: r.per || '',
            fill: r.art && r.per ? Math.round((r.qty / r.per) * 100) : '', blocked: r.blocked ? 'да' : '' })),
        };
      },
    },
    stock_sku: {
      title: 'Остатки по артикулам', group: 'Остатки',
      description: 'Сколько штук каждого артикула, в скольких ячейках и хватает ли до минимума.',
      filters: ['zone', 'art', 'status'],
      run(f) {
        let rows = db.prepare(`SELECT s.art, s.name, s.zone, s.per, s.min_qty,
          COALESCE(SUM(c.qty), 0) AS qty, COUNT(c.addr) AS cells
          FROM sku s LEFT JOIN cell c ON c.sku = s.art GROUP BY s.art ORDER BY s.zone, s.art`).all();
        rows = rows.map((r) => ({ ...r, status: r.qty === 0 ? 'нет на складе' : r.min_qty && r.qty < r.min_qty ? 'ниже минимума' : 'в норме' }));
        if (f.zone) rows = rows.filter((r) => r.zone === f.zone);
        if (f.art) rows = rows.filter((r) => r.art.toLowerCase().includes(f.art) || r.name.toLowerCase().includes(f.art));
        if (f.status === 'low') rows = rows.filter((r) => r.status !== 'в норме');
        return {
          columns: [
            { key: 'art', label: 'Артикул', mono: true }, { key: 'name', label: 'Наименование' }, { key: 'zone', label: 'Зона' },
            { key: 'qty', label: 'Кол-во', align: 'r', sum: true }, { key: 'cells', label: 'Ячеек', align: 'r', sum: true },
            { key: 'min_qty', label: 'Минимум', align: 'r' }, { key: 'status', label: 'Статус', type: 'status' },
          ],
          rows,
        };
      },
    },
    movements: {
      title: 'Движение товара', group: 'Операции',
      description: 'Все операции с ячейками за период: кто, что, откуда и сколько.',
      filters: ['period', 'kind', 'zone', 'user', 'art'],
      run(f) {
        const args = [f.from + ' 00:00:00', f.to + ' 23:59:59'];
        let sql = `SELECT o.ts, o.kind, o.op, o.addr, o.art, s.name, o.qty, o.user, o.ref FROM oplog o
          LEFT JOIN sku s ON s.art = o.art WHERE o.ts BETWEEN ? AND ?`;
        if (f.kind) { sql += ' AND o.kind = ?'; args.push(f.kind); }
        if (f.user) { sql += ' AND o.user = ?'; args.push(f.user); }
        sql += ' ORDER BY o.id DESC LIMIT 20000';
        let rows = db.prepare(sql).all(...args);
        if (f.zone) rows = rows.filter((r) => zoneOf(r.addr) === f.zone);
        if (f.art) rows = rows.filter((r) => (r.art || '').toLowerCase().includes(f.art) || (r.name || '').toLowerCase().includes(f.art));
        return {
          columns: [
            { key: 'ts', label: 'Время', mono: true }, { key: 'op', label: 'Операция' }, { key: 'addr', label: 'Адрес', mono: true },
            { key: 'art', label: 'Артикул', mono: true }, { key: 'name', label: 'Наименование' },
            { key: 'qty', label: 'Кол-во', align: 'r' }, { key: 'user', label: 'Сотрудник' }, { key: 'ref', label: 'Документ' },
          ],
          rows: rows.map((r) => ({ ...r, art: r.art || '', name: r.name || '', addr: r.addr || '', ref: r.ref || '', user: r.user || '' })),
        };
      },
    },
    receipts: {
      title: 'Поставки', group: 'Документы',
      description: 'Строки поставок за период и сколько из них размещено.',
      filters: ['period', 'art', 'state'],
      run(f) {
        let rows = db.prepare(`SELECT r.doc, r.gate, r.created, r.art, s.name, r.qty, r.placed, r.done FROM receipt r
          LEFT JOIN sku s ON s.art = r.art WHERE r.created BETWEEN ? AND ? ORDER BY r.id DESC`).all(f.from + ' 00:00:00', f.to + ' 23:59:59');
        if (f.art) rows = rows.filter((r) => r.art.toLowerCase().includes(f.art) || (r.name || '').toLowerCase().includes(f.art));
        if (f.state === 'open') rows = rows.filter((r) => !r.done);
        if (f.state === 'done') rows = rows.filter((r) => r.done);
        return {
          columns: [
            { key: 'doc', label: 'Документ', mono: true }, { key: 'gate', label: 'Ворота' }, { key: 'created', label: 'Создана', mono: true },
            { key: 'art', label: 'Артикул', mono: true }, { key: 'name', label: 'Наименование' },
            { key: 'qty', label: 'Ожидалось', align: 'r', sum: true }, { key: 'placed', label: 'Размещено', align: 'r', sum: true },
            { key: 'left', label: 'Осталось', align: 'r', sum: true }, { key: 'status', label: 'Статус', type: 'status' },
          ],
          rows: rows.map((r) => ({ ...r, name: r.name || '', gate: r.gate || '', left: r.qty - r.placed,
            status: r.done ? (r.placed >= r.qty ? 'размещено' : 'закрыта') : r.placed ? 'частично' : 'ожидает' })),
        };
      },
    },
    orders: {
      title: 'Заказы дилеров', group: 'Документы',
      description: 'Заказы за период: заказано, собрано, недостача.',
      filters: ['period', 'dealer', 'state'],
      run(f) {
        let rows = db.prepare(`SELECT o.number, o.dealer, o.created, o.due, o.done, COUNT(l.id) AS lines,
          SUM(l.qty) AS ordered, SUM(l.picked) AS picked FROM orders o LEFT JOIN order_line l ON l.order_id = o.id
          WHERE o.created BETWEEN ? AND ? GROUP BY o.id ORDER BY o.id DESC`).all(f.from + ' 00:00:00', f.to + ' 23:59:59');
        if (f.dealer) rows = rows.filter((r) => r.dealer.toLowerCase().includes(f.dealer));
        if (f.state === 'open') rows = rows.filter((r) => !r.done);
        if (f.state === 'done') rows = rows.filter((r) => r.done);
        return {
          columns: [
            { key: 'number', label: 'Заказ', mono: true }, { key: 'dealer', label: 'Дилер' }, { key: 'created', label: 'Создан', mono: true },
            { key: 'due', label: 'Срок' }, { key: 'lines', label: 'Строк', align: 'r', sum: true },
            { key: 'ordered', label: 'Заказано', align: 'r', sum: true }, { key: 'picked', label: 'Собрано', align: 'r', sum: true },
            { key: 'short', label: 'Недостача', align: 'r', sum: true }, { key: 'status', label: 'Статус', type: 'status' },
          ],
          rows: rows.map((r) => ({ ...r, due: r.due || '', ordered: r.ordered || 0, picked: r.picked || 0,
            short: r.done ? (r.ordered || 0) - (r.picked || 0) : 0,
            status: r.done ? ((r.picked || 0) >= (r.ordered || 0) ? 'собран' : 'с недостачей') : r.picked ? 'собирается' : 'ожидает' })),
        };
      },
    },
    productivity: {
      title: 'Производительность сотрудников', group: 'Операции',
      description: 'Сколько операций и штук обработал каждый сотрудник за период.',
      filters: ['period'],
      run(f) {
        const rows = db.prepare(`SELECT o.user, u.full_name, r.name AS role,
          COUNT(*) AS ops,
          SUM(CASE WHEN o.kind = 'put' THEN 1 ELSE 0 END) AS put_n, SUM(CASE WHEN o.kind = 'put' THEN o.qty ELSE 0 END) AS put_u,
          SUM(CASE WHEN o.kind = 'pick' THEN 1 ELSE 0 END) AS pick_n, SUM(CASE WHEN o.kind = 'pick' THEN -o.qty ELSE 0 END) AS pick_u,
          SUM(CASE WHEN o.kind = 'move' THEN 1 ELSE 0 END) AS move_n,
          SUM(CASE WHEN o.kind IN ('count','inv') THEN 1 ELSE 0 END) AS count_n,
          MIN(o.ts) AS first, MAX(o.ts) AS last
          FROM oplog o LEFT JOIN users u ON u.username = o.user LEFT JOIN roles r ON r.key = u.role
          WHERE o.kind IN ('put','pick','move','count','inv') AND o.ts BETWEEN ? AND ? AND o.user IS NOT NULL
          GROUP BY o.user ORDER BY ops DESC`).all(f.from + ' 00:00:00', f.to + ' 23:59:59');
        return {
          columns: [
            { key: 'user', label: 'Логин', mono: true }, { key: 'full_name', label: 'Сотрудник' }, { key: 'role', label: 'Роль' },
            { key: 'ops', label: 'Операций', align: 'r', sum: true },
            { key: 'put_n', label: 'Размещений', align: 'r', sum: true }, { key: 'put_u', label: 'Размещено, шт', align: 'r', sum: true },
            { key: 'pick_n', label: 'Отборов', align: 'r', sum: true }, { key: 'pick_u', label: 'Отобрано, шт', align: 'r', sum: true },
            { key: 'move_n', label: 'Перемещений', align: 'r', sum: true }, { key: 'count_n', label: 'Пересчётов', align: 'r', sum: true },
            { key: 'first', label: 'Первая', mono: true }, { key: 'last', label: 'Последняя', mono: true },
          ],
          rows: rows.map((r) => ({ ...r, full_name: r.full_name || '', role: r.role || '' })),
        };
      },
    },
    abc: {
      title: 'ABC-анализ по отбору', group: 'Анализ',
      description: 'Класс A — 80% отобранных штук, B — следующие 15%, C — остальное. Подсказывает, что переложить ближе к отгрузке.',
      filters: ['period'],
      run(f) {
        const picks = new Map(db.prepare(`SELECT art, SUM(-qty) AS u FROM oplog WHERE kind = 'pick' AND ts BETWEEN ? AND ? GROUP BY art`)
          .all(f.from + ' 00:00:00', f.to + ' 23:59:59').map((r) => [r.art, r.u]));
        const skus = db.prepare('SELECT s.art, s.name, s.zone, COALESCE((SELECT SUM(qty) FROM cell c WHERE c.sku = s.art),0) AS stock FROM sku s').all()
          .map((s) => ({ ...s, picked: picks.get(s.art) || 0 })).sort((a, b) => b.picked - a.picked || a.art.localeCompare(b.art));
        const total = skus.reduce((n, s) => n + s.picked, 0) || 1;
        let cum = 0;
        const rows = skus.map((s) => {
          const share = (s.picked / total) * 100;
          const before = cum;
          cum += share;
          const cls = s.picked === 0 ? 'C' : before < 80 ? 'A' : before < 95 ? 'B' : 'C';
          const zone = L.zoneById.get(s.zone);
          let advice = '';
          if (cls === 'A' && zone && zone.prefer !== 'middle') advice = 'ходовой: ближе к отгрузке, средние ярусы';
          if (cls === 'C' && zone && zone.prefer === 'middle' && s.stock > 0) advice = 'редкий: освободить место в быстрой зоне';
          return { ...s, share: share.toFixed(1), cum: Math.min(cum, 100).toFixed(1), cls, advice };
        });
        return {
          columns: [
            { key: 'cls', label: 'Класс', type: 'status' }, { key: 'art', label: 'Артикул', mono: true }, { key: 'name', label: 'Наименование' },
            { key: 'zone', label: 'Зона' }, { key: 'picked', label: 'Отобрано, шт', align: 'r', sum: true },
            { key: 'share', label: 'Доля, %', align: 'r' }, { key: 'cum', label: 'Накопл., %', align: 'r' },
            { key: 'stock', label: 'Остаток', align: 'r', sum: true }, { key: 'advice', label: 'Рекомендация' },
          ],
          rows,
        };
      },
    },
    occupancy: {
      title: 'Заполненность по рядам', group: 'Остатки',
      description: 'Свободные, занятые и заблокированные ячейки по каждому ряду.',
      filters: ['zone'],
      run(f) {
        const cells = new Map(db.prepare('SELECT c.addr, c.sku, c.qty, c.blocked, s.per FROM cell c LEFT JOIN sku s ON s.art = c.sku').all().map((r) => [r.addr, r]));
        const agg = new Map();
        for (const [addr, m] of L.meta) {
          if (f.zone && m.zone !== f.zone) continue;
          const key = `${m.zone}-${String(m.row).padStart(2, '0')}`;
          const a = agg.get(key) || { row: key, zone: m.zone, cells: 0, occupied: 0, blocked: 0, fillSum: 0 };
          const c = cells.get(addr);
          a.cells++;
          if (c && c.sku) { a.occupied++; a.fillSum += c.per ? c.qty / c.per : 0; }
          if (c && c.blocked) a.blocked++;
          agg.set(key, a);
        }
        return {
          columns: [
            { key: 'row', label: 'Ряд', mono: true }, { key: 'zone', label: 'Зона' }, { key: 'cells', label: 'Ячеек', align: 'r', sum: true },
            { key: 'occupied', label: 'Занято', align: 'r', sum: true }, { key: 'free', label: 'Свободно', align: 'r', sum: true },
            { key: 'blocked', label: 'Блок', align: 'r', sum: true }, { key: 'occ', label: 'Занятость, %', align: 'r' },
            { key: 'fill', label: 'По объёму, %', align: 'r' },
          ],
          rows: [...agg.values()].map((a) => ({ ...a, free: a.cells - a.occupied - (a.blocked - 0),
            occ: Math.round((a.occupied / a.cells) * 100), fill: Math.round((a.fillSum / a.cells) * 100) }))
            .map((a) => ({ ...a, free: Math.max(0, a.cells - a.occupied - a.blocked) })),
        };
      },
    },
    carsale: {
      title: 'Сверка с Carsale', group: 'Анализ',
      description: 'Сколько по Carsale лежит на центральном складе и сколько из этого разложено по ячейкам. «Не размещено» — нужно оприходовать по адресам.',
      filters: ['zone', 'art', 'status'],
      run(f) {
        let rows = reconcile(db);
        if (f.zone) rows = rows.filter((r) => r.zone === f.zone);
        if (f.art) rows = rows.filter((r) => r.art.toLowerCase().includes(f.art) || r.name.toLowerCase().includes(f.art));
        if (f.status === 'low') rows = rows.filter((r) => r.status !== 'совпадает');
        return {
          columns: [
            { key: 'art', label: 'Артикул', mono: true }, { key: 'name', label: 'Наименование' }, { key: 'zone', label: 'Зона' },
            { key: 'ext_qty', label: 'Carsale: на складе', align: 'r', sum: true }, { key: 'ext_reserved', label: 'Бронь', align: 'r', sum: true },
            { key: 'placed', label: 'В ячейках', align: 'r', sum: true }, { key: 'pending', label: 'В приёмке', align: 'r', sum: true },
            { key: 'diff', label: 'Разница', align: 'r', sum: true, type: 'diff' }, { key: 'status', label: 'Статус', type: 'status' },
            { key: 'ext_location', label: 'Место в Carsale' },
          ],
          rows: rows.map((r) => ({ ...r, ext_location: r.ext_location || '' })),
        };
      },
    },
    inventory: {
      title: 'Расхождения инвентаризации', group: 'Анализ',
      description: 'Ячейки, где посчитанное отличается от учёта. Выберите задание или период.',
      filters: ['period', 'task'],
      run(f) {
        const args = [];
        let sql = `SELECT t.id AS task_id, t.name AS task, t.status, l.addr, l.art_expected, l.qty_expected,
          l.art_counted, l.qty_counted, l.counted_by, l.counted_at FROM inv_line l JOIN inv_task t ON t.id = l.task_id
          WHERE l.qty_counted IS NOT NULL AND (l.qty_counted != l.qty_expected OR COALESCE(l.art_counted, l.art_expected, '') != COALESCE(l.art_expected, ''))`;
        if (f.task) { sql += ' AND t.id = ?'; args.push(Number(f.task)); } else { sql += ' AND t.created BETWEEN ? AND ?'; args.push(f.from + ' 00:00:00', f.to + ' 23:59:59'); }
        sql += ' ORDER BY t.id DESC, l.addr';
        const rows = db.prepare(sql).all(...args).map((r) => ({
          ...r, art: r.art_counted || r.art_expected || '',
          diff: r.art_counted && r.art_counted !== r.art_expected ? r.qty_counted : r.qty_counted - r.qty_expected,
          note: r.art_counted && r.art_counted !== r.art_expected ? `найден другой товар (учёт: ${r.art_expected || 'пусто'})` : '',
          status: r.status === 'closed' ? 'применено' : r.status === 'open' ? 'в работе' : 'отменено',
        }));
        return {
          columns: [
            { key: 'task', label: 'Задание' }, { key: 'addr', label: 'Адрес', mono: true }, { key: 'art', label: 'Артикул', mono: true },
            { key: 'qty_expected', label: 'По учёту', align: 'r', sum: true }, { key: 'qty_counted', label: 'Факт', align: 'r', sum: true },
            { key: 'diff', label: 'Разница', align: 'r', sum: true, type: 'diff' }, { key: 'note', label: 'Примечание' },
            { key: 'counted_by', label: 'Считал' }, { key: 'status', label: 'Статус', type: 'status' },
          ],
          rows,
        };
      },
    },
  };

  const list = () => Object.entries(R).map(([id, r]) => ({ id, title: r.title, group: r.group, description: r.description, filters: r.filters }));

  function normalize(q) {
    const d = defaultRange();
    const f = {
      from: DATE_RE.test(q.from || '') ? q.from : d.from,
      to: DATE_RE.test(q.to || '') ? q.to : d.to,
      zone: q.zone && L.zoneById.has(q.zone) ? q.zone : null,
      art: q.art ? String(q.art).trim().toLowerCase() : '',
      dealer: q.dealer ? String(q.dealer).trim().toLowerCase() : '',
      user: q.user ? String(q.user) : '',
      kind: q.kind && KIND_LABEL[q.kind] ? q.kind : '',
      state: ['open', 'done'].includes(q.state) ? q.state : '',
      status: q.status === 'low' ? 'low' : '',
      only: q.only === 'all' ? 'all' : '',
      task: /^\d+$/.test(q.task || '') ? q.task : '',
    };
    if (f.from > f.to) [f.from, f.to] = [f.to, f.from];
    return f;
  }

  function run(id, q) {
    const r = R[id];
    if (!r) return null;
    const f = normalize(q || {});
    const out = r.run(f);
    const totals = {};
    for (const c of out.columns) if (c.sum) totals[c.key] = out.rows.reduce((n, x) => n + (Number(x[c.key]) || 0), 0);
    return { id, title: r.title, filters: f, columns: out.columns, rows: out.rows, totals };
  }

  function toCsv(rep) {
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [rep.columns.map((c) => esc(c.label)).join(';')];
    for (const r of rep.rows) lines.push(rep.columns.map((c) => esc(r[c.key])).join(';'));
    if (Object.keys(rep.totals).length) lines.push(rep.columns.map((c, i) => esc(i === 0 ? 'Итого' : rep.totals[c.key] ?? '')).join(';'));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  return { list, run, toCsv, KIND_LABEL };
}

module.exports = { createReports, KIND_LABEL };
