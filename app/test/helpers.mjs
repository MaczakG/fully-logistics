// Test harness: starts the app on a free port with its own empty database and file store, applies
// the migrations, and gives tests an HTTP client that keeps the session cookie and sends the CSRF
// header like the browser app does. FL_RUNTIME picks the runtime:
//   node (default)  server/index.mjs, the runtime of the AWS server (SQLite file, files in a folder)
//   workers         `wrangler dev`, the Cloudflare Workers runtime (local D1 and R2)
//
//   const srv = await startServer();
//   const admin = await srv.admin();             // first-run setup, signed in as administrator
//   const r = await admin.get('/api/me');
//   await srv.stop();

import { spawn, execFileSync } from 'node:child_process';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = join(APP, 'node_modules', '.bin', 'wrangler');
export const SETUP_TOKEN = 'test-setup-token';
export const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
export const ADMIN = { name: 'Teszt Admin', email: 'admin@example.com', password: 'jelszo-12345' };

const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

export class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async request(method, path, body, { headers = {}, raw = false } = {}) {
    const h = { accept: 'application/json', 'x-requested-with': 'fl-app', ...headers };
    if (this.cookie) h.cookie = this.cookie;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(this.base + path, { method, headers: h, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = set.match(/fl_app_session=([^;]*)/);
      if (m) this.cookie = m[1] ? `fl_app_session=${m[1]}` : '';
    }
    if (raw) return res;
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  get(p, o) { return this.request('GET', p, undefined, o); }
  post(p, b, o) { return this.request('POST', p, b ?? {}, o); }
  put(p, b, o) { return this.request('PUT', p, b ?? {}, o); }
  patch(p, b, o) { return this.request('PATCH', p, b ?? {}, o); }
  del(p, o) { return this.request('DELETE', p, undefined, o); }
  async login(email, password) {
    const r = await this.post('/api/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.data)}`);
    return r;
  }
}

export const RUNTIME = process.env.FL_RUNTIME === 'workers' ? 'workers' : 'node';

function spawnNode(port, state) {
  return spawn(process.execPath, ['--no-warnings', 'server/index.mjs'], {
    cwd: APP,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: join(state, 'db.sqlite'), FILES_DRIVER: 'disk', FILES_DIR: join(state, 'files'),
      MIGRATE_ON_START: '1', CRON: '0', BACKUP: '0', WORKER: 'test/test-worker.js', SETUP_TOKEN, ENCRYPTION_KEY,
    },
  });
}

function spawnWrangler(port, inspector, state) {
  execFileSync(WRANGLER, ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state], { cwd: APP, stdio: 'ignore', env: { ...process.env, CI: '1' } });
  return spawn(WRANGLER, ['dev', 'test/test-worker.js', '--port', String(port), '--inspector-port', String(inspector), '--ip', '127.0.0.1', '--persist-to', state,
    '--var', `SETUP_TOKEN:${SETUP_TOKEN}`, '--var', `ENCRYPTION_KEY:${ENCRYPTION_KEY}`, '--show-interactive-dev-session=false'],
    { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
}

export async function startServer() {
  const port = await freePort();
  mkdirSync(join(APP, '.wrangler'), { recursive: true });
  const state = mkdtempSync(join(APP, '.wrangler', 'test-'));
  // npm test builds once up front; a single test file run builds only if there is no build yet.
  if (!existsSync(join(APP, 'dist', 'index.html'))) execFileSync('node', ['build.mjs'], { cwd: APP, stdio: 'ignore' });
  const proc = RUNTIME === 'workers' ? spawnWrangler(port, await freePort(), state) : spawnNode(port, state);
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (proc.exitCode != null) throw new Error(`${RUNTIME} server exited:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
    if (i === 119) throw new Error(`${RUNTIME} server did not start:\n${log}`);
  }
  const srv = {
    base,
    log: () => log,
    client: () => new Client(base),
    // First-run setup; returns a client signed in as the administrator.
    async admin() {
      const c = new Client(base);
      const r = await c.post('/api/setup', { token: SETUP_TOKEN, ...ADMIN });
      if (r.status !== 200) {
        await c.login(ADMIN.email, ADMIN.password);
      }
      return c;
    },
    // Creates a user with the given role key and returns a signed-in client.
    async userWithRole(roleKey, email = `${roleKey}-${Date.now()}@example.com`, password = 'jelszo-12345') {
      await srv.sql(`INSERT INTO users (email, name, role_id, password_hash) VALUES ('${email}', 'Teszt ${roleKey}', (SELECT id FROM roles WHERE key = '${roleKey}'), '${passwordHash(password)}')`);
      const c = new Client(base);
      await c.login(email, password);
      return c;
    },
    // Shared fixture data every module can rely on (ids are fixed, see FIXTURE below).
    async seedBasics() {
      await srv.sql(FIXTURE_SQL);
      return FIXTURE;
    },
    // Runs SQL against the local database (for test fixtures).
    // Raw SQL for fixtures, run inside the dev server (test/test-worker.js).
    async sql(sql) {
      const r = await fetch(`${base}/api/__test/sql`, { method: 'POST', body: JSON.stringify({ sql }) });
      const data = await r.json();
      if (!data.ok) throw new Error(`sql failed: ${data.error}`);
      return data;
    },
    // SELECT helper: rows as objects.
    async query(sql, ...args) {
      const r = await fetch(`${base}/api/__test/query`, { method: 'POST', body: JSON.stringify({ sql, args }) });
      return (await r.json()).results;
    },
    // Calls a library function inside the Worker: srv.call('stock.addStock', [{ ... }], { as: userId })
    async call(fn, args = [], { as = null } = {}) {
      const r = await fetch(`${base}/api/__test/call`, { method: 'POST', body: JSON.stringify({ fn, args, as }) });
      return r.json();
    },
    async stop() {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (proc.exitCode == null) proc.kill('SIGKILL');
      rmSync(state, { recursive: true, force: true });
    },
  };
  return srv;
}

// Same format as worker/lib/auth.js hashPassword().
export function passwordHash(password) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  return `pbkdf2-sha256$100000$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// Fixture: two clients, a supplier, two carriers, locations in zones A (M), B (L), C (XL), P (pallet),
// R (receiving), V (returns), Q (quarantine), six products and some stock.
export const FIXTURE = {
  clients: { kutya: 101, konyha: 102 },
  supplier: 201,
  carriers: { gls: 301, foxpost: 302 },
  products: { tap: 1001, alom: 1002, csont: 1003, robot: 1101, mixer: 1102, forralo: 1103 },
  locations: { receiving: 1, returns: 2, quarantine: 3 },
};
const loc = [];
let lid = 10;
for (const [zone, size, n] of [['A', 1, 8], ['B', 2, 6], ['C', 3, 4], ['P', 4, 4]]) {
  for (let i = 1; i <= n; i++) loc.push(`(${lid++}, '${zone}-01-${String(i).padStart(2, '0')}', '${zone}', ${size}, 'storage', ${lid})`);
}
export const FIXTURE_SQL = `
INSERT INTO partners (id, type, code, name, tax_number, zip, city, address, billing_email, carrier_code) VALUES
 (101, 'client', 'KUTYA', 'Kutyabarát Webshop Kft.', '12345678-2-13', '1111', 'Budapest', 'Minta utca 1.', 'szamla@kutyabarat.example', ''),
 (102, 'client', 'KONYHA', 'Konyhagép Gyártó Zrt.', '87654321-2-13', '6000', 'Kecskemét', 'Ipari út 5.', 'penzugy@konyhagep.example', ''),
 (201, 'supplier', 'TAPGYAR', 'Tápgyár Kft.', '', '2000', 'Szentendre', 'Gyár utca 2.', '', ''),
 (301, 'carrier', 'GLS', 'GLS General Logistics Systems Hungary Kft.', '', '', '', '', '', 'gls'),
 (302, 'carrier', 'FOXPOST', 'FoxPost Zrt.', '', '', '', '', '', 'foxpost');
INSERT INTO locations (id, code, zone, size_id, kind, pick_sequence) VALUES
 (1, 'RAMPA-BE', 'R', 4, 'receiving', 0), (2, 'VISSZARU', 'V', 4, 'returns', 0), (3, 'KARANTEN', 'Q', 4, 'quarantine', 0),
 ${loc.join(',\n ')};
INSERT INTO products (id, partner_id, sku, name, ean, weight_kg, min_stock, track_lot, track_expiry) VALUES
 (1001, 101, 'KB-1001', 'Prémium kutyatáp 12 kg', '5990000010015', 12, 20, 1, 1),
 (1002, 101, 'KB-1002', 'Macskaalom 10 l', '5990000010022', 6, 10, 0, 0),
 (1003, 101, 'KB-1003', 'Rágócsont, 3 db', '5990000010039', 0.3, 50, 0, 0),
 (1101, 102, 'KG-2001', 'Konyhai robotgép KR-500', '5990000020014', 7.5, 5, 1, 0),
 (1102, 102, 'KG-2002', 'Botmixer BM-200', '5990000020021', 1.2, 10, 0, 0),
 (1103, 102, 'KG-2003', 'Vízforraló VF-17', '5990000020038', 1.4, 10, 0, 0);
INSERT INTO stock (product_id, location_id, lot, expiry, qty) VALUES
 (1001, 18, 'L2410', '2027-03-31', 40), (1001, 19, 'L2409', '2027-01-31', 10),
 (1002, 20, '', '', 25),
 (1003, 10, '', '', 300),
 (1101, 26, 'B24-07', '', 12),
 (1102, 11, '', '', 60), (1103, 12, '', '', 45);
`;
