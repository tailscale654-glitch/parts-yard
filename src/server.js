'use strict';
const cfg = require('./config');
const { resolveLayout } = require('./layout');
const { openDb, syncCells } = require('./db');
const { createApp } = require('./app');

const db = openDb(cfg.dbPath);
const L = resolveLayout(db, cfg.layoutPath);
syncCells(db, L);
const users = db.prepare('SELECT COUNT(*) FROM users WHERE active = 1').pluck().get();
const app = createApp({ db, L, cfg });

app.locals.carsale.schedule();
if (cfg.carsale.login) console.log(`Carsale: синхронизация от имени ${cfg.carsale.login}`);

const server = app.listen(cfg.port, cfg.bind, () => {
  console.log(`WarehouseOS: http://${cfg.bind}:${cfg.port} (база ${cfg.dbPath}, ячеек ${L.meta.size}, пользователей ${users}${cfg.demo ? ', демо-режим' : ''})`);
  if (!users) console.warn('Нет ни одного пользователя. Создайте: sudo parts-yard user-add admin --role admin');
});

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
