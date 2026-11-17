// HTTP helpers shared by every route: JSON responses, errors with Hungarian messages, request bodies.

export class HttpError extends Error {
  constructor(status, message, code = 'error', fields = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export const badRequest = (message, fields) => new HttpError(400, message, 'bad_request', fields);
export const unauthorized = (message = 'Be kell jelentkezned.') => new HttpError(401, message, 'unauthorized');
export const forbidden = (message = 'Ehhez nincs jogosultságod.') => new HttpError(403, message, 'forbidden');
export const notFound = (message = 'Nem található.') => new HttpError(404, message, 'not_found');
export const conflict = (message, fields) => new HttpError(409, message, 'conflict', fields);

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    const body = { error: { code: err.code, message: err.message } };
    if (err.fields) body.error.fields = err.fields;
    return json(body, err.status);
  }
  const id = crypto.randomUUID().slice(0, 8);
  console.error(`[${id}]`, err && err.stack ? err.stack : err);
  return json({ error: { code: 'server_error', message: `Váratlan hiba történt (azonosító: ${id}).` } }, 500);
}

// Reads a JSON body once. Throws a 400 for malformed JSON or a non-object body.
export async function readJson(req) {
  const type = req.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw badRequest('A kérés törzsének JSON-nek kell lennie.');
  let data;
  try {
    data = await req.json();
  } catch {
    throw badRequest('Hibás JSON a kérésben.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw badRequest('A kérés törzsének objektumnak kell lennie.');
  return data;
}

// File download response (CSV, PDF, files from R2).
export function download(body, filename, contentType) {
  const safe = filename.replace(/[^\w.\- ]+/g, '_');
  return new Response(body, {
    headers: {
      'content-type': contentType,
      'content-disposition': `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

// Pagination from ?limit=&offset= with sane bounds.
export function page(query, defaultLimit = 50, maxLimit = 500) {
  const limit = Math.min(Math.max(parseInt(query.get('limit') || defaultLimit, 10) || defaultLimit, 1), maxLimit);
  const offset = Math.max(parseInt(query.get('offset') || '0', 10) || 0, 0);
  return { limit, offset };
}
