/* Beállítások (module "settings"): route #/beallitasok/<tab>
     cegadatok      company data for quotes and invoices
     raktar         cut-off (top bar countdown), opening hours, workdays, default carrier; costing
                    assumptions of the quote calculator's internal margin (rent, area, the rack
                    of each location size with its levels, staff cost, minute norms)
     raktarhelyek   location sizes and locations (filters, bulk create from a pattern, bulk size
                    change, CSV import and export)
     alaptarifak    default tariffs and quote terms for new client partners and new quotes
     futarok        courier accounts, forms rendered from the adapters' field definitions
     szamlazo       invoicing provider (Számlázz.hu, Billingo)
     naplo          activity log and integration log
   Credentials only ever arrive masked; an empty input keeps the stored value. */
(() => {
  'use strict';
  const { html, raw, ui, api, fmt } = FL;
  const BASE = '#/beallitasok';
  const TABS = [
    { key: 'cegadatok', label: 'Cégadatok', icon: 'identification-card' },
    { key: 'raktar', label: 'Raktár', icon: 'warehouse' },
    { key: 'raktarhelyek', label: 'Raktárhelyek', icon: 'map-trifold' },
    { key: 'alaptarifak', label: 'Alap tarifák', icon: 'coins' },
    { key: 'futarok', label: 'Futárszolgálatok', icon: 'truck' },
    { key: 'szamlazo', label: 'Számlázó', icon: 'invoice' },
    { key: 'naplo', label: 'Napló', icon: 'clock-counter-clockwise' },
  ];
  const can = (action) => FL.can('settings', action);
  const meta = () => FL.state.meta;
  const kindLabel = (k) => (meta().locationKinds || {})[k] || k;

  // Page frame shared by every tab: header, tab bar, body.
  function frame(root, tab, { lead, actions, body }) {
    root.innerHTML = String(html`
      ${ui.pageHead({ title: 'Beállítások', lead, actions })}
      ${ui.tabs(TABS.map((t) => ({ key: t.key, label: t.label, href: `${BASE}/${t.key}` })), tab, 'Beállítások részei')}
      ${body}`);
  }

  const readOnlyNotice = () => (can('edit') ? '' : ui.notice('Ezt a részt csak megtekintheted: a módosításhoz Beállítások módosítása jog kell.', 'info', 'lock-simple'));
  const disabledIf = (cond) => (cond ? raw('disabled') : '');

  // Submits a page form with a busy button and field errors.
  function bindForm(form, submit) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      ui.clearErrors(form);
      if (btn) { btn.setAttribute('aria-busy', 'true'); btn.disabled = true; }
      try {
        await submit(ui.formValues(form));
      } catch (err) {
        ui.showErrors(form, err);
      } finally {
        if (btn) { btn.removeAttribute('aria-busy'); btn.disabled = false; }
      }
    });
  }

  // Splits "prefix.key" form values into { prefix: { key: value } }.
  function nested(values) {
    const out = {};
    for (const [k, v] of Object.entries(values)) {
      const i = k.indexOf('.');
      if (i < 0) { out[k] = v; continue; }
      const head = k.slice(0, i);
      (out[head] ||= {})[k.slice(i + 1)] = v;
    }
    return out;
  }

  async function clientOptions() {
    const { items } = await api.get('/api/lookup/partners', { type: 'client', all: 1 });
    return items.map((p) => ({ value: p.id, label: `${p.name} (${p.code})${p.status === 'active' ? '' : ', inaktív'}` }));
  }

  // ================================================================ Cégadatok
  async function companyTab(root) {
    const c = await api.get('/api/settings/company');
    const f = (name, label, opts = {}) => ui.field({ name, label, value: c[name] ?? '', optional: !opts.required, ...opts });
    frame(root, 'cegadatok', {
      lead: 'A cégadatok az ajánlatokon, az elszámolásokon és a számlákon jelennek meg.',
      body: html`
        ${readOnlyNotice()}
        <form class="panel" id="company-form" novalidate>
          <fieldset class="form" ${disabledIf(!can('edit'))}>
            <legend class="visually-hidden">Cégadatok</legend>
            <h2>Cég</h2>
            <div class="form-grid">
              ${f('name', 'Cégnév', { required: true, span: 2, autocomplete: 'organization' })}
              ${f('tax_number', 'Adószám', { placeholder: '12345678-1-12' })}
              ${f('eu_vat_number', 'Közösségi adószám', { placeholder: 'HU12345678' })}
              ${f('company_reg_number', 'Cégjegyzékszám', { placeholder: '13-09-123456' })}
            </div>
            <h2>Székhely</h2>
            <div class="form-grid">
              ${f('country', 'Ország', { type: 'code', placeholder: 'HU', hint: 'Kétbetűs kód.' })}
              ${f('zip', 'Irányítószám')}
              ${f('city', 'Település')}
              ${f('address', 'Utca, házszám', { span: 2 })}
            </div>
            <h2>Elérhetőség</h2>
            <div class="form-grid">
              ${f('email', 'E-mail', { type: 'email' })}
              ${f('phone', 'Telefon', { type: 'tel' })}
              ${f('website', 'Weboldal', { placeholder: 'https://fully.hu' })}
            </div>
            <h2>Bank</h2>
            <div class="form-grid">
              ${f('bank_name', 'Bank neve')}
              ${f('bank_account', 'Bankszámlaszám', { span: 2, placeholder: '12345678-12345678-12345678 vagy IBAN' })}
            </div>
          </fieldset>
          ${can('edit') ? html`<div class="form-actions"><button class="btn btn--primary" type="submit">Mentés</button></div>` : ''}
        </form>`,
    });
    const form = root.querySelector('#company-form');
    bindForm(form, async (values) => {
      const saved = await api.put('/api/settings/company', values);
      for (const [k, v] of Object.entries(saved)) { const el = form.elements[k]; if (el) el.value = v ?? ''; }
      if (FL.state.me) FL.state.me.company.name = saved.name;
      ui.toast('Cégadatok mentve.', 'ok');
    });
  }

  // ================================================================ Raktár
  const DAYS = [[1, 'Hétfő'], [2, 'Kedd'], [3, 'Szerda'], [4, 'Csütörtök'], [5, 'Péntek'], [6, 'Szombat'], [7, 'Vasárnap']];

  async function warehouseTab(root) {
    const [w, cost] = await Promise.all([api.get('/api/settings/warehouse'), api.get('/api/settings/costing')]);
    const money = (v) => fmt.money(v);
    const numField = (name, label, value, extra = {}) => ui.field({ name, label, type: 'number', value, min: 0, attrs: 'inputmode="decimal"', ...extra });
    const carriers = Object.entries(meta().carriers || {}).filter(([k]) => k !== 'other').map(([value, label]) => ({ value, label }));
    frame(root, 'raktar', {
      lead: 'Az alsónémedi raktár munkarendje. A napi rendelési határidőt a felső sáv visszaszámlálója mutatja.',
      body: html`
        ${readOnlyNotice()}
        <form class="panel" id="warehouse-form" novalidate>
          <fieldset class="form" ${disabledIf(!can('edit'))}>
            <legend class="visually-hidden">Raktár beállítások</legend>
            <div class="form-grid">
              ${ui.field({ name: 'cutoff', label: 'Napi rendelési határidő', type: 'time', value: w.cutoff, required: true, hint: 'Az eddig beérkező rendeléseket még aznap feladjuk.' })}
              ${ui.field({ name: 'open', label: 'Nyitás', type: 'time', value: w.open, optional: true })}
              ${ui.field({ name: 'close', label: 'Zárás', type: 'time', value: w.close, optional: true })}
              ${ui.field({ name: 'default_carrier_code', label: 'Alapértelmezett futár', type: 'select', value: w.default_carrier_code, options: carriers, placeholder: 'Nincs megadva', hint: 'Akkor kerül a rendelésre, ha a forrás nem ad meg futárt.' })}
            </div>
            <fieldset class="field">
              <legend class="field__label">Munkanapok</legend>
              <div class="check-row" id="workdays">
                ${DAYS.map(([n, label]) => html`<label class="check"><input type="checkbox" name="wd" value="${n}" ${(w.workdays || []).includes(n) ? raw('checked') : ''}><span>${label}</span></label>`)}
              </div>
              <p class="field__error" id="workdays-err" hidden></p>
              <input type="hidden" name="workdays">
            </fieldset>
          </fieldset>
          ${can('edit') ? html`<div class="form-actions"><button class="btn btn--primary" type="submit">Mentés</button></div>` : ''}
        </form>
        <form class="panel" id="costing-form" novalidate>
          <div class="panel__head"><h2>Költségkalkuláció</h2></div>
          <p class="muted">Az Ajánlatkészítő belső fedezetszámítása ezekből számolja ki, hány raktáros kell egy ajánlathoz, mekkora területet foglal az ügyfél áruja, és mennyi raktárbérleti díj esik rá. Új ajánlat ezekkel az értékekkel indul, a meglévő ajánlatok a saját értékeiket tartják meg.</p>
          <fieldset class="form" ${disabledIf(!can('edit'))}>
            <legend class="visually-hidden">Költségkalkuláció</legend>
            <p class="set-sub">Raktár</p>
            <div class="form-grid">
              ${numField('rent', 'Havi raktárbérleti díj (Ft, nettó)', cost.rent, { step: 1000 })}
              ${numField('area_m2', 'Bérelt alapterület (m²)', cost.area_m2, { step: 1 })}
            </div>
            <p class="small" data-cost-rentm2></p>
            <div class="table-wrap"><table class="table table--cards cost-sizes">
              <caption class="visually-hidden">Állványok méretenként</caption>
              <thead><tr><th scope="col">Méret</th><th scope="col">Állvány + folyosó (m²)</th><th scope="col">Szintek</th><th scope="col">Hely / szint</th>
                <th class="r" scope="col">m² / hely</th><th class="r" scope="col">Ennyi férne el</th><th class="r" scope="col">Bérleti díj / hely / hó</th></tr></thead>
              <tbody>${cost.sizes.map((z) => {
                const rk = (cost.racks || {})[z.code] || {};
                const input = (key, label, step) => html`<td data-label="${label}"><div class="field"><label class="visually-hidden" for="cost-${key}-${z.id}">${z.name}: ${label}</label>
                  <input class="input input--num" id="cost-${key}-${z.id}" name="racks.${z.code}.${key}" type="number" min="0" step="${step}" inputmode="decimal" value="${rk[key] ?? 0}" aria-describedby="cost-${key}-${z.id}-err">
                  <p class="field__error" id="cost-${key}-${z.id}-err" hidden></p></div></td>`;
                return html`<tr data-size="${z.code}">
                  <td><span class="tag">${z.code}</span> ${z.name}</td>
                  ${input('area', 'Állvány + folyosó (m²)', 0.1)}${input('levels', 'Szintek', 1)}${input('per_level', 'Hely / szint', 1)}
                  <td class="r num" data-label="m² / hely" data-m2></td><td class="r num" data-label="Ennyi férne el" data-fits></td><td class="r num" data-label="Bérleti díj / hely / hó" data-rent></td></tr>`;
              })}</tbody>
            </table></div>
            <p class="field__hint">Egy állványrekesz alapterülete a folyosó rá eső részével együtt (pl. 1 × 0,5 m-es polc és 0,6 m² folyosó: 1,1 m²), a polcszintek száma, és hány ilyen méretű hely van egy szinten. Egy hely helyigénye: alapterület / (szintek × hely szintenként). Az „Ennyi férne el” azt mutatja, hány ilyen hely férne el, ha a teljes alapterületen ilyen állványok állnának.</p>
            <p class="set-sub">Munkaerő</p>
            <div class="form-grid">
              ${numField('worker_cost', 'Egy raktáros havi költsége (Ft)', cost.worker_cost, { step: 1000, hint: 'Bér és járulékok együtt.' })}
              ${numField('worker_hours', 'Hasznos munkaóra / fő / hó', cost.worker_hours, { step: 1, hint: 'Szabadság, szünet nélkül.' })}
              ${numField('min_order', 'Rendelés kiszedése, csomagolása (perc)', cost.min_order, { step: 0.1 })}
              ${numField('min_item', 'További termék a rendelésben (perc)', cost.min_item, { step: 0.1 })}
              ${numField('min_inbound', 'Betárolás (perc / db)', cost.min_inbound, { step: 0.1 })}
              ${numField('min_return', 'Visszáru (perc / csomag)', cost.min_return, { step: 0.5 })}
            </div>
            <p class="set-sub">Anyag</p>
            <div class="form-grid">
              ${numField('pack_cost', 'Csomagolóanyag beszerzés / rendelés (Ft)', cost.pack_cost, { step: 10 })}
            </div>
          </fieldset>
          ${can('edit') ? html`<div class="form-actions"><button class="btn btn--primary" type="submit">Mentés</button></div>` : ''}
        </form>`,
    });
    const costForm = root.querySelector('#costing-form');
    // Rent of one m² and, per size, how many locations would fit and the rent of one of them.
    const preview = () => {
      const v = (name) => Math.max(Number(String((costForm.elements[name] || {}).value || '').replace(',', '.')) || 0, 0);
      const area = v('area_m2');
      const perM2 = area > 0 ? v('rent') / area : 0;
      costForm.querySelector('[data-cost-rentm2]').textContent = perM2 > 0 ? `Bérleti díj: ${fmt.num(perM2)} Ft / m² / hó.` : 'Add meg a bérleti díjat és az alapterületet.';
      for (const row of costForm.querySelectorAll('[data-size]')) {
        const code = row.dataset.size;
        const places = v(`racks.${code}.levels`) * v(`racks.${code}.per_level`);
        const m2 = places > 0 ? v(`racks.${code}.area`) / places : 0;
        row.querySelector('[data-m2]').textContent = m2 > 0 ? `${fmt.num(m2, 3)} m²` : '';
        row.querySelector('[data-fits]').textContent = m2 > 0 && area > 0 ? `${fmt.int(Math.floor(area / m2))} db` : '';
        row.querySelector('[data-rent]').textContent = m2 > 0 && perM2 > 0 ? money(m2 * perM2) : '';
      }
    };
    costForm.addEventListener('input', preview);
    preview();
    bindForm(costForm, async (values) => {
      // racks.<code>.<field> into { racks: { code: { field } } }
      const body = { racks: {} };
      for (const [k, val] of Object.entries(values)) {
        const m = k.match(/^racks\.(.+)\.(area|levels|per_level)$/);
        if (m) (body.racks[m[1]] ||= {})[m[2]] = val; else body[k] = val;
      }
      await api.put('/api/settings/costing', body);
      ui.toast('Költségkalkuláció mentve. Az új ajánlatok ezekkel az értékekkel indulnak.', 'ok');
    });
    const form = root.querySelector('#warehouse-form');
    bindForm(form, async (values) => {
      const workdays = [...form.querySelectorAll('input[name="wd"]:checked')].map((el) => Number(el.value));
      const { wd, ...rest } = values;
      const saved = await api.put('/api/settings/warehouse', { ...rest, workdays });
      if (FL.state.me) Object.assign(FL.state.me.warehouse, { cutoff: saved.cutoff, open: saved.open, close: saved.close });
      ui.toast('Raktár beállítások mentve. A visszaszámláló fél percen belül frissül.', 'ok');
    });
  }

  // ================================================================ Raktárhelyek
  const LOC_FILTERS = ['q', 'zone', 'size_id', 'kind', 'occupied', 'partner_id', 'active'];
  const PAGE = 100;

  async function locationsTab(root, ctx) {
    const state = {
      filters: Object.fromEntries(LOC_FILTERS.map((k) => [k, ctx.query.get(k) || ''])),
      offset: Math.max(parseInt(ctx.query.get('offset') || '0', 10) || 0, 0),
      sizes: [],
      clients: [],
      list: { items: [], total: 0, summary: {}, zones: [] },
    };
    const sel = ui.selection(() => state.list.items, () => paintSelection());
    state.clients = await clientOptions();

    const actions = html`
      ${can('create') ? html`<button class="btn" type="button" data-action="import">${FL.icon('upload-simple')}Importálás</button>` : ''}
      <button class="btn" type="button" data-action="export">${FL.icon('download-simple')}Exportálás</button>
      ${can('create') ? html`<button class="btn" type="button" data-action="bulk-new">${FL.icon('squares-four')}Tömeges létrehozás</button>` : ''}
      ${can('create') ? html`<button class="btn btn--primary" type="button" data-action="new-loc">${FL.icon('plus')}Új raktárhely</button>` : ''}`;
    frame(root, 'raktarhelyek', {
      lead: 'Minden raktárhelynek egy mérete van; a méret havi díját ügyfelenként a partner Tarifák fülén adod meg. Egy helyen mindig csak egy partner áruja lehet.',
      actions,
      body: html`
        <div class="slot loc-kpis" data-kpis></div>
        <section class="panel panel--flush" aria-labelledby="sizes-title">
          <div class="panel__head">
            <div><h2 id="sizes-title">Méretek</h2><p class="small muted">A lista bővíthető, például XXL vagy Fél raklap. Használt méret nem törölhető, csak inaktiválható.</p></div>
            ${can('create') ? html`<button class="btn btn--sm" type="button" data-action="new-size">${FL.icon('plus')}Új méret</button>` : ''}
          </div>
          <div class="slot" data-sizes></div>
        </section>
        <section class="panel panel--flush" aria-labelledby="locs-title">
          <div class="panel__head"><h2 id="locs-title">Raktárhelyek</h2><span class="small muted" data-count></span></div>
          <form class="toolbar loc-filters" data-filters novalidate></form>
          <div class="slot" data-bulk></div>
          <div class="slot" data-locs></div>
        </section>`,
    });
    const $ = (s) => root.querySelector(s);
    $('[data-filters]').addEventListener('submit', (e) => e.preventDefault());

    // ---------------------------------------------------------------- sizes
    const dims = (s) => {
      const d = [s.width_cm, s.depth_cm, s.height_cm];
      return d.some((x) => x != null) ? `${d.map((x) => (x == null ? '?' : fmt.num(x, 1))).join(' × ')} cm` : '';
    };
    function paintSizes() {
      $('[data-sizes]').innerHTML = String(ui.table({
        caption: 'Raktárhely méretek',
        empty: 'Még nincs méret. Vegyél fel legalább egyet a raktárhelyek előtt.',
        rows: state.sizes,
        columns: [
          { key: 'code', label: 'Kód', render: (s) => html`<span class="tag">${s.code}</span>` },
          { key: 'name', label: 'Megnevezés', render: (s) => html`<b>${s.name}</b>` },
          { key: 'dims', label: 'Szél. × mély. × mag.', render: dims },
          { key: 'max_kg', label: 'Teherbírás', align: 'r', cls: 'num', render: (s) => (s.max_kg != null ? fmt.kg(s.max_kg) : '') },
          { key: 'locations', label: 'Raktárhelyek', align: 'r', cls: 'num', render: (s) => html`<a href="${BASE}/raktarhelyek?size_id=${s.id}" data-action="filter-size" data-id="${s.id}">${fmt.int(s.location_count)}</a><span class="sub">${fmt.int(s.occupied_count)} foglalt</span>` },
          { key: 'sort', label: 'Sorrend', align: 'r', cls: 'num' },
          { key: 'active', label: 'Állapot', render: (s) => FL.status('partner', s.active ? 'active' : 'inactive') },
          {
            key: 'act', label: 'Műveletek', cls: 'w-actions', render: (s) => html`<span class="row-actions">
              <button class="btn btn--sm btn--ghost btn--icon" type="button" data-action="edit-size" data-id="${s.id}" aria-label="${s.code} szerkesztése" title="Szerkesztés" ${ui.denyAttr('settings', 'edit')}>${FL.icon('pencil-simple')}</button>
              <button class="btn btn--sm btn--ghost btn--icon" type="button" data-action="delete-size" data-id="${s.id}" aria-label="${s.code} törlése" title="${s.location_count ? 'Használt méret: csak inaktiválható' : 'Törlés'}" ${can('delete') && !s.location_count ? '' : raw('disabled')}>${FL.icon('trash')}</button>
            </span>`,
          },
        ],
      }));
    }

    function sizeDialog(size) {
      const v = size || { active: 1 };
      ui.dialog({
        title: size ? `Méret: ${size.code}` : 'Új raktárhely méret',
        body: html`
          ${size && size.location_count ? ui.notice(`${fmt.int(size.location_count)} raktárhely használja ezt a méretet. A kód módosítása után a partnerek tárolási díjai megmaradnak.`, 'info') : ''}
          <div class="form-grid">
            ${ui.field({ name: 'code', label: 'Kód', type: 'code', value: v.code, required: true, hint: 'Rövid, ékezet nélkül, pl. XXL.' })}
            ${ui.field({ name: 'name', label: 'Megnevezés', value: v.name, required: true, placeholder: 'Polchely XXL' })}
            ${ui.field({ name: 'width_cm', label: 'Szélesség (cm)', type: 'number', value: v.width_cm, optional: true, min: 0 })}
            ${ui.field({ name: 'depth_cm', label: 'Mélység (cm)', type: 'number', value: v.depth_cm, optional: true, min: 0 })}
            ${ui.field({ name: 'height_cm', label: 'Magasság (cm)', type: 'number', value: v.height_cm, optional: true, min: 0 })}
            ${ui.field({ name: 'max_kg', label: 'Teherbírás (kg)', type: 'number', value: v.max_kg, optional: true, min: 0 })}
            ${ui.field({ name: 'sort', label: 'Sorrend', type: 'number', int: true, value: v.sort, optional: true, hint: 'Ebben a sorrendben jelenik meg a listákban.' })}
            ${ui.field({ name: 'active', label: 'Aktív, új raktárhelyhez választható', type: 'checkbox', value: !!v.active, span: 'all' })}
          </div>`,
        onSubmit: async (form) => {
          const values = ui.formValues(form);
          if (values.sort == null) delete values.sort;
          const res = size ? await api.patch(`/api/settings/sizes/${size.id}`, values) : await api.post('/api/settings/sizes', values);
          ui.toast(size ? 'Méret mentve.' : `${res.code} méret létrehozva.`, 'ok');
          if (res.warning) ui.toast(res.warning, 'info');
          await refreshMeta();
          await loadSizes();
          await loadLocations();
        },
      });
    }

    async function loadSizes() {
      state.sizes = (await api.get('/api/settings/sizes')).items;
      paintSizes();
      paintFilters();
    }

    // Keeps the shared size list (meta) in step, other screens read it.
    async function refreshMeta() {
      try { FL.state.meta = await api.get('/api/meta'); } catch { /* next load refreshes it */ }
    }

    // ---------------------------------------------------------------- filters
    function paintFilters() {
      const f = state.filters;
      const zones = state.list.zones || [];
      $('[data-filters]').innerHTML = String(html`
        <div class="field field--grow"><label for="loc-q">Keresés</label><input class="input" id="loc-q" name="q" type="search" value="${f.q}" placeholder="Kód vagy megjegyzés" autocomplete="off"></div>
        ${ui.field({ name: 'zone', label: 'Zóna', type: 'select', value: f.zone, placeholder: 'Mind', options: [...zones.map((z) => ({ value: z, label: z })), { value: '-', label: 'Zóna nélkül' }], attrs: 'data-action="filter"' })}
        ${ui.field({ name: 'size_id', label: 'Méret', type: 'select', value: f.size_id, placeholder: 'Mind', options: state.sizes.map((s) => ({ value: s.id, label: `${s.code} ${s.name}` })), attrs: 'data-action="filter"' })}
        ${ui.field({ name: 'kind', label: 'Típus', type: 'select', value: f.kind, placeholder: 'Mind', options: Object.entries(meta().locationKinds || {}).map(([value, label]) => ({ value, label })), attrs: 'data-action="filter"' })}
        ${ui.field({ name: 'occupied', label: 'Foglaltság', type: 'select', value: f.occupied, placeholder: 'Mind', options: [{ value: '1', label: 'Foglalt' }, { value: '0', label: 'Üres' }], attrs: 'data-action="filter"' })}
        ${ui.field({ name: 'partner_id', label: 'Partner', type: 'select', value: f.partner_id, placeholder: 'Mind', options: state.clients, attrs: 'data-action="filter"' })}
        ${ui.field({ name: 'active', label: 'Állapot', type: 'select', value: f.active, placeholder: 'Mind', options: [{ value: '1', label: 'Aktív' }, { value: '0', label: 'Inaktív' }], attrs: 'data-action="filter"' })}
        ${Object.values(f).some(Boolean) ? html`<button class="btn btn--ghost" type="button" data-action="clear-filters">${FL.icon('x')}Szűrők törlése</button>` : ''}`);
      const q = $('#loc-q');
      q.addEventListener('input', FL.debounce(() => { state.filters.q = q.value.trim(); state.offset = 0; sel.set.clear(); loadLocations(); }, 300));
    }

    function syncUrl() {
      const query = { ...state.filters, offset: state.offset || '' };
      history.replaceState(null, '', `${BASE}/raktarhelyek${FL.qs(query)}`);
    }

    // ---------------------------------------------------------------- list
    const locColumns = [
      { key: 'code', label: 'Kód', render: (l) => html`<button class="link-btn mono" type="button" data-action="edit-loc" data-id="${l.id}">${l.code}</button>` },
      { key: 'zone', label: 'Zóna', render: (l) => l.zone },
      { key: 'size', label: 'Méret', render: (l) => html`<span class="tag" title="${l.size_name}">${l.size_code}</span>` },
      { key: 'kind', label: 'Típus', render: (l) => kindLabel(l.kind) },
      { key: 'occ', label: 'Foglalja', cls: 'loc-partner', render: (l) => (l.occupant_id ? html`${l.occupant_name}<span class="sub">${fmt.int(l.qty)} db, ${fmt.int(l.products)} cikk</span>` : html`<span class="muted">üres</span>`) },
      { key: 'fixed', label: 'Fix partner', cls: 'loc-partner', render: (l) => l.partner_name || '' },
      { key: 'seq', label: 'Sorrend', align: 'r', cls: 'num', render: (l) => (l.pick_sequence ? l.pick_sequence : '') },
      { key: 'note', label: 'Megjegyzés', cls: 'loc-note', render: (l) => l.note },
      { key: 'active', label: 'Állapot', render: (l) => FL.status('partner', l.active ? 'active' : 'inactive') },
    ];

    async function loadLocations() {
      syncUrl();
      const box = $('[data-locs]');
      box.setAttribute('aria-busy', 'true');
      try {
        state.list = await api.get('/api/settings/locations', { ...state.filters, limit: PAGE, offset: state.offset });
      } finally {
        box.removeAttribute('aria-busy');
      }
      if (state.offset && !state.list.items.length && state.list.total) { state.offset = 0; return loadLocations(); }
      paintKpis();
      paintLocations();
      paintSelection();
      // Zone options come from the data: repaint the filter bar only when they changed.
      const zoneSel = $('[data-filters] select[name="zone"]');
      const shown = zoneSel ? [...zoneSel.options].map((o) => o.value).filter((v) => v && v !== '-').join(',') : null;
      if (shown !== (state.list.zones || []).join(',')) paintFilters();
      return undefined;
    }

    function paintKpis() {
      const s = state.list.summary || {};
      $('[data-kpis]').innerHTML = String(ui.kpis([
        { label: 'Raktárhely összesen', value: fmt.int(s.total) },
        { label: 'Foglalt', value: fmt.int(s.occupied), hint: s.total ? `${fmt.pct((s.occupied / s.total) * 100, 0)} kihasználtság` : '' },
        { label: 'Üres aktív tárolóhely', value: fmt.int(s.empty_storage), tone: s.total && !s.empty_storage ? 'warn' : '' },
        { label: 'Inaktív', value: fmt.int((s.total || 0) - (s.active || 0)) },
      ]));
    }

    function paintLocations() {
      const { items, total } = state.list;
      $('[data-count]').textContent = `${fmt.int(total)} találat`;
      $('[data-locs]').innerHTML = String(html`
        ${ui.table({
          caption: 'Raktárhelyek',
          rows: items,
          columns: locColumns,
          selectable: can('edit') || can('delete'),
          selected: sel.set,
          empty: Object.values(state.filters).some(Boolean) ? 'Nincs a szűrésnek megfelelő raktárhely.' : 'Még nincs raktárhely. Hozd létre őket egyenként vagy tömegesen.',
          cls: 'loc-table',
        })}
        ${total ? ui.pager({ total, limit: PAGE, offset: state.offset }) : ''}`);
    }

    function paintSelection() {
      const n = sel.set.size;
      const box = $('[data-bulk]');
      if (!(can('edit') || can('delete'))) { box.innerHTML = ''; return; }
      if (!n) {
        box.innerHTML = String(html`<p class="bulkbar bulkbar--hint small muted">${FL.icon('check-square')}Jelölj ki raktárhelyeket, és egyszerre módosíthatod a méretüket, a típusukat vagy a fix partnert.</p>`);
      } else {
        const total = state.list.total;
        box.innerHTML = String(html`<div class="bulkbar" role="region" aria-label="Kijelölt raktárhelyek műveletei">
          <b>${fmt.int(n)} kijelölve</b>
          ${total > n ? html`<button class="link-btn" type="button" data-action="select-matching">Mind a ${fmt.int(total)} találat kijelölése</button>` : ''}
          <button class="link-btn" type="button" data-action="clear-selection">Kijelölés megszüntetése</button>
          <span class="bulkbar__spacer"></span>
          ${can('edit') ? html`<button class="btn btn--sm btn--dark" type="button" data-action="bulk-size">${FL.icon('ruler')}Méret módosítása</button>
            <button class="btn btn--sm" type="button" data-action="bulk-edit">${FL.icon('pencil-simple')}Egyéb módosítás</button>
            <button class="btn btn--sm" type="button" data-action="bulk-activate">Aktiválás</button>` : ''}
          ${can('delete') ? html`<button class="btn btn--sm" type="button" data-action="bulk-deactivate">Inaktiválás</button>
            <button class="btn btn--sm btn--danger" type="button" data-action="bulk-delete">${FL.icon('trash')}Törlés</button>` : ''}
        </div>`);
      }
      root.querySelectorAll('.loc-table tbody tr').forEach((tr) => {
        const cb = tr.querySelector('[data-action="select-row"]');
        if (!cb) return;
        const on = sel.set.has(Number(cb.dataset.id));
        cb.checked = on;
        if (on) tr.dataset.selected = 'true'; else tr.removeAttribute('data-selected');
      });
      const all = root.querySelector('.loc-table [data-action="select-all"]');
      if (all) {
        const rows = state.list.items;
        const k = rows.filter((r) => sel.set.has(r.id)).length;
        all.checked = rows.length > 0 && k === rows.length;
        all.indeterminate = k > 0 && k < rows.length;
      }
    }

    // Lists codes the server skipped, with the reason.
    function showSkipped(title, skipped) {
      if (!skipped || !skipped.length) return;
      ui.dialog({
        title,
        hideSubmit: true,
        cancelLabel: 'Bezárás',
        body: html`${ui.notice(`${fmt.int(skipped.length)} raktárhely kimaradt.`, 'warn')}
          ${ui.table({ rows: skipped.map((s, i) => ({ id: i, ...s })), columns: [{ key: 'code', label: 'Kód', cls: 'mono' }, { key: 'reason', label: 'Ok' }] })}`,
      });
    }

    const activeSizes = (keepId) => state.sizes.filter((s) => s.active || s.id === keepId).map((s) => ({ value: s.id, label: `${s.code} ${s.name}${s.active ? '' : ' (inaktív)'}` }));
    const kindOptions = () => Object.entries(meta().locationKinds || {}).map(([value, label]) => ({ value, label }));

    // ---------------------------------------------------------------- one location
    async function locationDialog(id) {
      const loc = id ? await api.get(`/api/settings/locations/${id}`) : null;
      const v = loc || { kind: 'storage', active: 1, pick_sequence: 0 };
      const occupied = loc && loc.occupant_id;
      const mayDeactivate = !loc || (can('delete') && !occupied) || !v.active;
      const readOnly = !!loc && !can('edit');
      const dlg = ui.dialog({
        title: loc ? `Raktárhely: ${loc.code}` : 'Új raktárhely',
        hideSubmit: readOnly,
        cancelLabel: readOnly ? 'Bezárás' : 'Mégse',
        body: html`
          ${loc ? (occupied
            ? ui.notice(html`Most <b>${loc.occupant_name}</b> áruja van rajta: ${fmt.int(loc.qty)} db, ${fmt.int(loc.products)} cikk.`, 'info')
            : ui.notice('A raktárhely most üres.', 'ok', 'check-circle')) : ''}
          ${!state.sizes.some((s) => s.active) ? ui.notice('Nincs aktív méret. Előbb vegyél fel egyet a Méretek résznél.', 'warn') : ''}
          <div class="form-grid">
            ${ui.field({ name: 'code', label: 'Kód', type: 'code', value: v.code, required: true, placeholder: 'A-01-03', hint: 'Ez kerül a polccímkére és a vonalkódra.' })}
            ${ui.field({ name: 'zone', label: 'Zóna', type: 'code', value: v.zone, optional: true, hint: 'Üresen hagyva a kód elejéből.' })}
            ${ui.field({ name: 'size_id', label: 'Méret', type: 'select', value: v.size_id, required: true, options: activeSizes(v.size_id), placeholder: loc ? undefined : 'Válassz méretet' })}
            ${ui.field({ name: 'kind', label: 'Típus', type: 'select', value: v.kind, options: kindOptions() })}
            ${ui.field({ name: 'partner_id', label: 'Fix partner', type: 'select', value: v.partner_id, options: state.clients, placeholder: 'Nincs, bármelyik ügyfélé lehet', optional: true })}
            ${ui.field({ name: 'pick_sequence', label: 'Komissiós sorrend', type: 'number', int: true, min: 0, value: v.pick_sequence, hint: 'A kiszedési útvonal sorrendje; 0 esetén kód szerint.' })}
            ${ui.field({ name: 'note', label: 'Megjegyzés', value: v.note, optional: true, span: 'all' })}
            ${loc ? ui.field({ name: 'active', label: 'Aktív', type: 'checkbox', value: !!v.active, span: 'all', attrs: mayDeactivate ? '' : 'disabled', hint: occupied && v.active ? 'Csak üres raktárhely inaktiválható.' : (!can('delete') && v.active ? 'Az inaktiváláshoz Beállítások törlése jog kell.' : '') }) : ''}
          </div>
          <div data-size-warn></div>
          ${loc && loc.stock.length ? html`<details class="loc-stock"><summary>Készlet a helyen (${fmt.int(loc.stock.length)} sor)</summary>
            ${ui.table({ rows: loc.stock.map((s, i) => ({ id: i, ...s })), columns: [
              { key: 'sku', label: 'Cikkszám', cls: 'mono' }, { key: 'name', label: 'Megnevezés' },
              { key: 'lot', label: 'Tétel' }, { key: 'expiry', label: 'Lejárat', render: (s) => fmt.date(s.expiry) },
              { key: 'qty', label: 'Mennyiség', align: 'r', cls: 'num', render: (s) => fmt.int(s.qty) }] })}</details>` : ''}
          ${loc && can('delete') ? html`<div class="danger-zone">
            ${loc.deletable && !occupied
              ? html`<button class="btn btn--sm btn--danger" type="button" data-delete-loc>${FL.icon('trash')}Raktárhely törlése</button><span class="small muted">Még nem volt rajta forgalom, ezért törölhető.</span>`
              : html`<span class="small muted">${FL.icon('info')}Ezen a helyen már volt forgalom, ezért nem törölhető, csak inaktiválható.</span>`}
          </div>` : ''}`,
        submitLabel: loc ? 'Mentés' : 'Létrehozás',
        onOpen: ({ form, close }) => {
          if (readOnly) form.querySelectorAll('.form-grid input, .form-grid select, .form-grid textarea').forEach((el) => { el.disabled = true; });
          const sizeSel = form.elements.size_id;
          const warn = form.querySelector('[data-size-warn]');
          if (occupied && sizeSel) {
            sizeSel.addEventListener('change', () => {
              warn.innerHTML = String(Number(sizeSel.value) !== v.size_id
                ? ui.notice('A raktárhelyen készlet van. A méret módosítható, de a tárolási díj a mai naptól az új méret szerint számolódik.', 'warn')
                : '');
            });
          }
          const del = form.querySelector('[data-delete-loc]');
          if (del) {
            del.addEventListener('click', async () => {
              if (!(await ui.confirm({ title: 'Raktárhely törlése', text: `Biztosan törlöd a(z) ${loc.code} raktárhelyet?`, confirmLabel: 'Törlés', tone: 'danger' }))) return;
              await ui.run(del, async () => {
                await api.del(`/api/settings/locations/${loc.id}`);
                ui.toast(`${loc.code} törölve.`, 'ok');
                close(true);
                await Promise.all([loadSizes(), loadLocations()]);
              });
            });
          }
        },
        onSubmit: async (form) => {
          const values = ui.formValues(form);
          if (values.partner_id === '') values.partner_id = null;
          else values.partner_id = Number(values.partner_id);
          values.size_id = values.size_id ? Number(values.size_id) : null;
          if (values.pick_sequence == null) values.pick_sequence = 0;
          if (loc && occupied && values.size_id !== v.size_id) {
            const ok = await ui.confirm({ title: 'Foglalt raktárhely mérete', text: `A(z) ${loc.code} helyen ${loc.occupant_name} áruja van. A tárolási díj a mai naptól az új méret szerint számolódik. Módosítod?`, confirmLabel: 'Módosítás' });
            if (!ok) return false;
          }
          const res = loc ? await api.patch(`/api/settings/locations/${loc.id}`, values) : await api.post('/api/settings/locations', values);
          ui.toast(loc ? `${res.code} mentve.` : `${res.code} létrehozva.`, 'ok');
          if (res.warning) ui.toast(res.warning, 'info');
          await Promise.all([loadSizes(), loadLocations()]);
          return true;
        },
      });
      return dlg;
    }

    // ---------------------------------------------------------------- bulk create from a pattern
    function bulkCreateDialog() {
      let lastCount = 0;
      const pads = [1, 2, 3, 4].map((n) => ({ value: n, label: `${n} jegy (${'0'.repeat(n - 1)}1)` }));
      const seps = [{ value: '-', label: 'Kötőjel: A-01-01' }, { value: '.', label: 'Pont: A.01.01' }, { value: '/', label: 'Perjel: A/01/01' }, { value: '_', label: 'Aláhúzás: A_01_01' }, { value: '', label: 'Nincs: A0101' }];
      const dlg = ui.dialog({
        title: 'Raktárhelyek tömeges létrehozása',
        size: 'wide',
        submitLabel: 'Létrehozás',
        body: html`
          <p class="small muted">A kódok így épülnek fel: előtag, állvány, szint és ha kell, pozíció. A már létező kódok kimaradnak.</p>
          <div class="form-grid">
            ${ui.field({ name: 'prefixes', label: 'Zóna betűk vagy előtag', type: 'code', required: true, value: 'A', hint: 'Pl. A, vagy A,B,C, vagy A-D (betűtartomány).' })}
            ${ui.field({ name: 'separator', label: 'Elválasztó', type: 'select', value: '-', options: seps })}
            ${ui.field({ name: 'pad', label: 'Számjegyek', type: 'select', value: 2, options: pads })}
            ${ui.field({ name: 'rack_from', label: 'Állvány: első', type: 'number', int: true, min: 0, value: 1, required: true })}
            ${ui.field({ name: 'rack_to', label: 'Állvány: utolsó', type: 'number', int: true, min: 0, value: 10, required: true })}
            ${ui.field({ name: 'level_from', label: 'Szint: első', type: 'number', int: true, min: 0, value: 1, required: true })}
            ${ui.field({ name: 'level_to', label: 'Szint: utolsó', type: 'number', int: true, min: 0, value: 4, required: true })}
            ${ui.field({ name: 'pos_from', label: 'Pozíció: első', type: 'number', int: true, min: 0, optional: true })}
            ${ui.field({ name: 'pos_to', label: 'Pozíció: utolsó', type: 'number', int: true, min: 0, optional: true })}
            ${ui.field({ name: 'size_id', label: 'Méret', type: 'select', required: true, options: activeSizes(), placeholder: 'Válassz méretet' })}
            ${ui.field({ name: 'kind', label: 'Típus', type: 'select', value: 'storage', options: kindOptions() })}
            ${ui.field({ name: 'partner_id', label: 'Fix partner', type: 'select', options: state.clients, placeholder: 'Nincs', optional: true })}
            ${ui.field({ name: 'zone', label: 'Zóna', type: 'code', optional: true, hint: 'Üresen hagyva az előtag lesz a zóna.' })}
            ${ui.field({ name: 'pick_start', label: 'Komissiós sorrend kezdete', type: 'number', int: true, min: 0, optional: true, hint: 'Ha megadod, a helyek egyesével növekvő sorszámot kapnak.' })}
          </div>
          <div class="code-preview" data-preview aria-live="polite"></div>`,
        onOpen: ({ form }) => {
          const submit = form.querySelector('[type="submit"]');
          const box = form.querySelector('[data-preview]');
          let seq = 0;
          const preview = FL.debounce(async () => {
            const mine = ++seq;
            const body = payload(form);
            if (!body.size_id) { box.innerHTML = String(ui.notice('Válassz méretet az előnézethez.', 'info')); submit.disabled = true; return; }
            try {
              const r = await api.post('/api/settings/locations/bulk', { ...body, preview: true });
              if (mine !== seq) return;
              lastCount = r.create;
              const shown = r.codes.length > 40 ? [...r.codes.slice(0, 32), null, ...r.codes.slice(-4)] : r.codes;
              box.innerHTML = String(html`
                <p><b>${fmt.int(r.create)} új raktárhely</b>${r.existing.length ? html`, ${fmt.int(r.existing.length)} már létezik, kimarad` : ''}.</p>
                <ul class="code-list">${shown.map((c) => (c ? html`<li class="tag">${c}</li>` : html`<li class="muted" aria-label="további kódok">...</li>`))}</ul>
                ${r.existing.length ? html`<p class="small muted">Kimarad: ${r.existing.slice(0, 12).join(', ')}${r.existing.length > 12 ? ' és a többi' : ''}</p>` : ''}`);
              submit.disabled = !r.create;
              submit.textContent = r.create ? `Létrehozás (${fmt.int(r.create)} db)` : 'Létrehozás';
            } catch (err) {
              if (mine !== seq) return;
              lastCount = 0;
              submit.disabled = true;
              box.innerHTML = String(ui.notice(err.message, 'warn'));
            }
          }, 300);
          form.addEventListener('input', preview);
          form.addEventListener('change', preview);
          preview();
        },
        onSubmit: async (form) => {
          if (!lastCount) return false;
          const res = await api.post('/api/settings/locations/bulk', payload(form));
          ui.toast(`${fmt.int(res.created)} raktárhely létrehozva.`, 'ok');
          await Promise.all([loadSizes(), loadLocations()]);
          return true;
        },
      });
      function payload(form) {
        const v = ui.formValues(form);
        return {
          ...v,
          pad: Number(v.pad),
          size_id: v.size_id ? Number(v.size_id) : null,
          partner_id: v.partner_id ? Number(v.partner_id) : null,
        };
      }
      return dlg;
    }

    // ---------------------------------------------------------------- bulk change
    async function bulkUpdate(changes, button, label) {
      return ui.run(button, async () => {
        const res = await api.post('/api/settings/locations/bulk-update', { ids: [...sel.set], ...changes });
        ui.toast(`${fmt.int(res.updated)} raktárhely ${label}.${res.occupiedResized ? ` Ebből ${fmt.int(res.occupiedResized)} foglalt.` : ''}`, res.updated ? 'ok' : 'info');
        showSkipped('Kimaradt raktárhelyek', res.skipped);
        sel.set.clear();
        await Promise.all([loadSizes(), loadLocations()]);
      });
    }

    function bulkSizeDialog() {
      const n = sel.set.size;
      ui.dialog({
        title: 'Méret módosítása',
        size: 'narrow',
        submitLabel: `Módosítás (${fmt.int(n)} db)`,
        body: html`
          <p>A kijelölt <b>${fmt.int(n)} raktárhely</b> mérete erre változik:</p>
          ${ui.field({ name: 'size_id', label: 'Új méret', type: 'select', required: true, options: activeSizes(), placeholder: 'Válassz méretet' })}
          ${ui.notice('A foglalt helyeken a tárolási díj a mai naptól az új méret szerint számolódik.', 'info')}`,
        onSubmit: async (form) => {
          const { size_id: sizeId } = ui.formValues(form);
          if (!sizeId) throw new FL.ApiError(400, 'bad_request', 'Válassz méretet.', { size_id: 'Válassz méretet.' });
          const res = await api.post('/api/settings/locations/bulk-update', { ids: [...sel.set], size_id: Number(sizeId) });
          const size = state.sizes.find((s) => s.id === Number(sizeId));
          ui.toast(`${fmt.int(res.updated)} raktárhely mérete most ${size ? size.code : ''}.${res.occupiedResized ? ` Ebből ${fmt.int(res.occupiedResized)} foglalt.` : ''}`, 'ok');
          showSkipped('Kimaradt raktárhelyek', res.skipped);
          sel.set.clear();
          await Promise.all([loadSizes(), loadLocations()]);
        },
      });
    }

    function bulkEditDialog() {
      const n = sel.set.size;
      ui.dialog({
        title: 'Kijelöltek módosítása',
        submitLabel: `Módosítás (${fmt.int(n)} db)`,
        body: html`
          <p>A kijelölt <b>${fmt.int(n)} raktárhelyen</b> csak azt módosítjuk, amit itt megadsz.</p>
          <div class="form-grid">
            ${ui.field({ name: 'kind', label: 'Típus', type: 'select', options: kindOptions(), placeholder: 'Változatlan' })}
            ${ui.field({ name: 'partner_id', label: 'Fix partner', type: 'select', options: [{ value: 'none', label: 'Nincs fix partner' }, ...state.clients], placeholder: 'Változatlan', hint: 'Másik partner áruját tartalmazó helyek kimaradnak.' })}
            ${ui.field({ name: 'zone', label: 'Zóna', type: 'code', placeholder: 'Változatlan' })}
            ${ui.field({ name: 'pick_sequence', label: 'Komissiós sorrend', type: 'number', int: true, min: 0, placeholder: 'Változatlan' })}
          </div>`,
        onSubmit: async (form) => {
          const v = ui.formValues(form);
          const changes = {};
          if (v.kind) changes.kind = v.kind;
          if (v.partner_id) changes.partner_id = v.partner_id === 'none' ? null : Number(v.partner_id);
          if (v.zone) changes.zone = v.zone;
          if (v.pick_sequence != null) changes.pick_sequence = v.pick_sequence;
          if (!Object.keys(changes).length) throw new FL.ApiError(400, 'bad_request', 'Adj meg legalább egy módosítást.');
          const res = await api.post('/api/settings/locations/bulk-update', { ids: [...sel.set], ...changes });
          ui.toast(`${fmt.int(res.updated)} raktárhely módosítva.`, 'ok');
          showSkipped('Kimaradt raktárhelyek', res.skipped);
          sel.set.clear();
          await loadLocations();
        },
      });
    }

    // ---------------------------------------------------------------- actions
    ui.bind(root, {
      ...sel.handlers,
      'new-size': () => sizeDialog(null),
      'edit-size': (el) => sizeDialog(state.sizes.find((s) => s.id === Number(el.dataset.id))),
      'delete-size': async (el) => {
        const s = state.sizes.find((x) => x.id === Number(el.dataset.id));
        if (!(await ui.confirm({ title: 'Méret törlése', text: `Biztosan törlöd a(z) ${s.code} (${s.name}) méretet? A partnereknél megadott díjai is törlődnek.`, confirmLabel: 'Törlés', tone: 'danger' }))) return;
        await ui.run(el, async () => {
          await api.del(`/api/settings/sizes/${s.id}`);
          ui.toast(`${s.code} méret törölve.`, 'ok');
          await refreshMeta();
          await loadSizes();
        });
      },
      'filter-size': (el, e) => {
        e.preventDefault();
        state.filters = { ...Object.fromEntries(LOC_FILTERS.map((k) => [k, ''])), size_id: el.dataset.id };
        state.offset = 0;
        sel.set.clear();
        paintFilters();
        loadLocations();
        $('#locs-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
      filter: (el) => {
        state.filters[el.name] = el.value;
        state.offset = 0;
        sel.set.clear();
        loadLocations();
      },
      'clear-filters': () => {
        state.filters = Object.fromEntries(LOC_FILTERS.map((k) => [k, '']));
        state.offset = 0;
        sel.set.clear();
        paintFilters();
        loadLocations();
      },
      page: (el) => { state.offset = Number(el.dataset.offset) || 0; loadLocations(); $('#locs-title').scrollIntoView({ block: 'start' }); },
      'new-loc': () => locationDialog(null),
      'edit-loc': (el) => locationDialog(Number(el.dataset.id)),
      'bulk-new': () => bulkCreateDialog(),
      'select-matching': (el) => ui.run(el, async () => {
        const { ids } = await api.get('/api/settings/locations', { ...state.filters, ids_only: 1 });
        ids.forEach((id) => sel.set.add(id));
        paintSelection();
      }),
      'clear-selection': () => { sel.set.clear(); paintSelection(); },
      'bulk-size': () => bulkSizeDialog(),
      'bulk-edit': () => bulkEditDialog(),
      'bulk-activate': (el) => bulkUpdate({ active: true }, el, 'aktiválva'),
      'bulk-deactivate': async (el) => {
        if (!(await ui.confirm({ title: 'Inaktiválás', text: `A kijelölt ${fmt.int(sel.set.size)} raktárhelyből az üreseket inaktiváljuk: ezekre nem lehet árut tenni, és nem jelennek meg a választólistákban.`, confirmLabel: 'Inaktiválás' }))) return;
        await bulkUpdate({ active: false }, el, 'inaktiválva');
      },
      'bulk-delete': async (el) => {
        if (!(await ui.confirm({ title: 'Raktárhelyek törlése', text: `A kijelölt ${fmt.int(sel.set.size)} raktárhelyből azokat töröljük, amelyeken még nem volt forgalom. A többit inaktiválhatod.`, confirmLabel: 'Törlés', tone: 'danger' }))) return;
        await ui.run(el, async () => {
          const res = await api.post('/api/settings/locations/bulk-delete', { ids: [...sel.set] });
          ui.toast(`${fmt.int(res.deleted)} raktárhely törölve.`, res.deleted ? 'ok' : 'info');
          showSkipped('Nem törölhető raktárhelyek', res.skipped);
          sel.set.clear();
          await Promise.all([loadSizes(), loadLocations()]);
        });
      },
      import: async () => {
        const res = await ui.csvImport({
          title: 'Raktárhelyek importálása',
          endpoint: '/api/settings/locations/import',
          help: 'Új kódnál létrehozzuk a raktárhelyet, meglévőnél a kitöltött oszlopok szerint módosítjuk (például a méretet). A Méret oszlopba a méret kódja kerüljön (M, L, XL, PAL), a Fix partner oszlopba az ügyfél kódja. Tipp: exportáld a listát, javítsd Excelben, és töltsd vissza.',
          templateName: 'raktarhelyek.csv',
          templateColumns: ['Kód', 'Zóna', 'Méret', 'Típus', 'Fix partner', 'Komissiós sorrend', 'Aktív', 'Megjegyzés'],
        });
        if (res) await Promise.all([loadSizes(), loadLocations()]);
      },
      export: (el) => ui.run(el, () => api.download('/api/settings/locations/export', state.filters)),
    });

    await loadSizes();
    await loadLocations();
  }

  // ================================================================ Alap tarifák
  const TARIFF_GROUPS = { handling: 'Rendeléskezelés', inbound: 'Betárolás és visszáru', extra: 'Egyéb szolgáltatások', discount: 'Kedvezmények', vat: 'Adó' };

  async function tariffsTab(root) {
    const t = await api.get('/api/settings/tariffs');
    const ro = !can('edit');
    const input = (name, value, label, pct) => html`<div class="field"><input class="input input--num" type="number" step="any" min="0" ${pct ? raw('max="100"') : ''} name="${name}" value="${value ?? 0}" data-type="num" aria-label="${label}" ${disabledIf(ro)}><p class="field__error" hidden></p></div>`;
    const groups = FL.groupBy(t.tariffs, (x) => x.group);
    const sizes = t.sizes.filter((s) => s.active);
    frame(root, 'alaptarifak', {
      lead: 'Az új ügyfél partnerek és az új ajánlatok ezekkel az árakkal indulnak. A meglévő partnerek tarifái nem változnak.',
      body: html`
        ${readOnlyNotice()}
        <form class="tariffs" id="tariff-form" novalidate>
          <div class="grid-2">
            <section class="panel panel--flush" aria-labelledby="tf-flat">
              <div class="panel__head"><h2 id="tf-flat">Díjtételek</h2></div>
              <div class="table-wrap"><table class="table tariff-table">
                <thead><tr><th scope="col">Tétel</th><th scope="col" class="r">Díj</th><th scope="col">Egység</th></tr></thead>
                <tbody>${Object.entries(groups).map(([g, items]) => html`
                  <tr class="group"><td colspan="3">${TARIFF_GROUPS[g] || g}</td></tr>
                  ${items.map((x) => html`<tr><td>${x.label}</td><td class="r">${input(`values.${x.key}`, t.values[x.key], x.label, x.key.endsWith('_pct'))}</td><td class="muted small">${x.unit}</td></tr>`)}`)}
                </tbody></table></div>
            </section>
            <div class="stack">
              <section class="panel panel--flush" aria-labelledby="tf-storage">
                <div class="panel__head"><div><h2 id="tf-storage">Tárolás</h2><p class="small muted">Havi díj egy raktárhelyre, méretenként. Napi arányosan számlázzuk.</p></div></div>
                ${sizes.length ? html`<div class="table-wrap"><table class="table tariff-table">
                  <thead><tr><th scope="col">Méret</th><th scope="col" class="r">Díj</th><th scope="col">Egység</th></tr></thead>
                  <tbody>${sizes.map((s) => html`<tr><td><span class="tag">${s.code}</span> ${s.name}</td><td class="r">${input(`storage.${s.code}`, t.storage[s.code], `Tárolás, ${s.name}`)}</td><td class="muted small">Ft / hely / hó</td></tr>`)}</tbody>
                </table></div>` : html`<div class="panel__pad">${ui.empty('Nincs aktív raktárhely méret. A Raktárhelyek fülön vehetsz fel.')}</div>`}
              </section>
              <section class="panel" aria-labelledby="tf-terms">
                <h2 id="tf-terms">Ajánlati feltételek</h2>
                ${ui.field({ name: 'quote_terms', label: 'Feltételek', type: 'textarea', rows: 9, value: (t.quote_terms || []).join('\n'), hint: 'Soronként egy feltétel. Az új ajánlatok ezzel a listával indulnak.', attrs: ro ? 'disabled' : '' })}
              </section>
            </div>
          </div>
          ${ro ? '' : html`<div class="form-actions"><button class="btn btn--primary" type="submit">Mentés</button></div>`}
        </form>`,
    });
    const form = root.querySelector('#tariff-form');
    bindForm(form, async (values) => {
      const n = nested(values);
      await api.put('/api/settings/tariffs', { values: n.values || {}, storage: n.storage || {}, quote_terms: String(values.quote_terms || '').split('\n') });
      ui.toast('Alap tarifák mentve.', 'ok');
    });
  }

  // ================================================================ integration forms (couriers, invoicing)
  const optionList = (options) => (options || []).map((o) => (Array.isArray(o) ? { value: o[0], label: o[1] } : o && typeof o === 'object' ? { value: o.value, label: o.label ?? o.value } : { value: o, label: o }));

  // One input from an adapter field definition { key, label, type, required, options, help }.
  function integrationField(f, kind, values, masked) {
    const name = `${kind}.${f.key}`;
    const label = f.label || f.key;
    const help = f.help || '';
    const ro = !can('edit');
    const attrs = ro ? 'disabled' : '';
    if (kind === 'credentials') {
      const saved = masked && masked[f.key];
      if (f.type === 'checkbox') {
        return ui.field({ name, label, type: 'select', options: [{ value: '1', label: 'Igen' }, { value: '0', label: 'Nem' }], placeholder: saved ? 'Változatlan (mentve)' : 'Nincs megadva', hint: help, attrs: `data-cred-bool ${attrs}`, optional: !f.required });
      }
      if (f.type === 'select') {
        return ui.field({ name, label, type: 'select', options: optionList(f.options), placeholder: saved ? 'Változatlan (mentve)' : 'Válassz', hint: help, attrs, optional: !f.required });
      }
      return ui.field({
        name, label, type: f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text',
        placeholder: saved ? `Mentve: ${saved}` : '',
        hint: [help, saved ? 'Üresen hagyva a mentett érték marad.' : ''].filter(Boolean).join(' '),
        optional: !f.required, autocomplete: 'new-password', attrs,
      });
    }
    // Not saved yet: the adapter's default, so the first save stores it.
    const v = values && values[f.key] !== undefined ? values[f.key] : f.default;
    if (f.type === 'checkbox') return ui.field({ name, label, type: 'checkbox', value: !!v, hint: help, attrs });
    if (f.type === 'select') return ui.field({ name, label, type: 'select', value: v ?? '', options: optionList(f.options), placeholder: f.required ? undefined : 'Nincs megadva', hint: help, attrs, optional: !f.required });
    return ui.field({ name, label, type: f.type === 'number' ? 'number' : 'text', value: v ?? '', hint: help, attrs, optional: !f.required });
  }

  // Reads credentials.* and settings.* from a form: { credentials, settings }.
  function integrationValues(form) {
    const out = { credentials: {}, settings: {} };
    for (const el of form.elements) {
      if (!el.name || el.disabled) continue;
      const m = el.name.match(/^(credentials|settings)\.(.+)$/);
      if (!m) continue;
      const [, kind, key] = m;
      if (HIDDEN_KEYS.has(key)) continue;
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.dataset.type === 'num') v = el.value === '' ? (kind === 'credentials' ? '' : null) : Number(String(el.value).replace(',', '.'));
      else if (el.hasAttribute('data-cred-bool')) v = el.value === '' ? '' : el.value === '1';
      else v = el.value;
      out[kind][key] = v;
    }
    return out;
  }

  // Developer only settings (api_base_url) are never shown or sent; the server drops them too.
  const HIDDEN_KEYS = new Set(['api_base_url']);
  const fieldsBlock = (title, defs, kind, values, masked) => {
    const list = (defs || []).filter((f) => f && !HIDDEN_KEYS.has(f.key));
    return list.length ? html`<h3>${title}</h3><div class="form-grid">${list.map((f) => integrationField(f, kind, values, masked))}</div>` : '';
  };

  // What the courier adapter supports (listCouriers() features).
  const FEATURES = [['tracking', 'Nyomkövetés'], ['cod', 'Utánvét'], ['pickupPoints', 'Csomagpont, automata'], ['testMode', 'Teszt rendszer']];
  const featureList = (f) => {
    if (!f || !Object.keys(f).length) return '';
    return html`<ul class="feature-list" aria-label="Támogatott funkciók">
      ${FEATURES.map(([k, label]) => html`<li data-on="${f[k] ? 'true' : 'false'}">${FL.icon(f[k] ? 'check' : 'x')}${label}<span class="visually-hidden">: ${f[k] ? 'igen' : 'nem'}</span></li>`)}
      ${f.closeRequired ? html`<li data-on="warn">${FL.icon('info')}Napi zárás kötelező</li>` : ''}
    </ul>`;
  };

  // ================================================================ Futárszolgálatok
  async function couriersTab(root) {
    const data = await api.get('/api/settings/couriers');
    const paint = () => {
      frame(root, 'futarok', {
        lead: 'A saját futárszerződéseink hozzáférési adatai. Ezekkel készülnek a címkék és a nyomkövetés. A titkos adatokat titkosítva tároljuk, és soha nem jelenítjük meg.',
        body: html`
          ${readOnlyNotice()}
          ${data.items.length ? html`<div class="grid-2 courier-grid">${data.items.map((c) => courierCard(c))}</div>`
            : ui.notice('A futár integrációk (GLS, DPD, Foxpost, MPL, DHL) még nincsenek telepítve ebben a verzióban. Amint elérhetők, itt adhatod meg a hozzáférési adatokat. Addig a nyomkövetési számot kézzel lehet rögzíteni.', 'info')}`,
      });
    };
    const carrierName = (id) => { const p = data.carriers.find((x) => x.id === id); return p ? p.name : ''; };
    function courierCard(c) {
      const chip = c.active ? html`<span class="chip" data-tone="ok">Aktív</span>` : c.configured ? html`<span class="chip">Kikapcsolva</span>` : html`<span class="chip" data-tone="info">Nincs beállítva</span>`;
      return html`<section class="panel courier-card" aria-labelledby="cr-${c.code}">
        <div class="panel__head"><h2 id="cr-${c.code}">${c.name}</h2>${chip}</div>
        <dl class="dl">
          <dt>Fuvarozó partner</dt><dd>${c.carrier_id ? carrierName(c.carrier_id) : html`<span class="muted">nincs összekapcsolva</span>`}</dd>
          <dt>Hozzáférés</dt><dd>${Object.values(c.credentials || {}).some(Boolean) ? 'megadva' : html`<span class="muted">nincs megadva</span>`}</dd>
          <dt>Utoljára mentve</dt><dd>${c.updated_at ? fmt.dateTime(c.updated_at) : html`<span class="muted">soha</span>`}</dd>
        </dl>
        ${featureList(c.features)}
        ${c.error ? ui.notice(c.error, 'danger') : ''}
        ${c.error && can('edit') ? html`<div class="actions"><button class="btn btn--danger" type="button" data-action="clear-courier" data-code="${c.code}">${FL.icon('trash')}Tárolt hozzáférés törlése</button></div>` : ''}
        ${c.last_error ? ui.notice(html`<b>Utolsó hiba:</b> ${c.last_error}`, 'warn') : ''}
        <div class="actions">
          <button class="btn" type="button" data-action="edit-courier" data-code="${c.code}">${FL.icon(can('edit') ? 'pencil-simple' : 'eye')}${can('edit') ? 'Beállítás' : 'Megtekintés'}</button>
          ${can('edit') ? html`<button class="btn" type="button" data-action="test-courier" data-code="${c.code}" ${c.configured ? '' : raw('disabled title="Előbb mentsd a hozzáférési adatokat"')}>${FL.icon('plugs-connected')}Kapcsolat tesztelése</button>` : ''}
        </div>
      </section>`;
    }
    function courierDialog(c) {
      const carriers = data.carriers.filter((p) => p.carrier_code === c.code).map((p) => ({ value: p.id, label: `${p.name}${p.status === 'active' ? '' : ' (inaktív)'}` }));
      ui.dialog({
        title: `${c.name} beállításai`,
        size: 'wide',
        hideSubmit: !can('edit'),
        cancelLabel: can('edit') ? 'Mégse' : 'Bezárás',
        body: html`
          ${c.error ? ui.notice(c.error, 'danger') : ''}
          <div class="form-grid">
            ${ui.field({ name: 'active', label: 'Aktív: a címkék ezzel a fiókkal készülnek', type: 'checkbox', value: c.active, span: 'all', attrs: can('edit') ? '' : 'disabled' })}
            ${ui.field({ name: 'carrier_id', label: 'Fuvarozó partner', type: 'select', value: c.carrier_id, options: carriers, placeholder: 'Nincs összekapcsolva', optional: true, span: 2, attrs: can('edit') ? '' : 'disabled', hint: carriers.length ? 'A rendeléseken ez a partner jelenik meg fuvarozóként.' : `Nincs ${c.name} kódú fuvarozó partner. A Partnerek között veheted fel.` })}
          </div>
          ${fieldsBlock('Hozzáférési adatok', c.credentialFields, 'credentials', null, c.credentials)}
          ${fieldsBlock('Beállítások', c.settingFields, 'settings', c.settings, null)}`,
        onSubmit: async (form) => {
          const v = ui.formValues(form);
          const res = await api.put(`/api/settings/couriers/${c.code}`, {
            active: !!v.active, carrier_id: v.carrier_id ? Number(v.carrier_id) : null, ...integrationValues(form),
          });
          Object.assign(c, res);
          paint();
          ui.toast(`${c.name} beállításai mentve.`, 'ok');
        },
      });
    }
    paint();
    ui.bind(root, {
      'edit-courier': (el) => courierDialog(data.items.find((c) => c.code === el.dataset.code)),
      'clear-courier': (el) => ui.run(el, async () => {
        const c = data.items.find((x) => x.code === el.dataset.code);
        if (!(await ui.confirm({ title: 'Hozzáférés törlése', text: `A(z) ${c.name} tárolt hozzáférési adatait töröljük és a fiókot kikapcsoljuk. Utána újra meg kell adnod őket. Folytatod?`, confirmLabel: 'Törlés', tone: 'danger' }))) return;
        Object.assign(c, await api.del(`/api/settings/couriers/${c.code}/credentials`));
        paint();
        ui.toast(`${c.name}: a hozzáférési adatok törölve, add meg újra őket.`, 'ok');
      }),
      'test-courier': (el) => ui.run(el, async () => {
        const c = data.items.find((x) => x.code === el.dataset.code);
        const res = await api.post(`/api/settings/couriers/${c.code}/test`);
        ui.toast(`${c.name}: ${res.message}`, res.ok ? 'ok' : 'error');
        c.last_error = res.ok ? '' : res.message;
        paint();
      }),
    });
  }

  // ================================================================ Számlázó
  async function invoicingTab(root) {
    let data = await api.get('/api/settings/invoicing');
    let chosen = data.provider;
    const ro = !can('edit');
    const providerSection = () => {
      const p = data.providers.find((x) => x.code === chosen);
      const name = (data.choices.find((x) => x.value === chosen) || {}).label || chosen;
      if (!chosen) return ui.notice('Számlázó nélkül az elszámolásokat jóváhagyás után kézzel számlázod, a számla számát utólag rögzítheted.', 'info');
      if (!p) return ui.notice(`A(z) ${name} csatlakozás még nincs telepítve ebben a verzióban. A választásodat elmentjük, a hozzáférési adatokat a telepítés után adhatod meg.`, 'warn');
      return html`${fieldsBlock('Hozzáférési adatok', p.credentialFields, 'credentials', null, p.credentials)}${fieldsBlock('Beállítások', p.settingFields, 'settings', p.settings, null)}`;
    };
    const paint = () => {
      frame(root, 'szamlazo', {
        lead: 'A jóváhagyott havi elszámolásokból ezzel a szolgáltatással állítjuk ki a számlát.',
        body: html`
          ${readOnlyNotice()}
          ${data.error ? ui.notice(data.error, 'danger') : ''}
          ${data.error && !ro ? html`<div class="actions"><button class="btn btn--danger" type="button" data-action="clear-invoicing">${FL.icon('trash')}Tárolt hozzáférés törlése</button></div>` : ''}
          <form class="panel" id="invoicing-form" novalidate>
            <fieldset class="field">
              <legend class="field__label">Számlázó szolgáltatás</legend>
              <div class="choice-row">${data.choices.map((c) => html`<label class="choice">
                <input type="radio" name="provider" value="${c.value}" ${c.value === chosen ? raw('checked') : ''} ${disabledIf(ro)}>
                <span><b>${c.label}</b>${c.value === data.provider ? html`<span class="small muted">jelenleg használt</span>` : ''}</span></label>`)}</div>
            </fieldset>
            <div class="form" data-provider>${providerSection()}</div>
            ${ro ? '' : html`<div class="form-actions">
              <button class="btn" type="button" data-action="test-invoicing" ${chosen ? '' : raw('disabled')}>${FL.icon('plugs-connected')}Kapcsolat tesztelése</button>
              <button class="btn btn--primary" type="submit">Mentés</button></div>`}
          </form>`,
      });
      const form = root.querySelector('#invoicing-form');
      form.addEventListener('change', (e) => {
        if (e.target.name !== 'provider') return;
        chosen = e.target.value;
        form.querySelector('[data-provider]').innerHTML = String(providerSection());
        const test = form.querySelector('[data-action="test-invoicing"]');
        if (test) test.disabled = !chosen;
      });
      bindForm(form, async () => {
        const { credentials, settings } = integrationValues(form);
        const body = { provider: chosen, settings: {}, credentials: {} };
        if (chosen && data.providers.some((p) => p.code === chosen)) { body.settings[chosen] = settings; body.credentials[chosen] = credentials; }
        data = await api.put('/api/settings/invoicing', body);
        chosen = data.provider;
        paint();
        ui.toast('Számlázó beállítások mentve.', 'ok');
      });
    };
    paint();
    ui.bind(root, {
      'clear-invoicing': (el) => ui.run(el, async () => {
        if (!(await ui.confirm({ title: 'Hozzáférés törlése', text: 'A számlázók tárolt hozzáférési adatait töröljük. Utána újra meg kell adnod őket. Folytatod?', confirmLabel: 'Törlés', tone: 'danger' }))) return;
        data = await api.del('/api/settings/invoicing/credentials');
        chosen = data.provider;
        paint();
        ui.toast('A számlázó hozzáférési adatai törölve, add meg újra őket.', 'ok');
      }),
      'test-invoicing': (el) => ui.run(el, async () => {
        if (chosen !== data.provider) { ui.toast('Előbb mentsd a választott számlázót, utána teszteld.', 'info'); return; }
        const res = await api.post('/api/settings/invoicing/test', { provider: chosen });
        ui.toast(res.message, res.ok ? 'ok' : 'error');
      }),
    });
  }

  // ================================================================ Napló
  const ACTION_LABELS = { create: 'Létrehozás', edit: 'Módosítás', delete: 'Törlés', approve: 'Jóváhagyás', login: 'Bejelentkezés', view: 'Megtekintés' };
  const ENTITY_LABELS = {
    settings: 'Beállítás', location: 'Raktárhely', location_size: 'Raktárhely méret', courier_account: 'Futárfiók', user: 'Felhasználó', role: 'Szerepkör',
    order: 'Rendelés', inbound: 'Betárolás', wave: 'Komissiós hullám', count: 'Leltár', product: 'Cikk', partner: 'Partner', quote: 'Ajánlat',
    statement: 'Elszámolás', transport: 'Fuvar', pickup: 'Futárátvétel', return: 'Visszáru', api_key: 'API kulcs', webshop: 'Webshop kapcsolat', document: 'Dokumentum',
  };
  const AUDIT_FILTERS = ['q', 'module', 'user_id', 'entity', 'from', 'to'];
  const INTEG_FILTERS = ['q', 'system', 'ok', 'direction', 'from', 'to'];
  const LOG_PAGE = 50;

  async function logTab(root, ctx) {
    const kind = ctx.query.get('log') === 'integracio' ? 'integration' : 'audit';
    const keys = kind === 'audit' ? AUDIT_FILTERS : INTEG_FILTERS;
    const state = { filters: Object.fromEntries(keys.map((k) => [k, ctx.query.get(k) || ''])), offset: Math.max(parseInt(ctx.query.get('offset') || '0', 10) || 0, 0), data: { items: [], total: 0 } };
    const opts = await api.get('/api/settings/audit/filters');
    const seg = html`<nav class="seg" aria-label="Napló fajtája">
      <a href="${BASE}/naplo" ${kind === 'audit' ? raw('aria-current="page"') : ''}>${FL.icon('list-checks')}Műveleti napló</a>
      <a href="${BASE}/naplo?log=integracio" ${kind === 'integration' ? raw('aria-current="page"') : ''}>${FL.icon('plugs-connected')}Integrációs napló</a></nav>`;
    frame(root, 'naplo', {
      lead: kind === 'audit' ? 'Ki, mit és mikor csinált a rendszerben. Minden létrehozás, módosítás, törlés és jóváhagyás ide kerül.' : 'A webshopok, futárok, a számlázó és a partner API hívásai, hibakereséshez.',
      actions: kind === 'audit' ? html`<button class="btn" type="button" data-action="export-log">${FL.icon('download-simple')}Exportálás</button>` : '',
      body: html`${seg}
        <section class="panel panel--flush">
          <form class="toolbar log-filters" data-filters novalidate></form>
          <div class="slot" data-log></div>
        </section>`,
    });
    const $ = (s) => root.querySelector(s);
    $('[data-filters]').addEventListener('submit', (e) => e.preventDefault());
    const f = state.filters;
    const dateFields = html`
      ${ui.field({ name: 'from', label: 'Dátumtól', type: 'date', value: f.from, attrs: 'data-action="filter"' })}
      ${ui.field({ name: 'to', label: 'Dátumig', type: 'date', value: f.to, attrs: 'data-action="filter"' })}`;
    $('[data-filters]').innerHTML = String(kind === 'audit'
      ? html`
        <div class="field field--grow"><label for="log-q">Keresés</label><input class="input" id="log-q" name="q" type="search" value="${f.q}" placeholder="Leírás vagy név" autocomplete="off"></div>
        ${ui.field({ name: 'module', label: 'Modul', type: 'select', value: f.module, placeholder: 'Mind', options: opts.modules.map((m) => ({ value: m.key, label: m.name })), attrs: 'data-action="filter"' })}
        ${ui.field({ name: 'user_id', label: 'Felhasználó', type: 'select', value: f.user_id, placeholder: 'Mind', options: opts.users.map((u) => ({ value: u.id, label: `${u.name}${u.active ? '' : ' (letiltva)'}` })), attrs: 'data-action="filter"' })}
        ${ui.field({ name: 'entity', label: 'Tétel', type: 'select', value: f.entity, placeholder: 'Mind', options: opts.entities.map((e) => ({ value: e, label: ENTITY_LABELS[e] || e })), attrs: 'data-action="filter"' })}
        ${dateFields}`
      : html`
        <div class="field field--grow"><label for="log-q">Keresés</label><input class="input" id="log-q" name="q" type="search" value="${f.q}" placeholder="Üzenet vagy művelet" autocomplete="off"></div>
        ${ui.field({ name: 'system', label: 'Rendszer', type: 'select', value: f.system, placeholder: 'Mind', options: opts.systems.map((s) => ({ value: s, label: s })), attrs: 'data-action="filter"' })}
        ${ui.field({ name: 'ok', label: 'Eredmény', type: 'select', value: f.ok, placeholder: 'Mind', options: [{ value: '1', label: 'Sikeres' }, { value: '0', label: 'Hibás' }], attrs: 'data-action="filter"' })}
        ${ui.field({ name: 'direction', label: 'Irány', type: 'select', value: f.direction, placeholder: 'Mind', options: [{ value: 'out', label: 'Kimenő (mi hívtuk)' }, { value: 'in', label: 'Bejövő (minket hívtak)' }], attrs: 'data-action="filter"' })}
        ${dateFields}`);
    const q = $('#log-q');
    q.addEventListener('input', FL.debounce(() => { state.filters.q = q.value.trim(); state.offset = 0; load(); }, 300));

    async function load() {
      const query = { ...state.filters, offset: state.offset || '' };
      history.replaceState(null, '', `${BASE}/naplo${FL.qs({ log: kind === 'integration' ? 'integracio' : '', ...query })}`);
      state.data = await api.get(kind === 'audit' ? '/api/settings/audit' : '/api/settings/integration-log', { ...state.filters, limit: LOG_PAGE, offset: state.offset });
      paint();
    }
    function paint() {
      const { items, total } = state.data;
      const columns = kind === 'audit'
        ? [
          { key: 'at', label: 'Időpont', cls: 'num nowrap', render: (x) => fmt.dateTime(x.at) },
          { key: 'actor', label: 'Felhasználó', render: (x) => x.actor },
          { key: 'module', label: 'Modul', render: (x) => x.module_name },
          { key: 'action', label: 'Művelet', render: (x) => ACTION_LABELS[x.action] || x.action },
          { key: 'summary', label: 'Leírás', render: (x) => (x.details ? html`<button class="link-btn" type="button" data-action="details" data-id="${x.id}">${x.summary || 'Részletek'}</button>` : x.summary) },
          { key: 'entity', label: 'Tétel', render: (x) => (x.entity ? html`${ENTITY_LABELS[x.entity] || x.entity}${x.entity_id ? html`<span class="sub mono">${x.entity_id}</span>` : ''}` : '') },
        ]
        : [
          { key: 'at', label: 'Időpont', cls: 'num nowrap', render: (x) => fmt.dateTime(x.at) },
          { key: 'system', label: 'Rendszer', render: (x) => html`<span class="tag">${x.system}</span>` },
          { key: 'direction', label: 'Irány', render: (x) => (x.direction === 'in' ? 'Bejövő' : 'Kimenő') },
          { key: 'partner', label: 'Partner', render: (x) => x.partner_name || '' },
          { key: 'action', label: 'Művelet', cls: 'mono', render: (x) => x.action },
          { key: 'ok', label: 'Eredmény', render: (x) => html`<span class="chip" data-tone="${x.ok ? 'ok' : 'danger'}">${x.ok ? 'Sikeres' : 'Hibás'}${x.status ? ` ${x.status}` : ''}</span>` },
          { key: 'message', label: 'Üzenet', cls: 'log-msg', render: (x) => x.message },
        ];
      $('[data-log]').innerHTML = String(html`
        ${ui.table({ rows: items, columns, cls: 'log-table', caption: kind === 'audit' ? 'Műveleti napló' : 'Integrációs napló', empty: Object.values(state.filters).some(Boolean) ? 'Nincs a szűrésnek megfelelő bejegyzés.' : 'Még nincs bejegyzés.' })}
        ${ui.pager({ total, limit: LOG_PAGE, offset: state.offset })}`);
    }
    function details(x) {
      const d = x.details || {};
      const changes = d.changes && typeof d.changes === 'object' ? Object.entries(d.changes).filter(([, v]) => Array.isArray(v) && v.length === 2) : [];
      const show = (v) => (v == null || v === '' ? html`<span class="muted">üres</span>` : typeof v === 'object' ? JSON.stringify(v) : String(v));
      const rest = { ...d };
      if (changes.length) delete rest.changes;
      ui.dialog({
        title: 'Napló bejegyzés',
        hideSubmit: true,
        cancelLabel: 'Bezárás',
        size: 'wide',
        body: html`
          <dl class="dl">
            <dt>Időpont</dt><dd>${fmt.dateTime(x.at)}</dd>
            <dt>Felhasználó</dt><dd>${x.actor}</dd>
            <dt>Modul, művelet</dt><dd>${x.module_name}, ${ACTION_LABELS[x.action] || x.action}</dd>
            <dt>Leírás</dt><dd>${x.summary}</dd>
          </dl>
          ${changes.length ? ui.table({ caption: 'Változások', rows: changes.map(([k, v], i) => ({ id: i, k, a: v[0], b: v[1] })), columns: [
            { key: 'k', label: 'Mező', cls: 'mono' }, { key: 'a', label: 'Régi érték', render: (r) => show(r.a) }, { key: 'b', label: 'Új érték', render: (r) => show(r.b) }] }) : ''}
          ${Object.keys(rest).length ? html`<pre class="json">${JSON.stringify(rest, null, 2)}</pre>` : ''}`,
      });
    }
    ui.bind(root, {
      filter: (el) => { state.filters[el.name] = el.value; state.offset = 0; load(); },
      page: (el) => { state.offset = Number(el.dataset.offset) || 0; load(); },
      details: (el) => details(state.data.items.find((x) => x.id === Number(el.dataset.id))),
      'export-log': (el) => ui.run(el, () => api.download('/api/settings/audit/export', state.filters)),
    });
    await load();
  }

  // ================================================================ view
  const RENDER = {
    cegadatok: companyTab,
    raktar: warehouseTab,
    raktarhelyek: locationsTab,
    alaptarifak: tariffsTab,
    futarok: couriersTab,
    szamlazo: invoicingTab,
    naplo: logTab,
  };

  const view = {
    title: 'Beállítások',
    async render(root, ctx) {
      let tab = ctx.params[0];
      if (!RENDER[tab]) {
        tab = 'cegadatok';
        history.replaceState(null, '', `${BASE}/${tab}`);
      }
      await RENDER[tab](root, ctx);
    },
  };
  // core/app.js (which defines FL.view) loads after the views; it keeps FL.views, so registering
  // there directly works in either order.
  if (typeof FL.view === 'function') FL.view('settings', view);
  else (FL.views = FL.views || {}).settings = view;
})();
