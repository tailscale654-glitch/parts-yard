'use strict';
// Логика склада: подбор адресов, маршруты, операции с остатками.
// Все изменения идут через функции этого модуля и выполняются в транзакции.
const { now, kindOf } = require('./db');
const { makeGeometry } = require('./layout');

class WmsError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function posInt(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new WmsError(400, 'BAD_QTY', `${name}: нужно целое число больше нуля`);
  return n;
}

function createWarehouse(db, L, opts = {}) {
  const G = makeGeometry(L);
  const q = {
    rev: db.prepare("SELECT v FROM meta WHERE k = 'rev'").pluck(),
    bump: db.prepare("UPDATE meta SET v = v + 1 WHERE k = 'rev'"),
    sku: db.prepare('SELECT * FROM sku WHERE art = ?'),
    cell: db.prepare('SELECT * FROM cell WHERE addr = ?'),
    setCell: db.prepare('UPDATE cell SET sku = ?, qty = ? WHERE addr = ?'),
    setBlocked: db.prepare('UPDATE cell SET blocked = ? WHERE addr = ?'),
    log: db.prepare('INSERT INTO oplog(ts, op, kind, addr, art, qty, user, ref) VALUES (?,?,?,?,?,?,?,?)'),
    receipt: db.prepare('SELECT * FROM receipt WHERE id = ?'),
    order: db.prepare('SELECT * FROM orders WHERE id = ?'),
    lines: db.prepare('SELECT * FROM order_line WHERE order_id = ? ORDER BY id'),
  };
  const log = (op, addr, art, qty, user, ref) => q.log.run(now(), op, kindOf(op), addr || null, art || null, qty ?? null, user || null, ref || null);
  const rev = () => q.rev.get();
  const bump = () => q.bump.run();

  function needCell(addr) {
    if (!L.meta.has(addr)) throw new WmsError(404, 'NO_ADDRESS', `Адреса ${addr} нет на складе`);
    return q.cell.get(addr);
  }
  function needSku(art) {
    const s = q.sku.get(art);
    if (!s) throw new WmsError(404, 'NO_SKU', `Артикула ${art} нет в каталоге`);
    return s;
  }

  // ---------- подбор адресов ----------
  function planPutaway(rid) {
    const r = q.receipt.get(rid);
    if (!r) throw new WmsError(404, 'NO_RECEIPT', 'Строка поставки не найдена');
    if (r.done) throw new WmsError(409, 'RECEIPT_DONE', 'Строка поставки уже размещена');
    const s = needSku(r.art);
    // закреплённые за артикулом ячейки идут первыми, в порядке из справочника ячеек
    let home = [];
    try { home = JSON.parse(s.home || '[]').filter((a) => L.meta.has(a)); } catch (e) { home = []; }
    const homeSet = new Set(home);
    const rows = db.prepare('SELECT addr, sku, qty FROM cell WHERE blocked = 0 AND (sku IS NULL OR (sku = ? AND qty < ?))')
      .all(s.art, s.per).filter((x) => L.meta.has(x.addr) && (L.meta.get(x.addr).zone === s.zone || homeSet.has(x.addr)));
    const homeRows = home.map((a) => rows.find((x) => x.addr === a)).filter(Boolean);
    const same = rows.filter((x) => x.sku === s.art && !homeSet.has(x.addr)).sort((a, b) => G.dist(a.addr) - G.dist(b.addr));
    // чужие закреплённые ячейки занимаем в последнюю очередь
    const others = new Set();
    for (const h of db.prepare("SELECT home FROM sku WHERE home IS NOT NULL AND home != '[]' AND art != ?").pluck().all(s.art)) {
      try { for (const a of JSON.parse(h)) others.add(a); } catch (e) { /* пропускаем */ }
    }
    const empty = rows.filter((x) => !x.sku && !homeSet.has(x.addr))
      .sort((a, b) => (others.has(a.addr) - others.has(b.addr)) || G.slotScore(a.addr) - G.slotScore(b.addr));
    const plan = [];
    let left = r.qty - r.placed;
    for (const x of [...homeRows, ...same, ...empty]) {
      if (left <= 0) break;
      const put = Math.min(s.per - (x.sku ? x.qty : 0), left);
      if (put > 0) { plan.push({ addr: x.addr, art: s.art, qty: put, fresh: !x.sku }); left -= put; }
    }
    plan.sort((a, b) => G.routeCmp(a.addr, b.addr));
    return { receipt: r, plan, left };
  }

  // минимум точек: ячейка, закрывающая строку целиком (наименее полная из таких — чтобы освобождать место);
  // если такой нет — самая полная, и дальше по тому же правилу
  function planPick(oid) {
    const o = q.order.get(oid);
    if (!o) throw new WmsError(404, 'NO_ORDER', 'Заказ не найден');
    if (o.done) throw new WmsError(409, 'ORDER_DONE', 'Заказ уже закрыт');
    const plan = [], short = [], taken = new Map();
    for (const line of q.lines.all(oid)) {
      let left = line.qty - line.picked;
      if (left <= 0) continue;
      const cells = db.prepare('SELECT addr, qty FROM cell WHERE sku = ? AND blocked = 0 AND qty > 0').all(line.art)
        .filter((x) => L.meta.has(x.addr));
      while (left > 0) {
        const avail = cells.map((x) => ({ addr: x.addr, q: x.qty - (taken.get(x.addr) || 0) })).filter((x) => x.q > 0);
        if (!avail.length) break;
        const full = avail.filter((x) => x.q >= left);
        const pickFrom = full.length
          ? full.sort((a, b) => a.q - b.q || G.dist(a.addr) - G.dist(b.addr))[0]
          : avail.sort((a, b) => b.q - a.q || G.dist(a.addr) - G.dist(b.addr))[0];
        const take = Math.min(pickFrom.q, left);
        plan.push({ addr: pickFrom.addr, art: line.art, qty: take, lineId: line.id });
        taken.set(pickFrom.addr, (taken.get(pickFrom.addr) || 0) + take);
        left -= take;
      }
      if (left > 0) short.push({ art: line.art, qty: left });
    }
    plan.sort((a, b) => G.routeCmp(a.addr, b.addr));
    return { order: o, plan, short };
  }

  // ---------- штучные операции (ТСД и веб) ----------
  function put({ addr, art, qty, receiptId }, user, silent) {
    qty = posInt(qty, 'Количество');
    const c = needCell(addr);
    const s = needSku(art);
    if (c.blocked) throw new WmsError(409, 'CELL_BLOCKED', `Ячейка ${addr} заблокирована`);
    if (L.meta.get(addr).zone !== s.zone) {
      throw new WmsError(409, 'WRONG_ZONE', `${art} хранится в зоне ${s.zone}, а ${addr} — в зоне ${L.meta.get(addr).zone}`);
    }
    if (c.sku && c.sku !== art) throw new WmsError(409, 'CELL_OCCUPIED', `В ячейке ${addr} уже лежит ${c.sku}`);
    if (c.qty + qty > s.per) {
      throw new WmsError(409, 'OVER_CAPACITY', `В ${addr} помещается ещё ${s.per - c.qty} шт`, { free: s.per - c.qty });
    }
    let ref = null;
    if (receiptId != null) {
      const r = q.receipt.get(receiptId);
      if (!r) throw new WmsError(404, 'NO_RECEIPT', 'Строка поставки не найдена');
      if (r.art !== art) throw new WmsError(409, 'WRONG_ITEM', `По этой строке поставки ожидается ${r.art}`);
      if (r.done || r.placed + qty > r.qty) {
        throw new WmsError(409, 'OVER_RECEIPT', `По строке осталось разместить ${r.qty - r.placed} шт`);
      }
      db.prepare('UPDATE receipt SET placed = placed + ?, done = (placed + ? >= qty) WHERE id = ?').run(qty, qty, r.id);
      ref = r.doc;
    }
    q.setCell.run(art, c.qty + qty, addr);
    if (!silent) log('Размещение', addr, art, qty, user, ref);
    bump();
    return { cell: { addr, sku: art, qty: c.qty + qty, blocked: 0 } };
  }

  function pick({ addr, art, qty, orderId }, user, silent) {
    qty = posInt(qty, 'Количество');
    const c = needCell(addr);
    if (c.blocked) throw new WmsError(409, 'CELL_BLOCKED', `Ячейка ${addr} заблокирована`);
    if (c.sku !== art) {
      throw new WmsError(409, 'WRONG_ITEM', c.sku ? `В ячейке ${addr} лежит ${c.sku}, а не ${art}` : `Ячейка ${addr} пуста`);
    }
    if (qty > c.qty) throw new WmsError(409, 'INSUFFICIENT', `В ${addr} только ${c.qty} шт`, { available: c.qty });
    let ref = null, orderDone = null;
    if (orderId != null) {
      const o = q.order.get(orderId);
      if (!o) throw new WmsError(404, 'NO_ORDER', 'Заказ не найден');
      if (o.done) throw new WmsError(409, 'ORDER_DONE', 'Заказ уже закрыт');
      const lines = q.lines.all(o.id).filter((l) => l.art === art && l.picked < l.qty);
      const need = lines.reduce((n, l) => n + l.qty - l.picked, 0);
      if (qty > need) throw new WmsError(409, 'OVER_ORDER', `По заказу осталось взять ${need} шт ${art}`, { remaining: need });
      let left = qty;
      for (const l of lines) {
        const t = Math.min(left, l.qty - l.picked);
        db.prepare('UPDATE order_line SET picked = picked + ? WHERE id = ?').run(t, l.id);
        left -= t;
        if (!left) break;
      }
      orderDone = q.lines.all(o.id).every((l) => l.picked >= l.qty);
      if (orderDone) db.prepare('UPDATE orders SET done = 1 WHERE id = ?').run(o.id);
      ref = o.number;
    }
    const nq = c.qty - qty;
    q.setCell.run(nq ? art : null, nq, addr);
    if (!silent) log('Отбор', addr, art, -qty, user, ref);
    if (orderDone) log('Заказ собран', null, null, null, user, ref);
    bump();
    return { cell: { addr, sku: nq ? art : null, qty: nq, blocked: 0 }, orderDone };
  }

  function move({ from, to, qty }, user) {
    qty = posInt(qty, 'Количество');
    const a = needCell(from);
    if (!a.sku) throw new WmsError(409, 'WRONG_ITEM', `Ячейка ${from} пуста`);
    const art = a.sku;
    if (from === to) throw new WmsError(400, 'SAME_CELL', 'Ячейки совпадают');
    pick({ addr: from, art, qty }, user, true);
    put({ addr: to, art, qty }, user, true);
    log('Перемещение', `${from} → ${to}`, art, qty, user, null);
    return { from: q.cell.get(from), to: q.cell.get(to) };
  }

  function count({ addr, qty }, user) {
    const c = needCell(addr);
    const n = Number(qty);
    if (!c.sku) throw new WmsError(409, 'CELL_EMPTY', 'В ячейке нет товара для пересчёта');
    const s = needSku(c.sku);
    if (!Number.isInteger(n) || n < 0 || n > s.per) throw new WmsError(400, 'BAD_QTY', `Количество должно быть от 0 до ${s.per}`);
    q.setCell.run(n ? c.sku : null, n, addr);
    log('Пересчёт', addr, c.sku, n - c.qty, user, null);
    bump();
    return { cell: { addr, sku: n ? c.sku : null, qty: n, blocked: c.blocked } };
  }

  function setBlocked({ addr, blocked }, user) {
    const c = needCell(addr);
    const b = blocked ? 1 : 0;
    if (c.blocked !== b) {
      q.setBlocked.run(b, addr);
      log(b ? 'Блокировка' : 'Разблокировка', addr, c.sku, 0, user, null);
      bump();
    }
    return { cell: { ...c, blocked: b } };
  }

  // ---------- проведение плана целиком (веб) ----------
  function confirmPutaway(rid, user) {
    const p = planPutaway(rid);
    for (const x of p.plan) put({ addr: x.addr, art: x.art, qty: x.qty, receiptId: rid }, user);
    if (p.left > 0) log('Нет места, остаток в буфере', null, p.receipt.art, p.left, user, p.receipt.doc);
    return { placed: p.plan.reduce((n, x) => n + x.qty, 0), left: p.left };
  }

  function confirmPick(oid, user) {
    const p = planPick(oid);
    for (const x of p.plan) pick({ addr: x.addr, art: x.art, qty: x.qty, orderId: oid }, user);
    if (q.order.get(oid).done === 0) closeOrder(oid, user);
    return { picked: p.plan.reduce((n, x) => n + x.qty, 0), short: p.short };
  }

  function closeOrder(oid, user) {
    const o = q.order.get(oid);
    if (!o) throw new WmsError(404, 'NO_ORDER', 'Заказ не найден');
    if (o.done) throw new WmsError(409, 'ORDER_DONE', 'Заказ уже закрыт');
    for (const l of q.lines.all(oid)) {
      if (l.picked < l.qty) log('Недостача', null, l.art, -(l.qty - l.picked), user, o.number);
    }
    db.prepare('UPDATE orders SET done = 1 WHERE id = ?').run(oid);
    log('Заказ закрыт', null, null, null, user, o.number);
    bump();
    return { closed: true };
  }

  // ---------- чтение ----------
  function state() {
    const cells = {};
    for (const r of db.prepare('SELECT addr, sku, qty, blocked FROM cell WHERE sku IS NOT NULL OR blocked = 1').all()) {
      if (L.meta.has(r.addr)) cells[r.addr] = [r.sku, r.qty, r.blocked];
    }
    const receipts = db.prepare(`SELECT id, doc, gate, art, qty, placed, done FROM receipt
      WHERE done = 0 OR id IN (SELECT id FROM receipt WHERE done = 1 ORDER BY id DESC LIMIT 10) ORDER BY done, id`).all();
    const orders = db.prepare(`SELECT id, number, dealer, due, done FROM orders
      WHERE done = 0 OR id IN (SELECT id FROM orders WHERE done = 1 ORDER BY id DESC LIMIT 10)
      ORDER BY done, COALESCE(NULLIF(due, ''), '99:99'), id`).all();
    for (const o of orders) o.lines = db.prepare('SELECT id, art, qty, picked FROM order_line WHERE order_id = ? ORDER BY id').all(o.id);
    return {
      rev: rev(),
      cells,
      skus: db.prepare('SELECT art, name, zone, per, home FROM sku ORDER BY zone, art').all()
        .map((s) => { let h = []; try { h = JSON.parse(s.home || '[]'); } catch (e) { h = []; } return { ...s, home: h }; }),
      receipts,
      orders,
      log: db.prepare('SELECT ts, op, addr, art, qty, user, ref FROM oplog ORDER BY id DESC LIMIT 100').all(),
      demo: !!opts.demo,
    };
  }

  const tx = (fn) => db.transaction(fn);
  return {
    rev, bump, log, state, planPutaway, planPick,
    put: tx(put), pick: tx(pick), move: tx(move), count: tx(count), setBlocked: tx(setBlocked),
    confirmPutaway: tx(confirmPutaway), confirmPick: tx(confirmPick), closeOrder: tx(closeOrder),
  };
}

module.exports = { createWarehouse, WmsError };
