// Billingo API v3, following the official OpenAPI document (Billingo API v3, 3.0.14 / 3.0.15 on
// SwaggerHub, server https://api.billingo.hu/v3, authentication header X-API-KEY).
//
//   GET  /partners?query=<tax number>   find the client by tax number
//   POST /partners                      create it when missing (Partner)
//   PUT  /partners/{id}                 update name, address, e-mail when they changed
//   POST /documents                     create the invoice (DocumentInsert, type "invoice")
//   POST /documents/{id}/send           e-mail it to the client (optional setting)
//   GET  /documents/{id}/download       the PDF (202 while it is being generated)
//   GET  /documents/vendor/{vendor_id}  look up an invoice whose creation answer got lost
//   GET  /document-blocks, /bank-accounts  connection test
//
// Errors: 400/401/403/404 { error: { message } }, 402 subscription, 422 { message, errors: [{ field,
// message }] }, 429 with Retry-After, 5xx { error: { message, trace_id } }.
// Items are sent with net unit prices (unit_price_type "net"); Billingo computes VAT. The adapter
// only sends unit prices with at most 2 decimals whose quantity x price rounds to the statement's
// line amount, so Billingo's line totals equal the statement's (index.js invoiceItems).

import { FULFILLMENT_HELP, FULFILLMENT_OPTIONS, LANGUAGE_OPTIONS, ProviderError, baseUrl, defaultFetch, defaultSleep, isTimeout, noLog } from './common.js';

export const code = 'billingo';
export const name = 'Billingo';
export const docsUrl = 'https://app.swaggerhub.com/apis/Billingo/Billingo/3.0.14';
export const API = 'https://api.billingo.hu/v3';

export const credentialFields = [
  {
    key: 'api_key', label: 'API kulcs (v3)', type: 'password', required: true, options: null,
    help: 'Billingo: Beállítások > API (app.billingo.hu/api-key). Számlák írása joggal.',
  },
];

export const settingFields = [
  { key: 'block_id', label: 'Számlatömb azonosító', type: 'number', required: true, options: null, help: 'A kapcsolat tesztje kilistázza az elérhető számlatömböket és azonosítójukat.' },
  { key: 'bank_account_id', label: 'Bankszámla azonosító', type: 'number', required: false, options: null, help: 'A számlán megjelenő bankszámla Billingo azonosítója. Üresen a fiók alapértelmezése.' },
  { key: 'e_invoice', label: 'E-számla', type: 'checkbox', required: false, options: null, help: 'Elektronikus számla kiállítása.' },
  { key: 'language', label: 'Számla nyelve', type: 'select', required: false, options: LANGUAGE_OPTIONS, help: '' },
  { key: 'fulfillment_date', label: 'Teljesítés dátuma', type: 'select', required: false, options: FULFILLMENT_OPTIONS, help: FULFILLMENT_HELP },
  { key: 'send_email', label: 'Számla küldése e-mailben az ügyfél számlázási címére', type: 'checkbox', required: false, options: null, help: 'A Billingo küldi ki a kiállítás után.' },
];

export const isConfigured = (credentials = {}, settings = {}) => !!String(credentials.api_key || '').trim() && Number(settings.block_id) > 0;

// Billingo's VAT codes for percentage rates ("27%", "5,5%").
const VAT_CODES = new Set(['0%', '1%', '2%', '3%', '4%', '5%', '5,5%', '6%', '7%', '7,7%', '8%', '8,1%', '9%', '9,5%', '10%', '11%', '12%', '13%', '13,5%',
  '14%', '15%', '16%', '17%', '18%', '19%', '20%', '21%', '22%', '23%', '24%', '25%', '25,5%', '26%', '27%']);
export function vatCode(pct) {
  const c = `${String(Math.round(Number(pct) * 10) / 10).replace('.', ',')}%`;
  if (!VAT_CODES.has(c)) throw new ProviderError(`A(z) ${c} ÁFA kulcs a Billingóban nem használható.`);
  return c;
}

const digits = (s) => String(s || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();

// ---------------------------------------------------------------- HTTP

function errorMessage(status, body, retryAfter) {
  const msg = (body && body.error && body.error.message) || (body && body.message) || '';
  const details = body && Array.isArray(body.errors) ? body.errors.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).join('; ') : '';
  if (status === 401) return 'A Billingo nem fogadta el az API kulcsot. Ellenőrizd a Beállítások > Számlázó oldalon.';
  if (status === 402) return 'A Billingo előfizetésed nem teszi lehetővé ezt a műveletet.';
  if (status === 403) return `A Billingo API kulcsnak nincs joga ehhez a művelethez.${msg ? ` (${msg})` : ''}`;
  if (status === 429) return `Túl sok kérés a Billingo felé. Próbáld újra${retryAfter ? ` ${retryAfter} másodperc múlva` : ' később'}.`;
  if (status === 422) return `A Billingo nem fogadta el az adatokat: ${details || msg || 'érvénytelen adatok'}`;
  if (status >= 500) return `A Billingo szerverhibát jelzett (HTTP ${status}).`;
  return `Billingo hiba (HTTP ${status})${msg ? `: ${msg}` : ''}`;
}

function client({ apiKey, settings, fetch: f, log }) {
  const base = baseUrl(settings, API);
  async function call(method, path, { body, action, accept = 'application/json', okStatuses = [] } = {}) {
    const headers = { 'X-API-KEY': apiKey, accept };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await f(`${base}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    } catch (err) {
      await log(action, false, null, isTimeout(err) ? 'Időtúllépés' : `Hálózati hiba: ${err && err.message}`);
      throw new ProviderError(isTimeout(err) ? 'A Billingo nem válaszolt időben.' : 'Nem sikerült elérni a Billingót.', { uncertain: method !== 'GET' });
    }
    if (res.ok || okStatuses.includes(res.status)) {
      await log(action, true, res.status, `${method} ${path.split('?')[0]}`);
      return res;
    }
    let data = null;
    try {
      data = await res.json();
    } catch { /* not JSON */ }
    const message = errorMessage(res.status, data, res.headers.get('retry-after'));
    await log(action, false, res.status, message);
    throw new ProviderError(message, { status: res.status, uncertain: res.status >= 500 && method !== 'GET' });
  }
  return {
    call,
    json: async (method, path, opts) => (await call(method, path, opts)).json(),
  };
}

// ---------------------------------------------------------------- requests

export function partnerBody(buyer) {
  const hu = buyer.country === 'HU';
  return {
    name: buyer.name,
    address: { country_code: buyer.country || 'HU', post_code: buyer.zip, city: buyer.city, address: buyer.address },
    emails: buyer.email ? buyer.email.split(/[,;]\s*/).filter(Boolean) : [],
    taxcode: hu ? buyer.taxNumber : buyer.euVatNumber || buyer.taxNumber || '',
    tax_type: hu ? (buyer.taxNumber ? 'HAS_TAX_NUMBER' : 'NO_TAX_NUMBER') : 'FOREIGN',
  };
}

export function documentBody(doc, partnerId, settings = {}) {
  const body = {
    vendor_id: doc.reference,
    partner_id: partnerId,
    block_id: Number(settings.block_id),
    type: 'invoice',
    fulfillment_date: doc.fulfillmentDate,
    due_date: doc.dueDate,
    payment_method: 'wire_transfer',
    language: settings.language || doc.language || 'hu',
    currency: doc.currency,
    conversion_rate: 1,
    electronic: !!settings.e_invoice,
    paid: false,
    items: doc.items.map((it) => {
      const item = { name: it.name, unit_price: it.unitPrice, unit_price_type: 'net', quantity: it.qty, unit: it.unit, vat: vatCode(it.vatPct) };
      if (it.comment) item.comment = it.comment;
      return item;
    }),
    comment: doc.comment,
    settings: { round: 'none', order_number: doc.orderNumber },
  };
  if (Number(settings.bank_account_id) > 0) body.bank_account_id = Number(settings.bank_account_id);
  return body;
}

// Finds the client by tax number (creates or updates it). -> Billingo partner id
async function ensurePartner(api, buyer) {
  const wanted = partnerBody(buyer);
  const key = digits(wanted.taxcode);
  let found = null;
  if (key) {
    const list = await api.json('GET', `/partners?query=${encodeURIComponent(wanted.taxcode)}&per_page=100`, { action: 'partner.find' });
    found = (list.data || []).find((p) => digits(p.taxcode) === key) || null;
  }
  if (!found) {
    const created = await api.json('POST', '/partners', { body: wanted, action: 'partner.create' });
    return created.id;
  }
  const a = found.address || {};
  const changed = found.name !== wanted.name || a.post_code !== wanted.address.post_code || a.city !== wanted.address.city
    || a.address !== wanted.address.address || (a.country_code || 'HU') !== wanted.address.country_code
    || JSON.stringify(found.emails || []) !== JSON.stringify(wanted.emails);
  if (changed) {
    const { id, ...rest } = found;
    await api.json('PUT', `/partners/${id}`, { body: { ...rest, ...wanted }, action: 'partner.update' });
  }
  return found.id;
}

// GET /documents/{id}/download, waiting while Billingo answers 202 (PDF not generated yet).
async function downloadPdf(api, id, sleep, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const res = await api.call('GET', `/documents/${id}/download`, { action: 'invoice.pdf', accept: 'application/pdf', okStatuses: [202] });
    if (res.status === 200) return new Uint8Array(await res.arrayBuffer());
    if (i < attempts - 1) await sleep(1000 * (i + 1));
  }
  return null;
}

const apiKeyOf = (credentials) => String(credentials.api_key || '').trim();

// Creates the invoice. -> { invoiceNumber, externalId, pdf, net, gross, recovered, warnings }
export async function issue(doc, { credentials = {}, settings = {}, fetch: f = defaultFetch, log = noLog, recover = false, sleep = defaultSleep } = {}) {
  const apiKey = apiKeyOf(credentials);
  if (!apiKey) throw new ProviderError('Hiányzik a Billingo API kulcs (Beállítások > Számlázó).');
  if (!(Number(settings.block_id) > 0)) throw new ProviderError('Hiányzik a Billingo számlatömb azonosító (Beállítások > Számlázó).');
  const api = client({ apiKey, settings, fetch: f, log });
  const warnings = [];

  if (recover) {
    // The previous attempt ended without an answer: look the invoice up by vendor_id first.
    let res;
    try {
      res = await api.call('GET', `/documents/vendor/${encodeURIComponent(doc.reference)}`, { action: 'invoice.lookup', okStatuses: [400, 404, 422] });
    } catch (err) {
      err.uncertain = true;
      throw err;
    }
    if (res.status === 200) {
      const existing = await res.json();
      if (existing && existing.id && !existing.cancelled) {
        let pdf = null;
        try {
          pdf = await downloadPdf(api, existing.id, sleep);
          if (!pdf) warnings.push('A Billingo még készíti a számla PDF-et. Később töltsd le újra.');
        } catch (err) {
          warnings.push(`A számla PDF letöltése nem sikerült: ${err.message}`);
        }
        return { invoiceNumber: existing.invoice_number, externalId: String(existing.id), pdf, net: null, gross: existing.gross_total ?? null, recovered: true, warnings };
      }
    }
  }

  const body = documentBody(doc, await ensurePartner(api, doc.buyer), settings);
  const created = await api.json('POST', '/documents', { body, action: 'invoice.create' });
  if (!created || !created.id) throw new ProviderError('A Billingo válaszában nincs számla azonosító.', { uncertain: true });
  const result = {
    invoiceNumber: created.invoice_number || '',
    externalId: String(created.id),
    pdf: null,
    net: created.summary && created.summary.net_amount != null ? created.summary.net_amount : null,
    gross: created.gross_total ?? null,
    recovered: false,
    warnings,
  };
  if (result.gross != null && Math.abs(result.gross - doc.totals.gross) >= 0.5) {
    warnings.push(`A Billingo bruttó végösszege (${result.gross} Ft) eltér az elszámolásétól (${doc.totals.gross} Ft).`);
  }
  // From here on the invoice exists: problems only become warnings.
  if (settings.send_email && doc.buyer.email) {
    try {
      await api.call('POST', `/documents/${created.id}/send`, { body: { emails: doc.buyer.email.split(/[,;]\s*/).filter(Boolean) }, action: 'invoice.send' });
    } catch (err) {
      warnings.push(`A számla elkészült, de az e-mail küldés nem sikerült: ${err.message}`);
    }
  }
  try {
    result.pdf = await downloadPdf(api, created.id, sleep);
    if (!result.pdf) warnings.push('A Billingo még készíti a számla PDF-et. Később töltsd le újra.');
  } catch (err) {
    warnings.push(`A számla elkészült, de a PDF letöltése nem sikerült: ${err.message}`);
  }
  return result;
}

// Downloads the PDF of an invoice issued before. -> { pdf }
export async function fetchPdf({ externalId }, { credentials = {}, settings = {}, fetch: f = defaultFetch, log = noLog, sleep = defaultSleep } = {}) {
  const api = client({ apiKey: apiKeyOf(credentials), settings, fetch: f, log });
  const pdf = await downloadPdf(api, externalId, sleep);
  if (!pdf) throw new ProviderError('A Billingo még készíti a számla PDF-et. Próbáld újra pár perc múlva.');
  return { pdf };
}

// Checks the key, the invoice block and the bank account.
export async function test({ credentials = {}, settings = {}, fetch: f = defaultFetch, log = noLog } = {}) {
  const apiKey = apiKeyOf(credentials);
  if (!apiKey) return { ok: false, message: 'Add meg a Billingo API kulcsot.' };
  const api = client({ apiKey, settings, fetch: f, log });
  try {
    const blocks = (await api.json('GET', '/document-blocks?type=invoice&per_page=100', { action: 'test.blocks' })).data || [];
    const list = blocks.map((b) => `${b.id} (${b.name}${b.prefix ? `, ${b.prefix}` : ''})`).join(', ') || 'nincs';
    const blockId = Number(settings.block_id);
    if (!blockId) return { ok: false, message: `Az API kulcs érvényes. Add meg a számlatömb azonosítót. Elérhető számlatömbök: ${list}.` };
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return { ok: false, message: `A(z) ${blockId} számlatömb nem található. Elérhető számlatömbök: ${list}.` };
    const bankId = Number(settings.bank_account_id);
    if (bankId) {
      const banks = (await api.json('GET', '/bank-accounts?per_page=100', { action: 'test.bank_accounts' })).data || [];
      if (!banks.some((b) => b.id === bankId)) {
        return { ok: false, message: `A(z) ${bankId} bankszámla nem található. Elérhető bankszámlák: ${banks.map((b) => `${b.id} (${b.name})`).join(', ') || 'nincs'}.` };
      }
    }
    return { ok: true, message: `A Billingo kapcsolat rendben. Számlatömb: ${block.name}${block.prefix ? ` (${block.prefix})` : ''}.` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}
