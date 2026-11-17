// D1 helpers. All SQL goes through these so undefined values never reach bind() (D1 rejects them).

import { budapestYear } from './time.js';

const clean = (args) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a));

export const stmt = (db, sql, ...args) => db.prepare(sql).bind(...clean(args));

export async function all(db, sql, ...args) {
  const { results } = await stmt(db, sql, ...args).all();
  return results;
}

export const first = (db, sql, ...args) => stmt(db, sql, ...args).first();

export const run = (db, sql, ...args) => stmt(db, sql, ...args).run();

// Runs prepared statements atomically (all or nothing). Returns the D1 results array.
export const batch = (db, statements) => db.batch(statements.filter(Boolean));

// "?, ?, ?" for an IN (...) list.
export const marks = (n) => Array.from({ length: n }, () => '?').join(', ');

// Next running number for a prefix in the current year: "BT-2026-00042".
export async function nextNumber(db, prefix, pad = 5) {
  const year = budapestYear();
  const row = await first(
    db,
    `INSERT INTO sequences (prefix, year, value) VALUES (?, ?, 1)
     ON CONFLICT (prefix, year) DO UPDATE SET value = value + 1
     RETURNING value`,
    prefix,
    year,
  );
  return `${prefix}-${year}-${String(row.value).padStart(pad, '0')}`;
}

// settings table: JSON values by key.
export async function getSetting(db, key, fallback = null) {
  const row = await first(db, 'SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export const setSetting = (db, key, value) =>
  run(db, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));

// Builds "col = ?, col2 = ?" from an object of changes, for UPDATE statements.
export function setClause(changes) {
  const keys = Object.keys(changes);
  return { sql: keys.map((k) => `${k} = ?`).join(', '), args: keys.map((k) => changes[k]) };
}

// Parses JSON columns safely.
export function parseJson(text, fallback) {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
