// Packing station with a carrier label: GLS answered by a fake MyGLS server on 127.0.0.1 (account
// setting api_base_url, honoured only for localhost). Covers a booked label, a parcel booked with
// an unusable label (still packed, warning shown) and a refused parcel (manual fallback).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from './helpers.mjs';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n');
let srv;
let admin;
let fx;
let fake;
let parcelNo = 61001234560;
const requests = [];

function startFakeGls() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : null;
        requests.push({ path: req.url, body });
        const send = (data) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
        if (req.url !== '/ParcelService.svc/json/PrintLabels') { res.writeHead(404); res.end('{}'); return; }
        const parcel = body.ParcelList[0];
        if (parcel.DeliveryAddress.ZipCode === '9999') {
          send({ Labels: null, PrintLabelsErrorList: [{ ErrorCode: 13, ErrorDescription: 'Invalid ZipCode: 9999', ClientReferenceList: [parcel.ClientReference], ParcelIdList: [] }], PrintLabelsInfoList: [] });
          return;
        }
        const info = Array.from({ length: parcel.Count }, () => ({ ClientReference: parcel.ClientReference, ParcelId: 1, ParcelNumber: parcelNo++ }));
        send({ Labels: parcel.DeliveryAddress.ZipCode === '8888' ? [1, 2, 3] : Array.from(PDF), PrintLabelsErrorList: [], PrintLabelsInfoList: info });
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

before(async () => {
  fake = await startFakeGls();
  srv = await startServer();
  admin = await srv.admin();
  fx = await srv.seedBasics();
  await srv.sql(`UPDATE settings SET value = json_set(value, '$.phone', '+36 1 234 5678', '$.email', 'raktar@fully.hu') WHERE key = 'company'`);
  const saved = await srv.call('accounts.saveCourierAccount', ['gls', {
    credentials: { username: 'api@fully.hu', password: 'titkos-jelszo' },
    settings: { client_number: 100000001, test_mode: true, label_format: 'Thermo', api_base_url: `http://127.0.0.1:${fake.address().port}` },
    active: true, carrierId: fx.carriers.gls,
  }]);
  assert.equal(saved.ok, true, JSON.stringify(saved));
});
after(async () => {
  await srv.stop();
  fake.close();
});

// A picked order, ready for packing.
async function picked(zip) {
  const r = await admin.post('/api/orders', {
    partner_id: fx.clients.kutya, customer_name: 'Minta Mária', phone: '06 30 123 4567', email: 'maria@example.com',
    zip, city: 'Budapest', address: 'Fő utca 12/B', carrier_id: fx.carriers.gls, cod_amount: 4990,
    lines: [{ product_id: fx.products.csont, qty: 2 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const w = await admin.post('/api/picking/waves', { order_ids: [r.data.id] });
  const d = (await admin.get(`/api/picking/waves/${w.data.id}`)).data;
  for (const t of d.tasks) {
    const c = await admin.post(`/api/picking/waves/${w.data.id}/confirm`, { pick_id: t.pick_id, location_code: t.location.code, product_code: t.product.sku, qty: t.remaining });
    assert.equal(c.status, 200, JSON.stringify(c.data));
  }
  return r.data;
}

test('label: parcels booked with the carrier, label stored, order packed', async () => {
  const o = await picked('1111');
  const before = (await admin.get(`/api/picking/orders/${o.id}`)).data;
  assert.equal(before.carrier.configured, true);
  requests.length = 0;
  const r = await admin.post(`/api/picking/orders/${o.id}/pack`, { mode: 'label', package_count: 2, weight_kg: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'packed');
  assert.equal(r.data.warning, '');
  assert.match(r.data.tracking_number, /^6100123456\d$/);
  assert.ok(r.data.label && r.data.label.id);
  assert.equal(r.data.package_count, 2);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.ParcelList[0].Count, 2);
  assert.deepEqual(requests[0].body.ParcelList[0].ParcelPropertyList.map((p) => p.Weight), [1.5, 1.5]);
  const file = await admin.get(`/api/documents/${r.data.label.id}`, { raw: true });
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PDF);
  const events = await srv.query('SELECT type, text FROM order_events WHERE order_id = ? ORDER BY id', o.id);
  assert.ok(events.some((e) => e.type === 'label'));
  assert.match(events[events.length - 1].text, /Becsomagolva: 2 csomag, címke elkészült/);
});

test('label: booked but the label is unusable, the order is still packed with a warning', async () => {
  const o = await picked('8888');
  const r = await admin.post(`/api/picking/orders/${o.id}/pack`, { mode: 'label', package_count: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'packed');
  assert.match(r.data.warning, /címke nem érhető el/);
  assert.ok(r.data.tracking_number);
  assert.equal(r.data.label, null);
});

test('label: refused by the carrier, nothing booked, manual tracking number works', async () => {
  const o = await picked('9999');
  const r = await admin.post(`/api/picking/orders/${o.id}/pack`, { mode: 'label', package_count: 1 });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /Invalid ZipCode: 9999/);
  const after1 = (await admin.get(`/api/picking/orders/${o.id}`)).data;
  assert.equal(after1.status, 'picking');
  assert.equal(after1.tracking_number, '');
  const m = await admin.post(`/api/picking/orders/${o.id}/pack`, { mode: 'manual', tracking_number: 'KEZI-123' });
  assert.equal(m.status, 200, JSON.stringify(m.data));
  assert.equal(m.data.tracking_number, 'KEZI-123');
  assert.equal(m.data.status, 'packed');
});
