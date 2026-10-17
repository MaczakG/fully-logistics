// createLabel, testConnection and syncDeliveries end to end inside the Worker (wrangler dev),
// with GLS answered by a fake MyGLS server on 127.0.0.1 (account setting api_base_url, honoured
// only for localhost addresses).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { startServer } from './helpers.mjs';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n');

let srv;
let admin;
let fx;
let fake;
let fakeUrl;
const requests = [];
let nextParcel = 51001234560;

// Fake MyGLS: PrintLabels, GetParcelList, GetParcelListStatuses as documented in the MyGLS API.
function startFakeGls() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : null;
        requests.push({ method: req.method, path: req.url, headers: req.headers, raw, body });
        const send = (status, data) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(data));
        };
        if (req.url === '/ParcelService.svc/json/PrintLabels') {
          const parcel = body.ParcelList[0];
          if (parcel.DeliveryAddress.ZipCode === '9999') {
            return send(200, { Labels: null, PrintLabelsErrorList: [{ ErrorCode: 13, ErrorDescription: 'Invalid ZipCode: 9999', ClientReferenceList: [parcel.ClientReference], ParcelIdList: [] }], PrintLabelsInfoList: [] });
          }
          const info = Array.from({ length: parcel.Count }, () => ({ ClientReference: parcel.ClientReference, ParcelId: 777, ParcelNumber: nextParcel++ }));
          // ZIP 8888: booked, but the label is not a PDF.
          const labels = parcel.DeliveryAddress.ZipCode === '8888' ? [1, 2, 3] : Array.from(PDF);
          return send(200, { Labels: labels, PrintLabelsErrorList: [], PrintLabelsInfoList: info });
        }
        if (req.url === '/ParcelService.svc/json/GetParcelList') return send(200, { GetParcelListErrors: [], PrintDataInfoList: [{}] });
        if (req.url === '/ParcelService.svc/json/GetParcelListStatuses') {
          return send(200, {
            GetParcelListStatusesErrors: [],
            ParcelList: body.ParcelNumberList.map((n) => ({ ParcelNumber: n, ParcelStatusList: [{ StatusCode: '05', StatusDescription: 'A csomag kézbesítve.', StatusDate: '/Date(1760000000000)/' }] })),
          });
        }
        return send(404, {});
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

before(async () => {
  fake = await startFakeGls();
  fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  srv = await startServer();
  admin = await srv.admin();
  fx = await srv.seedBasics();
  await srv.sql(`UPDATE settings SET value = json_set(value, '$.phone', '+36 1 234 5678', '$.email', 'raktar@fully.hu') WHERE key = 'company'`);
});
after(async () => {
  // Close the fake first: if the server never started, an open listener would keep the run alive.
  if (fake) fake.close();
  if (srv) await srv.stop();
});

const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r)); return r.result; };

// Unique external_id: orders.UNIQUE (partner_id, source, external_id) also binds manual orders.
let seq = 0;
const order = async (over = {}) => ok(await srv.call('orderCreate.createOrder', [{
  external_id: `courier-test-${++seq}`,
  partner_id: fx.clients.kutya, customer_name: 'Minta Mária', email: 'maria@example.com', phone: '06 30 123 4567',
  zip: '1111', city: 'Budapest', address: 'Fő utca 12/B', carrier_code: 'gls', cod_amount: 12990, external_number: '#1001',
  lines: [{ sku: 'KB-1002', qty: 1 }], ...over,
}], { as: 1 }));

const saveGls = (extra = {}) => srv.call('accounts.saveCourierAccount', ['gls', {
  credentials: { username: 'api@fully.hu', password: 'titkos-jelszo' },
  settings: { client_number: 100000001, test_mode: true, label_format: 'Thermo', api_base_url: fakeUrl, ...extra },
  active: true, carrierId: fx.carriers.gls,
}]);

test('createLabel: refuses without a configured account', async () => {
  const { id } = await order();
  const r = await srv.call('couriers.createLabel', [id, {}], { as: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.match(r.error, /GLS fiók nincs beállítva/);
  assert.equal(ok(await srv.call('couriers.isConfigured', ['gls'])), false);

  const none = await order({ carrier_code: '' });
  const r2 = await srv.call('couriers.createLabel', [none.id, {}], { as: 1 });
  assert.equal(r2.status, 409);
  assert.match(r2.error, /nincs futárszolgálat rendelve/);
});

test('createLabel: GLS label booked, PDF stored, order updated', async () => {
  ok(await saveGls());
  assert.equal(ok(await srv.call('couriers.isConfigured', ['gls'])), true);
  const { id, number } = await order();
  requests.length = 0;
  const res = ok(await srv.call('couriers.createLabel', [id, { packages: [{ weight_kg: 2.5 }, { weight_kg: 1.2, length_cm: 30, width_cm: 20, height_cm: 10 }] }], { as: 1 }));

  // The request MyGLS got.
  assert.equal(requests.length, 1);
  const req = requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/ParcelService.svc/json/PrintLabels');
  assert.match(req.headers['content-type'], /application\/json/);
  assert.equal(req.body.Username, 'api@fully.hu');
  assert.deepEqual(req.body.Password, Array.from(createHash('sha512').update('titkos-jelszo').digest()));
  assert.equal(req.body.TypeOfPrinter, 'Thermo');
  const p = req.body.ParcelList[0];
  assert.equal(p.ClientNumber, 100000001);
  assert.equal(p.ClientReference, number);
  assert.equal(p.Count, 2);
  assert.equal(p.CODAmount, 12990);
  assert.equal(p.CODReference, number);
  assert.equal(p.Content, `${number} (#1001)`);
  assert.deepEqual(p.DeliveryAddress, {
    Name: 'Minta Mária', Street: 'Fő utca', HouseNumber: '12', HouseNumberInfo: '/B', City: 'Budapest', ZipCode: '1111', CountryIsoCode: 'HU',
    ContactName: 'Minta Mária', ContactPhone: '+36301234567', ContactEmail: 'maria@example.com',
  });
  assert.deepEqual(p.PickupAddress, {
    Name: 'Fully Logistics', Street: 'Depó út', HouseNumber: '14', HouseNumberInfo: '', City: 'Alsónémedi', ZipCode: '2351', CountryIsoCode: 'HU',
    ContactName: 'Fully Logistics', ContactPhone: '+3612345678', ContactEmail: 'raktar@fully.hu',
  });
  assert.deepEqual(p.ParcelPropertyList.map((x) => x.Weight), [2.5, 1.2]);

  // What the app stored.
  assert.match(res.trackingNumber, /^5100123456\d$/);
  assert.equal(res.parcelNumbers.length, 2);
  assert.equal(res.carrierCode, 'gls');
  assert.equal(res.trackingUrl, `https://gls-group.com/HU/hu/csomagkovetes?match=${res.trackingNumber}`);
  const [o] = await srv.query('SELECT tracking_number, label_document_id, package_count, weight_kg, status FROM orders WHERE id = ?', id);
  assert.deepEqual(o, { tracking_number: res.trackingNumber, label_document_id: res.documentId, package_count: 2, weight_kg: 3.7, status: 'new' });
  const [doc] = await srv.query('SELECT kind, partner_id, content_type, size, uploaded_by FROM documents WHERE id = ?', res.documentId);
  assert.deepEqual(doc, { kind: 'label', partner_id: fx.clients.kutya, content_type: 'application/pdf', size: PDF.length, uploaded_by: 1 });
  const file = await admin.get(`/api/documents/${res.documentId}`, { raw: true });
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PDF);
  const events = await srv.query("SELECT text FROM order_events WHERE order_id = ? AND type = 'label'", id);
  assert.equal(events.length, 1);
  for (const n of res.parcelNumbers) assert.ok(events[0].text.includes(n), events[0].text);
  assert.match(events[0].text, /teszt környezet/);

  // Logged, without the password.
  const logs = await srv.query("SELECT action, ok, message FROM integration_log WHERE system = 'gls' AND ref_id = ? ORDER BY id", id);
  assert.deepEqual(logs.map((l) => [l.action, l.ok]), [['PrintLabels', 1], ['createLabel', 1]]);
  assert.ok(!JSON.stringify(logs).includes('titkos-jelszo'));
  const audit = await srv.query("SELECT summary FROM audit_log WHERE entity = 'order' AND entity_id = ? AND action = 'edit'", String(id));
  assert.match(audit[0].summary, /GLS címke/);

  // A second label for the same order is refused.
  const again = await srv.call('couriers.createLabel', [id, {}], { as: 1 });
  assert.equal(again.status, 409);
  assert.match(again.error, /már van nyomkövetési szám/);
});

test('createLabel: carrier error is shown in Hungarian and saved as last_error', async () => {
  const { id, number } = await order({ zip: '9999' });
  const r = await srv.call('couriers.createLabel', [id, {}], { as: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /Nem készült el a GLS címke: A GLS hibásnak találta a csomag adatait\. \(Invalid ZipCode: 9999\)/);
  const [acc] = await srv.query("SELECT last_error FROM courier_accounts WHERE carrier_code = 'gls'");
  assert.ok(acc.last_error.startsWith(`${number}: `), acc.last_error);
  const [o] = await srv.query('SELECT tracking_number, label_document_id FROM orders WHERE id = ?', id);
  assert.deepEqual(o, { tracking_number: '', label_document_id: null });
  assert.equal((await srv.query('SELECT COUNT(*) AS n FROM courier_label_locks'))[0].n, 0, 'lock released');
});

test('createLabel: booked without a usable label keeps the tracking number', async () => {
  const { id } = await order({ zip: '8888' });
  const r = await srv.call('couriers.createLabel', [id, {}], { as: 1 });
  assert.equal(r.status, 409);
  assert.match(r.error, /GLS csomag elkészült \(\d+\), de a címke nem érhető el: a kapott címke nem PDF/);
  const [o] = await srv.query('SELECT tracking_number, label_document_id FROM orders WHERE id = ?', id);
  assert.match(o.tracking_number, /^\d+$/);
  assert.equal(o.label_document_id, null);
  const [ev] = await srv.query("SELECT text FROM order_events WHERE order_id = ? AND type = 'label'", id);
  assert.match(ev.text, /A címke nem érhető el/);
  // A retry does not book a second parcel.
  const again = await srv.call('couriers.createLabel', [id, {}], { as: 1 });
  assert.match(again.error, /már van nyomkövetési szám/);
});

test('createLabel: order data, status and lock refusals', async () => {
  // Parcel shop delivery needs a phone number: refused before calling GLS.
  const shop = await order({ pickup_point_id: '2351-CSOMAGPONT', phone: '' });
  requests.length = 0;
  const r = await srv.call('couriers.createLabel', [shop.id, {}], { as: 1 });
  assert.equal(r.status, 400);
  assert.match(r.error, /csomagpontra csak a címzett telefonszámával/);
  assert.equal(requests.length, 0);

  const bad = await order();
  const w = await srv.call('couriers.createLabel', [bad.id, { packages: [{ weight_kg: -1 }] }], { as: 1 });
  assert.equal(w.status, 400);
  assert.ok(w.fields['packages.0.weight_kg']);

  const held = await order();
  ok(await srv.call('orders.setOrderStatus', [held.id, 'hold'], { as: 1 }));
  const h = await srv.call('couriers.createLabel', [held.id, {}], { as: 1 });
  assert.equal(h.status, 409);
  assert.match(h.error, /Felfüggesztve/);

  const locked = await order();
  await srv.sql(`INSERT INTO courier_label_locks (order_id, locked_at) VALUES (${locked.id}, '${new Date().toISOString()}')`);
  const l = await srv.call('couriers.createLabel', [locked.id, {}], { as: 1 });
  assert.equal(l.status, 409);
  assert.match(l.error, /éppen készül a címke/);

  // Foxpost: account saved, but a parcel locker order without phone is refused with the reason.
  ok(await srv.call('accounts.saveCourierAccount', ['foxpost', { credentials: { username: 'u', password: 'p', api_key: 'k' }, settings: { api_base_url: fakeUrl }, active: true, carrierId: fx.carriers.foxpost }]));
  const fox = await order({ carrier_code: 'foxpost', pickup_point_id: 'hu35', phone: '' });
  const f = await srv.call('couriers.createLabel', [fox.id, {}], { as: 1 });
  assert.equal(f.status, 400);
  assert.match(f.error, /Foxpost csomaghoz kötelező a címzett telefonszáma/);
});

test('createLabel: weight falls back to the products when no packages are given', async () => {
  const { id } = await order({ cod_amount: 0, lines: [{ sku: 'KB-1001', qty: 1 }, { sku: 'KB-1003', qty: 2 }] });
  requests.length = 0;
  ok(await srv.call('couriers.createLabel', [id], { as: 1 }));
  const p = requests[0].body.ParcelList[0];
  assert.equal(p.Count, 1);
  assert.deepEqual(p.ParcelPropertyList.map((x) => x.Weight), [12.6]);
  assert.equal(p.CODAmount, undefined);
});

test('testConnection and syncDeliveries', async () => {
  const t = ok(await srv.call('couriers.testConnection', ['gls']));
  assert.equal(t.ok, true, t.message);
  assert.match(t.message, /kapcsolat rendben/);
  const dpd = ok(await srv.call('couriers.testConnection', ['dpd']));
  assert.equal(dpd.ok, false);

  // A labelled order goes out, then GLS reports it delivered.
  const { id } = await order();
  const label = ok(await srv.call('couriers.createLabel', [id, {}], { as: 1 }));
  await srv.sql(`UPDATE orders SET status = 'shipped', shipped_at = '${new Date().toISOString()}' WHERE id = ${id}`);
  const summary = ok(await srv.call('couriers.syncDeliveries', []));
  assert.ok(summary.gls.checked >= 1);
  assert.ok(summary.gls.delivered >= 1);
  const [o] = await srv.query('SELECT status, delivered_at FROM orders WHERE id = ?', id);
  assert.equal(o.status, 'delivered');
  assert.ok(o.delivered_at);
  const statusReq = requests.filter((r) => r.path.endsWith('/GetParcelListStatuses')).pop();
  assert.ok(statusReq.body.ParcelNumberList.includes(Number(label.trackingNumber)));
  const [ev] = await srv.query("SELECT text, user_id FROM order_events WHERE order_id = ? AND type = 'status' ORDER BY id DESC LIMIT 1", id);
  assert.match(ev.text, /Kézbesítve \(GLS nyomkövetés\): A csomag kézbesítve\./);
  assert.equal(ev.user_id, null);
});

test('closeShipments: not needed for GLS', async () => {
  const r = ok(await srv.call('couriers.closeShipments', ['gls', {}], { as: 1 }));
  assert.deepEqual(r, { required: false, documentIds: [], closed: 0 });
});
