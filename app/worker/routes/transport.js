// Fuvarszervezés: carrier pickups and manifests, pallet and truck transports. Prefix /api/transport
//
// Carrier pickups (FA-): a carrier's courier collects packed orders on a date. Packed orders of the
// carrier that are not on a pickup yet are "waiting"; they are assigned to a pickup, and closing the
// manifest ships every assigned order (setOrderStatus) and sends the tracking numbers back to the
// webshops (pushFulfillments, in the background).
//   planned -> arrived (courier at the ramp) -> closed ; planned -> cancelled (orders released)
//
// Transports (FU-): pallet and truck transports (LTL, FTL), inbound or outbound, for a client.
//   requested -> booked -> in_transit -> delivered ; requested, booked, in_transit -> cancelled

import { all, batch, first, getSetting, marks, nextNumber, run, stmt } from '../lib/db.js';
import { badRequest, conflict, download, notFound, page } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { setOrderStatus } from '../lib/orders.js';
import { STATUSES } from '../lib/constants.js';
import { toCsv } from '../lib/csv.js';
import { budapestDate, isDate, nowIso } from '../lib/time.js';
import { pushFulfillments } from '../integrations/webshops/index.js';
import { closeShipments, isConfigured } from '../integrations/couriers/index.js';

const OPEN_PICKUP = ['planned', 'arrived'];
const CHUNK = 90;
const CLOSE_CHUNK = 100; // orders shipped per request (each setOrderStatus is two D1 calls)

const intId = (v, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw notFound(`${what} nem található.`);
  return n;
};
const userId = (ctx) => (ctx.user ? ctx.user.id : null);
const shortList = (items, n = 5) => (items.length > n ? `${items.slice(0, n).join(', ')} és még ${items.length - n}` : items.join(', '));
const windowText = (from, to) => (from || to ? `${from || ''}-${to || ''}` : '');

function checkWindow(from, to, fields = ['window_from', 'window_to']) {
  if (from && to && from > to) throw badRequest('Az időablak vége nem lehet korábban, mint az eleje.', { [fields[1]]: 'Az elejénél későbbi időpontot adj meg.' });
}

async function carrierPartner(db, id, field = 'carrier_id') {
  const c = await first(db, "SELECT id, name, code, status, carrier_code FROM partners WHERE id = ? AND type = 'carrier'", id);
  if (!c) throw badRequest('Ismeretlen fuvarozó.', { [field]: 'Válassz fuvarozót.' });
  return c;
}

// Adds an order's amounts to totals; COD is summed per currency.
function addTotals(t, o) {
  t.orders += o.n ?? 1;
  t.packages += o.packages ?? o.package_count ?? 0;
  t.weight_kg += o.weight ?? o.weight_kg ?? 0;
  const cod = o.cod ?? o.cod_amount ?? 0;
  if (cod) {
    t.cod[o.currency || 'HUF'] = (t.cod[o.currency || 'HUF'] || 0) + cod;
    t.cod_orders += o.cod_orders ?? 1;
  }
  return t;
}
const emptyTotals = () => ({ orders: 0, packages: 0, weight_kg: 0, cod: {}, cod_orders: 0 });

// ---------------------------------------------------------------- pickups

const PICKUP_SQL = `SELECT cp.*, pa.name AS carrier_name, pa.code AS carrier_short, pa.carrier_code,
    cu.name AS closed_by_name, cr.name AS created_by_name
  FROM carrier_pickups cp JOIN partners pa ON pa.id = cp.carrier_id
  LEFT JOIN users cu ON cu.id = cp.closed_by LEFT JOIN users cr ON cr.id = cp.created_by`;

const ORDER_SQL = `SELECT o.id, o.number, o.external_number, o.status, o.partner_id, pa.name AS partner_name, pa.code AS partner_code,
    o.customer_name, o.company, o.country, o.zip, o.city, o.address, o.pickup_point_id, o.carrier_service,
    o.tracking_number, o.package_count, o.weight_kg, o.cod_amount, o.currency, o.packed_at, o.pickup_id
  FROM orders o JOIN partners pa ON pa.id = o.partner_id`;

async function loadPickup(db, id) {
  const p = await first(db, `${PICKUP_SQL} WHERE cp.id = ?`, id);
  if (!p) throw notFound('A futárátvétel nem található.');
  return p;
}

function assertOpen(p) {
  if (!OPEN_PICKUP.includes(p.status)) {
    throw conflict(`A(z) ${p.number} futárátvétel állapota „${STATUSES.pickup[p.status].label}”, már nem módosítható.`);
  }
}

const PICKUP_FIELDS = {
  carrier_id: { type: 'id', required: true },
  date: { type: 'date', required: true },
  window_from: { type: 'time', default: '' },
  window_to: { type: 'time', default: '' },
  note: { type: 'text', max: 1000, default: '' },
};

async function pickupDetail(ctx, id) {
  const db = ctx.env.DB;
  const p = await loadPickup(db, id);
  const orders = await all(db, `${ORDER_SQL} WHERE o.pickup_id = ? ORDER BY o.number`, p.id);
  const totals = orders.reduce(addTotals, emptyTotals());
  const waiting = OPEN_PICKUP.includes(p.status)
    ? await all(db, `${ORDER_SQL} WHERE o.status = 'packed' AND o.pickup_id IS NULL AND o.carrier_id = ? ORDER BY o.packed_at, o.number LIMIT 500`, p.carrier_id)
    : [];
  const company = await getSetting(db, 'company', {});
  return {
    ...p,
    orders,
    totals,
    waiting,
    problems: {
      not_packed: orders.filter((o) => !['packed', 'shipped'].includes(o.status)).map((o) => o.number),
      no_tracking: orders.filter((o) => !o.tracking_number).length,
    },
    company: { name: company.name || 'Fully Logistics', zip: company.zip || '', city: company.city || '', address: company.address || '', phone: company.phone || '' },
  };
}

// Assigns orders (ids) to an open pickup. Every order must be packed, free and of the carrier.
async function assignOrders(ctx, p, ids) {
  const db = ctx.env.DB;
  const rows = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const c = ids.slice(i, i + CHUNK);
    rows.push(...await all(db, `SELECT o.id, o.number, o.status, o.carrier_id, o.pickup_id, cp.number AS pickup_number
      FROM orders o LEFT JOIN carrier_pickups cp ON cp.id = o.pickup_id WHERE o.id IN (${marks(c.length)})`, ...c));
  }
  if (rows.length !== ids.length) throw badRequest('Ismeretlen rendelés a listában.', { order_ids: 'Ismeretlen rendelés.' });
  const problems = [];
  for (const o of rows) {
    if (o.pickup_id === p.id) continue;
    if (o.pickup_id) problems.push(`${o.number}: már a(z) ${o.pickup_number} átvételen van`);
    else if (o.status !== 'packed') problems.push(`${o.number}: ${STATUSES.order[o.status].label}`);
    else if (!o.carrier_id) problems.push(`${o.number}: nincs fuvarozója`);
    else if (o.carrier_id !== p.carrier_id) problems.push(`${o.number}: más fuvarozóval megy`);
  }
  if (problems.length) throw conflict(`Nem rendelhető hozzá: ${shortList(problems, 3)}.`);
  const todo = rows.filter((o) => o.pickup_id !== p.id).map((o) => o.id);
  const at = nowIso();
  let assigned = 0;
  for (let i = 0; i < todo.length; i += CHUNK) {
    const c = todo.slice(i, i + CHUNK);
    const res = await run(db, `UPDATE orders SET pickup_id = ?, updated_at = ? WHERE id IN (${marks(c.length)})
      AND status = 'packed' AND pickup_id IS NULL AND carrier_id = ?`, p.id, at, ...c, p.carrier_id);
    assigned += res.meta.changes;
  }
  return assigned;
}

// ---------------------------------------------------------------- transports

const TRANSPORT_FIELDS = {
  direction: { type: 'enum', values: ['in', 'out'], required: true },
  partner_id: { type: 'id', nullable: true },
  carrier_id: { type: 'id', nullable: true },
  date: { type: 'date', required: true },
  time_from: { type: 'time', default: '' },
  time_to: { type: 'time', default: '' },
  origin: { type: 'str', max: 300, default: '' },
  destination: { type: 'str', max: 300, default: '' },
  pallets: { type: 'int', min: 0, max: 1000, default: 0 },
  weight_kg: { type: 'num', min: 0, max: 1000000, nullable: true },
  vehicle: { type: 'str', max: 120, default: '' },
  price: { type: 'num', min: 0, max: 1000000000, nullable: true },
  carrier_ref: { type: 'str', max: 120, default: '' },
  note: { type: 'text', max: 2000, default: '' },
};
// Forward steps and one step back for corrections. Cancelling is the delete action.
const TRANSPORT_FLOW = {
  requested: ['booked'],
  booked: ['in_transit', 'requested'],
  in_transit: ['delivered', 'booked'],
  delivered: [],
  cancelled: [],
};

const TRANSPORT_SQL = `SELECT t.*, cl.name AS partner_name, cl.code AS partner_code, ca.name AS carrier_name, ca.code AS carrier_short,
    u.name AS created_by_name
  FROM transports t LEFT JOIN partners cl ON cl.id = t.partner_id LEFT JOIN partners ca ON ca.id = t.carrier_id
  LEFT JOIN users u ON u.id = t.created_by`;

async function loadTransport(db, id) {
  const t = await first(db, `${TRANSPORT_SQL} WHERE t.id = ?`, id);
  if (!t) throw notFound('A fuvar nem található.');
  return t;
}

async function checkTransportRefs(db, d) {
  if (d.partner_id) {
    const c = await first(db, "SELECT id FROM partners WHERE id = ? AND type = 'client'", d.partner_id);
    if (!c) throw badRequest('Ismeretlen ügyfél.', { partner_id: 'Válassz ügyfelet.' });
  }
  if (d.carrier_id) await carrierPartner(db, d.carrier_id);
}

const transportLabel = (t) => `${t.number} (${t.direction === 'in' ? 'beérkező' : 'kimenő'}, ${t.date})`;

// ---------------------------------------------------------------- routes

export function register(r) {
  // Day board: per carrier the waiting packed orders and the pickups of the date.
  r.get('/api/transport/board', async (ctx) => {
    const db = ctx.env.DB;
    const today = budapestDate();
    const date = ctx.query.get('date') || today;
    if (!isDate(date)) throw badRequest('Hibás dátum.', { date: 'ÉÉÉÉ-HH-NN formában add meg.' });
    const carriers = await all(db, "SELECT id, code, name, status, carrier_code FROM partners WHERE type = 'carrier' ORDER BY name");
    const waiting = await all(db,
      `SELECT carrier_id, currency, COUNT(*) AS n, SUM(cod_amount) AS cod, SUM(CASE WHEN cod_amount > 0 THEN 1 ELSE 0 END) AS cod_orders,
              SUM(package_count) AS packages, COALESCE(SUM(weight_kg), 0) AS weight
       FROM orders WHERE status = 'packed' AND pickup_id IS NULL GROUP BY carrier_id, currency`);
    const pickups = await all(db,
      `SELECT id, number, carrier_id, date, window_from, window_to, status, manifest_number, arrived_at, closed_at, note
       FROM carrier_pickups WHERE date = ? AND status <> 'cancelled' ORDER BY window_from, number`, date);
    const assigned = await all(db,
      `SELECT o.pickup_id, o.currency, COUNT(*) AS n, SUM(o.cod_amount) AS cod, SUM(CASE WHEN o.cod_amount > 0 THEN 1 ELSE 0 END) AS cod_orders,
              SUM(o.package_count) AS packages, COALESCE(SUM(o.weight_kg), 0) AS weight
       FROM orders o JOIN carrier_pickups cp ON cp.id = o.pickup_id WHERE cp.date = ? AND cp.status <> 'cancelled'
       GROUP BY o.pickup_id, o.currency`, date);

    const byCarrier = new Map(carriers.map((c) => [c.id, { ...c, waiting: emptyTotals(), assigned: emptyTotals(), pickups: [] }]));
    const noCarrier = emptyTotals();
    for (const w of waiting) {
      const c = byCarrier.get(w.carrier_id);
      addTotals(c ? c.waiting : noCarrier, w);
    }
    const byPickup = new Map();
    for (const p of pickups) {
      const item = { ...p, totals: emptyTotals() };
      byPickup.set(p.id, item);
      const c = byCarrier.get(p.carrier_id);
      if (c) c.pickups.push(item);
    }
    for (const a of assigned) {
      const p = byPickup.get(a.pickup_id);
      if (!p) continue;
      addTotals(p.totals, a);
      addTotals(byCarrier.get(p.carrier_id).assigned, a);
    }
    const list = [...byCarrier.values()]
      .filter((c) => c.status === 'active' || c.waiting.orders || c.pickups.length)
      .sort((a, b) => Number(!!(b.waiting.orders || b.pickups.length)) - Number(!!(a.waiting.orders || a.pickups.length)) || a.name.localeCompare(b.name, 'hu'));
    const totals = { waiting: emptyTotals(), assigned: emptyTotals(), pickups: pickups.length };
    for (const c of list) {
      for (const k of ['waiting', 'assigned']) {
        totals[k].orders += c[k].orders;
        totals[k].packages += c[k].packages;
        totals[k].weight_kg += c[k].weight_kg;
        totals[k].cod_orders += c[k].cod_orders;
        for (const [cur, v] of Object.entries(c[k].cod)) totals[k].cod[cur] = (totals[k].cod[cur] || 0) + v;
      }
    }
    return { date, today, carriers: list, no_carrier: noCarrier, totals };
  }, { perm: ['transport', 'view'] });

  r.get('/api/transport/pickups', async (ctx) => {
    const db = ctx.env.DB;
    const { limit, offset } = page(ctx.query);
    const where = [];
    const args = [];
    const from = ctx.query.get('from');
    const to = ctx.query.get('to');
    const status = ctx.query.get('status');
    const carrier = Number(ctx.query.get('carrier_id')) || null;
    if (from && isDate(from)) { where.push('cp.date >= ?'); args.push(from); }
    if (to && isDate(to)) { where.push('cp.date <= ?'); args.push(to); }
    if (status && STATUSES.pickup[status]) { where.push('cp.status = ?'); args.push(status); }
    if (carrier) { where.push('cp.carrier_id = ?'); args.push(carrier); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await first(db, `SELECT COUNT(*) AS n FROM carrier_pickups cp ${w}`, ...args)).n;
    const items = await all(db,
      `SELECT cp.id, cp.number, cp.carrier_id, cp.date, cp.window_from, cp.window_to, cp.status, cp.manifest_number, cp.closed_at,
              pa.name AS carrier_name, pa.carrier_code, (SELECT COUNT(*) FROM orders o WHERE o.pickup_id = cp.id) AS orders
       FROM carrier_pickups cp JOIN partners pa ON pa.id = cp.carrier_id ${w}
       ORDER BY cp.date DESC, cp.window_from DESC, cp.id DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
    return { items, total };
  }, { perm: ['transport', 'view'] });

  r.post('/api/transport/pickups', async (ctx) => {
    const db = ctx.env.DB;
    const d = validate(await ctx.body(), PICKUP_FIELDS);
    const carrier = await carrierPartner(db, d.carrier_id);
    if (carrier.status !== 'active') throw badRequest('A fuvarozó inaktív.', { carrier_id: 'Inaktív fuvarozó.' });
    if (d.date < budapestDate()) throw badRequest('Múltbeli napra nem vehetsz fel futárátvételt.', { date: 'Mai vagy későbbi napot adj meg.' });
    checkWindow(d.window_from, d.window_to);
    const number = await nextNumber(db, 'FA');
    const at = nowIso();
    const res = await run(db,
      `INSERT INTO carrier_pickups (number, carrier_id, date, window_from, window_to, status, note, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?)`,
      number, carrier.id, d.date, d.window_from, d.window_to, d.note, userId(ctx), at, at);
    const id = res.meta.last_row_id;
    await audit(ctx, { module: 'transport', action: 'create', entity: 'pickup', entityId: id, summary: `${number} futárátvétel felvéve (${carrier.name}, ${d.date} ${windowText(d.window_from, d.window_to)})`.trim() });
    return { id, number };
  }, { perm: ['transport', 'create'] });

  r.get('/api/transport/pickups/:id', (ctx) => pickupDetail(ctx, intId(ctx.params.id, 'A futárátvétel')), { perm: ['transport', 'view'] });

  r.patch('/api/transport/pickups/:id', async (ctx) => {
    const db = ctx.env.DB;
    const p = await loadPickup(db, intId(ctx.params.id, 'A futárátvétel'));
    assertOpen(p);
    const d = validate(await ctx.body(), {
      date: PICKUP_FIELDS.date, window_from: PICKUP_FIELDS.window_from, window_to: PICKUP_FIELDS.window_to, note: PICKUP_FIELDS.note,
    }, { partial: true });
    if (d.date === null) throw badRequest('Ellenőrizd a megjelölt mezőket.', { date: 'Kötelező mező.' });
    if (d.date && d.date !== p.date && d.date < budapestDate()) throw badRequest('Múltbeli napra nem teheted át az átvételt.', { date: 'Mai vagy későbbi napot adj meg.' });
    checkWindow(d.window_from ?? p.window_from, d.window_to ?? p.window_to);
    const keys = Object.keys(d);
    if (!keys.length) return pickupDetail(ctx, p.id);
    await run(db, `UPDATE carrier_pickups SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => d[k]), nowIso(), p.id);
    await audit(ctx, { module: 'transport', action: 'edit', entity: 'pickup', entityId: p.id, summary: `${p.number} futárátvétel módosítva`, details: d });
    return pickupDetail(ctx, p.id);
  }, { perm: ['transport', 'edit'] });

  // Assign orders: { order_ids: [...] } or { all: true } for every waiting packed order of the carrier.
  r.post('/api/transport/pickups/:id/orders', async (ctx) => {
    const db = ctx.env.DB;
    const p = await loadPickup(db, intId(ctx.params.id, 'A futárátvétel'));
    assertOpen(p);
    const body = await ctx.body();
    let assigned;
    if (body.all === true) {
      const res = await run(db, `UPDATE orders SET pickup_id = ?, updated_at = ? WHERE status = 'packed' AND pickup_id IS NULL AND carrier_id = ?`,
        p.id, nowIso(), p.carrier_id);
      assigned = res.meta.changes;
      if (!assigned) throw conflict(`Nincs ${p.carrier_name} fuvarozóra váró, feladásra kész rendelés.`);
    } else {
      const ids = [...new Set((Array.isArray(body.order_ids) ? body.order_ids : []).map(Number))];
      if (!ids.length || ids.some((n) => !Number.isInteger(n) || n < 1)) throw badRequest('Válassz ki legalább egy rendelést.', { order_ids: 'Válassz rendelést.' });
      if (ids.length > 2000) throw badRequest('Egyszerre legfeljebb 2000 rendelés rendelhető hozzá.');
      assigned = await assignOrders(ctx, p, ids);
    }
    await audit(ctx, { module: 'transport', action: 'edit', entity: 'pickup', entityId: p.id, summary: `${p.number}: ${assigned} rendelés hozzárendelve` });
    return { assigned, pickup: await pickupDetail(ctx, p.id) };
  }, { perm: ['transport', 'edit'] });

  // Scanning a parcel at the ramp: tracking number, order number or webshop order number.
  r.post('/api/transport/pickups/:id/scan', async (ctx) => {
    const db = ctx.env.DB;
    const p = await loadPickup(db, intId(ctx.params.id, 'A futárátvétel'));
    assertOpen(p);
    const { code } = validate(await ctx.body(), { code: { type: 'str', required: true, max: 120 } });
    const hits = await all(db,
      `SELECT o.id, o.number, o.status, o.carrier_id, o.pickup_id, cp.number AS pickup_number, pa.name AS carrier_name
       FROM orders o LEFT JOIN carrier_pickups cp ON cp.id = o.pickup_id LEFT JOIN partners pa ON pa.id = o.carrier_id
       WHERE (o.tracking_number = ? COLLATE NOCASE AND o.tracking_number <> '') OR o.number = ? COLLATE NOCASE
          OR (o.external_number = ? COLLATE NOCASE AND o.external_number <> '')
       ORDER BY CASE WHEN o.pickup_id = ? THEN 0 WHEN o.status = 'packed' AND o.carrier_id = ? AND o.pickup_id IS NULL THEN 1 ELSE 2 END, o.id DESC
       LIMIT 5`, code, code, code, p.id, p.carrier_id);
    if (!hits.length) throw notFound(`Nincs ilyen rendelés vagy nyomkövetési szám: ${code}`);
    const o = hits[0];
    if (o.pickup_id === p.id) return { order: o, already: true, message: `${o.number} már a manifeszten van.`, pickup: await pickupDetail(ctx, p.id) };
    if (o.pickup_id) throw conflict(`A(z) ${o.number} rendelés már a(z) ${o.pickup_number} átvételhez tartozik.`);
    if (o.status !== 'packed') throw conflict(`A(z) ${o.number} rendelés állapota: ${STATUSES.order[o.status].label}. Csak feladásra kész rendelés adható át.`);
    if (o.carrier_id !== p.carrier_id) throw conflict(`A(z) ${o.number} rendelés fuvarozója ${o.carrier_name || 'nincs megadva'}, nem ${p.carrier_name}.`);
    await assignOrders(ctx, p, [o.id]);
    await audit(ctx, { module: 'transport', action: 'edit', entity: 'pickup', entityId: p.id, summary: `${p.number}: ${o.number} beolvasva és hozzárendelve` });
    return { order: o, already: false, message: `${o.number} hozzáadva.`, pickup: await pickupDetail(ctx, p.id) };
  }, { perm: ['transport', 'edit'] });

  r.delete('/api/transport/pickups/:id/orders/:orderId', async (ctx) => {
    const db = ctx.env.DB;
    const p = await loadPickup(db, intId(ctx.params.id, 'A futárátvétel'));
    assertOpen(p);
    const orderId = intId(ctx.params.orderId, 'A rendelés');
    const o = await first(db, 'SELECT id, number, status FROM orders WHERE id = ? AND pickup_id = ?', orderId, p.id);
    if (!o) throw notFound('A rendelés nincs ezen a futárátvételen.');
    if (o.status === 'shipped') throw conflict(`A(z) ${o.number} rendelés már feladva, nem vehető le a manifesztről.`);
    await run(db, "UPDATE orders SET pickup_id = NULL, updated_at = ? WHERE id = ? AND pickup_id = ? AND status <> 'shipped'", nowIso(), o.id, p.id);
    await audit(ctx, { module: 'transport', action: 'edit', entity: 'pickup', entityId: p.id, summary: `${p.number}: ${o.number} levéve a manifesztről` });
    return pickupDetail(ctx, p.id);
  }, { perm: ['transport', 'edit'] });

  r.post('/api/transport/pickups/:id/arrived', async (ctx) => {
    const db = ctx.env.DB;
    const p = await loadPickup(db, intId(ctx.params.id, 'A futárátvétel'));
    if (p.status !== 'planned') assertOpen(p);
    if (p.status === 'arrived') return pickupDetail(ctx, p.id);
    const at = nowIso();
    await run(db, "UPDATE carrier_pickups SET status = 'arrived', arrived_at = ?, updated_at = ? WHERE id = ? AND status = 'planned'", at, at, p.id);
    await audit(ctx, { module: 'transport', action: 'edit', entity: 'pickup', entityId: p.id, summary: `${p.number}: a futár megérkezett (${p.carrier_name})` });
    return pickupDetail(ctx, p.id);
  }, { perm: ['transport', 'edit'] });

  // Close the manifest: every assigned order is shipped. Large manifests are shipped in parts: the
  // answer is { done: false, remaining } and the client calls again with the same body.
  r.post('/api/transport/pickups/:id/close', async (ctx) => {
    const db = ctx.env.DB;
    const p = await loadPickup(db, intId(ctx.params.id, 'A futárátvétel'));
    assertOpen(p);
    const d = validate(await ctx.body(), { manifest_number: { type: 'str', max: 120, default: '' } });
    const orders = await all(db, 'SELECT id, number, status FROM orders WHERE pickup_id = ? ORDER BY id', p.id);
    if (!orders.length) throw conflict('Üres manifeszt nem zárható le. Előbb rendelj hozzá rendeléseket.');
    const bad = orders.filter((o) => !['packed', 'shipped'].includes(o.status));
    if (bad.length) {
      throw conflict(`Ezek a rendelések nem feladásra kész állapotúak: ${shortList(bad.map((o) => `${o.number} (${STATUSES.order[o.status].label})`), 3)}. Vedd le őket a manifesztről.`);
    }
    // Carriers with a mandatory daily closing (MPL "zárás"): close the parcels with the carrier
    // first, while nothing is shipped yet, so a failure leaves the manifest open to retry.
    if (orders.every((o) => o.status === 'packed') && p.carrier_code && await isConfigured(ctx.env, p.carrier_code)) {
      const tracked = await all(db, "SELECT tracking_number FROM orders WHERE pickup_id = ? AND tracking_number <> ''", p.id);
      const closing = await closeShipments(ctx, p.carrier_code, { trackingNumbers: tracked.map((t) => t.tracking_number) });
      if (closing.required && closing.documentIds.length) {
        await run(db, 'UPDATE carrier_pickups SET manifest_document_id = ?, updated_at = ? WHERE id = ?', closing.documentIds[0], nowIso(), p.id);
      }
    }
    const manifest = d.manifest_number || p.manifest_number || p.number;
    if (manifest !== p.manifest_number) await run(db, 'UPDATE carrier_pickups SET manifest_number = ?, updated_at = ? WHERE id = ?', manifest, nowIso(), p.id);
    const todo = orders.filter((o) => o.status === 'packed');
    const now = todo.slice(0, CLOSE_CHUNK);
    const text = `Feladva: ${p.number} futárátvétel (${p.carrier_name}), manifeszt: ${manifest}`;
    for (const o of now) await setOrderStatus(ctx, o.id, 'shipped', text);
    if (todo.length > now.length) return { done: false, shipped: now.length, remaining: todo.length - now.length, manifest_number: manifest };

    const at = nowIso();
    const res = await run(db, `UPDATE carrier_pickups SET status = 'closed', closed_by = ?, closed_at = ?, updated_at = ?
                               WHERE id = ? AND status IN ('planned', 'arrived')`, userId(ctx), at, at, p.id);
    if (res.meta.changes !== 1) throw conflict('A futárátvétel állapota közben megváltozott. Töltsd újra az oldalt.');
    await audit(ctx, {
      module: 'transport', action: 'approve', entity: 'pickup', entityId: p.id,
      summary: `${p.number} manifeszt lezárva (${p.carrier_name}, ${manifest}): ${orders.length} rendelés feladva`,
    });
    const ids = orders.map((o) => o.id);
    ctx.waitUntil(Promise.resolve().then(() => pushFulfillments(ctx.env, ids)).catch((err) => {
      console.error(`pushFulfillments failed for ${p.number}`, err && err.stack ? err.stack : err);
    }));
    return { done: true, shipped: orders.length, manifest_number: manifest };
  }, { perm: ['transport', 'approve'] });

  // Cancel (transport delete): only a planned pickup; its orders wait for the carrier again.
  r.delete('/api/transport/pickups/:id', async (ctx) => {
    const db = ctx.env.DB;
    const p = await loadPickup(db, intId(ctx.params.id, 'A futárátvétel'));
    if (p.status !== 'planned') throw conflict(`Csak tervezett futárátvétel törölhető, ez „${STATUSES.pickup[p.status].label}”.`);
    const at = nowIso();
    const res = await batch(db, [
      stmt(db, "UPDATE carrier_pickups SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ? AND status = 'planned'", at, at, p.id),
      stmt(db, "UPDATE orders SET pickup_id = NULL, updated_at = ? WHERE pickup_id = ? AND status <> 'shipped'", at, p.id),
    ]);
    if (res[0].meta.changes !== 1) throw conflict('A futárátvétel állapota közben megváltozott. Töltsd újra az oldalt.');
    await audit(ctx, { module: 'transport', action: 'delete', entity: 'pickup', entityId: p.id, summary: `${p.number} futárátvétel törölve, ${res[1].meta.changes} rendelés felszabadítva` });
    return { ok: true, released: res[1].meta.changes };
  }, { perm: ['transport', 'delete'] });

  r.get('/api/transport/pickups/:id/manifest.csv', async (ctx) => {
    const p = await pickupDetail(ctx, intId(ctx.params.id, 'A futárátvétel'));
    const csv = toCsv([
      { key: 'number', label: 'Rendelésszám' },
      { key: 'external_number', label: 'Webshop rendelésszám' },
      { key: 'partner_name', label: 'Ügyfél' },
      { key: 'customer_name', label: 'Címzett' },
      { key: 'company', label: 'Cég' },
      { key: 'country', label: 'Ország' },
      { key: 'zip', label: 'Irányítószám' },
      { key: 'city', label: 'Település' },
      { key: 'address', label: 'Cím' },
      { key: 'pickup_point_id', label: 'Átvételi pont' },
      { key: 'tracking_number', label: 'Nyomkövetési szám' },
      { key: 'package_count', label: 'Csomagok' },
      { label: 'Súly (kg)', value: (o) => (o.weight_kg == null ? '' : String(o.weight_kg).replace('.', ',')) },
      { label: 'Utánvét', value: (o) => (o.cod_amount ? String(o.cod_amount).replace('.', ',') : '0') },
      { key: 'currency', label: 'Pénznem' },
    ], p.orders);
    return download(csv, `manifeszt-${p.number}.csv`, 'text/csv; charset=utf-8');
  }, { perm: ['transport', 'view'] });

  // ---------------------------------------------------------------- transports
  r.get('/api/transport/transports', async (ctx) => {
    const db = ctx.env.DB;
    const { limit, offset } = page(ctx.query);
    const status = ctx.query.get('status') || 'active';
    const direction = ctx.query.get('direction');
    const partner = Number(ctx.query.get('partner_id')) || null;
    const carrier = Number(ctx.query.get('carrier_id')) || null;
    const from = ctx.query.get('from');
    const to = ctx.query.get('to');
    const q = (ctx.query.get('q') || '').trim();
    const where = [];
    const args = [];
    if (status === 'active') where.push("t.status IN ('requested', 'booked', 'in_transit')");
    else if (STATUSES.transport[status]) { where.push('t.status = ?'); args.push(status); }
    if (direction === 'in' || direction === 'out') { where.push('t.direction = ?'); args.push(direction); }
    if (partner) { where.push('t.partner_id = ?'); args.push(partner); }
    if (carrier) { where.push('t.carrier_id = ?'); args.push(carrier); }
    if (from && isDate(from)) { where.push('t.date >= ?'); args.push(from); }
    if (to && isDate(to)) { where.push('t.date <= ?'); args.push(to); }
    if (q) {
      where.push('(t.number LIKE ? OR t.origin LIKE ? OR t.destination LIKE ? OR t.carrier_ref LIKE ? OR t.vehicle LIKE ? OR t.note LIKE ?)');
      args.push(...Array(6).fill(`%${q}%`));
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = status === 'active' ? 'ORDER BY t.date, t.time_from, t.id' : 'ORDER BY t.date DESC, t.time_from DESC, t.id DESC';
    const total = (await first(db, `SELECT COUNT(*) AS n FROM transports t ${w}`, ...args)).n;
    const items = await all(db, `${TRANSPORT_SQL} ${w} ${order} LIMIT ? OFFSET ?`, ...args, limit, offset);
    return { items, total };
  }, { perm: ['transport', 'view'] });

  r.get('/api/transport/transports/:id', (ctx) => loadTransport(ctx.env.DB, intId(ctx.params.id, 'A fuvar')), { perm: ['transport', 'view'] });

  r.post('/api/transport/transports', async (ctx) => {
    const db = ctx.env.DB;
    const body = await ctx.body();
    const d = validate(body, { ...TRANSPORT_FIELDS, status: { type: 'enum', values: ['requested', 'booked'], default: 'requested' } });
    await checkTransportRefs(db, d);
    checkWindow(d.time_from, d.time_to, ['time_from', 'time_to']);
    if (d.status === 'booked' && !d.carrier_id) throw badRequest('Lefoglalt fuvarhoz add meg a fuvarozót.', { carrier_id: 'Kötelező a foglaláshoz.' });
    const number = await nextNumber(db, 'FU');
    const at = nowIso();
    const res = await run(db,
      `INSERT INTO transports (number, direction, partner_id, carrier_id, date, time_from, time_to, origin, destination, pallets, weight_kg,
         vehicle, price, carrier_ref, status, note, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      number, d.direction, d.partner_id || null, d.carrier_id || null, d.date, d.time_from, d.time_to, d.origin, d.destination,
      d.pallets ?? 0, d.weight_kg ?? null, d.vehicle, d.price ?? null, d.carrier_ref, d.status, d.note, userId(ctx), at, at);
    const id = res.meta.last_row_id;
    await audit(ctx, { module: 'transport', action: 'create', entity: 'transport', entityId: id, summary: `${transportLabel({ number, ...d })} felvéve` });
    return loadTransport(db, id);
  }, { perm: ['transport', 'create'] });

  r.patch('/api/transport/transports/:id', async (ctx) => {
    const db = ctx.env.DB;
    const t = await loadTransport(db, intId(ctx.params.id, 'A fuvar'));
    if (t.status === 'cancelled') throw conflict(`A(z) ${t.number} fuvar törölve van, nem módosítható.`);
    const d = validate(await ctx.body(), TRANSPORT_FIELDS, { partial: true });
    if (d.date === null) throw badRequest('Ellenőrizd a megjelölt mezőket.', { date: 'Kötelező mező.' });
    if (d.pallets === null) d.pallets = 0;
    await checkTransportRefs(db, d);
    checkWindow(d.time_from ?? t.time_from, d.time_to ?? t.time_to, ['time_from', 'time_to']);
    if ('carrier_id' in d && !d.carrier_id && t.status !== 'requested') {
      throw badRequest('Lefoglalt fuvarnál a fuvarozó nem hagyható üresen.', { carrier_id: 'Kötelező mező.' });
    }
    const keys = Object.keys(d);
    if (!keys.length) return t;
    await run(db, `UPDATE transports SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => d[k]), nowIso(), t.id);
    await audit(ctx, { module: 'transport', action: 'edit', entity: 'transport', entityId: t.id, summary: `${t.number} fuvar módosítva`, details: d });
    return loadTransport(db, t.id);
  }, { perm: ['transport', 'edit'] });

  r.post('/api/transport/transports/:id/status', async (ctx) => {
    const db = ctx.env.DB;
    const t = await loadTransport(db, intId(ctx.params.id, 'A fuvar'));
    const { status } = validate(await ctx.body(), { status: { type: 'enum', values: Object.keys(TRANSPORT_FLOW), required: true } });
    if (status === t.status) return t;
    if (status === 'cancelled') throw badRequest('A fuvar törléséhez használd a Törlés gombot.');
    if (!TRANSPORT_FLOW[t.status].includes(status)) {
      throw conflict(`A(z) ${t.number} fuvar nem tehető át „${STATUSES.transport[t.status].label}” állapotból „${STATUSES.transport[status].label}” állapotba.`);
    }
    if (['booked', 'in_transit', 'delivered'].includes(status) && !t.carrier_id) {
      throw badRequest('Előbb add meg a fuvarozót.', { carrier_id: 'Kötelező a foglaláshoz.' });
    }
    const res = await run(db, 'UPDATE transports SET status = ?, updated_at = ? WHERE id = ? AND status = ?', status, nowIso(), t.id, t.status);
    if (res.meta.changes !== 1) throw conflict('A fuvar állapota közben megváltozott. Töltsd újra az oldalt.');
    await audit(ctx, {
      module: 'transport', action: 'edit', entity: 'transport', entityId: t.id,
      summary: `${t.number}: ${STATUSES.transport[t.status].label} -> ${STATUSES.transport[status].label}`,
    });
    return loadTransport(db, t.id);
  }, { perm: ['transport', 'edit'] });

  // Cancel (transport delete). The record stays for history.
  r.delete('/api/transport/transports/:id', async (ctx) => {
    const db = ctx.env.DB;
    const t = await loadTransport(db, intId(ctx.params.id, 'A fuvar'));
    if (t.status === 'cancelled') return { ok: true };
    if (t.status === 'delivered') throw conflict(`A(z) ${t.number} fuvar már leszállítva, nem törölhető.`);
    const at = nowIso();
    const res = await run(db, "UPDATE transports SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ? AND status = ?", at, at, t.id, t.status);
    if (res.meta.changes !== 1) throw conflict('A fuvar állapota közben megváltozott. Töltsd újra az oldalt.');
    await audit(ctx, { module: 'transport', action: 'delete', entity: 'transport', entityId: t.id, summary: `${transportLabel(t)} törölve` });
    return { ok: true };
  }, { perm: ['transport', 'delete'] });
}
