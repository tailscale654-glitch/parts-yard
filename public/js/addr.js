// Адреса ячеек — то же, что zoneCells/addrKey в src/layout.js (держать одинаковыми).
//   scheme "rows":  A-01-02-3-1  (зона-ряд-стеллаж-ярус-ячейка)
//   scheme "racks": A-08-01-02   (зона-стеллаж-ярус-ячейка, стеллажи нумеруются с start)
const pad = (n) => String(n).padStart(2, '0');

export function zoneRacks(z) {
  const out = [];
  for (let r = 0; r < z.rows; r++) {
    for (let k = 0; k < z.racks; k++) {
      const racks = z.scheme === 'racks';
      const no = racks ? (z.start || 1) + r * z.racks + k : k + 1;
      const id = racks ? `${z.id}-${pad(no)}` : `${z.id}-${pad(r + 1)}-${pad(k + 1)}`;
      out.push({ id, r, k, no, cell: (t, c) => (racks ? `${id}-${pad(t)}-${pad(c)}` : `${id}-${t}-${c}`) });
    }
  }
  return out;
}
export function addrKey(s) {
  const parts = String(s || '').toUpperCase().replace(/[\s_.]+/g, '-').split('-').filter(Boolean);
  return parts.map((p) => (/^\d+$/.test(p) ? String(Number(p)) : p)).join('-');
}
// индекс «как написали» → настоящий адрес/стеллаж
export function addrIndex(zones) {
  const idx = new Map();
  for (const z of zones) {
    for (const rk of zoneRacks(z)) {
      idx.set(addrKey(rk.id), { kind: 'rack', id: rk.id, z });
      for (let t = 1; t <= z.tiers; t++) for (let c = 1; c <= z.cells; c++) { const a = rk.cell(t, c); idx.set(addrKey(a), { kind: 'cell', id: a, rack: rk.id, z }); }
    }
  }
  return idx;
}
export function example(z) { return z && z.scheme === 'racks' ? `${z.id}-${pad(z.start || 1)}-01-01` : `${z ? z.id : 'A'}-01-01-1-1`; }
