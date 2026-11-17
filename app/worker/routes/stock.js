// Készlet + Cikktörzs: stock overview, movements, transfers, manual adjustment, location occupancy,
// products CRUD and CSV import. Prefix /api/stock and /api/products
//
// Availability here is the same as lib/stock.js availability(): on hand minus quarantine (blocked)
// minus open order lines not yet picked (reserved). Computed in SQL so lists can filter and page
// on the stock status:  out (elfogyott): available <= 0 ; low (alacsony): below min stock ; ok.

import { all, first, run } from '../lib/db.js';
import { badRequest, conflict, download, notFound, page } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { LOCATION_KINDS, MOVEMENT_TYPES } from '../lib/constants.js';
import { addStock, availability, locationByCode, location as getLocation, removeStock, setStockQty, transferStock } from '../lib/stock.js';
import { csvNumber, normalizeHeader, parseCsv, toCsv } from '../lib/csv.js';
import { readUpload } from '../lib/files.js';
import { budapestDate, isDate, nowIso } from '../lib/time.js';

const MAX_QTY = 1000000;
const MAX_EXPORT = 50000;
const MAX_IMPORT_ROWS = 10000;

const intParam = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const dateParam = (v) => (isDate(v) && realDate(v) ? v : null);
// LIKE pattern for user text; use with ESCAPE '\'.
const like = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
// isDate() lets "2027-02-31" through (Date.parse rolls it over), so dates are also checked here.
const realDate = (s) => !s || (isDate(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s);
const csvFile = (name) => `${name}-${budapestDate()}.csv`;
const CSV_TYPE = 'text/csv; charset=utf-8';

function idParam(ctx, what = 'A termék') {
  const id = intParam(ctx.params.id);
  if (!id) throw notFound(`${what} nem található.`);
  return id;
}

// ---------------------------------------------------------------- EAN / GTIN

// Warning text for a barcode that is not a valid EAN-8, UPC-A, EAN-13 or GTIN-14, or null.
// Only a warning: some clients use their own internal codes.
export function eanWarning(ean) {
  const s = String(ean || '').trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) return 'Az EAN nem csak számjegyekből áll. Ellenőrizd, hogy valóban vonalkód-e.';
  if (![8, 12, 13, 14].includes(s.length)) return `Az EAN hossza ${s.length} számjegy. Szabványos hossz: 8, 12, 13 vagy 14.`;
  const digits = s.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  const expected = (10 - (sum % 10)) % 10;
  return check === expected ? null : `Az EAN ellenőrző számjegye hibás (${check} helyett ${expected} lenne helyes).`;
}

// ---------------------------------------------------------------- stock overview

const STOCK_FROM = `
  FROM products p
  JOIN partners pa ON pa.id = p.partner_id
  LEFT JOIN (SELECT s.product_id, SUM(s.qty) AS on_hand,
                    SUM(CASE WHEN l.kind = 'quarantine' THEN s.qty ELSE 0 END) AS blocked,
                    COUNT(DISTINCT s.location_id) AS locations,
                    MIN(CASE WHEN s.expiry <> '' THEN s.expiry END) AS next_expiry
             FROM stock s JOIN locations l ON l.id = s.location_id GROUP BY s.product_id) st ON st.product_id = p.id
  LEFT JOIN (SELECT ol.product_id, SUM(ol.qty - ol.picked_qty) AS reserved
             FROM order_lines ol JOIN orders o ON o.id = ol.order_id
             WHERE o.status IN ('new', 'hold', 'picking') GROUP BY ol.product_id) rs ON rs.product_id = p.id`;
const AVAILABLE = '(COALESCE(st.on_hand, 0) - COALESCE(st.blocked, 0) - COALESCE(rs.reserved, 0))';
const STATUS = `(CASE WHEN ${AVAILABLE} <= 0 THEN 'out' WHEN ${AVAILABLE} < p.min_stock THEN 'low' ELSE 'ok' END)`;
const STOCK_COLUMNS = `p.id AS product_id, p.partner_id, pa.code AS partner_code, pa.name AS partner_name, p.sku, p.name, p.ean, p.unit,
  p.min_stock, p.active, p.track_lot, p.track_expiry, COALESCE(st.on_hand, 0) AS on_hand, COALESCE(rs.reserved, 0) AS reserved,
  COALESCE(st.blocked, 0) AS blocked, ${AVAILABLE} AS available, COALESCE(st.locations, 0) AS locations, st.next_expiry,
  ${STATUS} AS status`;
export const STOCK_STATUS = { ok: 'Rendben', low: 'Alacsony', out: 'Elfogyott' };

function stockWhere(q, { withStatus = true } = {}) {
  const where = ['(p.active = 1 OR COALESCE(st.on_hand, 0) > 0)'];
  const args = [];
  const partner = intParam(q.get('partner_id'));
  if (partner) { where.push('p.partner_id = ?'); args.push(partner); }
  const text = (q.get('q') || '').trim();
  if (text) {
    where.push("(p.sku LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR p.ean LIKE ? ESCAPE '\\')");
    args.push(like(text), like(text), like(text));
  }
  if (withStatus) {
    const status = q.get('status');
    if (q.get('low') === '1' || status === 'attention') where.push(`${STATUS} IN ('low', 'out')`);
    else if (STOCK_STATUS[status]) { where.push(`${STATUS} = ?`); args.push(status); }
  }
  return { sql: where.join(' AND '), args };
}

const shapeStock = (r) => ({ ...r, active: !!r.active, track_lot: !!r.track_lot, track_expiry: !!r.track_expiry, status_label: STOCK_STATUS[r.status] });

// ---------------------------------------------------------------- movements

const REF_NUMBER = `(CASE m.ref_type
  WHEN 'inbound' THEN (SELECT number FROM inbounds WHERE id = m.ref_id)
  WHEN 'order' THEN (SELECT number FROM orders WHERE id = m.ref_id)
  WHEN 'wave' THEN (SELECT number FROM waves WHERE id = m.ref_id)
  WHEN 'count' THEN (SELECT number FROM counts WHERE id = m.ref_id)
  WHEN 'return' THEN (SELECT number FROM returns WHERE id = m.ref_id)
  ELSE NULL END)`;
const REF_TYPES = { inbound: 'Betárolás', order: 'Rendelés', wave: 'Komissió', count: 'Leltár', return: 'Visszáru', manual: 'Kézi' };

function movementWhere(q) {
  const where = ['1 = 1'];
  const args = [];
  const partner = intParam(q.get('partner_id'));
  if (partner) { where.push('m.partner_id = ?'); args.push(partner); }
  const product = intParam(q.get('product_id'));
  if (product) { where.push('m.product_id = ?'); args.push(product); }
  const loc = intParam(q.get('location_id'));
  if (loc) { where.push('m.location_id = ?'); args.push(loc); }
  const type = q.get('type');
  if (type && MOVEMENT_TYPES[type]) { where.push('m.type = ?'); args.push(type); }
  const from = dateParam(q.get('from'));
  if (from) { where.push('m.date >= ?'); args.push(from); }
  const to = dateParam(q.get('to'));
  if (to) { where.push('m.date <= ?'); args.push(to); }
  const refType = q.get('ref_type');
  if (refType && REF_TYPES[refType]) { where.push('m.ref_type = ?'); args.push(refType); }
  const refId = intParam(q.get('ref_id'));
  if (refId) { where.push('m.ref_id = ?'); args.push(refId); }
  const ref = (q.get('ref') || '').trim();
  if (ref) { where.push(`(${REF_NUMBER} LIKE ? ESCAPE '\\' OR m.note LIKE ? ESCAPE '\\')`); args.push(like(ref), like(ref)); }
  const text = (q.get('q') || '').trim();
  if (text) { where.push("(p.sku LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR l.code LIKE ? ESCAPE '\\' OR m.lot LIKE ? ESCAPE '\\')"); args.push(like(text), like(text), like(text), like(text)); }
  return { sql: where.join(' AND '), args };
}

const MOVEMENT_FROM = `FROM movements m JOIN products p ON p.id = m.product_id JOIN partners pa ON pa.id = m.partner_id
  LEFT JOIN locations l ON l.id = m.location_id LEFT JOIN users u ON u.id = m.user_id`;
const MOVEMENT_COLUMNS = `m.id, m.at, m.date, m.type, m.partner_id, pa.code AS partner_code, m.product_id, p.sku, p.name, p.unit,
  m.location_id, l.code AS location_code, m.lot, m.expiry, m.qty, m.ref_type, m.ref_id, ${REF_NUMBER} AS ref_number,
  u.name AS user_name, m.note`;
const shapeMovement = (m) => ({ ...m, type_label: MOVEMENT_TYPES[m.type] || m.type });

// ---------------------------------------------------------------- locations (occupancy)

const OCCUPANCY = `(SELECT s.location_id, MIN(p.partner_id) AS partner_id, COUNT(DISTINCT s.product_id) AS products, SUM(s.qty) AS qty
                    FROM stock s JOIN products p ON p.id = s.product_id WHERE s.qty > 0 GROUP BY s.location_id)`;

function locationWhere(q) {
  const where = ['1 = 1'];
  const args = [];
  const kind = q.get('kind') || 'storage';
  if (kind !== 'all' && LOCATION_KINDS[kind]) { where.push('l.kind = ?'); args.push(kind); }
  if (q.get('inactive') !== '1') where.push('l.active = 1');
  const size = intParam(q.get('size_id'));
  if (size) { where.push('l.size_id = ?'); args.push(size); }
  const partner = intParam(q.get('partner_id'));
  if (partner) { where.push('(occ.partner_id = ? OR l.partner_id = ?)'); args.push(partner, partner); }
  const zone = (q.get('zone') || '').trim();
  if (zone) { where.push('l.zone = ? COLLATE NOCASE'); args.push(zone); }
  const text = (q.get('q') || '').trim();
  if (text) { where.push("l.code LIKE ? ESCAPE '\\'"); args.push(like(text)); }
  const state = q.get('state');
  if (state === 'empty') where.push('occ.location_id IS NULL');
  if (state === 'occupied') where.push('occ.location_id IS NOT NULL');
  return { sql: where.join(' AND '), args };
}

// ---------------------------------------------------------------- products

const PRODUCT_FIELDS = {
  partner_id: { type: 'id', required: true },
  sku: { type: 'str', required: true, max: 120 },
  name: { type: 'str', required: true, max: 200 },
  ean: { type: 'str', max: 50, default: '' },
  unit: { type: 'str', max: 20, default: 'db' },
  weight_kg: { type: 'num', min: 0, max: 100000, nullable: true },
  width_cm: { type: 'num', min: 0, max: 10000, nullable: true },
  depth_cm: { type: 'num', min: 0, max: 10000, nullable: true },
  height_cm: { type: 'num', min: 0, max: 10000, nullable: true },
  min_stock: { type: 'int', min: 0, max: MAX_QTY, default: 0 },
  track_lot: { type: 'bool', default: false },
  track_expiry: { type: 'bool', default: false },
  notes: { type: 'text', max: 2000, default: '' },
};
const EDIT_FIELDS = (({ partner_id, ...rest }) => rest)(PRODUCT_FIELDS);
const PRODUCT_COLUMNS = ['sku', 'name', 'ean', 'unit', 'weight_kg', 'width_cm', 'depth_cm', 'height_cm', 'min_stock', 'track_lot', 'track_expiry', 'notes'];

// Empty form fields arrive as null; the columns behind these are NOT NULL.
function normalizeProduct(data) {
  if (data.min_stock === null) data.min_stock = 0;
  if (data.unit !== undefined && !data.unit) data.unit = 'db';
  if (data.ean === null) data.ean = '';
  if (data.notes === null) data.notes = '';
  return data;
}

const shapeProduct = (p) => ({ ...p, active: !!p.active, track_lot: !!p.track_lot, track_expiry: !!p.track_expiry, ean_warning: eanWarning(p.ean) });

async function clientPartner(db, partnerId, { mustBeActive = true } = {}) {
  const p = await first(db, 'SELECT id, type, status, code, name FROM partners WHERE id = ?', partnerId);
  if (!p || p.type !== 'client') throw badRequest('Ismeretlen ügyfél.', { partner_id: 'Válassz ügyfelet.' });
  if (mustBeActive && p.status !== 'active') throw badRequest('Az ügyfél inaktív.', { partner_id: 'Inaktív ügyfél.' });
  return p;
}

// Case-insensitive SKU clash within the partner (KB-1 and kb-1 would confuse scanning and imports).
async function assertSkuFree(db, partnerId, sku, exceptId = null) {
  const clash = await first(db, 'SELECT id, sku FROM products WHERE partner_id = ? AND sku = ? COLLATE NOCASE AND id <> ?', partnerId, sku, exceptId || 0);
  if (clash) throw conflict(`A(z) ${clash.sku} cikkszám már létezik ennél az ügyfélnél.`, { sku: 'Ez a cikkszám már foglalt ennél az ügyfélnél.' });
}

async function productWarnings(db, p, exceptId = null) {
  const out = [];
  const w = eanWarning(p.ean);
  if (w) out.push(w);
  if (p.ean) {
    const twin = await first(db, 'SELECT sku FROM products WHERE partner_id = ? AND ean = ? AND id <> ? LIMIT 1', p.partner_id, p.ean, exceptId || 0);
    if (twin) out.push(`Ez az EAN már szerepel a(z) ${twin.sku} cikknél is, beolvasáskor nem lesz egyértelmű.`);
  }
  return out;
}

async function productUsage(db, productId) {
  const onHand = await first(db, 'SELECT COALESCE(SUM(qty), 0) AS n FROM stock WHERE product_id = ?', productId);
  const inbound = await first(db,
    `SELECT i.number FROM inbound_lines il JOIN inbounds i ON i.id = il.inbound_id
     WHERE il.product_id = ? AND i.status IN ('expected', 'arrived', 'receiving') ORDER BY i.id LIMIT 1`, productId);
  const order = await first(db,
    `SELECT o.number FROM order_lines ol JOIN orders o ON o.id = ol.order_id
     WHERE ol.product_id = ? AND o.status IN ('new', 'hold', 'picking', 'packed') ORDER BY o.id LIMIT 1`, productId);
  return { on_hand: onHand.n, open_inbound: inbound ? inbound.number : null, open_order: order ? order.number : null };
}

// CSV import columns (normalized header names) and how to read them.
const PRODUCT_CSV = {
  partner: ['ugyfelkod', 'ugyfel_kod', 'ugyfel', 'partner_kod', 'partnerkod', 'partner_code', 'partner'],
  sku: ['cikkszam', 'sku'],
  name: ['megnevezes', 'nev', 'name', 'termeknev'],
  ean: ['ean', 'vonalkod', 'gtin', 'barcode'],
  unit: ['egyseg', 'mennyisegi_egyseg', 'me', 'unit'],
  weight_kg: ['suly_kg', 'suly', 'weight_kg', 'weight', 'tomeg_kg'],
  width_cm: ['szelesseg_cm', 'szelesseg', 'width_cm', 'width'],
  depth_cm: ['melyseg_cm', 'melyseg', 'hosszusag_cm', 'hossz_cm', 'depth_cm', 'length_cm', 'depth'],
  height_cm: ['magassag_cm', 'magassag', 'height_cm', 'height'],
  dimensions: ['meretek_cm', 'meretek', 'meret', 'dimensions'],
  min_stock: ['minimum_keszlet', 'min_keszlet', 'minimum', 'min_stock'],
  track_lot: ['sarzskovetes', 'sarzs_kovetes', 'sarzs', 'track_lot', 'lot_tracking'],
  track_expiry: ['lejaratkovetes', 'lejarat_kovetes', 'lejarat', 'track_expiry', 'expiry_tracking'],
};
const BOOL_TRUE = new Set(['1', 'igen', 'i', 'yes', 'y', 'true', 'x', 'van']);
const BOOL_FALSE = new Set(['0', 'nem', 'n', 'no', 'false', '', 'nincs']);

function csvBool(s) {
  const v = String(s ?? '').trim().toLowerCase();
  if (BOOL_TRUE.has(v)) return true;
  if (BOOL_FALSE.has(v)) return false;
  return null;
}

// "30x20x10", "30 x 20 x 10", "30*20*10" -> [30, 20, 10]
function csvDimensions(s) {
  const v = String(s || '').trim();
  if (!v) return [];
  const parts = v.split(/\s*[x×*]\s*/i).map((x) => csvNumber(x));
  return parts.length === 3 && parts.every((n) => Number.isFinite(n) && n >= 0) ? parts : null;
}

async function importProducts(ctx, text, commit) {
  const db = ctx.env.DB;
  const { headers, records } = parseCsv(text);
  if (!headers.length) throw badRequest('Üres a CSV fájl.');
  const hs = headers.map(normalizeHeader);
  const col = {};
  for (const [key, names] of Object.entries(PRODUCT_CSV)) {
    const hit = names.find((n) => hs.includes(n));
    if (hit) col[key] = hit;
  }
  const missing = [['partner', 'Ügyfélkód'], ['sku', 'Cikkszám']].filter(([k]) => !col[k]).map(([, l]) => l);
  if (missing.length) throw badRequest(`Hiányzó oszlop a CSV fájlban: ${missing.join(', ')}.`);
  if (records.length > MAX_IMPORT_ROWS) throw badRequest(`Egyszerre legfeljebb ${MAX_IMPORT_ROWS} sort importálhatsz.`);

  const partners = new Map((await all(db, "SELECT id, type, status, code FROM partners WHERE type = 'client'")).map((p) => [p.code.toUpperCase(), p]));
  const existingOf = new Map();
  const productsOf = async (partnerId) => {
    if (!existingOf.has(partnerId)) {
      const rows = await all(db, `SELECT id, partner_id, ${PRODUCT_COLUMNS.join(', ')} FROM products WHERE partner_id = ?`, partnerId);
      const map = new Map();
      for (const p of rows) map.set(p.sku.toUpperCase(), p);
      existingOf.set(partnerId, map);
    }
    return existingOf.get(partnerId);
  };

  const errors = [];
  const warnings = [];
  const ops = [];
  const seen = new Set();
  for (const rec of records) {
    const has = (k) => col[k] && String(rec[col[k]] ?? '').trim() !== '';
    const get = (k) => (col[k] ? String(rec[col[k]] ?? '').trim() : '');
    const problems = [];
    const partner = partners.get(get('partner').toUpperCase());
    if (!get('partner')) problems.push('Hiányzó ügyfélkód.');
    else if (!partner) problems.push(`Ismeretlen ügyfélkód: ${get('partner')}.`);
    else if (partner.status !== 'active') problems.push(`Inaktív ügyfél: ${partner.code}.`);
    const sku = get('sku');
    if (!sku) problems.push('Hiányzó cikkszám.');
    else if (sku.length > 120) problems.push('A cikkszám legfeljebb 120 karakter lehet.');
    const key = partner ? `${partner.id}|${sku.toUpperCase()}` : null;
    if (key && seen.has(key)) problems.push(`A(z) ${sku} cikkszám többször szerepel a fájlban.`);
    const existing = partner && sku ? (await productsOf(partner.id)).get(sku.toUpperCase()) : null;

    const changes = {};
    if (has('name')) {
      if (get('name').length > 200) problems.push('A megnevezés legfeljebb 200 karakter lehet.');
      else changes.name = get('name');
    } else if (!existing) problems.push('Új cikkhez kötelező a megnevezés.');
    if (has('ean')) {
      if (get('ean').length > 50) problems.push('Az EAN legfeljebb 50 karakter lehet.');
      else changes.ean = get('ean');
    }
    if (has('unit')) {
      if (get('unit').length > 20) problems.push('Az egység legfeljebb 20 karakter lehet.');
      else changes.unit = get('unit');
    }
    for (const [k, label] of [['weight_kg', 'súly'], ['width_cm', 'szélesség'], ['depth_cm', 'mélység'], ['height_cm', 'magasság']]) {
      if (!has(k)) continue;
      const n = csvNumber(get(k));
      if (!Number.isFinite(n) || n < 0 || n > 100000) problems.push(`Hibás ${label}: ${get(k)}.`);
      else changes[k] = n;
    }
    if (has('dimensions')) {
      const d = csvDimensions(get('dimensions'));
      if (!d) problems.push(`Hibás méretek: ${get('dimensions')}. Formátum: szélesség x mélység x magasság cm-ben, pl. 30x20x10.`);
      else [changes.width_cm, changes.depth_cm, changes.height_cm] = d;
    }
    if (has('min_stock')) {
      const n = csvNumber(get('min_stock'));
      if (!Number.isInteger(n) || n < 0 || n > MAX_QTY) problems.push(`Hibás minimum készlet: ${get('min_stock')}.`);
      else changes.min_stock = n;
    }
    for (const [k, label] of [['track_lot', 'sarzskövetés'], ['track_expiry', 'lejáratkövetés']]) {
      if (!col[k] || (!has(k) && existing)) continue;
      const b = csvBool(get(k));
      if (b === null) problems.push(`Hibás ${label}: ${get(k)}. Igen vagy nem értéket várunk.`);
      else changes[k] = b ? 1 : 0;
    }
    if (problems.length) {
      errors.push({ line: rec._line, message: problems.join(' ') });
      continue;
    }
    seen.add(key);
    if (changes.ean !== undefined) {
      const w = eanWarning(changes.ean);
      if (w) warnings.push({ line: rec._line, message: `${sku}: ${w}` });
    }
    if (existing) {
      const diff = Object.fromEntries(Object.entries(changes).filter(([k, v]) => existing[k] !== v));
      ops.push({ line: rec._line, kind: 'update', id: existing.id, sku: existing.sku, partner, changes: diff });
    } else {
      ops.push({ line: rec._line, kind: 'create', sku, partner, changes });
    }
  }
  const created = ops.filter((o) => o.kind === 'create').length;
  const updated = ops.filter((o) => o.kind === 'update').length;
  if (!commit) {
    return {
      rows: records.length, valid: ops.length, errors, warnings, created, updated,
      sample: ops.slice(0, 10).map((o) => ({ line: o.line, partner: o.partner.code, sku: o.sku, action: o.kind === 'create' ? 'új' : 'frissítés', name: o.changes.name || '' })),
    };
  }
  let imported = 0;
  let unchanged = 0;
  const at = nowIso();
  for (const o of ops) {
    try {
      if (o.kind === 'create') {
        const c = { unit: 'db', ean: '', min_stock: 0, track_lot: 0, track_expiry: 0, ...o.changes };
        await run(db,
          `INSERT INTO products (partner_id, sku, name, ean, unit, weight_kg, width_cm, depth_cm, height_cm, min_stock, track_lot, track_expiry, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          o.partner.id, o.sku, c.name, c.ean, c.unit, c.weight_kg ?? null, c.width_cm ?? null, c.depth_cm ?? null, c.height_cm ?? null,
          c.min_stock, c.track_lot, c.track_expiry, at, at);
      } else if (Object.keys(o.changes).length) {
        const keys = Object.keys(o.changes);
        await run(db, `UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => o.changes[k]), at, o.id);
      } else {
        unchanged++;
      }
      imported++;
    } catch (e) {
      errors.push({ line: o.line, message: /UNIQUE/i.test(String(e.message)) ? `A(z) ${o.sku} cikkszám már létezik.` : 'Nem sikerült menteni.' });
    }
  }
  if (imported) {
    await audit(ctx, { module: 'stock', action: 'import', entity: 'product', summary: `Cikktörzs CSV import: ${created} új, ${updated - unchanged} módosított cikk`, details: { created, updated, unchanged } });
  }
  return { imported, created, updated, unchanged, errors, warnings };
}

// ---------------------------------------------------------------- routes

export function register(r) {
  // ------------------------------------------------ stock overview
  r.get('/api/stock', async (ctx) => {
    const db = ctx.env.DB;
    const { limit, offset } = page(ctx.query);
    const f = stockWhere(ctx.query);
    const total = (await first(db, `SELECT COUNT(*) AS n ${STOCK_FROM} WHERE ${f.sql}`, ...f.args)).n;
    const items = await all(db, `SELECT ${STOCK_COLUMNS} ${STOCK_FROM} WHERE ${f.sql} ORDER BY pa.code, p.sku LIMIT ? OFFSET ?`, ...f.args, limit, offset);
    const sf = stockWhere(ctx.query, { withStatus: false });
    const summary = await first(db,
      `SELECT COUNT(*) AS products, COALESCE(SUM(COALESCE(st.on_hand, 0)), 0) AS on_hand,
              COALESCE(SUM(CASE WHEN ${STATUS} = 'low' THEN 1 ELSE 0 END), 0) AS low,
              COALESCE(SUM(CASE WHEN ${STATUS} = 'out' THEN 1 ELSE 0 END), 0) AS out
       ${STOCK_FROM} WHERE ${sf.sql}`, ...sf.args);
    return { items: items.map(shapeStock), total, limit, offset, summary };
  }, { perm: ['stock', 'view'] });

  r.get('/api/stock/export', async (ctx) => {
    const db = ctx.env.DB;
    const f = stockWhere(ctx.query);
    const rows = await all(db, `SELECT ${STOCK_COLUMNS} ${STOCK_FROM} WHERE ${f.sql} ORDER BY pa.code, p.sku LIMIT ?`, ...f.args, MAX_EXPORT);
    const csv = toCsv([
      { key: 'partner_code', label: 'Ügyfélkód' }, { key: 'partner_name', label: 'Ügyfél' }, { key: 'sku', label: 'Cikkszám' },
      { key: 'name', label: 'Megnevezés' }, { key: 'ean', label: 'EAN' }, { key: 'unit', label: 'Egység' },
      { key: 'on_hand', label: 'Készleten' }, { key: 'reserved', label: 'Foglalt' }, { key: 'blocked', label: 'Zárolt' },
      { key: 'available', label: 'Elérhető' }, { key: 'min_stock', label: 'Minimum készlet' },
      { key: 'status', label: 'Állapot', value: (r) => STOCK_STATUS[r.status] }, { key: 'locations', label: 'Helyek száma' },
      { key: 'next_expiry', label: 'Legkorábbi lejárat' },
    ], rows);
    return download(csv, csvFile('keszlet'), CSV_TYPE);
  }, { perm: ['stock', 'view'] });

  // One product: availability, stock by location and lot, reservations, last movements.
  r.get('/api/stock/product/:id', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const p = await first(db,
      `SELECT p.*, pa.code AS partner_code, pa.name AS partner_name FROM products p JOIN partners pa ON pa.id = p.partner_id WHERE p.id = ?`, id);
    if (!p) throw notFound('A termék nem található.');
    const a = (await availability(db, [id]))[id];
    const status = a.available <= 0 ? 'out' : a.available < p.min_stock ? 'low' : 'ok';
    const locations = await all(db,
      `SELECT s.id AS stock_id, s.location_id, l.code, l.zone, l.kind, z.code AS size_code, s.lot, s.expiry, s.qty, s.updated_at
       FROM stock s JOIN locations l ON l.id = s.location_id JOIN location_sizes z ON z.id = l.size_id
       WHERE s.product_id = ? AND s.qty > 0
       ORDER BY CASE WHEN s.expiry = '' THEN 1 ELSE 0 END, s.expiry, l.pick_sequence, l.code`, id);
    const reservations = await all(db,
      `SELECT o.id, o.number, o.status, o.customer_name, SUM(ol.qty - ol.picked_qty) AS qty
       FROM order_lines ol JOIN orders o ON o.id = ol.order_id
       WHERE ol.product_id = ? AND o.status IN ('new', 'hold', 'picking') AND ol.qty > ol.picked_qty
       GROUP BY o.id ORDER BY o.id LIMIT 50`, id);
    const incoming = await first(db,
      `SELECT COALESCE(SUM(CASE WHEN il.expected_qty > il.received_qty THEN il.expected_qty - il.received_qty ELSE 0 END), 0) AS n
       FROM inbound_lines il JOIN inbounds i ON i.id = il.inbound_id WHERE il.product_id = ? AND i.status IN ('expected', 'arrived', 'receiving')`, id);
    const movements = await all(db, `SELECT ${MOVEMENT_COLUMNS} ${MOVEMENT_FROM} WHERE m.product_id = ? ORDER BY m.id DESC LIMIT 50`, id);
    return {
      product: shapeProduct(p),
      availability: { ...a, incoming: incoming.n, status, status_label: STOCK_STATUS[status] },
      locations: locations.map((l) => ({ ...l, kind_label: LOCATION_KINDS[l.kind] || l.kind })),
      reservations,
      movements: movements.map(shapeMovement),
    };
  }, { perm: ['stock', 'view'] });

  // ------------------------------------------------ movements (ledger)
  r.get('/api/stock/movements', async (ctx) => {
    const db = ctx.env.DB;
    const { limit, offset } = page(ctx.query);
    const f = movementWhere(ctx.query);
    const sums = await first(db,
      `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN m.qty > 0 THEN m.qty ELSE 0 END), 0) AS qty_in,
              COALESCE(SUM(CASE WHEN m.qty < 0 THEN -m.qty ELSE 0 END), 0) AS qty_out
       ${MOVEMENT_FROM} WHERE ${f.sql}`, ...f.args);
    const items = await all(db, `SELECT ${MOVEMENT_COLUMNS} ${MOVEMENT_FROM} WHERE ${f.sql} ORDER BY m.id DESC LIMIT ? OFFSET ?`, ...f.args, limit, offset);
    return { items: items.map(shapeMovement), total: sums.n, limit, offset, sums: { in: sums.qty_in, out: sums.qty_out } };
  }, { perm: ['stock', 'view'] });

  r.get('/api/stock/movements/export', async (ctx) => {
    const db = ctx.env.DB;
    const f = movementWhere(ctx.query);
    const rows = await all(db, `SELECT ${MOVEMENT_COLUMNS} ${MOVEMENT_FROM} WHERE ${f.sql} ORDER BY m.id DESC LIMIT ?`, ...f.args, MAX_EXPORT);
    const csv = toCsv([
      { key: 'at', label: 'Időpont (UTC)' }, { key: 'date', label: 'Dátum' }, { key: 'type', label: 'Típus', value: (m) => MOVEMENT_TYPES[m.type] || m.type },
      { key: 'partner_code', label: 'Ügyfélkód' }, { key: 'sku', label: 'Cikkszám' }, { key: 'name', label: 'Megnevezés' },
      { key: 'location_code', label: 'Raktárhely' }, { key: 'lot', label: 'Sarzs' }, { key: 'expiry', label: 'Lejárat' },
      { key: 'qty', label: 'Mennyiség' }, { key: 'ref_type', label: 'Hivatkozás típusa', value: (m) => REF_TYPES[m.ref_type] || m.ref_type },
      { key: 'ref_number', label: 'Hivatkozás', value: (m) => m.ref_number || (m.ref_id ?? '') }, { key: 'user_name', label: 'Felhasználó' },
      { key: 'note', label: 'Megjegyzés' },
    ], rows);
    return download(csv, csvFile('keszletmozgasok'), CSV_TYPE);
  }, { perm: ['stock', 'view'] });

  // ------------------------------------------------ location occupancy
  r.get('/api/stock/locations', async (ctx) => {
    const db = ctx.env.DB;
    const { limit, offset } = page(ctx.query, 100, 1000);
    const f = locationWhere(ctx.query);
    const from = `FROM locations l JOIN location_sizes z ON z.id = l.size_id LEFT JOIN ${OCCUPANCY} occ ON occ.location_id = l.id
                  LEFT JOIN partners dp ON dp.id = l.partner_id LEFT JOIN partners op ON op.id = occ.partner_id`;
    const total = (await first(db, `SELECT COUNT(*) AS n ${from} WHERE ${f.sql}`, ...f.args)).n;
    const items = await all(db,
      `SELECT l.id, l.code, l.zone, l.kind, l.active, l.size_id, z.code AS size_code, z.name AS size_name,
              l.partner_id AS dedicated_partner_id, dp.code AS dedicated_partner_code, dp.name AS dedicated_partner_name,
              occ.partner_id AS occupant_id, op.code AS occupant_code, op.name AS occupant_name,
              COALESCE(occ.products, 0) AS products, COALESCE(occ.qty, 0) AS qty
       ${from} WHERE ${f.sql} ORDER BY l.zone, l.code LIMIT ? OFFSET ?`, ...f.args, limit, offset);
    const bySize = await all(db,
      `SELECT z.id AS size_id, z.code, z.name, COUNT(l.id) AS total,
              COALESCE(SUM(CASE WHEN occ.location_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS occupied,
              COALESCE(SUM(CASE WHEN occ.location_id IS NULL THEN 1 ELSE 0 END), 0) AS empty,
              COALESCE(SUM(CASE WHEN occ.location_id IS NULL AND l.partner_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS empty_dedicated
       FROM location_sizes z JOIN locations l ON l.size_id = z.id AND l.active = 1 AND l.kind = 'storage'
       LEFT JOIN ${OCCUPANCY} occ ON occ.location_id = l.id
       GROUP BY z.id ORDER BY z.sort, z.code`);
    const pairs = await all(db,
      `SELECT occ.partner_id, p.code, p.name, z.code AS size_code, COUNT(*) AS n
       FROM ${OCCUPANCY} occ JOIN locations l ON l.id = occ.location_id JOIN location_sizes z ON z.id = l.size_id JOIN partners p ON p.id = occ.partner_id
       WHERE l.kind = 'storage' GROUP BY occ.partner_id, z.id ORDER BY p.name`);
    const byPartner = [];
    for (const row of pairs) {
      let e = byPartner.find((x) => x.partner_id === row.partner_id);
      if (!e) byPartner.push(e = { partner_id: row.partner_id, code: row.code, name: row.name, sizes: {}, total: 0 });
      e.sizes[row.size_code] = row.n;
      e.total += row.n;
    }
    return {
      items: items.map((l) => ({ ...l, active: !!l.active, kind_label: LOCATION_KINDS[l.kind] || l.kind })),
      total, limit, offset,
      summary: { bySize, byPartner },
    };
  }, { perm: ['stock', 'view'] });

  // Warehouse map (Készlet > Térkép): every location with its occupant in compact rows, and the
  // partners they name. One location holds one client's goods at a time.
  r.get('/api/stock/map', async (ctx) => {
    const db = ctx.env.DB;
    const rows = await all(db,
      `SELECT l.id, l.code, l.zone, z.code AS size_code, l.kind, l.active, l.partner_id AS dedicated_id,
              occ.partner_id AS occupant_id, COALESCE(occ.products, 0) AS products, COALESCE(occ.qty, 0) AS qty
       FROM locations l JOIN location_sizes z ON z.id = l.size_id LEFT JOIN ${OCCUPANCY} occ ON occ.location_id = l.id
       ORDER BY l.zone, l.code`);
    const ids = [...new Set(rows.flatMap((r) => [r.dedicated_id, r.occupant_id]).filter(Boolean))];
    const partners = ids.length
      ? await all(db, 'SELECT id, code, name FROM partners WHERE id IN (SELECT value FROM json_each(?)) ORDER BY name', JSON.stringify(ids))
      : [];
    return {
      columns: ['id', 'code', 'zone', 'size', 'kind', 'active', 'dedicated', 'occupant', 'products', 'qty'],
      rows: rows.map((r) => [r.id, r.code, r.zone, r.size_code, r.kind, r.active ? 1 : 0, r.dedicated_id, r.occupant_id, r.products, r.qty]),
      partners: partners.map((p) => ({ id: p.id, code: p.code, name: p.name })),
    };
  }, { perm: ['stock', 'view'] });

  // One location: its data, what lies on it (product, lot, expiry, quantity) and its last movement.
  r.get('/api/stock/locations/:id', async (ctx) => {
    const db = ctx.env.DB;
    const id = Number(ctx.params.id);
    const loc = Number.isInteger(id) && id > 0 ? await first(db,
      `SELECT l.id, l.code, l.zone, l.kind, l.active, l.note, z.code AS size_code, z.name AS size_name,
              dp.id AS dedicated_id, dp.code AS dedicated_code, dp.name AS dedicated_name
       FROM locations l JOIN location_sizes z ON z.id = l.size_id LEFT JOIN partners dp ON dp.id = l.partner_id
       WHERE l.id = ?`, id) : null;
    if (!loc) throw notFound('A raktárhely nem található.');
    const stock = await all(db,
      `SELECT s.product_id, p.sku, p.name, p.unit, pa.id AS partner_id, pa.code AS partner_code, pa.name AS partner_name, s.lot, s.expiry, s.qty
       FROM stock s JOIN products p ON p.id = s.product_id JOIN partners pa ON pa.id = p.partner_id
       WHERE s.location_id = ? AND s.qty > 0 ORDER BY p.sku, s.expiry, s.lot`, id);
    const last = await first(db, 'SELECT at, type FROM movements WHERE location_id = ? ORDER BY id DESC LIMIT 1', id);
    return {
      location: { ...loc, active: !!loc.active, kind_label: LOCATION_KINDS[loc.kind] || loc.kind },
      stock,
      last_movement: last ? { ...last, type_label: MOVEMENT_TYPES[last.type] || last.type } : null,
    };
  }, { perm: ['stock', 'view'] });

  // ------------------------------------------------ transfer and adjustment
  r.post('/api/stock/transfer', async (ctx) => {
    const db = ctx.env.DB;
    const data = validate(await ctx.body(), {
      product_id: { type: 'id', required: true },
      from_location_id: { type: 'id', required: true },
      to_location_id: { type: 'id', nullable: true },
      to_location_code: { type: 'str', max: 60 },
      qty: { type: 'int', required: true, min: 1, max: MAX_QTY },
      lot: { type: 'str', max: 80, default: '' },
      expiry: { type: 'date', nullable: true },
      note: { type: 'str', max: 300, default: '' },
    });
    data.expiry = data.expiry || '';
    const product = await first(db, 'SELECT id, sku, unit FROM products WHERE id = ?', data.product_id);
    if (!product) throw badRequest('Ismeretlen termék.', { product_id: 'Ismeretlen termék.' });
    const from = await getLocation(db, data.from_location_id);
    let to;
    if (data.to_location_id) to = await getLocation(db, data.to_location_id);
    else if (data.to_location_code) {
      to = await locationByCode(db, data.to_location_code);
      if (!to) throw badRequest(`Ismeretlen raktárhely: ${data.to_location_code}.`, { to_location_code: 'Ismeretlen raktárhely.' });
    } else throw badRequest('Add meg a cél raktárhelyet.', { to_location_code: 'Kötelező mező.' });
    if (to.id === from.id) throw badRequest('A cél raktárhely nem lehet ugyanaz, mint a forrás.', { to_location_code: 'Válassz másik helyet.' });
    const row = await first(db, 'SELECT qty FROM stock WHERE product_id = ? AND location_id = ? AND lot = ? AND expiry = ?', product.id, from.id, data.lot, data.expiry);
    if (!row) throw badRequest(`Nincs ${product.sku} készlet a(z) ${from.code} helyen ezzel a sarzzsal.`);
    if (row.qty < data.qty) throw conflict(`A(z) ${from.code} helyen csak ${row.qty} ${product.unit || 'db'} van.`, { qty: `Legfeljebb ${row.qty}.` });
    await transferStock(ctx, {
      productId: product.id, fromLocationId: from.id, toLocationId: to.id, qty: data.qty, lot: data.lot, expiry: data.expiry,
      refType: 'manual', note: data.note,
    });
    await audit(ctx, {
      module: 'stock', action: 'edit', entity: 'product', entityId: product.id,
      summary: `Áttárolás: ${data.qty} ${product.unit || 'db'} ${product.sku}${data.lot ? ` (sarzs ${data.lot})` : ''}, ${from.code} -> ${to.code}`,
      details: { from: from.code, to: to.code, qty: data.qty, lot: data.lot, expiry: data.expiry, note: data.note },
    });
    return { ok: true, from: from.code, to: to.code };
  }, { perm: ['stock', 'edit'] });

  // Manual correction with a mandatory reason. mode: set (to a counted quantity), add, remove.
  r.post('/api/stock/adjust', async (ctx) => {
    const db = ctx.env.DB;
    const data = validate(await ctx.body(), {
      product_id: { type: 'id', required: true },
      location_id: { type: 'id', nullable: true },
      location_code: { type: 'str', max: 60 },
      mode: { type: 'enum', values: ['set', 'add', 'remove'], default: 'set' },
      qty: { type: 'int', required: true, min: 0, max: MAX_QTY },
      lot: { type: 'str', max: 80, default: '' },
      expiry: { type: 'date', nullable: true },
      reason: { type: 'str', required: true, max: 300 },
    });
    if (!realDate(data.expiry)) throw badRequest('Ellenőrizd a megjelölt mezőket.', { expiry: 'Nem létező dátum.' });
    const reason = data.reason.trim();
    if (reason.length < 3) throw badRequest('Írd le a korrekció okát.', { reason: 'Legalább 3 karakter.' });
    const product = await first(db, 'SELECT id, partner_id, sku, unit, track_lot, track_expiry FROM products WHERE id = ?', data.product_id);
    if (!product) throw badRequest('Ismeretlen termék.', { product_id: 'Ismeretlen termék.' });
    let loc;
    if (data.location_id) loc = await getLocation(db, data.location_id);
    else if (data.location_code) {
      loc = await locationByCode(db, data.location_code);
      if (!loc) throw badRequest(`Ismeretlen raktárhely: ${data.location_code}.`, { location_code: 'Ismeretlen raktárhely.' });
    } else throw badRequest('Add meg a raktárhelyet.', { location_code: 'Kötelező mező.' });
    const lot = data.lot;
    const expiry = data.expiry || '';
    const row = await first(db, 'SELECT qty FROM stock WHERE product_id = ? AND location_id = ? AND lot = ? AND expiry = ?', product.id, loc.id, lot, expiry);
    const before = row ? row.qty : 0;
    if (data.mode !== 'set' && data.qty < 1) throw badRequest('A mennyiség legalább 1 legyen.', { qty: 'Legalább 1.' });
    if (data.mode === 'remove' && data.qty > before) throw conflict(`A(z) ${loc.code} helyen csak ${before} ${product.unit || 'db'} van ebből.`, { qty: `Legfeljebb ${before}.` });
    const target = data.mode === 'set' ? data.qty : data.mode === 'add' ? before + data.qty : before - data.qty;
    if (target > before && !row) {
      if (product.track_lot && !lot) throw badRequest(`A(z) ${product.sku} sarzskövetett termék: add meg a sarzsszámot.`, { lot: 'Kötelező ennél a terméknél.' });
      if (product.track_expiry && !expiry) throw badRequest(`A(z) ${product.sku} lejáratkövetett termék: add meg a lejáratot.`, { expiry: 'Kötelező ennél a terméknél.' });
    }
    if (target === before) throw badRequest(`A(z) ${loc.code} helyen már most is ${before} ${product.unit || 'db'} van, nincs mit korrigálni.`, { qty: 'Nincs változás.' });
    const note = `Kézi korrekció: ${reason}`;
    let diff;
    if (data.mode === 'set') diff = await setStockQty(ctx, { productId: product.id, locationId: loc.id, qty: target, lot, expiry, refType: 'manual', note });
    else if (data.mode === 'add') { await addStock(ctx, { productId: product.id, locationId: loc.id, qty: data.qty, lot, expiry, type: 'adjust', refType: 'manual', note }); diff = data.qty; }
    else { await removeStock(ctx, { productId: product.id, locationId: loc.id, qty: data.qty, lot, expiry, type: 'adjust', refType: 'manual', note }); diff = -data.qty; }
    await audit(ctx, {
      module: 'stock', action: 'approve', entity: 'product', entityId: product.id,
      summary: `Készletkorrekció: ${product.sku} ${loc.code}${lot ? ` (sarzs ${lot})` : ''}: ${before} -> ${before + diff} ${product.unit || 'db'}. Indok: ${reason}`,
      details: { location: loc.code, lot, expiry, before, after: before + diff, diff, reason },
    });
    return { ok: true, before, after: before + diff, diff };
  }, { perm: ['stock', 'approve'] });

  // ------------------------------------------------ Cikktörzs
  const productListWhere = (q) => {
    const where = ['1 = 1'];
    const args = [];
    const partner = intParam(q.get('partner_id'));
    if (partner) { where.push('p.partner_id = ?'); args.push(partner); }
    const active = q.get('active') ?? '1';
    if (active === '1') where.push('p.active = 1');
    if (active === '0') where.push('p.active = 0');
    const text = (q.get('q') || '').trim();
    if (text) { where.push("(p.sku LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR p.ean LIKE ? ESCAPE '\\')"); args.push(like(text), like(text), like(text)); }
    if (q.get('tracking') === 'lot') where.push('p.track_lot = 1');
    if (q.get('tracking') === 'expiry') where.push('p.track_expiry = 1');
    return { sql: where.join(' AND '), args };
  };
  const PRODUCT_SELECT = `SELECT p.id, p.partner_id, pa.code AS partner_code, pa.name AS partner_name, p.sku, p.name, p.ean, p.unit, p.weight_kg,
      p.width_cm, p.depth_cm, p.height_cm, p.min_stock, p.track_lot, p.track_expiry, p.active, p.notes, p.created_at, p.updated_at,
      COALESCE((SELECT SUM(s.qty) FROM stock s WHERE s.product_id = p.id), 0) AS on_hand
    FROM products p JOIN partners pa ON pa.id = p.partner_id`;

  r.get('/api/products', async (ctx) => {
    const db = ctx.env.DB;
    const { limit, offset } = page(ctx.query);
    const f = productListWhere(ctx.query);
    const total = (await first(db, `SELECT COUNT(*) AS n FROM products p WHERE ${f.sql}`, ...f.args)).n;
    const items = await all(db, `${PRODUCT_SELECT} WHERE ${f.sql} ORDER BY pa.code, p.sku LIMIT ? OFFSET ?`, ...f.args, limit, offset);
    return { items: items.map(shapeProduct), total, limit, offset };
  }, { perm: ['stock', 'view'] });

  // Same columns as the import, so an export can be edited and imported back.
  r.get('/api/products/export', async (ctx) => {
    const db = ctx.env.DB;
    const f = productListWhere(ctx.query);
    const rows = await all(db, `${PRODUCT_SELECT} WHERE ${f.sql} ORDER BY pa.code, p.sku LIMIT ?`, ...f.args, MAX_EXPORT);
    const yes = (v) => (v ? 'igen' : 'nem');
    const num = (v) => (v == null ? '' : String(v).replace('.', ','));
    const csv = toCsv([
      { key: 'partner_code', label: 'Ügyfélkód' }, { key: 'sku', label: 'Cikkszám' }, { key: 'name', label: 'Megnevezés' },
      { key: 'ean', label: 'EAN' }, { key: 'unit', label: 'Egység' }, { key: 'weight_kg', label: 'Súly (kg)', value: (p) => num(p.weight_kg) },
      { key: 'width_cm', label: 'Szélesség (cm)', value: (p) => num(p.width_cm) }, { key: 'depth_cm', label: 'Mélység (cm)', value: (p) => num(p.depth_cm) },
      { key: 'height_cm', label: 'Magasság (cm)', value: (p) => num(p.height_cm) }, { key: 'min_stock', label: 'Minimum készlet' },
      { key: 'track_lot', label: 'Sarzskövetés', value: (p) => yes(p.track_lot) }, { key: 'track_expiry', label: 'Lejáratkövetés', value: (p) => yes(p.track_expiry) },
      { key: 'active', label: 'Aktív', value: (p) => yes(p.active) }, { key: 'on_hand', label: 'Készleten' },
    ], rows);
    return download(csv, csvFile('cikktorzs'), CSV_TYPE);
  }, { perm: ['stock', 'view'] });

  r.post('/api/products/import', async (ctx) => {
    const { file, form } = await readUpload(ctx);
    const preview = String(form.get('preview') ?? '1') !== '0';
    return importProducts(ctx, await file.text(), !preview);
  }, { perm: ['stock', 'create'] });

  r.get('/api/products/:id', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const p = await first(db, `${PRODUCT_SELECT} WHERE p.id = ?`, id);
    if (!p) throw notFound('A termék nem található.');
    const usage = await productUsage(db, id);
    return { ...shapeProduct(p), usage, can_deactivate: !!p.active && !usage.on_hand && !usage.open_inbound && !usage.open_order };
  }, { perm: ['stock', 'view'] });

  r.post('/api/products', async (ctx) => {
    const db = ctx.env.DB;
    const data = normalizeProduct(validate(await ctx.body(), PRODUCT_FIELDS));
    const partner = await clientPartner(db, data.partner_id);
    await assertSkuFree(db, partner.id, data.sku);
    const warnings = await productWarnings(db, data);
    const at = nowIso();
    const res = await run(db,
      `INSERT INTO products (partner_id, ${PRODUCT_COLUMNS.join(', ')}, created_at, updated_at) VALUES (?, ${PRODUCT_COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
      partner.id, ...PRODUCT_COLUMNS.map((k) => data[k] ?? null), at, at);
    const id = res.meta.last_row_id;
    await audit(ctx, { module: 'stock', action: 'create', entity: 'product', entityId: id, summary: `Új cikk: ${data.sku} ${data.name} (${partner.code})` });
    return { id, warnings };
  }, { perm: ['stock', 'create'] });

  // Partial update. The client (partner) of a product never changes: its movements belong to it.
  r.patch('/api/products/:id', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const body = await ctx.body();
    if (body.partner_id !== undefined) {
      const cur = await first(db, 'SELECT partner_id FROM products WHERE id = ?', id);
      if (cur && Number(body.partner_id) !== cur.partner_id) throw badRequest('A cikk ügyfele nem módosítható. Vegyél fel új cikket a másik ügyfélnél.', { partner_id: 'Nem módosítható.' });
    }
    const data = normalizeProduct(validate(body, EDIT_FIELDS, { partial: true }));
    const p = await first(db, 'SELECT * FROM products WHERE id = ?', id);
    if (!p) throw notFound('A termék nem található.');
    if (data.sku !== undefined && data.sku !== p.sku) await assertSkuFree(db, p.partner_id, data.sku, id);
    const changes = {};
    for (const [k, v] of Object.entries(data)) {
      const cur = ['track_lot', 'track_expiry'].includes(k) ? !!p[k] : p[k];
      if (cur !== v) changes[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
    }
    const warnings = await productWarnings(db, { ...p, ...data }, id);
    if (!Object.keys(changes).length) return { ok: true, id, warnings, changed: [] };
    const keys = Object.keys(changes);
    await run(db, `UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => changes[k]), nowIso(), id);
    await audit(ctx, {
      module: 'stock', action: 'edit', entity: 'product', entityId: id, summary: `Cikk módosítva: ${changes.sku || p.sku} (${keys.join(', ')})`,
      details: { before: Object.fromEntries(keys.map((k) => [k, p[k]])), after: changes },
    });
    return { ok: true, id, warnings, changed: keys };
  }, { perm: ['stock', 'edit'] });

  // Inactive products cannot be ordered or received. Only without stock and open documents.
  r.post('/api/products/:id/deactivate', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const p = await first(db, 'SELECT id, sku, active FROM products WHERE id = ?', id);
    if (!p) throw notFound('A termék nem található.');
    if (!p.active) return { ok: true };
    const usage = await productUsage(db, id);
    if (usage.on_hand > 0) throw conflict(`A(z) ${p.sku} nem inaktiválható, amíg van belőle készlet (${usage.on_hand} db).`);
    if (usage.open_inbound) throw conflict(`A(z) ${p.sku} szerepel egy nyitott betárolásban (${usage.open_inbound}). Előbb zárd le vagy sztornózd.`);
    if (usage.open_order) throw conflict(`A(z) ${p.sku} szerepel egy nyitott rendelésben (${usage.open_order}). Előbb teljesítsd vagy sztornózd.`);
    const res = await run(db, 'UPDATE products SET active = 0, updated_at = ? WHERE id = ? AND active = 1 AND NOT EXISTS (SELECT 1 FROM stock WHERE product_id = ? AND qty > 0)', nowIso(), id, id);
    if (res.meta.changes !== 1) throw conflict('A cikk közben megváltozott. Frissítsd az oldalt.');
    await audit(ctx, { module: 'stock', action: 'delete', entity: 'product', entityId: id, summary: `Cikk inaktiválva: ${p.sku}` });
    return { ok: true };
  }, { perm: ['stock', 'delete'] });

  r.post('/api/products/:id/activate', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const p = await first(db, 'SELECT id, sku, active, partner_id FROM products WHERE id = ?', id);
    if (!p) throw notFound('A termék nem található.');
    if (p.active) return { ok: true };
    await clientPartner(db, p.partner_id);
    await run(db, 'UPDATE products SET active = 1, updated_at = ? WHERE id = ?', nowIso(), id);
    await audit(ctx, { module: 'stock', action: 'delete', entity: 'product', entityId: id, summary: `Cikk újra aktív: ${p.sku}` });
    return { ok: true };
  }, { perm: ['stock', 'delete'] });
}
