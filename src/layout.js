'use strict';
// Топология склада: зоны → ряды → стеллажи → ярусы → ячейки.
// Берётся из базы (если её меняли в админке) или из layout.json.
// Координаты совпадают со схемой 940×580 в веб-интерфейсе и задают порядок обхода.
const fs = require('fs');

const CX = 470;   // центральный проезд
const RH = 16;    // высота стеллажа на схеме
const RS = 34;    // шаг рядов

function pad(n) { return String(n).padStart(2, '0'); }

const LIMITS = { rows: [1, 40], racks: [1, 60], tiers: [1, 12], cells: [1, 12], rw: [8, 120], x: [0, 940], y: [0, 580] };

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
  for (const z of zones) {
    zoneById.set(z.id, z);
    for (let r = 0; r < z.rows; r++) {
      for (let k = 0; k < z.racks; k++) {
        const id = `${z.id}-${pad(r + 1)}-${pad(k + 1)}`;
        const x = z.x + k * (z.rw + 2);
        const y = z.y + r * RS;
        racks.set(id, { zone: z.id, row: r + 1, cx: x + z.rw / 2, ay: y + RH + 9 });
        for (let t = 1; t <= z.tiers; t++) {
          for (let c = 1; c <= z.cells; c++) {
            meta.set(`${id}-${t}-${c}`, { rack: id, zone: z.id, row: r + 1, tier: t, tiers: z.tiers, prefer: z.prefer || 'low' });
          }
        }
      }
    }
  }
  return { zones, zoneById, racks, meta };
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
  L.zones = n.zones; L.zoneById = n.zoneById; L.racks = n.racks; L.meta = n.meta;
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

module.exports = { buildLayout, validateZones, readLayoutFile, resolveLayout, applyLayout, makeGeometry, zoneOf };
