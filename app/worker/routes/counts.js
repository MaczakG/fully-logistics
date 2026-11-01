// Leltár: inventory counts, counting, posting differences. Prefix /api/counts
//
// Lifecycle: open -> counting (first entry) -> counted (every line counted, or "finish") -> posted.
// open, counting, counted -> cancelled (counts delete) as long as nothing is booked yet.
//
// Lines are a snapshot of stock when the count is created: one line per (location, product, lot,
// expiry) with the expected quantity, plus one line without product per empty location, so goods
// found there can be recorded. snapshot_mid remembers the highest movement id at that moment: a
// later movement of the same product at the same location means the stock changed since the
// snapshot, and posting such a line needs an explicit confirmation or a recount.
//
// Blind counts (default): users without [counts approve] never get expected quantities (nor booked
// differences, which would reveal them) while the count is open.

import { all, batch, first, marks, nextNumber, parseJson, run, stmt } from '../lib/db.js';
import { badRequest, conflict, notFound, page } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { can } from '../lib/perm.js';
import { setStockQty } from '../lib/stock.js';
import { nowIso } from '../lib/time.js';

export const COUNT_TYPES = {
  cycle: 'Ciklikus',
  zone: 'Zóna',
  product: 'Termék',
  full: 'Teljes',
  locations: 'Kijelölt helyek',
};
const ACTIVE = ['open', 'counting', 'counted'];
const ACTIVE_SQL = "('open', 'counting', 'counted')";
// Location kinds that may hold stock (mirrors lib/stock.js), used by the posting pre-check.
const STORABLE_SQL = "('storage', 'receiving', 'returns', 'quarantine', 'packing')";
// Highest movement id, read inside the same transaction as the stock snapshot.
const MID = '(SELECT COALESCE(MAX(id), 0) FROM movements)';
const CHUNK = 90; // bound parameters per statement stay under the D1 limit of 100
const MAX_PRODUCTS = 40;
const MAX_LOCATIONS = 500;
const POST_CHUNK = 100; // lines with a difference booked per request (D1 queries per invocation)

const MOVED_SQL = `EXISTS (SELECT 1 FROM movements m WHERE m.product_id = cl.product_id AND m.location_id = cl.location_id
  AND m.id > cl.snapshot_mid AND NOT (m.ref_type = 'count' AND m.ref_id = cl.count_id))`;
const CURRENT_SQL = `COALESCE((SELECT s.qty FROM stock s WHERE s.product_id = cl.product_id AND s.location_id = cl.location_id
  AND s.lot = cl.lot AND s.expiry = cl.expiry), 0)`;

const LINE_SQL = `SELECT cl.id, cl.location_id, cl.product_id, cl.lot, cl.expiry, cl.expected_qty, cl.counted_qty, cl.counted_at,
    cl.added, cl.posted_at, cl.posted_diff, p.sku, p.name, p.ean, p.unit, p.partner_id, pa.code AS partner_code,
    u.name AS counted_by_name, l.code AS location_code, l.zone
  FROM count_lines cl JOIN locations l ON l.id = cl.location_id
  LEFT JOIN products p ON p.id = cl.product_id LEFT JOIN partners pa ON pa.id = p.partner_id
  LEFT JOIN users u ON u.id = cl.counted_by
  WHERE cl.count_id = ?`;
const LINE_ORDER = 'ORDER BY l.pick_sequence, l.code, cl.product_id IS NULL, p.sku, cl.lot, cl.expiry, cl.id';

const intId = (v, what = 'A leltár') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw notFound(`${what} nem található.`);
  return n;
};
const userId = (ctx) => (ctx.user ? ctx.user.id : null);
const chunks = (list, size = CHUNK) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};
const shortList = (items, n = 5) => (items.length > n ? `${items.slice(0, n).join(', ')} és még ${items.length - n}` : items.join(', '));

async function loadCount(db, id) {
  const c = await first(db,
    `SELECT c.*, cu.name AS created_by_name, pu.name AS posted_by_name
     FROM counts c LEFT JOIN users cu ON cu.id = c.created_by LEFT JOIN users pu ON pu.id = c.posted_by WHERE c.id = ?`, id);
  if (!c) throw notFound('A leltár nem található.');
  c.blind = !!c.blind;
  c.filter = parseJson(c.filter, {});
  return c;
}

// Expected quantities are visible unless the count is blind, still open and the user may not approve.
const seesExpected = (ctx, c) => !c.blind || can(ctx.user, 'counts', 'approve') || !ACTIVE.includes(c.status);

function assertEditable(c) {
  if (c.status === 'posted') throw conflict(`A(z) ${c.number} leltár már könyvelve van, nem módosítható.`);
  if (c.status === 'cancelled') throw conflict(`A(z) ${c.number} leltár törölve van.`);
}

function shapeLine(r, visible) {
  const line = {
    id: r.id, location_id: r.location_id, location_code: r.location_code, zone: r.zone,
    product_id: r.product_id, sku: r.sku || '', name: r.name || '', ean: r.ean || '', unit: r.unit || 'db',
    partner_id: r.partner_id ?? null, partner_code: r.partner_code || '',
    lot: r.lot, expiry: r.expiry, counted_qty: r.counted_qty, counted_by_name: r.counted_by_name || '', counted_at: r.counted_at,
    added: !!r.added, posted: !!r.posted_at,
  };
  if (visible) {
    line.expected_qty = r.expected_qty;
    line.posted_diff = r.posted_diff;
  }
  return line;
}

async function progress(db, countId) {
  const p = await first(db,
    `SELECT COUNT(*) AS lines, SUM(CASE WHEN counted_qty IS NOT NULL THEN 1 ELSE 0 END) AS counted_lines,
            COUNT(DISTINCT location_id) AS locations,
            (SELECT COUNT(*) FROM (SELECT location_id FROM count_lines WHERE count_id = ? GROUP BY location_id
               HAVING SUM(CASE WHEN counted_qty IS NULL THEN 1 ELSE 0 END) = 0)) AS done_locations
     FROM count_lines WHERE count_id = ?`, countId, countId);
  return { lines: p.lines || 0, counted_lines: p.counted_lines || 0, locations: p.locations || 0, done_locations: p.done_locations || 0 };
}

// After an entry: open -> counting, and -> counted once no line is left uncounted. A count the
// user already finished stays counted.
const touchStatus = (db, countId, at) => stmt(db,
  `UPDATE counts SET
     status = CASE WHEN status = 'counted' THEN 'counted'
                   WHEN NOT EXISTS (SELECT 1 FROM count_lines WHERE count_id = counts.id AND counted_qty IS NULL) THEN 'counted'
                   ELSE 'counting' END,
     counted_at = CASE WHEN status = 'counted' THEN counted_at
                   WHEN NOT EXISTS (SELECT 1 FROM count_lines WHERE count_id = counts.id AND counted_qty IS NULL) THEN ?
                   ELSE counted_at END,
     started_at = COALESCE(started_at, ?), updated_at = ?
   WHERE id = ? AND status IN ${ACTIVE_SQL}`, at, at, at, countId);

// A line was reset: a finished count goes back to counting.
const reopenStatus = (db, countId, at) => stmt(db,
  `UPDATE counts SET status = 'counting', counted_at = NULL, updated_at = ? WHERE id = ? AND status = 'counted'
     AND EXISTS (SELECT 1 FROM count_lines WHERE count_id = counts.id AND counted_qty IS NULL)`, at, countId);

async function locationState(ctx, c, locationId) {
  const db = ctx.env.DB;
  const rows = await all(db, `${LINE_SQL} AND cl.location_id = ? ${LINE_ORDER}`, c.id, locationId);
  if (!rows.length) throw badRequest('Ez a raktárhely nem része a leltárnak.');
  const loc = await first(db, 'SELECT id, code, zone, kind FROM locations WHERE id = ?', locationId);
  const fresh = await first(db, 'SELECT status FROM counts WHERE id = ?', c.id);
  const visible = seesExpected(ctx, { ...c, status: fresh.status });
  return {
    count: { id: c.id, number: c.number, status: fresh.status, blind: c.blind, can_see_expected: visible },
    location: { ...loc, done: rows.every((r) => r.counted_qty != null) },
    lines: rows.map((r) => shapeLine(r, visible)),
    progress: await progress(db, c.id),
  };
}

async function lineInCount(db, c, lineId) {
  const line = await first(db, 'SELECT * FROM count_lines WHERE id = ? AND count_id = ?', lineId, c.id);
  if (!line) throw notFound('A tétel nem található ebben a leltárban.');
  if (line.posted_at) throw conflict('Ez a tétel már könyvelve van, nem módosítható.');
  return line;
}

// Statement that records a quantity on a line: { add } increments, { counted_qty } sets, null clears.
function entryStmt(db, lineId, data, uid, at) {
  if (data.add !== undefined) {
    return stmt(db, `UPDATE count_lines SET counted_qty = MAX(COALESCE(counted_qty, 0) + ?, 0), counted_by = ?, counted_at = ?
                     WHERE id = ? AND posted_at IS NULL`, data.add, uid, at, lineId);
  }
  if (data.counted_qty === null) {
    return stmt(db, 'UPDATE count_lines SET counted_qty = NULL, counted_by = NULL, counted_at = NULL WHERE id = ? AND posted_at IS NULL', lineId);
  }
  return stmt(db, 'UPDATE count_lines SET counted_qty = ?, counted_by = ?, counted_at = ? WHERE id = ? AND posted_at IS NULL',
    data.counted_qty, uid, at, lineId);
}

const ENTRY_FIELDS = {
  counted_qty: { type: 'int', min: 0, max: 1000000, nullable: true },
  add: { type: 'int', min: -100000, max: 100000 },
};

// ---------------------------------------------------------------- creation

const CREATE_FIELDS = {
  type: { type: 'enum', values: Object.keys(COUNT_TYPES), required: true },
  blind: { type: 'bool', default: true },
  note: { type: 'text', max: 2000, default: '' },
  limit: { type: 'int', min: 1, max: MAX_LOCATIONS },
  zone: { type: 'str', max: 40 },
  product_ids: { type: 'json' },
  location_codes: { type: 'json' },
  location_ids: { type: 'json' },
};

// Location scope of a new count: sets of { cond, args } on alias l (chunked id lists or a plain
// condition), an optional product filter, the scope text shown to users and the stored filter.
async function resolveScope(db, d) {
  if (d.type === 'cycle') {
    const limit = d.limit || 20;
    const zone = d.zone || null;
    // Not counted for the longest time first (never counted first), then walking order. Locations
    // already in an open count are left out.
    const rows = await all(db,
      `SELECT l.id FROM locations l
       LEFT JOIN (SELECT cl.location_id, MAX(c.posted_at) AS last FROM count_lines cl JOIN counts c ON c.id = cl.count_id
                  WHERE c.status = 'posted' AND cl.counted_qty IS NOT NULL GROUP BY cl.location_id) lc ON lc.location_id = l.id
       WHERE l.active = 1 AND l.kind = 'storage' AND (? IS NULL OR l.zone = ?)
         AND NOT EXISTS (SELECT 1 FROM count_lines cl2 JOIN counts c2 ON c2.id = cl2.count_id
                         WHERE cl2.location_id = l.id AND c2.status IN ${ACTIVE_SQL})
       ORDER BY lc.last IS NOT NULL, lc.last, l.pick_sequence, l.code LIMIT ?`, zone, zone, limit);
    if (!rows.length) throw badRequest('Nincs számolható raktárhely: mindegyik szerepel már egy nyitott leltárban.', zone ? { zone: 'Ebben a zónában nincs szabad hely.' } : undefined);
    const ids = rows.map((r) => r.id);
    return {
      sets: chunks(ids).map((c) => ({ cond: `l.id IN (${marks(c.length)})`, args: c })),
      scope: `${ids.length} hely, a legrégebben számoltak${zone ? `, ${zone} zóna` : ''}`,
      filter: { limit, zone },
    };
  }
  if (d.type === 'zone') {
    if (!d.zone) throw badRequest('Válassz zónát.', { zone: 'Kötelező mező.' });
    const z = await first(db, 'SELECT COUNT(*) AS n FROM locations WHERE zone = ? AND active = 1', d.zone);
    if (!z.n) throw badRequest('Ebben a zónában nincs aktív raktárhely.', { zone: 'Ismeretlen vagy üres zóna.' });
    return { sets: [{ cond: 'l.zone = ? AND l.active = 1', args: [d.zone] }], scope: `${d.zone} zóna`, filter: { zone: d.zone } };
  }
  if (d.type === 'full') {
    return { sets: [{ cond: "l.kind = 'storage' AND l.active = 1", args: [] }], scope: 'Teljes raktár, minden aktív tárolóhely', filter: {} };
  }
  if (d.type === 'product') {
    const ids = [...new Set((Array.isArray(d.product_ids) ? d.product_ids : []).map(Number))];
    if (!ids.length || ids.some((n) => !Number.isInteger(n) || n < 1)) throw badRequest('Válassz legalább egy terméket.', { product_ids: 'Válassz terméket.' });
    if (ids.length > MAX_PRODUCTS) throw badRequest(`Egyszerre legfeljebb ${MAX_PRODUCTS} termék számolható.`, { product_ids: 'Túl sok termék.' });
    const products = await all(db, `SELECT id, sku FROM products WHERE id IN (${marks(ids.length)}) ORDER BY sku`, ...ids);
    if (products.length !== ids.length) throw badRequest('Ismeretlen termék a listában.', { product_ids: 'Ismeretlen termék.' });
    const held = await first(db, `SELECT COUNT(*) AS n FROM stock WHERE qty > 0 AND product_id IN (${marks(ids.length)})`, ...ids);
    if (!held.n) throw badRequest('A kiválasztott termékekből nincs készlet egyik raktárhelyen sem.', { product_ids: 'Nincs készlet.' });
    return {
      sets: [{ cond: `l.id IN (SELECT s2.location_id FROM stock s2 WHERE s2.qty > 0 AND s2.product_id IN (${marks(ids.length)}))`, args: ids }],
      products: ids,
      scope: shortList(products.map((p) => p.sku), 8),
      filter: { product_ids: ids },
    };
  }
  // locations: explicit codes (from the form) or ids
  let rows = [];
  if (Array.isArray(d.location_codes) && d.location_codes.length) {
    const codes = [...new Set(d.location_codes.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
    if (codes.length > MAX_LOCATIONS) throw badRequest(`Legfeljebb ${MAX_LOCATIONS} hely adható meg.`, { location_codes: 'Túl sok hely.' });
    for (const c of chunks(codes)) {
      rows.push(...await all(db, `SELECT id, code, active FROM locations WHERE UPPER(code) IN (${marks(c.length)})`, ...c));
    }
    const found = new Set(rows.map((r) => r.code.toUpperCase()));
    const unknown = codes.filter((c) => !found.has(c));
    if (unknown.length) throw badRequest(`Ismeretlen raktárhely: ${shortList(unknown)}.`, { location_codes: `Ismeretlen: ${shortList(unknown)}` });
  } else if (Array.isArray(d.location_ids) && d.location_ids.length) {
    const ids = [...new Set(d.location_ids.map(Number))];
    if (ids.some((n) => !Number.isInteger(n) || n < 1)) throw badRequest('Hibás raktárhely azonosító.', { location_ids: 'Hibás azonosító.' });
    if (ids.length > MAX_LOCATIONS) throw badRequest(`Legfeljebb ${MAX_LOCATIONS} hely adható meg.`, { location_ids: 'Túl sok hely.' });
    for (const c of chunks(ids)) rows.push(...await all(db, `SELECT id, code, active FROM locations WHERE id IN (${marks(c.length)})`, ...c));
    if (rows.length !== ids.length) throw badRequest('Ismeretlen raktárhely a listában.', { location_ids: 'Ismeretlen hely.' });
  } else {
    throw badRequest('Adj meg legalább egy raktárhelyet.', { location_codes: 'Kötelező mező.' });
  }
  const inactive = rows.filter((r) => !r.active).map((r) => r.code);
  if (inactive.length) throw badRequest(`Inaktív raktárhely: ${shortList(inactive)}.`, { location_codes: `Inaktív: ${shortList(inactive)}` });
  rows = rows.sort((a, b) => a.code.localeCompare(b.code));
  const ids = rows.map((r) => r.id);
  const scope = rows.map((r) => r.code).join(', ');
  return {
    sets: chunks(ids).map((c) => ({ cond: `l.id IN (${marks(c.length)})`, args: c })),
    scope: scope.length > 280 ? `${rows.length} hely: ${shortList(rows.map((r) => r.code), 12)}` : scope,
    filter: { location_ids: ids },
  };
}

// Snapshot statements for a set of locations: stock lines and one empty line per empty location.
function snapshotStmts(db, ref, refArgs, set, products) {
  const pf = products ? ` AND s.product_id IN (${marks(products.length)})` : '';
  const out = [
    stmt(db, `INSERT INTO count_lines (count_id, location_id, product_id, lot, expiry, expected_qty, snapshot_mid)
              SELECT ${ref}, s.location_id, s.product_id, s.lot, s.expiry, s.qty, ${MID}
              FROM stock s JOIN locations l ON l.id = s.location_id WHERE s.qty > 0 AND ${set.cond}${pf}`,
    ...refArgs, ...set.args, ...(products || [])),
  ];
  if (!products) {
    out.push(stmt(db, `INSERT INTO count_lines (count_id, location_id, product_id, expected_qty, snapshot_mid)
                       SELECT ${ref}, l.id, NULL, 0, ${MID} FROM locations l
                       WHERE ${set.cond} AND NOT EXISTS (SELECT 1 FROM stock s WHERE s.location_id = l.id AND s.qty > 0)`,
    ...refArgs, ...set.args));
  }
  return out;
}

async function createCount(ctx, body) {
  const db = ctx.env.DB;
  const d = validate(body, CREATE_FIELDS);
  const scope = await resolveScope(db, d);

  // One location is only ever in one open count, so two counts never book over each other.
  let locations = 0;
  const busy = [];
  for (const set of scope.sets) {
    locations += (await first(db, `SELECT COUNT(*) AS n FROM locations l WHERE ${set.cond}`, ...set.args)).n;
    busy.push(...await all(db,
      `SELECT DISTINCT l.code, c.number FROM count_lines cl JOIN counts c ON c.id = cl.count_id JOIN locations l ON l.id = cl.location_id
       WHERE c.status IN ${ACTIVE_SQL} AND ${set.cond} LIMIT 6`, ...set.args));
  }
  if (!locations) throw badRequest('Nincs a feltételeknek megfelelő raktárhely.');
  if (busy.length) {
    const what = shortList([...new Set(busy.map((b) => `${b.code} (${b.number})`))]);
    throw conflict(`Ezek a helyek már egy nyitott leltárban vannak: ${what}. Fejezd be vagy töröld azt a leltárt, vagy hagyd ki ezeket a helyeket.`);
  }

  const number = await nextNumber(db, 'LT');
  const at = nowIso();
  const ref = '(SELECT id FROM counts WHERE number = ?)';
  await batch(db, [
    stmt(db, `INSERT INTO counts (number, type, scope, blind, status, note, filter, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
    number, d.type, scope.scope, d.blind ? 1 : 0, d.note, JSON.stringify(scope.filter), userId(ctx), at, at),
    ...scope.sets.flatMap((set) => snapshotStmts(db, ref, [number], set, scope.products)),
  ]);
  const row = await first(db, 'SELECT id FROM counts WHERE number = ?', number);
  const p = await progress(db, row.id);
  await audit(ctx, {
    module: 'counts', action: 'create', entity: 'count', entityId: row.id,
    summary: `${number} leltár indítva (${COUNT_TYPES[d.type]}: ${scope.scope}), ${p.locations} hely, ${p.lines} tétel`,
  });
  return { id: row.id, number, locations: p.locations, lines: p.lines };
}

// ---------------------------------------------------------------- review and posting

async function reviewLines(db, c) {
  return all(db,
    `SELECT cl.id, cl.location_id, cl.product_id, cl.lot, cl.expiry, cl.expected_qty, cl.counted_qty, cl.counted_at, cl.added,
            cl.posted_at, cl.posted_diff, p.sku, p.name, p.unit, pa.code AS partner_code, u.name AS counted_by_name,
            l.code AS location_code, l.zone,
            CASE WHEN cl.product_id IS NULL THEN 0 ELSE ${CURRENT_SQL} END AS current_qty,
            CASE WHEN cl.product_id IS NOT NULL AND cl.posted_at IS NULL AND ${MOVED_SQL} THEN 1 ELSE 0 END AS changed
     FROM count_lines cl JOIN locations l ON l.id = cl.location_id
     LEFT JOIN products p ON p.id = cl.product_id LEFT JOIN partners pa ON pa.id = p.partner_id
     LEFT JOIN users u ON u.id = cl.counted_by
     WHERE cl.count_id = ? ${LINE_ORDER}`, c.id);
}

function summarize(lines) {
  const s = { lines: lines.length, counted: 0, uncounted: 0, matching: 0, surplus: 0, shortage: 0, surplus_qty: 0, shortage_qty: 0, changed: 0 };
  for (const l of lines) {
    if (l.changed) s.changed++;
    if (l.counted_qty == null) { s.uncounted++; continue; }
    s.counted++;
    const diff = l.posted_at ? (l.posted_diff ?? 0) : l.counted_qty - l.expected_qty;
    if (diff > 0) { s.surplus++; s.surplus_qty += diff; } else if (diff < 0) { s.shortage++; s.shortage_qty += -diff; } else s.matching++;
  }
  return s;
}

// Refuses posting what lib/stock.js would refuse half way: two partners' goods in one location,
// goods into an inactive, non-storable or another partner's dedicated location.
async function precheckPosting(db, c) {
  const mixed = await all(db,
    `SELECT l.code FROM count_lines cl JOIN products p ON p.id = cl.product_id JOIN locations l ON l.id = cl.location_id
     WHERE cl.count_id = ? AND cl.posted_at IS NULL AND cl.counted_qty > 0
     GROUP BY cl.location_id HAVING COUNT(DISTINCT p.partner_id) > 1 LIMIT 6`, c.id);
  if (mixed.length) {
    throw conflict(`Két ügyfél áruját számoltátok ugyanazon a helyen: ${shortList(mixed.map((m) => m.code))}. Egy helyen csak egy ügyfél áruja lehet: tárold át az egyiket, majd számold újra a helyet.`);
  }
  const blocked = await all(db,
    `SELECT DISTINCT l.code FROM count_lines cl JOIN products p ON p.id = cl.product_id JOIN locations l ON l.id = cl.location_id
     WHERE cl.count_id = ? AND cl.posted_at IS NULL AND cl.counted_qty IS NOT NULL AND cl.counted_qty > ${CURRENT_SQL}
       AND (l.active = 0 OR l.kind NOT IN ${STORABLE_SQL} OR (l.partner_id IS NOT NULL AND l.partner_id <> p.partner_id)) LIMIT 6`, c.id);
  if (blocked.length) {
    throw conflict(`Ezekre a helyekre most nem könyvelhető többlet (inaktív, nem tárolóhely vagy másik ügyfél fix helye): ${shortList(blocked.map((b) => b.code))}.`);
  }
}

async function postCount(ctx, c, body) {
  const db = ctx.env.DB;
  if (!['counting', 'counted'].includes(c.status)) {
    if (c.status === 'open') throw conflict('Ebben a leltárban még nincs számolt tétel.');
    assertEditable(c);
  }
  const counted = await first(db, 'SELECT COUNT(*) AS n FROM count_lines WHERE count_id = ? AND counted_qty IS NOT NULL', c.id);
  if (!counted.n) throw conflict('Ebben a leltárban még nincs számolt tétel.');
  const confirm = new Set((Array.isArray(body.confirm_line_ids) ? body.confirm_line_ids : []).map(Number));
  const changed = await all(db,
    `SELECT cl.id, l.code, p.sku FROM count_lines cl JOIN locations l ON l.id = cl.location_id JOIN products p ON p.id = cl.product_id
     WHERE cl.count_id = ? AND cl.posted_at IS NULL AND cl.counted_qty IS NOT NULL AND ${MOVED_SQL}`, c.id);
  const unconfirmed = changed.filter((l) => !confirm.has(l.id));
  if (unconfirmed.length) {
    throw conflict(`${unconfirmed.length} tételnél mozgott a készlet a leltár indítása óta (${shortList(unconfirmed.map((l) => `${l.code} ${l.sku}`), 3)}). Számold újra ezeket a helyeket, vagy erősítsd meg a könyvelésüket.`);
  }
  await precheckPosting(db, c);

  const at = nowIso();
  // Lines without a difference (and confirmed empty locations) are booked in one statement.
  await run(db,
    `UPDATE count_lines AS cl SET posted_at = ?, posted_diff = 0
     WHERE cl.count_id = ? AND cl.posted_at IS NULL AND cl.counted_qty IS NOT NULL
       AND (cl.product_id IS NULL OR cl.counted_qty = ${CURRENT_SQL})`, at, c.id);

  // Shortages first, so a location emptied of one partner's goods can take another partner's.
  const todo = await all(db,
    `SELECT cl.id, cl.product_id, cl.location_id, cl.lot, cl.expiry, cl.counted_qty, cl.counted_qty - ${CURRENT_SQL} AS diff
     FROM count_lines cl WHERE cl.count_id = ? AND cl.posted_at IS NULL AND cl.counted_qty IS NOT NULL AND cl.product_id IS NOT NULL
     ORDER BY diff, cl.id LIMIT ?`, c.id, POST_CHUNK + 1);
  const now = todo.slice(0, POST_CHUNK);
  for (const l of now) {
    let diff;
    try {
      diff = await setStockQty(ctx, {
        productId: l.product_id, locationId: l.location_id, qty: l.counted_qty, lot: l.lot, expiry: l.expiry,
        refType: 'count', refId: c.id, note: `Leltár ${c.number}`,
      });
    } catch (err) {
      if (err && err.status) throw conflict(`A könyvelés megállt: ${err.message} A már könyvelt tételek megmaradnak, a hiba javítása után folytasd a könyvelést.`);
      throw err;
    }
    await run(db, 'UPDATE count_lines SET posted_at = ?, posted_diff = ? WHERE id = ?', nowIso(), diff, l.id);
  }
  if (todo.length > POST_CHUNK) {
    const left = await first(db, `SELECT COUNT(*) AS n FROM count_lines WHERE count_id = ? AND posted_at IS NULL AND counted_qty IS NOT NULL`, c.id);
    return { done: false, posted: now.length, remaining: left.n };
  }

  const fin = await run(db, `UPDATE counts SET status = 'posted', posted_by = ?, posted_at = ?, updated_at = ?,
                               counted_at = COALESCE(counted_at, ?) WHERE id = ? AND status IN ('counting', 'counted')`,
  userId(ctx), at, at, at, c.id);
  if (fin.meta.changes !== 1) throw conflict('A leltár állapota közben megváltozott. Töltsd újra az oldalt.');
  const lines = await all(db, 'SELECT counted_qty, expected_qty, posted_at, posted_diff FROM count_lines WHERE count_id = ?', c.id);
  const s = summarize(lines.map((l) => ({ ...l, changed: 0 })));
  await audit(ctx, {
    module: 'counts', action: 'approve', entity: 'count', entityId: c.id,
    summary: `${c.number} könyvelve: ${s.surplus} többlet (+${s.surplus_qty}), ${s.shortage} hiány (-${s.shortage_qty}), ${s.uncounted} nem számolt tétel`,
    details: { ...s, confirmed_changed: changed.map((l) => l.id) },
  });
  return { done: true, summary: s };
}

// ---------------------------------------------------------------- routes

export function register(r) {
  r.get('/api/counts', async (ctx) => {
    const db = ctx.env.DB;
    const status = ctx.query.get('status') || 'active';
    const type = ctx.query.get('type') || null;
    const q = (ctx.query.get('q') || '').trim();
    const { limit, offset } = page(ctx.query);
    const where = [];
    const args = [];
    if (status === 'active') where.push(`c.status IN ${ACTIVE_SQL}`);
    else if (status !== 'all') { where.push('c.status = ?'); args.push(status); }
    if (type) { where.push('c.type = ?'); args.push(type); }
    if (q) { where.push('(c.number LIKE ? OR c.scope LIKE ? OR c.note LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await first(db, `SELECT COUNT(*) AS n FROM counts c ${w}`, ...args)).n;
    const items = await all(db,
      `SELECT c.id, c.number, c.type, c.scope, c.blind, c.status, c.note, c.created_at, c.started_at, c.counted_at, c.posted_at,
              cu.name AS created_by_name,
              (SELECT COUNT(*) FROM count_lines WHERE count_id = c.id) AS lines,
              (SELECT COUNT(*) FROM count_lines WHERE count_id = c.id AND counted_qty IS NOT NULL) AS counted_lines,
              (SELECT COUNT(DISTINCT location_id) FROM count_lines WHERE count_id = c.id) AS locations,
              (SELECT COUNT(*) FROM (SELECT location_id FROM count_lines WHERE count_id = c.id GROUP BY location_id
                 HAVING SUM(CASE WHEN counted_qty IS NULL THEN 1 ELSE 0 END) = 0)) AS done_locations,
              (SELECT COUNT(*) FROM count_lines WHERE count_id = c.id AND counted_qty IS NOT NULL
                 AND counted_qty <> CASE WHEN posted_at IS NOT NULL THEN counted_qty - COALESCE(posted_diff, 0) ELSE expected_qty END) AS diff_lines
       FROM counts c LEFT JOIN users cu ON cu.id = c.created_by ${w}
       ORDER BY CASE WHEN c.status IN ${ACTIVE_SQL} THEN 0 ELSE 1 END, c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`,
    ...args, limit, offset);
    for (const it of items) {
      it.blind = !!it.blind;
      // Differences reveal expected quantities: hidden from counters while a blind count is open.
      if (!seesExpected(ctx, it)) it.diff_lines = null;
    }
    return { items, total };
  }, { perm: ['counts', 'view'] });

  // Choices for the create dialog: zones with their location counts.
  r.get('/api/counts/options', async (ctx) => {
    const db = ctx.env.DB;
    const zones = await all(db,
      `SELECT zone, COUNT(*) AS locations, SUM(CASE WHEN kind = 'storage' THEN 1 ELSE 0 END) AS storage
       FROM locations WHERE active = 1 AND zone <> '' GROUP BY zone ORDER BY zone`);
    const storage = await first(db, "SELECT COUNT(*) AS n FROM locations WHERE active = 1 AND kind = 'storage'");
    const busy = await first(db,
      `SELECT COUNT(DISTINCT cl.location_id) AS n FROM count_lines cl JOIN counts c ON c.id = cl.count_id WHERE c.status IN ${ACTIVE_SQL}`);
    return { types: COUNT_TYPES, zones, storage_locations: storage.n, locations_in_open_counts: busy.n };
  }, { perm: ['counts', 'create'] });

  r.post('/api/counts', async (ctx) => createCount(ctx, await ctx.body()), { perm: ['counts', 'create'] });

  r.get('/api/counts/:id', async (ctx) => {
    const db = ctx.env.DB;
    const c = await loadCount(db, intId(ctx.params.id));
    const visible = seesExpected(ctx, c);
    const locations = await all(db,
      `SELECT l.id AS location_id, l.code, l.zone, l.kind, COUNT(cl.id) AS lines,
              SUM(CASE WHEN cl.counted_qty IS NOT NULL THEN 1 ELSE 0 END) AS counted,
              SUM(CASE WHEN cl.product_id IS NOT NULL THEN 1 ELSE 0 END) AS product_lines
       FROM count_lines cl JOIN locations l ON l.id = cl.location_id WHERE cl.count_id = ?
       GROUP BY l.id ORDER BY l.pick_sequence, l.code`, c.id);
    for (const l of locations) l.done = l.counted === l.lines;
    if (ctx.query.get('lines') !== '0') {
      const lines = await all(db, `${LINE_SQL} ${LINE_ORDER}`, c.id);
      const byLoc = new Map(locations.map((l) => [l.location_id, (l.items = [])]));
      for (const row of lines) byLoc.get(row.location_id).push(shapeLine(row, visible));
    }
    return {
      ...c, type_label: COUNT_TYPES[c.type] || c.type, can_see_expected: visible,
      progress: await progress(db, c.id), locations,
    };
  }, { perm: ['counts', 'view'] });

  r.get('/api/counts/:id/locations/:locationId', async (ctx) => {
    const c = await loadCount(ctx.env.DB, intId(ctx.params.id));
    return locationState(ctx, c, intId(ctx.params.locationId, 'A raktárhely'));
  }, { perm: ['counts', 'view'] });

  // Product candidates for a scanned code (exact EAN or SKU). Products of the partner whose goods
  // are in the location come first; same_partner false means another client's product.
  r.get('/api/counts/:id/resolve', async (ctx) => {
    const db = ctx.env.DB;
    const c = await loadCount(db, intId(ctx.params.id));
    const code = (ctx.query.get('code') || '').trim();
    if (!code) throw badRequest('Olvass be egy kódot.');
    const locationId = Number(ctx.query.get('location_id')) || null;
    let partnerId = null;
    if (locationId) {
      const occ = await first(db,
        `SELECT p.partner_id FROM count_lines cl JOIN products p ON p.id = cl.product_id
         WHERE cl.count_id = ? AND cl.location_id = ? AND (cl.expected_qty > 0 OR cl.counted_qty > 0) LIMIT 1`, c.id, locationId);
      const loc = await first(db, 'SELECT partner_id FROM locations WHERE id = ?', locationId);
      partnerId = occ ? occ.partner_id : loc ? loc.partner_id : null;
    }
    const products = await all(db,
      `SELECT p.id, p.partner_id, p.sku, p.name, p.ean, p.unit, p.track_lot, p.track_expiry, pa.code AS partner_code, pa.name AS partner_name
       FROM products p JOIN partners pa ON pa.id = p.partner_id
       WHERE (p.ean = ? AND p.ean <> '') OR p.sku = ? COLLATE NOCASE ORDER BY p.active DESC, p.sku LIMIT 20`, code, code);
    for (const p of products) p.same_partner = partnerId == null || p.partner_id === partnerId;
    products.sort((a, b) => Number(b.same_partner) - Number(a.same_partner));
    return { code, products };
  }, { perm: ['counts', 'edit'] });

  // Records a quantity on a line: { counted_qty } sets it (null: not counted), { add } adds to it.
  r.put('/api/counts/:id/lines/:lineId', async (ctx) => {
    const db = ctx.env.DB;
    const c = await loadCount(db, intId(ctx.params.id));
    assertEditable(c);
    const data = validate(await ctx.body(), ENTRY_FIELDS);
    if (data.add === undefined && !('counted_qty' in data)) throw badRequest('Add meg a mennyiséget.', { counted_qty: 'Kötelező mező.' });
    const line = await lineInCount(db, c, intId(ctx.params.lineId, 'A tétel'));
    if (line.product_id == null && ((data.add !== undefined && data.add > 0) || data.counted_qty > 0)) {
      throw badRequest('Ezen a helyen nincs nyilvántartott áru: a talált terméket vedd fel külön tételként.');
    }
    const at = nowIso();
    await batch(db, [
      entryStmt(db, line.id, data, userId(ctx), at),
      touchStatus(db, c.id, at),
      data.counted_qty === null ? reopenStatus(db, c.id, at) : null,
    ]);
    return locationState(ctx, c, line.location_id);
  }, { perm: ['counts', 'edit'] });

  // A product found on a location: adds to its line, or creates a new (unexpected) line.
  r.post('/api/counts/:id/lines', async (ctx) => {
    const db = ctx.env.DB;
    const c = await loadCount(db, intId(ctx.params.id));
    assertEditable(c);
    const body = await ctx.body();
    const d = validate(body, {
      location_id: { type: 'id', required: true },
      product_id: { type: 'id' },
      code: { type: 'str', max: 120 },
      lot: { type: 'str', max: 80, default: '' },
      expiry: { type: 'date', nullable: true },
      ...ENTRY_FIELDS,
    });
    const entry = d.add !== undefined ? { add: d.add } : d.counted_qty != null ? { counted_qty: d.counted_qty } : { add: 1 };
    if (entry.add !== undefined && entry.add < 1) throw badRequest('A mennyiség legalább 1 legyen.', { add: 'Legalább 1.' });
    const loc = await first(db,
      `SELECT l.id, l.code, MIN(cl.snapshot_mid) AS mid FROM count_lines cl JOIN locations l ON l.id = cl.location_id
       WHERE cl.count_id = ? AND cl.location_id = ? GROUP BY l.id`, c.id, d.location_id);
    if (!loc) throw badRequest('Ez a raktárhely nem része a leltárnak.', { location_id: 'Nem része a leltárnak.' });
    let product;
    if (d.product_id) product = await first(db, 'SELECT id, sku, name FROM products WHERE id = ?', d.product_id);
    else if (d.code) {
      const found = await all(db, `SELECT id, sku, name FROM products WHERE (ean = ? AND ean <> '') OR sku = ? COLLATE NOCASE LIMIT 3`, d.code, d.code);
      if (found.length > 1) throw conflict('Több termék is tartozik ehhez a kódhoz. Válaszd ki a listából.');
      product = found[0];
    }
    if (!product) throw badRequest('Ismeretlen termék.', { product_id: 'Válassz terméket.' });
    const lot = d.lot || '';
    const expiry = d.expiry || '';
    const at = nowIso();
    const existing = await first(db,
      'SELECT id, posted_at FROM count_lines WHERE count_id = ? AND location_id = ? AND product_id = ? AND lot = ? AND expiry = ?',
      c.id, loc.id, product.id, lot, expiry);
    if (existing) {
      if (existing.posted_at) throw conflict('Ez a tétel már könyvelve van, nem módosítható.');
      await batch(db, [entryStmt(db, existing.id, entry, userId(ctx), at), touchStatus(db, c.id, at)]);
    } else {
      const qty = entry.add !== undefined ? entry.add : entry.counted_qty;
      await batch(db, [
        stmt(db, `INSERT INTO count_lines (count_id, location_id, product_id, lot, expiry, expected_qty, counted_qty, counted_by, counted_at, snapshot_mid, added)
                  VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1)`, c.id, loc.id, product.id, lot, expiry, qty, userId(ctx), at, loc.mid || 0),
        touchStatus(db, c.id, at),
      ]);
      await audit(ctx, {
        module: 'counts', action: 'edit', entity: 'count', entityId: c.id,
        summary: `${c.number}: talált termék ${product.sku} a(z) ${loc.code} helyen (${qty} db)`,
      });
    }
    return locationState(ctx, c, loc.id);
  }, { perm: ['counts', 'edit'] });

  // Removes a found (unexpected) line recorded by mistake.
  r.delete('/api/counts/:id/lines/:lineId', async (ctx) => {
    const db = ctx.env.DB;
    const c = await loadCount(db, intId(ctx.params.id));
    assertEditable(c);
    const line = await lineInCount(db, c, intId(ctx.params.lineId, 'A tétel'));
    if (!line.added) throw conflict('Csak a számlálás közben felvett tétel törölhető. A nyilvántartott tételnél állítsd a mennyiséget 0-ra.');
    const at = nowIso();
    await batch(db, [
      stmt(db, 'DELETE FROM count_lines WHERE id = ? AND posted_at IS NULL', line.id),
      touchStatus(db, c.id, at),
    ]);
    const p = await first(db, 'SELECT sku FROM products WHERE id = ?', line.product_id);
    await audit(ctx, { module: 'counts', action: 'edit', entity: 'count', entityId: c.id, summary: `${c.number}: talált tétel törölve (${p ? p.sku : line.product_id})` });
    return locationState(ctx, c, line.location_id);
  }, { perm: ['counts', 'edit'] });

  // Location done: what was not counted there is not there (0).
  r.post('/api/counts/:id/locations/:locationId/complete', async (ctx) => {
    const db = ctx.env.DB;
    const c = await loadCount(db, intId(ctx.params.id));
    assertEditable(c);
    const locationId = intId(ctx.params.locationId, 'A raktárhely');
    const loc = await first(db,
      `SELECT l.code, SUM(CASE WHEN cl.counted_qty IS NULL AND cl.product_id IS NOT NULL THEN 1 ELSE 0 END) AS missing
       FROM count_lines cl JOIN locations l ON l.id = cl.location_id WHERE cl.count_id = ? AND cl.location_id = ? GROUP BY l.id`, c.id, locationId);
    if (!loc) throw badRequest('Ez a raktárhely nem része a leltárnak.');
    const at = nowIso();
    await batch(db, [
      stmt(db, `UPDATE count_lines SET counted_qty = 0, counted_by = ?, counted_at = ?
                WHERE count_id = ? AND location_id = ? AND counted_qty IS NULL AND posted_at IS NULL`, userId(ctx), at, c.id, locationId),
      touchStatus(db, c.id, at),
    ]);
    await audit(ctx, {
      module: 'counts', action: 'edit', entity: 'count', entityId: c.id,
      summary: `${c.number}: ${loc.code} hely számolva${loc.missing ? `, ${loc.missing} tétel nem volt meg (0)` : ''}`,
    });
    return locationState(ctx, c, locationId);
  }, { perm: ['counts', 'edit'] });

  // Recount a location: fresh snapshot of its stock, every count on it starts again.
  r.post('/api/counts/:id/locations/:locationId/recount', async (ctx) => {
    const db = ctx.env.DB;
    const c = await loadCount(db, intId(ctx.params.id));
    assertEditable(c);
    const locationId = intId(ctx.params.locationId, 'A raktárhely');
    const loc = await first(db,
      `SELECT l.code, SUM(CASE WHEN cl.posted_at IS NOT NULL THEN 1 ELSE 0 END) AS posted
       FROM count_lines cl JOIN locations l ON l.id = cl.location_id WHERE cl.count_id = ? AND cl.location_id = ? GROUP BY l.id`, c.id, locationId);
    if (!loc) throw badRequest('Ez a raktárhely nem része a leltárnak.');
    if (loc.posted) throw conflict(`A(z) ${loc.code} hely egy része már könyvelve van, nem számolható újra.`);
    const products = Array.isArray(c.filter.product_ids) && c.filter.product_ids.length ? c.filter.product_ids : null;
    const pf = products ? ` AND s.product_id IN (${marks(products.length)})` : '';
    const at = nowIso();
    await batch(db, [
      stmt(db, 'DELETE FROM count_lines WHERE count_id = ? AND location_id = ?', c.id, locationId),
      stmt(db, `INSERT INTO count_lines (count_id, location_id, product_id, lot, expiry, expected_qty, snapshot_mid)
                SELECT ?, s.location_id, s.product_id, s.lot, s.expiry, s.qty, ${MID} FROM stock s
                WHERE s.location_id = ? AND s.qty > 0${pf}`, c.id, locationId, ...(products || [])),
      stmt(db, `INSERT INTO count_lines (count_id, location_id, product_id, expected_qty, snapshot_mid)
                SELECT ?, ?, NULL, 0, ${MID} WHERE NOT EXISTS (SELECT 1 FROM count_lines WHERE count_id = ? AND location_id = ?)`,
      c.id, locationId, c.id, locationId),
      stmt(db, `UPDATE counts SET status = CASE WHEN status = 'open' THEN 'open' ELSE 'counting' END, counted_at = NULL, updated_at = ?
                WHERE id = ? AND status IN ${ACTIVE_SQL}`, at, c.id),
    ]);
    await audit(ctx, { module: 'counts', action: 'edit', entity: 'count', entityId: c.id, summary: `${c.number}: ${loc.code} hely újraszámolása` });
    return locationState(ctx, c, locationId);
  }, { perm: ['counts', 'edit'] });

  // The counters are done. Lines nobody counted stay uncounted and are not booked.
  r.post('/api/counts/:id/finish', async (ctx) => {
    const db = ctx.env.DB;
    const c = await loadCount(db, intId(ctx.params.id));
    assertEditable(c);
    const p = await progress(db, c.id);
    if (!p.counted_lines) throw conflict('Még egy tételt sem számoltatok.');
    const at = nowIso();
    await run(db, `UPDATE counts SET status = 'counted', counted_at = COALESCE(counted_at, ?), started_at = COALESCE(started_at, ?), updated_at = ?
                   WHERE id = ? AND status IN ${ACTIVE_SQL}`, at, at, at, c.id);
    const left = p.lines - p.counted_lines;
    await audit(ctx, {
      module: 'counts', action: 'edit', entity: 'count', entityId: c.id,
      summary: `${c.number} számlálás befejezve${left ? `, ${left} tétel nem számolt` : ''}`,
    });
    return { status: 'counted', progress: p };
  }, { perm: ['counts', 'edit'] });

  // Differences for the approver: expected, counted, current stock and whether stock moved.
  r.get('/api/counts/:id/review', async (ctx) => {
    const db = ctx.env.DB;
    const c = await loadCount(db, intId(ctx.params.id));
    const rows = await reviewLines(db, c);
    const lines = rows.map((l) => ({
      ...l, added: !!l.added, changed: !!l.changed, posted: !!l.posted_at,
      diff: l.counted_qty == null ? null : l.posted_at ? l.posted_diff : l.counted_qty - l.expected_qty,
    }));
    return {
      count: { ...c, type_label: COUNT_TYPES[c.type] || c.type, progress: await progress(db, c.id) },
      summary: summarize(rows),
      lines,
    };
  }, { perm: ['counts', 'approve'] });

  // Books the differences. Answers { done: false, remaining } while there is more to book (the
  // client calls again with the same body), then { done: true, summary }.
  r.post('/api/counts/:id/post', async (ctx) => {
    const c = await loadCount(ctx.env.DB, intId(ctx.params.id));
    return postCount(ctx, c, await ctx.body());
  }, { perm: ['counts', 'approve'] });

  // Cancel (counts delete): only before anything is booked.
  r.delete('/api/counts/:id', async (ctx) => {
    const db = ctx.env.DB;
    const c = await loadCount(db, intId(ctx.params.id));
    assertEditable(c);
    const posted = await first(db, 'SELECT COUNT(*) AS n FROM count_lines WHERE count_id = ? AND posted_at IS NOT NULL', c.id);
    if (posted.n) throw conflict('A leltár egy része már könyvelve van, ezért nem törölhető. Fejezd be a könyvelést.');
    const at = nowIso();
    const res = await run(db, `UPDATE counts SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ? AND status IN ${ACTIVE_SQL}`, at, at, c.id);
    if (res.meta.changes !== 1) throw conflict('A leltár állapota közben megváltozott. Töltsd újra az oldalt.');
    await audit(ctx, { module: 'counts', action: 'delete', entity: 'count', entityId: c.id, summary: `${c.number} leltár törölve` });
    return { ok: true };
  }, { perm: ['counts', 'delete'] });
}
