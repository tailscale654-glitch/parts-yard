'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { resolveLayout } = require('../src/layout');
const { openDb, syncCells } = require('../src/db');
const { createApp } = require('../src/app');
const { addUser } = require('../src/auth');
const { seedDemo } = require('../src/demo');

let server, base, db, cookie, dir, L;
const LAYOUT_FILE = path.join(__dirname, '..', 'layout.json');

async function call(method, url, body, headers = {}) {
  const r = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  let data = null;
  try { data = await r.json(); } catch (e) { /* html */ }
  return { status: r.status, data };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyard-'));
  db = openDb(path.join(dir, 'w.db'));
  L = resolveLayout(db, LAYOUT_FILE);
  syncCells(db, L);
  seedDemo(db, L);
  addUser(db, 'ivan', 'secret1', 'operator');
  addUser(db, 'admin', 'secret2', 'admin');
  const app = createApp({ db, L, cfg: { ROOT: path.join(__dirname, '..'), demo: true, layoutPath: LAYOUT_FILE, dbPath: path.join(dir, 'w.db'), cookieName: 'pyard.sid', sessionDays: 1, secureCookie: false } });
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('без входа API закрыт, страница уводит на /login', async () => {
  assert.strictEqual((await call('GET', '/api/state')).status, 401);
  const r = await call('GET', '/');
  assert.strictEqual(r.status, 302);
});

test('неверный пароль и успешный вход', async () => {
  assert.strictEqual((await call('POST', '/api/login', { username: 'ivan', password: 'nope' })).status, 401);
  const r = await call('POST', '/api/login', { username: 'ivan', password: 'secret1' });
  assert.strictEqual(r.status, 200);
  assert.ok(cookie.startsWith('pyard.sid='));
  const st = await call('GET', '/api/state');
  assert.strictEqual(st.data.user.username, 'ivan');
  assert.ok(Object.keys(st.data.cells).length > 1000);
});

test('размещение по плану закрывает строку поставки', async () => {
  const rid = db.prepare("SELECT id FROM receipt WHERE done = 0 AND art = 'FO-15208'").pluck().get();
  const plan = await call('GET', `/api/plan/putaway/${rid}`);
  assert.ok(plan.data.plan.length > 0);
  const r = await call('POST', `/api/receipts/${rid}/putaway`);
  assert.strictEqual(r.status, 200);
  const rec = db.prepare('SELECT * FROM receipt WHERE id = ?').get(rid);
  assert.strictEqual(rec.done, 1);
  assert.strictEqual(rec.placed, rec.qty);
});

test('штучный отбор: проверка товара, остатка и повтор по opId', async () => {
  const c = db.prepare("SELECT addr, sku, qty FROM cell WHERE sku = 'FO-15208' AND qty >= 3 AND blocked = 0 LIMIT 1").get();
  const wrong = await call('POST', `/api/cells/${c.addr}/pick`, { art: 'SP-22401', qty: 1 });
  assert.strictEqual(wrong.status, 409);
  assert.strictEqual(wrong.data.code, 'WRONG_ITEM');
  const tooMuch = await call('POST', `/api/cells/${c.addr}/pick`, { art: c.sku, qty: c.qty + 1 });
  assert.strictEqual(tooMuch.data.code, 'INSUFFICIENT');

  const op = 'tsd-7-000123';
  const r1 = await call('POST', `/api/cells/${c.addr}/pick`, { art: c.sku, qty: 2 }, { 'X-Op-Id': op });
  const r2 = await call('POST', `/api/cells/${c.addr}/pick`, { art: c.sku, qty: 2 }, { 'X-Op-Id': op });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r2.data.replayed, true);
  assert.strictEqual(db.prepare('SELECT qty FROM cell WHERE addr = ?').get(c.addr).qty, c.qty - 2, 'повтор не списал второй раз');
});

test('два ТСД офлайн отбирают из одной ячейки: второй получает отказ', async () => {
  const c = db.prepare("SELECT addr, sku, qty FROM cell WHERE sku = 'SP-22401' AND qty >= 4 AND blocked = 0 LIMIT 1").get();
  const take = Math.ceil(c.qty * 0.6);
  const a = await call('POST', `/api/cells/${c.addr}/pick`, { art: c.sku, qty: take, opId: 'tsd-1-1' });
  const b = await call('POST', `/api/cells/${c.addr}/pick`, { art: c.sku, qty: take, opId: 'tsd-2-1' });
  assert.strictEqual(a.status, 200);
  assert.strictEqual(b.status, 409);
  assert.strictEqual(b.data.available, c.qty - take);
  const again = await call('POST', `/api/cells/${c.addr}/pick`, { art: c.sku, qty: take, opId: 'tsd-2-1' });
  assert.strictEqual(again.status, 409, 'отказ тоже запоминается по opId');
});

test('размещение в чужую зону и сверх вместимости запрещено', async () => {
  const empty = db.prepare("SELECT addr FROM cell WHERE addr LIKE 'D-%' AND sku IS NULL AND blocked = 0 LIMIT 1").pluck().get();
  const r = await call('POST', `/api/cells/${empty}/put`, { art: 'FO-15208', qty: 1 });
  assert.strictEqual(r.data.code, 'WRONG_ZONE');
  const emptyA = db.prepare("SELECT addr FROM cell WHERE addr LIKE 'A-%' AND sku IS NULL AND blocked = 0 LIMIT 1").pluck().get();
  const over = await call('POST', `/api/cells/${emptyA}/put`, { art: 'FO-15208', qty: 41 });
  assert.strictEqual(over.data.code, 'OVER_CAPACITY');
});

test('сборка заказа целиком и учёт взятого', async () => {
  const oid = db.prepare('SELECT id FROM orders WHERE done = 0 ORDER BY id LIMIT 1').pluck().get();
  const r = await call('POST', `/api/orders/${oid}/pick?state=1`);
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.state);
  const o = r.data.state.orders.find((x) => x.id === oid);
  assert.strictEqual(o.done, 1);
  const again = await call('POST', `/api/orders/${oid}/pick`);
  assert.strictEqual(again.data.code, 'ORDER_DONE');
});

test('перемещение между ячейками одной зоны', async () => {
  const from = db.prepare("SELECT addr, sku, qty FROM cell WHERE sku = 'BD-40206' AND qty >= 2 AND blocked = 0 LIMIT 1").get();
  const to = db.prepare("SELECT addr FROM cell WHERE addr LIKE 'B-%' AND sku IS NULL AND blocked = 0 LIMIT 1").pluck().get();
  const r = await call('POST', '/api/move', { from: from.addr, to, qty: 1 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(db.prepare('SELECT sku FROM cell WHERE addr = ?').pluck().get(to), 'BD-40206');
});

test('скан ТСД: этикетка ячейки, артикул, заводской штрихкод; закреплённая ячейка вне зоны', async () => {
  const c = db.prepare("SELECT addr, sku FROM cell WHERE sku = 'BD-40206' LIMIT 1").get();
  const cell = await call('GET', `/api/scan?code=${encodeURIComponent(c.addr.toLowerCase().replace(/-/g, ' '))}`);
  assert.strictEqual(cell.status, 200);
  assert.strictEqual(cell.data.kind, 'cell');
  assert.strictEqual(cell.data.addr, c.addr);
  assert.strictEqual(cell.data.cell.sku, 'BD-40206');
  const art = await call('GET', '/api/scan?code=bd40206');
  assert.strictEqual(art.data.kind, 'sku');
  assert.strictEqual(art.data.sku.art, 'BD-40206');
  assert.ok(art.data.sku.cells.some((x) => x.addr === c.addr));
  db.prepare("UPDATE sku SET barcode = '4607012345678' WHERE art = 'BD-40206'").run();
  const bc = await call('GET', '/api/scan?code=4607012345678');
  assert.strictEqual(bc.data.sku.art, 'BD-40206');
  assert.strictEqual((await call('GET', '/api/scan?code=NOPE-0000')).data.code, 'UNKNOWN_CODE');
  assert.strictEqual((await call('GET', '/api/scan?code=')).status, 400);
  // ячейка закреплена за товаром из другой зоны — класть туда можно
  const zone = db.prepare("SELECT zone FROM sku WHERE art = 'FO-15208'").pluck().get();
  const other = db.prepare('SELECT addr FROM cell WHERE sku IS NULL AND blocked = 0 AND substr(addr, 1, 1) <> ? LIMIT 1').pluck().get(zone);
  db.prepare('UPDATE sku SET home = ? WHERE art = ?').run(JSON.stringify([other]), 'FO-15208');
  const put = await call('POST', `/api/cells/${other}/put`, { art: 'FO-15208', qty: 1 }, { 'X-Op-Id': 'scan-home-1' });
  assert.strictEqual(put.status, 200, JSON.stringify(put.data));
  const home = await call('GET', `/api/scan?code=${other}`);
  assert.deepStrictEqual(home.data.home.map((x) => x.art), ['FO-15208']);
  // адрес в другом написании: строчные буквы и без ведущих нулей
  const loose = other.toLowerCase().split('-').map((p) => (/^\d+$/.test(p) ? String(Number(p)) : p)).join('-');
  const put2 = await call('POST', `/api/cells/${loose}/put`, { art: 'FO-15208', qty: 1 });
  assert.strictEqual(put2.data.cell.addr, other);
  const rack = await call('GET', `/api/scan?code=${encodeURIComponent(c.addr.split('-').slice(0, -2).join('-'))}`);
  assert.strictEqual(rack.data.kind, 'rack');
  assert.ok(rack.data.cells.some((x) => x.addr === c.addr && x.sku === 'BD-40206'));
  // словарь для работы без сети
  const dict = await call('GET', '/api/tsd/dict');
  assert.ok(dict.data.addrs.includes(other));
  assert.ok(dict.data.skus.some((r) => r[0] === 'BD-40206' && r[4] === '4607012345678'));
  // привязка заводского штрихкода с ТСД
  const link = await call('POST', '/api/skus/FO-15208/barcode', { barcode: '2000000000017' });
  assert.strictEqual(link.status, 200, JSON.stringify(link.data));
  assert.strictEqual((await call('GET', '/api/scan?code=2000000000017')).data.sku.art, 'FO-15208');
  assert.strictEqual((await call('POST', '/api/skus/FO-15208/barcode', { barcode: '4607012345678' })).data.code, 'BARCODE_TAKEN');
  assert.strictEqual((await call('POST', '/api/skus/FO-15208/barcode', { barcode: other })).data.code, 'BARCODE_IS_CELL');
});

test('сброс демо доступен только администратору', async () => {
  assert.strictEqual((await call('POST', '/api/demo/reset')).status, 403);
  await call('POST', '/api/logout');
  await call('POST', '/api/login', { username: 'admin', password: 'secret2' });
  assert.strictEqual((await call('POST', '/api/demo/reset')).status, 200);
});
