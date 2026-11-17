// UNAS: XML API (https://unas.hu/tudastar/api).
//
// Authentication: POST https://api.unas.eu/shop/login <Params><ApiKey/><WebshopInfo>true</WebshopInfo></Params>
//   -> <Token> valid for 2 hours (ExpireTime), sent as "Authorization: Bearer <token>".
// Limits that matter here (https://unas.hu/tudastar/api/limitaciok):
//   - failed logins: 5 per hour; 10 unidentifiable calls in 10 minutes ban the IP for every shop
//     for 2 hours. So a refused login is never retried automatically: the engine stops syncing the
//     connection until the API key changes (see index.js, auth backoff).
//   - getOrder with several orders per call: 30 calls per hour (PREMIUM), so at most two pages
//     per sync; the token is cached for its lifetime.
//   - maintenance around midnight (plus or minus 10 minutes): the cron skips UNAS then.
// Orders: getOrder <TimeModStart> (unix time) <Order>modify_time_asc</Order> <LimitNum>/<LimitStart>.
// Fulfilment: setOrder <Action>modify</Action> <Key/> <Status/> <StatusEmail/>
//   <Shipping><PackageNumber/><TrackingUrl/></Shipping>.
// Stock: setStock <Action>modify</Action> <Sku/> <Stocks><Stock><Qty/></Stock></Stocks> (up to 100 per call).

import {
  WebshopError, commonSettingFields, excerpt, fromBudapestLocal, isCod, list, money, orderInput, orderLines, remoteOrder, resolveShipping,
} from './common.js';
import { buildXml, parseXml } from './xml.js';

export const API = 'https://api.unas.eu/shop';
const PER_PAGE = 100;
const SPECIAL_ITEMS = new Set(['handel-cost', 'shipping-cost', 'discount-amount', 'discount-percent']);
const XML_HEADERS = { 'content-type': 'application/xml; charset=UTF-8', accept: 'application/xml' };

export const credentialFields = [
  { key: 'api_key', label: 'API kulcs', type: 'password', required: true,
    help: 'Az áruház adminjában: Beállítások > Külső kapcsolatok > API kapcsolat. Engedélyezd a getOrder és setOrder funkciót (a készlethez a setStock funkciót is).' },
];

export const settingFields = [
  { key: 'import_statuses', label: 'Importált rendelési állapotok', type: 'text', required: false, default: '',
    help: 'Az állapotok neve vagy azonosítója vesszővel elválasztva. Üresen minden normál nyitott állapotú rendelés bekerül.' },
  { key: 'cancel_statuses', label: 'Törölt rendelési állapotok', type: 'text', required: false, default: '',
    help: 'Azok az állapotok (név vagy azonosító), amelyek a rendelés visszavonását jelentik. A sikertelenül lezárt állapotokat magunktól is töröltnek vesszük.' },
  { key: 'shipped_status', label: 'Feladott állapot', type: 'text', required: false, default: '',
    help: 'Erre az állapotra állítjuk a rendelést feladáskor (név vagy azonosító). Üresen csak a csomagszámot írjuk be.' },
  { key: 'status_email', label: 'Státusz e-mail a vásárlónak', type: 'checkbox', required: false, default: true,
    help: 'Az állapot módosításakor az UNAS kiküldi a beállított státusz e-mailt.' },
  ...commonSettingFields({ codDefault: 'cod', carrierHelp: ', illetve az átvételi pont csoportjából' }),
];

// The UNAS API answers <Error>text</Error> on failure.
function errorText(doc, raw) {
  if (doc && doc.name === 'Error') return doc.text() || 'ismeretlen hiba';
  if (!doc) return excerpt(raw, 200) || 'üres válasz';
  return '';
}

function parse(text) {
  try {
    return parseXml(text);
  } catch {
    return null;
  }
}

// "IP is banned till 02.28.2022 10:00:00" -> milliseconds to wait (one hour if unreadable).
function banWait(message) {
  const m = String(message).match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const iso = fromBudapestLocal(`${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:${m[6] || '00'}`);
    if (iso) return Math.max(Date.parse(iso) - Date.now(), 60000);
  }
  return 60 * 60 * 1000;
}

// Pickup point groups ("gls_api_dropoffpoints" ...) to our carriers.
export function deliveryGroupCarrier(group) {
  const g = String(group || '').toLowerCase();
  if (g.startsWith('gls')) return 'gls';
  if (g.includes('foxpost')) return 'foxpost';
  if (g.includes('posta') || g.startsWith('mpl')) return 'mpl';
  if (g.startsWith('dpd')) return 'dpd';
  return '';
}

// MPL delivery mode from the pickup point group type (posta, postapont, csomagautomata).
export function subGroupMplMode(subGroup) {
  return { posta: 'PM', postapont: 'PP', csomagautomata: 'CS' }[String(subGroup || '').trim().toLowerCase()] || '';
}

export function connect({ credentials = {}, settings, http, tokens }) {
  if (!credentials.api_key) throw new WebshopError('Add meg az UNAS API kulcsot.', { kind: 'config' });
  let shopName = '';
  let permissions = null;

  async function login({ fresh = false } = {}) {
    if (!fresh) {
      const cached = await tokens.get();
      if (cached && cached.token && cached.expiresAt > Date.now() + 60000) return cached.token;
    }
    // Never retried: failed logins are counted by UNAS (5 per hour).
    const res = await http('login', `${API}/login`, {
      method: 'POST', headers: XML_HEADERS, parse: 'text', retries: 0,
      body: buildXml('Params', { ApiKey: credentials.api_key, WebshopInfo: 'true' }),
    });
    const doc = parse(res.text);
    const token = doc && doc.name !== 'Error' ? doc.text('Token') : '';
    if (!token) {
      const msg = errorText(doc, res.text) || 'nincs token a válaszban';
      if (/banned|tiltva|letilt/i.test(msg)) throw new WebshopError(`Az UNAS ideiglenesen letiltotta a hozzáférést: ${msg}`, { kind: 'banned', retryAfter: banWait(msg) });
      throw new WebshopError(`Az UNAS bejelentkezés sikertelen (${msg}). Ellenőrizd az API kulcsot. Hibás kulccsal nem próbálkozunk újra, amíg nem módosítod.`, { kind: 'auth', status: res.status });
    }
    shopName = doc.text('WebshopInfo/WebshopName');
    const perms = doc.get('Permissions');
    permissions = perms ? perms.all('Permission').map((p) => p.text()) : null;
    const expireTime = Number(doc.text('ExpireTime'));
    await tokens.set(token, (Number.isFinite(expireTime) && expireTime > 0 ? expireTime * 1000 : Date.now() + 2 * 3600 * 1000) - 5 * 60 * 1000);
    return token;
  }

  async function call(action, endpoint, rootName, value) {
    for (const fresh of [false, true]) {
      const token = await login({ fresh });
      const res = await http(action, `${API}/${endpoint}`, {
        method: 'POST', headers: { ...XML_HEADERS, authorization: `Bearer ${token}` }, parse: 'text', retries: 1, body: buildXml(rootName, value),
      });
      const doc = parse(res.text);
      const err = errorText(doc, res.text);
      if (err) {
        if (/banned|tiltva|letilt/i.test(err)) throw new WebshopError(`Az UNAS ideiglenesen letiltotta a hozzáférést: ${err}`, { kind: 'banned', retryAfter: banWait(err) });
        // An expired or revoked token: log in again once.
        if (!fresh && /token|authori|unauthori/i.test(err)) {
          await tokens.set('', 0);
          continue;
        }
        if (/permission|jogosults/i.test(err)) throw new WebshopError(`Az UNAS API kulcsnak nincs joga ehhez (${endpoint}): ${err}`, { kind: 'config', status: res.status });
        throw new WebshopError(`UNAS hiba (${endpoint}): ${err}`, { status: res.status });
      }
      if (res.status < 200 || res.status >= 300) throw new WebshopError(`UNAS hiba (${endpoint}, ${res.status}).`, { status: res.status });
      return doc;
    }
    throw new WebshopError('Az UNAS nem fogadta el az új tokent sem.', { kind: 'auth' });
  }

  function normalize(o) {
    const key = o.text('Key');
    const statusName = o.text('Status');
    const statusId = o.text('StatusID');
    const statusType = o.text('StatusType');
    const base = { remoteId: key, externalId: o.text('Id') || key, number: key, updatedAt: fromBudapestLocal(o.text('DateMod')) || new Date().toISOString() };
    const match = (setting) => {
      const wanted = list(setting).map((s) => s.toLowerCase());
      return wanted.includes(statusName.toLowerCase()) || (statusId !== '' && wanted.includes(statusId.toLowerCase()));
    };
    if (statusType === 'close_fault' || match(settings.cancel_statuses)) {
      return remoteOrder(base, { state: 'cancelled', reason: `Törölt állapot az UNAS-ban (${statusName || statusType}).` });
    }
    const wanted = list(settings.import_statuses).length ? match(settings.import_statuses) : statusType === 'open_normal';
    if (!wanted) return remoteOrder(base, { state: 'skip', reason: `Állapot: ${statusName || statusType || 'ismeretlen'}.` });

    const ship = o.get('Customer/Addresses/Shipping');
    const inv = o.get('Customer/Addresses/Invoice');
    const contact = o.get('Customer/Contact');
    const t = (node, path) => (node ? node.text(path) : '');
    const pickup = t(ship, 'DeliveryPointID');
    const shipping = resolveShipping(settings, [o.text('Shipping/Name')], {
      hint: deliveryGroupCarrier(t(ship, 'DeliveryPointGroup')), mplMode: subGroupMplMode(t(ship, 'DeliveryPointSubGroup')), pickupPointId: pickup,
    });
    const payType = o.text('Payment/Type').toLowerCase();
    const cod = payType === 'cod' || isCod(settings, [o.text('Payment/Name'), payType]);
    const comments = [];
    const legacy = o.text('Customer/Comment');
    if (legacy) comments.push(legacy);
    for (const c of o.get('Comments') ? o.get('Comments').all('Comment') : []) {
      if (['customer', 'customer_shipping'].includes(c.text('Type')) && c.text('Text') && !comments.includes(c.text('Text'))) comments.push(c.text('Text'));
    }
    const input = orderInput({
      customer_name: (pickup ? t(ship, 'RecipientName') : '') || t(ship, 'Name') || t(inv, 'Name') || t(contact, 'Name'),
      email: o.text('Customer/Email'),
      phone: t(contact, 'Mobile') || t(contact, 'Phone'),
      country: t(ship, 'CountryCode') || t(inv, 'CountryCode'),
      zip: t(ship, 'ZIP'),
      city: t(ship, 'City'),
      address: t(ship, 'Street'),
      pickup_point_id: pickup,
      ...shipping,
      cod_amount: cod ? money(o.text('SumPriceGross')) : 0,
      currency: o.text('Currency'),
      note: comments.join('\n'),
      ordered_at: fromBudapestLocal(o.text('Date')),
    });
    const items = o.get('Items') ? o.get('Items').all('Item') : [];
    const { lines, problems } = orderLines(settings, items
      .filter((it) => !SPECIAL_ITEMS.has(it.text('Id')) && !SPECIAL_ITEMS.has(it.text('Sku')))
      .map((it) => ({ sku: it.text('Sku'), qty: Number(it.text('Quantity')), name: it.text('Name'), external_line_id: '' })));
    return remoteOrder(base, { input, lines, problems });
  }

  return {
    async test() {
      await login({ fresh: true });
      const missing = permissions ? ['getOrder', 'setOrder'].filter((p) => !permissions.includes(p)) : [];
      return `Kapcsolat rendben: ${shopName || 'UNAS webshop'}.${missing.length ? ` Figyelem, az API kulcsnak nincs joga: ${missing.join(', ')}.` : ''}`;
    },

    async listOrders({ since, page }) {
      const start = Number(page) || 0;
      const doc = await call('orders.list', 'getOrder', 'Params', {
        TimeModStart: Math.floor(since.getTime() / 1000) - 1, Order: 'modify_time_asc', LimitNum: PER_PAGE, LimitStart: start,
      });
      const nodes = doc.name === 'Orders' ? doc.all('Order') : [];
      return { orders: nodes.map(normalize), nextPage: nodes.length >= PER_PAGE ? start + PER_PAGE : null };
    },

    async fulfill(f) {
      const order = { Action: 'modify', Key: f.remoteId };
      if (settings.shipped_status) {
        order.Status = settings.shipped_status;
        order.StatusEmail = settings.status_email ? 'yes' : 'no';
      }
      if (f.trackingNumbers.length) {
        order.Shipping = { PackageNumber: f.trackingNumbers.join(', ') };
        if (f.trackingUrls[0]) order.Shipping.TrackingUrl = f.trackingUrls[0];
      }
      if (!order.Status && !order.Shipping) {
        throw new WebshopError('Nincs mit visszaküldeni az UNAS-ba: állítsd be a Feladott állapotot, vagy adj meg csomagszámot.', { kind: 'config' });
      }
      const doc = await call('order.update', 'setOrder', 'Orders', { Order: order });
      const res = doc.get('Order');
      if (!res || res.text('Status') !== 'ok') throw new WebshopError(`UNAS: ${(res && res.text('Error')) || 'a rendelés módosítása sikertelen'}.`, { kind: 'data' });
      return { message: 'Feladás visszaküldve az UNAS-ba.' };
    },

    async pushStock(items) {
      const out = { updated: [], missing: [], failed: [] };
      for (let i = 0; i < items.length; i += 100) {
        const chunk = items.slice(i, i + 100);
        const doc = await call('stock.set', 'setStock', 'Products', {
          Product: chunk.map((it) => ({ Action: 'modify', Sku: it.sku, Stocks: { Stock: { Qty: it.qty } } })),
        });
        const results = doc.name === 'Products' ? doc.all('Product') : [];
        for (const it of chunk) {
          const r = results.find((x) => x.text('Sku') === it.sku);
          if (r && r.text('Status') === 'ok') out.updated.push(it.sku);
          else if (r && /nem talál|not found|nincs ilyen|unknown/i.test(r.text('Error'))) out.missing.push(it.sku);
          else out.failed.push({ sku: it.sku, message: (r && r.text('Error')) || 'Nincs válasz erre a cikkszámra.' });
        }
      }
      return out;
    },
  };
}

// Two pages per sync at most (getOrder with several orders: 30 calls per hour on PREMIUM).
export const platform = { code: 'unas', name: 'UNAS', sorted: true, maxPages: 2, credentialFields, settingFields, connect };
