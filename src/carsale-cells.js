'use strict';
// Запись ячеек склада в Carsale. Единственное место, где WarehouseOS что-то меняет в Carsale,
// и только по нажатию администратора (сначала план без изменений, потом запуск).
//
//   1. «Справочник стеллажей/ячеек»: создаём недостающие ячейки на складе Carsale
//      /b/tmc_hybrid&get_rack_directory, /b/tmc_hybrid&add_rack {name_, id_store, state:"A"}
//   2. «Справочник запчастей»: у артикула ставим ячейку хранения (первую закреплённую)
//      /b/tmc_hybrid&edit_directory {id, ...все поля карточки как в форме Carsale, id_rack}
//   3. Остатки на складе (по желанию): партии переносим в эту ячейку
//      /b/tmc_hybrid&change_rack {id, count_tmc, id_rack, id_store}
const { getSetting, setSetting, now, audit } = require('./db');
const { createClient, CarsaleError, arr } = require('./carsale');
const { homeOf } = require('./cells');

const PAUSE = 60; // мс между запросами, чтобы не нагружать Carsale
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = (v) => String(v ?? '').trim().toUpperCase();

// Карточка запчасти из списка Carsale → тело edit_directory. Повторяет форму Carsale (J → X),
// чтобы при смене ячейки остальные поля карточки остались как были.
function directoryPayload(e, rackId) {
  const price = e.PRICE ?? e.price;
  const typeId = e.ID_TYPE ?? e.id_type;
  const num = (v) => (Number(v) || v);
  return {
    id: num(e.id),
    Code_: e.code_ ?? e.code ?? '',
    Name_: e.name_ ?? e.name ?? '',
    ID_TYPE: typeId == null ? typeId : num(typeId),
    id_rack: num(rackId),
    state: e.state || 'A',
    id_mark: e.id_mark == null ? e.id_mark : num(e.id_mark),
    PRICE: Number(price) || 0,
    photo_sha: e.photo_sha ?? null,
    country: e.country || '',
    ms_quant: e.ms_quant || '',
    cpu: e.cpu ?? null,
    oem: e.oem || '',
    barcode: e.barcode ?? null,
    guarantee: e.guarantee || '',
    moq: e.moq != null && e.moq !== '' ? Number(e.moq) : 0,
  };
}

function createCarsaleCells(db, L, cfg, { clientFactory } = {}) {
  const makeClient = clientFactory || (() => createClient({ ...cfg.carsale }));
  const configured = () => !!(cfg.carsale && cfg.carsale.login && cfg.carsale.password);
  let job = null;

  function stores() { try { return JSON.parse(getSetting(db, 'carsale_stores', '[]')); } catch (e) { return []; } }
  function defaultStore() {
    const saved = getSetting(db, 'carsale_cells_store', '');
    if (saved) return saved;
    let ids = [];
    try { ids = JSON.parse(getSetting(db, 'carsale_store_ids', '[]')); } catch (e) { ids = []; }
    if (ids.length) return String(ids[0]);
    const st = stores().find((s) => s.active) || stores()[0];
    return st ? String(st.id) : '';
  }

  // что хотим получить: артикул → ячейки (первая — место хранения в Carsale)
  function targets() {
    const out = [];
    for (const s of db.prepare("SELECT art, name, home FROM sku WHERE home IS NOT NULL AND home != '[]'").all()) {
      const cells = homeOf(s);
      if (cells.length) out.push({ art: s.art, name: s.name, cells, main: cells[0] });
    }
    return out;
  }

  // Читает Carsale и считает, что нужно сделать. Ничего не меняет.
  async function plan({ storeId, batches = true, client } = {}) {
    if (!configured()) throw new CarsaleError('Интеграция не настроена: задайте CARSALE_LOGIN и CARSALE_PASSWORD в /etc/default/parts-yard');
    const c = client || makeClient();
    await c.ensureFilial();
    const store = String(storeId || defaultStore());
    if (!store) throw new CarsaleError('Не выбран склад Carsale — запустите синхронизацию, чтобы получить список складов');
    const T = targets();
    if (!T.length) throw new CarsaleError('У артикулов нет закреплённых ячеек — сначала загрузите файл ячеек склада');
    const [rackRows, dir] = await Promise.all([
      c.call('/b/tmc_hybrid&get_rack_directory').then(arr),
      c.call('/b/tmc_hybrid&get_tmc_directory').then(arr),
    ]);
    const racks = new Map();
    for (const r of rackRows) if (String(r.id_store ?? '') === store || r.id_store == null) racks.set(up(r.name_ ?? r.name), String(r.id));
    const wanted = [...new Set(T.flatMap((t) => t.cells))].sort();
    const createRacks = wanted.filter((n) => !racks.has(up(n)));

    const byCode = new Map();
    for (const d of dir) { const k = up(d.code_ ?? d.code); if (k && !byCode.has(k)) byCode.set(k, d); }
    const items = [], missing = [], same = [];
    for (const t of T) {
      const d = byCode.get(up(t.art));
      if (!d) { missing.push(t.art); continue; }
      const cur = d.id_rack != null ? String(d.id_rack) : '';
      const want = racks.get(up(t.main));
      if (want && cur === want) { same.push(t.art); continue; }
      items.push({ art: t.art, id: String(d.id), from: d.name_rack || '', to: t.main });
    }

    let moves = [];
    if (batches) {
      let ids = [];
      try { ids = JSON.parse(getSetting(db, 'carsale_status_ids', '[8,62]')); } catch (e) { ids = [8, 62]; }
      const { rows } = await c.stockList({ status_ids: ids, store_ids: [Number(store)] });
      const main = new Map(T.map((t) => [up(t.art), t.main]));
      for (const r of rows) {
        const to = main.get(up(r.code_));
        const qty = Number(r.count_tmc) || 0;
        if (!to || qty <= 0) continue;
        if (r.id_store != null && String(r.id_store) !== store) continue;
        if (up(r.cell_name) === up(to)) continue;
        moves.push({ id: String(r.id), art: r.code_, qty, from: r.cell_name || '', to });
      }
    }
    const st = stores().find((s) => String(s.id) === store);
    return {
      store: { id: store, name: st ? st.name : `склад ${store}` }, stores: stores(),
      targets: T.length, cells: wanted.length,
      racks: { existing: wanted.length - createRacks.length, create: createRacks.length, sample: createRacks.slice(0, 12) },
      items: { update: items.length, same: same.length, missing: missing.length, missingSample: missing.slice(0, 20), sample: items.slice(0, 12) },
      batches: { move: moves.length, units: moves.reduce((n, m) => n + m.qty, 0), sample: moves.slice(0, 12), enabled: batches },
      _work: { createRacks, items, moves, racks, dirById: new Map(dir.map((d) => [String(d.id), d])), client: c, store },
    };
  }

  const strip = (p) => { const { _work, ...rest } = p; return rest; };

  async function run({ storeId, doRacks = true, doItems = true, doBatches = true, user }) {
    const p = await plan({ storeId, batches: doBatches });
    const W = p._work, c = W.client;
    const total = (doRacks ? W.createRacks.length : 0) + (doItems ? W.items.length : 0) + (doBatches ? W.moves.length : 0);
    if (job) job.total = total;
    const errors = [];
    const stats = { racksCreated: 0, itemsUpdated: 0, batchesMoved: 0, unitsMoved: 0, errors: 0, verified: null };
    const step = (s) => { job.step = s; };
    const tick = () => { job.done++; };
    const fail = (what, e) => { stats.errors++; if (errors.length < 50) errors.push(`${what}: ${e.message || e}`); };

    if (doRacks) {
      step('Создаю ячейки в справочнике стеллажей');
      for (const name of W.createRacks) {
        try {
          const r = await c.call('/b/tmc_hybrid&add_rack', { name_: name, id_store: String(W.store), state: 'A' });
          if (r && r.id != null) W.racks.set(up(name), String(r.id));
          stats.racksCreated++;
        } catch (e) { fail(`ячейка ${name}`, e); }
        tick(); await sleep(PAUSE);
      }
      // id новых ячеек — перечитываем справочник
      const fresh = arr(await c.call('/b/tmc_hybrid&get_rack_directory'));
      for (const r of fresh) if (String(r.id_store ?? '') === String(W.store) || r.id_store == null) W.racks.set(up(r.name_ ?? r.name), String(r.id));
    }
    if (doItems) {
      step('Ставлю ячейки в карточки запчастей');
      for (const it of W.items) {
        const rackId = W.racks.get(up(it.to));
        const d = W.dirById.get(it.id);
        if (!rackId) { fail(`${it.art}`, new Error(`нет ячейки ${it.to} в Carsale`)); tick(); continue; }
        try { await c.call('/b/tmc_hybrid&edit_directory', directoryPayload(d, rackId)); stats.itemsUpdated++; } catch (e) { fail(it.art, e); }
        tick(); await sleep(PAUSE);
      }
    }
    if (doBatches) {
      step('Переношу остатки в ячейки');
      for (const m of W.moves) {
        const rackId = W.racks.get(up(m.to));
        if (!rackId) { fail(`партия ${m.art}`, new Error(`нет ячейки ${m.to} в Carsale`)); tick(); continue; }
        try {
          await c.call('/b/tmc_hybrid&change_rack', { id: m.id, count_tmc: String(m.qty), id_rack: rackId, id_store: String(W.store) });
          stats.batchesMoved++; stats.unitsMoved += m.qty;
        } catch (e) { fail(`партия ${m.art}`, e); }
        tick(); await sleep(PAUSE);
      }
    }
    // проверка: перечитываем карточки и сравниваем ячейку
    if (doItems && W.items.length) {
      step('Проверяю результат');
      const dir = arr(await c.call('/b/tmc_hybrid&get_tmc_directory'));
      const byId = new Map(dir.map((d) => [String(d.id), d]));
      stats.verified = W.items.filter((it) => { const d = byId.get(it.id); return d && String(d.id_rack ?? '') === W.racks.get(up(it.to)); }).length;
    }
    setSetting(db, 'carsale_cells_store', W.store);
    return { stats, errors, total, plan: strip(p) };
  }

  // Запуск в фоне: запись нескольких сотен карточек идёт минуты, а HTTP-запрос столько ждать не должен
  function start(opts) {
    if (job && job.running) return job;
    const id = db.prepare("INSERT INTO sync_run(source, started, trigger, user) VALUES ('carsale-cells', ?, 'manual', ?)").run(now(), opts.user || null).lastInsertRowid;
    job = { id, running: true, started: now(), step: 'Читаю Carsale', done: 0, total: 0, result: null, error: null };
    (async () => {
      try {
        const r = await run(opts);
        job.result = r; job.total = r.total;
        db.prepare('UPDATE sync_run SET finished = ?, status = ?, stats = ?, error = ? WHERE id = ?')
          .run(now(), r.stats.errors ? 'partial' : 'ok', JSON.stringify(r.stats), r.errors.slice(0, 10).join('; ') || null, id);
        audit(db, opts.user, 'Ячейки записаны в Carsale', { store: r.plan.store, ...r.stats, errors: r.errors.slice(0, 20) });
      } catch (e) {
        job.error = e instanceof CarsaleError ? e.message : `Ошибка: ${e.message}`;
        if (!(e instanceof CarsaleError)) console.error(e);
        db.prepare("UPDATE sync_run SET finished = ?, status = 'error', error = ? WHERE id = ?").run(now(), job.error, id);
      } finally { job.running = false; job.finished = now(); }
    })();
    return job;
  }
  function status() {
    const last = db.prepare("SELECT * FROM sync_run WHERE source = 'carsale-cells' ORDER BY id DESC LIMIT 5").all()
      .map((r) => ({ ...r, stats: r.stats ? JSON.parse(r.stats) : null }));
    return { job: job && { ...job, result: job.result && { stats: job.result.stats, errors: job.result.errors } }, last };
  }

  return { plan: async (o) => strip(await plan(o)), start, status, configured, directoryPayload };
}

module.exports = { createCarsaleCells, directoryPayload };
