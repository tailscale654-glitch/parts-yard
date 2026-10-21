// Карта склада: план зон, фасады стеллажей, приёмка и отбор по маршруту.
import { api, esc, pad, can, toast, fail, bus, pageHead, fmtTs } from '../core.js';
import { zoneRacks, addrIndex, addrKey, example } from '../addr.js';

const CX = 470, RH = 16, RS = 34, RECV = { x: 220, y: 448 }, SHIP = { x: 716, y: 448 };
let MAP_H = 580;

export async function mount(root, { params }) {
  let ZONES = [], SKU = {}, SKUS = [], RACKS = [], RACK = {}, META = {}, S = null, IDX = new Map();
  const U = { tab: 'rack', rack: null, cell: null, hl: new Set(), route: null, asn: null, order: null, plan: null, q: '', skuSel: null, busy: false };

  root.innerHTML = `${pageHead('Карта склада', 'Нажмите на стеллаж, чтобы увидеть ячейки. Приёмка и отбор строят маршрут прямо на схеме.')}
    <div class="mkpis" id="kpis"></div>
    <div class="mgrid">
      <section class="mapwrap" aria-label="Схема склада">
        <div class="maphead"><h2 id="mapTitle">План склада</h2>
          <div class="legend"><span><i style="background:var(--f0)"></i>пусто</span><span><i style="background:var(--f1)"></i>&lt;35%</span>
            <span><i style="background:var(--f2)"></i>&lt;70%</span><span><i style="background:var(--f3)"></i>&lt;95%</span>
            <span><i style="background:var(--f4)"></i>полный</span><span><i style="background:var(--bad);width:6px"></i>блок</span></div></div>
        <svg class="map" id="map" viewBox="0 0 940 580" role="img" aria-label="План склада"></svg>
      </section>
      <aside class="panel">
        <div class="search"><input id="q" type="search" placeholder="Артикул, название или адрес"  autocomplete="off" aria-label="Поиск"></div>
        <div class="ptabs" role="tablist" id="tabs"></div>
        <div class="pbody" id="body"></div>
      </aside>
    </div>`;
  const svg = root.querySelector('#map');

  function buildGeometry() {
    RACKS = []; RACK = {}; META = {};
    for (const z of ZONES) for (const q of zoneRacks(z)) {
      const { id, r, k } = q, x = z.x + k * (z.rw + 2), y = z.y + r * RS;
      const rk = { id, zone: z.id, z, r, k, no: q.no, at: q.cell, x, y, w: z.rw, cx: x + z.rw / 2, ay: y + RH + 9, cells: [] };
      for (let t = 1; t <= z.tiers; t++) for (let c = 1; c <= z.cells; c++) { const a = q.cell(t, c); rk.cells.push(a); META[a] = { rack: id, zone: z.id, tier: t, cell: c }; }
      RACKS.push(rk); RACK[id] = rk;
    }
    IDX = addrIndex(ZONES);
  }
  let HOME = {};
  function setState(st) {
    S = st; SKUS = st.skus; SKU = Object.fromEntries(SKUS.map((s) => [s.art, s]));
    HOME = {};
    for (const s of SKUS) for (const a of s.home || []) (HOME[a] = HOME[a] || []).push(s.art);
  }
  const cellOf = (a) => { const c = S.cells[a]; return c ? { sku: c[0], qty: c[1], blocked: !!c[2] } : { sku: null, qty: 0, blocked: false }; };
  const skuName = (a) => (SKU[a] ? SKU[a].name : a);
  function rackFill(id) { let f = 0, b = 0; for (const a of RACK[id].cells) { const c = cellOf(a); if (c.blocked) b++; if (c.sku && SKU[c.sku]) f += c.qty / SKU[c.sku].per; } return { fill: f / RACK[id].cells.length, blocked: b }; }
  const fcls = (f) => (f === 0 ? 'f0' : f < 0.35 ? 'f1' : f < 0.7 ? 'f2' : f < 0.95 ? 'f3' : 'f4');
  const sortRoute = (st) => st.sort((p, q) => { const a = RACK[META[p.addr].rack], b = RACK[META[q.addr].rack]; return a.ay - b.ay || a.cx - b.cx || META[p.addr].tier - META[q.addr].tier; });
  function routePath(stops, home) {
    const pts = [home, { x: CX, y: home.y }]; let cur = { x: CX, y: home.y };
    for (const s of stops) {
      const rk = RACK[META[s.addr].rack], p = { x: rk.cx, y: rk.ay };
      if (Math.abs(cur.y - p.y) > 0.5) pts.push({ x: CX, y: cur.y }, { x: CX, y: p.y });
      pts.push(p); cur = p;
    }
    pts.push({ x: CX, y: cur.y }, { x: CX, y: home.y }, home);
    return pts.map((p) => p.x + ',' + p.y).join(' ');
  }

  function drawMap() {
    // высота схемы — по зонам, без пустого поля внизу
    MAP_H = Math.max(220, ...ZONES.map((z) => z.y + (z.rows - 1) * RS + RH + 36));
    svg.setAttribute('viewBox', `0 0 940 ${MAP_H}`);
    RECV.y = SHIP.y = MAP_H - 16;
    let h = `<rect class="floor" x="10" y="10" width="920" height="${MAP_H - 20}" rx="6"/>`;
    h += `<line class="corr" x1="${CX}" y1="40" x2="${CX}" y2="${MAP_H - 24}"/>`;
    for (const z of ZONES) {
      const w = z.racks * (z.rw + 2) - 2, hgt = (z.rows - 1) * RS + RH + 18;
      h += `<rect class="zoneframe" x="${z.x - 12}" y="${z.y - 8}" width="${w + 24}" height="${hgt + 8}" rx="4"/>`;
      h += `<text class="zlabel" x="${z.x - 12}" y="${z.y - 22}">${esc(z.title)}</text><text class="zsub" x="${z.x + 40}" y="${z.y - 22}">${esc(z.sub)}</text>`;
      for (let r = 0; r < z.rows; r++) h += `<text class="rowlbl" x="${z.x - 4}" y="${z.y + r * RS + 11}" text-anchor="end">${pad(r + 1)}</text>`;
    }
    for (const rk of RACKS) h += `<rect class="rk" data-rack="${rk.id}" x="${rk.x}" y="${rk.y}" width="${rk.w}" height="${RH}" rx="2"><title>${rk.id}</title></rect>`;
    h += '<g id="blk"></g>';
    h += '<g id="ov"></g>';
    svg.innerHTML = h;
  }
  function paint() {
    let bl = '';
    const hlR = new Set([...U.hl].map((a) => META[a] && META[a].rack));
    for (const rk of RACKS) {
      const el = svg.querySelector(`[data-rack="${rk.id}"]`), { fill, blocked } = rackFill(rk.id);
      el.setAttribute('class', `rk ${fcls(fill)}${U.rack === rk.id ? ' sel' : ''}${hlR.has(rk.id) ? ' hl' : ''}`);
      el.querySelector('title').textContent = `${rk.id} · заполнено ${Math.round(fill * 100)}%${blocked ? ' · блок: ' + blocked : ''}`;
      if (blocked) bl += `<rect class="blk" x="${rk.x + rk.w - 5}" y="${rk.y + 1}" width="4" height="4"/>`;
    }
    svg.querySelector('#blk').innerHTML = bl;
    let ov = '';
    if (U.route && U.route.stops.length) {
      const pts = routePath(U.route.stops, U.route.home);
      ov += `<polyline class="routeh" points="${pts}"/><polyline class="route" points="${pts}"/>`;
      const seen = {};
      U.route.stops.forEach((s, i) => {
        const rk = RACK[META[s.addr].rack], d = (seen[rk.id] = (seen[rk.id] || 0) + 1) - 1;
        ov += `<circle class="stop" cx="${rk.cx + d * 9}" cy="${rk.ay}" r="7"/><text class="stopn" x="${rk.cx + d * 9}" y="${rk.ay}">${i + 1}</text>`;
      });
    }
    svg.querySelector('#ov').innerHTML = ov;
  }
  function kpis() {
    const tot = Object.keys(META).length; let occ = 0, blk = 0;
    for (const a in S.cells) { const c = S.cells[a]; if (c[2]) blk++; if (c[0]) occ++; }
    const k = [[tot, 'ячеек'], [Math.round((occ / tot) * 100) + '%', 'занято ячеек'], [tot - occ - blk, 'свободно'], [blk, 'заблокировано'],
      [S.receipts.filter((x) => !x.done).length, 'к размещению'], [S.orders.filter((x) => !x.done).length, 'заказов к сборке']];
    root.querySelector('#kpis').innerHTML = k.map(([v, l]) => `<div class="mkpi"><b>${v}</b><span>${l}</span></div>`).join('');
  }
  function tabs() {
    const t = [['rack', 'Стеллаж', ''], ['in', 'Приёмка', S.receipts.filter((x) => !x.done).length], ['out', 'Отбор', S.orders.filter((x) => !x.done).length], ['log', 'Журнал', '']];
    root.querySelector('#tabs').innerHTML = t.map(([id, l, c]) => `<button role="tab" data-tab="${id}" aria-selected="${U.tab === id}">${l}${c !== '' ? `<span class="cnt">${c}</span>` : ''}</button>`).join('');
  }

  function searchView() {
    const q = U.q.trim().toLowerCase();
    const res = SKUS.filter((s) => s.art.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)).slice(0, 8);
    if (!res.length) return '<div class="sec"><h3>Поиск</h3><p class="hint">Ничего не найдено. Адрес вводите как <span class="mono">B-03-08</span>.</p></div>';
    return `<div class="sec"><h3>Найдено в каталоге</h3><div class="list">${res.map((s) => {
      const cells = Object.keys(S.cells).filter((a) => S.cells[a][0] === s.art), total = cells.reduce((n, a) => n + S.cells[a][1], 0), open = U.skuSel === s.art;
      return `<button class="li${open ? ' on' : ''}" data-sku="${esc(s.art)}"><span>${esc(s.name)}</span><span class="mono">${total} шт</span><span class="sub mono">${esc(s.art)} · зона ${esc(s.zone)} · ${cells.length} яч.</span></button>${open ? `<div style="padding:8px 10px" class="chips">${sortRoute(cells.filter((a) => META[a]).map((a) => ({ addr: a }))).map((x) => `<button class="chip" data-goto="${x.addr}">${x.addr} · ${S.cells[x.addr][1]}</button>`).join('')}</div>` : ''}`;
    }).join('')}</div></div>`;
  }
  function rackView() {
    if (!U.rack) {
      return `<p class="hint">Нажмите на стеллаж на схеме, чтобы увидеть ячейки по ярусам.</p><div class="sec"><h3>Заполненность зон</h3><div style="display:flex;flex-direction:column;gap:8px">${ZONES.map((z) => {
        const rs = RACKS.filter((r) => r.zone === z.id), f = rs.reduce((n, r) => n + rackFill(r.id).fill, 0) / rs.length, cells = rs.reduce((n, r) => n + r.cells.length, 0);
        return `<div class="zstat"><b class="mono">${esc(z.id)}</b><div class="bar"><i style="width:${f * 100}%"></i></div><span class="mono" style="text-align:right">${Math.round(f * 100)}%</span></div><div class="note" style="margin:-4px 0 0 36px">${esc(z.sub)} · ${rs.length} стеллажей · ${cells} ячеек · ярусов ${z.tiers}</div>`;
      }).join('')}</div></div>
      <div class="sec"><h3>Как читать адрес</h3><p class="hint">${ZONES.some((z) => z.scheme === 'racks') ? '<span class="mono">A-08-01-02</span>: зона A, стеллаж 08, ярус 01 (снизу вверх), ячейка 02 (слева направо).' : '<span class="mono">A-02-07-3-1</span>: зона A, ряд 02, стеллаж 07, ярус 3 (снизу вверх), ячейка 1 (слева направо).'}</p></div>`;
    }
    const rk = RACK[U.rack], z = rk.z, { fill } = rackFill(rk.id);
    let g = `<div class="elev" style="grid-template-columns:22px repeat(${z.cells},minmax(0,1fr))">`;
    for (let t = z.tiers; t >= 1; t--) {
      g += `<span class="tierlbl">${t}</span>`;
      for (let c = 1; c <= z.cells; c++) {
        const a = rk.at(t, c), x = cellOf(a), s = x.sku && SKU[x.sku];
        g += `<button class="cell${x.sku ? '' : ' empty'}${x.blocked ? ' blocked' : ''}${U.cell === a ? ' on' : ''}${U.hl.has(a) ? ' hl' : ''}" data-cell="${a}" aria-label="Ячейка ${a}">
          <span class="t">${t}-${c}</span><span class="a">${x.blocked ? 'БЛОК' : x.sku ? esc(x.sku) : HOME[a] ? `<span class="note">за ${esc(HOME[a][0])}</span>` : 'свободна'}</span>${s ? `<span class="n">${esc(s.name)}</span><div class="bar"><i style="width:${Math.min(100, (x.qty / s.per) * 100)}%"></i></div>` : ''}</button>`;
      }
    }
    g += '</div>';
    return `<div class="row" style="justify-content:space-between"><div><div class="addr">${rk.id}</div><div class="note">${esc(z.title)} · ${z.scheme === 'racks' ? `стеллаж ${pad(rk.no)}` : `ряд ${pad(rk.r + 1)} · стеллаж ${pad(rk.k + 1)}`} · заполнено ${Math.round(fill * 100)}%</div></div><button class="btn sm" data-act="closerack">Закрыть</button></div>
      <div class="sec"><h3>Фасад стеллажа</h3>${g}</div>${U.cell ? cellCard() : ''}`;
  }
  function cellCard() {
    const a = U.cell, c = cellOf(a), s = c.sku && SKU[c.sku], m = META[a];
    return `<div class="mcard"><div class="row" style="justify-content:space-between"><span class="addr">${a}</span>${c.blocked ? '<span class="pill bad">заблокирована</span>' : c.sku ? '<span class="pill ok">занята</span>' : '<span class="pill wait">свободна</span>'}</div>
      <dl class="kv"><dt>Ярус / ячейка</dt><dd>${m.tier} / ${m.cell}</dd>
      ${HOME[a] ? `<dt>Закреплена за</dt><dd class="mono">${HOME[a].map(esc).join(', ')}</dd>` : ''}
      ${c.sku ? `<dt>Артикул</dt><dd class="mono">${esc(c.sku)}</dd><dt>Наименование</dt><dd>${esc(skuName(c.sku))}</dd><dt>Остаток</dt><dd class="mono">${c.qty}${s ? ' из ' + s.per : ''} шт</dd>` : `<dt>Назначение</dt><dd>${esc(ZONES.find((z) => z.id === m.zone).sub)}</dd>`}</dl>
      ${c.sku && can('stock.count') ? `<div class="row"><label for="cnt" class="note">Пересчёт, шт</label><input id="cnt" class="qty mono" type="number" min="0" max="${s ? s.per : ''}" value="${c.qty}"><button class="btn sm" data-act="count">Сохранить</button></div>` : ''}
      ${c.sku && can('stock.move') ? `<div class="row"><label for="mvTo" class="note">Переместить в</label><input id="mvTo" class="qty mono" style="width:130px" placeholder="${esc(example(ZONES.find((z) => z.id === m.zone)))}"><input id="mvQty" class="qty mono" type="number" min="1" max="${c.qty}" value="${c.qty}" aria-label="Количество"><button class="btn sm" data-act="move">Переместить</button></div>` : ''}
      ${can('stock.block') ? `<div class="row"><button class="btn sm" data-act="block">${c.blocked ? 'Снять блокировку' : 'Заблокировать ячейку'}</button></div>` : ''}</div>`;
  }
  function inView() {
    let h = `<div class="sec"><h3>Поставки к размещению</h3>${S.receipts.length ? `<div class="list">${S.receipts.map((x) =>
      `<button class="li${U.asn === x.id ? ' on' : ''}" data-asn="${x.id}" ${x.done ? 'disabled' : ''}><span>${esc(skuName(x.art))}</span><span class="pill ${x.done ? 'ok' : 'wait'}">${x.done ? 'размещено' : 'ожидает'}</span><span class="sub mono">${esc(x.doc)}${x.gate ? ' · ворота ' + esc(x.gate) : ''} · ${esc(x.art)} · ${x.placed ? `${x.qty - x.placed} из ${x.qty}` : x.qty} шт${SKU[x.art] ? ' · зона ' + esc(SKU[x.art].zone) : ''}</span></button>`).join('')}</div>` : '<p class="hint">Поставок нет. Создайте в разделе «Поставки».</p>'}</div>`;
    const p = U.plan && U.plan.kind === 'in' && U.plan.id === U.asn ? U.plan.data : null;
    if (!U.asn || !S.receipts.some((x) => x.id === U.asn && !x.done)) return h + '<p class="hint">Выберите строку поставки: система подберёт адреса по правилам зоны, сначала дозаполняя ячейки с тем же артикулом, затем свободные ближе к проезду.</p>';
    if (!p) return h + '<p class="hint">Подбираю адреса…</p>';
    h += `<div class="sec"><h3>Предложенные адреса · маршрут от приёмки</h3><table class="steps"><thead><tr><th>№</th><th>Адрес</th><th>Ячейка</th><th class="r">Кол-во</th></tr></thead><tbody>${p.plan.map((x, i) => `<tr><td><span class="no">${i + 1}</span></td><td><button class="chip" data-goto="${x.addr}">${x.addr}</button></td><td class="note">${x.fresh ? 'свободная' : 'дозаполнение'}</td><td class="r mono">${x.qty}</td></tr>`).join('')}</tbody></table>
      ${p.left ? `<p class="err" style="font-size:12.5px">Не хватает места на ${p.left} шт. Остаток останется в буфере приёмки.</p>` : ''}
      ${can('stock.put') ? `<div class="row" style="margin-top:8px"><button class="btn pri" data-act="putaway" ${p.plan.length && !U.busy ? '' : 'disabled'}>Подтвердить размещение</button></div>` : '<p class="note">Размещать может сотрудник с правом «Размещение товара».</p>'}</div>`;
    return h;
  }
  function outView() {
    let h = `<div class="sec"><h3>Заказы дилеров</h3>${S.orders.length ? `<div class="list">${S.orders.map((o) => `<button class="li${U.order === o.id ? ' on' : ''}" data-order="${o.id}" ${o.done ? 'disabled' : ''}><span>${esc(o.dealer)}</span><span class="pill ${o.done ? 'ok' : 'wait'}">${o.done ? 'собран' : o.due ? 'до ' + esc(o.due) : 'в работе'}</span><span class="sub mono">${esc(o.number)} · ${o.lines.length} строк · ${(() => { const t = o.lines.reduce((n, l) => n + l.qty, 0), pk = o.lines.reduce((n, l) => n + l.picked, 0); return pk ? `взято ${pk} из ${t}` : t + ' шт'; })()}</span></button>`).join('')}</div>` : '<p class="hint">Заказов нет. Создайте в разделе «Заказы дилеров».</p>'}</div>`;
    const p = U.plan && U.plan.kind === 'out' && U.plan.id === U.order ? U.plan.data : null;
    if (!U.order || !S.orders.some((x) => x.id === U.order && !x.done)) return h + '<p class="hint">Выберите заказ: система построит маршрут отбора от зоны отгрузки с минимумом точек.</p>';
    if (!p) return h + '<p class="hint">Строю маршрут…</p>';
    h += `<div class="sec"><h3>Лист отбора · ${p.plan.length} точек</h3><table class="steps"><thead><tr><th>№</th><th>Адрес</th><th>Артикул</th><th class="r">Взять</th></tr></thead><tbody>${p.plan.map((x, i) => `<tr><td><span class="no">${i + 1}</span></td><td><button class="chip" data-goto="${x.addr}">${x.addr}</button></td><td><span class="mono">${esc(x.art)}</span><div class="note">${esc(skuName(x.art))}</div></td><td class="r mono">${x.qty}</td></tr>`).join('')}</tbody></table>
      ${p.short.length ? `<p class="err" style="font-size:12.5px">Недостача: ${p.short.map((s) => `${esc(s.art)} — ${s.qty} шт`).join(', ')}</p>` : ''}
      ${can('stock.pick') ? `<div class="row" style="margin-top:8px"><button class="btn pri" data-act="pick" ${U.busy ? 'disabled' : ''}>${p.short.length ? 'Подтвердить отбор и закрыть с недостачей' : 'Подтвердить отбор'}</button></div>` : '<p class="note">Отбирать может сотрудник с правом «Отбор товара».</p>'}</div>`;
    return h;
  }
  function logView() {
    return `<div class="sec"><h3>Последние операции</h3><table class="steps"><thead><tr><th>Время</th><th>Операция</th><th>Адрес</th><th class="r">Кол-во</th></tr></thead><tbody>${S.log.map((l) => `<tr><td class="mono">${fmtTs(l.ts)}</td><td>${esc(l.op)}<div class="note">${[l.art ? `<span class="mono">${esc(l.art)}</span>` : '', esc(l.ref || ''), esc(l.user || '')].filter(Boolean).join(' · ')}</div></td><td>${l.addr && META[l.addr] ? `<button class="chip" data-goto="${l.addr}">${l.addr}</button>` : `<span class="note mono">${esc(l.addr || '—')}</span>`}</td><td class="r mono">${l.qty == null ? '' : l.qty > 0 ? '+' + l.qty : l.qty}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function body() { root.querySelector('#body').innerHTML = (U.q ? searchView() : '') + ({ rack: rackView, in: inView, out: outView, log: logView })[U.tab](); }
  function derive() {
    U.route = null; const hl = new Set();
    const p = U.plan && ((U.tab === 'in' && U.plan.kind === 'in' && U.plan.id === U.asn) || (U.tab === 'out' && U.plan.kind === 'out' && U.plan.id === U.order)) ? U.plan : null;
    if (p) { U.route = { stops: p.data.plan.filter((x) => META[x.addr]), home: p.kind === 'in' ? RECV : SHIP }; p.data.plan.forEach((x) => hl.add(x.addr)); }
    if (U.skuSel) { for (const a in S.cells) if (S.cells[a][0] === U.skuSel) hl.add(a); for (const a of (SKU[U.skuSel] && SKU[U.skuSel].home) || []) hl.add(a); }
    U.hl = hl;
    root.querySelector('#mapTitle').textContent = U.route ? (U.tab === 'in' ? 'Маршрут размещения' : 'Маршрут отбора') : U.skuSel ? 'Ячейки артикула ' + U.skuSel : 'План склада';
  }
  function render() { derive(); kpis(); tabs(); body(); paint(); }

  async function loadPlan() {
    const kind = U.tab === 'in' ? 'in' : 'out', id = kind === 'in' ? U.asn : U.order;
    if (!id) return;
    try { const data = await api(`/api/plan/${kind === 'in' ? 'putaway' : 'pick'}/${id}`); U.plan = { kind, id, data }; } catch (e) { U.plan = null; fail(e); }
    render();
  }
  async function act(path, payload, okMsg) {
    if (U.busy) return; U.busy = true;
    try {
      const r = await api(path + '?state=1', { method: 'POST', opId: true, body: payload || {} });
      setState(r.state);
      if (okMsg) toast(okMsg);
      bus.dispatchEvent(new Event('changed'));
    } catch (e) { fail(e); }
    U.busy = false; U.plan = null; render();
    if ((U.tab === 'in' && U.asn && S.receipts.some((x) => x.id === U.asn && !x.done)) || (U.tab === 'out' && U.order && S.orders.some((x) => x.id === U.order && !x.done))) loadPlan();
  }

  svg.addEventListener('click', (e) => { const r = e.target.closest('[data-rack]'); if (!r) return; U.rack = r.dataset.rack; U.cell = null; U.tab = 'rack'; render(); });
  root.querySelector('#tabs').addEventListener('click', (e) => { const t = e.target.closest('[data-tab]'); if (!t) return; U.tab = t.dataset.tab; render(); if ((U.tab === 'in' && U.asn) || (U.tab === 'out' && U.order)) loadPlan(); });
  root.querySelector('#body').addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]'), c = e.target.closest('[data-cell]'), k = e.target.closest('[data-sku]'),
      a = e.target.closest('[data-asn]'), o = e.target.closest('[data-order]'), b = e.target.closest('[data-act]');
    if (g) { const m = META[g.dataset.goto]; if (m) { U.rack = m.rack; U.cell = g.dataset.goto; U.tab = 'rack'; render(); } return; }
    if (c) { U.cell = c.dataset.cell; render(); return; }
    if (k) { U.skuSel = U.skuSel === k.dataset.sku ? null : k.dataset.sku; render(); return; }
    if (a) { U.asn = +a.dataset.asn; U.plan = null; render(); loadPlan(); return; }
    if (o) { U.order = +o.dataset.order; U.plan = null; render(); loadPlan(); return; }
    if (!b) return;
    const A = b.dataset.act;
    if (A === 'closerack') { U.rack = null; U.cell = null; render(); }
    if (A === 'block') act(`/api/cells/${U.cell}/block`, { blocked: !cellOf(U.cell).blocked }, cellOf(U.cell).blocked ? 'Блокировка снята' : 'Ячейка заблокирована');
    if (A === 'count') act(`/api/cells/${U.cell}/count`, { qty: parseInt(root.querySelector('#cnt').value, 10) }, 'Пересчёт сохранён');
    if (A === 'move') {
      const hit = IDX.get(addrKey(root.querySelector('#mvTo').value)), to = hit && hit.kind === 'cell' ? hit.id : '', qty = parseInt(root.querySelector('#mvQty').value, 10);
      if (!META[to]) { toast('Укажите полный адрес ячейки, например ' + example(ZONES.find((z) => z.id === META[U.cell].zone)), true); return; }
      act('/api/move', { from: U.cell, to, qty }, `Перемещено в ${to}`).then(() => { if (cellOf(to).sku) { U.rack = META[to].rack; U.cell = to; render(); } });
    }
    if (A === 'putaway') act(`/api/receipts/${U.asn}/putaway`, null, 'Размещение проведено');
    if (A === 'pick') act(`/api/orders/${U.order}/pick`, null, 'Отбор проведён');
  });
  const qi = root.querySelector('#q');
  qi.addEventListener('input', () => {
    const v = qi.value.trim(), hit = /\d/.test(v) && /[-\s]/.test(v) ? IDX.get(addrKey(v)) : null;
    if (hit) { U.rack = hit.kind === 'rack' ? hit.id : hit.rack; U.cell = hit.kind === 'cell' ? hit.id : null; U.tab = 'rack'; U.q = ''; U.skuSel = null; render(); return; }
    U.q = v; if (!v) U.skuSel = null; render();
  });

  async function reloadLayout() { const lay = await api('/api/layout'); ZONES = lay.zones; buildGeometry(); drawMap(); }
  async function reloadState() {
    if (U.busy || (document.activeElement && ['cnt', 'mvTo', 'mvQty'].includes(document.activeElement.id))) return;
    try { setState(await api('/api/state')); render(); if (U.plan) loadPlan(); } catch (e) { /* связь пропала — подождём */ }
  }
  const onRev = () => reloadState();
  const onLayout = async () => { await reloadLayout(); await reloadState(); };
  bus.addEventListener('rev', onRev);
  bus.addEventListener('layout', onLayout);

  try {
    await reloadLayout();
    setState(await api('/api/state'));
  } catch (e) { root.innerHTML = `<div class="empty"><b>Не удалось загрузить карту</b>${esc(e.message)}</div>`; return null; }
  if (params.receipt) { U.tab = 'in'; U.asn = +params.receipt; }
  if (params.order) { U.tab = 'out'; U.order = +params.order; }
  if (params.rack && RACK[params.rack]) { U.rack = params.rack; U.cell = null; U.tab = 'rack'; }
  if (params.cell && META[params.cell]) { U.rack = META[params.cell].rack; U.cell = params.cell; }
  if (params.sku) { U.q = params.sku; U.skuSel = params.sku; qi.value = params.sku; }
  render();
  if (U.asn || U.order) loadPlan();
  return () => { bus.removeEventListener('rev', onRev); bus.removeEventListener('layout', onLayout); };
}
