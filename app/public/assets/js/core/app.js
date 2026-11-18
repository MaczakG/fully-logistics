/* App shell: first-run setup, login, top bar with the main menu, hash router.
   Views register themselves in views/*.js:

     FL.view('orders', {
       title: 'Megrendelések',
       async render(root, ctx) { ... }   // root: an empty <section>; ctx: { params, query, path }
     });

   Routes are "#/<route>/<param>/<param>?a=1". MODULES below give each route its view, name and
   the permission module that guards it; MENU is the main menu across the top. An entry without
   "view" permission is hidden from the menu, and its route shows a message instead. */
(() => {
  'use strict';
  const FL = window.FL;
  const { html, ui } = FL;

  const MODULES = [
    { key: 'inbound', route: 'betarolas', label: 'Betárolás' },
    { key: 'orders', route: 'megrendelesek', label: 'Megrendelések' },
    { key: 'picking', route: 'komissio', label: 'Komissió' },
    { key: 'counts', route: 'leltar', label: 'Leltár' },
    { key: 'stock', route: 'keszlet', label: 'Készlet' },
    { key: 'history', route: 'rendelestortenet', label: 'Rendeléstörténet' },
    { key: 'transport', route: 'fuvarszervezes', label: 'Fuvarszervezés' },
    { key: 'partners', route: 'partnerek', label: 'Partnerek' },
    { key: 'quotes', route: 'ajanlatkeszito', label: 'Ajánlatkészítő' },
    { key: 'billing', route: 'elszamolas', label: 'Elszámolás' },
    { key: 'settings', route: 'beallitasok', label: 'Beállítások' },
    { key: 'users', route: 'felhasznalok', label: 'Felhasználók' },
  ];
  // The main menus and their entries; an entry opens a page (path) of a module (key).
  const MENU = [
    { title: 'Mozgások', items: [
      { key: 'inbound', path: 'betarolas', label: 'Betárolás' },
      { key: 'orders', path: 'megrendelesek', label: 'Megrendelések' },
      { key: 'picking', path: 'komissio', label: 'Komissió' },
      { key: 'counts', path: 'leltar', label: 'Leltár' },
      { key: 'transport', path: 'fuvarszervezes', label: 'Futárátadás' },
    ] },
    { title: 'Fuvarszervezés', items: [
      { key: 'transport', path: 'fuvarszervezes/tervezo', label: 'Fuvartervező' },
      { key: 'transport', path: 'fuvarszervezes/teherautok', label: 'Teherautók' },
      { key: 'transport', path: 'fuvarszervezes/fuvarok', label: 'Egyedi fuvarok' },
    ] },
    { title: 'Lekérdezések', items: [
      { key: 'stock', path: 'keszlet', label: 'Készlet' },
      { key: 'stock', path: 'keszlet/mozgasok', label: 'Készletmozgások' },
      { key: 'stock', path: 'keszlet/foglaltsag', label: 'Foglaltság' },
      { key: 'stock', path: 'keszlet/terkep', label: 'Raktártérkép' },
      { key: 'history', path: 'rendelestortenet', label: 'Rendeléstörténet' },
    ] },
    { title: 'Számlázás', items: [
      { key: 'billing', path: 'elszamolas', label: 'Havi elszámolások' },
      { key: 'billing', path: 'elszamolas/tetelek', label: 'Egyedi tételek és munkaórák' },
      { key: 'quotes', path: 'ajanlatkeszito', label: 'Ajánlatok' },
    ] },
    { title: 'Alapadatok', items: [
      { key: 'partners', path: 'partnerek', label: 'Partnerek' },
      { key: 'stock', path: 'keszlet/cikktorzs', label: 'Cikktörzs' },
      { key: 'settings', path: 'beallitasok/raktarhelyek', label: 'Raktárhelyek' },
      { key: 'settings', path: 'beallitasok/meretek', label: 'Méretek' },
      { key: 'settings', path: 'beallitasok/alaptarifak', label: 'Alap tarifák' },
    ] },
    { title: 'Beállítás', items: [
      { key: 'settings', path: 'beallitasok/cegadatok', label: 'Cégadatok' },
      { key: 'settings', path: 'beallitasok/raktar', label: 'Raktár' },
      { key: 'settings', path: 'beallitasok/futarok', label: 'Futárszolgálatok' },
      { key: 'settings', path: 'beallitasok/szamlazo', label: 'Számlázó' },
      { key: 'users', path: 'felhasznalok/lista', label: 'Felhasználók' },
      { key: 'users', path: 'felhasznalok/jogosultsagok', label: 'Jogosultságok' },
      { key: 'settings', path: 'beallitasok/naplo', label: 'Napló' },
    ] },
  ];
  const ENTRIES = MENU.flatMap((g) => g.items.map((i) => ({ ...i, group: g.title })));
  const byRoute = Object.fromEntries(MODULES.map((m) => [m.route, m]));
  FL.routes = Object.fromEntries(MODULES.map((m) => [m.key, `#/${m.route}`]));

  FL.state = { me: null, permissions: {}, meta: null };
  // Phone width: the app works like a hand terminal (PDA). Home screen with big tiles instead of the
  // main menu, a back button in the top bar, large touch targets (css: "PDA" section of app.css).
  const pdaQuery = window.matchMedia('(max-width: 640px)');
  FL.pda = () => pdaQuery.matches;
  FL.app = {};

  const appEl = () => document.getElementById('app');

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
      <div class="auth__body">
        <div class="auth__brand"><div><b>Fully Logistics</b><span>WMS</span></div></div>
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
  function visibleGroups() {
    return MENU.map((g) => ({ ...g, items: g.items.filter((i) => FL.can(i.key, 'view')) })).filter((g) => g.items.length);
  }

  // The menu entry of a page: the longest entry path the page's path starts with (matched). A
  // module's own start page (e.g. #/beallitasok) gets its module's last entry, for the main menu only.
  function entryFor(path) {
    const hits = ENTRIES.filter((e) => path === e.path || path.startsWith(`${e.path}/`));
    if (hits.length) return { ...hits.reduce((a, b) => (b.path.length > a.path.length ? b : a)), matched: true };
    const route = path.split('/')[0];
    const own = ENTRIES.filter((e) => e.path.split('/')[0] === route);
    return own.length ? { ...own[own.length - 1], matched: false } : null;
  }
  function markNav(entry) {
    document.querySelectorAll('.topnav__menu a').forEach((a) => (entry && entry.matched && a.dataset.path === entry.path ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    document.querySelectorAll('.topnav__btn').forEach((b) => b.classList.toggle('is-current', !!entry && b.dataset.group === entry.group));
  }

  function renderShell() {
    const me = FL.state.me;
    appEl().removeAttribute('aria-busy');
    appEl().innerHTML = String(html`<div class="shell">
      <div class="main">
        <header class="topbar">
          <a class="btn btn--ghost btn--icon topbar__back" href="#/" aria-label="Vissza">${FL.icon('arrow-left')}</a>
          <p class="topbar__title"></p>
          <nav class="topnav" aria-label="Főmenü">
            ${visibleGroups().map((g) => html`<div class="topnav__group">
              <button class="topnav__btn" type="button" aria-expanded="false" data-group="${g.title}">${g.title}${FL.icon('caret-down')}</button>
              <ul class="topnav__menu" hidden>${g.items.map((i) => html`<li><a href="#/${i.path}" data-path="${i.path}">${i.label}</a></li>`)}</ul>
            </div>`)}
          </nav>
          <span class="topbar__spacer"></span>
          <span class="cutoff" id="cutoff" data-cutoff title="Napi rendelési határidő: az eddig beérkező rendelések még aznap feladhatók"></span>
          <a class="btn btn--ghost btn--icon topbar__home" href="#/" aria-label="Kezdőképernyő">${FL.icon('squares-four')}</a>
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
    const nav = root.querySelector('.topnav');
    const closeNav = (keep) => nav.querySelectorAll('.topnav__btn').forEach((b) => {
      if (b === keep) return;
      b.setAttribute('aria-expanded', 'false');
      b.nextElementSibling.hidden = true;
    });
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.topnav__btn');
      if (!btn) { if (e.target.closest('a')) closeNav(); return; }
      const open = btn.getAttribute('aria-expanded') !== 'true';
      closeNav(btn);
      btn.setAttribute('aria-expanded', String(open));
      btn.nextElementSibling.hidden = !open;
    });
    ui.bind(root.querySelector('.topbar'), {
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
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.user-menu')) { pop.hidden = true; userBtn.setAttribute('aria-expanded', 'false'); }
      if (!e.target.closest('.topnav')) closeNav();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { pop.hidden = true; closeNav(); } });
    tickCutoff();
    watchScrollRegions(root.querySelector('#content'));
  }

  // Wide tables scroll sideways inside their wrapper (other scroll boxes carry data-scroll). A box
  // that actually scrolls gets tabindex="0", so keyboard users can reach it and scroll it with the
  // arrow keys.
  const SCROLLERS = '.table-wrap, .matrix-wrap, [data-scroll]';
  function watchScrollRegions(content) {
    if (!content) return;
    // Late layout changes (web fonts, images) resize the table without touching the DOM.
    let sizes = null;
    const mark = FL.debounce(() => {
      for (const form of content.querySelectorAll('form.toolbar[data-filters]')) collapsibleFilters(form);
      for (const tr of content.querySelectorAll('.table--cards tfoot tr:not([data-labelled])')) labelFooter(tr);
      for (const el of content.querySelectorAll(SCROLLERS)) {
        if (sizes && el.firstElementChild) sizes.observe(el.firstElementChild);
        const scrolls = el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
        if (scrolls && !el.hasAttribute('tabindex')) { el.tabIndex = 0; el.dataset.flScroll = '1'; }
        else if (!scrolls && el.dataset.flScroll) { el.removeAttribute('tabindex'); delete el.dataset.flScroll; }
      }
    }, 150);
    if (window.ResizeObserver) sizes = new ResizeObserver(mark);
    new MutationObserver(mark).observe(content, { childList: true, subtree: true });
    window.addEventListener('resize', mark);
  }

  // On the phone a filter bar shows only its search field; the other filters open with a button
  // that also tells how many of them are set. Desktop ignores the button (css).
  function collapsibleFilters(form) {
    const fields = [...form.querySelectorAll(':scope > .field')];
    if (fields.length < 3) return;
    const keep = fields.find((f) => f.querySelector('input[type="search"]')) || fields[0];
    const rest = fields.filter((f) => f !== keep);
    keep.classList.add('toolbar__keep');
    const set = rest.filter((f) => [...f.querySelectorAll('input, select')].some((i) => (i.type === 'checkbox' ? i.checked : i.value !== ''))).length;
    let btn = form.querySelector(':scope > .toolbar__toggle');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn toolbar__toggle';
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', () => {
        const open = form.dataset.filtersOpen !== 'true';
        form.dataset.filtersOpen = String(open);
        btn.setAttribute('aria-expanded', String(open));
      });
      keep.after(btn);
    }
    if (btn.dataset.set === String(set)) return;
    btn.dataset.set = String(set);
    btn.innerHTML = String(html`${FL.icon('funnel')}Szűrők${set ? html` <span class="count">${set}</span>` : ''}`);
  }

  // A totals row of a table shown as cards (phone) gets the column names of the cells it fills.
  function labelFooter(tr) {
    const heads = [...tr.closest('table').querySelectorAll('thead th')].map((th) => th.textContent.trim());
    let col = 0;
    let title = false;
    for (const td of tr.cells) {
      if (!title && td.textContent.trim()) { title = true; td.classList.add('td-title'); } else if (title && !td.hasAttribute('data-label')) td.dataset.label = heads[col] || '';
      col += td.colSpan || 1;
    }
    tr.dataset.labelled = '1';
  }

  // Daily cut-off countdown in the top bar.
  let cutoffTimer;
  function tickCutoff() {
    clearTimeout(cutoffTimer);
    const els = document.querySelectorAll('[data-cutoff]');
    if (!els.length || !FL.state.me) return;
    const [h, m] = (FL.state.me.warehouse.cutoff || '14:00').split(':').map(Number);
    const now = new Date();
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Budapest', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).map((p) => [p.type, p.value]));
    const minutesNow = Number(parts.hour) * 60 + Number(parts.minute);
    const left = h * 60 + m - minutesNow;
    const cut = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const hh = Math.floor(left / 60);
    const mm = left % 60;
    const state = left <= 0 ? 'passed' : left <= 30 ? 'soon' : 'open';
    const text = String(left > 0
      ? html`${FL.icon('timer')}<span class="cutoff__label">Zárás ${cut}</span> <b>${hh ? `${hh} ó ` : ''}${mm} p</b>`
      : html`${FL.icon('timer')}<span class="cutoff__label">Mai zárás ${cut}</span> <b>lezárva</b>`);
    for (const el of els) { el.dataset.state = state; el.innerHTML = text; }
    cutoffTimer = setTimeout(tickCutoff, 30 * 1000);
  }

  /* ------------------------------------------------------------ PDA home screen */
  // Big tiles of the modules the user may open.
  function renderHome(section) {
    const me = FL.state.me;
    FL.setTitle('Kezdőképernyő');
    const groups = visibleGroups();
    section.innerHTML = String(html`<div class="pda-home">
      <div class="pda-home__me">
        <span class="pda-home__avatar" aria-hidden="true">${FL.icon('user-circle')}</span>
        <p><b>${me.user.name}</b><span>${me.user.role.name} · ${me.company.name}</span></p>
      </div>
      <p class="cutoff pda-home__cutoff" data-cutoff></p>
      ${groups.length ? groups.map((g) => html`<nav class="pda-home__group" aria-label="${g.title}">
        <h2>${g.title}</h2>
        <ul class="pda-tiles">${g.items.map((i) => html`<li><a class="pda-tile" href="#/${i.path}">${i.label}</a></li>`)}</ul>
      </nav>`) : ui.empty('A szerepköröd egyik modulhoz sem ad hozzáférést. Kérj jogosultságot az adminisztrátortól.', 'lock-simple')}
    </div>`);
    tickCutoff();
  }

  // The top bar's back button: the page's own back link if it has one, else one level up.
  function updateBack(section) {
    const btn = document.querySelector('.topbar__back');
    if (!btn) return;
    const crumb = section.querySelector('.page-head .crumb[href]');
    const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
    btn.setAttribute('href', crumb ? crumb.getAttribute('href') : parts.length > 1 ? `#/${parts.slice(0, -1).join('/')}` : '#/');
  }

  /* ------------------------------------------------------------ router */
  let current = null;
  async function render() {
    if (!FL.state.me) return;
    const content = document.getElementById('content');
    if (!content) return;
    const { route, params, query, path } = parseHash();
    appEl().dataset.home = String(!route);
    if (!route) {
      if (current && current.destroy) { try { current.destroy(); } catch { /* ignore */ } }
      current = null;
      markNav(null);
      if (FL.pda()) {
        const section = document.createElement('section');
        content.replaceChildren(section);
        renderHome(section);
        content.focus({ preventScroll: true });
        return;
      }
      const first = visibleGroups().flatMap((g) => g.items)[0];
      if (first) location.replace(`#/${first.path}`);
      else content.innerHTML = String(ui.empty('A szerepköröd egyik modulhoz sem ad hozzáférést. Kérj jogosultságot az adminisztrátortól.', 'lock-simple'));
      return;
    }
    const item = byRoute[route];
    const entry = entryFor(path);
    markNav(entry);
    if (current && current.destroy) { try { current.destroy(); } catch { /* ignore */ } }
    current = null;
    const section = document.createElement('section');
    content.replaceChildren(section);
    updateBack(section);
    if (!item) {
      FL.setTitle('Nem található');
      section.innerHTML = String(ui.empty('Ez az oldal nem létezik.', 'warning-circle'));
      return;
    }
    FL.setTitle(entry && entry.matched ? entry.label : item.label);
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
      updateBack(section);
      // Keep focus where the view put it (scan fields); else [data-autofocus]; else the content.
      if (!content.contains(document.activeElement) || document.activeElement === content) {
        const auto = section.querySelector('[data-autofocus]');
        if (auto) auto.focus({ preventScroll: true });
        else content.focus({ preventScroll: true });
      }
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
  // Turning the phone (or resizing the window) across the PDA width: only the home screen differs
  // in markup, every other screen adapts in css, so a half-filled form is never redrawn.
  pdaQuery.addEventListener('change', () => { if (!parseHash().route) render(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
