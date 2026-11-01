// Partner REST API keys: "flk_" + 43 random characters. Shown once when created; only the SHA-256
// hash is stored. The prefix (first 12 characters) is kept to tell keys apart in the list.

import { first, run } from './db.js';
import { sha256Hex } from './auth.js';
import { nowIso } from './time.js';

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function createApiKey(ctx, partnerId, name) {
  const key = `flk_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const res = await run(
    ctx.env.DB,
    'INSERT INTO api_keys (partner_id, name, prefix, key_hash, created_by) VALUES (?, ?, ?, ?, ?)',
    partnerId, name || '', key.slice(0, 12), await sha256Hex(key), ctx.user ? ctx.user.id : null,
  );
  return { id: res.meta.last_row_id, key, prefix: key.slice(0, 12) };
}

// Resolves "Authorization: Bearer flk_..." to the client partner, or null.
export async function partnerFromApiKey(env, req) {
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(flk_[A-Za-z0-9_-]{20,})$/);
  if (!m) return null;
  const row = await first(
    env.DB,
    `SELECT k.id AS key_id, k.last_used_at, p.id, p.name, p.code, p.status, p.type FROM api_keys k JOIN partners p ON p.id = k.partner_id
     WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
    await sha256Hex(m[1]),
  );
  if (!row || row.status !== 'active' || row.type !== 'client') return null;
  // Record usage at most every 5 minutes.
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 5 * 60 * 1000) {
    await run(env.DB, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', nowIso(), row.key_id);
  }
  return { id: row.id, name: row.name, code: row.code, keyId: row.key_id };
}
