'use strict';
// Интеграция с Carsale (app.carsale.uz → API crm.carsale.uz), только чтение.
//
// Как устроен API Carsale:
//   POST {base}/dashboard/auth   {username, password}          → {token, user_id, user_name}
//   POST {base}/dashboard/proxy  {url:"/b/<модуль>&<метод>", filial_id, ...параметры}
//        заголовок X-Auth: Bearer <token>
//   Ошибка приходит как {error, details} или {status:"500", details:"ORA-…"}.
// Используемые методы:
//   /b/dashboard/infos&get_user_filials      — филиалы пользователя
//   /b/tmc_hybrid&get_tmc_directory          — каталог запчастей
//   /b/tmc_hybrid&get_tmc_stock_list         — партии запчастей с остатками и статусами
//        limit = номер страницы (с 1), offset = размер страницы (не больше 1000),
//        фильтры status_ids, store_ids, type_ids — массивы чисел
//   /b/tmc_hybrid&get_tmc_store_list         — склады
//   /b/tmc_hybrid&get_tmc_types              — типы (A, B, C, D, TOOLS)
const { now, getSetting, setSetting, audit } = require('./db');

const PAGE = 1000;
const STATUS_IN_STOCK = 8;      // «На складе»
const STATUS_RESERVED = 62;     // «Бронь для заказа»

class CarsaleError extends Error {}

function arr(d) {
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') for (const k of ['data', 'items', 'rows', 'filials', 'branches']) if (Array.isArray(d[k])) return d[k];
  if (d && typeof d === 'object' && Object.keys(d).every((k) => /^\d+$/.test(k))) return Object.values(d);
  return [];
}
const num = (v) => { const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const clean = (v, max = 200) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);

function createClient({ base, login, password, filial, timeoutMs = 30000, fetchImpl = fetch }) {
  let token = null;
  let filialId = filial || null;

  async function post(path, body, headers = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    let r;
    try {
      r = await fetchImpl(base.replace(/\/$/, '') + path, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new CarsaleError(e.name === 'AbortError' ? `Carsale не ответил за ${timeoutMs / 1000} с` : `Нет связи с Carsale: ${e.message}`);
    } finally { clearTimeout(t); }
    let data = null;
    try { data = await r.json(); } catch (e) { /* не JSON */ }
    return { status: r.status, data };
  }

  async function auth() {
    if (!login || !password) throw new CarsaleError('Не заданы CARSALE_LOGIN и CARSALE_PASSWORD в /etc/default/parts-yard');
    const { status, data } = await post('/dashboard/auth', { username: login, password });
    if (!data || !data.token) {
      throw new CarsaleError(status === 401 || status === 403 || (data && !data.token) ? 'Carsale не принял логин или пароль' : `Вход в Carsale не удался (HTTP ${status})`);
    }
    token = data.token;
    return { userId: data.user_id, userName: data.user_name };
  }

  function errorOf(status, data) {
    if (status === 401 || status === 403) return 'auth';
    if (!data) return `пустой ответ (HTTP ${status})`;
    if (data.error) return String(data.details || data.error).trim();
    if (String(data.status) === '500' || /ORA-\d{4,5}/.test(String(data.details || ''))) return String(data.details || data.message || 'ошибка сервера').trim();
    if (status >= 400) return `HTTP ${status}`;
    return null;
  }

  async function call(url, params = {}, { withFilial = true } = {}) {
    if (!token) await auth();
    const body = { url, ...params };
    if (withFilial && filialId) body.filial_id = String(filialId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const { status, data } = await post('/dashboard/proxy', body, { 'X-Auth': `Bearer ${token}` });
      const err = errorOf(status, data);
      if (!err) return data;
      const authProblem = err === 'auth' || /token|auth|unauthori|expired|login/i.test(err);
      if (attempt === 0 && authProblem) { token = null; await auth(); continue; }
      throw new CarsaleError(`Carsale ${url.split('&').pop()}: ${err === 'auth' ? 'нет доступа' : err}`);
    }
    return null;
  }

  async function ensureFilial() {
    if (filialId) return filialId;
    const list = arr(await call('/b/dashboard/infos&get_user_filials', {}, { withFilial: false }));
    if (!list.length) throw new CarsaleError('У пользователя Carsale нет доступных филиалов');
    filialId = String(list[0].filial_id ?? list[0].id);
    return filialId;
  }

  async function stockList(filters) {
    const first = await call('/b/tmc_hybrid&get_tmc_stock_list', { limit: '1', offset: String(PAGE), ...filters });
    const total = num(first && first.count_all);
    let rows = arr(first);
    let page = 1;
    // порядок строк у Carsale нестабилен между страницами — собираем по id и не доверяем одной выборке
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    while (rows.length === PAGE && page < 50) {
      page++;
      rows = arr(await call('/b/tmc_hybrid&get_tmc_stock_list', { limit: String(page), offset: String(PAGE), ...filters }));
      for (const r of rows) byId.set(String(r.id), r);
    }
    return { rows: [...byId.values()], total };
  }

  return { auth, call, ensureFilial, stockList, get filialId() { return filialId; } };
}

// ---------- синхронизация ----------
function readSettings(db, L) {
  const j = (k, d) => { try { return JSON.parse(getSetting(db, k, JSON.stringify(d))); } catch (e) { return d; } };
  return {
    enabled: getSetting(db, 'carsale_enabled', '1') === '1',
    intervalMin: Number(getSetting(db, 'carsale_interval', '30')) || 30,
    statusIds: j('carsale_status_ids', [STATUS_IN_STOCK, STATUS_RESERVED]),
    storeIds: j('carsale_store_ids', []),
    zoneMap: j('carsale_zone_map', {}),
    defaultZone: getSetting(db, 'carsale_default_zone', L.zones[0] ? L.zones[0].id : 'A'),
    defaultPer: Number(getSetting(db, 'carsale_default_per', '20')) || 20,
  };
}

function writeSettings(db, L, body) {
  const out = {};
  if (body.enabled !== undefined) out.carsale_enabled = body.enabled ? '1' : '0';
  if (body.intervalMin !== undefined) {
    const n = Number(body.intervalMin);
    if (!Number.isInteger(n) || n < 5 || n > 1440) throw new Error('Интервал — от 5 до 1440 минут');
    out.carsale_interval = String(n);
  }
  if (body.statusIds !== undefined) {
    const ids = (Array.isArray(body.statusIds) ? body.statusIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) throw new Error('Выберите хотя бы один статус');
    out.carsale_status_ids = JSON.stringify(ids);
  }
  if (body.storeIds !== undefined) out.carsale_store_ids = JSON.stringify((Array.isArray(body.storeIds) ? body.storeIds : []).map(Number).filter((n) => n > 0));
  if (body.zoneMap !== undefined) {
    const m = {};
    for (const [k, v] of Object.entries(body.zoneMap || {})) if (v && L.zoneById.has(String(v))) m[String(k).slice(0, 30)] = String(v);
    out.carsale_zone_map = JSON.stringify(m);
  }
  if (body.defaultZone !== undefined) {
    if (!L.zoneById.has(String(body.defaultZone))) throw new Error('Нет такой зоны');
    out.carsale_default_zone = String(body.defaultZone);
  }
  if (body.defaultPer !== undefined) {
    const n = Number(body.defaultPer);
    if (!Number.isInteger(n) || n < 1 || n > 100000) throw new Error('Вместимость — целое число больше нуля');
    out.carsale_default_per = String(n);
  }
  for (const [k, v] of Object.entries(out)) setSetting(db, k, v);
  return out;
}

function createCarsaleSync(db, L, cfg, { clientFactory } = {}) {
  let running = null;
  let timer = null;
  const configured = () => !!(cfg.carsale && cfg.carsale.login && cfg.carsale.password);
  const makeClient = clientFactory || (() => createClient({ ...cfg.carsale }));

  function zoneFor(type, rackName, S) {
    const t = clean(type, 30);
    if (S.zoneMap[t] && L.zoneById.has(S.zoneMap[t])) return S.zoneMap[t];
    if (L.zoneById.has(t)) return t;
    const first = clean(rackName, 30).charAt(0).toUpperCase();
    if (first && S.zoneMap[first] && L.zoneById.has(S.zoneMap[first])) return S.zoneMap[first];
    if (first && L.zoneById.has(first)) return first;
    return L.zoneById.has(S.defaultZone) ? S.defaultZone : L.zones[0].id;
  }

  async function fetchAll(client, S) {
    const filial = await client.ensureFilial();
    const [directory, stores, types] = await Promise.all([
      client.call('/b/tmc_hybrid&get_tmc_directory').then(arr),
      client.call('/b/tmc_hybrid&get_tmc_store_list').then(arr),
      client.call('/b/tmc_hybrid&get_tmc_types').then(arr).catch(() => []),
    ]);
    const filters = { status_ids: S.statusIds };
    if (S.storeIds.length) filters.store_ids = S.storeIds;
    let { rows, total } = await client.stockList(filters);
    const warnings = [];
    if (total && rows.length < total && types.length) {
      // выборка больше страницы и Carsale отдал не всё — добираем по типам
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      for (const t of types) {
        const part = await client.stockList({ ...filters, type_ids: [Number(t.id)] });
        for (const r of part.rows) byId.set(String(r.id), r);
      }
      rows = [...byId.values()];
    }
    if (total && rows.length < total) warnings.push(`Carsale сообщил о ${total} строках остатков, получено ${rows.length}`);
    return { filial, directory, stores, types, stock: rows, warnings };
  }

  function apply(data, S) {
    const stamp = now();
    const stats = { directory: data.directory.length, stockRows: data.stock.length, added: 0, updated: 0, zoneKept: 0, withStock: 0, units: 0, reserved: 0, warnings: [...data.warnings] };
    const existing = new Map(db.prepare('SELECT * FROM sku').all().map((s) => [s.art, s]));
    const placed = new Map(db.prepare('SELECT sku, COUNT(*) AS n FROM cell WHERE sku IS NOT NULL GROUP BY sku').all().map((r) => [r.sku, r.n]));
    const ins = db.prepare(`INSERT INTO sku(art, name, zone, per, min_qty, price, unit, brand, source, ext_id, ext_type, ext_location, ext_active, ext_synced)
      VALUES (@art, @name, @zone, @per, 0, @price, @unit, @brand, 'carsale', @ext_id, @ext_type, @ext_location, @ext_active, @stamp)`);
    const upd = db.prepare(`UPDATE sku SET name = @name, zone = @zone, price = @price, unit = @unit, brand = @brand, source = 'carsale',
      ext_id = @ext_id, ext_type = @ext_type, ext_location = @ext_location, ext_active = @ext_active, ext_synced = @stamp WHERE art = @art`);

    const seen = new Map();
    const take = (art, rec) => {
      if (!art || art.length > 60) return;
      const prev = seen.get(art) || {};
      seen.set(art, { ...rec, ...Object.fromEntries(Object.entries(prev).filter(([, v]) => v !== '' && v != null)) });
    };
    for (const d of data.directory) {
      take(clean(d.code_, 60), {
        name: clean(d.name_) || clean(d.code_, 60), type: clean(d.name_type, 30), rack: clean(d.name_rack, 80),
        price: num(d.price) || null, unit: clean(d.ms_quant, 20) || null, brand: clean(d.name_mark, 60) || null,
        ext_id: String(d.id ?? ''), active: d.state === 'A' || d.state == null ? 1 : 0,
      });
    }
    // запчасти, которых нет в справочнике, но есть в остатках
    const agg = new Map();
    for (const r of data.stock) {
      const art = clean(r.code_, 60);
      if (!art) continue;
      const a = agg.get(art) || { qty: 0, reserved: 0, cells: new Set() };
      const q = num(r.count_tmc);
      const status = clean(r.name_status, 60);
      if (status === 'Бронь для заказа') a.reserved += q; else a.qty += q;
      const cell = clean(r.cell_name, 60);
      if (cell) a.cells.add(cell);
      agg.set(art, a);
      if (!seen.has(art)) {
        take(art, { name: clean(r.name_tmc) || art, type: clean(r.name_type, 30), rack: cell, price: num(r.retail_price) || null,
          unit: null, brand: clean(r.car_brand, 60) || null, ext_id: '', active: 1 });
      }
    }

    db.transaction(() => {
      for (const [art, d] of seen) {
        const old = existing.get(art);
        let zone = zoneFor(d.type, d.rack, S);
        // артикул уже лежит в ячейках своей зоны — зону не трогаем, иначе он «потеряется» для размещения
        // и если зону вручную поменяли в каталоге WarehouseOS
        if (old && old.zone !== zone && ((placed.get(art) || 0) > 0 || old.zone_manual)) { zone = old.zone; stats.zoneKept++; }
        const a = agg.get(art);
        const location = a && a.cells.size ? [...a.cells].slice(0, 5).join(', ') : d.rack;
        const row = { art, name: d.name, zone, per: S.defaultPer, price: d.price, unit: d.unit, brand: d.brand,
          ext_id: d.ext_id || null, ext_type: d.type || null, ext_location: location || null, ext_active: d.active, stamp };
        if (old) { upd.run(row); stats.updated++; } else { ins.run(row); stats.added++; }
      }
      db.prepare("UPDATE sku SET ext_qty = 0, ext_reserved = 0 WHERE source = 'carsale'").run();
      const setQ = db.prepare('UPDATE sku SET ext_qty = ?, ext_reserved = ? WHERE art = ?');
      for (const [art, a] of agg) {
        setQ.run(a.qty, a.reserved, art);
        if (a.qty) stats.withStock++;
        stats.units += a.qty; stats.reserved += a.reserved;
      }
      setSetting(db, 'carsale_filial', data.filial);
      setSetting(db, 'carsale_stores', JSON.stringify(data.stores.map((s) => ({ id: String(s.id), name: clean(s.name, 80), code: clean(s.code, 20), active: s.state === 'A' }))));
      setSetting(db, 'carsale_types', JSON.stringify(data.types.map((t) => clean(t.name_, 30)).filter(Boolean)));
      db.prepare("INSERT INTO oplog(ts, op, kind, qty, user, ref) VALUES (?, 'Синхронизация Carsale', 'system', ?, 'carsale', ?)")
        .run(stamp, stats.units, `${stats.added} новых, ${stats.updated} обновлено`);
      db.exec("UPDATE meta SET v = v + 1 WHERE k = 'rev'");
    })();
    return stats;
  }

  async function run({ trigger = 'auto', user = null } = {}) {
    if (running) return running;
    if (!configured()) throw new CarsaleError('Интеграция не настроена: задайте CARSALE_LOGIN и CARSALE_PASSWORD в /etc/default/parts-yard');
    const S = readSettings(db, L);
    const id = db.prepare("INSERT INTO sync_run(source, started, trigger, user) VALUES ('carsale', ?, ?, ?)").run(now(), trigger, user).lastInsertRowid;
    const t0 = Date.now();
    running = (async () => {
      try {
        const data = await fetchAll(makeClient(), S);
        const stats = apply(data, S);
        stats.ms = Date.now() - t0;
        db.prepare("UPDATE sync_run SET finished = ?, status = 'ok', stats = ? WHERE id = ?").run(now(), JSON.stringify(stats), id);
        return { ok: true, id, stats };
      } catch (e) {
        const msg = e instanceof CarsaleError ? e.message : `Ошибка синхронизации: ${e.message}`;
        if (!(e instanceof CarsaleError)) console.error(e);
        db.prepare("UPDATE sync_run SET finished = ?, status = 'error', error = ? WHERE id = ?").run(now(), msg, id);
        return { ok: false, id, error: msg };
      } finally {
        db.prepare("DELETE FROM sync_run WHERE id NOT IN (SELECT id FROM sync_run ORDER BY id DESC LIMIT 200)").run();
      }
    })();
    try { return await running; } finally { running = null; }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!configured()) return;
    const S = readSettings(db, L);
    if (!S.enabled) return;
    const last = db.prepare("SELECT started FROM sync_run WHERE source = 'carsale' ORDER BY id DESC LIMIT 1").pluck().get();
    const lastMs = last ? new Date(last.replace(' ', 'T')).getTime() : 0;
    const due = Math.max(15000, lastMs + S.intervalMin * 60000 - Date.now());
    timer = setTimeout(async () => {
      const r = await run({ trigger: 'auto' }).catch((e) => ({ ok: false, error: e.message }));
      if (!r.ok) console.warn('Синхронизация Carsale:', r.error);
      schedule();
    }, due);
    timer.unref();
  }

  function status() {
    const S = readSettings(db, L);
    const runs = db.prepare("SELECT * FROM sync_run WHERE source = 'carsale' ORDER BY id DESC LIMIT 15").all()
      .map((r) => ({ ...r, stats: r.stats ? JSON.parse(r.stats) : null }));
    const j = (k) => { try { return JSON.parse(getSetting(db, k, '[]')); } catch (e) { return []; } };
    const counts = db.prepare(`SELECT COUNT(*) AS skus, COALESCE(SUM(ext_qty), 0) AS units, SUM(CASE WHEN ext_qty > 0 THEN 1 ELSE 0 END) AS inStock
      FROM sku WHERE source = 'carsale'`).get();
    return {
      configured: configured(),
      login: configured() ? cfg.carsale.login : null,
      base: cfg.carsale ? cfg.carsale.base : null,
      filial: getSetting(db, 'carsale_filial', cfg.carsale && cfg.carsale.filial) || null,
      running: !!running,
      settings: S,
      stores: j('carsale_stores'),
      types: j('carsale_types'),
      counts,
      runs,
    };
  }

  return { run, schedule, status, readSettings: () => readSettings(db, L), writeSettings: (b) => writeSettings(db, L, b), configured, zoneFor };
}

// Сколько по Carsale лежит на складе и сколько из этого уже разложено по ячейкам WarehouseOS
function reconcile(db) {
  return db.prepare(`SELECT s.art, s.name, s.zone, s.ext_type, s.ext_location, COALESCE(s.ext_qty, 0) AS ext_qty, COALESCE(s.ext_reserved, 0) AS ext_reserved,
      COALESCE((SELECT SUM(qty) FROM cell c WHERE c.sku = s.art), 0) AS placed,
      COALESCE((SELECT SUM(qty - placed) FROM receipt r WHERE r.art = s.art AND r.done = 0), 0) AS pending
    FROM sku s WHERE s.source = 'carsale' ORDER BY s.zone, s.art`).all()
    .map((r) => {
      const diff = r.ext_qty + r.ext_reserved - r.placed;
      return { ...r, diff, toPlace: Math.max(0, diff - r.pending),
        status: diff === 0 ? 'совпадает' : diff > 0 ? (r.pending >= diff ? 'в приёмке' : 'не размещено') : 'излишек в ячейках' };
    });
}

module.exports = { createClient, createCarsaleSync, reconcile, CarsaleError, STATUS_IN_STOCK, STATUS_RESERVED, arr };
