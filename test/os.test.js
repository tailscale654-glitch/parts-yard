'use strict';
// Роли, админка, дашборды, отчёты, инвентаризация, каталог, документы, топология.
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

let server, base, db, dir, L;
const LAYOUT_FILE = path.join(__dirname, '..', 'layout.json');
const jars = {};

async function as(who, method, url, body) {
  const r = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(jars[who] ? { Cookie: jars[who] } : {}) },
    body: body ? JSON.stringify(body) : undefined, redirect: 'manual',
  });
  const sc = r.headers.get('set-cookie');
  if (sc) jars[who] = sc.split(';')[0];
  const type = r.headers.get('content-type') || '';
  const data = type.includes('json') ? await r.json() : await r.text();
  return { status: r.status, data, type, headers: r.headers };
}
const login = (who, pw) => as(who, 'POST', '/api/login', { username: who, password: pw });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyard-os-'));
  db = openDb(path.join(dir, 'w.db'));
  L = resolveLayout(db, LAYOUT_FILE);
  syncCells(db, L);
  seedDemo(db, L);
  addUser(db, 'boss', 'secret1', 'admin');
  addUser(db, 'chief', 'secret2', 'manager');
  addUser(db, 'keeper', 'secret3', 'storekeeper');
  addUser(db, 'watch', 'secret4', 'viewer');
  const app = createApp({ db, L, cfg: { ROOT: path.join(__dirname, '..'), demo: true, layoutPath: LAYOUT_FILE, dbPath: path.join(dir, 'w.db'),
    cookieName: 'pyard.sid', sessionDays: 1, secureCookie: false } });
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [u, p] of [['boss', 'secret1'], ['chief', 'secret2'], ['keeper', 'secret3'], ['watch', 'secret4']]) {
    assert.strictEqual((await login(u, p)).status, 200);
  }
});
after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('права ролей: наблюдатель только смотрит, кладовщик не создаёт документы', async () => {
  const me = await as('watch', 'GET', '/api/me');
  assert.ok(me.data.perms.includes('reports.view'));
  assert.ok(!me.data.perms.includes('stock.pick'));
  const c = db.prepare("SELECT addr, sku FROM cell WHERE sku IS NOT NULL AND blocked = 0 LIMIT 1").get();
  assert.strictEqual((await as('watch', 'POST', `/api/cells/${c.addr}/pick`, { art: c.sku, qty: 1 })).status, 403);
  assert.strictEqual((await as('keeper', 'POST', '/api/orders', { number: 'X1', dealer: 'Д', lines: [{ art: 'FO-15208', qty: 1 }] })).status, 403);
  assert.strictEqual((await as('keeper', 'GET', '/api/reports')).status, 403);
  assert.strictEqual((await as('chief', 'GET', '/api/admin/users')).status, 403);
  assert.strictEqual((await as('boss', 'GET', '/api/admin/users')).status, 200);
});

test('админка: создание пользователя, сброс пароля, защита последнего админа', async () => {
  const r = await as('boss', 'POST', '/api/admin/users', { username: 'newbie', full_name: 'Новиков Н.', role: 'storekeeper' });
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.password.length >= 8);
  assert.strictEqual((await login('newbie', r.data.password)).status, 200);
  const id = db.prepare("SELECT id FROM users WHERE username = 'newbie'").pluck().get();
  const p = await as('boss', 'POST', `/api/admin/users/${id}/password`, {});
  assert.ok(p.data.password);
  assert.strictEqual((await as('newbie', 'GET', '/api/me')).status, 401, 'сброс пароля завершил сеанс');

  const bossId = db.prepare("SELECT id FROM users WHERE username = 'boss'").pluck().get();
  db.prepare("UPDATE users SET active = 0 WHERE username = 'admin'").run();
  const self = await as('boss', 'PATCH', `/api/admin/users/${bossId}`, { role: 'viewer' });
  assert.strictEqual(self.data.code, 'LAST_ADMIN');
});

test('роли: своя роль, запрет повышения прав, удаление', async () => {
  const perms = ['dashboard.view', 'stock.view', 'stock.put'];
  assert.strictEqual((await as('boss', 'POST', '/api/admin/roles', { key: 'receiver', name: 'Приёмщик', perms })).status, 200);
  // начальнику склада дадим право на роли и проверим, что он не может выдать admin.users
  db.prepare("UPDATE roles SET perms = ? WHERE key = 'manager'").run(JSON.stringify(['admin.roles', 'stock.view', 'dashboard.view']));
  const esc = await as('chief', 'PUT', '/api/admin/roles/receiver', { name: 'Приёмщик', perms: ['admin.users'] });
  assert.strictEqual(esc.data.code, 'ESCALATION');
  assert.strictEqual((await as('boss', 'DELETE', '/api/admin/roles/receiver')).status, 200);
  assert.strictEqual((await as('boss', 'DELETE', '/api/admin/roles/viewer')).data.code, 'ROLE_BUILTIN');
});

test('каталог: добавление, импорт, удаление с проверками', async () => {
  const add = await as('chief2', 'GET', '/api/catalog'); // без входа
  assert.strictEqual(add.status, 401);
  db.prepare("UPDATE roles SET perms = ? WHERE key = 'manager'").run(JSON.stringify(require('../src/perms').BUILTIN_ROLES.find((r) => r.key === 'manager').perms));
  assert.strictEqual((await as('chief', 'POST', '/api/catalog', { art: 'NEW-1', name: 'Тест', zone: 'B', per: 10, min_qty: 5, isNew: true })).status, 200);
  const dup = await as('chief', 'POST', '/api/catalog', { art: 'NEW-1', name: 'Тест', zone: 'B', per: 10, isNew: true });
  assert.strictEqual(dup.data.code, 'SKU_EXISTS');
  const imp = await as('chief', 'POST', '/api/catalog/import', { rows: [{ art: 'NEW-2', name: 'Два', zone: 'C', per: 3 }, { art: 'NEW-1', name: 'Тест 1', zone: 'B', per: 12 }] });
  assert.deepStrictEqual([imp.data.added, imp.data.updated], [1, 1]);
  const bad = await as('chief', 'POST', '/api/catalog/import', { rows: [{ art: 'NEW-3', name: 'x', zone: 'Z', per: 1 }] });
  assert.strictEqual(bad.data.code, 'BAD_ZONE');
  assert.strictEqual((await as('chief', 'DELETE', '/api/catalog/NEW-2')).status, 200);
  assert.strictEqual((await as('chief', 'DELETE', '/api/catalog/FO-15208')).data.code, 'SKU_USED');
});

test('документы: поставка и заказ из веба', async () => {
  const r = await as('chief', 'POST', '/api/receipts', { doc: 'ПТ-TEST', gate: '1', lines: [{ art: 'NEW-1', qty: 7 }] });
  assert.strictEqual(r.status, 200);
  const list = await as('keeper', 'GET', '/api/receipts?state=open');
  assert.ok(list.data.docs.some((d) => d.doc === 'ПТ-TEST'));
  const o = await as('chief', 'POST', '/api/orders', { number: 'ЗК-TEST', dealer: 'Тест', due: '16:00', lines: [{ art: 'FO-15208', qty: 2 }] });
  assert.strictEqual(o.status, 200);
  assert.strictEqual((await as('chief', 'POST', '/api/orders', { number: 'ЗК-TEST', dealer: 'Тест', lines: [{ art: 'FO-15208', qty: 2 }] })).data.code, 'ORDER_EXISTS');
  assert.strictEqual((await as('chief', 'DELETE', `/api/orders/${o.data.id}`)).status, 200);
  assert.strictEqual((await as('chief', 'DELETE', '/api/receipts/doc/' + encodeURIComponent('ПТ-TEST'))).status, 200);
});

test('метрики: все считаются без ошибок', async () => {
  const cat = await as('watch', 'GET', '/api/metrics');
  const items = cat.data.metrics.map((m) => ({ metric: m.id, params: { days: 14, limit: 5 } }));
  items.push({ metric: 'occupancy_pct', params: { zone: 'A' } });
  const r = await as('watch', 'POST', '/api/metrics/batch', { items });
  for (const [i, res] of r.data.results.entries()) assert.ok(!res.error, `${items[i].metric}: ${res.error}`);
  const flow = r.data.results[cat.data.metrics.findIndex((m) => m.id === 'flow_daily')];
  assert.strictEqual(flow.labels.length, 14);
  assert.ok(flow.series[1].values.some((v) => v > 0), 'в демо есть история отбора');
});

test('дашборды: личный у кладовщика, общий только с правом конструктора', async () => {
  const list = await as('keeper', 'GET', '/api/dashboards');
  assert.ok(list.data.dashboards.length >= 1);
  assert.strictEqual(list.data.dashboards[0].canEdit, false);
  const mine = await as('keeper', 'POST', '/api/dashboards', { name: 'Мой', widgets: [{ metric: 'picked_today', viz: 'kpi', w: 1 }] });
  assert.strictEqual(mine.status, 200);
  assert.strictEqual((await as('keeper', 'POST', '/api/dashboards', { name: 'Общий', shared: true, widgets: [] })).status, 403);
  assert.strictEqual((await as('keeper', 'PUT', `/api/dashboards/${list.data.dashboards[0].id}`, { name: 'x' })).status, 403);
  const bad = await as('keeper', 'PUT', `/api/dashboards/${mine.data.id}`, { widgets: [{ metric: 'nope' }] });
  assert.strictEqual(bad.data.code, 'BAD_METRIC');
  assert.strictEqual((await as('chief', 'PUT', `/api/dashboards/${list.data.dashboards[0].id}`, { name: 'Обзор' })).status, 200);
  assert.strictEqual((await as('watch', 'GET', '/api/dashboards')).data.dashboards.some((d) => d.name === 'Мой'), false, 'чужой личный не виден');
});

test('отчёты: все строятся, CSV для Excel', async () => {
  const list = await as('watch', 'GET', '/api/reports');
  for (const r of list.data.reports) {
    const res = await as('watch', 'GET', `/api/reports/${r.id}?from=2000-01-01&to=2100-01-01`);
    assert.strictEqual(res.status, 200, r.id);
    assert.ok(Array.isArray(res.data.rows), r.id);
  }
  const abc = await as('watch', 'GET', '/api/reports/abc?from=2000-01-01&to=2100-01-01');
  assert.ok(abc.data.rows.some((x) => x.cls === 'A') && abc.data.rows.some((x) => x.cls === 'C'));
  const csv = await as('watch', 'GET', '/api/reports/stock_sku?format=csv');
  assert.ok(csv.type.includes('text/csv'));
  assert.ok(csv.data.replace(/^\uFEFF/, '').startsWith('Артикул;'));
  const raw = Buffer.from(await (await fetch(base + '/api/reports/stock_sku?format=csv', { headers: { Cookie: jars.watch } })).arrayBuffer());
  assert.deepStrictEqual([...raw.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM для Excel');
  assert.ok(/filename\*=UTF-8''/.test(csv.headers.get('content-disposition')));
});

test('инвентаризация: задание, подсчёт, закрытие меняет остатки', async () => {
  const t = await as('chief', 'POST', '/api/inventory', { name: 'Ряд B-01', rows: ['B-01'], onlyStocked: true });
  assert.strictEqual(t.status, 200);
  assert.strictEqual((await as('chief', 'POST', '/api/inventory', { rows: ['B-01'] })).data.code, 'INV_OVERLAP');
  const task = await as('keeper', 'GET', `/api/inventory/${t.data.id}`);
  const [l1, l2] = task.data.lines;
  await as('keeper', 'POST', `/api/inventory/${t.data.id}/lines/${l1.id}`, { qty: l1.qty_expected + 3 });
  await as('keeper', 'POST', `/api/inventory/${t.data.id}/lines/${l2.id}`, { qty: 0 });
  assert.strictEqual((await as('keeper', 'POST', `/api/inventory/${t.data.id}/close`)).status, 403);
  const c = await as('chief', 'POST', `/api/inventory/${t.data.id}/close`);
  assert.strictEqual(c.data.changed, 2);
  assert.strictEqual(db.prepare('SELECT qty FROM cell WHERE addr = ?').pluck().get(l1.addr), l1.qty_expected + 3);
  assert.strictEqual(db.prepare('SELECT sku FROM cell WHERE addr = ?').pluck().get(l2.addr), null);
  const rep = await as('chief', 'GET', `/api/reports/inventory?task=${t.data.id}`);
  assert.strictEqual(rep.data.rows.length, 2);
});

test('топология: предпросмотр, добавление зоны, запрет удаления ячеек с товаром', async () => {
  const cur = await as('boss', 'GET', '/api/admin/layout');
  const zones = cur.data.zones.map((z) => ({ ...z }));
  const shrunk = zones.map((z) => (z.id === 'A' ? { ...z, rows: 1 } : z));
  const p = await as('boss', 'POST', '/api/admin/layout/preview', { zones: shrunk });
  assert.ok(p.data.impact.lostCount > 0);
  assert.strictEqual((await as('boss', 'PUT', '/api/admin/layout', { zones: shrunk })).data.code, 'LAYOUT_STOCK');
  const bigger = zones.map((z) => (z.id === 'D' ? { ...z, racks: 9 } : z));
  const ok = await as('boss', 'PUT', '/api/admin/layout', { zones: bigger });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.data));
  assert.strictEqual(L.meta.has('D-01-09-1-1'), true);
  const rev = await as('keeper', 'GET', '/api/rev');
  assert.ok(rev.data.layoutRev > 1);
  assert.strictEqual((await as('boss', 'POST', '/api/admin/layout/reset')).status, 200);
  assert.strictEqual(L.meta.has('D-01-09-1-1'), false);
});

test('настройки и аудит', async () => {
  assert.strictEqual((await as('boss', 'PUT', '/api/admin/settings', { warehouse_name: 'Склад №1', poll_seconds: 5 })).status, 200);
  assert.strictEqual((await as('watch', 'GET', '/api/me')).data.settings.name, 'Склад №1');
  assert.strictEqual((await as('boss', 'PUT', '/api/admin/settings', { poll_seconds: 1 })).data.code, 'BAD_VALUE');
  const a = await as('boss', 'GET', '/api/admin/audit?q=' + encodeURIComponent('Настройки'));
  assert.ok(a.data.rows.length >= 1);
  const pub = await as('anon', 'GET', '/api/public');
  assert.strictEqual(pub.data.name, 'Склад №1');
});

test('фирменный стиль: подпись, логотип, фото', async () => {
  const pub = await as('anon', 'GET', '/api/public');
  assert.strictEqual(pub.data.line1, 'JAC MOTORS');
  const photo = await fetch(base + '/brand/photo');
  assert.strictEqual(photo.status, 200);
  assert.match(photo.headers.get('content-type'), /image\/jpeg/);
  assert.strictEqual((await fetch(base + '/brand/logo')).status, 404);
  const png = 'data:image/png;base64,' + Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA6364F8FF3F0003010100A50E6A8B0000000049454E44AE426082', 'hex').toString('base64');
  assert.strictEqual((await as('watch', 'POST', '/api/admin/brand/logo', { dataUrl: png })).status, 403);
  const fake = 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64');
  assert.strictEqual((await as('boss', 'POST', '/api/admin/brand/logo', { dataUrl: fake })).data.code, 'BAD_IMAGE');
  assert.strictEqual((await as('boss', 'POST', '/api/admin/brand/logo', { dataUrl: png })).status, 200);
  const logo = await fetch(base + '/brand/logo');
  assert.strictEqual(logo.status, 200);
  assert.strictEqual(logo.headers.get('content-type'), 'image/png');
  assert.strictEqual((await as('anon', 'GET', '/api/public')).data.hasLogo, true);
  assert.strictEqual((await as('boss', 'PUT', '/api/admin/settings', { brand_line1: 'ТЕСТ' })).status, 200);
  assert.strictEqual((await as('anon', 'GET', '/api/public')).data.line1, 'ТЕСТ');
  assert.strictEqual((await as('boss', 'DELETE', '/api/admin/brand/logo')).status, 200);
  assert.strictEqual((await fetch(base + '/brand/logo')).status, 404);
});
