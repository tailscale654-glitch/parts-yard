// Виджеты дашборда: плитка, линия/столбцы по дням, полосы по категориям, таблица.
import { esc, fmt, fmtDay, table } from './core.js';

const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)'];

function niceMax(v) {
  if (v <= 0) return 4;
  const raw = v / 4, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  return Math.ceil(v / step) * step;
}

export function renderWidget(el, data, viz) {
  if (!data) { el.innerHTML = '<p class="note">Нет данных</p>'; return; }
  if (data.error) { el.innerHTML = `<p class="note err">${esc(data.error)}</p>`; return; }
  if (data.shape === 'scalar') return kpi(el, data);
  if (data.shape === 'series') return viz === 'line' ? seriesChart(el, data, 'line') : seriesChart(el, data, 'columns');
  if (data.shape === 'category') return viz === 'columns' ? catColumns(el, data) : hbars(el, data);
  if (data.shape === 'rows') {
    el.innerHTML = '<div class="wtable"></div>';
    table(el.firstChild, { columns: data.columns, rows: data.rows, empty: 'Всё в порядке' });
  }
}

function kpi(el, d) {
  const alert = d.alertAbove != null && d.value > d.alertAbove;
  el.innerHTML = `<div class="kpiv${alert ? ' alert' : ''}"><div class="v">${fmt(d.value)}${d.unit ? `<small>${esc(d.unit)}</small>` : ''}</div>${d.spark ? spark(d.spark) : ''}</div>
    <div class="kpis-sub">${esc(d.sub || '')}</div>`;
}

function spark(vals) {
  const W = 96, H = 34, max = Math.max(1, ...vals), n = vals.length;
  const x = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * (W - 4) + 2), y = (v) => H - 3 - (v / max) * (H - 8);
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path class="a" d="${line}L${x(n - 1)},${H}L${x(0)},${H}Z"/><path class="l" d="${line}"/><circle cx="${x(n - 1)}" cy="${y(vals[n - 1])}" r="2.5"/></svg>`;
}

function legend(series) {
  return series.length > 1 ? `<div class="legend-s">${series.map((s, i) => `<span><i style="background:${SERIES[i % 4]}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
}

function seriesChart(el, d, mode) {
  const W = Math.max(280, Math.round(el.clientWidth || 560)), H = 190;
  const ml = 38, mr = 8, mt = 8, mb = 22, iw = W - ml - mr, ih = H - mt - mb;
  const n = d.labels.length, all = d.series.flatMap((s) => s.values);
  const max = niceMax(Math.max(...all, 0));
  const y = (v) => mt + ih - (v / max) * ih;
  const step = iw / n;
  let g = '<g class="grid">';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    g += `<line x1="${ml}" x2="${W - mr}" y1="${yy}" y2="${yy}"/><text x="${ml - 6}" y="${yy + 3}" text-anchor="end">${fmt(Math.round(v))}</text>`;
  }
  g += '</g>';
  const every = Math.max(1, Math.ceil(n / Math.floor(iw / 44)));
  let xl = '';
  d.labels.forEach((lb, i) => {
    if ((n - 1 - i) % every === 0) xl += `<text x="${ml + step * i + step / 2}" y="${H - 6}" text-anchor="middle">${fmtDay(lb)}</text>`;
  });
  let marks = '';
  if (mode === 'columns') {
    const k = d.series.length, gw = Math.max(2, step * 0.72), bw = Math.max(1.5, gw / k - (k > 1 ? 1 : 0));
    d.series.forEach((s, si) => s.values.forEach((v, i) => {
      if (!v) return;
      const x = ml + step * i + (step - gw) / 2 + si * (gw / k);
      marks += `<rect x="${x.toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(mt + ih - y(v)).toFixed(1)}" rx="1.5" fill="${SERIES[si % 4]}"><title>${esc(s.name)} · ${fmtDay(d.labels[i])}: ${fmt(v)}</title></rect>`;
    }));
  } else {
    d.series.forEach((s, si) => {
      const pts = s.values.map((v, i) => `${(ml + step * i + step / 2).toFixed(1)},${y(v).toFixed(1)}`);
      marks += `<polyline points="${pts.join(' ')}" fill="none" stroke="${SERIES[si % 4]}" stroke-width="2" stroke-linejoin="round"/>`;
      const li = s.values.length - 1;
      marks += `<circle cx="${ml + step * li + step / 2}" cy="${y(s.values[li])}" r="3.2" fill="${SERIES[si % 4]}"><title>${esc(s.name)}: ${fmt(s.values[li])}</title></circle>`;
      s.values.forEach((v, i) => { marks += `<circle cx="${ml + step * i + step / 2}" cy="${y(v)}" r="7" fill="transparent"><title>${esc(s.name)} · ${fmtDay(d.labels[i])}: ${fmt(v)}</title></circle>`; });
    });
  }
  const sum = d.series.map((s) => s.values.reduce((a, b) => a + b, 0));
  el.innerHTML = `${legend(d.series)}<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(d.title)}">${g}<line class="axis" x1="${ml}" x2="${W - mr}" y1="${mt + ih}" y2="${mt + ih}"/>${marks}${xl}</svg>
    <div class="note">За период: ${d.series.map((s, i) => `${esc(s.name.toLowerCase())} ${fmt(sum[i])}${d.unit ? ' ' + esc(d.unit) : ''}`).join(' · ')}</div>`;
}

function hbars(el, d) {
  const max = d.max || Math.max(1, ...d.items.map((x) => x.value));
  if (!d.items.length) { el.innerHTML = '<p class="note">Нет данных за период</p>'; return; }
  el.innerHTML = `<div class="hbars">${d.items.map((x) => `<div class="hbar"><span class="lb" title="${esc(x.label)}">${esc(x.label)}</span>
    <span class="vl">${fmt(x.value)}${d.unit === '%' ? '%' : ''}${x.note ? `<small>${esc(x.note)}</small>` : ''}</span>
    <span class="track"><i style="width:${Math.max(0, Math.min(100, (x.value / max) * 100))}%"></i></span></div>`).join('')}</div>`;
}

function catColumns(el, d) {
  if (!d.items.length) { el.innerHTML = '<p class="note">Нет данных за период</p>'; return; }
  const W = Math.max(280, Math.round(el.clientWidth || 560)), H = 200, ml = 38, mr = 8, mt = 14, mb = 34;
  const iw = W - ml - mr, ih = H - mt - mb, n = d.items.length, step = iw / n;
  const max = d.max || niceMax(Math.max(...d.items.map((x) => x.value), 0));
  const y = (v) => mt + ih - (v / max) * ih;
  let s = '<g class="grid">';
  for (let i = 0; i <= 4; i++) { const v = (max / 4) * i; s += `<line x1="${ml}" x2="${W - mr}" y1="${y(v)}" y2="${y(v)}"/><text x="${ml - 6}" y="${y(v) + 3}" text-anchor="end">${fmt(Math.round(v))}</text>`; }
  s += '</g>';
  const maxChars = Math.max(3, Math.floor(step / 6.2));
  d.items.forEach((x, i) => {
    const bw = Math.min(56, step * 0.62), cx = ml + step * i + step / 2;
    s += `<rect x="${cx - bw / 2}" y="${y(x.value)}" width="${bw}" height="${mt + ih - y(x.value)}" rx="2" fill="var(--s1)"><title>${esc(x.label)}: ${fmt(x.value)}</title></rect>`;
    s += `<text x="${cx}" y="${y(x.value) - 4}" text-anchor="middle" style="fill:var(--ink)">${fmt(x.value)}</text>`;
    const lb = x.label.length > maxChars ? x.label.slice(0, maxChars - 1) + '…' : x.label;
    s += `<text x="${cx}" y="${H - mb + 14}" text-anchor="middle">${esc(lb)}</text>`;
  });
  el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(d.title)}">${s}<line class="axis" x1="${ml}" x2="${W - mr}" y1="${mt + ih}" y2="${mt + ih}"/></svg>`;
}

export const VIZ_LABEL = { kpi: 'Плитка', line: 'Линия', columns: 'Столбцы', bars: 'Полосы', table: 'Таблица' };
