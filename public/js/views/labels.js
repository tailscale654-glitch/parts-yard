// Этикетки ячеек и стеллажей со штрихкодом Code 128 — их сканирует ТСД при приёмке, отборе и пересчёте.
import { api, esc, icon, toast, fail, pageHead, fmt } from '../core.js';
import { zoneRacks } from '../addr.js';
import { code128Svg } from '../code128.js';

const FORMATS = {
  t58: { name: 'Термоэтикетка 58×40 мм', w: 58, h: 40, page: '58mm 40mm', af: 7.2, bh: 13 },
  t75: { name: 'Термоэтикетка 75×50 мм', w: 75, h: 50, page: '75mm 50mm', af: 9.5, bh: 17 },
  t100: { name: 'Термоэтикетка 100×50 мм', w: 100, h: 50, page: '100mm 50mm', af: 11, bh: 18 },
  a4: { name: 'Лист A4: 24 наклейки 70×37 мм', w: 70, h: 37, page: 'A4', af: 7, bh: 12, cols: 3, rows: 8 },
};
const MAX = 5000;
const plural = (n, one, few, many) => { const a = n % 100, b = n % 10; return a > 10 && a < 15 ? many : b === 1 ? one : b > 1 && b < 5 ? few : many; };
const ZOOMS = { 1: 'Крупно', 0.75: 'Средне', 0.5: 'Мелко' };

// «01-05, 08» → множество номеров стеллажей; пусто — все
function parseRange(s) {
  const out = new Set();
  for (const part of String(s || '').split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`Не понял «${part}». Пример: 1-5, 8`);
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    if (b < a || b - a > 999) throw new Error(`Неверный диапазон «${part}»`);
    for (let i = a; i <= b; i++) out.add(i);
  }
  return out;
}

export async function mount(root) {
  const [lay, st] = await Promise.all([api('/api/layout'), api('/api/state')]);
  const zones = lay.zones;
  const homeOf = new Map();
  for (const s of st.skus) for (const a of s.home || []) if (!homeOf.has(a)) homeOf.set(a, s.art);
  const saved = (() => { try { return JSON.parse(localStorage.getItem('pyard.labels') || '{}'); } catch (e) { return {}; } })();

  root.innerHTML = `${pageHead('Этикетки ячеек', 'Штрихкод Code 128 с адресом. ТСД и камера телефона читают его при приёмке, отборе и пересчёте.')}
    <div class="card"><div class="cb">
      <div class="filters" style="margin:0">
        <label class="field"><span>Что печатать</span><select class="in" id="kind"><option value="cell">Ячейки</option><option value="rack">Стеллажи</option></select></label>
        <label class="field"><span>Зона</span><select class="in" id="zone"><option value="*">Все зоны</option>${zones.map((z) => `<option value="${esc(z.id)}">${esc(z.id)} — ${esc(z.title || '')}</option>`).join('')}</select></label>
        <label class="field" style="min-width:180px"><span>Стеллажи</span><input class="in mono" id="racks" placeholder="все, или 1-5, 8"></label>
        <label class="field" id="tiersf" style="min-width:140px"><span>Ярусы</span><input class="in mono" id="tiers" placeholder="все, или 1-2"></label>
        <label class="field"><span>Формат</span><select class="in" id="fmt">${Object.entries(FORMATS).map(([k, f]) => `<option value="${k}">${esc(f.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Просмотр</span><select class="in" id="zoom">${Object.entries(ZOOMS).map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></label>
      </div>
      <div class="row" style="gap:18px;margin-top:10px;flex-wrap:wrap">
        <label class="check" id="usedf"><input type="checkbox" id="used">Только занятые и закреплённые за артикулом</label>
        <label class="check"><input type="checkbox" id="home" checked>Печатать закреплённый артикул</label>
      </div>
      <div class="row" style="justify-content:space-between;gap:12px;margin-top:14px;flex-wrap:wrap">
        <span class="note" id="cnt"></span>
        <button class="btn pri" id="print">${icon('download')}Печать</button>
      </div>
    </div></div>
    <div class="infobox" style="margin-top:12px">Термопринтер: в настройках печати браузера выберите принтер, размер бумаги как у этикетки, поля «нет», масштаб 100%. Лист A4 — обычный принтер, наклейки 70×37 мм (3×8).</div>
    <div class="lbl-prev" id="prev"></div>`;

  const $ = (s) => root.querySelector(s);
  if (saved.kind) $('#kind').value = saved.kind;
  if (saved.zone && (saved.zone === '*' || zones.some((z) => z.id === saved.zone))) $('#zone').value = saved.zone;
  $('#zoom').value = ZOOMS[saved.zoom] ? String(saved.zoom) : '0.75';
  if (saved.fmt && FORMATS[saved.fmt]) $('#fmt').value = saved.fmt;
  if (saved.used) $('#used').checked = true;
  if (saved.home === false) $('#home').checked = false;

  // grp — заголовок группы в просмотре: стеллаж для ячеек, зона для стеллажей
  function items() {
    const zv = $('#zone').value;
    const list = zv === '*' ? zones : zones.filter((x) => x.id === zv);
    const rs = parseRange($('#racks').value), ts = parseRange($('#tiers').value);
    const onlyUsed = $('#used').checked, out = [];
    for (const z of list) {
      const racks = zoneRacks(z).filter((rk) => !rs.size || rs.has(rk.no));
      const zt = `Зона ${z.id}${z.title && z.title !== `Зона ${z.id}` ? ` — ${z.title}` : ''}`;
      if ($('#kind').value === 'rack') {
        for (const rk of racks) out.push({ code: rk.id, grp: zt, rack: true,
          sub: z.scheme === 'racks' ? `Зона ${z.id} · стеллаж ${String(rk.no).padStart(2, '0')}` : `Зона ${z.id} · ряд ${rk.r + 1} · стеллаж ${rk.k + 1}` });
        continue;
      }
      for (const rk of racks) {
        for (let t = 1; t <= z.tiers; t++) {
          if (ts.size && !ts.has(t)) continue;
          for (let c = 1; c <= z.cells; c++) {
            const a = rk.cell(t, c);
            const home = homeOf.get(a), busy = st.cells[a];
            if (onlyUsed && !home && !(busy && busy[0])) continue;
            out.push({ code: a, grp: `Стеллаж ${rk.id}`, sub: `Ярус ${t} · ячейка ${c}`, home });
          }
        }
      }
    }
    return out;
  }

  function labelHtml(it, f) {
    const home = $('#home').checked && it.home ? `<div class="s mono">за ${esc(it.home)}</div>` : '';
    return `<div class="lbl${it.rack ? ' rack' : ''}" style="--w:${f.w}mm;--h:${f.h}mm;--af:${it.rack ? f.af * 1.35 : f.af}mm;--bh:${f.bh}mm">
      <div class="a">${esc(it.code)}</div>${code128Svg(it.code)}<div class="s">${esc(it.sub)}</div>${home}</div>`;
  }

  let list = [], token = 0;
  // все этикетки на одной странице; рисуем порциями, чтобы страница не подвисала на тысячах ячеек
  function render(f) {
    const my = ++token, prev = $('#prev');
    prev.innerHTML = '';
    prev.style.zoom = $('#zoom').value;
    prev.style.setProperty('--z', $('#zoom').value);
    const counts = new Map();
    for (const it of list) counts.set(it.grp, (counts.get(it.grp) || 0) + 1);
    let i = 0, last = null;
    const step = () => {
      if (my !== token) return;
      const end = Math.min(list.length, i + (i === 0 ? 200 : 400));
      let html = '';
      for (; i < end; i++) {
        const it = list[i];
        if (it.grp !== last) { last = it.grp; html += `<div class="lbl-grp">${esc(it.grp)}<span>${counts.get(it.grp)}</span></div>`; }
        html += labelHtml(it, f);
      }
      prev.insertAdjacentHTML('beforeend', html);
      if (i < list.length) requestAnimationFrame(step);
    };
    step();
  }

  function draw() {
    const f = FORMATS[$('#fmt').value];
    $('#tiersf').hidden = $('#usedf').hidden = $('#kind').value === 'rack';
    try { list = items(); } catch (e) { token++; $('#cnt').innerHTML = `<span class="err">${esc(e.message)}</span>`; $('#prev').innerHTML = ''; list = []; return; }
    const sheets = f.cols ? Math.ceil(list.length / (f.cols * f.rows)) : 0;
    const groups = new Set(list.map((it) => it.grp)).size;
    $('#cnt').innerHTML = list.length
      ? `<b>${fmt(list.length)}</b> ${plural(list.length, 'этикетка', 'этикетки', 'этикеток')}${$('#kind').value === 'cell' ? ` · ${fmt(groups)} ${plural(groups, 'стеллаж', 'стеллажа', 'стеллажей')}` : ''}${sheets ? ` · ${fmt(sheets)} ${plural(sheets, 'лист', 'листа', 'листов')} A4` : ''}${list.length > MAX ? ` · <span class="err">для печати выберите не больше ${fmt(MAX)}</span>` : ''}`
      : 'Нет ячеек под выбранные условия';
    render(f);
    try { localStorage.setItem('pyard.labels', JSON.stringify({ kind: $('#kind').value, zone: $('#zone').value, fmt: $('#fmt').value, used: $('#used').checked, home: $('#home').checked, zoom: $('#zoom').value })); } catch (e) { /* без памяти */ }
  }

  function print() {
    if (!list.length) return toast('Нечего печатать', true);
    if (list.length > MAX) return toast(`Не больше ${fmt(MAX)} этикеток за раз — выберите зону или часть стеллажей`, true);
    const f = FORMATS[$('#fmt').value];
    cleanupPrint();
    const style = document.createElement('style');
    style.id = 'lblstyle';
    style.textContent = `@page{size:${f.page};margin:0}
      @media print{html,body{background:#fff!important}body>*:not(#lblprint){display:none!important}#lblprint{display:block!important}}`;
    const host = document.createElement('div');
    host.id = 'lblprint';
    const html = list.map((it) => labelHtml(it, f));
    if (f.cols) {
      const per = f.cols * f.rows, pages = [];
      for (let i = 0; i < html.length; i += per) pages.push(`<div class="lbl-sheet" style="--cols:${f.cols};--w:${f.w}mm;--h:${f.h}mm">${html.slice(i, i + per).join('')}</div>`);
      host.innerHTML = pages.join('');
    } else {
      host.innerHTML = html.join('');
      host.classList.add('roll');
    }
    document.head.appendChild(style);
    document.body.appendChild(host);
    setTimeout(() => { window.print(); }, 50);
  }
  function cleanupPrint() { document.getElementById('lblstyle')?.remove(); document.getElementById('lblprint')?.remove(); }
  const after = () => cleanupPrint();
  window.addEventListener('afterprint', after);

  for (const id of ['kind', 'zone', 'fmt', 'used', 'home']) $('#' + id).addEventListener('change', draw);
  $('#zoom').addEventListener('change', draw);
  for (const id of ['racks', 'tiers']) $('#' + id).addEventListener('input', draw);
  $('#print').addEventListener('click', () => { try { print(); } catch (e) { fail(e); } });
  draw();
  return () => { token++; window.removeEventListener('afterprint', after); cleanupPrint(); };
}
