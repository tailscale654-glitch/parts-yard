'use strict';
// Топология склада: зоны → ряды → стеллажи → ярусы → ячейки.
// Координаты совпадают со схемой в веб-интерфейсе и используются для порядка обхода.
const fs = require('fs');

const CX = 470;   // центральный проезд
const RH = 16;    // высота стеллажа на схеме
const RS = 34;    // шаг рядов

function pad(n) { return String(n).padStart(2, '0'); }

function loadLayout(file) {
  const layout = JSON.parse(fs.readFileSync(file, 'utf8'));
  const racks = new Map();
  const meta = new Map();
  const zones = new Map();
  for (const z of layout.zones) {
    for (const k of ['id', 'rows', 'racks', 'tiers', 'cells', 'x', 'y', 'rw']) {
      if (z[k] === undefined) throw new Error(`layout.json: у зоны ${z.id || '?'} нет поля ${k}`);
    }
    zones.set(z.id, z);
    for (let r = 0; r < z.rows; r++) {
      for (let k = 0; k < z.racks; k++) {
        const id = `${z.id}-${pad(r + 1)}-${pad(k + 1)}`;
        const x = z.x + k * (z.rw + 2);
        const y = z.y + r * RS;
        racks.set(id, { zone: z.id, cx: x + z.rw / 2, ay: y + RH + 9 });
        for (let t = 1; t <= z.tiers; t++) {
          for (let c = 1; c <= z.cells; c++) {
            meta.set(`${id}-${t}-${c}`, { rack: id, zone: z.id, tier: t, tiers: z.tiers, prefer: z.prefer || 'low' });
          }
        }
      }
    }
  }
  return { zones: layout.zones, zoneById: zones, racks, meta };
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

module.exports = { loadLayout, makeGeometry };
