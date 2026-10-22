// node:http <-> fetch Request/Response, and the Workers ExecutionContext (waitUntil).

import { Readable } from 'node:stream';

// Behind Caddy (trustProxy) the public scheme comes from X-Forwarded-Proto and the client address
// from X-Forwarded-For (Caddy replaces what the client sent). The worker reads the address as
// cf-connecting-ip, as on Cloudflare; a value the client sent itself is never passed on.
export function toRequest(req, { trustProxy = false } = {}) {
  const proto = trustProxy && req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0].trim() : 'http';
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url || '/', `${proto}://${host}`);
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    if (name === 'cf-connecting-ip' || name.startsWith(':')) continue;
    headers.append(name, req.rawHeaders[i + 1]);
  }
  const ip = trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',').pop().trim() : req.socket.remoteAddress || '';
  if (ip) headers.set('cf-connecting-ip', ip);
  const method = req.method || 'GET';
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }
  return new Request(url, init);
}

export async function sendResponse(res, response, { head = false } = {}) {
  const headers = {};
  response.headers.forEach((value, name) => {
    if (name === 'set-cookie') return;
    headers[name] = value;
  });
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, response.statusText || undefined, headers);
  if (head || !response.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(response.body);
  await new Promise((resolve) => {
    body.on('error', (err) => { console.error('response stream failed', err); res.destroy(err); resolve(); });
    res.on('close', resolve);
    body.pipe(res);
  });
}

// Workers' ExecutionContext: background work keeps running after the response.
export function executionContext(pending) {
  return {
    waitUntil(promise) {
      const p = Promise.resolve(promise).catch((err) => console.error('waitUntil task failed', err && err.stack ? err.stack : err));
      pending.add(p);
      p.finally(() => pending.delete(p));
    },
    passThroughOnException() {},
  };
}
