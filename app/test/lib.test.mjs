// Shared library functions, called directly inside the Worker (test/test-worker.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

let srv;
let fx;
before(async () => {
  srv = await startServer();
  await srv.admin();
  fx = await srv.seedBasics();
});
after(async () => { await srv.stop(); });

const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r)); return r.result; };

test('createOrder: validates, resolves SKUs, de-duplicates imports', async () => {
  const input = {
    partner_id: fx.clients.kutya, source: 'shopify', external_id: 'gid-1', external_number: '#1001',
    customer_name: 'Minta Mária', zip: '1111', city: 'Budapest', address: 'Fő utca 1.', carrier_code: 'gls',
    lines: [{ sku: 'KB-1001', qty: 2 }, { sku: 'KB-1003', qty: 3 }],
  };
  const first = ok(await srv.call('orderCreate.createOrder', [input], { as: 1 }));
  assert.match(first.number, /^R-\d{4}-\d{6}$/);
  assert.equal(first.duplicate, false);
  const again = ok(await srv.call('orderCreate.createOrder', [input], { as: 1 }));
  assert.equal(again.id, first.id);
  assert.equal(again.duplicate, true);
  const [order] = await srv.query('SELECT status, carrier_id FROM orders WHERE id = ?', first.id);
  assert.equal(order.status, 'new');
  assert.equal(order.carrier_id, fx.carriers.gls);
  const lines = await srv.query('SELECT product_id, qty FROM order_lines WHERE order_id = ? ORDER BY id', first.id);
  assert.deepEqual(lines, [{ product_id: fx.products.tap, qty: 2 }, { product_id: fx.products.csont, qty: 3 }]);

  // A product of another partner is not visible to this partner.
  const wrong = await srv.call('orderCreate.createOrder', [{ ...input, external_id: 'gid-2', lines: [{ sku: 'KG-2001', qty: 1 }] }], { as: 1 });
  assert.equal(wrong.ok, false);
  assert.match(JSON.stringify(wrong.fields), /Ismeretlen cikkszám: KG-2001/);
  const missing = await srv.call('orderCreate.createOrder', [{ partner_id: fx.clients.kutya, lines: [] }], { as: 1 });
  assert.equal(missing.ok, false);
  assert.ok(missing.fields.customer_name);
});

test('createOrder: several manual orders without an external id', async () => {
  const base = { partner_id: fx.clients.kutya, customer_name: 'Kézi Rendelés', lines: [{ sku: 'KB-1003', qty: 1 }] };
  const a = ok(await srv.call('orderCreate.createOrder', [base], { as: 1 }));
  const b = ok(await srv.call('orderCreate.createOrder', [base], { as: 1 }));
  assert.notEqual(a.id, b.id);
  assert.equal(b.duplicate, false);
});

test('createInbound', async () => {
  const r = ok(await srv.call('inboundCreate.createInbound', [{
    partner_id: fx.clients.konyha, supplier_id: null, expected_date: '2026-10-20',
    lines: [{ sku: 'KG-2001', expected_qty: 10 }, { product_id: fx.products.mixer, expected_qty: 24 }],
  }], { as: 1 }));
  assert.match(r.number, /^BT-\d{4}-\d{5}$/);
  const lines = await srv.query('SELECT product_id, expected_qty FROM inbound_lines WHERE inbound_id = ? ORDER BY id', r.id);
  assert.deepEqual(lines, [{ product_id: fx.products.robot, expected_qty: 10 }, { product_id: fx.products.mixer, expected_qty: 24 }]);

  await srv.sql(`UPDATE products SET active = 0 WHERE id = ${fx.products.forralo}`);
  const inactive = await srv.call('inboundCreate.createInbound', [{
    partner_id: fx.clients.konyha, expected_date: '2026-10-20', lines: [{ product_id: fx.products.forralo, expected_qty: 1 }],
  }], { as: 1 });
  assert.equal(inactive.ok, false);
  assert.match(JSON.stringify(inactive), /Inaktív termék/);
  await srv.sql(`UPDATE products SET active = 1 WHERE id = ${fx.products.forralo}`);
});

test('stock: add, remove with guard, transfer, set, one partner per location', async () => {
  const P = fx.products.alom; // 25 at location 20
  ok(await srv.call('stock.addStock', [{ productId: P, locationId: 21, qty: 5, type: 'inbound', refType: 'inbound', refId: 1 }], { as: 1 }));
  const tooMuch = await srv.call('stock.removeStock', [{ productId: P, locationId: 21, qty: 6, type: 'pick' }], { as: 1 });
  assert.equal(tooMuch.ok, false);
  assert.equal(tooMuch.status, 409);
  assert.match(tooMuch.error, /Nincs elég készlet/);
  ok(await srv.call('stock.removeStock', [{ productId: P, locationId: 21, qty: 5, type: 'pick' }], { as: 1 }));
  assert.equal((await srv.query('SELECT COUNT(*) AS n FROM stock WHERE product_id = ? AND location_id = 21', P))[0].n, 0, 'empty rows are deleted');

  ok(await srv.call('stock.transferStock', [{ productId: P, fromLocationId: 20, toLocationId: 22, qty: 5 }], { as: 1 }));
  const rows = await srv.query('SELECT location_id, qty FROM stock WHERE product_id = ? ORDER BY location_id', P);
  assert.deepEqual(rows, [{ location_id: 20, qty: 20 }, { location_id: 22, qty: 5 }]);

  // Location 26 holds Konyhagép goods: Kutyabarát goods may not go there.
  const mixed = await srv.call('stock.addStock', [{ productId: P, locationId: 26, qty: 1, type: 'inbound' }], { as: 1 });
  assert.equal(mixed.ok, false);
  assert.match(mixed.error, /Egy helyen csak egy partner áruja lehet/);

  const diff = ok(await srv.call('stock.setStockQty', [{ productId: P, locationId: 22, qty: 2, refType: 'count', refId: 9 }], { as: 1 }));
  assert.equal(diff, -3);
  const ledger = await srv.query("SELECT type, qty FROM movements WHERE product_id = ? ORDER BY id", P);
  assert.deepEqual(ledger.map((m) => `${m.type}:${m.qty}`), ['inbound:5', 'pick:-5', 'transfer_out:-5', 'transfer_in:5', 'adjust:-3']);
});

test('availability counts open orders and quarantine; allocate is FEFO', async () => {
  const T = fx.products.tap; // 40 (exp 2027-03-31) at 18, 10 (exp 2027-01-31) at 19, order of 2 open
  ok(await srv.call('stock.addStock', [{ productId: T, locationId: fx.locations.quarantine, qty: 3, type: 'return' }], { as: 1 }));
  const a = ok(await srv.call('stock.availability', [[T]]));
  assert.deepEqual(a[T], { onHand: 53, blocked: 3, reserved: 2, available: 48 });
  const plan = ok(await srv.call('stock.allocate', [T, 15]));
  assert.deepEqual(plan.plan.map((p) => [p.code, p.qty, p.expiry]), [['B-01-02', 10, '2027-01-31'], ['B-01-01', 5, '2027-03-31']]);
  assert.equal(plan.missing, 0);
  assert.equal(ok(await srv.call('stock.allocate', [T, 60])).missing, 10);
});

test('order lifecycle is enforced', async () => {
  const { id } = ok(await srv.call('orderCreate.createOrder', [{ partner_id: fx.clients.kutya, customer_name: 'Teszt Elek', lines: [{ sku: 'KB-1002', qty: 1 }] }], { as: 1 }));
  const bad = await srv.call('orders.setOrderStatus', [id, 'shipped'], { as: 1 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /nem tehető át/);
  ok(await srv.call('orders.setOrderStatus', [id, 'hold', 'Ügyfél kérésére'], { as: 1 }));
  ok(await srv.call('orders.setOrderStatus', [id, 'cancelled'], { as: 1 }));
  const events = await srv.query('SELECT type, text FROM order_events WHERE order_id = ? ORDER BY id', id);
  assert.deepEqual(events.map((e) => e.type), ['created', 'status', 'status']);
  assert.equal(events[1].text, 'Ügyfél kérésére');
});

test('accounts: credentials are encrypted and merged', async () => {
  ok(await srv.call('accounts.saveCourierAccount', ['gls', { credentials: { username: 'u', password: 'p1' }, settings: { client_number: '123' }, active: true }]));
  ok(await srv.call('accounts.saveCourierAccount', ['gls', { credentials: { username: '', password: 'p2' } }]));
  const acc = ok(await srv.call('accounts.getCourierAccount', ['gls']));
  assert.deepEqual(acc.credentials, { username: 'u', password: 'p2' });
  assert.equal(acc.active, true);
  const [row] = await srv.query("SELECT credentials FROM courier_accounts WHERE carrier_code = 'gls'");
  assert.match(row.credentials, /^v1:/);
  assert.ok(!row.credentials.includes('p2'));
  ok(await srv.call('accounts.saveInvoicingConfig', [{ provider: 'billingo', settings: { billingo: { block_id: 5 } }, credentials: { billingo: { api_key: 'k' } } }]));
  const inv = ok(await srv.call('accounts.getInvoicingConfig', []));
  assert.equal(inv.provider, 'billingo');
  assert.deepEqual(inv.settings.billingo, { block_id: 5 });
  assert.deepEqual(inv.credentials.billingo, { api_key: 'k' });
});
