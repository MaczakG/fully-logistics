/* Fuvarszervezés views; transport.js routes these two sections here.
     #/fuvarszervezes/tervezo?date=   Fuvartervező: the egyedi fuvarok (open orders that are neither webshop
                                      nor courier orders) on top as a list or on a map; below the carriers
                                      25% | their trucks 25% | the chosen truck's load for the day 50%.
                                      Drag an order onto a truck or back, or select and Hozzárendelés;
                                      Automatikus rendezés plans the day with an algorithm (not AI).
     #/fuvarszervezes/teherautok      Teherautók: the trucks of the carriers, new / edit / delete. */
(() => {
  'use strict';
  const FL = window.FL;
  const { html, raw, ui, api, fmt } = FL;
  const ROOT = '#/fuvarszervezes';
  const COLORS = ['#0a6ed1', '#e9730c', '#107e3e', '#925ace', '#bb0000', '#1b90a6', '#c35500', '#6c32a9'];
  const OPEN = ['new', 'hold', 'picking', 'packed'];
  const BUDAPEST = { lat: 47.4979, lng: 19.0402 };
  const can = (a) => FL.can('transport', a);
  const color = (t) => COLORS[(t.id - 1) % COLORS.length];
  const kg = (n) => `${fmt.int(Math.round(n || 0))} kg`;

  // Leaflet (assets/vendor/leaflet, BSD-2-Clause) is loaded the first time the map is opened.
  let leafletLoading = null;
  const leaflet = () => leafletLoading || (leafletLoading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/assets/vendor/leaflet/leaflet.css';
    document.head.append(css);
    const js = document.createElement('script');
    js.src = '/assets/vendor/leaflet/leaflet.js';
    js.onload = () => resolve(window.L);
    js.onerror = () => { leafletLoading = null; reject(new Error('A térkép nem töltődött be.')); };
    document.head.append(js);
  }));

  /* ------------------------------------------------------------ the algorithm (not AI) */

  // Road km from the straight line (haversine x 1.3); every tour starts and ends at the depot. A stop
  // without a map position counts as at the depot.
  const ROAD = 1.3;
  const FIXED_KM = 80; // a truck that goes out at all costs this much more, so the plan uses as few trucks as it can
  function km(a, b) {
    if (a.lat == null || b.lat == null) return 0;
    const r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r;
    const dLng = (b.lng - a.lng) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h)) * ROAD;
  }
  function tourKm(depot, stops) {
    if (!stops.length) return 0;
    let d = 0;
    let at = depot;
    for (const o of stops) { d += km(at, o); at = o; }
    return d + km(at, depot);
  }

  // Capacitated routing: regret insertion (the order that would lose most by missing its best place goes
  // first), then local search (move a stop to its best place on any truck, 2-opt each tour) while the
  // total gets shorter. fleet: trucks with pallets and max_kg (0: no limit); orders: { id, lat, lng,
  // pallets, kg }. Returns Map truck id -> orders in stop order, and the orders that fit nowhere.
  function optimize(depot, fleet, orders) {
    const routes = new Map(fleet.map((t) => [t.id, []]));
    const fits = (t, list) => (!t.pallets || list.reduce((n, o) => n + o.pallets, 0) <= t.pallets)
      && (!t.max_kg || list.reduce((n, o) => n + o.kg, 0) <= t.max_kg);
    const cost = (r) => (r.length ? tourKm(depot, r) + FIXED_KM : 0);
    let pool = [...orders];
    while (pool.length) {
      let pick = null;
      for (const o of pool) {
        const options = [];
        for (const t of fleet) {
          const r = routes.get(t.id);
          if (!fits(t, [...r, o])) continue;
          let best = Infinity;
          let at = 0;
          for (let i = 0; i <= r.length; i++) {
            const c = cost([...r.slice(0, i), o, ...r.slice(i)]) - cost(r);
            if (c < best) { best = c; at = i; }
          }
          options.push({ t, at, c: best });
        }
        if (!options.length) continue;
        options.sort((a, b) => a.c - b.c);
        const regret = (options[1] ? options[1].c : 1e6) - options[0].c;
        if (!pick || regret > pick.regret) pick = { o, regret, ...options[0] };
      }
      if (!pick) break;
      routes.get(pick.t.id).splice(pick.at, 0, pick.o);
      pool = pool.filter((x) => x !== pick.o);
    }
    const total = () => [...routes.values()].reduce((n, r) => n + cost(r), 0);
    for (let better = true, round = 0; better && round < 50; round++) {
      better = false;
      for (const t of fleet) {
        for (const o of [...routes.get(t.id)]) {
          const from = routes.get(t.id);
          const i = from.indexOf(o);
          const before = total();
          from.splice(i, 1);
          let best = null;
          for (const u of fleet) {
            const r = routes.get(u.id);
            if (!fits(u, [...r, o])) continue;
            for (let j = 0; j <= r.length; j++) {
              r.splice(j, 0, o);
              const gain = before - total();
              r.splice(j, 1);
              if (gain > 1e-6 && (!best || gain > best.gain)) best = { gain, u, j };
            }
          }
          if (best) { routes.get(best.u.id).splice(best.j, 0, o); better = true; } else from.splice(i, 0, o);
        }
      }
      for (const r of routes.values()) {
        for (let i = 0; i < r.length - 1; i++) {
          for (let j = i + 1; j < r.length; j++) {
            const next = [...r.slice(0, i), ...r.slice(i, j + 1).reverse(), ...r.slice(j + 1)];
            if (tourKm(depot, next) < tourKm(depot, r) - 1e-6) { r.splice(0, r.length, ...next); better = true; }
          }
        }
      }
    }
    return { routes, left: pool };
  }
  
  /* ------------------------------------------------------------ Fuvartervező */

  async function renderPlanner(root, ctx) {
    root.classList.add('list-page', 'tp');
    const st = {
      date: ctx.query.get('date') || FL.today(),
      q: '', client: '', sel: new Set(), carrier: null, truck: null, map: false, focus: null, undo: null, geocoding: false,
    };
    let day = null;
    let map = null;
    let layer = null;
    let alive = true;

    root.innerHTML = String(html`
      ${ui.pageHead({
        title: 'Fuvartervező',
        actions: html`<span class="tp-selinfo" data-selinfo></span>
          <button class="btn" type="button" data-action="undo" hidden>${FL.icon('arrow-u-up-left')}Visszavonás</button>
          ${can('edit') ? html`<button class="btn" type="button" data-action="auto">${FL.icon('lightning')}Automatikus rendezés</button>` : ''}
          ${can('approve') ? html`<button class="btn" type="button" data-action="dispatch">${FL.icon('truck')}Járat indítása</button>` : ''}
          <button class="btn" type="button" data-action="export">${FL.icon('download-simple')}Exportálás</button>
          ${can('edit') ? html`<button class="btn btn--primary" type="button" data-action="assign">${FL.icon('truck')}Hozzárendelés</button>` : ''}`,
      })}
      <form class="toolbar" data-filters role="search">
        ${ui.field({ name: 'date', label: 'Nap', type: 'date', value: st.date })}
        <div class="field field--grow"><label for="tp-q">Keresés</label>
          <input class="input" id="tp-q" name="q" type="search" placeholder="Rendelésszám, címzett, város" autocomplete="off"></div>
        <div class="field"><label for="tp-client">Ügyfél</label><select class="select" id="tp-client" name="client"></select></div>
        <div class="actions toolbar__buttons">
          <button class="btn btn--primary" type="submit">${FL.icon('magnifying-glass')}Keresés</button>
          <button class="btn" type="button" data-action="clear">Szűrők törlése</button>
          <button class="btn" type="button" data-action="view" aria-pressed="false">${FL.icon('map-trifold')}<span>Térkép</span></button>
        </div>
      </form>
      <div class="tp-top" data-drop="top"><div class="table-wrap" data-orders>${ui.loading()}</div><div class="tp-map" data-map hidden></div></div>
      <div class="tp-bottom">
        <div class="tp-pane"><div class="tp-pane__head">Fuvarozók</div><div class="table-wrap" data-carriers></div></div>
        <div class="tp-pane"><div class="tp-pane__head" data-thead>Teherautók</div><div class="table-wrap" data-trucks></div></div>
        <div class="tp-pane" data-drop="load"><div class="tp-pane__head" data-lhead></div><div class="table-wrap" data-load></div></div>
      </div>`);
    const $ = (s) => root.querySelector(s);
    const form = $('[data-filters]');

    const depot = () => (day.depot.lat != null ? day.depot : { ...day.depot, ...BUDAPEST });
    const trucks = () => day.trucks;
    const truck = (id) => day.trucks.find((t) => t.id === id);
    const carrierName = (id) => (day.carriers.find((c) => c.id === id) || {}).name || '';
    const loadOf = (id) => day.loads.filter((o) => o.truck_id === id);
    const locked = (id) => loadOf(id).some((o) => !OPEN.includes(o.status)); // the truck has left
    const orderById = (id) => day.orders.find((o) => o.id === id) || day.loads.find((o) => o.id === id);
    const sum = (list, k) => list.reduce((n, o) => n + (o[k] || 0), 0);
    const visible = () => {
      const q = st.q.toLowerCase();
      return day.orders.filter((o) => (!st.client || o.partner_code === st.client)
        && (!q || [o.number, o.customer_name, o.company, o.city, o.partner_name].some((x) => String(x || '').toLowerCase().includes(q))));
    };
    const cap = (have, max) => (max ? html`<span class="tp-cap" ${have > max ? raw('data-over') : ''}><i style="width:${Math.min(100, Math.round((have / max) * 100))}%"></i></span>` : '');
    const who = (o) => html`${o.company || o.customer_name}${o.company && o.customer_name ? html`<span class="sub">${o.customer_name}</span>` : ''}`;
    const where = (o) => html`${o.zip} ${o.city}<span class="sub">${o.address}</span>`;

    async function load() {
      day = await api.get('/api/transport/planner', { date: st.date });
      if (!alive) return;
      if (!day.carriers.some((c) => c.id === st.carrier)) st.carrier = day.carriers.length ? day.carriers[0].id : null;
      if (!truck(st.truck) || truck(st.truck).carrier_id !== st.carrier) st.truck = (trucks().find((t) => t.carrier_id === st.carrier) || {}).id || null;
      const clients = [...new Map([...day.orders, ...day.loads].map((o) => [o.partner_code, o.partner_name])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'hu'));
      form.client.innerHTML = String(ui.options(clients.map(([c, n]) => [c, n]), st.client, 'Mind'));
      paint();
      if (!st.geocoding && [...day.orders, ...day.loads, day.depot].some((o) => o.lat == null && (o.city || o.address))) geocode();
    }

    // Map positions of new addresses: a few per call, while the page is open.
    async function geocode() {
      st.geocoding = true;
      try {
        for (;;) {
          const r = await api.post('/api/transport/planner/geocode');
          if (!alive || r.disabled || r.error || !r.done) break;
          const fresh = await api.get('/api/transport/planner', { date: st.date });
          if (!alive) break;
          day = fresh;
          paintMap();
          if (!r.left) break;
        }
      } catch (err) {
        // the map just stays without the positions still missing
      } finally {
        st.geocoding = false;
      }
    }

    // Saves trucks' loads (Map truck id -> order ids in stop order) and/or takes orders off.
    async function save(loads, unassign = [], undo = null) {
      try {
        day = await api.put('/api/transport/planner', {
          date: st.date, loads: [...loads].map(([truckId, ids]) => ({ truck_id: truckId, order_ids: ids })), unassign,
        });
        st.undo = undo;
      } catch (err) {
        ui.toast(err.message, 'error');
        day = await api.get('/api/transport/planner', { date: st.date });
      }
      for (const id of [...st.sel]) if (!day.orders.some((o) => o.id === id)) st.sel.delete(id);
      paint();
    }
    function assign(ids, truckId, beforeId = null) {
      const t = truck(truckId);
      if (!t.active) { ui.toast(`${t.plate} nincs üzemben, nem tervezhető rá.`, 'error'); return; }
      if (locked(truckId)) { ui.toast(`${t.plate} járata már elindult.`, 'error'); return; }
      const loads = new Map();
      for (const id of ids) {
        const o = orderById(id);
        if (o.truck_id && o.truck_date === st.date && o.truck_id !== truckId) loads.set(o.truck_id, loadOf(o.truck_id).map((x) => x.id).filter((x) => !ids.includes(x)));
      }
      const target = loadOf(truckId).map((x) => x.id).filter((x) => !ids.includes(x));
      const at = beforeId == null ? -1 : target.indexOf(beforeId);
      target.splice(at === -1 ? target.length : at, 0, ...ids);
      loads.set(truckId, target);
      st.truck = truckId;
      st.carrier = t.carrier_id;
      return save(loads);
    }

    /* ---------- painting */
    function paintOrders() {
      const rows = visible();
      const all = rows.length && rows.every((o) => st.sel.has(o.id));
      $('[data-orders]').innerHTML = String(rows.length ? html`<table class="table">
        <thead><tr>
          <th class="w-check">${can('edit') ? html`<input type="checkbox" aria-label="Összes kijelölése" data-select-all ${all ? raw('checked') : ''}>` : ''}</th>
          <th>Rendelés</th><th>Ügyfél</th><th>Címzett</th><th>Cím</th><th class="r">Raklap</th><th class="r">Súly</th><th>Állapot</th><th>Megjegyzés</th>
        </tr></thead>
        <tbody>${rows.map((o) => html`<tr ${can('edit') ? raw('draggable="true"') : ''} data-order="${o.id}" ${st.sel.has(o.id) ? raw('data-selected="true"') : ''}>
          <td class="w-check">${can('edit') ? html`<input type="checkbox" aria-label="Kijelölés" data-select="${o.id}" ${st.sel.has(o.id) ? raw('checked') : ''}>` : ''}</td>
          <td class="nowrap"><a class="mono" href="#/megrendelesek/${o.id}">${o.number}</a>${o.priority === 'express' ? html`<span class="sub">expressz</span>` : ''}</td>
          <td>${o.partner_name}<span class="sub">${o.partner_code}</span></td>
          <td>${who(o)}</td><td>${where(o)}</td>
          <td class="r num">${o.pallets || ''}</td><td class="r num nowrap">${kg(o.kg)}</td>
          <td>${FL.status('order', o.status)}${o.truck_id ? html`<span class="sub">Elmaradt: ${(truck(o.truck_id) || {}).plate}, ${fmt.date(o.truck_date)}</span>` : ''}</td><td class="small">${o.note}</td></tr>`)}</tbody>
      </table><div class="table-foot"><span>${fmt.int(rows.length)} tétel</span></div>`
        : ui.empty(st.q || st.client ? 'Nincs a szűrésnek megfelelő rendelés.' : 'Nincs teherautóra váró egyedi fuvar.', 'check'));
    }

    function paintCarriers() {
      $('[data-carriers]').innerHTML = String(day.carriers.length ? html`<table class="table">
        <thead><tr><th>Fuvarozó</th><th class="r">Teherautó</th></tr></thead>
        <tbody>${day.carriers.map((c) => {
          const n = trucks().filter((t) => t.carrier_id === c.id).reduce((k, t) => k + loadOf(t.id).length, 0);
          return html`<tr data-carrier="${c.id}" ${c.id === st.carrier ? raw('data-current="true"') : ''}>
            <td>${c.name}${n ? html`<span class="sub">${fmt.int(n)} rendelés ezen a napon</span>` : ''}</td>
            <td class="r num">${fmt.int(trucks().filter((t) => t.carrier_id === c.id).length)}</td></tr>`;
        })}</tbody></table>`
        : html`<p class="tp-hint">Nincs egyedi fuvarozó. A Partnerek között vegyél fel fuvarozót futárszolgálat nélkül.</p>`);
    }

    function paintTrucks() {
      const list = trucks().filter((t) => t.carrier_id === st.carrier);
      $('[data-thead]').innerHTML = String(html`Teherautók<span class="small muted">${carrierName(st.carrier)}</span>`);
      $('[data-trucks]').innerHTML = String(list.length ? html`<table class="table">
        <thead><tr><th>Teherautó</th><th class="r">Raklap</th><th class="r">Súly</th></tr></thead>
        <tbody>${list.map((t) => {
          const l = loadOf(t.id);
          const p = sum(l, 'pallets');
          const w = sum(l, 'kg');
          return html`<tr data-truck="${t.id}" ${t.id === st.truck ? raw('data-current="true"') : ''} ${t.active ? '' : raw('data-inactive')}>
            <td><span class="tp-swatch" style="background:${color(t)}"></span><b class="mono">${t.plate}</b>
              ${t.active ? '' : html` <span class="chip" data-tone="warn">Szervizben</span>`}${locked(t.id) ? html` <span class="chip" data-tone="ok">Elindult</span>` : ''}
              <span class="sub">${[t.name, t.driver, l.length ? `kb. ${fmt.int(Math.round(tourKm(depot(), l)))} km` : ''].filter(Boolean).join(', ')}</span></td>
            <td class="r num">${fmt.int(p)} / ${fmt.int(t.pallets)}${cap(p, t.pallets)}</td>
            <td class="r num">${fmt.int(Math.round(w))} / ${fmt.int(t.max_kg)}${cap(w, t.max_kg)}</td></tr>`;
        })}</tbody></table>`
        : html`<p class="tp-hint">Ennek a fuvarozónak még nincs teherautója. A Teherautók menüpontban veheted fel.</p>`);
    }

    function paintLoad() {
      const t = truck(st.truck);
      if (!t || t.carrier_id !== st.carrier) {
        $('[data-lhead]').textContent = 'Rakomány';
        $('[data-load]').innerHTML = String(html`<p class="tp-hint">Válassz teherautót a középső listából.</p>`);
        return;
      }
      const l = loadOf(t.id);
      const p = sum(l, 'pallets');
      const w = sum(l, 'kg');
      const over = (t.pallets && p > t.pallets) || (t.max_kg && w > t.max_kg);
      const edit = can('edit') && !locked(t.id);
      $('[data-lhead]').innerHTML = String(html`<span><span class="tp-swatch" style="background:${color(t)}"></span>${t.plate} rakománya <span class="small muted">${fmt.date(st.date)}</span></span>
        <span class="small ${over ? 'diff-neg' : 'muted'}">${fmt.int(l.length)} rendelés, ${fmt.int(p)} / ${fmt.int(t.pallets)} raklap, ${fmt.int(Math.round(w))} / ${fmt.int(t.max_kg)} kg${l.length ? `, kb. ${fmt.int(Math.round(tourKm(depot(), l)))} km` : ''}${over ? ', túlterhelt' : ''}</span>`);
      $('[data-load]').innerHTML = String(l.length ? html`<table class="table">
        <thead><tr><th class="r">#</th><th>Rendelés</th><th>Címzett</th><th class="r">Raklap</th><th class="r">Súly</th><th>Állapot</th><th class="w-actions"></th></tr></thead>
        <tbody>${l.map((o, i) => html`<tr ${edit ? raw('draggable="true"') : ''} data-loaded="${o.id}">
          <td class="r num">${i + 1}</td>
          <td class="nowrap"><a class="mono" href="#/megrendelesek/${o.id}">${o.number}</a><span class="sub">${o.partner_code}</span></td>
          <td>${who(o)}<span class="sub">${o.zip} ${o.city}, ${o.address}</span></td>
          <td class="r num">${o.pallets || ''}</td><td class="r num nowrap">${kg(o.kg)}</td><td>${FL.status('order', o.status)}</td>
          <td class="w-actions">${edit ? html`<span class="row-actions">
            <button class="btn btn--sm btn--icon btn--ghost" type="button" data-action="up" data-id="${o.id}" aria-label="Előrébb" title="Előrébb" ${i ? '' : raw('disabled')}>${FL.icon('caret-up')}</button>
            <button class="btn btn--sm btn--icon btn--ghost" type="button" data-action="down" data-id="${o.id}" aria-label="Hátrébb" title="Hátrébb" ${i < l.length - 1 ? '' : raw('disabled')}>${FL.icon('caret-down')}</button>
            <button class="btn btn--sm" type="button" data-action="remove" data-id="${o.id}">${FL.icon('x')}Levétel</button></span>` : ''}</td></tr>`)}</tbody></table>`
        : html`<p class="tp-hint">Még üres. Húzz ide rendeléseket a felső listából, vagy jelöld ki őket, és nyomd meg a Hozzárendelés gombot.</p>`);
    }

    function paintBar() {
      const t = truck(st.truck);
      $('[data-selinfo]').innerHTML = String(st.sel.size ? html`<b>${fmt.int(st.sel.size)}</b> kijelölve, ${fmt.int(sum([...st.sel].map(orderById), 'pallets'))} raklap, ${kg(sum([...st.sel].map(orderById), 'kg'))}` : '');
      const b = $('[data-action="assign"]');
      if (b) {
        b.disabled = !st.sel.size || !t || !t.active || locked(t.id);
        b.lastChild.textContent = t ? `Hozzárendelés: ${t.plate}` : 'Hozzárendelés';
      }
      const d = $('[data-action="dispatch"]');
      if (d) {
        d.disabled = !t || !loadOf(t.id).some((o) => o.status === 'packed');
        d.lastChild.textContent = t ? `Járat indítása: ${t.plate}` : 'Járat indítása';
      }
      $('[data-action="undo"]').hidden = !st.undo;
    }

    async function paintMap() {
      if (!st.map) return;
      const box = $('[data-map]');
      let L;
      try {
        L = await leaflet();
      } catch (err) {
        box.innerHTML = String(html`<p class="tp-hint">${err.message}</p>`);
        return;
      }
      if (!alive) return;
      if (!map) {
        map = L.map(box, { zoomSnap: 0.25 }).setView([BUDAPEST.lat, BUDAPEST.lng], 7);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19, attribution: '&copy; OpenStreetMap', referrerPolicy: 'strict-origin-when-cross-origin', // the tile servers ask for the site's address
        }).addTo(map);
        layer = L.layerGroup().addTo(map);
        fitMap();
      }
      layer.clearLayers();
      const pin = (label, bg) => L.divIcon({ className: 'tp-pin', html: `<span style="background:${bg}">${label}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] });
      const dp = depot();
      L.marker([dp.lat, dp.lng], { icon: pin('R', '#354a5f'), zIndexOffset: 1000 }).bindTooltip(FL.esc(`${day.depot.name}${day.depot.address ? `, ${day.depot.address}` : ''}`)).addTo(layer);
      const info = (o) => `<b>${FL.esc(o.number)}</b><br>${FL.esc(o.company || o.customer_name)}<br>${FL.esc(`${o.zip} ${o.city}, ${o.address}`)}<br>${o.pallets} raklap, ${kg(o.kg)}<br>${FL.esc(FL.statusLabel('order', o.status))}`;
      const legend = [];
      for (const t of trucks().filter((x) => !st.focus || x.id === st.focus)) {
        const l = loadOf(t.id);
        if (!l.length) continue;
        const c = color(t);
        const pts = l.filter((o) => o.lat != null);
        L.polyline([[dp.lat, dp.lng], ...pts.map((o) => [o.lat, o.lng]), [dp.lat, dp.lng]], { color: c, weight: 5, opacity: 0.8 })
          .bindTooltip(`${FL.esc(t.plate)} járata`).on('click', () => focusRoute(t.id)).addTo(layer);
        l.forEach((o, i) => { if (o.lat != null) L.marker([o.lat, o.lng], { icon: pin(i + 1, c) }).bindPopup(`${info(o)}<br><b>${FL.esc(t.plate)}</b>, ${i + 1}. megálló`).addTo(layer); });
        legend.push(`<button class="tp-legend__item" type="button" data-focus="${t.id}"${st.focus === t.id ? ' aria-pressed="true"' : ''}><span class="tp-swatch" style="background:${c}"></span>${FL.esc(t.plate)}: ${l.length} megálló, ${fmt.int(sum(l, 'pallets'))} raklap, kb. ${fmt.int(Math.round(tourKm(dp, l)))} km</button>`);
      }
      for (const o of st.focus ? [] : visible()) {
        if (o.lat == null) continue;
        L.marker([o.lat, o.lng], { icon: pin(st.sel.has(o.id) ? '&#10003;' : '', st.sel.has(o.id) ? '#0a6ed1' : '#8696a9') })
          .bindPopup(`${info(o)}<br><span class="muted">Nincs teherautón</span>${can('edit') ? `<br><button class="btn btn--sm" type="button" data-pin="${o.id}">${st.sel.has(o.id) ? 'Kijelölés törlése' : 'Kijelölés'}</button>` : ''}`).addTo(layer);
      }
      const unknown = [...visible(), ...day.loads].filter((o) => o.lat == null).length;
      let lg = box.querySelector('.tp-legend');
      if (!lg) { lg = document.createElement('div'); lg.className = 'tp-legend'; box.append(lg); }
      lg.innerHTML = (st.focus
        ? `${legend.join('') || `<span>${FL.esc((truck(st.focus) || {}).plate || '')}: ezen a napon nincs megállója</span>`}<button class="btn btn--sm" type="button" data-focus="">Összes járat</button>`
        : `<span><span class="tp-swatch" style="background:#8696a9"></span>Nincs teherautón (kék: kijelölve)</span>${legend.join('')}<span class="muted">Kattints egy járatra, hogy csak azt lásd.</span>`)
        + (unknown ? `<span class="muted">${unknown} címnek még nincs helye a térképen${st.geocoding ? ', keresés folyamatban' : ''}.</span>` : '')
        + (day.depot.lat == null ? '<span class="muted">A raktár címét a Cégadatoknál add meg.</span>' : '');
    }
    function fitMap() {
      if (!map) return;
      const dp = depot();
      const list = (st.focus ? loadOf(st.focus) : [...day.orders, ...day.loads]).filter((o) => o.lat != null);
      map.invalidateSize();
      map.fitBounds([[dp.lat, dp.lng], ...list.map((o) => [o.lat, o.lng])], { padding: [24, 24], maxZoom: 11 });
    }
    function focusRoute(id) {
      st.focus = id;
      if (id) { st.truck = id; st.carrier = truck(id).carrier_id; }
      paintCarriers(); paintTrucks(); paintLoad(); paintBar(); paintMap(); fitMap();
    }

    const paint = () => { paintOrders(); paintCarriers(); paintTrucks(); paintLoad(); paintBar(); paintMap(); };

    /* ---------- events */
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      st.q = form.q.value.trim();
      st.client = form.client.value;
      if (form.date.value && form.date.value !== st.date) {
        st.date = form.date.value;
        st.undo = null;
        history.replaceState(null, '', `${ROOT}/tervezo${FL.qs({ date: st.date === FL.today() ? '' : st.date })}`);
        load().catch((err) => ui.toast(err.message, 'error'));
      } else paint();
    });
    root.addEventListener('change', (e) => {
      if (e.target.matches('[data-select]')) { const id = Number(e.target.dataset.select); e.target.checked ? st.sel.add(id) : st.sel.delete(id); paintOrders(); paintBar(); paintMap(); }
      if (e.target.matches('[data-select-all]')) { for (const o of visible()) (e.target.checked ? st.sel.add(o.id) : st.sel.delete(o.id)); paintOrders(); paintBar(); paintMap(); }
    });
    root.addEventListener('click', (e) => {
      const f = e.target.closest('[data-focus]');
      if (f) { focusRoute(f.dataset.focus ? Number(f.dataset.focus) : null); return; }
      const pinBtn = e.target.closest('[data-pin]');
      if (pinBtn) {
        const id = Number(pinBtn.dataset.pin);
        st.sel.has(id) ? st.sel.delete(id) : st.sel.add(id);
        if (map) map.closePopup();
        paintOrders(); paintBar(); paintMap();
        return;
      }
      const tr = e.target.closest('tr');
      if (!tr || e.target.closest('input, a, button')) return;
      if (tr.dataset.carrier) {
        st.carrier = Number(tr.dataset.carrier);
        st.truck = (trucks().find((t) => t.carrier_id === st.carrier) || {}).id || null;
        paintCarriers(); paintTrucks(); paintLoad(); paintBar();
      } else if (tr.dataset.truck) {
        st.truck = Number(tr.dataset.truck);
        if (st.map) focusRoute(st.truck); else { paintTrucks(); paintLoad(); paintBar(); }
      } else if (tr.dataset.order && can('edit')) {
        const id = Number(tr.dataset.order);
        st.sel.has(id) ? st.sel.delete(id) : st.sel.add(id);
        paintOrders(); paintBar();
      }
    });
    ui.bind(root, {
      clear: () => { form.q.value = ''; form.client.value = ''; st.q = ''; st.client = ''; paint(); },
      view: async (el) => {
        st.map = !st.map;
        el.setAttribute('aria-pressed', String(st.map));
        el.querySelector('span').textContent = st.map ? 'Lista' : 'Térkép';
        el.querySelector('use').setAttribute('href', st.map ? '#i-list' : '#i-map-trifold');
        $('[data-orders]').hidden = st.map;
        $('[data-map]').hidden = !st.map;
        root.toggleAttribute('data-map', st.map);
        await paintMap();
        if (st.map) setTimeout(fitMap, 0);
      },
      assign: (el) => ui.run(el, () => assign([...st.sel], st.truck)),
      remove: (el) => ui.run(el, () => save(new Map(), [Number(el.dataset.id)])),
      up: (el) => move(Number(el.dataset.id), -1),
      down: (el) => move(Number(el.dataset.id), 1),
      undo: (el) => ui.run(el, () => save(new Map(st.undo), [])),
      auto: (el) => ui.run(el, autoPlan),
      dispatch: async (el) => {
        const t = truck(st.truck);
        const l = loadOf(t.id);
        const ready = l.filter((o) => o.status === 'packed').length;
        const ok = await ui.confirm({
          title: `${t.plate} járatának indítása`,
          text: `A ${fmt.date(st.date)} napi ${fmt.int(ready)} feladásra kész rendelés feladott állapotba kerül.${l.length > ready ? ` ${fmt.int(l.length - ready)} még nincs becsomagolva, az a teherautón marad.` : ''}`,
          confirmLabel: 'Indítás',
        });
        if (!ok) return;
        await ui.run(el, async () => {
          const r = await api.post('/api/transport/planner/dispatch', { date: st.date, truck_id: t.id });
          ui.toast(`${t.plate}: ${fmt.int(r.shipped)} rendelés feladva.`, 'ok');
          st.undo = null;
          await load();
        });
      },
      export: () => ui.exportCsv(`fuvarterv-${st.date}`, [
        { label: 'Nap', render: () => st.date },
        { label: 'Fuvarozó', render: (o) => carrierName(truck(o.truck_id).carrier_id) },
        { label: 'Teherautó', render: (o) => truck(o.truck_id).plate },
        { label: 'Sorrend', key: 'truck_seq' },
        { label: 'Rendelés', key: 'number' },
        { label: 'Ügyfél', key: 'partner_name' },
        { label: 'Címzett', render: (o) => o.company || o.customer_name },
        { label: 'Cím', render: (o) => `${o.zip} ${o.city}, ${o.address}` },
        { label: 'Raklap', key: 'pallets' },
        { label: 'Súly (kg)', render: (o) => Math.round(o.kg) },
        { label: 'Állapot', render: (o) => FL.statusLabel('order', o.status) },
      ], day.loads),
    });
    function move(id, step) {
      const o = orderById(id);
      const ids = loadOf(o.truck_id).map((x) => x.id);
      const i = ids.indexOf(id);
      [ids[i], ids[i + step]] = [ids[i + step], ids[i]];
      return save(new Map([[o.truck_id, ids]]));
    }

    // The whole day again: the open orders of the trucks that have not left, plus every order on no
    // truck (except the ones on hold and the ones without a map position), as short as it gets.
    async function autoPlan() {
      const fleet = trucks().filter((t) => t.active && !locked(t.id));
      if (!fleet.length) { ui.toast('Nincs üzemben lévő, még el nem indult teherautó.', 'error'); return; }
      const mine = (o) => fleet.some((t) => t.id === o.truck_id);
      const candidates = [...day.loads.filter(mine), ...day.orders.filter((o) => o.status !== 'hold')];
      const placeless = candidates.filter((o) => o.lat == null);
      const { routes, left } = optimize(depot(), fleet, candidates.filter((o) => o.lat != null));
      const undo = fleet.map((t) => [t.id, loadOf(t.id).map((o) => o.id)]);
      const keep = new Set(placeless.filter((o) => o.truck_id).map((o) => o.id)); // without a position it stays where it was
      const loads = new Map(fleet.map((t) => [t.id, [...routes.get(t.id).map((o) => o.id), ...loadOf(t.id).filter((o) => keep.has(o.id)).map((o) => o.id)]]));
      await save(loads, [], undo);
      const used = fleet.filter((t) => loadOf(t.id).length);
      ui.toast(`${fmt.int(candidates.length - left.length - placeless.length)} rendelés ${fmt.int(used.length)} teherautón, összesen kb. ${fmt.int(Math.round(used.reduce((n, t) => n + tourKm(depot(), loadOf(t.id)), 0)))} km`
        + `${left.length ? `; ${left.length} nem fért el` : ''}${placeless.length ? `; ${placeless.length} címnek nincs helye a térképen` : ''}.`, 'ok');
    }

    // Drag and drop: list rows onto a truck or the load; load rows back to the list, onto another truck, or between stops.
    let drag = null;
    root.addEventListener('dragstart', (e) => {
      const tr = e.target.closest('tr[draggable]');
      if (!tr) return;
      if (tr.dataset.order) { const id = Number(tr.dataset.order); drag = { from: 'top', ids: st.sel.has(id) ? [...st.sel] : [id] }; }
      else drag = { from: 'load', ids: [Number(tr.dataset.loaded)] };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', drag.ids.join(','));
    });
    const target = (e) => {
      if (!drag) return null;
      const t = e.target.closest('tr[data-truck]');
      if (t) return t;
      const l = e.target.closest('tr[data-loaded]');
      if (l) return l;
      const zone = e.target.closest('[data-drop]');
      if (zone && zone.dataset.drop === 'load' && st.truck) return zone;
      if (zone && zone.dataset.drop === 'top' && drag.from === 'load') return zone;
      return null;
    };
    const clearOver = () => root.querySelectorAll('[data-over]').forEach((x) => x.removeAttribute('data-over'));
    root.addEventListener('dragover', (e) => { const t = target(e); if (!t) return; e.preventDefault(); clearOver(); t.setAttribute('data-over', 'true'); });
    root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) clearOver(); });
    root.addEventListener('dragend', () => { clearOver(); drag = null; });
    root.addEventListener('drop', (e) => {
      const t = target(e);
      if (!t) return;
      e.preventDefault();
      clearOver();
      const { ids: moved } = drag;
      drag = null;
      if (t.dataset.truck) assign(moved, Number(t.dataset.truck));
      else if (t.dataset.loaded) assign(moved, st.truck, Number(t.dataset.loaded));
      else if (t.dataset.drop === 'load') assign(moved, st.truck);
      else if (t.dataset.drop === 'top') save(new Map(), moved);
    });

    await load();
    return { destroy() { alive = false; if (map) map.remove(); } };
  }

  /* ------------------------------------------------------------ Teherautók */

  async function renderTrucks(root, ctx) {
    root.classList.add('list-page', 'tr-trucks');
    const f = { q: ctx.query.get('q') || '', carrier_id: ctx.query.get('carrier_id') || '', active: ctx.query.get('active') || '' };
    const [data, carriers] = await Promise.all([
      api.get('/api/transport/trucks'),
      api.get('/api/lookup/partners', { type: 'carrier', all: 1 }),
    ]);
    const egyedi = carriers.items.filter((p) => !p.carrier_code);
    const q = f.q.toLowerCase();
    const rows = data.items.filter((t) => (!f.carrier_id || String(t.carrier_id) === f.carrier_id) && (!f.active || String(t.active) === f.active)
      && (!q || [t.plate, t.name, t.driver].some((x) => String(x || '').toLowerCase().includes(q))));
    const columns = [
      { key: 'plate', label: 'Rendszám', render: (t) => html`<span class="tp-swatch" style="background:${color(t)}"></span><button class="link-btn mono" type="button" data-action="edit" data-id="${t.id}">${t.plate}</button>` },
      { key: 'name', label: 'Megnevezés' },
      { key: 'carrier_name', label: 'Fuvarozó' },
      { key: 'driver', label: 'Sofőr' },
      { key: 'pallets', label: 'Raklaphely', align: 'r', cls: 'num', render: (t) => fmt.int(t.pallets) },
      { key: 'max_kg', label: 'Teherbírás', align: 'r', cls: 'num', render: (t) => kg(t.max_kg) },
      { key: 'today_stops', label: 'Ma', align: 'r', cls: 'num', render: (t) => (t.today_stops ? `${fmt.int(t.today_stops)} megálló` : '') },
      { key: 'active', label: 'Állapot', render: (t) => (t.active ? html`<span class="chip" data-tone="ok">Üzemben</span>` : html`<span class="chip" data-tone="warn">Szervizben</span>`) },
      {
        key: 'act', label: '', cls: 'w-actions', render: (t) => (can('delete') ? html`<span class="row-actions">
          <button class="btn btn--sm btn--ghost btn--icon" type="button" data-action="delete" data-id="${t.id}" aria-label="${t.plate} törlése" title="Törlés">${FL.icon('trash')}</button></span>` : ''),
      },
    ];
    root.innerHTML = String(html`
      ${ui.pageHead({
        title: 'Teherautók',
        actions: html`<button class="btn" type="button" data-action="export">${FL.icon('download-simple')}Exportálás</button>
          ${can('create') ? html`<button class="btn btn--primary" type="button" data-action="new">${FL.icon('plus')}Új teherautó</button>` : ''}`,
      })}
      <form class="toolbar" data-filters role="search">
        <div class="field field--grow"><label for="tr-q">Keresés</label>
          <input class="input" id="tr-q" name="q" type="search" value="${f.q}" placeholder="Rendszám, megnevezés, sofőr" autocomplete="off"></div>
        ${ui.field({ name: 'carrier_id', label: 'Fuvarozó', type: 'select', value: f.carrier_id, placeholder: 'Mind', options: egyedi.map((p) => [p.id, p.name]) })}
        ${ui.field({ name: 'active', label: 'Állapot', type: 'select', value: f.active, placeholder: 'Mind', options: [['1', 'Üzemben'], ['0', 'Szervizben']] })}
        ${ui.searchButtons(f.q || f.carrier_id || f.active ? { href: `${ROOT}/teherautok` } : {})}
      </form>
      ${ui.table({ caption: 'Teherautók', rows, columns, rowAttrs: (t) => `data-action="edit" data-id="${t.id}"`, empty: data.items.length ? 'Nincs a szűrésnek megfelelő teherautó.' : 'Még nincs teherautó. Vedd fel az Új teherautó gombbal.' })}`);
    root.querySelector('[data-filters]').addEventListener('submit', (e) => {
      e.preventDefault();
      FL.go(`${ROOT}/teherautok${FL.qs({ q: e.target.q.value.trim(), carrier_id: e.target.carrier_id.value, active: e.target.active.value })}`);
    });

    function truckDialog(t) {
      if (!egyedi.length) { ui.toast('Nincs egyedi fuvarozó. A Partnerek között vegyél fel fuvarozót futárszolgálat nélkül.', 'error'); return; }
      const ro = t ? !can('edit') : false;
      ui.dialog({
        title: t ? `${t.plate} szerkesztése` : 'Új teherautó',
        size: 'narrow',
        hideSubmit: ro,
        body: html`<div class="form-grid">
          ${ui.field({ name: 'carrier_id', label: 'Fuvarozó', type: 'select', required: true, value: t ? t.carrier_id : f.carrier_id, placeholder: 'Válassz fuvarozót', options: egyedi.filter((p) => p.status === 'active' || (t && p.id === t.carrier_id)).map((p) => [p.id, p.name]), span: 'all' })}
          ${ui.field({ name: 'plate', label: 'Rendszám', required: true, value: t ? t.plate : '', attrs: 'placeholder="AA BC-123" autocomplete="off"' })}
          ${ui.field({ name: 'driver', label: 'Sofőr', optional: true, value: t ? t.driver : '' })}
          ${ui.field({ name: 'name', label: 'Megnevezés', optional: true, value: t ? t.name : '', attrs: 'placeholder="7,5 t ponyvás, emelőhátfalas"', span: 'all' })}
          ${ui.field({ name: 'pallets', label: 'Raklaphely', type: 'number', int: true, min: 0, value: t ? t.pallets : 15 })}
          ${ui.field({ name: 'max_kg', label: 'Teherbírás (kg)', type: 'number', int: true, min: 0, value: t ? t.max_kg : 3500 })}
          ${ui.field({ name: 'active', label: 'Üzemben (szerviz alatt kapcsold ki)', type: 'checkbox', value: t ? !!t.active : true, span: 'all' })}
        </div>`,
        onSubmit: async (form) => {
          const v = ui.formValues(form);
          const body = { carrier_id: Number(v.carrier_id), plate: v.plate, driver: v.driver, name: v.name, pallets: Number(v.pallets) || 0, max_kg: Number(v.max_kg) || 0, active: !!v.active };
          const saved = t ? await api.put(`/api/transport/trucks/${t.id}`, body) : await api.post('/api/transport/trucks', body);
          ui.toast(`${saved.plate} ${t ? 'mentve' : 'felvéve'}.`, 'ok');
          FL.reload();
          return saved;
        },
      });
    }
    ui.bind(root, {
      new: () => truckDialog(null),
      edit: (el) => truckDialog(data.items.find((t) => t.id === Number(el.dataset.id))),
      delete: async (el) => {
        const t = data.items.find((x) => x.id === Number(el.dataset.id));
        if (!(await ui.confirm({ title: 'Teherautó törlése', text: `Törlöd a(z) ${t.plate} teherautót?`, confirmLabel: 'Törlés', tone: 'danger' }))) return;
        await ui.run(el, async () => { await api.del(`/api/transport/trucks/${t.id}`); ui.toast(`${t.plate} törölve.`, 'ok'); FL.reload(); });
      },
      export: () => ui.exportCsv('teherautok', columns, rows),
    });
    return null;
  }

  FL.planner = { optimize, renderPlanner, renderTrucks };
})();
