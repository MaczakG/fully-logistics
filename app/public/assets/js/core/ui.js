/* UI kit. Views build their markup with FL.html and these helpers, so every screen looks and
   behaves the same. Main pieces:
     FL.icon(name)                     inline icon from the sprite
     FL.can(module, action)            permission of the signed-in user
     FL.status(kind, key)              status chip (labels and colours from /api/meta)
     FL.ui.pageHead / kpis / table / empty / tabs / pager
     FL.ui.field(...)                  labelled form field; FL.ui.formValues(form); FL.ui.showErrors(form, err)
     FL.ui.dialog(...) / confirm(...)  modal dialogs on the native <dialog>
     FL.ui.toast(text, tone)           short message bottom right
     FL.ui.bind(root, handlers)        click delegation: <button data-action="save"> calls handlers.save(el, ev)
     FL.ui.autocomplete(input, ...)    search-as-you-type picker (products, locations, partners)
     FL.ui.scan(...)                   barcode input: hand scanners type the code and press Enter
     FL.ui.csvImport(...)              upload, preview with errors, then import
     FL.ui.run(button, fn)             busy state + error toast around an async action */
(() => {
  'use strict';
  const FL = window.FL;
  const { html, raw } = FL;
  const ui = (FL.ui = {});

  FL.icon = (name, cls = '') => raw(`<svg class="icon${cls ? ` ${cls}` : ''}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`);

  FL.can = (module, action = 'view') => {
    const p = FL.state && FL.state.permissions;
    return !!(p && p[module] && p[module].includes(action));
  };

  FL.status = (kind, key) => {
    const s = FL.state && FL.state.meta && FL.state.meta.statuses[kind] && FL.state.meta.statuses[kind][key];
    return html`<span class="chip" data-tone="${s ? s.tone : 'neutral'}">${s ? s.label : key}</span>`;
  };
  FL.statusLabel = (kind, key) => {
    const s = FL.state.meta.statuses[kind] && FL.state.meta.statuses[kind][key];
    return s ? s.label : key;
  };

  /* ------------------------------------------------------------ layout pieces */

  // { title, lead, crumb: { href, label }, actions: html }
  ui.pageHead = ({ title, lead, crumb, actions }) => html`
    <header class="page-head">
      <div class="page-head__text">
        ${crumb ? html`<a class="crumb" href="${crumb.href}">${FL.icon('arrow-left')}${crumb.label}</a>` : ''}
        <h1>${title}</h1>
        ${lead ? html`<p>${lead}</p>` : ''}
      </div>
      ${actions ? html`<div class="actions">${actions}</div>` : ''}
    </header>`;

  // [{ label, value, hint, tone, href }]
  ui.kpis = (items) => html`<div class="kpis">${items.map((k) => {
    const inner = html`<span class="kpi__label">${k.label}</span><span class="kpi__value">${k.value}</span>${k.hint ? html`<span class="kpi__hint">${k.hint}</span>` : ''}`;
    return k.href ? html`<a class="kpi" href="${k.href}" data-tone="${k.tone || ''}">${inner}</a>` : html`<div class="kpi" data-tone="${k.tone || ''}">${inner}</div>`;
  })}</div>`;

  ui.empty = (text = 'Nincs megjeleníthető adat.', icon = 'info') => html`<div class="empty">${FL.icon(icon)}<p>${text}</p></div>`;
  ui.loading = (text = 'Betöltés...') => html`<div class="loading" role="status">${text}</div>`;

  ui.notice = (text, tone = 'info', icon = tone === 'danger' || tone === 'warn' ? 'warning-circle' : 'info') =>
    html`<div class="notice" data-tone="${tone}">${FL.icon(icon)}<div>${text}</div></div>`;

  /* table({ columns, rows, empty, rowHref, rowAttrs, footer, selectable, selected, caption, cls })
       columns: [{ key, label, align: 'r'|'c', cls, render(row) -> value|html, width }]
       rowHref(row): makes the row clickable (the first link is the keyboard target)
       selectable: adds checkboxes (data-action="select-row"/"select-all"), selected: Set of ids */
  ui.table = ({ columns, rows, empty, rowHref, rowAttrs, footer, selectable, selected, caption, cls = '' }) => {
    if (!rows || !rows.length) return html`<div class="table-wrap">${ui.empty(empty)}</div>`;
    const allSel = selectable && rows.every((r) => selected && selected.has(r.id));
    return html`<div class="table-wrap"><table class="table ${cls}">
      ${caption ? html`<caption class="visually-hidden">${caption}</caption>` : ''}
      <thead><tr>
        ${selectable ? html`<th class="w-check"><input type="checkbox" aria-label="Összes kijelölése" data-action="select-all" ${allSel ? raw('checked') : ''}></th>` : ''}
        ${columns.map((c) => html`<th class="${c.align || ''} ${c.cls || ''}" ${c.width ? raw(`style="width:${c.width}"`) : ''} scope="col">${c.label}</th>`)}
      </tr></thead>
      <tbody>${rows.map((r) => {
        const href = rowHref ? rowHref(r) : null;
        const sel = selectable && selected && selected.has(r.id);
        return html`<tr ${href ? raw(`data-href="${FL.esc(href)}"`) : ''} ${sel ? raw('data-selected="true"') : ''} ${rowAttrs ? raw(rowAttrs(r)) : ''}>
          ${selectable ? html`<td class="w-check"><input type="checkbox" aria-label="Kijelölés" data-action="select-row" data-id="${r.id}" ${sel ? raw('checked') : ''}></td>` : ''}
          ${columns.map((c) => html`<td class="${c.align || ''} ${c.cls || ''}">${c.render ? c.render(r) : r[c.key]}</td>`)}
        </tr>`;
      })}</tbody>
      ${footer ? html`<tfoot>${footer}</tfoot>` : ''}
    </table></div>`;
  };

  // Clickable rows: Enter/click on a row with data-href navigates (unless a control was clicked).
  ui.enableRowLinks = (root) => {
    root.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-href]');
      if (!tr || e.target.closest('a, button, input, select, textarea, label')) return;
      FL.go(tr.dataset.href);
    });
  };

  // tabs([{ key, label, count, href }], activeKey): links (hash routes) styled as tabs.
  ui.tabs = (items, active, label = 'Fülek') => html`<nav class="tabs" aria-label="${label}">${items.map((t) => html`
    <a class="tab" href="${t.href}" ${t.key === active ? raw('aria-current="page"') : ''}>${t.icon ? FL.icon(t.icon) : ''}${t.label}${t.count != null ? html` <span class="count">${t.count}</span>` : ''}</a>`)}</nav>`;

  // pager({ total, limit, offset }) with buttons data-action="page" data-offset="N"
  ui.pager = ({ total, limit, offset }) => {
    if (total <= limit) return html`<div class="table-foot"><span>${FL.fmt.int(total)} tétel</span></div>`;
    const from = offset + 1;
    const to = Math.min(offset + limit, total);
    return html`<div class="table-foot">
      <span>${FL.fmt.int(from)}-${FL.fmt.int(to)} / ${FL.fmt.int(total)} tétel</span>
      <span class="actions">
        <button class="btn btn--sm" type="button" data-action="page" data-offset="${Math.max(offset - limit, 0)}" ${offset === 0 ? raw('disabled') : ''}>${FL.icon('caret-left')}Előző</button>
        <button class="btn btn--sm" type="button" data-action="page" data-offset="${offset + limit}" ${to >= total ? raw('disabled') : ''}>Következő${FL.icon('caret-right')}</button>
      </span>
    </div>`;
  };

  /* ------------------------------------------------------------ forms
     field({ name, label, type, value, required, options, placeholder, hint, optional, span, attrs, id, rows })
       type: text | number | email | tel | date | time | password | textarea | select | checkbox | hidden | code
       options (select): [{ value, label }] or [[value, label]]
       data-type="int" | "num" | "bool" on inputs makes formValues return numbers/booleans */
  let uid = 0;
  ui.field = (f) => {
    const id = f.id || `f-${f.name}-${++uid}`;
    const errId = `${id}-err`;
    const common = html`id="${id}" name="${f.name}" ${f.required ? raw('required') : ''} aria-describedby="${errId}" ${f.attrs ? raw(f.attrs) : ''}`;
    const opt = f.optional ? html` <span class="field__opt">(nem kötelező)</span>` : '';
    const span = f.span ? (f.span === 'all' ? 'span-all' : `span-${f.span}`) : '';
    if (f.type === 'hidden') return html`<input type="hidden" name="${f.name}" value="${f.value ?? ''}">`;
    if (f.type === 'checkbox') {
      return html`<div class="field ${span}"><label class="check"><input type="checkbox" ${common} data-type="bool" value="1" ${f.value ? raw('checked') : ''}><span>${f.label}</span></label>
        ${f.hint ? html`<span class="field__hint">${f.hint}</span>` : ''}<p class="field__error" id="${errId}" hidden></p></div>`;
    }
    let control;
    if (f.type === 'select') {
      control = html`<select class="select" ${common}>${ui.options(f.options || [], f.value, f.placeholder)}</select>`;
    } else if (f.type === 'textarea') {
      control = html`<textarea class="textarea" rows="${f.rows || 4}" ${common} placeholder="${f.placeholder || ''}">${f.value ?? ''}</textarea>`;
    } else {
      const type = f.type === 'code' ? 'text' : f.type || 'text';
      const isNum = type === 'number';
      const cls = isNum ? 'input input--num' : f.type === 'code' ? 'input input--code' : 'input';
      const dtype = isNum ? raw(`data-type="${f.int ? 'int' : 'num'}"`) : '';
      const step = isNum ? raw(`step="${f.step || (f.int ? 1 : 'any')}"`) : '';
      control = html`<input class="${cls}" type="${type}" ${common} ${dtype} ${step} value="${f.value ?? ''}" placeholder="${f.placeholder || ''}" ${f.min != null ? raw(`min="${f.min}"`) : ''} ${f.max != null ? raw(`max="${f.max}"`) : ''} autocomplete="${f.autocomplete || 'off'}">`;
    }
    return html`<div class="field ${span}">
      <label for="${id}">${f.label}${opt}</label>
      ${control}
      ${f.hint ? html`<span class="field__hint">${f.hint}</span>` : ''}
      <p class="field__error" id="${errId}" hidden></p>
    </div>`;
  };

  ui.options = (list, value, placeholder) => {
    const items = list.map((o) => (Array.isArray(o) ? { value: o[0], label: o[1] } : o));
    return html`${placeholder !== undefined ? html`<option value="">${placeholder}</option>` : ''}${items.map((o) =>
      html`<option value="${o.value}" ${String(o.value) === String(value ?? '') ? raw('selected') : ''}>${o.label}</option>`)}`;
  };

  // Reads a form into an object. Respects data-type on inputs; unchecked checkboxes are false.
  ui.formValues = (form) => {
    const out = {};
    for (const el of form.elements) {
      if (!el.name || el.disabled || el.type === 'button' || el.type === 'submit') continue;
      const t = el.dataset.type;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
      else if (t === 'int') out[el.name] = el.value === '' ? null : parseInt(el.value, 10);
      else if (t === 'num') out[el.name] = el.value === '' ? null : Number(String(el.value).replace(',', '.'));
      else out[el.name] = el.value;
    }
    return out;
  };

  ui.clearErrors = (form) => {
    form.querySelectorAll('[aria-invalid="true"]').forEach((el) => el.removeAttribute('aria-invalid'));
    form.querySelectorAll('.field__error').forEach((el) => { el.hidden = true; el.textContent = ''; });
  };

  // Shows ApiError.fields next to the inputs with those names; other errors as a toast.
  ui.showErrors = (form, err) => {
    ui.clearErrors(form);
    let shown = false;
    if (err && err.fields) {
      for (const [name, msg] of Object.entries(err.fields)) {
        const el = form.querySelector(`[name="${CSS.escape(name)}"]`);
        if (!el) continue;
        el.setAttribute('aria-invalid', 'true');
        const box = el.closest('.field') && el.closest('.field').querySelector('.field__error');
        if (box) { box.hidden = false; box.textContent = msg; }
        if (!shown) el.focus();
        shown = true;
      }
    }
    ui.toast(err && err.message ? err.message : 'Hiba történt.', 'error');
  };

  /* ------------------------------------------------------------ actions */

  // Click delegation for [data-action] elements inside root.
  ui.bind = (root, handlers) => {
    const onEvent = (e) => {
      const el = e.target.closest('[data-action]');
      if (!el || !root.contains(el)) return;
      const fn = handlers[el.dataset.action];
      if (!fn) return;
      if (e.type === 'change' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return;
      if (e.type === 'click' && ['SELECT'].includes(el.tagName)) return;
      if (e.type === 'click' && el.tagName === 'INPUT' && el.type !== 'checkbox' && el.type !== 'radio') return;
      if (e.type === 'change' && el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return;
      if (el.tagName === 'A' && el.getAttribute('href') === '#') e.preventDefault();
      fn(el, e);
    };
    root.addEventListener('click', onEvent);
    root.addEventListener('change', onEvent);
  };

  // Runs an async action with a busy button and an error toast. Returns the result or undefined.
  ui.run = async (button, fn) => {
    if (button) { button.setAttribute('aria-busy', 'true'); button.disabled = true; }
    try {
      return await fn();
    } catch (err) {
      ui.toast(err && err.message ? err.message : 'Hiba történt.', 'error');
      if (!(err instanceof FL.ApiError)) console.error(err);
      return undefined;
    } finally {
      if (button) { button.removeAttribute('aria-busy'); button.disabled = false; }
    }
  };

  /* ------------------------------------------------------------ toasts */
  ui.toast = (text, tone = 'info') => {
    const box = document.getElementById('toasts');
    if (!box) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.dataset.tone = tone;
    t.innerHTML = String(html`${FL.icon(tone === 'error' ? 'warning-circle' : tone === 'ok' ? 'check-circle' : 'info')}<p>${text}</p>`);
    box.appendChild(t);
    setTimeout(() => t.remove(), tone === 'error' ? 7000 : 3500);
  };

  /* ------------------------------------------------------------ dialogs
     dialog({ title, body, size: 'wide'|'narrow', submitLabel, submitTone: 'primary'|'danger',
              cancelLabel, hideSubmit, onSubmit(form, api) -> false keeps it open, onOpen(api) })
     body is markup; the dialog content is a <form>, so fields with FL.ui.field work directly.
     api: { el, form, close(), setBusy(bool) }. Returns api; api.done is a Promise resolved on close
     with the onSubmit result (or undefined when cancelled). */
  ui.dialog = (opts) => {
    const d = document.createElement('dialog');
    d.className = `dialog${opts.size ? ` dialog--${opts.size}` : ''}`;
    const titleId = `dlg-${++uid}`;
    d.setAttribute('aria-labelledby', titleId);
    d.innerHTML = String(html`<form class="dialog__inner" novalidate>
      <div class="dialog__head"><h2 id="${titleId}">${opts.title}</h2>
        <button class="btn btn--ghost btn--icon btn--sm" type="button" data-close aria-label="Bezárás">${FL.icon('x')}</button></div>
      <div class="dialog__body">${opts.body}</div>
      <div class="dialog__foot"><div class="form-actions">
        ${opts.footNote ? html`<span class="muted small">${opts.footNote}</span>` : ''}
        <button class="btn" type="button" data-close>${opts.cancelLabel || 'Mégse'}</button>
        ${opts.hideSubmit ? '' : html`<button class="btn ${opts.submitTone === 'danger' ? 'btn--danger' : 'btn--primary'}" type="submit">${opts.submitLabel || 'Mentés'}</button>`}
      </div></div>
    </form>`);
    document.body.appendChild(d);
    const form = d.querySelector('form');
    const submit = form.querySelector('[type="submit"]');
    let resolveDone;
    const api = {
      el: d,
      form,
      done: new Promise((r) => (resolveDone = r)),
      result: undefined,
      close: (result) => { api.result = result; d.close(); },
      setBusy: (busy) => { if (submit) { submit.disabled = busy; submit.toggleAttribute('aria-busy', busy); } },
    };
    d.addEventListener('close', () => { resolveDone(api.result); d.remove(); });
    form.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) api.close(); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!opts.onSubmit) { api.close(true); return; }
      ui.clearErrors(form);
      api.setBusy(true);
      try {
        const r = await opts.onSubmit(form, api);
        if (r !== false) api.close(r === undefined ? true : r);
      } catch (err) {
        ui.showErrors(form, err);
      } finally {
        if (d.open) api.setBusy(false);
      }
    });
    d.showModal();
    if (opts.onOpen) opts.onOpen(api);
    const first = form.querySelector('.dialog__body input:not([type="hidden"]), .dialog__body select, .dialog__body textarea');
    if (first && !opts.noAutofocus) first.focus();
    return api;
  };

  // confirm({ title, text, confirmLabel, tone }) -> Promise<boolean>
  ui.confirm = ({ title = 'Biztos vagy benne?', text = '', confirmLabel = 'Igen', tone = 'primary' } = {}) => {
    const dlg = ui.dialog({ title, size: 'narrow', body: html`<p>${text}</p>`, submitLabel: confirmLabel, submitTone: tone, noAutofocus: true });
    return dlg.done.then((r) => r === true);
  };

  /* ------------------------------------------------------------ autocomplete
     autocomplete(input, { source: async (q) => items, label: (item) => text, sub: (item) => text,
                           onSelect: (item) => void, minLength: 1 })
     Keyboard: arrows to move, Enter to pick, Escape to close. */
  ui.autocomplete = (input, { source, label, sub, onSelect, minLength = 1 }) => {
    const list = document.createElement('ul');
    list.className = 'ac-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    const lid = `ac-${++uid}`;
    list.id = lid;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', lid);
    input.setAttribute('aria-expanded', 'false');
    input.parentElement.style.position = 'relative';
    input.insertAdjacentElement('afterend', list);
    let items = [];
    let active = -1;
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
    const paint = () => {
      list.innerHTML = String(html`${items.map((it, i) => html`<li role="option" id="${lid}-${i}" data-i="${i}" aria-selected="${i === active}">
        <b>${label(it)}</b>${sub ? html`<span>${sub(it)}</span>` : ''}</li>`)}`);
      if (!items.length) list.innerHTML = '<li class="ac-none">Nincs találat</li>';
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (active >= 0) input.setAttribute('aria-activedescendant', `${lid}-${active}`);
      else input.removeAttribute('aria-activedescendant');
    };
    const pick = (i) => { const it = items[i]; if (!it) return; close(); onSelect(it); };
    const search = FL.debounce(async () => {
      const q = input.value.trim();
      if (q.length < minLength) { close(); return; }
      try { items = await source(q); } catch { items = []; }
      active = items.length ? 0 : -1;
      if (document.activeElement === input) paint();
    }, 200);
    input.addEventListener('input', search);
    input.addEventListener('keydown', (e) => {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
      else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); pick(active); } }
      else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    list.addEventListener('mousedown', (e) => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); pick(Number(li.dataset.i)); } });
    return { close };
  };

  // Ready-made sources for the common pickers.
  ui.sources = {
    products: (partnerId) => async (q) => (await FL.api.get('/api/lookup/products', { q, partner_id: partnerId || '' })).items,
    locations: async (q) => (await FL.api.get('/api/lookup/locations', { q })).items,
  };
  ui.productLabel = (p) => `${p.sku} ${p.name}`;

  /* ------------------------------------------------------------ barcode scanning
     scan({ id, label, placeholder }) renders the input; bindScan(root, id, onScan) handles Enter.
     Hand scanners act as keyboards: they type the code and send Enter. */
  ui.scan = ({ id = 'scan', label = 'Vonalkód vagy kód beolvasása', placeholder = 'Olvasd be a vonalkódot, vagy írd be és nyomj Entert' } = {}) => html`
    <div class="scan">${FL.icon('barcode')}<label class="visually-hidden" for="${id}">${label}</label>
      <input id="${id}" type="text" inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="${placeholder}"></div>`;
  ui.bindScan = (root, id, onScan) => {
    const input = root.querySelector(`#${id}`);
    if (!input) return null;
    input.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const code = input.value.trim();
      input.value = '';
      if (code) await onScan(code);
      // Back to the scan field, unless the handler moved focus on purpose (quantity, tracking ...).
      if (!document.activeElement || document.activeElement === document.body || document.activeElement === input) input.focus();
    });
    return input;
  };

  /* ------------------------------------------------------------ CSV import
     csvImport({ title, endpoint, help, templateName, templateColumns: [label...], extra: {...}, unit: 'tétel' })
     Flow: choose file -> POST endpoint with preview=1 -> server answers
       { rows: n, valid: n, errors: [{ line, message }], sample: [...] }
     -> user confirms -> POST again with preview=0 -> { imported: n, ... }.
     Resolves with the final server response, or undefined if cancelled. */
  ui.csvImport = ({ title, endpoint, help, templateName = 'sablon.csv', templateColumns = [], extra = {}, unit = 'tétel' }) => new Promise((resolve) => {
    let file = null;
    const dlg = ui.dialog({
      title,
      size: 'wide',
      submitLabel: 'Ellenőrzés',
      body: html`
        ${help ? html`<p>${help}</p>` : ''}
        ${templateColumns.length ? html`<p class="small muted">Oszlopok: ${templateColumns.join('; ')}. Elválasztó: pontosvessző vagy vessző. <button class="link-btn" type="button" data-template>Sablon letöltése</button></p>` : ''}
        <div class="field"><label for="csv-file">CSV fájl</label><input class="input" id="csv-file" name="file" type="file" accept=".csv,text/csv" required></div>
        <div data-preview></div>`,
      onOpen: ({ form }) => {
        const t = form.querySelector('[data-template]');
        if (t) t.addEventListener('click', () => FL.downloadBlob(new Blob([`﻿${templateColumns.join(';')}\r\n`], { type: 'text/csv' }), templateName));
        form.querySelector('#csv-file').addEventListener('change', (e) => {
          file = e.target.files[0] || null;
          form.querySelector('[type="submit"]').textContent = 'Ellenőrzés';
          form.dataset.stage = 'check';
          form.querySelector('[data-preview]').innerHTML = '';
        });
      },
      onSubmit: async (form) => {
        if (!file) throw new FL.ApiError(400, 'bad_request', 'Válassz ki egy CSV fájlt.', { file: 'Válassz ki egy fájlt.' });
        const preview = form.dataset.stage !== 'commit';
        const res = await FL.api.upload(endpoint, file, { ...extra, preview: preview ? '1' : '0' });
        if (!preview) { ui.toast(`Importálva: ${FL.fmt.int(res.imported)} ${unit}.`, 'ok'); resolve(res); return true; }
        const box = form.querySelector('[data-preview]');
        box.innerHTML = String(html`
          ${ui.kpis([{ label: 'Sorok', value: FL.fmt.int(res.rows) }, { label: 'Importálható', value: FL.fmt.int(res.valid), tone: 'ok' }, { label: 'Hibás', value: FL.fmt.int(res.errors.length), tone: res.errors.length ? 'danger' : '' }])}
          ${res.errors.length ? ui.table({ columns: [{ key: 'line', label: 'Sor', align: 'r', cls: 'num' }, { key: 'message', label: 'Hiba' }], rows: res.errors.slice(0, 100) }) : ''}
          ${res.warnings && res.warnings.length ? ui.table({ caption: 'Figyelmeztetések (ezek a sorok is importálódnak)', columns: [{ key: 'line', label: 'Sor', align: 'r', cls: 'num' }, { key: 'message', label: 'Figyelmeztetés' }], rows: res.warnings.slice(0, 100) }) : ''}
          ${res.valid ? ui.notice(res.errors.length ? 'A hibás sorok kimaradnak. Az importálás a többit rögzíti.' : 'Minden sor rendben. Indíthatod az importálást.', res.errors.length ? 'warn' : 'ok') : ui.notice('Nincs importálható sor.', 'danger')}`);
        if (res.valid) {
          form.dataset.stage = 'commit';
          form.querySelector('[type="submit"]').textContent = `Importálás (${FL.fmt.int(res.valid)} sor)`;
        }
        return false;
      },
    });
    dlg.done.then((r) => { if (r === undefined) resolve(undefined); });
  });

  /* ------------------------------------------------------------ small helpers */

  // Selection set for tables with checkboxes. bind with ui.bind handlers 'select-row' / 'select-all'.
  ui.selection = (getRows, onChange) => {
    const set = new Set();
    return {
      set,
      handlers: {
        'select-row': (el) => { const id = Number(el.dataset.id); if (el.checked) set.add(id); else set.delete(id); onChange(set); },
        'select-all': (el) => { for (const r of getRows()) { if (el.checked) set.add(r.id); else set.delete(r.id); } onChange(set); },
      },
    };
  };

  // Partner <select> options from the lookup: partnerOptions('client') -> [{ value, label }]
  ui.partnerOptions = async (type) => (await FL.api.get('/api/lookup/partners', { type })).items.map((p) => ({ value: p.id, label: `${p.name} (${p.code})` }));

  // Disabled-looking button that explains why, for actions the user may not perform.
  ui.denyAttr = (module, action) => (FL.can(module, action) ? '' : raw('disabled title="Ehhez nincs jogosultságod"'));
})();
