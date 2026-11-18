// Demo history (server/demo-history.mjs), here a week of it, from the command line on a fresh
// database: orders end up in every stage, nothing is dated after now (its clock is simulated),
// and demo-seed.mjs --remove takes all of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Database } from '../server/d1.mjs';
import { migrate } from '../server/migrate.mjs';
import { passwordHash, ENCRYPTION_KEY } from './helpers.mjs';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');

test('a week of demo history: every stage, nothing in the future, removable', async () => {
  if (!existsSync(join(APP, 'dist', 'index.html'))) execFileSync('node', ['build.mjs'], { cwd: APP, stdio: 'ignore' });
  const dir = mkdtempSync(join(tmpdir(), 'fl-demo-history-'));
  const dbPath = join(dir, 'db.sqlite');
  await migrate(dbPath, { log: () => {} });
  const DB = new D1Database(dbPath);
  const one = async (sql, ...args) => (await DB.prepare(sql).bind(...args).all()).results[0];
  try {
    await DB.prepare('INSERT INTO users (email, name, role_id, password_hash, must_change_password) VALUES (?, ?, (SELECT id FROM roles WHERE key = ?), ?, 0)')
      .bind('admin@example.com', 'Teszt Admin', 'admin', passwordHash('jelszo-12345')).run();
    const env = { ...process.env, DB_PATH: dbPath, FILES_DIR: join(dir, 'files'), ENCRYPTION_KEY, CRON: '0' };
    const started = new Date().toISOString();
    execFileSync('node', ['server/demo-history.mjs', '--months', '0.25'], { cwd: APP, env, stdio: 'pipe' });

    const statuses = (await DB.prepare("SELECT DISTINCT status FROM orders WHERE partner_id IN (SELECT id FROM partners WHERE code LIKE 'DEMO-%')").all()).results.map((r) => r.status);
    for (const s of ['delivered', 'picking']) assert.ok(statuses.includes(s), `${s} in ${statuses}`);
    assert.ok((await one('SELECT COUNT(*) AS n FROM orders')).n > 50);
    assert.ok((await one("SELECT COUNT(*) AS n FROM carrier_pickups WHERE status = 'closed'")).n >= 2);
    assert.ok((await one('SELECT COUNT(DISTINCT date) AS n FROM storage_snapshots')).n >= 6);
    // pallets went out on trucks, and today's trucks are partly planned
    assert.equal((await one('SELECT COUNT(*) AS n FROM trucks')).n, 5);
    assert.ok((await one("SELECT COUNT(*) AS n FROM orders WHERE truck_id IS NOT NULL AND status IN ('shipped', 'delivered')")).n > 5);
    assert.ok((await one("SELECT COUNT(*) AS n FROM order_events WHERE text LIKE 'Feladva: % teherautóval%'")).n > 0);
    // The simulated clock reaches the app's own dates and the tables' default timestamps alike.
    const now = new Date().toISOString();
    for (const [table, column] of [['orders', 'created_at'], ['movements', 'at'], ['audit_log', 'at'], ['order_events', 'at']]) {
      const r = await one(`SELECT MIN(${column}) AS first, MAX(${column}) AS last FROM ${table}`);
      assert.ok(r.last <= now, `${table}.${column} ${r.last} is after ${now}`);
      assert.ok(r.first < started.slice(0, 10), `${table}.${column} starts ${r.first}, not days back`);
    }

    execFileSync('node', ['server/demo-seed.mjs', '--remove'], { cwd: APP, env, stdio: 'pipe' });
    assert.equal((await one('SELECT COUNT(*) AS n FROM orders')).n, 0);
    assert.equal((await one("SELECT COUNT(*) AS n FROM partners WHERE code LIKE 'DEMO-%'")).n, 0);
    assert.equal((await one('SELECT COUNT(*) AS n FROM trucks')).n, 0);
  } finally {
    DB.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
