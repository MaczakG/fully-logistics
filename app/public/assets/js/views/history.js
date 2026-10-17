/* Rendeléstörténet: shipped, delivered, returned and cancelled orders.
     #/rendelestortenet          search and filters (date range on shipping or creation, client, carrier,
                                 status, text incl. tracking number), CSV export
     #/rendelestortenet/<id>     order detail (FL.orders.renderDetail) with return and delivered actions
   FL.returnDialog(order) records a return (visszáru); the detail page calls it. */
(() => {
  'use strict';
  const { html, ui, api, fmt } = FL;
  const CLOSED = ['shipped', 'delivered', 'returned', 'cancelled'];
  const REASONS = ['Nem vette át a címzett', 'Elállás (14 napon belül)', 'Sérült csomag', 'Téves termék', 'Hibás termék', 'Címzett ismeretlen', 'Csere'];

  /* ------------------------------------------------------------ return dialog */

  let rowSeq = 0;
  // The lots the order shipped with: a choice only when there is something to choose or show.
  const lotValue = (l) => JSON.stringify([l.lot, l.expiry]);
  const hasLots = (line) => line.lots.length > 1 || line.lots.some((l) => l.lot || l.expiry);
  const lotLabel = (l) => `${l.lot || 'Tétel nélkül'}${l.expiry ? `, lejárat ${fmt.date(l.expiry)}` : ''} (visszaküldhető ${fmt.int(l.returnable)})`;
  function lotField(line, n, chosen) {
    if (!hasLots(line)) return '';
    const open = line.lots.filter((l) => l.returnable > 0);
    const value = chosen || (open[0] ? lotValue(open[0]) : '');
    return FL.html`<div class="field rt-line__lot">
        <label for="rt-t-${n}">Tétel</label>
        <select class="select" id="rt-t-${n}" data-rt-lot aria-describedby="rt-t-${n}-err">${ui.options(open.map((l) => ({ value: lotValue(l), label: lotLabel(l) })), value)}</select>
        <p class="field__error" id="rt-t-${n}-err" hidden></p>
      </div>`;
  }

  function returnRow(line, opts, row = {}) {
    const n = ++rowSeq;
    const condition = row.condition || 'sellable';
    return FL.html`<div class="rt-line" data-rt-line data-product-id="${line.product_id}">
      <div class="rt-line__prod">
        <b class="mono">${line.sku}</b> <span>${line.name}</span>
        <span class="small muted">Rendelve ${fmt.int(line.qty)} ${line.unit}${line.returned ? `, már visszajött ${fmt.int(line.returned)}` : ''}, visszaküldhető ${fmt.int(line.returnable)}</span>
      </div>
      <div class="field rt-line__qty">
        <label for="rt-q-${n}">Darab</label>
        <input class="input input--num" id="rt-q-${n}" type="number" min="0" max="${line.returnable}" step="1" value="${row.qty ?? 0}" data-rt-qty aria-describedby="rt-q-${n}-err">
        <p class="field__error" id="rt-q-${n}-err" hidden></p>
      </div>
      ${lotField(line, n, row.lot)}
      <div class="field rt-line__cond">
        <label for="rt-c-${n}">Állapot</label>
        <select class="select" id="rt-c-${n}" data-rt-cond>${ui.options([['sellable', 'Értékesíthető'], ['damaged', 'Sérült']], condition)}</select>
      </div>
      <div class="field rt-line__loc">
        <label for="rt-l-${n}">Hová kerül</label>
        <select class="select" id="rt-l-${n}" data-rt-loc aria-describedby="rt-l-${n}-err">${locationOptions(line, opts, condition)}</select>
        <input class="input input--code" data-rt-code placeholder="Raktárhely kódja" aria-label="Raktárhely kódja" hidden>
        <p class="field__error" id="rt-l-${n}-err" hidden></p>
      </div>
      <button class="btn btn--ghost btn--sm rt-line__split" type="button" data-rt-split title="Ha egy része sérült, egy része értékesíthető">${FL.icon('plus')}Másik állapot</button>
    </div>`;
  }

  function locationOptions(line, opts, condition) {
    if (condition === 'damaged') {
      return ui.options(opts.quarantine_zones.map((z) => ({ value: `id:${z.id}`, label: `Karantén: ${z.code}` })));
    }
    const list = opts.returns_zones.map((z) => ({ value: `id:${z.id}`, label: `Visszáru zóna: ${z.code}` }));
    if (line.suggested_location && !opts.returns_zones.some((z) => z.id === line.suggested_location.id)) {
      list.push({ value: `id:${line.suggested_location.id}`, label: `Vissza a polcra: ${line.suggested_location.code}` });
    }
    list.push({ value: 'other', label: 'Másik raktárhely...' });
    return ui.options(list);
  }

  FL.returnDialog = async (order) => {
    const opts = await api.get(`/api/history/${order.id}/return-options`);
    if (!opts.can_return) { ui.toast('Ehhez a rendeléshez nem rögzíthető visszáru.', 'error'); return undefined; }
    const lines = opts.lines.filter((l) => l.returnable > 0);
    if (!lines.length) { ui.toast('A rendelés minden tétele visszajött már.', 'info'); return undefined; }
    const byProduct = new Map(lines.map((l) => [l.product_id, l]));
    const noZone = !opts.returns_zones.length || !opts.quarantine_zones.length;
    return ui.dialog({
      title: `Visszáru: ${order.number}`,
      size: 'wide',
      submitLabel: 'Visszáru rögzítése',
      body: html`
        <p>Add meg, mi érkezett vissza. Az értékesíthető áru a visszáru zónába vagy a választott polcra kerül, a sérült a karanténba (készleten van, de nem adható ki).</p>
        ${noZone ? ui.notice('Nincs beállítva visszáru zóna vagy karantén raktárhely. Vedd fel őket a Beállítások > Raktárhelyek alatt, vagy válassz konkrét raktárhelyet.', 'warn') : ''}
        <div class="rt-lines" data-rt-lines>${lines.map((l) => returnRow(l, opts))}</div>
        <div><button class="btn btn--sm" type="button" data-rt-all>${FL.icon('check')}Minden visszaküldhető tétel visszajött</button></div>
        <div class="form-grid">
          <div class="field"><label for="rt-reason">Ok <span class="field__opt">(nem kötelező)</span></label>
            <input class="input" id="rt-reason" name="reason" list="rt-reasons" maxlength="300" autocomplete="off">
            <datalist id="rt-reasons">${REASONS.map((r) => html`<option value="${r}"></option>`)}</datalist>
            <p class="field__error" hidden></p></div>
          ${ui.field({ name: 'note', label: 'Megjegyzés', optional: true, span: 2, placeholder: 'Pl. a doboz szakadt, a termék hiánytalan.' })}
          <div class="field span-all"><label for="rt-photos">Fotók <span class="field__opt">(nem kötelező)</span></label>
            <input class="input" id="rt-photos" type="file" accept="image/*" capture="environment" multiple>
            <span class="field__hint">A csomagról vagy a sérült áruról. Képenként legfeljebb 20 MB.</span></div>
        </div>`,
      onOpen: ({ form }) => {
        const box = form.querySelector('[data-rt-lines]');
        const wireCode = (row) => {
          const input = row.querySelector('[data-rt-code]');
          if (input.dataset.wired) return;
          input.dataset.wired = '1';
          ui.autocomplete(input, {
            source: ui.sources.locations,
            label: (l) => l.code,
            sub: (l) => `${FL.state.meta.locationKinds[l.kind] || l.kind} · ${l.size_code}`,
            onSelect: (l) => { input.value = l.code; },
          });
        };
        box.addEventListener('change', (e) => {
          const row = e.target.closest('[data-rt-line]');
          if (!row) return;
          if (e.target.matches('[data-rt-cond]')) {
            const line = byProduct.get(Number(row.dataset.productId));
            row.querySelector('[data-rt-loc]').innerHTML = String(locationOptions(line, opts, e.target.value));
            row.querySelector('[data-rt-code]').hidden = true;
          }
          if (e.target.matches('[data-rt-loc]')) {
            const code = row.querySelector('[data-rt-code]');
            code.hidden = e.target.value !== 'other';
            if (!code.hidden) { wireCode(row); code.focus(); }
          }
        });
        form.addEventListener('click', (e) => {
          const split = e.target.closest('[data-rt-split]');
          if (split) {
            const row = split.closest('[data-rt-line]');
            const line = byProduct.get(Number(row.dataset.productId));
            row.insertAdjacentHTML('afterend', String(returnRow(line, opts, { condition: 'damaged' })));
            row.nextElementSibling.querySelector('[data-rt-qty]').focus();
          }
          if (e.target.closest('[data-rt-all]')) {
            const seen = new Set();
            box.querySelectorAll('[data-rt-line]').forEach((row) => {
              const pid = Number(row.dataset.productId);
              const line = byProduct.get(pid);
              const open = line.lots.filter((l) => l.returnable > 0);
              if (open.length > 1) {
                // One row per lot, each with what is left of it.
                if (!seen.has(pid)) {
                  row.insertAdjacentHTML('beforebegin', open.map((l) => String(returnRow(line, opts, { qty: l.returnable, lot: lotValue(l) }))).join(''));
                }
                row.remove();
              } else row.querySelector('[data-rt-qty]').value = seen.has(pid) ? 0 : line.returnable;
              seen.add(pid);
            });
          }
        });
      },
      onSubmit: async (form) => {
        const rows = [...form.querySelectorAll('[data-rt-line]')];
        const fields = {};
        const payload = [];
        rows.forEach((row, i) => {
          const qtyEl = row.querySelector('[data-rt-qty]');
          const locEl = row.querySelector('[data-rt-loc]');
          qtyEl.name = `lines.${payload.length}.qty`;
          locEl.name = `lines.${payload.length}.location_id`;
          const qty = parseInt(qtyEl.value, 10) || 0;
          if (qty < 0) fields[`r${i}`] = true;
          if (!qty) {
            qtyEl.removeAttribute('name');
            locEl.removeAttribute('name');
            row.querySelector('[data-rt-lot]')?.removeAttribute('name');
            return;
          }
          const loc = locEl.value;
          const item = { product_id: Number(row.dataset.productId), qty, condition: row.querySelector('[data-rt-cond]').value };
          const lotEl = row.querySelector('[data-rt-lot]');
          if (lotEl && lotEl.value) {
            lotEl.name = `lines.${payload.length}.lot`;
            [item.lot, item.expiry] = JSON.parse(lotEl.value);
          }
          if (loc === 'other') {
            const code = row.querySelector('[data-rt-code]').value.trim();
            if (!code) fields[`lines.${payload.length}.location_id`] = 'Add meg a raktárhely kódját.';
            item.location_code = code;
          } else if (loc && loc.startsWith('id:')) item.location_id = Number(loc.slice(3));
          payload.push(item);
        });
        if (!payload.length) throw new FL.ApiError(400, 'bad_request', 'Legalább egy tételnél adj meg darabszámot.');
        if (Object.keys(fields).length) throw new FL.ApiError(400, 'bad_request', 'Ellenőrizd a megjelölt mezőket.', fields);
        const v = ui.formValues(form);
        const res = await api.post(`/api/history/${order.id}/returns`, { reason: v.reason || '', note: v.note || '', lines: payload });
        const files = [...form.querySelector('#rt-photos').files];
        let failed = 0;
        for (const f of files) {
          try { await api.upload(`/api/history/returns/${res.id}/photos`, f); } catch { failed += 1; }
        }
        ui.toast(`${res.number} rögzítve: ${fmt.int(res.pieces)} db visszakerült a készletbe.${files.length ? ` Fotó: ${files.length - failed} feltöltve${failed ? `, ${failed} nem sikerült` : ''}.` : ''}`, failed ? 'error' : 'ok');
        return res;
      },
    }).done;
  };

  /* ------------------------------------------------------------ list */

  async function renderList(root, ctx) {
    const q = ctx.query;
    const state = {
      status: CLOSED.includes(q.get('status')) ? q.get('status') : '',
      date_field: q.get('date_field') === 'created' ? 'created' : 'shipped',
      from: q.get('from') || '', to: q.get('to') || '',
      partner_id: q.get('partner_id') || '', carrier_id: q.get('carrier_id') || '', q: q.get('q') || '',
      offset: Number(q.get('offset')) || 0,
    };
    const [clients, carriers] = await Promise.all([ui.partnerOptions('client'), FL.orders.carrierOptions()]);
    root.innerHTML = String(html`
      ${ui.pageHead({
        title: 'Rendeléstörténet',
        lead: 'Feladott, kézbesített, visszáru és sztornózott rendelések. Kereshetsz rendelésszámra, vevőre, városra és nyomkövetési számra is.',
        actions: html`<button class="btn" type="button" data-action="export">${FL.icon('download-simple')}Exportálás (CSV)</button>`,
      })}
      <div data-kpis></div>
      <form class="toolbar hs-filters" data-filters role="search">
        <div class="field field--grow"><label for="hs-q">Keresés</label>
          <input class="input" id="hs-q" name="q" type="search" value="${state.q}" placeholder="Rendelésszám, vevő, város, nyomkövetési szám"></div>
        ${ui.field({ name: 'date_field', label: 'Dátum szerint', type: 'select', options: [['shipped', 'Feladás napja'], ['created', 'Beérkezés napja']], value: state.date_field })}
        ${ui.field({ name: 'from', label: 'Ettől', type: 'date', value: state.from })}
        ${ui.field({ name: 'to', label: 'Eddig', type: 'date', value: state.to })}
        ${ui.field({ name: 'partner_id', label: 'Ügyfél', type: 'select', options: clients, placeholder: 'Mind', value: state.partner_id })}
        ${ui.field({ name: 'carrier_id', label: 'Fuvarozó', type: 'select', options: carriers, placeholder: 'Mind', value: state.carrier_id })}
        ${ui.field({ name: 'status', label: 'Állapot', type: 'select', options: CLOSED.map((s) => [s, FL.statusLabel('order', s)]), placeholder: 'Mind', value: state.status })}
        <div class="hs-quick" role="group" aria-label="Gyors időszak">
          <button class="btn btn--sm btn--ghost" type="button" data-action="range" data-days="0">Ma</button>
          <button class="btn btn--sm btn--ghost" type="button" data-action="range" data-days="7">7 nap</button>
          <button class="btn btn--sm btn--ghost" type="button" data-action="range" data-days="30">30 nap</button>
          <button class="btn btn--sm btn--ghost" type="button" data-action="clear">${FL.icon('x')}Törlés</button>
        </div>
      </form>
      <div data-table>${ui.loading()}</div>`);

    const form = root.querySelector('[data-filters]');
    const query = () => ({ ...state, offset: undefined });

    async function load() {
      history.replaceState(null, '', `${FL.routes.history}${FL.qs({ ...state, date_field: state.date_field === 'shipped' ? '' : state.date_field, offset: state.offset || '' })}`);
      const data = await api.get('/api/history', { ...query(), offset: state.offset, limit: 50 });
      const k = data.kpis;
      const kpiHref = (s) => `${FL.routes.history}${FL.qs({ ...state, status: s, offset: '', date_field: state.date_field === 'shipped' ? '' : state.date_field })}`;
      root.querySelector('[data-kpis]').innerHTML = String(ui.kpis([
        { label: 'Feladva', value: fmt.int(k.shipped), hint: 'úton a vevőhöz', href: kpiHref('shipped') },
        { label: 'Kézbesítve', value: fmt.int(k.delivered), tone: 'ok', href: kpiHref('delivered') },
        { label: 'Visszáru', value: fmt.int(k.returned), tone: k.returned ? 'warn' : '', href: kpiHref('returned') },
        { label: 'Sztornózva', value: fmt.int(k.cancelled), href: kpiHref('cancelled') },
      ]));
      const filtered = state.q || state.from || state.to || state.partner_id || state.carrier_id || state.status;
      root.querySelector('[data-table]').innerHTML = String(html`${ui.table({
        caption: 'Lezárt rendelések',
        rows: data.items,
        empty: filtered ? 'Nincs a szűrésnek megfelelő rendelés.' : 'Még nincs lezárt rendelés.',
        rowHref: (r) => `${FL.routes.history}/${r.id}`,
        columns: [
          { key: 'number', label: 'Rendelés', cls: 'nowrap', render: (r) => html`<a class="mono" href="${FL.routes.history}/${r.id}">${r.number}</a>${r.external_number ? html`<span class="sub">${r.external_number}</span>` : ''}` },
          { key: 'partner_code', label: 'Ügyfél', render: (r) => html`<span class="tag" title="${r.partner_name}">${r.partner_code}</span>` },
          { key: 'customer_name', label: 'Vevő', render: (r) => html`${r.customer_name}<span class="sub">${[r.zip, r.city].filter(Boolean).join(' ')}</span>` },
          { key: 'carrier_name', label: 'Fuvarozó', render: (r) => html`<span title="${r.carrier_name || ''}">${FL.orders.carrierShort(r.carrier_name, r.carrier_code)}</span>${r.tracking_number ? html`<span class="sub mono">${r.tracking_number}</span>` : ''}` },
          { key: 'item_count', label: 'Db', align: 'r', cls: 'num' },
          { key: 'cod_amount', label: 'Utánvét', align: 'r', cls: 'num', render: (r) => (r.cod_amount ? fmt.money(r.cod_amount) : '') },
          { key: 'shipped_date', label: 'Feladva', render: (r) => html`${r.shipped_date ? fmt.date(r.shipped_date) : html`<span class="muted">nem</span>`}${r.delivered_at ? html`<span class="sub">Kézbesítve ${fmt.date(r.delivered_at)}</span>` : r.cancelled_at ? html`<span class="sub">Sztornó ${fmt.date(r.cancelled_at)}</span>` : ''}` },
          { key: 'status', label: 'Állapot', render: (r) => html`${FL.status('order', r.status)}${r.return_count ? html`<span class="sub">${fmt.int(r.return_count)} visszáru</span>` : ''}` },
        ],
      })}${ui.pager({ total: data.total, limit: 50, offset: state.offset })}`);
    }
    const apply = () => { state.offset = 0; load().catch((e) => ui.toast(e.message, 'error')); };
    form.addEventListener('submit', (e) => { e.preventDefault(); state.q = form.q.value.trim(); apply(); });
    form.q.addEventListener('input', FL.debounce(() => { state.q = form.q.value.trim(); apply(); }, 350));
    for (const name of ['date_field', 'from', 'to', 'partner_id', 'carrier_id', 'status']) {
      form[name].addEventListener('change', () => {
        state[name] = form[name].value;
        if ((name === 'from' || name === 'to') && state.from && state.to && state.from > state.to) {
          ui.toast('A kezdő dátum nem lehet későbbi a záró dátumnál.', 'error');
          return;
        }
        apply();
      });
    }
    ui.enableRowLinks(root);
    ui.bind(root, {
      range: (el) => {
        const days = Number(el.dataset.days);
        state.to = FL.today();
        state.from = days ? FL.addDays(state.to, -days) : state.to;
        form.from.value = state.from;
        form.to.value = state.to;
        apply();
      },
      clear: () => {
        Object.assign(state, { status: '', from: '', to: '', partner_id: '', carrier_id: '', q: '', date_field: 'shipped' });
        for (const name of ['q', 'from', 'to', 'partner_id', 'carrier_id', 'status']) form[name].value = '';
        form.date_field.value = 'shipped';
        apply();
      },
      page: (el) => { state.offset = Number(el.dataset.offset); load().then(() => root.querySelector('[data-table]').scrollIntoView({ block: 'start' })); },
      export: (el) => ui.run(el, () => api.download('/api/history/export', query())),
    });
    await load();
  }

  FL.view('history', {
    async render(root, ctx) {
      root.classList.add('hs-root', 'ol-root');
      if (ctx.params[0]) {
        const id = Number(ctx.params[0]);
        if (!Number.isInteger(id) || id <= 0) { root.innerHTML = String(ui.empty('Ez a rendelés nem létezik.', 'warning-circle')); return; }
        await FL.orders.renderDetail(root, id, { area: 'history' });
        return;
      }
      await renderList(root, ctx);
    },
  });
})();
