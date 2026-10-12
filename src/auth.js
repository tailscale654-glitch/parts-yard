'use strict';
// Пользователи и cookie-сессии (как в jac-yard). Права берутся из роли пользователя.
const crypto = require('crypto');
const { now, audit } = require('./db');
const { permSet, has, expand } = require('./perms');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function checkPassword(pw, stored) {
  const [kind, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt') return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(want, got);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth(db, cfg) {
  const maxAgeMs = cfg.sessionDays * 86400000;
  const q = {
    user: db.prepare('SELECT * FROM users WHERE username = ?'),
    session: db.prepare(`SELECT s.sid, s.expires, u.id, u.username, u.full_name, u.role, r.name AS role_name, r.perms
      FROM sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.key = u.role
      WHERE s.sid = ? AND u.active = 1`),
    touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
    create: db.prepare('INSERT INTO sessions(sid, user_id, expires) VALUES (?,?,?)'),
    del: db.prepare('DELETE FROM sessions WHERE sid = ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires < ?'),
    lastLogin: db.prepare('UPDATE users SET last_login = ? WHERE id = ?'),
  };

  // защита от подбора пароля: не больше 8 неудачных попыток за 10 минут с одного адреса
  const fails = new Map();
  function tooMany(ip) {
    const t = Date.now(), list = (fails.get(ip) || []).filter((x) => t - x < 600000);
    fails.set(ip, list);
    return list.length >= 8;
  }

  function setCookie(res, sid, maxAge) {
    const parts = [`${cfg.cookieName}=${sid}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAge / 1000)}`];
    if (cfg.secureCookie) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  function login(req, res) {
    const { username, password } = req.body || {};
    const ip = req.ip;
    if (tooMany(ip)) return res.status(429).json({ error: 'Слишком много попыток. Подождите 10 минут.', code: 'RATE_LIMIT' });
    const name = String(username || '').trim();
    const u = name && q.user.get(name);
    if (!u || !u.active || !password || !checkPassword(String(password), u.pass)) {
      fails.get(ip).push(Date.now());
      audit(db, name || null, 'Неудачный вход', { ip });
      return res.status(401).json({ error: 'Неверный логин или пароль', code: 'BAD_LOGIN' });
    }
    fails.delete(ip);
    q.purge.run(Date.now());
    const sid = crypto.randomBytes(32).toString('base64url');
    q.create.run(sid, u.id, Date.now() + maxAgeMs);
    q.lastLogin.run(now(), u.id);
    audit(db, u.username, 'Вход', { ip });
    setCookie(res, sid, maxAgeMs);
    res.json({ user: { username: u.username, role: u.role } });
  }

  function logout(req, res) {
    const sid = parseCookies(req.headers.cookie)[cfg.cookieName];
    if (sid) q.del.run(sid);
    setCookie(res, '', 0);
    res.json({ ok: true });
  }

  // кладёт req.user с правами, продлевает сессию не чаще раза в час
  function session(req, res, next) {
    const sid = parseCookies(req.headers.cookie)[cfg.cookieName];
    if (sid) {
      const s = q.session.get(sid);
      if (s && s.expires > Date.now()) {
        const set = permSet(s.perms);
        req.user = {
          id: s.id, username: s.username, fullName: s.full_name || '', role: s.role, roleName: s.role_name,
          perms: set, can: (p) => has(set, p), permList: expand(set),
        };
        if (s.expires - Date.now() < maxAgeMs - 3600000) {
          q.touch.run(Date.now() + maxAgeMs, sid);
          setCookie(res, sid, maxAgeMs);
        }
      }
    }
    next();
  }

  function requireUser(req, res, next) {
    if (req.user) return next();
    res.status(401).json({ error: 'Нужно войти в систему', code: 'AUTH_REQUIRED' });
  }

  // need('stock.pick') или need('a', 'b') — достаточно любого из прав
  function need(...perms) {
    return (req, res, next) => {
      if (req.user && perms.some((p) => req.user.can(p))) return next();
      res.status(403).json({ error: 'Недостаточно прав для этого действия', code: 'FORBIDDEN', need: perms });
    };
  }

  return { login, logout, session, requireUser, need };
}

const LOGIN_RE = /^[\p{L}\p{N}._-]{2,40}$/u;

function addUser(db, username, password, role = 'storekeeper', fullName) {
  if (role === 'operator') role = 'storekeeper';
  if (!LOGIN_RE.test(username)) throw new Error('Логин: 2–40 символов, буквы, цифры, точка, дефис, подчёркивание');
  if (String(password).length < 6) throw new Error('Пароль должен быть не короче 6 символов');
  if (!db.prepare('SELECT 1 FROM roles WHERE key = ?').get(role)) {
    const keys = db.prepare('SELECT key FROM roles ORDER BY builtin DESC, key').pluck().all();
    throw new Error(`Нет роли «${role}». Доступные: ${keys.join(', ')}`);
  }
  db.prepare(`INSERT INTO users(username, pass, role, full_name, created) VALUES (?,?,?,?,?)
    ON CONFLICT(username) DO UPDATE SET pass = excluded.pass, role = excluded.role, active = 1,
      full_name = COALESCE(excluded.full_name, users.full_name)`)
    .run(username, hashPassword(password), role, fullName || null, now());
}

function genPassword() {
  // без похожих символов (0/O, 1/l/I), чтобы легко продиктовать
  const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(10);
  return Array.from(b, (x) => abc[x % abc.length]).join('');
}

module.exports = { createAuth, addUser, hashPassword, checkPassword, genPassword, LOGIN_RE };
