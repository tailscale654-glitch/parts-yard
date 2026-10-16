// Заказы дилеров: список, создание, закрытие с недостачей, переход к отбору на карте.
import { api, esc, can, icon, toast, fail, modal, confirmBox, table, progress, pageHead, fmtTs, bus, debounce, statusPill } from '../core.js';
import { docForm } from './docform.js';

export async function mount(root, { params = {} } = {}) {
  let state = ['open', 'done', 'all'].includes(params.state) ? params.state : 'open', q = (params.q || '').trim().toLowerCase(), orders = [];
  root.innerHTML = `${pageHead('Заказы дилеров', 'Откройте заказ на карте склада: система построит маршрут отбора с минимумом точек.',
    can('docs.orders') ? `<button class="btn pri" id="new">${icon('plus')}Новый заказ</button>` : '')}
    <div class="filters"><div class="seg" id="seg">${[['open', 'В работе'], ['done', 'Закрытые'], ['all', 'Все']].map(([k, t]) => `<button type="button" data-s="${k}" aria-pressed="${k === state}">${t}</button>`).join('')}</div>
      <label class="field" style="min-width:240px"><span>Поиск</span><input class="in" id="q" type="search" placeholder="Номер, дилер или артикул" value="${esc(params.q || '')}"></label></div>
    <div class="card"><div class="tw" id="tbl"></div></div>`;
  const status = (o) => (o.done ? (o.picked >= o.total ? 'собран' : 'с недостачей') : o.picked ? 'собирается' : 'ожидает');
  const late = (o) => {
    if (o.done || !o.due) return false;
    const n = new Date(), hm = `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
    return o.due.padStart(5, '0') < hm;
  };

  function draw() {
    const list = orders.filter((o) => !q || o.number.toLowerCase().includes(q) || o.dealer.toLowerCase().includes(q) || o.lines.some((l) => l.art.toLowerCase().includes(q)));
    table(root.querySelector('#tbl'), {
      columns: [{ key: 'number', label: 'Заказ', mono: true }, { key: 'dealer', label: 'Дилер' }, { key: 'due', label: 'Срок' },
        { key: 'line_count', label: 'Строк', align: 'r' }, { key: 'progress', label: 'Собрано' }, { key: 'status', label: 'Статус' }, { key: 'act', label: '' }],
      rows: list.map((o) => ({ ...o, status: status(o) })),
      empty: state === 'open' ? 'Все заказы собраны' : 'Заказов нет',
      render: {
        dealer: (v, o) => `${esc(v)}${o.dealer_active === 0 ? ' <span class="note">неактивен в Carsale</span>' : ''}${o.dealer_code || o.dealer_region ? `<div class="note">${esc([o.dealer_code, o.dealer_region].filter(Boolean).join(' · '))}</div>` : ''}`,
        due: (v, o) => (v ? `<span class="${late(o) ? 'err' : ''}">${esc(v)}${late(o) ? ' · просрочен' : ''}</span>` : '<span class="muted">—</span>'),
        progress: (v, o) => progress(o.picked || 0, o.total || 0),
        status: (v) => statusPill(v),
        act: (v, o) => `<div class="row" style="justify-content:flex-end;flex-wrap:nowrap">${!o.done ? `<a class="btn sm" href="#/map?order=${o.id}">Собрать</a>` : ''}
          ${!o.done && can('docs.orders') && o.picked ? `<button class="btn sm" data-close="${o.id}">Закрыть</button>` : ''}
          ${!o.done && can('docs.orders') && !o.picked ? `<button class="btn sm ghost danger" data-del="${o.id}" aria-label="Удалить">${icon('trash')}</button>` : ''}</div>`,
      },
      onRow: (o) => details(o),
    });
    root.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      const o = orders.find((x) => x.id === +b.dataset.del);
      if (!(await confirmBox(`Удалить заказ ${o.number}?`, 'Удалить', true, 'Удалить можно, пока по заказу ничего не взято.'))) return;
      try { await api(`/api/orders/${o.id}`, { method: 'DELETE' }); toast('Заказ удалён'); bus.dispatchEvent(new Event('changed')); load(); } catch (e) { fail(e); }
    });
    root.querySelectorAll('[data-close]').forEach((b) => b.onclick = () => closeOrder(orders.find((x) => x.id === +b.dataset.close)));
  }
  async function closeOrder(o) {
    const short = o.lines.filter((l) => l.picked < l.qty).map((l) => `${l.art} — ${l.qty - l.picked} шт`);
    if (!(await confirmBox(`Закрыть заказ ${o.number}?`, 'Закрыть с недостачей', true, short.length ? `Недостача будет записана в журнал: ${esc(short.join(', '))}` : ''))) return;
    try { await api(`/api/orders/${o.id}/close`, { method: 'POST', opId: true }); toast('Заказ закрыт'); bus.dispatchEvent(new Event('changed')); load(); } catch (e) { fail(e); }
  }
  function details(o) {
    const body = document.createElement('div');
    body.className = 'tw';
    table(body, {
      columns: [{ key: 'art', label: 'Артикул', mono: true }, { key: 'name', label: 'Наименование' }, { key: 'qty', label: 'Заказано', align: 'r' },
        { key: 'picked', label: 'Взято', align: 'r' }, { key: 'stock', label: 'На складе', align: 'r' }],
      rows: o.lines,
      render: { stock: (v, l) => `<span class="${!o.done && v < l.qty - l.picked ? 'err' : ''}">${v}</span>` },
    });
    const acts = [{ label: 'Закрыть окно' }];
    if (!o.done) acts.push({ label: 'Собрать на карте', kind: 'pri', onClick: () => { location.hash = `#/map?order=${o.id}`; } });
    if (o.dealer_id) acts.unshift({ label: 'Карточка дилера', left: true, onClick: () => { location.hash = `#/dealers?open=${o.dealer_id}`; } });
    modal({ title: `Заказ ${o.number}`, sub: `${esc(o.dealer)} · создан ${fmtTs(o.created)}${o.due ? ' · срок ' + esc(o.due) : ''}`, wide: true, body, actions: acts });
  }
  async function load() {
    try { orders = (await api('/api/orders?state=' + state)).orders; draw(); } catch (e) { fail(e); }
  }
  root.querySelector('#seg').onclick = (e) => {
    const b = e.target.closest('[data-s]'); if (!b) return;
    state = b.dataset.s;
    root.querySelectorAll('#seg button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    load();
  };
  root.querySelector('#q').oninput = debounce((e) => { q = e.target.value.trim().toLowerCase(); draw(); }, 150);
  const nb = root.querySelector('#new');
  if (nb) nb.onclick = () => docForm({ kind: 'order', onDone: () => { bus.dispatchEvent(new Event('changed')); load(); } }).catch(fail);
  const onRev = debounce(load, 500);
  bus.addEventListener('rev', onRev);
  await load();
  return () => bus.removeEventListener('rev', onRev);
}
