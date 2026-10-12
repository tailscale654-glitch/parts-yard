// Поставки: список документов, создание, удаление, переход к размещению на карте.
import { api, esc, can, icon, toast, fail, modal, confirmBox, table, progress, pageHead, fmtTs, bus, debounce, statusPill } from '../core.js';
import { docForm } from './docform.js';

export async function mount(root) {
  let state = 'open', q = '', docs = [];
  root.innerHTML = `${pageHead('Поставки', 'Документы приёмки. Откройте поставку на карте склада, чтобы разместить товар по предложенным адресам.',
    can('docs.receipts') ? `<button class="btn pri" id="new">${icon('plus')}Новая поставка</button>` : '')}
    <div class="filters"><div class="seg" id="seg"><button type="button" data-s="open" aria-pressed="true">Ожидают</button><button type="button" data-s="done" aria-pressed="false">Размещены</button><button type="button" data-s="all" aria-pressed="false">Все</button></div>
      <label class="field" style="min-width:240px"><span>Поиск</span><input class="in" id="q" type="search" placeholder="Номер или артикул"></label></div>
    <div class="card"><div class="tw" id="tbl"></div></div>`;
  const status = (d) => (!d.open ? 'размещено' : d.placed ? 'частично' : 'ожидает');

  function draw() {
    const list = docs.filter((d) => !q || d.doc.toLowerCase().includes(q) || d.lines.some((l) => l.art.toLowerCase().includes(q) || (l.name || '').toLowerCase().includes(q)));
    table(root.querySelector('#tbl'), {
      columns: [{ key: 'doc', label: 'Поставка', mono: true }, { key: 'gate', label: 'Ворота' }, { key: 'created', label: 'Создана' },
        { key: 'lines', label: 'Строк', align: 'r' }, { key: 'qty', label: 'Штук', align: 'r' }, { key: 'progress', label: 'Размещено' },
        { key: 'status', label: 'Статус' }, { key: 'act', label: '' }],
      rows: list.map((d) => ({ ...d, lines: d.lines.length, _lines: d.lines, created: d.created, status: status(d) })),
      empty: state === 'open' ? 'Все поставки размещены' : 'Поставок нет',
      render: {
        created: (v) => `<span class="mono">${fmtTs(v)}</span>`,
        progress: (v, r) => progress(r.placed, r.qty),
        status: (v) => statusPill(v),
        act: (v, r) => `<div class="row" style="justify-content:flex-end;flex-wrap:nowrap">${r.open ? `<a class="btn sm" href="#/map?receipt=${r._lines.find((l) => !l.done).id}">Разместить</a>` : ''}${can('docs.receipts') && !r.placed ? `<button class="btn sm ghost danger" data-del="${esc(r.doc)}" aria-label="Удалить">${icon('trash')}</button>` : ''}</div>`,
      },
      onRow: (r) => details(r),
    });
    root.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!(await confirmBox(`Удалить поставку ${b.dataset.del}?`, 'Удалить', true, 'Удалить можно, пока ничего не размещено.'))) return;
      try { await api('/api/receipts/doc/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' }); toast('Поставка удалена'); bus.dispatchEvent(new Event('changed')); load(); } catch (e) { fail(e); }
    });
  }
  function details(d) {
    const body = document.createElement('div');
    body.className = 'tw';
    table(body, {
      columns: [{ key: 'art', label: 'Артикул', mono: true }, { key: 'name', label: 'Наименование' }, { key: 'zone', label: 'Зона' },
        { key: 'qty', label: 'Ожидалось', align: 'r' }, { key: 'placed', label: 'Размещено', align: 'r' }, { key: 'go', label: '' }],
      rows: d._lines,
      render: { go: (v, l) => (!l.done ? `<a class="btn sm" href="#/map?receipt=${l.id}">На карте</a>` : statusPill('размещено')) },
    });
    const m = modal({ title: `Поставка ${d.doc}`, sub: `Ворота ${esc(d.gate || '—')} · создана ${fmtTs(d.created)}`, wide: true, body, actions: [{ label: 'Закрыть' }] });
    body.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => m.close()));
  }
  async function load() {
    try { docs = (await api('/api/receipts?state=' + state)).docs; draw(); } catch (e) { fail(e); }
  }
  root.querySelector('#seg').onclick = (e) => {
    const b = e.target.closest('[data-s]'); if (!b) return;
    state = b.dataset.s;
    root.querySelectorAll('#seg button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    load();
  };
  root.querySelector('#q').oninput = debounce((e) => { q = e.target.value.trim().toLowerCase(); draw(); }, 150);
  const nb = root.querySelector('#new');
  if (nb) nb.onclick = () => docForm({ kind: 'receipt', onDone: () => { bus.dispatchEvent(new Event('changed')); load(); } }).catch(fail);
  const onRev = debounce(load, 500);
  bus.addEventListener('rev', onRev);
  await load();
  return () => bus.removeEventListener('rev', onRev);
}
