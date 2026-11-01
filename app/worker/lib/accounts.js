// Stored accounts of outside services. Secrets are encrypted (lib/crypto.js) and only ever
// decrypted here, inside the Worker.
//
//   Couriers: one courier_accounts row per carrier code (gls, dpd, foxpost, mpl, dhl).
//   Invoicing: settings "invoicing" = { provider, szamlazz: {...settings}, billingo: {...settings} }
//              settings "invoicing_credentials" = encrypted { szamlazz: {...}, billingo: {...} }
//
// Saving merges credentials: a field sent as undefined or '' keeps the stored value, so forms can
// show masked values and only send what the user retyped. Send null to clear a field.

import { first, getSetting, parseJson, run, setSetting } from './db.js';
import { decryptJson, encryptJson } from './crypto.js';
import { nowIso } from './time.js';

const merge = (stored, incoming) => {
  const out = { ...(stored || {}) };
  for (const [k, v] of Object.entries(incoming || {})) {
    if (v === null) delete out[k];
    else if (v !== undefined && v !== '') out[k] = v;
  }
  return out;
};

// -> { carrier_code, carrier_id, active, settings, credentials, last_error } or null
export async function getCourierAccount(env, code) {
  const row = await first(env.DB, 'SELECT * FROM courier_accounts WHERE carrier_code = ?', code);
  if (!row) return null;
  return {
    carrier_code: row.carrier_code,
    carrier_id: row.carrier_id,
    active: !!row.active,
    settings: parseJson(row.settings, {}),
    credentials: row.credentials ? await decryptJson(env, row.credentials) : {},
    last_error: row.last_error,
    updated_at: row.updated_at,
  };
}

export async function saveCourierAccount(env, code, { credentials, settings, active, carrierId } = {}) {
  const current = await getCourierAccount(env, code);
  const creds = merge(current ? current.credentials : {}, credentials);
  const sets = { ...(current ? current.settings : {}), ...(settings || {}) };
  await run(env.DB,
    `INSERT INTO courier_accounts (carrier_code, carrier_id, credentials, settings, active, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (carrier_code) DO UPDATE SET carrier_id = excluded.carrier_id, credentials = excluded.credentials,
       settings = excluded.settings, active = excluded.active, updated_at = excluded.updated_at`,
    code,
    carrierId !== undefined ? carrierId : current ? current.carrier_id : null,
    await encryptJson(env, creds),
    JSON.stringify(sets),
    active !== undefined ? (active ? 1 : 0) : current ? (current.active ? 1 : 0) : 0,
    nowIso());
}

// Throws the stored secret away without reading it: the way out when it can no longer be decrypted
// (for example after ENCRYPTION_KEY changed). Settings stay; the account is switched off.
export const clearCourierCredentials = (env, code) =>
  run(env.DB, "UPDATE courier_accounts SET credentials = '', active = 0, updated_at = ? WHERE carrier_code = ?", nowIso(), code);

export const setCourierError = (env, code, message) =>
  run(env.DB, 'UPDATE courier_accounts SET last_error = ? WHERE carrier_code = ?', String(message || '').slice(0, 1000), code);

// -> { provider, settings: { szamlazz: {...}, billingo: {...} }, credentials: { szamlazz: {...}, billingo: {...} } }
export async function getInvoicingConfig(env) {
  const conf = await getSetting(env.DB, 'invoicing', { provider: '' });
  const encrypted = await getSetting(env.DB, 'invoicing_credentials', '');
  const credentials = encrypted ? await decryptJson(env, encrypted) : {};
  const { provider = '', ...settings } = conf || {};
  return { provider, settings, credentials };
}

// Same for invoicing: every provider's credentials are one encrypted value, so all of them go.
export const clearInvoicingCredentials = (env) => setSetting(env.DB, 'invoicing_credentials', '');

// provider: '' | 'szamlazz' | 'billingo' ; settings and credentials keyed by provider code.
export async function saveInvoicingConfig(env, { provider, settings = {}, credentials = {} }) {
  const current = await getInvoicingConfig(env);
  const nextSettings = { ...current.settings };
  for (const [code, s] of Object.entries(settings)) nextSettings[code] = { ...(nextSettings[code] || {}), ...s };
  const nextCreds = { ...current.credentials };
  for (const [code, c] of Object.entries(credentials)) nextCreds[code] = merge(nextCreds[code], c);
  await setSetting(env.DB, 'invoicing', { provider: provider !== undefined ? provider : current.provider, ...nextSettings });
  await setSetting(env.DB, 'invoicing_credentials', await encryptJson(env, nextCreds));
}
