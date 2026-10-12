// Пользователи: создание, роли, отключение, сброс пароля, завершение сеансов.
import { api, esc, icon, toast, fail, modal, confirmBox, table, pageHead, fmtTs, statusPill, showSecret, h, S } from '../core.js';

export async function mount(root) {
  let users = [], roles = [];
  root.innerHTML = `${pageHead('Пользователи', 'Учётные записи сотрудников склада. Права определяются ролью — настраиваются в разделе «Роли и права».',
    `<button class="btn pri" id="add">${icon('plus')}Пользователь</button>`)}
    <div class="card"><div class="tw" id="tbl"></div></div>`;

  function draw() {
    table(root.querySelector('#tbl'), {
      columns: [{ key: 'username', label: 'Логин', mono: true }, { key: 'full_name', label: 'Сотрудник' }, { key: 'role_name', label: 'Роль' },
        { key: 'status', label: 'Статус' }, { key: 'last_login', label: 'Последний вход' }, { key: 'last_op', label: 'Последняя операция' }, { key: 'sessions', label: 'Сеансы', align: 'r' }],
      rows: users.map((u) => ({ ...u, full_name: u.full_name || '', status: u.active ? 'активен' : 'отключён' })),
      rowClass: (u) => (u.active ? '' : 'off'),
      render: { status: (v) => statusPill(v), last_login: (v) => `<span class="mono">${fmtTs(v)}</span>`, last_op: (v) => `<span class="mono">${fmtTs(v)}</span>` },
      onRow: (u) => edit(u),
    });
  }
  const roleOptions = (sel) => roles.map((r) => `<option value="${r.key}" ${sel === r.key ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  const roleHint = (key) => { const r = roles.find((x) => x.key === key); return r ? esc(r.description || '') : ''; };

  function edit(u) {
    const isNew = !u;
    const body = h(`<div style="display:flex;flex-direction:column;gap:12px">
      <div class="grid2"><label class="field"><span>Логин</span><input class="in mono" id="ulogin" maxlength="40" value="${esc(u ? u.username : '')}" ${isNew ? '' : 'readonly'} autocomplete="off"></label>
      <label class="field"><span>Фамилия и имя</span><input class="in" id="uname" maxlength="80" value="${esc(u ? u.full_name || '' : '')}"></label></div>
      <label class="field"><span>Роль</span><select class="in" id="urole">${roleOptions(u ? u.role : 'storekeeper')}</select><span class="hint" id="uhint"></span></label>
      ${isNew ? '<label class="field"><span>Пароль</span><input class="in" id="upass" type="text" autocomplete="off" placeholder="Оставьте пустым — придумаем надёжный"><span class="hint">Не короче 6 символов</span></label>'
    : `<label class="check"><input type="checkbox" id="uactive" ${u.active ? 'checked' : ''} ${u.username === S.me.username ? 'disabled' : ''}>Активен — может входить в систему</label>
       <div class="row"><button type="button" class="btn sm" id="ureset">Сбросить пароль</button>${u.sessions ? `<button type="button" class="btn sm" id="ukick">Завершить сеансы (${u.sessions})</button>` : ''}</div>`}</div>`);
    const hint = () => { body.querySelector('#uhint').innerHTML = roleHint(body.querySelector('#urole').value); };
    body.querySelector('#urole').onchange = hint; hint();
    const md = modal({
      title: isNew ? 'Новый пользователь' : u.username, sub: isNew ? '' : `Создан ${fmtTs(u.created)}`, body,
      actions: [{ label: 'Отмена' }, { label: 'Сохранить', kind: 'pri', onClick: async ({ el }) => {
        if (isNew) {
          const r = await api('/api/admin/users', { method: 'POST', body: { username: el.querySelector('#ulogin').value.trim(), full_name: el.querySelector('#uname').value, role: el.querySelector('#urole').value, password: el.querySelector('#upass').value || undefined } });
          if (r.password) showSecret('Пароль нового пользователя', r.password, 'Передайте сотруднику. Больше этот пароль не покажется — он сможет сменить его сам.');
          else toast('Пользователь создан');
        } else {
          await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { full_name: el.querySelector('#uname').value, role: el.querySelector('#urole').value, active: el.querySelector('#uactive').checked } });
          toast('Сохранено');
        }
        load();
      } }],
    });
    body.querySelector('#ureset')?.addEventListener('click', async () => {
      if (!(await confirmBox(`Сбросить пароль ${u.username}?`, 'Сбросить', true, 'Будет создан новый пароль, все сеансы сотрудника завершатся.'))) return;
      try { const r = await api(`/api/admin/users/${u.id}/password`, { method: 'POST', body: {} }); md.close(); showSecret(`Новый пароль ${u.username}`, r.password, 'Передайте сотруднику. Больше этот пароль не покажется.'); load(); } catch (e) { fail(e); }
    });
    body.querySelector('#ukick')?.addEventListener('click', async () => {
      try { const r = await api(`/api/admin/users/${u.id}/logout`, { method: 'POST' }); toast(`Завершено сеансов: ${r.sessions}`); md.close(); load(); } catch (e) { fail(e); }
    });
  }
  async function load() {
    try {
      const [u, r] = await Promise.all([api('/api/admin/users'), api('/api/admin/roles')]);
      users = u.users; roles = r.roles; draw();
    } catch (e) { fail(e); }
  }
  root.querySelector('#add').onclick = () => edit(null);
  await load();
}
