/* Leltár (#/leltar): inventory counts.
     #/leltar                    list with filters, "Új leltár" dialog
     #/leltar/:id                detail: lines grouped by location (walking order)
     #/leltar/:id/szamlalas      counting screen for a hand scanner, location by location
     #/leltar/:id/ellenorzes     review: differences, stock-changed lines, posting
     #/leltar/:id/iv             printable count sheet
   Blind counts: the API leaves out expected quantities for users who may not see them
   (can_see_expected), so the screens simply show what they get. */
(() => {
  'use strict';
  const FL = window.FL;
  const { html, raw, ui, api, fmt } = FL;

  const TYPES = { cycle: 'Ciklikus', zone: 'Zóna', product: 'Termék', full: 'Teljes', locations: 'Kijelölt helyek' };
  const STATUS_FILTER = [
    ['active', 'Folyamatban'], ['all', 'Mind'], ['open', 'Nyitott'], ['counting', 'Számlálás alatt'],
    ['counted', 'Könyvelésre vár'], ['posted', 'Könyvelve'], ['cancelled', 'Törölve'],
  ];
  const ACTIVE = ['open', 'counting', 'counted'];
  const base = (id) => `#/leltar/${id}`;
  const qtyText = (v) => (v == null ? '' : fmt.int(v));
  const diffText = (d) => (d == null ? '' : d > 0 ? `+${fmt.int(d)}` : fmt.int(d));
  const diffCls = (d) => (d > 0 ? 'diff-pos' : d < 0 ? 'diff-neg' : '');
  const lotText = (l) => [l.lot, l.expiry ? fmt.date(l.expiry) : ''].filter(Boolean).join(' · ');

  function progressBar(done, total, label) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return html`<div class="cnt-progress">
      <div class="progress" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" data-done="${total > 0 && done === total}"><span style="width:${pct}%"></span></div>
      <span class="small muted num">${fmt.int(done)} / ${fmt.int(total)} ${label}</span>
    </div>`;
  }

  const locState = (l) => (l.done ? html`<span class="chip" data-tone="ok">Kész</span>` : l.counted ? html`<span class="chip" data-tone="warn">Folyamatban</span>` : html`<span class="chip">Nincs számolva</span>`);

  /* ------------------------------------------------------------ list */
  async function renderList(root, ctx) {
    const q = ctx.query;
    const filters = { status: q.get('status') || 'active', type: q.get('type') || '', q: q.get('q') || '' };
    const offset = Number(q.get('offset')) || 0;
    const limit = 50;
    const data = await api.get('/api/counts', { ...filters, limit, offset });
    // "active" is the default status, so it is left out of the address.
    const go = (changes) => {
      const next = { ...filters, offset: 0, ...changes };
      if (next.status === 'active') next.status = '';
      FL.go(`#/leltar${FL.qs(next)}`);
    };

    root.innerHTML = String(html`
      ${ui.pageHead({
        title: 'Leltár',
        lead: 'Ciklikus, zóna, termék és teljes leltárak. Számlálás helyenként, kézi szkennerrel; az eltéréseket jóváhagyással könyveljük.',
        actions: FL.can('counts', 'create') ? html`<button class="btn btn--primary" type="button" data-action="new">${FL.icon('plus')}Új leltár</button>` : '',
      })}
      <form class="toolbar" data-filters role="search">
        ${ui.field({ name: 'status', label: 'Állapot', type: 'select', options: STATUS_FILTER, value: filters.status })}
        ${ui.field({ name: 'type', label: 'Típus', type: 'select', options: Object.entries(TYPES), value: filters.type, placeholder: 'Mind' })}
        <div class="field field--grow"><label for="cnt-q">Keresés</label>
          <div class="input-group"><input class="input" id="cnt-q" name="q" type="search" value="${filters.q}" placeholder="Szám, hely, cikkszám vagy megjegyzés">
          <button class="btn" type="submit" aria-label="Keresés">${FL.icon('magnifying-glass')}</button></div></div>
      </form>
      ${ui.table({
        caption: 'Leltárak',
        empty: filters.status === 'active' ? 'Nincs folyamatban lévő leltár.' : 'Nincs a szűrésnek megfelelő leltár.',
        rows: data.items,
        rowHref: (r) => base(r.id),
        columns: [
          { key: 'number', label: 'Szám', render: (r) => html`<a class="num" href="${base(r.id)}">${r.number}</a>${r.blind ? html` <span class="tag" title="Vak leltár: a raktárosok nem látják a nyilvántartott mennyiséget">vak</span>` : ''}` },
          { key: 'type', label: 'Típus', render: (r) => html`${TYPES[r.type] || r.type}<span class="sub cnt-scope">${r.scope}</span>` },
          { key: 'status', label: 'Állapot', render: (r) => FL.status('count', r.status) },
          { key: 'progress', label: 'Haladás', cls: 'cnt-col-progress', render: (r) => progressBar(r.done_locations, r.locations, 'hely') },
          { key: 'diff_lines', label: 'Eltérő tétel', align: 'r', cls: 'num', render: (r) => (r.diff_lines == null ? html`<span class="muted" title="Vak leltár: könyvelés előtt csak jóváhagyó látja">rejtett</span>` : r.counted_lines ? fmt.int(r.diff_lines) : '') },
          { key: 'created_at', label: 'Indította', render: (r) => html`${r.created_by_name || ''}<span class="sub">${fmt.dateTime(r.created_at)}</span>` },
        ],
      })}
      ${ui.pager({ total: data.total, limit, offset })}`);

    ui.enableRowLinks(root);
    const form = root.querySelector('[data-filters]');
    form.addEventListener('change', (e) => { if (e.target.name !== 'q') go({ [e.target.name]: e.target.value }); });
    form.addEventListener('submit', (e) => { e.preventDefault(); go({ q: form.elements.q.value.trim() }); });
    ui.bind(root, {
      new: (el) => ui.run(el, openCreate),
      page: (el) => go({ offset: el.dataset.offset }),
    });
  }

  /* ------------------------------------------------------------ create dialog */
  async function openCreate() {
    const opts = await api.get('/api/counts/options');
    const zones = opts.zones.map((z) => ({ value: z.zone, label: `${z.zone} zóna (${fmt.int(z.locations)} hely)` }));
    const chosen = new Map();
    const group = (type, inner) => html`<fieldset class="form-grid" data-for="${type}" hidden><legend class="visually-hidden">${TYPES[type]} leltár beállításai</legend>${inner}</fieldset>`;
    ui.dialog({
      title: 'Új leltár',
      submitLabel: 'Leltár indítása',
      body: html`
        <div class="form-grid">
          ${ui.field({ name: 'type', label: 'Típus', type: 'select', value: 'cycle', options: [
            ['cycle', 'Ciklikus: a legrégebben számolt helyek'], ['zone', 'Zóna: egy zóna minden helye'], ['product', 'Termék: ahol a kiválasztott termékek vannak'],
            ['full', 'Teljes: minden aktív tárolóhely'], ['locations', 'Kijelölt helyek: kódok listája'],
          ], span: 'all' })}
        </div>
        ${group('cycle', html`
          ${ui.field({ name: 'limit', label: 'Helyek száma', type: 'number', int: true, value: 20, min: 1, max: 500, required: true })}
          ${ui.field({ name: 'zone', label: 'Zóna', type: 'select', options: zones, placeholder: 'Bármely zóna', optional: true })}
          <p class="small muted span-all">Előbb a még soha nem számolt, aztán a legrégebben számolt helyek, bejárási sorrendben. A nyitott leltárban lévő helyek kimaradnak.</p>`)}
        ${group('zone', ui.field({ name: 'zone', label: 'Zóna', type: 'select', options: zones, placeholder: 'Válassz zónát', required: true }))}
        ${group('product', html`
          <div class="field span-all"><label for="cnt-product">Termékek</label>
            <input class="input" id="cnt-product" name="product_ids" type="text" placeholder="Cikkszám, név vagy EAN" autocomplete="off">
            <span class="field__hint">Minden hely bekerül, ahol a kiválasztott termékekből készlet van. Legfeljebb 40 termék.</span>
            <p class="field__error" hidden></p>
            <ul class="cnt-chosen" data-chosen></ul></div>`)}
        ${group('full', html`<div class="span-all">${ui.notice(`Minden aktív tárolóhely bekerül (${fmt.int(opts.storage_locations)} hely). Nagy raktárnál érdemes zónánként haladni.`, 'info')}</div>`)}
        ${group('locations', ui.field({ name: 'location_codes', label: 'Raktárhelyek', type: 'textarea', rows: 4, required: true, span: 'all',
          placeholder: 'A-01-01\nA-01-02', hint: 'Egy sorba egy kód, vagy vesszővel, szóközzel elválasztva. Legfeljebb 500 hely.' }))}
        <div class="form-grid">
          ${ui.field({ name: 'blind', label: 'Vak leltár', type: 'checkbox', value: true, span: 'all', hint: 'A számlálók nem látják a nyilvántartott mennyiséget, csak a jóváhagyók.' })}
          ${ui.field({ name: 'note', label: 'Megjegyzés', type: 'textarea', rows: 2, optional: true, span: 'all' })}
        </div>
        ${opts.locations_in_open_counts ? ui.notice(`${fmt.int(opts.locations_in_open_counts)} hely már egy nyitott leltárban van. Egy hely egyszerre csak egy leltárban lehet.`, 'info') : ''}`,
      onOpen: ({ form }) => {
        const typeSel = form.elements.type;
        const show = () => {
          form.querySelectorAll('[data-for]').forEach((fs) => {
            const on = fs.dataset.for === typeSel.value;
            fs.hidden = !on;
            fs.disabled = !on;
          });
        };
        typeSel.addEventListener('change', show);
        show();
        const list = form.querySelector('[data-chosen]');
        const paint = () => {
          list.innerHTML = String(html`${[...chosen.values()].map((p) => html`<li><span class="num">${p.sku}</span> ${p.name}
            <button class="btn btn--ghost btn--icon btn--sm" type="button" data-remove="${p.id}" aria-label="${p.sku} eltávolítása">${FL.icon('x')}</button></li>`)}`);
        };
        list.addEventListener('click', (e) => {
          const b = e.target.closest('[data-remove]');
          if (b) { chosen.delete(Number(b.dataset.remove)); paint(); }
        });
        const input = form.querySelector('#cnt-product');
        ui.autocomplete(input, {
          source: ui.sources.products(),
          label: ui.productLabel,
          sub: (p) => [p.partner_code, p.ean].filter(Boolean).join(' · '),
          onSelect: (p) => { chosen.set(p.id, p); input.value = ''; paint(); input.focus(); },
        });
      },
      onSubmit: async (form) => {
        const v = ui.formValues(form);
        const payload = { type: v.type, blind: v.blind, note: v.note || '' };
        if (v.type === 'cycle') Object.assign(payload, { limit: v.limit, zone: v.zone || null });
        if (v.type === 'zone') payload.zone = v.zone;
        if (v.type === 'product') payload.product_ids = [...chosen.keys()];
        if (v.type === 'locations') payload.location_codes = String(v.location_codes || '').split(/[\s,;]+/).filter(Boolean);
        const res = await api.post('/api/counts', payload);
        ui.toast(`${res.number} elindítva: ${fmt.int(res.locations)} hely, ${fmt.int(res.lines)} tétel.`, 'ok');
        FL.go(base(res.id));
      },
    });
  }

  /* ------------------------------------------------------------ detail */
  // Which of "count" and "review" the user may do now, the main one first.
  function nextSteps(c) {
    const canCount = ACTIVE.includes(c.status) && FL.can('counts', 'edit');
    const canReview = ['counting', 'counted'].includes(c.status) && FL.can('counts', 'approve');
    const steps = [];
    if (c.status === 'counted' && canReview) steps.push('review');
    if (canCount) steps.push('count');
    if (canReview && !steps.includes('review')) steps.push('review');
    return steps;
  }

  function lineRows(loc, visible, { showWho = true } = {}) {
    const items = loc.items || [];
    const hasGoods = items.some((l) => l.product_id);
    return items.filter((l) => l.product_id || !hasGoods).map((l) => {
      if (!l.product_id) {
        return html`<tr><td colspan="${3 + (visible ? 2 : 0) + (showWho ? 2 : 1)}" class="muted">Nyilvántartás szerint üres hely${l.counted_qty === 0 ? ': üresnek számolva' : ''}</td></tr>`;
      }
      const diff = visible && l.counted_qty != null ? (l.posted ? l.posted_diff : l.counted_qty - l.expected_qty) : null;
      return html`<tr class="${diff > 0 ? 'cnt-row--surplus' : diff < 0 ? 'cnt-row--shortage' : ''}">
        <td><span class="num">${l.sku}</span>${l.added ? html` <span class="chip" data-tone="warn">talált</span>` : ''}<span class="sub">${l.name}</span></td>
        <td class="nowrap">${lotText(l)}</td>
        ${visible ? html`<td class="r num">${qtyText(l.expected_qty)}</td>` : ''}
        <td class="r num">${l.counted_qty == null ? html`<span class="muted">nincs</span>` : qtyText(l.counted_qty)}</td>
        ${visible ? html`<td class="r num ${diffCls(diff)}">${diff ? diffText(diff) : ''}</td>` : ''}
        ${showWho ? html`<td>${l.counted_by_name}<span class="sub">${l.counted_at ? fmt.dateTime(l.counted_at) : ''}</span></td>` : ''}
      </tr>`;
    });
  }

  async function renderDetail(root, id) {
    const c = await api.get(`/api/counts/${id}`);
    const visible = c.can_see_expected;
    const [primary, ...secondary] = nextSteps(c);
    const btn = (kind, cls = '') => {
      if (kind === 'count') return html`<a class="btn ${cls}" href="${base(c.id)}/szamlalas">${FL.icon('scan')}${c.status === 'open' ? 'Számlálás indítása' : 'Számlálás'}</a>`;
      return html`<a class="btn ${cls}" href="${base(c.id)}/ellenorzes">${FL.icon('list-checks')}Ellenőrzés és könyvelés</a>`;
    };
    const p = c.progress;
    const diffLines = visible ? c.locations.flatMap((l) => l.items || []).filter((l) => l.product_id && l.counted_qty != null
      && (l.posted ? l.posted_diff : l.counted_qty - l.expected_qty) !== 0).length : null;
    root.innerHTML = String(html`
      ${ui.pageHead({
        crumb: { href: '#/leltar', label: 'Leltár' },
        title: html`${c.number} ${FL.status('count', c.status)}`,
        lead: `${c.type_label}: ${c.scope}`,
        actions: html`
          <a class="btn" href="${base(c.id)}/iv">${FL.icon('printer')}Leltárív</a>
          ${ACTIVE.includes(c.status) && FL.can('counts', 'delete') ? html`<button class="btn btn--danger" type="button" data-action="cancel">${FL.icon('trash')}Törlés</button>` : ''}
          ${secondary.map((k) => btn(k))}
          ${primary ? btn(primary, 'btn--primary') : ''}`,
      })}
      ${ui.kpis([
        { label: 'Helyek', value: `${fmt.int(p.done_locations)} / ${fmt.int(p.locations)}`, hint: 'kész / összes' },
        { label: 'Tételek', value: `${fmt.int(p.counted_lines)} / ${fmt.int(p.lines)}`, hint: 'számolt / összes' },
        visible ? { label: 'Eltérő tétel', value: fmt.int(diffLines), tone: diffLines ? 'warn' : '' } : { label: 'Vak leltár', value: 'igen', hint: 'a mennyiség könyvelés után látszik' },
      ])}
      <div class="grid-2 cnt-detail">
        <section class="panel">
          <div class="panel__head"><h2>Adatok</h2></div>
          <dl class="dl">
            <dt>Típus</dt><dd>${c.type_label}</dd>
            <dt>Hatókör</dt><dd>${c.scope}</dd>
            <dt>Vak leltár</dt><dd>${c.blind ? 'Igen' : 'Nem'}</dd>
            <dt>Indította</dt><dd>${c.created_by_name || ''} · ${fmt.dateTime(c.created_at)}</dd>
            ${c.started_at ? html`<dt>Számlálás kezdete</dt><dd>${fmt.dateTime(c.started_at)}</dd>` : ''}
            ${c.counted_at ? html`<dt>Számlálva</dt><dd>${fmt.dateTime(c.counted_at)}</dd>` : ''}
            ${c.posted_at ? html`<dt>Könyvelte</dt><dd>${c.posted_by_name || ''} · ${fmt.dateTime(c.posted_at)}</dd>` : ''}
            ${c.cancelled_at ? html`<dt>Törölve</dt><dd>${fmt.dateTime(c.cancelled_at)}</dd>` : ''}
            ${c.note ? html`<dt>Megjegyzés</dt><dd>${c.note}</dd>` : ''}
          </dl>
        </section>
        <section class="panel">
          <div class="panel__head"><h2>Haladás</h2></div>
          ${progressBar(p.done_locations, p.locations, 'hely kész')}
          ${progressBar(p.counted_lines, p.lines, 'tétel számolva')}
          ${c.status === 'counted' && p.counted_lines < p.lines ? ui.notice(`${fmt.int(p.lines - p.counted_lines)} tétel nincs számolva: ezek nem változnak a könyveléskor.`, 'warn') : ''}
          ${c.status === 'posted' ? ui.notice('Az eltérések könyvelve, a készlet a számolt mennyiségre állt.', 'ok') : ''}
        </section>
      </div>
      <section class="panel panel--flush">
        <div class="panel__head"><h2>Tételek helyenként</h2><span class="small muted">bejárási sorrendben</span></div>
        <div class="table-wrap"><table class="table cnt-lines">
          <caption class="visually-hidden">Leltártételek helyenként</caption>
          <thead><tr><th scope="col">Termék</th><th scope="col">Lot · lejárat</th>${visible ? html`<th scope="col" class="r">Várható</th>` : ''}
            <th scope="col" class="r">Számolt</th>${visible ? html`<th scope="col" class="r">Eltérés</th>` : ''}<th scope="col">Számolta</th></tr></thead>
          ${c.locations.map((loc) => html`<tbody>
            <tr class="cnt-group"><th scope="rowgroup" colspan="${visible ? 6 : 4}"><span class="num">${loc.code}</span> <span class="muted small">${loc.zone ? `${loc.zone} zóna` : ''}</span> ${locState(loc)}</th></tr>
            ${lineRows(loc, visible)}
          </tbody>`)}
        </table></div>
      </section>`);

    ui.bind(root, {
      cancel: async (el) => {
        if (!(await ui.confirm({ title: 'Leltár törlése', text: `Biztosan törlöd a(z) ${c.number} leltárt? A rögzített számolások elvesznek, a készlet nem változik.`, confirmLabel: 'Törlés', tone: 'danger' }))) return;
        await ui.run(el, async () => {
          await api.del(`/api/counts/${c.id}`);
          ui.toast(`${c.number} törölve.`, 'ok');
          FL.reload();
        });
      },
    });
  }

  /* ------------------------------------------------------------ counting (hand scanner) */
  async function renderCounting(root, id, ctx) {
    const c = await api.get(`/api/counts/${id}`, { lines: 0 });
    if (!ACTIVE.includes(c.status)) {
      root.innerHTML = String(html`${ui.pageHead({ crumb: { href: base(c.id), label: c.number }, title: 'Számlálás' })}
        ${ui.notice(`A(z) ${c.number} leltár ${FL.statusLabel('count', c.status).toLowerCase()}, már nem számolható.`, 'info')}`);
      return undefined;
    }
    if (!FL.can('counts', 'edit')) {
      root.innerHTML = String(html`${ui.pageHead({ crumb: { href: base(c.id), label: c.number }, title: 'Számlálás' })}
        ${ui.notice('A számlálás rögzítéséhez nincs jogosultságod.', 'warn')}`);
      return undefined;
    }
    const state = {
      locations: c.locations,
      progress: c.progress,
      current: null, // location state from the API
      feedback: null, // { tone, text }
      flash: null, // line id to highlight
    };
    const scanId = 'cnt-scan';

    const setUrl = () => {
      const hash = `${base(c.id)}/szamlalas${state.current ? FL.qs({ hely: state.current.location.id }) : ''}`;
      try { history.replaceState(null, '', hash); } catch { /* ignore */ }
    };
    const nextLocation = () => {
      const list = state.locations;
      const at = state.current ? list.findIndex((l) => l.location_id === state.current.location.id) : -1;
      return list.slice(at + 1).find((l) => !l.done) || list.find((l) => !l.done) || null;
    };
    const apply = (res) => {
      state.current = res;
      state.progress = res.progress;
      const l = state.locations.find((x) => x.location_id === res.location.id);
      if (l) {
        l.lines = res.lines.length;
        l.counted = res.lines.filter((x) => x.counted_qty != null).length;
        l.done = res.location.done;
      }
    };
    const say = (text, tone = 'ok') => {
      state.feedback = { text, tone };
      if (tone === 'danger' && navigator.vibrate) { try { navigator.vibrate([80, 60, 80]); } catch { /* ignore */ } }
    };

    function lineCard(l, visible) {
      const uncounted = l.counted_qty == null;
      return html`<li class="cnt-line ${uncounted ? '' : 'is-counted'} ${state.flash === l.id ? 'is-flash' : ''}" data-line="${l.id}">
        <div class="cnt-line__info">
          <p><b class="num">${l.sku}</b>${l.added ? html` <span class="chip" data-tone="warn">talált</span>` : ''}</p>
          <p class="cnt-line__name">${l.name}</p>
          <p class="small muted">${[lotText(l) && `Lot: ${lotText(l)}`, l.ean && `EAN ${l.ean}`].filter(Boolean).join(' · ')}</p>
          ${visible ? html`<p class="small">Nyilvántartás: <b class="num">${fmt.int(l.expected_qty)}</b> ${l.unit}</p>` : ''}
          ${!uncounted && l.counted_by_name ? html`<p class="small muted">${l.counted_by_name}, ${fmt.time(l.counted_at)}</p>` : ''}
        </div>
        <div class="cnt-line__qty">
          <button class="btn btn--icon" type="button" data-action="dec" data-line="${l.id}" aria-label="${l.sku}: eggyel kevesebb">${FL.icon('minus')}</button>
          <label class="visually-hidden" for="qty-${l.id}">${l.sku} számolt mennyiség</label>
          <input class="input input--num cnt-qty" id="qty-${l.id}" type="number" min="0" step="1" inputmode="numeric" data-line="${l.id}" value="${l.counted_qty ?? ''}" placeholder="?">
          <button class="btn btn--icon" type="button" data-action="inc" data-line="${l.id}" aria-label="${l.sku}: eggyel több">${FL.icon('plus')}</button>
          ${l.added ? html`<button class="btn btn--ghost btn--icon" type="button" data-action="remove-line" data-line="${l.id}" aria-label="${l.sku} talált tétel törlése">${FL.icon('trash')}</button>` : ''}
        </div>
      </li>`;
    }

    function locationPanel() {
      const cur = state.current;
      const visible = cur.count.can_see_expected;
      const goods = cur.lines.filter((l) => l.product_id);
      const empty = cur.lines.find((l) => !l.product_id);
      const left = goods.filter((l) => l.counted_qty == null).length;
      return html`<section class="panel cnt-loc" aria-labelledby="cnt-loc-title">
        <div class="cnt-loc__head">
          <div><p class="small muted">Raktárhely${cur.location.zone ? `, ${cur.location.zone} zóna` : ''}</p>
            <h2 id="cnt-loc-title" class="cnt-loc__code num">${cur.location.code}</h2></div>
          ${cur.location.done ? html`<span class="chip" data-tone="ok">Kész</span>` : left ? html`<span class="chip" data-tone="warn">${left} tétel számolatlan</span>` : ''}
        </div>
        ${!goods.length ? ui.notice(visible || empty ? 'Nyilvántartás szerint üres hely. Ha árut találsz, olvasd be, különben jelöld késznek.' : 'Nincs nyilvántartott áru.', 'info') : ''}
        ${goods.length ? html`<ul class="cnt-lines-list">${goods.map((l) => lineCard(l, visible))}</ul>` : ''}
        <div class="cnt-loc__actions">
          <button class="btn btn--primary btn--lg" type="button" data-action="complete">${FL.icon('check')}Hely kész</button>
          <button class="btn" type="button" data-action="add-product">${FL.icon('plus-circle')}Talált termék</button>
          <button class="btn" type="button" data-action="recount">${FL.icon('arrow-clockwise')}Újraszámolás</button>
          <button class="btn btn--ghost" type="button" data-action="leave">${FL.icon('arrow-left')}Helyek</button>
        </div>
      </section>`;
    }

    function chooser() {
      const next = nextLocation();
      return html`<section class="panel cnt-next">
        ${next ? html`<p class="small muted">Következő hely bejárási sorrendben</p>
          <p class="cnt-loc__code num">${next.code}</p>
          <p>Menj a helyhez, és olvasd be a hely címkéjét.</p>
          <div class="actions"><button class="btn btn--primary btn--lg" type="button" data-action="open" data-id="${next.location_id}">${FL.icon('map-pin')}Számlálás itt: ${next.code}</button></div>`
        : html`${ui.notice('Minden hely kész. Fejezd be a számlálást, hogy a jóváhagyó könyvelhesse az eltéréseket.', 'ok')}
          <div class="actions"><button class="btn btn--primary btn--lg" type="button" data-action="finish">${FL.icon('check-circle')}Számlálás befejezése</button></div>`}
      </section>`;
    }

    function paint() {
      const p = state.progress;
      const fb = state.feedback;
      root.innerHTML = String(html`
        ${ui.pageHead({
          crumb: { href: base(c.id), label: c.number },
          title: 'Számlálás',
          lead: `${c.type_label}: ${c.scope}${c.blind ? '. Vak leltár.' : ''}`,
          actions: state.current || nextLocation() ? html`<button class="btn" type="button" data-action="finish">${FL.icon('check-circle')}Befejezés</button>` : '',
        })}
        <div class="cnt-count">
          ${progressBar(p.done_locations, p.locations, 'hely kész')}
          ${ui.scan({ id: scanId, label: state.current ? 'Termék (EAN vagy cikkszám) vagy következő hely beolvasása' : 'Raktárhely beolvasása',
            placeholder: state.current ? 'Termék vagy hely' : 'Raktárhely kódja' })}
          <p class="cnt-feedback" role="status" aria-live="polite" data-tone="${fb ? fb.tone : ''}">${fb ? fb.text : ''}</p>
          ${state.current ? locationPanel() : chooser()}
          <section class="cnt-locs" aria-label="Helyek">
            <h2 class="small muted">Helyek (${fmt.int(state.locations.length)})</h2>
            <ul>${state.locations.map((l) => html`<li><button type="button" class="cnt-locbtn" data-action="open" data-id="${l.location_id}"
              data-state="${l.done ? 'done' : l.counted ? 'partial' : 'todo'}" ${state.current && state.current.location.id === l.location_id ? raw('aria-current="true"') : ''}>
              <span class="num">${l.code}</span><span class="visually-hidden">${l.done ? ' kész' : l.counted ? ' folyamatban' : ' számolatlan'}</span></button></li>`)}</ul>
          </section>
        </div>`);
      const input = ui.bindScan(root, scanId, onScan);
      if (input) input.focus({ preventScroll: true });
      state.flash = null;
    }

    // Entries run one after the other (a scan right after typing a quantity must not overtake it).
    let queue = Promise.resolve();
    function act(fn, el) {
      const run = async () => {
        try {
          if (el) { el.setAttribute('aria-busy', 'true'); el.disabled = true; }
          const res = await fn();
          if (res) apply(res);
          return res;
        } catch (err) {
          say(err.message || 'Hiba történt.', 'danger');
          if (!(err instanceof FL.ApiError)) console.error(err);
          return undefined;
        } finally {
          paint();
        }
      };
      const p = queue.then(run, run);
      queue = p.catch(() => {});
      return p;
    }

    async function openLocation(locationId, viaScan = false) {
      await act(async () => {
        const res = await api.get(`/api/counts/${c.id}/locations/${locationId}`);
        say(viaScan ? `${res.location.code}: olvasd be a termékeket.` : `${res.location.code} megnyitva.`, 'info');
        return res;
      });
      setUrl();
    }

    const findLine = (lineId) => state.current && state.current.lines.find((l) => l.id === Number(lineId));

    async function addTo(line, add) {
      await act(async () => {
        const res = await api.put(`/api/counts/${c.id}/lines/${line.id}`, { add });
        const now = res.lines.find((l) => l.id === line.id);
        state.flash = line.id;
        say(`${line.sku}${line.lot ? ` (${line.lot})` : ''}: ${fmt.int(now ? now.counted_qty : 0)} ${line.unit}`, 'ok');
        return res;
      });
    }

    async function setQty(line, value) {
      const qty = value === '' ? null : Number(value);
      if (qty != null && (!Number.isInteger(qty) || qty < 0)) { say('A mennyiség nem negatív egész szám legyen.', 'danger'); paint(); return; }
      if (qty === line.counted_qty) return;
      await act(async () => {
        const res = await api.put(`/api/counts/${c.id}/lines/${line.id}`, { counted_qty: qty });
        state.flash = line.id;
        say(qty == null ? `${line.sku}: számolás törölve.` : `${line.sku}: ${fmt.int(qty)} ${line.unit}`, 'ok');
        return res;
      });
    }

    async function foundDialog(products, code) {
      const cur = state.current;
      const single = products.length === 1 ? products[0] : null;
      const other = products.find((p) => !p.same_partner);
      const dlg = ui.dialog({
        title: 'Talált termék',
        submitLabel: 'Felvétel',
        size: 'narrow',
        body: html`
          <p>A(z) <b class="num">${cur.location.code}</b> helyen nincs nyilvántartva${code ? html`: <span class="num">${code}</span>` : ''}.</p>
          ${single ? html`<p><b class="num">${single.sku}</b> ${single.name}<span class="small muted"> · ${single.partner_name}</span></p><input type="hidden" name="product_id" value="${single.id}">`
          : ui.field({ name: 'product_id', label: 'Termék', type: 'select', required: true, options: products.map((p) => ({ value: p.id, label: `${p.sku} ${p.name} (${p.partner_code})` })) })}
          ${other ? ui.notice(`${single ? 'Ez a termék' : 'Van köztük olyan termék, amely'} másik ügyfélé, mint a hely többi áruja. Egy helyen csak egy ügyfél áruja lehet: jelezd a raktárvezetőnek.`, 'warn') : ''}
          <div class="form-grid">
            ${ui.field({ name: 'counted_qty', label: 'Mennyiség', type: 'number', int: true, min: 1, value: 1, required: true })}
            ${ui.field({ name: 'lot', label: 'Lot', optional: true })}
            ${ui.field({ name: 'expiry', label: 'Lejárat', type: 'date', optional: true })}
          </div>`,
        onSubmit: async (form) => {
          const v = ui.formValues(form);
          const res = await api.post(`/api/counts/${c.id}/lines`, {
            location_id: cur.location.id, product_id: Number(v.product_id), counted_qty: v.counted_qty, lot: v.lot || '', expiry: v.expiry || null,
          });
          apply(res);
          const p = products.find((x) => x.id === Number(v.product_id));
          say(`Felvéve: ${p ? p.sku : ''} ${fmt.int(v.counted_qty)} db.`, 'ok');
          return true;
        },
      });
      await dlg.done;
      paint();
    }

    async function chooseLine(matches) {
      const dlg = ui.dialog({
        title: 'Melyik tétel?',
        size: 'narrow',
        submitLabel: '+1 hozzáadása',
        body: html`<p>${matches[0].sku} több lottal is van ezen a helyen. Válaszd ki, melyiket olvastad be.</p>
          <fieldset class="cnt-choose"><legend class="visually-hidden">Tétel</legend>
          ${matches.map((l, i) => html`<label class="check"><input type="radio" name="line" value="${l.id}" ${i === 0 ? raw('checked') : ''}><span>${lotText(l) || 'lot nélkül'}</span></label>`)}
          </fieldset>`,
        onSubmit: (form) => Number(ui.formValues(form).line),
      });
      const lineId = await dlg.done;
      if (lineId && lineId !== true) await addTo(findLine(lineId), 1);
      else paint();
    }

    async function onScan(code) {
      const upper = code.toUpperCase();
      const loc = state.locations.find((l) => l.code.toUpperCase() === upper);
      if (loc) { await openLocation(loc.location_id, true); return; }
      if (!state.current) {
        say(`Ez nem raktárhely ebben a leltárban: ${code}. Előbb olvasd be a hely címkéjét.`, 'danger');
        paint();
        return;
      }
      const matches = state.current.lines.filter((l) => l.product_id && (l.ean === code || l.sku.toUpperCase() === upper));
      if (matches.length === 1) { await addTo(matches[0], 1); return; }
      if (matches.length > 1) { await chooseLine(matches); return; }
      let res;
      try {
        res = await api.get(`/api/counts/${c.id}/resolve`, { code, location_id: state.current.location.id });
      } catch (err) {
        say(err.message, 'danger');
        paint();
        return;
      }
      if (!res.products.length) {
        say(`Ismeretlen kód: ${code}. Nem termék és nem hely ebben a leltárban.`, 'danger');
        paint();
        return;
      }
      await foundDialog(res.products, code);
    }

    async function manualAdd() {
      const cur = state.current;
      let picked = null;
      const dlg = ui.dialog({
        title: 'Talált termék felvétele',
        size: 'narrow',
        submitLabel: 'Felvétel',
        body: html`
          <p>Hely: <b class="num">${cur.location.code}</b></p>
          <div class="field"><label for="cnt-add-product">Termék</label>
            <input class="input" id="cnt-add-product" name="product_id" type="text" placeholder="Cikkszám, név vagy EAN" autocomplete="off" required>
            <p class="field__error" hidden></p></div>
          <div class="form-grid">
            ${ui.field({ name: 'counted_qty', label: 'Mennyiség', type: 'number', int: true, min: 1, value: 1, required: true })}
            ${ui.field({ name: 'lot', label: 'Lot', optional: true })}
            ${ui.field({ name: 'expiry', label: 'Lejárat', type: 'date', optional: true })}
          </div>`,
        onOpen: ({ form }) => {
          const input = form.querySelector('#cnt-add-product');
          ui.autocomplete(input, {
            source: ui.sources.products(),
            label: ui.productLabel,
            sub: (p) => [p.partner_code, p.ean].filter(Boolean).join(' · '),
            onSelect: (p) => { picked = p; input.value = ui.productLabel(p); },
          });
        },
        onSubmit: async (form) => {
          if (!picked) throw new FL.ApiError(400, 'bad_request', 'Válassz terméket a listából.', { product_id: 'Válassz terméket a listából.' });
          const v = ui.formValues(form);
          const res = await api.post(`/api/counts/${c.id}/lines`, {
            location_id: cur.location.id, product_id: picked.id, counted_qty: v.counted_qty, lot: v.lot || '', expiry: v.expiry || null,
          });
          apply(res);
          say(`Felvéve: ${picked.sku} ${fmt.int(v.counted_qty)} db.`, 'ok');
          return true;
        },
      });
      await dlg.done;
      paint();
    }

    root.addEventListener('change', (e) => {
      const input = e.target.closest('input.cnt-qty');
      if (!input) return;
      const line = findLine(input.dataset.line);
      if (line) setQty(line, input.value.trim());
    });
    root.addEventListener('keydown', (e) => {
      const input = e.target.closest('input.cnt-qty');
      if (!input || e.key !== 'Enter') return;
      e.preventDefault();
      input.blur(); // fires change, which saves and repaints with focus back on the scan field
      const scan = root.querySelector(`#${scanId}`);
      if (scan && document.activeElement === document.body) scan.focus();
    });

    ui.bind(root, {
      open: (el) => openLocation(Number(el.dataset.id)),
      leave: () => { state.current = null; state.feedback = null; setUrl(); paint(); },
      inc: (el) => addTo(findLine(el.dataset.line), 1),
      dec: (el) => { const l = findLine(el.dataset.line); if (l && l.counted_qty) addTo(l, -1); else if (l && l.counted_qty == null) setQty(l, '0'); },
      'add-product': () => manualAdd(),
      'remove-line': async (el) => {
        const l = findLine(el.dataset.line);
        if (!l || !(await ui.confirm({ title: 'Talált tétel törlése', text: `Törlöd a(z) ${l.sku} tételt erről a helyről?`, confirmLabel: 'Törlés', tone: 'danger' }))) { paint(); return; }
        await act(async () => { const res = await api.del(`/api/counts/${c.id}/lines/${l.id}`); say(`${l.sku} törölve.`, 'ok'); return res; });
      },
      complete: async (el) => {
        const cur = state.current;
        const left = cur.lines.filter((l) => l.product_id && l.counted_qty == null);
        if (left.length && !(await ui.confirm({
          title: 'Hely kész?',
          text: `${left.length} tétel nincs számolva ezen a helyen (${left.slice(0, 3).map((l) => l.sku).join(', ')}${left.length > 3 ? ', ...' : ''}). Ha késznek jelölöd, 0 darabnak rögzítjük őket.`,
          confirmLabel: 'Kész, 0 darab',
        }))) { paint(); return; }
        const res = await act(async () => {
          const r = await api.post(`/api/counts/${c.id}/locations/${cur.location.id}/complete`);
          say(`${r.location.code} kész.`, 'ok');
          return r;
        }, el);
        if (res) { state.current = null; setUrl(); paint(); }
      },
      recount: async () => {
        const cur = state.current;
        if (!(await ui.confirm({ title: 'Hely újraszámolása', text: `A(z) ${cur.location.code} hely minden számolása törlődik, és a hely friss készlettel indul újra. Folytatod?`, confirmLabel: 'Újraszámolás' }))) { paint(); return; }
        await act(async () => { const r = await api.post(`/api/counts/${c.id}/locations/${cur.location.id}/recount`); say(`${r.location.code}: kezdd újra a számolást.`, 'info'); return r; });
      },
      finish: async (el) => {
        const p = state.progress;
        const left = p.lines - p.counted_lines;
        if (!(await ui.confirm({
          title: 'Számlálás befejezése',
          text: left ? `${left} tétel nincs számolva. Ezek nem változnak a könyveléskor. Befejezed a számlálást?` : 'Minden tétel számolva. Befejezed a számlálást?',
          confirmLabel: 'Befejezés',
        }))) { paint(); return; }
        await ui.run(el, async () => {
          await api.post(`/api/counts/${c.id}/finish`);
          ui.toast('A számlálás befejezve. A jóváhagyó könyvelheti az eltéréseket.', 'ok');
          FL.go(base(c.id));
        });
      },
    });

    const start = Number(ctx.query.get('hely')) || null;
    if (start && state.locations.some((l) => l.location_id === start)) await openLocation(start);
    else paint();
    // The shell focuses the content after rendering; the scanner needs the scan field.
    setTimeout(() => { const s = root.querySelector(`#${scanId}`); if (s && root.isConnected) s.focus({ preventScroll: true }); }, 0);
    return undefined;
  }

  /* ------------------------------------------------------------ review and posting */
  async function renderReview(root, id) {
    if (!FL.can('counts', 'approve')) {
      root.innerHTML = String(html`${ui.pageHead({ crumb: { href: base(id), label: 'Leltár' }, title: 'Ellenőrzés és könyvelés' })}
        ${ui.notice('Az eltérések könyveléséhez jóváhagyási jog kell.', 'warn')}`);
      return;
    }
    const data = await api.get(`/api/counts/${id}/review`);
    const c = data.count;
    const s = data.summary;
    const confirmed = new Set();
    let onlyDiff = true;
    const postable = ['counting', 'counted'].includes(c.status);

    const paint = () => {
      const groups = [];
      const byLoc = new Map();
      for (const l of data.lines) {
        if (!byLoc.has(l.location_id)) { const g = { id: l.location_id, code: l.location_code, zone: l.zone, lines: [] }; byLoc.set(l.location_id, g); groups.push(g); }
        byLoc.get(l.location_id).lines.push(l);
      }
      const interesting = (l) => l.changed || (l.diff != null && l.diff !== 0) || (l.added && l.counted_qty);
      const shown = groups.map((g) => ({ ...g, lines: onlyDiff ? g.lines.filter(interesting) : g.lines.filter((l) => l.product_id || g.lines.length === 1) }))
        .filter((g) => g.lines.length);
      const openChanged = data.lines.filter((l) => l.changed && !confirmed.has(l.id)).length;
      root.innerHTML = String(html`
        ${ui.pageHead({
          crumb: { href: base(c.id), label: c.number },
          title: 'Ellenőrzés és könyvelés',
          lead: `${c.type_label}: ${c.scope}`,
          actions: html`<a class="btn" href="${base(c.id)}/iv">${FL.icon('printer')}Leltárív</a>
            ${postable ? html`<button class="btn btn--primary" type="button" data-action="post" ${s.counted ? '' : raw('disabled')}>${FL.icon('seal-check')}Eltérések könyvelése</button>` : ''}`,
        })}
        ${!postable ? ui.notice(c.status === 'posted' ? 'Ez a leltár már könyvelve van.' : `A leltár állapota: ${FL.statusLabel('count', c.status)}.`, c.status === 'posted' ? 'ok' : 'info') : ''}
        ${ui.kpis([
          { label: 'Számolt tétel', value: `${fmt.int(s.counted)} / ${fmt.int(s.lines)}`, hint: s.uncounted ? `${fmt.int(s.uncounted)} számolatlan, nem változik` : 'minden tétel számolva' },
          { label: 'Egyezik', value: fmt.int(s.matching) },
          { label: 'Többlet', value: fmt.int(s.surplus), hint: s.surplus_qty ? `+${fmt.int(s.surplus_qty)} db` : '', tone: s.surplus ? 'ok' : '' },
          { label: 'Hiány', value: fmt.int(s.shortage), hint: s.shortage_qty ? `-${fmt.int(s.shortage_qty)} db` : '', tone: s.shortage ? 'danger' : '' },
          { label: 'Változott készlet', value: fmt.int(s.changed), hint: 'mozgás a leltár indítása óta', tone: s.changed ? 'warn' : '' },
        ])}
        ${s.changed && postable ? ui.notice(html`<p><b>${fmt.int(s.changed)} tételnél mozgott a készlet a leltár indítása óta</b> (kiszedés, betárolás, áttárolás). A várható mennyiség ezért elavult lehet.</p>
          <p>Tételenként döntsd el: számold újra a helyet, vagy jelöld be a „Könyvelhető” mezőt, és a készlet a számolt mennyiségre áll.${openChanged ? ` Még ${openChanged} döntés hiányzik.` : ''}</p>`, 'warn') : ''}
        <div class="toolbar"><label class="check"><input type="checkbox" data-action="only-diff" ${onlyDiff ? raw('checked') : ''}><span>Csak az eltérések és a változott tételek</span></label></div>
        ${shown.length ? html`<div class="table-wrap"><table class="table cnt-lines cnt-review">
          <caption class="visually-hidden">Eltérések helyenként</caption>
          <thead><tr><th scope="col">Termék</th><th scope="col">Lot · lejárat</th><th scope="col" class="r">Várható</th><th scope="col" class="r">Számolt</th>
            <th scope="col" class="r">Eltérés</th><th scope="col" class="r">Készlet most</th><th scope="col">Döntés</th></tr></thead>
          ${shown.map((g) => html`<tbody>
            <tr class="cnt-group"><th scope="rowgroup" colspan="7"><div class="cnt-group__in"><span><span class="num">${g.code}</span> <span class="muted small">${g.zone ? `${g.zone} zóna` : ''}</span></span>
              ${postable && FL.can('counts', 'edit') && !g.lines.some((l) => l.posted) ? html`<button class="btn btn--sm" type="button" data-action="recount" data-id="${g.id}" data-code="${g.code}">${FL.icon('arrow-clockwise')}Újraszámolás</button>` : ''}</div></th></tr>
            ${g.lines.map((l) => {
              if (!l.product_id) return html`<tr><td colspan="7" class="muted">Üres hely${l.counted_qty === 0 ? ', üresnek számolva' : ', nincs számolva'}</td></tr>`;
              const rowCls = l.changed ? 'row-warn' : l.diff > 0 ? 'cnt-row--surplus' : l.diff < 0 ? 'cnt-row--shortage' : '';
              return html`<tr class="${rowCls}">
                <td><span class="num">${l.sku}</span>${l.added ? html` <span class="chip" data-tone="warn">talált</span>` : ''}<span class="sub">${l.name}</span></td>
                <td class="nowrap">${lotText(l)}</td>
                <td class="r num">${qtyText(l.expected_qty)}</td>
                <td class="r num">${l.counted_qty == null ? html`<span class="muted">nincs</span>` : qtyText(l.counted_qty)}</td>
                <td class="r num"><span class="cnt-diff ${diffCls(l.diff)}">${l.diff ? diffText(l.diff) : l.counted_qty == null ? '' : '0'}</span></td>
                <td class="r num">${l.changed ? html`<b>${qtyText(l.current_qty)}</b>` : ''}</td>
                <td>${l.posted ? html`<span class="chip" data-tone="ok">könyvelve</span>` : l.changed && l.counted_qty != null && postable
                  ? html`<label class="check"><input type="checkbox" data-action="confirm" data-id="${l.id}" ${confirmed.has(l.id) ? raw('checked') : ''}><span>Könyvelhető</span></label>`
                  : l.changed ? html`<span class="small">változott</span>` : ''}</td>
              </tr>`;
            })}
          </tbody>`)}
        </table></div>` : ui.empty(onlyDiff ? 'Nincs eltérés: minden számolt tétel egyezik a nyilvántartással.' : 'Nincs tétel.', 'check-circle')}`);
    };

    paint();
    ui.bind(root, {
      'only-diff': (el) => { onlyDiff = el.checked; paint(); },
      confirm: (el) => { const lid = Number(el.dataset.id); if (el.checked) confirmed.add(lid); else confirmed.delete(lid); },
      recount: async (el) => {
        if (!(await ui.confirm({ title: 'Hely újraszámolása', text: `A(z) ${el.dataset.code} hely számolásai törlődnek, a hely friss készlettel indul újra. A számlálók a Számlálás képernyőn folytatják.`, confirmLabel: 'Újraszámolás' }))) return;
        await ui.run(el, async () => {
          await api.post(`/api/counts/${c.id}/locations/${el.dataset.id}/recount`);
          ui.toast(`${el.dataset.code}: újraszámolásra vár.`, 'ok');
          FL.reload();
        });
      },
      post: async (el) => {
        const missing = data.lines.filter((l) => l.changed && l.counted_qty != null && !l.posted && !confirmed.has(l.id));
        if (missing.length) {
          ui.toast(`${missing.length} változott tételnél dönts: újraszámolás vagy „Könyvelhető”.`, 'error');
          return;
        }
        const ok = await ui.confirm({
          title: 'Eltérések könyvelése',
          text: `${fmt.int(s.surplus)} többlet (+${fmt.int(s.surplus_qty)} db) és ${fmt.int(s.shortage)} hiány (-${fmt.int(s.shortage_qty)} db) könyvelése. A készlet a számolt mennyiségre áll.${s.uncounted ? ` A ${fmt.int(s.uncounted)} számolatlan tétel nem változik.` : ''} A könyvelés nem vonható vissza.`,
          confirmLabel: 'Könyvelés',
        });
        if (!ok) return;
        await ui.run(el, async () => {
          let res;
          do {
            res = await api.post(`/api/counts/${c.id}/post`, { confirm_line_ids: [...confirmed] });
            if (!res.done) ui.toast(`Könyvelés folyamatban, még ${fmt.int(res.remaining)} tétel...`, 'info');
          } while (!res.done);
          ui.toast(`${c.number} könyvelve.`, 'ok');
          FL.go(base(c.id));
        });
      },
    });
  }

  /* ------------------------------------------------------------ printable count sheet */
  async function renderSheet(root, id) {
    const c = await api.get(`/api/counts/${id}`);
    // The sheet goes to the counters: a blind count's sheet never shows expected quantities.
    const withExpected = !c.blind && c.can_see_expected;
    const cols = withExpected ? 7 : 6;
    root.innerHTML = String(html`
      <div class="no-print">${ui.pageHead({
        crumb: { href: base(c.id), label: c.number },
        title: 'Leltárív',
        lead: withExpected ? 'Nyomtatható ív a nyilvántartott mennyiséggel.' : 'Nyomtatható ív nyilvántartott mennyiség nélkül (vak leltár).',
        actions: html`<button class="btn btn--primary" type="button" data-action="print">${FL.icon('printer')}Nyomtatás</button>`,
      })}</div>
      <article class="cnt-sheet">
        <header class="cnt-sheet__head">
          <div><p class="small muted">${FL.state.me.company.name}</p><h2>Leltárív ${c.number}</h2>
            <p>${c.type_label}: ${c.scope}</p></div>
          <dl class="dl small">
            <dt>Indítva</dt><dd>${fmt.dateTime(c.created_at)}</dd>
            <dt>Vak leltár</dt><dd>${c.blind ? 'Igen' : 'Nem'}</dd>
            <dt>Helyek, tételek</dt><dd>${fmt.int(c.progress.locations)} hely, ${fmt.int(c.progress.lines)} tétel</dd>
          </dl>
        </header>
        <div class="table-wrap"><table class="table cnt-sheet__table">
          <thead><tr><th scope="col">Hely</th><th scope="col">Cikkszám</th><th scope="col">Megnevezés</th><th scope="col">Lot · lejárat</th>
            ${withExpected ? html`<th scope="col" class="r">Várható</th>` : ''}<th scope="col" class="r cnt-sheet__box">Számolt</th><th scope="col">Megjegyzés</th></tr></thead>
          ${c.locations.map((loc) => {
            const goods = (loc.items || []).filter((l) => l.product_id);
            return html`<tbody class="cnt-sheet__loc">${goods.length ? goods.map((l, i) => html`<tr>
              <td class="num">${i === 0 ? loc.code : ''}</td><td class="num">${l.sku}</td><td>${l.name}</td><td>${lotText(l)}</td>
              ${withExpected ? html`<td class="r num">${qtyText(l.expected_qty)}</td>` : ''}<td class="cnt-sheet__box"></td><td></td></tr>`)
              : html`<tr><td class="num">${loc.code}</td><td colspan="${cols - 3}" class="muted">Nyilvántartás szerint üres</td><td class="cnt-sheet__box"></td><td></td></tr>`}</tbody>`;
          })}
          <tbody><tr class="cnt-group"><th scope="rowgroup" colspan="${cols}">Talált, nem nyilvántartott áru</th></tr>
            ${Array.from({ length: 6 }, () => html`<tr class="cnt-sheet__blank">${Array.from({ length: cols }, () => html`<td></td>`)}</tr>`)}</tbody>
        </table></div>
        <footer class="cnt-sheet__sign">
          <p>Számolta: <span></span></p><p>Dátum: <span></span></p><p>Aláírás: <span></span></p>
        </footer>
      </article>`);
    ui.bind(root, { print: () => window.print() });
  }

  // core/app.js (which defines FL.view) loads after the views and keeps FL.views as it is, so the
  // view registers itself directly when FL.view is not there yet.
  const register = (key, def) => (typeof FL.view === 'function' ? FL.view(key, def) : ((FL.views = FL.views || {})[key] = def));
  register('counts', {
    async render(root, ctx) {
      const [id, sub] = ctx.params;
      if (!id) return renderList(root, ctx);
      if (!/^\d+$/.test(id)) { root.innerHTML = String(ui.empty('Ez az oldal nem létezik.', 'warning-circle')); return undefined; }
      if (!sub) return renderDetail(root, id);
      if (sub === 'szamlalas') return renderCounting(root, id, ctx);
      if (sub === 'ellenorzes') return renderReview(root, id);
      if (sub === 'iv') return renderSheet(root, id);
      root.innerHTML = String(ui.empty('Ez az oldal nem létezik.', 'warning-circle'));
      return undefined;
    },
  });
})();
