// Demo data seeder (server/demo-seed.mjs): runs in process on a fresh database without a server,
// fills every screen with consistent data through the app's own API, is idempotent, and removing
// it leaves real data and the foreign keys intact.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Database } from '../server/d1.mjs';
import { DiskBucket } from '../server/bucket.mjs';
import { createAssets } from '../server/assets.mjs';
import { migrate } from '../server/migrate.mjs';
import { seedDemo, removeDemo, openApi } from '../server/demo-seed.mjs';
import { passwordHash, ENCRYPTION_KEY, SETUP_TOKEN } from './helpers.mjs';
import worker from '../worker/index.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'fl-demo-seed-'));
let DB;
let env;
let api;
let adminId;
const real = {};
const logs = [];

const rows = (sql, ...args) => DB.prepare(sql).bind(...args).all().then((r) => r.results);
const one = async (sql, ...args) => (await rows(sql, ...args))[0];
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Budapest' }).format(new Date());

// Row count of every table.
async function tableCounts() {
  const tables = await rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const out = {};
  for (const t of tables) out[t.name] = (await one(`SELECT COUNT(*) AS n FROM "${t.name}"`)).n;
  return out;
}

// The real (non-demo) rows the test created, as they are in the database.
async function realRows() {
  return {
    partner: await one('SELECT * FROM partners WHERE id = ?', real.partner),
    tariffs: await rows('SELECT * FROM partner_tariffs WHERE partner_id = ? ORDER BY key', real.partner),
    storage: await rows('SELECT * FROM partner_storage_prices WHERE partner_id = ? ORDER BY size_id', real.partner),
    contacts: await rows('SELECT * FROM partner_contacts WHERE partner_id = ? ORDER BY id', real.partner),
    product: await one('SELECT * FROM products WHERE id = ?', real.product),
    order: await one('SELECT * FROM orders WHERE id = ?', real.order),
    lines: await rows('SELECT * FROM order_lines WHERE order_id = ? ORDER BY id', real.order),
    events: await rows('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', real.order),
  };
}

before(async () => {
  if (!existsSync(join(APP, 'dist', 'index.html'))) execFileSync('node', ['build.mjs'], { cwd: APP, stdio: 'ignore' });
  const dbPath = join(dir, 'db.sqlite');
  await migrate(dbPath, { log: () => {} });
  DB = new D1Database(dbPath);
  env = { SETUP_TOKEN, ENCRYPTION_KEY, DB, FILES: new DiskBucket(join(dir, 'files')), ASSETS: createAssets(join(APP, 'dist')) };
  const res = await DB.prepare('INSERT INTO users (email, name, role_id, password_hash) VALUES (?, ?, (SELECT id FROM roles WHERE key = ?), ?)')
    .bind('admin@example.com', 'Teszt Admin', 'admin', passwordHash('jelszo-12345')).run();
  adminId = res.meta.last_row_id;
  api = await openApi({ worker, env, userId: adminId });

  // Real data first: a client with a product and an order, through the API.
  real.partner = (await api.post('/api/partners', {
    type: 'client', code: 'VALODI', name: 'Valódi Ügyfél Kft.', tax_number: '12345678-2-41', zip: '1111', city: 'Budapest', address: 'Fő utca 1.',
  })).id;
  await api.post(`/api/partners/${real.partner}/contacts`, { name: 'Valódi Vilma', email: 'vilma@valodi.example' });
  real.product = (await api.post('/api/products', { partner_id: real.partner, sku: 'VAL-1', name: 'Valódi termék', ean: '5990000099990', min_stock: 3 })).id;
  real.order = (await api.post('/api/orders', {
    partner_id: real.partner, customer_name: 'Valódi Vevő', zip: '1111', city: 'Budapest', address: 'Fő utca 2.', lines: [{ product_id: real.product, qty: 1 }],
  })).id;
  real.before = await realRows();

  const out = await seedDemo({ worker, env, adminId, log: (m) => logs.push(m) });
  assert.equal(out.created, true);
});

after(async () => {
  if (api) await api.close();
  if (DB) DB.close();
  rmSync(dir, { recursive: true, force: true });
});

test('seed: partners, locations, products and the summary', async () => {
  const partners = await api.get('/api/partners?q=DEMO-&limit=100');
  assert.deepEqual(partners.counts, { all: 6, client: 3, carrier: 2, supplier: 1 });
  assert.ok(partners.items.every((p) => p.code.startsWith('DEMO-')));
  const gls = partners.items.find((p) => p.code === 'DEMO-GLS');
  assert.equal(gls.carrier_code, 'gls');
  assert.equal(partners.items.find((p) => p.code === 'DEMO-FOXPOST').carrier_code, 'foxpost');
  const client = partners.items.find((p) => p.code === 'DEMO-MANCS');
  assert.ok(client.tax_number && client.billing_email && client.contact_name);
  const contacts = await rows("SELECT p.code, COUNT(c.id) AS n FROM partners p JOIN partner_contacts c ON c.partner_id = p.id WHERE p.type = 'client' AND p.code LIKE 'DEMO-%' GROUP BY p.id");
  assert.equal(contacts.length, 3);
  assert.ok(contacts.every((c) => c.n >= 1 && c.n <= 2));

  const setting = JSON.parse((await one("SELECT value FROM settings WHERE key = 'demo_data'")).value);
  assert.ok(setting.created_at);
  assert.ok(setting.location_ids.length >= 22, 'storage zones and the special locations were created');
  const kinds = await rows(`SELECT kind, COUNT(*) AS n FROM locations WHERE id IN (SELECT value FROM json_each(?)) GROUP BY kind`, JSON.stringify(setting.location_ids));
  assert.deepEqual(kinds.map((k) => k.kind).sort(), ['quarantine', 'receiving', 'returns', 'storage']);
  const sizes = await rows(`SELECT DISTINCT z.code FROM locations l JOIN location_sizes z ON z.id = l.size_id WHERE l.kind = 'storage' AND l.id IN (SELECT value FROM json_each(?))`, JSON.stringify(setting.location_ids));
  assert.deepEqual(sizes.map((s) => s.code).sort(), ['L', 'M', 'PAL', 'XL']);

  const products = await api.get('/api/products?q=DEMO-&limit=100');
  assert.ok(products.total >= 12);
  const demoProducts = await rows("SELECT * FROM products WHERE sku LIKE 'DEMO-%'");
  assert.equal(demoProducts.length, 12);
  assert.ok(demoProducts.some((p) => p.track_lot && p.track_expiry));
  assert.ok(demoProducts.every((p) => /^\d{13}$/.test(p.ean) && p.weight_kg > 0));
  assert.match(logs.join('\n'), /Rendelések: 17/);
});

test('stock: non-zero quantities, low and out of stock items, ledger matches stock', async () => {
  const stock = await api.get('/api/stock?q=DEMO-&limit=100');
  assert.equal(stock.total, 12);
  assert.ok(stock.items.filter((i) => i.on_hand > 0).length >= 9);
  assert.ok(stock.summary.on_hand > 400);
  assert.ok(stock.summary.low >= 1, 'some products are below the minimum');
  assert.ok(stock.summary.out >= 1, 'some products are out of stock');
  assert.ok(stock.items.some((i) => i.blocked > 0), 'damaged return in quarantine');

  // Every stock row equals the sum of its movements, and no movement sum is left without stock.
  const mismatched = await rows(`
    SELECT s.product_id, s.location_id, s.lot, s.expiry, s.qty,
           (SELECT COALESCE(SUM(m.qty), 0) FROM movements m WHERE m.product_id = s.product_id AND m.location_id = s.location_id
              AND m.lot = s.lot AND m.expiry = s.expiry) AS ledger
    FROM stock s WHERE s.qty <> (SELECT COALESCE(SUM(m.qty), 0) FROM movements m WHERE m.product_id = s.product_id
      AND m.location_id = s.location_id AND m.lot = s.lot AND m.expiry = s.expiry)`);
  assert.deepEqual(mismatched, []);
  const orphans = await rows(`
    SELECT m.product_id, m.location_id, m.lot, m.expiry, SUM(m.qty) AS q FROM movements m
    GROUP BY m.product_id, m.location_id, m.lot, m.expiry
    HAVING q <> COALESCE((SELECT s.qty FROM stock s WHERE s.product_id = m.product_id AND s.location_id = m.location_id
      AND s.lot = m.lot AND s.expiry = m.expiry), 0)`);
  assert.deepEqual(orphans, []);
  const types = (await rows("SELECT DISTINCT m.type FROM movements m JOIN products p ON p.id = m.product_id WHERE p.sku LIKE 'DEMO-%'")).map((m) => m.type).sort();
  assert.deepEqual(types, ['inbound', 'pick', 'return']);
  assert.deepEqual(await rows('PRAGMA foreign_key_check'), []);
});

test('inbound: completed, partly received, expected and overdue', async () => {
  const list = await api.get('/api/inbound?limit=100');
  const demo = list.items.filter((i) => i.partner_code.startsWith('DEMO-'));
  assert.equal(demo.length, 5);
  const by = (s) => demo.filter((i) => i.status === s);
  assert.equal(by('completed').length, 2);
  assert.ok(by('completed').every((i) => i.received_qty === i.expected_qty && i.putaway_qty === i.received_qty && !i.has_discrepancy));
  assert.equal(by('receiving').length, 1);
  assert.ok(by('receiving')[0].received_qty > 0 && by('receiving')[0].received_qty < by('receiving')[0].expected_qty);
  assert.equal(by('expected').length, 2);
  assert.ok(by('expected').some((i) => i.expected_date > today()));
  assert.ok(by('expected').some((i) => i.expected_date < today()));
  assert.ok(list.kpis.overdue >= 1);
  assert.ok(demo.some((i) => i.supplier_code === 'DEMO-ALFOLDI'));
});

test('orders and history: every status', async () => {
  const open = await api.get('/api/orders?limit=200');
  const demoOpen = open.items.filter((o) => o.partner_code.startsWith('DEMO-'));
  const count = (list, s) => list.filter((o) => o.status === s).length;
  assert.equal(count(demoOpen, 'new'), 5);
  assert.equal(count(demoOpen, 'hold'), 1);
  assert.equal(count(demoOpen, 'picking'), 2);
  assert.equal(count(demoOpen, 'packed'), 3);
  assert.ok(demoOpen.some((o) => o.priority === 'express' && o.status === 'new'));
  assert.ok(demoOpen.filter((o) => o.status === 'new' && o.cod_amount > 0).length >= 2);
  assert.ok(demoOpen.some((o) => o.availability === 'short'), 'one new order waits for stock');
  assert.ok(demoOpen.filter((o) => o.status === 'packed').every((o) => o.tracking_number));
  assert.equal(open.kpis.express, 1);

  const history = await api.get('/api/history?limit=200');
  assert.deepEqual(history.kpis, { shipped: 2, delivered: 2, returned: 1, cancelled: 1 });
  const returned = history.items.find((o) => o.status === 'returned');
  assert.equal(returned.return_count, 1);
  const detail = await api.get(`/api/orders/${returned.id}`);
  assert.deepEqual(detail.returns[0].lines.map((l) => l.condition).sort(), ['damaged', 'sellable']);
  assert.equal(detail.returns[0].photos.length, 1);
  const photo = await one('SELECT r2_key, content_type FROM documents WHERE id = ?', detail.returns[0].photos[0].id);
  assert.equal(photo.content_type, 'image/png');
  assert.ok(await env.FILES.head(photo.r2_key));
});

test('picking and transport: wave in progress, closed and planned pickups', async () => {
  const waves = await api.get('/api/picking/waves?status=all');
  assert.deepEqual(waves.items.map((w) => w.status).sort(), ['completed', 'picking']);
  const inProgress = waves.items.find((w) => w.status === 'picking');
  assert.ok(inProgress.picked > 0 && inProgress.picked < inProgress.qty);

  const pickups = await api.get('/api/transport/pickups');
  assert.deepEqual(pickups.items.map((p) => p.status).sort(), ['closed', 'planned']);
  const closed = pickups.items.find((p) => p.status === 'closed');
  assert.equal(closed.orders, 5);
  assert.equal(closed.carrier_code, 'gls');
  const planned = await api.get(`/api/transport/pickups/${pickups.items.find((p) => p.status === 'planned').id}`);
  assert.equal(planned.orders.length, 2);
  assert.ok(planned.orders.every((o) => o.status === 'packed'));
  const board = await api.get('/api/transport/board');
  assert.ok(board.totals.waiting.orders >= 1, 'a packed order waits for its carrier');
  const transports = await api.get('/api/transport/transports');
  assert.equal(transports.total, 1);
});

test('counts, quotes and billing', async () => {
  const counts = await api.get('/api/counts');
  assert.equal(counts.total, 1);
  const c = counts.items[0];
  assert.equal(c.blind, true);
  assert.equal(c.locations, 3);
  assert.ok(['open', 'counting'].includes(c.status));

  const quotes = await api.get('/api/quotes');
  assert.deepEqual(quotes.items.map((q) => q.status).sort(), ['draft', 'sent']);
  assert.ok(quotes.items.every((q) => q.monthly_net > 0 && q.partner_code.startsWith('DEMO-')));

  const period = today().slice(0, 7);
  const overview = await api.get(`/api/billing/overview?period=${period}`);
  const demo = overview.items.filter((x) => x.code.startsWith('DEMO-'));
  assert.equal(demo.length, 3);
  assert.ok(demo.every((x) => x.status === 'draft' && x.net > 0));
  assert.equal(overview.items.find((x) => x.code === 'VALODI').status, 'none', 'real clients get no statement');
  const st = await api.get(`/api/billing/statements/${demo.find((x) => x.code === 'DEMO-MANCS').statement_id}`);
  const groups = new Set(st.lines.map((l) => l.group));
  for (const g of ['handling', 'storage', 'inbound', 'extra', 'custom']) assert.ok(groups.has(g), `statement has ${g} lines`);
  const entries = await api.get(`/api/billing/entries?period=${period}`);
  assert.equal(entries.total, 4);
  assert.ok((await one('SELECT COUNT(*) AS n FROM storage_snapshots WHERE date = ?', today())).n > 0);
});

test('a second run changes nothing', async () => {
  const before = await tableCounts();
  const out = await seedDemo({ worker, env, adminId, log: (m) => logs.push(m) });
  assert.equal(out.created, false);
  assert.match(logs[logs.length - 1], /már megvannak/);
  assert.deepEqual(await tableCounts(), before);
});

test('remove: every demo row goes, real data stays as it was', async () => {
  const docs = await rows("SELECT d.r2_key FROM documents d JOIN partners p ON p.id = d.partner_id WHERE p.code LIKE 'DEMO-%'");
  assert.ok(docs.length >= 1);
  const out = await removeDemo({ env, log: (m) => logs.push(m) });
  assert.equal(out.removed, true);
  assert.equal(out.partners, 6);
  assert.deepEqual(out.kept_partners, []);
  assert.equal(out.orders, 17);
  assert.equal(out.files, docs.length);
  for (const d of docs) assert.equal(await env.FILES.head(d.r2_key), null, 'file deleted from the bucket');

  assert.equal((await one("SELECT COUNT(*) AS n FROM partners WHERE code LIKE 'DEMO-%'")).n, 0);
  assert.equal((await one("SELECT COUNT(*) AS n FROM products WHERE sku LIKE 'DEMO-%'")).n, 0);
  assert.equal(await one("SELECT value FROM settings WHERE key = 'demo_data'"), undefined);
  for (const t of ['inbounds', 'returns', 'waves', 'picks', 'carrier_pickups', 'transports', 'counts', 'count_lines', 'quotes', 'statements',
    'billing_entries', 'stock', 'movements', 'storage_snapshots', 'documents', 'inbound_putaways', 'return_photos']) {
    assert.equal((await one(`SELECT COUNT(*) AS n FROM ${t}`)).n, 0, `${t} is empty`);
  }
  assert.equal((await one('SELECT COUNT(*) AS n FROM locations')).n, 0, 'demo locations without history are deleted');
  assert.ok(out.locations_deleted >= 22);
  assert.deepEqual(await realRows(), real.before);
  assert.equal((await one('SELECT COUNT(*) AS n FROM orders')).n, 1);
  assert.ok((await one("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'order'")).n > 17, 'the activity log keeps its rows');
  assert.deepEqual(await rows('PRAGMA foreign_key_check'), []);

  // The real order still works, and a second removal finds nothing to do.
  const detail = await api.get(`/api/orders/${real.order}`);
  assert.equal(detail.status, 'new');
  const again = await removeDemo({ env, log: (m) => logs.push(m) });
  assert.equal(again.removed, false);
});

test('remove after real use: what real data points at stays, real counts keep their locations', async () => {
  const out = await seedDemo({ worker, env, adminId, log: () => {} });
  assert.equal(out.created, true, 'can be seeded again after removal');
  const gls = (await one("SELECT id FROM partners WHERE code = 'DEMO-GLS'")).id;
  // Somebody tried the app with real data: a real order shipped with the demo GLS, a real location,
  // a real cycle count over it and over locations that hold demo stock. (A count that only covers
  // demo locations or demo products is demo data itself and goes with them.)
  const order = await api.post('/api/orders', {
    partner_id: real.partner, customer_name: 'Másik Vevő', carrier_id: gls, lines: [{ product_id: real.product, qty: 1 }],
  });
  const own = await api.post('/api/settings/locations', { code: 'SAJAT-01', size_id: 1 });
  const count = await api.post('/api/counts', { type: 'cycle', limit: 30 });
  assert.ok(await one('SELECT id FROM count_lines WHERE count_id = ? AND location_id = ?', count.id, own.id));
  const demoLines = (await one(`SELECT COUNT(*) AS n FROM count_lines cl JOIN products p ON p.id = cl.product_id
    WHERE cl.count_id = ? AND p.sku LIKE 'DEMO-%'`, count.id)).n;
  assert.ok(demoLines > 0);
  const countLocations = (await one('SELECT COUNT(DISTINCT location_id) AS n FROM count_lines WHERE count_id = ?', count.id)).n;

  const removed = await removeDemo({ env, log: () => {} });
  assert.deepEqual(removed.kept_partners, ['DEMO-GLS']);
  assert.deepEqual(await rows("SELECT code, status FROM partners WHERE code LIKE 'DEMO-%'"), [{ code: 'DEMO-GLS', status: 'inactive' }]);
  assert.equal((await one('SELECT carrier_id FROM orders WHERE id = ?', order.id)).carrier_id, gls);
  assert.equal((await one("SELECT COUNT(*) AS n FROM products WHERE sku LIKE 'DEMO-%'")).n, 0);
  // The real count stays with every location; the demo lines became empty location lines.
  assert.equal((await one('SELECT status FROM counts WHERE id = ?', count.id)).status, 'open');
  assert.equal((await one('SELECT COUNT(*) AS n FROM count_lines WHERE count_id = ? AND product_id IS NOT NULL', count.id)).n, 0);
  assert.equal((await one('SELECT COUNT(DISTINCT location_id) AS n FROM count_lines WHERE count_id = ?', count.id)).n, countLocations);
  // Its locations have history now (count lines): set inactive instead of deleted.
  assert.ok(removed.locations_inactivated > 0);
  assert.deepEqual(await rows('PRAGMA foreign_key_check'), []);
});
