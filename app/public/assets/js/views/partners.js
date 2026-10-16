/* Partnerek: clients, carriers and suppliers.
     #/partnerek?type=client&status=active&q=...   list with type tabs, search and status filter
     #/partnerek/<id>/<tab>                          partner page; tabs: alapadatok, kapcsolattartok,
                                                     szerzodesek, tarifak (clients), integraciok (clients), osszesito
   Permissions (partners): view, create (new partner), edit (basic data, contacts, contracts,
   documents), delete (partner), approve (tariffs, custom items, webshop connections, API keys). */
(() => {
  'use strict';
  const FL = window.FL;
  const { html, raw, ui, api, fmt } = FL;
  const BASE = '#/partnerek';

  const can = (action) => FL.can('partners', action);
  const meta = () => FL.state.meta || {};
  const typeLabel = (t) => (meta().partnerTypes || {})[t] || t;
  const carrierLabel = (c) => (meta().carriers || {})[c] || c;

  const TABS = [
    { key: 'alapadatok', label: 'Alapadatok', render: basicTab },
    { key: 'kapcsolattartok', label: 'Kapcsolattartók', count: (p) => p.counts.contacts, render: contactsTab },
    { key: 'szerzodesek', label: 'Szerződés és dokumentumok', count: (p) => p.counts.contracts + p.counts.documents, render: contractsTab },
    { key: 'tarifak', label: 'Tarifák', clientOnly: true, render: tariffsTab },
    { key: 'integraciok', label: 'Integrációk', clientOnly: true, render: integrationsTab },
    { key: 'osszesito', label: 'Összesítő', render: summaryTab },
  ];

  const TYPE_TABS = [['', 'Összes', 'all'], ['client', 'Ügyfelek', 'client'], ['carrier', 'Fuvarozók', 'carrier'], ['supplier', 'Beszállítók', 'supplier']];
  const TARIFF_GROUPS = { handling: 'Rendeléskezelés', inbound: 'Betárolás és visszáru', extra: 'Extrák', discount: 'Kedvezmények', vat: 'ÁFA' };
  const KIND_LABELS = { contract: 'Szerződés', other: 'Egyéb' };
  const CUSTOM_KINDS = [['per_unit', 'Mennyiség alapján'], ['monthly', 'Havi fix díj']];

  /* ------------------------------------------------------------ small helpers */
  const chip = (text, tone = 'neutral') => html`<span class="chip" data-tone="${tone}">${text}</span>`;
  const bytes = (n) => (n >= 1048576 ? `${fmt.num(n / 1048576, 1)} MB` : n >= 1024 ? `${fmt.num(n / 1024, 0)} KB` : `${fmt.int(n)} B`);
  const dims = (s) => {
    const d = [s.width_cm, s.depth_cm, s.height_cm];
    const size = d.every((x) => x != null) ? `${d.map((x) => fmt.num(x, 1)).join(' × ')} cm` : '';
    const kg = s.max_kg != null ? `max. ${fmt.num(s.max_kg, 1)} kg` : '';
    return [size, kg].filter(Boolean).join(', ');
  };
  const daysUntil = (date) => Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${FL.today()}T12:00:00Z`)) / 86400000);
  const sameNum = (a, b) => Math.abs(Number(a) - Number(b)) < 0.000001;
  const unitValue = (t, v) => (t.unit.startsWith('%') ? fmt.pct(v, 2) : fmt.money(v, 2));
  const iconBtn = (action, icon, label, attrs = '') => html`<button class="btn btn--ghost btn--icon btn--sm" type="button" data-action="${action}" aria-label="${label}" title="${label}" ${raw(attrs)}>${FL.icon(icon)}</button>`;
  const fieldError = (name, message) => new FL.ApiError(400, 'bad_request', message, { [name]: message });

  // A fresh element for a tab, so delegated handlers never pile up when the tab re-renders.
  const mount = (box) => {
    const el = document.createElement('div');
    el.className = 'pt-tab';
    box.replaceChildren(el);
    return el;
  };

  // "Kutyabarát Webshop Kft." -> "KUTYABARAT"
  const suggestCode = (name) => {
    const skip = new Set(['KFT', 'ZRT', 'BT', 'NYRT', 'EV', 'KKT', 'LTD', 'GMBH', 'SRO', 'THE']);
    const words = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
      .replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !skip.has(w));
    return (words[0] || '').slice(0, 12);
  };

  /* ------------------------------------------------------------ view */
  // core/app.js (which defines FL.view) loads after the views, and it keeps an existing FL.views,
  // so register directly when FL.view is not there yet.
  const register = (k, def) => (typeof FL.view === 'function' ? FL.view(k, def) : ((FL.views = FL.views || {})[k] = def));
  register('partners', {
    async render(root, ctx) {
      if (ctx.params[0]) return renderPartner(root, ctx);
      return renderList(root, ctx);
    },
  });

  /* ------------------------------------------------------------ list */
  async function renderList(root, ctx) {
    const st = {
      type: ['client', 'carrier', 'supplier'].includes(ctx.query.get('type')) ? ctx.query.get('type') : '',
      status: ['active', 'inactive'].includes(ctx.query.get('status')) ? ctx.query.get('status') : '',
      q: (ctx.query.get('q') || '').slice(0, 100),
      offset: 0,
    };
    const LIMIT = 50;
    root.innerHTML = String(html`
      ${ui.pageHead({
        title: 'Partnerek',
        lead: 'Ügyfelek, fuvarozók és beszállítók: cégadatok, kapcsolattartók, szerződések, tarifák és integrációk.',
        actions: can('create') ? html`<button class="btn btn--primary" type="button" data-action="new">${FL.icon('plus')}Új partner</button>` : '',
      })}
      <div class="pt-box" data-tabs></div>
      <div class="toolbar">
        <div class="field field--grow"><label for="pt-q">Keresés</label>
          <input class="input" id="pt-q" type="search" value="${st.q}" placeholder="Név, kód, adószám, település vagy e-mail" autocomplete="off"></div>
        <div class="field"><label for="pt-status">Állapot</label>
          <select class="select" id="pt-status">${ui.options([['', 'Mind'], ['active', 'Aktív'], ['inactive', 'Inaktív']], st.status)}</select></div>
      </div>
      <div class="pt-box" data-results>${ui.loading()}</div>`);

    const tabsBox = root.querySelector('[data-tabs]');
    const results = root.querySelector('[data-results]');
    const hrefFor = (type) => `${BASE}${FL.qs({ type, status: st.status, q: st.q })}`;
    const syncUrl = () => history.replaceState(null, '', hrefFor(st.type));
    let seq = 0;

    async function load() {
      const my = ++seq;
      let data;
      try {
        data = await api.get('/api/partners', { type: st.type, status: st.status, q: st.q, limit: LIMIT, offset: st.offset });
      } catch (err) {
        if (my === seq) results.innerHTML = String(ui.notice(err.message, 'danger'));
        return;
      }
      if (my !== seq) return;
      tabsBox.innerHTML = String(ui.tabs(TYPE_TABS.map(([key, label, ck]) => ({ key, label, href: hrefFor(key), count: data.counts[ck] })), st.type, 'Partnertípusok'));
      const filtered = st.q || st.status;
      results.innerHTML = String(html`
        ${ui.table({
          caption: 'Partnerek',
          rows: data.items,
          rowHref: (r) => `${BASE}/${r.id}`,
          empty: filtered ? 'Nincs a szűrésnek megfelelő partner.' : 'Még nincs partner. Vedd fel az elsőt az Új partner gombbal.',
          columns: [
            { key: 'code', label: 'Kód', render: (r) => html`<a class="mono" href="${BASE}/${r.id}">${r.code}</a>` },
            { key: 'name', label: 'Név', cls: 'pt-name', render: (r) => html`<b>${r.name}</b>${r.city ? html`<span class="sub">${[r.zip, r.city].filter(Boolean).join(' ')}</span>` : ''}` },
            { key: 'type', label: 'Típus', render: (r) => html`<span class="tag">${typeLabel(r.type)}</span>${r.type === 'carrier' && r.carrier_code ? html`<span class="sub">${carrierLabel(r.carrier_code)}</span>` : ''}` },
            { key: 'tax_number', label: 'Adószám', cls: 'num' },
            { key: 'contact', label: 'Kapcsolattartó', render: (r) => (r.contact_name ? html`${r.contact_name}<span class="sub">${[r.contact_email, r.contact_phone].filter(Boolean).join(', ')}</span>` : html`<span class="muted">${r.billing_email || ''}</span>`) },
            { key: 'status', label: 'Állapot', render: (r) => FL.status('partner', r.status) },
          ],
        })}
        ${data.total > 0 ? ui.pager({ total: data.total, limit: LIMIT, offset: st.offset }) : ''}`);
    }

    ui.enableRowLinks(results);
    ui.bind(root, {
      new: () => createDialog(st.type || 'client'),
      page: (el) => { st.offset = Number(el.dataset.offset) || 0; load(); },
    });
    const qInput = root.querySelector('#pt-q');
    qInput.addEventListener('input', FL.debounce(() => { st.q = qInput.value.trim(); st.offset = 0; syncUrl(); load(); }, 250));
    root.querySelector('#pt-status').addEventListener('change', (e) => { st.status = e.target.value; st.offset = 0; syncUrl(); load(); });
    await load();
  }

  function createDialog(defaultType) {
    const m = meta();
    ui.dialog({
      title: 'Új partner',
      size: 'wide',
      submitLabel: 'Partner létrehozása',
      body: html`
        <div class="form-grid">
          ${ui.field({ name: 'type', label: 'Típus', type: 'select', options: Object.entries(m.partnerTypes || {}), value: defaultType, required: true })}
          ${ui.field({ name: 'name', label: 'Név (cégnév)', required: true, span: 2, attrs: 'maxlength="200"' })}
          ${ui.field({ name: 'code', label: 'Kód', type: 'code', required: true, attrs: 'maxlength="20"', hint: 'Rövid, egyedi azonosító, pl. KUTYA.' })}
          ${ui.field({ name: 'tax_number', label: 'Adószám', optional: true, placeholder: '12345678-1-12' })}
          ${ui.field({ name: 'country', label: 'Ország', type: 'code', value: 'HU', attrs: 'maxlength="2"', hint: 'Kétbetűs kód.' })}
          ${ui.field({ name: 'zip', label: 'Irányítószám', optional: true })}
          ${ui.field({ name: 'city', label: 'Település', optional: true })}
          ${ui.field({ name: 'address', label: 'Utca, házszám', optional: true, span: 2 })}
          ${ui.field({ name: 'billing_email', label: 'Számlázási e-mail', type: 'email', optional: true })}
          ${ui.field({ name: 'website', label: 'Weboldal', optional: true, placeholder: 'https://pelda.hu' })}
          <div class="pt-carrier" data-carrier>${ui.field({ name: 'carrier_code', label: 'Futárszolgálat', type: 'select', options: Object.entries(m.carriers || {}), placeholder: 'Nincs megadva' })}</div>
          ${ui.field({ name: 'notes', label: 'Megjegyzés', type: 'textarea', optional: true, span: 'all', rows: 2 })}
        </div>
        <p class="small muted" data-client-note>Az ügyfél díjai a Beállítások alapértelmezett tarifáival indulnak, a Tarifák fülön módosíthatod őket.</p>`,
      onOpen: ({ form }) => {
        const type = form.querySelector('[name="type"]');
        const carrier = form.querySelector('[data-carrier]');
        const note = form.querySelector('[data-client-note]');
        const sync = () => {
          carrier.hidden = type.value !== 'carrier';
          carrier.querySelector('select').disabled = type.value !== 'carrier';
          note.hidden = type.value !== 'client';
        };
        type.addEventListener('change', sync);
        sync();
        const name = form.querySelector('[name="name"]');
        const code = form.querySelector('[name="code"]');
        let touched = false;
        code.addEventListener('input', () => { touched = code.value !== ''; });
        name.addEventListener('input', () => { if (!touched) code.value = suggestCode(name.value); });
        name.focus();
      },
      onSubmit: async (form) => {
        const v = ui.formValues(form);
        v.code = String(v.code || '').toUpperCase();
        v.country = String(v.country || '').toUpperCase();
        const res = await api.post('/api/partners', v);
        ui.toast('Partner létrehozva.', 'ok');
        FL.go(`${BASE}/${res.id}`);
      },
    });
  }

  /* ------------------------------------------------------------ partner page */
  async function renderPartner(root, ctx) {
    const id = Number(ctx.params[0]);
    if (!Number.isInteger(id) || id <= 0) {
      root.innerHTML = String(ui.empty('Ez a partner nem létezik.', 'warning-circle'));
      return;
    }
    const p = await api.get(`/api/partners/${id}`);
    const tabs = TABS.filter((t) => !t.clientOnly || p.type === 'client');
    const tab = tabs.find((t) => t.key === ctx.params[1]) || tabs[0];
    document.title = `${p.name} | Partnerek | Fully Logistics WMS`;
    root.innerHTML = String(html`
      ${ui.pageHead({
        crumb: { href: `${BASE}?type=${p.type}`, label: 'Partnerek' },
        title: p.name,
        lead: html`${typeLabel(p.type)}${p.type === 'carrier' && p.carrier_code ? html`, ${carrierLabel(p.carrier_code)}` : ''} · <span class="mono">${p.code}</span> ${FL.status('partner', p.status)}`,
        actions: p.type === 'client' && FL.can('quotes', 'create') ? html`<a class="btn" href="#/ajanlatkeszito/uj?partner=${p.id}">${FL.icon('calculator')}Ajánlat készítése</a>` : '',
      })}
      ${ui.tabs(tabs.map((t) => ({ key: t.key, label: t.label, href: `${BASE}/${p.id}/${t.key}`, count: t.count ? t.count(p) : null })), tab.key, 'Partner fülei')}
      <div class="pt-box" data-tab>${ui.loading()}</div>`);
    const box = root.querySelector('[data-tab]');
    const reload = async () => {
      try {
        await tab.render(box, p, reload);
      } catch (err) {
        if (err instanceof FL.ApiError && err.status === 401) return;
        box.innerHTML = String(ui.notice(err.message || 'Hiba történt a betöltéskor.', 'danger'));
      }
    };
    await reload();
  }

  /* ------------------------------------------------------------ Alapadatok */
  function basicTab(box, p) {
    const el = mount(box);
    if (!can('edit')) {
      el.innerHTML = String(basicReadOnly(p));
      bindDelete(el, p);
      return;
    }
    const f = (name, label, opts = {}) => ui.field({ name, label, value: p[name], ...opts });
    el.innerHTML = String(html`<form class="form" novalidate data-form>
      <div class="grid-2">
        <section class="panel">
          <h2>Cégadatok</h2>
          <div class="form-grid">
            ${f('name', 'Név (cégnév)', { required: true, span: 2, attrs: 'maxlength="200"' })}
            ${f('code', 'Kód', { type: 'code', required: true, attrs: 'maxlength="20"' })}
            ${f('status', 'Állapot', { type: 'select', options: [['active', 'Aktív'], ['inactive', 'Inaktív']], hint: 'Inaktív partnerre nem rögzíthető új rendelés vagy betárolás.' })}
            <div class="field"><span class="field__label">Típus</span><p class="pt-static">${typeLabel(p.type)}</p></div>
            ${f('tax_number', 'Adószám', { optional: true, placeholder: '12345678-1-12' })}
            ${f('eu_vat_number', 'Közösségi adószám', { optional: true, placeholder: 'HU12345678' })}
            ${f('company_reg_number', 'Cégjegyzékszám', { optional: true, placeholder: '01-09-123456' })}
            ${f('website', 'Weboldal', { optional: true, placeholder: 'https://pelda.hu' })}
            ${p.type === 'carrier' ? f('carrier_code', 'Futárszolgálat', { type: 'select', options: Object.entries(meta().carriers || {}), placeholder: 'Nincs megadva', hint: 'Ezzel köti össze a rendszer a fuvarozót a futár integrációval.' }) : ''}
          </div>
        </section>
        <section class="panel">
          <h2>Székhely, telephely</h2>
          <div class="form-grid">
            ${f('country', 'Ország', { type: 'code', attrs: 'maxlength="2"' })}
            ${f('zip', 'Irányítószám', { optional: true })}
            ${f('city', 'Település', { optional: true })}
            ${f('address', 'Utca, házszám', { optional: true, span: 'all' })}
          </div>
        </section>
        <section class="panel">
          <div class="panel__head"><h2>Számlázási adatok</h2>
            <button class="btn btn--sm" type="button" data-action="copy-address">${FL.icon('copy')}Cégadatok átmásolása</button></div>
          <div class="form-grid">
            ${f('billing_name', 'Számlázási név', { optional: true, span: 'all', hint: 'Üresen hagyva a cégnév kerül a számlára.' })}
            ${f('billing_country', 'Ország', { type: 'code', attrs: 'maxlength="2"' })}
            ${f('billing_zip', 'Irányítószám', { optional: true })}
            ${f('billing_city', 'Település', { optional: true })}
            ${f('billing_address', 'Utca, házszám', { optional: true, span: 'all' })}
            ${f('billing_email', 'Számlázási e-mail', { type: 'email', optional: true, span: 2 })}
            ${f('payment_days', 'Fizetési határidő (nap)', { type: 'number', int: true, min: 0, max: 365 })}
          </div>
        </section>
        <section class="panel">
          <h2>Megjegyzés</h2>
          ${f('notes', 'Belső megjegyzés', { type: 'textarea', optional: true, rows: 6, hint: 'Csak a munkatársak látják.' })}
        </section>
      </div>
      <div class="form-actions">
        <span class="muted small">Létrehozva: ${fmt.dateTime(p.created_at)}, módosítva: ${fmt.dateTime(p.updated_at)}</span>
        ${can('delete') ? html`<button class="btn btn--danger" type="button" data-action="delete">${FL.icon('trash')}Partner törlése</button>` : ''}
        <button class="btn btn--primary" type="submit">${FL.icon('check')}Mentés</button>
      </div>
    </form>`);

    const form = el.querySelector('[data-form]');
    ui.bind(el, {
      'copy-address': () => {
        const get = (n) => form.querySelector(`[name="${n}"]`);
        if (!get('billing_name').value) get('billing_name').value = get('name').value;
        for (const k of ['country', 'zip', 'city', 'address']) get(`billing_${k}`).value = get(k).value;
        ui.toast('A cégadatokat átmásoltam a számlázási mezőkbe. Mentsd el.', 'info');
      },
    });
    bindDelete(el, p);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      ui.clearErrors(form);
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
      try {
        const v = ui.formValues(form);
        for (const k of ['code', 'country', 'billing_country']) v[k] = String(v[k] || '').toUpperCase();
        await api.patch(`/api/partners/${p.id}`, v);
        ui.toast('Partner adatai mentve.', 'ok');
        FL.reload();
      } catch (err) {
        ui.showErrors(form, err);
      } finally {
        btn.removeAttribute('aria-busy');
        btn.disabled = false;
      }
    });
  }

  function basicReadOnly(p) {
    const dl = (rows) => {
      const shown = rows.filter(([, v]) => v !== '' && v != null);
      return shown.length ? html`<dl class="dl">${shown.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>` : html`<p class="muted">Nincs megadva.</p>`;
    };
    const addr = (c, z, ci, a) => [[z, ci].filter(Boolean).join(' '), a].filter(Boolean).join(', ') + (c && c !== 'HU' && (z || ci || a) ? ` (${c})` : '');
    return html`
      <div class="grid-2">
        <section class="panel"><h2>Cégadatok</h2>${dl([
          ['Név', p.name], ['Kód', html`<span class="mono">${p.code}</span>`], ['Típus', typeLabel(p.type)], ['Állapot', FL.status('partner', p.status)],
          ['Adószám', p.tax_number], ['Közösségi adószám', p.eu_vat_number], ['Cégjegyzékszám', p.company_reg_number],
          ['Weboldal', p.website ? html`<a href="${p.website}" target="_blank" rel="noopener">${p.website}</a>` : ''],
          ['Futárszolgálat', p.type === 'carrier' && p.carrier_code ? carrierLabel(p.carrier_code) : ''],
        ])}</section>
        <section class="panel"><h2>Székhely, telephely</h2>${dl([['Cím', addr(p.country, p.zip, p.city, p.address)]])}</section>
        <section class="panel"><h2>Számlázási adatok</h2>${dl([
          ['Számlázási név', p.billing_name || p.name], ['Cím', addr(p.billing_country, p.billing_zip, p.billing_city, p.billing_address)],
          ['E-mail', p.billing_email], ['Fizetési határidő', `${fmt.int(p.payment_days)} nap`],
        ])}</section>
        <section class="panel"><h2>Megjegyzés</h2>${p.notes ? html`<p class="pt-notes">${p.notes}</p>` : html`<p class="muted">Nincs megjegyzés.</p>`}</section>
      </div>
      ${can('delete') ? html`<div class="form-actions"><button class="btn btn--danger" type="button" data-action="delete">${FL.icon('trash')}Partner törlése</button></div>` : ''}`;
  }

  function bindDelete(el, p) {
    el.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-action="delete"]')) return;
      if (!p.can_delete) {
        const list = p.delete_blockers.map((b) => `${fmt.int(b.count)} ${b.label}`).join(', ');
        const canDeactivate = can('edit') && p.status === 'active';
        ui.dialog({
          title: 'A partner nem törölhető',
          size: 'narrow',
          body: html`<p>${p.name} partnerhez már tartoznak adatok: ${list}.</p>
            <p>${canDeactivate ? 'Inaktiváld inkább: a története megmarad, de új rendelés és betárolás nem rögzíthető rá.' : 'A partner története így megmarad.'}</p>`,
          submitLabel: 'Inaktiválás',
          cancelLabel: canDeactivate ? 'Mégse' : 'Bezárás',
          hideSubmit: !canDeactivate,
          onSubmit: async () => {
            await api.patch(`/api/partners/${p.id}`, { status: 'inactive' });
            ui.toast('A partner inaktív lett.', 'ok');
            FL.reload();
          },
        });
        return;
      }
      const ok = await ui.confirm({
        title: 'Partner törlése',
        text: `Biztosan törlöd: ${p.name}? A kapcsolattartói, szerződései, dokumentumai, tarifái és API kulcsai is törlődnek. Ez nem vonható vissza.`,
        confirmLabel: 'Végleges törlés',
        tone: 'danger',
      });
      if (!ok) return;
      await ui.run(null, async () => {
        await api.del(`/api/partners/${p.id}`);
        ui.toast('Partner törölve.', 'ok');
        FL.go(BASE);
      });
    });
  }

  /* ------------------------------------------------------------ Kapcsolattartók */
  async function contactsTab(box, p, reload) {
    const { items } = await api.get(`/api/partners/${p.id}/contacts`);
    const el = mount(box);
    const editable = can('edit');
    el.innerHTML = String(html`<section class="panel panel--flush">
      <div class="panel__head"><h2>Kapcsolattartók</h2>
        ${editable ? html`<button class="btn btn--primary" type="button" data-action="new">${FL.icon('plus')}Új kapcsolattartó</button>` : ''}</div>
      ${ui.table({
        caption: 'Kapcsolattartók',
        rows: items,
        empty: 'Még nincs kapcsolattartó.',
        columns: [
          { key: 'name', label: 'Név', render: (r) => html`<b>${r.name}</b>${r.is_primary ? html` ${chip('Elsődleges', 'accent')}` : ''}${r.position ? html`<span class="sub">${r.position}</span>` : ''}` },
          { key: 'email', label: 'E-mail', render: (r) => (r.email ? html`<a href="mailto:${r.email}">${r.email}</a>` : '') },
          { key: 'phone', label: 'Telefon', cls: 'nowrap', render: (r) => (r.phone ? html`<a href="tel:${r.phone.replace(/[^\d+]/g, '')}">${r.phone}</a>` : '') },
          { key: 'notes', label: 'Megjegyzés', render: (r) => html`<span class="small">${r.notes}</span>` },
          ...(editable ? [{ key: 'actions', label: 'Műveletek', align: 'r', cls: 'nowrap', render: (r) => html`
            ${r.is_primary ? '' : html`<button class="btn btn--sm" type="button" data-action="primary" data-id="${r.id}">Legyen elsődleges</button>`}
            ${iconBtn('edit', 'pencil-simple', `${r.name} szerkesztése`, `data-id="${r.id}"`)}
            ${iconBtn('remove', 'trash', `${r.name} törlése`, `data-id="${r.id}"`)}` }] : []),
        ],
      })}
    </section>`);
    const byId = (el2) => items.find((c) => c.id === Number(el2.dataset.id));
    ui.bind(el, {
      new: () => contactDialog(p, null, items.length === 0, reload),
      edit: (b) => contactDialog(p, byId(b), false, reload),
      primary: (b) => ui.run(b, async () => {
        await api.patch(`/api/partners/${p.id}/contacts/${b.dataset.id}`, { is_primary: true });
        ui.toast('Elsődleges kapcsolattartó beállítva.', 'ok');
        reload();
      }),
      remove: async (b) => {
        const c = byId(b);
        if (!(await ui.confirm({ title: 'Kapcsolattartó törlése', text: `Biztosan törlöd: ${c.name}?`, confirmLabel: 'Törlés', tone: 'danger' }))) return;
        await ui.run(null, async () => {
          await api.del(`/api/partners/${p.id}/contacts/${c.id}`);
          ui.toast('Kapcsolattartó törölve.', 'ok');
          reload();
        });
      },
    });
  }

  function contactDialog(p, c, firstOne, reload) {
    const isPrimary = c ? !!c.is_primary : firstOne;
    ui.dialog({
      title: c ? 'Kapcsolattartó szerkesztése' : 'Új kapcsolattartó',
      submitLabel: c ? 'Mentés' : 'Felvétel',
      body: html`<div class="form-grid">
        ${ui.field({ name: 'name', label: 'Név', value: c && c.name, required: true })}
        ${ui.field({ name: 'position', label: 'Beosztás', value: c && c.position, optional: true, placeholder: 'pl. logisztikai vezető' })}
        ${ui.field({ name: 'email', label: 'E-mail', type: 'email', value: c && c.email, optional: true })}
        ${ui.field({ name: 'phone', label: 'Telefon', type: 'tel', value: c && c.phone, optional: true, placeholder: '+36 30 123 4567' })}
        ${ui.field({ name: 'notes', label: 'Megjegyzés', type: 'textarea', value: c && c.notes, optional: true, rows: 2, span: 'all' })}
        ${ui.field({
          name: 'is_primary', label: 'Elsődleges kapcsolattartó', type: 'checkbox', value: isPrimary, span: 'all',
          attrs: c && c.is_primary ? 'disabled' : '',
          hint: c && c.is_primary ? 'Másik elsődleges kapcsolattartót a listában jelölhetsz ki.' : firstOne ? 'Az első kapcsolattartó automatikusan elsődleges.' : 'Egy partnernek egy elsődleges kapcsolattartója van.',
        })}
      </div>`,
      onSubmit: async (form) => {
        const v = ui.formValues(form);
        if (c && c.is_primary) delete v.is_primary;
        if (c) await api.patch(`/api/partners/${p.id}/contacts/${c.id}`, v);
        else await api.post(`/api/partners/${p.id}/contacts`, v);
        ui.toast(c ? 'Kapcsolattartó mentve.' : 'Kapcsolattartó felvéve.', 'ok');
        reload();
      },
    });
  }

  /* ------------------------------------------------------------ Szerződés és dokumentumok */
  async function contractsTab(box, p, reload) {
    const [{ items: contracts }, { items: docs }] = await Promise.all([
      api.get(`/api/partners/${p.id}/contracts`),
      api.get(`/api/partners/${p.id}/documents`),
    ]);
    const el = mount(box);
    const editable = can('edit');
    const contractLabel = (c) => [c.number, c.title].filter(Boolean).join(', ');
    const expiry = (c) => {
      if (!c.end_date) return html`Határozatlan`;
      const d = daysUntil(c.end_date);
      const note = c.status === 'active' && d < 0 ? html`<span class="sub diff-neg">lejárt</span>`
        : c.status === 'active' && d <= 60 ? html`<span class="sub diff-neg">${d === 0 ? 'ma jár le' : `${d} nap múlva lejár`}</span>` : '';
      return html`${fmt.date(c.end_date)}${note}`;
    };
    el.innerHTML = String(html`
      <section class="panel panel--flush">
        <div class="panel__head"><h2>Szerződések</h2>
          ${editable ? html`<button class="btn btn--primary" type="button" data-action="new-contract">${FL.icon('plus')}Új szerződés</button>` : ''}</div>
        ${ui.table({
          caption: 'Szerződések',
          rows: contracts,
          empty: 'Még nincs rögzített szerződés.',
          columns: [
            { key: 'number', label: 'Szám', cls: 'num', render: (r) => r.number || html`<span class="muted">nincs</span>` },
            { key: 'title', label: 'Megnevezés', render: (r) => html`<b>${r.title}</b>${r.notes ? html`<span class="sub">${r.notes}</span>` : ''}` },
            { key: 'start_date', label: 'Kezdete', cls: 'nowrap', render: (r) => fmt.date(r.start_date) },
            { key: 'end_date', label: 'Lejárata', cls: 'nowrap', render: expiry },
            { key: 'notice_days', label: 'Felmondási idő', align: 'r', cls: 'num', render: (r) => `${fmt.int(r.notice_days)} nap` },
            { key: 'status', label: 'Állapot', render: (r) => FL.status('contract', r.status) },
            { key: 'documents', label: 'Dokumentum', align: 'r', cls: 'num', render: (r) => fmt.int(r.documents) },
            ...(editable ? [{ key: 'a', label: 'Műveletek', align: 'r', cls: 'nowrap', render: (r) => html`
              ${iconBtn('edit-contract', 'pencil-simple', `${contractLabel(r)} szerkesztése`, `data-id="${r.id}"`)}
              ${iconBtn('remove-contract', 'trash', `${contractLabel(r)} törlése`, `data-id="${r.id}"`)}` }] : []),
          ],
        })}
      </section>
      <section class="panel panel--flush">
        <div class="panel__head"><h2>Dokumentumok</h2>
          ${editable ? html`<button class="btn" type="button" data-action="upload">${FL.icon('upload-simple')}Feltöltés</button>` : ''}</div>
        ${ui.table({
          caption: 'Dokumentumok',
          rows: docs,
          empty: 'Még nincs feltöltött dokumentum.',
          columns: [
            { key: 'filename', label: 'Fájl', render: (r) => html`<a href="${api.documentUrl(r.id, true)}" target="_blank" rel="noopener">${r.filename}</a><span class="sub">${bytes(r.size)}</span>` },
            { key: 'kind', label: 'Típus', render: (r) => html`<span class="tag">${KIND_LABELS[r.kind] || r.kind}</span>` },
            { key: 'contract', label: 'Szerződés', render: (r) => (r.contract_id ? contractLabel({ number: r.contract_number, title: r.contract_title }) : html`<span class="muted">nincs</span>`) },
            { key: 'uploaded_at', label: 'Feltöltve', cls: 'nowrap', render: (r) => html`${fmt.dateTime(r.uploaded_at)}${r.uploaded_by_name ? html`<span class="sub">${r.uploaded_by_name}</span>` : ''}` },
            { key: 'a', label: 'Műveletek', align: 'r', cls: 'nowrap', render: (r) => html`
              <a class="btn btn--ghost btn--icon btn--sm" href="${api.documentUrl(r.id)}" aria-label="${r.filename} letöltése" title="Letöltés">${FL.icon('download-simple')}</a>
              ${editable ? html`${iconBtn('edit-doc', 'pencil-simple', `${r.filename} adatai`, `data-id="${r.id}"`)}${iconBtn('remove-doc', 'trash', `${r.filename} törlése`, `data-id="${r.id}"`)}` : ''}` },
          ],
        })}
      </section>`);

    const contractById = (b) => contracts.find((c) => c.id === Number(b.dataset.id));
    const docById = (b) => docs.find((d) => d.id === Number(b.dataset.id));
    const contractOptions = contracts.map((c) => [c.id, contractLabel(c)]);
    ui.bind(el, {
      'new-contract': () => contractDialog(p, null, reload),
      'edit-contract': (b) => contractDialog(p, contractById(b), reload),
      'remove-contract': async (b) => {
        const c = contractById(b);
        const text = c.documents ? `Biztosan törlöd: ${contractLabel(c)}? A hozzá kapcsolt ${c.documents} dokumentum megmarad, csak a kapcsolat szűnik meg.` : `Biztosan törlöd: ${contractLabel(c)}?`;
        if (!(await ui.confirm({ title: 'Szerződés törlése', text, confirmLabel: 'Törlés', tone: 'danger' }))) return;
        await ui.run(null, async () => {
          await api.del(`/api/partners/${p.id}/contracts/${c.id}`);
          ui.toast('Szerződés törölve.', 'ok');
          FL.reload();
        });
      },
      upload: () => uploadDialog(p, contractOptions),
      'edit-doc': (b) => {
        const d = docById(b);
        ui.dialog({
          title: 'Dokumentum adatai',
          size: 'narrow',
          body: html`<p class="small muted">${d.filename}</p>
            ${ui.field({ name: 'kind', label: 'Típus', type: 'select', options: Object.entries(KIND_LABELS), value: d.kind })}
            ${ui.field({ name: 'contract_id', label: 'Szerződés', type: 'select', options: contractOptions, value: d.contract_id || '', placeholder: 'Nincs hozzárendelve' })}`,
          onSubmit: async (form) => {
            const v = ui.formValues(form);
            await api.patch(`/api/partners/${p.id}/documents/${d.id}`, { kind: v.kind, contract_id: v.contract_id ? Number(v.contract_id) : null });
            ui.toast('Dokumentum mentve.', 'ok');
            reload();
          },
        });
      },
      'remove-doc': async (b) => {
        const d = docById(b);
        if (!(await ui.confirm({ title: 'Dokumentum törlése', text: `Biztosan törlöd: ${d.filename}? A fájl végleg törlődik.`, confirmLabel: 'Törlés', tone: 'danger' }))) return;
        await ui.run(null, async () => {
          await api.del(`/api/partners/${p.id}/documents/${d.id}`);
          ui.toast('Dokumentum törölve.', 'ok');
          FL.reload();
        });
      },
    });
  }

  function contractDialog(p, c, reload) {
    const indefinite = c ? !c.end_date : true;
    ui.dialog({
      title: c ? 'Szerződés szerkesztése' : 'Új szerződés',
      submitLabel: c ? 'Mentés' : 'Felvétel',
      body: html`<div class="form-grid">
        ${ui.field({ name: 'number', label: 'Szerződésszám', value: c && c.number, optional: true, placeholder: 'pl. FL-2026-014' })}
        ${ui.field({ name: 'title', label: 'Megnevezés', value: c ? c.title : 'Fulfillment szolgáltatási szerződés', required: true, span: 2 })}
        ${ui.field({ name: 'start_date', label: 'Hatály kezdete', type: 'date', value: c ? c.start_date : FL.today(), optional: true })}
        ${ui.field({ name: 'indefinite', label: 'Határozatlan idejű', type: 'checkbox', value: indefinite })}
        ${ui.field({ name: 'end_date', label: 'Lejárat', type: 'date', value: c && c.end_date, attrs: indefinite ? 'disabled' : '' })}
        ${ui.field({ name: 'notice_days', label: 'Felmondási idő (nap)', type: 'number', int: true, min: 0, max: 3650, value: c ? c.notice_days : 30 })}
        ${ui.field({ name: 'status', label: 'Állapot', type: 'select', options: Object.entries(meta().statuses.contract).map(([k, s]) => [k, s.label]), value: c ? c.status : 'active' })}
        ${ui.field({ name: 'notes', label: 'Megjegyzés', type: 'textarea', value: c && c.notes, optional: true, rows: 2, span: 'all' })}
      </div>`,
      onOpen: ({ form }) => {
        const box = form.querySelector('[name="indefinite"]');
        const end = form.querySelector('[name="end_date"]');
        box.addEventListener('change', () => { end.disabled = box.checked; if (box.checked) end.value = ''; else end.focus(); });
      },
      onSubmit: async (form) => {
        const v = ui.formValues(form);
        const body = { ...v, end_date: v.indefinite ? null : v.end_date || null, start_date: v.start_date || null };
        delete body.indefinite;
        if (!v.indefinite && !v.end_date) throw fieldError('end_date', 'Add meg a lejáratot, vagy jelöld határozatlannak.');
        if (c) await api.patch(`/api/partners/${p.id}/contracts/${c.id}`, body);
        else await api.post(`/api/partners/${p.id}/contracts`, body);
        ui.toast(c ? 'Szerződés mentve.' : 'Szerződés felvéve.', 'ok');
        if (c) reload(); else FL.reload();
      },
    });
  }

  function uploadDialog(p, contractOptions) {
    ui.dialog({
      title: 'Dokumentum feltöltése',
      submitLabel: 'Feltöltés',
      body: html`
        <div class="field">
          <label for="pt-doc-file">Fájl</label>
          <input class="input" id="pt-doc-file" name="file" type="file" required aria-describedby="pt-doc-file-err"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.doc,.docx,.xls,.xlsx,.odt,.ods,.txt,.csv,.zip">
          <span class="field__hint">Legfeljebb 20 MB: PDF, kép, Word, Excel, szöveg vagy ZIP.</span>
          <p class="field__error" id="pt-doc-file-err" hidden></p>
        </div>
        <div class="form-grid">
          ${ui.field({ name: 'kind', label: 'Típus', type: 'select', options: Object.entries(KIND_LABELS), value: contractOptions.length ? 'contract' : 'other' })}
          ${ui.field({ name: 'contract_id', label: 'Szerződéshez kapcsolás', type: 'select', options: contractOptions, placeholder: 'Nincs hozzárendelve', optional: true })}
        </div>`,
      onSubmit: async (form) => {
        const file = form.querySelector('#pt-doc-file').files[0];
        if (!file) throw fieldError('file', 'Válassz ki egy fájlt.');
        if (file.size > 20 * 1024 * 1024) throw fieldError('file', 'A fájl legfeljebb 20 MB lehet.');
        const v = ui.formValues(form);
        await api.upload(`/api/partners/${p.id}/documents`, file, { kind: v.kind, contract_id: v.contract_id || '' });
        ui.toast('Dokumentum feltöltve.', 'ok');
        FL.reload();
      },
    });
  }

  /* ------------------------------------------------------------ Tarifák */
  async function tariffsTab(box, p, reload) {
    const data = await api.get(`/api/partners/${p.id}/tariffs`);
    const el = mount(box);
    const editable = can('approve');
    const ro = editable ? '' : raw('readonly');
    const diffCell = (differs) => html`<td class="pt-diff" data-diff-cell>${differs ? chip('Eltér', 'accent') : ''}</td>`;
    const groups = FL.groupBy(data.tariffs, (t) => t.group);
    const custom = data.custom_items;

    el.innerHTML = String(html`
      ${editable ? '' : ui.notice('Itt csak megtekintheted a díjakat. A módosításhoz „Partnerek: tarifák és integrációk módosítása” jog kell.', 'info')}
      <form class="form" novalidate data-form>
        <section class="panel panel--flush">
          <div class="panel__head"><div><h2>Díjtételek</h2>
            <p class="small muted">Az alapérték a Beállítások alapértelmezett tarifája. Az ettől eltérő díjakat kiemeljük.</p></div>
            <span class="small" data-diff-count></span></div>
          <div class="table-wrap"><table class="table pt-tariffs">
            <caption class="visually-hidden">Díjtételek</caption>
            <thead><tr><th scope="col">Tétel</th><th scope="col">Egység</th><th scope="col" class="r">Alapérték</th><th scope="col" class="r">Ügyfél díja</th><th scope="col"><span class="visually-hidden">Eltérés</span></th></tr></thead>
            <tbody>${Object.entries(TARIFF_GROUPS).filter(([g]) => groups[g]).map(([g, label]) => html`
              <tr class="pt-group"><td colspan="5">${label}</td></tr>
              ${groups[g].map((t) => html`<tr data-row ${t.differs ? raw('class="is-diff"') : ''}>
                <td><label for="pt-t-${t.key}">${t.label}</label><span class="sub pt-unit-sub">${t.unit}</span></td>
                <td class="small muted">${t.unit}</td>
                <td class="r num">${unitValue(t, t.default)}</td>
                <td class="r"><input class="input input--num pt-input" id="pt-t-${t.key}" name="${t.key}" type="number" min="0" step="any" ${t.unit.startsWith('%') ? raw('max="100"') : ''}
                  value="${t.value}" data-default="${t.default}" data-kind="tariff" ${ro}></td>
                ${diffCell(t.differs)}
              </tr>`)}`)}</tbody>
          </table></div>
        </section>

        <section class="panel panel--flush">
          <div class="panel__head"><div><h2>Tárolási díjak</h2>
            <p class="small muted">Egy raktárhely havi díja méretenként. A számlázás a napi foglaltság szerint időarányos. Új méretet a Beállítások > Raktárhelyek alatt vehetsz fel.</p></div></div>
          ${data.storage.length ? html`<div class="table-wrap"><table class="table pt-tariffs">
            <caption class="visually-hidden">Tárolási díjak</caption>
            <thead><tr><th scope="col">Méret</th><th scope="col">Befoglaló méret</th><th scope="col" class="r">Alapérték</th><th scope="col" class="r">Ügyfél díja / hó</th><th scope="col"><span class="visually-hidden">Eltérés</span></th></tr></thead>
            <tbody>${data.storage.map((s) => html`<tr data-row ${s.differs ? raw('class="is-diff"') : ''}>
              <td><label for="pt-s-${s.size_id}"><span class="tag">${s.code}</span> ${s.name}</label><span class="sub pt-unit-sub">${dims(s) || 'Ft / hely / hó'}</span></td>
              <td class="small muted">${dims(s) || 'nincs megadva'}</td>
              <td class="r num">${fmt.money(s.default, 2)}</td>
              <td class="r"><input class="input input--num pt-input" id="pt-s-${s.size_id}" name="storage_${s.size_id}" type="number" min="0" step="any"
                value="${s.price}" data-default="${s.default}" data-kind="storage" data-size="${s.size_id}" ${ro}></td>
              ${diffCell(s.differs)}
            </tr>`)}</tbody>
          </table></div>` : ui.empty('Nincs aktív raktárhely méret. Vegyél fel méretet a Beállítások > Raktárhelyek alatt.')}
        </section>

        ${editable ? html`<div class="form-actions">
          <button class="btn" type="button" data-action="reset">${FL.icon('arrow-clockwise')}Visszaállítás alapra</button>
          <button class="btn btn--primary" type="submit">${FL.icon('check')}Tarifák mentése</button>
        </div>` : ''}
      </form>

      <section class="panel panel--flush">
        <div class="panel__head"><div><h2>Egyedi tételek</h2>
          <p class="small muted">Az ügyfélre szabott díjak: havi fix díj, vagy rögzített mennyiség szerint számlázott tétel (pl. raklapfóliázás).</p></div>
          ${editable ? html`<button class="btn" type="button" data-action="new-item">${FL.icon('plus')}Új egyedi tétel</button>` : ''}</div>
        ${ui.table({
          caption: 'Egyedi tételek',
          rows: custom,
          empty: 'Nincs egyedi tétel.',
          columns: [
            { key: 'name', label: 'Megnevezés', render: (r) => html`<b>${r.name}</b>` },
            { key: 'kind', label: 'Típus', render: (r) => (r.kind === 'monthly' ? 'Havi fix díj' : 'Mennyiség alapján') },
            { key: 'price', label: 'Ár', align: 'r', cls: 'num', render: (r) => html`${fmt.money(r.price, 2)} / ${r.kind === 'monthly' ? 'hó' : r.unit}` },
            { key: 'active', label: 'Állapot', render: (r) => (r.active ? chip('Aktív', 'ok') : chip('Inaktív')) },
            ...(editable ? [{ key: 'a', label: 'Műveletek', align: 'r', cls: 'nowrap', render: (r) => html`
              ${iconBtn('edit-item', 'pencil-simple', `${r.name} szerkesztése`, `data-id="${r.id}"`)}
              ${iconBtn('remove-item', 'trash', `${r.name} törlése`, `data-id="${r.id}"`)}` }] : []),
          ],
        })}
      </section>`);

    const form = el.querySelector('[data-form]');
    const countBox = el.querySelector('[data-diff-count]');
    const refreshDiffs = () => {
      let n = 0;
      form.querySelectorAll('input[data-default]').forEach((input) => {
        const differs = input.value !== '' && !sameNum(input.value, input.dataset.default);
        if (differs) n++;
        const row = input.closest('[data-row]');
        row.classList.toggle('is-diff', differs);
        row.querySelector('[data-diff-cell]').innerHTML = differs ? String(chip('Eltér', 'accent')) : '';
      });
      countBox.innerHTML = String(n ? chip(`${n} díj eltér az alaptól`, 'accent') : chip('Minden díj az alapértéken', 'ok'));
    };
    refreshDiffs();
    form.addEventListener('input', (e) => { if (e.target.matches('input[data-default]')) refreshDiffs(); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!editable) return;
      const tariffs = {};
      const storage = {};
      form.querySelectorAll('input[data-kind="tariff"]').forEach((i) => { tariffs[i.name] = i.value === '' ? null : Number(i.value); });
      form.querySelectorAll('input[data-kind="storage"]').forEach((i) => { storage[i.dataset.size] = i.value === '' ? null : Number(i.value); });
      const btn = form.querySelector('[type="submit"]');
      ui.clearErrors(form);
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
      try {
        await api.put(`/api/partners/${p.id}/tariffs`, { tariffs, storage });
        ui.toast('Tarifák mentve.', 'ok');
        reload();
      } catch (err) {
        showTariffErrors(form, err);
      } finally {
        btn.removeAttribute('aria-busy');
        btn.disabled = false;
      }
    });

    const itemById = (b) => custom.find((c) => c.id === Number(b.dataset.id));
    ui.bind(el, {
      reset: async () => {
        const ok = await ui.confirm({
          title: 'Visszaállítás alapra',
          text: 'Az összes díjtétel és tárolási díj a Beállítások alapértékére áll vissza. Az egyedi tételek megmaradnak.',
          confirmLabel: 'Visszaállítás',
        });
        if (!ok) return;
        await ui.run(null, async () => {
          await api.post(`/api/partners/${p.id}/tariffs/reset`);
          ui.toast('A díjak az alapértékre álltak vissza.', 'ok');
          reload();
        });
      },
      'new-item': () => customItemDialog(p, null, reload),
      'edit-item': (b) => customItemDialog(p, itemById(b), reload),
      'remove-item': async (b) => {
        const it = itemById(b);
        if (!(await ui.confirm({ title: 'Egyedi tétel törlése', text: `Biztosan törlöd: ${it.name}?`, confirmLabel: 'Törlés', tone: 'danger' }))) return;
        await ui.run(null, async () => {
          await api.del(`/api/partners/${p.id}/custom-items/${it.id}`);
          ui.toast('Egyedi tétel törölve.', 'ok');
          reload();
        });
      },
    });
  }

  // The tariff inputs are named by tariff key and "storage_<size id>", matching the server's field errors.
  function showTariffErrors(form, err) {
    ui.showErrors(form, err);
    if (!err || !err.fields) return;
    for (const [name, msg] of Object.entries(err.fields)) {
      const input = form.querySelector(`[name="${CSS.escape(name)}"]`);
      if (input) input.title = msg;
    }
  }

  function customItemDialog(p, it, reload) {
    ui.dialog({
      title: it ? 'Egyedi tétel szerkesztése' : 'Új egyedi tétel',
      submitLabel: it ? 'Mentés' : 'Felvétel',
      body: html`<div class="form-grid">
        ${ui.field({ name: 'name', label: 'Megnevezés', value: it && it.name, required: true, span: 'all', placeholder: 'pl. Raklapfóliázás' })}
        ${ui.field({ name: 'kind', label: 'Típus', type: 'select', options: CUSTOM_KINDS, value: it ? it.kind : 'per_unit' })}
        ${ui.field({ name: 'unit', label: 'Egység', value: it ? it.unit : 'db', hint: 'Mennyiség alapú tételnél, pl. db, raklap, óra.' })}
        ${ui.field({ name: 'price', label: 'Nettó ár (Ft)', type: 'number', min: 0, value: it ? it.price : '', required: true })}
        ${ui.field({ name: 'active', label: 'Aktív (számlázásra kerül)', type: 'checkbox', value: it ? it.active : true })}
      </div>`,
      onSubmit: async (form) => {
        const v = ui.formValues(form);
        if (it) await api.patch(`/api/partners/${p.id}/custom-items/${it.id}`, v);
        else await api.post(`/api/partners/${p.id}/custom-items`, v);
        ui.toast(it ? 'Egyedi tétel mentve.' : 'Egyedi tétel felvéve.', 'ok');
        reload();
      },
    });
  }

  /* ------------------------------------------------------------ Integrációk */
  async function integrationsTab(box, p, reload) {
    const data = await api.get(`/api/partners/${p.id}/integrations`);
    const el = mount(box);
    const editable = can('approve');
    const hasPlatforms = data.platforms.length > 0;
    let connections = data.connections;
    const keyStatus = (k) => (k.revoked_at ? html`${chip('Visszavonva')}<span class="sub">${fmt.dateTime(k.revoked_at)}</span>` : chip('Aktív', 'ok'));
    const apiPrimary = !hasPlatforms;

    const connectionTable = () => ui.table({
      caption: 'Webshop kapcsolatok',
      rows: connections,
      empty: 'Nincs webshop kapcsolat.',
      columns: [
        { key: 'platform', label: 'Platform', cls: 'nowrap', render: (r) => html`<b>${r.platform_name}</b>${r.available ? '' : html`<span class="sub diff-neg">nem elérhető</span>`}` },
        { key: 'shop_url', label: 'Webshop', render: (r) => html`<a href="${r.shop_url}" target="_blank" rel="noopener">${r.shop_url.replace(/^https:\/\//, '')}</a>` },
        { key: 'active', label: 'Állapot', render: (r) => (r.active ? chip('Aktív', 'ok') : chip('Kikapcsolva')) },
        { key: 'last_sync_at', label: 'Utolsó szinkron', cls: 'nowrap', render: (r) => (r.last_sync_at ? fmt.dateTime(r.last_sync_at) : html`<span class="muted">még nem volt</span>`) },
        { key: 'last_error', label: 'Utolsó hiba', render: (r) => (r.last_error || r.credentials_error ? html`<span class="pt-error">${r.credentials_error || r.last_error}</span>` : html`<span class="muted">nincs</span>`) },
        ...(editable ? [{ key: 'a', label: 'Műveletek', align: 'r', render: (r) => html`<div class="pt-row-actions">
          <button class="btn btn--sm" type="button" data-action="test" data-id="${r.id}">${FL.icon('plugs-connected')}Kapcsolat tesztelése</button>
          <button class="btn btn--sm" type="button" data-action="sync" data-id="${r.id}" ${r.active ? '' : raw('disabled title="Kikapcsolt kapcsolat"')}>${FL.icon('arrow-clockwise')}Szinkronizálás most</button>
          ${iconBtn('edit-conn', 'pencil-simple', `${r.shop_url} szerkesztése`, `data-id="${r.id}"`)}
          ${iconBtn('remove-conn', 'trash', `${r.shop_url} törlése`, `data-id="${r.id}"`)}</div>` }] : []),
      ],
    });

    el.innerHTML = String(html`
      ${editable ? '' : ui.notice('Itt csak megtekintheted az integrációkat. A módosításhoz „Partnerek: tarifák és integrációk módosítása” jog kell.', 'info')}
      <section class="panel panel--flush">
        <div class="panel__head"><div><h2>Webshop kapcsolatok</h2>
          <p class="small muted">Az aktív kapcsolatokból a rendszer automatikusan importálja az új rendeléseket, és feladás után visszaküldi a csomagszámot.</p></div>
          ${editable ? html`<button class="btn ${hasPlatforms ? 'btn--primary' : ''}" type="button" data-action="new-conn" ${hasPlatforms ? '' : raw('disabled')}>${FL.icon('plus')}Új webshop kapcsolat</button>` : ''}</div>
        ${hasPlatforms ? '' : html`<div class="pt-pad">${ui.notice('Még nincs elérhető webshop integráció (Shopify, WooCommerce, Shoprenter, UNAS). Amint elkészül, itt tudod felvenni a kapcsolatot. Addig a rendelések CSV-ből vagy a partner API-n érkezhetnek.', 'info')}</div>`}
        <div data-conns>${connectionTable()}</div>
        <div class="pt-pad" data-result hidden></div>
      </section>

      <section class="panel panel--flush">
        <div class="panel__head"><div><h2>Partner API kulcsok</h2>
          <p class="small muted">Az ügyfél saját rendszere ezzel a kulccsal küldhet rendelést és betárolást, és lekérdezheti a készletét. A kulcsot csak létrehozáskor mutatjuk meg.</p></div>
          <div class="actions">
            <a class="btn" href="${data.api_docs_url}" target="_blank" rel="noopener">${FL.icon('code')}API dokumentáció</a>
            ${editable ? html`<button class="btn ${apiPrimary ? 'btn--primary' : ''}" type="button" data-action="new-key" ${p.status === 'active' ? '' : raw('disabled title="Inaktív ügyfélnek nem adható kulcs"')}>${FL.icon('key')}Új API kulcs</button>` : ''}
          </div></div>
        ${ui.table({
          caption: 'API kulcsok',
          rows: data.api_keys,
          empty: 'Még nincs API kulcs.',
          columns: [
            { key: 'prefix', label: 'Kulcs', render: (r) => html`<span class="mono">${r.prefix}...</span>` },
            { key: 'name', label: 'Név', cls: 'pt-name', render: (r) => html`<b>${r.name}</b>` },
            { key: 'created_at', label: 'Létrehozva', cls: 'nowrap', render: (r) => html`${fmt.dateTime(r.created_at)}${r.created_by_name ? html`<span class="sub">${r.created_by_name}</span>` : ''}` },
            { key: 'last_used_at', label: 'Utoljára használva', cls: 'nowrap', render: (r) => (r.last_used_at ? fmt.dateTime(r.last_used_at) : html`<span class="muted">még nem</span>`) },
            { key: 'status', label: 'Állapot', render: keyStatus },
            ...(editable ? [{ key: 'a', label: 'Műveletek', align: 'r', cls: 'nowrap', render: (r) => (r.revoked_at ? '' : html`<button class="btn btn--danger btn--sm" type="button" data-action="revoke" data-id="${r.id}">Visszavonás</button>`) }] : []),
          ],
        })}
      </section>`);

    const resultBox = el.querySelector('[data-result]');
    const showResult = (tone, content) => {
      resultBox.hidden = false;
      resultBox.innerHTML = String(ui.notice(content, tone, tone === 'ok' ? 'check-circle' : undefined));
    };
    const replaceConnection = (conn) => {
      connections = connections.map((c) => (c.id === conn.id ? conn : c));
      el.querySelector('[data-conns]').innerHTML = String(connectionTable());
    };
    const connById = (b) => connections.find((c) => c.id === Number(b.dataset.id));

    ui.bind(el, {
      'new-conn': () => connectionDialog(p, data.platforms, null, reload),
      'edit-conn': (b) => connectionDialog(p, data.platforms, connById(b), reload),
      'remove-conn': async (b) => {
        const c = connById(b);
        const ok = await ui.confirm({ title: 'Webshop kapcsolat törlése', text: `Biztosan törlöd: ${c.shop_url}? A mentett hozzáférési adatok is törlődnek, a már importált rendelések megmaradnak.`, confirmLabel: 'Törlés', tone: 'danger' });
        if (!ok) return;
        await ui.run(null, async () => {
          await api.del(`/api/partners/${p.id}/webshops/${c.id}`);
          ui.toast('Webshop kapcsolat törölve.', 'ok');
          reload();
        });
      },
      test: (b) => ui.run(b, async () => {
        const c = connById(b);
        const res = await api.post(`/api/partners/${p.id}/webshops/${c.id}/test`);
        showResult(res.result.ok ? 'ok' : 'danger', html`<p><b>${c.shop_url}:</b> ${res.result.message}</p>`);
        replaceConnection(res.connection);
      }),
      sync: (b) => ui.run(b, async () => {
        const c = connById(b);
        const res = await api.post(`/api/partners/${p.id}/webshops/${c.id}/sync`);
        const r = res.result;
        showResult(r.ok && !r.errors.length ? 'ok' : r.ok ? 'warn' : 'danger', html`
          <p><b>${c.shop_url}:</b> ${r.ok ? `${fmt.int(r.imported)} rendelés importálva, ${fmt.int(r.skipped)} kihagyva.` : 'A szinkronizálás nem sikerült.'}</p>
          ${r.errors.length ? html`<ul class="pt-errors">${r.errors.map((m) => html`<li>${m}</li>`)}</ul>` : ''}`);
        replaceConnection(res.connection);
      }),
      'new-key': () => apiKeyDialog(p, reload),
      revoke: async (b) => {
        const k = data.api_keys.find((x) => x.id === Number(b.dataset.id));
        const ok = await ui.confirm({ title: 'API kulcs visszavonása', text: `Visszavonod a(z) „${k.name}” kulcsot (${k.prefix}...)? Az ezt használó rendszer azonnal elveszti a hozzáférést. Ez nem vonható vissza.`, confirmLabel: 'Visszavonás', tone: 'danger' });
        if (!ok) return;
        await ui.run(null, async () => {
          await api.post(`/api/partners/${p.id}/api-keys/${k.id}/revoke`);
          ui.toast('API kulcs visszavonva.', 'ok');
          reload();
        });
      },
    });
  }

  // Inputs generated from the platform's field definitions. Credentials: "cred_<key>", settings: "set_<key>".
  function platformFields(def, conn) {
    if (!def) return '';
    const masked = conn ? conn.credentials || {} : {};
    const settings = conn ? conn.settings || {} : {};
    const creds = (def.credentialFields || []).map((f) => {
      const saved = masked[f.key];
      const t = String(f.type || 'password').toLowerCase();
      if (t === 'select') {
        return ui.field({
          name: `cred_${f.key}`, label: f.label || f.key, type: 'select', options: f.options || [], required: !!f.required && !saved,
          placeholder: saved ? 'Mentett érték megtartása' : 'Válassz', hint: f.help || '', span: 2,
        });
      }
      return ui.field({
        name: `cred_${f.key}`,
        label: f.label || f.key,
        type: ['text', 'url', 'email'].includes(t) ? 'text' : 'password',
        required: !!f.required && !saved,
        optional: !f.required,
        placeholder: saved ? `Mentve: ${saved}` : '',
        hint: [saved ? 'Hagyd üresen, ha nem változik.' : '', f.help || ''].filter(Boolean).join(' '),
        attrs: 'autocomplete="new-password" spellcheck="false"',
        span: 2,
      });
    });
    const sets = (def.settingFields || []).map((f) => {
      const value = settings[f.key] !== undefined ? settings[f.key] : f.default;
      const t = String(f.type || 'text').toLowerCase();
      const common = { name: `set_${f.key}`, label: f.label || f.key, required: !!f.required, optional: !f.required && !['checkbox', 'bool', 'boolean'].includes(t), hint: f.help || '', value };
      if (['checkbox', 'bool', 'boolean'].includes(t)) return ui.field({ ...common, type: 'checkbox', span: 'all' });
      if (t === 'select') return ui.field({ ...common, type: 'select', options: f.options || [], placeholder: f.required ? undefined : 'Nincs megadva' });
      if (['number', 'int', 'integer', 'num'].includes(t)) return ui.field({ ...common, type: 'number', int: t === 'int' || t === 'integer' });
      if (t === 'textarea') return ui.field({ ...common, type: 'textarea', rows: 3, span: 'all' });
      return ui.field({ ...common, type: ['url', 'email'].includes(t) ? t : 'text' });
    });
    return html`
      ${creds.length ? html`<fieldset class="pt-fieldset"><legend>Hozzáférési adatok</legend>
        <p class="small muted">Titkosítva tároljuk, és soha nem küldjük vissza a böngészőbe.</p><div class="form-grid">${creds}</div></fieldset>` : ''}
      ${sets.length ? html`<fieldset class="pt-fieldset"><legend>Beállítások</legend><div class="form-grid">${sets}</div></fieldset>` : ''}`;
  }

  function connectionDialog(p, defs, conn, reload) {
    let def = conn ? defs.find((d) => d.code === conn.platform) : defs[0];
    if (conn && !def) {
      ui.dialog({
        title: 'Webshop kapcsolat', size: 'narrow', hideSubmit: true, cancelLabel: 'Bezárás',
        body: html`<p>A(z) ${conn.platform_name} integráció most nem elérhető, ezért a kapcsolat beállításai nem módosíthatók. Törölni tudod.</p>`,
      });
      return;
    }
    ui.dialog({
      title: conn ? 'Webshop kapcsolat szerkesztése' : 'Új webshop kapcsolat',
      size: 'wide',
      submitLabel: conn ? 'Mentés' : 'Kapcsolat felvétele',
      body: html`<div class="form-grid">
          ${conn ? html`<div class="field"><span class="field__label">Platform</span><p class="pt-static">${conn.platform_name}</p></div>`
            : ui.field({ name: 'platform', label: 'Platform', type: 'select', options: defs.map((d) => [d.code, d.name]), value: def.code, required: true })}
          ${ui.field({ name: 'shop_url', label: 'Webshop címe', value: conn ? conn.shop_url : '', required: true, placeholder: 'https://bolt.hu', span: 2, attrs: 'inputmode="url" spellcheck="false"' })}
          ${ui.field({ name: 'active', label: 'Aktív (automatikus rendelésimport)', type: 'checkbox', value: conn ? conn.active : true, span: 'all' })}
        </div>
        <div data-platform-fields>${platformFields(def, conn)}</div>`,
      onOpen: ({ form }) => {
        const sel = form.querySelector('[name="platform"]');
        if (sel) sel.addEventListener('change', () => {
          def = defs.find((d) => d.code === sel.value);
          form.querySelector('[data-platform-fields]').innerHTML = String(platformFields(def, null));
        });
      },
      onSubmit: async (form) => {
        const v = ui.formValues(form);
        const body = { shop_url: v.shop_url, active: v.active, credentials: {}, settings: {} };
        if (!conn) body.platform = v.platform;
        for (const [k, val] of Object.entries(v)) {
          if (k.startsWith('cred_')) { if (val !== '') body.credentials[k.slice(5)] = val; } else if (k.startsWith('set_')) body.settings[k.slice(4)] = val;
        }
        if (conn && !Object.keys(body.credentials).length) delete body.credentials;
        if (conn) await api.patch(`/api/partners/${p.id}/webshops/${conn.id}`, body);
        else await api.post(`/api/partners/${p.id}/webshops`, body);
        ui.toast(conn ? 'Webshop kapcsolat mentve.' : 'Webshop kapcsolat felvéve. Teszteld a kapcsolatot.', 'ok');
        reload();
      },
    });
  }

  function apiKeyDialog(p, reload) {
    ui.dialog({
      title: 'Új API kulcs',
      size: 'narrow',
      submitLabel: 'Kulcs létrehozása',
      body: html`
        ${ui.field({ name: 'name', label: 'Mire használják?', required: true, placeholder: 'pl. Webshop backend, ERP', hint: 'Ezzel különböztetitek meg a kulcsokat a listában.', attrs: 'maxlength="100"' })}`,
      onSubmit: async (form) => {
        const res = await api.post(`/api/partners/${p.id}/api-keys`, ui.formValues(form));
        setTimeout(() => showKey(res, reload), 0);
      },
    });
  }

  function showKey(res, reload) {
    const dlg = ui.dialog({
      title: 'API kulcs létrehozva',
      hideSubmit: true,
      cancelLabel: 'Kimásoltam, bezárom',
      noAutofocus: true,
      body: html`
        ${ui.notice(html`<p><b>Ezt a kulcsot most látod utoljára.</b> Csak a lenyomatát tároljuk, később senki nem tudja újra megnézni. Másold ki, és biztonságos csatornán add át (például jelszókezelővel), ne sima e-mailben vagy chaten.</p>`, 'warn')}
        <div class="field">
          <label for="pt-key">API kulcs: ${res.name}</label>
          <div class="input-group">
            <input class="input pt-key" id="pt-key" type="text" readonly value="${res.key}" spellcheck="false" autocomplete="off">
            <button class="btn" type="button" data-copy>${FL.icon('copy')}Másolás</button>
          </div>
        </div>
        <p class="small muted">Használat a kérés fejlécében: <code>Authorization: Bearer ${res.prefix}...</code></p>`,
      onOpen: ({ form }) => {
        const input = form.querySelector('#pt-key');
        const btn = form.querySelector('[data-copy]');
        input.addEventListener('focus', () => input.select());
        btn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(res.key);
          } catch {
            input.select();
            document.execCommand('copy');
          }
          ui.toast('A kulcs a vágólapon van.', 'ok');
        });
        btn.focus();
      },
    });
    dlg.done.then(() => reload());
  }

  /* ------------------------------------------------------------ Összesítő */
  async function summaryTab(box, p) {
    const s = await api.get(`/api/partners/${p.id}/summary`);
    const el = mount(box);
    if (s.type === 'client') el.innerHTML = String(clientSummary(s));
    else if (s.type === 'carrier') el.innerHTML = String(carrierSummary(s));
    else el.innerHTML = String(supplierSummary(s));
    ui.enableRowLinks(el);
  }

  const monthName = (period) => FL.fmt.dateLong(`${period}-01`).replace(/\s*1\.$/, '');
  const orderHref = (r) => (FL.can('history', 'view') ? `#/rendelestortenet/${r.id}` : FL.can('orders', 'view') ? `#/megrendelesek/${r.id}` : null);
  const inboundHref = (r) => (FL.can('inbound', 'view') ? `#/betarolas/${r.id}` : null);
  const linkTo = (href, text) => (href ? html`<a class="mono" href="${href}">${text}</a>` : html`<span class="mono">${text}</span>`);

  function clientSummary(s) {
    const k = s.kpis;
    const sm = s.storage_month;
    return html`
      ${ui.kpis([
        { label: 'Aktív cikkek', value: fmt.int(k.active_skus), href: FL.can('stock', 'view') ? '#/keszlet' : null },
        { label: 'Készleten', value: fmt.qty(k.on_hand) },
        { label: 'Foglalt tárolóhely', value: fmt.int(k.occupied_locations), hint: s.occupied_by_size.map((x) => `${fmt.int(x.locations)} ${x.code}`).join(', ') || 'nincs' },
        { label: 'Nyitott betárolás', value: fmt.int(k.open_inbounds), tone: k.open_inbounds ? 'warn' : '' },
        { label: `Rendelés, ${monthName(s.period)}`, value: fmt.int(k.orders_this_month), hint: `Előző hónap: ${fmt.int(k.orders_last_month)}` },
      ])}
      <div class="grid-2">
        <section class="panel panel--flush">
          <div class="panel__head"><h2>Rendelések állapot szerint</h2></div>
          ${ui.table({
            caption: 'Rendelések állapot szerint',
            rows: s.orders_by_status,
            empty: 'Nincs rendelés ebben és az előző hónapban.',
            columns: [
              { key: 'status', label: 'Állapot', render: (r) => FL.status('order', r.status) },
              { key: 'this_month', label: monthName(s.period), align: 'r', cls: 'num', render: (r) => fmt.int(r.this_month) },
              { key: 'last_month', label: monthName(s.last_period), align: 'r', cls: 'num', render: (r) => fmt.int(r.last_month) },
            ],
            footer: s.orders_by_status.length ? html`<tr><td>Összesen</td><td class="r num">${fmt.int(k.orders_this_month)}</td><td class="r num">${fmt.int(k.orders_last_month)}</td></tr>` : '',
          })}
        </section>
        <section class="panel panel--flush">
          <div class="panel__head"><div><h2>Tárolás ebben a hónapban</h2>
            <p class="small muted">A napi pillanatképek alapján (${fmt.int(sm.days_snapshotted)} / ${fmt.int(sm.days_in_month)} nap), időarányos becslés.</p></div></div>
          ${sm.by_size.length ? ui.table({
            caption: 'Tárolás ebben a hónapban',
            rows: sm.by_size,
            columns: [
              { key: 'code', label: 'Méret', render: (r) => html`<span class="tag">${r.code}</span> ${r.name}` },
              { key: 'location_days', label: 'Helynap', align: 'r', cls: 'num', render: (r) => fmt.int(r.location_days) },
              { key: 'avg_locations', label: 'Átlag hely', align: 'r', cls: 'num', render: (r) => fmt.num(r.avg_locations, 1) },
              { key: 'price', label: 'Havi díj', align: 'r', cls: 'num', render: (r) => fmt.money(r.price) },
              { key: 'amount', label: 'Eddig', align: 'r', cls: 'num', render: (r) => fmt.money(r.amount) },
            ],
            footer: html`<tr><td colspan="4">Összesen eddig (nettó)</td><td class="r num">${fmt.money(sm.total)}</td></tr>`,
          }) : html`<div class="pt-pad">${ui.empty(sm.days_snapshotted ? 'Ebben a hónapban nem volt foglalt tárolóhelye.' : 'Ebben a hónapban még nincs napi tárolási pillanatkép.')}</div>`}
        </section>
      </div>
      <section class="panel panel--flush">
        <div class="panel__head"><h2>Nyitott betárolások</h2></div>
        ${ui.table({
          caption: 'Nyitott betárolások',
          rows: s.open_inbounds,
          rowHref: inboundHref,
          empty: 'Nincs nyitott betárolás.',
          columns: [
            { key: 'number', label: 'Szám', render: (r) => linkTo(inboundHref(r), r.number) },
            { key: 'expected_date', label: 'Várható', cls: 'nowrap', render: (r) => fmt.date(r.expected_date) || html`<span class="muted">nincs megadva</span>` },
            { key: 'external_ref', label: 'Hivatkozás' },
            { key: 'lines', label: 'Tétel', align: 'r', cls: 'num', render: (r) => fmt.int(r.lines) },
            { key: 'expected_qty', label: 'Várt db', align: 'r', cls: 'num', render: (r) => fmt.int(r.expected_qty) },
            { key: 'status', label: 'Állapot', render: (r) => FL.status('inbound', r.status) },
          ],
        })}
      </section>
      <section class="panel panel--flush">
        <div class="panel__head"><h2>Utolsó 10 feladott rendelés</h2></div>
        ${ui.table({
          caption: 'Utolsó feladott rendelések',
          rows: s.last_shipped,
          rowHref: orderHref,
          empty: 'Még nem adtunk fel rendelést.',
          columns: [
            { key: 'number', label: 'Szám', render: (r) => html`${linkTo(orderHref(r), r.number)}${r.external_number ? html`<span class="sub">${r.external_number}</span>` : ''}` },
            { key: 'shipped_at', label: 'Feladva', cls: 'nowrap', render: (r) => fmt.dateTime(r.shipped_at) },
            { key: 'customer_name', label: 'Címzett', render: (r) => html`${r.customer_name}${r.city ? html`<span class="sub">${r.city}</span>` : ''}` },
            { key: 'items', label: 'Termék', align: 'r', cls: 'num', render: (r) => fmt.int(r.items) },
            { key: 'carrier_name', label: 'Fuvarozó', render: (r) => html`${r.carrier_name || ''}${r.tracking_number ? html`<span class="sub mono">${r.tracking_number}</span>` : ''}` },
            { key: 'status', label: 'Állapot', render: (r) => FL.status('order', r.status) },
          ],
        })}
      </section>`;
  }

  function carrierSummary(s) {
    const k = s.kpis;
    return html`
      ${ui.kpis([
        { label: 'Feladott rendelés ebben a hónapban', value: fmt.int(k.shipped_this_month), hint: monthName(s.period) },
        { label: 'Feladott rendelés az előző hónapban', value: fmt.int(k.shipped_last_month), hint: monthName(s.last_period) },
        { label: 'Futárátvétel ebben a hónapban', value: fmt.int(k.pickups_this_month) },
      ])}
      <div class="grid-2">
        <section class="panel panel--flush">
          <div class="panel__head"><h2>Ügyfelek szerint, ebben a hónapban</h2></div>
          ${ui.table({
            caption: 'Feladott rendelések ügyfelenként',
            rows: s.by_client,
            rowHref: (r) => `${BASE}/${r.id}/osszesito`,
            empty: 'Ebben a hónapban még nem adtunk fel vele rendelést.',
            columns: [
              { key: 'name', label: 'Ügyfél', render: (r) => html`<a href="${BASE}/${r.id}/osszesito">${r.name}</a><span class="sub mono">${r.code}</span>` },
              { key: 'orders', label: 'Rendelés', align: 'r', cls: 'num', render: (r) => fmt.int(r.orders) },
            ],
          })}
        </section>
        <section class="panel panel--flush">
          <div class="panel__head"><h2>Utolsó futárátvételek</h2></div>
          ${ui.table({
            caption: 'Utolsó futárátvételek',
            rows: s.last_pickups,
            empty: 'Még nem volt futárátvétel.',
            columns: [
              { key: 'number', label: 'Szám', cls: 'num' },
              { key: 'date', label: 'Nap', cls: 'nowrap', render: (r) => html`${fmt.date(r.date)}${r.window_from ? html`<span class="sub">${r.window_from}${r.window_to ? ` és ${r.window_to} között` : ''}</span>` : ''}` },
              { key: 'orders', label: 'Rendelés', align: 'r', cls: 'num', render: (r) => fmt.int(r.orders) },
              { key: 'manifest_number', label: 'Manifeszt', cls: 'num' },
              { key: 'status', label: 'Állapot', render: (r) => FL.status('pickup', r.status) },
            ],
          })}
        </section>
      </div>`;
  }

  function supplierSummary(s) {
    const k = s.kpis;
    return html`
      ${ui.kpis([
        { label: `Betárolás ${s.year}-ban`, value: fmt.int(k.inbounds_this_year) },
        { label: 'Nyitott betárolás', value: fmt.int(k.open_inbounds), tone: k.open_inbounds ? 'warn' : '' },
        { label: `Átvett darab ${s.year}-ban`, value: fmt.int(k.received_this_year) },
      ])}
      <section class="panel panel--flush">
        <div class="panel__head"><h2>Utolsó betárolások</h2></div>
        ${ui.table({
          caption: 'Utolsó betárolások',
          rows: s.last_inbounds,
          rowHref: inboundHref,
          empty: 'Még nem érkezett tőle áru.',
          columns: [
            { key: 'number', label: 'Szám', render: (r) => linkTo(inboundHref(r), r.number) },
            { key: 'client_name', label: 'Ügyfél', render: (r) => html`${r.client_name}<span class="sub mono">${r.client_code}</span>` },
            { key: 'expected_date', label: 'Várható', cls: 'nowrap', render: (r) => fmt.date(r.expected_date) },
            { key: 'external_ref', label: 'Szállítólevél' },
            { key: 'expected_qty', label: 'Várt db', align: 'r', cls: 'num', render: (r) => fmt.int(r.expected_qty) },
            { key: 'received_qty', label: 'Átvett db', align: 'r', cls: 'num', render: (r) => fmt.int(r.received_qty) },
            { key: 'status', label: 'Állapot', render: (r) => FL.status('inbound', r.status) },
          ],
        })}
      </section>`;
  }
})();
