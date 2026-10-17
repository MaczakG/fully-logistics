# Developing the WMS app

The app is written as one Cloudflare Worker: `worker/` is the API, `public/` is the single page app (built into `dist/` by `build.mjs`), `migrations/` is the D1 schema. No framework and no runtime dependencies; `wrangler` is the only dev dependency.

It runs in two runtimes from the same code:
- **Node.js** (production on AWS Lightsail, see `deploy/aws/README.md`): `server/` provides the bindings. `env.DB` is D1's API on a SQLite file (`node:sqlite`), `env.FILES` is R2's API on the Lightsail bucket (S3, own SigV4) or a folder, `env.ASSETS` serves `dist/` with `_headers`, and a minute timer runs the cron schedules. Start: `npm start` (settings in `server/config.mjs`).
- **Cloudflare Workers** (`wrangler dev` / `wrangler deploy`), with D1, R2 and the assets binding.

Stick to what both have: Web APIs (fetch, Request, Response, crypto.subtle, streams), the D1 calls `prepare/bind/all/first/run/raw/batch`, and the R2 calls `put/get/head/delete/list`.

```bash
cd app
npm install
cp .dev.vars.example .dev.vars
npm run dev          # build, apply migrations to the local D1, wrangler dev on http://localhost:8787
npm test             # every test/*.test.mjs on the Node runtime, each file with its own empty database
npm run test:workers # the same on wrangler dev (Workers runtime), slower
node build.mjs       # build + lint (icons exist, no em or en dashes anywhere)
```

On first open the app asks for the setup token (`SETUP_TOKEN` in `.dev.vars`) and creates the first administrator.

## Layout

```
worker/index.js            entry: /api/v1 (partner API, API key), /api (session), static assets
worker/routes/<module>.js  one file per module, export function register(router)
worker/api/v1.js           partner REST API
worker/lib/                shared: http, router, db, validate, time, auth, perm, audit, crypto, csv, files,
                           stock, orders, constants, apikeys
worker/integrations/       couriers/, webshops/, invoicing/ (contracts documented in each index.js)
worker/jobs/snapshot.js    daily storage snapshot (storage billing)
worker/cron.js             scheduled jobs
migrations/                D1 migrations, applied in file name order
public/assets/js/core/     util.js, api.js, ui.js, app.js (shell and router)
public/assets/js/views/    one file per module, FL.view('<module>', { render })
public/assets/css/app.css  design system; css/views/<module>.css for view specific styles
test/                      node:test files, test/helpers.mjs starts a server
```

## Modules and permissions

Twelve modules, each guarded by the permission matrix (`worker/lib/perm.js`, the single source of truth): `inbound` Betárolás, `orders` Megrendelések, `picking` Komissió, `counts` Leltár, `stock` Készlet (with Cikktörzs), `history` Rendeléstörténet, `transport` Fuvarszervezés, `partners` Partnerek, `quotes` Ajánlatkészítő, `billing` Elszámolás, `settings` Beállítások, `users` Felhasználók.

Actions: `view`, `create`, `edit`, `delete`, `approve`. What each action means for a module is written in `MODULES` and shown in the matrix. Check on the server with `{ perm: [module, action] }` on the route or `need(ctx, module, action)` inside the handler; mirror it in the UI with `FL.can(module, action)` (hide or disable, never rely on the UI alone).

## Backend conventions

```js
// worker/routes/example.js
import { all, first, run, nextNumber } from '../lib/db.js';
import { notFound } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { audit } from '../lib/audit.js';

export function register(r) {
  r.get('/api/example', async (ctx) => {
    const status = ctx.query.get('status');
    return { items: await all(ctx.env.DB, 'SELECT * FROM things WHERE (? IS NULL OR status = ?) ORDER BY id DESC', status, status) };
  }, { perm: ['orders', 'view'] });

  r.post('/api/example', async (ctx) => {
    const data = validate(await ctx.body(), { name: { type: 'str', required: true, max: 200 } });
    const number = await nextNumber(ctx.env.DB, 'EX');
    const res = await run(ctx.env.DB, 'INSERT INTO things (number, name) VALUES (?, ?)', number, data.name);
    await audit(ctx, { module: 'orders', action: 'create', entity: 'thing', entityId: res.meta.last_row_id, summary: `${number} létrehozva` });
    return { id: res.meta.last_row_id, number };
  }, { perm: ['orders', 'create'] });
}
```

- Handlers return a plain object (sent as JSON) or a `Response`. Throw `badRequest`, `notFound`, `conflict`, `forbidden` from `lib/http.js`; messages are Hungarian and shown to the user as they are. `badRequest(message, { field: 'üzenet' })` marks form fields.
- Validate every body with `validate()` / `validateList()`. Never build SQL from user input; always bind.
- Lists answer `{ items, total }` and take `?limit=&offset=` (`page()` in `lib/http.js`). Detail endpoints answer the object itself.
- Running numbers: `nextNumber(db, prefix)` gives `PREFIX-2026-00001`. Prefixes in use: `BT` betárolás, `R` rendelés, `H` komissiós hullám, `LT` leltár, `FA` futárátvétel, `FU` fuvar, `VR` visszáru, `EL` elszámolás, `AJ` ajánlat.
- Every create, change, delete and approval writes `audit()`.
- Stock changes only through `lib/stock.js` (`addStock`, `removeStock`, `transferStock`, `setStockQty`). They keep stock non negative, write the movement ledger, and enforce one partner per location. Never `UPDATE stock` directly.
- Order status changes only through `setOrderStatus()` in `lib/orders.js`, which enforces the lifecycle and writes the timeline.
- New orders only through `createOrder()` (`lib/order-create.js`) and new inbounds only through `createInbound()` (`lib/inbound-create.js`), whatever the source (form, CSV, webshop, API). They validate, resolve SKUs within the partner, de-duplicate imports and write the audit log.
- Courier and invoicing accounts only through `lib/accounts.js` (encrypted credentials, merge on save).
- Dates: calendar dates are Budapest dates (`budapestDate()`), timestamps ISO UTC (`nowIso()`).
- Outside systems: log every call with `integrationLog()`. Credentials are stored encrypted (`encryptJson`) and never returned to the browser (`maskCredentials` for display).
- CSV import endpoints accept multipart `file` plus `preview=1|0`. With preview they answer `{ rows, valid, errors: [{ line, message }], sample }` and change nothing; without, they import the valid rows and answer `{ imported, errors }`. `FL.ui.csvImport` drives this flow. Exports use `toCsv()` (semicolon, BOM, Excel friendly).
- Schema changes go in a new migration file. Never edit `0001_init.sql` or `0002_defaults.sql` once deployed.

## Frontend conventions

```js
// public/assets/js/views/example.js
(() => {
  const { html, ui, api, fmt } = FL;
  FL.view('orders', {
    async render(root, ctx) {          // ctx.params: path parts after the route, ctx.query: URLSearchParams
      const { items } = await api.get('/api/example');
      root.innerHTML = String(html`
        ${ui.pageHead({ title: 'Példa', lead: 'Rövid magyarázat.', actions: FL.can('orders', 'create') ? html`<button class="btn btn--primary" data-action="new">${FL.icon('plus')}Új</button>` : '' })}
        ${ui.table({ columns: [{ key: 'number', label: 'Szám', cls: 'num' }, { key: 'name', label: 'Név' }], rows: items, rowHref: (r) => `#/megrendelesek/${r.id}` })}`);
      ui.enableRowLinks(root);
      ui.bind(root, {
        new: () => ui.dialog({ title: 'Új tétel', body: ui.field({ name: 'name', label: 'Név', required: true }),
          onSubmit: async (form) => { await api.post('/api/example', ui.formValues(form)); ui.toast('Mentve.', 'ok'); FL.reload(); } }),
      });
    },
  });
})();
```

- Always build markup with `FL.html` (escapes values). `FL.raw()` only for markup you built.
- Use the UI kit (`FL.ui.*`) and the classes in `app.css`: `.btn`, `.btn--primary` (one per screen, the main action), `.panel`, `.kpis`, `.table`, `.chip` via `FL.status(kind, key)`, `.tabs`, `.form-grid`, `.field`, `.notice`, `.scan`. View specific CSS goes in `css/views/<module>.css` and uses the same tokens.
- Routes are Hungarian slugs: `#/betarolas`, `#/megrendelesek`, `#/komissio`, `#/leltar`, `#/keszlet`, `#/rendelestortenet`, `#/fuvarszervezes`, `#/partnerek`, `#/ajanlatkeszito`, `#/elszamolas`, `#/beallitasok`, `#/felhasznalok` (`FL.routes[module]`). Sub pages: `#/partnerek/12/tarifak`. Filters in the query: `#/megrendelesek?status=new`.
- Hide or disable what the user may not do (`FL.can`, `ui.denyAttr(module, action)`).
- Text: Hungarian, informal (tegező) like the rest of the app, short and specific. No em or en dashes (`build.mjs` fails on them): use commas, colons, "és", "között". Numbers and money through `FL.fmt`.
- Every screen must work at 360 px wide, in light and dark theme, with keyboard only. Warehouse screens (receiving, picking, counting) must work with a hand scanner: `FL.ui.scan` + `FL.ui.bindScan`.
- Up to 640 px the app is a hand terminal (PDA): `#/` is a home screen of big module tiles (`renderHome` in `core/app.js`, counts from `GET /api/home`), the top bar has Back (the page's `.crumb`, else one level up) and Home instead of the side menu, and the "PDA" section of `app.css` sets the touch sizes. `FL.pda()` tells whether it is on. `ui.table` rows become cards there: the first column (or the one with `cardTitle: true`) is the title, the others are "label: value" lines; pass `cards: false` for a grid that must stay a table. A `form.toolbar[data-filters]` with three or more fields shows only its search field and a Filters button. Next to the scan field: camera reading (`FL.ui.cameraScan`, where `BarcodeDetector` exists) and an on-screen keyboard switch for devices with a built-in scanner.

## Tests

`test/<module>.test.mjs` with `node:test`. The server runs `test/test-worker.js`, the real Worker plus test-only endpoints.

```js
const srv = await startServer();            // fresh local D1 and R2
const admin = await srv.admin();            // first-run setup, signed-in administrator client
const fx = await srv.seedBasics();          // shared fixture: partners, locations, products, stock (ids in FIXTURE)
const op = await srv.userWithRole('warehouse_operator');   // signed-in client with a limited role
await admin.post('/api/orders', { ... });   // { status, data }
await srv.sql('UPDATE ...');                // raw SQL
const rows = await srv.query('SELECT ...', arg);
await srv.call('stock.addStock', [{ ... }], { as: 1 });   // call a library function directly
```

Test the happy path, the permission checks (a user with a limited role gets 403) and the important refusals (not enough stock, wrong status). Run one file with `node build.mjs && node --test test/<file>.test.mjs`.
