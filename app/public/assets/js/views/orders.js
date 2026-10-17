/* Megrendelések: open orders (new, hold, picking, packed).
     #/megrendelesek              list with status tabs, KPIs, filters, selection -> Komissióba küldés
     #/megrendelesek/<id>         order detail with timeline and actions
   Shared with the other order screens (loaded before picking.js and history.js):
     FL.orders.renderDetail(root, id, { area })   order detail page (area: 'orders' | 'history')
     FL.orders.sendToPicking(orders)              wave dialog for new orders
     FL.orders.age(iso), FL.orders.availChip(a), FL.orders.expressChip(o) */
(() => {
  'use strict';
  const { html, raw, ui, api, fmt } = FL;
  const OPEN = ['new', 'hold', 'picking', 'packed'];
  const CLOSED = ['shipped', 'delivered', 'returned', 'cancelled'];
  const LIFECYCLE = ['new', 'picking', 'packed', 'shipped', 'delivered'];
  const STEP_LABEL = { new: 'Új', picking: 'Komissió', packed: 'Csomagolva', shipped: 'Feladva', delivered: 'Kézbesítve' };
  const SOURCES = { manual: 'Kézi rögzítés', csv: 'CSV import', api: 'Partner API', shopify: 'Shopify', woocommerce: 'WooCommerce', shoprenter: 'Shoprenter', unas: 'UNAS' };
  const CSV_COLUMNS = ['Partnerkód', 'Rendelésszám', 'Vevő neve', 'Cég', 'E-mail', 'Telefon', 'Ország', 'Irányítószám', 'Város', 'Cím',
    'Átvételi pont', 'Futár', 'Utánvét', 'Cikkszám', 'Mennyiség', 'Megjegyzés'];

  /* ------------------------------------------------------------ small pieces */

  // "12 p", "5 ó", "3 nap" since the order arrived.
  const age = (iso) => {
    const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (min < 60) return `${min} p`;
    const h = Math.floor(min / 60);
    return h < 48 ? `${h} ó` : `${Math.floor(h / 24)} nap`;
  };
  const ageTone = (iso) => {
    const h = (Date.now() - new Date(iso).getTime()) / 3600000;
    return h >= 48 ? 'danger' : h >= 24 ? 'warn' : '';
  };
  const availChip = (a) => {
    if (a === 'ok') return html`<span class="chip" data-tone="ok">Van készlet</span>`;
    if (a === 'short') return html`<span class="chip" data-tone="danger">Hiány</span>`;
    return '';
  };
  const expressChip = (o) => (o.priority === 'express' ? html`<span class="chip ol-express" data-tone="warn">${FL.icon('lightning')}Expressz</span>` : '');
  // Carrier brand ("GLS") instead of the partner's full company name, which is long for tables.
  const carrierShort = (name, code) => (code && code !== 'other' && FL.state.meta.carriers[code] ? FL.state.meta.carriers[code] : name || '');
  const address = (o) => [o.zip, o.city].filter(Boolean).join(' ') + (o.address ? `, ${o.address}` : '');

  let carrierCache = null;
  const carrierOptions = async () => {
    if (!carrierCache) carrierCache = (await api.get('/api/lookup/partners', { type: 'carrier' })).items.map((p) => ({ value: p.id, label: p.name, code: p.carrier_code }));
    return carrierCache;
  };

  /* ------------------------------------------------------------ order form (new and edit) */

  let lineSeq = 0;
  function lineRow(line = {}) {
    const n = ++lineSeq;
    const locked = line.picked_qty > 0;
    return html`<div class="ol-line" data-line data-id="${line.id || ''}" data-product-id="${line.product_id || ''}">
      <div class="field ol-line__product">
        <label for="ol-p-${n}">Termék</label>
        <input class="input" id="ol-p-${n}" data-product-input value="${line.product_id ? `${line.sku} ${line.name}` : ''}" placeholder="Cikkszám, név vagy EAN" autocomplete="off" aria-describedby="ol-p-${n}-err" ${locked ? raw('readonly') : ''}>
        ${locked ? html`<span class="field__hint">Már ${fmt.int(line.picked_qty)} db kiszedve, a termék nem cserélhető.</span>` : ''}
        <p class="field__error" id="ol-p-${n}-err" hidden></p>
      </div>
      <div class="field ol-line__qty">
        <label for="ol-q-${n}">Mennyiség</label>
        <input class="input input--num" id="ol-q-${n}" type="number" min="${locked ? line.picked_qty : 1}" step="1" data-qty value="${line.qty || 1}" aria-describedby="ol-q-${n}-err">
        <p class="field__error" id="ol-q-${n}-err" hidden></p>
      </div>
      <button class="btn btn--ghost btn--icon ol-line__remove" type="button" data-remove-line aria-label="Tétel törlése" ${locked ? raw('disabled title="Kiszedett tétel nem törölhető"') : ''}>${FL.icon('trash')}</button>
    </div>`;
  }

  // Wires the line editor: product autocomplete within the client, add and remove, field names
  // "lines.N.product_id" / "lines.N.qty" so server errors land next to the right input.
  function bindLines(form, getPartner) {
    const box = form.querySelector('[data-lines]');
    const renumber = () => box.querySelectorAll('[data-line]').forEach((row, i) => {
      row.querySelector('[data-product-input]').name = `lines.${i}.product_id`;
      row.querySelector('[data-qty]').name = `lines.${i}.qty`;
    });
    const wire = (row) => {
      const input = row.querySelector('[data-product-input]');
      if (input.readOnly) return;
      input.disabled = !getPartner();
      input.placeholder = getPartner() ? 'Cikkszám, név vagy EAN' : 'Előbb válassz ügyfelet';
      ui.autocomplete(input, {
        source: (q) => ui.sources.products(getPartner())(q),
        label: ui.productLabel,
        sub: (p) => (p.ean ? `EAN ${p.ean}` : p.partner_code),
        onSelect: (p) => { row.dataset.productId = p.id; input.value = ui.productLabel(p); row.querySelector('[data-qty]').select(); },
      });
      input.addEventListener('input', () => { row.dataset.productId = ''; });
    };
    box.querySelectorAll('[data-line]').forEach(wire);
    renumber();
    form.addEventListener('click', (e) => {
      if (e.target.closest('[data-add-line]')) {
        box.insertAdjacentHTML('beforeend', String(lineRow()));
        const row = box.lastElementChild;
        wire(row);
        renumber();
        row.querySelector('[data-product-input]').focus();
      }
      const rm = e.target.closest('[data-remove-line]');
      if (rm) {
        const rows = box.querySelectorAll('[data-line]');
        if (rows.length === 1) { ui.toast('Legalább egy tétel kell.', 'error'); return; }
        rm.closest('[data-line]').remove();
        renumber();
      }
    });
    return {
      reset() {
        box.innerHTML = String(lineRow());
        box.querySelectorAll('[data-line]').forEach(wire);
        renumber();
      },
      values() {
        const rows = [...box.querySelectorAll('[data-line]')];
        const fields = {};
        const lines = rows.map((row, i) => {
          const productId = Number(row.dataset.productId) || null;
          const qty = parseInt(row.querySelector('[data-qty]').value, 10);
          if (!productId) fields[`lines.${i}.product_id`] = 'Válassz terméket a listából.';
          if (!Number.isInteger(qty) || qty < 1) fields[`lines.${i}.qty`] = 'Legalább 1 legyen.';
          return { ...(row.dataset.id ? { id: Number(row.dataset.id) } : {}), product_id: productId, qty };
        });
        if (Object.keys(fields).length) throw new FL.ApiError(400, 'bad_request', 'Ellenőrizd a tételeket.', fields);
        return lines;
      },
    };
  }

  async function orderDialog(order = null) {
    const [clients, carriers] = await Promise.all([ui.partnerOptions('client'), carrierOptions()]);
    const o = order || { country: 'HU', priority: 'normal', cod_amount: 0, lines: [] };
    const F = (f) => ui.field({ ...f, value: f.value !== undefined ? f.value : o[f.name] ?? '' });
    let partnerId = order ? order.partner.id : '';
    return ui.dialog({
      title: order ? `${order.number} módosítása` : 'Új rendelés',
      size: 'wide',
      submitLabel: order ? 'Mentés' : 'Rendelés rögzítése',
      body: html`
        <div class="form-grid">
          ${order
            ? html`<div class="field"><span class="field__label">Ügyfél</span><p class="ol-static">${order.partner.name} (${order.partner.code})</p></div>`
            : ui.field({ name: 'partner_id', label: 'Ügyfél', type: 'select', options: clients, placeholder: 'Válassz ügyfelet', required: true, value: '' })}
          ${F({ name: 'external_number', label: 'Külső rendelésszám', optional: true, hint: 'A webshop vagy a vevő rendelésszáma.' })}
          ${F({ name: 'priority', label: 'Prioritás', type: 'select', options: [['normal', 'Normál'], ['express', 'Expressz']] })}
        </div>
        <h3 class="ol-form__title">Címzett</h3>
        <div class="form-grid">
          ${F({ name: 'customer_name', label: 'Név', required: true, autocomplete: 'off' })}
          ${F({ name: 'company', label: 'Cég', optional: true })}
          ${F({ name: 'email', label: 'E-mail', type: 'email', optional: true })}
          ${F({ name: 'phone', label: 'Telefon', type: 'tel', optional: true })}
        </div>
        <h3 class="ol-form__title">Szállítás</h3>
        <div class="form-grid">
          ${F({ name: 'country', label: 'Ország', hint: 'Kétbetűs kód, pl. HU', attrs: 'maxlength="2"' })}
          ${F({ name: 'zip', label: 'Irányítószám' })}
          ${F({ name: 'city', label: 'Város' })}
          ${F({ name: 'address', label: 'Cím', span: 2 })}
          ${ui.field({ name: 'carrier_id', label: 'Fuvarozó', type: 'select', options: carriers, placeholder: 'Nincs megadva', value: o.carrier ? o.carrier.id : '' })}
          ${F({ name: 'carrier_service', label: 'Szolgáltatás', optional: true, hint: 'Pl. csomagautomata, házhoz' })}
          ${F({ name: 'pickup_point_id', label: 'Átvételi pont azonosító', optional: true, hint: 'Csomagautomata vagy átvevőhely' })}
          ${F({ name: 'cod_amount', label: 'Utánvét (Ft)', type: 'number', min: 0, hint: '0, ha nincs utánvét.' })}
        </div>
        <h3 class="ol-form__title">Tételek</h3>
        <div class="ol-lines" data-lines>${(o.lines.length ? o.lines : [{}]).map((l) => lineRow(l))}</div>
        <div><button class="btn btn--sm" type="button" data-add-line>${FL.icon('plus')}Tétel hozzáadása</button></div>
        ${F({ name: 'note', label: 'Megjegyzés', type: 'textarea', rows: 2, optional: true })}`,
      onOpen: ({ form }) => {
        const lines = bindLines(form, () => partnerId);
        form._lines = lines;
        const sel = form.querySelector('[name="partner_id"]');
        if (sel) sel.addEventListener('change', () => { partnerId = sel.value ? Number(sel.value) : ''; lines.reset(); });
      },
      onSubmit: async (form) => {
        const v = ui.formValues(form);
        for (const k of Object.keys(v)) if (k.startsWith('lines.')) delete v[k];
        if (!order && !v.partner_id) throw new FL.ApiError(400, 'bad_request', 'Válassz ügyfelet.', { partner_id: 'Válassz ügyfelet.' });
        const payload = { ...v, carrier_id: v.carrier_id ? Number(v.carrier_id) : null, cod_amount: v.cod_amount ?? 0, lines: form._lines.values() };
        if (order) {
          delete payload.partner_id;
          const res = await api.patch(`/api/orders/${order.id}`, payload);
          ui.toast(res.changed.length ? `Mentve: ${res.changed.join(', ')}.` : 'Nem változott semmi.', 'ok');
          return res;
        }
        payload.partner_id = Number(payload.partner_id);
        const res = await api.post('/api/orders', payload);
        ui.toast(`${res.number} rögzítve.`, 'ok');
        return res;
      },
    }).done;
  }

  /* ------------------------------------------------------------ send to picking (wave) */

  // orders: rows with id, number, status, availability. Opens the wave dialog; resolves with the
  // created wave or undefined.
  async function sendToPicking(orders) {
    const fresh = orders.filter((o) => o.status === 'new');
    const ok = fresh.filter((o) => o.availability === 'ok');
    const short = fresh.filter((o) => o.availability !== 'ok');
    const notNew = orders.filter((o) => o.status !== 'new');
    const users = (await api.get('/api/lookup/users')).items.map((u) => ({ value: u.id, label: u.name }));
    const items = ok.reduce((s, o) => s + (o.item_count || 0), 0);
    const dlg = ui.dialog({
      title: 'Komissióba küldés',
      submitLabel: ok.length ? `Hullám indítása (${fmt.int(ok.length)} rendelés)` : 'Hullám indítása',
      hideSubmit: !ok.length,
      body: html`
        ${ok.length
          ? ui.notice(html`<p><b>${fmt.int(ok.length)} rendelés</b>, összesen ${fmt.int(items)} db kerül a hullámba. A kiszedési helyeket a rendszer lejárat szerint (FEFO) jelöli ki.</p>`, 'info')
          : ui.notice('A kijelölt rendelések közül egyik sem indítható: komissióba csak új, teljes készlettel rendelkező rendelés küldhető.', 'warn')}
        ${short.length ? ui.notice(html`<p>Nincs elég szabad készlet, ezért kimarad: ${short.map((o) => o.number).join(', ')}.</p>`, 'warn') : ''}
        ${notNew.length ? ui.notice(html`<p>Nem új állapotú, ezért kimarad: ${notNew.map((o) => o.number).join(', ')}.</p>`, 'warn') : ''}
        <div data-wave-error></div>
        ${ok.length ? html`<div class="form-grid">
          ${ui.field({ name: 'picker_id', label: 'Komissiós', type: 'select', options: users, placeholder: 'Aki elindítja', optional: true, value: '' })}
          ${ui.field({ name: 'note', label: 'Megjegyzés', optional: true })}
        </div>` : ''}`,
      onSubmit: async (form) => {
        const v = ui.formValues(form);
        try {
          const res = await api.post('/api/picking/waves', { order_ids: ok.map((o) => o.id), picker_id: v.picker_id ? Number(v.picker_id) : null, note: v.note || '' });
          ui.toast(`${res.number} hullám elindítva: ${fmt.int(res.orders)} rendelés.${res.skipped.length ? ` Kimaradt: ${res.skipped.join(', ')}.` : ''}`, 'ok');
          return res;
        } catch (err) {
          if (err.status !== 409) throw err;
          const box = form.querySelector('[data-wave-error]');
          box.innerHTML = String(ui.notice(html`<p>${err.message}</p>${err.fields ? html`<ul class="ol-missing">${Object.entries(err.fields).map(([k, v2]) => html`<li><b class="mono">${k}</b> ${v2}</li>`)}</ul>` : ''}`, 'danger'));
          return false;
        }
      },
    });
    const res = await dlg.done;
    if (res && res.id) {
      if (FL.can('picking', 'view')) FL.go(`${FL.routes.picking}/${res.id}`);
      else FL.reload();
    }
    return res;
  }

  /* ------------------------------------------------------------ list */

  const STATUS_TABS = [['', 'Összes nyitott'], ['new', 'Új'], ['hold', 'Felfüggesztve'], ['picking', 'Komissió alatt'], ['packed', 'Feladásra kész']];

  async function renderList(root, ctx) {
    const q = ctx.query;
    const state = {
      status: OPEN.includes(q.get('status')) ? q.get('status') : '',
      partner_id: q.get('partner_id') || '', carrier_id: q.get('carrier_id') || '', priority: q.get('priority') || '',
      availability: q.get('availability') || '', q: q.get('q') || '', offset: Number(q.get('offset')) || 0,
    };
    const [clients, carriers] = await Promise.all([ui.partnerOptions('client'), carrierOptions()]);
    const canCreate = FL.can('orders', 'create');
    const canWave = FL.can('picking', 'create');
    let rows = [];
    const sel = ui.selection(() => rows, () => paintSelection());

    root.innerHTML = String(html`
      ${ui.pageHead({
        title: 'Megrendelések',
        lead: 'Nyitott rendelések: új, felfüggesztett, komissió alatti és feladásra kész. A legrégebbi és az expressz rendelések állnak elöl.',
        actions: canCreate ? html`
          <button class="btn" type="button" data-action="import">${FL.icon('upload-simple')}CSV import</button>
          <button class="btn btn--primary" type="button" data-action="new">${FL.icon('plus')}Új rendelés</button>` : '',
      })}
      <div data-kpis></div>
      <div data-tabs></div>
      <form class="toolbar" data-filters role="search">
        <div class="field field--grow"><label for="ol-q">Keresés</label>
          <input class="input" id="ol-q" name="q" type="search" value="${state.q}" placeholder="Rendelésszám, külső szám, vevő, cég, város"></div>
        ${ui.field({ name: 'partner_id', label: 'Ügyfél', type: 'select', options: clients, placeholder: 'Mind', value: state.partner_id })}
        ${ui.field({ name: 'carrier_id', label: 'Fuvarozó', type: 'select', options: carriers, placeholder: 'Mind', value: state.carrier_id })}
        ${ui.field({ name: 'priority', label: 'Prioritás', type: 'select', options: [['express', 'Expressz'], ['normal', 'Normál']], placeholder: 'Mind', value: state.priority })}
        ${ui.field({ name: 'availability', label: 'Készlet', type: 'select', options: [['ok', 'Teljesíthető'], ['short', 'Hiányos']], placeholder: 'Mind', value: state.availability })}
        <button class="btn btn--ghost" type="button" data-action="clear">${FL.icon('x')}Szűrők törlése</button>
      </form>
      <div class="ol-selbar" data-selbar hidden></div>
      <div data-table>${ui.loading()}</div>`);

    const filtersForm = root.querySelector('[data-filters]');
    const hash = () => `${FL.routes.orders}${FL.qs({ ...state, offset: state.offset || '' })}`;

    async function load() {
      history.replaceState(null, '', hash());
      const data = await api.get('/api/orders', { ...state, limit: 50 });
      rows = data.items;
      sel.set.clear();
      const k = data.kpis;
      const link = (extra) => `${FL.routes.orders}${FL.qs({ partner_id: state.partner_id, carrier_id: state.carrier_id, ...extra })}`;
      root.querySelector('[data-kpis]').innerHTML = String(ui.kpis([
        { label: 'Új', value: fmt.int(k.new), href: link({ status: 'new' }) },
        { label: 'Teljesíthető', value: fmt.int(k.fulfillable), hint: 'új, teljes készlettel', tone: 'ok', href: link({ status: 'new', availability: 'ok' }) },
        { label: 'Expressz', value: fmt.int(k.express), hint: 'még nincs becsomagolva', tone: k.express ? 'warn' : '', href: link({ priority: 'express' }) },
        { label: 'Felfüggesztve', value: fmt.int(k.hold), href: link({ status: 'hold' }) },
        { label: 'Komissió alatt', value: fmt.int(k.picking), href: link({ status: 'picking' }) },
        { label: 'Feladásra kész', value: fmt.int(k.packed), href: link({ status: 'packed' }) },
      ]));
      const total = k.new + k.hold + k.picking + k.packed;
      root.querySelector('[data-tabs]').innerHTML = String(ui.tabs(STATUS_TABS.map(([key, label]) => ({
        key, label, count: key ? k[key] : total,
        href: `${FL.routes.orders}${FL.qs({ ...state, status: key, offset: '' })}`,
      })), state.status, 'Állapot szerint'));
      root.querySelector('[data-table]').innerHTML = String(html`${ui.table({
        caption: 'Nyitott rendelések',
        selectable: canWave,
        selected: sel.set,
        rows,
        empty: state.q || state.partner_id || state.carrier_id || state.priority || state.availability ? 'Nincs a szűrésnek megfelelő rendelés.' : 'Nincs nyitott rendelés.',
        rowHref: (r) => `${FL.routes.orders}/${r.id}`,
        columns: [
          { key: 'number', label: 'Rendelés', cls: 'nowrap', render: (r) => html`<a class="mono ol-num" href="${FL.routes.orders}/${r.id}">${r.number}</a>${r.external_number ? html`<span class="sub">${r.external_number}</span>` : ''}` },
          { key: 'partner_code', label: 'Ügyfél', render: (r) => html`<span class="tag" title="${r.partner_name}">${r.partner_code}</span>` },
          { key: 'customer_name', label: 'Vevő', render: (r) => html`${r.customer_name}<span class="sub">${[r.zip, r.city].filter(Boolean).join(' ')}</span>` },
          { key: 'carrier_name', label: 'Fuvarozó', render: (r) => (r.carrier_name ? html`<span title="${r.carrier_name}">${carrierShort(r.carrier_name, r.carrier_code)}</span>` : html`<span class="muted">nincs</span>`) },
          { key: 'item_count', label: 'Tétel', align: 'r', cls: 'num', render: (r) => html`${fmt.int(r.item_count)} db<span class="sub">${fmt.int(r.line_count)} sor</span>` },
          { key: 'cod_amount', label: 'Utánvét', align: 'r', cls: 'num', render: (r) => (r.cod_amount ? fmt.money(r.cod_amount) : html`<span class="muted">nincs</span>`) },
          { key: 'created_at', label: 'Kor', align: 'r', render: (r) => html`<span class="num ol-age" data-tone="${['new', 'hold'].includes(r.status) ? ageTone(r.created_at) : ''}" title="${fmt.dateTime(r.created_at)}">${age(r.created_at)}</span>` },
          { key: 'availability', label: 'Készlet', render: (r) => (r.availability ? availChip(r.availability) : r.status === 'picking' ? html`<span class="small muted">${fmt.int(r.picked_count)}/${fmt.int(r.item_count)} kiszedve</span>` : '') },
          { key: 'status', label: 'Állapot', render: (r) => html`<span class="ol-chips">${FL.status('order', r.status)}${expressChip(r)}</span>${r.wave_number ? html`<span class="sub mono">${r.wave_number}</span>` : ''}` },
        ],
      })}${ui.pager({ total: data.total, limit: 50, offset: state.offset })}`);
      paintSelection();
    }

    function paintSelection() {
      const bar = root.querySelector('[data-selbar]');
      root.querySelectorAll('[data-action="select-row"]').forEach((cb) => {
        const on = sel.set.has(Number(cb.dataset.id));
        cb.checked = on;
        cb.closest('tr').toggleAttribute('data-selected', on);
        if (on) cb.closest('tr').dataset.selected = 'true';
      });
      const all = root.querySelector('[data-action="select-all"]');
      if (all) all.checked = rows.length > 0 && rows.every((r) => sel.set.has(r.id));
      const picked = rows.filter((r) => sel.set.has(r.id));
      bar.hidden = !picked.length;
      if (!picked.length) return;
      const ready = picked.filter((r) => r.status === 'new' && r.availability === 'ok').length;
      bar.innerHTML = String(html`<span><b>${fmt.int(picked.length)}</b> kijelölve, ebből <b>${fmt.int(ready)}</b> indítható</span>
        <span class="actions">
          <button class="btn btn--dark btn--sm" type="button" data-action="wave">${FL.icon('scan')}Komissióba küldés</button>
          <button class="btn btn--ghost btn--sm" type="button" data-action="unselect">Kijelölés törlése</button>
        </span>`);
    }

    const apply = () => { state.offset = 0; load().catch((e) => ui.toast(e.message, 'error')); };
    filtersForm.addEventListener('submit', (e) => { e.preventDefault(); state.q = filtersForm.q.value.trim(); apply(); });
    filtersForm.q.addEventListener('input', FL.debounce(() => { state.q = filtersForm.q.value.trim(); apply(); }, 350));
    for (const name of ['partner_id', 'carrier_id', 'priority', 'availability']) {
      filtersForm[name].addEventListener('change', () => { state[name] = filtersForm[name].value; apply(); });
    }
    ui.enableRowLinks(root);
    ui.bind(root, {
      ...sel.handlers,
      new: async () => { const r = await orderDialog(); if (r && r.id) FL.go(`${FL.routes.orders}/${r.id}`); },
      import: async () => {
        const r = await ui.csvImport({
          title: 'Rendelések importálása CSV-ből',
          endpoint: '/api/orders/import',
          unit: 'rendelés',
          help: 'Minden sor egy rendeléstétel. Az azonos partnerkódú és rendelésszámú sorokból egy rendelés lesz, a címadatokat az első sorból vesszük. A futár: gls, dpd, foxpost, mpl vagy dhl. A már importált rendelésszámok kimaradnak.',
          templateName: 'rendelesek-sablon.csv',
          templateColumns: CSV_COLUMNS,
        });
        if (r) load();
      },
      clear: () => {
        Object.assign(state, { partner_id: '', carrier_id: '', priority: '', availability: '', q: '', offset: 0 });
        for (const name of ['q', 'partner_id', 'carrier_id', 'priority', 'availability']) filtersForm[name].value = '';
        load();
      },
      page: (el) => { state.offset = Number(el.dataset.offset); load().then(() => root.querySelector('[data-table]').scrollIntoView({ block: 'start' })); },
      wave: () => sendToPicking(rows.filter((r) => sel.set.has(r.id))),
      unselect: () => { sel.set.clear(); paintSelection(); },
    });
    await load();
  }

  /* ------------------------------------------------------------ detail (shared with Rendeléstörténet) */

  const EVENT_ICON = { created: 'plus', status: 'arrow-right', note: 'pencil-simple', label: 'tag', sync: 'arrows-left-right', return: 'arrow-u-up-left' };

  function lifecycle(o) {
    if (['hold', 'cancelled', 'returned'].includes(o.status)) {
      const why = { hold: 'A rendelés fel van függesztve, amíg fel nem oldod.', cancelled: 'A rendelés sztornózva.', returned: 'A rendelés visszáruként érkezett vissza.' }[o.status];
      return ui.notice(html`<p><b>${FL.statusLabel('order', o.status)}.</b> ${why}</p>`, o.status === 'cancelled' ? 'danger' : 'warn');
    }
    const at = LIFECYCLE.indexOf(o.status);
    return html`<ol class="ol-steps" aria-label="Rendelés állapota">${LIFECYCLE.map((s, i) => html`
      <li data-state="${i < at ? 'done' : i === at ? 'current' : ''}" ${i === at ? raw('aria-current="step"') : ''}>${STEP_LABEL[s]}</li>`)}</ol>`;
  }

  async function renderDetail(root, id, { area = 'orders' } = {}) {
    const o = await api.get(`/api/orders/${id}`);
    FL.setTitle(o.number);
    const closed = CLOSED.includes(o.status);
    const back = area === 'history' ? { href: FL.routes.history, label: 'Rendeléstörténet' } : { href: FL.routes.orders, label: 'Megrendelések' };
    const canEdit = FL.can('orders', 'edit') && ['new', 'hold'].includes(o.status);
    const canCancel = FL.can('orders', 'delete') && ['new', 'hold'].includes(o.status);
    const canWave = FL.can('picking', 'create') && o.status === 'new';
    const canReturn = FL.can('history', 'create') && ['shipped', 'delivered', 'returned'].includes(o.status) && o.lines.some((l) => l.returned_qty < l.qty);
    const canDeliver = FL.can('history', 'edit') && o.status === 'shipped';
    const noteEndpoint = closed ? (FL.can('history', 'edit') ? `/api/history/${o.id}/notes` : null) : (FL.can('orders', 'edit') ? `/api/orders/${o.id}/notes` : null);
    const allPicked = o.lines.every((l) => l.picked_qty >= l.qty);

    // One primary action, depending on where the order is in its life.
    let primary = '';
    if (o.status === 'new' && canWave && o.availability === 'ok') primary = 'wave';
    else if (o.status === 'hold' && canEdit) primary = 'release';
    else if (o.status === 'picking' && allPicked && FL.can('picking', 'edit')) primary = 'pack';
    else if (o.status === 'packed' && o.label) primary = 'label';
    else if (canReturn) primary = 'return';
    const btn = (key, icon, text, extra = '') => html`<button class="btn ${primary === key ? 'btn--primary' : ''} ${extra}" type="button" data-action="${key}">${FL.icon(icon)}${text}</button>`;
    const packHref = `${FL.routes.picking}/csomagolas/${o.id}`;
    const actions = html`
      ${canEdit ? btn('edit', 'pencil-simple', 'Módosítás') : ''}
      ${o.status === 'new' && canEdit ? btn('hold', 'clock', 'Felfüggesztés') : ''}
      ${o.status === 'hold' && canEdit ? btn('release', 'check', 'Feloldás') : ''}
      ${canCancel ? btn('cancel', 'x', 'Sztornó', 'btn--danger') : ''}
      ${canWave ? btn('wave', 'scan', 'Komissióba küldés') : ''}
      ${o.status === 'picking' && FL.can('picking', 'view') ? html`<a class="btn ${primary === 'pack' ? 'btn--primary' : ''}" href="${packHref}">${FL.icon('package')}Csomagolás</a>` : ''}
      ${o.label ? html`<a class="btn ${primary === 'label' ? 'btn--primary' : ''}" href="${api.documentUrl(o.label.id, true)}" target="_blank" rel="noopener">${FL.icon('printer')}Címke</a>` : ''}
      ${canDeliver ? btn('delivered', 'check-circle', 'Kézbesítve') : ''}
      ${canReturn ? btn('return', 'arrow-u-up-left', 'Visszáru rögzítése') : ''}`;

    const dl = (pairs) => html`<dl class="dl">${pairs.filter(([, v]) => v !== '' && v != null && v !== false).map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
    const tracking = o.tracking_number
      ? (o.tracking_url ? html`<a class="mono" href="${o.tracking_url}" target="_blank" rel="noopener">${o.tracking_number}</a>` : html`<span class="mono">${o.tracking_number}</span>`)
      : '';

    root.innerHTML = String(html`
      ${ui.pageHead({
        crumb: back,
        title: o.number,
        lead: html`${o.partner.name} · ${SOURCES[o.source] || o.source}${o.external_number ? html` · <span class="mono">${o.external_number}</span>` : ''}`,
        actions,
      })}
      <div class="ol-chips ol-headchips">${FL.status('order', o.status)}${expressChip(o)}${availChip(o.availability)}
        ${o.cod_amount ? html`<span class="chip" data-tone="info">${FL.icon('coins')}Utánvét ${fmt.money(o.cod_amount)}</span>` : ''}</div>
      ${lifecycle(o)}
      ${area === 'orders' && closed ? ui.notice(html`<p>Ez a rendelés már lezárult. <a href="${FL.routes.history}/${o.id}">Megnyitás a Rendeléstörténetben</a></p>`, 'info') : ''}
      ${area === 'history' && !closed && FL.can('orders', 'view') ? ui.notice(html`<p>Ez a rendelés még nyitott. <a href="${FL.routes.orders}/${o.id}">Megnyitás a Megrendelések között</a></p>`, 'info') : ''}
      <div class="grid-2">
        <section class="panel" aria-labelledby="ol-ship">
          <h2 id="ol-ship">Címzett és szállítás</h2>
          ${dl([
            ['Címzett', html`<b>${o.customer_name}</b>${o.company ? html`<br>${o.company}` : ''}`],
            ['Cím', html`${address(o)}${o.country && o.country !== 'HU' ? ` (${o.country})` : ''}`],
            ['Átvételi pont', o.pickup_point_id ? html`<span class="mono">${o.pickup_point_id}</span>` : ''],
            ['E-mail', o.email ? html`<a href="mailto:${o.email}">${o.email}</a>` : ''],
            ['Telefon', o.phone ? html`<a href="tel:${o.phone}">${o.phone}</a>` : ''],
            ['Fuvarozó', o.carrier ? html`${o.carrier.name}${o.carrier_service ? ` · ${o.carrier_service}` : ''}` : html`<span class="muted">nincs megadva</span>`],
            ['Nyomkövetés', tracking],
            ['Csomag', o.packed_at ? `${fmt.int(o.package_count)} db${o.weight_kg ? `, ${fmt.kg(o.weight_kg)}` : ''}` : ''],
          ])}
        </section>
        <section class="panel" aria-labelledby="ol-meta">
          <h2 id="ol-meta">Rendelés</h2>
          ${dl([
            ['Ügyfél', `${o.partner.name} (${o.partner.code})`],
            ['Rendelve', o.ordered_at ? fmt.dateTime(o.ordered_at) : ''],
            ['Beérkezett', fmt.dateTime(o.created_at)],
            ['Utánvét', o.cod_amount ? fmt.money(o.cod_amount) : 'nincs'],
            ['Hullám', o.wave ? (FL.can('picking', 'view') ? html`<a class="mono" href="${FL.routes.picking}/${o.wave.id}">${o.wave.number}</a>` : html`<span class="mono">${o.wave.number}</span>`) : ''],
            ['Becsomagolva', o.packed_at ? fmt.dateTime(o.packed_at) : ''],
            ['Futárátvétel', o.pickup ? html`<span class="mono">${o.pickup.number}</span>` : ''],
            ['Feladva', o.shipped_at ? fmt.dateTime(o.shipped_at) : ''],
            ['Kézbesítve', o.delivered_at ? fmt.dateTime(o.delivered_at) : ''],
            ['Sztornózva', o.cancelled_at ? fmt.dateTime(o.cancelled_at) : ''],
            ['Megjegyzés', o.note ? html`<span class="ol-note">${o.note}</span>` : ''],
          ])}
        </section>
      </div>
      <section class="panel panel--flush" aria-labelledby="ol-lines">
        <div class="panel__head"><h2 id="ol-lines">Tételek</h2><span class="muted small">${fmt.int(o.line_count)} sor, ${fmt.int(o.item_count)} db</span></div>
        ${ui.table({
          caption: 'Rendelés tételei',
          rows: o.lines,
          columns: [
            { key: 'sku', label: 'Cikkszám', cls: 'mono nowrap' },
            { key: 'name', label: 'Megnevezés', render: (l) => html`${l.name}${l.ean ? html`<span class="sub mono">EAN ${l.ean}</span>` : ''}` },
            { key: 'qty', label: 'Rendelt', align: 'r', cls: 'num', render: (l) => fmt.qty(l.qty, l.unit) },
            { key: 'picked_qty', label: 'Kiszedve', align: 'r', cls: 'num', render: (l) => html`<span class="${l.picked_qty >= l.qty ? 'diff-pos' : ''}">${fmt.qty(l.picked_qty, l.unit)}</span>` },
            ...(o.availability ? [{ key: 'free', label: 'Szabad készlet', align: 'r', render: (l) => html`<span class="ol-free"><span class="num">${fmt.int(l.free)}</span>${l.available ? availChip('ok') : availChip('short')}</span>` }] : []),
            ...(o.returns.length ? [{ key: 'returned_qty', label: 'Visszajött', align: 'r', cls: 'num', render: (l) => (l.returned_qty ? fmt.qty(l.returned_qty, l.unit) : '') }] : []),
          ],
        })}
      </section>
      ${o.picks.length ? html`<section class="panel panel--flush" aria-labelledby="ol-picks">
        <div class="panel__head"><h2 id="ol-picks">Kiszedések</h2></div>
        ${ui.table({
          caption: 'Kiszedések',
          rows: o.picks,
          columns: [
            { key: 'wave_number', label: 'Hullám', cls: 'nowrap', render: (p) => html`<span class="mono">${p.wave_number}</span><span class="sub">${FL.statusLabel('wave', p.wave_status)}</span>` },
            { key: 'location_code', label: 'Hely', cls: 'mono nowrap' },
            { key: 'sku', label: 'Cikk', cls: 'nowrap', render: (p) => html`<span class="mono">${p.sku}</span>${p.lot || p.expiry ? html`<span class="sub">${[p.lot, p.expiry ? fmt.date(p.expiry) : ''].filter(Boolean).join(' · ')}</span>` : ''}` },
            { key: 'qty', label: 'Terv', align: 'r', cls: 'num' },
            { key: 'picked_qty', label: 'Kiszedve', align: 'r', cls: 'num' },
            { key: 'short_qty', label: 'Hiány', align: 'r', cls: 'num', render: (p) => (p.short_qty ? html`<span class="diff-neg">${p.short_qty}</span>` : '') },
            { key: 'restocked_qty', label: 'Visszatéve', align: 'r', cls: 'num', render: (p) => p.restocked_qty || '' },
            { key: 'picked_by_name', label: 'Ki, mikor', render: (p) => (p.picked_at ? html`${p.picked_by_name || ''}<span class="sub">${fmt.dateTime(p.picked_at)}</span>` : '') },
          ],
        })}
      </section>` : ''}
      ${o.returns.length ? html`<section class="panel" aria-labelledby="ol-returns">
        <h2 id="ol-returns">Visszáruk</h2>
        ${o.returns.map((r) => html`<article class="ol-return">
          <header><b class="mono">${r.number}</b> <span class="muted small">${fmt.dateTime(r.received_at)}${r.created_by_name ? `, ${r.created_by_name}` : ''}</span></header>
          ${r.reason || r.note ? html`<p>${r.reason}${r.reason && r.note ? ': ' : ''}${r.note}</p>` : ''}
          <ul class="ol-return__lines">${r.lines.map((l) => html`<li><span class="mono">${l.sku}</span> ${l.name} <b class="num">${fmt.int(l.qty)} db</b>
            ${l.lot || l.expiry ? html`<span class="muted small">${l.lot ? html`tétel <span class="mono">${l.lot}</span>` : ''}${l.lot && l.expiry ? ', ' : ''}${l.expiry ? `lejárat ${fmt.date(l.expiry)}` : ''}</span>` : ''}
            <span class="chip" data-tone="${l.condition === 'damaged' ? 'danger' : 'ok'}">${l.condition === 'damaged' ? 'Sérült' : 'Értékesíthető'}</span>
            <span class="muted small">${FL.icon('arrow-right')}<span class="mono">${l.location_code || ''}</span></span></li>`)}</ul>
          ${r.photos.length ? html`<p class="ol-return__photos">${r.photos.map((p) => html`<a class="btn btn--sm" href="${api.documentUrl(p.id, true)}" target="_blank" rel="noopener">${FL.icon('eye')}${p.filename}</a>`)}</p>` : ''}
        </article>`)}
      </section>` : ''}
      <section class="panel" aria-labelledby="ol-events">
        <div class="panel__head"><h2 id="ol-events">Előzmények</h2></div>
        ${noteEndpoint ? html`<form class="ol-noteform" data-noteform>
          ${ui.field({ name: 'text', label: 'Megjegyzés hozzáadása', type: 'textarea', rows: 2, placeholder: 'Pl. a vevő telefonon módosította az átvétel idejét.' })}
          <div class="form-actions"><button class="btn btn--sm" type="submit">${FL.icon('plus')}Hozzáadás</button></div>
        </form>` : ''}
        <ol class="timeline">${o.events.map((e) => html`<li>
          <span class="timeline__icon" data-type="${e.type}">${FL.icon(EVENT_ICON[e.type] || 'info')}</span>
          <div><p class="timeline__text">${e.text}</p><p class="timeline__meta"><time datetime="${e.at}">${fmt.dateTime(e.at)}</time>${e.user_name ? ` · ${e.user_name}` : ''}</p></div>
        </li>`)}</ol>
      </section>`);

    const noteForm = root.querySelector('[data-noteform]');
    if (noteForm) {
      noteForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const b = noteForm.querySelector('[type="submit"]');
        await ui.run(b, async () => {
          try {
            await api.post(noteEndpoint, { text: noteForm.text.value });
          } catch (err) { ui.showErrors(noteForm, err); return; }
          ui.toast('Megjegyzés hozzáadva.', 'ok');
          FL.reload();
        });
      });
    }

    const reasonDialog = ({ title, text, label, submitLabel, tone, required = true, onSubmit }) => ui.dialog({
      title, size: 'narrow', submitLabel, submitTone: tone,
      body: html`${text ? html`<div>${text}</div>` : ''}${ui.field({ name: 'reason', label, required, optional: !required })}`,
      onSubmit: async (form) => {
        const reason = form.reason.value.trim();
        if (required && !reason) throw new FL.ApiError(400, 'bad_request', 'Add meg az okát.', { reason: 'Kötelező mező.' });
        await onSubmit(reason);
      },
    }).done;

    ui.bind(root, {
      edit: async () => { if (await orderDialog(o)) FL.reload(); },
      hold: async () => {
        const r = await reasonDialog({ title: `${o.number} felfüggesztése`, text: html`<p>A felfüggesztett rendelés nem kerül komissióba, amíg fel nem oldod.</p>`, label: 'Ok', submitLabel: 'Felfüggesztés',
          onSubmit: (reason) => api.post(`/api/orders/${o.id}/hold`, { reason }) });
        if (r) { ui.toast('Felfüggesztve.', 'ok'); FL.reload(); }
      },
      release: async () => {
        const r = await reasonDialog({ title: `${o.number} feloldása`, text: html`<p>A rendelés újra új állapotba kerül, és komissióba küldhető.</p>`, label: 'Megjegyzés', required: false, submitLabel: 'Feloldás',
          onSubmit: (reason) => api.post(`/api/orders/${o.id}/release`, { reason }) });
        if (r) { ui.toast('Felfüggesztés feloldva.', 'ok'); FL.reload(); }
      },
      cancel: async () => {
        const held = o.picks.filter((p) => p.picked_qty - p.restocked_qty > 0);
        const r = await reasonDialog({
          title: `${o.number} sztornózása`, tone: 'danger', submitLabel: 'Sztornózás', label: 'Ok',
          text: html`<p>A sztornózott rendelés nem állítható vissza.</p>${held.length ? ui.notice(html`<p>A rendeléshez már kiszedett áru tartozik: ${held.map((p) => `${p.sku} ${p.picked_qty - p.restocked_qty} db (${p.location_code})`).join(', ')}. Visszakönyveljük a kiszedés helyére: tedd vissza a polcra.</p>`, 'warn') : ''}`,
          onSubmit: (reason) => api.post(`/api/orders/${o.id}/cancel`, { reason }),
        });
        if (r) { ui.toast('Rendelés sztornózva.', 'ok'); FL.reload(); }
      },
      wave: () => sendToPicking([{ ...o, availability: o.availability }]),
      delivered: async () => {
        if (!(await ui.confirm({ title: 'Kézbesítve', text: `Megjelölöd a(z) ${o.number} rendelést kézbesítettként?`, confirmLabel: 'Kézbesítve' }))) return;
        await ui.run(null, async () => { await api.post(`/api/history/${o.id}/delivered`, {}); ui.toast('Kézbesítettnek jelölve.', 'ok'); FL.reload(); });
      },
      return: async () => {
        if (!FL.returnDialog) return;
        const r = await FL.returnDialog(o);
        if (r) FL.reload();
      },
    });
  }

  FL.orders = { renderDetail, sendToPicking, orderDialog, age, availChip, expressChip, carrierOptions, carrierShort };

  FL.view('orders', {
    async render(root, ctx) {
      root.classList.add('ol-root');
      if (ctx.params[0]) {
        const id = Number(ctx.params[0]);
        if (!Number.isInteger(id) || id <= 0) { root.innerHTML = String(ui.empty('Ez a rendelés nem létezik.', 'warning-circle')); return; }
        await renderDetail(root, id, { area: 'orders' });
        return;
      }
      await renderList(root, ctx);
    },
  });
})();
