// Invoicing through the Worker: approved statement -> Számlázz.hu or Billingo (a local mock server
// stands in for them, reached through the loopback-only api_base setting) -> PDF in R2, statement
// invoiced. Covers the lock, failures saved on the statement, recovery after a lost answer, the
// late PDF download and the connection test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer } from './helpers.mjs';
import { PERIOD, seedEntries, seedMonth } from './billing-fixture.mjs';

const PDF = Buffer.from('%PDF-1.4 mock számla');
let srv;
let admin;
let mock;
let base;
const ids = {};

// Mock provider: requests are recorded, answers come from a queue (default answers when empty).
const seen = [];
const queue = [];
function startMock() {
  mock = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const entry = { method: req.method, path: req.url, headers: req.headers };
    if ((req.headers['content-type'] || '').includes('multipart/form-data')) {
      const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      entry.field = [...form.keys()][0];
      entry.xml = await form.get(entry.field).text();
    } else if (raw.length) entry.json = JSON.parse(raw.toString('utf8'));
    seen.push(entry);
    const answer = queue.shift() || defaultAnswer(entry);
    res.writeHead(answer.status || 200, answer.headers || {});
    res.end(answer.body ?? '');
  });
  return new Promise((r) => mock.listen(0, '127.0.0.1', r));
}

const szAnswer = (inner, headers = {}) => ({
  headers: { 'content-type': 'application/xml', ...headers },
  body: `<?xml version="1.0" encoding="UTF-8"?><xmlszamlavalasz xmlns="http://www.szamlazz.hu/xmlszamlavalasz">${inner}</xmlszamlavalasz>`,
});
const notFound7 = () => szAnswer('<sikeres>false</sikeres><hibakod>7</hibakod><hibauzenet>Hiányzó adat: számla xml</hibauzenet>', { szlahu_error_code: '7' });
const jsonAnswer = (status, data) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

function defaultAnswer(e) {
  if (e.path === '/szamla/') return notFound7();
  if (e.path.startsWith('/document-blocks')) return jsonAnswer(200, { data: [{ id: 42, name: 'Számlák', prefix: 'FL', type: 'invoice' }] });
  return jsonAnswer(404, { error: { message: 'Not found' } });
}

before(async () => {
  await startMock();
  base = `http://127.0.0.1:${mock.address().port}`;
  srv = await startServer();
  admin = await srv.admin();
  await srv.seedBasics();
  await seedMonth(srv);
  await seedEntries(admin);
  await srv.sql(`UPDATE settings SET value = json_set(value, '$.bank_account', '11773016-01234567-00000000') WHERE key = 'company'`);
  const g = await admin.post('/api/billing/statements/generate', { period: PERIOD });
  for (const s of g.data.statements) ids[s.partner_id] = s.id;
  assert.equal((await admin.post(`/api/billing/statements/${ids[101]}/approve`)).status, 200);
  assert.equal((await admin.post(`/api/billing/statements/${ids[102]}/approve`)).status, 200);
});
after(async () => {
  await srv.stop();
  mock.close();
});

const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
const configure = (provider, settings, credentials) => srv.call('accounts.saveInvoicingConfig', [{ provider, settings: { [provider]: { api_base: base, ...settings } }, credentials: { [provider]: credentials } }]);

test('connection test through the Worker (Számlázz.hu key check)', async () => {
  await configure('szamlazz', { e_invoice: false, send_email: false }, { agent_key: 'Mock-Agent-Key-123' });
  seen.length = 0;
  const r = await srv.call('invoicing.testConnection', ['szamlazz']);
  assert.deepEqual(r.result, { ok: true, message: 'A Számlázz.hu elfogadta a Számla Agent kulcsot.' });
  assert.equal(seen[0].field, 'action-szamla_agent_pdf');
  assert.match(seen[0].xml, /<szamlaagentkulcs>mock-agent-key-123<\/szamlaagentkulcs>/);
  const o = ok(await admin.get(`/api/billing/overview?period=${PERIOD}`));
  assert.deepEqual(o.invoicing, { provider: 'szamlazz', name: 'Számlázz.hu', configured: true });
});

test('a failed attempt is saved on the statement; a lost answer is looked up before trying again', async () => {
  seen.length = 0;
  queue.push({ status: 500, body: 'Internal Server Error' });
  const fail = await admin.post(`/api/billing/statements/${ids[101]}/invoice`);
  assert.equal(fail.status, 502);
  assert.match(fail.data.error.message, /Nem sikerült kiállítani a számlát: A Számlázz.hu szerverhibát jelzett \(HTTP 500\)/);
  let st = ok(await admin.get(`/api/billing/statements/${ids[101]}`));
  assert.equal(st.status, 'approved');
  assert.match(st.invoice_error, /HTTP 500/);
  assert.equal(st.invoice_uncertain, true);
  assert.equal(st.invoice_busy, false, 'the lock is released after a failure');

  // Next attempt: first the lookup by szamlaKulsoAzon (not found), then the invoice.
  seen.length = 0;
  queue.push(notFound7(), szAnswer(`<sikeres>true</sikeres><szamlaszam>FLX-2026-77</szamlaszam><szamlanetto>68064</szamlanetto><szamlabrutto>86442</szamlabrutto><pdf>${PDF.toString('base64')}</pdf>`,
    { szlahu_szamlaszam: 'FLX-2026-77' }));
  const r = ok(await admin.post(`/api/billing/statements/${ids[101]}/invoice`));
  assert.equal(r.invoiceNumber, 'FLX-2026-77');
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(seen.map((e) => e.field), ['action-szamla_agent_pdf', 'action-xmlagentxmlfile']);
  const ref = seen[0].xml.match(/<szamlaKulsoAzon>([^<]+)<\/szamlaKulsoAzon>/)[1];
  assert.match(ref, /^EL-\d{4}-\d{5}-\d{14}$/);
  const xml = seen[1].xml;
  assert.ok(xml.includes(`<szamlaKulsoAzon>${ref}</szamlaKulsoAzon>`));
  assert.match(xml, /<rendelesSzam>EL-\d{4}-\d{5}<\/rendelesSzam>/);
  assert.match(xml, /<vevo>\s*<nev>Kutyabarát Webshop Kft\.<\/nev>\s*<irsz>1111<\/irsz>\s*<telepules>Budapest<\/telepules>\s*<cim>Minta utca 1\.<\/cim>\s*<email>szamla@kutyabarat\.example<\/email>\s*<sendEmail>false<\/sendEmail>\s*<adoalany>1<\/adoalany>\s*<adoszam>12345678-2-13<\/adoszam>/);
  assert.match(xml, /<bankszamlaszam>11773016-01234567-00000000<\/bankszamlaszam>/);
  assert.match(xml, /<megjegyzes>Logisztikai szolgáltatások, elszámolási időszak: 2026\. szeptember \(2026-09-01 és 2026-09-30 között\)\. Elszámolás: EL-/);
  const nets = [...xml.matchAll(/<nettoErtek>(-?\d+)<\/nettoErtek>/g)].map((m) => Number(m[1]));
  const vats = [...xml.matchAll(/<afaErtek>(-?\d+)<\/afaErtek>/g)].map((m) => Number(m[1]));
  assert.equal(nets.length, 17);
  assert.equal(nets.reduce((a, b) => a + b, 0), 68064);
  assert.equal(vats.reduce((a, b) => a + b, 0), 18378);
  // Due date: issued today + 8 payment days; fulfilment date = due date (within 60 days of the period end).
  const due = xml.match(/<fizetesiHataridoDatum>([^<]+)</)[1];
  assert.equal(xml.match(/<teljesitesDatum>([^<]+)</)[1], due <= '2026-11-29' ? due : '2026-11-29');

  st = ok(await admin.get(`/api/billing/statements/${ids[101]}`));
  assert.equal(st.status, 'invoiced');
  assert.equal(st.invoice_number, 'FLX-2026-77');
  assert.equal(st.invoice_provider, 'szamlazz');
  assert.equal(st.invoice_error, '');
  assert.equal(st.invoice_uncertain, false);
  const pdf = await admin.get(`/api/documents/${st.invoice_document_id}`, { raw: true });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), PDF);
  const [doc] = await srv.query('SELECT kind, partner_id, filename FROM documents WHERE id = ?', st.invoice_document_id);
  assert.deepEqual(doc, { kind: 'invoice', partner_id: 101, filename: 'FLX-2026-77.pdf' });

  const logs = await srv.query("SELECT action, ok, status, message FROM integration_log WHERE system = 'szamlazz' AND ref_type = 'statement' ORDER BY id");
  assert.deepEqual(logs.map((l) => [l.action, l.ok]), [['invoice.create', 0], ['invoice.pdf', 0], ['invoice.create', 1]]);
  assert.ok(!JSON.stringify(logs).toLowerCase().includes('mock-agent-key'), 'the agent key is never logged');

  const again = await admin.post(`/api/billing/statements/${ids[101]}/invoice`);
  assert.equal(again.status, 409);
  const o = ok(await admin.get(`/api/billing/overview?period=${PERIOD}`));
  assert.equal(o.kpis.invoiced_net, 68064);
  assert.equal(o.items.find((x) => x.partner_id === 101).invoice_number, 'FLX-2026-77');
});

test('a statement being invoiced cannot be invoiced or voided twice at the same time', async () => {
  await srv.sql(`UPDATE statements SET invoice_lock_at = '${new Date().toISOString()}' WHERE id = ${ids[102]}`);
  const r = await admin.post(`/api/billing/statements/${ids[102]}/invoice`);
  assert.equal(r.status, 409);
  assert.match(r.data.error.message, /folyamatban/);
  assert.equal((await admin.post(`/api/billing/statements/${ids[102]}/void`, { reason: 'x' })).status, 409);
  // A stale lock (older than 5 minutes) no longer blocks.
  await srv.sql(`UPDATE statements SET invoice_lock_at = '2026-01-01T00:00:00.000Z' WHERE id = ${ids[102]}`);
});

test('Billingo: provider errors are shown; then the invoice with a late PDF', async () => {
  await configure('billingo', { block_id: 42, bank_account_id: 0, e_invoice: false }, { api_key: 'bg-mock-key' });
  seen.length = 0;
  queue.push(jsonAnswer(200, { data: [] }), jsonAnswer(201, { id: 77 }),
    jsonAnswer(422, { message: 'The given data was invalid.', errors: [{ field: 'items.0.vat', message: 'Invalid VAT.' }] }));
  const fail = await admin.post(`/api/billing/statements/${ids[102]}/invoice`);
  assert.equal(fail.status, 502);
  assert.match(fail.data.error.message, /A Billingo nem fogadta el az adatokat: items\.0\.vat: Invalid VAT\./);
  const o = ok(await admin.get(`/api/billing/overview?period=${PERIOD}`));
  assert.match(o.items.find((x) => x.partner_id === 102).invoice_error, /Invalid VAT/);
  assert.equal(ok(await admin.get(`/api/billing/statements/${ids[102]}`)).invoice_uncertain, false, 'a clear refusal is not uncertain');

  // Success, but the PDF is not ready for four tries: the statement is invoiced and asks for a retry.
  seen.length = 0;
  queue.push(jsonAnswer(200, { data: [{ id: 77, name: 'Konyhagép Gyártó Zrt.', taxcode: '87654321-2-13', emails: ['penzugy@konyhagep.example'],
    address: { country_code: 'HU', post_code: '6000', city: 'Kecskemét', address: 'Ipari út 5.' } }] }),
  jsonAnswer(201, { id: 9100, invoice_number: 'FL-2026-000100', gross_total: 5396, summary: { net_amount: 4248 } }),
  { status: 202 }, { status: 202 }, { status: 202 }, { status: 202 });
  const r = ok(await admin.post(`/api/billing/statements/${ids[102]}/invoice`));
  assert.equal(r.invoiceNumber, 'FL-2026-000100');
  assert.equal(r.documentId, null);
  assert.match(r.warnings.join(' '), /még készíti a számla PDF-et/);
  assert.deepEqual(seen.map((e) => `${e.method} ${e.path}`).slice(0, 2), ['GET /partners?query=87654321-2-13&per_page=100', 'POST /documents']);
  assert.equal(seen[0].headers['x-api-key'], 'bg-mock-key');
  const body = seen[1].json;
  assert.equal(body.partner_id, 77, 'the existing partner is reused without an update');
  assert.equal(body.block_id, 42);
  assert.equal(body.bank_account_id, undefined);
  assert.equal(body.type, 'invoice');
  assert.equal(body.payment_method, 'wire_transfer');
  assert.match(body.vendor_id, /^EL-\d{4}-\d{5}-\d{14}$/);
  assert.deepEqual(body.items.map((i) => [i.name, i.quantity, i.unit_price, i.vat]), [
    ['Alap rendeléskezelés', 1, 600, '27%'],
    ['Csomagolóanyag', 1, 150, '27%'],
    ['Tárolás, Polchely M (M)', 60, 26, '27%'],
    ['Tárolás, Polchely XL (XL)', 30, 45, '27%'],
    ['Betárolás', 12, 49, '27%'],
  ]);
  let st = ok(await admin.get(`/api/billing/statements/${ids[102]}`));
  assert.equal(st.status, 'invoiced');
  assert.equal(st.invoice_document_id, null);
  assert.match(st.invoice_error, /PDF még nem érhető el/);

  // Retry: only the PDF is downloaded.
  seen.length = 0;
  queue.push({ status: 200, headers: { 'content-type': 'application/pdf' }, body: PDF });
  const again = ok(await admin.post(`/api/billing/statements/${ids[102]}/invoice`));
  assert.deepEqual(seen.map((e) => `${e.method} ${e.path}`), ['GET /documents/9100/download']);
  st = ok(await admin.get(`/api/billing/statements/${ids[102]}`));
  assert.equal(st.invoice_document_id, again.documentId);
  assert.equal(st.invoice_error, '');
  const pdf = await admin.get(`/api/documents/${st.invoice_document_id}?inline=1`, { raw: true });
  assert.match(pdf.headers.get('content-disposition'), /^inline/);
});

test('missing billing data of the client stops the invoice before any call', async () => {
  // A third statement: Kutyabarát, August (the monthly fee and the August order).
  const g = ok(await admin.post('/api/billing/statements/generate', { period: '2026-08', partner_ids: [101] }));
  const id = g.statements[0].id;
  ok(await admin.post(`/api/billing/statements/${id}/approve`));
  await srv.sql("UPDATE partners SET tax_number = '', billing_zip = '', zip = '' WHERE id = 101");
  seen.length = 0;
  const r = await admin.post(`/api/billing/statements/${id}/invoice`);
  assert.equal(r.status, 409);
  assert.equal(r.data.error.message, 'Hiányzik az ügyfél számlázási adata: irányítószám, adószám. Pótold a Partnerek oldalon.');
  assert.equal(seen.length, 0);
  await srv.sql("UPDATE partners SET tax_number = '12345678-2-13', zip = '1111' WHERE id = 101");
});

test('void an invoiced statement only after the invoice was reversed in the invoicing system', async () => {
  const r = await admin.post(`/api/billing/statements/${ids[101]}/void`, { reason: 'Hibás tarifa' });
  assert.equal(r.status, 409);
  assert.match(r.data.error.message, /Előbb sztornózd a számlázóban/);
  ok(await admin.post(`/api/billing/statements/${ids[101]}/void`, { reason: 'Hibás tarifa', invoice_cancelled: true }));
  const st = ok(await admin.get(`/api/billing/statements/${ids[101]}`));
  assert.equal(st.status, 'void');
  assert.match(st.history[0].summary, /érvénytelenítve \(számla: FLX-2026-77, sztornó a számlázóban\): Hibás tarifa/);
  // Rebuilt and approved again, it gets a new external reference for the provider.
  ok(await admin.post('/api/billing/statements/generate', { period: PERIOD, partner_ids: [101] }));
  const rebuilt = ok(await admin.get(`/api/billing/statements/${ids[101]}`));
  assert.deepEqual([rebuilt.status, rebuilt.invoice_number, rebuilt.invoice_document_id], ['draft', '', null]);
});
