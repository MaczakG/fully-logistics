// A realistic billing month (2026-09, 30 days) on top of the shared fixture, used by the billing
// and invoicing tests. Expected amounts are worked out by hand in billing.test.mjs.
//
// Kutyabarát (101): own tariffs (order_base 650, item_2 90, cod_fixed 120, cod_pct 1.5%, hourly 6500,
// 10% handling and 5% storage discount, M 800 Ft, PAL 15 000 Ft), the rest from the defaults.
//   orders shipped in September: 1, 2, 3, 5 and 4 pieces, three with COD (10 000, 5 990, 7 000)
//   plus orders outside the month or cancelled that must not count
//   inbound movements 40 + 25 pieces, two returns, snapshots: M location 25 days, three L
//   locations 30 days, a pallet place and the quarantine (PAL) 10 days, goods in the receiving
//   zone (not billed); custom items: Címkézés 25 Ft/db (per unit), ügyfélmenedzser 15 000 Ft/hó
// Konyhagép (102): default tariffs, one order of 1 piece, 12 pieces inbound, two M and one XL
//   location all month.

export const PERIOD = '2026-09';

export const MONTH_SQL = `
INSERT INTO partner_tariffs (partner_id, key, value) VALUES
 (101, 'order_base', 650), (101, 'item_2', 90), (101, 'cod_fixed', 120), (101, 'cod_pct', 1.5), (101, 'hourly_work', 6500),
 (101, 'discount_handling_pct', 10), (101, 'discount_storage_pct', 5);
INSERT INTO partner_storage_prices (partner_id, size_id, price) VALUES (101, 1, 800), (101, 4, 15000);
INSERT INTO partner_custom_items (id, partner_id, name, unit, price, kind, active) VALUES
 (8001, 101, 'Címkézés', 'db', 25, 'per_unit', 1),
 (8002, 101, 'Dedikált ügyfélmenedzser', 'hó', 15000, 'monthly', 1),
 (8003, 101, 'Régi havidíj', 'hó', 5000, 'monthly', 0),
 (8004, 102, 'Szettképzés', 'szett', 120, 'per_unit', 1);
INSERT INTO orders (id, number, external_id, partner_id, status, customer_name, cod_amount, currency, shipped_date) VALUES
 (5001, 'R-2026-905001', 'T-5001', 101, 'shipped', 'Vevő Egy', 0, 'HUF', '2026-09-02'),
 (5002, 'R-2026-905002', 'T-5002', 101, 'delivered', 'Vevő Kettő', 10000, 'HUF', '2026-09-05'),
 (5003, 'R-2026-905003', 'T-5003', 101, 'returned', 'Vevő Három', 5990, 'HUF', '2026-09-11'),
 (5004, 'R-2026-905004', 'T-5004', 101, 'shipped', 'Vevő Négy', 0, 'HUF', '2026-09-30'),
 (5005, 'R-2026-905005', 'T-5005', 101, 'shipped', 'Vevő Öt', 7000, 'HUF', '2026-09-15'),
 (5006, 'R-2026-905006', 'T-5006', 101, 'shipped', 'Vevő Hat', 3000, 'HUF', '2026-10-01'),
 (5007, 'R-2026-905007', 'T-5007', 101, 'delivered', 'Vevő Hét', 0, 'HUF', '2026-08-31'),
 (5008, 'R-2026-905008', 'T-5008', 101, 'cancelled', 'Vevő Nyolc', 0, 'HUF', '2026-09-12'),
 (5009, 'R-2026-905009', 'T-5009', 102, 'shipped', 'Vevő Kilenc', 0, 'HUF', '2026-09-20');
INSERT INTO order_lines (order_id, product_id, qty) VALUES
 (5001, 1001, 1), (5002, 1002, 2), (5003, 1001, 1), (5003, 1003, 2), (5004, 1003, 5),
 (5005, 1001, 1), (5005, 1002, 1), (5005, 1003, 2), (5006, 1001, 1), (5007, 1001, 3), (5008, 1001, 2), (5009, 1101, 1);
INSERT INTO movements (date, type, partner_id, product_id, location_id, qty, ref_type) VALUES
 ('2026-09-03', 'inbound', 101, 1001, 18, 40, 'inbound'),
 ('2026-09-20', 'inbound', 101, 1002, 20, 25, 'inbound'),
 ('2026-10-02', 'inbound', 101, 1003, 10, 10, 'inbound'),
 ('2026-09-21', 'pick', 101, 1001, 18, -5, 'wave'),
 ('2026-09-08', 'inbound', 102, 1101, 26, 12, 'inbound');
INSERT INTO returns (id, number, partner_id, order_id, received_date, reason) VALUES
 (7001, 'VR-2026-90001', 101, 5003, '2026-09-14', 'Nem kellett'),
 (7002, 'VR-2026-90002', 101, NULL, '2026-09-25', 'Sérült csomag'),
 (7003, 'VR-2026-90003', 101, NULL, '2026-08-30', 'Augusztusi');
INSERT INTO return_lines (return_id, product_id, qty) VALUES (7001, 1003, 2), (7002, 1001, 1);
`;

const day = (n) => `${PERIOD}-${String(n).padStart(2, '0')}`;

// Records the September snapshots with stock changes on day 21 and day 26.
export async function seedMonth(srv) {
  await srv.sql(MONTH_SQL);
  const ok = (r) => { if (!r.ok) throw new Error(JSON.stringify(r)); return r.result; };
  for (let d = 1; d <= 20; d++) ok(await srv.call('snapshot.takeDailySnapshot', [day(d)]));
  ok(await srv.call('stock.addStock', [{ productId: 1001, locationId: 28, qty: 5, type: 'inbound' }], { as: 1 }));
  ok(await srv.call('stock.addStock', [{ productId: 1002, locationId: 3, qty: 2, type: 'return' }], { as: 1 }));
  ok(await srv.call('stock.addStock', [{ productId: 1003, locationId: 1, qty: 3, type: 'inbound' }], { as: 1 }));
  for (let d = 21; d <= 25; d++) ok(await srv.call('snapshot.takeDailySnapshot', [day(d)]));
  ok(await srv.call('stock.removeStock', [{ productId: 1003, locationId: 10, qty: 300, type: 'adjust' }], { as: 1 }));
  for (let d = 26; d <= 30; d++) ok(await srv.call('snapshot.takeDailySnapshot', [day(d)]));
}

// Hourly work and per unit custom items, recorded through the API.
export async function seedEntries(client) {
  const entries = [
    { partner_id: 101, date: '2026-09-12', kind: 'hourly_work', qty: 2.5, note: 'Szettképzés' },
    { partner_id: 101, date: '2026-09-28', kind: 'hourly_work', qty: 1.5, note: 'Átcímkézés' },
    { partner_id: 101, date: '2026-09-05', kind: 'custom', custom_item_id: 8001, qty: 120 },
    { partner_id: 101, date: '2026-09-18', kind: 'custom', custom_item_id: 8001, qty: 80 },
    { partner_id: 101, date: '2026-10-02', kind: 'hourly_work', qty: 1, note: 'Októberi' },
  ];
  const ids = [];
  for (const e of entries) {
    const r = await client.post('/api/billing/entries', e);
    if (r.status !== 200) throw new Error(JSON.stringify(r.data));
    ids.push(r.data.id);
  }
  return ids;
}

// Role with billing view, create and edit only (no delete, no approve).
export async function clerk(srv) {
  await srv.sql(`INSERT OR IGNORE INTO roles (key, name) VALUES ('billing_clerk', 'Elszámoló');
    INSERT OR IGNORE INTO role_permissions (role_id, module, action) SELECT r.id, 'billing', a.value FROM roles r, json_each('["view","create","edit"]') a WHERE r.key = 'billing_clerk'`);
  return srv.userWithRole('billing_clerk');
}
