// Ajánlatkészítő: defaults, partner tariff loading, quote CRUD with server-side monthly_net,
// duplicate, permissions, and the calculation (browser calc() and server quoteTotals() agree,
// and match the owner's original calculator on its example).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { startServer } from './helpers.mjs';
import { normalizeQuoteData, quoteTotals } from '../worker/routes/quotes.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');

// The owner's example from the original calculator (ajanlat-kalkulator.html CLIENT_DEFAULTS).
const EXAMPLE = {
  client: { name: 'Példa Webshop Kft.', contact: 'Kovács Anna', email: 'anna@peldawebshop.hu', shop: 'peldawebshop.hu' },
  offerDate: '2026-10-16',
  validDays: 30,
  volume: { orders: 300, avg: 1.5, inbound: 450, retPct: 3, moveIn: 3000 },
  storage: [{ code: 'M', name: 'Polchely M', qty: 20, price: 780 }, { code: 'L', name: 'Polchely L', qty: 15, price: 990 }, { code: 'XL', name: 'Polchely XL', qty: 5, price: 1350 }, { code: 'PAL', name: 'Raklaphely', qty: 0, price: 0 }],
  tariffs: { order_base: 600, item_2: 80, item_3: 60, item_extra: 50, packaging: 150, inbound_unit: 49, return_unit: 499, vat_pct: 27, discount_handling_pct: 10, discount_storage_pct: 0 },
  discounts: { freeMoveIn: 3000, freeStorageMonths: 1, priceLockMonths: 12 },
  terms: ['Az árak nettó árak.'],
  internal: {
    rent: 2400000, area_m2: 1200, worker_cost: 520000, worker_hours: 150,
    // m² per location: M 1.5 / (5 x 2) = 0.15, L 2 / (4 x 2) = 0.25, XL 1.2 / 3 = 0.4, PAL 7.2 / (3 x 2) = 1.2
    racks: { M: { area: 1.5, levels: 5, per_level: 2 }, L: { area: 2, levels: 4, per_level: 2 }, XL: { area: 1.2, levels: 3, per_level: 1 }, PAL: { area: 7.2, levels: 3, per_level: 2 } },
    min_order: 3, min_item: 0.5, min_inbound: 0.3, min_return: 5, costPack: 100,
  },
};

function loadBrowserView() {
  const FL = { views: {} };
  FL.view = (key, def) => { FL.views[key] = def; };
  const context = vm.createContext({ window: { FL }, Intl, console });
  vm.runInContext(readFileSync(join(APP, 'public/assets/js/views/quotes.js'), 'utf8'), context, { filename: 'quotes.js' });
  return FL.views.quotes;
}
const loadBrowserCalc = () => loadBrowserView().calc;

let srv;
let fx;
let admin;
let sales;     // quotes: view, create, edit, delete
let manager;   // quotes: view only
let service;   // no quotes access
before(async () => {
  srv = await startServer();
  admin = await srv.admin();
  fx = await srv.seedBasics();
  sales = await srv.userWithRole('sales');
  manager = await srv.userWithRole('warehouse_manager');
  service = await srv.userWithRole('customer_service');
});
after(async () => { await srv.stop(); });

const okData = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };

test('calculation: the original example, and browser and server agree', () => {
  const d = normalizeQuoteData(EXAMPLE);
  const t = quoteTotals(d);
  // 300 x 600 + 300 x 40 (avg 1.5) + 300 x 150 - 10% of handling + 37 200 storage + 450 x 49 + 9 x 499
  assert.equal(Math.round(t.net * 100) / 100, 281541);
  assert.equal(Math.round(t.gross * 100) / 100, 357557.07);
  assert.equal(Math.round(t.oneOff), 147000 + 37200);
  assert.equal(Math.round(t.perOrder * 100) / 100, 938.47);

  const calc = loadBrowserCalc();
  const browser = calc(d);
  assert.equal(Math.round(browser.net * 100) / 100, 281541);
  assert.deepEqual(Array.from(browser.items.filter((i) => i.grp), (i) => i.grp), ['Rendeléskezelés', 'Tárolás', 'Áruátvétel és visszáru']);
  assert.ok(browser.items.some((i) => i.disc && /10%/.test(i.name)));

  const variants = [
    EXAMPLE,
    { ...EXAMPLE, volume: { ...EXAMPLE.volume, avg: 2.7, hours: 12, codOrders: 80, codAvg: 14990 }, tariffs: { ...EXAMPLE.tariffs, hourly_work: 6500, cod_fixed: 150, cod_pct: 1.2 } },
    { ...EXAMPLE, volume: { ...EXAMPLE.volume, avg: 5.25, retPct: 150 }, tariffs: { ...EXAMPLE.tariffs, discount_handling_pct: 250, discount_storage_pct: 15, vat_pct: 0 } },
    { ...EXAMPLE, customItems: [{ name: 'Dedikált ügyfélszolgálat', kind: 'monthly', price: 25000, qty: 1 }, { name: 'Raklapfóliázás', kind: 'per_unit', unit: 'raklap', price: 1500, qty: 6 }, { name: '', price: 999, qty: 9 }] },
    { volume: { orders: 0 }, storage: [], tariffs: {}, discounts: { freeStorageMonths: 2 } },
    { ...EXAMPLE, volume: { orders: '120', avg: '1,4', inbound: -5 }, storage: [{ code: 'M', qty: '3', price: '780' }], discounts: { freeMoveIn: 100, freeStorageMonths: 2.6 } },
  ];
  for (const v of variants) {
    const nd = normalizeQuoteData(v);
    const s = quoteTotals(nd);
    const b = calc(nd);
    for (const k of ['net', 'vat', 'gross', 'perOrder', 'yearly', 'storNetMonthly']) {
      assert.ok(Math.abs(s[k] - b[k]) < 0.005, `${k}: server ${s[k]} browser ${b[k]} for ${JSON.stringify(v).slice(0, 80)}`);
    }
    assert.ok(Math.abs(s.oneOff - b.oneOffTotal) < 0.005, 'one-off total');
  }
});

test('internal costing: staff from the minute norms, area and rent by occupancy, margin', () => {
  const { calc, costing } = loadBrowserView();
  const d = normalizeQuoteData(EXAMPLE);
  const r = calc(d);
  const k = costing(d, r);
  // 300 orders x 3 min + 150 further items x 0.5 + 450 pieces x 0.3 + 9 returns x 5 = 1155 min
  assert.equal(k.hours, 19.25);
  assert.equal(Math.round(k.staff * 10000) / 10000, 0.1283);
  assert.equal(Math.round(k.labour), 66733);
  // 2 400 000 Ft / 1 200 m² = 2 000 Ft per m²; 20 M x 0.15 + 15 L x 0.25 + 5 XL x 0.4 = 8.75 m²
  assert.equal(k.rentPerM2, 2000);
  assert.equal(k.area, 8.75);
  assert.equal(k.rent, 17500);
  const m = k.sizes.find((s) => s.code === 'M');
  assert.equal(m.m2, 0.15);
  assert.equal(m.fits, 8000);
  assert.equal(m.rentPer, 300);
  assert.equal(k.sizes.find((s) => s.code === 'PAL').rentPer, 2400);
  assert.equal(k.pack, 30000);
  assert.equal(Math.round(k.cost), 114233);
  assert.equal(Math.round(k.margin), 167308);
  assert.equal(Math.round(k.pct * 100) / 100, 59.43);
  assert.deepEqual(JSON.parse(JSON.stringify(k.missing)), { rent: false, staff: false, racks: [] });
  // 3000 pieces moving in: 15 hours once, outside the monthly cost
  assert.equal(k.moveInHours, 15);

  // Nothing set: no cost, and the screen says what is missing.
  const empty = normalizeQuoteData({ ...EXAMPLE, internal: {} });
  const e = costing(empty, calc(empty));
  assert.equal(e.cost, 0);
  assert.equal(e.staff, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(e.missing)), { rent: true, staff: true, racks: ['M', 'L', 'XL'] });
  // A rack without levels takes no area.
  const half = normalizeQuoteData({ ...EXAMPLE, internal: { ...EXAMPLE.internal, racks: { ...EXAMPLE.internal.racks, M: { area: 1.5, levels: 0, per_level: 2 } } } });
  assert.deepEqual(Array.from(costing(half, calc(half)).missing.racks), ['M']);

  // The server keeps the assumptions, cleans them, and drops the old per order labour cost.
  const n = normalizeQuoteData({ internal: { costLabor: 450, costSpace: 250, rent: '-5', area_m2: '1 200', worker_hours: 9999, costPack: '120', racks: { M: { area: '1,1', levels: 5, per_level: 'x' } } } });
  assert.deepEqual(n.internal, {
    rent: 0, area_m2: 1200, worker_cost: 0, worker_hours: 744, min_order: 0, min_item: 0, min_inbound: 0, min_return: 0,
    racks: { M: { area: 1.1, levels: 5, per_level: 0 } }, costPack: 120,
  });
  // A quote saved with the earlier m² per location: one level, one location each.
  const old = normalizeQuoteData({ internal: { worker_hours: 150, space: { M: 0.2, PAL: 1.5 } } });
  assert.deepEqual(old.internal.racks, { M: { area: 0.2, levels: 1, per_level: 1 }, PAL: { area: 1.5, levels: 1, per_level: 1 } });
});

test('defaults: company, default tariffs, terms, active sizes, tariff list', async () => {
  const d = okData(await manager.get('/api/quotes/defaults'));
  assert.equal(d.company.name, 'Fully Logistics');
  assert.equal(d.default_tariffs.order_base, 600);
  assert.equal(d.default_tariffs.storage.M, 780);
  assert.equal(d.quote_terms.length, 6);
  assert.deepEqual(d.sizes.map((s) => s.code), ['M', 'L', 'XL', 'PAL']);
  assert.equal(d.tariffs.length, 13);
  assert.equal(d.costing.worker_hours, 150, 'the costing assumptions come with the defaults');
  assert.equal((await service.get('/api/quotes/defaults')).status, 403);
});

test('partner tariffs for the calculator: defaults when missing, then the client\'s own', async () => {
  const p0 = okData(await manager.get(`/api/quotes/partner/${fx.clients.konyha}`));
  assert.equal(p0.partner.code, 'KONYHA');
  assert.equal(p0.tariffs.order_base, 600, 'no tariff rows yet: defaults');
  assert.equal(p0.storage.find((s) => s.code === 'XL').price, 1350);
  assert.equal(p0.contact.name, 'Konyhagép Gyártó Zrt.');
  assert.equal(p0.contact.address, '6000 Kecskemét, Ipari út 5.');
  assert.equal(p0.contact.billing_email, 'penzugy@konyhagep.example');

  const sizes = okData(await admin.get(`/api/partners/${fx.clients.konyha}/tariffs`)).storage;
  okData(await admin.put(`/api/partners/${fx.clients.konyha}/tariffs`, { tariffs: { order_base: 520, item_2: 70 }, storage: { [sizes.find((s) => s.code === 'XL').size_id]: 1200 } }));
  okData(await admin.post(`/api/partners/${fx.clients.konyha}/contacts`, { name: 'Gép Gábor', email: 'gabor@konyhagep.example', phone: '+36 1 234 5678' }));
  okData(await admin.post(`/api/partners/${fx.clients.konyha}/custom-items`, { name: 'Szettképzés', price: 90, kind: 'per_unit', unit: 'szett' }));
  okData(await admin.post(`/api/partners/${fx.clients.konyha}/custom-items`, { name: 'Régi tétel', price: 1, active: false }));
  const p1 = okData(await manager.get(`/api/quotes/partner/${fx.clients.konyha}`));
  assert.equal(p1.tariffs.order_base, 520);
  assert.equal(p1.tariffs.item_3, 60);
  assert.equal(p1.storage.find((s) => s.code === 'XL').price, 1200);
  assert.equal(p1.contact.contact_name, 'Gép Gábor');
  assert.deepEqual(p1.custom_items.map((c) => c.name), ['Szettképzés'], 'only active custom items');

  assert.equal((await manager.get(`/api/quotes/partner/${fx.carriers.gls}`)).status, 400);
  assert.equal((await manager.get('/api/quotes/partner/9999')).status, 404);
  assert.equal((await service.get(`/api/quotes/partner/${fx.clients.konyha}`)).status, 403);
});

test('quotes: create with number and server-computed monthly net, list, update, duplicate, delete', async () => {
  const created = okData(await sales.post('/api/quotes', { partner_id: fx.clients.kutya, data: EXAMPLE }));
  assert.match(created.number, /^AJ-\d{4}-\d{5}$/);
  assert.equal(created.status, 'draft');
  assert.equal(created.client_name, 'Példa Webshop Kft.');
  assert.equal(created.monthly_net, 281541);
  assert.equal(created.partner_code, 'KUTYA');
  assert.equal(created.data.volume.orders, 300);
  assert.equal(created.data.version, 1);
  assert.deepEqual(created.data.terms, ['Az árak nettó árak.']);

  // monthly_net is never taken from the browser.
  const forged = okData(await sales.post('/api/quotes', { data: { ...EXAMPLE, client: { name: 'Hamis' } }, monthly_net: 1 }));
  assert.equal(forged.monthly_net, 281541);

  const list = okData(await manager.get('/api/quotes'));
  assert.equal(list.total, 2);
  assert.ok(list.items.every((q) => q.monthly_net === 281541));
  assert.ok(!('data' in list.items[0]), 'the list does not carry the full state');
  const found = okData(await manager.get('/api/quotes?q=Hamis'));
  assert.deepEqual(found.items.map((q) => q.id), [forged.id]);
  const byPartner = okData(await manager.get(`/api/quotes?partner_id=${fx.clients.kutya}`));
  assert.deepEqual(byPartner.items.map((q) => q.id), [created.id]);

  const upd = okData(await sales.patch(`/api/quotes/${created.id}`, { status: 'sent', data: { ...EXAMPLE, volume: { ...EXAMPLE.volume, orders: 400 } } }));
  assert.equal(upd.status, 'sent');
  assert.ok(upd.monthly_net > 281541);
  assert.equal((await manager.get('/api/quotes?status=sent')).data.total, 1);
  const statusOnly = okData(await sales.patch(`/api/quotes/${created.id}`, { status: 'accepted' }));
  assert.equal(statusOnly.monthly_net, upd.monthly_net);
  const audit = await srv.query("SELECT summary FROM audit_log WHERE entity = 'quote' AND entity_id = ? ORDER BY id", String(created.id));
  assert.match(audit.at(-1).summary, /állapot: elfogadva/);

  const copy = okData(await sales.post(`/api/quotes/${created.id}/duplicate`));
  assert.notEqual(copy.number, created.number);
  assert.equal(copy.status, 'draft');
  assert.equal(copy.monthly_net, upd.monthly_net);
  assert.equal(copy.partner_id, fx.clients.kutya);

  okData(await sales.del(`/api/quotes/${copy.id}`));
  assert.equal((await manager.get(`/api/quotes/${copy.id}`)).status, 404);
});

test('quotes: validation of partner and data', async () => {
  assert.equal((await sales.post('/api/quotes', {})).status, 400);
  assert.equal((await sales.post('/api/quotes', { data: [1, 2] })).status, 400);
  const carrier = await sales.post('/api/quotes', { partner_id: fx.carriers.gls, data: EXAMPLE });
  assert.equal(carrier.status, 400);
  assert.ok(carrier.data.error.fields.partner_id);
  assert.equal((await sales.post('/api/quotes', { status: 'lost', data: EXAMPLE })).status, 400);
  const huge = await sales.post('/api/quotes', { data: { ...EXAMPLE, terms: Array.from({ length: 400 }, () => 'x'.repeat(600)) } });
  assert.equal(huge.status, 400);
  // Junk inside the state is cleaned, not stored.
  const junk = okData(await sales.post('/api/quotes', { data: { volume: { orders: 'sok', avg: -2 }, storage: [{ qty: 5 }], customItems: [{ price: 5 }], offerDate: 'tegnap', extra: '<script>' } }));
  assert.equal(junk.data.volume.orders, 0);
  assert.deepEqual(junk.data.storage, []);
  assert.deepEqual(junk.data.customItems, []);
  assert.match(junk.data.offerDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!('extra' in junk.data));
  assert.equal((await sales.get('/api/quotes/abc')).status, 404);
});

test('quotes: permissions', async () => {
  const q = okData(await sales.post('/api/quotes', { data: EXAMPLE }));
  assert.equal((await manager.get(`/api/quotes/${q.id}`)).status, 200);
  assert.equal((await manager.post('/api/quotes', { data: EXAMPLE })).status, 403);
  assert.equal((await manager.patch(`/api/quotes/${q.id}`, { status: 'sent' })).status, 403);
  assert.equal((await manager.post(`/api/quotes/${q.id}/duplicate`)).status, 403);
  assert.equal((await manager.del(`/api/quotes/${q.id}`)).status, 403);
  assert.equal((await service.get('/api/quotes')).status, 403);
  assert.equal((await service.get(`/api/quotes/${q.id}`)).status, 403);
});
