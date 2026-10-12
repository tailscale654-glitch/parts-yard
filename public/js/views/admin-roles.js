// Роли и права: встроенные и свои роли, матрица прав.
import { api, esc, icon, toast, fail, modal, confirmBox, pageHead, h, can } from '../core.js';

export async function mount(root) {
  let roles = [], perms = [];
  root.innerHTML = `${pageHead('Роли и права', 'Роль — набор прав. Назначьте роль пользователю, и он увидит только нужные разделы и кнопки.',
    `<button class="btn pri" id="add">${icon('plus')}Своя роль</button>`)}
    <div class="role-cards" id="cards"></div>`;
  const label = (k) => (perms.find((p) => p.key === k) || { label: k }).label;

  function draw() {
    root.querySelector('#cards').innerHTML = roles.map((r) => {
      const all = r.perms.includes('*');
      return `<div class="card role-card"><div class="meta"><h3>${esc(r.name)}</h3><span class="pill ${r.builtin ? 'mute' : 'info'}">${r.builtin ? 'встроенная' : 'своя'}</span><span class="note mono">${esc(r.key)}</span></div>
        <p class="note" style="margin:0">${esc(r.description || '')}</p>
        <div class="note">Пользователей: <b>${r.users}</b> · прав: <b>${all ? 'все' : r.perms.length}</b></div>
        <div class="perm-tags">${all ? '<span>Полный доступ</span>' : r.perms.slice(0, 8).map((p) => `<span>${esc(label(p))}</span>`).join('') + (r.perms.length > 8 ? `<span>ещё ${r.perms.length - 8}</span>` : '')}</div>
        <div class="row" style="margin-top:auto">${all ? '<span class="note">Права администратора не меняются</span>' : `<button class="btn sm" data-edit="${r.key}">${icon('edit')}Настроить</button>`}
          ${!r.builtin ? `<button class="btn sm ghost danger" data-del="${r.key}">${icon('trash')}Удалить</button>` : ''}</div></div>`;
    }).join('');
    root.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => edit(roles.find((r) => r.key === b.dataset.edit)));
    root.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      const r = roles.find((x) => x.key === b.dataset.del);
      if (!(await confirmBox(`Удалить роль «${r.name}»?`, 'Удалить', true))) return;
      try { await api(`/api/admin/roles/${r.key}`, { method: 'DELETE' }); toast('Роль удалена'); load(); } catch (e) { fail(e); }
    });
  }
  function edit(r) {
    const isNew = !r;
    const groups = [...new Set(perms.map((p) => p.group))];
    const has = new Set(r ? r.perms : ['dashboard.view', 'stock.view']);
    const body = h(`<div style="display:flex;flex-direction:column;gap:12px">
      <div class="grid2"><label class="field"><span>Название</span><input class="in" id="rname" maxlength="40" value="${esc(r ? r.name : '')}" placeholder="Например, Приёмщик"></label>
      <label class="field"><span>Код</span><input class="in mono" id="rkey" maxlength="31" value="${esc(r ? r.key : '')}" ${isNew ? '' : 'readonly'} placeholder="receiver"><span class="hint">Латиница, используется в командной строке</span></label></div>
      <label class="field"><span>Описание</span><input class="in" id="rdesc" maxlength="160" value="${esc(r ? r.description || '' : '')}"></label>
      <div class="perm-grid">${groups.map((g) => `<fieldset><legend>${esc(g)}</legend>${perms.filter((p) => p.group === g).map((p) =>
        `<label class="check"><input type="checkbox" value="${p.key}" ${has.has(p.key) ? 'checked' : ''} ${can(p.key) ? '' : 'disabled title="У вас самих нет этого права"'}>${esc(p.label)}</label>`).join('')}</fieldset>`).join('')}</div></div>`);
    modal({
      title: isNew ? 'Новая роль' : `Роль «${r.name}»`, sub: isNew ? '' : `Изменения применятся у ${r.users} пользователей сразу.`, wide: true, body,
      actions: [{ label: 'Отмена' }, { label: 'Сохранить', kind: 'pri', onClick: async ({ el }) => {
        const payload = { name: el.querySelector('#rname').value, description: el.querySelector('#rdesc').value, perms: [...el.querySelectorAll('.perm-grid input:checked')].map((x) => x.value) };
        if (isNew) await api('/api/admin/roles', { method: 'POST', body: { ...payload, key: el.querySelector('#rkey').value.trim() } });
        else await api(`/api/admin/roles/${r.key}`, { method: 'PUT', body: payload });
        toast('Роль сохранена'); load();
      } }],
    });
  }
  async function load() {
    try { const r = await api('/api/admin/roles'); roles = r.roles; perms = r.perms; draw(); } catch (e) { fail(e); }
  }
  root.querySelector('#add').onclick = () => edit(null);
  await load();
}
