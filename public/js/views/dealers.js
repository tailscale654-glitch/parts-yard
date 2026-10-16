// Дилеры — копия справочника Carsale «Запчасти → Справочники → Дилеры». Обновляется автоматически.
import { api, esc, can, icon, toast, fail, modal, table, pageHead, fmtTs, fmt, bus, debounce, progress, statusPill } from '../core.js';

const CS_URL = 'https://app.carsale.uz/spare-parts/references';
// сортировка по сути названия: без кавычек и организационно-правовой формы (ООО, MCHJ, ИП…)
const sortKey = (s) => String(s || '').toLowerCase().replace(/[«»"'`„“”]/g, '')
  .replace(/(^|\s)(ооо|ooo|ип|сп|мчж|mchj|mcj|qk|llc|xk|чп|ао)(?=\s|$)/gi, ' ').replace(/\s+/g, ' ').trim();

export async function mount(root, { params = {} } = {}) {
  let data = null, q = (params.q || '').trim().toLowerCase(), region = '', onlyActive = true;
  const canSync = can('admin.settings') || can('catalog.manage');

  root.innerHTML = `${pageHead('Дилеры', `Справочник из Carsale: <a href="${CS_URL}" target="_blank" rel="noopener">Запчасти → Справочники → Дилеры</a>. Добавлять, менять и удалять дилеров — в Carsale, сюда изменения придут сами.`)}
    <div id="sync"></div>
    <div class="filters">
      <label class="field" style="min-width:240px"><span>Поиск</span><input class="in" id="q" type="search" placeholder="Название, код или ИНН" value="${esc(params.q || '')}"></label>
      <label class="field"><span>Регион</span><select class="in" id="reg"><option value="">Все регионы</option></select></label>
      <label class="check" style="min-height:36px"><input type="checkbox" id="act" checked>Только активные</label>
    </div>
    <div class="card"><div class="tw" id="tbl"><div class="sk" style="height:180px;margin:12px"></div></div></div>`;

  function syncBox() {
    const c = data.carsale, el = root.querySelector('#sync');
    if (!c.configured) {
      el.innerHTML = '<div class="infobox">Интеграция с Carsale не настроена — справочник дилеров пуст. Настройка: раздел «Интеграция Carsale».</div>';
      return;
    }
    const last = c.last;
    const state = !c.enabled ? '<span class="pill wait">загрузка дилеров выключена</span>'
      : !last ? '<span class="pill wait">ждёт первой синхронизации</span>'
      : last.status === 'error' ? `<span class="pill bad">ошибка</span> <span class="note">${esc(last.error || '')}</span>`
      : last.status === 'partial' ? `<span class="pill wait">частично</span> <span class="note">${esc(last.error || '')}</span>`
      : '<span class="pill ok">в порядке</span>';
    el.innerHTML = `<div class="infobox row dsync" style="justify-content:space-between;gap:12px">
      <span>${icon('link')}<b>${fmt(data.dealers.length)}</b> дилеров, активных ${fmt(data.dealers.filter((d) => d.active).length)} · проверка ${c.auto ? `каждые ${c.intervalMin} мин` : 'только вручную'} · последняя ${last ? fmtTs(last.started) : '—'} ${state}</span>
      ${canSync ? `<button class="btn sm" id="syncnow">${icon('refresh')}Проверить сейчас</button>` : ''}</div>`;
    el.querySelector('#syncnow')?.addEventListener('click', syncNow);
  }

  function draw() {
    const list = data.dealers.filter((d) => (!onlyActive || d.active) && (!region || d.region === region)
      && (!q || d.name.toLowerCase().includes(q) || (d.code || '').toLowerCase().includes(q) || (d.inn || '').includes(q)))
      .sort((a, b) => b.active - a.active || sortKey(a.name).localeCompare(sortKey(b.name), 'ru'));
    table(root.querySelector('#tbl'), {
      columns: [{ key: 'name', label: 'Дилер' }, { key: 'code', label: 'Код', mono: true }, { key: 'region', label: 'Регион' },
        { key: 'orders', label: 'Заказов', align: 'r' }, { key: 'open_orders', label: 'В работе', align: 'r' }, { key: 'last_order', label: 'Последний заказ' }, { key: 'status', label: 'В Carsale' }],
      rows: list.map((d) => ({ ...d, code: d.code || '', region: d.region || '', last_order: d.last_order || '', status: d.active ? 'активен' : 'неактивен' })),
      empty: data.dealers.length ? 'Ничего не найдено' : 'Справочник пуст — дилеры появятся после синхронизации с Carsale',
      render: {
        name: (v, d) => `${esc(v)}${d.note ? `<div class="note">${esc(d.note)}</div>` : ''}`,
        open_orders: (v) => (v ? `<b>${v}</b>` : '<span class="muted">0</span>'),
        last_order: (v) => (v ? fmtTs(v) : '<span class="muted">—</span>'),
        status: (v) => (v === 'активен' ? '<span class="pill ok">активен</span>' : '<span class="pill mute">неактивен</span>'),
      },
      onRow: (d) => open(d.id),
    });
  }

  async function open(id) {
    let d;
    try { d = await api(`/api/dealers/${id}`); } catch (e) { fail(e); return; }
    const edit = can('docs.orders');
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:14px';
    body.innerHTML = `<dl class="kv">
        <dt>Код</dt><dd class="mono">${esc(d.code || '—')}</dd>
        <dt>Регион</dt><dd>${esc(d.region || '—')}</dd>
        ${d.address ? `<dt>Адрес</dt><dd>${esc(d.address)}</dd>` : ''}
        ${d.phone ? `<dt>Телефон</dt><dd>${esc(d.phone)}</dd>` : ''}
        ${d.inn ? `<dt>ИНН</dt><dd class="mono">${esc(d.inn)}</dd>` : ''}
        <dt>В Carsale</dt><dd>${d.active ? '<span class="pill ok">активен</span>' : '<span class="pill mute">неактивен</span> <span class="note">в новых заказах не предлагается</span>'} <span class="note">ID ${esc(d.ext_id)}${d.synced ? ` · проверен ${fmtTs(d.synced)}` : ''}</span></dd>
        <dt>Заказов</dt><dd>${fmt(d.totals.orders)} · заказано ${fmt(d.totals.ordered)} шт, собрано ${fmt(d.totals.picked)} шт</dd></dl>
      ${edit ? `<label class="field"><span>Заметка склада</span><input class="in" id="dnote" maxlength="300" value="${esc(d.note || '')}" placeholder="Например: забирает по вторникам, контакт — Азиз"><span class="hint">Видна только в WarehouseOS, в Carsale не уходит</span></label>` : ''}
      <div class="field"><span>Последние заказы</span><div class="tw" id="dorders"></div></div>`;
    table(body.querySelector('#dorders'), {
      columns: [{ key: 'number', label: 'Заказ', mono: true }, { key: 'created', label: 'Создан' }, { key: 'lines', label: 'Строк', align: 'r' },
        { key: 'progress', label: 'Собрано' }, { key: 'status', label: 'Статус' }],
      rows: d.orders.map((o) => ({ ...o, status: o.done ? (o.picked >= o.ordered ? 'собран' : 'с недостачей') : o.picked ? 'собирается' : 'ожидает' })),
      render: { created: (v) => fmtTs(v), progress: (v, o) => progress(o.picked, o.ordered), status: (v) => statusPill(v) },
      empty: 'Заказов не было',
      onRow: (o) => { location.hash = o.done ? `#/orders?q=${encodeURIComponent(o.number)}&state=all` : `#/map?order=${o.id}`; },
    });
    const acts = [];
    if (d.orders.length) acts.push({ label: 'Все заказы', left: true, onClick: () => { location.hash = `#/orders?q=${encodeURIComponent(d.name)}&state=all`; } });
    acts.push({ label: edit ? 'Отмена' : 'Закрыть' });
    if (edit) {
      acts.push({ label: 'Сохранить', kind: 'pri', onClick: async ({ el }) => {
        await api(`/api/dealers/${d.id}`, { method: 'PUT', body: { note: el.querySelector('#dnote').value } });
        toast('Заметка сохранена'); changed();
      } });
    }
    modal({ title: d.name, sub: [d.code, d.region].filter(Boolean).map(esc).join(' · '), wide: true, body, actions: acts });
  }

  async function syncNow() {
    const b = root.querySelector('#syncnow');
    if (b) { b.disabled = true; b.lastChild.textContent = 'Проверяю…'; }
    try {
      const r = await api('/api/integrations/carsale/sync', { method: 'POST' });
      const d = r.stats && r.stats.dealers;
      if (d) {
        const n = d.added + d.updated + d.removed + d.off + d.on;
        toast(n ? `Дилеры: новых ${d.added}, изменено ${d.updated}, удалено ${d.removed}` : `Дилеры: изменений нет, в справочнике ${d.total}`);
      } else toast(r.error ? `Дилеры не обновились: ${r.error}` : 'Загрузка дилеров выключена в настройках интеграции', !!r.error);
      bus.dispatchEvent(new Event('changed'));
    } catch (e) { fail(e); }
    await load();
  }

  function changed() { bus.dispatchEvent(new Event('changed')); load(); }

  async function load() {
    try {
      data = await api('/api/dealers');
      const sel = root.querySelector('#reg');
      sel.innerHTML = `<option value="">Все регионы</option>${data.regions.map((r) => `<option ${r === region ? 'selected' : ''}>${esc(r)}</option>`).join('')}`;
      syncBox();
      draw();
    } catch (e) { fail(e); }
  }

  root.querySelector('#q').oninput = debounce((e) => { q = e.target.value.trim().toLowerCase(); draw(); }, 150);
  root.querySelector('#reg').onchange = (e) => { region = e.target.value; draw(); };
  root.querySelector('#act').onchange = (e) => { onlyActive = e.target.checked; draw(); };
  await load();
  if (params.open) open(+params.open);
  const onRev = debounce(() => { if (!document.querySelector('.modal-back')) load(); }, 600);
  bus.addEventListener('rev', onRev);
  return () => bus.removeEventListener('rev', onRev);
}
