// DHL Express: MyDHL API (REST), OpenAPI "DHL Express APIs (MyDHL API)" 3.3.4, released
// 2026-10-11 (https://developer.dhl.com/api-reference/dhl-express-mydhl-api,
// https://developer.dhl.com/sites/default/files/2026-10/dpdhl-express-api-3.3.4.yaml).
//
// Why DHL Express: in Hungary DHL Parcel/eCommerce parcels are delivered by Magyar Posta and DHL
// eCommerce Hungary only offers bespoke cross-border contracts without a public API, while DHL
// Express (DHL Express Magyarország) serves both domestic (product N, DOMESTIC EXPRESS) and EU
// (product U, EXPRESS WORLDWIDE; W, ECONOMY SELECT) shipments with the self-service MyDHL API.
//
//   Label:     POST {base}/shipments   -> 201 { shipmentTrackingNumber, packages[].trackingNumber, documents[] }
//   Tracking:  GET  {base}/tracking?shipmentTrackingNumber=..&shipmentTrackingNumber=.. (up to 200)
//   Test:      GET  {base}/address-validate?type=delivery&countryCode=HU&postalCode=2351&cityName=Alsónémedi
//   base:      https://express.api.dhl.com/mydhlapi (production), https://express.api.dhl.com/mydhlapi/test (test)
//   Auth:      HTTP Basic (API key, API secret), header x-version: 3.3.4
//   Errors:    application/problem+json { title, detail, status, additionalDetails }
//
// Not supported here: cash on delivery (not offered by DHL Express for these shipments), service
// point delivery and dutiable (non-EU) shipments, which need customs data.

import {
  CourierError, EU_COUNTRIES, SENDER_FIELDS, TEST_MODE_FIELD, base64ToBytes, basicAuth, baseUrl, budapestDateTimeGmt, chunks, cut, httpError,
  isPdf, round, setting, uuid,
} from './common.js';

export const code = 'dhl';
export const name = 'DHL Express';

const URLS = { prod: 'https://express.api.dhl.com/mydhlapi', test: 'https://express.api.dhl.com/mydhlapi/test' };
export const API_VERSION = '3.3.4';

export const credentialFields = [
  { key: 'api_key', label: 'MyDHL API kulcs (API Key)', type: 'text', required: true, help: 'A developer.dhl.com oldalon kapott MyDHL API felhasználó.' },
  { key: 'api_secret', label: 'MyDHL API titok (API Secret)', type: 'password', required: true },
];

export const settingFields = [
  { key: 'account_number', label: 'DHL Express ügyfélszám (feladói)', type: 'text', required: true, help: 'A DHL Express szerződés 9 jegyű ügyfélszáma (shipper account).' },
  TEST_MODE_FIELD('Bekapcsolva a MyDHL API teszt környezetét használjuk (napi 500 hívás).'),
  {
    key: 'label_format', label: 'Címke formátuma', type: 'select', required: false, default: 'ECOM26_A6_002',
    options: [
      { value: 'ECOM26_A6_002', label: 'A6 (címkenyomtató)' },
      { value: 'ECOM26_84_001', label: '4 x 8 hüvelyk (DHL alapértelmezés)' },
      { value: 'ECOM26_84_A4_001', label: 'A4' },
    ],
  },
  {
    key: 'product_domestic', label: 'Belföldi termék', type: 'select', required: false, default: 'N',
    options: [{ value: 'N', label: 'DOMESTIC EXPRESS (N)' }, { value: 'G', label: 'ECONOMY SELECT DOMESTIC (G)' }],
  },
  {
    key: 'product_eu', label: 'EU-s termék', type: 'select', required: false, default: 'U',
    options: [{ value: 'U', label: 'EXPRESS WORLDWIDE (U)' }, { value: 'W', label: 'ECONOMY SELECT (W)' }],
  },
  { key: 'content_description', label: 'Tartalom leírása', type: 'text', required: false, default: 'Webáruházi termékek', help: 'A szállítmány tartalma a fuvarlevélen (legfeljebb 70 karakter).' },
  ...SENDER_FIELDS,
];

export const requiredCredentials = ['api_key', 'api_secret'];
export const requiredSettings = ['account_number'];

export const features = { cod: false, pickupPoints: false, tracking: true, testMode: true, closeRequired: false };

export const trackingUrl = (n) => `https://www.dhl.com/hu-hu/home/tracking.html?tracking-id=${encodeURIComponent(n)}&submit=1`;

const headers = (account) => ({
  authorization: basicAuth(account.credentials.api_key || '', account.credentials.api_secret || ''),
  'x-version': API_VERSION,
  'message-reference': uuid(),
});

// ---------------------------------------------------------------- request building

export function validate(shipment) {
  const r = shipment.recipient;
  const country = String(r.country || 'HU').toUpperCase();
  const problems = [];
  if (!EU_COUNTRIES.has(country)) problems.push('DHL Express-szel csak belföldre és EU-n belülre adható fel csomag (EU-n kívülre vámadatok kellenek).');
  if (shipment.cod) problems.push('A DHL Express nem szállít utánvéttel. Válassz másik futárt, vagy töröld az utánvétet.');
  if (shipment.pickupPointId) problems.push('A DHL Express integráció csak házhoz szállítást támogat, a csomagpontot töröld a rendelésből.');
  if (!r.phone) problems.push('DHL Express csomaghoz kötelező a címzett telefonszáma.');
  if (!r.city || !r.address) problems.push('A címzett címe hiányos (település, cím).');
  const s = shipment.sender;
  if (!s.name || !s.city || !s.address) problems.push('Hiányos a feladó címe (Beállítások, Cégadatok vagy a DHL fiók feladó mezői).');
  if (!s.phone) problems.push('A DHL Express feladáshoz add meg a feladó telefonszámát (Beállítások, Cégadatok).');
  return problems;
}

const lines = (address) => {
  const a = cut(address, 135);
  if (a.length <= 45) return { addressLine1: a };
  const cutAt = a.lastIndexOf(' ', 45) > 10 ? a.lastIndexOf(' ', 45) : 45;
  const rest = a.slice(cutAt).trim();
  return { addressLine1: a.slice(0, cutAt).trim(), addressLine2: cut(rest, 45), ...(rest.length > 45 ? { addressLine3: cut(rest.slice(45), 45) } : {}) };
};

const party = (p, { company, fullName }) => ({
  postalAddress: {
    postalCode: cut(p.zip, 12),
    cityName: cut(p.city, 45),
    countryCode: String(p.country || 'HU').toUpperCase(),
    ...lines(p.address),
  },
  contactInformation: {
    phone: cut(p.phone, 70),
    companyName: cut(company, 100),
    fullName: cut(fullName, 255),
    ...(p.email ? { email: cut(p.email, 70) } : {}),
  },
});

export function buildShipmentRequest(shipment, account, now = new Date()) {
  const r = shipment.recipient;
  const s = shipment.sender;
  const domestic = String(r.country || 'HU').toUpperCase() === 'HU';
  const fromOrder = String(shipment.service || '').trim().toUpperCase();
  const productCode = /^[A-Z0-9]$/.test(fromOrder) ? fromOrder : domestic ? setting(account, 'product_domestic', 'N') : setting(account, 'product_eu', 'U');
  // The time must not be "now" (DHL may see it as past): planned for an hour later.
  const planned = budapestDateTimeGmt(new Date(now.getTime() + 60 * 60 * 1000));
  const receiver = party(r, { company: r.company || r.name, fullName: r.name });
  receiver.typeCode = r.company ? 'business' : 'private';
  const body = {
    plannedShippingDateAndTime: planned,
    pickup: { isRequested: false },
    productCode,
    accounts: [{ typeCode: 'shipper', number: String(setting(account, 'account_number')) }],
    outputImageProperties: {
      encodingFormat: 'pdf',
      imageOptions: [
        { typeCode: 'label', templateName: setting(account, 'label_format', 'ECOM26_A6_002'), isRequested: true },
        { typeCode: 'waybillDoc', isRequested: false },
      ],
    },
    customerReferences: [{ typeCode: 'CU', value: cut(shipment.orderNumber, 35) }],
    customerDetails: {
      shipperDetails: { ...party(s, { company: s.name, fullName: s.contactName || s.name }), typeCode: 'business' },
      receiverDetails: receiver,
    },
    content: {
      packages: shipment.packages.map((p, i) => {
        const pkg = { weight: Math.max(0.001, round(p.weightKg, 3)), customerReferences: [{ typeCode: 'CU', value: cut(i ? `${shipment.orderNumber}/${i + 1}` : shipment.orderNumber, 35) }] };
        if (p.lengthCm && p.widthCm && p.heightCm) pkg.dimensions = { length: round(p.lengthCm, 1), width: round(p.widthCm, 1), height: round(p.heightCm, 1) };
        return pkg;
      }),
      isCustomsDeclarable: false,
      description: cut(setting(account, 'content_description', 'Webáruházi termékek'), 70),
      incoterm: 'DAP',
      unitOfMeasurement: 'metric',
    },
  };
  return { url: `${baseUrl(account, URLS)}/shipments`, body };
}

// ---------------------------------------------------------------- response parsing

export function errorText(d) {
  if (!d || typeof d !== 'object') return '';
  const more = Array.isArray(d.additionalDetails) ? d.additionalDetails.map((x) => (typeof x === 'string' ? x : x && (x.message || x.detail || JSON.stringify(x)))).filter(Boolean) : [];
  return [d.detail || d.message || d.title, ...more].filter(Boolean).join(' ');
}

export function parseShipmentResponse(res) {
  if (res.status === 401) throw new CourierError('a DHL elutasította az API kulcsot vagy titkot (HTTP 401).', { kind: 'auth', status: 401 });
  if (!res.ok) throw httpError(res, 'a DHL', errorText(res.data));
  const d = res.data;
  if (!d || !d.shipmentTrackingNumber) throw new CourierError('a DHL válasza nem tartalmaz fuvarlevélszámot.', { kind: 'response' });
  const doc = (d.documents || []).find((x) => String(x.typeCode).toLowerCase() === 'label') || (d.documents || [])[0];
  const label = doc ? base64ToBytes(doc.content) : null;
  if (!label || !isPdf(label)) throw new CourierError('a DHL nem adott vissza PDF címkét.', { kind: 'response' });
  return {
    trackingNumber: String(d.shipmentTrackingNumber),
    parcelNumbers: (d.packages || []).map((p) => String(p.trackingNumber)).filter(Boolean),
    label,
    carrierIds: [String(d.shipmentTrackingNumber)],
  };
}

// ---------------------------------------------------------------- operations

export async function createShipment(shipment, account, http) {
  const req = buildShipmentRequest(shipment, account);
  const res = await http('shipments', req.url, { method: 'POST', headers: headers(account), json: req.body });
  return parseShipmentResponse(res);
}

export async function testConnection(account, http) {
  const q = new URLSearchParams({ type: 'delivery', countryCode: 'HU', postalCode: '2351', cityName: 'Alsónémedi' });
  const res = await http('address-validate', `${baseUrl(account, URLS)}/address-validate?${q}`, { headers: headers(account) });
  if (res.status === 401 || res.status === 403) return { ok: false, message: `A DHL elutasította az API kulcsot vagy titkot (HTTP ${res.status}).` };
  if (!res.ok) return { ok: false, message: `A DHL nem válaszolt megfelelően (HTTP ${res.status}): ${errorText(res.data) || 'ismeretlen hiba'}` };
  return { ok: true, message: 'A DHL Express kapcsolat rendben.' };
}

// Event type "OK" is delivery ("Delivered").
export async function trackDelivered(trackingNumbers, account, http) {
  const delivered = [];
  for (const batch of chunks(trackingNumbers, 50)) {
    const q = new URLSearchParams();
    for (const n of batch) q.append('shipmentTrackingNumber', n);
    q.set('trackingView', 'all-checkpoints');
    q.set('levelOfDetail', 'shipment');
    const res = await http('tracking', `${baseUrl(account, URLS)}/tracking?${q}`, { headers: headers(account) });
    if (res.status === 404) continue;
    if (!res.ok || !res.data) throw httpError(res, 'a DHL', errorText(res.data));
    for (const sh of res.data.shipments || []) {
      const hit = (sh.events || []).find((e) => String(e.typeCode).toUpperCase() === 'OK');
      if (hit) delivered.push({ trackingNumber: String(sh.shipmentTrackingNumber), text: String(hit.description || 'Delivered').trim() });
    }
  }
  return { delivered };
}
