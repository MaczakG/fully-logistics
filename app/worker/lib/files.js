// Files in R2 (binding FILES) with a documents row each: contracts, quotes, invoices, labels, photos.

import { first, run } from './db.js';
import { badRequest, download, forbidden, notFound } from './http.js';
import { can } from './perm.js';

export const MAX_UPLOAD = 20 * 1024 * 1024;

// Stores bytes and returns the documents row id.
export async function storeFile(ctx, { partnerId = null, contractId = null, kind = 'other', filename, contentType = 'application/octet-stream', body }) {
  const size = body.byteLength ?? body.size ?? 0;
  if (size > MAX_UPLOAD) throw badRequest('A fájl legfeljebb 20 MB lehet.');
  const key = `${kind}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}`;
  await ctx.env.FILES.put(key, body, { httpMetadata: { contentType } });
  const res = await run(
    ctx.env.DB,
    'INSERT INTO documents (partner_id, contract_id, kind, filename, content_type, size, r2_key, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    partnerId, contractId, kind, String(filename).slice(0, 200), contentType, size, key, ctx.user ? ctx.user.id : null,
  );
  return res.meta.last_row_id;
}

// Reads a file from a multipart/form-data request (field "file").
export async function readUpload(ctx, field = 'file') {
  const type = ctx.req.headers.get('content-type') || '';
  if (!type.includes('multipart/form-data')) throw badRequest('Fájlfeltöltést várunk (multipart/form-data).');
  const form = await ctx.req.formData();
  const file = form.get(field);
  if (!file || typeof file === 'string') throw badRequest('Nincs kiválasztott fájl.');
  if (file.size > MAX_UPLOAD) throw badRequest('A fájl legfeljebb 20 MB lehet.');
  return { file, form };
}

// Who may open which kind of document.
const VIEW_RULES = {
  contract: [['partners', 'view']],
  quote: [['quotes', 'view'], ['partners', 'view']],
  invoice: [['billing', 'view']],
  label: [['picking', 'view'], ['orders', 'view'], ['transport', 'view'], ['history', 'view']],
  manifest: [['transport', 'view']],
  photo: [['inbound', 'view'], ['history', 'view'], ['partners', 'view']],
  other: [['partners', 'view']],
};

export async function sendDocument(ctx, id, { inline = false } = {}) {
  const doc = await first(ctx.env.DB, 'SELECT * FROM documents WHERE id = ?', id);
  if (!doc) throw notFound('A dokumentum nem található.');
  const rules = VIEW_RULES[doc.kind] || VIEW_RULES.other;
  if (!rules.some(([m, a]) => can(ctx.user, m, a))) throw forbidden();
  const obj = await ctx.env.FILES.get(doc.r2_key);
  if (!obj) throw notFound('A fájl nem található a tárhelyen.');
  const res = download(obj.body, doc.filename, doc.content_type);
  if (inline && /^(application\/pdf|image\/)/.test(doc.content_type)) {
    res.headers.set('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.filename)}`);
  }
  return res;
}

export async function deleteDocument(ctx, id) {
  const doc = await first(ctx.env.DB, 'SELECT * FROM documents WHERE id = ?', id);
  if (!doc) throw notFound('A dokumentum nem található.');
  await ctx.env.FILES.delete(doc.r2_key);
  await run(ctx.env.DB, 'DELETE FROM documents WHERE id = ?', id);
  return doc;
}
