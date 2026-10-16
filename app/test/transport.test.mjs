// Fuvarszervezés: day board, carrier pickups (assign, scan, remove, arrived, close, cancel),
// manifest CSV, pallet and truck transports, permissions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

let srv;
let fx;
let manager;
let operator;
let service;
let sales;
let today;
const orders = {};

before(async () => {
  srv = await startServer();
  await srv.admin();
  fx = await srv.seedBasics();
  manager = await srv.userWithRole('warehouse_manager', 'vezeto-transport@example.com');
  operator = await srv.userWithRole('warehouse_operator', 'raktaros-transport@example.com');
  service = await srv.userWithRole('customer_service', 'ugyfel-transport@example.com');
  sales = await srv.userWithRole('sales', 'sales-transport@example.com');
  today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Budapest' }).format(new Date());

  // Packed orders: three for GLS (one with COD), one for Foxpost, one without a carrier.
  // (external_id: the orders table allows only one order per partner and source with an empty one.)
  const make = async (key, carrier, extra = {}) => {
    const r = await srv.call('orderCreate.createOrder', [{
      partner_id: fx.clients.kutya, source: 'api', external_id: `ext-${key}`,
      customer_name: `Vevő ${key}`, zip: '1111', city: 'Budapest', address: 'Fő utca 1.',
      carrier_code: carrier, lines: [{ sku: 'KB-1003', qty: 1 }], ...extra,
    }], { as: 1 });
    assert.equal(r.ok, true, JSON.stringify(r));
    orders[key] = r.result;
  };
  await make('g1', 'gls', { cod_amount: 12990, external_number: '#5001' });
  await make('g2', 'gls');
  await make('g3', 'gls', { cod_amount: 4500 });
  await make('f1', 'foxpost');
  await make('n1', '');
  await srv.sql(`UPDATE orders SET status = 'packed', packed_at = '2026-10-16T09:00:00.000Z', package_count = 1, weight_kg = 2.5,
    tracking_number = 'TRK-' || number WHERE id IN (${Object.values(orders).map((o) => o.id).join(', ')})`);
  await srv.sql(`UPDATE orders SET package_count = 2 WHERE id = ${orders.g2.id}`);
});
after(async () => { await srv.stop(); });

const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
const order = async (key) => (await srv.query('SELECT status, pickup_id, shipped_date, tracking_number FROM orders WHERE id = ?', orders[key].id))[0];

test('permissions: no transport module 403, operator cannot create or close', async () => {
  assert.equal((await sales.get('/api/transport/board')).status, 403);
  assert.equal((await sales.get('/api/transport/transports')).status, 403);
  assert.equal((await operator.post('/api/transport/pickups', { carrier_id: fx.carriers.gls, date: today })).status, 403);
  assert.equal((await operator.post('/api/transport/transports', { direction: 'out', date: today })).status, 403);
  ok(await operator.get('/api/transport/board'));
});

test('board: waiting packed orders per carrier', async () => {
  const b = ok(await operator.get('/api/transport/board'));
  assert.equal(b.date, today);
  const gls = b.carriers.find((c) => c.id === fx.carriers.gls);
  assert.equal(gls.waiting.orders, 3);
  assert.equal(gls.waiting.packages, 4);
  assert.equal(gls.waiting.cod.HUF, 17490);
  assert.equal(gls.waiting.cod_orders, 2);
  assert.equal(b.carriers.find((c) => c.id === fx.carriers.foxpost).waiting.orders, 1);
  assert.equal(b.no_carrier.orders, 1);
  assert.equal(b.totals.waiting.orders, 4);
  assert.equal((await operator.get('/api/transport/board?date=2026-13-01')).status, 400);
});

test('pickup: create, assign, scan, remove, arrived, close', async () => {
  assert.equal((await service.post('/api/transport/pickups', { carrier_id: fx.carriers.gls, date: '2020-01-01' })).status, 400, 'past date');
  assert.equal((await service.post('/api/transport/pickups', { carrier_id: fx.carriers.gls, date: today, window_from: '17:00', window_to: '15:00' })).status, 400);
  assert.equal((await service.post('/api/transport/pickups', { carrier_id: fx.clients.kutya, date: today })).status, 400, 'not a carrier');
  const p = ok(await service.post('/api/transport/pickups', { carrier_id: fx.carriers.gls, date: today, window_from: '15:00', window_to: '17:00' }));
  assert.match(p.number, /^FA-\d{4}-\d{5}$/);

  // A Foxpost order does not go on a GLS pickup.
  const wrong = await operator.post(`/api/transport/pickups/${p.id}/orders`, { order_ids: [orders.f1.id] });
  assert.equal(wrong.status, 409);
  assert.match(wrong.data.error.message, /más fuvarozóval/);
  const one = ok(await operator.post(`/api/transport/pickups/${p.id}/orders`, { order_ids: [orders.g1.id] }));
  assert.equal(one.assigned, 1);
  assert.equal(one.pickup.orders.length, 1);
  assert.equal(one.pickup.waiting.length, 2);

  // Scanning parcels at the ramp: tracking number, then the same again, then a wrong one.
  const scan = ok(await operator.post(`/api/transport/pickups/${p.id}/scan`, { code: `trk-${orders.g2.number}` }));
  assert.equal(scan.already, false);
  assert.equal(scan.order.number, orders.g2.number);
  assert.equal(ok(await operator.post(`/api/transport/pickups/${p.id}/scan`, { code: orders.g2.number })).already, true);
  assert.equal((await operator.post(`/api/transport/pickups/${p.id}/scan`, { code: 'NINCS-ILYEN' })).status, 404);
  const fox = await operator.post(`/api/transport/pickups/${p.id}/scan`, { code: `TRK-${orders.f1.number}` });
  assert.equal(fox.status, 409);
  assert.match(fox.data.error.message, /fuvarozója FoxPost/);
  const byWebshopNumber = ok(await operator.post(`/api/transport/pickups/${p.id}/scan`, { code: '#5001' }));
  assert.equal(byWebshopNumber.already, true);

  const all = ok(await operator.post(`/api/transport/pickups/${p.id}/orders`, { all: true }));
  assert.equal(all.assigned, 1);
  assert.equal((await operator.post(`/api/transport/pickups/${p.id}/orders`, { all: true })).status, 409, 'nothing left');

  let b = ok(await operator.get('/api/transport/board'));
  let gls = b.carriers.find((c) => c.id === fx.carriers.gls);
  assert.equal(gls.waiting.orders, 0);
  assert.equal(gls.assigned.orders, 3);
  assert.equal(gls.pickups[0].totals.cod.HUF, 17490);
  assert.equal(gls.pickups[0].window_from, '15:00');

  // Take one order off again: it waits for GLS.
  const detail = ok(await operator.del(`/api/transport/pickups/${p.id}/orders/${orders.g3.id}`));
  assert.equal(detail.orders.length, 2);
  assert.equal((await order('g3')).pickup_id, null);
  assert.equal(detail.totals.packages, 3);
  assert.equal(detail.totals.cod.HUF, 12990);

  const arrived = ok(await operator.post(`/api/transport/pickups/${p.id}/arrived`));
  assert.equal(arrived.status, 'arrived');
  assert.ok(arrived.arrived_at);

  assert.equal((await operator.post(`/api/transport/pickups/${p.id}/close`, {})).status, 403);
  const closed = ok(await manager.post(`/api/transport/pickups/${p.id}/close`, { manifest_number: 'GLS-M-777' }));
  assert.deepEqual(closed, { done: true, shipped: 2, manifest_number: 'GLS-M-777' });
  for (const key of ['g1', 'g2']) {
    const o = await order(key);
    assert.equal(o.status, 'shipped');
    assert.equal(o.shipped_date, today);
    const [ev] = await srv.query("SELECT text FROM order_events WHERE order_id = ? AND type = 'status' ORDER BY id DESC LIMIT 1", orders[key].id);
    assert.match(ev.text, new RegExp(`${p.number}.*GLS-M-777`));
  }
  assert.equal((await order('g3')).status, 'packed');
  const after = ok(await operator.get(`/api/transport/pickups/${p.id}`));
  assert.equal(after.status, 'closed');
  assert.equal(after.manifest_number, 'GLS-M-777');
  assert.equal(after.closed_by_name, 'Teszt warehouse_manager');
  assert.deepEqual(after.waiting, [], 'no waiting list on a closed pickup');

  assert.equal((await manager.post(`/api/transport/pickups/${p.id}/close`, {})).status, 409);
  assert.equal((await operator.del(`/api/transport/pickups/${p.id}/orders/${orders.g1.id}`)).status, 409);
  assert.equal((await operator.post(`/api/transport/pickups/${p.id}/orders`, { all: true })).status, 409);
  assert.equal((await manager.del(`/api/transport/pickups/${p.id}`)).status, 409, 'closed pickups are not cancelled');

  const csv = await operator.get(`/api/transport/pickups/${p.id}/manifest.csv`, { raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /manifeszt-FA-/);
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM for Excel');
  const text = bytes.toString('utf8');
  assert.ok(text.includes('Rendelésszám;Webshop rendelésszám;'));
  assert.ok(text.includes(`TRK-${orders.g1.number}`));
  assert.ok(text.includes('12990'));
  const audits = await srv.query("SELECT action FROM audit_log WHERE module = 'transport' AND entity = 'pickup' AND entity_id = ? ORDER BY id", String(p.id));
  assert.deepEqual([...new Set(audits.map((a) => a.action))], ['create', 'edit', 'approve']);

  const list = ok(await operator.get(`/api/transport/pickups?status=closed&from=${today}`));
  assert.equal(list.total, 1);
  assert.equal(list.items[0].orders, 2);
});

test('pickup: cancel releases orders, closing refuses orders that are not packed', async () => {
  const p = ok(await manager.post('/api/transport/pickups', { carrier_id: fx.carriers.foxpost, date: today }));
  ok(await operator.post(`/api/transport/pickups/${p.id}/orders`, { all: true }));
  assert.equal((await order('f1')).pickup_id, p.id);
  assert.equal((await service.del(`/api/transport/pickups/${p.id}`)).status, 403);
  const cancelled = ok(await manager.del(`/api/transport/pickups/${p.id}`));
  assert.equal(cancelled.released, 1);
  assert.equal((await order('f1')).pickup_id, null);
  assert.equal((await operator.post(`/api/transport/pickups/${p.id}/orders`, { all: true })).status, 409);

  const q = ok(await manager.post('/api/transport/pickups', { carrier_id: fx.carriers.foxpost, date: today }));
  assert.equal((await manager.post(`/api/transport/pickups/${q.id}/close`, {})).status, 409, 'empty manifest');
  ok(await operator.post(`/api/transport/pickups/${q.id}/orders`, { order_ids: [orders.f1.id] }));
  // The picking team took the order back for repacking.
  await srv.sql(`UPDATE orders SET status = 'picking' WHERE id = ${orders.f1.id}`);
  const refused = await manager.post(`/api/transport/pickups/${q.id}/close`, {});
  assert.equal(refused.status, 409);
  assert.match(refused.data.error.message, new RegExp(orders.f1.number));
  const d = ok(await operator.get(`/api/transport/pickups/${q.id}`));
  assert.deepEqual(d.problems.not_packed, [orders.f1.number]);
  ok(await operator.del(`/api/transport/pickups/${q.id}/orders/${orders.f1.id}`));
  ok(await operator.post(`/api/transport/pickups/${q.id}/arrived`));
  assert.equal((await manager.del(`/api/transport/pickups/${q.id}`)).status, 409, 'only planned pickups are cancelled');

  const patched = ok(await service.patch(`/api/transport/pickups/${q.id}`, { window_from: '10:00', window_to: '12:00', note: 'Hátsó rámpa' }));
  assert.equal(patched.window_to, '12:00');
  assert.equal((await service.patch(`/api/transport/pickups/${q.id}`, { window_from: '13:00' })).status, 400, 'window from after to');
});

test('pickup: large manifests are closed in parts', async () => {
  const p = ok(await manager.post('/api/transport/pickups', { carrier_id: fx.carriers.gls, date: today }));
  const values = [];
  for (let i = 1; i <= 105; i++) {
    values.push(`('R-TEST-${String(i).padStart(4, '0')}', ${fx.clients.kutya}, 'csv', 'bulk-${i}', 'Tömeges ${i}', 'packed', ${fx.carriers.gls}, ${p.id}, 'TT${i}')`);
  }
  await srv.sql(`INSERT INTO orders (number, partner_id, source, external_id, customer_name, status, carrier_id, pickup_id, tracking_number) VALUES ${values.join(', ')}`);
  const part = ok(await manager.post(`/api/transport/pickups/${p.id}/close`, {}));
  assert.equal(part.done, false);
  assert.equal(part.remaining, 5);
  assert.equal(part.manifest_number, p.number, 'the pickup number is the default manifest number');
  const rest = ok(await manager.post(`/api/transport/pickups/${p.id}/close`, {}));
  assert.equal(rest.done, true);
  assert.equal(rest.shipped, 105);
  const [n] = await srv.query("SELECT COUNT(*) AS n FROM orders WHERE pickup_id = ? AND status = 'shipped'", p.id);
  assert.equal(n.n, 105);
});

test('transports: create, validate, list, edit, status flow, cancel', async () => {
  const bad = await service.post('/api/transport/transports', { direction: 'in' });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.error.fields.date);
  assert.equal((await service.post('/api/transport/transports', { direction: 'in', date: today, partner_id: fx.carriers.gls })).status, 400, 'partner must be a client');
  assert.equal((await service.post('/api/transport/transports', { direction: 'in', date: today, status: 'booked' })).status, 400, 'booked needs a carrier');
  assert.equal((await service.post('/api/transport/transports', { direction: 'in', date: today, time_from: '12:00', time_to: '08:00' })).status, 400);

  const t = ok(await service.post('/api/transport/transports', {
    direction: 'in', partner_id: fx.clients.konyha, date: today, time_from: '08:00', time_to: '10:00',
    origin: 'Kecskemét, Ipari út 5.', destination: 'Alsónémedi', pallets: 6, weight_kg: '1250,5', price: 85000, note: 'Hátfalas autó kell',
  }));
  assert.match(t.number, /^FU-\d{4}-\d{5}$/);
  assert.equal(t.status, 'requested');
  assert.equal(t.weight_kg, 1250.5);
  assert.equal(t.partner_name, 'Konyhagép Gyártó Zrt.');

  const list = ok(await operator.get('/api/transport/transports'));
  assert.equal(list.total, 1);
  assert.equal(ok(await operator.get(`/api/transport/transports?direction=out`)).total, 0);
  assert.equal(ok(await operator.get(`/api/transport/transports?q=Kecskem`)).total, 1);

  assert.equal((await service.post(`/api/transport/transports/${t.id}/status`, { status: 'booked' })).status, 400, 'no carrier yet');
  const edited = ok(await operator.patch(`/api/transport/transports/${t.id}`, { carrier_id: fx.carriers.gls, vehicle: '12 t ponyvás, ABC-123', carrier_ref: 'GLS-8812' }));
  assert.equal(edited.carrier_name, 'GLS General Logistics Systems Hungary Kft.');
  const jump = await service.post(`/api/transport/transports/${t.id}/status`, { status: 'delivered' });
  assert.equal(jump.status, 409);
  for (const s of ['booked', 'in_transit', 'delivered']) assert.equal(ok(await operator.post(`/api/transport/transports/${t.id}/status`, { status: s })).status, s);
  assert.equal((await operator.patch(`/api/transport/transports/${t.id}`, { carrier_id: null })).status, 400);
  assert.equal(ok(await operator.patch(`/api/transport/transports/${t.id}`, { price: 92000 })).price, 92000, 'price can be fixed after delivery');
  assert.equal((await manager.del(`/api/transport/transports/${t.id}`)).status, 409, 'delivered transports stay');
  assert.equal(ok(await operator.get('/api/transport/transports?status=delivered')).total, 1);

  const u = ok(await service.post('/api/transport/transports', { direction: 'out', date: today, destination: 'Győr' }));
  assert.equal((await service.del(`/api/transport/transports/${u.id}`)).status, 403);
  ok(await manager.del(`/api/transport/transports/${u.id}`));
  const gone = ok(await operator.get(`/api/transport/transports/${u.id}`));
  assert.equal(gone.status, 'cancelled');
  assert.equal((await operator.patch(`/api/transport/transports/${u.id}`, { note: 'x' })).status, 409);
  assert.equal((await operator.get('/api/transport/transports/999999')).status, 404);
  const audits = await srv.query("SELECT action FROM audit_log WHERE module = 'transport' AND entity = 'transport' AND entity_id = ?", String(t.id));
  assert.ok(audits.length >= 5);
});
