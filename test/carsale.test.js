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
const M = { password: 'secret', token: 'T1', calls: 0, expireAfter: Infinity, rows: [], directory: [], dealers: [], racks: [], edits: [], moves: [] };
// как настоящий get_tmc_dealer_list: вместе с карточкой отдаются логины и ключи интеграций — их хранить нельзя
const dealerRow = (id, name, code, region, state = 'A') => ({ dealer_id: id, region_id: '1', name, state, address: 'ул. Мохичехра, 48а', code,
  phone_number: '+998 90 000 00 00', fax: '', note: '', name_uz: name, filial_id: '3641522', client_id_faktura: '2661', username: 'dealer@mail.example',
  password: 'SECRET-PASS', client_secret: 'SECRET-KEY', client_id: 'abozorcar', company_inn: '310044027', url_token: 'https://account.faktura.uz/token',
  url_api: 'https://api.faktura.uz/Api', methodgetstatus: '', region_name: region, state_name: state === 'A' ? 'Активный' : 'Неактивный', rating: '<span></span>', rating_value: '0' });
function makeDealers() {
  M.dealers = [dealerRow('1125', 'OOO «ASIAMOTOR»', 'ASM', 'город Ташкент'), dealerRow('1127', 'OOO «NURAFSHON AUTO ZONE»', 'JNZ', 'город Ташкент', 'P'),
    dealerRow('1181', '"Jac Motors Toshkent" MCHJ Qk', 'JMT', 'город Ташкент'), dealerRow('1147', 'OOO «Buyuk Sam Sabr»', 'BSS', 'Самаркандская область')];
}

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
  makeDealers();
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
    if (b.url === '/b/tmc_hybrid&get_tmc_dealer_list') return res.json(M.dealers);
    if (b.url === '/b/tmc_hybrid&get_rack_directory') return res.json({ status: '200', data: M.racks });
    if (b.url === '/b/tmc_hybrid&add_rack') {
      if (M.racks.some((r) => r.name_ === b.name_ && r.id_store === b.id_store)) return res.json({ error: 'Proxy error', details: 'ORA-20001: AP: ячейка уже есть' });
      const id = String(9000 + M.racks.length); M.racks.push({ id, name_: b.name_, id_store: b.id_store, name_store: 'JAC Motors Toshkent Store', state: b.state });
      return res.json({ message: 'ok' });
    }
    if (b.url === '/b/tmc_hybrid&edit_directory') {
      const d = M.directory.find((x) => String(x.id) === String(b.id));
      if (!d) return res.json({ error: 'Proxy error', details: 'no item' });
      M.edits.push(b);
      d.id_rack = String(b.id_rack); d.name_rack = (M.racks.find((r) => r.id === String(b.id_rack)) || {}).name_;
      return res.json({ message: 'ok' });
    }
    if (b.url === '/b/tmc_hybrid&change_rack') {
      const r = M.rows.find((x) => x.id === b.id);
      M.moves.push(b);
      r.cell_name = (M.racks.find((x) => x.id === b.id_rack) || {}).name_;
      return res.json({ message: 'Moved successfully' });
    }
    if (b.url === '/b/monster/bot&table_dealers') return res.json([{ dealer_id: '1937', dealer_name: '"Asia Motor" MChJ' }]);
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
  assert.strictEqual(s.dealers.added, 4, 'дилеры из справочника запчастей загружены той же синхронизацией');
  assert.strictEqual(db.prepare('SELECT COUNT(*) FROM dealer WHERE active = 1').pluck().get(), 3, 'неактивный в Carsale — неактивен и здесь');
  assert.ok(!db.prepare("SELECT 1 FROM dealer WHERE name LIKE '%Asia Motor%'").get(), 'дилеры из других разделов Carsale не берутся');
  const dump = JSON.stringify(db.prepare('SELECT * FROM dealer').all()) + JSON.stringify(db.prepare('SELECT * FROM sync_run').all()) + JSON.stringify(db.prepare('SELECT * FROM audit').all());
  assert.ok(!/SECRET|faktura|dealer@mail/.test(dump), 'логины, пароли и ключи интеграций дилеров не сохраняются');
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

test('дилеры: только из справочника Carsale, заказы, удаление лишних', async () => {
  // заказ — только на дилера из справочника: по id, названию (без учёта кавычек и формы) или коду
  const asm = db.prepare("SELECT * FROM dealer WHERE ext_id = '1125'").get();
  let o = await as('boss', 'POST', '/api/orders', { number: 'D-1', dealer_id: asm.id, lines: [{ art: 'P0001-B', qty: 1 }] });
  assert.strictEqual(o.status, 200, JSON.stringify(o.data));
  o = await as('boss', 'POST', '/api/orders', { number: 'D-2', dealer: 'ООО "Jac Motors Toshkent"', lines: [{ art: 'P0001-B', qty: 1 }] });
  assert.strictEqual(o.data.dealer, '"Jac Motors Toshkent" MCHJ Qk');
  o = await as('boss', 'POST', '/api/orders', { number: 'D-3', dealer: 'bss', lines: [{ art: 'P0001-B', qty: 1 }] });
  assert.strictEqual(o.data.dealer, 'OOO «Buyuk Sam Sabr»');
  const bad = await as('boss', 'POST', '/api/orders', { number: 'D-4', dealer: 'Дилерский центр «Восток»', lines: [{ art: 'P0001-B', qty: 1 }] });
  assert.strictEqual(bad.data.code, 'BAD_DEALER', 'дилера не из справочника не заводим');
  const off = db.prepare("SELECT id FROM dealer WHERE ext_id = '1127'").pluck().get();
  assert.match((await as('boss', 'POST', '/api/orders', { number: 'D-4', dealer_id: off, lines: [{ art: 'P0001-B', qty: 1 }] })).data.error, /неактивен/);

  // посторонний дилер в базе (например, из прежней версии) удаляется при синхронизации, заказ сохраняет имя
  const t = '2026-10-01 10:00:00';
  const stray = db.prepare("INSERT INTO dealer(name, name_key, source, created) VALUES ('Сервис «Чиланзар»', 'сервис чиланзар', 'local', ?)").run(t).lastInsertRowid;
  db.prepare("INSERT INTO orders(number, dealer, dealer_id, created) VALUES ('OLD-1', 'Сервис «Чиланзар»', ?, ?)").run(stray, t);
  // старый заказ без ссылки, но с узнаваемым именем — привяжется
  db.prepare("INSERT INTO orders(number, dealer, created) VALUES ('OLD-2', 'Jac Motors Toshkent', ?)").run(t);

  // в Carsale: дилер переименован, один удалён, один стал активным
  M.dealers = M.dealers.filter((d) => d.dealer_id !== '1147');
  M.dealers.find((d) => d.dealer_id === '1125').name = 'OOO «ASIA MOTOR»';
  M.dealers.find((d) => d.dealer_id === '1127').state = 'A';
  let r = await as('boss', 'POST', '/api/integrations/carsale/sync');
  const st = r.data.stats.dealers;
  assert.strictEqual(st.removed, 2, 'удалены: пропавший из Carsale и посторонний');
  assert.strictEqual(st.updated, 1);
  assert.strictEqual(st.on, 1);
  assert.ok(st.relinked >= 1);
  assert.ok(!db.prepare('SELECT 1 FROM dealer WHERE id = ?').get(stray));
  assert.strictEqual(db.prepare("SELECT dealer_id FROM orders WHERE number = 'OLD-1'").pluck().get(), null);
  assert.strictEqual(db.prepare("SELECT dealer FROM orders WHERE number = 'D-3'").pluck().get(), 'OOO «Buyuk Sam Sabr»', 'имя в заказе остаётся');
  assert.strictEqual(db.prepare("SELECT dealer FROM orders WHERE number = 'D-1'").pluck().get(), 'OOO «ASIA MOTOR»', 'переименование доходит до заказов');
  assert.strictEqual(db.prepare("SELECT dealer_id FROM orders WHERE number = 'OLD-2'").pluck().get(), db.prepare("SELECT id FROM dealer WHERE ext_id = '1181'").pluck().get());
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action LIKE 'Дилеры Carsale:%удалено%'").get(), 'изменения видны в журнале аудита');

  // пустой ответ Carsale справочник не трогает
  const keep = M.dealers;
  M.dealers = [];
  r = await as('boss', 'POST', '/api/integrations/carsale/sync');
  assert.strictEqual(r.data.stats.dealers.removed, 0);
  assert.ok(r.data.stats.warnings.some((w) => /пустой список дилеров/.test(w)));
  M.dealers = keep;

  // в WarehouseOS у дилера меняется только заметка; добавлять и удалять нельзя
  const list = (await as('keeper', 'GET', '/api/dealers')).data;
  assert.strictEqual(list.dealers.length, 3);
  assert.ok(list.dealers.every((d) => d.source === 'carsale'));
  assert.strictEqual((await as('boss', 'POST', '/api/dealers', { name: 'Новый' })).status, 404);
  assert.strictEqual((await as('boss', 'DELETE', `/api/dealers/${asm.id}`)).status, 404);
  assert.strictEqual((await as('keeper', 'PUT', `/api/dealers/${asm.id}`, { note: 'x' })).status, 403);
  assert.strictEqual((await as('boss', 'PUT', `/api/dealers/${asm.id}`, { note: 'забирает по вторникам', name: 'хак' })).status, 200);
  const card = (await as('keeper', 'GET', `/api/dealers/${asm.id}`)).data;
  assert.strictEqual(card.name, 'OOO «ASIA MOTOR»');
  assert.strictEqual(card.note, 'забирает по вторникам');
  assert.strictEqual(card.orders.length, 1);
  assert.strictEqual(card.inn, '310044027');

  // загрузку дилеров можно выключить
  await as('boss', 'PUT', '/api/integrations/carsale/settings', { dealers: false });
  r = await as('boss', 'POST', '/api/integrations/carsale/sync');
  assert.strictEqual(r.data.stats.dealers, undefined);
  await as('boss', 'PUT', '/api/integrations/carsale/settings', { dealers: true });
  for (const n of ['D-1', 'D-2', 'D-3', 'OLD-1', 'OLD-2']) await as('boss', 'DELETE', `/api/orders/${db.prepare('SELECT id FROM orders WHERE number = ?').pluck().get(n)}`);
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

test('ячейки склада из Excel и запись ячеек в Carsale', async () => {
  const C = require('../src/cells');
  assert.deepStrictEqual(C.parseCell('B-01-03-02\\03').list, ['B-01-03-02', 'B-01-03-03']);
  assert.deepStrictEqual(C.parseCell('A-016-01-01').list, ['A-16-01-01']);
  assert.deepStrictEqual(C.parseCell('A-01-01-01\\03').list, ['A-01-01-01', 'A-01-01-02', 'A-01-01-03'], 'два номера по возрастанию — диапазон');
  assert.deepStrictEqual(C.parseCell('B-12\\07-01-01').list, ['B-12-01-01', 'B-07-01-01'], 'по убыванию — перечисление');
  assert.strictEqual(C.parseCell('D/Z-01-02-01').zone, 'DZ');
  assert.strictEqual(C.parseCell('А-08-01-01').zone, 'A', 'кириллическая А');
  assert.ok(C.parseCell('D/Z---').error);

  const rows = [['№', 'Артикул', 'Номенклатура Ru', 'Номенклатура EN', 'Ячейка'],
    ['1', 'P0001-B', 'Деталь 1', 'PART 1', 'B-01-02-01'], ['2', 'P0002-C', 'Деталь 2', 'PART 2', 'A-016-01-01\\02'],
    ['3', 'P0003-D', 'Деталь 3', 'PART 3', 'D/Z-01-02-01'], ['4', 'NEW-1', 'Новая', 'NEW', 'B-03-04-02'], ['5', 'BAD-1', 'Плохая', 'BAD', 'D/Z---']];
  const objs = C.rowsFromTable(rows);
  const pv = await as('boss', 'POST', '/api/admin/cells/preview', { rows: objs });
  assert.strictEqual(pv.status, 200, JSON.stringify(pv.data));
  assert.strictEqual(pv.data.stats.ok, 4);
  assert.strictEqual(pv.data.problems.length, 1);
  assert.deepStrictEqual(pv.data.zones.map((z) => z.id).sort(), ['A', 'B', 'DZ']);
  assert.strictEqual(pv.data.zones.find((z) => z.id === 'DZ').title, 'Зона D/Z');
  assert.strictEqual((await as('keeper', 'POST', '/api/admin/cells/apply', { rows: objs })).status, 403);
  const ap = await as('boss', 'POST', '/api/admin/cells/apply', { rows: objs, clearCells: true, confirmClear: true });
  assert.strictEqual(ap.status, 200, JSON.stringify(ap.data));
  assert.strictEqual(ap.data.added, 1, 'артикул, которого не было в каталоге, добавлен');
  assert.strictEqual(db.prepare("SELECT home FROM sku WHERE art = 'P0002-C'").pluck().get(), '["A-16-01-01","A-16-01-02"]');
  assert.strictEqual(db.prepare("SELECT zone FROM sku WHERE art = 'P0002-C'").pluck().get(), 'A');
  const lay = (await as('keeper', 'GET', '/api/layout')).data;
  assert.ok(lay.zones.every((z) => z.scheme === 'racks'));
  // размещение идёт в закреплённую ячейку
  await as('boss', 'POST', '/api/receipts', { doc: 'CELL-1', gate: '1', lines: [{ art: 'P0002-C', qty: 3 }] });
  const rid = db.prepare("SELECT id FROM receipt WHERE doc = 'CELL-1'").pluck().get();
  const plan = await as('keeper', 'GET', `/api/plan/putaway/${rid}`);
  assert.strictEqual(plan.data.plan[0].addr, 'A-16-01-01');
  // в каталоге ячейки можно поправить в любом написании
  assert.strictEqual((await as('boss', 'POST', '/api/catalog', { art: 'NEW-1', name: 'Новая', zone: 'B', per: 5, home: 'b-3-4-2, B 03 04 01' })).status, 200);
  assert.strictEqual(db.prepare("SELECT home FROM sku WHERE art = 'NEW-1'").pluck().get(), '["B-03-04-02","B-03-04-01"]');
  assert.strictEqual((await as('boss', 'POST', '/api/catalog', { art: 'NEW-1', name: 'Новая', zone: 'B', per: 5, home: 'Z-99-01-01' })).data.code, 'BAD_HOME');

  // Carsale: план ничего не меняет
  M.racks = [{ id: '8001', name_: 'B-01-02-01', id_store: '381', name_store: 'JAC Motors Toshkent Store', state: 'A' }];
  const before = JSON.stringify(M.directory);
  const p1 = await as('boss', 'GET', '/api/integrations/carsale/cells/plan?store=381');
  assert.strictEqual(p1.status, 200, JSON.stringify(p1.data));
  assert.strictEqual(p1.data.racks.create, 5, 'A-16-01-01, A-16-01-02, DZ-01-02-01 и две ячейки NEW-1; B-01-02-01 уже есть');
  assert.strictEqual(p1.data.items.update, 3);
  assert.strictEqual(p1.data.items.missing, 1, 'NEW-1 нет в Carsale');
  assert.ok(p1.data.batches.move > 0);
  assert.strictEqual(JSON.stringify(M.directory), before);
  assert.strictEqual(M.edits.length + M.moves.length, 0);
  assert.strictEqual((await as('keeper', 'GET', '/api/integrations/carsale/cells/plan')).status, 403);
  assert.strictEqual((await as('boss', 'POST', '/api/integrations/carsale/cells/apply', {})).data.code, 'CONFIRM');

  // запись
  const src = JSON.parse(JSON.stringify(M.directory.find((d) => d.code_ === 'P0002-C')));
  const go = await as('boss', 'POST', '/api/integrations/carsale/cells/apply', { confirm: true, storeId: '381' });
  assert.strictEqual(go.status, 200, JSON.stringify(go.data));
  let st;
  for (let i = 0; i < 100; i++) { st = (await as('boss', 'GET', '/api/integrations/carsale/cells/status')).data; if (!st.job.running) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.ok(!st.job.error, st.job.error);
  const s = st.job.result.stats;
  assert.strictEqual(s.racksCreated, 5);
  assert.strictEqual(s.itemsUpdated, 3);
  assert.strictEqual(s.verified, 3);
  assert.strictEqual(s.errors, 0, JSON.stringify(st.job.result.errors));
  const d2 = M.directory.find((d) => d.code_ === 'P0002-C');
  assert.strictEqual(d2.name_rack, 'A-16-01-01', 'место хранения — первая закреплённая ячейка');
  const e = M.edits.find((x) => x.Code_ === 'P0002-C');
  assert.strictEqual(e.Name_, src.name_, 'остальные поля карточки не теряются');
  assert.strictEqual(e.PRICE, Number(src.price));
  assert.strictEqual(e.ms_quant, src.ms_quant);
  assert.ok(M.rows.filter((r) => r.code_ === 'P0002-C' && [8, 62].includes(r.id_status)).every((r) => r.cell_name === 'A-16-01-01'), 'остатки перенесены');
  assert.ok(M.rows.filter((r) => r.code_ === 'P0002-C' && r.id_status === 82).every((r) => r.cell_name !== 'A-16-01-01'), 'у дилера не трогаем');
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action = 'Ячейки записаны в Carsale'").get());
  // повторный план — делать нечего
  const p2 = (await as('boss', 'GET', '/api/integrations/carsale/cells/plan?store=381')).data;
  assert.strictEqual(p2.racks.create + p2.items.update + p2.batches.move, 0);
  await as('boss', 'DELETE', '/api/receipts/doc/CELL-1');
});
