// Invoicing integrations (Számlázz.hu Agent, Billingo API v3).
//
// Contract used by the rest of the app:
//   listProviders()                    -> [{ code, name, docsUrl, credentialFields, settingFields }]
//        fields: { key, label, type: text|password|select|number|checkbox, required, options, help };
//        the Beállítások > Számlázó screen renders its forms from these and saves them with
//        saveInvoicingConfig (lib/accounts.js) as settings[code][key] and credentials[code][key].
//   invoicingStatus(env)               -> Promise<{ provider, name, configured, error? }>
//   issueInvoice(ctx, statementId, { fetch?, sleep? })
//                                      -> Promise<{ invoiceNumber, documentId, warnings }>
//        creates the invoice for an approved statement with the provider chosen in Beállítások,
//        stores the PDF in R2 (documents, kind invoice) and updates the statement (status
//        invoiced, invoice number). For an invoiced statement whose PDF could not be downloaded yet
//        it only downloads the PDF again. Failures are saved in statements.invoice_error and thrown
//        as HttpError (409 for refusals, 502 for provider errors) with a Hungarian message.
//   testConnection(env, provider, { fetch? }) -> Promise<{ ok, message }>
//
// Adapters (szamlazz.js, billingo.js) share one shape and take an injectable fetch (default: the
// global one), so tests can stub every HTTP exchange:
//   issue(doc, { credentials, settings, fetch, log, recover, sleep }) -> { invoiceNumber, externalId, pdf, net, gross, recovered, warnings }
//   fetchPdf({ invoiceNumber, externalId }, opts) -> { pdf }
//   test({ credentials, settings, fetch, log }) -> { ok, message }
// Every call is logged with integrationLog() (status and message only, never the request body,
// which holds the Számla Agent key).

import { first, getSetting, parseJson, run } from '../../lib/db.js';
import { HttpError, conflict, notFound } from '../../lib/http.js';
import { audit, integrationLog } from '../../lib/audit.js';
import { getInvoicingConfig } from '../../lib/accounts.js';
import { storeFile } from '../../lib/files.js';
import { addDays, budapestDate, monthRange, nowIso } from '../../lib/time.js';
import { roundHuf } from '../../jobs/billing-calc.js';
import * as szamlazz from './szamlazz.js';
import * as billingo from './billingo.js';

const ADAPTERS = { szamlazz, billingo };
const LOCK_MINUTES = 5;

export const listProviders = () => Object.values(ADAPTERS).map((a) => ({
  code: a.code, name: a.name, docsUrl: a.docsUrl, credentialFields: a.credentialFields, settingFields: a.settingFields,
}));

export async function invoicingStatus(env) {
  try {
    const conf = await getInvoicingConfig(env);
    const a = ADAPTERS[conf.provider];
    if (!a) return { provider: '', name: '', configured: false };
    return { provider: a.code, name: a.name, configured: a.isConfigured(conf.credentials[a.code] || {}, conf.settings[a.code] || {}) };
  } catch (err) {
    return { provider: '', name: '', configured: false, error: `A számlázó beállításai nem olvashatók: ${err.message}` };
  }
}

// ---------------------------------------------------------------- invoice document

const MONTHS = ['január', 'február', 'március', 'április', 'május', 'június', 'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];
export const periodLabel = (period) => `${period.slice(0, 4)}. ${MONTHS[Number(period.slice(5, 7)) - 1]}`;

const COUNTRY_NAMES = { HU: 'Magyarország', AT: 'Ausztria', DE: 'Németország', SK: 'Szlovákia', RO: 'Románia', CZ: 'Csehország', PL: 'Lengyelország', SI: 'Szlovénia', HR: 'Horvátország' };
const plain = (n) => String(Math.round(Number(n) * 100) / 100).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

// Statement lines -> invoice items. Every item's net is the statement line's rounded amount, and
// its unit price (at most `decimals` decimals) times its quantity rounds to exactly that amount;
// otherwise the item becomes "1 tétel" at the line amount with the quantity in the comment.
export function invoiceItems(lines, vatPct, { decimals = 6, daysInMonth = 30 } = {}) {
  const scale = 10 ** decimals;
  return lines.filter((l) => roundHuf(l.amount) !== 0).map((l) => {
    let qty = Number(l.qty);
    let unitPrice = Number(l.price);
    let comment = '';
    if (l.price_unit === 'Ft / hely / hó') {
      unitPrice = Number(l.price) / daysInMonth;
      comment = `${plain(l.qty)} ${l.unit}, ${plain(l.price)} Ft / hely / hó, ${daysInMonth} napos hónap`;
    } else if (l.price_unit === '%') {
      comment = `${plain(l.price)}% x ${plain(l.qty)} ${l.unit}`;
      qty = 0;
    }
    unitPrice = Math.round(unitPrice * scale) / scale;
    const amount = roundHuf(l.amount);
    const exact = qty > 0 && roundHuf(qty * unitPrice) === amount;
    return {
      name: l.name,
      qty: exact ? qty : 1,
      unit: exact ? l.unit || 'db' : 'tétel',
      unitPrice: exact ? unitPrice : amount,
      vatPct: Number(vatPct),
      net: amount,
      vat: roundHuf(l.vat),
      gross: amount + roundHuf(l.vat),
      comment: exact ? comment : comment || (l.qty && l.qty !== 1 ? `${plain(l.qty)} ${l.unit}` : ''),
    };
  });
}

// Fulfilment date of a periodic (monthly) settlement, see the fulfillment_date setting.
export function fulfillmentDate(mode, { periodEnd, issueDate, dueDate }) {
  if (mode === 'period_end') return periodEnd;
  if (mode === 'issue_date') return issueDate;
  const latest = addDays(periodEnd, 60);
  if (dueDate < periodEnd) return periodEnd;
  return dueDate > latest ? latest : dueDate;
}

// Provider-neutral invoice built from a statement and the client's billing data.
export async function buildInvoiceDocument(db, st, settings = {}, provider = 'szamlazz') {
  const partner = await first(db, 'SELECT * FROM partners WHERE id = ?', st.partner_id);
  if (!partner) throw notFound('Az ügyfél nem található.');
  const company = (await getSetting(db, 'company', {})) || {};
  const pick = (a, b) => String(a || '').trim() || String(b || '').trim();
  const country = (pick(partner.billing_country, partner.country) || 'HU').toUpperCase();
  const buyer = {
    name: pick(partner.billing_name, partner.name),
    country,
    countryName: COUNTRY_NAMES[country] || country,
    zip: pick(partner.billing_zip, partner.zip),
    city: pick(partner.billing_city, partner.city),
    address: pick(partner.billing_address, partner.address),
    email: String(partner.billing_email || '').trim(),
    taxNumber: String(partner.tax_number || '').trim(),
    euVatNumber: String(partner.eu_vat_number || '').trim(),
  };
  const missing = [];
  if (!buyer.zip) missing.push('irányítószám');
  if (!buyer.city) missing.push('település');
  if (!buyer.address) missing.push('cím');
  if (country === 'HU' && !buyer.taxNumber) missing.push('adószám');
  if (missing.length) throw conflict(`Hiányzik az ügyfél számlázási adata: ${missing.join(', ')}. Pótold a Partnerek oldalon.`);

  const meta = parseJson(st.meta, {});
  const lines = parseJson(st.lines, []);
  const { from, to, days } = monthRange(st.period);
  const issueDate = budapestDate();
  const dueDate = addDays(issueDate, Math.max(0, Number(partner.payment_days) || 0));
  const items = invoiceItems(lines, st.vat_pct, { decimals: provider === 'billingo' ? 2 : 6, daysInMonth: meta.days_in_month || days });
  if (!items.length) throw conflict('Az elszámolásban nincs számlázható tétel.');
  return {
    reference: `${st.number}-${String(st.approved_at || '').replace(/\D/g, '').slice(0, 14)}`,
    orderNumber: st.number,
    period: st.period,
    issueDate,
    fulfillmentDate: fulfillmentDate(settings.fulfillment_date || 'due_date', { periodEnd: to, issueDate, dueDate }),
    dueDate,
    currency: 'HUF',
    language: 'hu',
    comment: `Logisztikai szolgáltatások, elszámolási időszak: ${periodLabel(st.period)} (${from} és ${to} között). Elszámolás: ${st.number}.`,
    buyer,
    seller: { name: company.name || '', bankAccount: String(company.bank_account || '').trim() },
    items,
    totals: { net: st.net, vat: st.vat, gross: st.gross },
  };
}

// ---------------------------------------------------------------- issuing

const pdfName = (number) => `${String(number || 'szamla').replace(/[\\/:*?"<>|\s]+/g, '_')}.pdf`;

const storePdf = (ctx, st, number, pdf) => storeFile(ctx, {
  partnerId: st.partner_id, kind: 'invoice', filename: pdfName(number), contentType: 'application/pdf', body: pdf,
});

export async function issueInvoice(ctx, statementId, { fetch, sleep } = {}) {
  const db = ctx.env.DB;
  const st = await first(db, 'SELECT * FROM statements WHERE id = ?', statementId);
  if (!st) throw notFound('Az elszámolás nem található.');
  const pdfOnly = st.status === 'invoiced' && !st.invoice_document_id && !!st.invoice_external_id;
  if (st.status === 'invoiced' && !pdfOnly) throw conflict('Erről az elszámolásról már kiállítottuk a számlát.');
  if (!pdfOnly && st.status !== 'approved') throw conflict('Csak jóváhagyott elszámolásról állíthatsz ki számlát.');
  if (!pdfOnly && !(st.net > 0)) throw conflict('Nulla vagy negatív végösszegű elszámolásról nem állíthatsz ki számlát.');

  const conf = await getInvoicingConfig(ctx.env);
  const code = pdfOnly ? st.invoice_provider : conf.provider;
  const adapter = ADAPTERS[code];
  if (!adapter) throw conflict('Még nincs beállítva számlázó. Válaszd ki és állítsd be a Beállítások > Számlázó oldalon.');
  const credentials = conf.credentials[code] || {};
  const settings = conf.settings[code] || {};
  if (!adapter.isConfigured(credentials, settings)) throw conflict(`A(z) ${adapter.name} beállításai hiányosak. Pótold a Beállítások > Számlázó oldalon.`);
  const doc = pdfOnly ? null : await buildInvoiceDocument(db, st, settings, code);

  // One attempt at a time: a double click or two users must not create two invoices.
  const stale = new Date(Date.now() - LOCK_MINUTES * 60 * 1000).toISOString();
  const lock = await run(db, 'UPDATE statements SET invoice_lock_at = ? WHERE id = ? AND status = ? AND (invoice_lock_at IS NULL OR invoice_lock_at < ?)',
    nowIso(), st.id, st.status, stale);
  if (lock.meta.changes !== 1) throw conflict('A számla kiállítása már folyamatban van. Várj egy kicsit, majd frissítsd az oldalt.');

  const log = (action, ok, status, message) => integrationLog(ctx.env, {
    system: code, action, ok, status, message, partnerId: st.partner_id, refType: 'statement', refId: st.id,
  });
  const opts = { credentials, settings, fetch, log, sleep, recover: !!st.invoice_uncertain };
  let created = null;
  try {
    if (pdfOnly) {
      const { pdf } = await adapter.fetchPdf({ invoiceNumber: st.invoice_number, externalId: st.invoice_external_id }, opts);
      const documentId = await storePdf(ctx, st, st.invoice_number, pdf);
      await run(db, "UPDATE statements SET invoice_document_id = ?, invoice_error = '', invoice_lock_at = NULL WHERE id = ?", documentId, st.id);
      await audit(ctx, { module: 'billing', action: 'approve', entity: 'statement', entityId: st.id, summary: `${st.number}: számla PDF letöltve (${st.invoice_number})` });
      return { invoiceNumber: st.invoice_number, documentId, warnings: [] };
    }
    created = await adapter.issue(doc, opts);
    const warnings = created.warnings || [];
    let documentId = null;
    if (created.pdf) documentId = await storePdf(ctx, st, created.invoiceNumber, created.pdf);
    await run(db, `UPDATE statements SET status = 'invoiced', invoice_provider = ?, invoice_number = ?, invoice_external_id = ?, invoice_document_id = ?,
                     invoiced_at = ?, invoice_error = ?, invoice_uncertain = 0, invoice_lock_at = NULL WHERE id = ?`,
    code, created.invoiceNumber, created.externalId || '', documentId, nowIso(),
    documentId ? '' : 'A számla elkészült, de a PDF még nem érhető el. Töltsd le újra a számla PDF gombbal.', st.id);
    await audit(ctx, {
      module: 'billing', action: 'approve', entity: 'statement', entityId: st.id,
      summary: `${st.number}: számla kiállítva (${adapter.name}, ${created.invoiceNumber})${created.recovered ? ', korábbi kísérletből visszakeresve' : ''}`,
      details: warnings.length ? { warnings } : null,
    });
    return { invoiceNumber: created.invoiceNumber, documentId, warnings };
  } catch (err) {
    const message = (err && err.message) || 'Ismeretlen hiba.';
    let uncertain = (created || (err && err.uncertain)) ? 1 : 0;
    if (pdfOnly) uncertain = st.invoice_uncertain;
    await run(db, 'UPDATE statements SET invoice_error = ?, invoice_uncertain = ?, invoice_lock_at = NULL WHERE id = ?',
      String(message).slice(0, 1000), uncertain, st.id);
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, `Nem sikerült ${pdfOnly ? 'letölteni a számla PDF-et' : 'kiállítani a számlát'}: ${message}`, 'invoicing_failed');
  }
}

export async function testConnection(env, provider, { fetch } = {}) {
  const a = ADAPTERS[provider];
  if (!a) return { ok: false, message: 'Ismeretlen számlázó.' };
  let conf;
  try {
    conf = await getInvoicingConfig(env);
  } catch (err) {
    return { ok: false, message: `A számlázó beállításai nem olvashatók: ${err.message}` };
  }
  const log = (action, ok, status, message) => integrationLog(env, { system: a.code, action, ok, status, message, refType: 'test' });
  return a.test({ credentials: conf.credentials[a.code] || {}, settings: conf.settings[a.code] || {}, fetch, log });
}
