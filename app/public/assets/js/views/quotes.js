/* Ajánlatkészítő: fulfillment quotes.
     #/ajanlatkeszito                 saved quotes (search, status filter)
     #/ajanlatkeszito/uj?partner=ID   new quote, optionally prefilled from a client partner
     #/ajanlatkeszito/<id>            saved quote
   Layout: form groups on the left, the live A4 "paper" on the right. Only the paper is printed;
   the internal margin calculation never goes on it. calc() is pure and mirrors quoteTotals() in
   worker/routes/quotes.js (test/quotes.test.mjs runs both on the same input).
   Permissions (quotes): view, create (new, duplicate), edit (save changes, status), delete. */
(() => {
  'use strict';
  const FL = window.FL;
  const { html, raw, ui, api, fmt } = FL;
  const BASE = '#/ajanlatkeszito';
  const BRAND = '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect width="32" height="32" fill="#E8BE3C"/><path d="M8 7h17v5.5H14v3.5h9v5.5h-9V26H8z" fill="#121518"/></svg>';

  /* ------------------------------------------------------------ calculation (pure) */
  const nf0 = new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 2 });
  const f0 = (v) => nf0.format(v);
  const f1 = (v) => nf1.format(v);
  const ft = (v) => `${nf0.format(Math.round(v))} Ft`;
  const ftu = (v) => `${nf2.format(v)} Ft`;
  // Anything that is not a positive number counts as 0 (same rule as the server).
  const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) && x > 0 ? x : 0; };
  const pct = (v) => Math.min(n(v), 100);
  const whole = (v, max) => Math.round(Math.min(n(v), max));

  function feeInt(k, t) {
    if (k <= 1) return t.order_base;
    if (k === 2) return t.order_base + t.item_2;
    if (k === 3) return t.order_base + t.item_2 + t.item_3;
    return t.order_base + t.item_2 + t.item_3 + t.item_extra * (k - 3);
  }
  // Per order fee with a fractional average: between the two neighbouring whole numbers.
  function orderFee(avg, t) {
    const a = Math.max(1, avg || 1);
    const lo = Math.floor(a);
    const hi = Math.ceil(a);
    const w = a - lo;
    return feeInt(lo, t) * (1 - w) + feeInt(hi, t) * w;
  }

  function calc(d) {
    const tIn = d.tariffs || {};
    const v = d.volume || {};
    const T = (k) => (k.endsWith('_pct') ? pct(tIn[k]) : n(tIn[k]));
    const t = { order_base: T('order_base'), item_2: T('item_2'), item_3: T('item_3'), item_extra: T('item_extra') };
    const o = n(v.orders);
    const avg = n(v.avg);
    const items = [];
    const perOrder = orderFee(avg, t);
    const base = o * t.order_base;
    const extraItems = o * (perOrder - t.order_base);
    items.push({ grp: 'Rendeléskezelés' });
    items.push({ name: 'Alap rendeléskezelés', note: 'komissiózás, csomagolás, címke, átadás a futárnak', qty: o, unit: 'rendelés', price: t.order_base, sum: base });
    if (extraItems > 0.5) {
      items.push({
        name: 'További termékek a rendelésben',
        note: `átl. ${f1(avg || 1)} termék / rendelés: 2. termék ${ftu(t.item_2)}, 3. termék ${ftu(t.item_3)}, 4.-től ${ftu(t.item_extra)} / db`,
        qty: o, unit: 'rendelés', price: perOrder - t.order_base, sum: extraItems,
      });
    }
    const pack = o * T('packaging');
    if (pack > 0) items.push({ name: 'Csomagolóanyag', note: 'doboz, töltőanyag, szalag', qty: o, unit: 'rendelés', price: T('packaging'), sum: pack });
    const handlingSum = base + extraItems;
    const dHp = T('discount_handling_pct');
    const dH = handlingSum * dHp / 100;
    if (dH > 0) items.push({ name: `Kedvezmény a rendeléskezelésből (${f1(dHp)}%)`, sum: -dH, disc: true });

    const storage = (d.storage || []).filter((s) => n(s.qty) > 0);
    const dSp = T('discount_storage_pct');
    let storSum = 0;
    if (storage.length) {
      items.push({ grp: 'Tárolás' });
      for (const s of storage) {
        const q = n(s.qty);
        const val = q * n(s.price);
        storSum += val;
        items.push({ name: s.name || s.code, note: s.dims || '', qty: q, unit: 'hely / hó', price: n(s.price), sum: val });
      }
      const dS0 = storSum * dSp / 100;
      if (dS0 > 0) items.push({ name: `Kedvezmény a tárolásból (${f1(dSp)}%)`, sum: -dS0, disc: true });
    }
    const dS = storSum * dSp / 100;

    const inb = n(v.inbound) * T('inbound_unit');
    const retP = pct(v.retPct);
    const retQ = o * retP / 100;
    const ret = retQ * T('return_unit');
    if (inb > 0 || ret > 0) items.push({ grp: 'Áruátvétel és visszáru' });
    if (inb > 0) items.push({ name: 'Betárolás', note: 'áruátvétel, mennyiségi ellenőrzés, polcra helyezés', qty: n(v.inbound), unit: 'db', price: T('inbound_unit'), sum: inb });
    if (ret > 0) items.push({ name: 'Visszáru kezelése', note: `becslés: a rendelések ${f1(retP)}%-a`, qty: retQ, unit: 'csomag', price: T('return_unit'), sum: ret });

    const extras = [];
    const hours = n(v.hours);
    const hourly = hours * T('hourly_work');
    if (hourly > 0) extras.push({ name: 'Óradíjas munka', note: 'szettképzés, átcímkézés és egyéb kézi munka, becsült óraszám', qty: hours, unit: 'óra', price: T('hourly_work'), sum: hourly });
    const codO = n(v.codOrders);
    const codAvg = n(v.codAvg);
    const codP = T('cod_pct');
    const codFixed = codO * T('cod_fixed');
    const codPart = codO * codAvg * codP / 100;
    if (codFixed > 0) extras.push({ name: 'Utánvétkezelés, fix díj', note: 'utánvétes rendelésenként', qty: codO, unit: 'rendelés', price: T('cod_fixed'), sum: codFixed });
    if (codPart > 0) extras.push({ name: 'Utánvétkezelés, arányos díj', note: `az utánvét ${f1(codP)}%-a, átlagosan ${ft(codAvg)} utánvéttel`, qty: codO, unit: 'rendelés', price: codAvg * codP / 100, sum: codPart });
    for (const c of d.customItems || []) {
      const name = String(c.name || '').trim();
      const q = n(c.qty);
      const val = q * n(c.price);
      if (name && val > 0) extras.push({ name, note: c.kind === 'monthly' ? 'havi fix díj' : '', qty: q, unit: c.kind === 'monthly' ? 'hó' : String(c.unit || 'db'), price: n(c.price), sum: val });
    }
    if (extras.length) items.push({ grp: 'Kiegészítő szolgáltatások' }, ...extras);

    const net = items.reduce((a, i) => a + (i.sum || 0), 0);
    const vatP = T('vat_pct');
    const vat = net * vatP / 100;
    const storNetMonthly = storSum - dS;
    const disc = d.discounts || {};
    const oneOff = [];
    const freeQ = Math.min(n(disc.freeMoveIn), n(v.moveIn));
    if (freeQ > 0) oneOff.push({ name: `Ingyenes betárolás beköltözéskor (${f0(freeQ)} db)`, value: freeQ * T('inbound_unit') });
    const months = whole(disc.freeStorageMonths, 120);
    if (months > 0 && storNetMonthly > 0) oneOff.push({ name: `Ingyenes tárolás az első ${f0(months)} hónapban`, value: storNetMonthly * months });
    const oneOffTotal = oneOff.reduce((a, x) => a + x.value, 0);
    const locations = (d.storage || []).reduce((a, s) => a + n(s.qty), 0);
    return { items, net, vat, vatP, gross: net + vat, perOrder: o > 0 ? net / o : 0, yearly: net * 12, oneOff, oneOffTotal, o, avg, storNetMonthly, locations };
  }

  /* Internal costing, never printed. d.internal holds the assumptions (worker/lib/costing.js):
     - staff: the volume of the quote in minutes by the norms (per order, per further item, per
       received piece, per return) plus the hourly work, divided by a worker's productive hours;
       its cost is that share of a worker's monthly cost
     - rent: rent / rented m² is the rent of one m²; a storage location takes its size's m² (aisles
       included), so the client's locations take area = qty x m², and pay that area's rent
     - packaging purchase per order
     What the quote brings in a month (r.net) less these is the margin. */
  function costing(d, r) {
    const i = d.internal || {};
    const v = d.volume || {};
    const o = r.o;
    const extraItems = o * Math.max(r.avg - 1, 0);
    const returns = o * pct(v.retPct) / 100;
    const work = [
      { key: 'orders', name: 'Rendelés kiszedése, csomagolása', qty: o, unit: 'rendelés', min: n(i.min_order) },
      { key: 'items', name: 'További termékek a rendelésekben', qty: extraItems, unit: 'termék', min: n(i.min_item) },
      { key: 'inbound', name: 'Betárolás', qty: n(v.inbound), unit: 'db', min: n(i.min_inbound) },
      { key: 'returns', name: 'Visszáru', qty: returns, unit: 'csomag', min: n(i.min_return) },
    ].map((w) => ({ ...w, hours: (w.qty * w.min) / 60 }));
    if (n(v.hours) > 0) work.push({ key: 'hourly', name: 'Óradíjas munka', qty: n(v.hours), unit: 'óra', min: 60, hours: n(v.hours) });
    const hours = work.reduce((a, w) => a + w.hours, 0);
    const workerHours = n(i.worker_hours);
    const staff = workerHours > 0 ? hours / workerHours : 0;
    const labour = staff * n(i.worker_cost);
    const moveInHours = (n(v.moveIn) * n(i.min_inbound)) / 60;

    const totalArea = n(i.area_m2);
    const rentPerM2 = totalArea > 0 ? n(i.rent) / totalArea : 0;
    const space = i.space || {};
    const sizes = (d.storage || []).map((s) => {
      const m2 = n(space[s.code]);
      const qty = n(s.qty);
      return {
        code: s.code, name: s.name || s.code, qty, m2, area: qty * m2, price: n(s.price),
        fits: m2 > 0 && totalArea > 0 ? Math.floor(totalArea / m2) : 0,
        rentPer: m2 * rentPerM2, rent: qty * m2 * rentPerM2,
      };
    });
    const area = sizes.reduce((a, s) => a + s.area, 0);
    const rent = sizes.reduce((a, s) => a + s.rent, 0);
    const pack = o * n(i.costPack);
    const cost = labour + rent + pack;
    const m = r.net - cost;
    return {
      work, hours, staff, labour, moveInHours, moveInCost: workerHours > 0 ? (moveInHours / workerHours) * n(i.worker_cost) : 0,
      rentPerM2, sizes, area, areaPct: totalArea > 0 ? (area / totalArea) * 100 : 0, rent, pack, cost,
      margin: m, pct: r.net > 0 ? (m / r.net) * 100 : 0, perOrder: o > 0 ? m / o : 0,
      payback: m > 0 && r.oneOffTotal > 0 ? r.oneOffTotal / m : 0,
      missing: {
        rent: !(n(i.rent) > 0 && totalArea > 0),
        staff: !(n(i.worker_cost) > 0 && workerHours > 0),
        space: sizes.filter((s) => s.qty > 0 && !s.m2).map((s) => s.code),
      },
    };
  }

  // The assumptions of a new quote: the settings (Beállítások > Raktár > Költségkalkuláció).
  const costingFrom = (c = {}) => ({
    rent: num(c.rent), area_m2: num(c.area_m2), space: { ...(c.space || {}) },
    worker_cost: num(c.worker_cost), worker_hours: num(c.worker_hours),
    min_order: num(c.min_order), min_item: num(c.min_item), min_inbound: num(c.min_inbound), min_return: num(c.min_return),
    costPack: num(c.pack_cost),
  });

  /* ------------------------------------------------------------ helpers */
  const can = (a) => FL.can('quotes', a);
  const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const sizeDims = (s) => {
    const d = [s.width_cm, s.depth_cm, s.height_cm];
    return d.every((x) => x != null) ? `${d.map((x) => nf1.format(x)).join(' × ')} cm` : '';
  };
  const GROUP_LABELS = { handling: 'Rendeléskezelés', inbound: 'Betárolás és visszáru', extra: 'Extrák', vat: 'ÁFA' };
  const DRAFT_KEY = (id) => `fl-quote-draft:${id || 'new'}`;
  const readDraft = (id) => { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY(id)) || 'null'); } catch { return null; } };
  const writeDraft = (id, value) => { try { sessionStorage.setItem(DRAFT_KEY(id), JSON.stringify(value)); } catch { /* storage blocked */ } };
  const dropDraft = (id) => { try { sessionStorage.removeItem(DRAFT_KEY(id)); } catch { /* storage blocked */ } };

  // core/app.js (which defines FL.view) loads after the views, and it keeps an existing FL.views,
  // so register directly when FL.view is not there yet.
  const register = (k, def) => (typeof FL.view === 'function' ? FL.view(k, def) : ((FL.views = FL.views || {})[k] = def));
  register('quotes', {
    calc,
    costing,
    async render(root, ctx) {
      if (!ctx.params[0]) return renderList(root, ctx);
      return renderCalculator(root, ctx);
    },
  });

  /* ------------------------------------------------------------ list */
  async function renderList(root, ctx) {
    const st = { q: (ctx.query.get('q') || '').slice(0, 100), status: ctx.query.get('status') || '', offset: 0 };
    const LIMIT = 50;
    const statuses = Object.entries(FL.state.meta.statuses.quote).map(([k, s]) => [k, s.label]);
    root.innerHTML = String(html`
      ${ui.pageHead({
        title: 'Ajánlatkészítő',
        lead: 'Fulfillment árajánlatok a cég alapértelmezett tarifáival vagy egy ügyfél egyedi díjaival. Az ajánlat kinyomtatható és PDF-be menthető.',
        actions: can('create') ? html`<a class="btn btn--primary" href="${BASE}/uj">${FL.icon('plus')}Új ajánlat</a>`
          : html`<a class="btn" href="${BASE}/uj">${FL.icon('calculator')}Kalkulátor</a>`,
      })}
      <div class="toolbar">
        <div class="field field--grow"><label for="qt-q">Keresés</label>
          <input class="input" id="qt-q" type="search" value="${st.q}" placeholder="Ajánlatszám vagy ügyfél" autocomplete="off"></div>
        <div class="field"><label for="qt-status">Állapot</label>
          <select class="select" id="qt-status">${ui.options(statuses, st.status, 'Mind')}</select></div>
      </div>
      <div class="qc-box" data-results>${ui.loading()}</div>`);
    const results = root.querySelector('[data-results]');
    const syncUrl = () => history.replaceState(null, '', `${BASE}${FL.qs({ q: st.q, status: st.status })}`);
    let seq = 0;
    async function load() {
      const my = ++seq;
      let data;
      try {
        data = await api.get('/api/quotes', { q: st.q, status: st.status, limit: LIMIT, offset: st.offset });
      } catch (err) {
        if (my === seq) results.innerHTML = String(ui.notice(err.message, 'danger'));
        return;
      }
      if (my !== seq) return;
      results.innerHTML = String(html`${ui.table({
        caption: 'Ajánlatok',
        rows: data.items,
        rowHref: (r) => `${BASE}/${r.id}`,
        empty: st.q || st.status ? 'Nincs a szűrésnek megfelelő ajánlat.' : 'Még nincs mentett ajánlat.',
        columns: [
          { key: 'number', label: 'Szám', render: (r) => html`<a class="mono" href="${BASE}/${r.id}">${r.number}</a>` },
          { key: 'client_name', label: 'Ügyfél', render: (r) => html`<b>${r.client_name || r.partner_name || 'Névtelen ügyfél'}</b>${r.partner_id ? html`<span class="sub">Partner: ${r.partner_name} (${r.partner_code})</span>` : ''}` },
          { key: 'status', label: 'Állapot', render: (r) => FL.status('quote', r.status) },
          { key: 'monthly_net', label: 'Havi nettó', align: 'r', cls: 'num', render: (r) => fmt.money(r.monthly_net) },
          { key: 'created_by_name', label: 'Készítette' },
          { key: 'updated_at', label: 'Módosítva', cls: 'nowrap', render: (r) => fmt.dateTime(r.updated_at) },
        ],
      })}${data.total > 0 ? ui.pager({ total: data.total, limit: LIMIT, offset: st.offset }) : ''}`);
    }
    ui.enableRowLinks(results);
    ui.bind(root, { page: (el) => { st.offset = Number(el.dataset.offset) || 0; load(); } });
    const q = root.querySelector('#qt-q');
    q.addEventListener('input', FL.debounce(() => { st.q = q.value.trim(); st.offset = 0; syncUrl(); load(); }, 250));
    root.querySelector('#qt-status').addEventListener('change', (e) => { st.status = e.target.value; st.offset = 0; syncUrl(); load(); });
    await load();
  }

  /* ------------------------------------------------------------ calculator */
  async function renderCalculator(root, ctx) {
    const isNew = ctx.params[0] === 'uj';
    const id = isNew ? null : Number(ctx.params[0]);
    if (!isNew && !(Number.isInteger(id) && id > 0)) {
      root.innerHTML = String(ui.empty('Ez az ajánlat nem létezik.', 'warning-circle'));
      return undefined;
    }
    const [defs, saved, clients] = await Promise.all([
      api.get('/api/quotes/defaults'),
      isNew ? Promise.resolve(null) : api.get(`/api/quotes/${id}`),
      api.get('/api/lookup/partners', { type: 'client' }).then((r) => r.items),
    ]);

    const st = {
      id: saved ? saved.id : null,
      number: saved ? saved.number : '',
      status: saved ? saved.status : 'draft',
      partner_id: saved ? saved.partner_id : null,
      updated_at: saved ? saved.updated_at : null,
      created_by_name: saved ? saved.created_by_name : '',
      data: saved ? mergeSizes(saved.data, defs) : newData(defs),
      tariffSource: saved ? '' : 'a Beállítások alapértelmezett tarifái',
      dirty: false,
      open: new Set(['client', 'volume', 'discounts']),
    };
    // A saved partner that is no longer in the active list still shows up in the select.
    if (saved && saved.partner_id && !clients.some((c) => c.id === saved.partner_id)) {
      clients.push({ id: saved.partner_id, name: saved.partner_name || 'Ismeretlen ügyfél', code: saved.partner_code || '' });
    }
    const company = () => (st.status !== 'draft' && st.data.company && st.data.company.name ? st.data.company : defs.company || {});
    const canSave = () => (st.id ? can('edit') : can('create'));

    if (isNew && ctx.query.get('partner')) {
      const pid = Number(ctx.query.get('partner'));
      if (clients.some((c) => c.id === pid)) {
        st.partner_id = pid;
        try {
          applyPartner(st, await api.get(`/api/quotes/partner/${pid}`), 'both');
        } catch (err) {
          ui.toast(err.message, 'error');
        }
      }
    }

    root.classList.add('qc-page');
    root.innerHTML = String(html`
      <div class="qc-box" data-head></div>
      <div class="qc-box" data-draft></div>
      <div class="qc">
        <div class="qc__form" data-form></div>
        <div class="qc__paperwrap" data-scroll role="region" aria-label="Az ajánlat előnézete"><div data-paper></div></div>
      </div>`);
    const headBox = root.querySelector('[data-head]');
    const formBox = root.querySelector('[data-form]');
    const paperBox = root.querySelector('[data-paper]');
    const draftBox = root.querySelector('[data-draft]');

    /* -------------------------------------------------------- rendering */
    function renderHead() {
      const client = st.data.client.name;
      headBox.innerHTML = String(ui.pageHead({
        crumb: { href: BASE, label: 'Ajánlatok' },
        title: st.number || 'Új ajánlat',
        lead: html`${FL.status('quote', st.status)} ${client || 'Ügyfél még nincs megadva'}${st.created_by_name ? html` <span class="muted small">· készítette ${st.created_by_name}</span>` : ''}
          <span class="qc-dirty" data-dirty ${st.dirty ? '' : raw('hidden')}>Nem mentett változások</span>`,
        actions: html`
          <button class="btn" type="button" data-action="print">${FL.icon('printer')}Nyomtatás / PDF</button>
          ${st.id && can('create') ? html`<button class="btn" type="button" data-action="duplicate">${FL.icon('copy')}Másolat</button>` : ''}
          ${st.id && can('delete') ? html`<button class="btn btn--danger" type="button" data-action="delete">${FL.icon('trash')}Törlés</button>` : ''}
          ${canSave() ? html`<button class="btn btn--primary" type="button" data-action="save">${FL.icon('check')}Mentés</button>` : ''}`,
      }));
    }

    // ui.field bound to a state path (data-k) that onEdit() writes back into st.
    function field(path, label, value, opts = {}) {
      return ui.field({
        ...opts,
        name: path,
        label,
        value,
        attrs: `data-k="${path}"${opts.attrs ? ` ${opts.attrs}` : ''}`,
        ...(opts.type === 'number' ? { min: opts.min ?? 0 } : {}),
      });
    }

    function group(key, title, body, extra = '') {
      return html`<details class="qc-group" data-group="${key}" ${st.open.has(key) ? raw('open') : ''}>
        <summary><span>${title}</span>${extra}</summary>
        <div class="qc-group__body">${body}</div>
      </details>`;
    }

    function renderForm() {
      const d = st.data;
      const tariffDefs = defs.tariffs.filter((t) => t.group !== 'discount');
      const byGroup = FL.groupBy(tariffDefs, (t) => t.group);
      const c = company();
      const companyLines = [
        [[c.zip, c.city].filter(Boolean).join(' '), c.address].filter(Boolean).join(', '),
        c.tax_number ? `Adószám: ${c.tax_number}` : '', c.company_reg_number ? `Cégjegyzékszám: ${c.company_reg_number}` : '',
        [c.email, c.phone].filter(Boolean).join(', '), c.website || '', c.bank_account ? `Bankszámla: ${c.bank_account}` : '',
      ].filter(Boolean);
      const items = d.customItems;
      formBox.innerHTML = String(html`
        ${group('client', 'Ügyfél és ajánlat', html`<div class="form-grid">
          <div class="field span-2">
            <label for="qc-partner">Ügyfél a partnerek közül <span class="field__opt">(nem kötelező)</span></label>
            <select class="select" id="qc-partner" name="partner_id" data-k="partner_id">${ui.options(clients.map((p) => [p.id, `${p.name} (${p.code})`]), st.partner_id || '', 'Új érdeklődő, nincs még partner')}</select>
            <div class="qc-inline-actions">
              <button class="btn btn--sm" type="button" data-action="load-client" ${st.partner_id ? '' : raw('disabled')}>${FL.icon('identification-card')}Ügyféladatok betöltése</button>
              <button class="btn btn--sm" type="button" data-action="load-tariffs" ${st.partner_id ? '' : raw('disabled')}>${FL.icon('coins')}Partner tarifáinak betöltése</button>
            </div>
          </div>
          ${field('client.name', 'Ügyfél (cég) neve', d.client.name, { span: 2, attrs: 'maxlength="200"' })}
          ${field('client.contact', 'Kapcsolattartó', d.client.contact)}
          ${field('client.email', 'E-mail', d.client.email, { type: 'email' })}
          ${field('client.phone', 'Telefon', d.client.phone, { type: 'tel' })}
          ${field('client.shop', 'Webshop', d.client.shop, { placeholder: 'peldawebshop.hu' })}
          ${field('client.address', 'Cím', d.client.address, { span: 2, optional: true })}
          ${field('offerDate', 'Kelte', d.offerDate, { type: 'date' })}
          ${field('validDays', 'Érvényes (nap)', d.validDays, { type: 'number', int: true, min: 1, step: 1 })}
          ${field('status', 'Állapot', st.status, { type: 'select', options: Object.entries(FL.state.meta.statuses.quote).map(([k, s]) => [k, s.label]) })}
        </div>`)}

        ${group('volume', 'Havi forgalom', html`<div class="form-grid">
          ${field('volume.orders', 'Rendelés / hó', d.volume.orders, { type: 'number', step: 10 })}
          ${field('volume.avg', 'Átl. termék / rendelés', d.volume.avg, { type: 'number', step: 0.1, min: 1 })}
          ${field('volume.inbound', 'Betárolás / hó (db)', d.volume.inbound, { type: 'number', step: 10 })}
          ${field('volume.retPct', 'Visszáru arány (%)', d.volume.retPct, { type: 'number', step: 0.5, max: 100 })}
          ${d.storage.map((s) => field(`storage.${s.code}.qty`, html`<span class="tag">${s.code}</span> ${s.name} (db)`, s.qty, { type: 'number', step: 1, hint: s.dims }))}
          ${field('volume.moveIn', 'Beköltözési készlet (db)', d.volume.moveIn, { type: 'number', step: 100 })}
          ${field('volume.hours', 'Óradíjas munka (óra / hó)', d.volume.hours, { type: 'number', step: 1, hint: 'Szettképzés, átcímkézés.' })}
          ${field('volume.codOrders', 'Utánvétes rendelés / hó', d.volume.codOrders, { type: 'number', step: 10 })}
          ${field('volume.codAvg', 'Átlagos utánvét (Ft)', d.volume.codAvg, { type: 'number', step: 100 })}
        </div>`)}

        ${group('discounts', 'Kedvezmények', html`<div class="form-grid">
          ${field('tariffs.discount_handling_pct', 'Kedvezmény a rendeléskezelésből (%)', d.tariffs.discount_handling_pct, { type: 'number', step: 1, max: 100 })}
          ${field('tariffs.discount_storage_pct', 'Kedvezmény a tárolásból (%)', d.tariffs.discount_storage_pct, { type: 'number', step: 1, max: 100 })}
          ${field('discounts.freeMoveIn', 'Ingyenes betárolás beköltözéskor (db, 0 = nincs)', d.discounts.freeMoveIn, { type: 'number', step: 100 })}
          ${field('discounts.freeStorageMonths', 'Ingyenes tárolás (első hónapok száma)', d.discounts.freeStorageMonths, { type: 'number', int: true, step: 1 })}
          ${field('discounts.priceLockMonths', 'Árgarancia (hónap, 0 = nincs)', d.discounts.priceLockMonths, { type: 'number', int: true, step: 1 })}
        </div>
        <p class="field__hint">A beköltözési készletnél megadott darabszámig az ingyenes betárolás egyszeri kedvezményként szerepel az ajánlatban.</p>`)}

        ${group('tariffs', 'Tarifák (nettó)', html`
          <div class="qc-inline-actions">
            <button class="btn btn--sm" type="button" data-action="default-tariffs">${FL.icon('arrow-clockwise')}Alapértelmezett tarifák</button>
            <button class="btn btn--sm" type="button" data-action="load-tariffs" ${st.partner_id ? '' : raw('disabled')}>${FL.icon('coins')}Partner tarifáinak betöltése</button>
          </div>
          ${st.tariffSource ? html`<p class="field__hint">Kiindulás: ${st.tariffSource}.</p>` : ''}
          ${Object.entries(GROUP_LABELS).filter(([g]) => byGroup[g]).map(([g, label]) => html`
            <h3 class="qc-sub">${label}</h3>
            <div class="form-grid">${byGroup[g].map((t) => field(`tariffs.${t.key}`, `${t.label} (${t.unit})`, d.tariffs[t.key], { type: 'number', step: t.unit.startsWith('%') ? 0.5 : 1 }))}</div>`)}
          <h3 class="qc-sub">Tárolás</h3>
          <div class="form-grid">${d.storage.map((s) => field(`storage.${s.code}.price`, html`<span class="tag">${s.code}</span> ${s.name} (Ft / hely / hó)`, s.price, { type: 'number', step: 10 }))}</div>`)}

        ${group('custom', 'Egyedi tételek', html`
          ${items.length ? html`<div class="qc-items">${items.map((it, i) => html`<fieldset class="qc-item">
            <legend class="visually-hidden">${i + 1}. egyedi tétel</legend>
            ${field(`custom.${i}.name`, 'Megnevezés', it.name)}
            ${field(`custom.${i}.kind`, 'Típus', it.kind, { type: 'select', options: [['per_unit', 'Mennyiség alapján'], ['monthly', 'Havi fix díj']] })}
            ${field(`custom.${i}.unit`, 'Egység', it.unit)}
            ${field(`custom.${i}.price`, 'Egységár (Ft)', it.price, { type: 'number', step: 10 })}
            ${field(`custom.${i}.qty`, 'Mennyiség / hó', it.qty, { type: 'number', step: 1 })}
            <button class="btn btn--ghost btn--icon btn--sm qc-item__remove" type="button" data-action="remove-item" data-i="${i}" aria-label="${i + 1}. tétel törlése" title="Tétel törlése">${FL.icon('trash')}</button>
          </fieldset>`)}</div>` : html`<p class="muted small">Nincs egyedi tétel. Partner tarifáinak betöltésekor az ügyfél egyedi tételei is ide kerülnek.</p>`}
          <div class="qc-inline-actions"><button class="btn btn--sm" type="button" data-action="add-item">${FL.icon('plus')}Tétel hozzáadása</button></div>`, html`<span class="count">${items.length || ''}</span>`)}

        ${group('company', 'Saját cégadatok', html`
          <div class="qc-company"><b>${c.name || 'Fully Logistics'}</b>${companyLines.map((l) => html`<span>${l}</span>`)}</div>
          <p class="field__hint">${st.status !== 'draft' && st.data.company && st.data.company.name ? 'Az ajánlat a mentéskori cégadatokat mutatja.' : 'A cégadatokat a Beállítások alatt szerkesztheted.'}
            ${FL.can('settings', 'view') ? html` <a href="#/beallitasok">Beállítások megnyitása</a>` : ''}</p>
          ${field('signer', 'Aláíró neve, beosztása', d.signer, { placeholder: 'pl. Kiss Péter, ügyvezető' })}`)}

        ${group('terms', 'Feltételek (az ajánlatban megjelenő pontok)', html`
          ${field('terms', 'Soronként egy pont', (d.terms || []).join('\n'), { type: 'textarea', rows: 8 })}
          <div class="qc-inline-actions"><button class="btn btn--sm" type="button" data-action="default-terms">${FL.icon('arrow-clockwise')}Alapértelmezett feltételek</button></div>`)}

        <section class="qc-internal no-print" aria-labelledby="qc-int-title">
          <h2 id="qc-int-title">${FL.icon('lock-simple')}Belső fedezetszámítás <span class="muted small">(nem kerül az ajánlatba)</span></h2>
          <div class="qc-internal__out" data-kpis></div>
          <details class="qc-group qc-assume" data-group="assume" ${st.open.has('assume') ? raw('open') : ''}>
            <summary><span>Feltételezések ennél az ajánlatnál</span></summary>
            <div class="qc-group__body">
              <p class="field__hint">Új ajánlatnál a Beállítások > Raktár > Költségkalkuláció értékei. Itt átírhatod őket, a módosítás csak erre az ajánlatra vonatkozik.</p>
              <p class="qc-sub">Raktár</p>
              <div class="form-grid">
                ${field('internal.rent', 'Havi raktárbérleti díj (Ft)', d.internal.rent, { type: 'number', step: 10000 })}
                ${field('internal.area_m2', 'Bérelt alapterület (m²)', d.internal.area_m2, { type: 'number', step: 10 })}
                ${d.storage.map((s) => field(`internal.space.${s.code}`, `${s.name || s.code}: helyigény (m²)`, (d.internal.space || {})[s.code] ?? 0, { type: 'number', step: 0.05, hint: 'egy hely, folyosóval együtt' }))}
              </div>
              <p class="qc-sub">Munkaerő</p>
              <div class="form-grid">
                ${field('internal.worker_cost', 'Egy raktáros havi költsége (Ft)', d.internal.worker_cost, { type: 'number', step: 10000, hint: 'bér és járulékok' })}
                ${field('internal.worker_hours', 'Hasznos munkaóra / fő / hó', d.internal.worker_hours, { type: 'number', step: 1 })}
                ${field('internal.min_order', 'Rendelés (perc)', d.internal.min_order, { type: 'number', step: 0.1, hint: 'kiszedés, csomagolás' })}
                ${field('internal.min_item', 'További termék (perc)', d.internal.min_item, { type: 'number', step: 0.1, hint: 'termékenként' })}
                ${field('internal.min_inbound', 'Betárolás (perc / db)', d.internal.min_inbound, { type: 'number', step: 0.1 })}
                ${field('internal.min_return', 'Visszáru (perc / csomag)', d.internal.min_return, { type: 'number', step: 0.5 })}
              </div>
              <p class="qc-sub">Anyag</p>
              <div class="form-grid">
                ${field('internal.costPack', 'Csomagolóanyag beszerzés / rendelés (Ft)', d.internal.costPack, { type: 'number', step: 10 })}
              </div>
              <div class="qc-inline-actions"><button class="btn btn--sm" type="button" data-action="default-costing">${FL.icon('arrow-clockwise')}Beállítások értékeinek betöltése</button></div>
            </div>
          </details>
        </section>`);
      renderKpis();
    }

    // Results of the internal costing; redrawn on every edit (the assumption fields stay).
    function renderKpis() {
      const box = formBox.querySelector('[data-kpis]');
      if (!box) return;
      const r = calc(st.data);
      const k = costing(st.data, r);
      const tone = k.margin >= 0 ? 'ok' : 'danger';
      const i = st.data.internal;
      const warn = [];
      if (k.missing.rent) warn.push('a raktár havi bérleti díja és alapterülete');
      if (k.missing.staff) warn.push('egy raktáros havi költsége');
      if (k.missing.space.length) warn.push(`a helyigény ennél a méretnél: ${k.missing.space.join(', ')}`);
      const settingsLink = FL.can('settings', 'view') ? html` <a href="#/beallitasok/raktar">Beállítások > Raktár</a>` : '';
      box.innerHTML = String(html`
        ${warn.length ? ui.notice(html`Hiányzik ${warn.join(', ')}, ezért ez a költség 0 Ft-tal számít. Add meg lent a Feltételezések alatt, vagy a Beállításokban.${settingsLink}`, 'warn') : ''}
        ${ui.kpis([
          { label: 'Raktáros', value: `${nf2.format(k.staff)} fő`, hint: `${f1(k.hours)} munkaóra / hó` },
          { label: 'Foglalt terület', value: `${nf2.format(k.area)} m²`, hint: n(i.area_m2) > 0 ? `a raktár ${nf2.format(k.areaPct)}%-a` : 'nincs megadva alapterület' },
          { label: 'Közvetlen költség / hó', value: ft(k.cost), hint: 'bér, bérleti díj, csomagolóanyag' },
          { label: 'Fedezet / hó', value: ft(k.margin), tone, hint: `bevétel ${ft(r.net)}` },
          { label: 'Fedezeti arány', value: `${f1(k.pct)}%`, tone },
          { label: 'Fedezet / rendelés', value: r.o > 0 ? ft(k.perOrder) : 'nincs rendelés', tone: r.o > 0 ? tone : '' },
          {
            label: 'Egyszeri kedvezmények megtérülése',
            value: r.oneOffTotal > 0 ? (k.margin > 0 ? `${f1(k.payback)} hónap` : 'nem térül meg') : 'nincs',
            tone: r.oneOffTotal > 0 && k.margin <= 0 ? 'danger' : '',
          },
        ])}
        <div class="qc-cost">
          <section class="qc-cost__box" aria-label="Munkaerő">
            <h3>Munkaerő</h3>
            <ul class="qc-cost__rows">${k.work.map((w) => html`<li><span>${w.name}<small>${w.key === 'hourly' ? `${f1(w.qty)} óra` : `${f1(w.qty)} ${w.unit} × ${nf2.format(w.min)} perc`}</small></span><b class="num">${f1(w.hours)} óra</b></li>`)}</ul>
            <p class="qc-cost__total"><span>${nf2.format(k.hours)} óra / ${f0(n(i.worker_hours))} óra = ${nf2.format(k.staff)} fő × ${ft(n(i.worker_cost))}</span><b class="num">${ft(k.labour)}</b></p>
          </section>
          <section class="qc-cost__box" aria-label="Tárolás és bérleti díj">
            <h3>Tárolás és bérleti díj${k.rentPerM2 > 0 ? html` <span class="muted small">${ftu(k.rentPerM2)} / m² / hó</span>` : ''}</h3>
            ${k.sizes.some((s) => s.qty > 0) ? html`<ul class="qc-cost__rows">${k.sizes.filter((s) => s.qty > 0).map((s) => html`<li><span><span><span class="tag">${s.code}</span> ${s.name}</span>
              <small>${f0(s.qty)} hely × ${s.m2 ? nf2.format(s.m2) : '?'} m² = ${nf2.format(s.area)} m² · bérlet ${ft(s.rentPer)} / hely, díj ${ft(s.price)} / hely</small>
              ${s.price < s.rentPer ? html`<small class="diff-neg">A tárolási díj kevesebb, mint a helyre eső bérleti díj.</small>` : ''}</span>
              <b class="num">${ft(s.rent)}</b></li>`)}</ul>` : html`<p class="muted small">Az ajánlatban nincs tárolóhely.</p>`}
            <p class="qc-cost__total"><span>Összesen ${nf2.format(k.area)} m²${n(i.area_m2) > 0 ? `, a raktár ${nf2.format(k.areaPct)}%-a` : ''}</span><b class="num">${ft(k.rent)}</b></p>
          </section>
          <section class="qc-cost__box" aria-label="Havi összesítés">
            <h3>Havi összesítés</h3>
            <ul class="qc-cost__rows">
              <li><span>Bevétel<small>az ajánlat havi nettó összege</small></span><b class="num">${ft(r.net)}</b></li>
              <li><span>Bérköltség<small>${nf2.format(k.staff)} fő</small></span><b class="num">−${ft(k.labour)}</b></li>
              <li><span>Raktárbérlet<small>helyfoglalás szerint, ${nf2.format(k.area)} m²</small></span><b class="num">−${ft(k.rent)}</b></li>
              <li><span>Csomagolóanyag<small>${f0(r.o)} rendelés × ${ft(n(i.costPack))}</small></span><b class="num">−${ft(k.pack)}</b></li>
            </ul>
            <p class="qc-cost__total"><span>Fedezet (profit)</span><b class="num ${k.margin < 0 ? 'diff-neg' : ''}">${ft(k.margin)}</b></p>
          </section>
          ${k.moveInHours > 0 ? html`<p class="small muted">Beköltözés egyszer: ${f0(n(st.data.volume.moveIn))} db betárolása kb. ${f1(k.moveInHours)} munkaóra (${ft(k.moveInCost)}), ez nincs benne a havi költségben.</p>` : ''}
        </div>`);
    }

    function renderPaper() {
      paperBox.innerHTML = String(paperHtml(st, calc(st.data), company()));
    }

    /* -------------------------------------------------------- state changes */
    const saveDraft = FL.debounce(() => { if (st.dirty) writeDraft(st.id, { at: new Date().toISOString(), partner_id: st.partner_id, status: st.status, data: st.data }); }, 400);
    function markDirty() {
      st.dirty = true;
      const el = headBox.querySelector('[data-dirty]');
      if (el) el.hidden = false;
      saveDraft();
    }
    function markClean() {
      st.dirty = false;
      dropDraft(st.id);
      dropDraft(null);
      const el = headBox.querySelector('[data-dirty]');
      if (el) el.hidden = true;
    }

    function setValue(path, el) {
      const d = st.data;
      const parts = path.split('.');
      const isNum = el.type === 'number';
      const val = isNum ? num(el.value) : el.value;
      if (path === 'partner_id') {
        st.partner_id = el.value ? Number(el.value) : null;
        formBox.querySelectorAll('[data-action="load-client"], [data-action="load-tariffs"]').forEach((b) => { b.disabled = !st.partner_id; });
        if (st.partner_id && !d.client.name) loadPartner('client');
      } else if (path === 'status') {
        st.status = el.value;
        renderHead();
      } else if (path === 'terms') {
        d.terms = el.value.split('\n');
      } else if (parts[0] === 'storage') {
        const s = d.storage.find((x) => x.code === parts[1]);
        if (s) s[parts[2]] = val;
      } else if (parts[0] === 'internal' && parts[1] === 'space') {
        d.internal.space = d.internal.space || {};
        d.internal.space[parts[2]] = val;
      } else if (parts[0] === 'custom') {
        const it = d.customItems[Number(parts[1])];
        if (it) it[parts[2]] = val;
      } else if (parts.length === 1) {
        d[parts[0]] = val;
      } else {
        d[parts[0]] = d[parts[0]] || {};
        d[parts[0]][parts[1]] = val;
      }
      if (path === 'client.name') renderHead();
    }

    function onEdit(e) {
      const el = e.target.closest('[data-k]');
      if (!el || !formBox.contains(el)) return;
      setValue(el.dataset.k, el);
      markDirty();
      renderPaper();
      renderKpis();
    }

    async function loadPartner(kind) {
      if (!st.partner_id) { ui.toast('Előbb válassz ügyfelet.', 'info'); return; }
      try {
        applyPartner(st, await api.get(`/api/quotes/partner/${st.partner_id}`), kind);
      } catch (err) {
        ui.toast(err.message, 'error');
        return;
      }
      markDirty();
      if (kind !== 'client') st.open.add('tariffs');
      renderHead();
      renderForm();
      renderPaper();
      ui.toast(kind === 'client' ? 'Ügyféladatok betöltve.' : 'A partner tarifái betöltve.', 'ok');
    }

    async function save() {
      if (!canSave()) return false;
      const btn = headBox.querySelector('[data-action="save"]');
      const body = { partner_id: st.partner_id, client_name: st.data.client.name, status: st.status, data: { ...st.data, company: company() } };
      const res = await ui.run(btn, () => (st.id ? api.patch(`/api/quotes/${st.id}`, body) : api.post('/api/quotes', body)));
      if (!res) return false;
      const wasNew = !st.id;
      st.id = res.id;
      st.number = res.number;
      st.updated_at = res.updated_at;
      st.created_by_name = res.created_by_name;
      markClean();
      if (wasNew) history.replaceState(null, '', `${BASE}/${res.id}`);
      renderHead();
      renderPaper();
      ui.toast(wasNew ? `Ajánlat mentve: ${res.number}.` : 'Ajánlat mentve.', 'ok');
      return true;
    }

    /* -------------------------------------------------------- events */
    formBox.addEventListener('input', onEdit);
    formBox.addEventListener('change', onEdit);
    formBox.addEventListener('toggle', (e) => {
      const g = e.target.closest && e.target.closest('details[data-group]');
      if (!g) return;
      if (g.open) st.open.add(g.dataset.group); else st.open.delete(g.dataset.group);
    }, true);

    ui.bind(root, {
      save: () => save(),
      print: async () => {
        if ((st.dirty || !st.id) && canSave() && !(await save())) return;
        window.print();
      },
      duplicate: async (b) => {
        if (st.dirty && canSave() && !(await save())) return;
        const res = await ui.run(b, () => api.post(`/api/quotes/${st.id}/duplicate`));
        if (!res) return;
        ui.toast(`Másolat elkészült: ${res.number}.`, 'ok');
        FL.go(`${BASE}/${res.id}`);
      },
      delete: async () => {
        const ok = await ui.confirm({ title: 'Ajánlat törlése', text: `Biztosan törlöd: ${st.number}? Ez nem vonható vissza.`, confirmLabel: 'Törlés', tone: 'danger' });
        if (!ok) return;
        const res = await ui.run(null, () => api.del(`/api/quotes/${st.id}`));
        if (!res) return;
        markClean();
        ui.toast('Ajánlat törölve.', 'ok');
        FL.go(BASE);
      },
      'load-client': () => loadPartner('client'),
      'load-tariffs': () => loadPartner('tariffs'),
      'default-tariffs': () => {
        const dt = defs.default_tariffs || {};
        for (const t of defs.tariffs) st.data.tariffs[t.key] = num(dt[t.key]);
        for (const s of st.data.storage) s.price = num((dt.storage || {})[s.code]);
        st.tariffSource = 'a Beállítások alapértelmezett tarifái';
        markDirty();
        renderForm();
        renderPaper();
        ui.toast('Alapértelmezett tarifák betöltve.', 'ok');
      },
      'default-costing': () => {
        st.data.internal = costingFrom(defs.costing);
        markDirty();
        renderForm();
        ui.toast('A Beállítások költségkalkulációs értékei betöltve.', 'ok');
      },
      'default-terms': () => {
        st.data.terms = [...(defs.quote_terms || [])];
        markDirty();
        renderForm();
        renderPaper();
      },
      'add-item': () => {
        st.data.customItems.push({ name: '', unit: 'db', kind: 'per_unit', price: 0, qty: 0 });
        st.open.add('custom');
        markDirty();
        renderForm();
        const inputs = formBox.querySelectorAll('.qc-item input[data-k$=".name"]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      },
      'remove-item': (b) => {
        st.data.customItems.splice(Number(b.dataset.i), 1);
        markDirty();
        renderForm();
        renderPaper();
      },
      'restore-draft': () => {
        const dr = readDraft(st.id);
        if (dr) {
          st.data = mergeSizes(dr.data, defs);
          st.partner_id = dr.partner_id ?? st.partner_id;
          st.status = dr.status || st.status;
          st.dirty = true;
          renderHead();
          renderForm();
          renderPaper();
          ui.toast('A nem mentett változatot visszaállítottam. Mentsd el.', 'ok');
        }
        draftBox.innerHTML = '';
      },
      'drop-draft': () => { dropDraft(st.id); draftBox.innerHTML = ''; },
    });

    const onBeforeUnload = (e) => { if (st.dirty) { e.preventDefault(); e.returnValue = ''; } };
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && canSave()) { e.preventDefault(); save(); }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('keydown', onKey);

    renderHead();
    renderForm();
    renderPaper();

    // A change that was not saved (navigated away) waits in this browser tab.
    const draft = readDraft(st.id);
    if (draft && draft.data && (!st.updated_at || draft.at > st.updated_at)) {
      draftBox.innerHTML = String(ui.notice(html`<p>Van egy nem mentett változatod ${st.id ? 'ehhez az ajánlathoz' : 'egy új ajánlathoz'} (${fmt.dateTime(draft.at)}).</p>
        <div class="qc-inline-actions"><button class="btn btn--sm btn--dark" type="button" data-action="restore-draft">Visszaállítás</button>
        <button class="btn btn--sm" type="button" data-action="drop-draft">Elvetés</button></div>`, 'warn'));
    }

    return {
      destroy() {
        window.removeEventListener('beforeunload', onBeforeUnload);
        document.removeEventListener('keydown', onKey);
      },
    };
  }

  /* ------------------------------------------------------------ state builders */
  function newData(defs) {
    const dt = defs.default_tariffs || {};
    const sd = dt.storage || {};
    return {
      client: { name: '', contact: '', email: '', phone: '', shop: '', address: '' },
      offerDate: FL.today(),
      validDays: 30,
      volume: { orders: 0, avg: 1, inbound: 0, retPct: 0, moveIn: 0, hours: 0, codOrders: 0, codAvg: 0 },
      storage: defs.sizes.map((s) => ({ code: s.code, name: s.name, dims: sizeDims(s), qty: 0, price: num(sd[s.code]) })),
      tariffs: Object.fromEntries(defs.tariffs.map((t) => [t.key, num(dt[t.key])])),
      discounts: { freeMoveIn: 0, freeStorageMonths: 0, priceLockMonths: 0 },
      customItems: [],
      terms: [...(defs.quote_terms || [])],
      signer: FL.state.me ? FL.state.me.user.name : '',
      internal: costingFrom(defs.costing),
    };
  }

  // Saved quotes keep their sizes; sizes added since then appear with 0 locations.
  function mergeSizes(data, defs) {
    const d = clone(data);
    const sd = (defs.default_tariffs || {}).storage || {};
    d.storage = d.storage || [];
    for (const s of defs.sizes) {
      if (!d.storage.some((x) => x.code === s.code)) d.storage.push({ code: s.code, name: s.name, dims: sizeDims(s), qty: 0, price: num(sd[s.code]) });
    }
    for (const k of ['client', 'volume', 'tariffs', 'discounts', 'internal']) d[k] = d[k] || {};
    // Quotes saved before the costing had only per order and per location costs: they get the
    // settings' assumptions, the packaging price stays.
    if (!(n(d.internal.worker_hours) > 0)) d.internal = { ...costingFrom(defs.costing), costPack: num(d.internal.costPack) || num((defs.costing || {}).pack_cost) };
    d.internal.space = d.internal.space || {};
    d.customItems = d.customItems || [];
    d.terms = d.terms || [];
    return d;
  }

  function applyPartner(st, res, kind) {
    const d = st.data;
    if (kind === 'client' || kind === 'both') {
      const c = res.contact;
      Object.assign(d.client, {
        name: c.name,
        contact: c.contact_name || '',
        email: c.contact_email || c.billing_email || '',
        phone: c.contact_phone || '',
        shop: String(c.website || '').replace(/^https?:\/\//, ''),
        address: c.address || '',
      });
    }
    if (kind === 'tariffs' || kind === 'both') {
      Object.assign(d.tariffs, res.tariffs);
      for (const s of res.storage) {
        const row = d.storage.find((x) => x.code === s.code);
        if (row) row.price = s.price;
        else d.storage.push({ code: s.code, name: s.name, dims: '', qty: 0, price: s.price });
      }
      for (const ci of res.custom_items) {
        const row = d.customItems.find((x) => String(x.name).trim().toLowerCase() === ci.name.trim().toLowerCase());
        if (row) Object.assign(row, { unit: ci.unit, kind: ci.kind, price: ci.price });
        else d.customItems.push({ name: ci.name, unit: ci.unit, kind: ci.kind, price: ci.price, qty: ci.kind === 'monthly' ? 1 : 0 });
      }
      st.tariffSource = `${res.partner.name} egyedi tarifái`;
    }
  }

  /* ------------------------------------------------------------ the paper */
  function paperHtml(st, r, c) {
    const d = st.data;
    const date = d.offerDate || FL.today();
    const validTo = FL.addDays(date, Math.round(Math.min(n(d.validDays), 365)) || 30);
    const terms = (d.terms || []).map((x) => String(x).trim()).filter(Boolean);
    const lock = whole((d.discounts || {}).priceLockMonths, 120);
    if (lock > 0) terms.unshift(`Az ajánlott díjakat a szerződéskötéstől számított ${f0(lock)} hónapig nem emeljük.`);
    const companyLines = [
      [[c.zip, c.city].filter(Boolean).join(' '), c.address].filter(Boolean).join(', '),
      c.tax_number ? `Adószám: ${c.tax_number}` : '',
      c.company_reg_number ? `Cégjegyzékszám: ${c.company_reg_number}` : '',
      [c.email, c.phone].filter(Boolean).join(' · '),
      c.website ? String(c.website).replace(/^https?:\/\//, '') : '',
    ].filter(Boolean);
    const cl = d.client || {};
    const v = d.volume || {};
    const stored = (d.storage || []).filter((s) => n(s.qty) > 0);
    const basis = [
      `${f0(r.o)} rendelés, átl. ${f1(r.avg || 1)} termék / rendelés`,
      stored.length ? `${stored.map((s) => `${f0(n(s.qty))} db ${s.name || s.code}`).join(', ')}` : 'tárolóhely nélkül',
      `${f0(n(v.inbound))} db betárolás, ${f1(pct(v.retPct))}% visszáru`,
      n(v.hours) > 0 ? `${f1(n(v.hours))} óra kézi munka` : '',
      n(v.codOrders) > 0 ? `${f0(n(v.codOrders))} utánvétes rendelés` : '',
    ].filter(Boolean);
    const t = d.tariffs || {};
    const T = (k) => (k.endsWith('_pct') ? pct(t[k]) : n(t[k]));
    const unitPrices = [
      ['Alap rendeléskezelés', `${ftu(T('order_base'))} / rendelés`],
      ['2. termék', ftu(T('item_2'))],
      ['3. termék', ftu(T('item_3'))],
      ['4. és további termék', `${ftu(T('item_extra'))} / db`],
      ['Csomagolóanyag', `${ftu(T('packaging'))} / rendelés`],
      ['Betárolás', `${ftu(T('inbound_unit'))} / db`],
      ['Visszáru kezelése', `${ftu(T('return_unit'))} / csomag`],
      ...(d.storage || []).filter((s) => n(s.price) > 0).map((s) => [s.name || s.code, `${ftu(n(s.price))} / hó`]),
      ...(T('hourly_work') > 0 ? [['Óradíjas munka', `${ftu(T('hourly_work'))} / óra`]] : []),
      ...(T('cod_fixed') > 0 ? [['Utánvétkezelés, fix', `${ftu(T('cod_fixed'))} / rendelés`]] : []),
      ...(T('cod_pct') > 0 ? [['Utánvétkezelés, arányos', `az utánvét ${f1(T('cod_pct'))}%-a`]] : []),
      ...(d.customItems || []).filter((x) => String(x.name || '').trim()).map((x) => [String(x.name).trim(), `${ftu(n(x.price))} / ${x.kind === 'monthly' ? 'hó' : x.unit || 'db'}`]),
    ];
    const pairs = [];
    for (let i = 0; i < unitPrices.length; i += 2) pairs.push([unitPrices[i], unitPrices[i + 1]]);
    const money = (x) => (x < 0 ? `−${ft(-x)}` : ft(x));

    return html`<article class="qp" aria-label="Ajánlat előnézete">
      <div class="qp__hazard" aria-hidden="true"></div>
      <header class="qp__head">
        <div class="qp__brand">${raw(BRAND)}
          <div><div class="qp__company">${c.name || 'Fully Logistics'}</div>
            <div class="qp__details">${companyLines.map((l, i) => html`${i ? raw('<br>') : ''}${l}`)}</div></div>
        </div>
        <dl class="qp__meta">
          <div><dt>Ajánlatszám</dt><dd class="qp__num">${st.number || 'mentéskor kap számot'}</dd></div>
          <div><dt>Kelte</dt><dd>${fmt.dateLong(date)}</dd></div>
          <div><dt>Érvényes</dt><dd>${fmt.dateLong(validTo).replace(/\.$/, '')}-ig</dd></div>
        </dl>
      </header>

      <h2 class="qp__title">Fulfillment árajánlat</h2>
      <p class="qp__sub">Raktározás, rendeléskezelés és csomagolás${cl.shop ? ` a(z) ${cl.shop} webshop részére` : ''}.</p>

      <div class="qp__parties">
        <div><div class="qp__lbl">Ajánlatkérő</div>
          <div class="qp__lines"><b>${cl.name || raw('<span class="qp__empty">ügyfél neve</span>')}</b>
            ${[cl.contact, [cl.email, cl.phone].filter(Boolean).join(' · '), cl.address].filter(Boolean).map((l) => html`<span>${l}</span>`)}</div></div>
        <div><div class="qp__lbl">A kalkuláció alapja (havi)</div>
          <div class="qp__lines">${basis.map((l) => html`<span>${l}</span>`)}</div></div>
      </div>

      <div class="qp__sec">Havi díjak részletezése</div>
      <div class="qp__tablewrap" data-scroll><table class="qp__items qp__main">
        <thead><tr><th scope="col">Tétel</th><th scope="col" class="r">Mennyiség</th><th scope="col" class="r">Egységár</th><th scope="col" class="r">Havi összeg</th></tr></thead>
        <tbody>${r.items.map((i) => (i.grp ? html`<tr class="qp__grp"><td colspan="4">${i.grp}</td></tr>` : html`<tr ${i.disc ? raw('class="qp__disc"') : ''}>
          <td>${i.name}${i.note ? html`<span class="qp__note">${i.note}</span>` : ''}${i.qty != null ? html`<span class="qp__qtyline">${f1(i.qty)} ${i.unit} × ${ftu(i.price)}</span>` : ''}</td>
          <td class="r">${i.qty != null ? `${f1(i.qty)} ${i.unit}` : ''}</td>
          <td class="r">${i.price != null ? ftu(i.price) : ''}</td>
          <td class="r">${money(i.sum)}</td></tr>`))}</tbody>
      </table></div>
      <table class="qp__totals">
        <tr><td>Nettó havi díj</td><td class="r">${ft(r.net)}</td></tr>
        <tr><td>ÁFA (${f1(r.vatP)}%)</td><td class="r">${ft(r.vat)}</td></tr>
        <tr class="qp__big"><td>Bruttó havi díj</td><td class="r">${ft(r.gross)}</td></tr>
      </table>

      <div class="qp__highlight">
        <div><span>Teljes költség / rendelés (nettó)</span><b>${r.o > 0 ? ft(r.perOrder) : 'nincs rendelés'}</b></div>
        <div><span>Becsült éves díj (nettó)</span><b>${ft(r.yearly)}</b></div>
        <div><span>Egyszeri kedvezmények értéke</span><b>${ft(r.oneOffTotal)}</b></div>
      </div>

      ${r.oneOff.length ? html`<div class="qp__sec">Egyszeri kedvezmények induláskor</div>
        <table class="qp__items"><tbody>${r.oneOff.map((x) => html`<tr class="qp__disc"><td>${x.name}</td><td class="r">${money(-x.value)}</td></tr>`)}</tbody></table>` : ''}

      <div class="qp__sec">Egységárak</div>
      <div class="qp__tablewrap" data-scroll><table class="qp__items qp__unit"><tbody>${pairs.map(([a, b]) => html`<tr>
        <td>${a[0]}</td><td class="r">${a[1]}</td><td>${b ? b[0] : ''}</td><td class="r">${b ? b[1] : ''}</td></tr>`)}</tbody></table></div>

      ${terms.length ? html`<div class="qp__sec">Feltételek</div><ul class="qp__cond">${terms.map((x) => html`<li>${x}</li>`)}</ul>` : ''}

      <p class="qp__fine">A havi díj a megadott forgalom alapján készült becslés, a számlázás a ténylegesen teljesített mennyiségek szerint történik.</p>

      <div class="qp__sign">
        <div>${c.name || 'Fully Logistics'}${d.signer ? html`<br>${d.signer}` : ''}</div>
        <div>${cl.name || 'Ajánlatkérő'}<br>elfogadó aláírás, dátum</div>
      </div>
    </article>`;
  }
})();
