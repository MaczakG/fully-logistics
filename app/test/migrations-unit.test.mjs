// Migrations from parallel work must not clash: one number per file, and every table and index
// name created once (D1 stops at the first clash and the later migrations never run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../migrations/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

test('migration numbers are unique', () => {
  const numbers = files.map((f) => f.slice(0, 4));
  assert.deepEqual(numbers.filter((n, i) => numbers.indexOf(n) !== i), []);
});

test('every table and index is created once', () => {
  const seen = new Map();
  const clashes = [];
  for (const f of files) {
    const sql = readFileSync(new URL(f, dir), 'utf8').replace(/--.*$/gm, '');
    for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)/gi)) {
      if (m[2]) continue;
      const key = `${m[1].toUpperCase()} ${m[3]}`;
      if (seen.has(key)) clashes.push(`${key}: ${seen.get(key)} and ${f}`);
      else seen.set(key, f);
    }
  }
  assert.deepEqual(clashes, []);
});
