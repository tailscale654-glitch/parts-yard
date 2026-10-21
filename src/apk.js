'use strict';
// Чтение APK без сторонних библиотек: из двоичного AndroidManifest.xml берём пакет и версию.
// Нужно, чтобы администратор не загрузил чужое приложение или старую версию.
const { unzip } = require('./xlsx');

function stringPool(b, p) {
  const count = b.readUInt32LE(p + 8), flags = b.readUInt32LE(p + 16), start = b.readUInt32LE(p + 20);
  const utf8 = (flags & 0x100) !== 0, hsize = b.readUInt16LE(p + 2), out = new Array(count);
  for (let i = 0; i < count; i++) {
    let o = p + start + b.readUInt32LE(p + hsize + i * 4);
    if (utf8) {
      o += (b[o] & 0x80) ? 2 : 1; // длина в символах
      let n = b[o];
      if (n & 0x80) { n = ((n & 0x7f) << 8) | b[o + 1]; o += 2; } else o += 1;
      out[i] = b.toString('utf8', o, o + n);
    } else {
      let n = b.readUInt16LE(o);
      if (n & 0x8000) { n = ((n & 0x7fff) << 16) | b.readUInt16LE(o + 2); o += 4; } else o += 2;
      out[i] = b.toString('utf16le', o, o + n * 2);
    }
  }
  return out;
}

// атрибуты корневого элемента <manifest>: package, versionCode, versionName
function manifestAttrs(b) {
  if (!b || b.length < 8 || b.readUInt16LE(0) !== 0x0003) throw new Error('В APK нет двоичного AndroidManifest.xml');
  let p = b.readUInt16LE(2), strings = [];
  while (p + 8 <= b.length) {
    const type = b.readUInt16LE(p), size = b.readUInt32LE(p + 4);
    if (size < 8) break;
    if (type === 0x0001) strings = stringPool(b, p);
    else if (type === 0x0102 && strings[b.readUInt32LE(p + 20)] === 'manifest') {
      const ext = p + 16, aStart = ext + b.readUInt16LE(ext + 8), aSize = b.readUInt16LE(ext + 10), n = b.readUInt16LE(ext + 12);
      const out = {};
      for (let i = 0; i < n; i++) {
        const a = aStart + i * aSize;
        const name = strings[b.readUInt32LE(a + 4)], raw = b.readUInt32LE(a + 8), dtype = b[a + 15], data = b.readUInt32LE(a + 16);
        out[name] = dtype === 0x03 ? strings[data] : dtype >= 0x10 && dtype <= 0x1f ? data : raw !== 0xffffffff ? strings[raw] : data;
      }
      return out;
    }
    p += size;
  }
  throw new Error('В манифесте APK нет элемента <manifest>');
}

function readApk(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 100 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error('Это не APK-файл');
  const z = unzip(buf, 'APK-файл');
  const m = manifestAttrs(z.readBuf('AndroidManifest.xml'));
  const versionCode = Number(m.versionCode);
  if (!m.package || !Number.isInteger(versionCode)) throw new Error('Не удалось прочитать версию из APK');
  return { package: m.package, versionCode, versionName: m.versionName ? String(m.versionName) : String(versionCode) };
}

module.exports = { readApk, manifestAttrs };
