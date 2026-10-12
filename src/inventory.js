'use strict';
// Инвентаризация: задание фиксирует учётные остатки по выбранным ячейкам,
// кладовщики вносят факт, при закрытии факт записывается в ячейки.
const { now, kindOf } = require('./db');
const { WmsError } = require('./warehouse');

function createInventory(db, L) {
  const bump = () => db.exec("UPDATE meta SET v = v + 1 WHERE k = 'rev'");
  const log = db.prepare('INSERT INTO oplog(ts, op, kind, addr, art, qty, user, ref) VALUES (?,?,?,?,?,?,?,?)');

  function task(id) {
    const t = db.prepare('SELECT * FROM inv_task WHERE id = ?').get(id);
    if (!t) throw new WmsError(404, 'NO_TASK', 'Задание инвентаризации не найдено');
    return t;
  }

  const create = db.transaction(({ name, zones, rows, onlyStocked }, user) => {
    const zs = (Array.isArray(zones) ? zones : []).filter((z) => L.zoneById.has(z));
    const rowSet = new Set((Array.isArray(rows) ? rows : []).map(String));
    if (!zs.length && !rowSet.size) throw new WmsError(400, 'NO_SCOPE', 'Выберите хотя бы одну зону или ряд');
    const addrs = [...L.meta.entries()].filter(([, m]) => zs.includes(m.zone) || rowSet.has(`${m.zone}-${String(m.row).padStart(2, '0')}`))
      .map(([a]) => a).sort();
    const cells = new Map(db.prepare('SELECT addr, sku, qty FROM cell').all().map((c) => [c.addr, c]));
    const chosen = addrs.filter((a) => !onlyStocked || (cells.get(a) && cells.get(a).sku));
    if (!chosen.length) throw new WmsError(400, 'EMPTY_SCOPE', 'В выбранной области нет ячеек для подсчёта');
    const busy = db.prepare(`SELECT l.addr FROM inv_line l JOIN inv_task t ON t.id = l.task_id WHERE t.status = 'open'`).pluck().all();
    const busySet = new Set(busy);
    const overlap = chosen.filter((a) => busySet.has(a));
    if (overlap.length) throw new WmsError(409, 'INV_OVERLAP', `${overlap.length} ячеек уже в другом открытом задании (например, ${overlap[0]})`);
    const title = String(name || '').trim() || `Инвентаризация ${zs.join(', ') || [...rowSet].join(', ')}`;
    const id = db.prepare('INSERT INTO inv_task(name, scope, created_by, created) VALUES (?,?,?,?)')
      .run(title.slice(0, 80), JSON.stringify({ zones: zs, rows: [...rowSet], onlyStocked: !!onlyStocked }), user, now()).lastInsertRowid;
    const ins = db.prepare('INSERT INTO inv_line(task_id, addr, art_expected, qty_expected) VALUES (?,?,?,?)');
    for (const a of chosen) { const c = cells.get(a) || {}; ins.run(id, a, c.sku || null, c.qty || 0); }
    log.run(now(), 'Инвентаризация начата', 'system', null, null, chosen.length, user, title);
    bump();
    return { id, lines: chosen.length };
  });

  function list() {
    return db.prepare(`SELECT t.*, COUNT(l.id) AS total, COUNT(l.qty_counted) AS counted,
      SUM(CASE WHEN l.qty_counted IS NOT NULL AND (l.qty_counted != l.qty_expected OR
        COALESCE(l.art_counted, l.art_expected, '') != COALESCE(l.art_expected, '')) THEN 1 ELSE 0 END) AS diffs
      FROM inv_task t LEFT JOIN inv_line l ON l.task_id = t.id GROUP BY t.id
      ORDER BY CASE t.status WHEN 'open' THEN 0 ELSE 1 END, t.id DESC LIMIT 100`).all();
  }

  function get(id) {
    const t = task(id);
    t.lines = db.prepare(`SELECT l.*, s.name AS name_expected, s2.name AS name_counted, c.sku AS cur_sku, c.qty AS cur_qty
      FROM inv_line l LEFT JOIN sku s ON s.art = l.art_expected LEFT JOIN sku s2 ON s2.art = l.art_counted
      LEFT JOIN cell c ON c.addr = l.addr WHERE l.task_id = ? ORDER BY l.addr`).all(id);
    return t;
  }

  const count = db.transaction((taskId, lineId, { qty, art }, user) => {
    const t = task(taskId);
    if (t.status !== 'open') throw new WmsError(409, 'TASK_CLOSED', 'Задание уже закрыто');
    const l = db.prepare('SELECT * FROM inv_line WHERE id = ? AND task_id = ?').get(lineId, taskId);
    if (!l) throw new WmsError(404, 'NO_LINE', 'Строка задания не найдена');
    if (qty === null || qty === '') {
      db.prepare('UPDATE inv_line SET qty_counted = NULL, art_counted = NULL, counted_by = NULL, counted_at = NULL WHERE id = ?').run(lineId);
      bump();
      return { line: { id: lineId, qty_counted: null } };
    }
    const n = Number(qty);
    if (!Number.isInteger(n) || n < 0 || n > 100000) throw new WmsError(400, 'BAD_QTY', 'Количество — целое число от 0');
    let a = art ? String(art).trim() : null;
    if (a && a === l.art_expected) a = null;
    if (a) {
      const s = db.prepare('SELECT zone FROM sku WHERE art = ?').get(a);
      if (!s) throw new WmsError(404, 'NO_SKU', `Артикула ${a} нет в каталоге`);
    }
    if (n > 0 && !a && !l.art_expected) throw new WmsError(400, 'NEED_ART', 'Ячейка числилась пустой: укажите найденный артикул');
    db.prepare('UPDATE inv_line SET qty_counted = ?, art_counted = ?, counted_by = ?, counted_at = ? WHERE id = ?').run(n, a, user, now(), lineId);
    bump();
    return { line: db.prepare('SELECT * FROM inv_line WHERE id = ?').get(lineId) };
  });

  const close = db.transaction((taskId, user) => {
    const t = task(taskId);
    if (t.status !== 'open') throw new WmsError(409, 'TASK_CLOSED', 'Задание уже закрыто');
    const lines = db.prepare('SELECT * FROM inv_line WHERE task_id = ? AND qty_counted IS NOT NULL').all(taskId);
    let changed = 0, plus = 0, minus = 0;
    const getCell = db.prepare('SELECT * FROM cell WHERE addr = ?');
    const setCell = db.prepare('UPDATE cell SET sku = ?, qty = ? WHERE addr = ?');
    for (const l of lines) {
      const c = getCell.get(l.addr);
      if (!c) continue;
      const art = l.qty_counted > 0 ? (l.art_counted || l.art_expected) : null;
      const qty = art ? l.qty_counted : 0;
      if (c.sku === art && c.qty === qty) continue;
      // остаток мог измениться после начала задания: разницу считаем от текущего учёта
      if (c.sku && c.sku !== art) { log.run(now(), 'Инвентаризация', kindOf('Инвентаризация'), l.addr, c.sku, -c.qty, user, t.name); minus += c.qty; }
      if (art) {
        const d = c.sku === art ? qty - c.qty : qty;
        if (d) { log.run(now(), 'Инвентаризация', 'inv', l.addr, art, d, user, t.name); if (d > 0) plus += d; else minus -= d; }
      }
      setCell.run(art, qty, l.addr);
      changed++;
    }
    db.prepare("UPDATE inv_task SET status = 'closed', closed_by = ?, closed_at = ? WHERE id = ?").run(user, now(), taskId);
    log.run(now(), 'Инвентаризация закрыта', 'system', null, null, changed, user, t.name);
    bump();
    return { changed, counted: lines.length, plus, minus };
  });

  const cancel = db.transaction((taskId, user) => {
    const t = task(taskId);
    if (t.status !== 'open') throw new WmsError(409, 'TASK_CLOSED', 'Задание уже закрыто');
    db.prepare("UPDATE inv_task SET status = 'cancelled', closed_by = ?, closed_at = ? WHERE id = ?").run(user, now(), taskId);
    bump();
    return { cancelled: true };
  });

  return { create, list, get, count, close, cancel };
}

module.exports = { createInventory };
