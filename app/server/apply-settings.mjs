// Changes settings on the server without a browser. The deploy agent's "settings" task runs this
// with the JSON it was given (node deploy/aws/task.mjs settings <file.json>). The changes go
// through the app's own API with a short lived session of an administrator, so they are checked
// and written to the activity log exactly as when someone saves them on the settings page.
//
//   node server/apply-settings.mjs payload.json
//
// payload, every part optional:
//   { "tariffs": { "values": { "order_base": 600, ... }, "storage": { "M": 780, ... } },
//     "costing": { "rent": 3300000, "racks": { "M": { "area": 1.1, ... } }, ... },
//     "sizes": { "L": { "width_cm": 50, "depth_cm": 50, "height_cm": 60, "max_kg": 125 }, ... } }
// sizes: inner dimensions and maximum weight of existing location sizes, by code.
//
// DB_PATH and the other settings come from the environment (server/config.mjs).

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { first } from '../worker/lib/db.js';
import { openApi } from './demo-seed.mjs';

// run(api, given) saves one part and answers { before, after } (the part's values as they were and
// are). The tariffs endpoint keeps what it is not given; the costing endpoint saves the whole set,
// so the payload goes over the current one; sizes are saved one by one.
const SIZE_KEYS = ['width_cm', 'depth_cm', 'height_cm', 'max_kg'];
export const PARTS = {
  tariffs: {
    name: 'Alap tarifák',
    async run(api, given) {
      const pick = (s) => ({ values: s.values, storage: s.storage });
      const before = pick(await api.get('/api/settings/tariffs'));
      return { before, after: pick(await api.put('/api/settings/tariffs', given)) };
    },
  },
  costing: {
    name: 'Költségkalkuláció',
    async run(api, given) {
      const pick = ({ sizes, ...c }) => c;
      const before = pick(await api.get('/api/settings/costing'));
      const racks = { ...before.racks };
      for (const [code, r] of Object.entries((given && given.racks) || {})) racks[code] = { ...racks[code], ...r };
      return { before, after: pick(await api.put('/api/settings/costing', { ...before, ...given, racks })) };
    },
  },
  sizes: {
    name: 'Helyméretek',
    async run(api, given) {
      const list = (await api.get('/api/settings/sizes')).items;
      const entries = Object.entries(given && typeof given === 'object' ? given : {});
      const unknown = entries.map(([code]) => code).filter((code) => !list.some((z) => z.code === code));
      if (unknown.length) throw new Error(`Ismeretlen helyméret: ${unknown.join(', ')}.`);
      const before = {};
      const after = {};
      for (const [code, fields] of entries) {
        const z = list.find((x) => x.code === code);
        const body = Object.fromEntries(SIZE_KEYS.filter((k) => fields && k in fields).map((k) => [k, fields[k]]));
        before[code] = Object.fromEntries(SIZE_KEYS.map((k) => [k, z[k]]));
        const saved = await api.patch(`/api/settings/sizes/${z.id}`, body);
        after[code] = Object.fromEntries(SIZE_KEYS.map((k) => [k, saved[k]]));
      }
      return { before, after };
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
      const res = await part.run(api, p[k]);
      const before = flat(res.before);
      const after = flat(res.after);
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
