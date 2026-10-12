'use strict';
// Администрирование: пользователи, роли, настройки, топология, аудит, резервная копия.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { now, audit, getSetting, setSetting, syncCells } = require('./db');
const { hashPassword, genPassword, LOGIN_RE } = require('./auth');
const { PERMS, PERM_KEYS, permSet, has } = require('./perms');
const { validateZones, buildLayout, applyLayout, readLayoutFile } = require('./layout');
const pkg = require('../package.json');
const { parseDataUrl, KINDS: BRAND_KINDS, DEFAULTS: BRAND_DEFAULTS } = require('./brand');

const ROLE_KEY_RE = /^[a-z][a-z0-9_-]{1,30}$/;
const STARTED = Date.now();

module.exports = function adminApi(api, { db, L, cfg, need, h, WmsError }) {
  const bump = () => db.exec("UPDATE meta SET v = v + 1 WHERE k = 'rev'");
  const rolePerms = (key) => permSet(db.prepare('SELECT perms FROM roles WHERE key = ?').pluck().get(key));
  const isSuper = (key) => rolePerms(key).has('*');
  // нельзя выдать права, которых нет у себя (защита от повышения привилегий)
  function assertCanGrant(req, perms) {
    if (req.user.perms.has('*')) return;
    const extra = [...perms].filter((p) => p === '*' || !has(req.user.perms, p));
    if (extra.length) throw new WmsError(403, 'ESCALATION', 'Нельзя выдать права, которых нет у вас самих');
  }
  const activeSupers = () => db.prepare('SELECT u.id, r.perms FROM users u JOIN roles r ON r.key = u.role WHERE u.active = 1').all()
    .filter((x) => permSet(x.perms).has('*')).map((x) => x.id);
  const getUser = (id) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw new WmsError(404, 'NO_USER', 'Пользователь не найден');
    return u;
  };

  // ---------- пользователи ----------
  api.get('/admin/users', need('admin.users'), h(() => ({
    users: db.prepare(`SELECT u.id, u.username, u.full_name, u.role, r.name AS role_name, u.active, u.created, u.last_login,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires > ?) AS sessions,
      (SELECT MAX(ts) FROM oplog o WHERE o.user = u.username) AS last_op
      FROM users u LEFT JOIN roles r ON r.key = u.role ORDER BY u.active DESC, u.username`).all(Date.now()),
  })));
  api.get('/admin/roles', need('admin.users', 'admin.roles'), h(() => ({
    roles: db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role = r.key AND u.active = 1) AS users
      FROM roles r ORDER BY r.builtin DESC, r.name`).all().map((r) => ({ ...r, perms: JSON.parse(r.perms) })),
    perms: PERMS,
  })));

  api.post('/admin/users', need('admin.users'), h((req) => {
    const username = String(req.body.username || '').trim();
    const fullName = String(req.body.full_name || '').trim().slice(0, 80) || null;
    const role = String(req.body.role || '');
    if (!LOGIN_RE.test(username)) throw new WmsError(400, 'BAD_LOGIN', 'Логин: 2–40 символов, буквы, цифры, точка, дефис, подчёркивание');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new WmsError(409, 'USER_EXISTS', `Логин ${username} уже занят`);
    if (!db.prepare('SELECT 1 FROM roles WHERE key = ?').get(role)) throw new WmsError(400, 'BAD_ROLE', 'Выберите роль');
    assertCanGrant(req, rolePerms(role));
    const generated = !req.body.password;
    const password = generated ? genPassword() : String(req.body.password);
    if (password.length < 6) throw new WmsError(400, 'WEAK_PASSWORD', 'Пароль должен быть не короче 6 символов');
    db.prepare('INSERT INTO users(username, pass, full_name, role, created) VALUES (?,?,?,?,?)').run(username, hashPassword(password), fullName, role, now());
    audit(db, req.user.username, 'Пользователь создан', { username, role });
    return { ok: true, password: generated ? password : undefined };
  }));
  api.patch('/admin/users/:id(\\d+)', need('admin.users'), h((req) => {
    const u = getUser(+req.params.id);
    assertCanGrant(req, rolePerms(u.role));
    const role = req.body.role === undefined ? u.role : String(req.body.role);
    const active = req.body.active === undefined ? u.active : (req.body.active ? 1 : 0);
    const fullName = req.body.full_name === undefined ? u.full_name : (String(req.body.full_name).trim().slice(0, 80) || null);
    if (!db.prepare('SELECT 1 FROM roles WHERE key = ?').get(role)) throw new WmsError(400, 'BAD_ROLE', 'Нет такой роли');
    assertCanGrant(req, rolePerms(role));
    if (u.id === req.user.id && !active) throw new WmsError(409, 'SELF', 'Нельзя отключить самого себя');
    if (isSuper(u.role) && (!isSuper(role) || !active) && u.active && activeSupers().length <= 1) {
      throw new WmsError(409, 'LAST_ADMIN', 'Это последний администратор — сначала назначьте другого');
    }
    db.transaction(() => {
      db.prepare('UPDATE users SET role = ?, active = ?, full_name = ? WHERE id = ?').run(role, active, fullName, u.id);
      if (!active || role !== u.role) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      audit(db, req.user.username, 'Пользователь изменён', { username: u.username, role, active: !!active, fullName });
    })();
    return { ok: true };
  }));
  api.post('/admin/users/:id(\\d+)/password', need('admin.users'), h((req) => {
    const u = getUser(+req.params.id);
    assertCanGrant(req, rolePerms(u.role));
    const generated = !req.body.password;
    const password = generated ? genPassword() : String(req.body.password);
    if (password.length < 6) throw new WmsError(400, 'WEAK_PASSWORD', 'Пароль должен быть не короче 6 символов');
    db.transaction(() => {
      db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(hashPassword(password), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      audit(db, req.user.username, 'Пароль сброшен', { username: u.username });
    })();
    return { ok: true, password: generated ? password : undefined };
  }));
  api.post('/admin/users/:id(\\d+)/logout', need('admin.users'), h((req) => {
    const u = getUser(+req.params.id);
    const n = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id).changes;
    audit(db, req.user.username, 'Сеансы завершены', { username: u.username, sessions: n });
    return { ok: true, sessions: n };
  }));
  // смена своего пароля — доступна всем
  api.post('/me/password', h((req) => {
    const { current, password } = req.body || {};
    const u = getUser(req.user.id);
    const { checkPassword } = require('./auth');
    if (!checkPassword(String(current || ''), u.pass)) throw new WmsError(400, 'BAD_PASSWORD', 'Текущий пароль указан неверно');
    if (String(password || '').length < 6) throw new WmsError(400, 'WEAK_PASSWORD', 'Новый пароль должен быть не короче 6 символов');
    db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(hashPassword(String(password)), u.id);
    audit(db, u.username, 'Пароль изменён');
    return { ok: true };
  }));

  // ---------- роли ----------
  function cleanRole(body) {
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) throw new WmsError(400, 'BAD_NAME', 'Укажите название роли');
    const perms = (Array.isArray(body.perms) ? body.perms : []).filter((p) => PERM_KEYS.has(p));
    return { name, description: String(body.description || '').trim().slice(0, 160), perms: [...new Set(perms)] };
  }
  api.post('/admin/roles', need('admin.roles'), h((req) => {
    const key = String(req.body.key || '').trim().toLowerCase();
    if (!ROLE_KEY_RE.test(key)) throw new WmsError(400, 'BAD_KEY', 'Код роли: латиница, цифры, дефис; 2–31 символ; начинается с буквы');
    if (db.prepare('SELECT 1 FROM roles WHERE key = ?').get(key)) throw new WmsError(409, 'ROLE_EXISTS', `Роль ${key} уже есть`);
    const r = cleanRole(req.body);
    assertCanGrant(req, new Set(r.perms));
    db.prepare('INSERT INTO roles(key, name, description, perms, builtin) VALUES (?,?,?,?,0)').run(key, r.name, r.description, JSON.stringify(r.perms));
    audit(db, req.user.username, 'Роль создана', { key, ...r });
    return { ok: true, key };
  }));
  api.put('/admin/roles/:key', need('admin.roles'), h((req) => {
    const role = db.prepare('SELECT * FROM roles WHERE key = ?').get(req.params.key);
    if (!role) throw new WmsError(404, 'NO_ROLE', 'Роль не найдена');
    if (permSet(role.perms).has('*')) throw new WmsError(409, 'ROLE_LOCKED', 'Права администратора не меняются');
    const r = cleanRole(req.body);
    assertCanGrant(req, new Set(r.perms));
    db.prepare('UPDATE roles SET name = ?, description = ?, perms = ? WHERE key = ?').run(r.name, r.description, JSON.stringify(r.perms), role.key);
    audit(db, req.user.username, 'Роль изменена', { key: role.key, ...r });
    return { ok: true };
  }));
  api.delete('/admin/roles/:key', need('admin.roles'), h((req) => {
    const role = db.prepare('SELECT * FROM roles WHERE key = ?').get(req.params.key);
    if (!role) throw new WmsError(404, 'NO_ROLE', 'Роль не найдена');
    if (role.builtin) throw new WmsError(409, 'ROLE_BUILTIN', 'Встроенную роль удалить нельзя');
    const n = db.prepare('SELECT COUNT(*) FROM users WHERE role = ?').pluck().get(role.key);
    if (n) throw new WmsError(409, 'ROLE_USED', `Роль назначена пользователям (${n}) — сначала смените им роль`);
    db.prepare('DELETE FROM roles WHERE key = ?').run(role.key);
    audit(db, req.user.username, 'Роль удалена', { key: role.key });
    return { ok: true };
  }));

  // ---------- настройки ----------
  const SETTINGS = {
    warehouse_name: { max: 60, dflt: 'Адресный склад запчастей' },
    warehouse_subtitle: { max: 80, dflt: '' },
    poll_seconds: { int: [3, 120], dflt: '8' },
    brand_line1: { max: 24, dflt: BRAND_DEFAULTS.brand_line1 },
    brand_line2: { max: 24, dflt: BRAND_DEFAULTS.brand_line2 },
  };
  api.get('/admin/settings', need('admin.settings'), h(() => {
    const values = {};
    for (const [k, s] of Object.entries(SETTINGS)) values[k] = getSetting(db, k, s.dflt);
    let size = 0;
    try { size = fs.statSync(cfg.dbPath).size + (fs.existsSync(cfg.dbPath + '-wal') ? fs.statSync(cfg.dbPath + '-wal').size : 0); } catch (e) { /* нет файла */ }
    return {
      values,
      system: {
        version: pkg.version, node: process.version, db: cfg.dbPath, dbSize: size, demo: !!cfg.demo,
        cells: L.meta.size, zones: L.zones.length, skus: db.prepare('SELECT COUNT(*) FROM sku').pluck().get(),
        users: db.prepare('SELECT COUNT(*) FROM users WHERE active = 1').pluck().get(),
        uptimeMin: Math.round((Date.now() - STARTED) / 60000), host: os.hostname(),
        schema: db.prepare("SELECT v FROM meta WHERE k = 'schema'").pluck().get(),
      },
    };
  }));
  api.put('/admin/settings', need('admin.settings'), h((req) => {
    const changed = {};
    for (const [k, s] of Object.entries(SETTINGS)) {
      if (req.body[k] === undefined) continue;
      let v = String(req.body[k]).trim();
      if (s.max) v = v.slice(0, s.max);
      if (s.int) {
        const n = Number(v);
        if (!Number.isInteger(n) || n < s.int[0] || n > s.int[1]) throw new WmsError(400, 'BAD_VALUE', `Значение должно быть от ${s.int[0]} до ${s.int[1]}`);
      }
      setSetting(db, k, v);
      changed[k] = v;
    }
    audit(db, req.user.username, 'Настройки изменены', changed);
    return { ok: true };
  }));
  // логотип и фото здания для меню и страницы входа
  api.post('/admin/brand/:kind(logo|photo)', need('admin.settings'), h((req) => {
    try { parseDataUrl(req.body && req.body.dataUrl, req.params.kind); } catch (e) { throw new WmsError(400, 'BAD_IMAGE', e.message); }
    setSetting(db, BRAND_KINDS[req.params.kind].key, req.body.dataUrl);
    setSetting(db, 'brand_v', String(Date.now() % 1e9));
    audit(db, req.user.username, req.params.kind === 'logo' ? 'Логотип загружен' : 'Фото здания загружено');
    return { ok: true };
  }));
  api.delete('/admin/brand/:kind(logo|photo)', need('admin.settings'), h((req) => {
    db.prepare('DELETE FROM settings WHERE k = ?').run(BRAND_KINDS[req.params.kind].key);
    setSetting(db, 'brand_v', String(Date.now() % 1e9));
    audit(db, req.user.username, req.params.kind === 'logo' ? 'Логотип удалён' : 'Фото здания сброшено');
    return { ok: true };
  }));
  api.get('/admin/backup', need('admin.settings'), async (req, res, next) => {
    const file = path.join(os.tmpdir(), `warehouse-${Date.now()}.db`);
    try {
      await db.backup(file);
      audit(db, req.user.username, 'Резервная копия скачана');
      const stamp = now().slice(0, 16).replace(/[: ]/g, '-');
      res.download(file, `warehouse-${stamp}.db`, () => fs.unlink(file, () => {}));
    } catch (e) { fs.unlink(file, () => {}); next(e); }
  });

  // ---------- топология ----------
  function layoutImpact(zones) {
    const next = buildLayout(zones);
    const stocked = db.prepare('SELECT addr, sku, qty, blocked FROM cell WHERE sku IS NOT NULL OR blocked = 1').all();
    const lost = stocked.filter((c) => !next.meta.has(c.addr));
    const inv = db.prepare("SELECT l.addr FROM inv_line l JOIN inv_task t ON t.id = l.task_id WHERE t.status = 'open'").pluck().all()
      .filter((a) => !next.meta.has(a));
    const skuZones = db.prepare('SELECT DISTINCT zone FROM sku').pluck().all().filter((z) => !next.zoneById.has(z));
    return { cells: next.meta.size, added: [...next.meta.keys()].filter((a) => !L.meta.has(a)).length,
      removed: [...L.meta.keys()].filter((a) => !next.meta.has(a)).length, lost, inv, skuZones };
  }
  api.get('/admin/layout', need('admin.layout'), h(() => {
    const stocked = db.prepare('SELECT addr FROM cell WHERE sku IS NOT NULL').pluck().all();
    return {
      zones: L.zones,
      source: getSetting(db, 'layout', null) ? 'database' : 'file',
      stats: L.zones.map((z) => ({ id: z.id, cells: [...L.meta.values()].filter((m) => m.zone === z.id).length,
        stocked: stocked.filter((a) => a.startsWith(z.id + '-')).length })),
    };
  }));
  function prepareLayout(zones) {
    let v;
    try { v = validateZones(zones); } catch (e) { throw new WmsError(400, 'BAD_LAYOUT', e.message); }
    return { ...v, impact: layoutImpact(v.zones) };
  }
  api.post('/admin/layout/preview', need('admin.layout'), h((req) => {
    const p = prepareLayout(req.body.zones);
    return { ok: true, warnings: p.warnings, impact: { ...p.impact, lost: p.impact.lost.slice(0, 20), lostCount: p.impact.lost.length } };
  }));
  function saveLayout(req, zones, toFile) {
    const p = prepareLayout(zones);
    if (p.impact.lost.length) {
      throw new WmsError(409, 'LAYOUT_STOCK', `Исчезнут ${p.impact.lost.length} ячеек с товаром или блокировкой (например, ${p.impact.lost[0].addr}). Сначала освободите их.`);
    }
    if (p.impact.inv.length) throw new WmsError(409, 'LAYOUT_INV', 'Удаляемые ячейки входят в открытую инвентаризацию — закройте её');
    if (p.impact.skuZones.length) throw new WmsError(409, 'LAYOUT_SKU', `В каталоге есть артикулы зон ${p.impact.skuZones.join(', ')}, которых не будет — смените им зону`);
    db.transaction(() => {
      if (toFile) db.prepare("DELETE FROM settings WHERE k = 'layout'").run();
      else setSetting(db, 'layout', JSON.stringify(p.zones));
      applyLayout(L, p.zones);
      syncCells(db, L);
      const keep = new Set(L.meta.keys());
      const drop = db.prepare('SELECT addr FROM cell WHERE sku IS NULL AND blocked = 0').pluck().all().filter((a) => !keep.has(a));
      const del = db.prepare('DELETE FROM cell WHERE addr = ?');
      for (const a of drop) del.run(a);
      db.exec("UPDATE meta SET v = v + 1 WHERE k = 'layout_rev'");
      bump();
      audit(db, req.user.username, toFile ? 'Топология сброшена к layout.json' : 'Топология изменена',
        { zones: p.zones.map((z) => z.id), cells: L.meta.size, added: p.impact.added, removed: p.impact.removed });
    })();
    return { ok: true, cells: L.meta.size, warnings: p.warnings };
  }
  api.put('/admin/layout', need('admin.layout'), h((req) => saveLayout(req, req.body.zones, false)));
  api.post('/admin/layout/reset', need('admin.layout'), h((req) => {
    let zones;
    try { zones = readLayoutFile(cfg.layoutPath); } catch (e) { throw new WmsError(500, 'NO_FILE', `Не удалось прочитать ${cfg.layoutPath}: ${e.message}`); }
    return saveLayout(req, zones, true);
  }));

  // ---------- аудит ----------
  api.get('/admin/audit', need('admin.audit'), h((req) => {
    const args = [];
    let sql = 'SELECT * FROM audit WHERE 1 = 1';
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) { sql += ' AND ts >= ?'; args.push(req.query.from + ' 00:00:00'); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) { sql += ' AND ts <= ?'; args.push(req.query.to + ' 23:59:59'); }
    if (req.query.user) { sql += ' AND user = ?'; args.push(String(req.query.user)); }
    if (req.query.q) { sql += ' AND (action LIKE ? OR details LIKE ?)'; args.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    sql += ' ORDER BY id DESC LIMIT 2000';
    return { rows: db.prepare(sql).all(...args) };
  }));
};
