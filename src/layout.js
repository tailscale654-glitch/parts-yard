'use strict';
// Топология склада: зоны → ряды → стеллажи → ярусы → ячейки.
// Две схемы адресов:
//   scheme "rows"  (по умолчанию) — ЗОНА-РЯД-СТЕЛЛАЖ-ЯРУС-ЯЧЕЙКА, например A-01-02-3-1;
//   scheme "racks" — ЗОНА-СТЕЛЛАЖ-ЯРУС-ЯЧЕЙКА, например A-08-01-02 (стеллажи сквозной нумерации с start;
//                    rows и racks тогда задают только раскладку стеллажей на схеме: rows рядов по racks).
// Берётся из базы (если её меняли в админке) или из layout.json.
// Координаты совпадают со схемой 940×580 в веб-интерфейсе и задают порядок обхода.
const fs = require('fs');

const CX = 470;   // центральный проезд
const RH = 16;    // высота стеллажа на схеме
const RS = 34;    // шаг рядов

function pad(n) { return String(n).padStart(2, '0'); }

const LIMITS = { rows: [1, 40], racks: [1, 60], tiers: [1, 12], cells: [1, 12], rw: [8, 120], x: [0, 940], y: [0, 580] };

// Все ячейки зоны: адрес, стеллаж, ряд на схеме, ярус, ячейка
function zoneCells(z) {
  const out = [];
  for (let r = 0; r < z.rows; r++) {
    for (let k = 0; k < z.racks; k++) {
      const racks = z.scheme === 'racks';
      const rackNo = racks ? (z.start || 1) + r * z.racks + k : k + 1;
      const rack = racks ? `${z.id}-${pad(rackNo)}` : `${z.id}-${pad(r + 1)}-${pad(k + 1)}`;
      for (let t = 1; t <= z.tiers; t++) {
        for (let c = 1; c <= z.cells; c++) {
          out.push({ addr: racks ? `${rack}-${pad(t)}-${pad(c)}` : `${rack}-${t}-${c}`, rack, r, k, rackNo, t, c });
        }
      }
    }
  }
  return out;
}
// Адрес в виде, который пишут люди: «a-016-1-01», «A 16 01 01» → ключ для поиска «A-16-1-1»
function addrKey(s) {
  const parts = String(s || '').toUpperCase().replace(/[\s_.]+/g, '-').split('-').filter(Boolean);
  return parts.map((p) => (/^\d+$/.test(p) ? String(Number(p)) : p)).join('-');
}

function validateZones(zones) {
  if (!Array.isArray(zones) || !zones.length) throw new Error('Нужна хотя бы одна зона');
  const ids = new Set();
  const warnings = [];
  const clean = zones.map((z, i) => {
    const id = String(z.id || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{1,3}$/.test(id)) throw new Error(`Зона ${i + 1}: код — 1–3 латинские буквы или цифры`);
    if (ids.has(id)) throw new Error(`Код зоны ${id} повторяется`);
    ids.add(id);
    const out = { id, title: String(z.title || `Зона ${id}`).slice(0, 40), sub: String(z.sub || '').slice(0, 60) };
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
      const v = Number(z[k]);
      if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`Зона ${id}: «${k}» должно быть целым от ${lo} до ${hi}`);
      out[k] = v;
    }
    out.prefer = z.prefer === 'middle' ? 'middle' : 'low';
    if (z.scheme === 'racks') {
      out.scheme = 'racks';
      const st = Number(z.start || 1);
      if (!Number.isInteger(st) || st < 1 || st > 999) throw new Error(`Зона ${id}: первый номер стеллажа — от 1 до 999`);
      out.start = st;
    }
    const w = out.racks * (out.rw + 2) - 2, h = (out.rows - 1) * RS + RH;
    if (out.x + w > 930 || out.y + h > 455) warnings.push(`Зона ${id} выходит за поле схемы (${out.x + w}×${out.y + h}, доступно 930×455)`);
    return out;
  });
  for (let i = 0; i < clean.length; i++) {
    for (let j = i + 1; j < clean.length; j++) {
      const a = clean[i], b = clean[j];
      const aw = a.racks * (a.rw + 2), ah = (a.rows - 1) * RS + RH + 20;
      const bw = b.racks * (b.rw + 2), bh = (b.rows - 1) * RS + RH + 20;
      if (a.x < b.x + bw && b.x < a.x + aw && a.y < b.y + bh && b.y < a.y + ah) warnings.push(`Зоны ${a.id} и ${b.id} перекрываются на схеме`);
    }
  }
  return { zones: clean, warnings };
}

function buildLayout(zones) {
  const racks = new Map();
  const meta = new Map();
  const zoneById = new Map();
  const keys = new Map();
  for (const z of zones) {
    zoneById.set(z.id, z);
    for (const x of zoneCells(z)) {
      if (!racks.has(x.rack)) {
        const rx = z.x + x.k * (z.rw + 2), ry = z.y + x.r * RS;
        racks.set(x.rack, { zone: z.id, row: x.r + 1, no: x.rackNo, cx: rx + z.rw / 2, ay: ry + RH + 9 });
        keys.set(addrKey(x.rack), x.rack);
      }
      meta.set(x.addr, { rack: x.rack, zone: z.id, row: x.r + 1, tier: x.t, cell: x.c, tiers: z.tiers, prefer: z.prefer || 'low' });
      keys.set(addrKey(x.addr), x.addr);
    }
  }
  // адрес или стеллаж по тому, как его написали люди
  const find = (s) => keys.get(addrKey(s)) || null;
  return { zones, zoneById, racks, meta, find };
}

function readLayoutFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return validateZones(raw.zones).zones;
}

// Загружает топологию: из настроек базы, если есть, иначе из файла
function resolveLayout(db, file) {
  const stored = db.prepare("SELECT v FROM settings WHERE k = 'layout'").pluck().get();
  const zones = stored ? JSON.parse(stored) : readLayoutFile(file);
  return buildLayout(zones);
}

// Подменяет содержимое объекта L на месте: все модули держат ссылку на тот же объект
function applyLayout(L, zones) {
  const n = buildLayout(zones);
  L.zones = n.zones; L.zoneById = n.zoneById; L.racks = n.racks; L.meta = n.meta; L.find = n.find;
}

function makeGeometry(L) {
  const dist = (addr) => {
    const rk = L.racks.get(L.meta.get(addr).rack);
    return Math.abs(rk.cx - CX) + (480 - rk.ay) * 1.2;
  };
  const routeCmp = (a, b) => {
    const ma = L.meta.get(a), mb = L.meta.get(b);
    const ra = L.racks.get(ma.rack), rb = L.racks.get(mb.rack);
    return ra.ay - rb.ay || ra.cx - rb.cx || ma.tier - mb.tier;
  };
  // "middle" — сначала средние ярусы (уровень пояса), "low" — сначала нижние
  const slotScore = (addr) => {
    const m = L.meta.get(addr);
    if (m.prefer === 'middle') return dist(addr) + Math.abs(m.tier - (m.tiers + 1) / 2) * 40;
    return dist(addr) + m.tier * 12;
  };
  return { dist, routeCmp, slotScore };
}

function zoneOf(addr) { return String(addr || '').split('-')[0]; }

module.exports = { buildLayout, validateZones, readLayoutFile, resolveLayout, applyLayout, makeGeometry, zoneOf, zoneCells, addrKey, RS, RH };
