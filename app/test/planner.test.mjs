// Fuvarszervezés: trucks, the day's plan of egyedi fuvarok (orders that are neither webshop nor
// courier orders), loads in stop order, taking orders off, dispatching a truck, permissions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

let srv;
let admin;
let fx;
let manager;
let operator;
let today;
const S = {};
const ok = (r) => { assert.ok(r.status >= 200 && r.status < 300, `${r.status} ${JSON.stringify(r.data)}`); return r.data; };

before(async () => {
  srv = await startServer();
  admin = await srv.admin();
  fx = await srv.seedBasics();
  manager = await srv.userWithRole('warehouse_manager', 'vezeto-planner@example.com');
  operator = await srv.userWithRole('warehouse_operator', 'raktaros-planner@example.com');
  today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Budapest' }).format(new Date());
  S.cargo = ok(await admin.post('/api/partners', { type: 'carrier', code: 'CARGO', name: 'Cargo Trans Kft.' })).id;
  const order = async (key, extra = {}) => {
    S[key] = ok(await admin.post('/api/orders', {
      partner_id: fx.clients.kutya, customer_name: `Bolt ${key}`, company: `${key} Kft.`, zip: '6000', city: 'Kecskemét', address: 'Fő utca 1.',
      lines: [{ product_id: fx.products.alom, qty: 2 }], ...extra,
    }));
  };
  await order('b1', { pallets: 2 });
  await order('b2', { pallets: 1 });
  await order('b3', { pallets: 4 });
  await order('courier', { carrier_id: fx.carriers.gls });
  await order('shop');
  await srv.sql(`UPDATE orders SET source = 'shoprenter', external_id = 'x1' WHERE id = ${S.shop.id}`);
});
after(async () => { await srv.stop(); });

test('trucks: only for a carrier that is not a courier, unique plate, edit, delete', async () => {
  assert.equal((await admin.post('/api/transport/trucks', { carrier_id: fx.carriers.gls, plate: 'AA AA-001' })).status, 400, 'a courier has no trucks');
  S.t1 = ok(await admin.post('/api/transport/trucks', { carrier_id: S.cargo, plate: 'aa kx-482', name: '7,5 t ponyvás', driver: 'Kiss Gábor', pallets: 6, max_kg: 3500 }));
  assert.equal(S.t1.plate, 'AA KX-482');
  assert.equal(S.t1.carrier_name, 'Cargo Trans Kft.');
  assert.equal((await admin.post('/api/transport/trucks', { carrier_id: S.cargo, plate: 'AA KX-482' })).status, 409);
  S.t2 = ok(await admin.post('/api/transport/trucks', { carrier_id: S.cargo, plate: 'AB RT-115', pallets: 18, max_kg: 6000 }));
  S.t3 = ok(await admin.post('/api/transport/trucks', { carrier_id: S.cargo, plate: 'AE BC-871', active: false }));
  const edited = ok(await admin.put(`/api/transport/trucks/${S.t2.id}`, { carrier_id: S.cargo, plate: 'AB RT-115', driver: 'Nagy Péter', pallets: 18, max_kg: 6000 }));
  assert.equal(edited.driver, 'Nagy Péter');
  assert.equal(ok(await admin.get('/api/transport/trucks')).items.length, 3);
  assert.equal((await operator.post('/api/transport/trucks', { carrier_id: S.cargo, plate: 'X' })).status, 403);
});

test('planner: egyedi fuvarok only, loads in stop order, taking off, inactive truck refused', async () => {
  const day = ok(await operator.get(`/api/transport/planner?date=${today}`));
  assert.deepEqual(day.orders.map((o) => o.id).sort(), [S.b1.id, S.b2.id, S.b3.id].sort(), 'no courier and no webshop orders');
  assert.equal(day.orders.find((o) => o.id === S.b3.id).pallets, 4);
  assert.ok(day.orders.every((o) => o.kg > 0), 'weight from the products');
  assert.deepEqual(day.carriers.map((c) => c.id), [S.cargo]);

  let plan = ok(await operator.put('/api/transport/planner', { date: today, loads: [{ truck_id: S.t1.id, order_ids: [S.b2.id, S.b1.id] }] }));
  assert.deepEqual(plan.loads.map((o) => [o.id, o.truck_seq]), [[S.b2.id, 1], [S.b1.id, 2]]);
  assert.deepEqual(plan.orders.map((o) => o.id), [S.b3.id]);
  const detail = ok(await admin.get(`/api/orders/${S.b1.id}`));
  assert.equal(detail.truck.plate, 'AA KX-482');
  assert.equal(detail.carrier.id, S.cargo, 'the truck\'s carrier becomes the order\'s carrier');
  assert.ok(detail.events.some((e) => e.type === 'transport' && e.text.includes('AA KX-482')));

  // one move to the other truck, the rest reordered; what is not listed any more comes off
  plan = ok(await operator.put('/api/transport/planner', { date: today, loads: [{ truck_id: S.t1.id, order_ids: [S.b1.id] }, { truck_id: S.t2.id, order_ids: [S.b3.id, S.b2.id] }] }));
  assert.deepEqual(plan.loads.map((o) => [o.truck_id, o.id]), [[S.t1.id, S.b1.id], [S.t2.id, S.b3.id], [S.t2.id, S.b2.id]]);
  plan = ok(await operator.put('/api/transport/planner', { date: today, unassign: [S.b2.id] }));
  assert.deepEqual(plan.orders.map((o) => o.id), [S.b2.id]);

  assert.equal((await operator.put('/api/transport/planner', { date: today, loads: [{ truck_id: S.t3.id, order_ids: [S.b2.id] }] })).status, 409, 'truck not in service');
  assert.equal((await operator.put('/api/transport/planner', { date: today, loads: [{ truck_id: S.t1.id, order_ids: [S.courier.id] }] })).status, 409, 'courier order');
  assert.equal((await operator.put('/api/transport/planner', { date: today, loads: [{ truck_id: S.t1.id, order_ids: [S.b1.id] }], unassign: [S.b1.id] })).status, 400, 'twice');
  assert.equal((await operator.put('/api/transport/planner', { date: '2026-13-01' })).status, 400);
  const other = ok(await operator.get('/api/transport/planner?date=2099-01-01'));
  assert.equal(other.loads.length, 0, 'another day has its own loads');
});

test('dispatch: the packed orders on the truck are shipped, the rest stays', async () => {
  for (const s of ['picking', 'packed']) assert.equal((await srv.call('orders.setOrderStatus', [S.b3.id, s, ''], { as: 1 })).ok, true);
  assert.equal((await operator.post('/api/transport/planner/dispatch', { date: today, truck_id: S.t2.id })).status, 403, 'needs the approve right');
  const res = ok(await manager.post('/api/transport/planner/dispatch', { date: today, truck_id: S.t2.id }));
  assert.equal(res.shipped, 1);
  const b3 = ok(await admin.get(`/api/orders/${S.b3.id}`));
  assert.equal(b3.status, 'shipped');
  assert.ok(b3.events.some((e) => e.text.startsWith('Feladva: AB RT-115 teherautóval')));
  assert.equal((await manager.post('/api/transport/planner/dispatch', { date: today, truck_id: S.t1.id })).status, 409, 'nothing packed on it');
  assert.equal((await operator.put('/api/transport/planner', { date: today, unassign: [S.b3.id] })).status, 409, 'a shipped order stays on its truck');
  assert.equal((await admin.del(`/api/transport/trucks/${S.t2.id}`)).status, 409, 'a truck with orders is not deleted');
  ok(await admin.del(`/api/transport/trucks/${S.t3.id}`));
});

test('an order left behind on an earlier day waits in the list again', async () => {
  await srv.sql(`UPDATE orders SET truck_date = '2000-01-03' WHERE id = ${S.b1.id}`);
  const day = ok(await operator.get(`/api/transport/planner?date=${today}`));
  assert.ok(day.orders.some((o) => o.id === S.b1.id && o.truck_id === S.t1.id), 'back in the list, with its old truck');
  assert.ok(!day.loads.some((o) => o.id === S.b1.id));
  const plan = ok(await operator.put('/api/transport/planner', { date: today, loads: [{ truck_id: S.t1.id, order_ids: [S.b1.id] }] }));
  assert.deepEqual(plan.loads.filter((o) => o.truck_id === S.t1.id).map((o) => o.id), [S.b1.id]);
});
