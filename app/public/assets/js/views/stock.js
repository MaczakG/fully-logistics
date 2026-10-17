/* Készlet view.
     #/keszlet                  stock per product and client, location occupancy summary
     #/keszlet/helyek           locations: which client holds which location, empty ones by size
     #/keszlet/termek/<id>      product page: locations and lots, reservations, movements,
                                transfer (stock edit) and manual adjustment (stock approve)
     #/keszlet/cikktorzs        product catalogue: create, edit, deactivate, CSV import and export
     #/keszlet/mozgasok         movement ledger with filters and CSV export */
(() => {
  'use strict';
  const FL = window.FL;
  const { html, raw, ui, api, fmt } = FL;
  const ROUTE = '#/keszlet';
  const STOCK_STATUS = { ok: ['Rendben', 'ok'], low: ['Alacsony', 'warn'], out: ['Elfogyott', 'danger'] };
  const REF_ROUTES = { inbound: '#/betarolas/', order: '#/megrendelesek/', wave: '#/komissio/', count: '#/leltar/' };
  const REF_LABELS = { inbound: 'Betárolás', order: 'Rendelés', wave: 'Komissió', count: 'Leltár', return: 'Visszáru', manual: 'Kézi' };
  const MOVE_TONES = { inbound: 'ok', return: 'info', pick: 'neutral', adjust: 'warn', transfer_out: 'neutral', transfer_in: 'neutral', cancel_pick: 'info' };
  const REASONS = ['Leltáreltérés', 'Sérült áru, selejtezés', 'Talált áru', 'Hibás könyvelés javítása', 'Ügyfél kérésére', 'Egyéb'];
  const PRODUCT_CSV = ['Ügyfélkód', 'Cikkszám', 'Megnevezés', 'EAN', 'Egység', 'Súly (kg)', 'Szélesség (cm)', 'Mélység (cm)', 'Magasság (cm)', 'Minimum készlet', 'Sarzskövetés', 'Lejáratkövetés'];

  const chip = (text, tone = 'neutral') => html`<span class="chip" data-tone="${tone}">${text}</span>`;
  const stockChip = (s) => chip(STOCK_STATUS[s][0], STOCK_STATUS[s][1]);
  const intOf = (v) => Math.max(parseInt(v || '0', 10) || 0, 0);
  const signed = (n) => html`<span class="num ${n > 0 ? 'diff-pos' : n < 0 ? 'diff-neg' : ''}">${n > 0 ? '+' : ''}${fmt.int(n)}</span>`;
  const dims = (p) => ([p.width_cm, p.depth_cm, p.height_cm].every((v) => v == null) ? '' : `${[p.width_cm, p.depth_cm, p.height_cm].map((v) => (v == null ? '?' : fmt.num(v, 1))).join(' x ')} cm`);
  const sizes = () => (FL.state.meta && FL.state.meta.sizes) || [];
  const kindLabel = (k) => (FL.state.meta.locationKinds && FL.state.meta.locationKinds[k]) || k;
  const clientList = async () => (await api.get('/api/lookup/partners', { type: 'client', all: 1 })).items;
  const partnerOptions = (items) => items.map((p) => ({ value: p.id, label: `${p.name} (${p.code})` }));

  // Same rule as the server (worker/routes/stock.js eanWarning), for the live hint in the form.
  function eanWarning(ean) {
    const s = String(ean || '').trim();
    if (!s) return '';
    if (!/^\d+$/.test(s)) return 'Az EAN nem csak számjegyekből áll. Ellenőrizd, hogy valóban vonalkód-e.';
    if (![8, 12, 13, 14].includes(s.length)) return `Az EAN hossza ${s.length} számjegy. Szabványos hossz: 8, 12, 13 vagy 14.`;
    const digits = s.split('').map(Number);
    const check = digits.pop();
    let sum = 0;
    digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
    const expected = (10 - (sum % 10)) % 10;
    return check === expected ? '' : `Az EAN ellenőrző számjegye hibás (${check} helyett ${expected} lenne helyes).`;
  }

  function expiryCell(expiry) {
    if (!expiry) return html`<span class="muted">nincs</span>`;
    const today = FL.today();
    if (expiry < today) return html`<span class="stk-exp stk-exp--past">${fmt.date(expiry)}</span><span class="sub">lejárt</span>`;
    if (expiry <= FL.addDays(today, 30)) return html`<span class="stk-exp stk-exp--soon">${fmt.date(expiry)}</span><span class="sub">30 napon belül lejár</span>`;
    return fmt.date(expiry);
  }

  const searchField = (id, value, placeholder, label = 'Keresés') => html`<div class="field field--grow"><label for="${id}">${label}</label>
    <input class="input" id="${id}" name="q" type="search" value="${value}" placeholder="${placeholder}" autocomplete="off"></div>`;

  const filterButtons = (clearHref, filtered) => html`<div class="actions">
    <button class="btn" type="submit">${FL.icon('funnel')}Szűrés</button>
    ${filtered ? html`<a class="btn btn--ghost" href="${clearHref}">Szűrők törlése</a>` : ''}
  </div>`;

  function bindFilters(root, base) {
    const form = root.querySelector('[data-filters]');
    if (!form) return;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      FL.go(base + FL.qs(Object.fromEntries(new FormData(form).entries())));
    });
  }

  const tabs = (active) => ui.tabs([
    { key: 'stock', label: 'Készlet', href: ROUTE, icon: 'stack' },
    { key: 'catalog', label: 'Cikktörzs', href: `${ROUTE}/cikktorzs`, icon: 'package' },
    { key: 'movements', label: 'Mozgások', href: `${ROUTE}/mozgasok`, icon: 'arrows-left-right' },
  ], active, 'Készlet fülei');

  const head = (actions) => ui.pageHead({
    title: 'Készlet',
    lead: 'Ügyfelenkénti készlet raktárhely és sarzs szerint, cikktörzs és készletmozgások.',
    actions,
  });

  // core/app.js (which defines FL.view) loads after the views and keeps an existing FL.views,
  // so register directly when FL.view is not there yet.
  const register = (key, def) => (typeof FL.view === 'function' ? FL.view(key, def) : ((FL.views = FL.views || {})[key] = def));

  register('stock', {
    async render(root, ctx) {
      const [sub, id] = ctx.params;
      if (sub === 'termek') {
        const pid = Number(id);
        if (!Number.isInteger(pid) || pid <= 0) { root.innerHTML = String(ui.empty('Ez a termék nem létezik.', 'warning-circle')); return null; }
        return renderProduct(root, pid);
      }
      if (sub === 'cikktorzs') return renderCatalog(root, ctx);
      if (sub === 'mozgasok') return renderMovements(root, ctx);
      if (sub === 'helyek') return renderLocations(root, ctx);
      if (sub) { root.innerHTML = String(ui.empty('Ez az oldal nem létezik.', 'warning-circle')); return null; }
      return renderStock(root, ctx);
    },
  });

  /* ================================================================ Készlet */

  async function renderStock(root, ctx) {
    const q = ctx.query;
    const f = { q: q.get('q') || '', partner_id: q.get('partner_id') || '', status: q.get('status') || (q.get('low') === '1' ? 'attention' : '') };
    const offset = intOf(q.get('offset'));
    const limit = 50;
    const [data, occ, clients] = await Promise.all([
      api.get('/api/stock', { ...f, limit, offset }),
      api.get('/api/stock/locations', { limit: 1 }),
      clientList(),
    ]);
    const s = data.summary;
    const bySize = occ.summary.bySize;
    const free = bySize.reduce((n, x) => n + x.empty, 0);
    const total = bySize.reduce((n, x) => n + x.total, 0);
    const link = (p) => ROUTE + FL.qs(p);
    const filtered = Boolean(f.q || f.partner_id || f.status);

    root.innerHTML = String(html`
      ${head(html`<button class="btn" type="button" data-action="export">${FL.icon('download-simple')}CSV export</button>`)}
      ${tabs('stock')}
      ${ui.kpis([
        { label: 'Cikkek', value: fmt.int(s.products), hint: `${fmt.int(s.on_hand)} db készleten` },
        { label: 'Alacsony készlet', value: fmt.int(s.low), hint: 'a minimum alatt', tone: s.low ? 'warn' : '', href: link({ partner_id: f.partner_id, status: 'low' }) },
        { label: 'Elfogyott', value: fmt.int(s.out), hint: 'nincs elérhető darab', tone: s.out ? 'danger' : '', href: link({ partner_id: f.partner_id, status: 'out' }) },
        { label: 'Szabad tárolóhely', value: fmt.int(free), hint: `${fmt.int(total)} aktív tárolóhelyből`, href: `${ROUTE}/helyek?state=empty` },
      ])}
      <form class="toolbar" data-filters role="search" aria-label="Készlet szűrése">
        ${searchField('stk-q', f.q, 'Cikkszám, megnevezés vagy EAN')}
        ${ui.field({ name: 'partner_id', label: 'Ügyfél', type: 'select', value: f.partner_id, placeholder: 'Minden ügyfél', options: partnerOptions(clients) })}
        ${ui.field({ name: 'status', label: 'Állapot', type: 'select', value: f.status, placeholder: 'Minden állapot',
          options: [['attention', 'Csak alacsony vagy elfogyott'], ['low', 'Alacsony'], ['out', 'Elfogyott'], ['ok', 'Rendben']] })}
        ${filterButtons(ROUTE, filtered)}
      </form>
      ${ui.table({
        caption: 'Készlet termékenként',
        cls: 'stk-mid',
        empty: filtered ? 'Nincs a szűrésnek megfelelő cikk.' : 'Még nincs cikk a cikktörzsben.',
        rows: data.items,
        rowHref: (r) => `${ROUTE}/termek/${r.product_id}`,
        rowAttrs: (r) => (r.status === 'ok' ? '' : `class="stk-row--${r.status}"`),
        columns: [
          { key: 'partner_code', label: 'Ügyfél', render: (r) => html`<span class="tag">${r.partner_code}</span>` },
          { key: 'sku', label: 'Cikk', cardTitle: true, render: (r) => html`<a class="mono stk-code" href="${ROUTE}/termek/${r.product_id}">${r.sku}</a><span class="sub">${r.name}${r.active ? '' : ', inaktív'}</span>` },
          { key: 'on_hand', label: 'Készleten', align: 'r', cls: 'num', render: (r) => fmt.int(r.on_hand) },
          { key: 'reserved', label: 'Foglalt', align: 'r', cls: 'num', render: (r) => (r.reserved ? fmt.int(r.reserved) : html`<span class="muted">0</span>`) },
          { key: 'blocked', label: 'Zárolt', align: 'r', cls: 'num', render: (r) => (r.blocked ? html`<span class="diff-neg">${fmt.int(r.blocked)}</span>` : html`<span class="muted">0</span>`) },
          { key: 'available', label: 'Elérhető', align: 'r', cls: 'num', render: (r) => html`<b class="${r.available <= 0 ? 'diff-neg' : ''}">${fmt.int(r.available)}</b>` },
          { key: 'min_stock', label: 'Minimum', align: 'r', cls: 'num', render: (r) => fmt.int(r.min_stock) },
          { key: 'status', label: 'Állapot', render: (r) => stockChip(r.status) },
          { key: 'locations', label: 'Helyek', align: 'r', cls: 'num', render: (r) => fmt.int(r.locations) },
          { key: 'next_expiry', label: 'Első lejárat', cls: 'nowrap', render: (r) => (r.next_expiry ? expiryCell(r.next_expiry) : '') },
        ],
      })}
      ${ui.pager({ total: data.total, limit, offset })}
      ${occupancyPanel(occ.summary)}`);

    ui.enableRowLinks(root);
    bindFilters(root, ROUTE);
    ui.bind(root, {
      export: (el) => ui.run(el, () => api.download('/api/stock/export', f)),
      page: (el) => FL.go(link({ ...f, offset: el.dataset.offset })),
    });
    return null;
  }

  function occupancyPanel(summary) {
    const codes = sizes().map((z) => z.code);
    return html`<section class="panel panel--flush" aria-labelledby="stk-occ-h">
      <div class="panel__head">
        <div><h2 id="stk-occ-h">Raktárhelyek foglaltsága</h2>
          <p class="muted small">Aktív tárolóhelyek méret és ügyfél szerint. Egy helyen mindig csak egy ügyfél áruja lehet.</p></div>
        <a class="btn btn--sm" href="${ROUTE}/helyek">${FL.icon('map-trifold')}Helyek listája</a>
      </div>
      <div class="stk-occ">
        ${ui.table({
          caption: 'Foglaltság méret szerint',
          empty: 'Még nincs tárolóhely. Vedd fel őket a Beállítások, Raktárhelyek oldalon.',
          rows: summary.bySize,
          columns: [
            { key: 'code', label: 'Méret', cls: 'nowrap', render: (z) => html`<span class="tag">${z.code}</span> ${z.name}` },
            { key: 'total', label: 'Összes', align: 'r', cls: 'num', render: (z) => fmt.int(z.total) },
            { key: 'occupied', label: 'Foglalt', align: 'r', cls: 'num', render: (z) => fmt.int(z.occupied) },
            { key: 'empty', label: 'Szabad', align: 'r', cls: 'num', render: (z) => html`<a href="${ROUTE}/helyek?state=empty&size_id=${z.size_id}">${fmt.int(z.empty)}</a>${z.empty_dedicated ? html`<span class="sub">ebből ${fmt.int(z.empty_dedicated)} fix</span>` : ''}` },
            { key: 'usage', label: 'Kihasználtság', render: (z) => {
              const p = z.total ? Math.round((z.occupied / z.total) * 100) : 0;
              return html`<div class="stk-usage"><div class="progress" role="img" aria-label="${p}% foglalt"><span style="width:${p}%"></span></div><span class="num small">${p}%</span></div>`;
            } },
          ],
        })}
        ${ui.table({
          caption: 'Foglalt helyek ügyfelenként',
          empty: 'Egyik tárolóhelyen sincs áru.',
          rows: summary.byPartner,
          rowHref: (p) => `${ROUTE}/helyek?partner_id=${p.partner_id}&state=occupied`,
          columns: [
            { key: 'name', label: 'Ügyfél', render: (p) => html`${p.name}<span class="sub">${p.code}</span>` },
            ...codes.map((c) => ({ key: c, label: c, align: 'r', cls: 'num', render: (p) => (p.sizes[c] ? fmt.int(p.sizes[c]) : html`<span class="muted">0</span>`) })),
            { key: 'total', label: 'Összesen', align: 'r', cls: 'num', render: (p) => html`<b>${fmt.int(p.total)}</b>` },
          ],
        })}
      </div>
    </section>`;
  }

  /* ================================================================ Helyek */

  async function renderLocations(root, ctx) {
    const q = ctx.query;
    const f = { q: q.get('q') || '', state: q.get('state') || '', size_id: q.get('size_id') || '', partner_id: q.get('partner_id') || '', kind: q.get('kind') || 'storage' };
    const offset = intOf(q.get('offset'));
    const limit = 100;
    const [data, clients] = await Promise.all([api.get('/api/stock/locations', { ...f, limit, offset }), clientList()]);
    const base = `${ROUTE}/helyek`;
    const filtered = Boolean(f.q || f.state || f.size_id || f.partner_id || f.kind !== 'storage');
    const kinds = Object.entries(FL.state.meta.locationKinds || {}).map(([k, v]) => ({ value: k, label: v }));
    root.innerHTML = String(html`
      ${ui.pageHead({ crumb: { href: ROUTE, label: 'Készlet' }, title: 'Raktárhelyek', lead: 'Melyik helyen melyik ügyfél áruja van, és hol van szabad hely méret szerint.' })}
      <form class="toolbar" data-filters role="search" aria-label="Raktárhelyek szűrése">
        ${searchField('loc-q', f.q, 'pl. A-01', 'Hely kódja')}
        ${ui.field({ name: 'state', label: 'Foglaltság', type: 'select', value: f.state, placeholder: 'Mind', options: [['empty', 'Üres'], ['occupied', 'Foglalt']] })}
        ${ui.field({ name: 'size_id', label: 'Méret', type: 'select', value: f.size_id, placeholder: 'Minden méret', options: sizes().map((z) => ({ value: z.id, label: `${z.code}, ${z.name}` })) })}
        ${ui.field({ name: 'partner_id', label: 'Ügyfél', type: 'select', value: f.partner_id, placeholder: 'Minden ügyfél', options: partnerOptions(clients) })}
        ${ui.field({ name: 'kind', label: 'Típus', type: 'select', value: f.kind, options: [...kinds, { value: 'all', label: 'Minden típus' }] })}
        ${filterButtons(base, filtered)}
      </form>
      ${ui.table({
        caption: 'Raktárhelyek',
        cls: 'stk-mid',
        empty: 'Nincs a szűrésnek megfelelő raktárhely.',
        rows: data.items,
        rowHref: (l) => `${ROUTE}/mozgasok?location_id=${l.id}`,
        columns: [
          { key: 'code', label: 'Hely', render: (l) => html`<a class="mono stk-code" href="${ROUTE}/mozgasok?location_id=${l.id}">${l.code}</a>` },
          { key: 'zone', label: 'Zóna', render: (l) => l.zone },
          { key: 'size_code', label: 'Méret', render: (l) => html`<span class="tag">${l.size_code}</span>` },
          { key: 'kind', label: 'Típus', render: (l) => l.kind_label },
          { key: 'occupant', label: 'Ügyfél', render: (l) => (l.occupant_name ? html`${l.occupant_name}<span class="sub">${l.occupant_code}</span>` : html`<span class="muted">üres</span>`) },
          { key: 'dedicated', label: 'Fix hely', render: (l) => (l.dedicated_partner_code ? html`<span class="tag">${l.dedicated_partner_code}</span>` : '') },
          { key: 'products', label: 'Cikkek', align: 'r', cls: 'num', render: (l) => fmt.int(l.products) },
          { key: 'qty', label: 'Mennyiség', align: 'r', cls: 'num', render: (l) => fmt.int(l.qty) },
        ],
      })}
      ${ui.pager({ total: data.total, limit, offset })}`);
    ui.enableRowLinks(root);
    bindFilters(root, base);
    ui.bind(root, { page: (el) => FL.go(base + FL.qs({ ...f, offset: el.dataset.offset })) });
    return null;
  }

  /* ================================================================ product page */

  const rowLabel = (r) => [r.code, r.lot ? `sarzs ${r.lot}` : '', r.expiry ? `lejárat ${fmt.date(r.expiry)}` : '', `${fmt.int(r.qty)} db`].filter(Boolean).join(', ');

  async function renderProduct(root, id) {
    const data = await api.get(`/api/stock/product/${id}`);
    const p = data.product;
    const a = data.availability;
    const rows = data.locations;
    const canEdit = FL.can('stock', 'edit');
    const canApprove = FL.can('stock', 'approve');
    const canDelete = FL.can('stock', 'delete');
    const actions = [];
    if (canEdit && rows.length) actions.push(html`<button class="btn btn--primary" type="button" data-action="transfer">${FL.icon('arrows-left-right')}Áttárolás</button>`);
    if (canApprove) actions.push(html`<button class="btn" type="button" data-action="adjust">${FL.icon('pencil-simple')}Készletkorrekció</button>`);
    if (canEdit) actions.push(html`<button class="btn" type="button" data-action="edit">${FL.icon('package')}Cikkadatok</button>`);
    if (canDelete) {
      actions.push(p.active
        ? html`<button class="btn btn--danger" type="button" data-action="deactivate">${FL.icon('eye-slash')}Inaktiválás</button>`
        : html`<button class="btn" type="button" data-action="activate">${FL.icon('eye')}Újraaktiválás</button>`);
    }
    const unit = p.unit || 'db';
    const info = [
      ['Cikkszám', html`<span class="mono">${p.sku}</span>`],
      ['EAN', p.ean ? html`<span class="mono">${p.ean}</span>${p.ean_warning ? html`<span class="stk-warn">${FL.icon('warning')}${p.ean_warning}</span>` : ''}` : 'nincs'],
      ['Egység', unit],
      ['Súly', p.weight_kg != null ? fmt.kg(p.weight_kg) : 'nincs megadva'],
      ['Méretek', dims(p) || 'nincs megadva'],
      ['Minimum készlet', `${fmt.int(p.min_stock)} ${unit}`],
      ['Követés', html`<span class="stk-tags">${p.track_lot ? html`<span class="tag">sarzs</span>` : ''}${p.track_expiry ? html`<span class="tag">lejárat</span>` : ''}${!p.track_lot && !p.track_expiry ? 'nincs' : ''}</span>`],
      ['Állapot', p.active ? chip('Aktív', 'ok') : chip('Inaktív', 'neutral')],
    ];
    if (p.notes) info.push(['Megjegyzés', p.notes]);

    root.innerHTML = String(html`
      ${ui.pageHead({ crumb: { href: ROUTE, label: 'Készlet' }, title: html`<span class="mono">${p.sku}</span> ${p.name}`, lead: `${p.partner_name} (${p.partner_code})`, actions })}
      ${p.active ? '' : ui.notice('Ez a cikk inaktív: nem rendelhető, és új betárolásra sem vehető fel.', 'warn')}
      ${ui.kpis([
        { label: 'Készleten', value: fmt.int(a.onHand), hint: `${fmt.int(rows.length)} helyen` },
        { label: 'Foglalt', value: fmt.int(a.reserved), hint: 'nyitott rendelések' },
        { label: 'Zárolt', value: fmt.int(a.blocked), hint: 'karanténban', tone: a.blocked ? 'danger' : '' },
        { label: 'Elérhető', value: fmt.int(a.available), hint: `${a.status_label}, minimum ${fmt.int(p.min_stock)}`, tone: STOCK_STATUS[a.status][1] === 'ok' ? '' : STOCK_STATUS[a.status][1] },
        { label: 'Beérkező', value: fmt.int(a.incoming), hint: 'nyitott betárolásokból', href: a.incoming ? '#/betarolas?status=open' : '' },
      ])}
      <div class="stk-product">
        <section class="panel panel--flush" aria-labelledby="stk-loc-h">
          <div class="panel__head"><h2 id="stk-loc-h">Készlet helyenként</h2><span class="muted small">Első lejárat elöl (FEFO)</span></div>
          ${ui.table({
            caption: 'Készlet helyenként',
            empty: 'Ebből a cikkből nincs készlet.',
            rows,
            columns: [
              { key: 'code', label: 'Hely', render: (r) => html`<span class="mono stk-code">${r.code}</span>${r.kind !== 'storage' ? html`<span class="sub">${r.kind_label}</span>` : ''}` },
              { key: 'size_code', label: 'Méret', render: (r) => html`<span class="tag">${r.size_code}</span>` },
              { key: 'lot', label: 'Sarzs', render: (r) => (r.lot ? html`<span class="mono stk-code">${r.lot}</span>` : html`<span class="muted">nincs</span>`) },
              { key: 'expiry', label: 'Lejárat', cls: 'nowrap', render: (r) => expiryCell(r.expiry) },
              { key: 'qty', label: 'Mennyiség', align: 'r', cls: 'num', render: (r) => html`<b>${fmt.int(r.qty)}</b>` },
              ...(canEdit || canApprove ? [{ key: 'act', label: 'Művelet', align: 'r', render: (r) => html`<span class="stk-row-actions">
                ${canEdit ? html`<button class="btn btn--sm btn--icon btn--ghost" type="button" data-action="transfer" data-row="${rows.indexOf(r)}" aria-label="Áttárolás innen: ${r.code}" title="Áttárolás">${FL.icon('arrows-left-right')}</button>` : ''}
                ${canApprove ? html`<button class="btn btn--sm btn--icon btn--ghost" type="button" data-action="adjust" data-row="${rows.indexOf(r)}" aria-label="Korrekció: ${r.code}" title="Készletkorrekció">${FL.icon('pencil-simple')}</button>` : ''}
              </span>` }] : []),
            ],
            footer: rows.length ? html`<tr><td colspan="4">Összesen</td><td class="r num">${fmt.int(a.onHand)}</td>${canEdit || canApprove ? html`<td></td>` : ''}</tr>` : '',
          })}
        </section>
        <section class="panel" aria-labelledby="stk-data-h"><h2 id="stk-data-h">Cikkadatok</h2>
          <dl class="dl">${info.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl></section>
      </div>
      ${data.reservations.length ? html`<section class="panel panel--flush" aria-labelledby="stk-res-h">
        <div class="panel__head"><h2 id="stk-res-h">Foglalások</h2><span class="muted small">Nyitott rendelések, még ki nem szedett mennyiség</span></div>
        ${ui.table({
          caption: 'Foglalások',
          rows: data.reservations,
          rowHref: (r) => `#/megrendelesek/${r.id}`,
          columns: [
            { key: 'number', label: 'Rendelés', render: (r) => html`<a class="mono" href="#/megrendelesek/${r.id}">${r.number}</a>` },
            { key: 'status', label: 'Állapot', render: (r) => FL.status('order', r.status) },
            { key: 'customer_name', label: 'Vevő', render: (r) => r.customer_name },
            { key: 'qty', label: 'Mennyiség', align: 'r', cls: 'num', render: (r) => fmt.int(r.qty) },
          ],
        })}
      </section>` : ''}
      <section class="panel panel--flush" aria-labelledby="stk-mov-h">
        <div class="panel__head"><h2 id="stk-mov-h">Utolsó mozgások</h2>
          <a class="btn btn--sm" href="${ROUTE}/mozgasok?product_id=${p.id}">${FL.icon('list-checks')}Összes mozgás</a></div>
        ${movementTable(data.movements, { showProduct: false })}
      </section>`);

    ui.enableRowLinks(root);
    const refresh = () => FL.reload();
    ui.bind(root, {
      transfer: (el) => transferDialog(p, rows, el.dataset.row != null ? Number(el.dataset.row) : 0, refresh),
      adjust: (el) => adjustDialog(p, rows, el.dataset.row != null ? Number(el.dataset.row) : (rows.length ? 0 : 'new'), refresh),
      edit: () => productDialog(p, refresh),
      deactivate: async (el) => {
        const okToGo = await ui.confirm({ title: 'Cikk inaktiválása', text: `Inaktiválod a(z) ${p.sku} cikket? Utána nem lehet rendelni és betárolni, amíg újra nem aktiválod.`, confirmLabel: 'Inaktiválás', tone: 'danger' });
        if (!okToGo) return;
        await ui.run(el, async () => { await api.post(`/api/products/${p.id}/deactivate`); ui.toast('A cikk inaktív lett.', 'ok'); refresh(); });
      },
      activate: (el) => ui.run(el, async () => { await api.post(`/api/products/${p.id}/activate`); ui.toast('A cikk újra aktív.', 'ok'); refresh(); }),
    });
    return null;
  }

  function locationAutocomplete(input, onPick) {
    ui.autocomplete(input, {
      source: async (q) => (await api.get('/api/lookup/locations', { q })).items.filter((x) => x.kind !== 'packing'),
      label: (x) => x.code,
      sub: (x) => `${kindLabel(x.kind)}, ${x.size_code}`,
      onSelect: (x) => { input.value = x.code; if (onPick) onPick(x); },
    });
  }

  function transferDialog(p, rows, index, done) {
    const r0 = rows[index] || rows[0];
    ui.dialog({
      title: `Áttárolás: ${p.sku}`,
      submitLabel: 'Áttárolás',
      body: html`
        <p class="muted small">${p.name}. A cél hely csak üres lehet, vagy ${p.partner_name} áruját tárolhatja.</p>
        <div class="form-grid">
          ${ui.field({ name: 'from', label: 'Honnan', type: 'select', value: rows.indexOf(r0), options: rows.map((r, i) => ({ value: i, label: rowLabel(r) })), span: 'all' })}
          ${ui.field({ name: 'to_location_code', id: 'stk-tr-to', label: 'Hová (raktárhely)', type: 'code', required: true, placeholder: 'A-01-04', hint: 'Olvasd be a hely vonalkódját, vagy írd be a kódját.' })}
          ${ui.field({ name: 'qty', label: 'Mennyiség', type: 'number', int: true, min: 1, max: r0.qty, value: r0.qty, required: true })}
          ${ui.field({ name: 'note', label: 'Megjegyzés', optional: true, span: 'all' })}
        </div>`,
      onOpen: ({ form }) => {
        const from = form.querySelector('[name="from"]');
        const qty = form.querySelector('[name="qty"]');
        from.addEventListener('change', () => { const r = rows[Number(from.value)]; qty.max = r.qty; qty.value = r.qty; });
        locationAutocomplete(form.querySelector('#stk-tr-to'), () => { qty.focus(); qty.select(); });
        setTimeout(() => form.querySelector('#stk-tr-to').focus(), 0);
      },
      onSubmit: async (form) => {
        const v = ui.formValues(form);
        const r = rows[Number(v.from)];
        const res = await api.post('/api/stock/transfer', {
          product_id: p.id, from_location_id: r.location_id, lot: r.lot, expiry: r.expiry || null,
          to_location_code: v.to_location_code.trim(), qty: v.qty, note: v.note,
        });
        ui.toast(`Áttárolva: ${fmt.int(v.qty)} db, ${res.from} → ${res.to}.`, 'ok');
        done();
      },
    });
  }

  function adjustDialog(p, rows, index, done) {
    const opts = [...rows.map((r, i) => ({ value: String(i), label: rowLabel(r) })), { value: 'new', label: 'Új hely vagy új sarzs' }];
    ui.dialog({
      title: `Készletkorrekció: ${p.sku}`,
      submitLabel: 'Korrekció könyvelése',
      body: html`
        ${ui.notice('A korrekció azonnal módosítja a készletet. Az indoklással együtt bekerül a készletmozgások közé és a naplóba.', 'warn')}
        <div class="form-grid">
          ${ui.field({ name: 'row', label: 'Készletsor', type: 'select', value: String(index), options: opts, span: 'all' })}
          <div class="stk-newrow span-all" data-newrow hidden>
            ${ui.field({ name: 'location_code', id: 'stk-adj-loc', label: 'Raktárhely', type: 'code', placeholder: 'A-01-04' })}
            ${ui.field({ name: 'lot', label: 'Sarzs', type: 'code', optional: !p.track_lot })}
            ${ui.field({ name: 'expiry', label: 'Lejárat', type: 'date', optional: !p.track_expiry })}
          </div>
          ${ui.field({ name: 'mode', label: 'Művelet', type: 'select', value: 'set', options: [['set', 'Mennyiség beállítása (számolt érték)'], ['add', 'Hozzáadás'], ['remove', 'Levonás']] })}
          ${ui.field({ name: 'qty', label: 'Mennyiség', type: 'number', int: true, min: 0, required: true, hint: 'Beállításnál a hely új, teljes mennyisége.' })}
          ${ui.field({ name: 'reason', label: 'Indoklás', type: 'select', required: true, placeholder: 'Válassz okot', options: REASONS.map((x) => [x, x]) })}
          ${ui.field({ name: 'reason_text', label: 'Részletek', optional: true, placeholder: 'pl. leltárszám, sérülés leírása' })}
        </div>`,
      onOpen: ({ form }) => {
        const row = form.querySelector('[name="row"]');
        const box = form.querySelector('[data-newrow]');
        const qty = form.querySelector('[name="qty"]');
        const mode = form.querySelector('[name="mode"]');
        const sync = () => {
          const isNew = row.value === 'new';
          box.hidden = !isNew;
          box.querySelectorAll('input').forEach((i) => { i.disabled = !isNew; });
          if (!isNew && mode.value === 'set') qty.value = rows[Number(row.value)].qty;
          if (isNew && mode.value === 'set') qty.value = '';
          if (isNew && mode.value === 'remove') mode.value = 'add';
        };
        row.addEventListener('change', sync);
        mode.addEventListener('change', () => { if (mode.value !== 'set') qty.value = ''; else sync(); });
        sync();
        locationAutocomplete(form.querySelector('#stk-adj-loc'));
      },
      onSubmit: async (form) => {
        const v = ui.formValues(form);
        const reason = v.reason ? `${v.reason}${v.reason_text ? `: ${v.reason_text.trim()}` : ''}` : '';
        const body = { product_id: p.id, mode: v.mode, qty: v.qty, reason };
        if (v.row === 'new') Object.assign(body, { location_code: (v.location_code || '').trim(), lot: (v.lot || '').trim(), expiry: v.expiry || null });
        else {
          const r = rows[Number(v.row)];
          Object.assign(body, { location_id: r.location_id, lot: r.lot, expiry: r.expiry || null });
        }
        const res = await api.post('/api/stock/adjust', body);
        ui.toast(`Korrekció könyvelve: ${fmt.int(res.before)} → ${fmt.int(res.after)} db.`, 'ok');
        done();
      },
    });
  }

  /* ================================================================ Cikktörzs */

  async function productDialog(p, done) {
    const clients = await ui.partnerOptions('client');
    const isNew = !p;
    const e = p || { unit: 'db', min_stock: 0 };
    if (!isNew && !clients.some((c) => String(c.value) === String(e.partner_id))) clients.push({ value: e.partner_id, label: `${e.partner_name} (${e.partner_code})` });
    ui.dialog({
      title: isNew ? 'Új cikk' : `${e.sku} szerkesztése`,
      size: 'wide',
      submitLabel: isNew ? 'Cikk felvétele' : 'Mentés',
      body: html`<div class="form-grid">
        ${ui.field({ name: 'partner_id', label: 'Ügyfél', type: 'select', required: true, value: e.partner_id, placeholder: 'Válassz ügyfelet', options: clients, attrs: isNew ? '' : 'disabled', hint: isNew ? '' : 'A cikk ügyfele nem módosítható.' })}
        ${ui.field({ name: 'sku', label: 'Cikkszám', required: true, value: e.sku, hint: 'Ügyfelenként egyedi.' })}
        ${ui.field({ name: 'name', label: 'Megnevezés', required: true, value: e.name, span: 2 })}
        <div class="field"><label for="stk-ean">EAN (vonalkód)</label>
          <input class="input" id="stk-ean" name="ean" value="${e.ean || ''}" inputmode="numeric" autocomplete="off" aria-describedby="stk-ean-hint stk-ean-err">
          <span class="field__hint stk-warn" id="stk-ean-hint" data-ean-warn aria-live="polite"></span>
          <p class="field__error" id="stk-ean-err" hidden></p></div>
        ${ui.field({ name: 'unit', label: 'Egység', value: e.unit || 'db' })}
        ${ui.field({ name: 'min_stock', label: 'Minimum készlet', type: 'number', int: true, min: 0, value: e.min_stock ?? 0, hint: 'Ez alatt alacsony a készlet.' })}
        ${ui.field({ name: 'weight_kg', label: 'Súly (kg)', type: 'number', min: 0, value: e.weight_kg, optional: true })}
        ${ui.field({ name: 'width_cm', label: 'Szélesség (cm)', type: 'number', min: 0, value: e.width_cm, optional: true })}
        ${ui.field({ name: 'depth_cm', label: 'Mélység (cm)', type: 'number', min: 0, value: e.depth_cm, optional: true })}
        ${ui.field({ name: 'height_cm', label: 'Magasság (cm)', type: 'number', min: 0, value: e.height_cm, optional: true })}
        ${ui.field({ name: 'track_lot', label: 'Sarzskövetés', type: 'checkbox', value: e.track_lot, hint: 'Átvételkor kötelező a sarzsszám.' })}
        ${ui.field({ name: 'track_expiry', label: 'Lejáratkövetés', type: 'checkbox', value: e.track_expiry, hint: 'Átvételkor kötelező a lejárat, kiszedés FEFO szerint.' })}
        ${ui.field({ name: 'notes', label: 'Megjegyzés', type: 'textarea', rows: 2, optional: true, value: e.notes, span: 'all' })}
      </div>`,
      onOpen: ({ form }) => {
        const ean = form.querySelector('#stk-ean');
        const hint = form.querySelector('[data-ean-warn]');
        const check = () => { const w = eanWarning(ean.value); hint.textContent = w; hint.hidden = !w; };
        ean.addEventListener('input', check);
        check();
      },
      onSubmit: async (form) => {
        const v = ui.formValues(form);
        const body = {
          sku: v.sku, name: v.name, ean: v.ean.trim(), unit: v.unit, min_stock: v.min_stock ?? 0,
          weight_kg: v.weight_kg, width_cm: v.width_cm, depth_cm: v.depth_cm, height_cm: v.height_cm,
          track_lot: v.track_lot, track_expiry: v.track_expiry, notes: v.notes,
        };
        let res;
        if (isNew) res = await api.post('/api/products', { ...body, partner_id: v.partner_id ? Number(v.partner_id) : null });
        else res = await api.patch(`/api/products/${e.id}`, body);
        ui.toast(isNew ? 'Cikk felvéve.' : 'Cikk mentve.', 'ok');
        for (const w of res.warnings || []) ui.toast(w, 'info');
        done(res);
      },
    });
  }

  async function renderCatalog(root, ctx) {
    const q = ctx.query;
    const f = { q: q.get('q') || '', partner_id: q.get('partner_id') || '', active: q.get('active') || '1' };
    const offset = intOf(q.get('offset'));
    const limit = 50;
    const base = `${ROUTE}/cikktorzs`;
    const [data, clients] = await Promise.all([api.get('/api/products', { ...f, limit, offset }), clientList()]);
    const canCreate = FL.can('stock', 'create');
    const canEdit = FL.can('stock', 'edit');
    const filtered = Boolean(f.q || f.partner_id || f.active !== '1');
    root.innerHTML = String(html`
      ${head(html`
        ${canCreate ? html`<button class="btn" type="button" data-action="import">${FL.icon('upload-simple')}CSV import</button>` : ''}
        <button class="btn" type="button" data-action="export">${FL.icon('download-simple')}CSV export</button>
        ${canCreate ? html`<button class="btn btn--primary" type="button" data-action="new">${FL.icon('plus')}Új cikk</button>` : ''}`)}
      ${tabs('catalog')}
      <form class="toolbar" data-filters role="search" aria-label="Cikkek szűrése">
        ${searchField('cat-q', f.q, 'Cikkszám, megnevezés vagy EAN')}
        ${ui.field({ name: 'partner_id', label: 'Ügyfél', type: 'select', value: f.partner_id, placeholder: 'Minden ügyfél', options: partnerOptions(clients) })}
        ${ui.field({ name: 'active', label: 'Állapot', type: 'select', value: f.active, options: [['1', 'Aktív'], ['0', 'Inaktív'], ['all', 'Mind']] })}
        ${filterButtons(base, filtered)}
      </form>
      ${ui.table({
        caption: 'Cikktörzs',
        cls: 'stk-wide',
        empty: filtered ? 'Nincs a szűrésnek megfelelő cikk.' : 'Még nincs cikk. Vegyél fel egyet, vagy importáld CSV-ből.',
        rows: data.items,
        rowHref: (r) => `${ROUTE}/termek/${r.id}`,
        columns: [
          { key: 'partner_code', label: 'Ügyfél', render: (r) => html`<span class="tag">${r.partner_code}</span>` },
          { key: 'sku', label: 'Cikkszám', cardTitle: true, render: (r) => html`<a class="mono stk-code" href="${ROUTE}/termek/${r.id}">${r.sku}</a>` },
          { key: 'name', label: 'Megnevezés', cls: 'stk-name', render: (r) => r.name },
          { key: 'ean', label: 'EAN', cls: 'nowrap', render: (r) => (r.ean ? html`<span class="mono">${r.ean}</span>${r.ean_warning ? html` <span class="stk-warn" role="img" aria-label="${r.ean_warning}" title="${r.ean_warning}">${FL.icon('warning')}</span>` : ''}` : html`<span class="muted">nincs</span>`) },
          { key: 'unit', label: 'Egység', render: (r) => r.unit },
          { key: 'weight_kg', label: 'Súly', align: 'r', cls: 'num', render: (r) => (r.weight_kg != null ? fmt.kg(r.weight_kg) : '') },
          { key: 'dims', label: 'Méretek', cls: 'nowrap', render: (r) => dims(r) },
          { key: 'min_stock', label: 'Minimum', align: 'r', cls: 'num', render: (r) => fmt.int(r.min_stock) },
          { key: 'track', label: 'Követés', render: (r) => html`<span class="stk-tags">${r.track_lot ? html`<span class="tag">sarzs</span>` : ''}${r.track_expiry ? html`<span class="tag">lejárat</span>` : ''}</span>` },
          { key: 'active', label: 'Állapot', render: (r) => (r.active ? chip('Aktív', 'ok') : chip('Inaktív')) },
          { key: 'on_hand', label: 'Készlet', align: 'r', cls: 'num', render: (r) => fmt.int(r.on_hand) },
          ...(canEdit ? [{ key: 'act', label: 'Művelet', align: 'r', render: (r) => html`<button class="btn btn--sm btn--ghost btn--icon" type="button" data-action="edit" data-id="${r.id}" aria-label="${r.sku} szerkesztése" title="Szerkesztés">${FL.icon('pencil-simple')}</button>` }] : []),
        ],
      })}
      ${ui.pager({ total: data.total, limit, offset })}`);
    ui.enableRowLinks(root);
    bindFilters(root, base);
    ui.bind(root, {
      new: () => productDialog(null, (res) => FL.go(`${ROUTE}/termek/${res.id}`)),
      edit: (el) => productDialog(data.items.find((x) => x.id === Number(el.dataset.id)), () => FL.reload()),
      export: (el) => ui.run(el, () => api.download('/api/products/export', f)),
      import: async () => {
        const res = await ui.csvImport({
          title: 'Cikkek importálása CSV-ből',
          endpoint: '/api/products/import',
          help: 'Az ügyfélkód és a cikkszám azonosítja a cikket: a meglévőket frissítjük (az üres cella nem változtat semmit), az újakat felvesszük. Új cikkhez a megnevezés kötelező. Méretek külön oszlopban vagy egyben is jöhetnek (pl. 30x20x10). A követés oszlopokba igen vagy nem kerüljön.',
          templateName: 'cikktorzs-sablon.csv',
          templateColumns: PRODUCT_CSV,
        });
        if (!res) return;
        ui.toast(`${fmt.int(res.created)} új és ${fmt.int(res.updated - res.unchanged)} módosított cikk.`, 'ok');
        if (res.warnings && res.warnings.length) ui.toast(`${fmt.int(res.warnings.length)} EAN figyelmeztetés, pl. ${res.warnings[0].message}`, 'info');
        FL.reload();
      },
      page: (el) => FL.go(base + FL.qs({ ...f, offset: el.dataset.offset })),
    });
    return null;
  }

  /* ================================================================ Mozgások */

  function refCell(m) {
    if (!m.ref_type) return html`<span class="muted">nincs</span>`;
    const kind = REF_LABELS[m.ref_type] || m.ref_type;
    if (!m.ref_number && !m.ref_id) return kind;
    const label = m.ref_number || `#${m.ref_id}`;
    const href = REF_ROUTES[m.ref_type] && m.ref_id ? `${REF_ROUTES[m.ref_type]}${m.ref_id}` : '';
    return html`${href ? html`<a class="mono stk-code" href="${href}">${label}</a>` : html`<span class="mono stk-code">${label}</span>`}<span class="sub">${kind}</span>`;
  }

  function movementTable(items, { showProduct = true, empty = 'Még nincs készletmozgás.' } = {}) {
    return ui.table({
      caption: 'Készletmozgások',
      cls: 'stk-xwide',
      empty,
      rows: items,
      columns: [
        { key: 'at', label: 'Időpont', cls: 'nowrap', render: (m) => html`<span class="num">${fmt.dateTime(m.at)}</span>` },
        { key: 'type', label: 'Típus', render: (m) => chip(m.type_label, MOVE_TONES[m.type] || 'neutral') },
        ...(showProduct ? [
          { key: 'partner_code', label: 'Ügyfél', render: (m) => html`<span class="tag">${m.partner_code}</span>` },
          { key: 'sku', label: 'Cikk', cls: 'stk-name', render: (m) => html`<a class="mono stk-code" href="${ROUTE}/termek/${m.product_id}">${m.sku}</a><span class="sub">${m.name}</span>` },
        ] : []),
        { key: 'location_code', label: 'Hely', render: (m) => html`<span class="mono stk-code">${m.location_code || ''}</span>` },
        { key: 'lot', label: 'Sarzs, lejárat', render: (m) => html`${m.lot || ''}${m.expiry ? html`<span class="sub">${fmt.date(m.expiry)}</span>` : ''}` },
        { key: 'qty', label: 'Mennyiség', align: 'r', render: (m) => signed(m.qty) },
        { key: 'ref', label: 'Hivatkozás', render: refCell },
        { key: 'user_name', label: 'Felhasználó', render: (m) => m.user_name || html`<span class="muted">rendszer</span>` },
        { key: 'note', label: 'Megjegyzés', cls: 'stk-notecol', render: (m) => html`<span class="stk-note">${m.note}</span>` },
      ],
    });
  }

  async function renderMovements(root, ctx) {
    const q = ctx.query;
    const f = {
      q: q.get('q') || '', partner_id: q.get('partner_id') || '', product_id: q.get('product_id') || '', location_id: q.get('location_id') || '',
      type: q.get('type') || '', from: q.get('from') || '', to: q.get('to') || '', ref: q.get('ref') || '', ref_type: q.get('ref_type') || '', ref_id: q.get('ref_id') || '',
    };
    const offset = intOf(q.get('offset'));
    const limit = 100;
    const base = `${ROUTE}/mozgasok`;
    const [data, clients, product] = await Promise.all([
      api.get('/api/stock/movements', { ...f, limit, offset }),
      clientList(),
      f.product_id ? api.get(`/api/products/${f.product_id}`).catch(() => null) : null,
    ]);
    const loc = f.location_id ? (data.items[0] && data.items[0].location_id === Number(f.location_id) ? data.items[0].location_code : `#${f.location_id}`) : '';
    const types = Object.entries(FL.state.meta.movementTypes || {}).map(([k, v]) => ({ value: k, label: v }));
    const filtered = Object.values(f).some(Boolean);
    const without = (key) => base + FL.qs({ ...f, [key]: '' });
    root.innerHTML = String(html`
      ${head(html`<button class="btn" type="button" data-action="export">${FL.icon('download-simple')}CSV export</button>`)}
      ${tabs('movements')}
      <form class="toolbar" data-filters role="search" aria-label="Mozgások szűrése">
        ${searchField('mov-q', f.q, 'Cikkszám, név, hely vagy sarzs')}
        ${ui.field({ name: 'partner_id', label: 'Ügyfél', type: 'select', value: f.partner_id, placeholder: 'Minden ügyfél', options: partnerOptions(clients) })}
        ${ui.field({ name: 'type', label: 'Típus', type: 'select', value: f.type, placeholder: 'Minden típus', options: types })}
        ${ui.field({ name: 'from', label: 'Ettől', type: 'date', value: f.from })}
        ${ui.field({ name: 'to', label: 'Eddig', type: 'date', value: f.to })}
        ${ui.field({ name: 'ref', label: 'Hivatkozás', value: f.ref, placeholder: 'pl. BT-2026-00012' })}
        <input type="hidden" name="product_id" value="${f.product_id}">
        <input type="hidden" name="location_id" value="${f.location_id}">
        <input type="hidden" name="ref_type" value="${f.ref_type}">
        <input type="hidden" name="ref_id" value="${f.ref_id}">
        ${filterButtons(base, filtered)}
      </form>
      ${f.product_id || f.location_id ? html`<div class="stk-tags" aria-label="Aktív szűrők">
        ${f.product_id ? html`<a class="chip stk-filter-chip" data-tone="info" href="${without('product_id')}" aria-label="Termékszűrő törlése">Termék: ${product ? `${product.sku} ${product.name}` : `#${f.product_id}`} ${FL.icon('x')}</a>` : ''}
        ${f.location_id ? html`<a class="chip stk-filter-chip" data-tone="info" href="${without('location_id')}" aria-label="Helyszűrő törlése">Hely: ${loc} ${FL.icon('x')}</a>` : ''}
      </div>` : ''}
      <p class="muted small stk-sums">${fmt.int(data.total)} mozgás. Be: <span class="diff-pos num">+${fmt.int(data.sums.in)}</span>, ki: <span class="diff-neg num">-${fmt.int(data.sums.out)}</span> db.</p>
      ${movementTable(data.items, { empty: filtered ? 'Nincs a szűrésnek megfelelő mozgás.' : 'Még nincs készletmozgás.' })}
      ${ui.pager({ total: data.total, limit, offset })}`);
    bindFilters(root, base);
    ui.bind(root, {
      export: (el) => ui.run(el, () => api.download('/api/stock/movements/export', f)),
      page: (el) => FL.go(base + FL.qs({ ...f, offset: el.dataset.offset })),
    });
    return null;
  }
})();
