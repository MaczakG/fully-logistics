// Test entry point: the real Worker plus two endpoints that only exist in tests
// (wrangler dev test/test-worker.js, see helpers.mjs). Never deployed: wrangler.jsonc points at
// worker/index.js.
//
//   POST /api/__test/sql   { sql }               runs raw SQL (fixtures)
//   POST /api/__test/call  { fn, args, as }      calls a library function directly, e.g.
//                      { fn: 'stock.addStock', args: [{ ... }], as: 1 }   ("as": user id for ctx.user)
//   The first argument of functions that take ctx is filled in automatically.

import app from '../worker/index.js';
import * as stock from '../worker/lib/stock.js';
import * as orders from '../worker/lib/orders.js';
import * as orderCreate from '../worker/lib/order-create.js';
import * as inboundCreate from '../worker/lib/inbound-create.js';
import * as accounts from '../worker/lib/accounts.js';
import * as crypto from '../worker/lib/crypto.js';
import * as snapshot from '../worker/jobs/snapshot.js';
import * as couriers from '../worker/integrations/couriers/index.js';
import * as webshops from '../worker/integrations/webshops/index.js';
import * as invoicing from '../worker/integrations/invoicing/index.js';
import { scheduled } from '../worker/cron.js';

// Splits SQL text into statements at semicolons outside quotes and comments.
function splitSql(text) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const LIBS = { stock, orders, orderCreate, inboundCreate, accounts, crypto, snapshot, couriers, webshops, invoicing, cron: { scheduled } };
// Functions whose first parameter is env rather than ctx.
const TAKES_ENV = /^(accounts|crypto|snapshot|webshops)\.|^(couriers\.(isConfigured|testConnection)|invoicing\.testConnection|cron\.scheduled)$/;
// Functions whose first parameter is the D1 database.
const TAKES_DB = /^stock\.(availability|allocate|suggestLocation|location|locationByCode|occupant|assertCanStore)$/;

export default {
  async fetch(req, env, exec) {
    const url = new URL(req.url);
    if (url.pathname === '/api/__test/sql') {
      const { sql } = await req.json();
      try {
        const statements = splitSql(sql);
        await env.DB.batch(statements.map((q) => env.DB.prepare(q)));
        return Response.json({ ok: true, count: statements.length });
      } catch (e) {
        return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 });
      }
    }
    if (url.pathname === '/api/__test/query') {
      const { sql, args = [] } = await req.json();
      const { results } = await env.DB.prepare(sql).bind(...args).all();
      return Response.json({ results });
    }
    if (url.pathname === '/api/__test/call') {
      const { fn, args = [], as = null } = await req.json();
      const [ns, name] = fn.split('.');
      const f = LIBS[ns] && LIBS[ns][name];
      if (typeof f !== 'function') return Response.json({ ok: false, error: `unknown function ${fn}` }, { status: 404 });
      let user = null;
      if (as) {
        const u = await env.DB.prepare('SELECT u.id, u.name, r.is_admin FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?').bind(as).first();
        user = u ? { id: u.id, name: u.name, is_admin: !!u.is_admin, permissions: new Set() } : null;
      }
      const ctx = { env, user, apiPartner: null, waitUntil: (p) => exec.waitUntil(p), req, url };
      try {
        const out = TAKES_DB.test(fn) ? await f(env.DB, ...args) : TAKES_ENV.test(fn) ? await f(env, ...args) : await f(ctx, ...args);
        return Response.json({ ok: true, result: out ?? null });
      } catch (e) {
        return Response.json({ ok: false, status: e.status || 500, error: String(e.message || e), fields: e.fields || null });
      }
    }
    return app.fetch(req, env, exec);
  },
  scheduled: app.scheduled,
};
