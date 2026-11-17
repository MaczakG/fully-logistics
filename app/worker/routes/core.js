// Session, first-run setup, profile, metadata and the shared lookups every screen uses.

import { all, first, getSetting, run } from '../lib/db.js';
import { badRequest, conflict, forbidden, json } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import {
  checkLogin, clearCookie, createSession, destroySession, hashPassword, passwordProblem, safeEqual, userCount, verifyPassword,
} from '../lib/auth.js';
import { ACTIONS, MODULES, can, permissionMap } from '../lib/perm.js';
import {
  CARRIERS, LOCATION_KINDS, MOVEMENT_TYPES, PARTNER_TYPES, STATUSES, TARIFFS, WEBSHOP_PLATFORMS,
} from '../lib/constants.js';
import { audit } from '../lib/audit.js';
import { sendDocument } from '../lib/files.js';
import { budapestDate, nowIso } from '../lib/time.js';

async function me(ctx) {
  const company = await getSetting(ctx.env.DB, 'company', {});
  const warehouse = await getSetting(ctx.env.DB, 'warehouse', {});
  const u = ctx.user;
  return {
    user: {
      id: u.id, email: u.email, name: u.name, phone: u.phone,
      role: { id: u.role_id, key: u.role_key, name: u.role_name, is_admin: u.is_admin },
      must_change_password: u.must_change_password,
    },
    permissions: permissionMap(u),
    company: { name: company.name || 'Fully Logistics' },
    warehouse: { cutoff: warehouse.cutoff || '14:00', open: warehouse.open || '', close: warehouse.close || '' },
  };
}

export function register(r) {
  r.get('/api/health', () => ({ ok: true }), { public: true });

  // ---------------------------------------------------------------- first run
  r.get('/api/setup', async (ctx) => ({
    needsSetup: (await userCount(ctx.env)) === 0,
    tokenConfigured: !!ctx.env.SETUP_TOKEN,
  }), { public: true });

  // Creates the first administrator. Needs the SETUP_TOKEN secret, so nobody who finds the fresh
  // deployment before you can claim it.
  r.post('/api/setup', async (ctx) => {
    if ((await userCount(ctx.env)) > 0) throw conflict('A rendszer már be van állítva.');
    if (!ctx.env.SETUP_TOKEN) throw conflict('Hiányzik a SETUP_TOKEN titok a Worker beállításaiból.');
    const body = await ctx.body();
    const data = validate(body, {
      token: { type: 'str', required: true, max: 200 },
      name: { type: 'str', required: true, max: 120 },
      email: { type: 'email', required: true },
      password: { type: 'str', required: true, max: 200 },
    });
    if (!safeEqual(data.token, ctx.env.SETUP_TOKEN)) throw forbidden('Hibás telepítési kód.');
    const problem = passwordProblem(body.password);
    if (problem) throw badRequest(problem, { password: problem });
    const res = await run(ctx.env.DB,
      'INSERT INTO users (email, name, role_id, password_hash) VALUES (?, ?, (SELECT id FROM roles WHERE key = ?), ?)',
      data.email, data.name, 'admin', await hashPassword(body.password));
    const cookie = await createSession(ctx.env, ctx.req, res.meta.last_row_id);
    ctx.user = { id: res.meta.last_row_id, name: data.name };
    await audit(ctx, { module: 'users', action: 'create', entity: 'user', entityId: res.meta.last_row_id, summary: 'Első adminisztrátor létrehozva' });
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }, { public: true });

  // ---------------------------------------------------------------- session
  r.post('/api/auth/login', async (ctx) => {
    const body = await ctx.body();
    let user;
    try {
      user = await checkLogin(ctx.env, body.email, body.password);
    } catch (e) {
      throw badRequest(e.message);
    }
    const cookie = await createSession(ctx.env, ctx.req, user.id);
    ctx.user = { id: user.id, name: user.name };
    await audit(ctx, { module: 'users', action: 'login', entity: 'user', entityId: user.id, summary: 'Bejelentkezés' });
    return json({ ok: true, must_change_password: !!user.must_change_password }, 200, { 'set-cookie': cookie });
  }, { public: true });

  r.post('/api/auth/logout', async (ctx) => {
    await destroySession(ctx.env, ctx.req);
    return json({ ok: true }, 200, { 'set-cookie': clearCookie(ctx.req) });
  }, { public: true });

  // ---------------------------------------------------------------- profile
  r.get('/api/me', me);

  r.patch('/api/me', async (ctx) => {
    const data = validate(await ctx.body(), {
      name: { type: 'str', required: true, max: 120 },
      phone: { type: 'str', max: 40 },
    }, { partial: true });
    if (!Object.keys(data).length) return me(ctx);
    const keys = Object.keys(data);
    await run(ctx.env.DB, `UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      ...keys.map((k) => data[k]), nowIso(), ctx.user.id);
    Object.assign(ctx.user, data);
    return me(ctx);
  });

  r.post('/api/me/password', async (ctx) => {
    const body = await ctx.body();
    const row = await first(ctx.env.DB, 'SELECT password_hash FROM users WHERE id = ?', ctx.user.id);
    if (!(await verifyPassword(String(body.current || ''), row.password_hash))) {
      throw badRequest('A jelenlegi jelszó nem megfelelő.', { current: 'Nem megfelelő jelszó.' });
    }
    const problem = passwordProblem(body.next);
    if (problem) throw badRequest(problem, { next: problem });
    await run(ctx.env.DB, 'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?',
      await hashPassword(body.next), nowIso(), ctx.user.id);
    // Sign out every other session of this user.
    await run(ctx.env.DB, 'DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', ctx.user.id, ctx.user.session_hash);
    await audit(ctx, { module: 'users', action: 'edit', entity: 'user', entityId: ctx.user.id, summary: 'Saját jelszó módosítva' });
    return { ok: true };
  });

  // ---------------------------------------------------------------- metadata
  // Work waiting in each module, for the tiles of the phone (PDA) home screen. Only the modules
  // the user may open; a module without a count is left out.
  r.get('/api/home', async (ctx) => {
    const db = ctx.env.DB;
    const today = budapestDate();
    const queries = {
      inbound: () => first(db, `SELECT COUNT(*) AS open, COALESCE(SUM(status IN ('arrived', 'receiving')), 0) AS active
        FROM inbounds WHERE status IN ('expected', 'arrived', 'receiving')`),
      orders: () => first(db, `SELECT COALESCE(SUM(status = 'new'), 0) AS new, COALESCE(SUM(status = 'hold'), 0) AS hold
        FROM orders WHERE status IN ('new', 'hold')`),
      picking: () => first(db, `SELECT COALESCE(SUM(status IN ('open', 'picking')), 0) AS active, COALESCE(SUM(status = 'picked'), 0) AS picked
        FROM waves WHERE status IN ('open', 'picking', 'picked')`),
      counts: () => first(db, "SELECT COUNT(*) AS open FROM counts WHERE status IN ('open', 'counting')"),
      transport: () => first(db, "SELECT COUNT(*) AS today FROM carrier_pickups WHERE status IN ('planned', 'arrived') AND date <= ?", today),
    };
    const keys = Object.keys(queries).filter((m) => can(ctx.user, m, 'view'));
    const rows = await Promise.all(keys.map((m) => queries[m]()));
    return { counts: Object.fromEntries(keys.map((m, i) => [m, rows[i]])) };
  });

  r.get('/api/meta', async (ctx) => ({
    modules: MODULES,
    actions: ACTIONS,
    statuses: STATUSES,
    partnerTypes: PARTNER_TYPES,
    carriers: CARRIERS,
    webshopPlatforms: WEBSHOP_PLATFORMS,
    movementTypes: MOVEMENT_TYPES,
    locationKinds: LOCATION_KINDS,
    tariffs: TARIFFS,
    sizes: await all(ctx.env.DB, 'SELECT id, code, name, width_cm, depth_cm, height_cm, max_kg FROM location_sizes WHERE active = 1 ORDER BY sort, code'),
  }));

  // ---------------------------------------------------------------- lookups for pickers
  // Short lists for selects and autocompletes. Names and codes only, available to every user.
  r.get('/api/lookup/partners', async (ctx) => {
    const type = ctx.query.get('type');
    const rows = await all(ctx.env.DB,
      `SELECT id, type, code, name, status, carrier_code FROM partners
       WHERE (? IS NULL OR type = ?) AND (? = '1' OR status = 'active') ORDER BY name`,
      type, type, ctx.query.get('all') || '0');
    return { items: rows };
  });

  r.get('/api/lookup/products', async (ctx) => {
    const q = `%${(ctx.query.get('q') || '').trim()}%`;
    const partnerId = ctx.query.get('partner_id') ? Number(ctx.query.get('partner_id')) : null;
    const rows = await all(ctx.env.DB,
      `SELECT p.id, p.partner_id, p.sku, p.name, p.ean, p.unit, pa.code AS partner_code
       FROM products p JOIN partners pa ON pa.id = p.partner_id
       WHERE p.active = 1 AND (? IS NULL OR p.partner_id = ?) AND (p.sku LIKE ? OR p.name LIKE ? OR p.ean LIKE ?)
       ORDER BY p.sku LIMIT 30`,
      partnerId, partnerId, q, q, q);
    return { items: rows };
  });

  r.get('/api/lookup/locations', async (ctx) => {
    const q = `${(ctx.query.get('q') || '').trim()}%`;
    const rows = await all(ctx.env.DB,
      `SELECT l.id, l.code, l.zone, l.kind, l.size_id, s.code AS size_code, l.partner_id
       FROM locations l JOIN location_sizes s ON s.id = l.size_id
       WHERE l.active = 1 AND l.code LIKE ? ORDER BY l.pick_sequence, l.code LIMIT 30`, q);
    return { items: rows };
  });

  r.get('/api/lookup/users', async (ctx) => ({
    items: await all(ctx.env.DB, 'SELECT id, name FROM users WHERE active = 1 ORDER BY name'),
  }));

  // ---------------------------------------------------------------- documents
  r.get('/api/documents/:id', (ctx) => sendDocument(ctx, Number(ctx.params.id), { inline: ctx.query.get('inline') === '1' }));
}
