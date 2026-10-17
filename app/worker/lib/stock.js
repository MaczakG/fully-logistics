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

// Suggests a putaway location for a product: where it already is, else an empty active location
// of the wanted size (or any size), dedicated to the partner or free.
export async function suggestLocation(db, productId, sizeId = null) {
  const p = await product(db, productId);
  const existing = await first(
    db,
    `SELECT l.id, l.code FROM stock s JOIN locations l ON l.id = s.location_id
     WHERE s.product_id = ? AND l.kind = 'storage' AND l.active = 1 ORDER BY s.qty DESC LIMIT 1`,
    productId,
  );
  if (existing) return existing;
  return first(
    db,
    `SELECT l.id, l.code FROM locations l
     WHERE l.kind = 'storage' AND l.active = 1 AND (l.partner_id IS NULL OR l.partner_id = ?)
       AND (? IS NULL OR l.size_id = ?)
       AND NOT EXISTS (SELECT 1 FROM stock s WHERE s.location_id = l.id AND s.qty > 0)
     ORDER BY CASE WHEN l.partner_id = ? THEN 0 ELSE 1 END, l.pick_sequence, l.code LIMIT 1`,
    p.partner_id,
    sizeId,
    sizeId,
    p.partner_id,
  );
}
