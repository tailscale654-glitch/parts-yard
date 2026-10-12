// Дашборды и их конструктор.
import { api, esc, icon, h, toast, fail, modal, confirmBox, bus, debounce, pageHead } from '../core.js';
import { renderWidget, VIZ_LABEL } from '../charts.js';

const PERIOD_LABEL = { 1: 'Сегодня', 7: '7 дней', 14: '14 дней', 30: '30 дней', 90: '90 дней' };
const LS = 'wos.dashboard';

export async function mount(root, { rest }) {
  let dashes = [], canShare = false, cat = null, active = null, editing = null, results = [], timer = null;

  const lsGet = () => { try { return localStorage.getItem(LS); } catch (e) { return null; } };
  const lsSet = (v) => { try { localStorage.setItem(LS, v); } catch (e) { /* нет хранилища */ } };
  const metric = (id) => cat.metrics.find((m) => m.id === id);
  const wTitle = (w) => w.title || (metric(w.metric) ? metric(w.metric).title : w.metric);
  const paramNote = (w) => {
    const m = metric(w.metric); if (!m) return '';
    const parts = [];
    if (m.params.includes('days')) parts.push(PERIOD_LABEL[w.params?.days || 14]);
    if (m.params.includes('zone') && w.params?.zone) parts.push('зона ' + w.params.zone);
    return parts.join(' · ');
  };

  async function load() {
    const [d, m] = await Promise.all([api('/api/dashboards'), cat ? Promise.resolve(cat) : api('/api/metrics')]);
    dashes = d.dashboards; canShare = d.canShare; cat = m;
    const want = Number(rest[0]) || Number(lsGet());
    active = dashes.find((x) => x.id === want) || dashes[0] || null;
  }

  function header() {
    const d = editing || active;
    const tabs = dashes.map((x) => `<button class="tab" type="button" data-id="${x.id}" aria-selected="${active && x.id === active.id}">${esc(x.name)}${x.shared ? '<span class="shared">общий</span>' : ''}</button>`).join('');
    if (editing) {
      return `${pageHead('Конструктор дашборда', 'Добавляйте виджеты, меняйте ширину и порядок перетаскиванием. Изменения видны всем, у кого есть доступ к дашборду, после сохранения.',
        `<button class="btn" data-a="add">${icon('plus')}Добавить виджет</button><button class="btn" data-a="cancel">Отмена</button><button class="btn pri" data-a="save">Сохранить</button>`)}
        <div class="card"><div class="cb grid3">
          <label class="field"><span>Название</span><input class="in" id="dname" maxlength="60" value="${esc(d.name)}"></label>
          <div class="field"><span>Доступ</span><label class="check" style="min-height:36px"><input type="checkbox" id="dshared" ${d.shared ? 'checked' : ''} ${canShare ? '' : 'disabled'}>Общий — видят все сотрудники</label></div>
          <div class="field"><span>&nbsp;</span>${d.id ? '<button class="btn danger" data-a="delete" style="justify-self:start;width:max-content">' + icon('trash') + 'Удалить дашборд</button>' : ''}</div>
        </div></div>`;
    }
    const acts = [`<button class="btn" data-a="refresh">${icon('refresh')}Обновить</button>`];
    if (active && active.canEdit) acts.push(`<button class="btn" data-a="edit">${icon('edit')}Изменить</button>`);
    if (active && !active.canEdit) acts.push(`<button class="btn" data-a="copy">${icon('copy')}Копия для себя</button>`);
    acts.push(`<button class="btn pri" data-a="new">${icon('plus')}Новый дашборд</button>`);
    return `${pageHead('Дашборды', 'Сводка по складу в реальном времени. Соберите свой дашборд из готовых виджетов.', acts.join(''))}
      <div class="dash-tabs" role="tablist">${tabs}</div>`;
  }

  function grid() {
    const d = editing || active;
    if (!d) return '<div class="empty"><b>Дашбордов пока нет</b>Создайте первый — кнопка «Новый дашборд».</div>';
    if (!d.widgets.length) return `<div class="empty"><b>На дашборде нет виджетов</b>${editing ? 'Нажмите «Добавить виджет».' : 'Откройте конструктор, чтобы добавить.'}</div>`;
    return `<div class="wgrid">${d.widgets.map((w, i) => `<section class="w w${w.w}${editing ? ' editing' : ''}" data-i="${i}" ${editing ? 'draggable="true"' : ''}>
      <h3>${esc(wTitle(w))}${paramNote(w) ? ` <span style="text-transform:none;letter-spacing:0;font-weight:400">· ${esc(paramNote(w))}</span>` : ''}</h3>
      ${editing ? `<div class="wtools"><button type="button" data-t="narrow" title="Уже" aria-label="Сделать уже">${icon('narrower')}</button><button type="button" data-t="wide" title="Шире" aria-label="Сделать шире">${icon('wider')}</button><button type="button" data-t="left" title="Раньше" aria-label="Переместить раньше">${icon('left')}</button><button type="button" data-t="right" title="Позже" aria-label="Переместить позже">${icon('right')}</button><button type="button" data-t="edit" title="Настроить" aria-label="Настроить">${icon('edit')}</button><button type="button" data-t="del" title="Удалить" aria-label="Удалить">${icon('trash')}</button></div>` : ''}
      <div class="wbody"><p class="note">Загрузка…</p></div></section>`).join('')}</div>`;
  }

  function paintWidgets() {
    const d = editing || active;
    if (!d) return;
    root.querySelectorAll('.w').forEach((sec) => {
      const i = +sec.dataset.i, w = d.widgets[i];
      if (results[i]) renderWidget(sec.querySelector('.wbody'), results[i], w.viz);
    });
  }

  async function fetchData() {
    const d = editing || active;
    if (!d || !d.widgets.length) return;
    try {
      const r = await api('/api/metrics/batch', { method: 'POST', body: { items: d.widgets.map((w) => ({ metric: w.metric, params: w.params || {} })) } });
      results = r.results;
      paintWidgets();
    } catch (e) { if (e.status) fail(e); }
  }

  function render() {
    root.innerHTML = header() + grid();
    bind();
    if (results.length === (editing || active || { widgets: [] }).widgets.length) paintWidgets();
    fetchData();
  }

  function bind() {
    root.querySelectorAll('.dash-tabs .tab').forEach((b) => b.onclick = () => {
      active = dashes.find((x) => x.id === +b.dataset.id);
      lsSet(String(active.id));
      history.replaceState(null, '', `#/dashboard/${active.id}`);
      results = [];
      render();
    });
    root.querySelectorAll('[data-a]').forEach((b) => b.onclick = () => action(b.dataset.a));
    if (!editing) return;
    root.querySelector('#dname').oninput = (e) => { editing.name = e.target.value; };
    root.querySelector('#dshared').onchange = (e) => { editing.shared = e.target.checked ? 1 : 0; };
    root.querySelectorAll('.w').forEach((sec) => {
      const i = +sec.dataset.i;
      sec.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => tool(i, b.dataset.t));
      sec.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; });
      sec.addEventListener('dragover', (e) => { e.preventDefault(); sec.classList.add('drag-over'); });
      sec.addEventListener('dragleave', () => sec.classList.remove('drag-over'));
      sec.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = +e.dataTransfer.getData('text/plain');
        if (Number.isNaN(from) || from === i) return;
        const [w] = editing.widgets.splice(from, 1);
        const [r] = results.splice(from, 1);
        editing.widgets.splice(i, 0, w);
        results.splice(i, 0, r);
        render();
      });
    });
  }

  function tool(i, t) {
    const ws = editing.widgets;
    const swap = (a, b) => { [ws[a], ws[b]] = [ws[b], ws[a]]; [results[a], results[b]] = [results[b], results[a]]; };
    if (t === 'narrow') ws[i].w = Math.max(1, ws[i].w - 1);
    if (t === 'wide') ws[i].w = Math.min(4, ws[i].w + 1);
    if (t === 'left' && i > 0) swap(i, i - 1);
    if (t === 'right' && i < ws.length - 1) swap(i, i + 1);
    if (t === 'del') { ws.splice(i, 1); results.splice(i, 1); }
    if (t === 'edit') return widgetDialog(ws[i], (nw) => { ws[i] = nw; results[i] = null; render(); });
    render();
  }

  async function action(a) {
    if (a === 'refresh') return fetchData();
    if (a === 'new') {
      editing = { id: null, name: 'Новый дашборд', shared: 0, widgets: [] };
      results = [];
      return render();
    }
    if (a === 'edit') { editing = JSON.parse(JSON.stringify(active)); return render(); }
    if (a === 'copy') {
      try {
        const r = await api('/api/dashboards', { method: 'POST', body: { name: active.name + ' (моя копия)', widgets: active.widgets } });
        toast('Копия создана — теперь её можно менять');
        await load(); active = dashes.find((x) => x.id === r.id) || active; lsSet(String(active.id)); results = []; render();
      } catch (e) { fail(e); }
      return;
    }
    if (a === 'add') return widgetDialog(null, (nw) => { editing.widgets.push(nw); results.push(null); render(); });
    if (a === 'cancel') { editing = null; results = []; return render(); }
    if (a === 'delete') {
      if (!(await confirmBox(`Удалить дашборд «${editing.name}»?`, 'Удалить', true, 'Виджеты будут удалены. Данные склада не затрагиваются.'))) return;
      try { await api(`/api/dashboards/${editing.id}`, { method: 'DELETE' }); toast('Дашборд удалён'); editing = null; await load(); results = []; render(); } catch (e) { fail(e); }
      return;
    }
    if (a === 'save') {
      const body = { name: editing.name, shared: !!editing.shared, widgets: editing.widgets };
      try {
        let id = editing.id;
        if (id) await api(`/api/dashboards/${id}`, { method: 'PUT', body });
        else id = (await api('/api/dashboards', { method: 'POST', body })).id;
        toast('Дашборд сохранён');
        editing = null;
        await load();
        active = dashes.find((x) => x.id === id) || active;
        lsSet(String(active.id));
        history.replaceState(null, '', `#/dashboard/${active.id}`);
        results = [];
        render();
      } catch (e) { fail(e); }
    }
  }

  function widgetDialog(w, done) {
    const st = w ? JSON.parse(JSON.stringify(w)) : { metric: null, viz: null, w: 1, params: {} };
    const groups = [...new Set(cat.metrics.map((m) => m.group))];
    const SHAPE = { scalar: 'число', series: 'по дням', category: 'сравнение', rows: 'список' };
    const body = h('<div style="display:flex;flex-direction:column;gap:12px"></div>');
    let previewSeq = 0;
    function paint() {
      const m = st.metric && metric(st.metric);
      body.innerHTML = `<div class="field"><span>Что показать</span><div class="metric-pick">${groups.map((g) => `<h4>${esc(g)}</h4>${cat.metrics.filter((x) => x.group === g)
        .map((x) => `<button type="button" data-m="${x.id}" aria-pressed="${st.metric === x.id}">${esc(x.title)}<small>${SHAPE[x.shape]}</small></button>`).join('')}`).join('')}</div></div>
        ${m ? `<div class="grid2">
          <div class="field"><span>Вид</span><div class="seg">${m.viz.map((v) => `<button type="button" data-v="${v}" aria-pressed="${st.viz === v}">${VIZ_LABEL[v]}</button>`).join('')}</div></div>
          <div class="field"><span>Ширина</span><div class="seg">${[1, 2, 3, 4].map((n) => `<button type="button" data-w="${n}" aria-pressed="${st.w === n}">${n}/4</button>`).join('')}</div></div>
          ${m.params.includes('days') ? `<label class="field"><span>Период</span><select class="in" id="wdays">${cat.periods.map((p) => `<option value="${p}" ${Number(st.params.days || 14) === p ? 'selected' : ''}>${PERIOD_LABEL[p]}</option>`).join('')}</select></label>` : ''}
          ${m.params.includes('zone') ? `<label class="field"><span>Зона</span><select class="in" id="wzone"><option value="">Весь склад</option>${cat.zones.map((z) => `<option value="${z.id}" ${st.params.zone === z.id ? 'selected' : ''}>${esc(z.id)} · ${esc(z.sub || z.title)}</option>`).join('')}</select></label>` : ''}
          ${m.params.includes('limit') ? `<label class="field"><span>Сколько строк</span><input class="in" id="wlimit" type="number" min="1" max="50" value="${st.params.limit || 8}"></label>` : ''}
          <label class="field"><span>Свой заголовок</span><input class="in" id="wtitle" maxlength="60" placeholder="${esc(m.title)}" value="${esc(st.title || '')}"></label>
        </div>
        <div class="field"><span>Предпросмотр</span><div class="w" style="border-style:dashed"><div class="wbody" id="wprev"><p class="note">Загрузка…</p></div></div></div>` : '<p class="note">Выберите метрику, чтобы настроить вид.</p>'}`;
      body.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => {
        const nm = metric(b.dataset.m);
        st.metric = nm.id; st.viz = nm.viz[0];
        st.w = nm.shape === 'scalar' ? 1 : 2;
        st.params = {};
        paint();
      });
      body.querySelectorAll('[data-v]').forEach((b) => b.onclick = () => { st.viz = b.dataset.v; paint(); });
      body.querySelectorAll('[data-w]').forEach((b) => b.onclick = () => { st.w = +b.dataset.w; paint(); });
      const sync = () => {
        const dd = body.querySelector('#wdays'), z = body.querySelector('#wzone'), l = body.querySelector('#wlimit'), t = body.querySelector('#wtitle');
        st.params = {};
        if (dd) st.params.days = +dd.value;
        if (z && z.value) st.params.zone = z.value;
        if (l) st.params.limit = Math.min(50, Math.max(1, +l.value || 8));
        st.title = t && t.value.trim() ? t.value.trim() : undefined;
      };
      body.querySelectorAll('#wdays,#wzone,#wlimit').forEach((x) => x.onchange = () => { sync(); preview(); });
      const t = body.querySelector('#wtitle'); if (t) t.oninput = sync;
      if (m) preview();
    }
    async function preview() {
      const seq = ++previewSeq, el = body.querySelector('#wprev');
      if (!el) return;
      try {
        const r = await api('/api/metrics/batch', { method: 'POST', body: { items: [{ metric: st.metric, params: st.params }] } });
        if (seq === previewSeq && el.isConnected) renderWidget(el, r.results[0], st.viz);
      } catch (e) { fail(e); }
    }
    paint();
    modal({
      title: w ? 'Настройка виджета' : 'Новый виджет', wide: true, body,
      actions: [{ label: 'Отмена' }, {
        label: w ? 'Применить' : 'Добавить', kind: 'pri', onClick: () => {
          if (!st.metric) { toast('Выберите метрику', true); return true; }
          const out = { metric: st.metric, viz: st.viz, w: st.w, params: st.params };
          if (st.title) out.title = st.title;
          done(out);
        },
      }],
    });
  }

  try { await load(); } catch (e) { root.innerHTML = `<div class="empty"><b>Не удалось загрузить</b>${esc(e.message)}</div>`; return; }
  render();
  const onRev = debounce(() => { if (!editing) fetchData(); }, 600);
  const onResize = debounce(paintWidgets, 200);
  bus.addEventListener('rev', onRev);
  window.addEventListener('resize', onResize);
  timer = setInterval(() => { if (!editing && document.visibilityState === 'visible') fetchData(); }, 60000);
  return () => { bus.removeEventListener('rev', onRev); window.removeEventListener('resize', onResize); clearInterval(timer); };
}
