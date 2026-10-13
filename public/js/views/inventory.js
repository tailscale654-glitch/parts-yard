// Инвентаризация: задания, подсчёт по ячейкам, закрытие с записью факта.
import { api, esc, can, icon, toast, fail, modal, confirmBox, table, progress, pageHead, fmtTs, bus, debounce, statusPill, h } from '../core.js';
import { catalog } from './docform.js';

const ST = { open: 'в работе', closed: 'применено', cancelled: 'отменено' };

export async function mount(root, { rest }) {
  if (rest[0]) return taskView(root, +rest[0]);
  root.innerHTML = `${pageHead('Инвентаризация', 'Задание фиксирует учётные остатки выбранных ячеек. Кладовщики вносят факт, при закрытии факт записывается в остатки.',
    can('inventory.manage') ? `<button class="btn pri" id="new">${icon('plus')}Новое задание</button>` : '')}
    <div class="card"><div class="tw" id="tbl"></div></div>`;
  async function load() {
    const r = await api('/api/inventory');
    table(root.querySelector('#tbl'), {
      columns: [{ key: 'name', label: 'Задание' }, { key: 'created', label: 'Создано' }, { key: 'created_by', label: 'Кто' },
        { key: 'progress', label: 'Посчитано' }, { key: 'diffs', label: 'Расхождений', align: 'r' }, { key: 'status', label: 'Статус' }],
      rows: r.tasks.map((t) => ({ ...t, status: ST[t.status] })),
      empty: 'Заданий ещё не было',
      render: { created: (v) => `<span class="mono">${fmtTs(v)}</span>`, progress: (v, t) => progress(t.counted, t.total), status: (v) => statusPill(v),
        diffs: (v) => (v ? `<b class="err">${v}</b>` : '0') },
      onRow: (t) => { location.hash = `#/inventory/${t.id}`; },
    });
  }
  root.querySelector('#new')?.addEventListener('click', async () => {
    const lay = await api('/api/layout');
    const body = h(`<div style="display:flex;flex-direction:column;gap:12px">
      <label class="field"><span>Название</span><input class="in" id="iname" maxlength="80" placeholder="Например, пересчёт зоны A"></label>
      <div class="field"><span>Зоны целиком</span><div class="row">${lay.zones.map((z) => `<label class="check"><input type="checkbox" value="${z.id}" class="iz">${esc(z.id)} · ${esc(z.sub || z.title)}</label>`).join('')}</div></div>
      <label class="field"><span>Или отдельные ряды</span><input class="in mono" id="irows" placeholder="A-01, B-03"><span class="hint">Через запятую, формат «зона-ряд»</span></label>
      <label class="check"><input type="checkbox" id="istock" checked>Только ячейки с товаром (быстрее; пустые не проверяются)</label></div>`);
    modal({ title: 'Новое задание инвентаризации', body, actions: [{ label: 'Отмена' }, { label: 'Создать', kind: 'pri', onClick: async ({ el }) => {
      const zones = [...el.querySelectorAll('.iz:checked')].map((x) => x.value);
      const rows = el.querySelector('#irows').value.toUpperCase().split(/[\s,;]+/).filter(Boolean).map((x) => { const m = x.match(/^([A-Z0-9]+)-?(\d{1,2})$/); return m ? `${m[1]}-${m[2].padStart(2, '0')}` : x; });
      const r = await api('/api/inventory', { method: 'POST', body: { name: el.querySelector('#iname').value, zones, rows, onlyStocked: el.querySelector('#istock').checked } });
      toast(`Задание создано: ${r.lines} ячеек`); bus.dispatchEvent(new Event('changed'));
      location.hash = `#/inventory/${r.id}`;
    } }] });
  });
  await load();
  const onRev = debounce(() => load().catch(() => {}), 600);
  bus.addEventListener('rev', onRev);
  return () => bus.removeEventListener('rev', onRev);
}

async function taskView(root, id) {
  let t, filter = 'all', q = '', blind = false;
  const items = await catalog();
  const names = new Map(items.map((s) => [s.art, s.name]));
  root.innerHTML = '<div class="sk" style="height:38px;width:260px"></div><div class="sk" style="height:180px"></div>';

  const isDiff = (l) => l.qty_counted != null && (l.qty_counted !== l.qty_expected || (l.art_counted && l.art_counted !== l.art_expected));
  function head() {
    const counted = t.lines.filter((l) => l.qty_counted != null).length, diffs = t.lines.filter(isDiff).length;
    const open = t.status === 'open';
    return `${pageHead(t.name, `Создано ${fmtTs(t.created)} · ${esc(t.created_by || '')} · ${statusPill(ST[t.status])}${t.closed_at ? ` · закрыто ${fmtTs(t.closed_at)} (${esc(t.closed_by || '')})` : ''}`,
      `<a class="btn" href="#/inventory">← Все задания</a>${can('reports.view') ? `<a class="btn" href="#/reports/inventory?task=${t.id}">Отчёт о расхождениях</a>` : ''}
       ${open && can('inventory.manage') ? '<button class="btn danger" id="cancel">Отменить</button><button class="btn pri" id="close">Закрыть и применить</button>' : ''}`)}
      <div class="card"><div class="cb inv-head">
        <div style="min-width:220px;flex:1">${progress(counted, t.lines.length)}</div>
        <span class="note">Расхождений: <b id="invDiffs" class="${diffs ? 'err' : ''}">${diffs}</b></span>
        <div class="seg" id="seg">${[['all', 'Все'], ['todo', 'Не посчитано'], ['diff', 'Расхождения']].map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${filter === k}">${l}</button>`).join('')}</div>
        <input class="in sm mono" id="q" type="search" placeholder="Адрес или артикул" style="max-width:200px" value="${esc(q)}">
        ${open ? `<label class="check"><input type="checkbox" id="blind" ${blind ? 'checked' : ''}>Слепой пересчёт (скрыть учёт)</label>` : ''}
      </div></div>`;
  }
  function rows() {
    const open = t.status === 'open' && can('inventory.count');
    const list = t.lines.filter((l) => (filter === 'all' || (filter === 'todo' ? l.qty_counted == null : isDiff(l))) &&
      (!q || l.addr.toLowerCase().includes(q) || (l.art_expected || '').toLowerCase().includes(q)));
    const shown = list.slice(0, 600);
    return `<div class="card"><div class="tw" style="max-height:calc(100vh - 290px)"><table class="t"><thead><tr><th>Адрес</th><th>По учёту</th><th class="r">Учёт, шт</th><th class="r">Факт, шт</th><th>Найден другой артикул</th><th>Считал</th></tr></thead><tbody>
      ${shown.map((l) => `<tr class="inv-row${isDiff(l) ? ' diff' : l.qty_counted != null ? ' done' : ''}" data-id="${l.id}">
        <td class="mono">${l.addr}</td>
        <td>${l.art_expected ? `<span class="mono">${esc(l.art_expected)}</span> <span class="note">${esc(l.name_expected || '')}</span>` : '<span class="muted">пусто</span>'}</td>
        <td class="r mono">${blind && l.qty_counted == null ? '•••' : l.qty_expected}</td>
        <td class="r">${open ? `<input class="in mono" type="number" min="0" data-q value="${l.qty_counted ?? ''}" aria-label="Факт ${l.addr}">` : `<span class="mono">${l.qty_counted ?? '—'}</span>`}</td>
        <td>${open ? `<input class="in sm mono" list="invarts" data-a value="${esc(l.art_counted || '')}" placeholder="${l.art_expected ? 'тот же' : 'артикул'}" style="width:140px" aria-label="Артикул ${l.addr}">` : esc(l.art_counted || '')}</td>
        <td class="note">${esc(l.counted_by || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Нет строк</td></tr>'}
      </tbody></table>${list.length > shown.length ? `<p class="note" style="padding:8px 12px">Показаны первые ${shown.length} из ${list.length}. Уточните поиск.</p>` : ''}</div></div>
      <datalist id="invarts">${items.map((s) => `<option value="${esc(s.art)}">${esc(s.name)}</option>`).join('')}</datalist>`;
  }
  function render() {
    root.innerHTML = head() + rows();
    root.querySelector('#seg').onclick = (e) => { const b = e.target.closest('[data-f]'); if (b) { filter = b.dataset.f; render(); } };
    root.querySelector('#q').oninput = debounce((e) => { q = e.target.value.trim().toLowerCase(); render(); root.querySelector('#q').focus(); }, 300);
    const bl = root.querySelector('#blind'); if (bl) bl.onchange = () => { blind = bl.checked; render(); };
    root.querySelectorAll('tr[data-id]').forEach((tr) => {
      const save = async () => {
        const l = t.lines.find((x) => x.id === +tr.dataset.id);
        const qv = tr.querySelector('[data-q]').value, av = tr.querySelector('[data-a]').value.trim();
        if (qv === String(l.qty_counted ?? '') && av === (l.art_counted || '')) return;
        try {
          const r = await api(`/api/inventory/${t.id}/lines/${l.id}`, { method: 'POST', opId: true, body: { qty: qv === '' ? null : Number(qv), art: av || null } });
          Object.assign(l, r.line, { name_counted: names.get(r.line.art_counted) || null });
          tr.className = `inv-row${isDiff(l) ? ' diff' : l.qty_counted != null ? ' done' : ''}`;
          tr.lastElementChild.textContent = l.counted_by || '';
          const counted = t.lines.filter((x) => x.qty_counted != null).length;
          root.querySelector('.inv-head .progress').outerHTML = progress(counted, t.lines.length);
          const dEl = root.querySelector('#invDiffs'), diffs = t.lines.filter(isDiff).length;
          dEl.textContent = diffs; dEl.className = diffs ? 'err' : '';
        } catch (e) { fail(e); }
      };
      tr.querySelectorAll('input').forEach((inp) => {
        inp.addEventListener('change', save);
        inp.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const next = tr.nextElementSibling && tr.nextElementSibling.querySelector('[data-q]');
          if (next) next.focus(); else inp.blur();
        });
      });
    });
    root.querySelector('#close')?.addEventListener('click', async () => {
      const counted = t.lines.filter((l) => l.qty_counted != null).length, diffs = t.lines.filter(isDiff).length;
      if (!(await confirmBox('Закрыть задание и записать факт в остатки?', 'Закрыть и применить', false,
        `Посчитано ${counted} из ${t.lines.length} ячеек, расхождений ${diffs}. Непосчитанные ячейки не изменятся.`))) return;
      try { const r = await api(`/api/inventory/${t.id}/close`, { method: 'POST' }); toast(`Готово: изменено ячеек ${r.changed}, излишки +${r.plus}, недостача −${r.minus}`); bus.dispatchEvent(new Event('changed')); load(); } catch (e) { fail(e); }
    });
    root.querySelector('#cancel')?.addEventListener('click', async () => {
      if (!(await confirmBox('Отменить задание?', 'Отменить задание', true, 'Подсчёты сохранятся в истории, остатки не изменятся.'))) return;
      try { await api(`/api/inventory/${t.id}/cancel`, { method: 'POST' }); toast('Задание отменено'); load(); } catch (e) { fail(e); }
    });
  }
  async function load() { t = await api(`/api/inventory/${id}`); render(); }
  try { await load(); } catch (e) { root.innerHTML = `<div class="empty"><b>Задание не открылось</b>${esc(e.message)}</div>`; }
}
