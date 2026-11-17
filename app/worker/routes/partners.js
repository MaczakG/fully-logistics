// Partnerek: clients, carriers and suppliers with contacts, contracts and documents, tariffs (clients),
// integrations (clients: webshop connections and partner API keys) and a summary. Prefix /api/partners.
//
//   GET    /api/partners                          list: ?type=&status=&q=&limit=&offset=  [view]
//   POST   /api/partners                          create (clients get the default tariffs) [create]
//   GET    /api/partners/:id                      detail with tab counts and delete check [view]
//   PATCH  /api/partners/:id                      basic data, status [edit]
//   DELETE /api/partners/:id                      only without orders, products, stock ... [delete]
//   GET|POST /api/partners/:id/contacts, PATCH|DELETE .../contacts/:cid             [view | edit]
//   GET|POST /api/partners/:id/contracts, PATCH|DELETE .../contracts/:cid           [view | edit]
//   GET|POST /api/partners/:id/documents (multipart), PATCH|DELETE .../documents/:did [view | edit]
//   GET    /api/partners/:id/tariffs              flat tariffs, storage prices by size, custom items [view]
//   PUT    /api/partners/:id/tariffs              { tariffs: { key: value }, storage: { sizeId: price } } [approve]
//   POST   /api/partners/:id/tariffs/reset        back to settings default_tariffs [approve]
//   POST   /api/partners/:id/custom-items, PATCH|DELETE .../custom-items/:itemId   [approve]
//   GET    /api/partners/:id/integrations         platforms, webshop connections (masked), API keys [view]
//   POST   /api/partners/:id/webshops, PATCH|DELETE .../webshops/:wid               [approve]
//   POST   /api/partners/:id/webshops/:wid/test | /sync                             [approve]
//   POST   /api/partners/:id/api-keys, POST .../api-keys/:kid/revoke                [approve]
//   GET    /api/partners/:id/summary              per partner type [view]
//
// Missing partner_tariffs / partner_storage_prices rows mean "the default from settings".

import { all, batch, first, getSetting, marks, parseJson, run, stmt } from '../lib/db.js';
import { badRequest, conflict, notFound, page } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { CARRIERS, PARTNER_TYPES, STATUSES, TARIFFS, WEBSHOP_PLATFORMS } from '../lib/constants.js';
import { deleteDocument, readUpload, storeFile } from '../lib/files.js';
import { decryptJson, encryptJson, maskCredentials } from '../lib/crypto.js';
import { createApiKey } from '../lib/apikeys.js';
import { TZ, budapestDate, monthRange, nowIso } from '../lib/time.js';
import { listPlatforms, syncConnection, testConnection } from '../integrations/webshops/index.js';

const M = 'partners';

// ---------------------------------------------------------------- small helpers

export const PCT_TARIFFS = new Set(['cod_pct', 'discount_handling_pct', 'discount_storage_pct', 'vat_pct']);
const MAX_PRICE = 100000000;

const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const sameNum = (a, b) => Math.abs(num(a) - num(b)) < 0.000001;

const idOf = (v, what = 'A tétel') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw notFound(`${what} nem található.`);
  return n;
};

export async function getPartner(db, id) {
  const p = await first(db, 'SELECT * FROM partners WHERE id = ?', idOf(id, 'A partner'));
  if (!p) throw notFound('A partner nem található.');
  return p;
}

function requireClient(p) {
  if (p.type !== 'client') throw badRequest('Ez csak ügyfél partnernél érhető el.');
}

const fieldError = (field, message) => badRequest(message, { [field]: message });

// Budapest midnight of a calendar date as an ISO UTC instant, for comparing with created_at columns.
const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function budapestOffsetMs(instant) {
  const p = Object.fromEntries(partsFmt.formatToParts(instant).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(instant.getTime() / 1000) * 1000;
}
export function budapestStartIso(date) {
  const guess = new Date(`${date}T00:00:00Z`);
  return new Date(guess.getTime() - budapestOffsetMs(guess)).toISOString();
}
const nextMonth = (period) => {
  const [y, m] = period.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
const prevMonth = (period) => {
  const [y, m] = period.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
// { from, to } ISO instants of a Budapest month, end exclusive.
const monthInstants = (period) => ({ from: budapestStartIso(`${period}-01`), to: budapestStartIso(`${nextMonth(period)}-01`) });

// ---------------------------------------------------------------- partner data

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,19}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

const PARTNER_FIELDS = {
  type: { type: 'enum', values: Object.keys(PARTNER_TYPES), required: true },
  code: { type: 'str', required: true, max: 20 },
  name: { type: 'str', required: true, max: 200 },
  status: { type: 'enum', values: Object.keys(STATUSES.partner), default: 'active' },
  tax_number: { type: 'str', max: 40, default: '' },
  eu_vat_number: { type: 'str', max: 40, default: '' },
  company_reg_number: { type: 'str', max: 40, default: '' },
  country: { type: 'str', max: 2, default: 'HU' },
  zip: { type: 'str', max: 20, default: '' },
  city: { type: 'str', max: 120, default: '' },
  address: { type: 'str', max: 300, default: '' },
  billing_name: { type: 'str', max: 200, default: '' },
  billing_country: { type: 'str', max: 2, default: 'HU' },
  billing_zip: { type: 'str', max: 20, default: '' },
  billing_city: { type: 'str', max: 120, default: '' },
  billing_address: { type: 'str', max: 300, default: '' },
  billing_email: { type: 'email', default: '' },
  payment_days: { type: 'int', required: true, min: 0, max: 365, default: 8 },
  website: { type: 'str', max: 300, default: '' },
  carrier_code: { type: 'enum', values: [...Object.keys(CARRIERS), ''], default: '' },
  notes: { type: 'text', max: 5000, default: '' },
};
const PARTNER_UPDATE_FIELDS = Object.fromEntries(Object.entries(PARTNER_FIELDS).filter(([k]) => k !== 'type'));

export function normalizeWebsite(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.')) return null;
  return u.href.replace(/\/$/, '');
}

// Hungarian tax number: 8 + 1 + 2 digits, stored as "12345678-2-13".
export function normalizeHuTaxNumber(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const digits = s.replace(/[\s-]/g, '');
  if (!/^\d{11}$/.test(digits)) return null;
  return `${digits.slice(0, 8)}-${digits.slice(8, 9)}-${digits.slice(9)}`;
}

// Cleans validated partner fields; current: the stored row on update (for type and country).
function cleanPartner(data, current = null) {
  const errors = {};
  const type = current ? current.type : data.type;
  if (data.code !== undefined) {
    data.code = data.code.toUpperCase();
    if (!CODE_RE.test(data.code)) errors.code = 'Legalább 2 karakter: ékezet nélküli nagybetű, szám, kötőjel vagy aláhúzás.';
  }
  for (const k of ['country', 'billing_country']) {
    if (data[k] !== undefined) {
      data[k] = (data[k] || 'HU').toUpperCase();
      if (!COUNTRY_RE.test(data[k])) errors[k] = 'Kétbetűs országkód, pl. HU.';
    }
  }
  if (data.tax_number !== undefined) {
    const country = data.country ?? (current ? current.country : 'HU');
    if (country === 'HU' && data.tax_number) {
      const t = normalizeHuTaxNumber(data.tax_number);
      if (t === null) errors.tax_number = 'Magyar adószám: 12345678-1-12 formában.';
      else data.tax_number = t;
    }
  }
  if (data.website !== undefined) {
    const w = normalizeWebsite(data.website);
    if (w === null) errors.website = 'Érvényes webcímet adj meg, pl. https://pelda.hu';
    else data.website = w;
  }
  if (data.carrier_code !== undefined && type !== 'carrier') data.carrier_code = '';
  if (Object.keys(errors).length) throw badRequest('Ellenőrizd a megjelölt mezőket.', errors);
  return data;
}

async function assertCodeFree(db, code, exceptId = 0) {
  const dup = await first(db, 'SELECT id, name FROM partners WHERE code = ? AND id <> ?', code, exceptId);
  if (dup) throw conflict(`A(z) ${code} kódot már ${dup.name} használja.`, { code: 'Ez a kód már foglalt.' });
}

// ---------------------------------------------------------------- tariffs

export const activeSizes = (db) =>
  all(db, 'SELECT id, code, name, width_cm, depth_cm, height_cm, max_kg FROM location_sizes WHERE active = 1 ORDER BY sort, code');

export async function defaultTariffs(db) {
  const d = await getSetting(db, 'default_tariffs', {});
  return d && typeof d === 'object' ? d : {};
}

// Statements that set a client's flat tariffs and storage prices to the defaults.
// ref: SQL for the partner id ("?" or a subquery), refArgs: its bind values.
async function defaultTariffStatements(db, ref, refArgs) {
  const defaults = await defaultTariffs(db);
  const storage = defaults.storage && typeof defaults.storage === 'object' ? defaults.storage : {};
  const sizes = await activeSizes(db);
  return [
    ...TARIFFS.map((t) => stmt(db,
      `INSERT INTO partner_tariffs (partner_id, key, value) VALUES (${ref}, ?, ?)
       ON CONFLICT (partner_id, key) DO UPDATE SET value = excluded.value`,
      ...refArgs, t.key, num(defaults[t.key]))),
    ...sizes.map((s) => stmt(db,
      `INSERT INTO partner_storage_prices (partner_id, size_id, price) VALUES (${ref}, ?, ?)
       ON CONFLICT (partner_id, size_id) DO UPDATE SET price = excluded.price`,
      ...refArgs, s.id, num(storage[s.code]))),
  ];
}

// The client's tariffs next to the defaults. Also used by the quote calculator.
export async function loadTariffs(db, partnerId, { activeCustomOnly = false } = {}) {
  const defaults = await defaultTariffs(db);
  const storageDefaults = defaults.storage && typeof defaults.storage === 'object' ? defaults.storage : {};
  const rows = await all(db, 'SELECT key, value FROM partner_tariffs WHERE partner_id = ?', partnerId);
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const tariffs = TARIFFS.map((t) => {
    const def = num(defaults[t.key]);
    const value = byKey.has(t.key) ? num(byKey.get(t.key)) : def;
    return { ...t, value, default: def, differs: !sameNum(value, def) };
  });
  const sizes = await all(db,
    `SELECT s.id, s.code, s.name, s.width_cm, s.depth_cm, s.height_cm, s.max_kg, sp.price
     FROM location_sizes s LEFT JOIN partner_storage_prices sp ON sp.size_id = s.id AND sp.partner_id = ?
     WHERE s.active = 1 ORDER BY s.sort, s.code`, partnerId);
  const storage = sizes.map((s) => {
    const def = num(storageDefaults[s.code]);
    const price = s.price == null ? def : num(s.price);
    return {
      size_id: s.id, code: s.code, name: s.name, width_cm: s.width_cm, depth_cm: s.depth_cm, height_cm: s.height_cm, max_kg: s.max_kg,
      price, default: def, differs: !sameNum(price, def),
    };
  });
  const custom = await all(db,
    `SELECT id, name, unit, price, kind, active FROM partner_custom_items WHERE partner_id = ? ${activeCustomOnly ? 'AND active = 1' : ''}
     ORDER BY active DESC, name COLLATE NOCASE`, partnerId);
  return { tariffs, storage, custom_items: custom.map((c) => ({ ...c, active: !!c.active })) };
}

// Reads { key: value } maps of numbers. Field errors are keyed with the form input names.
function readTariffInput(body, sizes) {
  const errors = {};
  const tariffs = {};
  const storage = {};
  const inT = body && typeof body.tariffs === 'object' && body.tariffs ? body.tariffs : {};
  const inS = body && typeof body.storage === 'object' && body.storage ? body.storage : {};
  const readNum = (v, max) => {
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return 'Adj meg egy számot (0 is lehet).';
    const x = typeof v === 'string' ? Number(v.replace(',', '.').replace(/\s/g, '')) : v;
    if (typeof x !== 'number' || !Number.isFinite(x)) return 'Számot várunk.';
    if (x < 0) return 'Nem lehet negatív.';
    if (x > max) return `Legfeljebb ${max} lehet.`;
    return x;
  };
  for (const [key, v] of Object.entries(inT)) {
    const t = TARIFFS.find((x) => x.key === key);
    if (!t) { errors[key] = 'Ismeretlen tarifa.'; continue; }
    const r = readNum(v, PCT_TARIFFS.has(key) ? 100 : MAX_PRICE);
    if (typeof r === 'string') errors[key] = r;
    else tariffs[key] = r;
  }
  for (const [sizeId, v] of Object.entries(inS)) {
    const size = sizes.find((s) => String(s.id) === String(sizeId));
    if (!size) { errors[`storage_${sizeId}`] = 'Ismeretlen vagy inaktív raktárhely méret.'; continue; }
    const r = readNum(v, MAX_PRICE);
    if (typeof r === 'string') errors[`storage_${sizeId}`] = r;
    else storage[size.id] = r;
  }
  if (Object.keys(errors).length) throw badRequest('Ellenőrizd a megjelölt díjakat.', errors);
  return { tariffs, storage };
}

const CUSTOM_ITEM_FIELDS = {
  name: { type: 'str', required: true, max: 200 },
  unit: { type: 'str', max: 30, default: 'db' },
  price: { type: 'num', required: true, min: 0, max: MAX_PRICE },
  kind: { type: 'enum', values: ['monthly', 'per_unit'], default: 'per_unit' },
  active: { type: 'bool', default: true },
};

// ---------------------------------------------------------------- contacts, contracts, documents

const CONTACT_FIELDS = {
  name: { type: 'str', required: true, max: 200 },
  position: { type: 'str', max: 120, default: '' },
  email: { type: 'email', default: '' },
  phone: { type: 'str', max: 60, default: '' },
  is_primary: { type: 'bool', default: false },
  notes: { type: 'text', max: 2000, default: '' },
};

const CONTRACT_FIELDS = {
  number: { type: 'str', max: 60, default: '' },
  title: { type: 'str', required: true, max: 200 },
  start_date: { type: 'date', nullable: true },
  end_date: { type: 'date', nullable: true },
  notice_days: { type: 'int', required: true, min: 0, max: 3650, default: 30 },
  status: { type: 'enum', values: Object.keys(STATUSES.contract), default: 'active' },
  notes: { type: 'text', max: 2000, default: '' },
};

export const DOCUMENT_KINDS = { contract: 'Szerződés', other: 'Egyéb' };

// Content types served as they are; anything else (HTML, SVG, scripts ...) is stored as a plain
// download, so an uploaded file can never run in the app's origin.
const SAFE_TYPES = [
  /^application\/pdf$/, /^image\/(png|jpeg|gif|webp)$/, /^text\/(plain|csv)$/,
  /^application\/(msword|vnd\.ms-excel|vnd\.ms-powerpoint|rtf|zip|x-zip-compressed)$/,
  /^application\/vnd\.openxmlformats-officedocument\.[\w.-]+$/, /^application\/vnd\.oasis\.opendocument\.[\w.-]+$/,
];
export const safeContentType = (t) => {
  const type = String(t || '').split(';')[0].trim().toLowerCase();
  return SAFE_TYPES.some((re) => re.test(type)) ? type : 'application/octet-stream';
};

async function contractOf(db, partnerId, contractId) {
  if (contractId == null) return null;
  const c = await first(db, 'SELECT id, number, title FROM partner_contracts WHERE id = ? AND partner_id = ?', contractId, partnerId);
  if (!c) throw fieldError('contract_id', 'Ismeretlen szerződés.');
  return c;
}

async function documentOf(db, partnerId, docId) {
  const d = await first(db, "SELECT * FROM documents WHERE id = ? AND partner_id = ? AND kind IN ('contract', 'other')", idOf(docId, 'A dokumentum'), partnerId);
  if (!d) throw notFound('A dokumentum nem található.');
  return d;
}

// ---------------------------------------------------------------- webshop connections

export function platforms() {
  try {
    const list = listPlatforms();
    return Array.isArray(list) ? list.filter((p) => p && p.code) : [];
  } catch (err) {
    console.error('listPlatforms failed', err);
    return [];
  }
}

const fieldsOf = (list) => (Array.isArray(list) ? list.filter((f) => f && f.key) : []);

// Options of a select field as [{ value, label }], from [{ value, label }], [[value, label]] or ['value'].
export function optionList(options) {
  if (!Array.isArray(options)) return [];
  return options.map((o) => (Array.isArray(o) ? { value: String(o[0]), label: String(o[1] ?? o[0]) }
    : o && typeof o === 'object' ? { value: String(o.value), label: String(o.label ?? o.value) } : { value: String(o), label: String(o) }));
}

const BOOL_TYPES = new Set(['checkbox', 'bool', 'boolean']);
const NUM_TYPES = new Set(['number', 'int', 'integer', 'num']);

// Settings from the platform's settingFields. Unknown keys are dropped. Errors keyed "set_<key>".
export function readSettings(fields, incoming, stored = {}) {
  const out = {};
  const errors = {};
  const src = incoming && typeof incoming === 'object' ? incoming : {};
  for (const f of fieldsOf(fields)) {
    const has = Object.prototype.hasOwnProperty.call(src, f.key);
    const raw = has ? src[f.key] : stored[f.key];
    const t = String(f.type || 'text').toLowerCase();
    const name = `set_${f.key}`;
    if (BOOL_TYPES.has(t)) {
      out[f.key] = raw === true || raw === 1 || raw === '1' || raw === 'true' || raw === 'on';
      continue;
    }
    const empty = raw === undefined || raw === null || String(raw).trim() === '';
    if (empty) {
      if (f.required) errors[name] = 'Kötelező mező.';
      else if (f.default !== undefined) out[f.key] = f.default;
      continue;
    }
    if (NUM_TYPES.has(t)) {
      const x = Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(x)) errors[name] = 'Számot várunk.';
      else if ((t === 'int' || t === 'integer') && !Number.isInteger(x)) errors[name] = 'Egész számot várunk.';
      else out[f.key] = x;
    } else if (t === 'select') {
      const v = String(raw);
      if (!optionList(f.options).some((o) => o.value === v)) errors[name] = 'Érvénytelen érték.';
      else out[f.key] = v;
    } else {
      const v = String(raw).trim();
      if (v.length > 2000) errors[name] = 'Legfeljebb 2000 karakter lehet.';
      else out[f.key] = v;
    }
  }
  return { settings: out, errors };
}

// Credentials from the platform's credentialFields, merged with the stored ones: an empty or missing
// value keeps what is stored, null clears it. Unknown keys are dropped. Errors keyed "cred_<key>".
export function mergeCredentials(fields, incoming, stored = {}) {
  const out = {};
  const errors = {};
  const src = incoming && typeof incoming === 'object' ? incoming : {};
  for (const f of fieldsOf(fields)) {
    const v = src[f.key];
    if (v === null) {
      // cleared
    } else if (v !== undefined && String(v).trim() !== '') {
      const s = String(v).trim();
      if (s.length > 4000) errors[`cred_${f.key}`] = 'Túl hosszú érték.';
      else out[f.key] = s;
    } else if (stored[f.key] != null && String(stored[f.key]) !== '') {
      out[f.key] = stored[f.key];
    }
    if (f.required && !out[f.key] && !errors[`cred_${f.key}`]) errors[`cred_${f.key}`] = 'Kötelező mező.';
  }
  return { credentials: out, errors };
}

export function normalizeShopUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return { error: 'Add meg a webshop címét.' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return { error: 'Érvényes webcímet adj meg, pl. https://bolt.hu' };
  }
  if (u.protocol !== 'https:') return { error: 'A webshop címe https:// kezdetű legyen.' };
  if (!u.hostname.includes('.') || u.username || u.password) return { error: 'Érvényes webcímet adj meg, pl. https://bolt.hu' };
  return { url: `https://${u.host}${u.pathname.replace(/\/+$/, '')}` };
}

async function connectionOut(env, row, defs) {
  const def = defs.find((p) => p.code === row.platform);
  let creds = {};
  let credentialsError = '';
  try {
    creds = await decryptJson(env, row.credentials);
  } catch {
    credentialsError = 'A mentett hozzáférési adatok nem olvashatók. Add meg őket újra.';
  }
  return {
    id: row.id,
    partner_id: row.partner_id,
    platform: row.platform,
    platform_name: def ? def.name : WEBSHOP_PLATFORMS[row.platform] || row.platform,
    available: !!def,
    shop_url: row.shop_url,
    active: !!row.active,
    settings: parseJson(row.settings, {}),
    credentials: maskCredentials(creds),
    credentials_error: credentialsError,
    last_sync_at: row.last_sync_at,
    last_error: row.last_error,
    created_at: row.created_at,
  };
}

async function connectionOf(db, partnerId, wid) {
  const c = await first(db, 'SELECT * FROM webshop_connections WHERE id = ? AND partner_id = ?', idOf(wid, 'A kapcsolat'), partnerId);
  if (!c) throw notFound('A webshop kapcsolat nem található.');
  return c;
}

// ---------------------------------------------------------------- delete check

const USAGE = [
  ['orders', 'rendelés', '(SELECT COUNT(*) FROM orders WHERE partner_id = ? OR carrier_id = ?)', 2],
  ['products', 'termék', '(SELECT COUNT(*) FROM products WHERE partner_id = ?)', 1],
  ['stock', 'db készlet', '(SELECT COALESCE(SUM(s.qty), 0) FROM stock s JOIN products p ON p.id = s.product_id WHERE p.partner_id = ?)', 1],
  ['inbounds', 'betárolás', '(SELECT COUNT(*) FROM inbounds WHERE partner_id = ? OR supplier_id = ?)', 2],
  ['statements', 'elszámolás', '(SELECT COUNT(*) FROM statements WHERE partner_id = ?)', 1],
  ['returns', 'visszáru', '(SELECT COUNT(*) FROM returns WHERE partner_id = ?)', 1],
  ['movements', 'készletmozgás', '(SELECT COUNT(*) FROM movements WHERE partner_id = ?)', 1],
  ['snapshots', 'tárolási napló sor', '(SELECT COUNT(*) FROM storage_snapshots WHERE partner_id = ?)', 1],
  ['billing_entries', 'rögzített munka', '(SELECT COUNT(*) FROM billing_entries WHERE partner_id = ?)', 1],
  ['pickups', 'futárátvétel', '(SELECT COUNT(*) FROM carrier_pickups WHERE carrier_id = ?)', 1],
  ['transports', 'fuvar', '(SELECT COUNT(*) FROM transports WHERE partner_id = ? OR carrier_id = ?)', 2],
];

async function usageOf(db, id) {
  const row = await first(db, `SELECT ${USAGE.map(([k, , sql]) => `${sql} AS ${k}`).join(', ')}`,
    ...USAGE.flatMap(([, , , n]) => Array(n).fill(id)));
  const blockers = USAGE.filter(([k]) => row[k] > 0).map(([k, label]) => ({ key: k, label, count: row[k] }));
  return { counts: Object.fromEntries(USAGE.map(([k]) => [k, row[k]])), blockers };
}

// ---------------------------------------------------------------- summary

async function clientSummary(db, p) {
  const today = budapestDate();
  const period = today.slice(0, 7);
  const last = prevMonth(period);
  const cur = monthInstants(period);
  const prev = monthInstants(last);
  const [skus, onHand, openInbounds] = await Promise.all([
    first(db, 'SELECT COUNT(*) AS n FROM products WHERE partner_id = ? AND active = 1', p.id),
    first(db, 'SELECT COALESCE(SUM(s.qty), 0) AS n FROM stock s JOIN products p ON p.id = s.product_id WHERE p.partner_id = ?', p.id),
    first(db, "SELECT COUNT(*) AS n FROM inbounds WHERE partner_id = ? AND status IN ('expected', 'arrived', 'receiving')", p.id),
  ]);
  const occupied = await all(db,
    `SELECT ls.id AS size_id, ls.code, ls.name, COUNT(DISTINCT s.location_id) AS locations
     FROM stock s JOIN products pr ON pr.id = s.product_id JOIN locations l ON l.id = s.location_id JOIN location_sizes ls ON ls.id = l.size_id
     WHERE pr.partner_id = ? AND s.qty > 0 AND l.kind = 'storage'
     GROUP BY ls.id ORDER BY ls.sort, ls.code`, p.id);
  const inbounds = await all(db,
    `SELECT i.id, i.number, i.status, i.expected_date, i.created_at, i.external_ref,
            (SELECT COUNT(*) FROM inbound_lines WHERE inbound_id = i.id) AS lines,
            (SELECT COALESCE(SUM(expected_qty), 0) FROM inbound_lines WHERE inbound_id = i.id) AS expected_qty
     FROM inbounds i WHERE i.partner_id = ? AND i.status IN ('expected', 'arrived', 'receiving')
     ORDER BY COALESCE(i.expected_date, '9999-12-31'), i.id LIMIT 10`, p.id);
  const byStatus = await all(db,
    `SELECT status,
            SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END) AS this_month,
            SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END) AS last_month
     FROM orders WHERE partner_id = ? AND created_at >= ? AND created_at < ? GROUP BY status`,
    cur.from, cur.to, prev.from, prev.to, p.id, prev.from, cur.to);
  const order = Object.keys(STATUSES.order);
  byStatus.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const shipped = await all(db,
    `SELECT o.id, o.number, o.external_number, o.customer_name, o.city, o.status, o.shipped_at, o.shipped_date, o.tracking_number,
            c.name AS carrier_name, (SELECT COALESCE(SUM(qty), 0) FROM order_lines WHERE order_id = o.id) AS items
     FROM orders o LEFT JOIN partners c ON c.id = o.carrier_id
     WHERE o.partner_id = ? AND o.shipped_at IS NOT NULL ORDER BY o.shipped_at DESC LIMIT 10`, p.id);

  // Storage this month from the daily snapshots, priced pro rata by day with the client's prices.
  const { from, days } = monthRange(period);
  const defaults = await defaultTariffs(db);
  const storageDefaults = defaults.storage || {};
  const snap = await all(db,
    `SELECT ss.size_id, ls.code, ls.name, COUNT(*) AS location_days, sp.price
     FROM storage_snapshots ss JOIN location_sizes ls ON ls.id = ss.size_id
     LEFT JOIN partner_storage_prices sp ON sp.partner_id = ss.partner_id AND sp.size_id = ss.size_id
     WHERE ss.partner_id = ? AND ss.date >= ? AND ss.date <= ?
     GROUP BY ss.size_id ORDER BY ls.sort, ls.code`, p.id, from, today);
  const snapDays = (await first(db, 'SELECT COUNT(DISTINCT date) AS n FROM storage_snapshots WHERE date >= ? AND date <= ?', from, today)).n;
  const bySize = snap.map((s) => {
    const price = s.price == null ? num(storageDefaults[s.code]) : num(s.price);
    return {
      size_id: s.size_id, code: s.code, name: s.name, location_days: s.location_days,
      avg_locations: snapDays ? s.location_days / snapDays : 0,
      price, amount: Math.round((s.location_days * price / days) * 100) / 100,
    };
  });
  const sum = (list, k) => list.reduce((a, x) => a + num(x[k]), 0);
  return {
    type: 'client',
    period,
    last_period: last,
    kpis: {
      active_skus: skus.n,
      on_hand: onHand.n,
      occupied_locations: sum(occupied, 'locations'),
      open_inbounds: openInbounds.n,
      orders_this_month: sum(byStatus, 'this_month'),
      orders_last_month: sum(byStatus, 'last_month'),
    },
    occupied_by_size: occupied,
    open_inbounds: inbounds,
    orders_by_status: byStatus,
    last_shipped: shipped,
    storage_month: { period, days_in_month: days, days_snapshotted: snapDays, by_size: bySize, total: Math.round(sum(bySize, 'amount') * 100) / 100 },
  };
}

async function carrierSummary(db, p) {
  const period = budapestDate().slice(0, 7);
  const last = prevMonth(period);
  const cur = monthRange(period);
  const prev = monthRange(last);
  const count = (r) => first(db, 'SELECT COUNT(*) AS n FROM orders WHERE carrier_id = ? AND shipped_date >= ? AND shipped_date <= ?', p.id, r.from, r.to);
  const [thisMonth, lastMonth, pickupsThisMonth] = await Promise.all([
    count(cur), count(prev),
    first(db, "SELECT COUNT(*) AS n FROM carrier_pickups WHERE carrier_id = ? AND date >= ? AND date <= ? AND status <> 'cancelled'", p.id, cur.from, cur.to),
  ]);
  const byClient = await all(db,
    `SELECT pa.id, pa.code, pa.name, COUNT(*) AS orders FROM orders o JOIN partners pa ON pa.id = o.partner_id
     WHERE o.carrier_id = ? AND o.shipped_date >= ? AND o.shipped_date <= ?
     GROUP BY pa.id ORDER BY orders DESC, pa.name LIMIT 20`, p.id, cur.from, cur.to);
  const pickups = await all(db,
    `SELECT cp.id, cp.number, cp.date, cp.window_from, cp.window_to, cp.status, cp.manifest_number, cp.closed_at,
            (SELECT COUNT(*) FROM orders WHERE pickup_id = cp.id) AS orders
     FROM carrier_pickups cp WHERE cp.carrier_id = ? ORDER BY cp.date DESC, cp.id DESC LIMIT 10`, p.id);
  return {
    type: 'carrier',
    period,
    last_period: last,
    kpis: { shipped_this_month: thisMonth.n, shipped_last_month: lastMonth.n, pickups_this_month: pickupsThisMonth.n },
    by_client: byClient,
    last_pickups: pickups,
  };
}

async function supplierSummary(db, p) {
  const year = budapestDate().slice(0, 4);
  const from = budapestStartIso(`${year}-01-01`);
  const [count, open, received] = await Promise.all([
    first(db, "SELECT COUNT(*) AS n FROM inbounds WHERE supplier_id = ? AND created_at >= ? AND status <> 'cancelled'", p.id, from),
    first(db, "SELECT COUNT(*) AS n FROM inbounds WHERE supplier_id = ? AND status IN ('expected', 'arrived', 'receiving')", p.id),
    first(db, `SELECT COALESCE(SUM(l.received_qty), 0) AS n FROM inbound_lines l JOIN inbounds i ON i.id = l.inbound_id
               WHERE i.supplier_id = ? AND i.created_at >= ? AND i.status <> 'cancelled'`, p.id, from),
  ]);
  const lastInbounds = await all(db,
    `SELECT i.id, i.number, i.status, i.expected_date, i.completed_at, i.created_at, i.external_ref, pa.name AS client_name, pa.code AS client_code,
            (SELECT COALESCE(SUM(expected_qty), 0) FROM inbound_lines WHERE inbound_id = i.id) AS expected_qty,
            (SELECT COALESCE(SUM(received_qty), 0) FROM inbound_lines WHERE inbound_id = i.id) AS received_qty
     FROM inbounds i JOIN partners pa ON pa.id = i.partner_id
     WHERE i.supplier_id = ? ORDER BY i.created_at DESC, i.id DESC LIMIT 10`, p.id);
  return {
    type: 'supplier',
    year: Number(year),
    kpis: { inbounds_this_year: count.n, open_inbounds: open.n, received_this_year: received.n },
    last_inbounds: lastInbounds,
  };
}

// ---------------------------------------------------------------- routes

export function register(r) {
  // ------------------------------------------------------------ list and create
  r.get('/api/partners', async (ctx) => {
    const db = ctx.env.DB;
    const type = Object.keys(PARTNER_TYPES).includes(ctx.query.get('type')) ? ctx.query.get('type') : null;
    const status = Object.keys(STATUSES.partner).includes(ctx.query.get('status')) ? ctx.query.get('status') : null;
    const q = (ctx.query.get('q') || '').trim().slice(0, 100);
    const like = q ? `%${q}%` : null;
    const { limit, offset } = page(ctx.query);
    const where = `(? IS NULL OR p.status = ?) AND (? IS NULL OR p.code LIKE ? OR p.name LIKE ? OR p.tax_number LIKE ? OR p.city LIKE ? OR p.billing_email LIKE ?)`;
    const whereArgs = [status, status, like, like, like, like, like, like];
    const items = await all(db,
      `SELECT p.id, p.type, p.code, p.name, p.status, p.tax_number, p.zip, p.city, p.billing_email, p.carrier_code, p.website, p.created_at,
              c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone
       FROM partners p
       LEFT JOIN partner_contacts c ON c.id = (SELECT id FROM partner_contacts WHERE partner_id = p.id ORDER BY is_primary DESC, id LIMIT 1)
       WHERE (? IS NULL OR p.type = ?) AND ${where}
       ORDER BY p.name COLLATE NOCASE, p.id LIMIT ? OFFSET ?`,
      type, type, ...whereArgs, limit, offset);
    const byType = await all(db, `SELECT p.type, COUNT(*) AS n FROM partners p WHERE ${where} GROUP BY p.type`, ...whereArgs);
    const counts = { all: 0, client: 0, carrier: 0, supplier: 0 };
    for (const row of byType) { counts[row.type] = row.n; counts.all += row.n; }
    return { items, total: type ? counts[type] : counts.all, counts, limit, offset };
  }, { perm: [M, 'view'] });

  r.post('/api/partners', async (ctx) => {
    const db = ctx.env.DB;
    const data = cleanPartner(validate(await ctx.body(), PARTNER_FIELDS));
    await assertCodeFree(db, data.code);
    const cols = Object.keys(data);
    const statements = [stmt(db, `INSERT INTO partners (${cols.join(', ')}) VALUES (${marks(cols.length)})`, ...cols.map((k) => data[k]))];
    if (data.type === 'client') statements.push(...await defaultTariffStatements(db, '(SELECT id FROM partners WHERE code = ?)', [data.code]));
    try {
      await batch(db, statements);
    } catch (err) {
      if (/UNIQUE/i.test(String(err && err.message))) throw conflict('Ez a kód már foglalt.', { code: 'Ez a kód már foglalt.' });
      throw err;
    }
    const row = await first(db, 'SELECT id FROM partners WHERE code = ?', data.code);
    await audit(ctx, {
      module: M, action: 'create', entity: 'partner', entityId: row.id,
      summary: `${PARTNER_TYPES[data.type]} létrehozva: ${data.name} (${data.code})`,
    });
    return { id: row.id, code: data.code };
  }, { perm: [M, 'create'] });

  // ------------------------------------------------------------ one partner
  r.get('/api/partners/:id', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    const counts = await first(db,
      `SELECT (SELECT COUNT(*) FROM partner_contacts WHERE partner_id = ?) AS contacts,
              (SELECT COUNT(*) FROM partner_contracts WHERE partner_id = ?) AS contracts,
              (SELECT COUNT(*) FROM documents WHERE partner_id = ? AND kind IN ('contract', 'other')) AS documents,
              (SELECT COUNT(*) FROM webshop_connections WHERE partner_id = ?) AS webshops,
              (SELECT COUNT(*) FROM api_keys WHERE partner_id = ? AND revoked_at IS NULL) AS api_keys,
              (SELECT COUNT(*) FROM partner_custom_items WHERE partner_id = ? AND active = 1) AS custom_items`,
      p.id, p.id, p.id, p.id, p.id, p.id);
    const usage = await usageOf(db, p.id);
    return { ...p, counts, usage: usage.counts, delete_blockers: usage.blockers, can_delete: usage.blockers.length === 0 };
  }, { perm: [M, 'view'] });

  r.patch('/api/partners/:id', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    const body = await ctx.body();
    if (body.type !== undefined && body.type !== p.type) throw fieldError('type', 'A partner típusa nem módosítható.');
    const data = cleanPartner(validate(body, PARTNER_UPDATE_FIELDS, { partial: true }), p);
    if (data.code !== undefined && data.code !== p.code) await assertCodeFree(db, data.code, p.id);
    const changed = Object.keys(data).filter((k) => String(data[k] ?? '') !== String(p[k] ?? ''));
    if (!changed.length) return { ok: true, changed: [] };
    try {
      await run(db, `UPDATE partners SET ${changed.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        ...changed.map((k) => data[k]), nowIso(), p.id);
    } catch (err) {
      if (/UNIQUE/i.test(String(err && err.message))) throw conflict('Ez a kód már foglalt.', { code: 'Ez a kód már foglalt.' });
      throw err;
    }
    const statusText = changed.includes('status') ? ` (${STATUSES.partner[data.status].label.toLowerCase()})` : '';
    await audit(ctx, {
      module: M, action: 'edit', entity: 'partner', entityId: p.id, summary: `Partner módosítva: ${data.name || p.name}${statusText}`,
      details: Object.fromEntries(changed.map((k) => [k, { from: p[k], to: data[k] }])),
    });
    return { ok: true, changed };
  }, { perm: [M, 'edit'] });

  r.delete('/api/partners/:id', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    const { blockers } = await usageOf(db, p.id);
    if (blockers.length) {
      const list = blockers.map((b) => `${b.count} ${b.label}`).join(', ');
      throw conflict(`${p.name} nem törölhető, mert vannak hozzá tartozó adatok (${list}). Inaktiváld inkább, így a története megmarad.`);
    }
    const docs = await all(db, 'SELECT r2_key FROM documents WHERE partner_id = ?', p.id);
    try {
      await run(db, 'DELETE FROM partners WHERE id = ?', p.id);
    } catch (err) {
      // A table of another module still points at the partner.
      if (/FOREIGN KEY/i.test(String(err && err.message))) throw conflict(`${p.name} nem törölhető, mert más adatok hivatkoznak rá. Inaktiváld inkább.`);
      throw err;
    }
    for (const d of docs) {
      try { await ctx.env.FILES.delete(d.r2_key); } catch (err) { console.error('R2 delete failed', d.r2_key, err); }
    }
    await audit(ctx, { module: M, action: 'delete', entity: 'partner', entityId: p.id, summary: `Partner törölve: ${p.name} (${p.code})` });
    return { ok: true };
  }, { perm: [M, 'delete'] });

  // ------------------------------------------------------------ contacts
  r.get('/api/partners/:id/contacts', async (ctx) => {
    const p = await getPartner(ctx.env.DB, ctx.params.id);
    return { items: await all(ctx.env.DB, 'SELECT * FROM partner_contacts WHERE partner_id = ? ORDER BY is_primary DESC, name COLLATE NOCASE', p.id) };
  }, { perm: [M, 'view'] });

  r.post('/api/partners/:id/contacts', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    const c = validate(await ctx.body(), CONTACT_FIELDS);
    const existing = (await first(db, 'SELECT COUNT(*) AS n FROM partner_contacts WHERE partner_id = ?', p.id)).n;
    const primary = c.is_primary || existing === 0;
    const res = await batch(db, [
      primary ? stmt(db, 'UPDATE partner_contacts SET is_primary = 0 WHERE partner_id = ?', p.id) : null,
      stmt(db, 'INSERT INTO partner_contacts (partner_id, name, position, email, phone, is_primary, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
        p.id, c.name, c.position, c.email, c.phone, primary ? 1 : 0, c.notes),
    ]);
    const id = res[res.length - 1].meta.last_row_id;
    await audit(ctx, { module: M, action: 'edit', entity: 'partner_contact', entityId: id, summary: `Kapcsolattartó felvéve: ${c.name} (${p.name})` });
    return { id };
  }, { perm: [M, 'edit'] });

  r.patch('/api/partners/:id/contacts/:cid', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    const cur = await first(db, 'SELECT * FROM partner_contacts WHERE id = ? AND partner_id = ?', idOf(ctx.params.cid, 'A kapcsolattartó'), p.id);
    if (!cur) throw notFound('A kapcsolattartó nem található.');
    const c = validate(await ctx.body(), CONTACT_FIELDS, { partial: true });
    const statements = [];
    if (c.is_primary === true) {
      statements.push(stmt(db, 'UPDATE partner_contacts SET is_primary = 0 WHERE partner_id = ? AND id <> ?', p.id, cur.id));
    } else if (c.is_primary === false && cur.is_primary) {
      // Someone must stay primary: the oldest other contact takes over, or this one stays.
      const other = await first(db, 'SELECT id FROM partner_contacts WHERE partner_id = ? AND id <> ? ORDER BY id LIMIT 1', p.id, cur.id);
      if (other) statements.push(stmt(db, 'UPDATE partner_contacts SET is_primary = 1 WHERE id = ?', other.id));
      else c.is_primary = true;
    }
    const keys = Object.keys(c);
    if (keys.length) statements.push(stmt(db, `UPDATE partner_contacts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => c[k]), cur.id));
    await batch(db, statements);
    await audit(ctx, { module: M, action: 'edit', entity: 'partner_contact', entityId: cur.id, summary: `Kapcsolattartó módosítva: ${c.name || cur.name} (${p.name})` });
    return { ok: true };
  }, { perm: [M, 'edit'] });

  r.delete('/api/partners/:id/contacts/:cid', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    const cur = await first(db, 'SELECT * FROM partner_contacts WHERE id = ? AND partner_id = ?', idOf(ctx.params.cid, 'A kapcsolattartó'), p.id);
    if (!cur) throw notFound('A kapcsolattartó nem található.');
    await batch(db, [
      stmt(db, 'DELETE FROM partner_contacts WHERE id = ?', cur.id),
      cur.is_primary ? stmt(db, `UPDATE partner_contacts SET is_primary = 1 WHERE id = (SELECT id FROM partner_contacts WHERE partner_id = ? ORDER BY id LIMIT 1)`, p.id) : null,
    ]);
    await audit(ctx, { module: M, action: 'edit', entity: 'partner_contact', entityId: cur.id, summary: `Kapcsolattartó törölve: ${cur.name} (${p.name})` });
    return { ok: true };
  }, { perm: [M, 'edit'] });

  // ------------------------------------------------------------ contracts
  r.get('/api/partners/:id/contracts', async (ctx) => {
    const p = await getPartner(ctx.env.DB, ctx.params.id);
    const items = await all(ctx.env.DB,
      `SELECT c.*, (SELECT COUNT(*) FROM documents d WHERE d.contract_id = c.id) AS documents
       FROM partner_contracts c WHERE c.partner_id = ? ORDER BY COALESCE(c.start_date, '0000') DESC, c.id DESC`, p.id);
    return { items };
  }, { perm: [M, 'view'] });

  const checkContractDates = (c) => {
    if (c.start_date && c.end_date && c.end_date < c.start_date) throw fieldError('end_date', 'A lejárat nem lehet a kezdés előtt.');
  };

  r.post('/api/partners/:id/contracts', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    const c = validate(await ctx.body(), CONTRACT_FIELDS);
    checkContractDates(c);
    const res = await run(db,
      'INSERT INTO partner_contracts (partner_id, number, title, start_date, end_date, notice_days, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      p.id, c.number, c.title, c.start_date || null, c.end_date || null, c.notice_days, c.status, c.notes);
    const id = res.meta.last_row_id;
    await audit(ctx, { module: M, action: 'edit', entity: 'partner_contract', entityId: id, summary: `Szerződés felvéve: ${c.number || c.title} (${p.name})` });
    return { id };
  }, { perm: [M, 'edit'] });

  r.patch('/api/partners/:id/contracts/:cid', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    const cur = await first(db, 'SELECT * FROM partner_contracts WHERE id = ? AND partner_id = ?', idOf(ctx.params.cid, 'A szerződés'), p.id);
    if (!cur) throw notFound('A szerződés nem található.');
    const c = validate(await ctx.body(), CONTRACT_FIELDS, { partial: true });
    checkContractDates({ start_date: c.start_date !== undefined ? c.start_date : cur.start_date, end_date: c.end_date !== undefined ? c.end_date : cur.end_date });
    const keys = Object.keys(c);
    if (keys.length) await run(db, `UPDATE partner_contracts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => c[k]), cur.id);
    await audit(ctx, {
      module: M, action: 'edit', entity: 'partner_contract', entityId: cur.id, summary: `Szerződés módosítva: ${c.number || cur.number || c.title || cur.title} (${p.name})`,
      details: Object.fromEntries(keys.filter((k) => String(c[k] ?? '') !== String(cur[k] ?? '')).map((k) => [k, { from: cur[k], to: c[k] }])),
    });
    return { ok: true };
  }, { perm: [M, 'edit'] });

  r.delete('/api/partners/:id/contracts/:cid', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    const cur = await first(db, 'SELECT * FROM partner_contracts WHERE id = ? AND partner_id = ?', idOf(ctx.params.cid, 'A szerződés'), p.id);
    if (!cur) throw notFound('A szerződés nem található.');
    await run(db, 'DELETE FROM partner_contracts WHERE id = ?', cur.id);
    await audit(ctx, { module: M, action: 'edit', entity: 'partner_contract', entityId: cur.id, summary: `Szerződés törölve: ${cur.number || cur.title} (${p.name})` });
    return { ok: true };
  }, { perm: [M, 'edit'] });

  // ------------------------------------------------------------ documents
  r.get('/api/partners/:id/documents', async (ctx) => {
    const p = await getPartner(ctx.env.DB, ctx.params.id);
    const items = await all(ctx.env.DB,
      `SELECT d.id, d.kind, d.filename, d.content_type, d.size, d.uploaded_at, d.contract_id, c.number AS contract_number, c.title AS contract_title,
              u.name AS uploaded_by_name
       FROM documents d LEFT JOIN partner_contracts c ON c.id = d.contract_id LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE d.partner_id = ? AND d.kind IN ('contract', 'other') ORDER BY d.uploaded_at DESC, d.id DESC`, p.id);
    return { items };
  }, { perm: [M, 'view'] });

  r.post('/api/partners/:id/documents', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    const { file, form } = await readUpload(ctx);
    const kind = String(form.get('kind') || 'other');
    if (!DOCUMENT_KINDS[kind]) throw fieldError('kind', 'Válassz típust.');
    const rawContract = String(form.get('contract_id') || '').trim();
    if (rawContract && !/^[1-9]\d{0,9}$/.test(rawContract)) throw fieldError('contract_id', 'Ismeretlen szerződés.');
    const contract = rawContract ? await contractOf(db, p.id, Number(rawContract)) : null;
    const filename = String(file.name || 'dokumentum').replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || 'dokumentum';
    if (!file.size) throw fieldError('file', 'A kiválasztott fájl üres.');
    const id = await storeFile(ctx, {
      partnerId: p.id, contractId: contract ? contract.id : null, kind, filename, contentType: safeContentType(file.type), body: await file.arrayBuffer(),
    });
    await audit(ctx, { module: M, action: 'edit', entity: 'document', entityId: id, summary: `Dokumentum feltöltve: ${filename} (${p.name})` });
    return { id };
  }, { perm: [M, 'edit'] });

  r.patch('/api/partners/:id/documents/:did', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    const doc = await documentOf(db, p.id, ctx.params.did);
    const d = validate(await ctx.body(), { kind: { type: 'enum', values: Object.keys(DOCUMENT_KINDS) }, contract_id: { type: 'id', nullable: true } }, { partial: true });
    if (d.contract_id) await contractOf(db, p.id, d.contract_id);
    const keys = Object.keys(d);
    if (keys.length) await run(db, `UPDATE documents SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => d[k]), doc.id);
    await audit(ctx, { module: M, action: 'edit', entity: 'document', entityId: doc.id, summary: `Dokumentum módosítva: ${doc.filename} (${p.name})` });
    return { ok: true };
  }, { perm: [M, 'edit'] });

  r.delete('/api/partners/:id/documents/:did', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    const doc = await documentOf(db, p.id, ctx.params.did);
    await deleteDocument(ctx, doc.id);
    await audit(ctx, { module: M, action: 'edit', entity: 'document', entityId: doc.id, summary: `Dokumentum törölve: ${doc.filename} (${p.name})` });
    return { ok: true };
  }, { perm: [M, 'edit'] });

  // ------------------------------------------------------------ tariffs (clients)
  r.get('/api/partners/:id/tariffs', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    requireClient(p);
    return loadTariffs(db, p.id);
  }, { perm: [M, 'view'] });

  r.put('/api/partners/:id/tariffs', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    requireClient(p);
    const sizes = await activeSizes(db);
    const input = readTariffInput(await ctx.body(), sizes);
    const before = await loadTariffs(db, p.id);
    const statements = [
      ...Object.entries(input.tariffs).map(([key, value]) => stmt(db,
        'INSERT INTO partner_tariffs (partner_id, key, value) VALUES (?, ?, ?) ON CONFLICT (partner_id, key) DO UPDATE SET value = excluded.value',
        p.id, key, value)),
      ...Object.entries(input.storage).map(([sizeId, price]) => stmt(db,
        'INSERT INTO partner_storage_prices (partner_id, size_id, price) VALUES (?, ?, ?) ON CONFLICT (partner_id, size_id) DO UPDATE SET price = excluded.price',
        p.id, Number(sizeId), price)),
    ];
    if (statements.length) await batch(db, statements);
    const changes = {};
    for (const t of before.tariffs) if (input.tariffs[t.key] !== undefined && !sameNum(input.tariffs[t.key], t.value)) changes[t.key] = { from: t.value, to: input.tariffs[t.key] };
    for (const s of before.storage) if (input.storage[s.size_id] !== undefined && !sameNum(input.storage[s.size_id], s.price)) changes[`storage:${s.code}`] = { from: s.price, to: input.storage[s.size_id] };
    await audit(ctx, {
      module: M, action: 'approve', entity: 'partner_tariffs', entityId: p.id,
      summary: `Tarifák mentve: ${p.name} (${Object.keys(changes).length} változás)`, details: changes,
    });
    return loadTariffs(db, p.id);
  }, { perm: [M, 'approve'] });

  r.post('/api/partners/:id/tariffs/reset', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    requireClient(p);
    await batch(db, await defaultTariffStatements(db, '?', [p.id]));
    await audit(ctx, { module: M, action: 'approve', entity: 'partner_tariffs', entityId: p.id, summary: `Tarifák visszaállítva az alapértékekre: ${p.name}` });
    return loadTariffs(db, p.id);
  }, { perm: [M, 'approve'] });

  // ------------------------------------------------------------ custom tariff items (clients)
  const customItemOf = async (db, partnerId, itemId) => {
    const it = await first(db, 'SELECT * FROM partner_custom_items WHERE id = ? AND partner_id = ?', idOf(itemId, 'Az egyedi tétel'), partnerId);
    if (!it) throw notFound('Az egyedi tétel nem található.');
    return it;
  };

  r.post('/api/partners/:id/custom-items', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    requireClient(p);
    const it = validate(await ctx.body(), CUSTOM_ITEM_FIELDS);
    const res = await run(db, 'INSERT INTO partner_custom_items (partner_id, name, unit, price, kind, active) VALUES (?, ?, ?, ?, ?, ?)',
      p.id, it.name, it.unit || 'db', it.price, it.kind, it.active);
    const id = res.meta.last_row_id;
    await audit(ctx, { module: M, action: 'approve', entity: 'custom_item', entityId: id, summary: `Egyedi tétel felvéve: ${it.name} (${p.name})`, details: it });
    return { id };
  }, { perm: [M, 'approve'] });

  r.patch('/api/partners/:id/custom-items/:itemId', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    requireClient(p);
    const cur = await customItemOf(db, p.id, ctx.params.itemId);
    const it = validate(await ctx.body(), CUSTOM_ITEM_FIELDS, { partial: true });
    if (it.unit !== undefined && !it.unit) it.unit = 'db';
    const keys = Object.keys(it);
    if (keys.length) await run(db, `UPDATE partner_custom_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => it[k]), cur.id);
    await audit(ctx, {
      module: M, action: 'approve', entity: 'custom_item', entityId: cur.id, summary: `Egyedi tétel módosítva: ${it.name || cur.name} (${p.name})`,
      details: Object.fromEntries(keys.map((k) => [k, { from: cur[k], to: it[k] }])),
    });
    return { ok: true };
  }, { perm: [M, 'approve'] });

  r.delete('/api/partners/:id/custom-items/:itemId', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    requireClient(p);
    const cur = await customItemOf(db, p.id, ctx.params.itemId);
    const used = (await first(db, 'SELECT COUNT(*) AS n FROM billing_entries WHERE custom_item_id = ?', cur.id)).n;
    if (used) throw conflict(`A(z) „${cur.name}” tételhez már ${used} rögzített mennyiség tartozik, ezért nem törölhető. Inaktiváld inkább.`);
    await run(db, 'DELETE FROM partner_custom_items WHERE id = ?', cur.id);
    await audit(ctx, { module: M, action: 'approve', entity: 'custom_item', entityId: cur.id, summary: `Egyedi tétel törölve: ${cur.name} (${p.name})` });
    return { ok: true };
  }, { perm: [M, 'approve'] });

  // ------------------------------------------------------------ integrations (clients)
  r.get('/api/partners/:id/integrations', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    requireClient(p);
    const defs = platforms();
    const rows = await all(db, 'SELECT * FROM webshop_connections WHERE partner_id = ? ORDER BY id', p.id);
    const keys = await all(db,
      `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at, u.name AS created_by_name
       FROM api_keys k LEFT JOIN users u ON u.id = k.created_by WHERE k.partner_id = ? ORDER BY k.revoked_at IS NOT NULL, k.id DESC`, p.id);
    return {
      platforms: defs.map((d) => ({
        code: d.code, name: d.name || WEBSHOP_PLATFORMS[d.code] || d.code,
        credentialFields: fieldsOf(d.credentialFields).map((f) => ({ ...f, options: f.options ? optionList(f.options) : undefined })),
        settingFields: fieldsOf(d.settingFields).map((f) => ({ ...f, options: f.options ? optionList(f.options) : undefined })),
      })),
      connections: await Promise.all(rows.map((row) => connectionOut(ctx.env, row, defs))),
      api_keys: keys,
      api_docs_url: '/api/v1/docs',
    };
  }, { perm: [M, 'view'] });

  r.post('/api/partners/:id/webshops', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    requireClient(p);
    const body = await ctx.body();
    const defs = platforms();
    const def = defs.find((d) => d.code === body.platform);
    if (!def) {
      throw fieldError('platform', defs.length ? 'Válassz platformot.' : 'Még nincs elérhető webshop integráció, ezért kapcsolat sem vehető fel.');
    }
    const errors = {};
    const shop = normalizeShopUrl(body.shop_url);
    if (shop.error) errors.shop_url = shop.error;
    const creds = mergeCredentials(def.credentialFields, body.credentials, {});
    const sets = readSettings(def.settingFields, body.settings, {});
    Object.assign(errors, creds.errors, sets.errors);
    if (Object.keys(errors).length) throw badRequest('Ellenőrizd a megjelölt mezőket.', errors);
    const active = body.active === undefined ? true : !!body.active;
    const res = await run(db,
      'INSERT INTO webshop_connections (partner_id, platform, shop_url, credentials, settings, active) VALUES (?, ?, ?, ?, ?, ?)',
      p.id, def.code, shop.url, await encryptJson(ctx.env, creds.credentials), JSON.stringify(sets.settings), active);
    const id = res.meta.last_row_id;
    await audit(ctx, { module: M, action: 'approve', entity: 'webshop_connection', entityId: id, summary: `Webshop kapcsolat felvéve: ${def.name || def.code} ${shop.url} (${p.name})` });
    return connectionOut(ctx.env, await first(db, 'SELECT * FROM webshop_connections WHERE id = ?', id), defs);
  }, { perm: [M, 'approve'] });

  r.patch('/api/partners/:id/webshops/:wid', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    requireClient(p);
    const cur = await connectionOf(db, p.id, ctx.params.wid);
    const body = await ctx.body();
    if (body.platform !== undefined && body.platform !== cur.platform) throw fieldError('platform', 'A platform nem módosítható. Vegyél fel új kapcsolatot.');
    const defs = platforms();
    const def = defs.find((d) => d.code === cur.platform);
    const changes = {};
    const errors = {};
    if (body.shop_url !== undefined) {
      const shop = normalizeShopUrl(body.shop_url);
      if (shop.error) errors.shop_url = shop.error;
      else changes.shop_url = shop.url;
    }
    if (body.active !== undefined) changes.active = body.active ? 1 : 0;
    if (body.credentials !== undefined || body.settings !== undefined) {
      if (!def) throw conflict('Ehhez a platformhoz most nincs elérhető integráció, ezért a hozzáférési adatai nem módosíthatók.');
      if (body.credentials !== undefined) {
        let stored = {};
        try { stored = await decryptJson(ctx.env, cur.credentials); } catch { stored = {}; }
        const creds = mergeCredentials(def.credentialFields, body.credentials, stored);
        Object.assign(errors, creds.errors);
        changes.credentials = await encryptJson(ctx.env, creds.credentials);
      }
      if (body.settings !== undefined) {
        const sets = readSettings(def.settingFields, body.settings, parseJson(cur.settings, {}));
        Object.assign(errors, sets.errors);
        changes.settings = JSON.stringify(sets.settings);
      }
    }
    if (Object.keys(errors).length) throw badRequest('Ellenőrizd a megjelölt mezőket.', errors);
    const keys = Object.keys(changes);
    if (keys.length) await run(db, `UPDATE webshop_connections SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => changes[k]), cur.id);
    await audit(ctx, {
      module: M, action: 'approve', entity: 'webshop_connection', entityId: cur.id,
      summary: `Webshop kapcsolat módosítva: ${changes.shop_url || cur.shop_url} (${p.name})`,
      details: { fields: keys.map((k) => (k === 'credentials' ? 'credentials (titkosítva)' : k)) },
    });
    return connectionOut(ctx.env, await first(db, 'SELECT * FROM webshop_connections WHERE id = ?', cur.id), defs);
  }, { perm: [M, 'approve'] });

  r.delete('/api/partners/:id/webshops/:wid', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    requireClient(p);
    const cur = await connectionOf(db, p.id, ctx.params.wid);
    await run(db, 'DELETE FROM webshop_connections WHERE id = ?', cur.id);
    await audit(ctx, { module: M, action: 'approve', entity: 'webshop_connection', entityId: cur.id, summary: `Webshop kapcsolat törölve: ${cur.shop_url} (${p.name})` });
    return { ok: true };
  }, { perm: [M, 'approve'] });

  r.post('/api/partners/:id/webshops/:wid/test', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    requireClient(p);
    const cur = await connectionOf(db, p.id, ctx.params.wid);
    let result;
    try {
      result = await testConnection(ctx.env, cur.id);
    } catch (err) {
      result = { ok: false, message: (err && err.message) || 'A kapcsolat tesztelése nem sikerült.' };
    }
    const out = { ok: !!(result && result.ok), message: String((result && result.message) || (result && result.ok ? 'A kapcsolat működik.' : 'A kapcsolat nem működik.')) };
    await audit(ctx, { module: M, action: 'test', entity: 'webshop_connection', entityId: cur.id, summary: `Webshop kapcsolat tesztelve: ${cur.shop_url}, ${out.ok ? 'sikeres' : 'sikertelen'}` });
    return { result: out, connection: await connectionOut(ctx.env, await first(db, 'SELECT * FROM webshop_connections WHERE id = ?', cur.id), platforms()) };
  }, { perm: [M, 'approve'] });

  r.post('/api/partners/:id/webshops/:wid/sync', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    requireClient(p);
    const cur = await connectionOf(db, p.id, ctx.params.wid);
    if (!cur.active) throw conflict('Inaktív kapcsolat nem szinkronizálható. Előbb kapcsold be.');
    if (p.status !== 'active') throw conflict('Inaktív ügyfél rendelései nem importálhatók.');
    let result;
    try {
      const r0 = await syncConnection(ctx.env, cur.id);
      result = {
        ok: true,
        imported: num(r0 && r0.imported),
        skipped: num(r0 && r0.skipped),
        errors: Array.isArray(r0 && r0.errors) ? r0.errors.slice(0, 50).map((e) => (typeof e === 'string' ? e : (e && e.message) || JSON.stringify(e))) : [],
      };
    } catch (err) {
      result = { ok: false, imported: 0, skipped: 0, errors: [(err && err.message) || 'A szinkronizálás nem sikerült.'] };
    }
    await audit(ctx, {
      module: M, action: 'sync', entity: 'webshop_connection', entityId: cur.id,
      summary: `Webshop szinkronizálás: ${cur.shop_url}, ${result.imported} importálva, ${result.errors.length} hiba`,
    });
    return { result, connection: await connectionOut(ctx.env, await first(db, 'SELECT * FROM webshop_connections WHERE id = ?', cur.id), platforms()) };
  }, { perm: [M, 'approve'] });

  // ------------------------------------------------------------ partner API keys (clients)
  r.post('/api/partners/:id/api-keys', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    requireClient(p);
    if (p.status !== 'active') throw conflict('Inaktív ügyfélnek nem adható API kulcs.');
    const { name } = validate(await ctx.body(), { name: { type: 'str', required: true, max: 100 } });
    const key = await createApiKey(ctx, p.id, name);
    await audit(ctx, { module: M, action: 'approve', entity: 'api_key', entityId: key.id, summary: `API kulcs létrehozva: ${name} (${key.prefix}..., ${p.name})` });
    return { id: key.id, key: key.key, prefix: key.prefix, name };
  }, { perm: [M, 'approve'] });

  r.post('/api/partners/:id/api-keys/:kid/revoke', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    const key = await first(db, 'SELECT * FROM api_keys WHERE id = ? AND partner_id = ?', idOf(ctx.params.kid, 'Az API kulcs'), p.id);
    if (!key) throw notFound('Az API kulcs nem található.');
    if (key.revoked_at) throw conflict('Ez a kulcs már vissza van vonva.');
    await run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', nowIso(), key.id);
    await audit(ctx, { module: M, action: 'approve', entity: 'api_key', entityId: key.id, summary: `API kulcs visszavonva: ${key.name} (${key.prefix}..., ${p.name})` });
    return { ok: true };
  }, { perm: [M, 'approve'] });

  // ------------------------------------------------------------ summary
  r.get('/api/partners/:id/summary', async (ctx) => {
    const db = ctx.env.DB;
    const p = await getPartner(db, ctx.params.id);
    if (p.type === 'client') return clientSummary(db, p);
    if (p.type === 'carrier') return carrierSummary(db, p);
    return supplierSummary(db, p);
  }, { perm: [M, 'view'] });
}

// For the quote calculator: the client's contact data in one object.
export async function partnerContact(db, p) {
  const c = await first(db, 'SELECT name, position, email, phone FROM partner_contacts WHERE partner_id = ? ORDER BY is_primary DESC, id LIMIT 1', p.id);
  return {
    name: p.name,
    code: p.code,
    tax_number: p.tax_number,
    address: [[p.zip, p.city].filter(Boolean).join(' '), p.address].filter(Boolean).join(', '),
    website: p.website,
    billing_email: p.billing_email,
    contact_name: c ? c.name : '',
    contact_position: c ? c.position : '',
    contact_email: c ? c.email : '',
    contact_phone: c ? c.phone : '',
  };
}
