'use strict';
// Демо-данные: каталог, остатки, документы и история операций за 30 дней,
// чтобы дашборды и отчёты сразу показывали что-то осмысленное.
const crypto = require('crypto');
const { hashPassword } = require('./auth');
const { linkOrderDealers } = require('./dealers');

const SKUS = [
  ['FO-15208', 'Фильтр масляный', 'A', 40, 60], ['FA-16546', 'Фильтр воздушный', 'A', 20, 30],
  ['FC-27277', 'Фильтр салона', 'A', 30, 40], ['BP-41060', 'Колодки тормозные передние', 'A', 16, 40],
  ['BP-44060', 'Колодки тормозные задние', 'A', 16, 24], ['SP-22401', 'Свеча зажигания', 'A', 60, 120],
  ['WB-28890', 'Щётка стеклоочистителя 600 мм', 'A', 30, 30], ['LB-26261', 'Лампа H7', 'A', 80, 100],
  ['OL-5W30', 'Масло моторное 5W-30, 4 л', 'A', 12, 48],
  ['BD-40206', 'Диск тормозной передний', 'B', 6, 12], ['SA-54302', 'Амортизатор передний', 'B', 4, 12],
  ['TR-48520', 'Наконечник рулевой тяги', 'B', 20, 16], ['BJ-40160', 'Шаровая опора', 'B', 20, 16],
  ['TB-13028', 'Комплект ремня ГРМ', 'B', 10, 10], ['WP-21010', 'Помпа водяная', 'B', 8, 6],
  ['CL-30100', 'Комплект сцепления', 'B', 4, 4], ['ST-54618', 'Стойка стабилизатора', 'B', 24, 20],
  ['HB-40202', 'Подшипник ступицы', 'B', 12, 10],
  ['SN-23731', 'Датчик ABS', 'C', 20, 6], ['IG-22448', 'Катушка зажигания', 'C', 16, 8],
  ['TS-22630', 'Датчик температуры', 'C', 40, 0], ['MR-26010', 'Зеркало наружное левое', 'C', 4, 2],
  ['HL-26060', 'Фара левая', 'C', 2, 2], ['TL-26550', 'Фонарь задний правый', 'C', 3, 2],
  ['AC-92600', 'Компрессор кондиционера', 'C', 2, 1], ['GN-23100', 'Генератор', 'C', 2, 2],
  ['SR-23300', 'Стартер', 'C', 3, 2],
  ['BM-62022', 'Бампер передний', 'D', 6, 4], ['BM-85022', 'Бампер задний', 'D', 6, 4],
  ['HD-65100', 'Капот', 'D', 4, 2], ['DR-80100', 'Дверь передняя левая', 'D', 3, 0],
  ['RD-21400', 'Радиатор охлаждения', 'D', 10, 6], ['BT-24410', 'Аккумулятор 60 А·ч', 'D', 24, 30],
  ['WH-40300', 'Диск колёсный R16', 'D', 16, 16], ['WS-72700', 'Стекло лобовое', 'D', 8, 4],
];
// вес = насколько часто артикул уходит в заказы (для правдоподобного ABC)
const WEIGHT = { A: 10, B: 4, C: 1.2, D: 1.5 };
const STAFF = [
  ['karimov', 'Каримов Азиз'], ['petrova', 'Петрова Елена'], ['sidorov', 'Сидоров Игорь'], ['yusupova', 'Юсупова Дилноза'],
];
const DEALERS = ['Дилерский центр «Север»', 'Дилерский центр «Восток»', 'Дилерский центр «Запад»', 'Дилерский центр «Юг»',
  'Сервис «Чиланзар»', 'Сервис «Юнусабад»', 'Дилерский центр «Самарканд»'];

function rng(seed) {
  let s = seed;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const p2 = (n) => String(n).padStart(2, '0');
function stamp(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

function seedDemo(db, L) {
  const R = rng(7);
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const weighted = (items, w) => {
    const total = items.reduce((n, x) => n + w(x), 0);
    let r = R() * total;
    for (const x of items) { r -= w(x); if (r <= 0) return x; }
    return items[items.length - 1];
  };
  db.transaction(() => {
    for (const t of ['inv_line', 'inv_task', 'order_line', 'orders', 'receipt', 'oplog', 'client_ops']) db.exec(`DELETE FROM ${t}`);
    db.exec('UPDATE cell SET sku = NULL, qty = 0, blocked = 0');
    db.exec('DELETE FROM sku');
    // свои демо-дилеры пересоздаются из заказов ниже; дилеры из Carsale остаются
    db.exec("DELETE FROM dealer WHERE source = 'local'");
    const zones = new Set(L.zones.map((z) => z.id));
    const skus = SKUS.filter((s) => zones.has(s[2]));
    const insSku = db.prepare('INSERT INTO sku(art, name, zone, per, min_qty) VALUES (?,?,?,?,?)');
    for (const s of skus) insSku.run(...s);
    // «узкое место» для демо: этого артикула мало, он попадёт в «ниже минимума»
    const scarce = new Set(['BP-41060', 'OL-5W30', 'SA-54302']);

    // демо-сотрудники с неизвестными случайными паролями (администратор может их сбросить)
    const insUser = db.prepare(`INSERT OR IGNORE INTO users(username, pass, full_name, role, created) VALUES (?,?,?,'storekeeper',?)`);
    for (const [login, name] of STAFF) insUser.run(login, hashPassword(crypto.randomBytes(12).toString('hex')), name, stamp(new Date()));
    const staff = STAFF.map((s) => s[0]);

    // остатки
    const setCell = db.prepare('UPDATE cell SET sku = ?, qty = ? WHERE addr = ?');
    const block = db.prepare('UPDATE cell SET blocked = 1 WHERE addr = ?');
    const byArt = new Map();
    for (const addr of [...L.meta.keys()].sort()) {
      const zs = skus.filter((s) => s[2] === L.meta.get(addr).zone && !scarce.has(s[0]));
      const p = R();
      if (p < 0.012) block.run(addr);
      else if (p < 0.68 && zs.length) {
        const s = pick(zs);
        setCell.run(s[0], 1 + Math.floor(R() * s[3]), addr);
        if (!byArt.has(s[0])) byArt.set(s[0], []);
        byArt.get(s[0]).push(addr);
      }
    }
    for (const art of scarce) {
      const s = skus.find((x) => x[0] === art);
      if (!s) continue;
      const empty = db.prepare('SELECT addr FROM cell WHERE sku IS NULL AND blocked = 0').pluck().all()
        .filter((a) => L.meta.has(a) && L.meta.get(a).zone === s[2]).slice(-2);
      for (const a of empty) setCell.run(art, Math.max(1, Math.floor(s[3] / 4)), a);
      byArt.set(art, empty);
    }

    // история за 30 дней
    const log = db.prepare('INSERT INTO oplog(ts, op, kind, addr, art, qty, user, ref) VALUES (?,?,?,?,?,?,?,?)');
    const insO = db.prepare('INSERT INTO orders(number, dealer, due, done, created) VALUES (?,?,?,?,?)');
    const insL = db.prepare('INSERT INTO order_line(order_id, art, qty, picked) VALUES (?,?,?,?)');
    const insR = db.prepare('INSERT INTO receipt(doc, gate, art, qty, placed, done, created) VALUES (?,?,?,?,?,?,?)');
    const artsWithCells = skus.filter((s) => byArt.get(s[0]) && byArt.get(s[0]).length);
    let orderNo = 23400, recNo = 10300;
    for (let back = 30; back >= 1; back--) {
      const day = new Date();
      day.setDate(day.getDate() - back);
      const dow = day.getDay();
      const load = dow === 0 ? 0.25 : dow === 6 ? 0.55 : 0.85 + R() * 0.4;
      const at = (h0, h1) => { const d = new Date(day); d.setHours(h0 + Math.floor(R() * (h1 - h0)), Math.floor(R() * 60), Math.floor(R() * 60), 0); return d; };

      // приёмка: 1–2 поставки в день
      const nRec = dow === 0 ? 0 : 1 + (R() < 0.5 ? 1 : 0);
      for (let i = 0; i < nRec; i++) {
        const doc = `ПТ-${recNo++}`, created = at(8, 10), gate = String(1 + Math.floor(R() * 3));
        const lines = 3 + Math.floor(R() * 5);
        for (let j = 0; j < lines; j++) {
          const s = weighted(artsWithCells, (x) => WEIGHT[x[2]] || 1);
          const qty = Math.max(2, Math.round(s[3] * (0.4 + R() * 1.6)));
          insR.run(doc, gate, s[0], qty, qty, 1, stamp(created));
          let left = qty;
          const user = pick(staff);
          while (left > 0) {
            const put = Math.min(left, Math.max(1, Math.round(s[3] * (0.3 + R() * 0.7))));
            log.run(stamp(at(9, 13)), 'Размещение', 'put', pick(byArt.get(s[0])), s[0], put, user, doc);
            left -= put;
          }
        }
        log.run(stamp(created), 'Поставка создана', 'doc', null, null, lines, 'karimov', doc);
      }

      // заказы дилеров
      const nOrd = Math.round((4 + R() * 4) * load);
      for (let i = 0; i < nOrd; i++) {
        const number = `ЗК-${orderNo++}`, created = at(7, 11), dealer = pick(DEALERS);
        const due = `${p2(12 + Math.floor(R() * 6))}:${R() < 0.5 ? '00' : '30'}`;
        const oid = insO.run(number, dealer, due, 1, stamp(created)).lastInsertRowid;
        const lines = 2 + Math.floor(R() * 5);
        const user = pick(staff);
        let lastTs = created;
        const used = new Set();
        for (let j = 0; j < lines; j++) {
          const s = weighted(artsWithCells, (x) => WEIGHT[x[2]] || 1);
          if (used.has(s[0])) continue;
          used.add(s[0]);
          const qty = s[2] === 'A' ? 2 + Math.floor(R() * 14) : 1 + Math.floor(R() * 4);
          const short = R() < 0.04 ? 1 : 0;
          insL.run(oid, s[0], qty, qty - short);
          lastTs = at(11, 18);
          log.run(stamp(lastTs), 'Отбор', 'pick', pick(byArt.get(s[0])), s[0], -(qty - short), user, number);
          if (short) log.run(stamp(lastTs), 'Недостача', 'shortage', null, s[0], -short, user, number);
        }
        log.run(stamp(lastTs), 'Заказ собран', 'order', null, null, null, user, number);
      }

      // перемещения и пересчёты
      const nMove = Math.round(R() * 4 * load);
      for (let i = 0; i < nMove; i++) {
        const s = pick(artsWithCells), a = pick(byArt.get(s[0])), b = pick(byArt.get(s[0]));
        log.run(stamp(at(13, 17)), 'Перемещение', 'move', `${a} → ${b}`, s[0], 1 + Math.floor(R() * 5), pick(staff), null);
      }
      const nCount = Math.round(R() * 6 * load);
      for (let i = 0; i < nCount; i++) {
        const s = pick(artsWithCells);
        log.run(stamp(at(15, 18)), 'Пересчёт', 'count', pick(byArt.get(s[0])), s[0], Math.floor(R() * 5) - 2, pick(staff), null);
      }
    }

    // сегодня: часть уже сделана, остальное ждёт
    const today = new Date();
    const nowH = today.getHours();
    const earlier = (minutesAgo) => { const d = new Date(Date.now() - minutesAgo * 60000); return stamp(d); };
    if (nowH >= 9) {
      for (let i = 0; i < 18; i++) {
        const s = weighted(artsWithCells, (x) => WEIGHT[x[2]] || 1);
        log.run(earlier(10 + Math.floor(R() * Math.min(480, (nowH - 8) * 60))), 'Отбор', 'pick', pick(byArt.get(s[0])), s[0], -(1 + Math.floor(R() * 6)), pick(staff), `ЗК-${orderNo - 1 - Math.floor(R() * 3)}`);
      }
      for (let i = 0; i < 7; i++) {
        const s = pick(artsWithCells);
        log.run(earlier(20 + Math.floor(R() * 200)), 'Размещение', 'put', pick(byArt.get(s[0])), s[0], 2 + Math.floor(R() * 10), pick(staff), `ПТ-${recNo - 1}`);
      }
    }

    // открытые документы
    const nowStr = stamp(new Date());
    for (const [art, qty] of [['FO-15208', 120], ['BP-41060', 40], ['SA-54302', 10], ['IG-22448', 12], ['BM-62022', 6], ['SP-22401', 150]]) {
      if (skus.find((s) => s[0] === art)) insR.run('ПТ-' + recNo, '2', art, qty, 0, 0, nowStr);
    }
    const open = [
      [`ЗК-${orderNo++}`, 'Дилерский центр «Север»', '12:30', [['FO-15208', 18], ['BP-41060', 6], ['WB-28890', 10], ['SA-54302', 2], ['SN-23731', 3]]],
      [`ЗК-${orderNo++}`, 'Дилерский центр «Восток»', '15:00', [['BD-40206', 4], ['TB-13028', 2], ['OL-5W30', 12], ['RD-21400', 1], ['LB-26261', 20]]],
      [`ЗК-${orderNo++}`, 'Дилерский центр «Запад»', '17:30', [['BT-24410', 6], ['BM-85022', 1], ['TR-48520', 4], ['FC-27277', 15]]],
    ];
    for (const [number, dealer, due, lines] of open) {
      const oid = insO.run(number, dealer, due, 0, nowStr).lastInsertRowid;
      for (const [art, qty] of lines) if (skus.find((s) => s[0] === art)) insL.run(oid, art, qty, 0);
    }

    // закрытая инвентаризация с расхождениями
    const rowCells = [...L.meta.entries()].filter(([, m]) => m.zone === (zones.has('C') ? 'C' : L.zones[0].id) && m.row === 2).map(([a]) => a).slice(0, 36);
    if (rowCells.length) {
      const t = new Date(); t.setDate(t.getDate() - 3); t.setHours(16, 10, 0, 0);
      const tid = db.prepare("INSERT INTO inv_task(name, scope, status, created_by, created, closed_by, closed_at) VALUES (?,?, 'closed', 'karimov', ?, 'karimov', ?)")
        .run(`Пересчёт ряда ${rowCells[0].slice(0, 4)}`, JSON.stringify({ rows: [rowCells[0].slice(0, 4)] }), stamp(t), stamp(new Date(t.getTime() + 3600000))).lastInsertRowid;
      const getCell = db.prepare('SELECT sku, qty FROM cell WHERE addr = ?');
      const insLine = db.prepare('INSERT INTO inv_line(task_id, addr, art_expected, qty_expected, qty_counted, counted_by, counted_at) VALUES (?,?,?,?,?,?,?)');
      rowCells.forEach((a, i) => {
        const c = getCell.get(a);
        const exp = c.sku ? c.qty + (i % 9 === 3 ? 2 : i % 11 === 5 ? -1 : 0) : 0;
        insLine.run(tid, a, c.sku, exp, c.sku ? c.qty : 0, pick(staff), stamp(new Date(t.getTime() + i * 60000)));
      });
    }
    linkOrderDealers(db);
    db.prepare("INSERT INTO oplog(ts, op, kind, user) VALUES (?, 'Демо-данные загружены', 'system', 'система')").run(nowStr);
    db.exec("UPDATE meta SET v = v + 1 WHERE k = 'rev'");
  })();
}

module.exports = { seedDemo };
