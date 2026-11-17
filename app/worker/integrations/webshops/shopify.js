// Shopify: GraphQL Admin API, version API_VERSION (supported until October 2027; move to a newer
// stable version once a year, see https://shopify.dev/docs/api/usage/versioning).
//
// Authentication (https://shopify.dev/docs/apps/build/authentication-authorization):
//   - apps created in the Dev Dashboard (the only kind that can still be created): the merchant
//     creates the app in their own organization, installs it on the store and gives us the client
//     ID and secret; we get a 24 hour token with the client credentials grant
//     POST https://{shop}.myshopify.com/admin/oauth/access_token
//   - older apps created in the Shopify admin: the Admin API access token (shpat_...).
//   Every request sends the token in X-Shopify-Access-Token.
// Scopes: read_orders, read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders
//   (and read_products, read_inventory, write_inventory for the stock sync).
//
// Orders: orders(query: "updated_at:>='...'", sortKey: UPDATED_AT) with cursor pagination.
// Fulfilment: order.fulfillmentOrders (those that support CREATE_FULFILLMENT), then one
//   fulfillmentCreate per assigned location with trackingInfo { company, number, url }.
// Stock: productVariants by SKU, then inventorySetQuantities (name "available") at the configured
//   location, with the @idempotent directive that 2026-04 and later require.

import {
  WebshopError, commonSettingFields, isCod, isoSeconds, joinParts, list, money, orderInput, orderLines, remoteOrder, resolveShipping,
} from './common.js';

export const API_VERSION = '2026-10';

// Orders per page: 10 orders x 50 line items stays well under the 1000 point single query limit.
const PAGE = 10;

const ADDRESS = 'name firstName lastName company address1 address2 city zip countryCodeV2 phone';

export const ORDERS_QUERY = `query FlOrders($first: Int!, $after: String, $query: String!) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id legacyResourceId name createdAt updatedAt cancelledAt test
      displayFinancialStatus displayFulfillmentStatus
      email phone note paymentGatewayNames presentmentCurrencyCode
      customAttributes { key value }
      totalOutstandingSet { presentmentMoney { amount currencyCode } }
      shippingAddress { ${ADDRESS} }
      billingAddress { name phone }
      shippingLine { title code }
      lineItems(first: 50) {
        pageInfo { hasNextPage endCursor }
        nodes { id sku name quantity currentQuantity requiresShipping }
      }
    }
  }
}`;

export const LINES_QUERY = `query FlOrderLines($id: ID!, $after: String) {
  order(id: $id) {
    lineItems(first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id sku name quantity currentQuantity requiresShipping }
    }
  }
}`;

export const FULFILLMENT_ORDERS_QUERY = `query FlFulfillmentOrders($id: ID!) {
  order(id: $id) {
    id displayFulfillmentStatus
    fulfillmentOrders(first: 20) {
      nodes { id status assignedLocation { location { id } } supportedActions { action } }
    }
  }
}`;

export const FULFILLMENT_CREATE = `mutation FlFulfillmentCreate($fulfillment: FulfillmentInput!) {
  fulfillmentCreate(fulfillment: $fulfillment) {
    fulfillment { id status }
    userErrors { field message }
  }
}`;

export const VARIANTS_QUERY = `query FlVariants($query: String!) {
  productVariants(first: 100, query: $query) {
    nodes { sku inventoryItem { id tracked } }
  }
}`;

const STOCK_MUTATION = (key) => `mutation FlSetStock($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) @idempotent(key: "${key}") {
    userErrors { field message code }
  }
}`;

// Names Shopify knows (it builds the tracking link itself for those it supports).
const COMPANY = { gls: 'GLS', dpd: 'DPD', dhl: 'DHL Express', mpl: 'Magyar Posta', foxpost: 'Foxpost' };

export const credentialFields = [
  { key: 'client_id', label: 'Ügyfélazonosító (Client ID)', type: 'text', required: false,
    help: 'Dev Dashboard alkalmazásnál: az alkalmazás Beállítások oldalán, a Hitelesítő adatok kártyán.' },
  { key: 'client_secret', label: 'Titkos kulcs (Client secret)', type: 'password', required: false,
    help: 'Ugyanott, mint az ügyfélazonosító. A titkos kulcsból 24 órás hozzáférési tokent kérünk.' },
  { key: 'access_token', label: 'Admin API hozzáférési token (régi alkalmazásnál)', type: 'password', required: false,
    help: 'Csak a korábban a Shopify adminban létrehozott egyedi alkalmazásnál (shpat_ kezdetű). Ilyenkor az ügyfélazonosító és a titkos kulcs üresen maradhat.' },
];

export const settingFields = [
  { key: 'import_statuses', label: 'Importált fizetési állapotok', type: 'text', required: false, default: 'paid, authorized',
    help: 'Vesszővel elválasztva: paid, authorized, partially_paid, pending. Az utánvétes rendelések fizetés előtt (pending) is bekerülnek.' },
  { key: 'pickup_point_attribute', label: 'Csomagpont azonosító mező', type: 'text', required: false, default: '',
    help: 'Ha a csomagpontválasztó alkalmazás a rendelés további adatai (note attributes) között adja át a csomagpont azonosítót, add meg a mező nevét.' },
  { key: 'notify_customer', label: 'Vásárló értesítése feladáskor', type: 'checkbox', required: false, default: true,
    help: 'A Shopify elküldi a vásárlónak a szállítási értesítőt a csomagszámmal.' },
  { key: 'stock_location_id', label: 'Shopify helyszín azonosító (készlethez)', type: 'text', required: false, default: '',
    help: 'Csak a készlet visszaküldéséhez: a raktárunkat jelentő Shopify helyszín azonosítója (szám vagy gid://shopify/Location/...).' },
  ...commonSettingFields({ codDefault: 'Cash on Delivery (COD), Utánvét' }),
];

// "https://bolt.myshopify.com/admin" or "bolt" -> "bolt.myshopify.com"
export function shopDomain(shopUrl) {
  let host = String(shopUrl || '').trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  if (host && !host.includes('.')) host = `${host}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host)) {
    throw new WebshopError('A Shopify bolt címe a .myshopify.com végű cím legyen (például boltod.myshopify.com).', { kind: 'config' });
  }
  return host;
}

const gidTail = (gid) => String(gid || '').split('/').pop();

export function connect({ shopUrl, credentials = {}, settings, http, tokens, sleep }) {
  const domain = shopDomain(shopUrl);
  const endpoint = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;

  async function accessToken({ fresh = false } = {}) {
    if (credentials.access_token) return credentials.access_token;
    if (!credentials.client_id || !credentials.client_secret) {
      throw new WebshopError('Add meg a Shopify alkalmazás ügyfélazonosítóját és titkos kulcsát (vagy a régi Admin API tokent).', { kind: 'config' });
    }
    if (!fresh) {
      const cached = await tokens.get();
      if (cached && cached.token && cached.expiresAt > Date.now() + 60000) return cached.token;
    }
    const res = await http('oauth.token', `https://${domain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: credentials.client_id, client_secret: credentials.client_secret }).toString(),
    });
    if (res.status === 404) throw new WebshopError(`A Shopify bolt nem található: ${domain}.`, { kind: 'config', status: 404 });
    if (res.status !== 200 || !res.data || !res.data.access_token) {
      const why = res.data && typeof res.data === 'object' ? res.data.error_description || res.data.error || res.data.errors : '';
      throw new WebshopError(`A Shopify nem adott hozzáférési tokent${why ? ` (${String(why).slice(0, 200)})` : ''}. Ellenőrizd az ügyfélazonosítót, a titkos kulcsot, és hogy az alkalmazás telepítve van-e a boltban.`, { kind: 'auth', status: res.status });
    }
    const expiresIn = Number(res.data.expires_in) || 86399;
    await tokens.set(res.data.access_token, Date.now() + expiresIn * 1000 - 120000);
    return res.data.access_token;
  }

  async function graphql(action, query, variables) {
    let fresh = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await accessToken({ fresh });
      const res = await http(action, endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-shopify-access-token': token },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 401) {
        // An expired client credentials token: get a new one once.
        if (!credentials.access_token && !fresh) {
          fresh = true;
          continue;
        }
        throw new WebshopError('A Shopify elutasította a hozzáférési tokent (401). Ellenőrizd a hitelesítő adatokat.', { kind: 'auth', status: 401 });
      }
      if (res.status === 402) throw new WebshopError('A Shopify bolt fizetési probléma miatt zárolva van (402).', { status: 402 });
      if (res.status === 403) throw new WebshopError('A Shopify megtagadta a hozzáférést (403). Ellenőrizd az alkalmazás jogosultságait.', { kind: 'auth', status: 403 });
      if (res.status === 404) throw new WebshopError(`A Shopify bolt nem található: ${domain}.`, { kind: 'config', status: 404 });
      if (res.status === 423) throw new WebshopError('A Shopify bolt zárolva van (423).', { status: 423 });
      if (res.status !== 200 || !res.data || typeof res.data !== 'object') throw new WebshopError(`Váratlan Shopify válasz (${res.status}).`, { kind: 'data', status: res.status });
      const errors = typeof res.data.errors === 'string' ? [{ message: res.data.errors }] : res.data.errors;
      if (errors && errors.length) {
        if (errors.some((e) => e.extensions && e.extensions.code === 'THROTTLED')) {
          const cost = res.data.extensions && res.data.extensions.cost;
          if (attempt < 2) {
            const need = cost ? (cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable) / (cost.throttleStatus.restoreRate || 50) : 2;
            await sleep(Math.min(Math.max(need, 1), 10) * 1000);
            continue;
          }
          throw new WebshopError('A Shopify lassításra kért (THROTTLED). Később folytatjuk.', { kind: 'rate' });
        }
        const denied = errors.find((e) => e.extensions && e.extensions.code === 'ACCESS_DENIED');
        if (denied) throw new WebshopError(`Hiányzó Shopify jogosultság: ${String(denied.message).slice(0, 300)}`, { kind: 'config' });
        throw new WebshopError(`Shopify hiba: ${errors.map((e) => e.message).join('; ').slice(0, 500)}`, { kind: 'data' });
      }
      return res.data.data || {};
    }
    throw new WebshopError('A Shopify kérés sikertelen.', { kind: 'data' });
  }

  function normalize(node, items) {
    const base = { remoteId: node.id, externalId: String(node.legacyResourceId || gidTail(node.id)), number: node.name || '', updatedAt: new Date(node.updatedAt).toISOString() };
    if (node.cancelledAt) return remoteOrder(base, { state: 'cancelled', reason: 'Törölve a Shopifyban.' });
    if (node.test) return remoteOrder(base, { state: 'skip', reason: 'Teszt rendelés.' });
    if (node.displayFulfillmentStatus === 'FULFILLED') return remoteOrder(base, { state: 'skip', reason: 'Már teljesítve a webshopban.' });
    const financial = String(node.displayFinancialStatus || '').toLowerCase();
    const cod = isCod(settings, node.paymentGatewayNames || []);
    const allowed = list(settings.import_statuses).map((s) => s.toLowerCase());
    if (!allowed.includes(financial) && !(cod && financial === 'pending')) {
      return remoteOrder(base, { state: 'skip', reason: `Fizetési állapot: ${financial || 'ismeretlen'}.` });
    }
    const ship = node.shippingAddress || {};
    const bill = node.billingAddress || {};
    const attr = settings.pickup_point_attribute.toLowerCase();
    const pickup = attr ? (node.customAttributes || []).find((a) => String(a.key).toLowerCase() === attr) : null;
    const money2 = node.totalOutstandingSet && node.totalOutstandingSet.presentmentMoney;
    const line = node.shippingLine || {};
    const pickupId = pickup ? pickup.value : '';
    const shipping = resolveShipping(settings, [line.title, line.code], { pickupPointId: pickupId });
    const input = orderInput({
      customer_name: ship.name || joinParts(ship.firstName, ship.lastName) || bill.name || node.email,
      company: ship.company,
      email: node.email,
      phone: ship.phone || node.phone || bill.phone,
      country: ship.countryCodeV2,
      zip: ship.zip,
      city: ship.city,
      address: [ship.address1, ship.address2].filter(Boolean).join(', '),
      pickup_point_id: pickupId,
      ...shipping,
      cod_amount: cod ? money(money2 && money2.amount) : 0,
      currency: (money2 && money2.currencyCode) || node.presentmentCurrencyCode,
      note: node.note,
      ordered_at: node.createdAt ? new Date(node.createdAt).toISOString() : null,
    });
    const shippable = items.filter((i) => i.requiresShipping !== false);
    const { lines, problems } = orderLines(settings, shippable.map((i) => ({
      sku: i.sku, qty: i.currentQuantity ?? i.quantity, name: i.name, external_line_id: gidTail(i.id),
    })));
    return remoteOrder(base, { input, lines, problems });
  }

  return {
    async test() {
      const data = await graphql('shop', '{ shop { name myshopifyDomain } }', {});
      return `Kapcsolat rendben: ${data.shop ? data.shop.name : domain} (${domain}).`;
    },

    async listOrders({ since, page }) {
      const data = await graphql('orders.list', ORDERS_QUERY, { first: PAGE, after: page || null, query: `updated_at:>='${isoSeconds(since)}'` });
      const conn = data.orders || { nodes: [], pageInfo: {} };
      const orders = [];
      for (const node of conn.nodes) {
        let items = node.lineItems ? node.lineItems.nodes : [];
        let info = node.lineItems ? node.lineItems.pageInfo : null;
        while (info && info.hasNextPage) {
          const more = await graphql('orders.lines', LINES_QUERY, { id: node.id, after: info.endCursor });
          const li = more.order && more.order.lineItems;
          if (!li) break;
          items = items.concat(li.nodes);
          info = li.pageInfo;
        }
        orders.push(normalize(node, items));
      }
      return { orders, nextPage: conn.pageInfo && conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null };
    },

    // f: { remoteId, trackingNumbers: [], trackingUrls: [], carrierCode, carrierName }
    async fulfill(f) {
      const data = await graphql('fulfillment.orders', FULFILLMENT_ORDERS_QUERY, { id: f.remoteId });
      if (!data.order) throw new WebshopError('A rendelés nem található a Shopifyban.', { kind: 'data', status: 404 });
      const open = data.order.fulfillmentOrders.nodes.filter((fo) => (fo.supportedActions || []).some((a) => a.action === 'CREATE_FULFILLMENT'));
      if (!open.length) {
        if (data.order.displayFulfillmentStatus === 'FULFILLED') return { message: 'A rendelés már teljesítve volt a Shopifyban.', already: true };
        throw new WebshopError('A Shopify rendelésen nincs teljesíthető tétel (visszatartott, vagy egy másik szolgáltatóhoz rendelt).', { kind: 'data' });
      }
      // One fulfillmentCreate per location: Shopify requires the same assigned location.
      const groups = new Map();
      for (const fo of open) {
        const loc = fo.assignedLocation && fo.assignedLocation.location ? fo.assignedLocation.location.id : '';
        if (!groups.has(loc)) groups.set(loc, []);
        groups.get(loc).push({ fulfillmentOrderId: fo.id });
      }
      const company = COMPANY[f.carrierCode] || f.carrierName || undefined;
      const numbers = f.trackingNumbers;
      let trackingInfo;
      if (numbers.length === 1) {
        trackingInfo = { company, number: numbers[0] };
        if (f.trackingUrls[0]) trackingInfo.url = f.trackingUrls[0];
      } else if (numbers.length > 1) {
        trackingInfo = { company, numbers };
        if (f.trackingUrls.every(Boolean)) trackingInfo.urls = f.trackingUrls;
      }
      for (const lineItemsByFulfillmentOrder of groups.values()) {
        const fulfillment = { lineItemsByFulfillmentOrder, notifyCustomer: settings.notify_customer };
        if (trackingInfo) fulfillment.trackingInfo = trackingInfo;
        const out = await graphql('fulfillment.create', FULFILLMENT_CREATE, { fulfillment });
        const errs = out.fulfillmentCreate ? out.fulfillmentCreate.userErrors : [];
        if (errs && errs.length) throw new WebshopError(`Shopify: ${errs.map((e) => e.message).join('; ').slice(0, 500)}`, { kind: 'data' });
      }
      return { message: 'Teljesítve a Shopifyban.' };
    },

    // items: [{ sku, qty }] -> { updated: [sku], missing: [sku], failed: [{ sku, message }] }
    async pushStock(items) {
      const raw = settings.stock_location_id;
      if (!raw) throw new WebshopError('A készlet visszaküldéséhez add meg a Shopify helyszín azonosítóját a kapcsolat beállításaiban.', { kind: 'config' });
      const locationId = /^\d+$/.test(raw) ? `gid://shopify/Location/${raw}` : raw;
      const out = { updated: [], missing: [], failed: [] };
      for (let i = 0; i < items.length; i += 25) {
        const chunk = items.slice(i, i + 25);
        const query = chunk.map((it) => `sku:"${String(it.sku).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(' OR ');
        const data = await graphql('stock.variants', VARIANTS_QUERY, { query });
        const bySku = new Map();
        for (const v of (data.productVariants && data.productVariants.nodes) || []) {
          if (!v.inventoryItem) continue;
          if (!bySku.has(v.sku)) bySku.set(v.sku, []);
          bySku.get(v.sku).push(v.inventoryItem);
        }
        const quantities = [];
        const sent = [];
        for (const it of chunk) {
          const inv = bySku.get(it.sku);
          if (!inv) {
            out.missing.push(it.sku);
            continue;
          }
          if (!inv.some((x) => x.tracked)) {
            out.failed.push({ sku: it.sku, message: 'A Shopifyban nincs bekapcsolva a készletkövetés.' });
            continue;
          }
          for (const x of inv.filter((y) => y.tracked)) quantities.push({ inventoryItemId: x.id, locationId, quantity: it.qty, changeFromQuantity: null });
          sent.push(it.sku);
        }
        if (!quantities.length) continue;
        const res = await graphql('stock.set', STOCK_MUTATION(crypto.randomUUID()), { input: { name: 'available', reason: 'correction', quantities } });
        const errs = res.inventorySetQuantities ? res.inventorySetQuantities.userErrors : [];
        if (errs && errs.length) {
          const message = errs.map((e) => e.message).join('; ').slice(0, 300);
          for (const sku of sent) out.failed.push({ sku, message });
        } else out.updated.push(...sent);
      }
      return out;
    },
  };
}

export const platform = { code: 'shopify', name: 'Shopify', sorted: true, credentialFields, settingFields, connect };
