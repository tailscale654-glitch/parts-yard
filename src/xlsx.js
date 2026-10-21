'use strict';
// Минимальное чтение .xlsx без сторонних библиотек: первый лист → массив строк (массив значений по столбцам).
// xlsx — это zip с XML внутри; нужны только sharedStrings и первый лист. Формулы берутся по сохранённому значению.
const zlib = require('zlib');

function unzip(buf, what = 'файл Excel (.xlsx)') {
  // конец центрального каталога
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error(`Это не ${what}`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`Повреждён ${what}`);
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    files.set(name, { method, csize, off });
    p += 46 + nlen + xlen + clen;
  }
  const readBuf = (name) => {
    const f = files.get(name);
    if (!f) return null;
    const lh = f.off, start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
    const data = buf.subarray(start, start + f.csize);
    if (f.method === 0) return data;
    if (f.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 });
    throw new Error(`Неподдерживаемое сжатие: ${what}`);
  };
  const read = (name) => { const b = readBuf(name); return b == null ? null : b.toString('utf8'); };
  return { read, readBuf, names: [...files.keys()] };
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m));
const textOf = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

function readXlsx(buf) {
  const z = unzip(buf);
  const shared = [];
  const ss = z.read('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));
  // первый лист по workbook.xml и связям
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = z.read('xl/workbook.xml'), rels = z.read('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const first = wb.match(/<sheet\b[^>]*r:id="([^"]+)"/);
    if (first) {
      const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${first[1]}"`));
      const target = rel && rel.match(/Target="([^"]+)"/);
      if (target) sheetPath = target[1].startsWith('/') ? target[1].slice(1) : 'xl/' + target[1].replace(/^\.\//, '');
    }
  }
  const sheet = z.read(sheetPath);
  if (!sheet) throw new Error('В файле Excel не найден лист');
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] || '';
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
      const t = (attrs.match(/\bt="(\w+)"/) || [])[1];
      const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = null;
      if (t === 's') val = v != null ? shared[+v] ?? '' : '';
      else if (t === 'inlineStr') val = textOf(body);
      else if (v != null) val = unxml(v);
      const idx = ref ? colIndex(ref) : row.length;
      row[idx] = val;
    }
    rows.push(Array.from(row, (x) => (x === undefined ? null : x)));
  }
  return rows;
}

module.exports = { readXlsx, unzip };
