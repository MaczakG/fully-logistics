// Database backups to the bucket: a consistent copy (VACUUM INTO), gzipped, at
// backups/db/YYYY-MM-DD/HHMM.sqlite.gz. Every backup of the last 48 hours is kept, then the first
// of each day for 60 days.
//
//   node server/backup.mjs           one backup now (DB_PATH and the S3_* settings from the environment)
//   node server/backup.mjs --restore backups/db/2026-10-16/1415.sqlite.gz --to /path/new.sqlite

import { DatabaseSync } from 'node:sqlite';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEEP_ALL_MS = 48 * 3600 * 1000;
const KEEP_DAILY_MS = 60 * 24 * 3600 * 1000;

export async function backupDatabase(dbPath, bucket, { now = new Date(), log = console.log } = {}) {
  const tmp = join(tmpdir(), `fully-app-backup-${process.pid}-${now.getTime()}.sqlite`);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.prepare('VACUUM INTO ?').run(tmp);
  } finally {
    db.close();
  }
  try {
    const data = gzipSync(await readFile(tmp), { level: 9 });
    const iso = now.toISOString();
    const key = `backups/db/${iso.slice(0, 10)}/${iso.slice(11, 13)}${iso.slice(14, 16)}.sqlite.gz`;
    await bucket.put(key, data, { httpMetadata: { contentType: 'application/gzip' } });
    log(`backup stored: ${key} (${Math.round(data.length / 1024)} KB)`);
    await pruneBackups(bucket, { now, log });
    return key;
  } finally {
    await rm(tmp, { force: true });
  }
}

export async function pruneBackups(bucket, { now = new Date(), log = console.log } = {}) {
  const all = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: 'backups/db/', cursor });
    all.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const dayKept = new Set();
  const remove = [];
  for (const o of all.sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const m = o.key.match(/^backups\/db\/(\d{4}-\d{2}-\d{2})\/(\d{2})(\d{2})\.sqlite\.gz$/);
    if (!m) continue;
    const at = new Date(`${m[1]}T${m[2]}:${m[3]}:00Z`).getTime();
    const age = now.getTime() - at;
    if (age <= KEEP_ALL_MS) continue;
    if (age <= KEEP_DAILY_MS && !dayKept.has(m[1])) { dayKept.add(m[1]); continue; }
    remove.push(o.key);
  }
  if (remove.length) {
    await bucket.delete(remove);
    log(`old backups removed: ${remove.length}`);
  }
  return remove;
}

export async function restoreBackup(bucket, key, toPath) {
  const obj = await bucket.get(key);
  if (!obj) throw new Error(`No backup at ${key}`);
  await writeFile(toPath, gunzipSync(Buffer.from(await obj.arrayBuffer())), { flag: 'wx' });
  return toPath;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { loadConfig, backupBucket } = await import('./config.mjs');
  const config = loadConfig();
  const bucket = backupBucket(config);
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const job = arg('--restore')
    ? restoreBackup(bucket, arg('--restore'), arg('--to')).then((p) => console.log(`restored to ${p}`))
    : backupDatabase(config.dbPath, bucket);
  job.catch((err) => { console.error(err.message); process.exit(1); });
}
