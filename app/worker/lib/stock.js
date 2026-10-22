// Stock changes. Every module that moves goods goes through these functions, so that
//  - stock never goes negative (guarded UPDATE, checked after the batch),
//  - every change writes a movements row (the ledger used by stock history and billing),
//  - a location only ever holds goods of one partner (assertCanStore).
//
// Each function runs as one D1 batch, which is a single transaction: either every statement
// applies or none does. Statements after a guarded UPDATE use "WHERE changes() > 0", so if the
// guard fails (not enough stock) nothing else in the batch happens either.

import { all, batch, first, marks, stmt } from './db.js';
import { conflict, badRequest } from './http.js';
import { budapestDate, nowIso } from './time.js';

// Location kinds that may hold stock at all, and those that picking may take from.
const STORABLE = new Set(['storage', 'receiving', 'returns', 'quarantine', 'packing']);
const PICKABLE = ['storage'];

async function product(db, productId) {
  const p = await first(db, 'SELECT id, partner_id, sku, name, active FROM products WHERE id = ?', productId);
  if (!p) throw badRequest('Ismeretlen termék.');
  return p;
}

export async function location(db, locationId) {
  const l = await first(db, 'SELECT * FROM locations WHERE id = ?', locationId);
  if (!l) throw badRequest('Ismeretlen raktárhely.');
  return l;
}

export const locationByCode = (db, code) => first(db, 'SELECT * FROM locations WHERE code = ? COLLATE NOCASE', String(code || '').trim());

// The partner whose goods are in the location now, or null if it is empty.
export async function occupant(db, locationId) {
  const row = await first(
    db,
    `SELECT p.partner_id, pa.name FROM stock s JOIN products p ON p.id = s.product_id JOIN partners pa ON pa.id = p.partner_id
     WHERE s.location_id = ? AND s.qty > 0 LIMIT 1`,
    locationId,
  );
  return row ? { partnerId: row.partner_id, name: row.name } : null;
}

// One location, one partner: refuses a location that is inactive, dedicated to another partner,
// or already holds another partner's goods.
export async function assertCanStore(db, locationId, partnerId) {
  const loc = await location(db, locationId);
  if (!loc.active) throw conflict(`A(z) ${loc.code} raktárhely inaktív.`);
  if (!STORABLE.has(loc.kind)) throw conflict(`A(z) ${loc.code} raktárhelyre nem lehet árut tenni.`);
  if (loc.partner_id && loc.partner_id !== partnerId) {
    throw conflict(`A(z) ${loc.code} raktárhely egy másik partner fix helye.`);
  }
  const occ = await occupant(db, locationId);
  if (occ && occ.partnerId !== partnerId) {
    throw conflict(`A(z) ${loc.code} raktárhelyen már ${occ.name} áruja van. Egy helyen csak egy partner áruja lehet.`);
  }
  return loc;
}

function movementStmt(db, m, guarded) {
  const sql = `INSERT INTO movements (at, date, type, partner_id, product_id, location_id, lot, expiry, qty, ref_type, ref_id, user_id, note)
               SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${guarded ? ' WHERE changes() > 0' : ''}`;
  return stmt(db, sql, m.at, m.date, m.type, m.partnerId, m.productId, m.locationId, m.lot || '', m.expiry || '', m.qty,
    m.refType || '', m.refId ?? null, m.userId ?? null, m.note || '');
}

const userId = (ctx) => (ctx.user ? ctx.user.id : null);

// Puts goods into a location. type: inbound | return | adjust | cancel_pick
export async function addStock(ctx, { productId, locationId, qty, lot = '', expiry = '', type, refType = '', refId = null, note = '' }) {
  if (!Number.isInteger(qty) || qty <= 0) throw badRequest('A mennyiség pozitív egész szám legyen.');
  const db = ctx.env.DB;
  const p = await product(db, productId);
  await assertCanStore(db, locationId, p.partner_id);
  const at = nowIso();
  await batch(db, [
    stmt(db, `INSERT INTO stock (product_id, location_id, lot, expiry, qty, updated_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (product_id, location_id, lot, expiry) DO UPDATE SET qty = qty + excluded.qty, updated_at = excluded.updated_at`,
      productId, locationId, lot, expiry, qty, at),
    movementStmt(db, { at, date: budapestDate(), type, partnerId: p.partner_id, productId, locationId, lot, expiry, qty, refType, refId, userId: userId(ctx), note }, false),
  ]);
}

// Takes goods out of a location. type: pick | adjust. Throws 409 if there is not enough.
export async function removeStock(ctx, { productId, locationId, qty, lot = '', expiry = '', type, refType = '', refId = null, note = '' }) {
  if (!Number.isInteger(qty) || qty <= 0) throw badRequest('A mennyiség pozitív egész szám legyen.');
  const db = ctx.env.DB;
  const p = await product(db, productId);
  const at = nowIso();
  const res = await batch(db, [
    stmt(db, `UPDATE stock SET qty = qty - ?, updated_at = ? WHERE product_id = ? AND location_id = ? AND lot = ? AND expiry = ? AND qty >= ?`,
      qty, at, productId, locationId, lot, expiry, qty),
    movementStmt(db, { at, date: budapestDate(), type, partnerId: p.partner_id, productId, locationId, lot, expiry, qty: -qty, refType, refId, userId: userId(ctx), note }, true),
    stmt(db, 'DELETE FROM stock WHERE product_id = ? AND location_id = ? AND lot = ? AND expiry = ? AND qty = 0', productId, locationId, lot, expiry),
  ]);
  if (res[0].meta.changes !== 1) {
    const loc = await location(db, locationId);
    throw conflict(`Nincs elég készlet: ${p.sku} a(z) ${loc.code} helyen.`);
  }
}

// Moves goods between two locations in one transaction.
export async function transferStock(ctx, { productId, fromLocationId, toLocationId, qty, lot = '', expiry = '', refType = 'manual', refId = null, note = '' }) {
  if (!Number.isInteger(qty) || qty <= 0) throw badRequest('A mennyiség pozitív egész szám legyen.');
  if (fromLocationId === toLocationId) throw badRequest('A cél raktárhely nem lehet ugyanaz.');
  const db = ctx.env.DB;
  const p = await product(db, productId);
  await assertCanStore(db, toLocationId, p.partner_id);
  const at = nowIso();
  const date = budapestDate();
  const base = { at, date, partnerId: p.partner_id, productId, lot, expiry, refType, refId, userId: userId(ctx), note };
  const res = await batch(db, [
    stmt(db, `UPDATE stock SET qty = qty - ?, updated_at = ? WHERE product_id = ? AND location_id = ? AND lot = ? AND expiry = ? AND qty >= ?`,
      qty, at, productId, fromLocationId, lot, expiry, qty),
    stmt(db, `INSERT INTO stock (product_id, location_id, lot, expiry, qty, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE changes() > 0
              ON CONFLICT (product_id, location_id, lot, expiry) DO UPDATE SET qty = qty + excluded.qty, updated_at = excluded.updated_at`,
      productId, toLocationId, lot, expiry, qty, at),
    movementStmt(db, { ...base, type: 'transfer_out', locationId: fromLocationId, qty: -qty }, true),
    movementStmt(db, { ...base, type: 'transfer_in', locationId: toLocationId, qty }, true),
    stmt(db, 'DELETE FROM stock WHERE product_id = ? AND location_id = ? AND lot = ? AND expiry = ? AND qty = 0', productId, fromLocationId, lot, expiry),
  ]);
  if (res[0].meta.changes !== 1) {
    const loc = await location(db, fromLocationId);
    throw conflict(`Nincs elég készlet: ${p.sku} a(z) ${loc.code} helyen.`);
  }
}

// Sets the quantity of one stock row to what was counted (inventory count posting).
// Returns the difference that was booked (0 if none).
export async function setStockQty(ctx, { productId, locationId, qty, lot = '', expiry = '', refType = 'count', refId = null, note = '' }) {
  if (!Number.isInteger(qty) || qty < 0) throw badRequest('A mennyiség nem lehet negatív.');
  const db = ctx.env.DB;
  const row = await first(db, 'SELECT qty FROM stock WHERE product_id = ? AND location_id = ? AND lot = ? AND expiry = ?', productId, locationId, lot, expiry);
  const current = row ? row.qty : 0;
  const diff = qty - current;
  if (diff > 0) await addStock(ctx, { productId, locationId, qty: diff, lot, expiry, type: 'adjust', refType, refId, note });
  if (diff < 0) await removeStock(ctx, { productId, locationId, qty: -diff, lot, expiry, type: 'adjust', refType, refId, note });
  return diff;
}

// { [productId]: { onHand, reserved, available } }. Reserved: open order lines not yet picked.
// Stock in quarantine locations counts as on hand but not available.
export async function availability(db, productIds) {
  const ids = [...new Set(productIds)].filter(Boolean);
  const out = {};
  if (!ids.length) return out;
  for (const id of ids) out[id] = { onHand: 0, blocked: 0, reserved: 0, available: 0 };
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const onHand = await all(
      db,
      `SELECT s.product_id, SUM(s.qty) AS qty, SUM(CASE WHEN l.kind = 'quarantine' THEN s.qty ELSE 0 END) AS blocked
       FROM stock s JOIN locations l ON l.id = s.location_id WHERE s.product_id IN (${marks(chunk.length)}) GROUP BY s.product_id`,
      ...chunk,
    );
    for (const r of onHand) Object.assign(out[r.product_id], { onHand: r.qty, blocked: r.blocked });
    const reserved = await all(
      db,
      `SELECT ol.product_id, SUM(ol.qty - ol.picked_qty) AS qty FROM order_lines ol JOIN orders o ON o.id = ol.order_id
       WHERE o.status IN ('new', 'hold', 'picking') AND ol.product_id IN (${marks(chunk.length)}) GROUP BY ol.product_id`,
      ...chunk,
    );
    for (const r of reserved) out[r.product_id].reserved = r.qty;
  }
  for (const id of ids) {
    const a = out[id];
    a.available = a.onHand - a.blocked - a.reserved;
  }
  return out;
}

// Picking plan for one product: which locations to take qty from. First expiry first (FEFO),
// then the walking order of locations. Quantities already planned in open waves are left alone.
// Returns [{ location_id, code, lot, expiry, qty }] covering as much of qty as there is.
export async function allocate(db, productId, qty) {
  const rows = await all(
    db,
    `SELECT s.location_id, l.code, s.lot, s.expiry, s.qty -
            COALESCE((SELECT SUM(pk.qty - pk.picked_qty) FROM picks pk JOIN waves w ON w.id = pk.wave_id
                      WHERE w.status IN ('open', 'picking') AND pk.product_id = s.product_id AND pk.location_id = s.location_id
                        AND pk.lot = s.lot AND pk.expiry = s.expiry), 0) AS free
     FROM stock s JOIN locations l ON l.id = s.location_id
     WHERE s.product_id = ? AND l.active = 1 AND l.kind IN (${marks(PICKABLE.length)})
     ORDER BY CASE WHEN s.expiry = '' THEN 1 ELSE 0 END, s.expiry, l.pick_sequence, l.code`,
    productId,
    ...PICKABLE,
  );
  const plan = [];
  let left = qty;
  for (const r of rows) {
    if (left <= 0) break;
    if (r.free <= 0) continue;
    const take = Math.min(r.free, left);
    plan.push({ location_id: r.location_id, code: r.code, lot: r.lot, expiry: r.expiry, qty: take });
    left -= take;
  }
  return { plan, missing: Math.max(left, 0) };
}

// ---------------------------------------------------------------- putaway suggestion
// Where qty pieces of a product (of a lot) should go. Returns { id, code, size_code, kind, reason,
// room } or null:
//  1. kind 'existing': a storage location that already holds the product, the same lot first,
//     if at least one more piece fits there (room: how many, null when it cannot be told);
//  2. kind 'empty': an empty active storage location, the client's own dedicated ones first, of
//     the size the pieces fit best: the smallest size that takes all of them, then sizes without
//     dimensions (they may), then the largest that takes some (room: per location).
// What fits comes from the product's dimensions and weight and the size's inner dimensions and
// maximum weight; goods use FILL of a location's volume. Without dimensions any size will do.
// taken (Map location id -> product id) keeps one empty location for one product while several
// lines are suggested together (an inbound): the next product gets the next empty location.
const FILL = 0.85;
const sides = (o) => [o.width_cm, o.depth_cm, o.height_cm];
const hasDims = (o) => sides(o).every((v) => Number(v) > 0);
const volumeOf = (o) => (hasDims(o) ? o.width_cm * o.depth_cm * o.height_cm : null);
// Whether one piece fits in the box at all: sides largest to smallest against the box's.
function fitsOne(item, box) {
  const a = sides(item).map(Number).sort((x, y) => y - x);
  const b = sides(box).map(Number).sort((x, y) => y - x);
  return a.every((v, i) => v <= b[i]);
}
// Pieces of the product an empty location of this size takes (null: cannot be told).
function piecesPerLocation(prod, size) {
  if (!hasDims(prod) || !hasDims(size)) return null;
  if (!fitsOne(prod, size)) return 0;
  let n = Math.floor((volumeOf(size) * FILL) / volumeOf(prod));
  if (prod.weight_kg > 0 && size.max_kg > 0) n = Math.min(n, Math.floor(size.max_kg / prod.weight_kg));
  return Math.max(n, 0);
}
// Pieces of the product that still fit in a location next to what is there (null: cannot be told).
async function roomIn(db, prod, loc) {
  if (!hasDims(prod) || !hasDims(loc)) return null;
  if (!fitsOne(prod, loc)) return 0;
  const there = await all(db,
    `SELECT s.qty, p.width_cm, p.depth_cm, p.height_cm, p.weight_kg FROM stock s JOIN products p ON p.id = s.product_id
     WHERE s.location_id = ? AND s.qty > 0`, loc.id);
  if (there.some((r) => !hasDims(r))) return null;
  const used = there.reduce((a, r) => a + r.qty * volumeOf(r), 0);
  let n = Math.floor((volumeOf(loc) * FILL - used) / volumeOf(prod));
  if (prod.weight_kg > 0 && loc.max_kg > 0 && there.every((r) => r.weight_kg != null)) {
    n = Math.min(n, Math.floor((loc.max_kg - there.reduce((a, r) => a + r.qty * r.weight_kg, 0)) / prod.weight_kg));
  }
  return Math.max(n, 0);
}

export async function suggestLocation(db, productId, { qty = 1, lot = '', expiry = '', taken = null } = {}) {
  const prod = await first(db, 'SELECT id, partner_id, sku, width_cm, depth_cm, height_cm, weight_kg FROM products WHERE id = ?', productId);
  if (!prod) throw badRequest('Ismeretlen termék.');
  const want = Math.max(Number(qty) || 1, 1);
  const takenBy = taken instanceof Map ? taken : new Map(Object.entries(taken || {}).map(([k, v]) => [Number(k), v]));
  const unit = (n) => `${n} db`;

  // 1. Where it already is, if there is room.
  const existing = await all(db,
    `SELECT l.id, l.code, z.code AS size_code, z.width_cm, z.depth_cm, z.height_cm, z.max_kg, MAX(s.lot = ? AND s.expiry = ?) AS same_lot, SUM(s.qty) AS qty
     FROM stock s JOIN locations l ON l.id = s.location_id JOIN location_sizes z ON z.id = l.size_id
     WHERE s.product_id = ? AND s.qty > 0 AND l.kind = 'storage' AND l.active = 1
     GROUP BY l.id ORDER BY same_lot DESC, qty DESC, l.pick_sequence, l.code`, lot, expiry, productId);
  for (const loc of existing) {
    const room = await roomIn(db, prod, loc);
    if (room === 0) continue;
    const reason = room == null ? 'itt már van ebből a termékből'
      : room >= want ? `itt már van ebből a termékből, és elfér még ${unit(want)}`
        : `itt már van ebből a termékből, de csak kb. ${unit(room)} fér még, a többinek új hely kell`;
    return { id: loc.id, code: loc.code, size_code: loc.size_code, kind: 'existing', reason, room };
  }

  // 2. An empty location of the size that fits best.
  const sizes = await all(db, 'SELECT id, code, name, width_cm, depth_cm, height_cm, max_kg, sort FROM location_sizes WHERE active = 1 ORDER BY sort, code');
  let order;
  if (hasDims(prod)) {
    const cap = new Map(sizes.map((z) => [z.id, piecesPerLocation(prod, z)]));
    const whole = sizes.filter((z) => cap.get(z.id) != null && cap.get(z.id) >= want);
    const unknown = sizes.filter((z) => cap.get(z.id) == null);
    const part = sizes.filter((z) => cap.get(z.id) > 0 && cap.get(z.id) < want).sort((a, b) => cap.get(b.id) - cap.get(a.id));
    order = [...whole, ...unknown, ...part].map((z) => ({ ...z, cap: cap.get(z.id) }));
  }
  const emptyOf = (sizeId, dedicatedOnly) => first(db,
    `SELECT l.id, l.code, l.partner_id, z.code AS size_code FROM locations l JOIN location_sizes z ON z.id = l.size_id
     WHERE l.kind = 'storage' AND l.active = 1 AND (l.partner_id IS NULL OR l.partner_id = ?) AND (? = 0 OR l.partner_id = ?)
       AND (? IS NULL OR l.size_id = ?)
       AND NOT EXISTS (SELECT 1 FROM stock s WHERE s.location_id = l.id AND s.qty > 0)
       AND l.id NOT IN (SELECT value FROM json_each(?))
     ORDER BY CASE WHEN l.partner_id = ? THEN 0 ELSE 1 END, l.pick_sequence, l.code LIMIT 1`,
    prod.partner_id, dedicatedOnly ? 1 : 0, prod.partner_id, sizeId, sizeId,
    JSON.stringify([...takenBy].filter(([, pid]) => pid !== prod.id).map(([id]) => id)), prod.partner_id);
  const pick = (loc, z) => {
    takenBy.set(loc.id, prod.id);
    const own = loc.partner_id === prod.partner_id ? 'az ügyfél fix helye, ' : '';
    let reason;
    if (!z) reason = `${own}üres hely (a termék méretei nincsenek megadva, ezért a méretét nem néztem)`;
    else if (z.cap == null) reason = `${own}üres ${z.code} hely (ennél a méretnél nincs megadva a hely mérete)`;
    else if (z.cap >= want) reason = `${own}üres ${z.code} hely, a ${unit(want)} elfér rajta (kb. ${unit(z.cap)} férne)`;
    else reason = `${own}üres ${z.code} hely, de csak kb. ${unit(z.cap)} fér rá, összesen kb. ${Math.ceil(want / z.cap)} hely kell`;
    return { id: loc.id, code: loc.code, size_code: loc.size_code, kind: 'empty', reason, room: z ? z.cap : null };
  };
  if (!order) {
    const loc = await emptyOf(null, false);
    return loc ? pick(loc, null) : null;
  }
  // The client's own empty locations of a size that takes everything (or may), then any.
  for (const z of order.filter((x) => x.cap == null || x.cap >= want)) {
    const loc = await emptyOf(z.id, true);
    if (loc) return pick(loc, z);
  }
  for (const z of order) {
    const loc = await emptyOf(z.id, false);
    if (loc) return pick(loc, z);
  }
  return null;
}
