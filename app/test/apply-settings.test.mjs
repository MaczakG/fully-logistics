// Settings without a browser (server/apply-settings.mjs, the deploy agent's "settings" task): the
// changes go through the app's own API, so they are checked and logged like a save on the page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Database } from '../server/d1.mjs';
import { DiskBucket } from '../server/bucket.mjs';
import { createAssets } from '../server/assets.mjs';
import { migrate } from '../server/migrate.mjs';
import { applySettings } from '../server/apply-settings.mjs';
import { passwordHash, ENCRYPTION_KEY, SETUP_TOKEN } from './helpers.mjs';
import worker from '../worker/index.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'fl-apply-settings-'));
let DB;
let env;
let adminId;
const setting = async (key) => JSON.parse((await DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first()).value);

before(async () => {
  if (!existsSync(join(APP, 'dist', 'index.html'))) execFileSync('node', ['build.mjs'], { cwd: APP, stdio: 'ignore' });
  const dbPath = join(dir, 'db.sqlite');
  await migrate(dbPath, { log: () => {} });
  DB = new D1Database(dbPath);
  env = { SETUP_TOKEN, ENCRYPTION_KEY, DB, FILES: new DiskBucket(join(dir, 'files')), ASSETS: createAssets(join(APP, 'dist')) };
  const res = await DB.prepare('INSERT INTO users (email, name, role_id, password_hash) VALUES (?, ?, (SELECT id FROM roles WHERE key = ?), ?)')
    .bind('admin@example.com', 'Teszt Admin', 'admin', passwordHash('jelszo-12345')).run();
  adminId = res.meta.last_row_id;
});
after(() => { DB.close(); rmSync(dir, { recursive: true, force: true }); });

test('tariffs and costing through the API, with the changes listed and logged', async () => {
  const logs = [];
  const changes = await applySettings({
    worker, env, adminId, log: (m) => logs.push(m),
    payload: {
      tariffs: { values: { cod_fixed: 190, cod_pct: 1.5, hourly_work: 6900 }, storage: { PAL: 3990 } },
      costing: { rent: 3300000, area_m2: 1680, worker_cost: 700000, worker_hours: 144, pack_cost: 95, racks: { PAL: { area: 7, levels: 4, per_level: 3 } } },
    },
  });
  const t = await setting('default_tariffs');
  assert.equal(t.cod_pct, 1.5);
  assert.equal(t.hourly_work, 6900);
  assert.equal(t.storage.PAL, 3990);
  assert.equal(t.order_base, 600, 'what the payload leaves out stays');
  assert.equal(t.storage.M, 780);
  const c = await setting('costing');
  assert.equal(c.pack_cost, 95);
  assert.deepEqual(c.racks.PAL, { area: 7, levels: 4, per_level: 3 });
  assert.deepEqual(changes.tariffs.find((x) => x.field === 'values.cod_pct'), { field: 'values.cod_pct', before: 0, after: 1.5 });
  assert.ok(changes.costing.some((x) => x.field === 'pack_cost' && x.after === 95));
  assert.ok(logs.some((l) => /^Alap tarifák: \d+ változás$/.test(l)), logs.join('\n'));
  assert.ok(logs.includes('  storage.PAL: 0 -> 3990'), logs.join('\n'));
  const audit = (await DB.prepare("SELECT actor, summary FROM audit_log WHERE entity = 'settings' ORDER BY id").all()).results.map((r) => `${r.actor}: ${r.summary}`);
  assert.deepEqual(audit, ['Teszt Admin: Alap tarifák módosítva', 'Teszt Admin: Költségkalkuláció módosítva']);
  const sessions = (await DB.prepare('SELECT COUNT(*) AS n FROM sessions').first()).n;
  assert.equal(sessions, 0, 'the short lived session is gone');

  // The same again changes nothing.
  const again = await applySettings({ worker, env, adminId, log: () => {}, payload: { tariffs: { values: { cod_pct: 1.5 } } } });
  assert.deepEqual(again.tariffs, []);

  // Only some of the costing: the rest stays as it was.
  const part = await applySettings({ worker, env, adminId, log: () => {}, payload: { costing: { min_order: 4, racks: { M: { levels: 6 } } } } });
  assert.deepEqual(part.costing.map((x) => x.field).sort(), ['min_order', 'racks.M.levels']);
  const c2 = await setting('costing');
  assert.equal(c2.rent, 3300000);
  assert.equal(c2.pack_cost, 95);
  assert.deepEqual(c2.racks.M, { area: 1.1, levels: 6, per_level: 2 });
});

test('unknown parts, an empty package and invalid values are refused', async () => {
  await assert.rejects(applySettings({ worker, env, adminId, log: () => {}, payload: { users: {} } }), /Ismeretlen beállítás: users/);
  await assert.rejects(applySettings({ worker, env, adminId, log: () => {}, payload: {} }), /Üres a beállításcsomag/);
  await assert.rejects(applySettings({ worker, env, adminId, log: () => {}, payload: { tariffs: { values: { cod_pct: 250 } } } }), /400/);
  assert.equal((await setting('default_tariffs')).cod_pct, 1.5, 'nothing saved from the refused one');
});

test('command line: a JSON file, and no administrator means no change', () => {
  const file = join(dir, 'payload.json');
  writeFileSync(file, JSON.stringify({ tariffs: { values: { cod_fixed: 200 } } }));
  const run = (dbPath) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, ['--no-warnings', join(APP, 'server/apply-settings.mjs'), file], { env: { ...process.env, DB_PATH: dbPath, FILES_DIR: join(dir, 'files') }, encoding: 'utf8', stdio: 'pipe' }) };
    } catch (err) {
      return { code: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };
  const ok = run(join(dir, 'db.sqlite'));
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /cod_fixed: 190 -> 200/);
  const emptyDb = join(dir, 'empty.sqlite');
  execFileSync(process.execPath, ['--no-warnings', join(APP, 'server/migrate.mjs')], { env: { ...process.env, DB_PATH: emptyDb }, stdio: 'ignore' });
  const none = run(emptyDb);
  assert.equal(none.code, 2, none.out);
  assert.match(none.out, /Nincs aktív adminisztrátor/);
});
