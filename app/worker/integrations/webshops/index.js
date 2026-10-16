// Webshop integrations (Shopify, WooCommerce, Shoprenter, UNAS): order import and fulfilment.
//
// Contract used by the rest of the app:
//   listPlatforms()                       -> [{ code, name, credentialFields, settingFields, shopUrl }]
//        fields: { key, label, type: text|password|select|number|checkbox, required, options, help, default }
//        shopUrl: { label, placeholder, help } for the shop address field of the connection form
//   syncAll(env)                          -> Promise<void>  cron: import new orders from every active connection
//   syncConnection(env, connectionId)     -> Promise<{ imported, skipped, errors }>  (errors: Hungarian strings;
//        also cancelled, fulfilled, stock, partial)
//   pushFulfillments(env, orderIds)       -> Promise<void>  after shipping: send tracking numbers back
//   testConnection(env, connectionId)     -> Promise<{ ok, message }>
//   listPendingOrders(env, connectionId)  -> Promise<[{ remote_id, external_number, error, attempts, first_seen_at, last_attempt_at }]>
//
// The connection row (webshop_connections) holds shop_url, credentials (encrypted JSON of
// credentialFields) and settings (JSON of settingFields). Each adapter (shopify.js ...) talks to
// one platform and returns normalised orders (common.js remoteOrder); this file does the rest:
//
// Import: orders changed since last_sync_cursor are read page by page. New ones go through
// createOrder() (source = platform, external_id = the platform's order id, so re-reading is safe)
// and are remembered in webshop_orders (which connection, the id the shop API uses). Orders the
// warehouse cannot take yet (unknown SKU, SKU missing in the shop ...) wait in
// webshop_pending_orders with a clear error and are retried on later syncs. Orders cancelled in
// the shop are cancelled here too while still new or on hold.
//
// Cursor: adapters with sorted results (Shopify, WooCommerce, UNAS) move it to the last processed
// order's update time after every order. Shoprenter has no documented order, so the whole window
// is paged through (page remembered between runs) before the cursor moves to the pass start.
//
// Fulfilment: shipped orders from a webshop are reported back with tracking number, carrier and
// tracking URL; failures are retried with backoff by every sync of the connection.
//
// Limits: every run has a budget of D1 queries plus HTTP calls (a Worker invocation may make 1000
// subrequests), and stops gracefully when it runs out; the next run continues. Refused credentials
// pause the connection (UNAS bans the IP after a few failed logins, so a refused UNAS key is not
// tried again by the cron until it changes).

import { all, batch, first, marks, parseJson, run, stmt } from '../../lib/db.js';
import { HttpError } from '../../lib/http.js';
import { audit, integrationLog } from '../../lib/audit.js';
import { decryptJson, encryptJson } from '../../lib/crypto.js';
import { sha256Hex } from '../../lib/auth.js';
import { createOrder } from '../../lib/order-create.js';
import { addOrderEvent, setOrderStatus } from '../../lib/orders.js';
import { availability } from '../../lib/stock.js';
import { CARRIERS, STATUSES } from '../../lib/constants.js';
import { budapestTime, nowIso } from '../../lib/time.js';
import { trackingUrl } from '../couriers/index.js';
import { SHOP_URL_HINTS, WebshopError, createHttp, defaultFetch, defaultSleep, readSettings } from './common.js';
import { scriptedFetch } from './testing.js';
import * as shopify from './shopify.js';
import * as woocommerce from './woocommerce.js';
import * as shoprenter from './shoprenter.js';
import * as unas from './unas.js';

export const PLATFORMS = {
  shopify: shopify.platform,
  woocommerce: woocommerce.platform,
  shoprenter: shoprenter.platform,
  unas: unas.platform,
};

const BUDGET = 600; // D1 queries + HTTP calls per invocation (Workers allow 1000 subrequests)
const MAX_PAGES = 10;
const PENDING_RETRY = 20;
const PUSH_PER_RUN = 25;
const PUSH_MAX_ATTEMPTS = 10;
const STOCK_PER_RUN = { shopify: 100, woocommerce: 40, shoprenter: 25, unas: 100 };
const LOCK_MS = 5 * 60 * 1000;
const UNSORTED_OVERLAP_MS = 10 * 60 * 1000;
const UNAS_MANUAL_RETRY_MS = 15 * 60 * 1000;

export function listPlatforms() {
  return Object.values(PLATFORMS).map((p) => ({
    code: p.code,
    name: p.name,
    credentialFields: p.credentialFields,
    settingFields: p.settingFields,
    shopUrl: SHOP_URL_HINTS[p.code],
  }));
}

// ---------------------------------------------------------------- run context

function newBudget(n = BUDGET) {
  return {
    left: n,
    spend(k = 1) { this.left -= k; },
    get low() { return this.left < 40; },
  };
}

function makeDeps(opts = {}) {
  return {
    fetch: opts.fetch || defaultFetch,
    sleep: opts.sleep || defaultSleep,
    budget: opts.budget || newBudget(),
    scheduled: !!opts.scheduled,
  };
}

const systemCtx = (env) => ({ env, user: null, apiPartner: null, waitUntil: () => {} });

const messageOf = (err) => (err instanceof WebshopError || err instanceof HttpError ? err.message : `Váratlan hiba: ${String((err && err.message) || err).slice(0, 300)}`);

async function loadConnection(env, id) {
  const row = await first(env.DB,
    `SELECT c.*, p.name AS partner_name, p.status AS partner_status, p.type AS partner_type
     FROM webshop_connections c JOIN partners p ON p.id = c.partner_id WHERE c.id = ?`, id);
  if (!row) return null;
  const platform = PLATFORMS[row.platform] || null;
  let credentials = null;
  let credentialError = '';
  try {
    credentials = row.credentials ? await decryptJson(env, row.credentials) : {};
  } catch (err) {
    credentialError = `A tárolt hitelesítő adatok nem olvashatók (${err.message}). Add meg őket újra.`;
  }
  const settings = platform ? readSettings(platform.settingFields, parseJson(row.settings, {})) : {};
  return { ...row, platformDef: platform, credentials, credentialError, settings };
}

// Why the connection cannot be used at all right now, or ''.
function unusable(conn) {
  if (!conn.platformDef) return `Ismeretlen webshop platform: ${conn.platform}.`;
  if (!conn.active) return 'A webshop kapcsolat ki van kapcsolva.';
  if (conn.partner_type !== 'client' || conn.partner_status !== 'active') return 'Az ügyfél inaktív, a kapcsolat szünetel.';
  if (conn.credentialError) return conn.credentialError;
  return '';
}

const credentialHash = (conn) => sha256Hex(`${conn.platform}|${conn.shop_url}|${JSON.stringify(conn.credentials || {})}`);

// ---------------------------------------------------------------- connection state

async function getState(env, id) {
  return (await first(env.DB, 'SELECT * FROM webshop_connection_state WHERE connection_id = ?', id))
    || { connection_id: id, token: '', backoff_until: null, backoff_reason: '', failed_credentials: '', failed_at: null, lock_until: null };
}

async function updateState(env, id, changes) {
  const keys = Object.keys(changes);
  await run(env.DB,
    `INSERT INTO webshop_connection_state (connection_id, ${keys.join(', ')}) VALUES (?, ${marks(keys.length)})
     ON CONFLICT (connection_id) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(', ')}`,
    id, ...keys.map((k) => changes[k]));
}

async function acquireLock(env, id) {
  const now = nowIso();
  await run(env.DB, 'INSERT OR IGNORE INTO webshop_connection_state (connection_id) VALUES (?)', id);
  const res = await run(env.DB, 'UPDATE webshop_connection_state SET lock_until = ? WHERE connection_id = ? AND (lock_until IS NULL OR lock_until < ?)',
    new Date(Date.now() + LOCK_MS).toISOString(), id, now);
  return res.meta.changes === 1;
}

const releaseLock = (env, id) => run(env.DB, 'UPDATE webshop_connection_state SET lock_until = NULL WHERE connection_id = ?', id);

// A message if the connection is paused (rate limit, ban, refused credentials), or ''.
// Refused credentials stop pausing once they are changed. Manual runs may retry refused
// credentials, except UNAS within 15 minutes (its failed login limit bans the IP).
function pausedMessage(conn, state, hash, scheduled) {
  if (!state.backoff_until || Date.parse(state.backoff_until) <= Date.now()) return '';
  const authPause = !!state.failed_credentials;
  if (authPause && state.failed_credentials !== hash) return '';
  if (authPause && !scheduled) {
    const recent = state.failed_at && Date.now() - Date.parse(state.failed_at) < UNAS_MANUAL_RETRY_MS;
    if (conn.platform !== 'unas' || !recent) return '';
    return 'Az UNAS bejelentkezés nemrég sikertelen volt ezzel az API kulccsal. Az IP tiltás elkerülése miatt 15 percig nem próbálkozunk újra; ellenőrizd vagy cseréld az API kulcsot.';
  }
  return `A kapcsolat szünetel eddig: ${state.backoff_until}. ${state.backoff_reason}`.trim();
}

async function applyBackoff(env, conn, err, hash) {
  if (!(err instanceof WebshopError)) return;
  const now = Date.now();
  if (err.kind === 'auth') {
    const ms = conn.platform === 'unas' ? 7 * 24 * 3600 * 1000 : 3600 * 1000;
    await updateState(env, conn.id, { backoff_until: new Date(now + ms).toISOString(), backoff_reason: err.message, failed_credentials: hash, failed_at: new Date(now).toISOString(), token: '' });
  } else if (err.kind === 'rate' || err.kind === 'banned') {
    const ms = Math.min(Math.max(err.retryAfter || (err.kind === 'banned' ? 3600 * 1000 : 10 * 60 * 1000), 60 * 1000), 24 * 3600 * 1000);
    await updateState(env, conn.id, { backoff_until: new Date(now + ms).toISOString(), backoff_reason: err.message, failed_credentials: '' });
  }
}

const clearBackoff = (env, id) => updateState(env, id, { backoff_until: null, backoff_reason: '', failed_credentials: '', failed_at: null });

function tokenStore(env, id, state) {
  return {
    async get() {
      if (!state.token) return null;
      try {
        return await decryptJson(env, state.token);
      } catch {
        return null;
      }
    },
    async set(token, expiresAt) {
      state.token = token ? await encryptJson(env, { token, expiresAt }) : '';
      await updateState(env, id, { token: state.token });
    },
  };
}

function connectClient(env, conn, state, deps) {
  const platform = conn.platformDef;
  const http = createHttp({
    fetch: deps.fetch,
    sleep: deps.sleep,
    minIntervalMs: platform.minIntervalMs || 0,
    log: async (e) => {
      deps.budget.spend(1);
      try {
        await integrationLog(env, {
          system: conn.platform, direction: 'out', partnerId: conn.partner_id, action: e.action, ok: e.ok, status: e.status, message: e.message,
          refType: 'webshop_connection', refId: conn.id,
        });
      } catch (err) {
        console.error('integration log failed', err && err.message);
      }
    },
  });
  const counted = (...args) => {
    deps.budget.spend(1);
    return http(...args);
  };
  return platform.connect({ shopUrl: conn.shop_url, credentials: conn.credentials, settings: conn.settings, http: counted, tokens: tokenStore(env, conn.id, state), sleep: deps.sleep });
}

// ---------------------------------------------------------------- cursor

function parseCursor(text, initialDays) {
  const j = parseJson(text, null);
  if (j && typeof j === 'object' && typeof j.since === 'string' && !Number.isNaN(Date.parse(j.since))) {
    return { since: new Date(j.since).toISOString(), page: j.page ?? null, passStart: j.passStart || null };
  }
  if (text && typeof text === 'string' && !Number.isNaN(Date.parse(text))) return { since: new Date(text).toISOString(), page: null, passStart: null };
  return { since: new Date(Date.now() - (Number(initialDays) || 0) * 86400000).toISOString(), page: null, passStart: null };
}

// ---------------------------------------------------------------- import

const label = (o) => (o.number ? `#${String(o.number).replace(/^#/, '')}` : o.remoteId);

function fieldMessage(err) {
  const values = [...new Set(Object.values(err.fields || {}).map(String))];
  return values.length ? values.join('; ') : err.message;
}

const isUnique = (err) => /UNIQUE constraint failed/i.test(String((err && err.message) || ''));

async function savePending(env, conn, o, message, seen) {
  const prev = seen.pending.get(o.remoteId);
  const attempts = prev ? prev.attempts + 1 : 1;
  const now = new Date();
  const next = new Date(now.getTime() + Math.min(attempts * 10, 360) * 60 * 1000).toISOString();
  await run(env.DB,
    `INSERT INTO webshop_pending_orders (connection_id, remote_id, external_number, payload, error, attempts, first_seen_at, last_attempt_at, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (connection_id, remote_id) DO UPDATE SET external_number = excluded.external_number, payload = excluded.payload,
       error = excluded.error, attempts = excluded.attempts, last_attempt_at = excluded.last_attempt_at, next_attempt_at = excluded.next_attempt_at`,
    conn.id, o.remoteId, String(o.number || ''), JSON.stringify(o), message.slice(0, 1000), attempts, now.toISOString(), now.toISOString(), next);
  seen.pending.set(o.remoteId, { attempts });
}

async function dropPending(env, conn, remoteId, seen) {
  if (!seen.pending.has(remoteId)) return;
  await run(env.DB, 'DELETE FROM webshop_pending_orders WHERE connection_id = ? AND remote_id = ?', conn.id, remoteId);
  seen.pending.delete(remoteId);
}

async function importOne(env, ctx, conn, o, deps, result, seen) {
  if (seen.done.has(o.remoteId)) return;
  seen.done.add(o.remoteId);
  if (o.problems && o.problems.length) {
    const msg = o.problems.join(' ');
    await savePending(env, conn, o, msg, seen);
    result.errors.push(`${label(o)}: ${msg}`);
    return;
  }
  deps.budget.spend(14);
  const input = { ...o.input, partner_id: conn.partner_id, source: conn.platform, external_id: o.externalId, external_number: String(o.number || ''), lines: o.lines };
  let r;
  try {
    try {
      r = await createOrder(ctx, input);
    } catch (err) {
      if (!isUnique(err)) throw err;
      r = await createOrder(ctx, input); // imported by a parallel run a moment ago: answers the duplicate
    }
    if (r.duplicate) {
      // Same platform order id in another shop of the same partner (WooCommerce ids are per site).
      const owner = await first(env.DB, 'SELECT connection_id FROM webshop_orders WHERE order_id = ?', r.id);
      if (owner && owner.connection_id !== conn.id) r = await createOrder(ctx, { ...input, external_id: `${o.externalId}@${conn.id}` });
    }
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) {
      const msg = fieldMessage(err);
      await savePending(env, conn, o, msg, seen);
      result.errors.push(`${label(o)}: ${msg}`);
      return;
    }
    throw err;
  }
  await run(env.DB, 'INSERT OR IGNORE INTO webshop_orders (order_id, connection_id, remote_id, remote_number) VALUES (?, ?, ?, ?)',
    r.id, conn.id, o.remoteId, String(o.number || ''));
  await dropPending(env, conn, o.remoteId, seen);
  if (r.duplicate) result.skipped++;
  else result.imported++;
}

// The order was cancelled in the shop after we imported it: cancel it here too while nobody has
// started working on it, otherwise leave a warning on the timeline. Happens once per order.
async function remoteCancelled(env, ctx, conn, mapped, result) {
  const name = conn.platformDef.name;
  let cancelled = false;
  if (conn.settings.cancel_sync && ['new', 'hold'].includes(mapped.status) && !mapped.wave_id) {
    try {
      await setOrderStatus(ctx, mapped.order_id, 'cancelled', `Sztornózva: a rendelést törölték a webshopban (${name}).`);
      await audit(ctx, { module: 'orders', action: 'delete', entity: 'order', entityId: mapped.order_id, summary: `${mapped.number} sztornózva, mert törölték a webshopban (${name})` });
      result.cancelled++;
      cancelled = true;
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 409)) throw err; // moved on in the meantime
    }
  }
  if (!cancelled) {
    const current = await first(env.DB, 'SELECT status FROM orders WHERE id = ?', mapped.order_id);
    const status = current ? current.status : mapped.status;
    if (status !== 'cancelled') {
      const st = STATUSES.order[status];
      const where = mapped.wave_id && ['new', 'hold'].includes(status) ? 'már komissiós hullámba került' : `már „${st ? st.label : status}” állapotú`;
      const text = conn.settings.cancel_sync
        ? `Figyelem: a rendelést törölték a webshopban (${name}), de ${where}, ezért nem sztornóztuk. Állítsátok meg kézzel, ha még lehet.`
        : `Figyelem: a rendelést törölték a webshopban (${name}).`;
      await addOrderEvent(ctx, mapped.order_id, 'sync', text);
    }
  }
  await run(env.DB, 'UPDATE webshop_orders SET remote_cancelled_at = ? WHERE order_id = ?', nowIso(), mapped.order_id);
}

async function handleRemote(env, ctx, conn, o, deps, result, seen) {
  deps.budget.spend(2);
  const mapped = await first(env.DB,
    `SELECT w.order_id, w.remote_cancelled_at, o.status, o.number, o.wave_id FROM webshop_orders w JOIN orders o ON o.id = w.order_id
     WHERE w.connection_id = ? AND w.remote_id = ?`, conn.id, o.remoteId);
  if (mapped) {
    if (o.state === 'cancelled' && !mapped.remote_cancelled_at) await remoteCancelled(env, ctx, conn, mapped, result);
    await dropPending(env, conn, o.remoteId, seen);
    result.skipped++;
    return;
  }
  if (o.state !== 'import') {
    await dropPending(env, conn, o.remoteId, seen);
    result.skipped++;
    return;
  }
  await importOne(env, ctx, conn, o, deps, result, seen);
}

async function retryPending(env, ctx, conn, deps, result, seen) {
  const due = await all(env.DB,
    `SELECT remote_id, payload FROM webshop_pending_orders WHERE connection_id = ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY last_attempt_at LIMIT ?`, conn.id, nowIso(), PENDING_RETRY);
  for (const row of due) {
    if (deps.budget.low) return;
    const o = parseJson(row.payload, null);
    if (!o || !o.remoteId) {
      await dropPending(env, conn, row.remote_id, seen);
      continue;
    }
    // A problem in the shop's data (no SKU there ...) only goes away when the order changes in the
    // shop, and then the order is read again anyway.
    if (o.problems && o.problems.length) continue;
    await handleRemote(env, ctx, conn, o, deps, result, seen);
  }
}

async function importOrders(env, ctx, conn, client, deps, result, seen, progress) {
  const platform = conn.platformDef;
  const sorted = platform.sorted !== false;
  const cur = parseCursor(conn.last_sync_cursor, conn.settings.initial_days);
  const since = new Date(cur.since);
  const passStart = sorted ? null : cur.passStart || nowIso();
  let page = sorted ? null : cur.page;
  let watermark = cur.since;
  const maxPages = platform.maxPages || MAX_PAGES;
  for (let n = 0; n < maxPages; n++) {
    if (deps.budget.low) {
      result.partial = true;
      return;
    }
    const res = await client.listOrders({ since, page });
    for (const o of res.orders) {
      if (deps.budget.low) {
        // Unsorted: read this page again next time. Sorted: the watermark covers what is done.
        result.partial = true;
        if (!sorted) progress.cursor = JSON.stringify({ since: cur.since, page, passStart });
        return;
      }
      await handleRemote(env, ctx, conn, o, deps, result, seen);
      if (sorted && o.updatedAt && o.updatedAt > watermark) {
        watermark = o.updatedAt;
        progress.cursor = JSON.stringify({ since: watermark });
      }
    }
    if (!res.nextPage) {
      progress.cursor = JSON.stringify({ since: sorted ? watermark : new Date(Date.parse(passStart) - UNSORTED_OVERLAP_MS).toISOString() });
      return;
    }
    page = res.nextPage;
    if (!sorted) progress.cursor = JSON.stringify({ since: cur.since, page, passStart });
  }
  result.partial = true;
}

async function pendingSummary(env, conn) {
  const rows = await all(env.DB,
    'SELECT external_number, remote_id, error FROM webshop_pending_orders WHERE connection_id = ? ORDER BY first_seen_at LIMIT 4', conn.id);
  if (!rows.length) return '';
  const total = (await first(env.DB, 'SELECT COUNT(*) AS n FROM webshop_pending_orders WHERE connection_id = ?', conn.id)).n;
  const list = rows.slice(0, 3).map((r) => `${r.external_number ? `#${String(r.external_number).replace(/^#/, '')}` : r.remote_id}: ${r.error}`).join('; ');
  return `${total} rendelés nem importálható, újrapróbáljuk: ${list}${total > 3 ? ' ...' : ''}`.slice(0, 1000);
}

export async function listPendingOrders(env, connectionId) {
  return all(env.DB,
    `SELECT remote_id, external_number, error, attempts, first_seen_at, last_attempt_at, next_attempt_at
     FROM webshop_pending_orders WHERE connection_id = ? ORDER BY first_seen_at`, connectionId);
}

// ---------------------------------------------------------------- fulfilment

const splitTracking = (t) => String(t || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);

async function safeTrackingUrl(code, number) {
  try {
    return (code && number && (await trackingUrl(code, number))) || '';
  } catch {
    return '';
  }
}

// Connection level failures (credentials, rate limit, network) stop the run; others are counted
// on the order and retried with backoff.
const connectionLevel = (err) => err instanceof WebshopError && ['auth', 'rate', 'banned', 'network'].includes(err.kind);

async function pushOne(env, ctx, conn, client, orderId, deps, result) {
  deps.budget.spend(8);
  const o = await first(env.DB,
    `SELECT o.id, o.number, o.status, o.tracking_number, o.fulfillment_synced_at, c.carrier_code, c.name AS carrier_name,
            w.remote_id, w.remote_number, w.fulfillment_attempts
     FROM orders o JOIN webshop_orders w ON w.order_id = o.id LEFT JOIN partners c ON c.id = o.carrier_id
     WHERE o.id = ? AND w.connection_id = ?`, orderId, conn.id);
  if (!o || o.fulfillment_synced_at || !['shipped', 'delivered'].includes(o.status)) return;
  const numbers = splitTracking(o.tracking_number);
  const code = o.carrier_code || '';
  const urls = [];
  for (const n of numbers) urls.push(await safeTrackingUrl(code, n));
  const carrierName = code && code !== 'other' && CARRIERS[code] ? CARRIERS[code] : o.carrier_name || '';
  try {
    const out = await client.fulfill({ remoteId: o.remote_id, number: o.remote_number, trackingNumbers: numbers, trackingUrls: urls, carrierCode: code, carrierName });
    await batch(env.DB, [
      stmt(env.DB, 'UPDATE orders SET fulfillment_synced_at = ? WHERE id = ?', nowIso(), o.id),
      stmt(env.DB, "UPDATE webshop_orders SET fulfillment_error = '', fulfillment_next_at = NULL WHERE order_id = ?", o.id),
    ]);
    const tracking = numbers.length ? `, csomagszám: ${numbers.join(', ')}` : ', csomagszám nélkül';
    await addOrderEvent(ctx, o.id, 'sync', out && out.already
      ? `A rendelés már teljesítve volt a webshopban (${conn.platformDef.name}).`
      : `Feladás visszaküldve a webshopba (${conn.platformDef.name})${tracking}.`);
    result.fulfilled++;
  } catch (err) {
    if (connectionLevel(err)) throw err;
    if (!(err instanceof WebshopError)) console.error('fulfilment push failed', err && err.stack ? err.stack : err);
    const msg = messageOf(err);
    const attempts = (o.fulfillment_attempts || 0) + 1;
    const next = new Date(Date.now() + Math.min(10 * 2 ** (attempts - 1), 12 * 60) * 60 * 1000).toISOString();
    await run(env.DB, 'UPDATE webshop_orders SET fulfillment_attempts = ?, fulfillment_error = ?, fulfillment_next_at = ? WHERE order_id = ?',
      attempts, msg.slice(0, 1000), next, o.id);
    if (attempts === 1) await addOrderEvent(ctx, o.id, 'sync', `Nem sikerült visszaküldeni a feladást a webshopba: ${msg} Később újrapróbáljuk.`);
    else if (attempts >= PUSH_MAX_ATTEMPTS) await addOrderEvent(ctx, o.id, 'sync', `A feladás visszaküldése a webshopba ${attempts} próbálkozás után sem sikerült, nem próbáljuk tovább: ${msg}`);
    result.errors.push(`${o.number}: ${msg}`);
  }
}

async function pushPendingForConnection(env, ctx, conn, client, deps, result) {
  const rows = await all(env.DB,
    `SELECT w.order_id FROM webshop_orders w JOIN orders o ON o.id = w.order_id
     WHERE w.connection_id = ? AND o.fulfillment_synced_at IS NULL AND o.status IN ('shipped', 'delivered')
       AND w.fulfillment_attempts < ? AND (w.fulfillment_next_at IS NULL OR w.fulfillment_next_at <= ?)
     ORDER BY o.shipped_at, o.id LIMIT ?`, conn.id, PUSH_MAX_ATTEMPTS, nowIso(), PUSH_PER_RUN);
  for (const r of rows) {
    if (deps.budget.low) {
      result.partial = true;
      return;
    }
    await pushOne(env, ctx, conn, client, r.order_id, deps, result);
  }
}

// ---------------------------------------------------------------- stock

async function syncStock(env, conn, client, deps, result) {
  if (deps.budget.left < 150) return;
  const products = await all(env.DB, 'SELECT id, sku FROM products WHERE partner_id = ? AND active = 1 ORDER BY id LIMIT 5000', conn.partner_id);
  if (!products.length) return;
  deps.budget.spend(2 * Math.ceil(products.length / 90) + 3);
  const avail = await availability(env.DB, products.map((p) => p.id));
  const last = new Map((await all(env.DB, 'SELECT sku, qty, missing, synced_at FROM webshop_stock_sync WHERE connection_id = ?', conn.id)).map((r) => [r.sku, r]));
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const changed = [];
  for (const p of products) {
    const qty = Math.max(0, avail[p.id] ? avail[p.id].available : 0);
    const prev = last.get(p.sku);
    if (prev && prev.qty === qty && (!prev.missing || Date.parse(prev.synced_at) > dayAgo)) continue;
    changed.push({ sku: p.sku, qty });
  }
  const items = changed.slice(0, STOCK_PER_RUN[conn.platform] || 25);
  if (!items.length) return;
  deps.budget.spend(items.length);
  const out = await client.pushStock(items);
  const at = nowIso();
  const qtyOf = new Map(items.map((i) => [i.sku, i.qty]));
  const upsert = (sku, missing) => stmt(env.DB,
    `INSERT INTO webshop_stock_sync (connection_id, sku, qty, missing, synced_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (connection_id, sku) DO UPDATE SET qty = excluded.qty, missing = excluded.missing, synced_at = excluded.synced_at`,
    conn.id, sku, qtyOf.get(sku), missing ? 1 : 0, at);
  const statements = [
    ...out.updated.map((sku) => upsert(sku, false)),
    ...out.missing.map((sku) => upsert(sku, true)),
    ...out.failed.map((f) => upsert(f.sku, true)),
  ];
  if (statements.length) await batch(env.DB, statements);
  result.stock = { updated: out.updated.length, missing: out.missing.length, failed: out.failed.length, waiting: Math.max(changed.length - items.length, 0) };
  if (out.failed.length) result.errors.push(`Készlet: ${out.failed.slice(0, 3).map((f) => `${f.sku}: ${f.message}`).join('; ')}`);
}

// ---------------------------------------------------------------- contract

export async function syncConnection(env, connectionId, opts = {}) {
  const deps = makeDeps(opts);
  const result = { imported: 0, skipped: 0, cancelled: 0, fulfilled: 0, errors: [] };
  deps.budget.spend(6);
  const conn = await loadConnection(env, connectionId);
  if (!conn) {
    result.errors.push('A webshop kapcsolat nem található.');
    return result;
  }
  const why = unusable(conn);
  if (why) {
    result.errors.push(why);
    return result;
  }
  const state = await getState(env, conn.id);
  const hash = await credentialHash(conn);
  const paused = pausedMessage(conn, state, hash, deps.scheduled);
  if (paused) {
    result.errors.push(paused);
    return result;
  }
  if (!(await acquireLock(env, conn.id))) {
    result.errors.push('Ennél a kapcsolatnál már fut egy szinkron, próbáld újra pár perc múlva.');
    return result;
  }
  const ctx = systemCtx(env);
  const progress = { cursor: conn.last_sync_cursor };
  let fatal = null;
  try {
    const pending = await all(env.DB, 'SELECT remote_id, attempts FROM webshop_pending_orders WHERE connection_id = ?', conn.id);
    const seen = { pending: new Map(pending.map((p) => [p.remote_id, { attempts: p.attempts }])), done: new Set() };
    const client = connectClient(env, conn, state, deps);
    await retryPending(env, ctx, conn, deps, result, seen);
    await importOrders(env, ctx, conn, client, deps, result, seen, progress);
    if (conn.settings.push_fulfillment) await pushPendingForConnection(env, ctx, conn, client, deps, result);
    if (conn.settings.stock_sync && client.pushStock) await syncStock(env, conn, client, deps, result);
  } catch (err) {
    fatal = err;
    if (!(err instanceof WebshopError) && !(err instanceof HttpError)) console.error(`webshop sync ${conn.id} failed`, err && err.stack ? err.stack : err);
    result.errors.push(messageOf(err));
    try {
      await applyBackoff(env, conn, err, hash);
    } catch (e) {
      console.error('webshop backoff failed', e && e.message);
    }
  } finally {
    await releaseLock(env, conn.id);
  }
  const lastError = fatal ? messageOf(fatal) : await pendingSummary(env, conn);
  await run(env.DB, 'UPDATE webshop_connections SET last_sync_at = ?, last_sync_cursor = ?, last_error = ? WHERE id = ?',
    nowIso(), progress.cursor || '', lastError.slice(0, 1000), conn.id);
  if (!fatal && state.backoff_until) await clearBackoff(env, conn.id);
  return result;
}

// UNAS does maintenance around midnight (plus or minus 10 minutes).
const unasMaintenance = () => {
  const t = budapestTime();
  return t >= '23:50' || t < '00:10';
};

export async function syncAll(env, opts = {}) {
  const budget = opts.budget || newBudget();
  const rows = await all(env.DB,
    `SELECT c.id, c.platform FROM webshop_connections c JOIN partners p ON p.id = c.partner_id
     WHERE c.active = 1 AND p.status = 'active' AND p.type = 'client' ORDER BY COALESCE(c.last_sync_at, ''), c.id`);
  const results = [];
  for (const r of rows) {
    if (budget.left < 100) break;
    if (!PLATFORMS[r.platform]) continue;
    if (r.platform === 'unas' && unasMaintenance()) continue;
    try {
      results.push({ id: r.id, ...(await syncConnection(env, r.id, { ...opts, budget, scheduled: true })) });
    } catch (err) {
      console.error(`webshop sync ${r.id} failed`, err && err.stack ? err.stack : err);
    }
  }
  return results;
}

export async function pushFulfillments(env, orderIds, opts = {}) {
  const ids = [...new Set((Array.isArray(orderIds) ? orderIds : [orderIds]).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const summary = { fulfilled: 0, errors: [], waiting: 0 };
  if (!ids.length) return summary;
  const deps = makeDeps(opts);
  const byConnection = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await all(env.DB,
      `SELECT w.order_id, w.connection_id FROM webshop_orders w JOIN orders o ON o.id = w.order_id
       WHERE w.order_id IN (${marks(chunk.length)}) AND o.fulfillment_synced_at IS NULL ORDER BY w.order_id`, ...chunk);
    for (const r of rows) {
      if (!byConnection.has(r.connection_id)) byConnection.set(r.connection_id, []);
      byConnection.get(r.connection_id).push(r.order_id);
    }
  }
  const ctx = systemCtx(env);
  for (const [connectionId, orders] of byConnection) {
    try {
      const conn = await loadConnection(env, connectionId);
      // Not now (connection off, paused ...): the sync of the connection retries them later.
      if (!conn || unusable(conn) || !conn.settings.push_fulfillment) {
        summary.waiting += orders.length;
        continue;
      }
      const state = await getState(env, conn.id);
      const hash = await credentialHash(conn);
      if (pausedMessage(conn, state, hash, true)) {
        summary.waiting += orders.length;
        continue;
      }
      const client = connectClient(env, conn, state, deps);
      const result = { fulfilled: 0, errors: [] };
      for (let i = 0; i < orders.length; i++) {
        if (deps.budget.low || i >= PUSH_PER_RUN * 2) {
          summary.waiting += orders.length - i;
          break;
        }
        try {
          await pushOne(env, ctx, conn, client, orders[i], deps, result);
        } catch (err) {
          await applyBackoff(env, conn, err, hash);
          await run(env.DB, 'UPDATE webshop_connections SET last_error = ? WHERE id = ?', messageOf(err).slice(0, 1000), conn.id);
          summary.errors.push(messageOf(err));
          summary.waiting += orders.length - i;
          break;
        }
      }
      summary.fulfilled += result.fulfilled;
      summary.errors.push(...result.errors);
    } catch (err) {
      console.error(`fulfilment push for connection ${connectionId} failed`, err && err.stack ? err.stack : err);
      summary.errors.push(messageOf(err));
    }
  }
  return summary;
}

export async function testConnection(env, connectionId, opts = {}) {
  const deps = makeDeps(opts);
  const conn = await loadConnection(env, connectionId);
  if (!conn) return { ok: false, message: 'A webshop kapcsolat nem található.' };
  if (!conn.platformDef) return { ok: false, message: `Ismeretlen webshop platform: ${conn.platform}.` };
  if (conn.credentialError) return { ok: false, message: conn.credentialError };
  const state = await getState(env, conn.id);
  const hash = await credentialHash(conn);
  const paused = pausedMessage(conn, state, hash, false);
  if (paused) return { ok: false, message: paused };
  try {
    const client = connectClient(env, conn, state, deps);
    const message = await client.test();
    if (state.failed_credentials) await clearBackoff(env, conn.id);
    return { ok: true, message };
  } catch (err) {
    if (!(err instanceof WebshopError)) console.error(`webshop test ${conn.id} failed`, err && err.stack ? err.stack : err);
    if (err instanceof WebshopError && err.kind === 'auth') await applyBackoff(env, conn, err, hash);
    return { ok: false, message: messageOf(err) };
  }
}

// Test support (reached only through test/test-worker.js): runs one of the functions above with a
// scripted HTTP transport and returns the result with every request made.
export async function runWithMockedHttp(env, { call, args = [], routes = [], budget } = {}) {
  const fns = { syncConnection, syncAll, pushFulfillments, testConnection };
  if (!fns[call]) throw new Error(`unknown function ${call}`);
  const { fetch, requests } = scriptedFetch(routes);
  const opts = { fetch, sleep: async () => {} };
  if (budget) opts.budget = newBudget(budget);
  const result = call === 'syncAll' ? await fns[call](env, opts) : await fns[call](env, ...args, opts);
  return { result, requests };
}
