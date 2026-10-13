'use strict';
// Интеграция с Carsale на макете API. Формы ответов повторяют настоящий crm.carsale.uz.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { resolveLayout } = require('../src/layout');
const { openDb, syncCells } = require('../src/db');
const { createApp } = require('../src/app');
const { addUser } = require('../src/auth');
const { createClient } = require('../src/carsale');

const LAYOUT_FILE = path.join(__dirname, '..', 'layout.json');
let mock, mockBase, server, base, db, dir, L, app;
const jars = {};
const M = { password: 'secret', token: 'T1', calls: 0, expireAfter: Infinity, rows: [], directory: [],
  // как настоящий table_dealers: только ID и название, список отдаётся лишь с all = "Y"
  dealers: [{ dealer_id: '1937', dealer_name: '"Asia Motor" MChJ' }, { dealer_id: '1942', dealer_name: '"Billur motors Qiziltepa" MChJ' },
    { dealer_id: '2001', dealer_name: 'СП ООО "JAC Motors Toshkent"' }] };

function makeData() {
  const types = ['A', 'B', 'C', 'D', 'TOOLS'];
  M.directory = [];
  M.rows = [];
  let id = 30000;
  for (let i = 0; i < 600; i++) {
    const type = types[i % 5];
    const code = `P${String(i).padStart(4, '0')}-${type}`;
    M.directory.push({ id: String(21000 + i), code_: code, name_: `PART ${i} ASSY.`, name_type: type, name_rack: i % 7 ? type : `${type}\t03-04\t/01-02/`,
      price: String(10000 + i * 100), ms_quant: 'шт.', name_mark: i % 3 ? 'T8-P30BF' : '', state: i === 599 ? 'P' : 'A' });
    // на складе 2 партии, у дилера 2 партии, иногда бронь
    M.rows.push({ id: String(id++), code_: code, name_tmc: `PART ${i} ASSY.`, count_tmc: String(3 + (i % 5)), name_status: 'На складе', id_status: 8, name_type: type, cell_name: i % 4 ? type : `${type}-0${i % 9}-01-02`, retail_price: '1000' });
    M.rows.push({ id: String(id++), code_: code, name_tmc: `PART ${i} ASSY.`, count_tmc: '2', name_status: 'На складе', id_status: 8, name_type: type, cell_name: type, retail_price: '1000' });
    M.rows.push({ id: String(id++), code_: code, name_tmc: `PART ${i} ASSY.`, count_tmc: '4', name_status: 'У дилера', id_status: 82, name_type: type, cell_name: '', retail_price: '1000' });
    M.rows.push({ id: String(id++), code_: code, name_tmc: `PART ${i} ASSY.`, count_tmc: '1', name_status: 'Запчасть реализована', id_status: 65, name_type: type, cell_name: '', retail_price: '1000' });
    if (i % 10 === 0) M.rows.push({ id: String(id++), code_: code, name_tmc: `PART ${i} ASSY.`, count_tmc: '1', name_status: 'Бронь для заказа', id_status: 62, name_type: type, cell_name: type, retail_price: '1000' });
  }
  // артикул, которого нет в справочнике
  M.rows.push({ id: String(id++), code_: 'ORPHAN-1', name_tmc: 'ORPHAN PART', count_tmc: '5', name_status: 'На складе', id_status: 8, name_type: 'B', cell_name: 'B-01-01-01', retail_price: '555' });
}

before(async () => {
  makeData();
  const m = express();
  m.use(express.json());
  m.post('/dashboard/auth', (req, res) => {
    if (req.body.username === 'robot' && req.body.password === M.password) { M.token = 'T' + Date.now(); M.calls = 0; return res.json({ token: M.token, user_id: 5, user_name: 'Robot' }); }
    res.json({ message: 'Неверный логин или пароль' });
  });
  m.post('/dashboard/proxy', (req, res) => {
    const b = req.body;
    M.calls++;
    if (req.get('X-Auth') !== `Bearer ${M.token}` || M.calls > M.expireAfter) { M.expireAfter = Infinity; return res.json({ error: 'Proxy error', details: 'Token expired' }); }
    if (b.url === '/b/dashboard/infos&get_user_filials') return res.json([{ filial_id: '3641522', name: 'JAC MOTORS TOSHKENT' }]);
    if (!b.filial_id) return res.json({ error: 'Proxy error', details: '\rHashmap:filial_id not found\n' });
    if (b.url === '/b/tmc_hybrid&get_tmc_directory') return res.json({ status: '200', data: M.directory });
    if (b.url === '/b/tmc_hybrid&get_tmc_store_list') return res.json({ 0: { id: '381', name: 'JAC Motors Toshkent Store', code: 'JMTS', state: 'A' }, 1: { id: '521', name: 'Spare Parts Customs Warehouse', code: 'SPCW', state: 'P' } });
    if (b.url === '/b/tmc_hybrid&get_tmc_types') return res.json({ status: '200', data: ['A', 'B', 'C', 'D', 'TOOLS'].map((n, i) => ({ id: String(422 + i), name_: n })) });
    if (b.url === '/b/monster/bot&table_dealers') return res.json(b.all === 'Y' ? M.dealers : []);
    if (b.url === '/b/monster/bot&table_regions') return res.json([{ region_id: '1', region_name: 'город Ташкент' }, { region_id: '2', region_name: 'Андижанская область' }]);
    if (b.url === '/b/tmc_hybrid&get_tmc_stock_list') {
      let rows = M.rows;
      if (Array.isArray(b.status_ids)) rows = rows.filter((r) => b.status_ids.includes(r.id_status));
      if (Array.isArray(b.type_ids)) rows = rows.filter((r) => b.type_ids.map((t) => ['A', 'B', 'C', 'D', 'TOOLS'][t - 422]).includes(r.name_type));
      const page = Number(b.limit), size = Math.min(Number(b.offset), 1000);
      // как у настоящего Carsale: на больших выборках страницы «плывут» — часть строк повторяется, часть теряется
      const shift = page > 1 && rows.length > size ? 7 : 0;
      const data = rows.slice((page - 1) * size - shift, page * size - shift);
      return res.json({ status: '200', data, count_all: String(rows.length), qty_stock_total: '0' });
    }
    res.json({ error: 'Proxy error', details: 'unknown method' });
  });
  await new Promise((r) => { mock = m.listen(0, '127.0.0.1', r); });
  mockBase = `http://127.0.0.1:${mock.address().port}`;

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyard-cs-'));
  db = openDb(path.join(dir, 'w.db'));
  L = resolveLayout(db, LAYOUT_FILE);
  syncCells(db, L);
  addUser(db, 'boss', 'secret1', 'admin');
  addUser(db, 'keeper', 'secret3', 'storekeeper');
  app = createApp({ db, L, cfg: { ROOT: path.join(__dirname, '..'), demo: false, layoutPath: LAYOUT_FILE, dbPath: path.join(dir, 'w.db'),
    cookieName: 'pyard.sid', sessionDays: 1, secureCookie: false,
    carsale: { base: mockBase, login: 'robot', password: 'secret', filial: '' } } });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [u, p] of [['boss', 'secret1'], ['keeper', 'secret3']]) await as(u, 'POST', '/api/login', { username: u, password: p });
});
after(() => { server.close(); mock.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function as(who, method, url, body) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(jars[who] ? { Cookie: jars[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) jars[who] = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => null) };
}

test('клиент: вход, филиал, повторный вход при истёкшем ключе', async () => {
  const c = createClient({ base: mockBase, login: 'robot', password: 'secret' });
  assert.strictEqual(await c.ensureFilial(), '3641522');
  M.expireAfter = 0;
  const dirList = await c.call('/b/tmc_hybrid&get_tmc_directory');
  assert.strictEqual(dirList.data.length, 600, 'после истечения ключа клиент вошёл заново');
  const bad = createClient({ base: mockBase, login: 'robot', password: 'nope' });
  await assert.rejects(bad.ensureFilial(), /не принял логин или пароль/);
});

test('синхронизация: каталог, зоны, остатки только центрального склада', async () => {
  assert.strictEqual((await as('keeper', 'POST', '/api/integrations/carsale/sync')).status, 403);
  const r = await as('boss', 'POST', '/api/integrations/carsale/sync');
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const s = r.data.stats;
  assert.strictEqual(s.added, 601, 'справочник + артикул только из остатков');
  assert.strictEqual(s.warnings.length, 0, 'потерянные при постраничной выборке строки добраны по типам');
  const sku = db.prepare("SELECT * FROM sku WHERE art = 'P0010-A'").get();
  assert.strictEqual(sku.zone, 'A');
  assert.strictEqual(sku.ext_qty, 3 + (10 % 5) + 2, 'две партии «На складе», дилерские не считаются');
  assert.strictEqual(sku.ext_reserved, 1);
  assert.strictEqual(sku.price, 11000);
  assert.strictEqual(db.prepare("SELECT zone FROM sku WHERE art = 'P0004-TOOLS'").pluck().get(), 'A', 'TOOLS → зона по умолчанию');
  assert.strictEqual(db.prepare("SELECT ext_active FROM sku WHERE art = 'P0599-TOOLS'").pluck().get(), 0);
  assert.strictEqual(db.prepare("SELECT name FROM sku WHERE art = 'ORPHAN-1'").pluck().get(), 'ORPHAN PART');
  const expected = M.rows.filter((x) => x.id_status === 8).reduce((n, x) => n + Number(x.count_tmc), 0);
  assert.strictEqual(s.units, expected);
  assert.strictEqual(s.dealers.added, 3, 'дилеры из Carsale загружены той же синхронизацией');
  assert.strictEqual(db.prepare("SELECT COUNT(*) FROM dealer WHERE source = 'carsale' AND active = 1").pluck().get(), 3);
});

test('настройки: соответствие типов зонам, повторная синхронизация обновляет', async () => {
  const bad = await as('boss', 'PUT', '/api/integrations/carsale/settings', { intervalMin: 1 });
  assert.strictEqual(bad.data.code, 'BAD_SETTINGS');
  assert.strictEqual((await as('boss', 'PUT', '/api/integrations/carsale/settings', { zoneMap: { TOOLS: 'D' }, defaultPer: 30, intervalMin: 60 })).status, 200);
  // артикул уже лежит в ячейке зоны A — зону не меняем
  const cell = db.prepare("SELECT addr FROM cell WHERE addr LIKE 'A-%' AND sku IS NULL LIMIT 1").pluck().get();
  db.prepare("UPDATE cell SET sku = 'P0009-TOOLS', qty = 2 WHERE addr = ?").run(cell);
  db.prepare("UPDATE sku SET zone = 'A' WHERE art = 'P0009-TOOLS'").run();
  const r = await as('boss', 'POST', '/api/integrations/carsale/sync');
  assert.strictEqual(r.data.stats.added, 0);
  assert.strictEqual(r.data.stats.updated, 601);
  assert.strictEqual(db.prepare("SELECT zone FROM sku WHERE art = 'P0004-TOOLS'").pluck().get(), 'D');
  assert.strictEqual(db.prepare("SELECT zone FROM sku WHERE art = 'P0009-TOOLS'").pluck().get(), 'A');
  assert.ok(r.data.stats.zoneKept >= 1);
});

test('дилеры: заказ по имени, привязка к Carsale, отключение, переименование', async () => {
  // заказ на дилера, которого ещё нет в справочнике, — заводится свой дилер
  const o = await as('boss', 'POST', '/api/orders', { number: 'D-1', dealer: 'Дилерский центр «Восток»', lines: [{ art: 'P0001-B', qty: 1 }] });
  assert.strictEqual(o.status, 200, JSON.stringify(o.data));
  assert.strictEqual(o.data.newDealer, true);
  const local = db.prepare("SELECT * FROM dealer WHERE name = 'Дилерский центр «Восток»'").get();
  assert.strictEqual(local.source, 'local');
  // второй заказ с тем же дилером, написанным иначе, — тот же дилер
  const o2 = await as('boss', 'POST', '/api/orders', { number: 'D-2', dealer: 'дилерский центр "Восток"', lines: [{ art: 'P0001-B', qty: 1 }] });
  assert.strictEqual(o2.data.newDealer, false);
  assert.strictEqual(db.prepare("SELECT COUNT(DISTINCT dealer_id) FROM orders WHERE number IN ('D-1', 'D-2')").pluck().get(), 1);

  // тот же дилер появился в Carsale — свой привязывается, заказы получают имя из Carsale
  M.dealers.push({ dealer_id: '1950', dealer_name: 'Дилерский центр "Восток"' });
  let r = await as('boss', 'POST', '/api/integrations/carsale/sync');
  assert.strictEqual(r.data.stats.dealers.linked, 1);
  assert.strictEqual(r.data.stats.dealers.added, 0);
  const linked = db.prepare('SELECT * FROM dealer WHERE id = ?').get(local.id);
  assert.strictEqual(linked.source, 'carsale');
  assert.strictEqual(linked.ext_id, '1950');
  assert.strictEqual(db.prepare("SELECT dealer FROM orders WHERE number = 'D-1'").pluck().get(), 'Дилерский центр "Восток"');

  // пропал из Carsale — отключается, но заказы остаются
  M.dealers = M.dealers.filter((d) => d.dealer_id !== '1942');
  M.dealers.find((d) => d.dealer_id === '1937').dealer_name = 'Asia Motor MChJ';
  r = await as('boss', 'POST', '/api/integrations/carsale/sync');
  assert.strictEqual(r.data.stats.dealers.off, 1);
  assert.strictEqual(r.data.stats.dealers.updated, 1);
  const list = (await as('keeper', 'GET', '/api/dealers')).data;
  assert.strictEqual(list.dealers.find((d) => d.ext_id === '1942').active, 0);
  assert.strictEqual(list.dealers.find((d) => d.ext_id === '1950').orders, 2);
  assert.ok(list.carsale.configured);
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action LIKE 'Дилеры Carsale:%'").get(), 'изменения видны в журнале аудита');

  // пустой ответ Carsale не отключает весь справочник
  const keep = M.dealers;
  M.dealers = [];
  r = await as('boss', 'POST', '/api/integrations/carsale/sync');
  assert.strictEqual(r.data.stats.dealers.off, 0);
  assert.ok(r.data.stats.warnings.some((w) => /пустой список дилеров/.test(w)));
  M.dealers = keep;

  // вернулся — снова активен
  M.dealers.push({ dealer_id: '1942', dealer_name: '"Billur motors Qiziltepa" MChJ' });
  r = await as('boss', 'POST', '/api/integrations/carsale/sync');
  assert.strictEqual(r.data.stats.dealers.on, 1);

  // свои дилеры: права, дубликаты, удаление
  assert.strictEqual((await as('keeper', 'POST', '/api/dealers', { name: 'Сервис «Чиланзар»' })).status, 403);
  const add = await as('boss', 'POST', '/api/dealers', { name: 'Сервис «Чиланзар»', region: 'город Ташкент' });
  assert.strictEqual(add.status, 200);
  assert.strictEqual((await as('boss', 'POST', '/api/dealers', { name: 'сервис "чиланзар"' })).data.code, 'DEALER_EXISTS');
  const cs = db.prepare("SELECT id FROM dealer WHERE ext_id = '1937'").pluck().get();
  assert.strictEqual((await as('boss', 'DELETE', `/api/dealers/${cs}`)).data.code, 'FROM_CARSALE');
  assert.strictEqual((await as('boss', 'PUT', `/api/dealers/${cs}`, { note: 'забирает по вторникам', name: 'хак' })).status, 200);
  assert.strictEqual(db.prepare('SELECT name FROM dealer WHERE id = ?').pluck().get(cs), 'Asia Motor MChJ', 'у дилера из Carsale меняется только заметка');
  assert.strictEqual((await as('boss', 'DELETE', `/api/dealers/${add.data.dealer.id}`)).status, 200);
  const card = await as('keeper', 'GET', `/api/dealers/${local.id}`);
  assert.strictEqual(card.data.orders.length, 2);

  // загрузку дилеров можно выключить
  await as('boss', 'PUT', '/api/integrations/carsale/settings', { dealers: false });
  r = await as('boss', 'POST', '/api/integrations/carsale/sync');
  assert.strictEqual(r.data.stats.dealers, undefined);
  await as('boss', 'PUT', '/api/integrations/carsale/settings', { dealers: true });
  for (const n of ['D-1', 'D-2']) await as('boss', 'DELETE', `/api/orders/${db.prepare('SELECT id FROM orders WHERE number = ?').pluck().get(n)}`);
});

test('сверка и поставка на неразмещённое', async () => {
  const rec = await as('keeper', 'GET', '/api/integrations/carsale/reconcile');
  const row = rec.data.rows.find((x) => x.art === 'P0009-TOOLS');
  assert.strictEqual(row.placed, 2);
  assert.strictEqual(row.status, 'не размещено');
  assert.ok(rec.data.summary.unplacedSkus > 590);
  assert.strictEqual((await as('keeper', 'POST', '/api/integrations/carsale/receipt')).status, 403);
  const doc = await as('boss', 'POST', '/api/integrations/carsale/receipt');
  assert.strictEqual(doc.status, 200, JSON.stringify(doc.data));
  assert.ok(doc.data.doc.startsWith('CS-'));
  const after = await as('boss', 'GET', '/api/integrations/carsale/reconcile');
  assert.strictEqual(after.data.summary.unplacedUnits, 0, 'всё неразмещённое ушло в приёмку');
  assert.strictEqual(after.data.rows.find((x) => x.art === 'P0009-TOOLS').status, 'в приёмке');
  const again = await as('boss', 'POST', '/api/integrations/carsale/receipt');
  assert.strictEqual(again.data.code, 'NOTHING_TO_PLACE');
});

test('отчёт, метрики, журнал синхронизаций, ошибка входа', async () => {
  const rep = await as('boss', 'GET', '/api/reports/carsale?status=low');
  assert.strictEqual(rep.status, 200);
  assert.ok(rep.data.rows.length > 0);
  const met = await as('boss', 'POST', '/api/metrics/batch', { items: [{ metric: 'carsale_unplaced' }, { metric: 'carsale_sync' }, { metric: 'carsale_diff', params: { limit: 5 } }] });
  for (const x of met.data.results) assert.ok(!x.error, x.error);
  M.password = 'changed';
  const fail = await as('boss', 'POST', '/api/integrations/carsale/sync');
  assert.strictEqual(fail.status, 502);
  assert.match(fail.data.error, /не принял логин или пароль/);
  M.password = 'secret';
  const st = await as('boss', 'GET', '/api/integrations/carsale');
  assert.strictEqual(st.data.login, 'robot');
  assert.strictEqual(st.data.filial, '3641522');
  assert.strictEqual(st.data.runs[0].status, 'error');
  assert.strictEqual(st.data.runs[1].status, 'ok');
  assert.ok(!JSON.stringify(st.data).includes('secret'), 'пароль никогда не уходит в браузер');
  assert.strictEqual(st.data.stores.length, 2);
});
