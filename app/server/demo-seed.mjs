// Demo data, so every screen of the app can be tried on the live server: three clients, two
// carriers and a supplier, locations, products, inbounds in every state, orders in every status,
// picking waves, carrier pickups, an inventory count, quotes and billing.
//
// Everything is created through the app's own HTTP API, in process, with a short lived session of
// an administrator: the stock ledger, running numbers, statuses and the activity log stay exactly
// as if somebody had clicked through the app. Direct SQL is only used where no endpoint exists
// (the demo_data setting, and removing the demo again).
//
// Demo rows are marked: partner codes and product SKUs start with DEMO-, and the setting
// demo_data ({ created_at, location_ids }) remembers the locations the seeder created. The seeder
// does nothing when a DEMO- partner already exists.
//
//   node server/demo-seed.mjs            create the demo data
//   node server/demo-seed.mjs --remove   delete the demo data again (real data stays untouched,
//                                        the activity log keeps its rows)
//
// DB_PATH, FILES_* and the other settings come from the environment (server/config.mjs), the same
// way server/index.mjs reads them; on the server: set -a; . /etc/fully-app/env; set +a first.

import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createSession, sha256Hex } from '../worker/lib/auth.js';
import { all, first, getSetting, run, setSetting, stmt } from '../worker/lib/db.js';
import { addDays, budapestDate, nowIso } from '../worker/lib/time.js';

export const DEMO_PREFIX = 'DEMO-';
export const DEMO_SETTING = 'demo_data';
const ORIGIN = 'https://seed.local';
const IN = 'IN (SELECT value FROM json_each(?))';
const J = (list) => JSON.stringify([...list]);

// ---------------------------------------------------------------- API client

// A session of the given user and a small client that calls the worker in process, the way the
// browser app does (session cookie, CSRF header, same origin). Every non-2xx answer throws an
// Error with the method, the path and the response body.
export async function openApi({ worker, env, userId }) {
  const setCookie = await createSession(env, new Request(`${ORIGIN}/`), userId);
  const cookie = setCookie.split(';')[0];
  const token = cookie.slice(cookie.indexOf('=') + 1);
  const pending = [];
  const exec = {
    waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); },
    passThroughOnException() {},
  };
  async function call(method, path, body) {
    const headers = { cookie, 'x-requested-with': 'fl-app', origin: ORIGIN, accept: 'application/json' };
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: payload }), env, exec);
    const text = await res.text();
    if (res.status < 200 || res.status > 299) throw new Error(`${method} ${path} failed with ${res.status}: ${text.slice(0, 2000)}`);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return {
    get: (path) => call('GET', path),
    post: (path, body = {}) => call('POST', path, body),
    put: (path, body = {}) => call('PUT', path, body),
    patch: (path, body = {}) => call('PATCH', path, body),
    del: (path) => call('DELETE', path),
    // Waits for background work (ctx.waitUntil) and deletes the session.
    async close() {
      await Promise.allSettled(pending);
      await run(env.DB, 'DELETE FROM sessions WHERE token_hash = ?', await sha256Hex(token));
    },
  };
}

// ---------------------------------------------------------------- the demo data

const CLIENTS = [
  {
    key: 'MANCS',
    partner: {
      type: 'client', code: 'DEMO-MANCS', name: 'Mancsbirodalom Webáruház Kft.',
      tax_number: '25841736-2-42', company_reg_number: '01-09-384512',
      zip: '1097', city: 'Budapest', address: 'Gubacsi út 6/B.',
      billing_name: 'Mancsbirodalom Webáruház Kft.', billing_zip: '1097', billing_city: 'Budapest', billing_address: 'Gubacsi út 6/B.',
      billing_email: 'szamlazas@mancsbirodalom.example', payment_days: 8, website: 'https://mancsbirodalom.example',
      notes: 'Kisállateledel webshop. Kedden és pénteken érkezik tápszállítmány, a 12 kg-os zsákok raklapon jönnek.',
    },
    contacts: [
      { name: 'Bodnár Péter', position: 'Ügyvezető', email: 'bodnar.peter@mancsbirodalom.example', phone: '+36 30 412 7788', is_primary: true },
      { name: 'Kertész Anikó', position: 'Logisztikai koordinátor', email: 'logisztika@mancsbirodalom.example', phone: '+36 20 318 5520' },
    ],
    contract: { number: 'FL-SZ-2026-011', title: 'Fulfillment szolgáltatási szerződés', notice_days: 30, days_ago: 210 },
    tariffs: { tariffs: { order_base: 650, hourly_work: 6500, cod_fixed: 120 }, storage: { PAL: 15000 } },
    customItems: [{ name: 'Ajándékcsomagolás', unit: 'db', price: 120, kind: 'per_unit' }],
  },
  {
    key: 'KONYHA',
    partner: {
      type: 'client', code: 'DEMO-KONYHA', name: 'Konyhamester Háztartási Gépgyártó Zrt.',
      tax_number: '13579246-2-07', company_reg_number: '07-10-001834',
      zip: '8000', city: 'Székesfehérvár', address: 'Takarodó út 9.',
      billing_name: 'Konyhamester Háztartási Gépgyártó Zrt.', billing_zip: '8000', billing_city: 'Székesfehérvár', billing_address: 'Takarodó út 9.',
      billing_email: 'penzugy@konyhamester.example', payment_days: 15, website: 'https://konyhamester.example',
      notes: 'Kisgépgyártó, a webshopja és a viszonteladói rendelései is tőlünk mennek. Konténeres beérkezés havonta.',
    },
    contacts: [
      { name: 'Dr. Halász Tamás', position: 'Kereskedelmi igazgató', email: 'halasz.tamas@konyhamester.example', phone: '+36 22 501 340', is_primary: true },
      { name: 'Pintér Zsuzsanna', position: 'Raktári kapcsolattartó', email: 'pinter.zsuzsanna@konyhamester.example', phone: '+36 70 284 1196' },
    ],
    contract: { number: 'FL-SZ-2026-004', title: 'Raktározási és kiszállítási keretszerződés', notice_days: 60, days_ago: 280 },
    tariffs: { tariffs: { hourly_work: 6000 }, storage: { PAL: 14000 } },
    customItems: [{ name: 'Raklapfóliázás', unit: 'raklap', price: 1500, kind: 'per_unit' }],
  },
  {
    key: 'BARSONY',
    partner: {
      type: 'client', code: 'DEMO-BARSONY', name: 'Bársonybőr Kozmetikum Kft.',
      tax_number: '26473918-2-13', company_reg_number: '13-09-198765',
      zip: '2040', city: 'Budaörs', address: 'Szabadság út 117.',
      billing_name: 'Bársonybőr Kozmetikum Kft.', billing_zip: '2040', billing_city: 'Budaörs', billing_address: 'Szabadság út 117.',
      billing_email: 'konyveles@barsonybor.example', payment_days: 8, website: 'https://barsonybor.example',
      notes: 'Natúrkozmetikai márka. Sarzs és lejárat szerint kiadandó (FEFO), a sérült termék karanténba kerül.',
    },
    contacts: [
      { name: 'Fehér Krisztina', position: 'Webshop vezető', email: 'feher.krisztina@barsonybor.example', phone: '+36 30 977 2014', is_primary: true },
    ],
    contract: { number: 'FL-SZ-2026-019', title: 'Fulfillment szolgáltatási szerződés', notice_days: 30, days_ago: 95 },
    tariffs: { tariffs: { hourly_work: 7000, cod_pct: 1, discount_handling_pct: 5 } },
    customItems: [{ name: 'Dedikált ügyfélmenedzser', unit: 'hó', price: 15000, kind: 'monthly' }],
  },
];

const OTHER_PARTNERS = [
  {
    key: 'GLS',
    partner: {
      type: 'carrier', code: 'DEMO-GLS', name: 'GLS General Logistics Systems Hungary Kft.', carrier_code: 'gls',
      notes: 'Napi futárátvétel 14:00 és 15:00 között, a manifesztet a sofőr írja alá.',
    },
  },
  {
    key: 'FOXPOST',
    partner: {
      type: 'carrier', code: 'DEMO-FOXPOST', name: 'FoxPost Zrt.', carrier_code: 'foxpost',
      notes: 'Csomagautomatás kiszállítás, a futár 16:30 körül érkezik.',
    },
  },
  {
    key: 'ALFOLDI',
    partner: {
      type: 'supplier', code: 'DEMO-ALFOLDI', name: 'Alföldi Tápgyártó Kft.',
      tax_number: '11223344-2-03', zip: '6000', city: 'Kecskemét', address: 'Szent István körút 21.',
      billing_email: 'ertekesites@alfolditap.example', website: 'https://alfolditap.example',
      notes: 'A Mancsbirodalom tápjainak gyártója, raklapos szállítás saját autóval.',
    },
    contacts: [{ name: 'Szűcs Lajos', position: 'Értékesítési vezető', email: 'szucs.lajos@alfolditap.example', phone: '+36 76 488 210', is_primary: true }],
  },
];

// n: item number in the EAN; size: preferred location size for putaway.
const PRODUCTS = [
  { key: 'MB1', client: 'MANCS', sku: 'DEMO-MB-001', name: 'Prémium felnőtt kutyatáp, csirkés, 12 kg', n: 101, weight_kg: 12.3, width_cm: 42, depth_cm: 14, height_cm: 66, min_stock: 20, track_lot: true, track_expiry: true },
  { key: 'MB2', client: 'MANCS', sku: 'DEMO-MB-002', name: 'Kölyök kutyatáp, bárányos, 3 kg', n: 102, weight_kg: 3.1, width_cm: 26, depth_cm: 9, height_cm: 38, min_stock: 30, track_lot: true, track_expiry: true },
  { key: 'MB3', client: 'MANCS', sku: 'DEMO-MB-003', name: 'Csomósodó macskaalom, levendulás, 10 l', n: 103, weight_kg: 6.2, width_cm: 30, depth_cm: 18, height_cm: 40, min_stock: 15 },
  { key: 'MB4', client: 'MANCS', sku: 'DEMO-MB-004', name: 'Marhabőr rágócsont, 5 db', n: 104, weight_kg: 0.35, min_stock: 50 },
  { key: 'MB5', client: 'MANCS', sku: 'DEMO-MB-005', name: 'Macska jutalomfalat, lazacos, 60 g', n: 105, weight_kg: 0.07, min_stock: 40, track_expiry: true },
  { key: 'KM1', client: 'KONYHA', sku: 'DEMO-KM-100', name: 'Konyhai robotgép KR-900, 1200 W', n: 201, weight_kg: 8.4, width_cm: 45, depth_cm: 32, height_cm: 38, min_stock: 15, track_lot: true },
  { key: 'KM2', client: 'KONYHA', sku: 'DEMO-KM-210', name: 'Botmixer szett BM-350, 3 részes', n: 202, weight_kg: 1.3, width_cm: 28, depth_cm: 12, height_cm: 22, min_stock: 10 },
  { key: 'KM3', client: 'KONYHA', sku: 'DEMO-KM-320', name: 'Üveg vízforraló VF-17, 1,7 l', n: 203, weight_kg: 1.5, width_cm: 24, depth_cm: 18, height_cm: 27, min_stock: 8 },
  { key: 'KM4', client: 'KONYHA', sku: 'DEMO-KM-450', name: 'Kontakt grill KG-2000', n: 204, weight_kg: 3.9, width_cm: 38, depth_cm: 34, height_cm: 16, min_stock: 6 },
  { key: 'BB1', client: 'BARSONY', sku: 'DEMO-BB-01', name: 'Hialuronsavas arckrém, 50 ml', n: 301, weight_kg: 0.12, min_stock: 30, track_lot: true, track_expiry: true },
  { key: 'BB2', client: 'BARSONY', sku: 'DEMO-BB-02', name: 'C-vitaminos arcszérum, 30 ml', n: 302, weight_kg: 0.09, min_stock: 25, track_lot: true, track_expiry: true },
  { key: 'BB3', client: 'BARSONY', sku: 'DEMO-BB-03', name: 'Micellás arctisztító víz, 400 ml', n: 303, weight_kg: 0.45, min_stock: 20, track_lot: true, track_expiry: true },
];

// Inbounds. due: expected date relative to today. put: [location size, pieces] per putaway.
// mode: complete (received, put away, closed), partial (arrived, partly received), expected.
const INBOUNDS = [
  {
    client: 'MANCS', supplier: true, external_ref: 'SZL-ATK-26-0912', due: -3, pallets: 3, cartons: 12, mode: 'complete',
    arrival: 'Három raklap, a fólia ép.',
    lines: [
      { p: 'MB1', qty: 48, lot: 'T2609A', expiry: 330, put: [['PAL', 32], ['PAL', 16]] },
      { p: 'MB2', qty: 60, lot: 'K2608B', expiry: 240, put: [['L', 60]] },
      { p: 'MB3', qty: 40, put: [['L', 40]] },
      { p: 'MB4', qty: 30, put: [['M', 30]] },
      { p: 'MB5', qty: 100, expiry: 150, put: [['M', 100]] },
    ],
  },
  {
    client: 'BARSONY', external_ref: 'BB-SZALL-2609-14', due: -1, pallets: 1, cartons: 9, mode: 'complete',
    arrival: 'Kilenc karton egy raklapon.',
    lines: [
      { p: 'BB1', qty: 120, lot: 'HA2608', expiry: 700, put: [['M', 120]] },
      { p: 'BB2', qty: 80, lot: 'CV2607', expiry: 540, put: [['M', 80]] },
      { p: 'BB3', qty: 60, lot: 'MV2609', expiry: 730, put: [['L', 60]] },
    ],
  },
  {
    client: 'KONYHA', external_ref: 'KM-GY-2026-118', due: 0, pallets: 4, cartons: 0, mode: 'partial',
    arrival: 'Egy raklap fóliája sérült, a dobozok épek. A vízforralók és a grillek még a rámpán várnak.',
    lines: [
      { p: 'KM1', qty: 24, lot: 'KR9-2638', receive: 12, put: [['XL', 12]] },
      { p: 'KM2', qty: 60, receive: 60, put: [['M', 40]] },
      { p: 'KM3', qty: 36 },
      { p: 'KM4', qty: 12 },
    ],
  },
  {
    client: 'MANCS', supplier: true, external_ref: 'SZL-ATK-26-0937', due: 3, pallets: 2, mode: 'expected',
    note: 'Utánrendelés: a rágócsont fogyóban van.',
    lines: [{ p: 'MB4', qty: 200 }, { p: 'MB5', qty: 150 }, { p: 'MB1', qty: 24 }],
  },
  {
    client: 'BARSONY', external_ref: 'BB-SZALL-2609-21', due: -4, cartons: 6, mode: 'expected',
    note: 'A gyártó jelezte, hogy a szállítás csúszik, a héten várható.',
    lines: [{ p: 'BB1', qty: 100 }, { p: 'BB2', qty: 60 }],
  },
];

// Orders, oldest first. flow: what happens to the order after it was created.
//   shipped, delivered, returned: wave 1, packed, closed GLS pickup (then delivered or returned)
//   packed: wave 1, packed; pickup: on the planned Foxpost pickup
//   wave2: the wave in progress; hold, cancel, new: as named
const ORDERS = [
  { key: 'O13', client: 'MANCS', carrier: 'GLS', flow: 'shipped', hours: 52, customer_name: 'Fekete László', email: 'fekete.laszlo@example.com', phone: '+36 30 218 4467', zip: '5000', city: 'Szolnok', address: 'Kossuth tér 4.', external_number: '#MB-10471', cod_amount: 21970, lines: [['MB1', 1], ['MB2', 1]] },
  { key: 'O14', client: 'BARSONY', carrier: 'GLS', flow: 'shipped', hours: 50, customer_name: 'Kovács Anna', email: 'kovacs.anna@example.com', phone: '+36 70 334 5120', zip: '1137', city: 'Budapest', address: 'Pozsonyi út 21. 2/5.', external_number: 'BB-55809', lines: [['BB3', 2]] },
  { key: 'O15', client: 'MANCS', carrier: 'GLS', flow: 'delivered', hours: 49, customer_name: 'Németh Zoltán', email: 'nemeth.zoltan@example.com', phone: '+36 20 671 0932', zip: '6400', city: 'Kiskunhalas', address: 'Kossuth utca 12.', external_number: '#MB-10468', lines: [['MB3', 1]] },
  { key: 'O16', client: 'KONYHA', carrier: 'GLS', flow: 'delivered', hours: 48, customer_name: 'Takács Judit', company: 'Takács Vendéglő Bt.', email: 'takacs.judit@example.com', phone: '+36 36 410 772', zip: '3300', city: 'Eger', address: 'Dobó István tér 1.', external_number: 'KM-2026-3302', lines: [['KM1', 1]] },
  { key: 'O17', client: 'BARSONY', carrier: 'GLS', flow: 'returned', hours: 47, customer_name: 'Juhász Lilla', email: 'juhasz.lilla@example.com', phone: '+36 30 905 3381', zip: '2400', city: 'Dunaújváros', address: 'Vasmű út 10.', external_number: 'BB-55801', lines: [['BB1', 2], ['BB2', 1]] },
  { key: 'O10', client: 'BARSONY', carrier: 'FOXPOST', flow: 'pickup', hours: 30, customer_name: 'Papp Nóra', email: 'papp.nora@example.com', phone: '+36 70 552 1846', zip: '1053', city: 'Budapest', address: 'Kossuth Lajos utca 6.', pickup_point_id: '1021', carrier_service: 'Csomagautomata', external_number: 'BB-55817', lines: [['BB1', 2], ['BB2', 1]] },
  { key: 'O11', client: 'MANCS', carrier: 'FOXPOST', flow: 'pickup', hours: 28, customer_name: 'Lakatos Márk', email: 'lakatos.mark@example.com', phone: '+36 20 448 9017', zip: '8000', city: 'Székesfehérvár', address: 'Fő utca 2.', pickup_point_id: '1187', carrier_service: 'Csomagautomata', external_number: '#MB-10476', cod_amount: 4580, lines: [['MB5', 4]] },
  { key: 'O12', client: 'KONYHA', carrier: 'GLS', flow: 'packed', hours: 26, customer_name: 'Simon Edit', email: 'simon.edit@example.com', phone: '+36 99 312 650', zip: '9400', city: 'Sopron', address: 'Várkerület 30.', external_number: 'KM-2026-3311', lines: [['KM2', 1]] },
  { key: 'O8', client: 'MANCS', carrier: 'GLS', flow: 'wave2', hours: 20, customer_name: 'Molnár Ákos', email: 'molnar.akos@example.com', phone: '+36 30 761 2290', zip: '2000', city: 'Szentendre', address: 'Dumtsa Jenő utca 8.', external_number: '#MB-10480', lines: [['MB1', 2], ['MB3', 1]] },
  { key: 'O9', client: 'KONYHA', carrier: 'GLS', flow: 'wave2', hours: 18, customer_name: 'Balogh Krisztina', email: 'balogh.krisztina@example.com', phone: '+36 76 507 118', zip: '6000', city: 'Kecskemét', address: 'Rákóczi út 15.', external_number: 'KM-2026-3315', lines: [['KM2', 1], ['KM1', 1]] },
  { key: 'O6', client: 'MANCS', carrier: 'GLS', flow: 'hold', hours: 16, customer_name: 'Nagy Bence', email: 'nagy.bence@example.com', phone: '+36 46 220 418', zip: '3530', city: 'Miskolc', address: 'Széchenyi István út 5.', external_number: '#MB-10478', lines: [['MB3', 2]] },
  { key: 'O7', client: 'BARSONY', carrier: 'FOXPOST', flow: 'cancel', hours: 12, customer_name: 'Farkas Dóra', email: 'farkas.dora@example.com', phone: '+36 70 219 6634', zip: '8200', city: 'Veszprém', address: 'Óváros tér 3.', pickup_point_id: '1158', carrier_service: 'Csomagautomata', external_number: 'BB-55819', lines: [['BB1', 1]] },
  { key: 'O3', client: 'MANCS', carrier: 'GLS', flow: 'new', hours: 6, customer_name: 'Horváth Gábor', email: 'horvath.gabor@example.com', phone: '+36 96 318 207', zip: '9021', city: 'Győr', address: 'Baross Gábor út 20.', external_number: '#MB-10483', cod_amount: 15480, lines: [['MB2', 2], ['MB5', 3]] },
  { key: 'O5', client: 'BARSONY', carrier: 'GLS', flow: 'new', hours: 5, customer_name: 'Tóth Petra', email: 'toth.petra@example.com', phone: '+36 72 511 903', zip: '7621', city: 'Pécs', address: 'Király utca 14.', external_number: 'BB-55822', lines: [['BB2', 2]] },
  { key: 'O2', client: 'BARSONY', carrier: 'FOXPOST', flow: 'new', hours: 4, customer_name: 'Szabó Eszter', email: 'szabo.eszter@example.com', phone: '+36 62 425 117', zip: '6720', city: 'Szeged', address: 'Kárász utca 9.', pickup_point_id: '1092', carrier_service: 'Csomagautomata', external_number: 'BB-55821', cod_amount: 8990, lines: [['BB1', 1], ['BB3', 1]] },
  { key: 'O4', client: 'KONYHA', carrier: 'GLS', flow: 'new', hours: 3, customer_name: 'Varga Zsolt', company: 'Varga és Társa Bt.', email: 'varga.zsolt@example.com', phone: '+36 52 316 774', zip: '4025', city: 'Debrecen', address: 'Piac utca 31.', external_number: 'KM-2026-3317', note: 'Viszonteladói rendelés, a grill most nincs raktáron.', lines: [['KM4', 1]] },
  { key: 'O1', client: 'MANCS', carrier: 'GLS', flow: 'new', priority: 'express', hours: 1, customer_name: 'Kiss Réka', email: 'kiss.reka@example.com', phone: '+36 30 555 1201', zip: '1117', city: 'Budapest', address: 'Bartók Béla út 112. 3/9.', external_number: '#MB-10484', note: 'Expressz kiszállítás, kapucsengő: Kiss R.', lines: [['MB1', 1], ['MB4', 2]] },
];

// Storage zones created when the warehouse has fewer than 20 active storage locations.
const ZONES = [
  { prefix: 'A', size: 'M', rack_from: 1, rack_to: 2, levels: 4, pick: 10 },
  { prefix: 'B', size: 'L', rack_from: 1, rack_to: 2, levels: 3, pick: 100 },
  { prefix: 'C', size: 'XL', rack_from: 1, rack_to: 1, levels: 4, pick: 200 },
  { prefix: 'P', size: 'PAL', rack_from: 1, rack_to: 1, levels: 4, pick: 300 },
];
// Fallback when there are not enough free storage locations: a separate DEMO zone.
const SPARE_ZONES = [
  { prefix: 'DEMO', size: 'M', rack_from: 1, rack_to: 1, levels: 6, pick: 900 },
  { prefix: 'DEMO', size: 'L', rack_from: 2, rack_to: 2, levels: 4, pick: 910 },
  { prefix: 'DEMO', size: 'XL', rack_from: 3, rack_to: 3, levels: 2, pick: 920 },
  { prefix: 'DEMO', size: 'PAL', rack_from: 4, rack_to: 4, levels: 2, pick: 930 },
];
const SPECIAL = [
  { kind: 'receiving', code: 'RAMPA-BE', note: 'Áruátvételi rámpa' },
  { kind: 'returns', code: 'VISSZARU', note: 'Visszáru zóna' },
  { kind: 'quarantine', code: 'KARANTEN', note: 'Sérült és zárolt áru' },
];
const LOCATION_NOTE = 'Demó adat';

// ---------------------------------------------------------------- small helpers

// Valid EAN-13 (GS1 Hungary prefix 599) for item number n.
function ean13(n) {
  const body = `5999876${String(n).padStart(5, '0')}`;
  const sum = body.split('').reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// A small picture of a dented cardboard box corner (photo of a damaged return).
export function demoPhoto(w = 160, h = 120) {
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  for (let y = 0; y < h; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < w; x++) {
      let c = [198, 162, 112];
      if (Math.abs(x - (y * w) / h) < 2.5) c = [150, 116, 76];
      if ((x - 112) ** 2 + (y - 38) ** 2 < 260) c = [118, 88, 56];
      if (y > h - 18) c = [222, 220, 214];
      const grain = ((x * 7 + y * 13) % 9) - 4;
      const o = y * row + 1 + x * 3;
      raw[o] = clamp(c[0] + grain);
      raw[o + 1] = clamp(c[1] + grain);
      raw[o + 2] = clamp(c[2] + grain);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const glsTracking = (id) => String(50340000000 + id * 7919);
const foxTracking = (id) => `CLFOX${String(2600000000 + id * 104729)}`;

async function freeLocationCode(db, code) {
  for (const c of [code, `${code}-DEMO`, `DEMO-${code}`, `DEMO-${code}-2`]) {
    if (!(await first(db, 'SELECT id FROM locations WHERE code = ? COLLATE NOCASE', c))) return c;
  }
  throw new Error(`No free location code for ${code}`);
}

// Saves the demo_data setting (direct SQL: there is no endpoint for it). Location ids of an
// earlier, interrupted run are kept.
async function saveDemoSetting(db, locationIds) {
  const prev = await getSetting(db, DEMO_SETTING, null);
  const ids = new Set([...(prev && Array.isArray(prev.location_ids) ? prev.location_ids : []), ...locationIds]);
  await setSetting(db, DEMO_SETTING, { created_at: (prev && prev.created_at) || nowIso(), location_ids: [...ids].sort((a, b) => a - b) });
}

// ---------------------------------------------------------------- seeding

export async function seedDemo({ worker, env, adminId, log = console.log, today }) {
  const db = env.DB;
  const existing = await first(db, "SELECT code FROM partners WHERE code LIKE 'DEMO-%' ORDER BY id LIMIT 1");
  if (existing) {
    log(`A demó adatok már megvannak (${existing.code} partner létezik), nem változtattam semmit. Törlés: node server/demo-seed.mjs --remove`);
    return { created: false };
  }
  const user = await first(db,
    'SELECT u.id, u.name, u.active, u.must_change_password, r.is_admin FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?', adminId);
  if (!user || !user.active || !user.is_admin) throw new Error(`A(z) ${adminId} azonosítójú felhasználó nem aktív adminisztrátor.`);
  if (user.must_change_password) throw new Error(`${user.name} még nem változtatta meg a kezdő jelszavát, így nem használhatja az API-t. Lépj be vele egyszer.`);
  log(`Demó adatok létrehozása ${user.name} nevében...`);

  const realToday = budapestDate();
  const day0 = today || realToday;
  const rel = (days) => addDays(day0, days);
  // Endpoints check the dates against the real clock: billing entries not in the future, pickups
  // not in the past, statements not for a future month.
  const notFuture = (d) => (d > realToday ? realToday : d);
  const period = notFuture(day0).slice(0, 7);
  const inMonth = (days) => {
    const d = notFuture(rel(days));
    return d < `${period}-01` ? notFuture(day0) : d;
  };
  const pickupDay = day0 < realToday ? realToday : day0;
  const base = day0 === realToday ? Date.now() : Date.parse(`${day0}T15:00:00.000Z`);
  const hoursAgo = (h) => new Date(base - h * 3600 * 1000).toISOString();

  const api = await openApi({ worker, env, userId: adminId });
  const state = { partners: {}, products: {}, orders: {}, locations: [], productLocations: {} };
  try {
    // ------------------------------------------------------------ partners
    log('Partnerek...');
    for (const c of [...CLIENTS, ...OTHER_PARTNERS]) {
      const { id } = await api.post('/api/partners', c.partner);
      state.partners[c.key] = id;
      for (const contact of c.contacts || []) await api.post(`/api/partners/${id}/contacts`, contact);
      if (c.contract) {
        const { days_ago: daysAgo, ...contract } = c.contract;
        await api.post(`/api/partners/${id}/contracts`, { ...contract, start_date: rel(-daysAgo), status: 'active', notes: 'Határozatlan idejű, havi elszámolással.' });
      }
    }

    // ------------------------------------------------------------ locations
    log('Raktárhelyek...');
    const sizes = (await api.get('/api/settings/sizes')).items.filter((s) => s.active);
    if (!sizes.length) throw new Error('Nincs aktív raktárhely méret (Beállítások > Raktárhely méretek).');
    const sizeId = (code) => (sizes.find((s) => s.code === code) || sizes[0]).id;
    const bulkZone = async (z) => {
      const body = {
        prefixes: z.prefix, separator: '-', pad: 2, rack_from: z.rack_from, rack_to: z.rack_to, level_from: 1, level_to: z.levels,
        size_id: sizeId(z.size), kind: 'storage', pick_start: z.pick, note: LOCATION_NOTE,
      };
      const preview = await api.post('/api/settings/locations/bulk', { ...body, preview: true });
      if (!preview.codes.length) return;
      await api.post('/api/settings/locations/bulk', body);
      const rows = await all(db, `SELECT id FROM locations WHERE code ${IN}`, J(preview.codes));
      state.locations.push(...rows.map((r) => r.id));
    };
    const activeStorage = (await first(db, "SELECT COUNT(*) AS n FROM locations WHERE kind = 'storage' AND active = 1")).n;
    if (activeStorage < 20) for (const z of ZONES) await bulkZone(z);
    for (const s of SPECIAL) {
      if (await first(db, 'SELECT id FROM locations WHERE kind = ? AND active = 1 LIMIT 1', s.kind)) continue;
      const loc = await api.post('/api/settings/locations', { code: await freeLocationCode(db, s.code), size_id: sizeId('PAL'), kind: s.kind, note: s.note });
      state.locations.push(loc.id);
    }
    // Empty, free storage locations for the putaways: the ones just created first.
    const freePool = () => all(db,
      `SELECT l.id, l.code, z.code AS size FROM locations l JOIN location_sizes z ON z.id = l.size_id
       WHERE l.kind = 'storage' AND l.active = 1 AND l.partner_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM stock s WHERE s.location_id = l.id AND s.qty > 0)
         AND NOT EXISTS (SELECT 1 FROM count_lines cl JOIN counts c ON c.id = cl.count_id
                         WHERE cl.location_id = l.id AND c.status IN ('open', 'counting', 'counted'))
       ORDER BY CASE WHEN l.id ${IN} THEN 0 ELSE 1 END, l.pick_sequence, l.code`, J(state.locations));
    const needed = INBOUNDS.reduce((n, i) => n + i.lines.reduce((m, l) => m + (l.put ? l.put.length : 0), 0), 0);
    let pool = await freePool();
    if (pool.length < needed) {
      for (const z of SPARE_ZONES) await bulkZone(z);
      pool = await freePool();
      if (pool.length < needed) throw new Error(`Nincs elég üres tárolóhely a demó készlethez (${needed} kell, ${pool.length} van).`);
    }
    const takeLocation = (size) => {
      let i = pool.findIndex((l) => l.size === size);
      if (i < 0) i = 0;
      return pool.splice(i, 1)[0];
    };
    await saveDemoSetting(db, state.locations);

    // ------------------------------------------------------------ tariffs and custom items
    log('Tarifák...');
    for (const c of CLIENTS) {
      const id = state.partners[c.key];
      const storage = Object.fromEntries(Object.entries(c.tariffs.storage || {})
        .filter(([code]) => sizes.some((s) => s.code === code)).map(([code, price]) => [sizeId(code), price]));
      await api.put(`/api/partners/${id}/tariffs`, { tariffs: c.tariffs.tariffs, storage });
      state.customItems = state.customItems || {};
      for (const item of c.customItems) {
        const { id: itemId } = await api.post(`/api/partners/${id}/custom-items`, item);
        state.customItems[c.key] = itemId;
      }
    }

    // ------------------------------------------------------------ products
    log('Termékek...');
    for (const p of PRODUCTS) {
      const { key, client, n, ...fields } = p;
      const ean = ean13(n);
      const { id } = await api.post('/api/products', {
        partner_id: state.partners[client], ...fields, ean, track_lot: !!fields.track_lot, track_expiry: !!fields.track_expiry,
        notes: fields.track_expiry ? 'Lejárat szerint kiadandó (FEFO).' : '',
      });
      state.products[key] = { id, sku: p.sku, ean, client };
    }

    // ------------------------------------------------------------ inbounds
    log('Betárolások...');
    for (const inb of INBOUNDS) {
      const { id } = await api.post('/api/inbound', {
        partner_id: state.partners[inb.client], supplier_id: inb.supplier ? state.partners.ALFOLDI : null,
        external_ref: inb.external_ref, expected_date: rel(inb.due), pallets: inb.pallets || 0, cartons: inb.cartons || 0, note: inb.note || '',
        lines: inb.lines.map((l) => ({
          product_id: state.products[l.p].id, expected_qty: l.qty, lot: l.lot || '', expiry: l.expiry ? rel(l.expiry) : null,
        })),
      });
      if (inb.mode === 'expected') continue;
      await api.post(`/api/inbound/${id}/arrive`, { pallets: inb.pallets || 0, cartons: inb.cartons || 0, note: inb.arrival || '' });
      const detail = await api.get(`/api/inbound/${id}`);
      for (const spec of inb.lines) {
        const line = detail.lines.find((l) => l.product_id === state.products[spec.p].id);
        const received = inb.mode === 'complete' ? spec.qty : spec.receive || 0;
        if (!received) continue;
        await api.post(`/api/inbound/${id}/lines/${line.id}/receive`, { received_qty: received });
        for (const [size, qty] of spec.put || []) {
          const loc = takeLocation(size);
          await api.post(`/api/inbound/${id}/putaway`, { line_id: line.id, location_id: loc.id, qty });
          (state.productLocations[spec.p] ||= []).push(loc);
        }
      }
      if (inb.mode === 'complete') await api.post(`/api/inbound/${id}/complete`, { note: '' });
    }

    // ------------------------------------------------------------ orders
    log('Rendelések...');
    for (const o of ORDERS) {
      const { key, client, carrier, flow, hours, lines, ...fields } = o;
      const res = await api.post('/api/orders', {
        partner_id: state.partners[client], carrier_id: state.partners[carrier], ordered_at: hoursAgo(hours), ...fields,
        lines: lines.map(([p, qty]) => ({ product_id: state.products[p].id, qty })),
      });
      state.orders[key] = { id: res.id, number: res.number, flow, carrier };
    }
    const orderIds = (flows) => Object.values(state.orders).filter((o) => flows.includes(o.flow)).map((o) => o.id);

    // Wave 1: everything that gets packed, picked completely and packed with a manual tracking
    // number; the wave closes itself when the last order is packed.
    log('Komissió és csomagolás...');
    const wave1 = await api.post('/api/picking/waves', { order_ids: orderIds(['shipped', 'delivered', 'returned', 'packed', 'pickup']), note: 'Délelőtti hullám' });
    await api.post(`/api/picking/waves/${wave1.id}/start`);
    let w = await api.get(`/api/picking/waves/${wave1.id}`);
    for (const t of w.tasks) {
      if (t.remaining <= 0) continue;
      await api.post(`/api/picking/waves/${wave1.id}/confirm`, {
        pick_id: t.pick_id, location_code: t.location.code, product_code: t.product.ean || t.product.sku, qty: t.remaining,
      });
    }
    for (const o of Object.values(state.orders).filter((x) => ['shipped', 'delivered', 'returned', 'packed', 'pickup'].includes(x.flow))) {
      const p = await api.get(`/api/picking/orders/${o.id}`);
      await api.post(`/api/picking/orders/${o.id}/pack`, {
        mode: 'manual', package_count: 1, weight_kg: p.suggested_weight_kg ? Math.round((p.suggested_weight_kg + 0.3) * 10) / 10 : null,
        tracking_number: o.carrier === 'FOXPOST' ? foxTracking(o.id) : glsTracking(o.id),
      });
    }

    // Closed GLS pickup: ships the older orders.
    log('Futárátvételek...');
    const closed = await api.post('/api/transport/pickups', {
      carrier_id: state.partners.GLS, date: pickupDay, window_from: '14:00', window_to: '15:00', note: 'Napi GLS átvétel',
    });
    await api.post(`/api/transport/pickups/${closed.id}/orders`, { order_ids: orderIds(['shipped', 'delivered', 'returned']) });
    await api.post(`/api/transport/pickups/${closed.id}/arrived`);
    await api.post(`/api/transport/pickups/${closed.id}/close`, { manifest_number: `GLS-${pickupDay.replace(/-/g, '')}-01` });
    // Planned Foxpost pickup with packed orders still on it.
    const planned = await api.post('/api/transport/pickups', {
      carrier_id: state.partners.FOXPOST, date: pickupDay, window_from: '16:30', window_to: '17:00', note: 'Foxpost automatás csomagok',
    });
    await api.post(`/api/transport/pickups/${planned.id}/orders`, { order_ids: orderIds(['pickup']) });

    // Delivered, and one delivered order came back: one piece sellable, one damaged.
    log('Kézbesítés és visszáru...');
    for (const id of orderIds(['delivered', 'returned'])) await api.post(`/api/history/${id}/delivered`, { note: 'A címzett átvette.' });
    const ret = state.orders.O17;
    const quarantine = await quarantineFor(db, state.partners.BARSONY) || await (async () => {
      const loc = await api.post('/api/settings/locations', { code: await freeLocationCode(db, 'KARANTEN'), size_id: sizeId('PAL'), kind: 'quarantine', note: 'Sérült és zárolt áru' });
      state.locations.push(loc.id);
      await saveDemoSetting(db, state.locations);
      return loc;
    })();
    const vr = await api.post(`/api/history/${ret.id}/returns`, {
      reason: 'Elállás 14 napon belül', note: 'A szérum kupakja eltört, a doboz benyomódott.',
      lines: [
        { product_id: state.products.BB1.id, qty: 1, condition: 'sellable', location_id: state.productLocations.BB1[0].id },
        { product_id: state.products.BB2.id, qty: 1, condition: 'damaged', location_id: quarantine.id },
      ],
    });
    const form = new FormData();
    form.append('file', new Blob([demoPhoto()], { type: 'image/png' }), 'visszaru-serult-doboz.png');
    await api.post(`/api/history/returns/${vr.id}/photos`, form);

    // Hold and cancel.
    await api.post(`/api/orders/${state.orders.O6.id}/hold`, { reason: 'A vevő kérésére jövő hétig várunk a szállítással.' });
    await api.post(`/api/orders/${state.orders.O7.id}/cancel`, { reason: 'A vevő lemondta, a webshop visszautalta a vételárat.' });

    // Wave 2: in progress, the first task picked.
    const wave2 = await api.post('/api/picking/waves', { order_ids: orderIds(['wave2']), note: 'Délutáni hullám' });
    await api.post(`/api/picking/waves/${wave2.id}/start`);
    w = await api.get(`/api/picking/waves/${wave2.id}`);
    const t = w.tasks.find((x) => x.remaining > 0);
    await api.post(`/api/picking/waves/${wave2.id}/confirm`, {
      pick_id: t.pick_id, location_code: t.location.code, product_code: t.product.ean || t.product.sku, qty: t.remaining,
    });

    // Pallet transport request for next week's pet food delivery.
    const company = await getSetting(db, 'company', {});
    await api.post('/api/transport/transports', {
      direction: 'in', partner_id: state.partners.MANCS, date: rel(3), time_from: '08:00', time_to: '10:00',
      origin: 'Alföldi Tápgyártó Kft., 6000 Kecskemét, Szent István körút 21.',
      destination: [company.name, [company.zip, company.city].filter(Boolean).join(' '), company.address].filter(Boolean).join(', ') || 'Fully Logistics raktár',
      pallets: 2, weight_kg: 1450, vehicle: '7,5 t, ponyvás, emelőhátfalas', note: 'Ajánlatkérés a jövő heti tápszállításhoz.',
    });

    // ------------------------------------------------------------ inventory count
    log('Leltár...');
    const countLocations = ['BB1', 'BB2', 'BB3'].map((k) => state.productLocations[k][0].id);
    const count = await api.post('/api/counts', { type: 'locations', location_ids: countLocations, blind: true, note: 'Havi ciklikus leltár a kozmetikai polcokon.' });
    const countDetail = await api.get(`/api/counts/${count.id}`);
    const counted = countDetail.locations.find((l) => l.location_id === state.productLocations.BB3[0].id);
    for (const line of counted.items) {
      if (line.product_id) await api.put(`/api/counts/${count.id}/lines/${line.id}`, { counted_qty: line.expected_qty });
    }

    // ------------------------------------------------------------ quotes
    log('Ajánlatok...');
    const defaults = await api.get('/api/quotes/defaults');
    const t0 = defaults.default_tariffs || {};
    const tariffs = Object.fromEntries((defaults.tariffs || []).map((x) => [x.key, Number(t0[x.key]) || 0]));
    const storageLine = (code, qty, price) => {
      const s = (defaults.sizes || []).find((x) => x.code === code);
      return s ? { code: s.code, name: s.name, qty, price: price != null ? price : Number((t0.storage || {})[code]) || 0 } : null;
    };
    const quoteBody = (key, status, data) => ({
      partner_id: state.partners[key], status,
      data: {
        offerDate: rel(status === 'sent' ? -9 : -1), validDays: 30, terms: defaults.quote_terms, company: defaults.company,
        signer: user.name, internal: { costLabor: 420, costPack: 110, costSpace: 260 }, ...data,
        tariffs: { ...tariffs, ...data.tariffs },
        storage: data.storage.filter(Boolean),
      },
    });
    const contactOf = (key) => {
      const c = CLIENTS.find((x) => x.key === key);
      const p = c.partner;
      return {
        name: p.name, contact: c.contacts[0].name, email: c.contacts[0].email, phone: c.contacts[0].phone,
        shop: p.website.replace(/^https:\/\//, ''), address: `${p.zip} ${p.city}, ${p.address}`, tax_number: p.tax_number,
      };
    };
    await api.post('/api/quotes', quoteBody('BARSONY', 'sent', {
      client: contactOf('BARSONY'),
      volume: { orders: 450, avg: 1.8, inbound: 1200, retPct: 2, moveIn: 2500, hours: 4, codOrders: 120, codAvg: 9500 },
      storage: [storageLine('M', 30), storageLine('L', 10)],
      tariffs: { cod_pct: 1, hourly_work: 7000, discount_handling_pct: 5 },
      discounts: { freeMoveIn: 2500, freeStorageMonths: 1, priceLockMonths: 12 },
      customItems: [{ name: 'Dedikált ügyfélmenedzser', unit: 'hó', kind: 'monthly', price: 15000, qty: 1 }],
    }));
    await api.post('/api/quotes', quoteBody('KONYHA', 'draft', {
      client: contactOf('KONYHA'),
      volume: { orders: 180, avg: 1.2, inbound: 800, retPct: 3, moveIn: 0, hours: 6 },
      storage: [storageLine('XL', 8), storageLine('PAL', 12, 14000)],
      tariffs: { hourly_work: 6000 },
      discounts: { freeMoveIn: 0, freeStorageMonths: 0, priceLockMonths: 6 },
      customItems: [{ name: 'Raklapfóliázás', unit: 'raklap', kind: 'per_unit', price: 1500, qty: 10 }],
    }));

    // ------------------------------------------------------------ billing
    log('Elszámolás...');
    const entries = [
      { partner_id: state.partners.MANCS, date: inMonth(-2), kind: 'hourly_work', qty: 2.5, note: 'Akciós csomagok összeállítása (kutyatáp és rágócsont)' },
      { partner_id: state.partners.MANCS, date: inMonth(-1), kind: 'custom', custom_item_id: state.customItems.MANCS, qty: 40, note: 'Ajándékcsomagolás a születésnapi akcióhoz' },
      { partner_id: state.partners.KONYHA, date: inMonth(0), kind: 'custom', custom_item_id: state.customItems.KONYHA, qty: 3, note: 'Viszonteladói raklapok fóliázása' },
      { partner_id: state.partners.BARSONY, date: inMonth(-1), kind: 'hourly_work', qty: 1.5, note: 'Átcímkézés magyar nyelvű címkére' },
    ];
    for (const e of entries) await api.post('/api/billing/entries', e);
    await api.post('/api/billing/snapshot');
    // Only the demo clients: a generate without partner_ids would also touch the real clients.
    await api.post('/api/billing/statements/generate', { period, partner_ids: CLIENTS.map((c) => state.partners[c.key]) });

    await saveDemoSetting(db, state.locations);
  } finally {
    await api.close();
  }
  const summary = await demoSummary(db);
  log(formatSummary(summary));
  return { created: true, summary };
}

// A quarantine location that can take this partner's goods (empty, or already holding theirs).
const quarantineFor = (db, partnerId) => first(db,
  `SELECT l.id, l.code FROM locations l
   WHERE l.kind = 'quarantine' AND l.active = 1 AND (l.partner_id IS NULL OR l.partner_id = ?)
     AND NOT EXISTS (SELECT 1 FROM stock s JOIN products p ON p.id = s.product_id
                     WHERE s.location_id = l.id AND s.qty > 0 AND p.partner_id <> ?)
   ORDER BY l.pick_sequence, l.code LIMIT 1`, partnerId, partnerId);

// What the demo data holds now, for the summary.
export async function demoSummary(db) {
  const P = (await all(db, "SELECT id FROM partners WHERE code LIKE 'DEMO-%'")).map((r) => r.id);
  const setting = await getSetting(db, DEMO_SETTING, null);
  const byKey = async (sql, ...args) => Object.fromEntries((await all(db, sql, ...args)).map((r) => [r.k, r.n]));
  const n = async (sql, ...args) => (await first(db, sql, ...args)).n;
  const ordersOf = `SELECT id FROM orders WHERE partner_id ${IN}`;
  return {
    partners: await byKey(`SELECT type AS k, COUNT(*) AS n FROM partners WHERE id ${IN} GROUP BY type`, J(P)),
    contacts: await n(`SELECT COUNT(*) AS n FROM partner_contacts WHERE partner_id ${IN}`, J(P)),
    contracts: await n(`SELECT COUNT(*) AS n FROM partner_contracts WHERE partner_id ${IN}`, J(P)),
    locations: setting && Array.isArray(setting.location_ids) ? setting.location_ids.length : 0,
    products: await n(`SELECT COUNT(*) AS n FROM products WHERE partner_id ${IN}`, J(P)),
    on_hand: await n(`SELECT COALESCE(SUM(s.qty), 0) AS n FROM stock s JOIN products p ON p.id = s.product_id WHERE p.partner_id ${IN}`, J(P)),
    inbounds: await byKey(`SELECT status AS k, COUNT(*) AS n FROM inbounds WHERE partner_id ${IN} GROUP BY status`, J(P)),
    orders: await byKey(`SELECT status AS k, COUNT(*) AS n FROM orders WHERE partner_id ${IN} GROUP BY status`, J(P)),
    waves: await byKey(`SELECT status AS k, COUNT(*) AS n FROM waves WHERE id IN (SELECT wave_id FROM picks WHERE order_id IN (${ordersOf})) GROUP BY status`, J(P)),
    pickups: await byKey(`SELECT status AS k, COUNT(*) AS n FROM carrier_pickups WHERE carrier_id ${IN} GROUP BY status`, J(P)),
    transports: await n(`SELECT COUNT(*) AS n FROM transports WHERE partner_id ${IN}`, J(P)),
    returns: await n(`SELECT COUNT(*) AS n FROM returns WHERE partner_id ${IN}`, J(P)),
    counts: await n(`SELECT COUNT(DISTINCT c.id) AS n FROM counts c JOIN count_lines cl ON cl.count_id = c.id JOIN products p ON p.id = cl.product_id
                     WHERE p.partner_id ${IN} AND c.status IN ('open', 'counting', 'counted')`, J(P)),
    quotes: await byKey(`SELECT status AS k, COUNT(*) AS n FROM quotes WHERE partner_id ${IN} GROUP BY status`, J(P)),
    billing_entries: await n(`SELECT COUNT(*) AS n FROM billing_entries WHERE partner_id ${IN}`, J(P)),
    statements: await byKey(`SELECT period AS k, COUNT(*) AS n FROM statements WHERE partner_id ${IN} GROUP BY period`, J(P)),
  };
}

const ORDER_LABELS = [['new', 'új'], ['hold', 'felfüggesztve'], ['picking', 'komissió alatt'], ['packed', 'feladásra kész'],
  ['shipped', 'feladva'], ['delivered', 'kézbesítve'], ['returned', 'visszáru'], ['cancelled', 'sztornózva']];
const sumOf = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
const list = (o, labels) => labels.filter(([k]) => o[k]).map(([k, label]) => `${label} ${o[k]}`).join(', ');

export function formatSummary(s) {
  return [
    'Demó adatok:',
    `- Partnerek: ${s.partners.client || 0} ügyfél, ${s.partners.carrier || 0} fuvarozó, ${s.partners.supplier || 0} beszállító, ${s.contacts} kapcsolattartó, ${s.contracts} szerződés`,
    `- Raktárhelyek: ${s.locations} új`,
    `- Termékek: ${s.products}, készleten ${s.on_hand} db`,
    `- Betárolások: ${sumOf(s.inbounds)} (${list(s.inbounds, [['completed', 'lezárt'], ['receiving', 'átvétel alatt'], ['arrived', 'megérkezett'], ['expected', 'várható']])})`,
    `- Rendelések: ${sumOf(s.orders)} (${list(s.orders, ORDER_LABELS)}), visszáru: ${s.returns}`,
    `- Komissió: ${sumOf(s.waves)} hullám (${list(s.waves, [['completed', 'lezárt'], ['picking', 'kiszedés alatt'], ['open', 'nyitott'], ['picked', 'kiszedve']])})`,
    `- Fuvarszervezés: ${sumOf(s.pickups)} futárátvétel (${list(s.pickups, [['closed', 'lezárt'], ['planned', 'tervezett'], ['arrived', 'futár a rámpán']])}), ${s.transports} fuvar`,
    `- Leltár: ${s.counts} nyitott leltár`,
    `- Ajánlatok: ${sumOf(s.quotes)} (${list(s.quotes, [['draft', 'piszkozat'], ['sent', 'elküldve'], ['accepted', 'elfogadva'], ['rejected', 'elutasítva']])})`,
    `- Elszámolás: ${s.billing_entries} rögzített tétel, ${sumOf(s.statements)} piszkozat elszámolás (${Object.keys(s.statements).join(', ')})`,
  ].join('\n');
}

// ---------------------------------------------------------------- removing

// Deletes every row that belongs to the demo partners (codes DEMO-%) in one transaction, then the
// demo locations and the demo_data setting. Direct SQL: the app has no endpoint that deletes
// orders, movements or inbounds (they are history), and a demo must go without a trace.
// Rules that keep real data untouched:
//   - only rows of demo partners and their products, orders, inbounds and returns are deleted;
//   - a demo carrier or supplier that real data still points at (a real order shipped with the
//     demo GLS, a real inbound from the demo supplier) stays, set inactive, and is reported;
//   - waves, pickups, transports and counts go only when nothing real is left on them; a real count
//     only loses its lines of demo products (a location that had only those keeps an empty line);
//   - a demo location goes when nothing refers to it any more, it is set inactive when history is
//     left on it, and it stays as it is while it holds real stock;
//   - the activity log keeps its rows (it is history) and gets one row about the removal.
export async function removeDemo({ env, log = console.log }) {
  const db = env.DB;
  const setting = await getSetting(db, DEMO_SETTING, null);
  const partners = await all(db, "SELECT id, code, type FROM partners WHERE code LIKE 'DEMO-%' ORDER BY id");
  if (!partners.length && !setting) {
    log('Nincs demó adat, nincs mit törölni.');
    return { removed: false };
  }
  const ids = async (sql, ...args) => (await all(db, sql, ...args)).map((r) => r.id);
  const P = partners.map((p) => p.id);
  const locs = setting && Array.isArray(setting.location_ids) ? setting.location_ids.filter((x) => Number.isInteger(x)) : [];

  const products = await ids(`SELECT id FROM products WHERE partner_id ${IN}`, J(P));
  const orders = await ids(`SELECT id FROM orders WHERE partner_id ${IN}`, J(P));
  const keep = new Set(await ids(
    `SELECT carrier_id AS id FROM orders WHERE carrier_id ${IN} AND partner_id NOT ${IN}
     UNION SELECT supplier_id FROM inbounds WHERE supplier_id ${IN} AND partner_id NOT ${IN}
     UNION SELECT carrier_id FROM transports WHERE carrier_id ${IN} AND partner_id IS NOT NULL AND partner_id NOT ${IN}
     UNION SELECT cp.carrier_id FROM carrier_pickups cp WHERE cp.carrier_id ${IN}
       AND EXISTS (SELECT 1 FROM orders o WHERE o.pickup_id = cp.id AND o.partner_id NOT ${IN})`,
    J(P), J(P), J(P), J(P), J(P), J(P), J(P), J(P)));
  const drop = P.filter((id) => !keep.has(id));
  const returns = await ids(`SELECT id FROM returns WHERE partner_id ${IN}`, J(P));
  const inbounds = await ids(`SELECT id FROM inbounds WHERE partner_id ${IN}`, J(P));
  const waves = await ids(
    `SELECT wave_id AS id FROM picks WHERE order_id ${IN} UNION SELECT wave_id FROM orders WHERE id ${IN} AND wave_id IS NOT NULL`, J(orders), J(orders));
  const pickups = await ids(
    `SELECT cp.id FROM carrier_pickups cp
     WHERE (cp.carrier_id ${IN} OR cp.id IN (SELECT pickup_id FROM orders WHERE id ${IN} AND pickup_id IS NOT NULL))
       AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.pickup_id = cp.id AND o.partner_id NOT ${IN})`, J(drop), J(orders), J(P));
  const transports = await ids(`SELECT id FROM transports WHERE partner_id ${IN} OR (partner_id IS NULL AND carrier_id ${IN})`, J(P), J(P));
  // Counts that only cover demo locations or demo products.
  const counts = await ids(
    `SELECT c.id FROM counts c
     WHERE EXISTS (SELECT 1 FROM count_lines cl WHERE cl.count_id = c.id AND (cl.product_id ${IN} OR cl.location_id ${IN}))
       AND NOT EXISTS (SELECT 1 FROM count_lines cl WHERE cl.count_id = c.id AND cl.location_id NOT ${IN}
                         AND (cl.product_id IS NULL OR cl.product_id NOT ${IN}))`, J(products), J(locs), J(locs), J(products));
  const docs = await all(db,
    `SELECT id, r2_key FROM documents WHERE partner_id ${IN}
     OR id IN (SELECT manifest_document_id FROM carrier_pickups WHERE id ${IN} AND manifest_document_id IS NOT NULL)`, J(drop), J(pickups));
  const snapshotDates = (await all(db, `SELECT DISTINCT date FROM storage_snapshots WHERE partner_id ${IN}`, J(P))).map((r) => r.date);
  const connections = `(SELECT id FROM webshop_connections WHERE partner_id ${IN})`;
  const now = nowIso();
  const summary = `Demó adatok törölve: ${drop.length} partner, ${products.length} termék, ${orders.length} rendelés, ${inbounds.length} betárolás`;

  const steps = [
    ['return_photos', `DELETE FROM return_photos WHERE return_id ${IN}`, J(returns)],
    ['return_lines', `DELETE FROM return_lines WHERE return_id ${IN}`, J(returns)],
    ['returns', `DELETE FROM returns WHERE id ${IN}`, J(returns)],
    ['picks', `DELETE FROM picks WHERE order_id ${IN}`, J(orders)],
    ['order_events', `DELETE FROM order_events WHERE order_id ${IN}`, J(orders)],
    ['order_lines', `DELETE FROM order_lines WHERE order_id ${IN}`, J(orders)],
    ['webshop_orders', `DELETE FROM webshop_orders WHERE order_id ${IN}`, J(orders)],
    ['courier_label_locks', `DELETE FROM courier_label_locks WHERE order_id ${IN}`, J(orders)],
    ['orders', `DELETE FROM orders WHERE id ${IN}`, J(orders)],
    ['waves', `DELETE FROM waves WHERE id ${IN} AND NOT EXISTS (SELECT 1 FROM picks WHERE wave_id = waves.id)
                 AND NOT EXISTS (SELECT 1 FROM orders WHERE wave_id = waves.id)`, J(waves)],
    ['carrier_pickups', `DELETE FROM carrier_pickups WHERE id ${IN}`, J(pickups)],
    ['transports', `DELETE FROM transports WHERE id ${IN}`, J(transports)],
    ['inbound_putaways', `DELETE FROM inbound_putaways WHERE inbound_id ${IN}`, J(inbounds)],
    ['inbound_lines', `DELETE FROM inbound_lines WHERE inbound_id ${IN}`, J(inbounds)],
    ['inbounds', `DELETE FROM inbounds WHERE id ${IN}`, J(inbounds)],
    ['count_lines', `DELETE FROM count_lines WHERE count_id ${IN}`, J(counts)],
    ['counts', `DELETE FROM counts WHERE id ${IN}`, J(counts)],
    // A real count keeps every location it covers: where only demo goods were counted, one line
    // becomes the "empty location" line the count would have had without them.
    ['count_lines_emptied', `UPDATE count_lines SET product_id = NULL, lot = '', expiry = '', expected_qty = 0, added = 0,
         counted_qty = CASE WHEN counted_qty IS NULL THEN NULL ELSE 0 END, posted_diff = CASE WHEN posted_at IS NULL THEN NULL ELSE 0 END
       WHERE id IN (SELECT MIN(cl.id) FROM count_lines cl WHERE cl.product_id ${IN}
         AND NOT EXISTS (SELECT 1 FROM count_lines o WHERE o.count_id = cl.count_id AND o.location_id = cl.location_id
                         AND (o.product_id IS NULL OR o.product_id NOT ${IN}))
         GROUP BY cl.count_id, cl.location_id)`, J(products), J(products)],
    ['count_lines_demo', `DELETE FROM count_lines WHERE product_id ${IN}`, J(products)],
    ['movements', `DELETE FROM movements WHERE partner_id ${IN}`, J(P)],
    ['stock', `DELETE FROM stock WHERE product_id ${IN}`, J(products)],
    ['storage_snapshots', `DELETE FROM storage_snapshots WHERE partner_id ${IN}`, J(P)],
    ['snapshot_runs', `UPDATE snapshot_runs SET rows = (SELECT COUNT(*) FROM storage_snapshots s WHERE s.date = snapshot_runs.date) WHERE date ${IN}`, J(snapshotDates)],
    ['billing_entries', `DELETE FROM billing_entries WHERE partner_id ${IN}`, J(P)],
    ['statements', `DELETE FROM statements WHERE partner_id ${IN}`, J(P)],
    ['quotes', `DELETE FROM quotes WHERE partner_id ${IN}`, J(P)],
    ['documents', `DELETE FROM documents WHERE id ${IN}`, J(docs.map((d) => d.id))],
    ['products', `DELETE FROM products WHERE id ${IN}`, J(products)],
    ['webshop_pending_orders', `DELETE FROM webshop_pending_orders WHERE connection_id IN ${connections}`, J(drop)],
    ['webshop_connection_state', `DELETE FROM webshop_connection_state WHERE connection_id IN ${connections}`, J(drop)],
    ['webshop_stock_sync', `DELETE FROM webshop_stock_sync WHERE connection_id IN ${connections}`, J(drop)],
    ['webshop_connections', `DELETE FROM webshop_connections WHERE partner_id ${IN}`, J(drop)],
    ['api_rate_limits', `DELETE FROM api_rate_limits WHERE key_id IN (SELECT id FROM api_keys WHERE partner_id ${IN})`, J(drop)],
    ['api_keys', `DELETE FROM api_keys WHERE partner_id ${IN}`, J(drop)],
    ['partner_contacts', `DELETE FROM partner_contacts WHERE partner_id ${IN}`, J(drop)],
    ['partner_contracts', `DELETE FROM partner_contracts WHERE partner_id ${IN}`, J(drop)],
    ['partner_tariffs', `DELETE FROM partner_tariffs WHERE partner_id ${IN}`, J(drop)],
    ['partner_storage_prices', `DELETE FROM partner_storage_prices WHERE partner_id ${IN}`, J(drop)],
    ['partner_custom_items', `DELETE FROM partner_custom_items WHERE partner_id ${IN}`, J(drop)],
    ['partners_kept', `UPDATE partners SET status = 'inactive', updated_at = ? WHERE id ${IN}`, now, J(keep)],
    ['partners', `DELETE FROM partners WHERE id ${IN}`, J(drop)],
    ['locations', `DELETE FROM locations WHERE id ${IN}
       AND NOT EXISTS (SELECT 1 FROM stock WHERE location_id = locations.id)
       AND NOT EXISTS (SELECT 1 FROM movements WHERE location_id = locations.id)
       AND NOT EXISTS (SELECT 1 FROM picks WHERE location_id = locations.id)
       AND NOT EXISTS (SELECT 1 FROM count_lines WHERE location_id = locations.id)
       AND NOT EXISTS (SELECT 1 FROM inbound_lines WHERE location_id = locations.id)
       AND NOT EXISTS (SELECT 1 FROM inbound_putaways WHERE location_id = locations.id)
       AND NOT EXISTS (SELECT 1 FROM return_lines WHERE location_id = locations.id)
       AND NOT EXISTS (SELECT 1 FROM storage_snapshots WHERE location_id = locations.id)`, J(locs)],
    ['locations_inactive', `UPDATE locations SET active = 0 WHERE id ${IN} AND active = 1
       AND NOT EXISTS (SELECT 1 FROM stock WHERE location_id = locations.id AND qty > 0)`, J(locs)],
    ['setting', 'DELETE FROM settings WHERE key = ?', DEMO_SETTING],
    ['audit', `INSERT INTO audit_log (at, actor, module, action, entity, entity_id, summary) VALUES (?, 'Rendszer', 'settings', 'delete', 'demo_data', '', ?)`, now, summary],
  ];
  const results = await db.batch(steps.map(([, sql, ...args]) => stmt(db, sql, ...args)));
  const changed = Object.fromEntries(steps.map(([name], i) => [name, results[i].meta.changes]));

  // Files after the commit: R2 is not part of the transaction. A file that cannot be deleted is
  // only an orphan in the bucket, the rows are gone already.
  let filesDeleted = 0;
  for (const d of docs) {
    try {
      await env.FILES.delete(d.r2_key);
      filesDeleted++;
    } catch (err) {
      log(`Nem sikerült törölni a fájlt: ${d.r2_key} (${err.message})`);
    }
  }
  const kept = partners.filter((p) => keep.has(p.id)).map((p) => p.code);
  const locationsLeft = await all(db, `SELECT code, active FROM locations WHERE id ${IN} ORDER BY code`, J(locs));
  const out = {
    removed: true,
    partners: changed.partners,
    kept_partners: kept,
    products: changed.products,
    orders: changed.orders,
    inbounds: changed.inbounds,
    returns: changed.returns,
    waves: changed.waves,
    pickups: changed.carrier_pickups,
    transports: changed.transports,
    counts: changed.counts,
    quotes: changed.quotes,
    statements: changed.statements,
    billing_entries: changed.billing_entries,
    movements: changed.movements,
    documents: changed.documents,
    files: filesDeleted,
    locations_deleted: changed.locations,
    locations_inactivated: changed.locations_inactive,
    locations_kept: locationsLeft.filter((l) => l.active).map((l) => l.code),
  };
  log([
    'Demó adatok törölve:',
    `- ${out.partners} partner, ${out.products} termék, ${out.orders} rendelés, ${out.inbounds} betárolás, ${out.returns} visszáru`,
    `- ${out.waves} hullám, ${out.pickups} futárátvétel, ${out.transports} fuvar, ${out.counts} leltár, ${out.quotes} ajánlat`,
    `- ${out.statements} elszámolás, ${out.billing_entries} rögzített tétel, ${out.movements} készletmozgás, ${out.documents} dokumentum (${out.files} fájl)`,
    `- Raktárhelyek: ${out.locations_deleted} törölve, ${out.locations_inactivated} inaktiválva${out.locations_kept.length ? `, valódi készlet miatt maradt: ${out.locations_kept.join(', ')}` : ''}`,
    ...(kept.length ? [`- Inaktiválva, mert valódi adat hivatkozik rá: ${kept.join(', ')}`] : []),
    'A napló bejegyzései megmaradtak.',
  ].join('\n'));
  return out;
}

// ---------------------------------------------------------------- command line

let seeding = false;

async function main() {
  const { loadConfig, filesBucket } = await import('./config.mjs');
  const { D1Database } = await import('./d1.mjs');
  const { createAssets } = await import('./assets.mjs');
  const config = loadConfig();
  if (!existsSync(config.dbPath)) throw new Error(`Nem találom az adatbázist: ${config.dbPath}. Állítsd be a DB_PATH változót.`);
  const DB = new D1Database(config.dbPath);
  try {
    const env = { ...config.vars, DB, FILES: filesBucket(config), ASSETS: createAssets(config.assetsDir) };
    if (process.argv.includes('--remove')) {
      await removeDemo({ env });
      return 0;
    }
    const worker = (await import(pathToFileURL(config.worker).href)).default;
    // The first active administrator; one who still has to change the initial password cannot
    // use the API, so those come last.
    const admin = await first(DB,
      `SELECT u.id, u.name, u.email FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.is_admin = 1 AND u.active = 1 ORDER BY u.must_change_password, u.id LIMIT 1`);
    if (!admin) {
      console.error('Nincs aktív adminisztrátor. Előbb hozd létre az első adminisztrátort az alkalmazásban (telepítési kód), utána futtasd újra.');
      return 2;
    }
    seeding = true;
    const res = await seedDemo({ worker, env, adminId: admin.id });
    if (res.created) console.log('Kész. Törlés: node server/demo-seed.mjs --remove');
    return 0;
  } finally {
    DB.close();
  }
}

// realpath: the file may be started through a symlink (/opt/fully-app/current, see deploy/aws/agent.mjs tasks).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`Hiba: ${err.message}`);
      if (seeding) console.error('A félbemaradt demó adatokat így törölheted: node server/demo-seed.mjs --remove');
      process.exitCode = 1;
    });
}
