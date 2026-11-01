// Komissió: waves (FEFO allocation), scan confirmation, shortages, packing, completing and cancelling.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

let srv;
let admin;
let fx;
let op; // Raktáros: picking view, create, edit (no approve, no delete)
let cs; // Ügyfélszolgálat: picking view only
before(async () => {
  srv = await startServer();
  admin = await srv.admin();
  fx = await srv.seedBasics();
  op = await srv.userWithRole('warehouse_operator');
  cs = await srv.userWithRole('customer_service');
});
after(async () => { await srv.stop(); });

const newOrder = async (lines, over = {}) => {
  const r = await admin.post('/api/orders', {
    partner_id: fx.clients.kutya, customer_name: 'Teszt Vevő', zip: '1111', city: 'Budapest', address: 'Fő utca 1.',
    carrier_id: fx.carriers.gls, lines, ...over,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};
const stockAt = async (productId, locationId) =>
  (await srv.query('SELECT COALESCE(SUM(qty), 0) AS q FROM stock WHERE product_id = ? AND location_id = ?', productId, locationId))[0].q;
const wave = async (id) => (await admin.get(`/api/picking/waves/${id}`)).data;
const task = (w, code, sku) => w.tasks.find((t) => t.location.code === code && (!sku || t.product.sku === sku));
const confirm = (client, w, t, qty = t.remaining, codes = {}) => client.post(`/api/picking/waves/${w.id}/confirm`, {
  pick_id: t.pick_id, location_code: codes.location ?? t.location.code, product_code: codes.product ?? t.product.ean, qty,
});

const S = {};

test('wave: only new orders that can be allocated completely, FEFO plan', async () => {
  S.a = await newOrder([{ product_id: fx.products.tap, qty: 12 }, { product_id: fx.products.csont, qty: 2 }]);
  S.b = await newOrder([{ product_id: fx.products.tap, qty: 3 }], { priority: 'express' });
  S.c = await newOrder([{ product_id: fx.products.mixer, qty: 1 }], { partner_id: fx.clients.konyha, carrier_id: fx.carriers.foxpost });
  S.d = await newOrder([{ product_id: fx.products.alom, qty: 30 }]);

  const refused = await admin.post('/api/picking/waves', { order_ids: [S.a.id, S.d.id] });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error.message, /KB-1002 Macskaalom 10 l \(hiányzik 5 db\)/);
  assert.equal(refused.data.error.fields[S.d.number], 'Hiányzik: KB-1002');
  assert.equal((await srv.query('SELECT COUNT(*) AS n FROM waves'))[0].n, 0);

  assert.equal((await cs.post('/api/picking/waves', { order_ids: [S.a.id] })).status, 403);
  assert.equal((await admin.post('/api/picking/waves', { order_ids: [] })).status, 400);

  const r = await op.post('/api/picking/waves', { order_ids: [S.a.id, S.b.id, S.c.id] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.number, /^H-\d{4}-\d{5}$/);
  S.w1 = r.data.id;
  const picks = await srv.query(
    `SELECT o.number, l.code, pk.qty, pk.lot FROM picks pk JOIN orders o ON o.id = pk.order_id JOIN locations l ON l.id = pk.location_id
     WHERE pk.wave_id = ? AND pk.product_id = ? ORDER BY pk.id`, S.w1, fx.products.tap);
  // Express order first, earliest expiry first (B-01-02: L2409, 2027-01-31), then B-01-01.
  assert.deepEqual(picks.map((p) => [p.number, p.code, p.qty, p.lot]), [
    [S.b.number, 'B-01-02', 3, 'L2409'], [S.a.number, 'B-01-02', 7, 'L2409'], [S.a.number, 'B-01-01', 5, 'L2410'],
  ]);
  const orders = await srv.query('SELECT status, wave_id FROM orders WHERE id IN (?, ?, ?)', S.a.id, S.b.id, S.c.id);
  assert.ok(orders.every((o) => o.status === 'picking' && o.wave_id === S.w1));

  const again = await admin.post('/api/picking/waves', { order_ids: [S.a.id] });
  assert.equal(again.status, 409);
  assert.match(again.data.error.message, /Csak új rendelés/);
  const list = await admin.get('/api/orders?status=picking');
  assert.equal(list.data.total, 3);
});

test('wave detail: tasks in walking order, grouped by location and product', async () => {
  const w = await wave(S.w1);
  assert.equal(w.status, 'open');
  assert.deepEqual(w.tasks.map((t) => `${t.location.code} ${t.product.sku}`), ['A-01-01 KB-1003', 'A-01-02 KG-2002', 'B-01-01 KB-1001', 'B-01-02 KB-1001']);
  const t = task(w, 'B-01-02');
  assert.equal(t.qty, 10);
  assert.deepEqual(t.orders, [S.b.number, S.a.number]);
  assert.equal(w.progress.qty, 18);
  assert.equal(w.orders.length, 3);
  const list = await admin.get('/api/picking/waves');
  assert.equal(list.data.items[0].order_count, 3);
  assert.equal(list.data.items[0].qty, 18);
  assert.equal((await cs.get(`/api/picking/waves/${S.w1}`)).status, 200);
});

test('scan resolves locations, products and orders of the wave', async () => {
  const loc = await admin.get(`/api/picking/waves/${S.w1}/scan?code=b-01-02`);
  assert.equal(loc.data.kind, 'location');
  assert.equal(loc.data.pick_ids.length, 2);
  const ean = await admin.get(`/api/picking/waves/${S.w1}/scan?code=5990000010015`);
  assert.equal(ean.data.kind, 'product');
  assert.equal(ean.data.product.sku, 'KB-1001');
  const sku = await admin.get(`/api/picking/waves/${S.w1}/scan?code=kg-2002`);
  assert.equal(sku.data.kind, 'product');
  const ord = await admin.get(`/api/picking/waves/${S.w1}/scan?code=${S.a.number}`);
  assert.equal(ord.data.kind, 'order');
  assert.equal(ord.data.order.id, S.a.id);
  const unknown = await admin.get(`/api/picking/waves/${S.w1}/scan?code=KB-1002`);
  assert.equal(unknown.data.kind, 'unknown');
});

test('confirm: wrong location or product refused, then stock decreases and the orders get the pieces', async () => {
  let w = await wave(S.w1);
  const t = task(w, 'B-01-02');
  const wrongLoc = await confirm(op, w, t, 4, { location: 'B-01-01' });
  assert.equal(wrongLoc.status, 409);
  assert.match(wrongLoc.data.error.message, /Rossz raktárhely \(B-01-01\)\. Ezt a tételt a\(z\) B-01-02 helyről kell kiszedni/);
  const wrongProduct = await confirm(op, w, t, 4, { product: 'KB-1002' });
  assert.equal(wrongProduct.status, 409);
  assert.match(wrongProduct.data.error.message, /Rossz termék \(KB-1002\)/);
  assert.equal((await confirm(op, w, t, 11)).status, 400);
  assert.equal((await confirm(cs, w, t, 4)).status, 403);
  assert.equal(await stockAt(fx.products.tap, 19), 10, 'refusals change nothing');

  const ok = await confirm(op, w, t, 4);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.left, 6);
  assert.equal(await stockAt(fx.products.tap, 19), 6);
  const [mv] = await srv.query("SELECT type, qty, ref_type, ref_id, lot FROM movements WHERE type = 'pick' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(mv, { type: 'pick', qty: -4, ref_type: 'wave', ref_id: S.w1, lot: 'L2409' });
  const lines = await srv.query('SELECT order_id, picked_qty FROM order_lines WHERE product_id = ? AND order_id IN (?, ?) ORDER BY order_id', fx.products.tap, S.a.id, S.b.id);
  assert.deepEqual(lines.map((l) => l.picked_qty), [1, 3], 'express order served first');
  w = await wave(S.w1);
  assert.equal(w.status, 'picking');
  assert.ok(w.started_at);
});

test('shortage: the rest is re-planned from another location', async () => {
  let w = await wave(S.w1);
  const t = task(w, 'B-01-02');
  assert.equal(t.remaining, 6);
  const r = await op.post(`/api/picking/waves/${S.w1}/short`, { pick_id: t.pick_id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.short, 6);
  assert.deepEqual(r.data.moved, [{ code: 'B-01-01', qty: 6 }]);
  assert.equal(r.data.missing, 0);
  w = await wave(S.w1);
  assert.equal(task(w, 'B-01-02').state, 'short');
  assert.equal(task(w, 'B-01-01').remaining, 11);
  assert.equal(await stockAt(fx.products.tap, 19), 6, 'a shortage does not touch stock');
});

test('picking the rest finishes the wave for packing', async () => {
  let w = await wave(S.w1);
  for (const t of w.tasks.filter((x) => x.state === 'open')) {
    const r = await confirm(admin, w, t, t.remaining, { product: t.product.sku.toLowerCase() });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  w = await wave(S.w1);
  assert.equal(w.status, 'picked');
  assert.equal(w.progress.remaining, 0);
  assert.equal(await stockAt(fx.products.tap, 18), 29);
  assert.equal(await stockAt(fx.products.csont, 10), 298);
  assert.ok(w.orders.every((o) => o.ready));
  const done = await confirm(admin, w, w.tasks[0], 1);
  assert.equal(done.status, 409);
});

test('packing: manual tracking number, label fallback, unpack, wave closes itself', async () => {
  const q = await admin.get('/api/picking/packing');
  assert.deepEqual(q.data.ready.map((o) => o.id).sort(), [S.a.id, S.b.id, S.c.id].sort());
  const byNumber = await admin.get(`/api/picking/packing/lookup?code=${S.a.number.toLowerCase()}`);
  assert.equal(byNumber.data.id, S.a.id);
  assert.equal(byNumber.data.all_picked, true);
  assert.equal(byNumber.data.tracking_required, true);
  assert.equal(byNumber.data.carrier.configured, false);
  assert.equal(byNumber.data.suggested_weight_kg, 144.6);
  const byProduct = await admin.get('/api/picking/packing/lookup?code=5990000020021');
  assert.equal(byProduct.data.id, S.c.id);
  assert.equal((await admin.get('/api/picking/packing/lookup?code=NINCS')).status, 404);

  const label = await op.post(`/api/picking/orders/${S.a.id}/pack`, { mode: 'label', package_count: 2 });
  assert.equal(label.status, 409);
  assert.match(label.data.error.message, /futár API nincs beállítva/);
  const noTracking = await op.post(`/api/picking/orders/${S.a.id}/pack`, { mode: 'manual', package_count: 2 });
  assert.equal(noTracking.status, 400);
  assert.ok(noTracking.data.error.fields.tracking_number);
  assert.equal((await cs.post(`/api/picking/orders/${S.a.id}/pack`, { mode: 'manual', tracking_number: 'X' })).status, 403);

  const packed = await op.post(`/api/picking/orders/${S.a.id}/pack`, { mode: 'manual', package_count: 2, weight_kg: 150.5, tracking_number: ' 0012 3456 ' });
  assert.equal(packed.status, 200, JSON.stringify(packed.data));
  assert.equal(packed.data.status, 'packed');
  const [o] = await srv.query('SELECT status, tracking_number, package_count, weight_kg, packed_at FROM orders WHERE id = ?', S.a.id);
  assert.deepEqual({ ...o, packed_at: !!o.packed_at }, { status: 'packed', tracking_number: '00123456', package_count: 2, weight_kg: 150.5, packed_at: true });
  assert.equal((await op.post(`/api/picking/orders/${S.a.id}/pack`, { mode: 'manual', tracking_number: 'X' })).status, 409);

  assert.equal((await op.post(`/api/picking/orders/${S.a.id}/unpack`, {})).status, 400);
  const un = await op.post(`/api/picking/orders/${S.a.id}/unpack`, { reason: 'Rossz címke' });
  assert.equal(un.status, 200);
  assert.equal(un.data.status, 'picking');
  assert.equal(un.data.tracking_number, '');
  await op.post(`/api/picking/orders/${S.a.id}/pack`, { mode: 'manual', tracking_number: '00123457' });
  await op.post(`/api/picking/orders/${S.b.id}/pack`, { mode: 'manual', tracking_number: '00123458' });
  assert.equal((await wave(S.w1)).status, 'picked');
  const last = await op.post(`/api/picking/orders/${S.c.id}/pack`, { mode: 'manual', tracking_number: 'FOX987' });
  assert.equal(last.data.wave_completed, true);
  assert.equal((await wave(S.w1)).status, 'completed');
  const events = await srv.query('SELECT text FROM order_events WHERE order_id = ? ORDER BY id', S.a.id);
  assert.ok(events.some((e) => /Becsomagolva: 2 csomag, nyomkövetési szám: 00123456/.test(e.text)));
  assert.ok(events.some((e) => /Csomagolás visszavonva: Rossz címke/.test(e.text)));
});

test('shortage without replacement: completing needs approve, the order goes back to new', async () => {
  S.e = await newOrder([{ product_id: fx.products.robot, qty: 12 }], { partner_id: fx.clients.konyha });
  S.f = await newOrder([{ product_id: fx.products.csont, qty: 1 }]);
  const r = await admin.post('/api/picking/waves', { order_ids: [S.e.id, S.f.id] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  S.w2 = r.data.id;
  let w = await wave(S.w2);
  const robot = task(w, 'C-01-03');
  assert.equal((await confirm(op, w, robot, 10)).status, 200);
  w = await wave(S.w2);
  const sh = await op.post(`/api/picking/waves/${S.w2}/short`, { pick_id: task(w, 'C-01-03').pick_id });
  assert.equal(sh.data.short, 2);
  assert.deepEqual(sh.data.moved, []);
  assert.equal(sh.data.missing, 2);
  assert.equal((await confirm(op, w, task(w, 'A-01-01'))).status, 200);
  w = await wave(S.w2);
  assert.equal(w.status, 'picked');
  assert.deepEqual(w.incomplete_orders, [S.e.number]);

  const denied = await op.post(`/api/picking/waves/${S.w2}/complete`, {});
  assert.equal(denied.status, 403);
  assert.match(denied.data.error.message, /hullám lezárása hiánnyal/);
  const done = await admin.post(`/api/picking/waves/${S.w2}/complete`, {});
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.deepEqual(done.data.reverted, [S.e.number]);
  const [e] = await srv.query('SELECT status, wave_id FROM orders WHERE id = ?', S.e.id);
  assert.deepEqual(e, { status: 'new', wave_id: null });
  const [ev] = await srv.query("SELECT text FROM order_events WHERE order_id = ? AND type = 'status' ORDER BY id DESC LIMIT 1", S.e.id);
  assert.match(ev.text, /Hullám lezárva hiánnyal .*KG-2001 2 db/);
  assert.equal((await srv.query('SELECT picked_qty FROM order_lines WHERE order_id = ?', S.e.id))[0].picked_qty, 10, 'picked pieces stay with the order');
  assert.equal(await stockAt(fx.products.robot, 26), 2, 'stock untouched by completing');
  const [f] = await srv.query('SELECT status FROM orders WHERE id = ?', S.f.id);
  assert.equal(f.status, 'picking', 'complete orders stay ready for packing');
  assert.equal((await wave(S.w2)).status, 'completed');

  // Cancelling the order puts the 10 picked pieces back where they came from.
  const cancel = await admin.post(`/api/orders/${S.e.id}/cancel`, { reason: 'Nincs elég robotgép' });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
  assert.deepEqual(cancel.data.restocked.map((x) => [x.sku, x.qty, x.code]), [['KG-2001', 10, 'C-01-03']]);
  assert.equal(await stockAt(fx.products.robot, 26), 12);
  const [back] = await srv.query("SELECT qty, lot, ref_type FROM movements WHERE type = 'cancel_pick' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(back, { qty: 10, lot: 'B24-07', ref_type: 'order' });
});

test('open waves keep their stock; cancelling a wave puts picked goods back', async () => {
  S.g = await newOrder([{ product_id: fx.products.forralo, qty: 40 }], { partner_id: fx.clients.konyha });
  S.h = await newOrder([{ product_id: fx.products.alom, qty: 3 }]);
  const r = await admin.post('/api/picking/waves', { order_ids: [S.g.id, S.h.id] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  S.w3 = r.data.id;
  const other = await newOrder([{ product_id: fx.products.forralo, qty: 10 }], { partner_id: fx.clients.konyha });
  const refused = await admin.post('/api/picking/waves', { order_ids: [other.id] });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error.message, /KG-2003 .*hiányzik 5 db/);

  let w = await wave(S.w3);
  assert.equal((await confirm(op, w, task(w, 'A-01-03'), 25)).status, 200);
  assert.equal(await stockAt(fx.products.forralo, 12), 20);

  assert.equal((await op.post(`/api/picking/waves/${S.w3}/cancel`, { reason: 'Teszt' })).status, 403);
  assert.equal((await admin.post(`/api/picking/waves/${S.w3}/cancel`, {})).status, 400);
  const c = await admin.post(`/api/picking/waves/${S.w3}/cancel`, { reason: 'Átszervezés' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.orders, 2);
  assert.equal(await stockAt(fx.products.forralo, 12), 45);
  const [mv] = await srv.query("SELECT qty, location_id, ref_type, ref_id FROM movements WHERE type = 'cancel_pick' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(mv, { qty: 25, location_id: 12, ref_type: 'wave', ref_id: S.w3 });
  const orders = await srv.query('SELECT status, wave_id FROM orders WHERE id IN (?, ?)', S.g.id, S.h.id);
  assert.ok(orders.every((o) => o.status === 'new' && o.wave_id === null));
  assert.equal((await srv.query('SELECT COALESCE(SUM(picked_qty), 0) AS n FROM order_lines WHERE order_id = ?', S.g.id))[0].n, 0);
  assert.equal((await srv.query('SELECT COUNT(*) AS n FROM picks WHERE wave_id = ? AND picked_qty = 0', S.w3))[0].n, 0, 'unpicked picks dropped');
  w = await wave(S.w3);
  assert.equal(w.status, 'cancelled');
  assert.match(w.note, /Megszakítva: Átszervezés/);
  assert.equal((await confirm(admin, w, { pick_id: 1, location: { code: 'A-01-03' }, product: { ean: '5990000020038' }, remaining: 1 })).status, 409);
  const ev = await srv.query("SELECT text FROM order_events WHERE order_id = ? ORDER BY id DESC LIMIT 1", S.g.id);
  assert.match(ev[0].text, /Hullám megszakítva .*Átszervezés.*Visszakönyvelve: KG-2003 25 db \(A-01-03\)/);

  // With the wave gone, the stock is free again.
  assert.equal((await admin.post('/api/picking/waves', { order_ids: [other.id] })).status, 200);
});
