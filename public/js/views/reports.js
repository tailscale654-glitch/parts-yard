// Отчёты: фильтры, таблица с сортировкой и итогами, выгрузка в Excel (CSV).
import { api, esc, icon, fail, table, pageHead, today, debounce, fmt } from '../core.js';

export async function mount(root, { rest, params }) {
  const meta = await api('/api/reports');
  const reps = meta.reports;
  let cur = reps.find((r) => r.id === rest[0]) || reps[0];
  let f = { from: today(-6), to: today(), ...params };
  root.innerHTML = `${pageHead('Отчёты', 'Остатки, движение, документы, производительность и анализ. Любой отчёт выгружается в Excel.')}
    <div class="rep-layout"><nav class="card rep-list" id="list" aria-label="Список отчётов"></nav><section class="card" id="pane" style="min-width:0"></section></div>`;

  function list() {
    const groups = [...new Set(reps.map((r) => r.group))];
    root.querySelector('#list').innerHTML = groups.map((g) => `<div class="grp">${esc(g)}</div>${reps.filter((r) => r.group === g)
      .map((r) => `<button type="button" data-id="${r.id}" aria-current="${r.id === cur.id}">${esc(r.title)}</button>`).join('')}`).join('');
    root.querySelectorAll('#list [data-id]').forEach((b) => b.onclick = () => {
      cur = reps.find((r) => r.id === b.dataset.id);
      f = { from: f.from, to: f.to };
      list(); pane();
    });
  }
  const sel = (id, opts, val) => `<select class="in" id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(val || '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  function filtersHtml() {
    const out = [];
    for (const k of cur.filters) {
      if (k === 'period') {
        out.push(`<label class="field"><span>С</span><input class="in" type="date" id="f_from" value="${f.from}"></label>
          <label class="field"><span>По</span><input class="in" type="date" id="f_to" value="${f.to}"></label>
          <div class="field"><span>Быстро</span><div class="seg" id="quick"><button type="button" data-d="0">Сегодня</button><button type="button" data-d="6">7 дн.</button><button type="button" data-d="29">30 дн.</button><button type="button" data-d="m">Месяц</button></div></div>`);
      }
      if (k === 'zone') out.push(`<label class="field"><span>Зона</span>${sel('f_zone', [['', 'Все'], ...meta.zones.map((z) => [z.id, `${z.id} · ${z.sub || z.title}`])], f.zone)}</label>`);
      if (k === 'art') out.push(`<label class="field"><span>Артикул или название</span><input class="in" id="f_art" value="${esc(f.art || '')}"></label>`);
      if (k === 'dealer') out.push(`<label class="field"><span>Дилер</span><input class="in" id="f_dealer" value="${esc(f.dealer || '')}"></label>`);
      if (k === 'user') out.push(`<label class="field"><span>Сотрудник</span>${sel('f_user', [['', 'Все'], ...meta.users.map((u) => [u.username, u.full_name ? `${u.full_name} (${u.username})` : u.username])], f.user)}</label>`);
      if (k === 'kind') out.push(`<label class="field"><span>Операция</span>${sel('f_kind', [['', 'Все'], ...Object.entries(meta.kinds)], f.kind)}</label>`);
      if (k === 'state') out.push(`<label class="field"><span>Состояние</span>${sel('f_state', [['', 'Все'], ['open', 'В работе'], ['done', 'Закрытые']], f.state)}</label>`);
      if (k === 'status') out.push(`<label class="field"><span>Показать</span>${sel('f_status', [['', 'Все артикулы'], ['low', 'Только проблемные']], f.status)}</label>`);
      if (k === 'only') out.push(`<label class="field"><span>Ячейки</span>${sel('f_only', [['', 'С товаром и блокировки'], ['all', 'Все, включая пустые']], f.only)}</label>`);
      if (k === 'task') out.push(`<label class="field"><span>Задание</span>${sel('f_task', [['', 'Все за период'], ...meta.tasks.map((t) => [t.id, `${t.name} · ${t.created.slice(0, 10)}`])], f.task)}</label>`);
    }
    return out.join('');
  }
  const qs = () => new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '' && v != null)).toString();
  function pane() {
    root.querySelector('#pane').innerHTML = `<div class="ch" style="flex-wrap:wrap;align-items:flex-start"><div><h2 style="text-transform:none;letter-spacing:0;font-size:16px;color:var(--ink)">${esc(cur.title)}</h2><p class="note" style="margin:3px 0 0">${esc(cur.description)}</p></div>
      <a class="btn" id="csv" href="#">${icon('download')}Скачать в Excel</a></div>
      <div class="cb" style="display:flex;flex-direction:column;gap:12px"><div class="filters" id="filters">${filtersHtml()}</div>
      <div class="note" id="count"></div><div class="tw rep-table" id="out"><p class="note">Строю отчёт…</p></div></div>`;
    const pn = root.querySelector('#pane');
    const read = () => {
      const g = (id) => { const el = pn.querySelector('#' + id); return el ? el.value.trim() : undefined; };
      const nf = { from: g('f_from') || f.from, to: g('f_to') || f.to };
      for (const k of ['zone', 'art', 'dealer', 'user', 'kind', 'state', 'status', 'only', 'task']) { const v = g('f_' + k); if (v) nf[k] = v; }
      f = nf; run();
    };
    pn.querySelectorAll('#filters select, #filters input[type=date]').forEach((x) => x.onchange = read);
    pn.querySelectorAll('#filters input:not([type=date])').forEach((x) => x.oninput = debounce(read, 400));
    const qk = pn.querySelector('#quick');
    if (qk) qk.onclick = (e) => {
      const b = e.target.closest('[data-d]'); if (!b) return;
      const d = b.dataset.d;
      pn.querySelector('#f_to').value = today();
      if (d === 'm') { const n = new Date(); pn.querySelector('#f_from').value = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-01`; } else pn.querySelector('#f_from').value = today(-Number(d));
      read();
    };
    run();
  }
  let seq = 0;
  async function run() {
    const my = ++seq;
    const q = qs();
    history.replaceState(null, '', `#/reports/${cur.id}${q ? '?' + q : ''}`);
    root.querySelector('#csv').href = `/api/reports/${cur.id}?${q}${q ? '&' : ''}format=csv`;
    try {
      const r = await api(`/api/reports/${cur.id}?${q}`);
      if (my !== seq) return;
      root.querySelector('#count').textContent = `Строк: ${fmt(r.total)}${r.truncated ? ` · на экране первые ${fmt(r.rows.length)}, в Excel выгрузятся все` : ''}`;
      table(root.querySelector('#out'), { columns: r.columns, rows: r.rows, totals: r.totals, empty: 'Нет данных за выбранный период' });
    } catch (e) { fail(e); }
  }
  list(); pane();
}
