'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { BUILTIN_ROLES } = require('./perms');

// Базовая схема (версия 1). Всё, что появилось позже, добавляется миграциями ниже,
// поэтому уже работающие базы обновляются при старте без потери данных.
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v INTEGER NOT NULL);
INSERT OR IGNORE INTO meta(k, v) VALUES ('rev', 1), ('schema', 1), ('layout_rev', 1);

CREATE TABLE IF NOT EXISTS sku(
  art  TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  zone TEXT NOT NULL,
  per  INTEGER NOT NULL CHECK (per > 0)
);
CREATE TABLE IF NOT EXISTS cell(
  addr    TEXT PRIMARY KEY,
  sku     TEXT REFERENCES sku(art),
  qty     INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  blocked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS cell_sku ON cell(sku);
CREATE TABLE IF NOT EXISTS receipt(
  id INTEGER PRIMARY KEY, doc TEXT NOT NULL, gate TEXT, art TEXT NOT NULL REFERENCES sku(art),
  qty INTEGER NOT NULL CHECK (qty > 0), placed INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, dealer TEXT NOT NULL, due TEXT,
  done INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_line(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  art TEXT NOT NULL REFERENCES sku(art), qty INTEGER NOT NULL CHECK (qty > 0), picked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oplog(
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, op TEXT NOT NULL, addr TEXT, art TEXT, qty INTEGER, user TEXT, ref TEXT
);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, pass TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('operator', 'admin')),
  active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  sid TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS client_ops(
  op_id TEXT PRIMARY KEY, user_id INTEGER, ts TEXT NOT NULL, status INTEGER NOT NULL, result TEXT NOT NULL
);
`;

const KINDS = {
  'Размещение': 'put', 'Отбор': 'pick', 'Пересчёт': 'count', 'Перемещение': 'move',
  'Блокировка': 'block', 'Разблокировка': 'block', 'Недостача': 'shortage',
  'Заказ собран': 'order', 'Заказ закрыт': 'order', 'Заказ загружен': 'doc', 'Заказ создан': 'doc',
  'Поставка загружена': 'doc', 'Поставка создана': 'doc', 'Нет места, остаток в буфере': 'receipt',
  'Инвентаризация': 'inv',
};
function kindOf(op) {
  if (KINDS[op]) return KINDS[op];
  if (op.startsWith('Недостача')) return 'shortage';
  if (op.startsWith('Инвентаризация')) return 'inv';
  return 'system';
}

const MIGRATIONS = [
  null, // 0
  null, // 1 — базовая схема
  // 2 — WarehouseOS: роли, настройки, аудит, дашборды, инвентаризация, виды операций
  (db) => {
    db.exec(`
      CREATE TABLE roles(
        key TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        perms TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE users_new(
        id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, pass TEXT NOT NULL,
        full_name TEXT, role TEXT NOT NULL REFERENCES roles(key),
        active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL, last_login TEXT
      );
    `);
    const ins = db.prepare('INSERT INTO roles(key, name, description, perms, builtin) VALUES (?,?,?,?,1)');
    for (const r of BUILTIN_ROLES) ins.run(r.key, r.name, r.description, JSON.stringify(r.perms));
    db.exec(`
      INSERT INTO users_new(id, username, pass, role, active, created)
        SELECT id, username, pass, CASE role WHEN 'admin' THEN 'admin' ELSE 'storekeeper' END, active, created FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;

      ALTER TABLE sku ADD COLUMN min_qty INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE oplog ADD COLUMN kind TEXT;
      CREATE INDEX oplog_ts ON oplog(ts);
      CREATE INDEX oplog_kind_ts ON oplog(kind, ts);

      CREATE TABLE settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE audit(
        id INTEGER PRIMARY KEY, ts TEXT NOT NULL, user TEXT, action TEXT NOT NULL, details TEXT
      );
      CREATE INDEX audit_ts ON audit(ts);
      CREATE TABLE dashboards(
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner TEXT, shared INTEGER NOT NULL DEFAULT 0,
        widgets TEXT NOT NULL DEFAULT '[]', position INTEGER NOT NULL DEFAULT 0,
        created TEXT NOT NULL, updated TEXT NOT NULL
      );
      CREATE TABLE inv_task(
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
        created_by TEXT, created TEXT NOT NULL, closed_by TEXT, closed_at TEXT
      );
      CREATE TABLE inv_line(
        id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES inv_task(id) ON DELETE CASCADE,
        addr TEXT NOT NULL, art_expected TEXT, qty_expected INTEGER NOT NULL,
        art_counted TEXT, qty_counted INTEGER, counted_by TEXT, counted_at TEXT,
        UNIQUE(task_id, addr)
      );
      CREATE INDEX receipt_created ON receipt(created);
      CREATE INDEX orders_created ON orders(created);
    `);
    const upd = db.prepare('UPDATE oplog SET kind = ? WHERE id = ?');
    for (const r of db.prepare('SELECT id, op FROM oplog').all()) upd.run(kindOf(r.op), r.id);
    db.prepare("INSERT OR IGNORE INTO settings(k, v) VALUES ('warehouse_name', ?), ('warehouse_subtitle', ?)")
      .run('Адресный склад запчастей', 'Центральный склад сети');
  },
  // 3 — интеграция с Carsale: внешние поля каталога и журнал синхронизаций
  (db) => {
    db.exec(`
      ALTER TABLE sku ADD COLUMN price INTEGER;
      ALTER TABLE sku ADD COLUMN unit TEXT;
      ALTER TABLE sku ADD COLUMN brand TEXT;
      ALTER TABLE sku ADD COLUMN source TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE sku ADD COLUMN ext_id TEXT;
      ALTER TABLE sku ADD COLUMN ext_type TEXT;
      ALTER TABLE sku ADD COLUMN ext_location TEXT;
      ALTER TABLE sku ADD COLUMN ext_qty INTEGER;
      ALTER TABLE sku ADD COLUMN ext_reserved INTEGER;
      ALTER TABLE sku ADD COLUMN ext_active INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE sku ADD COLUMN ext_synced TEXT;
      ALTER TABLE sku ADD COLUMN zone_manual INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE sync_run(
        id INTEGER PRIMARY KEY, source TEXT NOT NULL, started TEXT NOT NULL, finished TEXT,
        status TEXT NOT NULL DEFAULT 'running', trigger TEXT, user TEXT, stats TEXT, error TEXT
      );
      CREATE INDEX sync_run_started ON sync_run(source, started);
    `);
  },
  // 4 — справочник дилеров (свои и из Carsale), заказы ссылаются на дилера
  (db) => {
    db.exec(`
      CREATE TABLE dealer(
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL, name_key TEXT NOT NULL,
        code TEXT, region TEXT, city TEXT, address TEXT, phone TEXT, inn TEXT, note TEXT,
        source TEXT NOT NULL DEFAULT 'local', ext_id TEXT UNIQUE,
        active INTEGER NOT NULL DEFAULT 1,
        created TEXT NOT NULL, updated TEXT, synced TEXT
      );
      CREATE INDEX dealer_name_key ON dealer(name_key);
      ALTER TABLE orders ADD COLUMN dealer_id INTEGER REFERENCES dealer(id);
      CREATE INDEX orders_dealer ON orders(dealer_id);
    `);
    // дилеры из уже существующих заказов становятся «своими» записями справочника
    require('./dealers').linkOrderDealers(db);
  },
];

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function migrate(db) {
  let v = db.prepare("SELECT v FROM meta WHERE k = 'schema'").pluck().get();
  const target = MIGRATIONS.length - 1;
  if (v >= target) return;
  // перестройка таблиц требует отключённых внешних ключей (переключаются только вне транзакции)
  db.pragma('foreign_keys = OFF');
  try {
    while (v < target) {
      const next = v + 1;
      db.transaction(() => {
        MIGRATIONS[next](db);
        db.prepare("UPDATE meta SET v = ? WHERE k = 'schema'").run(next);
      })();
      console.log(`База обновлена до версии ${next}`);
      v = next;
    }
    const bad = db.pragma('foreign_key_check');
    if (bad.length) console.warn('ВНИМАНИЕ: нарушены внешние ключи после миграции', bad.slice(0, 5));
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_V1);
  db.exec("INSERT OR IGNORE INTO meta(k, v) VALUES ('layout_rev', 1)");
  migrate(db);
  db.pragma('foreign_keys = ON');
  return db;
}

// Ячейки по топологии: новые добавляются, существующие не трогаются
function syncCells(db, L) {
  const ins = db.prepare('INSERT OR IGNORE INTO cell(addr) VALUES (?)');
  db.transaction(() => { for (const a of L.meta.keys()) ins.run(a); })();
  const stray = db.prepare('SELECT addr FROM cell WHERE (sku IS NOT NULL OR blocked = 1)').pluck().all()
    .filter((a) => !L.meta.has(a));
  if (stray.length) {
    console.warn(`ВНИМАНИЕ: ${stray.length} ячеек с остатком нет в топологии (первые: ${stray.slice(0, 5).join(', ')})`);
  }
  return stray;
}

function getSetting(db, k, dflt) {
  const v = db.prepare('SELECT v FROM settings WHERE k = ?').pluck().get(k);
  return v === undefined ? dflt : v;
}
function setSetting(db, k, v) {
  db.prepare('INSERT INTO settings(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}
function audit(db, user, action, details) {
  db.prepare('INSERT INTO audit(ts, user, action, details) VALUES (?,?,?,?)')
    .run(now(), user || null, action, details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details)));
}

module.exports = { openDb, syncCells, now, kindOf, getSetting, setSetting, audit };
