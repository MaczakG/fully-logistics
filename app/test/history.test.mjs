// Rendeléstörténet: list and filters, export, delivered, notes, returns with restocking and photos.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

let srv;
let admin;
let fx;
let cs; // Ügyfélszolgálat: history view, create, edit
let op; // Raktáros: history view only
const S = {};

const ship = async (lines, over = {}, tracking = '') => {
  const r = await admin.post('/api/orders', {
    partner_id: fx.clients.kutya, customer_name: 'Vevő Vera', zip: '1111', city: 'Budapest', address: 'Fő utca 1.', carrier_id: fx.carriers.gls, lines, ...over,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (const s of ['picking', 'packed', 'shipped']) {
    const res = await srv.call('orders.setOrderStatus', [r.data.id, s, '', s === 'packed' ? { tracking_number: tracking } : {}], { as: 1 });
    assert.equal(res.ok, true, JSON.stringify(res));
  }
  await srv.sql(`UPDATE order_lines SET picked_qty = qty WHERE order_id = ${r.data.id}`);
  return r.data;
};
const stockAt = async (productId, locationId) =>
  (await srv.query('SELECT COALESCE(SUM(qty), 0) AS q FROM stock WHERE product_id = ? AND location_id = ?', productId, locationId))[0].q;

before(async () => {
  srv = await startServer();
  admin = await srv.admin();
  fx = await srv.seedBasics();
  cs = await srv.userWithRole('customer_service');
  op = await srv.userWithRole('warehouse_operator');
  S.one = await ship([{ product_id: fx.products.alom, qty: 2 }, { product_id: fx.products.csont, qty: 3 }], { city: 'Szeged' }, 'GLS-00112233');
  S.two = await ship([{ product_id: fx.products.mixer, qty: 1 }], { partner_id: fx.clients.konyha, carrier_id: fx.carriers.foxpost }, 'FOX-445566');
  const c = await admin.post('/api/orders', { partner_id: fx.clients.kutya, customer_name: 'Lemondó Lajos', lines: [{ product_id: fx.products.tap, qty: 1 }] });
  S.cancelled = c.data;
  await admin.post(`/api/orders/${c.data.id}/cancel`, { reason: 'Lemondta' });
  const open = await admin.post('/api/orders', { partner_id: fx.clients.kutya, customer_name: 'Nyitott Nóra', lines: [{ product_id: fx.products.tap, qty: 1 }] });
  S.open = open.data;
});
after(async () => { await srv.stop(); });

test('list: closed orders only, filters and KPIs', async () => {
  const all = await admin.get('/api/history');
  assert.equal(all.status, 200);
  assert.deepEqual(all.data.items.map((i) => i.id).sort(), [S.one.id, S.two.id, S.cancelled.id].sort());
  assert.deepEqual(all.data.kpis, { shipped: 2, delivered: 0, returned: 0, cancelled: 1 });
  const first = all.data.items.find((i) => i.id === S.one.id);
  assert.equal(first.item_count, 5);
  assert.equal(first.tracking_number, 'GLS-00112233');
  assert.ok(first.shipped_date);

  const byTracking = await admin.get('/api/history?q=00112233');
  assert.deepEqual(byTracking.data.items.map((i) => i.id), [S.one.id]);
  const byCity = await admin.get('/api/history?q=szeged');
  assert.deepEqual(byCity.data.items.map((i) => i.id), [S.one.id]);
  const byClient = await admin.get(`/api/history?partner_id=${fx.clients.konyha}`);
  assert.deepEqual(byClient.data.items.map((i) => i.id), [S.two.id]);
  assert.deepEqual(byClient.data.kpis, { shipped: 1, delivered: 0, returned: 0, cancelled: 0 });
  const byCarrier = await admin.get(`/api/history?carrier_id=${fx.carriers.foxpost}`);
  assert.deepEqual(byCarrier.data.items.map((i) => i.id), [S.two.id]);
  const cancelled = await admin.get('/api/history?status=cancelled');
  assert.deepEqual(cancelled.data.items.map((i) => i.id), [S.cancelled.id]);

  const today = first.shipped_date;
  const shippedToday = await admin.get(`/api/history?date_field=shipped&from=${today}&to=${today}`);
  assert.equal(shippedToday.data.total, 2, 'cancelled orders have no shipping date');
  const createdToday = await admin.get(`/api/history?date_field=created&from=${today}&to=${today}`);
  assert.equal(createdToday.data.total, 3);
  const future = await admin.get('/api/history?date_field=created&from=2099-01-01');
  assert.equal(future.data.total, 0);
  assert.equal((await admin.get('/api/history?from=2026-13-01')).status, 400);
  assert.equal((await admin.get('/api/history?status=new')).status, 400);
  assert.equal((await admin.get('/api/history?limit=1')).data.items.length, 1);

  const sales = await srv.userWithRole('sales');
  assert.equal((await sales.get('/api/history')).status, 200);
  await srv.sql("INSERT INTO roles (key, name) VALUES ('semmi', 'Semmi')");
  const nobody = await srv.userWithRole('semmi');
  assert.equal((await nobody.get('/api/history')).status, 403);
  assert.equal((await nobody.get('/api/history/export')).status, 403);
});

test('export: semicolon CSV with BOM and the same filters', async () => {
  const res = await admin.get(`/api/history/export?partner_id=${fx.clients.kutya}`, { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /rendelestortenet-\d{4}-\d{2}-\d{2}\.csv/);
  const buf = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...buf.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(buf).replace(/^﻿/, '');
  const lines = text.trim().split('\r\n');
  assert.match(lines[0], /^Rendelésszám;Külső rendelésszám;Ügyfélkód;Ügyfél;Állapot;Vevő/);
  assert.equal(lines.length, 3);
  assert.ok(lines.some((l) => l.startsWith(`${S.one.number};`) && l.includes(';Feladva;') && l.includes('GLS-00112233')));
  assert.ok(!text.includes(S.two.number));
});

test('delivered and notes need history edit', async () => {
  assert.equal((await op.post(`/api/history/${S.two.id}/delivered`, {})).status, 403);
  const ok = await cs.post(`/api/history/${S.two.id}/delivered`, {});
  assert.equal(ok.status, 200);
  const d = (await admin.get(`/api/orders/${S.two.id}`)).data;
  assert.equal(d.status, 'delivered');
  assert.ok(d.delivered_at);
  assert.equal((await cs.post(`/api/history/${S.two.id}/delivered`, {})).status, 409);
  assert.equal((await cs.post(`/api/history/${S.open.id}/delivered`, {})).status, 409);

  assert.equal((await op.post(`/api/history/${S.two.id}/notes`, { text: 'x' })).status, 403);
  assert.equal((await cs.post(`/api/history/${S.two.id}/notes`, { text: '' })).status, 400);
  assert.equal((await cs.post(`/api/history/${S.two.id}/notes`, { text: 'A vevő megerősítette az átvételt.' })).status, 200);
  const ev = (await admin.get(`/api/orders/${S.two.id}`)).data.events[0];
  assert.equal(ev.type, 'note');
  assert.equal(ev.user_name, 'Teszt customer_service');
});

test('return: sellable to the returns zone or a chosen location, damaged to quarantine', async () => {
  const opts = await admin.get(`/api/history/${S.one.id}/return-options`);
  assert.equal(opts.status, 200);
  assert.equal(opts.data.can_return, true);
  assert.deepEqual(opts.data.lines.map((l) => [l.sku, l.qty, l.returnable]), [['KB-1002', 2, 2], ['KB-1003', 3, 3]]);
  assert.equal(opts.data.lines[0].suggested_location.code, 'B-01-03');
  assert.deepEqual(opts.data.returns_zones.map((z) => z.code), ['VISSZARU']);
  assert.deepEqual(opts.data.quarantine_zones.map((z) => z.code), ['KARANTEN']);

  assert.equal((await op.post(`/api/history/${S.one.id}/returns`, { lines: [{ product_id: fx.products.alom, qty: 1, condition: 'sellable' }] })).status, 403);
  const wrongProduct = await cs.post(`/api/history/${S.one.id}/returns`, { lines: [{ product_id: fx.products.tap, qty: 1, condition: 'sellable' }] });
  assert.equal(wrongProduct.status, 400);
  assert.ok(wrongProduct.data.error.fields['lines.0.product_id']);
  const tooMany = await cs.post(`/api/history/${S.one.id}/returns`, { lines: [{ product_id: fx.products.alom, qty: 3, condition: 'sellable' }] });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error.fields['lines.0.qty'], /Legfeljebb 2/);
  const damagedToShelf = await cs.post(`/api/history/${S.one.id}/returns`, { lines: [{ product_id: fx.products.csont, qty: 1, condition: 'damaged', location_code: 'A-01-01' }] });
  assert.equal(damagedToShelf.status, 400);
  assert.match(damagedToShelf.data.error.fields['lines.0.location_id'], /karantén/);
  const otherPartner = await cs.post(`/api/history/${S.one.id}/returns`, { lines: [{ product_id: fx.products.alom, qty: 1, condition: 'sellable', location_code: 'A-01-02' }] });
  assert.equal(otherPartner.status, 400);
  assert.match(otherPartner.data.error.fields['lines.0.location_id'], /Egy helyen csak egy partner áruja lehet/);
  assert.equal((await srv.query('SELECT COUNT(*) AS n FROM returns'))[0].n, 0, 'refusals record nothing');

  const r = await cs.post(`/api/history/${S.one.id}/returns`, {
    reason: 'Elállás (14 nap)', note: 'A doboz sérült',
    lines: [
      { product_id: fx.products.alom, qty: 1, condition: 'sellable' },
      { product_id: fx.products.alom, qty: 1, condition: 'sellable', location_code: 'b-01-03' },
      { product_id: fx.products.csont, qty: 2, condition: 'damaged' },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.number, /^VR-\d{4}-\d{5}$/);
  S.ret = r.data.id;
  assert.equal(await stockAt(fx.products.alom, fx.locations.returns), 1);
  assert.equal(await stockAt(fx.products.alom, 20), 26);
  assert.equal(await stockAt(fx.products.csont, fx.locations.quarantine), 2);
  const mv = await srv.query("SELECT location_id, qty, ref_type, ref_id FROM movements WHERE type = 'return' ORDER BY id");
  assert.deepEqual(mv.map((m) => [m.location_id, m.qty, m.ref_type, m.ref_id]), [[2, 1, 'return', S.ret], [20, 1, 'return', S.ret], [3, 2, 'return', S.ret]]);
  // Quarantine stock is on hand but not available.
  const av = (await srv.call('stock.availability', [[fx.products.csont]])).result[fx.products.csont];
  assert.equal(av.blocked, 2);

  const d = (await admin.get(`/api/orders/${S.one.id}`)).data;
  assert.equal(d.status, 'returned');
  assert.match(d.events[0].text, /Visszáru rögzítve: VR-.*4 db \(ebből sérült 2\).*KB-1003 2 db \(KARANTEN\).*Ok: Elállás/);
  assert.equal(d.returns.length, 1);
  assert.deepEqual(d.returns[0].lines.map((l) => [l.sku, l.qty, l.condition, l.location_code]),
    [['KB-1002', 1, 'sellable', 'VISSZARU'], ['KB-1002', 1, 'sellable', 'B-01-03'], ['KB-1003', 2, 'damaged', 'KARANTEN']]);
  assert.equal(d.lines.find((l) => l.sku === 'KB-1002').returned_qty, 2);

  // A second parcel for the same order: only what is left may come back.
  const left = await cs.post(`/api/history/${S.one.id}/returns`, { lines: [{ product_id: fx.products.alom, qty: 1, condition: 'sellable' }] });
  assert.equal(left.status, 400);
  assert.match(left.data.error.fields['lines.0.qty'], /már mindent visszaküldtek/);
  const second = await cs.post(`/api/history/${S.one.id}/returns`, { lines: [{ product_id: fx.products.csont, qty: 1, condition: 'sellable' }] });
  assert.equal(second.status, 200);
  const list = await admin.get(`/api/history/${S.one.id}/returns`);
  assert.equal(list.data.items.length, 2);
  assert.equal((await admin.get('/api/history?status=returned')).data.total, 1);

  const cancelled = await cs.post(`/api/history/${S.cancelled.id}/returns`, { lines: [{ product_id: fx.products.tap, qty: 1, condition: 'sellable' }] });
  assert.equal(cancelled.status, 409);
});

test('return photos: images only, readable with history view', async () => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const form = (blob, name) => { const f = new FormData(); f.append('file', blob, name); return f; };
  assert.equal((await op.post(`/api/history/returns/${S.ret}/photos`, form(new Blob([png], { type: 'image/png' }), 'doboz.png'))).status, 403);
  const bad = await cs.post(`/api/history/returns/${S.ret}/photos`, form(new Blob(['hello'], { type: 'text/plain' }), 'jegyzet.txt'));
  assert.equal(bad.status, 400);
  const ok = await cs.post(`/api/history/returns/${S.ret}/photos`, form(new Blob([png], { type: 'image/png' }), 'doboz.png'));
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const d = (await admin.get(`/api/orders/${S.one.id}`)).data;
  assert.deepEqual(d.returns[0].photos.map((p) => p.filename), ['doboz.png']);
  const [doc] = await srv.query('SELECT kind, partner_id FROM documents WHERE id = ?', ok.data.id);
  assert.deepEqual(doc, { kind: 'photo', partner_id: fx.clients.kutya });
  const file = await op.get(`/api/documents/${ok.data.id}?inline=1`, { raw: true });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal((await cs.post('/api/history/returns/99999/photos', form(new Blob([png], { type: 'image/png' }), 'x.png'))).status, 404);
});
