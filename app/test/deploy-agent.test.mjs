// The AWS deploy agent end to end, without AWS: a fake S3 bucket (signatures checked), stand-ins
// for systemctl, runuser, caddy and journalctl (test/fake-system), and the real release bundle.
// Covers the first install, a release that does not start (rolled back), a failing migration
// (nothing switched), and the next good release.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeS3 } from './fake-s3.mjs';
import { S3Bucket } from '../server/bucket.mjs';
import { APP, buildBundle, putHostnames } from '../deploy/aws/lib.mjs';

const creds = { accessKeyId: 'AKIASERVER', secretAccessKey: 'szerver-titok' };
const root = mkdtempSync(join(tmpdir(), 'fl-agent-'));
let s3;
let bucket;
let port;
let good;

const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

// Async on purpose: the fake S3 server lives in this process and must keep answering.
async function runAgent(extra = []) {
  const child = spawn(process.execPath, ['--no-warnings', join(APP, 'deploy/aws/agent.mjs'), ...extra], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `${join(APP, 'test/fake-system')}:${process.env.PATH}`,
      FULLY_AGENT_ROOT: root,
      FULLY_AGENT_ENV_FILE: join(root, 'env'),
      FULLY_AGENT_CADDYFILE: join(root, 'Caddyfile'),
      FULLY_AGENT_SYSTEMD_DIR: join(root, 'systemd'),
      FULLY_AGENT_LOCK: join(root, 'agent.lock'),
      FULLY_AGENT_HEALTH: `http://127.0.0.1:${port}/api/health`,
      FULLY_AGENT_HEALTH_SECONDS: '8',
    },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, `agent failed:\n${out}`);
  return s3.json('status/agent.json');
}

// The good bundle, changed: unpacks it, lets fn edit the files, packs it under a new version.
function variant(version, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'fl-variant-'));
  try {
    execFileSync('tar', ['-xzf', '-', '-C', dir], { input: good.buf });
    fn(join(dir, 'app'));
    const buf = execFileSync('tar', ['-czf', '-', '-C', dir, 'app'], { maxBuffer: 64 * 1024 * 1024 });
    return { version, buf, sha256: createHash('sha256').update(buf).digest('hex') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function publish(b) {
  await bucket.put(`releases/${b.version}.tar.gz`, b.buf, { httpMetadata: { contentType: 'application/gzip' } });
  await bucket.put('releases/current.json', JSON.stringify({ version: b.version, sha256: b.sha256 }), { httpMetadata: { contentType: 'application/json' } });
}

const health = async () => {
  try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { return false; }
};

before(async () => {
  s3 = await startFakeS3({ credentials: creds });
  bucket = new S3Bucket({ bucket: 'b', region: 'eu-central-1', credentials: creds, endpoint: s3.base });
  port = await freePort();
  mkdirSync(join(root, 'systemd'));
  mkdirSync(join(root, 'releases'));
  writeFileSync(join(root, 'env'), [
    'NODE_ENV=production', `PORT=${port}`, 'HOST=127.0.0.1', 'TRUST_PROXY=1', 'BACKUP=0', 'CRON=0',
    `DB_PATH=${join(root, 'data', 'fully-app.sqlite')}`, 'FILES_DRIVER=s3', 'S3_BUCKET=b', 'S3_REGION=eu-central-1',
    `S3_ENDPOINT=${s3.base}`, `S3_ACCESS_KEY_ID=${creds.accessKeyId}`, `S3_SECRET_ACCESS_KEY=${creds.secretAccessKey}`,
    'SETUP_TOKEN=telepites', `ENCRYPTION_KEY=${Buffer.alloc(32, 9).toString('base64')}`, '',
  ].join('\n'));
  // npm test has built dist/ already; rebuilding here would race the other test files.
  good = await buildBundle({ build: !existsSync(join(APP, 'dist', 'index.html')) });
});

after(async () => {
  spawnSync(join(APP, 'test/fake-system/systemctl'), ['stop', 'fully-app.service'], { env: { ...process.env, FULLY_AGENT_ROOT: root } });
  await s3.close();
  rmSync(root, { recursive: true, force: true });
});

test('first install, a release that does not start, a failing migration, then a good release', { timeout: 120000 }, async () => {
  // 1. Bootstrap: units installed, release unpacked, migrations, app started, Caddy configured.
  await publish(good);
  await putHostnames(bucket, ['10-0-0-1.sslip.io']);
  let st = await runAgent(['--bootstrap']);
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.equal(st.installed, good.version);
  assert.equal(st.healthy, true);
  assert.equal(readlinkSync(join(root, 'current')), join(root, 'releases', good.version));
  assert.equal(readlinkSync(join(root, 'agent')), join(root, 'releases', good.version));
  assert.deepEqual(readdirSync(join(root, 'systemd')).sort(), ['fully-app-agent.service', 'fully-app-agent.timer', 'fully-app.service']);
  assert.match(readFileSync(join(root, 'Caddyfile'), 'utf8'), /^10-0-0-1\.sslip\.io \{$/m);
  assert.ok(await health());
  const setup = await (await fetch(`http://127.0.0.1:${port}/api/setup`)).json();
  assert.equal(setup.needsSetup, true);

  // 2. Nothing new: the agent leaves everything as it is.
  const restarts = () => readFileSync(join(root, 'systemctl.log'), 'utf8').split('\n').filter((l) => l.startsWith('systemctl restart fully-app')).length;
  const before = restarts();
  await runAgent();
  assert.equal(restarts(), before);

  // 3. A release that crashes on start: rolled back, reported, not retried every minute.
  const broken = variant(`${good.version}-b`, (app) => writeFileSync(join(app, 'server/index.mjs'), 'process.exit(3);\n'));
  await publish(broken);
  st = await runAgent();
  assert.equal(st.ok, false);
  assert.match(st.messages.join('\n'), /did not become healthy, the previous version runs again/);
  assert.equal(st.installed, good.version);
  assert.equal(readlinkSync(join(root, 'current')), join(root, 'releases', good.version));
  assert.ok(await health());
  assert.ok([...s3.objects.keys()].some((k) => k.startsWith('backups/db/')), 'a backup is taken before installing');
  const afterBroken = restarts();
  await runAgent();
  assert.equal(restarts(), afterBroken, 'a failed version is not tried again');

  // 4. A failing migration: nothing is switched, the running version keeps its database.
  const badMigration = variant(`${good.version}-m`, (app) => writeFileSync(join(app, 'migrations/9999_hibas.sql'), 'INSERT INTO nincs_ilyen VALUES (1);\n'));
  await publish(badMigration);
  st = await runAgent();
  assert.equal(st.ok, false);
  assert.match(st.messages.join('\n'), /migrations failed, nothing switched/);
  assert.equal(readlinkSync(join(root, 'current')), join(root, 'releases', good.version));
  assert.ok(await health());

  // 5. The next good release installs, and a hostname change reaches Caddy.
  const next = variant(`${good.version}-n`, () => {});
  await publish(next);
  await putHostnames(bucket, ['app.fully.hu', '10-0-0-1.sslip.io']);
  st = await runAgent();
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.equal(st.installed, next.version);
  assert.equal(readlinkSync(join(root, 'current')), join(root, 'releases', next.version));
  assert.match(readFileSync(join(root, 'Caddyfile'), 'utf8'), /^app\.fully\.hu, 10-0-0-1\.sslip\.io \{$/m);
  assert.ok(await health());
});
