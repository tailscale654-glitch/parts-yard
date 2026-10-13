'use strict';
// Справочник дилеров. Дилеры бывают двух видов:
//   source = 'carsale' — загружены из Carsale и обновляются при каждой синхронизации;
//   source = 'local'   — добавлены вручную или появились из заказа с новым именем.
// Заказ хранит и ссылку на дилера (dealer_id), и его имя на момент заказа (dealer).
const { now } = require('./db');

const clean = (v, max = 200) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
// ключ для сравнения имён: без регистра, кавычек и лишних пробелов
const nameKey = (s) => clean(s, 200).toLowerCase().replace(/ё/g, 'е').replace(/[«»"'`„“”]/g, '').replace(/\s+/g, ' ').trim();

const FIELDS = ['name', 'code', 'region', 'city', 'address', 'phone', 'inn'];

function findByName(db, name) {
  const key = nameKey(name);
  if (!key) return null;
  return db.prepare('SELECT * FROM dealer WHERE name_key = ? ORDER BY active DESC, (source = \'carsale\') DESC, id LIMIT 1').get(key) || null;
}

function insertLocal(db, d) {
  const name = clean(d.name, 120);
  const t = now();
  const id = db.prepare(`INSERT INTO dealer(name, name_key, code, region, city, address, phone, inn, note, source, active, created, updated)
    VALUES (?,?,?,?,?,?,?,?,?, 'local', 1, ?, ?)`)
    .run(name, nameKey(name), clean(d.code, 40) || null, clean(d.region, 80) || null, clean(d.city, 80) || null, clean(d.address, 200) || null,
      clean(d.phone, 60) || null, clean(d.inn, 20) || null, clean(d.note, 300) || null, t, t).lastInsertRowid;
  return db.prepare('SELECT * FROM dealer WHERE id = ?').get(id);
}

// Дилер для заказа: по id, иначе по имени; если такого нет — заводим своего (create = true)
function resolveDealer(db, { id, name } = {}, { create = true } = {}) {
  if (id != null && id !== '') {
    const d = db.prepare('SELECT * FROM dealer WHERE id = ?').get(Number(id));
    if (d) return d;
  }
  const n = clean(name, 120);
  if (!n) return null;
  return findByName(db, n) || (create ? insertLocal(db, { name: n }) : null);
}

// Заказы без ссылки на дилера (старые данные, загрузка из CLI) — привязываем по имени
function linkOrderDealers(db) {
  const rows = db.prepare('SELECT id, dealer FROM orders WHERE dealer_id IS NULL').all();
  if (!rows.length) return 0;
  const set = db.prepare('UPDATE orders SET dealer_id = ? WHERE id = ?');
  for (const o of rows) { const d = resolveDealer(db, { name: o.dealer }); if (d) set.run(d.id, o.id); }
  return rows.length;
}

function list(db) {
  return db.prepare(`SELECT d.*, COUNT(o.id) AS orders, COALESCE(SUM(CASE WHEN o.done = 0 THEN 1 ELSE 0 END), 0) AS open_orders,
      MAX(o.created) AS last_order
    FROM dealer d LEFT JOIN orders o ON o.dealer_id = d.id GROUP BY d.id ORDER BY d.active DESC, d.name`).all();
}

// ---------- Carsale ----------
// Строка справочника Carsale → наш дилер. Имена полей у Carsale бывают разные (и в верхнем регистре),
// поэтому берём первое непустое из вариантов.
function pickField(r, names) {
  for (const n of names) {
    for (const k of [n, n.toUpperCase()]) if (r[k] != null && String(r[k]).trim() !== '') return r[k];
  }
  return '';
}
function fromCarsale(r, regionById) {
  const ext = clean(pickField(r, ['dealer_id', 'id']), 40);
  const regionId = clean(pickField(r, ['region_id', 'id_region']), 40);
  const state = clean(pickField(r, ['state', 'status', 'is_active', 'active']), 10).toUpperCase();
  return {
    ext_id: ext,
    name: clean(pickField(r, ['dealer_name', 'name', 'name_', 'title', 'short_name', 'full_name']), 120),
    code: clean(pickField(r, ['code', 'dealer_code', 'code_', 'mycar_code']), 40) || null,
    region: clean(pickField(r, ['region_name', 'name_region', 'region']) || (regionId && regionById.get(regionId)) || '', 80) || null,
    city: clean(pickField(r, ['city', 'city_name', 'name_city']), 80) || null,
    address: clean(pickField(r, ['address', 'adress', 'addr', 'legal_address']), 200) || null,
    phone: clean(pickField(r, ['phone', 'phone_number', 'tel', 'phones']), 60) || null,
    inn: clean(pickField(r, ['inn', 'tin']), 20) || null,
    active: ['P', 'N', '0', 'FALSE', 'D', 'BLOCKED', 'PASSIVE'].includes(state) ? 0 : 1,
  };
}

// Сверка справочника с Carsale. Ничего не удаляем: дилер, которого больше нет в Carsale,
// помечается «нет в Carsale» (active = 0), а его заказы остаются как были.
function applyCarsaleDealers(db, rows, regions = []) {
  const stamp = now();
  const regionById = new Map(regions.map((g) => [clean(pickField(g, ['id', 'region_id']), 40), clean(pickField(g, ['name', 'region_name', 'name_']), 80)]));
  const incoming = new Map();
  let skipped = 0;
  for (const r of rows) {
    const d = fromCarsale(r, regionById);
    if (!d.ext_id || !d.name) { skipped++; continue; }
    incoming.set(d.ext_id, d);
  }
  const stats = { received: rows.length, total: incoming.size, added: 0, updated: 0, linked: 0, off: 0, on: 0, skipped, changes: [], warnings: [] };
  const note = (kind, name, detail) => { if (stats.changes.length < 40) stats.changes.push(detail ? { kind, name, detail } : { kind, name }); };

  const known = db.prepare("SELECT * FROM dealer WHERE source = 'carsale'").all();
  if (!incoming.size && known.length) {
    // пустой ответ — скорее сбой или нет прав, а не «все дилеры закрылись»: ничего не отключаем
    stats.warnings.push('Carsale вернул пустой список дилеров — справочник не менялся');
    return stats;
  }
  const byExt = new Map(known.map((d) => [d.ext_id, d]));
  const locals = db.prepare("SELECT * FROM dealer WHERE source = 'local'").all();
  const localByKey = new Map(), localByCode = new Map();
  for (const d of locals) { if (!localByKey.has(d.name_key)) localByKey.set(d.name_key, d); if (d.code) localByCode.set(d.code.toLowerCase(), d); }

  const upd = db.prepare(`UPDATE dealer SET name = @name, name_key = @name_key, code = @code, region = @region, city = @city, address = @address,
    phone = @phone, inn = @inn, active = @active, source = 'carsale', ext_id = @ext_id, updated = @stamp, synced = @stamp WHERE id = @id`);
  const touch = db.prepare('UPDATE dealer SET synced = ? WHERE id = ?');
  const ins = db.prepare(`INSERT INTO dealer(name, name_key, code, region, city, address, phone, inn, source, ext_id, active, created, updated, synced)
    VALUES (@name, @name_key, @code, @region, @city, @address, @phone, @inn, 'carsale', @ext_id, @active, @stamp, @stamp, @stamp)`);
  const rename = db.prepare('UPDATE orders SET dealer = ? WHERE dealer_id = ?');

  db.transaction(() => {
    for (const d of incoming.values()) {
      const row = { ...d, name_key: nameKey(d.name), stamp };
      const old = byExt.get(d.ext_id);
      if (old) {
        const diff = FIELDS.filter((f) => (old[f] || null) !== (row[f] || null));
        if (diff.length || old.active !== row.active) {
          upd.run({ ...row, id: old.id });
          if (old.name !== row.name) rename.run(row.name, old.id);
          if (old.active !== row.active) { if (row.active) { stats.on++; note('on', row.name); } else { stats.off++; note('off', row.name, 'отключён в Carsale'); } }
          if (diff.length) { stats.updated++; note('upd', row.name, diff.includes('name') ? `было «${old.name}»` : diff.map((f) => ({ code: 'код', region: 'регион', city: 'город', address: 'адрес', phone: 'телефон', inn: 'ИНН' }[f])).join(', ')); }
        } else touch.run(stamp, old.id);
        continue;
      }
      // свой дилер с тем же именем или кодом — это он и есть, привязываем к Carsale
      const local = (row.code && localByCode.get(row.code.toLowerCase())) || localByKey.get(row.name_key);
      if (local) {
        upd.run({ ...row, id: local.id });
        if (local.name !== row.name) rename.run(row.name, local.id);
        localByKey.delete(local.name_key);
        if (local.code) localByCode.delete(local.code.toLowerCase());
        stats.linked++; note('link', row.name, local.name !== row.name ? `был «${local.name}»` : null);
        continue;
      }
      ins.run(row);
      stats.added++; note('add', row.name, row.region);
    }
    // были в Carsale, а теперь их нет
    for (const old of known) {
      if (!incoming.has(old.ext_id) && old.active) {
        db.prepare('UPDATE dealer SET active = 0, updated = ?, synced = ? WHERE id = ?').run(stamp, stamp, old.id);
        stats.off++; note('off', old.name, 'пропал из Carsale');
      }
    }
  })();
  return stats;
}

module.exports = { nameKey, resolveDealer, linkOrderDealers, insertLocal, findByName, list, applyCarsaleDealers, fromCarsale, clean };
