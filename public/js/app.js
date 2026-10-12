// Оболочка WarehouseOS: меню по правам, маршруты, опрос сервера, профиль.
import { S, can, api, esc, icon, h, toast, fail, modal, bus } from './core.js';

const V = '?v=2';
const ROUTES = [
  { grp: 'Обзор' },
  { path: 'dashboard', title: 'Дашборды', icon: 'dash', perm: ['dashboard.view'], mod: './views/dashboard.js' },
  { grp: 'Склад' },
  { path: 'map', title: 'Карта склада', icon: 'map', perm: ['stock.view'], mod: './views/map.js' },
  { path: 'receipts', title: 'Поставки', icon: 'inbound', perm: ['stock.view'], mod: './views/receipts.js', badge: 'receipts' },
  { path: 'orders', title: 'Заказы дилеров', icon: 'outbound', perm: ['stock.view'], mod: './views/orders.js', badge: 'orders' },
  { path: 'catalog', title: 'Каталог', icon: 'box', perm: ['stock.view'], mod: './views/catalog.js' },
  { grp: 'Контроль' },
  { path: 'inventory', title: 'Инвентаризация', icon: 'check', perm: ['stock.view', 'inventory.count'], mod: './views/inventory.js', badge: 'inventory' },
  { path: 'reports', title: 'Отчёты', icon: 'report', perm: ['reports.view'], mod: './views/reports.js' },
  { grp: 'Администрирование' },
  { path: 'admin/users', title: 'Пользователи', icon: 'users', perm: ['admin.users'], mod: './views/admin-users.js' },
  { path: 'admin/roles', title: 'Роли и права', icon: 'shield', perm: ['admin.roles'], mod: './views/admin-roles.js' },
  { path: 'admin/layout', title: 'Топология', icon: 'grid', perm: ['admin.layout'], mod: './views/admin-layout.js' },
  { path: 'admin/settings', title: 'Настройки', icon: 'gear', perm: ['admin.settings'], mod: './views/admin-settings.js' },
  { path: 'admin/carsale', title: 'Интеграция Carsale', icon: 'link', perm: ['admin.settings', 'catalog.manage'], mod: './views/admin-carsale.js' },
  { path: 'admin/audit', title: 'Журнал аудита', icon: 'log', perm: ['admin.audit'], mod: './views/admin-audit.js' },
];
const allowed = (r) => r.path && r.perm.some(can);

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
  document.getElementById('logout').onclick = async () => { try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* всё равно на вход */ } location.href = '/login'; };
  document.getElementById('pw').onclick = changePassword;
}

function paintBadges() {
  document.querySelectorAll('[data-badge]').forEach((b) => {
    const n = badges[b.dataset.badge] || 0;
    b.hidden = !n;
    b.textContent = n;
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
  document.getElementById('topTitle').textContent = r.title;
  document.title = `${r.title} · ${S.settings.name || 'WarehouseOS'}`;
  document.getElementById('shell').classList.remove('open');
  document.querySelector('.scrim')?.remove();
  const key = r.path + '|' + rest.join('/') + '|' + query;
  if (current && current.key === key) return;
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  const view = document.getElementById('view');
  const host = h('<div style="display:contents"></div>');
  view.replaceChildren(host);
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
    if (last.rev !== null && r.rev !== last.rev) bus.dispatchEvent(new Event('rev'));
    if (last.layoutRev !== null && r.layoutRev !== last.layoutRev) bus.dispatchEvent(new Event('layout'));
    last = { rev: r.rev, layoutRev: r.layoutRev };
  } catch (e) {
    conn?.classList.add('off');
    if (conn) conn.lastChild.textContent = 'Нет связи с сервером';
  }
}
// после своих изменений — проверить сразу, не дожидаясь таймера
bus.addEventListener('changed', () => setTimeout(poll, 50));

(async function boot() {
  try {
    const me = await api('/api/me');
    S.me = me.user; S.perms = new Set(me.perms); S.settings = me.settings; S.demo = me.demo; S.permCatalog = me.permCatalog;
    document.getElementById('whName').textContent = me.settings.name;
    document.getElementById('whSub').textContent = me.settings.subtitle || '';
    buildMenu();
    document.getElementById('burger').onclick = () => {
      document.getElementById('shell').classList.add('open');
      const s = h('<div class="scrim"></div>');
      s.onclick = () => { document.getElementById('shell').classList.remove('open'); s.remove(); };
      document.body.appendChild(s);
    };
    window.addEventListener('hashchange', route);
    await poll();
    route();
    setInterval(poll, (me.settings.pollSeconds || 8) * 1000);
  } catch (e) {
    if (e.status !== 401) { document.getElementById('view').innerHTML = `<div class="empty"><b>Сервер недоступен</b>${esc(e.message)}</div>`; fail(e); }
  }
})();
