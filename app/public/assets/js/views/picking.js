/* Komissió: waves, picking with a hand scanner, packing station.
     #/komissio                         wave list
     #/komissio/<id>                    wave screen: scan location, then product, confirm quantity
     #/komissio/csomagolas[/<orderId>]  packing station (?hullam=<waveId> limits the queue to one wave)
   The wave screen keeps the scan input in place and repaints the rest, so a scanner never loses
   focus. Print: the pick list (.pk-print) replaces the screen on paper. */
(() => {
  'use strict';
  const { html, raw, ui, api, fmt } = FL;
  const ACTIVE = ['open', 'picking', 'picked'];

  // Same rule as the server: SKU in any case, or EAN (leading zeros ignored).
  const matchesProduct = (p, code) => {
    const c = String(code || '').trim();
    if (!c) return false;
    if (p.sku && p.sku.toLowerCase() === c.toLowerCase()) return true;
    if (!p.ean) return false;
    if (p.ean === c) return true;
    if (/^\d+$/.test(c) && /^\d+$/.test(p.ean)) { const a = c.replace(/^0+/, ''); return a !== '' && a === p.ean.replace(/^0+/, ''); }
    return false;
  };
  const buzz = (ok) => { try { if (navigator.vibrate) navigator.vibrate(ok ? 40 : [90, 60, 90]); } catch { /* not supported */ } };
  const lotText = (t) => [t.lot ? `Tétel ${t.lot}` : '', t.expiry ? `Lejárat ${fmt.date(t.expiry)}` : ''].filter(Boolean).join(' · ');
  const progressBar = (done, total, label) => html`<div class="progress" data-done="${total > 0 && done >= total}" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><span style="width:${total ? Math.min(100, Math.round((done / total) * 100)) : 0}%"></span></div>`;
  const orderHref = (id) => (FL.can('orders', 'view') ? `${FL.routes.orders}/${id}` : FL.can('history', 'view') ? `${FL.routes.history}/${id}` : null);

  /* ------------------------------------------------------------ wave list */

  const TABS = [['active', 'Aktív'], ['completed', 'Lezárt'], ['cancelled', 'Megszakított'], ['all', 'Összes']];

  async function newWaveDialog() {
    const [clients, carriers, users] = await Promise.all([
      ui.partnerOptions('client'), FL.orders.carrierOptions(), api.get('/api/lookup/users').then((r) => r.items.map((u) => ({ value: u.id, label: u.name }))),
    ]);
    let candidates = [];
    const dlg = ui.dialog({
      title: 'Új hullám',
      submitLabel: 'Hullám indítása',
      body: html`
        <p>A rendszer a teljes készlettel rendelkező új rendelésekből állítja össze a hullámot: előbb az expressz, aztán a legrégebbi rendelések kerülnek bele.</p>
        <div class="form-grid">
          ${ui.field({ name: 'partner_id', label: 'Ügyfél', type: 'select', options: clients, placeholder: 'Mind' })}
          ${ui.field({ name: 'carrier_id', label: 'Fuvarozó', type: 'select', options: carriers, placeholder: 'Mind' })}
          ${ui.field({ name: 'priority', label: 'Prioritás', type: 'select', options: [['express', 'Csak expressz'], ['normal', 'Csak normál']], placeholder: 'Mind' })}
          ${ui.field({ name: 'max', label: 'Legfeljebb', type: 'number', int: true, min: 1, max: 200, value: 30, hint: 'rendelés egy hullámban' })}
          ${ui.field({ name: 'picker_id', label: 'Komissiós', type: 'select', options: users, placeholder: 'Aki elindítja', optional: true })}
        </div>
        <div data-preview role="status" aria-live="polite">${ui.loading('Rendelések keresése...')}</div>`,
      onOpen: ({ form }) => {
        const preview = async () => {
          const v = ui.formValues(form);
          const max = Math.min(Math.max(Number(v.max) || 30, 1), 200);
          const box = form.querySelector('[data-preview]');
          try {
            const r = await api.get('/api/orders', { status: 'new', availability: 'ok', partner_id: v.partner_id, carrier_id: v.carrier_id, priority: v.priority, limit: max });
            candidates = r.items;
            const items = candidates.reduce((s, o) => s + o.item_count, 0);
            box.innerHTML = String(candidates.length
              ? ui.notice(html`<p><b>${fmt.int(candidates.length)} rendelés</b>, ${fmt.int(items)} db kerül a hullámba${r.total > candidates.length ? html` (további ${fmt.int(r.total - candidates.length)} teljesíthető rendelés vár)` : ''}.</p>
                  <p class="small mono">${candidates.slice(0, 12).map((o) => o.number).join(', ')}${candidates.length > 12 ? ', ...' : ''}</p>`, 'info')
              : ui.notice('Nincs olyan új rendelés, amelyhez minden tétel elérhető.', 'warn'));
          } catch (err) {
            box.innerHTML = String(ui.notice(err.message, 'danger'));
          }
        };
        form.addEventListener('change', (e) => { if (e.target.name !== 'picker_id') preview(); });
        preview();
      },
      onSubmit: async (form) => {
        if (!candidates.length) throw new FL.ApiError(400, 'bad_request', 'Nincs indítható rendelés.');
        const v = ui.formValues(form);
        const res = await api.post('/api/picking/waves', { order_ids: candidates.map((o) => o.id), picker_id: v.picker_id ? Number(v.picker_id) : null });
        ui.toast(`${res.number} elindítva: ${fmt.int(res.orders)} rendelés.`, 'ok');
        return res;
      },
    });
    const res = await dlg.done;
    if (res && res.id) FL.go(`${FL.routes.picking}/${res.id}`);
  }

  async function renderList(root, ctx) {
    const status = TABS.some(([k]) => k === ctx.query.get('status')) ? ctx.query.get('status') : 'active';
    const offset = Number(ctx.query.get('offset')) || 0;
    const data = await api.get('/api/picking/waves', { status, limit: 50, offset });
    const c = data.counts;
    const activeCount = (c.open || 0) + (c.picking || 0) + (c.picked || 0);
    root.innerHTML = String(html`
      ${ui.pageHead({
        title: 'Komissió',
        lead: 'Hullámok kiszedése és csomagolása. Hullámot itt vagy a Megrendelések listából indíthatsz.',
        actions: html`
          <a class="btn" href="${FL.routes.picking}/csomagolas">${FL.icon('package')}Csomagolóállomás${data.ready_to_pack ? html` <span class="pk-count">${fmt.int(data.ready_to_pack)}</span>` : ''}</a>
          ${FL.can('picking', 'create') ? html`<button class="btn btn--primary" type="button" data-action="new">${FL.icon('plus')}Új hullám</button>` : ''}`,
      })}
      ${ui.kpis([
        { label: 'Nyitott', value: fmt.int(c.open || 0), hint: 'még nem kezdték el' },
        { label: 'Kiszedés alatt', value: fmt.int(c.picking || 0) },
        { label: 'Kiszedve', value: fmt.int(c.picked || 0), hint: 'csomagolásra vár' },
        { label: 'Csomagolható rendelés', value: fmt.int(data.ready_to_pack), tone: data.ready_to_pack ? 'ok' : '', href: `${FL.routes.picking}/csomagolas` },
      ])}
      ${ui.tabs(TABS.map(([key, label]) => ({ key, label, href: `${FL.routes.picking}${FL.qs({ status: key === 'active' ? '' : key })}`, count: key === 'active' ? activeCount : key === 'all' ? null : c[key] || 0 })), status, 'Hullámok állapot szerint')}
      ${ui.table({
        caption: 'Komissiós hullámok',
        rows: data.items,
        empty: status === 'active' ? 'Nincs aktív hullám. Indíts egyet az Új hullám gombbal.' : 'Nincs ilyen hullám.',
        rowHref: (w) => `${FL.routes.picking}/${w.id}`,
        columns: [
          { key: 'number', label: 'Hullám', render: (w) => html`<a class="mono" href="${FL.routes.picking}/${w.id}">${w.number}</a>${w.note ? html`<span class="sub">${w.note}</span>` : ''}` },
          { key: 'status', label: 'Állapot', render: (w) => FL.status('wave', w.status) },
          { key: 'picker_name', label: 'Komissiós', render: (w) => w.picker_name || html`<span class="muted">nincs</span>` },
          { key: 'order_count', label: 'Rendelés', align: 'r', cls: 'num' },
          { key: 'picked', label: 'Haladás', render: (w) => html`<div class="pk-listprogress">${progressBar(w.picked, w.qty, `${w.number} haladás`)}<span class="num small">${fmt.int(w.picked)} / ${fmt.int(w.qty)} db</span></div>` },
          { key: 'short', label: 'Hiány', align: 'r', cls: 'num', render: (w) => (w.short ? html`<span class="diff-neg">${fmt.int(w.short)} db</span>` : '') },
          { key: 'created_at', label: 'Indítva', render: (w) => html`${fmt.dateTime(w.started_at || w.created_at)}${w.completed_at ? html`<span class="sub">Lezárva ${fmt.dateTime(w.completed_at)}</span>` : ''}` },
        ],
      })}
      ${ui.pager({ total: data.total, limit: 50, offset })}`);
    ui.enableRowLinks(root);
    ui.bind(root, {
      new: () => newWaveDialog(),
      page: (el) => FL.go(`${FL.routes.picking}${FL.qs({ status: status === 'active' ? '' : status, offset: el.dataset.offset })}`),
    });
  }

  /* ------------------------------------------------------------ wave screen */

  async function renderWave(root, id) {
    const canEdit = FL.can('picking', 'edit');
    let w;
    const st = { key: null, step: 'location', locId: null, locCode: '', productCode: '', skipped: [], qty: 1 };

    root.innerHTML = String(html`
      <div class="pk-screen">
        <div data-head></div>
        <div data-summary></div>
        <div class="pk-work" data-work hidden>
          ${ui.scan({ id: 'pk-scan', label: 'Raktárhely vagy termék beolvasása', placeholder: 'Olvasd be a helyet' })}
          <p class="pk-feedback" data-feedback role="status" aria-live="assertive"></p>
          <div data-task></div>
        </div>
        <div data-finish></div>
        <section class="panel panel--flush" aria-labelledby="pk-tasks-h">
          <div class="panel__head"><h2 id="pk-tasks-h">Kiszedési lista</h2><span class="small muted">Bejárási sorrendben, helyenként</span></div>
          <div data-tasks></div>
        </section>
        <section class="panel panel--flush" aria-labelledby="pk-orders-h">
          <div class="panel__head"><h2 id="pk-orders-h">Rendelések a hullámban</h2></div>
          <div data-orders></div>
        </section>
      </div>
      <div class="pk-print" data-print aria-hidden="true"></div>`);

    const $ = (sel) => root.querySelector(sel);
    const scan = $('#pk-scan');
    scan.setAttribute('data-autofocus', '');
    const open = () => w.tasks.filter((t) => t.state === 'open');
    const queue = () => {
      const o = open();
      const skipped = st.skipped.map((k) => o.find((t) => t.key === k)).filter(Boolean);
      return [...o.filter((t) => !st.skipped.includes(t.key)), ...skipped];
    };
    const current = () => w.tasks.find((t) => t.key === st.key && t.state === 'open') || null;

    function feedback(text, tone = 'info') {
      const box = $('[data-feedback]');
      box.textContent = text;
      box.dataset.tone = tone;
      const s = root.querySelector('.scan');
      s.dataset.flash = tone;
      clearTimeout(feedback.t);
      feedback.t = setTimeout(() => { delete s.dataset.flash; }, 700);
      if (tone === 'ok' || tone === 'danger') buzz(tone === 'ok');
    }

    function chooseNext() {
      const q = queue();
      if (current()) return;
      const same = q.find((t) => t.location.id === st.locId);
      st.key = (same || q[0] || {}).key || null;
      const cur = current();
      st.step = cur && st.locId === cur.location.id ? 'product' : 'location';
      st.productCode = '';
    }

    async function refresh() {
      w = await api.get(`/api/picking/waves/${id}`);
      chooseNext();
      paint();
    }

    function paintHead() {
      const active = ACTIVE.includes(w.status);
      const missing = w.progress.remaining > 0 || w.incomplete_orders.length > 0;
      const needApprove = missing && !FL.can('picking', 'approve');
      const ready = w.orders.filter((o) => o.ready).length;
      $('[data-head]').innerHTML = String(ui.pageHead({
        crumb: { href: FL.routes.picking, label: 'Komissió' },
        title: w.number,
        lead: html`${FL.status('wave', w.status)} <span class="muted">Létrehozta ${w.created_by_name || 'rendszer'}, ${fmt.dateTime(w.created_at)}</span>`,
        actions: html`
          <button class="btn" type="button" data-action="print">${FL.icon('printer')}Kiszedési lista</button>
          ${ready && FL.can('picking', 'edit') ? html`<a class="btn ${!open().length && active ? 'btn--primary' : ''}" href="${FL.routes.picking}/csomagolas${FL.qs({ hullam: w.id })}">${FL.icon('package')}Csomagolás (${fmt.int(ready)})</a>` : ''}
          ${active && canEdit ? html`<button class="btn" type="button" data-action="complete" ${needApprove ? raw('disabled title="Hiánnyal lezárni csak jóváhagyási joggal lehet"') : ''}>${FL.icon('check-circle')}Lezárás</button>` : ''}
          ${active && FL.can('picking', 'delete') ? html`<button class="btn btn--danger" type="button" data-action="cancel">${FL.icon('x')}Megszakítás</button>` : ''}`,
      }));
      FL.setTitle(w.number);
    }

    function paintSummary() {
      const p = w.progress;
      $('[data-summary]').innerHTML = String(html`<div class="panel pk-summary">
        <div class="pk-summary__bar">${progressBar(p.picked, p.qty, 'Hullám haladása')}
          <p><b class="num">${fmt.int(p.picked)} / ${fmt.int(p.qty)} db</b> kiszedve${p.short ? html`, <span class="diff-neg">hiány ${fmt.int(p.short)} db</span>` : ''} · ${p.open_tasks ? `${fmt.int(p.open_tasks)} feladat van hátra` : 'nincs hátralévő feladat'}</p></div>
        <p class="pk-summary__picker">${FL.icon('user-circle')}<span>Komissiós: <b>${w.picker_name || 'nincs kijelölve'}</b></span>
          ${ACTIVE.includes(w.status) && canEdit ? html`<button class="link-btn" type="button" data-action="picker">módosítás</button>` : ''}</p>
        ${w.status === 'open' && canEdit ? html`<p class="small muted">A hullám az első beolvasott tétellel indul. <button class="link-btn" type="button" data-action="start">Indítás most</button></p>` : ''}
        ${w.note ? html`<p class="small">${w.note}</p>` : ''}
      </div>`);
    }

    function paintTask() {
      const cur = current();
      const box = $('[data-task]');
      if (!cur) { box.innerHTML = ''; return; }
      // The placeholder says what to scan next (short enough for a handheld screen).
      scan.placeholder = st.step === 'location' ? `Hely: ${cur.location.code}` : st.step === 'product' ? `Termék: ${cur.product.sku}` : 'Mennyiség megadása';
      const q = queue();
      const pos = q.findIndex((t) => t.key === cur.key) + 1;
      const cell = (step, label, body) => {
        const order = ['location', 'product', 'qty'];
        const state = order.indexOf(st.step) > order.indexOf(step) ? 'done' : st.step === step ? 'current' : '';
        return html`<div class="pk-cell" data-state="${state}">
          <span class="pk-label">${state === 'done' ? FL.icon('check') : html`<span class="pk-stepno">${order.indexOf(step) + 1}</span>`}${label}</span>${body}</div>`;
      };
      box.innerHTML = String(html`<article class="pk-task" aria-label="Aktuális feladat">
        <header class="pk-task__head"><span class="pk-label">Feladat ${fmt.int(pos)} / ${fmt.int(q.length)}</span>${cur.express ? html`<span class="chip" data-tone="warn">${FL.icon('lightning')}Expressz</span>` : ''}</header>
        <div class="pk-task__grid">
          ${cell('location', 'Hely', html`<b class="pk-big mono">${cur.location.code}</b>`)}
          ${cell('product', 'Termék', html`<b class="pk-mid mono">${cur.product.sku}</b><span>${cur.product.name}</span>
            <span class="small muted mono">${cur.product.ean ? `EAN ${cur.product.ean}` : ''}${lotText(cur) ? ` · ${lotText(cur)}` : ''}</span>`)}
          ${cell('qty', 'Mennyiség', html`<b class="pk-big num">${fmt.int(cur.remaining)} <small>${cur.product.unit}</small></b>
            <span class="small muted">${cur.orders.length > 1 ? `${cur.orders.length} rendelés: ` : ''}${cur.orders.join(', ')}</span>`)}
        </div>
        ${st.step === 'qty' ? html`<div class="pk-qty">
          <label for="pk-qty">Kiszedett mennyiség</label>
          <div class="pk-qty__row">
            <button class="btn btn--lg btn--icon" type="button" data-action="qty-minus" aria-label="Eggyel kevesebb">${FL.icon('minus')}</button>
            <input class="input input--num pk-qty__input" id="pk-qty" type="number" inputmode="numeric" min="1" max="${cur.remaining}" step="1" value="${st.qty}">
            <button class="btn btn--lg btn--icon" type="button" data-action="qty-plus" aria-label="Eggyel több">${FL.icon('plus')}</button>
            <button class="btn btn--primary btn--lg" type="button" data-action="confirm">${FL.icon('check')}Megerősítés</button>
          </div></div>` : ''}
        <footer class="actions pk-task__actions">
          <button class="btn" type="button" data-action="short">${FL.icon('warning-circle')}Hiány</button>
          ${q.length > 1 ? html`<button class="btn btn--ghost" type="button" data-action="skip">${FL.icon('arrow-right')}Kihagyás</button>` : ''}
          ${st.step !== 'location' ? html`<button class="btn btn--ghost" type="button" data-action="restart">${FL.icon('arrow-clockwise')}Újrakezdés</button>` : ''}
        </footer>
      </article>`);
    }

    function paintDone() {
      const box = $('[data-finish]');
      const active = ACTIVE.includes(w.status);
      if (active && !open().length) {
        const ready = w.orders.filter((o) => o.ready).length;
        box.innerHTML = String(ui.notice(html`<p><b>Minden feladat kész.</b> ${w.progress.short ? `Hiány: ${fmt.int(w.progress.short)} db. ` : ''}${ready ? `${fmt.int(ready)} rendelés csomagolható.` : ''}
          ${w.incomplete_orders.length ? ` Hiányos rendelés: ${w.incomplete_orders.join(', ')}. Lezáráskor ezek visszakerülnek új állapotba.` : ''}</p>`, w.incomplete_orders.length ? 'warn' : 'ok'));
      } else if (!active) {
        box.innerHTML = String(ui.notice(w.status === 'completed' ? html`<p>A hullám le van zárva${w.completed_at ? ` (${fmt.dateTime(w.completed_at)})` : ''}.</p>` : html`<p>A hullám meg van szakítva. ${w.note}</p>`, w.status === 'completed' ? 'ok' : 'warn'));
      } else box.innerHTML = '';
    }

    function paintLists() {
      const cur = current();
      let lastLoc = null;
      $('[data-tasks]').innerHTML = String(w.tasks.length ? html`<div class="table-wrap"><table class="table pk-tasklist">
        <caption class="visually-hidden">Kiszedési lista</caption>
        <thead><tr><th scope="col">Hely</th><th scope="col">Termék</th><th class="r" scope="col">Kell</th><th class="r" scope="col">Kiszedve</th><th scope="col">Állapot</th><th scope="col"><span class="visually-hidden">Művelet</span></th></tr></thead>
        <tbody>${w.tasks.map((t) => {
          const first = t.location.code !== lastLoc;
          lastLoc = t.location.code;
          const isCur = cur && cur.key === t.key;
          return html`<tr class="${first ? 'pk-group' : ''}" ${isCur ? raw('data-current="true"') : ''}>
            <td class="mono nowrap">${first ? html`<b>${t.location.code}</b>` : ''}</td>
            <td><span class="mono">${t.product.sku}</span><span class="sub">${t.product.name}</span>${lotText(t) ? html`<span class="sub mono">${lotText(t)}</span>` : ''}</td>
            <td class="r num">${fmt.int(t.qty)}</td>
            <td class="r num">${fmt.int(t.picked)}${t.short ? html`<span class="sub diff-neg">hiány ${fmt.int(t.short)}</span>` : ''}</td>
            <td>${t.state === 'done' ? html`<span class="chip" data-tone="ok">Kész</span>` : t.state === 'short' ? html`<span class="chip" data-tone="danger">Hiány</span>` : isCur ? html`<span class="chip" data-tone="accent">Most</span>` : html`<span class="chip">Hátra</span>`}</td>
            <td class="r">${t.state === 'open' && !isCur && canEdit && ACTIVE.includes(w.status) ? html`<button class="btn btn--sm btn--ghost" type="button" data-action="pick-task" data-key="${t.key}">Ez jön</button>` : ''}</td>
          </tr>`;
        })}</tbody></table></div>` : ui.empty('Ebben a hullámban nincs kiszedendő tétel.'));

      $('[data-orders]').innerHTML = String(ui.table({
        caption: 'Rendelések a hullámban',
        rows: w.orders,
        columns: [
          { key: 'number', label: 'Rendelés', cls: 'nowrap', render: (o) => { const h = orderHref(o.id); return html`${h ? html`<a class="mono" href="${h}">${o.number}</a>` : html`<span class="mono">${o.number}</span>`}${o.external_number ? html`<span class="sub">${o.external_number}</span>` : ''}`; } },
          { key: 'customer_name', label: 'Vevő', render: (o) => html`${o.customer_name}<span class="sub">${o.partner_code} · ${o.city}</span>` },
          { key: 'carrier_name', label: 'Fuvarozó', render: (o) => html`<span title="${o.carrier_name || ''}">${FL.orders.carrierShort(o.carrier_name, o.carrier_code)}</span>` },
          { key: 'picked_count', label: 'Kiszedve', align: 'r', render: (o) => html`<span class="num ${o.picked_count >= o.item_count ? 'diff-pos' : ''}">${fmt.int(o.picked_count)} / ${fmt.int(o.item_count)}</span>${o.wave_short ? html`<span class="sub diff-neg">hiány ${fmt.int(o.wave_short)}</span>` : ''}` },
          { key: 'status', label: 'Állapot', render: (o) => html`<span class="ol-chips">${FL.status('order', o.status)}${o.priority === 'express' ? html`<span class="chip" data-tone="warn">Expressz</span>` : ''}</span>${!o.in_wave ? html`<span class="sub">már nincs a hullámban</span>` : ''}` },
          { key: 'id', label: 'Csomagolás', render: (o) => (o.ready && canEdit ? html`<a class="btn btn--sm" href="${FL.routes.picking}/csomagolas/${o.id}">${FL.icon('package')}Csomagolás</a>` : o.tracking_number ? html`<span class="mono small">${o.tracking_number}</span>` : '') },
        ],
      }));
    }

    function paintPrint() {
      let lastLoc = null;
      const rows = w.tasks.filter((t) => t.remaining > 0 || t.state === 'open');
      $('[data-print]').innerHTML = String(html`
        <header class="pk-print__head"><h1>Kiszedési lista: ${w.number}</h1>
          <p>Nyomtatva: ${fmt.dateTime(new Date().toISOString())} · Komissiós: ${w.picker_name || '................'} · ${fmt.int(w.orders.filter((o) => o.in_wave).length)} rendelés · ${fmt.int(w.progress.remaining)} db hátra</p></header>
        <table class="pk-print__table">
          <thead><tr><th>Kész</th><th>Hely</th><th>Cikkszám</th><th>Megnevezés</th><th>Tétel, lejárat</th><th>Db</th><th>Rendelések</th></tr></thead>
          <tbody>${rows.map((t) => {
            const first = t.location.code !== lastLoc;
            lastLoc = t.location.code;
            return html`<tr class="${first ? 'pk-group' : ''}"><td class="pk-box"></td><td class="mono"><b>${first ? t.location.code : ''}</b></td><td class="mono">${t.product.sku}</td>
              <td>${t.product.name}</td><td>${lotText(t)}</td><td class="num"><b>${fmt.int(t.remaining)}</b></td><td class="mono small">${t.orders.join(', ')}</td></tr>`;
          })}</tbody>
        </table>
        ${rows.length ? '' : html`<p>Nincs hátralévő tétel.</p>`}
        <p class="pk-print__sign">Kiszedte: ................................ Ellenőrizte: ................................</p>`);
    }

    // After a scan ui.bindScan puts focus back on the scan input: move it on a tick later.
    const focusQty = () => setTimeout(() => { const q = $('#pk-qty'); if (q) { q.focus(); q.select(); } }, 0);

    function paint() {
      paintHead();
      paintSummary();
      const working = ACTIVE.includes(w.status) && canEdit && open().length > 0;
      $('[data-work]').hidden = !working;
      paintTask();
      paintDone();
      paintLists();
      paintPrint();
      if (working && st.step !== 'qty' && !document.querySelector('dialog[open]')) scan.focus({ preventScroll: true });
      if (st.step === 'qty') focusQty();
    }

    async function confirmQty(qty) {
      const cur = current();
      if (!cur) return;
      if (!Number.isInteger(qty) || qty < 1 || qty > cur.remaining) { feedback(`A mennyiség 1 és ${cur.remaining} között legyen.`, 'danger'); return; }
      try {
        const r = await api.post(`/api/picking/waves/${id}/confirm`, { pick_id: cur.pick_id, location_code: st.locCode || cur.location.code, product_code: st.productCode, qty });
        st.productCode = '';
        st.step = 'product';
        await refresh();
        const next = current();
        feedback(`Kiszedve: ${qty} ${cur.product.unit} ${cur.product.sku}.${r.left ? ` Ennél a feladatnál még ${r.left} van hátra.` : ''}${next ? ` Következő: ${next.location.code}${next.location.id === cur.location.id ? ', ugyanez a hely' : ''}.` : ' Minden tétel kész.'}`, 'ok');
      } catch (err) {
        feedback(err.message, 'danger');
        if (err.status === 409 || err.status === 404) await refresh().catch(() => {});
      }
    }

    function switchTo(task, how) {
      st.key = task.key;
      st.locId = task.location.id;
      st.locCode = task.location.code;
      st.step = 'product';
      st.productCode = '';
      paintTask();
      paintLists();
      feedback(`${how}: ${task.location.code}. Most olvasd be a terméket: ${task.product.sku}.`, 'ok');
    }

    async function onScan(code) {
      const cur = current();
      if (!cur) { feedback('Nincs több kiszedendő tétel ebben a hullámban.', 'info'); return; }
      const isLoc = (t) => t.location.code.toLowerCase() === code.toLowerCase();
      if (isLoc(cur)) {
        if (st.step === 'location') switchTo(cur, 'Hely rendben');
        else feedback(`A hely már be van olvasva. Most a terméket olvasd be: ${cur.product.sku}.`, 'info');
        return;
      }
      const otherLoc = queue().find(isLoc);
      if (otherLoc) { switchTo(otherLoc, 'Átváltva a helyre'); return; }
      if (matchesProduct(cur.product, code)) {
        if (st.step === 'location') { feedback(`Előbb a helyet olvasd be: ${cur.location.code}.`, 'danger'); return; }
        if (st.step === 'qty') { feedback('Add meg a mennyiséget, majd nyomd meg a Megerősítés gombot.', 'info'); focusQty(); return; }
        st.productCode = code;
        if (cur.remaining === 1) { await confirmQty(1); return; }
        st.step = 'qty';
        st.qty = cur.remaining;
        paintTask();
        focusQty();
        feedback(`Termék rendben: ${cur.product.sku}. Számold meg: ${cur.remaining} ${cur.product.unit} kell.`, 'ok');
        return;
      }
      // Not the current task: ask the server what the code is, to give a useful message.
      try {
        const r = await api.get(`/api/picking/waves/${id}/scan`, { code });
        if (r.kind === 'location') feedback(`A(z) ${r.location.code} helyen nincs feladat ebben a hullámban. Ide menj: ${cur.location.code}.`, 'danger');
        else if (r.kind === 'product') feedback(st.step === 'location' ? `Előbb a helyet olvasd be: ${cur.location.code}.` : `Rossz termék (${r.product.sku}). A(z) ${cur.location.code} helyen ezt kell kiszedni: ${cur.product.sku} ${cur.product.name}.`, 'danger');
        else if (r.kind === 'order') feedback(`Ez a(z) ${r.order.number} rendelés száma. Kiszedéshez a helyet és a terméket olvasd be.`, 'info');
        else feedback(r.message, 'danger');
      } catch (err) {
        feedback(err.message, 'danger');
      }
    }

    ui.bindScan(root, 'pk-scan', onScan);
    root.addEventListener('keydown', (e) => {
      if (e.target.id === 'pk-qty' && e.key === 'Enter') { e.preventDefault(); confirmQty(parseInt(e.target.value, 10)); }
      if (e.target.id === 'pk-qty' && e.key === 'Escape') { st.step = 'product'; paintTask(); scan.focus(); }
    });

    async function shortDialog() {
      const cur = current();
      if (!cur) return;
      const scanned = st.step === 'qty';
      const res = await ui.dialog({
        title: `Hiány: ${cur.location.code}, ${cur.product.sku}`,
        size: 'narrow',
        submitLabel: 'Hiány rögzítése',
        submitTone: 'danger',
        body: html`<p>A helyen ${fmt.int(cur.remaining)} ${cur.product.unit} kellene. A hiányzó részt megpróbáljuk másik helyről pótolni; ha nincs máshol, a rendelés hiánnyal marad.</p>
          ${scanned
            ? ui.field({ name: 'found', label: 'Ennyit találtál a helyen', type: 'number', int: true, min: 0, max: cur.remaining - 1, value: 0, hint: `0 és ${cur.remaining - 1} között` })
            : html`<p class="small muted">Ha találtál belőle valamennyit, előbb olvasd be a helyet és a terméket, és a mennyiségnél add meg, amennyit találtál.</p>`}`,
        onSubmit: async (form) => {
          const found = scanned ? Number(ui.formValues(form).found || 0) : 0;
          if (!Number.isInteger(found) || found < 0 || found >= cur.remaining) throw new FL.ApiError(400, 'bad_request', `0 és ${cur.remaining - 1} között adj meg számot.`, { found: 'Érvénytelen mennyiség.' });
          if (found > 0) await api.post(`/api/picking/waves/${id}/confirm`, { pick_id: cur.pick_id, location_code: st.locCode || cur.location.code, product_code: st.productCode, qty: found });
          const fresh = await api.get(`/api/picking/waves/${id}`);
          const t = fresh.tasks.find((x) => x.key === cur.key);
          if (!t || t.state !== 'open') return { short: 0, moved: [], missing: 0 };
          return api.post(`/api/picking/waves/${id}/short`, { pick_id: t.pick_id });
        },
      }).done;
      if (!res) { scan.focus(); return; }
      st.step = 'location';
      await refresh();
      const moved = res.moved && res.moved.length ? ` Pótlás innen: ${res.moved.map((m) => `${m.code} (${m.qty} db)`).join(', ')}.` : '';
      feedback(`Hiány rögzítve: ${res.short} ${cur.product.unit} ${cur.product.sku}.${moved}${res.missing ? ` Nem pótolható: ${res.missing} db.` : ''}`, res.missing ? 'danger' : 'ok');
    }

    ui.bind(root, {
      print: () => window.print(),
      start: async (el) => ui.run(el, async () => { await api.post(`/api/picking/waves/${id}/start`, {}); await refresh(); ui.toast('Kiszedés elindítva.', 'ok'); }),
      picker: async () => {
        const users = (await api.get('/api/lookup/users')).items.map((u) => ({ value: u.id, label: u.name }));
        const r = await ui.dialog({
          title: 'Komissiós', size: 'narrow',
          body: ui.field({ name: 'picker_id', label: 'Ki szedi ki a hullámot?', type: 'select', options: users, placeholder: 'Nincs kijelölve', value: w.picker_id || '' }),
          onSubmit: (form) => api.patch(`/api/picking/waves/${id}`, { picker_id: form.picker_id.value ? Number(form.picker_id.value) : null }),
        }).done;
        if (r) await refresh();
      },
      'qty-minus': () => { const q = $('#pk-qty'); q.value = Math.max(1, (parseInt(q.value, 10) || 1) - 1); st.qty = Number(q.value); q.focus(); },
      'qty-plus': () => { const q = $('#pk-qty'); const cur = current(); q.value = Math.min(cur.remaining, (parseInt(q.value, 10) || 0) + 1); st.qty = Number(q.value); q.focus(); },
      confirm: async (el) => ui.run(el, () => confirmQty(parseInt($('#pk-qty').value, 10))),
      short: () => shortDialog(),
      skip: () => {
        const cur = current();
        if (!cur) return;
        st.skipped = [...st.skipped.filter((k) => k !== cur.key), cur.key];
        st.key = null;
        chooseNext();
        paintTask();
        paintLists();
        const next = current();
        feedback(next ? `Kihagyva. Következő hely: ${next.location.code}.` : 'Kihagyva.', 'info');
        scan.focus();
      },
      restart: () => { st.step = 'location'; st.locId = null; st.productCode = ''; paintTask(); scan.focus(); feedback('Kezdd újra: olvasd be a helyet.', 'info'); },
      'pick-task': (el) => {
        st.key = el.dataset.key;
        const cur = current();
        st.step = cur && cur.location.id === st.locId ? 'product' : 'location';
        st.productCode = '';
        paintTask();
        paintLists();
        root.querySelector('[data-work]').scrollIntoView({ block: 'start', behavior: 'smooth' });
        scan.focus({ preventScroll: true });
        feedback(`Következő feladat: ${cur.location.code}, ${cur.product.sku}.`, 'info');
      },
      complete: async () => {
        const missing = w.incomplete_orders.length || w.progress.remaining > 0;
        const reverted = w.orders.filter((o) => o.in_wave && o.status === 'picking' && o.picked_count < o.item_count).map((o) => o.number);
        const ok = await ui.confirm({
          title: `${w.number} lezárása`,
          text: missing
            ? `A hullámban hiány van. Lezáráskor a hiányos rendelések (${reverted.join(', ') || 'nincs'}) visszakerülnek új állapotba; a már kiszedett tételeik a rendelésnél maradnak, a készlet nem változik.`
            : 'Minden tétel ki van szedve. A még be nem csomagolt rendelések a csomagolóállomáson továbbra is csomagolhatók.',
          confirmLabel: missing ? 'Lezárás hiánnyal' : 'Lezárás',
          tone: missing ? 'danger' : 'primary',
        });
        if (!ok) return;
        await ui.run(null, async () => {
          const r = await api.post(`/api/picking/waves/${id}/complete`, {});
          ui.toast(r.reverted.length ? `Lezárva. Új állapotba került: ${r.reverted.join(', ')}.` : 'Hullám lezárva.', 'ok');
          await refresh();
        });
      },
      cancel: async () => {
        const picked = w.progress.picked;
        const r = await ui.dialog({
          title: `${w.number} megszakítása`, size: 'narrow', submitLabel: 'Megszakítás', submitTone: 'danger',
          body: html`<p>A rendelések visszakerülnek új állapotba. ${picked ? html`<b>A már kiszedett ${fmt.int(picked)} db-ot visszakönyveljük oda, ahonnan kivették: tedd vissza a polcra.</b>` : ''} A becsomagolt rendelések nem változnak.</p>
            ${ui.field({ name: 'reason', label: 'Ok', required: true })}`,
          onSubmit: async (form) => {
            const reason = form.reason.value.trim();
            if (!reason) throw new FL.ApiError(400, 'bad_request', 'Add meg az okát.', { reason: 'Kötelező mező.' });
            return api.post(`/api/picking/waves/${id}/cancel`, { reason });
          },
        }).done;
        if (!r) return;
        ui.toast(`Hullám megszakítva.${r.restocked.length ? ` Visszakönyvelve: ${r.restocked.map((x) => `${x.sku} ${x.qty} db (${x.code})`).join(', ')}.` : ''}`, 'ok');
        await refresh();
      },
    });

    await refresh();
    if (ACTIVE.includes(w.status) && canEdit && open().length) feedback(`Kezdd itt: ${current().location.code}. Olvasd be a helyet.`, 'info');
  }

  /* ------------------------------------------------------------ packing station */

  async function renderPacking(root, ctx) {
    const waveId = Number(ctx.query.get('hullam')) || null;
    const canEdit = FL.can('picking', 'edit');
    let order = null;
    let manual = false;
    let labelError = '';

    root.innerHTML = String(html`
      ${ui.pageHead({
        crumb: { href: FL.routes.picking, label: 'Komissió' },
        title: 'Csomagolóállomás',
        lead: 'Olvasd be a rendelésszámot vagy egy termék vonalkódját, ellenőrizd a tételeket, add meg a csomagok számát, és készítsd el a címkét.',
        actions: waveId ? html`<a class="btn" href="${FL.routes.picking}/csomagolas">${FL.icon('x')}Minden hullám</a>` : '',
      })}
      ${ui.scan({ id: 'pack-scan', label: 'Rendelésszám vagy termék beolvasása', placeholder: 'Rendelésszám vagy termék' })}
      <p class="pk-feedback" data-feedback role="status" aria-live="assertive"></p>
      <div class="pk-pack">
        <div data-order>${ui.empty('Olvass be egy rendelést, vagy válassz a listából.', 'package')}</div>
        <div class="pk-pack__side">
          <section class="panel panel--flush" aria-labelledby="pk-queue-h"><div class="panel__head"><h2 id="pk-queue-h">Csomagolásra vár</h2><span data-queue-count class="small muted"></span></div><div data-queue>${ui.loading()}</div></section>
          <section class="panel panel--flush" aria-labelledby="pk-packed-h"><div class="panel__head"><h2 id="pk-packed-h">Ma becsomagolva</h2></div><div data-packed></div></section>
        </div>
      </div>`);
    const $ = (sel) => root.querySelector(sel);
    const scan = $('#pack-scan');
    scan.setAttribute('data-autofocus', '');
    const feedback = (text, tone = 'info') => {
      const box = $('[data-feedback]');
      box.textContent = text;
      box.dataset.tone = tone;
      if (tone === 'ok' || tone === 'danger') buzz(tone === 'ok');
    };

    async function loadQueue() {
      const q = await api.get('/api/picking/packing', { wave_id: waveId || '' });
      $('[data-queue-count]').textContent = `${fmt.int(q.ready.length)} rendelés${q.still_picking ? `, kiszedés alatt még ${fmt.int(q.still_picking)}` : ''}${q.wave ? ` · ${q.wave.number}` : ''}`;
      $('[data-queue]').innerHTML = String(ui.table({
        caption: 'Csomagolásra váró rendelések',
        rows: q.ready,
        empty: 'Nincs csomagolásra váró rendelés.',
        columns: [
          { key: 'number', label: 'Rendelés', cls: 'nowrap', render: (o) => html`<span class="mono">${o.number}</span>${o.priority === 'express' ? html` <span class="chip" data-tone="warn">Expressz</span>` : ''}<span class="sub">${o.partner_code}${o.wave_number ? ` · ${o.wave_number}` : ''}</span>` },
          { key: 'customer_name', label: 'Vevő', render: (o) => html`${o.customer_name}<span class="sub">${o.carrier_name ? FL.orders.carrierShort(o.carrier_name, o.carrier_code) : 'nincs fuvarozó'}</span>` },
          { key: 'item_count', label: 'Db', align: 'r', cls: 'num' },
          { key: 'id', label: '', align: 'r', render: (o) => html`<button class="btn btn--sm" type="button" data-action="open" data-id="${o.id}">Csomagolás</button>` },
        ],
      }));
      $('[data-packed]').innerHTML = String(ui.table({
        caption: 'Ma becsomagolt rendelések',
        rows: q.packed,
        empty: 'Ma még nem csomagoltál rendelést.',
        columns: [
          { key: 'number', label: 'Rendelés', render: (o) => html`<button class="link-btn mono" type="button" data-action="open" data-id="${o.id}">${o.number}</button><span class="sub">${fmt.time(o.packed_at)}</span>` },
          { key: 'tracking_number', label: 'Nyomkövetés', render: (o) => html`<span class="mono small">${o.tracking_number || ''}</span><span class="sub">${FL.orders.carrierShort(o.carrier_name, o.carrier_code)}</span>` },
          { key: 'label_document_id', label: '', align: 'r', render: (o) => (o.label_document_id ? html`<a class="btn btn--sm" href="${api.documentUrl(o.label_document_id, true)}" target="_blank" rel="noopener">${FL.icon('printer')}Címke</a>` : '') },
        ],
      }));
    }

    function paintOrder() {
      const box = $('[data-order]');
      if (!order) { box.innerHTML = String(ui.empty('Olvass be egy rendelést, vagy válassz a listából.', 'package')); return; }
      const o = order;
      const booked = o.status === 'picking' && !!o.tracking_number;
      const canLabel = o.carrier && o.carrier.configured && !booked;
      const useManual = manual || !canLabel;
      const missing = o.lines.filter((l) => l.picked_qty < l.qty);
      let action = '';
      if (o.status === 'picking' && o.all_picked && canEdit) {
        action = html`<form class="form pk-packform" data-packform novalidate>
          <div class="form-grid">
            ${ui.field({ name: 'package_count', label: 'Csomagok száma', type: 'number', int: true, min: 1, max: 99, value: o.package_count || 1, required: true })}
            ${ui.field({ name: 'weight_kg', label: 'Súly (kg)', type: 'number', min: 0, step: '0.01', value: o.weight_kg ?? o.suggested_weight_kg ?? '', optional: true, hint: o.suggested_weight_kg ? `A cikktörzs szerint ${fmt.kg(o.suggested_weight_kg)}` : '' })}
            ${useManual ? ui.field({ name: 'tracking_number', label: 'Nyomkövetési szám', type: 'code', value: o.tracking_number || '', required: o.tracking_required, optional: !o.tracking_required, hint: 'Olvasd be a címke vonalkódját, vagy írd be.', span: 2 }) : ''}
          </div>
          ${labelError ? ui.notice(html`<p>${labelError}</p>`, 'danger') : ''}
          ${booked ? ui.notice(html`<p>A futárnál már van csomag ehhez a rendeléshez: <span class="mono">${o.tracking_number}</span>.${o.label ? ' A címkét lent újranyomtathatod.' : ''} Zárd le a csomagolást.</p>`, 'info') : ''}
          ${!canLabel && !booked ? ui.notice(html`<p>${o.carrier ? `A(z) ${FL.orders.carrierShort(o.carrier.name, o.carrier.carrier_code)} futár API még nincs beállítva, ezért a címkét a futár saját felületén készítsd el, és itt add meg a nyomkövetési számot.` : 'A rendeléshez nincs fuvarozó megadva.'}</p>`, 'info') : ''}
          <div class="form-actions">
            ${booked && o.label ? html`<a class="btn" href="${api.documentUrl(o.label.id, true)}" target="_blank" rel="noopener">${FL.icon('printer')}Címke</a>` : ''}
            ${canLabel ? html`<button class="btn btn--ghost" type="button" data-action="toggle-manual">${useManual ? 'Címke a futár API-val' : 'Kézi nyomkövetési szám'}</button>` : ''}
            <button class="btn btn--primary btn--lg" type="submit">${useManual ? html`${FL.icon('check')}Csomagolás lezárása` : html`${FL.icon('tag')}Címke készítése`}</button>
          </div>
        </form>`;
      } else if (o.status === 'packed') {
        action = html`${ui.notice(html`<p><b>Becsomagolva</b> ${fmt.dateTime(o.packed_at)}: ${fmt.int(o.package_count)} csomag${o.weight_kg ? `, ${fmt.kg(o.weight_kg)}` : ''}${o.tracking_number ? html`, nyomkövetési szám: <span class="mono">${o.tracking_number}</span>` : ''}.</p>`, 'ok')}
          <div class="form-actions">
            ${canEdit && !o.pickup_id ? html`<button class="btn btn--ghost" type="button" data-action="unpack">${FL.icon('arrow-u-up-left')}Csomagolás visszavonása</button>` : ''}
            ${o.label ? html`<a class="btn" href="${api.documentUrl(o.label.id, true)}" target="_blank" rel="noopener">${FL.icon('printer')}Címke nyomtatása</a>` : ''}
            <button class="btn btn--primary" type="button" data-action="next">${FL.icon('scan')}Következő rendelés</button>
          </div>`;
      } else if (o.status === 'picking') {
        action = ui.notice(html`<p>Még nincs minden kiszedve: ${missing.map((l) => `${l.sku} (${l.qty - l.picked_qty} ${l.unit})`).join(', ')}.${o.wave ? html` <a href="${FL.routes.picking}/${o.wave.id}">Ugrás a(z) ${o.wave.number} hullámra</a>` : ''}</p>`, 'warn');
      } else {
        action = ui.notice(html`<p>Ez a rendelés nem csomagolható, az állapota: ${FL.statusLabel('order', o.status)}.</p>`, 'warn');
      }
      const href = orderHref(o.id);
      box.innerHTML = String(html`<section class="panel pk-packorder" aria-labelledby="pk-order-h">
        <div class="panel__head">
          <h2 id="pk-order-h" class="pk-ordernum">${href ? html`<a href="${href}">${o.number}</a>` : o.number}</h2>
          <span class="ol-chips">${FL.status('order', o.status)}${o.priority === 'express' ? html`<span class="chip" data-tone="warn">${FL.icon('lightning')}Expressz</span>` : ''}<span class="tag">${o.partner.code}</span></span>
        </div>
        ${o.cod_amount ? html`<p class="pk-cod">${FL.icon('coins')}<span>Utánvét: <b>${fmt.money(o.cod_amount)}</b></span></p>` : ''}
        <dl class="dl">
          <dt>Címzett</dt><dd><b>${o.customer_name}</b>${o.company ? html`, ${o.company}` : ''}</dd>
          <dt>Cím</dt><dd>${[o.zip, o.city].filter(Boolean).join(' ')}${o.address ? `, ${o.address}` : ''}${o.country !== 'HU' ? ` (${o.country})` : ''}</dd>
          ${o.pickup_point_id ? html`<dt>Átvételi pont</dt><dd class="mono">${o.pickup_point_id}</dd>` : ''}
          <dt>Fuvarozó</dt><dd>${o.carrier ? o.carrier.name : html`<span class="muted">nincs megadva</span>`}${o.carrier_service ? ` · ${o.carrier_service}` : ''}</dd>
          ${o.note ? html`<dt>Megjegyzés</dt><dd class="ol-note">${o.note}</dd>` : ''}
        </dl>
        ${ui.table({
          caption: 'Tételek ellenőrzése',
          rows: o.lines,
          columns: [
            { key: 'sku', label: 'Cikk', render: (l) => html`<span class="mono">${l.sku}</span><span class="sub">${l.name}</span>` },
            { key: 'qty', label: 'Db', align: 'r', cls: 'num', render: (l) => html`<b>${fmt.int(l.qty)}</b>` },
            { key: 'picked_qty', label: 'Kiszedve', align: 'r', render: (l) => (l.picked_qty >= l.qty ? html`<span class="chip" data-tone="ok">${FL.icon('check')}${fmt.int(l.picked_qty)}</span>` : html`<span class="chip" data-tone="danger">${fmt.int(l.picked_qty)}</span>`) },
          ],
        })}
        ${action}
      </section>`);
      const form = box.querySelector('[data-packform]');
      if (form) {
        form.addEventListener('submit', (e) => { e.preventDefault(); pack(form); });
        const t = form.querySelector('[name="tracking_number"]');
        // Later than ui.bindScan's own refocus, so a scanned label lands in the tracking field.
        setTimeout(() => (t || form.querySelector('[type="submit"]')).focus(), 0);
      }
    }

    async function pack(form) {
      const v = ui.formValues(form);
      const submit = form.querySelector('[type="submit"]');
      const mode = form.querySelector('[name="tracking_number"]') ? 'manual' : 'label';
      submit.setAttribute('aria-busy', 'true');
      submit.disabled = true;
      try {
        order = await api.post(`/api/picking/orders/${order.id}/pack`, { mode, package_count: v.package_count || 1, weight_kg: v.weight_kg, tracking_number: v.tracking_number || '' });
        labelError = '';
        manual = false;
        paintOrder();
        feedback(`${order.number} becsomagolva.${order.wave_completed ? ' A hullám minden rendelése kész, a hullám lezárult.' : ''}${order.warning ? ` ${order.warning}` : ''}`, order.warning ? 'danger' : 'ok');
        if (order.label) window.open(api.documentUrl(order.label.id, true), '_blank', 'noopener');
        await loadQueue();
        scan.focus();
      } catch (err) {
        if (mode === 'label' && (err.status === 409 || err.status === 400)) {
          // The courier refused, is not set up or did not answer: reload the order (the tracking
          // number may already be saved) and offer the manual tracking number.
          try { order = await api.get(`/api/picking/orders/${order.id}`); } catch { /* keep the old copy */ }
          labelError = err.message;
          manual = true;
          paintOrder();
          feedback(err.message, 'danger');
          return;
        }
        ui.showErrors(form, err);
        feedback(err.message, 'danger');
      } finally {
        if (submit.isConnected) { submit.removeAttribute('aria-busy'); submit.disabled = false; }
      }
    }

    async function show(id) {
      try {
        order = await api.get(`/api/picking/orders/${id}`);
        manual = false;
        labelError = '';
        history.replaceState(null, '', `${FL.routes.picking}/csomagolas/${order.id}${FL.qs({ hullam: waveId || '' })}`);
        paintOrder();
        feedback(`${order.number}: ${order.customer_name}. ${order.status === 'picking' && order.all_picked ? 'Ellenőrizd a tételeket, és csomagold be.' : ''}`, 'info');
      } catch (err) {
        feedback(err.message, 'danger');
      }
    }

    ui.bindScan(root, 'pack-scan', async (code) => {
      try {
        order = await api.get('/api/picking/packing/lookup', { code, wave_id: waveId || '' });
        manual = false;
        labelError = '';
        history.replaceState(null, '', `${FL.routes.picking}/csomagolas/${order.id}${FL.qs({ hullam: waveId || '' })}`);
        paintOrder();
        feedback(`${order.number}: ${order.customer_name}.`, 'ok');
      } catch (err) {
        feedback(err.message, 'danger');
        scan.focus();
      }
    });
    ui.bind(root, {
      open: (el) => show(Number(el.dataset.id)),
      'toggle-manual': () => { manual = !manual; labelError = ''; paintOrder(); },
      next: () => { order = null; paintOrder(); scan.focus(); history.replaceState(null, '', `${FL.routes.picking}/csomagolas${FL.qs({ hullam: waveId || '' })}`); },
      unpack: async () => {
        const r = await ui.dialog({
          title: `${order.number}: csomagolás visszavonása`, size: 'narrow', submitLabel: 'Visszavonás', submitTone: 'danger',
          body: html`<p>A rendelés visszakerül csomagolásra váró állapotba, a nyomkövetési szám törlődik. A futárnál már létrehozott küldeményt a futár felületén kell törölni.</p>${ui.field({ name: 'reason', label: 'Ok', required: true })}`,
          onSubmit: async (form) => {
            const reason = form.reason.value.trim();
            if (!reason) throw new FL.ApiError(400, 'bad_request', 'Add meg az okát.', { reason: 'Kötelező mező.' });
            return api.post(`/api/picking/orders/${order.id}/unpack`, { reason });
          },
        }).done;
        if (!r) return;
        order = r;
        paintOrder();
        await loadQueue();
        feedback('Csomagolás visszavonva.', 'info');
      },
    });
    await loadQueue();
    const orderId = Number(ctx.params[1]);
    if (orderId) await show(orderId);
    else scan.focus();
  }

  FL.view('picking', {
    async render(root, ctx) {
      root.classList.add('pk-root');
      const [first] = ctx.params;
      if (first === 'csomagolas') { await renderPacking(root, ctx); return; }
      if (first) {
        const id = Number(first);
        if (!Number.isInteger(id) || id <= 0) { root.innerHTML = String(ui.empty('Ez a hullám nem létezik.', 'warning-circle')); return; }
        await renderWave(root, id);
        return;
      }
      await renderList(root, ctx);
    },
  });
})();
