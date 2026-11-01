/* Betárolás view.
     #/betarolas           list with status tabs, KPIs, filters, new inbound, CSV import
     #/betarolas/<id>      detail: arrival, receiving by hand scanner, putaway, closing, receiving report
   The receiving screen keeps the scan input in place while the lines below it are redrawn, and
   handles scans one after the other, so fast scanning never loses a code. Receiving works by typed
   quantity: a scan (or the line's button) opens the quantity entry of the product, and nothing is
   counted until the typed quantity is confirmed. Scanning the same product again while its entry is
   open adds one piece to the typed quantity. */
(() => {
  'use strict';
  const FL = window.FL;
  const { html, raw, ui, api, fmt } = FL;
  const ROUTE = '#/betarolas';
  const OPEN = ['expected', 'arrived', 'receiving'];
  const EDITABLE = ['expected', 'arrived'];
  const CLOSABLE = ['arrived', 'receiving'];
  const TABS = [
    ['open', 'Nyitott'], ['expected', 'Várható'], ['arrived', 'Megérkezett'], ['receiving', 'Átvétel alatt'],
    ['completed', 'Betárolva'], ['cancelled', 'Sztornózva'], ['all', 'Összes'],
  ];
  const SOURCES = { manual: 'Kézi', csv: 'CSV', api: 'API' };
  const CSV_COLUMNS = ['Ügyfélkód', 'Külső hivatkozás', 'Várható dátum', 'Cikkszám', 'Mennyiség', 'Sarzs', 'Lejárat', 'Beszállító kód'];

  const link = (params) => ROUTE + FL.qs(params);
  const unitOf = (l) => l.unit || 'db';
  const pct = (v, max) => (max > 0 ? Math.max(0, Math.min(100, Math.round((v / max) * 100))) : 0);
  const bar = (value, max, done, label) => html`<div class="progress" ${done ? raw('data-done="true"') : ''} role="img" aria-label="${label || `${value} / ${max}`}"><span style="width:${pct(value, max)}%"></span></div>`;
  const chip = (text, tone = 'neutral') => html`<span class="chip" data-tone="${tone}">${text}</span>`;
  const hasDiscrepancy = (l) => l.received_qty !== l.expected_qty || l.damaged_qty > 0 || l.putaway_qty < l.received_qty;
  const strip0 = (s) => String(s || '').replace(/^0+/, '');

  // core/app.js (which defines FL.view) loads after the views and keeps an existing FL.views,
  // so register directly when FL.view is not there yet.
  const register = (key, def) => (typeof FL.view === 'function' ? FL.view(key, def) : ((FL.views = FL.views || {})[key] = def));

  register('inbound', {
    async render(root, ctx) {
      if (ctx.params[0]) {
        const id = Number(ctx.params[0]);
        if (!Number.isInteger(id) || id <= 0) { root.innerHTML = String(ui.empty('Ez a betárolás nem létezik.', 'warning-circle')); return null; }
        return renderDetail(root, id);
      }
      return renderList(root, ctx);
    },
  });

  /* ================================================================ list */

  async function renderList(root, ctx) {
    const q = ctx.query;
    const f = {
      status: q.get('status') || 'open',
      partner_id: q.get('partner_id') || '',
      supplier_id: q.get('supplier_id') || '',
      q: q.get('q') || '',
      from: q.get('from') || '',
      to: q.get('to') || '',
      discrepancy: q.get('discrepancy') || '',
      closed_from: q.get('closed_from') || '',
    };
    const offset = Math.max(parseInt(q.get('offset') || '0', 10) || 0, 0);
    const limit = 50;
    const [data, clients, suppliers] = await Promise.all([
      api.get('/api/inbound', { ...f, status: f.status === 'all' ? '' : f.status, limit, offset }),
      api.get('/api/lookup/partners', { type: 'client', all: 1 }),
      api.get('/api/lookup/partners', { type: 'supplier', all: 1 }),
    ]);
    const k = data.kpis;
    const today = FL.today();
    const filtersOnly = { partner_id: f.partner_id, supplier_id: f.supplier_id, q: f.q, from: f.from, to: f.to, discrepancy: f.discrepancy, closed_from: f.closed_from };
    const filtered = Object.values(filtersOnly).some(Boolean);
    const actions = FL.can('inbound', 'create') ? html`
      <button class="btn" type="button" data-action="import">${FL.icon('upload-simple')}CSV import</button>
      <button class="btn btn--primary" type="button" data-action="new">${FL.icon('plus')}Új betárolás</button>` : '';

    root.innerHTML = String(html`
      ${ui.pageHead({ title: 'Betárolás', lead: 'Várható szállítások, áruátvétel kézi szkennerrel és polcra helyezés.', actions })}
      ${ui.kpis([
        { label: 'Várható ma', value: fmt.int(k.expected_today), hint: k.overdue ? `${fmt.int(k.overdue)} késésben` : 'mai érkezés', tone: k.overdue ? 'warn' : '', href: link({ status: 'expected', from: k.today, to: k.today }) },
        { label: 'Megérkezett', value: fmt.int(k.arrived), hint: 'átvételre vár', href: link({ status: 'arrived' }) },
        { label: 'Átvétel alatt', value: fmt.int(k.receiving), hint: 'számlálás, polcra helyezés', href: link({ status: 'receiving' }) },
        { label: 'Eltéréssel lezárt', value: fmt.int(k.discrepancy_30d), hint: 'elmúlt 30 nap', tone: k.discrepancy_30d ? 'danger' : '', href: link({ status: 'completed', discrepancy: 1, closed_from: k.discrepancy_since }) },
      ])}
      ${ui.tabs(TABS.map(([key, label]) => ({ key, label, count: data.counts[key] ?? 0, href: link({ ...filtersOnly, status: key }) })), f.status, 'Betárolások állapot szerint')}
      <form class="toolbar inb-filters" data-filters role="search" aria-label="Betárolások szűrése">
        <input type="hidden" name="status" value="${f.status}">
        <div class="field field--grow"><label for="inb-q">Keresés</label>
          <input class="input" id="inb-q" name="q" type="search" value="${f.q}" placeholder="Betárolás száma vagy külső hivatkozás" autocomplete="off"></div>
        ${ui.field({ name: 'partner_id', label: 'Ügyfél', type: 'select', value: f.partner_id, placeholder: 'Minden ügyfél', options: clients.items.map((p) => ({ value: p.id, label: `${p.name} (${p.code})` })) })}
        ${ui.field({ name: 'supplier_id', label: 'Beszállító', type: 'select', value: f.supplier_id, placeholder: 'Minden beszállító', options: suppliers.items.map((p) => ({ value: p.id, label: p.name })) })}
        ${ui.field({ name: 'from', label: 'Várható ettől', type: 'date', value: f.from })}
        ${ui.field({ name: 'to', label: 'Várható eddig', type: 'date', value: f.to })}
        <input type="hidden" name="discrepancy" value="${f.discrepancy}">
        <input type="hidden" name="closed_from" value="${f.closed_from}">
        <div class="actions">
          <button class="btn" type="submit">${FL.icon('funnel')}Szűrés</button>
          ${filtered ? html`<a class="btn btn--ghost" href="${link({ status: f.status })}">Szűrők törlése</a>` : ''}
        </div>
      </form>
      ${f.discrepancy === '1' ? ui.notice(html`Csak az eltéréssel lezárt betárolások${f.closed_from ? html` ${fmt.date(f.closed_from)} óta` : ''}.`, 'info') : ''}
      ${ui.table({
        caption: 'Betárolások',
        cls: 'inb-table',
        empty: filtered ? 'Nincs a szűrésnek megfelelő betárolás.' : 'Nincs betárolás ebben az állapotban.',
        rows: data.items,
        rowHref: (r) => `${ROUTE}/${r.id}`,
        columns: [
          { key: 'number', label: 'Szám', render: (r) => html`<a class="mono inb-code" href="${ROUTE}/${r.id}">${r.number}</a>${r.external_ref ? html`<span class="sub">${r.external_ref}</span>` : ''}` },
          { key: 'partner', label: 'Ügyfél', render: (r) => html`${r.partner_name}<span class="sub">${r.partner_code}</span>` },
          { key: 'supplier', label: 'Beszállító', render: (r) => r.supplier_name || html`<span class="muted">nincs megadva</span>` },
          { key: 'expected_date', label: 'Várható', cls: 'nowrap', render: (r) => {
            const late = r.status === 'expected' && r.expected_date && r.expected_date < today;
            return r.expected_date ? html`<span class="${late ? 'inb-late' : ''}">${fmt.date(r.expected_date)}</span>${late ? html`<span class="sub">késésben</span>` : ''}` : html`<span class="muted">nincs</span>`;
          } },
          { key: 'status', label: 'Állapot', render: (r) => html`<span class="inb-chips">${FL.status('inbound', r.status)}${r.has_discrepancy ? chip('Eltérés', 'danger') : ''}</span>` },
          { key: 'line_count', label: 'Tételek', align: 'r', cls: 'num' , render: (r) => fmt.int(r.line_count) },
          { key: 'received', label: 'Átvett / várt', render: (r) => html`<span class="num">${fmt.int(r.received_qty)} / ${fmt.int(r.expected_qty)}</span>${bar(r.received_qty, Math.max(r.expected_qty, r.received_qty), r.received_qty === r.expected_qty && r.expected_qty > 0)}` },
          { key: 'putaway_qty', label: 'Polcon', align: 'r', cls: 'num', render: (r) => fmt.int(r.putaway_qty) },
          { key: 'source', label: 'Forrás', render: (r) => html`<span class="tag">${SOURCES[r.source] || r.source}</span>` },
        ],
      })}
      ${ui.pager({ total: data.total, limit, offset })}`);

    ui.enableRowLinks(root);
    root.querySelector('[data-filters]').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target).entries());
      FL.go(link(v));
    });
    ui.bind(root, {
      new: () => inboundForm(null),
      import: async () => {
        const res = await ui.csvImport({
          title: 'Betárolások importálása CSV-ből',
          endpoint: '/api/inbound/import',
          help: 'Soronként egy tétel. Az azonos ügyfélkódú és külső hivatkozású sorokból egy betárolás lesz. Ha nincs külső hivatkozás, az azonos dátumú és beszállítójú sorok kerülnek egybe. A már importált hivatkozásokat kihagyjuk.',
          templateName: 'betarolas-sablon.csv',
          templateColumns: CSV_COLUMNS,
        });
        if (res) {
          if (res.inbounds) ui.toast(`${fmt.int(res.inbounds)} betárolás jött létre.`, 'ok');
          FL.reload();
        }
      },
      page: (el) => FL.go(link({ ...filtersOnly, status: f.status, offset: el.dataset.offset })),
    });
    return null;
  }

  /* ================================================================ new and edit form */

  let rowSeq = 0;
  function lineRow(l = {}) {
    const k = ++rowSeq;
    const label = l.sku ? `${l.sku} ${l.name || ''}`.trim() : '';
    return html`<div class="inb-fline" data-row>
      <input type="hidden" data-f="id" value="${l.id || ''}">
      <input type="hidden" data-f="product_id" value="${l.product_id || ''}">
      <div class="field inb-fline__product">
        <label class="inb-fline__label" for="fl-p-${k}">Termék</label>
        <input class="input" id="fl-p-${k}" data-f="sku" data-product value="${label}" placeholder="Cikkszám, név vagy EAN" autocomplete="off" aria-describedby="fl-p-${k}-err">
        <p class="field__error" id="fl-p-${k}-err" hidden></p>
      </div>
      <div class="field">
        <label class="inb-fline__label" for="fl-q-${k}">Várt mennyiség</label>
        <input class="input input--num" id="fl-q-${k}" type="number" min="1" step="1" inputmode="numeric" data-f="expected_qty" value="${l.expected_qty ?? ''}" aria-describedby="fl-q-${k}-err">
        <p class="field__error" id="fl-q-${k}-err" hidden></p>
      </div>
      <div class="field">
        <label class="inb-fline__label" for="fl-l-${k}">Sarzs</label>
        <input class="input input--code" id="fl-l-${k}" data-f="lot" value="${l.lot || ''}" autocomplete="off" aria-describedby="fl-l-${k}-err">
        <p class="field__error" id="fl-l-${k}-err" hidden></p>
      </div>
      <div class="field">
        <label class="inb-fline__label" for="fl-e-${k}">Lejárat</label>
        <input class="input" id="fl-e-${k}" type="date" data-f="expiry" value="${l.expiry || ''}" aria-describedby="fl-e-${k}-err">
        <p class="field__error" id="fl-e-${k}-err" hidden></p>
      </div>
      <button class="btn btn--ghost btn--icon btn--sm inb-fline__remove" type="button" data-remove-line aria-label="Sor törlése">${FL.icon('trash')}</button>
    </div>`;
  }

  // New inbound (existing = null) or edit of an expected / arrived one.
  async function inboundForm(existing) {
    const [clients, suppliers] = await Promise.all([ui.partnerOptions('client'), ui.partnerOptions('supplier')]);
    if (existing && !clients.some((c) => String(c.value) === String(existing.partner_id))) {
      clients.push({ value: existing.partner_id, label: `${existing.partner_name} (${existing.partner_code})` });
    }
    const e = existing || {};
    const lines = existing ? existing.lines : [{}];
    const dlg = ui.dialog({
      title: existing ? `${existing.number} szerkesztése` : 'Új betárolás',
      size: 'wide',
      submitLabel: existing ? 'Mentés' : 'Betárolás rögzítése',
      body: html`
        <div class="form-grid">
          ${ui.field({ name: 'partner_id', label: 'Ügyfél', type: 'select', required: true, value: e.partner_id, placeholder: 'Válassz ügyfelet', options: clients })}
          ${ui.field({ name: 'supplier_id', label: 'Beszállító', type: 'select', optional: true, value: e.supplier_id, placeholder: 'Nincs megadva', options: suppliers })}
          ${ui.field({ name: 'expected_date', label: 'Várható érkezés', type: 'date', optional: true, value: e.expected_date || FL.today() })}
          ${ui.field({ name: 'external_ref', label: 'Külső hivatkozás', optional: true, value: e.external_ref, hint: 'Szállítólevél vagy ASN szám.' })}
          ${ui.field({ name: 'pallets', label: 'Raklap', type: 'number', int: true, min: 0, value: e.pallets ?? 0 })}
          ${ui.field({ name: 'cartons', label: 'Karton', type: 'number', int: true, min: 0, value: e.cartons ?? 0 })}
          ${ui.field({ name: 'note', label: 'Megjegyzés', type: 'textarea', rows: 2, optional: true, value: e.note, span: 'all' })}
        </div>
        <fieldset class="inb-flines">
          <legend class="field__label">Tételek</legend>
          <div class="inb-fline inb-fline--head" aria-hidden="true"><span>Termék</span><span>Várt mennyiség</span><span>Sarzs</span><span>Lejárat</span><span></span></div>
          <div data-lines>${lines.map((l) => lineRow(l))}</div>
          <div class="field"><input type="hidden" name="lines"><p class="field__error" hidden></p></div>
          <div><button class="btn btn--sm" type="button" data-add-line>${FL.icon('plus')}Tétel hozzáadása</button></div>
        </fieldset>`,
      onOpen: ({ form }) => {
        const box = form.querySelector('[data-lines]');
        const partner = form.querySelector('[name="partner_id"]');
        const renumber = () => box.querySelectorAll('[data-row]').forEach((row, i) => {
          row.querySelectorAll('[data-f]').forEach((el) => { el.name = `lines.${i}.${el.dataset.f}`; });
        });
        const setupRow = (row) => {
          const input = row.querySelector('[data-product]');
          const hidden = row.querySelector('[data-f="product_id"]');
          input.disabled = !partner.value;
          if (!partner.value) input.placeholder = 'Előbb válassz ügyfelet';
          input.addEventListener('input', () => { hidden.value = ''; });
          ui.autocomplete(input, {
            source: async (q) => (partner.value ? ui.sources.products(partner.value)(q) : []),
            label: ui.productLabel,
            sub: (p) => (p.ean ? `EAN ${p.ean}` : p.unit),
            onSelect: (p) => {
              input.value = ui.productLabel(p);
              hidden.value = p.id;
              const qty = row.querySelector('[data-f="expected_qty"]');
              qty.focus();
              qty.select();
            },
          });
        };
        box.querySelectorAll('[data-row]').forEach(setupRow);
        renumber();
        let current = partner.value;
        partner.addEventListener('change', () => {
          const had = [...box.querySelectorAll('[data-f="product_id"]')].some((h) => h.value);
          box.querySelectorAll('[data-row]').forEach((row) => {
            const input = row.querySelector('[data-product]');
            input.disabled = !partner.value;
            input.placeholder = partner.value ? 'Cikkszám, név vagy EAN' : 'Előbb válassz ügyfelet';
            if (partner.value !== current) { input.value = ''; row.querySelector('[data-f="product_id"]').value = ''; }
          });
          if (had && partner.value !== current) ui.toast('Másik ügyfelet választottál: a termékeket válaszd ki újra.', 'info');
          current = partner.value;
        });
        form.addEventListener('click', (ev) => {
          if (ev.target.closest('[data-add-line]')) {
            box.insertAdjacentHTML('beforeend', String(lineRow({})));
            const row = box.lastElementChild;
            setupRow(row);
            renumber();
            row.querySelector('[data-product]').focus();
          }
          const rm = ev.target.closest('[data-remove-line]');
          if (rm) {
            const rows = box.querySelectorAll('[data-row]');
            if (rows.length === 1) { ui.toast('Legalább egy tétel kell.', 'error'); return; }
            const row = rm.closest('[data-row]');
            const next = row.nextElementSibling || row.previousElementSibling;
            row.remove();
            renumber();
            if (next) next.querySelector('[data-product]').focus();
          }
        });
      },
      onSubmit: async (form) => {
        const v = ui.formValues(form);
        const lines = [...form.querySelectorAll('[data-lines] [data-row]')].map((row) => {
          const val = (f) => row.querySelector(`[data-f="${f}"]`).value.trim();
          const out = { expected_qty: val('expected_qty') === '' ? null : Number(val('expected_qty')), lot: val('lot'), expiry: val('expiry') || null };
          if (val('id')) out.id = Number(val('id'));
          if (val('product_id')) out.product_id = Number(val('product_id'));
          else out.sku = val('sku').split(/\s+/)[0] || '';
          return out;
        });
        const body = {
          partner_id: v.partner_id ? Number(v.partner_id) : null,
          supplier_id: v.supplier_id ? Number(v.supplier_id) : null,
          expected_date: v.expected_date || null,
          external_ref: v.external_ref,
          pallets: v.pallets ?? 0,
          cartons: v.cartons ?? 0,
          note: v.note,
          lines,
        };
        try {
          if (existing) {
            await api.put(`/api/inbound/${existing.id}`, body);
            ui.toast('Betárolás mentve.', 'ok');
            FL.reload();
          } else {
            const res = await api.post('/api/inbound', body);
            ui.toast(`${res.number} rögzítve.`, 'ok');
            FL.go(`${ROUTE}/${res.id}`);
          }
        } catch (err) {
          if (err.fields) {
            for (const key of Object.keys(err.fields)) {
              const m = key.match(/^lines\.(\d+)\.(product_id|id)$/);
              if (m && !err.fields[`lines.${m[1]}.sku`]) err.fields[`lines.${m[1]}.sku`] = err.fields[key];
            }
          }
          throw err;
        }
      },
    });
    return dlg;
  }

  /* ================================================================ detail */

  async function renderDetail(root, id) {
    let d = await api.get(`/api/inbound/${id}`);
    const st = {
      mode: initialMode(d),
      activeLine: null,
      // Quantity entry while receiving: { lineId, qty, damaged, lot, expiry } (typed, not saved yet).
      entry: null,
      put: { lineId: null, location: null, qty: '' },
    };
    let queue = Promise.resolve();
    let audioCtx = null;
    let lastFeedback = null;
    const canEdit = () => FL.can('inbound', 'edit');
    const working = () => CLOSABLE.includes(d.status) && canEdit();

    root.innerHTML = String(html`
      <div class="inb-screen">
        <div class="inb-region" data-region="head"></div>
        <div class="inb-region" data-region="summary"></div>
        <section class="panel inb-work" data-region="work-shell" aria-label="Átvétel és polcra helyezés" hidden></section>
        <div class="inb-region" data-region="lines"></div>
        <div class="grid-2" data-region="info"></div>
      </div>
      <div class="inb-print" data-region="print"></div>`);
    const region = (name) => root.querySelector(`[data-region="${name}"]`);

    function initialMode(data) {
      const lines = data.lines;
      const counting = lines.some((l) => l.received_qty < l.expected_qty);
      const toPut = lines.some((l) => l.received_qty > l.putaway_qty);
      return !counting && toPut ? 'putaway' : 'receive';
    }

    function recalc() {
      const t = { lines: d.lines.length, expected: 0, received: 0, damaged: 0, putaway: 0 };
      for (const l of d.lines) {
        t.expected += l.expected_qty;
        t.received += l.received_qty;
        t.damaged += l.damaged_qty;
        t.putaway += l.putaway_qty;
        l.open_qty = l.received_qty - l.putaway_qty;
      }
      d.totals = t;
      d.discrepancy = d.lines.some(hasDiscrepancy);
      d.can_cancel = OPEN.includes(d.status) && t.putaway === 0;
    }

    function beep(kind) {
      try {
        audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'square';
        o.frequency.value = kind === 'ok' ? 1320 : kind === 'warn' ? 660 : 220;
        g.gain.value = 0.05;
        o.connect(g);
        g.connect(audioCtx.destination);
        o.start();
        o.stop(audioCtx.currentTime + (kind === 'ok' ? 0.08 : 0.35));
      } catch { /* no audio, fine */ }
    }

    function feedback(text, tone = 'info') {
      lastFeedback = { text, tone };
      const el = root.querySelector('[data-feedback]');
      if (!el) { ui.toast(text, tone === 'danger' ? 'error' : tone); return; }
      el.dataset.tone = tone;
      el.innerHTML = String(html`${FL.icon(tone === 'ok' ? 'check-circle' : tone === 'info' ? 'info' : 'warning-circle')}<span>${text}</span>`);
    }

    const scanInput = () => root.querySelector('#inb-scan');
    const focusScan = () => { const s = scanInput(); if (s) s.focus(); };

    /* ---------------------------------------------------------- regions */

    function paintHead() {
      const s = d.status;
      const allPut = d.lines.every((l) => l.putaway_qty === l.received_qty) && d.totals.received > 0;
      const actions = [];
      actions.push(html`<button class="btn" type="button" data-action="print">${FL.icon('printer')}Jegyzőkönyv</button>`);
      if (EDITABLE.includes(s) && FL.can('inbound', 'create')) actions.push(html`<button class="btn" type="button" data-action="edit">${FL.icon('pencil-simple')}Szerkesztés</button>`);
      if (d.can_cancel && FL.can('inbound', 'delete')) actions.push(html`<button class="btn btn--danger" type="button" data-action="cancel">${FL.icon('x')}Sztornó</button>`);
      if (OPEN.includes(s) && s !== 'expected' && canEdit()) actions.push(html`<button class="btn" type="button" data-action="arrive">${FL.icon('truck')}Érkezési adatok</button>`);
      if (s === 'expected' && canEdit()) actions.push(html`<button class="btn btn--primary" type="button" data-action="arrive">${FL.icon('truck')}Megérkezett</button>`);
      if (CLOSABLE.includes(s) && canEdit()) actions.push(html`<button class="btn ${allPut ? 'btn--primary' : ''}" type="button" data-action="complete">${FL.icon('check-circle')}Lezárás</button>`);
      region('head').innerHTML = String(html`
        ${ui.pageHead({
          crumb: { href: ROUTE, label: 'Betárolás' },
          title: d.number,
          lead: html`${d.partner_name} (${d.partner_code})${d.supplier_name ? html`, beszállító: ${d.supplier_name}` : ''}${d.expected_date ? html`, várható: ${fmt.date(d.expected_date)}` : ''}`,
          actions,
        })}
        <div class="inb-chips inb-statusline">
          ${FL.status('inbound', s)}
          ${d.has_discrepancy ? chip('Eltéréssel lezárva', 'danger') : ''}
          ${d.external_ref ? html`<span class="tag">${d.external_ref}</span>` : ''}
          <span class="tag">${SOURCES[d.source] || d.source}</span>
        </div>`);
    }

    function issueList() {
      return d.lines.filter((l) => l.issues.length).map((l) => html`<li><b class="mono">${l.sku}</b>${l.lot ? html` (sarzs ${l.lot})` : ''}: ${l.issues.map((i) => i.text).join(', ')}</li>`);
    }

    function paintSummary() {
      const t = d.totals;
      const s = d.status;
      const diff = t.received - t.expected;
      const notices = [];
      if (s === 'expected') {
        notices.push(ui.notice(canEdit() ? 'A szállítmány még nem érkezett meg. Ha a rámpára állt, jelöld megérkezettnek (raklap, karton), és kezdheted az átvételt.' : 'A szállítmány még nem érkezett meg.', 'info'));
      }
      if (s === 'cancelled') notices.push(ui.notice(html`Sztornózva ${fmt.dateTime(d.cancelled_at)}.${d.cancel_reason ? html` Indoklás: ${d.cancel_reason}` : ''}`, 'info'));
      if (s === 'completed') {
        notices.push(d.has_discrepancy
          ? ui.notice(html`<p><b>Lezárva eltéréssel</b> ${fmt.dateTime(d.completed_at)}${d.completed_by_name ? html`, ${d.completed_by_name}` : ''}. Indoklás: ${d.discrepancy_note}</p>${issueList().length ? html`<ul class="inb-issues">${issueList()}</ul>` : ''}`, 'warn')
          : ui.notice(html`Betárolva eltérés nélkül ${fmt.dateTime(d.completed_at)}${d.completed_by_name ? html`, ${d.completed_by_name}` : ''}.`, 'ok'));
      }
      if (CLOSABLE.includes(s)) {
        const items = issueList();
        if (items.length) notices.push(ui.notice(html`<p><b>Eltérés a várt mennyiségtől.</b> Lezárni csak jóváhagyással, indoklással lehet.</p><ul class="inb-issues">${items}</ul>`, 'warn'));
        const missingLot = d.lines.filter((l) => l.received_qty > l.putaway_qty && ((l.track_lot && !l.lot) || (l.track_expiry && !l.expiry)));
        if (missingLot.length) notices.push(ui.notice(html`Polcra helyezés előtt add meg a sarzsot vagy a lejáratot: ${missingLot.map((l) => l.sku).join(', ')}.`, 'warn'));
      }
      region('summary').innerHTML = String(html`
        ${ui.kpis([
          { label: 'Várt mennyiség', value: fmt.int(t.expected), hint: `${fmt.int(t.lines)} tétel` },
          { label: 'Átvett', value: fmt.int(t.received), hint: diff === 0 ? 'egyezik a várttal' : diff > 0 ? `${fmt.int(diff)} többlet` : `${fmt.int(-diff)} hiány`, tone: diff === 0 ? (t.received ? 'ok' : '') : 'warn' },
          { label: 'Sérült', value: fmt.int(t.damaged), hint: !t.damaged ? 'nincs sérült áru' : OPEN.includes(s) ? 'karanténba tedd' : 'sérült áru', tone: t.damaged ? 'danger' : '' },
          { label: 'Polcon', value: fmt.int(t.putaway), hint: t.received ? `${pct(t.putaway, t.received)}% az átvettből` : 'még semmi', tone: t.received && t.putaway === t.received ? 'ok' : '' },
        ])}
        ${notices}`);
    }

    // The scan bar, mode tabs and feedback. Built only when the mode changes, never during scanning.
    function paintShell() {
      const shell = region('work-shell');
      if (!working()) { shell.hidden = true; shell.innerHTML = ''; return; }
      shell.hidden = false;
      const toPut = d.lines.reduce((n, l) => n + Math.max(l.received_qty - l.putaway_qty, 0), 0);
      const receive = st.mode === 'receive';
      shell.innerHTML = String(html`
        <div class="inb-modes" role="tablist" aria-label="Munkafolyamat lépései">
          <button class="tab" type="button" role="tab" id="inb-tab-receive" aria-controls="inb-work" aria-selected="${String(receive)}" data-action="mode" data-mode="receive">${FL.icon('barcode')}1. Átvétel</button>
          <button class="tab" type="button" role="tab" id="inb-tab-putaway" aria-controls="inb-work" aria-selected="${String(!receive)}" data-action="mode" data-mode="putaway">${FL.icon('stack')}2. Polcra helyezés <span class="count" data-put-count>${toPut ? `${fmt.int(toPut)} vár` : ''}</span></button>
        </div>
        <div class="inb-scanzone">
        <div class="inb-scanbar">
          ${ui.scan({
            id: 'inb-scan',
            label: receive ? 'Termék beolvasása (EAN vagy cikkszám)' : 'Termék vagy raktárhely beolvasása',
            placeholder: receive ? 'EAN vagy cikkszám' : 'Termék vagy hely',
          })}
        </div>
        <p class="inb-feedback" data-feedback data-tone="info" aria-live="polite">${FL.icon('info')}<span>${receive
          ? 'Olvasd be a terméket (vagy válaszd ki lent), írd be a beérkezett mennyiséget, és rögzítsd.'
          : 'Olvasd be a termék kódját (vagy válassz tételt), utána a raktárhely kódját, és erősítsd meg a mennyiséget.'}</span></p>
        ${receive ? html`<div class="inb-entrybox" data-entry hidden></div>` : ''}
        </div>
        <div id="inb-work" role="tabpanel" aria-labelledby="${receive ? 'inb-tab-receive' : 'inb-tab-putaway'}" data-region="work"></div>`);
      // The mode is taken at the moment of the scan, not when the queued request is sent.
      const scan = ui.bindScan(shell, 'inb-scan', (code) => {
        const at = { mode: st.mode };
        queue = queue.then(() => onScan(code, at)).catch(() => {});
      });
      if (scan) scan.setAttribute('data-autofocus', '');
      paintEntry();
      paintWork();
    }

    // The quantity entry of the product being received. Typed values live in st.entry, so a redraw
    // (another scanner's change, a reload) keeps them.
    function paintEntry() {
      const box = root.querySelector('[data-entry]');
      if (!box) return;
      const l = st.entry && d.lines.find((x) => x.id === st.entry.lineId);
      if (!l) { st.entry = null; box.hidden = true; box.innerHTML = ''; return; }
      const e = st.entry;
      const lots = d.lines.filter((x) => x.product_id === l.product_id);
      const left = Math.max(l.expected_qty - l.received_qty, 0);
      const needLot = l.track_lot && !l.lot && l.putaway_qty === 0;
      const needExp = l.track_expiry && !l.expiry && l.putaway_qty === 0;
      box.hidden = false;
      box.innerHTML = String(html`<form class="inb-entry" data-entry-form novalidate aria-label="Mennyiség: ${l.sku}">
        <div class="inb-entry__info">
        <div class="inb-entry__product">
          <span class="inb-card__sku">${l.sku}</span>
          <span class="inb-entry__name">${l.name}</span>
          <span class="inb-card__codes">${codesLine(l)}</span>
        </div>
        <dl class="inb-entry__stats">
          <div><dt>Várt</dt><dd class="num">${fmt.int(l.expected_qty)}</dd></div>
          <div><dt>Eddig átvéve</dt><dd class="num">${fmt.int(l.received_qty)}</dd></div>
          <div><dt>Hátra</dt><dd class="num">${fmt.int(left)}</dd></div>
        </dl>
        </div>
        <div class="inb-entry__input">
        ${lots.length > 1 ? html`<div class="field"><label for="inb-entry-line">Sarzs</label>
          <select class="select" id="inb-entry-line" data-action="entry-line">${lots.map((x) => html`<option value="${x.id}" ${x.id === l.id ? raw('selected') : ''}>${x.lot || 'sarzs nélkül'}${x.expiry ? `, lejárat ${fmt.date(x.expiry)}` : ''} (${fmt.int(x.received_qty)} / ${fmt.int(x.expected_qty)})</option>`)}</select></div>` : ''}
        <div class="inb-entry__row">
          <div class="field inb-entry__qty"><label for="inb-entry-qty">Beérkezett mennyiség (${unitOf(l)})</label>
            <input class="input input--num" id="inb-entry-qty" name="qty" type="text" inputmode="numeric" autocomplete="off" enterkeyhint="done" value="${e.qty}" aria-describedby="inb-entry-qty-err">
            <p class="field__error" id="inb-entry-qty-err" hidden></p></div>
          <label class="check inb-entry__damaged"><input type="checkbox" name="damaged" ${e.damaged ? raw('checked') : ''}><span>Sérült</span></label>
        </div>
        ${needLot || needExp ? html`<div class="inb-entry__row">
          ${needLot ? html`<div class="field"><label for="inb-entry-lot">Sarzs</label>
            <input class="input input--code" id="inb-entry-lot" name="lot" value="${e.lot}" autocomplete="off" aria-describedby="inb-entry-lot-err"><p class="field__error" id="inb-entry-lot-err" hidden></p></div>` : ''}
          ${needExp ? html`<div class="field"><label for="inb-entry-exp">Lejárat</label>
            <input class="input" type="date" id="inb-entry-exp" name="expiry" value="${e.expiry}" aria-describedby="inb-entry-exp-err"><p class="field__error" id="inb-entry-exp-err" hidden></p></div>` : ''}
        </div>` : ''}
        <div class="inb-entry__actions">
          <button class="btn" type="button" data-action="entry-cancel">${FL.icon('x')}Mégse</button>
          <button class="btn btn--primary" type="submit">${FL.icon('check')}Rögzítés</button>
        </div>
        </div>
      </form>`);
    }

    const focusQty = () => { const q = root.querySelector('#inb-entry-qty'); if (q) { q.focus(); q.select(); } };

    // A scan opens the entry with 1 piece (selected, so typing a number replaces it; every further
    // scan of the product adds one); the line's button opens it empty.
    function openEntry(l, { scanned = false } = {}) {
      st.entry = { lineId: l.id, qty: scanned ? '1' : '', damaged: false, lot: '', expiry: '' };
      st.activeLine = l.id;
      paintEntry();
      paintWork();
      focusQty();
    }

    function lineState(l) {
      if (l.expected_qty === 0) return 'extra';
      if (l.received_qty === 0) return 'todo';
      if (l.received_qty < l.expected_qty) return 'partial';
      return l.received_qty === l.expected_qty ? 'done' : 'over';
    }

    const codesLine = (l) => [l.ean ? `EAN ${l.ean}` : 'nincs EAN', l.lot ? `sarzs ${l.lot}` : '', l.expiry ? `lejárat ${fmt.date(l.expiry)}` : ''].filter(Boolean).join(' · ');

    function receiveCard(l) {
      const tracked = (l.track_lot || l.track_expiry) && l.putaway_qty === 0;
      const needLot = l.track_lot && !l.lot;
      const needExp = l.track_expiry && !l.expiry;
      return html`<li class="inb-card" data-line="${l.id}" data-state="${lineState(l)}" ${st.activeLine === l.id ? raw('data-active="true"') : ''}>
        <div class="inb-card__top">
          <div class="inb-card__product">
            <span class="inb-card__sku">${l.sku}</span>
            <span class="inb-card__name">${l.name}</span>
            <span class="inb-card__codes">${codesLine(l)}</span>
          </div>
          <div class="inb-card__count"><b class="num">${fmt.int(l.received_qty)}</b><span class="num">/ ${fmt.int(l.expected_qty)} ${unitOf(l)}</span></div>
        </div>
        ${bar(l.received_qty, Math.max(l.expected_qty, l.received_qty), lineState(l) === 'done', `Átvett ${l.received_qty}, várt ${l.expected_qty}`)}
        <div class="inb-chips">
          ${l.issues.map((i) => chip(i.text, i.kind === 'damaged' ? 'danger' : 'warn'))}
          ${l.received_qty && l.received_qty === l.expected_qty && !l.damaged_qty ? chip('rendben', 'ok') : ''}
          ${needLot ? chip('sarzs hiányzik', 'warn') : ''}${needExp ? chip('lejárat hiányzik', 'warn') : ''}
          ${l.putaway_qty ? chip(`polcon ${fmt.int(l.putaway_qty)}`, 'info') : ''}
        </div>
        ${tracked ? html`<div class="inb-card__track">
          ${l.track_lot ? html`<div class="field"><label for="lot-${l.id}">Sarzs</label><input class="input input--code" id="lot-${l.id}" data-action="track" data-field="lot" data-id="${l.id}" value="${l.lot}" autocomplete="off" ${needLot ? raw('aria-invalid="true"') : ''}></div>` : ''}
          ${l.track_expiry ? html`<div class="field"><label for="exp-${l.id}">Lejárat</label><input class="input" type="date" id="exp-${l.id}" data-action="track" data-field="expiry" data-id="${l.id}" value="${l.expiry}" ${needExp ? raw('aria-invalid="true"') : ''}></div>` : ''}
        </div>` : ''}
        <div class="inb-card__actions">
          <button class="btn btn--sm ${st.entry && st.entry.lineId === l.id ? 'btn--dark' : ''}" type="button" data-action="entry" data-id="${l.id}" aria-label="Mennyiség beírása: ${l.sku}">${FL.icon('tray-arrow-down')}Mennyiség beírása</button>
          <button class="btn btn--sm" type="button" data-action="edit-line" data-id="${l.id}">${FL.icon('pencil-simple')}Javítás</button>
          ${l.expected_qty === 0 && l.putaway_qty === 0 ? html`<button class="btn btn--sm btn--ghost" type="button" data-action="delete-line" data-id="${l.id}">${FL.icon('trash')}Törlés</button>` : ''}
        </div>
      </li>`;
    }

    const damagedLeft = (l) => Math.max(l.damaged_qty - l.putaways.filter((p) => p.location_kind === 'quarantine').reduce((n, p) => n + p.qty, 0), 0);

    function putCard(l) {
      const open = l.received_qty - l.putaway_qty;
      const selected = st.put.lineId === l.id;
      return html`<li class="inb-card" data-line="${l.id}" data-state="${open > 0 ? 'todo' : l.received_qty ? 'done' : 'empty'}" ${selected ? raw('data-active="true"') : ''}>
        <div class="inb-card__top">
          <div class="inb-card__product">
            <span class="inb-card__sku">${l.sku}</span>
            <span class="inb-card__name">${l.name}</span>
            <span class="inb-card__codes">${codesLine(l)}</span>
          </div>
          <div class="inb-card__count">${open > 0
            ? html`<b class="num">${fmt.int(open)}</b><span>${unitOf(l)} polcra vár</span>`
            : html`<b class="num">${fmt.int(l.putaway_qty)}</b><span>${l.received_qty ? 'polcon, kész' : 'nincs átvett áru'}</span>`}</div>
        </div>
        ${bar(l.putaway_qty, l.received_qty, l.received_qty > 0 && open === 0, `Polcon ${l.putaway_qty}, átvett ${l.received_qty}`)}
        <div class="inb-chips">
          ${l.putaways.map((p) => html`<span class="tag">${p.location_code}: ${fmt.int(p.qty)}</span>`)}
          ${open > 0 && l.suggested ? html`<span class="chip" data-tone="info" title="${l.suggested.reason}">javasolt: ${l.suggested.code}</span>` : ''}
          ${damagedLeft(l) ? chip(`${fmt.int(damagedLeft(l))} sérült, karanténba`, 'danger') : ''}
          ${(l.track_lot && !l.lot) || (l.track_expiry && !l.expiry) ? chip('sarzs vagy lejárat hiányzik', 'warn') : ''}
        </div>
        ${open > 0 ? html`<div class="inb-card__actions">
          <button class="btn btn--sm ${selected ? 'btn--dark' : ''}" type="button" data-action="select-line" data-id="${l.id}" aria-pressed="${String(selected)}">${FL.icon(selected ? 'check' : 'arrow-right')}${selected ? 'Kiválasztva' : 'Kiválaszt'}</button>
        </div>` : ''}
      </li>`;
    }

    function putForm() {
      const l = d.lines.find((x) => x.id === st.put.lineId);
      const open = l ? l.received_qty - l.putaway_qty : 0;
      const dmg = l ? damagedLeft(l) : 0;
      return html`<form class="inb-put" data-put-form novalidate>
        <div class="inb-put__line">${l
          ? html`<b class="mono">${l.sku}</b> ${l.name}${l.lot ? html` <span class="tag">sarzs ${l.lot}</span>` : ''} <span class="muted">${fmt.int(open)} ${unitOf(l)} vár polcra</span>`
          : html`<span class="muted">Válassz tételt: olvasd be a termék kódját, vagy válaszd ki lent.</span>`}</div>
        <div class="inb-put__fields">
          <div class="field inb-put__loc"><label for="inb-put-loc">Raktárhely</label>
            <input class="input input--code" id="inb-put-loc" name="location_code" value="${st.put.location ? st.put.location.code : ''}" placeholder="A-01-03" autocomplete="off" ${l ? '' : raw('disabled')}></div>
          <div class="field inb-put__qty"><label for="inb-put-qty">Mennyiség</label>
            <input class="input input--num" id="inb-put-qty" name="qty" type="number" min="1" max="${open || 1}" step="1" inputmode="numeric" value="${st.put.qty}" ${l ? '' : raw('disabled')}></div>
          <button class="btn btn--primary" type="submit" ${l ? '' : raw('disabled')}>${FL.icon('tray-arrow-down')}Polcra helyezés</button>
        </div>
        ${l ? html`<div class="inb-put__hints">
          ${l.suggested ? html`<button class="btn btn--sm" type="button" data-action="use-loc" data-id="${l.suggested.id}" data-code="${l.suggested.code}">${FL.icon('map-pin')}Javasolt hely: ${l.suggested.code}</button>
            <span class="inb-put__why small">${l.suggested.reason}</span>` : html`<span class="muted small">Nincs javasolt szabad hely.</span>`}
          ${dmg && d.quarantine ? html`<button class="btn btn--sm btn--danger" type="button" data-action="use-quarantine">${FL.icon('warning')}${fmt.int(Math.min(dmg, open))} sérült karanténba (${d.quarantine.code})</button>` : ''}
          ${dmg && !d.quarantine ? html`<span class="inb-warn">${FL.icon('warning')}Nincs szabad karanténhely ennek az ügyfélnek (egy helyen csak egy ügyfél áruja lehet). Vegyél fel karanténhelyet a Beállításokban.</span>` : ''}
        </div>` : ''}
      </form>`;
    }

    function paintWork() {
      const box = root.querySelector('[data-region="work"]');
      if (!box) return;
      const count = root.querySelector('[data-put-count]');
      const toPut = d.lines.reduce((n, l) => n + Math.max(l.received_qty - l.putaway_qty, 0), 0);
      if (count) count.textContent = toPut ? `${fmt.int(toPut)} vár` : '';
      if (st.mode === 'receive') {
        box.innerHTML = String(html`
          <ul class="inb-cards">${d.lines.map(receiveCard)}</ul>
          <div class="inb-work__foot"><button class="btn btn--sm" type="button" data-action="add-line">${FL.icon('plus')}Nem várt termék vagy új sarzs</button></div>`);
      } else {
        const open = d.lines.filter((l) => l.received_qty > l.putaway_qty);
        const rest = d.lines.filter((l) => l.received_qty <= l.putaway_qty);
        box.innerHTML = String(html`
          ${putForm()}
          ${open.length ? '' : ui.notice(d.totals.received ? 'Minden átvett áru polcon van. Lezárhatod a betárolást.' : 'Még nincs átvett áru. Előbb számold meg a beérkezett termékeket.', d.totals.received ? 'ok' : 'info')}
          <ul class="inb-cards">${open.map(putCard)}${rest.map(putCard)}</ul>`);
        const loc = box.querySelector('#inb-put-loc');
        if (loc && !loc.disabled) {
          ui.autocomplete(loc, {
            source: async (q) => (await api.get('/api/lookup/locations', { q })).items.filter((x) => ['storage', 'quarantine'].includes(x.kind)),
            label: (x) => x.code,
            sub: (x) => `${FL.state.meta.locationKinds[x.kind] || x.kind}, ${x.size_code}`,
            onSelect: (x) => { st.put.location = { id: x.id, code: x.code }; loc.value = x.code; const qty = box.querySelector('#inb-put-qty'); qty.focus(); qty.select(); },
          });
          loc.addEventListener('input', () => { st.put.location = null; });
        }
      }
    }

    function paintLines() {
      const box = region('lines');
      if (working()) { box.innerHTML = ''; return; }
      box.innerHTML = String(html`<section class="panel panel--flush">
        <div class="panel__head"><h2>Tételek</h2></div>
        ${ui.table({
          caption: 'Tételek',
          cls: 'inb-table',
          rows: d.lines,
          columns: [
            { key: 'sku', label: 'Cikk', render: (l) => html`<span class="mono inb-code">${l.sku}</span><span class="sub">${l.name}</span>` },
            { key: 'lot', label: 'Sarzs, lejárat', render: (l) => html`${l.lot || html`<span class="muted">nincs</span>`}${l.expiry ? html`<span class="sub">${fmt.date(l.expiry)}</span>` : ''}` },
            { key: 'expected_qty', label: 'Várt', align: 'r', cls: 'num', render: (l) => fmt.int(l.expected_qty) },
            { key: 'received_qty', label: 'Átvett', align: 'r', cls: 'num', render: (l) => fmt.int(l.received_qty) },
            { key: 'damaged_qty', label: 'Sérült', align: 'r', cls: 'num', render: (l) => (l.damaged_qty ? html`<span class="diff-neg">${fmt.int(l.damaged_qty)}</span>` : '0') },
            { key: 'putaway_qty', label: 'Polcon', align: 'r', cls: 'num', render: (l) => fmt.int(l.putaway_qty) },
            { key: 'places', label: 'Helyek', render: (l) => (l.putaways.length ? html`<span class="inb-chips">${l.putaways.map((p) => html`<span class="tag">${p.location_code}: ${fmt.int(p.qty)}</span>`)}</span>` : l.suggested ? html`<span class="muted small">javasolt: ${l.suggested.code}</span>` : '') },
            { key: 'issues', label: 'Eltérés', render: (l) => (l.issues.length ? html`<span class="inb-chips">${l.issues.map((i) => chip(i.text, i.kind === 'damaged' ? 'danger' : 'warn'))}</span>` : d.status === 'expected' ? '' : chip('rendben', 'ok')) },
          ],
          footer: html`<tr><td colspan="2">Összesen</td><td class="r num">${fmt.int(d.totals.expected)}</td><td class="r num">${fmt.int(d.totals.received)}</td><td class="r num">${fmt.int(d.totals.damaged)}</td><td class="r num">${fmt.int(d.totals.putaway)}</td><td colspan="2"></td></tr>`,
        })}
      </section>`);
    }

    function paintInfo() {
      const rows = [
        ['Ügyfél', `${d.partner_name} (${d.partner_code})`],
        ['Beszállító', d.supplier_name || 'nincs megadva'],
        ['Külső hivatkozás', d.external_ref || 'nincs'],
        ['Forrás', SOURCES[d.source] || d.source],
        ['Várható érkezés', d.expected_date ? fmt.date(d.expected_date) : 'nincs megadva'],
        ['Megérkezett', d.arrived_at ? fmt.dateTime(d.arrived_at) : 'még nem'],
        ['Raklap, karton', `${fmt.int(d.pallets)} raklap, ${fmt.int(d.cartons)} karton`],
        ['Érkezési megjegyzés', d.arrival_note || 'nincs'],
        ['Megjegyzés', d.note || 'nincs'],
        ['Rögzítette', `${d.created_by_name || 'ismeretlen'}, ${fmt.dateTime(d.created_at)}`],
      ];
      if (d.completed_at) rows.push(['Lezárta', `${d.completed_by_name || 'ismeretlen'}, ${fmt.dateTime(d.completed_at)}`]);
      region('info').innerHTML = String(html`
        <section class="panel"><h2>Adatok</h2><dl class="dl">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl></section>
        <section class="panel"><h2>Előzmények</h2>
          ${d.history.length ? html`<ol class="inb-history">${d.history.map((h) => html`<li><span class="num small muted">${fmt.dateTime(h.at)}</span><span>${h.summary}</span><span class="small muted">${h.actor}</span></li>`)}</ol>` : ui.empty('Még nincs bejegyzés.')}
        </section>`);
    }

    function paintPrint() {
      const me = FL.state.me;
      region('print').innerHTML = String(html`
        <header class="inb-print__head">
          <div><b>${me.company.name}</b><span>Raktár, áruátvétel</span></div>
          <div class="inb-print__title"><h1>Átvételi jegyzőkönyv</h1><span class="mono">${d.number}</span></div>
        </header>
        <dl class="inb-print__dl">
          <dt>Ügyfél</dt><dd>${d.partner_name} (${d.partner_code})</dd>
          <dt>Beszállító</dt><dd>${d.supplier_name || ''}</dd>
          <dt>Külső hivatkozás</dt><dd>${d.external_ref || ''}</dd>
          <dt>Várható érkezés</dt><dd>${d.expected_date ? fmt.date(d.expected_date) : ''}</dd>
          <dt>Megérkezett</dt><dd>${d.arrived_at ? fmt.dateTime(d.arrived_at) : ''}</dd>
          <dt>Lezárva</dt><dd>${d.completed_at ? fmt.dateTime(d.completed_at) : FL.statusLabel('inbound', d.status)}</dd>
          <dt>Raklap, karton</dt><dd>${fmt.int(d.pallets)} raklap, ${fmt.int(d.cartons)} karton</dd>
        </dl>
        <table class="table inb-print__table">
          <thead><tr><th>Cikkszám</th><th>Megnevezés</th><th>Sarzs</th><th>Lejárat</th><th class="r">Várt</th><th class="r">Átvett</th><th class="r">Sérült</th><th class="r">Eltérés</th><th>Polcra</th></tr></thead>
          <tbody>${d.lines.map((l) => html`<tr>
            <td class="mono">${l.sku}</td><td>${l.name}</td><td>${l.lot}</td><td>${l.expiry ? fmt.date(l.expiry) : ''}</td>
            <td class="r num">${fmt.int(l.expected_qty)}</td><td class="r num">${fmt.int(l.received_qty)}</td><td class="r num">${fmt.int(l.damaged_qty)}</td>
            <td class="r num">${l.received_qty - l.expected_qty > 0 ? '+' : ''}${fmt.int(l.received_qty - l.expected_qty)}</td>
            <td>${l.putaways.map((p) => `${p.location_code}: ${p.qty}`).join(', ')}</td></tr>`)}</tbody>
          <tfoot><tr><td colspan="4">Összesen</td><td class="r num">${fmt.int(d.totals.expected)}</td><td class="r num">${fmt.int(d.totals.received)}</td>
            <td class="r num">${fmt.int(d.totals.damaged)}</td><td class="r num">${fmt.int(d.totals.received - d.totals.expected)}</td><td>${fmt.int(d.totals.putaway)} polcon</td></tr></tfoot>
        </table>
        ${d.arrival_note ? html`<p><b>Érkezési megjegyzés:</b> ${d.arrival_note}</p>` : ''}
        ${d.has_discrepancy ? html`<p><b>Eltérés oka:</b> ${d.discrepancy_note}</p>` : ''}
        <div class="inb-print__sign">
          <div><span></span>Átadó (sofőr, beszállító)</div>
          <div><span></span>Átvevő (${me.company.name})</div>
          <div><span></span>Dátum</div>
        </div>
        <p class="small">Nyomtatva: ${fmt.dateTime(new Date().toISOString())}, ${me.user.name}</p>`);
    }

    function paintAll() {
      recalc();
      paintHead();
      paintSummary();
      paintShell();
      paintLines();
      paintInfo();
      paintPrint();
    }

    // After a change on lines only: everything except the scan bar.
    function paintAfterChange() {
      recalc();
      paintHead();
      paintSummary();
      paintWork();
      paintPrint();
    }

    // Fetches the inbound again. While the receiving screen stays open the scan bar is kept.
    async function reload({ keepFocus = true } = {}) {
      const wasWorking = working();
      d = await api.get(`/api/inbound/${id}`);
      if (wasWorking && working()) { paintAfterChange(); paintEntry(); paintInfo(); } else paintAll();
      if (lastFeedback && working()) feedback(lastFeedback.text, lastFeedback.tone);
      if (keepFocus) { if (st.entry) focusQty(); else focusScan(); }
    }

    function mergeLine(line, status) {
      const i = d.lines.findIndex((l) => l.id === line.id);
      if (i >= 0) d.lines[i] = { ...d.lines[i], ...line, suggested: d.lines[i].suggested };
      else d.lines.push({ ...line, suggested: null });
      if (status) d.status = status;
    }

    /* ---------------------------------------------------------- scanning */

    async function onScan(code, at) {
      if (at.mode === 'receive') return scanReceive(code);
      return scanPutaway(code);
    }

    function matchLines(code) {
      const c = code.trim().toUpperCase();
      const numeric = /^\d+$/.test(c);
      return d.lines.filter((l) => l.sku.toUpperCase() === c || (l.ean && (l.ean === c || (numeric && strip0(l.ean) === strip0(c)))));
    }

    // Receiving: a product code opens its quantity entry; a location switches to putaway; a product of
    // the client that is not on the inbound can be added as a new line.
    async function scanReceive(code) {
      const matches = matchLines(code);
      if (matches.length) return productScanned(matches);
      try {
        const r = await api.post(`/api/inbound/${id}/scan`, { code, peek: true });
        if (r.result === 'location') {
          beep('warn');
          st.mode = 'putaway';
          st.entry = null;
          st.put.location = { id: r.location.id, code: r.location.code };
          paintShell();
          feedback(`${r.location.code} raktárhely: átváltottunk polcra helyezésre. Válaszd ki a tételt.`, 'info');
          focusScan();
          return;
        }
        if (r.result === 'match') {
          await reload({ keepFocus: false });
          const l = d.lines.find((x) => x.id === r.line_id);
          if (l) await productScanned([l]);
          return;
        }
        if (r.result === 'unexpected') {
          beep('warn');
          const yes = await ui.confirm({
            title: 'Nem várt termék',
            text: `A(z) ${r.product.sku} ${r.product.name} nem szerepel ebben a betárolásban. Felveszed új tételként?`,
            confirmLabel: 'Felveszem',
          });
          if (!yes) { feedback(`${r.product.sku} nem került rögzítésre.`, 'warn'); focusScan(); return; }
          if (st.entry && Number(st.entry.qty) > 0 && !(await commitEntry())) return;
          const added = await api.post(`/api/inbound/${id}/lines`, { product_id: r.product.id, received_qty: 0 });
          await reload({ keepFocus: false });
          const l = d.lines.find((x) => x.id === added.line.id);
          if (l) openEntry(l, { scanned: true });
          feedback(`${r.product.sku} új tételként felvéve. Írd be a beérkezett mennyiséget.`, 'info');
        }
      } catch (err) {
        beep('error');
        feedback(err.message, 'danger');
        focusScan();
      }
    }

    async function productScanned(matches) {
      const cur = st.entry && d.lines.find((x) => x.id === st.entry.lineId);
      if (cur && matches.some((x) => x.id === cur.id)) {
        // The same product again: one more piece in the typed quantity (counting by scanning).
        st.entry.qty = String((parseInt(st.entry.qty, 10) || 0) + 1);
        paintEntry();
        focusQty();
        beep('ok');
        feedback(`${cur.sku}: ${fmt.int(Number(st.entry.qty))} ${unitOf(cur)} beolvasva. Rögzítsd, vagy írd át a mennyiséget.`, 'ok');
        return;
      }
      // Another product while a quantity is typed: that quantity is recorded first.
      if (cur && Number(st.entry.qty) > 0 && !(await commitEntry())) return;
      const l = matches.find((x) => x.received_qty < x.expected_qty) || matches[matches.length - 1];
      openEntry(l, { scanned: true });
      beep('ok');
      feedback(`${l.sku} ${l.name}${matches.length > 1 ? ' (több sarzs: válaszd ki, melyik)' : ''}: írd be a mennyiséget, vagy olvasd be darabonként.`, 'info');
      const card = root.querySelector(`[data-region="work"] [data-line="${l.id}"]`);
      if (card) card.scrollIntoView({ block: 'nearest' });
    }

    // A scan that went into the quantity field: the code is at the end. Digits typed before it stay;
    // when the scan replaced the selected quantity, the quantity from before the scan counts.
    async function scanInQty(value) {
      const up = value.toUpperCase();
      const codes = d.lines.flatMap((l) => [l.ean, l.sku].filter(Boolean).map((c) => String(c).toUpperCase()));
      const hit = codes.filter((c) => up.endsWith(c)).sort((a, b) => b.length - a.length)[0];
      const typed = hit ? value.slice(0, value.length - hit.length) : '';
      if (st.entry) st.entry.qty = /^\d{1,6}$/.test(typed) ? typed : typed === '' && /^\d{1,6}$/.test(st.entry.qtyAtFocus || '') ? st.entry.qtyAtFocus : '';
      const q = root.querySelector('#inb-entry-qty');
      if (q) q.value = st.entry ? st.entry.qty : '';
      await scanReceive(hit || value);
    }

    // Records the typed quantity on the line (a delta, so two scanners on one inbound add up).
    async function commitEntry() {
      const e = st.entry;
      const l = e && d.lines.find((x) => x.id === e.lineId);
      if (!l) return false;
      const form = root.querySelector('[data-entry-form]');
      const raw = String(e.qty).trim();
      const qty = /^\d{1,6}$/.test(raw) ? parseInt(raw, 10) : NaN;
      const needLot = l.track_lot && !l.lot && l.putaway_qty === 0;
      const needExp = l.track_expiry && !l.expiry && l.putaway_qty === 0;
      const fields = {};
      if (!(qty >= 1 && qty <= 100000)) fields.qty = 'Írd be a beérkezett darabszámot.';
      if (needLot && !e.lot.trim()) fields.lot = 'Add meg a sarzsot.';
      if (needExp && !e.expiry) fields.expiry = 'Add meg a lejáratot.';
      if (Object.keys(fields).length) {
        beep('error');
        if (form) entryErrors(form, fields);
        feedback(`${l.sku}: ${Object.values(fields).join(' ')}`, 'danger');
        return false;
      }
      const total = l.received_qty + qty;
      if (l.expected_qty > 0 && total > l.expected_qty) {
        beep('warn');
        const yes = await ui.confirm({
          title: 'Több a vártnál',
          text: `${l.sku}: a várt ${fmt.int(l.expected_qty)} ${unitOf(l)} helyett összesen ${fmt.int(total)} ${unitOf(l)} lesz átvéve. Rögzíted?`,
          confirmLabel: 'Rögzítem',
        });
        if (!yes) { focusQty(); return false; }
      }
      const body = { add: qty, damaged_add: e.damaged ? qty : 0 };
      if (needLot) body.lot = e.lot.trim();
      if (needExp) body.expiry = e.expiry;
      const btn = form && form.querySelector('[type="submit"]');
      if (btn) btn.setAttribute('aria-busy', 'true');
      try {
        const r = await api.post(`/api/inbound/${id}/lines/${l.id}/receive`, body);
        const wasStatus = d.status;
        mergeLine(r.line, r.status);
        st.entry = null;
        st.activeLine = l.id;
        const after = d.lines.find((x) => x.id === l.id);
        const over = after.received_qty > after.expected_qty;
        beep(over ? 'warn' : 'ok');
        feedback(`${fmt.int(qty)} ${unitOf(l)}${e.damaged ? ' sérült' : ''} rögzítve: ${l.sku} ${l.name}, átvett ${fmt.int(after.received_qty)} / ${fmt.int(after.expected_qty)}${over ? ', több a vártnál' : after.received_qty === after.expected_qty ? ', kész' : ''}.`, over ? 'warn' : 'ok');
        paintEntry();
        paintAfterChange();
        if (wasStatus !== d.status) paintInfo();
        const card = root.querySelector(`[data-region="work"] [data-line="${l.id}"]`);
        if (card) card.scrollIntoView({ block: 'nearest' });
        return true;
      } catch (err) {
        beep('error');
        if (btn) btn.removeAttribute('aria-busy');
        const f = err.fields || {};
        if (form) entryErrors(form, { qty: f.received_qty || f.damaged_qty, lot: f.lot, expiry: f.expiry });
        feedback(err.message, 'danger');
        return false;
      }
    }

    // Marks the entry's fields without a toast: the message is in the feedback line above.
    function entryErrors(form, fields) {
      ui.clearErrors(form);
      let firstEl = null;
      for (const [name, msg] of Object.entries(fields)) {
        const el = msg && form.querySelector(`[name="${name}"]`);
        if (!el) continue;
        el.setAttribute('aria-invalid', 'true');
        const box = el.closest('.field') && el.closest('.field').querySelector('.field__error');
        if (box) { box.hidden = false; box.textContent = msg; }
        firstEl ||= el;
      }
      if (firstEl) firstEl.focus();
    }

    function selectLine(l) {
      const open = l.received_qty - l.putaway_qty;
      const dmg = damagedLeft(l);
      st.put.lineId = l.id;
      st.put.qty = dmg && open > dmg ? open - dmg : open;
      paintWork();
    }

    async function scanPutaway(code) {
      const c = code.trim().toUpperCase();
      const numeric = /^\d+$/.test(c);
      const matches = d.lines.filter((l) => l.sku.toUpperCase() === c || (l.ean && (l.ean === c || (numeric && strip0(l.ean) === strip0(c)))));
      if (matches.length) {
        const open = matches.filter((l) => l.received_qty > l.putaway_qty);
        if (!open.length) { beep('warn'); feedback(`${matches[0].sku}: ebből nincs több polcra helyezendő áru.`, 'warn'); return; }
        const idx = open.findIndex((l) => l.id === st.put.lineId);
        const pick = idx >= 0 ? open[(idx + 1) % open.length] : open[0];
        selectLine(pick);
        beep('ok');
        feedback(`${pick.sku} kiválasztva${pick.lot ? `, sarzs ${pick.lot}` : ''}. Most olvasd be a raktárhelyet.${open.length > 1 ? ' Több sarzs is vár: újabb beolvasással léptetsz.' : ''}`, 'ok');
        focusScan();
        return;
      }
      let loc = null;
      try {
        const res = await api.get('/api/lookup/locations', { q: code.trim() });
        loc = res.items.find((x) => x.code.toUpperCase() === c) || null;
      } catch (err) {
        feedback(err.message, 'danger');
        return;
      }
      if (!loc) { beep('error'); feedback(`Ismeretlen kód: ${code}. Termék vagy raktárhely kódját olvasd be.`, 'danger'); return; }
      if (!['storage', 'quarantine'].includes(loc.kind)) { beep('error'); feedback(`${loc.code} nem tároló- vagy karanténhely.`, 'danger'); return; }
      st.put.location = { id: loc.id, code: loc.code };
      if (!st.put.lineId) {
        paintWork();
        beep('warn');
        feedback(`${loc.code} megjegyezve. Most válaszd ki a tételt (termék beolvasása).`, 'warn');
        focusScan();
        return;
      }
      paintWork();
      beep('ok');
      feedback(`${loc.code}: erősítsd meg a mennyiséget Enterrel.`, 'ok');
      const qty = root.querySelector('#inb-put-qty');
      if (qty) { qty.focus(); qty.select(); }
    }

    async function submitPutaway(form) {
      const l = d.lines.find((x) => x.id === st.put.lineId);
      if (!l) return;
      const code = form.location_code.value.trim();
      const qty = parseInt(form.qty.value, 10);
      const btn = form.querySelector('[type="submit"]');
      await ui.run(btn, async () => {
        try {
          const body = { line_id: l.id, qty: Number.isInteger(qty) ? qty : null };
          if (st.put.location && st.put.location.code.toUpperCase() === code.toUpperCase()) body.location_id = st.put.location.id;
          else body.location_code = code;
          const r = await api.post(`/api/inbound/${id}/putaway`, body);
          mergeLine(r.line);
          const after = d.lines.find((x) => x.id === l.id);
          const left = after.received_qty - after.putaway_qty;
          beep('ok');
          feedback(`${fmt.int(body.qty)} ${unitOf(l)} ${l.sku} polcra: ${r.location.code}.${left ? ` Még ${fmt.int(left)} vár.` : ''}`, 'ok');
          st.put.location = null;
          if (left > 0) { st.put.qty = left; } else { st.put.lineId = null; st.put.qty = ''; }
          paintAfterChange();
          // The suggestions follow what is on the shelves now (room left, the next empty location).
          await reload();
        } catch (err) {
          beep('error');
          feedback(err.message, 'danger');
          focusScan();
        }
      });
    }

    /* ---------------------------------------------------------- dialogs */

    function arriveDialog() {
      const first = d.status === 'expected';
      ui.dialog({
        title: first ? 'Szállítmány megérkezett' : 'Érkezési adatok',
        size: 'narrow',
        submitLabel: first ? 'Megérkezett, kezdjük az átvételt' : 'Mentés',
        body: html`<div class="form-grid">
          ${ui.field({ name: 'pallets', label: 'Raklap', type: 'number', int: true, min: 0, value: d.pallets })}
          ${ui.field({ name: 'cartons', label: 'Karton', type: 'number', int: true, min: 0, value: d.cartons })}
          ${ui.field({ name: 'note', label: 'Érkezési megjegyzés', type: 'textarea', rows: 3, optional: true, value: d.arrival_note, span: 'all', hint: 'Pl. sérült fólia, rendszám, késés oka.' })}
        </div>`,
        onSubmit: async (form) => {
          const v = ui.formValues(form);
          await api.post(`/api/inbound/${id}/arrive`, { pallets: v.pallets ?? 0, cartons: v.cartons ?? 0, note: v.note });
          ui.toast(first ? 'Megérkezett. Kezdheted a számlálást.' : 'Érkezési adatok mentve.', 'ok');
          if (first) st.mode = 'receive';
          await reload();
        },
      }).done.then(focusScan);
    }

    function editLineDialog(l) {
      ui.dialog({
        title: `${l.sku} átvétele`,
        size: 'narrow',
        body: html`
          <p class="muted small">${l.name}. Várt: ${fmt.int(l.expected_qty)} ${unitOf(l)}${l.putaway_qty ? html`, polcon már ${fmt.int(l.putaway_qty)}` : ''}.</p>
          <div class="form-grid">
            ${ui.field({ name: 'received_qty', label: 'Átvett összesen', type: 'number', int: true, min: l.putaway_qty, value: l.received_qty, hint: 'A sérült darabokkal együtt.' })}
            ${ui.field({ name: 'damaged_qty', label: 'Ebből sérült', type: 'number', int: true, min: 0, value: l.damaged_qty })}
            ${l.putaway_qty ? '' : ui.field({ name: 'lot', label: 'Sarzs', type: 'code', value: l.lot, optional: !l.track_lot })}
            ${l.putaway_qty ? '' : ui.field({ name: 'expiry', label: 'Lejárat', type: 'date', value: l.expiry, optional: !l.track_expiry })}
            ${ui.field({ name: 'note', label: 'Megjegyzés', value: l.note, optional: true, span: 'all' })}
          </div>`,
        onSubmit: async (form) => {
          const v = ui.formValues(form);
          const body = { received_qty: v.received_qty ?? 0, damaged_qty: v.damaged_qty ?? 0, note: v.note };
          if (!l.putaway_qty) { body.lot = v.lot.trim(); body.expiry = v.expiry || null; }
          const r = await api.post(`/api/inbound/${id}/lines/${l.id}/receive`, body);
          mergeLine(r.line, r.status);
          st.activeLine = l.id;
          ui.toast('Tétel mentve.', 'ok');
          await reload();
        },
      }).done.then(focusScan);
    }

    function addLineDialog() {
      let picked = null;
      ui.dialog({
        title: 'Nem várt termék vagy új sarzs',
        body: html`
          <p class="muted small">Csak ${d.partner_name} termékei közül választhatsz. Ugyanannak a terméknek egy másik sarzsát is így veheted fel.</p>
          <div class="form-grid">
            <div class="field span-all"><label for="add-prod">Termék</label>
              <input class="input" id="add-prod" name="product" placeholder="Cikkszám, név vagy EAN" autocomplete="off" required aria-describedby="add-prod-err">
              <p class="field__error" id="add-prod-err" hidden></p></div>
            ${ui.field({ name: 'received_qty', label: 'Átvett mennyiség', type: 'number', int: true, min: 0, value: '' })}
            ${ui.field({ name: 'damaged_qty', label: 'Ebből sérült', type: 'number', int: true, min: 0, value: 0 })}
            ${ui.field({ name: 'lot', label: 'Sarzs', type: 'code', optional: true })}
            ${ui.field({ name: 'expiry', label: 'Lejárat', type: 'date', optional: true })}
          </div>`,
        submitLabel: 'Tétel felvétele',
        onOpen: ({ form }) => {
          const input = form.querySelector('#add-prod');
          input.addEventListener('input', () => { picked = null; });
          ui.autocomplete(input, {
            source: ui.sources.products(d.partner_id),
            label: ui.productLabel,
            sub: (p) => (p.ean ? `EAN ${p.ean}` : p.unit),
            onSelect: (p) => { picked = p; input.value = ui.productLabel(p); form.querySelector('[name="received_qty"]').focus(); },
          });
        },
        onSubmit: async (form) => {
          const v = ui.formValues(form);
          const body = { received_qty: v.received_qty ?? 0, damaged_qty: v.damaged_qty ?? 0, lot: v.lot.trim(), expiry: v.expiry || null };
          if (picked) body.product_id = picked.id;
          else body.code = String(v.product || '').trim().split(/\s+/)[0];
          try {
            const r = await api.post(`/api/inbound/${id}/lines`, body);
            st.activeLine = r.line.id;
          } catch (err) {
            if (err.fields && err.fields.product_id) err.fields.product = err.fields.product_id;
            throw err;
          }
          ui.toast('Tétel felvéve.', 'ok');
          await reload();
        },
      }).done.then(focusScan);
    }

    function completeDialog() {
      const issues = d.lines.filter(hasDiscrepancy);
      const canApprove = FL.can('inbound', 'approve');
      ui.dialog({
        title: `${d.number} lezárása`,
        size: issues.length ? 'wide' : 'narrow',
        submitLabel: issues.length ? 'Lezárás eltéréssel' : 'Lezárás',
        hideSubmit: issues.length > 0 && !canApprove,
        body: issues.length ? html`
          ${ui.notice('A betárolásban eltérés van. Lezárás után a polcra nem helyezett darabok nem kerülnek készletre, és az eltérés a jegyzőkönyvön is szerepel.', 'warn')}
          ${ui.table({
            caption: 'Eltérések',
            rows: issues,
            columns: [
              { key: 'sku', label: 'Cikk', render: (l) => html`<span class="mono">${l.sku}</span><span class="sub">${l.name}</span>` },
              { key: 'expected_qty', label: 'Várt', align: 'r', cls: 'num', render: (l) => fmt.int(l.expected_qty) },
              { key: 'received_qty', label: 'Átvett', align: 'r', cls: 'num', render: (l) => fmt.int(l.received_qty) },
              { key: 'damaged_qty', label: 'Sérült', align: 'r', cls: 'num', render: (l) => fmt.int(l.damaged_qty) },
              { key: 'putaway_qty', label: 'Polcon', align: 'r', cls: 'num', render: (l) => fmt.int(l.putaway_qty) },
              { key: 'what', label: 'Eltérés', render: (l) => [...l.issues.map((i) => i.text), ...(l.putaway_qty < l.received_qty ? [`polcra nem került ${l.received_qty - l.putaway_qty}`] : [])].join(', ') },
            ],
          })}
          ${canApprove
            ? ui.field({ name: 'note', label: 'Az eltérés oka', type: 'textarea', rows: 3, required: true, hint: 'Pl. a beszállító kevesebbet hozott, a sérült zsákot visszaküldtük.' })
            : ui.notice('Eltéréssel csak jóváhagyási joggal zárhatod le. Kérd meg a raktárvezetőt, vagy rögzítsd a hiányzó darabokat.', 'danger')}`
          : html`<p>Minden tétel rendben: a várt mennyiség megérkezett, és minden darab polcra került. Lezárod?</p>`,
        onSubmit: async (form) => {
          const v = ui.formValues(form);
          const r = await api.post(`/api/inbound/${id}/complete`, { note: v.note || '' });
          ui.toast(r.has_discrepancy ? 'Lezárva eltéréssel.' : 'Betárolás lezárva.', 'ok');
          await reload({ keepFocus: false });
        },
      });
    }

    function cancelDialog() {
      ui.dialog({
        title: `${d.number} sztornózása`,
        size: 'narrow',
        submitLabel: 'Sztornózás',
        submitTone: 'danger',
        body: html`<p>A betárolás sztornózott állapotba kerül, és nem lehet rá több árut átvenni. Készletmozgás nem keletkezik.</p>
          ${ui.field({ name: 'reason', label: 'Indoklás', optional: true })}`,
        onSubmit: async (form) => {
          await api.post(`/api/inbound/${id}/cancel`, { reason: ui.formValues(form).reason });
          ui.toast('Betárolás sztornózva.', 'ok');
          await reload({ keepFocus: false });
        },
      });
    }

    async function saveTrack(el) {
      const l = d.lines.find((x) => x.id === Number(el.dataset.id));
      if (!l) return;
      const field = el.dataset.field;
      const value = field === 'lot' ? el.value.trim() : el.value || null;
      if ((l[field] || '') === (value || '')) return;
      try {
        const r = await api.post(`/api/inbound/${id}/lines/${l.id}/receive`, { [field]: value });
        mergeLine(r.line, r.status);
        feedback(`${l.sku}: ${field === 'lot' ? `sarzs ${value || 'törölve'}` : `lejárat ${value ? fmt.date(value) : 'törölve'}`} mentve.`, 'ok');
        paintAfterChange();
        const next = field === 'lot' && l.track_expiry && !r.line.expiry ? root.querySelector(`[data-action="track"][data-field="expiry"][data-id="${l.id}"]`) : null;
        if (next) next.focus(); else focusScan();
      } catch (err) {
        beep('error');
        feedback(err.message, 'danger');
        el.setAttribute('aria-invalid', 'true');
      }
    }

    /* ---------------------------------------------------------- events (bound once) */

    ui.bind(root, {
      print: () => window.print(),
      edit: () => inboundForm(d),
      cancel: cancelDialog,
      arrive: arriveDialog,
      complete: completeDialog,
      mode: async (el) => {
        if (st.mode === el.dataset.mode) return;
        st.mode = el.dataset.mode;
        paintShell();
        focusScan();
        // Received quantities changed the suggestions (they depend on how much is to be put away).
        if (st.mode === 'putaway') await reload();
      },
      entry: async (el) => {
        const l = d.lines.find((x) => x.id === Number(el.dataset.id));
        if (!l) return;
        if (st.entry && st.entry.lineId !== l.id && Number(st.entry.qty) > 0 && !(await commitEntry())) return;
        openEntry(l);
        feedback(`${l.sku} ${l.name}: írd be a beérkezett mennyiséget.`, 'info');
        const zone = root.querySelector('.inb-scanzone');
        if (zone) zone.scrollIntoView({ block: 'nearest' });
      },
      'entry-cancel': () => {
        st.entry = null;
        paintEntry();
        paintWork();
        feedback('Mennyiség beírása megszakítva, semmi sem került rögzítésre.', 'info');
        focusScan();
      },
      'entry-line': (el) => {
        const l = d.lines.find((x) => x.id === Number(el.value));
        if (!l || !st.entry) return;
        st.entry = { ...st.entry, lineId: l.id, lot: '', expiry: '' };
        st.activeLine = l.id;
        paintEntry();
        paintWork();
        focusQty();
      },
      'edit-line': (el) => editLineDialog(d.lines.find((l) => l.id === Number(el.dataset.id))),
      'delete-line': async (el) => {
        const l = d.lines.find((x) => x.id === Number(el.dataset.id));
        if (!(await ui.confirm({ title: 'Tétel törlése', text: `Törlöd a(z) ${l.sku} tételt (${l.received_qty} db átvéve)?`, confirmLabel: 'Törlés', tone: 'danger' }))) return;
        await ui.run(null, async () => {
          await api.del(`/api/inbound/${id}/lines/${l.id}`);
          ui.toast('Tétel törölve.', 'ok');
          await reload();
        });
      },
      'add-line': addLineDialog,
      track: (el) => saveTrack(el),
      'select-line': (el) => {
        const l = d.lines.find((x) => x.id === Number(el.dataset.id));
        selectLine(l);
        feedback(`${l.sku} kiválasztva. Olvasd be vagy írd be a raktárhelyet.`, 'ok');
        focusScan();
      },
      'use-loc': (el) => {
        st.put.location = { id: Number(el.dataset.id), code: el.dataset.code };
        paintWork();
        const qty = root.querySelector('#inb-put-qty');
        if (qty) { qty.focus(); qty.select(); }
      },
      'use-quarantine': () => {
        const l = d.lines.find((x) => x.id === st.put.lineId);
        st.put.location = { id: d.quarantine.id, code: d.quarantine.code };
        st.put.qty = Math.min(damagedLeft(l), l.received_qty - l.putaway_qty);
        paintWork();
        const qty = root.querySelector('#inb-put-qty');
        if (qty) { qty.focus(); qty.select(); }
      },
    });
    root.addEventListener('submit', (e) => {
      const entryForm = e.target.closest('[data-entry-form]');
      if (entryForm) {
        e.preventDefault();
        const value = entryForm.qty.value.trim();
        queue = queue.then(async () => {
          if (value && !/^\d{1,6}$/.test(value)) { await scanInQty(value); return; }
          if (st.entry) st.entry.qty = value;
          if (await commitEntry()) focusScan();
        }).catch(() => {});
        return;
      }
      const form = e.target.closest('[data-put-form]');
      if (!form) return;
      e.preventDefault();
      submitPutaway(form);
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('[data-action="track"][data-field="lot"]')) {
        e.preventDefault();
        e.target.blur();
      }
    });
    root.addEventListener('input', (e) => {
      if (e.target.matches('#inb-put-qty')) st.put.qty = e.target.value;
      if (!st.entry || !e.target.closest('[data-entry-form]')) return;
      // A scanner typing into the quantity field is not a quantity (see scanInQty).
      if (e.target.name === 'qty' && /^\d{0,6}$/.test(e.target.value.trim())) st.entry.qty = e.target.value.trim();
      if (['lot', 'expiry'].includes(e.target.name)) st.entry[e.target.name] = e.target.value;
    });
    root.addEventListener('focusin', (e) => {
      if (st.entry && e.target.matches('#inb-entry-qty')) st.entry.qtyAtFocus = e.target.value.trim();
    });
    root.addEventListener('change', (e) => {
      if (st.entry && e.target.closest('[data-entry-form]') && e.target.name === 'damaged') st.entry.damaged = e.target.checked;
      if (st.entry && e.target.closest('[data-entry-form]') && e.target.name === 'expiry') st.entry.expiry = e.target.value;
    });

    paintAll();
    // The shell focuses the content after render; the scanner input wins on a warehouse screen.
    if (working()) setTimeout(focusScan, 0);
    return null;
  }
})();
