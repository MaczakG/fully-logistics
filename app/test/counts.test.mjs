// Leltár: creating counts by type, blind counting, location by location entry, review, posting
// with the stock-changed recheck, cancelling, permissions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

let srv;
let fx;
let manager;
let operator;
let service;

before(async () => {
  srv = await startServer();
  await srv.admin();
  fx = await srv.seedBasics();
  manager = await srv.userWithRole('warehouse_manager', 'vezeto-counts@example.com');
  operator = await srv.userWithRole('warehouse_operator', 'raktaros-counts@example.com');
  service = await srv.userWithRole('customer_service', 'ugyfel-counts@example.com');
});
after(async () => { await srv.stop(); });

const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
const stockAt = async (locationId) => srv.query('SELECT product_id, lot, expiry, qty FROM stock WHERE location_id = ? ORDER BY product_id', locationId);
const lineOf = (loc, productId) => loc.lines.find((l) => l.product_id === productId);

test('permissions: no counts module 403, counter cannot start or approve', async () => {
  assert.equal((await service.get('/api/counts')).status, 403);
  assert.equal((await operator.post('/api/counts', { type: 'zone', zone: 'A' })).status, 403);
  assert.equal((await operator.get('/api/counts/options')).status, 403);
  ok(await operator.get('/api/counts'));
  const opts = ok(await manager.get('/api/counts/options'));
  assert.ok(opts.zones.find((z) => z.zone === 'A' && z.locations === 8));
  assert.equal(opts.storage_locations, 22);
});

test('zone count: snapshot, blind counting, found goods, recheck, posting', async () => {
  const created = ok(await manager.post('/api/counts', { type: 'zone', zone: 'A', note: 'Negyedéves' }));
  assert.match(created.number, /^LT-\d{4}-\d{5}$/);
  assert.equal(created.locations, 8);
  assert.equal(created.lines, 8, '3 stock lines and 5 empty locations');
  const id = created.id;

  // The same location cannot be in two open counts.
  const overlap = await manager.post('/api/counts', { type: 'locations', location_codes: ['A-01-01'] });
  assert.equal(overlap.status, 409);
  assert.match(overlap.data.error.message, /A-01-01 \(LT-/);

  // Blind: the counter sees products but no expected quantities; the approver sees them.
  const seen = ok(await operator.get(`/api/counts/${id}`));
  assert.equal(seen.can_see_expected, false);
  assert.equal(seen.status, 'open');
  assert.deepEqual(seen.locations.map((l) => l.code), ['A-01-01', 'A-01-02', 'A-01-03', 'A-01-04', 'A-01-05', 'A-01-06', 'A-01-07', 'A-01-08']);
  const opLines = seen.locations.flatMap((l) => l.items);
  assert.ok(opLines.every((l) => !('expected_qty' in l)));
  assert.equal(opLines.find((l) => l.product_id === fx.products.csont).sku, 'KB-1003');
  const mgr = ok(await manager.get(`/api/counts/${id}`));
  assert.equal(mgr.locations[0].items[0].expected_qty, 300);
  assert.equal(mgr.locations[3].items[0].product_id, null, 'empty location line');

  // A-01-01: scans add one by one, then the counter types the total (2 short).
  let loc = ok(await operator.get(`/api/counts/${id}/locations/10`));
  const csont = lineOf(loc, fx.products.csont);
  loc = ok(await operator.put(`/api/counts/${id}/lines/${csont.id}`, { add: 1 }));
  loc = ok(await operator.put(`/api/counts/${id}/lines/${csont.id}`, { add: 1 }));
  assert.equal(lineOf(loc, fx.products.csont).counted_qty, 2);
  assert.equal(loc.count.status, 'counting');
  assert.ok(!('expected_qty' in lineOf(loc, fx.products.csont)));
  loc = ok(await operator.put(`/api/counts/${id}/lines/${csont.id}`, { counted_qty: 298 }));
  assert.equal(loc.location.done, true);
  assert.equal(lineOf(loc, fx.products.csont).counted_by_name, 'Teszt warehouse_operator');
  assert.equal((await operator.put(`/api/counts/${id}/lines/${csont.id}`, { counted_qty: -1 })).status, 400);

  // A-01-02 matches, A-01-03 has 5 more than expected.
  loc = ok(await operator.get(`/api/counts/${id}/locations/11`));
  ok(await operator.put(`/api/counts/${id}/lines/${lineOf(loc, fx.products.mixer).id}`, { counted_qty: 60 }));
  loc = ok(await operator.get(`/api/counts/${id}/locations/12`));
  ok(await operator.put(`/api/counts/${id}/lines/${lineOf(loc, fx.products.forralo).id}`, { counted_qty: 50 }));

  // A-01-04 should be empty but holds 3 bags of cat litter: found by EAN, then the location is done.
  loc = ok(await operator.get(`/api/counts/${id}/locations/13`));
  const empty = loc.lines[0];
  assert.equal((await operator.put(`/api/counts/${id}/lines/${empty.id}`, { counted_qty: 2 })).status, 400, 'empty line takes no goods');
  const resolved = ok(await operator.get(`/api/counts/${id}/resolve?code=5990000010022&location_id=13`));
  assert.deepEqual(resolved.products.map((p) => p.sku), ['KB-1002']);
  loc = ok(await operator.post(`/api/counts/${id}/lines`, { location_id: 13, code: '5990000010022', counted_qty: 2 }));
  loc = ok(await operator.post(`/api/counts/${id}/lines`, { location_id: 13, product_id: fx.products.alom, add: 1 }));
  const found = lineOf(loc, fx.products.alom);
  assert.equal(found.added, true);
  assert.equal(found.counted_qty, 3, 'the second entry adds to the found line');
  assert.equal(loc.location.done, false);
  loc = ok(await operator.post(`/api/counts/${id}/locations/13/complete`));
  assert.equal(loc.location.done, true);
  assert.equal(loc.lines.find((l) => l.product_id === null).counted_qty, 0);
  assert.equal((await operator.post(`/api/counts/${id}/lines`, { location_id: 30, product_id: fx.products.alom })).status, 400, 'location not in count');

  // Only a found line can be deleted.
  assert.equal((await operator.del(`/api/counts/${id}/lines/${csont.id}`)).status, 409);

  // The counters stop: four empty locations stay uncounted.
  const fin = ok(await operator.post(`/api/counts/${id}/finish`));
  assert.equal(fin.status, 'counted');
  const listed = ok(await operator.get('/api/counts'));
  const row = listed.items.find((c) => c.id === id);
  assert.equal(row.done_locations, 4);
  assert.equal(row.diff_lines, null, 'differences hidden from blind counters');
  assert.equal(ok(await manager.get('/api/counts')).items.find((c) => c.id === id).diff_lines, 3);

  // Stock moves after the snapshot: 5 mixers picked from A-01-02.
  const picked = await srv.call('stock.removeStock', [{ productId: fx.products.mixer, locationId: 11, qty: 5, type: 'pick', refType: 'order', refId: 1 }], { as: 1 });
  assert.equal(picked.ok, true, JSON.stringify(picked));

  assert.equal((await operator.get(`/api/counts/${id}/review`)).status, 403);
  let review = ok(await manager.get(`/api/counts/${id}/review`));
  assert.deepEqual(
    { surplus: review.summary.surplus, shortage: review.summary.shortage, matching: review.summary.matching, uncounted: review.summary.uncounted, changed: review.summary.changed },
    { surplus: 2, shortage: 1, matching: 2, uncounted: 4, changed: 1 },
  );
  const mixerLine = review.lines.find((l) => l.product_id === fx.products.mixer);
  assert.equal(mixerLine.changed, true);
  assert.equal(mixerLine.current_qty, 55);
  assert.equal(review.lines.find((l) => l.product_id === fx.products.forralo).diff, 5);

  assert.equal((await operator.post(`/api/counts/${id}/post`, {})).status, 403);
  const refused = await manager.post(`/api/counts/${id}/post`, {});
  assert.equal(refused.status, 409);
  assert.match(refused.data.error.message, /mozgott a készlet/);
  assert.deepEqual(await stockAt(10), [{ product_id: fx.products.csont, lot: '', expiry: '', qty: 300 }], 'nothing booked');

  // Recount A-01-02: fresh snapshot, the count is open for counting again.
  loc = ok(await operator.post(`/api/counts/${id}/locations/11/recount`));
  assert.equal(loc.count.status, 'counting');
  assert.equal(lineOf(loc, fx.products.mixer).counted_qty, null);
  ok(await operator.put(`/api/counts/${id}/lines/${lineOf(loc, fx.products.mixer).id}`, { counted_qty: 55 }));
  review = ok(await manager.get(`/api/counts/${id}/review`));
  assert.equal(review.summary.changed, 0);
  assert.equal(review.lines.find((l) => l.product_id === fx.products.mixer).expected_qty, 55);

  const posted = ok(await manager.post(`/api/counts/${id}/post`, {}));
  assert.equal(posted.done, true);
  assert.equal(posted.summary.surplus_qty, 8);
  assert.equal(posted.summary.shortage_qty, 2);
  assert.deepEqual(await stockAt(10), [{ product_id: fx.products.csont, lot: '', expiry: '', qty: 298 }]);
  assert.deepEqual(await stockAt(11), [{ product_id: fx.products.mixer, lot: '', expiry: '', qty: 55 }]);
  assert.deepEqual(await stockAt(12), [{ product_id: fx.products.forralo, lot: '', expiry: '', qty: 50 }]);
  assert.deepEqual(await stockAt(13), [{ product_id: fx.products.alom, lot: '', expiry: '', qty: 3 }]);
  const moves = await srv.query("SELECT type, product_id, qty FROM movements WHERE ref_type = 'count' AND ref_id = ? ORDER BY qty", id);
  assert.deepEqual(moves.map((m) => `${m.type}:${m.product_id}:${m.qty}`), [`adjust:${fx.products.csont}:-2`, `adjust:${fx.products.alom}:3`, `adjust:${fx.products.forralo}:5`]);

  const done = ok(await operator.get(`/api/counts/${id}`));
  assert.equal(done.status, 'posted');
  assert.equal(done.can_see_expected, true, 'after posting the counter may see the differences');
  const uncounted = await srv.query('SELECT COUNT(*) AS n FROM count_lines WHERE count_id = ? AND posted_at IS NULL', id);
  assert.equal(uncounted[0].n, 4, 'uncounted lines stay unposted');
  assert.equal((await operator.put(`/api/counts/${id}/lines/${csont.id}`, { counted_qty: 1 })).status, 409);
  assert.equal((await manager.del(`/api/counts/${id}`)).status, 409);
  const log = await srv.query("SELECT action, summary FROM audit_log WHERE module = 'counts' AND entity_id = ? ORDER BY id", String(id));
  assert.equal(log[0].action, 'create');
  assert.equal(log.at(-1).action, 'approve');
  assert.match(log.at(-1).summary, /könyvelve: 2 többlet \(\+8\), 1 hiány \(-2\)/);
});

test('cycle count: least recently counted first, open counts left out, cancel', async () => {
  const a = ok(await manager.post('/api/counts', { type: 'cycle', limit: 5 }));
  const first = ok(await manager.get(`/api/counts/${a.id}?lines=0`));
  assert.equal(first.locations[0].items, undefined, 'lines=0 leaves the lines out');
  // A-01-01..04 were counted and posted; the rest has never been counted.
  assert.deepEqual(first.locations.map((l) => l.code), ['A-01-05', 'A-01-06', 'A-01-07', 'A-01-08', 'B-01-01']);
  const b = ok(await manager.post('/api/counts', { type: 'cycle', limit: 3, zone: 'B' }));
  const second = ok(await manager.get(`/api/counts/${b.id}`));
  assert.deepEqual(second.locations.map((l) => l.code), ['B-01-02', 'B-01-03', 'B-01-04']);
  assert.equal(second.type_label, 'Ciklikus');

  assert.equal((await operator.del(`/api/counts/${a.id}`)).status, 403);
  ok(await manager.del(`/api/counts/${a.id}`));
  ok(await manager.del(`/api/counts/${b.id}`));
  assert.equal((await srv.query('SELECT status FROM counts WHERE id = ?', a.id))[0].status, 'cancelled');
  assert.equal((await operator.put(`/api/counts/${a.id}/lines/1`, { counted_qty: 1 })).status, 409, 'cancelled count is closed');
  assert.equal((await manager.post(`/api/counts/${b.id}/finish`)).status, 409);
});

test('product, full and location list counts; validation', async () => {
  const p = ok(await manager.post('/api/counts', { type: 'product', product_ids: [fx.products.tap] }));
  const detail = ok(await manager.get(`/api/counts/${p.id}`));
  assert.deepEqual(detail.locations.map((l) => l.code), ['B-01-01', 'B-01-02']);
  assert.deepEqual(detail.locations.map((l) => l.items[0].lot), ['L2410', 'L2409']);
  assert.equal(detail.scope, 'KB-1001');

  const full = await manager.post('/api/counts', { type: 'full' });
  assert.equal(full.status, 409, 'B-01-01 is in the product count');
  ok(await manager.del(`/api/counts/${p.id}`));
  const f = ok(await manager.post('/api/counts', { type: 'full', blind: false }));
  assert.equal(f.locations, 22);
  const visible = ok(await operator.get(`/api/counts/${f.id}`));
  assert.equal(visible.can_see_expected, true, 'not blind');
  assert.equal(visible.locations.find((l) => l.code === 'C-01-03').items[0].expected_qty, 12);
  assert.equal((await manager.post(`/api/counts/${f.id}/finish`)).status, 409, 'nothing counted yet');
  assert.equal((await manager.post(`/api/counts/${f.id}/post`, {})).status, 409);
  ok(await manager.del(`/api/counts/${f.id}`));

  const bad = await manager.post('/api/counts', { type: 'locations', location_codes: ['A-01-02', 'NINCS-1'] });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error.message, /NINCS-1/);
  assert.equal((await manager.post('/api/counts', { type: 'zone' })).status, 400);
  assert.equal((await manager.post('/api/counts', { type: 'zone', zone: 'X' })).status, 400);
  assert.equal((await manager.post('/api/counts', { type: 'product', product_ids: [] })).status, 400);
  assert.equal((await manager.post('/api/counts', { type: 'what' })).status, 400);
  const l = ok(await manager.post('/api/counts', { type: 'locations', location_codes: ['b-01-03', 'A-01-02'] }));
  const ld = ok(await manager.get(`/api/counts/${l.id}`));
  assert.deepEqual(ld.locations.map((x) => x.code), ['A-01-02', 'B-01-03']);
  ok(await manager.del(`/api/counts/${l.id}`));
});

test('posting refuses two partners in one location, books shortages before surpluses', async () => {
  const c = ok(await manager.post('/api/counts', { type: 'locations', location_codes: ['B-01-03'] }));
  let loc = ok(await operator.get(`/api/counts/${c.id}/locations/20`));
  const alom = lineOf(loc, fx.products.alom);
  ok(await operator.put(`/api/counts/${c.id}/lines/${alom.id}`, { counted_qty: 25 }));
  const res = ok(await operator.get(`/api/counts/${c.id}/resolve?code=KG-2002&location_id=20`));
  assert.equal(res.products[0].same_partner, false, 'another client product');
  loc = ok(await operator.post(`/api/counts/${c.id}/lines`, { location_id: 20, product_id: fx.products.mixer, counted_qty: 2 }));
  const mixed = await manager.post(`/api/counts/${c.id}/post`, {});
  assert.equal(mixed.status, 409);
  assert.match(mixed.data.error.message, /Két ügyfél áruját/);

  // The cat litter is gone, only the mixers are there.
  ok(await operator.put(`/api/counts/${c.id}/lines/${alom.id}`, { counted_qty: 0 }));
  const posted = ok(await manager.post(`/api/counts/${c.id}/post`, {}));
  assert.equal(posted.done, true);
  assert.deepEqual(await stockAt(20), [{ product_id: fx.products.mixer, lot: '', expiry: '', qty: 2 }]);
});

test('confirming a changed line books the counted quantity', async () => {
  const c = ok(await manager.post('/api/counts', { type: 'locations', location_codes: ['C-01-03'] }));
  const loc = ok(await operator.get(`/api/counts/${c.id}/locations/26`));
  const robot = lineOf(loc, fx.products.robot);
  ok(await operator.put(`/api/counts/${c.id}/lines/${robot.id}`, { counted_qty: 11 }));
  const added = await srv.call('stock.addStock', [{ productId: fx.products.robot, locationId: 26, qty: 1, lot: 'B24-07', type: 'inbound', refType: 'inbound', refId: 7 }], { as: 1 });
  assert.equal(added.ok, true, JSON.stringify(added));
  const review = ok(await manager.get(`/api/counts/${c.id}/review`));
  assert.equal(review.lines[0].changed, true);
  assert.equal(review.lines[0].current_qty, 13);
  const posted = ok(await manager.post(`/api/counts/${c.id}/post`, { confirm_line_ids: [robot.id] }));
  assert.equal(posted.done, true);
  assert.deepEqual(await stockAt(26), [{ product_id: fx.products.robot, lot: 'B24-07', expiry: '', qty: 11 }]);
  const [line] = await srv.query('SELECT posted_diff FROM count_lines WHERE id = ?', robot.id);
  assert.equal(line.posted_diff, -2, 'booked against the current stock');
});

test('large counts are posted in parts', async () => {
  const values = [];
  for (let i = 1; i <= 120; i++) values.push(`(${1000 + i}, 'Z-${String(i).padStart(3, '0')}', 'Z', 1, 'storage', ${1000 + i})`);
  await srv.sql(`INSERT INTO locations (id, code, zone, size_id, kind, pick_sequence) VALUES ${values.join(', ')};
    INSERT INTO stock (product_id, location_id, lot, expiry, qty) SELECT ${fx.products.csont}, id, '', '', 5 FROM locations WHERE zone = 'Z'`);
  const c = ok(await manager.post('/api/counts', { type: 'zone', zone: 'Z' }));
  assert.equal(c.lines, 120);
  await srv.sql(`UPDATE count_lines SET counted_qty = 4, counted_at = '2026-10-16T08:00:00.000Z' WHERE count_id = ${c.id}`);
  await srv.sql(`UPDATE counts SET status = 'counted' WHERE id = ${c.id}`);
  const part = ok(await manager.post(`/api/counts/${c.id}/post`, {}));
  assert.equal(part.done, false);
  assert.equal(part.remaining, 20);
  const rest = ok(await manager.post(`/api/counts/${c.id}/post`, {}));
  assert.equal(rest.done, true);
  assert.equal(rest.summary.shortage, 120);
  const [sum] = await srv.query("SELECT SUM(s.qty) AS qty FROM stock s JOIN locations l ON l.id = s.location_id WHERE l.zone = 'Z'");
  assert.equal(sum.qty, 480);
});
