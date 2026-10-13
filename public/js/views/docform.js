// Форма документа (поставка или заказ): строки «артикул — количество», вставка из Excel.
import { api, esc, h, toast, modal, parseCsv, pickFile, icon } from '../core.js';

let catalogCache = null;
export async function catalog(force) {
  if (!catalogCache || force) catalogCache = (await api('/api/catalog')).items;
  return catalogCache;
}

export async function docForm({ kind, onDone }) {
  const items = await catalog(true);
  const byArt = new Map(items.map((s) => [s.art, s]));
  const lines = [{ art: '', qty: '' }];
  const isOrder = kind === 'order';
  const body = h('<div style="display:flex;flex-direction:column;gap:12px"></div>');
  body.innerHTML = `<div class="grid3">
      <label class="field"><span>${isOrder ? 'Номер заказа' : 'Номер поставки'}</span><input class="in" id="fnum" maxlength="40" placeholder="${isOrder ? 'ЗК-24130' : 'ПТ-10413'}"></label>
      ${isOrder ? `<label class="field"><span>Дилер</span><input class="in" id="fdealer" maxlength="120" list="dealers" placeholder="Начните вводить название" autocomplete="off"><span class="hint" id="fdhint">Из справочника дилеров</span></label>
        <label class="field"><span>Срок сборки</span><input class="in" id="fdue" type="time"></label>`
    : `<label class="field"><span>Ворота</span><select class="in" id="fgate">${[1, 2, 3, 4, 5, 6].map((g) => `<option>${g}</option>`).join('')}</select></label><div></div>`}
    </div>
    <datalist id="arts">${items.map((s) => `<option value="${esc(s.art)}">${esc(s.name)}</option>`).join('')}</datalist>
    <div class="field"><span>Строки</span><div class="tw"><table class="t" id="flines"></table></div></div>
    <div class="row"><button class="btn sm" type="button" id="fadd">${icon('plus')}Строка</button>
      <button class="btn sm" type="button" id="fpaste">Вставить из Excel</button>
      <button class="btn sm" type="button" id="ffile">${icon('upload')}Из файла CSV</button>
      <span class="note" id="fsum"></span></div>
    <div id="fpastebox" hidden><label class="field"><span>Скопируйте из Excel два столбца — артикул и количество — и вставьте сюда</span>
      <textarea class="in" id="fpastetext" rows="6" placeholder="FO-15208	120&#10;BP-41060	40"></textarea></label>
      <div class="row" style="margin-top:6px"><button class="btn sm pri" type="button" id="fpasteok">Добавить строки</button></div></div>`;
  // дилеры из справочника: активные предлагаются в списке, новое имя заведёт своего дилера
  let dealers = [];
  const key = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"'`„“”]/g, '').replace(/\s+/g, ' ').trim();
  const findDealer = (v) => { const k = key(v); return k ? dealers.find((d) => key(d.name) === k) : null; };
  if (isOrder) {
    api('/api/dealers').then((r) => {
      dealers = r.dealers;
      const act = dealers.filter((d) => d.active);
      body.insertAdjacentHTML('beforeend', `<datalist id="dealers">${act.map((d) => `<option value="${esc(d.name)}">${esc([d.source === 'carsale' ? 'Carsale' : 'свой', d.region, d.code].filter(Boolean).join(' · '))}</option>`).join('')}</datalist>`);
      dealerHint();
    }).catch(() => {});
    const inp = body.querySelector('#fdealer');
    const dealerHint = () => {
      const el = body.querySelector('#fdhint'), v = inp.value.trim(), d = findDealer(v);
      el.classList.remove('err');
      if (!v) el.textContent = `Из справочника: ${dealers.filter((x) => x.active).length || ''} дилеров`;
      else if (d && !d.active) { el.textContent = d.source === 'carsale' ? 'Этого дилера больше нет в Carsale' : 'Дилер отключён в справочнике'; el.classList.add('err'); }
      else if (d) el.textContent = d.source === 'carsale' ? 'Дилер из Carsale' : 'Свой дилер из справочника';
      else el.textContent = 'Нового дилера добавим в справочник';
    };
    inp.addEventListener('input', dealerHint);
  }
  const tbl = body.querySelector('#flines');
  function paint() {
    tbl.innerHTML = `<thead><tr><th style="width:34%">Артикул</th><th>Наименование</th><th class="r" style="width:110px">Количество</th>${isOrder ? '<th class="r">На складе</th>' : '<th>Зона</th>'}<th></th></tr></thead><tbody>${lines.map((l, i) => {
      const s = byArt.get(l.art.trim());
      return `<tr data-i="${i}"><td><input class="in sm mono" data-f="art" list="arts" value="${esc(l.art)}" aria-label="Артикул, строка ${i + 1}"></td>
        <td class="${l.art && !s ? 'err' : ''}">${s ? esc(s.name) : l.art ? 'нет в каталоге' : ''}</td>
        <td class="r"><input class="in sm" data-f="qty" type="number" min="1" value="${esc(l.qty)}" style="width:96px;text-align:right" aria-label="Количество, строка ${i + 1}"></td>
        <td class="${isOrder ? 'r mono' : ''}${isOrder && s && Number(l.qty) > s.qty ? ' err' : ''}">${s ? (isOrder ? s.qty : esc(s.zone)) : ''}</td>
        <td><button class="btn ghost sm" type="button" data-del="${i}" aria-label="Удалить строку">${icon('trash')}</button></td></tr>`;
    }).join('')}</tbody>`;
    const ok = lines.filter((l) => byArt.has(l.art.trim()) && Number(l.qty) > 0);
    body.querySelector('#fsum').textContent = `Строк: ${ok.length} · штук: ${ok.reduce((n, l) => n + Number(l.qty), 0)}`;
  }
  tbl.addEventListener('change', (e) => {
    const tr = e.target.closest('tr[data-i]'); if (!tr) return;
    lines[+tr.dataset.i][e.target.dataset.f] = e.target.value;
    paint();
  });
  tbl.addEventListener('click', (e) => {
    const d = e.target.closest('[data-del]'); if (!d) return;
    lines.splice(+d.dataset.del, 1);
    if (!lines.length) lines.push({ art: '', qty: '' });
    paint();
  });
  function addRows(rows) {
    let n = 0;
    for (const r of rows) {
      if (r.length < 2 || !/^\d+$/.test(r[1])) continue;
      const empty = lines.findIndex((l) => !l.art && !l.qty);
      const row = { art: r[0], qty: r[1] };
      if (empty >= 0) lines[empty] = row; else lines.push(row);
      n++;
    }
    paint();
    toast(n ? `Добавлено строк: ${n}` : 'Не нашёл строк вида «артикул ; количество»', !n);
  }
  body.querySelector('#fadd').onclick = () => { lines.push({ art: '', qty: '' }); paint(); tbl.querySelector('tbody tr:last-child input').focus(); };
  body.querySelector('#fpaste').onclick = () => { const b = body.querySelector('#fpastebox'); b.hidden = !b.hidden; if (!b.hidden) body.querySelector('#fpastetext').focus(); };
  body.querySelector('#fpasteok').onclick = () => { addRows(parseCsv(body.querySelector('#fpastetext').value)); body.querySelector('#fpastetext').value = ''; body.querySelector('#fpastebox').hidden = true; };
  body.querySelector('#ffile').onclick = async () => { const f = await pickFile(); if (f) addRows(parseCsv(f.text)); };
  paint();

  modal({
    title: isOrder ? 'Новый заказ дилера' : 'Новая поставка', wide: true, body,
    sub: isOrder ? 'После сохранения заказ появится в отборе на карте склада.' : 'После сохранения строки появятся в приёмке на карте склада.',
    actions: [{ label: 'Отмена' }, {
      label: 'Сохранить', kind: 'pri', onClick: async () => {
        const clean = lines.filter((l) => l.art.trim() || l.qty).map((l) => ({ art: l.art.trim(), qty: Number(l.qty) }));
        const bad = clean.find((l) => !byArt.has(l.art));
        if (bad) { toast(`Артикула «${bad.art}» нет в каталоге`, true); return true; }
        const payload = isOrder
          ? (() => { const dv = body.querySelector('#fdealer').value.trim(), d = findDealer(dv);
            return { number: body.querySelector('#fnum').value.trim(), dealer: dv, dealer_id: d ? d.id : null, due: body.querySelector('#fdue').value, lines: clean }; })()
          : { doc: body.querySelector('#fnum').value.trim(), gate: body.querySelector('#fgate').value, lines: clean };
        await api(isOrder ? '/api/orders' : '/api/receipts', { method: 'POST', body: payload });
        toast(isOrder ? 'Заказ создан' : 'Поставка создана');
        onDone && onDone();
      },
    }],
  });
}
