// WooCommerce: REST API v3 (https://woocommerce.github.io/woocommerce-rest-api-docs/).
//
// Authentication: consumer key and secret over HTTPS with HTTP Basic auth, or as consumer_key /
//   consumer_secret query parameters for servers that drop the Authorization header.
// Orders: GET /wp-json/wc/v3/orders?modified_after=...&dates_are_gmt=true&orderby=modified&order=asc
//   with page and per_page; X-WP-TotalPages tells the number of pages.
// Fulfilment: PUT /wp-json/wc/v3/orders/<id> { status: "completed" }, a customer note
//   POST /wp-json/wc/v3/orders/<id>/notes { note, customer_note: true }, and optionally the official
//   Shipment Tracking extension: POST /wp-json/wc-shipment-tracking/v3/orders/<id>/shipment-trackings.
// Stock: GET /wp-json/wc/v3/products?sku=..., then POST /wp-json/wc/v3/products/batch
//   { update: [{ id, manage_stock: true, stock_quantity }] } (variations through
//   /products/<parent>/variations/batch when the product found is a variation).
// Pickup points: the meta key the pickup point plugin writes to the order (default
//   "_vp_woo_pont_point_id", the "Csomagpontok és Címkék WooCommerce-hez" plugin, which also
//   writes the provider to "_vp_woo_pont_provider").

import {
  WebshopError, commonSettingFields, excerpt, isCod, isoSeconds, joinParts, list, money, orderInput, orderLines, remoteOrder, resolveShipping,
} from './common.js';
import { budapestDate } from '../../lib/time.js';

const PER_PAGE = 50;
const CANCELLED = ['cancelled', 'refunded', 'failed', 'trash'];

export const credentialFields = [
  { key: 'consumer_key', label: 'Consumer key', type: 'text', required: true,
    help: 'WooCommerce > Beállítások > Haladó > REST API: új kulcs olvasási és írási joggal (ck_ kezdetű).' },
  { key: 'consumer_secret', label: 'Consumer secret', type: 'password', required: true, help: 'A kulcs létrehozásakor egyszer látható (cs_ kezdetű).' },
];

export const settingFields = [
  { key: 'import_statuses', label: 'Importált rendelési állapotok', type: 'text', required: false, default: 'processing',
    help: 'Vesszővel elválasztva: pending, processing, on-hold, completed. Alapból csak a feldolgozás alatti (processing) rendelések jönnek.' },
  { key: 'pickup_point_meta', label: 'Csomagpont azonosító meta kulcs', type: 'text', required: false, default: '_vp_woo_pont_point_id',
    help: 'A rendelés meta mezője, amelybe a csomagpontválasztó bővítmény az azonosítót írja. A Csomagpontok és Címkék WooCommerce-hez bővítménynél: _vp_woo_pont_point_id.' },
  { key: 'complete_order', label: 'Rendelés teljesítettre állítása feladáskor', type: 'checkbox', required: false, default: true,
    help: 'Feladáskor a rendelés állapota completed lesz (a WooCommerce ilyenkor e-mailt küldhet a vásárlónak).' },
  { key: 'customer_note', label: 'Vásárlói megjegyzés a csomagszámmal', type: 'checkbox', required: false, default: true,
    help: 'A csomagszámot és a nyomkövetési linket vásárlói megjegyzésként a rendeléshez írjuk (a vásárló e-mailben is megkapja).' },
  { key: 'shipment_tracking', label: 'Shipment Tracking bővítmény használata', type: 'checkbox', required: false, default: false,
    help: 'Ha a webshopban fut a hivatalos WooCommerce Shipment Tracking bővítmény, a csomagszámot oda is beírjuk.' },
  { key: 'query_auth', label: 'Hitelesítés URL paraméterben', type: 'checkbox', required: false, default: false,
    help: 'Csak akkor kapcsold be, ha a szerver nem engedi át az Authorization fejlécet (Consumer key is missing hiba).' },
  ...commonSettingFields({ codDefault: 'cod', carrierHelp: ', illetve a csomagpont bővítmény szolgáltatójából' }),
];

// "webshop.hu/" -> "https://webshop.hu"; only HTTPS (the keys travel in every request).
export function shopBase(shopUrl) {
  let s = String(shopUrl || '').trim();
  if (!s) throw new WebshopError('Add meg a webshop címét.', { kind: 'config' });
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new WebshopError('A webshop címe nem érvényes URL.', { kind: 'config' });
  }
  if (u.protocol !== 'https:') throw new WebshopError('A WooCommerce kulcsokat csak HTTPS-en küldjük. Add meg a webshop https:// kezdetű címét.', { kind: 'config' });
  const path = u.pathname.replace(/\/wp-json(\/.*)?$/, '').replace(/\/+$/, '');
  return `https://${u.host}${path}`;
}

const gmt = (s) => (s ? new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`).toISOString() : null);

const metaValue = (meta, key) => {
  if (!key) return '';
  const m = (meta || []).find((x) => x && x.key === key);
  return m && (typeof m.value === 'string' || typeof m.value === 'number') ? String(m.value) : '';
};

// Provider ids of the pickup point plugin ("foxpost_foxpost", "gls_locker" ...) to our carriers.
export function providerCarrier(provider) {
  const p = String(provider || '').toLowerCase();
  if (p.startsWith('postapont')) return 'mpl';
  if (p.startsWith('foxpost')) return 'foxpost';
  if (p.startsWith('gls')) return 'gls';
  if (p.startsWith('dpd')) return 'dpd';
  return '';
}

// MPL delivery mode of the plugin's MPL providers (postán maradó, csomagautomata, PostaPont).
export function providerMplMode(provider) {
  return { postapont_posta: 'PM', postapont_automata: 'CS', postapont_postapont: 'PP' }[String(provider || '').toLowerCase()] || '';
}

export function connect({ shopUrl, credentials = {}, settings, http }) {
  const base = shopBase(shopUrl);
  if (!credentials.consumer_key || !credentials.consumer_secret) {
    throw new WebshopError('Add meg a WooCommerce consumer key és consumer secret értékét.', { kind: 'config' });
  }

  async function request(action, path, { method = 'GET', query = {}, body } = {}) {
    const url = new URL(`${base}/wp-json/${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const headers = { accept: 'application/json' };
    if (settings.query_auth) {
      url.searchParams.set('consumer_key', credentials.consumer_key);
      url.searchParams.set('consumer_secret', credentials.consumer_secret);
    } else {
      headers.authorization = `Basic ${btoa(`${credentials.consumer_key}:${credentials.consumer_secret}`)}`;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await http(action, url.toString(), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const err = res.data && typeof res.data === 'object' && !Array.isArray(res.data) ? res.data : {};
    const why = err.message ? `${err.code ? `${err.code}: ` : ''}${err.message}` : excerpt(res.text, 200);
    if (res.status === 401 || res.status === 403) {
      throw new WebshopError(`A WooCommerce elutasította a kérést (${res.status}${why ? `, ${why}` : ''}). A kulcsnak olvasási és írási joga is legyen.`, { kind: 'auth', status: res.status });
    }
    if (res.status === 404 && err.code === 'rest_no_route') {
      throw new WebshopError('A WooCommerce REST API nem érhető el ezen a címen. Ellenőrizd a webshop címét és hogy a WordPress közvetlen hivatkozásai (permalink) be vannak-e kapcsolva.', { kind: 'config', status: 404 });
    }
    if (res.status < 200 || res.status >= 300) throw new WebshopError(`WooCommerce hiba (${res.status}): ${why || 'ismeretlen hiba'}.`, { status: res.status });
    if (res.data === null || typeof res.data !== 'object') {
      throw new WebshopError('A webshop nem JSON választ adott. Ellenőrizd a címet, vagy hogy tűzfal nem blokkolja-e a kéréseinket.', { kind: 'data', status: res.status });
    }
    return res;
  }

  function normalize(o) {
    const base2 = { remoteId: String(o.id), externalId: String(o.id), number: String(o.number || o.id), updatedAt: gmt(o.date_modified_gmt) || new Date().toISOString() };
    if (CANCELLED.includes(o.status)) return remoteOrder(base2, { state: 'cancelled', reason: `Törölve a WooCommerce-ben (${o.status}).` });
    if (!list(settings.import_statuses).map((s) => s.toLowerCase()).includes(o.status)) {
      return remoteOrder(base2, { state: 'skip', reason: `Állapot: ${o.status}.` });
    }
    const ship = o.shipping || {};
    const bill = o.billing || {};
    const addr = ship.address_1 || ship.city || ship.postcode ? ship : bill;
    const country = addr.country || bill.country || '';
    // WooCommerce prints Hungarian names family name first.
    const name = (a) => (String(country).toUpperCase() === 'HU' ? joinParts(a.last_name, a.first_name) : joinParts(a.first_name, a.last_name));
    const method = (o.shipping_lines || [])[0] || {};
    const provider = metaValue(o.meta_data, '_vp_woo_pont_provider');
    const pickupId = metaValue(o.meta_data, settings.pickup_point_meta);
    const shipping = resolveShipping(settings, [method.method_title, method.method_id], { hint: providerCarrier(provider), mplMode: providerMplMode(provider), pickupPointId: pickupId });
    const cod = isCod(settings, [o.payment_method, o.payment_method_title]);
    const input = orderInput({
      customer_name: name(addr) || name(bill),
      company: addr.company || bill.company,
      email: bill.email,
      phone: ship.phone || bill.phone,
      country,
      zip: addr.postcode,
      city: addr.city,
      address: [addr.address_1, addr.address_2].filter(Boolean).join(', '),
      pickup_point_id: pickupId,
      ...shipping,
      cod_amount: cod ? money(o.total) : 0,
      currency: o.currency,
      note: o.customer_note,
      ordered_at: gmt(o.date_created_gmt),
    });
    const { lines, problems } = orderLines(settings, (o.line_items || []).map((li) => ({
      sku: li.sku, qty: li.quantity, name: li.name, external_line_id: String(li.id ?? ''),
    })));
    return remoteOrder(base2, { input, lines, problems });
  }

  return {
    async test() {
      const res = await request('orders.test', 'wc/v3/orders', { query: { per_page: '1' } });
      const total = res.headers.get('x-wp-total');
      return `Kapcsolat rendben: ${new URL(base).host}${total ? `, ${total} rendelés látható` : ''}.`;
    },

    async listOrders({ since, page }) {
      const p = Number(page) || 1;
      // modified_after is exclusive: start one second earlier, re-read orders are skipped anyway.
      const after = isoSeconds(new Date(since.getTime() - 1000)).replace(/Z$/, '');
      const res = await request('orders.list', 'wc/v3/orders', {
        query: { modified_after: after, dates_are_gmt: 'true', orderby: 'modified', order: 'asc', per_page: String(PER_PAGE), page: String(p) },
      });
      if (!Array.isArray(res.data)) throw new WebshopError('A WooCommerce rendelés lista nem tömb.', { kind: 'data' });
      const pages = Number(res.headers.get('x-wp-totalpages')) || 1;
      return { orders: res.data.map(normalize), nextPage: p < pages ? p + 1 : null };
    },

    async fulfill(f) {
      const id = encodeURIComponent(f.remoteId);
      const current = await request('order.get', `wc/v3/orders/${id}`);
      if (CANCELLED.includes(current.data.status)) {
        throw new WebshopError(`A rendelés a webshopban ${current.data.status} állapotú, nem állítható teljesítettre.`, { kind: 'data' });
      }
      const numbers = f.trackingNumbers;
      if (settings.shipment_tracking && numbers.length) {
        const existing = await request('tracking.list', `wc-shipment-tracking/v3/orders/${id}/shipment-trackings`);
        const have = new Set((Array.isArray(existing.data) ? existing.data : []).map((t) => String(t.tracking_number)));
        for (let i = 0; i < numbers.length; i++) {
          if (have.has(numbers[i])) continue;
          const body = { tracking_number: numbers[i], custom_tracking_provider: f.carrierName, date_shipped: budapestDate() };
          if (f.trackingUrls[i]) body.custom_tracking_link = f.trackingUrls[i];
          await request('tracking.create', `wc-shipment-tracking/v3/orders/${id}/shipment-trackings`, { method: 'POST', body });
        }
      }
      if (settings.customer_note && numbers.length) {
        const notes = await request('notes.list', `wc/v3/orders/${id}/notes`, { query: { type: 'customer' } });
        const already = (Array.isArray(notes.data) ? notes.data : []).some((n) => numbers.every((num) => String(n.note || '').includes(num)));
        if (!already) {
          const links = numbers.map((num, i) => (f.trackingUrls[i] ? `${num} (${f.trackingUrls[i]})` : num)).join(', ');
          const note = `A csomagodat feladtuk${f.carrierName ? `, futár: ${f.carrierName}` : ''}. Csomagszám: ${links}`;
          await request('notes.create', `wc/v3/orders/${id}/notes`, { method: 'POST', body: { note, customer_note: true } });
        }
      }
      if (settings.complete_order && current.data.status !== 'completed') {
        await request('order.complete', `wc/v3/orders/${id}`, { method: 'PUT', body: { status: 'completed' } });
      }
      return { message: 'Teljesítve a WooCommerce-ben.' };
    },

    async pushStock(items) {
      const out = { updated: [], missing: [], failed: [] };
      const simple = [];
      const variations = new Map();
      for (const it of items) {
        const res = await request('stock.find', 'wc/v3/products', { query: { sku: it.sku, per_page: '5' } });
        const p = (Array.isArray(res.data) ? res.data : []).find((x) => x.sku === it.sku);
        if (!p) {
          out.missing.push(it.sku);
          continue;
        }
        if (p.type === 'variable') {
          out.failed.push({ sku: it.sku, message: 'Változatos termék: a változatok cikkszámára küldjük a készletet.' });
          continue;
        }
        const row = { id: p.id, manage_stock: true, stock_quantity: it.qty };
        if (p.type === 'variation' && p.parent_id) {
          if (!variations.has(p.parent_id)) variations.set(p.parent_id, []);
          variations.get(p.parent_id).push({ row, sku: it.sku });
        } else simple.push({ row, sku: it.sku });
      }
      const send = async (path, group) => {
        for (let i = 0; i < group.length; i += 100) {
          const chunk = group.slice(i, i + 100);
          const res = await request('stock.batch', path, { method: 'POST', body: { update: chunk.map((c) => c.row) } });
          const results = Array.isArray(res.data.update) ? res.data.update : [];
          for (const c of chunk) {
            const r = results.find((x) => x && x.id === c.row.id);
            if (r && r.error) out.failed.push({ sku: c.sku, message: String(r.error.message || 'hiba').slice(0, 200) });
            else out.updated.push(c.sku);
          }
        }
      };
      if (simple.length) await send('wc/v3/products/batch', simple);
      for (const [parent, group] of variations) await send(`wc/v3/products/${parent}/variations/batch`, group);
      return out;
    },
  };
}

export const platform = { code: 'woocommerce', name: 'WooCommerce', sorted: true, credentialFields, settingFields, connect };
