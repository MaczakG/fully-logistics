// Activity log: who did what and when. Shown in Beállítások > Napló and on detail pages.

import { run } from './db.js';

// ctx.user may be a staff user, ctx.apiPartner a partner calling the REST API, or neither (cron).
export function audit(ctx, { module, action, entity = '', entityId = '', summary = '', details = null }) {
  const actor = ctx.user ? ctx.user.name : ctx.apiPartner ? `API: ${ctx.apiPartner.name}` : 'Rendszer';
  return run(
    ctx.env.DB,
    `INSERT INTO audit_log (user_id, actor, module, action, entity, entity_id, summary, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.user ? ctx.user.id : null,
    actor,
    module,
    action,
    entity,
    String(entityId ?? ''),
    summary,
    details ? JSON.stringify(details) : null,
  );
}

// Log of calls to and from outside systems (webshops, couriers, invoicing, partner API).
export function integrationLog(env, { system, direction = 'out', partnerId = null, action, ok = true, status = null, message = '', refType = '', refId = null }) {
  return run(
    env.DB,
    `INSERT INTO integration_log (system, direction, partner_id, action, ok, status, message, ref_type, ref_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    system, direction, partnerId, action, ok ? 1 : 0, status, String(message).slice(0, 2000), refType, refId,
  );
}
