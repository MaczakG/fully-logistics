// Beállítások: company, warehouse, sizes, default tariffs, couriers, invoicing, logs, permissions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

let srv;
let admin;
let fx;
before(async () => {
  srv = await startServer();
  admin = await srv.admin();
  fx = await srv.seedBasics();
});
after(async () => { await srv.stop(); });

const lastAudit = async (entity) => (await srv.query('SELECT * FROM audit_log WHERE entity = ? ORDER BY id DESC LIMIT 1', entity))[0];

test('company: read, validate formats, save, audit', async () => {
  const r = await admin.get('/api/settings/company');
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'Fully Logistics');

  const bad = await admin.put('/api/settings/company', { name: '', tax_number: '123', email: 'nem-email', bank_account: '12', website: 'x' });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.error.fields.name);
  assert.ok(bad.data.error.fields.email);

  const bad2 = await admin.put('/api/settings/company', { name: 'Fully Logistics Kft.', tax_number: '123', bank_account: '12' });
  assert.equal(bad2.status, 400);
  assert.match(bad2.data.error.fields.tax_number, /12345678-1-12/);
  assert.ok(bad2.data.error.fields.bank_account);

  const ok = await admin.put('/api/settings/company', {
    name: 'Fully Logistics Kft.', tax_number: '12345678213', company_reg_number: '13-09-123456', zip: '2351', city: 'Alsónémedi',
    address: 'Depó út 14', email: 'Info@Fully.hu', phone: '+36 1 234 5678', bank_account: '1177300512345678', website: 'fully.hu',
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.tax_number, '12345678-2-13');
  assert.equal(ok.data.bank_account, '11773005-12345678');
  assert.equal(ok.data.website, 'https://fully.hu');
  assert.equal(ok.data.email, 'info@fully.hu');
  const me = await admin.get('/api/me');
  assert.equal(me.data.company.name, 'Fully Logistics Kft.');
  const a = await lastAudit('settings');
  assert.equal(a.entity_id, 'company');
  assert.match(a.details, /Fully Logistics Kft\./);
});

test('warehouse: cut-off feeds /api/me, opening hours and workdays are checked', async () => {
  const cur = await admin.get('/api/settings/warehouse');
  assert.deepEqual(cur.data.workdays, [1, 2, 3, 4, 5]);
  const bad = await admin.put('/api/settings/warehouse', { cutoff: '25:00', open: '18:00', close: '06:00', workdays: [], default_carrier_code: 'xyz' });
  assert.equal(bad.status, 400);
  for (const f of ['cutoff', 'workdays', 'default_carrier_code']) assert.ok(bad.data.error.fields[f], f);
  const bad2 = await admin.put('/api/settings/warehouse', { cutoff: '13:00', open: '18:00', close: '06:00', workdays: [1] });
  assert.ok(bad2.data.error.fields.close);
  const ok = await admin.put('/api/settings/warehouse', { cutoff: '13:30', open: '07:00', close: '17:00', workdays: [5, 1, 2, 2, 6], default_carrier_code: 'gls' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.workdays, [1, 2, 5, 6]);
  const me = await admin.get('/api/me');
  assert.equal(me.data.warehouse.cutoff, '13:30');
});

test('costing: defaults, field checks, save, audit, and the quote calculator gets it', async () => {
  const cur = (await admin.get('/api/settings/costing')).data;
  assert.equal(cur.rent, 0);
  assert.equal(cur.worker_hours, 150);
  assert.equal(cur.min_order, 3);
  assert.deepEqual(cur.racks.M, { area: 1.1, levels: 5, per_level: 2 });
  assert.deepEqual(cur.racks.PAL, { area: 7, levels: 4, per_level: 3 });
  assert.equal(cur.space, undefined);
  assert.deepEqual(cur.sizes.map((z) => z.code), ['M', 'L', 'XL', 'PAL']);

  const bad = await admin.put('/api/settings/costing', { rent: -1, area_m2: 'sok', worker_hours: 0, min_order: 9999, racks: { M: { area: -0.1, levels: 2.5, per_level: 2 } } });
  assert.equal(bad.status, 400);
  for (const f of ['rent', 'area_m2', 'worker_hours', 'min_order', 'racks.M.area', 'racks.M.levels']) assert.ok(bad.data.error.fields[f], f);

  const body = { rent: 2400000, area_m2: '1 200', worker_cost: 520000, worker_hours: 150, min_order: 3, min_item: 0.5, min_inbound: 0.3, min_return: 5, pack_cost: 100, racks: { M: { area: '1,2', levels: 6, per_level: 2 } } };
  const ok = await admin.put('/api/settings/costing', body);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.area_m2, 1200);
  assert.deepEqual(ok.data.racks.M, { area: 1.2, levels: 6, per_level: 2 });
  assert.deepEqual(ok.data.racks.PAL, { area: 7, levels: 4, per_level: 3 }, 'sizes left out keep their rack');
  const log = await lastAudit('settings');
  assert.equal(log.entity_id, 'costing');
  assert.match(log.details, /area_m2/);

  const defs = (await admin.get('/api/quotes/defaults')).data;
  assert.equal(defs.costing.rent, 2400000);
  assert.deepEqual(defs.costing.racks.M, { area: 1.2, levels: 6, per_level: 2 });
  assert.equal(defs.costing.pack_cost, 100);

  // A setting saved with the earlier m² per location: changed values become one level racks, the
  // estimates that were the defaults then give way to the rack defaults.
  await srv.sql(`UPDATE settings SET value = '{"rent":1,"area_m2":1,"worker_hours":150,"space":{"M":0.3,"L":0.25}}' WHERE key = 'costing'`);
  const changed = (await admin.get('/api/settings/costing')).data;
  assert.deepEqual(changed.racks.M, { area: 0.3, levels: 1, per_level: 1 });
  assert.deepEqual(changed.racks.L, { area: 0.25, levels: 1, per_level: 1 });
  await srv.sql(`UPDATE settings SET value = '{"rent":1,"area_m2":1,"worker_hours":150,"space":{"M":0.15,"L":0.25,"XL":0.4,"PAL":1.2}}' WHERE key = 'costing'`);
  const untouched = (await admin.get('/api/settings/costing')).data;
  assert.deepEqual(untouched.racks.M, { area: 1.1, levels: 5, per_level: 2 });
  assert.equal(untouched.space, undefined);
});

test('sizes: create, rename carries the default price, deactivate, delete only when unused', async () => {
  const list = await admin.get('/api/settings/sizes');
  assert.equal(list.data.items.length, 4);
  const m = list.data.items.find((s) => s.code === 'M');
  assert.equal(m.location_count, 8);
  assert.ok(m.occupied_count >= 3);

  const dup = await admin.post('/api/settings/sizes', { code: 'm', name: 'Másik M' });
  assert.equal(dup.status, 409);
  const badCode = await admin.post('/api/settings/sizes', { code: 'FÉL RAKLAP', name: 'Fél raklap' });
  assert.equal(badCode.status, 400);
  assert.ok(badCode.data.error.fields.code);

  const created = await admin.post('/api/settings/sizes', { code: 'xxl', name: 'Polchely XXL', width_cm: 120, depth_cm: 80, height_cm: '150', max_kg: '250,5' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.code, 'XXL');
  assert.equal(created.data.max_kg, 250.5);
  assert.equal(created.data.sort, 50);
  const id = created.data.id;
  assert.ok((await admin.get('/api/meta')).data.sizes.some((s) => s.code === 'XXL'));

  // Default storage price follows a code change.
  await admin.put('/api/settings/tariffs', { storage: { XXL: 2100 } });
  const renamed = await admin.patch(`/api/settings/sizes/${id}`, { code: 'XXL2', name: 'Polchely XXL+' });
  assert.equal(renamed.status, 200);
  const t = await admin.get('/api/settings/tariffs');
  assert.equal(t.data.storage.XXL2, 2100);
  assert.equal(t.data.storage.XXL, undefined);

  // A size in use cannot be deleted, only deactivated (with a warning).
  const inUse = await admin.del('/api/settings/sizes/1');
  assert.equal(inUse.status, 409);
  assert.match(inUse.data.error.message, /Inaktiváld/);
  const off = await admin.patch('/api/settings/sizes/3', { active: false });
  assert.equal(off.status, 200);
  assert.match(off.data.warning, /4 aktív raktárhely/);
  assert.ok(!(await admin.get('/api/meta')).data.sizes.some((s) => s.code === 'XL'));
  await admin.patch('/api/settings/sizes/3', { active: true });

  await srv.sql(`INSERT INTO partner_storage_prices (partner_id, size_id, price) VALUES (${fx.clients.kutya}, ${id}, 2500)`);
  const del = await admin.del(`/api/settings/sizes/${id}`);
  assert.equal(del.status, 200);
  assert.equal((await srv.query('SELECT COUNT(*) AS n FROM partner_storage_prices WHERE size_id = ?', id))[0].n, 0);
  assert.equal((await admin.get('/api/settings/tariffs')).data.storage.XXL2, undefined);
  const a = await lastAudit('location_size');
  assert.equal(a.action, 'delete');
});

test('default tariffs and quote terms', async () => {
  const r = await admin.get('/api/settings/tariffs');
  assert.equal(r.status, 200);
  assert.equal(r.data.values.order_base, 600);
  assert.equal(r.data.storage.M, 780);
  assert.ok(r.data.quote_terms.length >= 3);
  assert.equal(r.data.tariffs.length, 13);

  const bad = await admin.put('/api/settings/tariffs', { values: { order_base: -1, vat_pct: 150, item_2: 'abc' }, storage: { NINCS: 5 } });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.data.error.fields).sort(), ['storage.NINCS', 'values.item_2', 'values.order_base', 'values.vat_pct']);

  const ok = await admin.put('/api/settings/tariffs', {
    values: { order_base: '650', cod_pct: '1,5' }, storage: { M: 800, PAL: '4500' }, quote_terms: ['Első feltétel.', '  ', 'Második feltétel.'],
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const after = await admin.get('/api/settings/tariffs');
  assert.equal(after.data.values.order_base, 650);
  assert.equal(after.data.values.cod_pct, 1.5);
  assert.equal(after.data.values.item_2, 80, 'untouched keys stay');
  assert.equal(after.data.storage.PAL, 4500);
  assert.equal(after.data.storage.L, 990);
  assert.deepEqual(after.data.quote_terms, ['Első feltétel.', 'Második feltétel.']);
  const [row] = await srv.query("SELECT value FROM settings WHERE key = 'default_tariffs'");
  assert.equal(JSON.parse(row.value).storage.M, 800, 'stored the way partners and quotes read it');
});

test('couriers: generic forms, masked credentials, no secrets to the browser', async () => {
  const r = await admin.get('/api/settings/couriers');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.items));
  assert.ok(r.data.carriers.some((c) => c.id === fx.carriers.gls));
  assert.equal((await admin.put('/api/settings/couriers/nincsilyen', { active: true })).status, 404);
  assert.equal((await admin.post('/api/settings/couriers/nincsilyen/test')).status, 404);

  // When adapters exist, a saved secret is only ever returned masked.
  for (const c of r.data.items) {
    assert.ok(Array.isArray(c.credentialFields) && Array.isArray(c.settingFields), c.code);
    const field = c.credentialFields.find((f) => f.type === 'password') || c.credentialFields[0];
    if (!field) continue;
    const secret = 'titkos-ertek-1234567890';
    const put = await admin.put(`/api/settings/couriers/${c.code}`, { active: false, credentials: { [field.key]: secret } });
    assert.equal(put.status, 200, JSON.stringify(put.data));
    const again = await admin.get('/api/settings/couriers');
    assert.ok(!JSON.stringify(again.data).includes(secret));
    assert.ok(again.data.items.find((x) => x.code === c.code).credentials[field.key].includes('••••'));
    // Empty value keeps the stored secret.
    await admin.put(`/api/settings/couriers/${c.code}`, { credentials: { [field.key]: '' } });
    const acc = await srv.call('accounts.getCourierAccount', [c.code]);
    assert.equal(acc.result.credentials[field.key], secret);
    const carrier = await admin.put(`/api/settings/couriers/${c.code}`, { carrier_id: fx.clients.kutya });
    assert.equal(carrier.status, 400);
  }
});

test('couriers: adapter defaults, activation needs required fields, api_base_url stays hidden', async () => {
  const r = await admin.get('/api/settings/couriers');
  const gls = r.data.items.find((c) => c.code === 'gls');
  if (!gls) return; // courier adapters not installed in this build
  assert.equal(typeof gls.features.tracking, 'boolean');
  assert.ok(!gls.settingFields.some((f) => f.key === 'api_base_url'));

  const bad = await admin.put('/api/settings/couriers/gls', { active: true });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error.message, /aktiváláshoz/);
  const required = [...gls.credentialFields.filter((f) => f.required).map((f) => `credentials.${f.key}`), ...gls.settingFields.filter((f) => f.required).map((f) => `settings.${f.key}`)];
  const stored = (await srv.call('accounts.getCourierAccount', ['gls'])).result;
  for (const key of required) {
    const [kind, k] = key.split('.');
    if (!stored || !stored[kind][k]) assert.ok(bad.data.error.fields[key], key);
  }

  // Saving fills the adapter defaults; the browser cannot set api_base_url.
  const creds = Object.fromEntries(gls.credentialFields.map((f) => [f.key, `ertek-${f.key}-1234567`]));
  const settings = Object.fromEntries(gls.settingFields.filter((f) => f.required).map((f) => [f.key, f.type === 'number' ? 100200300 : 'X1']));
  const saved = await admin.put('/api/settings/couriers/gls', { active: false, carrier_id: fx.carriers.gls, credentials: creds, settings: { ...settings, api_base_url: 'http://127.0.0.1:9' } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  for (const f of gls.settingFields.filter((x) => x.default !== undefined)) assert.deepEqual(saved.data.settings[f.key], f.default, f.key);
  assert.equal((await srv.call('accounts.getCourierAccount', ['gls'])).result.settings.api_base_url, undefined);
  assert.ok(!JSON.stringify(saved.data).includes('ertek-password'));

  const on = await admin.put('/api/settings/couriers/gls', { active: true });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.active, true);
  assert.equal((await srv.call('couriers.isConfigured', ['gls'])).result, true);

  // A stored api_base_url (tests only) is never sent to the browser and survives saving the form.
  await srv.call('accounts.saveCourierAccount', ['gls', { settings: { api_base_url: 'http://127.0.0.1:9' } }]);
  const list = await admin.get('/api/settings/couriers');
  assert.ok(!JSON.stringify(list.data).includes('api_base_url'));
  assert.ok(!JSON.stringify(list.data).includes('127.0.0.1'));
  await admin.put('/api/settings/couriers/gls', { settings: { ...list.data.items.find((c) => c.code === 'gls').settings } });
  assert.equal((await srv.call('accounts.getCourierAccount', ['gls'])).result.settings.api_base_url, 'http://127.0.0.1:9');

  // Connection test against a closed local port: a clear failure, kept as the last error.
  const t = await admin.post('/api/settings/couriers/gls/test');
  assert.equal(t.status, 200);
  assert.equal(t.data.ok, false);
  assert.ok(t.data.message);
  const after = (await admin.get('/api/settings/couriers')).data.items.find((c) => c.code === 'gls');
  assert.equal(after.last_error, t.data.message);
  await admin.put('/api/settings/couriers/gls', { active: false });
});

test('invoicing: provider choice, masked credentials, test needs a provider', async () => {
  const r = await admin.get('/api/settings/invoicing');
  assert.equal(r.status, 200);
  assert.equal(r.data.provider, '');
  assert.deepEqual(r.data.choices.map((c) => c.value).sort(), ['', 'billingo', 'szamlazz']);
  const bad = await admin.put('/api/settings/invoicing', { provider: 'kezi-excel' });
  assert.equal(bad.status, 400);
  const noProvider = await admin.post('/api/settings/invoicing/test', {});
  assert.equal(noProvider.status, 400);

  const providers = r.data.providers;
  const chosen = providers[0] ? providers[0].code : 'billingo';
  const body = { provider: chosen, settings: {}, credentials: {} };
  const secret = 'szamlazo-titok-abcdef123456';
  if (providers[0]) {
    const p = providers[0];
    // Selecting a provider needs its required fields.
    const missing = await admin.put('/api/settings/invoicing', { provider: p.code });
    if (p.credentialFields.some((f) => f.required)) assert.equal(missing.status, 400);
    body.credentials[p.code] = Object.fromEntries(p.credentialFields.map((f) => [f.key, f.type === 'checkbox' ? true : secret]));
    body.settings[p.code] = Object.fromEntries(p.settingFields.filter((f) => f.required).map((f) => [f.key,
      f.type === 'select' ? (f.options[0].value ?? f.options[0][0] ?? f.options[0]) : f.type === 'number' ? 1 : f.type === 'checkbox' ? true : 'x']));
  }
  const ok = await admin.put('/api/settings/invoicing', body);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.provider, chosen);
  assert.ok(!JSON.stringify(ok.data).includes(secret));
  const conf = await srv.call('accounts.getInvoicingConfig', []);
  assert.equal(conf.result.provider, chosen);
  const test1 = await admin.post('/api/settings/invoicing/test', {});
  assert.equal(test1.status, 200);
  assert.equal(typeof test1.data.ok, 'boolean');
  assert.ok(test1.data.message);
  await admin.put('/api/settings/invoicing', { provider: '' });
});

test('undecryptable credentials can be cleared and entered again', async () => {
  // As if ENCRYPTION_KEY had changed: the stored values are no longer valid ciphertext.
  await srv.sql("INSERT INTO courier_accounts (carrier_code, credentials, settings, active) VALUES ('dpd', 'nem-titkositott', '{\"customer_id\":\"C1\"}', 1) ON CONFLICT (carrier_code) DO UPDATE SET credentials = excluded.credentials, settings = excluded.settings, active = 1");
  await srv.sql("INSERT INTO settings (key, value) VALUES ('invoicing_credentials', '\"nem-titkositott\"') ON CONFLICT (key) DO UPDATE SET value = excluded.value");

  const list = await admin.get('/api/settings/couriers');
  assert.match(list.data.items.find((c) => c.code === 'dpd').error, /nem fejthetők vissza/);
  assert.equal((await admin.put('/api/settings/couriers/dpd', { credentials: { api_token: 'uj' } })).status, 409);
  const inv = await admin.get('/api/settings/invoicing');
  assert.match(inv.data.error, /nem fejthetők vissza/);

  const viewer = await srv.userWithRole('warehouse_operator', 'nezo-titok@example.com');
  assert.equal((await viewer.del('/api/settings/couriers/dpd/credentials')).status, 403);

  const cleared = await admin.del('/api/settings/couriers/dpd/credentials');
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  assert.equal(cleared.data.error, '');
  assert.equal(cleared.data.active, false);
  const [row] = await srv.query("SELECT credentials, settings FROM courier_accounts WHERE carrier_code = 'dpd'");
  assert.equal(row.credentials, '');
  assert.equal(JSON.parse(row.settings).customer_id, 'C1');
  assert.equal((await admin.put('/api/settings/couriers/dpd', { credentials: { api_token: 'uj' } })).status, 200);

  const invCleared = await admin.del('/api/settings/invoicing/credentials');
  assert.equal(invCleared.status, 200, JSON.stringify(invCleared.data));
  assert.equal(invCleared.data.error, '');
  assert.equal((await lastAudit('settings')).summary, 'Számlázó hozzáférési adatai törölve');
});

test('activity log: filters, pagination, export; integration log filters', async () => {
  const all = await admin.get('/api/settings/audit');
  assert.equal(all.status, 200);
  assert.ok(all.data.total >= 5);
  const settingsOnly = await admin.get('/api/settings/audit?module=settings&limit=2');
  assert.equal(settingsOnly.data.items.length, 2);
  assert.ok(settingsOnly.data.items.every((x) => x.module === 'settings' && x.module_name === 'Beállítások'));
  const page2 = await admin.get('/api/settings/audit?module=settings&limit=2&offset=2');
  assert.notEqual(page2.data.items[0].id, settingsOnly.data.items[0].id);
  const text = await admin.get(`/api/settings/audit?q=${encodeURIComponent('Cégadatok')}`);
  assert.ok(text.data.items.length >= 1 && text.data.items.every((x) => /Cégadatok/.test(x.summary)));
  assert.ok(text.data.items[0].details.changes);
  const entity = await admin.get('/api/settings/audit?entity=settings&entity_id=warehouse');
  assert.ok(entity.data.items.length >= 1);
  const today = new Date().toISOString().slice(0, 10);
  const future = await admin.get('/api/settings/audit?from=2099-01-01');
  assert.equal(future.data.total, 0);
  const ranged = await admin.get(`/api/settings/audit?from=2020-01-01&to=2099-12-31&user_id=1`);
  assert.ok(ranged.data.total >= 1, today);
  assert.equal((await admin.get('/api/settings/audit?from=tegnap')).status, 400);
  const filters = await admin.get('/api/settings/audit/filters');
  assert.ok(filters.data.entities.includes('settings'));
  assert.equal(filters.data.modules.length, 12);
  const csv = await admin.get('/api/settings/audit/export?module=settings', { raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(await csv.text(), /Időpont;Felhasználó;Modul/);

  // Own system names: real adapters called by other tests log here too.
  await srv.sql(`INSERT INTO integration_log (system, direction, action, ok, status, message) VALUES
    ('naplo-a', 'out', 'label', 1, 200, 'Címke kész'), ('naplo-a', 'out', 'label', 0, 500, 'Szerver hiba'), ('naplo-b', 'in', 'webhook', 1, 200, 'Rendelés')`);
  const errorsOnly = await admin.get('/api/settings/integration-log?ok=0&system=naplo-a');
  assert.equal(errorsOnly.data.total, 1);
  assert.equal(errorsOnly.data.items[0].message, 'Szerver hiba');
  assert.ok((await admin.get('/api/settings/integration-log?ok=0')).data.items.every((x) => !x.ok));
  const a = await admin.get('/api/settings/integration-log?system=naplo-a');
  assert.equal(a.data.total, 2);
  assert.equal((await admin.get('/api/settings/integration-log?direction=in&system=naplo-b')).data.total, 1);
  assert.ok((await admin.get('/api/settings/audit/filters')).data.systems.includes('naplo-b'));
});

test('permissions: view only roles read, cannot change; no settings right is 403 everywhere', async () => {
  const manager = await srv.userWithRole('warehouse_manager'); // settings: view only
  assert.equal((await manager.get('/api/settings/company')).status, 200);
  assert.equal((await manager.get('/api/settings/locations')).status, 200);
  assert.equal((await manager.get('/api/settings/audit')).status, 200);
  assert.equal((await manager.put('/api/settings/company', { name: 'X' })).status, 403);
  assert.equal((await manager.put('/api/settings/warehouse', { cutoff: '10:00', workdays: [1] })).status, 403);
  assert.equal((await manager.get('/api/settings/costing')).status, 200);
  assert.equal((await manager.put('/api/settings/costing', { rent: 1, worker_hours: 1 })).status, 403);
  assert.equal((await manager.put('/api/settings/tariffs', { values: { order_base: 1 } })).status, 403);
  assert.equal((await manager.post('/api/settings/sizes', { code: 'Z', name: 'Z' })).status, 403);
  assert.equal((await manager.patch('/api/settings/sizes/1', { name: 'Z' })).status, 403);
  assert.equal((await manager.del('/api/settings/sizes/1')).status, 403);
  assert.equal((await manager.put('/api/settings/invoicing', { provider: '' })).status, 403);
  assert.equal((await manager.post('/api/settings/invoicing/test', {})).status, 403);
  const denied = await manager.post('/api/settings/locations', { code: 'Z-01', size_id: 1 });
  assert.equal(denied.status, 403);
  assert.match(denied.data.error.message, /Beállítások: raktárhely és méret felvétele/);

  const sales = await srv.userWithRole('sales'); // no settings rights
  for (const path of ['/api/settings/company', '/api/settings/warehouse', '/api/settings/costing', '/api/settings/tariffs', '/api/settings/sizes',
    '/api/settings/locations', '/api/settings/locations/export', '/api/settings/couriers', '/api/settings/invoicing',
    '/api/settings/audit', '/api/settings/audit/filters', '/api/settings/integration-log']) {
    assert.equal((await sales.get(path)).status, 403, path);
  }
});
