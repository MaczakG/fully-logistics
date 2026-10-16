/* Fuvarszervezés (#/fuvarszervezes): carrier pickups and pallet or truck transports.
     #/fuvarszervezes?date=YYYY-MM-DD   Futárátvételek: day board per carrier (default: today in Budapest)
     #/fuvarszervezes/atvetel/:id       one pickup: manifest, scanning parcels, waiting orders, close, print
     #/fuvarszervezes/fuvarok           Raklapos fuvarok: list with filters
     #/fuvarszervezes/fuvarok/:id       the list with the transport's dialog open */
(() => {
  'use strict';
  const FL = window.FL;
  const { html, raw, ui, api, fmt } = FL;

  const ROOT = '#/fuvarszervezes';
  const OPEN = ['planned', 'arrived'];
  const DIRECTIONS = { out: 'Kimenő', in: 'Beérkező' };
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
  const windowText = (a, b) => (a || b ? `${a || '?'}-${b || '?'}` : '');

  // COD totals come per currency: { HUF: 12990, EUR: 40 }.
  const codText = (cod) => {
    const parts = Object.entries(cod || {}).filter(([, v]) => v).map(([cur, v]) => (cur === 'HUF' ? fmt.money(v) : `${fmt.num(v, 2)} ${cur}`));
    return parts.length ? parts.join(' + ') : fmt.money(0);
  };
  const carrierLabel = (code) => (code && FL.state.meta.carriers[code]) || '';

  const tabs = (active) => ui.tabs([
    { key: 'pickups', label: 'Futárátvételek', href: ROOT, icon: 'package' },
    { key: 'transports', label: 'Raklapos fuvarok', href: `${ROOT}/fuvarok`, icon: 'truck' },
  ], active, 'Fuvarszervezés nézetei');

  /* ------------------------------------------------------------ pickup dialog */
  async function pickupDialog({ pickup = null, carrierId = '', date = FL.today() } = {}) {
    const carriers = pickup ? [] : await ui.partnerOptions('carrier');
    if (!pickup && !carriers.length) {
      ui.toast('Nincs aktív fuvarozó partner. Vedd fel a Partnerek között.', 'error');
      return;
    }
    ui.dialog({
      title: pickup ? `${pickup.number} módosítása` : 'Új futárátvétel',
      submitLabel: pickup ? 'Mentés' : 'Átvétel felvétele',
      body: html`<div class="form-grid">
        ${pickup ? html`<p class="span-all">Fuvarozó: <b>${pickup.carrier_name}</b></p>`
        : ui.field({ name: 'carrier_id', label: 'Fuvarozó', type: 'select', options: carriers, value: carrierId, placeholder: 'Válassz fuvarozót', required: true, span: 'all' })}
        ${ui.field({ name: 'date', label: 'Nap', type: 'date', value: pickup ? pickup.date : date, required: true, min: FL.today() })}
        ${ui.field({ name: 'window_from', label: 'Időablak eleje', type: 'time', value: pickup ? pickup.window_from : '', optional: true })}
        ${ui.field({ name: 'window_to', label: 'Időablak vége', type: 'time', value: pickup ? pickup.window_to : '', optional: true })}
        ${ui.field({ name: 'note', label: 'Megjegyzés', type: 'textarea', rows: 2, value: pickup ? pickup.note : '', optional: true, span: 'all' })}
      </div>`,
      onSubmit: async (form) => {
        const v = ui.formValues(form);
        if (pickup) {
          await api.patch(`/api/transport/pickups/${pickup.id}`, v);
          ui.toast('Futárátvétel mentve.', 'ok');
          FL.reload();
          return;
        }
        const res = await api.post('/api/transport/pickups', { ...v, carrier_id: Number(v.carrier_id) || null });
        ui.toast(`${res.number} felvéve.`, 'ok');
        FL.go(`${ROOT}/atvetel/${res.id}`);
      },
    });
  }

  /* ------------------------------------------------------------ day board */
  async function renderBoard(root, ctx) {
    const date = isDate(ctx.query.get('date')) ? ctx.query.get('date') : FL.today();
    const b = await api.get('/api/transport/board', { date });
    const canCreate = FL.can('transport', 'create');
    const canEdit = FL.can('transport', 'edit');
    const t = b.totals;

    const card = (c) => {
      const active = c.waiting.orders || c.pickups.length;
      return html`<article class="panel tr-card" data-active="${active ? 'true' : 'false'}" aria-labelledby="tr-c-${c.id}">
        <div class="panel__head">
          <h2 id="tr-c-${c.id}">${c.name}</h2>
          ${carrierLabel(c.carrier_code) ? html`<span class="tag">${carrierLabel(c.carrier_code)}</span>` : ''}
        </div>
        <dl class="tr-stats">
          <div><dt>Feladásra vár</dt><dd class="num">${fmt.int(c.waiting.orders)}</dd>
            <dd class="small muted">${c.waiting.orders ? `${fmt.int(c.waiting.packages)} csomag${c.waiting.cod_orders ? `, utánvét ${codText(c.waiting.cod)}` : ''}` : 'nincs'}</dd></div>
          <div><dt>Hozzárendelve</dt><dd class="num">${fmt.int(c.assigned.orders)}</dd>
            <dd class="small muted">${c.assigned.orders ? `${fmt.int(c.assigned.packages)} csomag` : 'erre a napra'}</dd></div>
          <div><dt>Utánvét</dt><dd class="num">${codText(c.assigned.cod)}</dd><dd class="small muted">${fmt.int(c.assigned.cod_orders)} utánvétes</dd></div>
        </dl>
        ${c.pickups.length ? html`<ul class="tr-pickups">${c.pickups.map((p) => html`<li>
          <div class="tr-pickups__main">
            <a class="num" href="${ROOT}/atvetel/${p.id}">${p.number}</a> ${FL.status('pickup', p.status)}
            <span class="small muted">${windowText(p.window_from, p.window_to) || 'nincs időablak'} · ${fmt.int(p.totals.orders)} rendelés${p.manifest_number && p.manifest_number !== p.number ? ` · ${p.manifest_number}` : ''}</span>
          </div>
          <div class="actions">
            ${OPEN.includes(p.status) && canEdit && c.waiting.orders ? html`<button class="btn btn--sm" type="button" data-action="assign-all" data-id="${p.id}" data-n="${c.waiting.orders}">${FL.icon('plus')}Mind hozzá (${fmt.int(c.waiting.orders)})</button>` : ''}
            <a class="btn btn--sm" href="${ROOT}/atvetel/${p.id}">${OPEN.includes(p.status) ? 'Manifeszt' : 'Megnyitás'}</a>
          </div>
        </li>`)}</ul>` : html`<p class="small muted">Erre a napra nincs futárátvétel.</p>`}
        ${canCreate && c.status === 'active' ? html`<div class="actions"><button class="btn btn--sm" type="button" data-action="new" data-carrier="${c.id}">${FL.icon('plus-circle')}Átvétel felvétele</button></div>` : ''}
      </article>`;
    };

    root.innerHTML = String(html`
      ${ui.pageHead({
        title: 'Fuvarszervezés',
        lead: 'Napi futárátvételek fuvarozónként: a feladásra kész csomagok manifesztre kerülnek, a lezárással feladjuk őket.',
        actions: canCreate ? html`<button class="btn btn--primary" type="button" data-action="new">${FL.icon('plus')}Új futárátvétel</button>` : '',
      })}
      ${tabs('pickups')}
      <div class="toolbar tr-daybar">
        <button class="btn btn--icon" type="button" data-action="day" data-delta="-1" aria-label="Előző nap">${FL.icon('caret-left')}</button>
        <div class="field"><label for="tr-date">Nap</label><input class="input" id="tr-date" type="date" value="${date}"></div>
        <button class="btn btn--icon" type="button" data-action="day" data-delta="1" aria-label="Következő nap">${FL.icon('caret-right')}</button>
        <button class="btn" type="button" data-action="today" ${date === b.today ? raw('disabled') : ''}>Ma</button>
        <p class="tr-daylabel">${fmt.dateLong(date)}${date === b.today ? ', ma' : ''}</p>
      </div>
      ${ui.kpis([
        { label: 'Feladásra vár', value: fmt.int(t.waiting.orders), hint: `${fmt.int(t.waiting.packages)} csomag, minden fuvarozó`, tone: t.waiting.orders ? 'warn' : '' },
        { label: 'Hozzárendelve', value: fmt.int(t.assigned.orders), hint: `${fmt.int(t.assigned.packages)} csomag erre a napra` },
        { label: 'Átvételek', value: fmt.int(t.pickups), hint: 'erre a napra' },
        { label: 'Utánvét', value: codText(t.assigned.cod), hint: `${fmt.int(t.assigned.cod_orders)} utánvétes rendelés` },
      ])}
      ${b.no_carrier.orders ? ui.notice(`${fmt.int(b.no_carrier.orders)} feladásra kész rendelésnek nincs fuvarozója, ezért egyik átvételhez sem rendelhető. Állítsd be a fuvarozót a Megrendeléseknél.`, 'warn') : ''}
      ${b.carriers.length ? html`<div class="grid-3 tr-cards">${b.carriers.map(card)}</div>`
      : ui.empty('Még nincs fuvarozó partner. Vedd fel a Partnerek között (típus: fuvarozó).', 'truck')}`);

    const goDay = (d) => FL.go(`${ROOT}${d === FL.today() ? '' : FL.qs({ date: d })}`);
    root.querySelector('#tr-date').addEventListener('change', (e) => { if (isDate(e.target.value)) goDay(e.target.value); });
    ui.bind(root, {
      day: (el) => goDay(FL.addDays(date, Number(el.dataset.delta))),
      today: () => goDay(FL.today()),
      new: (el) => ui.run(el, () => pickupDialog({ carrierId: el.dataset.carrier || '', date: date < b.today ? b.today : date })),
      'assign-all': (el) => ui.run(el, async () => {
        const res = await api.post(`/api/transport/pickups/${el.dataset.id}/orders`, { all: true });
        ui.toast(`${fmt.int(res.assigned)} rendelés a(z) ${res.pickup.number} átvételhez rendelve.`, 'ok');
        FL.reload();
      }),
    });
  }

  /* ------------------------------------------------------------ one pickup: manifest */
  async function renderPickup(root, id) {
    let p = await api.get(`/api/transport/pickups/${id}`);
    const selected = new Set();
    let feedback = null;
    const canEdit = FL.can('transport', 'edit');

    const orderColumns = (withRemove) => [
      { key: 'i', label: '#', align: 'r', cls: 'num', render: (o) => String(p.orders.indexOf(o) + 1) },
      { key: 'number', label: 'Rendelés', render: (o) => html`<span class="num">${o.number}</span>${o.external_number ? html`<span class="sub">${o.external_number}</span>` : ''}` },
      { key: 'partner_name', label: 'Ügyfél', render: (o) => html`${o.partner_code}<span class="sub">${o.partner_name}</span>` },
      { key: 'customer_name', label: 'Címzett', render: (o) => html`${o.customer_name}${o.company ? `, ${o.company}` : ''}<span class="sub">${o.pickup_point_id ? `Átvételi pont: ${o.pickup_point_id}` : `${o.zip} ${o.city}`}</span>` },
      { key: 'tracking_number', label: 'Nyomkövetési szám', render: (o) => (o.tracking_number ? html`<span class="num">${o.tracking_number}</span>` : html`<span class="chip" data-tone="warn">nincs</span>`) },
      { key: 'package_count', label: 'Csomag', align: 'r', cls: 'num', render: (o) => fmt.int(o.package_count) },
      { key: 'weight_kg', label: 'Súly', align: 'r', cls: 'num', render: (o) => fmt.kg(o.weight_kg) },
      { key: 'cod_amount', label: 'Utánvét', align: 'r', cls: 'num', render: (o) => (o.cod_amount ? codText({ [o.currency]: o.cod_amount }) : '') },
      ...(withRemove ? [{ key: 'x', label: '', cls: 'no-print', render: (o) => html`${['packed', 'shipped'].includes(o.status) ? '' : html`${FL.status('order', o.status)} `}<button class="btn btn--ghost btn--icon btn--sm" type="button" data-action="remove" data-id="${o.id}" data-number="${o.number}" aria-label="${o.number} levétele a manifesztről">${FL.icon('x')}</button>`,
      }] : []),
    ];

    const waitingColumns = [
      { key: 'number', label: 'Rendelés', render: (o) => html`<span class="num">${o.number}</span>${o.external_number ? html`<span class="sub">${o.external_number}</span>` : ''}` },
      { key: 'partner_code', label: 'Ügyfél' },
      { key: 'customer_name', label: 'Címzett', render: (o) => html`${o.customer_name}<span class="sub">${o.zip} ${o.city}</span>` },
      { key: 'tracking_number', label: 'Nyomkövetési szám', render: (o) => (o.tracking_number ? html`<span class="num">${o.tracking_number}</span>` : html`<span class="muted">nincs</span>`) },
      { key: 'package_count', label: 'Csomag', align: 'r', cls: 'num', render: (o) => fmt.int(o.package_count) },
      { key: 'cod_amount', label: 'Utánvét', align: 'r', cls: 'num', render: (o) => (o.cod_amount ? codText({ [o.currency]: o.cod_amount }) : '') },
      { key: 'packed_at', label: 'Csomagolva', render: (o) => (o.packed_at ? fmt.dateTime(o.packed_at) : '') },
    ];

    const paint = () => {
      const open = OPEN.includes(p.status);
      const editable = open && canEdit;
      const tt = p.totals;
      const win = windowText(p.window_from, p.window_to);
      const closeAllowed = open && FL.can('transport', 'approve') && p.orders.length;
      root.innerHTML = String(html`
        <div class="no-print">${ui.pageHead({
          crumb: { href: `${ROOT}${p.date === FL.today() ? '' : FL.qs({ date: p.date })}`, label: 'Futárátvételek' },
          title: html`${p.number} ${FL.status('pickup', p.status)}`,
          lead: `${p.carrier_name}, ${fmt.dateLong(p.date)}${win ? `, ${win}` : ''}`,
          actions: html`
            ${p.status === 'planned' && canEdit ? html`<button class="btn" type="button" data-action="arrived">${FL.icon('truck')}Futár megérkezett</button>` : ''}
            ${editable ? html`<button class="btn" type="button" data-action="edit">${FL.icon('pencil-simple')}Módosítás</button>` : ''}
            <button class="btn" type="button" data-action="print">${FL.icon('printer')}Nyomtatás</button>
            <button class="btn" type="button" data-action="csv">${FL.icon('download-simple')}CSV</button>
            ${p.status === 'planned' && FL.can('transport', 'delete') ? html`<button class="btn btn--danger" type="button" data-action="cancel">${FL.icon('trash')}Törlés</button>` : ''}
            ${closeAllowed ? html`<button class="btn btn--primary" type="button" data-action="close">${FL.icon('seal-check')}Manifeszt lezárása</button>` : ''}`,
        })}</div>
        <header class="tr-print-head">
          <div><p class="small">${p.company.name} · ${[p.company.zip, p.company.city, p.company.address].filter(Boolean).join(' ')}</p>
            <h2>Átadás-átvételi manifeszt</h2></div>
          <dl class="dl small">
            <dt>Manifesztszám</dt><dd class="num">${p.manifest_number || p.number}</dd>
            <dt>Fuvarozó</dt><dd>${p.carrier_name}</dd>
            <dt>Átvétel napja</dt><dd>${fmt.date(p.date)}${win ? `, ${win}` : ''}</dd>
          </dl>
        </header>
        ${ui.kpis([
          { label: 'Rendelés', value: fmt.int(tt.orders) },
          { label: 'Csomag', value: fmt.int(tt.packages) },
          { label: 'Súly', value: fmt.kg(tt.weight_kg) || '0 kg' },
          { label: 'Utánvét', value: codText(tt.cod), hint: `${fmt.int(tt.cod_orders)} utánvétes` },
        ])}
        <div class="no-print tr-notices">
          ${p.problems.not_packed.length ? ui.notice(`Nem feladásra kész rendelés a manifeszten: ${p.problems.not_packed.join(', ')}. Vedd le őket, különben a manifeszt nem zárható le.`, 'danger') : ''}
          ${open && p.problems.no_tracking ? ui.notice(`${fmt.int(p.problems.no_tracking)} rendelésnek nincs nyomkövetési száma. Lezárható így is, de a webshop nem kap követési linket.`, 'warn') : ''}
          ${p.status === 'closed' ? ui.notice(`Lezárva ${fmt.dateTime(p.closed_at)}${p.closed_by_name ? `, ${p.closed_by_name}` : ''}, manifesztszám: ${p.manifest_number || p.number}. A rendelések feladva, a nyomkövetési számokat visszaküldjük a webshopoknak.`, 'ok') : ''}
          ${p.status === 'arrived' ? ui.notice(`A futár ${fmt.time(p.arrived_at)} óta a rámpán. Olvasd be az átadott csomagokat, majd zárd le a manifesztet.`, 'info') : ''}
          ${p.note ? ui.notice(p.note, 'info') : ''}
        </div>
        ${editable ? html`<div class="no-print tr-scan">
          ${ui.scan({ id: 'tr-scan', label: 'Csomag beolvasása', placeholder: 'Csomagcímke vagy rendelésszám' })}
          <p class="tr-feedback" role="status" aria-live="polite" data-tone="${feedback ? feedback.tone : ''}">${feedback ? feedback.text : ''}</p>
        </div>` : ''}
        <section class="panel panel--flush tr-manifest" aria-labelledby="tr-man-title">
          <div class="panel__head"><h2 id="tr-man-title">Manifeszt</h2><span class="small muted">${fmt.int(p.orders.length)} rendelés</span></div>
          ${ui.table({
            caption: 'Manifeszt rendelései',
            rows: p.orders,
            empty: editable ? 'Még nincs rendelés a manifeszten. Olvasd be a csomagokat, vagy add hozzá a várakozókat lent.' : 'Nincs rendelés a manifeszten.',
            columns: orderColumns(editable),
            footer: p.orders.length ? html`<tr><td colspan="5">Összesen</td><td class="r num">${fmt.int(tt.packages)}</td><td class="r num">${fmt.kg(tt.weight_kg)}</td><td class="r num">${codText(tt.cod)}</td>${editable ? html`<td class="no-print"></td>` : ''}</tr>` : '',
          })}
        </section>
        <footer class="tr-sign">
          <div><p class="small muted">Átadó (Fully Logistics)</p><p>Név: <span></span></p><p>Aláírás: <span></span></p></div>
          <div><p class="small muted">Átvevő (futár, ${p.carrier_name})</p><p>Név: <span></span></p><p>Aláírás: <span></span></p></div>
          <div><p class="small muted">Időpont</p><p><span></span></p></div>
        </footer>
        ${editable && p.waiting.length ? html`<section class="panel panel--flush no-print" aria-labelledby="tr-wait-title">
          <div class="panel__head"><div><h2 id="tr-wait-title">Feladásra vár</h2>
            <p class="small muted">${fmt.int(p.waiting.length)} csomagolt ${p.carrier_short} rendelés, még nincs átvételen</p></div>
            <div class="actions">
              <button class="btn btn--sm" type="button" data-action="add-selected" ${selected.size ? '' : raw('disabled')}>${FL.icon('plus')}Kijelöltek hozzáadása${selected.size ? ` (${selected.size})` : ''}</button>
              <button class="btn btn--sm" type="button" data-action="add-all">${FL.icon('plus-circle')}Mind hozzáadása (${fmt.int(p.waiting.length)})</button>
            </div></div>
          ${ui.table({ caption: 'Feladásra váró rendelések', rows: p.waiting, columns: waitingColumns, selectable: true, selected })}
        </section>` : ''}`);
      const scan = ui.bindScan(root, 'tr-scan', onScan);
      if (scan && (feedback || document.activeElement === document.body)) scan.focus({ preventScroll: true });
    };

    async function onScan(code) {
      try {
        const res = await api.post(`/api/transport/pickups/${p.id}/scan`, { code });
        p = res.pickup;
        selected.delete(res.order.id);
        feedback = { tone: res.already ? 'info' : 'ok', text: res.message };
      } catch (err) {
        feedback = { tone: 'danger', text: err.message };
        if (navigator.vibrate) { try { navigator.vibrate([80, 60, 80]); } catch { /* ignore */ } }
      }
      paint();
    }

    // Ticks in the waiting table: update the rows and the button without repainting (keeps focus).
    const showSelection = () => {
      const b = root.querySelector('[data-action="add-selected"]');
      if (b) {
        b.disabled = !selected.size;
        b.innerHTML = String(html`${FL.icon('plus')}Kijelöltek hozzáadása${selected.size ? ` (${selected.size})` : ''}`);
      }
      root.querySelectorAll('[data-action="select-row"]').forEach((cb) => {
        cb.checked = selected.has(Number(cb.dataset.id));
        if (cb.checked) cb.closest('tr').dataset.selected = 'true'; else cb.closest('tr').removeAttribute('data-selected');
      });
      const all = root.querySelector('[data-action="select-all"]');
      if (all) all.checked = p.waiting.length > 0 && p.waiting.every((o) => selected.has(o.id));
    };
    const assigned = (res) => {
      p = res.pickup;
      selected.clear();
      feedback = { tone: 'ok', text: `${fmt.int(res.assigned)} rendelés hozzáadva a manifeszthez.` };
      paint();
    };

    paint();
    setTimeout(() => { const s = root.querySelector('#tr-scan'); if (s && root.isConnected) s.focus({ preventScroll: true }); }, 0);
    ui.bind(root, {
      'select-row': (el) => { const oid = Number(el.dataset.id); if (el.checked) selected.add(oid); else selected.delete(oid); showSelection(); },
      'select-all': (el) => { for (const o of p.waiting) { if (el.checked) selected.add(o.id); else selected.delete(o.id); } showSelection(); },
      'add-selected': (el) => ui.run(el, async () => assigned(await api.post(`/api/transport/pickups/${p.id}/orders`, { order_ids: [...selected] }))),
      'add-all': (el) => ui.run(el, async () => assigned(await api.post(`/api/transport/pickups/${p.id}/orders`, { all: true }))),
      remove: (el) => ui.run(el, async () => {
        p = await api.del(`/api/transport/pickups/${p.id}/orders/${el.dataset.id}`);
        feedback = { tone: 'info', text: `${el.dataset.number} levéve a manifesztről.` };
        paint();
      }),
      arrived: (el) => ui.run(el, async () => {
        p = await api.post(`/api/transport/pickups/${p.id}/arrived`);
        ui.toast('A futár megérkezett.', 'ok');
        paint();
      }),
      edit: () => pickupDialog({ pickup: p }),
      print: () => window.print(),
      csv: (el) => ui.run(el, () => api.download(`/api/transport/pickups/${p.id}/manifest.csv`)),
      cancel: async (el) => {
        if (!(await ui.confirm({ title: 'Futárátvétel törlése', text: `Törlöd a(z) ${p.number} átvételt? A ${fmt.int(p.orders.length)} rendelése újra feladásra vár.`, confirmLabel: 'Törlés', tone: 'danger' }))) return;
        await ui.run(el, async () => {
          await api.del(`/api/transport/pickups/${p.id}`);
          ui.toast(`${p.number} törölve.`, 'ok');
          FL.go(`${ROOT}${p.date === FL.today() ? '' : FL.qs({ date: p.date })}`);
        });
      },
      close: () => {
        const tt = p.totals;
        ui.dialog({
          title: 'Manifeszt lezárása',
          submitLabel: 'Lezárás és feladás',
          size: 'narrow',
          body: html`
            <p><b>${fmt.int(tt.orders)} rendelés</b>, ${fmt.int(tt.packages)} csomag${tt.weight_kg ? `, ${fmt.kg(tt.weight_kg)}` : ''}, utánvét ${codText(tt.cod)} megy át a(z) ${p.carrier_name} futárnak.</p>
            <p class="small muted">A rendelések állapota Feladva lesz, a webshopok megkapják a nyomkövetési számokat. Ez nem vonható vissza.</p>
            ${p.problems.no_tracking ? ui.notice(`${fmt.int(p.problems.no_tracking)} rendelésnek nincs nyomkövetési száma.`, 'warn') : ''}
            ${ui.field({ name: 'manifest_number', label: 'A fuvarozó manifesztszáma', optional: true, hint: `Ha üresen hagyod, az átvétel száma lesz: ${p.number}.` })}`,
          onSubmit: async (form) => {
            const body = ui.formValues(form);
            let res;
            do {
              res = await api.post(`/api/transport/pickups/${p.id}/close`, body);
              if (!res.done) ui.toast(`Feladás folyamatban, még ${fmt.int(res.remaining)} rendelés...`, 'info');
            } while (!res.done);
            ui.toast(`${p.number} lezárva: ${fmt.int(res.shipped)} rendelés feladva.`, 'ok');
            p = await api.get(`/api/transport/pickups/${p.id}`);
            paint();
          },
        });
      },
    });
  }

  /* ------------------------------------------------------------ transports */
  const STATUS_FILTER = [['active', 'Aktív'], ['all', 'Mind'], ['requested', 'Ajánlatkérés'], ['booked', 'Lefoglalva'], ['in_transit', 'Úton'], ['delivered', 'Leszállítva'], ['cancelled', 'Törölve']];
  const NEXT = { requested: ['booked'], booked: ['in_transit', 'requested'], in_transit: ['delivered', 'booked'], delivered: [], cancelled: [] };
  const NEXT_LABEL = { booked: 'Lefoglalva', in_transit: 'Úton van', delivered: 'Leszállítva', requested: 'Vissza ajánlatkérésre' };

  async function transportDialog(t, { clients, carriers, onClose }) {
    const canSave = t ? FL.can('transport', 'edit') && t.status !== 'cancelled' : FL.can('transport', 'create');
    const v = t || { direction: 'out', date: FL.today(), pallets: 0 };
    const dlg = ui.dialog({
      title: t ? html`${t.number} ${FL.status('transport', t.status)}` : 'Új fuvar',
      size: 'wide',
      submitLabel: t ? 'Mentés' : 'Fuvar felvétele',
      hideSubmit: !canSave,
      cancelLabel: canSave ? 'Mégse' : 'Bezárás',
      body: html`
        ${t && (FL.can('transport', 'edit') || FL.can('transport', 'delete')) && t.status !== 'cancelled' ? html`<div class="tr-status-bar">
          <span class="small muted">Állapot:</span> ${FL.status('transport', t.status)}
          <span class="actions">
            ${FL.can('transport', 'edit') ? NEXT[t.status].map((s) => html`<button class="btn btn--sm" type="button" data-status="${s}">${s === 'requested' || (t.status === 'in_transit' && s === 'booked') ? FL.icon('arrow-left') : FL.icon('arrow-right')}${NEXT_LABEL[s]}</button>`) : ''}
            ${FL.can('transport', 'delete') && t.status !== 'delivered' ? html`<button class="btn btn--sm btn--danger" type="button" data-cancel>${FL.icon('trash')}Törlés</button>` : ''}
          </span></div>` : ''}
        <fieldset class="form-grid" ${canSave ? '' : raw('disabled')}>
          <legend class="visually-hidden">Fuvar adatai</legend>
          ${ui.field({ name: 'direction', label: 'Irány', type: 'select', value: v.direction, required: true, options: [['out', 'Kimenő (tőlünk)'], ['in', 'Beérkező (hozzánk)']] })}
          ${ui.field({ name: 'partner_id', label: 'Ügyfél', type: 'select', value: v.partner_id, options: clients, placeholder: 'Nincs megadva', optional: true })}
          ${ui.field({ name: 'date', label: 'Nap', type: 'date', value: v.date, required: true })}
          ${ui.field({ name: 'time_from', label: 'Időablak eleje', type: 'time', value: v.time_from, optional: true })}
          ${ui.field({ name: 'time_to', label: 'Időablak vége', type: 'time', value: v.time_to, optional: true })}
          ${ui.field({ name: 'pallets', label: 'Raklap', type: 'number', int: true, min: 0, value: v.pallets ?? 0 })}
          ${ui.field({ name: 'weight_kg', label: 'Súly (kg)', type: 'number', min: 0, value: v.weight_kg ?? '', optional: true })}
          ${ui.field({ name: 'vehicle', label: 'Jármű', value: v.vehicle, optional: true, placeholder: 'pl. 12 t ponyvás, rendszám' })}
          ${ui.field({ name: 'origin', label: 'Felrakás helye', value: v.origin, optional: true, span: 2, placeholder: 'Cím vagy telephely' })}
          ${ui.field({ name: 'destination', label: 'Lerakás helye', value: v.destination, optional: true, span: 2, placeholder: 'Cím vagy telephely' })}
          ${ui.field({ name: 'carrier_id', label: 'Fuvarozó', type: 'select', value: v.carrier_id, options: carriers, placeholder: 'Még nincs', optional: true, span: 2, hint: 'Foglaláshoz kötelező.' })}
          ${ui.field({ name: 'carrier_ref', label: 'Fuvarozó hivatkozása', value: v.carrier_ref, optional: true, placeholder: 'Foglalási szám' })}
          ${ui.field({ name: 'price', label: 'Fuvardíj (Ft, nettó)', type: 'number', min: 0, value: v.price ?? '', optional: true })}
          ${ui.field({ name: 'note', label: 'Megjegyzés', type: 'textarea', rows: 2, value: v.note, optional: true, span: 'all' })}
        </fieldset>
        ${t ? html`<p class="small muted">Felvette: ${t.created_by_name || 'ismeretlen'}, ${fmt.dateTime(t.created_at)}${t.updated_at && t.updated_at !== t.created_at ? `. Utoljára módosítva: ${fmt.dateTime(t.updated_at)}` : ''}.</p>` : ''}`,
      onOpen: ({ el }) => {
        el.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => ui.run(b, async () => {
          await api.post(`/api/transport/transports/${t.id}/status`, { status: b.dataset.status });
          ui.toast(`${t.number}: ${FL.statusLabel('transport', b.dataset.status)}.`, 'ok');
          dlg.close(true);
        })));
        const cancel = el.querySelector('[data-cancel]');
        if (cancel) {
          cancel.addEventListener('click', async () => {
            if (!(await ui.confirm({ title: 'Fuvar törlése', text: `Törlöd a(z) ${t.number} fuvart? A fuvar törölt állapotba kerül, a rekord megmarad.`, confirmLabel: 'Törlés', tone: 'danger' }))) return;
            await ui.run(cancel, async () => {
              await api.del(`/api/transport/transports/${t.id}`);
              ui.toast(`${t.number} törölve.`, 'ok');
              dlg.close(true);
            });
          });
        }
      },
      onSubmit: async (form) => {
        const data = ui.formValues(form);
        data.partner_id = Number(data.partner_id) || null;
        data.carrier_id = Number(data.carrier_id) || null;
        if (data.pallets == null) data.pallets = 0;
        const res = t ? await api.patch(`/api/transport/transports/${t.id}`, data) : await api.post('/api/transport/transports', data);
        ui.toast(t ? `${res.number} mentve.` : `${res.number} felvéve.`, 'ok');
        return true;
      },
    });
    const changed = await dlg.done;
    onClose(changed === true);
  }

  async function renderTransports(root, ctx) {
    const q = ctx.query;
    const filters = {
      status: q.get('status') || 'active', direction: q.get('direction') || '', partner_id: q.get('partner_id') || '',
      from: q.get('from') || '', to: q.get('to') || '', q: q.get('q') || '',
    };
    const offset = Number(q.get('offset')) || 0;
    const limit = 50;
    const [data, clients, carriers] = await Promise.all([
      api.get('/api/transport/transports', { ...filters, limit, offset }),
      ui.partnerOptions('client'),
      ui.partnerOptions('carrier'),
    ]);
    const listHash = (changes = {}) => {
      const next = { ...filters, offset: offset || '', ...changes };
      if (next.status === 'active') next.status = '';
      return `${ROOT}/fuvarok${FL.qs(next)}`;
    };
    const rowHref = (r) => `${ROOT}/fuvarok/${r.id}${FL.qs({ ...filters, status: filters.status === 'active' ? '' : filters.status })}`;

    root.innerHTML = String(html`
      ${ui.pageHead({
        title: 'Fuvarszervezés',
        lead: 'Raklapos és kamionos fuvarok ügyfeleinknek: ajánlatkéréstől a leszállításig.',
        actions: FL.can('transport', 'create') ? html`<button class="btn btn--primary" type="button" data-action="new">${FL.icon('plus')}Új fuvar</button>` : '',
      })}
      ${tabs('transports')}
      <form class="toolbar" data-filters role="search">
        ${ui.field({ name: 'status', label: 'Állapot', type: 'select', options: STATUS_FILTER, value: filters.status })}
        ${ui.field({ name: 'direction', label: 'Irány', type: 'select', options: Object.entries(DIRECTIONS), value: filters.direction, placeholder: 'Mind' })}
        ${ui.field({ name: 'partner_id', label: 'Ügyfél', type: 'select', options: clients, value: filters.partner_id, placeholder: 'Mind' })}
        ${ui.field({ name: 'from', label: 'Naptól', type: 'date', value: filters.from })}
        ${ui.field({ name: 'to', label: 'Napig', type: 'date', value: filters.to })}
        <div class="field field--grow"><label for="tr-q">Keresés</label>
          <div class="input-group"><input class="input" id="tr-q" name="q" type="search" value="${filters.q}" placeholder="Szám, cím, jármű, hivatkozás">
          <button class="btn" type="submit" aria-label="Keresés">${FL.icon('magnifying-glass')}</button></div></div>
      </form>
      ${ui.table({
        caption: 'Fuvarok',
        rows: data.items,
        empty: filters.status === 'active' ? 'Nincs aktív fuvar.' : 'Nincs a szűrésnek megfelelő fuvar.',
        rowHref,
        columns: [
          { key: 'date', label: 'Nap', render: (r) => html`<a class="nowrap" href="${rowHref(r)}">${fmt.date(r.date)}</a><span class="sub num">${windowText(r.time_from, r.time_to)}</span>` },
          { key: 'number', label: 'Szám, irány', render: (r) => html`<span class="num">${r.number}</span><span class="sub tr-dir" data-dir="${r.direction}">${FL.icon(r.direction === 'in' ? 'tray-arrow-down' : 'tray-arrow-up')}${DIRECTIONS[r.direction]}</span>` },
          { key: 'partner_name', label: 'Ügyfél', render: (r) => (r.partner_name ? html`<span title="${r.partner_name}">${r.partner_code}</span>` : html`<span class="muted">nincs</span>`) },
          { key: 'route', label: 'Útvonal', cls: 'tr-route', render: (r) => html`${r.origin || '?'}<span class="sub">${FL.icon('arrow-right')}${r.destination || '?'}</span>` },
          { key: 'load', label: 'Rakomány', align: 'r', cls: 'num', render: (r) => html`${fmt.int(r.pallets)} rkl<span class="sub">${fmt.kg(r.weight_kg)}</span>` },
          { key: 'carrier_name', label: 'Fuvarozó', render: (r) => (r.carrier_name ? html`<span title="${r.carrier_name}">${r.carrier_short}</span><span class="sub">${r.carrier_ref || r.vehicle}</span>` : html`<span class="muted">nincs</span>`) },
          { key: 'price', label: 'Díj', align: 'r', cls: 'num', render: (r) => fmt.money(r.price) },
          { key: 'status', label: 'Állapot', render: (r) => FL.status('transport', r.status) },
        ],
      })}
      ${ui.pager({ total: data.total, limit, offset })}`);

    ui.enableRowLinks(root);
    const form = root.querySelector('[data-filters]');
    form.addEventListener('change', (e) => { if (e.target.name !== 'q') FL.go(listHash({ [e.target.name]: e.target.value, offset: '' })); });
    form.addEventListener('submit', (e) => { e.preventDefault(); FL.go(listHash({ q: form.elements.q.value.trim(), offset: '' })); });
    const refs = { clients, carriers };
    const back = () => FL.go(listHash());
    ui.bind(root, {
      new: () => transportDialog(null, { ...refs, onClose: (changed) => { if (changed) FL.reload(); } }),
      page: (el) => FL.go(listHash({ offset: el.dataset.offset })),
    });

    const openId = ctx.params[1];
    if (openId && /^\d+$/.test(openId)) {
      try {
        const t = await api.get(`/api/transport/transports/${openId}`);
        transportDialog(t, { ...refs, onClose: back });
      } catch (err) {
        ui.toast(err.message, 'error');
      }
    }
  }

  // core/app.js (which defines FL.view) loads after the views and keeps FL.views as it is, so the
  // view registers itself directly when FL.view is not there yet.
  const register = (key, def) => (typeof FL.view === 'function' ? FL.view(key, def) : ((FL.views = FL.views || {})[key] = def));
  register('transport', {
    async render(root, ctx) {
      const [section, id] = ctx.params;
      if (!section) return renderBoard(root, ctx);
      if (section === 'fuvarok') return renderTransports(root, ctx);
      if (section === 'atvetel' && /^\d+$/.test(id || '')) return renderPickup(root, id);
      root.innerHTML = String(ui.empty('Ez az oldal nem létezik.', 'warning-circle'));
      return undefined;
    },
  });
})();
