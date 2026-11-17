// Számlázz.hu Számla Agent (XML API), following https://docs.szamlazz.hu/agent/
//
//   Every call: HTTPS POST multipart/form-data to https://www.szamlazz.hu/szamla/, the XML as a
//   file in the form field that names the function:
//     action-xmlagentxmlfile   create invoice   (root <xmlszamla>, xmlszamla.xsd)
//     action-szamla_agent_pdf  query invoice PDF (root <xmlszamlapdf>, xmlszamlapdf.xsd)
//   Authentication: the Számla Agent key in <szamlaagentkulcs> (lower case, case sensitive).
//   Answers: <valaszVerzio>2</valaszVerzio> gives an <xmlszamlavalasz> XML (sikeres, hibakod,
//   hibauzenet, szamlaszam, szamlanetto, szamlabrutto, pdf as base64). The headers szlahu_szamlaszam,
//   szlahu_error and szlahu_error_code (URL encoded) carry the same data and win when present.
//
// Seller name, address and tax number come from the Számlázz.hu account itself (the XSD has no
// such fields); the XML only carries the bank account and the e-mail texts of the seller.
// Amounts follow the documented HUF B2B rounding: net value of an item rounded to whole forints,
// VAT from that rounded net, rounded, gross = net + VAT (docs: Generating invoice > Rounding).
// The statement number goes into <rendelesSzam>; with "Rendelésszám ismétlődés tiltása" switched
// on in the account, Számlázz.hu also refuses (or returns) a repeated invoice for the same number.
// <szamlaKulsoAzon> carries a key unique to the approved statement, so an attempt whose answer got
// lost can be looked up before trying again (recover).
//
// Session cookies (JSESSIONID) are not kept between calls: a handful of invoices a month does not
// need them, and the docs only recommend them for high volume.

import { FULFILLMENT_HELP, FULFILLMENT_OPTIONS, LANGUAGE_OPTIONS, ProviderError, baseUrl, defaultFetch, isTimeout, noLog } from './common.js';

export const code = 'szamlazz';
export const name = 'Számlázz.hu';
export const docsUrl = 'https://docs.szamlazz.hu/agent/';
export const ENDPOINT = 'https://www.szamlazz.hu/szamla/';

export const credentialFields = [
  {
    key: 'agent_key', label: 'Számla Agent kulcs', type: 'password', required: true, options: null,
    help: 'A Számlázz.hu fiókod kezdőlapjának alján, a Számla Agent kulcsok résznél hozhatod létre.',
  },
];

export const settingFields = [
  { key: 'e_invoice', label: 'E-számla', type: 'checkbox', required: false, options: null, help: 'Elektronikus számla. A Számlázz.hu fiókodban engedélyezve kell legyen.' },
  { key: 'prefix', label: 'Számlaszám előtag', type: 'text', required: false, options: null, help: 'A Számlázz.hu Beállítások > Előtagok menüben regisztrált előtag. Üresen az alapértelmezett előtagot használja.' },
  { key: 'bank_name', label: 'Bank neve', type: 'text', required: false, options: null, help: 'A számlán megjelenő bank. Üresen a Számlázz.hu fiók adatai szerint.' },
  { key: 'bank_account', label: 'Bankszámlaszám', type: 'text', required: false, options: null, help: 'Üresen a Beállítások > Cégadatok bankszámlaszáma.' },
  { key: 'language', label: 'Számla nyelve', type: 'select', required: false, options: LANGUAGE_OPTIONS, help: '' },
  { key: 'fulfillment_date', label: 'Teljesítés dátuma', type: 'select', required: false, options: FULFILLMENT_OPTIONS, help: FULFILLMENT_HELP },
  { key: 'send_email', label: 'Számla küldése e-mailben az ügyfél számlázási címére', type: 'checkbox', required: false, options: null, help: 'A Számlázz.hu küldi ki a partner számlázási e-mail címére.' },
  { key: 'email_reply_to', label: 'Válaszcím az e-mailben', type: 'text', required: false, options: null, help: '' },
  { key: 'email_subject', label: 'E-mail tárgya', type: 'text', required: false, options: null, help: '' },
  { key: 'email_text', label: 'E-mail szövege', type: 'text', required: false, options: null, help: '' },
];

export const isConfigured = (credentials = {}) => !!String(credentials.agent_key || '').trim();

// ---------------------------------------------------------------- XML

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
export const xmlEscape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const tag = (name, value) => `<${name}>${xmlEscape(value)}</${name}>`;
const opt = (name, value) => (value === undefined || value === null || value === '' ? '' : tag(name, value));
const bool = (v) => (v ? 'true' : 'false');

// Decimal with a dot, no exponent, at most 6 decimals ("10000", "25.161290", "-2000").
export function num(n) {
  const v = Math.round((Number(n) || 0) * 1e6) / 1e6;
  if (Object.is(v, -0)) return '0';
  return Number.isInteger(v) ? String(v) : v.toFixed(6).replace(/0+$/, '');
}

// Buyer's tax status (adoalany): 1 Hungarian tax number, 6 EU business, 7 business outside the EU.
const EU = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK']);
function taxStatus(buyer) {
  if (buyer.country === 'HU') return buyer.taxNumber ? 1 : 0;
  return EU.has(buyer.country) ? 6 : 7;
}

// doc: the provider-neutral invoice built by index.js (buildInvoiceDocument).
export function buildInvoiceXml(doc, { agentKey, settings = {} }) {
  const s = settings;
  const b = doc.buyer;
  const items = doc.items.map((it) => `
    <tetel>
      ${tag('megnevezes', it.name)}
      ${tag('mennyiseg', num(it.qty))}
      ${tag('mennyisegiEgyseg', it.unit)}
      ${tag('nettoEgysegar', num(it.unitPrice))}
      ${tag('afakulcs', num(it.vatPct))}
      ${tag('nettoErtek', num(it.net))}
      ${tag('afaErtek', num(it.vat))}
      ${tag('bruttoErtek', num(it.gross))}
      ${opt('megjegyzes', it.comment)}
    </tetel>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<xmlszamla xmlns="http://www.szamlazz.hu/xmlszamla" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.szamlazz.hu/xmlszamla https://www.szamlazz.hu/szamla/docs/xsds/agent/xmlszamla.xsd">
  <beallitasok>
    ${tag('szamlaagentkulcs', agentKey)}
    ${tag('eszamla', bool(s.e_invoice))}
    ${tag('szamlaLetoltes', 'true')}
    ${tag('valaszVerzio', '2')}
    ${opt('szamlaKulsoAzon', doc.reference)}
  </beallitasok>
  <fejlec>
    ${tag('keltDatum', doc.issueDate)}
    ${tag('teljesitesDatum', doc.fulfillmentDate)}
    ${tag('fizetesiHataridoDatum', doc.dueDate)}
    ${tag('fizmod', 'Átutalás')}
    ${tag('penznem', doc.currency)}
    ${tag('szamlaNyelve', s.language || doc.language || 'hu')}
    ${opt('megjegyzes', doc.comment)}
    ${opt('rendelesSzam', doc.orderNumber)}
    ${tag('elolegszamla', 'false')}
    ${tag('vegszamla', 'false')}
    ${tag('helyesbitoszamla', 'false')}
    ${tag('dijbekero', 'false')}
    ${opt('szamlaszamElotag', String(s.prefix || '').trim())}
  </fejlec>
  <elado>
    ${opt('bank', String(s.bank_name || '').trim())}
    ${opt('bankszamlaszam', String(s.bank_account || doc.seller.bankAccount || '').trim())}
    ${opt('emailReplyto', String(s.email_reply_to || '').trim())}
    ${opt('emailTargy', String(s.email_subject || '').trim())}
    ${opt('emailSzoveg', String(s.email_text || '').trim())}
  </elado>
  <vevo>
    ${tag('nev', b.name)}
    ${b.country && b.country !== 'HU' ? tag('orszag', b.countryName || b.country) : ''}
    ${tag('irsz', b.zip)}
    ${tag('telepules', b.city)}
    ${tag('cim', b.address)}
    ${opt('email', b.email)}
    ${tag('sendEmail', bool(s.send_email && b.email))}
    ${tag('adoalany', String(taxStatus(b)))}
    ${opt('adoszam', b.country === 'HU' ? b.taxNumber : '')}
    ${opt('adoszamEU', b.euVatNumber)}
  </vevo>
  <tetelek>${items}
  </tetelek>
</xmlszamla>
`.replace(/\n\s*\n/g, '\n');
}

export function buildPdfQueryXml({ agentKey, invoiceNumber = '', externalId = '' }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<xmlszamlapdf xmlns="http://www.szamlazz.hu/xmlszamlapdf" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.szamlazz.hu/xmlszamlapdf https://www.szamlazz.hu/szamla/docs/xsds/agentpdf/xmlszamlapdf.xsd">
  ${tag('szamlaagentkulcs', agentKey)}
  ${opt('szamlaszam', invoiceNumber)}
  ${tag('valaszVerzio', '2')}
  ${opt('szamlaKulsoAzon', externalId)}
</xmlszamlapdf>
`.replace(/\n\s*\n/g, '\n');
}

// ---------------------------------------------------------------- response

const decodeHeader = (v) => {
  if (v == null) return '';
  try {
    return decodeURIComponent(String(v).replace(/\+/g, ' '));
  } catch {
    return String(v);
  }
};

function xmlValue(xml, name) {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
  if (!m) return null;
  const v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return (cdata ? cdata[1] : v).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function base64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// -> { ok, invoiceNumber, net, gross, pdf (Uint8Array|null), errorCode, errorMessage }
export async function parseAgentResponse(res) {
  const headerCode = res.headers.get('szlahu_error_code');
  const headerError = decodeHeader(res.headers.get('szlahu_error'));
  const headerNumber = decodeHeader(res.headers.get('szlahu_szamlaszam'));
  const bytes = new Uint8Array(await res.arrayBuffer());
  const isPdf = bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
  const text = isPdf ? '' : new TextDecoder().decode(bytes);
  const out = { ok: false, invoiceNumber: headerNumber, net: null, gross: null, pdf: null, errorCode: headerCode ? String(headerCode).trim() : '', errorMessage: headerError };
  if (isPdf) out.pdf = bytes;
  if (/<(?:\w+:)?xmlszamlavalasz[\s>]/.test(text)) {
    out.ok = (xmlValue(text, 'sikeres') || '').toLowerCase() === 'true';
    out.errorCode ||= xmlValue(text, 'hibakod') || '';
    out.errorMessage ||= xmlValue(text, 'hibauzenet') || '';
    out.invoiceNumber ||= xmlValue(text, 'szamlaszam') || '';
    const net = xmlValue(text, 'szamlanetto');
    const gross = xmlValue(text, 'szamlabrutto');
    out.net = net != null && net !== '' ? Number(net) : null;
    out.gross = gross != null && gross !== '' ? Number(gross) : null;
    const pdf = xmlValue(text, 'pdf');
    if (pdf) out.pdf = base64ToBytes(pdf);
  } else if (/\[ERR\]/.test(text)) {
    // Plain text error (valaszVerzio 1): the message is between [ERR] and the dashes.
    out.errorMessage ||= text.replace(/^[\s\S]*?\[ERR\]\s*/, '').split(/-{5,}/)[0].trim();
  } else if (!isPdf && /xmlagentresponse=DONE;/.test(text)) {
    out.ok = true;
    out.invoiceNumber ||= decodeHeader(text.split('DONE;')[1].trim());
  } else if (isPdf) {
    out.ok = !out.errorCode;
  }
  if (out.errorCode) out.ok = false;
  if (!res.ok && !out.errorCode) out.ok = false;
  return out;
}

// Hungarian message for an Agent error code.
export function errorText(code, message) {
  const c = String(code || '');
  const m = String(message || '').trim();
  const known = {
    1: 'A Számlázz.hu karbantartás miatt nem elérhető. Próbáld újra pár perc múlva.',
    3: 'Sikertelen bejelentkezés a Számlázz.hu-ba: ellenőrizd a Számla Agent kulcsot a Beállítások > Számlázó oldalon.',
    53: 'A Számlázz.hu nem kapta meg a számla adatait (hiányzó XML fájl).',
    54: 'Az e-számla kiállítása nincs engedélyezve a Számlázz.hu fiókodban. Kapcsold ki az E-számla beállítást, vagy engedélyezd a fiókban.',
    55: 'Az e-számla aláírása nem sikerült a Számlázz.hu-ban. Próbáld újra később.',
    71: 'A Számlázz.hu-ban már van számla ezzel a rendelésszámmal (az elszámolás számával).',
    136: 'Bejelentkezési hiba: lépj be a Számlázz.hu fiókodba böngészőből, és ellenőrizd az előfizetést.',
    152: 'A Számlázz.hu-ban már van számla ezzel a rendelésszámmal (az elszámolás számával).',
    164: 'A Számlázz.hu felhasználó több fiókhoz is hozzáfér. Használj Számla Agent kulcsot.',
    202: 'A megadott számlaszám előtag nincs regisztrálva a Számlázz.hu fiókodban (Beállítások > Előtagok).',
    491: 'A Számlázz.hu fiók adóneme az új KATA, ezért vállalkozásnak nem állíthat ki számlát.',
  };
  if (known[c]) return known[c];
  if (['57', '259', '260', '261', '262', '263', '264'].includes(c)) return `A Számlázz.hu nem fogadta el a számla adatait (${c}): ${m || 'hibás XML'}`;
  return `Számlázz.hu hiba${c ? ` (${c})` : ''}: ${m || 'ismeretlen hiba'}`;
}

// ---------------------------------------------------------------- calls

const endpoint = (settings) => {
  const base = baseUrl(settings, ENDPOINT);
  return base === ENDPOINT ? base : `${base}/szamla/`;
};

async function post(field, xml, { settings, fetch: f, log, action }) {
  const form = new FormData();
  form.append(field, new Blob([xml], { type: 'text/xml' }), 'request.xml');
  let res;
  try {
    res = await f(endpoint(settings), { method: 'POST', body: form, signal: AbortSignal.timeout(45000) });
  } catch (err) {
    const timeout = isTimeout(err);
    await log(action, false, null, timeout ? 'Időtúllépés' : `Hálózati hiba: ${err && err.message}`);
    throw new ProviderError(timeout ? 'A Számlázz.hu nem válaszolt időben.' : 'Nem sikerült elérni a Számlázz.hu-t.', { uncertain: true });
  }
  if (res.status >= 500) {
    await log(action, false, res.status, `HTTP ${res.status}`);
    throw new ProviderError(`A Számlázz.hu szerverhibát jelzett (HTTP ${res.status}).`, { uncertain: true, status: res.status });
  }
  const parsed = await parseAgentResponse(res);
  await log(action, parsed.ok, res.status, parsed.ok ? (parsed.invoiceNumber ? `Számla: ${parsed.invoiceNumber}` : 'OK') : `Hiba ${parsed.errorCode}: ${parsed.errorMessage}`.slice(0, 500));
  return { res, parsed };
}

const agentKeyOf = (credentials) => String(credentials.agent_key || '').trim().toLowerCase();

// Looks an invoice up by its external key or number. -> { found, invoiceNumber, pdf }
export async function queryPdf({ invoiceNumber = '', externalId = '' }, { credentials = {}, settings = {}, fetch: f = defaultFetch, log = noLog } = {}) {
  const xml = buildPdfQueryXml({ agentKey: agentKeyOf(credentials), invoiceNumber, externalId });
  const { parsed } = await post('action-szamla_agent_pdf', xml, { settings, fetch: f, log, action: 'invoice.pdf' });
  if (parsed.ok && parsed.pdf) return { found: true, invoiceNumber: parsed.invoiceNumber || invoiceNumber, pdf: parsed.pdf };
  if (String(parsed.errorCode) === '7') return { found: false };
  throw new ProviderError(errorText(parsed.errorCode, parsed.errorMessage), { code: parsed.errorCode });
}

// Creates the invoice. -> { invoiceNumber, externalId, pdf, net, gross, recovered, warnings }
export async function issue(doc, { credentials = {}, settings = {}, fetch: f = defaultFetch, log = noLog, recover = false } = {}) {
  const agentKey = agentKeyOf(credentials);
  if (!agentKey) throw new ProviderError('Hiányzik a Számla Agent kulcs (Beállítások > Számlázó).');
  if (recover) {
    // The previous attempt ended without an answer: look the invoice up by its external key first.
    let found;
    try {
      found = await queryPdf({ externalId: doc.reference }, { credentials, settings, fetch: f, log });
    } catch (err) {
      err.uncertain = true;
      throw err;
    }
    if (found.found) return { invoiceNumber: found.invoiceNumber, externalId: doc.reference, pdf: found.pdf, net: null, gross: null, recovered: true, warnings: [] };
  }
  const xml = buildInvoiceXml(doc, { agentKey, settings });
  const { parsed } = await post('action-xmlagentxmlfile', xml, { settings, fetch: f, log, action: 'invoice.create' });
  if (!parsed.ok || !parsed.invoiceNumber) {
    const code = parsed.errorCode;
    throw new ProviderError(errorText(code, parsed.errorMessage || (parsed.ok ? 'A válaszban nincs számlaszám.' : '')), {
      code, uncertain: !code,
    });
  }
  const warnings = [];
  if (parsed.gross != null && Math.abs(parsed.gross - doc.totals.gross) >= 0.5) {
    warnings.push(`A Számlázz.hu bruttó végösszege (${parsed.gross} Ft) eltér az elszámolásétól (${doc.totals.gross} Ft).`);
  }
  if (!parsed.pdf) warnings.push('A Számlázz.hu nem küldte vissza a számla PDF-et.');
  return { invoiceNumber: parsed.invoiceNumber, externalId: doc.reference, pdf: parsed.pdf, net: parsed.net, gross: parsed.gross, recovered: false, warnings };
}

// Downloads the PDF of an invoice issued before. -> { pdf }
export async function fetchPdf({ invoiceNumber, externalId }, opts = {}) {
  const r = await queryPdf({ invoiceNumber, externalId: invoiceNumber ? '' : externalId }, opts);
  if (!r.found) throw new ProviderError('A számla nem található a Számlázz.hu-ban.');
  return { pdf: r.pdf };
}

// Checks the key with a PDF query for an invoice that cannot exist: error 7 (not found) means
// the key was accepted; 3, 136 and 164 are login problems.
export async function test({ credentials = {}, settings = {}, fetch: f = defaultFetch, log = noLog } = {}) {
  if (!agentKeyOf(credentials)) return { ok: false, message: 'Add meg a Számla Agent kulcsot.' };
  try {
    // Any answer other than an error (found or not found) means the key was accepted.
    await queryPdf({ externalId: `FL-KAPCSOLATTESZT-${Date.now()}` }, { credentials, settings, fetch: f, log });
    return { ok: true, message: 'A Számlázz.hu elfogadta a Számla Agent kulcsot.' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}
