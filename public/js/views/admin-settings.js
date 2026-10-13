// Настройки системы, сведения о сервере, резервная копия, демо-данные.
import { api, esc, toast, fail, confirmBox, pageHead, fmt, S, icon, bus } from '../core.js';

// уменьшаем картинку в браузере, чтобы не гонять на сервер фото с телефона по 8 МБ
function shrink(file, maxW, type, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxW / img.naturalWidth);
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL(type, quality));
    };
    img.onerror = () => reject(new Error('Не удалось прочитать картинку'));
    img.src = URL.createObjectURL(file);
  });
}
function pickImage() {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp'; inp.hidden = true;
    inp.onchange = () => { const f = inp.files[0]; inp.remove(); resolve(f || null); };
    document.body.appendChild(inp); inp.click();
  });
}

export async function mount(root) {
  const r = await api('/api/admin/settings');
  const v = r.values, s = r.system;
  root.innerHTML = `${pageHead('Настройки', 'Название склада, частота обновления экранов, резервная копия базы.')}
    <div class="grid2" style="align-items:start">
      <div class="card"><div class="ch"><h2>Основное</h2></div><div class="cb" style="display:flex;flex-direction:column;gap:12px">
        <label class="field"><span>Название склада</span><input class="in" id="sname" maxlength="60" value="${esc(v.warehouse_name)}"><span class="hint">Показывается на странице входа и во вкладке браузера</span></label>
        <label class="field"><span>Подпись</span><input class="in" id="ssub" maxlength="80" value="${esc(v.warehouse_subtitle)}"></label>
        <label class="field"><span>Обновлять экраны каждые, сек</span><input class="in" id="spoll" type="number" min="3" max="120" value="${esc(v.poll_seconds)}" style="max-width:120px"><span class="hint">Как быстро сотрудники видят изменения коллег. По умолчанию 8</span></label>
        <div><button class="btn pri" id="save">Сохранить</button></div>
      </div></div>
      <div class="card"><div class="ch"><h2>Фирменный стиль</h2></div><div class="cb" style="display:flex;flex-direction:column;gap:12px">
        <div class="grid2"><label class="field"><span>Подпись бренда, строка 1</span><input class="in" id="bl1" maxlength="24" value="${esc(v.brand_line1)}"><span class="hint">Красная часть подписи на странице входа, например JAC MOTORS</span></label>
          <label class="field"><span>Строка 2</span><input class="in" id="bl2" maxlength="24" value="${esc(v.brand_line2)}"><span class="hint">Например TOSHKENT</span></label></div>
        <div class="field"><span>Логотип</span><div class="row"><div class="infobox" style="min-width:160px;min-height:52px;display:grid;place-items:center;background:#E6E3E0">${S.settings.hasLogo ? `<img src="/brand/logo?v=${esc(S.settings.v)}" alt="Логотип" style="max-height:40px;max-width:200px">` : '<span class="note">не загружен — показывается подпись</span>'}</div>
          <button class="btn sm" id="logoUp">${icon('upload')}Загрузить</button>${S.settings.hasLogo ? '<button class="btn sm ghost danger" id="logoDel">Убрать</button>' : ''}</div>
          <span class="hint">PNG с прозрачным фоном, по ширине до 800 px. Показывается в меню вместо знака JAC и на странице входа вместо подписи</span></div>
        <div class="field"><span>Фото здания</span><div class="row"><div style="width:220px;aspect-ratio:2/1;max-width:100%;border-radius:6px;background:center/cover url('/brand/photo?v=${esc(S.settings.v)}');border:1px solid var(--line)"></div>
          <button class="btn sm" id="photoUp">${icon('upload')}Заменить</button>${S.settings.customPhoto ? '<button class="btn sm ghost" id="photoDel">Вернуть стандартное</button>' : ''}</div>
          <span class="hint">Фон всех страниц системы и левая половина страницы входа. Лучше широкое фото, здание по центру</span></div>
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
      await api('/api/admin/settings', { method: 'PUT', body: { warehouse_name: root.querySelector('#sname').value, warehouse_subtitle: root.querySelector('#ssub').value,
        poll_seconds: root.querySelector('#spoll').value, brand_line1: root.querySelector('#bl1').value, brand_line2: root.querySelector('#bl2').value } });
      toast('Настройки сохранены');
      bus.dispatchEvent(new Event('brand'));
    } catch (e) { fail(e); }
  };
  const brandUp = async (kind) => {
    const f = await pickImage();
    if (!f) return;
    try {
      const dataUrl = kind === 'logo' ? await shrink(f, 800, 'image/png') : await shrink(f, 2000, 'image/jpeg', 0.84);
      await api(`/api/admin/brand/${kind}`, { method: 'POST', body: { dataUrl } });
      toast(kind === 'logo' ? 'Логотип загружен' : 'Фото обновлено');
      bus.dispatchEvent(new Event('brand'));
      setTimeout(() => mount(root), 300);
    } catch (e) { fail(e); }
  };
  const brandDel = async (kind) => {
    try { await api(`/api/admin/brand/${kind}`, { method: 'DELETE' }); bus.dispatchEvent(new Event('brand')); setTimeout(() => mount(root), 300); } catch (e) { fail(e); }
  };
  root.querySelector('#logoUp').onclick = () => brandUp('logo');
  root.querySelector('#photoUp').onclick = () => brandUp('photo');
  root.querySelector('#logoDel')?.addEventListener('click', () => brandDel('logo'));
  root.querySelector('#photoDel')?.addEventListener('click', () => brandDel('photo'));
  root.querySelector('#demo')?.addEventListener('click', async () => {
    if (!(await confirmBox('Заменить все данные склада демонстрационными?', 'Сбросить', true, 'Остатки, документы, история и инвентаризации будут заменены. Пользователи и роли сохранятся.'))) return;
    try { await api('/api/demo/reset', { method: 'POST' }); toast('Демо-данные восстановлены'); bus.dispatchEvent(new Event('changed')); } catch (e) { fail(e); }
  });
}
