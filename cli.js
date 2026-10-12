#!/usr/bin/env node
'use strict';
// Командная строка: база, пользователи, загрузка и выгрузка CSV.
const fs = require('fs');
const cfg = require('./src/config');
const { resolveLayout } = require('./src/layout');
const { openDb, syncCells, now, audit } = require('./src/db');
const { addUser, genPassword } = require('./src/auth');
const { seedDemo } = require('./src/demo');
const { createCarsaleSync } = require('./src/carsale');

const HELP = `WarehouseOS — адресный склад запчастей, команды

  init [--demo]                         создать базу и ячейки по layout.json (--demo стирает данные!)
  user-add <логин> [--role <роль>] [--password <пароль>] [--name "Фамилия Имя"]
                                        создать пользователя или сменить ему пароль/роль
                                        роли: admin, manager, storekeeper, viewer и свои из админки
  user-del <логин>                      отключить пользователя и завершить его сессии
  user-list                             список пользователей
  role-list                             список ролей
  import-skus <файл.csv>                каталог: артикул;наименование;зона;вместимость_ячейки[;минимум]
  import-receipt <файл.csv> --doc <№> [--gate <ворота>]
                                        поставка: артикул;количество
  import-order <файл.csv> --number <№> --dealer <дилер> [--due 15:00]
                                        заказ дилера: артикул;количество
  export-stock <файл.csv>               остатки по адресам
  backup <файл.db>                      резервная копия базы на ходу
  carsale-sync                          забрать каталог и остатки из Carsale сейчас
  carsale-status                        состояние интеграции и последние синхронизации

Без пароля в user-add он будет создан случайным и выведен на экран.`;

function die(msg) { console.error(msg); process.exit(1); }

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(argv[i]);
  }
  return { pos, opt };
}

function readRows(file, ncols, maxCols = ncols) {
  if (!file) die('Укажите файл');
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch (e) { die(`Не удалось прочитать ${file}: ${e.message}`); }
  const lines = text.split(/\r?\n/);
  const first = lines[0] || '';
  const delim = first.includes('\t') ? '\t' : (first.split(';').length >= first.split(',').length ? ';' : ',');
  const rows = [];
  lines.forEach((line, idx) => {
    if (!line.trim()) return;
    const row = splitCsv(line, delim).map((c) => c.trim());
    const n = idx + 1;
    if (row.length < ncols) die(`Строка ${n}: ожидается колонок ${ncols}, получено ${row.length}`);
    if (n === 1 && !/^-?\d+$/.test(row[ncols - 1])) return; // заголовок
    rows.push([n, row.slice(0, maxCols)]);
  });
  return rows;
}

function splitCsv(line, d) {
  const out = []; let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === d) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function toInt(v, n) {
  if (!/^\d+$/.test(v) || +v <= 0) die(`Строка ${n}: «${v}» — нужно целое число больше нуля`);
  return +v;
}

function checkSkus(db, rows) {
  const known = new Set(db.prepare('SELECT art FROM sku').pluck().all());
  const bad = rows.filter(([, r]) => !known.has(r[0]));
  if (bad.length) die('Неизвестные артикулы: ' + bad.slice(0, 10).map(([n, r]) => `стр.${n} ${r[0]}`).join(', '));
}

const bump = (db) => db.exec("UPDATE meta SET v = v + 1 WHERE k = 'rev'");

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') { console.log(HELP); return; }
  const db = openDb(cfg.dbPath);
  const L = resolveLayout(db, cfg.layoutPath);
  syncCells(db, L);

  switch (cmd) {
    case 'init':
      if (opt.demo) seedDemo(db, L);
      console.log(`База готова: ${cfg.dbPath}, ячеек ${L.meta.size}${opt.demo ? ', демо-данные загружены' : ''}`);
      break;

    case 'user-add': {
      const name = pos[0];
      if (!name) die('Укажите логин: user-add <логин>');
      const role = opt.role && opt.role !== true ? String(opt.role) : 'storekeeper';
      const generated = !opt.password || opt.password === true;
      const pw = generated ? genPassword() : String(opt.password);
      try { addUser(db, name, pw, role, opt.name && opt.name !== true ? String(opt.name) : null); } catch (e) { die(e.message); }
      audit(db, 'консоль', 'Пользователь сохранён', { username: name, role });
      const uid = db.prepare('SELECT id FROM users WHERE username = ?').pluck().get(name);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid);
      const rk = db.prepare('SELECT role FROM users WHERE username = ?').pluck().get(name);
      console.log(`Пользователь ${name} (${rk}) сохранён.${generated ? ` Пароль: ${pw}` : ''}`);
      break;
    }
    case 'user-del': {
      const r = db.prepare('UPDATE users SET active = 0 WHERE username = ?').run(pos[0] || '');
      if (!r.changes) die(`Пользователь ${pos[0]} не найден`);
      db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(pos[0]);
      console.log(`Пользователь ${pos[0]} отключён`);
      break;
    }
    case 'user-list':
      for (const u of db.prepare('SELECT username, full_name, role, active, last_login FROM users ORDER BY username').all()) {
        console.log(`${u.username.padEnd(16)} ${(u.full_name || '').padEnd(22)} ${u.role.padEnd(12)} ${u.active ? 'активен ' : 'отключён'}  вход: ${u.last_login || '—'}`);
      }
      break;
    case 'role-list':
      for (const r of db.prepare('SELECT key, name, builtin, (SELECT COUNT(*) FROM users u WHERE u.role = roles.key) AS n FROM roles ORDER BY builtin DESC, key').all()) {
        console.log(`${r.key.padEnd(14)} ${r.name.padEnd(22)} ${r.builtin ? 'встроенная' : 'своя      '}  пользователей: ${r.n}`);
      }
      break;

    case 'import-skus': {
      const rows = readRows(pos[0], 4, 5);
      const ins = db.prepare(`INSERT INTO sku(art, name, zone, per, min_qty) VALUES (?,?,?,?,?)
        ON CONFLICT(art) DO UPDATE SET name = excluded.name, zone = excluded.zone, per = excluded.per, min_qty = excluded.min_qty`);
      db.transaction(() => {
        for (const [n, [art, name, zone, per, min]] of rows) {
          if (!L.zoneById.has(zone)) die(`Строка ${n}: зоны «${zone}» нет на складе`);
          const m = min && /^\d+$/.test(min) ? +min : 0;
          ins.run(art, name, zone, toInt(per, n), m);
        }
        bump(db);
      })();
      console.log(`Загружено артикулов: ${rows.length}`);
      break;
    }
    case 'import-receipt': {
      if (!opt.doc || opt.doc === true) die('Укажите --doc <номер поставки>');
      const rows = readRows(pos[0], 2);
      checkSkus(db, rows);
      const ins = db.prepare('INSERT INTO receipt(doc, gate, art, qty, created) VALUES (?,?,?,?,?)');
      db.transaction(() => {
        for (const [n, [art, qty]] of rows) ins.run(opt.doc, opt.gate === true ? '' : (opt.gate || ''), art, toInt(qty, n), now());
        db.prepare("INSERT INTO oplog(ts, op, kind, qty, user, ref) VALUES (?, 'Поставка загружена', 'doc', ?, 'импорт', ?)").run(now(), rows.length, opt.doc);
        bump(db);
      })();
      console.log(`Поставка ${opt.doc}: строк ${rows.length}`);
      break;
    }
    case 'import-order': {
      if (!opt.number || !opt.dealer || opt.number === true || opt.dealer === true) die('Укажите --number <номер> и --dealer <дилер>');
      const rows = readRows(pos[0], 2);
      checkSkus(db, rows);
      if (db.prepare('SELECT 1 FROM orders WHERE number = ?').get(opt.number)) die(`Заказ ${opt.number} уже есть`);
      db.transaction(() => {
        const oid = db.prepare('INSERT INTO orders(number, dealer, due, created) VALUES (?,?,?,?)')
          .run(opt.number, opt.dealer, opt.due === true ? '' : (opt.due || ''), now()).lastInsertRowid;
        const ins = db.prepare('INSERT INTO order_line(order_id, art, qty) VALUES (?,?,?)');
        for (const [n, [art, qty]] of rows) ins.run(oid, art, toInt(qty, n));
        db.prepare("INSERT INTO oplog(ts, op, kind, qty, user, ref) VALUES (?, 'Заказ загружен', 'doc', ?, 'импорт', ?)").run(now(), rows.length, opt.number);
        bump(db);
      })();
      console.log(`Заказ ${opt.number}: строк ${rows.length}`);
      break;
    }
    case 'export-stock': {
      if (!pos[0]) die('Укажите файл');
      const esc = (v) => (/[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      const rows = db.prepare(`SELECT c.addr, c.sku, s.name, c.qty, c.blocked FROM cell c LEFT JOIN sku s ON s.art = c.sku
        WHERE c.sku IS NOT NULL OR c.blocked = 1 ORDER BY c.addr`).all();
      const out = ['адрес;артикул;наименование;количество;заблокирована',
        ...rows.map((r) => [r.addr, r.sku || '', r.name || '', r.qty, r.blocked ? 'да' : ''].map(esc).join(';'))];
      fs.writeFileSync(pos[0], '﻿' + out.join('\r\n') + '\r\n');
      console.log(`Выгружено строк: ${rows.length} → ${pos[0]}`);
      break;
    }
    case 'backup':
      if (!pos[0]) die('Укажите файл: backup /path/warehouse-копия.db');
      await db.backup(pos[0]);
      console.log(`Резервная копия: ${pos[0]}`);
      break;

    case 'carsale-sync': {
      const CS = createCarsaleSync(db, L, cfg);
      if (!CS.configured()) die('Не заданы CARSALE_LOGIN и CARSALE_PASSWORD в /etc/default/parts-yard');
      console.log(`Вхожу в Carsale (${cfg.carsale.base}) как ${cfg.carsale.login}…`);
      const r = await CS.run({ trigger: 'console', user: 'консоль' });
      if (!r.ok) die('Не получилось: ' + r.error);
      const s = r.stats;
      console.log(`Готово за ${(s.ms / 1000).toFixed(1)} с: каталог ${s.directory}, строк остатков ${s.stockRows}`);
      console.log(`Артикулов: новых ${s.added}, обновлено ${s.updated}; на складе по Carsale ${s.withStock} арт. / ${s.units} шт, в брони ${s.reserved} шт`);
      for (const w of s.warnings) console.log('Внимание: ' + w);
      break;
    }
    case 'carsale-status': {
      const st = createCarsaleSync(db, L, cfg).status();
      console.log(st.configured ? `Логин: ${st.login} · ${st.base} · филиал ${st.filial || 'определится при синхронизации'}` : 'Интеграция не настроена');
      console.log(`Каждые ${st.settings.intervalMin} мин${st.settings.enabled ? '' : ' (автосинхронизация выключена)'} · артикулов из Carsale: ${st.counts.skus}, штук на складе: ${st.counts.units}`);
      for (const r of st.runs.slice(0, 10)) console.log(`${r.started}  ${r.status.padEnd(7)} ${r.trigger || ''}  ${r.error || (r.stats ? `+${r.stats.added} / ${r.stats.updated} обн. / ${r.stats.units} шт` : '')}`);
      break;
    }
    default:
      die(`Неизвестная команда ${cmd}\n\n${HELP}`);
  }
  db.close();
}

main().catch((e) => die(e.message));
