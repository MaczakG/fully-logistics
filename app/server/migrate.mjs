// Applies migrations/*.sql in order, each in its own transaction, and records them in the same
// d1_migrations table wrangler uses. A failing migration is rolled back and stops the run.
//
//   node server/migrate.mjs [--db path] [--dir migrations]   (DB_PATH from the environment otherwise)

import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(HERE, '../migrations');

export async function migrate(dbPath, { dir = MIGRATIONS_DIR, log = console.log } = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`);
    const done = new Set(db.prepare('SELECT name FROM d1_migrations').all().map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const applied = [];
    for (const name of files) {
      if (done.has(name)) continue;
      const sql = await readFile(resolve(dir, name), 'utf8');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(sql);
        db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw new Error(`Migration ${name} failed: ${err.message}`);
      }
      applied.push(name);
      log(`migration applied: ${name}`);
    }
    return applied;
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const dbPath = arg('--db') || process.env.DB_PATH;
  if (!dbPath) { console.error('DB_PATH or --db is required'); process.exit(2); }
  migrate(dbPath, { dir: arg('--dir') || MIGRATIONS_DIR })
    .then((applied) => console.log(applied.length ? `${applied.length} migration(s) applied` : 'database is up to date'))
    .catch((err) => { console.error(err.message); process.exit(1); });
}
