import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, ADMIN, SETUP_TOKEN } from './helpers.mjs';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

test('first run: setup needs the token, then is closed', async () => {
  const c = srv.client();
  assert.deepEqual((await c.get('/api/setup')).data, { needsSetup: true, tokenConfigured: true });
  const bad = await c.post('/api/setup', { token: 'wrong', ...ADMIN });
  assert.equal(bad.status, 403);
  const weak = await c.post('/api/setup', { token: SETUP_TOKEN, ...ADMIN, password: 'rovid' });
  assert.equal(weak.status, 400);
  const ok = await c.post('/api/setup', { token: SETUP_TOKEN, ...ADMIN });
  assert.equal(ok.status, 200);
  assert.equal((await c.get('/api/setup')).data.needsSetup, false);
  const again = await c.post('/api/setup', { token: SETUP_TOKEN, ...ADMIN, email: 'masik@example.com' });
  assert.equal(again.status, 409);
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.user.role.is_admin, true);
  assert.ok(me.data.permissions.users.includes('edit'));
});

test('session: 401 without cookie, login, logout', async () => {
  const c = srv.client();
  assert.equal((await c.get('/api/me')).status, 401);
  const wrong = await c.post('/api/auth/login', { email: ADMIN.email, password: 'rossz-jelszo-1' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error.message, /Hibás e-mail cím vagy jelszó/);
  await c.login(ADMIN.email.toUpperCase(), ADMIN.password);
  assert.equal((await c.get('/api/me')).status, 200);
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/me')).status, 401);
});

test('csrf: state changes need the app header and same origin', async () => {
  const c = srv.client();
  await c.login(ADMIN.email, ADMIN.password);
  const noHeader = await c.request('PATCH', '/api/me', { name: 'X' }, { headers: { 'x-requested-with': '' } });
  assert.equal(noHeader.status, 403);
  const otherOrigin = await c.request('PATCH', '/api/me', { name: 'X' }, { headers: { origin: 'https://evil.example' } });
  assert.equal(otherOrigin.status, 403);
  const ok = await c.patch('/api/me', { name: 'Teszt Admin' });
  assert.equal(ok.status, 200);
});

test('lockout after five wrong passwords', async () => {
  await srv.sql(`INSERT INTO users (email, name, role_id, password_hash) VALUES ('zar@example.com', 'Zár Teszt', 3, 'pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$x')`);
  const c = srv.client();
  for (let i = 0; i < 5; i++) await c.post('/api/auth/login', { email: 'zar@example.com', password: 'rossz-jelszo-1' });
  const r = await c.post('/api/auth/login', { email: 'zar@example.com', password: 'rossz-jelszo-1' });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.match(r.data.error.message, /Túl sok sikertelen/);
});

test('meta lists modules and statuses', async () => {
  const c = await srv.admin();
  const r = await c.get('/api/meta');
  assert.equal(r.status, 200);
  assert.equal(r.data.modules.length, 12);
  assert.equal(r.data.sizes.length, 4);
  assert.equal(r.data.statuses.order.new.label, 'Új');
});

test('spa: unknown paths serve the app, unknown api paths 404 json', async () => {
  const page = await fetch(`${srv.base}/megrendelesek`, { headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Fully Logistics WMS/);
  const c = await srv.admin();
  const api = await c.get('/api/nincs-ilyen');
  assert.equal(api.status, 404);
  assert.equal(api.data.error.code, 'not_found');
});

test('fixture data and a limited role', async () => {
  const fx = await srv.seedBasics();
  const admin = await srv.admin();
  const partners = await admin.get('/api/lookup/partners?type=client');
  assert.equal(partners.data.items.length, 2);
  const products = await admin.get(`/api/lookup/products?partner_id=${fx.clients.kutya}&q=KB`);
  assert.equal(products.data.items.length, 3);
  const locs = await admin.get('/api/lookup/locations?q=A-01');
  assert.equal(locs.data.items.length, 8);
  const op = await srv.userWithRole('warehouse_operator');
  const me = await op.get('/api/me');
  assert.equal(me.data.user.role.key, 'warehouse_operator');
  assert.deepEqual(me.data.permissions.counts, ['view', 'edit']);
  assert.deepEqual(me.data.permissions.users, []);
});
