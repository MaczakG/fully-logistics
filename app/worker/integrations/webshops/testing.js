// Scripted HTTP for tests: a fetch replacement that answers from a list of routes and records
// every request (method, url, headers, body), so tests can assert the exact calls an adapter makes.
// Used by the Node adapter tests directly and, inside the Worker, by runWithMockedHttp() in index.js
// (reached only through test/test-worker.js, never from a production route).
//
//   routes: [{ method, url (exact, with or without the query string), urlIncludes, bodyIncludes,
//              times (how often it may answer), status, headers, body (string or JSON), error }]
//   A request no route answers gets status 599 and is marked unmatched.

export function scriptedFetch(routes = []) {
  const requests = [];
  const used = routes.map(() => 0);
  const matches = (r, req) => {
    if (r.method && r.method.toUpperCase() !== req.method) return false;
    if (r.url && r.url !== req.url && r.url !== req.url.split('?')[0]) return false;
    if (r.urlIncludes && !req.url.includes(r.urlIncludes)) return false;
    if (r.bodyIncludes && !String(req.body || '').includes(r.bodyIncludes)) return false;
    return true;
  };
  async function fetch(url, init = {}) {
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
    const req = { method: (init.method || 'GET').toUpperCase(), url: String(url), headers, body: init.body == null ? null : String(init.body) };
    requests.push(req);
    const i = routes.findIndex((r, idx) => matches(r, req) && (r.times == null || used[idx] < r.times));
    if (i === -1) {
      req.unmatched = true;
      return new Response(JSON.stringify({ error: 'no mock route' }), { status: 599, headers: { 'content-type': 'application/json' } });
    }
    used[i]++;
    const r = routes[i];
    if (r.error) throw new TypeError(r.error);
    const status = r.status || 200;
    const body = [204, 304].includes(status) ? null : typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null);
    return new Response(body, { status, headers: r.headers || { 'content-type': typeof r.body === 'string' ? 'text/plain' : 'application/json' } });
  }
  return { fetch, requests };
}
