// Каталог артикулов: остатки, минимумы, редактирование и загрузка из Excel.
import { api, esc, can, icon, toast, fail, modal, confirmBox, table, pageHead, bus, debounce, parseCsv, pickFile, h, fmt } from '../core.js';

export async function mount(root, { params = {} } = {}) {
  let items = [], zones = [], q = (params.q || '').trim().toLowerCase(), zone = '', onlyLow = false;
  root.innerHTML = `${pageHead('Каталог', 'Артикулы, их зоны хранения, вместимость одной ячейки и минимальный остаток для пополнения.',
    `${can('reports.view') ? `<a class="btn" href="/api/reports/stock_sku?format=csv">${icon('download')}Скачать в Excel</a>` : ''}
     ${can('catalog.manage') ? `<button class="btn" id="imp">${icon('upload')}Загрузить из Excel</button><button class="btn pri" id="add">${icon('plus')}Артикул</button>` : ''}`)}
    <div class="filters">
      <label class="field" style="min-width:240px"><span>Поиск</span><input class="in" id="q" type="search" placeholder="Артикул или название"></label>
      <label class="field"><span>Зона</span><select class="in" id="zone"><option value="">Все зоны</option></select></label>
      <label class="check" style="min-height:36px"><input type="checkbox" id="low">Только ниже минимума</label>
    </div>
    <div class="card"><div class="tw" id="tbl"></div></div>`;

  const status = (r) => (r.qty === 0 ? (r.source === 'carsale' && (r.ext_qty || 0) + (r.ext_reserved || 0) > 0 ? 'не размещено' : 'нет на складе') : r.min_qty && r.qty < r.min_qty ? 'ниже минимума' : 'в норме');
  const homeOf = (r) => { try { return JSON.parse(r.home || '[]'); } catch (e) { return []; } };
  const homeTxt = (r) => { const h = homeOf(r); return h.length ? h[0] + (h.length > 1 ? ` +${h.length - 1}` : '') : ''; };
  function draw() {
    const hasHome = items.some((r) => homeOf(r).length);
    const cs = items.some((r) => r.source === 'carsale');
    const list = items.filter((r) => (!q || r.art.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || String(r.home || '').toLowerCase().includes(q) || String(r.barcode || '').toLowerCase().includes(q)) && (!zone || r.zone === zone) && (!onlyLow || status(r) !== 'в норме'));
    table(root.querySelector('#tbl'), {
      columns: [{ key: 'art', label: 'Артикул', mono: true }, { key: 'name', label: 'Наименование' }, { key: 'zone', label: 'Зона' },
        ...(hasHome ? [{ key: 'homeTxt', label: 'Закреплено', mono: true }] : []), { key: 'per', label: 'В ячейку', align: 'r' }, { key: 'min_qty', label: 'Минимум', align: 'r' }, { key: 'qty', label: 'В ячейках', align: 'r' },
        { key: 'cells', label: 'Ячеек', align: 'r' }, ...(cs ? [{ key: 'ext_total', label: 'В Carsale', align: 'r' }, { key: 'price', label: 'Цена', align: 'r' }] : []),
        { key: 'status', label: 'Статус', type: 'status' }],
      rows: list.map((r) => ({ ...r, homeTxt: homeTxt(r), status: status(r), ext_total: r.source === 'carsale' ? (r.ext_qty || 0) + (r.ext_reserved || 0) : '', price: r.price ?? '' })),
      render: { ext_total: (v, r) => (v === '' ? '<span class="muted">—</span>' : `<span class="${v !== r.qty ? 'err' : ''}">${fmt(v)}</span>`) },
      totals: { qty: list.reduce((n, r) => n + r.qty, 0), cells: list.reduce((n, r) => n + r.cells, 0) },
      empty: 'Ничего не найдено',
      onRow: (r) => edit(r),
    });
  }
  function edit(r) {
    const isNew = !r, m = can('catalog.manage');
    const body = h(`<div style="display:flex;flex-direction:column;gap:12px"><div class="grid2">
      <label class="field"><span>Артикул</span><input class="in mono" id="cart" maxlength="40" value="${esc(r ? r.art : '')}" ${isNew ? '' : 'readonly'}></label>
      <label class="field"><span>Зона хранения</span><select class="in" id="czone" ${m ? '' : 'disabled'}>${zones.map((z) => `<option value="${z.id}" ${r && r.zone === z.id ? 'selected' : ''}>${esc(z.id)} · ${esc(z.sub || z.title)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Наименование</span><input class="in" id="cname" maxlength="120" value="${esc(r ? r.name : '')}" ${m ? '' : 'readonly'}></label>
      <div class="grid2">
        <label class="field"><span>Вместимость ячейки, шт</span><input class="in" id="cper" type="number" min="1" value="${r ? r.per : ''}" ${m ? '' : 'readonly'}><span class="hint">Сколько штук помещается в одну ячейку</span></label>
        <label class="field"><span>Минимальный остаток, шт</span><input class="in" id="cmin" type="number" min="0" value="${r ? r.min_qty : 0}" ${m ? '' : 'readonly'}><span class="hint">Ниже — попадёт в «Требует внимания». 0 — не следить</span></label>
      </div>
      <label class="field"><span>Закреплённые ячейки</span><input class="in mono" id="chome" value="${esc(r && r.home ? (() => { try { return JSON.parse(r.home).join(', '); } catch (e) { return ''; } })() : '')}" placeholder="A-16-01-01, A-16-01-02" ${m ? '' : 'readonly'}><span class="hint">Сюда артикул размещается в первую очередь; первая ячейка уходит в Carsale как место хранения</span></label>
      <label class="field"><span>Штрихкод производителя</span><input class="in mono" id="cbar" maxlength="60" value="${esc(r && r.barcode ? r.barcode : '')}" placeholder="4607012345678" ${m ? '' : 'readonly'}><span class="hint">По нему ТСД находит артикул при скане заводской этикетки. Кладовщик может привязать его прямо с ТСД</span></label>
      ${r ? `<div class="infobox">В ячейках <b>${r.qty}</b> шт (${r.cells} яч.). <a href="#/map?sku=${encodeURIComponent(r.art)}">Показать на карте</a></div>` : ''}
      ${r && r.source === 'carsale' ? `<div class="infobox"><b>Из Carsale</b> · на складе ${fmt(r.ext_qty || 0)} шт${r.ext_reserved ? `, бронь ${fmt(r.ext_reserved)}` : ''} · тип ${esc(r.ext_type || '—')}${r.price ? ` · цена ${fmt(r.price)}` : ''}${r.unit ? ` · ${esc(r.unit)}` : ''}${r.brand ? ` · ${esc(r.brand)}` : ''}${r.ext_location ? `<br>Место в Carsale: <span class="mono">${esc(r.ext_location)}</span>` : ''}${r.ext_active ? '' : '<br><span class="err">В Carsale неактивен</span>'}
        <div class="note" style="margin-top:4px">Название и цена обновляются при синхронизации. Зону и вместимость можно менять здесь — синхронизация их не перезапишет.</div></div>` : ''}</div>`);
    const acts = [];
    if (r && m && !r.cells && r.source !== 'carsale') acts.push({ label: 'Удалить', kind: 'danger', left: true, onClick: async () => {
      if (!(await confirmBox(`Удалить артикул ${r.art}?`, 'Удалить', true))) return true;
      await api('/api/catalog/' + encodeURIComponent(r.art), { method: 'DELETE' }); toast('Артикул удалён'); load();
    } });
    acts.push({ label: m ? 'Отмена' : 'Закрыть' });
    if (m) acts.push({ label: 'Сохранить', kind: 'pri', onClick: async ({ el }) => {
      await api('/api/catalog', { method: 'POST', body: { isNew, art: el.querySelector('#cart').value.trim(), name: el.querySelector('#cname').value, zone: el.querySelector('#czone').value,
        per: Number(el.querySelector('#cper').value), min_qty: Number(el.querySelector('#cmin').value || 0), home: el.querySelector('#chome').value, barcode: el.querySelector('#cbar').value } });
      toast('Сохранено'); bus.dispatchEvent(new Event('changed')); load();
    } });
    const md = modal({ title: isNew ? 'Новый артикул' : r.art, sub: r ? esc(r.name) : '', body, actions: acts });
    body.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => md.close()));
  }
  async function importDialog() {
    const f = await pickFile();
    if (!f) return;
    const rows = parseCsv(f.text);
    if (rows.length && !/^\d+$/.test(rows[0][3] || '')) rows.shift();
    const parsed = rows.map((r) => ({ art: r[0], name: r[1], zone: (r[2] || '').toUpperCase(), per: r[3], min_qty: r[4] || 0 }));
    const known = new Set(items.map((x) => x.art));
    const body = h(`<div style="display:flex;flex-direction:column;gap:10px"><p class="note">Файл <b>${esc(f.name)}</b>: строк ${parsed.length}, новых ${parsed.filter((x) => !known.has(x.art)).length}, обновится ${parsed.filter((x) => known.has(x.art)).length}.
      Колонки: артикул; наименование; зона; вместимость ячейки; минимум (необязательно).</p><div class="tw" style="max-height:340px"></div></div>`);
    table(body.querySelector('.tw'), {
      columns: [{ key: 'art', label: 'Артикул', mono: true }, { key: 'name', label: 'Наименование' }, { key: 'zone', label: 'Зона' }, { key: 'per', label: 'В ячейку', align: 'r' }, { key: 'min_qty', label: 'Мин.', align: 'r' }, { key: 'st', label: '' }],
      rows: parsed.slice(0, 300).map((x) => ({ ...x, st: known.has(x.art) ? 'обновится' : 'новый' })),
    });
    modal({ title: 'Загрузка каталога', wide: true, body, actions: [{ label: 'Отмена' }, { label: `Загрузить ${parsed.length}`, kind: 'pri', onClick: async () => {
      const r = await api('/api/catalog/import', { method: 'POST', body: { rows: parsed } });
      toast(`Добавлено ${r.added}, обновлено ${r.updated}`); bus.dispatchEvent(new Event('changed')); load();
    } }] });
  }
  async function load() {
    try {
      const r = await api('/api/catalog');
      items = r.items; zones = r.zones;
      const sel = root.querySelector('#zone');
      if (sel.options.length === 1) sel.insertAdjacentHTML('beforeend', zones.map((z) => `<option value="${z.id}">${esc(z.id)} · ${esc(z.sub || z.title)}</option>`).join(''));
      draw();
    } catch (e) { fail(e); }
  }
  if (params.q) root.querySelector('#q').value = params.q;
  root.querySelector('#q').oninput = debounce((e) => { q = e.target.value.trim().toLowerCase(); draw(); }, 150);
  root.querySelector('#zone').onchange = (e) => { zone = e.target.value; draw(); };
  root.querySelector('#low').onchange = (e) => { onlyLow = e.target.checked; draw(); };
  root.querySelector('#add')?.addEventListener('click', () => edit(null));
  root.querySelector('#imp')?.addEventListener('click', () => importDialog().catch(fail));
  await load();
}
