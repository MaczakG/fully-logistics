// Half a year of demo history. First the demo data of demo-seed.mjs as it stood half a year ago,
// with 47 more webshops (50 clients), three carriers and four suppliers, then every day since replayed
// through the app's own API with this process's clock set to that day:
//   - every client has its own tariff, and the fees of one order (handling, packaging, cash on
//     delivery) are at most 800 Ft net even for the biggest order the script makes;
//   - each client sends 850 to 930 orders a calendar month (a weekend day counts two thirds of a
//     weekday), so every full month ends between 800 and 1000; a few are cancelled or put on hold;
//   - on weekdays the warehouse picks and packs everything it can and hands the parcels to GLS, DPD
//     and Foxpost, the parcels are delivered a day or two later, and a few come back;
//   - a few clients also send pallets to shops and companies: those orders are planned onto the
//     trucks of Duna Cargo and Mátra Logisztika (Fuvartervező) and the trucks leave at noon;
//   - stock is reordered when it runs low, and the delivery is received and put away;
//   - the storage snapshot is taken every evening, hourly work is logged on Fridays, and the
//     monthly statements are made and approved on the 1st.
// Today ends mid-morning: new orders, a wave being picked, packed parcels waiting for the courier,
// today's trucks half planned.
//
// It is the same demo data (DEMO- partners and products), so it all goes with
//   node server/demo-seed.mjs --remove
// Nothing leaves the server: parcels get made-up tracking numbers by hand (no courier API), the
// statements are not invoiced (no invoicing API), the demo clients have no webshop or API key.
//
//   node server/demo-history.mjs [--months 6] [--volume 1]
// --volume scales the number of orders (the tests run a small one).
// The environment is read like server/demo-seed.mjs reads it (DB_PATH and the rest).

import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { all, first, run } from '../worker/lib/db.js';
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

// The three clients of demo-seed.mjs; the others come from MORE_CLIENTS. An order has 1 to 3 of the
// client's products, 1 or 2 pieces each (at most MAX_PIECES pieces).
const SHOPS = {
  'DEMO-MANCS': { ref: '#MB-', next: 10500, cod: 0.4, skus: ['DEMO-MB-001', 'DEMO-MB-002', 'DEMO-MB-003', 'DEMO-MB-004', 'DEMO-MB-005'] },
  'DEMO-BARSONY': { ref: 'BB-', next: 56000, cod: 0.25, skus: ['DEMO-BB-01', 'DEMO-BB-02', 'DEMO-BB-03'] },
  'DEMO-KONYHA': { ref: 'KM-2026-', next: 3400, cod: 0.2, skus: ['DEMO-KM-100', 'DEMO-KM-210', 'DEMO-KM-320', 'DEMO-KM-450'] },
};
const MAX_PIECES = 6;
const MAX_ORDER_FEE = 800; // Ft net: handling, packaging and cash on delivery of one order

// A client's own tariff: random within realistic bounds, the order fee capped at MAX_ORDER_FEE for an
// order of MAX_PIECES pieces with cash on delivery. Pallet clients pay nothing from the 4th piece on.
function tariffFor(pallet) {
  const step = (a, b, s = 5) => a + s * int(0, Math.floor((b - a) / s));
  const t = {
    order_base: step(280, 420), item_2: step(30, 90), item_3: step(20, 70), item_extra: pallet ? 0 : step(10, 35),
    packaging: step(60, 140), cod_fixed: step(0, 80), cod_pct: 0, inbound_unit: step(25, 60), return_unit: step(250, 450, 10),
    hourly_work: step(5000, 7500, 250), discount_handling_pct: chance(0.3) ? int(2, 10) : 0, discount_storage_pct: chance(0.2) ? int(2, 8) : 0, vat_pct: 27,
  };
  const over = orderFee(t, MAX_PIECES, true) - MAX_ORDER_FEE;
  if (over > 0) t.order_base -= over;
  return t;
}
// The fees of one order as the statement counts them (worker/jobs/billing-calc.js), before discounts.
export function orderFee(t, pieces, cod) {
  return t.order_base + (pieces >= 2 ? t.item_2 : 0) + (pieces >= 3 ? t.item_3 : 0) + Math.max(0, pieces - 3) * t.item_extra
    + t.packaging + (cod ? t.cod_fixed : 0);
}
// Weekday orders per day for a monthly volume, in this calendar month (a weekend day counts 0.65).
function weekdayRate(monthly, day) {
  const [y, m] = day.split('-').map(Number);
  const days = new RealDate(Date.UTC(y, m, 0)).getUTCDate();
  let units = 0;
  for (let d = 1; d <= days; d++) units += [0, 6].includes(new RealDate(Date.UTC(y, m - 1, d)).getUTCDay()) ? 0.65 : 1;
  return monthly / units;
}
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
  ['BORPINCE', 'Borpince Online Kft.', '8230', 'Balatonfüred', 'Petőfi Sándor utca 12.', [['Olaszrizling, 0,75 l', 1.3, true], ['Kékfrankos, 0,75 l', 1.3, true], ['Ajándék borosdoboz', 0.4]]],
  ['MEZESKERT', 'Mézeskert Méhészet Bt.', '6100', 'Kiskunfélegyháza', 'Kossuth utca 30.', [['Akácméz, 500 g', 0.6, true], ['Hársméz, 500 g', 0.6, true], ['Propoliszos krém', 0.1, true]]],
  ['GYERTYAMUHELY', 'Gyertyaműhely Kft.', '2500', 'Esztergom', 'Széchenyi tér 9.', [['Illatgyertya, levendula', 0.35], ['Illatgyertya, vanília', 0.35], ['Gyertyatartó, üveg', 0.5]]],
  ['KERTIBUTOR', 'KertiBútor Webáruház Kft.', '7100', 'Szekszárd', 'Rákóczi utca 40.', [['Kerti párna', 0.8], ['Napernyő talp', 9.5], ['Kerti lámpa, napelemes', 0.4]]],
  ['BICAJ', 'Bicaj Kerékpár Alkatrész Kft.', '9022', 'Győr', 'Árpád út 18.', [['Belső gumi, 28"', 0.2], ['Kerékpár lámpa szett', 0.3], ['Lakat, spirál', 0.6]]],
  ['HAZIPATIKA', 'Házipatika Gyógynövény Kft.', '5600', 'Békéscsaba', 'Andrássy út 21.', [['Kamillatea, 50 g', 0.07, true], ['Csipkebogyó tea, 100 g', 0.12, true], ['Gyógynövényes balzsam', 0.1, true]]],
  ['PAPIRSARKANY', 'Papírsárkány Írószer Bt.', '4400', 'Nyíregyháza', 'Dózsa György utca 5.', [['Füzet A5, vonalas', 0.2], ['Színes ceruza, 24 db', 0.35], ['Iskolatáska', 0.9]]],
  ['MANCSAPOLAS', 'Mancsápolás Kft.', '1138', 'Budapest', 'Váci út 152.', [['Kutyasampon, 250 ml', 0.3, true], ['Szőrkefe', 0.15], ['Karomvágó', 0.1]]],
  ['TERMESZETESEN', 'Természetesen Bio Kft.', '8900', 'Zalaegerszeg', 'Kossuth Lajos utca 15.', [['Bio müzli, 750 g', 0.8, true], ['Bio almalé, 1 l', 1.1, true], ['Bio olívaolaj, 0,5 l', 0.55, true]]],
  ['FUSZERKERT', 'Fűszerkert Kft.', '6720', 'Szeged', 'Dugonics tér 2.', [['Szegedi paprika, 100 g', 0.12, true], ['Fűszerkeverék grillhez', 0.1, true], ['Fűszertartó készlet', 0.9]]],
  ['BABAKUCKO', 'Babakuckó Webáruház Kft.', '7400', 'Kaposvár', 'Fő utca 12.', [['Body, 3 db-os', 0.25], ['Babatakaró', 0.5], ['Rágóka', 0.05]]],
  ['ONTOZES', 'Öntözéstechnika Kft.', '6800', 'Hódmezővásárhely', 'Andrássy út 9.', [['Csepegtető szett', 0.9], ['Öntözőidőzítő', 0.4], ['Tömlőcsatlakozó', 0.1]]],
  ['KEMPING', 'Kempingvilág Kft.', '8360', 'Keszthely', 'Kossuth utca 50.', [['Kempingszék', 2.8], ['Hálózsák', 1.6], ['Fejlámpa', 0.15]]],
  ['TECHSAROK', 'TechSarok Kft.', '1117', 'Budapest', 'Október huszonharmadika utca 8.', [['USB-C töltőkábel', 0.05], ['Vezeték nélküli egér', 0.1], ['Powerbank, 10000 mAh', 0.25]]],
  ['MOBILTOK', 'Mobiltok Webshop Bt.', '2800', 'Tatabánya', 'Fő tér 4.', [['Telefontok, szilikon', 0.05], ['Kijelzővédő üveg', 0.03], ['Autós töltő', 0.08]]],
  ['EKSZERDOBOZ', 'Ékszerdoboz Kft.', '1061', 'Budapest', 'Andrássy út 10.', [['Ezüst nyaklánc', 0.05], ['Fülbevaló, acél', 0.02], ['Ékszertartó doboz', 0.3]]],
  ['ORAVILAG', 'Óravilág Kft.', '9021', 'Győr', 'Baross Gábor út 3.', [['Karóra, férfi', 0.2], ['Karóra, női', 0.15], ['Óraszíj, bőr', 0.05]]],
  ['PARFUMERIA', 'Parfüméria Online Kft.', '4025', 'Debrecen', 'Hatvan utca 2.', [['Eau de parfum, 50 ml', 0.3, true], ['Testpermet, 100 ml', 0.2, true], ['Ajándékszett', 0.6, true]]],
  ['SPORTTAPLALEK', 'Sporttáplálék Kft.', '3300', 'Eger', 'Törvényház utca 4.', [['Fehérjepor, 1 kg', 1.1, true], ['Energiaszelet, 12 db', 0.7, true], ['Shaker, 600 ml', 0.15]]],
  ['KONYVMOLY', 'Könyvmoly Antikvárium Bt.', '7621', 'Pécs', 'Ferencesek utcája 20.', [['Regény, keménytáblás', 0.6], ['Krimi, puhatáblás', 0.35], ['Könyvjelző szett', 0.02]]],
  ['JATEKMESTER', 'Játékmester Kft.', '2000', 'Szentendre', 'Bükkös part 20.', [['Kirakós, 1000 db', 0.8], ['Kártyajáték', 0.2], ['Logikai játék', 0.4]]],
  ['KREATIVKUCKO', 'Kreatív Kuckó Kft.', '8000', 'Székesfehérvár', 'Fő utca 7.', [['Gyöngyfűző készlet', 0.3], ['Gyurmakészlet', 0.6], ['Ragasztópisztoly', 0.25]]],
  ['AKVARIUM', 'Akvárium Centrum Kft.', '1095', 'Budapest', 'Soroksári út 60.', [['Haltáp, 250 ml', 0.12, true], ['Akváriumszűrő', 0.7], ['Vízelőkészítő, 500 ml', 0.55, true]]],
  ['MADARETETO', 'Madáretető Kft.', '2700', 'Cegléd', 'Kossuth tér 1.', [['Madáreleség, 2 kg', 2.1, true], ['Madáretető, fa', 1.2], ['Cinkegolyó, 6 db', 0.55, true]]],
  ['FURDOSZOBA', 'Fürdőszoba Kellék Kft.', '6000', 'Kecskemét', 'Izsáki út 4.', [['Zuhanyfej', 0.4], ['Fürdőszobai szőnyeg', 0.8], ['Fogkefetartó', 0.2]]],
  ['TEXTILHAZ', 'Textilház Lakástextil Kft.', '5000', 'Szolnok', 'Baross út 18.', [['Ágyneműhuzat garnitúra', 1.2], ['Törölköző, 70 × 140 cm', 0.5], ['Konyharuha, 3 db', 0.2]]],
  ['LAMPABOLT', 'Lámpabolt Online Kft.', '2600', 'Vác', 'Széchenyi utca 30.', [['Asztali lámpa', 1.4], ['LED szalag, 5 m', 0.3], ['Éjjeli fény', 0.2]]],
  ['SZERSZAMKAMRA', 'Szerszámkamra Kft.', '3534', 'Miskolc', 'Kiss Ernő utca 19.', [['Csavarhúzó készlet', 0.7], ['Mérőszalag, 5 m', 0.25], ['Munkavédelmi kesztyű', 0.1]]],
  ['KAVEFOZO', 'Kávéfőző Szerviz Bt.', '8200', 'Veszprém', 'Kossuth utca 6.', [['Vízkőoldó, 500 ml', 0.55, true], ['Kávégép szűrő', 0.05], ['Tejhabosító kancsó', 0.3]]],
  ['NOVENYHAZ', 'Növényház Kft.', '2310', 'Szigetszentmiklós', 'Gyári út 9.', [['Szobanövény táp, 1 l', 1.05, true], ['Kaspó, kerámia', 1.5], ['Virágcserép alátét', 0.2]]],
];
const MORE_PARTNERS = [
  { type: 'carrier', code: 'DEMO-DPD', name: 'DPD Hungária Kft.', carrier_code: 'dpd', notes: 'Napi futárátadás 15:00 és 16:00 között.' },
  { type: 'carrier', code: 'DEMO-DUNACARGO', name: 'Duna Cargo Szállítmányozási Kft.', zip: '2310', city: 'Szigetszentmiklós', address: 'Leshegy út 30.', notes: 'Raklapos és kamionos fuvarok.' },
  { type: 'carrier', code: 'DEMO-MATRALOG', name: 'Mátra Logisztika Kft.', zip: '3200', city: 'Gyöngyös', address: 'Déli külhatár út 6.', notes: 'Raklapos fuvarok, főleg Észak- és Kelet-Magyarország.' },
  ...[['PANNONPACK', 'Pannon Csomagolóanyag Kft.', '9027', 'Győr'], ['AGROMAG', 'Agro-Mag Kft.', '6800', 'Hódmezővásárhely'], ['EUROKOZMETIK', 'EuroKozmetik Gyártó Kft.', '2600', 'Vác'],
    ['DELPAPIR', 'Dél-Alföldi Papír Zrt.', '6500', 'Baja']]
    .map(([key, name, zip, city]) => ({ type: 'supplier', code: `DEMO-${key}`, name, zip, city, address: 'Ipari park 1.' })),
];

// The trucks of the two carriers that are not couriers: [carrier, plate, name, driver, pallets, kg, in service].
const TRUCKS = [
  ['DEMO-DUNACARGO', 'AE DC-114', 'Iveco Eurocargo 12 t, ponyvás, emelőhátfalas', 'Kiss Gábor', 18, 6000, true],
  ['DEMO-DUNACARGO', 'AE DC-117', 'Mercedes Atego 7,5 t, dobozos', 'Nagy Péter', 15, 3500, true],
  ['DEMO-DUNACARGO', 'AD KL-562', 'Renault Master platós', 'Tóth Ákos', 6, 1200, true],
  ['DEMO-MATRALOG', 'AF ML-208', 'DAF LF 12 t, ponyvás', 'Szabó László', 18, 6000, true],
  ['DEMO-MATRALOG', 'AF ML-311', 'MAN TGL 7,5 t, hűtős', 'Varga Zoltán', 15, 3500, false],
];
// Who orders pallets: the shops and companies the clients deliver to, with their map positions (so
// the planner needs no geocoder for them), and the clients that send to them.
const STORES = [
  ['Kisállat Centrum Kft.', '1106', 'Budapest', 'Örs vezér tere 25.', 47.5032, 19.1366],
  ['Gazdabolt Kecskemét Kft.', '6000', 'Kecskemét', 'Kiskőrösi út 30.', 46.8964, 19.6897],
  ['Szegedi Állateledel Nagyker Kft.', '6728', 'Szeged', 'Dorozsmai út 12.', 46.2690, 20.1080],
  ['Debreceni Kertészet Bt.', '4030', 'Debrecen', 'Mikepércsi út 70.', 47.5100, 21.6250],
  ['Pécsi Konyhafelszerelés Kft.', '7630', 'Pécs', 'Zsolnay Vilmos utca 52.', 46.0760, 18.2500],
  ['Győri Irodaház Üzemeltető Kft.', '9027', 'Győr', 'Gesztenyefa út 4.', 47.6900, 17.6800],
  ['Miskolci Sportcentrum Kft.', '3527', 'Miskolc', 'Pesti út 5.', 48.0900, 20.7700],
  ['Fehérvári Gazdabolt Kft.', '8000', 'Székesfehérvár', 'Takarodó út 1.', 47.1900, 18.4100],
  ['Szolnoki Állatpatika Bt.', '5000', 'Szolnok', 'Thököly út 48.', 47.1750, 20.1900],
  ['Veszprémi Biobolt Kft.', '8200', 'Veszprém', 'Házgyári út 6.', 47.1000, 17.9300],
  ['Egri Vendéglátó Kft.', '3300', 'Eger', 'Faiskola út 5.', 47.8900, 20.3700],
  ['Soproni Kisállat Kft.', '9400', 'Sopron', 'Ipar körút 10.', 47.6800, 16.6100],
  ['Nyíregyházi Gazdakör Kft.', '4400', 'Nyíregyháza', 'Debreceni út 155.', 47.9300, 21.7300],
  ['Kaposvári Kertcentrum Bt.', '7400', 'Kaposvár', 'Füredi utca 160.', 46.3600, 17.8300],
  ['Zalaegerszegi Irodaszer Kft.', '8900', 'Zalaegerszeg', 'Balatoni út 6.', 46.8400, 16.8600],
  ['Tatabányai Háztartási Bolt Kft.', '2800', 'Tatabánya', 'Győri út 9.', 47.5700, 18.4000],
  ['Szombathelyi Sportbolt Kft.', '9700', 'Szombathely', 'Zanati út 30.', 47.2500, 16.6300],
  ['Békéscsabai Gazdabolt Kft.', '5600', 'Békéscsaba', 'Szarvasi út 82.', 46.6900, 21.0700],
  ['Váci Kisállat Bolt Bt.', '2600', 'Vác', 'Zrínyi utca 39.', 47.7800, 19.1300],
  ['Budaörsi Irodapark Kft.', '2040', 'Budaörs', 'Puskás Tivadar utca 12.', 47.4600, 18.9500],
  ['Gödöllői Bioközpont Kft.', '2100', 'Gödöllő', 'Dózsa György út 69.', 47.6000, 19.3500],
  ['Dunaújvárosi Konyha Kft.', '2400', 'Dunaújváros', 'Papírgyári út 2.', 46.9600, 18.9300],
];
const PALLET_CLIENTS = ['DEMO-MANCS', 'DEMO-KONYHA', 'DEMO-ZOLDKERT', 'DEMO-IRODASZER', 'DEMO-BIOKOSAR', 'DEMO-SPORTMAX'];
const DEPOT = { lat: 47.4979, lng: 19.0402 }; // only for sorting the stops around Budapest

// ---------------------------------------------------------------- one day

export async function seedHistory({ worker, env, adminId, months = 6, volume = 1, log = console.log }) {
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
  for (const [code, shop] of Object.entries(shops)) Object.assign(shop, { monthly: int(850, 930), pallet: PALLET_CLIENTS.includes(code) });
  // Pieces a day of one of the shop's products, on average (webshop orders, and pallets for pallet clients).
  const perSkuDay = (shop) => volume * ((shop.monthly / 30) * ((1 + Math.min(3, shop.skus.length)) / 2) * 1.5
    + (shop.pallet ? (5 / PALLET_CLIENTS.length) * 2 * 13 : 0)) / shop.skus.length;
  await withApi((api) => morePartners(api, day0));
  await withApi((api) => setTariffs(api));

  // The other partners, the webshops with their products, and a zone for their goods; each shop's
  // opening stock arrives the next morning.
  async function morePartners(api, start) {
    for (const p of MORE_PARTNERS) await api.post('/api/partners', p);
    const sizes = (await api.get('/api/settings/sizes')).items.filter((z) => z.active);
    const sizeId = (code) => (sizes.find((z) => z.code === code) || sizes[0]).id;
    for (const [size, from, to, pickStart] of [['M', 5, 44, 940], ['L', 45, 54, 1200]]) {
      const body = { prefixes: 'DEMO', separator: '-', pad: 2, rack_from: from, rack_to: to, level_from: 1, level_to: 4, size_id: sizeId(size), kind: 'storage', pick_start: pickStart, note: 'Demó adat' };
      const { codes } = await api.post('/api/settings/locations/bulk', { ...body, preview: true });
      if (!codes.length) continue;
      await api.post('/api/settings/locations/bulk', body);
      await saveDemoSetting(db, (await all(db, 'SELECT id FROM locations WHERE code IN (SELECT value FROM json_each(?))', JSON.stringify(codes))).map((r) => r.id));
    }
    const carriers = Object.fromEntries((await all(db, "SELECT id, code FROM partners WHERE code IN ('DEMO-DUNACARGO', 'DEMO-MATRALOG')")).map((p) => [p.code, p.id]));
    for (const [carrier, plate, name, driver, pallets, maxKg, active] of TRUCKS) {
      await api.post('/api/transport/trucks', { carrier_id: carriers[carrier], plate, name, driver, pallets, max_kg: maxKg, active });
    }
    for (const [, zip, city, address, lat, lng] of STORES) {
      await run(db, 'INSERT OR IGNORE INTO geocodes (address, lat, lng) VALUES (?, ?, ?)', ['HU', zip, city, address].join('|'), lat, lng);
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
      const shop = {
        ref: `${key.slice(0, 2)}-`, next: int(1000, 5000), cod: 0.3, supplier: pick(suppliers), monthly: int(850, 930),
        pallet: PALLET_CLIENTS.includes(code), skus: items.map((_, j) => `${code}-${j + 1}`),
      };
      const lines = [];
      for (const [j, [pname, kg, expiry]] of items.entries()) {
        const p = await api.post('/api/products', { partner_id: id, sku: `${code}-${j + 1}`, name: pname, ean: ean13(++n), weight_kg: kg, min_stock: 10, track_lot: !!expiry, track_expiry: !!expiry });
        // 40 days of sales to start with
        lines.push({ product_id: p.id, expected_qty: Math.max(60, Math.ceil((perSkuDay(shop) * 40) / 10) * 10), lot: expiry ? 'NYITO' : '', expiry: expiry ? addDays(start, 400) : null });
      }
      await api.post('/api/inbound', {
        partner_id: id, external_ref: `${key.slice(0, 2)}-NYITO`, expected_date: start, pallets: 1, cartons: int(4, 20), note: 'Nyitókészlet beszállítása.', lines,
      });
      shops[code] = shop;
    }
  }

  // Every client its own tariff (tariffFor), and storage prices around the default ones.
  async function setTariffs(api) {
    const seen = new Set();
    for (const [code, shop] of Object.entries(shops)) {
      const id = (await first(db, 'SELECT id FROM partners WHERE code = ?', code)).id;
      let t;
      do t = tariffFor(shop.pallet); while (seen.has(JSON.stringify(t)));
      seen.add(JSON.stringify(t));
      const { storage } = await api.get(`/api/partners/${id}/tariffs`);
      await api.put(`/api/partners/${id}/tariffs`, {
        tariffs: t, storage: Object.fromEntries(storage.map((z) => [z.size_id, Math.round((z.default * (0.85 + rnd() * 0.3)) / 10) * 10])),
      });
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
      const rate = volume * weekdayRate(shop.monthly, day) * (weekend ? 0.65 : 1) * (0.92 + rnd() * 0.16);
      const n = Math.floor(rate) + (chance(rate % 1) ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const carrier = pick(['GLS', 'GLS', 'GLS', 'GLS', 'FOXPOST', 'FOXPOST', 'FOXPOST', 'DPD']);
        const foxpost = carrier === 'FOXPOST';
        const [zip, city, street] = pick(PLACES);
        const [last, firstName] = [pick(LAST), pick(FIRST)];
        const skus = [...shop.skus].sort(() => rnd() - 0.5).slice(0, int(1, Math.min(3, shop.skus.length)));
        const o = await api.post('/api/orders', {
          partner_id: partners[code], carrier_id: partners[`DEMO-${carrier}`], ordered_at: hoursAgo(int(1, 20)),
          customer_name: `${last} ${firstName}`, email: `${plain(last)}.${plain(firstName)}@example.com`, phone: `+36 ${pick(['20', '30', '70'])} ${int(200, 999)} ${int(1000, 9999)}`,
          zip, city, address: `${street} ${int(1, 120)}.`, external_number: `${shop.ref}${shop.next++}`,
          cod_amount: chance(shop.cod) ? int(4, 40) * 990 : 0, priority: chance(0.05) ? 'express' : 'normal',
          ...(foxpost ? { pickup_point_id: String(int(1000, 1999)), carrier_service: 'Csomagautomata' } : {}),
          lines: skus.map((sku) => ({ product_id: bySku[sku].id, qty: int(1, 2) })),
        });
        if (chance(0.012)) await api.post(`/api/orders/${o.id}/cancel`, { reason: 'A vevő lemondta, a webshop visszautalta a vételárat.' });
        else if (chance(0.012)) await api.post(`/api/orders/${o.id}/hold`, { reason: 'A vevő kérésére később küldjük.' });
      }
    }
  }

  // Pallets for shops and companies: no courier, the Fuvartervező puts them on a truck.
  async function palletOrders(api, n) {
    for (let i = 0; i < n; i++) {
      const code = pick(PALLET_CLIENTS);
      const [company, zip, city, address] = pick(STORES);
      const skus = [...shops[code].skus].sort(() => rnd() - 0.5).slice(0, int(1, 3));
      await api.post('/api/orders', {
        partner_id: partners[code], customer_name: `${pick(LAST)} ${pick(FIRST)}`, company, phone: `+36 ${pick(['20', '30', '70'])} ${int(200, 999)} ${int(1000, 9999)}`,
        zip, city, address, external_number: `B2B-${int(10000, 99999)}`, pallets: int(1, 4), ordered_at: hoursAgo(int(2, 30)),
        note: pick(['', '', 'Átvétel hétköznap 8 és 15 óra között.', 'Rámpás lerakodás.', 'Előtte telefonáljon a sofőr.']),
        lines: skus.map((sku) => ({ product_id: bySku[sku].id, qty: int(6, 20) })),
      });
    }
  }

  // The day's trucks: the waiting orders around Budapest in order of direction (a sweep), each truck
  // filled up before the next one. Today only every other order is planned, the rest waits.
  async function planTrucks(api, day, last) {
    const plan = await api.get(`/api/transport/planner?date=${day}`);
    const fleet = plan.trucks.filter((t) => t.active);
    const loads = new Map(fleet.map((t) => [t.id, plan.loads.filter((o) => o.truck_id === t.id).map((o) => o.id)]));
    const room = new Map(fleet.map((t) => [t.id, t.pallets - plan.loads.filter((o) => o.truck_id === t.id).reduce((n, o) => n + o.pallets, 0)]));
    const angle = (o) => Math.atan2((o.lat ?? DEPOT.lat) - DEPOT.lat, (o.lng ?? DEPOT.lng) - DEPOT.lng);
    const waiting = plan.orders.filter((o) => o.status !== 'hold').sort((a, b) => angle(a) - angle(b)).filter((_, i) => !last || i % 2 === 0);
    let k = 0;
    for (const o of waiting) {
      while (k < fleet.length && room.get(fleet[k].id) < o.pallets) k++;
      if (k === fleet.length) break;
      loads.get(fleet[k].id).push(o.id);
      room.set(fleet[k].id, room.get(fleet[k].id) - o.pallets);
    }
    const used = [...loads].filter(([, list]) => list.length);
    if (used.length) await api.put('/api/transport/planner', { date: day, loads: used.map(([truckId, list]) => ({ truck_id: truckId, order_ids: list })) });
    return used.map(([truckId]) => truckId);
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
    for (;;) { // a wave holds at most 200 orders
      const page = (await api.get('/api/orders?status=new&availability=ok&limit=200')).items;
      const ready = page.filter((o) => o.availability === 'ok').map((o) => o.id);
      if (ready.length) await api.post('/api/picking/waves', { order_ids: ready, note: weekday(day) === 1 ? 'Hétfői hullám' : 'Reggeli hullám' });
      if (page.length < 200 || !ready.length) break;
    }
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
        const { carrier, pallets } = await first(db, 'SELECT c.carrier_code AS carrier, o.pallets FROM orders o LEFT JOIN partners c ON c.id = o.carrier_id WHERE o.id = ?', o.id);
        await api.post(`/api/picking/orders/${o.id}/pack`, {
          mode: 'manual', package_count: pallets || 1, weight_kg: p.suggested_weight_kg ? Math.round((p.suggested_weight_kg + (pallets ? pallets * 25 : 0.3)) * 10) / 10 : null,
          tracking_number: !carrier ? '' : { foxpost: `CLFOX${2600000000 + o.id * 104729}`, dpd: String(1580000000000 + o.id * 7907) }[carrier] || String(50340000000 + o.id * 7919),
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
      // a big manifest closes in parts: the call answers done: false until every parcel is shipped
      while (!(await api.post(`/api/transport/pickups/${pickupId}/close`, { manifest_number: `${code.slice(5)}-${day.replace(/-/g, '')}` })).done);
    }
  }

  async function deliver(api, all_) {
    const shipped = await all(db, `SELECT id FROM orders WHERE partner_id IN ${demo} AND status = 'shipped' AND shipped_at < ?`, all_ ? nowIso() : hoursAgo(18));
    for (const o of shipped) if (all_ || chance(0.8)) await api.post(`/api/history/${o.id}/delivered`, { note: 'A címzett átvette.' });
  }

  async function returns(api, day) {
    const delivered = await all(db,
      `SELECT id FROM orders WHERE partner_id IN ${demo} AND status = 'delivered' AND pallets = 0 AND delivered_at >= ? AND delivered_at < ?`,
      `${addDays(day, -5)}T00:00:00.000Z`, `${addDays(day, -4)}T00:00:00.000Z`);
    for (const o of delivered) {
      if (!chance(0.01)) continue;
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
      for (const sku of shop.skus) {
        const p = bySku[sku];
        const sold = (await first(db, 'SELECT COALESCE(SUM(ol.qty), 0) AS n FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE ol.product_id = ? AND o.created_at >= ?', p.id, since)).n;
        const perDay = Math.max(sold / 21, perSkuDay(shop), 1);
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
        await palletOrders(api, int(3, 7));
        for (const o of await all(db, `SELECT id FROM orders WHERE partner_id IN ${demo} AND status = 'hold' AND updated_at < ?`, hoursAgo(48))) {
          await api.post(`/api/orders/${o.id}/release`, { reason: 'A vevő kérte a küldést.' });
        }
        await receive(api, day);
        clock(day, '08:00', 60);
        await pickAndPack(api, day, last);
        clock(day, '10:30', 45);
        const trucks = await planTrucks(api, day, last);
        if (!last) {
          clock(day, '11:45', 40);
          for (const id of trucks) await api.post('/api/transport/planner/dispatch', { date: day, truck_id: id }).catch(() => {}); // nothing packed on it
        }
        clock(day, '13:15', 30);
        await handOver(api, day, last);
        await reorder(api, day);
        if (last) { await newOrders(api, day); await palletOrders(api, 2); } // the morning's orders, still new
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
  const v = process.argv.indexOf('--volume');
  const volume = v > 0 ? Number(process.argv[v + 1]) : 1;
  if (!(volume > 0 && volume <= 1)) throw new Error('A --volume 0 és 1 közötti szám legyen.');
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
    const res = await seedHistory({ worker, env, adminId: admin.id, months, volume });
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
