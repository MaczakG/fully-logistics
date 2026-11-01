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
import { migrate } from '../server/migrate.mjs';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';

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
// After the bootstrap the agent is started like systemd does it: through the /opt/fully-app/agent symlink.
async function runAgent(extra = []) {
  const viaLink = join(root, 'agent', 'app', 'deploy', 'aws', 'agent.mjs');
  const script = extra.includes('--bootstrap') || !existsSync(viaLink) ? join(APP, 'deploy/aws/agent.mjs') : viaLink;
  const child = spawn(process.execPath, ['--no-warnings', script, ...extra], {
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
  // 1. Bootstrap: units installed, release unpacked, the newest backup restored (a rebuilt server),
  // migrations, app started, Caddy configured.
  const saved = join(mkdtempSync(join(tmpdir(), 'fl-agent-bk-')), 'saved.sqlite');
  await migrate(saved, { log: () => {} });
  const savedDb = new DatabaseSync(saved);
  savedDb.prepare("INSERT INTO users (email, name, role_id, password_hash) VALUES ('mentett@example.com', 'Mentett Admin', 1, 'x')").run();
  savedDb.close();
  await bucket.put('backups/db/2026-10-16/2215.sqlite.gz', gzipSync(Buffer.from('régebbi, nem ez kell')));
  await bucket.put('backups/db/2026-10-16/2315.sqlite.gz', gzipSync(readFileSync(saved)));
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
  assert.match(st.messages.join('\n'), /database restored from backups\/db\/2026-10-16\/2315\.sqlite\.gz/);
  const setup = await (await fetch(`http://127.0.0.1:${port}/api/setup`)).json();
  assert.equal(setup.needsSetup, false, 'the restored database already has its administrator');

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

  // 6. One-off tasks: a known one runs once as the app, an unknown one is refused.
  const task = async (id, name) => {
    await bucket.put('tasks/current.json', JSON.stringify({ id, task: name }), { httpMetadata: { contentType: 'application/json' } });
    await runAgent();
    return s3.json(`status/task-${id}.json`);
  };
  const done = await task('feladat-1', 'backup');
  assert.equal(done.ok, true, JSON.stringify(done));
  const stored = done.output.match(/backup stored: (backups\/db\/\S+\.sqlite\.gz)/);
  assert.ok(stored && s3.objects.has(stored[1]), done.output);
  s3.objects.delete('status/task-feladat-1.json');
  await runAgent();
  assert.equal(s3.json('status/task-feladat-1.json'), null, 'the same task id does not run again');
  const refused = await task('feladat-2', 'rm -rf /');
  assert.equal(refused.ok, false);
  assert.match(refused.output, /unknown task/);
  // A task with a payload: the file from tasks/payload-<id>.json reaches the script, which saves the
  // settings through the app's API; without the file the task fails.
  await bucket.put('tasks/payload-feladat-3.json', JSON.stringify({ tariffs: { values: { cod_pct: 1.5 } } }), { httpMetadata: { contentType: 'application/json' } });
  const settings = await task('feladat-3', 'settings');
  assert.equal(settings.ok, true, settings.output);
  assert.match(settings.output, /values\.cod_pct: \S+ -> 1\.5/);
  const noPayload = await task('feladat-4', 'settings');
  assert.equal(noPayload.ok, false);
  assert.match(noPayload.output, /no payload: tasks\/payload-feladat-4\.json is missing/);
  assert.ok(await health());
});
