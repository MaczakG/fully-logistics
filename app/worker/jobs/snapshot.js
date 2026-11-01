// Daily storage snapshot for pro-rata storage billing: which partner occupies which location at
// the end of each Budapest day. Contract:
//
//   takeDailySnapshot(env, date?, { now?, source? }) -> Promise<{ date, rows, recorded, fallback? }>
//
//   Without a date (the hourly cron, "5 * * * *"):
//     - if yesterday has no snapshot at all although earlier days have one (a missed run), it
//       records yesterday from the current stock as a fallback and writes that to the audit log;
//     - from 23:00 Budapest time it records today once. Idempotent: later runs the same evening
//       do nothing. A snapshot taken earlier in the day (manual) is replaced by the end of day one.
//   With a date it (re)records that date from the current stock (tests, and the admin action
//   "Pillanatkép rögzítése most" for today).
//
// One storage_snapshots row per location holding stock: date, location, partner of the goods,
// size of the location. Storage and quarantine locations count (the partner occupies them, also
// when the goods are blocked); receiving, packing and returns zones are transit areas and are not
// billed; empty locations are not recorded. Every recorded day also gets a snapshot_runs row,
// so "recorded, nothing occupied" and "not recorded" can be told apart.
//
// `now` (Date or ISO string) only exists so tests can simulate the clock.

import { all, batch, first, stmt } from '../lib/db.js';
import { badRequest } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { addDays, budapestDate, budapestTime, isDate } from '../lib/time.js';

export const BILLED_KINDS = ['storage', 'quarantine'];
const END_OF_DAY = '23:00';

const OCCUPIED_SQL = `
  SELECT l.id AS location_id, l.size_id, MIN(p.partner_id) AS partner_id, COUNT(DISTINCT p.partner_id) AS partners
  FROM stock s
  JOIN locations l ON l.id = s.location_id
  JOIN products p ON p.id = s.product_id
  WHERE s.qty > 0 AND l.kind IN ('storage', 'quarantine')
  GROUP BY l.id, l.size_id`;

// Records one date from the current stock. Replaces whatever was recorded for that date before.
async function record(env, date, source, at) {
  const db = env.DB;
  const occupied = await all(db, OCCUPIED_SQL);
  const mixed = occupied.filter((r) => r.partners > 1);
  if (mixed.length) {
    // lib/stock.js prevents this; if old data breaks the rule, bill the lowest partner id and say so.
    console.warn(`snapshot ${date}: ${mixed.length} location(s) hold goods of more than one partner`, mixed.map((r) => r.location_id));
  }
  await batch(db, [
    stmt(db, 'DELETE FROM storage_snapshots WHERE date = ?', date),
    stmt(db, `INSERT INTO storage_snapshots (date, location_id, partner_id, size_id)
              SELECT ?, x.location_id, x.partner_id, x.size_id FROM (${OCCUPIED_SQL}) x`, date),
    stmt(db, `INSERT INTO snapshot_runs (date, taken_at, rows, source)
              VALUES (?, ?, (SELECT COUNT(*) FROM storage_snapshots WHERE date = ?), ?)
              ON CONFLICT (date) DO UPDATE SET taken_at = excluded.taken_at, rows = excluded.rows, source = excluded.source`,
      date, at, date, source),
  ]);
  const row = await first(db, 'SELECT rows FROM snapshot_runs WHERE date = ?', date);
  return row.rows;
}

export async function takeDailySnapshot(env, date = null, { now = null, source = null } = {}) {
  const clock = now ? new Date(now) : new Date();
  if (Number.isNaN(clock.getTime())) throw badRequest('Érvénytelen időpont.');
  const at = clock.toISOString();
  const db = env.DB;

  if (date) {
    if (!isDate(date)) throw badRequest('Dátumot várunk (ÉÉÉÉ-HH-NN).');
    const rows = await record(env, date, source || 'manual', at);
    return { date, rows, recorded: true };
  }

  const today = budapestDate(clock);
  const yesterday = addDays(today, -1);
  const out = { date: today, rows: 0, recorded: false };

  // Missed run: yesterday was never recorded although the job has run before.
  const [yRun, earlier] = await Promise.all([
    first(db, 'SELECT date FROM snapshot_runs WHERE date = ?', yesterday),
    first(db, 'SELECT date FROM snapshot_runs WHERE date < ? LIMIT 1', yesterday),
  ]);
  if (!yRun && earlier) {
    const rows = await record(env, yesterday, 'fallback', at);
    out.fallback = { date: yesterday, rows };
    console.warn(`snapshot: no snapshot for ${yesterday}, recorded it from the current stock (${rows} locations)`);
    await audit({ env, user: null, apiPartner: null }, {
      module: 'billing', action: 'snapshot', entity: 'snapshot', entityId: yesterday,
      summary: `Pótló pillanatkép ${yesterday} napra a jelenlegi készletből (kimaradt futás), ${rows} raktárhely`,
    });
  }

  if (budapestTime(clock) < END_OF_DAY) return out;
  const todayRun = await first(db, 'SELECT taken_at FROM snapshot_runs WHERE date = ?', today);
  if (todayRun && budapestDate(new Date(todayRun.taken_at)) === today && budapestTime(new Date(todayRun.taken_at)) >= END_OF_DAY) {
    const n = await first(db, 'SELECT rows FROM snapshot_runs WHERE date = ?', today);
    return { ...out, rows: n.rows };
  }
  out.rows = await record(env, today, source || 'cron', at);
  out.recorded = true;
  return out;
}
