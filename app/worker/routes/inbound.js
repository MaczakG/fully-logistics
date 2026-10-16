// Betárolás: inbounds (ASN), receiving, putaway, CSV import. Prefix /api/inbound
//
// Workflow (labels in STATUSES.inbound):
//   expected  -> arrived     POST /:id/arrive    pallets, cartons, arrival note
//   arrived   -> receiving   first count on a line (scan or manual); counting on an expected inbound
//                            also marks it arrived
//   receiving                POST /:id/putaway   goods go into stock through addStock(type inbound)
//   arrived/receiving -> completed   POST /:id/complete, with a discrepancy only with inbound:approve
//   expected/arrived/receiving -> cancelled   POST /:id/cancel, only before anything was put away
//
// received_qty is every piece that arrived on a line, damaged_qty the damaged part of it. Every
// received piece should be put away (damaged ones to a quarantine location). A line is a
// discrepancy when received differs from expected, something is damaged or not all of it was put away.
//
// Receiving counts are not stock yet, so single scans are not written to the audit log one by one:
// the log gets the start of receiving, manual corrections, added lines, every putaway and the
// closing summary with the final quantities of every line.

import { all, batch, first, marks, run, stmt } from '../lib/db.js';
import { badRequest, conflict, forbidden, notFound, page } from '../lib/http.js';
import { validate, validateList } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { can } from '../lib/perm.js';
import { STATUSES } from '../lib/constants.js';
import { createInbound, INBOUND_FIELDS, INBOUND_LINE_FIELDS } from '../lib/inbound-create.js';
import { addStock, locationByCode, location as getLocation, suggestLocation } from '../lib/stock.js';
import { normalizeHeader, parseCsv } from '../lib/csv.js';
import { readUpload } from '../lib/files.js';
import { budapestDate, isDate, nowIso } from '../lib/time.js';

const OPEN = ['expected', 'arrived', 'receiving'];
const EDITABLE = ['expected', 'arrived'];
const CLOSABLE = ['arrived', 'receiving'];
const PUTAWAY_KINDS = ['storage', 'quarantine'];
const MAX_QTY = 1000000;
const MAX_IMPORT_ROWS = 5000;

const inList = (list) => list.map((s) => `'${s}'`).join(', ');
const statusLabel = (s) => (STATUSES.inbound[s] ? STATUSES.inbound[s].label : s);
const intParam = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const dateParam = (v) => (isDate(v) ? v : null);
// LIKE pattern for user text; use with ESCAPE '\'.
const like = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
// isDate() lets "2027-02-31" through (Date.parse rolls it over), so dates are also checked here.
const realDate = (s) => !s || (isDate(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s);
function checkDates(fields) {
  const errors = {};
  for (const [k, v] of Object.entries(fields)) if (v && !realDate(v)) errors[k] = 'Nem létező dátum.';
  if (Object.keys(errors).length) throw badRequest('Ellenőrizd a megjelölt mezőket.', errors);
}
const lineDates = (h, lines) => checkDates({ expected_date: h.expected_date, ...Object.fromEntries(lines.map((l, i) => [`lines.${i}.expiry`, l.expiry])) });

function idParam(ctx, key = 'id') {
  const id = intParam(ctx.params[key]);
  if (!id) throw notFound(key === 'id' ? 'A betárolás nem található.' : 'A tétel nem található.');
  return id;
}

async function loadInbound(db, id) {
  const row = await first(db, 'SELECT * FROM inbounds WHERE id = ?', id);
  if (!row) throw notFound('A betárolás nem található.');
  return row;
}

async function loadLine(db, inboundId, lineId) {
  const row = await first(db, 'SELECT * FROM inbound_lines WHERE id = ? AND inbound_id = ?', lineId, inboundId);
  if (!row) throw notFound('A tétel nem található ebben a betárolásban.');
  return row;
}

function requireStatus(inb, allowed, what) {
  if (!allowed.includes(inb.status)) {
    throw conflict(`A(z) ${inb.number} betárolás „${statusLabel(inb.status)}” állapotban van, ${what}.`);
  }
}

// Guard used inside batches, so a status change by someone else in the meantime stops the write.
const statusGuard = (statuses) => `EXISTS (SELECT 1 FROM inbounds WHERE id = ? AND status IN (${inList(statuses)}))`;

// ---------------------------------------------------------------- lines and discrepancies

const LINE_SELECT = `
  SELECT l.id, l.inbound_id, l.product_id, l.expected_qty, l.received_qty, l.damaged_qty, l.lot, l.expiry, l.location_id,
         l.putaway_qty, l.note, l.received_at, pr.sku, pr.name, pr.ean, pr.unit, pr.track_lot, pr.track_expiry,
         pr.active AS product_active, lo.code AS location_code, ru.name AS received_by_name
  FROM inbound_lines l
  JOIN products pr ON pr.id = l.product_id
  LEFT JOIN locations lo ON lo.id = l.location_id
  LEFT JOIN users ru ON ru.id = l.received_by`;

// Differences that make a line a discrepancy (open putaway is listed separately).
function lineIssues(l) {
  const out = [];
  const unit = l.unit || 'db';
  if (l.expected_qty === 0 && l.received_qty > 0) out.push({ kind: 'unexpected', qty: l.received_qty, text: `nem várt tétel, ${l.received_qty} ${unit}` });
  else if (l.received_qty < l.expected_qty) out.push({ kind: 'short', qty: l.expected_qty - l.received_qty, text: `hiány ${l.expected_qty - l.received_qty} ${unit}` });
  else if (l.received_qty > l.expected_qty) out.push({ kind: 'over', qty: l.received_qty - l.expected_qty, text: `többlet ${l.received_qty - l.expected_qty} ${unit}` });
  if (l.damaged_qty > 0) out.push({ kind: 'damaged', qty: l.damaged_qty, text: `sérült ${l.damaged_qty} ${unit}` });
  return out;
}

function shapeLine(l) {
  return {
    ...l,
    track_lot: !!l.track_lot,
    track_expiry: !!l.track_expiry,
    product_active: !!l.product_active,
    open_qty: l.received_qty - l.putaway_qty,
    issues: lineIssues(l),
  };
}

const hasDiscrepancy = (l) => l.received_qty !== l.expected_qty || l.damaged_qty > 0 || l.putaway_qty < l.received_qty;

async function lineView(db, lineId) {
  const l = await first(db, `${LINE_SELECT} WHERE l.id = ?`, lineId);
  if (!l) return null;
  const line = shapeLine(l);
  line.putaways = await all(db,
    `SELECT pa.qty, pa.at, lo.code AS location_code, lo.kind AS location_kind, u.name AS user_name
     FROM inbound_putaways pa JOIN locations lo ON lo.id = pa.location_id LEFT JOIN users u ON u.id = pa.user_id
     WHERE pa.line_id = ? ORDER BY pa.id`, lineId);
  return line;
}

// A quarantine location that can take this partner's goods (empty, or already holding theirs).
const quarantineFor = (db, partnerId) => first(db,
  `SELECT l.id, l.code FROM locations l
   WHERE l.kind = 'quarantine' AND l.active = 1 AND (l.partner_id IS NULL OR l.partner_id = ?)
     AND NOT EXISTS (SELECT 1 FROM stock s JOIN products p ON p.id = s.product_id
                     WHERE s.location_id = l.id AND s.qty > 0 AND p.partner_id <> ?)
   ORDER BY l.pick_sequence, l.code LIMIT 1`, partnerId, partnerId);

// Product of the partner by id, SKU or barcode (EAN, also with or without leading zeros).
async function findProducts(db, partnerId, code) {
  const c = String(code || '').trim();
  if (!c) return [];
  const numeric = /^\d+$/.test(c);
  return all(db,
    `SELECT id, sku, name, ean, unit, active, track_lot, track_expiry FROM products
     WHERE partner_id = ? AND (sku = ? COLLATE NOCASE OR ean = ? OR (? = 1 AND ean <> '' AND ltrim(ean, '0') = ltrim(?, '0')))
     ORDER BY active DESC, id`,
    partnerId, c, c, numeric ? 1 : 0, c);
}

// ---------------------------------------------------------------- list

function listWhere(q, { withStatus = true } = {}) {
  const where = ['1 = 1'];
  const args = [];
  const partner = intParam(q.get('partner_id'));
  if (partner) { where.push('i.partner_id = ?'); args.push(partner); }
  const supplier = intParam(q.get('supplier_id'));
  if (supplier) { where.push('i.supplier_id = ?'); args.push(supplier); }
  const text = (q.get('q') || '').trim();
  if (text) { where.push("(i.number LIKE ? ESCAPE '\\' OR i.external_ref LIKE ? ESCAPE '\\')"); args.push(like(text), like(text)); }
  const from = dateParam(q.get('from'));
  if (from) { where.push('i.expected_date >= ?'); args.push(from); }
  const to = dateParam(q.get('to'));
  if (to) { where.push('i.expected_date <= ?'); args.push(to); }
  if (q.get('discrepancy') === '1') where.push('i.has_discrepancy = 1');
  const closedFrom = dateParam(q.get('closed_from'));
  if (closedFrom) { where.push('i.completed_at >= ?'); args.push(closedFrom); }
  if (withStatus) {
    const status = q.get('status');
    if (status === 'open') where.push(`i.status IN (${inList(OPEN)})`);
    else if (status && STATUSES.inbound[status]) { where.push('i.status = ?'); args.push(status); }
  }
  return { sql: where.join(' AND '), args };
}

async function kpis(db) {
  const today = budapestDate();
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const row = await first(db,
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'expected' AND expected_date = ? THEN 1 ELSE 0 END), 0) AS expected_today,
       COALESCE(SUM(CASE WHEN status = 'expected' AND expected_date < ? THEN 1 ELSE 0 END), 0) AS overdue,
       COALESCE(SUM(CASE WHEN status = 'arrived' THEN 1 ELSE 0 END), 0) AS arrived,
       COALESCE(SUM(CASE WHEN status = 'receiving' THEN 1 ELSE 0 END), 0) AS receiving,
       COALESCE(SUM(CASE WHEN status = 'completed' AND has_discrepancy = 1 AND completed_at >= ? THEN 1 ELSE 0 END), 0) AS discrepancy_30d
     FROM inbounds WHERE status IN ('expected', 'arrived', 'receiving') OR completed_at >= ?`,
    today, today, since, since);
  return { ...row, today, discrepancy_since: since.slice(0, 10) };
}

// ---------------------------------------------------------------- input checks

const HEADER_FIELDS = (({ source, ...rest }) => rest)(INBOUND_FIELDS);
const MANUAL_QTY = { expected_qty: { type: 'int', required: true, min: 1, max: MAX_QTY } };

async function checkPartners(db, h) {
  const partner = await first(db, 'SELECT id, type, status, code, name FROM partners WHERE id = ?', h.partner_id);
  if (!partner || partner.type !== 'client') throw badRequest('Ismeretlen ügyfél.', { partner_id: 'Válassz ügyfelet.' });
  if (partner.status !== 'active') throw badRequest('Az ügyfél inaktív.', { partner_id: 'Inaktív ügyfél.' });
  if (h.supplier_id) {
    const s = await first(db, "SELECT id FROM partners WHERE id = ? AND type = 'supplier'", h.supplier_id);
    if (!s) throw badRequest('Ismeretlen beszállító.', { supplier_id: 'Válassz beszállítót.' });
  }
  return partner;
}

// Resolves product_id / sku of each line within the partner. Unknown and (unless allowed) inactive
// products are field errors keyed "lines.i.sku".
async function resolveLines(db, partnerId, lines, { allowInactive = new Set() } = {}) {
  const ids = lines.filter((l) => l.product_id).map((l) => l.product_id);
  const skus = lines.filter((l) => !l.product_id && l.sku).map((l) => l.sku);
  const found = [];
  if (ids.length) found.push(...await all(db, `SELECT id, sku, active FROM products WHERE partner_id = ? AND id IN (${marks(ids.length)})`, partnerId, ...ids));
  if (skus.length) found.push(...await all(db, `SELECT id, sku, active FROM products WHERE partner_id = ? AND sku IN (${marks(skus.length)})`, partnerId, ...skus));
  const byId = new Map(found.map((p) => [p.id, p]));
  const bySku = new Map(found.map((p) => [p.sku, p]));
  const errors = {};
  const out = lines.map((l, i) => {
    const p = l.product_id ? byId.get(l.product_id) : bySku.get(l.sku);
    if (!p) errors[`lines.${i}.${l.product_id ? 'product_id' : 'sku'}`] = l.sku ? `Ismeretlen cikkszám ennél az ügyfélnél: ${l.sku}` : 'Ismeretlen termék ennél az ügyfélnél.';
    else if (!p.active && !allowInactive.has(p.id)) errors[`lines.${i}.sku`] = `Inaktív cikk: ${p.sku}`;
    return p ? { ...l, product_id: p.id, sku: p.sku } : l;
  });
  if (Object.keys(errors).length) throw badRequest('Ellenőrizd a betárolás tételeit.', errors);
  return out;
}

// The same product with the same lot and expiry may only be on one line.
function assertUniqueLines(lines) {
  const errors = {};
  const keys = new Set();
  lines.forEach((l, i) => {
    const k = `${l.product_id}|${l.lot || ''}|${l.expiry || ''}`;
    if (keys.has(k)) errors[`lines.${i}.sku`] = 'Ez a termék ezzel a sarzzsal már szerepel egy másik sorban.';
    keys.add(k);
  });
  if (Object.keys(errors).length) throw badRequest('Ellenőrizd a betárolás tételeit.', errors);
}

// ---------------------------------------------------------------- receiving

// Applies a count to a line. data: add / damaged_add (scanner deltas, concurrent scans add up) or
// received_qty / damaged_qty (absolute, from the edit form), lot, expiry, note.
async function receiveLine(ctx, inb, line, data, { auditIt = true } = {}) {
  const db = ctx.env.DB;
  requireStatus(inb, OPEN, 'már nem vehető át rá áru');
  const absolute = data.received_qty != null || data.damaged_qty != null;
  let addR = 0;
  let addD = 0;
  if (data.received_qty != null) addR = data.received_qty - line.received_qty;
  if (data.damaged_qty != null) addD = data.damaged_qty - line.damaged_qty;
  if (data.add != null) addR += data.add;
  if (data.damaged_add != null) addD += data.damaged_add;
  const newR = line.received_qty + addR;
  const newD = line.damaged_qty + addD;
  if (newR < 0) throw badRequest('Az átvett mennyiség nem lehet negatív.', { received_qty: 'Nem lehet negatív.' });
  if (newR > MAX_QTY) throw badRequest('Túl nagy mennyiség.', { received_qty: `Legfeljebb ${MAX_QTY} lehet.` });
  if (newR < line.putaway_qty) {
    throw conflict(`Ebből a tételből már ${line.putaway_qty} ${line.unit || 'db'} polcra került, az átvett mennyiség ennél nem lehet kevesebb.`, { received_qty: `Legalább ${line.putaway_qty}.` });
  }
  if (newD < 0) throw badRequest('A sérült mennyiség nem lehet negatív.', { damaged_qty: 'Nem lehet negatív.' });
  if (newD > newR) throw badRequest('A sérült mennyiség nem lehet több az átvettnél.', { damaged_qty: 'Nem lehet több az átvettnél.' });

  const lot = data.lot !== undefined ? data.lot : line.lot;
  const expiry = data.expiry !== undefined ? data.expiry || '' : line.expiry;
  const trackingChanged = lot !== line.lot || expiry !== line.expiry;
  if (trackingChanged && line.putaway_qty > 0) {
    throw conflict('A sarzs és a lejárat már nem módosítható, mert ebből a tételből került áru polcra.', { lot: 'Már nem módosítható.' });
  }
  if (trackingChanged) {
    const twin = await first(db, 'SELECT id FROM inbound_lines WHERE inbound_id = ? AND product_id = ? AND lot = ? AND expiry = ? AND id <> ?',
      inb.id, line.product_id, lot, expiry, line.id);
    if (twin) throw conflict('Ez a termék ezzel a sarzzsal és lejárattal már szerepel egy másik tételben.', { lot: 'Már van ilyen tétel.' });
  }
  const note = data.note !== undefined ? data.note : line.note;
  const at = nowIso();
  const userId = ctx.user ? ctx.user.id : null;
  const res = await batch(db, [
    stmt(db,
      `UPDATE inbound_lines SET received_qty = received_qty + ?, damaged_qty = damaged_qty + ?, lot = ?, expiry = ?, note = ?,
              received_by = ?, received_at = ?
       WHERE id = ? AND inbound_id = ?
         AND received_qty + ? >= putaway_qty AND received_qty + ? <= ? AND damaged_qty + ? >= 0 AND damaged_qty + ? <= received_qty + ?
         ${absolute ? 'AND received_qty = ? AND damaged_qty = ?' : ''}
         ${trackingChanged ? 'AND putaway_qty = 0' : ''}
         AND ${statusGuard(OPEN)}`,
      addR, addD, lot, expiry, note, userId, at, line.id, inb.id,
      addR, addR, MAX_QTY, addD, addD, addR,
      ...(absolute ? [line.received_qty, line.damaged_qty] : []),
      inb.id),
    stmt(db,
      `UPDATE inbounds SET status = 'receiving', arrived_at = COALESCE(arrived_at, ?), updated_at = ?
       WHERE id = ? AND status IN ('expected', 'arrived') AND changes() > 0`,
      at, at, inb.id),
  ]);
  if (res[0].meta.changes !== 1) {
    const now = await first(db, 'SELECT received_qty, damaged_qty, putaway_qty FROM inbound_lines WHERE id = ?', line.id);
    if (now && newR < now.putaway_qty) throw conflict(`Ebből a tételből már ${now.putaway_qty} db polcra került, az átvett mennyiség ennél nem lehet kevesebb.`);
    if (now && now.damaged_qty + addD > now.received_qty + addR) throw badRequest('A sérült mennyiség nem lehet több az átvettnél.', { damaged_qty: 'Nem lehet több az átvettnél.' });
    throw conflict('A tételt közben valaki más is módosította. Frissítsd az oldalt, és próbáld újra.');
  }
  const started = res[1].meta.changes === 1;
  if (started) {
    await audit(ctx, { module: 'inbound', action: 'edit', entity: 'inbound', entityId: inb.id, summary: `${inb.number} átvétele megkezdve` });
  }
  if (auditIt && (absolute || trackingChanged)) {
    const parts = [];
    if (absolute) parts.push(`átvett ${newR}, ebből sérült ${newD}`);
    if (trackingChanged) parts.push(`sarzs ${lot || 'nincs'}, lejárat ${expiry || 'nincs'}`);
    await audit(ctx, {
      module: 'inbound', action: 'edit', entity: 'inbound', entityId: inb.id,
      summary: `${line.sku || 'Tétel'}: ${parts.join('; ')}`,
      details: { line_id: line.id, before: { received_qty: line.received_qty, damaged_qty: line.damaged_qty, lot: line.lot, expiry: line.expiry }, after: { received_qty: newR, damaged_qty: newD, lot, expiry } },
    });
  }
  return { line: await lineView(db, line.id), status: 'receiving' };
}

// Adds a line during receiving (an unexpected product or another lot of a product): expected 0.
async function addLine(ctx, inb, product, data) {
  const db = ctx.env.DB;
  requireStatus(inb, OPEN, 'már nem vehető fel új tétel');
  if (!product.active) throw badRequest(`Inaktív cikk: ${product.sku}. Előbb aktiváld a Cikktörzsben.`, { product_id: 'Inaktív cikk.' });
  const received = data.received_qty || 0;
  const damaged = data.damaged_qty || 0;
  if (damaged > received) throw badRequest('A sérült mennyiség nem lehet több az átvettnél.', { damaged_qty: 'Nem lehet több az átvettnél.' });
  const lot = data.lot || '';
  const expiry = data.expiry || '';
  const twin = await first(db, 'SELECT id FROM inbound_lines WHERE inbound_id = ? AND product_id = ? AND lot = ? AND expiry = ?', inb.id, product.id, lot, expiry);
  if (twin) throw conflict(`A(z) ${product.sku} ezzel a sarzzsal már szerepel a betárolásban. Azon a tételen számolj tovább.`, { lot: 'Már van ilyen tétel.' });
  const at = nowIso();
  const userId = ctx.user ? ctx.user.id : null;
  const res = await batch(db, [
    stmt(db,
      `INSERT INTO inbound_lines (inbound_id, product_id, expected_qty, received_qty, damaged_qty, lot, expiry, note, received_by, received_at)
       SELECT ?, ?, 0, ?, ?, ?, ?, ?, ?, ? WHERE ${statusGuard(OPEN)}`,
      inb.id, product.id, received, damaged, lot, expiry, data.note || '', userId, received ? at : null, inb.id),
    stmt(db,
      `UPDATE inbounds SET status = 'receiving', arrived_at = COALESCE(arrived_at, ?), updated_at = ?
       WHERE id = ? AND status IN ('expected', 'arrived') AND ? > 0 AND changes() > 0`,
      at, at, inb.id, received),
  ]);
  if (res[0].meta.changes !== 1) throw conflict('A betárolás állapota közben megváltozott. Frissítsd az oldalt.');
  if (res[1].meta.changes === 1) {
    await audit(ctx, { module: 'inbound', action: 'edit', entity: 'inbound', entityId: inb.id, summary: `${inb.number} átvétele megkezdve` });
  }
  await audit(ctx, {
    module: 'inbound', action: 'edit', entity: 'inbound', entityId: inb.id,
    summary: `Új tétel átvételkor: ${product.sku}${lot ? ` (sarzs ${lot})` : ''}, ${received} db`,
  });
  return { line: await lineView(db, res[0].meta.last_row_id), status: res[1].meta.changes === 1 ? 'receiving' : inb.status };
}

// ---------------------------------------------------------------- CSV import

const CSV_COLUMNS = {
  partner: ['ugyfelkod', 'ugyfel_kod', 'ugyfel', 'partner_kod', 'partnerkod', 'partner_code', 'partner'],
  ref: ['kulso_hivatkozas', 'hivatkozas', 'external_ref', 'referencia', 'ref', 'szallitolevel', 'szallitolevel_szam', 'asn'],
  date: ['varhato_datum', 'expected_date', 'datum', 'erkezes', 'varhato_erkezes'],
  sku: ['cikkszam', 'sku', 'cikk'],
  qty: ['mennyiseg', 'qty', 'quantity', 'db', 'darab', 'varhato_mennyiseg'],
  lot: ['sarzs', 'sarzsszam', 'lot', 'batch'],
  expiry: ['lejarat', 'lejarati_datum', 'expiry', 'szavatossag', 'mmi'],
  supplier: ['beszallito_kod', 'beszallitokod', 'beszallito', 'supplier_code', 'supplier'],
};

function columnMap(headers) {
  const map = {};
  for (const [key, names] of Object.entries(CSV_COLUMNS)) {
    const hit = names.find((n) => headers.includes(n));
    if (hit) map[key] = hit;
  }
  return map;
}

// "2026-10-20", "2026.10.20.", "2026/10/20", "20.10.2026" -> "2026-10-20"; '' -> ''; junk -> null
function csvDate(s) {
  const v = String(s || '').trim();
  if (!v) return '';
  let m = v.match(/^(\d{4})[-./ ]+(\d{1,2})[-./ ]+(\d{1,2})\.?$/);
  if (m) {
    const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    return isDate(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d ? d : null;
  }
  m = v.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})\.?$/);
  if (m) {
    const d = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return isDate(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d ? d : null;
  }
  return null;
}

async function importInbounds(ctx, text, commit) {
  const db = ctx.env.DB;
  const { headers, records } = parseCsv(text);
  if (!headers.length) throw badRequest('Üres a CSV fájl.');
  const col = columnMap(headers.map(normalizeHeader));
  const missing = [['partner', 'Ügyfélkód'], ['sku', 'Cikkszám'], ['qty', 'Mennyiség']].filter(([k]) => !col[k]).map(([, l]) => l);
  if (missing.length) throw badRequest(`Hiányzó oszlop a CSV fájlban: ${missing.join(', ')}.`);
  if (records.length > MAX_IMPORT_ROWS) throw badRequest(`Egyszerre legfeljebb ${MAX_IMPORT_ROWS} sort importálhatsz.`);

  const partners = new Map((await all(db, 'SELECT id, type, status, code, name FROM partners')).map((p) => [p.code.toUpperCase(), p]));
  const productCache = new Map();
  const productsOf = async (partnerId) => {
    if (!productCache.has(partnerId)) {
      const rows = await all(db, 'SELECT id, sku, active FROM products WHERE partner_id = ?', partnerId);
      const map = new Map();
      for (const p of rows) map.set(p.sku, p);
      for (const p of rows) if (!map.has(p.sku.toUpperCase())) map.set(p.sku.toUpperCase(), p);
      productCache.set(partnerId, map);
    }
    return productCache.get(partnerId);
  };

  const errors = [];
  const groups = new Map();
  for (const rec of records) {
    const get = (k) => (col[k] ? String(rec[col[k]] ?? '').trim() : '');
    const problems = [];
    const partnerCode = get('partner');
    const partner = partnerCode ? partners.get(partnerCode.toUpperCase()) : null;
    if (!partnerCode) problems.push('Hiányzó ügyfélkód.');
    else if (!partner || partner.type !== 'client') problems.push(`Ismeretlen ügyfélkód: ${partnerCode}.`);
    else if (partner.status !== 'active') problems.push(`Inaktív ügyfél: ${partnerCode}.`);
    const sku = get('sku');
    let product = null;
    if (!sku) problems.push('Hiányzó cikkszám.');
    else if (partner && partner.type === 'client') {
      const map = await productsOf(partner.id);
      product = map.get(sku) || map.get(sku.toUpperCase()) || null;
      if (!product) problems.push(`Ismeretlen cikkszám ennél az ügyfélnél: ${sku}.`);
      else if (!product.active) problems.push(`Inaktív cikk: ${product.sku}.`);
    }
    const qtyText = get('qty').replace(/\s/g, '');
    const qty = /^\d+$/.test(qtyText) ? Number(qtyText) : NaN;
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) problems.push(`Hibás mennyiség: ${get('qty') || 'üres'}. Pozitív egész számot várunk.`);
    const date = csvDate(get('date'));
    if (date === null) problems.push(`Hibás várható dátum: ${get('date')}. Formátum: ÉÉÉÉ-HH-NN.`);
    const expiry = csvDate(get('expiry'));
    if (expiry === null) problems.push(`Hibás lejárat: ${get('expiry')}. Formátum: ÉÉÉÉ-HH-NN.`);
    const lot = get('lot');
    if (lot.length > 80) problems.push('A sarzs legfeljebb 80 karakter lehet.');
    const ref = get('ref');
    if (ref.length > 120) problems.push('A külső hivatkozás legfeljebb 120 karakter lehet.');
    const supplierCode = get('supplier');
    let supplier = null;
    if (supplierCode) {
      supplier = partners.get(supplierCode.toUpperCase());
      if (!supplier || supplier.type !== 'supplier') problems.push(`Ismeretlen beszállítókód: ${supplierCode}.`);
    }
    const key = partner ? `${partner.id}|${ref ? `ref:${ref}` : `date:${date || ''}|${supplierCode.toUpperCase()}`}` : `bad|${rec._line}`;
    if (!groups.has(key)) groups.set(key, { partner, ref, date: date || '', supplier, rows: [], bad: false });
    const g = groups.get(key);
    if (!g.date && date) g.date = date;
    if (!g.supplier && supplier && supplier.type === 'supplier') g.supplier = supplier;
    g.rows.push({ line: rec._line, product, qty, lot, expiry: expiry || '', problems });
    if (problems.length) {
      g.bad = true;
      errors.push({ line: rec._line, message: problems.join(' ') });
    }
  }

  const good = [];
  for (const g of groups.values()) {
    if (g.bad) {
      for (const r of g.rows) if (!r.problems.length) errors.push({ line: r.line, message: `Kimarad, mert ${g.ref ? `a(z) ${g.ref} szállítmány` : 'a szállítmány'} más sorai hibásak.` });
      continue;
    }
    if (g.ref) {
      const dup = await first(db, "SELECT number FROM inbounds WHERE partner_id = ? AND external_ref = ? AND status <> 'cancelled' LIMIT 1", g.partner.id, g.ref);
      if (dup) {
        for (const r of g.rows) errors.push({ line: r.line, message: `Már van betárolás ezzel a hivatkozással: ${g.ref} (${dup.number}).` });
        continue;
      }
    }
    // Same product, lot and expiry twice in one shipment: one line with the sum.
    const merged = new Map();
    for (const r of g.rows) {
      const k = `${r.product.id}|${r.lot}|${r.expiry}`;
      if (merged.has(k)) merged.get(k).expected_qty += r.qty;
      else merged.set(k, { product_id: r.product.id, expected_qty: r.qty, lot: r.lot, expiry: r.expiry || null });
    }
    good.push({ ...g, lines: [...merged.values()] });
  }
  const sortErrors = () => errors.sort((a, b) => a.line - b.line);
  const validRows = good.reduce((n, g) => n + g.rows.length, 0);

  if (!commit) {
    return {
      rows: records.length,
      valid: validRows,
      errors: sortErrors(),
      inbounds: good.length,
      sample: good.slice(0, 10).map((g) => ({
        partner: g.partner.code, external_ref: g.ref, expected_date: g.date, supplier: g.supplier ? g.supplier.code : '',
        lines: g.lines.length, qty: g.lines.reduce((n, l) => n + l.expected_qty, 0),
      })),
    };
  }

  let imported = 0;
  const created = [];
  for (const g of good) {
    try {
      const res = await createInbound(ctx, {
        partner_id: g.partner.id, supplier_id: g.supplier ? g.supplier.id : null, source: 'csv',
        external_ref: g.ref, expected_date: g.date || null, lines: g.lines,
      });
      if (res.duplicate) {
        for (const r of g.rows) errors.push({ line: r.line, message: `Már importálva: ${res.number}.` });
        continue;
      }
      created.push(res.number);
      imported += g.rows.length;
    } catch (e) {
      for (const r of g.rows) errors.push({ line: r.line, message: e.message || 'Nem sikerült létrehozni.' });
    }
  }
  if (created.length) {
    await audit(ctx, { module: 'inbound', action: 'import', entity: 'inbound', summary: `CSV import: ${created.length} betárolás (${imported} sor)`, details: { numbers: created } });
  }
  return { imported, inbounds: created.length, numbers: created, errors: sortErrors() };
}

// ---------------------------------------------------------------- routes

export function register(r) {
  // List with filters, per row totals, counts per status (for the tabs) and the KPI tiles.
  r.get('/api/inbound', async (ctx) => {
    const db = ctx.env.DB;
    const { limit, offset } = page(ctx.query);
    const f = listWhere(ctx.query);
    const base = `FROM inbounds i JOIN partners p ON p.id = i.partner_id LEFT JOIN partners s ON s.id = i.supplier_id WHERE ${f.sql}`;
    const total = (await first(db, `SELECT COUNT(*) AS n ${base}`, ...f.args)).n;
    const items = await all(db,
      `SELECT i.id, i.number, i.partner_id, p.code AS partner_code, p.name AS partner_name, i.supplier_id, s.code AS supplier_code,
              s.name AS supplier_name, i.source, i.external_ref, i.expected_date, i.arrived_at, i.completed_at, i.status, i.pallets,
              i.cartons, i.has_discrepancy, i.created_at
       ${base}
       ORDER BY CASE WHEN i.status IN (${inList(OPEN)}) THEN 0 ELSE 1 END,
                CASE WHEN i.status IN (${inList(OPEN)}) THEN COALESCE(i.expected_date, '9999-12-31') END,
                COALESCE(i.completed_at, i.cancelled_at, i.created_at) DESC, i.id DESC
       LIMIT ? OFFSET ?`,
      ...f.args, limit, offset);
    if (items.length) {
      const ids = items.map((i) => i.id);
      const sums = await all(db,
        `SELECT inbound_id, COUNT(*) AS line_count, SUM(expected_qty) AS expected_qty, SUM(received_qty) AS received_qty,
                SUM(damaged_qty) AS damaged_qty, SUM(putaway_qty) AS putaway_qty
         FROM inbound_lines WHERE inbound_id IN (${marks(ids.length)}) GROUP BY inbound_id`, ...ids);
      const byId = new Map(sums.map((s) => [s.inbound_id, s]));
      for (const it of items) {
        const s = byId.get(it.id) || {};
        it.line_count = s.line_count || 0;
        it.expected_qty = s.expected_qty || 0;
        it.received_qty = s.received_qty || 0;
        it.damaged_qty = s.damaged_qty || 0;
        it.putaway_qty = s.putaway_qty || 0;
        it.has_discrepancy = !!it.has_discrepancy;
      }
    }
    const cf = listWhere(ctx.query, { withStatus: false });
    const countRows = await all(db, `SELECT i.status, COUNT(*) AS n FROM inbounds i WHERE ${cf.sql} GROUP BY i.status`, ...cf.args);
    const counts = { all: 0, open: 0 };
    for (const k of Object.keys(STATUSES.inbound)) counts[k] = 0;
    for (const c of countRows) {
      counts[c.status] = c.n;
      counts.all += c.n;
      if (OPEN.includes(c.status)) counts.open += c.n;
    }
    return { items, total, limit, offset, counts, kpis: await kpis(db) };
  }, { perm: ['inbound', 'view'] });

  // Detail: lines with product data, suggested putaway locations, putaways and the history.
  r.get('/api/inbound/:id', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const inb = await first(db,
      `SELECT i.*, p.code AS partner_code, p.name AS partner_name, s.code AS supplier_code, s.name AS supplier_name,
              cu.name AS created_by_name, du.name AS completed_by_name
       FROM inbounds i JOIN partners p ON p.id = i.partner_id LEFT JOIN partners s ON s.id = i.supplier_id
       LEFT JOIN users cu ON cu.id = i.created_by LEFT JOIN users du ON du.id = i.completed_by
       WHERE i.id = ?`, id);
    if (!inb) throw notFound('A betárolás nem található.');
    const rows = await all(db, `${LINE_SELECT} WHERE l.inbound_id = ? ORDER BY l.id`, id);
    const putaways = await all(db,
      `SELECT pa.line_id, pa.qty, pa.at, lo.code AS location_code, lo.kind AS location_kind, u.name AS user_name
       FROM inbound_putaways pa JOIN locations lo ON lo.id = pa.location_id LEFT JOIN users u ON u.id = pa.user_id
       WHERE pa.inbound_id = ? ORDER BY pa.id`, id);
    const open = OPEN.includes(inb.status);
    const suggestions = new Map();
    const lines = [];
    for (const row of rows) {
      const l = shapeLine(row);
      l.putaways = putaways.filter((p) => p.line_id === l.id).map(({ line_id, ...p }) => p);
      if (open && l.putaway_qty < Math.max(l.received_qty, l.expected_qty)) {
        if (!suggestions.has(l.product_id)) suggestions.set(l.product_id, await suggestLocation(db, l.product_id));
        l.suggested = suggestions.get(l.product_id) || null;
      } else l.suggested = null;
      lines.push(l);
    }
    const totals = { lines: lines.length, expected: 0, received: 0, damaged: 0, putaway: 0 };
    for (const l of lines) {
      totals.expected += l.expected_qty;
      totals.received += l.received_qty;
      totals.damaged += l.damaged_qty;
      totals.putaway += l.putaway_qty;
    }
    const history = await all(db,
      "SELECT at, actor, action, summary FROM audit_log WHERE entity = 'inbound' AND entity_id = ? ORDER BY id DESC LIMIT 200", String(id));
    return {
      ...inb,
      has_discrepancy: !!inb.has_discrepancy,
      lines,
      totals,
      discrepancy: lines.some(hasDiscrepancy),
      can_cancel: open && totals.putaway === 0,
      quarantine: open ? await quarantineFor(db, inb.partner_id) : null,
      history,
    };
  }, { perm: ['inbound', 'view'] });

  // Manual create. Lines need a positive expected quantity and active products of the client.
  r.post('/api/inbound', async (ctx) => {
    const db = ctx.env.DB;
    const body = await ctx.body();
    const h = validate(body, HEADER_FIELDS);
    const lines = validateList(body.lines, INBOUND_LINE_FIELDS);
    validateList(body.lines, MANUAL_QTY);
    lineDates(h, lines);
    await checkPartners(db, h);
    assertUniqueLines(await resolveLines(db, h.partner_id, lines));
    return createInbound(ctx, { ...body, source: 'manual' });
  }, { perm: ['inbound', 'create'] });

  // Edit header and lines while nothing was counted yet (expected, arrived). Lines with an id are
  // updated, without one added, missing ones removed.
  r.put('/api/inbound/:id', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const inb = await loadInbound(db, id);
    requireStatus(inb, EDITABLE, 'már nem szerkeszthető');
    const body = await ctx.body();
    const h = validate(body, HEADER_FIELDS);
    const lines = validateList(body.lines, { id: { type: 'id', nullable: true }, ...INBOUND_LINE_FIELDS });
    validateList(body.lines, MANUAL_QTY);
    lineDates(h, lines);
    await checkPartners(db, h);
    const existing = await all(db, 'SELECT id, product_id, received_qty, putaway_qty FROM inbound_lines WHERE inbound_id = ?', id);
    const existingById = new Map(existing.map((l) => [l.id, l]));
    if (existing.some((l) => l.received_qty > 0 || l.putaway_qty > 0)) throw conflict('Ebben a betárolásban már van átvett áru, ezért nem szerkeszthető.');
    const errors = {};
    lines.forEach((l, i) => { if (l.id && !existingById.has(l.id)) errors[`lines.${i}.id`] = 'Ismeretlen tétel.'; });
    if (Object.keys(errors).length) throw badRequest('Ellenőrizd a betárolás tételeit.', errors);
    // A product that became inactive since may stay on its own line, but not be added anew.
    const keep = new Set(lines.filter((l) => l.id && existingById.get(l.id).product_id === l.product_id).map((l) => l.product_id));
    const resolved = await resolveLines(db, h.partner_id, lines, { allowInactive: keep });
    assertUniqueLines(resolved);

    const at = nowIso();
    const kept = resolved.filter((l) => l.id).map((l) => l.id);
    const guard = statusGuard(EDITABLE);
    const res = await batch(db, [
      stmt(db,
        `UPDATE inbounds SET partner_id = ?, supplier_id = ?, external_ref = ?, expected_date = ?, pallets = ?, cartons = ?, note = ?, updated_at = ?
         WHERE id = ? AND status IN (${inList(EDITABLE)})`,
        h.partner_id, h.supplier_id || null, h.external_ref, h.expected_date || null, h.pallets, h.cartons, h.note, at, id),
      stmt(db,
        `DELETE FROM inbound_lines WHERE inbound_id = ? ${kept.length ? `AND id NOT IN (${marks(kept.length)})` : ''} AND ${guard}`,
        id, ...kept, id),
      ...resolved.map((l) => (l.id
        ? stmt(db, `UPDATE inbound_lines SET product_id = ?, expected_qty = ?, lot = ?, expiry = ?, note = ? WHERE id = ? AND inbound_id = ? AND ${guard}`,
          l.product_id, l.expected_qty, l.lot || '', l.expiry || '', l.note || '', l.id, id, id)
        : stmt(db, `INSERT INTO inbound_lines (inbound_id, product_id, expected_qty, lot, expiry, note) SELECT ?, ?, ?, ?, ?, ? WHERE ${guard}`,
          id, l.product_id, l.expected_qty, l.lot || '', l.expiry || '', l.note || '', id))),
    ]);
    if (res[0].meta.changes !== 1) throw conflict('A betárolás állapota közben megváltozott, már nem szerkeszthető.');
    await audit(ctx, {
      module: 'inbound', action: 'edit', entity: 'inbound', entityId: id, summary: `${inb.number} módosítva`,
      details: { lines: resolved.length, removed: existing.length - kept.length },
    });
    return { ok: true, id, number: inb.number };
  }, { perm: ['inbound', 'create'] });

  // Sztornó: only while no goods of it were put away.
  r.post('/api/inbound/:id/cancel', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const data = validate(await ctx.body(), { reason: { type: 'str', max: 300, default: '' } });
    const inb = await loadInbound(db, id);
    requireStatus(inb, OPEN, 'nem sztornózható');
    const at = nowIso();
    const res = await run(db,
      `UPDATE inbounds SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ?
       WHERE id = ? AND status IN (${inList(OPEN)}) AND NOT EXISTS (SELECT 1 FROM inbound_lines WHERE inbound_id = ? AND putaway_qty > 0)`,
      at, data.reason, at, id, id);
    if (res.meta.changes !== 1) {
      const put = await first(db, 'SELECT COALESCE(SUM(putaway_qty), 0) AS n FROM inbound_lines WHERE inbound_id = ?', id);
      if (put.n > 0) throw conflict(`Ebből a betárolásból már ${put.n} db polcra került, ezért nem sztornózható. Zárd le eltéréssel.`);
      throw conflict('A betárolás állapota közben megváltozott. Frissítsd az oldalt.');
    }
    await audit(ctx, { module: 'inbound', action: 'delete', entity: 'inbound', entityId: id, summary: `${inb.number} sztornózva${data.reason ? `: ${data.reason}` : ''}` });
    return { ok: true };
  }, { perm: ['inbound', 'delete'] });

  // Arrival at the ramp: expected -> arrived. On an arrived or receiving inbound it updates the counts.
  r.post('/api/inbound/:id/arrive', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const data = validate(await ctx.body(), {
      pallets: { type: 'int', min: 0, max: 10000 },
      cartons: { type: 'int', min: 0, max: 100000 },
      note: { type: 'text', max: 2000 },
    });
    const inb = await loadInbound(db, id);
    requireStatus(inb, OPEN, 'az érkezés már nem rögzíthető');
    const pallets = data.pallets ?? inb.pallets;
    const cartons = data.cartons ?? inb.cartons;
    const note = data.note ?? inb.arrival_note;
    const at = nowIso();
    if (inb.status === 'expected') {
      const res = await run(db,
        `UPDATE inbounds SET status = 'arrived', arrived_at = ?, pallets = ?, cartons = ?, arrival_note = ?, updated_at = ? WHERE id = ? AND status = 'expected'`,
        at, pallets, cartons, note, at, id);
      if (res.meta.changes !== 1) throw conflict('A betárolás állapota közben megváltozott. Frissítsd az oldalt.');
      await audit(ctx, { module: 'inbound', action: 'edit', entity: 'inbound', entityId: id, summary: `${inb.number} megérkezett (${pallets} raklap, ${cartons} karton)` });
    } else {
      await run(db, 'UPDATE inbounds SET pallets = ?, cartons = ?, arrival_note = ?, updated_at = ? WHERE id = ?', pallets, cartons, note, at, id);
      await audit(ctx, { module: 'inbound', action: 'edit', entity: 'inbound', entityId: id, summary: `Érkezési adatok módosítva (${pallets} raklap, ${cartons} karton)` });
    }
    return { ok: true };
  }, { perm: ['inbound', 'edit'] });

  // Scanner: one scan of an EAN or SKU counts qty pieces on the matching line. Answers
  //   { result: 'counted', line, status }     counted on a line
  //   { result: 'unexpected', product }       product of the client but not on this inbound (send add_line: true to add it)
  //   { result: 'location', location }        the code is a location (the screen can switch to putaway)
  r.post('/api/inbound/:id/scan', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const data = validate(await ctx.body(), {
      code: { type: 'str', required: true, max: 120 },
      qty: { type: 'int', min: 1, max: 100000, default: 1 },
      damaged: { type: 'bool', default: false },
      line_id: { type: 'id', nullable: true },
      add_line: { type: 'bool', default: false },
      lot: { type: 'str', max: 80 },
    });
    const inb = await loadInbound(db, id);
    requireStatus(inb, OPEN, 'már nem vehető át rá áru');
    const products = await findProducts(db, inb.partner_id, data.code);
    if (!products.length) {
      const loc = await locationByCode(db, data.code);
      if (loc) return { result: 'location', location: { id: loc.id, code: loc.code, kind: loc.kind } };
      const other = await first(db,
        `SELECT p.sku, pa.code FROM products p JOIN partners pa ON pa.id = p.partner_id
         WHERE p.partner_id <> ? AND (p.sku = ? COLLATE NOCASE OR (p.ean <> '' AND p.ean = ?)) LIMIT 1`, inb.partner_id, data.code, data.code);
      const partner = await first(db, 'SELECT code FROM partners WHERE id = ?', inb.partner_id);
      if (other) throw badRequest(`A(z) ${data.code} kód a(z) ${other.code} ügyfél terméke (${other.sku}), nem ehhez a betároláshoz tartozik.`);
      throw badRequest(`Ismeretlen kód: ${data.code}. Nincs ilyen EAN vagy cikkszám a(z) ${partner ? partner.code : ''} ügyfélnél.`);
    }
    const ids = products.map((p) => p.id);
    const lines = await all(db,
      `SELECT l.*, pr.sku, pr.unit FROM inbound_lines l JOIN products pr ON pr.id = l.product_id
       WHERE l.inbound_id = ? AND l.product_id IN (${marks(ids.length)}) ORDER BY l.id`, id, ...ids);
    let line = data.line_id ? lines.find((l) => l.id === data.line_id) : null;
    if (!line && data.lot !== undefined) line = lines.find((l) => l.lot === data.lot) || null;
    if (!line && lines.length) line = lines.find((l) => l.received_qty < l.expected_qty) || lines[lines.length - 1];
    const counts = { add: data.qty, damaged_add: data.damaged ? data.qty : 0 };
    if (!line) {
      const product = products[0];
      if (!data.add_line) return { result: 'unexpected', product: { id: product.id, sku: product.sku, name: product.name, active: !!product.active } };
      const out = await addLine(ctx, inb, product, { received_qty: data.qty, damaged_qty: counts.damaged_add, lot: data.lot || '' });
      return { result: 'counted', ...out };
    }
    const out = await receiveLine(ctx, inb, line, counts, { auditIt: false });
    return { result: 'counted', ...out };
  }, { perm: ['inbound', 'edit'] });

  // Adds a line during receiving (unexpected product, or another lot of a product on the inbound).
  r.post('/api/inbound/:id/lines', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const data = validate(await ctx.body(), {
      product_id: { type: 'id', nullable: true },
      code: { type: 'str', max: 120 },
      received_qty: { type: 'int', min: 0, max: MAX_QTY, default: 0 },
      damaged_qty: { type: 'int', min: 0, max: MAX_QTY, default: 0 },
      lot: { type: 'str', max: 80, default: '' },
      expiry: { type: 'date', nullable: true },
      note: { type: 'str', max: 300, default: '' },
    });
    checkDates({ expiry: data.expiry });
    const inb = await loadInbound(db, id);
    requireStatus(inb, OPEN, 'már nem vehető fel új tétel');
    let product = null;
    if (data.product_id) product = await first(db, 'SELECT id, sku, name, active FROM products WHERE id = ? AND partner_id = ?', data.product_id, inb.partner_id);
    else if (data.code) product = (await findProducts(db, inb.partner_id, data.code))[0] || null;
    if (!product) throw badRequest('Ismeretlen termék ennél az ügyfélnél.', { product_id: 'Válassz az ügyfél termékei közül.' });
    return addLine(ctx, inb, product, data);
  }, { perm: ['inbound', 'edit'] });

  // Manual count of a line: absolute received / damaged quantities, lot, expiry, note.
  r.post('/api/inbound/:id/lines/:lineId/receive', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const lineId = idParam(ctx, 'lineId');
    const data = validate(await ctx.body(), {
      add: { type: 'int', min: -MAX_QTY, max: MAX_QTY },
      damaged_add: { type: 'int', min: -MAX_QTY, max: MAX_QTY },
      received_qty: { type: 'int', min: 0, max: MAX_QTY },
      damaged_qty: { type: 'int', min: 0, max: MAX_QTY },
      lot: { type: 'str', max: 80 },
      expiry: { type: 'date', nullable: true },
      note: { type: 'str', max: 300 },
    });
    checkDates({ expiry: data.expiry });
    const inb = await loadInbound(db, id);
    const line = await first(db, 'SELECT l.*, pr.sku, pr.unit FROM inbound_lines l JOIN products pr ON pr.id = l.product_id WHERE l.id = ? AND l.inbound_id = ?', lineId, id);
    if (!line) throw notFound('A tétel nem található ebben a betárolásban.');
    return receiveLine(ctx, inb, line, data);
  }, { perm: ['inbound', 'edit'] });

  // Removes a line added during receiving (expected 0) that has nothing put away.
  r.delete('/api/inbound/:id/lines/:lineId', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const lineId = idParam(ctx, 'lineId');
    const inb = await loadInbound(db, id);
    requireStatus(inb, OPEN, 'a tételei már nem törölhetők');
    const line = await loadLine(db, id, lineId);
    if (line.expected_qty > 0) throw conflict('Csak az átvételkor felvett (nem várt) tétel törölhető. A várt mennyiséget a betárolás szerkesztésével módosíthatod.');
    if (line.putaway_qty > 0) throw conflict('Ebből a tételből már került áru polcra, nem törölhető.');
    const res = await run(db, `DELETE FROM inbound_lines WHERE id = ? AND inbound_id = ? AND expected_qty = 0 AND putaway_qty = 0 AND ${statusGuard(OPEN)}`, lineId, id, id);
    if (res.meta.changes !== 1) throw conflict('A tétel közben megváltozott. Frissítsd az oldalt.');
    const p = await first(db, 'SELECT sku FROM products WHERE id = ?', line.product_id);
    await audit(ctx, { module: 'inbound', action: 'edit', entity: 'inbound', entityId: id, summary: `Tétel törölve: ${p ? p.sku : line.product_id} (${line.received_qty} db átvéve)` });
    return { ok: true };
  }, { perm: ['inbound', 'edit'] });

  // Putaway: qty pieces of a received line into a location (stock movement type inbound).
  r.post('/api/inbound/:id/putaway', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const data = validate(await ctx.body(), {
      line_id: { type: 'id', required: true },
      location_id: { type: 'id', nullable: true },
      location_code: { type: 'str', max: 60 },
      qty: { type: 'int', required: true, min: 1, max: MAX_QTY },
    });
    const inb = await loadInbound(db, id);
    if (inb.status !== 'receiving') {
      requireStatus(inb, ['receiving'], inb.status === 'expected' || inb.status === 'arrived' ? 'előbb rögzítsd az átvett mennyiségeket' : 'nem helyezhető polcra');
    }
    const line = await loadLine(db, id, data.line_id);
    const product = await first(db, 'SELECT id, sku, name, unit, track_lot, track_expiry FROM products WHERE id = ?', line.product_id);
    if (product.track_lot && !line.lot) throw badRequest(`A(z) ${product.sku} sarzskövetett termék: polcra helyezés előtt add meg a sarzsszámot.`, { lot: 'Add meg a sarzsszámot.' });
    if (product.track_expiry && !line.expiry) throw badRequest(`A(z) ${product.sku} lejáratkövetett termék: polcra helyezés előtt add meg a lejárati dátumot.`, { expiry: 'Add meg a lejáratot.' });
    const open = line.received_qty - line.putaway_qty;
    if (open <= 0) throw conflict(`A(z) ${product.sku} tételből nincs több polcra helyezendő áru.`, { qty: 'Nincs több polcra helyezendő.' });
    if (data.qty > open) throw conflict(`Ebből a tételből legfeljebb ${open} ${product.unit || 'db'} helyezhető polcra.`, { qty: `Legfeljebb ${open}.` });
    let loc;
    if (data.location_id) loc = await getLocation(db, data.location_id);
    else if (data.location_code) {
      loc = await locationByCode(db, data.location_code);
      if (!loc) throw badRequest(`Ismeretlen raktárhely: ${data.location_code}.`, { location_code: 'Ismeretlen raktárhely.' });
    } else throw badRequest('Add meg a raktárhelyet.', { location_code: 'Kötelező mező.' });
    if (!PUTAWAY_KINDS.includes(loc.kind)) {
      throw conflict(`A(z) ${loc.code} nem tároló- vagy karanténhely. Betároláskor ilyen helyre tedd az árut.`, { location_code: 'Nem tárolóhely.' });
    }

    // Reserve the quantity on the line first, so two scanners cannot put the same pieces away twice.
    const reserve = await run(db,
      `UPDATE inbound_lines SET putaway_qty = putaway_qty + ?, location_id = ?
       WHERE id = ? AND inbound_id = ? AND putaway_qty + ? <= received_qty AND ${statusGuard(['receiving'])}`,
      data.qty, loc.id, line.id, id, data.qty, id);
    if (reserve.meta.changes !== 1) throw conflict('A tétel közben megváltozott. Frissítsd az oldalt, és próbáld újra.');
    try {
      await addStock(ctx, {
        productId: product.id, locationId: loc.id, qty: data.qty, lot: line.lot, expiry: line.expiry,
        type: 'inbound', refType: 'inbound', refId: id, note: inb.number,
      });
    } catch (e) {
      await run(db, 'UPDATE inbound_lines SET putaway_qty = putaway_qty - ?, location_id = ? WHERE id = ?', data.qty, line.location_id, line.id);
      throw e;
    }
    await run(db, 'INSERT INTO inbound_putaways (inbound_id, line_id, location_id, qty, user_id, at) VALUES (?, ?, ?, ?, ?, ?)',
      id, line.id, loc.id, data.qty, ctx.user ? ctx.user.id : null, nowIso());
    await audit(ctx, {
      module: 'inbound', action: 'putaway', entity: 'inbound', entityId: id,
      summary: `${data.qty} ${product.unit || 'db'} ${product.sku}${line.lot ? ` (sarzs ${line.lot})` : ''} polcra: ${loc.code}`,
    });
    return { line: await lineView(db, line.id), location: { id: loc.id, code: loc.code, kind: loc.kind } };
  }, { perm: ['inbound', 'edit'] });

  // Closing. With a discrepancy (received differs from expected, damaged goods, or not everything
  // put away) it needs inbound:approve and a reason.
  r.post('/api/inbound/:id/complete', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const data = validate(await ctx.body(), { note: { type: 'text', max: 2000, default: '' } });
    const inb = await loadInbound(db, id);
    requireStatus(inb, CLOSABLE, inb.status === 'expected' ? 'előbb jelöld megérkezettnek' : 'nem zárható le');
    const lines = await all(db, `${LINE_SELECT} WHERE l.inbound_id = ? ORDER BY l.id`, id);
    const discrepancy = lines.some(hasDiscrepancy);
    const note = data.note.trim();
    if (discrepancy) {
      if (!can(ctx.user, 'inbound', 'approve')) {
        throw forbidden('A betárolásban eltérés van (hiány, többlet, sérült vagy polcra nem helyezett áru). Eltéréssel csak jóváhagyási joggal zárható le, kérd meg a raktárvezetőt.');
      }
      if (note.length < 3) throw badRequest('Írd le röviden az eltérés okát.', { note: 'Kötelező mező.' });
    }
    const at = nowIso();
    const res = await run(db,
      `UPDATE inbounds SET status = 'completed', completed_at = ?, completed_by = ?, has_discrepancy = ?, discrepancy_note = ?, updated_at = ?
       WHERE id = ? AND status IN (${inList(CLOSABLE)})
         AND (? = 1 OR NOT EXISTS (SELECT 1 FROM inbound_lines WHERE inbound_id = ?
                                   AND (received_qty <> expected_qty OR damaged_qty > 0 OR putaway_qty < received_qty)))`,
      at, ctx.user ? ctx.user.id : null, discrepancy ? 1 : 0, discrepancy ? note : '', at, id, discrepancy ? 1 : 0, id);
    if (res.meta.changes !== 1) throw conflict('A betárolás közben megváltozott. Frissítsd az oldalt, és próbáld újra.');
    await audit(ctx, {
      module: 'inbound', action: discrepancy ? 'approve' : 'edit', entity: 'inbound', entityId: id,
      summary: discrepancy ? `${inb.number} lezárva eltéréssel: ${note}` : `${inb.number} lezárva, eltérés nélkül`,
      details: {
        lines: lines.map((l) => ({ sku: l.sku, lot: l.lot, expected: l.expected_qty, received: l.received_qty, damaged: l.damaged_qty, putaway: l.putaway_qty })),
      },
    });
    return { ok: true, has_discrepancy: discrepancy };
  }, { perm: ['inbound', 'edit'] });

  // CSV import (preview / commit): one row per line, rows with the same client and external
  // reference make one inbound.
  r.post('/api/inbound/import', async (ctx) => {
    const { file, form } = await readUpload(ctx);
    const preview = String(form.get('preview') ?? '1') !== '0';
    return importInbounds(ctx, await file.text(), !preview);
  }, { perm: ['inbound', 'create'] });
}
