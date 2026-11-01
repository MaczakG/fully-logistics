// Courier integrations (GLS, DPD, Foxpost, MPL, DHL): labels and tracking.
//
// Contract used by the rest of the app (do not change the signatures without updating callers):
//   listCouriers()                         -> [{ code, name, credentialFields, settingFields, features }]
//        field: { key, label, type: text|password|select|number|checkbox, required, options, help, default }
//        The Beállítások screen renders these and saves them with saveCourierAccount().
//   isConfigured(env, carrierCode)          -> Promise<boolean>  account saved, active, required fields filled
//   createLabel(ctx, orderId, { packages }) -> Promise<{ trackingNumber, documentId, parcelNumbers, carrierCode, trackingUrl, warnings }>
//        packages: [{ weight_kg, length_cm, width_cm, height_cm, size }] (all optional; without it
//        the order's package_count and weight, or the products' weight, are used).
//        Books the shipment with the carrier of the order (partners.carrier_code of orders.carrier_id),
//        stores the label PDF in R2 (documents, kind "label"), writes orders.tracking_number (first
//        parcel number), label_document_id, package_count, weight_kg and an order event with every
//        parcel number. Throws HttpError with a Hungarian message on failure (409 configuration or
//        carrier unavailable, 400 order data or the carrier refused it), so the packing screen can
//        fall back to a manual tracking number. The error is also saved as the account's last_error.
//   trackingUrl(carrierCode, trackingNumber) -> string ('' if unknown)  public tracking page for customers
//   testConnection(env, carrierCode)        -> Promise<{ ok, message }>  cheap authenticated call
//   syncDeliveries(env)                     -> Promise<{ [carrierCode]: { checked, delivered, error } }>
//        For orders shipped in the last 14 days with a tracking number, asks the carrier's tracking
//        API and moves delivered orders to "delivered" (setOrderStatus, system user). GLS, Foxpost
//        and DHL answer at once; MPL tracking is asynchronous (the first run submits, a later run
//        at least a minute after collects the report); DPD has no tracking API (see dpd.js).
//        Meant for an hourly cron; wiring it into worker/cron.js is up to the owner of that file.
//   closeShipments(ctx, carrierCode, { trackingNumbers }) -> Promise<{ required, documentIds, closed }>
//        Daily closing where the carrier needs it (MPL: mandatory "zárás", returns the manifest PDFs,
//        stored as documents of kind "manifest"). Other carriers answer { required: false }.
//
// Order fields used: customer_name, company, email, phone, country, zip, city, address,
// pickup_point_id (parcel locker or pickup point), cod_amount and currency, carrier_service (per
// order service: GLS extra service codes like "T12", DPD main service code, MPL delivery mode
// HA/PM/PP/CS or basic service, DHL product code), package_count, weight_kg.
// Sender: account settings sender_* override the company settings (settings "company").
//
// Adapters (one file per carrier) export: code, name, credentialFields, settingFields,
// requiredCredentials, requiredSettings, features, trackingUrl(n), validate(shipment, account),
// createShipment(shipment, account, http), testConnection(account, http) and optionally
// trackDelivered(numbers, account, http, state) and closeShipments(account, http, opts).
// They use only common.js, so they can be unit tested in plain Node with a fake fetch.
//
// Tests: the hidden account setting api_base_url (accepted only for http://127.0.0.1 or
// http://localhost, see common.baseUrl) points an adapter at a fake carrier server.

import { all, first, getSetting, run } from '../../lib/db.js';
import { badRequest, conflict, notFound } from '../../lib/http.js';
import { getCourierAccount, setCourierError } from '../../lib/accounts.js';
import { storeFile } from '../../lib/files.js';
import { addOrderEvent, setOrderStatus } from '../../lib/orders.js';
import { audit, integrationLog } from '../../lib/audit.js';
import { STATUSES } from '../../lib/constants.js';
import { nowIso } from '../../lib/time.js';
import { CourierError, budapestDay, isPdf, isTestMode, makeHttp, normalizePhone, round, splitStreet } from './common.js';
import * as gls from './gls.js';
import * as dpd from './dpd.js';
import * as foxpost from './foxpost.js';
import * as mpl from './mpl.js';
import * as dhl from './dhl.js';

const ADAPTERS = { gls, dpd, foxpost, mpl, dhl };
const WHO = { gls: 'a GLS', dpd: 'a DPD', foxpost: 'a Foxpost', mpl: 'az MPL', dhl: 'a DHL' };
const LABEL_STATUSES = ['new', 'picking', 'packed'];
const DEFAULT_WEIGHT_KG = 1;
const LOCK_MS = 2 * 60 * 1000;

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export const listCouriers = () => Object.values(ADAPTERS).map((a) => ({
  code: a.code,
  name: a.name,
  credentialFields: a.credentialFields,
  settingFields: a.settingFields,
  features: a.features,
}));

const fieldLabel = (fields, key) => (fields.find((f) => f.key === key) || { label: key }).label;

function missingFields(adapter, account) {
  const blank = (v) => v === undefined || v === null || String(v).trim() === '';
  return [
    ...adapter.requiredCredentials.filter((k) => blank(account.credentials[k])).map((k) => fieldLabel(adapter.credentialFields, k)),
    ...adapter.requiredSettings.filter((k) => blank(account.settings[k])).map((k) => fieldLabel(adapter.settingFields, k)),
  ];
}

export async function isConfigured(env, carrierCode) {
  const adapter = ADAPTERS[carrierCode];
  if (!adapter) return false;
  const account = await getCourierAccount(env, carrierCode);
  return !!account && account.active && missingFields(adapter, account).length === 0;
}

export function trackingUrl(carrierCode, trackingNumber) {
  const adapter = ADAPTERS[carrierCode];
  const n = String(trackingNumber || '').trim();
  return adapter && n ? adapter.trackingUrl(n) : '';
}

// ---------------------------------------------------------------- shipment from an order

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

async function productWeight(env, orderId) {
  const row = await first(env.DB,
    'SELECT COALESCE(SUM(ol.qty * COALESCE(p.weight_kg, 0)), 0) AS w FROM order_lines ol JOIN products p ON p.id = ol.product_id WHERE ol.order_id = ?',
    orderId);
  return row ? Number(row.w) || 0 : 0;
}

export async function normalizePackages(env, order, packages) {
  if (packages !== undefined && packages !== null && !Array.isArray(packages)) throw badRequest('A csomagok listáját tömbként add meg.');
  const given = packages || [];
  if (given.length > 99) throw badRequest('Legfeljebb 99 csomag adható meg.');
  const errors = {};
  let list = given.map((p, i) => {
    const item = p || {};
    const weightKg = num(item.weight_kg ?? item.weightKg ?? item.weight);
    const dims = [item.length_cm ?? item.lengthCm, item.width_cm ?? item.widthCm, item.height_cm ?? item.heightCm].map(num);
    if (weightKg !== null && !(weightKg > 0 && weightKg <= 1000)) errors[`packages.${i}.weight_kg`] = 'A súlyt 0 és 1000 kg között add meg.';
    dims.forEach((d, j) => {
      if (d !== null && !(d > 0 && d <= 400)) errors[`packages.${i}.${['length_cm', 'width_cm', 'height_cm'][j]}`] = 'A méretet 0 és 400 cm között add meg.';
    });
    return { weightKg, lengthCm: dims[0], widthCm: dims[1], heightCm: dims[2], size: item.size ? String(item.size).trim() : '' };
  });
  if (Object.keys(errors).length) throw badRequest('Ellenőrizd a csomagok adatait.', errors);
  if (!list.length) {
    const count = Math.max(1, Math.min(99, parseInt(order.package_count, 10) || 1));
    list = Array.from({ length: count }, () => ({ weightKg: null, lengthCm: null, widthCm: null, heightCm: null, size: '' }));
  }
  const unknown = list.filter((p) => !p.weightKg);
  if (unknown.length) {
    const known = list.reduce((s, p) => s + (p.weightKg || 0), 0);
    const total = Number(order.weight_kg) > 0 ? Number(order.weight_kg) : await productWeight(env, order.id);
    const rest = total - known;
    const each = rest > 0 ? Math.max(0.1, round(rest / unknown.length, 2)) : DEFAULT_WEIGHT_KG;
    for (const p of unknown) p.weightKg = each;
  }
  return list;
}

export async function buildShipment(env, order, account, packages) {
  const company = (await getSetting(env.DB, 'company', {})) || {};
  const s = account.settings || {};
  const senderAddress = String(s.sender_address || company.address || '').trim();
  const sender = {
    name: String(s.sender_name || company.name || '').trim(),
    contactName: String(s.sender_name || company.name || '').trim(),
    email: String(s.sender_email || company.email || '').trim(),
    phone: normalizePhone(s.sender_phone || company.phone, 'HU'),
    country: String(company.country || 'HU').toUpperCase(),
    zip: String(s.sender_zip || company.zip || '').trim(),
    city: String(s.sender_city || company.city || '').trim(),
    address: senderAddress,
    ...splitStreet(senderAddress),
  };
  const country = String(order.country || 'HU').toUpperCase();
  const address = String(order.address || '').trim();
  const recipient = {
    name: String(order.customer_name || '').trim(),
    company: String(order.company || '').trim(),
    email: String(order.email || '').trim(),
    phone: normalizePhone(order.phone, country),
    country,
    zip: String(order.zip || '').trim(),
    city: String(order.city || '').trim(),
    address,
    ...splitStreet(address),
  };
  const pk = await normalizePackages(env, order, packages);
  const cod = Number(order.cod_amount) > 0 ? { amount: Number(order.cod_amount), currency: String(order.currency || 'HUF').toUpperCase() } : null;
  return {
    orderId: order.id,
    orderNumber: order.number,
    reference: order.external_number || order.number,
    content: order.external_number ? `${order.number} (${order.external_number})` : order.number,
    recipient,
    sender,
    pickupPointId: String(order.pickup_point_id || '').trim(),
    service: String(order.carrier_service || '').trim(),
    cod,
    packages: pk,
    totalWeightKg: round(pk.reduce((sum, p) => sum + p.weightKg, 0), 3),
    shipDate: budapestDay(),
  };
}

// ---------------------------------------------------------------- label

async function lockOrder(env, orderId) {
  const now = Date.now();
  const row = await first(env.DB,
    `INSERT INTO courier_label_locks (order_id, locked_at) VALUES (?, ?)
     ON CONFLICT (order_id) DO UPDATE SET locked_at = excluded.locked_at WHERE courier_label_locks.locked_at < ?
     RETURNING order_id`,
    orderId, new Date(now).toISOString(), new Date(now - LOCK_MS).toISOString());
  return !!row;
}

const unlockOrder = (env, orderId) => run(env.DB, 'DELETE FROM courier_label_locks WHERE order_id = ?', orderId);

const logFor = (env, code, order) => (e) => integrationLog(env, {
  system: code, partnerId: order ? order.partner_id : null, action: e.action, ok: e.ok, status: e.status,
  message: order ? `${order.number}: ${e.message}` : e.message, refType: order ? 'order' : '', refId: order ? order.id : null,
});

// Saves the problem as the account's last error and turns it into an HttpError.
async function fail(env, code, order, message, status) {
  try {
    await setCourierError(env, code, order ? `${order.number}: ${message}` : message);
    await integrationLog(env, { system: code, partnerId: order ? order.partner_id : null, action: 'createLabel', ok: false, message: order ? `${order.number}: ${message}` : message, refType: order ? 'order' : '', refId: order ? order.id : null });
  } catch {
    // The original problem matters more than a failed log write.
  }
  return status === 400 ? badRequest(message) : conflict(message);
}

export async function createLabel(ctx, orderId, { packages } = {}) {
  const env = ctx.env;
  const order = await first(env.DB,
    'SELECT o.*, c.carrier_code, c.name AS carrier_name FROM orders o LEFT JOIN partners c ON c.id = o.carrier_id WHERE o.id = ?', orderId);
  if (!order) throw notFound('A rendelés nem található.');
  const code = order.carrier_code || '';
  const adapter = ADAPTERS[code];
  if (!adapter) {
    throw conflict(order.carrier_id
      ? `A rendelés fuvarozójához (${order.carrier_name}) nincs futár API. Add meg kézzel a nyomkövetési számot.`
      : 'A rendeléshez nincs futárszolgálat rendelve. Válassz futárt a rendelésnél, vagy add meg kézzel a nyomkövetési számot.');
  }
  if (!LABEL_STATUSES.includes(order.status)) {
    throw conflict(`A(z) ${order.number} rendelés „${STATUSES.order[order.status] ? STATUSES.order[order.status].label : order.status}” állapotú, ehhez nem készíthető címke.`);
  }
  if (order.tracking_number) {
    throw conflict(`A(z) ${order.number} rendeléshez már van nyomkövetési szám (${order.tracking_number}). A címkét a rendelés dokumentumai közül nyomtathatod újra.`);
  }
  const account = await getCourierAccount(env, code);
  if (!account || !account.active) {
    throw conflict(`${capital(WHO[code])} fiók nincs beállítva vagy ki van kapcsolva (Beállítások, Futárszolgálatok). Addig add meg kézzel a nyomkövetési számot.`);
  }
  const missing = missingFields(adapter, account);
  if (missing.length) throw await fail(env, code, order, `Hiányzó ${adapter.name} beállítás: ${missing.join(', ')} (Beállítások, Futárszolgálatok).`, 409);

  const shipment = await buildShipment(env, order, account, packages);
  const problems = adapter.validate(shipment, account);
  if (problems.length) throw await fail(env, code, order, `Nem készült el ${WHO[code]} címke: ${problems.join(' ')}`, 400);

  if (!(await lockOrder(env, order.id))) throw conflict(`A(z) ${order.number} rendeléshez éppen készül a címke. Várj pár másodpercet.`);
  try {
    const again = await first(env.DB, 'SELECT tracking_number FROM orders WHERE id = ?', order.id);
    if (again && again.tracking_number) throw conflict(`A(z) ${order.number} rendeléshez közben elkészült a címke (${again.tracking_number}).`);

    const http = makeHttp({ log: logFor(env, code, order) });
    let result;
    try {
      result = await adapter.createShipment(shipment, account, http);
      if (!result || !result.trackingNumber) throw new CourierError('nem érkezett csomagszám.', { kind: 'response' });
    } catch (err) {
      if (!(err instanceof CourierError)) throw err;
      const hint = err.kind === 'unavailable' || err.kind === 'response' ? ' Ha sürgős, add meg kézzel a nyomkövetési számot.' : '';
      throw await fail(env, code, order, `Nem készült el ${WHO[code]} címke: ${err.message}${hint}`, err.kind === 'rejected' ? 400 : 409);
    }

    // From here the parcel is booked with the carrier: the tracking number is saved even when the
    // label cannot be kept, so a retry does not book it twice.
    const parcels = result.parcelNumbers && result.parcelNumbers.length ? result.parcelNumbers : [result.trackingNumber];
    const testNote = isTestMode(account) ? ' (teszt környezet)' : '';
    let documentId = null;
    let labelProblem = result.labelError || (isPdf(result.label) ? '' : 'a kapott címke nem PDF');
    if (!labelProblem) {
      try {
        documentId = await storeFile(ctx, {
          kind: 'label', partnerId: order.partner_id, filename: `${order.number}_${code}_${result.trackingNumber}.pdf`, contentType: 'application/pdf', body: result.label,
        });
      } catch (err) {
        labelProblem = `a PDF mentése nem sikerült (${String((err && err.message) || err).slice(0, 200)})`;
      }
    }
    await run(env.DB,
      'UPDATE orders SET tracking_number = ?, label_document_id = ?, package_count = ?, weight_kg = ?, updated_at = ? WHERE id = ?',
      result.trackingNumber, documentId, shipment.packages.length, shipment.totalWeightKg, nowIso(), order.id);
    const warnings = result.warnings || [];
    const text = [
      `${adapter.name} címke elkészült${testNote}, ${shipment.packages.length} csomag, ${String(shipment.totalWeightKg).replace('.', ',')} kg.`,
      `${parcels.length > 1 ? 'Csomagszámok' : 'Csomagszám'}: ${parcels.join(', ')}.`,
      warnings.length ? `Figyelmeztetés: ${warnings.join(' ')}` : '',
      labelProblem ? `A címke nem érhető el (${labelProblem}), a futár felületén nyomtasd ki.` : '',
    ].filter(Boolean).join(' ');
    await addOrderEvent(ctx, order.id, 'label', text);
    await audit(ctx, { module: 'orders', action: 'edit', entity: 'order', entityId: order.id, summary: `${order.number}: ${adapter.name} címke (${result.trackingNumber})${testNote}` });
    await integrationLog(env, { system: code, partnerId: order.partner_id, action: 'createLabel', ok: !labelProblem, message: `${order.number}: ${parcels.join(', ')}${testNote}${labelProblem ? `, címke nélkül: ${labelProblem}` : ''}`, refType: 'order', refId: order.id });
    if (labelProblem) {
      const message = `${capital(WHO[code])} csomag elkészült (${parcels.join(', ')}), de a címke nem érhető el: ${labelProblem}. Nyomtasd ki a futár felületén, a nyomkövetési számot elmentettük.`;
      await setCourierError(env, code, `${order.number}: ${message}`);
      throw conflict(message);
    }
    await setCourierError(env, code, '');
    return { trackingNumber: result.trackingNumber, documentId, parcelNumbers: parcels, carrierCode: code, trackingUrl: adapter.trackingUrl(result.trackingNumber), warnings };
  } finally {
    await unlockOrder(env, order.id);
  }
}

// ---------------------------------------------------------------- connection test

export async function testConnection(env, carrierCode) {
  const adapter = ADAPTERS[carrierCode];
  if (!adapter) return { ok: false, message: 'Ismeretlen futárszolgálat.' };
  const account = await getCourierAccount(env, carrierCode);
  if (!account) return { ok: false, message: `Előbb mentsd el ${WHO[carrierCode]} fiók adatait.` };
  const missing = missingFields(adapter, account);
  if (missing.length) return { ok: false, message: `Hiányzó adatok: ${missing.join(', ')}.` };
  const http = makeHttp({ log: logFor(env, carrierCode, null), timeoutMs: 20000 });
  let out;
  try {
    out = await adapter.testConnection(account, http);
  } catch (err) {
    if (!(err instanceof CourierError)) throw err;
    out = { ok: false, message: `${adapter.name}: ${err.message}` };
  }
  if (out.ok && isTestMode(account)) out = { ...out, message: `${out.message} (teszt környezet)` };
  if (out.ok && !account.active) out = { ...out, message: `${out.message} A fiók még nincs bekapcsolva.` };
  await setCourierError(env, carrierCode, out.ok ? '' : out.message);
  await integrationLog(env, { system: carrierCode, action: 'testConnection', ok: out.ok, message: out.message });
  return out;
}

// ---------------------------------------------------------------- delivery sync

const loadState = async (env, code) => {
  const row = await first(env.DB, 'SELECT state FROM courier_sync_state WHERE carrier_code = ?', code);
  try {
    return row ? JSON.parse(row.state) : {};
  } catch {
    return {};
  }
};

const saveState = (env, code, state) => run(env.DB,
  `INSERT INTO courier_sync_state (carrier_code, state, updated_at) VALUES (?, ?, ?)
   ON CONFLICT (carrier_code) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
  code, JSON.stringify(state || {}), nowIso());

// Accepts env (cron) or a ctx ({ env }) as test/test-worker.js passes it.
export async function syncDeliveries(envOrCtx) {
  const env = envOrCtx && envOrCtx.DB ? envOrCtx : envOrCtx.env;
  const ctx = { env, user: null, apiPartner: null };
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const summary = {};
  for (const adapter of Object.values(ADAPTERS)) {
    if (!adapter.trackDelivered) continue;
    const account = await getCourierAccount(env, adapter.code);
    if (!account || !account.active || missingFields(adapter, account).length) continue;
    const orders = await all(env.DB,
      `SELECT o.id, o.number, o.tracking_number FROM orders o JOIN partners c ON c.id = o.carrier_id
       WHERE o.status = 'shipped' AND c.carrier_code = ? AND o.tracking_number <> '' AND o.shipped_at >= ?
       ORDER BY o.shipped_at LIMIT 2000`,
      adapter.code, since);
    const entry = { checked: orders.length, delivered: 0, error: '' };
    summary[adapter.code] = entry;
    const state = await loadState(env, adapter.code);
    if (!orders.length) {
      if (Object.keys(state).length) await saveState(env, adapter.code, {});
      continue;
    }
    const http = makeHttp({ log: logFor(env, adapter.code, null) });
    try {
      const res = await adapter.trackDelivered(orders.map((o) => o.tracking_number), account, http, state);
      if (res.state !== undefined) await saveState(env, adapter.code, res.state);
      const byNumber = new Map(orders.map((o) => [String(o.tracking_number), o]));
      for (const d of res.delivered) {
        const o = byNumber.get(String(d.trackingNumber));
        if (!o) continue;
        try {
          await setOrderStatus(ctx, o.id, 'delivered', `Kézbesítve (${adapter.name} nyomkövetés): ${d.text}`);
          entry.delivered++;
        } catch {
          // The order moved on in the meantime (e.g. returned); nothing to do.
        }
      }
      await integrationLog(env, { system: adapter.code, action: 'syncDeliveries', ok: true, message: `${orders.length} rendelés ellenőrizve, ${entry.delivered} kézbesítve.` });
    } catch (err) {
      entry.error = err instanceof CourierError ? `${adapter.name}: ${err.message}` : String((err && err.message) || err);
      await integrationLog(env, { system: adapter.code, action: 'syncDeliveries', ok: false, message: entry.error });
      if (!(err instanceof CourierError)) console.error('courier sync failed', adapter.code, err && err.stack ? err.stack : err);
    }
  }
  return summary;
}

// ---------------------------------------------------------------- daily closing

export async function closeShipments(ctx, carrierCode, { trackingNumbers = [] } = {}) {
  const env = ctx.env;
  const adapter = ADAPTERS[carrierCode];
  if (!adapter) throw badRequest('Ismeretlen futárszolgálat.');
  if (!adapter.closeShipments) return { required: false, documentIds: [], closed: 0 };
  const account = await getCourierAccount(env, carrierCode);
  if (!account || !account.active) throw conflict(`${capital(WHO[carrierCode])} fiók nincs beállítva vagy ki van kapcsolva.`);
  const missing = missingFields(adapter, account);
  if (missing.length) throw conflict(`Hiányzó ${adapter.name} beállítás: ${missing.join(', ')}.`);
  const http = makeHttp({ log: logFor(env, carrierCode, null), timeoutMs: 60000 });
  let res;
  try {
    res = await adapter.closeShipments(account, http, { trackingNumbers: (trackingNumbers || []).map(String).filter(Boolean) });
  } catch (err) {
    if (!(err instanceof CourierError)) throw err;
    const message = `Nem sikerült a napi zárás ${WHO[carrierCode]} felé: ${err.message}`;
    await setCourierError(env, carrierCode, message);
    await integrationLog(env, { system: carrierCode, action: 'closeShipments', ok: false, message });
    throw err.kind === 'rejected' ? badRequest(message) : conflict(message);
  }
  const day = budapestDay();
  const documentIds = [];
  for (const [i, pdf] of res.manifests.entries()) {
    documentIds.push(await storeFile(ctx, { kind: 'manifest', filename: `${carrierCode}_jegyzek_${day}_${i + 1}.pdf`, contentType: 'application/pdf', body: pdf }));
  }
  const closed = res.prices.length || trackingNumbers.length;
  await audit(ctx, { module: 'transport', action: 'edit', entity: 'courier_closing', entityId: carrierCode, summary: `${adapter.name} napi zárás: ${closed} küldemény, ${documentIds.length} jegyzék` });
  await integrationLog(env, { system: carrierCode, action: 'closeShipments', ok: true, message: `${closed} küldemény lezárva.` });
  return { required: true, documentIds, closed };
}
