// Felhasználók: users, roles, permission matrix. Prefix /api/users and /api/roles
//
//   GET  POST  /api/users                       list (filters q, role_id, active), create with a temporary password
//   GET  PATCH DELETE /api/users/:id            detail (sessions, recent activity), edit, delete
//   POST       /api/users/:id/reset-password    new temporary password, must change it, sessions signed out
//   POST       /api/users/:id/logout            signs out every session of the user
//   GET  POST  /api/roles                       roles with user counts and permissions, create (optionally copy)
//   PATCH DELETE /api/roles/:id                 name and description, delete when unused
//   PUT        /api/roles/:id/permissions       replaces the role's rows in role_permissions
//
// Rules: the administrator role (is_admin) has every right and cannot be edited or deleted; there is
// always at least one active administrator; only an administrator may give the administrator role
// or touch an administrator's account (otherwise "users edit" could take over the admin account by
// resetting its password). Sessions read the permissions on every request, so matrix changes apply
// on the next request of the affected users.

import { all, batch, first, run, setClause, stmt } from '../lib/db.js';
import { badRequest, conflict, forbidden, notFound, page } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { hashPassword, passwordProblem } from '../lib/auth.js';
import { isValidPermission, MODULES } from '../lib/perm.js';
import { nowIso } from '../lib/time.js';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Temporary password: three groups of four characters without look-alikes (l, 1, I, O, 0),
// about 70 bits of randomness. "k7Qm-xP3d-Wn9a"
export function temporaryPassword() {
  const out = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < 12) {
    for (const b of crypto.getRandomValues(new Uint8Array(24))) {
      if (b < limit && out.length < 12) out.push(ALPHABET[b % ALPHABET.length]);
    }
  }
  return `${out.slice(0, 4).join('')}-${out.slice(4, 8).join('')}-${out.slice(8).join('')}`;
}

const ALL_PERMISSIONS = MODULES.flatMap((m) => Object.keys(m.actions).map((a) => `${m.key}:${a}`));
const MODULE_ORDER = new Map(MODULES.map((m, i) => [m.key, i]));
const ACTION_ORDER = ['view', 'create', 'edit', 'delete', 'approve'];

// { module: [actions] } from "module:action" strings, in matrix order.
export function permissionObject(list) {
  const out = Object.fromEntries(MODULES.map((m) => [m.key, []]));
  for (const p of list) {
    const [m, a] = p.split(':');
    if (out[m] && !out[m].includes(a)) out[m].push(a);
  }
  for (const k of Object.keys(out)) out[k].sort((x, y) => ACTION_ORDER.indexOf(x) - ACTION_ORDER.indexOf(y));
  return out;
}

// Validates { module: [actions] } and applies "every action implies view". Returns sorted
// "module:action" strings or throws 400.
export function normalizePermissions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('A jogosultságokat modulonként, műveletlistaként várjuk.');
  const set = new Set();
  const invalid = [];
  for (const [module, actions] of Object.entries(input)) {
    if (!Array.isArray(actions)) { invalid.push(module); continue; }
    for (const a of actions) {
      if (typeof a === 'string' && isValidPermission(module, a)) set.add(`${module}:${a}`);
      else invalid.push(`${module}:${a}`);
    }
  }
  if (invalid.length) throw badRequest(`Érvénytelen jogosultság: ${invalid.slice(0, 5).join(', ')}.`);
  for (const p of [...set]) set.add(`${p.split(':')[0]}:view`);
  return [...set].sort((x, y) => {
    const [mx, ax] = x.split(':');
    const [my, ay] = y.split(':');
    return (MODULE_ORDER.get(mx) - MODULE_ORDER.get(my)) || (ACTION_ORDER.indexOf(ax) - ACTION_ORDER.indexOf(ay));
  });
}

// "Kulcs Elek" -> "kulcs_elek"
function slug(text) {
  const s = String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  return s || 'szerepkor';
}

const huSort = (a, b) => a.localeCompare(b, 'hu', { sensitivity: 'base' });

const USER_SELECT = `
  SELECT u.id, u.email, u.name, u.phone, u.role_id, r.name AS role_name, r.key AS role_key, r.is_admin, u.active,
         u.must_change_password, u.locked_until, u.last_login_at, u.created_at, u.updated_at,
         (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions
  FROM users u JOIN roles r ON r.id = u.role_id`;

const shapeUser = (u) => ({
  ...u,
  is_admin: !!u.is_admin,
  active: !!u.active,
  must_change_password: !!u.must_change_password,
  locked: !!(u.locked_until && Date.parse(u.locked_until) > Date.now()),
});

async function userRow(db, id) {
  const u = await first(db, `${USER_SELECT} WHERE u.id = ?`, nowIso(), id);
  return u ? shapeUser(u) : null;
}

const activeAdmins = async (db) =>
  (await first(db, 'SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.is_admin = 1 AND u.active = 1')).n;

// Only an administrator may change an administrator's account.
function guardAdminTarget(ctx, target) {
  if (target.is_admin && !ctx.user.is_admin) throw forbidden('Adminisztrátor fiókját csak adminisztrátor módosíthatja.');
}

async function roleFor(db, id) {
  const role = await first(db, 'SELECT * FROM roles WHERE id = ?', id);
  if (!role) throw badRequest('Ellenőrizd a megjelölt mezőket.', { role_id: 'Ismeretlen szerepkör.' });
  return role;
}

async function rolesList(db) {
  const roles = await all(db, `SELECT r.*, COUNT(u.id) AS user_count, COALESCE(SUM(u.active), 0) AS active_user_count
    FROM roles r LEFT JOIN users u ON u.role_id = r.id GROUP BY r.id ORDER BY r.is_admin DESC, r.id`);
  const perms = await all(db, 'SELECT role_id, module, action FROM role_permissions');
  const byRole = new Map();
  for (const p of perms) {
    if (!isValidPermission(p.module, p.action)) continue;
    if (!byRole.has(p.role_id)) byRole.set(p.role_id, []);
    byRole.get(p.role_id).push(`${p.module}:${p.action}`);
  }
  return roles.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    is_admin: !!r.is_admin,
    created_at: r.created_at,
    user_count: r.user_count,
    active_user_count: r.active_user_count,
    permissions: permissionObject(r.is_admin ? ALL_PERMISSIONS : byRole.get(r.id) || []),
  }));
}

// Role names are unique regardless of case, accented letters included (SQLite NOCASE folds ASCII only).
async function roleNameTaken(db, name, exceptId = 0) {
  const key = name.toLocaleLowerCase('hu');
  return (await all(db, 'SELECT id, name FROM roles WHERE id <> ?', exceptId)).some((r) => r.name.toLocaleLowerCase('hu') === key);
}

const USER_FIELDS = {
  name: { type: 'str', required: true, max: 120 },
  email: { type: 'email', required: true },
  phone: { type: 'str', max: 40, default: '' },
  role_id: { type: 'id', required: true },
  active: { type: 'bool', default: true },
};

const ROLE_FIELDS = {
  name: { type: 'str', required: true, max: 80 },
  description: { type: 'text', max: 500, default: '' },
};

export function register(r) {
  // ---------------------------------------------------------------- users
  r.get('/api/users', async (ctx) => {
    const db = ctx.env.DB;
    const where = [];
    const args = [nowIso()];
    const q = (ctx.query.get('q') || '').trim();
    if (q) { where.push('(u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const role = Number(ctx.query.get('role_id'));
    if (Number.isInteger(role) && role > 0) { where.push('u.role_id = ?'); args.push(role); }
    const active = ctx.query.get('active');
    if (active === '1' || active === '0') { where.push('u.active = ?'); args.push(Number(active)); }
    const rows = await all(db, `${USER_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, ...args);
    const items = rows.map(shapeUser).sort((a, b) => (b.active - a.active) || huSort(a.name, b.name));
    const { limit, offset } = page(ctx.query, 200, 1000);
    return { items: items.slice(offset, offset + limit), total: items.length };
  }, { perm: ['users', 'view'] });

  r.get('/api/users/:id', async (ctx) => {
    const db = ctx.env.DB;
    const user = await userRow(db, Number(ctx.params.id));
    if (!user) throw notFound('A felhasználó nem található.');
    const sessions = await all(db, `SELECT created_at, last_seen_at, expires_at, ip, user_agent, token_hash = ? AS current
      FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC`, ctx.user.session_hash || '', user.id, nowIso());
    const activity = await all(db, 'SELECT id, at, module, action, entity, entity_id, summary FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 20', user.id);
    return { ...user, sessions: sessions.map((s) => ({ ...s, current: !!s.current })), activity };
  }, { perm: ['users', 'view'] });

  r.post('/api/users', async (ctx) => {
    const db = ctx.env.DB;
    const data = validate(await ctx.body(), USER_FIELDS);
    const role = await roleFor(db, data.role_id);
    if (role.is_admin && !ctx.user.is_admin) throw forbidden('Adminisztrátor szerepkört csak adminisztrátor adhat.');
    if (await first(db, 'SELECT id FROM users WHERE email = ?', data.email)) {
      throw conflict('Ezzel az e-mail címmel már van felhasználó.', { email: 'Ezzel az e-mail címmel már van felhasználó.' });
    }
    const password = temporaryPassword();
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    const res = await run(db, `INSERT INTO users (email, name, phone, role_id, password_hash, active, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`, data.email, data.name, data.phone, role.id, await hashPassword(password), data.active, nowIso(), nowIso());
    const id = res.meta.last_row_id;
    await audit(ctx, { module: 'users', action: 'create', entity: 'user', entityId: id, summary: `Felhasználó létrehozva: ${data.name} (${data.email}), ${role.name}` });
    return { ...(await userRow(db, id)), password };
  }, { perm: ['users', 'create'] });

  r.patch('/api/users/:id', async (ctx) => {
    const db = ctx.env.DB;
    const id = Number(ctx.params.id);
    const target = await userRow(db, id);
    if (!target) throw notFound('A felhasználó nem található.');
    guardAdminTarget(ctx, target);
    const data = validate(await ctx.body(), USER_FIELDS, { partial: true });
    const self = id === ctx.user.id;
    let role = null;
    if (data.role_id !== undefined && data.role_id !== target.role_id) {
      role = await roleFor(db, data.role_id);
      if (role.is_admin && !ctx.user.is_admin) throw forbidden('Adminisztrátor szerepkört csak adminisztrátor adhat.');
    }
    if (data.active === false && self) throw conflict('Saját magadat nem tilthatod le.');
    if (data.email !== undefined && data.email !== target.email.toLowerCase()) {
      if (await first(db, 'SELECT id FROM users WHERE email = ? AND id <> ?', data.email, id)) {
        throw conflict('Ezzel az e-mail címmel már van felhasználó.', { email: 'Ezzel az e-mail címmel már van felhasználó.' });
      }
    }
    const willBeAdmin = role ? !!role.is_admin : target.is_admin;
    const willBeActive = data.active !== undefined ? data.active : target.active;
    if (target.is_admin && target.active && !(willBeAdmin && willBeActive) && (await activeAdmins(db)) <= 1) {
      throw conflict('Legalább egy aktív adminisztrátornak maradnia kell. Előbb adj adminisztrátor szerepkört valaki másnak.');
    }
    const before = { name: target.name, email: target.email, phone: target.phone, role_id: target.role_id, active: target.active };
    const changes = {};
    for (const k of Object.keys(data)) if (JSON.stringify(before[k]) !== JSON.stringify(data[k])) changes[k] = [before[k], data[k]];
    if (!Object.keys(changes).length) return target;
    const upd = Object.fromEntries(Object.keys(changes).map((k) => [k, data[k]]));
    const { sql, args } = setClause({ ...upd, updated_at: nowIso() });
    const statements = [stmt(db, `UPDATE users SET ${sql} WHERE id = ?`, ...args, id)];
    if (changes.active && !data.active) statements.push(stmt(db, 'DELETE FROM sessions WHERE user_id = ?', id));
    await batch(db, statements);
    const row = await userRow(db, id);
    if (changes.role_id) changes.role_id = [target.role_name, row.role_name];
    const what = changes.active ? (data.active ? 'engedélyezve' : 'letiltva') : 'módosítva';
    await audit(ctx, { module: 'users', action: 'edit', entity: 'user', entityId: id, summary: `Felhasználó ${what}: ${row.name}`, details: { changes } });
    return row;
  }, { perm: ['users', 'edit'] });

  r.post('/api/users/:id/reset-password', async (ctx) => {
    const db = ctx.env.DB;
    const id = Number(ctx.params.id);
    const target = await userRow(db, id);
    if (!target) throw notFound('A felhasználó nem található.');
    guardAdminTarget(ctx, target);
    if (id === ctx.user.id) throw conflict('A saját jelszavadat a profil menüben, a Jelszó módosítása pontban változtathatod meg.');
    const password = temporaryPassword();
    await batch(db, [
      stmt(db, 'UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?',
        await hashPassword(password), nowIso(), id),
      stmt(db, 'DELETE FROM sessions WHERE user_id = ?', id),
    ]);
    await audit(ctx, { module: 'users', action: 'edit', entity: 'user', entityId: id, summary: `Ideiglenes jelszó kiadva: ${target.name}` });
    return { password };
  }, { perm: ['users', 'edit'] });

  r.post('/api/users/:id/logout', async (ctx) => {
    const db = ctx.env.DB;
    const id = Number(ctx.params.id);
    const target = await userRow(db, id);
    if (!target) throw notFound('A felhasználó nem található.');
    guardAdminTarget(ctx, target);
    // Your own current session stays, the others go.
    const res = id === ctx.user.id
      ? await run(db, 'DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', id, ctx.user.session_hash || '')
      : await run(db, 'DELETE FROM sessions WHERE user_id = ?', id);
    const count = res.meta.changes || 0;
    await audit(ctx, { module: 'users', action: 'edit', entity: 'user', entityId: id, summary: `Kijelentkeztetve minden eszközről: ${target.name} (${count} munkamenet)` });
    return { count };
  }, { perm: ['users', 'edit'] });

  r.delete('/api/users/:id', async (ctx) => {
    const db = ctx.env.DB;
    const id = Number(ctx.params.id);
    const target = await userRow(db, id);
    if (!target) throw notFound('A felhasználó nem található.');
    guardAdminTarget(ctx, target);
    if (id === ctx.user.id) throw conflict('Saját magadat nem törölheted.');
    if (target.is_admin && target.active && (await activeAdmins(db)) <= 1) throw conflict('Az utolsó aktív adminisztrátor nem törölhető.');
    // Work recorded by the user (beyond logging in and changing their own password): keep the
    // account for the history and deactivate it instead.
    const history = (await first(db, `SELECT
        (SELECT COUNT(*) FROM audit_log WHERE user_id = ? AND action <> 'login' AND NOT (entity = 'user' AND entity_id = ?)) +
        (SELECT COUNT(*) FROM movements WHERE user_id = ?) AS n`, id, String(id), id)).n;
    if (history > 0) {
      throw conflict(`${target.name} már rögzített műveleteket (${history}). Tiltsd le inkább, így a napló és a mozgások megőrzik, ki végezte őket.`);
    }
    await run(db, 'DELETE FROM users WHERE id = ?', id);
    await audit(ctx, { module: 'users', action: 'delete', entity: 'user', entityId: id, summary: `Felhasználó törölve: ${target.name} (${target.email})` });
    return { ok: true };
  }, { perm: ['users', 'delete'] });

  // ---------------------------------------------------------------- roles
  r.get('/api/roles', async (ctx) => ({ items: await rolesList(ctx.env.DB) }), { perm: ['users', 'view'] });

  r.post('/api/roles', async (ctx) => {
    const db = ctx.env.DB;
    const body = await ctx.body();
    const data = validate(body, { ...ROLE_FIELDS, copy_from: { type: 'id', nullable: true } });
    if (await roleNameTaken(db, data.name)) {
      throw conflict('Ilyen nevű szerepkör már van.', { name: 'Ilyen nevű szerepkör már van.' });
    }
    let copy = [];
    let source = null;
    if (data.copy_from) {
      source = await first(db, 'SELECT * FROM roles WHERE id = ?', data.copy_from);
      if (!source) throw badRequest('Ellenőrizd a megjelölt mezőket.', { copy_from: 'Ismeretlen szerepkör.' });
      copy = source.is_admin ? ALL_PERMISSIONS
        : (await all(db, 'SELECT module, action FROM role_permissions WHERE role_id = ?', source.id)).map((p) => `${p.module}:${p.action}`).filter((p) => ALL_PERMISSIONS.includes(p));
    }
    const base = slug(data.name);
    let key = base;
    for (let i = 2; await first(db, 'SELECT id FROM roles WHERE key = ?', key); i++) key = `${base}_${i}`;
    const res = await run(db, 'INSERT INTO roles (key, name, description, is_admin) VALUES (?, ?, ?, 0)', key, data.name, data.description);
    const id = res.meta.last_row_id;
    if (copy.length) {
      await run(db, `INSERT INTO role_permissions (role_id, module, action)
        SELECT ?, substr(value, 1, instr(value, ':') - 1), substr(value, instr(value, ':') + 1) FROM json_each(?)`, id, JSON.stringify(copy));
    }
    await audit(ctx, {
      module: 'users', action: 'create', entity: 'role', entityId: id,
      summary: `Szerepkör létrehozva: ${data.name}${source ? ` (${source.name} jogosultságaival)` : ''}`,
      details: copy.length ? { permissions: copy } : null,
    });
    return (await rolesList(db)).find((x) => x.id === id);
  }, { perm: ['users', 'create'] });

  r.patch('/api/roles/:id', async (ctx) => {
    const db = ctx.env.DB;
    const id = Number(ctx.params.id);
    const role = await first(db, 'SELECT * FROM roles WHERE id = ?', id);
    if (!role) throw notFound('A szerepkör nem található.');
    if (role.is_admin) throw conflict('Az Adminisztrátor szerepkör nem módosítható.');
    const data = validate(await ctx.body(), ROLE_FIELDS, { partial: true });
    if (data.name !== undefined && await roleNameTaken(db, data.name, id)) {
      throw conflict('Ilyen nevű szerepkör már van.', { name: 'Ilyen nevű szerepkör már van.' });
    }
    const changes = {};
    for (const k of Object.keys(data)) if (role[k] !== data[k]) changes[k] = [role[k], data[k]];
    if (Object.keys(changes).length) {
      const { sql, args } = setClause(Object.fromEntries(Object.keys(changes).map((k) => [k, data[k]])));
      await run(db, `UPDATE roles SET ${sql} WHERE id = ?`, ...args, id);
      await audit(ctx, { module: 'users', action: 'edit', entity: 'role', entityId: id, summary: `Szerepkör módosítva: ${data.name || role.name}`, details: { changes } });
    }
    return (await rolesList(db)).find((x) => x.id === id);
  }, { perm: ['users', 'edit'] });

  r.delete('/api/roles/:id', async (ctx) => {
    const db = ctx.env.DB;
    const id = Number(ctx.params.id);
    const role = await first(db, 'SELECT * FROM roles WHERE id = ?', id);
    if (!role) throw notFound('A szerepkör nem található.');
    if (role.is_admin) throw conflict('Az Adminisztrátor szerepkör nem törölhető.');
    const n = (await first(db, 'SELECT COUNT(*) AS n FROM users WHERE role_id = ?', id)).n;
    if (n) throw conflict(`Ezt a szerepkört ${n} felhasználó használja (a letiltottakat is beleértve). Előbb tedd át őket másik szerepkörbe.`);
    await batch(db, [stmt(db, 'DELETE FROM role_permissions WHERE role_id = ?', id), stmt(db, 'DELETE FROM roles WHERE id = ?', id)]);
    await audit(ctx, { module: 'users', action: 'delete', entity: 'role', entityId: id, summary: `Szerepkör törölve: ${role.name}` });
    return { ok: true };
  }, { perm: ['users', 'delete'] });

  r.put('/api/roles/:id/permissions', async (ctx) => {
    const db = ctx.env.DB;
    const id = Number(ctx.params.id);
    const role = await first(db, 'SELECT * FROM roles WHERE id = ?', id);
    if (!role) throw notFound('A szerepkör nem található.');
    if (role.is_admin) throw conflict('Az Adminisztrátor szerepkör mindenhez hozzáfér, a jogosultságai nem módosíthatók.');
    const next = normalizePermissions((await ctx.body()).permissions);
    const current = (await all(db, 'SELECT module, action FROM role_permissions WHERE role_id = ?', id)).map((p) => `${p.module}:${p.action}`);
    const added = next.filter((p) => !current.includes(p));
    const removed = current.filter((p) => !next.includes(p));
    if (added.length || removed.length) {
      await batch(db, [
        stmt(db, 'DELETE FROM role_permissions WHERE role_id = ?', id),
        stmt(db, `INSERT INTO role_permissions (role_id, module, action)
          SELECT ?, substr(value, 1, instr(value, ':') - 1), substr(value, instr(value, ':') + 1) FROM json_each(?)`, id, JSON.stringify(next)),
      ]);
      await audit(ctx, {
        module: 'users', action: 'edit', entity: 'role', entityId: id,
        summary: `Jogosultságok módosítva: ${role.name} (${added.length} új, ${removed.length} elvéve)`,
        details: { added, removed },
      });
    }
    const self = ctx.user.role_id === id;
    return { ...(await rolesList(db)).find((x) => x.id === id), added, removed, self };
  }, { perm: ['users', 'edit'] });
}
