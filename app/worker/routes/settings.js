// Beállítások: company, warehouse, location sizes and locations, default tariffs, courier and
// invoicing accounts, activity and integration log. Prefix /api/settings
//
//   GET  PUT    /api/settings/company                  settings "company"
//   GET  PUT    /api/settings/warehouse                settings "warehouse" (cut-off, opening hours, workdays)
//   GET  PUT    /api/settings/tariffs                  settings "default_tariffs" and "quote_terms"
//   GET  POST   /api/settings/sizes                    location sizes; PATCH, DELETE /api/settings/sizes/:id
//   GET  POST   /api/settings/locations                list with filters (?ids_only=1 for "select all"), create one
//   POST        /api/settings/locations/bulk           create from a pattern (preview: true answers the codes)
//   POST        /api/settings/locations/bulk-update    change size, kind, fixed partner, zone or active of many
//   POST        /api/settings/locations/bulk-delete    delete many (only empty ones without history)
//   GET         /api/settings/locations/export         CSV, same filters as the list
//   POST        /api/settings/locations/import         CSV (multipart file, preview=1|0)
//   GET  PATCH  DELETE /api/settings/locations/:id
//   GET         /api/settings/couriers                 PUT /:code, POST /:code/test
//   GET  PUT    /api/settings/invoicing                POST /api/settings/invoicing/test
//   DELETE /api/settings/couriers/:code/credentials, /api/settings/invoicing/credentials (undecryptable secrets)
//   GET         /api/settings/audit                    activity log; /audit/filters, /audit/export
//   GET         /api/settings/integration-log          calls to and from outside systems
//
// Credentials of couriers and invoicing providers are only ever returned masked.

import { all, batch, first, getSetting, parseJson, run, setClause, setSetting, stmt } from '../lib/db.js';
import { badRequest, conflict, download, notFound, page } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { can, need, MODULES } from '../lib/perm.js';
import { CARRIERS, LOCATION_KINDS, TARIFFS } from '../lib/constants.js';
import { occupant } from '../lib/stock.js';
import { normalizeHeader, parseCsv, toCsv } from '../lib/csv.js';
import { readUpload } from '../lib/files.js';
import { maskCredentials } from '../lib/crypto.js';
import {
  clearCourierCredentials, clearInvoicingCredentials, getCourierAccount, getInvoicingConfig, saveCourierAccount, saveInvoicingConfig, setCourierError,
} from '../lib/accounts.js';
import { addDays, budapestDate, isDate, TZ } from '../lib/time.js';
import * as couriers from '../integrations/couriers/index.js';
import * as invoicing from '../integrations/invoicing/index.js';

const fieldError = (field, message) => badRequest(message, { [field]: message });
const intParam = (v) => {
  const n = Number(v);
  return v != null && v !== '' && Number.isInteger(n) && n > 0 ? n : null;
};
const strParam = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

// Old and new values of the keys that changed, for the audit details.
export function diff(before, after, keys = Object.keys(after)) {
  const out = {};
  for (const k of keys) {
    const a = before ? before[k] : undefined;
    const b = after[k];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out[k] = [a ?? null, b ?? null];
  }
  return out;
}

// ------------------------------------------------------------------ dates for log filters

const wallFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const stampFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

// The UTC instant (ISO) when the Budapest calendar day "YYYY-MM-DD" starts.
export function budapestDayStartIso(date) {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const p = Object.fromEntries(wallFmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return new Date(guess - (wall - guess)).toISOString();
}
const stamp = (iso) => (iso ? stampFmt.format(new Date(iso)) : '');

function dateRange(query, column, where, args) {
  const from = strParam(query.get('from'));
  const to = strParam(query.get('to'));
  if (from && !isDate(from)) throw fieldError('from', 'Dátumot várunk (ÉÉÉÉ-HH-NN).');
  if (to && !isDate(to)) throw fieldError('to', 'Dátumot várunk (ÉÉÉÉ-HH-NN).');
  if (from) { where.push(`${column} >= ?`); args.push(budapestDayStartIso(from)); }
  if (to) { where.push(`${column} < ?`); args.push(budapestDayStartIso(addDays(to, 1))); }
}

// ------------------------------------------------------------------ company and warehouse

const COMPANY_FIELDS = {
  name: { type: 'str', required: true, max: 200 },
  tax_number: { type: 'str', max: 20, default: '' },
  eu_vat_number: { type: 'str', max: 20, default: '' },
  company_reg_number: { type: 'str', max: 30, default: '' },
  country: { type: 'str', max: 2, default: 'HU' },
  zip: { type: 'str', max: 20, default: '' },
  city: { type: 'str', max: 120, default: '' },
  address: { type: 'str', max: 300, default: '' },
  email: { type: 'email', default: '' },
  phone: { type: 'str', max: 40, default: '' },
  bank_name: { type: 'str', max: 120, default: '' },
  bank_account: { type: 'str', max: 60, default: '' },
  website: { type: 'str', max: 200, default: '' },
};

// Normalises the formats printed on quotes and invoices; returns field errors.
export function normalizeCompany(c) {
  const errors = {};
  if (c.tax_number) {
    const d = c.tax_number.replace(/[\s-]/g, '');
    if (/^\d{11}$/.test(d)) c.tax_number = `${d.slice(0, 8)}-${d.slice(8, 9)}-${d.slice(9)}`;
    else errors.tax_number = 'Az adószám formátuma: 12345678-1-12.';
  }
  if (c.eu_vat_number) {
    const v = c.eu_vat_number.replace(/\s/g, '').toUpperCase();
    if (/^[A-Z]{2}[0-9A-Z]{2,13}$/.test(v)) c.eu_vat_number = v;
    else errors.eu_vat_number = 'A közösségi adószám formátuma: HU12345678.';
  }
  if (c.company_reg_number && !/^[0-9][0-9 -]{4,28}[0-9]$/.test(c.company_reg_number)) {
    errors.company_reg_number = 'A cégjegyzékszám formátuma: 13-09-123456.';
  }
  c.country = (c.country || 'HU').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c.country)) errors.country = 'Kétbetűs országkódot adj meg (pl. HU).';
  if (c.bank_account) {
    const raw = c.bank_account.replace(/[\s-]/g, '').toUpperCase();
    if (/^\d{16}$|^\d{24}$/.test(raw)) c.bank_account = raw.match(/\d{8}/g).join('-');
    else if (/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(raw)) c.bank_account = raw.match(/.{1,4}/g).join(' ');
    else errors.bank_account = 'Adj meg 16 vagy 24 jegyű bankszámlaszámot vagy IBAN-t.';
  }
  if (c.website) {
    const w = /^https?:\/\//i.test(c.website) ? c.website : `https://${c.website}`;
    try {
      const u = new URL(w);
      if (!u.hostname.includes('.')) throw new Error('host');
      c.website = w;
    } catch {
      errors.website = 'Érvényes webcímet adj meg (pl. https://fully.hu).';
    }
  }
  return errors;
}

const WAREHOUSE_FIELDS = {
  cutoff: { type: 'time', required: true },
  open: { type: 'time', default: '' },
  close: { type: 'time', default: '' },
  default_carrier_code: { type: 'enum', values: ['', ...Object.keys(CARRIERS)], default: '' },
};

const WAREHOUSE_DEFAULTS = { cutoff: '14:00', open: '', close: '', workdays: [1, 2, 3, 4, 5], default_carrier_code: '' };

// ------------------------------------------------------------------ default tariffs

const PCT_MAX = 100;
const MONEY_MAX = 100000000;

async function tariffState(db) {
  const stored = await getSetting(db, 'default_tariffs', {});
  const { storage = {}, ...values } = stored || {};
  return { values, storage, terms: await getSetting(db, 'quote_terms', []) };
}

// ------------------------------------------------------------------ location sizes

const SIZE_FIELDS = {
  code: { type: 'str', required: true, max: 20 },
  name: { type: 'str', required: true, max: 80 },
  width_cm: { type: 'num', min: 0, max: 100000, nullable: true },
  depth_cm: { type: 'num', min: 0, max: 100000, nullable: true },
  height_cm: { type: 'num', min: 0, max: 100000, nullable: true },
  max_kg: { type: 'num', min: 0, max: 1000000, nullable: true },
  sort: { type: 'int', min: 0, max: 1000000 },
  active: { type: 'bool' },
};
const SIZE_CODE = /^[A-Z0-9][A-Z0-9_-]*$/;

const SIZE_LIST_SQL = `
  SELECT z.*, COALESCE(c.total, 0) AS location_count, COALESCE(c.active, 0) AS active_location_count, COALESCE(o.n, 0) AS occupied_count
  FROM location_sizes z
  LEFT JOIN (SELECT size_id, COUNT(*) AS total, SUM(active) AS active FROM locations GROUP BY size_id) c ON c.size_id = z.id
  LEFT JOIN (SELECT l.size_id, COUNT(DISTINCT s.location_id) AS n FROM stock s JOIN locations l ON l.id = s.location_id
             WHERE s.qty > 0 GROUP BY l.size_id) o ON o.size_id = z.id`;

const sizeRow = (db, id) => first(db, `${SIZE_LIST_SQL} WHERE z.id = ?`, id);

// ------------------------------------------------------------------ locations

const LOCATION_FIELDS = {
  code: { type: 'str', required: true, max: 40 },
  zone: { type: 'str', max: 20, default: '' },
  size_id: { type: 'id', required: true },
  kind: { type: 'enum', values: Object.keys(LOCATION_KINDS), default: 'storage' },
  partner_id: { type: 'id', nullable: true },
  pick_sequence: { type: 'int', min: 0, max: 999999, default: 0 },
  active: { type: 'bool', default: true },
  note: { type: 'str', max: 300, default: '' },
};
const LOCATION_CODE = /^[A-Z0-9][A-Z0-9._/-]*$/;
const CODE_RULE = 'Csak ékezet nélküli betű, szám, kötőjel, pont, perjel és aláhúzás lehet, szóköz nélkül.';
const MAX_BULK = 2000;
const MAX_IMPORT = 5000;

export const normCode = (s) => String(s ?? '').trim().toUpperCase();

// "A-01-03" -> "A", "RAMPA-BE" -> "RAMPA", "12.04" -> "12"
export function deriveZone(code) {
  const m = code.match(/^[A-Z]+/) || code.match(/^[^-._/]+/);
  return m ? m[0].slice(0, 20) : '';
}

// Stock on hand per location: who occupies it, how many pieces, how many products.
const OCC_CTE = `occ AS (
  SELECT s.location_id, MIN(p.partner_id) AS partner_id, SUM(s.qty) AS qty, COUNT(DISTINCT s.product_id) AS products
  FROM stock s JOIN products p ON p.id = s.product_id WHERE s.qty > 0 GROUP BY s.location_id)`;

const LOCATION_SELECT = `
  SELECT l.id, l.code, l.zone, l.size_id, z.code AS size_code, z.name AS size_name, z.active AS size_active, l.kind,
         l.partner_id, fp.code AS partner_code, fp.name AS partner_name, l.pick_sequence, l.active, l.note,
         occ.partner_id AS occupant_id, op.code AS occupant_code, op.name AS occupant_name,
         COALESCE(occ.qty, 0) AS qty, COALESCE(occ.products, 0) AS products
  FROM locations l JOIN location_sizes z ON z.id = l.size_id
  LEFT JOIN occ ON occ.location_id = l.id
  LEFT JOIN partners fp ON fp.id = l.partner_id
  LEFT JOIN partners op ON op.id = occ.partner_id`;

function locationFilters(query) {
  const where = [];
  const args = [];
  const q = strParam(query.get('q'));
  if (q) { where.push('(l.code LIKE ? OR l.note LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  const zone = query.get('zone');
  if (zone != null && zone !== '') { where.push('l.zone = ?'); args.push(zone === '-' ? '' : zone); }
  const size = intParam(query.get('size_id'));
  if (size) { where.push('l.size_id = ?'); args.push(size); }
  const kind = strParam(query.get('kind'));
  if (kind) { where.push('l.kind = ?'); args.push(kind); }
  const occupied = query.get('occupied');
  if (occupied === '1') where.push('occ.location_id IS NOT NULL');
  if (occupied === '0') where.push('occ.location_id IS NULL');
  const partner = intParam(query.get('partner_id'));
  if (partner) { where.push('(l.partner_id = ? OR occ.partner_id = ?)'); args.push(partner, partner); }
  const active = query.get('active');
  if (active === '1' || active === '0') { where.push('l.active = ?'); args.push(Number(active)); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

async function locationById(db, id) {
  return first(db, `WITH ${OCC_CTE} ${LOCATION_SELECT} WHERE l.id = ?`, id);
}

async function clientPartner(db, id, field = 'partner_id') {
  const p = await first(db, 'SELECT id, type, code, name FROM partners WHERE id = ?', id);
  if (!p || p.type !== 'client') throw fieldError(field, 'Ügyfél partnert válassz.');
  return p;
}

async function sizeFor(db, id, { allowInactive = null } = {}) {
  const s = await first(db, 'SELECT id, code, name, active FROM location_sizes WHERE id = ?', id);
  if (!s) throw fieldError('size_id', 'Ismeretlen méret.');
  if (!s.active && s.id !== allowInactive) throw fieldError('size_id', `A(z) ${s.code} méret inaktív.`);
  return s;
}

// Which of the given locations are referenced anywhere (stock, ledger, picks, counts, inbound and
// return lines, storage snapshots). Those cannot be deleted, only deactivated.
async function referencedLocations(db, ids) {
  const used = new Set();
  const list = JSON.stringify(ids);
  const tables = ['stock', 'movements', 'picks', 'count_lines', 'inbound_lines', 'return_lines', 'storage_snapshots'];
  for (const t of tables) {
    const rows = await all(db, `SELECT DISTINCT location_id AS id FROM ${t} WHERE location_id IN (SELECT value FROM json_each(?))`, list);
    for (const r of rows) used.add(r.id);
  }
  return used;
}

// Codes from a pattern: prefixes x racks x levels (x positions).
export function patternCodes(p) {
  const pad = (n) => String(n).padStart(p.pad, '0');
  let prefixes = [];
  const raw = String(p.prefixes || '').toUpperCase().replace(/\s/g, '');
  const range = raw.match(/^([A-Z])-([A-Z])$/);
  if (range) {
    const [a, b] = [range[1].charCodeAt(0), range[2].charCodeAt(0)];
    for (let c = Math.min(a, b); c <= Math.max(a, b); c++) prefixes.push(String.fromCharCode(c));
  } else {
    prefixes = raw.split(',').filter(Boolean);
  }
  const out = [];
  const span = (from, to) => {
    const list = [];
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) list.push(i);
    return list;
  };
  const racks = span(p.rack_from, p.rack_to);
  const levels = span(p.level_from, p.level_to);
  const positions = p.pos_from != null && p.pos_to != null ? span(p.pos_from, p.pos_to) : [null];
  const total = prefixes.length * racks.length * levels.length * positions.length;
  if (total > MAX_BULK) return { prefixes, codes: [], total };
  for (const prefix of prefixes) {
    for (const r of racks) {
      for (const l of levels) {
        for (const pos of positions) {
          const parts = [prefix, pad(r), pad(l)];
          if (pos != null) parts.push(pad(pos));
          out.push({ code: parts.join(p.separator), zone: prefix });
        }
      }
    }
  }
  return { prefixes, codes: out, total };
}

const SEPARATORS = ['-', '.', '/', '_', ''];
const BULK_FIELDS = {
  prefixes: { type: 'str', required: true, max: 200 },
  separator: { type: 'str', max: 1, default: '-' },
  pad: { type: 'int', min: 1, max: 4, default: 2 },
  rack_from: { type: 'int', required: true, min: 0, max: 9999 },
  rack_to: { type: 'int', required: true, min: 0, max: 9999 },
  level_from: { type: 'int', required: true, min: 0, max: 9999 },
  level_to: { type: 'int', required: true, min: 0, max: 9999 },
  pos_from: { type: 'int', min: 0, max: 9999, nullable: true },
  pos_to: { type: 'int', min: 0, max: 9999, nullable: true },
  size_id: { type: 'id', required: true },
  kind: { type: 'enum', values: Object.keys(LOCATION_KINDS), default: 'storage' },
  partner_id: { type: 'id', nullable: true },
  zone: { type: 'str', max: 20, default: '' },
  pick_start: { type: 'int', min: 0, max: 999999, nullable: true },
  note: { type: 'str', max: 300, default: '' },
  preview: { type: 'bool', default: false },
};

// Inserts many locations in one statement (rows as JSON), skipping codes that exist meanwhile.
function insertLocationsStmt(db, rows) {
  return stmt(db, `INSERT INTO locations (code, zone, size_id, kind, partner_id, pick_sequence, active, note)
    SELECT json_extract(value, '$.code'), json_extract(value, '$.zone'), json_extract(value, '$.size_id'), json_extract(value, '$.kind'),
           json_extract(value, '$.partner_id'), json_extract(value, '$.pick_sequence'), json_extract(value, '$.active'), json_extract(value, '$.note')
    FROM json_each(?) WHERE 1 ON CONFLICT (code) DO NOTHING`, JSON.stringify(rows));
}

const KIND_BY_TEXT = Object.fromEntries(Object.entries(LOCATION_KINDS).flatMap(([k, label]) => [[normalizeHeader(k), k], [normalizeHeader(label), k]]));
const YES = new Set(['igen', 'i', 'yes', 'y', '1', 'true', 'aktiv', 'x']);
const NO = new Set(['nem', 'n', 'no', '0', 'false', 'inaktiv']);

// CSV columns (normalised header -> field). The export writes the first spelling of each.
const CSV_COLUMNS = [
  { key: 'code', label: 'Kód', aliases: ['kod', 'code', 'raktarhely', 'hely'] },
  { key: 'zone', label: 'Zóna', aliases: ['zona', 'zone'] },
  { key: 'size', label: 'Méret', aliases: ['meret', 'size', 'meret_kod'] },
  { key: 'kind', label: 'Típus', aliases: ['tipus', 'kind', 'fajta'] },
  { key: 'partner', label: 'Fix partner', aliases: ['fix_partner', 'partner', 'partner_kod', 'fix_partner_kod'] },
  { key: 'pick_sequence', label: 'Komissiós sorrend', aliases: ['komissios_sorrend', 'sorrend', 'pick_sequence'] },
  { key: 'active', label: 'Aktív', aliases: ['aktiv', 'active'] },
  { key: 'note', label: 'Megjegyzés', aliases: ['megjegyzes', 'note'] },
];
const COLUMN_BY_HEADER = Object.fromEntries(CSV_COLUMNS.flatMap((c) => c.aliases.map((a) => [a, c.key])));

// ------------------------------------------------------------------ integration field definitions

const optionValues = (options) => (options || []).map((o) => (Array.isArray(o) ? o[0] : o && typeof o === 'object' ? o.value : o));

// Settings that only tests and developers use (api_base_url points an adapter at a fake carrier
// server). They are never sent to the browser and never accepted from it; a stored value stays.
const HIDDEN_KEYS = new Set(['api_base_url']);
export const visibleFields = (defs) => (Array.isArray(defs) ? defs.filter((f) => f && f.key && !HIDDEN_KEYS.has(f.key)) : []);

// Only the values of the fields the screen shows.
function pick(values, defs) {
  const out = {};
  for (const f of defs) if (values && Object.prototype.hasOwnProperty.call(values, f.key)) out[f.key] = values[f.key];
  return out;
}

// Defaults of the adapter (field.default) for settings that are neither stored nor sent.
export function withDefaults(defs, stored, incoming) {
  const out = { ...incoming };
  for (const f of defs) {
    if (f.default === undefined || f.key in out || (stored && f.key in stored)) continue;
    out[f.key] = f.default;
  }
  return out;
}

// Cleans the values sent for a courier or invoicing form against the adapter's field definitions
// ({ key, label, type: text|password|select|number|checkbox, required, options }). Unknown keys
// are dropped. For credentials an empty or missing value keeps the stored one and null clears it.
// Field errors go into errors under "<kind>.<key>".
export function cleanFields(defs, values, kind, errors = {}) {
  const out = {};
  if (values == null) return out;
  if (typeof values !== 'object' || Array.isArray(values)) {
    errors[kind] = 'Objektumot várunk.';
    return out;
  }
  for (const f of defs || []) {
    if (!Object.prototype.hasOwnProperty.call(values, f.key)) continue;
    let v = values[f.key];
    const name = `${kind}.${f.key}`;
    if (kind === 'credentials') {
      if (v === undefined || v === '') continue;
      if (v === null) { out[f.key] = null; continue; }
    }
    switch (f.type) {
      case 'checkbox':
        if (v === true || v === 1 || v === '1' || v === 'true') v = true;
        else if (v === false || v === 0 || v === '0' || v === 'false' || v === null || v === '') v = false;
        else { errors[name] = 'Igen/nem értéket várunk.'; continue; }
        break;
      case 'number': {
        if (v === null || v === '') { v = null; break; }
        const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
        if (typeof n !== 'number' || !Number.isFinite(n)) { errors[name] = 'Számot várunk.'; continue; }
        v = n;
        break;
      }
      case 'select': {
        if (v === null || v === '') { v = ''; break; }
        const allowed = optionValues(f.options);
        const hit = allowed.find((a) => String(a) === String(v));
        if (hit === undefined) { errors[name] = 'Érvénytelen érték.'; continue; }
        v = hit;
        break;
      }
      default: {
        if (v === null) { v = ''; break; }
        if (typeof v !== 'string' && typeof v !== 'number') { errors[name] = 'Szöveget várunk.'; continue; }
        v = f.type === 'password' ? String(v) : String(v).trim();
        if (v.length > 4000) { errors[name] = 'Legfeljebb 4000 karakter lehet.'; continue; }
      }
    }
    out[f.key] = v;
  }
  return out;
}

const isBlank = (v) => v === undefined || v === null || v === '';

// Required fields that would stay empty after merging the new values into the stored ones.
export function missingRequired(defs, stored, incoming, kind, errors = {}) {
  for (const f of defs || []) {
    if (!f.required || f.type === 'checkbox') continue;
    const next = Object.prototype.hasOwnProperty.call(incoming || {}, f.key) ? incoming[f.key] : (stored || {})[f.key];
    if (isBlank(next)) errors[`${kind}.${f.key}`] = 'Kötelező mező.';
  }
  return errors;
}

const DECRYPT_FAILED = 'A tárolt hozzáférési adatok nem fejthetők vissza. Ellenőrizd az ENCRYPTION_KEY titkot a Worker beállításaiban.';

function cryptoProblem(err) {
  if (err && /ENCRYPTION_KEY/.test(err.message || '')) return conflict(err.message);
  return conflict(DECRYPT_FAILED);
}

function courierDefs() {
  try {
    const list = couriers.listCouriers();
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.error('listCouriers failed', e);
    return [];
  }
}

function providerDefs() {
  try {
    const list = invoicing.listProviders();
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.error('listProviders failed', e);
    return [];
  }
}

const PROVIDER_NAMES = { szamlazz: 'Számlázz.hu', billingo: 'Billingo' };

function courierView(def, account, error = '') {
  const credentialFields = visibleFields(def.credentialFields);
  const settingFields = visibleFields(def.settingFields);
  return {
    code: def.code,
    name: def.name || CARRIERS[def.code] || def.code,
    credentialFields,
    settingFields,
    features: def.features && typeof def.features === 'object' ? def.features : {},
    configured: !!account,
    active: !!(account && account.active),
    carrier_id: account ? account.carrier_id : null,
    settings: account ? pick(account.settings, settingFields) : {},
    credentials: account ? maskCredentials(pick(account.credentials, credentialFields)) : {},
    last_error: account ? account.last_error || '' : '',
    updated_at: account ? account.updated_at : null,
    error,
  };
}

async function readCourier(env, def) {
  try {
    return courierView(def, await getCourierAccount(env, def.code));
  } catch (e) {
    return courierView(def, null, cryptoProblem(e).message);
  }
}

async function readInvoicing(env) {
  const defs = providerDefs();
  let conf = { provider: '', settings: {}, credentials: {} };
  let error = '';
  try {
    conf = await getInvoicingConfig(env);
  } catch (e) {
    error = cryptoProblem(e).message;
    const plain = await getSetting(env.DB, 'invoicing', { provider: '' });
    conf.provider = (plain && plain.provider) || '';
  }
  const choices = [{ value: '', label: 'Nincs, kézi számlázás' }];
  const seen = new Set(['']);
  for (const d of defs) { choices.push({ value: d.code, label: d.name || PROVIDER_NAMES[d.code] || d.code }); seen.add(d.code); }
  for (const [code, label] of Object.entries(PROVIDER_NAMES)) if (!seen.has(code)) choices.push({ value: code, label });
  return {
    provider: conf.provider || '',
    choices,
    error,
    providers: defs.map((d) => {
      const credentialFields = visibleFields(d.credentialFields);
      const settingFields = visibleFields(d.settingFields);
      return {
        code: d.code,
        name: d.name || PROVIDER_NAMES[d.code] || d.code,
        credentialFields,
        settingFields,
        settings: pick((conf.settings || {})[d.code], settingFields),
        credentials: maskCredentials(pick((conf.credentials || {})[d.code], credentialFields)),
      };
    }),
  };
}

async function runTest(fn) {
  try {
    const r = await fn();
    return { ok: !!(r && r.ok), message: (r && r.message) || (r && r.ok ? 'A kapcsolat rendben.' : 'A kapcsolat nem sikerült.') };
  } catch (e) {
    return { ok: false, message: (e && e.message) || 'A kapcsolat nem sikerült.' };
  }
}

// ------------------------------------------------------------------ log filters

function auditFilters(query) {
  const where = [];
  const args = [];
  const mod = strParam(query.get('module'));
  if (mod) { where.push('a.module = ?'); args.push(mod); }
  const action = strParam(query.get('action'));
  if (action) { where.push('a.action = ?'); args.push(action); }
  const user = intParam(query.get('user_id'));
  if (user) { where.push('a.user_id = ?'); args.push(user); }
  const entity = strParam(query.get('entity'));
  if (entity) { where.push('a.entity = ?'); args.push(entity); }
  const entityId = strParam(query.get('entity_id'));
  if (entityId) { where.push('a.entity_id = ?'); args.push(entityId); }
  const q = strParam(query.get('q'));
  if (q) { where.push('(a.summary LIKE ? OR a.actor LIKE ? OR a.entity_id = ?)'); args.push(`%${q}%`, `%${q}%`, q); }
  dateRange(query, 'a.at', where, args);
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

function integrationFilters(query) {
  const where = [];
  const args = [];
  const system = strParam(query.get('system'));
  if (system) { where.push('i.system = ?'); args.push(system); }
  const ok = query.get('ok');
  if (ok === '1' || ok === '0') { where.push('i.ok = ?'); args.push(Number(ok)); }
  const dir = query.get('direction');
  if (dir === 'in' || dir === 'out') { where.push('i.direction = ?'); args.push(dir); }
  const partner = intParam(query.get('partner_id'));
  if (partner) { where.push('i.partner_id = ?'); args.push(partner); }
  const q = strParam(query.get('q'));
  if (q) { where.push('(i.message LIKE ? OR i.action LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  dateRange(query, 'i.at', where, args);
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

const MODULE_NAMES = Object.fromEntries(MODULES.map((m) => [m.key, m.name]));

// ================================================================== routes

export function register(r) {
  // ---------------------------------------------------------------- company
  r.get('/api/settings/company', async (ctx) => ({ ...(await getSetting(ctx.env.DB, 'company', {})) }), { perm: ['settings', 'view'] });

  r.put('/api/settings/company', async (ctx) => {
    const db = ctx.env.DB;
    const data = validate(await ctx.body(), COMPANY_FIELDS);
    const errors = normalizeCompany(data);
    if (Object.keys(errors).length) throw badRequest('Ellenőrizd a megjelölt mezőket.', errors);
    const current = await getSetting(db, 'company', {});
    const next = { ...current, ...data };
    const changes = diff(current, next, Object.keys(COMPANY_FIELDS));
    await setSetting(db, 'company', next);
    if (Object.keys(changes).length) {
      await audit(ctx, { module: 'settings', action: 'edit', entity: 'settings', entityId: 'company', summary: 'Cégadatok módosítva', details: { changes } });
    }
    return next;
  }, { perm: ['settings', 'edit'] });

  // ---------------------------------------------------------------- warehouse
  r.get('/api/settings/warehouse', async (ctx) => ({ ...WAREHOUSE_DEFAULTS, ...(await getSetting(ctx.env.DB, 'warehouse', {})) }), { perm: ['settings', 'view'] });

  r.put('/api/settings/warehouse', async (ctx) => {
    const db = ctx.env.DB;
    const body = await ctx.body();
    const errors = {};
    let data = {};
    try {
      data = validate(body, WAREHOUSE_FIELDS);
    } catch (e) {
      Object.assign(errors, e.fields || {});
    }
    const days = body.workdays;
    let workdays = [];
    if (!Array.isArray(days) || days.some((d) => !Number.isInteger(Number(d)) || Number(d) < 1 || Number(d) > 7)) {
      errors.workdays = 'A munkanapok 1 (hétfő) és 7 (vasárnap) közötti számok listája.';
    } else {
      workdays = [...new Set(days.map(Number))].sort((a, b) => a - b);
      if (!workdays.length) errors.workdays = 'Legalább egy munkanapot jelölj be.';
    }
    if (data.open && data.close && data.open >= data.close) errors.close = 'A zárás a nyitás után legyen.';
    if (Object.keys(errors).length) throw badRequest('Ellenőrizd a megjelölt mezőket.', errors);
    const current = await getSetting(db, 'warehouse', {});
    const next = { ...WAREHOUSE_DEFAULTS, ...current, ...data, workdays };
    const changes = diff(current, next, ['cutoff', 'open', 'close', 'workdays', 'default_carrier_code']);
    await setSetting(db, 'warehouse', next);
    if (Object.keys(changes).length) {
      await audit(ctx, { module: 'settings', action: 'edit', entity: 'settings', entityId: 'warehouse', summary: 'Raktár beállítások módosítva', details: { changes } });
    }
    return next;
  }, { perm: ['settings', 'edit'] });

  // ---------------------------------------------------------------- default tariffs, quote terms
  r.get('/api/settings/tariffs', async (ctx) => {
    const db = ctx.env.DB;
    const { values, storage, terms } = await tariffState(db);
    const sizes = await all(db, 'SELECT id, code, name, active FROM location_sizes ORDER BY sort, code');
    return { tariffs: TARIFFS, sizes, values, storage, quote_terms: Array.isArray(terms) ? terms : [] };
  }, { perm: ['settings', 'view'] });

  r.put('/api/settings/tariffs', async (ctx) => {
    const db = ctx.env.DB;
    const body = await ctx.body();
    const errors = {};
    const current = await tariffState(db);
    const values = { ...current.values };
    const inValues = body.values && typeof body.values === 'object' ? body.values : {};
    for (const t of TARIFFS) {
      if (!(t.key in inValues)) continue;
      const v = inValues[t.key];
      const n = v === '' || v === null ? 0 : typeof v === 'string' ? Number(v.replace(',', '.')) : v;
      const max = t.key.endsWith('_pct') ? PCT_MAX : MONEY_MAX;
      if (typeof n !== 'number' || !Number.isFinite(n)) errors[`values.${t.key}`] = 'Számot várunk.';
      else if (n < 0) errors[`values.${t.key}`] = 'Nem lehet negatív.';
      else if (n > max) errors[`values.${t.key}`] = `Legfeljebb ${max} lehet.`;
      else values[t.key] = n;
    }
    const storage = { ...current.storage };
    const codes = new Set((await all(db, 'SELECT code FROM location_sizes')).map((s) => s.code));
    const inStorage = body.storage && typeof body.storage === 'object' ? body.storage : {};
    for (const [code, v] of Object.entries(inStorage)) {
      if (!codes.has(code)) { errors[`storage.${code}`] = 'Ismeretlen méret.'; continue; }
      const n = v === '' || v === null ? 0 : typeof v === 'string' ? Number(v.replace(',', '.')) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) errors[`storage.${code}`] = 'Számot várunk.';
      else if (n < 0) errors[`storage.${code}`] = 'Nem lehet negatív.';
      else if (n > MONEY_MAX) errors[`storage.${code}`] = `Legfeljebb ${MONEY_MAX} lehet.`;
      else storage[code] = n;
    }
    let terms = Array.isArray(current.terms) ? current.terms : [];
    if (body.quote_terms !== undefined) {
      const list = Array.isArray(body.quote_terms) ? body.quote_terms : typeof body.quote_terms === 'string' ? body.quote_terms.split(/\r?\n/) : null;
      if (!list || list.some((t) => typeof t !== 'string')) errors.quote_terms = 'Soronként egy feltételt adj meg.';
      else {
        terms = list.map((t) => t.trim()).filter(Boolean);
        if (terms.length > 50) errors.quote_terms = 'Legfeljebb 50 feltétel lehet.';
        else if (terms.some((t) => t.length > 500)) errors.quote_terms = 'Egy feltétel legfeljebb 500 karakter lehet.';
      }
    }
    if (Object.keys(errors).length) throw badRequest('Ellenőrizd a megjelölt mezőket.', errors);
    const changes = { ...diff(current.values, values, TARIFFS.map((t) => t.key)) };
    const storageChanges = diff(current.storage, storage, Object.keys(storage));
    for (const [k, v] of Object.entries(storageChanges)) changes[`storage.${k}`] = v;
    if (JSON.stringify(terms) !== JSON.stringify(current.terms)) changes.quote_terms = [current.terms.length, terms.length];
    await setSetting(db, 'default_tariffs', { ...values, storage });
    await setSetting(db, 'quote_terms', terms);
    if (Object.keys(changes).length) {
      await audit(ctx, { module: 'settings', action: 'edit', entity: 'settings', entityId: 'default_tariffs', summary: 'Alap tarifák módosítva', details: { changes } });
    }
    return { values, storage, quote_terms: terms };
  }, { perm: ['settings', 'edit'] });

  // ---------------------------------------------------------------- location sizes
  r.get('/api/settings/sizes', async (ctx) => ({
    items: await all(ctx.env.DB, `${SIZE_LIST_SQL} ORDER BY z.sort, z.code`),
  }), { perm: ['settings', 'view'] });

  r.post('/api/settings/sizes', async (ctx) => {
    const db = ctx.env.DB;
    const data = validate(await ctx.body(), SIZE_FIELDS);
    data.code = data.code.toUpperCase();
    if (!SIZE_CODE.test(data.code)) throw fieldError('code', 'Csak ékezet nélküli betű, szám, kötőjel és aláhúzás lehet.');
    if (await first(db, 'SELECT id FROM location_sizes WHERE code = ? COLLATE NOCASE', data.code)) {
      throw conflict('Ilyen kódú méret már van.', { code: 'Ilyen kódú méret már van.' });
    }
    if (data.sort === undefined) data.sort = ((await first(db, 'SELECT COALESCE(MAX(sort), 0) AS m FROM location_sizes')).m) + 10;
    const res = await run(db, `INSERT INTO location_sizes (code, name, width_cm, depth_cm, height_cm, max_kg, sort, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      data.code, data.name, data.width_cm ?? null, data.depth_cm ?? null, data.height_cm ?? null, data.max_kg ?? null, data.sort, data.active ?? true);
    const id = res.meta.last_row_id;
    await audit(ctx, { module: 'settings', action: 'create', entity: 'location_size', entityId: id, summary: `Raktárhely méret létrehozva: ${data.code} (${data.name})` });
    return sizeRow(db, id);
  }, { perm: ['settings', 'create'] });

  r.patch('/api/settings/sizes/:id', async (ctx) => {
    const db = ctx.env.DB;
    const id = Number(ctx.params.id);
    const size = await first(db, 'SELECT * FROM location_sizes WHERE id = ?', id);
    if (!size) throw notFound('A méret nem található.');
    const data = validate(await ctx.body(), SIZE_FIELDS, { partial: true });
    if (data.code !== undefined) {
      data.code = data.code.toUpperCase();
      if (!SIZE_CODE.test(data.code)) throw fieldError('code', 'Csak ékezet nélküli betű, szám, kötőjel és aláhúzás lehet.');
      if (await first(db, 'SELECT id FROM location_sizes WHERE code = ? COLLATE NOCASE AND id <> ?', data.code, id)) {
        throw conflict('Ilyen kódú méret már van.', { code: 'Ilyen kódú méret már van.' });
      }
    }
    if ('active' in data) data.active = data.active ? 1 : 0;
    const changes = diff(size, data);
    if (!Object.keys(changes).length) return { ...(await sizeRow(db, id)), warning: '' };
    const { sql, args } = setClause(Object.fromEntries(Object.keys(changes).map((k) => [k, data[k]])));
    const statements = [stmt(db, `UPDATE location_sizes SET ${sql} WHERE id = ?`, ...args, id)];
    // Default storage prices are keyed by size code: carry the price over to the new code.
    if (data.code && data.code !== size.code) {
      const tariffs = await getSetting(db, 'default_tariffs', {});
      if (tariffs.storage && size.code in tariffs.storage) {
        tariffs.storage[data.code] = tariffs.storage[size.code];
        delete tariffs.storage[size.code];
        statements.push(stmt(db, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', 'default_tariffs', JSON.stringify(tariffs)));
      }
    }
    await batch(db, statements);
    const row = await sizeRow(db, id);
    await audit(ctx, { module: 'settings', action: 'edit', entity: 'location_size', entityId: id, summary: `Raktárhely méret módosítva: ${row.code}`, details: { changes } });
    let warning = '';
    if ('active' in changes && !data.active && row.active_location_count > 0) {
      warning = `${row.active_location_count} aktív raktárhely még ezt a méretet használja. Új raktárhelyhez már nem választható.`;
    }
    return { ...row, warning };
  }, { perm: ['settings', 'edit'] });

  r.delete('/api/settings/sizes/:id', async (ctx) => {
    const db = ctx.env.DB;
    const id = Number(ctx.params.id);
    const size = await first(db, 'SELECT * FROM location_sizes WHERE id = ?', id);
    if (!size) throw notFound('A méret nem található.');
    const used = (await first(db, 'SELECT COUNT(*) AS n FROM locations WHERE size_id = ?', id)).n;
    if (used) throw conflict(`${used} raktárhely ezt a méretet használja, ezért nem törölhető. Inaktiváld helyette, vagy előbb tedd át a raktárhelyeket másik méretre.`);
    if (await first(db, 'SELECT 1 AS x FROM storage_snapshots WHERE size_id = ? LIMIT 1', id)) {
      throw conflict('Ez a méret szerepel a tárolási elszámolás napi adataiban, ezért nem törölhető. Inaktiváld helyette.');
    }
    // Partner prices of the size go with it (the schema cascades too, this does not rely on it).
    const statements = [
      stmt(db, 'DELETE FROM partner_storage_prices WHERE size_id = ?', id),
      stmt(db, 'DELETE FROM location_sizes WHERE id = ?', id),
    ];
    const tariffs = await getSetting(db, 'default_tariffs', {});
    if (tariffs.storage && size.code in tariffs.storage) {
      delete tariffs.storage[size.code];
      statements.push(stmt(db, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', 'default_tariffs', JSON.stringify(tariffs)));
    }
    await batch(db, statements);
    await audit(ctx, { module: 'settings', action: 'delete', entity: 'location_size', entityId: id, summary: `Raktárhely méret törölve: ${size.code} (${size.name})` });
    return { ok: true };
  }, { perm: ['settings', 'delete'] });

  // ---------------------------------------------------------------- locations: list, export
  r.get('/api/settings/locations', async (ctx) => {
    const db = ctx.env.DB;
    const f = locationFilters(ctx.query);
    if (ctx.query.get('ids_only') === '1') {
      const rows = await all(db, `WITH ${OCC_CTE} SELECT l.id FROM locations l LEFT JOIN occ ON occ.location_id = l.id ${f.sql} ORDER BY l.code LIMIT 10000`, ...f.args);
      return { ids: rows.map((x) => x.id), total: rows.length };
    }
    const { limit, offset } = page(ctx.query, 100, 1000);
    const total = (await first(db, `WITH ${OCC_CTE} SELECT COUNT(*) AS n FROM locations l LEFT JOIN occ ON occ.location_id = l.id ${f.sql}`, ...f.args)).n;
    const items = await all(db, `WITH ${OCC_CTE} ${LOCATION_SELECT} ${f.sql} ORDER BY l.code LIMIT ? OFFSET ?`, ...f.args, limit, offset);
    const summary = await first(db, `WITH ${OCC_CTE}
      SELECT COUNT(*) AS total, COALESCE(SUM(l.active), 0) AS active,
             COALESCE(SUM(CASE WHEN occ.location_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS occupied,
             COALESCE(SUM(CASE WHEN occ.location_id IS NULL AND l.active = 1 AND l.kind = 'storage' THEN 1 ELSE 0 END), 0) AS empty_storage
      FROM locations l LEFT JOIN occ ON occ.location_id = l.id`);
    const zones = (await all(db, "SELECT DISTINCT zone FROM locations WHERE zone <> '' ORDER BY zone")).map((z) => z.zone);
    return { items, total, summary, zones };
  }, { perm: ['settings', 'view'] });

  r.get('/api/settings/locations/export', async (ctx) => {
    const db = ctx.env.DB;
    const f = locationFilters(ctx.query);
    const rows = await all(db, `WITH ${OCC_CTE} ${LOCATION_SELECT} ${f.sql} ORDER BY l.code LIMIT 50000`, ...f.args);
    const csv = toCsv([
      ...CSV_COLUMNS.map((c) => ({
        label: c.label,
        value: {
          code: (x) => x.code, zone: (x) => x.zone, size: (x) => x.size_code, kind: (x) => LOCATION_KINDS[x.kind] || x.kind,
          partner: (x) => x.partner_code || '', pick_sequence: (x) => x.pick_sequence, active: (x) => (x.active ? 'igen' : 'nem'), note: (x) => x.note,
        }[c.key],
      })),
      { label: 'Foglalja', value: (x) => x.occupant_code || '' },
      { label: 'Készlet (db)', value: (x) => x.qty },
    ], rows);
    return download(csv, `raktarhelyek-${budapestDate()}.csv`, 'text/csv; charset=utf-8');
  }, { perm: ['settings', 'view'] });

  // ---------------------------------------------------------------- locations: bulk create from pattern
  r.post('/api/settings/locations/bulk', async (ctx) => {
    const db = ctx.env.DB;
    const p = validate(await ctx.body(), BULK_FIELDS);
    if (!SEPARATORS.includes(p.separator)) throw fieldError('separator', 'Elválasztó: kötőjel, pont, perjel, aláhúzás vagy semmi.');
    if ((p.pos_from == null) !== (p.pos_to == null)) {
      throw badRequest('Ellenőrizd a megjelölt mezőket.', { [p.pos_from == null ? 'pos_from' : 'pos_to']: 'A pozíció tartomány mindkét végét add meg, vagy egyiket se.' });
    }
    const { prefixes, codes, total } = patternCodes(p);
    if (!prefixes.length) throw fieldError('prefixes', 'Adj meg legalább egy zóna betűt vagy előtagot.');
    const badPrefix = prefixes.find((x) => !LOCATION_CODE.test(x) || x.length > 20);
    if (badPrefix) throw fieldError('prefixes', `Hibás előtag: ${badPrefix}. ${CODE_RULE}`);
    if (total > MAX_BULK) throw badRequest(`Ez ${total} raktárhely lenne. Egyszerre legfeljebb ${MAX_BULK} hozható létre.`);
    const seen = new Set();
    for (const c of codes) {
      if (c.code.length > 40) throw badRequest(`Túl hosszú kód: ${c.code}. Legfeljebb 40 karakter lehet.`);
      if (seen.has(c.code)) throw badRequest(`A minta ütköző kódokat ad (${c.code}). Használj elválasztót vagy több számjegyet.`, { separator: 'Ütköző kódok.' });
      seen.add(c.code);
    }
    const size = await sizeFor(db, p.size_id);
    let partner = null;
    if (p.partner_id) partner = await clientPartner(db, p.partner_id);
    const zone = p.zone ? p.zone.toUpperCase() : null;
    const existingRows = await all(db, 'SELECT code FROM locations WHERE upper(code) IN (SELECT value FROM json_each(?))', JSON.stringify(codes.map((c) => c.code)));
    const existing = new Set(existingRows.map((e) => e.code.toUpperCase()));
    const create = codes.filter((c) => !existing.has(c.code));
    if (p.preview) {
      return { total: codes.length, create: create.length, codes: create.map((c) => c.code), existing: [...existing].sort() };
    }
    if (!create.length) throw conflict('Minden kód létezik már, nincs mit létrehozni.');
    const rows = create.map((c, i) => ({
      code: c.code, zone: zone || c.zone, size_id: size.id, kind: p.kind, partner_id: partner ? partner.id : null,
      pick_sequence: p.pick_start != null ? p.pick_start + i : 0, active: 1, note: p.note,
    }));
    const res = await batch(db, [insertLocationsStmt(db, rows)]);
    const created = res[0].meta.changes;
    await audit(ctx, {
      module: 'settings', action: 'create', entity: 'location', entityId: '',
      summary: `${created} raktárhely létrehozva (${rows[0].code} és ${rows[rows.length - 1].code} között, ${size.code} méret)`,
      details: { pattern: { ...p, preview: undefined }, created, skipped: existing.size },
    });
    return { created, skipped: [...existing].sort() };
  }, { perm: ['settings', 'create'] });

  // ---------------------------------------------------------------- locations: bulk change
  r.post('/api/settings/locations/bulk-update', async (ctx) => {
    const db = ctx.env.DB;
    const body = await ctx.body();
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number))].filter((n) => Number.isInteger(n) && n > 0) : [];
    if (!ids.length) throw badRequest('Jelölj ki legalább egy raktárhelyet.');
    if (ids.length > 10000) throw badRequest('Egyszerre legfeljebb 10 000 raktárhely módosítható.');
    const data = validate(body, {
      size_id: { type: 'id' }, kind: { type: 'enum', values: Object.keys(LOCATION_KINDS) },
      partner_id: { type: 'id', nullable: true }, zone: { type: 'str', max: 20 }, active: { type: 'bool' },
      pick_sequence: { type: 'int', min: 0, max: 999999 },
    }, { partial: true });
    if ('zone' in data) data.zone = data.zone.toUpperCase();
    if (!Object.keys(data).length) throw badRequest('Válaszd ki, mit módosítsunk.');
    if (data.active === false) need(ctx, 'settings', 'delete');
    let size = null;
    if (data.size_id) size = await sizeFor(db, data.size_id);
    let partner = null;
    if (data.partner_id) partner = await clientPartner(db, data.partner_id);
    const list = JSON.stringify(ids);
    const rows = await all(db, `WITH ${OCC_CTE} SELECT l.id, l.code, l.active, occ.partner_id AS occupant_id, op.name AS occupant_name
      FROM locations l LEFT JOIN occ ON occ.location_id = l.id LEFT JOIN partners op ON op.id = occ.partner_id
      WHERE l.id IN (SELECT value FROM json_each(?)) ORDER BY l.code`, list);
    const skipped = [];
    const ok = [];
    let occupiedResized = 0;
    for (const row of rows) {
      if (partner && row.occupant_id && row.occupant_id !== partner.id) {
        skipped.push({ code: row.code, reason: `${row.occupant_name} áruja van rajta` });
        continue;
      }
      if (data.active === false && row.occupant_id) {
        skipped.push({ code: row.code, reason: 'nem üres' });
        continue;
      }
      if (size && row.occupant_id) occupiedResized++;
      ok.push(row);
    }
    if (rows.length < ids.length) skipped.push({ code: '', reason: `${ids.length - rows.length} raktárhely nem található` });
    if (ok.length) {
      const { sql, args } = setClause(data);
      await run(db, `UPDATE locations SET ${sql} WHERE id IN (SELECT value FROM json_each(?))`, ...args, JSON.stringify(ok.map((x) => x.id)));
      const what = [
        size ? `méret: ${size.code}` : '',
        data.kind ? `típus: ${LOCATION_KINDS[data.kind]}` : '',
        'partner_id' in data ? `fix partner: ${partner ? partner.name : 'nincs'}` : '',
        'zone' in data ? `zóna: ${data.zone || 'nincs'}` : '',
        'pick_sequence' in data ? `komissiós sorrend: ${data.pick_sequence}` : '',
        'active' in data ? (data.active ? 'aktiválva' : 'inaktiválva') : '',
      ].filter(Boolean).join(', ');
      await audit(ctx, {
        module: 'settings', action: data.active === false ? 'delete' : 'edit', entity: 'location', entityId: '',
        summary: `${ok.length} raktárhely módosítva (${what})`,
        details: { changes: data, codes: ok.slice(0, 200).map((x) => x.code), skipped },
      });
    }
    return { updated: ok.length, skipped, occupiedResized };
  }, { perm: ['settings', 'edit'] });

  r.post('/api/settings/locations/bulk-delete', async (ctx) => {
    const db = ctx.env.DB;
    const body = await ctx.body();
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(Number))].filter((n) => Number.isInteger(n) && n > 0) : [];
    if (!ids.length) throw badRequest('Jelölj ki legalább egy raktárhelyet.');
    if (ids.length > 10000) throw badRequest('Egyszerre legfeljebb 10 000 raktárhely törölhető.');
    const rows = await all(db, 'SELECT id, code FROM locations WHERE id IN (SELECT value FROM json_each(?)) ORDER BY code', JSON.stringify(ids));
    const used = await referencedLocations(db, rows.map((x) => x.id));
    const del = rows.filter((x) => !used.has(x.id));
    const skipped = rows.filter((x) => used.has(x.id)).map((x) => ({ code: x.code, reason: 'volt már rajta forgalom, inaktiváld helyette' }));
    if (del.length) {
      await run(db, 'DELETE FROM locations WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(del.map((x) => x.id)));
      await audit(ctx, {
        module: 'settings', action: 'delete', entity: 'location', entityId: '',
        summary: `${del.length} raktárhely törölve`, details: { codes: del.slice(0, 500).map((x) => x.code), skipped: skipped.length },
      });
    }
    return { deleted: del.length, skipped };
  }, { perm: ['settings', 'delete'] });

  // ---------------------------------------------------------------- locations: CSV import
  r.post('/api/settings/locations/import', async (ctx) => {
    const db = ctx.env.DB;
    const { file, form } = await readUpload(ctx);
    const preview = form.get('preview') !== '0';
    const { headers, records } = parseCsv(await file.text());
    const cols = new Set(headers.map((h) => COLUMN_BY_HEADER[h]).filter(Boolean));
    if (!cols.has('code')) throw badRequest('A fájlból hiányzik a Kód oszlop.');
    if (records.length > MAX_IMPORT) throw badRequest(`Egyszerre legfeljebb ${MAX_IMPORT} sor importálható.`);
    const get = (rec, key) => {
      for (const h of headers) if (COLUMN_BY_HEADER[h] === key) return rec[h] ?? '';
      return undefined;
    };
    const sizes = await all(db, 'SELECT id, code, active FROM location_sizes');
    const sizeByCode = new Map(sizes.map((s) => [s.code.toUpperCase(), s]));
    const clients = await all(db, "SELECT id, code, name FROM partners WHERE type = 'client'");
    const clientByCode = new Map(clients.map((p) => [p.code.toUpperCase(), p]));
    const codes = records.map((rec) => normCode(get(rec, 'code')));
    const existingRows = await all(db, `WITH ${OCC_CTE} SELECT l.*, occ.partner_id AS occupant_id FROM locations l LEFT JOIN occ ON occ.location_id = l.id
      WHERE upper(l.code) IN (SELECT value FROM json_each(?))`, JSON.stringify(codes.filter(Boolean)));
    const existing = new Map(existingRows.map((x) => [x.code.toUpperCase(), x]));
    const mayEdit = can(ctx.user, 'settings', 'edit');
    const mayDelete = can(ctx.user, 'settings', 'delete');

    const errors = [];
    const inserts = [];
    const updates = [];
    let unchanged = 0;
    const lineOf = new Map();
    records.forEach((rec, i) => {
      const line = rec._line;
      const code = codes[i];
      const fail = (message) => errors.push({ line, message: code ? `${code}: ${message}` : message });
      if (!code) return fail('Hiányzik a kód.');
      if (code.length > 40 || !LOCATION_CODE.test(code)) return fail(`Hibás kód. ${CODE_RULE}`);
      if (lineOf.has(code)) return fail(`A kód már szerepelt a(z) ${lineOf.get(code)}. sorban.`);
      lineOf.set(code, line);
      const cur = existing.get(code);
      const out = cur
        ? { id: cur.id, code: cur.code, zone: cur.zone, size_id: cur.size_id, kind: cur.kind, partner_id: cur.partner_id, pick_sequence: cur.pick_sequence, active: cur.active, note: cur.note }
        : { code, zone: '', size_id: null, kind: 'storage', partner_id: null, pick_sequence: 0, active: 1, note: '' };

      const zone = get(rec, 'zone');
      if (zone !== undefined && zone !== '') {
        if (zone.length > 20) return fail('A zóna legfeljebb 20 karakter lehet.');
        out.zone = zone.toUpperCase();
      }
      if (!cur && !out.zone) out.zone = deriveZone(code);
      const sizeCode = get(rec, 'size');
      if (sizeCode !== undefined && sizeCode !== '') {
        const s = sizeByCode.get(sizeCode.toUpperCase());
        if (!s) return fail(`Ismeretlen méret: ${sizeCode}.`);
        if (!s.active && !(cur && cur.size_id === s.id)) return fail(`Inaktív méret: ${s.code}.`);
        out.size_id = s.id;
      } else if (!cur) return fail('Új raktárhelyhez add meg a méretet.');
      const kind = get(rec, 'kind');
      if (kind !== undefined && kind !== '') {
        const k = KIND_BY_TEXT[normalizeHeader(kind)];
        if (!k) return fail(`Ismeretlen típus: ${kind}.`);
        out.kind = k;
      }
      const partnerCode = get(rec, 'partner');
      if (partnerCode !== undefined) {
        if (partnerCode === '') out.partner_id = null;
        else {
          const p = clientByCode.get(partnerCode.toUpperCase());
          if (!p) return fail(`Ismeretlen ügyfél kód: ${partnerCode}.`);
          if (cur && cur.occupant_id && cur.occupant_id !== p.id) return fail('A helyen most másik partner áruja van, ezért nem lehet ennek a partnernek a fix helye.');
          out.partner_id = p.id;
        }
      }
      const seq = get(rec, 'pick_sequence');
      if (seq !== undefined && seq !== '') {
        const n = Number(seq);
        if (!Number.isInteger(n) || n < 0 || n > 999999) return fail('A komissiós sorrend 0 és 999999 közötti egész szám.');
        out.pick_sequence = n;
      }
      const act = get(rec, 'active');
      if (act !== undefined && act !== '') {
        const a = normalizeHeader(act);
        if (YES.has(a)) out.active = 1;
        else if (NO.has(a)) out.active = 0;
        else return fail(`Az Aktív oszlopban igen vagy nem álljon (${act}).`);
      }
      const note = get(rec, 'note');
      if (note !== undefined) {
        if (note.length > 300) return fail('A megjegyzés legfeljebb 300 karakter lehet.');
        out.note = note;
      }
      if (!cur) { inserts.push(out); return undefined; }
      const changed = ['zone', 'size_id', 'kind', 'partner_id', 'pick_sequence', 'active', 'note'].some((k) => out[k] !== cur[k]);
      if (!changed) { unchanged++; return undefined; }
      if (!mayEdit) return fail('Ez a kód már létezik, a módosításához nincs jogosultságod.');
      if (cur.active && !out.active) {
        if (!mayDelete) return fail('Az inaktiváláshoz nincs jogosultságod.');
        if (cur.occupant_id) return fail('Nem üres raktárhely nem inaktiválható.');
      }
      updates.push(out);
      return undefined;
    });

    const valid = inserts.length + updates.length + unchanged;
    if (preview) {
      return {
        rows: records.length, valid, errors, created: inserts.length, updated: updates.length, unchanged,
        sample: [...inserts.slice(0, 5).map((x) => ({ ...x, action: 'új' })), ...updates.slice(0, 5).map((x) => ({ ...x, action: 'módosítás' }))],
      };
    }
    const statements = [];
    for (let i = 0; i < inserts.length; i += 1000) statements.push(insertLocationsStmt(db, inserts.slice(i, i + 1000)));
    for (let i = 0; i < updates.length; i += 1000) {
      statements.push(stmt(db, `UPDATE locations SET zone = x.zone, size_id = x.size_id, kind = x.kind, partner_id = x.partner_id,
          pick_sequence = x.pick_sequence, active = x.active, note = x.note
        FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.zone') AS zone, json_extract(value, '$.size_id') AS size_id,
                     json_extract(value, '$.kind') AS kind, json_extract(value, '$.partner_id') AS partner_id,
                     json_extract(value, '$.pick_sequence') AS pick_sequence, json_extract(value, '$.active') AS active, json_extract(value, '$.note') AS note
              FROM json_each(?)) AS x
        WHERE locations.id = x.id`, JSON.stringify(updates.slice(i, i + 1000))));
    }
    if (statements.length) await batch(db, statements);
    if (inserts.length || updates.length) {
      await audit(ctx, {
        module: 'settings', action: inserts.length ? 'create' : 'edit', entity: 'location', entityId: '',
        summary: `Raktárhelyek importálva CSV-ből: ${inserts.length} új, ${updates.length} módosított`,
        details: { file: file.name, created: inserts.length, updated: updates.length, errors: errors.length },
      });
    }
    return { imported: inserts.length + updates.length, created: inserts.length, updated: updates.length, unchanged, errors };
  }, { perm: ['settings', 'create'] });

  // ---------------------------------------------------------------- locations: one
  r.post('/api/settings/locations', async (ctx) => {
    const db = ctx.env.DB;
    const data = validate(await ctx.body(), LOCATION_FIELDS);
    data.code = normCode(data.code);
    if (!LOCATION_CODE.test(data.code)) throw fieldError('code', CODE_RULE);
    data.zone = data.zone ? data.zone.toUpperCase() : deriveZone(data.code);
    if (await first(db, 'SELECT id FROM locations WHERE code = ? COLLATE NOCASE', data.code)) {
      throw conflict('Ilyen kódú raktárhely már van.', { code: 'Ilyen kódú raktárhely már van.' });
    }
    await sizeFor(db, data.size_id);
    if (data.partner_id) await clientPartner(db, data.partner_id);
    const res = await run(db, `INSERT INTO locations (code, zone, size_id, kind, partner_id, pick_sequence, active, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      data.code, data.zone, data.size_id, data.kind, data.partner_id ?? null, data.pick_sequence, data.active, data.note);
    const id = res.meta.last_row_id;
    await audit(ctx, { module: 'settings', action: 'create', entity: 'location', entityId: id, summary: `Raktárhely létrehozva: ${data.code}` });
    return locationById(db, id);
  }, { perm: ['settings', 'create'] });

  r.get('/api/settings/locations/:id', async (ctx) => {
    const db = ctx.env.DB;
    const loc = await locationById(db, Number(ctx.params.id));
    if (!loc) throw notFound('A raktárhely nem található.');
    const stock = await all(db, `SELECT s.product_id, p.sku, p.name, s.lot, s.expiry, s.qty FROM stock s JOIN products p ON p.id = s.product_id
      WHERE s.location_id = ? AND s.qty > 0 ORDER BY p.sku, s.expiry, s.lot`, loc.id);
    const used = await referencedLocations(db, [loc.id]);
    return { ...loc, stock, deletable: !used.has(loc.id) };
  }, { perm: ['settings', 'view'] });

  r.patch('/api/settings/locations/:id', async (ctx) => {
    const db = ctx.env.DB;
    const id = Number(ctx.params.id);
    const loc = await first(db, 'SELECT * FROM locations WHERE id = ?', id);
    if (!loc) throw notFound('A raktárhely nem található.');
    const data = validate(await ctx.body(), LOCATION_FIELDS, { partial: true });
    if (data.code !== undefined) {
      data.code = normCode(data.code);
      if (!LOCATION_CODE.test(data.code)) throw fieldError('code', CODE_RULE);
      if (await first(db, 'SELECT id FROM locations WHERE code = ? COLLATE NOCASE AND id <> ?', data.code, id)) {
        throw conflict('Ilyen kódú raktárhely már van.', { code: 'Ilyen kódú raktárhely már van.' });
      }
    }
    if (data.zone !== undefined) data.zone = data.zone ? data.zone.toUpperCase() : deriveZone(data.code || loc.code);
    if ('active' in data) data.active = data.active ? 1 : 0;
    const changes = diff(loc, data);
    if (!Object.keys(changes).length) return { ...(await locationById(db, id)), warning: '' };
    const occ = await occupant(db, id);
    const warnings = [];
    if ('active' in changes && !data.active) {
      need(ctx, 'settings', 'delete');
      if (occ) throw conflict(`A(z) ${loc.code} raktárhelyen ${occ.name} áruja van. Csak üres raktárhely inaktiválható.`);
    }
    if ('size_id' in changes) {
      await sizeFor(db, data.size_id, { allowInactive: loc.size_id });
      if (occ) warnings.push(`A raktárhelyen most ${occ.name} áruja van: a tárolási díj mostantól az új méret szerint számolódik.`);
    }
    if ('partner_id' in changes && data.partner_id) {
      const p = await clientPartner(db, data.partner_id);
      if (occ && occ.partnerId !== p.id) throw conflict(`A(z) ${loc.code} raktárhelyen most ${occ.name} áruja van, ezért nem lehet ${p.name} fix helye.`);
    }
    if ('kind' in changes && occ) warnings.push(`A raktárhelyen készlet van: típusa mostantól ${LOCATION_KINDS[data.kind]}.`);
    const upd = Object.fromEntries(Object.keys(changes).map((k) => [k, data[k]]));
    const { sql, args } = setClause(upd);
    await run(db, `UPDATE locations SET ${sql} WHERE id = ?`, ...args, id);
    const row = await locationById(db, id);
    await audit(ctx, {
      module: 'settings', action: 'active' in changes && !data.active ? 'delete' : 'edit', entity: 'location', entityId: id,
      summary: 'active' in changes && !data.active ? `Raktárhely inaktiválva: ${row.code}` : `Raktárhely módosítva: ${row.code}`,
      details: { changes },
    });
    return { ...row, warning: warnings.join(' ') };
  }, { perm: ['settings', 'edit'] });

  r.delete('/api/settings/locations/:id', async (ctx) => {
    const db = ctx.env.DB;
    const id = Number(ctx.params.id);
    const loc = await first(db, 'SELECT * FROM locations WHERE id = ?', id);
    if (!loc) throw notFound('A raktárhely nem található.');
    const occ = await occupant(db, id);
    if (occ) throw conflict(`A(z) ${loc.code} raktárhelyen ${occ.name} áruja van. Csak üres raktárhely törölhető.`);
    const used = await referencedLocations(db, [id]);
    if (used.has(id)) throw conflict(`A(z) ${loc.code} raktárhelyen már volt forgalom, ezért nem törölhető. Inaktiváld helyette.`);
    try {
      await run(db, 'DELETE FROM locations WHERE id = ?', id);
    } catch (e) {
      if (/FOREIGN KEY/i.test(String(e.message))) throw conflict(`A(z) ${loc.code} raktárhelyre más adat hivatkozik, ezért nem törölhető. Inaktiváld helyette.`);
      throw e;
    }
    await audit(ctx, { module: 'settings', action: 'delete', entity: 'location', entityId: id, summary: `Raktárhely törölve: ${loc.code}` });
    return { ok: true };
  }, { perm: ['settings', 'delete'] });

  // ---------------------------------------------------------------- couriers
  r.get('/api/settings/couriers', async (ctx) => {
    const defs = courierDefs();
    const items = [];
    for (const d of defs) items.push(await readCourier(ctx.env, d));
    const carriers = await all(ctx.env.DB, "SELECT id, code, name, status, carrier_code FROM partners WHERE type = 'carrier' ORDER BY name");
    return { items, carriers };
  }, { perm: ['settings', 'view'] });

  r.put('/api/settings/couriers/:code', async (ctx) => {
    const db = ctx.env.DB;
    const def = courierDefs().find((d) => d.code === ctx.params.code);
    if (!def) throw notFound('Ismeretlen futárszolgálat.');
    const body = await ctx.body();
    const data = validate(body, { active: { type: 'bool' }, carrier_id: { type: 'id', nullable: true } }, { partial: true });
    const errors = {};
    const settingFields = visibleFields(def.settingFields);
    const credentialFields = visibleFields(def.credentialFields);
    let settings = cleanFields(settingFields, body.settings, 'settings', errors);
    const credentials = cleanFields(credentialFields, body.credentials, 'credentials', errors);
    if (Object.keys(errors).length) throw badRequest('Ellenőrizd a megjelölt mezőket.', errors);
    if (data.carrier_id) {
      const c = await first(db, "SELECT id, carrier_code FROM partners WHERE id = ? AND type = 'carrier'", data.carrier_id);
      if (!c || c.carrier_code !== def.code) throw fieldError('carrier_id', 'Ehhez a futárhoz tartozó fuvarozó partnert válassz.');
    }
    let current;
    try {
      current = await getCourierAccount(ctx.env, def.code);
    } catch (e) {
      throw cryptoProblem(e);
    }
    settings = withDefaults(settingFields, current ? current.settings : {}, settings);
    const active = data.active !== undefined ? data.active : !!(current && current.active);
    if (active) {
      missingRequired(credentialFields, current ? current.credentials : {}, credentials, 'credentials', errors);
      missingRequired(settingFields, current ? current.settings : {}, settings, 'settings', errors);
      if (Object.keys(errors).length) throw badRequest('Az aktiváláshoz töltsd ki a kötelező mezőket.', errors);
    }
    try {
      await saveCourierAccount(ctx.env, def.code, { credentials, settings, active: data.active, carrierId: data.carrier_id });
    } catch (e) {
      throw cryptoProblem(e);
    }
    const changedCreds = Object.keys(credentials);
    const settingChanges = diff(current ? current.settings : {}, settings);
    const details = {
      ...(data.active !== undefined && data.active !== !!(current && current.active) ? { active: data.active } : {}),
      ...(data.carrier_id !== undefined ? { carrier_id: data.carrier_id } : {}),
      ...(Object.keys(settingChanges).length ? { settings: settingChanges } : {}),
      ...(changedCreds.length ? { credentials_changed: changedCreds } : {}),
    };
    await audit(ctx, { module: 'settings', action: 'edit', entity: 'courier_account', entityId: def.code, summary: `Futárszolgálat beállításai módosítva: ${def.name || def.code}`, details });
    return readCourier(ctx.env, def);
  }, { perm: ['settings', 'edit'] });

  r.delete('/api/settings/couriers/:code/credentials', async (ctx) => {
    const def = courierDefs().find((d) => d.code === ctx.params.code);
    if (!def) throw notFound('Ismeretlen futárszolgálat.');
    await clearCourierCredentials(ctx.env, def.code);
    await audit(ctx, { module: 'settings', action: 'edit', entity: 'courier_account', entityId: def.code, summary: `Futárszolgálat hozzáférési adatai törölve: ${def.name || def.code}` });
    return readCourier(ctx.env, def);
  }, { perm: ['settings', 'edit'] });

  r.post('/api/settings/couriers/:code/test', async (ctx) => {
    const def = courierDefs().find((d) => d.code === ctx.params.code);
    if (!def) throw notFound('Ismeretlen futárszolgálat.');
    const res = await runTest(() => couriers.testConnection(ctx.env, def.code));
    await setCourierError(ctx.env, def.code, res.ok ? '' : res.message);
    return res;
  }, { perm: ['settings', 'edit'] });

  // ---------------------------------------------------------------- invoicing
  r.get('/api/settings/invoicing', (ctx) => readInvoicing(ctx.env), { perm: ['settings', 'view'] });

  r.put('/api/settings/invoicing', async (ctx) => {
    const body = await ctx.body();
    const defs = providerDefs();
    const allowed = new Set(['', ...Object.keys(PROVIDER_NAMES), ...defs.map((d) => d.code)]);
    const errors = {};
    if (body.provider !== undefined && !allowed.has(body.provider)) errors.provider = 'Ismeretlen számlázó.';
    const settings = {};
    const credentials = {};
    for (const d of defs) {
      const s = cleanFields(visibleFields(d.settingFields), body.settings && body.settings[d.code], 'settings', errors);
      const c = cleanFields(visibleFields(d.credentialFields), body.credentials && body.credentials[d.code], 'credentials', errors);
      if (Object.keys(s).length) settings[d.code] = s;
      if (Object.keys(c).length) credentials[d.code] = c;
    }
    if (Object.keys(errors).length) throw badRequest('Ellenőrizd a megjelölt mezőket.', errors);
    let current;
    try {
      current = await getInvoicingConfig(ctx.env);
    } catch (e) {
      throw cryptoProblem(e);
    }
    const provider = body.provider !== undefined ? body.provider : current.provider;
    const def = defs.find((d) => d.code === provider);
    for (const d of defs) {
      if (!settings[d.code] && d.code !== provider) continue;
      const s = withDefaults(visibleFields(d.settingFields), (current.settings || {})[d.code], settings[d.code] || {});
      if (Object.keys(s).length) settings[d.code] = s;
    }
    if (def) {
      missingRequired(visibleFields(def.credentialFields), (current.credentials || {})[provider], credentials[provider], 'credentials', errors);
      missingRequired(visibleFields(def.settingFields), (current.settings || {})[provider], settings[provider], 'settings', errors);
      if (Object.keys(errors).length) throw badRequest('A számlázó használatához töltsd ki a kötelező mezőket.', errors);
    }
    try {
      await saveInvoicingConfig(ctx.env, { provider, settings, credentials });
    } catch (e) {
      throw cryptoProblem(e);
    }
    const details = {
      ...(provider !== current.provider ? { provider: [current.provider, provider] } : {}),
      ...Object.fromEntries(Object.entries(settings).map(([code, s]) => [`settings.${code}`, diff((current.settings || {})[code], s)])),
      ...Object.fromEntries(Object.entries(credentials).map(([code, c]) => [`credentials_changed.${code}`, Object.keys(c)])),
    };
    const name = provider ? (def && def.name) || PROVIDER_NAMES[provider] || provider : 'nincs';
    await audit(ctx, { module: 'settings', action: 'edit', entity: 'settings', entityId: 'invoicing', summary: `Számlázó beállításai módosítva (${name})`, details });
    return readInvoicing(ctx.env);
  }, { perm: ['settings', 'edit'] });

  r.delete('/api/settings/invoicing/credentials', async (ctx) => {
    await clearInvoicingCredentials(ctx.env);
    await audit(ctx, { module: 'settings', action: 'edit', entity: 'settings', entityId: 'invoicing', summary: 'Számlázó hozzáférési adatai törölve' });
    return readInvoicing(ctx.env);
  }, { perm: ['settings', 'edit'] });

  r.post('/api/settings/invoicing/test', async (ctx) => {
    const body = await ctx.body();
    let provider = body.provider;
    if (provider === undefined) provider = (await getSetting(ctx.env.DB, 'invoicing', { provider: '' })).provider || '';
    if (!provider) throw badRequest('Előbb válassz számlázót.');
    if (!providerDefs().some((d) => d.code === provider) && !PROVIDER_NAMES[provider]) throw badRequest('Ismeretlen számlázó.');
    return runTest(() => invoicing.testConnection(ctx.env, provider));
  }, { perm: ['settings', 'edit'] });

  // ---------------------------------------------------------------- activity log
  r.get('/api/settings/audit/filters', async (ctx) => {
    const db = ctx.env.DB;
    const entities = (await all(db, "SELECT DISTINCT entity FROM audit_log WHERE entity <> '' ORDER BY entity")).map((x) => x.entity);
    const users = await all(db, 'SELECT id, name, active FROM users ORDER BY name');
    const systems = (await all(db, 'SELECT DISTINCT system FROM integration_log ORDER BY system')).map((x) => x.system);
    return { modules: MODULES.map((m) => ({ key: m.key, name: m.name })), entities, users, systems };
  }, { perm: ['settings', 'view'] });

  r.get('/api/settings/audit', async (ctx) => {
    const db = ctx.env.DB;
    const f = auditFilters(ctx.query);
    const { limit, offset } = page(ctx.query, 50, 200);
    const total = (await first(db, `SELECT COUNT(*) AS n FROM audit_log a ${f.sql}`, ...f.args)).n;
    const rows = await all(db, `SELECT a.id, a.at, a.user_id, a.actor, a.module, a.action, a.entity, a.entity_id, a.summary, a.details
      FROM audit_log a ${f.sql} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...f.args, limit, offset);
    return { items: rows.map((x) => ({ ...x, module_name: MODULE_NAMES[x.module] || x.module, details: parseJson(x.details, null) })), total };
  }, { perm: ['settings', 'view'] });

  r.get('/api/settings/audit/export', async (ctx) => {
    const db = ctx.env.DB;
    const f = auditFilters(ctx.query);
    const rows = await all(db, `SELECT a.at, a.actor, a.module, a.action, a.entity, a.entity_id, a.summary FROM audit_log a ${f.sql} ORDER BY a.id DESC LIMIT 20000`, ...f.args);
    const csv = toCsv([
      { label: 'Időpont', value: (x) => stamp(x.at) },
      { label: 'Felhasználó', key: 'actor' },
      { label: 'Modul', value: (x) => MODULE_NAMES[x.module] || x.module },
      { label: 'Művelet', key: 'action' },
      { label: 'Tétel', key: 'entity' },
      { label: 'Azonosító', key: 'entity_id' },
      { label: 'Leírás', key: 'summary' },
    ], rows);
    return download(csv, `naplo-${budapestDate()}.csv`, 'text/csv; charset=utf-8');
  }, { perm: ['settings', 'view'] });

  // ---------------------------------------------------------------- integration log
  r.get('/api/settings/integration-log', async (ctx) => {
    const db = ctx.env.DB;
    const f = integrationFilters(ctx.query);
    const { limit, offset } = page(ctx.query, 50, 200);
    const total = (await first(db, `SELECT COUNT(*) AS n FROM integration_log i ${f.sql}`, ...f.args)).n;
    const items = await all(db, `SELECT i.*, p.name AS partner_name, p.code AS partner_code FROM integration_log i LEFT JOIN partners p ON p.id = i.partner_id
      ${f.sql} ORDER BY i.id DESC LIMIT ? OFFSET ?`, ...f.args, limit, offset);
    return { items, total };
  }, { perm: ['settings', 'view'] });
}
