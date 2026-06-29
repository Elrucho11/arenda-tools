/* =========================================================
   АрендаСтрой · Инструмент — логика приложения
   Локальное хранилище (localStorage). Готово к замене на API/CRM.
   ========================================================= */

(() => {
  'use strict';

  // ---------- Категории ----------
  // Берём из импортированного каталога (catalog-data.js), иначе — базовый набор.
  const CATEGORIES = (window.SEED_CATEGORIES && window.SEED_CATEGORIES.length)
    ? window.SEED_CATEGORIES.concat(['Прочее'])
    : [
      'Перфораторы и отбойники', 'Дрели и шуруповёрты', 'УШМ и резка',
      'Бетон и растворы', 'Сварка', 'Генераторы и компрессоры',
      'Измерительный', 'Сантехника', 'Прочее',
    ];

  const STATUS = {
    available:   { label: 'В наличии',  cls: 'available' },
    rented:      { label: 'В аренде',   cls: 'rented' },
    maintenance: { label: 'На ТО',      cls: 'maintenance' },
    broken:      { label: 'Неисправен', cls: 'broken' },
  };

  // ---------- Хранилище данных ----------
  const KEY = 'arenda-tools-v1';
  const store = {
    data: { tools: [] },
    load() {
      try { this.data = JSON.parse(localStorage.getItem(KEY)) || { tools: [] }; }
      catch { this.data = { tools: [] }; }
      if (!Array.isArray(this.data.tools)) this.data.tools = [];
    },
    save() { localStorage.setItem(KEY, JSON.stringify(this.data)); },
    tools() { return this.data.tools; },
    get(id) { return this.data.tools.find(t => t.id === id); },
    add(tool) { this.data.tools.unshift(tool); this.save(); },
    update(id, patch) {
      const t = this.get(id); if (!t) return;
      Object.assign(t, patch); this.save();
    },
    remove(id) { this.data.tools = this.data.tools.filter(t => t.id !== id); this.save(); },
  };

  // ---------- Утилиты ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const uid = () => 'T' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
  const rid = () => Math.random().toString(36).slice(2, 9);
  const nowISO = () => new Date().toISOString();
  const todayInput = () => new Date().toISOString().slice(0, 10);

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  // Подпись цены: число → «N ₽/сут», иначе текстовая цена (priceText), иначе «—»
  function priceLabel(t) {
    if (t.dailyPrice) return esc(t.dailyPrice) + ' ₽/сут';
    if (t.priceText) return esc(t.priceText);
    return '—';
  }

  function toast(msg, type = 'ok') {
    const wrap = $('#toastWrap');
    const t = el(`<div class="toast toast--${type}">${esc(msg)}</div>`);
    wrap.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, 2600);
  }

  // ---------- Модальные окна ----------
  const modal = {
    open(html, wide = false) {
      const m = $('#modal'); const box = m.querySelector('.modal');
      box.classList.toggle('modal--wide', wide);
      $('#modalBody').innerHTML = '';
      $('#modalBody').appendChild(typeof html === 'string' ? el(`<div>${html}</div>`) : html);
      m.hidden = false;
      return $('#modalBody');
    },
    close() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; if (window._scanner) stopScanner(); },
  };
  $('#modalClose').addEventListener('click', () => modal.close());
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') modal.close(); });

  // =========================================================
  //  РОУТЕР
  // =========================================================
  function router() {
    const hash = location.hash || '#/';
    const view = $('#view');
    if (hash.startsWith('#/t/')) {
      renderTool(view, hash.slice(4));
    } else {
      renderCatalog(view);
    }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', router);

  // =========================================================
  //  КАТАЛОГ
  // =========================================================
  let filterState = { q: '', status: 'all' };

  function renderCatalog(view) {
    const tools = store.tools();
    const counts = {
      total: tools.length,
      available: tools.filter(t => t.status === 'available').length,
      rented: tools.filter(t => t.status === 'rented').length,
      maintenance: tools.filter(t => t.status === 'maintenance' || t.status === 'broken').length,
    };

    view.innerHTML = `
      <div class="page-head">
        <div>
          <span class="eyebrow">Парк инструмента</span>
          <h1>Каталог <span>инструмента</span></h1>
        </div>
        <button class="btn btn--primary" id="addTool">+ Добавить инструмент</button>
      </div>

      <div class="stats">
        <div class="stat"><div class="stat__num">${counts.total}</div><div class="stat__label">Всего позиций</div></div>
        <div class="stat stat--ok"><div class="stat__num">${counts.available}</div><div class="stat__label">В наличии</div></div>
        <div class="stat stat--rented"><div class="stat__num">${counts.rented}</div><div class="stat__label">В аренде</div></div>
        <div class="stat stat--maint"><div class="stat__num">${counts.maintenance}</div><div class="stat__label">ТО / ремонт</div></div>
      </div>

      <div class="toolbar">
        <input type="search" class="search" id="search" placeholder="🔍 Поиск по названию, № или категории…" value="${esc(filterState.q)}">
      </div>
      <div class="filters" id="filters">
        ${['all','available','rented','maintenance','broken'].map(s => {
          const label = s === 'all' ? 'Все' : STATUS[s].label;
          return `<button class="chip ${filterState.status === s ? 'is-active' : ''}" data-status="${s}">${label}</button>`;
        }).join('')}
      </div>

      <div id="grid"></div>
    `;

    $('#addTool').addEventListener('click', () => openToolForm());
    $('#search').addEventListener('input', (e) => { filterState.q = e.target.value; renderGrid(); });
    $('#filters').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-status]'); if (!btn) return;
      filterState.status = btn.dataset.status;
      view.querySelectorAll('#filters .chip').forEach(c => c.classList.toggle('is-active', c.dataset.status === filterState.status));
      renderGrid();
    });

    renderGrid();
  }

  function renderGrid() {
    const grid = $('#grid'); if (!grid) return;
    const q = filterState.q.trim().toLowerCase();
    let list = store.tools();
    if (filterState.status !== 'all') list = list.filter(t => t.status === filterState.status);
    if (q) list = list.filter(t =>
      [t.name, t.category, t.inventoryNo, t.serialNo].filter(Boolean).join(' ').toLowerCase().includes(q));

    if (!store.tools().length) {
      grid.innerHTML = `<div class="empty"><div class="empty__icon">🧰</div>
        <p>Пока нет ни одного инструмента.<br>Добавьте первый — и получите для него QR-код.</p>
        <button class="btn btn--primary" onclick="document.getElementById('addTool').click()">+ Добавить инструмент</button></div>`;
      return;
    }
    if (!list.length) { grid.innerHTML = `<div class="empty"><div class="empty__icon">🔍</div><p>Ничего не найдено по заданным условиям.</p></div>`; return; }

    grid.className = 'grid';
    grid.innerHTML = list.map(t => {
      const st = STATUS[t.status] || STATUS.available;
      const cur = t.status === 'rented' ? currentRental(t) : null;
      return `
        <article class="tool-card" data-id="${t.id}">
          <div class="tool-card__top">
            <div>
              <div class="tool-card__name">${esc(t.name)}</div>
              <div class="tool-card__cat">${esc(t.category || 'Без категории')}</div>
            </div>
            <span class="status status--${st.cls}">${st.label}</span>
          </div>
          ${cur ? `<div class="tool-card__renter">👤 ${esc(cur.renter)} · до ${fmtDate(cur.dueAt)}</div>` : ''}
          <div class="tool-card__meta">
            ${t.inventoryNo ? `<span>№ ${esc(t.inventoryNo)}</span>` : ''}
            ${(t.dailyPrice || t.priceText) ? `<span>${priceLabel(t)}</span>` : ''}
            <span>Аренд: ${(t.rentals || []).length}</span>
          </div>
        </article>`;
    }).join('');

    grid.querySelectorAll('.tool-card').forEach(c =>
      c.addEventListener('click', () => { location.hash = '#/t/' + c.dataset.id; }));
  }

  // =========================================================
  //  КАРТОЧКА ИНСТРУМЕНТА
  // =========================================================
  function currentRental(t) {
    return (t.rentals || []).find(r => !r.returnedAt) || null;
  }

  function renderTool(view, id) {
    const t = store.get(id);
    if (!t) {
      view.innerHTML = `<a href="#/" class="back-link">← Назад к каталогу</a>
        <div class="empty"><div class="empty__icon">❓</div><p>Инструмент не найден.<br>Возможно, QR-код от другого устройства/базы.</p></div>`;
      return;
    }
    const st = STATUS[t.status] || STATUS.available;
    const cur = currentRental(t);

    view.innerHTML = `
      <a href="#/" class="back-link">← Назад к каталогу</a>
      <div class="page-head">
        <div>
          <span class="status status--${st.cls}">${st.label}</span>
          <h1 style="margin-top:10px">${esc(t.name)}</h1>
          <div class="tool-card__cat">${esc(t.category || 'Без категории')}</div>
        </div>
      </div>

      <div class="detail">
        <div>
          <div class="panel qr-box">
            <h3 style="align-self:flex-start">QR-код</h3>
            <div class="qr-box__code" id="qrcode"></div>
            <div class="qr-box__id">${esc(t.id)}</div>
            <div class="actions-row" style="justify-content:center">
              <button class="btn btn--outline btn--sm" id="printQr">🖨 Печать</button>
              <button class="btn btn--outline btn--sm" id="downloadQr">⬇ PNG</button>
            </div>
          </div>
        </div>

        <div>
          <div class="panel">
            <h3>Действия</h3>
            <div class="actions-row">
              ${t.status === 'available'
                ? `<button class="btn btn--primary" id="actRent">🤝 Выдать в аренду</button>`
                : ''}
              ${t.status === 'rented'
                ? `<button class="btn btn--primary" id="actReturn">📥 Принять возврат</button>`
                : ''}
              <button class="btn btn--outline" id="actMaint">🔧 Записать ТО</button>
              <button class="btn btn--outline" id="actStatus">⚙ Статус</button>
              <button class="btn btn--outline" id="actEdit">✏ Изменить</button>
            </div>
          </div>

          <div class="panel">
            <h3>Характеристики</h3>
            ${t.desc ? `<p style="margin:0 0 14px;color:var(--text-dim)">${esc(t.desc)}</p>` : ''}
            <dl class="kv">
              <dt>Инвентарный №</dt><dd>${esc(t.inventoryNo || '—')}</dd>
              <dt>Серийный №</dt><dd>${esc(t.serialNo || '—')}</dd>
              <dt>Цена аренды</dt><dd>${priceLabel(t)}</dd>
              <dt>Добавлен</dt><dd>${fmtDate(t.createdAt)}</dd>
              ${t.notes ? `<dt>Заметки</dt><dd>${esc(t.notes)}</dd>` : ''}
            </dl>
            ${(t.specs && t.specs.length) ? `
              <ul style="margin:14px 0 0;padding-left:18px;color:var(--text-dim);font-size:.9rem">
                ${t.specs.map(s => `<li>${esc(s)}</li>`).join('')}
              </ul>` : ''}
          </div>

          ${cur ? `
          <div class="panel" style="border-color:var(--orange)">
            <h3>🔴 Сейчас в аренде</h3>
            <dl class="kv">
              <dt>Арендатор</dt><dd>${esc(cur.renter)}</dd>
              <dt>Телефон</dt><dd>${esc(cur.phone || '—')}</dd>
              <dt>Объект</dt><dd>${esc(cur.site || '—')}</dd>
              <dt>Выдан</dt><dd>${fmtDateTime(cur.takenAt)}</dd>
              <dt>Вернуть до</dt><dd>${fmtDate(cur.dueAt)}</dd>
            </dl>
          </div>` : ''}

          <div class="panel">
            <h3>🔧 История ТО (${(t.maintenance || []).length})</h3>
            ${renderMaintenance(t)}
          </div>

          <div class="panel">
            <h3>📜 История аренд (${(t.rentals || []).length})</h3>
            ${renderRentals(t)}
          </div>

          <div class="panel">
            <button class="btn btn--outline btn--sm" id="actDelete" style="color:#dc2626;border-color:#f3c2c2">🗑 Удалить инструмент</button>
          </div>
        </div>
      </div>
    `;

    // QR-код
    const qrText = location.origin && location.origin !== 'null'
      ? `${location.origin}${location.pathname}#/t/${t.id}`
      : t.id;
    const qrEl = $('#qrcode');
    const qr = new QRCode(qrEl, { text: qrText, width: 220, height: 220, colorDark: '#1a1d22', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });

    $('#printQr').addEventListener('click', () => printQr(t, qrEl));
    $('#downloadQr').addEventListener('click', () => downloadQr(t, qrEl));

    if ($('#actRent')) $('#actRent').addEventListener('click', () => openRentForm(t));
    if ($('#actReturn')) $('#actReturn').addEventListener('click', () => openReturnForm(t));
    $('#actMaint').addEventListener('click', () => openMaintForm(t));
    $('#actStatus').addEventListener('click', () => openStatusForm(t));
    $('#actEdit').addEventListener('click', () => openToolForm(t));
    $('#actDelete').addEventListener('click', () => {
      if (confirm(`Удалить «${t.name}» вместе со всей историей? Действие необратимо.`)) {
        store.remove(t.id); toast('Инструмент удалён'); location.hash = '#/';
      }
    });
  }

  function renderMaintenance(t) {
    const list = (t.maintenance || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (!list.length) return `<p class="tool-card__cat">Записей о ТО пока нет.</p>`;
    return `<ul class="timeline">${list.map(m => `
      <li>
        <div class="timeline__date">${fmtDate(m.date)}</div>
        <div class="timeline__title">${esc(m.type)}</div>
        ${m.master ? `<div class="timeline__sub">Мастер: ${esc(m.master)}</div>` : ''}
        ${m.note ? `<div class="timeline__sub">${esc(m.note)}</div>` : ''}
      </li>`).join('')}</ul>`;
  }

  function renderRentals(t) {
    const list = (t.rentals || []).slice().sort((a, b) => (b.takenAt || '').localeCompare(a.takenAt || ''));
    if (!list.length) return `<p class="tool-card__cat">Инструмент ещё не сдавался в аренду.</p>`;
    return `<ul class="timeline">${list.map(r => `
      <li${!r.returnedAt ? ' style="border-color:var(--orange)"' : ''}>
        <div class="timeline__date">${fmtDateTime(r.takenAt)} ${r.returnedAt ? '→ ' + fmtDateTime(r.returnedAt) : '· <b style="color:var(--orange)">не возвращён</b>'}</div>
        <div class="timeline__title">👤 ${esc(r.renter)}${r.phone ? ' · ' + esc(r.phone) : ''}</div>
        ${r.site ? `<div class="timeline__sub">Объект: ${esc(r.site)}</div>` : ''}
        ${r.note ? `<div class="timeline__sub">${esc(r.note)}</div>` : ''}
      </li>`).join('')}</ul>`;
  }

  // =========================================================
  //  ФОРМЫ
  // =========================================================
  function field(label, inner, hint) {
    return `<div class="field"><label>${label}</label>${inner}${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  }
  function catOptions(selected) {
    return CATEGORIES.map(c => `<option ${c === selected ? 'selected' : ''}>${c}</option>`).join('');
  }

  function openToolForm(t = null) {
    const isEdit = !!t;
    const body = modal.open(`
      <h2>${isEdit ? 'Изменить инструмент' : 'Новый инструмент'}</h2>
      <form id="toolForm">
        ${field('Название *', `<input name="name" required value="${esc(t?.name || '')}" placeholder="Перфоратор Bosch GBH 2-26">`)}
        ${field('Категория', `<select name="category">${catOptions(t?.category)}</select>`)}
        <div class="field-row">
          ${field('Инвентарный №', `<input name="inventoryNo" value="${esc(t?.inventoryNo || '')}" placeholder="0042">`)}
          ${field('Цена, ₽/сут', `<input name="dailyPrice" type="number" min="0" value="${esc(t?.dailyPrice || '')}" placeholder="500">`)}
        </div>
        ${field('Серийный №', `<input name="serialNo" value="${esc(t?.serialNo || '')}" placeholder="SN-12345">`)}
        ${field('Заметки', `<textarea name="notes" rows="2" placeholder="Комплект, особенности…">${esc(t?.notes || '')}</textarea>`)}
        <button class="btn btn--primary btn--block" type="submit">${isEdit ? 'Сохранить' : 'Добавить и создать QR'}</button>
      </form>
    `);
    $('#toolForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const patch = {
        name: f.get('name').trim(),
        category: f.get('category'),
        inventoryNo: f.get('inventoryNo').trim(),
        serialNo: f.get('serialNo').trim(),
        dailyPrice: f.get('dailyPrice').trim(),
        notes: f.get('notes').trim(),
      };
      if (!patch.name) return;
      if (isEdit) {
        store.update(t.id, patch); modal.close(); toast('Сохранено'); router();
      } else {
        const tool = { id: uid(), status: 'available', createdAt: nowISO(), rentals: [], maintenance: [], ...patch };
        store.add(tool); modal.close(); toast('Инструмент добавлен'); location.hash = '#/t/' + tool.id;
      }
    });
  }

  function openRentForm(t) {
    modal.open(`
      <h2>Выдать в аренду</h2>
      <p class="tool-card__cat" style="margin-top:-10px">${esc(t.name)}</p>
      <form id="rentForm">
        ${field('Арендатор *', `<input name="renter" required placeholder="Иван Петров / ООО Стройка">`)}
        <div class="field-row">
          ${field('Телефон', `<input name="phone" type="tel" placeholder="+7 …">`)}
          ${field('Вернуть до', `<input name="dueAt" type="date" value="${todayInput()}">`)}
        </div>
        ${field('Объект / адрес', `<input name="site" placeholder="ЖК Северный, корп. 3">`)}
        ${field('Примечание', `<textarea name="note" rows="2" placeholder="Залог, комплект…"></textarea>`)}
        <button class="btn btn--primary btn--block" type="submit">🤝 Выдать</button>
      </form>
    `);
    $('#rentForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const renter = f.get('renter').trim(); if (!renter) return;
      const rental = {
        id: rid(), renter, phone: f.get('phone').trim(), site: f.get('site').trim(),
        dueAt: f.get('dueAt'), note: f.get('note').trim(), takenAt: nowISO(), returnedAt: null,
      };
      t.rentals = t.rentals || []; t.rentals.push(rental);
      store.update(t.id, { status: 'rented', rentals: t.rentals });
      modal.close(); toast('Выдано в аренду'); router();
    });
  }

  function openReturnForm(t) {
    const cur = currentRental(t);
    if (!cur) { toast('Активная аренда не найдена', 'err'); return; }
    modal.open(`
      <h2>Принять возврат</h2>
      <p class="tool-card__cat" style="margin-top:-10px">${esc(t.name)} · от ${esc(cur.renter)}</p>
      <form id="retForm">
        ${field('Состояние при возврате', `<select name="condition">
          <option value="ok">Исправен — в наличии</option>
          <option value="maintenance">Требует ТО</option>
          <option value="broken">Неисправен</option>
        </select>`)}
        ${field('Примечание', `<textarea name="note" rows="2" placeholder="Замечания по возврату…"></textarea>`)}
        <button class="btn btn--primary btn--block" type="submit">📥 Принять</button>
      </form>
    `);
    $('#retForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      cur.returnedAt = nowISO();
      const note = f.get('note').trim();
      if (note) cur.note = (cur.note ? cur.note + ' | ' : '') + 'Возврат: ' + note;
      const cond = f.get('condition');
      const newStatus = cond === 'ok' ? 'available' : cond;
      store.update(t.id, { status: newStatus, rentals: t.rentals });
      modal.close(); toast('Возврат принят'); router();
    });
  }

  function openMaintForm(t) {
    modal.open(`
      <h2>Запись о ТО</h2>
      <p class="tool-card__cat" style="margin-top:-10px">${esc(t.name)}</p>
      <form id="maintForm">
        <div class="field-row">
          ${field('Дата', `<input name="date" type="date" value="${todayInput()}">`)}
          ${field('Тип работ', `<select name="type">
            <option>Плановое ТО</option><option>Чистка/смазка</option><option>Замена расходников</option>
            <option>Ремонт</option><option>Диагностика</option><option>Прочее</option>
          </select>`)}
        </div>
        ${field('Мастер', `<input name="master" placeholder="Кто проводил">`)}
        ${field('Описание', `<textarea name="note" rows="2" placeholder="Что сделано, заменённые детали…"></textarea>`)}
        ${field('После ТО — статус', `<select name="status">
          <option value="">Не менять</option>
          <option value="available">В наличии</option>
          <option value="maintenance">Оставить на ТО</option>
          <option value="broken">Неисправен</option>
        </select>`)}
        <button class="btn btn--primary btn--block" type="submit">Сохранить запись</button>
      </form>
    `);
    $('#maintForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const m = { id: rid(), date: f.get('date'), type: f.get('type'), master: f.get('master').trim(), note: f.get('note').trim() };
      t.maintenance = t.maintenance || []; t.maintenance.push(m);
      const patch = { maintenance: t.maintenance };
      const st = f.get('status'); if (st) patch.status = st;
      store.update(t.id, patch);
      modal.close(); toast('Запись ТО добавлена'); router();
    });
  }

  function openStatusForm(t) {
    modal.open(`
      <h2>Изменить статус</h2>
      <p class="tool-card__cat" style="margin-top:-10px">${esc(t.name)}</p>
      <form id="stForm">
        ${field('Статус', `<select name="status">
          ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select>`, 'Смена на «В аренде» делается через кнопку «Выдать».')}
        <button class="btn btn--primary btn--block" type="submit">Применить</button>
      </form>
    `);
    $('#stForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const status = new FormData(e.target).get('status');
      if (status === 'rented' && !currentRental(t)) { toast('Используйте «Выдать в аренду»', 'err'); return; }
      store.update(t.id, { status }); modal.close(); toast('Статус обновлён'); router();
    });
  }

  // =========================================================
  //  QR: печать и скачивание
  // =========================================================
  function qrImage(qrEl) {
    const canvas = qrEl.querySelector('canvas');
    if (canvas) return canvas.toDataURL('image/png');
    const img = qrEl.querySelector('img');
    return img ? img.src : '';
  }
  function downloadQr(t, qrEl) {
    const url = qrImage(qrEl); if (!url) return;
    const a = document.createElement('a');
    a.href = url; a.download = `QR-${(t.inventoryNo || t.id)}.png`; a.click();
  }
  function printQr(t, qrEl) {
    const url = qrImage(qrEl);
    const w = window.open('', '_blank', 'width=420,height=560');
    w.document.write(`<html><head><title>QR ${esc(t.name)}</title>
      <style>body{font-family:Manrope,system-ui,sans-serif;text-align:center;padding:30px}
      h2{margin:0 0 4px;font-size:20px} .cat{color:#666;margin-bottom:14px;font-size:14px}
      img{width:280px;height:280px} .id{font-family:monospace;color:#888;font-size:12px;margin-top:8px}
      .inv{font-weight:800;font-size:18px;margin-top:6px}</style></head>
      <body><h2>${esc(t.name)}</h2><div class="cat">${esc(t.category || '')}</div>
      <img src="${url}"><div class="inv">${t.inventoryNo ? '№ ' + esc(t.inventoryNo) : ''}</div>
      <div class="id">${esc(t.id)}</div>
      <script>onload=()=>{print();}<\/script></body></html>`);
    w.document.close();
  }

  // =========================================================
  //  СКАНЕР QR
  // =========================================================
  function openScanner() {
    modal.open(`
      <h2>Сканировать QR</h2>
      <div id="reader"></div>
      <p class="scan-hint">Наведите камеру на QR-наклейку инструмента</p>
      <button class="btn btn--outline btn--block btn--sm" id="manualEntry">Ввести код вручную</button>
    `, true);

    $('#manualEntry').addEventListener('click', () => {
      const code = prompt('Введите код инструмента (например, T…):');
      if (code) handleScan(code.trim());
    });

    if (!window.Html5Qrcode) { $('#reader').innerHTML = '<p class="empty">Сканер недоступен в этом окружении.</p>'; return; }
    const scanner = new Html5Qrcode('reader');
    window._scanner = scanner;
    scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 230, height: 230 } },
      (decoded) => { handleScan(decoded); },
      () => {}
    ).catch(err => {
      $('#reader').innerHTML = `<p class="empty">📷 Нет доступа к камере.<br><span class="tool-card__cat">${esc(String(err))}</span><br>Используйте ручной ввод.</p>`;
    });
  }

  function stopScanner() {
    if (window._scanner) {
      try { window._scanner.stop().then(() => window._scanner.clear()).catch(() => {}); } catch {}
      window._scanner = null;
    }
  }

  function handleScan(text) {
    stopScanner(); modal.close();
    // Поддерживаем как полный URL (#/t/ID), так и просто ID
    let id = text;
    const m = text.match(/#\/t\/([^/?&#]+)/);
    if (m) id = m[1];
    if (store.get(id)) { location.hash = '#/t/' + id; }
    else { toast('Инструмент с этим кодом не найден', 'err'); }
  }

  $('#navScan').addEventListener('click', openScanner);
  $('#fabScan').addEventListener('click', openScanner);

  // =========================================================
  //  ИМПОРТ КАТАЛОГА (при первом запуске)
  //  Источник — catalog-data.js (раздел инструмента из arenda-site).
  // =========================================================
  // v2: стабильные ID из каталога (одинаковые на всех устройствах → QR работает между ними).
  const SEED_VERSION = 'catalog-v2';
  const OLD_DEMO_NAMES = ['Перфоратор Bosch GBH 2-26', 'Бетономешалка 160 л', 'УШМ Makita 125 мм'];

  function seedFromCatalog() {
    const seed = window.SEED_CATALOG;
    if (!Array.isArray(seed) || !seed.length) return;
    // Сохраняем порядок каталога: добавляем с конца, т.к. add() кладёт в начало.
    for (let i = seed.length - 1; i >= 0; i--) {
      const d = seed[i];
      store.add({
        id: d.id || uid(), status: 'available', createdAt: nowISO(),
        name: d.name, category: d.category || 'Прочее',
        inventoryNo: '', serialNo: '',
        dailyPrice: d.price || '', priceText: d.priceText || '',
        desc: d.desc || '', specs: Array.isArray(d.specs) ? d.specs : [],
        notes: '', rentals: [], maintenance: [],
      });
    }
  }

  // Переводим существующие позиции каталога на стабильные ID — БЕЗ потери истории
  // (id — это просто ключ; аренды и ТО лежат внутри объекта инструмента).
  function migrateIdsToStable() {
    const byName = new Map((window.SEED_CATALOG || []).map(d => [d.name, d.id]));
    const used = new Set(store.tools().map(t => t.id));
    let changed = false;
    store.tools().forEach(t => {
      const sid = byName.get(t.name);
      if (sid && t.id !== sid && !used.has(sid)) {
        used.delete(t.id); t.id = sid; used.add(sid); changed = true;
      }
    });
    return changed;
  }

  function ensureCatalog() {
    if (store.tools().length === 0) {
      seedFromCatalog();                 // первый запуск — заливаем каталог со стабильными ID
    } else {
      migrateIdsToStable();              // существующая база — переводим позиции на стабильные ID
    }
    store.data.seeded = SEED_VERSION;
    store.save();
  }

  // ---------- Старт ----------
  store.load();
  ensureCatalog();
  router();
})();
