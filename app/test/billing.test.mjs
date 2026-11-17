// Elszámolás: monthly statement calculation, drafts, manual lines, approval, void, entries,
// exports and permissions. The month is built in billing-fixture.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { PERIOD, clerk, seedEntries, seedMonth } from './billing-fixture.mjs';

let srv;
let admin;
let sales;
let billingClerk;
let entryIds;
const ids = {};

before(async () => {
  srv = await startServer();
  admin = await srv.admin();
  await srv.seedBasics();
  await seedMonth(srv);
  sales = await srv.userWithRole('sales');
  billingClerk = await clerk(srv);
  entryIds = await seedEntries(billingClerk);
});
after(async () => { await srv.stop(); });

const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
const byKey = (lines) => Object.fromEntries(lines.map((l) => [l.key, l]));

// Hand-worked expectation for Kutyabarát, September 2026 (see billing-fixture.mjs).
const KUTYA = [
  ['handling.order_base', 5, 650, 3250, 878],
  ['handling.item_2', 4, 90, 360, 97],
  ['handling.item_3', 3, 60, 180, 49],
  ['handling.item_extra', 3, 50, 150, 41],
  ['handling.packaging', 5, 150, 750, 203],
  ['storage.M', 25, 800, 667, 180], // 25 location-days x 800 / 30 = 666.67
  ['storage.L', 90, 990, 2970, 802], // default price
  ['storage.PAL', 20, 15000, 10000, 2700], // pallet place + quarantine, 10 days each
  ['inbound.inbound_unit', 65, 49, 3185, 860],
  ['inbound.return_unit', 2, 499, 998, 269],
  ['extra.cod_fixed', 3, 120, 360, 97],
  ['extra.cod_pct', 22990, 1.5, 345, 93], // 1.5% of 22 990 = 344.85
  ['extra.hourly_work', 4, 6500, 26000, 7020],
  ['custom.monthly.8002', 1, 15000, 15000, 4050],
  ['custom.unit.8001', 200, 25, 5000, 1350],
  ['discount.handling', 1, -469, -469, -127], // 10% of 4 690
  ['discount.storage', 1, -682, -682, -184], // 5% of 13 637 = 681.85
];

test('overview before generation: every active client without statement, snapshot coverage', async () => {
  const o = ok(await sales.get(`/api/billing/overview?period=${PERIOD}`));
  assert.deepEqual(o.items.map((x) => [x.partner_id, x.status]), [[102, 'none'], [101, 'none']]);
  assert.equal(o.kpis.missing_count, 2);
  assert.equal(o.snapshots.expected, 30);
  assert.equal(o.snapshots.recorded, 30);
  assert.deepEqual(o.snapshots.missing, []);
  assert.equal(o.invoicing.configured, false);
  assert.equal(o.label, '2026. szeptember');
  // Default period is the previous month.
  assert.match(ok(await sales.get('/api/billing/overview')).period, /^\d{4}-\d{2}$/);
  assert.equal((await sales.get('/api/billing/overview?period=2026-13')).status, 400);
});

test('permissions: view only roles cannot generate, edit, approve or record entries', async () => {
  assert.equal((await sales.post('/api/billing/statements/generate', { period: PERIOD })).status, 403);
  assert.equal((await sales.post('/api/billing/entries', { partner_id: 101, date: '2026-09-01', kind: 'hourly_work', qty: 1 })).status, 403);
  assert.equal((await sales.post('/api/billing/snapshot')).status, 403);
  const op = await srv.userWithRole('warehouse_operator');
  assert.equal((await op.get(`/api/billing/overview?period=${PERIOD}`)).status, 403);
  assert.equal((await op.get(`/api/billing/entries?period=${PERIOD}`)).status, 403);
});

test('generate drafts: exact amounts per line, VAT line by line', async () => {
  const g = ok(await billingClerk.post('/api/billing/statements/generate', { period: PERIOD }));
  assert.equal(g.created, 2);
  assert.equal(g.updated, 0);
  for (const s of g.statements) ids[s.partner_id] = s.id;
  assert.match(g.statements[0].number, /^EL-\d{4}-\d{5}$/);

  const st = ok(await sales.get(`/api/billing/statements/${ids[101]}`));
  assert.equal(st.status, 'draft');
  assert.equal(st.stale, false);
  assert.deepEqual(st.lines.map((l) => [l.key, l.qty, l.price, l.amount, l.vat]), KUTYA);
  assert.equal(st.net, 68064);
  assert.equal(st.vat, 18378, 'VAT is the sum of the rounded line VATs, not 27% of the net');
  assert.equal(st.gross, 86442);
  assert.equal(st.vat_pct, 27);
  const l = byKey(st.lines);
  assert.deepEqual(l['handling.order_base'].detail.buckets, { 1: 1, 2: 1, 3: 1, '4+': 2 });
  assert.equal(l['storage.M'].detail.location_days, 25);
  assert.equal(l['storage.PAL'].detail.locations, 2);
  assert.equal(l['storage.L'].group, 'storage');
  assert.ok(!st.lines.some((x) => x.name === 'Régi havidíj'), 'inactive custom items are not billed');

  const k = ok(await sales.get(`/api/billing/statements/${ids[102]}`));
  assert.deepEqual(k.lines.map((x) => [x.key, x.qty, x.amount, x.vat]), [
    ['handling.order_base', 1, 600, 162],
    ['handling.packaging', 1, 150, 41],
    ['storage.M', 60, 1560, 421],
    ['storage.XL', 30, 1350, 365],
    ['inbound.inbound_unit', 12, 588, 159],
  ]);
  assert.deepEqual([k.net, k.vat, k.gross], [4248, 1148, 5396]);

  const o = ok(await sales.get(`/api/billing/overview?period=${PERIOD}`));
  assert.equal(o.kpis.draft_count, 2);
  assert.equal(o.kpis.total_net, 68064 + 4248);
  assert.equal(o.kpis.missing_count, 0);
});

test('drill-down lists: orders with piece counts and fees, inbound, returns, storage, entries', async () => {
  const orders = ok(await sales.get(`/api/billing/statements/${ids[101]}/details?kind=orders`));
  assert.equal(orders.total, 5);
  assert.deepEqual(orders.items.map((o) => [o.number, o.pieces, o.fee]), [
    ['R-2026-905001', 1, 800], // 650 + 150 packaging
    ['R-2026-905002', 2, 890],
    ['R-2026-905003', 3, 950],
    ['R-2026-905005', 4, 1000],
    ['R-2026-905004', 5, 1050],
  ]);
  const inbound = ok(await sales.get(`/api/billing/statements/${ids[101]}/details?kind=inbound`));
  assert.deepEqual(inbound.items.map((m) => [m.date, m.sku, m.qty]), [['2026-09-03', 'KB-1001', 40], ['2026-09-20', 'KB-1002', 25]]);
  const returns = ok(await sales.get(`/api/billing/statements/${ids[101]}/details?kind=returns`));
  assert.deepEqual(returns.items.map((x) => [x.number, x.order_number, x.pieces]), [['VR-2026-90001', 'R-2026-905003', 2], ['VR-2026-90002', null, 1]]);
  const storage = ok(await sales.get(`/api/billing/statements/${ids[101]}/details?kind=storage`));
  assert.deepEqual(storage.items.map((s) => [s.code, s.size_code, s.days, s.first_date, s.last_date]), [
    ['A-01-01', 'M', 25, '2026-09-01', '2026-09-25'],
    ['B-01-01', 'L', 30, '2026-09-01', '2026-09-30'],
    ['B-01-02', 'L', 30, '2026-09-01', '2026-09-30'],
    ['B-01-03', 'L', 30, '2026-09-01', '2026-09-30'],
    ['KARANTEN', 'PAL', 10, '2026-09-21', '2026-09-30'],
    ['P-01-01', 'PAL', 10, '2026-09-21', '2026-09-30'],
  ]);
  assert.ok(!storage.items.some((s) => s.code === 'RAMPA-BE'), 'receiving zone is not billed');
  const entries = ok(await sales.get(`/api/billing/statements/${ids[101]}/details?kind=entries`));
  assert.deepEqual(entries.items.map((e) => [e.date, e.kind, e.qty, e.price]), [
    ['2026-09-05', 'custom', 120, 25], ['2026-09-12', 'hourly_work', 2.5, 6500], ['2026-09-18', 'custom', 80, 25], ['2026-09-28', 'hourly_work', 1.5, 6500],
  ]);
  assert.equal((await sales.get(`/api/billing/statements/${ids[101]}/details?kind=nope`)).status, 400);
});

test('manual lines on drafts; computed lines cannot be removed', async () => {
  assert.equal((await sales.post(`/api/billing/statements/${ids[101]}/lines`, { name: 'X', qty: 1, price: 1 })).status, 403);
  const bad = await billingClerk.post(`/api/billing/statements/${ids[101]}/lines`, { name: '', qty: 0, price: 'x' });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.error.fields.name && bad.data.error.fields.qty && bad.data.error.fields.price);
  const add = ok(await billingClerk.post(`/api/billing/statements/${ids[101]}/lines`, { group: 'extra', name: 'Raklapfóliázás', qty: 3, unit: 'raklap', price: 1250.5 }));
  assert.equal(add.net, 68064 + 3752); // 3 x 1250.5 = 3751.5 -> 3752
  const credit = ok(await billingClerk.post(`/api/billing/statements/${ids[101]}/lines`, { group: 'discount', name: 'Jóváírás: késedelmes kiszállítás', qty: 1, price: -2000 }));
  assert.equal(credit.net, 68064 + 3752 - 2000);
  const st = ok(await sales.get(`/api/billing/statements/${ids[101]}`));
  const manual = st.lines.filter((l) => l.manual);
  assert.deepEqual(manual.map((l) => [l.group, l.amount, l.vat]), [['extra', 3752, 1013], ['discount', -2000, -540]]);
  assert.equal(st.stale, false, 'manual lines do not make a draft stale');

  const computed = st.lines.find((l) => l.key === 'storage.L');
  assert.equal((await billingClerk.del(`/api/billing/statements/${ids[101]}/lines/${computed.id}`)).status, 409);
  ok(await billingClerk.del(`/api/billing/statements/${ids[101]}/lines/${manual[1].id}`));
  assert.equal(ok(await sales.get(`/api/billing/statements/${ids[101]}`)).net, 68064 + 3752);
});

test('a draft becomes stale when data changes; approval needs regeneration, which keeps manual lines', async () => {
  // A new hourly entry after the draft was made.
  const e = ok(await billingClerk.post('/api/billing/entries', { partner_id: 101, date: '2026-09-29', kind: 'hourly_work', qty: 1 }));
  const st = ok(await sales.get(`/api/billing/statements/${ids[101]}`));
  assert.equal(st.stale, true);
  assert.equal(st.fresh.net, 68064 + 3752 + 6500);

  assert.equal((await billingClerk.post(`/api/billing/statements/${ids[101]}/approve`)).status, 403, 'clerk has no approve right');
  const refused = await admin.post(`/api/billing/statements/${ids[101]}/approve`);
  assert.equal(refused.status, 409);
  assert.match(refused.data.error.message, /Számold újra/);

  const g = ok(await billingClerk.post('/api/billing/statements/generate', { period: PERIOD, partner_ids: [101] }));
  assert.deepEqual([g.created, g.updated], [0, 1]);
  const again = ok(await sales.get(`/api/billing/statements/${ids[101]}`));
  assert.equal(again.stale, false);
  assert.equal(byKey(again.lines)['extra.hourly_work'].qty, 5);
  assert.equal(again.lines.filter((l) => l.manual).length, 1, 'manual lines survive regeneration');
  // Remove the extra entry again and regenerate, so the remaining tests see the hand-worked month.
  ok(await admin.del(`/api/billing/entries/${e.id}`));
  ok(await billingClerk.post('/api/billing/statements/generate', { period: PERIOD, partner_ids: [101] }));
  assert.equal(ok(await sales.get(`/api/billing/statements/${ids[101]}`)).net, 68064 + 3752);
});

test('approve locks the statement: no regeneration, no line changes, no entries for the month', async () => {
  ok(await admin.post(`/api/billing/statements/${ids[101]}/approve`));
  const st = ok(await sales.get(`/api/billing/statements/${ids[101]}`));
  assert.equal(st.status, 'approved');
  assert.equal(st.approved_by_name, 'Teszt Admin');
  assert.equal((await admin.post(`/api/billing/statements/${ids[101]}/approve`)).status, 409);
  assert.equal((await admin.post(`/api/billing/statements/${ids[101]}/lines`, { name: 'Utólagos', qty: 1, price: 100 })).status, 409);
  assert.equal((await admin.del(`/api/billing/statements/${ids[101]}`)).status, 409);

  const g = ok(await billingClerk.post('/api/billing/statements/generate', { period: PERIOD }));
  assert.equal(g.created, 0);
  assert.equal(g.updated, 1, 'the other draft is regenerated');
  assert.deepEqual(g.skipped.map((s) => [s.partner_id, s.reason]), [[101, 'Már jóvá van hagyva.']]);

  const locked = await billingClerk.post('/api/billing/entries', { partner_id: 101, date: '2026-09-30', kind: 'hourly_work', qty: 1 });
  assert.equal(locked.status, 409);
  assert.match(locked.data.error.message, /jóvá van hagyva/);
  assert.equal((await billingClerk.patch(`/api/billing/entries/${entryIds[0]}`, { qty: 3 })).status, 409);
  assert.equal((await admin.del(`/api/billing/entries/${entryIds[0]}`)).status, 409);
  // October is still open.
  ok(await billingClerk.patch(`/api/billing/entries/${entryIds[4]}`, { qty: 2, note: 'Októberi, javítva' }));
  const list = ok(await sales.get(`/api/billing/entries?period=${PERIOD}&partner_id=101`));
  assert.equal(list.total, 4);
  assert.ok(list.items.every((x) => x.locked));
  assert.equal(list.items.find((x) => x.kind === 'hourly_work' && x.qty === 2.5).amount, 16250);
});

test('entries: validation and the custom item must be a per unit item of the same client', async () => {
  const wrongPartner = await billingClerk.post('/api/billing/entries', { partner_id: 102, date: '2026-10-01', kind: 'custom', custom_item_id: 8001, qty: 1 });
  assert.equal(wrongPartner.status, 400);
  assert.ok(wrongPartner.data.error.fields.custom_item_id);
  const monthly = await billingClerk.post('/api/billing/entries', { partner_id: 101, date: '2026-10-01', kind: 'custom', custom_item_id: 8002, qty: 1 });
  assert.equal(monthly.status, 400);
  const future = await billingClerk.post('/api/billing/entries', { partner_id: 102, date: '2099-01-01', kind: 'hourly_work', qty: 1 });
  assert.equal(future.status, 400);
  const notClient = await billingClerk.post('/api/billing/entries', { partner_id: 201, date: '2026-10-01', kind: 'hourly_work', qty: 1 });
  assert.equal(notClient.status, 400);
  const k = ok(await billingClerk.post('/api/billing/entries', { partner_id: 102, date: '2026-10-01', kind: 'custom', custom_item_id: 8004, qty: 4 }));
  assert.equal((await billingClerk.del(`/api/billing/entries/${k.id}`)).status, 403, 'clerk has no delete right');
  ok(await admin.del(`/api/billing/entries/${k.id}`));
  const items = ok(await sales.get('/api/billing/custom-items?partner_id=101'));
  assert.deepEqual(items.items.map((i) => i.id).sort(), [8001, 8002, 8003]);
});

test('delete a draft (delete right) and rebuild it', async () => {
  assert.equal((await billingClerk.del(`/api/billing/statements/${ids[102]}`)).status, 403);
  ok(await admin.del(`/api/billing/statements/${ids[102]}`));
  assert.equal((await sales.get(`/api/billing/statements/${ids[102]}`)).status, 404);
  const g = ok(await billingClerk.post('/api/billing/statements/generate', { period: PERIOD, partner_ids: [102] }));
  assert.equal(g.created, 1);
  ids[102] = g.statements[0].id;
});

test('void an approved statement; void ones are only rebuilt when selected', async () => {
  const noReason = await admin.post(`/api/billing/statements/${ids[101]}/void`, {});
  assert.equal(noReason.status, 400);
  assert.equal((await billingClerk.post(`/api/billing/statements/${ids[101]}/void`, { reason: 'x' })).status, 403);
  assert.equal((await admin.post(`/api/billing/statements/${ids[102]}/void`, { reason: 'x' })).status, 409, 'drafts are deleted, not voided');
  ok(await admin.post(`/api/billing/statements/${ids[101]}/void`, { reason: 'Hibás tarifa' }));
  const st = ok(await sales.get(`/api/billing/statements/${ids[101]}`));
  assert.equal(st.status, 'void');
  assert.equal(st.void_reason, 'Hibás tarifa');

  const all = ok(await billingClerk.post('/api/billing/statements/generate', { period: PERIOD }));
  assert.ok(all.skipped.some((s) => s.partner_id === 101 && /Érvénytelenítve/.test(s.reason)));
  const one = ok(await billingClerk.post('/api/billing/statements/generate', { period: PERIOD, partner_ids: [101] }));
  assert.equal(one.updated, 1);
  const rebuilt = ok(await sales.get(`/api/billing/statements/${ids[101]}`));
  assert.equal(rebuilt.status, 'draft');
  assert.equal(rebuilt.approved_at, null);
  assert.equal(rebuilt.net, 68064 + 3752);
});

test('invoicing refuses drafts and an unconfigured provider', async () => {
  const draft = await admin.post(`/api/billing/statements/${ids[101]}/invoice`);
  assert.equal(draft.status, 409);
  assert.match(draft.data.error.message, /jóváhagyott/);
  ok(await admin.post(`/api/billing/statements/${ids[101]}/approve`));
  assert.equal((await billingClerk.post(`/api/billing/statements/${ids[101]}/invoice`)).status, 403);
  const none = await admin.post(`/api/billing/statements/${ids[101]}/invoice`);
  assert.equal(none.status, 409);
  assert.match(none.data.error.message, /Még nincs beállítva számlázó/);
});

test('generation validates the period and the selection', async () => {
  assert.equal((await billingClerk.post('/api/billing/statements/generate', { period: '2026-9' })).status, 400);
  assert.equal((await billingClerk.post('/api/billing/statements/generate', { period: '2099-01' })).status, 400);
  assert.equal((await billingClerk.post('/api/billing/statements/generate', { period: PERIOD, partner_ids: [201] })).status, 400, 'suppliers have no statements');
  assert.equal((await billingClerk.post('/api/billing/statements/generate', { period: PERIOD, partner_ids: [] })).status, 400);
  // A month without activity: only the fixed monthly custom item of Kutyabarát is billed.
  const quiet = ok(await billingClerk.post('/api/billing/statements/generate', { period: '2026-07' }));
  assert.equal(quiet.created, 1);
  assert.deepEqual(quiet.skipped.map((s) => s.partner_id), [102]);
  const july = ok(await sales.get(`/api/billing/statements/${quiet.statements[0].id}`));
  assert.deepEqual(july.lines.map((l) => [l.key, l.amount]), [['custom.monthly.8002', 15000]]);
  ok(await admin.del(`/api/billing/statements/${july.id}`));
});

test('CSV exports of a statement and of the overview', async () => {
  const res = await sales.get(`/api/billing/statements/${ids[101]}/export`, { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /EL-\d{4}-\d{5}-KUTYA-2026-09\.csv/);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel');
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.startsWith('Csoport;Tétel;Mennyiség;Egység;Egységár;Ár egysége;Nettó (Ft);ÁFA 27% (Ft);Bruttó (Ft)\r\n'), text.slice(0, 120));
  assert.match(text, /Tárolás;Tárolás, Polchely M \(M\);25;helynap;800;Ft \/ hely \/ hó;667;180;847/);
  assert.match(text, /Extrák;Utánvétkezelés, arányos \(1,5%\);22990;Ft;1,5;%;345;93;438/);
  assert.match(text, /Összesen;;;;;;71816;19391;91207/);
  const ov = await sales.get(`/api/billing/overview/export?period=${PERIOD}`, { raw: true });
  const ovText = await ov.text();
  assert.match(ovText, /KUTYA;Kutyabarát Webshop Kft\.;Jóváhagyva;EL-\d{4}-\d{5};71816;19391;91207;/);
  assert.match(ovText, /KONYHA;Konyhagép Gyártó Zrt\.;Piszkozat;/);
});

test('snapshot now: records today from the current stock (create right)', async () => {
  const r = ok(await billingClerk.post('/api/billing/snapshot'));
  assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
  // Kutyabarát: B-01-01..03, P-01-01, KARANTEN; Konyhagép: A-01-02, A-01-03, C-01-03 (A-01-01 is empty now).
  assert.equal(r.rows, 8);
  const [run] = await srv.query('SELECT source, rows FROM snapshot_runs WHERE date = ?', r.date);
  assert.deepEqual(run, { source: 'manual', rows: 8 });
  const [log] = await srv.query("SELECT actor, summary FROM audit_log WHERE entity = 'snapshot' ORDER BY id DESC LIMIT 1");
  assert.match(log.summary, /Tárolási pillanatkép rögzítve kézzel/);
});

test('audit trail of a statement', async () => {
  const st = ok(await sales.get(`/api/billing/statements/${ids[101]}`));
  const text = st.history.map((h) => h.summary).join('\n');
  assert.match(text, /elkészítve/);
  assert.match(text, /kézi tétel hozzáadva: Raklapfóliázás/);
  assert.match(text, /jóváhagyva/);
  assert.match(text, /érvénytelenítve: Hibás tarifa/);
  assert.match(text, /újrakészítve érvénytelenített elszámolásból/);
});
