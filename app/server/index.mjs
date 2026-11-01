// The app on Node.js (the AWS server, development, tests): the same worker code as on Cloudflare,
// with D1 on a SQLite file, R2 on S3 or a folder, the static assets from dist/ and the cron jobs
// of wrangler.jsonc run by a minute timer. Settings: server/config.mjs.
//
//   node server/index.mjs

import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { D1Database } from './d1.mjs';
import { createAssets } from './assets.mjs';
import { executionContext, sendResponse, toRequest } from './http.mjs';
import { backupBucket, filesBucket, loadConfig } from './config.mjs';
import { migrate } from './migrate.mjs';
import { backupDatabase } from './backup.mjs';

// The two schedules of wrangler.jsonc, in UTC like Cloudflare's cron triggers.
const CRONS = [
  { cron: '*/10 * * * *', due: (d) => d.getUTCMinutes() % 10 === 0 },
  { cron: '5 * * * *', due: (d) => d.getUTCMinutes() === 5 },
];
const BACKUP_MINUTE = 15;

export async function startApp(config = loadConfig()) {
  await mkdir(dirname(config.dbPath), { recursive: true });
  if (config.migrateOnStart) await migrate(config.dbPath, { log: () => {} });
  const worker = (await import(pathToFileURL(config.worker).href)).default;
  const DB = new D1Database(config.dbPath);
  const env = { ...config.vars, DB, FILES: filesBucket(config), ASSETS: createAssets(config.assetsDir) };
  const pending = new Set();

  const server = createServer(async (req, res) => {
    let request;
    try {
      request = toRequest(req, { trustProxy: config.trustProxy });
      const url = new URL(request.url);
      const response = url.pathname.startsWith('/api/')
        ? await worker.fetch(request, env, executionContext(pending))
        : await env.ASSETS.fetch(request);
      await sendResponse(res, response, { head: req.method === 'HEAD' });
    } catch (err) {
      console.error('request failed', req.method, req.url, err && err.stack ? err.stack : err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'internal', message: 'Váratlan hiba történt.' } }));
      } else res.destroy();
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;

  // Cron: once a minute, a few seconds after the minute starts; a job that still runs is skipped.
  const running = new Map();
  const runJob = (name, fn) => {
    if (running.get(name)) { console.warn(`cron ${name}: previous run still in progress, skipped`); return; }
    const p = Promise.resolve().then(fn).catch((err) => console.error(`cron ${name} failed`, err && err.stack ? err.stack : err)).finally(() => running.delete(name));
    running.set(name, p);
  };
  let timer = null;
  const tick = () => {
    const now = new Date();
    for (const c of CRONS) {
      if (!c.due(now)) continue;
      runJob(c.cron, async () => {
        const local = new Set();
        worker.scheduled({ cron: c.cron, scheduledTime: now.getTime(), type: 'scheduled' }, env, executionContext(local));
        while (local.size) await Promise.all([...local]);
      });
    }
    if (config.backup && now.getUTCMinutes() === BACKUP_MINUTE) runJob('backup', () => backupDatabase(config.dbPath, backupBucket(config)));
    schedule();
  };
  const schedule = () => {
    const now = Date.now();
    timer = setTimeout(tick, 60_000 - (now % 60_000) + 2_000);
    timer.unref();
  };
  if (config.cron) schedule();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  return {
    server,
    env,
    port: server.address().port,
    async close() {
      clearTimeout(timer);
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      await Promise.allSettled([...pending, ...running.values()]);
      DB.close();
    },
  };
}

// realpath: systemd starts this through the /opt/fully-app/current symlink.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const app = await startApp();
  console.log(`fully-app listening on http://${app.server.address().address}:${app.port}`);
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: shutting down`);
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
