// Deploy agent on the AWS server. systemd runs it once a minute (fully-app-agent.timer) as root.
// It makes the server match what the bucket says, so deploying never needs SSH:
//
//   releases/current.json   { version, sha256 }  the release that should run
//   releases/<version>.tar.gz                    the bundle (app/ with dist, worker, server, migrations)
//   deploy/config.json      { hostnames: [...] } the names Caddy serves with HTTPS certificates
//   status/agent.json       written here: what runs, whether the last install worked, and why not
//
// Installing a release: download and check it, back up the database, apply the migrations, switch
// /opt/fully-app/current, restart the app and check /api/health. If the new version does not come
// up healthy, the previous one is put back. The agent itself then runs from the new release.
//
//   node agent.mjs              one reconcile run (the timer)
//   node agent.mjs --bootstrap  first run on a new server: installs the systemd units, then reconciles

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, readlink, rename, rm, stat, statfs, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Bucket } from '../../server/bucket.mjs';

// Paths can be moved with FULLY_AGENT_* variables; only the test (test/deploy-agent.test.mjs) does.
const E = process.env;
const ROOT = E.FULLY_AGENT_ROOT || '/opt/fully-app';
const RELEASES = join(ROOT, 'releases');
const CURRENT = join(ROOT, 'current');
const AGENT_LINK = join(ROOT, 'agent');
const INSTALLED = join(ROOT, 'installed.json');
const STATE = join(ROOT, 'agent-state.json');
const ENV_FILE = E.FULLY_AGENT_ENV_FILE || '/etc/fully-app/env';
const CADDYFILE = E.FULLY_AGENT_CADDYFILE || '/etc/caddy/Caddyfile';
const SYSTEMD_DIR = E.FULLY_AGENT_SYSTEMD_DIR || '/etc/systemd/system';
const LOCK = E.FULLY_AGENT_LOCK || '/run/fully-app-agent.lock';
const HEALTH = E.FULLY_AGENT_HEALTH || 'http://127.0.0.1:8787/api/health';
const HEALTH_SECONDS = Number(E.FULLY_AGENT_HEALTH_SECONDS || 40);
const HERE = dirname(fileURLToPath(import.meta.url));
const UNITS = ['fully-app.service', 'fully-app-agent.service', 'fully-app-agent.timer'];
const HEARTBEAT_MS = 15 * 60 * 1000;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), status: r.status };
};
const readJson = async (path, fallback = null) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } };

async function loadEnv() {
  const env = {};
  for (const line of (await readFile(ENV_FILE, 'utf8')).split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const bucketOf = (env) => new S3Bucket({
  bucket: env.S3_BUCKET, region: env.S3_REGION, prefix: '', endpoint: env.S3_ENDPOINT || '',
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
});

async function getJson(bucket, key) {
  const o = await bucket.get(key);
  return o ? JSON.parse(await o.text()) : null;
}

// Runs a node script of a release as the app's user, with the app's environment.
function asApp(env, script, args = []) {
  return sh('runuser', ['-u', 'fullyapp', '--', process.execPath, '--no-warnings', script, ...args], { env: { ...env, PATH: process.env.PATH } });
}

async function healthy(seconds = HEALTH_SECONDS) {
  for (let i = 0; i < seconds; i++) {
    try {
      const r = await fetch(HEALTH, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function pointLink(link, target) {
  const tmp = `${link}.new`;
  await rm(tmp, { force: true });
  await symlink(target, tmp);
  await rename(tmp, link); // atomic replace
}

async function installUnits(appDir) {
  let changed = false;
  for (const unit of UNITS) {
    const src = await readFile(join(appDir, 'deploy/aws/systemd', unit), 'utf8');
    const dst = join(SYSTEMD_DIR, unit);
    const cur = existsSync(dst) ? await readFile(dst, 'utf8') : '';
    if (cur !== src) { await writeFile(dst, src); changed = true; }
  }
  if (changed) {
    sh('systemctl', ['daemon-reload']);
    sh('systemctl', ['enable', 'fully-app.service', 'fully-app-agent.timer']);
    sh('systemctl', ['start', 'fully-app-agent.timer']);
  }
  return changed;
}

async function download(bucket, wanted) {
  const dir = join(RELEASES, wanted.version);
  if (existsSync(join(dir, 'app/server/index.mjs'))) return dir;
  const obj = await bucket.get(`releases/${wanted.version}.tar.gz`);
  if (!obj) throw new Error(`release ${wanted.version} is missing from the bucket`);
  const buf = Buffer.from(await obj.arrayBuffer());
  const sum = createHash('sha256').update(buf).digest('hex');
  if (wanted.sha256 && sum !== wanted.sha256) throw new Error(`release ${wanted.version}: checksum mismatch`);
  const tmp = `${dir}.part`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const t = sh('tar', ['-xzf', '-', '-C', tmp], { input: buf });
  if (!t.ok) throw new Error(`release ${wanted.version}: cannot unpack: ${t.out}`);
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
  return dir;
}

async function install(bucket, env, wanted) {
  const dir = await download(bucket, wanted);
  const app = join(dir, 'app');
  if (existsSync(env.DB_PATH)) {
    const b = asApp(env, join(app, 'server/backup.mjs'));
    if (!b.ok) throw new Error(`backup before install failed: ${b.out.slice(-500)}`);
  }
  const m = asApp(env, join(app, 'server/migrate.mjs'));
  if (!m.ok) throw new Error(`migrations failed, nothing switched: ${m.out.slice(-800)}`);
  log(m.out);
  await installUnits(app);
  const previous = existsSync(CURRENT) ? await readlink(CURRENT) : null;
  await pointLink(CURRENT, dir);
  sh('systemctl', ['restart', 'fully-app.service']);
  if (!(await healthy())) {
    const journal = sh('journalctl', ['-u', 'fully-app.service', '-n', '40', '--no-pager']).out;
    if (previous) {
      await pointLink(CURRENT, previous);
      sh('systemctl', ['restart', 'fully-app.service']);
    }
    throw new Error(`version ${wanted.version} did not become healthy${previous ? ', the previous version runs again' : ''}:\n${journal.slice(-2000)}`);
  }
  await writeFile(INSTALLED, JSON.stringify({ version: wanted.version, at: new Date().toISOString() }));
  await pointLink(AGENT_LINK, dir);
  // Keep the running release, the previous one and the newest others; the rest goes.
  const keep = new Set([dir, previous].filter(Boolean).map((p) => resolve(p)));
  const all = (await readdir(RELEASES)).filter((n) => !n.endsWith('.part')).sort().reverse();
  for (const name of all.slice(3)) if (!keep.has(resolve(RELEASES, name))) await rm(join(RELEASES, name), { recursive: true, force: true });
  return `version ${wanted.version} installed`;
}

export function caddyfile(hostnames) {
  const names = hostnames.filter((h) => /^[a-z0-9.-]+$/i.test(h));
  if (!names.length) return '';
  return `# Written by the fully-app deploy agent from deploy/config.json in the bucket. Changes here are overwritten.
{
\tservers {
\t\tprotocols h1 h2
\t}
}

${names.join(', ')} {
\tencode zstd gzip
\trequest_body {
\t\tmax_size 25MB
\t}
\theader {
\t\tStrict-Transport-Security "max-age=31536000"
\t\t-Server
\t}
\treverse_proxy 127.0.0.1:8787
}
`;
}

async function syncCaddy(bucket) {
  const conf = await getJson(bucket, 'deploy/config.json');
  if (!conf || !Array.isArray(conf.hostnames)) return null;
  const text = caddyfile(conf.hostnames);
  if (!text) return null;
  const cur = existsSync(CADDYFILE) ? await readFile(CADDYFILE, 'utf8') : '';
  if (cur === text) return null;
  await writeFile(CADDYFILE, text);
  const v = sh('caddy', ['validate', '--config', CADDYFILE, '--adapter', 'caddyfile']);
  if (!v.ok) {
    await writeFile(CADDYFILE, cur);
    throw new Error(`Caddyfile rejected: ${v.out.slice(-500)}`);
  }
  const r = sh('systemctl', ['reload-or-restart', 'caddy']);
  if (!r.ok) throw new Error(`caddy reload failed: ${r.out.slice(-500)}`);
  return `hostnames: ${conf.hostnames.join(', ')}`;
}

async function reconcile({ bootstrap = false } = {}) {
  const env = await loadEnv();
  const bucket = bucketOf(env);
  const state = await readJson(STATE, {});
  const status = { at: new Date().toISOString(), ok: true, messages: [] };
  if (bootstrap) await installUnits(resolve(HERE, '../..'));

  const wanted = await getJson(bucket, 'releases/current.json');
  const installed = await readJson(INSTALLED);
  status.wanted = wanted && wanted.version;
  status.installed = installed && installed.version;
  if (wanted && (!installed || installed.version !== wanted.version) && state.failedVersion !== wanted.version) {
    try {
      status.messages.push(await install(bucket, env, wanted));
      status.installed = wanted.version;
      state.failedVersion = null;
    } catch (err) {
      status.ok = false;
      status.messages.push(String(err.message || err));
      // A broken release is not retried every minute; publishing a new version tries again.
      state.failedVersion = wanted.version;
    }
  }
  try {
    const c = await syncCaddy(bucket);
    if (c) status.messages.push(c);
  } catch (err) {
    status.ok = false;
    status.messages.push(String(err.message || err));
  }
  if (status.installed && !sh('systemctl', ['is-active', '--quiet', 'fully-app.service']).ok) {
    sh('systemctl', ['start', 'fully-app.service']);
    status.messages.push('fully-app was not running, started');
  }
  status.healthy = status.installed ? await healthy(Math.min(5, HEALTH_SECONDS)) : false;
  try {
    const fs = await statfs('/var/lib/fully-app');
    status.diskFreeMb = Math.round((fs.bavail * fs.bsize) / 1048576);
  } catch { /* not important */ }

  const changed = status.messages.length > 0 || !state.lastReport || Date.now() - state.lastReport > HEARTBEAT_MS || state.lastHealthy !== status.healthy;
  if (changed) {
    await bucket.put('status/agent.json', JSON.stringify(status, null, 2), { httpMetadata: { contentType: 'application/json' } });
    state.lastReport = Date.now();
    state.lastHealthy = status.healthy;
    if (status.messages.length) log(status.messages.join('\n'));
  }
  await writeFile(STATE, JSON.stringify(state));
  return status;
}

// One agent at a time (the timer and a bootstrap run could overlap); a lock older than 20 minutes
// is left over from a crash.
async function withLock(fn) {
  try {
    await mkdir(LOCK);
  } catch {
    const since = await stat(LOCK).then((s) => s.mtimeMs, () => 0);
    if (Date.now() - since < 20 * 60 * 1000) { log('another agent run is in progress'); return null; }
    await rm(LOCK, { recursive: true, force: true });
    await mkdir(LOCK);
  }
  try { return await fn(); } finally { await rm(LOCK, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bootstrap = process.argv.includes('--bootstrap');
  withLock(async () => {
    // Until a release is installed the timer runs the agent from the bootstrap copy.
    if (bootstrap && !existsSync(AGENT_LINK)) await pointLink(AGENT_LINK, resolve(HERE, '../../..'));
    return reconcile({ bootstrap });
  }).catch((err) => {
    console.error('agent failed', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
