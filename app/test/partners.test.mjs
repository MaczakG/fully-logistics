// Partnerek: list, create with default tariffs, basic data, delete rules, contacts, contracts,
// documents (R2), tariffs and custom items, webshop connections, API keys, summary, permissions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { mergeCredentials, normalizeShopUrl, readSettings, safeContentType, budapestStartIso } from '../worker/routes/partners.js';

let srv;
let fx;
let admin;
let sales;      // partners: view, create, edit, approve (no delete)
let service;    // partners: view only
let operator;   // no partners access
before(async () => {
  srv = await startServer();
  admin = await srv.admin();
  fx = await srv.seedBasics();
  sales = await srv.userWithRole('sales');
  service = await srv.userWithRole('customer_service');
  operator = await srv.userWithRole('warehouse_operator');
});
after(async () => { await srv.stop(); });

const okData = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Budapest' }).format(new Date());

test('list: type tabs with counts, search and status filter', async () => {
  const all = okData(await service.get('/api/partners'));
  assert.equal(all.counts.all, 5);
  assert.deepEqual([all.counts.client, all.counts.carrier, all.counts.supplier], [2, 2, 1]);
  const clients = okData(await service.get('/api/partners?type=client'));
  assert.equal(clients.total, 2);
  assert.ok(clients.items.every((p) => p.type === 'client'));
  const search = okData(await service.get('/api/partners?q=kecskem'));
  assert.deepEqual(search.items.map((p) => p.code), ['KONYHA']);
  assert.equal(search.counts.all, 1);
  const inactive = okData(await service.get('/api/partners?status=inactive'));
  assert.equal(inactive.total, 0);
  assert.equal((await operator.get('/api/partners')).status, 403);
});

test('create: code is uppercased and unique, clients get the default tariffs', async () => {
  const res = okData(await sales.post('/api/partners', {
    type: 'client', code: 'macska-1', name: 'Macskabolt Kft.', tax_number: '11223344213', zip: '1051', city: 'Budapest', website: 'macskabolt.hu',
  }));
  const [p] = await srv.query('SELECT * FROM partners WHERE id = ?', res.id);
  assert.equal(p.code, 'MACSKA-1');
  assert.equal(p.tax_number, '11223344-2-13');
  assert.equal(p.website, 'https://macskabolt.hu');
  assert.equal(p.status, 'active');
  const tariffs = await srv.query('SELECT key, value FROM partner_tariffs WHERE partner_id = ?', res.id);
  assert.equal(tariffs.length, 13);
  assert.equal(tariffs.find((t) => t.key === 'order_base').value, 600);
  const storage = await srv.query('SELECT s.code, sp.price FROM partner_storage_prices sp JOIN location_sizes s ON s.id = sp.size_id WHERE sp.partner_id = ? ORDER BY s.sort', res.id);
  assert.deepEqual(storage.map((s) => `${s.code}:${s.price}`), ['M:780', 'L:990', 'XL:1350', 'PAL:0']);
  const audit = await srv.query("SELECT summary FROM audit_log WHERE entity = 'partner' AND entity_id = ?", String(res.id));
  assert.match(audit[0].summary, /Ügyfél létrehozva: Macskabolt Kft\./);

  const dup = await sales.post('/api/partners', { type: 'supplier', code: 'Macska-1', name: 'Másik' });
  assert.equal(dup.status, 409);
  assert.ok(dup.data.error.fields.code);
  const bad = await sales.post('/api/partners', { type: 'client', code: 'Á', name: 'Rossz kód', tax_number: '123' });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.error.fields.code);
  assert.ok(bad.data.error.fields.tax_number);
  const carrier = okData(await sales.post('/api/partners', { type: 'carrier', code: 'DPD', name: 'DPD Hungária Kft.', carrier_code: 'dpd' }));
  assert.equal((await srv.query('SELECT COUNT(*) AS n FROM partner_tariffs WHERE partner_id = ?', carrier.id))[0].n, 0, 'only clients get tariffs');
  const supplier = okData(await sales.post('/api/partners', { type: 'supplier', code: 'BESZ', name: 'Beszállító Bt.', carrier_code: 'gls' }));
  assert.equal((await srv.query('SELECT carrier_code FROM partners WHERE id = ?', supplier.id))[0].carrier_code, '', 'carrier code only for carriers');
  assert.equal((await service.post('/api/partners', { type: 'client', code: 'NEM', name: 'Nem mehet' })).status, 403);
});

test('detail and basic data: edit, type is fixed, required numbers', async () => {
  const p = okData(await service.get(`/api/partners/${fx.clients.kutya}`));
  assert.equal(p.code, 'KUTYA');
  assert.equal(p.can_delete, false);
  assert.ok(p.delete_blockers.some((b) => b.key === 'products'));
  assert.equal((await service.patch(`/api/partners/${fx.clients.kutya}`, { notes: 'x' })).status, 403);

  okData(await sales.patch(`/api/partners/${fx.clients.kutya}`, {
    billing_name: 'Kutyabarát Webshop Kft.', billing_zip: '1111', billing_city: 'Budapest', billing_address: 'Minta utca 1.', payment_days: 15, notes: 'Kedden nagy betárolás.',
  }));
  const [row] = await srv.query('SELECT payment_days, notes, billing_city FROM partners WHERE id = ?', fx.clients.kutya);
  assert.deepEqual(row, { payment_days: 15, notes: 'Kedden nagy betárolás.', billing_city: 'Budapest' });
  const type = await sales.patch(`/api/partners/${fx.clients.kutya}`, { type: 'supplier' });
  assert.equal(type.status, 400);
  assert.ok(type.data.error.fields.type);
  const days = await sales.patch(`/api/partners/${fx.clients.kutya}`, { payment_days: null });
  assert.equal(days.status, 400);
  assert.ok(days.data.error.fields.payment_days);
  const code = await sales.patch(`/api/partners/${fx.clients.kutya}`, { code: 'konyha' });
  assert.equal(code.status, 409);
  assert.equal((await sales.get('/api/partners/99999')).status, 404);
});

test('delete: refused with history (suggests deactivating), allowed for an unused partner', async () => {
  const blocked = await admin.del(`/api/partners/${fx.clients.kutya}`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error.message, /Inaktiváld/);

  const p = okData(await admin.post('/api/partners', { type: 'client', code: 'TOROL', name: 'Törlendő Kft.' }));
  okData(await admin.post(`/api/partners/${p.id}/contacts`, { name: 'Valaki' }));
  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4 teszt'], { type: 'application/pdf' }), 'szerzodes.pdf');
  form.append('kind', 'contract');
  const doc = okData(await admin.post(`/api/partners/${p.id}/documents`, form));
  assert.equal((await sales.del(`/api/partners/${p.id}`)).status, 403, 'sales may not delete partners');
  okData(await admin.del(`/api/partners/${p.id}`));
  assert.equal((await srv.query('SELECT COUNT(*) AS n FROM partners WHERE id = ?', p.id))[0].n, 0);
  assert.equal((await srv.query('SELECT COUNT(*) AS n FROM documents WHERE id = ?', doc.id))[0].n, 0);
  assert.equal((await srv.query('SELECT COUNT(*) AS n FROM partner_tariffs WHERE partner_id = ?', p.id))[0].n, 0);
});

test('contacts: one primary at a time', async () => {
  const pid = fx.clients.konyha;
  const a = okData(await sales.post(`/api/partners/${pid}/contacts`, { name: 'Első Anna', email: 'ANNA@konyhagep.example', phone: '+36 30 111 2222' }));
  const b = okData(await sales.post(`/api/partners/${pid}/contacts`, { name: 'Második Béla', is_primary: true }));
  okData(await sales.post(`/api/partners/${pid}/contacts`, { name: 'Harmadik Cili' }));
  const primary = async () => (await srv.query('SELECT id FROM partner_contacts WHERE partner_id = ? AND is_primary = 1', pid)).map((r) => r.id);
  assert.deepEqual(await primary(), [b.id]);
  const list = okData(await service.get(`/api/partners/${pid}/contacts`));
  assert.equal(list.items[0].id, b.id, 'primary first');
  assert.equal(list.items.find((c) => c.id === a.id).email, 'anna@konyhagep.example');
  okData(await sales.patch(`/api/partners/${pid}/contacts/${a.id}`, { is_primary: true }));
  assert.deepEqual(await primary(), [a.id]);
  okData(await sales.del(`/api/partners/${pid}/contacts/${a.id}`));
  assert.equal((await primary()).length, 1, 'another contact took over');
  const badEmail = await sales.post(`/api/partners/${pid}/contacts`, { name: 'X', email: 'nem-email' });
  assert.equal(badEmail.status, 400);
  assert.equal((await service.post(`/api/partners/${pid}/contacts`, { name: 'Tilos' })).status, 403);
  const list2 = okData(await sales.get(`/api/partners/${fx.carriers.gls}/contacts`));
  assert.equal(list2.items.length, 0);
});

test('contracts and documents: dates, R2 upload, safe content types, open, delete', async () => {
  const pid = fx.clients.konyha;
  const bad = await sales.post(`/api/partners/${pid}/contracts`, { title: 'Rossz', start_date: '2026-05-01', end_date: '2026-04-01' });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.error.fields.end_date);
  const c = okData(await sales.post(`/api/partners/${pid}/contracts`, { number: 'SZ-2026-01', title: 'Fulfillment szerződés', start_date: '2026-01-01', end_date: null, notice_days: 60 }));
  const other = okData(await sales.post(`/api/partners/${fx.clients.kutya}/contracts`, { title: 'Másik ügyfél szerződése' }));
  okData(await sales.patch(`/api/partners/${pid}/contracts/${c.id}`, { status: 'terminated' }));
  assert.equal((await srv.query('SELECT status, end_date FROM partner_contracts WHERE id = ?', c.id))[0].status, 'terminated');
  assert.equal((await sales.patch(`/api/partners/${pid}/contracts/${c.id}`, { status: 'nincs' })).status, 400);

  const upload = (name, type, body, fields = {}) => {
    const form = new FormData();
    form.append('file', new Blob([body], { type }), name);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return sales.post(`/api/partners/${pid}/documents`, form);
  };
  const pdf = okData(await upload('szerzodes.pdf', 'application/pdf', '%PDF-1.4 teszt', { kind: 'contract', contract_id: String(c.id) }));
  const svg = okData(await upload('kep.svg', 'image/svg+xml', '<svg onload="alert(1)"></svg>', { kind: 'other' }));
  assert.equal((await upload('x.pdf', 'application/pdf', 'x', { kind: 'contract', contract_id: String(other.id) })).status, 400, 'contract of another partner');
  assert.equal((await upload('x.pdf', 'application/pdf', 'x', { kind: 'invoice' })).status, 400);
  const types = await srv.query('SELECT id, content_type, contract_id, kind FROM documents WHERE partner_id = ? ORDER BY id', pid);
  assert.deepEqual(types.map((d) => d.content_type), ['application/pdf', 'application/octet-stream']);
  assert.equal(types[0].contract_id, c.id);

  const docs = okData(await service.get(`/api/partners/${pid}/documents`));
  assert.equal(docs.items.length, 2);
  assert.equal(docs.items.find((d) => d.id === pdf.id).contract_number, 'SZ-2026-01');
  const contracts = okData(await service.get(`/api/partners/${pid}/contracts`));
  assert.equal(contracts.items.find((x) => x.id === c.id).documents, 1);

  const open = await service.get(`/api/documents/${pdf.id}?inline=1`, { raw: true });
  assert.equal(open.status, 200);
  assert.equal(await open.text(), '%PDF-1.4 teszt');
  assert.equal((await operator.get(`/api/documents/${pdf.id}`, { raw: true })).status, 403);
  const svgOpen = await service.get(`/api/documents/${svg.id}?inline=1`, { raw: true });
  assert.match(svgOpen.headers.get('content-disposition'), /^attachment/, 'SVG is never served inline');
  await svgOpen.arrayBuffer();

  okData(await sales.patch(`/api/partners/${pid}/documents/${svg.id}`, { contract_id: c.id }));
  assert.equal((await service.del(`/api/partners/${pid}/documents/${svg.id}`)).status, 403);
  okData(await sales.del(`/api/partners/${pid}/documents/${svg.id}`));
  assert.equal((await service.get(`/api/documents/${svg.id}`, { raw: true })).status, 404);
  okData(await sales.del(`/api/partners/${pid}/contracts/${c.id}`));
  assert.equal((await srv.query('SELECT contract_id FROM documents WHERE id = ?', pdf.id))[0].contract_id, null, 'documents stay, unlinked');
});

test('tariffs: missing rows are the defaults, save needs approve, differences, reset, new sizes appear', async () => {
  const pid = fx.clients.kutya; // fixture: no tariff rows at all
  const t0 = okData(await service.get(`/api/partners/${pid}/tariffs`));
  assert.equal(t0.tariffs.length, 13);
  assert.ok(t0.tariffs.every((t) => !t.differs));
  assert.equal(t0.tariffs.find((t) => t.key === 'item_2').value, 80);
  assert.deepEqual(t0.storage.map((s) => [s.code, s.price, s.default]), [['M', 780, 780], ['L', 990, 990], ['XL', 1350, 1350], ['PAL', 0, 0]]);

  assert.equal((await service.put(`/api/partners/${pid}/tariffs`, { tariffs: { order_base: 550 } })).status, 403);
  const L = t0.storage.find((s) => s.code === 'L').size_id;
  const t1 = okData(await sales.put(`/api/partners/${pid}/tariffs`, { tariffs: { order_base: 550, discount_handling_pct: 5 }, storage: { [L]: 900 } }));
  const ob = t1.tariffs.find((t) => t.key === 'order_base');
  assert.deepEqual([ob.value, ob.default, ob.differs], [550, 600, true]);
  assert.equal(t1.storage.find((s) => s.code === 'L').differs, true);
  assert.equal(t1.tariffs.find((t) => t.key === 'packaging').differs, false);
  const audit = await srv.query("SELECT details FROM audit_log WHERE entity = 'partner_tariffs' AND entity_id = ? ORDER BY id DESC LIMIT 1", String(pid));
  assert.deepEqual(JSON.parse(audit[0].details).order_base, { from: 600, to: 550 });

  const bad = await sales.put(`/api/partners/${pid}/tariffs`, { tariffs: { vat_pct: 150, item_2: -1, nincs: 1 }, storage: { 999: 5 } });
  assert.equal(bad.status, 400);
  assert.deepEqual(Object.keys(bad.data.error.fields).sort(), ['item_2', 'nincs', 'storage_999', 'vat_pct']);
  assert.equal((await sales.put(`/api/partners/${fx.carriers.gls}/tariffs`, { tariffs: { order_base: 1 } })).status, 400, 'only clients');

  // A size added in Beállítások shows up with its default price.
  await srv.sql("INSERT INTO location_sizes (id, code, name, width_cm, depth_cm, height_cm, sort) VALUES (5, 'XXL', 'Polchely XXL', 120, 80, 100, 35)");
  const t2 = okData(await service.get(`/api/partners/${pid}/tariffs`));
  const xxl = t2.storage.find((s) => s.code === 'XXL');
  assert.deepEqual([xxl.price, xxl.default, xxl.width_cm], [0, 0, 120]);

  const t3 = okData(await sales.post(`/api/partners/${pid}/tariffs/reset`));
  assert.ok(t3.tariffs.every((t) => !t.differs));
  assert.ok(t3.storage.every((s) => !s.differs));
  assert.equal((await srv.query('SELECT COUNT(*) AS n FROM partner_storage_prices WHERE partner_id = ?', pid))[0].n, 5);
  await srv.sql('UPDATE location_sizes SET active = 0 WHERE id = 5');
});

test('custom items: approve needed, delete refused once used', async () => {
  const pid = fx.clients.kutya;
  assert.equal((await service.post(`/api/partners/${pid}/custom-items`, { name: 'Fóliázás', price: 500 })).status, 403);
  const it = okData(await sales.post(`/api/partners/${pid}/custom-items`, { name: 'Raklapfóliázás', unit: 'raklap', price: 1500, kind: 'per_unit' }));
  const fee = okData(await sales.post(`/api/partners/${pid}/custom-items`, { name: 'Dedikált ügyfélszolgálat', price: 25000, kind: 'monthly', unit: '' }));
  assert.equal((await sales.post(`/api/partners/${pid}/custom-items`, { name: 'Rossz', price: -5 })).status, 400);
  okData(await sales.patch(`/api/partners/${pid}/custom-items/${fee.id}`, { price: 30000 }));
  const t = okData(await service.get(`/api/partners/${pid}/tariffs`));
  assert.deepEqual(t.custom_items.map((c) => `${c.name}:${c.price}:${c.kind}:${c.unit}`).sort(), ['Dedikált ügyfélszolgálat:30000:monthly:db', 'Raklapfóliázás:1500:per_unit:raklap']);
  await srv.sql(`INSERT INTO billing_entries (partner_id, date, kind, custom_item_id, qty) VALUES (${pid}, '2026-10-01', 'custom', ${it.id}, 4)`);
  const used = await sales.del(`/api/partners/${pid}/custom-items/${it.id}`);
  assert.equal(used.status, 409);
  assert.match(used.data.error.message, /Inaktiváld/);
  okData(await sales.patch(`/api/partners/${pid}/custom-items/${it.id}`, { active: false }));
  okData(await sales.del(`/api/partners/${pid}/custom-items/${fee.id}`));
});

test('webshop connections: platforms from the integration, credentials encrypted and masked', async () => {
  const pid = fx.clients.konyha;
  const i0 = okData(await service.get(`/api/partners/${pid}/integrations`));
  assert.ok(Array.isArray(i0.platforms));
  assert.equal(i0.api_docs_url, '/api/v1/docs');
  assert.equal((await service.get(`/api/partners/${fx.carriers.gls}/integrations`)).status, 400);

  const unknown = await sales.post(`/api/partners/${pid}/webshops`, { platform: 'nincs-ilyen', shop_url: 'https://bolt.example.com' });
  assert.equal(unknown.status, 400);
  assert.ok(unknown.data.error.fields.platform);
  assert.equal((await service.post(`/api/partners/${pid}/webshops`, { platform: 'shopify' })).status, 403);

  // A stored connection (as the integration module would leave it): never shown in clear text.
  const enc = await srv.call('crypto.encryptJson', [{ access_token: 'shpat_titkos_1234567890' }]);
  assert.equal(enc.ok, true);
  await srv.sql(`INSERT INTO webshop_connections (id, partner_id, platform, shop_url, credentials, settings, active) VALUES (500, ${pid}, 'shopify', 'https://konyhagep-teszt.invalid', '${enc.result}', '{"auto_import":true}', 1)`);
  const i1 = okData(await service.get(`/api/partners/${pid}/integrations`));
  const conn = i1.connections.find((c) => c.id === 500);
  assert.equal(conn.credentials.access_token, 'sh••••90');
  assert.ok(!JSON.stringify(i1).includes('shpat_titkos'));
  assert.equal(conn.platform_name, 'Shopify');
  assert.deepEqual(conn.settings, { auto_import: true });

  const badUrl = await sales.patch(`/api/partners/${pid}/webshops/500`, { shop_url: 'http://nem-biztonsagos.hu' });
  assert.equal(badUrl.status, 400);
  assert.ok(badUrl.data.error.fields.shop_url);
  const off = okData(await sales.patch(`/api/partners/${pid}/webshops/500`, { active: false }));
  assert.equal(off.active, false);
  assert.equal((await sales.post(`/api/partners/${pid}/webshops/500/sync`)).status, 409, 'inactive connection');
  assert.equal((await service.post(`/api/partners/${pid}/webshops/500/test`)).status, 403);
  const tested = okData(await sales.post(`/api/partners/${pid}/webshops/500/test`));
  assert.equal(typeof tested.result.ok, 'boolean');
  assert.equal(typeof tested.result.message, 'string');
  assert.equal(tested.connection.id, 500);
  okData(await sales.patch(`/api/partners/${pid}/webshops/500`, { active: true }));
  const synced = okData(await sales.post(`/api/partners/${pid}/webshops/500/sync`));
  assert.equal(typeof synced.result.imported, 'number');
  assert.ok(Array.isArray(synced.result.errors));
  assert.equal((await sales.get(`/api/partners/${fx.clients.kutya}/webshops/500`)).status, 405);
  assert.equal((await sales.del(`/api/partners/${fx.clients.kutya}/webshops/500`)).status, 404, 'another partner\'s connection');

  // When adapters exist, a connection can be created from their field definitions.
  const defs = i0.platforms;
  if (defs.length) {
    const def = defs[0];
    const credentials = Object.fromEntries(def.credentialFields.map((f) => [f.key, f.options ? f.options[0].value : `teszt-${f.key}-0123456789`]));
    const settings = Object.fromEntries(def.settingFields.filter((f) => f.required).map((f) => [f.key, f.options ? f.options[0].value : ['number', 'int'].includes(f.type) ? 1 : ['checkbox', 'bool', 'boolean'].includes(f.type) ? true : 'x']));
    const created = okData(await sales.post(`/api/partners/${pid}/webshops`, { platform: def.code, shop_url: 'teszt-bolt.invalid', credentials, settings, active: false }));
    assert.equal(created.shop_url, 'https://teszt-bolt.invalid');
    const [row] = await srv.query('SELECT credentials FROM webshop_connections WHERE id = ?', created.id);
    assert.match(row.credentials, /^v1:/);
    okData(await sales.del(`/api/partners/${pid}/webshops/${created.id}`));
  }
  okData(await sales.del(`/api/partners/${pid}/webshops/500`));
  assert.equal((await srv.query('SELECT COUNT(*) AS n FROM webshop_connections WHERE id = 500'))[0].n, 0);
});

test('API keys: shown once, hashed, revocable; revoked keys stop working', async () => {
  const pid = fx.clients.konyha;
  assert.equal((await service.post(`/api/partners/${pid}/api-keys`, { name: 'ERP' })).status, 403);
  assert.equal((await sales.post(`/api/partners/${pid}/api-keys`, {})).status, 400);
  const k = okData(await sales.post(`/api/partners/${pid}/api-keys`, { name: 'ERP integráció' }));
  assert.match(k.key, /^flk_[A-Za-z0-9_-]{40,}$/);
  const [row] = await srv.query('SELECT prefix, key_hash FROM api_keys WHERE id = ?', k.id);
  assert.equal(row.prefix, k.key.slice(0, 12));
  assert.notEqual(row.key_hash, k.key);
  const list = okData(await service.get(`/api/partners/${pid}/integrations`));
  assert.ok(!JSON.stringify(list).includes(k.key), 'the key is never listed');
  assert.equal(list.api_keys[0].name, 'ERP integráció');

  const asPartner = (path) => fetch(`${srv.base}${path}`, { headers: { authorization: `Bearer ${k.key}`, accept: 'application/json' } });
  assert.notEqual((await asPartner('/api/v1/__nincs_ilyen__')).status, 401, 'valid key passes authentication');
  assert.equal((await service.post(`/api/partners/${pid}/api-keys/${k.id}/revoke`)).status, 403);
  okData(await sales.post(`/api/partners/${pid}/api-keys/${k.id}/revoke`));
  assert.equal((await asPartner('/api/v1/__nincs_ilyen__')).status, 401);
  assert.equal((await sales.post(`/api/partners/${pid}/api-keys/${k.id}/revoke`)).status, 409);

  const inactive = okData(await sales.post('/api/partners', { type: 'client', code: 'ALVO', name: 'Alvó Kft.', status: 'inactive' }));
  assert.equal((await sales.post(`/api/partners/${inactive.id}/api-keys`, { name: 'x' })).status, 409);
  assert.equal((await sales.post(`/api/partners/${fx.carriers.gls}/api-keys`, { name: 'x' })).status, 400);
});

test('summary: client stock and orders, carrier shipments, supplier inbounds', async () => {
  const client = okData(await service.get(`/api/partners/${fx.clients.kutya}/summary`));
  assert.equal(client.type, 'client');
  assert.equal(client.kpis.active_skus, 3);
  assert.equal(client.kpis.on_hand, 375);
  assert.deepEqual(client.occupied_by_size.map((s) => `${s.code}:${s.locations}`), ['M:1', 'L:3']);
  assert.equal(client.kpis.occupied_locations, 4);

  const order = await srv.call('orderCreate.createOrder', [{ partner_id: fx.clients.kutya, customer_name: 'Vevő Vera', city: 'Szeged', carrier_code: 'gls', lines: [{ sku: 'KB-1002', qty: 2 }] }], { as: 1 });
  assert.equal(order.ok, true, JSON.stringify(order));
  // A second order with its own external id (independent of how manual orders are de-duplicated).
  const second = await srv.call('orderCreate.createOrder', [{ partner_id: fx.clients.kutya, source: 'csv', external_id: 'csv-1', customer_name: 'Új Ubul', lines: [{ sku: 'KB-1003', qty: 1 }] }], { as: 1 });
  assert.equal(second.ok, true, JSON.stringify(second));
  const now = new Date().toISOString();
  await srv.sql(`UPDATE orders SET status = 'shipped', shipped_at = '${now}', shipped_date = '${today()}', tracking_number = 'GLS123' WHERE id = ${order.result.id}`);
  await srv.sql(`INSERT INTO storage_snapshots (date, location_id, partner_id, size_id) VALUES ('${today()}', 18, ${fx.clients.kutya}, 2), ('${today()}', 19, ${fx.clients.kutya}, 2), ('${today()}', 10, ${fx.clients.kutya}, 1)`);
  const inbound = await srv.call('inboundCreate.createInbound', [{ partner_id: fx.clients.kutya, supplier_id: fx.supplier, expected_date: today(), lines: [{ sku: 'KB-1001', expected_qty: 20 }] }], { as: 1 });
  assert.equal(inbound.ok, true, JSON.stringify(inbound));

  const c2 = okData(await service.get(`/api/partners/${fx.clients.kutya}/summary`));
  assert.equal(c2.kpis.orders_this_month, 2);
  assert.equal(c2.kpis.open_inbounds, 1);
  assert.equal(c2.open_inbounds[0].expected_qty, 20);
  assert.deepEqual(c2.orders_by_status.map((s) => `${s.status}:${s.this_month}`), ['new:1', 'shipped:1']);
  assert.equal(c2.last_shipped[0].tracking_number, 'GLS123');
  assert.equal(c2.last_shipped[0].carrier_name, 'GLS General Logistics Systems Hungary Kft.');
  const sm = c2.storage_month;
  assert.equal(sm.days_snapshotted, 1);
  const L = sm.by_size.find((s) => s.code === 'L');
  assert.equal(L.location_days, 2);
  assert.equal(L.amount, Math.round((2 * 990 / sm.days_in_month) * 100) / 100);

  const carrier = okData(await service.get(`/api/partners/${fx.carriers.gls}/summary`));
  assert.equal(carrier.type, 'carrier');
  assert.equal(carrier.kpis.shipped_this_month, 1);
  assert.deepEqual(carrier.by_client.map((c) => `${c.code}:${c.orders}`), ['KUTYA:1']);
  await srv.sql(`INSERT INTO carrier_pickups (number, carrier_id, date, status) VALUES ('FA-2026-00001', ${fx.carriers.gls}, '${today()}', 'planned')`);
  const c3 = okData(await service.get(`/api/partners/${fx.carriers.gls}/summary`));
  assert.equal(c3.last_pickups[0].number, 'FA-2026-00001');
  assert.equal(c3.kpis.pickups_this_month, 1);

  const supplier = okData(await service.get(`/api/partners/${fx.supplier}/summary`));
  assert.equal(supplier.type, 'supplier');
  assert.equal(supplier.kpis.inbounds_this_year, 1);
  assert.equal(supplier.last_inbounds[0].client_code, 'KUTYA');
  assert.equal((await operator.get(`/api/partners/${fx.supplier}/summary`)).status, 403);

  // The carrier now has orders: it cannot be deleted any more.
  const del = await admin.del(`/api/partners/${fx.carriers.gls}`);
  assert.equal(del.status, 409);
});

test('helpers: shop URL, credential merge, settings, content types, Budapest month start', () => {
  assert.deepEqual(normalizeShopUrl('bolt.hu/'), { url: 'https://bolt.hu' });
  assert.deepEqual(normalizeShopUrl('https://bolt.hu/shop/'), { url: 'https://bolt.hu/shop' });
  assert.ok(normalizeShopUrl('http://bolt.hu').error);
  assert.ok(normalizeShopUrl('').error);
  assert.ok(normalizeShopUrl('https://user:pw@bolt.hu').error);
  const fields = [{ key: 'api_key', required: true }, { key: 'secret' }];
  assert.deepEqual(mergeCredentials(fields, { api_key: '', secret: ' uj ' }, { api_key: 'regi', secret: 'r', old: 'x' }).credentials, { api_key: 'regi', secret: 'uj' });
  assert.deepEqual(mergeCredentials(fields, { secret: null }, { api_key: 'k', secret: 's' }).credentials, { api_key: 'k' });
  assert.deepEqual(mergeCredentials(fields, {}, {}).errors, { cred_api_key: 'Kötelező mező.' });
  const sf = [{ key: 'auto', type: 'checkbox' }, { key: 'status', type: 'select', options: [['processing', 'Feldolgozás alatt'], ['completed', 'Teljesítve']], required: true }, { key: 'days', type: 'number' }];
  assert.deepEqual(readSettings(sf, { auto: '1', status: 'completed', days: '3', extra: 'x' }).settings, { auto: true, status: 'completed', days: 3 });
  assert.deepEqual(Object.keys(readSettings(sf, { status: 'nincs', days: 'abc' }).errors).sort(), ['set_days', 'set_status']);
  assert.equal(safeContentType('application/pdf'), 'application/pdf');
  assert.equal(safeContentType('text/html'), 'application/octet-stream');
  assert.equal(safeContentType('image/svg+xml'), 'application/octet-stream');
  assert.equal(budapestStartIso('2026-07-01'), '2026-06-30T22:00:00.000Z');
  assert.equal(budapestStartIso('2026-12-01'), '2026-11-30T23:00:00.000Z');
});
