// Betárolás: create, edit, receiving by scan and by hand, putaway, closing, sztornó, CSV import.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

let srv;
let fx;
let admin;
let manager;
let operator;
let service;
let sales;

// Location ids of the fixture: A-01-01..08 = 10..17 (M), B-01-01..06 = 18..23 (L), C = 24..27, P = 28..31.
const LOC = { a01: 10, a02: 11, a05: 14, a06: 15, b01: 18, b04: 21, b05: 22 };

before(async () => {
  srv = await startServer();
  admin = await srv.admin();
  fx = await srv.seedBasics();
  manager = await srv.userWithRole('warehouse_manager', 'vezeto@example.com');
  operator = await srv.userWithRole('warehouse_operator', 'raktaros@example.com');
  service = await srv.userWithRole('customer_service', 'ugyfelszolgalat@example.com');
  sales = await srv.userWithRole('sales', 'ertekesito@example.com');
});
after(async () => { await srv.stop(); });

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Budapest' }).format(new Date());

function csvForm(text, preview) {
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/csv' }), 'betarolas.csv');
  form.append('preview', preview ? '1' : '0');
  return form;
}

async function newInbound(client = admin, extra = {}) {
  const r = await client.post('/api/inbound', {
    partner_id: fx.clients.kutya, supplier_id: fx.supplier, expected_date: today(), external_ref: 'SZL-1',
    lines: [{ product_id: fx.products.tap, expected_qty: 10 }, { sku: 'KB-1002', expected_qty: 5 }],
    ...extra,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

test('permissions: view, create, receive and cancel are guarded', async () => {
  assert.equal((await sales.get('/api/inbound')).status, 403);
  const { id } = await newInbound(service);
  assert.equal((await service.get(`/api/inbound/${id}`)).status, 200);
  assert.equal((await service.post(`/api/inbound/${id}/arrive`, {})).status, 403, 'customer service may not receive');
  assert.equal((await service.post(`/api/inbound/${id}/scan`, { code: 'KB-1002' })).status, 403);
  assert.equal((await operator.post(`/api/inbound/${id}/cancel`, {})).status, 403, 'operator may not cancel');
  assert.equal((await sales.post('/api/inbound', { partner_id: fx.clients.kutya, lines: [{ sku: 'KB-1002', expected_qty: 1 }] })).status, 403);
});

test('create validates the client, the products and the quantities', async () => {
  const empty = await admin.post('/api/inbound', { partner_id: fx.clients.kutya, lines: [] });
  assert.equal(empty.status, 400);
  assert.ok(empty.data.error.fields.lines);
  const foreign = await admin.post('/api/inbound', { partner_id: fx.clients.kutya, lines: [{ sku: 'KG-2001', expected_qty: 3 }] });
  assert.equal(foreign.status, 400);
  assert.match(foreign.data.error.fields['lines.0.sku'], /KG-2001/);
  const zero = await admin.post('/api/inbound', { partner_id: fx.clients.kutya, lines: [{ sku: 'KB-1002', expected_qty: 0 }] });
  assert.equal(zero.status, 400);
  assert.ok(zero.data.error.fields['lines.0.expected_qty']);
  const supplierAsClient = await admin.post('/api/inbound', { partner_id: fx.supplier, lines: [{ sku: 'KB-1002', expected_qty: 1 }] });
  assert.equal(supplierAsClient.status, 400);
  assert.ok(supplierAsClient.data.error.fields.partner_id);
  const twice = await admin.post('/api/inbound', { partner_id: fx.clients.kutya, lines: [{ sku: 'KB-1002', expected_qty: 1 }, { sku: 'KB-1002', expected_qty: 2 }] });
  assert.equal(twice.status, 400);
  assert.ok(twice.data.error.fields['lines.1.sku']);

  const created = await newInbound(operator);
  assert.match(created.number, /^BT-\d{4}-\d{5}$/);
  const [row] = await srv.query('SELECT status, source, supplier_id, created_by FROM inbounds WHERE id = ?', created.id);
  assert.equal(row.status, 'expected');
  assert.equal(row.source, 'manual');
  assert.equal(row.supplier_id, fx.supplier);
  const log = await srv.query("SELECT summary FROM audit_log WHERE entity = 'inbound' AND entity_id = ?", String(created.id));
  assert.match(log[0].summary, /létrehozva/);
});

test('list: filters, totals per row, counts per status and KPIs', async () => {
  const a = await newInbound(admin, { external_ref: 'KERES-77' });
  await admin.post('/api/inbound', { partner_id: fx.clients.konyha, expected_date: '2026-01-05', lines: [{ sku: 'KG-2002', expected_qty: 24 }] });
  const all = await admin.get('/api/inbound?status=open');
  assert.equal(all.status, 200);
  assert.ok(all.data.total >= 2);
  assert.ok(all.data.counts.expected >= 2);
  assert.equal(all.data.counts.open, all.data.counts.expected + all.data.counts.arrived + all.data.counts.receiving);
  assert.ok(all.data.kpis.expected_today >= 1);
  assert.ok(all.data.kpis.overdue >= 1, 'the January inbound is overdue');

  const byRef = await admin.get('/api/inbound?q=KERES-77');
  assert.equal(byRef.data.total, 1);
  const row = byRef.data.items[0];
  assert.equal(row.id, a.id);
  assert.equal(row.line_count, 2);
  assert.equal(row.expected_qty, 15);
  assert.equal(row.received_qty, 0);
  assert.equal(row.partner_code, 'KUTYA');
  assert.equal(row.supplier_code, 'TAPGYAR');

  const konyha = await admin.get(`/api/inbound?partner_id=${fx.clients.konyha}`);
  assert.ok(konyha.data.items.every((i) => i.partner_id === fx.clients.konyha));
  const range = await admin.get('/api/inbound?from=2026-01-01&to=2026-01-31');
  assert.ok(range.data.items.length >= 1);
  assert.ok(range.data.items.every((i) => i.expected_date >= '2026-01-01' && i.expected_date <= '2026-01-31'));
  const paged = await admin.get('/api/inbound?limit=1&offset=0');
  assert.equal(paged.data.items.length, 1);
});

test('edit header and lines while expected, not after receiving started', async () => {
  const { id } = await newInbound();
  const detail = (await admin.get(`/api/inbound/${id}`)).data;
  const [tap, alom] = detail.lines;
  const r = await operator.put(`/api/inbound/${id}`, {
    partner_id: fx.clients.kutya, supplier_id: null, expected_date: '2026-11-02', external_ref: 'SZL-2', pallets: 2, cartons: 0, note: 'Hívd fel a sofőrt',
    lines: [{ id: tap.id, product_id: fx.products.tap, expected_qty: 12, lot: 'L-NEW', expiry: '2027-06-30' }, { sku: 'KB-1003', expected_qty: 100 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = (await admin.get(`/api/inbound/${id}`)).data;
  assert.equal(after.expected_date, '2026-11-02');
  assert.equal(after.supplier_id, null);
  assert.deepEqual(after.lines.map((l) => [l.sku, l.expected_qty, l.lot]), [['KB-1001', 12, 'L-NEW'], ['KB-1003', 100, '']]);
  assert.ok(!after.lines.some((l) => l.product_id === alom.product_id), 'removed line is gone');

  const foreignLine = await operator.put(`/api/inbound/${id}`, { partner_id: fx.clients.kutya, lines: [{ id: 999999, sku: 'KB-1003', expected_qty: 1 }] });
  assert.equal(foreignLine.status, 400);

  await operator.post(`/api/inbound/${id}/scan`, { code: 'KB-1003' });
  const late = await operator.put(`/api/inbound/${id}`, { partner_id: fx.clients.kutya, lines: [{ sku: 'KB-1003', expected_qty: 1 }] });
  assert.equal(late.status, 409);
  assert.match(late.data.error.message, /nem szerkeszthető/);
});

test('receiving workflow: arrive, scan, count, putaway, close with discrepancy', async () => {
  const { id, number } = await newInbound();
  const arrived = await operator.post(`/api/inbound/${id}/arrive`, { pallets: 1, cartons: 6, note: 'Fóliázás sérült' });
  assert.equal(arrived.status, 200);
  let d = (await operator.get(`/api/inbound/${id}`)).data;
  assert.equal(d.status, 'arrived');
  assert.equal(d.cartons, 6);
  assert.equal(d.arrival_note, 'Fóliázás sérült');
  assert.ok(d.arrived_at);
  const tapLine = d.lines.find((l) => l.product_id === fx.products.tap);
  const alomLine = d.lines.find((l) => l.product_id === fx.products.alom);
  assert.equal(tapLine.track_lot, true);
  assert.ok(alomLine.suggested && alomLine.suggested.code, 'putaway suggestion for each line');
  assert.equal(alomLine.suggested.id, 20, 'suggests where the product already is');
  assert.equal(d.quarantine.code, 'KARANTEN');

  // One scan = one piece; EAN and SKU both work; a carton quantity counts at once.
  for (let i = 0; i < 3; i++) {
    const s = await operator.post(`/api/inbound/${id}/scan`, { code: '5990000010022' });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    assert.equal(s.data.result, 'counted');
  }
  const carton = await operator.post(`/api/inbound/${id}/scan`, { code: 'kb-1002', qty: 2 });
  assert.equal(carton.data.line.received_qty, 5);
  assert.equal(carton.data.status, 'receiving');
  const unknown = await operator.post(`/api/inbound/${id}/scan`, { code: '0000000' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.data.error.message, /Ismeretlen kód/);
  const foreign = await operator.post(`/api/inbound/${id}/scan`, { code: '5990000020014' });
  assert.equal(foreign.status, 400);
  assert.match(foreign.data.error.message, /KONYHA ügyfél terméke/);
  const loc = await operator.post(`/api/inbound/${id}/scan`, { code: 'a-01-05' });
  assert.equal(loc.data.result, 'location');
  assert.equal(loc.data.location.id, LOC.a05);

  // Unexpected product: asked first, added as a line with expected 0 on confirmation.
  const unexpected = await operator.post(`/api/inbound/${id}/scan`, { code: 'KB-1003', qty: 4 });
  assert.equal(unexpected.data.result, 'unexpected');
  assert.equal(unexpected.data.product.sku, 'KB-1003');
  const added = await operator.post(`/api/inbound/${id}/scan`, { code: 'KB-1003', qty: 4, add_line: true });
  assert.equal(added.data.result, 'counted');
  assert.equal(added.data.line.expected_qty, 0);
  assert.equal(added.data.line.received_qty, 4);
  assert.equal(added.data.line.issues[0].kind, 'unexpected');

  // Manual count with damage, lot and expiry.
  const tooDamaged = await operator.post(`/api/inbound/${id}/lines/${tapLine.id}/receive`, { received_qty: 3, damaged_qty: 4 });
  assert.equal(tooDamaged.status, 400);
  const badDate = await operator.post(`/api/inbound/${id}/lines/${tapLine.id}/receive`, { expiry: '2027-02-31' });
  assert.equal(badDate.status, 400);

  // Lot tracked product: putaway refused until the lot is known.
  await operator.post(`/api/inbound/${id}/lines/${tapLine.id}/receive`, { received_qty: 10, damaged_qty: 1 });
  const noLot = await operator.post(`/api/inbound/${id}/putaway`, { line_id: tapLine.id, location_code: 'B-01-01', qty: 9 });
  assert.equal(noLot.status, 400);
  assert.match(noLot.data.error.message, /sarzsszámot/);
  const counted = await operator.post(`/api/inbound/${id}/lines/${tapLine.id}/receive`, { lot: 'L2411', expiry: '2027-08-31' });
  assert.equal(counted.status, 200, JSON.stringify(counted.data));
  assert.equal(counted.data.line.received_qty, 10);
  assert.equal(counted.data.line.damaged_qty, 1);

  // One partner per location: A-01-02 holds Konyhagép goods. The reservation is rolled back.
  const mixed = await operator.post(`/api/inbound/${id}/putaway`, { line_id: alomLine.id, location_id: LOC.a02, qty: 5 });
  assert.equal(mixed.status, 409);
  assert.match(mixed.data.error.message, /Egy helyen csak egy partner áruja lehet/);
  assert.equal((await srv.query('SELECT putaway_qty FROM inbound_lines WHERE id = ?', alomLine.id))[0].putaway_qty, 0);
  const ramp = await operator.post(`/api/inbound/${id}/putaway`, { line_id: alomLine.id, location_code: 'RAMPA-BE', qty: 1 });
  assert.equal(ramp.status, 409);
  const tooMany = await operator.post(`/api/inbound/${id}/putaway`, { line_id: alomLine.id, location_code: 'A-01-05', qty: 6 });
  assert.equal(tooMany.status, 409);
  assert.match(tooMany.data.error.message, /legfeljebb 5/);

  const put = await operator.post(`/api/inbound/${id}/putaway`, { line_id: alomLine.id, location_code: 'a-01-05', qty: 5 });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.line.putaway_qty, 5);
  assert.equal(put.data.line.putaways[0].location_code, 'A-01-05');
  await operator.post(`/api/inbound/${id}/putaway`, { line_id: tapLine.id, location_id: LOC.b01, qty: 9 });
  await operator.post(`/api/inbound/${id}/putaway`, { line_id: tapLine.id, location_id: fx.locations.quarantine, qty: 1 });

  const stock = await srv.query('SELECT location_id, lot, expiry, qty FROM stock WHERE product_id = ? ORDER BY location_id, lot', fx.products.tap);
  assert.deepEqual(stock.find((s) => s.lot === 'L2411' && s.location_id === LOC.b01), { location_id: LOC.b01, lot: 'L2411', expiry: '2027-08-31', qty: 9 });
  assert.ok(stock.find((s) => s.location_id === fx.locations.quarantine && s.lot === 'L2411' && s.qty === 1));
  const moves = await srv.query("SELECT type, qty, ref_type, ref_id, note FROM movements WHERE ref_type = 'inbound' AND ref_id = ? ORDER BY id", id);
  assert.deepEqual(moves.map((m) => [m.type, m.qty]), [['inbound', 5], ['inbound', 9], ['inbound', 1]]);
  assert.equal(moves[0].note, number);

  // Received may not go below what is already put away; lot is frozen after putaway.
  const below = await operator.post(`/api/inbound/${id}/lines/${alomLine.id}/receive`, { received_qty: 4 });
  assert.equal(below.status, 409);
  const scanBack = await operator.post(`/api/inbound/${id}/lines/${alomLine.id}/receive`, { add: -1 });
  assert.equal(scanBack.status, 409);
  const lotLater = await operator.post(`/api/inbound/${id}/lines/${tapLine.id}/receive`, { lot: 'MASIK' });
  assert.equal(lotLater.status, 409);

  // Cancel is no longer possible, closing needs approve because of the damage and the extra line.
  d = (await operator.get(`/api/inbound/${id}`)).data;
  assert.equal(d.can_cancel, false);
  assert.equal(d.discrepancy, true);
  assert.equal((await manager.post(`/api/inbound/${id}/cancel`, {})).status, 409);
  const opClose = await operator.post(`/api/inbound/${id}/complete`, { note: 'ok' });
  assert.equal(opClose.status, 403);
  assert.match(opClose.data.error.message, /jóváhagyási joggal/);
  const noReason = await manager.post(`/api/inbound/${id}/complete`, {});
  assert.equal(noReason.status, 400);
  assert.ok(noReason.data.error.fields.note);
  const closed = await manager.post(`/api/inbound/${id}/complete`, { note: '1 db sérült zsák, 4 db rágócsont nem volt a szállítólevélen' });
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal(closed.data.has_discrepancy, true);
  d = (await manager.get(`/api/inbound/${id}`)).data;
  assert.equal(d.status, 'completed');
  assert.equal(d.has_discrepancy, true);
  assert.match(d.discrepancy_note, /sérült/);
  assert.ok(d.completed_by_name);
  assert.ok(d.history.some((h) => /lezárva eltéréssel/.test(h.summary)));
  assert.ok(d.history.some((h) => /polcra: A-01-05/.test(h.summary)));
  assert.equal((await operator.post(`/api/inbound/${id}/scan`, { code: 'KB-1002' })).status, 409, 'no counting after closing');

  const kpi = (await admin.get('/api/inbound')).data.kpis;
  assert.ok(kpi.discrepancy_30d >= 1);
});

test('closing without discrepancy needs only edit', async () => {
  const { id } = await newInbound(admin, { lines: [{ sku: 'KB-1003', expected_qty: 3 }] });
  const early = await operator.post(`/api/inbound/${id}/complete`, {});
  assert.equal(early.status, 409, 'expected inbound cannot be closed');
  const putEarly = await operator.post(`/api/inbound/${id}/putaway`, { line_id: 1, location_code: 'A-01-01', qty: 1 });
  assert.equal(putEarly.status, 409);
  // Counting on an expected inbound marks it arrived and receiving.
  const s = await operator.post(`/api/inbound/${id}/scan`, { code: '5990000010039', qty: 3 });
  assert.equal(s.data.status, 'receiving');
  const lineId = s.data.line.id;
  assert.ok((await srv.query('SELECT arrived_at FROM inbounds WHERE id = ?', id))[0].arrived_at);
  // A-01-01 already holds KB-1003 of the same client.
  assert.equal((await operator.post(`/api/inbound/${id}/putaway`, { line_id: lineId, location_id: LOC.a01, qty: 3 })).status, 200);
  const closed = await operator.post(`/api/inbound/${id}/complete`, {});
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal(closed.data.has_discrepancy, false);
  const [row] = await srv.query('SELECT status, has_discrepancy FROM inbounds WHERE id = ?', id);
  assert.deepEqual(row, { status: 'completed', has_discrepancy: 0 });
});

test('extra lines during receiving and sztornó before putaway', async () => {
  const { id } = await newInbound();
  await operator.post(`/api/inbound/${id}/arrive`, {});
  // Second lot of the tap: a new line with expected 0.
  const lot2 = await operator.post(`/api/inbound/${id}/lines`, { product_id: fx.products.tap, lot: 'L2412', expiry: '2027-09-30', received_qty: 2 });
  assert.equal(lot2.status, 200, JSON.stringify(lot2.data));
  const dup = await operator.post(`/api/inbound/${id}/lines`, { product_id: fx.products.tap, lot: 'L2412', expiry: '2027-09-30' });
  assert.equal(dup.status, 409);
  const foreign = await operator.post(`/api/inbound/${id}/lines`, { product_id: fx.products.robot });
  assert.equal(foreign.status, 400);
  const expectedLine = (await admin.get(`/api/inbound/${id}`)).data.lines[0];
  assert.equal((await operator.del(`/api/inbound/${id}/lines/${expectedLine.id}`)).status, 409, 'expected lines stay');
  assert.equal((await operator.del(`/api/inbound/${id}/lines/${lot2.data.line.id}`)).status, 200);

  const cancelled = await manager.post(`/api/inbound/${id}/cancel`, { reason: 'A beszállító visszavonta' });
  assert.equal(cancelled.status, 200);
  const [row] = await srv.query('SELECT status, cancel_reason, cancelled_at FROM inbounds WHERE id = ?', id);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.cancel_reason, 'A beszállító visszavonta');
  assert.ok(row.cancelled_at);
  assert.equal((await manager.post(`/api/inbound/${id}/cancel`, {})).status, 409);
  assert.equal((await operator.post(`/api/inbound/${id}/arrive`, {})).status, 409);
});

test('receiving by typed quantity: a peek scan only finds the line, typed quantities add up and are logged', async () => {
  const { id } = await newInbound();
  await operator.post(`/api/inbound/${id}/arrive`, {});
  const tap = (await admin.get(`/api/inbound/${id}`)).data.lines.find((l) => l.product_id === fx.products.tap);
  const peek = await operator.post(`/api/inbound/${id}/scan`, { code: '5990000010015', peek: true });
  assert.deepEqual(peek.data, { result: 'match', line_id: tap.id });
  const unexpected = await operator.post(`/api/inbound/${id}/scan`, { code: 'KB-1003', peek: true, add_line: true });
  assert.equal(unexpected.data.result, 'unexpected', 'a peek never adds a line');
  assert.equal(unexpected.data.product.sku, 'KB-1003');
  assert.equal((await operator.post(`/api/inbound/${id}/scan`, { code: 'A-01-01', peek: true })).data.result, 'location');
  let d = (await admin.get(`/api/inbound/${id}`)).data;
  assert.equal(d.lines.length, 2);
  assert.equal(d.lines.find((l) => l.id === tap.id).received_qty, 0, 'nothing counted by a peek');
  assert.equal(d.status, 'arrived');

  // Two operators confirm their typed counts at the same moment: the deltas add up.
  const [a, b] = await Promise.all([
    operator.post(`/api/inbound/${id}/lines/${tap.id}/receive`, { add: 6, damaged_add: 0 }),
    manager.post(`/api/inbound/${id}/lines/${tap.id}/receive`, { add: 4, damaged_add: 4 }),
  ]);
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(b.status, 200, JSON.stringify(b.data));
  d = (await admin.get(`/api/inbound/${id}`)).data;
  const line = d.lines.find((l) => l.id === tap.id);
  assert.equal(line.received_qty, 10);
  assert.equal(line.damaged_qty, 4);
  assert.equal(d.status, 'receiving');
  // A scanner's single scans stay out of the log, typed quantities are in it.
  await operator.post(`/api/inbound/${id}/scan`, { code: 'KB-1001' });
  const log = (await srv.query("SELECT summary FROM audit_log WHERE entity = 'inbound' AND entity_id = ? ORDER BY id", String(id))).map((r) => r.summary);
  assert.ok(log.some((t) => /^KB-1001: 6 átvéve, összesen (6|10)$/.test(t)), log.join(' | '));
  assert.ok(log.some((t) => /^KB-1001: 4 átvéve, ebből sérült 4, összesen (4|10)$/.test(t)), log.join(' | '));
  assert.equal(log.filter((t) => t.startsWith('KB-1001:')).length, 2, 'the scan is not logged');
});

test('inactive products cannot be put on a new inbound', async () => {
  await srv.sql("INSERT INTO products (id, partner_id, sku, name, active) VALUES (1901, 101, 'KB-OLD', 'Kifutott cikk', 0)");
  const r = await admin.post('/api/inbound', { partner_id: fx.clients.kutya, lines: [{ sku: 'KB-OLD', expected_qty: 1 }] });
  assert.equal(r.status, 400);
  assert.match(r.data.error.fields['lines.0.sku'], /Inaktív/);
});

test('CSV import: preview changes nothing, groups by reference, skips broken shipments, no double import', async () => {
  const csv = [
    'Ügyfélkód;Külső hivatkozás;Várható dátum;Cikkszám;Mennyiség;Sarzs;Lejárat;Beszállító kód',
    'KUTYA;ASN-100;2026.11.05.;KB-1001;20;L2501;2027-12-31;TAPGYAR',
    'KUTYA;ASN-100;2026.11.05.;KB-1002;8;;;TAPGYAR',
    'KUTYA;ASN-100;2026.11.05.;KB-1002;2;;;TAPGYAR',
    'KONYHA;ASN-200;2026-11-06;KG-2002;12;;;',
    'KONYHA;ASN-200;2026-11-06;NINCS-ILYEN;1;;;',
    'NEMLETEZO;ASN-300;2026-11-06;KB-1001;1;;;',
    'KUTYA;ASN-400;holnap;KB-1003;1;;;',
  ].join('\r\n');
  assert.equal((await sales.request('POST', '/api/inbound/import', csvForm(csv, true))).status, 403);
  const before = (await srv.query('SELECT COUNT(*) AS n FROM inbounds'))[0].n;
  const preview = await service.request('POST', '/api/inbound/import', csvForm(csv, true));
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.rows, 7);
  assert.equal(preview.data.valid, 3);
  assert.equal(preview.data.inbounds, 1);
  assert.deepEqual(preview.data.errors.map((e) => e.line), [5, 6, 7, 8]);
  assert.match(preview.data.errors.find((e) => e.line === 5).message, /Kimarad/);
  assert.match(preview.data.errors.find((e) => e.line === 6).message, /NINCS-ILYEN/);
  assert.match(preview.data.errors.find((e) => e.line === 8).message, /Hibás várható dátum/);
  assert.equal(preview.data.sample[0].qty, 30);
  assert.equal((await srv.query('SELECT COUNT(*) AS n FROM inbounds'))[0].n, before, 'preview writes nothing');

  const commit = await service.request('POST', '/api/inbound/import', csvForm(csv, false));
  assert.equal(commit.status, 200, JSON.stringify(commit.data));
  assert.equal(commit.data.imported, 3);
  assert.equal(commit.data.inbounds, 1);
  const [inb] = await srv.query("SELECT id, source, expected_date, supplier_id FROM inbounds WHERE external_ref = 'ASN-100'");
  assert.equal(inb.source, 'csv');
  assert.equal(inb.expected_date, '2026-11-05');
  assert.equal(inb.supplier_id, fx.supplier);
  const lines = await srv.query('SELECT product_id, expected_qty, lot, expiry FROM inbound_lines WHERE inbound_id = ? ORDER BY id', inb.id);
  assert.deepEqual(lines, [
    { product_id: fx.products.tap, expected_qty: 20, lot: 'L2501', expiry: '2027-12-31' },
    { product_id: fx.products.alom, expected_qty: 10, lot: '', expiry: '' },
  ]);
  const again = await service.request('POST', '/api/inbound/import', csvForm(csv, true));
  assert.equal(again.data.valid, 0);
  assert.match(again.data.errors.find((e) => e.line === 2).message, /Már van betárolás/);

  const missing = await service.request('POST', '/api/inbound/import', csvForm('Cikkszám;Mennyiség\r\nKB-1001;1', true));
  assert.equal(missing.status, 400);
  assert.match(missing.data.error.message, /Ügyfélkód/);
});
