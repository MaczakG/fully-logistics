// Foxpost: FoxWeb API (OpenAPI "FoxWeb API" 1.2.14, https://webapi.foxpost.hu/v3/api-docs and
// https://webapi.foxpost.hu/swagger-ui/index.html; response handling as in Foxpost's own
// WooCommerce plugin "FOXPOST, Packeta Group" 1.0.26, includes/FoxPostApi.php).
//
//   Parcel:    POST {base}/api/parcel?isWeb=true&isRedirect=false   body: [CreateParcelRequest]
//              -> 201 { valid, parcels: [{ refCode, clFoxId, errors: [{ field, message }] }] }
//   Label:     POST {base}/api/label/{pageSize}?startPos=0         body: ["CLFOX..."] -> application/pdf
//   Tracking:  POST {base}/api/tracking/tracks                     body: ["CLFOX..."] -> [{ barcode, statuses }]
//   Test:      GET  {base}/api/address
//   base:      https://webapi.foxpost.hu (production), https://webapi-test.foxpost.hu (test)
//   Auth:      HTTP Basic (user name, password) plus the "api-key" header.
//
// Parcel locker (APM) delivery: "destination" is the APM id or operator id (e.g. "hu35").
// Home delivery (HD): recipientCity, recipientZip and recipientAddress instead of destination.
// Each package is its own Foxpost parcel; COD is collected with the first one.

import { CourierError, TEST_MODE_FIELD, basicAuth, baseUrl, cut, httpError, isEmail, isHuMobile, isPdf, chunks, setting } from './common.js';

export const code = 'foxpost';
export const name = 'Foxpost';

const URLS = { prod: 'https://webapi.foxpost.hu', test: 'https://webapi-test.foxpost.hu' };
const SIZES = ['xs', 's', 'm', 'l', 'xl'];

export const credentialFields = [
  { key: 'username', label: 'Foxpost felhasználónév', type: 'text', required: true, help: 'A foxpost.hu üzleti fiók Webapi beállításainál találod.' },
  { key: 'password', label: 'Foxpost jelszó', type: 'password', required: true },
  { key: 'api_key', label: 'Foxpost API kulcs', type: 'password', required: true, help: 'A foxpost.hu üzleti fiók Webapi beállításainál találod.' },
];

export const settingFields = [
  TEST_MODE_FIELD('Bekapcsolva a webapi-test.foxpost.hu tesztrendszert használjuk.'),
  {
    key: 'label_format', label: 'Címke mérete', type: 'select', required: false, default: 'A6',
    options: [
      { value: 'A6', label: 'A6 (címkenyomtató)' },
      { value: 'A5', label: 'A5' },
      { value: 'A7', label: 'A7 (A4 lapon, több címke)' },
      { value: '_85X85', label: '85 x 85 mm (címkenyomtató)' },
    ],
  },
  {
    key: 'default_size', label: 'Alapértelmezett csomagméret', type: 'select', required: false, default: 'xs',
    options: SIZES.map((s) => ({ value: s, label: s.toUpperCase() })),
    help: 'Automatás csomagnál a rekesz mérete. Csomagonként felülírható a címkekészítéskor (size).',
  },
];

export const requiredCredentials = ['username', 'password', 'api_key'];
export const requiredSettings = [];

export const features = { cod: true, pickupPoints: true, tracking: true, testMode: true, closeRequired: false };

export const trackingUrl = (n) => `https://foxpost.hu/csomagkovetes/?code=${encodeURIComponent(n)}`;

const headers = (account, accept = 'application/json') => ({
  authorization: basicAuth(account.credentials.username || '', account.credentials.password || ''),
  'api-key': String(account.credentials.api_key || ''),
  accept,
});

// ---------------------------------------------------------------- request building

export function validate(shipment) {
  const r = shipment.recipient;
  const problems = [];
  if (String(r.country || 'HU').toUpperCase() !== 'HU') problems.push('A Foxpost csak belföldre szállít.');
  if (!r.phone) problems.push('Foxpost csomaghoz kötelező a címzett telefonszáma.');
  else if (!isHuMobile(r.phone)) problems.push(`A Foxpost magyar mobilszámot kér (+3620, +3630, +3631, +3650, +3670), a megadott szám: ${r.phone}.`);
  if (!r.email) problems.push('Foxpost csomaghoz kötelező a címzett e-mail címe.');
  else if (!isEmail(r.email)) problems.push(`Hibás e-mail cím: ${r.email}.`);
  if (!shipment.pickupPointId && (!r.zip || !r.city || !r.address)) problems.push('Házhoz szállításhoz add meg a címzett irányítószámát, települését és címét, vagy válassz Foxpost automatát.');
  if (shipment.cod) {
    if (shipment.cod.currency !== 'HUF') problems.push('Foxpost utánvét csak forintban lehet.');
    else if (shipment.cod.amount > 1000000) problems.push('A Foxpost utánvét legfeljebb 1 000 000 Ft lehet.');
  }
  for (const p of shipment.packages) if (p.size && !SIZES.includes(String(p.size).toLowerCase())) problems.push(`Ismeretlen Foxpost csomagméret: ${p.size} (XS, S, M, L, XL).`);
  return problems;
}

export function buildParcelsRequest(shipment, account) {
  const r = shipment.recipient;
  const recipientName = cut(r.company ? `${r.company}, ${r.name}` : r.name, 150);
  const parcels = shipment.packages.map((p, i) => {
    const parcel = {
      recipientName,
      recipientPhone: r.phone,
      recipientEmail: cut(r.email, 100),
      recipientCountry: 'HU',
      size: String(p.size || setting(account, 'default_size', 'xs')).toLowerCase(),
      cod: i === 0 && shipment.cod ? Math.round(shipment.cod.amount) : 0,
      comment: cut(shipment.reference, 50),
      refCode: cut(i ? `${shipment.orderNumber}/${i + 1}` : shipment.orderNumber, 30),
      label: false,
      fragile: false,
    };
    if (shipment.pickupPointId) {
      parcel.destination = String(shipment.pickupPointId).trim();
    } else {
      parcel.recipientCity = cut(r.city, 25);
      parcel.recipientZip = String(r.zip).trim();
      parcel.recipientAddress = cut(r.address, 150);
    }
    return parcel;
  });
  return { url: `${baseUrl(account, URLS)}/api/parcel?isWeb=true&isRedirect=false`, body: parcels };
}

// ---------------------------------------------------------------- response parsing

const FIELD_NAMES = {
  recipientName: 'címzett neve', recipientPhone: 'telefonszám', recipientEmail: 'e-mail cím', recipientZip: 'irányítószám',
  recipientCity: 'település', recipientAddress: 'cím', recipientCountry: 'ország', destination: 'automata', cod: 'utánvét',
  size: 'csomagméret', refCode: 'hivatkozás', comment: 'megjegyzés', deliveryNote: 'futár megjegyzés', uniqueBarcode: 'vonalkód',
};
const MESSAGES = {
  INVALID_APM_ID: 'ismeretlen Foxpost automata (ellenőrizd a csomagpont azonosítót)',
  WRONG_USERNAME_OR_PASSWORD: 'hibás Foxpost felhasználónév vagy jelszó',
  INVALID_API_KEY: 'érvénytelen Foxpost API kulcs',
  NOT_VALID: 'hibás adat',
};

const describe = (e) => {
  const msg = String(e.message || e.error || '').trim();
  if (MESSAGES[msg]) return MESSAGES[msg];
  return `hibás ${FIELD_NAMES[e.field] || e.field || 'adat'}${msg ? ` (${msg})` : ''}`;
};

export function parseParcelsResponse(res) {
  if (res.status === 401) throw new CourierError(`a Foxpost elutasította a belépési adatokat (${(res.data && res.data.error) || 'HTTP 401'}). Ellenőrizd a felhasználónevet, a jelszót és az API kulcsot.`, { kind: 'auth', status: 401 });
  const d = res.data;
  if (!res.ok && !(d && Array.isArray(d.parcels))) throw httpError(res, 'a Foxpost', d && d.error ? describe({ message: d.error }) : '');
  if (!d || !Array.isArray(d.parcels)) throw new CourierError('a Foxpost válasza nem értelmezhető.', { kind: 'response' });
  const errors = [...(d.errors || []), ...d.parcels.flatMap((p) => p.errors || [])];
  if (d.valid === false || errors.length) {
    const text = errors.length ? [...new Set(errors.map(describe))].join('; ') : 'a Foxpost nem fogadta el a csomagot';
    throw new CourierError(`${text}.`, { kind: 'rejected' });
  }
  const ids = d.parcels.map((p) => p.clFoxId || p.barcode).filter(Boolean).map(String);
  if (!ids.length) throw new CourierError('a Foxpost nem adott vissza csomagazonosítót.', { kind: 'response' });
  return ids;
}

// ---------------------------------------------------------------- operations

export async function createShipment(shipment, account, http) {
  const req = buildParcelsRequest(shipment, account);
  const res = await http('parcel', req.url, { method: 'POST', headers: headers(account), json: req.body });
  const ids = parseParcelsResponse(res);
  const booked = { trackingNumber: ids[0], parcelNumbers: ids, carrierIds: ids };
  // The parcels exist at Foxpost by now: a failed label download is reported, not thrown, so the
  // parcel numbers are kept (the label can also be printed on foxpost.hu).
  const pageSize = setting(account, 'label_format', 'A6');
  let lres;
  try {
    lres = await http('label', `${baseUrl(account, URLS)}/api/label/${encodeURIComponent(pageSize)}?startPos=0`, {
      method: 'POST', headers: headers(account, 'application/pdf'), json: ids,
    });
  } catch (err) {
    if (!(err instanceof CourierError)) throw err;
    return { ...booked, label: null, labelError: `a Foxpost címke letöltése nem sikerült (${err.message})` };
  }
  if (!lres.ok || !isPdf(lres.bytes)) {
    return { ...booked, label: null, labelError: `a Foxpost címke letöltése nem sikerült (${(lres.data && lres.data.error) || `HTTP ${lres.status}`})` };
  }
  return { ...booked, label: lres.bytes, labelError: '' };
}

export async function testConnection(account, http) {
  const res = await http('address', `${baseUrl(account, URLS)}/api/address`, { headers: headers(account) });
  if (res.status === 401) return { ok: false, message: `A Foxpost elutasította a belépési adatokat (${(res.data && res.data.error) || 'HTTP 401'}).` };
  if (!res.ok) return { ok: false, message: `A Foxpost nem válaszolt megfelelően (HTTP ${res.status}).` };
  return { ok: true, message: 'A Foxpost kapcsolat rendben.' };
}

// RECEIVE: the recipient took the parcel out of the parcel locker; HDRECEIVE: home delivery done.
const DELIVERED = new Set(['RECEIVE', 'HDRECEIVE']);

export async function trackDelivered(trackingNumbers, account, http) {
  const delivered = [];
  for (const batch of chunks(trackingNumbers, 50)) {
    const res = await http('tracking/tracks', `${baseUrl(account, URLS)}/api/tracking/tracks`, { method: 'POST', headers: headers(account), json: batch });
    if (res.status === 401) throw new CourierError('a Foxpost elutasította a belépési adatokat.', { kind: 'auth', status: 401 });
    if (!res.ok || !Array.isArray(res.data)) throw httpError(res, 'a Foxpost');
    for (const item of res.data) {
      const hit = (item.statuses || []).find((s) => DELIVERED.has(String(s.status || '').toUpperCase()));
      if (hit) delivered.push({ trackingNumber: String(item.barcode), text: hit.status === 'HDRECEIVE' ? 'Házhoz kézbesítve' : 'Átvéve az automatából' });
    }
  }
  return { delivered };
}
