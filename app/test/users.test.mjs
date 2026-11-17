// Felhasználók: users with temporary passwords, roles, the permission matrix end to end, and the
// rules that keep at least one active administrator.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, ADMIN } from './helpers.mjs';

let srv;
let admin;
before(async () => {
  srv = await startServer();
  admin = await srv.admin();
  await srv.seedBasics();
});
after(async () => { await srv.stop(); });

// Signs in with the temporary password and sets a real one. Returns the client.
async function firstLogin(email, temp, next = 'uj-jelszo-12345') {
  const c = srv.client();
  const login = await c.post('/api/auth/login', { email, password: temp });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.equal(login.data.must_change_password, true);
  const blocked = await c.get('/api/settings/company');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.code, 'password_change_required');
  const changed = await c.post('/api/me/password', { current: temp, next });
  assert.equal(changed.status, 200);
  return c;
}

test('create user: temporary password shown once, must change it', async () => {
  const roles = (await admin.get('/api/roles')).data.items;
  const operator = roles.find((r) => r.key === 'warehouse_operator');
  const r = await admin.post('/api/users', { name: 'Kiss Anna', email: 'Anna.Kiss@example.com', phone: '+36 30 123 4567', role_id: operator.id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.password, /^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
  assert.equal(r.data.email, 'anna.kiss@example.com');
  assert.equal(r.data.must_change_password, true);
  assert.equal(r.data.password_hash, undefined);
  const list = await admin.get('/api/users');
  assert.ok(list.data.items.every((u) => u.password_hash === undefined));
  const anna = list.data.items.find((u) => u.email === 'anna.kiss@example.com');
  assert.equal(anna.role_name, 'Raktáros');
  assert.equal(anna.password, undefined, 'the password is never shown again');
  const dup = await admin.post('/api/users', { name: 'Másik Anna', email: 'ANNA.KISS@example.com', role_id: operator.id });
  assert.equal(dup.status, 409);
  assert.ok(dup.data.error.fields.email);
  const bad = await admin.post('/api/users', { name: '', email: 'x', role_id: 999 });
  assert.equal(bad.status, 400);

  const c = await firstLogin('anna.kiss@example.com', r.data.password);
  const me = await c.get('/api/me');
  assert.equal(me.data.user.must_change_password, false);
  assert.deepEqual(me.data.permissions.counts, ['view', 'edit']);
  const after = (await admin.get('/api/users?q=Kiss')).data.items[0];
  assert.ok(after.last_login_at);
  assert.equal((await admin.get('/api/users?active=0')).data.total, 0);
  assert.equal((await admin.get(`/api/users?role_id=${operator.id}`)).data.total, 1);
});

test('edit, deactivate (sessions end), reset password, sign out everywhere', async () => {
  const anna = (await admin.get('/api/users?q=anna.kiss')).data.items[0];
  const c = srv.client();
  await c.login('anna.kiss@example.com', 'uj-jelszo-12345');
  assert.equal((await c.get('/api/me')).status, 200);

  const edit = await admin.patch(`/api/users/${anna.id}`, { name: 'Kiss Anna Mária', phone: '' });
  assert.equal(edit.status, 200);
  assert.equal(edit.data.name, 'Kiss Anna Mária');
  const detail = await admin.get(`/api/users/${anna.id}`);
  assert.ok(detail.data.sessions.length >= 1);
  assert.ok(detail.data.activity.some((a) => a.action === 'login'));

  const off = await admin.patch(`/api/users/${anna.id}`, { active: false });
  assert.equal(off.status, 200);
  assert.equal(off.data.active, false);
  assert.equal((await c.get('/api/me')).status, 401);
  assert.equal((await srv.query('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', anna.id))[0].n, 0);
  const denied = await srv.client().post('/api/auth/login', { email: 'anna.kiss@example.com', password: 'uj-jelszo-12345' });
  assert.equal(denied.status, 400);
  await admin.patch(`/api/users/${anna.id}`, { active: true });

  await c.login('anna.kiss@example.com', 'uj-jelszo-12345');
  const reset = await admin.post(`/api/users/${anna.id}/reset-password`);
  assert.equal(reset.status, 200);
  assert.equal((await c.get('/api/me')).status, 401, 'sessions are signed out');
  assert.equal((await srv.client().post('/api/auth/login', { email: 'anna.kiss@example.com', password: 'uj-jelszo-12345' })).status, 400);
  const c2 = await firstLogin('anna.kiss@example.com', reset.data.password, 'harmadik-jelszo-1');

  const out = await admin.post(`/api/users/${anna.id}/logout`);
  assert.equal(out.status, 200);
  assert.equal(out.data.count, 1);
  assert.equal((await c2.get('/api/me')).status, 401);

  const audit = await srv.query("SELECT summary FROM audit_log WHERE module = 'users' AND entity = 'user' AND entity_id = ? ORDER BY id", String(anna.id));
  assert.ok(audit.some((a) => /letiltva/.test(a.summary)));
  assert.ok(audit.some((a) => /Ideiglenes jelszó/.test(a.summary)));
});

test('administrators: last one stays, only admins touch admin accounts, no self lockout', async () => {
  const me = (await admin.get('/api/me')).data.user;
  assert.equal((await admin.patch(`/api/users/${me.id}`, { active: false })).status, 409);
  const demote = await admin.patch(`/api/users/${me.id}`, { role_id: 2 });
  assert.equal(demote.status, 409);
  assert.match(demote.data.error.message, /Legalább egy aktív adminisztrátor/);
  assert.equal((await admin.del(`/api/users/${me.id}`)).status, 409);
  assert.equal((await admin.post(`/api/users/${me.id}/reset-password`)).status, 409);

  // A non-admin user manager cannot create or take over administrators.
  const role = await admin.post('/api/roles', { name: 'Felhasználókezelő' });
  await admin.put(`/api/roles/${role.data.id}/permissions`, { permissions: { users: ['view', 'create', 'edit', 'delete'] } });
  await srv.sql(`UPDATE roles SET key = 'user_manager' WHERE id = ${role.data.id}`);
  const um = await srv.userWithRole('user_manager');
  assert.equal((await um.post('/api/users', { name: 'Új Admin', email: 'ujadmin@example.com', role_id: 1 })).status, 403);
  assert.equal((await um.patch(`/api/users/${me.id}`, { name: 'Átvett' })).status, 403);
  assert.equal((await um.post(`/api/users/${me.id}/reset-password`)).status, 403);
  assert.equal((await um.post(`/api/users/${me.id}/logout`)).status, 403);
  assert.equal((await um.del(`/api/users/${me.id}`)).status, 403);
  const plain = await um.post('/api/users', { name: 'Nagy Béla', email: 'bela@example.com', role_id: 3 });
  assert.equal(plain.status, 200);
  assert.equal((await um.patch(`/api/users/${plain.data.id}`, { role_id: 1 })).status, 403);

  // With a second administrator the first one may step down.
  const second = await admin.post('/api/users', { name: 'Második Admin', email: 'admin2@example.com', role_id: 1 });
  assert.equal(second.status, 200);
  const demoteNow = await admin.patch(`/api/users/${me.id}`, { role_id: 2 });
  assert.equal(demoteNow.status, 200);
  await srv.sql(`UPDATE users SET role_id = 1 WHERE id = ${me.id}`);
});

test('delete: refused with history, allowed for unused accounts', async () => {
  const fresh = await admin.post('/api/users', { name: 'Próba Péter', email: 'proba@example.com', role_id: 4 });
  const c = await firstLogin('proba@example.com', fresh.data.password);
  assert.equal((await c.get('/api/me')).status, 200);
  const del = await admin.del(`/api/users/${fresh.data.id}`);
  assert.equal(del.status, 200, 'logging in and changing the own password is not history');
  assert.equal((await srv.query('SELECT COUNT(*) AS n FROM users WHERE id = ?', fresh.data.id))[0].n, 0);

  const worker = await admin.post('/api/users', { name: 'Munkás Márton', email: 'marton@example.com', role_id: 3 });
  await srv.call('stock.addStock', [{ productId: 1002, locationId: 21, qty: 1, type: 'inbound' }], { as: worker.data.id });
  const refused = await admin.del(`/api/users/${worker.data.id}`);
  assert.equal(refused.status, 409);
  assert.match(refused.data.error.message, /Tiltsd le inkább/);
  assert.equal((await admin.del('/api/users/9999')).status, 404);
});

test('roles: create with copy, rename, delete only when unused, admin role locked', async () => {
  const roles = (await admin.get('/api/roles')).data.items;
  const adminRole = roles.find((r) => r.is_admin);
  assert.ok(adminRole.permissions.settings.includes('delete'));
  assert.ok(roles.find((r) => r.key === 'warehouse_manager').user_count >= 0);
  const copy = await admin.post('/api/roles', { name: 'Éjszakai raktáros', description: 'Éjszakás műszak', copy_from: roles.find((r) => r.key === 'warehouse_operator').id });
  assert.equal(copy.status, 200, JSON.stringify(copy.data));
  assert.equal(copy.data.key, 'ejszakai_raktaros');
  assert.deepEqual(copy.data.permissions.counts, ['view', 'edit']);
  assert.equal((await admin.post('/api/roles', { name: 'éjszakai RAKTÁROS' })).status, 409);
  const fromAdmin = await admin.post('/api/roles', { name: 'Majdnem admin', copy_from: adminRole.id });
  assert.equal(fromAdmin.data.is_admin, false);
  assert.deepEqual(fromAdmin.data.permissions.users, ['view', 'create', 'edit', 'delete']);

  const ren = await admin.patch(`/api/roles/${copy.data.id}`, { name: 'Éjszakás raktáros' });
  assert.equal(ren.data.name, 'Éjszakás raktáros');
  assert.equal((await admin.patch(`/api/roles/${adminRole.id}`, { name: 'Főnök' })).status, 409);
  assert.equal((await admin.del(`/api/roles/${adminRole.id}`)).status, 409);
  assert.equal((await admin.put(`/api/roles/${adminRole.id}/permissions`, { permissions: {} })).status, 409);

  const u = await admin.post('/api/users', { name: 'Éjjeli Ede', email: 'ede@example.com', role_id: copy.data.id, active: false });
  const inUse = await admin.del(`/api/roles/${copy.data.id}`);
  assert.equal(inUse.status, 409);
  assert.match(inUse.data.error.message, /1 felhasználó/);
  await admin.patch(`/api/users/${u.data.id}`, { role_id: 3 });
  assert.equal((await admin.del(`/api/roles/${copy.data.id}`)).status, 200);
  assert.equal((await srv.query('SELECT COUNT(*) AS n FROM role_permissions WHERE role_id = ?', copy.data.id))[0].n, 0);
  await admin.del(`/api/roles/${fromAdmin.data.id}`);
});

test('permission matrix: validation, implied view, diff audit, applies on the next request', async () => {
  const role = await admin.post('/api/roles', { name: 'Ellenőr', description: 'Csak beállítások' });
  const id = role.data.id;
  const invalid = await admin.put(`/api/roles/${id}/permissions`, { permissions: { orders: ['approve'], nincs: ['view'] } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.data.error.message, /Érvénytelen jogosultság/);
  assert.equal((await admin.put(`/api/roles/${id}/permissions`, { permissions: ['settings:view'] })).status, 400);

  const set1 = await admin.put(`/api/roles/${id}/permissions`, { permissions: { settings: ['edit'], users: [] } });
  assert.equal(set1.status, 200, JSON.stringify(set1.data));
  assert.deepEqual(set1.data.permissions.settings, ['view', 'edit'], 'edit implies view');
  assert.deepEqual(set1.data.added, ['settings:view', 'settings:edit']);

  // A user of the role, signed in with the temporary password.
  const u = await admin.post('/api/users', { name: 'Ellenőr Elza', email: 'elza@example.com', role_id: id });
  const c = await firstLogin('elza@example.com', u.data.password);
  assert.equal((await c.get('/api/settings/company')).status, 200);
  assert.equal((await c.put('/api/settings/warehouse', { cutoff: '14:00', open: '06:00', close: '18:00', workdays: [1, 2, 3, 4, 5] })).status, 200);
  assert.equal((await c.post('/api/settings/sizes', { code: 'ELZA', name: 'Elza mérete' })).status, 403);
  assert.equal((await c.get('/api/users')).status, 403);
  assert.equal((await c.get('/api/roles')).status, 403);
  assert.equal((await c.get('/api/settings/audit')).status, 200);

  // Change the matrix: the same session gets the new rights on its next request.
  const set2 = await admin.put(`/api/roles/${id}/permissions`, { permissions: { settings: ['view', 'create'], users: ['view'] } });
  assert.deepEqual(set2.data.added, ['settings:create', 'users:view']);
  assert.deepEqual(set2.data.removed, ['settings:edit']);
  assert.equal((await c.post('/api/settings/sizes', { code: 'ELZA', name: 'Elza mérete' })).status, 200);
  assert.equal((await c.put('/api/settings/warehouse', { cutoff: '14:00', workdays: [1] })).status, 403);
  assert.equal((await c.get('/api/users')).status, 200);
  assert.equal((await c.get('/api/roles')).status, 200);
  assert.equal((await c.post('/api/users', { name: 'X', email: 'x@example.com', role_id: 3 })).status, 403);
  assert.equal((await c.put(`/api/roles/${id}/permissions`, { permissions: {} })).status, 403);
  const me = await c.get('/api/me');
  assert.deepEqual(me.data.permissions.settings, ['view', 'create']);

  const [entry] = await srv.query("SELECT summary, details FROM audit_log WHERE entity = 'role' AND entity_id = ? ORDER BY id DESC LIMIT 1", String(id));
  assert.match(entry.summary, /Ellenőr \(2 új, 1 elvéve\)/);
  assert.deepEqual(JSON.parse(entry.details), { added: ['settings:create', 'users:view'], removed: ['settings:edit'] });

  // Saving the same matrix again changes and logs nothing.
  const before = (await srv.query('SELECT COUNT(*) AS n FROM audit_log'))[0].n;
  const same = await admin.put(`/api/roles/${id}/permissions`, { permissions: { settings: ['view', 'create'], users: ['view'] } });
  assert.deepEqual([same.data.added, same.data.removed], [[], []]);
  assert.equal((await srv.query('SELECT COUNT(*) AS n FROM audit_log'))[0].n, before);

  // Clearing everything leaves the user with no module.
  await admin.put(`/api/roles/${id}/permissions`, { permissions: {} });
  assert.equal((await c.get('/api/settings/company')).status, 403);
  assert.equal((await c.get('/api/me')).status, 200);
});

test('permissions: view only cannot change users or roles; no users right is 403', async () => {
  const manager = await srv.userWithRole('warehouse_manager'); // users: view
  assert.equal((await manager.get('/api/users')).status, 200);
  assert.equal((await manager.get('/api/roles')).status, 200);
  const anyone = (await manager.get('/api/users')).data.items.find((u) => !u.is_admin);
  assert.equal((await manager.get(`/api/users/${anyone.id}`)).status, 200);
  assert.equal((await manager.post('/api/users', { name: 'X', email: 'xx@example.com', role_id: 3 })).status, 403);
  assert.equal((await manager.patch(`/api/users/${anyone.id}`, { name: 'X' })).status, 403);
  assert.equal((await manager.post(`/api/users/${anyone.id}/reset-password`)).status, 403);
  assert.equal((await manager.post(`/api/users/${anyone.id}/logout`)).status, 403);
  assert.equal((await manager.del(`/api/users/${anyone.id}`)).status, 403);
  assert.equal((await manager.post('/api/roles', { name: 'X' })).status, 403);
  assert.equal((await manager.patch('/api/roles/3', { name: 'X' })).status, 403);
  assert.equal((await manager.del('/api/roles/3')).status, 403);
  const put = await manager.put('/api/roles/3/permissions', { permissions: {} });
  assert.equal(put.status, 403);
  assert.match(put.data.error.message, /Felhasználók: felhasználók és jogosultságok módosítása/);

  const sales = await srv.userWithRole('sales');
  for (const path of ['/api/users', '/api/users/1', '/api/roles']) assert.equal((await sales.get(path)).status, 403, path);
  assert.equal(ADMIN.email, 'admin@example.com');
});
