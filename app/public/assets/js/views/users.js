/* Felhasználók (module "users"): route #/felhasznalok/<tab>
     lista           users: create with a temporary password (shown once), edit, new temporary
                     password, sign out everywhere, delete (or deactivate when there is history)
     jogosultsagok   roles and the permission matrix (role x module x action, "műveletenként
                     pipák"), plus a read-only overview of every role
   The server enforces every rule (one active administrator at least, the administrator role is
   locked, only administrators touch administrator accounts); the screen mirrors them. */
(() => {
  'use strict';
  const { html, raw, ui, api, fmt } = FL;
  const BASE = '#/felhasznalok';
  const TABS = [
    { key: 'lista', label: 'Felhasználók', icon: 'users-three' },
    { key: 'jogosultsagok', label: 'Jogosultságok', icon: 'shield-check' },
  ];
  const can = (action) => FL.can('users', action);
  const me = () => FL.state.me.user;
  const GROUPS = [['warehouse', 'Raktár'], ['commercial', 'Kereskedelem'], ['admin', 'Adminisztráció']];
  const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve'];
  const SHORT = { view: 'M', create: 'L', edit: 'Mó', delete: 'T', approve: 'J' };
  const actionLabel = (a) => (FL.state.meta.actions || {})[a] || a;

  // Unsaved matrix changes per role (roleId -> Set of "module:action"); they survive leaving the
  // tab and coming back within the session.
  const drafts = new Map();

  function frame(root, tab, { lead, actions, body }) {
    root.innerHTML = String(html`
      ${ui.pageHead({ title: 'Felhasználók', lead, actions })}
      ${ui.tabs(TABS.map((t) => ({ ...t, href: `${BASE}/${t.key}` })), tab, 'Felhasználók részei')}
      ${body}`);
  }

  const roleOptions = (roles, { allowAdmin }) => roles.map((r) => ({ value: r.id, label: r.is_admin && !allowAdmin ? `${r.name} (csak adminisztrátor adhatja)` : r.name }));

  async function copyText(text, input) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      if (!input) return false;
      input.focus();
      input.select();
      try { return document.execCommand('copy'); } catch { return false; }
    }
  }

  // The temporary password, shown exactly once.
  function passwordDialog(user, password) {
    ui.dialog({
      title: 'Ideiglenes jelszó',
      size: 'narrow',
      hideSubmit: true,
      cancelLabel: 'Kész',
      noAutofocus: true,
      body: html`
        ${ui.notice(html`Ezt a jelszót <b>csak most</b> látod. Add át ${user.name} részére személyesen vagy telefonon, ne e-mailben.`, 'warn')}
        <div class="temp-pass">
          <label class="visually-hidden" for="temp-pass">Ideiglenes jelszó</label>
          <input class="input" id="temp-pass" value="${password}" readonly spellcheck="false" autocomplete="off">
          <button class="btn btn--dark" type="button" data-copy>${FL.icon('copy')}Másolás</button>
        </div>
        <p class="small muted">Bejelentkezés: <b>${user.email}</b>. Első belépéskor saját jelszót kell beállítania.</p>`,
      onOpen: ({ form }) => {
        const input = form.querySelector('#temp-pass');
        const btn = form.querySelector('[data-copy]');
        btn.focus();
        btn.addEventListener('click', async () => {
          ui.toast(await copyText(password, input) ? 'Jelszó a vágólapon.' : 'Nem sikerült másolni: jelöld ki és másold kézzel.', 'ok');
        });
      },
    });
  }

  // ================================================================ Felhasználók
  async function listTab(root, ctx) {
    const state = {
      filters: { q: ctx.query.get('q') || '', role_id: ctx.query.get('role_id') || '', active: ctx.query.get('active') || '' },
      roles: (await api.get('/api/roles')).items,
      users: [],
      total: 0,
    };
    const isAdmin = !!me().role.is_admin;
    frame(root, 'lista', {
      lead: 'A raktár és az iroda munkatársai. Mindenki egy szerepkört kap; a szerepkörök jogait a Jogosultságok fülön állítod be.',
      actions: can('create') ? html`<button class="btn btn--primary" type="button" data-action="new">${FL.icon('plus')}Új felhasználó</button>` : '',
      body: html`
        <section class="panel panel--flush">
          <form class="toolbar user-filters" data-filters novalidate>
            <div class="field field--grow"><label for="u-q">Keresés</label><input class="input" id="u-q" name="q" type="search" value="${state.filters.q}" placeholder="Név, e-mail vagy telefon" autocomplete="off"></div>
            ${ui.field({ name: 'role_id', label: 'Szerepkör', type: 'select', value: state.filters.role_id, placeholder: 'Mind', options: state.roles.map((r) => ({ value: r.id, label: r.name })), attrs: 'data-action="filter"' })}
            ${ui.field({ name: 'active', label: 'Állapot', type: 'select', value: state.filters.active, placeholder: 'Mind', options: [{ value: '1', label: 'Aktív' }, { value: '0', label: 'Letiltott' }], attrs: 'data-action="filter"' })}
          </form>
          <div class="slot" data-users></div>
        </section>`,
    });
    const $ = (s) => root.querySelector(s);
    $('[data-filters]').addEventListener('submit', (e) => e.preventDefault());
    const q = $('#u-q');
    q.addEventListener('input', FL.debounce(() => { state.filters.q = q.value.trim(); load(); }, 250));

    // What the signed-in user may do with this account (mirrors the server rules).
    const locked = (u) => u.is_admin && !isAdmin;
    const chips = (u) => html`
      ${u.active ? html`<span class="chip" data-tone="ok">Aktív</span>` : html`<span class="chip">Letiltva</span>`}
      ${u.locked ? html`<span class="chip" data-tone="warn">Zárolva</span>` : ''}
      ${u.active && u.must_change_password ? html`<span class="chip" data-tone="info">Jelszócsere vár</span>` : ''}`;
    const columns = [
      {
        key: 'name', label: 'Név', render: (u) => html`<button class="link-btn" type="button" data-action="edit" data-id="${u.id}">${u.name}</button>${u.id === me().id ? html` <span class="tag">te</span>` : ''}<span class="sub">${u.email}</span>`,
      },
      { key: 'role', label: 'Szerepkör', cls: 'nowrap', render: (u) => html`${u.is_admin ? FL.icon('shield-check', 'icon--inline') : ''}${u.role_name}` },
      { key: 'phone', label: 'Telefon', cls: 'nowrap', render: (u) => u.phone },
      { key: 'state', label: 'Állapot', render: chips },
      { key: 'last', label: 'Utolsó belépés', cls: 'nowrap', render: (u) => (u.last_login_at ? fmt.dateTime(u.last_login_at) : html`<span class="muted">még nem lépett be</span>`) },
      { key: 'sessions', label: 'Munkamenet', align: 'r', cls: 'num', render: (u) => fmt.int(u.sessions) },
      {
        key: 'act', label: 'Műveletek', cls: 'w-actions', render: (u) => {
          const self = u.id === me().id;
          const off = (cond, why) => (cond ? raw(`disabled title="${FL.esc(why)}"`) : '');
          const lockWhy = 'Adminisztrátor fiókját csak adminisztrátor módosíthatja';
          return html`<span class="row-actions">
            <button class="btn btn--sm btn--ghost btn--icon" type="button" data-action="edit" data-id="${u.id}" aria-label="${u.name} szerkesztése" title="Szerkesztés">${FL.icon(can('edit') && !locked(u) ? 'pencil-simple' : 'eye')}</button>
            ${can('edit') ? html`
              <button class="btn btn--sm btn--ghost btn--icon" type="button" data-action="reset" data-id="${u.id}" aria-label="Új ideiglenes jelszó: ${u.name}" title="Új ideiglenes jelszó" ${off(locked(u) || self, self ? 'A saját jelszavad a profil menüben módosíthatod' : lockWhy)}>${FL.icon('key')}</button>
              <button class="btn btn--sm btn--ghost btn--icon" type="button" data-action="logout" data-id="${u.id}" aria-label="${u.name} kijelentkeztetése mindenhonnan" title="Kijelentkeztetés mindenhonnan" ${off(locked(u) || !u.sessions, locked(u) ? lockWhy : 'Nincs aktív munkamenete')}>${FL.icon('sign-out')}</button>` : ''}
            ${can('delete') ? html`<button class="btn btn--sm btn--ghost btn--icon" type="button" data-action="delete" data-id="${u.id}" aria-label="${u.name} törlése" title="Törlés" ${off(locked(u) || self, self ? 'Saját magadat nem törölheted' : lockWhy)}>${FL.icon('trash')}</button>` : ''}
          </span>`;
        },
      },
    ];

    async function load() {
      history.replaceState(null, '', `${BASE}/lista${FL.qs(state.filters)}`);
      const res = await api.get('/api/users', state.filters);
      state.users = res.items;
      state.total = res.total;
      $('[data-users]').innerHTML = String(html`
        ${ui.table({ rows: state.users, columns, caption: 'Felhasználók', cls: 'user-table', rowAttrs: (u) => (u.active ? '' : 'class="is-inactive"'), empty: Object.values(state.filters).some(Boolean) ? 'Nincs a szűrésnek megfelelő felhasználó.' : 'Még nincs felhasználó.' })}
        ${ui.pager({ total: state.total, limit: 1000, offset: 0 })}`);
    }

    async function userDialog(id) {
      const u = id ? await api.get(`/api/users/${id}`) : null;
      const self = u && u.id === me().id;
      const readOnly = u ? !can('edit') || locked(u) : false;
      const ro = readOnly ? 'disabled' : '';
      const roleOpts = roleOptions(state.roles, { allowAdmin: isAdmin });
      ui.dialog({
        title: u ? u.name : 'Új felhasználó',
        submitLabel: u ? 'Mentés' : 'Létrehozás',
        hideSubmit: readOnly,
        cancelLabel: readOnly ? 'Bezárás' : 'Mégse',
        body: html`
          ${!u ? ui.notice('Mentés után egy ideiglenes jelszót mutatunk, egyszer. Első belépéskor a munkatársnak saját jelszót kell beállítania.', 'info') : ''}
          ${u && locked(u) ? ui.notice('Adminisztrátor fiókját csak adminisztrátor módosíthatja.', 'info', 'lock-simple') : ''}
          <div class="form-grid">
            ${ui.field({ name: 'name', label: 'Név', value: u && u.name, required: true, autocomplete: 'name', attrs: ro })}
            ${ui.field({ name: 'email', label: 'E-mail cím', type: 'email', value: u && u.email, required: true, hint: 'Ezzel lép be.', attrs: ro })}
            ${ui.field({ name: 'phone', label: 'Telefon', type: 'tel', value: u && u.phone, optional: true, attrs: ro })}
            ${ui.field({ name: 'role_id', label: 'Szerepkör', type: 'select', value: u ? u.role_id : '', required: true, options: roleOpts, placeholder: u ? undefined : 'Válassz szerepkört', attrs: ro })}
            ${u ? ui.field({ name: 'active', label: 'Aktív, beléphet', type: 'checkbox', value: u.active, span: 'all', attrs: self || readOnly ? 'disabled' : '', hint: self ? 'Saját magadat nem tilthatod le.' : 'Letiltáskor minden munkamenete azonnal megszűnik.' }) : ''}
          </div>
          ${u ? html`<div class="grid-2 user-facts">
            <section><h3>Bejelentkezések</h3>
              ${u.sessions.length ? html`<ul class="facts">${u.sessions.map((s) => html`<li><b>${fmt.dateTime(s.last_seen_at)}</b>${s.current ? ' (ez a munkamenet)' : ''}<span class="small muted">${s.ip || 'ismeretlen IP'}, ${String(s.user_agent || '').slice(0, 60)}</span></li>`)}</ul>`
                : html`<p class="small muted">Nincs aktív munkamenete.</p>`}
              <p class="small muted">Utolsó belépés: ${u.last_login_at ? fmt.dateTime(u.last_login_at) : 'még nem lépett be'}. Létrehozva: ${fmt.date(u.created_at)}.</p>
            </section>
            <section><h3>Legutóbbi tevékenység</h3>
              ${u.activity.length ? html`<ul class="facts">${u.activity.slice(0, 6).map((a) => html`<li><span>${a.summary}</span><span class="small muted">${fmt.dateTime(a.at)}</span></li>`)}</ul>`
                : html`<p class="small muted">Még nincs rögzített tevékenysége.</p>`}
              ${FL.can('settings', 'view') ? html`<a class="small" href="#/beallitasok/naplo?user_id=${u.id}">Teljes napló</a>` : ''}
            </section>
          </div>` : ''}`,
        onSubmit: async (form) => {
          const v = ui.formValues(form);
          v.role_id = v.role_id ? Number(v.role_id) : null;
          if (!u) {
            const res = await api.post('/api/users', v);
            await load();
            passwordDialog(res, res.password);
            return true;
          }
          const role = state.roles.find((r) => r.id === v.role_id);
          if (self && role && !role.is_admin && me().role.is_admin) {
            const ok = await ui.confirm({ title: 'Saját szerepkör', text: 'Ezzel elveszíted az adminisztrátori jogaidat. Folytatod?', confirmLabel: 'Igen, módosítom' });
            if (!ok) return false;
          }
          await api.patch(`/api/users/${u.id}`, v);
          ui.toast(`${v.name} mentve.`, 'ok');
          if (self) { location.reload(); return true; }
          await load();
          return true;
        },
      });
    }

    const find = (id) => state.users.find((x) => x.id === Number(id));
    ui.bind(root, {
      filter: (el) => { state.filters[el.name] = el.value; load(); },
      new: () => userDialog(null),
      edit: (el) => userDialog(Number(el.dataset.id)),
      reset: async (el) => {
        const u = find(el.dataset.id);
        if (!(await ui.confirm({ title: 'Új ideiglenes jelszó', text: `${u.name} jelenlegi jelszava érvényét veszti, és minden eszközről kijelentkeztetjük. Az új, ideiglenes jelszót egyszer mutatjuk meg.`, confirmLabel: 'Új jelszó kiadása' }))) return;
        await ui.run(el, async () => {
          const res = await api.post(`/api/users/${u.id}/reset-password`);
          passwordDialog(u, res.password);
          await load();
        });
      },
      logout: async (el) => {
        const u = find(el.dataset.id);
        const self = u.id === me().id;
        if (!(await ui.confirm({ title: 'Kijelentkeztetés', text: self ? 'Minden más eszközödön kijelentkeztetünk. Ez a munkamenet megmarad.' : `${u.name} minden eszközön ki lesz jelentkeztetve.`, confirmLabel: 'Kijelentkeztetés' }))) return;
        await ui.run(el, async () => {
          const res = await api.post(`/api/users/${u.id}/logout`);
          ui.toast(`${fmt.int(res.count)} munkamenet megszűnt.`, 'ok');
          await load();
        });
      },
      delete: async (el) => {
        const u = find(el.dataset.id);
        if (!(await ui.confirm({ title: 'Felhasználó törlése', text: `Biztosan törlöd ${u.name} (${u.email}) fiókját?`, confirmLabel: 'Törlés', tone: 'danger' }))) return;
        el.setAttribute('aria-busy', 'true');
        try {
          await api.del(`/api/users/${u.id}`);
          ui.toast(`${u.name} törölve.`, 'ok');
          await load();
        } catch (err) {
          if (err.status === 409 && u.active && can('edit') && /Tiltsd le/.test(err.message)) {
            if (await ui.confirm({ title: 'Letiltás törlés helyett', text: err.message, confirmLabel: 'Letiltás' })) {
              await ui.run(null, async () => { await api.patch(`/api/users/${u.id}`, { active: false }); ui.toast(`${u.name} letiltva.`, 'ok'); await load(); });
            }
          } else ui.toast(err.message, 'error');
        } finally {
          el.removeAttribute('aria-busy');
        }
      },
    });
    await load();
  }

  // ================================================================ Jogosultságok
  async function permissionsTab(root, ctx) {
    let roles = (await api.get('/api/roles')).items;
    const modules = FL.state.meta.modules;
    const valid = new Set(modules.flatMap((m) => Object.keys(m.actions).map((a) => `${m.key}:${a}`)));
    const want = Number(ctx.query.get('szerepkor'));
    let roleId = (roles.find((r) => r.id === want) || roles.find((r) => !r.is_admin) || roles[0]).id;
    const role = () => roles.find((r) => r.id === roleId);
    const saved = (r) => new Set(Object.entries(r.permissions).flatMap(([m, list]) => list.map((a) => `${m}:${a}`)));
    const current = () => drafts.get(roleId) || saved(role());
    const editable = () => can('edit') && !role().is_admin;
    const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
    const dirtyCount = () => {
      const d = drafts.get(roleId);
      if (!d) return 0;
      const s = saved(role());
      return [...d].filter((x) => !s.has(x)).length + [...s].filter((x) => !d.has(x)).length;
    };

    frame(root, 'jogosultsagok', {
      lead: 'Szerepkörönként, modulonként és műveletenként pipálod be, ki mit tehet. A változás a felhasználók következő kattintásától érvényes.',
      actions: can('create') ? html`<button class="btn" type="button" data-action="new-role">${FL.icon('plus')}Új szerepkör</button>` : '',
      body: html`
        <div class="role-tabs" role="tablist" aria-label="Szerepkörök" data-roles></div>
        <section class="panel panel--flush role-panel" id="role-panel" role="tabpanel" data-role-panel></section>
        <section class="panel panel--flush" aria-labelledby="ovw-title" data-overview></section>`,
    });
    const $ = (s) => root.querySelector(s);

    function paintRoleTabs() {
      $('[data-roles]').innerHTML = String(html`${roles.map((r) => html`
        <button class="role-tab" type="button" role="tab" id="role-tab-${r.id}" aria-controls="role-panel" aria-selected="${r.id === roleId}" tabindex="${r.id === roleId ? 0 : -1}" data-action="pick-role" data-id="${r.id}">
          ${r.is_admin ? FL.icon('lock-simple') : ''}<span>${r.name}</span><span class="count">${fmt.int(r.user_count)}</span>${drafts.has(r.id) ? html`<span class="dot" title="Mentetlen változás" aria-label="mentetlen változás"></span>` : ''}
        </button>`)}`);
      $('#role-panel').setAttribute('aria-labelledby', `role-tab-${roleId}`);
    }

    function cell(m, a) {
      const label = m.actions[a];
      if (!label) return html`<td class="na"><span class="visually-hidden">Ennél a modulnál nincs ${actionLabel(a).toLowerCase()}</span></td>`;
      return html`<td><label class="perm" title="${label}">
        <input type="checkbox" data-action="perm" data-m="${m.key}" data-a="${a}" aria-label="${m.name}: ${label}">
        <span>${label}</span></label></td>`;
    }

    function paintRolePanel() {
      const r = role();
      const ed = editable();
      $('[data-role-panel]').innerHTML = String(html`
        <div class="panel__head">
          <div class="role-head">
            <h2>${r.name}</h2>
            <p class="small muted">${r.description || 'Nincs leírás.'}</p>
          </div>
          <div class="actions">
            <a class="chip" href="${BASE}/lista?role_id=${r.id}">${fmt.int(r.user_count)} felhasználó</a>
            ${can('edit') && !r.is_admin ? html`<button class="btn btn--sm" type="button" data-action="edit-role">${FL.icon('pencil-simple')}Átnevezés</button>` : ''}
            ${can('delete') && !r.is_admin ? html`<button class="btn btn--sm btn--danger" type="button" data-action="delete-role" ${r.user_count ? raw('disabled title="Amíg felhasználó használja, nem törölhető"') : ''}>${FL.icon('trash')}Törlés</button>` : ''}
          </div>
        </div>
        ${r.is_admin ? html`<div class="panel__pad">${ui.notice('Az Adminisztrátor szerepkör mindenhez hozzáfér, és nem szerkeszthető. Legalább egy aktív adminisztrátornak mindig lennie kell.', 'info', 'lock-simple')}</div>`
          : !can('edit') ? html`<div class="panel__pad">${ui.notice('A jogosultságokat csak megtekintheted: a módosításhoz Felhasználók módosítása jog kell.', 'info', 'lock-simple')}</div>` : ''}
        <div class="table-wrap matrix-wrap"><table class="table matrix perm-matrix" ${ed ? '' : raw('data-readonly="true"')}>
          <caption class="visually-hidden">${r.name} jogosultságai: modulok soronként, műveletek oszloponként</caption>
          <thead>
            <tr><th scope="col">Modul</th>${ACTIONS.map((a) => html`<th scope="col">${actionLabel(a)}</th>`)}<th scope="col">Mind</th></tr>
            <tr class="matrix__toggles"><td class="small muted">Egész oszlop</td>${ACTIONS.map((a) => html`<td><input type="checkbox" data-action="col" data-a="${a}" aria-label="${actionLabel(a)} minden modulban"></td>`)}<td></td></tr>
          </thead>
          <tbody>${GROUPS.map(([g, gname]) => {
            const list = modules.filter((m) => m.group === g);
            if (!list.length) return '';
            return html`<tr class="group"><td colspan="${ACTIONS.length + 2}">${gname}</td></tr>
              ${list.map((m) => html`<tr data-module="${m.key}">
                <td class="matrix__module">${m.name}</td>
                ${ACTIONS.map((a) => cell(m, a))}
                <td><input type="checkbox" data-action="row" data-m="${m.key}" aria-label="${m.name}: minden művelet"></td>
              </tr>`)}`;
          })}</tbody>
        </table></div>
        ${ed ? html`<div class="savebar" data-savebar>
          <span class="savebar__state" aria-live="polite" data-state></span>
          <span class="savebar__spacer"></span>
          <button class="btn" type="button" data-action="discard">Elvetés</button>
          <button class="btn btn--primary" type="button" data-action="save">Mentés</button>
        </div>` : ''}`);
      sync();
    }

    // Puts the draft into the checkboxes (and the row and column toggles) without repainting,
    // so keyboard focus stays where it is.
    function sync() {
      const set = editable() ? current() : saved(role());
      const ed = editable();
      const panel = $('[data-role-panel]');
      panel.querySelectorAll('input[data-action="perm"]').forEach((el) => {
        el.checked = role().is_admin || set.has(`${el.dataset.m}:${el.dataset.a}`);
        el.disabled = !ed;
      });
      panel.querySelectorAll('input[data-action="row"]').forEach((el) => {
        const m = modules.find((x) => x.key === el.dataset.m);
        const acts = Object.keys(m.actions);
        const k = acts.filter((a) => role().is_admin || set.has(`${m.key}:${a}`)).length;
        el.checked = k === acts.length;
        el.indeterminate = k > 0 && k < acts.length;
        el.disabled = !ed;
      });
      panel.querySelectorAll('input[data-action="col"]').forEach((el) => {
        const mods = modules.filter((m) => m.actions[el.dataset.a]);
        const k = mods.filter((m) => role().is_admin || set.has(`${m.key}:${el.dataset.a}`)).length;
        el.checked = k === mods.length;
        el.indeterminate = k > 0 && k < mods.length;
        el.disabled = !ed;
      });
      const n = dirtyCount();
      if (!n && drafts.has(roleId)) drafts.delete(roleId);
      const state = panel.querySelector('[data-state]');
      if (state) {
        state.innerHTML = String(n ? html`<span class="chip" data-tone="warn">${fmt.int(n)} mentetlen változás</span>` : html`<span class="muted small">Nincs mentetlen változás.</span>`);
        panel.querySelector('[data-action="save"]').disabled = !n;
        panel.querySelector('[data-action="discard"]').disabled = !n;
      }
      const tab = $(`#role-tab-${roleId}`);
      if (tab) {
        const dot = tab.querySelector('.dot');
        if (n && !dot) tab.insertAdjacentHTML('beforeend', '<span class="dot" title="Mentetlen változás" aria-label="mentetlen változás"></span>');
        if (!n && dot) dot.remove();
      }
    }

    // Applies one change to the draft with the rule "any action needs view".
    function change(fn) {
      const set = new Set(current());
      fn(set);
      for (const m of modules) {
        const acts = Object.keys(m.actions);
        if (acts.some((a) => a !== 'view' && set.has(`${m.key}:${a}`))) set.add(`${m.key}:view`);
      }
      for (const p of [...set]) if (!valid.has(p)) set.delete(p);
      if (sameSet(set, saved(role()))) drafts.delete(roleId);
      else drafts.set(roleId, set);
      sync();
    }
    const clearRow = (set, mk) => { for (const a of ACTIONS) set.delete(`${mk}:${a}`); };

    function paintOverview() {
      $('[data-overview]').innerHTML = String(html`
        <div class="panel__head"><div>
          <h2 id="ovw-title">Áttekintés</h2>
          <p class="small muted">A mentett jogok szerepkörönként. ${ACTIONS.map((a) => html`<b class="mono">${SHORT[a]}</b> ${actionLabel(a).toLowerCase()}${a === 'approve' ? '.' : ', '}`)}</p>
        </div></div>
        <div class="table-wrap matrix-wrap"><table class="table matrix ovw-table">
          <caption class="visually-hidden">Szerepkörök jogosultságai modulonként</caption>
          <thead><tr><th scope="col">Modul</th>${roles.map((r) => html`<th scope="col" class="matrix__role">${r.name}</th>`)}</tr></thead>
          <tbody>${GROUPS.map(([g, gname]) => {
            const list = modules.filter((m) => m.group === g);
            if (!list.length) return '';
            return html`<tr class="group"><td colspan="${roles.length + 1}">${gname}</td></tr>
              ${list.map((m) => html`<tr><td class="matrix__module">${m.name}</td>${roles.map((r) => {
                const granted = r.permissions[m.key] || [];
                return html`<td><span class="ovw" aria-hidden="true">${ACTIONS.map((a) => (m.actions[a]
                  ? (granted.includes(a) ? html`<b title="${m.actions[a]}">${SHORT[a]}</b>` : html`<i>·</i>`)
                  : html`<i class="ovw__na"></i>`))}</span><span class="visually-hidden">${granted.length ? granted.map((a) => actionLabel(a)).join(', ') : 'nincs jog'}</span></td>`;
              })}</tr>`)}`;
          })}</tbody>
        </table></div>`);
    }

    function paintAll() {
      paintRoleTabs();
      paintRolePanel();
      paintOverview();
      history.replaceState(null, '', `${BASE}/jogosultsagok?szerepkor=${roleId}`);
    }

    async function reloadRoles(selectId) {
      roles = (await api.get('/api/roles')).items;
      if (selectId) roleId = selectId;
      if (!roles.some((r) => r.id === roleId)) roleId = (roles.find((r) => !r.is_admin) || roles[0]).id;
      paintAll();
    }

    function roleDialog(r) {
      ui.dialog({
        title: r ? `Szerepkör: ${r.name}` : 'Új szerepkör',
        size: 'narrow',
        submitLabel: r ? 'Mentés' : 'Létrehozás',
        body: html`
          ${ui.field({ name: 'name', label: 'Név', value: r && r.name, required: true, placeholder: 'Pl. Műszakvezető' })}
          ${ui.field({ name: 'description', label: 'Leírás', type: 'textarea', rows: 3, value: r && r.description, optional: true })}
          ${r ? '' : ui.field({ name: 'copy_from', label: 'Jogosultságok másolása', type: 'select', options: roles.map((x) => ({ value: x.id, label: x.name })), placeholder: 'Ne másoljon, üresen indul', optional: true, hint: 'A másolt jogokat utána szabadon módosíthatod.' })}`,
        onSubmit: async (form) => {
          const v = ui.formValues(form);
          if ('copy_from' in v) v.copy_from = v.copy_from ? Number(v.copy_from) : null;
          const res = r ? await api.patch(`/api/roles/${r.id}`, v) : await api.post('/api/roles', v);
          ui.toast(r ? 'Szerepkör mentve.' : `${res.name} szerepkör létrehozva. Most pipáld be a jogait.`, 'ok');
          await reloadRoles(res.id);
        },
      });
    }

    async function pickRole(id) {
      if (id === roleId) return;
      roleId = id;
      paintAll();
      const tab = $(`#role-tab-${roleId}`);
      if (tab) tab.focus();
    }

    ui.bind(root, {
      'pick-role': (el) => pickRole(Number(el.dataset.id)),
      perm: (el) => change((set) => {
        const key = `${el.dataset.m}:${el.dataset.a}`;
        if (el.checked) set.add(key);
        else if (el.dataset.a === 'view') clearRow(set, el.dataset.m);
        else set.delete(key);
      }),
      row: (el) => change((set) => {
        const m = modules.find((x) => x.key === el.dataset.m);
        if (el.checked) for (const a of Object.keys(m.actions)) set.add(`${m.key}:${a}`);
        else clearRow(set, m.key);
      }),
      col: (el) => change((set) => {
        const a = el.dataset.a;
        for (const m of modules.filter((x) => x.actions[a])) {
          if (el.checked) set.add(`${m.key}:${a}`);
          else if (a === 'view') clearRow(set, m.key);
          else set.delete(`${m.key}:${a}`);
        }
      }),
      discard: () => { drafts.delete(roleId); sync(); },
      save: (el) => ui.run(el, async () => {
        const set = current();
        const r = role();
        const mine = me().role.id === r.id;
        if (mine && FL.can('users', 'edit') && !set.has('users:edit')) {
          const ok = await ui.confirm({ title: 'Saját jogosultságod', text: 'A saját szerepkörödből veszed el a Felhasználók módosítása jogot. Mentés után ezt a képernyőt már nem tudod szerkeszteni, csak egy adminisztrátor adhatja vissza. Folytatod?', confirmLabel: 'Mentés így' });
          if (!ok) return;
        }
        const body = {};
        for (const m of modules) body[m.key] = Object.keys(m.actions).filter((a) => set.has(`${m.key}:${a}`));
        const res = await api.put(`/api/roles/${r.id}/permissions`, { permissions: body });
        drafts.delete(r.id);
        ui.toast(`${r.name}: ${res.added.length || res.removed.length ? `${fmt.int(res.added.length)} jog hozzáadva, ${fmt.int(res.removed.length)} elvéve` : 'nem változott semmi'}.`, 'ok');
        if (res.self) {
          const before = JSON.stringify(FL.state.permissions);
          const fresh = await api.get('/api/me');
          if (JSON.stringify(fresh.permissions) !== before) { location.reload(); return; }
        }
        await reloadRoles(r.id);
      }),
      'new-role': () => roleDialog(null),
      'edit-role': () => roleDialog(role()),
      'delete-role': async (el) => {
        const r = role();
        if (!(await ui.confirm({ title: 'Szerepkör törlése', text: `Biztosan törlöd a(z) ${r.name} szerepkört?`, confirmLabel: 'Törlés', tone: 'danger' }))) return;
        await ui.run(el, async () => {
          await api.del(`/api/roles/${r.id}`);
          drafts.delete(r.id);
          ui.toast(`${r.name} törölve.`, 'ok');
          await reloadRoles(null);
        });
      },
    });

    // Arrow keys move between the role tabs.
    $('[data-roles]').addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const i = roles.findIndex((r) => r.id === roleId);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? roles.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + roles.length) % roles.length;
      pickRole(roles[next].id);
    });

    const onUnload = (e) => { if (drafts.size) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', onUnload);
    paintAll();
    return {
      destroy() {
        window.removeEventListener('beforeunload', onUnload);
        if (drafts.size) ui.toast('A jogosultságok mentetlen változásai megmaradtak: a Jogosultságok fülön mentheted vagy elvetheted őket.', 'info');
      },
    };
  }

  // ================================================================ view
  const view = {
    title: 'Felhasználók',
    async render(root, ctx) {
      let tab = ctx.params[0];
      if (tab !== 'lista' && tab !== 'jogosultsagok') {
        tab = 'lista';
        history.replaceState(null, '', `${BASE}/${tab}`);
      }
      return tab === 'lista' ? listTab(root, ctx) : permissionsTab(root, ctx);
    },
  };
  // core/app.js (which defines FL.view) loads after the views; it keeps FL.views, so registering
  // there directly works in either order.
  if (typeof FL.view === 'function') FL.view('users', view);
  else (FL.views = FL.views || {}).users = view;
})();
