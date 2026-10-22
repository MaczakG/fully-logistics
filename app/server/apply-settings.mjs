// Changes settings on the server without a browser. The deploy agent's "settings" task runs this
// with the JSON it was given (node deploy/aws/task.mjs settings <file.json>). The changes go
// through the app's own API with a short lived session of an administrator, so they are checked
// and written to the activity log exactly as when someone saves them on the settings page.
//
//   node server/apply-settings.mjs payload.json
//
// payload, every part optional:
//   { "tariffs": { "values": { "order_base": 600, ... }, "storage": { "M": 780, ... } },
//     "costing": { "rent": 3300000, "racks": { "M": { "area": 1.1, ... } }, ... } }
//
// DB_PATH and the other settings come from the environment (server/config.mjs).

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { first } from '../worker/lib/db.js';
import { openApi } from './demo-seed.mjs';

// body: what is sent, from the current values and the payload. The tariffs endpoint keeps what it
// is not given; the costing endpoint saves the whole set, so the payload goes over the current one.
export const PARTS = {
  tariffs: {
    path: '/api/settings/tariffs', name: 'Alap tarifák',
    pick: (s) => ({ values: s.values, storage: s.storage }),
    body: (current, given) => given,
  },
  costing: {
    path: '/api/settings/costing', name: 'Költségkalkuláció',
    pick: ({ sizes, ...c }) => c,
    body: (current, given) => {
      const racks = { ...current.racks };
      for (const [code, r] of Object.entries((given && given.racks) || {})) racks[code] = { ...racks[code], ...r };
      return { ...current, ...given, racks };
    },
  },
};

// "a.b.c": value pairs of a nested object, for the before and after lines.
function flat(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, `${prefix}${k}.`, out);
    else out[`${prefix}${k}`] = v;
  }
  return out;
}

export async function applySettings({ worker, env, adminId, payload, log = console.log }) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const keys = Object.keys(p);
  const unknown = keys.filter((k) => !Object.prototype.hasOwnProperty.call(PARTS, k));
  if (unknown.length) throw new Error(`Ismeretlen beállítás: ${unknown.join(', ')}. Ezek adhatók meg: ${Object.keys(PARTS).join(', ')}.`);
  if (!keys.length) throw new Error('Üres a beállításcsomag.');
  const api = await openApi({ worker, env, userId: adminId });
  const changes = {};
  try {
    for (const k of keys) {
      const part = PARTS[k];
      const current = part.pick(await api.get(part.path));
      const before = flat(current);
      const after = flat(part.pick(await api.put(part.path, part.body(current, p[k]))));
      changes[k] = Object.keys(after).filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]))
        .map((f) => ({ field: f, before: before[f] ?? null, after: after[f] }));
      log(`${part.name}: ${changes[k].length ? `${changes[k].length} változás` : 'nem változott semmi'}`);
      for (const c of changes[k]) log(`  ${c.field}: ${c.before ?? 'nincs'} -> ${c.after}`);
    }
  } finally {
    await api.close();
  }
  return changes;
}

async function main() {
  const file = process.argv[2];
  if (!file || !existsSync(file)) throw new Error('Használat: node server/apply-settings.mjs <beállítások.json>');
  const payload = JSON.parse(readFileSync(file, 'utf8'));
  const { loadConfig, filesBucket } = await import('./config.mjs');
  const { D1Database } = await import('./d1.mjs');
  const { createAssets } = await import('./assets.mjs');
  const config = loadConfig();
  if (!existsSync(config.dbPath)) throw new Error(`Nem találom az adatbázist: ${config.dbPath}. Állítsd be a DB_PATH változót.`);
  const DB = new D1Database(config.dbPath);
  try {
    const env = { ...config.vars, DB, FILES: filesBucket(config), ASSETS: createAssets(config.assetsDir) };
    const worker = (await import(pathToFileURL(config.worker).href)).default;
    // The first active administrator who can use the API (one who still has to change the
    // initial password cannot).
    const admin = await first(DB,
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.is_admin = 1 AND u.active = 1 AND u.must_change_password = 0 ORDER BY u.id LIMIT 1`);
    if (!admin) {
      console.error('Nincs aktív adminisztrátor, aki használhatja az alkalmazást. Előbb lépj be adminisztrátorként, utána futtasd újra.');
      return 2;
    }
    await applySettings({ worker, env, adminId: admin.id, payload });
    return 0;
  } finally {
    DB.close();
  }
}

// realpath: the file may be started through a symlink (/opt/fully-app/current, see deploy/aws/agent.mjs tasks).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => { console.error(`Hiba: ${err.message}`); process.exitCode = 1; });
}
