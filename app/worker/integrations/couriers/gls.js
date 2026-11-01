// GLS Hungary: MyGLS API, REST with JSON (documentation "MyGLS API for system integration",
// ver. 25.12.11, https://api.mygls.hu/docs/MyGLS_API.pdf, and the official sample
// php_rest_client.php from https://api.mygls.hu/docs/mygls_api_20260331.zip).
//
//   Label:     POST {base}/ParcelService.svc/json/PrintLabels   (PrepareLabels + GetPrintedLabels in one step)
//   Tracking:  POST {base}/ParcelService.svc/json/GetParcelListStatuses   (up to 100 parcel numbers)
//   Test:      POST {base}/ParcelService.svc/json/GetParcelList            (today's printed parcels)
//   base:      https://api.mygls.hu (production), https://api.test.mygls.hu (testing)
//
// Every request carries Username and Password, where Password is the SHA-512 hash of the
// password as a JSON byte array ([12,250,...]). Byte arrays in responses (Labels) are JSON number
// arrays; base64 strings are accepted too. DateTime values use the WCF format "\/Date(ms)\/".

import {
  CourierError, SENDER_FIELDS, TEST_MODE_FIELD, baseUrl, base64ToBytes, budapestDay, budapestDayStartMs, chunks, cut, flag, httpError,
  round, setting, sha512Bytes,
} from './common.js';

export const code = 'gls';
export const name = 'GLS';

const URLS = { prod: 'https://api.mygls.hu', test: 'https://api.test.mygls.hu' };
const WEBSHOP_ENGINE = 'Fully Logistics WMS';

const EXTRA_SERVICES = ['24H', 'T09', 'T10', 'T12', 'SAT', 'XS', 'TGS', 'SRS'];

export const credentialFields = [
  { key: 'username', label: 'MyGLS felhasználónév (e-mail cím)', type: 'text', required: true, help: 'A MyGLS felületre is ezzel lépsz be.' },
  { key: 'password', label: 'MyGLS jelszó', type: 'password', required: true, help: 'Titkosítva tároljuk, a GLS felé SHA-512 lenyomatként küldjük.' },
];

export const settingFields = [
  { key: 'client_number', label: 'GLS ügyfélszám', type: 'number', required: true, help: 'A GLS által adott ügyfélszám (ClientNumber), a szerződésben vagy a MyGLS felületen találod.' },
  TEST_MODE_FIELD('Bekapcsolva az api.test.mygls.hu tesztrendszert használjuk, a csomagok nem indulnak el.'),
  {
    key: 'label_format', label: 'Címke formátuma', type: 'select', required: false, default: 'Thermo',
    options: [
      { value: 'Thermo', label: 'Címkenyomtató (10x15 cm)' },
      { value: 'A4_2x2', label: 'A4, 4 címke laponként (2x2)' },
      { value: 'A4_4x1', label: 'A4, 4 címke egymás alatt (4x1)' },
      { value: 'Connect', label: 'GLS Connect nyomtató' },
    ],
    help: 'A GLS TypeOfPrinter beállítása.',
  },
  {
    key: 'default_service', label: 'Alapértelmezett többletszolgáltatás', type: 'select', required: false, default: '',
    options: [
      { value: '', label: 'Nincs (normál Business Parcel)' },
      { value: 'T12', label: 'Express, 12 óráig (T12)' },
      { value: 'T10', label: 'Express, 10 óráig (T10)' },
      { value: 'T09', label: 'Express, 9 óráig (T09)' },
      { value: '24H', label: 'Garantált 24 órás kézbesítés (24H)' },
      { value: 'SAT', label: 'Szombati kézbesítés (SAT)' },
      { value: 'TGS', label: 'Think Green (TGS)' },
    ],
    help: 'A rendelés futárszolgáltatás mezője (pl. "T12") felülírja.',
  },
  { key: 'notify_email', label: 'E-mail értesítés a címzettnek (FDS)', type: 'checkbox', required: false, default: true, help: 'Házhoz szállításnál a GLS e-mailben értesíti a címzettet, ha van e-mail cím.' },
  { key: 'notify_sms', label: 'SMS értesítés a címzettnek (FSS)', type: 'checkbox', required: false, default: false, help: 'Csak az e-mail értesítéssel együtt kérhető, külön díjas lehet.' },
  ...SENDER_FIELDS,
];

export const requiredCredentials = ['username', 'password'];
export const requiredSettings = ['client_number'];

export const features = { cod: true, pickupPoints: true, tracking: true, testMode: true, closeRequired: false };

export const trackingUrl = (n) => `https://gls-group.com/HU/hu/csomagkovetes?match=${encodeURIComponent(n)}`;

// ---------------------------------------------------------------- request building

const address = (a, { name: n, contactName, phone, email }) => ({
  Name: cut(n, 100),
  Street: cut(a.street || a.address, 100),
  HouseNumber: cut(a.houseNumber, 20),
  HouseNumberInfo: cut(a.houseInfo, 50),
  City: cut(a.city, 60),
  ZipCode: cut(a.zip, 10),
  CountryIsoCode: String(a.country || 'HU').toUpperCase(),
  ContactName: cut(contactName, 100),
  ContactPhone: cut(phone, 30),
  ContactEmail: cut(email, 100),
});

const serviceCodes = (shipment, account) => {
  const fromOrder = String(shipment.service || '').toUpperCase().split(/[\s,;]+/).filter((c) => EXTRA_SERVICES.includes(c));
  const fallback = setting(account, 'default_service', '');
  return fromOrder.length ? fromOrder : fallback ? [fallback] : [];
};

// Validation before calling GLS. Returns Hungarian problems, empty when everything is fine.
export function validate(shipment) {
  const r = shipment.recipient;
  const problems = [];
  if (!r.zip || !r.city || !(r.street || r.address)) problems.push('A címzett címe hiányos (irányítószám, település, utca).');
  if (r.houseNumber === '0') problems.push('A házszám nem lehet 0.');
  if (shipment.packages.length > 99) problems.push('A GLS legfeljebb 99 csomagot fogad egy feladásban.');
  if (shipment.pickupPointId) {
    // PSD (Parcel Shop Delivery) needs ContactName, ContactPhone and ContactEmail.
    if (!r.phone) problems.push('GLS csomagpontra csak a címzett telefonszámával adható fel csomag.');
    if (!r.email) problems.push('GLS csomagpontra csak a címzett e-mail címével adható fel csomag.');
  }
  const s = shipment.sender;
  if (!s.name || !s.zip || !s.city || !(s.street || s.address)) problems.push('Hiányos a feladó címe (Beállítások, Cégadatok vagy a GLS fiók feladó mezői).');
  return problems;
}

export function buildParcel(shipment, account) {
  const r = shipment.recipient;
  const s = shipment.sender;
  const services = serviceCodes(shipment, account).map((c) => ({ Code: c }));
  if (shipment.pickupPointId) {
    services.push({ Code: 'PSD', PSDParameter: { StringValue: shipment.pickupPointId } });
  } else {
    if (flag(account.settings, 'notify_email', true) && r.email) {
      services.push({ Code: 'FDS', FDSParameter: { Value: r.email } });
      if (flag(account.settings, 'notify_sms', false) && r.phone) services.push({ Code: 'FSS', FSSParameter: { Value: r.phone } });
    }
  }
  const parcel = {
    ClientNumber: Number(setting(account, 'client_number')),
    ClientReference: cut(shipment.orderNumber, 40),
    Count: shipment.packages.length,
    Content: cut(shipment.content || shipment.reference, 100),
    PickupAddress: address(s, { name: s.name, contactName: s.contactName || s.name, phone: s.phone, email: s.email }),
    DeliveryAddress: address(r, { name: r.company || r.name, contactName: r.name, phone: r.phone, email: r.email }),
    ServiceList: services,
    ParcelPropertyList: shipment.packages.map((p) => {
      const prop = { Content: cut(shipment.reference, 40), PackageType: 2, Weight: round(p.weightKg, 2) };
      if (p.lengthCm && p.widthCm && p.heightCm) Object.assign(prop, { Length: Math.round(p.lengthCm), Width: Math.round(p.widthCm), Height: Math.round(p.heightCm) });
      return prop;
    }),
  };
  if (shipment.cod) {
    parcel.CODAmount = shipment.cod.currency === 'HUF' ? Math.round(shipment.cod.amount) : round(shipment.cod.amount, 2);
    parcel.CODReference = cut(shipment.orderNumber, 40);
    parcel.CODCurrency = shipment.cod.currency;
  }
  return parcel;
}

const auth = async (account) => ({
  Username: String(account.credentials.username || ''),
  Password: await sha512Bytes(account.credentials.password || ''),
});

// WCF needs DateTime as "\/Date(ms)\/" with escaped slashes in the raw JSON text.
export const wcfDate = (ms) => `/Date(${ms})/`;
export const toWcfJson = (obj) => JSON.stringify(obj).replace(/"\/Date\((-?\d+)\)\/"/g, '"\\/Date($1)\\/"');

export async function buildPrintLabelsRequest(shipment, account) {
  return {
    url: `${baseUrl(account, URLS)}/ParcelService.svc/json/PrintLabels`,
    body: {
      ...(await auth(account)),
      WebshopEngine: WEBSHOP_ENGINE,
      ParcelList: [buildParcel(shipment, account)],
      PrintPosition: 1,
      ShowPrintDialog: false,
      TypeOfPrinter: setting(account, 'label_format', 'Thermo'),
    },
  };
}

// ---------------------------------------------------------------- response parsing

// Appendix A error codes in Hungarian; the GLS description is appended for the details.
const ERRORS = {
  1: 'Üres kérés.',
  7: 'Hiányzó csomagadatok.',
  8: 'Az utánvét összege nem lehet negatív.',
  11: 'Üres csomaglista.',
  12: 'Üres csomaglista.',
  13: 'A GLS hibásnak találta a csomag adatait.',
  14: 'Ismeretlen felhasználó: hibás MyGLS felhasználónév vagy jelszó.',
  15: 'A felhasználónak nincs joga ehhez a csomaghoz.',
  17: 'Nem készült csomagszám.',
  19: 'A GLS csomagszám generálása nem sikerült.',
  20: 'Nem készült csomagszám.',
  21: 'Nincs nyomtatható címke.',
  23: 'A házszám nem lehet 0.',
  27: 'A felhasználónak nincs joga ehhez az ügyfélszámhoz (ellenőrizd a GLS ügyfélszámot).',
  28: 'Biztosítás (INS) mellett csak 1 csomag adható fel.',
  29: 'A csomagok száma 1 és 99 között lehet.',
  30: 'Az SMS értesítés (FSS) csak e-mail értesítéssel (FDS) együtt kérhető.',
  31: 'Ugyanezt a kérést 5 percen belül ötször küldted el. Várj pár percet, és próbáld újra.',
  32: 'Kötelező az ügyfél hivatkozás (ClientReference).',
  33: 'Kötelező a csomag tartalmának megadása (Content).',
  34: 'Érvénytelen címkeformátum (TypeOfPrinter).',
  48: 'Érvénytelen utánvét pénznem.',
  1000: 'Váratlan hiba a GLS rendszerében.',
  1001: 'Belső hiba a GLS rendszerében.',
};
const AUTH_CODES = new Set([14, 15, 27]);

export function errorText(list) {
  return (list || []).map((e) => {
    const hu = ERRORS[e.ErrorCode];
    const desc = String(e.ErrorDescription || '').trim();
    if (hu && desc && !desc.toLowerCase().startsWith(hu.toLowerCase())) return `${hu} (${desc})`;
    return hu || desc || `GLS hibakód: ${e.ErrorCode}`;
  }).join(' ');
}

const toBytes = (labels) => {
  if (!labels) return null;
  if (Array.isArray(labels)) return Uint8Array.from(labels);
  if (typeof labels === 'string') return base64ToBytes(labels);
  return null;
};

export function parsePrintLabelsResponse(res) {
  if (res.status === 401) throw new CourierError('a GLS elutasította a belépési adatokat (HTTP 401). Ellenőrizd a MyGLS felhasználónevet és jelszót a Beállításokban.', { kind: 'auth', status: 401 });
  if (!res.ok) throw httpError(res, 'a GLS');
  const d = res.data;
  if (!d || typeof d !== 'object') throw new CourierError('a GLS válasza nem értelmezhető.', { kind: 'response', status: res.status });
  const errors = d.PrintLabelsErrorList || [];
  if (errors.length) {
    const kind = errors.some((e) => AUTH_CODES.has(e.ErrorCode)) ? 'auth' : errors.some((e) => e.ErrorCode >= 1000) ? 'unavailable' : 'rejected';
    throw new CourierError(errorText(errors), { kind });
  }
  const info = d.PrintLabelsInfoList || [];
  const parcelNumbers = [...new Set(info.map((i) => i.ParcelNumber).filter((n) => n !== undefined && n !== null && String(n) !== '0').map(String))];
  const label = toBytes(d.Labels);
  if (!parcelNumbers.length || !label || !label.length) throw new CourierError('a GLS nem adott vissza csomagszámot vagy címkét.', { kind: 'response' });
  return { trackingNumber: parcelNumbers[0], parcelNumbers, label, carrierIds: info.map((i) => i.ParcelId) };
}

// ---------------------------------------------------------------- operations

export async function createShipment(shipment, account, http) {
  const req = await buildPrintLabelsRequest(shipment, account);
  const res = await http('PrintLabels', req.url, { method: 'POST', json: req.body });
  return parsePrintLabelsResponse(res);
}

export async function testConnection(account, http) {
  const day = budapestDay();
  const body = toWcfJson({
    ...(await auth(account)),
    PrintDateFrom: wcfDate(budapestDayStartMs(day)),
    PrintDateTo: wcfDate(budapestDayStartMs(day, true)),
  });
  const res = await http('GetParcelList', `${baseUrl(account, URLS)}/ParcelService.svc/json/GetParcelList`, { method: 'POST', json: body });
  if (res.status === 401) return { ok: false, message: 'A GLS elutasította a belépési adatokat. Ellenőrizd a MyGLS felhasználónevet és jelszót.' };
  if (!res.ok || !res.data) return { ok: false, message: `A GLS nem válaszolt megfelelően (HTTP ${res.status}).` };
  const errors = res.data.GetParcelListErrors || [];
  if (errors.length) return { ok: false, message: `GLS: ${errorText(errors)}` };
  const n = (res.data.PrintDataInfoList || []).length;
  return { ok: true, message: `A GLS kapcsolat rendben. Ma eddig ${n} címke készült ebben a fiókban.` };
}

// Delivered status codes (Appendix G): 5 and 92 "The parcel has been delivered",
// 58 "delivered at the neighbour's". 54 (parcel box) and 55 (ParcelShop) mean the parcel waits
// for pickup, so they are not counted as delivered.
const DELIVERED = new Set([5, 58, 92]);

export async function trackDelivered(trackingNumbers, account, http) {
  const delivered = [];
  const credentials = await auth(account);
  for (const batch of chunks(trackingNumbers.filter((n) => /^\d+$/.test(n)), 100)) {
    const res = await http('GetParcelListStatuses', `${baseUrl(account, URLS)}/ParcelService.svc/json/GetParcelListStatuses`, {
      method: 'POST',
      json: { ...credentials, ParcelNumberList: batch.map(Number), LanguageIsoCode: 'HU' },
    });
    if (res.status === 401) throw new CourierError('a GLS elutasította a belépési adatokat.', { kind: 'auth', status: 401 });
    if (!res.ok || !res.data) throw httpError(res, 'a GLS');
    for (const p of res.data.ParcelList || []) {
      const hit = (p.ParcelStatusList || []).find((s) => DELIVERED.has(parseInt(s.StatusCode, 10)));
      if (hit) delivered.push({ trackingNumber: String(p.ParcelNumber), text: String(hit.StatusDescription || 'Kézbesítve').trim() });
    }
  }
  return { delivered };
}
