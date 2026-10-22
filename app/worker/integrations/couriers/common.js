// Shared helpers of the courier adapters: HTTP calls with timeout and logging, error type,
// address and phone normalisation, Budapest date and time, base64.
//
// Nothing here touches Workers-only globals at import time, so the adapters can be imported and
// unit tested in plain Node (test/couriers.test.mjs).

// ---------------------------------------------------------------- errors

// kind: config (our account settings), invalid (order data, found before calling the carrier),
//       rejected (the carrier refused the data), auth (credentials refused),
//       unavailable (network error, timeout, 5xx), response (unexpected answer).
export class CourierError extends Error {
  constructor(message, { kind = 'rejected', status = null, fields = undefined } = {}) {
    super(message);
    this.name = 'CourierError';
    this.kind = kind;
    this.status = status;
    this.fields = fields;
  }
}

// ---------------------------------------------------------------- HTTP

const decoder = new TextDecoder();

const pathOf = (url) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return String(url).slice(0, 200);
  }
};

// request(action, url, { method, headers, json, form, body, timeoutMs })
//   -> { status, ok, headers, contentType, bytes, text, data }
// Every call is logged through log({ action, ok, status, message }) without bodies or headers,
// so secrets never reach the integration log. Network errors and timeouts throw CourierError
// (kind unavailable); HTTP error statuses are returned for the adapter to interpret.
export function makeHttp({ fetch: fetchFn = (...a) => globalThis.fetch(...a), log = async () => {}, timeoutMs = 30000 } = {}) {
  return async function request(action, url, { method = 'GET', headers = {}, json, form, body, timeoutMs: perCall } = {}) {
    const h = { accept: 'application/json', ...headers };
    let payload = body;
    if (json !== undefined) {
      payload = typeof json === 'string' ? json : JSON.stringify(json);
      h['content-type'] = 'application/json';
    } else if (form !== undefined) {
      payload = new URLSearchParams(form).toString();
      h['content-type'] = 'application/x-www-form-urlencoded';
    }
    const started = Date.now();
    let res;
    try {
      res = await fetchFn(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(perCall || timeoutMs) });
    } catch (err) {
      const reason = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'időtúllépés' : String((err && err.message) || err);
      await safeLog(log, { action, ok: false, status: null, message: `${method} ${pathOf(url)}: ${reason}` });
      throw new CourierError(`a szerver nem érhető el (${reason})`, { kind: 'unavailable' });
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || '';
    const isBinary = /application\/(pdf|octet-stream)|image\//i.test(contentType);
    const text = isBinary ? '' : decoder.decode(bytes);
    let data = null;
    if (!isBinary && text) {
      const t = text.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          data = JSON.parse(t);
        } catch {
          data = null;
        }
      }
    }
    await safeLog(log, { action, ok: res.ok, status: res.status, message: `${method} ${pathOf(url)} HTTP ${res.status} (${Date.now() - started} ms)` });
    return { status: res.status, ok: res.ok, headers: res.headers, contentType, bytes, text, data };
  };
}

async function safeLog(log, entry) {
  try {
    await log(entry);
  } catch {
    // Logging must never break a label.
  }
}

// Turns a non-2xx answer the adapter could not explain into a CourierError.
// who: the carrier with its article, e.g. "a GLS", "az MPL".
export function httpError(res, who, detail = '') {
  const extra = detail ? `: ${detail}` : '';
  if (res.status === 401) return new CourierError(`${who} elutasította a belépési adatokat (HTTP 401)${extra}. Ellenőrizd a fiókot a Beállításokban.`, { kind: 'auth', status: 401 });
  if (res.status === 403) return new CourierError(`a fióknak nincs jogosultsága ehhez a művelethez ${who} rendszerében (HTTP 403)${extra}.`, { kind: 'auth', status: 403 });
  if (res.status === 429) return new CourierError(`túl sok kérés ment ${who} felé (HTTP 429), próbáld újra egy perc múlva${extra}.`, { kind: 'unavailable', status: 429 });
  if (res.status >= 500) return new CourierError(`${who} szervere hibát jelzett (HTTP ${res.status})${extra}. Próbáld újra pár perc múlva.`, { kind: 'unavailable', status: res.status });
  return new CourierError(`${who} hibát jelzett (HTTP ${res.status})${extra}`, { kind: 'rejected', status: res.status });
}

// Base URL of an adapter: production, test environment, or (tests only) a local fake carrier.
// api_base_url is honoured only for http://127.0.0.1 or http://localhost, so a stored setting can
// never send credentials to an outside host.
export function baseUrl(account, { prod, test }) {
  const override = account && account.settings && account.settings.api_base_url;
  if (override && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/.*)?$/.test(String(override))) return String(override).replace(/\/+$/, '');
  return (isTestMode(account) ? test : prod).replace(/\/+$/, '');
}

export const isTestMode = (account) => {
  const v = account && account.settings ? account.settings.test_mode : false;
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
};

export const flag = (settings, key, fallback = false) => {
  const v = settings ? settings[key] : undefined;
  if (v === undefined || v === null || v === '') return fallback;
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
};

// Setting value with the field's default.
export const setting = (account, key, fallback = '') => {
  const v = account && account.settings ? account.settings[key] : undefined;
  return v === undefined || v === null || v === '' ? fallback : v;
};

// ---------------------------------------------------------------- bytes

export function base64ToBytes(b64) {
  const clean = String(b64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

const encoder = new TextEncoder();

export const basicAuth = (user, pass) => `Basic ${bytesToBase64(encoder.encode(`${user}:${pass}`))}`;

export const isPdf = (bytes) => !!bytes && bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;

export async function sha512Bytes(text) {
  const digest = await crypto.subtle.digest('SHA-512', encoder.encode(String(text)));
  return Array.from(new Uint8Array(digest));
}

export const uuid = () => crypto.randomUUID();

// ---------------------------------------------------------------- text

export const cut = (s, max) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).trim() : t;
};

// ---------------------------------------------------------------- addresses

// Public space types in Hungarian addresses, longest first so "körút" wins over "út".
const STREET_TYPES = [
  'sugárút', 'körút', 'krt\\.?', 'rakpart', 'lakótelep', 'ltp\\.?', 'sétány', 'fasor', 'utca', 'u\\.', 'útja', 'út',
  'tér', 'tere', 'köz', 'sor', 'park', 'dűlő', 'liget', 'lejtő', 'lépcső', 'udvar', 'kert', 'telep', 'tanya', 'major',
  'határút', 'ösvény', 'sziget', 'part', 'hegy', 'domb', 'zug', 'kapu', 'pincesor', 'puszta',
];
const TYPED = new RegExp(`^(.+?\\s(?:${STREET_TYPES.join('|')}))\\.?\\s*(\\d+)(.*)$`, 'iu');
const TRAILING = /^(.*\S)\s+(\d+)([^\d].*)?$/u;
const LEADING = /^(\d+)\s*([A-Za-z]?)\s+(.+)$/u;

const tidyInfo = (s) => String(s || '').replace(/^[\s.,]+/, '').replace(/\s+/g, ' ').trim();

// "Fő utca 12/B. 2. em." -> { street: "Fő utca", houseNumber: "12", houseInfo: "/B. 2. em." }
export function splitStreet(address) {
  const s = String(address || '').replace(/\s+/g, ' ').trim();
  if (!s) return { street: '', houseNumber: '', houseInfo: '' };
  let m = s.match(TYPED);
  if (m) return { street: m[1].trim(), houseNumber: m[2], houseInfo: tidyInfo(m[3]) };
  m = s.match(TRAILING);
  if (m) return { street: m[1].replace(/[,]$/, '').trim(), houseNumber: m[2], houseInfo: tidyInfo(m[3]) };
  m = s.match(LEADING);
  if (m) return { street: m[3].trim(), houseNumber: m[1], houseInfo: tidyInfo(m[2]) };
  return { street: s, houseNumber: '', houseInfo: '' };
}

export const EU_COUNTRIES = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);

export const CALLING_CODES = {
  AT: '43', BE: '32', BG: '359', HR: '385', CY: '357', CZ: '420', DK: '45', EE: '372', FI: '358', FR: '33', DE: '49', GR: '30',
  HU: '36', IE: '353', IT: '39', LV: '371', LT: '370', LU: '352', MT: '356', NL: '31', PL: '48', PT: '351', RO: '40', SK: '421',
  SI: '386', ES: '34', SE: '46', GB: '44', CH: '41', NO: '47', RS: '381', UA: '380', BA: '387', ME: '382', MK: '389', AL: '355',
};
const CODES_BY_LENGTH = [...new Set(Object.values(CALLING_CODES))].sort((a, b) => b.length - a.length);

// Phone number in E.164 ("+36301234567"). Hungarian habits handled: 06..., 36..., 30/123-4567.
export function normalizePhone(raw, country = 'HU') {
  const s = String(raw || '').trim();
  if (!s) return '';
  let digits = s.replace(/\D/g, '');
  if (!digits) return '';
  if (s.startsWith('+')) return `+${digits}`;
  if (s.startsWith('00')) return `+${digits.slice(2)}`;
  const cc = CALLING_CODES[String(country || 'HU').toUpperCase()] || '36';
  if (cc === '36') {
    if (digits.startsWith('06')) digits = digits.slice(2);
    else if (digits.startsWith('36') && digits.length >= 10) digits = digits.slice(2);
    return `+36${digits}`;
  }
  if (digits.startsWith(cc) && digits.length > cc.length + 6) return `+${digits}`;
  return `+${cc}${digits.replace(/^0+/, '')}`;
}

// Hungarian mobile numbers (20, 30, 31, 50, 70), needed for parcel locker codes.
export const isHuMobile = (e164) => /^\+36(20|30|31|50|70)\d{7}$/.test(String(e164 || ''));
export const isHuPhone = (e164) => /^\+36(1\d{7}|[2-9]\d{7,8})$/.test(String(e164 || ''));

// "+36301234567" -> { prefix: "+36", number: "301234567" }
export function splitPhone(e164) {
  const s = String(e164 || '');
  if (!s.startsWith('+')) return { prefix: '', number: s };
  const d = s.slice(1);
  const cc = CODES_BY_LENGTH.find((c) => d.startsWith(c));
  return cc ? { prefix: `+${cc}`, number: d.slice(cc.length) } : { prefix: '', number: s };
}

export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));

// ---------------------------------------------------------------- Budapest time

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function budapestParts(d = new Date()) {
  const p = Object.fromEntries(partsFmt.formatToParts(d).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

// Minutes Budapest is ahead of UTC at that instant (60 or 120).
export function budapestOffsetMinutes(d = new Date()) {
  const p = budapestParts(d);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

// "2026-10-16"
export function budapestDay(d = new Date()) {
  const p = budapestParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// "2026-10-16T15:30:00 GMT+02:00" (DHL Express plannedShippingDateAndTime)
export function budapestDateTimeGmt(d = new Date()) {
  const p = budapestParts(d);
  const off = budapestOffsetMinutes(d);
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)} GMT${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// UTC milliseconds of 00:00:00 (or 23:59:59) of a Budapest calendar day.
export function budapestDayStartMs(day, endOfDay = false) {
  const [y, m, dd] = day.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, dd, 12));
  const off = budapestOffsetMinutes(guess);
  const local = endOfDay ? Date.UTC(y, m - 1, dd, 23, 59, 59) : Date.UTC(y, m - 1, dd, 0, 0, 0);
  return local - off * 60000;
}

// ---------------------------------------------------------------- misc

export const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

export const round = (n, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(Number(n) * f) / f;
};

// Field definitions shared by every carrier's settings form.
export const SENDER_FIELDS = [
  { key: 'sender_name', label: 'Feladó neve', type: 'text', required: false, help: 'Üresen hagyva a cégadatok szerinti név (Beállítások, Cégadatok).' },
  { key: 'sender_zip', label: 'Feladó irányítószáma', type: 'text', required: false, help: 'Üresen hagyva a cégadatok szerint.' },
  { key: 'sender_city', label: 'Feladó települése', type: 'text', required: false, help: 'Üresen hagyva a cégadatok szerint.' },
  { key: 'sender_address', label: 'Feladó címe (utca, házszám)', type: 'text', required: false, help: 'Üresen hagyva a cégadatok szerint.' },
  { key: 'sender_phone', label: 'Feladó telefonszáma', type: 'text', required: false, help: 'Üresen hagyva a cégadatok szerint.' },
  { key: 'sender_email', label: 'Feladó e-mail címe', type: 'text', required: false, help: 'Üresen hagyva a cégadatok szerint.' },
];

export const TEST_MODE_FIELD = (help) => ({ key: 'test_mode', label: 'Teszt környezet', type: 'checkbox', required: false, default: false, help });
