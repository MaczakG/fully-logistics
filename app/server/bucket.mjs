// The part of Cloudflare's R2 API the app uses, on a local folder (development, tests) or on an
// S3 bucket (the Lightsail bucket in production).
//
//   bucket.put(key, value, { httpMetadata: { contentType } }) -> { key, size, etag, httpMetadata }
//   bucket.get(key)    -> { key, size, etag, httpMetadata, body, arrayBuffer(), text(), json() } or null
//   bucket.head(key)   -> object without body, or null
//   bucket.delete(key | [keys])
//   bucket.list({ prefix, cursor, limit }) -> { objects: [{ key, size, uploaded }], truncated, cursor }

import { mkdir, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { awsFetch, encodeKey } from './sigv4.mjs';

// Every value R2 accepts, as one Buffer (uploads are at most 20 MB).
export async function toBuffer(value) {
  if (value == null) return Buffer.alloc(0);
  if (typeof value === 'string') return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value.arrayBuffer === 'function') return Buffer.from(await value.arrayBuffer()); // Blob, File
  if (typeof value.getReader === 'function') return Buffer.from(await new Response(value).arrayBuffer()); // ReadableStream
  throw new TypeError('Unsupported R2 value');
}

function objectBody(meta, buf) {
  return {
    ...meta,
    get body() { return new Response(buf).body; },
    bodyUsed: false,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => buf.toString('utf8'),
    json: async () => JSON.parse(buf.toString('utf8')),
    blob: async () => new Blob([buf], { type: meta.httpMetadata.contentType || '' }),
    writeHttpMetadata(headers) { if (meta.httpMetadata.contentType) headers.set('content-type', meta.httpMetadata.contentType); },
  };
}

const checkKey = (key) => {
  const k = String(key || '');
  if (!k || k.length > 1024 || k.split('/').some((p) => p === '..' || p === '.') || k.startsWith('/') || k.includes('\0')) {
    throw new TypeError(`Invalid object key: ${k.slice(0, 80)}`);
  }
  return k;
};

// ---------------------------------------------------------------- local folder

export class DiskBucket {
  constructor(root) {
    this.root = resolve(root);
  }

  paths(key) {
    const file = resolve(this.root, checkKey(key));
    if (!file.startsWith(this.root + sep)) throw new TypeError('Invalid object key');
    return { file, meta: `${file}.r2meta.json` };
  }

  async put(key, value, { httpMetadata = {} } = {}) {
    const buf = await toBuffer(value);
    const { file, meta } = this.paths(key);
    await mkdir(dirname(file), { recursive: true });
    const info = {
      key, size: buf.length, etag: createHash('md5').update(buf).digest('hex'),
      uploaded: new Date().toISOString(), httpMetadata: { contentType: httpMetadata.contentType || 'application/octet-stream' },
    };
    await writeFile(file, buf);
    await writeFile(meta, JSON.stringify(info));
    return { ...info, uploaded: new Date(info.uploaded) };
  }

  async head(key) {
    const { meta } = this.paths(key);
    try {
      const info = JSON.parse(await readFile(meta, 'utf8'));
      return { ...info, uploaded: new Date(info.uploaded) };
    } catch {
      return null;
    }
  }

  async get(key) {
    const info = await this.head(key);
    if (!info) return null;
    return objectBody(info, await readFile(this.paths(key).file));
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const { file, meta } = this.paths(key);
      await rm(file, { force: true });
      await rm(meta, { force: true });
    }
  }

  async list({ prefix = '', limit = 1000 } = {}) {
    const out = [];
    const walk = async (dir) => {
      let entries = [];
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (!e.name.endsWith('.r2meta.json')) {
          const key = relative(this.root, p).split(sep).join('/');
          if (key.startsWith(prefix)) out.push({ key, size: (await stat(p)).size, uploaded: (await stat(p)).mtime });
        }
      }
    };
    await walk(this.root);
    out.sort((a, b) => (a.key < b.key ? -1 : 1));
    return { objects: out.slice(0, limit), truncated: out.length > limit, delimitedPrefixes: [] };
  }
}

// ---------------------------------------------------------------- S3 (Lightsail bucket)

const xmlValues = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export class S3Bucket {
  // prefix keeps the app's files apart from backups and releases in the same bucket.
  constructor({ bucket, region, credentials, prefix = '', endpoint = '', fetchImpl = fetch }) {
    this.bucket = bucket;
    this.region = region;
    this.credentials = credentials;
    this.prefix = prefix;
    this.base = (endpoint || `https://${bucket}.s3.${region}.amazonaws.com`).replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  url(key, query = '') {
    return `${this.base}/${encodeKey(this.prefix + checkKey(key))}${query}`;
  }

  async request(method, url, { headers = {}, body } = {}) {
    const res = await awsFetch(url, { method, headers, body, service: 's3', region: this.region, credentials: this.credentials, fetchImpl: this.fetchImpl });
    return res;
  }

  async fail(res, what) {
    const text = await res.text().catch(() => '');
    const code = xmlValues(text, 'Code')[0] || res.status;
    throw new Error(`S3 ${what}: ${code} ${xmlValues(text, 'Message')[0] || ''}`.trim());
  }

  async put(key, value, { httpMetadata = {} } = {}) {
    const buf = await toBuffer(value);
    const contentType = httpMetadata.contentType || 'application/octet-stream';
    const res = await this.request('PUT', this.url(key), { headers: { 'content-type': contentType }, body: buf });
    if (!res.ok) await this.fail(res, `put ${key}`);
    return { key, size: buf.length, etag: (res.headers.get('etag') || '').replace(/"/g, ''), uploaded: new Date(), httpMetadata: { contentType } };
  }

  meta(key, res, size) {
    return {
      key,
      size,
      etag: (res.headers.get('etag') || '').replace(/"/g, ''),
      uploaded: new Date(res.headers.get('last-modified') || Date.now()),
      httpMetadata: { contentType: res.headers.get('content-type') || 'application/octet-stream' },
    };
  }

  async head(key) {
    const res = await this.request('HEAD', this.url(key));
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res, `head ${key}`);
    return this.meta(key, res, Number(res.headers.get('content-length') || 0));
  }

  async get(key) {
    const res = await this.request('GET', this.url(key));
    if (res.status === 404) { await res.arrayBuffer().catch(() => {}); return null; }
    if (!res.ok) await this.fail(res, `get ${key}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return objectBody(this.meta(key, res, buf.length), buf);
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const res = await this.request('DELETE', this.url(key));
      if (!res.ok && res.status !== 404) await this.fail(res, `delete ${key}`);
    }
  }

  async list({ prefix = '', cursor = '', limit = 1000 } = {}) {
    const q = new URLSearchParams({ 'list-type': '2', prefix: this.prefix + prefix, 'max-keys': String(limit) });
    if (cursor) q.set('continuation-token', cursor);
    const res = await this.request('GET', `${this.base}/?${q}`);
    if (!res.ok) await this.fail(res, 'list');
    const xml = await res.text();
    const objects = xmlValues(xml, 'Contents').map((c) => ({
      key: unxml(xmlValues(c, 'Key')[0] || '').slice(this.prefix.length),
      size: Number(xmlValues(c, 'Size')[0] || 0),
      uploaded: new Date(xmlValues(c, 'LastModified')[0] || 0),
    }));
    const truncated = xmlValues(xml, 'IsTruncated')[0] === 'true';
    return { objects, truncated, cursor: truncated ? unxml(xmlValues(xml, 'NextContinuationToken')[0] || '') : undefined, delimitedPrefixes: [] };
  }
}
