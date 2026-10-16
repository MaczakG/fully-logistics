// Elszámolás: monthly statements from movements and storage snapshots, billing entries, invoicing.
// Prefix /api/billing. Numbers: EL-YYYY-NNNNN. The calculation lives in jobs/billing-calc.js, the
// invoicing in integrations/invoicing/, the daily snapshot in jobs/snapshot.js.
//
//   GET    /api/billing/overview?period=YYYY-MM            clients with statement status, KPIs   [view]
//   GET    /api/billing/overview/export?period=            CSV of the overview                   [view]
//   POST   /api/billing/statements/generate                { period, partner_ids? } drafts       [create]
//   GET    /api/billing/statements/:id                     statement with lines                  [view]
//   GET    /api/billing/statements/:id/details?kind=       drill-down (orders, inbound, returns, storage, entries) [view]
//   GET    /api/billing/statements/:id/export              CSV of the statement                  [view]
//   POST   /api/billing/statements/:id/lines               manual line on a draft                [edit]
//   DELETE /api/billing/statements/:id/lines/:lineId       remove a manual line                  [edit]
//   DELETE /api/billing/statements/:id                     delete a draft                        [delete]
//   POST   /api/billing/statements/:id/approve             draft -> approved                     [approve]
//   POST   /api/billing/statements/:id/void                approved or invoiced -> void          [approve]
//   POST   /api/billing/statements/:id/invoice             issue the invoice (or fetch its PDF)  [approve]
//   GET    /api/billing/entries?period=&partner_id=        hourly work and per unit items        [view]
//   POST   /api/billing/entries                            new entry                             [create]
//   PATCH  /api/billing/entries/:id                        change an entry                       [edit]
//   DELETE /api/billing/entries/:id                        delete an entry                       [delete]
//   GET    /api/billing/custom-items?partner_id=           the client's custom tariff items      [view]
//   POST   /api/billing/snapshot                           "Pillanatkép rögzítése most" (today)  [create]
//
// Business rules: regenerating replaces the computed lines of drafts (manual lines stay), never
// touches approved or invoiced statements; a void statement is only rebuilt when selected
// explicitly. Approval needs an up to date draft. Billing entries of a period whose statement is
// approved or invoiced cannot change.

import { all, first, marks, nextNumber, parseJson, run } from '../lib/db.js';
import { badRequest, conflict, download, notFound, page } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import { toCsv } from '../lib/csv.js';
import { STATUSES } from '../lib/constants.js';
import { addDays, budapestDate, monthRange, nowIso } from '../lib/time.js';
import {
  DETAIL_KINDS, GROUPS, GROUP_KEYS, calculatePeriod, isPeriod, previousPeriod, roundHuf, sameLines, statementDetails, withTotals,
} from '../jobs/billing-calc.js';
import { takeDailySnapshot } from '../jobs/snapshot.js';
import { invoicingStatus, issueInvoice, periodLabel } from '../integrations/invoicing/index.js';

const STATUS_LABEL = { none: 'Nincs elszámolás', ...Object.fromEntries(Object.entries(STATUSES.statement).map(([k, v]) => [k, v.label])) };
const LOCKED = ['approved', 'invoiced'];
const LOCK_MS = 5 * 60 * 1000;

function periodOf(value, field = 'period') {
  if (!isPeriod(value)) throw badRequest('Ellenőrizd a megjelölt mezőket.', { [field]: 'Érvénytelen időszak (ÉÉÉÉ-HH).' });
  return value;
}
const queryPeriod = (ctx) => periodOf(ctx.query.get('period') || previousPeriod(budapestDate()));

const idParam = (ctx, name = 'id') => {
  const n = Number(ctx.params[name]);
  if (!Number.isInteger(n) || n < 1) throw notFound();
  return n;
};

const STATEMENT_SQL = `SELECT s.*, p.code AS partner_code, p.name AS partner_name,
    gu.name AS generated_by_name, au.name AS approved_by_name, vu.name AS voided_by_name
  FROM statements s JOIN partners p ON p.id = s.partner_id
  LEFT JOIN users gu ON gu.id = s.generated_by LEFT JOIN users au ON au.id = s.approved_by LEFT JOIN users vu ON vu.id = s.voided_by
  WHERE s.id = ?`;

async function loadStatement(db, id) {
  const st = await first(db, STATEMENT_SQL, id);
  if (!st) throw notFound('Az elszámolás nem található.');
  return st;
}

const busy = (st) => !!st.invoice_lock_at && Date.parse(st.invoice_lock_at) > Date.now() - LOCK_MS;

function shape(st) {
  const { meta, lines, invoice_lock_at: lockAt, invoice_uncertain: uncertain, ...rest } = st;
  return { ...rest, lines: parseJson(lines, []), meta: parseJson(meta, {}), invoice_busy: busy(st), invoice_uncertain: !!uncertain };
}

// Whether billing entries of a client on a date may still change.
async function assertEntryOpen(db, partnerId, date) {
  const period = date.slice(0, 7);
  const st = await first(db, 'SELECT number, status FROM statements WHERE partner_id = ? AND period = ?', partnerId, period);
  if (st && LOCKED.includes(st.status)) {
    throw conflict(`A(z) ${period} időszak elszámolása (${st.number}) már ${st.status === 'invoiced' ? 'számlázva' : 'jóvá van hagyva'}, ezért ehhez a naphoz nem rögzíthetsz és nem módosíthatsz tételt.`);
  }
}

async function freshLines(db, st) {
  const calc = (await calculatePeriod(db, st.period, [st.partner_id])).get(st.partner_id);
  const manual = parseJson(st.lines, []).filter((l) => l.manual);
  return { calc, manual, totals: withTotals([...calc.lines, ...manual], calc.vat_pct) };
}

const csvNum = (v) => (v == null || v === '' ? '' : String(v).replace('.', ','));

// Mutates a draft's lines: fn(lines) -> lines. Guarded on status so a concurrent approval wins.
async function updateDraftLines(ctx, st, fn) {
  if (st.status !== 'draft') throw conflict('Csak piszkozat tételei módosíthatók.');
  const lines = fn(parseJson(st.lines, []));
  const totals = withTotals(lines, st.vat_pct);
  const res = await run(ctx.env.DB, "UPDATE statements SET lines = ?, net = ?, vat = ?, gross = ? WHERE id = ? AND status = 'draft'",
    JSON.stringify(totals.lines), totals.net, totals.vat, totals.gross, st.id);
  if (res.meta.changes !== 1) throw conflict('Az elszámolás közben megváltozott. Frissítsd az oldalt.');
  return totals;
}

export function register(r) {
  // ---------------------------------------------------------------- overview
  async function overview(ctx) {
    const db = ctx.env.DB;
    const period = queryPeriod(ctx);
    const { from, to, days } = monthRange(period);
    const rows = await all(db, `SELECT p.id AS partner_id, p.code, p.name, p.status AS partner_status,
        s.id AS statement_id, s.number, s.status, s.net, s.vat, s.gross, s.invoice_number, s.invoice_error, s.invoice_document_id,
        s.generated_at, s.approved_at, s.invoiced_at
      FROM partners p LEFT JOIN statements s ON s.partner_id = p.id AND s.period = ?
      WHERE p.type = 'client' AND (p.status = 'active' OR s.id IS NOT NULL)
      ORDER BY p.name COLLATE NOCASE`, period);
    const items = rows.map((x) => ({ ...x, status: x.status || 'none' }));
    const sum = (list) => list.reduce((s, x) => s + (x.net || 0), 0);
    const live = items.filter((x) => ['draft', 'approved', 'invoiced'].includes(x.status));
    const drafts = items.filter((x) => x.status === 'draft');
    const approved = items.filter((x) => x.status === 'approved');
    const invoiced = items.filter((x) => x.status === 'invoiced');

    // Snapshot coverage of the days that are already over.
    const today = budapestDate();
    const lastDay = to < today ? to : addDays(today, -1);
    const recorded = new Set((await all(db, 'SELECT date FROM snapshot_runs WHERE date BETWEEN ? AND ?', from, to)).map((x) => x.date));
    const missing = [];
    let expected = 0;
    for (let d = from; d <= lastDay; d = addDays(d, 1)) {
      expected++;
      if (!recorded.has(d)) missing.push(d);
    }
    const lastRun = await first(db, 'SELECT date, taken_at, rows, source FROM snapshot_runs ORDER BY date DESC LIMIT 1');

    return {
      period, label: periodLabel(period), from, to, days, items,
      kpis: {
        total_net: sum(live), invoiced_net: sum(invoiced), invoiced_count: invoiced.length,
        draft_net: sum(drafts), draft_count: drafts.length, approved_net: sum(approved), approved_count: approved.length,
        missing_count: items.filter((x) => x.status === 'none').length,
      },
      snapshots: { recorded: recorded.size, expected, missing, last: lastRun || null },
      invoicing: await invoicingStatus(ctx.env),
      groups: GROUPS,
    };
  }
  r.get('/api/billing/overview', overview, { perm: ['billing', 'view'] });

  r.get('/api/billing/overview/export', async (ctx) => {
    const data = await overview(ctx);
    const csv = toCsv([
      { key: 'code', label: 'Ügyfélkód' },
      { key: 'name', label: 'Ügyfél' },
      { label: 'Állapot', value: (x) => STATUS_LABEL[x.status] || x.status },
      { key: 'number', label: 'Elszámolás' },
      { label: 'Nettó (Ft)', value: (x) => csvNum(x.net) },
      { label: 'ÁFA (Ft)', value: (x) => csvNum(x.vat) },
      { label: 'Bruttó (Ft)', value: (x) => csvNum(x.gross) },
      { key: 'invoice_number', label: 'Számlaszám' },
    ], data.items);
    return download(csv, `elszamolasok-${data.period}.csv`, 'text/csv; charset=utf-8');
  }, { perm: ['billing', 'view'] });

  // ---------------------------------------------------------------- generate drafts
  r.post('/api/billing/statements/generate', async (ctx) => {
    const db = ctx.env.DB;
    const body = await ctx.body();
    const period = periodOf(validate(body, { period: { type: 'str', required: true, max: 7 } }).period);
    if (period > budapestDate().slice(0, 7)) throw badRequest('Jövőbeli hónapra nem készíthetsz elszámolást.', { period: 'Jövőbeli hónap.' });

    let partners;
    const explicit = body.partner_ids !== undefined && body.partner_ids !== null;
    if (explicit) {
      const list = body.partner_ids;
      if (!Array.isArray(list) || !list.length || list.length > 500 || list.some((x) => !Number.isInteger(x) || x < 1)) {
        throw badRequest('Ellenőrizd a megjelölt mezőket.', { partner_ids: 'Válassz legalább egy ügyfelet.' });
      }
      const ids = [...new Set(list)];
      partners = [];
      for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90);
        partners.push(...await all(db, `SELECT id, name FROM partners WHERE type = 'client' AND id IN (${marks(chunk.length)})`, ...chunk));
      }
      if (partners.length !== ids.length) throw badRequest('Ismeretlen ügyfél a kijelölésben.', { partner_ids: 'Ismeretlen ügyfél.' });
    } else {
      // Every client: inactive ones too, as long as they had activity in the month (last statement).
      partners = await all(db, "SELECT id, name, status FROM partners WHERE type = 'client' ORDER BY name COLLATE NOCASE");
    }

    const existing = new Map((await all(db, 'SELECT * FROM statements WHERE period = ?', period)).map((s) => [s.partner_id, s]));
    const calc = await calculatePeriod(db, period, partners.map((p) => p.id));
    const out = { period, created: 0, updated: 0, skipped: [], statements: [] };
    const now = nowIso();
    const uid = ctx.user ? ctx.user.id : null;

    for (const p of partners) {
      const ex = existing.get(p.id);
      const skip = (reason) => out.skipped.push({ partner_id: p.id, name: p.name, statement_id: ex ? ex.id : null, reason });
      if (ex && LOCKED.includes(ex.status)) { skip(ex.status === 'approved' ? 'Már jóvá van hagyva.' : 'Már számlázva.'); continue; }
      if (ex && ex.status === 'void' && !explicit) { skip('Érvénytelenítve. Újrakészítéshez jelöld ki külön.'); continue; }
      const c = calc.get(p.id);
      const manual = ex ? parseJson(ex.lines, []).filter((l) => l.manual) : [];
      if (!ex && !explicit) {
        // An inactive client's fixed monthly items alone do not make a statement.
        const billable = p.status === 'inactive' ? c.lines.filter((l) => !(l.detail && l.detail.kind === 'monthly')) : c.lines;
        if (!billable.length) {
          if (p.status !== 'inactive') skip('Nincs számlázható tétel ebben a hónapban.');
          continue;
        }
      }
      const totals = withTotals([...c.lines, ...manual], c.vat_pct);
      const lines = JSON.stringify(totals.lines);
      const meta = JSON.stringify(c.meta);
      if (ex) {
        const res = await run(db, `UPDATE statements SET status = 'draft', lines = ?, net = ?, vat_pct = ?, vat = ?, gross = ?, meta = ?, generated_at = ?, generated_by = ?,
            approved_by = NULL, approved_at = NULL, invoice_provider = '', invoice_number = '', invoice_external_id = '', invoice_document_id = NULL,
            invoiced_at = NULL, invoice_error = '', invoice_uncertain = 0, invoice_lock_at = NULL, voided_by = NULL, voided_at = NULL, void_reason = ''
          WHERE id = ? AND status = ?`, lines, totals.net, c.vat_pct, totals.vat, totals.gross, meta, now, uid, ex.id, ex.status);
        if (res.meta.changes !== 1) { skip('Közben megváltozott, próbáld újra.'); continue; }
        out.updated++;
        const wasVoid = ex.status === 'void';
        await audit(ctx, {
          module: 'billing', action: 'create', entity: 'statement', entityId: ex.id,
          summary: `${ex.number} ${wasVoid ? 'újrakészítve érvénytelenített elszámolásból' : 'újraszámolva'} (${p.name}, ${period}), nettó ${totals.net} Ft`,
          details: wasVoid && ex.invoice_number ? { previous_invoice: ex.invoice_number } : null,
        });
        out.statements.push({ id: ex.id, partner_id: p.id, number: ex.number, status: 'draft', net: totals.net, gross: totals.gross });
      } else {
        const number = await nextNumber(db, 'EL');
        const res = await run(db, `INSERT INTO statements (number, partner_id, period, status, lines, net, vat_pct, vat, gross, meta, generated_at, generated_by)
            VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (partner_id, period) DO NOTHING`,
        number, p.id, period, lines, totals.net, c.vat_pct, totals.vat, totals.gross, meta, now, uid);
        if (res.meta.changes !== 1) { skip('Közben valaki más elkészítette.'); continue; }
        const id = res.meta.last_row_id;
        out.created++;
        await audit(ctx, { module: 'billing', action: 'create', entity: 'statement', entityId: id, summary: `${number} elkészítve (${p.name}, ${period}), nettó ${totals.net} Ft` });
        out.statements.push({ id, partner_id: p.id, number, status: 'draft', net: totals.net, gross: totals.gross });
      }
    }
    return out;
  }, { perm: ['billing', 'create'] });

  // ---------------------------------------------------------------- statement
  r.get('/api/billing/statements/:id', async (ctx) => {
    const db = ctx.env.DB;
    const st = await loadStatement(db, idParam(ctx));
    const out = shape(st);
    out.label = periodLabel(st.period);
    if (st.status === 'draft') {
      const { calc, totals } = await freshLines(db, st);
      out.stale = !sameLines(out.lines, calc.lines) || Number(calc.vat_pct) !== Number(st.vat_pct);
      if (out.stale) out.fresh = { net: totals.net, vat: totals.vat, gross: totals.gross };
    } else out.stale = false;
    out.partner = await first(db, `SELECT id, code, name, status, tax_number, eu_vat_number, billing_name, billing_zip, billing_city, billing_address, billing_country,
        billing_email, zip, city, address, payment_days FROM partners WHERE id = ?`, st.partner_id);
    out.invoicing = await invoicingStatus(ctx.env);
    out.groups = GROUPS;
    out.history = await all(db, "SELECT at, actor, summary FROM audit_log WHERE entity = 'statement' AND entity_id = ? ORDER BY id DESC LIMIT 30", String(st.id));
    return out;
  }, { perm: ['billing', 'view'] });

  r.get('/api/billing/statements/:id/details', async (ctx) => {
    const st = await loadStatement(ctx.env.DB, idParam(ctx));
    const kind = ctx.query.get('kind');
    if (!DETAIL_KINDS.includes(kind)) throw badRequest('Ismeretlen részletező lista.');
    const { limit, offset } = page(ctx.query, 200, 1000);
    return { kind, limit, offset, ...(await statementDetails(ctx.env.DB, st, kind, { limit, offset })) };
  }, { perm: ['billing', 'view'] });

  r.get('/api/billing/statements/:id/export', async (ctx) => {
    const st = shape(await loadStatement(ctx.env.DB, idParam(ctx)));
    const groupLabel = Object.fromEntries(GROUPS.map((g) => [g.key, g.label]));
    const rows = st.lines.map((l) => ({ ...l, group_label: groupLabel[l.group] || l.group }));
    rows.push({ group_label: 'Összesen', name: '', amount: st.net, vat: st.vat, gross: st.gross });
    const csv = toCsv([
      { key: 'group_label', label: 'Csoport' },
      { key: 'name', label: 'Tétel' },
      { label: 'Mennyiség', value: (x) => csvNum(x.qty) },
      { key: 'unit', label: 'Egység' },
      { label: 'Egységár', value: (x) => csvNum(x.price) },
      { key: 'price_unit', label: 'Ár egysége' },
      { label: 'Nettó (Ft)', value: (x) => csvNum(x.amount) },
      { label: `ÁFA ${csvNum(st.vat_pct)}% (Ft)`, value: (x) => csvNum(x.vat) },
      { label: 'Bruttó (Ft)', value: (x) => csvNum(x.gross) },
    ], rows);
    return download(csv, `${st.number}-${st.partner_code}-${st.period}.csv`, 'text/csv; charset=utf-8');
  }, { perm: ['billing', 'view'] });

  // Manual lines on drafts.
  r.post('/api/billing/statements/:id/lines', async (ctx) => {
    const st = await loadStatement(ctx.env.DB, idParam(ctx));
    const data = validate(await ctx.body(), {
      group: { type: 'enum', values: GROUP_KEYS, default: 'custom' },
      name: { type: 'str', required: true, max: 200 },
      qty: { type: 'num', required: true, min: 0.01, max: 1000000 },
      unit: { type: 'str', max: 30, default: 'db' },
      price: { type: 'num', required: true, min: -100000000, max: 100000000 },
    });
    const amount = roundHuf(data.qty * data.price);
    if (amount === 0) throw badRequest('A tétel összege 0 Ft lenne.', { price: 'Adj meg egységárat.' });
    const lineId = `m-${crypto.randomUUID().slice(0, 8)}`;
    const totals = await updateDraftLines(ctx, st, (lines) => [...lines, {
      id: lineId, key: 'manual', group: data.group, name: data.name, qty: data.qty, unit: data.unit || 'db', price: data.price, price_unit: 'Ft',
      amount, detail: null, warn: '', manual: true, created_by: ctx.user ? ctx.user.name : '', created_at: nowIso(),
    }]);
    await audit(ctx, { module: 'billing', action: 'edit', entity: 'statement', entityId: st.id, summary: `${st.number}: kézi tétel hozzáadva: ${data.name} (${amount} Ft)` });
    return { id: lineId, net: totals.net, vat: totals.vat, gross: totals.gross };
  }, { perm: ['billing', 'edit'] });

  r.delete('/api/billing/statements/:id/lines/:lineId', async (ctx) => {
    const st = await loadStatement(ctx.env.DB, idParam(ctx));
    const target = parseJson(st.lines, []).find((l) => l.id === ctx.params.lineId);
    if (!target) throw notFound('A tétel nem található.');
    if (!target.manual) throw conflict('Számított tétel nem törölhető. Javítsd a tarifát vagy az adatokat és számold újra, vagy adj hozzá jóváíró tételt.');
    const totals = await updateDraftLines(ctx, st, (lines) => lines.filter((l) => l.id !== target.id));
    await audit(ctx, { module: 'billing', action: 'edit', entity: 'statement', entityId: st.id, summary: `${st.number}: kézi tétel törölve: ${target.name}` });
    return { ok: true, net: totals.net, vat: totals.vat, gross: totals.gross };
  }, { perm: ['billing', 'edit'] });

  r.delete('/api/billing/statements/:id', async (ctx) => {
    const st = await loadStatement(ctx.env.DB, idParam(ctx));
    if (st.status !== 'draft') throw conflict('Csak piszkozat törölhető. Jóváhagyott elszámolást érvényteleníteni lehet.');
    const res = await run(ctx.env.DB, "DELETE FROM statements WHERE id = ? AND status = 'draft'", st.id);
    if (res.meta.changes !== 1) throw conflict('Az elszámolás közben megváltozott. Frissítsd az oldalt.');
    await audit(ctx, { module: 'billing', action: 'delete', entity: 'statement', entityId: st.id, summary: `${st.number} piszkozat törölve (${st.partner_name}, ${st.period})` });
    return { ok: true, period: st.period };
  }, { perm: ['billing', 'delete'] });

  r.post('/api/billing/statements/:id/approve', async (ctx) => {
    const db = ctx.env.DB;
    const st = await loadStatement(db, idParam(ctx));
    if (st.status !== 'draft') throw conflict('Csak piszkozatot lehet jóváhagyni.');
    const lines = parseJson(st.lines, []);
    if (!lines.length) throw conflict('Üres elszámolást nem hagyhatsz jóvá.');
    const { calc } = await freshLines(db, st);
    if (!sameLines(lines, calc.lines) || Number(calc.vat_pct) !== Number(st.vat_pct)) {
      throw conflict('Az elszámolás készítése óta változtak az adatok vagy a tarifák. Számold újra a jóváhagyás előtt.');
    }
    const res = await run(db, "UPDATE statements SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ? AND status = 'draft'",
      ctx.user ? ctx.user.id : null, nowIso(), st.id);
    if (res.meta.changes !== 1) throw conflict('Az elszámolás közben megváltozott. Frissítsd az oldalt.');
    await audit(ctx, { module: 'billing', action: 'approve', entity: 'statement', entityId: st.id, summary: `${st.number} jóváhagyva (${st.partner_name}, ${st.period}), nettó ${st.net} Ft` });
    return { ok: true, status: 'approved' };
  }, { perm: ['billing', 'approve'] });

  r.post('/api/billing/statements/:id/void', async (ctx) => {
    const db = ctx.env.DB;
    const st = await loadStatement(db, idParam(ctx));
    const data = validate(await ctx.body(), {
      reason: { type: 'str', required: true, max: 500 },
      invoice_cancelled: { type: 'bool', default: false },
    });
    if (!LOCKED.includes(st.status)) throw conflict('Csak jóváhagyott vagy számlázott elszámolás érvényteleníthető. Piszkozatot törölni lehet.');
    if (busy(st)) throw conflict('A számla kiállítása éppen folyamatban van. Várd meg a végét.');
    if (st.status === 'invoiced' && !data.invoice_cancelled) {
      throw conflict(`Ehhez az elszámoláshoz már készült számla (${st.invoice_number}). Előbb sztornózd a számlázóban, majd erősítsd meg.`, { invoice_cancelled: 'Erősítsd meg a sztornózást.' });
    }
    const res = await run(db, 'UPDATE statements SET status = ?, voided_by = ?, voided_at = ?, void_reason = ? WHERE id = ? AND status = ?',
      'void', ctx.user ? ctx.user.id : null, nowIso(), data.reason, st.id, st.status);
    if (res.meta.changes !== 1) throw conflict('Az elszámolás közben megváltozott. Frissítsd az oldalt.');
    await audit(ctx, {
      module: 'billing', action: 'approve', entity: 'statement', entityId: st.id,
      summary: `${st.number} érvénytelenítve${st.invoice_number ? ` (számla: ${st.invoice_number}, sztornó a számlázóban)` : ''}: ${data.reason}`,
    });
    return { ok: true, status: 'void' };
  }, { perm: ['billing', 'approve'] });

  r.post('/api/billing/statements/:id/invoice', async (ctx) => {
    const id = idParam(ctx);
    await loadStatement(ctx.env.DB, id);
    return issueInvoice(ctx, id);
  }, { perm: ['billing', 'approve'] });

  // ---------------------------------------------------------------- billing entries
  r.get('/api/billing/entries', async (ctx) => {
    const db = ctx.env.DB;
    const period = queryPeriod(ctx);
    const { from, to } = monthRange(period);
    const partnerId = ctx.query.get('partner_id') ? Number(ctx.query.get('partner_id')) : null;
    if (partnerId !== null && !(Number.isInteger(partnerId) && partnerId > 0)) throw badRequest('Érvénytelen ügyfél.');
    const { limit, offset } = page(ctx.query, 100, 500);
    const where = 'e.date BETWEEN ? AND ? AND (? IS NULL OR e.partner_id = ?)';
    const total = (await first(db, `SELECT COUNT(*) AS n FROM billing_entries e WHERE ${where}`, from, to, partnerId, partnerId)).n;
    const rows = await all(db, `SELECT e.*, p.name AS partner_name, p.code AS partner_code, c.name AS item_name, c.unit AS item_unit, c.price AS item_price,
        u.name AS created_by_name, s.status AS statement_status, s.number AS statement_number,
        COALESCE((SELECT value FROM partner_tariffs WHERE partner_id = e.partner_id AND key = 'hourly_work'), NULL) AS hourly_price
      FROM billing_entries e JOIN partners p ON p.id = e.partner_id
      LEFT JOIN partner_custom_items c ON c.id = e.custom_item_id LEFT JOIN users u ON u.id = e.created_by
      LEFT JOIN statements s ON s.partner_id = e.partner_id AND s.period = substr(e.date, 1, 7)
      WHERE ${where} ORDER BY e.date DESC, e.id DESC LIMIT ? OFFSET ?`, from, to, partnerId, partnerId, limit, offset);
    const defaults = await first(db, "SELECT value FROM settings WHERE key = 'default_tariffs'");
    const defaultHourly = Number(parseJson(defaults && defaults.value, {}).hourly_work) || 0;
    const items = rows.map((e) => {
      const price = e.kind === 'hourly_work' ? (e.hourly_price != null ? Number(e.hourly_price) : defaultHourly) : e.item_price;
      const { hourly_price: _h, ...rest } = e;
      return {
        ...rest,
        unit: e.kind === 'hourly_work' ? 'óra' : e.item_unit || 'db',
        price: price ?? null,
        amount: price != null ? roundHuf(e.qty * price) : null,
        locked: LOCKED.includes(e.statement_status),
      };
    });
    return { period, items, total, limit, offset };
  }, { perm: ['billing', 'view'] });

  const ENTRY_FIELDS = {
    partner_id: { type: 'id', required: true },
    date: { type: 'date', required: true },
    kind: { type: 'enum', values: ['hourly_work', 'custom'], required: true },
    custom_item_id: { type: 'id', nullable: true },
    qty: { type: 'num', required: true, min: 0.01, max: 100000 },
    note: { type: 'text', max: 500, default: '' },
  };

  async function checkEntry(db, e) {
    const partner = await first(db, 'SELECT id, type, name FROM partners WHERE id = ?', e.partner_id);
    if (!partner || partner.type !== 'client') throw badRequest('Ismeretlen ügyfél.', { partner_id: 'Válassz ügyfelet.' });
    if (e.date > budapestDate()) throw badRequest('Jövőbeli napra nem rögzíthetsz tételt.', { date: 'Jövőbeli dátum.' });
    if (e.kind === 'custom') {
      if (!e.custom_item_id) throw badRequest('Válaszd ki az egyedi tételt.', { custom_item_id: 'Kötelező mező.' });
      const item = await first(db, 'SELECT id, partner_id, kind, active, name FROM partner_custom_items WHERE id = ?', e.custom_item_id);
      if (!item || item.partner_id !== e.partner_id) throw badRequest('Ez az egyedi tétel nem ehhez az ügyfélhez tartozik.', { custom_item_id: 'Ismeretlen tétel.' });
      if (item.kind !== 'per_unit') throw badRequest('A havi díjas tételt nem kell rögzíteni, havonta egyszer automatikusan számlázzuk.', { custom_item_id: 'Havi díjas tétel.' });
      if (!item.active) throw badRequest('Az egyedi tétel inaktív.', { custom_item_id: 'Inaktív tétel.' });
    } else e.custom_item_id = null;
    await assertEntryOpen(db, e.partner_id, e.date);
    return partner;
  }

  r.post('/api/billing/entries', async (ctx) => {
    const db = ctx.env.DB;
    const e = validate(await ctx.body(), ENTRY_FIELDS);
    const partner = await checkEntry(db, e);
    const res = await run(db, 'INSERT INTO billing_entries (partner_id, date, kind, custom_item_id, qty, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      e.partner_id, e.date, e.kind, e.custom_item_id, e.qty, e.note, ctx.user ? ctx.user.id : null);
    const id = res.meta.last_row_id;
    await audit(ctx, { module: 'billing', action: 'create', entity: 'billing_entry', entityId: id, summary: `${e.kind === 'hourly_work' ? 'Munkaóra' : 'Egyedi tétel'} rögzítve: ${partner.name}, ${e.date}, ${e.qty}` });
    return { id };
  }, { perm: ['billing', 'create'] });

  r.patch('/api/billing/entries/:id', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const cur = await first(db, 'SELECT * FROM billing_entries WHERE id = ?', id);
    if (!cur) throw notFound('A tétel nem található.');
    const changes = validate(await ctx.body(), ENTRY_FIELDS, { partial: true });
    delete changes.partner_id;
    const next = { ...cur, ...changes };
    await assertEntryOpen(db, cur.partner_id, cur.date);
    const partner = await checkEntry(db, next);
    await run(db, 'UPDATE billing_entries SET date = ?, kind = ?, custom_item_id = ?, qty = ?, note = ? WHERE id = ?',
      next.date, next.kind, next.custom_item_id, next.qty, next.note, id);
    await audit(ctx, { module: 'billing', action: 'edit', entity: 'billing_entry', entityId: id, summary: `Elszámolási tétel módosítva: ${partner.name}, ${next.date}, ${next.qty}` });
    return { ok: true };
  }, { perm: ['billing', 'edit'] });

  r.delete('/api/billing/entries/:id', async (ctx) => {
    const db = ctx.env.DB;
    const id = idParam(ctx);
    const cur = await first(db, 'SELECT e.*, p.name AS partner_name FROM billing_entries e JOIN partners p ON p.id = e.partner_id WHERE e.id = ?', id);
    if (!cur) throw notFound('A tétel nem található.');
    await assertEntryOpen(db, cur.partner_id, cur.date);
    await run(db, 'DELETE FROM billing_entries WHERE id = ?', id);
    await audit(ctx, { module: 'billing', action: 'delete', entity: 'billing_entry', entityId: id, summary: `Elszámolási tétel törölve: ${cur.partner_name}, ${cur.date}, ${cur.qty}` });
    return { ok: true };
  }, { perm: ['billing', 'delete'] });

  r.get('/api/billing/custom-items', async (ctx) => {
    const partnerId = Number(ctx.query.get('partner_id'));
    if (!Number.isInteger(partnerId) || partnerId < 1) throw badRequest('Válassz ügyfelet.');
    const items = await all(ctx.env.DB, 'SELECT id, name, unit, price, kind, active FROM partner_custom_items WHERE partner_id = ? ORDER BY kind DESC, name', partnerId);
    return { items };
  }, { perm: ['billing', 'view'] });

  // ---------------------------------------------------------------- snapshot
  r.post('/api/billing/snapshot', async (ctx) => {
    const date = budapestDate();
    const res = await takeDailySnapshot(ctx.env, date, { source: 'manual' });
    await audit(ctx, { module: 'billing', action: 'create', entity: 'snapshot', entityId: date, summary: `Tárolási pillanatkép rögzítve kézzel: ${date}, ${res.rows} raktárhely` });
    return { date, rows: res.rows };
  }, { perm: ['billing', 'create'] });
}
