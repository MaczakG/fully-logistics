// AWS Signature Version 4 for the few AWS calls the app and the deploy scripts make (S3 objects of
// the Lightsail bucket, the Lightsail API). No SDK: node:crypto and fetch.
//
//   const res = await awsFetch(url, { method, headers, body, service: 's3', region, credentials })
//   credentials: { accessKeyId, secretAccessKey, sessionToken? }

import { createHash, createHmac } from 'node:crypto';

const hex = (buf) => Buffer.from(buf).toString('hex');
export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// RFC 3986 encoding as SigV4 wants it (encodeURIComponent leaves !'()* alone).
export const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// S3 object keys: every path segment encoded, the slashes kept.
export const encodeKey = (key) => String(key).split('/').map(rfc3986).join('/');

// string | Buffer | Uint8Array | ArrayBuffer -> something createHash accepts.
export function toBytes(body) {
  if (body == null) return '';
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('Signed request bodies must be strings or bytes');
}

export function signingKey(secretAccessKey, dateStamp, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
}

// Returns the headers to send (the given ones plus host, x-amz-date, authorization ...).
export function signRequest({ method = 'GET', url, headers = {}, body = '', service, region, credentials, now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(toBytes(body));

  const out = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && v !== null) out[k.toLowerCase()] = String(v);
  out.host = u.host;
  out['x-amz-date'] = amzDate;
  if (service === 's3') out['x-amz-content-sha256'] = payloadHash;
  if (credentials.sessionToken) out['x-amz-security-token'] = credentials.sessionToken;

  const names = Object.keys(out).sort();
  const canonicalHeaders = names.map((n) => `${n}:${out[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  // URL already holds the path encoded once (encodeKey); S3 signs it as is, other services encode again.
  const path = u.pathname || '/';
  const canonicalPath = service === 's3' ? path : path.split('/').map((s) => rfc3986(decodeURIComponent(s))).join('/');
  const canonicalRequest = [method.toUpperCase(), canonicalPath, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hex(hmac(signingKey(credentials.secretAccessKey, dateStamp, region, service), stringToSign));
  out.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete out.host; // fetch sets it
  return { headers: out, signature, canonicalRequest, stringToSign };
}

export async function awsFetch(url, { method = 'GET', headers = {}, body, service, region, credentials, fetchImpl = fetch } = {}) {
  const { headers: signed } = signRequest({ method, url, headers, body: body ?? '', service, region, credentials });
  return fetchImpl(url, { method, headers: signed, body: body === undefined || method === 'GET' || method === 'HEAD' ? undefined : body });
}

// The Lightsail JSON API: lightsail('CreateBucket', { ... }) -> parsed JSON, or throws with AWS's message.
export async function lightsail(action, params, { region, credentials, fetchImpl } = {}) {
  const url = `https://lightsail.${region}.amazonaws.com/`;
  const body = JSON.stringify(params || {});
  const res = await awsFetch(url, {
    method: 'POST',
    service: 'lightsail',
    region,
    credentials,
    body,
    fetchImpl,
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `Lightsail_20161128.${action}` },
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!res.ok) {
    const err = new Error(`Lightsail ${action}: ${data.message || data.Message || res.status}`);
    err.status = res.status;
    err.code = data.__type || data.code || '';
    throw err;
  }
  return data;
}
