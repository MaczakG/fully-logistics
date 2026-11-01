// Shared parts of the AWS deploy scripts (provision, release, domain, status).
//
// AWS access comes from the environment: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (and
// AWS_SESSION_TOKEN for temporary keys), AWS_REGION (default eu-central-1). The key only needs
// Lightsail rights (lightsail:*). Bucket access for a deploy uses a short-lived bucket access key
// that the script creates and deletes again; the server keeps its own key.

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lightsail } from '../../server/sigv4.mjs';
import { S3Bucket } from '../../server/bucket.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const APP = resolve(HERE, '../..');
export const CONFIG_FILE = join(HERE, 'config.json');

export const log = (...a) => console.log(...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function awsFromEnv(env = process.env) {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Az AWS kulcs hiányzik: AWS_ACCESS_KEY_ID és AWS_SECRET_ACCESS_KEY környezeti változó kell (deploy/aws/README.md).');
  }
  return {
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'eu-central-1',
    credentials: { accessKeyId, secretAccessKey, sessionToken: env.AWS_SESSION_TOKEN || undefined },
  };
}

export const ls = (aws, action, params) => lightsail(action, params, aws);

export async function readConfig() {
  if (!existsSync(CONFIG_FILE)) return null;
  return JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
}

export async function writeConfig(conf) {
  await writeFile(CONFIG_FILE, `${JSON.stringify(conf, null, 2)}\n`);
}

export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');

// Waits for a Lightsail operation list to finish (most calls return operations).
export async function waitOps(aws, result, what = 'operation') {
  const ops = result.operations || (result.operation ? [result.operation] : []);
  for (const op of ops) {
    for (let i = 0; i < 120; i++) {
      const { operation } = await ls(aws, 'GetOperation', { operationId: op.id });
      if (operation.status === 'Succeeded' || operation.status === 'Completed') break;
      if (operation.status === 'Failed') throw new Error(`${what} failed: ${operation.errorDetails || operation.errorCode || ''}`);
      await sleep(2000);
    }
  }
}

// A fresh bucket access key for this run. A bucket can have two keys: the server's (kept) and
// one for deploys, which is replaced every time.
export async function deployBucket(aws, conf) {
  const { accessKeys = [] } = await ls(aws, 'GetBucketAccessKeys', { bucketName: conf.bucket });
  for (const k of accessKeys) {
    if (k.accessKeyId !== conf.serverKeyId) await ls(aws, 'DeleteBucketAccessKey', { bucketName: conf.bucket, accessKeyId: k.accessKeyId });
  }
  const { accessKey } = await ls(aws, 'CreateBucketAccessKey', { bucketName: conf.bucket });
  const bucket = new S3Bucket({
    bucket: conf.bucket, region: conf.region, prefix: '',
    credentials: { accessKeyId: accessKey.accessKeyId, secretAccessKey: accessKey.secretAccessKey },
  });
  // New keys take a few seconds to work.
  for (let i = 0; i < 30; i++) {
    try { await bucket.list({ prefix: 'status/', limit: 1 }); break; } catch (err) {
      if (i === 29) throw err;
      await sleep(2000);
    }
  }
  bucket.cleanup = () => ls(aws, 'DeleteBucketAccessKey', { bucketName: conf.bucket, accessKeyId: accessKey.accessKeyId }).catch(() => {});
  return bucket;
}

// Builds the single page app and packs what the server runs into app/... inside a .tar.gz.
export async function buildBundle({ build = true } = {}) {
  if (build) execFileSync(process.execPath, ['build.mjs'], { cwd: APP, stdio: 'inherit' });
  let commit = 'local';
  try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: APP, encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
  let dirty = '';
  try { dirty = execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: APP, encoding: 'utf8' }).trim() ? '-dirty' : ''; } catch { /* ignore */ }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const version = `${stamp}-${commit}${dirty}`;
  const tmp = await mkdtemp(join(tmpdir(), 'fully-bundle-'));
  try {
    await writeFile(join(APP, 'VERSION'), `${version}\n`);
    const file = join(tmp, 'release.tar.gz');
    execFileSync('tar', ['-czf', file, '-C', resolve(APP, '..'),
      'app/VERSION', 'app/package.json', 'app/dist', 'app/worker', 'app/server', 'app/migrations', 'app/deploy/aws']);
    const buf = await readFile(file);
    return { version, commit, buf, sha256: createHash('sha256').update(buf).digest('hex') };
  } finally {
    await rm(join(APP, 'VERSION'), { force: true });
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function uploadRelease(bucket, bundle) {
  await bucket.put(`releases/${bundle.version}.tar.gz`, bundle.buf, { httpMetadata: { contentType: 'application/gzip' } });
  const current = { version: bundle.version, sha256: bundle.sha256, commit: bundle.commit, at: new Date().toISOString() };
  await bucket.put('releases/current.json', JSON.stringify(current, null, 2), { httpMetadata: { contentType: 'application/json' } });
  return current;
}

export async function putHostnames(bucket, hostnames) {
  await bucket.put('deploy/config.json', JSON.stringify({ hostnames }, null, 2), { httpMetadata: { contentType: 'application/json' } });
}

export async function readStatus(bucket) {
  const o = await bucket.get('status/agent.json');
  return o ? JSON.parse(await o.text()) : null;
}

// Waits until the server reports the version installed (or a failure for it).
export async function waitForVersion(bucket, version, { minutes = 15 } = {}) {
  const until = Date.now() + minutes * 60 * 1000;
  let last = '';
  while (Date.now() < until) {
    const s = await readStatus(bucket).catch(() => null);
    if (s) {
      const line = `${s.at} telepítve: ${s.installed || '-'}, kért: ${s.wanted || '-'}, rendben: ${s.ok}, egészséges: ${s.healthy}`;
      if (line !== last) { log(`  szerver: ${line}`); last = line; }
      if (s.installed === version && s.healthy) return s;
      if (!s.ok && s.wanted === version) throw new Error(`A szerver nem tudta telepíteni a(z) ${version} verziót:\n${(s.messages || []).join('\n')}`);
    }
    await sleep(10000);
  }
  throw new Error(`A szerver ${minutes} perc alatt sem jelezte a(z) ${version} verziót.`);
}

export const sslipName = (ip) => `${ip.replace(/\./g, '-')}.sslip.io`;

// The Lightsail launch script: cloud-init.sh with its placeholders filled in, wrapped for /bin/sh.
// Lightsail puts the launch script into its own sh script, where bash syntax (set -o pipefail,
// process substitution) stops everything on the first line. So the wrapper only writes the bash
// script to a root-only file with a quoted here-document (nothing is expanded) and runs it.
const INIT_EOF = 'FULLY_APP_INIT_EOF';
export async function launchScript(values) {
  const checks = {
    BUCKET: /^[a-z0-9-]+$/, REGION: /^[a-z0-9-]+$/, S3_KEY_ID: /^[A-Z0-9]+$/, S3_SECRET: /^[A-Za-z0-9/+=]+$/,
    SETUP_TOKEN: /^[A-Za-z0-9_-]+$/, BOOTSTRAP_URL: /^https?:\/\/[^'\s]+$/, LOG_URL: /^https?:\/\/[^'\s]+$/, BOOTSTRAP_SHA256: /^[a-f0-9]{64}$/,
  };
  let inner = await readFile(join(HERE, 'cloud-init.sh'), 'utf8');
  for (const [name, re] of Object.entries(checks)) {
    const v = String(values[name] ?? '');
    if (!re.test(v)) throw new Error(`Váratlan érték a launch scriptben: ${name}`);
    inner = inner.split(`__${name}__`).join(v);
  }
  const left = inner.match(/__[A-Z0-9_]+__/g);
  if (left) throw new Error(`Kitöltetlen helyek a launch scriptben: ${left.join(', ')}`);
  if (inner.includes(INIT_EOF)) throw new Error('A launch script nem tartalmazhatja a lezáró jelet.');
  const script = [
    '#!/bin/sh',
    '# Fully Logistics app setup. The setup itself is bash (deploy/aws/cloud-init.sh); see launchScript() in lib.mjs.',
    'umask 077',
    `cat > /root/fully-app-init.sh <<'${INIT_EOF}'`,
    inner.replace(/\n$/, ''),
    INIT_EOF,
    'bash /root/fully-app-init.sh',
    '',
  ].join('\n');
  if (script.length > 16000) throw new Error('A launch script túl hosszú.');
  return script;
}

export async function checkHttps(hostname) {
  try {
    const r = await fetch(`https://${hostname}/api/health`, { signal: AbortSignal.timeout(15000) });
    return r.ok ? 'ok' : `HTTP ${r.status}`;
  } catch (err) {
    return `nem érhető el innen (${(err.cause && (err.cause.code || err.cause.message)) || err.message})`;
  }
}
