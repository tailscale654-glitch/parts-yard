// Общие функции интерфейса: запросы к серверу, права, окна, таблицы, форматирование.

export const S = { me: null, perms: new Set(), settings: {}, demo: false, permCatalog: [] };
export const can = (p) => S.perms.has(p);

export class ApiError extends Error {
  constructor(msg, status, data) { super(msg); this.status = status; this.code = data && data.code; this.data = data; }
}

export async function api(path, opt = {}) {
  const init = { method: opt.method || 'GET', headers: { ...(opt.headers || {}) }, cache: 'no-store' };
  if (opt.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opt.body); }
  if (opt.raw !== undefined) { init.headers['Content-Type'] = opt.type || 'application/octet-stream'; init.body = opt.raw; }
  if (opt.opId) init.headers['X-Op-Id'] = newOpId();
  let r;
  try { r = await fetch(path, init); } catch (e) { throw new ApiError('Нет связи с сервером', 0, null); }
  let d = null;
  try { d = await r.json(); } catch (e) { /* не JSON */ }
  if (r.status === 401 && path !== '/api/login') { location.href = '/login'; throw new ApiError('Нужно войти', 401, d); }
  if (!r.ok || (d && d.ok === false)) throw new ApiError((d && d.error) || `Ошибка сервера ${r.status}`, r.status, d);
  return d;
}

export function newOpId() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const pad = (n) => String(n).padStart(2, '0');
export const fmt = (n) => (n == null || n === '' || Number.isNaN(Number(n)) ? (n ?? '') : Number(n).toLocaleString('ru-RU'));
export function today(off = 0) { const d = new Date(); d.setDate(d.getDate() + off); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export function fmtTs(ts) {
  if (!ts) return '—';
  const t = today();
  return ts.slice(0, 10) === t ? ts.slice(11, 16) : `${ts.slice(8, 10)}.${ts.slice(5, 7)} ${ts.slice(11, 16)}`;
}
export function fmtDay(d) { return `${d.slice(8, 10)}.${d.slice(5, 7)}`; }
export function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

// ---------- значки (линейные, 24×24) ----------
const P = {
  dash: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  map: '<path d="M3 21V8l9-5 9 5v13"/><path d="M7 21v-8h10v8"/><path d="M7 17h10"/>',
  inbound: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/>',
  outbound: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M4 21h16"/>',
  box: '<path d="m3 7 9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
  check: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
  report: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><path d="M16 4a4 4 0 0 1 0 8"/><path d="M22 21c0-3-2-5-4-5.6"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z"/><path d="m9 12 2 2 4-4"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  log: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  left: '<path d="m15 18-6-6 6-6"/>', right: '<path d="m9 18 6-6-6-6"/>',
  wider: '<path d="M4 12h16"/><path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/>',
  narrower: '<path d="M4 12h6M14 12h6"/><path d="m7 9 3 3-3 3"/><path d="m17 9-3 3 3 3"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  upload: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  barcode: '<path d="M4 5v14M7 5v14M10 5v14M14 5v14M16 5v14M20 5v14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  store: '<path d="M3 9.5 4.6 4h14.8L21 9.5"/><path d="M4 9.5V20h16V9.5"/><path d="M3 9.5h18"/><path d="M9.5 20v-5.5h5V20"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
};
export const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;

// ---------- уведомления ----------
let toastWrap;
export function toast(msg, bad) {
  if (!toastWrap) { toastWrap = h('<div class="toast-wrap" role="status" aria-live="polite"></div>'); document.body.appendChild(toastWrap); }
  const t = h(`<div class="toast${bad ? ' bad' : ''}"></div>`);
  t.textContent = msg;
  toastWrap.appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3500);
}
export const fail = (e) => toast(e && e.message ? e.message : String(e), true);

// ---------- модальные окна ----------
export function modal({ title, sub = '', body = '', wide = false, actions = [], onClose }) {
  const back = h(`<div class="modal-back"><div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header><div><h2>${esc(title)}</h2>${sub ? `<p>${sub}</p>` : ''}</div><button class="x" type="button" aria-label="Закрыть">×</button></header>
    <div class="mb"></div><footer></footer></div></div>`);
  const mb = back.querySelector('.mb'), foot = back.querySelector('footer');
  if (typeof body === 'string') mb.innerHTML = body; else mb.appendChild(body);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); if (onClose) onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.querySelector('.x').onclick = close;
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  for (const a of actions) {
    const b = h(`<button type="button" class="btn ${a.kind || ''}${a.left ? ' left' : ''}">${esc(a.label)}</button>`);
    b.onclick = async () => {
      if (!a.onClick) return close();
      b.disabled = true;
      try { const keep = await a.onClick({ close, el: mb, btn: b }); if (keep !== true) close(); } catch (e) { fail(e); } finally { b.disabled = false; }
    };
    foot.appendChild(b);
  }
  if (!actions.length) foot.remove();
  document.body.appendChild(back);
  const first = mb.querySelector('input,select,textarea');
  if (first) setTimeout(() => first.focus(), 30);
  return { el: mb, close, root: back };
}

export function confirmBox(text, okLabel = 'Подтвердить', danger = false, sub = '') {
  return new Promise((resolve) => {
    let done = false;
    modal({
      title: text, sub,
      actions: [
        { label: 'Отмена', onClick: () => { done = true; resolve(false); } },
        { label: okLabel, kind: danger ? 'danger' : 'pri', onClick: () => { done = true; resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

export function showSecret(title, secret, note) {
  modal({
    title, sub: note,
    body: `<div class="secret">${esc(secret)}</div><button class="btn sm" type="button" id="cp">${icon('copy')}Скопировать</button>`,
    actions: [{ label: 'Готово', kind: 'pri' }],
  }).el.querySelector('#cp').onclick = async (e) => {
    try { await navigator.clipboard.writeText(secret); toast('Скопировано'); } catch (x) { e.target.previousElementSibling.focus(); }
  };
}

// ---------- таблица с сортировкой ----------
export function table(el, { columns, rows, totals, empty = 'Нет данных', onRow, rowClass, sort = null, render = {} }) {
  let st = sort ? { ...sort } : null;
  const cell = (c, r) => {
    if (render[c.key]) return render[c.key](r[c.key], r);
    const v = r[c.key];
    if (c.type === 'status') return statusPill(v);
    if (c.type === 'level') return `<span style="white-space:nowrap"><span class="lvl ${esc(v)}"></span>${esc(v)}</span>`;
    if (c.type === 'progress') { const [a, b] = v || [0, 0]; return progress(a, b); }
    if (c.type === 'diff') return `<span class="${v > 0 ? 'diff-pos' : v < 0 ? 'diff-neg' : ''}">${v > 0 ? '+' : ''}${fmt(v)}</span>`;
    if (c.align === 'r' && typeof v === 'number') return fmt(v);
    return esc(v);
  };
  function draw() {
    let list = rows;
    if (st) {
      const k = st.key, dir = st.dir;
      list = [...rows].sort((a, b) => {
        const x = a[k], y = b[k];
        const nx = typeof x === 'number' || (x !== '' && !Number.isNaN(Number(x)) && x != null);
        const r = nx && (typeof y === 'number' || !Number.isNaN(Number(y))) ? Number(x) - Number(y) : String(x ?? '').localeCompare(String(y ?? ''), 'ru');
        return dir * r;
      });
    }
    el.innerHTML = `<table class="t"><thead><tr>${columns.map((c) => `<th class="${c.align === 'r' ? 'r ' : ''}sortable" data-k="${c.key}">${esc(c.label)}${st && st.key === c.key ? `<span class="dir">${st.dir > 0 ? '↑' : '↓'}</span>` : ''}</th>`).join('')}</tr></thead>
      <tbody>${list.length ? list.map((r, i) => `<tr data-i="${rows.indexOf(r)}" class="${onRow ? 'clickable ' : ''}${rowClass ? rowClass(r) : ''}">${columns.map((c) => `<td class="${c.align === 'r' ? 'r' : ''}${c.mono ? ' mono' : ''}">${cell(c, r)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${columns.length}" class="empty">${esc(empty)}</td></tr>`}</tbody>
      ${totals && Object.keys(totals).length && list.length ? `<tfoot><tr>${columns.map((c, i) => `<td class="${c.align === 'r' ? 'r' : ''}">${i === 0 ? 'Итого' : totals[c.key] != null ? fmt(totals[c.key]) : ''}</td>`).join('')}</tr></tfoot>` : ''}</table>`;
    el.querySelectorAll('th.sortable').forEach((th) => th.onclick = () => {
      const k = th.dataset.k;
      st = st && st.key === k ? { key: k, dir: -st.dir } : { key: k, dir: 1 };
      draw();
    });
    if (onRow) el.querySelectorAll('tbody tr[data-i]').forEach((tr) => tr.onclick = (e) => { if (!e.target.closest('button,a,input')) onRow(rows[+tr.dataset.i]); });
  }
  draw();
}

const STATUS = {
  'в норме': 'ok', 'размещено': 'ok', 'собран': 'ok', 'применено': 'ok', 'закрыто': 'ok', 'активен': 'ok',
  'ожидает': 'wait', 'частично': 'wait', 'собирается': 'wait', 'в работе': 'wait', 'ниже минимума': 'wait',
  'нет на складе': 'bad', 'с недостачей': 'bad', 'закрыта': 'mute', 'отменено': 'mute', 'отключён': 'mute',
  A: 'ok', B: 'info', C: 'mute', 'совпадает': 'ok', 'не размещено': 'wait', 'в приёмке': 'info', 'излишек в ячейках': 'bad',
};
export const statusPill = (v) => (v ? `<span class="pill ${STATUS[v] || 'mute'}">${esc(v)}</span>` : '');
export function progress(a, b) {
  const p = b ? Math.min(100, Math.round((a / b) * 100)) : 0;
  return `<div class="progress"><div class="bar${p >= 100 ? ' ok' : ''}"><i style="width:${p}%"></i></div><span class="mono note">${fmt(a)}/${fmt(b)}</span></div>`;
}

// ---------- CSV из Excel ----------
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const d = first.includes('\t') ? '\t' : (first.split(';').length >= first.split(',').length ? ';' : ',');
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === d) { row.push(cur.trim()); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur.trim()); cur = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur.trim());
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}
export function pickFile(accept = '.csv,.txt') {
  return new Promise((resolve) => {
    const inp = h(`<input type="file" accept="${accept}" hidden>`);
    inp.onchange = () => {
      const f = inp.files[0];
      inp.remove();
      if (!f) return resolve(null);
      const rd = new FileReader();
      rd.onload = () => resolve({ name: f.name, text: String(rd.result) });
      rd.onerror = () => resolve(null);
      rd.readAsText(f, 'utf-8');
    };
    document.body.appendChild(inp);
    inp.click();
  });
}

// заголовок страницы
export function pageHead(title, sub, actionsHtml = '') {
  return `<div class="page-h"><div><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="actions">${actionsHtml}</div></div>`;
}

// события изменения данных на складе (опрос сервера в app.js)
export const bus = new EventTarget();
