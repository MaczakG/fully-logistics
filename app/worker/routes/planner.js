// Fuvarszervezés: the trucks of the carriers that do egyedi fuvarok, and the day's plan: which open
// orders go on which truck, in what order. Prefix /api/transport
//
//   GET    /api/transport/trucks                 trucks with their carrier [transport view]
//   POST   /api/transport/trucks                 new truck [transport create]
//   PUT    /api/transport/trucks/:id             edit [transport edit]
//   DELETE /api/transport/trucks/:id             delete, only a truck that never had orders [transport delete]
//   GET    /api/transport/planner?date=          the day: open orders on no truck (or left behind on an earlier day), the trucks' loads, the depot [transport view]
//   PUT    /api/transport/planner                set trucks' loads for a day, take orders off [transport edit]
//   POST   /api/transport/planner/dispatch       a truck leaves: its packed orders of the day are shipped [transport approve]
//   POST   /api/transport/planner/geocode        map positions of a few addresses not known yet [transport view]
//
// Egyedi fuvar: an open order that does not come from a webshop and has no courier (no carrier, or a
// carrier without a courier code). Courier parcels go through Futárátadás (transport.js).

import { all, batch, first, getSetting, marks, run, stmt } from '../lib/db.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { setOrderStatus } from '../lib/orders.js';
import { budapestDate, isDate, nowIso } from '../lib/time.js';

const OPEN = ['new', 'hold', 'picking', 'packed'];
const WEBSHOP = ['shopify', 'woocommerce', 'shoprenter', 'unas'];
const EGYEDI = `o.source NOT IN (${WEBSHOP.map((s) => `'${s}'`).join(', ')}) AND (o.carrier_id IS NULL OR c.carrier_code = '')`;
const OPEN_IN = `status IN (${OPEN.map((s) => `'${s}'`).join(', ')})`;
const OPEN_SQL = `o.${OPEN_IN}`;
// The key of an address in geocodes, the same in SQL and in JS.
const KEY_SQL = "trim(o.country) || '|' || trim(o.zip) || '|' || trim(o.city) || '|' || trim(o.address)";
const addressKey = (a) => [a.country || 'HU', a.zip, a.city, a.address].map((s) => String(s || '').trim()).join('|');
const ORDER_SELECT = `
  SELECT o.id, o.number, o.status, o.priority, o.source, o.customer_name, o.company, o.country, o.zip, o.city, o.address, o.note,
         o.pallets, o.truck_id, o.truck_date, o.truck_seq, pa.code AS partner_code, pa.name AS partner_name,
         COALESCE(o.weight_kg, (SELECT SUM(ol.qty * COALESCE(p.weight_kg, 0)) FROM order_lines ol JOIN products p ON p.id = ol.product_id
                                WHERE ol.order_id = o.id), 0) AS kg,
         g.lat, g.lng
  FROM orders o JOIN partners pa ON pa.id = o.partner_id LEFT JOIN partners c ON c.id = o.carrier_id
  LEFT JOIN geocodes g ON g.address = ${KEY_SQL}`;

const TRUCK_FIELDS = {
  carrier_id: { type: 'id', required: true },
  plate: { type: 'str', required: true, max: 20 },
  name: { type: 'str', max: 120, default: '' },
  driver: { type: 'str', max: 120, default: '' },
  pallets: { type: 'int', min: 0, max: 99, default: 0 },
  max_kg: { type: 'num', min: 0, max: 60000, default: 0 },
  active: { type: 'bool', default: true },
};

async function truckCarrier(db, id) {
  const c = await first(db, "SELECT id, name, status, carrier_code FROM partners WHERE id = ? AND type = 'carrier'", id);
  if (!c) throw badRequest('Ismeretlen fuvarozó.', { carrier_id: 'Válassz fuvarozót.' });
  if (c.carrier_code) throw badRequest('Teherautó csak egyedi fuvarozóhoz vehető fel, futárszolgálathoz nem.', { carrier_id: 'Futárszolgálat.' });
  return c;
}

async function loadTruck(db, id) {
  const t = await first(db, 'SELECT t.*, p.name AS carrier_name FROM trucks t JOIN partners p ON p.id = t.carrier_id WHERE t.id = ?', id);
  if (!t) throw notFound('A teherautó nem található.');
  return t;
}

const idOf = (ctx) => {
  const n = Number(ctx.params.id);
  if (!Number.isInteger(n) || n < 1) throw notFound('A teherautó nem található.');
  return n;
};
const ids = (list, field) => {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.some((n) => !Number.isInteger(n) || n < 1)) throw badRequest('Hibás azonosítók.', { [field]: 'Azonosítók listáját várjuk.' });
  return list;
};

async function plannerDay(db, date) {
  const company = await getSetting(db, 'company', {});
  const depotAddress = { country: company.country, zip: company.zip, city: company.city, address: company.address };
  const depotGeo = company.city ? await first(db, 'SELECT lat, lng FROM geocodes WHERE address = ?', addressKey(depotAddress)) : null;
  return {
    date,
    depot: {
      name: company.name || 'Raktár',
      address: [[company.zip, company.city].filter(Boolean).join(' '), company.address].filter(Boolean).join(', '),
      lat: depotGeo ? depotGeo.lat : null, lng: depotGeo ? depotGeo.lng : null,
    },
    carriers: await all(db,
      `SELECT p.id, p.name, p.status FROM partners p WHERE p.type = 'carrier' AND p.carrier_code = ''
         AND (p.status = 'active' OR EXISTS (SELECT 1 FROM trucks t WHERE t.carrier_id = p.id)) ORDER BY p.name`),
    trucks: await all(db, 'SELECT t.id, t.carrier_id, t.plate, t.name, t.driver, t.pallets, t.max_kg, t.active FROM trucks t ORDER BY t.plate'),
    // on no truck, or planned for an earlier day and still here (that truck left without it)
    orders: await all(db, `${ORDER_SELECT} WHERE ${OPEN_SQL} AND ${EGYEDI} AND (o.truck_id IS NULL OR o.truck_date < ?)
                           ORDER BY CASE o.priority WHEN 'express' THEN 0 ELSE 1 END, o.created_at, o.id`, date),
    loads: await all(db, `${ORDER_SELECT} WHERE o.truck_date = ? AND o.truck_id IS NOT NULL ORDER BY o.truck_id, o.truck_seq, o.id`, date),
  };
}

const dateOf = (v) => {
  const d = v || budapestDate();
  if (!isDate(d)) throw badRequest('Hibás dátum.', { date: 'ÉÉÉÉ-HH-NN formában add meg.' });
  return d;
};

// One Nominatim lookup (OpenStreetMap): the street first, then only the town. null when nothing was found.
async function lookUp(url, a) {
  const tries = [{ street: a.address, city: a.city, postalcode: a.zip }, { city: a.city, postalcode: a.zip }];
  for (const t of tries) {
    const q = new URLSearchParams({ format: 'json', limit: '1', countrycodes: (a.country || 'HU').toLowerCase(), ...Object.fromEntries(Object.entries(t).filter(([, v]) => v)) });
    const res = await fetch(`${url}?${q}`, { headers: { 'user-agent': 'Fully-Logistics-WMS/1.0', accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const [hit] = await res.json();
    if (hit) return { lat: Number(hit.lat), lng: Number(hit.lon) };
    await new Promise((r) => setTimeout(r, 1100));
  }
  return null;
}

export function register(r) {
  // ------------------------------------------------------------ trucks
  r.get('/api/transport/trucks', async (ctx) => ({
    items: await all(ctx.env.DB,
      `SELECT t.*, p.name AS carrier_name,
              (SELECT COUNT(*) FROM orders o WHERE o.truck_id = t.id AND o.truck_date = ?) AS today_stops
       FROM trucks t JOIN partners p ON p.id = t.carrier_id ORDER BY p.name, t.plate`, budapestDate()),
  }), { perm: ['transport', 'view'] });

  r.post('/api/transport/trucks', async (ctx) => {
    const db = ctx.env.DB;
    const d = validate(await ctx.body(), TRUCK_FIELDS);
    const carrier = await truckCarrier(db, d.carrier_id);
    const plate = d.plate.trim().toUpperCase();
    if (await first(db, 'SELECT id FROM trucks WHERE plate = ?', plate)) throw conflict(`Már van ${plate} rendszámú teherautó.`, { plate: 'Foglalt rendszám.' });
    const res = await run(db, 'INSERT INTO trucks (carrier_id, plate, name, driver, pallets, max_kg, active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      carrier.id, plate, d.name.trim(), d.driver.trim(), d.pallets, d.max_kg, d.active ? 1 : 0);
    const id = res.meta.last_row_id;
    await audit(ctx, { module: 'transport', action: 'create', entity: 'truck', entityId: id, summary: `${plate} teherautó felvéve (${carrier.name})` });
    return loadTruck(db, id);
  }, { perm: ['transport', 'create'] });

  r.put('/api/transport/trucks/:id', async (ctx) => {
    const db = ctx.env.DB;
    const t = await loadTruck(db, idOf(ctx));
    const d = validate(await ctx.body(), TRUCK_FIELDS);
    const carrier = await truckCarrier(db, d.carrier_id);
    const plate = d.plate.trim().toUpperCase();
    if (await first(db, 'SELECT id FROM trucks WHERE plate = ? AND id <> ?', plate, t.id)) throw conflict(`Már van ${plate} rendszámú teherautó.`, { plate: 'Foglalt rendszám.' });
    await run(db, 'UPDATE trucks SET carrier_id = ?, plate = ?, name = ?, driver = ?, pallets = ?, max_kg = ?, active = ?, updated_at = ? WHERE id = ?',
      carrier.id, plate, d.name.trim(), d.driver.trim(), d.pallets, d.max_kg, d.active ? 1 : 0, nowIso(), t.id);
    await audit(ctx, { module: 'transport', action: 'edit', entity: 'truck', entityId: t.id, summary: `${plate} teherautó módosítva` });
    return loadTruck(db, t.id);
  }, { perm: ['transport', 'edit'] });

  r.delete('/api/transport/trucks/:id', async (ctx) => {
    const db = ctx.env.DB;
    const t = await loadTruck(db, idOf(ctx));
    if (await first(db, 'SELECT id FROM orders WHERE truck_id = ? LIMIT 1', t.id)) {
      throw conflict(`A(z) ${t.plate} teherautóval már volt rendelés, ezért nem törölhető. Állítsd szervizbe (nincs üzemben).`);
    }
    await run(db, 'DELETE FROM trucks WHERE id = ?', t.id);
    await audit(ctx, { module: 'transport', action: 'delete', entity: 'truck', entityId: t.id, summary: `${t.plate} teherautó törölve` });
    return { ok: true };
  }, { perm: ['transport', 'delete'] });

  // ------------------------------------------------------------ the day's plan
  r.get('/api/transport/planner', async (ctx) => plannerDay(ctx.env.DB, dateOf(ctx.query.get('date'))), { perm: ['transport', 'view'] });

  // loads: [{ truck_id, order_ids }] is each truck's whole load for the day in stop order (orders it
  // had and are not listed come off it); unassign: order ids taken off whatever truck they are on.
  r.put('/api/transport/planner', async (ctx) => {
    const db = ctx.env.DB;
    const body = await ctx.body();
    const date = dateOf(body.date);
    if (!Array.isArray(body.loads || [])) throw badRequest('Hibás terv.', { loads: 'Listát várunk.' });
    const loads = (body.loads || []).map((l) => ({ truck_id: ids([l && l.truck_id], 'loads')[0], order_ids: ids(l && l.order_ids, 'loads') }));
    const off = ids(body.unassign, 'unassign');
    const listed = [...loads.flatMap((l) => l.order_ids), ...off];
    if (new Set(listed).size !== listed.length) throw badRequest('Egy rendelés csak egyszer szerepelhet a tervben.');
    const orders = listed.length ? await all(db,
      `SELECT o.id, o.number, o.status, o.source, o.truck_id, o.truck_date, c.carrier_code FROM orders o LEFT JOIN partners c ON c.id = o.carrier_id
       WHERE o.id IN (${marks(listed.length)})`, ...listed) : [];
    const byId = new Map(orders.map((o) => [o.id, o]));
    for (const id of listed) {
      const o = byId.get(id);
      if (!o) throw notFound('A rendelés nem található.');
      if (!OPEN.includes(o.status)) throw conflict(`A(z) ${o.number} már elindult vagy lezárult, nem tervezhető át.`);
      if (WEBSHOP.includes(o.source) || o.carrier_code) throw conflict(`A(z) ${o.number} futáros (webshopos) rendelés, a Futárátadásban megy.`);
    }
    const trucks = new Map();
    for (const l of loads) {
      const t = await loadTruck(db, l.truck_id);
      if (!t.active && l.order_ids.some((id) => byId.get(id).truck_id !== t.id)) throw conflict(`A(z) ${t.plate} nincs üzemben, nem tervezhető rá.`);
      trucks.set(t.id, t);
    }
    const at = nowIso();
    const userId = ctx.user ? ctx.user.id : null;
    const event = (id, text) => stmt(db, "INSERT INTO order_events (order_id, at, type, text, user_id) VALUES (?, ?, 'transport', ?, ?)", id, at, text, userId);
    const statements = [];
    let planned = 0;
    let taken = 0;
    const takeOff = (o) => {
      statements.push(stmt(db, `UPDATE orders SET truck_id = NULL, truck_date = NULL, truck_seq = 0, updated_at = ? WHERE id = ? AND ${OPEN_IN}`, at, o.id));
      if (o.truck_id) { statements.push(event(o.id, 'Levéve a teherautóról')); taken++; }
    };
    for (const l of loads) {
      const t = trucks.get(l.truck_id);
      // what was on this truck that day and is open, and is not on any list now, comes off
      const before = await all(db, `SELECT id, truck_id FROM orders WHERE truck_id = ? AND truck_date = ? AND ${OPEN_IN}`, t.id, date);
      for (const o of before) if (!listed.includes(o.id)) takeOff(o);
      l.order_ids.forEach((id, i) => {
        const o = byId.get(id);
        statements.push(stmt(db, 'UPDATE orders SET truck_id = ?, truck_date = ?, truck_seq = ?, carrier_id = ?, updated_at = ? WHERE id = ?', t.id, date, i + 1, t.carrier_id, at, id));
        if (o.truck_id !== t.id || o.truck_date !== date) { statements.push(event(id, `Teherautóra tervezve: ${t.plate} (${t.carrier_name}), ${date}`)); planned++; }
      });
    }
    for (const id of off) takeOff(byId.get(id));
    if (statements.length) await batch(db, statements);
    if (planned || taken) await audit(ctx, { module: 'transport', action: 'edit', entity: 'plan', entityId: date, summary: `Fuvarterv ${date}: ${planned} rendelés teherautóra tervezve, ${taken} levéve` });
    return plannerDay(db, date);
  }, { perm: ['transport', 'edit'] });

  r.post('/api/transport/planner/dispatch', async (ctx) => {
    const db = ctx.env.DB;
    const body = await ctx.body();
    const date = dateOf(body.date);
    const t = await loadTruck(db, ids([body.truck_id], 'truck_id')[0]);
    const orders = await all(db, `SELECT id, number, status FROM orders o WHERE truck_id = ? AND truck_date = ? AND ${OPEN_SQL} ORDER BY truck_seq`, t.id, date);
    const ready = orders.filter((o) => o.status === 'packed');
    if (!ready.length) throw conflict(`A(z) ${t.plate} teherautón nincs feladásra kész rendelés ${date} napra.`);
    for (const o of ready) await setOrderStatus(ctx, o.id, 'shipped', `Feladva: ${t.plate} teherautóval (${t.carrier_name}), ${date}`);
    const left = orders.filter((o) => o.status !== 'packed').map((o) => o.number);
    await audit(ctx, { module: 'transport', action: 'approve', entity: 'truck', entityId: t.id, summary: `${t.plate} járata elindult ${date}: ${ready.length} rendelés feladva` });
    return { shipped: ready.length, not_ready: left };
  }, { perm: ['transport', 'approve'] });

  // A few at a time (Nominatim allows one lookup a second); the planner calls it again while some are left.
  r.post('/api/transport/planner/geocode', async (ctx) => {
    const db = ctx.env.DB;
    const url = ctx.env.GEOCODER_URL ?? 'https://nominatim.openstreetmap.org/search';
    if (!url) return { done: 0, left: 0, disabled: true };
    const company = await getSetting(db, 'company', {});
    const rows = await all(db,
      `SELECT DISTINCT o.country, o.zip, o.city, o.address FROM orders o LEFT JOIN partners c ON c.id = o.carrier_id
       WHERE ((${OPEN_SQL} AND ${EGYEDI}) OR o.truck_date >= ?) AND o.city <> ''
         AND NOT EXISTS (SELECT 1 FROM geocodes g WHERE g.address = ${KEY_SQL})`, budapestDate());
    const missing = rows.filter((a, i) => rows.findIndex((b) => addressKey(b) === addressKey(a)) === i);
    if (company.city && !(await first(db, 'SELECT address FROM geocodes WHERE address = ?', addressKey(company)))) missing.unshift(company);
    let done = 0;
    for (const a of missing.slice(0, 6)) {
      let pos;
      try {
        pos = await lookUp(url, a);
      } catch (err) {
        return { done, left: missing.length - done, error: `A címkeresés nem érhető el: ${err.message}` };
      }
      await run(db, 'INSERT OR REPLACE INTO geocodes (address, lat, lng, at) VALUES (?, ?, ?, ?)', addressKey(a), pos ? pos.lat : null, pos ? pos.lng : null, nowIso());
      done++;
      await new Promise((res) => setTimeout(res, 1100));
    }
    return { done, left: missing.length - done };
  }, { perm: ['transport', 'view'] });
}
