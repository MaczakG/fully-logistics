// Megrendelések: open orders (new, hold, picking, packed), manual create, CSV import, edit, hold, cancel. Prefix /api/orders
//
//   GET   /api/orders               list: filters, KPIs, availability per row [orders view]
//   GET   /api/orders/:id           detail with lines, picks, timeline, label, returns [orders view or history view]
//   POST  /api/orders               manual order through createOrder() [orders create]
//   POST  /api/orders/import        CSV import, preview/commit (one row per order line) [orders create]
//   PATCH /api/orders/:id           address, carrier, COD, note, priority, lines while new or hold [orders edit]
//   POST  /api/orders/:id/hold      hold with reason [orders edit]
//   POST  /api/orders/:id/release   release from hold [orders edit]
//   POST  /api/orders/:id/cancel    sztornó with reason, new or hold only [orders delete]
//   POST  /api/orders/:id/notes     timeline note [orders edit]
//
// Availability: open new orders are served in the order a wave would take them (express first, then
// oldest), against free pickable stock (storage locations minus what open waves have planned). An
// order is "ok" when every line fits; only "ok" orders use up stock in the simulation, because a
// wave only takes orders it can allocate completely.

import { all, batch, first, marks, stmt } from '../lib/db.js';
import { badRequest, conflict, forbidden, notFound, page } from '../lib/http.js';
import { validate, validateList } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { can } from '../lib/perm.js';
import { addOrderEvent, setOrderStatus } from '../lib/orders.js';
import { createOrder, LINE_FIELDS, ORDER_FIELDS } from '../lib/order-create.js';
import { csvNumber, parseCsv } from '../lib/csv.js';
import { readUpload } from '../lib/files.js';
import { STATUSES } from '../lib/constants.js';
import { nowIso } from '../lib/time.js';
import { isConfigured, trackingUrl } from '../integrations/couriers/index.js';
import { allIn, freeStock, heldPicks, idParam, restockPicks } from './picking.js';

const OPEN = ['new', 'hold', 'picking', 'packed'];
const label = (s) => (STATUSES.order[s] ? STATUSES.order[s].label : s);

// "%text%" for LIKE with the wildcards in the text itself escaped (use with ESCAPE '\').
export const likeArg = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const intParam = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('Érvénytelen szűrő.');
  return n;
};

// Map orderId -> { ok, status, partnerId, carrierId, lines: { lineId: { ok, free } } } for new and hold orders.
export async function availabilityMap(db) {
  const orders = await all(db,
    `SELECT id, status, partner_id, carrier_id FROM orders WHERE status IN ('new', 'hold')
     ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END, CASE priority WHEN 'express' THEN 0 ELSE 1 END, created_at, id`);
  const map = new Map();
  if (!orders.length) return map;
  const lines = await all(db,
    `SELECT ol.id, ol.order_id, ol.product_id, ol.qty - ol.picked_qty AS remaining
     FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.status IN ('new', 'hold') ORDER BY ol.id`);
  const free = await freeStock(db, lines.filter((l) => l.remaining > 0).map((l) => l.product_id));
  const byOrder = new Map();
  for (const l of lines) {
    if (!byOrder.has(l.order_id)) byOrder.set(l.order_id, []);
    byOrder.get(l.order_id).push(l);
  }
  for (const o of orders) {
    const ls = byOrder.get(o.id) || [];
    const needs = {};
    for (const l of ls) if (l.remaining > 0) needs[l.product_id] = (needs[l.product_id] || 0) + l.remaining;
    const ok = Object.entries(needs).every(([pid, q]) => (free[pid] || 0) >= q);
    const lineInfo = {};
    for (const l of ls) {
      const f = free[l.product_id] || 0;
      lineInfo[l.id] = { ok: l.remaining <= 0 || f >= needs[l.product_id], free: Math.max(f, 0) };
    }
    if (ok && o.status === 'new') for (const [pid, q] of Object.entries(needs)) free[pid] -= q;
    map.set(o.id, { ok, status: o.status, partnerId: o.partner_id, carrierId: o.carrier_id, lines: lineInfo });
  }
  return map;
}

const LIST_SELECT = `
  SELECT o.id, o.number, o.external_number, o.source, o.status, o.priority, o.customer_name, o.company, o.city, o.zip, o.country,
         o.cod_amount, o.currency, o.created_at, o.ordered_at, o.packed_at, o.tracking_number, o.wave_id,
         pa.id AS partner_id, pa.code AS partner_code, pa.name AS partner_name,
         c.id AS carrier_id, c.name AS carrier_name, c.carrier_code, w.number AS wave_number,
         (SELECT COALESCE(SUM(qty), 0) FROM order_lines WHERE order_id = o.id) AS item_count,
         (SELECT COUNT(*) FROM order_lines WHERE order_id = o.id) AS line_count,
         (SELECT COALESCE(SUM(picked_qty), 0) FROM order_lines WHERE order_id = o.id) AS picked_count
  FROM orders o JOIN partners pa ON pa.id = o.partner_id LEFT JOIN partners c ON c.id = o.carrier_id LEFT JOIN waves w ON w.id = o.wave_id`;
const LIST_ORDER = "ORDER BY CASE o.priority WHEN 'express' THEN 0 ELSE 1 END, o.created_at, o.id";

async function listOrders(ctx) {
  const db = ctx.env.DB;
  const q = ctx.query;
  const status = q.get('status') || '';
  if (status && !OPEN.includes(status)) throw badRequest('Ismeretlen állapot.');
  const partnerId = intParam(q.get('partner_id'));
  const carrierId = intParam(q.get('carrier_id'));
  const priority = q.get('priority') || '';
  if (priority && !['normal', 'express'].includes(priority)) throw badRequest('Ismeretlen prioritás.');
  const avail = q.get('availability') || '';
  if (avail && !['ok', 'short'].includes(avail)) throw badRequest('Ismeretlen készletszűrő.');
  const text = (q.get('q') || '').trim().slice(0, 100);
  const { limit, offset } = page(q, 50, 500);

  const statuses = status ? [status] : OPEN;
  const where = [`o.status IN (${marks(statuses.length)})`];
  const args = [...statuses];
  if (partnerId) { where.push('o.partner_id = ?'); args.push(partnerId); }
  if (carrierId) { where.push('o.carrier_id = ?'); args.push(carrierId); }
  if (priority) { where.push('o.priority = ?'); args.push(priority); }
  if (text) {
    where.push(`(o.number LIKE ? ESCAPE '\\' OR o.external_number LIKE ? ESCAPE '\\' OR o.customer_name LIKE ? ESCAPE '\\'
                 OR o.company LIKE ? ESCAPE '\\' OR o.city LIKE ? ESCAPE '\\')`);
    const l = likeArg(text);
    args.push(l, l, l, l, l);
  }
  const whereSql = where.join(' AND ');
  const av = await availabilityMap(db);

  let total;
  let rows;
  if (avail) {
    const ids = (await all(db, `SELECT o.id FROM orders o WHERE ${whereSql} ${LIST_ORDER}`, ...args))
      .map((r) => r.id)
      .filter((id) => av.has(id) && (avail === 'ok' ? av.get(id).ok : !av.get(id).ok));
    total = ids.length;
    const pageIds = ids.slice(offset, offset + limit);
    const found = pageIds.length ? await allIn(db, `${LIST_SELECT} WHERE o.id IN (?)`, pageIds) : [];
    const pos = new Map(pageIds.map((id, i) => [id, i]));
    rows = found.sort((a, b) => pos.get(a.id) - pos.get(b.id));
  } else {
    total = (await first(db, `SELECT COUNT(*) AS n FROM orders o WHERE ${whereSql}`, ...args)).n;
    rows = await all(db, `${LIST_SELECT} WHERE ${whereSql} ${LIST_ORDER} LIMIT ? OFFSET ?`, ...args, limit, offset);
  }
  const items = rows.map((r) => ({ ...r, availability: av.has(r.id) ? (av.get(r.id).ok ? 'ok' : 'short') : null }));

  // KPIs follow the client and carrier filters, not the status tab or the search.
  const kWhere = [`o.status IN (${marks(OPEN.length)})`];
  const kArgs = [...OPEN];
  if (partnerId) { kWhere.push('o.partner_id = ?'); kArgs.push(partnerId); }
  if (carrierId) { kWhere.push('o.carrier_id = ?'); kArgs.push(carrierId); }
  const counts = await all(db,
    `SELECT o.status, COUNT(*) AS n, SUM(CASE WHEN o.priority = 'express' AND o.status IN ('new', 'hold', 'picking') THEN 1 ELSE 0 END) AS express
     FROM orders o WHERE ${kWhere.join(' AND ')} GROUP BY o.status`, ...kArgs);
  const kpis = { new: 0, hold: 0, picking: 0, packed: 0, express: 0, fulfillable: 0 };
  for (const c of counts) {
    kpis[c.status] = c.n;
    kpis.express += c.express || 0;
  }
  for (const a of av.values()) {
    if (a.ok && a.status === 'new' && (!partnerId || a.partnerId === partnerId) && (!carrierId || a.carrierId === carrierId)) kpis.fulfillable += 1;
  }
  return { items, total, kpis };
}

// ---------------------------------------------------------------- detail

export async function orderDetail(ctx, id) {
  const db = ctx.env.DB;
  const o = await first(db,
    `SELECT o.*, pa.code AS partner_code, pa.name AS partner_name, c.name AS carrier_name, c.carrier_code,
            w.number AS wave_number, w.status AS wave_status, d.filename AS label_filename, cp.number AS pickup_number
     FROM orders o JOIN partners pa ON pa.id = o.partner_id LEFT JOIN partners c ON c.id = o.carrier_id
     LEFT JOIN waves w ON w.id = o.wave_id LEFT JOIN documents d ON d.id = o.label_document_id
     LEFT JOIN carrier_pickups cp ON cp.id = o.pickup_id WHERE o.id = ?`, id);
  if (!o) throw notFound('A rendelés nem található.');
  const lines = await all(db,
    `SELECT ol.id, ol.product_id, ol.qty, ol.picked_qty, ol.external_line_id, p.sku, p.name, p.ean, p.unit, p.weight_kg, p.active,
            (SELECT COALESCE(SUM(rl.qty), 0) FROM return_lines rl JOIN returns r ON r.id = rl.return_id WHERE r.order_id = ol.order_id AND rl.product_id = ol.product_id) AS returned_qty
     FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? ORDER BY ol.id`, id);
  let availability = null;
  if (['new', 'hold'].includes(o.status)) {
    const av = (await availabilityMap(db)).get(id);
    availability = av && av.ok ? 'ok' : 'short';
    for (const l of lines) {
      const info = av && av.lines[l.id];
      l.free = info ? info.free : 0;
      l.available = info ? info.ok : false;
    }
  }
  const picks = await all(db,
    `SELECT pk.id, pk.wave_id, w.number AS wave_number, w.status AS wave_status, l.code AS location_code, p.sku, pk.lot, pk.expiry,
            pk.qty, pk.picked_qty, pk.short_qty, pk.restocked_qty, pk.picked_at, u.name AS picked_by_name
     FROM picks pk JOIN waves w ON w.id = pk.wave_id JOIN locations l ON l.id = pk.location_id JOIN products p ON p.id = pk.product_id
     LEFT JOIN users u ON u.id = pk.picked_by WHERE pk.order_id = ? ORDER BY pk.wave_id, l.pick_sequence, l.code, pk.id`, id);
  const events = await all(db,
    'SELECT e.id, e.at, e.type, e.text, u.name AS user_name FROM order_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.order_id = ? ORDER BY e.at DESC, e.id DESC', id);
  const returns = await all(db,
    'SELECT r.id, r.number, r.received_at, r.received_date, r.reason, r.note, u.name AS created_by_name FROM returns r LEFT JOIN users u ON u.id = r.created_by WHERE r.order_id = ? ORDER BY r.id', id);
  if (returns.length) {
    const rids = returns.map((r) => r.id);
    const rlines = await allIn(db,
      `SELECT rl.id, rl.return_id, rl.product_id, rl.qty, rl.condition, rl.lot, rl.expiry, p.sku, p.name, l.code AS location_code
       FROM return_lines rl JOIN products p ON p.id = rl.product_id LEFT JOIN locations l ON l.id = rl.location_id
       WHERE rl.return_id IN (?) ORDER BY rl.id`, rids);
    const photos = await allIn(db,
      'SELECT rp.return_id, d.id, d.filename, d.content_type FROM return_photos rp JOIN documents d ON d.id = rp.document_id WHERE rp.return_id IN (?) ORDER BY d.id', rids);
    for (const r of returns) {
      r.lines = rlines.filter((x) => x.return_id === r.id);
      r.photos = photos.filter((x) => x.return_id === r.id).map(({ id: docId, filename, content_type: type }) => ({ id: docId, filename, content_type: type }));
    }
  }
  const code = o.carrier_code || '';
  return {
    id: o.id, number: o.number, status: o.status, priority: o.priority, source: o.source,
    external_id: o.external_id, external_number: o.external_number,
    partner: { id: o.partner_id, code: o.partner_code, name: o.partner_name },
    customer_name: o.customer_name, company: o.company, email: o.email, phone: o.phone,
    country: o.country, zip: o.zip, city: o.city, address: o.address, pickup_point_id: o.pickup_point_id,
    carrier: o.carrier_id ? { id: o.carrier_id, name: o.carrier_name, carrier_code: code } : null,
    carrier_service: o.carrier_service, cod_amount: o.cod_amount, currency: o.currency, note: o.note,
    wave: o.wave_id ? { id: o.wave_id, number: o.wave_number, status: o.wave_status } : null,
    pickup: o.pickup_id ? { id: o.pickup_id, number: o.pickup_number } : null,
    package_count: o.package_count, weight_kg: o.weight_kg, tracking_number: o.tracking_number,
    tracking_url: o.tracking_number && code ? trackingUrl(code, o.tracking_number) : '',
    label: o.label_document_id ? { id: o.label_document_id, filename: o.label_filename } : null,
    courier_configured: code ? await isConfigured(ctx.env, code) : false,
    ordered_at: o.ordered_at, created_at: o.created_at, updated_at: o.updated_at, packed_at: o.packed_at,
    shipped_at: o.shipped_at, shipped_date: o.shipped_date, delivered_at: o.delivered_at, cancelled_at: o.cancelled_at,
    item_count: lines.reduce((s, l) => s + l.qty, 0),
    picked_count: lines.reduce((s, l) => s + l.picked_qty, 0),
    line_count: lines.length,
    availability,
    lines, picks, events, returns,
  };
}

async function loadOrder(db, id) {
  const o = await first(db, 'SELECT * FROM orders WHERE id = ?', id);
  if (!o) throw notFound('A rendelés nem található.');
  return o;
}

// ---------------------------------------------------------------- edit

const EDIT_GROUPS = {
  customer_name: 'címzett', company: 'címzett', email: 'címzett', phone: 'címzett',
  country: 'szállítási cím', zip: 'szállítási cím', city: 'szállítási cím', address: 'szállítási cím', pickup_point_id: 'átvételi pont',
  carrier_id: 'fuvarozó', carrier_service: 'fuvarozó', cod_amount: 'utánvét', note: 'megjegyzés', priority: 'prioritás',
  external_number: 'külső rendelésszám',
};
const EDIT_SPEC = Object.fromEntries(Object.keys(EDIT_GROUPS).map((k) => {
  const { default: _d, ...rule } = ORDER_FIELDS[k];
  return [k, rule];
}));

async function editOrder(ctx, id, body) {
  const db = ctx.env.DB;
  const data = validate(body, EDIT_SPEC, { partial: true });
  const o = await loadOrder(db, id);
  if (!['new', 'hold'].includes(o.status)) {
    throw conflict(`Csak új vagy felfüggesztett rendelés módosítható. A(z) ${o.number} állapota: ${label(o.status)}.`);
  }
  if (data.country !== undefined) data.country = (data.country || 'HU').toUpperCase();
  if (data.carrier_id) {
    const c = await first(db, "SELECT id FROM partners WHERE id = ? AND type = 'carrier'", data.carrier_id);
    if (!c) throw badRequest('Ismeretlen fuvarozó.', { carrier_id: 'Válassz fuvarozót.' });
  }
  const changes = {};
  for (const [k, v] of Object.entries(data)) {
    const cur = o[k] ?? (k === 'carrier_id' ? null : '');
    if (String(cur ?? '') !== String(v ?? '')) changes[k] = v;
  }

  // Lines: { id } keeps an existing line (its product stays), no id adds one, missing ids are removed.
  // Every statement re-checks the status, so a wave started meanwhile cannot see half an edit.
  const guard = "EXISTS (SELECT 1 FROM orders WHERE id = ? AND status IN ('new', 'hold'))";
  const lineStmts = [];
  const lineNotes = [];
  if (body.lines !== undefined) {
    const list = validateList(body.lines, {
      id: { type: 'id', nullable: true },
      product_id: { type: 'id', required: true },
      qty: LINE_FIELDS.qty,
    }, { max: 1000 });
    const existing = await all(db, 'SELECT ol.*, p.sku FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ?', id);
    const byId = new Map(existing.map((l) => [l.id, l]));
    const productIds = [...new Set(list.map((l) => l.product_id))];
    const products = await allIn(db, 'SELECT id, sku, active FROM products WHERE partner_id = ? AND id IN (?)', productIds, o.partner_id);
    const pById = new Map(products.map((p) => [p.id, p]));
    const errors = {};
    const kept = new Set();
    list.forEach((l, i) => {
      const p = pById.get(l.product_id);
      if (l.id) {
        const cur = byId.get(l.id);
        if (!cur) { errors[`lines.${i}.product_id`] = 'Ez a tétel nem ehhez a rendeléshez tartozik.'; return; }
        if (kept.has(l.id)) { errors[`lines.${i}.product_id`] = 'A tétel kétszer szerepel.'; return; }
        kept.add(l.id);
        if (cur.product_id !== l.product_id) {
          if (cur.picked_qty > 0) { errors[`lines.${i}.product_id`] = `A(z) ${cur.sku} tételből már kiszedtek, a termék nem cserélhető.`; return; }
          if (!p) { errors[`lines.${i}.product_id`] = 'Ismeretlen termék.'; return; }
          if (!p.active) { errors[`lines.${i}.product_id`] = `Inaktív cikk: ${p.sku}`; return; }
        }
        if (l.qty < cur.picked_qty) { errors[`lines.${i}.qty`] = `Már ${cur.picked_qty} db ki van szedve, ennél kevesebb nem lehet.`; return; }
        if (cur.product_id !== l.product_id || cur.qty !== l.qty) {
          lineStmts.push(stmt(db, `UPDATE order_lines SET product_id = ?, qty = ? WHERE id = ? AND order_id = ? AND ${guard}`, l.product_id, l.qty, l.id, id, id));
          lineNotes.push(cur.product_id !== l.product_id ? `${cur.sku} helyett ${p.sku} ${l.qty} db` : `${cur.sku}: ${cur.qty} -> ${l.qty} db`);
        }
      } else {
        if (!p) { errors[`lines.${i}.product_id`] = 'Ismeretlen termék, vagy nem ennek az ügyfélnek a cikke.'; return; }
        if (!p.active) { errors[`lines.${i}.product_id`] = `Inaktív cikk: ${p.sku}`; return; }
        lineStmts.push(stmt(db, `INSERT INTO order_lines (order_id, product_id, qty) SELECT ?, ?, ? WHERE ${guard}`, id, l.product_id, l.qty, id));
        lineNotes.push(`új tétel: ${p.sku} ${l.qty} db`);
      }
    });
    for (const cur of existing) {
      if (kept.has(cur.id)) continue;
      if (cur.picked_qty > 0) {
        errors.lines = `A(z) ${cur.sku} tételből már ${cur.picked_qty} db ki van szedve, ezért nem törölhető.`;
        continue;
      }
      lineStmts.push(stmt(db, `DELETE FROM order_lines WHERE id = ? AND order_id = ? AND ${guard}`, cur.id, id, id));
      lineNotes.push(`törölve: ${cur.sku}`);
    }
    if (Object.keys(errors).length) throw badRequest('Ellenőrizd a rendelés tételeit.', errors);
  }

  if (!Object.keys(changes).length && !lineStmts.length) return { ok: true, changed: [] };
  const groups = [...new Set(Object.keys(changes).map((k) => EDIT_GROUPS[k]))];
  if (lineStmts.length) groups.push('tételek');
  const at = nowIso();
  const keys = Object.keys(changes);
  const res = await batch(db, [
    stmt(db, `UPDATE orders SET ${[...keys.map((k) => `${k} = ?`), 'updated_at = ?'].join(', ')} WHERE id = ? AND status IN ('new', 'hold')`,
      ...keys.map((k) => changes[k]), at, id),
    ...lineStmts,
    stmt(db, `INSERT INTO order_events (order_id, at, type, text, user_id) SELECT ?, ?, 'note', ?, ? WHERE ${guard}`,
      id, at, `Módosítva: ${groups.join(', ')}${lineNotes.length ? ` (${lineNotes.join('; ')})` : ''}`, ctx.user ? ctx.user.id : null, id),
  ]);
  if (res[0].meta.changes !== 1) throw conflict('A rendelés állapota közben megváltozott, a módosítás nem menthető. Frissítsd az oldalt.');
  await audit(ctx, {
    module: 'orders', action: 'edit', entity: 'order', entityId: id,
    summary: `${o.number} módosítva: ${groups.join(', ')}`,
    details: { changes, lines: lineNotes },
  });
  return { ok: true, changed: groups };
}

// ---------------------------------------------------------------- CSV import

const CSV_ALIASES = {
  partner_code: ['partnerkod', 'partner_kod', 'ugyfelkod', 'ugyfel_kod', 'partner', 'partner_code', 'client_code'],
  external_number: ['rendelesszam', 'kulso_rendelesszam', 'kulso_szam', 'rendeles_szam', 'external_number', 'order_number'],
  customer_name: ['vevo_neve', 'vevo', 'cimzett', 'nev', 'customer_name', 'name'],
  company: ['ceg', 'cegnev', 'company'],
  email: ['e_mail', 'email'],
  phone: ['telefon', 'telefonszam', 'phone'],
  country: ['orszag', 'country'],
  zip: ['iranyitoszam', 'irsz', 'zip', 'postcode'],
  city: ['varos', 'telepules', 'city'],
  address: ['cim', 'utca', 'address'],
  pickup_point_id: ['atveteli_pont', 'csomagautomata', 'atvevohely', 'pickup_point_id', 'pickup_point'],
  carrier_code: ['futar', 'fuvarozo', 'futarkod', 'carrier_code', 'carrier'],
  cod_amount: ['utanvet', 'utanvet_osszeg', 'cod_amount', 'cod'],
  sku: ['cikkszam', 'sku'],
  qty: ['mennyiseg', 'db', 'qty', 'quantity'],
  note: ['megjegyzes', 'note'],
};
export const CSV_TEMPLATE = ['Partnerkód', 'Rendelésszám', 'Vevő neve', 'Cég', 'E-mail', 'Telefon', 'Ország', 'Irányítószám', 'Város', 'Cím',
  'Átvételi pont', 'Futár', 'Utánvét', 'Cikkszám', 'Mennyiség', 'Megjegyzés'];
const CARRIER_CODES = ['gls', 'dpd', 'foxpost', 'mpl', 'dhl'];
const MAX_IMPORT_ROWS = 5000;

function pickColumns(headers) {
  const col = {};
  for (const [key, names] of Object.entries(CSV_ALIASES)) col[key] = names.find((n) => headers.includes(n)) || null;
  return col;
}

async function importOrders(ctx) {
  const db = ctx.env.DB;
  const { file, form } = await readUpload(ctx);
  const preview = String(form.get('preview') ?? '1') !== '0';
  const { headers, records } = parseCsv(await file.text());
  if (!records.length) throw badRequest('A fájlban nincs adatsor.');
  if (records.length > MAX_IMPORT_ROWS) throw badRequest(`Egyszerre legfeljebb ${MAX_IMPORT_ROWS} sor importálható.`);
  const col = pickColumns(headers);
  const missingCols = ['partner_code', 'external_number', 'customer_name', 'sku', 'qty'].filter((k) => !col[k]);
  if (missingCols.length) {
    const names = { partner_code: 'Partnerkód', external_number: 'Rendelésszám', customer_name: 'Vevő neve', sku: 'Cikkszám', qty: 'Mennyiség' };
    throw badRequest(`Hiányzó oszlop: ${missingCols.map((k) => names[k]).join(', ')}. Töltsd le a sablont.`);
  }
  const val = (rec, key) => (col[key] ? String(rec[col[key]] ?? '').trim() : '');

  // Group rows into orders by partner code + external order number.
  const groups = new Map();
  const errors = [];
  for (const rec of records) {
    const code = val(rec, 'partner_code').toUpperCase();
    const ext = val(rec, 'external_number');
    if (!code || !ext) {
      errors.push({ line: rec._line, message: !code ? 'Hiányzik a partnerkód.' : 'Hiányzik a rendelésszám.' });
      continue;
    }
    const key = `${code}\u0000${ext}`;
    if (!groups.has(key)) groups.set(key, { code, ext, rows: [] });
    groups.get(key).rows.push(rec);
  }

  const codes = [...new Set([...groups.values()].map((g) => g.code))];
  const partners = codes.length ? await allIn(db, 'SELECT id, code, name, type, status FROM partners WHERE UPPER(code) IN (?)', codes) : [];
  const partnerByCode = new Map(partners.map((p) => [p.code.toUpperCase(), p]));
  const carriers = await all(db, "SELECT id, carrier_code FROM partners WHERE type = 'carrier' AND status = 'active' ORDER BY id");

  const ready = [];
  for (const g of groups.values()) {
    const fail = (rec, message) => errors.push({ line: rec._line, message });
    const first0 = g.rows[0];
    const partner = partnerByCode.get(g.code);
    if (!partner || partner.type !== 'client') { g.rows.forEach((r) => fail(r, `Ismeretlen ügyfél partnerkód: ${g.code}.`)); continue; }
    if (partner.status !== 'active') { g.rows.forEach((r) => fail(r, `Inaktív ügyfél: ${partner.name}.`)); continue; }

    const carrierRaw = val(first0, 'carrier_code').toLowerCase();
    const cod = val(first0, 'cod_amount');
    const codValue = cod === '' ? 0 : csvNumber(cod);
    const input = {
      partner_id: partner.id, source: 'csv', external_id: g.ext, external_number: g.ext,
      customer_name: val(first0, 'customer_name'), company: val(first0, 'company'), email: val(first0, 'email'), phone: val(first0, 'phone'),
      country: (val(first0, 'country') || 'HU').toUpperCase(), zip: val(first0, 'zip'), city: val(first0, 'city'), address: val(first0, 'address'),
      pickup_point_id: val(first0, 'pickup_point_id'),
      carrier_code: CARRIER_CODES.includes(carrierRaw) ? carrierRaw : '', cod_amount: Number.isFinite(codValue) ? codValue : 0,
      note: g.rows.map((r) => val(r, 'note')).find(Boolean) || '',
      lines: g.rows.map((r) => {
        const q = csvNumber(val(r, 'qty'));
        return { sku: val(r, 'sku'), qty: Number.isFinite(q) ? q : val(r, 'qty') };
      }),
    };
    const rowErr = [];
    if (carrierRaw && !CARRIER_CODES.includes(carrierRaw)) rowErr.push([first0, `Ismeretlen futár: ${carrierRaw}. Lehet: ${CARRIER_CODES.join(', ')}.`]);
    else if (carrierRaw && !carriers.some((c) => c.carrier_code === carrierRaw)) rowErr.push([first0, `Nincs aktív ${carrierRaw} fuvarozó partner felvéve.`]);
    if (!Number.isFinite(codValue)) rowErr.push([first0, `Hibás utánvét összeg: ${cod}.`]);
    try {
      validate(input, ORDER_FIELDS);
    } catch (e) {
      for (const [f, msg] of Object.entries(e.fields || {})) rowErr.push([first0, `${FIELD_NAMES[f] || f}: ${msg}`]);
    }
    try {
      validateList(input.lines, LINE_FIELDS);
    } catch (e) {
      for (const [k, msg] of Object.entries(e.fields || {})) {
        const m = k.match(/^lines\.(\d+)\.(\w+)$/);
        rowErr.push([m ? g.rows[Number(m[1])] : first0, `${m ? FIELD_NAMES[m[2]] || m[2] : 'Tételek'}: ${msg}`]);
      }
    }
    const skus = [...new Set(input.lines.map((l) => l.sku).filter(Boolean))];
    const products = skus.length ? await allIn(db, 'SELECT sku, active FROM products WHERE partner_id = ? AND sku IN (?)', skus, partner.id) : [];
    const known = new Map(products.map((p) => [p.sku, p]));
    input.lines.forEach((l, i) => {
      if (!l.sku) return;
      const p = known.get(l.sku);
      if (!p) rowErr.push([g.rows[i], `Ismeretlen cikkszám ennél az ügyfélnél: ${l.sku}.`]);
      else if (!p.active) rowErr.push([g.rows[i], `Inaktív cikk: ${l.sku}.`]);
    });
    if (rowErr.length) {
      const bad = new Set(rowErr.map(([r]) => r));
      for (const [r, msg] of rowErr) fail(r, msg);
      for (const r of g.rows) if (!bad.has(r)) fail(r, `A(z) ${g.ext} rendelés egy másik sora hibás, ezért ez a sor is kimarad.`);
      continue;
    }
    const dup = await first(db, "SELECT number FROM orders WHERE partner_id = ? AND source = 'csv' AND external_id = ?", partner.id, g.ext);
    if (dup) {
      g.rows.forEach((r) => fail(r, `A(z) ${g.ext} rendelés már importálva van (${dup.number}), kimarad.`));
      continue;
    }
    ready.push({ g, partner, input });
  }

  const validRows = ready.reduce((s, x) => s + x.g.rows.length, 0);
  errors.sort((a, b) => a.line - b.line);
  if (preview) {
    return {
      rows: records.length, valid: validRows, orders: ready.length, errors,
      sample: ready.slice(0, 10).map(({ g, partner, input }) => ({
        partner: partner.code, external_number: g.ext, customer_name: input.customer_name, city: input.city,
        lines: input.lines.length, items: input.lines.reduce((s, l) => s + l.qty, 0),
      })),
    };
  }
  let imported = 0;
  const created = [];
  for (const { g, input } of ready) {
    try {
      const res = await createOrder(ctx, input);
      if (!res.duplicate) {
        imported += 1;
        created.push(res.number);
      }
    } catch (e) {
      const msg = e.fields ? Object.values(e.fields).join(' ') : e.message;
      g.rows.forEach((r) => errors.push({ line: r._line, message: msg }));
    }
  }
  await audit(ctx, { module: 'orders', action: 'create', entity: 'order_import', summary: `CSV import: ${imported} rendelés`, details: { created: created.slice(0, 200), errors: errors.length } });
  return { imported, orders: created, errors };
}

const FIELD_NAMES = {
  customer_name: 'Vevő neve', company: 'Cég', email: 'E-mail', phone: 'Telefon', country: 'Ország', zip: 'Irányítószám', city: 'Város',
  address: 'Cím', pickup_point_id: 'Átvételi pont', carrier_code: 'Futár', cod_amount: 'Utánvét', note: 'Megjegyzés', sku: 'Cikkszám',
  qty: 'Mennyiség', external_id: 'Rendelésszám', external_number: 'Rendelésszám',
};

// ---------------------------------------------------------------- routes

export function register(r) {
  r.get('/api/orders', listOrders, { perm: ['orders', 'view'] });

  r.post('/api/orders/import', importOrders, { perm: ['orders', 'create'] });

  r.post('/api/orders', async (ctx) => {
    const body = await ctx.body();
    // The form always creates manual orders; imports have their own endpoints.
    return createOrder(ctx, { ...body, source: 'manual', external_id: '' });
  }, { perm: ['orders', 'create'] });

  r.get('/api/orders/:id', async (ctx) => {
    if (!can(ctx.user, 'orders', 'view') && !can(ctx.user, 'history', 'view')) {
      throw forbidden('Ehhez nincs jogosultságod (Megrendelések vagy Rendeléstörténet: megtekintés).');
    }
    return orderDetail(ctx, idParam(ctx));
  });

  r.patch('/api/orders/:id', async (ctx) => editOrder(ctx, idParam(ctx), await ctx.body()), { perm: ['orders', 'edit'] });

  r.post('/api/orders/:id/hold', async (ctx) => {
    const id = idParam(ctx);
    const { reason } = validate(await ctx.body(), { reason: { type: 'str', required: true, max: 300 } });
    const o = await loadOrder(ctx.env.DB, id);
    if (o.status !== 'new') throw conflict(`Csak új rendelés függeszthető fel. A(z) ${o.number} állapota: ${label(o.status)}.`);
    await setOrderStatus(ctx, id, 'hold', `Felfüggesztve: ${reason}`);
    await audit(ctx, { module: 'orders', action: 'edit', entity: 'order', entityId: id, summary: `${o.number} felfüggesztve: ${reason}` });
    return { ok: true };
  }, { perm: ['orders', 'edit'] });

  r.post('/api/orders/:id/release', async (ctx) => {
    const id = idParam(ctx);
    const { reason } = validate(await ctx.body(), { reason: { type: 'str', max: 300, default: '' } });
    const o = await loadOrder(ctx.env.DB, id);
    if (o.status !== 'hold') throw conflict(`A(z) ${o.number} rendelés nincs felfüggesztve.`);
    await setOrderStatus(ctx, id, 'new', `Felfüggesztés feloldva${reason ? `: ${reason}` : ''}`);
    await audit(ctx, { module: 'orders', action: 'edit', entity: 'order', entityId: id, summary: `${o.number} felfüggesztése feloldva` });
    return { ok: true };
  }, { perm: ['orders', 'edit'] });

  r.post('/api/orders/:id/cancel', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const { reason } = validate(await ctx.body(), { reason: { type: 'str', required: true, max: 300 } });
    const o = await loadOrder(db, id);
    if (!['new', 'hold'].includes(o.status)) {
      throw conflict(`Csak új vagy felfüggesztett rendelés sztornózható. A(z) ${o.number} állapota: ${label(o.status)}.`);
    }
    // Goods already picked for it (an earlier wave closed with shortage) go back to their shelves.
    const held = await heldPicks(db, id);
    await setOrderStatus(ctx, id, 'cancelled', `Sztornózva: ${reason}`);
    const back = held.length ? await restockPicks(ctx, held, { refType: 'order', refId: id, note: `${o.number} sztornózva` }) : [];
    if (back.length) await addOrderEvent(ctx, id, 'note', `Visszakönyvelve: ${back.map((b) => `${b.sku} ${b.qty} db (${b.code})`).join(', ')}`);
    await audit(ctx, { module: 'orders', action: 'delete', entity: 'order', entityId: id, summary: `${o.number} sztornózva: ${reason}`, details: { restocked: back } });
    return { ok: true, restocked: back };
  }, { perm: ['orders', 'delete'] });

  r.post('/api/orders/:id/notes', async (ctx) => {
    const id = idParam(ctx);
    const { text } = validate(await ctx.body(), { text: { type: 'text', required: true, max: 2000 } });
    if (!text.trim()) throw badRequest('Írd be a megjegyzést.', { text: 'Kötelező mező.' });
    const o = await loadOrder(ctx.env.DB, id);
    await addOrderEvent(ctx, id, 'note', text.trim());
    await audit(ctx, { module: 'orders', action: 'edit', entity: 'order', entityId: id, summary: `${o.number}: megjegyzés hozzáadva` });
    return { ok: true };
  }, { perm: ['orders', 'edit'] });
}
