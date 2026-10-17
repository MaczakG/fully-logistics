// DPD Hungary: DPD Shipping API (NST Shipment API v1.1), the API DPD Hungary recommends for own
// systems (https://www.dpd.com/hu/en/support/integration/), documented at
// https://nst-preprod.dpsin.dpdgroup.com/api/docs/ (Shipping API V1.1).
//
//   Label:  POST {base}/shipments  with saveMode "printed": books the shipment, assigns parcel
//           numbers and returns the label (labelFile, a base64 data URL) in the same answer.
//   Test:   GET  {base}/routing/postcode-validation?countryCode=HU&postcode=2351 (authenticated)
//   base:   https://shipping.dpdgroup.com/api/v1.1 (PROD), https://nst-preprod.dpsin.dpdgroup.com/api/v1.1 (PREPROD)
//   Auth:   Authorization: Bearer <JWT token issued by DPD>
//
// Tracking: the Shipping API has no delivery status call (GET /shipments/{id} only knows
// draft/printed/cancelled). DPD Hungary offers delivery statuses as hourly Statusdata files over
// FTP, which a Worker cannot fetch, so DPD orders are not marked delivered automatically.

import {
  CourierError, TEST_MODE_FIELD, base64ToBytes, baseUrl, cut, flag, httpError, round, setting, splitPhone,
} from './common.js';

export const code = 'dpd';
export const name = 'DPD';

const URLS = { prod: 'https://shipping.dpdgroup.com/api/v1.1', test: 'https://nst-preprod.dpsin.dpdgroup.com/api/v1.1' };

export const credentialFields = [
  { key: 'api_token', label: 'DPD Shipping API token (JWT)', type: 'password', required: true, help: 'A DPD Hungary által kiadott JWT hozzáférési token. Titkosítva tároljuk.' },
];

export const settingFields = [
  { key: 'customer_id', label: 'DPD ügyfélazonosító (customerId)', type: 'text', required: true, help: 'A DPD Shipping rendszerben használt ügyfélazonosító.' },
  { key: 'sender_address_id', label: 'Feladási cím azonosító (senderAddressId)', type: 'number', required: true, help: 'A raktár (felvételi cím) azonosítója a DPD Shipping rendszerben. A feladó címét a DPD ehhez az azonosítóhoz tárolja.' },
  { key: 'bu_code', label: 'Business Unit kód (buCode)', type: 'text', required: false, help: 'Csak akkor töltsd ki, ha a DPD kéri.' },
  TEST_MODE_FIELD('Bekapcsolva a DPD PREPROD tesztrendszerét használjuk.'),
  {
    key: 'label_format', label: 'Címke mérete', type: 'select', required: false, default: 'A6',
    options: [{ value: 'A6', label: 'A6 (címkenyomtató)' }, { value: 'A4', label: 'A4' }],
  },
  { key: 'default_service', label: 'Szolgáltatáskód házhoz szállításhoz (mainServiceCode)', type: 'text', required: false, default: '101', help: 'A DPD által a szerződéshez megadott fő szolgáltatáskód. A rendelés futárszolgáltatás mezőjében megadott szám felülírja.' },
  { key: 'pudo_service', label: 'Szolgáltatáskód csomagponthoz (mainServiceCode)', type: 'text', required: false, default: '337', help: 'Csomagpontos (Pickup) kézbesítés fő szolgáltatáskódja, a DPD adja meg.' },
  { key: 'predict', label: 'Predict értesítés a címzettnek (e-mail, SMS)', type: 'checkbox', required: false, default: true, help: 'A DPD értesíti a címzettet a várható kézbesítésről. Csak akkor kapcsold ki, ha a szerződésed nem tartalmazza.' },
];

export const requiredCredentials = ['api_token'];
export const requiredSettings = ['customer_id', 'sender_address_id'];

export const features = { cod: true, pickupPoints: true, tracking: false, testMode: true, closeRequired: false };

export const trackingUrl = (n) => `https://www.dpdgroup.com/hu/mydpd/my-parcels/search?parcelNumber=${encodeURIComponent(n)}`;

// ---------------------------------------------------------------- request building

const zip = (z) => String(z || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, 9);

export function validate(shipment) {
  const r = shipment.recipient;
  const problems = [];
  if (!r.zip || !r.city || !(r.street || r.address)) problems.push('A címzett címe hiányos (irányítószám, település, utca).');
  if (!r.phone && !r.email) problems.push('A DPD-hez add meg a címzett telefonszámát vagy e-mail címét.');
  return problems;
}

export function buildShipmentRequest(shipment, account) {
  const r = shipment.recipient;
  const phone = splitPhone(r.phone);
  // houseNo holds 8 characters: "12/B" fits, "12, 3. em. 5." goes as 12 + additionalAddressInfo.
  const joined = `${r.houseNumber}${r.houseInfo}`;
  const short = r.houseInfo && /^[/\-A-Za-z]/.test(r.houseInfo) && joined.length <= 8;
  const receiver = {
    name: cut(r.name, 35),
    companyName: cut(r.company, 35) || undefined,
    street: cut(r.street || r.address, 35),
    houseNo: cut(short ? joined : r.houseNumber, 8) || undefined,
    additionalAddressInfo: !short && r.houseInfo ? cut(r.houseInfo, 35) : undefined,
    city: cut(r.city, 35),
    zipCode: zip(r.zip),
    countryCode: String(r.country || 'HU').toUpperCase(),
    contactName: cut(r.name, 35),
    contactPhonePrefix: phone.prefix || undefined,
    contactPhone: cut(phone.number, 30) || undefined,
    contactMobilePrefix: phone.prefix || undefined,
    contactMobile: cut(phone.number, 30) || undefined,
    contactEmail: cut(r.email, 100) || undefined,
  };

  const orderService = /^\d{3}$/.test(String(shipment.service || '').trim()) ? String(shipment.service).trim() : '';
  const mainServiceCode = orderService || (shipment.pickupPointId ? setting(account, 'pudo_service', '337') : setting(account, 'default_service', '101'));

  const additionalService = {};
  if (shipment.cod) {
    additionalService.cod = {
      amount: shipment.cod.currency === 'HUF' ? Math.round(shipment.cod.amount) : round(shipment.cod.amount, 2),
      currency: shipment.cod.currency,
      paymentType: 'Cash',
      reference: cut(shipment.orderNumber, 14),
      split: 'First parcel',
    };
  }
  if (shipment.pickupPointId) additionalService.pudoId = cut(shipment.pickupPointId, 20);
  if (flag(account.settings, 'predict', true)) {
    const predicts = [];
    if (r.email) predicts.push({ type: 'email', destination: cut(r.email, 100), language: 'HU' });
    if (r.phone) predicts.push({ type: 'SMS', destination: r.phone, language: 'HU' });
    if (predicts.length) additionalService.predicts = predicts;
  }

  const body = {
    customerId: String(setting(account, 'customer_id')),
    shipments: [{
      numOrder: 1,
      senderAddressId: Number(setting(account, 'sender_address_id')),
      receiver,
      parcels: shipment.packages.map((p, i) => {
        const parcel = { weight: round(p.weightKg, 2), reference1: cut(i ? `${shipment.orderNumber}/${i + 1}` : shipment.orderNumber, 35) };
        if (p.lengthCm && p.widthCm && p.heightCm) Object.assign(parcel, { dimensionLength: Math.round(p.lengthCm), dimensionWidth: Math.round(p.widthCm), dimensionHeight: Math.round(p.heightCm) });
        return parcel;
      }),
      service: { mainServiceCode, ...(Object.keys(additionalService).length ? { additionalService } : {}) },
      reference1: cut(shipment.orderNumber, 35),
      reference2: cut(shipment.reference !== shipment.orderNumber ? shipment.reference : '', 35) || undefined,
      saveMode: 'printed',
      printFormat: 'pdf',
      labelSize: setting(account, 'label_format', 'A6'),
    }],
  };
  const bu = setting(account, 'bu_code', '');
  if (bu) body.buCode = String(bu);
  return { url: `${baseUrl(account, URLS)}/shipments`, body: JSON.parse(JSON.stringify(body)) };
}

const headers = (account) => ({ authorization: `Bearer ${account.credentials.api_token || ''}` });

// ---------------------------------------------------------------- response parsing

// 400 answers are either a map of field -> message ({"create...sender.contact": "At least one ..."})
// or lists of { errorCode, errorContent | errorText, errorField }.
export function errorText(data) {
  if (!data) return '';
  if (Array.isArray(data)) {
    return data.map((e) => (typeof e === 'string' ? e : [e.errorContent || e.errorText || e.content || e.message, e.errorField || e.field ? `(${e.errorField || e.field})` : ''].filter(Boolean).join(' '))).filter(Boolean).join(' ');
  }
  if (typeof data === 'object') {
    if (Array.isArray(data.errors)) return errorText(data.errors);
    if (Array.isArray(data.messages)) return errorText(data.messages);
    if (data.message || data.error) return String(data.message || data.error);
    return Object.entries(data).filter(([, v]) => typeof v === 'string').map(([k, v]) => `${v} (${k.split('.').slice(-2).join('.')})`).join(' ');
  }
  return String(data);
}

export function parseShipmentResponse(res) {
  if (res.status === 401) throw new CourierError('a DPD elutasította az API tokent (HTTP 401). Ellenőrizd vagy kérj újat a DPD-től.', { kind: 'auth', status: 401 });
  if (!res.ok) throw httpError(res, 'a DPD', errorText(res.data) || res.text.slice(0, 300));
  const result = res.data && Array.isArray(res.data.shipmentResults) ? res.data.shipmentResults[0] : null;
  if (!result) throw new CourierError('a DPD válasza nem értelmezhető.', { kind: 'response' });
  const errors = (result.errors || []).filter((e) => e && (e.errorCode || e.errorContent));
  if (errors.length) throw new CourierError(errorText(errors), { kind: 'rejected' });
  const parcels = result.parcelResults && result.parcelResults.length ? result.parcelResults : (result.shipment && result.shipment.parcels) || [];
  const parcelNumbers = parcels.map((p) => p.parcelNumber).filter(Boolean).map(String);
  const trackingNumber = parcelNumbers[0] || result.mpsId || (result.shipment && result.shipment.mpsId) || '';
  if (!trackingNumber || !result.labelFile) throw new CourierError('a DPD nem adott vissza csomagszámot vagy címkét.', { kind: 'response' });
  return {
    trackingNumber: String(trackingNumber),
    parcelNumbers: parcelNumbers.length ? parcelNumbers : [String(trackingNumber)],
    label: base64ToBytes(result.labelFile),
    carrierIds: [result.shipmentId || (result.shipment && result.shipment.shipmentId)].filter(Boolean),
  };
}

// ---------------------------------------------------------------- operations

export async function createShipment(shipment, account, http) {
  const req = buildShipmentRequest(shipment, account);
  const res = await http('shipments', req.url, { method: 'POST', headers: headers(account), json: req.body });
  return parseShipmentResponse(res);
}

export async function testConnection(account, http) {
  const res = await http('postcode-validation', `${baseUrl(account, URLS)}/routing/postcode-validation?countryCode=HU&postcode=2351`, { headers: headers(account) });
  if (res.status === 401 || res.status === 403) return { ok: false, message: `A DPD elutasította az API tokent (HTTP ${res.status}).` };
  if (!res.ok) return { ok: false, message: `A DPD nem válaszolt megfelelően (HTTP ${res.status}).` };
  return { ok: true, message: 'A DPD kapcsolat rendben, a token érvényes.' };
}
