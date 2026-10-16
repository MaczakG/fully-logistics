// Creating inbounds (expected deliveries, ASN): one function for the manual form, CSV import and
// the partner REST API.

import { all, batch, first, marks, nextNumber, stmt } from './db.js';
import { badRequest } from './http.js';
import { validate, validateList } from './validate.js';
import { audit } from './audit.js';
import { nowIso } from './time.js';

export const INBOUND_FIELDS = {
  partner_id: { type: 'id', required: true },
  supplier_id: { type: 'id', nullable: true },
  source: { type: 'enum', values: ['manual', 'csv', 'api'], default: 'manual' },
  external_ref: { type: 'str', max: 120, default: '' },
  expected_date: { type: 'date', nullable: true },
  pallets: { type: 'int', min: 0, default: 0 },
  cartons: { type: 'int', min: 0, default: 0 },
  note: { type: 'text', max: 2000, default: '' },
};

export const INBOUND_LINE_FIELDS = {
  product_id: { type: 'id', nullable: true },
  sku: { type: 'str', max: 120 },
  expected_qty: { type: 'int', required: true, min: 0, max: 1000000 },
  lot: { type: 'str', max: 80, default: '' },
  expiry: { type: 'date', nullable: true },
  note: { type: 'str', max: 300, default: '' },
};

// Returns { id, number, duplicate }. For csv and api sources a repeated (partner, source,
// external_ref) answers the existing inbound with duplicate: true.
export async function createInbound(ctx, input) {
  const db = ctx.env.DB;
  const h = validate(input, INBOUND_FIELDS);
  const lines = validateList(input.lines, INBOUND_LINE_FIELDS);

  const partner = await first(db, 'SELECT id, type, status, name FROM partners WHERE id = ?', h.partner_id);
  if (!partner || partner.type !== 'client') throw badRequest('Ismeretlen ügyfél.', { partner_id: 'Válassz ügyfelet.' });
  if (partner.status !== 'active') throw badRequest('Az ügyfél inaktív.', { partner_id: 'Inaktív ügyfél.' });
  if (h.supplier_id) {
    const s = await first(db, "SELECT id FROM partners WHERE id = ? AND type = 'supplier'", h.supplier_id);
    if (!s) throw badRequest('Ismeretlen beszállító.', { supplier_id: 'Válassz beszállítót.' });
  }
  if (h.source !== 'manual' && h.external_ref) {
    const dup = await first(db, 'SELECT id, number FROM inbounds WHERE partner_id = ? AND source = ? AND external_ref = ?', h.partner_id, h.source, h.external_ref);
    if (dup) return { id: dup.id, number: dup.number, duplicate: true };
  }

  const ids = lines.filter((l) => l.product_id).map((l) => l.product_id);
  const skus = lines.filter((l) => !l.product_id && l.sku).map((l) => l.sku);
  const found = [];
  if (ids.length) found.push(...await all(db, `SELECT id, sku, active FROM products WHERE partner_id = ? AND id IN (${marks(ids.length)})`, h.partner_id, ...ids));
  if (skus.length) found.push(...await all(db, `SELECT id, sku, active FROM products WHERE partner_id = ? AND sku IN (${marks(skus.length)})`, h.partner_id, ...skus));
  const byId = new Map(found.map((p) => [p.id, p]));
  const bySku = new Map(found.map((p) => [p.sku, p]));
  const errors = {};
  const resolved = lines.map((l, i) => {
    const p = l.product_id ? byId.get(l.product_id) : bySku.get(l.sku);
    const key = `lines.${i}.${l.product_id ? 'product_id' : 'sku'}`;
    if (!p) errors[key] = l.sku ? `Ismeretlen cikkszám: ${l.sku}` : 'Ismeretlen termék.';
    else if (!p.active) errors[key] = `Inaktív termék: ${p.sku}`;
    return p ? { ...l, product_id: p.id } : l;
  });
  if (Object.keys(errors).length) throw badRequest('Ellenőrizd a betárolás tételeit.', errors);

  const number = await nextNumber(db, 'BT');
  const at = nowIso();
  const ref = '(SELECT id FROM inbounds WHERE number = ?)';
  await batch(db, [
    stmt(db, `INSERT INTO inbounds (number, partner_id, supplier_id, source, external_ref, expected_date, status, pallets, cartons, note, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'expected', ?, ?, ?, ?, ?, ?)`,
      number, h.partner_id, h.supplier_id || null, h.source, h.external_ref, h.expected_date || null, h.pallets, h.cartons, h.note,
      ctx.user ? ctx.user.id : null, at, at),
    ...resolved.map((l) => stmt(db, `INSERT INTO inbound_lines (inbound_id, product_id, expected_qty, lot, expiry, note) VALUES (${ref}, ?, ?, ?, ?, ?)`,
      number, l.product_id, l.expected_qty, l.lot || '', l.expiry || '', l.note || '')),
  ]);
  const row = await first(db, 'SELECT id FROM inbounds WHERE number = ?', number);
  await audit(ctx, { module: 'inbound', action: 'create', entity: 'inbound', entityId: row.id, summary: `${number} létrehozva (${partner.name})` });
  return { id: row.id, number, duplicate: false };
}
