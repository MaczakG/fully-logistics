// Megrendelések: list, availability, create, edit, hold, cancel, CSV import, permissions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

let srv;
let admin;
let fx;
before(async () => {
  srv = await startServer();
  admin = await srv.admin();
  fx = await srv.seedBasics();
});
after(async () => { await srv.stop(); });

const order = (over = {}) => ({
  partner_id: fx.clients.kutya, customer_name: 'Minta Mária', zip: '1111', city: 'Budapest', address: 'Fő utca 1.',
  carrier_id: fx.carriers.gls, lines: [{ product_id: fx.products.alom, qty: 2 }], ...over,
});
const create = async (over) => {
  const r = await admin.post('/api/orders', order(over));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};
const csvForm = (text, preview) => {
  const fd = new FormData();
  fd.append('file', new Blob([text], { type: 'text/csv' }), 'rendelesek.csv');
  fd.append('preview', preview ? '1' : '0');
  return fd;
};

test('manual order: created as manual, listed with counts and availability', async () => {
  const a = await create({ source: 'shopify', external_id: 'x-1', priority: 'express' });
  assert.match(a.number, /^R-\d{4}-\d{6}$/);
  const [row] = await srv.query('SELECT source, external_id, status, priority FROM orders WHERE id = ?', a.id);
  assert.deepEqual(row, { source: 'manual', external_id: '', status: 'new', priority: 'express' });

  const list = await admin.get('/api/orders');
  assert.equal(list.status, 200);
  const item = list.data.items.find((i) => i.id === a.id);
  assert.equal(item.item_count, 2);
  assert.equal(item.line_count, 1);
  assert.equal(item.availability, 'ok');
  assert.equal(item.partner_code, 'KUTYA');
  assert.equal(item.carrier_name, 'GLS General Logistics Systems Hungary Kft.');
  assert.ok(item.created_at);
  assert.equal(list.data.kpis.new, 1);
  assert.equal(list.data.kpis.express, 1);
  assert.equal(list.data.kpis.fulfillable, 1);
});

test('availability: orders are served express first, then oldest; a short order does not use stock up', async () => {
  // Macskaalom: 25 on the shelf, 2 already taken by the express order above.
  const big = await create({ customer_name: 'Nagy Rendelés', lines: [{ product_id: fx.products.alom, qty: 100 }] });
  const fits = await create({ customer_name: 'Belefér Béla', lines: [{ product_id: fx.products.alom, qty: 20 }] });
  const late = await create({ customer_name: 'Késő Kata', city: 'Szeged', lines: [{ product_id: fx.products.alom, qty: 5 }] });
  const list = await admin.get(`/api/orders?partner_id=${fx.clients.kutya}&limit=100`);
  const av = (id) => list.data.items.find((i) => i.id === id).availability;
  assert.equal(av(big.id), 'short');
  assert.equal(av(fits.id), 'ok');
  assert.equal(av(late.id), 'short');
  assert.equal(list.data.kpis.fulfillable, 2);

  const ok = await admin.get('/api/orders?availability=ok');
  assert.deepEqual(ok.data.items.map((i) => i.customer_name).sort(), ['Belefér Béla', 'Minta Mária']);
  assert.equal(ok.data.total, 2);
  const short = await admin.get('/api/orders?availability=short&limit=1');
  assert.equal(short.data.total, 2);
  assert.equal(short.data.items.length, 1);

  const search = await admin.get('/api/orders?q=szeged');
  assert.deepEqual(search.data.items.map((i) => i.id), [late.id]);
  const byNumber = await admin.get(`/api/orders?q=${encodeURIComponent(late.number)}`);
  assert.equal(byNumber.data.total, 1);
  assert.equal((await admin.get('/api/orders?status=hold')).data.total, 0);
  assert.equal((await admin.get('/api/orders?status=shipped')).status, 400);

  const detail = await admin.get(`/api/orders/${late.id}`);
  assert.equal(detail.data.availability, 'short');
  assert.equal(detail.data.lines[0].available, false);
  assert.equal(detail.data.lines[0].free, 3);
});

test('detail: lines, timeline; readable with orders view or history view', async () => {
  const a = await create({ lines: [{ product_id: fx.products.csont, qty: 3 }, { product_id: fx.products.tap, qty: 1 }], cod_amount: 12990 });
  const d = await admin.get(`/api/orders/${a.id}`);
  assert.equal(d.status, 200);
  assert.equal(d.data.number, a.number);
  assert.deepEqual(d.data.lines.map((l) => [l.sku, l.qty]), [['KB-1003', 3], ['KB-1001', 1]]);
  assert.equal(d.data.events[0].type, 'created');
  assert.equal(d.data.events[0].user_name, 'Teszt Admin');
  assert.equal(d.data.cod_amount, 12990);
  assert.equal(d.data.carrier.carrier_code, 'gls');
  assert.equal(d.data.courier_configured, false);
  assert.deepEqual(d.data.picks, []);
  assert.deepEqual(d.data.returns, []);

  const sales = await srv.userWithRole('sales'); // history view, no orders view
  assert.equal((await sales.get(`/api/orders/${a.id}`)).status, 200);
  assert.equal((await sales.get('/api/orders')).status, 403);
  await srv.sql("INSERT INTO roles (key, name) VALUES ('semmi', 'Semmi')");
  const nobody = await srv.userWithRole('semmi');
  assert.equal((await nobody.get(`/api/orders/${a.id}`)).status, 403);
  assert.equal((await admin.get('/api/orders/999999')).status, 404);
  assert.equal((await admin.get('/api/orders/abc')).status, 404);
});

test('create: validation and permissions', async () => {
  const bad = await admin.post('/api/orders', order({ customer_name: '', lines: [{ product_id: fx.products.robot, qty: 1 }] }));
  assert.equal(bad.status, 400);
  assert.ok(bad.data.error.fields.customer_name);
  const wrongPartner = await admin.post('/api/orders', order({ lines: [{ product_id: fx.products.robot, qty: 1 }] }));
  assert.equal(wrongPartner.status, 400);
  assert.ok(wrongPartner.data.error.fields['lines.0.product_id']);
  const noLines = await admin.post('/api/orders', order({ lines: [] }));
  assert.equal(noLines.status, 400);

  const op = await srv.userWithRole('warehouse_operator'); // orders view only
  assert.equal((await op.get('/api/orders')).status, 200);
  assert.equal((await op.post('/api/orders', order())).status, 403);
  const cs = await srv.userWithRole('customer_service');
  const ok = await cs.post('/api/orders', order({ customer_name: 'Ügyfélszolgálati Rendelés' }));
  assert.equal(ok.status, 200);
  const audit = await srv.query("SELECT actor FROM audit_log WHERE entity = 'order' AND entity_id = ? AND action = 'create'", String(ok.data.id));
  assert.equal(audit[0].actor, 'Teszt customer_service');
});

test('edit: header and lines while new or hold, refused afterwards', async () => {
  const a = await create({ lines: [{ product_id: fx.products.alom, qty: 1 }, { product_id: fx.products.csont, qty: 4 }] });
  const d0 = (await admin.get(`/api/orders/${a.id}`)).data;
  const [alom, csont] = d0.lines;
  const r = await admin.patch(`/api/orders/${a.id}`, {
    city: 'Győr', zip: '9021', cod_amount: 5000, priority: 'express', carrier_id: fx.carriers.foxpost, pickup_point_id: 'FOX-123',
    lines: [{ id: alom.id, product_id: alom.product_id, qty: 3 }, { product_id: fx.products.tap, qty: 1 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.changed.includes('tételek'));
  const d = (await admin.get(`/api/orders/${a.id}`)).data;
  assert.equal(d.city, 'Győr');
  assert.equal(d.priority, 'express');
  assert.equal(d.carrier.id, fx.carriers.foxpost);
  assert.deepEqual(d.lines.map((l) => [l.sku, l.qty]), [['KB-1002', 3], ['KB-1001', 1]]);
  assert.ok(!d.lines.some((l) => l.id === csont.id));
  assert.match(d.events[0].text, /Módosítva: .*szállítási cím.*tételek/);

  const foreign = await admin.patch(`/api/orders/${a.id}`, { lines: [{ product_id: fx.products.mixer, qty: 1 }] });
  assert.equal(foreign.status, 400);
  assert.ok(foreign.data.error.fields['lines.0.product_id']);
  const empty = await admin.patch(`/api/orders/${a.id}`, { customer_name: '' });
  assert.equal(empty.status, 400);
  const nothing = await admin.patch(`/api/orders/${a.id}`, { city: 'Győr' });
  assert.deepEqual(nothing.data.changed, []);

  const op = await srv.userWithRole('warehouse_operator');
  assert.equal((await op.patch(`/api/orders/${a.id}`, { city: 'Pécs' })).status, 403);

  await srv.call('orders.setOrderStatus', [a.id, 'picking'], { as: 1 });
  const late = await admin.patch(`/api/orders/${a.id}`, { city: 'Pécs' });
  assert.equal(late.status, 409);
  assert.match(late.data.error.message, /Csak új vagy felfüggesztett/);
});

test('hold, release and cancel with reasons', async () => {
  const a = await create();
  assert.equal((await admin.post(`/api/orders/${a.id}/hold`, {})).status, 400);
  assert.equal((await admin.post(`/api/orders/${a.id}/hold`, { reason: 'Fizetésre vár' })).status, 200);
  assert.equal((await admin.post(`/api/orders/${a.id}/hold`, { reason: 'Megint' })).status, 409);
  let d = (await admin.get(`/api/orders/${a.id}`)).data;
  assert.equal(d.status, 'hold');
  assert.equal(d.events[0].text, 'Felfüggesztve: Fizetésre vár');
  // Edit is still allowed on hold.
  assert.equal((await admin.patch(`/api/orders/${a.id}`, { note: 'Csengess kétszer' })).status, 200);
  assert.equal((await admin.post(`/api/orders/${a.id}/release`, {})).status, 200);
  assert.equal((await admin.get(`/api/orders/${a.id}`)).data.status, 'new');
  assert.equal((await admin.post(`/api/orders/${a.id}/release`, {})).status, 409);

  const op = await srv.userWithRole('warehouse_operator');
  assert.equal((await op.post(`/api/orders/${a.id}/hold`, { reason: 'x' })).status, 403);
  assert.equal((await op.post(`/api/orders/${a.id}/cancel`, { reason: 'x' })).status, 403);

  assert.equal((await admin.post(`/api/orders/${a.id}/cancel`, {})).status, 400);
  const c = await admin.post(`/api/orders/${a.id}/cancel`, { reason: 'Vevő lemondta' });
  assert.equal(c.status, 200);
  d = (await admin.get(`/api/orders/${a.id}`)).data;
  assert.equal(d.status, 'cancelled');
  assert.ok(d.cancelled_at);
  assert.equal((await admin.post(`/api/orders/${a.id}/cancel`, { reason: 'Megint' })).status, 409);

  const picking = await create();
  await srv.call('orders.setOrderStatus', [picking.id, 'picking'], { as: 1 });
  const refused = await admin.post(`/api/orders/${picking.id}/cancel`, { reason: 'Késő' });
  assert.equal(refused.status, 409);
  assert.equal((await admin.post(`/api/orders/${picking.id}/hold`, { reason: 'x' })).status, 409);

  assert.equal((await admin.post(`/api/orders/${a.id}/notes`, { text: ' ' })).status, 400);
  assert.equal((await admin.post(`/api/orders/${a.id}/notes`, { text: 'Visszahívtuk a vevőt.' })).status, 200);
  assert.equal((await admin.get(`/api/orders/${a.id}`)).data.events[0].text, 'Visszahívtuk a vevőt.');
});

test('CSV import: preview changes nothing, commit creates orders, repeats are skipped', async () => {
  const csv = [
    'Partnerkód;Rendelésszám;Vevő neve;Cég;E-mail;Telefon;Ország;Irányítószám;Város;Cím;Átvételi pont;Futár;Utánvét;Cikkszám;Mennyiség;Megjegyzés',
    'KUTYA;#5001;Kiss Anna;;anna@example.com;+3630111;HU;1051;Budapest;Fő utca 2.;;gls;12 990;KB-1001;1;Kapucsengő: 12',
    'KUTYA;#5001;Kiss Anna;;anna@example.com;+3630111;HU;1051;Budapest;Fő utca 2.;;gls;12 990;KB-1003;2;',
    'konyha;W-77;Nagy Béla;Béla Bt.;;;HU;6000;Kecskemét;Ipari út 9.;FOX-01;foxpost;0;KG-2002;1;',
    'KUTYA;#5002;Tóth Teréz;;;;HU;4024;Debrecen;Piac utca 1.;;gls;;KB-9999;1;',
    'KUTYA;#5002;Tóth Teréz;;;;HU;4024;Debrecen;Piac utca 1.;;gls;;KB-1002;1;',
    ';#5003;Senki;;;;HU;;;;;;;KB-1002;1;',
    'KUTYA;#5004;Hibás Futár;;;;HU;;;;;ups;;KB-1002;x;',
  ].join('\r\n');
  const before = (await srv.query('SELECT COUNT(*) AS n FROM orders'))[0].n;
  const p = await admin.post('/api/orders/import', csvForm(csv, true));
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.rows, 7);
  assert.equal(p.data.valid, 3);
  assert.equal(p.data.orders, 2);
  const msgs = p.data.errors.map((e) => `${e.line}: ${e.message}`);
  assert.ok(msgs.some((m) => /^5: Ismeretlen cikkszám ennél az ügyfélnél: KB-9999/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /^6: .*másik sora hibás/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /^7: Hiányzik a partnerkód/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /^8: Ismeretlen futár: ups/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /^8: Mennyiség/.test(m)), msgs.join('\n'));
  assert.equal(p.data.sample[0].external_number, '#5001');
  assert.equal(p.data.sample[0].items, 3);
  assert.equal((await srv.query('SELECT COUNT(*) AS n FROM orders'))[0].n, before, 'preview creates nothing');

  const c = await admin.post('/api/orders/import', csvForm(csv, false));
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.imported, 2);
  const [o] = await srv.query("SELECT id, source, external_id, external_number, cod_amount, carrier_id, note FROM orders WHERE external_number = '#5001'");
  assert.equal(o.source, 'csv');
  assert.equal(o.cod_amount, 12990);
  assert.equal(o.carrier_id, fx.carriers.gls);
  assert.equal(o.note, 'Kapucsengő: 12');
  const lines = await srv.query('SELECT product_id, qty FROM order_lines WHERE order_id = ? ORDER BY id', o.id);
  assert.deepEqual(lines, [{ product_id: fx.products.tap, qty: 1 }, { product_id: fx.products.csont, qty: 2 }]);
  const [w] = await srv.query("SELECT partner_id, pickup_point_id, carrier_id FROM orders WHERE external_number = 'W-77'");
  assert.deepEqual(w, { partner_id: fx.clients.konyha, pickup_point_id: 'FOX-01', carrier_id: fx.carriers.foxpost });

  const again = await admin.post('/api/orders/import', csvForm(csv, true));
  assert.equal(again.data.valid, 0);
  assert.ok(again.data.errors.some((e) => /már importálva van/.test(e.message)));

  const missingCol = await admin.post('/api/orders/import', csvForm('Cikkszám;Mennyiség\r\nKB-1001;1\r\n', true));
  assert.equal(missingCol.status, 400);
  assert.match(missingCol.data.error.message, /Hiányzó oszlop/);
  const op = await srv.userWithRole('warehouse_operator');
  assert.equal((await op.post('/api/orders/import', csvForm(csv, true))).status, 403);
});
