'use strict';
// Приложение для ТСД: загрузка APK администратором, страница установки, проверка версии.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { resolveLayout } = require('../src/layout');
const { openDb, syncCells } = require('../src/db');
const { createApp } = require('../src/app');
const { addUser } = require('../src/auth');
const { readApk } = require('../src/apk');

const LAYOUT_FILE = path.join(__dirname, '..', 'layout.json');
let dir, db, server, base, cookie = null;

// --- минимальный APK: zip с двоичным AndroidManifest.xml ---
function axml({ pkg, code, name }) {
  const strs = ['versionCode', 'versionName', 'package', 'manifest', 'http://schemas.android.com/apk/res/android', pkg, name];
  const enc = strs.map((s) => { const b = Buffer.alloc(2 + s.length * 2 + 2); b.writeUInt16LE(s.length, 0); b.write(s, 2, 'utf16le'); return b; });
  let data = Buffer.concat(enc);
  if (data.length % 4) data = Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
  const offs = Buffer.alloc(4 * strs.length);
  let o = 0;
  enc.forEach((b, i) => { offs.writeUInt32LE(o, i * 4); o += b.length; });
  const ph = Buffer.alloc(28);
  ph.writeUInt16LE(0x0001, 0); ph.writeUInt16LE(28, 2); ph.writeUInt32LE(28 + offs.length + data.length, 4);
  ph.writeUInt32LE(strs.length, 8); ph.writeUInt32LE(0, 12); ph.writeUInt32LE(0, 16); ph.writeUInt32LE(28 + offs.length, 20); ph.writeUInt32LE(0, 24);
  const pool = Buffer.concat([ph, offs, data]);
  const attrs = [[0, 0x10, code, 0xffffffff], [1, 0x03, 6, 6], [2, 0x03, 5, 5]];
  const el = Buffer.alloc(16 + 20 + 20 * attrs.length);
  el.writeUInt16LE(0x0102, 0); el.writeUInt16LE(16, 2); el.writeUInt32LE(el.length, 4); el.writeUInt32LE(1, 8); el.writeUInt32LE(0xffffffff, 12);
  el.writeUInt32LE(0xffffffff, 16); el.writeUInt32LE(3, 20); el.writeUInt16LE(20, 24); el.writeUInt16LE(20, 26); el.writeUInt16LE(attrs.length, 28);
  attrs.forEach(([n, t, d, raw], i) => {
    const a = 36 + i * 20;
    el.writeUInt32LE(n === 2 ? 0xffffffff : 4, a); el.writeUInt32LE(n, a + 4); el.writeUInt32LE(raw, a + 8);
    el.writeUInt16LE(8, a + 12); el[a + 14] = 0; el[a + 15] = t; el.writeUInt32LE(d, a + 16);
  });
  const head = Buffer.alloc(8);
  head.writeUInt16LE(0x0003, 0); head.writeUInt16LE(8, 2); head.writeUInt32LE(8 + pool.length + el.length, 4);
  return Buffer.concat([head, pool, el]);
}
function zip(files) {
  const locals = [], central = [];
  let off = 0;
  for (const [name, raw] of files) {
    const comp = zlib.deflateRawSync(raw), nb = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, comp); central.push(ch, nb);
    off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const apk = (pkg, code, name) => zip([['AndroidManifest.xml', axml({ pkg, code, name })], ['classes.dex', Buffer.alloc(4000, 7)]]);

async function call(method, url, body, headers = {}) {
  const raw = Buffer.isBuffer(body);
  const r = await fetch(base + url, {
    method, redirect: 'manual',
    headers: { ...(raw ? { 'Content-Type': 'application/vnd.android.package-archive' } : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body == null ? undefined : raw ? body : JSON.stringify(body),
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const type = r.headers.get('content-type') || '';
  const data = type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data, type, disp: r.headers.get('content-disposition') };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyard-tsd-'));
  db = openDb(path.join(dir, 'w.db'));
  const L = resolveLayout(db, LAYOUT_FILE);
  syncCells(db, L);
  addUser(db, 'ivan', 'secret1', 'storekeeper');
  addUser(db, 'admin', 'secret2', 'admin');
  const app = createApp({ db, L, cfg: { ROOT: path.join(__dirname, '..'), demo: false, layoutPath: LAYOUT_FILE, dbPath: path.join(dir, 'w.db'), cookieName: 'pyard.sid', sessionDays: 1, secureCookie: false } });
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('APK: версия и пакет из двоичного манифеста', () => {
  assert.deepStrictEqual(readApk(apk('uz.jacmotors.sklad', 12, '1.0.12')), { package: 'uz.jacmotors.sklad', versionCode: 12, versionName: '1.0.12' });
  assert.throws(() => readApk(Buffer.from('not an apk'.repeat(30))), /не APK/);
});

test('приложение для ТСД: загрузка, страница установки, обновление', async () => {
  // до загрузки: страница есть, файла нет, версия 0
  const page0 = await call('GET', '/app');
  assert.strictEqual(page0.status, 200);
  assert.match(page0.data.toString(), /ещё не загружено/);
  assert.strictEqual((await call('GET', '/app/sklad-jac.apk')).status, 404);
  await call('POST', '/api/login', { username: 'ivan', password: 'secret1' });
  assert.strictEqual((await call('GET', '/api/tsd/app')).data.versionCode, 0);
  // кладовщик загружать не может
  assert.strictEqual((await call('POST', '/api/admin/tsd-app', apk('uz.jacmotors.sklad', 3, '1.0.3'))).status, 403);
  await call('POST', '/api/logout');
  await call('POST', '/api/login', { username: 'admin', password: 'secret2' });
  assert.strictEqual((await call('POST', '/api/admin/tsd-app', apk('com.example.other', 3, '1.0.3'))).data.code, 'WRONG_APP');
  assert.strictEqual((await call('POST', '/api/admin/tsd-app', Buffer.from('x'.repeat(500)))).data.code, 'BAD_APK');
  const up = await call('POST', '/api/admin/tsd-app', apk('uz.jacmotors.sklad', 5, '1.0.5'));
  assert.strictEqual(up.status, 200, JSON.stringify(up.data));
  assert.strictEqual(up.data.versionName, '1.0.5');
  // старую версию поверх новой — только явно
  assert.strictEqual((await call('POST', '/api/admin/tsd-app', apk('uz.jacmotors.sklad', 4, '1.0.4'))).data.code, 'OLDER_VERSION');
  const info = await call('GET', '/api/tsd/app');
  assert.strictEqual(info.data.versionCode, 5);
  assert.strictEqual(info.data.url, '/app/sklad-jac.apk');
  // скачивание без входа
  cookie = null;
  const file = await call('GET', '/app/sklad-jac.apk');
  assert.strictEqual(file.status, 200);
  assert.match(file.type, /android\.package-archive/);
  assert.match(file.disp, /sklad-jac-1\.0\.5\.apk/);
  assert.strictEqual(readApk(file.data).versionCode, 5);
  assert.match((await call('GET', '/app')).data.toString(), /Скачать версию 1\.0\.5/);
  assert.strictEqual((await call('GET', '/api/tsd/app')).status, 401);
});
