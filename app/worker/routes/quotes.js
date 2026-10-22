// Ajánlatkészítő: saved quotes and the data the calculator needs. Prefix /api/quotes.
//
//   GET    /api/quotes                 list: ?q=&status=&partner_id=&limit=&offset=     [view]
//   GET    /api/quotes/defaults        company, default_tariffs, quote_terms, active sizes, TARIFFS,
//                                      costing (internal margin assumptions)                [view]
//   GET    /api/quotes/partner/:id     a client's tariffs, storage prices, custom items, contact [view]
//   GET    /api/quotes/:id             one quote with its calculator state (data)       [view]
//   POST   /api/quotes                 { partner_id, client_name, status, data }        [create]
//   PATCH  /api/quotes/:id             same fields, partial                             [edit]
//   POST   /api/quotes/:id/duplicate   copy as a new draft                              [create]
//   DELETE /api/quotes/:id                                                              [delete]
//
// data is the full calculator state (see normalizeQuoteData). The server cleans it and computes
// monthly_net itself with quoteTotals(), the same calculation the calculator page shows, so the
// list never disagrees with the document.

import { all, first, getSetting, nextNumber, parseJson, run } from '../lib/db.js';
import { badRequest, notFound, page } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { STATUSES, TARIFFS } from '../lib/constants.js';
import { budapestDate, isDate, nowIso } from '../lib/time.js';
import { PCT_TARIFFS, activeSizes, defaultTariffs, getPartner, loadTariffs, partnerContact } from './partners.js';
import { costingWithDefaults, looseCosting } from '../lib/costing.js';

const M = 'quotes';
const MAX_DATA = 200 * 1024;

// ---------------------------------------------------------------- calculator state

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v, max = 300) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : '');
// Same rule as the calculator: anything that is not a positive number counts as 0.
const pos = (v, max = 1e9) => {
  const x = typeof v === 'string' ? Number(v.replace(',', '.').replace(/\s/g, '')) : Number(v);
  return Number.isFinite(x) && x > 0 ? Math.min(x, max) : 0;
};

const COMPANY_KEYS = ['name', 'tax_number', 'company_reg_number', 'eu_vat_number', 'country', 'zip', 'city', 'address', 'email', 'phone', 'bank_account', 'website'];

// The quote's own copy of the costing assumptions; its packaging price is costPack.
const quoteCosting = (internal) => {
  const { pack_cost: _settingsOnly, ...rest } = looseCosting(internal);
  return { ...rest, costPack: pos(internal.costPack, 1e7) };
};

export function normalizeQuoteData(input) {
  const d = obj(input);
  const c = obj(d.client);
  const v = obj(d.volume);
  const t = obj(d.tariffs);
  const disc = obj(d.discounts);
  const internal = obj(d.internal);
  const company = obj(d.company);
  const terms = Array.isArray(d.terms) ? d.terms : String(d.terms || '').split('\n');
  return {
    version: 1,
    client: {
      name: str(c.name, 200), contact: str(c.contact, 200), email: str(c.email, 200), phone: str(c.phone, 60),
      shop: str(c.shop, 200), address: str(c.address, 300), tax_number: str(c.tax_number, 40),
    },
    offerDate: isDate(d.offerDate) ? d.offerDate : budapestDate(),
    validDays: Math.round(pos(d.validDays, 365)) || 30,
    volume: {
      orders: pos(v.orders, 1e7), avg: pos(v.avg, 1000), inbound: pos(v.inbound, 1e8), retPct: pos(v.retPct, 100),
      moveIn: pos(v.moveIn, 1e8), hours: pos(v.hours, 1e5), codOrders: pos(v.codOrders, 1e7), codAvg: pos(v.codAvg, 1e8),
    },
    storage: arr(d.storage).slice(0, 50).map((s0) => {
      const s = obj(s0);
      return { code: str(s.code, 20), name: str(s.name, 100), dims: str(s.dims, 120), qty: pos(s.qty, 1e6), price: pos(s.price, 1e8) };
    }).filter((s) => s.code),
    tariffs: Object.fromEntries(TARIFFS.map((x) => [x.key, pos(t[x.key], PCT_TARIFFS.has(x.key) ? 100 : 1e8)])),
    discounts: { freeMoveIn: pos(disc.freeMoveIn, 1e8), freeStorageMonths: Math.round(pos(disc.freeStorageMonths, 120)), priceLockMonths: Math.round(pos(disc.priceLockMonths, 120)) },
    customItems: arr(d.customItems).slice(0, 50).map((i0) => {
      const i = obj(i0);
      return { name: str(i.name, 200), unit: str(i.unit, 30) || 'db', kind: i.kind === 'monthly' ? 'monthly' : 'per_unit', price: pos(i.price, 1e8), qty: pos(i.qty, 1e7) };
    }).filter((i) => i.name),
    terms: terms.map((x) => str(x, 1000)).filter(Boolean).slice(0, 50),
    signer: str(d.signer, 200),
    // Internal costing, never printed: the assumptions of worker/lib/costing.js as they were set for
    // this quote, and the packaging purchase price per order.
    internal: quoteCosting(internal),
    company: Object.fromEntries(COMPANY_KEYS.map((k) => [k, str(company[k], 300)])),
  };
}

// Per order fee for a whole number of items: base, + 2nd, + 3rd, + 4th and every further item.
function feeInt(k, t) {
  if (k <= 1) return t.order_base;
  if (k === 2) return t.order_base + t.item_2;
  if (k === 3) return t.order_base + t.item_2 + t.item_3;
  return t.order_base + t.item_2 + t.item_3 + t.item_extra * (k - 3);
}

// Fractional average: interpolated between the two neighbouring whole numbers.
export function orderFee(avg, t) {
  const a = Math.max(1, avg || 1);
  const lo = Math.floor(a);
  const hi = Math.ceil(a);
  const w = a - lo;
  return feeInt(lo, t) * (1 - w) + feeInt(hi, t) * w;
}

// Totals of a normalised quote. Mirrors calc() in public/assets/js/views/quotes.js line by line
// (test/quotes.test.mjs checks that both give the same numbers).
export function quoteTotals(d) {
  const t = d.tariffs;
  const v = d.volume;
  const o = v.orders;
  const perOrder = orderFee(v.avg, t);
  const base = o * t.order_base;
  const extraItems = o * (perOrder - t.order_base);
  const pack = o * t.packaging;
  const handlingSum = base + extraItems;
  const dH = handlingSum * Math.min(t.discount_handling_pct, 100) / 100;
  const storSum = d.storage.reduce((a, s) => a + s.qty * s.price, 0);
  const dS = storSum * Math.min(t.discount_storage_pct, 100) / 100;
  const inbound = v.inbound * t.inbound_unit;
  const returns = (o * v.retPct / 100) * t.return_unit;
  const hourly = v.hours * t.hourly_work;
  const cod = v.codOrders * t.cod_fixed + v.codOrders * v.codAvg * t.cod_pct / 100;
  const custom = d.customItems.reduce((a, i) => a + i.qty * i.price, 0);
  const net = base + (extraItems > 0.5 ? extraItems : 0) + pack - dH + storSum - dS + inbound + returns + hourly + cod + custom;
  const vat = net * t.vat_pct / 100;
  const storNetMonthly = storSum - dS;
  const freeQ = Math.min(d.discounts.freeMoveIn, v.moveIn);
  const oneOff = (freeQ > 0 ? freeQ * t.inbound_unit : 0)
    + (d.discounts.freeStorageMonths > 0 && storNetMonthly > 0 ? storNetMonthly * d.discounts.freeStorageMonths : 0);
  return { net, vat, gross: net + vat, perOrder: o > 0 ? net / o : 0, yearly: net * 12, oneOff, storNetMonthly };
}

const round2 = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------- input

const QUOTE_FIELDS = {
  partner_id: { type: 'id', nullable: true },
  client_name: { type: 'str', max: 200 },
  status: { type: 'enum', values: Object.keys(STATUSES.quote) },
  data: { type: 'json' },
};

async function readQuote(ctx, { partial }) {
  const body = await ctx.body();
  const q = validate(body, QUOTE_FIELDS, { partial: true });
  if (!partial && q.data === undefined) throw badRequest('Hiányzik az ajánlat tartalma.', { data: 'Kötelező mező.' });
  if (q.data !== undefined) {
    if (!q.data || typeof q.data !== 'object' || Array.isArray(q.data)) throw badRequest('Hibás ajánlat tartalom.', { data: 'Objektumot várunk.' });
    if (JSON.stringify(q.data).length > MAX_DATA) throw badRequest('Az ajánlat túl nagy.', { data: 'Túl sok adat.' });
    q.data = normalizeQuoteData(q.data);
  }
  if (q.partner_id) {
    const p = await first(ctx.env.DB, 'SELECT id, type FROM partners WHERE id = ?', q.partner_id);
    if (!p || p.type !== 'client') throw badRequest('Ismeretlen ügyfél.', { partner_id: 'Válassz ügyfelet.' });
  }
  if (q.client_name === undefined && q.data) q.client_name = q.data.client.name;
  return q;
}

async function quoteOf(db, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw notFound('Az ajánlat nem található.');
  const q = await first(db,
    `SELECT q.*, p.name AS partner_name, p.code AS partner_code, u.name AS created_by_name
     FROM quotes q LEFT JOIN partners p ON p.id = q.partner_id LEFT JOIN users u ON u.id = q.created_by WHERE q.id = ?`, n);
  if (!q) throw notFound('Az ajánlat nem található.');
  return q;
}

const quoteOut = (q) => ({ ...q, data: normalizeQuoteData(parseJson(q.data, {})) });

// ---------------------------------------------------------------- routes

export function register(r) {
  r.get('/api/quotes', async (ctx) => {
    const db = ctx.env.DB;
    const status = Object.keys(STATUSES.quote).includes(ctx.query.get('status')) ? ctx.query.get('status') : null;
    const partnerId = /^\d+$/.test(ctx.query.get('partner_id') || '') ? Number(ctx.query.get('partner_id')) : null;
    const q = (ctx.query.get('q') || '').trim().slice(0, 100);
    const like = q ? `%${q}%` : null;
    const { limit, offset } = page(ctx.query);
    const where = `(? IS NULL OR q.status = ?) AND (? IS NULL OR q.partner_id = ?) AND (? IS NULL OR q.number LIKE ? OR q.client_name LIKE ? OR p.name LIKE ?)`;
    const args = [status, status, partnerId, partnerId, like, like, like, like];
    const items = await all(db,
      `SELECT q.id, q.number, q.partner_id, q.client_name, q.status, q.monthly_net, q.created_at, q.updated_at,
              p.name AS partner_name, p.code AS partner_code, u.name AS created_by_name
       FROM quotes q LEFT JOIN partners p ON p.id = q.partner_id LEFT JOIN users u ON u.id = q.created_by
       WHERE ${where} ORDER BY q.updated_at DESC, q.id DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
    const total = (await first(db, `SELECT COUNT(*) AS n FROM quotes q LEFT JOIN partners p ON p.id = q.partner_id WHERE ${where}`, ...args)).n;
    return { items, total, limit, offset };
  }, { perm: [M, 'view'] });

  r.get('/api/quotes/defaults', async (ctx) => {
    const db = ctx.env.DB;
    const terms = await getSetting(db, 'quote_terms', []);
    return {
      company: await getSetting(db, 'company', {}),
      default_tariffs: await defaultTariffs(db),
      quote_terms: Array.isArray(terms) ? terms : [],
      sizes: await activeSizes(db),
      tariffs: TARIFFS,
      costing: costingWithDefaults(await getSetting(db, 'costing', {})),
    };
  }, { perm: [M, 'view'] });

  r.get('/api/quotes/partner/:id', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    if (p.type !== 'client') throw badRequest('Ajánlat csak ügyfél partnerhez tölthető be.');
    const t = await loadTariffs(db, p.id, { activeCustomOnly: true });
    return {
      partner: { id: p.id, code: p.code, name: p.name, status: p.status },
      contact: await partnerContact(db, p),
      tariffs: Object.fromEntries(t.tariffs.map((x) => [x.key, x.value])),
      storage: t.storage.map((s) => ({ size_id: s.size_id, code: s.code, name: s.name, price: s.price })),
      custom_items: t.custom_items.map((c) => ({ id: c.id, name: c.name, unit: c.unit, price: c.price, kind: c.kind })),
    };
  }, { perm: [M, 'view'] });

  r.get('/api/quotes/:id', async (ctx) => quoteOut(await quoteOf(ctx.env.DB, ctx.params.id)), { perm: [M, 'view'] });

  r.post('/api/quotes', async (ctx) => {
    const db = ctx.env.DB;
    const q = await readQuote(ctx, { partial: false });
    const number = await nextNumber(db, 'AJ');
    const at = nowIso();
    const res = await run(db,
      `INSERT INTO quotes (number, partner_id, client_name, status, data, monthly_net, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      number, q.partner_id || null, q.client_name || '', q.status || 'draft', JSON.stringify(q.data), round2(quoteTotals(q.data).net),
      ctx.user.id, at, at);
    const id = res.meta.last_row_id;
    await audit(ctx, { module: M, action: 'create', entity: 'quote', entityId: id, summary: `Ajánlat létrehozva: ${number}${q.client_name ? ` (${q.client_name})` : ''}` });
    return quoteOut(await quoteOf(db, id));
  }, { perm: [M, 'create'] });

  r.patch('/api/quotes/:id', async (ctx) => {
    const db = ctx.env.DB;
    const cur = await quoteOf(db, ctx.params.id);
    const q = await readQuote(ctx, { partial: true });
    const changes = {};
    if (q.partner_id !== undefined) changes.partner_id = q.partner_id || null;
    if (q.client_name !== undefined) changes.client_name = q.client_name;
    if (q.status !== undefined) changes.status = q.status;
    if (q.data !== undefined) {
      changes.data = JSON.stringify(q.data);
      changes.monthly_net = round2(quoteTotals(q.data).net);
    }
    const keys = Object.keys(changes);
    if (keys.length) {
      await run(db, `UPDATE quotes SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => changes[k]), nowIso(), cur.id);
    }
    const statusText = changes.status && changes.status !== cur.status ? `, állapot: ${STATUSES.quote[changes.status].label.toLowerCase()}` : '';
    await audit(ctx, {
      module: M, action: 'edit', entity: 'quote', entityId: cur.id, summary: `Ajánlat módosítva: ${cur.number}${statusText}`,
      details: changes.monthly_net !== undefined && changes.monthly_net !== cur.monthly_net ? { monthly_net: { from: cur.monthly_net, to: changes.monthly_net } } : null,
    });
    return quoteOut(await quoteOf(db, cur.id));
  }, { perm: [M, 'edit'] });

  r.post('/api/quotes/:id/duplicate', async (ctx) => {
    const db = ctx.env.DB;
    const cur = await quoteOf(db, ctx.params.id);
    const data = normalizeQuoteData(parseJson(cur.data, {}));
    data.offerDate = budapestDate();
    const number = await nextNumber(db, 'AJ');
    const at = nowIso();
    const res = await run(db,
      `INSERT INTO quotes (number, partner_id, client_name, status, data, monthly_net, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      number, cur.partner_id, cur.client_name, JSON.stringify(data), round2(quoteTotals(data).net), ctx.user.id, at, at);
    const id = res.meta.last_row_id;
    await audit(ctx, { module: M, action: 'create', entity: 'quote', entityId: id, summary: `Ajánlat másolva: ${cur.number} alapján ${number}` });
    return quoteOut(await quoteOf(db, id));
  }, { perm: [M, 'create'] });

  r.delete('/api/quotes/:id', async (ctx) => {
    const db = ctx.env.DB;
    const cur = await quoteOf(db, ctx.params.id);
    await run(db, 'DELETE FROM quotes WHERE id = ?', cur.id);
    await audit(ctx, { module: M, action: 'delete', entity: 'quote', entityId: cur.id, summary: `Ajánlat törölve: ${cur.number}${cur.client_name ? ` (${cur.client_name})` : ''}` });
    return { ok: true };
  }, { perm: [M, 'delete'] });
}
