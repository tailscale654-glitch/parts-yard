'use strict';
// Справочник дилеров — зеркало Carsale «Запчасти → Справочники → Дилеры»
// (метод /b/tmc_hybrid&get_tmc_dealer_list). Других дилеров в WarehouseOS нет:
// ни своих, ни из других разделов Carsale. Синхронизация добавляет, обновляет и удаляет.
// Заказ хранит ссылку на дилера (dealer_id) и его имя на момент заказа (dealer);
// если дилера удалили из справочника, у заказа остаётся имя, а ссылка обнуляется.
//
// Из строки Carsale берём только то, что нужно складу. В том же ответе Carsale отдаёт
// логины, пароли и ключи интеграций дилеров (faktura.uz и т. п.) — они НЕ сохраняются.
const { now } = require('./db');

const SOURCE = 'carsale';
const clean = (v, max = 200) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
// ключ для сравнения имён: без регистра, кавычек и лишних пробелов
const nameKey = (s) => clean(s, 200).toLowerCase().replace(/ё/g, 'е').replace(/[«»"'`„“”]/g, '').replace(/\s+/g, ' ').trim();
// «суть» названия: ещё и без организационно-правовой формы (ООО, OOO, ИП, СП, MCHJ, МЧЖ, Qk, LLC…) и дефисов
const LEGAL = /(^|\s)(ооо|ooo|ип|сп|чп|ао|мчж|mchj|mcj|qk|xk|llc|ltd)(?=\s|$)/g;
const coreKey = (s) => nameKey(s).replace(/[-–—.,]/g, ' ').replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();

const FIELDS = ['name', 'code', 'region', 'address', 'phone', 'inn'];
const LABEL = { code: 'код', region: 'регион', address: 'адрес', phone: 'телефон', inn: 'ИНН' };

function count(db) { return db.prepare('SELECT COUNT(*) FROM dealer').pluck().get(); }

// Поиск дилера по тексту: точное имя, код, затем «суть» названия (если она однозначна)
function findDealer(db, text) {
  const t = clean(text, 120);
  if (!t) return null;
  const all = db.prepare('SELECT * FROM dealer').all();
  const k = nameKey(t);
  let hit = all.filter((d) => d.name_key === k);
  if (!hit.length) hit = all.filter((d) => d.code && d.code.toLowerCase() === t.toLowerCase());
  if (!hit.length) { const c = coreKey(t); if (c) hit = all.filter((d) => coreKey(d.name) === c); }
  if (hit.length > 1) hit.sort((a, b) => b.active - a.active);
  return hit.length === 1 || (hit.length > 1 && hit[0].active !== hit[1].active) ? hit[0] : null;
}

// Дилер для нового заказа. Только из справочника; пока справочник пуст (Carsale не подключён
// или ещё не синхронизировался) — заказ принимается с именем без ссылки.
function resolveDealer(db, { id, name } = {}) {
  if (id != null && id !== '') {
    const d = db.prepare('SELECT * FROM dealer WHERE id = ?').get(Number(id));
    if (!d) return { error: 'Дилер не найден в справочнике — обновите список' };
    if (!d.active) return { error: `Дилер «${d.name}» неактивен в Carsale` };
    return { dealer: d };
  }
  const n = clean(name, 120);
  if (!n) return { error: 'Укажите дилера' };
  if (!count(db)) return { dealer: null, name: n };
  const d = findDealer(db, n);
  if (!d) return { error: `Дилера «${n}» нет в справочнике Carsale — выберите из списка` };
  if (!d.active) return { error: `Дилер «${d.name}» неактивен в Carsale` };
  return { dealer: d };
}

// Заказы без ссылки на дилера (старые данные, загрузка из CLI) — привязываем, если дилер однозначно находится
function linkOrderDealers(db) {
  const rows = db.prepare('SELECT id, dealer FROM orders WHERE dealer_id IS NULL').all();
  if (!rows.length || !count(db)) return 0;
  const set = db.prepare('UPDATE orders SET dealer_id = ? WHERE id = ?');
  const cache = new Map();
  let n = 0;
  for (const o of rows) {
    if (!cache.has(o.dealer)) cache.set(o.dealer, findDealer(db, o.dealer));
    const d = cache.get(o.dealer);
    if (d) { set.run(d.id, o.id); n++; }
  }
  return n;
}

function list(db) {
  return db.prepare(`SELECT d.*, COUNT(o.id) AS orders, COALESCE(SUM(CASE WHEN o.done = 0 THEN 1 ELSE 0 END), 0) AS open_orders,
      MAX(o.created) AS last_order
    FROM dealer d LEFT JOIN orders o ON o.dealer_id = d.id GROUP BY d.id ORDER BY d.active DESC, d.name`).all();
}

// Строка get_tmc_dealer_list → наш дилер (только безопасные поля)
function fromCarsale(r) {
  const state = clean(r.state, 4).toUpperCase();
  return {
    ext_id: clean(r.dealer_id ?? r.id, 40),
    name: clean(r.name, 120),
    code: clean(r.code, 40) || null,
    region: clean(r.region_name, 80) || null,
    address: clean(r.address, 200) || null,
    phone: clean(r.phone_number, 60) || null,
    inn: clean(r.company_inn ?? r.inn, 20) || null,
    active: state === 'A' || state === '' ? 1 : 0,
  };
}

// Сверка с Carsale: справочник становится точной копией. Пустой ответ ничего не меняет.
function applyCarsaleDealers(db, rows) {
  const stamp = now();
  const incoming = new Map();
  let skipped = 0;
  for (const r of rows) {
    const d = fromCarsale(r);
    if (!d.ext_id || !d.name) { skipped++; continue; }
    incoming.set(d.ext_id, d);
  }
  const stats = { received: rows.length, total: incoming.size, active: [...incoming.values()].filter((d) => d.active).length,
    added: 0, updated: 0, removed: 0, off: 0, on: 0, relinked: 0, skipped, changes: [], warnings: [] };
  const note = (kind, name, detail) => { if (stats.changes.length < 40) stats.changes.push(detail ? { kind, name, detail } : { kind, name }); };

  const known = db.prepare('SELECT * FROM dealer').all();
  if (!incoming.size) {
    // пустой ответ — скорее сбой или нет прав, а не «все дилеры закрылись»
    if (known.length) stats.warnings.push('Carsale вернул пустой список дилеров — справочник не менялся');
    return stats;
  }
  const byExt = new Map(known.filter((d) => d.source === SOURCE).map((d) => [d.ext_id, d]));

  const upd = db.prepare(`UPDATE dealer SET name = @name, name_key = @name_key, code = @code, region = @region, address = @address,
    phone = @phone, inn = @inn, active = @active, updated = @stamp, synced = @stamp WHERE id = @id`);
  const touch = db.prepare('UPDATE dealer SET synced = ? WHERE id = ?');
  const ins = db.prepare(`INSERT INTO dealer(name, name_key, code, region, address, phone, inn, source, ext_id, active, created, updated, synced)
    VALUES (@name, @name_key, @code, @region, @address, @phone, @inn, '${SOURCE}', @ext_id, @active, @stamp, @stamp, @stamp)`);
  const rename = db.prepare('UPDATE orders SET dealer = ? WHERE dealer_id = ?');

  db.transaction(() => {
    for (const d of incoming.values()) {
      const row = { ...d, name_key: nameKey(d.name), stamp };
      const old = byExt.get(d.ext_id);
      if (!old) { ins.run(row); stats.added++; note('add', row.name, [row.code, row.region].filter(Boolean).join(' · ')); continue; }
      const diff = FIELDS.filter((f) => (old[f] || null) !== (row[f] || null));
      if (!diff.length && old.active === row.active) { touch.run(stamp, old.id); continue; }
      upd.run({ ...row, id: old.id });
      if (old.name !== row.name) rename.run(row.name, old.id);
      if (old.active !== row.active) { if (row.active) { stats.on++; note('on', row.name); } else { stats.off++; note('off', row.name, 'неактивен в Carsale'); } }
      if (diff.length) { stats.updated++; note('upd', row.name, diff.includes('name') ? `было «${old.name}»` : diff.map((f) => LABEL[f]).join(', ')); }
    }
    // всех, кого нет в справочнике Carsale, удаляем; их заказы сохраняют имя дилера
    const unlink = db.prepare('UPDATE orders SET dealer_id = NULL WHERE dealer_id = ?');
    const del = db.prepare('DELETE FROM dealer WHERE id = ?');
    for (const old of known) {
      if (old.source === SOURCE && incoming.has(old.ext_id)) continue;
      unlink.run(old.id);
      del.run(old.id);
      stats.removed++; note('del', old.name, old.source === SOURCE ? 'удалён из справочника Carsale' : 'не из справочника Carsale');
    }
    stats.relinked = linkOrderDealers(db);
  })();
  return stats;
}

module.exports = { nameKey, coreKey, resolveDealer, linkOrderDealers, findDealer, list, applyCarsaleDealers, fromCarsale, clean, SOURCE };
