// Komissió: waves, pick lists, pick confirmation by scan, packing, labels. Prefix /api/picking
//
//   GET   /api/picking/waves                  wave list (?status=active|open|picking|picked|completed|cancelled|all) [picking view]
//   POST  /api/picking/waves                  new wave from new, fully allocatable orders (FEFO) [picking create]
//   GET   /api/picking/waves/:id              tasks in walking order, orders, progress [picking view]
//   PATCH /api/picking/waves/:id              picker, note [picking edit]
//   POST  /api/picking/waves/:id/start        [picking edit]
//   GET   /api/picking/waves/:id/scan?code=   what a scanned code means in this wave [picking view]
//   POST  /api/picking/waves/:id/confirm      confirm a task: scanned location + product, quantity [picking edit]
//   POST  /api/picking/waves/:id/short        shortage: the rest of a task is not at the location [picking edit]
//   POST  /api/picking/waves/:id/complete     close; with missing pieces it needs [picking approve]
//   POST  /api/picking/waves/:id/cancel       cancel: picked goods back to their locations [picking delete]
//   GET   /api/picking/packing                packing queue and today's packed orders [picking view]
//   GET   /api/picking/packing/lookup?code=   order to pack by order number, external number or product code [picking view]
//   GET   /api/picking/orders/:id             one order for the packing station [picking view]
//   POST  /api/picking/orders/:id/pack        package count, weight, carrier label or manual tracking number [picking edit]
//   POST  /api/picking/orders/:id/unpack      back to picking (wrong label, repacking) [picking edit]
//
// A task is a group of picks with the same location, product, lot and expiry: the picker takes the
// total once and the confirmed quantity is shared out over the orders (express first, then oldest).

import { all, batch, first, marks, nextNumber, run, stmt } from '../lib/db.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { need } from '../lib/perm.js';
import { addStock, allocate, assertCanStore, locationByCode, removeStock } from '../lib/stock.js';
import { setOrderStatus } from '../lib/orders.js';
import { STATUSES } from '../lib/constants.js';
import { budapestDate, nowIso } from '../lib/time.js';
import { createLabel, isConfigured, trackingUrl } from '../integrations/couriers/index.js';

const ACTIVE = ['open', 'picking', 'picked'];
const MAX_WAVE_ORDERS = 200;
// Couriers whose parcels always have a tracking number.
export const TRACKED_CARRIERS = ['gls', 'dpd', 'foxpost', 'mpl', 'dhl'];

const userId = (ctx) => (ctx.user ? ctx.user.id : null);
const remaining = (pk) => pk.qty - pk.picked_qty - pk.short_qty;
const orderLabel = (s) => (STATUSES.order[s] ? STATUSES.order[s].label : s);

export function idParam(ctx, key = 'id') {
  const n = Number(ctx.params[key]);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
}

// Runs an "IN (...)" query in chunks (D1 binds at most 100 parameters).
export async function allIn(db, sqlWithIn, ids, ...before) {
  const out = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    out.push(...await all(db, sqlWithIn.replace('(?)', `(${marks(chunk.length)})`), ...before, ...chunk));
  }
  return out;
}

// SKU (any case) or EAN (also without leading zeros, so EAN-13 and UPC-A both match).
export function matchesProduct(p, code) {
  const c = String(code || '').trim();
  if (!c) return false;
  if (p.sku && p.sku.toLowerCase() === c.toLowerCase()) return true;
  if (!p.ean) return false;
  if (p.ean === c) return true;
  const digits = /^\d+$/;
  if (digits.test(c) && digits.test(p.ean)) {
    const a = c.replace(/^0+/, '');
    return a !== '' && a === p.ean.replace(/^0+/, '');
  }
  return false;
}

// Free pickable stock per product, the same way allocate() sees it: storage locations, minus what
// open waves have planned but not picked yet. { [productId]: qty }
export async function freeStock(db, productIds) {
  const ids = [...new Set(productIds)].filter(Boolean);
  const out = {};
  for (const id of ids) out[id] = 0;
  const rows = await allIn(db,
    `SELECT s.product_id, SUM(MAX(s.qty - COALESCE((SELECT SUM(pk.qty - pk.picked_qty) FROM picks pk JOIN waves w ON w.id = pk.wave_id
                                                   WHERE w.status IN ('open', 'picking') AND pk.product_id = s.product_id AND pk.location_id = s.location_id
                                                     AND pk.lot = s.lot AND pk.expiry = s.expiry), 0), 0)) AS free
     FROM stock s JOIN locations l ON l.id = s.location_id
     WHERE l.active = 1 AND l.kind = 'storage' AND s.product_id IN (?) GROUP BY s.product_id`, ids);
  for (const r of rows) out[r.product_id] = r.free || 0;
  return out;
}

const defaultReturnsLocation = (db) =>
  first(db, "SELECT id, code FROM locations WHERE kind = 'returns' AND active = 1 ORDER BY pick_sequence, code LIMIT 1");

// ISO instant of 00:00 Budapest time on a "YYYY-MM-DD" date (for filters on timestamp columns).
export function budapestDayStartIso(date) {
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const offset = (d) => (Date.parse(`${fmt.format(d).replace(' ', 'T')}Z`) - d.getTime()) / 60000;
  const midnightUtc = Date.parse(`${date}T00:00:00Z`);
  let t = midnightUtc - offset(new Date(midnightUtc)) * 60000;
  t = midnightUtc - offset(new Date(t)) * 60000;
  return new Date(t).toISOString();
}

// Checks before anything changes that every picked piece can go back: to its own location, or to
// the returns zone if another partner's goods have arrived there since.
export async function checkRestock(db, picks) {
  let returnsLoc;
  for (const pk of picks) {
    if (pk.picked_qty - pk.restocked_qty <= 0) continue;
    const p = await first(db, 'SELECT partner_id, sku FROM products WHERE id = ?', pk.product_id);
    try {
      await assertCanStore(db, pk.location_id, p.partner_id);
    } catch (err) {
      if (err.status !== 409) throw err;
      if (returnsLoc === undefined) returnsLoc = await defaultReturnsLocation(db);
      if (!returnsLoc) throw conflict(`${err.message} A kiszedett ${p.sku} nem tehető vissza, és nincs aktív visszáru zóna sem.`);
    }
  }
}

// Puts picked goods back into stock (cancel_pick) to the location they came from; if that location
// cannot take them any more (another partner's goods arrived), to the returns zone.
// picks: rows of the picks table. Returns [{ pickId, sku, qty, code, fallback }].
export async function restockPicks(ctx, picks, { refType, refId, note }) {
  const db = ctx.env.DB;
  await checkRestock(db, picks);
  const done = [];
  for (const pk of picks) {
    const amount = pk.picked_qty - pk.restocked_qty;
    if (amount <= 0) continue;
    const claim = await run(db, 'UPDATE picks SET restocked_qty = restocked_qty + ? WHERE id = ? AND picked_qty - restocked_qty >= ?', amount, pk.id, amount);
    if (claim.meta.changes !== 1) continue;
    const base = { productId: pk.product_id, qty: amount, lot: pk.lot, expiry: pk.expiry, type: 'cancel_pick', refType, refId, note };
    let code = null;
    let fallback = false;
    try {
      try {
        await addStock(ctx, { ...base, locationId: pk.location_id });
      } catch (err) {
        if (err.status !== 409) throw err;
        const ret = await defaultReturnsLocation(db);
        if (!ret) throw err;
        await addStock(ctx, { ...base, locationId: ret.id, note: `${note} (az eredeti hely foglalt)` });
        code = ret.code;
        fallback = true;
      }
    } catch (err) {
      await run(db, 'UPDATE picks SET restocked_qty = restocked_qty - ? WHERE id = ?', amount, pk.id);
      throw err;
    }
    await run(db, 'UPDATE order_lines SET picked_qty = MAX(picked_qty - ?, 0) WHERE id = ?', amount, pk.order_line_id);
    if (!code) code = (await first(db, 'SELECT code FROM locations WHERE id = ?', pk.location_id)).code;
    const p = await first(db, 'SELECT sku FROM products WHERE id = ?', pk.product_id);
    done.push({ pickId: pk.id, sku: p ? p.sku : '', qty: amount, code, fallback });
  }
  return done;
}

// Picked goods still held for an order (not put back), across every wave.
export const heldPicks = (db, orderId) =>
  all(db, 'SELECT * FROM picks WHERE order_id = ? AND picked_qty - restocked_qty > 0 ORDER BY id', orderId);

async function loadWave(db, id) {
  const w = await first(db, 'SELECT * FROM waves WHERE id = ?', id);
  if (!w) throw notFound('A hullám nem található.');
  return w;
}

function assertActive(w) {
  if (!ACTIVE.includes(w.status)) {
    throw conflict(`A(z) ${w.number} hullám már ${w.status === 'completed' ? 'le van zárva' : 'meg van szakítva'}.`);
  }
}

// open/picking -> picked when nothing is left to pick; picked -> picking when a re-plan added work.
async function refreshWaveStatus(db, waveId) {
  const w = await first(db, 'SELECT id, status FROM waves WHERE id = ?', waveId);
  if (!w || !ACTIVE.includes(w.status)) return w ? w.status : null;
  const r = await first(db, 'SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN qty - picked_qty - short_qty > 0 THEN 1 ELSE 0 END), 0) AS open FROM picks WHERE wave_id = ?', waveId);
  let next = w.status;
  if (r.open === 0 && (w.status === 'picking' || r.n === 0)) next = 'picked';
  if (r.open > 0 && w.status === 'picked') next = 'picking';
  if (next !== w.status) await run(db, 'UPDATE waves SET status = ? WHERE id = ? AND status = ?', next, waveId, w.status);
  return next;
}

// A picked wave whose orders are all packed (or further) closes itself.
async function autoCompleteWave(ctx, waveId) {
  if (!waveId) return false;
  const db = ctx.env.DB;
  const w = await first(db, 'SELECT id, number, status FROM waves WHERE id = ?', waveId);
  if (!w || w.status !== 'picked') return false;
  const left = await first(db, "SELECT COUNT(*) AS n FROM orders WHERE wave_id = ? AND status = 'picking'", waveId);
  if (left.n > 0) return false;
  const res = await run(db, "UPDATE waves SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'picked'", nowIso(), waveId);
  if (res.meta.changes === 1) {
    await audit(ctx, { module: 'picking', action: 'edit', entity: 'wave', entityId: waveId, summary: `${w.number} lezárva (minden rendelés becsomagolva)` });
  }
  return res.meta.changes === 1;
}

// ---------------------------------------------------------------- wave creation

async function createWave(ctx, body) {
  const db = ctx.env.DB;
  const data = validate(body, {
    picker_id: { type: 'id', nullable: true },
    note: { type: 'str', max: 500, default: '' },
  });
  const list = Array.isArray(body.order_ids) ? body.order_ids : null;
  if (!list || !list.length) throw badRequest('Válassz ki legalább egy rendelést.', { order_ids: 'Válassz ki legalább egy rendelést.' });
  const ids = [...new Set(list.map(Number))];
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw badRequest('Érvénytelen rendelésazonosító.', { order_ids: 'Érvénytelen azonosító.' });
  if (ids.length > MAX_WAVE_ORDERS) throw badRequest(`Egy hullámban legfeljebb ${MAX_WAVE_ORDERS} rendelés lehet.`, { order_ids: `Legfeljebb ${MAX_WAVE_ORDERS} rendelés.` });
  if (data.picker_id) {
    const u = await first(db, 'SELECT id FROM users WHERE id = ? AND active = 1', data.picker_id);
    if (!u) throw badRequest('Ismeretlen komissiós.', { picker_id: 'Válassz aktív felhasználót.' });
  }

  const orders = await allIn(db, 'SELECT id, number, status, priority, created_at FROM orders WHERE id IN (?)', ids);
  if (orders.length !== ids.length) throw notFound('A kiválasztott rendelések egy része nem található. Frissítsd a listát.');
  const notNew = orders.filter((o) => o.status !== 'new');
  if (notNew.length) {
    throw conflict(`Csak új rendelés küldhető komissióba. Nem új: ${notNew.map((o) => `${o.number} (${orderLabel(o.status)})`).join(', ')}.`);
  }
  orders.sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'express' ? -1 : 1) || a.created_at.localeCompare(b.created_at) || a.id - b.id);
  const seq = new Map(orders.map((o, i) => [o.id, i]));

  const lines = (await allIn(db,
    `SELECT ol.id, ol.order_id, ol.product_id, ol.qty - ol.picked_qty AS remaining, p.sku, p.name
     FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id IN (?)`, ids))
    .filter((l) => l.remaining > 0)
    .sort((a, b) => seq.get(a.order_id) - seq.get(b.order_id) || a.id - b.id);

  // One FEFO plan per product for the total the wave needs.
  const needs = new Map();
  for (const l of lines) {
    const n = needs.get(l.product_id) || { qty: 0, sku: l.sku, name: l.name, orders: new Set() };
    n.qty += l.remaining;
    n.orders.add(l.order_id);
    needs.set(l.product_id, n);
  }
  const plans = new Map();
  const missing = [];
  for (const [productId, n] of needs) {
    const { plan, missing: short } = await allocate(db, productId, n.qty);
    plans.set(productId, plan.map((p) => ({ ...p })));
    if (short > 0) missing.push({ ...n, missing: short });
  }
  if (missing.length) {
    const byNumber = new Map(orders.map((o) => [o.id, o.number]));
    const fields = {};
    for (const m of missing) {
      for (const oid of m.orders) {
        const key = byNumber.get(oid);
        fields[key] = fields[key] ? `${fields[key]}, ${m.sku}` : `Hiányzik: ${m.sku}`;
      }
    }
    throw conflict(`Nem indítható a hullám, mert nincs elég szabad készlet a polcokon: ${missing
      .map((m) => `${m.sku} ${m.name} (hiányzik ${m.missing} db)`).join('; ')}. Vedd ki ezeket a rendeléseket, vagy várd meg a betárolást.`, fields);
  }

  const picks = [];
  for (const l of lines) {
    const plan = plans.get(l.product_id);
    let left = l.remaining;
    while (left > 0 && plan.length) {
      const e = plan[0];
      const take = Math.min(e.qty, left);
      picks.push({ order_id: l.order_id, order_line_id: l.id, product_id: l.product_id, location_id: e.location_id, lot: e.lot, expiry: e.expiry, qty: take });
      e.qty -= take;
      left -= take;
      if (e.qty <= 0) plan.shift();
    }
  }

  const number = await nextNumber(db, 'H');
  const at = nowIso();
  const ref = '(SELECT id FROM waves WHERE number = ?)';
  await batch(db, [
    stmt(db, "INSERT INTO waves (number, status, picker_id, note, created_by, created_at) VALUES (?, 'open', ?, ?, ?, ?)",
      number, data.picker_id || null, data.note, userId(ctx), at),
    ...picks.map((p) => stmt(db, `INSERT INTO picks (wave_id, order_id, order_line_id, product_id, location_id, lot, expiry, qty) VALUES (${ref}, ?, ?, ?, ?, ?, ?, ?)`,
      number, p.order_id, p.order_line_id, p.product_id, p.location_id, p.lot, p.expiry, p.qty)),
  ]);
  const wave = await first(db, 'SELECT id FROM waves WHERE number = ?', number);

  // Two waves created at the same moment could both have planned the same pieces: check and undo.
  const over = await first(db,
    `SELECT COUNT(*) AS n FROM (
       SELECT pk.product_id, pk.location_id, pk.lot, pk.expiry, SUM(pk.qty - pk.picked_qty) AS planned
       FROM picks pk JOIN waves w ON w.id = pk.wave_id
       WHERE w.status IN ('open', 'picking')
         AND EXISTS (SELECT 1 FROM picks me WHERE me.wave_id = ? AND me.product_id = pk.product_id AND me.location_id = pk.location_id AND me.lot = pk.lot AND me.expiry = pk.expiry)
       GROUP BY pk.product_id, pk.location_id, pk.lot, pk.expiry) x
     LEFT JOIN stock s ON s.product_id = x.product_id AND s.location_id = x.location_id AND s.lot = x.lot AND s.expiry = x.expiry
     WHERE x.planned > COALESCE(s.qty, 0)`, wave.id);
  if (over.n > 0) {
    await batch(db, [stmt(db, 'DELETE FROM picks WHERE wave_id = ?', wave.id), stmt(db, 'DELETE FROM waves WHERE id = ?', wave.id)]);
    throw conflict('Közben megváltozott a készlet, vagy egy másik hullám ugyanazt az árut foglalta le. Próbáld újra.');
  }

  const skipped = [];
  for (const o of orders) {
    try {
      await setOrderStatus(ctx, o.id, 'picking', `Komissióba küldve (${number})`, { wave_id: wave.id });
    } catch (err) {
      if (err.status !== 409) throw err;
      await run(db, 'DELETE FROM picks WHERE wave_id = ? AND order_id = ?', wave.id, o.id);
      skipped.push(o.number);
    }
  }
  if (skipped.length === orders.length) {
    await batch(db, [stmt(db, 'DELETE FROM picks WHERE wave_id = ?', wave.id), stmt(db, 'DELETE FROM waves WHERE id = ?', wave.id)]);
    throw conflict('Közben mindegyik rendelés állapota megváltozott. Frissítsd a listát.');
  }
  await refreshWaveStatus(db, wave.id);
  await audit(ctx, {
    module: 'picking', action: 'create', entity: 'wave', entityId: wave.id,
    summary: `${number} indítva: ${orders.length - skipped.length} rendelés, ${picks.length} kiszedés`,
    details: { orders: orders.filter((o) => !skipped.includes(o.number)).map((o) => o.number), skipped },
  });
  return { id: wave.id, number, orders: orders.length - skipped.length, picks: picks.length, skipped };
}

// ---------------------------------------------------------------- wave detail

const PICKS_SQL = `
  SELECT pk.*, l.code AS location_code, l.zone, l.pick_sequence, p.sku, p.name, p.ean, p.unit,
         o.number AS order_number, o.priority, o.created_at AS order_created_at, o.status AS order_status, u.name AS picked_by_name
  FROM picks pk JOIN locations l ON l.id = pk.location_id JOIN products p ON p.id = pk.product_id
  JOIN orders o ON o.id = pk.order_id LEFT JOIN users u ON u.id = pk.picked_by
  WHERE pk.wave_id = ?
  ORDER BY l.pick_sequence, l.code, p.sku, pk.lot, pk.expiry, CASE o.priority WHEN 'express' THEN 0 ELSE 1 END, o.created_at, pk.id`;

function buildTasks(picks) {
  const tasks = [];
  const byKey = new Map();
  for (const pk of picks) {
    const key = `${pk.location_id}|${pk.product_id}|${pk.lot}|${pk.expiry}`;
    let t = byKey.get(key);
    if (!t) {
      t = {
        key, pick_id: pk.id, pick_ids: [],
        location: { id: pk.location_id, code: pk.location_code, zone: pk.zone },
        product: { id: pk.product_id, sku: pk.sku, name: pk.name, ean: pk.ean, unit: pk.unit },
        lot: pk.lot, expiry: pk.expiry, qty: 0, picked: 0, short: 0, remaining: 0, express: false, orders: [],
      };
      byKey.set(key, t);
      tasks.push(t);
    }
    t.pick_ids.push(pk.id);
    t.qty += pk.qty;
    t.picked += pk.picked_qty;
    t.short += pk.short_qty;
    t.remaining += Math.max(remaining(pk), 0);
    if (pk.priority === 'express') t.express = true;
    if (!t.orders.includes(pk.order_number)) t.orders.push(pk.order_number);
  }
  for (const t of tasks) {
    // The first pick still open is the one the client sends back when confirming.
    const open = picks.find((pk) => t.pick_ids.includes(pk.id) && remaining(pk) > 0);
    if (open) t.pick_id = open.id;
    t.state = t.remaining > 0 ? 'open' : t.short > 0 ? 'short' : 'done';
  }
  return tasks;
}

async function waveDetail(db, id) {
  const w = await first(db,
    `SELECT w.*, u.name AS picker_name, c.name AS created_by_name FROM waves w
     LEFT JOIN users u ON u.id = w.picker_id LEFT JOIN users c ON c.id = w.created_by WHERE w.id = ?`, id);
  if (!w) throw notFound('A hullám nem található.');
  const picks = await all(db, PICKS_SQL, id);
  const tasks = buildTasks(picks);
  const orders = await all(db,
    `SELECT o.id, o.number, o.external_number, o.status, o.priority, o.customer_name, o.city, o.tracking_number, o.wave_id,
            pa.code AS partner_code, c.name AS carrier_name, c.carrier_code,
            (SELECT COALESCE(SUM(qty), 0) FROM order_lines WHERE order_id = o.id) AS item_count,
            (SELECT COALESCE(SUM(picked_qty), 0) FROM order_lines WHERE order_id = o.id) AS picked_count
     FROM orders o JOIN partners pa ON pa.id = o.partner_id LEFT JOIN partners c ON c.id = o.carrier_id
     WHERE o.wave_id = ? OR o.id IN (SELECT order_id FROM picks WHERE wave_id = ?)
     ORDER BY CASE o.priority WHEN 'express' THEN 0 ELSE 1 END, o.created_at, o.id`, id, id);
  for (const o of orders) {
    const mine = picks.filter((pk) => pk.order_id === o.id);
    o.in_wave = o.wave_id === id;
    o.wave_qty = mine.reduce((s, pk) => s + pk.qty, 0);
    o.wave_picked = mine.reduce((s, pk) => s + pk.picked_qty, 0);
    o.wave_short = mine.reduce((s, pk) => s + pk.short_qty, 0);
    o.ready = o.status === 'picking' && o.picked_count >= o.item_count;
  }
  const sum = (f) => picks.reduce((s, pk) => s + f(pk), 0);
  const progress = {
    qty: sum((pk) => pk.qty), picked: sum((pk) => pk.picked_qty), short: sum((pk) => pk.short_qty),
    remaining: sum((pk) => Math.max(remaining(pk), 0)), tasks: tasks.length, open_tasks: tasks.filter((t) => t.state === 'open').length,
  };
  const incomplete = orders.filter((o) => o.in_wave && o.status === 'picking' && o.picked_count < o.item_count).map((o) => o.number);
  return {
    ...w,
    picks: picks.map((pk) => ({
      id: pk.id, order_id: pk.order_id, order_number: pk.order_number, order_line_id: pk.order_line_id, product_id: pk.product_id,
      sku: pk.sku, name: pk.name, location_id: pk.location_id, location_code: pk.location_code, lot: pk.lot, expiry: pk.expiry,
      qty: pk.qty, picked_qty: pk.picked_qty, short_qty: pk.short_qty, restocked_qty: pk.restocked_qty,
      picked_by_name: pk.picked_by_name, picked_at: pk.picked_at,
    })),
    tasks,
    orders,
    progress,
    incomplete_orders: incomplete,
  };
}

async function groupOf(db, waveId, pickId) {
  const pk = await first(db, 'SELECT * FROM picks WHERE id = ? AND wave_id = ?', pickId, waveId);
  if (!pk) throw notFound('Ez a feladat nem tartozik ehhez a hullámhoz. Frissítsd a listát.');
  const group = await all(db,
    `SELECT pk.*, o.number AS order_number FROM picks pk JOIN orders o ON o.id = pk.order_id
     WHERE pk.wave_id = ? AND pk.location_id = ? AND pk.product_id = ? AND pk.lot = ? AND pk.expiry = ?
       AND pk.qty - pk.picked_qty - pk.short_qty > 0
     ORDER BY CASE o.priority WHEN 'express' THEN 0 ELSE 1 END, o.created_at, pk.id`,
    waveId, pk.location_id, pk.product_id, pk.lot, pk.expiry);
  const loc = await first(db, 'SELECT id, code FROM locations WHERE id = ?', pk.location_id);
  const product = await first(db, 'SELECT id, sku, name, ean, unit FROM products WHERE id = ?', pk.product_id);
  return { pk, group, loc, product, left: group.reduce((s, g) => s + remaining(g), 0) };
}

async function startWave(ctx, w) {
  if (w.status !== 'open') return w;
  await run(ctx.env.DB, "UPDATE waves SET status = 'picking', started_at = COALESCE(started_at, ?), picker_id = COALESCE(picker_id, ?) WHERE id = ? AND status = 'open'",
    nowIso(), userId(ctx), w.id);
  return { ...w, status: 'picking' };
}

// ---------------------------------------------------------------- pick confirmation and shortage

async function confirmPick(ctx, waveId, body) {
  const db = ctx.env.DB;
  const data = validate(body, {
    pick_id: { type: 'id', required: true },
    location_code: { type: 'str', required: true, max: 60 },
    product_code: { type: 'str', required: true, max: 120 },
    qty: { type: 'int', required: true, min: 1, max: 100000 },
  });
  let w = await loadWave(db, waveId);
  assertActive(w);
  if (w.status === 'picked') throw conflict('Ebben a hullámban már minden ki van szedve.');
  const { group, loc, product, left } = await groupOf(db, waveId, data.pick_id);
  if (!left) throw conflict('Ez a feladat már kész. Frissítsd a listát.');

  const scanned = await locationByCode(db, data.location_code);
  if (!scanned || scanned.id !== loc.id) {
    throw conflict(`Rossz raktárhely (${data.location_code}). Ezt a tételt a(z) ${loc.code} helyről kell kiszedni.`, { location_code: `A helyes hely: ${loc.code}` });
  }
  if (!matchesProduct(product, data.product_code)) {
    throw conflict(`Rossz termék (${data.product_code}). A(z) ${loc.code} helyen ezt kell kiszedni: ${product.sku} ${product.name}.`, { product_code: `A helyes termék: ${product.sku}` });
  }
  if (data.qty > left) {
    throw badRequest(`Ennél a feladatnál legfeljebb ${left} ${product.unit} szedhető ki.`, { qty: `Legfeljebb ${left}.` });
  }
  w = await startWave(ctx, w);

  // Share the quantity out over the orders and claim it on the picks first, so that two scanners
  // confirming the same task cannot both take it.
  const at = nowIso();
  const shares = [];
  let rest = data.qty;
  for (const g of group) {
    if (rest <= 0) break;
    const take = Math.min(remaining(g), rest);
    shares.push({ pick: g, take });
    rest -= take;
  }
  const claims = await batch(db, shares.map((s) => stmt(db,
    'UPDATE picks SET picked_qty = picked_qty + ?, picked_by = ?, picked_at = ? WHERE id = ? AND qty - picked_qty - short_qty >= ?',
    s.take, userId(ctx), at, s.pick.id, s.take)));
  const undo = () => batch(db, shares.filter((s, i) => claims[i].meta.changes === 1)
    .map((s) => stmt(db, 'UPDATE picks SET picked_qty = picked_qty - ? WHERE id = ?', s.take, s.pick.id)));
  if (claims.some((c) => c.meta.changes !== 1)) {
    await undo();
    throw conflict('Ezt a tételt közben valaki más is kiszedte. Frissítsd a listát.');
  }
  try {
    await removeStock(ctx, {
      productId: product.id, locationId: loc.id, qty: data.qty, lot: group[0].lot, expiry: group[0].expiry,
      type: 'pick', refType: 'wave', refId: waveId, note: `${w.number}: ${[...new Set(shares.map((s) => s.pick.order_number))].join(', ')}`,
    });
  } catch (err) {
    await undo();
    throw err;
  }
  await batch(db, shares.map((s) => stmt(db, 'UPDATE order_lines SET picked_qty = picked_qty + ? WHERE id = ?', s.take, s.pick.order_line_id)));
  const status = await refreshWaveStatus(db, waveId);
  await audit(ctx, {
    module: 'picking', action: 'edit', entity: 'wave', entityId: waveId,
    summary: `${w.number}: kiszedve ${data.qty} ${product.unit} ${product.sku} (${loc.code})`,
  });
  return { ok: true, picked: data.qty, left: left - data.qty, wave_status: status };
}

async function shortPick(ctx, waveId, body) {
  const db = ctx.env.DB;
  const data = validate(body, { pick_id: { type: 'id', required: true } });
  let w = await loadWave(db, waveId);
  assertActive(w);
  const { group, loc, product, left } = await groupOf(db, waveId, data.pick_id);
  if (!left) throw conflict('Ennél a feladatnál nincs több kiszedendő tétel. Frissítsd a listát.');
  w = await startWave(ctx, w);

  const marked = [];
  for (const g of group) {
    const n = remaining(g);
    const res = await run(db, 'UPDATE picks SET short_qty = short_qty + ? WHERE id = ? AND qty - picked_qty - short_qty = ?', n, g.id, n);
    if (res.meta.changes === 1) marked.push({ ...g, short: n });
  }
  const shortQty = marked.reduce((s, g) => s + g.short, 0);

  // Re-plan the missing pieces from other locations (never from one already found short here).
  const excluded = new Set((await all(db, 'SELECT DISTINCT location_id FROM picks WHERE wave_id = ? AND product_id = ? AND short_qty > 0', waveId, product.id))
    .map((r) => r.location_id));
  const { plan } = await allocate(db, product.id, Number.MAX_SAFE_INTEGER);
  const options = plan.filter((p) => !excluded.has(p.location_id));
  const inserts = [];
  const moved = [];
  let missing = 0;
  for (const g of marked) {
    let need = g.short;
    while (need > 0 && options.length) {
      const e = options[0];
      const take = Math.min(e.qty, need);
      inserts.push(stmt(db, 'INSERT INTO picks (wave_id, order_id, order_line_id, product_id, location_id, lot, expiry, qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        waveId, g.order_id, g.order_line_id, g.product_id, e.location_id, e.lot, e.expiry, take));
      const m = moved.find((x) => x.code === e.code);
      if (m) m.qty += take;
      else moved.push({ code: e.code, qty: take });
      e.qty -= take;
      need -= take;
      if (e.qty <= 0) options.shift();
    }
    missing += need;
  }
  if (inserts.length) await batch(db, inserts);
  const status = await refreshWaveStatus(db, waveId);
  const where = moved.map((m) => `${m.code} (${m.qty} ${product.unit})`).join(', ');
  await audit(ctx, {
    module: 'picking', action: 'edit', entity: 'wave', entityId: waveId,
    summary: `${w.number}: hiány ${shortQty} ${product.unit} ${product.sku} a(z) ${loc.code} helyen${moved.length ? `, új hely: ${where}` : ''}${missing ? `, nem pótolható: ${missing}` : ''}`,
    details: { location: loc.code, sku: product.sku, short: shortQty, moved, missing },
  });
  return { ok: true, short: shortQty, moved, missing, wave_status: status };
}

// ---------------------------------------------------------------- complete and cancel

async function completeWave(ctx, waveId) {
  const db = ctx.env.DB;
  const w = await loadWave(db, waveId);
  assertActive(w);
  const orders = await all(db,
    `SELECT o.id, o.number, o.status FROM orders o WHERE o.wave_id = ? AND o.status = 'picking'
       AND EXISTS (SELECT 1 FROM order_lines ol WHERE ol.order_id = o.id AND ol.picked_qty < ol.qty)`, waveId);
  if (orders.length) need(ctx, 'picking', 'approve');
  const reverted = [];
  for (const o of orders) {
    const lines = await all(db,
      `SELECT p.sku, ol.qty - ol.picked_qty AS missing, p.unit FROM order_lines ol JOIN products p ON p.id = ol.product_id
       WHERE ol.order_id = ? AND ol.picked_qty < ol.qty ORDER BY ol.id`, o.id);
    const what = lines.map((l) => `${l.sku} ${l.missing} ${l.unit}`).join(', ');
    await setOrderStatus(ctx, o.id, 'new', `Hullám lezárva hiánnyal (${w.number}), nem lett kiszedve: ${what}. A kiszedett tételek a rendelésnél maradnak.`, { wave_id: null });
    reverted.push(o.number);
  }
  const res = await run(db, `UPDATE waves SET status = 'completed', completed_at = ? WHERE id = ? AND status IN ('open', 'picking', 'picked')`, nowIso(), waveId);
  if (res.meta.changes !== 1) throw conflict('A hullám állapota közben megváltozott. Frissítsd az oldalt.');
  await audit(ctx, {
    module: 'picking', action: reverted.length ? 'approve' : 'edit', entity: 'wave', entityId: waveId,
    summary: reverted.length ? `${w.number} lezárva hiánnyal, vissza új állapotba: ${reverted.join(', ')}` : `${w.number} lezárva`,
    details: { reverted },
  });
  return { ok: true, reverted };
}

async function cancelWave(ctx, waveId, body) {
  const db = ctx.env.DB;
  const { reason } = validate(body, { reason: { type: 'str', required: true, max: 300 } });
  const w = await loadWave(db, waveId);
  assertActive(w);
  const orders = await all(db, "SELECT id, number, status FROM orders WHERE wave_id = ? AND status = 'picking' ORDER BY id", waveId);
  const ids = orders.map((o) => o.id);
  const packed = await first(db, "SELECT COUNT(*) AS n FROM orders WHERE wave_id = ? AND status <> 'picking'", waveId);
  const picks = ids.length ? await allIn(db, 'SELECT * FROM picks WHERE wave_id = ? AND order_id IN (?) ORDER BY id', ids, waveId) : [];
  await checkRestock(db, picks);

  // Mark the wave first: from here on allocate() ignores its picks and no one can confirm more.
  const res = await run(db, `UPDATE waves SET status = 'cancelled', completed_at = ?, note = TRIM(note || ' ' || ?) WHERE id = ? AND status IN ('open', 'picking', 'picked')`,
    nowIso(), `Megszakítva: ${reason}.${orders.length ? ` Rendelések: ${orders.map((o) => o.number).join(', ')}.` : ''}`, waveId);
  if (res.meta.changes !== 1) throw conflict('A hullám állapota közben megváltozott. Frissítsd az oldalt.');

  const restocked = await restockPicks(ctx, picks.filter((pk) => pk.picked_qty - pk.restocked_qty > 0), { refType: 'wave', refId: waveId, note: `${w.number} megszakítva` });
  if (ids.length) {
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      await run(db, `DELETE FROM picks WHERE wave_id = ? AND picked_qty = 0 AND order_id IN (${marks(chunk.length)})`, waveId, ...chunk);
    }
  }
  for (const o of orders) {
    const back = restocked.filter((r) => picks.some((pk) => pk.id === r.pickId && pk.order_id === o.id));
    const text = back.length ? ` Visszakönyvelve: ${back.map((b) => `${b.sku} ${b.qty} db (${b.code})`).join(', ')}.` : '';
    await setOrderStatus(ctx, o.id, 'new', `Hullám megszakítva (${w.number}): ${reason}.${text}`, { wave_id: null });
  }
  await audit(ctx, {
    module: 'picking', action: 'delete', entity: 'wave', entityId: waveId,
    summary: `${w.number} megszakítva: ${reason}`,
    details: { orders: orders.map((o) => o.number), restocked, packed_left: packed.n },
  });
  return { ok: true, orders: orders.length, restocked, packed: packed.n };
}

// ---------------------------------------------------------------- packing

async function packingOrder(ctx, id) {
  const db = ctx.env.DB;
  const o = await first(db,
    `SELECT o.*, pa.code AS partner_code, pa.name AS partner_name, c.name AS carrier_name, c.carrier_code,
            w.number AS wave_number, w.status AS wave_status, d.filename AS label_filename
     FROM orders o JOIN partners pa ON pa.id = o.partner_id LEFT JOIN partners c ON c.id = o.carrier_id
     LEFT JOIN waves w ON w.id = o.wave_id LEFT JOIN documents d ON d.id = o.label_document_id WHERE o.id = ?`, id);
  if (!o) throw notFound('A rendelés nem található.');
  const lines = await all(db,
    `SELECT ol.id, ol.product_id, ol.qty, ol.picked_qty, p.sku, p.name, p.ean, p.unit, p.weight_kg
     FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? ORDER BY ol.id`, id);
  const weight = lines.reduce((s, l) => s + (l.weight_kg || 0) * l.qty, 0);
  const code = o.carrier_code || '';
  return {
    id: o.id, number: o.number, external_number: o.external_number, status: o.status, priority: o.priority,
    partner: { id: o.partner_id, code: o.partner_code, name: o.partner_name },
    customer_name: o.customer_name, company: o.company, phone: o.phone, email: o.email,
    country: o.country, zip: o.zip, city: o.city, address: o.address, pickup_point_id: o.pickup_point_id,
    carrier: o.carrier_id ? { id: o.carrier_id, name: o.carrier_name, carrier_code: code, configured: code ? await isConfigured(ctx.env, code) : false } : null,
    carrier_service: o.carrier_service, cod_amount: o.cod_amount, currency: o.currency, note: o.note,
    wave: o.wave_id ? { id: o.wave_id, number: o.wave_number, status: o.wave_status } : null,
    pickup_id: o.pickup_id, package_count: o.package_count, weight_kg: o.weight_kg, tracking_number: o.tracking_number,
    tracking_url: o.tracking_number && code ? trackingUrl(code, o.tracking_number) : '',
    label: o.label_document_id ? { id: o.label_document_id, filename: o.label_filename } : null,
    packed_at: o.packed_at,
    lines,
    all_picked: lines.every((l) => l.picked_qty >= l.qty),
    tracking_required: TRACKED_CARRIERS.includes(code),
    suggested_weight_kg: weight ? Math.round(weight * 100) / 100 : null,
  };
}

async function packOrder(ctx, id, body) {
  const db = ctx.env.DB;
  const data = validate(body, {
    mode: { type: 'enum', values: ['label', 'manual'], default: 'manual' },
    package_count: { type: 'int', min: 1, max: 99, default: 1 },
    weight_kg: { type: 'num', min: 0, max: 5000, nullable: true },
    tracking_number: { type: 'str', max: 120, default: '' },
  });
  const o = await packingOrder(ctx, id);
  if (o.status === 'packed') throw conflict(`A(z) ${o.number} rendelés már be van csomagolva.`);
  if (o.status !== 'picking') throw conflict(`A(z) ${o.number} rendelés nem csomagolható, az állapota: ${orderLabel(o.status)}.`);
  if (!o.all_picked) {
    const miss = o.lines.filter((l) => l.picked_qty < l.qty).map((l) => `${l.sku} (${l.qty - l.picked_qty} db)`).join(', ');
    throw conflict(`A(z) ${o.number} rendelésből még nincs minden kiszedve: ${miss}.`);
  }
  const weight = data.weight_kg > 0 ? data.weight_kg : null;
  let text;
  let warning = '';
  if (data.mode === 'label') {
    if (!o.carrier) throw conflict('A rendeléshez nincs fuvarozó megadva, címke nem készíthető.');
    if (!o.carrier.configured) throw conflict(`A(z) ${o.carrier.name} futár API nincs beállítva. Add meg kézzel a nyomkövetési számot.`);
    if (o.tracking_number) throw conflict(`A rendeléshez már van nyomkövetési szám (${o.tracking_number}). Zárd le a csomagolást kézzel.`);
    // createLabel books the parcels and writes tracking number, label, package count and weight.
    const each = weight ? Math.round((weight / data.package_count) * 100) / 100 : null;
    const packages = Array.from({ length: data.package_count }, () => (each ? { weight_kg: each } : {}));
    let label = null;
    try {
      label = await createLabel(ctx, id, { packages });
    } catch (err) {
      // A 409 can come after the carrier booked the parcel (label not usable): the tracking number
      // is saved then, so the order is packed and the warning shown. Otherwise the client falls
      // back to a manual tracking number.
      const again = await first(db, 'SELECT tracking_number FROM orders WHERE id = ?', id);
      if (!again || !again.tracking_number) throw err;
      warning = err.message;
      label = { trackingNumber: again.tracking_number };
    }
    text = `Becsomagolva: ${data.package_count} csomag, ${warning ? 'a futárnál rögzítve' : 'címke elkészült'} (${label.trackingNumber})`;
    await setOrderStatus(ctx, id, 'packed', text);
  } else {
    const tracking = data.tracking_number.replace(/\s+/g, '') || o.tracking_number || '';
    if (o.tracking_required && !tracking) {
      throw badRequest('Add meg a nyomkövetési számot.', { tracking_number: 'Kötelező mező ennél a futárnál.' });
    }
    text = `Becsomagolva: ${data.package_count} csomag${tracking ? `, nyomkövetési szám: ${tracking}` : ''}`;
    await setOrderStatus(ctx, id, 'packed', text, { package_count: data.package_count, weight_kg: weight, tracking_number: tracking });
  }
  const closed = await autoCompleteWave(ctx, o.wave ? o.wave.id : null);
  await audit(ctx, { module: 'picking', action: 'edit', entity: 'order', entityId: id, summary: `${o.number}: ${text}` });
  return { ...(await packingOrder(ctx, id)), wave_completed: closed, warning };
}

async function unpackOrder(ctx, id, body) {
  const db = ctx.env.DB;
  const { reason } = validate(body, { reason: { type: 'str', required: true, max: 300 } });
  const o = await first(db, 'SELECT o.id, o.number, o.status, o.pickup_id, cp.number AS pickup_number FROM orders o LEFT JOIN carrier_pickups cp ON cp.id = o.pickup_id WHERE o.id = ?', id);
  if (!o) throw notFound('A rendelés nem található.');
  if (o.status !== 'packed') throw conflict(`Csak becsomagolt rendelés csomagolása vonható vissza (most: ${orderLabel(o.status)}).`);
  if (o.pickup_id) throw conflict(`A(z) ${o.number} rendelés már egy futárátvételhez tartozik (${o.pickup_number}). Előbb vedd ki onnan.`);
  await setOrderStatus(ctx, id, 'picking', `Csomagolás visszavonva: ${reason}`, { tracking_number: '', label_document_id: null, packed_at: null });
  await audit(ctx, { module: 'picking', action: 'edit', entity: 'order', entityId: id, summary: `${o.number}: csomagolás visszavonva (${reason})` });
  return packingOrder(ctx, id);
}

const READY_SQL = `
  SELECT o.id, o.number, o.external_number, o.priority, o.customer_name, o.city, o.cod_amount, o.created_at, o.wave_id,
         w.number AS wave_number, pa.code AS partner_code, c.name AS carrier_name, c.carrier_code,
         (SELECT COALESCE(SUM(qty), 0) FROM order_lines WHERE order_id = o.id) AS item_count,
         (SELECT COUNT(*) FROM order_lines WHERE order_id = o.id) AS line_count
  FROM orders o JOIN partners pa ON pa.id = o.partner_id LEFT JOIN partners c ON c.id = o.carrier_id LEFT JOIN waves w ON w.id = o.wave_id
  WHERE o.status = 'picking' AND NOT EXISTS (SELECT 1 FROM order_lines ol WHERE ol.order_id = o.id AND ol.picked_qty < ol.qty)`;

// ---------------------------------------------------------------- routes

export function register(r) {
  r.get('/api/picking/waves', async (ctx) => {
    const db = ctx.env.DB;
    const status = ctx.query.get('status') || 'active';
    const statuses = status === 'active' ? ACTIVE : status === 'all' ? [...ACTIVE, 'completed', 'cancelled'] : [status];
    if (!statuses.every((s) => STATUSES.wave[s])) throw badRequest('Ismeretlen állapot.');
    const limit = Math.min(Math.max(parseInt(ctx.query.get('limit') || '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(ctx.query.get('offset') || '0', 10) || 0, 0);
    const where = `w.status IN (${marks(statuses.length)})`;
    const total = (await first(db, `SELECT COUNT(*) AS n FROM waves w WHERE ${where}`, ...statuses)).n;
    const items = await all(db,
      `SELECT w.id, w.number, w.status, w.note, w.created_at, w.started_at, w.completed_at, u.name AS picker_name,
              (SELECT COUNT(DISTINCT order_id) FROM picks WHERE wave_id = w.id)
                + (SELECT COUNT(*) FROM orders o2 WHERE o2.wave_id = w.id AND NOT EXISTS (SELECT 1 FROM picks p2 WHERE p2.wave_id = w.id AND p2.order_id = o2.id)) AS order_count,
              (SELECT COUNT(*) FROM orders WHERE wave_id = w.id AND status = 'picking') AS open_orders,
              (SELECT COALESCE(SUM(qty), 0) FROM picks WHERE wave_id = w.id) AS qty,
              (SELECT COALESCE(SUM(picked_qty), 0) FROM picks WHERE wave_id = w.id) AS picked,
              (SELECT COALESCE(SUM(short_qty), 0) FROM picks WHERE wave_id = w.id) AS short
       FROM waves w LEFT JOIN users u ON u.id = w.picker_id WHERE ${where}
       ORDER BY CASE w.status WHEN 'picking' THEN 0 WHEN 'open' THEN 1 WHEN 'picked' THEN 2 ELSE 3 END, w.created_at DESC, w.id DESC
       LIMIT ? OFFSET ?`, ...statuses, limit, offset);
    const counts = Object.fromEntries((await all(db, 'SELECT status, COUNT(*) AS n FROM waves GROUP BY status')).map((x) => [x.status, x.n]));
    const ready = (await first(db, `SELECT COUNT(*) AS n FROM (${READY_SQL})`)).n;
    return { items, total, counts, ready_to_pack: ready };
  }, { perm: ['picking', 'view'] });

  r.post('/api/picking/waves', async (ctx) => createWave(ctx, await ctx.body()), { perm: ['picking', 'create'] });

  r.get('/api/picking/waves/:id', (ctx) => waveDetail(ctx.env.DB, idParam(ctx)), { perm: ['picking', 'view'] });

  r.patch('/api/picking/waves/:id', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const data = validate(await ctx.body(), { picker_id: { type: 'id', nullable: true }, note: { type: 'str', max: 500 } }, { partial: true });
    const w = await loadWave(db, id);
    assertActive(w);
    if (data.picker_id) {
      const u = await first(db, 'SELECT id FROM users WHERE id = ? AND active = 1', data.picker_id);
      if (!u) throw badRequest('Ismeretlen komissiós.', { picker_id: 'Válassz aktív felhasználót.' });
    }
    const keys = Object.keys(data);
    if (keys.length) {
      await run(db, `UPDATE waves SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => data[k]), id);
      await audit(ctx, { module: 'picking', action: 'edit', entity: 'wave', entityId: id, summary: `${w.number} módosítva`, details: data });
    }
    return waveDetail(db, id);
  }, { perm: ['picking', 'edit'] });

  r.post('/api/picking/waves/:id/start', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const w = await loadWave(db, id);
    assertActive(w);
    if (w.status === 'open') {
      await startWave(ctx, w);
      await refreshWaveStatus(db, id);
      await audit(ctx, { module: 'picking', action: 'edit', entity: 'wave', entityId: id, summary: `${w.number} kiszedés elindítva` });
    }
    return waveDetail(db, id);
  }, { perm: ['picking', 'edit'] });

  r.get('/api/picking/waves/:id/scan', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const code = (ctx.query.get('code') || '').trim();
    if (!code) throw badRequest('Nincs beolvasott kód.');
    await loadWave(db, id);
    const loc = await locationByCode(db, code);
    if (loc) {
      const open = await all(db, 'SELECT id FROM picks WHERE wave_id = ? AND location_id = ? AND qty - picked_qty - short_qty > 0 ORDER BY id', id, loc.id);
      return { kind: 'location', location: { id: loc.id, code: loc.code, kind: loc.kind }, pick_ids: open.map((x) => x.id) };
    }
    const products = await all(db, 'SELECT DISTINCT p.id, p.sku, p.name, p.ean, p.unit FROM picks pk JOIN products p ON p.id = pk.product_id WHERE pk.wave_id = ?', id);
    const product = products.find((p) => matchesProduct(p, code));
    if (product) {
      const open = await all(db, 'SELECT id FROM picks WHERE wave_id = ? AND product_id = ? AND qty - picked_qty - short_qty > 0 ORDER BY id', id, product.id);
      return { kind: 'product', product, pick_ids: open.map((x) => x.id) };
    }
    const order = await first(db,
      `SELECT id, number, status FROM orders WHERE (number = ? COLLATE NOCASE OR (external_number <> '' AND external_number = ?))
         AND (wave_id = ? OR id IN (SELECT order_id FROM picks WHERE wave_id = ?)) LIMIT 1`, code, code, id, id);
    if (order) return { kind: 'order', order };
    return { kind: 'unknown', message: `Ismeretlen kód: ${code}. Nem raktárhely, és ilyen termék vagy rendelés sincs ebben a hullámban.` };
  }, { perm: ['picking', 'view'] });

  r.post('/api/picking/waves/:id/confirm', async (ctx) => confirmPick(ctx, idParam(ctx), await ctx.body()), { perm: ['picking', 'edit'] });
  r.post('/api/picking/waves/:id/short', async (ctx) => shortPick(ctx, idParam(ctx), await ctx.body()), { perm: ['picking', 'edit'] });
  r.post('/api/picking/waves/:id/complete', (ctx) => completeWave(ctx, idParam(ctx)), { perm: ['picking', 'edit'] });
  r.post('/api/picking/waves/:id/cancel', async (ctx) => cancelWave(ctx, idParam(ctx), await ctx.body()), { perm: ['picking', 'delete'] });

  r.get('/api/picking/packing', async (ctx) => {
    const db = ctx.env.DB;
    const waveId = ctx.query.get('wave_id') ? Number(ctx.query.get('wave_id')) : null;
    const ready = await all(db, `${READY_SQL} AND (? IS NULL OR o.wave_id = ?) ORDER BY CASE o.priority WHEN 'express' THEN 0 ELSE 1 END, o.created_at, o.id LIMIT 200`, waveId, waveId);
    const picking = await first(db,
      `SELECT COUNT(*) AS n FROM orders o WHERE o.status = 'picking' AND (? IS NULL OR o.wave_id = ?)
         AND EXISTS (SELECT 1 FROM order_lines ol WHERE ol.order_id = o.id AND ol.picked_qty < ol.qty)`, waveId, waveId);
    const since = budapestDayStartIso(budapestDate());
    const packed = await all(db,
      `SELECT o.id, o.number, o.customer_name, o.tracking_number, o.label_document_id, o.package_count, o.packed_at, c.name AS carrier_name, c.carrier_code
       FROM orders o LEFT JOIN partners c ON c.id = o.carrier_id
       WHERE o.status = 'packed' AND o.packed_at >= ? AND (? IS NULL OR o.wave_id = ?) ORDER BY o.packed_at DESC LIMIT 30`, since, waveId, waveId);
    const wave = waveId ? await first(db, 'SELECT id, number, status FROM waves WHERE id = ?', waveId) : null;
    return { ready, packed, still_picking: picking.n, wave };
  }, { perm: ['picking', 'view'] });

  r.get('/api/picking/packing/lookup', async (ctx) => {
    const db = ctx.env.DB;
    const code = (ctx.query.get('code') || '').trim();
    if (!code) throw badRequest('Nincs beolvasott kód.');
    const waveId = ctx.query.get('wave_id') ? Number(ctx.query.get('wave_id')) : null;
    let o = await first(db,
      `SELECT id FROM orders WHERE number = ? COLLATE NOCASE OR tracking_number = ? OR (external_number <> '' AND external_number = ?)
       ORDER BY CASE status WHEN 'picking' THEN 0 WHEN 'packed' THEN 1 ELSE 2 END, id DESC LIMIT 1`, code, code, code);
    if (!o) {
      // A product scan finds the next order ready for packing that contains it (single-item orders first).
      const candidates = await all(db,
        `SELECT o.id, p.sku, p.ean, (SELECT COUNT(*) FROM order_lines x WHERE x.order_id = o.id) AS lines
         FROM orders o JOIN order_lines ol ON ol.order_id = o.id JOIN products p ON p.id = ol.product_id
         WHERE o.status = 'picking' AND (? IS NULL OR o.wave_id = ?)
           AND NOT EXISTS (SELECT 1 FROM order_lines y WHERE y.order_id = o.id AND y.picked_qty < y.qty)
         ORDER BY lines, CASE o.priority WHEN 'express' THEN 0 ELSE 1 END, o.created_at, o.id LIMIT 500`, waveId, waveId);
      const hit = candidates.find((c) => matchesProduct(c, code));
      if (hit) o = { id: hit.id };
    }
    if (!o) throw notFound(`Nincs csomagolható rendelés ehhez a kódhoz: ${code}.`);
    return packingOrder(ctx, o.id);
  }, { perm: ['picking', 'view'] });

  r.get('/api/picking/orders/:id', (ctx) => packingOrder(ctx, idParam(ctx)), { perm: ['picking', 'view'] });
  r.post('/api/picking/orders/:id/pack', async (ctx) => packOrder(ctx, idParam(ctx), await ctx.body()), { perm: ['picking', 'edit'] });
  r.post('/api/picking/orders/:id/unpack', async (ctx) => unpackOrder(ctx, idParam(ctx), await ctx.body()), { perm: ['picking', 'edit'] });
}
