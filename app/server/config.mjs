// Settings of the Node runtime, from environment variables (on the server: /etc/fully-app/env).
//
//   PORT, HOST            where the app listens (8787, 127.0.0.1; Caddy is in front)
//   DB_PATH               SQLite file (./data/fully-app.sqlite)
//   FILES_DRIVER          disk | s3
//   FILES_DIR             folder for disk (./data/files)
//   S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT (tests only)
//   SETUP_TOKEN, ENCRYPTION_KEY   the app's secrets
//   TRUST_PROXY=1         take scheme and client address from Caddy's X-Forwarded-* headers
//   CRON=0                switch the scheduled jobs off; BACKUP=1 hourly database backups to S3
//   MIGRATE_ON_START=1    apply migrations before listening (development, tests)
//   WORKER, ASSETS_DIR    the worker module and the built single page app (tests use their own)

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiskBucket, S3Bucket } from './bucket.mjs';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flag = (v, dflt = false) => (v === undefined || v === '' ? dflt : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

export function loadConfig(env = process.env) {
  const c = {
    app: APP,
    port: Number(env.PORT || 8787),
    host: env.HOST || '127.0.0.1',
    dbPath: resolve(env.DB_PATH || resolve(APP, 'data/fully-app.sqlite')),
    filesDriver: env.FILES_DRIVER || (env.S3_BUCKET ? 's3' : 'disk'),
    filesDir: resolve(env.FILES_DIR || resolve(APP, 'data/files')),
    s3: {
      bucket: env.S3_BUCKET || '',
      region: env.S3_REGION || 'eu-central-1',
      endpoint: env.S3_ENDPOINT || '',
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID || '', secretAccessKey: env.S3_SECRET_ACCESS_KEY || '' },
    },
    trustProxy: flag(env.TRUST_PROXY),
    cron: flag(env.CRON, true),
    backup: flag(env.BACKUP),
    migrateOnStart: flag(env.MIGRATE_ON_START),
    worker: resolve(env.WORKER || resolve(APP, 'worker/index.js')),
    assetsDir: resolve(env.ASSETS_DIR || resolve(APP, 'dist')),
    // Values the worker reads from env (secrets and plain variables).
    vars: { SETUP_TOKEN: env.SETUP_TOKEN || '', ENCRYPTION_KEY: env.ENCRYPTION_KEY || '' },
  };
  if (c.filesDriver === 's3' && (!c.s3.bucket || !c.s3.credentials.accessKeyId || !c.s3.credentials.secretAccessKey)) {
    throw new Error('FILES_DRIVER=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
  }
  return c;
}

export function filesBucket(c) {
  return c.filesDriver === 's3' ? new S3Bucket({ ...c.s3, prefix: 'files/' }) : new DiskBucket(c.filesDir);
}

export function backupBucket(c) {
  if (!c.s3.bucket) throw new Error('Backups need the S3_* settings');
  return new S3Bucket({ ...c.s3, prefix: '' });
}
