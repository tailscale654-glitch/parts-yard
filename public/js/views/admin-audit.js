// Журнал аудита: входы, изменения пользователей, ролей, настроек, топологии, каталога.
import { api, esc, fail, table, pageHead, today, debounce } from '../core.js';

export async function mount(root) {
  let f = { from: today(-29), to: today(), q: '' };
  root.innerHTML = `${pageHead('Журнал аудита', 'Кто и когда входил в систему и что менял в настройках. Складские операции — в отчёте «Движение товара».')}
    <div class="filters"><label class="field"><span>С</span><input class="in" type="date" id="from" value="${f.from}"></label>
      <label class="field"><span>По</span><input class="in" type="date" id="to" value="${f.to}"></label>
      <label class="field" style="min-width:240px"><span>Поиск</span><input class="in" id="q" type="search" placeholder="Действие, логин, подробности"></label></div>
    <div class="card"><div class="tw rep-table" id="tbl"></div></div>`;
  const fmtDetails = (d) => {
    if (!d) return '';
    try { const o = JSON.parse(d); return Object.entries(o).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · '); } catch (e) { return d; }
  };
  async function load() {
    try {
      const qs = new URLSearchParams({ from: f.from, to: f.to, ...(f.q ? { q: f.q } : {}) });
      const r = await api('/api/admin/audit?' + qs);
      table(root.querySelector('#tbl'), {
        columns: [{ key: 'ts', label: 'Время', mono: true }, { key: 'user', label: 'Кто', mono: true }, { key: 'action', label: 'Действие' }, { key: 'details', label: 'Подробности' }],
        rows: r.rows.map((x) => ({ ...x, user: x.user || '—', details: fmtDetails(x.details) })),
        empty: 'Записей нет',
        render: { details: (v) => `<span class="note">${esc(v)}</span>` },
      });
    } catch (e) { fail(e); }
  }
  root.querySelector('#from').onchange = (e) => { f.from = e.target.value; load(); };
  root.querySelector('#to').onchange = (e) => { f.to = e.target.value; load(); };
  root.querySelector('#q').oninput = debounce((e) => { f.q = e.target.value.trim(); load(); }, 350);
  await load();
}
