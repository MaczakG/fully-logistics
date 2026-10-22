/* Elszámolás (#/elszamolas): monthly statements per client, drill-down, manual lines, approval,
   invoicing, and the hourly work / custom item entries (#/elszamolas/tetelek).
     #/elszamolas?period=YYYY-MM          overview of the month (default: previous month)
     #/elszamolas/<id>                    one statement
     #/elszamolas/tetelek?period=&partner= billing entries */
(() => {
  'use strict';
  const FL = window.FL;
  const { html, raw, ui, api, fmt } = FL;

  const MONTHS = ['január', 'február', 'március', 'április', 'május', 'június', 'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];
  const isPeriod = (p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(p || '');
  const label = (p) => `${p.slice(0, 4)}. ${MONTHS[Number(p.slice(5, 7)) - 1]}`;
  const shift = (p, n) => {
    const d = new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)) - 1 + n, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  const defaultPeriod = () => shift(FL.thisMonth(), -1);
  const periodFrom = (query) => (isPeriod(query.get('period')) ? query.get('period') : defaultPeriod());
  const GROUP_LABEL = { handling: 'Rendeléskezelés', storage: 'Tárolás', inbound: 'Áruátvétel és visszáru', extra: 'Extrák', custom: 'Egyedi tételek', discount: 'Kedvezmények' };
  const DRILL = { orders: 'Rendelések', storage: 'Tárolás helyenként', inbound: 'Betárolás', returns: 'Visszáru', entries: 'Munkaórák és egyedi tételek' };
  const KIND_LABEL = { hourly_work: 'Óradíjas munka', custom: 'Egyedi tétel' };

  const chip = (status) => (status === 'none'
    ? html`<span class="chip" data-tone="neutral">Nincs elszámolás</span>`
    : FL.status('statement', status));
  const money = (v) => (v == null ? '' : fmt.money(v, Number.isInteger(Number(v)) ? 0 : 2));
  const qty = (v, unit) => `${fmt.num(v, 2)} ${unit || ''}`.trim();
  const priceText = (l) => {
    if (l.price_unit === '%') return fmt.pct(l.price, 2);
    if (l.price_unit === 'Ft / hely / hó') return `${money(l.price)} / hely / hó`;
    return money(l.price);
  };

  const tabs = (active, period) => ui.tabs([
    { key: 'statements', label: 'Havi elszámolások', href: `#/elszamolas?period=${period}`, icon: 'invoice' },
    { key: 'entries', label: 'Egyedi tételek és munkaórák', href: `#/elszamolas/tetelek?period=${period}`, icon: 'clock' },
  ], active, 'Elszámolás nézetek');

  // Month picker: previous / select / next. onChange(period).
  function periodPicker(period) {
    const now = FL.thisMonth();
    const options = [];
    for (let p = now, i = 0; i < 25; i++, p = shift(p, -1)) options.push({ value: p, label: label(p) });
    if (!options.some((o) => o.value === period)) options.push({ value: period, label: label(period) });
    return html`<div class="field bl-period"><label for="bl-period">Időszak</label>
      <div class="bl-period__row">
        <button class="btn btn--icon" type="button" data-action="period-prev" aria-label="Előző hónap">${FL.icon('caret-left')}</button>
        <select class="select" id="bl-period" data-action="period">${ui.options(options, period)}</select>
        <button class="btn btn--icon" type="button" data-action="period-next" aria-label="Következő hónap" ${period >= now ? raw('disabled') : ''}>${FL.icon('caret-right')}</button>
      </div></div>`;
  }
  const periodHandlers = (go, period) => ({
    period: (el) => go(el.value),
    'period-prev': () => go(shift(period, -1)),
    'period-next': () => go(shift(period, 1)),
  });

  function invoicingNotice(inv) {
    if (inv && inv.error) return ui.notice(inv.error, 'danger');
    if (inv && inv.configured) return '';
    const what = inv && inv.provider ? `A(z) ${inv.name} beállításai hiányosak` : 'Még nincs beállítva számlázó';
    return ui.notice(html`${what}, ezért a jóváhagyott elszámolásokról nem tudsz számlát kiállítani.
      ${FL.can('settings', 'view') ? html`<a href="#/beallitasok/szamlazo">Számlázó beállítása</a>` : 'Kérd meg az adminisztrátort, hogy állítsa be (Beállítások > Számlázó).'}`, 'warn');
  }

  /* ------------------------------------------------------------ overview */
  async function renderOverview(root, ctx) {
    const period = periodFrom(ctx.query);
    const data = await api.get('/api/billing/overview', { period });
    const canCreate = FL.can('billing', 'create');
    const rows = data.items.map((x) => ({ ...x, id: x.partner_id }));
    const sel = ui.selection(() => rows, () => updateGenerate());
    const k = data.kpis;
    const snap = data.snapshots;

    root.innerHTML = String(html`
      ${ui.pageHead({
        title: 'Elszámolás',
        lead: 'Havi elszámolás ügyfelenként: rendeléskezelés a feladott rendelésekből, tárolás a napi pillanatképekből, áruátvétel, visszáru és a rögzített tételek.',
        actions: html`
          <button class="btn" type="button" data-action="export">${FL.icon('download-simple')}Export</button>
          ${canCreate ? html`<button class="btn" type="button" data-action="snapshot">${FL.icon('database')}Pillanatkép rögzítése most</button>
            <button class="btn btn--primary" type="button" data-action="generate">${FL.icon('calculator')}<span data-generate-label>Elszámolások készítése</span></button>` : ''}`,
      })}
      ${tabs('statements', period)}
      ${invoicingNotice(data.invoicing)}
      ${snap.missing.length ? ui.notice(html`A tárolási díj a napi pillanatképekből számolódik. ${label(period)} ${fmt.int(snap.expected)} napjából
        ${fmt.int(snap.missing.length)} napra nincs pillanatkép, ezekre nem számolunk tárolást:
        ${snap.missing.slice(0, 10).map((d) => fmt.date(d)).join(', ')}${snap.missing.length > 10 ? ' ...' : ''}`, 'warn') : ''}
      <div class="toolbar">
        ${periodPicker(period)}
        <p class="small muted bl-snapinfo">${snap.last ? `Utolsó pillanatkép: ${fmt.date(snap.last.date)}, ${fmt.int(snap.last.rows)} raktárhely` : 'Még nincs tárolási pillanatkép.'}</p>
      </div>
      <div class="bl-kpis">${ui.kpis([
        { label: 'Nettó összesen', value: fmt.money(k.total_net), hint: `${label(period)}, érvénytelenítettek nélkül` },
        { label: 'Számlázva', value: fmt.money(k.invoiced_net), hint: `${fmt.int(k.invoiced_count)} ügyfél`, tone: k.invoiced_count ? 'ok' : '' },
        { label: 'Jóváhagyásra vár', value: fmt.int(k.draft_count), hint: fmt.money(k.draft_net), tone: k.draft_count ? 'warn' : '' },
        { label: 'Számlázásra vár', value: fmt.int(k.approved_count), hint: fmt.money(k.approved_net) },
        { label: 'Nincs elszámolás', value: fmt.int(k.missing_count), hint: 'aktív ügyfél' },
      ])}</div>
      ${ui.table({
        caption: `Elszámolások, ${label(period)}`,
        rows,
        selectable: canCreate,
        selected: sel.set,
        empty: 'Nincs aktív ügyfél.',
        rowHref: (r) => (r.statement_id ? `#/elszamolas/${r.statement_id}` : null),
        columns: [
          { key: 'name', label: 'Ügyfél', render: (r) => html`${r.statement_id ? html`<a href="#/elszamolas/${r.statement_id}">${r.name}</a>` : r.name}<span class="sub">${r.code}${r.partner_status === 'inactive' ? ' · inaktív' : ''}</span>` },
          { key: 'status', label: 'Állapot', render: (r) => chip(r.status) },
          { key: 'number', label: 'Elszámolás', cls: 'num', render: (r) => r.number || '' },
          { key: 'net', label: 'Nettó', align: 'r', cls: 'num', render: (r) => (r.statement_id ? fmt.money(r.net) : '') },
          { key: 'gross', label: 'Bruttó', align: 'r', cls: 'num', render: (r) => (r.statement_id ? fmt.money(r.gross) : '') },
          {
            key: 'invoice', label: 'Számla', render: (r) => (r.invoice_number
              ? html`<span class="num">${r.invoice_number}</span>`
              : r.invoice_error ? html`<span class="chip" data-tone="danger" title="${r.invoice_error}">Hiba</span>` : ''),
          },
        ],
        footer: rows.length ? html`<tr>${canCreate ? html`<td></td>` : ''}<td colspan="3">Összesen (érvénytelenítettek nélkül)</td>
          <td class="r num">${fmt.money(k.total_net)}</td><td class="r num">${fmt.money(data.items.filter((x) => ['draft', 'approved', 'invoiced'].includes(x.status)).reduce((s, x) => s + x.gross, 0))}</td><td></td></tr>` : '',
      })}
      <p class="small muted">A piszkozatok újraszámolhatók, a kézi tételek megmaradnak. Jóváhagyott és számlázott elszámolásokhoz az újraszámolás nem nyúl. Inaktív ügyfélnek csak akkor készül elszámolás, ha volt forgalma a hónapban.</p>`);

    ui.enableRowLinks(root);
    const markRow = (box) => {
      const tr = box.closest('tr');
      if (box.checked) tr.setAttribute('data-selected', 'true');
      else tr.removeAttribute('data-selected');
    };
    const genLabel = root.querySelector('[data-generate-label]');
    function updateGenerate() {
      if (genLabel) genLabel.textContent = sel.set.size ? `Elszámolások készítése (${sel.set.size} kijelölt)` : 'Elszámolások készítése';
    }
    const go = (p) => FL.go(`#/elszamolas?period=${p}`);
    ui.bind(root, {
      ...sel.handlers,
      'select-all': (el) => {
        sel.handlers['select-all'](el);
        root.querySelectorAll('[data-action="select-row"]').forEach((c) => { c.checked = el.checked; markRow(c); });
      },
      'select-row': (el) => {
        sel.handlers['select-row'](el);
        markRow(el);
        const all = root.querySelector('[data-action="select-all"]');
        if (all) all.checked = rows.every((r) => sel.set.has(r.id));
      },
      ...periodHandlers(go, period),
      export: (el) => ui.run(el, () => api.download('/api/billing/overview/export', { period })),
      snapshot: async (el) => {
        const yes = await ui.confirm({
          title: 'Pillanatkép rögzítése most',
          text: 'Rögzítjük a mai napra, melyik raktárhelyen kinek az áruja van. Ma 23:00 után a rendszer magától is rögzíti a napi záró állapotot, ami ezt felülírja.',
          confirmLabel: 'Rögzítés',
        });
        if (!yes) return;
        const r = await ui.run(el, () => api.post('/api/billing/snapshot'));
        if (r) { ui.toast(`Pillanatkép rögzítve (${fmt.date(r.date)}): ${fmt.int(r.rows)} raktárhely.`, 'ok'); FL.reload(); }
      },
      generate: () => generate(period, [...sel.set], rows),
    });
  }

  function generate(period, selected, rows) {
    const names = rows.filter((r) => selected.includes(r.id)).map((r) => r.name);
    ui.dialog({
      title: 'Elszámolások készítése',
      submitLabel: 'Elszámolások készítése',
      body: html`
        <p>${selected.length
          ? html`A kijelölt ${fmt.int(selected.length)} ügyfélnek (${names.join(', ')}) elkészítjük vagy újraszámoljuk a ${label(period)} elszámolását.`
          : html`Minden ügyfélnek elkészítjük vagy újraszámoljuk a ${label(period)} elszámolását, akinek volt számlázható tétele.`}</p>
        <p class="small muted">A piszkozatok számított tételei frissülnek, a kézzel hozzáadott tételek megmaradnak. Jóváhagyott és számlázott elszámolásokhoz nem nyúlunk.${selected.length ? ' Kijelölt érvénytelenített elszámolás újra piszkozat lesz.' : ''}</p>`,
      onSubmit: async () => {
        const res = await api.post('/api/billing/statements/generate', selected.length ? { period, partner_ids: selected } : { period });
        const skipped = res.skipped.filter((s) => !/Nincs számlázható/.test(s.reason));
        ui.toast(`Kész: ${fmt.int(res.created)} új, ${fmt.int(res.updated)} újraszámolt elszámolás.`, 'ok');
        FL.reload();
        if (skipped.length) {
          ui.dialog({
            title: 'Kimaradt ügyfelek',
            hideSubmit: true,
            cancelLabel: 'Bezárás',
            body: ui.table({ columns: [{ key: 'name', label: 'Ügyfél' }, { key: 'reason', label: 'Ok' }], rows: skipped }),
          });
        }
      },
    });
  }

  /* ------------------------------------------------------------ statement */
  // "1 db: 12 · 2 db: 5 rendelés", zero buckets left out.
  const bucketText = (b) => `${[['1 db', b[1]], ['2 db', b[2]], ['3 db', b[3]], ['4+ db', b['4+']]].filter(([, n]) => n).map(([k, n]) => `${k}: ${fmt.int(n)}`).join(' · ')} rendelés`;

  function lineSub(l) {
    const d = l.detail || {};
    const parts = [];
    if (l.manual) parts.push(`Kézi tétel${l.created_by ? `, ${l.created_by}` : ''}`);
    else if (d.drill === 'orders' && !d.cod_only && l.key === 'handling.order_base') parts.push(bucketText(d.buckets));
    else if (d.drill === 'orders' && l.key === 'handling.item_extra') parts.push(`${fmt.int(d.extra_pieces)} db a 4. darabtól`);
    else if (d.drill === 'storage') parts.push(`${fmt.int(d.location_days)} helynap, ${fmt.int(d.locations)} hely, ${d.days_in_month} napos hónap`);
    else if (l.group === 'discount' && d.base != null) parts.push(`${fmt.pct(d.pct, 2)} ennyiből: ${fmt.money(d.base)}`);
    else if (l.key === 'extra.cod_pct') parts.push(`${fmt.money(d.cod_total)} utánvét`);
    return parts.join(' ');
  }

  function linesTable(st, canEdit) {
    const editable = st.status === 'draft' && canEdit;
    const groups = st.groups.filter((g) => st.lines.some((l) => l.group === g.key));
    if (!groups.length) return html`<div class="table-wrap">${ui.empty('Az elszámolásban nincs tétel.')}</div>`;
    const cols = 7;
    return html`<div class="table-wrap"><table class="table bl-lines">
      <caption class="visually-hidden">Elszámolás tételei csoportonként</caption>
      <thead><tr><th scope="col">Tétel</th><th scope="col" class="r">Mennyiség</th><th scope="col" class="r">Egységár</th>
        <th scope="col" class="r">Nettó</th><th scope="col" class="r">ÁFA ${fmt.pct(st.vat_pct, 1)}</th><th scope="col" class="r">Bruttó</th><th scope="col"><span class="visually-hidden">Műveletek</span></th></tr></thead>
      ${groups.map((g) => {
        const lines = st.lines.filter((l) => l.group === g.key);
        const sum = (k) => lines.reduce((s, l) => s + (l[k] || 0), 0);
        const drillShown = new Set();
        const drillButton = (l) => {
          const kind = l.detail && l.detail.drill;
          if (!kind || drillShown.has(kind)) return '';
          drillShown.add(kind);
          return html`<button class="btn btn--ghost btn--sm" type="button" data-action="drill" data-kind="${kind}" aria-label="${`Részletek: ${DRILL[kind]}`}">Részletek</button>`;
        };
        return html`<tbody>
          <tr class="bl-group"><th scope="rowgroup" colspan="${cols}">${g.label}</th></tr>
          ${lines.map((l) => html`<tr>
            <td class="bl-c-name"><span class="bl-line-name">${l.name}</span>${lineSub(l) ? html`<span class="sub">${lineSub(l)}</span>` : ''}
              ${l.warn ? html`<span class="sub bl-warn">${FL.icon('warning')}${l.warn}</span>` : ''}</td>
            <td class="r num bl-c-qty">${qty(l.qty, l.unit)}</td>
            <td class="r num bl-c-price">${priceText(l)}</td>
            <td class="r num bl-c-net">${fmt.money(l.amount)}</td>
            <td class="r num bl-c-vat">${fmt.money(l.vat)}</td>
            <td class="r num bl-c-gross">${fmt.money(l.gross)}</td>
            <td class="bl-line-actions bl-c-act">
              ${drillButton(l)}
              ${editable && l.manual ? html`<button class="btn btn--ghost btn--icon btn--sm" type="button" data-action="remove-line" data-id="${l.id}" data-name="${l.name}" aria-label="${`Tétel törlése: ${l.name}`}">${FL.icon('trash')}</button>` : ''}
            </td></tr>`)}
          <tr class="bl-subtotal"><td class="bl-c-label" colspan="3">${g.label} összesen</td><td class="r num bl-c-net">${fmt.money(sum('amount'))}</td>
            <td class="r num bl-c-vat">${fmt.money(sum('vat'))}</td><td class="r num bl-c-gross">${fmt.money(sum('gross'))}</td><td class="bl-c-act"></td></tr>
        </tbody>`;
      })}
      <tfoot><tr><td class="bl-c-label" colspan="3">Összesen nettó</td><td class="r num bl-c-net">${fmt.money(st.net)}</td><td class="r num bl-c-vat">${fmt.money(st.vat)}</td>
        <td class="r num bl-c-gross">${fmt.money(st.gross)}</td><td class="bl-c-act"></td></tr></tfoot>
    </table></div>`;
  }

  const DETAIL_COLUMNS = {
    orders: [
      { key: 'number', label: 'Rendelés', cls: 'num', render: (r) => html`${r.number}${r.external_number ? html`<span class="sub">${r.external_number}</span>` : ''}` },
      { key: 'customer_name', label: 'Vevő' },
      { key: 'shipped_date', label: 'Feladva', cls: 'nowrap', render: (r) => fmt.date(r.shipped_date) },
      { key: 'status', label: 'Állapot', render: (r) => FL.status('order', r.status) },
      { key: 'pieces', label: 'Darab', align: 'r', cls: 'num', render: (r) => fmt.int(r.pieces) },
      { key: 'fee', label: 'Kezelési díj', align: 'r', cls: 'num', render: (r) => fmt.money(r.fee) },
      { key: 'cod_amount', label: 'Utánvét', align: 'r', cls: 'num', render: (r) => (r.cod_amount > 0 ? `${fmt.num(r.cod_amount, 2)} ${r.currency === 'HUF' ? 'Ft' : r.currency}` : '') },
    ],
    inbound: [
      { key: 'date', label: 'Dátum', cls: 'nowrap', render: (r) => fmt.date(r.date) },
      { key: 'sku', label: 'Cikk', render: (r) => html`<span class="num">${r.sku}</span><span class="sub">${r.name}</span>` },
      { key: 'location_code', label: 'Hely', cls: 'num' },
      { key: 'lot', label: 'Sarzs', cls: 'num' },
      { key: 'inbound_number', label: 'Betárolás', cls: 'num', render: (r) => r.inbound_number || '' },
      { key: 'qty', label: 'Mennyiség', align: 'r', cls: 'num', render: (r) => fmt.qty(r.qty) },
    ],
    returns: [
      { key: 'number', label: 'Visszáru', cls: 'num' },
      { key: 'received_date', label: 'Beérkezett', cls: 'nowrap', render: (r) => fmt.date(r.received_date) },
      { key: 'order_number', label: 'Rendelés', cls: 'num', render: (r) => r.order_number || '' },
      { key: 'reason', label: 'Ok' },
      { key: 'pieces', label: 'Darab', align: 'r', cls: 'num', render: (r) => fmt.int(r.pieces) },
    ],
    storage: [
      { key: 'code', label: 'Raktárhely', cls: 'num' },
      { key: 'size_code', label: 'Méret', render: (r) => html`<span class="tag">${r.size_code}</span> ${r.size_name}` },
      { key: 'days', label: 'Napok', align: 'r', cls: 'num', render: (r) => fmt.int(r.days) },
      { key: 'first_date', label: 'Első nap', cls: 'nowrap', render: (r) => fmt.date(r.first_date) },
      { key: 'last_date', label: 'Utolsó nap', cls: 'nowrap', render: (r) => fmt.date(r.last_date) },
      { key: 'price', label: 'Havi ár', align: 'r', cls: 'num', render: (r) => (r.price == null ? 'nincs ár' : fmt.money(r.price)) },
      { key: 'amount', label: 'Arányos díj', align: 'r', cls: 'num', render: (r) => fmt.money(r.amount) },
    ],
    entries: [
      { key: 'date', label: 'Dátum', cls: 'nowrap', render: (r) => fmt.date(r.date) },
      { key: 'kind', label: 'Típus', render: (r) => KIND_LABEL[r.kind] || r.kind },
      { key: 'item_name', label: 'Tétel', render: (r) => (r.kind === 'hourly_work' ? 'Munkaóra' : r.item_name || 'Törölt tétel') },
      { key: 'qty', label: 'Mennyiség', align: 'r', cls: 'num', render: (r) => qty(r.qty, r.unit) },
      { key: 'price', label: 'Egységár', align: 'r', cls: 'num', render: (r) => money(r.price) },
      { key: 'note', label: 'Megjegyzés' },
      { key: 'created_by_name', label: 'Rögzítette' },
    ],
  };

  async function renderStatement(root, ctx, id) {
    const st = await api.get(`/api/billing/statements/${id}`);
    const can = (a) => FL.can('billing', a);
    const inv = st.invoicing || {};
    const period = st.period;
    const drills = [...new Set(st.lines.map((l) => l.detail && l.detail.drill).filter(Boolean))].filter((k) => DRILL[k]);
    const order = ['orders', 'storage', 'inbound', 'returns', 'entries'];
    drills.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const warnings = (st.meta && st.meta.warnings) || [];

    let actions = '';
    if (st.status === 'draft') {
      actions = html`
        ${can('create') ? html`<button class="btn" type="button" data-action="regenerate">${FL.icon('arrow-clockwise')}Újraszámolás</button>` : ''}
        ${can('edit') ? html`<button class="btn" type="button" data-action="add-line">${FL.icon('plus')}Tétel hozzáadása</button>` : ''}
        ${can('delete') ? html`<button class="btn btn--danger" type="button" data-action="delete">${FL.icon('trash')}Törlés</button>` : ''}
        ${can('approve') ? html`<button class="btn btn--primary" type="button" data-action="approve" ${st.stale ? raw('disabled title="Előbb számold újra"') : ''}>${FL.icon('check')}Jóváhagyás</button>` : ''}`;
    } else if (st.status === 'approved') {
      actions = html`
        ${can('approve') ? html`<button class="btn btn--danger" type="button" data-action="void">${FL.icon('x')}Érvénytelenítés</button>
          <button class="btn btn--primary" type="button" data-action="invoice" ${!inv.configured || st.invoice_busy ? raw('disabled') : ''}>${FL.icon('receipt')}Számla kiállítása</button>` : ''}`;
    } else if (st.status === 'invoiced') {
      actions = html`
        ${can('approve') ? html`<button class="btn btn--danger" type="button" data-action="void">${FL.icon('x')}Érvénytelenítés</button>` : ''}
        ${st.invoice_document_id
          ? html`<a class="btn btn--primary" href="${api.documentUrl(st.invoice_document_id, true)}" target="_blank" rel="noopener">${FL.icon('file-text')}Számla PDF</a>`
          : can('approve') ? html`<button class="btn btn--primary" type="button" data-action="invoice">${FL.icon('download-simple')}Számla PDF letöltése újra</button>` : ''}`;
    } else if (st.status === 'void' && can('create')) {
      actions = html`<button class="btn btn--primary" type="button" data-action="regenerate">${FL.icon('arrow-clockwise')}Újrakészítés piszkozatként</button>`;
    }

    const p = st.partner || {};
    const billingAddress = [p.billing_zip || p.zip, p.billing_city || p.city, p.billing_address || p.address].filter(Boolean).join(' ');
    root.innerHTML = String(html`
      ${ui.pageHead({
        crumb: { href: `#/elszamolas?period=${period}`, label: `Elszámolás, ${label(period)}` },
        title: `${st.partner_name}, ${label(period)}`,
        lead: `${st.number} elszámolás`,
        actions: html`<button class="btn" type="button" data-action="export">${FL.icon('download-simple')}CSV</button>${actions}`,
      })}
      ${st.status === 'void' ? ui.notice(html`Érvénytelenítve ${fmt.dateTime(st.voided_at)} (${st.voided_by_name || 'ismeretlen'}): ${st.void_reason}`, 'info') : ''}
      ${st.stale ? ui.notice(html`A piszkozat készítése óta változtak az adatok vagy a tarifák. Friss nettó összeg: <b>${fmt.money(st.fresh.net)}</b>.
        Jóváhagyás előtt számold újra.`, 'warn') : ''}
      ${st.invoice_error ? ui.notice(st.status === 'invoiced' ? st.invoice_error : html`A legutóbbi számlázási kísérlet nem sikerült: ${st.invoice_error}`, st.status === 'invoiced' ? 'warn' : 'danger') : ''}
      ${st.invoice_uncertain && st.status === 'approved' ? ui.notice('Az előző kísérletre nem jött egyértelmű válasz a számlázótól. A következő kísérlet előbb megnézi, elkészült-e már a számla, így nem lesz kétszer kiállítva.', 'info') : ''}
      ${st.invoice_busy ? ui.notice('A számla kiállítása éppen folyamatban van. Frissítsd az oldalt egy perc múlva.', 'info') : ''}
      ${st.status === 'approved' ? invoicingNotice(inv) : ''}
      ${warnings.length ? ui.notice(html`${warnings.map((w) => html`<p>${w}</p>`)}`, 'warn') : ''}
      <div class="bl-summary">
        <section class="panel" aria-labelledby="bl-data">
          <div class="panel__head"><h2 id="bl-data">Adatok</h2>${chip(st.status)}</div>
          <dl class="dl">
            <dt>Ügyfél</dt><dd>${FL.can('partners', 'view') ? html`<a href="#/partnerek/${st.partner_id}">${st.partner_name}</a>` : st.partner_name} <span class="muted">(${st.partner_code})</span></dd>
            <dt>Számlázási cím</dt><dd>${p.billing_name && p.billing_name !== st.partner_name ? html`${p.billing_name}<br>` : ''}${billingAddress || html`<span class="bl-warn">hiányzik</span>`}</dd>
            <dt>Adószám</dt><dd class="num">${p.tax_number || p.eu_vat_number || html`<span class="bl-warn">hiányzik</span>`}</dd>
            <dt>Fizetési határidő</dt><dd>${fmt.int(p.payment_days)} nap</dd>
            <dt>Készült</dt><dd>${fmt.dateTime(st.generated_at)}${st.generated_by_name ? ` (${st.generated_by_name})` : ''}</dd>
            ${st.approved_at ? html`<dt>Jóváhagyta</dt><dd>${st.approved_by_name || ''}, ${fmt.dateTime(st.approved_at)}</dd>` : ''}
            ${st.invoice_number ? html`<dt>Számla</dt><dd><span class="num">${st.invoice_number}</span> <span class="muted">(${st.invoice_provider === 'billingo' ? 'Billingo' : 'Számlázz.hu'}, ${fmt.dateTime(st.invoiced_at)})</span></dd>` : ''}
          </dl>
        </section>
        ${ui.kpis([
          { label: 'Nettó', value: fmt.money(st.net) },
          { label: `ÁFA ${fmt.pct(st.vat_pct, 1)}`, value: fmt.money(st.vat), hint: 'soronként kerekítve' },
          { label: 'Bruttó', value: fmt.money(st.gross) },
        ])}
      </div>
      <section class="bl-section" aria-labelledby="bl-lines-title">
        <h2 id="bl-lines-title">Tételek</h2>
        ${linesTable(st, can('edit'))}
        <p class="small muted">Kerekítés: minden tétel nettó összege egész forintra kerekítve, az ÁFA a kerekített nettóból tételenként, szintén egész forintra. A végösszegek a tételek összegei.</p>
      </section>
      ${drills.length ? html`<section class="panel panel--flush bl-drill" aria-labelledby="bl-drill-title">
        <div class="panel__head"><h2 id="bl-drill-title" tabindex="-1">Részletezés</h2></div>
        <div class="tabs bl-drill__tabs" role="tablist" aria-label="Részletező listák">${drills.map((k, i) => html`
          <button class="tab" type="button" role="tab" id="bl-tab-${k}" aria-selected="${i === 0}" aria-controls="bl-drill-body" data-action="drill-tab" data-kind="${k}">${DRILL[k]}</button>`)}</div>
        <div id="bl-drill-body" role="tabpanel" aria-live="polite"></div>
      </section>` : ''}
      ${st.history && st.history.length ? html`<section class="panel" aria-labelledby="bl-hist">
        <h2 id="bl-hist">Előzmények</h2>
        <ol class="bl-history">${st.history.map((h) => html`<li><span class="num muted">${fmt.dateTime(h.at)}</span><span>${h.actor}</span><span>${h.summary}</span></li>`)}</ol>
      </section>` : ''}`);

    // Drill-down lists, loaded on demand.
    const body = root.querySelector('#bl-drill-body');
    let drillKind = drills[0];
    async function loadDrill(kind, offset = 0) {
      drillKind = kind;
      root.querySelectorAll('[data-action="drill-tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.kind === kind)));
      body.setAttribute('aria-labelledby', `bl-tab-${kind}`);
      body.innerHTML = String(ui.loading());
      try {
        const d = await api.get(`/api/billing/statements/${id}/details`, { kind, limit: 100, offset });
        const base = st.lines.find((l) => l.key === 'handling.order_base');
        body.innerHTML = String(html`
          ${kind === 'orders' && base ? html`<p class="bl-drill__note small">Darabszám szerint: ${bucketText(base.detail.buckets)}. A kezelési díj az elszámolás tarifáival számolva.</p>` : ''}
          ${kind === 'storage' ? html`<p class="bl-drill__note small">Arányos díj = napok x havi ár / ${d.days_in_month} nap. A helyenkénti összegek kerekítés miatt eltérhetnek a méretenkénti tételtől.</p>` : ''}
          ${ui.table({ columns: DETAIL_COLUMNS[kind], rows: d.items, empty: 'Nincs tétel.', caption: DRILL[kind] })}
          ${ui.pager({ total: d.total, limit: d.limit, offset: d.offset })}`);
      } catch (err) {
        body.innerHTML = String(ui.notice(err.message, 'danger'));
      }
    }
    if (drills.length) loadDrill(drills[0]);

    const after = (msg) => { ui.toast(msg, 'ok'); FL.reload(); };
    ui.bind(root, {
      'drill-tab': (el) => loadDrill(el.dataset.kind),
      drill: (el) => {
        loadDrill(el.dataset.kind);
        const h = root.querySelector('#bl-drill-title');
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        h.focus({ preventScroll: true });
      },
      page: (el) => loadDrill(drillKind, Number(el.dataset.offset)),
      export: (el) => ui.run(el, () => api.download(`/api/billing/statements/${id}/export`)),
      regenerate: async (el) => {
        const r = await ui.run(el, () => api.post('/api/billing/statements/generate', { period, partner_ids: [st.partner_id] }));
        if (!r) return;
        if (r.skipped.length) ui.toast(r.skipped[0].reason, 'error');
        else after('Újraszámolva.');
      },
      'add-line': () => ui.dialog({
        title: 'Kézi tétel hozzáadása',
        submitLabel: 'Hozzáadás',
        body: html`<div class="form-grid">
          ${ui.field({ name: 'name', label: 'Megnevezés', required: true, span: 'all', placeholder: 'pl. Raklapfóliázás' })}
          ${ui.field({ name: 'group', label: 'Csoport', type: 'select', value: 'custom', options: st.groups.map((g) => ({ value: g.key, label: g.label })) })}
          ${ui.field({ name: 'qty', label: 'Mennyiség', type: 'number', value: 1, required: true, min: 0.01 })}
          ${ui.field({ name: 'unit', label: 'Egység', value: 'db' })}
          ${ui.field({ name: 'price', label: 'Nettó egységár (Ft)', type: 'number', required: true, hint: 'Jóváíráshoz adj meg negatív árat.' })}
        </div>`,
        onSubmit: async (form) => {
          await api.post(`/api/billing/statements/${id}/lines`, ui.formValues(form));
          after('Tétel hozzáadva.');
        },
      }),
      'remove-line': async (el) => {
        const yes = await ui.confirm({ title: 'Kézi tétel törlése', text: `Törlöd ezt a tételt: ${el.dataset.name}?`, confirmLabel: 'Törlés', tone: 'danger' });
        if (yes && await ui.run(el, () => api.del(`/api/billing/statements/${id}/lines/${encodeURIComponent(el.dataset.id)}`))) after('Tétel törölve.');
      },
      delete: async (el) => {
        const yes = await ui.confirm({ title: 'Piszkozat törlése', text: `Törlöd a(z) ${st.number} piszkozatot? A kézi tételei is elvesznek.`, confirmLabel: 'Törlés', tone: 'danger' });
        if (!yes) return;
        if (await ui.run(el, () => api.del(`/api/billing/statements/${id}`))) { ui.toast('Piszkozat törölve.', 'ok'); FL.go(`#/elszamolas?period=${period}`); }
      },
      approve: async (el) => {
        const yes = await ui.confirm({
          title: 'Elszámolás jóváhagyása',
          text: `${st.partner_name}, ${label(period)}: bruttó ${fmt.money(st.gross)}. Jóváhagyás után a tételek nem módosíthatók, és kiállíthatod a számlát.`,
          confirmLabel: 'Jóváhagyás',
        });
        if (yes && await ui.run(el, () => api.post(`/api/billing/statements/${id}/approve`))) after('Jóváhagyva.');
      },
      invoice: async (el) => {
        if (st.status === 'approved') {
          const yes = await ui.confirm({
            title: 'Számla kiállítása',
            text: `Kiállítjuk a számlát a(z) ${inv.name} rendszerben: ${st.partner_name}, bruttó ${fmt.money(st.gross)}, ${fmt.int(p.payment_days)} napos fizetési határidővel.`,
            confirmLabel: 'Számla kiállítása',
          });
          if (!yes) return;
        }
        const r = await ui.run(el, () => api.post(`/api/billing/statements/${id}/invoice`));
        if (!r) { FL.reload(); return; }
        for (const w of r.warnings || []) ui.toast(w, 'info');
        after(st.status === 'approved' ? `Számla kiállítva: ${r.invoiceNumber}.` : 'Számla PDF letöltve.');
      },
      void: () => ui.dialog({
        title: 'Elszámolás érvénytelenítése',
        submitLabel: 'Érvénytelenítés',
        submitTone: 'danger',
        body: html`
          ${st.status === 'invoiced' ? ui.notice(html`Ehhez az elszámoláshoz már készült számla (<b>${st.invoice_number}</b>). Az érvénytelenítés nem sztornózza a számlát: előbb sztornózd a ${st.invoice_provider === 'billingo' ? 'Billingóban' : 'Számlázz.hu-ban'}.`, 'warn') : ''}
          ${ui.field({ name: 'reason', label: 'Indoklás', type: 'textarea', required: true, rows: 3 })}
          ${st.status === 'invoiced' ? ui.field({ name: 'invoice_cancelled', label: `A(z) ${st.invoice_number} számlát sztornóztam`, type: 'checkbox' }) : ''}
          <p class="small muted">Érvénytelenítés után újra elkészítheted piszkozatként.</p>`,
        onSubmit: async (form) => {
          await api.post(`/api/billing/statements/${id}/void`, ui.formValues(form));
          after('Elszámolás érvénytelenítve.');
        },
      }),
    });
  }

  /* ------------------------------------------------------------ entries */
  async function renderEntries(root, ctx) {
    const period = periodFrom(ctx.query);
    const partner = ctx.query.get('partner') || '';
    const offset = Math.max(0, Number(ctx.query.get('offset')) || 0);
    const [clients, data] = await Promise.all([
      api.get('/api/lookup/partners', { type: 'client' }),
      api.get('/api/billing/entries', { period, partner_id: partner, limit: 100, offset }),
    ]);
    const options = clients.items.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }));
    const can = (a) => FL.can('billing', a);
    const link = (p) => `#/elszamolas/tetelek${FL.qs({ period: p.period ?? period, partner: p.partner ?? partner, offset: p.offset || '' })}`;

    root.innerHTML = String(html`
      ${ui.pageHead({
        title: 'Elszámolás',
        lead: 'Óradíjas munka (szettképzés, átcímkézés) és darabonként számlázott egyedi tételek ügyfelenként és naponta. A havi elszámolás ezekből számol.',
        actions: can('create') ? html`<button class="btn btn--primary" type="button" data-action="new">${FL.icon('plus')}Új tétel</button>` : '',
      })}
      ${tabs('entries', period)}
      <div class="toolbar">
        ${periodPicker(period)}
        ${ui.field({ name: 'partner', id: 'bl-partner', label: 'Ügyfél', type: 'select', value: partner, options, placeholder: 'Minden ügyfél', attrs: 'data-action="partner"' })}
      </div>
      <div class="bl-tablebox">${ui.table({
        caption: `Rögzített tételek, ${label(period)}`,
        rows: data.items,
        empty: 'Ebben a hónapban nincs rögzített tétel.',
        columns: [
          { key: 'date', label: 'Dátum', cls: 'nowrap', render: (r) => fmt.date(r.date) },
          { key: 'partner_name', label: 'Ügyfél', render: (r) => html`${r.partner_name}<span class="sub">${r.partner_code}</span>` },
          { key: 'kind', label: 'Tétel', render: (r) => html`${r.kind === 'hourly_work' ? 'Óradíjas munka' : r.item_name || 'Törölt tétel'}${r.note ? html`<span class="sub">${r.note}</span>` : ''}` },
          { key: 'qty', label: 'Mennyiség', align: 'r', cls: 'num', render: (r) => qty(r.qty, r.unit) },
          { key: 'price', label: 'Egységár', align: 'r', cls: 'num', render: (r) => money(r.price) },
          { key: 'amount', label: 'Összeg', align: 'r', cls: 'num', render: (r) => money(r.amount) },
          { key: 'created_by_name', label: 'Rögzítette', render: (r) => html`${r.created_by_name || ''}<span class="sub">${fmt.dateTime(r.created_at)}</span>` },
          {
            key: 'actions', label: 'Műveletek', render: (r) => (r.locked
              ? html`<span class="chip" title="${`A(z) ${r.statement_number} elszámolás már ${r.statement_status === 'invoiced' ? 'számlázva' : 'jóváhagyva'}`}">Lezárt hónap</span>`
              : html`<span class="actions bl-row-actions">
                ${can('edit') ? html`<button class="btn btn--ghost btn--icon btn--sm" type="button" data-action="edit" data-id="${r.id}" aria-label="Szerkesztés">${FL.icon('pencil-simple')}</button>` : ''}
                ${can('delete') ? html`<button class="btn btn--ghost btn--icon btn--sm" type="button" data-action="remove" data-id="${r.id}" aria-label="Törlés">${FL.icon('trash')}</button>` : ''}
              </span>`),
          },
        ],
      })}
      ${ui.pager({ total: data.total, limit: data.limit, offset: data.offset })}</div>`);

    const byId = new Map(data.items.map((e) => [e.id, e]));
    ui.bind(root, {
      ...periodHandlers((p) => FL.go(link({ period: p, offset: 0 })), period),
      partner: (el) => FL.go(link({ partner: el.value, offset: 0 })),
      page: (el) => FL.go(link({ offset: Number(el.dataset.offset) })),
      new: () => entryDialog({ clients: options, partner }),
      edit: (el) => entryDialog({ clients: options, entry: byId.get(Number(el.dataset.id)) }),
      remove: async (el) => {
        const e = byId.get(Number(el.dataset.id));
        const yes = await ui.confirm({ title: 'Tétel törlése', text: `Törlöd: ${e.partner_name}, ${fmt.date(e.date)}, ${qty(e.qty, e.unit)}?`, confirmLabel: 'Törlés', tone: 'danger' });
        if (yes && await ui.run(el, () => api.del(`/api/billing/entries/${e.id}`))) { ui.toast('Tétel törölve.', 'ok'); FL.reload(); }
      },
    });
  }

  function entryDialog({ clients, entry = null, partner = '' }) {
    const e = entry || { partner_id: partner, date: FL.today(), kind: 'hourly_work', qty: '', note: '', custom_item_id: '' };
    ui.dialog({
      title: entry ? 'Tétel módosítása' : 'Új tétel',
      submitLabel: entry ? 'Mentés' : 'Rögzítés',
      body: html`<div class="form-grid">
        ${ui.field({ name: 'partner_id', label: 'Ügyfél', type: 'select', value: e.partner_id, options: clients, placeholder: 'Válassz ügyfelet', required: true, span: 'all', attrs: entry ? 'disabled data-type="int"' : 'data-type="int"' })}
        ${ui.field({ name: 'date', label: 'Dátum', type: 'date', value: e.date, required: true, max: FL.today() })}
        ${ui.field({ name: 'kind', label: 'Típus', type: 'select', value: e.kind, options: [{ value: 'hourly_work', label: 'Óradíjas munka' }, { value: 'custom', label: 'Egyedi tétel (darabonként)' }] })}
        <div class="field span-all" data-custom hidden>
          <label for="bl-item">Egyedi tétel</label>
          <select class="select" id="bl-item" name="custom_item_id" data-type="int" aria-describedby="bl-item-err"></select>
          <span class="field__hint">Az ügyfél Tarifák fülén felvett, darabonként számlázott tételek.</span>
          <p class="field__error" id="bl-item-err" hidden></p>
        </div>
        ${ui.field({ name: 'qty', label: 'Mennyiség', type: 'number', value: e.qty, required: true, min: 0.01, hint: 'Óradíjas munkánál órában.' })}
        ${ui.field({ name: 'note', label: 'Megjegyzés', type: 'textarea', value: e.note, rows: 2, span: 'all', optional: true })}
      </div>`,
      onOpen: ({ form }) => {
        const kind = form.querySelector('[name="kind"]');
        const client = form.querySelector('[name="partner_id"]');
        const box = form.querySelector('[data-custom]');
        const select = form.querySelector('[name="custom_item_id"]');
        const sync = async () => {
          box.hidden = kind.value !== 'custom';
          select.disabled = box.hidden;
          if (box.hidden) return;
          if (!client.value) { select.innerHTML = String(ui.options([], '', 'Előbb válassz ügyfelet')); return; }
          try {
            const { items } = await api.get('/api/billing/custom-items', { partner_id: client.value });
            const list = items.filter((i) => i.kind === 'per_unit' && i.active).map((i) => ({ value: i.id, label: `${i.name} (${fmt.money(i.price, 2)} / ${i.unit})` }));
            select.innerHTML = String(list.length ? ui.options(list, e.custom_item_id, 'Válassz tételt') : ui.options([], '', 'Nincs darabonkénti egyedi tétel'));
          } catch (err) {
            ui.toast(err.message, 'error');
          }
        };
        kind.addEventListener('change', sync);
        client.addEventListener('change', sync);
        sync();
      },
      onSubmit: async (form) => {
        const v = ui.formValues(form);
        if (v.kind !== 'custom') v.custom_item_id = null;
        if (entry) {
          delete v.partner_id;
          await api.patch(`/api/billing/entries/${entry.id}`, v);
          ui.toast('Tétel mentve.', 'ok');
        } else {
          await api.post('/api/billing/entries', v);
          ui.toast('Tétel rögzítve.', 'ok');
        }
        FL.reload();
      },
    });
  }

  // views/*.js load before core/app.js (which defines FL.view), so register directly when needed;
  // app.js keeps FL.views that already exist.
  const register = FL.view || ((key, def) => { (FL.views = FL.views || {})[key] = def; });
  register('billing', {
    title: 'Elszámolás',
    async render(root, ctx) {
      const [first] = ctx.params;
      if (first === 'tetelek') return renderEntries(root, ctx);
      if (first && /^\d+$/.test(first)) return renderStatement(root, ctx, Number(first));
      return renderOverview(root, ctx);
    },
  });
})();
