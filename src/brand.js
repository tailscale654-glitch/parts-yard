'use strict';
// Фирменный стиль: подпись бренда, логотип и фото здания (загружаются в Настройках).
const fs = require('fs');
const path = require('path');
const { getSetting } = require('./db');

const DEFAULTS = { brand_line1: 'JAC MOTORS', brand_line2: 'TOSHKENT' };
const KINDS = { logo: { key: 'brand_logo', max: 600 * 1024 }, photo: { key: 'brand_photo', max: 3 * 1024 * 1024 } };
const MIME = ['image/png', 'image/jpeg', 'image/webp'];

function brandInfo(db) {
  return {
    name: getSetting(db, 'warehouse_name', 'Адресный склад запчастей'),
    subtitle: getSetting(db, 'warehouse_subtitle', ''),
    line1: getSetting(db, 'brand_line1', DEFAULTS.brand_line1),
    line2: getSetting(db, 'brand_line2', DEFAULTS.brand_line2),
    hasLogo: !!getSetting(db, 'brand_logo', ''),
    customPhoto: !!getSetting(db, 'brand_photo', ''),
    v: getSetting(db, 'brand_v', '1'),
  };
}

function parseDataUrl(s, kind) {
  const m = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
  if (!m || !MIME.includes(m[1])) throw new Error('Нужна картинка PNG, JPEG или WebP');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > KINDS[kind].max) throw new Error(`Файл больше ${Math.round(KINDS[kind].max / 1024)} КБ`);
  // проверяем сигнатуру, а не только заявленный тип
  const sig = buf.subarray(0, 12);
  const ok = (m[1] === 'image/png' && sig[0] === 0x89 && sig[1] === 0x50) || (m[1] === 'image/jpeg' && sig[0] === 0xFF && sig[1] === 0xD8)
    || (m[1] === 'image/webp' && sig.toString('ascii', 0, 4) === 'RIFF' && sig.toString('ascii', 8, 12) === 'WEBP');
  if (!ok) throw new Error('Файл не похож на картинку');
  return { mime: m[1], buf };
}

function serve(db, root) {
  const fallbackPhoto = path.join(root, 'public', 'brand', 'building.jpg');
  return (req, res) => {
    const kind = req.params.kind;
    if (!KINDS[kind]) return res.status(404).end();
    const stored = getSetting(db, KINDS[kind].key, '');
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (stored) {
      try { const { mime, buf } = parseDataUrl(stored, kind); res.type(mime); return res.send(buf); } catch (e) { /* испорчено — отдадим запасное */ }
    }
    if (kind === 'photo' && fs.existsSync(fallbackPhoto)) return res.sendFile(fallbackPhoto);
    res.status(404).end();
  };
}

module.exports = { brandInfo, parseDataUrl, serve, KINDS, DEFAULTS };
