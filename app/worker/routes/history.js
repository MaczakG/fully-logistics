// Rendeléstörténet: shipped, delivered, returned and cancelled orders, export, returns. Prefix /api/history
//
//   GET  /api/history                       list with filters and KPIs [history view]
//   GET  /api/history/export                CSV export of the same filters [history view]
//   GET  /api/history/:id/returns           returns of one order [history view]
//   GET  /api/history/:id/return-options    returnable lines and target locations for the dialog [history view]
//   POST /api/history/:id/delivered         mark delivered [history edit]
//   POST /api/history/:id/notes             timeline note [history edit]
//   POST /api/history/:id/returns           record a return (VR), goods back into stock [history create]
//   POST /api/history/returns/:rid/photos   photo of a return, multipart "file" [history create]
//
// Order details come from GET /api/orders/:id, which history view may read as well.
//
// Returns: sellable goods go to the chosen storage location or the returns zone, damaged goods to
// the quarantine zone (counted as on hand but blocked). Every line books an addStock "return".

import { all, batch, first, marks, nextNumber, stmt } from '../lib/db.js';
import { badRequest, conflict, download, notFound, page } from '../lib/http.js';
import { validate, validateList } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { addOrderEvent, setOrderStatus } from '../lib/orders.js';
import { addStock, assertCanStore, location as loadLocation, locationByCode, suggestLocation } from '../lib/stock.js';
import { readUpload, storeFile } from '../lib/files.js';
import { toCsv } from '../lib/csv.js';
import { CARRIERS, STATUSES } from '../lib/constants.js';
import { addDays, budapestDate, budapestTime, isDate, nowIso } from '../lib/time.js';
import { allIn, budapestDayStartIso, idParam } from './picking.js';
import { likeArg } from './orders.js';

const CLOSED = ['shipped', 'delivered', 'returned', 'cancelled'];
const RETURNABLE = ['shipped', 'delivered', 'returned'];
const label = (s) => (STATUSES.order[s] ? STATUSES.order[s].label : s);
const PHOTO_TYPES = /^image\/(jpeg|png|webp|heic|heif|gif)$/;
const PHOTO_EXT = /\.(jpe?g|png|webp|heic|heif|gif)$/i;

// Filters shared by the list and the export.
function filters(query) {
  const status = query.get('status') || '';
  if (status && !CLOSED.includes(status)) throw badRequest('Ismeretlen állapot.');
  const dateField = query.get('date_field') || 'shipped';
  if (!['shipped', 'created'].includes(dateField)) throw badRequest('Ismeretlen dátummező.');
  const from = query.get('from') || '';
  const to = query.get('to') || '';
  if ((from && !isDate(from)) || (to && !isDate(to))) throw badRequest('A dátumot ÉÉÉÉ-HH-NN formában add meg.');
  if (from && to && from > to) throw badRequest('A kezdő dátum nem lehet későbbi a záró dátumnál.');
  const num = (k) => {
    const v = query.get(k);
    if (!v) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw badRequest('Érvénytelen szűrő.');
    return n;
  };
  const partnerId = num('partner_id');
  const carrierId = num('carrier_id');
  const text = (query.get('q') || '').trim().slice(0, 100);

  const where = [];
  const args = [];
  if (partnerId) { where.push('o.partner_id = ?'); args.push(partnerId); }
  if (carrierId) { where.push('o.carrier_id = ?'); args.push(carrierId); }
  if (from || to) {
    if (dateField === 'shipped') {
      if (from) { where.push('o.shipped_date >= ?'); args.push(from); }
      if (to) { where.push('o.shipped_date <= ?'); args.push(to); }
    } else {
      if (from) { where.push('o.created_at >= ?'); args.push(budapestDayStartIso(from)); }
      if (to) { where.push('o.created_at < ?'); args.push(budapestDayStartIso(addDays(to, 1))); }
    }
  }
  if (text) {
    const l = likeArg(text);
    where.push(`(o.number LIKE ? ESCAPE '\\' OR o.external_number LIKE ? ESCAPE '\\' OR o.customer_name LIKE ? ESCAPE '\\'
                 OR o.company LIKE ? ESCAPE '\\' OR o.city LIKE ? ESCAPE '\\' OR o.email LIKE ? ESCAPE '\\' OR o.tracking_number LIKE ? ESCAPE '\\')`);
    args.push(l, l, l, l, l, l, l);
  }
  return { status, where, args };
}

const SELECT = `
  SELECT o.id, o.number, o.external_number, o.source, o.status, o.priority, o.customer_name, o.company, o.email, o.phone,
         o.country, o.zip, o.city, o.address, o.pickup_point_id, o.tracking_number, o.package_count, o.weight_kg,
         o.cod_amount, o.currency, o.created_at, o.packed_at, o.shipped_at, o.shipped_date, o.delivered_at, o.cancelled_at,
         pa.id AS partner_id, pa.code AS partner_code, pa.name AS partner_name, c.name AS carrier_name, c.carrier_code,
         (SELECT COALESCE(SUM(qty), 0) FROM order_lines WHERE order_id = o.id) AS item_count,
         (SELECT COUNT(*) FROM returns WHERE order_id = o.id) AS return_count
  FROM orders o JOIN partners pa ON pa.id = o.partner_id LEFT JOIN partners c ON c.id = o.carrier_id`;
const ORDER = 'ORDER BY COALESCE(o.shipped_at, o.cancelled_at, o.updated_at) DESC, o.id DESC';

async function loadOrder(db, id) {
  const o = await first(db, 'SELECT * FROM orders WHERE id = ?', id);
  if (!o) throw notFound('A rendelés nem található.');
  return o;
}

async function returnedByProduct(db, orderId) {
  const rows = await all(db,
    'SELECT rl.product_id, SUM(rl.qty) AS qty FROM return_lines rl JOIN returns r ON r.id = rl.return_id WHERE r.order_id = ? GROUP BY rl.product_id', orderId);
  return new Map(rows.map((r) => [r.product_id, r.qty]));
}

const zones = (db, kind) => all(db, 'SELECT id, code FROM locations WHERE kind = ? AND active = 1 ORDER BY pick_sequence, code', kind);

async function returnsOf(db, orderId) {
  const returns = await all(db,
    `SELECT r.id, r.number, r.received_at, r.received_date, r.reason, r.note, u.name AS created_by_name
     FROM returns r LEFT JOIN users u ON u.id = r.created_by WHERE r.order_id = ? ORDER BY r.id`, orderId);
  if (!returns.length) return [];
  const ids = returns.map((r) => r.id);
  const lines = await allIn(db,
    `SELECT rl.id, rl.return_id, rl.product_id, rl.qty, rl.condition, p.sku, p.name, l.code AS location_code
     FROM return_lines rl JOIN products p ON p.id = rl.product_id LEFT JOIN locations l ON l.id = rl.location_id
     WHERE rl.return_id IN (?) ORDER BY rl.id`, ids);
  const photos = await allIn(db,
    'SELECT rp.return_id, d.id, d.filename, d.content_type FROM return_photos rp JOIN documents d ON d.id = rp.document_id WHERE rp.return_id IN (?) ORDER BY d.id', ids);
  return returns.map((r) => ({
    ...r,
    lines: lines.filter((l) => l.return_id === r.id),
    photos: photos.filter((p) => p.return_id === r.id).map((p) => ({ id: p.id, filename: p.filename, content_type: p.content_type })),
  }));
}

// Resolves where one return line goes. Sellable: the given storage or returns location, else the
// first returns zone. Damaged: the given quarantine location, else the first quarantine zone.
async function targetLocation(db, line, defaults) {
  let loc = null;
  if (line.location_id) loc = await first(db, 'SELECT * FROM locations WHERE id = ?', line.location_id);
  else if (line.location_code) loc = await locationByCode(db, line.location_code);
  if ((line.location_id || line.location_code) && !loc) return { error: `Ismeretlen raktárhely: ${line.location_code || line.location_id}.` };
  if (loc) {
    if (!loc.active) return { error: `A(z) ${loc.code} raktárhely inaktív.` };
    if (line.condition === 'damaged' && loc.kind !== 'quarantine') return { error: 'Sérült áru csak karantén helyre kerülhet.' };
    if (line.condition === 'sellable' && !['storage', 'returns'].includes(loc.kind)) return { error: 'Értékesíthető áru tárolóhelyre vagy a visszáru zónába kerülhet.' };
    return { loc };
  }
  const def = line.condition === 'damaged' ? defaults.quarantine : defaults.returns;
  if (!def) {
    return { error: line.condition === 'damaged'
      ? 'Nincs aktív karantén raktárhely. Vegyél fel egyet a Beállítások > Raktárhelyek alatt.'
      : 'Nincs aktív visszáru zóna. Válassz raktárhelyet, vagy vegyél fel visszáru zónát a Beállításokban.' };
  }
  return { loc: await loadLocation(db, def.id) };
}

async function recordReturn(ctx, orderId, body) {
  const db = ctx.env.DB;
  const data = validate(body, {
    reason: { type: 'str', max: 300, default: '' },
    note: { type: 'text', max: 2000, default: '' },
  });
  const lines = validateList(body.lines, {
    product_id: { type: 'id', required: true },
    qty: { type: 'int', required: true, min: 1, max: 100000 },
    condition: { type: 'enum', values: ['sellable', 'damaged'], required: true },
    location_id: { type: 'id', nullable: true },
    location_code: { type: 'str', max: 60, default: '' },
  }, { max: 200 });
  const o = await loadOrder(db, orderId);
  if (!RETURNABLE.includes(o.status)) {
    throw conflict(`Visszárut csak feladott vagy kézbesített rendeléshez rögzíthetsz. A(z) ${o.number} állapota: ${label(o.status)}.`);
  }
  const ordered = new Map((await all(db,
    'SELECT ol.product_id, SUM(ol.qty) AS qty, p.sku, p.unit FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ? GROUP BY ol.product_id', orderId))
    .map((r) => [r.product_id, r]));
  const returned = await returnedByProduct(db, orderId);
  const defaults = { returns: (await zones(db, 'returns'))[0] || null, quarantine: (await zones(db, 'quarantine'))[0] || null };

  const errors = {};
  const used = new Map();
  const resolved = [];
  for (const [i, l] of lines.entries()) {
    const ord = ordered.get(l.product_id);
    if (!ord) { errors[`lines.${i}.product_id`] = 'Ez a termék nem szerepel a rendelésben.'; continue; }
    const sofar = (returned.get(l.product_id) || 0) + (used.get(l.product_id) || 0);
    if (sofar + l.qty > ord.qty) {
      const left = Math.max(ord.qty - sofar, 0);
      errors[`lines.${i}.qty`] = left ? `Legfeljebb ${left} ${ord.unit} küldhető vissza (rendelve ${ord.qty}).` : `A(z) ${ord.sku} tételből már mindent visszaküldtek.`;
      continue;
    }
    used.set(l.product_id, (used.get(l.product_id) || 0) + l.qty);
    const t = await targetLocation(db, l, defaults);
    if (t.error) { errors[`lines.${i}.location_id`] = t.error; continue; }
    try {
      await assertCanStore(db, t.loc.id, o.partner_id);
    } catch (err) {
      if (err.status !== 409) throw err;
      errors[`lines.${i}.location_id`] = err.message;
      continue;
    }
    resolved.push({ ...l, loc: t.loc, sku: ord.sku, unit: ord.unit });
  }
  if (Object.keys(errors).length) throw badRequest('Ellenőrizd a visszáru tételeit.', errors);

  const number = await nextNumber(db, 'VR');
  const at = nowIso();
  const ref = '(SELECT id FROM returns WHERE number = ?)';
  await batch(db, [
    stmt(db, 'INSERT INTO returns (number, order_id, partner_id, received_at, received_date, reason, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      number, orderId, o.partner_id, at, budapestDate(), data.reason, data.note, ctx.user ? ctx.user.id : null),
    ...resolved.map((l) => stmt(db, `INSERT INTO return_lines (return_id, product_id, qty, condition, location_id) VALUES (${ref}, ?, ?, ?, ?)`,
      number, l.product_id, l.qty, l.condition, l.loc.id)),
  ]);
  const ret = await first(db, 'SELECT id FROM returns WHERE number = ?', number);
  for (const l of resolved) {
    await addStock(ctx, {
      productId: l.product_id, locationId: l.loc.id, qty: l.qty, type: 'return', refType: 'return', refId: ret.id,
      note: `${number} (${o.number}${l.condition === 'damaged' ? ', sérült' : ''})`,
    });
  }
  const pieces = resolved.reduce((s, l) => s + l.qty, 0);
  const damaged = resolved.filter((l) => l.condition === 'damaged').reduce((s, l) => s + l.qty, 0);
  const text = `Visszáru rögzítve: ${number}, ${pieces} db${damaged ? ` (ebből sérült ${damaged})` : ''}: ${resolved
    .map((l) => `${l.sku} ${l.qty} ${l.unit} (${l.loc.code})`).join(', ')}${data.reason ? `. Ok: ${data.reason}` : ''}`;
  if (o.status !== 'returned') await setOrderStatus(ctx, orderId, 'returned', text);
  else await addOrderEvent(ctx, orderId, 'return', text);
  await audit(ctx, {
    module: 'history', action: 'create', entity: 'return', entityId: ret.id,
    summary: `${number} rögzítve (${o.number}, ${pieces} db)`,
    details: { order: o.number, lines: resolved.map((l) => ({ sku: l.sku, qty: l.qty, condition: l.condition, location: l.loc.code })) },
  });
  return { id: ret.id, number, pieces };
}

export function register(r) {
  r.get('/api/history', async (ctx) => {
    const db = ctx.env.DB;
    const { status, where, args } = filters(ctx.query);
    const { limit, offset } = page(ctx.query, 50, 500);
    const statuses = status ? [status] : CLOSED;
    const w = [`o.status IN (${marks(statuses.length)})`, ...where].join(' AND ');
    const total = (await first(db, `SELECT COUNT(*) AS n FROM orders o WHERE ${w}`, ...statuses, ...args)).n;
    const items = await all(db, `${SELECT} WHERE ${w} ${ORDER} LIMIT ? OFFSET ?`, ...statuses, ...args, limit, offset);
    // KPIs: the same filters without the status.
    const kw = [`o.status IN (${marks(CLOSED.length)})`, ...where].join(' AND ');
    const counts = await all(db, `SELECT o.status, COUNT(*) AS n FROM orders o WHERE ${kw} GROUP BY o.status`, ...CLOSED, ...args);
    const kpis = Object.fromEntries(CLOSED.map((s) => [s, 0]));
    for (const c of counts) kpis[c.status] = c.n;
    return { items, total, kpis };
  }, { perm: ['history', 'view'] });

  r.get('/api/history/export', async (ctx) => {
    const db = ctx.env.DB;
    const { status, where, args } = filters(ctx.query);
    const statuses = status ? [status] : CLOSED;
    const w = [`o.status IN (${marks(statuses.length)})`, ...where].join(' AND ');
    const rows = await all(db, `${SELECT} WHERE ${w} ${ORDER} LIMIT 50000`, ...statuses, ...args);
    const dt = (v) => (v ? `${budapestDate(new Date(v))} ${budapestTime(new Date(v))}` : '');
    const csv = toCsv([
      { key: 'number', label: 'Rendelésszám' },
      { key: 'external_number', label: 'Külső rendelésszám' },
      { key: 'partner_code', label: 'Ügyfélkód' },
      { key: 'partner_name', label: 'Ügyfél' },
      { label: 'Állapot', value: (x) => label(x.status) },
      { key: 'customer_name', label: 'Vevő' },
      { key: 'company', label: 'Cég' },
      { key: 'email', label: 'E-mail' },
      { key: 'phone', label: 'Telefon' },
      { key: 'country', label: 'Ország' },
      { key: 'zip', label: 'Irányítószám' },
      { key: 'city', label: 'Város' },
      { key: 'address', label: 'Cím' },
      { key: 'pickup_point_id', label: 'Átvételi pont' },
      { label: 'Fuvarozó', value: (x) => x.carrier_name || (x.carrier_code ? CARRIERS[x.carrier_code] : '') || '' },
      { key: 'tracking_number', label: 'Nyomkövetési szám' },
      { key: 'package_count', label: 'Csomagok' },
      { label: 'Súly (kg)', value: (x) => (x.weight_kg == null ? '' : String(x.weight_kg).replace('.', ',')) },
      { key: 'item_count', label: 'Darab' },
      { label: 'Utánvét', value: (x) => (x.cod_amount ? String(x.cod_amount).replace('.', ',') : '') },
      { label: 'Létrehozva', value: (x) => dt(x.created_at) },
      { key: 'shipped_date', label: 'Feladás napja' },
      { label: 'Kézbesítve', value: (x) => dt(x.delivered_at) },
      { label: 'Sztornózva', value: (x) => dt(x.cancelled_at) },
      { key: 'return_count', label: 'Visszáruk' },
    ], rows);
    await audit(ctx, { module: 'history', action: 'view', entity: 'export', summary: `Rendeléstörténet export: ${rows.length} sor` });
    return download(csv, `rendelestortenet-${budapestDate()}.csv`, 'text/csv; charset=utf-8');
  }, { perm: ['history', 'view'] });

  r.get('/api/history/:id/returns', async (ctx) => {
    const id = idParam(ctx);
    await loadOrder(ctx.env.DB, id);
    return { items: await returnsOf(ctx.env.DB, id) };
  }, { perm: ['history', 'view'] });

  r.get('/api/history/:id/return-options', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const o = await loadOrder(db, id);
    const returned = await returnedByProduct(db, id);
    const lines = await all(db,
      `SELECT ol.product_id, SUM(ol.qty) AS qty, p.sku, p.name, p.ean, p.unit FROM order_lines ol JOIN products p ON p.id = ol.product_id
       WHERE ol.order_id = ? GROUP BY ol.product_id ORDER BY MIN(ol.id)`, id);
    for (const l of lines) {
      l.returned = returned.get(l.product_id) || 0;
      l.returnable = Math.max(l.qty - l.returned, 0);
      const s = await suggestLocation(db, l.product_id);
      l.suggested_location = s ? { id: s.id, code: s.code } : null;
    }
    return {
      order: { id: o.id, number: o.number, status: o.status, partner_id: o.partner_id },
      can_return: RETURNABLE.includes(o.status),
      lines,
      returns_zones: await zones(db, 'returns'),
      quarantine_zones: await zones(db, 'quarantine'),
    };
  }, { perm: ['history', 'view'] });

  r.post('/api/history/:id/delivered', async (ctx) => {
    const id = idParam(ctx);
    const o = await loadOrder(ctx.env.DB, id);
    if (o.status !== 'shipped') throw conflict(`Csak feladott rendelés jelölhető kézbesítettnek. A(z) ${o.number} állapota: ${label(o.status)}.`);
    const { note } = validate(await ctx.body(), { note: { type: 'str', max: 300, default: '' } });
    await setOrderStatus(ctx, id, 'delivered', `Kézbesítve${note ? `: ${note}` : ''}`);
    await audit(ctx, { module: 'history', action: 'edit', entity: 'order', entityId: id, summary: `${o.number} kézbesítettnek jelölve` });
    return { ok: true };
  }, { perm: ['history', 'edit'] });

  r.post('/api/history/:id/notes', async (ctx) => {
    const id = idParam(ctx);
    const { text } = validate(await ctx.body(), { text: { type: 'text', required: true, max: 2000 } });
    if (!text.trim()) throw badRequest('Írd be a megjegyzést.', { text: 'Kötelező mező.' });
    const o = await loadOrder(ctx.env.DB, id);
    await addOrderEvent(ctx, id, 'note', text.trim());
    await audit(ctx, { module: 'history', action: 'edit', entity: 'order', entityId: id, summary: `${o.number}: megjegyzés hozzáadva` });
    return { ok: true };
  }, { perm: ['history', 'edit'] });

  r.post('/api/history/:id/returns', async (ctx) => recordReturn(ctx, idParam(ctx), await ctx.body()), { perm: ['history', 'create'] });

  r.post('/api/history/returns/:rid/photos', async (ctx) => {
    const db = ctx.env.DB;
    const rid = idParam(ctx, 'rid');
    const ret = await first(db, 'SELECT r.id, r.number, r.partner_id, r.order_id FROM returns r WHERE r.id = ?', rid);
    if (!ret) throw notFound('A visszáru nem található.');
    const count = await first(db, 'SELECT COUNT(*) AS n FROM return_photos WHERE return_id = ?', rid);
    if (count.n >= 20) throw conflict('Egy visszáruhoz legfeljebb 20 fotó tölthető fel.');
    const { file } = await readUpload(ctx);
    const name = file.name || 'foto.jpg';
    let type = (file.type || '').toLowerCase();
    if (!PHOTO_TYPES.test(type)) {
      if (!PHOTO_EXT.test(name)) throw badRequest('Csak képfájl tölthető fel (JPG, PNG, WEBP, HEIC).', { file: 'Képfájlt válassz.' });
      const ext = name.split('.').pop().toLowerCase();
      type = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
    }
    const docId = await storeFile(ctx, { partnerId: ret.partner_id, kind: 'photo', filename: name, contentType: type, body: await file.arrayBuffer() });
    await batch(db, [stmt(db, 'INSERT INTO return_photos (return_id, document_id) VALUES (?, ?)', rid, docId)]);
    await audit(ctx, { module: 'history', action: 'create', entity: 'return', entityId: rid, summary: `${ret.number}: fotó feltöltve (${name})` });
    return { id: docId, filename: name };
  }, { perm: ['history', 'create'] });
}
