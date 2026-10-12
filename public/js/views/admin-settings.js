// Настройки системы, сведения о сервере, резервная копия, демо-данные.
import { api, esc, toast, fail, confirmBox, pageHead, fmt, S, icon, bus } from '../core.js';

export async function mount(root) {
  const r = await api('/api/admin/settings');
  const v = r.values, s = r.system;
  root.innerHTML = `${pageHead('Настройки', 'Название склада, частота обновления экранов, резервная копия базы.')}
    <div class="grid2" style="align-items:start">
      <div class="card"><div class="ch"><h2>Основное</h2></div><div class="cb" style="display:flex;flex-direction:column;gap:12px">
        <label class="field"><span>Название склада</span><input class="in" id="sname" maxlength="60" value="${esc(v.warehouse_name)}"><span class="hint">Показывается в меню и на странице входа</span></label>
        <label class="field"><span>Подпись</span><input class="in" id="ssub" maxlength="80" value="${esc(v.warehouse_subtitle)}"></label>
        <label class="field"><span>Обновлять экраны каждые, сек</span><input class="in" id="spoll" type="number" min="3" max="120" value="${esc(v.poll_seconds)}" style="max-width:120px"><span class="hint">Как быстро сотрудники видят изменения коллег. По умолчанию 8</span></label>
        <div><button class="btn pri" id="save">Сохранить</button></div>
      </div></div>
      <div class="card"><div class="ch"><h2>Сервер</h2></div><div class="cb" style="display:flex;flex-direction:column;gap:12px">
        <dl class="kv"><dt>Версия</dt><dd class="mono">WarehouseOS ${esc(s.version)} · схема БД ${s.schema}</dd><dt>Node.js</dt><dd class="mono">${esc(s.node)}</dd>
          <dt>Сервер</dt><dd class="mono">${esc(s.host)} · работает ${fmt(s.uptimeMin)} мин</dd><dt>База</dt><dd class="mono" style="word-break:break-all">${esc(s.db)} · ${(s.dbSize / 1048576).toFixed(1)} МБ</dd>
          <dt>Склад</dt><dd>${s.zones} зон · ${fmt(s.cells)} ячеек · ${fmt(s.skus)} артикулов · ${s.users} пользователей</dd><dt>Режим</dt><dd>${s.demo ? '<span class="pill wait">демо</span>' : '<span class="pill ok">рабочий</span>'}</dd></dl>
        <div class="row"><a class="btn" href="/api/admin/backup">${icon('download')}Скачать резервную копию</a></div>
        <p class="note" style="margin:0">Копия делается на ходу, без остановки работы. Для восстановления остановите службу и замените файл базы.</p>
        ${S.demo ? '<div class="infobox">Демо-режим: можно вернуть демонстрационные данные. Для реальной работы поставьте <span class="mono">WMS_DEMO=0</span> в <span class="mono">/etc/default/parts-yard</span>.<div class="row" style="margin-top:8px"><button class="btn danger sm" id="demo">Сбросить демо-данные</button></div></div>' : ''}
      </div></div>
    </div>`;
  root.querySelector('#save').onclick = async () => {
    try {
      await api('/api/admin/settings', { method: 'PUT', body: { warehouse_name: root.querySelector('#sname').value, warehouse_subtitle: root.querySelector('#ssub').value, poll_seconds: root.querySelector('#spoll').value } });
      toast('Настройки сохранены');
      document.getElementById('whName').textContent = root.querySelector('#sname').value;
      document.getElementById('whSub').textContent = root.querySelector('#ssub').value;
    } catch (e) { fail(e); }
  };
  root.querySelector('#demo')?.addEventListener('click', async () => {
    if (!(await confirmBox('Заменить все данные склада демонстрационными?', 'Сбросить', true, 'Остатки, документы, история и инвентаризации будут заменены. Пользователи и роли сохранятся.'))) return;
    try { await api('/api/demo/reset', { method: 'POST' }); toast('Демо-данные восстановлены'); bus.dispatchEvent(new Event('changed')); } catch (e) { fail(e); }
  });
}
