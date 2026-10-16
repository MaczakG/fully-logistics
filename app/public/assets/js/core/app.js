/* App shell: first-run setup, login, sidebar menu, top bar, hash router.
   Views register themselves in views/*.js:

     FL.view('orders', {
       title: 'Megrendelések',
       async render(root, ctx) { ... }   // root: an empty <section>; ctx: { params, query, path }
     });

   Routes are "#/<route>/<param>/<param>?a=1". The menu below decides the order, route, icon and
   which permission module guards each view. A view without "view" permission is hidden from the
   menu and its route shows a message instead. */
(() => {
  'use strict';
  const FL = window.FL;
  const { html, raw, ui } = FL;

  const MENU = [
    [
      { key: 'inbound', route: 'betarolas', label: 'Betárolás', icon: 'tray-arrow-down' },
      { key: 'orders', route: 'megrendelesek', label: 'Megrendelések', icon: 'clipboard-text' },
      { key: 'picking', route: 'komissio', label: 'Komissió', icon: 'scan' },
      { key: 'counts', route: 'leltar', label: 'Leltár', icon: 'list-checks' },
      { key: 'stock', route: 'keszlet', label: 'Készlet', icon: 'stack' },
      { key: 'history', route: 'rendelestortenet', label: 'Rendeléstörténet', icon: 'clock-counter-clockwise' },
      { key: 'transport', route: 'fuvarszervezes', label: 'Fuvarszervezés', icon: 'truck' },
    ],
    [
      { key: 'partners', route: 'partnerek', label: 'Partnerek', icon: 'handshake' },
      { key: 'quotes', route: 'ajanlatkeszito', label: 'Ajánlatkészítő', icon: 'calculator' },
      { key: 'billing', route: 'elszamolas', label: 'Elszámolás', icon: 'invoice' },
    ],
    [
      { key: 'settings', route: 'beallitasok', label: 'Beállítások', icon: 'gear-six' },
      { key: 'users', route: 'felhasznalok', label: 'Felhasználók', icon: 'users-three' },
    ],
  ];
  const ITEMS = MENU.flat();
  const byRoute = Object.fromEntries(ITEMS.map((i) => [i.route, i]));
  FL.routes = Object.fromEntries(ITEMS.map((i) => [i.key, `#/${i.route}`]));

  FL.views = FL.views || {};
  FL.view = (key, def) => { FL.views[key] = def; };
  FL.state = { me: null, permissions: {}, meta: null };
  FL.app = {};

  const appEl = () => document.getElementById('app');
  const BRAND = '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect width="32" height="32" fill="#E8BE3C"/><path d="M8 7h17v5.5H14v3.5h9v5.5h-9V26H8z" fill="#121518"/></svg>';

  /* ------------------------------------------------------------ navigation */
  FL.go = (hash) => {
    if (location.hash === hash) render();
    else location.hash = hash;
  };
  FL.reload = () => render();
  FL.setTitle = (text) => {
    const t = document.querySelector('.topbar__title');
    if (t) t.textContent = text;
    document.title = `${text} | Fully Logistics WMS`;
  };

  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, query = ''] = raw.split('?');
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    return { route: parts[0] || '', params: parts.slice(1), query: new URLSearchParams(query), path };
  }

  /* ------------------------------------------------------------ auth screens */
  function authScreen(title, sub, body) {
    appEl().removeAttribute('aria-busy');
    appEl().innerHTML = String(html`<main class="auth"><div class="auth__card">
      <div class="hazard" aria-hidden="true"></div>
      <div class="auth__body">
        <div class="auth__brand">${raw(BRAND)}<div><b>Fully Logistics</b><span>WMS</span></div></div>
        <div><h1>${title}</h1>${sub ? html`<p class="muted">${sub}</p>` : ''}</div>
        ${body}
      </div></div></main>`);
  }

  function showLogin(message) {
    authScreen('Bejelentkezés', 'A raktárkezelő rendszer csak munkatársaknak érhető el.', html`
      <form class="form" id="login-form" novalidate>
        ${message ? ui.notice(message, 'info') : ''}
        ${ui.field({ name: 'email', label: 'E-mail cím', type: 'email', required: true, autocomplete: 'username' })}
        ${ui.field({ name: 'password', label: 'Jelszó', type: 'password', required: true, autocomplete: 'current-password' })}
        <button class="btn btn--primary btn--lg" type="submit">Belépés ${FL.icon('arrow-right')}</button>
      </form>`);
    const form = document.getElementById('login-form');
    form.querySelector('input[name="email"]').focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      btn.setAttribute('aria-busy', 'true');
      try {
        await FL.api.post('/api/auth/login', ui.formValues(form));
        await start();
      } catch (err) {
        ui.showErrors(form, err);
      } finally {
        btn.removeAttribute('aria-busy');
      }
    });
  }

  function showSetup(status) {
    authScreen('Első indítás', 'Hozd létre az első adminisztrátort. Ő tudja majd felvenni a többi munkatársat.', html`
      ${status.tokenConfigured ? '' : ui.notice('A Worker beállításaiban még nincs megadva a SETUP_TOKEN titok. Állítsd be (app/README.md), és töltsd újra az oldalt.', 'warn')}
      <form class="form" id="setup-form" novalidate>
        ${ui.field({ name: 'token', label: 'Telepítési kód (SETUP_TOKEN)', type: 'password', required: true })}
        ${ui.field({ name: 'name', label: 'Teljes név', required: true, autocomplete: 'name' })}
        ${ui.field({ name: 'email', label: 'E-mail cím', type: 'email', required: true, autocomplete: 'username' })}
        ${ui.field({ name: 'password', label: 'Jelszó', type: 'password', required: true, autocomplete: 'new-password', hint: 'Legalább 10 karakter.' })}
        <button class="btn btn--primary btn--lg" type="submit">Adminisztrátor létrehozása</button>
      </form>`);
    const form = document.getElementById('setup-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      btn.setAttribute('aria-busy', 'true');
      try {
        await FL.api.post('/api/setup', ui.formValues(form));
        await start();
      } catch (err) {
        ui.showErrors(form, err);
      } finally {
        btn.removeAttribute('aria-busy');
      }
    });
  }

  let loginShown = false;
  FL.app.onUnauthorized = () => {
    if (loginShown) return;
    loginShown = true;
    showLogin('A munkamenet lejárt. Jelentkezz be újra.');
  };

  FL.app.requirePasswordChange = () => changePassword(true);

  function changePassword(forced = false) {
    return ui.dialog({
      title: forced ? 'Új jelszó beállítása' : 'Jelszó módosítása',
      size: 'narrow',
      submitLabel: 'Jelszó mentése',
      body: html`
        ${forced ? ui.notice('A folytatáshoz állíts be saját jelszót.', 'info') : ''}
        ${ui.field({ name: 'current', label: forced ? 'Kapott (ideiglenes) jelszó' : 'Jelenlegi jelszó', type: 'password', required: true, autocomplete: 'current-password' })}
        ${ui.field({ name: 'next', label: 'Új jelszó', type: 'password', required: true, autocomplete: 'new-password', hint: 'Legalább 10 karakter.' })}`,
      onSubmit: async (form) => {
        await FL.api.post('/api/me/password', ui.formValues(form));
        ui.toast('A jelszavad megváltozott.', 'ok');
        if (forced) await start();
      },
    });
  }

  function editProfile() {
    const u = FL.state.me.user;
    ui.dialog({
      title: 'Profil',
      size: 'narrow',
      body: html`
        ${ui.field({ name: 'name', label: 'Név', value: u.name, required: true })}
        ${ui.field({ name: 'phone', label: 'Telefon', type: 'tel', value: u.phone, optional: true })}
        <p class="small muted">E-mail: ${u.email} · Szerepkör: ${u.role.name}</p>`,
      onSubmit: async (form) => {
        FL.state.me = await FL.api.patch('/api/me', ui.formValues(form));
        renderShell();
        render();
        ui.toast('Profil mentve.', 'ok');
      },
    });
  }

  /* ------------------------------------------------------------ shell */
  function visibleItems() {
    return MENU.map((group) => group.filter((i) => FL.can(i.key, 'view'))).filter((g) => g.length);
  }

  function renderShell() {
    const me = FL.state.me;
    appEl().removeAttribute('aria-busy');
    appEl().innerHTML = String(html`<div class="shell">
      <aside class="sidebar" id="sidebar" aria-label="Főmenü">
        <a class="sidebar__brand" href="#/">${raw(BRAND)}<span class="sidebar__name">Fully Logistics<span>WMS</span></span></a>
        <nav aria-label="Modulok">
          ${visibleItems().map((group) => html`<ul class="menu-group">${group.map((i) => html`
            <li><a class="menu-link" href="#/${i.route}" data-route="${i.route}">${FL.icon(i.icon)}<span>${i.label}</span></a></li>`)}</ul>`)}
        </nav>
        <div class="sidebar__foot">
          <p>${me.company.name}</p>
          <p><a href="https://fully.hu" target="_blank" rel="noopener">fully.hu</a></p>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="btn btn--ghost btn--icon menu-toggle" type="button" data-action="menu" aria-controls="sidebar" aria-expanded="false" aria-label="Menü megnyitása">${FL.icon('list')}</button>
          <p class="topbar__title"></p>
          <span class="topbar__spacer"></span>
          <span class="cutoff" id="cutoff" title="Napi rendelési határidő: az eddig beérkező rendelések még aznap feladhatók"></span>
          <button class="btn btn--ghost btn--icon" type="button" data-action="theme" aria-label="Téma váltása">${FL.icon('moon')}</button>
          <div class="user-menu">
            <button class="user-menu__btn" type="button" data-action="user" aria-haspopup="true" aria-expanded="false" aria-controls="user-pop">
              ${FL.icon('user-circle')}<span class="user-menu__text">${me.user.name} <span class="user-menu__role">${me.user.role.name}</span></span>${FL.icon('caret-down')}
            </button>
            <div class="popover" id="user-pop" hidden>
              <button type="button" data-action="profile">${FL.icon('identification-card')}Profil</button>
              <button type="button" data-action="password">${FL.icon('key')}Jelszó módosítása</button>
              <hr>
              <button type="button" data-action="logout">${FL.icon('sign-out')}Kijelentkezés</button>
            </div>
          </div>
        </header>
        <main class="content" id="content" tabindex="-1"></main>
      </div>
    </div>`);

    const root = appEl();
    const pop = root.querySelector('#user-pop');
    const userBtn = root.querySelector('[data-action="user"]');
    const menuBtn = root.querySelector('[data-action="menu"]');
    const setMenu = (open) => { root.dataset.menu = open ? 'open' : ''; menuBtn.setAttribute('aria-expanded', String(open)); };
    ui.bind(root.querySelector('.topbar'), {
      menu: () => setMenu(root.dataset.menu !== 'open'),
      theme: () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem('fl-theme', next); } catch { /* storage blocked */ }
        updateThemeIcon();
      },
      user: () => { pop.hidden = !pop.hidden; userBtn.setAttribute('aria-expanded', String(!pop.hidden)); },
      profile: () => { pop.hidden = true; editProfile(); },
      password: () => { pop.hidden = true; changePassword(false); },
      logout: async () => {
        await FL.api.post('/api/auth/logout').catch(() => {});
        FL.state.me = null;
        loginShown = true;
        showLogin('Kijelentkeztél.');
      },
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.user-menu')) { pop.hidden = true; userBtn.setAttribute('aria-expanded', 'false'); } });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { pop.hidden = true; setMenu(false); } });
    root.querySelector('#sidebar').addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
    updateThemeIcon();
    tickCutoff();
  }

  function updateThemeIcon() {
    const btn = document.querySelector('[data-action="theme"]');
    if (!btn) return;
    const dark = document.documentElement.dataset.theme === 'dark';
    btn.innerHTML = String(FL.icon(dark ? 'sun' : 'moon'));
    btn.setAttribute('aria-label', dark ? 'Váltás világos témára' : 'Váltás sötét témára');
  }

  // Daily cut-off countdown in the top bar (hazard stripes in the last 30 minutes).
  let cutoffTimer;
  function tickCutoff() {
    clearTimeout(cutoffTimer);
    const el = document.getElementById('cutoff');
    if (!el || !FL.state.me) return;
    const [h, m] = (FL.state.me.warehouse.cutoff || '14:00').split(':').map(Number);
    const now = new Date();
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Budapest', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).map((p) => [p.type, p.value]));
    const minutesNow = Number(parts.hour) * 60 + Number(parts.minute);
    const left = h * 60 + m - minutesNow;
    const cut = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    if (left > 0) {
      const hh = Math.floor(left / 60);
      const mm = left % 60;
      el.dataset.state = left <= 30 ? 'soon' : 'open';
      el.innerHTML = String(html`${FL.icon('timer')}<span class="cutoff__label">Zárás ${cut}</span> <b>${hh ? `${hh} ó ` : ''}${mm} p</b>`);
    } else {
      el.dataset.state = 'passed';
      el.innerHTML = String(html`${FL.icon('timer')}<span class="cutoff__label">Mai zárás ${cut}</span> <b>lezárva</b>`);
    }
    cutoffTimer = setTimeout(tickCutoff, 30 * 1000);
  }

  /* ------------------------------------------------------------ router */
  let current = null;
  async function render() {
    if (!FL.state.me) return;
    const content = document.getElementById('content');
    if (!content) return;
    const { route, params, query, path } = parseHash();
    if (!route) {
      const first = visibleItems().flat()[0];
      if (first) location.replace(`#/${first.route}`);
      else content.innerHTML = String(ui.empty('A szerepköröd egyik modulhoz sem ad hozzáférést. Kérj jogosultságot az adminisztrátortól.', 'lock-simple'));
      return;
    }
    const item = byRoute[route];
    document.querySelectorAll('.menu-link').forEach((a) => { if (a.dataset.route === route) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    if (current && current.destroy) { try { current.destroy(); } catch { /* ignore */ } }
    current = null;
    const section = document.createElement('section');
    content.replaceChildren(section);
    if (!item) {
      FL.setTitle('Nem található');
      section.innerHTML = String(ui.empty('Ez az oldal nem létezik.', 'warning-circle'));
      return;
    }
    FL.setTitle(item.label);
    if (!FL.can(item.key, 'view')) {
      section.innerHTML = String(ui.empty(`Nincs jogosultságod a(z) ${item.label} modulhoz.`, 'lock-simple'));
      return;
    }
    const view = FL.views[item.key];
    if (!view) {
      section.innerHTML = String(ui.empty('Ez a modul még készül.', 'wrench'));
      return;
    }
    section.innerHTML = String(ui.loading());
    try {
      const out = await view.render(section, { params, query, path, route: item });
      current = out || null;
      content.focus({ preventScroll: true });
    } catch (err) {
      if (err instanceof FL.ApiError && err.status === 401) return;
      console.error(err);
      section.innerHTML = String(ui.notice(err && err.message ? err.message : 'Hiba történt az oldal betöltésekor.', 'danger'));
    }
  }

  /* ------------------------------------------------------------ boot */
  async function start() {
    loginShown = false;
    try {
      FL.state.me = await FL.api.get('/api/me');
    } catch (err) {
      if (err.status === 401) { loginShown = true; showLogin(); return; }
      if (err.code === 'password_change_required') return;
      authScreen('Hiba', '', ui.notice(err.message, 'danger'));
      return;
    }
    FL.state.permissions = FL.state.me.permissions;
    FL.state.meta = await FL.api.get('/api/meta');
    renderShell();
    if (FL.state.me.user.must_change_password) changePassword(true);
    await render();
  }

  async function boot() {
    try {
      const status = await FL.api.get('/api/setup');
      if (status.needsSetup) { showSetup(status); return; }
    } catch (err) {
      authScreen('A szerver nem érhető el', '', ui.notice(err.message, 'danger'));
      return;
    }
    await start();
  }

  window.addEventListener('hashchange', render);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
