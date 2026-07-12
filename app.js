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
  // Локальный кэш (localStorage) + зеркалирование в общую облачную базу (sync).
  const KEY = 'arenda-tools-v1';
  const store = {
    data: { tools: [] },
    muted: false,                 // при true — локальные изменения НЕ шлются в облако
    load() {
      try { this.data = JSON.parse(localStorage.getItem(KEY)) || { tools: [] }; }
      catch { this.data = { tools: [] }; }
      if (!Array.isArray(this.data.tools)) this.data.tools = [];
    },
    save() { localStorage.setItem(KEY, JSON.stringify(this.data)); },
    // Служебные документы (например «_settings» с PIN администратора) живут
    // в той же таблице, но в каталоге не показываются
    tools() { return this.data.tools.filter(t => t.id !== '_settings'); },
    get(id) { return this.data.tools.find(t => t.id === id); },
    add(tool) { this.data.tools.unshift(tool); this.save(); if (!this.muted) sync.push(tool); },
    update(id, patch) {
      const t = this.get(id); if (!t) return;
      Object.assign(t, patch); this.save(); if (!this.muted) sync.push(t);
    },
    remove(id) { this.data.tools = this.data.tools.filter(t => t.id !== id); this.save(); if (!this.muted) sync.remove(id); },
    // Применение удалённых изменений (из realtime) — БЕЗ обратной отправки в облако
    applyRemoteUpsert(doc) {
      const i = this.data.tools.findIndex(t => t.id === doc.id);
      if (i >= 0) this.data.tools[i] = doc; else this.data.tools.unshift(doc);
      this.save();
    },
    applyRemoteDelete(id) { this.data.tools = this.data.tools.filter(t => t.id !== id); this.save(); },
  };

  // ---------- Облачная синхронизация (Supabase) ----------
  let pending = 0;   // счётчик незавершённых отправок в облако (для безопасного поллинга)
  let lastSig = '';  // «подпись» состава базы (id+время) — чтобы не качать фото зря
  const sync = {
    client: null, enabled: false,
    async init() {
      const c = window.APP_CONFIG || {};
      if (!c.SUPABASE_URL || !c.SUPABASE_ANON_KEY || !window.supabase) return false;
      try {
        this.client = window.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY);
        this.enabled = true; return true;
      } catch (e) { console.warn('Supabase init failed:', e); return false; }
    },
    async pullAll() {
      const { data, error } = await this.client.from('tools').select('id,doc').order('sort', { ascending: true });
      if (error) throw error;
      return data.map(r => r.doc);
    },
    async push(tool) {
      if (!this.enabled) return;
      pending++;
      try {
        const sort = store.data.tools.findIndex(t => t.id === tool.id);
        const { error } = await this.client.from('tools').upsert({ id: tool.id, doc: tool, sort, updated_at: new Date().toISOString() });
        if (error) throw error;
        setStatus('online');
      } catch (e) { console.warn('sync push:', e); setStatus('offline'); }
      finally { pending--; }
    },
    async remove(id) {
      if (!this.enabled) return;
      pending++;
      try {
        const { error } = await this.client.from('tools').delete().eq('id', id);
        if (error) throw error;
        setStatus('online');
      } catch (e) { console.warn('sync remove:', e); setStatus('offline'); }
      finally { pending--; }
    },
    async pushAll(tools) {
      if (!this.enabled) return;
      const rows = tools.map((t, i) => ({ id: t.id, doc: t, sort: i, updated_at: new Date().toISOString() }));
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await this.client.from('tools').upsert(rows.slice(i, i + 200));
        if (error) throw error;
      }
    },
    subscribe(onChange) {
      this.client.channel('tools-rt')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tools' }, onChange)
        .subscribe();
    },
  };

  // Индикатор состояния синхронизации в шапке
  function setStatus(mode) {
    const el = document.getElementById('syncStatus');
    if (!el) return;
    const map = {
      online:  { t: '● Синхронизировано', c: '#15a34a' },
      offline: { t: '● Нет сети', c: '#d97706' },
      local:   { t: '● Локально (без общей базы)', c: '#6b7280' },
    };
    const s = map[mode] || map.local;
    el.textContent = s.t; el.style.color = s.c; el.title = s.t;
  }

  // ---------- Утилиты ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const uid = () => 'T' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
  const rid = () => Math.random().toString(36).slice(2, 9);
  const nowISO = () => new Date().toISOString();
  const todayInput = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  // ---------- Аккаунты и роли ----------
  // Вход обязателен. Аккаунты создаёт администратор (самостоятельной
  // регистрации нет). Роли: admin — полное управление парком,
  // manager — каталог, сканер, выдача, возврат, ТО, фото, аналитика.
  // Профиль кешируется локально, чтобы приложение работало офлайн.
  const PROFILE_KEY = 'arenda-profile';
  let currentProfile = null; // {id, email, name, role}
  const isAdmin = () => !!currentProfile && currentProfile.role === 'admin';
  const managerName = () => (currentProfile && currentProfile.name) || '';
  const ADMIN_FN = () => (window.APP_CONFIG.SUPABASE_URL || '') + '/functions/v1/admin-users';

  async function authToken() {
    if (!sync.client) return '';
    const { data } = await sync.client.auth.getSession();
    return data && data.session ? data.session.access_token : '';
  }
  async function adminApi(payload) {
    const token = await authToken();
    const resp = await fetch(ADMIN_FN(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': window.APP_CONFIG.SUPABASE_ANON_KEY || '',
        ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
      },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) throw new Error(data.error || ('HTTP ' + resp.status));
    return data;
  }
  async function loadProfile(userId) {
    try {
      const { data, error } = await sync.client.from('profiles')
        .select('id,email,name,role').eq('id', userId).single();
      if (error) throw error;
      currentProfile = data;
      localStorage.setItem(PROFILE_KEY, JSON.stringify(data));
    } catch (e) {
      // офлайн — берём кешированный профиль этого же пользователя
      try {
        const cached = JSON.parse(localStorage.getItem(PROFILE_KEY));
        if (cached && cached.id === userId) currentProfile = cached;
      } catch {}
    }
    return currentProfile;
  }
  function updateUserBtn() {
    const nameEl = document.getElementById('userBtnName');
    const btn = document.getElementById('userBtn');
    if (!nameEl || !btn) return;
    const name = managerName();
    nameEl.textContent = name ? name.split(' ')[0] : 'Вход';
    btn.classList.toggle('is-admin', isAdmin());
    btn.title = name
      ? name + ' · ' + (isAdmin() ? 'администратор' : 'менеджер')
      : 'Вход';
  }

  // Экран входа / регистрации / первичной настройки (рисуется вместо приложения)
  function renderAuthScreen(needsBootstrap) {
    const view = document.getElementById('view');
    if (needsBootstrap) {
      view.innerHTML = `
        <div class="auth-wrap">
          <div class="panel auth-panel">
            <span class="eyebrow">Первичная настройка</span>
            <h2 style="margin:8px 0 4px">Создайте аккаунт <span style="color:var(--orange)">администратора</span></h2>
            <p class="tool-card__cat" style="margin:0 0 16px">Это первый запуск: аккаунт станет администратором. Сотрудники потом зарегистрируются сами, а вы их одобрите.</p>
            <form id="authForm">
              ${field('Ваше имя *', `<input name="aname" required placeholder="Павел">`)}
              ${field('Почта (логин) *', `<input name="aemail" type="email" required placeholder="pavel@arenda.ru" autocomplete="username">`)}
              ${field('Пароль *', `<input name="apass" type="password" required minlength="6" placeholder="Минимум 6 символов" autocomplete="new-password">`)}
              <button class="btn btn--primary btn--block" type="submit">Создать и войти</button>
            </form>
          </div>
        </div>`;
      $('#authForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const btn = e.target.querySelector('button[type=submit]');
        btn.disabled = true; btn.textContent = 'Секунду…';
        try {
          await adminApi({ action: 'bootstrap', email: f.get('aemail').trim(), password: f.get('apass'), name: f.get('aname').trim() });
          const { error } = await sync.client.auth.signInWithPassword({ email: f.get('aemail').trim(), password: f.get('apass') });
          if (error) throw new Error(error.message);
          location.reload();
        } catch (err) {
          toast(err.message, 'err');
          btn.disabled = false; btn.textContent = 'Создать и войти';
        }
      });
      return;
    }

    let mode = 'login'; // login | signup
    const draw = () => {
      view.innerHTML = `
        <div class="auth-wrap">
          <div class="panel auth-panel">
            <span class="eyebrow">Для сотрудников</span>
            <div class="auth-tabs">
              <button class="chip ${mode === 'login' ? 'is-active' : ''}" data-mode="login">Вход</button>
              <button class="chip ${mode === 'signup' ? 'is-active' : ''}" data-mode="signup">Регистрация</button>
            </div>
            <p class="tool-card__cat" style="margin:10px 0 16px">${mode === 'login'
              ? 'Войдите со своим логином и паролем.'
              : 'После регистрации доступ откроется, когда администратор одобрит заявку.'}</p>
            <form id="authForm">
              ${mode === 'signup' ? field('Ваше имя *', `<input name="aname" required placeholder="Александр">`) : ''}
              ${field('Почта (логин) *', `<input name="aemail" type="email" required placeholder="sasha@arenda.ru" autocomplete="username">`)}
              ${field('Пароль *', `<input name="apass" type="password" required minlength="6" placeholder="Минимум 6 символов" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}">`)}
              <button class="btn btn--primary btn--block" type="submit">${mode === 'login' ? 'Войти' : 'Зарегистрироваться'}</button>
            </form>
          </div>
        </div>`;
      view.querySelector('.auth-tabs').addEventListener('click', (e) => {
        const b = e.target.closest('[data-mode]');
        if (b) { mode = b.dataset.mode; draw(); }
      });
      $('#authForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const email = f.get('aemail').trim();
        const password = f.get('apass');
        const btn = e.target.querySelector('button[type=submit]');
        btn.disabled = true; btn.textContent = 'Секунду…';
        try {
          if (mode === 'signup') {
            const { error } = await sync.client.auth.signUp({
              email, password,
              options: { data: { name: f.get('aname').trim() } },
            });
            if (error) throw new Error(error.message);
          } else {
            const { error } = await sync.client.auth.signInWithPassword({ email, password });
            if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Неверная почта или пароль' : error.message);
          }
          location.reload();
        } catch (err) {
          toast(err.message, 'err');
          btn.disabled = false; btn.textContent = mode === 'login' ? 'Войти' : 'Зарегистрироваться';
        }
      });
    };
    draw();
  }

  // Аккаунт есть, но администратор ещё не одобрил — доступа нет
  function renderPendingScreen(email) {
    const view = document.getElementById('view');
    view.innerHTML = `
      <div class="auth-wrap">
        <div class="panel auth-panel" style="text-align:center">
          <span class="eyebrow">Заявка отправлена</span>
          <h2 style="margin:8px 0 4px">Ожидает <span style="color:var(--orange)">одобрения</span></h2>
          <p class="tool-card__cat" style="margin:0 0 16px">Аккаунт ${esc(email || '')} создан. Доступ откроется, когда администратор примет заявку в разделе «Сотрудники». Сообщите ему.</p>
          <button class="btn btn--primary btn--block" id="pendingRefresh">Проверить ещё раз</button>
          <button class="btn btn--outline btn--sm btn--block" id="pendingLogout" style="margin-top:10px">Выйти</button>
        </div>
      </div>`;
    $('#pendingRefresh').addEventListener('click', () => location.reload());
    $('#pendingLogout').addEventListener('click', async () => {
      try { await sync.client.auth.signOut(); } catch {}
      localStorage.removeItem(PROFILE_KEY);
      location.reload();
    });
  }

  // ---------- Векторные иконки (единый линейный стиль) ----------
  const ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    scan: '<path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/><path d="M4 12h16"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3.2"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 16v-5M12 16V8M17 16v-3"/>',
    tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.3"/>',
    hash: '<path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/>',
    user: '<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="8" r="4"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    alarm: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M5 3L2.5 5.5M22 6l-2.5-2.5"/>',
    handout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
    printer: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    refresh: '<path d="M21 3v6h-6M3 12a9 9 0 0 1 15-6.7L21 9M3 21v-6h6M21 12a9 9 0 0 1-15 6.7L3 15"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    package: '<path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    trend: '<path d="M22 7l-8.5 8.5-4-4L2 19M16 7h6v6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  };
  function icon(name, cls = 'ic') {
    return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }
  // Цветной кружок-индикатор (например «в аренде»)
  function dot(color) {
    return `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6" fill="${color}"/></svg>`;
  }

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

  // ---------- Деньги ----------
  const fmtMoney = (n) => Number(n || 0).toLocaleString('ru-RU') + ' ₽';
  // Сутки аренды: каждые начатые 24 часа, минимум 1
  function rentalDays(r) {
    const from = new Date(r.takenAt).getTime();
    const to = r.returnedAt ? new Date(r.returnedAt).getTime() : Date.now();
    return Math.max(1, Math.ceil((to - from) / 86400000));
  }
  function rentalCost(t, r) {
    const price = parseFloat(t.dailyPrice);
    return price > 0 ? rentalDays(r) * price : 0;
  }

  // ---------- ТО по наработке ----------
  // Норма «ТО каждые N аренд» (t.maintEvery) и сколько выдач было после последнего ТО
  function maintInfo(t) {
    const every = parseInt(t.maintEvery, 10);
    if (!every || every < 1) return null;
    const lastMaint = (t.maintenance || []).reduce((m, x) => ((x.date || '') > m ? x.date : m), '');
    const used = (t.rentals || []).filter(r => !lastMaint || (r.takenAt || '').slice(0, 10) > lastMaint).length;
    return { every, used, due: used >= every };
  }

  // ---------- Просрочка ----------
  // Местная дата (а не UTC) — иначе срок сравнивается криво около полуночи.
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function isOverdue(t) {
    if (t.status !== 'rented') return false;
    const cur = currentRental(t);
    return !!(cur && cur.dueAt && cur.dueAt < todayStr());
  }
  function daysOverdue(t) {
    const cur = currentRental(t);
    if (!cur || !cur.dueAt || cur.dueAt >= todayStr()) return 0;
    const d1 = new Date(cur.dueAt + 'T00:00:00');
    const d2 = new Date(todayStr() + 'T00:00:00');
    return Math.round((d2 - d1) / 86400000);
  }

  // ---------- Сжатие фото (клиентский ресайз перед сохранением) ----------
  function resizeImage(file, maxSize = 900, quality = 0.7) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxSize) { height = Math.round(height * maxSize / width); width = maxSize; }
        else if (height > maxSize) { width = Math.round(width * maxSize / height); height = maxSize; }
        const c = document.createElement('canvas');
        c.width = width; c.height = height;
        c.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      const fr = new FileReader();
      fr.onload = () => { img.src = fr.result; };
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
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
  function render(scroll = true) {
    const hash = location.hash || '#/';
    const view = $('#view');
    if (hash.startsWith('#/t/')) {
      renderTool(view, hash.slice(4));
    } else if (hash === '#/stats') {
      renderStats(view);
    } else {
      renderCatalog(view);
    }
    if (scroll) window.scrollTo(0, 0);
  }
  function router() { render(true); }   // после локальных действий — перерисовка с прокруткой вверх
  window.addEventListener('hashchange', () => render(true));

  // Резервная синхронизация: периодически подтягиваем общую базу — на случай,
  // если realtime-websocket заблокирован сетью. Безопасно: не трогаем локальные
  // данные, пока есть незавершённые отправки (pending), чтобы не затереть свежий ввод.
  async function pollSync() {
    if (!sync.enabled || pending > 0) return;
    try {
      // Лёгкая проверка: тянем только id+updated_at (без doc/фото)
      const { data, error } = await sync.client.from('tools').select('id,updated_at').order('id');
      if (error) throw error;
      setStatus('online');
      const sig = data.map(r => r.id + ':' + r.updated_at).join('|');
      if (sig === lastSig) return;                 // ничего не изменилось — полную базу не качаем
      const remote = await sync.pullAll();         // что-то поменялось — подтягиваем целиком
      lastSig = sig;
      if (JSON.stringify(store.data.tools) !== JSON.stringify(remote)) {
        store.data.tools = remote; store.save(); render(false);
      }
    } catch (e) { setStatus('offline'); }
  }

  // Применение изменений, пришедших с других устройств (realtime)
  function handleRemote(payload) {
    try {
      if (payload.eventType === 'DELETE') {
        if (payload.old && payload.old.id) store.applyRemoteDelete(payload.old.id);
      } else if (payload.new && payload.new.doc) {
        store.applyRemoteUpsert(payload.new.doc);
      }
      render(false);   // обновляем экран без скачка прокрутки
    } catch (e) { console.warn('handleRemote:', e); }
  }

  // =========================================================
  //  КАТАЛОГ
  // =========================================================
  let filterState = { q: '', status: 'all' };

  function renderCatalog(view) {
    const tools = store.tools();
    const overdue = tools.filter(isOverdue).length;
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
        <div class="head-actions">
          <a class="btn btn--outline" href="#/stats">${icon('chart')} Аналитика</a>
          ${isAdmin() ? `
            <button class="btn btn--outline" id="printLabels">${icon('tag')} Наклейки</button>
            <button class="btn btn--outline" id="bulkInv">${icon('hash')} Инв. номера</button>
            <button class="btn btn--primary" id="addTool">${icon('plus')} Добавить</button>
          ` : ''}
        </div>
      </div>

      <div class="stats">
        <div class="stat"><div class="stat__num">${counts.total}</div><div class="stat__label">Всего позиций</div></div>
        <div class="stat stat--ok"><div class="stat__num">${counts.available}</div><div class="stat__label">В наличии</div></div>
        <div class="stat stat--rented"><div class="stat__num">${counts.rented}</div><div class="stat__label">В аренде</div></div>
        <div class="stat ${overdue ? 'stat--over' : ''}"><div class="stat__num">${overdue}</div><div class="stat__label">Просрочено</div></div>
        <div class="stat stat--maint"><div class="stat__num">${counts.maintenance}</div><div class="stat__label">ТО / ремонт</div></div>
      </div>

      <div class="toolbar">
        <div class="search-wrap">
          <span class="search-ic">${icon('search')}</span>
          <input type="search" class="search" id="search" placeholder="Поиск по названию, № или категории…" value="${esc(filterState.q)}">
        </div>
      </div>
      <div class="filters" id="filters">
        ${['all','available','rented','overdue','maintenance','broken'].map(s => {
          const label = s === 'all' ? 'Все' : (s === 'overdue' ? icon('alarm') + ' Просрочено' : STATUS[s].label);
          return `<button class="chip ${filterState.status === s ? 'is-active' : ''}" data-status="${s}">${label}</button>`;
        }).join('')}
      </div>

      <div id="grid"></div>
    `;

    if ($('#addTool')) $('#addTool').addEventListener('click', () => openToolForm());
    if ($('#printLabels')) $('#printLabels').addEventListener('click', () => printLabels(visibleTools()));
    if ($('#bulkInv')) $('#bulkInv').addEventListener('click', () => openBulkInvForm());
    $('#search').addEventListener('input', (e) => { filterState.q = e.target.value; renderGrid(); });
    $('#filters').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-status]'); if (!btn) return;
      filterState.status = btn.dataset.status;
      view.querySelectorAll('#filters .chip').forEach(c => c.classList.toggle('is-active', c.dataset.status === filterState.status));
      renderGrid();
    });

    renderGrid();
  }

  // Текущая выборка каталога с учётом поиска и фильтра (используется и в печати наклеек)
  function visibleTools() {
    const q = filterState.q.trim().toLowerCase();
    let list = store.tools();
    if (filterState.status === 'overdue') list = list.filter(isOverdue);
    else if (filterState.status !== 'all') list = list.filter(t => t.status === filterState.status);
    if (q) list = list.filter(t =>
      [t.name, t.category, t.inventoryNo, t.serialNo].filter(Boolean).join(' ').toLowerCase().includes(q));
    return list;
  }

  function renderGrid() {
    const grid = $('#grid'); if (!grid) return;
    const list = visibleTools();

    if (!store.tools().length) {
      grid.innerHTML = `<div class="empty"><div class="empty__icon">${icon('package', 'ic-xl')}</div>
        <p>Пока нет ни одного инструмента.<br>Добавьте первый — и получите для него QR-код.</p>
        <button class="btn btn--primary" onclick="document.getElementById('addTool').click()">${icon('plus')} Добавить инструмент</button></div>`;
      return;
    }
    if (!list.length) { grid.innerHTML = `<div class="empty"><div class="empty__icon">${icon('search', 'ic-xl')}</div><p>Ничего не найдено по заданным условиям.</p></div>`; return; }

    grid.className = 'grid';
    grid.innerHTML = list.map(t => {
      const st = STATUS[t.status] || STATUS.available;
      const cur = t.status === 'rented' ? currentRental(t) : null;
      const over = isOverdue(t);
      return `
        <article class="tool-card ${over ? 'tool-card--over' : ''}" data-id="${t.id}">
          ${t.photo ? `<div class="tool-card__photo" style="background-image:url('${t.photo}')"></div>` : ''}
          <div class="tool-card__top">
            <div>
              <div class="tool-card__name">${esc(t.name)}</div>
              <div class="tool-card__cat">${esc(t.category || 'Без категории')}</div>
            </div>
            <span class="status status--${st.cls}">${st.label}</span>
          </div>
          ${cur ? `<div class="tool-card__renter ${over ? 'is-over' : ''}">${icon('user')} ${esc(cur.renter)} · ${over ? `${icon('alarm')} просрочка ${daysOverdue(t)} дн.` : 'до ' + fmtDate(cur.dueAt)}</div>` : ''}
          <div class="tool-card__meta">
            ${t.inventoryNo ? `<span>№ ${esc(t.inventoryNo)}</span>` : ''}
            ${(t.dailyPrice || t.priceText) ? `<span>${priceLabel(t)}</span>` : ''}
            <span>Аренд: ${(t.rentals || []).length}</span>
            ${(() => { const mi = maintInfo(t); return mi ? `<span class="${mi.due ? 'maint-due' : ''}">ТО: ${mi.used}/${mi.every}</span>` : ''; })()}
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
        <div class="empty"><div class="empty__icon">${icon('help', 'ic-xl')}</div><p>Инструмент не найден.<br>Возможно, QR-код от другого устройства/базы.</p></div>`;
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
          <div class="panel photo-box">
            <h3>Фото</h3>
            ${t.photo
              ? `<img class="photo-box__img" src="${t.photo}" alt="">`
              : `<div class="photo-box__empty">${icon('camera', 'ic-xl')}<span>Нет фото</span></div>`}
            <input type="file" id="photoInput" accept="image/*" hidden>
            <div class="actions-row" style="justify-content:center">
              <button class="btn btn--outline btn--sm" id="photoBtn">${t.photo ? icon('refresh') + ' Заменить' : icon('camera') + ' Добавить фото'}</button>
              ${t.photo ? `<button class="btn btn--outline btn--sm" id="photoDel" style="color:#dc2626;border-color:#f3c2c2">${icon('x')} Убрать</button>` : ''}
            </div>
          </div>

          <div class="panel qr-box">
            <h3 style="align-self:flex-start">QR-код</h3>
            <div class="qr-box__code" id="qrcode"></div>
            <div class="qr-box__id">${esc(t.id)}</div>
            <div class="actions-row" style="justify-content:center">
              <button class="btn btn--outline btn--sm" id="printQr">${icon('printer')} Печать</button>
              <button class="btn btn--outline btn--sm" id="downloadQr">${icon('download')} PNG</button>
            </div>
          </div>
        </div>

        <div>
          <div class="panel">
            <h3>Действия</h3>
            ${(() => { const mi = maintInfo(t); return (mi && mi.due) ? `<div class="overdue-banner">${icon('wrench')} Наработка ${mi.used} из ${mi.every} аренд — проведите ТО, выдача заблокирована.</div>` : ''; })()}
            <div class="actions-row">
              ${t.status === 'available'
                ? `<button class="btn btn--primary" id="actRent">${icon('handout')} Выдать в аренду</button>`
                : ''}
              ${t.status === 'rented'
                ? `<button class="btn btn--primary" id="actReturn">${icon('inbox')} Принять возврат</button>`
                : ''}
              <button class="btn btn--outline" id="actMaint">${icon('wrench')} Записать ТО</button>
              ${isAdmin() ? `
                <button class="btn btn--outline" id="actStatus">${icon('gear')} Статус</button>
                <button class="btn btn--outline" id="actEdit">${icon('edit')} Изменить</button>
                <button class="btn btn--outline" id="actCopies">${icon('copy')} Создать копии</button>
              ` : ''}
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
          <div class="panel" style="border-color:${isOverdue(t) ? '#dc2626' : 'var(--orange)'}">
            <h3>${dot(isOverdue(t) ? '#dc2626' : 'var(--orange)')} Сейчас в аренде</h3>
            ${isOverdue(t) ? `<div class="overdue-banner">${icon('alarm')} Просрочено на ${daysOverdue(t)} дн. — пора вернуть!</div>` : ''}
            <dl class="kv">
              <dt>Арендатор</dt><dd>${esc(cur.renter)}</dd>
              <dt>Телефон</dt><dd>${esc(cur.phone || '—')}</dd>
              ${cur.passport?.series ? `<dt>Паспорт</dt><dd>${esc(cur.passport.series)}${cur.passport.issuedAt ? ', выдан ' + fmtDate(cur.passport.issuedAt) : ''}${cur.passport.deptCode ? ' (' + esc(cur.passport.deptCode) + ')' : ''}</dd>` : ''}
              ${cur.passport?.issuedBy ? `<dt>Кем выдан</dt><dd>${esc(cur.passport.issuedBy)}</dd>` : ''}
              ${cur.passport?.birthDate ? `<dt>Дата рождения</dt><dd>${fmtDate(cur.passport.birthDate)}</dd>` : ''}
              ${cur.passport?.regAddress ? `<dt>Регистрация</dt><dd>${esc(cur.passport.regAddress)}</dd>` : ''}
              <dt>Объект</dt><dd>${esc(cur.site || '—')}</dd>
              <dt>Выдан</dt><dd>${fmtDateTime(cur.takenAt)}${cur.manager ? ' · ' + esc(cur.manager) : ''}</dd>
              <dt>Вернуть до</dt><dd style="${isOverdue(t) ? 'color:#dc2626;font-weight:800' : ''}">${fmtDate(cur.dueAt)}${(cur.extensions || []).length ? ' (продлевалась)' : ''}</dd>
              <dt>Дней в аренде</dt><dd>${rentalDays(cur)}</dd>
              ${rentalCost(t, cur) ? `<dt>Начислено</dt><dd><b>${fmtMoney(rentalCost(t, cur))}</b></dd>` : ''}
            </dl>
            <div class="actions-row" style="margin-top:12px">
              <button class="btn btn--outline btn--sm" id="actExtend">${icon('alarm')} Продлить аренду</button>
            </div>
          </div>` : ''}

          <div class="panel">
            <h3>${icon('wrench')} История ТО (${(t.maintenance || []).length})${(() => { const mi = maintInfo(t); return mi ? ` <span class="tool-card__cat" style="font-weight:600">· наработка ${mi.used} из ${mi.every}</span>` : ''; })()}</h3>
            ${renderMaintenance(t)}
          </div>

          <div class="panel">
            <h3>${icon('list')} История аренд (${(t.rentals || []).length})</h3>
            ${renderRentals(t)}
          </div>

          ${isAdmin() ? `
          <div class="panel">
            <button class="btn btn--outline btn--sm" id="actDelete" style="color:#dc2626;border-color:#f3c2c2">${icon('trash')} Удалить инструмент</button>
          </div>` : ''}
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
    if ($('#actExtend')) $('#actExtend').addEventListener('click', () => openExtendForm(t));
    $('#actMaint').addEventListener('click', () => openMaintForm(t));
    if ($('#actStatus')) $('#actStatus').addEventListener('click', () => openStatusForm(t));
    if ($('#actEdit')) $('#actEdit').addEventListener('click', () => openToolForm(t));
    if ($('#actCopies')) $('#actCopies').addEventListener('click', () => openCopiesForm(t));

    // Фото: загрузка/замена/удаление
    $('#photoBtn').addEventListener('click', () => $('#photoInput').click());
    $('#photoInput').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      toast('Загружаю фото…');
      try {
        const dataUrl = await resizeImage(file);
        store.update(t.id, { photo: dataUrl });
        toast('Фото сохранено'); router();
      } catch (err) { toast('Не удалось обработать фото', 'err'); }
    });
    if ($('#photoDel')) $('#photoDel').addEventListener('click', () => {
      store.update(t.id, { photo: '' }); toast('Фото убрано'); router();
    });

    if ($('#actDelete')) $('#actDelete').addEventListener('click', () => {
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
        <div class="timeline__title">${icon('user')} ${esc(r.renter)}${r.phone ? ' · ' + esc(r.phone) : ''}</div>
        ${r.amount != null ? `<div class="timeline__sub">${fmtMoney(r.amount)} за ${rentalDays(r)} сут.${r.paid === false ? ' · <b style="color:#dc2626">не оплачено</b>' : ''}</div>` : ''}
        ${(r.extensions || []).length ? `<div class="timeline__sub">Продлевалась: ${r.extensions.map(x => 'до ' + fmtDate(x.to)).join(', ')}</div>` : ''}
        ${r.passport?.series ? `<div class="timeline__sub">Паспорт: ${esc(r.passport.series)}</div>` : ''}
        ${(r.manager || r.returnedBy) ? `<div class="timeline__sub">${r.manager ? 'Выдал: ' + esc(r.manager) : ''}${r.manager && r.returnedBy ? ' · ' : ''}${r.returnedBy ? 'Принял: ' + esc(r.returnedBy) : ''}</div>` : ''}
        ${r.site ? `<div class="timeline__sub">Объект: ${esc(r.site)}</div>` : ''}
        ${r.note ? `<div class="timeline__sub">${esc(r.note)}</div>` : ''}
      </li>`).join('')}</ul>`;
  }

  // =========================================================
  //  АНАЛИТИКА
  // =========================================================
  function renderStats(view) {
    const tools = store.tools();
    const overdue = tools.filter(isOverdue).sort((a, b) => daysOverdue(b) - daysOverdue(a));
    const rented = tools.filter(t => t.status === 'rented');

    // Арендаторы: сколько держат сейчас и сколько брали всего
    const renters = {};
    tools.forEach(t => {
      (t.rentals || []).forEach(r => {
        const k = (r.renter || '—').trim();
        renters[k] = renters[k] || { name: k, total: 0, current: 0 };
        renters[k].total++;
      });
      const cur = currentRental(t);
      if (cur) { const k = (cur.renter || '—').trim(); if (renters[k]) renters[k].current++; }
    });
    const topRenters = Object.values(renters).sort((a, b) => b.total - a.total).slice(0, 10);

    // Занятость: по числу аренд
    const byUsage = tools.slice().sort((a, b) => (b.rentals || []).length - (a.rentals || []).length);
    const mostUsed = byUsage.filter(t => (t.rentals || []).length > 0).slice(0, 8);
    const neverUsed = tools.filter(t => !(t.rentals || []).length).length;
    const totalRentals = tools.reduce((s, t) => s + (t.rentals || []).length, 0);
    const utilPct = tools.length ? Math.round(rented.length / tools.length * 100) : 0;

    // Касса: суммы из закрытых аренд (по местной дате возврата)
    const localDay = (iso) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const today = todayStr();
    const rev = { today: 0, week: 0, month: 0, total: 0, debt: 0 };
    tools.forEach(t => (t.rentals || []).forEach(r => {
      if (r.amount == null) return;
      if (r.paid === false) { rev.debt += r.amount; return; }
      rev.total += r.amount;
      const dstr = localDay(r.returnedAt || r.takenAt);
      const age = (new Date(today) - new Date(dstr)) / 86400000;
      if (dstr === today) rev.today += r.amount;
      if (age < 7) rev.week += r.amount;
      if (age < 30) rev.month += r.amount;
    }));
    const byRevenue = tools.map(t => ({
      t, sum: (t.rentals || []).reduce((s, r) => s + ((r.paid !== false && r.amount) ? r.amount : 0), 0),
    })).filter(x => x.sum > 0).sort((a, b) => b.sum - a.sum).slice(0, 8);

    // Пора на ТО
    const maintDue = tools.map(t => ({ t, mi: maintInfo(t) })).filter(x => x.mi && x.mi.due);

    view.innerHTML = `
      <a href="#/" class="back-link">← Назад к каталогу</a>
      <div class="page-head">
        <div><span class="eyebrow">Сводка по парку</span><h1>Аналитика <span>проката</span></h1></div>
      </div>

      <div class="stats">
        <div class="stat stat--rented"><div class="stat__num">${rented.length}</div><div class="stat__label">Сейчас в аренде</div></div>
        <div class="stat ${overdue.length ? 'stat--over' : ''}"><div class="stat__num">${overdue.length}</div><div class="stat__label">Просрочено</div></div>
        <div class="stat"><div class="stat__num">${utilPct}%</div><div class="stat__label">Занятость парка</div></div>
        <div class="stat"><div class="stat__num">${totalRentals}</div><div class="stat__label">Всего выдач</div></div>
        <div class="stat"><div class="stat__num">${neverUsed}</div><div class="stat__label">Ни разу не брали</div></div>
      </div>

      <h3 style="margin:18px 0 10px">${icon('trend')} Касса</h3>
      <div class="stats">
        <div class="stat"><div class="stat__num">${fmtMoney(rev.today)}</div><div class="stat__label">Сегодня</div></div>
        <div class="stat"><div class="stat__num">${fmtMoney(rev.week)}</div><div class="stat__label">За 7 дней</div></div>
        <div class="stat"><div class="stat__num">${fmtMoney(rev.month)}</div><div class="stat__label">За 30 дней</div></div>
        <div class="stat"><div class="stat__num">${fmtMoney(rev.total)}</div><div class="stat__label">За всё время</div></div>
        <div class="stat ${rev.debt ? 'stat--over' : ''}"><div class="stat__num">${fmtMoney(rev.debt)}</div><div class="stat__label">Долги (не оплачено)</div></div>
      </div>

      <div class="stats-cols">
        <div class="panel">
          <h3>${icon('alarm')} Просрочки (${overdue.length})</h3>
          ${overdue.length ? `<ul class="stat-list">${overdue.map(t => {
            const c = currentRental(t);
            return `<li data-id="${t.id}"><div><b>${esc(t.name)}</b>${t.inventoryNo ? ` · №${esc(t.inventoryNo)}` : ''}<div class="stat-list__sub">${icon('user')} ${esc(c.renter)}${c.phone ? ' · ' + esc(c.phone) : ''}</div></div><span class="over-pill">${daysOverdue(t)} дн.</span></li>`;
          }).join('')}</ul>` : `<p class="tool-card__cat">Просрочек нет.</p>`}
        </div>

        <div class="panel">
          <h3>${dot('var(--orange)')} Сейчас в аренде (${rented.length})</h3>
          ${rented.length ? `<ul class="stat-list">${rented.map(t => {
            const c = currentRental(t);
            return `<li data-id="${t.id}"><div><b>${esc(t.name)}</b><div class="stat-list__sub">${icon('user')} ${esc(c.renter)} · с ${fmtDate(c.takenAt)}</div></div><span class="tool-card__cat">${c.dueAt ? 'до ' + fmtDate(c.dueAt) : ''}</span></li>`;
          }).join('')}</ul>` : `<p class="tool-card__cat">Всё в наличии.</p>`}
        </div>

        <div class="panel">
          <h3>${icon('users')} Топ арендаторов</h3>
          ${topRenters.length ? `<ul class="stat-list">${topRenters.map(r => `
            <li><div><b>${esc(r.name)}</b><div class="stat-list__sub">${r.current ? 'сейчас держит: ' + r.current : 'нет на руках'}</div></div><span class="count-pill">${r.total} выдач</span></li>`).join('')}</ul>`
            : `<p class="tool-card__cat">Пока нет данных по аренде.</p>`}
        </div>

        <div class="panel">
          <h3>${icon('trend')} Доход по инструментам</h3>
          ${byRevenue.length ? `<ul class="stat-list">${byRevenue.map(x => `
            <li data-id="${x.t.id}"><div><b>${esc(x.t.name)}</b><div class="stat-list__sub">${(x.t.rentals || []).length} аренд</div></div><span class="count-pill">${fmtMoney(x.sum)}</span></li>`).join('')}</ul>`
            : `<p class="tool-card__cat">Пока нет оплаченных возвратов — суммы появятся после первого возврата с указанной суммой.</p>`}
        </div>

        <div class="panel">
          <h3>${icon('wrench')} Пора на ТО (${maintDue.length})</h3>
          ${maintDue.length ? `<ul class="stat-list">${maintDue.map(x => `
            <li data-id="${x.t.id}"><div><b>${esc(x.t.name)}</b>${x.t.inventoryNo ? ` · №${esc(x.t.inventoryNo)}` : ''}<div class="stat-list__sub">выдача заблокирована до отметки ТО</div></div><span class="over-pill">${x.mi.used}/${x.mi.every}</span></li>`).join('')}</ul>`
            : `<p class="tool-card__cat">Наработка в норме у всех отслеживаемых.</p>`}
        </div>

        <div class="panel">
          <h3>${icon('trend')} Самые востребованные</h3>
          ${mostUsed.length ? `<ul class="stat-list">${mostUsed.map(t => `
            <li data-id="${t.id}"><div><b>${esc(t.name)}</b><div class="stat-list__sub">${esc(t.category || '')}</div></div><span class="count-pill">${(t.rentals || []).length} аренд</span></li>`).join('')}</ul>`
            : `<p class="tool-card__cat">Пока никто ничего не брал.</p>`}
        </div>
      </div>
    `;

    view.querySelectorAll('.stat-list li[data-id]').forEach(li =>
      li.addEventListener('click', () => { location.hash = '#/t/' + li.dataset.id; }));
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
        <div class="field-row">
          ${field('Серийный №', `<input name="serialNo" value="${esc(t?.serialNo || '')}" placeholder="SN-12345">`)}
          ${field('ТО каждые N аренд', `<input name="maintEvery" type="number" min="0" value="${esc(t?.maintEvery || '')}" placeholder="7">`, 'Пусто — не отслеживать')}
        </div>
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
        maintEvery: f.get('maintEvery').trim(),
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

  // База клиентов из истории аренд: имя → последние известные телефон и паспорт.
  // Используется для автозаполнения формы выдачи.
  const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  function clientsIndex() {
    const rentals = [];
    store.tools().forEach(t => (t.rentals || []).forEach(r => {
      if ((r.renter || '').trim()) rentals.push(r);
    }));
    rentals.sort((a, b) => (a.takenAt || '').localeCompare(b.takenAt || ''));
    const map = {};
    rentals.forEach(r => {
      const name = r.renter.trim();
      const c = map[normName(name)] || (map[normName(name)] = {});
      c.name = name;
      if (r.phone) c.phone = r.phone;
      if (r.passport && Object.values(r.passport).some(v => v)) c.passport = r.passport;
    });
    return map;
  }
  const fmtPassSeries = (v) => {
    const d = String(v || '').replace(/\D/g, '').slice(0, 10);
    return d.length > 4 ? d.slice(0, 4) + ' ' + d.slice(4) : d;
  };
  const fmtDeptCode = (v) => {
    const d = String(v || '').replace(/\D/g, '').slice(0, 6);
    return d.length > 3 ? d.slice(0, 3) + '-' + d.slice(3) : d;
  };

  // =========================================================
  //  РАСПОЗНАВАНИЕ ПАСПОРТА РФ ПО ФОТО (Tesseract.js, офлайн)
  //  Читаем машиночитаемую зону (2 строки внизу разворота).
  // =========================================================
  // Транслитерация МЧЗ внутреннего паспорта РФ → кириллица (включая цифровые коды букв)
  const MRZ_CYR = {
    A: 'А', B: 'Б', V: 'В', G: 'Г', D: 'Д', E: 'Е', '2': 'Ё', J: 'Ж', Z: 'З', I: 'И',
    Q: 'Й', K: 'К', L: 'Л', M: 'М', N: 'Н', O: 'О', P: 'П', R: 'Р', S: 'С', T: 'Т',
    U: 'У', F: 'Ф', H: 'Х', C: 'Ц', '3': 'Ч', '4': 'Ш', W: 'Щ', X: 'Ъ', Y: 'Ы',
    '9': 'Ь', '6': 'Э', '8': 'Ю', '7': 'Я',
  };
  const mrzToCyr = (s) => {
    const w = [...String(s)].map(c => MRZ_CYR[c] || '').join('');
    return w ? w[0] + w.slice(1).toLowerCase() : '';
  };
  // Контрольная цифра МЧЗ: веса 7-3-1, A=10…Z=35, '<'=0
  const mrzCheck = (s) => [...s].reduce((sum, c, i) =>
    sum + (c === '<' ? 0 : (c >= '0' && c <= '9' ? +c : c.charCodeAt(0) - 55)) * [7, 3, 1][i % 3], 0) % 10;

  function parseMRZ(raw) {
    const lines = String(raw).toUpperCase().split('\n')
      .map(l => l.replace(/[^A-Z0-9<]/g, '')).filter(l => l.length >= 28);
    let l1 = '', l2 = '';
    for (let i = 0; i < lines.length; i++) {
      if (/^P[NM<]/.test(lines[i]) && lines[i + 1]) { l1 = lines[i]; l2 = lines[i + 1]; break; }
    }
    if (!l2) { // запасной поиск: строка, начинающаяся с 7+ цифр — вторая строка МЧЗ
      const idx = lines.findIndex(l => /^\d{7}/.test(l.replace(/O/g, '0').replace(/I/g, '1')));
      if (idx >= 0) { l2 = lines[idx]; l1 = idx > 0 ? lines[idx - 1] : ''; }
    }
    if (!l2) return null;
    // Якоря: «PNRUS» в начале первой строки, «RUS» на позициях 11–13 второй —
    // отрезаем мусор, попавший в строку слева от МЧЗ.
    const a1 = l1.search(/P[NM]RU[S5]/);
    if (a1 > 0) l1 = l1.slice(a1);
    const a2 = l2.replace(/5/g, 'S').indexOf('RUS');
    if (a2 >= 10) l2 = l2.slice(a2 - 10);
    l1 = l1.padEnd(44, '<'); l2 = l2.padEnd(44, '<');
    try { window.__mrzLines = { l1, l2 }; } catch (e) {}
    // Типовые путаницы OCR в цифровых полях
    const dig = (s) => s.replace(/[OQ]/g, '0').replace(/[IL]/g, '1').replace(/B/g, '8')
      .replace(/S/g, '5').replace(/Z/g, '2').replace(/G/g, '6');
    const docField = dig(l2.slice(0, 9));   // 3 первые цифры серии + номер
    const birth = dig(l2.slice(13, 19));
    if (!/^\d{9}$/.test(docField) || !/^\d{6}$/.test(birth)) return null;
    // Личное поле (4-я цифра серии + дата выдачи + код подразделения): позиции 29–42,
    // но OCR может «съесть» заполнитель «<» и сдвинуть строку — поэтому пробуем и якорь:
    // длинную цифровую последовательность после заполнителей. Выбираем вариант,
    // где дата выдачи правдоподобна, а код подразделения цел.
    const pCands = [dig(l2.slice(28, 41))];
    const am = l2.slice(20).match(/<+([0-9OQILBSZG]{7,13})/);
    if (am) pCands.push(dig(am[1]));
    let personal = pCands[0], pBest = -1;
    for (const p of pCands) {
      const is = p.slice(1, 7), mm = +is.slice(2, 4), dd = +is.slice(4, 6);
      let score = 0;
      if (/^\d/.test(p)) score += 1;
      if (/^\d{6}$/.test(is) && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) score += 2;
      if (/^\d{6}$/.test(p.slice(7, 13))) score += 1;
      if (score > pBest) { pBest = score; personal = p; }
    }
    const valid = mrzCheck(l2.slice(0, 9)) === +dig(l2[9]) && mrzCheck(l2.slice(13, 19)) === +dig(l2[19]);
    let lastName = '', firstName = '', midName = '';
    const m = l1.match(/^P[A-Z<][A-Z<]{3}(.+)$/);
    if (m) {
      const parts = m[1].split('<<');
      lastName = mrzToCyr(parts[0] || '');
      const given = (parts[1] || '').split('<').filter(Boolean);
      firstName = mrzToCyr(given[0] || '');
      midName = mrzToCyr(given[1] || '');
    }
    const curYY = new Date().getFullYear() % 100;
    const date = (yymmdd, pivot) => {
      if (!/^\d{6}$/.test(yymmdd)) return '';
      const yy = +yymmdd.slice(0, 2), mm = +yymmdd.slice(2, 4), dd = +yymmdd.slice(4, 6);
      if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return '';
      return `${yy > pivot ? 1900 + yy : 2000 + yy}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
    };
    const series4 = /^\d/.test(personal) ? personal[0] : '';
    const issue = personal.slice(1, 7), dept = personal.slice(7, 13);
    return {
      lastName, firstName, midName,
      series: docField.slice(0, 3) + series4,
      number: docField.slice(3, 9),
      birthDate: date(birth, curYY),        // рождение — не в будущем
      issueDate: date(issue, 96),           // паспорта РФ выдаются с 1997 года
      deptCode: /^\d{6}$/.test(dept) ? dept.slice(0, 3) + '-' + dept.slice(3) : '',
      valid,
    };
  }

  let passWorkerPromise = null;
  let passProgress = null; // колбэк прогресса текущего сканирования
  function getPassWorker() {
    if (!passWorkerPromise) {
      const base = new URL('vendor/tesseract/', location.href).href;
      // ocrb — модель, обученная на шрифте OCR-B (им печатается МЧЗ); eng — подстраховка
      passWorkerPromise = Tesseract.createWorker('ocrb+eng', 1, {
        workerPath: base + 'worker.min.js',
        corePath: base,
        langPath: base.replace(/\/$/, ''),
        gzip: true,
        logger: (msg) => { if (passProgress) passProgress(msg); },
      }).then(async (w) => {
        await w.setParameters({
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
          tessedit_pageseg_mode: '6',
          user_defined_dpi: '300',
        });
        return w;
      });
      passWorkerPromise.catch(() => { passWorkerPromise = null; });
    }
    return passWorkerPromise;
  }

  const fileToImage = (file) => new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('bad image')); };
    img.src = url;
  });

  // Кадр для OCR: вырезка + масштаб + серый с растяжкой контраста;
  // mode 'bin' — дополнительно адаптивная бинаризация (убирает узор и водяные знаки).
  function prepCanvas(img, fromY, height, mode, angleDeg) {
    const sw = img.naturalWidth, sh = img.naturalHeight;
    const outW = Math.round(Math.min(2200, Math.max(1600, sw)));
    const sy = Math.floor(sh * fromY), sHeight = Math.ceil(sh * height);
    const c = document.createElement('canvas');
    c.width = outW; c.height = Math.round(sHeight * outW / sw);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    if (angleDeg) {
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate(angleDeg * Math.PI / 180);
      ctx.translate(-c.width / 2, -c.height / 2);
    }
    ctx.drawImage(img, 0, sy, sw, sHeight, 0, 0, c.width, c.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const id = ctx.getImageData(0, 0, c.width, c.height);
    const d = id.data, W = c.width, H = c.height, n = W * H;
    const gray = new Uint8ClampedArray(n);
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      const g = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
      gray[i] = g; hist[g]++;
    }
    // Растяжка контраста по 2-му и 98-му перцентилям
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.98) { hi = v; break; } }
    const range = Math.max(1, hi - lo);
    for (let i = 0; i < n; i++) gray[i] = Math.max(0, Math.min(255, Math.round((gray[i] - lo) * 255 / range)));

    if (mode === 'bin') {
      // Локальный порог по среднему в окне (через интегральное изображение)
      const integ = new Float64Array((W + 1) * (H + 1));
      for (let y = 0; y < H; y++) {
        let rowSum = 0;
        for (let x = 0; x < W; x++) {
          rowSum += gray[y * W + x];
          integ[(y + 1) * (W + 1) + (x + 1)] = integ[y * (W + 1) + (x + 1)] + rowSum;
        }
      }
      const win = Math.max(16, Math.round(W / 40));
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const x1 = Math.max(0, x - win), x2 = Math.min(W - 1, x + win);
          const y1 = Math.max(0, y - win), y2 = Math.min(H - 1, y + win);
          const area = (x2 - x1 + 1) * (y2 - y1 + 1);
          const sum = integ[(y2 + 1) * (W + 1) + (x2 + 1)] - integ[y1 * (W + 1) + (x2 + 1)]
                    - integ[(y2 + 1) * (W + 1) + x1] + integ[y1 * (W + 1) + x1];
          const px = gray[y * W + x] < (sum / area) * 0.82 ? 0 : 255;
          const o = (y * W + x) * 4;
          d[o] = d[o + 1] = d[o + 2] = px;
        }
      }
    } else {
      for (let i = 0; i < n; i++) { const o = i * 4; d[o] = d[o + 1] = d[o + 2] = gray[i]; }
    }
    ctx.putImageData(id, 0, 0);
    return c;
  }

  // Поиск полосы МЧЗ на бинаризованном кадре: две плотные строки текста у низа.
  function findMrzBand(binCanvas) {
    const W = binCanvas.width, H = binCanvas.height;
    const d = binCanvas.getContext('2d').getImageData(0, 0, W, H).data;
    const step = 2, cols = Math.ceil(W / step);
    const dens = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      let c = 0;
      for (let x = 0; x < W; x += step) if (d[(y * W + x) * 4] < 128) c++;
      dens[y] = c / cols;
    }
    const sm = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      let s = 0, k = 0;
      for (let dy = -2; dy <= 2; dy++) { const yy = y + dy; if (yy >= 0 && yy < H) { s += dens[yy]; k++; } }
      sm[y] = s / k;
    }
    let peak = 0;
    for (let y = 0; y < H; y++) peak = Math.max(peak, sm[y]);
    const thr = Math.max(0.05, peak * 0.4);
    const runs = [];
    let start = -1;
    for (let y = 0; y <= H; y++) {
      const on = y < H && sm[y] > thr;
      if (on && start < 0) start = y;
      if (!on && start >= 0) { if (y - start >= 3) runs.push([start, y - 1]); start = -1; }
    }
    if (!runs.length) return null;
    const last = runs[runs.length - 1];
    let y1 = last[0];
    const y2 = last[1];
    const lh = y2 - y1 + 1;
    const prev = runs[runs.length - 2];
    if (prev && (y1 - prev[1]) < lh * 2.5) y1 = prev[0]; // вторая строка МЧЗ рядом сверху
    if ((y2 - y1) < H * 0.02 || (y2 - y1) > H * 0.3) return null; // неправдоподобная высота
    return { y1, y2, peak }; // peak — метрика «горизонтальности» строк (для выравнивания)
  }

  // Вырезаем найденную полосу с запасом и укрупняем — OCR читает крупный текст надёжнее
  function zoomBand(srcCanvas, band) {
    const pad = Math.round((band.y2 - band.y1) * 0.35) + 4;
    const y1 = Math.max(0, band.y1 - pad), y2 = Math.min(srcCanvas.height, band.y2 + pad);
    const h = y2 - y1;
    const scale = Math.min(2.5, 2600 / srcCanvas.width);
    const c = document.createElement('canvas');
    c.width = Math.round(srcCanvas.width * scale);
    c.height = Math.round(h * scale);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcCanvas, 0, y1, srcCanvas.width, h, 0, 0, c.width, c.height);
    return c;
  }

  // Слияние результатов разных проходов: приоритет — валидным контрольным цифрам,
  // пустые поля добираем из другого прохода.
  function mergeParsed(a, b) {
    if (!a) return b;
    if (!b) return a;
    const [p, s] = (b.valid && !a.valid) ? [b, a] : [a, b];
    const out = { ...p };
    for (const k of ['lastName', 'firstName', 'midName', 'series', 'number', 'birthDate', 'issueDate', 'deptCode']) {
      if (!out[k]) out[k] = s[k];
    }
    if ((out.series || '').length < 4 && (s.series || '').length === 4) out.series = s.series;
    out.valid = a.valid || b.valid;
    return out;
  }

  // Облачное распознавание: фото → Edge Function → нейросеть с компьютерным зрением.
  // Читает всю страницу (включая «Кем выдан» и место рождения), а не только МЧЗ.
  // Фото → JPEG base64: ужимаем до 1600px по длинной стороне, при необходимости
  // поворачиваем (для штампов, снятых боком)
  async function fileToJpegBase64(file, rotateDeg) {
    const img = await fileToImage(file);
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas');
    const deg = rotateDeg || 0;
    if (deg === 90 || deg === 270) { c.width = h; c.height = w; }
    else { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    return c.toDataURL('image/jpeg', 0.85).split(',')[1];
  }

  async function recognizePassportCloud(file, mode, rotateDeg) {
    const url = window.APP_CONFIG && window.APP_CONFIG.CLOUD_OCR_URL;
    if (!url || !navigator.onLine) return null;
    const image = await fileToJpegBase64(file, rotateDeg);
    const token = await authToken();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': window.APP_CONFIG.SUPABASE_ANON_KEY || '',
          ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
        },
        body: JSON.stringify({ image, media_type: 'image/jpeg', mode: mode || undefined }),
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error('облако недоступно (' + resp.status + ')');
      const payload = await resp.json();
      if (payload.error) throw new Error(payload.error);
      return payload.data || null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function recognizePassport(file) {
    if (typeof Tesseract === 'undefined') throw new Error('Модуль распознавания не загружен');
    const worker = await getPassWorker();
    const img = await fileToImage(file);
    // Поиск полосы МЧЗ на разных углах поворота (лечит заваленные кадры).
    // Прямой кадр (угол 0) всегда остаётся в попытках — метрика угла может ошибаться.
    const cands = [];
    for (const a of [0, -2, 2, -4, 4, -6, 6]) {
      const info = findMrzBand(prepCanvas(img, 0.5, 0.5, 'bin', a));
      if (info) cands.push({ angle: a, peak: info.peak, band: info });
    }
    cands.sort((x, y) => y.peak - x.peak);
    const picks = [];
    if (cands[0]) picks.push(cands[0]);
    const zeroCand = cands.find(c => c.angle === 0);
    if (zeroCand && cands[0] !== zeroCand) picks.push(zeroCand);
    try { window.__mrzDebug = { angles: cands.map(c => [c.angle, +c.peak.toFixed(3)]) }; } catch (e) {}
    // Прицельные попытки (укрупнённая полоса; лучшая — построчно в режиме
    // «одна строка», он надёжнее дочитывает хвост), затем запасные кадры целиком.
    const ocr = async (canvas) => {
      if (window.__dbgCanvas) {
        try { (window.__mrzShots = window.__mrzShots || []).push(canvas.toDataURL('image/png')); } catch (e) {}
      }
      return (await worker.recognize(canvas)).data.text || '';
    };
    const ocrLines = async (canvas) => {
      // режем полосу пополам и читаем каждую строку отдельно (PSM 7)
      await worker.setParameters({ tessedit_pageseg_mode: '7' });
      const half = (sy, sh2) => {
        const h = document.createElement('canvas');
        h.width = canvas.width; h.height = sh2;
        h.getContext('2d').drawImage(canvas, 0, sy, canvas.width, sh2, 0, 0, canvas.width, sh2);
        return h;
      };
      const mid = Math.round(canvas.height / 2);
      const t1 = await ocr(half(0, mid));
      const t2 = await ocr(half(mid, canvas.height - mid));
      await worker.setParameters({ tessedit_pageseg_mode: '6' });
      return t1.trim() + '\n' + t2.trim();
    };
    const attempts = [];
    for (const p of picks) {
      const mk = (mode) => zoomBand(prepCanvas(img, 0.5, 0.5, mode, p.angle), p.band);
      if (p === picks[0]) attempts.push(() => ocrLines(mk('bin')), () => ocrLines(mk('gray')));
      attempts.push(() => ocr(mk('bin')), () => ocr(mk('gray')));
    }
    attempts.push(
      () => ocr(prepCanvas(img, 0.5, 0.5, 'bin', 0)),
      () => ocr(prepCanvas(img, 0.5, 0.5, 'gray', 0)),
      () => ocr(prepCanvas(img, 0, 1, 'bin', 0)),
      () => ocr(prepCanvas(img, 0, 1, 'gray', 0)),
    );
    // ФИО подтверждаем голосованием проходов: одиночный проход может принять
    // заполнитель «<» за букву — ждём, пока два прохода сойдутся на одном варианте.
    let best = null;
    const votes = { lastName: {}, firstName: {}, midName: {} };
    const top = (k) => Object.entries(votes[k]).sort((a, b) => b[1] - a[1])[0] || null;
    const confirmed = (k) => { const t = top(k); return !t || t[1] >= 2; }; // нет вариантов — тоже «решено»
    for (let i = 0; i < attempts.length; i++) {
      if (passProgress) passProgress({ status: 'attempt', attempt: i + 1, total: attempts.length });
      const parsed = parseMRZ(await attempts[i]());
      console.debug('MRZ pass', i + 1, JSON.stringify(parsed));
      if (parsed) for (const k of Object.keys(votes)) {
        // голос прохода с сошедшимися контрольными цифрами весит вдвое больше
        if (parsed[k]) votes[k][parsed[k]] = (votes[k][parsed[k]] || 0) + (parsed.valid ? 2 : 1);
      }
      best = mergeParsed(best, parsed);
      if (best && best.valid && best.issueDate && best.deptCode
          && top('lastName') && top('lastName')[1] >= 2
          && confirmed('firstName') && confirmed('midName')) break;
    }
    if (best) for (const k of Object.keys(votes)) {
      const t = top(k);
      if (t) best[k] = t[0]; // самый частый вариант каждой части ФИО
    }
    return best;
  }

  // Профиль сотрудника: имя, выход; для администратора — управление сотрудниками
  function openUserForm() {
    if (!currentProfile) return;
    const admin = isAdmin();
    modal.open(`
      <h2>Профиль</h2>
      <p class="tool-card__cat" style="margin-top:-10px">${esc(currentProfile.email)} · ${admin ? 'администратор' : 'менеджер'}</p>
      <form id="userForm">
        ${field('Ваше имя', `<input name="mname" required value="${esc(managerName())}" placeholder="Александр">`)}
        <button class="btn btn--outline btn--sm btn--block" type="submit">Сохранить имя</button>
      </form>
      <button class="btn btn--outline btn--sm btn--block" id="logoutBtn" style="margin-top:10px">Выйти из аккаунта</button>
      ${admin ? `
      <div class="role-box">
        <div class="role-box__row"><b>Заявки на регистрацию</b></div>
        <div id="pendingList" class="staff-list"><p class="tool-card__cat">Загружаю…</p></div>
        <div class="role-box__row" style="margin-top:14px"><b>Сотрудники</b></div>
        <div id="staffList" class="staff-list"><p class="tool-card__cat">Загружаю…</p></div>
        <form id="staffAdd" style="margin-top:14px;border-top:1px dashed var(--line);padding-top:12px">
          <div class="role-box__row"><b>Новый сотрудник</b></div>
          ${field('Имя *', `<input name="sname" required placeholder="Александр">`)}
          <div class="field-row">
            ${field('Почта (логин) *', `<input name="semail" type="email" required placeholder="sasha@arenda.ru">`)}
            ${field('Пароль *', `<input name="spass" required minlength="6" placeholder="От 6 символов">`)}
          </div>
          ${field('Роль', `<select name="srole"><option value="manager">Менеджер</option><option value="admin">Администратор</option></select>`)}
          <button class="btn btn--primary btn--block" type="submit">Создать аккаунт</button>
        </form>
      </div>` : ''}
    `);
    $('#userForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = new FormData(e.target).get('mname').trim();
      if (!name) return;
      try {
        const { error } = await sync.client.from('profiles').update({ name }).eq('id', currentProfile.id);
        if (error) throw error;
        currentProfile.name = name;
        localStorage.setItem(PROFILE_KEY, JSON.stringify(currentProfile));
        updateUserBtn(); toast('Имя сохранено');
      } catch (err) { toast('Не удалось сохранить: ' + err.message, 'err'); }
    });
    $('#logoutBtn').addEventListener('click', async () => {
      try { await sync.client.auth.signOut(); } catch {}
      localStorage.removeItem(PROFILE_KEY);
      location.reload();
    });
    if (admin) { loadPendingList(); loadStaffList(); }
  }

  async function loadPendingList() {
    const box = $('#pendingList');
    if (!box) return;
    try {
      const { pending } = await adminApi({ action: 'list_pending' });
      if (!pending.length) {
        box.innerHTML = '<p class="tool-card__cat">Новых заявок нет.</p>';
        return;
      }
      box.innerHTML = pending.map(u => `
        <div class="staff-row" data-id="${u.id}">
          <div class="staff-row__info">
            <b>${esc(u.name || 'Без имени')}</b>
            <span>${esc(u.email)}</span>
          </div>
          <div class="staff-row__actions">
            <button class="btn btn--primary btn--sm" data-act="approve">Принять</button>
            <button class="btn btn--outline btn--sm" data-act="reject" style="color:#dc2626;border-color:#f3c2c2">Отклонить</button>
          </div>
        </div>`).join('');
      box.onclick = async (e) => {
        const btn = e.target.closest('[data-act]'); if (!btn) return;
        const id = btn.closest('.staff-row').dataset.id;
        const u = pending.find(x => x.id === id); if (!u) return;
        try {
          if (btn.dataset.act === 'approve') {
            await adminApi({ action: 'approve', id, role: 'manager' });
            toast('Принят как менеджер: ' + (u.name || u.email));
          } else {
            if (!confirm('Отклонить и удалить заявку «' + (u.name || u.email) + '»?')) return;
            await adminApi({ action: 'reject', id });
            toast('Заявка отклонена');
          }
          loadPendingList(); loadStaffList();
        } catch (err) { toast(err.message, 'err'); }
      };
    } catch (err) {
      box.innerHTML = `<p class="tool-card__cat">Не удалось загрузить: ${esc(err.message)}</p>`;
    }
  }

  async function loadStaffList() {
    const box = $('#staffList');
    if (!box) return;
    try {
      const { users } = await adminApi({ action: 'list' });
      box.innerHTML = users.map(u => `
        <div class="staff-row" data-id="${u.id}">
          <div class="staff-row__info">
            <b>${esc(u.name)}</b>
            <span>${esc(u.email)} · ${u.role === 'admin' ? 'администратор' : 'менеджер'}</span>
          </div>
          ${u.id === currentProfile.id ? '<span class="tool-card__cat">это вы</span>' : `
          <div class="staff-row__actions">
            <button class="btn btn--outline btn--sm" data-act="role">${u.role === 'admin' ? 'Сделать менеджером' : 'Сделать админом'}</button>
            <button class="btn btn--outline btn--sm" data-act="pass">Пароль</button>
            <button class="btn btn--outline btn--sm" data-act="del" style="color:#dc2626;border-color:#f3c2c2">Удалить</button>
          </div>`}
        </div>`).join('') || '<p class="tool-card__cat">Пока только вы.</p>';
      box.onclick = async (e) => {
        const btn = e.target.closest('[data-act]'); if (!btn) return;
        const row = btn.closest('.staff-row');
        const id = row.dataset.id;
        const u = users.find(x => x.id === id); if (!u) return;
        try {
          if (btn.dataset.act === 'role') {
            await adminApi({ action: 'set_role', id, role: u.role === 'admin' ? 'manager' : 'admin' });
            toast('Роль изменена'); loadStaffList();
          } else if (btn.dataset.act === 'pass') {
            const p = prompt('Новый пароль для «' + u.name + '» (от 6 символов):');
            if (p === null) return;
            await adminApi({ action: 'reset_password', id, password: p });
            toast('Пароль обновлён — сообщите его сотруднику');
          } else if (btn.dataset.act === 'del') {
            if (!confirm('Удалить аккаунт «' + u.name + '»?')) return;
            await adminApi({ action: 'delete', id });
            toast('Аккаунт удалён'); loadStaffList();
          }
        } catch (err) { toast(err.message, 'err'); }
      };
    } catch (err) {
      box.innerHTML = `<p class="tool-card__cat">Не удалось загрузить: ${esc(err.message)}</p>`;
    }
    // форма создания
    const form = $('#staffAdd');
    if (form && !form.dataset.wired) {
      form.dataset.wired = '1';
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        try {
          await adminApi({
            action: 'create',
            name: f.get('sname').trim(),
            email: f.get('semail').trim(),
            password: f.get('spass'),
            role: f.get('srole'),
          });
          toast('Аккаунт создан — сообщите сотруднику логин и пароль');
          e.target.reset();
          loadStaffList();
        } catch (err) { toast(err.message, 'err'); }
      });
    }
  }

  function openRentForm(t) {
    const miGuard = maintInfo(t);
    if (miGuard && miGuard.due) {
      toast(`Наработка ${miGuard.used} из ${miGuard.every} аренд — сначала проведите ТО`, 'err');
      openMaintForm(t);
      return;
    }
    const clients = clientsIndex();
    const names = Object.values(clients).map(c => c.name).sort((a, b) => a.localeCompare(b, 'ru'));
    modal.open(`
      <h2>Выдать в аренду</h2>
      <p class="tool-card__cat" style="margin-top:-10px">${esc(t.name)}</p>
      <form id="rentForm">
        ${field('Арендатор *', `<input name="renter" required list="renterList" autocomplete="off" placeholder="Иван Петров / ООО Стройка">`,
          names.length ? 'Начните вводить — знакомый клиент подставится вместе с паспортом.' : '')}
        <datalist id="renterList">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
        <div class="field-row">
          ${field('Телефон', `<input name="phone" type="tel" placeholder="+7 …">`)}
          ${field('Вернуть до', `<input name="dueAt" type="date" value="${todayInput()}">`)}
        </div>
        <details class="pass-details">
          <summary>${icon('user')} Паспортные данные (РФ)</summary>
          <div class="field">
            <button type="button" class="btn btn--outline btn--sm btn--block" id="passScanBtn">${icon('camera')} Распознать по фото паспорта</button>
            <input type="file" id="passScanFile" accept="image/*" hidden>
            <div class="hint">Сфотографируйте разворот с фото так, чтобы были видны две строки символов внизу.</div>
          </div>
          <div class="field-row">
            ${field('Серия и номер', `<input name="passSeries" inputmode="numeric" placeholder="1234 567890">`)}
            ${field('Дата выдачи', `<input name="passIssuedAt" type="date">`)}
          </div>
          ${field('Кем выдан', `<input name="passIssuedBy" placeholder="ГУ МВД России по Тюменской области">`)}
          <div class="field-row">
            ${field('Код подразделения', `<input name="passDeptCode" inputmode="numeric" placeholder="720-001">`)}
            ${field('Дата рождения', `<input name="birthDate" type="date">`)}
          </div>
          ${field('Адрес регистрации', `<input name="regAddress" placeholder="г. Тюмень, ул. …">`)}
          <div class="field">
            <button type="button" class="btn btn--outline btn--sm btn--block" id="addrScanBtn">${icon('camera')} Распознать прописку по фото штампа</button>
            <input type="file" id="addrScanFile" accept="image/*" hidden>
            <div class="hint">Страница со штампом «ЗАРЕГИСТРИРОВАН» (5-я). Почерк — проверьте результат.</div>
          </div>
        </details>
        ${field('Объект / адрес', `<input name="site" placeholder="ЖК Северный, корп. 3">`)}
        ${field('Примечание', `<textarea name="note" rows="2" placeholder="Залог, комплект…"></textarea>`)}
        <button class="btn btn--primary btn--block" type="submit">${icon('handout')} Выдать</button>
      </form>
    `);

    const form = $('#rentForm');
    const el = (n) => form.querySelector(`[name=${n}]`);

    // Маски: серия/номер «#### ######», код подразделения «###-###»
    el('passSeries').addEventListener('input', (e) => { e.target.value = fmtPassSeries(e.target.value); });
    el('passDeptCode').addEventListener('input', (e) => { e.target.value = fmtDeptCode(e.target.value); });

    // Распознавание прописки по фото штампа «ЗАРЕГИСТРИРОВАН» (только облако:
    // рукописный текст локальному OCR не по зубам)
    const addrBtn = form.querySelector('#addrScanBtn');
    const addrFile = form.querySelector('#addrScanFile');
    const addrLabel = addrBtn.innerHTML;
    addrBtn.addEventListener('click', () => addrFile.click());
    addrFile.addEventListener('change', async () => {
      const file = addrFile.files[0];
      addrFile.value = '';
      if (!file) return;
      if (!navigator.onLine) { toast('Для распознавания прописки нужен интернет', 'err'); return; }
      addrBtn.disabled = true;
      try {
        // Штамп часто фотографируют боком — перебираем ориентации,
        // пока адрес не соберётся уверенно
        let best = null;
        for (const deg of [0, 90, 270, 180]) {
          addrBtn.textContent = deg ? `Распознаю штамп (поворот ${deg}°)…` : 'Распознаю штамп…';
          let r = null;
          try { r = await recognizePassportCloud(file, 'address', deg); } catch (e) { console.warn('поворот ' + deg + '°:', e); }
          if (r && r.reg_address) {
            const score = (r.reg_address.match(/,/g) || []).length * 2
              + (r.confidence === 'high' ? 10 : r.confidence === 'medium' ? 5 : 0);
            if (!best || score > best.score) best = { r, score };
            if (r.confidence !== 'low') break;
          }
        }
        if (best) {
          el('regAddress').value = best.r.reg_address;
          if (best.r.confidence === 'high') toast('Прописка распознана — сверьте с почерком');
          else toast('Прописка распознана не полностью — проверьте и допишите', 'err');
        } else {
          toast('Штамп не распознан — попробуйте более чёткое фото', 'err');
        }
      } catch (err) {
        console.error(err);
        toast('Ошибка распознавания: ' + err.message, 'err');
      } finally {
        addrBtn.disabled = false;
        addrBtn.innerHTML = addrLabel;
      }
    });

    // Распознавание паспорта по фото (МЧЗ)
    const scanBtn = form.querySelector('#passScanBtn');
    const scanFile = form.querySelector('#passScanFile');
    const scanLabel = scanBtn.innerHTML;
    scanBtn.addEventListener('click', () => scanFile.click());
    scanFile.addEventListener('change', async () => {
      const file = scanFile.files[0];
      scanFile.value = '';
      if (!file) return;
      scanBtn.disabled = true;
      let attempt = 0, attempts = 0;
      passProgress = (m) => {
        if (m.status === 'attempt') {
          attempt = m.attempt; attempts = m.total;
          scanBtn.textContent = `Распознаю… проход ${attempt}/${attempts}`;
        } else if (m.status === 'recognizing text') {
          scanBtn.textContent = `Распознаю… проход ${attempt || 1}${attempts ? '/' + attempts : ''} · ${Math.round((m.progress || 0) * 100)}%`;
        } else if (!attempt) {
          scanBtn.textContent = 'Загрузка модуля…';
        }
      };
      try {
        // 1) Облако: нейросеть читает всю страницу, включая «Кем выдан»
        let cloud = null;
        try {
          scanBtn.textContent = 'Распознаю в облаке…';
          cloud = await recognizePassportCloud(file);
        } catch (cloudErr) {
          console.warn('Облачное распознавание не сработало, локальный запасной вариант:', cloudErr);
        }
        if (cloud && (cloud.last_name || cloud.series)) {
          const fio = [cloud.last_name, cloud.first_name, cloud.middle_name].filter(Boolean).join(' ');
          if (fio) el('renter').value = fio;
          if (cloud.series && cloud.number) el('passSeries').value = fmtPassSeries(cloud.series + cloud.number);
          if (cloud.issue_date) el('passIssuedAt').value = cloud.issue_date;
          if (cloud.issued_by) el('passIssuedBy').value = cloud.issued_by;
          if (cloud.dept_code) el('passDeptCode').value = fmtDeptCode(cloud.dept_code);
          if (cloud.birth_date) el('birthDate').value = cloud.birth_date;
          form.querySelector('.pass-details').open = true;
          // Полным считаем результат, только если есть всё, что умеет дочитывать МЧЗ
          // («Кем выдан» не в счёт — его в МЧЗ нет, локально не дочитаешь)
          const complete = cloud.last_name && cloud.first_name && cloud.series && cloud.number
            && cloud.issue_date && cloud.birth_date && cloud.dept_code;
          if (complete && cloud.confidence === 'high') { toast('Паспорт распознан'); return; }
          if (complete) { toast('Распознано — проверьте данные (фото не идеальное)', 'err'); return; }
          // облако прочитало не всё — дочитываем недостающее по МЧЗ локально
        }

        // 2) Локальный OCR по МЧЗ: запасной вариант офлайн и «дочитывание» за облаком.
        //    Заполняет только пустые поля; если контрольные цифры МЧЗ сошлись —
        //    серия/номер и даты из МЧЗ надёжнее облачной догадки и перекрывают её.
        const p = await recognizePassport(file);
        if (!p) {
          if (!cloud) toast('Не удалось прочитать МЧЗ — попробуйте более чёткое фото', 'err');
          else toast('Распознано не полностью — проверьте данные', 'err');
          return;
        }
        const fio = [p.lastName, p.firstName, p.midName].filter(Boolean).join(' ');
        const curFio = el('renter').value.trim();
        if (fio && fio.split(' ').length > (curFio ? curFio.split(' ').length : 0)) el('renter').value = fio;
        const setIfEmpty = (n, v) => { if (v && !el(n).value) el(n).value = v; };
        if (p.valid && p.series.length === 4 && p.number) {
          el('passSeries').value = p.series + ' ' + p.number; // подтверждено контрольными цифрами
        } else if (p.series.length === 4 && p.number) {
          setIfEmpty('passSeries', p.series + ' ' + p.number);
        }
        if (p.valid && p.issueDate) el('passIssuedAt').value = p.issueDate;
        else setIfEmpty('passIssuedAt', p.issueDate);
        setIfEmpty('passDeptCode', p.deptCode);
        if (p.valid && p.birthDate) el('birthDate').value = p.birthDate;
        else setIfEmpty('birthDate', p.birthDate);
        form.querySelector('.pass-details').open = true;
        if (p.valid) toast('Паспорт распознан');
        else toast('Распознано не полностью — проверьте данные', 'err');
      } catch (err) {
        console.error(err);
        toast('Ошибка распознавания: ' + err.message, 'err');
      } finally {
        passProgress = null;
        scanBtn.disabled = false;
        scanBtn.innerHTML = scanLabel;
      }
    });

    // Автозаполнение по известному клиенту
    let lastFilled = '';
    const tryFill = () => {
      const k = normName(el('renter').value);
      const c = clients[k];
      if (!c || k === lastFilled) return;
      lastFilled = k;
      const set = (n, v) => { if (v) el(n).value = v; };
      set('phone', c.phone);
      const p = c.passport || {};
      set('passSeries', p.series); set('passIssuedAt', p.issuedAt); set('passIssuedBy', p.issuedBy);
      set('passDeptCode', p.deptCode); set('birthDate', p.birthDate); set('regAddress', p.regAddress);
      if (c.passport) form.querySelector('.pass-details').open = true;
      toast('Данные клиента подставлены из истории');
    };
    el('renter').addEventListener('input', tryFill);
    el('renter').addEventListener('change', tryFill);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!managerName()) { toast('Сначала представьтесь — кнопка с человечком в шапке', 'err'); return; }
      const f = new FormData(e.target);
      const renter = f.get('renter').trim(); if (!renter) return;
      const rental = {
        id: rid(), renter, manager: managerName(), phone: f.get('phone').trim(), site: f.get('site').trim(),
        dueAt: f.get('dueAt'), note: f.get('note').trim(), takenAt: nowISO(), returnedAt: null,
      };
      const passport = {
        series: f.get('passSeries').trim(), issuedAt: f.get('passIssuedAt'),
        issuedBy: f.get('passIssuedBy').trim(), deptCode: f.get('passDeptCode').trim(),
        birthDate: f.get('birthDate'), regAddress: f.get('regAddress').trim(),
      };
      if (Object.values(passport).some(v => v)) rental.passport = passport;
      t.rentals = t.rentals || []; t.rentals.push(rental);
      store.update(t.id, { status: 'rented', rentals: t.rentals });
      modal.close(); toast('Выдано в аренду'); router();
    });
  }

  function openReturnForm(t) {
    const cur = currentRental(t);
    if (!cur) { toast('Активная аренда не найдена', 'err'); return; }
    const days = rentalDays(cur);
    const price = parseFloat(t.dailyPrice) || 0;
    const cost = rentalCost(t, cur);
    modal.open(`
      <h2>Принять возврат</h2>
      <p class="tool-card__cat" style="margin-top:-10px">${esc(t.name)} · от ${esc(cur.renter)}</p>
      <form id="retForm">
        <div class="field-row">
          ${field('Сумма к оплате, ₽', `<input name="amount" type="number" min="0" step="1" value="${cost || ''}">`,
            price ? `${days} сут. × ${fmtMoney(price)} — можно поправить` : `${days} сут., тариф не задан`)}
          ${field('Оплата', `<select name="paid">
            <option value="1">Оплачено</option>
            <option value="0">Не оплачено (долг)</option>
          </select>`)}
        </div>
        ${field('Состояние при возврате', `<select name="condition">
          <option value="ok">Исправен — в наличии</option>
          <option value="maintenance">Требует ТО</option>
          <option value="broken">Неисправен</option>
        </select>`)}
        ${field('Примечание', `<textarea name="note" rows="2" placeholder="Замечания по возврату…"></textarea>`)}
        <button class="btn btn--primary btn--block" type="submit">${icon('inbox')} Принять</button>
      </form>
    `);
    $('#retForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      cur.returnedAt = nowISO();
      if (managerName()) cur.returnedBy = managerName();
      const amountStr = String(f.get('amount')).trim();
      if (amountStr !== '') {
        cur.amount = Math.max(0, parseFloat(amountStr) || 0);
        cur.paid = f.get('paid') === '1';
      }
      const note = f.get('note').trim();
      if (note) cur.note = (cur.note ? cur.note + ' | ' : '') + 'Возврат: ' + note;
      const cond = f.get('condition');
      const newStatus = cond === 'ok' ? 'available' : cond;
      store.update(t.id, { status: newStatus, rentals: t.rentals });
      modal.close(); toast('Возврат принят'); router();
    });
  }

  function openExtendForm(t) {
    const cur = currentRental(t);
    if (!cur) { toast('Активная аренда не найдена', 'err'); return; }
    modal.open(`
      <h2>Продлить аренду</h2>
      <p class="tool-card__cat" style="margin-top:-10px">${esc(t.name)} · ${esc(cur.renter)}</p>
      <form id="extForm">
        ${field('Вернуть до (новая дата)', `<input name="dueAt" type="date" required value="${cur.dueAt || todayInput()}">`,
          cur.dueAt ? 'Сейчас: до ' + fmtDate(cur.dueAt) : '')}
        <button class="btn btn--primary btn--block" type="submit">${icon('alarm')} Продлить</button>
      </form>
    `);
    $('#extForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const dueAt = new FormData(e.target).get('dueAt');
      if (!dueAt) return;
      cur.extensions = cur.extensions || [];
      cur.extensions.push({ from: cur.dueAt || '', to: dueAt, at: nowISO(), by: managerName() });
      cur.dueAt = dueAt;
      store.update(t.id, { rentals: t.rentals });
      modal.close(); toast('Аренда продлена до ' + fmtDate(dueAt)); router();
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
        ${field('Мастер', `<input name="master" value="${esc(managerName())}" placeholder="Кто проводил">`)}
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

  // Следующий инвентарный номер: "0042"→0043, "A-100"→A-101 (сохраняет ведущие нули)
  function nextInv(base, i) {
    const m = String(base).match(/^(\D*?)(\d+)(\D*)$/);
    if (!m) return i === 0 ? String(base) : `${base}-${i + 1}`;
    const num = String(parseInt(m[2], 10) + i).padStart(m[2].length, '0');
    return m[1] + num + m[3];
  }

  // Создать N копий модели — каждая со своим QR и инвентарным номером
  function openCopiesForm(t) {
    modal.open(`
      <h2>Создать копии</h2>
      <p class="tool-card__cat" style="margin-top:-10px">${esc(t.name)}</p>
      <form id="copyForm">
        <div class="field-row">
          ${field('Сколько копий', `<input name="count" type="number" min="1" max="50" value="3" required>`)}
          ${field('Инв. № с', `<input name="startInv" placeholder="напр. 0042">`, 'нумеруются по порядку')}
        </div>
        <div class="field"><label><input type="checkbox" name="withPhoto" checked style="width:auto;margin-right:8px">Скопировать фото и характеристики</label></div>
        <button class="btn btn--primary btn--block" type="submit">Создать</button>
      </form>
    `);
    $('#copyForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const n = Math.max(1, Math.min(50, parseInt(f.get('count'), 10) || 1));
      const startInv = f.get('startInv').trim();
      const withPhoto = f.get('withPhoto') === 'on';
      for (let i = 0; i < n; i++) {
        store.add({
          id: uid(), status: 'available', createdAt: nowISO(),
          name: t.name, category: t.category,
          inventoryNo: startInv ? nextInv(startInv, i) : '',
          serialNo: '', dailyPrice: t.dailyPrice || '', priceText: t.priceText || '',
          desc: withPhoto ? (t.desc || '') : '', specs: withPhoto ? (t.specs || []) : [],
          photo: withPhoto ? (t.photo || '') : '',
          notes: '', rentals: [], maintenance: [],
        });
      }
      modal.close(); toast(`Создано копий: ${n}`); location.hash = '#/'; router();
    });
  }

  // Массовое проставление инвентарных номеров
  function openBulkInvForm() {
    modal.open(`
      <h2>Инвентарные номера</h2>
      <form id="invForm">
        ${field('Начать с номера', `<input name="start" value="0001" required>`, 'например 0001 — далее по порядку 0002, 0003…')}
        ${field('Кому проставить', `<select name="scope">
          <option value="empty">Только без номера</option>
          <option value="visible">Видимым сейчас (${visibleTools().length})</option>
          <option value="all">Всем (${store.tools().length})</option>
        </select>`)}
        <button class="btn btn--primary btn--block" type="submit">Проставить</button>
      </form>
    `);
    $('#invForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const start = f.get('start').trim() || '0001';
      const scope = f.get('scope');
      let targets = scope === 'all' ? store.tools().slice()
        : scope === 'visible' ? visibleTools()
        : store.tools().filter(t => !t.inventoryNo);
      if (!targets.length) { toast('Нет подходящих позиций', 'err'); return; }
      targets.forEach((t, i) => store.update(t.id, { inventoryNo: nextInv(start, i) }));
      modal.close(); toast(`Проставлено номеров: ${targets.length}`); router();
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

  // QR как dataURL для печати листа наклеек
  function makeQrDataUrl(text) {
    const tmp = document.createElement('div');
    new QRCode(tmp, { text, width: 240, height: 240, colorDark: '#1a1d22', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
    return qrImage(tmp);
  }
  function qrTextFor(t) {
    return (location.origin && location.origin !== 'null')
      ? `${location.origin}${location.pathname}#/t/${t.id}` : t.id;
  }
  // Печать листа наклеек (сетка QR) для текущей выборки каталога
  function printLabels(list) {
    if (!list || !list.length) { toast('Нет инструментов для печати', 'err'); return; }
    const cells = list.map(t => `
      <div class="lbl">
        <img src="${makeQrDataUrl(qrTextFor(t))}">
        <div class="lbl__name">${esc(t.name)}</div>
        <div class="lbl__inv">${t.inventoryNo ? '№ ' + esc(t.inventoryNo) : ''}</div>
        <div class="lbl__id">${esc(t.id)}</div>
      </div>`).join('');
    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>Наклейки QR (${list.length})</title><style>
      *{box-sizing:border-box} body{font-family:Manrope,system-ui,sans-serif;margin:0;padding:8mm}
      h1{font-size:16px;margin:0 0 6mm}
      .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:5mm}
      .lbl{border:1px dashed #c4c4c4;border-radius:8px;padding:8px;text-align:center;page-break-inside:avoid}
      .lbl img{width:40mm;height:40mm}
      .lbl__name{font-weight:800;font-size:11px;margin-top:4px;line-height:1.2}
      .lbl__inv{font-weight:700;font-size:13px;margin-top:2px}
      .lbl__id{font-family:monospace;color:#aaa;font-size:8px;margin-top:2px}
      @media print{ h1{display:none} }
      </style></head><body>
      <h1>Наклейки QR — ${list.length} шт. (печать → вырезать по пунктиру)</h1>
      <div class="grid">${cells}</div>
      <script>onload=()=>setTimeout(()=>print(),400)<\/script></body></html>`);
    w.document.close();
  }

  // =========================================================
  //  СКАНЕР QR
  // =========================================================
  function openScanner() {
    if (!currentProfile) { toast('Сначала войдите в аккаунт', 'err'); return; }
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
      $('#reader').innerHTML = `<p class="empty">${icon('camera', 'ic-xl')}<br>Нет доступа к камере.<br><span class="tool-card__cat">${esc(String(err))}</span><br>Используйте ручной ввод.</p>`;
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

  // ---------- Тёмная / светлая тема ----------
  function setTheme(theme) {
    const dark = theme === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : '';
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) {}
    const tc = document.getElementById('themeColor'); if (tc) tc.setAttribute('content', dark ? '#15171c' : '#1a1d22');
    const btn = document.getElementById('themeToggle'); if (btn) btn.innerHTML = icon(dark ? 'sun' : 'moon');
  }
  (function initTheme() {
    let saved = null; try { saved = localStorage.getItem('theme'); } catch (e) {}
    setTheme(saved === 'dark' ? 'dark' : 'light');
    const btn = document.getElementById('themeToggle');
    if (btn) btn.addEventListener('click', () =>
      setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  })();

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
  $('#userBtn').addEventListener('click', () => { if (currentProfile) openUserForm(); });

  async function start() {
    store.load();

    const synced = await sync.init();
    if (!synced) {                      // бэкенд не настроен — локальный режим без входа
      currentProfile = { id: 'local', email: '', name: 'Локальный режим', role: 'admin' };
      updateUserBtn();
      render(true);
      ensureCatalog();
      setStatus('local');
      render(false);
      return;
    }

    // ---- Вход обязателен ----
    const { data: sessData } = await sync.client.auth.getSession();
    const session = sessData && sessData.session;
    if (!session) {
      let needsBootstrap = false;
      try { needsBootstrap = !!(await adminApi({ action: 'status' })).needsBootstrap; } catch {}
      setStatus('local');
      renderAuthScreen(needsBootstrap);
      return;
    }
    sync.client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') { localStorage.removeItem(PROFILE_KEY); location.reload(); }
    });
    await loadProfile(session.user.id);
    if (!currentProfile) {
      // аккаунт без профиля: либо заявка ещё не одобрена, либо аккаунт удалён
      setStatus('local');
      renderPendingScreen(session.user.email);
      return;
    }
    updateUserBtn();
    render(true);                       // мгновенный рендер из локального кэша

    try {
      const remote = await sync.pullAll();
      if (remote.length === 0) {
        // Общая база пуста → заполняем каталогом ОДИН раз для всех устройств
        store.muted = true;
        store.data.tools = [];
        seedFromCatalog();
        store.muted = false;
        await sync.pushAll(store.tools());
      } else {
        store.data.tools = remote;      // общая база — источник истины
        store.save();
      }
      sync.subscribe(handleRemote);     // мгновенные обновления с других устройств
      setStatus('online');
      render(false);
      setInterval(pollSync, 12000);     // резервная подкачка каждые 12 сек
      document.addEventListener('visibilitychange', () => { if (!document.hidden) pollSync(); });
    } catch (e) {
      console.warn('Не удалось получить общую базу, работаем из кэша:', e);
      ensureCatalog();
      setStatus('offline');
      render(false);
    }
  }

  start();
})();
