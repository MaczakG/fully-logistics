// The part of Cloudflare's D1 API the app uses, on a local SQLite file (node:sqlite).
//
//   db.prepare(sql).bind(...values)  -> statement
//   statement.all()   -> { results, success, meta: { changes, last_row_id, duration, ... } }
//   statement.first(column?) -> row, the column's value, or null
//   statement.run()   -> { results: [], success, meta }
//   statement.raw({ columnNames }) -> rows as arrays
//   db.batch([statements]) -> one transaction; results in order; any error rolls everything back
//   db.exec(sql)      -> runs one or more statements without results
//
// Values are converted as D1 does: booleans become 1 or 0, undefined and objects are refused.
// node:sqlite is synchronous, so a batch is never interleaved with other requests.

import { DatabaseSync } from 'node:sqlite';

export class D1Error extends Error {
  constructor(message, cause) {
    super(`D1_ERROR: ${message}`);
    this.name = 'D1Error';
    if (cause) this.cause = cause;
  }
}

function toSql(v, i) {
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new D1Error(`Type '${v === undefined ? 'undefined' : typeof v}' not supported for value '${String(v)}' (parameter ${i + 1})`);
}

// D1 hands out plain objects; node:sqlite rows have a null prototype.
const plain = (row) => (row ? Object.assign({}, row) : row);

export class D1Statement {
  constructor(db, sql, values = []) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new D1Statement(this.db, this.sql, values.map(toSql));
  }

  // Runs the statement once and reports the rows plus what it changed.
  execute(mode = 'objects') {
    const sqlite = this.db.sqlite;
    const started = performance.now();
    let rows;
    let stmt;
    try {
      stmt = sqlite.prepare(this.sql);
      if (mode === 'arrays') stmt.setReturnArrays?.(true);
      const before = this.db.totalChanges();
      rows = stmt.all(...this.values);
      const after = this.db.totalChanges();
      const info = sqlite.prepare('SELECT changes() AS changes, last_insert_rowid() AS id').get();
      const changes = after !== before ? info.changes : 0;
      return {
        rows: mode !== 'arrays' ? rows.map(plain) : stmt.setReturnArrays ? rows : rows.map((r) => Object.values(r)),
        columns: mode === 'arrays' && stmt.columns ? stmt.columns().map((c) => c.name) : [],
        meta: {
          changed_db: changes > 0,
          changes,
          last_row_id: info.id,
          duration: performance.now() - started,
          rows_read: rows.length,
          rows_written: changes,
          size_after: 0,
        },
      };
    } catch (err) {
      if (err instanceof D1Error) throw err;
      throw new D1Error(err.message, err);
    }
  }

  async all() {
    const r = this.execute();
    return { results: r.rows, success: true, meta: r.meta };
  }

  async run() {
    const r = this.execute();
    return { results: [], success: true, meta: r.meta };
  }

  async first(column) {
    const r = this.execute();
    const row = r.rows[0];
    if (!row) return null;
    if (column === undefined) return row;
    if (!(column in row)) throw new D1Error(`Column not found: ${column}`);
    return row[column];
  }

  async raw({ columnNames = false } = {}) {
    const r = this.execute('arrays');
    return columnNames ? [r.columns, ...r.rows] : r.rows;
  }
}

export class D1Database {
  constructor(path, { busyTimeoutMs = 5000 } = {}) {
    this.sqlite = new DatabaseSync(path);
    this.path = path;
    this.sqlite.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0}`);
    if (path !== ':memory:') this.sqlite.exec('PRAGMA journal_mode = WAL');
    this.sqlite.exec('PRAGMA synchronous = NORMAL');
    // D1 enforces foreign keys.
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    this.totalStmt = this.sqlite.prepare('SELECT total_changes() AS n');
  }

  totalChanges() {
    return this.totalStmt.get().n;
  }

  prepare(sql) {
    return new D1Statement(this, sql);
  }

  async batch(statements) {
    if (!Array.isArray(statements)) throw new D1Error('batch() expects an array of statements');
    const sqlite = this.sqlite;
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const out = statements.map((s) => {
        const r = s.execute();
        return { results: r.rows, success: true, meta: r.meta };
      });
      sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      try { sqlite.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err instanceof D1Error ? err : new D1Error(err.message, err);
    }
  }

  async exec(sql) {
    try {
      this.sqlite.exec(sql);
      return { count: 1, duration: 0 };
    } catch (err) {
      throw new D1Error(err.message, err);
    }
  }

  close() {
    this.sqlite.close();
  }
}
