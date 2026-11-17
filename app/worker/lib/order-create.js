// Creating orders: one function for every source (manual form, CSV import, webshop import,
// partner REST API), so validation, de-duplication and numbering are always the same.

import { all, batch, first, marks, nextNumber, stmt } from './db.js';
import { badRequest } from './http.js';
import { validate, validateList } from './validate.js';
import { audit } from './audit.js';
import { nowIso } from './time.js';

export const ORDER_FIELDS = {
  partner_id: { type: 'id', required: true },
  source: { type: 'enum', values: ['manual', 'csv', 'api', 'shopify', 'woocommerce', 'shoprenter', 'unas'], default: 'manual' },
  external_id: { type: 'str', max: 120, default: '' },
  external_number: { type: 'str', max: 120, default: '' },
  priority: { type: 'enum', values: ['normal', 'express'], default: 'normal' },
  customer_name: { type: 'str', required: true, max: 200 },
  company: { type: 'str', max: 200, default: '' },
  email: { type: 'email', default: '' },
  phone: { type: 'str', max: 60, default: '' },
  country: { type: 'str', max: 2, default: 'HU' },
  zip: { type: 'str', max: 20, default: '' },
  city: { type: 'str', max: 120, default: '' },
  address: { type: 'str', max: 300, default: '' },
  pickup_point_id: { type: 'str', max: 120, default: '' },
  carrier_id: { type: 'id', nullable: true },
  carrier_code: { type: 'enum', values: ['gls', 'dpd', 'foxpost', 'mpl', 'dhl', 'other', ''], default: '' },
  carrier_service: { type: 'str', max: 120, default: '' },
  cod_amount: { type: 'num', min: 0, default: 0 },
  currency: { type: 'str', max: 3, default: 'HUF' },
  note: { type: 'text', max: 2000, default: '' },
  ordered_at: { type: 'str', max: 40, nullable: true },
};

export const LINE_FIELDS = {
  product_id: { type: 'id', nullable: true },
  sku: { type: 'str', max: 120 },
  qty: { type: 'int', required: true, min: 1, max: 100000 },
  external_line_id: { type: 'str', max: 120, default: '' },
};

// Returns { id, number, duplicate }. Throws 400 with field messages when the input is invalid.
// A repeated (partner, source, external_id) answers the existing order with duplicate: true,
// so webshop and API imports can safely retry.
export async function createOrder(ctx, input) {
  const db = ctx.env.DB;
  const o = validate(input, ORDER_FIELDS);
  const lines = validateList(input.lines, LINE_FIELDS);

  const partner = await first(db, 'SELECT id, type, status, name FROM partners WHERE id = ?', o.partner_id);
  if (!partner || partner.type !== 'client') throw badRequest('Ismeretlen ügyfél.', { partner_id: 'Válassz ügyfelet.' });
  if (partner.status !== 'active') throw badRequest('Az ügyfél inaktív.', { partner_id: 'Inaktív ügyfél.' });

  if (o.source !== 'manual' && o.external_id) {
    const dup = await first(db, 'SELECT id, number FROM orders WHERE partner_id = ? AND source = ? AND external_id = ?', o.partner_id, o.source, o.external_id);
    if (dup) return { id: dup.id, number: dup.number, duplicate: true };
  }

  // Products: by id or by SKU, always within the partner's own catalogue.
  const ids = lines.filter((l) => l.product_id).map((l) => l.product_id);
  const skus = lines.filter((l) => !l.product_id && l.sku).map((l) => l.sku);
  const found = [];
  if (ids.length) found.push(...await all(db, `SELECT id, sku, active FROM products WHERE partner_id = ? AND id IN (${marks(ids.length)})`, o.partner_id, ...ids));
  if (skus.length) found.push(...await all(db, `SELECT id, sku, active FROM products WHERE partner_id = ? AND sku IN (${marks(skus.length)})`, o.partner_id, ...skus));
  const byId = new Map(found.map((p) => [p.id, p]));
  const bySku = new Map(found.map((p) => [p.sku, p]));
  const errors = {};
  const resolved = lines.map((l, i) => {
    const p = l.product_id ? byId.get(l.product_id) : bySku.get(l.sku);
    if (!p) errors[`lines.${i}.${l.product_id ? 'product_id' : 'sku'}`] = l.sku ? `Ismeretlen cikkszám: ${l.sku}` : 'Ismeretlen termék.';
    else if (!p.active) errors[`lines.${i}.sku`] = `Inaktív cikk: ${p.sku}`;
    return p ? { ...l, product_id: p.id } : l;
  });
  if (Object.keys(errors).length) throw badRequest('Ellenőrizd a rendelés tételeit.', errors);

  // Carrier: explicit carrier partner, or the active carrier partner with that code.
  let carrierId = o.carrier_id || null;
  if (carrierId) {
    const c = await first(db, "SELECT id FROM partners WHERE id = ? AND type = 'carrier'", carrierId);
    if (!c) throw badRequest('Ismeretlen fuvarozó.', { carrier_id: 'Válassz fuvarozót.' });
  } else if (o.carrier_code) {
    const c = await first(db, "SELECT id FROM partners WHERE type = 'carrier' AND carrier_code = ? AND status = 'active' ORDER BY id LIMIT 1", o.carrier_code);
    carrierId = c ? c.id : null;
  }

  const number = await nextNumber(db, 'R', 6);
  const at = nowIso();
  const orderRef = '(SELECT id FROM orders WHERE number = ?)';
  await batch(db, [
    stmt(db, `INSERT INTO orders (number, partner_id, source, external_id, external_number, status, priority, customer_name, company, email, phone,
                country, zip, city, address, pickup_point_id, carrier_id, carrier_service, cod_amount, currency, note, ordered_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      number, o.partner_id, o.source, o.external_id, o.external_number, o.priority, o.customer_name, o.company, o.email, o.phone,
      (o.country || 'HU').toUpperCase(), o.zip, o.city, o.address, o.pickup_point_id, carrierId, o.carrier_service, o.cod_amount, o.currency,
      o.note, o.ordered_at || null, at, at),
    ...resolved.map((l) => stmt(db, `INSERT INTO order_lines (order_id, product_id, qty, external_line_id) VALUES (${orderRef}, ?, ?, ?)`,
      number, l.product_id, l.qty, l.external_line_id)),
    stmt(db, `INSERT INTO order_events (order_id, at, type, text, user_id) VALUES (${orderRef}, ?, 'created', ?, ?)`,
      number, at, SOURCE_TEXT[o.source] || 'Rendelés létrehozva', ctx.user ? ctx.user.id : null),
  ]);
  const row = await first(db, 'SELECT id FROM orders WHERE number = ?', number);
  await audit(ctx, { module: 'orders', action: 'create', entity: 'order', entityId: row.id, summary: `${number} létrehozva (${partner.name})` });
  return { id: row.id, number, duplicate: false };
}

const SOURCE_TEXT = {
  manual: 'Rendelés rögzítve kézzel',
  csv: 'Rendelés importálva CSV-ből',
  api: 'Rendelés érkezett az API-n',
  shopify: 'Rendelés importálva a Shopifyból',
  woocommerce: 'Rendelés importálva a WooCommerce-ből',
  shoprenter: 'Rendelés importálva a Shoprenterből',
  unas: 'Rendelés importálva az UNAS-ból',
};
