'use strict';
// Загрузка «ячеек склада» из Excel: артикул → ячейка(и). По файлу строится топология
// (зоны со сквозной нумерацией стеллажей: A-08-01-02 = зона A, стеллаж 08, ярус 01, ячейка 02)
// и у артикулов появляются закреплённые ячейки (sku.home), куда система размещает их в первую очередь.
//
// Как пишут адреса на складе и что с этим делаем:
//   B-01-03-02\03        ячейки 02 и 03 одного яруса              → B-01-03-02, B-01-03-03
//   A-01-01-01\03        с 01 по 03 (два номера по возрастанию)   → ячейки 01, 02, 03
//   B-12\07-01-01, …\03\04  перечисление                          → только названные номера
//   A-03\04-01\02-01\03  несколько стеллажей/ярусов/ячеек          → все сочетания
//   A-016-01-01          лишние нули                               → A-16-01-01
//   D/Z-01-02-01, A/C-…  зона с косой чертой                       → зона DZ, AC (название «D/Z», «A/C»)
//   кириллица А/В/С/Е/Н… вместо латиницы                           → латиница
const { getSetting, setSetting, now, audit, syncCells } = require('./db');
const { validateZones, applyLayout, RS, RH } = require('./layout');

const pad = (n) => String(n).padStart(2, '0');
const CYR = { А: 'A', В: 'B', С: 'C', Е: 'E', Н: 'H', К: 'K', М: 'M', О: 'O', Р: 'P', Т: 'T', Х: 'X', У: 'Y' };
const clean = (v, max = 200) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);

function parseCell(raw) {
  const src = clean(raw, 80);
  if (!src) return { error: 'ячейка не указана' };
  const s = src.toUpperCase().replace(/[АВСЕНКМОРТХУ]/g, (c) => CYR[c]).replace(/\s+/g, '').replace(/[–—]/g, '-');
  const parts = s.split('-');
  if (parts.length !== 4) return { error: `не похоже на адрес ЗОНА-СТЕЛЛАЖ-ЯРУС-ЯЧЕЙКА: «${src}»` };
  const zoneRaw = parts[0], zone = zoneRaw.replace(/[/\\]/g, '');
  if (!/^[A-Z0-9]{1,3}$/.test(zone)) return { error: `непонятная зона «${zoneRaw}» в «${src}»` };
  const nums = [];
  for (const [i, p] of parts.slice(1).entries()) {
    const list = p.split(/[\\/]/).filter((x) => x !== '');
    if (!list.length || !list.every((x) => /^\d{1,3}$/.test(x))) return { error: `${['стеллаж', 'ярус', 'ячейка'][i]} — не число в «${src}»` };
    let v = [...new Set(list.map(Number))];
    // «01\03» — с 01 по 03 (соседние номера), «12\07» и «01\03\04» — перечисление
    if (v.length === 2 && v[0] < v[1] && v[1] - v[0] <= 3) v = Array.from({ length: v[1] - v[0] + 1 }, (_, j) => v[0] + j);
    if (v.some((n) => n < 1)) return { error: `номер 0 в «${src}»` };
    nums.push(v);
  }
  const [R, T, C] = nums;
  const list = [];
  for (const r of R) for (const t of T) for (const c of C) list.push(`${zone}-${pad(r)}-${pad(t)}-${pad(c)}`);
  if (list.length > 24) return { error: `слишком много ячеек (${list.length}) в «${src}»` };
  return { zone, zoneTitle: zoneRaw.includes('/') || zoneRaw.includes('\\') ? zoneRaw.replace(/\\/g, '/') : zone, racks: R, tiers: T, cells: C, list, src };
}

// Строки файла → артикулы с ячейками и список проблем.
// rows: [{art, name, cell}] или массивы [№, артикул, название RU, название EN, ячейка] как в Excel
function parseRows(rows) {
  const items = [], problems = [], seen = new Map();
  rows.forEach((r, i) => {
    const row = Array.isArray(r) ? { art: r[1], name: r[2] || r[3], cell: r[4] } : r;
    const art = clean(row.art, 40), name = clean(row.name, 120), cellRaw = clean(row.cell, 80);
    if (!art && !cellRaw) return;
    if (!art) { problems.push({ line: i + 1, art: '', cell: cellRaw, error: 'нет артикула' }); return; }
    const p = parseCell(cellRaw);
    if (p.error) { problems.push({ line: i + 1, art, cell: cellRaw, error: p.error }); return; }
    if (seen.has(art)) {
      // тот же артикул ещё раз — добавляем ячейки к уже найденным
      const it = seen.get(art);
      for (const a of p.list) if (!it.cells.includes(a)) it.cells.push(a);
      return;
    }
    const it = { line: i + 1, art, name, cells: [...p.list], zone: p.zone, src: cellRaw };
    seen.set(art, it);
    items.push(it);
  });
  return { items, problems };
}

// Топология по найденным ячейкам: для каждой зоны — диапазон стеллажей, максимум ярусов и ячеек.
// Стеллажи раскладываются на схеме по 10 в ряд, зоны — в две колонки.
function layoutFromItems(items, titles = {}) {
  const Z = new Map();
  for (const it of items) {
    for (const a of it.cells) {
      const [z, r, t, c] = a.split('-');
      const e = Z.get(z) || { id: z, rmin: Infinity, rmax: 0, tiers: 0, cells: 0 };
      e.rmin = Math.min(e.rmin, +r); e.rmax = Math.max(e.rmax, +r); e.tiers = Math.max(e.tiers, +t); e.cells = Math.max(e.cells, +c);
      Z.set(z, e);
    }
  }
  const order = [...Z.values()].sort((a, b) => (b.rmax - b.rmin) - (a.rmax - a.rmin) || a.id.localeCompare(b.id));
  const cols = [{ x: 40, y: 40, w: 420 }, { x: 510, y: 40, w: 420 }];
  const zones = [];
  for (const e of order) {
    const count = e.rmax - e.rmin + 1;
    // до 15 стеллажей — один ряд на схеме, больше — поровну в несколько рядов
    const rows = Math.ceil(count / 15);
    const perRow = Math.ceil(count / rows);
    const rw = 26;
    const col = cols[0].y <= cols[1].y ? cols[0] : cols[1];
    const h = (rows - 1) * RS + RH + 58;
    zones.push({ id: e.id, title: `Зона ${titles[e.id] || e.id}`, sub: `стеллажи ${pad(e.rmin)}–${pad(e.rmax)}`, x: col.x + 12, y: col.y + 20,
      rows, racks: perRow, rw, tiers: Math.min(12, e.tiers), cells: Math.min(12, e.cells), prefer: 'low', scheme: 'racks', start: e.rmin });
    col.y += h;
  }
  return zones;
}

// Таблица из Excel/CSV → строки {art, name, cell}: ищем строку заголовков («Артикул», «Ячейка», «Номенклатура»)
function rowsFromTable(table) {
  const norm = (v) => String(v ?? '').toLowerCase().trim();
  let hi = -1, col = null;
  for (let i = 0; i < Math.min(15, table.length); i++) {
    const r = (table[i] || []).map(norm);
    const art = r.findIndex((x) => /^(артикул|код|code|part ?(no|number))/.test(x));
    const cell = r.findIndex((x) => /ячейк|адрес|cell|location|место/.test(x));
    if (art >= 0 && cell >= 0) {
      let name = r.findIndex((x) => /номенклатура.*ru|наименование|название/.test(x));
      if (name < 0) name = r.findIndex((x) => /номенклатура|name/.test(x));
      hi = i; col = { art, cell, name }; break;
    }
  }
  // без заголовков: как в шаблоне склада — №, артикул, название RU, название EN, ячейка
  if (!col) col = (table[0] || []).length >= 5 ? { art: 1, name: 2, cell: 4 } : { art: 0, name: 1, cell: (table[0] || []).length - 1 };
  return table.slice(hi + 1).map((r) => ({ art: (r || [])[col.art], name: col.name >= 0 ? (r || [])[col.name] : '', cell: (r || [])[col.cell] }))
    .filter((r) => String(r.art ?? '').trim() || String(r.cell ?? '').trim());
}

function analyze(db, L, rows, layoutImpact) {
  const { items, problems } = parseRows(rows);
  const titles = {};
  for (const r of rows) { const p = parseCell(Array.isArray(r) ? r[4] : r.cell); if (!p.error && p.zoneTitle !== p.zone) titles[p.zone] = p.zoneTitle; }
  const zones = items.length ? validateZones(layoutFromItems(items, titles)) : { zones: [], warnings: [] };
  const known = new Set(db.prepare('SELECT art FROM sku').pluck().all());
  const byCell = new Map();
  for (const it of items) for (const a of it.cells) byCell.set(a, (byCell.get(a) || 0) + 1);
  const cellCount = zones.zones.reduce((n, z) => n + z.rows * z.racks * z.tiers * z.cells, 0);
  return {
    items, problems, zones: zones.zones, warnings: zones.warnings,
    impact: zones.zones.length ? layoutImpact(zones.zones) : null,
    stats: {
      rows: items.length + problems.length, ok: items.length, problems: problems.length,
      cells: byCell.size, shared: [...byCell.values()].filter((n) => n > 1).length,
      multi: items.filter((i) => i.cells.length > 1).length,
      newSkus: items.filter((i) => !known.has(i.art)).length, layoutCells: cellCount,
    },
  };
}

// Применить: топология из файла + закреплённые ячейки у артикулов.
// clearCells — освободить все ячейки (для демо-данных), иначе ячейки с товаром не должны пропасть.
function apply(db, L, a, { user, clearCells = false } = {}) {
  if (!a.items.length) throw new Error('В файле нет ни одной строки с понятной ячейкой');
  const stamp = now();
  const per = Number(getSetting(db, 'carsale_default_per', '20')) || 20;
  return db.transaction(() => {
    if (clearCells) {
      db.exec("UPDATE cell SET sku = NULL, qty = 0, blocked = 0; UPDATE inv_task SET status = 'cancelled', closed_at = datetime('now','localtime') WHERE status = 'open';");
    } else if (a.impact && a.impact.lost.length) {
      throw new Error(`Исчезнут ${a.impact.lost.length} ячеек с товаром (например, ${a.impact.lost[0].addr}). Освободите их или включите «Освободить все ячейки» (в консоли — --clear-cells).`);
    }
    // артикулы из каталога в зонах, которых больше не будет, переводим в зону их ячейки или в первую зону
    const ids = new Set(a.zones.map((z) => z.id));
    db.prepare(`UPDATE sku SET zone = ? WHERE zone NOT IN (${a.zones.map(() => '?').join(',')})`).run(a.zones[0].id, ...a.zones.map((z) => z.id));
    setSetting(db, 'layout', JSON.stringify(a.zones));
    applyLayout(L, a.zones);
    syncCells(db, L);
    const keep = new Set(L.meta.keys());
    const del = db.prepare('DELETE FROM cell WHERE addr = ?');
    for (const x of db.prepare('SELECT addr FROM cell WHERE sku IS NULL AND blocked = 0').pluck().all()) if (!keep.has(x)) del.run(x);
    db.exec("UPDATE meta SET v = v + 1 WHERE k = 'layout_rev'");

    const get = db.prepare('SELECT art FROM sku WHERE art = ?');
    const upd = db.prepare('UPDATE sku SET home = ?, zone = ?, zone_manual = 1 WHERE art = ?');
    const ins = db.prepare(`INSERT INTO sku(art, name, zone, per, min_qty, source, home, zone_manual) VALUES (?, ?, ?, ?, 0, 'local', ?, 1)`);
    let added = 0, updated = 0;
    db.prepare('UPDATE sku SET home = NULL').run();
    for (const it of a.items) {
      const cells = it.cells.filter((x) => keep.has(x));
      const zone = ids.has(it.zone) ? it.zone : a.zones[0].id;
      if (get.get(it.art)) { upd.run(JSON.stringify(cells), zone, it.art); updated++; } else { ins.run(it.art, it.name || it.art, zone, per, JSON.stringify(cells)); added++; }
    }
    db.prepare("INSERT INTO oplog(ts, op, kind, qty, user, ref) VALUES (?, 'Ячейки склада загружены', 'system', ?, ?, ?)").run(stamp, a.items.length, user || 'импорт', `${a.stats.cells} ячеек`);
    db.exec("UPDATE meta SET v = v + 1 WHERE k = 'rev'");
    audit(db, user, 'Ячейки склада загружены из файла', { zones: a.zones.map((z) => z.id), cells: L.meta.size, skus: a.items.length, added, updated, problems: a.problems.length, clearCells });
    return { cells: L.meta.size, zones: a.zones.length, added, updated, skus: a.items.length, problems: a.problems.length };
  })();
}

// Закреплённые ячейки артикула (то, что лежит в sku.home)
function homeOf(s) { try { const v = JSON.parse(s.home || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }

module.exports = { parseCell, parseRows, rowsFromTable, layoutFromItems, analyze, apply, homeOf };
