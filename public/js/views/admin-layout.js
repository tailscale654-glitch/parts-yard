// Топология склада: зоны, ряды, стеллажи, ярусы, ячейки и их место на схеме.
import { api, esc, icon, toast, fail, confirmBox, pageHead, debounce, fmt, bus } from '../core.js';

const RS = 34, RH = 16;
const COLS = [
  ['id', 'Код', 'text', 48], ['title', 'Название', 'text', 96], ['sub', 'Описание', 'text', 150],
  ['rows', 'Рядов', 'number', 0], ['racks', 'Стеллажей', 'number', 0], ['tiers', 'Ярусов', 'number', 0], ['cells', 'Ячеек/ярус', 'number', 0],
  ['rw', 'Ширина', 'number', 0], ['x', 'X', 'number', 0], ['y', 'Y', 'number', 0],
];

export async function mount(root) {
  let zones = [], source = 'file', stats = [], check = null;
  root.innerHTML = `${pageHead('Топология склада', 'Зоны, ряды, стеллажи, ярусы и ячейки. Новые ячейки появятся сразу; ячейки с товаром удалить нельзя, пока их не освободят.',
    '<button class="btn" id="reset">Вернуть из layout.json</button><button class="btn" id="check">Проверить</button><button class="btn pri" id="save">Сохранить</button>')}
    <div class="card"><div class="ch"><h2>Зоны</h2><div class="row"><span class="note" id="src"></span><button class="btn sm" id="addz">${icon('plus')}Зона</button></div></div>
      <div class="tw"><table class="t zone-table" id="zt"></table></div></div>
    <div class="grid2" style="align-items:start">
      <div class="card"><div class="ch"><h2>Схема</h2><span class="note">Поле 940 × 580; приёмка и отгрузка внизу (y ≥ 460)</span></div><div class="cb"><svg class="map" id="prev" viewBox="0 0 940 580" role="img" aria-label="Предпросмотр схемы"></svg></div></div>
      <div class="card"><div class="ch"><h2>Что изменится</h2></div><div class="cb" id="impact"><p class="note">Нажмите «Проверить», чтобы увидеть, сколько ячеек добавится и удалится.</p></div></div>
    </div>`;

  function table() {
    root.querySelector('#src').textContent = source === 'database' ? 'Изменена в админке' : 'Из файла layout.json';
    root.querySelector('#zt').innerHTML = `<thead><tr>${COLS.map(([, l]) => `<th>${l}</th>`).join('')}<th>Заполнять</th><th class="r">Ячеек</th><th class="r">С товаром</th><th></th></tr></thead>
      <tbody>${zones.map((z, i) => {
        const st = stats.find((s) => s.id === z.id);
        return `<tr data-i="${i}">${COLS.map(([k, , t, w]) => `<td><input class="in${t === 'number' ? ' mono' : ''}" data-k="${k}" type="${t}" value="${esc(z[k] ?? '')}" ${w ? `style="width:${w}px"` : ''} aria-label="${k}"></td>`).join('')}
          <td><select class="in" data-k="prefer"><option value="low" ${z.prefer !== 'middle' ? 'selected' : ''}>снизу</option><option value="middle" ${z.prefer === 'middle' ? 'selected' : ''}>с середины</option></select></td>
          <td class="r mono">${fmt(z.rows * z.racks * z.tiers * z.cells || 0)}</td><td class="r mono">${st ? fmt(st.stocked) : '—'}</td>
          <td><button class="btn ghost sm danger" data-rm="${i}" aria-label="Удалить зону">${icon('trash')}</button></td></tr>`;
      }).join('')}</tbody>`;
  }
  function preview() {
    let s = '<rect class="floor" x="10" y="10" width="920" height="560" rx="6"/><rect class="dock" x="40" y="462" width="360" height="46" rx="4"/><rect class="dock" x="540" y="462" width="352" height="46" rx="4"/>';
    for (const z of zones) {
      const n = (k) => Number(z[k]) || 0;
      if (!n('rows') || !n('racks')) continue;
      const w = n('racks') * (n('rw') + 2) - 2, hh = (n('rows') - 1) * RS + RH + 18;
      s += `<rect class="zoneframe" x="${n('x') - 12}" y="${n('y') - 8}" width="${w + 24}" height="${hh + 8}" rx="4"/><text class="zlabel" x="${n('x') - 12}" y="${n('y') - 14}">${esc(z.id)} · ${esc(z.title || '')}</text>`;
      for (let r = 0; r < Math.min(n('rows'), 40); r++) for (let k = 0; k < Math.min(n('racks'), 60); k++) {
        s += `<rect class="rk f1" x="${n('x') + k * (n('rw') + 2)}" y="${n('y') + r * RS}" width="${n('rw')}" height="${RH}" rx="2"/>`;
      }
    }
    root.querySelector('#prev').innerHTML = s;
  }
  const clean = () => zones.map((z) => ({ ...z, id: String(z.id || '').toUpperCase(), ...Object.fromEntries(['rows', 'racks', 'tiers', 'cells', 'rw', 'x', 'y'].map((k) => [k, Number(z[k])])) }));
  async function runCheck() {
    try {
      check = await api('/api/admin/layout/preview', { method: 'POST', body: { zones: clean() } });
      const i = check.impact;
      root.querySelector('#impact').innerHTML = `<dl class="kv"><dt>Ячеек станет</dt><dd class="mono">${fmt(i.cells)}</dd><dt>Добавится</dt><dd class="mono">${fmt(i.added)}</dd><dt>Удалится</dt><dd class="mono">${fmt(i.removed)}</dd>
        <dt>С товаром среди удаляемых</dt><dd class="mono ${i.lostCount ? 'err' : ''}">${fmt(i.lostCount)}</dd></dl>
        ${i.lostCount ? `<p class="err" style="font-size:13px">Сохранить нельзя: в удаляемых ячейках есть товар или блокировка (${i.lost.map((x) => esc(x.addr)).join(', ')}${i.lostCount > i.lost.length ? '…' : ''}).</p>` : ''}
        ${i.skuZones.length ? `<p class="err" style="font-size:13px">В каталоге есть артикулы зон ${esc(i.skuZones.join(', '))}, которых не будет.</p>` : ''}
        ${check.warnings.map((w) => `<p class="warnbox">${esc(w)}</p>`).join('')}
        ${!i.lostCount && !i.skuZones.length ? '<p class="note">Можно сохранять.</p>' : ''}`;
    } catch (e) { root.querySelector('#impact').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  }
  const autoCheck = debounce(runCheck, 500);
  root.querySelector('#zt').addEventListener('input', (e) => {
    const tr = e.target.closest('tr[data-i]'); if (!tr) return;
    zones[+tr.dataset.i][e.target.dataset.k] = e.target.value;
    preview(); autoCheck();
  });
  root.querySelector('#zt').addEventListener('change', (e) => { if (e.target.tagName === 'INPUT' && e.target.type === 'number') table(); });
  root.querySelector('#zt').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]'); if (!b) return;
    zones.splice(+b.dataset.rm, 1); table(); preview(); autoCheck();
  });
  root.querySelector('#addz').onclick = () => {
    const used = new Set(zones.map((z) => z.id));
    const id = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('').find((c) => !used.has(c)) || 'Z1';
    zones.push({ id, title: `Зона ${id}`, sub: '', rows: 2, racks: 6, tiers: 4, cells: 3, rw: 28, x: 40, y: 380, prefer: 'low' });
    table(); preview(); autoCheck();
  };
  root.querySelector('#check').onclick = runCheck;
  root.querySelector('#save').onclick = async () => {
    await runCheck();
    if (!check || check.impact.lostCount) return;
    if (check.impact.removed && !(await confirmBox(`Удалить ${check.impact.removed} пустых ячеек?`, 'Сохранить', true, 'Ячейки без товара исчезнут со схемы и из справочника адресов.'))) return;
    try { const r = await api('/api/admin/layout', { method: 'PUT', body: { zones: clean() } }); toast(`Топология сохранена: ${fmt(r.cells)} ячеек`); bus.dispatchEvent(new Event('changed')); load(); } catch (e) { fail(e); }
  };
  root.querySelector('#reset').onclick = async () => {
    if (!(await confirmBox('Вернуть топологию из файла layout.json?', 'Вернуть', true, 'Изменения, сделанные в админке, будут заменены содержимым файла на сервере.'))) return;
    try { await api('/api/admin/layout/reset', { method: 'POST' }); toast('Топология взята из layout.json'); bus.dispatchEvent(new Event('changed')); load(); } catch (e) { fail(e); }
  };
  async function load() {
    const r = await api('/api/admin/layout');
    zones = r.zones.map((z) => ({ ...z })); source = r.source; stats = r.stats;
    table(); preview();
    root.querySelector('#impact').innerHTML = '<p class="note">Нажмите «Проверить», чтобы увидеть, сколько ячеек добавится и удалится.</p>';
  }
  await load();
}
