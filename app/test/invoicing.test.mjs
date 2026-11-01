// Invoicing adapters with a stubbed fetch: the exact Számlázz.hu XML and Billingo JSON we send,
// parsing of success and error answers, recovery after a lost answer. Runs in Node, no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as szamlazz from '../worker/integrations/invoicing/szamlazz.js';
import * as billingo from '../worker/integrations/invoicing/billingo.js';
import { fulfillmentDate, invoiceItems, listProviders, periodLabel } from '../worker/integrations/invoicing/index.js';

const PDF = new TextEncoder().encode('%PDF-1.4 teszt számla');
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const compact = (xml) => xml.replace(/>\s+</g, '><').trim();

const LINES = [
  { name: 'Alap rendeléskezelés', qty: 5, unit: 'rendelés', price: 650, price_unit: 'Ft', amount: 3250, vat: 878 },
  { name: 'Tárolás, Polchely M (M)', qty: 25, unit: 'helynap', price: 800, price_unit: 'Ft / hely / hó', amount: 667, vat: 180 },
  { name: 'Utánvétkezelés, arányos (1,5%)', qty: 22990, unit: 'Ft', price: 1.5, price_unit: '%', amount: 345, vat: 93 },
  { name: 'Kedvezmény a rendeléskezelésből (10%)', qty: 1, unit: 'tétel', price: -469, price_unit: 'Ft', amount: -469, vat: -127 },
  { name: 'Ár nélküli tárolás', qty: 3, unit: 'helynap', price: 0, price_unit: 'Ft / hely / hó', amount: 0, vat: 0 },
];

function doc(items) {
  return {
    reference: 'EL-2026-00007-20261003101500',
    orderNumber: 'EL-2026-00007',
    period: '2026-09',
    issueDate: '2026-10-03',
    fulfillmentDate: '2026-10-11',
    dueDate: '2026-10-11',
    currency: 'HUF',
    language: 'hu',
    comment: 'Teszt & <megjegyzés>',
    buyer: {
      name: 'Kutyabarát Webshop Kft.', country: 'HU', countryName: 'Magyarország', zip: '1111', city: 'Budapest', address: 'Minta utca 1.',
      email: 'szamla@kutyabarat.example', taxNumber: '12345678-2-13', euVatNumber: '',
    },
    seller: { name: 'Fully Logistics', bankAccount: '11111111-22222222-33333333' },
    items,
    totals: { net: 3793, vat: 1024, gross: 4817 },
  };
}

// fetch stub: answers from a list of handlers, records every request.
function stub(handlers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body };
    if (init.body instanceof FormData) {
      call.fields = [...init.body.keys()];
      const file = init.body.get(call.fields[0]);
      call.fileName = file.name;
      call.fileType = file.type;
      call.xml = await file.text();
    } else if (typeof init.body === 'string') call.json = JSON.parse(init.body);
    calls.push(call);
    const h = handlers.shift();
    if (!h) throw new Error(`unexpected call ${call.method} ${call.url}`);
    return typeof h === 'function' ? h(call) : h;
  };
  fn.calls = calls;
  return fn;
}

const xmlAnswer = (inner, headers = {}) => new Response(`<?xml version="1.0" encoding="UTF-8"?>
<xmlszamlavalasz xmlns="http://www.szamlazz.hu/xmlszamlavalasz" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${inner}</xmlszamlavalasz>`,
{ status: 200, headers: { 'content-type': 'application/xml; charset=UTF-8', ...headers } });
const json = (status, data, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

test('providers describe their forms for Beállítások > Számlázó', () => {
  const list = listProviders();
  assert.deepEqual(list.map((p) => p.code), ['szamlazz', 'billingo']);
  for (const p of list) {
    for (const f of [...p.credentialFields, ...p.settingFields]) {
      assert.ok(f.key && f.label, JSON.stringify(f));
      assert.ok(['text', 'password', 'select', 'number', 'checkbox'].includes(f.type), f.key);
      assert.equal(typeof f.required, 'boolean');
      if (f.type === 'select') assert.ok(Array.isArray(f.options) && f.options.every((o) => o.value && o.label));
    }
  }
  assert.deepEqual(list[0].credentialFields.map((f) => [f.key, f.type, f.required]), [['agent_key', 'password', true]]);
  assert.deepEqual(list[1].credentialFields.map((f) => [f.key, f.type, f.required]), [['api_key', 'password', true]]);
  assert.ok(list[1].settingFields.some((f) => f.key === 'block_id' && f.required));
});

test('invoice items: unit price x quantity always rounds to the statement line', () => {
  const items = invoiceItems(LINES, 27, { decimals: 6, daysInMonth: 30 });
  assert.deepEqual(items, [
    { name: 'Alap rendeléskezelés', qty: 5, unit: 'rendelés', unitPrice: 650, vatPct: 27, net: 3250, vat: 878, gross: 4128, comment: '' },
    { name: 'Tárolás, Polchely M (M)', qty: 25, unit: 'helynap', unitPrice: 26.666667, vatPct: 27, net: 667, vat: 180, gross: 847, comment: '25 helynap, 800 Ft / hely / hó, 30 napos hónap' },
    { name: 'Utánvétkezelés, arányos (1,5%)', qty: 1, unit: 'tétel', unitPrice: 345, vatPct: 27, net: 345, vat: 93, gross: 438, comment: '1,5% x 22 990 Ft' },
    { name: 'Kedvezmény a rendeléskezelésből (10%)', qty: 1, unit: 'tétel', unitPrice: -469, vatPct: 27, net: -469, vat: -127, gross: -596, comment: '' },
  ]);
  // 1 000 location-days at 780 Ft in a 31 day month: 25 161 Ft. 2 decimals (Billingo) cannot express
  // the unit price exactly, so the item becomes one item at the line amount.
  const line = { name: 'Tárolás, Polchely M (M)', qty: 1000, unit: 'helynap', price: 780, price_unit: 'Ft / hely / hó', amount: 25161, vat: 6793 };
  assert.deepEqual(invoiceItems([line], 27, { decimals: 6, daysInMonth: 31 })[0].unitPrice, 25.16129);
  const two = invoiceItems([line], 27, { decimals: 2, daysInMonth: 31 })[0];
  assert.deepEqual([two.qty, two.unit, two.unitPrice, two.net, two.comment], [1, 'tétel', 25161, 25161, '1 000 helynap, 780 Ft / hely / hó, 31 napos hónap']);
});

test('fulfilment date of a monthly settlement and period labels', () => {
  const base = { periodEnd: '2026-09-30', issueDate: '2026-10-03' };
  assert.equal(fulfillmentDate('due_date', { ...base, dueDate: '2026-10-11' }), '2026-10-11');
  assert.equal(fulfillmentDate('due_date', { ...base, dueDate: '2026-12-31' }), '2026-11-29', 'at most 60 days after the period');
  assert.equal(fulfillmentDate('due_date', { ...base, dueDate: '2026-09-20' }), '2026-09-30');
  assert.equal(fulfillmentDate('period_end', { ...base, dueDate: '2026-10-11' }), '2026-09-30');
  assert.equal(fulfillmentDate('issue_date', { ...base, dueDate: '2026-10-11' }), '2026-10-03');
  assert.equal(periodLabel('2026-09'), '2026. szeptember');
  assert.equal(periodLabel('2027-01'), '2027. január');
});

const SZ_CREDS = { agent_key: 'ABC123Key ' };
const SZ_SETTINGS = { e_invoice: true, prefix: 'FLX', bank_name: 'OTP Bank', send_email: true, language: 'hu' };

test('Számlázz.hu: the exact invoice XML (xmlszamla.xsd order, escaping, rounding)', () => {
  const items = invoiceItems(LINES, 27, { decimals: 6, daysInMonth: 30 });
  const xml = szamlazz.buildInvoiceXml(doc(items), { agentKey: 'abc123key', settings: SZ_SETTINGS });
  assert.equal(compact(xml), '<?xml version="1.0" encoding="UTF-8"?>'
    + '<xmlszamla xmlns="http://www.szamlazz.hu/xmlszamla" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.szamlazz.hu/xmlszamla https://www.szamlazz.hu/szamla/docs/xsds/agent/xmlszamla.xsd">'
    + '<beallitasok><szamlaagentkulcs>abc123key</szamlaagentkulcs><eszamla>true</eszamla><szamlaLetoltes>true</szamlaLetoltes><valaszVerzio>2</valaszVerzio>'
    + '<szamlaKulsoAzon>EL-2026-00007-20261003101500</szamlaKulsoAzon></beallitasok>'
    + '<fejlec><keltDatum>2026-10-03</keltDatum><teljesitesDatum>2026-10-11</teljesitesDatum><fizetesiHataridoDatum>2026-10-11</fizetesiHataridoDatum>'
    + '<fizmod>Átutalás</fizmod><penznem>HUF</penznem><szamlaNyelve>hu</szamlaNyelve><megjegyzes>Teszt &amp; &lt;megjegyzés&gt;</megjegyzes>'
    + '<rendelesSzam>EL-2026-00007</rendelesSzam><elolegszamla>false</elolegszamla><vegszamla>false</vegszamla><helyesbitoszamla>false</helyesbitoszamla>'
    + '<dijbekero>false</dijbekero><szamlaszamElotag>FLX</szamlaszamElotag></fejlec>'
    + '<elado><bank>OTP Bank</bank><bankszamlaszam>11111111-22222222-33333333</bankszamlaszam></elado>'
    + '<vevo><nev>Kutyabarát Webshop Kft.</nev><irsz>1111</irsz><telepules>Budapest</telepules><cim>Minta utca 1.</cim>'
    + '<email>szamla@kutyabarat.example</email><sendEmail>true</sendEmail><adoalany>1</adoalany><adoszam>12345678-2-13</adoszam></vevo>'
    + '<tetelek>'
    + '<tetel><megnevezes>Alap rendeléskezelés</megnevezes><mennyiseg>5</mennyiseg><mennyisegiEgyseg>rendelés</mennyisegiEgyseg><nettoEgysegar>650</nettoEgysegar>'
    + '<afakulcs>27</afakulcs><nettoErtek>3250</nettoErtek><afaErtek>878</afaErtek><bruttoErtek>4128</bruttoErtek></tetel>'
    + '<tetel><megnevezes>Tárolás, Polchely M (M)</megnevezes><mennyiseg>25</mennyiseg><mennyisegiEgyseg>helynap</mennyisegiEgyseg><nettoEgysegar>26.666667</nettoEgysegar>'
    + '<afakulcs>27</afakulcs><nettoErtek>667</nettoErtek><afaErtek>180</afaErtek><bruttoErtek>847</bruttoErtek><megjegyzes>25 helynap, 800 Ft / hely / hó, 30 napos hónap</megjegyzes></tetel>'
    + '<tetel><megnevezes>Utánvétkezelés, arányos (1,5%)</megnevezes><mennyiseg>1</mennyiseg><mennyisegiEgyseg>tétel</mennyisegiEgyseg><nettoEgysegar>345</nettoEgysegar>'
    + '<afakulcs>27</afakulcs><nettoErtek>345</nettoErtek><afaErtek>93</afaErtek><bruttoErtek>438</bruttoErtek><megjegyzes>1,5% x 22 990 Ft</megjegyzes></tetel>'
    + '<tetel><megnevezes>Kedvezmény a rendeléskezelésből (10%)</megnevezes><mennyiseg>1</mennyiseg><mennyisegiEgyseg>tétel</mennyisegiEgyseg><nettoEgysegar>-469</nettoEgysegar>'
    + '<afakulcs>27</afakulcs><nettoErtek>-469</nettoErtek><afaErtek>-127</afaErtek><bruttoErtek>-596</bruttoErtek></tetel>'
    + '</tetelek></xmlszamla>');
  // Foreign EU buyer: country name, EU VAT number, tax status 6, no Hungarian tax number.
  const eu = doc(items);
  eu.buyer = { ...eu.buyer, country: 'AT', countryName: 'Ausztria', taxNumber: '', euVatNumber: 'ATU12345678' };
  const euXml = compact(szamlazz.buildInvoiceXml(eu, { agentKey: 'k', settings: {} }));
  assert.match(euXml, /<vevo><nev>Kutyabarát Webshop Kft\.<\/nev><orszag>Ausztria<\/orszag><irsz>1111<\/irsz>.*<sendEmail>false<\/sendEmail><adoalany>6<\/adoalany><adoszamEU>ATU12345678<\/adoszamEU><\/vevo>/);
  assert.match(euXml, /<eszamla>false<\/eszamla>/);
  assert.doesNotMatch(euXml, /szamlaszamElotag|<bank>/);
});

test('Számlázz.hu: issue posts the XML as action-xmlagentxmlfile and reads the XML answer', async () => {
  const f = stub([xmlAnswer(`<sikeres>true</sikeres><szamlaszam>FLX-2026-12</szamlaszam><szamlanetto>3793</szamlanetto><szamlabrutto>4817</szamlabrutto>
    <kintlevoseg>4817</kintlevoseg><pdf>${b64(PDF).replace(/(.{20})/g, '$1\n')}</pdf>`, { szlahu_szamlaszam: encodeURIComponent('FLX-2026-12') })]);
  const logs = [];
  const items = invoiceItems(LINES, 27);
  const r = await szamlazz.issue(doc(items), { credentials: SZ_CREDS, settings: SZ_SETTINGS, fetch: f, log: async (...a) => logs.push(a) });
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.equal(c.url, 'https://www.szamlazz.hu/szamla/');
  assert.equal(c.method, 'POST');
  assert.deepEqual(c.fields, ['action-xmlagentxmlfile']);
  assert.equal(c.fileName, 'request.xml');
  assert.equal(c.fileType, 'text/xml');
  assert.equal(c.xml, szamlazz.buildInvoiceXml(doc(items), { agentKey: 'abc123key', settings: SZ_SETTINGS }), 'agent key trimmed and lower case');
  assert.equal(r.invoiceNumber, 'FLX-2026-12');
  assert.deepEqual([...r.pdf], [...PDF]);
  assert.equal(r.gross, 4817);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(logs, [['invoice.create', true, 200, 'Számla: FLX-2026-12']]);
  assert.ok(!JSON.stringify(logs).includes('abc123key'), 'the key is never logged');
});

test('Számlázz.hu: error answers become Hungarian messages; lost answers are marked uncertain', async () => {
  const items = invoiceItems(LINES, 27);
  const login = stub([xmlAnswer('<sikeres>false</sikeres><hibakod>3</hibakod><hibauzenet><![CDATA[Sikertelen bejelentkezés]]></hibauzenet>', { szlahu_error_code: '3', szlahu_error: encodeURIComponent('Sikertelen bejelentkezés') })]);
  await assert.rejects(szamlazz.issue(doc(items), { credentials: SZ_CREDS, settings: {}, fetch: login }), (e) => {
    assert.match(e.message, /Számla Agent kulcsot/);
    assert.equal(e.uncertain, false);
    assert.equal(e.providerCode, '3');
    return true;
  });
  // Plain text answer (valaszVerzio 1 style) with the code in the header.
  const dup = stub([new Response('[ERR] Már létező rendelésszám: EL-2026-00007. ---------- t.getMessage(): ...', { status: 200, headers: { szlahu_error_code: '152' } })]);
  await assert.rejects(szamlazz.issue(doc(items), { credentials: SZ_CREDS, settings: {}, fetch: dup }), /már van számla ezzel a rendelésszámmal/);
  const sums = stub([xmlAnswer('<sikeres>false</sikeres><hibakod>260</hibakod><hibauzenet>A tétel áfa értéke nem megfelelő. Termék: X</hibauzenet>')]);
  await assert.rejects(szamlazz.issue(doc(items), { credentials: SZ_CREDS, settings: {}, fetch: sums }), /nem fogadta el a számla adatait \(260\): A tétel áfa értéke/);
  const down = stub([new Response('Service Unavailable', { status: 503 })]);
  await assert.rejects(szamlazz.issue(doc(items), { credentials: SZ_CREDS, settings: {}, fetch: down }), (e) => e.uncertain === true && /HTTP 503/.test(e.message));
  const net = stub([() => { throw new TypeError('fetch failed'); }]);
  await assert.rejects(szamlazz.issue(doc(items), { credentials: SZ_CREDS, settings: {}, fetch: net }), (e) => e.uncertain === true);
  await assert.rejects(szamlazz.issue(doc(items), { credentials: {}, settings: {}, fetch: stub([]) }), /Hiányzik a Számla Agent kulcs/);
});

test('Számlázz.hu: recovery looks the invoice up by szamlaKulsoAzon before creating it again', async () => {
  const items = invoiceItems(LINES, 27);
  // Not found (error 7): create it.
  const f = stub([
    xmlAnswer('<sikeres>false</sikeres><hibakod>7</hibakod><hibauzenet>Hiányzó adat: számla xml</hibauzenet>'),
    xmlAnswer(`<sikeres>true</sikeres><szamlaszam>FLX-2026-13</szamlaszam><szamlanetto>3793</szamlanetto><szamlabrutto>4817</szamlabrutto><pdf>${b64(PDF)}</pdf>`),
  ]);
  const r = await szamlazz.issue(doc(items), { credentials: SZ_CREDS, settings: {}, fetch: f, recover: true });
  assert.deepEqual(f.calls.map((c) => c.fields[0]), ['action-szamla_agent_pdf', 'action-xmlagentxmlfile']);
  assert.equal(compact(f.calls[0].xml), '<?xml version="1.0" encoding="UTF-8"?>'
    + '<xmlszamlapdf xmlns="http://www.szamlazz.hu/xmlszamlapdf" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.szamlazz.hu/xmlszamlapdf https://www.szamlazz.hu/szamla/docs/xsds/agentpdf/xmlszamlapdf.xsd">'
    + '<szamlaagentkulcs>abc123key</szamlaagentkulcs><valaszVerzio>2</valaszVerzio><szamlaKulsoAzon>EL-2026-00007-20261003101500</szamlaKulsoAzon></xmlszamlapdf>');
  assert.equal(r.recovered, false);
  assert.equal(r.invoiceNumber, 'FLX-2026-13');
  // Found: no second invoice.
  const g = stub([xmlAnswer(`<sikeres>true</sikeres><szamlaszam>FLX-2026-12</szamlaszam><szamlanetto>3793</szamlanetto><szamlabrutto>4817</szamlabrutto><pdf>${b64(PDF)}</pdf>`)]);
  const found = await szamlazz.issue(doc(items), { credentials: SZ_CREDS, settings: {}, fetch: g, recover: true });
  assert.equal(g.calls.length, 1);
  assert.deepEqual([found.recovered, found.invoiceNumber], [true, 'FLX-2026-12']);
  // The lookup itself fails: still uncertain, nothing created.
  const h = stub([xmlAnswer('<sikeres>false</sikeres><hibakod>3</hibakod><hibauzenet>x</hibauzenet>')]);
  await assert.rejects(szamlazz.issue(doc(items), { credentials: SZ_CREDS, settings: {}, fetch: h, recover: true }), (e) => e.uncertain === true);
  assert.equal(h.calls.length, 1);
});

test('Számlázz.hu: connection test and PDF download', async () => {
  const okTest = await szamlazz.test({ credentials: SZ_CREDS, fetch: stub([xmlAnswer('<sikeres>false</sikeres><hibakod>7</hibakod><hibauzenet>nincs</hibauzenet>')]) });
  assert.deepEqual(okTest, { ok: true, message: 'A Számlázz.hu elfogadta a Számla Agent kulcsot.' });
  const bad = await szamlazz.test({ credentials: SZ_CREDS, fetch: stub([xmlAnswer('<sikeres>false</sikeres><hibakod>3</hibakod><hibauzenet>x</hibauzenet>')]) });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /Sikertelen bejelentkezés/);
  assert.equal((await szamlazz.test({ credentials: {} })).ok, false);
  const f = stub([new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf', szlahu_szamlaszam: 'FLX-2026-12' } })]);
  const { pdf } = await szamlazz.fetchPdf({ invoiceNumber: 'FLX-2026-12', externalId: 'x' }, { credentials: SZ_CREDS, fetch: f });
  assert.deepEqual([...pdf], [...PDF]);
  assert.match(f.calls[0].xml, /<szamlaszam>FLX-2026-12<\/szamlaszam>/);
});

// ---------------------------------------------------------------- Billingo

const BG_CREDS = { api_key: 'bg-secret-key' };
const BG_SETTINGS = { block_id: 42, bank_account_id: 7, e_invoice: true, language: 'hu', send_email: true };
const API = 'https://api.billingo.hu/v3';

test('Billingo: VAT codes', () => {
  assert.equal(billingo.vatCode(27), '27%');
  assert.equal(billingo.vatCode(5.5), '5,5%');
  assert.equal(billingo.vatCode(0), '0%');
  assert.throws(() => billingo.vatCode(33), /33% ÁFA kulcs a Billingóban nem használható/);
});

test('Billingo: creates the partner, the invoice, e-mails it and downloads the PDF after a 202', async () => {
  const items = invoiceItems(LINES, 27, { decimals: 2, daysInMonth: 30 });
  const f = stub([
    json(200, { data: [{ id: 3, name: 'Más Kft.', taxcode: '99999999-2-13' }], total: 1 }),
    json(201, { id: 55, name: 'Kutyabarát Webshop Kft.' }),
    json(201, { id: 9001, invoice_number: 'FL-2026-000012', gross_total: 4817, summary: { net_amount: 3793 } }),
    json(200, { emails: ['szamla@kutyabarat.example'] }),
    new Response(null, { status: 202 }),
    new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } }),
  ]);
  const sleeps = [];
  const logs = [];
  const r = await billingo.issue(doc(items), { credentials: BG_CREDS, settings: BG_SETTINGS, fetch: f, sleep: async (ms) => sleeps.push(ms), log: async (...a) => logs.push(a) });
  assert.deepEqual(f.calls.map((c) => `${c.method} ${c.url}`), [
    `GET ${API}/partners?query=12345678-2-13&per_page=100`,
    `POST ${API}/partners`,
    `POST ${API}/documents`,
    `POST ${API}/documents/9001/send`,
    `GET ${API}/documents/9001/download`,
    `GET ${API}/documents/9001/download`,
  ]);
  for (const c of f.calls) assert.equal(c.headers['X-API-KEY'], 'bg-secret-key');
  assert.equal(f.calls[1].headers['content-type'], 'application/json');
  assert.equal(f.calls[4].headers.accept, 'application/pdf');
  assert.deepEqual(f.calls[1].json, {
    name: 'Kutyabarát Webshop Kft.',
    address: { country_code: 'HU', post_code: '1111', city: 'Budapest', address: 'Minta utca 1.' },
    emails: ['szamla@kutyabarat.example'],
    taxcode: '12345678-2-13',
    tax_type: 'HAS_TAX_NUMBER',
  });
  assert.deepEqual(f.calls[2].json, {
    vendor_id: 'EL-2026-00007-20261003101500',
    partner_id: 55,
    block_id: 42,
    type: 'invoice',
    fulfillment_date: '2026-10-11',
    due_date: '2026-10-11',
    payment_method: 'wire_transfer',
    language: 'hu',
    currency: 'HUF',
    conversion_rate: 1,
    electronic: true,
    paid: false,
    items: [
      { name: 'Alap rendeléskezelés', unit_price: 650, unit_price_type: 'net', quantity: 5, unit: 'rendelés', vat: '27%' },
      { name: 'Tárolás, Polchely M (M)', unit_price: 26.67, unit_price_type: 'net', quantity: 25, unit: 'helynap', vat: '27%', comment: '25 helynap, 800 Ft / hely / hó, 30 napos hónap' },
      { name: 'Utánvétkezelés, arányos (1,5%)', unit_price: 345, unit_price_type: 'net', quantity: 1, unit: 'tétel', vat: '27%', comment: '1,5% x 22 990 Ft' },
      { name: 'Kedvezmény a rendeléskezelésből (10%)', unit_price: -469, unit_price_type: 'net', quantity: 1, unit: 'tétel', vat: '27%' },
    ],
    comment: 'Teszt & <megjegyzés>',
    settings: { round: 'none', order_number: 'EL-2026-00007' },
    bank_account_id: 7,
  });
  assert.deepEqual(f.calls[3].json, { emails: ['szamla@kutyabarat.example'] });
  assert.deepEqual(sleeps, [1000]);
  assert.deepEqual([r.invoiceNumber, r.externalId, r.gross, r.net], ['FL-2026-000012', '9001', 4817, 3793]);
  assert.deepEqual([...r.pdf], [...PDF]);
  assert.deepEqual(r.warnings, []);
  assert.ok(!JSON.stringify(logs).includes('bg-secret-key'));
});

test('Billingo: an existing partner is reused and updated when its billing data changed', async () => {
  const items = invoiceItems(LINES.slice(0, 1), 27, { decimals: 2 });
  const existing = { id: 55, name: 'Kutyabarát Kft.', taxcode: '12345678213', emails: [], address: { country_code: 'HU', post_code: '1111', city: 'Budapest', address: 'Régi utca 2.' }, custom_billing_settings: { due_days: 8 } };
  const f = stub([
    json(200, { data: [existing] }),
    json(200, { ...existing }),
    json(201, { id: 9002, invoice_number: 'FL-2026-000013', gross_total: 4128 }),
    new Response(PDF, { status: 200 }),
  ]);
  const d = doc(items);
  d.totals = { net: 3250, vat: 878, gross: 4128 };
  const r = await billingo.issue(d, { credentials: BG_CREDS, settings: { block_id: 42 }, fetch: f, sleep: async () => {} });
  assert.equal(f.calls[1].method, 'PUT');
  assert.equal(f.calls[1].url, `${API}/partners/55`);
  assert.deepEqual(f.calls[1].json, {
    name: 'Kutyabarát Webshop Kft.', taxcode: '12345678-2-13', tax_type: 'HAS_TAX_NUMBER', emails: ['szamla@kutyabarat.example'],
    address: { country_code: 'HU', post_code: '1111', city: 'Budapest', address: 'Minta utca 1.' }, custom_billing_settings: { due_days: 8 },
  });
  assert.equal(f.calls[2].json.partner_id, 55);
  assert.equal(f.calls[2].json.bank_account_id, undefined);
  assert.equal(r.invoiceNumber, 'FL-2026-000013');
});

test('Billingo: errors, recovery by vendor_id and the connection test', async () => {
  const items = invoiceItems(LINES.slice(0, 1), 27, { decimals: 2 });
  const invalid = stub([
    json(200, { data: [] }),
    json(201, { id: 55 }),
    json(422, { message: 'The given data was invalid.', errors: [{ field: 'block_id', message: 'The selected block id is invalid.' }] }),
  ]);
  await assert.rejects(billingo.issue(doc(items), { credentials: BG_CREDS, settings: { block_id: 42 }, fetch: invalid }), (e) => {
    assert.equal(e.message, 'A Billingo nem fogadta el az adatokat: block_id: The selected block id is invalid.');
    assert.equal(e.uncertain, false);
    return true;
  });
  const unauthorized = stub([json(401, { error: { message: 'Authorization information is missing or invalid.' } })]);
  await assert.rejects(billingo.issue(doc(items), { credentials: BG_CREDS, settings: { block_id: 42 }, fetch: unauthorized }), /nem fogadta el az API kulcsot/);
  const busy = stub([json(200, { data: [] }), json(201, { id: 55 }), json(429, { error: { message: 'Too many requests' } }, { 'retry-after': '30' })]);
  await assert.rejects(billingo.issue(doc(items), { credentials: BG_CREDS, settings: { block_id: 42 }, fetch: busy }), /30 másodperc múlva/);
  const lost = stub([json(200, { data: [] }), json(201, { id: 55 }), json(502, { error: { message: 'Bad gateway', trace_id: 'x' } })]);
  await assert.rejects(billingo.issue(doc(items), { credentials: BG_CREDS, settings: { block_id: 42 }, fetch: lost }), (e) => e.uncertain === true);
  await assert.rejects(billingo.issue(doc(items), { credentials: BG_CREDS, settings: {}, fetch: stub([]) }), /számlatömb azonosító/);

  // Recovery: the invoice exists under the vendor id, so only its PDF is fetched.
  const rec = stub([json(200, { id: 9001, invoice_number: 'FL-2026-000012', gross_total: 4128, cancelled: false }), new Response(PDF, { status: 200 })]);
  const r = await billingo.issue(doc(items), { credentials: BG_CREDS, settings: { block_id: 42 }, fetch: rec, recover: true, sleep: async () => {} });
  assert.deepEqual(rec.calls.map((c) => c.url), [`${API}/documents/vendor/EL-2026-00007-20261003101500`, `${API}/documents/9001/download`]);
  assert.deepEqual([r.recovered, r.invoiceNumber, r.externalId], [true, 'FL-2026-000012', '9001']);
  // Not found under the vendor id: create as usual.
  const fresh = stub([json(404, { error: { message: 'Not found' } }), json(200, { data: [] }), json(201, { id: 55 }), json(201, { id: 9003, invoice_number: 'FL-3' }), new Response(PDF, { status: 200 })]);
  const r2 = await billingo.issue(doc(items), { credentials: BG_CREDS, settings: { block_id: 42 }, fetch: fresh, recover: true, sleep: async () => {} });
  assert.equal(r2.invoiceNumber, 'FL-3');

  const blocks = { data: [{ id: 42, name: 'Számlák', prefix: 'FL', type: 'invoice' }, { id: 43, name: 'Teszt', prefix: '', type: 'invoice' }] };
  assert.deepEqual(await billingo.test({ credentials: BG_CREDS, settings: { block_id: 42 }, fetch: stub([json(200, blocks)]) }), { ok: true, message: 'A Billingo kapcsolat rendben. Számlatömb: Számlák (FL).' });
  const wrong = await billingo.test({ credentials: BG_CREDS, settings: { block_id: 99 }, fetch: stub([json(200, blocks)]) });
  assert.deepEqual(wrong, { ok: false, message: 'A(z) 99 számlatömb nem található. Elérhető számlatömbök: 42 (Számlák, FL), 43 (Teszt).' });
  const bank = await billingo.test({ credentials: BG_CREDS, settings: { block_id: 42, bank_account_id: 5 }, fetch: stub([json(200, blocks), json(200, { data: [{ id: 7, name: 'OTP' }] })]) });
  assert.equal(bank.ok, false);
  assert.match(bank.message, /5 bankszámla nem található. Elérhető bankszámlák: 7 \(OTP\)/);
  assert.equal((await billingo.test({ credentials: BG_CREDS, settings: {}, fetch: stub([json(401, {})]) })).ok, false);
});

test('adapters only accept loopback addresses as a test endpoint', async () => {
  const f = stub([xmlAnswer('<sikeres>false</sikeres><hibakod>7</hibakod><hibauzenet>x</hibauzenet>')]);
  await szamlazz.test({ credentials: SZ_CREDS, settings: { api_base: 'https://evil.example' }, fetch: f });
  assert.equal(f.calls[0].url, 'https://www.szamlazz.hu/szamla/');
  const g = stub([xmlAnswer('<sikeres>false</sikeres><hibakod>7</hibakod><hibauzenet>x</hibauzenet>')]);
  await szamlazz.test({ credentials: SZ_CREDS, settings: { api_base: 'http://127.0.0.1:9999' }, fetch: g });
  assert.equal(g.calls[0].url, 'http://127.0.0.1:9999/szamla/');
  const h = stub([json(200, { data: [] })]);
  await billingo.test({ credentials: BG_CREDS, settings: { api_base: 'http://localhost.evil.example' }, fetch: h });
  assert.equal(h.calls[0].url, `${API}/document-blocks?type=invoice&per_page=100`);
});
