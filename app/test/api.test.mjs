// Partner REST API (/api/v1): API key authentication, partner isolation, products, stock, orders
// (idempotent create, cancel rules), inbounds, pagination, rate limit and logging.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { startServer } from './helpers.mjs';

let srv;
let fx;
const KEYS = {};

const newKey = () => `flk_${randomBytes(32).toString('base64url')}`;
const sha = (s) => createHash('sha256').update(s).digest('hex');

async function addKey(name, partnerId, { revoked = false } = {}) {
  const key = newKey();
  await srv.sql(`INSERT INTO api_keys (partner_id, name, prefix, key_hash, revoked_at)
    VALUES (${partnerId}, '${name}', '${key.slice(0, 12)}', '${sha(key)}', ${revoked ? "'2026-10-01T00:00:00.000Z'" : 'NULL'})`);
  KEYS[name] = key;
  return key;
}

// Plain fetch client for the partner API: Bearer key, JSON in and out.
function api(key) {
  const call = async (method, path, body, headers = {}) => {
    const h = { accept: 'application/json', ...headers };
    if (key) h.authorization = `Bearer ${key}`;
    let payload;
    if (body !== undefined) {
      h['content-type'] = h['content-type'] || 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(`${srv.base}/api/v1${path}`, { method, headers: h, body: payload });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b, h) => call('POST', p, b, h),
    put: (p, b, h) => call('PUT', p, b, h),
    del: (p) => call('DELETE', p),
    raw: call,
  };
}

let A;
let B;

const ORDER = {
  external_id: 'WEB-1001',
  external_number: '#1001',
  customer_name: 'Minta Mária',
  email: 'Maria@Example.com',
  phone: '+36301234567',
  zip: '1111',
  city: 'Budapest',
  address: 'Fő utca 1.',
  carrier_code: 'gls',
  cod_amount: 12990,
  lines: [{ sku: 'KB-1001', qty: 1 }, { sku: 'KB-1003', qty: 2, external_line_id: 'L2' }],
};

before(async () => {
  srv = await startServer();
  await srv.admin();
  fx = await srv.seedBasics();
  await srv.sql(`INSERT INTO partners (id, type, code, name, status) VALUES (103, 'client', 'ALVO', 'Alvó Ügyfél Kft.', 'inactive'),
    (104, 'supplier', 'BESZ', 'Beszállító Bt.', 'active')`);
  await addKey('a', fx.clients.kutya);
  await addKey('a2', fx.clients.kutya);
  await addKey('b', fx.clients.konyha);
  await addKey('revoked', fx.clients.kutya, { revoked: true });
  await addKey('inactive', 103);
  await addKey('supplier', 104);
  A = api(KEYS.a);
  B = api(KEYS.b);
});
after(async () => { await srv.stop(); });

test('authentication: missing, malformed, unknown, revoked and inactive keys are refused', async () => {
  for (const [label, client] of [
    ['missing', api(null)],
    ['malformed', api('not-a-key')],
    ['unknown', api(newKey())],
    ['revoked', api(KEYS.revoked)],
    ['inactive partner', api(KEYS.inactive)],
    ['not a client', api(KEYS.supplier)],
  ]) {
    const r = await client.get('/me');
    assert.equal(r.status, 401, label);
    assert.equal(r.data.error.code, 'unauthorized', label);
    assert.match(r.data.error.message, /API kulcs/, label);
  }
  const me = await A.get('/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.data.partner, { code: 'KUTYA', name: 'Kutyabarát Webshop Kft.' });
  assert.equal(me.headers.get('x-ratelimit-limit'), '120');
  assert.ok(Number(me.headers.get('x-ratelimit-remaining')) < 120);
  const used = await srv.query('SELECT last_used_at FROM api_keys WHERE prefix = ?', KEYS.a.slice(0, 12));
  assert.ok(used[0].last_used_at, 'last_used_at is recorded');

  const unknown = await A.get('/nincs-ilyen');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.error.code, 'not_found');
  const wrongMethod = await A.del('/products');
  assert.equal(wrongMethod.status, 405);
});

test('documentation page is served as HTML', async () => {
  const r = await A.get('/docs');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.data, /<h1 id="fully-logistics-partner-api">Fully Logistics partner API/);
  assert.match(r.data, /<table>/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  const md = await A.get('/docs.md');
  assert.equal(md.status, 200);
  assert.match(md.data, /^# Fully Logistics partner API/);
});

test('documentation is public, everything else still needs a key', async () => {
  const r = await api(null).get('/docs');
  assert.equal(r.status, 200);
  assert.equal((await api(null).get('/docs.md')).status, 200);
  assert.equal((await api(null).get('/products')).status, 401);
  assert.equal((await api(null).get('/nincs-ilyen')).status, 401);
});

test('products: list is limited to the partner, cursor pagination', async () => {
  const all = await A.get('/products');
  assert.equal(all.status, 200);
  assert.equal(all.data.total, 3);
  assert.deepEqual(all.data.items.map((p) => p.sku), ['KB-1001', 'KB-1002', 'KB-1003']);
  assert.equal(all.data.next_cursor, null);
  assert.deepEqual(Object.keys(all.data.items[0]).sort(), ['active', 'created_at', 'depth_cm', 'ean', 'height_cm', 'min_stock', 'name', 'sku', 'unit', 'updated_at', 'weight_kg', 'width_cm']);

  const p1 = await A.get('/products?limit=2');
  assert.equal(p1.data.items.length, 2);
  assert.ok(p1.data.next_cursor);
  const p2 = await A.get(`/products?limit=2&cursor=${encodeURIComponent(p1.data.next_cursor)}`);
  assert.deepEqual(p2.data.items.map((p) => p.sku), ['KB-1003']);
  assert.equal(p2.data.next_cursor, null);

  const filtered = await A.get('/products?sku=KB-1002,KG-2001');
  assert.deepEqual(filtered.data.items.map((p) => p.sku), ['KB-1002'], 'another partner\'s SKU is not listed');

  const bad = await A.get('/products?cursor=%%%');
  assert.equal(bad.status, 400);
  assert.ok(bad.data.error.fields.cursor);

  const own = await A.get('/products/KB-1001');
  assert.equal(own.status, 200);
  assert.equal(own.data.name, 'Prémium kutyatáp 12 kg');
  const foreign = await A.get('/products/KG-2001');
  assert.equal(foreign.status, 404);
  const b = await B.get('/products');
  assert.deepEqual(b.data.items.map((p) => p.sku), ['KG-2001', 'KG-2002', 'KG-2003']);
});

test('products: PUT creates, updates only what was sent, validates, and is audited', async () => {
  const created = await A.put('/products/KB-2001', { name: 'Jutalomfalat 200 g', ean: '5990000020014', weight_kg: 0.25, min_stock: 30 });
  assert.equal(created.status, 201);
  assert.equal(created.data.sku, 'KB-2001');
  assert.equal(created.data.unit, 'db');
  assert.equal(created.data.weight_kg, 0.25);
  assert.equal(created.data.active, true);

  const updated = await A.put('/products/KB-2001', { min_stock: 40, height_cm: 12.5 });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.min_stock, 40);
  assert.equal(updated.data.height_cm, 12.5);
  assert.equal(updated.data.name, 'Jutalomfalat 200 g', 'fields not sent stay');
  assert.equal(updated.data.ean, '5990000020014');

  const noName = await A.put('/products/KB-2002', { ean: '123' });
  assert.equal(noName.status, 400);
  assert.ok(noName.data.error.fields.name);
  const unknown = await A.put('/products/KB-2001', { name: 'x', colour: 'red' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.data.error.fields.colour, 'Ismeretlen mező.');
  const mismatch = await A.put('/products/KB-2001', { sku: 'MAS', name: 'x' });
  assert.equal(mismatch.status, 400);
  assert.ok(mismatch.data.error.fields.sku);
  const negative = await A.put('/products/KB-2001', { weight_kg: -1 });
  assert.equal(negative.status, 400);
  assert.ok(negative.data.error.fields.weight_kg);
  const badJson = await A.put('/products/KB-2001', '{"name":');
  assert.equal(badJson.status, 400);
  assert.match(badJson.data.error.message, /Hibás JSON/);

  // The same SKU at another partner is a different product; A's stays untouched.
  const other = await B.put('/products/KB-2001', { name: 'Konyhai cikk ugyanazzal a kóddal' });
  assert.equal(other.status, 201);
  const mine = await A.get('/products/KB-2001');
  assert.equal(mine.data.name, 'Jutalomfalat 200 g');
  const rows = await srv.query("SELECT partner_id FROM products WHERE sku = 'KB-2001' ORDER BY partner_id");
  assert.deepEqual(rows.map((r) => r.partner_id), [fx.clients.kutya, fx.clients.konyha]);

  const auditRows = await srv.query("SELECT actor, module, action, summary FROM audit_log WHERE entity = 'product' ORDER BY id");
  assert.equal(auditRows[0].actor, 'API: Kutyabarát Webshop Kft.');
  assert.deepEqual(auditRows.slice(0, 2).map((r) => `${r.module}:${r.action}`), ['stock:create', 'stock:edit']);
  const logs = await srv.query("SELECT action, ok, status, direction, partner_id FROM integration_log WHERE system = 'api' AND action LIKE 'products.%' ORDER BY id");
  assert.ok(logs.some((l) => l.action === 'products.create' && l.ok === 1 && l.status === 201 && l.direction === 'in' && l.partner_id === fx.clients.kutya));
  assert.ok(logs.some((l) => l.action === 'products.upsert' && l.ok === 0 && l.status === 400), 'refused writes are logged');
});

test('stock: on hand, reserved, blocked and available per SKU, lots, isolation', async () => {
  const list = await A.get('/stock?sku=KB-1001,KB-1002');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.items, [
    { sku: 'KB-1001', name: 'Prémium kutyatáp 12 kg', on_hand: 50, reserved: 0, blocked: 0, available: 50 },
    { sku: 'KB-1002', name: 'Macskaalom 10 l', on_hand: 25, reserved: 0, blocked: 0, available: 25 },
  ]);
  const one = await A.get('/stock/KB-1001');
  assert.deepEqual(one.data.lots, [
    { lot: 'L2409', expiry: '2027-01-31', qty: 10, blocked: 0 },
    { lot: 'L2410', expiry: '2027-03-31', qty: 40, blocked: 0 },
  ]);
  const everything = await A.get('/stock?limit=2');
  assert.equal(everything.data.items.length, 2);
  assert.ok(everything.data.next_cursor);
  assert.equal(everything.data.total, 4, 'three fixture products and KB-2001');
  assert.equal((await B.get('/stock/KB-1001')).status, 404);
  const bStock = await B.get('/stock');
  assert.ok(bStock.data.items.every((s) => s.sku.startsWith('KG-') || s.sku === 'KB-2001'));
});

test('orders: create is idempotent by external_id and reserves stock', async () => {
  const first = await A.post('/orders', ORDER);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const o = first.data;
  assert.match(o.number, /^R-\d{4}-\d{6}$/);
  assert.equal(o.status, 'new');
  assert.equal(o.status_label, 'Új');
  assert.equal(o.source, 'api');
  assert.equal(o.email, 'maria@example.com');
  assert.equal(o.carrier_code, 'gls');
  assert.equal(o.cod_amount, 12990);
  assert.deepEqual(o.lines, [
    { sku: 'KB-1001', name: 'Prémium kutyatáp 12 kg', qty: 1, picked_qty: 0, external_line_id: '' },
    { sku: 'KB-1003', name: 'Rágócsont, 3 db', qty: 2, picked_qty: 0, external_line_id: 'L2' },
  ]);

  const again = await A.post('/orders', { ...ORDER, customer_name: 'Valaki Más' });
  assert.equal(again.status, 200);
  assert.equal(again.data.number, o.number);
  assert.equal(again.data.customer_name, 'Minta Mária', 'the existing order is returned unchanged');
  const count = await srv.query("SELECT COUNT(*) AS n FROM orders WHERE external_id = 'WEB-1001'");
  assert.equal(count[0].n, 1);

  // Another partner may use the same external_id: it is a separate order.
  const bOrder = await B.post('/orders', { ...ORDER, lines: [{ sku: 'KG-2002', qty: 1 }] });
  assert.equal(bOrder.status, 201);
  assert.notEqual(bOrder.data.number, o.number);

  const stock = await A.get('/stock/KB-1001');
  assert.equal(stock.data.reserved, 1);
  assert.equal(stock.data.available, 49);

  const auditRow = await srv.query("SELECT actor FROM audit_log WHERE entity = 'order' AND entity_id = ?", String((await srv.query('SELECT id FROM orders WHERE number = ?', o.number))[0].id));
  assert.equal(auditRow[0].actor, 'API: Kutyabarát Webshop Kft.');
  const logs = await srv.query("SELECT status, message FROM integration_log WHERE system = 'api' AND action = 'orders.create' AND partner_id = ? ORDER BY id", fx.clients.kutya);
  assert.deepEqual(logs.map((l) => l.status), [201, 200]);
});

test('orders: validation refuses missing external_id, unknown fields and SKUs of other partners', async () => {
  const noRef = await A.post('/orders', { ...ORDER, external_id: undefined });
  assert.equal(noRef.status, 400);
  assert.ok(noRef.data.error.fields.external_id);
  const extra = await A.post('/orders', { ...ORDER, external_id: 'WEB-X1', partner_id: fx.clients.konyha });
  assert.equal(extra.status, 400);
  assert.equal(extra.data.error.fields.partner_id, 'Ismeretlen mező.');
  const lineExtra = await A.post('/orders', { ...ORDER, external_id: 'WEB-X2', lines: [{ sku: 'KB-1001', qty: 1, product_id: 1101 }] });
  assert.equal(lineExtra.status, 400);
  assert.ok(lineExtra.data.error.fields['lines.0.product_id']);
  const foreign = await A.post('/orders', { ...ORDER, external_id: 'WEB-X3', lines: [{ sku: 'KB-1001', qty: 1 }, { sku: 'KG-2001', qty: 1 }] });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.data.error.fields['lines.1.sku'], 'Ismeretlen cikkszám: KG-2001');
  const noLines = await A.post('/orders', { ...ORDER, external_id: 'WEB-X4', lines: [] });
  assert.equal(noLines.status, 400);
  const badDate = await A.post('/orders', { ...ORDER, external_id: 'WEB-X5', ordered_at: 'tegnap' });
  assert.equal(badDate.status, 400);
  assert.ok(badDate.data.error.fields.ordered_at);
  const badQty = await A.post('/orders', { ...ORDER, external_id: 'WEB-X6', lines: [{ sku: 'KB-1001', qty: 0 }] });
  assert.equal(badQty.status, 400);
  assert.ok(badQty.data.error.fields['lines.0.qty']);
  const created = await srv.query("SELECT COUNT(*) AS n FROM orders WHERE external_id LIKE 'WEB-X%'");
  assert.equal(created[0].n, 0);
});

test('orders: lookup by number or external_id, lists with filters and cursor, isolation', async () => {
  const byRef = await A.get('/orders/WEB-1001');
  assert.equal(byRef.status, 200);
  const byNumber = await A.get(`/orders/${byRef.data.number}`);
  assert.equal(byNumber.data.external_id, 'WEB-1001');
  assert.equal(byNumber.data.customer_name, 'Minta Mária');
  // B used the same external_id: each partner sees its own order only.
  const bView = await B.get('/orders/WEB-1001');
  assert.notEqual(bView.data.number, byRef.data.number);
  assert.equal((await B.get(`/orders/${byRef.data.number}`)).status, 404);
  assert.equal((await B.post(`/orders/${byRef.data.number}/cancel`)).status, 404);

  for (let i = 2; i <= 4; i++) {
    const r = await A.post('/orders', { ...ORDER, external_id: `WEB-100${i}`, lines: [{ sku: 'KB-1002', qty: 1 }] });
    assert.equal(r.status, 201);
  }
  const list = await A.get('/orders?limit=3');
  assert.equal(list.data.total, 4);
  assert.equal(list.data.items.length, 3);
  const rest = await A.get(`/orders?limit=3&cursor=${encodeURIComponent(list.data.next_cursor)}`);
  assert.equal(rest.data.items.length, 1);
  assert.equal(rest.data.next_cursor, null);
  const ids = [...list.data.items, ...rest.data.items].map((o) => o.external_id);
  assert.deepEqual(ids.sort(), ['WEB-1001', 'WEB-1002', 'WEB-1003', 'WEB-1004']);
  assert.ok(list.data.items.every((o) => Array.isArray(o.lines) && o.lines.length));

  await srv.sql(`UPDATE orders SET status = 'shipped', tracking_number = '00123456789', updated_at = '2030-01-01T00:00:00.000Z' WHERE external_id = 'WEB-1004' AND partner_id = ${fx.clients.kutya}`);
  const shipped = await A.get('/orders?status=shipped');
  assert.deepEqual(shipped.data.items.map((o) => o.external_id), ['WEB-1004']);
  assert.equal(shipped.data.items[0].tracking_number, '00123456789');
  assert.equal(shipped.data.items[0].tracking_url, 'https://gls-group.com/HU/hu/csomagkovetes?match=00123456789');
  const recent = await A.get('/orders?updated_since=2029-12-31T00:00:00Z');
  assert.deepEqual(recent.data.items.map((o) => o.external_id), ['WEB-1004']);
  const badStatus = await A.get('/orders?status=elkuldve');
  assert.equal(badStatus.status, 400);
  assert.ok(badStatus.data.error.fields.status);
  const badSince = await A.get('/orders?updated_since=tegnap');
  assert.equal(badSince.status, 400);
  assert.equal((await B.get('/orders')).data.total, 1);
});

test('orders: cancel only while new or on hold, through the order lifecycle', async () => {
  const cancel = await A.post('/orders/WEB-1002/cancel', { reason: 'A vevő visszamondta' });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
  assert.equal(cancel.data.status, 'cancelled');
  assert.ok(cancel.data.cancelled_at);
  const [row] = await srv.query("SELECT id FROM orders WHERE external_id = 'WEB-1002' AND partner_id = ?", fx.clients.kutya);
  const events = await srv.query("SELECT type, text FROM order_events WHERE order_id = ? AND type = 'status'", row.id);
  assert.deepEqual(events.map((e) => e.text), ['Sztornózva az API-n: A vevő visszamondta']);
  const auditRows = await srv.query("SELECT action, actor FROM audit_log WHERE entity = 'order' AND entity_id = ? AND action = 'delete'", String(row.id));
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].actor, 'API: Kutyabarát Webshop Kft.');

  const again = await A.post('/orders/WEB-1002/cancel');
  assert.equal(again.status, 200, 'cancelling twice is fine');
  assert.equal(again.data.status, 'cancelled');

  await srv.sql(`UPDATE orders SET status = 'hold' WHERE external_id = 'WEB-1003' AND partner_id = ${fx.clients.kutya}`);
  const fromHold = await A.post('/orders/WEB-1003/cancel', {});
  assert.equal(fromHold.status, 200);
  assert.equal(fromHold.data.status, 'cancelled');

  await srv.sql(`UPDATE orders SET status = 'picking' WHERE external_id = 'WEB-1001' AND partner_id = ${fx.clients.kutya}`);
  const picking = await A.post('/orders/WEB-1001/cancel');
  assert.equal(picking.status, 409);
  assert.match(picking.data.error.message, /Komissió alatt/);
  const shipped = await A.post('/orders/WEB-1004/cancel');
  assert.equal(shipped.status, 409);

  // Still "new", but already planned into a picking wave: not cancellable here either.
  const inWave = await A.post('/orders', { ...ORDER, external_id: 'WEB-1005', lines: [{ sku: 'KB-1002', qty: 1 }] });
  await srv.sql(`INSERT INTO waves (id, number, status) VALUES (1, 'H-2026-00001', 'open');
    UPDATE orders SET wave_id = 1 WHERE number = '${inWave.data.number}'`);
  const waved = await A.post('/orders/WEB-1005/cancel');
  assert.equal(waved.status, 409);
  assert.match(waved.data.error.message, /komissiós hullámba/);

  const unknownField = await A.post('/orders/WEB-1001/cancel', { why: 'x' });
  assert.equal(unknownField.status, 400);
  const status = await srv.query("SELECT status FROM orders WHERE external_id = 'WEB-1001' AND partner_id = ?", fx.clients.kutya);
  assert.equal(status[0].status, 'picking');

  // Released reservation: cancelled orders no longer count as reserved.
  const stock = await A.get('/stock/KB-1002');
  assert.equal(stock.data.reserved, 1, 'WEB-1002 and WEB-1003 cancelled, WEB-1004 shipped, only WEB-1005 still reserves');
});

test('inbounds: ASN create is idempotent by external_ref, lookup, isolation', async () => {
  const body = {
    external_ref: 'SZL-0815', expected_date: '2026-10-20', pallets: 2,
    lines: [{ sku: 'KB-1001', expected_qty: 120, lot: 'L2411', expiry: '2027-05-31' }, { sku: 'KB-1002', expected_qty: 60 }],
  };
  const r = await A.post('/inbounds', body);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.number, /^BT-\d{4}-\d{5}$/);
  assert.equal(r.data.status, 'expected');
  assert.equal(r.data.source, 'api');
  assert.deepEqual(r.data.lines.map((l) => [l.sku, l.expected_qty, l.lot, l.expiry]), [['KB-1001', 120, 'L2411', '2027-05-31'], ['KB-1002', 60, '', '']]);
  const again = await A.post('/inbounds', body);
  assert.equal(again.status, 200);
  assert.equal(again.data.number, r.data.number);
  assert.equal((await srv.query("SELECT COUNT(*) AS n FROM inbounds WHERE external_ref = 'SZL-0815'"))[0].n, 1);

  const byRef = await A.get('/inbounds/SZL-0815');
  assert.equal(byRef.data.number, r.data.number);
  const byNumber = await A.get(`/inbounds/${r.data.number}`);
  assert.equal(byNumber.data.external_ref, 'SZL-0815');
  assert.equal((await B.get(`/inbounds/${r.data.number}`)).status, 404);
  assert.equal((await B.get('/inbounds')).data.total, 0);
  assert.equal((await A.get('/inbounds?status=expected')).data.total, 1);

  const noRef = await A.post('/inbounds', { ...body, external_ref: '' });
  assert.equal(noRef.status, 400);
  assert.ok(noRef.data.error.fields.external_ref);
  const foreign = await A.post('/inbounds', { ...body, external_ref: 'SZL-0816', lines: [{ sku: 'KG-2001', expected_qty: 1 }] });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.data.error.fields['lines.0.sku'], 'Ismeretlen cikkszám: KG-2001');
  const supplier = await A.post('/inbounds', { ...body, external_ref: 'SZL-0817', supplier_id: 201 });
  assert.equal(supplier.status, 400, 'internal ids are not accepted');
});

test('rate limit: 429 with Retry-After above the per key limit', async () => {
  const [{ id }] = await srv.query('SELECT id FROM api_keys WHERE prefix = ?', KEYS.a2.slice(0, 12));
  const bucket = Math.floor(Date.now() / 60000);
  // Fill this minute (and the next, in case the minute turns during the test).
  await srv.sql(`INSERT INTO api_rate_limits (key_id, bucket, count) VALUES (${id}, ${bucket}, 120), (${id}, ${bucket + 1}, 120)`);
  const r = await api(KEYS.a2).get('/me');
  assert.equal(r.status, 429);
  assert.equal(r.data.error.code, 'rate_limited');
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal(r.headers.get('x-ratelimit-remaining'), '0');
  // Other keys have their own counter.
  assert.equal((await A.get('/me')).status, 200);
});
