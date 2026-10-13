// Оболочка WarehouseOS: меню по правам, маршруты, опрос сервера, профиль,
// быстрый поиск (Ctrl K / ⌘K) и нижняя панель вкладок на телефоне.
import { S, can, api, esc, icon, h, toast, fail, modal, bus } from './core.js';

const V = '?v=6';
const ROUTES = [
  { grp: 'Обзор' },
  { path: 'dashboard', title: 'Дашборды', short: 'Обзор', icon: 'dash', perm: ['dashboard.view'], mod: './views/dashboard.js' },
  { grp: 'Склад' },
  { path: 'map', title: 'Карта склада', short: 'Карта', icon: 'map', perm: ['stock.view'], mod: './views/map.js' },
  { path: 'receipts', title: 'Поставки', short: 'Поставки', icon: 'inbound', perm: ['stock.view'], mod: './views/receipts.js', badge: 'receipts' },
  { path: 'orders', title: 'Заказы дилеров', short: 'Заказы', icon: 'outbound', perm: ['stock.view'], mod: './views/orders.js', badge: 'orders' },
  { path: 'catalog', title: 'Каталог', short: 'Каталог', icon: 'box', perm: ['stock.view'], mod: './views/catalog.js' },
  { grp: 'Контроль' },
  { path: 'inventory', title: 'Инвентаризация', short: 'Пересчёт', icon: 'check', perm: ['stock.view', 'inventory.count'], mod: './views/inventory.js', badge: 'inventory' },
  { path: 'reports', title: 'Отчёты', short: 'Отчёты', icon: 'report', perm: ['reports.view'], mod: './views/reports.js' },
  { grp: 'Администрирование' },
  { path: 'admin/users', title: 'Пользователи', icon: 'users', perm: ['admin.users'], mod: './views/admin-users.js' },
  { path: 'admin/roles', title: 'Роли и права', icon: 'shield', perm: ['admin.roles'], mod: './views/admin-roles.js' },
  { path: 'admin/layout', title: 'Топология', icon: 'grid', perm: ['admin.layout'], mod: './views/admin-layout.js' },
  { path: 'admin/settings', title: 'Настройки', icon: 'gear', perm: ['admin.settings'], mod: './views/admin-settings.js' },
  { path: 'admin/carsale', title: 'Интеграция Carsale', icon: 'link', perm: ['admin.settings', 'catalog.manage'], mod: './views/admin-carsale.js' },
  { path: 'admin/audit', title: 'Журнал аудита', icon: 'log', perm: ['admin.audit'], mod: './views/admin-audit.js' },
];
// разделы для нижней панели на телефоне, по важности; показываем первые четыре доступных
const TAB_ORDER = ['dashboard', 'map', 'orders', 'receipts', 'catalog', 'inventory', 'reports'];
const allowed = (r) => r.path && r.perm.some(can);
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

let cleanup = null, current = null, last = { rev: null, layoutRev: null }, badges = {};

function buildMenu() {
  const items = [];
  let pendingGrp = null;
  for (const r of ROUTES) {
    if (r.grp) { pendingGrp = r.grp; continue; }
    if (!allowed(r)) continue;
    if (pendingGrp) { items.push(`<div class="grp">${esc(pendingGrp)}</div>`); pendingGrp = null; }
    items.push(`<a href="#/${r.path}" data-path="${r.path}">${icon(r.icon)}<span>${esc(r.title)}</span>${r.badge ? `<span class="badge" data-badge="${r.badge}" hidden></span>` : ''}</a>`);
  }
  document.getElementById('menu').innerHTML = items.join('');
  const u = S.me;
  document.getElementById('me').innerHTML = `<b>${esc(u.fullName || u.username)}</b><span class="role">${esc(u.roleName)} · ${esc(u.username)}</span>
    <div class="conn" id="conn"><i></i><span>На связи</span></div>
    <div class="links"><button type="button" id="pw">Сменить пароль</button><button type="button" id="logout">Выйти</button></div>`;
  document.getElementById('logout').onclick = logout;
  document.getElementById('pw').onclick = changePassword;
}

function buildTabbar() {
  const bar = document.getElementById('tabbar');
  const tabs = TAB_ORDER.map((p) => ROUTES.find((r) => r.path === p)).filter((r) => r && allowed(r)).slice(0, 4);
  bar.innerHTML = tabs.map((r) => `<a href="#/${r.path}" data-tab="${r.path}">${icon(r.icon)}<span>${esc(r.short || r.title)}</span>${r.badge ? `<i class="tb-badge" data-badge="${r.badge}" hidden></i>` : ''}</a>`).join('')
    + `<button type="button" id="tabMore" aria-label="Все разделы">${icon('more')}<span>Ещё</span></button>`;
  bar.querySelector('#tabMore').onclick = openSide;
}

function openSide() {
  const shell = document.getElementById('shell');
  if (shell.classList.contains('open')) return closeSide();
  shell.classList.add('open');
  const s = h('<div class="scrim"></div>');
  s.onclick = closeSide;
  document.body.appendChild(s);
}
function closeSide() {
  document.getElementById('shell').classList.remove('open');
  document.querySelector('.scrim')?.remove();
}

async function logout() {
  try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* всё равно на вход */ }
  location.href = '/login';
}

// фото здания — фон страниц; в меню только знак JAC (или загруженный в настройках логотип)
let EMBLEM = null;
export function applyBrand(b) {
  S.settings = { ...S.settings, ...b };
  document.documentElement.style.setProperty('--photo', `url("/brand/photo?v=${encodeURIComponent(b.v)}")`);
  const em = document.getElementById('emblem');
  if (!em) return;
  if (EMBLEM === null) EMBLEM = em.innerHTML;
  em.innerHTML = b.hasLogo ? `<img src="/brand/logo?v=${encodeURIComponent(b.v)}" alt="Логотип">` : EMBLEM;
  em.classList.toggle('custom', !!b.hasLogo);
}

function paintBadges() {
  document.querySelectorAll('[data-badge]').forEach((b) => {
    const n = badges[b.dataset.badge] || 0;
    b.hidden = !n;
    b.textContent = n > 99 ? '99+' : n;
  });
}

function changePassword() {
  modal({
    title: 'Смена пароля',
    body: `<label class="field"><span>Текущий пароль</span><input class="in" id="p0" type="password" autocomplete="current-password"></label>
      <label class="field"><span>Новый пароль</span><input class="in" id="p1" type="password" autocomplete="new-password"><span class="hint">Не короче 6 символов</span></label>
      <label class="field"><span>Ещё раз</span><input class="in" id="p2" type="password" autocomplete="new-password"></label>`,
    actions: [{ label: 'Отмена' }, {
      label: 'Сменить', kind: 'pri', onClick: async ({ el }) => {
        const p1 = el.querySelector('#p1').value;
        if (p1 !== el.querySelector('#p2').value) { toast('Новые пароли не совпадают', true); return true; }
        await api('/api/me/password', { method: 'POST', body: { current: el.querySelector('#p0').value, password: p1 } });
        toast('Пароль изменён');
      },
    }],
  });
}

// ---------- быстрый поиск: разделы, артикулы, адреса, заказы, поставки ----------
const PAL = { data: null, at: 0, loading: null };

function palData() {
  if (PAL.data && Date.now() - PAL.at < 30000) return Promise.resolve(PAL.data);
  if (PAL.loading) return PAL.loading;
  const stock = can('stock.view');
  PAL.loading = Promise.allSettled([
    stock ? api('/api/catalog') : null, stock ? api('/api/orders') : null, stock ? api('/api/receipts') : null, stock ? api('/api/layout') : null,
  ]).then(([cat, ord, rec, lay]) => {
    PAL.data = { skus: cat.value?.items || [], orders: ord.value?.orders || [], receipts: rec.value?.docs || [], zones: lay.value?.zones || [] };
    PAL.at = Date.now(); PAL.loading = null;
    return PAL.data;
  });
  return PAL.loading;
}
bus.addEventListener('changed', () => { PAL.at = 0; });

const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_.]/g, '');
function mark(text, q) {
  const t = String(text ?? ''), i = q ? t.toLowerCase().indexOf(q) : -1;
  return i < 0 ? esc(t) : `${esc(t.slice(0, i))}<mark>${esc(t.slice(i, i + q.length))}</mark>${esc(t.slice(i + q.length))}`;
}
const pad2 = (n) => String(n).padStart(2, '0');

// адрес вида A-01-02 (стеллаж) или A-01-02-3-4 (ячейка); разделители можно опускать пробелами/точками
function parseAddr(q, zones) {
  const p = q.toUpperCase().trim().split(/[-\s.]+/).filter(Boolean);
  if (p.length !== 3 && p.length !== 5) return null;
  const z = zones.find((x) => x.id === p[0]);
  if (!z || !p.slice(1).every((x) => /^\d{1,3}$/.test(x))) return null;
  const [r, k, t, c] = p.slice(1).map(Number);
  if (r < 1 || r > z.rows || k < 1 || k > z.racks) return null;
  const rack = `${z.id}-${pad2(r)}-${pad2(k)}`;
  if (p.length === 3) return { kind: 'rack', id: rack, z };
  if (t < 1 || t > z.tiers || c < 1 || c > z.cells) return null;
  return { kind: 'cell', id: `${rack}-${t}-${c}`, z };
}

function palSearch(raw, d) {
  const q = raw.trim().toLowerCase(), nq = norm(q), out = [];
  const routes = ROUTES.filter(allowed);
  if (!q) {
    out.push({ t: 'Разделы', items: routes.map((r) => ({ icon: r.icon, html: esc(r.title), href: `#/${r.path}` })) });
    out.push({ t: 'Действия', items: [{ icon: 'shield', html: 'Сменить пароль', run: changePassword }, { icon: 'left', html: 'Выйти', run: logout }] });
    return out;
  }
  if (d) {
    const a = parseAddr(raw, d.zones);
    if (a) out.push({ t: 'Адрес', items: [{ icon: 'pin', html: `${a.kind === 'cell' ? 'Ячейка' : 'Стеллаж'} <b class="mono">${a.id}</b>`, sub: esc(a.z.title), href: `#/map?${a.kind}=${encodeURIComponent(a.id)}` }] });
  }
  const rr = routes.filter((r) => r.title.toLowerCase().includes(q));
  if (rr.length) out.push({ t: 'Разделы', items: rr.map((r) => ({ icon: r.icon, html: mark(r.title, q), href: `#/${r.path}` })) });
  if (!d) { out.push({ t: 'Склад', items: [], loading: true }); return out; }

  const skus = d.skus.map((s) => {
    const art = norm(s.art), name = String(s.name || '').toLowerCase();
    const score = art === nq ? 0 : art.startsWith(nq) ? 1 : art.includes(nq) ? 2 : name.includes(q) ? 3 : -1;
    return { s, score };
  }).filter((x) => x.score >= 0).sort((a, b) => a.score - b.score || b.s.qty - a.s.qty).slice(0, 8);
  if (skus.length) {
    out.push({
      t: 'Артикулы', items: skus.map(({ s }) => ({
        icon: 'box', html: `${mark(s.name, q)} <span class="mono t3">${mark(s.art, q)}</span>`,
        sub: s.qty ? `${s.qty} шт · ${s.cells} яч.` : 'нет в ячейках',
        href: s.qty ? `#/map?sku=${encodeURIComponent(s.art)}` : `#/catalog?q=${encodeURIComponent(s.art)}`,
      })),
    });
  }
  const orders = d.orders.filter((o) => norm(o.number).includes(nq) || o.dealer.toLowerCase().includes(q)).slice(0, 5);
  if (orders.length) {
    out.push({
      t: 'Заказы дилеров', items: orders.map((o) => ({
        icon: 'outbound', html: `Заказ <b>${mark(o.number, q)}</b> · ${mark(o.dealer, q)}`, sub: `собрано ${o.picked || 0} из ${o.total || 0}${o.due ? ' · к ' + esc(o.due) : ''}`,
        href: `#/map?order=${o.id}`,
      })),
    });
  }
  const recs = d.receipts.filter((r) => norm(r.doc).includes(nq) || r.lines.some((l) => norm(l.art) === nq)).slice(0, 5);
  if (recs.length) {
    out.push({
      t: 'Поставки', items: recs.map((r) => {
        const open = r.lines.find((l) => !l.done);
        return { icon: 'inbound', html: `Поставка <b>${mark(r.doc, q)}</b>`, sub: `размещено ${r.placed} из ${r.qty}`, href: open ? `#/map?receipt=${open.id}` : '#/receipts' };
      }),
    });
  }
  return out;
}

function openPalette() {
  if (document.querySelector('.palette-back')) { document.querySelector('.palette input').focus(); return; }
  closeSide();
  const prevFocus = document.activeElement;
  const back = h(`<div class="palette-back" role="presentation"><div class="palette" role="dialog" aria-modal="true" aria-label="Поиск">
      <div class="pin">${icon('search')}<input type="text" placeholder="Артикул, адрес, заказ или раздел" aria-label="Что найти" autocomplete="off" spellcheck="false"
        role="combobox" aria-expanded="true" aria-controls="palRes" aria-autocomplete="list"><kbd>Esc</kbd><button type="button" class="pcancel">Отмена</button></div>
      <div class="res" id="palRes" role="listbox"></div>
      <div class="foot"><span><kbd>↑</kbd> <kbd>↓</kbd> выбрать</span><span><kbd>Enter</kbd> открыть</span><span>адрес: <span class="mono">A-01-02-3-1</span></span></div>
    </div></div>`);
  const inp = back.querySelector('input'), res = back.querySelector('.res');
  let flat = [], sel = 0, data = PAL.data && Date.now() - PAL.at < 30000 ? PAL.data : null;

  const draw = () => {
    const groups = palSearch(inp.value, data);
    flat = [];
    let html = '';
    for (const g of groups) {
      html += `<div class="grp">${esc(g.t)}</div>`;
      if (g.loading) html += '<div class="sk" style="height:34px;margin:2px 6px 6px"></div>';
      for (const it of g.items) {
        const i = flat.push(it) - 1;
        html += `<button type="button" class="it" role="option" id="pal${i}" data-i="${i}" aria-selected="false">${icon(it.icon)}<span class="t1">${it.html}</span>${it.sub ? `<span class="t2">${it.sub}</span>` : ''}</button>`;
      }
    }
    if (!flat.length && !groups.some((g) => g.loading)) html = `<div class="none">Ничего не найдено по запросу «${esc(inp.value.trim())}»</div>`;
    res.innerHTML = html;
    sel = 0;
    paintSel();
  };
  const paintSel = () => {
    res.querySelectorAll('.it').forEach((b) => b.setAttribute('aria-selected', String(+b.dataset.i === sel)));
    const b = res.querySelector(`[data-i="${sel}"]`);
    if (b) { b.scrollIntoView({ block: 'nearest' }); inp.setAttribute('aria-activedescendant', b.id); } else inp.removeAttribute('aria-activedescendant');
  };
  const close = (restore = true) => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    if (restore && prevFocus && prevFocus.focus) prevFocus.focus();
  };
  const go = (it) => {
    if (!it) return;
    close(false);
    if (it.run) it.run();
    else if (location.hash === it.href) { current = null; route(); }
    else location.hash = it.href;
    if (!it.run) document.getElementById('view').focus({ preventScroll: true });
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length) { sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length; paintSel(); }
    } else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); go(flat[sel]); }
    else if (e.key === 'Tab') { e.preventDefault(); inp.focus(); }
  };

  inp.addEventListener('input', draw);
  res.addEventListener('mousemove', (e) => { const b = e.target.closest('.it'); if (b && +b.dataset.i !== sel) { sel = +b.dataset.i; paintSel(); } });
  res.addEventListener('click', (e) => { const b = e.target.closest('.it'); if (b) go(flat[+b.dataset.i]); });
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.querySelector('.pcancel').onclick = () => close();
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(back);
  draw();
  inp.focus();
  if (!data) palData().then((d) => { data = d; if (back.isConnected) draw(); }).catch(() => {});
}

function bindShortcuts() {
  document.querySelectorAll('[data-search]').forEach((b) => { b.onclick = openPalette; });
  document.querySelectorAll('.kbd-k').forEach((k) => { k.textContent = IS_MAC ? '⌘K' : 'Ctrl K'; });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K' || e.code === 'KeyK')) { e.preventDefault(); openPalette(); return; }
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (!typing && !document.querySelector('.modal-back')) { e.preventDefault(); openPalette(); }
    }
  });
}

async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = hash.split('?');
  let r = ROUTES.filter(allowed).find((x) => pathPart === x.path || pathPart.startsWith(x.path + '/'));
  if (!r) {
    r = ROUTES.find(allowed);
    if (!r) { document.getElementById('view').innerHTML = '<div class="empty"><b>Нет доступных разделов</b>Обратитесь к администратору, чтобы вам назначили роль.</div>'; return; }
    location.replace('#/' + r.path);
    return;
  }
  const rest = pathPart.slice(r.path.length).split('/').filter(Boolean).map(decodeURIComponent);
  const params = Object.fromEntries(new URLSearchParams(query));
  document.querySelectorAll('#menu a').forEach((a) => a.classList.toggle('on', a.dataset.path === r.path));
  const tabs = document.querySelectorAll('#tabbar [data-tab]');
  let inTabs = false;
  tabs.forEach((a) => { const on = a.dataset.tab === r.path; a.classList.toggle('on', on); if (on) { a.setAttribute('aria-current', 'page'); inTabs = true; } else a.removeAttribute('aria-current'); });
  document.getElementById('tabMore')?.classList.toggle('on', !inTabs);
  document.getElementById('topTitle').textContent = r.title;
  document.title = `${r.title} · ${S.settings.name || 'WarehouseOS'}`;
  closeSide();
  const key = r.path + '|' + rest.join('/') + '|' + query;
  if (current && current.key === key) return;
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  const view = document.getElementById('view');
  const host = h('<div style="display:contents"></div>');
  view.replaceChildren(host);
  if (!current || current.path !== r.path) window.scrollTo(0, 0);
  current = { key, path: r.path };
  try {
    const mod = await import(r.mod + V);
    if (current.key !== key) return;
    cleanup = (await mod.mount(host, { rest, params, route: r })) || null;
  } catch (e) {
    console.error(e);
    host.innerHTML = `<div class="empty"><b>Не удалось открыть раздел</b>${esc(e.message || e)}</div>`;
  }
}

async function poll() {
  const conn = document.getElementById('conn');
  try {
    const r = await api('/api/rev');
    conn?.classList.remove('off');
    if (conn) conn.lastChild.textContent = 'На связи';
    badges = r.badges || {};
    paintBadges();
    if (last.rev !== null && r.rev !== last.rev) { PAL.at = 0; bus.dispatchEvent(new Event('rev')); }
    if (last.layoutRev !== null && r.layoutRev !== last.layoutRev) bus.dispatchEvent(new Event('layout'));
    last = { rev: r.rev, layoutRev: r.layoutRev };
  } catch (e) {
    conn?.classList.add('off');
    if (conn) conn.lastChild.textContent = 'Нет связи с сервером';
  }
}
// после своих изменений — проверить сразу, не дожидаясь таймера
bus.addEventListener('changed', () => setTimeout(poll, 50));
bus.addEventListener('brand', async () => { try { applyBrand(await api('/api/public')); } catch (e) { /* не страшно */ } });

(async function boot() {
  try {
    const me = await api('/api/me');
    S.me = me.user; S.perms = new Set(me.perms); S.settings = me.settings; S.demo = me.demo; S.permCatalog = me.permCatalog;
    applyBrand(me.settings);
    buildMenu();
    buildTabbar();
    bindShortcuts();
    document.getElementById('burger').onclick = openSide;
    window.addEventListener('hashchange', route);
    // как в iOS: заголовок в верхней панели появляется, когда крупный заголовок страницы ушёл под неё
    const onScroll = () => document.body.classList.toggle('scrolled', window.scrollY > 56);
    window.addEventListener('scroll', onScroll, { passive: true });
    await poll();
    route();
    setInterval(poll, (me.settings.pollSeconds || 8) * 1000);
  } catch (e) {
    if (e.status !== 401) { document.getElementById('view').innerHTML = `<div class="empty"><b>Сервер недоступен</b>${esc(e.message)}</div>`; fail(e); }
  }
})();
