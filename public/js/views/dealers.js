// Справочник дилеров: из Carsale (обновляется автоматически) и свои.
import { api, esc, can, icon, toast, fail, modal, confirmBox, table, pageHead, fmtTs, fmt, bus, debounce, progress, statusPill } from '../core.js';

// сортировка по сути названия: без кавычек и организационно-правовой формы (ООО, MChJ, СП…)
const sortKey = (s) => String(s || '').toLowerCase().replace(/[«»"'`„“”]/g, '')
  .replace(/(^|\s)(ооо|ooo|ип|сп|мчж|mchj|mcj|llc|xk|чп|ао|ат)(?=\s|$)/gi, ' ').replace(/\s+/g, ' ').trim();

export async function mount(root, { params = {} } = {}) {
  let data = null, q = (params.q || '').trim().toLowerCase(), src = '', onlyActive = true;
  const canSync = can('admin.settings') || can('catalog.manage');

  root.innerHTML = `${pageHead('Дилеры', 'Справочник дилеров для заказов. Дилеры из Carsale подтягиваются и проверяются автоматически, своих можно добавить вручную.',
    `<span id="acts" class="row"></span>`)}
    <div id="sync"></div>
    <div class="filters">
      <label class="field" style="min-width:240px"><span>Поиск</span><input class="in" id="q" type="search" placeholder="Название или код" value="${esc(params.q || '')}"></label>
      <div class="seg" id="src"><button type="button" data-s="" aria-pressed="true">Все</button><button type="button" data-s="carsale" aria-pressed="false">Из Carsale</button><button type="button" data-s="local" aria-pressed="false">Свои</button></div>
      <label class="check" style="min-height:36px"><input type="checkbox" id="act" checked>Только активные</label>
    </div>
    <div class="card"><div class="tw" id="tbl"><div class="sk" style="height:180px;margin:12px"></div></div></div>`;

  function syncBox() {
    const c = data.carsale, el = root.querySelector('#sync');
    const fromCs = data.dealers.filter((d) => d.source === 'carsale');
    if (!c.configured) { el.innerHTML = ''; return; }
    const last = c.last;
    const when = last ? fmtTs(last.started) : 'ещё не было';
    const state = !c.enabled ? '<span class="pill wait">загрузка дилеров выключена</span>'
      : !last ? '<span class="pill wait">ждёт первой синхронизации</span>'
      : last.status === 'error' ? `<span class="pill bad">ошибка</span> <span class="note">${esc(last.error || '')}</span>`
      : last.status === 'partial' ? `<span class="pill wait">частично</span> <span class="note">${esc(last.error || '')}</span>`
      : '<span class="pill ok">в порядке</span>';
    el.innerHTML = `<div class="infobox row dsync" style="justify-content:space-between;gap:12px">
      <span>${icon('link')}Carsale: <b>${fmt(fromCs.length)}</b> дилеров, из них ${fmt(fromCs.filter((d) => d.active).length)} активных · проверка ${c.auto ? `каждые ${c.intervalMin} мин` : 'только вручную'} · последняя ${when} ${state}</span>
      ${canSync ? '<button class="btn sm" id="syncnow">' + icon('refresh') + 'Проверить сейчас</button>' : ''}</div>`;
    el.querySelector('#syncnow')?.addEventListener('click', syncNow);
  }

  function draw() {
    const list = data.dealers.filter((d) => (!onlyActive || d.active) && (!src || d.source === src)
      && (!q || d.name.toLowerCase().includes(q) || (d.code || '').toLowerCase().includes(q) || (d.region || '').toLowerCase().includes(q)))
      .sort((a, b) => b.active - a.active || sortKey(a.name).localeCompare(sortKey(b.name), 'ru'));
    const hasRegion = data.dealers.some((d) => d.region);
    table(root.querySelector('#tbl'), {
      columns: [{ key: 'name', label: 'Дилер' }, ...(hasRegion ? [{ key: 'region', label: 'Регион' }] : []), { key: 'source', label: 'Откуда' },
        { key: 'orders', label: 'Заказов', align: 'r' }, { key: 'open_orders', label: 'В работе', align: 'r' }, { key: 'last_order', label: 'Последний заказ' }, { key: 'status', label: 'Статус' }],
      rows: list.map((d) => ({ ...d, region: d.region || '', last_order: d.last_order || '', status: d.active ? 'активен' : d.source === 'carsale' ? 'нет в Carsale' : 'отключён' })),
      empty: q ? 'Ничего не найдено' : 'Дилеров пока нет',
      render: {
        name: (v, d) => `${esc(v)}${d.code ? ` <span class="note mono">${esc(d.code)}</span>` : ''}${d.note ? `<div class="note">${esc(d.note)}</div>` : ''}`,
        source: (v, d) => (v === 'carsale' ? `<span class="pill info" title="ID в Carsale: ${esc(d.ext_id)}">Carsale</span>` : '<span class="pill mute">свой</span>'),
        open_orders: (v) => (v ? `<b>${v}</b>` : '<span class="muted">0</span>'),
        last_order: (v) => (v ? fmtTs(v) : '<span class="muted">—</span>'),
        status: (v) => (v === 'активен' ? '<span class="pill ok">активен</span>' : `<span class="pill bad">${esc(v)}</span>`),
      },
      onRow: (d) => open(d.id),
    });
  }

  async function open(id) {
    let d;
    try { d = await api(`/api/dealers/${id}`); } catch (e) { fail(e); return; }
    const local = d.source === 'local', edit = can('docs.orders');
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:14px';
    body.innerHTML = `<dl class="kv">
        <dt>Откуда</dt><dd>${local ? 'добавлен в WarehouseOS' : `Carsale · ID <span class="mono">${esc(d.ext_id)}</span>${d.synced ? ` · проверен ${fmtTs(d.synced)}` : ''}`}</dd>
        <dt>Статус</dt><dd>${d.active ? '<span class="pill ok">активен</span>' : local ? '<span class="pill bad">отключён</span>' : '<span class="pill bad">нет в Carsale</span> <span class="note">в новых заказах не предлагается</span>'}</dd>
        <dt>Заказов</dt><dd>${fmt(d.totals.orders)} · заказано ${fmt(d.totals.ordered)} шт, собрано ${fmt(d.totals.picked)} шт</dd></dl>
      ${local && edit ? `<div class="grid2">
          <label class="field"><span>Название</span><input class="in" id="dn" maxlength="120" value="${esc(d.name)}"></label>
          <label class="field"><span>Код</span><input class="in" id="dc" maxlength="40" value="${esc(d.code || '')}"></label>
          <label class="field"><span>Регион</span><input class="in" id="dr" maxlength="80" list="dregions" value="${esc(d.region || '')}"></label>
          <label class="field"><span>Телефон</span><input class="in" id="dp" maxlength="60" value="${esc(d.phone || '')}"></label></div>
        <datalist id="dregions">${data.regions.map((r) => `<option value="${esc(r)}">`).join('')}</datalist>
        <label class="check"><input type="checkbox" id="da" ${d.active ? 'checked' : ''}>Активен — предлагать в новых заказах</label>` : ''}
      ${edit ? `<label class="field"><span>Заметка</span><input class="in" id="dnote" maxlength="300" value="${esc(d.note || '')}" placeholder="Например: забирает по вторникам, контакт — Азиз"></label>` : ''}
      <div class="field"><span>Последние заказы</span><div class="tw" id="dorders"></div></div>`;
    table(body.querySelector('#dorders'), {
      columns: [{ key: 'number', label: 'Заказ', mono: true }, { key: 'created', label: 'Создан' }, { key: 'lines', label: 'Строк', align: 'r' },
        { key: 'progress', label: 'Собрано' }, { key: 'status', label: 'Статус' }],
      rows: d.orders.map((o) => ({ ...o, status: o.done ? (o.picked >= o.ordered ? 'собран' : 'с недостачей') : o.picked ? 'собирается' : 'ожидает' })),
      render: { created: (v) => fmtTs(v), progress: (v, o) => progress(o.picked, o.ordered), status: (v) => statusPill(v) },
      empty: 'Заказов не было',
      onRow: (o) => { location.hash = o.done ? `#/orders?q=${encodeURIComponent(o.number)}` : `#/map?order=${o.id}`; },
    });
    const acts = [];
    if (local && edit && !d.totals.orders) {
      acts.push({ label: 'Удалить', kind: 'ghost danger', left: true, onClick: async () => {
        if (!(await confirmBox(`Удалить дилера «${d.name}»?`, 'Удалить', true))) return true;
        await api(`/api/dealers/${d.id}`, { method: 'DELETE' });
        toast('Дилер удалён'); changed();
      } });
    }
    if (d.orders.length) acts.push({ label: 'Все заказы', left: true, onClick: () => { location.hash = `#/orders?q=${encodeURIComponent(d.name)}&state=all`; } });
    acts.push({ label: edit ? 'Отмена' : 'Закрыть' });
    if (edit) {
      acts.push({ label: 'Сохранить', kind: 'pri', onClick: async ({ el }) => {
        const v = (id2) => el.querySelector(id2)?.value ?? '';
        const body2 = local ? { name: v('#dn'), code: v('#dc'), region: v('#dr'), phone: v('#dp'), note: v('#dnote'), active: el.querySelector('#da').checked } : { note: v('#dnote') };
        await api(`/api/dealers/${d.id}`, { method: 'PUT', body: body2 });
        toast('Сохранено'); changed();
      } });
    }
    modal({ title: d.name, sub: [d.region, d.city, d.phone].filter(Boolean).map(esc).join(' · '), wide: true, body, actions: acts });
  }

  function addDealer() {
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:12px';
    body.innerHTML = `<p class="note" style="margin:0">Дилеров из Carsale добавлять не нужно — они появятся сами. Здесь — те, кого в Carsale нет: сервисы, партнёры, свои подразделения.</p>
      <div class="grid2"><label class="field"><span>Название</span><input class="in" id="dn" maxlength="120" placeholder="Сервис «Чиланзар»"></label>
        <label class="field"><span>Код</span><input class="in" id="dc" maxlength="40"></label>
        <label class="field"><span>Регион</span><input class="in" id="dr" maxlength="80" list="dregions2"></label>
        <label class="field"><span>Телефон</span><input class="in" id="dp" maxlength="60"></label></div>
      <datalist id="dregions2">${data.regions.map((r) => `<option value="${esc(r)}">`).join('')}</datalist>
      <label class="field"><span>Заметка</span><input class="in" id="dnote" maxlength="300"></label>`;
    modal({ title: 'Новый дилер', body, actions: [{ label: 'Отмена' }, { label: 'Добавить', kind: 'pri', onClick: async ({ el }) => {
      const v = (s) => el.querySelector(s).value;
      await api('/api/dealers', { method: 'POST', body: { name: v('#dn'), code: v('#dc'), region: v('#dr'), phone: v('#dp'), note: v('#dnote') } });
      toast('Дилер добавлен'); changed();
    } }] });
    setTimeout(() => body.querySelector('#dn').focus(), 50);
  }

  async function syncNow() {
    const b = root.querySelector('#syncnow');
    if (b) { b.disabled = true; b.lastChild.textContent = 'Проверяю…'; }
    try {
      const r = await api('/api/integrations/carsale/sync', { method: 'POST' });
      const d = r.stats && r.stats.dealers;
      if (d) {
        const n = d.added + d.linked + d.updated + d.off + d.on;
        toast(n ? `Дилеры: новых ${d.added}, привязано ${d.linked}, изменено ${d.updated}, отключено ${d.off}` : `Дилеры: изменений нет, в Carsale ${d.total}`);
      } else toast(r.error ? `Дилеры не обновились: ${r.error}` : 'Загрузка дилеров выключена в настройках интеграции', !!r.error);
      bus.dispatchEvent(new Event('changed'));
    } catch (e) { fail(e); }
    await load();
  }

  function changed() { bus.dispatchEvent(new Event('changed')); load(); }

  async function load() {
    try {
      data = await api('/api/dealers');
      root.querySelector('#acts').innerHTML = can('docs.orders') ? `<button class="btn pri" id="add">${icon('plus')}Дилер</button>` : '';
      root.querySelector('#add')?.addEventListener('click', addDealer);
      syncBox();
      draw();
    } catch (e) { fail(e); }
  }

  root.querySelector('#q').oninput = debounce((e) => { q = e.target.value.trim().toLowerCase(); draw(); }, 150);
  root.querySelector('#src').onclick = (e) => {
    const b = e.target.closest('[data-s]'); if (!b) return;
    src = b.dataset.s;
    root.querySelectorAll('#src button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    draw();
  };
  root.querySelector('#act').onchange = (e) => { onlyActive = e.target.checked; draw(); };
  await load();
  if (params.open) open(+params.open);
  const onRev = debounce(() => { if (!document.querySelector('.modal-back')) load(); }, 600);
  bus.addEventListener('rev', onRev);
  return () => bus.removeEventListener('rev', onRev);
}
