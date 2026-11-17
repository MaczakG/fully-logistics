// Fully Logistics WMS Worker (app.fully.hu).
//
//   /api/v1/*   partner REST API, authenticated with an API key (Authorization: Bearer flk_...)
//   /api/*      the admin app's own API, authenticated with the session cookie
//   anything else: the single page app from dist/ (static assets binding)
//
// Every /api handler gets a ctx object:
//   ctx.req, ctx.env (DB, FILES, ASSETS, secrets), ctx.url, ctx.query (URLSearchParams),
//   ctx.params (route parameters), ctx.user (session user or null), ctx.apiPartner (API partner),
//   ctx.body() (parsed JSON body, cached), ctx.waitUntil(promise)

import { Router } from './lib/router.js';
import { HttpError, errorResponse, forbidden, json, notFound, readJson, unauthorized } from './lib/http.js';
import { loadSession } from './lib/auth.js';
import { need } from './lib/perm.js';
import { partnerFromApiKey } from './lib/apikeys.js';
import { registerAll } from './routes/index.js';
import { registerApi } from './api/v1.js';
import { scheduled } from './cron.js';

const app = registerAll(new Router());
const partnerApi = registerApi(new Router());

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function makeCtx(req, env, exec, url) {
  let bodyPromise;
  return {
    req,
    env,
    url,
    query: url.searchParams,
    params: {},
    user: null,
    apiPartner: null,
    waitUntil: (p) => exec.waitUntil(p),
    body: () => (bodyPromise ||= readJson(req)),
  };
}

async function run(router, ctx, method, path) {
  const hit = router.match(method, path);
  if (!hit) throw notFound('Ismeretlen API végpont.');
  if (hit.allowed) throw new HttpError(405, 'Ez a metódus itt nem használható.', 'method_not_allowed');
  ctx.params = hit.params;
  const { opts, handler } = hit.route;
  if (opts.perm) need(ctx, opts.perm[0], opts.perm[1]);
  const out = await handler(ctx);
  return out instanceof Response ? out : json(out ?? { ok: true });
}

async function handleApi(req, env, exec, url) {
  const ctx = makeCtx(req, env, exec, url);
  const method = req.method;
  try {
    if (url.pathname.startsWith('/api/v1/')) {
      // Every partner API route needs a key, except the public documentation.
      const hit = partnerApi.match(method, url.pathname);
      if (!(hit && hit.route && hit.route.opts.public)) {
        ctx.apiPartner = await partnerFromApiKey(env, req);
        if (!ctx.apiPartner) throw unauthorized('Hiányzó vagy érvénytelen API kulcs.');
      }
      return await run(partnerApi, ctx, method, url.pathname);
    }

    // CSRF: state-changing requests must come from our own pages. Cross-site forms cannot set
    // custom headers, and the session cookie is SameSite=Strict on top of this.
    if (!SAFE_METHODS.has(method)) {
      const origin = req.headers.get('origin');
      if (req.headers.get('x-requested-with') !== 'fl-app' || (origin && origin !== url.origin)) {
        throw forbidden('A kérés nem az alkalmazásból érkezett.');
      }
    }

    const hit = app.match(method, url.pathname);
    if (!(hit && hit.route && hit.route.opts.public)) {
      ctx.user = await loadSession(env, req);
      if (!ctx.user) throw unauthorized();
      // A user who must change the password can only do that (and read who they are).
      if (ctx.user.must_change_password && !['/api/me', '/api/me/password', '/api/auth/logout', '/api/meta'].includes(url.pathname)) {
        throw new HttpError(403, 'Először változtasd meg a jelszavad.', 'password_change_required');
      }
    }
    return await run(app, ctx, method, url.pathname);
  } catch (err) {
    return errorResponse(err);
  }
}

export default {
  async fetch(req, env, exec) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return handleApi(req, env, exec, url);
    return env.ASSETS.fetch(req);
  },
  scheduled(event, env, exec) {
    exec.waitUntil(scheduled(event, env));
  },
};
