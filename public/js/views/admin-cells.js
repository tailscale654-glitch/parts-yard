// Ячейки склада: загрузка из Excel (артикул → ячейка) и запись ячеек в Carsale.
import { api, esc, icon, toast, fail, confirmBox, pageHead, fmt, fmtTs, bus, table, parseCsv, S, can } from '../core.js';

function pickAnyFile() {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.xlsx,.csv,.txt'; inp.hidden = true;
    inp.onchange = () => { const f = inp.files[0]; inp.remove(); resolve(f || null); };
    document.body.appendChild(inp); inp.click();
  });
}
const readAs = (f, how) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Не удалось прочитать файл')); r[how](f); });

export async function mount(root) {
  let rows = null, pv = null, fileName = '', poll = null;
  const canCarsale = can('admin.settings');
  root.innerHTML = `${pageHead('Ячейки склада', 'Загрузите таблицу «артикул → ячейка»: WarehouseOS построит по ней топологию и закрепит ячейки за артикулами, а потом запишет ячейки в Carsale.')}
    <div class="card"><div class="ch"><h2>1. Файл с ячейками</h2><span class="note">Excel (.xlsx) или CSV: столбцы «Артикул», «Номенклатура», «Ячейка»</span></div>
      <div class="cb" style="display:flex;flex-direction:column;gap:12px">
        <div class="row"><button class="btn pri" id="pick">${icon('upload')}Выбрать файл</button><span class="note" id="fname">или вставьте столбцы из Excel ниже</span></div>
        <details><summary class="note">Вставить из Excel</summary><textarea class="in" id="paste" rows="5" placeholder="Артикул	Номенклатура	Ячейка&#10;1106100V6500	Топливный насос	B-01-02-01" style="margin-top:8px;width:100%"></textarea>
          <div class="row" style="margin-top:6px"><button class="btn sm" id="pasteok">Разобрать</button></div></details>
        <div id="pv"></div>
      </div></div>
    ${canCarsale ? `<div class="card"><div class="ch"><h2>2. Записать в Carsale</h2><span class="note">Запчасти → Справочники: «Справочник стеллажей/ячеек» и ячейка в карточке запчасти</span></div>
      <div class="cb" id="cs" style="display:flex;flex-direction:column;gap:12px"></div></div>` : ''}`;

  // ---------- шаг 1 ----------
  async function load(newRows, name) {
    rows = newRows; fileName = name || '';
    root.querySelector('#fname').textContent = name ? `${name} · строк ${rows.length}` : `строк ${rows.length}`;
    root.querySelector('#pv').innerHTML = '<div class="sk" style="height:120px"></div>';
    try { pv = await api('/api/admin/cells/preview', { method: 'POST', body: { rows } }); drawPreview(); } catch (e) { root.querySelector('#pv').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  }
  function drawPreview() {
    const s = pv.stats, imp = pv.impact || { lostCount: 0 };
    const el = root.querySelector('#pv');
    el.innerHTML = `<div class="mkpis">
        <div class="mkpi"><b>${fmt(s.ok)}</b><span>артикулов с ячейкой</span></div>
        <div class="mkpi"><b>${fmt(s.cells)}</b><span>ячеек в файле</span></div>
        <div class="mkpi"><b>${fmt(pv.zones.length)}</b><span>зон</span></div>
        <div class="mkpi"><b>${fmt(s.newSkus)}</b><span>новых в каталоге</span></div>
        <div class="mkpi"><b class="${s.problems ? 'err' : ''}">${fmt(s.problems)}</b><span>строк с ошибкой</span></div></div>
      <div class="grid2" style="align-items:start">
        <div><h3 class="note" style="margin:4px 0">Топология по файлу</h3><div class="tw" id="pz"></div>
          <p class="note">Ярусов и ячеек взято по максимуму из файла. Если на складе их больше — поправьте в разделе «Топология» после загрузки.</p></div>
        <div><h3 class="note" style="margin:4px 0">Примеры</h3><div class="tw" id="ps"></div></div></div>
      ${pv.problems.length ? `<div><h3 class="note" style="margin:4px 0">Строки с ошибкой — не загрузятся, исправьте в файле</h3><div class="tw" id="pp"></div></div>` : ''}
      ${s.shared ? `<p class="note">${fmt(s.shared)} ячеек закреплены сразу за несколькими артикулами — это допустимо.</p>` : ''}
      ${imp.lostCount ? `<div class="warnbox">Сейчас в ${fmt(imp.lostCount)} ячейках, которых не будет в новой топологии, лежит товар (${imp.lost.map((x) => esc(x.addr)).join(', ')}…).
        <label class="check" style="margin-top:6px"><input type="checkbox" id="clear">Освободить все ячейки — текущие остатки по ячейкам удалятся${S.demo ? ' (демо-данные)' : ''}</label></div>` : ''}
      <div class="row"><button class="btn pri" id="apply">Загрузить в WarehouseOS</button><span class="note">Топология склада заменится на построенную по файлу</span></div>`;
    table(el.querySelector('#pz'), {
      columns: [{ key: 'id', label: 'Зона', mono: true }, { key: 'range', label: 'Стеллажи' }, { key: 'tiers', label: 'Ярусов', align: 'r' }, { key: 'cells', label: 'Ячеек/ярус', align: 'r' }, { key: 'total', label: 'Всего ячеек', align: 'r' }],
      rows: pv.zones.map((z) => ({ ...z, id: z.title.replace(/^Зона /, ''), range: `${String(z.start).padStart(2, '0')}–${String(z.start + z.rows * z.racks - 1).padStart(2, '0')}`, total: z.rows * z.racks * z.tiers * z.cells })),
    });
    table(el.querySelector('#ps'), {
      columns: [{ key: 'art', label: 'Артикул', mono: true }, { key: 'src', label: 'В файле', mono: true }, { key: 'cells', label: 'Ячейки' }],
      rows: pv.sample.map((x) => ({ ...x, cells: x.cells.join(', ') })),
      render: { cells: (v) => `<span class="mono">${esc(v)}</span>` },
    });
    if (pv.problems.length) {
      table(el.querySelector('#pp'), {
        columns: [{ key: 'line', label: 'Строка', align: 'r' }, { key: 'art', label: 'Артикул', mono: true }, { key: 'cell', label: 'Ячейка', mono: true }, { key: 'error', label: 'Что не так' }],
        rows: pv.problems,
      });
    }
    el.querySelector('#apply').onclick = apply;
  }
  async function apply() {
    const clear = root.querySelector('#clear')?.checked || false;
    if (pv.impact && pv.impact.lostCount && !clear) { toast('Отметьте «Освободить все ячейки» или сначала освободите их', true); return; }
    if (!(await confirmBox(`Загрузить ${fmt(pv.stats.ok)} артикулов и ${fmt(pv.zones.length)} зон?`, 'Загрузить', !!clear,
      `Топология склада заменится на построенную по файлу${clear ? ', все ячейки будут освобождены' : ''}. Закреплённые ячейки артикулов обновятся.`))) return;
    try {
      const r = await api('/api/admin/cells/apply', { method: 'POST', body: { rows, clearCells: clear, confirmClear: clear } });
      toast(`Готово: ${fmt(r.cells)} ячеек, ${fmt(r.skus)} артикулов (${fmt(r.added)} новых)`);
      bus.dispatchEvent(new Event('changed')); bus.dispatchEvent(new Event('layout'));
      root.querySelector('#pv').insertAdjacentHTML('afterbegin', `<div class="infobox">Загружено: ${fmt(r.zones)} зон, ${fmt(r.cells)} ячеек, ${fmt(r.skus)} артикулов с закреплёнными ячейками. <a href="#/map">Открыть карту</a></div>`);
      root.querySelector('#apply').disabled = true;
      if (canCarsale) drawCarsale();
    } catch (e) { fail(e); }
  }
  root.querySelector('#pick').onclick = async () => {
    const f = await pickAnyFile(); if (!f) return;
    try {
      if (/\.xlsx$/i.test(f.name)) {
        const data = await readAs(f, 'readAsDataURL');
        const r = await api('/api/admin/cells/read', { method: 'POST', body: { data } });
        await load(r.rows, f.name);
      } else {
        const text = await readAs(f, 'readAsText');
        await load(csvRows(text), f.name);
      }
    } catch (e) { fail(e); }
  };
  // CSV / вставка из Excel: ищем заголовки, иначе «артикул, название, ячейка» или 5 столбцов шаблона
  function csvRows(text) {
    const t = parseCsv(text);
    const head = t.findIndex((r) => r.some((x) => /артикул/i.test(x)) && r.some((x) => /ячейк/i.test(x)));
    if (head >= 0) {
      const h = t[head].map((x) => x.toLowerCase());
      const ai = h.findIndex((x) => /артикул/.test(x)), ci = h.findIndex((x) => /ячейк/.test(x));
      let ni = h.findIndex((x) => /номенклатура.*ru|наимен|назв/.test(x)); if (ni < 0) ni = h.findIndex((x) => /номенклатура/.test(x));
      return t.slice(head + 1).map((r) => ({ art: r[ai], name: ni >= 0 ? r[ni] : '', cell: r[ci] }));
    }
    return t.map((r) => (r.length >= 5 ? { art: r[1], name: r[2], cell: r[4] } : { art: r[0], name: r.length > 2 ? r[1] : '', cell: r[r.length - 1] }));
  }
  root.querySelector('#pasteok').onclick = () => { const v = root.querySelector('#paste').value; if (v.trim()) load(csvRows(v), 'из Excel').catch(fail); };

  // ---------- шаг 2: Carsale ----------
  let plan = null;
  async function drawCarsale() {
    const el = root.querySelector('#cs');
    if (!el) return;
    let st;
    try { st = await api('/api/integrations/carsale/cells/status'); } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    if (st.job && st.job.running) { showJob(st.job); return; }
    el.innerHTML = `<p class="note" style="margin:0">Сначала WarehouseOS только читает Carsale и показывает, что изменится. Запись — после вашего подтверждения.
        Для записи учётной записи Carsale из настроек сервера нужны права на справочники запчастей.</p>
      <div class="row"><button class="btn" id="plan">Показать, что изменится</button><label class="check"><input type="checkbox" id="bat" checked>Перенести и остатки на складе в эти ячейки</label></div>
      <div id="planbox"></div>${st.last.length ? `<div><h3 class="note" style="margin:4px 0">История записи</h3><div class="tw" id="hist"></div></div>` : ''}`;
    if (st.last.length) {
      table(el.querySelector('#hist'), {
        columns: [{ key: 'started', label: 'Когда' }, { key: 'user', label: 'Кто' }, { key: 'status', label: 'Итог', type: 'status' }, { key: 'res', label: 'Результат' }],
        rows: st.last.map((r) => ({ ...r, user: r.user || '', status: r.status === 'ok' ? 'применено' : r.status === 'partial' ? 'частично' : r.status === 'running' ? 'в работе' : 'с недостачей',
          res: r.stats ? `ячеек создано ${r.stats.racksCreated}, карточек ${r.stats.itemsUpdated}${r.stats.verified != null ? ` (проверено ${r.stats.verified})` : ''}, партий ${r.stats.batchesMoved}${r.stats.errors ? `, ошибок ${r.stats.errors}` : ''}` : (r.error || '') })),
        render: { started: (v) => fmtTs(v) },
      });
    }
    el.querySelector('#plan').onclick = () => makePlan();
  }
  async function makePlan(storeId) {
    const box = root.querySelector('#planbox'), bat = root.querySelector('#bat').checked;
    box.innerHTML = '<div class="sk" style="height:90px"></div>';
    try { plan = await api(`/api/integrations/carsale/cells/plan?batches=${bat ? 1 : 0}${storeId ? `&store=${encodeURIComponent(storeId)}` : ''}`); } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    const p = plan;
    box.innerHTML = `<label class="field" style="max-width:360px"><span>Склад Carsale</span><select class="in" id="store">${(p.stores.length ? p.stores : [p.store]).map((s) => `<option value="${esc(s.id)}" ${String(s.id) === String(p.store.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <div class="mkpis">
        <div class="mkpi"><b>${fmt(p.racks.create)}</b><span>ячеек создать (есть ${fmt(p.racks.existing)})</span></div>
        <div class="mkpi"><b>${fmt(p.items.update)}</b><span>карточек обновить (уже верно ${fmt(p.items.same)})</span></div>
        <div class="mkpi"><b class="${p.items.missing ? 'err' : ''}">${fmt(p.items.missing)}</b><span>артикулов нет в Carsale</span></div>
        ${p.batches.enabled ? `<div class="mkpi"><b>${fmt(p.batches.move)}</b><span>партий перенести · ${fmt(p.batches.units)} шт</span></div>` : ''}</div>
      ${p.items.missing ? `<p class="note">Нет в справочнике запчастей Carsale: <span class="mono">${p.items.missingSample.map(esc).join(', ')}${p.items.missing > p.items.missingSample.length ? '…' : ''}</span> — им ячейка в Carsale не запишется.</p>` : ''}
      ${p.items.sample.length ? `<div class="tw" id="psam"></div>` : ''}
      <div class="row"><button class="btn pri" id="go" ${p.racks.create + p.items.update + (p.batches.enabled ? p.batches.move : 0) ? '' : 'disabled'}>Записать в Carsale</button>
        <span class="note">${p.racks.create + p.items.update + p.batches.move ? 'Изменения сразу появятся в Carsale' : 'В Carsale уже всё как в WarehouseOS'}</span></div>`;
    if (p.items.sample.length) {
      table(box.querySelector('#psam'), {
        columns: [{ key: 'art', label: 'Артикул', mono: true }, { key: 'from', label: 'Сейчас в Carsale', mono: true }, { key: 'to', label: 'Станет', mono: true }],
        rows: p.items.sample.map((x) => ({ ...x, from: x.from || '—' })),
      });
    }
    box.querySelector('#store').onchange = (e) => makePlan(e.target.value);
    box.querySelector('#go').onclick = go;
  }
  async function go() {
    const p = plan, bat = root.querySelector('#bat').checked;
    const what = [p.racks.create && `создать ${fmt(p.racks.create)} ячеек`, p.items.update && `обновить ${fmt(p.items.update)} карточек запчастей`, bat && p.batches.move && `перенести ${fmt(p.batches.move)} партий (${fmt(p.batches.units)} шт)`].filter(Boolean).join(', ');
    if (!(await confirmBox('Записать ячейки в Carsale?', 'Записать', true, `На складе «${esc(p.store.name)}» будет: ${esc(what)}. Отменить одной кнопкой нельзя — только правкой в Carsale.`))) return;
    try {
      await api('/api/integrations/carsale/cells/apply', { method: 'POST', body: { confirm: true, storeId: p.store.id, racks: true, items: true, batches: bat } });
      watch();
    } catch (e) { fail(e); }
  }
  function showJob(j) {
    const el = root.querySelector('#cs');
    const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
    el.innerHTML = `<div class="row" style="justify-content:space-between"><b>${esc(j.step || 'Запись в Carsale')}</b><span class="mono note">${fmt(j.done)} из ${fmt(j.total || '…')}</span></div>
      <div class="progress"><div class="bar"><i style="width:${pct}%"></i></div><span class="mono note">${pct}%</span></div><p class="note" style="margin:0">Можно уйти со страницы — запись продолжится на сервере.</p>`;
  }
  function watch() {
    clearInterval(poll);
    const tick = async () => {
      let st; try { st = await api('/api/integrations/carsale/cells/status'); } catch (e) { return; }
      const j = st.job;
      if (j && j.running) { showJob(j); return; }
      clearInterval(poll); poll = null;
      if (j && j.error) toast(j.error, true);
      else if (j && j.result) {
        const s = j.result.stats;
        toast(`Carsale: ячеек создано ${s.racksCreated}, карточек ${s.itemsUpdated}, партий ${s.batchesMoved}${s.errors ? `, ошибок ${s.errors}` : ''}`, !!s.errors);
      }
      await drawCarsale();
      if (j && j.result && j.result.errors.length) root.querySelector('#cs').insertAdjacentHTML('afterbegin', `<div class="warnbox">Не получилось: ${j.result.errors.slice(0, 10).map(esc).join('; ')}${j.result.errors.length > 10 ? '…' : ''}</div>`);
    };
    tick(); poll = setInterval(tick, 2000);
  }

  if (canCarsale) {
    await drawCarsale();
    const st = await api('/api/integrations/carsale/cells/status').catch(() => null);
    if (st && st.job && st.job.running) watch();
  }
  return () => clearInterval(poll);
}
