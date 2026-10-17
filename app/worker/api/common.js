// Shared pieces of the partner REST API: the route wrapper (rate limit, JSON, error format, logging
// of writes), cursors, strict body checks and the JSON shapes of products, orders and inbounds.

import { all, first, marks, run } from '../lib/db.js';
import { HttpError, badRequest, errorResponse, json } from '../lib/http.js';
import { integrationLog } from '../lib/audit.js';
import { STATUSES } from '../lib/constants.js';
import { trackingUrl } from '../integrations/couriers/index.js';

export const RATE_LIMIT = 120; // requests per minute per API key

// ---------------------------------------------------------------- rate limit

// Fixed one minute windows counted in D1 (one UPSERT per request). Throws 429 above the limit.
export async function rateLimit(ctx) {
  const db = ctx.env.DB;
  const keyId = ctx.apiPartner.keyId;
  const now = Date.now();
  const bucket = Math.floor(now / 60000);
  const row = await first(db,
    `INSERT INTO api_rate_limits (key_id, bucket, count) VALUES (?, ?, 1)
     ON CONFLICT (key_id, bucket) DO UPDATE SET count = count + 1 RETURNING count`, keyId, bucket);
  if (row.count === 1) await run(db, 'DELETE FROM api_rate_limits WHERE key_id = ? AND bucket < ?', keyId, bucket - 1);
  const reset = (bucket + 1) * 60;
  const info = { limit: RATE_LIMIT, remaining: Math.max(RATE_LIMIT - row.count, 0), reset, retryAfter: Math.max(Math.ceil(reset - now / 1000), 1) };
  if (row.count > RATE_LIMIT) {
    const err = new HttpError(429, `Túl sok kérés: API kulcsonként percenként legfeljebb ${RATE_LIMIT} kérés küldhető. Próbáld újra ${info.retryAfter} másodperc múlva.`, 'rate_limited');
    err.rateInfo = info;
    throw err;
  }
  return info;
}

function limitHeaders(res, info) {
  res.headers.set('x-ratelimit-limit', String(info.limit));
  res.headers.set('x-ratelimit-remaining', String(info.remaining));
  res.headers.set('x-ratelimit-reset', String(info.reset));
}

// Logs a write call of the partner (system "api", direction "in").
export function logWrite(ctx, { action, ok = true, status = 200, message = '', refType = '', refId = null }) {
  return integrationLog(ctx.env, { system: 'api', direction: 'in', partnerId: ctx.apiPartner ? ctx.apiPartner.id : null, action, ok, status, message, refType, refId });
}

// Registers a route. Every partner call is rate limited; failed writes are logged here, successful
// ones by the handler (it knows the record). public: no API key needed (documentation).
export function route(router, method, path, handler, { write = null, public: isPublic = false } = {}) {
  router[method](path, async (ctx) => {
    let info = null;
    try {
      if (!isPublic) info = await rateLimit(ctx);
      const out = await handler(ctx);
      const res = out instanceof Response ? out : json(out ?? { ok: true });
      if (info) limitHeaders(res, info);
      return res;
    } catch (err) {
      const res = errorResponse(err);
      const limit = info || err.rateInfo;
      if (limit) limitHeaders(res, limit);
      if (err.rateInfo) res.headers.set('retry-after', String(err.rateInfo.retryAfter));
      if (write && err.status !== 429) {
        const fields = err.fields ? ` ${Object.entries(err.fields).map(([k, v]) => `${k}: ${v}`).join('; ')}` : '';
        try {
          await logWrite(ctx, { action: write, ok: false, status: res.status, message: `${err.message}${fields}`.slice(0, 1000) });
        } catch (e) {
          console.error('api log failed', e && e.message);
        }
      }
      return res;
    }
  }, { public: isPublic });
}

// ---------------------------------------------------------------- request helpers

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeCursor(value) {
  const bytes = enc.encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(text) {
  if (!text) return null;
  try {
    const b64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const value = JSON.parse(dec.decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
    if (value && typeof value === 'object') return value;
  } catch { /* fall through */ }
  throw badRequest('Érvénytelen cursor. Az előző válasz next_cursor értékét add meg változtatás nélkül.', { cursor: 'Érvénytelen érték.' });
}

// ?updated_since=2026-10-16T08:00:00Z -> ISO string comparable with the stored timestamps.
export function sinceParam(query, name = 'updated_since') {
  const v = query.get(name);
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw badRequest('Ellenőrizd a megjelölt mezőket.', { [name]: 'Dátum és időpont ISO 8601 formátumban (például 2026-10-16T08:00:00Z).' });
  return new Date(t).toISOString();
}

// ?status=new,hold -> ['new', 'hold'], each checked against the known statuses.
export function statusParam(query, kind) {
  const v = query.get('status');
  if (!v) return [];
  const list = v.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((s) => !STATUSES[kind][s]);
  if (bad.length) throw badRequest('Ellenőrizd a megjelölt mezőket.', { status: `Ismeretlen állapot: ${bad.join(', ')}. Lehetséges: ${Object.keys(STATUSES[kind]).join(', ')}.` });
  return list;
}

// Strict bodies: an unknown field is usually a typo, so it is refused instead of ignored.
export function onlyKnown(body, allowed, prefix = '') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) {
    throw badRequest(`Ismeretlen mező: ${extra.map((k) => prefix + k).join(', ')}.`, Object.fromEntries(extra.map((k) => [prefix + k, 'Ismeretlen mező.'])));
  }
}

// A SKU from the URL path.
export function skuParam(value) {
  const sku = String(value || '').trim();
  if (!sku || sku.length > 120 || /[\u0000-\u001f\u007f]/.test(sku)) {
    throw badRequest('Érvénytelen cikkszám az URL-ben (1 és 120 karakter között, vezérlőkarakter nélkül).', { sku: 'Érvénytelen cikkszám.' });
  }
  return sku;
}

// Reads an optional JSON body (cancel): no body is fine, a body must be JSON.
export async function optionalBody(ctx) {
  const type = ctx.req.headers.get('content-type') || '';
  const length = ctx.req.headers.get('content-length');
  if (!type && (!length || length === '0')) return {};
  if (!type.includes('application/json')) {
    const text = await ctx.req.text();
    if (!text.trim()) return {};
  }
  return ctx.body();
}

// ---------------------------------------------------------------- output shapes

export const productOut = (p) => ({
  sku: p.sku,
  name: p.name,
  ean: p.ean,
  unit: p.unit,
  weight_kg: p.weight_kg,
  width_cm: p.width_cm,
  depth_cm: p.depth_cm,
  height_cm: p.height_cm,
  min_stock: p.min_stock,
  active: !!p.active,
  created_at: p.created_at,
  updated_at: p.updated_at,
});

export const ORDER_SELECT = `SELECT o.*, c.carrier_code AS carrier_partner_code, c.name AS carrier_partner_name
  FROM orders o LEFT JOIN partners c ON c.id = o.carrier_id`;

// Orders (rows of ORDER_SELECT) with their lines, in the API shape.
export async function ordersOut(db, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const lines = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    lines.push(...await all(db,
      `SELECT ol.order_id, ol.qty, ol.picked_qty, ol.external_line_id, p.sku, p.name
       FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id IN (${marks(chunk.length)}) ORDER BY ol.id`, ...chunk));
  }
  const out = [];
  for (const o of rows) {
    const code = o.carrier_partner_code || '';
    const first = String(o.tracking_number || '').split(/[\s,;]+/).filter(Boolean)[0] || '';
    let url = '';
    if (code && first) {
      try {
        url = (await trackingUrl(code, first)) || '';
      } catch {
        url = '';
      }
    }
    out.push({
      number: o.number,
      external_id: o.external_id,
      external_number: o.external_number,
      source: o.source,
      status: o.status,
      status_label: STATUSES.order[o.status] ? STATUSES.order[o.status].label : o.status,
      priority: o.priority,
      customer_name: o.customer_name,
      company: o.company,
      email: o.email,
      phone: o.phone,
      country: o.country,
      zip: o.zip,
      city: o.city,
      address: o.address,
      pickup_point_id: o.pickup_point_id,
      carrier_code: code,
      carrier_name: o.carrier_partner_name || '',
      carrier_service: o.carrier_service,
      cod_amount: o.cod_amount,
      currency: o.currency,
      note: o.note,
      package_count: o.package_count,
      weight_kg: o.weight_kg,
      tracking_number: o.tracking_number,
      tracking_url: url,
      ordered_at: o.ordered_at,
      created_at: o.created_at,
      updated_at: o.updated_at,
      packed_at: o.packed_at,
      shipped_at: o.shipped_at,
      delivered_at: o.delivered_at,
      cancelled_at: o.cancelled_at,
      lines: lines.filter((l) => l.order_id === o.id).map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, picked_qty: l.picked_qty, external_line_id: l.external_line_id })),
    });
  }
  return out;
}

export async function inboundsOut(db, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const lines = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    lines.push(...await all(db,
      `SELECT il.inbound_id, il.expected_qty, il.received_qty, il.damaged_qty, il.lot, il.expiry, p.sku, p.name
       FROM inbound_lines il JOIN products p ON p.id = il.product_id WHERE il.inbound_id IN (${marks(chunk.length)}) ORDER BY il.id`, ...chunk));
  }
  return rows.map((b) => ({
    number: b.number,
    external_ref: b.external_ref,
    source: b.source,
    status: b.status,
    status_label: STATUSES.inbound[b.status] ? STATUSES.inbound[b.status].label : b.status,
    expected_date: b.expected_date,
    arrived_at: b.arrived_at,
    completed_at: b.completed_at,
    pallets: b.pallets,
    cartons: b.cartons,
    note: b.note,
    has_discrepancy: !!b.has_discrepancy,
    created_at: b.created_at,
    updated_at: b.updated_at,
    lines: lines.filter((l) => l.inbound_id === b.id).map((l) => ({
      sku: l.sku, name: l.name, expected_qty: l.expected_qty, received_qty: l.received_qty, damaged_qty: l.damaged_qty, lot: l.lot, expiry: l.expiry,
    })),
  }));
}
