'use strict';
// Приложение «Склад JAC» для ТСД: администратор загружает APK, ТСД ставят его по ссылке
// https://<сервер>/app и дальше обновляются сами (приложение сверяет версию через /api/tsd/app).
const fs = require('fs');
const path = require('path');
const express = require('express');
const { audit, getSetting, setSetting, now } = require('./db');
const { readApk } = require('./apk');

const PACKAGE = 'uz.jacmotors.sklad';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = function tsdApi(app, api, { db, cfg, need, h, WmsError }) {
  const dir = path.join(path.dirname(path.resolve(cfg.dbPath)), 'app');
  const file = path.join(dir, 'sklad-jac.apk');
  const info = () => {
    try { const i = JSON.parse(getSetting(db, 'tsd_app', '') || 'null'); return i && fs.existsSync(file) ? i : null; } catch (e) { return null; }
  };

  // публично: страница для первой установки и сам файл (в APK нет секретов, вход — логином кладовщика)
  app.get('/app', (req, res) => {
    const i = info();
    res.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Склад JAC — приложение для ТСД</title><style>
body{margin:0;font:17px/1.45 -apple-system,system-ui,Roboto,sans-serif;background:#F2F2F7;color:#1C1C1E}
main{max-width:520px;margin:0 auto;padding:28px 18px}h1{font-size:26px;margin:0 0 4px}.sub{color:#6E6E73;margin:0 0 22px}
.card{background:#fff;border-radius:16px;padding:18px;margin-bottom:14px}a.btn{display:block;text-align:center;background:#0A798D;color:#fff;text-decoration:none;font-weight:700;border-radius:12px;padding:16px;font-size:19px}
ol{padding-left:20px;margin:0}li{margin:6px 0}.muted{color:#6E6E73;font-size:15px}</style></head><body><main>
<h1>Склад JAC</h1><p class="sub">Приложение для ТСД и телефонов: приёмка, отбор, перемещение, пересчёт.</p>
${i ? `<div class="card"><a class="btn" href="/app/sklad-jac.apk">Скачать версию ${esc(i.versionName)}</a>
<p class="muted">${(i.size / 1048576).toFixed(1)} МБ · загружена ${esc(String(i.uploaded).slice(0, 16).replace('T', ' '))}</p></div>
<div class="card"><ol><li>Нажмите «Скачать», откройте файл.</li><li>Если Android спросит — разрешите установку из браузера.</li>
<li>Откройте «Склад JAC», войдите своим логином и паролем.</li><li>Дальше приложение обновляется само.</li></ol></div>`
    : '<div class="card">Приложение ещё не загружено. Администратор: веб-версия → «Настройки» → «Приложение для ТСД».</div>'}
</main></body></html>`);
  });
  app.get('/app/sklad-jac.apk', (req, res) => {
    const i = info();
    if (!i) return res.status(404).type('text').send('Приложение ещё не загружено');
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="sklad-jac-${i.versionName}.apk"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(file);
  });

  api.get('/tsd/app', h(() => {
    const i = info();
    return i ? { ...i, url: '/app/sklad-jac.apk' } : { versionCode: 0 };
  }));

  // загрузка APK: тело запроса — сам файл (не JSON), до 60 МБ
  api.post('/admin/tsd-app', need('admin.settings'), express.raw({ type: () => true, limit: '60mb' }), h((req) => {
    let apk;
    try { apk = readApk(req.body); } catch (e) { throw new WmsError(400, 'BAD_APK', e.message); }
    if (apk.package !== PACKAGE) throw new WmsError(400, 'WRONG_APP', `Это другое приложение (${apk.package}), нужно ${PACKAGE}`);
    const cur = info();
    if (cur && apk.versionCode < cur.versionCode && req.query.force !== '1') {
      throw new WmsError(409, 'OLDER_VERSION', `Загружается версия ${apk.versionName}, а на сервере уже ${cur.versionName}. ТСД не смогут откатиться на старую.`);
    }
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, req.body);
    fs.renameSync(tmp, file);
    const meta = { versionCode: apk.versionCode, versionName: apk.versionName, size: req.body.length, uploaded: now(), by: req.user.username };
    setSetting(db, 'tsd_app', JSON.stringify(meta));
    audit(db, req.user.username, 'Приложение для ТСД загружено', { version: apk.versionName, size: req.body.length });
    return { ok: true, ...meta };
  }));
};
