// Shared pieces of the webshop adapters: the HTTP client (timeouts, retries, rate limits, logging
// without secrets), errors, settings parsing, carrier and payment mapping, and helpers that turn
// webshop data into clean createOrder() input.
//
// Adapters never touch the database. They get an http() function from createHttp() and return
// normalised orders; the engine in index.js does everything else.

import { CARRIERS } from '../../lib/constants.js';
import { TZ } from '../../lib/time.js';

// kind: auth (credentials refused), rate (rate limited), banned (IP banned by the shop),
// config (connection settings are wrong), http (other HTTP error), network, data (unexpected answer)
export class WebshopError extends Error {
  constructor(message, { kind = 'http', status = null, retryAfter = null } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Workers throw "Illegal invocation" when fetch is called detached from the global, so wrap it.
export const defaultFetch = (...args) => fetch(...args);

function retryAfterMs(headers) {
  const v = headers.get('retry-after');
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return s * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(at - Date.now(), 0);
}

// A path for the log: method and path only. Query strings may carry credentials (WooCommerce
// query string authentication), so they are never logged.
export function logPath(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return 'ismeretlen cím';
  }
}

// createHttp({ fetch, log, sleep, minIntervalMs, timeoutMs, maxWaitMs })
//   -> request(action, url, { method, headers, body, parse: 'json'|'text', retries, expect })
//   -> { status, headers, data, text }
// 429 and 5xx answers are retried (honouring Retry-After up to maxWaitMs). Other non-2xx answers are
// returned to the caller, which turns them into WebshopErrors with platform specific messages.
// Every attempt is logged through log({ action, ok, status, message }).
export function createHttp({ fetch = defaultFetch, log = async () => {}, sleep = defaultSleep, minIntervalMs = 0, timeoutMs = 25000, maxWaitMs = 8000 } = {}) {
  let last = 0;
  return async function request(action, url, { method = 'GET', headers = {}, body, parse = 'json', retries = 2 } = {}) {
    for (let attempt = 0; ; attempt++) {
      if (minIntervalMs) {
        const wait = last + minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
      }
      let res;
      try {
        res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const msg = err && err.name === 'TimeoutError' ? 'időtúllépés' : String((err && err.message) || err).slice(0, 200);
        await log({ action, ok: false, status: null, message: `${method} ${logPath(url)}: hálózati hiba (${msg})` });
        if (attempt < retries) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw new WebshopError(`A webshop nem érhető el (${logPath(url)}): ${msg}.`, { kind: 'network' });
      }
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const wait = Math.min(retryAfterMs(res.headers) ?? 1000 * 2 ** attempt, maxWaitMs);
        await log({ action, ok: false, status: res.status, message: `${method} ${logPath(url)}: ${res.status}, újrapróbálás` });
        await sleep(wait);
        continue;
      }
      let data = text;
      if (parse === 'json' && text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      const ok = res.status >= 200 && res.status < 300;
      await log({ action, ok, status: res.status, message: `${method} ${logPath(url)}: ${res.status}${ok ? '' : ` ${excerpt(text)}`}` });
      if (res.status === 429) {
        throw new WebshopError('A webshop túl sok kérést jelzett (429). Később újrapróbáljuk.', { kind: 'rate', status: 429, retryAfter: retryAfterMs(res.headers) });
      }
      return { status: res.status, headers: res.headers, data, text };
    }
  };
}

// First characters of an error body for the log (HTML pages reduced to their text).
export function excerpt(text, max = 300) {
  return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---------------------------------------------------------------- settings

export const bool = (v, fallback = false) => {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'on', 'yes', 'igen'].includes(String(v).trim().toLowerCase());
};

export const num = (v, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.'));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

// "a, b; c" -> ['a', 'b', 'c']
export const list = (v) => String(v ?? '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);

// Settings with each field's default filled in, values cleaned by field type.
export function readSettings(fields, raw = {}) {
  const out = {};
  for (const f of fields) {
    const v = raw ? raw[f.key] : undefined;
    if (f.type === 'checkbox') out[f.key] = bool(v, f.default ?? false);
    else if (f.type === 'number') out[f.key] = num(v, f.default ?? 0, { min: f.min, max: f.max });
    else out[f.key] = v === undefined || v === null ? (f.default ?? '') : String(v).trim();
  }
  return out;
}

const CARRIER_CODES = Object.keys(CARRIERS);

export const carrierOptions = () => [{ value: '', label: 'Nincs (kézzel választjuk)' }, ...CARRIER_CODES.map((c) => ({ value: c, label: CARRIERS[c] }))];

// Setting fields every platform has. Platform specific fields come first in each adapter.
export function commonSettingFields({ codDefault, carrierHelp = '' }) {
  return [
    { key: 'cod_methods', label: 'Utánvétes fizetési módok', type: 'text', required: false, default: codDefault,
      help: 'Vesszővel elválasztva. Ha a rendelés fizetési módja (neve vagy kódja) tartalmazza valamelyiket, a rendelés utánvétes, az összeget beszedi a futár.' },
    { key: 'carrier_map', label: 'Szállítási módok és futárok', type: 'text', required: false, default: '',
      help: `Párok pontosvesszővel elválasztva: szállítási mód neve=futárkód, vagy futárkód:szolgáltatás. Futárkódok: ${CARRIER_CODES.join(', ')}. Például: GLS házhozszállítás=gls; Foxpost automata=foxpost; MPL postán maradó=mpl:PM; GLS 12 óráig=gls:T12. MPL módok: HA házhoz, PM postán maradó, PP PostaPont, CS csomagautomata. Ha nincs egyezés, a szállítási mód nevéből próbáljuk felismerni a futárt${carrierHelp}.` },
    { key: 'default_carrier', label: 'Alapértelmezett futár', type: 'select', required: false, default: '', options: carrierOptions(),
      help: 'Ezt kapja a rendelés, ha a szállítási módból nem derül ki a futár.' },
    { key: 'ignore_skus', label: 'Kihagyott cikkszámok', type: 'text', required: false, default: '',
      help: 'Vesszővel elválasztva azok a webshop cikkszámok, amelyek nem raktári áruk (például ajándékcsomagolás, szolgáltatás). Ezek a tételek nem kerülnek a rendelésbe.' },
    { key: 'push_fulfillment', label: 'Feladás visszaküldése a webshopba', type: 'checkbox', required: false, default: true,
      help: 'Feladáskor (futárátvétel lezárásakor) a rendelést teljesítettre állítjuk a webshopban a csomagszámmal.' },
    { key: 'cancel_sync', label: 'Webshopban törölt rendelés sztornózása', type: 'checkbox', required: false, default: true,
      help: 'Ha a rendelést a webshopban törlik, nálunk is sztornózzuk, amíg még nem kezdtük el a komissiót.' },
    { key: 'stock_sync', label: 'Készlet visszaküldése', type: 'checkbox', required: false, default: false,
      help: 'Szinkronkor a webshopba küldjük a raktári szabad készletet (azonos cikkszámú termékeknél). Csak akkor kapcsold be, ha a webshop készlete kizárólag nálunk van.' },
    { key: 'initial_days', label: 'Első szinkron visszamenőleg (nap)', type: 'number', required: false, default: 1, min: 0, max: 30,
      help: 'Az első szinkronkor ennyi napra visszamenőleg olvassuk be a módosult rendeléseket.' },
  ];
}

// ---------------------------------------------------------------- mapping helpers

const norm = (s) => String(s ?? '').trim().toLowerCase();

// "GLS házhozszállítás=gls; MPL postán maradó=mpl:PM" ->
//   [{ key: 'gls házhozszállítás', code: 'gls', service: '' }, { key: 'mpl postán maradó', code: 'mpl', service: 'PM' }]
// The optional service is passed to the courier as the order's carrier_service (MPL delivery mode
// HA, PM, PP or CS; GLS extra service such as T12; DPD service code; DHL product code).
export function parseCarrierMap(text) {
  const out = [];
  for (const part of String(text || '').split(/[;\n]/)) {
    const m = part.match(/^(.*?)\s*(?:=>|->|=)\s*([a-z]+)(?:\s*:\s*([A-Za-z0-9_]+))?\s*$/i);
    if (!m || !m[1].trim()) continue;
    const code = m[2].toLowerCase();
    if (CARRIER_CODES.includes(code)) out.push({ key: norm(m[1]), code, service: (m[3] || '').toUpperCase() });
  }
  return out;
}

const MPL_MODES = ['HA', 'PM', 'PP', 'CS'];

// MPL delivery mode from a shipping method name, when the name says it.
export function mplModeFromName(name) {
  const n = norm(name);
  if (/automata/.test(n)) return 'CS';
  if (/postapont/.test(n)) return 'PP';
  if (/postán maradó|postan marado|posta(hivatal|i átvétel)/.test(n)) return 'PM';
  if (/házhoz|hazhoz|home delivery/.test(n)) return 'HA';
  return '';
}

// Carrier and courier service of an order from the shipping method name(s):
//   carrier: exact match in the map, then the longest map entry contained in the name, then a hint
//     from the platform (pickup point provider ...), then keywords in the name, then the default.
//   service: the one written in the map entry; for MPL otherwise the delivery mode the shop gave
//     (mplMode), else read from the method name, else HA (home delivery) when there is no pickup
//     point. Other carriers get no service unless the map says so: a shipping method title must
//     never turn into a paid courier service by accident.
export function resolveShipping(settings, names, { hint = '', mplMode = '', pickupPointId = '' } = {}) {
  const map = parseCarrierMap(settings.carrier_map);
  const candidates = (Array.isArray(names) ? names : [names]).map(norm).filter(Boolean);
  let entry = null;
  for (const n of candidates) {
    entry = map.find((m) => m.key === n);
    if (entry) break;
  }
  if (!entry) {
    for (const n of candidates) {
      entry = map.filter((m) => n.includes(m.key)).sort((a, b) => b.key.length - a.key.length)[0];
      if (entry) break;
    }
  }
  let code = entry ? entry.code : '';
  if (!code && hint && CARRIER_CODES.includes(hint)) code = hint;
  if (!code) code = candidates.map(guessCarrier).find(Boolean) || '';
  if (!code && CARRIER_CODES.includes(settings.default_carrier)) code = settings.default_carrier;
  let service = entry ? entry.service : '';
  if (!service && code === 'mpl') {
    service = MPL_MODES.includes(mplMode) ? mplMode : candidates.map(mplModeFromName).find(Boolean) || (pickupPointId ? '' : 'HA');
  }
  return { carrier_code: code, carrier_service: service };
}

export const resolveCarrier = (settings, names, hint = '') => resolveShipping(settings, names, { hint }).carrier_code;

export function guessCarrier(name) {
  const n = norm(name);
  if (!n) return '';
  if (/\bgls\b/.test(n)) return 'gls';
  if (/\bdpd\b/.test(n)) return 'dpd';
  if (/foxpost/.test(n)) return 'foxpost';
  if (/\bmpl\b|magyar posta|postapont|posta\b/.test(n)) return 'mpl';
  if (/\bdhl\b/.test(n)) return 'dhl';
  return '';
}

// True if any of the given payment method names/codes contains a configured COD term.
export function isCod(settings, methods) {
  const terms = list(settings.cod_methods).map(norm);
  if (!terms.length) return false;
  return (Array.isArray(methods) ? methods : [methods]).map(norm).filter(Boolean)
    .some((m) => terms.some((t) => m === t || m.includes(t)));
}

export const skuIgnored = (settings, sku) => list(settings.ignore_skus).map(norm).includes(norm(sku));

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const clip = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export const clipText = (s, max) => String(s ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
export const joinParts = (...parts) => parts.map((p) => String(p ?? '').trim()).filter(Boolean).join(' ');

export const money = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
};

// Builds the createOrder() input (without partner, source, external ids) from plain values,
// clipped to the field limits so that a long address never makes the import fail.
export function orderInput(v) {
  const email = clip(v.email, 254).toLowerCase();
  const country = clip(v.country, 2).toUpperCase();
  return {
    customer_name: clip(v.customer_name, 200),
    company: clip(v.company, 200),
    email: EMAIL.test(email) ? email : '',
    phone: clip(v.phone, 60),
    country: /^[A-Z]{2}$/.test(country) ? country : 'HU',
    zip: clip(v.zip, 20),
    city: clip(v.city, 120),
    address: clip(v.address, 300),
    pickup_point_id: clip(v.pickup_point_id, 120),
    carrier_code: CARRIER_CODES.includes(v.carrier_code) ? v.carrier_code : '',
    carrier_service: clip(v.carrier_service, 120),
    cod_amount: v.cod_amount > 0 ? v.cod_amount : 0,
    currency: /^[A-Za-z]{3}$/.test(String(v.currency || '')) ? String(v.currency).toUpperCase() : 'HUF',
    note: clipText(v.note, 2000),
    ordered_at: v.ordered_at || null,
  };
}

// Order lines from [{ sku, qty, name, external_line_id }]: drops ignored SKUs, reports lines the
// warehouse cannot handle (no SKU, fractional quantity) as problems. No lines and no problems
// means the order has nothing for the warehouse (the adapter skips it).
export function orderLines(settings, items) {
  const lines = [];
  const problems = [];
  for (const it of items) {
    const sku = clip(it.sku, 120);
    const qty = Number(it.qty);
    if (sku && skuIgnored(settings, sku)) continue;
    if (!(qty > 0)) continue;
    if (!sku) {
      problems.push(`A(z) „${clip(it.name, 80) || 'névtelen'}” tételnek nincs cikkszáma a webshopban.`);
      continue;
    }
    if (!Number.isInteger(qty)) {
      problems.push(`A(z) ${sku} mennyisége nem egész szám (${qty}).`);
      continue;
    }
    lines.push({ sku, qty, external_line_id: clip(it.external_line_id, 120) });
  }
  return { lines, problems };
}

// The normalised order every adapter returns from listOrders():
//   { remoteId, externalId, number, updatedAt (ISO), state: 'import'|'skip'|'cancelled', reason,
//     input (createOrder fields without partner, source and external ids), lines, problems }
export function remoteOrder(base, { state = 'import', reason = '', input = null, lines = [], problems = [] } = {}) {
  const out = { ...base, state, reason, input, lines, problems };
  if (state === 'import') {
    if (!lines.length && !problems.length) return { ...out, state: 'skip', reason: 'Nincs raktári tétel a rendelésben.' };
    if (input && !input.customer_name) out.problems = [...problems, 'Hiányzik a vásárló neve.'];
  }
  return out;
}

// ---------------------------------------------------------------- Budapest local time

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function budapestParts(d) {
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour, i: p.minute, s: p.second };
}

// Date -> "2026-10-16T10:30:05" in Budapest local time (Shoprenter filters).
export function toBudapestLocal(date) {
  const p = budapestParts(date);
  return `${p.y}-${p.m}-${p.d}T${p.h}:${p.i}:${p.s}`;
}

// "2026-10-16T10:30:05" / "2026.10.16 10:30:05" in Budapest local time -> ISO UTC string, or null.
export function fromBudapestLocal(text) {
  const m = String(text || '').trim().match(/^(\d{4})[-.](\d{2})[-.](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, i, s = '00'] = m;
  if (Number(y) < 1971) return null;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +i, +s);
  // The offset of Budapest at that moment (one or two hours); checked twice around DST changes.
  let guess = asUtc;
  for (let k = 0; k < 2; k++) {
    const p = budapestParts(new Date(guess));
    const shown = Date.UTC(+p.y, +p.m - 1, +p.d, +p.h, +p.i, +p.s);
    guess = asUtc - (shown - guess);
  }
  return new Date(guess).toISOString();
}

// ISO string without milliseconds, for APIs that do not take them.
export const isoSeconds = (date) => new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Shown on the partner page above the shop address field.
export const SHOP_URL_HINTS = {
  shopify: { label: 'Shopify bolt címe', placeholder: 'boltod.myshopify.com', help: 'A bolt .myshopify.com végű címe (Beállítások > Domainek), nem a saját domain.' },
  woocommerce: { label: 'Webshop címe', placeholder: 'https://webshop.hu', help: 'A WordPress oldal címe https:// előtaggal. Az API csak HTTPS-en érhető el.' },
  shoprenter: { label: 'Shoprenter bolt neve', placeholder: 'boltneve', help: 'A bolt rövid neve, ahogy az admin címében szerepel (boltneve.shoprenter.hu).' },
  unas: { label: 'Webshop címe', placeholder: 'https://webshop.hu', help: 'Csak tájékoztató adat: az UNAS API-t az API kulcs azonosítja.' },
};
