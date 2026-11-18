// Half a year of demo history. First the demo data of demo-seed.mjs as it stood half a year ago,
// with 17 more webshops, two carriers and five suppliers (30 partners), then every day since replayed through the app's own API with this process's clock set to that
// day:
//   - webshop orders arrive every day, a few are cancelled or put on hold;
//   - on weekdays the warehouse picks and packs everything it can and hands the parcels to GLS, DPD
//     and Foxpost, the parcels are delivered a day or two later, and a few come back;
//   - stock is reordered when it runs low, and the delivery is received and put away;
//   - the storage snapshot is taken every evening, hourly work is logged on Fridays, and the
//     monthly statements are made and approved on the 1st.
// Today ends mid-morning: new orders, a wave being picked, packed parcels waiting for the courier.
//
// It is the same demo data (DEMO- partners and products), so it all goes with
//   node server/demo-seed.mjs --remove
// Nothing leaves the server: parcels get made-up tracking numbers by hand (no courier API), the
// statements are not invoiced (no invoicing API), the demo clients have no webshop or API key.
//
//   node server/demo-history.mjs [--months 6]
// The environment is read like server/demo-seed.mjs reads it (DB_PATH and the rest).

import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { all, first } from '../worker/lib/db.js';
import { addDays, budapestDate } from '../worker/lib/time.js';
import { demoSummary, ean13, formatSummary, openApi, saveDemoSetting, seedDemo } from './demo-seed.mjs';

// ---------------------------------------------------------------- the clock of this process

// Every new Date() and Date.now() in the app reads the simulated time, and so do the tables'
// default timestamps (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), the only strftime the app has) on
// this process's database connection. The running server keeps the real clock.
const RealDate = Date;
let shift = 0;
function useSimulatedClock(db) {
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(RealDate.now() + shift);
    }
    static now() { return RealDate.now() + shift; }
  };
  db.sqlite.function('strftime', (format, value) => {
    if (format !== '%Y-%m-%dT%H:%M:%fZ' || value !== 'now') throw new Error(`strftime(${format}, ${value}) nincs szimulálva`);
    return new Date().toISOString();
  });
}
// day: "YYYY-MM-DD", utc: "HH:MM" in UTC (06:30 UTC is 07:30 or 08:30 in Budapest, same day).
const setClock = (day, utc) => { shift = RealDate.parse(`${day}T${utc}:00.000Z`) - RealDate.now(); };
const weekday = (day) => new RealDate(`${day}T12:00:00Z`).getUTCDay();

// ---------------------------------------------------------------- reproducible randomness

let seed = 20260518;
function rnd() {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;

// ---------------------------------------------------------------- what the shops sell

// perDay: orders on a weekday (weekends: about two thirds); qty: pieces of one line.
const SHOPS = {
  'DEMO-MANCS': { perDay: [5, 12], ref: '#MB-', next: 10500, cod: 0.4, lines: [1, 3], skus: { 'DEMO-MB-001': [1, 1], 'DEMO-MB-002': [1, 2], 'DEMO-MB-003': [1, 2], 'DEMO-MB-004': [1, 3], 'DEMO-MB-005': [1, 4] } },
  'DEMO-BARSONY': { perDay: [3, 9], ref: 'BB-', next: 56000, cod: 0.25, lines: [1, 3], skus: { 'DEMO-BB-01': [1, 2], 'DEMO-BB-02': [1, 2], 'DEMO-BB-03': [1, 2] } },
  'DEMO-KONYHA': { perDay: [1, 4], ref: 'KM-2026-', next: 3400, cod: 0.2, lines: [1, 2], skus: { 'DEMO-KM-100': [1, 1], 'DEMO-KM-210': [1, 2], 'DEMO-KM-320': [1, 2], 'DEMO-KM-450': [1, 1] } },
};
const LAST = ['Nagy', 'Kovács', 'Tóth', 'Szabó', 'Horváth', 'Varga', 'Kiss', 'Molnár', 'Németh', 'Farkas', 'Balogh', 'Papp', 'Takács', 'Juhász', 'Lakatos', 'Mészáros', 'Oláh', 'Simon', 'Rácz', 'Fekete'];
const FIRST = ['Anna', 'Eszter', 'Réka', 'Zsófia', 'Katalin', 'Judit', 'Nóra', 'Petra', 'Bence', 'Gábor', 'László', 'Zoltán', 'Péter', 'Máté', 'Dániel', 'Ákos', 'Tamás', 'Krisztina', 'Lilla', 'Márk'];
const PLACES = [
  ['1117', 'Budapest', 'Bartók Béla út'], ['1137', 'Budapest', 'Pozsonyi út'], ['1095', 'Budapest', 'Soroksári út'], ['6720', 'Szeged', 'Kárász utca'],
  ['4025', 'Debrecen', 'Piac utca'], ['7621', 'Pécs', 'Király utca'], ['9021', 'Győr', 'Baross Gábor út'], ['3530', 'Miskolc', 'Széchenyi István út'],
  ['8000', 'Székesfehérvár', 'Fő utca'], ['6000', 'Kecskemét', 'Rákóczi út'], ['5000', 'Szolnok', 'Kossuth tér'], ['8200', 'Veszprém', 'Óváros tér'],
  ['3300', 'Eger', 'Dobó István tér'], ['9400', 'Sopron', 'Várkerület'], ['2000', 'Szentendre', 'Dumtsa Jenő utca'], ['2040', 'Budaörs', 'Szabadság út'],
];
const plain = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const HOURLY_NOTES = ['Akciós csomagok összeállítása', 'Átcímkézés magyar nyelvű címkére', 'Szettképzés a webshop akciójához', 'Sérült dobozok átcsomagolása'];
const RETURN_REASONS = ['Elállás 14 napon belül', 'Nem ezt rendelte', 'Sérült csomagolás'];

// More partners, so the list has 30: small webshops with their products ([name, kg, expiry tracked]),
// two carriers and the suppliers of the shops' goods.
const MORE_CLIENTS = [
  ['ZOLDKERT', 'Zöldkert Kertészeti Webáruház Kft.', '6000', 'Kecskemét', 'Halasi út 12.', [['Fűmagkeverék, 1 kg', 1.1], ['Virágföld, 20 l', 8.5], ['Metszőolló', 0.3], ['Locsolótömlő, 25 m', 2.4]]],
  ['BABAPONT', 'Babapont Kft.', '1149', 'Budapest', 'Mogyoródi út 32.', [['Babaágynemű szett', 1.2], ['Cumisüveg, 250 ml', 0.15], ['Pelenkázó táska', 0.8]]],
  ['SPORTMAX', 'SportMax Online Kft.', '9024', 'Győr', 'Bálint Mihály utca 4.', [['Jógaszőnyeg, 6 mm', 1.0], ['Kézisúlyzó, 2 × 5 kg', 10.4], ['Futópóló', 0.2], ['Kulacs, 750 ml', 0.25]]],
  ['LAPOZO', 'Lapozó Könyvesbolt Kft.', '6722', 'Szeged', 'Tisza Lajos körút 47.', [['Magyar konyha szakácskönyv', 1.1], ['Mesekönyv, 3-6 éveseknek', 0.6], ['Asztali naptár 2027', 0.4]]],
  ['TEAHAZ', 'Teaház Manufaktúra Bt.', '3300', 'Eger', 'Széchenyi utca 18.', [['Zöld tea, 100 g', 0.12, true], ['Gyümölcstea, 100 g', 0.12, true], ['Üveg teáskanna, 1 l', 0.7]]],
  ['PORKOLDE', 'Pörkölde Kávé Kft.', '1066', 'Budapest', 'Teréz körút 24.', [['Szemes kávé, 1 kg', 1.05, true], ['Őrölt kávé, 250 g', 0.27, true], ['Kotyogós kávéfőző', 0.6]]],
  ['OKOSOTTHON', 'OkosOtthon Elektronika Kft.', '4031', 'Debrecen', 'Kishegyesi út 8.', [['Okos konnektor', 0.15], ['LED izzó E27, 4 db', 0.3], ['Wifi kamera', 0.4]]],
  ['VITALPLUSZ', 'VitalPlusz Étrend-kiegészítő Kft.', '7622', 'Pécs', 'Bajcsy-Zsilinszky utca 5.', [['D3-vitamin, 60 db', 0.08, true], ['Magnézium, 30 db', 0.07, true], ['Kollagén por, 300 g', 0.35, true]]],
  ['JATEKVAR', 'Játékvár Kft.', '3527', 'Miskolc', 'József Attila utca 66.', [['Építőkocka, 500 db', 1.4], ['Családi társasjáték', 1.0], ['Plüssmaci, 40 cm', 0.4]]],
  ['AUTOPLUSZ', 'AutóPlusz Alkatrész Kft.', '8000', 'Székesfehérvár', 'Seregélyesi út 96.', [['Ablaktörlő lapát, 2 db', 0.5], ['Motorolaj 5W-30, 5 l', 4.6], ['Autós telefontartó', 0.2]]],
  ['DIVATSAROK', 'Divatsarok Webshop Kft.', '1052', 'Budapest', 'Váci utca 11.', [['Női kötött pulóver', 0.5], ['Férfi ing, slim', 0.3], ['Gyapjú sál', 0.2]]],
  ['LEPESROL', 'Lépésről Cipőbolt Kft.', '9700', 'Szombathely', 'Fő tér 8.', [['Futócipő', 0.9], ['Bőr bakancs', 1.4], ['Strandpapucs', 0.3]]],
  ['HOBBIMUHELY', 'Hobbiműhely Kft.', '8200', 'Veszprém', 'Budapest út 20.', [['Akrilfesték készlet, 24 szín', 0.9], ['Festővászon, 40 × 50 cm', 0.5], ['Ecsetkészlet', 0.2]]],
  ['IRODASZER', 'Irodaszer Expressz Kft.', '2040', 'Budaörs', 'Kinizsi utca 2.', [['Fénymásolópapír A4, 500 lap', 2.5], ['Golyóstoll, 10 db', 0.15], ['Iratrendező, 8 cm', 0.6]]],
  ['BIOKOSAR', 'Biokosár Kft.', '2100', 'Gödöllő', 'Szabadság tér 3.', [['Bio zabpehely, 1 kg', 1.0, true], ['Chia mag, 500 g', 0.5, true], ['Kókuszolaj, 500 ml', 0.5, true]]],
  ['SZEPSEG', 'Szépségsziget Kft.', '4024', 'Debrecen', 'Piac utca 45.', [['Hajsampon, 500 ml', 0.55, true], ['Testápoló, 400 ml', 0.45, true], ['Körömlakk', 0.05]]],
  ['PECABOLT', 'Pecabolt Horgászcikk Kft.', '2890', 'Tata', 'Ady Endre út 7.', [['Pergető horgászbot, 3 m', 0.4], ['Monofil damil, 0,25 mm', 0.1], ['Csalis doboz', 0.3]]],
];
const MORE_PARTNERS = [
  { type: 'carrier', code: 'DEMO-DPD', name: 'DPD Hungária Kft.', carrier_code: 'dpd', notes: 'Napi futárátadás 15:00 és 16:00 között.' },
  { type: 'carrier', code: 'DEMO-DUNACARGO', name: 'Duna Cargo Szállítmányozási Kft.', zip: '2310', city: 'Szigetszentmiklós', address: 'Leshegy út 30.', notes: 'Raklapos és kamionos fuvarok.' },
  ...[['PANNONPACK', 'Pannon Csomagolóanyag Kft.', '9027', 'Győr'], ['AGROMAG', 'Agro-Mag Kft.', '6800', 'Hódmezővásárhely'], ['EUROKOZMETIK', 'EuroKozmetik Gyártó Kft.', '2600', 'Vác'],
    ['DELPAPIR', 'Dél-Alföldi Papír Zrt.', '6500', 'Baja'], ['BALATONTEXTIL', 'Balaton Textil Kft.', '8360', 'Keszthely']]
    .map(([key, name, zip, city]) => ({ type: 'supplier', code: `DEMO-${key}`, name, zip, city, address: 'Ipari park 1.' })),
];

// ---------------------------------------------------------------- one day

export async function seedHistory({ worker, env, adminId, months = 6, log = console.log }) {
  const db = env.DB;
  if (await first(db, "SELECT id FROM partners WHERE code LIKE 'DEMO-%' LIMIT 1")) {
    log('A demó adatok már megvannak, nem változtattam semmit. Előbb töröld őket: node server/demo-seed.mjs --remove');
    return { created: false };
  }
  const today = budapestDate();
  const day0 = addDays(today, -Math.round(months * 30.4));
  setClock(day0, '06:30');
  log(`Demó adatok ${day0} napra...`);
  await seedDemo({ worker, env, adminId, log: () => {} });
  const withApi = async (fn) => {
    const api = await openApi({ worker, env, userId: adminId });
    try {
      return await fn(api);
    } finally {
      await api.close();
    }
  };
  const shops = structuredClone(SHOPS);
  await withApi((api) => morePartners(api, day0));

  // The other partners, the webshops with their products, and a zone for their goods; each shop's
  // opening stock arrives the next morning.
  async function morePartners(api, start) {
    for (const p of MORE_PARTNERS) await api.post('/api/partners', p);
    const sizes = (await api.get('/api/settings/sizes')).items.filter((z) => z.active);
    const sizeId = (code) => (sizes.find((z) => z.code === code) || sizes[0]).id;
    for (const [size, from, to, pickStart] of [['M', 5, 12, 940], ['L', 13, 16, 970]]) {
      const body = { prefixes: 'DEMO', separator: '-', pad: 2, rack_from: from, rack_to: to, level_from: 1, level_to: 4, size_id: sizeId(size), kind: 'storage', pick_start: pickStart, note: 'Demó adat' };
      const { codes } = await api.post('/api/settings/locations/bulk', { ...body, preview: true });
      if (!codes.length) continue;
      await api.post('/api/settings/locations/bulk', body);
      await saveDemoSetting(db, (await all(db, 'SELECT id FROM locations WHERE code IN (SELECT value FROM json_each(?))', JSON.stringify(codes))).map((r) => r.id));
    }
    const suppliers = MORE_PARTNERS.filter((p) => p.type === 'supplier').map((p) => p.code);
    let n = 400;
    for (const [i, [key, name, zip, city, address, items]] of MORE_CLIENTS.entries()) {
      const code = `DEMO-${key}`;
      const domain = `${plain(key)}.example`;
      const { id } = await api.post('/api/partners', {
        type: 'client', code, name, zip, city, address, tax_number: `${int(10000000, 32999999)}-2-${String(int(2, 44)).padStart(2, '0')}`,
        billing_name: name, billing_zip: zip, billing_city: city, billing_address: address, billing_email: `szamlazas@${domain}`,
        payment_days: pick([8, 15, 30]), website: `https://${domain}`,
      });
      await api.post(`/api/partners/${id}/contacts`, {
        name: `${pick(LAST)} ${pick(FIRST)}`, position: 'Webshop vezető', email: `info@${domain}`, phone: `+36 ${pick(['20', '30', '70'])} ${int(200, 999)} ${int(1000, 9999)}`, is_primary: true,
      });
      await api.post(`/api/partners/${id}/contracts`, {
        number: `FL-SZ-2026-${String(30 + i).padStart(3, '0')}`, title: 'Fulfillment szolgáltatási szerződés', notice_days: 30, start_date: addDays(start, -int(5, 200)), status: 'active',
      });
      const lines = [];
      for (const [j, [pname, kg, expiry]] of items.entries()) {
        const p = await api.post('/api/products', { partner_id: id, sku: `${code}-${j + 1}`, name: pname, ean: ean13(++n), weight_kg: kg, min_stock: 10, track_lot: !!expiry, track_expiry: !!expiry });
        lines.push({ product_id: p.id, expected_qty: int(6, 20) * 10, lot: expiry ? 'NYITO' : '', expiry: expiry ? addDays(start, 400) : null });
      }
      await api.post('/api/inbound', {
        partner_id: id, external_ref: `${key.slice(0, 2)}-NYITO`, expected_date: start, pallets: 1, cartons: int(4, 20), note: 'Nyitókészlet beszállítása.', lines,
      });
      shops[code] = {
        perDay: [0, 3], ref: `${key.slice(0, 2)}-`, next: int(1000, 5000), cod: 0.3, lines: [1, 2], supplier: pick(suppliers),
        skus: Object.fromEntries(items.map((_, j) => [`${code}-${j + 1}`, [1, 2]])),
      };
    }
  }

  const partners = Object.fromEntries((await all(db, "SELECT id, code FROM partners WHERE code LIKE 'DEMO-%'")).map((p) => [p.code, p.id]));
  const products = await all(db, "SELECT id, sku, partner_id, track_lot, track_expiry FROM products WHERE sku LIKE 'DEMO-%'");
  const bySku = Object.fromEntries(products.map((p) => [p.sku, p]));
  const clients = Object.keys(shops).map((code) => partners[code]);
  const demo = `(SELECT id FROM partners WHERE code LIKE 'DEMO-%')`;
  const nowIso = () => new Date().toISOString();
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

  // A location for this product's goods: where it already is, where it was, or an empty one.
  const locationFor = async (productId) => (await first(db,
    `SELECT location_id AS id FROM stock WHERE product_id = ? AND qty > 0 ORDER BY qty DESC LIMIT 1`, productId))
    || (await first(db, 'SELECT location_id AS id FROM movements WHERE product_id = ? ORDER BY id DESC LIMIT 1', productId))
    || first(db,
      `SELECT l.id FROM locations l WHERE l.kind = 'storage' AND l.active = 1 AND l.partner_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM stock s WHERE s.location_id = l.id AND s.qty > 0)
       ORDER BY CASE WHEN l.note = 'Demó adat' THEN 0 ELSE 1 END, l.pick_sequence, l.code LIMIT 1`);

  async function newOrders(api, day) {
    const weekend = [0, 6].includes(weekday(day));
    for (const [code, shop] of Object.entries(shops)) {
      const n = Math.round(int(...shop.perDay) * (weekend ? 0.65 : 1));
      for (let i = 0; i < n; i++) {
        const carrier = pick(['GLS', 'GLS', 'GLS', 'GLS', 'FOXPOST', 'FOXPOST', 'FOXPOST', 'DPD']);
        const foxpost = carrier === 'FOXPOST';
        const [zip, city, street] = pick(PLACES);
        const [last, firstName] = [pick(LAST), pick(FIRST)];
        const skus = Object.keys(shop.skus).sort(() => rnd() - 0.5).slice(0, int(...shop.lines));
        const o = await api.post('/api/orders', {
          partner_id: partners[code], carrier_id: partners[`DEMO-${carrier}`], ordered_at: hoursAgo(int(1, 20)),
          customer_name: `${last} ${firstName}`, email: `${plain(last)}.${plain(firstName)}@example.com`, phone: `+36 ${pick(['20', '30', '70'])} ${int(200, 999)} ${int(1000, 9999)}`,
          zip, city, address: `${street} ${int(1, 120)}.`, external_number: `${shop.ref}${shop.next++}`,
          cod_amount: chance(shop.cod) ? int(4, 40) * 990 : 0, priority: chance(0.05) ? 'express' : 'normal',
          ...(foxpost ? { pickup_point_id: String(int(1000, 1999)), carrier_service: 'Csomagautomata' } : {}),
          lines: skus.map((sku) => ({ product_id: bySku[sku].id, qty: int(...shop.skus[sku]) })),
        });
        if (chance(0.012)) await api.post(`/api/orders/${o.id}/cancel`, { reason: 'A vevő lemondta, a webshop visszautalta a vételárat.' });
        else if (chance(0.012)) await api.post(`/api/orders/${o.id}/hold`, { reason: 'A vevő kérésére később küldjük.' });
      }
    }
  }

  async function receive(api, day) {
    const due = await all(db, `SELECT id, status FROM inbounds WHERE partner_id IN ${demo} AND status IN ('expected', 'arrived', 'receiving') AND expected_date <= ?`, day);
    for (const inb of due) {
      if (inb.status === 'expected') await api.post(`/api/inbound/${inb.id}/arrive`, { note: 'Ép raklapok, a szállítólevél egyezik.' });
      const { lines } = await api.get(`/api/inbound/${inb.id}`);
      for (const l of lines) {
        const p = products.find((x) => x.id === l.product_id);
        if (l.received_qty < l.expected_qty) {
          await api.post(`/api/inbound/${inb.id}/lines/${l.id}/receive`, {
            received_qty: l.expected_qty,
            ...(p.track_lot && !l.lot ? { lot: `L${day.replace(/-/g, '').slice(2)}` } : {}),
            ...(p.track_expiry && !l.expiry ? { expiry: addDays(day, int(300, 700)) } : {}),
          });
        }
        const open = l.expected_qty - l.putaway_qty;
        if (open > 0) await api.post(`/api/inbound/${inb.id}/putaway`, { line_id: l.id, location_id: (await locationFor(l.product_id)).id, qty: open });
      }
      await api.post(`/api/inbound/${inb.id}/complete`, { note: 'A beérkezett mennyiség eltér a várttól.' });
    }
  }

  // Everything that can be picked goes into one wave; on the last day only half of it is picked.
  async function pickAndPack(api, day, last) {
    const ready = (await api.get('/api/orders?status=new&availability=ok&limit=500')).items.filter((o) => o.availability === 'ok').map((o) => o.id);
    if (ready.length) await api.post('/api/picking/waves', { order_ids: ready, note: weekday(day) === 1 ? 'Hétfői hullám' : 'Reggeli hullám' });
    const waves = (await api.get('/api/picking/waves?status=active&limit=200')).items;
    for (const w of waves) {
      if (w.status === 'open') await api.post(`/api/picking/waves/${w.id}/start`);
      const tasks = (await api.get(`/api/picking/waves/${w.id}`)).tasks.filter((t) => t.remaining > 0);
      for (const t of last ? tasks.slice(0, Math.ceil(tasks.length / 2)) : tasks) {
        await api.post(`/api/picking/waves/${w.id}/confirm`, { pick_id: t.pick_id, location_code: t.location.code, product_code: t.product.ean || t.product.sku, qty: t.remaining });
      }
    }
    for (;;) {
      const { ready: packable } = await api.get('/api/picking/packing');
      if (!packable.length) break;
      for (const o of packable) {
        const p = await api.get(`/api/picking/orders/${o.id}`);
        const { carrier_code: carrier } = await first(db, 'SELECT c.carrier_code FROM orders o JOIN partners c ON c.id = o.carrier_id WHERE o.id = ?', o.id);
        await api.post(`/api/picking/orders/${o.id}/pack`, {
          mode: 'manual', package_count: 1, weight_kg: p.suggested_weight_kg ? Math.round((p.suggested_weight_kg + 0.3) * 10) / 10 : null,
          tracking_number: { foxpost: `CLFOX${2600000000 + o.id * 104729}`, dpd: String(1580000000000 + o.id * 7907) }[carrier] || String(50340000000 + o.id * 7919),
        });
      }
    }
  }

  // Each carrier's packed parcels on a pickup; closed (shipped) except on the last day.
  async function handOver(api, day, last) {
    for (const [code, from, to] of [['DEMO-GLS', '14:00', '15:00'], ['DEMO-DPD', '15:00', '16:00'], ['DEMO-FOXPOST', '16:30', '17:00']]) {
      const carrierId = partners[code];
      const waiting = await first(db, "SELECT COUNT(*) AS n FROM orders WHERE status = 'packed' AND pickup_id IS NULL AND carrier_id = ?", carrierId);
      const open = await first(db, "SELECT id FROM carrier_pickups WHERE carrier_id = ? AND status IN ('planned', 'arrived') ORDER BY id LIMIT 1", carrierId);
      if (!waiting.n && !open) continue;
      const pickupId = open ? open.id : (await api.post('/api/transport/pickups', { carrier_id: carrierId, date: day, window_from: from, window_to: to, note: 'Napi átadás' })).id;
      if (waiting.n) await api.post(`/api/transport/pickups/${pickupId}/orders`, { all: true });
      if (last) continue;
      await api.post(`/api/transport/pickups/${pickupId}/arrived`);
      await api.post(`/api/transport/pickups/${pickupId}/close`, { manifest_number: `${code.slice(5)}-${day.replace(/-/g, '')}` });
    }
  }

  async function deliver(api, all_) {
    const shipped = await all(db, `SELECT id FROM orders WHERE partner_id IN ${demo} AND status = 'shipped' AND shipped_at < ?`, all_ ? nowIso() : hoursAgo(18));
    for (const o of shipped) if (all_ || chance(0.8)) await api.post(`/api/history/${o.id}/delivered`, { note: 'A címzett átvette.' });
  }

  async function returns(api, day) {
    const delivered = await all(db,
      `SELECT id FROM orders WHERE partner_id IN ${demo} AND status = 'delivered' AND delivered_at >= ? AND delivered_at < ?`,
      `${addDays(day, -5)}T00:00:00.000Z`, `${addDays(day, -4)}T00:00:00.000Z`);
    for (const o of delivered) {
      if (!chance(0.03)) continue;
      const line = await first(db, 'SELECT product_id FROM order_lines WHERE order_id = ? ORDER BY id LIMIT 1', o.id);
      await api.post(`/api/history/${o.id}/returns`, {
        reason: pick(RETURN_REASONS), note: '',
        lines: [{ product_id: line.product_id, qty: 1, condition: 'sellable', location_id: (await locationFor(line.product_id)).id }],
      });
    }
  }

  // Reorder when stock and the expected deliveries cover less than 12 days of sales: 30 days' worth.
  async function reorder(api, day) {
    const since = hoursAgo(21 * 24);
    for (const [code, shop] of Object.entries(shops)) {
      const lines = [];
      for (const sku of Object.keys(shop.skus)) {
        const p = bySku[sku];
        const sold = (await first(db, 'SELECT COALESCE(SUM(ol.qty), 0) AS n FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE ol.product_id = ? AND o.created_at >= ?', p.id, since)).n;
        const perDay = Math.max(sold / 21, 1);
        const onHand = (await first(db, 'SELECT COALESCE(SUM(qty), 0) AS n FROM stock WHERE product_id = ?', p.id)).n;
        const coming = (await first(db,
          `SELECT COALESCE(SUM(l.expected_qty - l.putaway_qty), 0) AS n FROM inbound_lines l JOIN inbounds i ON i.id = l.inbound_id
           WHERE l.product_id = ? AND i.status IN ('expected', 'arrived', 'receiving')`, p.id)).n;
        if (onHand + coming >= perDay * 12) continue;
        lines.push({
          product_id: p.id, expected_qty: Math.ceil((perDay * 30) / 10) * 10,
          lot: p.track_lot ? `L${day.replace(/-/g, '').slice(2)}` : '', expiry: p.track_expiry ? addDays(day, int(300, 700)) : null,
        });
      }
      if (!lines.length) continue;
      let due = addDays(day, 2);
      while ([0, 6].includes(weekday(due))) due = addDays(due, 1);
      await api.post('/api/inbound', {
        partner_id: partners[code], supplier_id: code === 'DEMO-MANCS' ? partners['DEMO-ALFOLDI'] : partners[shop.supplier] || null,
        external_ref: `${code.slice(5, 7)}-SZALL-${day.replace(/-/g, '')}`, expected_date: due, pallets: int(1, 3), cartons: int(0, 12),
        note: 'Utánrendelés: fogyóban a készlet.', lines,
      });
    }
  }

  async function statements(api, period) {
    await api.post('/api/billing/statements/generate', { period, partner_ids: clients });
    const drafts = await all(db, `SELECT id FROM statements WHERE period = ? AND status = 'draft' AND partner_id IN ${demo}`, period);
    for (const s of drafts) await api.post(`/api/billing/statements/${s.id}/approve`).catch(() => {}); // an empty one stays a draft
  }

  // ------------------------------------------------------------ the days since
  // Today nothing may happen later than now: the morning is squeezed into the last hour and a half.
  const clock = (day, utc, minutesBeforeNow) => {
    const planned = RealDate.parse(`${day}T${utc}:00.000Z`);
    shift = (day === today ? Math.min(planned, RealDate.now() - minutesBeforeNow * 60000) : planned) - RealDate.now();
  };
  let count = 0;
  for (let day = addDays(day0, 1); day <= today; day = addDays(day, 1)) {
    const last = day === today;
    const workday = ![0, 6].includes(weekday(day));
    clock(day, '06:30', 90);
    await withApi(async (api) => {
      if (day.endsWith('-01')) await statements(api, addDays(day, -1).slice(0, 7));
      await newOrders(api, day);
      if (workday) {
        for (const o of await all(db, `SELECT id FROM orders WHERE partner_id IN ${demo} AND status = 'hold' AND updated_at < ?`, hoursAgo(48))) {
          await api.post(`/api/orders/${o.id}/release`, { reason: 'A vevő kérte a küldést.' });
        }
        await receive(api, day);
        clock(day, '08:00', 60);
        await pickAndPack(api, day, last);
        clock(day, '13:15', 30);
        await handOver(api, day, last);
        await reorder(api, day);
        if (last) await newOrders(api, day); // the morning's orders, still new
        else {
          await deliver(api, false);
          await returns(api, day);
          if (weekday(day) === 5) {
            await api.post('/api/billing/entries', { partner_id: pick(clients), date: day, kind: 'hourly_work', qty: int(2, 8) / 2, note: pick(HOURLY_NOTES) });
          }
        }
      }
    });
    if (!last) {
      setClock(day, '20:30');
      await withApi((api) => api.post('/api/billing/snapshot'));
    }
    if (++count % 30 === 0) log(`${day} kész...`);
  }
  // Parcels still on the way count as delivered: the couriers' tracking would ask about made-up numbers.
  await withApi((api) => deliver(api, true));
  const summary = await demoSummary(db);
  const orders = (await first(db, `SELECT COUNT(*) AS n FROM orders WHERE partner_id IN ${demo}`)).n;
  log(`${formatSummary(summary)}\nÖsszesen ${orders} demó rendelés ${day0} óta.`);
  return { created: true, from: day0, orders };
}

// ---------------------------------------------------------------- command line

async function main() {
  const { loadConfig, filesBucket } = await import('./config.mjs');
  const { D1Database } = await import('./d1.mjs');
  const { createAssets } = await import('./assets.mjs');
  const config = loadConfig();
  if (!existsSync(config.dbPath)) throw new Error(`Nem találom az adatbázist: ${config.dbPath}. Állítsd be a DB_PATH változót.`);
  const i = process.argv.indexOf('--months');
  const months = i > 0 ? Number(process.argv[i + 1]) : 6;
  if (!(months > 0 && months <= 24)) throw new Error('A --months 1 és 24 közötti szám legyen.');
  const DB = new D1Database(config.dbPath);
  try {
    const env = { ...config.vars, DB, FILES: filesBucket(config), ASSETS: createAssets(config.assetsDir) };
    const worker = (await import(pathToFileURL(config.worker).href)).default;
    const admin = await first(DB,
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.is_admin = 1 AND u.active = 1 AND u.must_change_password = 0 ORDER BY u.id LIMIT 1`);
    if (!admin) {
      console.error('Nincs aktív adminisztrátor, aki már beállította a saját jelszavát. Lépj be vele egyszer, utána futtasd újra.');
      return 2;
    }
    useSimulatedClock(DB);
    const started = RealDate.now();
    const res = await seedHistory({ worker, env, adminId: admin.id, months });
    if (res.created) console.log(`Kész ${Math.round((RealDate.now() - started) / 1000)} másodperc alatt. Törlés: node server/demo-seed.mjs --remove`);
    return 0;
  } finally {
    DB.close();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`Hiba: ${err.message}`);
      console.error('A félbemaradt demó adatokat így törölheted: node server/demo-seed.mjs --remove');
      process.exitCode = 1;
    });
}
