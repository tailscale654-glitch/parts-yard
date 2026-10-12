'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v INTEGER NOT NULL);
INSERT OR IGNORE INTO meta(k, v) VALUES ('rev', 1), ('schema', 1);

CREATE TABLE IF NOT EXISTS sku(
  art  TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  zone TEXT NOT NULL,
  per  INTEGER NOT NULL CHECK (per > 0)        -- вместимость одной ячейки, шт
);
CREATE TABLE IF NOT EXISTS cell(
  addr    TEXT PRIMARY KEY,                    -- A-02-07-3-1
  sku     TEXT REFERENCES sku(art),
  qty     INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  blocked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS cell_sku ON cell(sku);

CREATE TABLE IF NOT EXISTS receipt(            -- строка поставки к размещению
  id      INTEGER PRIMARY KEY,
  doc     TEXT NOT NULL,
  gate    TEXT,
  art     TEXT NOT NULL REFERENCES sku(art),
  qty     INTEGER NOT NULL CHECK (qty > 0),
  placed  INTEGER NOT NULL DEFAULT 0,
  done    INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders(
  id      INTEGER PRIMARY KEY,
  number  TEXT NOT NULL UNIQUE,
  dealer  TEXT NOT NULL,
  due     TEXT,
  done    INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_line(
  id       INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  art      TEXT NOT NULL REFERENCES sku(art),
  qty      INTEGER NOT NULL CHECK (qty > 0),
  picked   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oplog(
  id   INTEGER PRIMARY KEY,
  ts   TEXT NOT NULL,
  op   TEXT NOT NULL,
  addr TEXT, art TEXT, qty INTEGER,
  user TEXT,
  ref  TEXT                                    -- поставка / заказ
);
CREATE TABLE IF NOT EXISTS users(
  id       INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  pass     TEXT NOT NULL,
  role     TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('operator', 'admin')),
  active   INTEGER NOT NULL DEFAULT 1,
  created  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  sid     TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
-- идемпотентность: повтор операции из офлайн-очереди ТСД возвращает сохранённый ответ
CREATE TABLE IF NOT EXISTS client_ops(
  op_id   TEXT PRIMARY KEY,
  user_id INTEGER,
  ts      TEXT NOT NULL,
  status  INTEGER NOT NULL,
  result  TEXT NOT NULL
);
`;

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function openDb(file, meta) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  // ячейки по layout.json: новые добавляются, существующие не трогаются
  const ins = db.prepare('INSERT OR IGNORE INTO cell(addr) VALUES (?)');
  db.transaction(() => { for (const a of meta.keys()) ins.run(a); })();
  const stray = db.prepare('SELECT addr FROM cell WHERE (sku IS NOT NULL OR blocked = 1)').all()
    .map((r) => r.addr).filter((a) => !meta.has(a));
  if (stray.length) {
    console.warn(`ВНИМАНИЕ: ${stray.length} ячеек с остатком нет в layout.json (первые: ${stray.slice(0, 5).join(', ')})`);
  }
  return db;
}

module.exports = { openDb, now };
