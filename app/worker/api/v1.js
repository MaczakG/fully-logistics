// Partner REST API (/api/v1). Every request carries a client partner's API key; ctx.apiPartner is
// that partner, and every query below is limited to its own data (partner_id = ctx.apiPartner.id).
// Documentation for the partners' developers: docs/partner-api.md, served at GET /api/v1/docs.
//
//   GET  /api/v1/me                       the partner of the key
//   GET  /api/v1/products                 products (cursor pagination by SKU)
//   GET  /api/v1/products/:sku            one product
//   PUT  /api/v1/products/:sku            create or update a product
//   GET  /api/v1/stock                    stock per SKU: on hand, reserved, blocked, available
//   GET  /api/v1/stock/:sku               one SKU with lots and expiry dates
//   POST /api/v1/orders                   new order (external_id makes it idempotent)
//   GET  /api/v1/orders                   orders (status, updated_since, cursor pagination)
//   GET  /api/v1/orders/:ref              one order by our number or the partner's external_id
//   POST /api/v1/orders/:ref/cancel       cancel while new or on hold
//   POST /api/v1/inbounds                 expected delivery (ASN), external_ref makes it idempotent
//   GET  /api/v1/inbounds                 inbounds (status, updated_since, cursor pagination)
//   GET  /api/v1/inbounds/:ref            one inbound by our number or external_ref
//   GET  /api/v1/docs                     the documentation as HTML (public, no key)

import { all, first, marks, run } from '../lib/db.js';
import { badRequest, conflict, json, notFound, page } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { availability } from '../lib/stock.js';
import { setOrderStatus } from '../lib/orders.js';
import { createOrder, ORDER_FIELDS, LINE_FIELDS } from '../lib/order-create.js';
import { createInbound, INBOUND_FIELDS, INBOUND_LINE_FIELDS } from '../lib/inbound-create.js';
import { STATUSES } from '../lib/constants.js';
import { nowIso } from '../lib/time.js';
import {
  ORDER_SELECT, RATE_LIMIT, decodeCursor, encodeCursor, inboundsOut, logWrite, onlyKnown, optionalBody, ordersOut, productOut, route, sinceParam,
  skuParam, statusParam,
} from './common.js';
import { docsMarkdown, docsPage } from './docs.js';

const pid = (ctx) => ctx.apiPartner.id;
const isUnique = (err) => /UNIQUE constraint failed/i.test(String((err && err.message) || ''));

// Fields a partner may send. partner_id, source and our internal ids are never taken from the body.
const ORDER_KEYS = Object.keys(ORDER_FIELDS).filter((k) => !['partner_id', 'source', 'carrier_id'].includes(k)).concat('lines');
const ORDER_LINE_KEYS = Object.keys(LINE_FIELDS).filter((k) => k !== 'product_id');
const INBOUND_KEYS = Object.keys(INBOUND_FIELDS).filter((k) => !['partner_id', 'source', 'supplier_id'].includes(k)).concat('lines');
const INBOUND_LINE_KEYS = Object.keys(INBOUND_LINE_FIELDS).filter((k) => k !== 'product_id');

const PRODUCT_FIELDS = {
  name: { type: 'str', min: 1, max: 200 },
  ean: { type: 'str', max: 64 },
  unit: { type: 'str', min: 1, max: 20 },
  weight_kg: { type: 'num', min: 0, max: 100000, nullable: true },
  width_cm: { type: 'num', min: 0, max: 10000, nullable: true },
  depth_cm: { type: 'num', min: 0, max: 10000, nullable: true },
  height_cm: { type: 'num', min: 0, max: 10000, nullable: true },
  min_stock: { type: 'int', min: 0, max: 100000000 },
};

function checkLines(body, allowed) {
  if (!Array.isArray(body.lines)) return;
  body.lines.forEach((l, i) => {
    if (!l || typeof l !== 'object' || Array.isArray(l)) throw badRequest('Ellenőrizd a megjelölt tételeket.', { [`lines.${i}`]: 'Objektumot várunk.' });
    onlyKnown(l, allowed, `lines.${i}.`);
    if (l.sku === undefined || l.sku === null || String(l.sku).trim() === '') throw badRequest('Ellenőrizd a megjelölt tételeket.', { [`lines.${i}.sku`]: 'Kötelező mező.' });
  });
}

function requireRef(body, key) {
  if (body[key] === undefined || body[key] === null || String(body[key]).trim() === '') {
    throw badRequest('Ellenőrizd a megjelölt mezőket.', { [key]: 'Kötelező mező: ezzel az azonosítóval ismerjük fel az ismételt beküldést.' });
  }
}

// ---------------------------------------------------------------- lookups (always within the partner)

async function orderRow(ctx, ref) {
  const r = String(ref || '').trim();
  const row = await first(ctx.env.DB,
    `${ORDER_SELECT} WHERE o.partner_id = ? AND (o.number = ? OR o.external_id = ?)
     ORDER BY CASE WHEN o.number = ? THEN 0 WHEN o.source = 'api' THEN 1 ELSE 2 END, o.id LIMIT 1`, pid(ctx), r, r, r);
  if (!row) throw notFound(`Nincs ilyen rendelés: ${r}.`);
  return row;
}

async function orderById(ctx, id) {
  const row = await first(ctx.env.DB, `${ORDER_SELECT} WHERE o.id = ? AND o.partner_id = ?`, id, pid(ctx));
  return (await ordersOut(ctx.env.DB, [row]))[0];
}

async function inboundRow(ctx, ref) {
  const r = String(ref || '').trim();
  const row = await first(ctx.env.DB,
    `SELECT * FROM inbounds WHERE partner_id = ? AND (number = ? OR external_ref = ?)
     ORDER BY CASE WHEN number = ? THEN 0 WHEN source = 'api' THEN 1 ELSE 2 END, id LIMIT 1`, pid(ctx), r, r, r);
  if (!row) throw notFound(`Nincs ilyen betárolás: ${r}.`);
  return row;
}

async function productRow(ctx, sku) {
  return first(ctx.env.DB, 'SELECT * FROM products WHERE partner_id = ? AND sku = ?', pid(ctx), sku);
}

// ---------------------------------------------------------------- products

async function listProducts(ctx) {
  const db = ctx.env.DB;
  const { limit } = page(ctx.query, 50, 200);
  const cursor = decodeCursor(ctx.query.get('cursor'));
  const where = ['partner_id = ?'];
  const args = [pid(ctx)];
  const skus = (ctx.query.get('sku') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
  if (skus.length) {
    where.push(`sku IN (${marks(skus.length)})`);
    args.push(...skus);
  }
  const active = ctx.query.get('active');
  if (active === '0' || active === '1') {
    where.push('active = ?');
    args.push(Number(active));
  }
  const since = sinceParam(ctx.query);
  if (since) {
    where.push('updated_at >= ?');
    args.push(since);
  }
  const total = (await first(db, `SELECT COUNT(*) AS n FROM products WHERE ${where.join(' AND ')}`, ...args)).n;
  if (cursor) {
    if (typeof cursor.s !== 'string') throw badRequest('Érvénytelen cursor.', { cursor: 'Érvénytelen érték.' });
    where.push('sku > ?');
    args.push(cursor.s);
  }
  const rows = await all(db, `SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY sku LIMIT ?`, ...args, limit + 1);
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items: items.map(productOut), total, next_cursor: more ? encodeCursor({ s: items[items.length - 1].sku }) : null };
}

async function getProduct(ctx) {
  const sku = skuParam(ctx.params.sku);
  const p = await productRow(ctx, sku);
  if (!p) throw notFound(`Nincs ilyen cikkszámú termék: ${sku}.`);
  return productOut(p);
}

async function putProduct(ctx) {
  const db = ctx.env.DB;
  const sku = skuParam(ctx.params.sku);
  const body = await ctx.body();
  onlyKnown(body, [...Object.keys(PRODUCT_FIELDS), 'sku']);
  if (body.sku !== undefined && String(body.sku).trim() !== sku) {
    throw badRequest('A törzsben lévő cikkszám eltér az URL-ben lévőtől.', { sku: 'Eltér az URL-ben lévő cikkszámtól.' });
  }
  const data = validate(body, PRODUCT_FIELDS, { partial: true });
  if (data.min_stock === null) throw badRequest('Ellenőrizd a megjelölt mezőket.', { min_stock: 'Nem lehet üres, add meg a 0-t.' });
  if (data.ean !== undefined && !/^[0-9A-Za-z._-]*$/.test(data.ean)) throw badRequest('Ellenőrizd a megjelölt mezőket.', { ean: 'Csak számjegy, betű, pont, kötőjel és aláhúzás lehet benne.' });

  let existing = await productRow(ctx, sku);
  if (!existing) {
    if (!data.name) throw badRequest('Ellenőrizd a megjelölt mezőket.', { name: 'Kötelező mező új terméknél.' });
    const at = nowIso();
    try {
      const res = await run(db,
        `INSERT INTO products (partner_id, sku, name, ean, unit, weight_kg, width_cm, depth_cm, height_cm, min_stock, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        pid(ctx), sku, data.name, data.ean ?? '', data.unit ?? 'db', data.weight_kg ?? null, data.width_cm ?? null, data.depth_cm ?? null,
        data.height_cm ?? null, data.min_stock ?? 0, at, at);
      const id = res.meta.last_row_id;
      await audit(ctx, { module: 'stock', action: 'create', entity: 'product', entityId: id, summary: `${sku} cikk létrehozva az API-n` });
      await logWrite(ctx, { action: 'products.create', status: 201, message: sku, refType: 'product', refId: id });
      return json(productOut(await productRow(ctx, sku)), 201);
    } catch (err) {
      if (!isUnique(err)) throw err;
      existing = await productRow(ctx, sku); // created by a parallel request: update it instead
    }
  }
  const changes = {};
  for (const [k, v] of Object.entries(data)) if (existing[k] !== v) changes[k] = v;
  if (Object.keys(changes).length) {
    const keys = Object.keys(changes);
    await run(db, `UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND partner_id = ?`,
      ...keys.map((k) => changes[k]), nowIso(), existing.id, pid(ctx));
    await audit(ctx, { module: 'stock', action: 'edit', entity: 'product', entityId: existing.id, summary: `${sku} cikk módosítva az API-n`, details: { changes } });
  }
  await logWrite(ctx, { action: 'products.update', status: 200, message: `${sku}${Object.keys(changes).length ? `: ${Object.keys(changes).join(', ')}` : ': nincs változás'}`, refType: 'product', refId: existing.id });
  return productOut(await productRow(ctx, sku));
}

// ---------------------------------------------------------------- stock

const stockOut = (p, a) => ({
  sku: p.sku,
  name: p.name,
  on_hand: a ? a.onHand : 0,
  reserved: a ? a.reserved : 0,
  blocked: a ? a.blocked : 0,
  available: a ? a.available : 0,
});

// Active products and inactive ones that still have stock.
const STOCK_PRODUCTS = `SELECT p.id, p.sku, p.name FROM products p
  WHERE p.partner_id = ? AND (p.active = 1 OR EXISTS (SELECT 1 FROM stock s WHERE s.product_id = p.id AND s.qty > 0))`;

async function listStock(ctx) {
  const db = ctx.env.DB;
  const { limit } = page(ctx.query, 100, 500);
  const cursor = decodeCursor(ctx.query.get('cursor'));
  let sql = STOCK_PRODUCTS;
  const args = [pid(ctx)];
  const skus = (ctx.query.get('sku') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
  if (skus.length) {
    sql += ` AND p.sku IN (${marks(skus.length)})`;
    args.push(...skus);
  }
  const total = (await first(db, `SELECT COUNT(*) AS n FROM (${sql})`, ...args)).n;
  if (cursor) {
    if (typeof cursor.s !== 'string') throw badRequest('Érvénytelen cursor.', { cursor: 'Érvénytelen érték.' });
    sql += ' AND p.sku > ?';
    args.push(cursor.s);
  }
  const rows = await all(db, `${sql} ORDER BY p.sku LIMIT ?`, ...args, limit + 1);
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  const avail = await availability(db, items.map((p) => p.id));
  return { items: items.map((p) => stockOut(p, avail[p.id])), total, next_cursor: more ? encodeCursor({ s: items[items.length - 1].sku }) : null };
}

async function getStock(ctx) {
  const db = ctx.env.DB;
  const sku = skuParam(ctx.params.sku);
  const p = await productRow(ctx, sku);
  if (!p) throw notFound(`Nincs ilyen cikkszámú termék: ${sku}.`);
  const avail = await availability(db, [p.id]);
  const lots = await all(db,
    `SELECT s.lot, s.expiry, SUM(s.qty) AS qty, SUM(CASE WHEN l.kind = 'quarantine' THEN s.qty ELSE 0 END) AS blocked
     FROM stock s JOIN locations l ON l.id = s.location_id JOIN products p ON p.id = s.product_id
     WHERE s.product_id = ? AND p.partner_id = ? AND s.qty > 0
     GROUP BY s.lot, s.expiry ORDER BY CASE WHEN s.expiry = '' THEN 1 ELSE 0 END, s.expiry, s.lot`, p.id, pid(ctx));
  return { ...stockOut(p, avail[p.id]), lots: lots.map((l) => ({ lot: l.lot, expiry: l.expiry, qty: l.qty, blocked: l.blocked })) };
}

// ---------------------------------------------------------------- orders

async function postOrder(ctx) {
  const body = await ctx.body();
  onlyKnown(body, ORDER_KEYS);
  checkLines(body, ORDER_LINE_KEYS);
  requireRef(body, 'external_id');
  if (body.ordered_at !== undefined && body.ordered_at !== null && body.ordered_at !== '' && Number.isNaN(Date.parse(body.ordered_at))) {
    throw badRequest('Ellenőrizd a megjelölt mezőket.', { ordered_at: 'Dátum és időpont ISO 8601 formátumban (például 2026-10-16T08:00:00Z).' });
  }
  const input = {
    ...body,
    ordered_at: body.ordered_at ? new Date(body.ordered_at).toISOString() : null,
    partner_id: pid(ctx),
    source: 'api',
    lines: Array.isArray(body.lines) ? body.lines.map((l) => ({ sku: l.sku, qty: l.qty, external_line_id: l.external_line_id })) : body.lines,
  };
  let r;
  try {
    r = await createOrder(ctx, input);
  } catch (err) {
    if (!isUnique(err)) throw err;
    r = await createOrder(ctx, input); // a parallel request created it a moment ago
  }
  await logWrite(ctx, { action: 'orders.create', status: r.duplicate ? 200 : 201, message: `${r.number}${r.duplicate ? ' (már létezett)' : ''}`, refType: 'order', refId: r.id });
  return json(await orderById(ctx, r.id), r.duplicate ? 200 : 201);
}

async function listOrders(ctx) {
  const db = ctx.env.DB;
  const { limit } = page(ctx.query, 50, 200);
  const cursor = decodeCursor(ctx.query.get('cursor'));
  const where = ['o.partner_id = ?'];
  const args = [pid(ctx)];
  const statuses = statusParam(ctx.query, 'order');
  if (statuses.length) {
    where.push(`o.status IN (${marks(statuses.length)})`);
    args.push(...statuses);
  }
  const since = sinceParam(ctx.query);
  if (since) {
    where.push('o.updated_at >= ?');
    args.push(since);
  }
  const total = (await first(db, `SELECT COUNT(*) AS n FROM orders o WHERE ${where.join(' AND ')}`, ...args)).n;
  if (cursor) {
    if (typeof cursor.u !== 'string' || !Number.isInteger(cursor.i)) throw badRequest('Érvénytelen cursor.', { cursor: 'Érvénytelen érték.' });
    where.push('(o.updated_at > ? OR (o.updated_at = ? AND o.id > ?))');
    args.push(cursor.u, cursor.u, cursor.i);
  }
  const rows = await all(db, `${ORDER_SELECT} WHERE ${where.join(' AND ')} ORDER BY o.updated_at, o.id LIMIT ?`, ...args, limit + 1);
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items: await ordersOut(db, items), total, next_cursor: more ? encodeCursor({ u: last.updated_at, i: last.id }) : null };
}

async function getOrder(ctx) {
  const row = await orderRow(ctx, ctx.params.ref);
  return (await ordersOut(ctx.env.DB, [row]))[0];
}

async function cancelOrder(ctx) {
  const body = await optionalBody(ctx);
  onlyKnown(body, ['reason']);
  const { reason = '' } = validate(body, { reason: { type: 'str', max: 300, default: '' } });
  const order = await orderRow(ctx, ctx.params.ref);
  if (order.status !== 'cancelled') {
    const st = STATUSES.order[order.status];
    if (!['new', 'hold'].includes(order.status) || order.wave_id) {
      const why = order.wave_id && ['new', 'hold'].includes(order.status) ? 'már komissiós hullámba került' : `„${st ? st.label : order.status}” állapotú`;
      throw conflict(`A(z) ${order.number} rendelés ${why}, ezért az API-n már nem sztornózható. Ha mégis le kell állítani, keresd az ügyfélszolgálatunkat.`);
    }
    await setOrderStatus(ctx, order.id, 'cancelled', reason ? `Sztornózva az API-n: ${reason}` : 'Sztornózva az API-n');
    await audit(ctx, { module: 'orders', action: 'delete', entity: 'order', entityId: order.id, summary: `${order.number} sztornózva az API-n${reason ? `: ${reason}` : ''}` });
  }
  await logWrite(ctx, { action: 'orders.cancel', status: 200, message: `${order.number}${order.status === 'cancelled' ? ' (már sztornózva volt)' : ''}`, refType: 'order', refId: order.id });
  return orderById(ctx, order.id);
}

// ---------------------------------------------------------------- inbounds

async function postInbound(ctx) {
  const body = await ctx.body();
  onlyKnown(body, INBOUND_KEYS);
  checkLines(body, INBOUND_LINE_KEYS);
  requireRef(body, 'external_ref');
  const input = {
    ...body,
    partner_id: pid(ctx),
    source: 'api',
    supplier_id: null,
  };
  let r;
  try {
    r = await createInbound(ctx, input);
  } catch (err) {
    if (!isUnique(err)) throw err;
    r = await createInbound(ctx, input);
  }
  await logWrite(ctx, { action: 'inbounds.create', status: r.duplicate ? 200 : 201, message: `${r.number}${r.duplicate ? ' (már létezett)' : ''}`, refType: 'inbound', refId: r.id });
  const row = await first(ctx.env.DB, 'SELECT * FROM inbounds WHERE id = ? AND partner_id = ?', r.id, pid(ctx));
  return json((await inboundsOut(ctx.env.DB, [row]))[0], r.duplicate ? 200 : 201);
}

async function listInbounds(ctx) {
  const db = ctx.env.DB;
  const { limit } = page(ctx.query, 50, 200);
  const cursor = decodeCursor(ctx.query.get('cursor'));
  const where = ['partner_id = ?'];
  const args = [pid(ctx)];
  const statuses = statusParam(ctx.query, 'inbound');
  if (statuses.length) {
    where.push(`status IN (${marks(statuses.length)})`);
    args.push(...statuses);
  }
  const since = sinceParam(ctx.query);
  if (since) {
    where.push('updated_at >= ?');
    args.push(since);
  }
  const total = (await first(db, `SELECT COUNT(*) AS n FROM inbounds WHERE ${where.join(' AND ')}`, ...args)).n;
  if (cursor) {
    if (typeof cursor.u !== 'string' || !Number.isInteger(cursor.i)) throw badRequest('Érvénytelen cursor.', { cursor: 'Érvénytelen érték.' });
    where.push('(updated_at > ? OR (updated_at = ? AND id > ?))');
    args.push(cursor.u, cursor.u, cursor.i);
  }
  const rows = await all(db, `SELECT * FROM inbounds WHERE ${where.join(' AND ')} ORDER BY updated_at, id LIMIT ?`, ...args, limit + 1);
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items: await inboundsOut(db, items), total, next_cursor: more ? encodeCursor({ u: last.updated_at, i: last.id }) : null };
}

async function getInbound(ctx) {
  const row = await inboundRow(ctx, ctx.params.ref);
  return (await inboundsOut(ctx.env.DB, [row]))[0];
}

// ---------------------------------------------------------------- registration

export function registerApi(router) {
  route(router, 'get', '/api/v1/docs', () => docsPage(), { public: true });
  route(router, 'get', '/api/v1/docs.md', () => docsMarkdown(), { public: true });

  route(router, 'get', '/api/v1/me', (ctx) => ({
    partner: { code: ctx.apiPartner.code, name: ctx.apiPartner.name },
    rate_limit: { per_minute: RATE_LIMIT },
  }));

  route(router, 'get', '/api/v1/products', listProducts);
  route(router, 'get', '/api/v1/products/:sku', getProduct);
  route(router, 'put', '/api/v1/products/:sku', putProduct, { write: 'products.upsert' });

  route(router, 'get', '/api/v1/stock', listStock);
  route(router, 'get', '/api/v1/stock/:sku', getStock);

  route(router, 'post', '/api/v1/orders', postOrder, { write: 'orders.create' });
  route(router, 'get', '/api/v1/orders', listOrders);
  route(router, 'get', '/api/v1/orders/:ref', getOrder);
  route(router, 'post', '/api/v1/orders/:ref/cancel', cancelOrder, { write: 'orders.cancel' });

  route(router, 'post', '/api/v1/inbounds', postInbound, { write: 'inbounds.create' });
  route(router, 'get', '/api/v1/inbounds', listInbounds);
  route(router, 'get', '/api/v1/inbounds/:ref', getInbound);

  return router;
}
