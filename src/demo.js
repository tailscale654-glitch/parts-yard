'use strict';
const { now } = require('./db');

const SKUS = [
  ['FO-15208', 'Фильтр масляный', 'A', 40], ['FA-16546', 'Фильтр воздушный', 'A', 20],
  ['FC-27277', 'Фильтр салона', 'A', 30], ['BP-41060', 'Колодки тормозные передние', 'A', 16],
  ['BP-44060', 'Колодки тормозные задние', 'A', 16], ['SP-22401', 'Свеча зажигания', 'A', 60],
  ['WB-28890', 'Щётка стеклоочистителя 600 мм', 'A', 30], ['LB-26261', 'Лампа H7', 'A', 80],
  ['OL-5W30', 'Масло моторное 5W-30, 4 л', 'A', 12],
  ['BD-40206', 'Диск тормозной передний', 'B', 6], ['SA-54302', 'Амортизатор передний', 'B', 4],
  ['TR-48520', 'Наконечник рулевой тяги', 'B', 20], ['BJ-40160', 'Шаровая опора', 'B', 20],
  ['TB-13028', 'Комплект ремня ГРМ', 'B', 10], ['WP-21010', 'Помпа водяная', 'B', 8],
  ['CL-30100', 'Комплект сцепления', 'B', 4], ['ST-54618', 'Стойка стабилизатора', 'B', 24],
  ['HB-40202', 'Подшипник ступицы', 'B', 12],
  ['SN-23731', 'Датчик ABS', 'C', 20], ['IG-22448', 'Катушка зажигания', 'C', 16],
  ['TS-22630', 'Датчик температуры', 'C', 40], ['MR-26010', 'Зеркало наружное левое', 'C', 4],
  ['HL-26060', 'Фара левая', 'C', 2], ['TL-26550', 'Фонарь задний правый', 'C', 3],
  ['AC-92600', 'Компрессор кондиционера', 'C', 2], ['GN-23100', 'Генератор', 'C', 2],
  ['SR-23300', 'Стартер', 'C', 3],
  ['BM-62022', 'Бампер передний', 'D', 6], ['BM-85022', 'Бампер задний', 'D', 6],
  ['HD-65100', 'Капот', 'D', 4], ['DR-80100', 'Дверь передняя левая', 'D', 3],
  ['RD-21400', 'Радиатор охлаждения', 'D', 10], ['BT-24410', 'Аккумулятор 60 А·ч', 'D', 24],
  ['WH-40300', 'Диск колёсный R16', 'D', 16], ['WS-72700', 'Стекло лобовое', 'D', 8],
];

function rng(seed) {
  let s = seed;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedDemo(db, L) {
  db.transaction(() => {
    for (const t of ['order_line', 'orders', 'receipt', 'oplog', 'client_ops']) db.exec(`DELETE FROM ${t}`);
    db.exec('UPDATE cell SET sku = NULL, qty = 0, blocked = 0');
    db.exec('DELETE FROM sku');
    const insSku = db.prepare('INSERT INTO sku(art, name, zone, per) VALUES (?,?,?,?)');
    for (const s of SKUS) insSku.run(...s);
    const R = rng(7);
    const setCell = db.prepare('UPDATE cell SET sku = ?, qty = ? WHERE addr = ?');
    const block = db.prepare('UPDATE cell SET blocked = 1 WHERE addr = ?');
    for (const addr of [...L.meta.keys()].sort()) {
      const zs = SKUS.filter((s) => s[2] === L.meta.get(addr).zone);
      const p = R();
      if (p < 0.012) block.run(addr);
      else if (p < 0.7 && zs.length) {
        const s = zs[Math.floor(R() * zs.length)];
        setCell.run(s[0], 1 + Math.floor(R() * s[3]), addr);
      }
    }
    const insR = db.prepare("INSERT INTO receipt(doc, gate, art, qty, created) VALUES ('ПТ-10412', '2', ?, ?, ?)");
    for (const [art, qty] of [['FO-15208', 120], ['BP-41060', 40], ['SA-54302', 10], ['IG-22448', 12], ['BM-62022', 6], ['SP-22401', 150]]) {
      insR.run(art, qty, now());
    }
    const orders = [
      ['ЗК-24117', 'Дилерский центр «Север»', '12:30', [['FO-15208', 18], ['BP-41060', 6], ['WB-28890', 10], ['SA-54302', 2], ['SN-23731', 3]]],
      ['ЗК-24121', 'Дилерский центр «Восток»', '15:00', [['BD-40206', 4], ['TB-13028', 2], ['OL-5W30', 12], ['RD-21400', 1], ['LB-26261', 20]]],
      ['ЗК-24125', 'Дилерский центр «Запад»', '17:30', [['BT-24410', 6], ['BM-85022', 1], ['TR-48520', 4], ['FC-27277', 15]]],
    ];
    const insO = db.prepare('INSERT INTO orders(number, dealer, due, created) VALUES (?,?,?,?)');
    const insL = db.prepare('INSERT INTO order_line(order_id, art, qty) VALUES (?,?,?)');
    for (const [number, dealer, due, lines] of orders) {
      const oid = insO.run(number, dealer, due, now()).lastInsertRowid;
      for (const [art, qty] of lines) insL.run(oid, art, qty);
    }
    db.prepare("INSERT INTO oplog(ts, op, user) VALUES (?, 'Демо-данные загружены', 'система')").run(now());
    db.exec("UPDATE meta SET v = v + 1 WHERE k = 'rev'");
  })();
}

module.exports = { seedDemo };
