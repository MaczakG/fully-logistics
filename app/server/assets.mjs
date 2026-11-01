// Static files of the single page app (dist/), served the way Cloudflare's assets binding does
// with the settings in wrangler.jsonc: the rules of dist/_headers, ETags, and index.html for any
// path that is not a file (single-page-application).

import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.map': 'application/json',
};

// Cloudflare _headers: a path pattern at the start of a line, its headers indented below.
// "*" matches anything (also "/"), ":name" one segment.
export function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      const pattern = raw.trim();
      const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/:\w+/g, '[^/]+')}$`);
      current = { pattern, re, set: [], unset: [] };
      rules.push(current);
    } else if (current) {
      const line = raw.trim();
      if (line.startsWith('! ')) current.unset.push(line.slice(2).trim().toLowerCase());
      else {
        const i = line.indexOf(':');
        if (i > 0) current.set.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
      }
    }
  }
  return rules;
}

export function createAssets(dir) {
  const root = resolve(dir);
  let rules = null;
  const cache = new Map(); // path -> { buf, etag, mtimeMs }

  async function loadRules() {
    if (rules) return rules;
    try { rules = parseHeaders(await readFile(resolve(root, '_headers'), 'utf8')); } catch { rules = []; }
    return rules;
  }

  async function file(path) {
    const full = resolve(root, `.${path}`);
    if (full !== root && !full.startsWith(root + sep)) return null;
    let st;
    try { st = await stat(full); } catch { return null; }
    if (!st.isFile()) return null;
    const hit = cache.get(full);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit;
    const buf = await readFile(full);
    const entry = { buf, etag: `"${createHash('sha1').update(buf).digest('hex').slice(0, 20)}"`, mtimeMs: st.mtimeMs, type: TYPES[extname(full).toLowerCase()] || 'application/octet-stream' };
    cache.set(full, entry);
    return entry;
  }

  return {
    async fetch(req) {
      const url = new URL(req.url);
      if (!['GET', 'HEAD'].includes(req.method)) return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
      let path;
      try { path = decodeURIComponent(url.pathname); } catch { return new Response('Bad Request', { status: 400 }); }
      if (path.includes('\0') || path.includes('/_headers')) return new Response('Not Found', { status: 404 });
      // "/index.html" lives at "/"; like Cloudflare's html handling, redirect to the clean path.
      if (path === '/index.html') return new Response(null, { status: 307, headers: { location: `/${url.search}` } });
      let f = path.endsWith('/') ? await file(`${path}index.html`) : await file(path);
      let served = path;
      if (!f) {
        // Single page app: unknown paths get index.html, except missing files with an extension.
        if (extname(path)) return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        f = await file('/index.html');
        served = '/index.html';
        if (!f) return new Response('Not Found', { status: 404 });
      }
      const headers = new Headers({ 'content-type': f.type, etag: f.etag, 'cache-control': 'public, max-age=0, must-revalidate' });
      for (const rule of await loadRules()) {
        if (!rule.re.test(url.pathname) && !rule.re.test(served)) continue;
        for (const name of rule.unset) headers.delete(name);
        for (const [k, v] of rule.set) headers.set(k, v);
      }
      if (req.headers.get('if-none-match') === f.etag) {
        headers.delete('content-type');
        return new Response(null, { status: 304, headers });
      }
      headers.set('content-length', String(f.buf.length));
      return new Response(req.method === 'HEAD' ? null : f.buf, { status: 200, headers });
    },
  };
}
