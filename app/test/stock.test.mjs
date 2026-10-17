// Készlet and Cikktörzs: overview with availability, product page, ledger, transfer, adjustment,
// location occupancy, products CRUD, deactivation and CSV import / export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

let srv;
let fx;
let admin;
let manager;
let operator;
let service;

// Fixture locations: A-01-01..08 = 10..17 (M), B-01-01..06 = 18..23 (L), C = 24..27 (XL), P = 28..31 (PAL).
const LOC = { a01: 10, a02: 11, a06: 15, a07: 16, b03: 20, b04: 21, c03: 26 };

before(async () => {
  srv = await startServer();
  admin = await srv.admin();
  fx = await srv.seedBasics();
  manager = await srv.userWithRole('warehouse_manager', 'vezeto@example.com');
  operator = await srv.userWithRole('warehouse_operator', 'raktaros@example.com');
  service = await srv.userWithRole('customer_service', 'ugyfelszolgalat@example.com');
});
after(async () => { await srv.stop(); });

const csvForm = (text, preview) => {
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/csv' }), 'cikkek.csv');
  form.append('preview', preview ? '1' : '0');
  return form;
};
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };

test('stock overview: availability, status, filters, paging', async () => {
  // An open order reserves 5 alom; a quarantined tap is blocked.
  const order = await srv.call('orderCreate.createOrder', [{ partner_id: fx.clients.kutya, customer_name: 'Teszt Vevő', lines: [{ sku: 'KB-1002', qty: 5 }] }], { as: 1 });
  assert.equal(order.ok, true, JSON.stringify(order));
  await srv.call('stock.addStock', [{ productId: fx.products.tap, locationId: fx.locations.quarantine, qty: 2, lot: 'SER', type: 'return' }], { as: 1 });
  await srv.sql('UPDATE products SET min_stock = 400 WHERE id = 1003');
  await srv.sql("INSERT INTO products (id, partner_id, sku, name, min_stock) VALUES (1004, 101, 'KB-1004', 'Kutyapóráz', 5)");

  const r = ok(await operator.get('/api/stock'));
  const by = Object.fromEntries(r.items.map((i) => [i.sku, i]));
  assert.deepEqual(
    [by['KB-1001'].on_hand, by['KB-1001'].blocked, by['KB-1001'].available, by['KB-1001'].locations],
    [52, 2, 50, 3],
  );
  assert.deepEqual([by['KB-1002'].on_hand, by['KB-1002'].reserved, by['KB-1002'].available], [25, 5, 20]);
  assert.equal(by['KB-1001'].status, 'ok');
  assert.equal(by['KB-1003'].status, 'low');
  assert.equal(by['KB-1004'].status, 'out');
  assert.equal(by['KB-1004'].status_label, 'Elfogyott');
  assert.equal(by['KB-1001'].next_expiry, '2027-01-31');
  assert.equal(r.summary.low, 1);
  assert.equal(r.summary.out, 1);

  const low = ok(await operator.get('/api/stock?low=1'));
  assert.deepEqual(low.items.map((i) => i.sku).sort(), ['KB-1003', 'KB-1004']);
  const konyha = ok(await operator.get(`/api/stock?partner_id=${fx.clients.konyha}`));
  assert.equal(konyha.total, 3);
  assert.ok(konyha.items.every((i) => i.partner_code === 'KONYHA'));
  const search = ok(await operator.get('/api/stock?q=mixer'));
  assert.deepEqual(search.items.map((i) => i.sku), ['KG-2002']);
  const out = ok(await operator.get('/api/stock?status=out'));
  assert.deepEqual(out.items.map((i) => i.sku), ['KB-1004']);
  const paged = ok(await operator.get('/api/stock?limit=2&offset=2'));
  assert.equal(paged.items.length, 2);
  assert.ok(paged.total >= 7);

  const csv = await operator.get('/api/stock/export?low=1');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /keszlet-\d{4}-\d{2}-\d{2}\.csv/);
  assert.ok(csv.data.startsWith('Ügyfélkód;Ügyfél;Cikkszám'), csv.data.slice(0, 40));
  const raw = await operator.get('/api/stock/export', { raw: true });
  assert.deepEqual([...new Uint8Array(await raw.arrayBuffer()).slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel');
  assert.match(csv.data, /KB-1004;Kutyapóráz/);
  assert.match(csv.data, /Elfogyott/);
});

test('product page: locations with lot and expiry, availability, reservations, movements', async () => {
  const d = ok(await operator.get(`/api/stock/product/${fx.products.tap}`));
  assert.equal(d.product.sku, 'KB-1001');
  assert.equal(d.product.partner_code, 'KUTYA');
  assert.deepEqual(d.locations.map((l) => [l.code, l.lot, l.expiry, l.qty]), [
    ['B-01-02', 'L2409', '2027-01-31', 10], ['B-01-01', 'L2410', '2027-03-31', 40], ['KARANTEN', 'SER', '', 2],
  ]);
  assert.equal(d.locations[2].kind_label, 'Karantén (zárolt)');
  assert.equal(d.availability.blocked, 2);
  assert.equal(d.availability.status, 'ok');
  const alom = ok(await operator.get(`/api/stock/product/${fx.products.alom}`));
  assert.equal(alom.reservations.length, 1);
  assert.equal(alom.reservations[0].qty, 5);
  assert.equal((await operator.get('/api/stock/product/999999')).status, 404);
  assert.equal(d.movements[0].type, 'return');
  assert.equal(d.movements[0].type_label, 'Visszáru');
});

test('transfer between locations: edit right, one partner per location, enough stock', async () => {
  const body = { product_id: fx.products.alom, from_location_id: LOC.b03, to_location_code: 'b-01-04', qty: 10, note: 'Polc átrendezés' };
  const denied = await operator.post('/api/stock/transfer', body);
  assert.equal(denied.status, 403);
  assert.match(denied.data.error.message, /áttárolás/);
  const done = ok(await manager.post('/api/stock/transfer', body));
  assert.equal(done.to, 'B-01-04');
  const rows = await srv.query('SELECT location_id, qty FROM stock WHERE product_id = ? ORDER BY location_id', fx.products.alom);
  assert.deepEqual(rows, [{ location_id: LOC.b03, qty: 15 }, { location_id: LOC.b04, qty: 10 }]);
  const moves = await srv.query("SELECT type, qty, ref_type, note FROM movements WHERE product_id = ? AND type LIKE 'transfer%' ORDER BY id", fx.products.alom);
  assert.deepEqual(moves.map((m) => [m.type, m.qty, m.ref_type]), [['transfer_out', -10, 'manual'], ['transfer_in', 10, 'manual']]);
  assert.equal(moves[0].note, 'Polc átrendezés');

  const mixed = await manager.post('/api/stock/transfer', { ...body, to_location_code: 'A-01-02' });
  assert.equal(mixed.status, 409);
  assert.match(mixed.data.error.message, /Egy helyen csak egy partner áruja lehet/);
  const tooMuch = await manager.post('/api/stock/transfer', { ...body, qty: 16, to_location_code: 'A-01-07' });
  assert.equal(tooMuch.status, 409);
  const same = await manager.post('/api/stock/transfer', { ...body, to_location_code: 'B-01-03' });
  assert.equal(same.status, 400);
  const unknown = await manager.post('/api/stock/transfer', { ...body, to_location_code: 'X-99' });
  assert.equal(unknown.status, 400);
  assert.ok(unknown.data.error.fields.to_location_code);
  const wrongLot = await manager.post('/api/stock/transfer', { ...body, lot: 'NINCS' });
  assert.equal(wrongLot.status, 400);
});

test('manual adjustment: approve right, mandatory reason, set, add and remove', async () => {
  const base = { product_id: fx.products.csont, location_id: LOC.a01, mode: 'set', qty: 290, reason: 'Leltáreltérés, 10 db hiányzott' };
  assert.equal((await operator.post('/api/stock/adjust', base)).status, 403);
  const noReason = await manager.post('/api/stock/adjust', { ...base, reason: '' });
  assert.equal(noReason.status, 400);
  assert.ok(noReason.data.error.fields.reason);
  const set = ok(await manager.post('/api/stock/adjust', base));
  assert.deepEqual([set.before, set.after, set.diff], [300, 290, -10]);
  const same = await manager.post('/api/stock/adjust', base);
  assert.equal(same.status, 400, 'nothing to change');

  const add = ok(await manager.post('/api/stock/adjust', { ...base, mode: 'add', qty: 5, reason: 'Talált áru' }));
  assert.equal(add.after, 295);
  const remove = ok(await manager.post('/api/stock/adjust', { ...base, mode: 'remove', qty: 15, reason: 'Sérült, selejtezve' }));
  assert.equal(remove.after, 280);
  const tooMuch = await manager.post('/api/stock/adjust', { ...base, mode: 'remove', qty: 281, reason: 'Selejt' });
  assert.equal(tooMuch.status, 409);

  const moves = await srv.query("SELECT type, qty, ref_type, note FROM movements WHERE product_id = ? AND type = 'adjust' ORDER BY id", fx.products.csont);
  assert.deepEqual(moves.map((m) => m.qty), [-10, 5, -15]);
  assert.ok(moves.every((m) => m.ref_type === 'manual'));
  assert.match(moves[0].note, /Leltáreltérés/);
  const log = await srv.query("SELECT action, summary FROM audit_log WHERE module = 'stock' AND action = 'approve' ORDER BY id");
  assert.equal(log.length, 3);
  assert.match(log[0].summary, /300 -> 290/);

  // New stock of a lot tracked product needs the lot; the location must take the partner's goods.
  const noLot = await manager.post('/api/stock/adjust', { product_id: fx.products.tap, location_code: 'A-01-06', mode: 'add', qty: 1, reason: 'Talált' });
  assert.equal(noLot.status, 400);
  assert.ok(noLot.data.error.fields.lot);
  const badDate = await manager.post('/api/stock/adjust', { product_id: fx.products.tap, location_code: 'A-01-06', mode: 'add', qty: 1, lot: 'X', expiry: '2027-02-30', reason: 'Talált' });
  assert.equal(badDate.status, 400);
  const foreign = await manager.post('/api/stock/adjust', { product_id: fx.products.tap, location_id: LOC.c03, mode: 'add', qty: 1, lot: 'X', expiry: '2027-02-28', reason: 'Talált' });
  assert.equal(foreign.status, 409);
});

test('movements: ledger with filters, reference numbers and CSV export', async () => {
  const { result: inbound } = await srv.call('inboundCreate.createInbound', [{ partner_id: fx.clients.konyha, lines: [{ sku: 'KG-2003', expected_qty: 3 }] }], { as: 1 });
  await srv.call('stock.addStock', [{ productId: fx.products.forralo, locationId: 12, qty: 3, type: 'inbound', refType: 'inbound', refId: inbound.id }], { as: 1 });

  const all = ok(await operator.get('/api/stock/movements'));
  assert.equal(all.total, 7);
  assert.ok(all.items[0].id > all.items[all.items.length - 1].id, 'newest first');
  const byType = ok(await operator.get('/api/stock/movements?type=adjust'));
  assert.ok(byType.items.length >= 3 && byType.items.every((m) => m.type === 'adjust' && m.type_label === 'Korrekció'));
  assert.equal(byType.sums.out, 25);
  const byProduct = ok(await operator.get(`/api/stock/movements?product_id=${fx.products.alom}`));
  assert.ok(byProduct.items.every((m) => m.sku === 'KB-1002'));
  const byPartner = ok(await operator.get(`/api/stock/movements?partner_id=${fx.clients.konyha}`));
  assert.ok(byPartner.items.every((m) => m.partner_code === 'KONYHA'));
  const byRef = ok(await operator.get(`/api/stock/movements?ref=${inbound.number}`));
  assert.equal(byRef.total, 1);
  assert.equal(byRef.items[0].ref_number, inbound.number);
  assert.equal(byRef.items[0].location_code, 'A-01-03');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Budapest' }).format(new Date());
  const range = ok(await operator.get(`/api/stock/movements?from=${today}&to=${today}`));
  assert.equal(range.total, all.total);
  const past = ok(await operator.get('/api/stock/movements?from=2020-01-01&to=2020-12-31'));
  assert.equal(past.total, 0);

  const csv = await operator.get(`/api/stock/movements/export?partner_id=${fx.clients.konyha}`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /keszletmozgasok/);
  assert.match(csv.data, /Betárolás;KONYHA;KG-2003/);
  assert.equal((await srv.userWithRole('sales', 'ertekesito@example.com').then((c) => c.get('/api/stock/movements'))).status, 200, 'sales may view stock');
});

test('location occupancy: who holds what, empty locations by size', async () => {
  const r = ok(await operator.get('/api/stock/locations?limit=200'));
  const m = r.summary.bySize.find((s) => s.code === 'M');
  assert.equal(m.total, 8);
  assert.equal(m.occupied + m.empty, 8);
  const occupiedM = await srv.query("SELECT COUNT(DISTINCT s.location_id) AS n FROM stock s JOIN locations l ON l.id = s.location_id WHERE l.size_id = 1 AND l.kind = 'storage' AND s.qty > 0");
  assert.equal(m.occupied, occupiedM[0].n);
  const kutya = r.summary.byPartner.find((p) => p.code === 'KUTYA');
  assert.ok(kutya.total >= 3);
  assert.ok(kutya.sizes.L >= 2);
  const a02 = r.items.find((l) => l.code === 'A-01-02');
  assert.equal(a02.occupant_code, 'KONYHA');
  assert.equal(a02.size_code, 'M');
  const empty = ok(await operator.get('/api/stock/locations?state=empty&size_id=4'));
  assert.ok(empty.items.length >= 1);
  assert.ok(empty.items.every((l) => !l.occupant_id && l.size_code === 'PAL'));
  const mine = ok(await operator.get(`/api/stock/locations?partner_id=${fx.clients.konyha}`));
  assert.ok(mine.items.every((l) => l.occupant_code === 'KONYHA' || l.dedicated_partner_id === fx.clients.konyha));
  const quarantine = ok(await operator.get('/api/stock/locations?kind=quarantine'));
  assert.deepEqual(quarantine.items.map((l) => l.code), ['KARANTEN']);
});

test('products: create with EAN warning, unique SKU per client, edit, permissions', async () => {
  const body = { partner_id: fx.clients.kutya, sku: 'KB-2000', name: 'Etetőtál', ean: '5990000010016', unit: 'db', weight_kg: '0,4', min_stock: 3, track_lot: false };
  assert.equal((await service.post('/api/products', body)).status, 403);
  assert.equal((await operator.post('/api/products', body)).status, 403);
  const created = ok(await manager.post('/api/products', body));
  assert.ok(created.id);
  assert.match(created.warnings[0], /ellenőrző számjegye hibás/);
  const [row] = await srv.query('SELECT sku, weight_kg, active FROM products WHERE id = ?', created.id);
  assert.deepEqual(row, { sku: 'KB-2000', weight_kg: 0.4, active: 1 });

  const dupe = await manager.post('/api/products', { ...body, sku: 'kb-2000' });
  assert.equal(dupe.status, 409);
  assert.ok(dupe.data.error.fields.sku);
  const otherClient = ok(await manager.post('/api/products', { ...body, partner_id: fx.clients.konyha, ean: '4006381333931' }));
  assert.deepEqual(otherClient.warnings, [], 'same SKU at another client is fine, valid EAN has no warning');
  const missing = await manager.post('/api/products', { partner_id: fx.clients.kutya });
  assert.equal(missing.status, 400);
  assert.ok(missing.data.error.fields.sku && missing.data.error.fields.name);
  const supplier = await manager.post('/api/products', { ...body, sku: 'X1', partner_id: fx.supplier });
  assert.equal(supplier.status, 400);

  assert.equal((await operator.patch(`/api/products/${created.id}`, { name: 'Új név' })).status, 403);
  const edited = ok(await manager.patch(`/api/products/${created.id}`, { name: 'Etetőtál, inox', ean: '5990000010022', track_expiry: true }));
  assert.deepEqual(edited.changed.sort(), ['ean', 'name', 'track_expiry']);
  assert.match(edited.warnings[0], /KB-1002 cikknél is/);
  const movePartner = await manager.patch(`/api/products/${created.id}`, { partner_id: fx.clients.konyha });
  assert.equal(movePartner.status, 400);
  const clash = await manager.patch(`/api/products/${created.id}`, { sku: 'KB-1001' });
  assert.equal(clash.status, 409);

  const list = ok(await operator.get(`/api/products?partner_id=${fx.clients.kutya}&q=etet`));
  assert.equal(list.total, 1);
  assert.equal(list.items[0].name, 'Etetőtál, inox');
  assert.equal(list.items[0].track_expiry, true);
  const detail = ok(await operator.get(`/api/products/${created.id}`));
  assert.equal(detail.can_deactivate, true);
  assert.equal(detail.usage.on_hand, 0);
  const log = await srv.query("SELECT summary FROM audit_log WHERE entity = 'product' AND entity_id = ? ORDER BY id", String(created.id));
  assert.deepEqual(log.map((l) => l.summary.split(':')[0]), ['Új cikk', 'Cikk módosítva']);
});

test('deactivate only without stock and open documents; inactive products cannot be ordered', async () => {
  assert.equal((await manager.post(`/api/products/${fx.products.mixer}/deactivate`)).status, 409, 'has stock');
  const p = ok(await manager.post('/api/products', { partner_id: fx.clients.konyha, sku: 'KG-9000', name: 'Kifutó termék' }));
  assert.equal((await operator.post(`/api/products/${p.id}/deactivate`)).status, 403);
  const { result: inb } = await srv.call('inboundCreate.createInbound', [{ partner_id: fx.clients.konyha, lines: [{ product_id: p.id, expected_qty: 1 }] }], { as: 1 });
  const blocked = await manager.post(`/api/products/${p.id}/deactivate`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error.message, /nyitott betárolásban/);
  await srv.sql(`UPDATE inbounds SET status = 'cancelled' WHERE id = ${inb.id}`);
  ok(await manager.post(`/api/products/${p.id}/deactivate`));
  assert.equal((await srv.query('SELECT active FROM products WHERE id = ?', p.id))[0].active, 0);

  const order = await srv.call('orderCreate.createOrder', [{ partner_id: fx.clients.konyha, customer_name: 'Vevő', lines: [{ sku: 'KG-9000', qty: 1 }] }], { as: 1 });
  assert.equal(order.ok, false);
  assert.match(JSON.stringify(order.fields), /Inaktív cikk/);
  const inactive = ok(await operator.get(`/api/products?active=0&partner_id=${fx.clients.konyha}`));
  assert.deepEqual(inactive.items.map((i) => i.sku), ['KG-9000']);
  const lookup = ok(await operator.get(`/api/lookup/products?partner_id=${fx.clients.konyha}&q=KG-9000`));
  assert.equal(lookup.items.length, 0, 'inactive products are not offered');

  ok(await manager.post(`/api/products/${p.id}/activate`));
  assert.equal((await srv.query('SELECT active FROM products WHERE id = ?', p.id))[0].active, 1);
});

test('products CSV import: preview, create and update by SKU of the client, export round trip', async () => {
  const csv = [
    'Ügyfélkód;Cikkszám;Megnevezés;EAN;Egység;Súly (kg);Méretek (cm);Minimum készlet;Sarzskövetés;Lejáratkövetés',
    'KUTYA;KB-3000;Jutalomfalat 200 g;5990000030013;db;0,2;10x5x20;30;igen;igen',
    'KUTYA;kb-1002;Macskaalom 10 l, levendula;;;;;15;;',
    'KONYHA;KG-3000;Kenyérpirító;123;db;1,1;;;nem;nem',
    'KUTYA;KB-3001;;;;;;;;',
    'NINCS;X-1;Valami;;;;;;;',
    'KUTYA;KB-3002;Hibás súly;;db;sok;;;;',
    'KUTYA;KB-3000;Duplikált sor;;;;;;;',
  ].join('\r\n');
  assert.equal((await operator.request('POST', '/api/products/import', csvForm(csv, true))).status, 403);
  const preview = ok(await manager.request('POST', '/api/products/import', csvForm(csv, true)));
  assert.equal(preview.rows, 7);
  assert.equal(preview.valid, 3);
  assert.equal(preview.created, 2);
  assert.equal(preview.updated, 1);
  assert.deepEqual(preview.errors.map((e) => e.line), [5, 6, 7, 8]);
  assert.match(preview.errors[0].message, /megnevezés/);
  assert.match(preview.warnings[0].message, /KG-3000/);
  assert.equal((await srv.query("SELECT COUNT(*) AS n FROM products WHERE sku = 'KB-3000'"))[0].n, 0);

  const done = ok(await manager.request('POST', '/api/products/import', csvForm(csv, false)));
  assert.equal(done.imported, 3);
  const [p] = await srv.query("SELECT name, ean, weight_kg, width_cm, depth_cm, height_cm, min_stock, track_lot, track_expiry FROM products WHERE sku = 'KB-3000'");
  assert.deepEqual(p, { name: 'Jutalomfalat 200 g', ean: '5990000030013', weight_kg: 0.2, width_cm: 10, depth_cm: 5, height_cm: 20, min_stock: 30, track_lot: 1, track_expiry: 1 });
  const [alom] = await srv.query('SELECT sku, name, ean, min_stock FROM products WHERE id = ?', fx.products.alom);
  assert.deepEqual(alom, { sku: 'KB-1002', name: 'Macskaalom 10 l, levendula', ean: '5990000010022', min_stock: 15 }, 'empty cells keep values');

  const exp = await operator.get(`/api/products/export?partner_id=${fx.clients.kutya}`);
  assert.equal(exp.status, 200);
  assert.match(exp.data, /KB-3000;Jutalomfalat 200 g;5990000030013;db;0,2;10;5;20;30;igen;igen;igen;0/);
  const again = ok(await manager.request('POST', '/api/products/import', csvForm(exp.data, true)));
  assert.equal(again.errors.length, 0, JSON.stringify(again.errors));
  assert.equal(again.created, 0);
});
