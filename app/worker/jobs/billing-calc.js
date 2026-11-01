// Monthly statement calculation per client (Elszámolás). Pure reads: nothing here writes.
//
//   calculatePeriod(db, period, partnerIds) -> Map(partnerId -> { lines, vat_pct, meta })
//   withTotals(lines, vatPct)               -> { lines (with vat, gross), net, vat, gross }
//   statementDetails(db, statement, kind, { limit, offset }) -> drill-down list { items, total, ... }
//
// Sources for a period (YYYY-MM, Budapest calendar dates):
//   Rendeléskezelés   orders with shipped_date in the period and status shipped, delivered or returned:
//                     order_base per order, item_2 if the order has 2+ pieces, item_3 if 3+,
//                     item_extra per piece from the 4th (pieces = SUM(order_lines.qty)), packaging per order
//   Tárolás           storage_snapshots: for every recorded day and location, price(size) / days in
//                     the month; one line per size with the location-days
//   Áruátvétel        movements of type inbound dated in the period x inbound_unit;
//   és visszáru       returns received in the period x return_unit (per parcel)
//   Extrák            cod_fixed per order with cod_amount > 0, cod_pct percent of the HUF COD amounts,
//                     hourly work from billing_entries x hourly_work
//   Egyedi tételek    monthly custom items once, per_unit custom items x recorded quantities
//   Kedvezmények      discount_handling_pct of the Rendeléskezelés group, discount_storage_pct of the
//                     Tárolás group, as negative lines
// A missing partner_tariffs / partner_storage_prices row means the value in settings default_tariffs
// (storage prices by size code there).
//
// Rounding rule (HUF): every line's net amount is rounded to whole forints (half away from zero),
// its VAT is the rounded net x vat_pct / 100, again rounded to whole forints, gross = net + VAT.
// The statement's net, VAT and gross are the sums of the rounded lines. Discounts are computed
// from the sum of the already rounded lines of their group. Invoices get exactly these lines, so
// the invoice and the statement always agree.

import { all, getSetting, marks } from '../lib/db.js';
import { ITEM_COUNT_SQL } from '../lib/orders.js';
import { TARIFFS } from '../lib/constants.js';
import { monthRange } from '../lib/time.js';

export const GROUPS = [
  { key: 'handling', label: 'Rendeléskezelés' },
  { key: 'storage', label: 'Tárolás' },
  { key: 'inbound', label: 'Áruátvétel és visszáru' },
  { key: 'extra', label: 'Extrák' },
  { key: 'custom', label: 'Egyedi tételek' },
  { key: 'discount', label: 'Kedvezmények' },
];
export const GROUP_KEYS = GROUPS.map((g) => g.key);
export const BILLED_ORDER_STATUSES = ['shipped', 'delivered', 'returned'];
const TARIFF_KEYS = TARIFFS.map((t) => t.key);

// Whole forints, half away from zero. Rounds to cents first so 0.1 + 0.2 style noise never flips a half.
export function roundHuf(x) {
  const n = Number(x) || 0;
  const r = Math.round(Math.round(Math.abs(n) * 100) / 100);
  return r === 0 ? 0 : n < 0 ? -r : r;
}
const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

export const isPeriod = (p) => typeof p === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(p);

// The previous calendar month of a Budapest date: "2026-10-16" -> "2026-09".
export function previousPeriod(date) {
  const [y, m] = date.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

// Runs a query for ids in chunks of 90 (D1 bind limit is 100). sql(marks) builds the statement.
async function inChunks(db, ids, sql, ...before) {
  const out = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    out.push(...await all(db, sql(marks(chunk.length)), ...before, ...chunk));
  }
  return out;
}

// Tariffs of each partner with the defaults filled in.
export async function loadTariffs(db, partnerIds) {
  const defaults = (await getSetting(db, 'default_tariffs', {})) || {};
  const sizes = await all(db, 'SELECT id, code, name, sort FROM location_sizes ORDER BY sort, code');
  const flat = await inChunks(db, partnerIds, (m) => `SELECT partner_id, key, value FROM partner_tariffs WHERE partner_id IN (${m})`);
  const storage = await inChunks(db, partnerIds, (m) => `SELECT partner_id, size_id, price FROM partner_storage_prices WHERE partner_id IN (${m})`);
  const custom = await inChunks(db, partnerIds, (m) => `SELECT id, partner_id, name, unit, price, kind, active FROM partner_custom_items WHERE partner_id IN (${m}) ORDER BY id`);
  const defaultStorage = defaults.storage && typeof defaults.storage === 'object' ? defaults.storage : {};
  const out = new Map();
  for (const id of partnerIds) {
    const values = {};
    for (const k of TARIFF_KEYS) values[k] = Number(defaults[k]) || 0;
    const prices = {};
    for (const s of sizes) prices[s.id] = defaultStorage[s.code] != null && defaultStorage[s.code] !== '' ? Number(defaultStorage[s.code]) || 0 : null;
    out.set(id, { values, prices, custom: [], sizes });
  }
  for (const r of flat) if (out.has(r.partner_id) && TARIFF_KEYS.includes(r.key)) out.get(r.partner_id).values[r.key] = Number(r.value) || 0;
  for (const r of storage) if (out.has(r.partner_id)) out.get(r.partner_id).prices[r.size_id] = Number(r.price) || 0;
  for (const r of custom) if (out.has(r.partner_id)) out.get(r.partner_id).custom.push(r);
  return out;
}

// Order fee as billed: base + 2nd + 3rd + 4th and further pieces + packaging.
export function orderFee(t, pieces) {
  return (t.order_base || 0) + (pieces >= 2 ? t.item_2 || 0 : 0) + (pieces >= 3 ? t.item_3 || 0 : 0)
    + Math.max(0, pieces - 3) * (t.item_extra || 0) + (t.packaging || 0);
}

const ORDERS_SQL = (m) => `
  SELECT x.partner_id,
    COUNT(*) AS orders,
    SUM(x.pieces) AS pieces,
    SUM(CASE WHEN x.pieces = 1 THEN 1 ELSE 0 END) AS b1,
    SUM(CASE WHEN x.pieces = 2 THEN 1 ELSE 0 END) AS b2,
    SUM(CASE WHEN x.pieces = 3 THEN 1 ELSE 0 END) AS b3,
    SUM(CASE WHEN x.pieces >= 4 THEN 1 ELSE 0 END) AS b4,
    SUM(CASE WHEN x.pieces >= 2 THEN 1 ELSE 0 END) AS o2,
    SUM(CASE WHEN x.pieces >= 3 THEN 1 ELSE 0 END) AS o3,
    SUM(CASE WHEN x.pieces > 3 THEN x.pieces - 3 ELSE 0 END) AS extra,
    SUM(CASE WHEN x.cod_amount > 0 THEN 1 ELSE 0 END) AS cod_orders,
    SUM(CASE WHEN x.cod_amount > 0 AND x.currency = 'HUF' THEN x.cod_amount ELSE 0 END) AS cod_total,
    SUM(CASE WHEN x.cod_amount > 0 AND x.currency <> 'HUF' THEN 1 ELSE 0 END) AS cod_foreign
  FROM (SELECT o.id, o.partner_id, o.cod_amount, UPPER(o.currency) AS currency, ${ITEM_COUNT_SQL} AS pieces
        FROM orders o
        WHERE o.shipped_date BETWEEN ? AND ? AND o.status IN ('shipped', 'delivered', 'returned') AND o.partner_id IN (${m})) x
  GROUP BY x.partner_id`;

function line(key, group, name, qty, unit, price, opts = {}) {
  return {
    id: key,
    key,
    group,
    name,
    qty: round2(qty),
    unit,
    price: round2(price),
    price_unit: opts.priceUnit || 'Ft',
    amount: opts.amount !== undefined ? roundHuf(opts.amount) : roundHuf(qty * price),
    detail: opts.detail || null,
    warn: opts.warn || '',
    manual: false,
  };
}

const pctLabel = (v) => String(round2(v)).replace('.', ',');

// -> Map(partnerId -> { lines, vat_pct, meta })
export async function calculatePeriod(db, period, partnerIds) {
  const { from, to, days } = monthRange(period);
  const ids = [...new Set(partnerIds.map(Number))].filter(Boolean);
  const out = new Map();
  if (!ids.length) return out;
  const tariffs = await loadTariffs(db, ids);

  const byPartner = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.partner_id)) m.set(r.partner_id, []);
      m.get(r.partner_id).push(r);
    }
    return m;
  };
  const orders = new Map((await inChunks(db, ids, ORDERS_SQL, from, to)).map((r) => [r.partner_id, r]));
  const inbound = new Map((await inChunks(db, ids, (m) => `SELECT partner_id, SUM(qty) AS qty, COUNT(*) AS n FROM movements
    WHERE type = 'inbound' AND date BETWEEN ? AND ? AND partner_id IN (${m}) GROUP BY partner_id`, from, to)).map((r) => [r.partner_id, r]));
  const returns = new Map((await inChunks(db, ids, (m) => `SELECT partner_id, COUNT(*) AS n FROM returns
    WHERE received_date BETWEEN ? AND ? AND partner_id IN (${m}) GROUP BY partner_id`, from, to)).map((r) => [r.partner_id, r]));
  const storage = byPartner(await inChunks(db, ids, (m) => `SELECT partner_id, size_id, COUNT(*) AS days, COUNT(DISTINCT location_id) AS locations
    FROM storage_snapshots WHERE date BETWEEN ? AND ? AND partner_id IN (${m}) GROUP BY partner_id, size_id`, from, to));
  const entries = byPartner(await inChunks(db, ids, (m) => `SELECT partner_id, kind, custom_item_id, SUM(qty) AS qty, COUNT(*) AS n FROM billing_entries
    WHERE date BETWEEN ? AND ? AND partner_id IN (${m}) GROUP BY partner_id, kind, custom_item_id`, from, to));
  const snapshotDays = (await all(db, 'SELECT COUNT(*) AS n FROM snapshot_runs WHERE date BETWEEN ? AND ?', from, to))[0].n;

  for (const id of ids) {
    const tf = tariffs.get(id);
    const t = tf.values;
    const lines = [];
    const warnings = [];

    // ---- Rendeléskezelés
    const o = orders.get(id) || { orders: 0, pieces: 0, b1: 0, b2: 0, b3: 0, b4: 0, o2: 0, o3: 0, extra: 0, cod_orders: 0, cod_total: 0, cod_foreign: 0 };
    const orderDetail = { drill: 'orders', orders: o.orders, pieces: o.pieces, buckets: { 1: o.b1, 2: o.b2, 3: o.b3, '4+': o.b4 }, extra_pieces: o.extra };
    const handling = [
      ['handling.order_base', 'Alap rendeléskezelés', o.orders, 'rendelés', t.order_base],
      ['handling.item_2', '2. termék', o.o2, 'rendelés', t.item_2],
      ['handling.item_3', '3. termék', o.o3, 'rendelés', t.item_3],
      ['handling.item_extra', '4. és további termék', o.extra, 'db', t.item_extra],
      ['handling.packaging', 'Csomagolóanyag', o.orders, 'rendelés', t.packaging],
    ];
    for (const [key, name, qty, unit, price] of handling) {
      if (qty > 0 && price) lines.push(line(key, 'handling', name, qty, unit, price, { detail: orderDetail }));
    }

    // ---- Tárolás (per size, in the size order of Beállítások > Raktárhelyek)
    const st = storage.get(id) || [];
    for (const size of tf.sizes) {
      const row = st.find((r) => r.size_id === size.id);
      if (!row) continue;
      const price = tf.prices[size.id];
      const detail = { drill: 'storage', size_id: size.id, size_code: size.code, locations: row.locations, location_days: row.days, days_in_month: days };
      lines.push(line(`storage.${size.code}`, 'storage', `Tárolás, ${size.name} (${size.code})`, row.days, 'helynap', price || 0, {
        priceUnit: 'Ft / hely / hó',
        amount: (row.days * (price || 0)) / days,
        detail,
        warn: price ? '' : `Nincs tárolási ár a(z) ${size.code} mérethez (Partnerek > Tarifák vagy az alapértelmezett tarifák).`,
      }));
      if (!price) warnings.push(`Nincs tárolási ár a(z) ${size.code} mérethez.`);
    }

    // ---- Áruátvétel és visszáru
    const ib = inbound.get(id);
    if (ib && ib.qty > 0 && t.inbound_unit) {
      lines.push(line('inbound.inbound_unit', 'inbound', 'Betárolás', ib.qty, 'db', t.inbound_unit, { detail: { drill: 'inbound', movements: ib.n, pieces: ib.qty } }));
    }
    const rt = returns.get(id);
    if (rt && rt.n > 0 && t.return_unit) {
      lines.push(line('inbound.return_unit', 'inbound', 'Visszáru kezelése', rt.n, 'csomag', t.return_unit, { detail: { drill: 'returns', parcels: rt.n } }));
    }

    // ---- Extrák
    if (o.cod_orders > 0 && t.cod_fixed) {
      lines.push(line('extra.cod_fixed', 'extra', 'Utánvétkezelés, fix', o.cod_orders, 'rendelés', t.cod_fixed, { detail: { ...orderDetail, cod_only: true } }));
    }
    if (o.cod_total > 0 && t.cod_pct) {
      lines.push(line('extra.cod_pct', 'extra', `Utánvétkezelés, arányos (${pctLabel(t.cod_pct)}%)`, o.cod_total, 'Ft', t.cod_pct, {
        priceUnit: '%',
        amount: (o.cod_total * t.cod_pct) / 100,
        detail: { ...orderDetail, cod_only: true, cod_total: o.cod_total },
        warn: o.cod_foreign ? `${o.cod_foreign} utánvétes rendelés nem forintban volt, ezekre az arányos díj nem számolódott.` : '',
      }));
    }
    const ent = entries.get(id) || [];
    const hours = ent.filter((e) => e.kind === 'hourly_work').reduce((s, e) => s + e.qty, 0);
    if (hours > 0) {
      lines.push(line('extra.hourly_work', 'extra', 'Óradíjas munka', hours, 'óra', t.hourly_work, {
        detail: { drill: 'entries', kind: 'hourly_work' },
        warn: t.hourly_work ? '' : 'Az óradíj 0 Ft, ellenőrizd a tarifát.',
      }));
    }

    // ---- Egyedi tételek
    for (const item of tf.custom.filter((c) => c.kind === 'monthly' && c.active)) {
      lines.push(line(`custom.monthly.${item.id}`, 'custom', item.name, 1, 'hó', item.price, { detail: { custom_item_id: item.id, kind: 'monthly' } }));
    }
    for (const e of ent.filter((x) => x.kind === 'custom')) {
      const item = tf.custom.find((c) => c.id === e.custom_item_id);
      if (!item) {
        warnings.push(`${e.n} rögzített egyedi tétel törölt tarifatételre hivatkozik, ezek nem kerültek az elszámolásba.`);
        continue;
      }
      lines.push(line(`custom.unit.${item.id}`, 'custom', item.name, e.qty, item.unit || 'db', item.price, { detail: { drill: 'entries', kind: 'custom', custom_item_id: item.id } }));
    }

    // ---- Kedvezmények (from the rounded group sums)
    const groupSum = (g) => lines.filter((l) => l.group === g).reduce((s, l) => s + l.amount, 0);
    const handlingNet = groupSum('handling');
    if (t.discount_handling_pct && handlingNet) {
      const amount = -roundHuf((handlingNet * t.discount_handling_pct) / 100);
      lines.push(line('discount.handling', 'discount', `Kedvezmény a rendeléskezelésből (${pctLabel(t.discount_handling_pct)}%)`, 1, 'tétel', amount, {
        amount, detail: { base: handlingNet, pct: t.discount_handling_pct },
      }));
    }
    const storageNet = groupSum('storage');
    if (t.discount_storage_pct && storageNet) {
      const amount = -roundHuf((storageNet * t.discount_storage_pct) / 100);
      lines.push(line('discount.storage', 'discount', `Kedvezmény a tárolásból (${pctLabel(t.discount_storage_pct)}%)`, 1, 'tétel', amount, {
        amount, detail: { base: storageNet, pct: t.discount_storage_pct },
      }));
    }

    const storagePrices = {};
    for (const s of tf.sizes) storagePrices[s.code] = tf.prices[s.id];
    out.set(id, {
      lines,
      vat_pct: t.vat_pct,
      meta: { tariffs: t, storage_prices: storagePrices, days_in_month: days, snapshot_days: snapshotDays, warnings },
    });
  }
  return out;
}

// Adds each line's VAT and gross and the statement totals (see the rounding rule above).
export function withTotals(lines, vatPct) {
  const out = lines.map((l) => {
    const amount = roundHuf(l.amount);
    const vat = roundHuf((amount * (Number(vatPct) || 0)) / 100);
    return { ...l, amount, vat, gross: amount + vat };
  });
  const net = out.reduce((s, l) => s + l.amount, 0);
  const vat = out.reduce((s, l) => s + l.vat, 0);
  return { lines: out, net, vat, gross: net + vat };
}

// Computed lines compared field by field, to tell whether a draft is out of date.
export function sameLines(a, b) {
  const key = (list) => JSON.stringify(list.filter((l) => !l.manual).map((l) => [l.key, l.qty, l.price, l.amount]));
  return key(a) === key(b);
}

// ---------------------------------------------------------------- drill-down lists

export const DETAIL_KINDS = ['orders', 'inbound', 'returns', 'storage', 'entries'];

export async function statementDetails(db, st, kind, { limit = 200, offset = 0 } = {}) {
  const { from, to, days } = monthRange(st.period);
  const meta = typeof st.meta === 'string' ? JSON.parse(st.meta || '{}') : st.meta || {};
  const t = meta.tariffs || (await loadTariffs(db, [st.partner_id])).get(st.partner_id).values;
  const pid = st.partner_id;

  if (kind === 'orders') {
    const where = `o.partner_id = ? AND o.shipped_date BETWEEN ? AND ? AND o.status IN ('shipped', 'delivered', 'returned')`;
    const total = (await all(db, `SELECT COUNT(*) AS n FROM orders o WHERE ${where}`, pid, from, to))[0].n;
    const rows = await all(db, `SELECT o.id, o.number, o.external_number, o.shipped_date, o.status, o.cod_amount, o.currency, o.customer_name,
        ${ITEM_COUNT_SQL} AS pieces
      FROM orders o WHERE ${where} ORDER BY o.shipped_date, o.number LIMIT ? OFFSET ?`, pid, from, to, limit, offset);
    return { total, items: rows.map((r) => ({ ...r, fee: orderFee(t, r.pieces) })) };
  }
  if (kind === 'inbound') {
    const where = `m.partner_id = ? AND m.type = 'inbound' AND m.date BETWEEN ? AND ?`;
    const total = (await all(db, `SELECT COUNT(*) AS n FROM movements m WHERE ${where}`, pid, from, to))[0].n;
    const items = await all(db, `SELECT m.id, m.date, m.qty, m.lot, m.ref_type, m.ref_id, p.sku, p.name, l.code AS location_code,
        CASE WHEN m.ref_type = 'inbound' THEN (SELECT number FROM inbounds WHERE id = m.ref_id) ELSE NULL END AS inbound_number
      FROM movements m JOIN products p ON p.id = m.product_id LEFT JOIN locations l ON l.id = m.location_id
      WHERE ${where} ORDER BY m.date, m.id LIMIT ? OFFSET ?`, pid, from, to, limit, offset);
    return { total, items };
  }
  if (kind === 'returns') {
    const where = 'r.partner_id = ? AND r.received_date BETWEEN ? AND ?';
    const total = (await all(db, `SELECT COUNT(*) AS n FROM returns r WHERE ${where}`, pid, from, to))[0].n;
    const items = await all(db, `SELECT r.id, r.number, r.received_date, r.reason, o.number AS order_number,
        (SELECT COALESCE(SUM(qty), 0) FROM return_lines WHERE return_id = r.id) AS pieces
      FROM returns r LEFT JOIN orders o ON o.id = r.order_id WHERE ${where} ORDER BY r.received_date, r.number LIMIT ? OFFSET ?`,
    pid, from, to, limit, offset);
    return { total, items };
  }
  if (kind === 'storage') {
    const prices = meta.storage_prices || {};
    const rows = await all(db, `SELECT ss.location_id, l.code, z.code AS size_code, z.name AS size_name, COUNT(*) AS days,
        MIN(ss.date) AS first_date, MAX(ss.date) AS last_date
      FROM storage_snapshots ss JOIN locations l ON l.id = ss.location_id JOIN location_sizes z ON z.id = ss.size_id
      WHERE ss.partner_id = ? AND ss.date BETWEEN ? AND ?
      GROUP BY ss.location_id, ss.size_id ORDER BY z.sort, l.code`, pid, from, to);
    const items = rows.map((r) => ({ ...r, price: prices[r.size_code] ?? null, amount: roundHuf((r.days * (prices[r.size_code] || 0)) / days) }));
    return { total: items.length, items: items.slice(offset, offset + limit), days_in_month: days };
  }
  if (kind === 'entries') {
    const where = 'e.partner_id = ? AND e.date BETWEEN ? AND ?';
    const total = (await all(db, `SELECT COUNT(*) AS n FROM billing_entries e WHERE ${where}`, pid, from, to))[0].n;
    const items = await all(db, `SELECT e.id, e.date, e.kind, e.qty, e.note, e.custom_item_id, c.name AS item_name, c.unit AS item_unit, c.price AS item_price,
        u.name AS created_by_name
      FROM billing_entries e LEFT JOIN partner_custom_items c ON c.id = e.custom_item_id LEFT JOIN users u ON u.id = e.created_by
      WHERE ${where} ORDER BY e.date, e.id LIMIT ? OFFSET ?`, pid, from, to, limit, offset);
    return {
      total,
      items: items.map((e) => ({ ...e, price: e.kind === 'hourly_work' ? t.hourly_work : e.item_price, unit: e.kind === 'hourly_work' ? 'óra' : e.item_unit || 'db' })),
    };
  }
  return { total: 0, items: [] };
}
