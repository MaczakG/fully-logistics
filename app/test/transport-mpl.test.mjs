// Closing an MPL pickup runs MPL's mandatory daily closing first: when it fails nothing is shipped
// and the manifest stays open; when it works the manifest PDF is stored on the pickup.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer } from './helpers.mjs';

let srv;
let fx;
let manager;
let fake;
let closeFails = true;
const calls = [];
const PDF = Buffer.from('%PDF-1.4 feladojegyzek').toString('base64');

before(async () => {
  fake = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ url: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/oauth2/token') return res.end(JSON.stringify({ access_token: 'tok', expires_in: 1800 }));
      if (req.url === '/v2/mplapi/shipments/close') {
        if (closeFails) { res.statusCode = 503; return res.end(JSON.stringify({ fault: { faultstring: 'Szolgáltatás nem elérhető' } })); }
        return res.end(JSON.stringify([{ manifest: PDF, trackingNrPrices: [{ trackingNumber: 'MPL1', price: 1200 }], errors: [] }]));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));

  srv = await startServer();
  await srv.admin();
  fx = await srv.seedBasics();
  manager = await srv.userWithRole('warehouse_manager', 'vezeto-mpl@example.com');
  await srv.sql("INSERT INTO partners (id, type, code, name, carrier_code) VALUES (303, 'carrier', 'MPL', 'Magyar Posta Zrt.', 'mpl')");
  const saved = await srv.call('accounts.saveCourierAccount', ['mpl', {
    active: true, carrierId: 303,
    credentials: { client_id: 'id', client_secret: 'secret' },
    settings: { customer_code: '12345', agreement: '12345678', api_base_url: `http://127.0.0.1:${fake.address().port}` },
  }]);
  assert.equal(saved.ok, true, JSON.stringify(saved));
});
after(async () => {
  // Close the fake first: if the server never started, an open listener would keep the run alive.
  if (fake) fake.close();
  if (srv) await srv.stop();
});

test('mpl daily closing runs before shipping and keeps the manifest open on failure', async () => {
  const created = await srv.call('orderCreate.createOrder', [{
    partner_id: fx.clients.kutya, source: 'api', external_id: 'mpl-1', customer_name: 'Posta Vevő',
    zip: '1111', city: 'Budapest', address: 'Fő utca 1.', carrier_code: 'mpl', lines: [{ sku: 'KB-1003', qty: 1 }],
  }], { as: 1 });
  assert.equal(created.ok, true, JSON.stringify(created));
  const id = created.result.id;
  await srv.sql(`UPDATE orders SET status = 'packed', packed_at = '2026-10-16T09:00:00.000Z', tracking_number = 'MPL1' WHERE id = ${id}`);
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Budapest' }).format(new Date());
  const pickup = await manager.post('/api/transport/pickups', { carrier_id: 303, date: today });
  assert.equal(pickup.status, 200, JSON.stringify(pickup.data));
  const pid = pickup.data.id;
  const assigned = await manager.post(`/api/transport/pickups/${pid}/orders`, { order_ids: [id] });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.data));

  const failed = await manager.post(`/api/transport/pickups/${pid}/close`, {});
  assert.equal(failed.status, 409, JSON.stringify(failed.data));
  assert.match(failed.data.error.message, /napi zárás/);
  assert.equal((await srv.query('SELECT status FROM orders WHERE id = ?', id))[0].status, 'packed');
  assert.notEqual((await srv.query('SELECT status FROM carrier_pickups WHERE id = ?', pid))[0].status, 'closed');

  closeFails = false;
  const closed = await manager.post(`/api/transport/pickups/${pid}/close`, {});
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal(closed.data.done, true);
  assert.equal((await srv.query('SELECT status FROM orders WHERE id = ?', id))[0].status, 'shipped');
  const [p] = await srv.query('SELECT status, manifest_document_id FROM carrier_pickups WHERE id = ?', pid);
  assert.equal(p.status, 'closed');
  assert.ok(p.manifest_document_id);
  const doc = await manager.request('GET', `/api/documents/${p.manifest_document_id}`, undefined, { raw: true });
  assert.equal(doc.status, 200);
  assert.match(Buffer.from(await doc.arrayBuffer()).toString(), /feladojegyzek/);
  const closeCall = calls.filter((c) => c.url === '/v2/mplapi/shipments/close').pop();
  assert.deepEqual(JSON.parse(closeCall.body).trackingNumbers, ['MPL1']);
});
