// Minimal router: "/api/orders/:id" style patterns, one handler per method and path.
//
// A handler receives ctx (see worker/index.js) and returns a Response, or any other value which is
// sent as JSON with status 200. Route options:
//   public: true        no session needed (login, setup, health)
//   perm: [module, action]  checked before the handler runs (403 otherwise)

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const source = pattern
      .replace(/\/$/, '')
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:(\w+)/g, (_, key) => {
        keys.push(key);
        return '([^/]+)';
      });
    this.routes.push({ method, regex: new RegExp(`^${source}/?$`), keys, handler, opts, pattern });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  // Returns { route, params } or { allowed: [methods] } when only the method is wrong, or null.
  match(method, path) {
    const allowed = [];
    for (const route of this.routes) {
      const m = path.match(route.regex);
      if (!m) continue;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) {
        allowed.push(route.method);
        continue;
      }
      const params = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route, params };
    }
    return allowed.length ? { allowed } : null;
  }
}
