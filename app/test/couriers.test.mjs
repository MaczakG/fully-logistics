// Courier adapters as pure functions, without the Worker: the exact requests each adapter sends
// and how it reads success and error answers. Responses follow the examples of the carriers'
// documentation (see the header of each adapter file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as common from '../worker/integrations/couriers/common.js';
import * as gls from '../worker/integrations/couriers/gls.js';
import * as dpd from '../worker/integrations/couriers/dpd.js';
import * as foxpost from '../worker/integrations/couriers/foxpost.js';
import * as mpl from '../worker/integrations/couriers/mpl.js';
import * as dhl from '../worker/integrations/couriers/dhl.js';
import { listCouriers, trackingUrl } from '../worker/integrations/couriers/index.js';

const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n');
const PDF_B64 = Buffer.from(PDF).toString('base64');

// Fake fetch: answers with handler(url, init) -> { status, json | body, type } and records calls.
function fakeHttp(handler) {
  const calls = [];
  const logs = [];
  const fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body };
    calls.push(call);
    const r = (await handler(call)) || { status: 404, json: {} };
    const body = r.json !== undefined ? JSON.stringify(r.json) : r.body;
    return new Response(body, { status: r.status || 200, headers: { 'content-type': r.type || (r.json !== undefined ? 'application/json' : 'application/octet-stream') } });
  };
  const http = common.makeHttp({ fetch, log: async (e) => { logs.push(e); } });
  return { http, calls, logs };
}

const jsonBody = (call) => JSON.parse(call.body);

const shipment = (over = {}) => ({
  orderId: 7,
  orderNumber: 'R-2026-000007',
  reference: '#1007',
  content: 'R-2026-000007 (#1007)',
  recipient: {
    name: 'Minta Mária', company: '', email: 'maria@example.com', phone: '+36301234567', country: 'HU',
    zip: '1111', city: 'Budapest', address: 'Fő utca 12/B', street: 'Fő utca', houseNumber: '12', houseInfo: '/B',
    ...(over.recipient || {}),
  },
  sender: {
    name: 'Fully Logistics', contactName: 'Fully Logistics', email: 'raktar@fully.hu', phone: '+3612345678', country: 'HU',
    zip: '2351', city: 'Alsónémedi', address: 'Depó út 14', street: 'Depó út', houseNumber: '14', houseInfo: '',
    ...(over.sender || {}),
  },
  pickupPointId: '',
  service: '',
  cod: null,
  packages: [{ weightKg: 2.5, lengthCm: 40, widthCm: 30, heightCm: 20, size: '' }],
  totalWeightKg: 2.5,
  shipDate: '2026-10-16',
  ...Object.fromEntries(Object.entries(over).filter(([k]) => !['recipient', 'sender'].includes(k))),
});

const account = (settings = {}, credentials = {}) => ({ active: true, settings, credentials });

// ---------------------------------------------------------------- common

test('common: street split, phone normalisation, Budapest time, base URL override', () => {
  assert.deepEqual(common.splitStreet('Európa u. 2/b'), { street: 'Európa u.', houseNumber: '2', houseInfo: '/b' });
  assert.deepEqual(common.splitStreet('Váci út 12-14. 3. em. 5.'), { street: 'Váci út', houseNumber: '12', houseInfo: '-14. 3. em. 5.' });
  assert.deepEqual(common.splitStreet('Május 1. utca 5'), { street: 'Május 1. utca', houseNumber: '5', houseInfo: '' });
  assert.deepEqual(common.splitStreet('Hauptstraße 5'), { street: 'Hauptstraße', houseNumber: '5', houseInfo: '' });
  assert.equal(common.normalizePhone('06 30 123 4567'), '+36301234567');
  assert.equal(common.normalizePhone('30/123-4567'), '+36301234567');
  assert.equal(common.normalizePhone('0905123456', 'SK'), '+421905123456');
  assert.ok(common.isHuMobile('+36701234567'));
  assert.ok(!common.isHuMobile('+3612345678'));
  assert.equal(common.budapestDateTimeGmt(new Date('2026-10-16T13:30:00Z')), '2026-10-16T15:30:00 GMT+02:00');
  assert.equal(common.budapestDateTimeGmt(new Date('2026-01-16T13:30:00Z')), '2026-01-16T14:30:00 GMT+01:00');
  const urls = { prod: 'https://prod.example', test: 'https://test.example' };
  assert.equal(common.baseUrl(account({}), urls), 'https://prod.example');
  assert.equal(common.baseUrl(account({ test_mode: true }), urls), 'https://test.example');
  assert.equal(common.baseUrl(account({ api_base_url: 'http://127.0.0.1:9999/' }), urls), 'http://127.0.0.1:9999');
  // Never an outside host, so a stored setting cannot send credentials elsewhere.
  assert.equal(common.baseUrl(account({ api_base_url: 'https://evil.example' }), urls), 'https://prod.example');
});

test('common: network errors become CourierError, every call is logged without bodies', async () => {
  const logs = [];
  const http = common.makeHttp({ fetch: async () => { throw new TypeError('connect ECONNREFUSED'); }, log: async (e) => logs.push(e) });
  await assert.rejects(http('x', 'https://api.example/path?a=1', { method: 'POST', json: { password: 'titok' } }), (e) => e instanceof common.CourierError && e.kind === 'unavailable');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].ok, false);
  assert.ok(!JSON.stringify(logs).includes('titok'));
});

test('listCouriers: five carriers with Hungarian field definitions, tracking URLs', () => {
  const list = listCouriers();
  assert.deepEqual(list.map((c) => c.code), ['gls', 'dpd', 'foxpost', 'mpl', 'dhl']);
  for (const c of list) {
    assert.ok(c.name && c.credentialFields.length && c.settingFields.length);
    for (const f of [...c.credentialFields, ...c.settingFields]) {
      assert.ok(['text', 'password', 'select', 'number', 'checkbox'].includes(f.type), `${c.code}.${f.key}`);
      assert.ok(f.label && typeof f.required === 'boolean', `${c.code}.${f.key}`);
      if (f.type === 'select') assert.ok(Array.isArray(f.options) && f.options.length, `${c.code}.${f.key}`);
    }
    assert.ok(c.settingFields.some((f) => f.key === 'test_mode'), c.code);
    assert.ok(c.settingFields.some((f) => f.key === 'label_format'), c.code);
    assert.ok(!c.settingFields.some((f) => f.key === 'api_base_url'), 'test hook stays hidden');
  }
  assert.equal(trackingUrl('gls', '00123456789'), 'https://gls-group.com/HU/hu/csomagkovetes?match=00123456789');
  assert.equal(trackingUrl('foxpost', 'CLFOX0000000001'), 'https://foxpost.hu/csomagkovetes/?code=CLFOX0000000001');
  assert.equal(trackingUrl('mpl', 'PNAAA50069529'), 'https://www.posta.hu/nyomkovetes/nyitooldal?searchvalue=PNAAA50069529');
  assert.match(trackingUrl('dpd', '05910000000004'), /dpdgroup\.com\/hu\/mydpd\/my-parcels\/search\?parcelNumber=05910000000004$/);
  assert.match(trackingUrl('dhl', '5374534546'), /tracking-id=5374534546/);
  assert.equal(trackingUrl('other', '123'), '');
  assert.equal(trackingUrl('gls', ''), '');
});

// ---------------------------------------------------------------- GLS

const glsAccount = (settings = {}) => account({ client_number: '100000001', label_format: 'A4_2x2', ...settings }, { username: 'api@fully.hu', password: '1pImY_gls.hu' });

test('GLS: PrintLabels request for a COD home delivery', async () => {
  const s = shipment({ cod: { amount: 12990, currency: 'HUF' }, packages: [{ weightKg: 2.5 }, { weightKg: 1.25, lengthCm: 30, widthCm: 20, heightCm: 10 }] });
  const { http, calls } = fakeHttp(() => ({ json: { Labels: Array.from(PDF), PrintLabelsErrorList: [], PrintLabelsInfoList: [{ ClientReference: 'R-2026-000007', ParcelId: 1, ParcelNumber: 51001234567 }, { ClientReference: 'R-2026-000007', ParcelId: 1, ParcelNumber: 51001234568 }] } }));
  const out = await gls.createShipment(s, glsAccount({ test_mode: true }), http);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.test.mygls.hu/ParcelService.svc/json/PrintLabels');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['content-type'], 'application/json');
  const body = jsonBody(calls[0]);
  assert.equal(body.Username, 'api@fully.hu');
  // Password: SHA-512 of the password as a byte array (MyGLS API, APIRequestBase).
  assert.deepEqual(body.Password, Array.from(createHash('sha512').update('1pImY_gls.hu').digest()));
  assert.equal(body.WebshopEngine, 'Fully Logistics WMS');
  assert.equal(body.TypeOfPrinter, 'A4_2x2');
  assert.equal(body.PrintPosition, 1);
  assert.equal(body.ShowPrintDialog, false);
  const p = body.ParcelList[0];
  assert.equal(p.ClientNumber, 100000001);
  assert.equal(p.ClientReference, 'R-2026-000007');
  assert.equal(p.Count, 2);
  assert.equal(p.CODAmount, 12990);
  assert.equal(p.CODReference, 'R-2026-000007');
  assert.equal(p.CODCurrency, 'HUF');
  assert.deepEqual(p.DeliveryAddress, {
    Name: 'Minta Mária', Street: 'Fő utca', HouseNumber: '12', HouseNumberInfo: '/B', City: 'Budapest', ZipCode: '1111', CountryIsoCode: 'HU',
    ContactName: 'Minta Mária', ContactPhone: '+36301234567', ContactEmail: 'maria@example.com',
  });
  assert.equal(p.PickupAddress.Name, 'Fully Logistics');
  assert.equal(p.PickupAddress.Street, 'Depó út');
  assert.equal(p.PickupAddress.HouseNumber, '14');
  assert.deepEqual(p.ServiceList, [{ Code: 'FDS', FDSParameter: { Value: 'maria@example.com' } }]);
  assert.deepEqual(p.ParcelPropertyList, [
    { Content: '#1007', PackageType: 2, Weight: 2.5 },
    { Content: '#1007', PackageType: 2, Weight: 1.25, Length: 30, Width: 20, Height: 10 },
  ]);
  assert.equal(out.trackingNumber, '51001234567');
  assert.deepEqual(out.parcelNumbers, ['51001234567', '51001234568']);
  assert.deepEqual(Array.from(out.label), Array.from(PDF));
});

test('GLS: parcel shop (PSD) needs phone and e-mail; express from the order service', async () => {
  const s = shipment({ pickupPointId: '2351-CSOMAGPONT', service: 'T12' });
  assert.deepEqual(gls.validate(s), []);
  const bad = shipment({ pickupPointId: '2351-CSOMAGPONT', recipient: { phone: '', email: '' } });
  assert.equal(gls.validate(bad).length, 2);
  const req = await gls.buildPrintLabelsRequest(s, glsAccount({ notify_sms: true }));
  assert.equal(req.url, 'https://api.mygls.hu/ParcelService.svc/json/PrintLabels');
  assert.deepEqual(req.body.ParcelList[0].ServiceList, [{ Code: 'T12' }, { Code: 'PSD', PSDParameter: { StringValue: '2351-CSOMAGPONT' } }]);
  assert.equal(req.body.ParcelList[0].CODAmount, undefined);
});

test('GLS: errors from PrintLabelsErrorList and HTTP 401', () => {
  const rejected = { ok: true, status: 200, data: { Labels: null, PrintLabelsErrorList: [{ ErrorCode: 13, ErrorDescription: 'ZipCode is invalid.' }], PrintLabelsInfoList: [] } };
  assert.throws(() => gls.parsePrintLabelsResponse(rejected), (e) => e.kind === 'rejected' && /hibásnak találta/.test(e.message) && /ZipCode is invalid/.test(e.message));
  const auth = { ok: true, status: 200, data: { PrintLabelsErrorList: [{ ErrorCode: 14, ErrorDescription: 'User not exists' }] } };
  assert.throws(() => gls.parsePrintLabelsResponse(auth), (e) => e.kind === 'auth');
  assert.throws(() => gls.parsePrintLabelsResponse({ ok: false, status: 401, data: null, text: '' }), (e) => e.kind === 'auth' && e.status === 401);
  // Labels as base64 string is accepted too.
  const ok = gls.parsePrintLabelsResponse({ ok: true, status: 200, data: { Labels: PDF_B64, PrintLabelsErrorList: [], PrintLabelsInfoList: [{ ParcelId: 5, ParcelNumber: 123 }] } });
  assert.equal(ok.trackingNumber, '123');
});

test('GLS: connection test sends WCF dates, tracking marks delivered codes', async () => {
  const { http, calls } = fakeHttp((c) => (c.url.endsWith('/GetParcelList')
    ? { json: { GetParcelListErrors: [], PrintDataInfoList: [{}, {}] } }
    : { json: { GetParcelListStatusesErrors: [], ParcelList: [
      { ParcelNumber: 111, ParcelStatusList: [{ StatusCode: '51', StatusDescription: 'Adatok rögzítve' }, { StatusCode: '05', StatusDescription: 'A csomag kézbesítve.' }] },
      { ParcelNumber: 222, ParcelStatusList: [{ StatusCode: '55', StatusDescription: 'ParcelShopba kézbesítve' }] },
    ] } }));
  const t = await gls.testConnection(glsAccount(), http);
  assert.equal(t.ok, true);
  assert.match(calls[0].body, /"PrintDateFrom":"\\\/Date\(\d+\)\\\/"/);
  const r = await gls.trackDelivered(['111', '222'], glsAccount(), http);
  assert.deepEqual(r.delivered, [{ trackingNumber: '111', text: 'A csomag kézbesítve.' }]);
  const b = jsonBody(calls[1]);
  assert.deepEqual(b.ParcelNumberList, [111, 222]);
  assert.equal(b.LanguageIsoCode, 'HU');
});

// ---------------------------------------------------------------- DPD

const dpdAccount = (settings = {}) => account({ customer_id: '7463354763', sender_address_id: '56', ...settings }, { api_token: 'jwt.token.value' });

const dpdOk = {
  transactionId: 4384,
  shipmentResults: [{ numOrder: 1, shipmentId: 52173, mpsId: '05910000000005', labelFile: `data:application/pdf;base64,${PDF_B64}`, parcelResults: [{ parcelId: 56766, parcelNumber: '05910000000005' }] }],
};

test('DPD: shipment request for COD home delivery with Predict', async () => {
  const s = shipment({ cod: { amount: 12990, currency: 'HUF' }, recipient: { address: 'Fő utca 12, 3. em. 5.', houseNumber: '12', houseInfo: '3. em. 5.' } });
  const { http, calls } = fakeHttp(() => ({ json: dpdOk }));
  const out = await dpd.createShipment(s, dpdAccount({ test_mode: true, bu_code: '015' }), http);
  assert.equal(calls[0].url, 'https://nst-preprod.dpsin.dpdgroup.com/api/v1.1/shipments');
  assert.equal(calls[0].headers.authorization, 'Bearer jwt.token.value');
  const body = jsonBody(calls[0]);
  assert.equal(body.customerId, '7463354763');
  assert.equal(body.buCode, '015');
  const sh = body.shipments[0];
  assert.equal(sh.numOrder, 1);
  assert.equal(sh.senderAddressId, 56);
  assert.equal(sh.saveMode, 'printed');
  assert.equal(sh.printFormat, 'pdf');
  assert.equal(sh.labelSize, 'A6');
  assert.equal(sh.reference1, 'R-2026-000007');
  assert.deepEqual(sh.receiver, {
    name: 'Minta Mária', street: 'Fő utca', houseNo: '12', additionalAddressInfo: '3. em. 5.', city: 'Budapest', zipCode: '1111', countryCode: 'HU',
    contactName: 'Minta Mária', contactPhonePrefix: '+36', contactPhone: '301234567', contactMobilePrefix: '+36', contactMobile: '301234567', contactEmail: 'maria@example.com',
  });
  assert.deepEqual(sh.parcels, [{ weight: 2.5, reference1: 'R-2026-000007', dimensionLength: 40, dimensionWidth: 30, dimensionHeight: 20 }]);
  assert.equal(sh.service.mainServiceCode, '101');
  assert.deepEqual(sh.service.additionalService.cod, { amount: 12990, currency: 'HUF', paymentType: 'Cash', reference: 'R-2026-000007', split: 'First parcel' });
  assert.deepEqual(sh.service.additionalService.predicts, [{ type: 'email', destination: 'maria@example.com', language: 'HU' }, { type: 'SMS', destination: '+36301234567', language: 'HU' }]);
  assert.equal(out.trackingNumber, '05910000000005');
  assert.deepEqual(Array.from(out.label), Array.from(PDF));
});

test('DPD: pickup point uses pudoId and the PUDO service code', () => {
  const req = dpd.buildShipmentRequest(shipment({ pickupPointId: 'HU12345' }), dpdAccount({ predict: false }));
  assert.equal(req.url, 'https://shipping.dpdgroup.com/api/v1.1/shipments');
  assert.deepEqual(req.body.shipments[0].service, { mainServiceCode: '337', additionalService: { pudoId: 'HU12345' } });
  assert.equal(req.body.buCode, undefined);
  assert.equal(req.body.shipments[0].receiver.houseNo, '12/B');
});

test('DPD: validation errors (400 map) and per shipment errors', () => {
  const r400 = { ok: false, status: 400, text: '', data: { 'create.shipmentRequest.shipments[0].sender.contact': 'At least one sender contact method must be provided (contactPhone or contactEmail).' } };
  assert.throws(() => dpd.parseShipmentResponse(r400), (e) => e.kind === 'rejected' && /At least one sender contact/.test(e.message));
  const r200 = { ok: true, status: 200, data: { shipmentResults: [{ numOrder: 1, errors: [{ errorCode: 'MSG530', errorContent: 'PUDO not found' }] }] } };
  assert.throws(() => dpd.parseShipmentResponse(r200), (e) => e.kind === 'rejected' && /PUDO not found/.test(e.message));
  assert.throws(() => dpd.parseShipmentResponse({ ok: false, status: 401, data: null, text: '' }), (e) => e.kind === 'auth');
});

// ---------------------------------------------------------------- Foxpost

const foxAccount = (settings = {}) => account(settings, { username: 'fox-user', password: 'fox-pass', api_key: 'fox-key' });

test('Foxpost: parcel locker parcel, then the label PDF', async () => {
  const s = shipment({ pickupPointId: 'hu35', packages: [{ weightKg: 1, size: 's' }] });
  assert.deepEqual(foxpost.validate(s), []);
  const { http, calls } = fakeHttp((c) => (c.url.includes('/api/parcel')
    ? { status: 201, json: { valid: true, parcels: [{ refCode: 'R-2026-000007', clFoxId: 'CLFOX0000000001', errors: null }] } }
    : { status: 200, body: PDF, type: 'application/pdf' }));
  const out = await foxpost.createShipment(s, foxAccount({ label_format: 'A6' }), http);
  assert.equal(calls[0].url, 'https://webapi.foxpost.hu/api/parcel?isWeb=true&isRedirect=false');
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from('fox-user:fox-pass').toString('base64')}`);
  assert.equal(calls[0].headers['api-key'], 'fox-key');
  assert.deepEqual(jsonBody(calls[0]), [{
    recipientName: 'Minta Mária', recipientPhone: '+36301234567', recipientEmail: 'maria@example.com', recipientCountry: 'HU',
    size: 's', cod: 0, comment: '#1007', refCode: 'R-2026-000007', label: false, fragile: false, destination: 'hu35',
  }]);
  assert.equal(calls[1].url, 'https://webapi.foxpost.hu/api/label/A6?startPos=0');
  assert.equal(calls[1].headers.accept, 'application/pdf');
  assert.deepEqual(jsonBody(calls[1]), ['CLFOX0000000001']);
  assert.equal(out.trackingNumber, 'CLFOX0000000001');
  assert.deepEqual(Array.from(out.label), Array.from(PDF));
});

test('Foxpost: home delivery with COD on the first of two parcels, test environment', () => {
  const s = shipment({ cod: { amount: 8990.4, currency: 'HUF' }, packages: [{ weightKg: 1 }, { weightKg: 2 }] });
  const req = foxpost.buildParcelsRequest(s, foxAccount({ test_mode: true, default_size: 'm' }));
  assert.equal(req.url, 'https://webapi-test.foxpost.hu/api/parcel?isWeb=true&isRedirect=false');
  assert.equal(req.body.length, 2);
  assert.equal(req.body[0].cod, 8990);
  assert.equal(req.body[1].cod, 0);
  assert.equal(req.body[1].refCode, 'R-2026-000007/2');
  assert.equal(req.body[0].recipientZip, '1111');
  assert.equal(req.body[0].recipientCity, 'Budapest');
  assert.equal(req.body[0].recipientAddress, 'Fő utca 12/B');
  assert.equal(req.body[0].size, 'm');
  assert.equal(req.body[0].destination, undefined);
});

test('Foxpost: refusals before and after calling', () => {
  const noPhone = foxpost.validate(shipment({ pickupPointId: 'hu35', recipient: { phone: '' } }));
  assert.match(noPhone.join(' '), /kötelező a címzett telefonszáma/);
  assert.match(foxpost.validate(shipment({ pickupPointId: 'hu35', recipient: { phone: '+3612345678' } })).join(' '), /mobilszámot/);
  const invalid = { ok: true, status: 201, data: { valid: false, parcels: [{ refCode: 'R-2026-000007', errors: [{ field: 'destination', message: 'INVALID_APM_ID' }] }] } };
  assert.throws(() => foxpost.parseParcelsResponse(invalid), (e) => e.kind === 'rejected' && /ismeretlen Foxpost automata/.test(e.message));
  const unauthorized = { ok: false, status: 401, data: { error: 'WRONG_USERNAME_OR_PASSWORD', status: 401 } };
  assert.throws(() => foxpost.parseParcelsResponse(unauthorized), (e) => e.kind === 'auth' && /WRONG_USERNAME_OR_PASSWORD/.test(e.message));
});

test('Foxpost: parcel booked but label download failed keeps the parcel numbers', async () => {
  const { http } = fakeHttp((c) => (c.url.includes('/api/parcel')
    ? { status: 201, json: { valid: true, parcels: [{ refCode: 'R-2026-000007', clFoxId: 'CLFOX0000000009' }] } }
    : { status: 500, json: { error: 'INTERNAL_ERROR', status: 500 } }));
  const out = await foxpost.createShipment(shipment({ pickupPointId: 'hu35' }), foxAccount(), http);
  assert.equal(out.trackingNumber, 'CLFOX0000000009');
  assert.equal(out.label, null);
  assert.match(out.labelError, /címke letöltése nem sikerült \(INTERNAL_ERROR\)/);
});

test('Foxpost: tracking marks RECEIVE and HDRECEIVE as delivered', async () => {
  const { http, calls } = fakeHttp(() => ({ json: [
    { barcode: 'CLFOX1', statuses: [{ trackId: 4, status: 'RECEIVE', statusDate: '2026-10-15T09:33:28.182Z' }, { status: 'CREATE' }] },
    { barcode: 'CLFOX2', statuses: [{ status: 'OPERIN' }] },
  ] }));
  const r = await foxpost.trackDelivered(['CLFOX1', 'CLFOX2'], foxAccount(), http);
  assert.equal(calls[0].url, 'https://webapi.foxpost.hu/api/tracking/tracks');
  assert.deepEqual(jsonBody(calls[0]), ['CLFOX1', 'CLFOX2']);
  assert.deepEqual(r.delivered.map((d) => d.trackingNumber), ['CLFOX1']);
});

// ---------------------------------------------------------------- MPL

const mplAccount = (settings = {}, id = 'client-1') => account({ customer_code: '0012345678', agreement: '10000319', bank_account: '11112222-33334444', ...settings }, { client_id: id, client_secret: 'secret-1' });
const mplToken = { access_token: 'APRug5AE4VGAzNKDPAoxugLiDp0b', issued_at: 1592910455065, expires_in: 1799, token_type: 'Bearer' };

test('MPL: OAuth2 token, then a COD home delivery shipment', async () => {
  mpl.clearTokenCache();
  const s = shipment({ cod: { amount: 3000, currency: 'HUF' } });
  const { http, calls } = fakeHttp((c) => (c.url.endsWith('/oauth2/token')
    ? { json: mplToken }
    : { json: [{ webshopId: 'R-2026-000007', trackingNumber: 'PKAAA50058206', packageTrackingNumbers: ['PKAAA500582060011138001500'], label: PDF_B64, warnings: [{ code: '33', text: 'Címzett címe nem azonosítható, kérjük ellenőrizze.' }] }] }));
  const out = await mpl.createShipment(s, mplAccount({ test_mode: true }), http);
  assert.equal(calls[0].url, 'https://sandbox.api.posta.hu/oauth2/token');
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from('client-1:secret-1').toString('base64')}`);
  assert.equal(calls[0].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(calls[0].body, 'grant_type=client_credentials');
  assert.equal(calls[1].url, 'https://sandbox.api.posta.hu/v2/mplapi/shipments');
  assert.equal(calls[1].headers.authorization, 'Bearer APRug5AE4VGAzNKDPAoxugLiDp0b');
  assert.equal(calls[1].headers['x-accounting-code'], '0012345678');
  assert.match(calls[1].headers['x-request-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const [body] = jsonBody(calls[1]);
  assert.equal(body.developer, 'Fully Logistics WMS');
  assert.equal(body.webshopId, 'R-2026-000007');
  assert.equal(body.orderId, 'R-2026-000007');
  assert.equal(body.labelType, 'A6');
  assert.equal(body.paymentMode, 'UV_AT');
  assert.equal(body.packageRetention, 5);
  assert.deepEqual(body.sender, {
    agreement: '10000319', accountNo: '1111222233334444',
    contact: { name: 'Fully Logistics', email: 'raktar@fully.hu', phone: '+3612345678' },
    address: { postCode: '2351', city: 'Alsónémedi', address: 'Depó út 14' },
  });
  assert.deepEqual(body.recipient, {
    contact: { name: 'Minta Mária', email: 'maria@example.com', phone: '+36301234567' },
    address: { postCode: '1111', city: 'Budapest', address: 'Fő utca 12/B' },
  });
  assert.deepEqual(body.item, [{
    customData1: 'R-2026-000007', customData2: '#1007', weight: { value: 2500, unit: 'G' },
    services: { basic: 'A_175_UZL', extra: ['K_ORZ', 'K_UVT', 'K_ENY'], deliveryMode: 'HA', cod: 3000, value: 3000 },
  }]);
  assert.equal(out.trackingNumber, 'PKAAA50058206');
  assert.deepEqual(out.parcelNumbers, ['PKAAA500582060011138001500']);
  assert.match(out.warnings[0], /nem azonosítható/);
  // The token is reused for the next call.
  await mpl.createShipment(s, mplAccount({ test_mode: true }), http);
  assert.equal(calls.filter((c) => c.url.endsWith('/oauth2/token')).length, 1);
});

test('MPL: parcel locker (CS) shipment and its refusals', () => {
  const s = shipment({ pickupPointId: '345 sz. automata - Szolnok Auchan', recipient: { zip: '5000', city: 'Szolnok' } });
  assert.equal(mpl.deliveryMode(s, mplAccount()), 'CS');
  assert.deepEqual(mpl.validate(s, mplAccount()), []);
  const [body] = mpl.buildShipmentRequest(s, mplAccount()).body;
  assert.equal(body.recipient.address.parcelPickupSite, '345 sz. automata - Szolnok Auchan');
  assert.equal(body.item[0].services.deliveryMode, 'CS');
  assert.equal(body.item[0].size, 'M');
  assert.deepEqual(body.item[0].services.extra, ['K_ORZ']);
  const noMobile = mpl.validate(shipment({ pickupPointId: '107206', service: 'CS', recipient: { phone: '+3612345678' } }), mplAccount());
  assert.match(noMobile.join(' '), /mobilszáma/);
  assert.equal(mpl.deliveryMode(shipment({ pickupPointId: 'Szolnok 2 posta' }), mplAccount()), 'PM');
  assert.equal(mpl.deliveryMode(shipment({ pickupPointId: '106455', service: 'PP' }), mplAccount()), 'PP');
  assert.match(mpl.validate(shipment({ recipient: { country: 'AT' } }), mplAccount()).join(' '), /csak belföldi/);
});

test('MPL: error answers (errors list, Apigee fault, 401 renews the token once)', async () => {
  const rejected = { ok: true, status: 200, data: [{ webshopId: 'R-2026-000007', errors: [{ code: '60', parameter: 'recipient.address.parcelPickupSite', text: 'A megadott recipient.address.parcelPickupSite nem található' }] }] };
  assert.throws(() => mpl.parseShipmentResponse(rejected, 'R-2026-000007'), (e) => e.kind === 'rejected' && /parcelPickupSite nem található/.test(e.message));
  const fault = { ok: false, status: 401, data: { fault: { faultstring: 'Invalid access token', detail: { errorcode: 'oauth.v2.InvalidAccessToken' } } } };
  assert.throws(() => mpl.parseShipmentResponse(fault, 'x'), (e) => e.kind === 'auth' && /Invalid access token/.test(e.message));

  mpl.clearTokenCache();
  let shipmentsCalls = 0;
  const { http, calls } = fakeHttp((c) => {
    if (c.url.endsWith('/oauth2/token')) return { json: { ...mplToken, access_token: `tok-${calls.length}` } };
    shipmentsCalls++;
    return shipmentsCalls === 1 ? { status: 401, json: { fault: { faultstring: 'Access Token expired' } } } : { json: [{ webshopId: 'R-2026-000007', trackingNumber: 'PN1', label: PDF_B64 }] };
  });
  const out = await mpl.createShipment(shipment(), mplAccount({}, 'client-2'), http);
  assert.equal(out.trackingNumber, 'PN1');
  assert.equal(calls.filter((c) => c.url.endsWith('/oauth2/token')).length, 2);

  mpl.clearTokenCache();
  const bad = fakeHttp(() => ({ status: 401, json: { fault: { faultstring: 'The povided API key (client_id) is invalid.', detail: { errorcode: 'RaiseFault.InvalidApiKey' } } } }));
  await assert.rejects(mpl.createShipment(shipment(), mplAccount({}, 'client-3'), bad.http), (e) => e.kind === 'auth' && /client_id/.test(e.message));
});

test('MPL: asynchronous tracking, report as the documentation shows it', async () => {
  mpl.clearTokenCache();
  const report = '{"item_identifier": "PNXXX50019641","last_event_type": " Sikeresen kézbesítve Postahelyen","last_post_name": "Füle posta","last_event_timestamp": "2023-01-26T14:46:53"},{"item_identifier": "PNXXX50094862","last_event_type": " Feladónak visszakézbesítve","last_post_name": "Csomaglogisztikai Központ","last_event_timestamp": "2023-01-26T11:33:06"}';
  assert.equal(mpl.parseTrackingReport(report).length, 2);
  const { http, calls } = fakeHttp((c) => {
    if (c.url.endsWith('/oauth2/token')) return { json: mplToken };
    if (c.method === 'POST') return { json: { trackingGUID: 'E6F654DB-EF6A-68B6-E053-5541660A0F29' } };
    return { json: { status: 'READY', report } };
  });
  const first = await mpl.trackDelivered(['PNXXX50019641', 'PNXXX50094862'], mplAccount({}, 'client-4'), http, {});
  assert.deepEqual(first.delivered, []);
  assert.equal(first.state.guid, 'E6F654DB-EF6A-68B6-E053-5541660A0F29');
  const post = calls.find((c) => c.url.endsWith('/v2/mplapi-tracking/tracking'));
  assert.deepEqual(jsonBody(post), { trackingNumbers: ['PNXXX50019641', 'PNXXX50094862'], language: 'HU' });
  const second = await mpl.trackDelivered(['PNXXX50019641', 'PNXXX50094862'], mplAccount({}, 'client-4'), http, first.state);
  assert.ok(calls.some((c) => c.url.endsWith('/v2/mplapi-tracking/tracking/E6F654DB-EF6A-68B6-E053-5541660A0F29')));
  assert.deepEqual(second.delivered, [{ trackingNumber: 'PNXXX50019641', text: 'Sikeresen kézbesítve Postahelyen' }]);
  assert.deepEqual(second.state, {});
});

test('MPL: daily closing returns the manifests', async () => {
  mpl.clearTokenCache();
  const { http, calls } = fakeHttp((c) => (c.url.endsWith('/oauth2/token') ? { json: mplToken } : { json: [{ manifest: PDF_B64, trackingNrPrices: [{ trackingNumber: 'PNQZ0501157850011138000000', price: 1250 }] }] }));
  const out = await mpl.closeShipments(mplAccount({}, 'client-5'), http, { trackingNumbers: ['PBABC50000122'] });
  assert.equal(calls[1].url, 'https://core.api.posta.hu/v2/mplapi/shipments/close');
  assert.deepEqual(jsonBody(calls[1]), { checkList: true, trackingNumbers: ['PBABC50000122'] });
  assert.equal(out.manifests.length, 1);
  assert.equal(out.prices[0].price, 1250);
});

// ---------------------------------------------------------------- DHL Express

const dhlAccount = (settings = {}) => account({ account_number: '123456789', ...settings }, { api_key: 'dhl-key', api_secret: 'dhl-secret' });

const dhlOk = {
  shipmentTrackingNumber: '5374534546',
  trackingUrl: 'https://expressapi.dhl.com/mydhlapi/shipments/5374534546/tracking',
  packages: [{ referenceNumber: 1, trackingNumber: 'JD014600004617230779', trackingUrl: 'https://expressapi.dhl.com/mydhlapi/shipments/5374534546/tracking?pieceTrackingNumber=JD014600004617230779' }],
  documents: [{ imageFormat: 'PDF', content: PDF_B64, typeCode: 'label' }],
};

test('DHL Express: domestic shipment request and label', async () => {
  const { http, calls } = fakeHttp(() => ({ status: 201, json: dhlOk }));
  const out = await dhl.createShipment(shipment(), dhlAccount({ test_mode: true }), http);
  assert.equal(calls[0].url, 'https://express.api.dhl.com/mydhlapi/test/shipments');
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from('dhl-key:dhl-secret').toString('base64')}`);
  assert.equal(calls[0].headers['x-version'], '3.3.4');
  assert.ok(calls[0].headers['message-reference'].length <= 36);
  const body = jsonBody(calls[0]);
  assert.match(body.plannedShippingDateAndTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} GMT\+0[12]:00$/);
  assert.deepEqual(body.pickup, { isRequested: false });
  assert.equal(body.productCode, 'N');
  assert.deepEqual(body.accounts, [{ typeCode: 'shipper', number: '123456789' }]);
  assert.deepEqual(body.outputImageProperties, { encodingFormat: 'pdf', imageOptions: [{ typeCode: 'label', templateName: 'ECOM26_A6_002', isRequested: true }, { typeCode: 'waybillDoc', isRequested: false }] });
  assert.deepEqual(body.customerDetails.receiverDetails, {
    postalAddress: { postalCode: '1111', cityName: 'Budapest', countryCode: 'HU', addressLine1: 'Fő utca 12/B' },
    contactInformation: { phone: '+36301234567', companyName: 'Minta Mária', fullName: 'Minta Mária', email: 'maria@example.com' },
    typeCode: 'private',
  });
  assert.equal(body.customerDetails.shipperDetails.typeCode, 'business');
  assert.equal(body.customerDetails.shipperDetails.contactInformation.companyName, 'Fully Logistics');
  assert.deepEqual(body.content, {
    packages: [{ weight: 2.5, customerReferences: [{ typeCode: 'CU', value: 'R-2026-000007' }], dimensions: { length: 40, width: 30, height: 20 } }],
    isCustomsDeclarable: false, description: 'Webáruházi termékek', incoterm: 'DAP', unitOfMeasurement: 'metric',
  });
  assert.equal(out.trackingNumber, '5374534546');
  assert.deepEqual(out.parcelNumbers, ['JD014600004617230779']);
});

test('DHL Express: EU product, refusals and problem+json errors', () => {
  const eu = dhl.buildShipmentRequest(shipment({ recipient: { country: 'AT', zip: '1010', city: 'Wien', address: 'Quellenstrasse 51', phone: '+431252307217' } }), dhlAccount());
  assert.equal(eu.url, 'https://express.api.dhl.com/mydhlapi/shipments');
  assert.equal(eu.body.productCode, 'U');
  assert.match(dhl.validate(shipment({ cod: { amount: 1000, currency: 'HUF' } })).join(' '), /nem szállít utánvéttel/);
  assert.match(dhl.validate(shipment({ recipient: { country: 'US' } })).join(' '), /EU-n belülre/);
  const r400 = { ok: false, status: 400, data: { instance: '/expressapi/shipments', detail: "7008: The requested Special Service Code  #/valueAddedServices/0/serviceCode 'xx' is not available between this origin and destination.", title: 'Bad request', message: 'Bad request', status: '400' } };
  assert.throws(() => dhl.parseShipmentResponse(r400), (e) => e.kind === 'rejected' && /7008/.test(e.message));
  assert.throws(() => dhl.parseShipmentResponse({ ok: false, status: 500, data: { detail: '999: Process failure occurred.' } }), (e) => e.kind === 'unavailable');
});

test('DHL Express: tracking reads the "OK" (delivered) event', async () => {
  const { http, calls } = fakeHttp(() => ({ json: { shipments: [
    { shipmentTrackingNumber: '1234567890', status: 'Success', events: [{ date: '2026-10-15', time: '11:59:23', typeCode: 'OK', description: 'Delivered : ALBY H' }] },
    { shipmentTrackingNumber: '9356579890', status: 'Success', events: [{ typeCode: 'PU', description: 'Shipment picked up' }] },
  ] } }));
  const r = await dhl.trackDelivered(['1234567890', '9356579890'], dhlAccount(), http);
  assert.match(calls[0].url, /\/tracking\?shipmentTrackingNumber=1234567890&shipmentTrackingNumber=9356579890&trackingView=all-checkpoints&levelOfDetail=shipment$/);
  assert.deepEqual(r.delivered, [{ trackingNumber: '1234567890', text: 'Delivered : ALBY H' }]);
});
