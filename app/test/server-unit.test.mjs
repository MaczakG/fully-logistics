// The Node runtime's pieces on their own: D1 semantics on SQLite, the disk and S3 buckets,
// static assets with _headers, migrations, backups and their pruning.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { D1Database } from '../server/d1.mjs';
import { DiskBucket, S3Bucket } from '../server/bucket.mjs';
import { createAssets, parseHeaders } from '../server/assets.mjs';
import { migrate } from '../server/migrate.mjs';
import { backupDatabase, pruneBackups, restoreBackup } from '../server/backup.mjs';
import { startFakeS3 } from './fake-s3.mjs';

const dir = mkdtempSync(join(tmpdir(), 'fl-server-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('d1: all, first, run, raw and meta like D1', async () => {
  const db = new D1Database(':memory:');
  await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE, flag INTEGER, n REAL)');
  const ins = await db.prepare('INSERT INTO t (name, flag, n) VALUES (?, ?, ?)').bind('a', true, 1.5).run();
  assert.equal(ins.success, true);
  assert.equal(ins.meta.changes, 1);
  assert.equal(ins.meta.last_row_id, 1);
  const rows = await db.prepare('SELECT * FROM t').all();
  assert.deepEqual(rows.results, [{ id: 1, name: 'a', flag: 1, n: 1.5 }]);
  assert.equal(Object.getPrototypeOf(rows.results[0]), Object.prototype);
  assert.equal(rows.meta.changes, 0);
  assert.deepEqual(await db.prepare('SELECT name FROM t WHERE id = ?').bind(1).first(), { name: 'a' });
  assert.equal(await db.prepare('SELECT name FROM t WHERE id = ?').bind(1).first('name'), 'a');
  assert.equal(await db.prepare('SELECT name FROM t WHERE id = ?').bind(9).first(), null);
  assert.deepEqual(await db.prepare('SELECT id, name FROM t').raw(), [[1, 'a']]);
  assert.deepEqual(await db.prepare('SELECT id, name FROM t').raw({ columnNames: true }), [['id', 'name'], [1, 'a']]);
  const upd = await db.prepare('UPDATE t SET flag = 0 WHERE id = 99').run();
  assert.equal(upd.meta.changes, 0);
  // Like D1, bind() itself refuses values SQLite cannot store.
  assert.throws(() => db.prepare('SELECT ?').bind(undefined), /D1_ERROR: Type 'undefined' not supported/);
  assert.throws(() => db.prepare('SELECT ?').bind({}), /D1_ERROR: Type 'object' not supported/);
  await assert.rejects(db.prepare('INSERT INTO t (name) VALUES (?)').bind('a').run(), /D1_ERROR: UNIQUE constraint failed: t.name/);
});

test('d1: batch is one transaction and changes() guards the next statement', async () => {
  const db = new D1Database(':memory:');
  await db.exec('CREATE TABLE stock (id INTEGER PRIMARY KEY, qty INTEGER NOT NULL CHECK (qty >= 0)); CREATE TABLE ledger (qty INTEGER)');
  await db.prepare('INSERT INTO stock (id, qty) VALUES (1, 5)').run();
  const take = (n) => [
    db.prepare('UPDATE stock SET qty = qty - ? WHERE id = 1 AND qty >= ?').bind(n, n),
    db.prepare('INSERT INTO ledger (qty) SELECT ? WHERE changes() > 0').bind(-n),
  ];
  const ok = await db.batch(take(3));
  assert.deepEqual(ok.map((r) => r.meta.changes), [1, 1]);
  const refused = await db.batch(take(3));
  assert.deepEqual(refused.map((r) => r.meta.changes), [0, 0]);
  assert.deepEqual((await db.prepare('SELECT qty FROM ledger').all()).results, [{ qty: -3 }]);
  // An error anywhere rolls the whole batch back.
  await assert.rejects(db.batch([db.prepare('INSERT INTO ledger (qty) VALUES (100)'), db.prepare('UPDATE stock SET qty = -1')]), /CHECK constraint failed/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM ledger').first()).n, 1);
  assert.equal(await db.prepare('SELECT qty FROM stock').first('qty'), 2);
});

test('disk bucket: put, get, head, list, delete; keys cannot escape the folder', async () => {
  const b = new DiskBucket(join(dir, 'files'));
  await b.put('contract/2026-10/a.pdf', new TextEncoder().encode('%PDF-1'), { httpMetadata: { contentType: 'application/pdf' } });
  const o = await b.get('contract/2026-10/a.pdf');
  assert.equal(o.httpMetadata.contentType, 'application/pdf');
  assert.equal(o.size, 6);
  assert.equal(await new Response(o.body).text(), '%PDF-1');
  assert.equal((await b.head('contract/2026-10/a.pdf')).size, 6);
  assert.deepEqual((await b.list({ prefix: 'contract/' })).objects.map((x) => x.key), ['contract/2026-10/a.pdf']);
  await b.delete('contract/2026-10/a.pdf');
  assert.equal(await b.get('contract/2026-10/a.pdf'), null);
  await assert.rejects(b.put('../kint.txt', 'x'), /Invalid object key/);
  await assert.rejects(b.put('a/../../kint.txt', 'x'), /Invalid object key/);
});

// S3 lookalike that checks every signature (test/fake-s3.mjs).
let s3;
let s3base;
let objects;
const creds = { accessKeyId: 'AKIATEST', secretAccessKey: 'titok' };
before(async () => {
  s3 = await startFakeS3({ credentials: creds });
  s3base = s3.base;
  objects = s3.objects;
});
after(() => s3 && s3.close());

test('s3 bucket: signed requests, prefix, list, missing objects', async () => {
  const b = new S3Bucket({ bucket: 'b', region: 'eu-central-1', credentials: creds, endpoint: s3base, prefix: 'files/' });
  await b.put('photo/2026-10/x y.png', Buffer.from([1, 2, 3]), { httpMetadata: { contentType: 'image/png' } });
  assert.ok(objects.has('files/photo/2026-10/x y.png'));
  const o = await b.get('photo/2026-10/x y.png');
  assert.equal(o.httpMetadata.contentType, 'image/png');
  assert.deepEqual([...new Uint8Array(await o.arrayBuffer())], [1, 2, 3]);
  assert.equal((await b.head('photo/2026-10/x y.png')).size, 3);
  assert.equal(await b.get('nincs'), null);
  assert.deepEqual((await b.list({ prefix: 'photo/' })).objects.map((x) => x.key), ['photo/2026-10/x y.png']);
  await b.delete('photo/2026-10/x y.png');
  assert.equal(await b.head('photo/2026-10/x y.png'), null);
  const wrong = new S3Bucket({ bucket: 'b', region: 'eu-central-1', credentials: { ...creds, secretAccessKey: 'rossz' }, endpoint: s3base });
  await assert.rejects(wrong.put('a', 'b'), /SignatureDoesNotMatch/);
});

test('assets: _headers rules, ETag, single page fallback, no traversal', async () => {
  const d = join(dir, 'dist');
  mkdirSync(join(d, 'assets'), { recursive: true });
  writeFileSync(join(d, 'index.html'), '<!doctype html><title>x</title>');
  writeFileSync(join(d, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(d, '_headers'), '/*\n  X-Frame-Options: DENY\n  Content-Security-Policy: default-src \'self\'\n\n/assets/*\n  Cache-Control: public, max-age=3600\n');
  assert.equal(parseHeaders('/*\n  A: b\n').length, 1);
  const a = createAssets(d);
  const home = await a.fetch(new Request('http://x/'));
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.match(home.headers.get('content-type'), /text\/html/);
  const js = await a.fetch(new Request('http://x/assets/app.js'));
  assert.equal(js.headers.get('cache-control'), 'public, max-age=3600');
  assert.match(js.headers.get('content-type'), /javascript/);
  const again = await a.fetch(new Request('http://x/assets/app.js', { headers: { 'if-none-match': js.headers.get('etag') } }));
  assert.equal(again.status, 304);
  assert.equal((await a.fetch(new Request('http://x/megrendelesek/12'))).status, 200);
  assert.equal((await a.fetch(new Request('http://x/assets/nincs.js'))).status, 404);
  assert.equal((await a.fetch(new Request('http://x/_headers'))).status, 404);
  // The URL parser resolves dot segments, so this asks for /etc/passwd inside dist: the app page.
  const escape = await a.fetch(new Request('http://x/%2e%2e/%2e%2e/etc/passwd'));
  assert.match(await escape.text(), /<title>x<\/title>/);
  const encoded = await a.fetch(new Request('http://x/assets/..%2f..%2f..%2fetc/passwd'));
  assert.match(await encoded.text(), /<title>x<\/title>/);
  assert.equal((await a.fetch(new Request('http://x/', { method: 'POST' }))).status, 405);
});

test('migrations: applied once, in order, a failing one rolls back and stops', async () => {
  const m = join(dir, 'migrations');
  mkdirSync(m);
  writeFileSync(join(m, '0001_a.sql'), 'CREATE TABLE a (id INTEGER);\nINSERT INTO a VALUES (1);');
  writeFileSync(join(m, '0002_b.sql'), 'CREATE TABLE b (id INTEGER);');
  const path = join(dir, 'm.sqlite');
  assert.deepEqual(await migrate(path, { dir: m, log: () => {} }), ['0001_a.sql', '0002_b.sql']);
  assert.deepEqual(await migrate(path, { dir: m, log: () => {} }), []);
  writeFileSync(join(m, '0003_bad.sql'), 'CREATE TABLE c (id INTEGER);\nINSERT INTO nincs VALUES (1);');
  await assert.rejects(migrate(path, { dir: m, log: () => {} }), /0003_bad.sql failed: no such table: nincs/);
  const db = new D1Database(path);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'c'").first('n'), 0);
  assert.deepEqual((await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results.map((r) => r.name), ['0001_a.sql', '0002_b.sql']);
  db.close();
});

test('backups: consistent gzipped copy, restore, pruning keeps 48 hours and then one a day', async () => {
  const path = join(dir, 'live.sqlite');
  const db = new D1Database(path);
  await db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('mentve')");
  const bucket = new DiskBucket(join(dir, 'bk'));
  const key = await backupDatabase(path, bucket, { now: new Date('2026-10-16T14:15:00Z'), log: () => {} });
  assert.equal(key, 'backups/db/2026-10-16/1415.sqlite.gz');
  const restored = await restoreBackup(bucket, key, join(dir, 'restored.sqlite'));
  const r = new D1Database(restored);
  assert.equal(await r.prepare('SELECT v FROM t').first('v'), 'mentve');
  r.close();
  db.close();

  const old = ['2026-10-01/0015', '2026-10-01/1315', '2026-10-02/0015', '2026-07-01/0015', '2026-10-15/0015', '2026-10-16/1315'];
  for (const k of old) await bucket.put(`backups/db/${k}.sqlite.gz`, 'x');
  const removed = await pruneBackups(bucket, { now: new Date('2026-10-16T14:20:00Z'), log: () => {} });
  assert.deepEqual(removed.sort(), ['backups/db/2026-07-01/0015.sqlite.gz', 'backups/db/2026-10-01/1315.sqlite.gz']);
  assert.ok(readdirSync(join(dir, 'bk', 'backups', 'db')).includes('2026-10-16'));
});
