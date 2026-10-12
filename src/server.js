'use strict';
const cfg = require('./config');
const { loadLayout } = require('./layout');
const { openDb } = require('./db');
const { createApp } = require('./app');

const L = loadLayout(cfg.layoutPath);
const db = openDb(cfg.dbPath, L.meta);
const users = db.prepare('SELECT COUNT(*) FROM users WHERE active = 1').pluck().get();
const app = createApp({ db, L, cfg });

const server = app.listen(cfg.port, cfg.bind, () => {
  console.log(`Адресный склад: http://${cfg.bind}:${cfg.port} (база ${cfg.dbPath}, ячеек ${L.meta.size}, пользователей ${users}${cfg.demo ? ', демо-режим' : ''})`);
  if (!users) console.warn('Нет ни одного пользователя. Создайте: parts-yard user-add admin --role admin');
});

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
