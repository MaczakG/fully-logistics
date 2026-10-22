// Shoprenter: Shoprenter API (https://doc.shoprenter.hu, sources: github.com/Shoprenter/sr-api-docs).
//
// Authentication: a custom API client created by the shop admin (Beállítások > API beállítások)
//   gets an access token with the client credentials grant:
//   POST https://oauth.app.shoprenter.net/{shopName}/app/token { grant_type, client_id, client_secret }
//   -> { token_type: "Bearer", expires_in: 3600, access_token }. Calls go to
//   https://{shopName}.api2.myshoprenter.hu/api/ with Authorization: Bearer <token>.
// Limits: 3 requests per second per application and shop (429 above that).
// Orders: GET /orderExtend?full=1&updatedAtMin=<Budapest local time>&page=&limit= (orders with
//   their products, country and currency in one call). No documented sort order, so the engine
//   pages through the whole window before it moves the cursor.
// Statuses: orderStatus links; names come from /orderStatusDescriptions.
// Fulfilment: PUT /orders/{id} { orderStatus: { id } }. The public API has no tracking number field;
//   optionally the tracking number is appended to the order comment.
// Stock: GET /products?sku=..., then PUT /products/{id} { stock1 }.

import {
  WebshopError, commonSettingFields, excerpt, fromBudapestLocal, isCod, joinParts, list, money, orderInput, orderLines, remoteOrder, resolveShipping,
  toBudapestLocal,
} from './common.js';

const PER_PAGE = 50;

export const credentialFields = [
  { key: 'client_id', label: 'API kliens azonosító (Client ID)', type: 'text', required: true,
    help: 'A bolt adminjában: Beállítások > API beállítások, egyedi API kliens. Jogosultságok: rendelések olvasása és írása, rendelési állapotok olvasása (készlethez termékek írása).' },
  { key: 'client_secret', label: 'API kliens titkos kulcs (Client secret)', type: 'password', required: true, help: 'Az API kliens létrehozásakor kapott titkos kulcs.' },
];

export const settingFields = [
  { key: 'import_statuses', label: 'Importált rendelési állapotok', type: 'text', required: false, default: '',
    help: 'Az állapotok neve vagy azonosítója vesszővel elválasztva (például: Feldolgozás alatt). Üresen minden befejezett, nem törölt rendelés bekerül.' },
  { key: 'cancel_statuses', label: 'Törölt rendelési állapotok', type: 'text', required: false, default: '',
    help: 'Azok az állapotok (név vagy azonosító), amelyek a rendelés visszavonását jelentik.' },
  { key: 'shipped_status', label: 'Feladott állapot', type: 'text', required: false, default: '',
    help: 'Erre az állapotra állítjuk a rendelést feladáskor (név vagy azonosító, például: Szállítás alatt). Enélkül nem tudjuk visszajelezni a feladást.' },
  { key: 'tracking_in_comment', label: 'Csomagszám beírása a megjegyzésbe', type: 'checkbox', required: false, default: false,
    help: 'A Shoprenter API-ban nincs csomagszám mező. Bekapcsolva a csomagszámot és a követési linket a rendelés megjegyzéséhez fűzzük.' },
  ...commonSettingFields({ codDefault: 'COD, COD2, COD3, COD4', carrierHelp: ', illetve a Shoprenter szállítási mód típusából' }),
];

// "boltneve", "boltneve.shoprenter.hu", "https://boltneve.api2.myshoprenter.hu/api" -> "boltneve"
export function shopName(shopUrl) {
  const host = String(shopUrl || '').trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  const m = host.match(/^([a-z0-9][a-z0-9-]*)(?:\.(?:api2?\.)?(?:my)?shoprenter\.hu)?$/);
  if (!m) throw new WebshopError('Add meg a Shoprenter bolt rövid nevét (például boltneve), nem a saját domaint.', { kind: 'config' });
  return m[1];
}

const tail = (href) => String(href || '').split('?')[0].split('/').pop();
const statusIdOf = (o) => (o.orderStatus ? o.orderStatus.id || tail(o.orderStatus.href) : '');

function decodeId(id) {
  try {
    return atob(id);
  } catch {
    return '';
  }
}

// Shoprenter shipping method types (shippingMethodExtension) to our carriers.
export function extensionCarrier(ext) {
  const e = String(ext || '').toUpperCase();
  if (e.startsWith('GLS') || e.startsWith('SHOPRENTERGOGLS')) return 'gls';
  if (e.startsWith('FOXPOST')) return 'foxpost';
  if (e.startsWith('MPL')) return 'mpl';
  if (e.startsWith('DPD')) return 'dpd';
  if (e.startsWith('DHL')) return 'dhl';
  return '';
}

// MPL delivery mode of the Shoprenter MPL shipping method types.
export function extensionMplMode(ext) {
  return { MPLPARCELMACHINE: 'CS', MPLPOSTPOINT: 'PP', MPLPOSTSTAY: 'PM' }[String(ext || '').toUpperCase()] || '';
}

const COUNTRY_NAMES = { hungary: 'HU', 'magyarország': 'HU', austria: 'AT', 'ausztria': 'AT', slovakia: 'SK', 'szlovákia': 'SK', romania: 'RO', 'románia': 'RO', germany: 'DE', 'németország': 'DE' };

export function connect({ shopUrl, credentials = {}, settings, http, tokens }) {
  const shop = shopName(shopUrl);
  const api = `https://${shop}.api2.myshoprenter.hu/api`;
  if (!credentials.client_id || !credentials.client_secret) {
    throw new WebshopError('Add meg a Shoprenter API kliens azonosítóját és titkos kulcsát.', { kind: 'config' });
  }

  async function accessToken({ fresh = false } = {}) {
    if (!fresh) {
      const cached = await tokens.get();
      if (cached && cached.token && cached.expiresAt > Date.now() + 60000) return cached.token;
    }
    const res = await http('oauth.token', `https://oauth.app.shoprenter.net/${shop}/app/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: credentials.client_id, client_secret: credentials.client_secret }),
    });
    if (res.status !== 200 || !res.data || !res.data.access_token) {
      const why = res.data && typeof res.data === 'object' ? res.data.message || res.data.error_description || res.data.error : excerpt(res.text, 200);
      throw new WebshopError(`A Shoprenter nem adott hozzáférési tokent (${res.status}${why ? `, ${why}` : ''}). Ellenőrizd az API kliens azonosítóját és titkos kulcsát.`, { kind: 'auth', status: res.status });
    }
    await tokens.set(res.data.access_token, Date.now() + (Number(res.data.expires_in) || 3600) * 1000 - 60000);
    return res.data.access_token;
  }

  async function request(action, path, { method = 'GET', query = {}, body, allow = [] } = {}) {
    const url = new URL(`${api}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let fresh = false;
    for (;;) {
      const token = await accessToken({ fresh });
      const res = await http(action, url.toString(), {
        method,
        // Content-Type is mandatory on every Shoprenter API request, JSON answers need Accept.
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 401 && !fresh) {
        fresh = true;
        continue;
      }
      if (allow.includes(res.status)) return res;
      const why = res.data && typeof res.data === 'object' ? res.data.message || res.data.error : excerpt(res.text, 200);
      if (res.status === 401 || res.status === 403) {
        throw new WebshopError(`A Shoprenter elutasította a kérést (${res.status}${why ? `, ${why}` : ''}). Ellenőrizd az API kliens jogosultságait.`, { kind: 'auth', status: res.status });
      }
      if (res.status < 200 || res.status >= 300) throw new WebshopError(`Shoprenter hiba (${res.status}): ${why || 'ismeretlen hiba'}.`, { status: res.status });
      if (!res.data || typeof res.data !== 'object') throw new WebshopError('A Shoprenter nem JSON választ adott.', { kind: 'data' });
      return res;
    }
  }

  // Status names -> ids, loaded once per connection run.
  let names = null;
  async function statusIds(text) {
    const tokensList = list(text);
    if (!tokensList.length) return null;
    const ids = new Set();
    for (const t of tokensList) {
      if (/^\d+$/.test(t)) {
        ids.add(btoa(`orderStatus-order_status_id=${t}`));
        continue;
      }
      if (decodeId(t).startsWith('orderStatus-')) {
        ids.add(t);
        continue;
      }
      if (!names) {
        names = new Map();
        const res = await request('statuses.list', '/orderStatusDescriptions', { query: { full: '1', limit: '200' } });
        for (const d of res.data.items || []) {
          const id = d.orderStatus ? d.orderStatus.id || tail(d.orderStatus.href) : '';
          if (d.name && id) names.set(String(d.name).trim().toLowerCase(), id);
        }
      }
      const id = names.get(t.toLowerCase());
      if (!id) throw new WebshopError(`Ismeretlen Shoprenter rendelési állapot: ${t}. Ellenőrizd a kapcsolat beállításait.`, { kind: 'config' });
      ids.add(id);
    }
    return ids;
  }

  function normalize(o, importIds, cancelIds) {
    const statusId = statusIdOf(o);
    const base = { remoteId: o.id, externalId: String(o.innerId || o.id), number: String(o.innerId || o.id), updatedAt: fromBudapestLocal(o.dateUpdated) || new Date().toISOString() };
    const statusNo = decodeId(statusId).split('=').pop() || statusId;
    if (!statusId) return remoteOrder(base, { state: 'skip', reason: 'Nincs állapota (befejezetlen rendelés).' });
    if (cancelIds && cancelIds.has(statusId)) return remoteOrder(base, { state: 'cancelled', reason: `Törölt állapot a Shoprenterben (${statusNo}).` });
    if (importIds && !importIds.has(statusId)) return remoteOrder(base, { state: 'skip', reason: `Állapot: ${statusNo}.` });
    const iso = o.shippingCountry && o.shippingCountry.isoCode2;
    const country = iso || COUNTRY_NAMES[String(o.shippingCountryName || '').trim().toLowerCase()] || '';
    const receivingPoint = o.shippingReceivingPointId && o.shippingReceivingPointId !== '0' ? o.shippingReceivingPointId : '';
    const ppp = String(o.shippingMethodExtension || '').toUpperCase() === 'PICKPACKPONT' ? o.pickPackPontShopCode : '';
    const pickupId = receivingPoint || ppp || '';
    const shipping = resolveShipping(settings, [o.shippingMethodLocalizedName, o.shippingMethodName], {
      hint: extensionCarrier(o.shippingMethodExtension), mplMode: extensionMplMode(o.shippingMethodExtension), pickupPointId: pickupId,
    });
    const cod = isCod(settings, [o.paymentMethodCode, o.paymentMethodName]);
    const input = orderInput({
      // Shoprenter stores the family name in firstname (Hungarian order), so this reads naturally.
      customer_name: joinParts(o.shippingFirstname, o.shippingLastname) || joinParts(o.firstname, o.lastname),
      company: o.shippingCompany,
      email: o.email,
      phone: o.phone,
      country,
      zip: o.shippingPostcode,
      city: o.shippingCity,
      address: [o.shippingAddress1, o.shippingAddress2].filter(Boolean).join(', '),
      pickup_point_id: pickupId,
      ...shipping,
      cod_amount: cod ? money(Number(o.total) * (Number(o.value) || 1)) : 0,
      currency: o.currency && typeof o.currency === 'object' ? o.currency.code : '',
      note: o.comment,
      ordered_at: fromBudapestLocal(o.dateCreated),
    });
    const products = Array.isArray(o.orderProducts) ? o.orderProducts : [];
    const { lines, problems } = orderLines(settings, products.map((p) => ({
      sku: p.sku,
      qty: ['stock1', 'stock2', 'stock3', 'stock4'].reduce((s, k) => s + (Number(p[k]) || 0), 0),
      name: p.name,
      external_line_id: p.innerId || p.id || '',
    })));
    return remoteOrder(base, { input, lines, problems });
  }

  return {
    async test() {
      await request('statuses.test', '/orderStatuses', { query: { page: '0', limit: '1' } });
      return `Kapcsolat rendben: ${shop} (Shoprenter).`;
    },

    async listOrders({ since, page }) {
      const importIds = await statusIds(settings.import_statuses);
      const cancelIds = await statusIds(settings.cancel_statuses);
      const p = Number(page) || 0;
      const res = await request('orders.list', '/orderExtend', {
        query: { full: '1', limit: String(PER_PAGE), page: String(p), updatedAtMin: toBudapestLocal(new Date(since.getTime() - 1000)), excludeAbandonedCart: '1', excludeStorno: '1' },
        allow: [400],
      });
      // 40008: "Page not found": an empty result has no pages at all.
      if (res.status === 400) {
        const msg = res.data && typeof res.data === 'object' ? JSON.stringify(res.data) : res.text;
        if (/40008|page not found/i.test(msg)) return { orders: [], nextPage: null };
        throw new WebshopError(`Shoprenter hiba (400): ${excerpt(msg, 200)}`, { status: 400 });
      }
      const items = Array.isArray(res.data.items) ? res.data.items : [];
      const pageCount = Number(res.data.pageCount);
      const hasNext = res.data.next ? true : Number.isFinite(pageCount) && p + 1 < pageCount;
      return { orders: items.map((o) => normalize(o, importIds, cancelIds)), nextPage: hasNext && items.length ? p + 1 : null };
    },

    async fulfill(f) {
      const shipped = await statusIds(settings.shipped_status);
      if (!shipped || !shipped.size) {
        throw new WebshopError('Állítsd be a Shoprenter kapcsolatnál a Feladott állapotot, enélkül nem tudjuk teljesítettre állítani a rendelést.', { kind: 'config' });
      }
      const statusId = [...shipped][0];
      const id = encodeURIComponent(f.remoteId);
      const current = await request('order.get', `/orders/${id}`);
      const body = {};
      if (statusIdOf(current.data) !== statusId) body.orderStatus = { id: statusId };
      if (settings.tracking_in_comment && f.trackingNumbers.length) {
        const comment = String(current.data.comment || '');
        if (!comment.includes(f.trackingNumbers[0])) {
          const links = f.trackingNumbers.map((n, i) => (f.trackingUrls[i] ? `${n} ${f.trackingUrls[i]}` : n)).join(', ');
          const line = `Csomagszám${f.carrierName ? ` (${f.carrierName})` : ''}: ${links}`;
          body.comment = comment ? `${comment}\n${line}` : line;
        }
      }
      if (!Object.keys(body).length) return { message: 'A rendelés már feladott állapotú volt a Shoprenterben.', already: true };
      await request('order.update', `/orders/${id}`, { method: 'PUT', body });
      return { message: 'Feladott állapotra állítva a Shoprenterben.' };
    },

    async pushStock(items) {
      const out = { updated: [], missing: [], failed: [] };
      for (const it of items) {
        const res = await request('stock.find', '/products', { query: { sku: it.sku, full: '1', limit: '5' } });
        const p = (res.data.items || []).find((x) => x.sku === it.sku);
        if (!p) {
          out.missing.push(it.sku);
          continue;
        }
        const id = p.id || tail(p.href);
        await request('stock.update', `/products/${encodeURIComponent(id)}`, { method: 'PUT', body: { stock1: String(it.qty) } });
        out.updated.push(it.sku);
      }
      return out;
    },
  };
}

// Unsorted results: the engine pages through the whole window, see index.js.
export const platform = { code: 'shoprenter', name: 'Shoprenter', sorted: false, minIntervalMs: 350, credentialFields, settingFields, connect };
