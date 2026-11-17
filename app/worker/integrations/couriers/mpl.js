// MPL (Magyar Posta): MPL API v2 (devportal.posta.hu; "MPL API v2 technikai leírás" V2.3,
// https://www.posta.hu/static/internet/download/MPLAPI_technikai_leiras.pdf, field list from V1.1
// https://devportal.posta.hu/sites/default/files/2020-11/MPLAPI_v2_technikai_leiras2.pdf, the
// examples in https://posta.hu/static/internet/download/mplapi_peldak.pdf and the integration guide
// https://www.posta.hu/static/internet/download/MPLAPI_integracios_javaslat_belfold.pdf, 2026.08.03).
//
//   Token:     POST {base}/oauth2/token  (Basic client_id:client_secret, grant_type=client_credentials)
//   Label:     POST {base}/v2/mplapi/shipments  with labelType: books the shipment and returns the
//              label as base64 PDF in the same answer.
//   Closing:   POST {base}/v2/mplapi/shipments/close  (mandatory once a day, see closeShipments)
//   Tracking:  POST {base}/v2/mplapi-tracking/tracking (up to 500 items, asynchronous), then
//              GET  {base}/v2/mplapi-tracking/tracking/{trackingGUID} at least a minute later
//   Test:      token + POST {base}/v2/mplapi/addresses/cityToZipCode
//   base:      https://core.api.posta.hu (production), https://sandbox.api.posta.hu (sandbox)
//   Headers:   Authorization: Bearer <token>, X-Accounting-Code: <vevőkód>, X-Request-ID: <GUID>
//
// Only domestic parcels are supported here (MPL Üzleti csomag A_175_UZL, MPL Postacsomag A_177_MPC).

import {
  CourierError, SENDER_FIELDS, TEST_MODE_FIELD, base64ToBytes, basicAuth, baseUrl, cut, httpError, isEmail, isHuMobile, isHuPhone,
  isPdf, setting, uuid,
} from './common.js';

export const code = 'mpl';
export const name = 'MPL (Magyar Posta)';

const URLS = { prod: 'https://core.api.posta.hu', test: 'https://sandbox.api.posta.hu' };
const DEVELOPER = 'Fully Logistics WMS';
const MODES = ['HA', 'PM', 'PP', 'CS', 'RA'];
const BASICS = ['A_175_UZL', 'A_177_MPC'];

export const credentialFields = [
  { key: 'client_id', label: 'API Key (client_id)', type: 'text', required: true, help: 'A devportal.posta.hu oldalon, bejelentkezés után látod. Sandbox és éles környezethez külön kulcs tartozik.' },
  { key: 'client_secret', label: 'API Secret (client_secret)', type: 'password', required: true },
];

export const settingFields = [
  { key: 'customer_code', label: 'Vevőkód', type: 'text', required: true, help: 'A Magyar Posta által adott vevőkód (X-Accounting-Code).' },
  { key: 'agreement', label: 'Megállapodáskód', type: 'text', required: true, help: 'A csomagfeladási szerződés megállapodáskódja (8 számjegy).' },
  { key: 'bank_account', label: 'Bankszámlaszám az utánvét utalásához', type: 'text', required: false, help: '16 vagy 24 számjegy. Ha üres, a posta a szerződés szerinti alapértelmezett számlára utal.' },
  {
    key: 'payment_mode', label: 'Utánvét kifizetése', type: 'select', required: false, default: 'UV_AT',
    options: [{ value: 'UV_AT', label: 'Átutalással (UV_AT)' }, { value: 'UV_KP', label: 'Készpénzben (UV_KP)' }],
  },
  TEST_MODE_FIELD('Bekapcsolva a sandbox.api.posta.hu tesztrendszert használjuk (külön sandbox kulcs kell hozzá).'),
  {
    key: 'label_format', label: 'Címke formátuma', type: 'select', required: false, default: 'A6',
    options: [
      { value: 'A6', label: 'A6 (címkenyomtató)' },
      { value: 'A6inA4', label: 'A6, A4 lapon' },
      { value: 'A5', label: 'A5' },
      { value: 'A5inA4', label: 'A5, A4 lapon' },
      { value: 'A5E', label: 'A5E' },
      { value: 'A4', label: 'A4' },
    ],
  },
  {
    key: 'default_service', label: 'Alapszolgáltatás', type: 'select', required: false, default: 'A_175_UZL',
    options: [{ value: 'A_175_UZL', label: 'MPL Üzleti csomag (A_175_UZL)' }, { value: 'A_177_MPC', label: 'MPL Postacsomag (A_177_MPC)' }],
  },
  {
    key: 'pickup_delivery_mode', label: 'Átvételi pont típusa, ha a rendelés nem mondja meg', type: 'select', required: false, default: 'CS',
    options: [{ value: 'CS', label: 'Csomagautomata (CS)' }, { value: 'PP', label: 'PostaPont (PP)' }, { value: 'PM', label: 'Postán maradó (PM)' }],
    help: 'A rendelés futárszolgáltatás mezője (HA, PM, PP, CS) felülírja. Az "automata" nevű pontokat csomagautomatának, a "posta" nevűeket postán maradónak vesszük.',
  },
  {
    key: 'package_retention', label: 'Őrzési idő (munkanap)', type: 'select', required: false, default: '5',
    options: [{ value: '5', label: '5 munkanap' }, { value: '10', label: '10 munkanap' }, { value: '0', label: '0 (csak házhoz kézbesítésnél)' }],
  },
  {
    key: 'default_size', label: 'Csomagméret csomagautomatához', type: 'select', required: false, default: 'M',
    options: [{ value: 'S', label: 'S (31x25x7 cm)' }, { value: 'M', label: 'M (50x31x16 cm)' }, { value: 'L', label: 'L (50x31x35 cm)' }],
    help: 'Automatába címzett csomagnál kötelező. Csomagonként felülírható a címkekészítéskor (size).',
  },
  { key: 'tag', label: 'Címke (tag) a záráshoz', type: 'text', required: false, default: 'fully-wms', help: 'A szállítmányokat ezzel jelöljük, a napi zárás erre is szűrhető.' },
  ...SENDER_FIELDS,
];

export const requiredCredentials = ['client_id', 'client_secret'];
export const requiredSettings = ['customer_code', 'agreement'];

export const features = { cod: true, pickupPoints: true, tracking: true, testMode: true, closeRequired: true };

export const trackingUrl = (n) => `https://www.posta.hu/nyomkovetes/nyitooldal?searchvalue=${encodeURIComponent(n)}`;

// ---------------------------------------------------------------- token

// Tokens are valid for 3600 seconds (expires_in); cached per isolate and refreshed a minute early.
const tokens = new Map();

export const clearTokenCache = () => tokens.clear();

async function token(account, http, { refresh = false } = {}) {
  const url = `${baseUrl(account, URLS)}/oauth2/token`;
  const id = String(account.credentials.client_id || '');
  const key = `${url}|${id}`;
  const cached = tokens.get(key);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.token;
  const res = await http('oauth2/token', url, {
    method: 'POST',
    headers: { authorization: basicAuth(id, account.credentials.client_secret || '') },
    form: { grant_type: 'client_credentials' },
  });
  if (!res.ok || !res.data || !res.data.access_token) {
    tokens.delete(key);
    const fault = faultText(res.data);
    if (res.status === 401 || res.status === 400) throw new CourierError(`az MPL elutasította az API kulcsot vagy a titkot${fault ? ` (${fault})` : ''}. Sandbox és éles környezethez külön kulcs kell.`, { kind: 'auth', status: res.status });
    throw httpError(res, 'az MPL', fault);
  }
  const ttl = Math.max(60, parseInt(res.data.expires_in, 10) || 1800);
  tokens.set(key, { token: res.data.access_token, expiresAt: Date.now() + (ttl - 60) * 1000 });
  return res.data.access_token;
}

const faultText = (d) => (d && d.fault ? String(d.fault.faultstring || '') : '');

// Business call with the token; on 401 the token is renewed once.
async function call(account, http, action, path, opts = {}) {
  const url = `${baseUrl(account, URLS)}${path}`;
  const send = async (t) => http(action, url, {
    ...opts,
    headers: { authorization: `Bearer ${t}`, 'x-accounting-code': String(setting(account, 'customer_code')), 'x-request-id': uuid(), ...(opts.headers || {}) },
  });
  let res = await send(await token(account, http));
  if (res.status === 401) res = await send(await token(account, http, { refresh: true }));
  return res;
}

// ---------------------------------------------------------------- request building

const words = (s) => String(s || '').toUpperCase().split(/[\s,;]+/).filter(Boolean);

export function deliveryMode(shipment, account) {
  const fromOrder = words(shipment.service).find((w) => MODES.includes(w));
  if (fromOrder) return fromOrder;
  if (!shipment.pickupPointId) return 'HA';
  const p = String(shipment.pickupPointId);
  if (/automata/i.test(p)) return 'CS';
  if (/\bposta\b/i.test(p) && !/postapont/i.test(p)) return 'PM';
  return setting(account, 'pickup_delivery_mode', 'CS');
}

export function basicService(shipment, account) {
  return words(shipment.service).find((w) => BASICS.includes(w)) || setting(account, 'default_service', 'A_175_UZL');
}

export function validate(shipment, account) {
  const r = shipment.recipient;
  const mode = deliveryMode(shipment, account);
  const basic = basicService(shipment, account);
  const problems = [];
  if (String(r.country || 'HU').toUpperCase() !== 'HU') problems.push('Az MPL integráció csak belföldi csomagot ad fel.');
  if (!r.zip || !r.city || !r.address) problems.push('A címzett címe hiányos (irányítószám, település, cím).');
  if (r.phone && !isHuPhone(r.phone)) problems.push(`Az MPL magyar telefonszámot kér, a megadott szám: ${r.phone}.`);
  if (r.email && !isEmail(r.email)) problems.push(`Hibás e-mail cím: ${r.email}.`);
  if (['PM', 'PP', 'CS'].includes(mode) && !shipment.pickupPointId) problems.push('Átvételi ponthoz (posta, PostaPont, automata) add meg az átvételi pontot.');
  if (mode === 'CS') {
    if (!isHuMobile(r.phone)) problems.push('Csomagautomatához kötelező a címzett magyar mobilszáma.');
    if (!r.email) problems.push('Csomagautomatához kötelező a címzett e-mail címe.');
    if (shipment.packages.length > 1) problems.push('Csomagautomatába csak egy csomag adható fel egy szállítmányban.');
    if (shipment.cod && shipment.cod.amount > 500000) problems.push('Csomagautomatánál az utánvét legfeljebb 500 000 Ft lehet.');
  }
  if (basic === 'A_177_MPC') {
    if (['PP', 'CS', 'RA'].includes(mode)) problems.push('MPL Postacsomag nem kézbesíthető PostaPontra, automatába vagy raklapon.');
    if (shipment.packages.length > 1) problems.push('MPL Postacsomagnál egy szállítmányban egy csomag lehet.');
  }
  if (shipment.packages.length > 16) problems.push('Egy MPL szállítmányban legfeljebb 16 csomag lehet.');
  if (shipment.cod) {
    if (shipment.cod.currency !== 'HUF') problems.push('MPL utánvét csak forintban lehet.');
    else if (shipment.cod.amount > 2000000) problems.push('Az MPL utánvét legfeljebb 2 000 000 Ft lehet.');
  }
  const s = shipment.sender;
  if (!s.name || !s.zip || !s.city || !s.address) problems.push('Hiányos a feladó címe (Beállítások, Cégadatok vagy az MPL fiók feladó mezői).');
  return problems;
}

export function buildShipmentRequest(shipment, account) {
  const r = shipment.recipient;
  const s = shipment.sender;
  const mode = deliveryMode(shipment, account);
  const basic = basicService(shipment, account);
  const cod = shipment.cod ? Math.round(shipment.cod.amount) : 0;
  const sender = {
    agreement: String(setting(account, 'agreement')),
    contact: { name: cut(s.contactName || s.name, 100), email: cut(s.email, 100) || undefined, phone: s.phone || undefined },
    address: { postCode: String(s.zip).trim(), city: cut(s.city, 60), address: cut(s.address, 100) },
  };
  const bank = String(setting(account, 'bank_account', '')).replace(/\D/g, '');
  if (bank) sender.accountNo = bank;
  const recipient = {
    contact: { name: cut(r.name, 100), email: cut(r.email, 100) || undefined, phone: r.phone || undefined },
    address: { postCode: String(r.zip).trim(), city: cut(r.city, 60), address: cut(r.address, 100) },
  };
  if (r.company) recipient.contact.organization = cut(r.company, 100);
  if (shipment.pickupPointId && mode !== 'HA' && mode !== 'RA') recipient.address.parcelPickupSite = cut(shipment.pickupPointId, 100);

  const items = shipment.packages.map((p, i) => {
    const extra = ['K_ORZ'];
    const services = { basic, extra, deliveryMode: mode };
    if (i === 0 && cod > 0) {
      extra.push('K_UVT', 'K_ENY');
      services.cod = cod;
      services.value = cod;
    }
    const item = {
      customData1: cut(shipment.orderNumber, 40),
      customData2: cut(shipment.reference !== shipment.orderNumber ? shipment.reference : '', 40) || undefined,
      weight: { value: Math.max(1, Math.round(p.weightKg * 1000)), unit: 'G' },
      services,
    };
    if (mode === 'CS' || p.size) item.size = String(p.size || setting(account, 'default_size', 'M')).toUpperCase();
    return item;
  });

  const body = [{
    developer: DEVELOPER,
    webshopId: cut(shipment.orderNumber, 100),
    orderId: cut(shipment.orderNumber, 50),
    labelType: setting(account, 'label_format', 'A6'),
    tag: cut(setting(account, 'tag', 'fully-wms'), 50),
    sender,
    recipient,
    item: items,
    paymentMode: setting(account, 'payment_mode', 'UV_AT'),
    packageRetention: Number(setting(account, 'package_retention', '5')),
  }];
  if (items.length > 1) body[0].groupTogether = true;
  return { path: '/v2/mplapi/shipments', body: JSON.parse(JSON.stringify(body)) };
}

// ---------------------------------------------------------------- response parsing

const describe = (e) => {
  const text = String(e.text || e.text_eng || e.message || '').trim();
  const where = e.parameter ? ` (${e.parameter})` : '';
  return text ? `${text}${where}` : `MPL hibakód ${e.code}${where}`;
};

export function parseShipmentResponse(res, webshopId) {
  const d = res.data;
  const list = Array.isArray(d) ? d : d && Array.isArray(d.shipments) ? d.shipments : null;
  if (!res.ok && !list) {
    if (res.status === 401) throw new CourierError(`az MPL elutasította a hozzáférést (HTTP 401)${faultText(d) ? `: ${faultText(d)}` : ''}.`, { kind: 'auth', status: 401 });
    const detail = faultText(d) || (d && Array.isArray(d.errors) ? d.errors.map(describe).join(' ') : '') || (d && d.message) || '';
    throw httpError(res, 'az MPL', detail);
  }
  const result = list ? list.find((x) => x && String(x.webshopId) === String(webshopId)) || list[0] : null;
  if (!result) throw new CourierError('az MPL válasza nem értelmezhető.', { kind: 'response' });
  const errors = result.errors || [];
  if (errors.length) throw new CourierError(errors.map(describe).join(' '), { kind: 'rejected' });
  if (!result.trackingNumber || !result.label) throw new CourierError('az MPL nem adott vissza ragszámot vagy címkét.', { kind: 'response' });
  const label = base64ToBytes(result.label);
  if (!isPdf(label)) throw new CourierError('az MPL címkéje nem PDF.', { kind: 'response' });
  return {
    trackingNumber: String(result.trackingNumber),
    parcelNumbers: (result.packageTrackingNumbers && result.packageTrackingNumbers.length ? result.packageTrackingNumbers : [result.trackingNumber]).map(String),
    label,
    warnings: (result.warnings || []).map(describe),
    carrierIds: [String(result.trackingNumber)],
  };
}

// ---------------------------------------------------------------- operations

export async function createShipment(shipment, account, http) {
  const req = buildShipmentRequest(shipment, account);
  const res = await call(account, http, 'shipments', req.path, { method: 'POST', json: req.body });
  return parseShipmentResponse(res, req.body[0].webshopId);
}

export async function testConnection(account, http) {
  try {
    const res = await call(account, http, 'addresses/cityToZipCode', '/v2/mplapi/addresses/cityToZipCode', { method: 'POST', json: { city: 'Alsónémedi' } });
    if (res.status === 401 || res.status === 403) return { ok: false, message: `Az MPL elutasította a hozzáférést (HTTP ${res.status})${faultText(res.data) ? `: ${faultText(res.data)}` : ''}.` };
    if (!res.ok) return { ok: false, message: `Az MPL nem válaszolt megfelelően (HTTP ${res.status}).` };
    return { ok: true, message: 'Az MPL kapcsolat rendben, a token és a vevőkód elfogadva.' };
  } catch (err) {
    if (err instanceof CourierError) return { ok: false, message: `MPL: ${err.message}` };
    throw err;
  }
}

// Daily closing (zárás): without it the post office cannot process the parcels. Returns the
// manifest PDFs (feladójegyzék) MPL sends back.
export async function closeShipments(account, http, { trackingNumbers = [] } = {}) {
  const body = { checkList: true };
  if (trackingNumbers.length) body.trackingNumbers = trackingNumbers;
  else body.tag = setting(account, 'tag', 'fully-wms');
  const res = await call(account, http, 'shipments/close', '/v2/mplapi/shipments/close', { method: 'POST', json: body });
  const d = res.data;
  const list = Array.isArray(d) ? d : d ? [d] : [];
  if (!res.ok) throw httpError(res, 'az MPL', faultText(d) || list.flatMap((x) => x.errors || []).map(describe).join(' '));
  const errors = list.flatMap((x) => x.errors || []);
  if (errors.length) throw new CourierError(errors.map(describe).join(' '), { kind: 'rejected' });
  return {
    manifests: list.filter((x) => x.manifest).map((x) => base64ToBytes(x.manifest)),
    prices: list.flatMap((x) => x.trackingNrPrices || []),
  };
}

// The report arrives as a JSON array, or (as in the documentation example) as a string of
// comma separated objects without brackets.
export function parseTrackingReport(report) {
  if (!report) return [];
  if (Array.isArray(report)) return report;
  if (typeof report === 'object') return [report];
  const s = String(report).trim();
  for (const candidate of [s, `[${s}]`]) {
    try {
      const v = JSON.parse(candidate);
      return Array.isArray(v) ? v : [v];
    } catch {
      // try the next form
    }
  }
  return [];
}

// "Kézbesített" category events that mean the recipient got the parcel. "Feladónak
// visszakézbesítve" (returned to sender) is not delivery.
export const isDeliveredEvent = (text) => {
  const t = String(text || '').trim();
  return t.startsWith('Sikeresen kézbesítve') || t === 'Sikeres kézbesítés rögzítése belső rendszerben' || t.startsWith('Árufizetési összeg feladónak kifizetve');
};

// Asynchronous: one run submits the numbers and keeps the trackingGUID in state, a later run
// (the API asks for at least a minute between calls) fetches the report.
export async function trackDelivered(trackingNumbers, account, http, state = {}) {
  const delivered = [];
  if (state.guid) {
    const res = await call(account, http, 'tracking/result', `/v2/mplapi-tracking/tracking/${encodeURIComponent(state.guid)}`, {});
    if (res.ok && res.data && String(res.data.status).toUpperCase() === 'READY') {
      for (const row of parseTrackingReport(res.data.report)) {
        if (isDeliveredEvent(row.last_event_type)) delivered.push({ trackingNumber: String(row.item_identifier).trim(), text: String(row.last_event_type).trim() });
      }
      return { delivered, state: {} };
    }
    const age = Date.now() - Date.parse(state.requestedAt || 0);
    if (res.ok && age < 60 * 60 * 1000) return { delivered, state };
    // Failed or stuck for an hour: ask again below.
  }
  const numbers = trackingNumbers.slice(0, 500);
  if (!numbers.length) return { delivered, state: {} };
  const res = await call(account, http, 'tracking', '/v2/mplapi-tracking/tracking', { method: 'POST', json: { trackingNumbers: numbers, language: 'HU' } });
  if (!res.ok || !res.data || !res.data.trackingGUID) throw httpError(res, 'az MPL', faultText(res.data));
  return { delivered, state: { guid: res.data.trackingGUID, requestedAt: new Date().toISOString(), count: numbers.length } };
}

