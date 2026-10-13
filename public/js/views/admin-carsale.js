// Интеграция с Carsale: состояние, запуск, настройки, история синхронизаций.
import { api, esc, can, icon, toast, fail, table, pageHead, fmtTs, fmt, confirmBox, bus } from '../core.js';

const STATUSES = [[8, 'На складе'], [62, 'Бронь для заказа'], [81, 'Перемещение к дилеру'], [66, 'Брак']];
const TRIGGER = { auto: 'по расписанию', manual: 'вручную', console: 'из консоли' };
const STATUS_PILL = { ok: '<span class="pill ok">успешно</span>', partial: '<span class="pill wait">частично</span>', running: '<span class="pill wait">идёт</span>', error: '<span class="pill bad">ошибка</span>' };

function dealersText(d) {
  if (!d) return '';
  const ch = [d.added && `+${d.added}`, d.linked && `привязано ${d.linked}`, d.updated && `изм. ${d.updated}`, d.off && `откл. ${d.off}`, d.on && `вернулись ${d.on}`].filter(Boolean).join(', ');
  return `дилеров ${d.total}${ch ? ` (${ch})` : ''}`;
}
function resultText(r) {
  const s = r.stats, parts = [];
  if (s && s.added != null) parts.push(`новых ${s.added}, обновлено ${s.updated}, на складе ${fmt(s.units)} шт, бронь ${fmt(s.reserved)} шт`);
  if (s && s.dealers) parts.push(dealersText(s.dealers));
  if (s && s.ms != null) parts.push(`${(s.ms / 1000).toFixed(1)} с`);
  if (s && s.warnings && s.warnings.length) parts.push(s.warnings.join('; '));
  if (r.error) parts.push(r.error);
  return parts.join(' · ');
}

export async function mount(root) {
  let st = null, rec = null, zones = [];
  const isAdmin = can('admin.settings');

  async function load() {
    const [s, r, lay] = await Promise.all([api('/api/integrations/carsale'), api('/api/integrations/carsale/reconcile'), api('/api/layout')]);
    st = s; rec = r; zones = lay.zones;
    render();
  }

  function render() {
    const last = st.runs[0];
    const lastOk = st.runs.find((r) => r.status === 'ok');
    const sm = rec.summary;
    const acts = [];
    if (st.configured) acts.push(`<button class="btn pri" id="sync" ${st.running ? 'disabled' : ''}>${icon('refresh')}${st.running ? 'Синхронизация идёт…' : 'Синхронизировать сейчас'}</button>`);
    if (can('docs.receipts') && sm.unplacedUnits > 0) acts.push(`<button class="btn" id="mkdoc">${icon('inbound')}Поставка на неразмещённое</button>`);
    root.innerHTML = `${pageHead('Интеграция Carsale', 'Каталог запчастей и остатки центрального склада приходят из Carsale. Только чтение: WarehouseOS ничего не меняет в Carsale.', acts.join(''))}
      ${!st.configured ? `<div class="card"><div class="cb" style="display:flex;flex-direction:column;gap:10px">
        <b>Интеграция ещё не настроена</b>
        <p class="note" style="margin:0">Логин и пароль Carsale хранятся только на сервере, в файле настроек, и не попадают ни в браузер, ни в git. На сервере Debian выполните:</p>
        <pre class="infobox mono" style="margin:0;white-space:pre-wrap">sudo nano /etc/default/parts-yard
# добавьте или заполните строки:
CARSALE_LOGIN=логин
CARSALE_PASSWORD=пароль
# сохранить: Ctrl+O, Enter, выйти: Ctrl+X
sudo systemctl restart parts-yard
sudo parts-yard carsale-sync      # первая синхронизация с выводом результата</pre>
        <p class="note" style="margin:0">Лучше завести в Carsale отдельного пользователя только с просмотром запчастей.</p></div></div>` : ''}
      <div class="wgrid">
        <section class="w"><h3>Последняя синхронизация</h3><div class="kpiv${last && last.status === 'error' ? ' alert' : ''}"><div class="v" style="font-size:22px">${last ? fmtTs(last.started) : '—'}</div></div>
          <div class="kpis-sub">${last ? (last.status === 'ok' ? `успешно, ${TRIGGER[last.trigger] || ''}` : last.status === 'running' ? 'идёт сейчас' : `<span class="err">${last.status === 'partial' ? 'частично: ' : ''}${esc(last.error || 'ошибка')}</span>`) : 'ещё не было'}</div></section>
        <section class="w"><h3>Артикулов из Carsale</h3><div class="kpiv"><div class="v">${fmt(st.counts.skus)}</div></div><div class="kpis-sub">${fmt(st.counts.inStock || 0)} есть на центральном складе</div></section>
        <section class="w"><h3>Штук по Carsale</h3><div class="kpiv"><div class="v">${fmt(st.counts.units)}<small>шт</small></div></div><div class="kpis-sub">статусы: ${esc(st.settings.statusIds.map((id) => (STATUSES.find((s) => s[0] === id) || [0, id])[1]).join(', '))}</div></section>
        <section class="w"><h3>Не размещено по ячейкам</h3><div class="kpiv${sm.unplacedUnits ? ' alert' : ''}"><div class="v">${fmt(sm.unplacedUnits)}<small>шт</small></div></div>
          <div class="kpis-sub">${sm.unplacedSkus} артикулов · <a href="#/reports/carsale?status=low">сверка</a></div></section>
        <section class="w"><h3>Дилеров из Carsale</h3><div class="kpiv"><div class="v">${fmt(st.dealers.total)}</div></div>
          <div class="kpis-sub">${st.settings.dealers ? `${fmt(st.dealers.active)} активных · <a href="#/dealers">справочник</a>` : 'загрузка выключена'}</div></section>
      </div>
      <div class="grid2" style="align-items:start">
        <div class="card"><div class="ch"><h2>Подключение</h2></div><div class="cb">
          <dl class="kv"><dt>Сервер</dt><dd class="mono">${esc(st.base || '—')}</dd><dt>Пользователь</dt><dd class="mono">${esc(st.login || 'не задан')}</dd>
            <dt>Филиал</dt><dd class="mono">${esc(st.filial || 'определится при первой синхронизации')}</dd>
            <dt>Последняя удачная</dt><dd>${lastOk ? `${fmtTs(lastOk.started)} · ${fmt(lastOk.stats.directory)} в каталоге, ${fmt(lastOk.stats.stockRows)} строк остатков${lastOk.stats.dealers ? `, ${dealersText(lastOk.stats.dealers)}` : ''}, ${(lastOk.stats.ms / 1000).toFixed(1)} с` : '—'}</dd>
            <dt>Что берём</dt><dd>каталог (артикул, название, тип, цена, единица, модель, место), остатки выбранных статусов и справочник дилеров (ID и название). Заказы клиентов и персональные данные не загружаются.</dd></dl>
        </div></div>
        <div class="card"><div class="ch"><h2>Настройки</h2></div><div class="cb" style="display:flex;flex-direction:column;gap:12px" id="settings"></div></div>
      </div>
      <div class="card"><div class="ch"><h2>История</h2></div><div class="tw" id="runs"></div></div>`;
    settingsForm();
    table(root.querySelector('#runs'), {
      columns: [{ key: 'started', label: 'Начало', mono: true }, { key: 'trigger', label: 'Как' }, { key: 'user', label: 'Кто' }, { key: 'status', label: 'Итог' }, { key: 'result', label: 'Результат' }],
      rows: st.runs.map((r) => ({ ...r, trigger: TRIGGER[r.trigger] || r.trigger || '', user: r.user || '', result: resultText(r) })),
      render: { status: (v) => STATUS_PILL[v] || STATUS_PILL.error, started: (v) => fmtTs(v) },
      empty: 'Синхронизаций ещё не было',
    });
    root.querySelector('#sync')?.addEventListener('click', sync);
    root.querySelector('#mkdoc')?.addEventListener('click', makeReceipt);
  }

  function settingsForm() {
    const S = st.settings, el = root.querySelector('#settings');
    const dis = isAdmin ? '' : 'disabled';
    const types = st.types.length ? st.types : ['A', 'B', 'C', 'D', 'TOOLS'];
    el.innerHTML = `<label class="check"><input type="checkbox" id="sen" ${S.enabled ? 'checked' : ''} ${dis}>Синхронизировать автоматически</label>
      <label class="check"><input type="checkbox" id="sdl" ${S.dealers ? 'checked' : ''} ${dis}>Загружать и проверять справочник дилеров</label>
      <div class="grid2"><label class="field"><span>Каждые, минут</span><input class="in" id="sint" type="number" min="5" max="1440" value="${S.intervalMin}" ${dis}></label>
        <label class="field"><span>Вместимость ячейки для новых артикулов</span><input class="in" id="sper" type="number" min="1" value="${S.defaultPer}" ${dis}><span class="hint">Потом можно поправить в каталоге</span></label></div>
      <div class="field"><span>Какие остатки считать лежащими на складе</span><div class="row">${STATUSES.map(([id, n]) => `<label class="check"><input type="checkbox" class="sst" value="${id}" ${S.statusIds.includes(id) ? 'checked' : ''} ${dis}>${esc(n)}</label>`).join('')}</div></div>
      ${st.stores.length ? `<div class="field"><span>Склады Carsale</span><div class="row">${st.stores.map((s) => `<label class="check"><input type="checkbox" class="sstore" value="${s.id}" ${S.storeIds.includes(Number(s.id)) ? 'checked' : ''} ${dis}>${esc(s.name)}${s.active ? '' : ' <span class="note">(неактивный)</span>'}</label>`).join('')}</div><span class="hint">Ничего не отмечено — все склады филиала</span></div>` : ''}
      <div class="field"><span>Тип запчасти в Carsale → зона WarehouseOS</span><div class="grid3">${types.map((t) => `<label class="field"><span class="mono">${esc(t)}</span><select class="in szm" data-t="${esc(t)}" ${dis}>
        <option value="">${zones.some((z) => z.id === t) ? `авто (${esc(t)})` : 'по умолчанию'}</option>${zones.map((z) => `<option value="${z.id}" ${S.zoneMap[t] === z.id ? 'selected' : ''}>${esc(z.id)} · ${esc(z.sub || z.title)}</option>`).join('')}</select></label>`).join('')}</div>
        <span class="hint">Зону не меняем у артикулов, которые уже лежат в ячейках или которым зону поменяли вручную</span></div>
      <label class="field" style="max-width:280px"><span>Зона по умолчанию</span><select class="in" id="sdz" ${dis}>${zones.map((z) => `<option value="${z.id}" ${S.defaultZone === z.id ? 'selected' : ''}>${esc(z.id)} · ${esc(z.sub || z.title)}</option>`).join('')}</select></label>
      ${isAdmin ? '<div><button class="btn pri" id="ssave">Сохранить настройки</button></div>' : '<p class="note">Настройки меняет администратор.</p>'}`;
    el.querySelector('#ssave')?.addEventListener('click', async () => {
      const zoneMap = {};
      el.querySelectorAll('.szm').forEach((s) => { if (s.value) zoneMap[s.dataset.t] = s.value; });
      try {
        const r = await api('/api/integrations/carsale/settings', { method: 'PUT', body: {
          enabled: el.querySelector('#sen').checked, dealers: el.querySelector('#sdl').checked, intervalMin: Number(el.querySelector('#sint').value), defaultPer: Number(el.querySelector('#sper').value),
          statusIds: [...el.querySelectorAll('.sst:checked')].map((x) => Number(x.value)), storeIds: [...el.querySelectorAll('.sstore:checked')].map((x) => Number(x.value)),
          zoneMap, defaultZone: el.querySelector('#sdz').value } });
        st = r.status; toast('Настройки сохранены. Применятся при следующей синхронизации'); render();
      } catch (e) { fail(e); }
    });
  }

  async function sync() {
    const b = root.querySelector('#sync');
    b.disabled = true; b.lastChild.textContent = 'Синхронизация идёт…';
    try {
      const r = await api('/api/integrations/carsale/sync', { method: 'POST' });
      const s = r.stats;
      const parts = [s.added != null && `артикулов новых ${s.added}, обновлено ${s.updated}`, s.dealers && dealersText(s.dealers)].filter(Boolean);
      toast(`${r.partial ? 'Частично' : 'Готово'}: ${parts.join('; ')}${r.partial ? ` · ${r.error}` : ''}`, !!r.partial);
      bus.dispatchEvent(new Event('changed'));
    } catch (e) { fail(e); }
    await load();
  }

  async function makeReceipt() {
    const sm = rec.summary;
    if (!(await confirmBox(`Создать поставку на ${fmt(sm.unplacedUnits)} шт?`, 'Создать поставку', false,
      `${sm.unplacedSkus} артикулов числятся в Carsale на складе, но ещё не разложены по ячейкам. Поставка появится в приёмке на карте склада — система подберёт адреса.`))) return;
    try {
      const r = await api('/api/integrations/carsale/receipt', { method: 'POST' });
      toast(`Поставка ${r.doc}: ${r.lines} строк, ${fmt(r.units)} шт`);
      bus.dispatchEvent(new Event('changed'));
      location.hash = '#/receipts';
    } catch (e) { fail(e); }
  }

  try { await load(); } catch (e) { root.innerHTML = `<div class="empty"><b>Не удалось загрузить</b>${esc(e.message)}</div>`; }
  const onRev = () => { if (!document.activeElement || !root.contains(document.activeElement)) load().catch(() => {}); };
  bus.addEventListener('rev', onRev);
  return () => bus.removeEventListener('rev', onRev);
}
