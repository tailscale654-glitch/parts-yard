'use strict';
// Пользователи и cookie-сессии (как в jac-yard), хранение — в той же SQLite.
const crypto = require('crypto');
const { now } = require('./db');

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
    session: db.prepare(`SELECT s.sid, s.expires, u.id, u.username, u.role FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.sid = ? AND u.active = 1`),
    touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
    create: db.prepare('INSERT INTO sessions(sid, user_id, expires) VALUES (?,?,?)'),
    del: db.prepare('DELETE FROM sessions WHERE sid = ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires < ?'),
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
    const u = username && q.user.get(String(username).trim());
    if (!u || !u.active || !password || !checkPassword(String(password), u.pass)) {
      fails.get(ip).push(Date.now());
      return res.status(401).json({ error: 'Неверный логин или пароль', code: 'BAD_LOGIN' });
    }
    fails.delete(ip);
    q.purge.run(Date.now());
    const sid = crypto.randomBytes(32).toString('base64url');
    q.create.run(sid, u.id, Date.now() + maxAgeMs);
    setCookie(res, sid, maxAgeMs);
    res.json({ user: { username: u.username, role: u.role } });
  }

  function logout(req, res) {
    const sid = parseCookies(req.headers.cookie)[cfg.cookieName];
    if (sid) q.del.run(sid);
    setCookie(res, '', 0);
    res.json({ ok: true });
  }

  // кладёт req.user, продлевает сессию не чаще раза в час
  function session(req, res, next) {
    const sid = parseCookies(req.headers.cookie)[cfg.cookieName];
    if (sid) {
      const s = q.session.get(sid);
      if (s && s.expires > Date.now()) {
        req.user = { id: s.id, username: s.username, role: s.role };
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

  function requireAdmin(req, res, next) {
    if (req.user && req.user.role === 'admin') return next();
    res.status(403).json({ error: 'Действие доступно только администратору', code: 'FORBIDDEN' });
  }

  return { login, logout, session, requireUser, requireAdmin };
}

function addUser(db, username, password, role = 'operator') {
  if (!/^[\p{L}\p{N}._-]{2,40}$/u.test(username)) throw new Error('Логин: 2–40 символов, буквы, цифры, точка, дефис, подчёркивание');
  if (String(password).length < 6) throw new Error('Пароль должен быть не короче 6 символов');
  db.prepare(`INSERT INTO users(username, pass, role, created) VALUES (?,?,?,?)
    ON CONFLICT(username) DO UPDATE SET pass = excluded.pass, role = excluded.role, active = 1`)
    .run(username, hashPassword(password), role, now());
}

module.exports = { createAuth, addUser, hashPassword, checkPassword };
