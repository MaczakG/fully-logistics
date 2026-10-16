// Test harness: starts `wrangler dev` on a free port with its own empty local D1/R2 state,
// applies the migrations, and gives tests an HTTP client that keeps the session cookie and sends
// the CSRF header like the browser app does.
//
//   const srv = await startServer();
//   const admin = await srv.admin();             // first-run setup, signed in as administrator
//   const r = await admin.get('/api/me');
//   await srv.stop();

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

export async function startServer() {
  const port = await freePort();
  mkdirSync(join(APP, '.wrangler'), { recursive: true });
  const state = mkdtempSync(join(APP, '.wrangler', 'test-'));
  execFileSync('node', ['build.mjs'], { cwd: APP, stdio: 'ignore' });
  execFileSync(WRANGLER, ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state], { cwd: APP, stdio: 'ignore', env: { ...process.env, CI: '1' } });
  const proc = spawn(WRANGLER, ['dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', state,
    '--var', `SETUP_TOKEN:${SETUP_TOKEN}`, '--var', `ENCRYPTION_KEY:${ENCRYPTION_KEY}`, '--show-interactive-dev-session=false'],
    { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (proc.exitCode != null) throw new Error(`wrangler dev exited:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
    if (i === 119) throw new Error(`wrangler dev did not start:\n${log}`);
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
    // Runs SQL against the local database (for test fixtures).
    sql(command) {
      return execFileSync(WRANGLER, ['d1', 'execute', 'DB', '--local', '--persist-to', state, '--json', '--command', command],
        { cwd: APP, env: { ...process.env, CI: '1' } }).toString();
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
