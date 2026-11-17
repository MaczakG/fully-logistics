// Daily storage snapshot (worker/jobs/snapshot.js): what is recorded, idempotency, the 23:00
// Budapest window, the missed-run fallback.
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
const snap = (date, opts) => srv.call('snapshot.takeDailySnapshot', opts ? [date, opts] : [date]);
const rowsOf = (date) => srv.query('SELECT location_id, partner_id, size_id FROM storage_snapshots WHERE date = ? ORDER BY location_id', date);
const runOf = async (date) => (await srv.query('SELECT date, rows, source FROM snapshot_runs WHERE date = ?', date))[0] || null;

test('explicit date: one row per occupied storage or quarantine location with partner and size', async () => {
  // Quarantine counts, the receiving and returns zones do not, inactive locations still count.
  ok(await srv.call('stock.addStock', [{ productId: fx.products.alom, locationId: fx.locations.quarantine, qty: 1, type: 'return' }], { as: 1 }));
  ok(await srv.call('stock.addStock', [{ productId: fx.products.mixer, locationId: fx.locations.receiving, qty: 2, type: 'inbound' }], { as: 1 }));
  ok(await srv.call('stock.addStock', [{ productId: fx.products.robot, locationId: fx.locations.returns, qty: 1, type: 'return' }], { as: 1 }));
  await srv.sql('UPDATE locations SET active = 0 WHERE id = 19');
  const r = ok(await snap('2026-09-01'));
  assert.deepEqual(r, { date: '2026-09-01', rows: 8, recorded: true });
  assert.deepEqual(await rowsOf('2026-09-01'), [
    { location_id: 3, partner_id: 101, size_id: 4 },
    { location_id: 10, partner_id: 101, size_id: 1 },
    { location_id: 11, partner_id: 102, size_id: 1 },
    { location_id: 12, partner_id: 102, size_id: 1 },
    { location_id: 18, partner_id: 101, size_id: 2 },
    { location_id: 19, partner_id: 101, size_id: 2 },
    { location_id: 20, partner_id: 101, size_id: 2 },
    { location_id: 26, partner_id: 102, size_id: 3 },
  ]);
  assert.deepEqual(await runOf('2026-09-01'), { date: '2026-09-01', rows: 8, source: 'manual' });
});

test('re-recording a date replaces it; empty locations disappear; the size is kept per day', async () => {
  ok(await srv.call('stock.removeStock', [{ productId: fx.products.csont, locationId: 10, qty: 300, type: 'adjust' }], { as: 1 }));
  const r = ok(await snap('2026-09-01'));
  assert.equal(r.rows, 7);
  assert.ok(!(await rowsOf('2026-09-01')).some((x) => x.location_id === 10));
  // A location resized later keeps its old size in earlier snapshots.
  await srv.sql('UPDATE locations SET size_id = 3 WHERE id = 20');
  ok(await snap('2026-09-02'));
  assert.equal((await rowsOf('2026-09-01')).find((x) => x.location_id === 20).size_id, 2);
  assert.equal((await rowsOf('2026-09-02')).find((x) => x.location_id === 20).size_id, 3);
  await srv.sql('UPDATE locations SET size_id = 2 WHERE id = 20');
});

test('invalid dates are refused', async () => {
  const bad = await snap('2026-02-30x');
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
});

test('cron: nothing before 23:00 Budapest, then today once', async () => {
  // 2026-10-16 12:00 Budapest (CEST, UTC+2): too early for today. Yesterday was never recorded
  // although earlier days were, so it is filled in from the current stock.
  const early = ok(await snap(null, { now: '2026-10-16T10:00:00Z' }));
  assert.equal(early.recorded, false);
  assert.deepEqual(early.fallback, { date: '2026-10-15', rows: 7 });
  assert.equal(await runOf('2026-10-16'), null);

  const evening = ok(await snap(null, { now: '2026-10-16T21:05:00Z' })); // 23:05 Budapest
  assert.equal(evening.recorded, true);
  assert.equal(evening.date, '2026-10-16');
  assert.equal((await runOf('2026-10-16')).source, 'cron');

  // Later runs the same evening do nothing.
  await srv.sql("DELETE FROM storage_snapshots WHERE date = '2026-10-16' AND location_id = 11");
  const again = ok(await snap(null, { now: '2026-10-16T21:55:00Z' }));
  assert.equal(again.recorded, false);
  assert.equal((await rowsOf('2026-10-16')).length, 6, 'the earlier end of day snapshot is left alone');
});

test('cron: a manual snapshot during the day is replaced by the end of day one', async () => {
  ok(await snap('2026-10-17', { now: '2026-10-17T08:00:00Z' })); // 10:00 Budapest
  ok(await srv.call('stock.addStock', [{ productId: fx.products.tap, locationId: 28, qty: 4, type: 'inbound' }], { as: 1 }));
  const r = ok(await snap(null, { now: '2026-10-17T21:05:00Z' }));
  assert.equal(r.recorded, true);
  assert.ok((await rowsOf('2026-10-17')).some((x) => x.location_id === 28));
  assert.equal((await runOf('2026-10-17')).source, 'cron');
});

test('cron: a missed day is recorded from the current stock the next day and logged', async () => {
  // Nothing ran on the 18th. The first run on the 19th (10:05 Budapest) fills it in.
  const r = ok(await snap(null, { now: '2026-10-19T08:05:00Z' }));
  assert.equal(r.recorded, false, 'the 19th itself waits for 23:00');
  assert.deepEqual(r.fallback, { date: '2026-10-18', rows: 8 });
  assert.equal((await runOf('2026-10-18')).source, 'fallback');
  const [log] = await srv.query("SELECT actor, module, summary FROM audit_log WHERE entity = 'snapshot' AND entity_id = '2026-10-18'");
  assert.equal(log.actor, 'Rendszer');
  assert.equal(log.module, 'billing');
  assert.match(log.summary, /Pótló pillanatkép 2026-10-18/);
  // A day that was recorded with no occupied location is not a missed day.
  await srv.sql('DELETE FROM stock');
  ok(await snap('2026-10-20'));
  assert.deepEqual(await runOf('2026-10-20'), { date: '2026-10-20', rows: 0, source: 'manual' });
  const next = ok(await snap(null, { now: '2026-10-21T06:05:00Z' }));
  assert.equal(next.fallback, undefined);
});

test('cron: the 23:00 window follows Budapest time in winter too', async () => {
  // 2026-11-02 is CET (UTC+1): 21:05Z is 22:05 in Budapest, 22:05Z is 23:05.
  assert.equal(ok(await snap(null, { now: '2026-11-02T21:05:00Z' })).recorded, false);
  const r = ok(await snap(null, { now: '2026-11-02T22:05:00Z' }));
  assert.equal(r.recorded, true);
  assert.equal(r.date, '2026-11-02');
});

test('a location holding two partners (old data) is billed to one of them only', async () => {
  await srv.sql(`INSERT INTO stock (product_id, location_id, qty) VALUES (${fx.products.mixer}, 30, 1), (${fx.products.alom}, 30, 1)`);
  ok(await snap('2026-11-03'));
  assert.deepEqual(await rowsOf('2026-11-03'), [{ location_id: 30, partner_id: 101, size_id: 4 }]);
});
