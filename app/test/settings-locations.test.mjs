// Beállítások > Raktárhelyek: list with occupancy, create, bulk create from a pattern, bulk size
// change, edit rules (occupied locations), delete and deactivate rules, CSV import and export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

let srv;
let admin;
let fx;
before(async () => {
  srv = await startServer();
  admin = await srv.admin();
  fx = await srv.seedBasics();
});
after(async () => { await srv.stop(); });

const csvForm = (text, preview) => {
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/csv' }), 'helyek.csv');
  form.append('preview', preview ? '1' : '0');
  return form;
};
const idOf = async (code) => (await srv.query('SELECT id FROM locations WHERE code = ?', code))[0].id;

test('list: occupancy from stock, filters, summary, ids for select all', async () => {
  const r = await admin.get('/api/settings/locations?limit=500');
  assert.equal(r.status, 200);
  assert.equal(r.data.total, 25);
  assert.deepEqual(r.data.zones, ['A', 'B', 'C', 'P', 'Q', 'R', 'V']);
  const b1 = r.data.items.find((l) => l.code === 'B-01-01');
  assert.equal(b1.occupant_code, 'KUTYA');
  assert.equal(b1.qty, 40);
  assert.equal(b1.size_code, 'L');
  assert.equal(r.data.summary.occupied, 7);

  const occupied = await admin.get('/api/settings/locations?occupied=1');
  assert.equal(occupied.data.total, 7);
  const emptyA = await admin.get('/api/settings/locations?occupied=0&zone=A');
  assert.equal(emptyA.data.total, 5);
  const konyha = await admin.get(`/api/settings/locations?partner_id=${fx.clients.konyha}`);
  assert.deepEqual(konyha.data.items.map((l) => l.code), ['A-01-02', 'A-01-03', 'C-01-03']);
  const pal = await admin.get('/api/settings/locations?size_id=4&kind=storage');
  assert.equal(pal.data.total, 4);
  const q = await admin.get('/api/settings/locations?q=rampa');
  assert.equal(q.data.items[0].kind, 'receiving');
  const paged = await admin.get('/api/settings/locations?limit=10&offset=20');
  assert.equal(paged.data.items.length, 5);
  const ids = await admin.get('/api/settings/locations?zone=A&ids_only=1');
  assert.equal(ids.data.ids.length, 8);

  const one = await admin.get(`/api/settings/locations/${b1.id}`);
  assert.equal(one.data.stock.length, 1);
  assert.equal(one.data.stock[0].sku, 'KB-1001');
  assert.equal(one.data.deletable, false);
});

test('create one: code rules, zone derived, duplicates refused', async () => {
  const ok = await admin.post('/api/settings/locations', { code: ' d-01-01 ', size_id: 2, pick_sequence: 5, note: 'Új sor' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.code, 'D-01-01');
  assert.equal(ok.data.zone, 'D');
  assert.equal(ok.data.kind, 'storage');
  const dup = await admin.post('/api/settings/locations', { code: 'D-01-01', size_id: 2 });
  assert.equal(dup.status, 409);
  assert.ok(dup.data.error.fields.code);
  const bad = await admin.post('/api/settings/locations', { code: 'Á 01', size_id: 2 });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.error.fields.code);
  const noSize = await admin.post('/api/settings/locations', { code: 'D-01-02', size_id: 99 });
  assert.equal(noSize.status, 400);
  const wrongPartner = await admin.post('/api/settings/locations', { code: 'D-01-02', size_id: 1, partner_id: fx.carriers.gls });
  assert.equal(wrongPartner.status, 400);
  assert.ok(wrongPartner.data.error.fields.partner_id);
  const fixed = await admin.post('/api/settings/locations', { code: 'D-01-02', size_id: 1, partner_id: fx.clients.kutya, kind: 'storage' });
  assert.equal(fixed.data.partner_code, 'KUTYA');
});

test('bulk create: preview, skip existing, conflicts, limit', async () => {
  const pattern = { prefixes: 'E-F', separator: '-', pad: 2, rack_from: 1, rack_to: 3, level_from: 1, level_to: 4, size_id: 1 };
  const preview = await admin.post('/api/settings/locations/bulk', { ...pattern, preview: true });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.total, 24);
  assert.equal(preview.data.create, 24);
  assert.equal(preview.data.codes[0], 'E-01-01');
  assert.equal(preview.data.codes[23], 'F-03-04');
  assert.equal((await srv.query("SELECT COUNT(*) AS n FROM locations WHERE zone IN ('E', 'F')"))[0].n, 0, 'preview changes nothing');

  await admin.post('/api/settings/locations', { code: 'E-01-02', size_id: 3 });
  const created = await admin.post('/api/settings/locations/bulk', { ...pattern, pick_start: 100, kind: 'storage' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.created, 23);
  assert.deepEqual(created.data.skipped, ['E-01-02']);
  const [e11] = await srv.query("SELECT zone, size_id, pick_sequence FROM locations WHERE code = 'E-01-01'");
  assert.deepEqual(e11, { zone: 'E', size_id: 1, pick_sequence: 100 });
  assert.equal((await srv.query("SELECT size_id FROM locations WHERE code = 'E-01-02'"))[0].size_id, 3, 'existing one untouched');

  const withPos = await admin.post('/api/settings/locations/bulk', { prefixes: 'G', separator: '.', pad: 1, rack_from: 1, rack_to: 1, level_from: 1, level_to: 2, pos_from: 1, pos_to: 2, size_id: 4, preview: true });
  assert.deepEqual(withPos.data.codes, ['G.1.1.1', 'G.1.1.2', 'G.1.2.1', 'G.1.2.2']);
  const clash = await admin.post('/api/settings/locations/bulk', { prefixes: 'H', separator: '', pad: 1, rack_from: 1, rack_to: 11, level_from: 1, level_to: 11, size_id: 1, preview: true });
  assert.equal(clash.status, 400);
  assert.match(clash.data.error.message, /ütköző kódokat/);
  const tooMany = await admin.post('/api/settings/locations/bulk', { prefixes: 'A-Z', pad: 3, rack_from: 1, rack_to: 100, level_from: 1, level_to: 10, size_id: 1, preview: true });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.data.error.message, /legfeljebb 2000/);
  const halfPos = await admin.post('/api/settings/locations/bulk', { ...pattern, pos_from: 1, preview: true });
  assert.equal(halfPos.status, 400);
  const nothing = await admin.post('/api/settings/locations/bulk', pattern);
  assert.equal(nothing.status, 409);
});

test('bulk change: many sizes at once, partner and deactivation rules', async () => {
  const { data } = await admin.get('/api/settings/locations?zone=A&ids_only=1');
  const r = await admin.post('/api/settings/locations/bulk-update', { ids: data.ids, size_id: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.updated, 8);
  assert.equal(r.data.occupiedResized, 3);
  assert.equal((await srv.query("SELECT COUNT(*) AS n FROM locations WHERE zone = 'A' AND size_id = 2"))[0].n, 8);
  const audit = (await srv.query("SELECT summary FROM audit_log WHERE entity = 'location' ORDER BY id DESC LIMIT 1"))[0];
  assert.match(audit.summary, /8 raktárhely módosítva \(méret: L\)/);

  // Fixed partner: locations holding another partner's goods are skipped.
  const fixed = await admin.post('/api/settings/locations/bulk-update', { ids: data.ids, partner_id: fx.clients.kutya });
  assert.equal(fixed.data.updated, 6);
  assert.deepEqual(fixed.data.skipped.map((s) => s.code), ['A-01-02', 'A-01-03']);
  const clear = await admin.post('/api/settings/locations/bulk-update', { ids: data.ids, partner_id: null });
  assert.equal(clear.data.updated, 8);

  const off = await admin.post('/api/settings/locations/bulk-update', { ids: data.ids, active: false });
  assert.equal(off.data.updated, 5, 'only empty locations are deactivated');
  assert.equal(off.data.skipped.length, 3);
  await admin.post('/api/settings/locations/bulk-update', { ids: data.ids, active: true });
  await admin.post('/api/settings/locations/bulk-update', { ids: data.ids, size_id: 1 });

  assert.equal((await admin.post('/api/settings/locations/bulk-update', { ids: [] , size_id: 1 })).status, 400);
  assert.equal((await admin.post('/api/settings/locations/bulk-update', { ids: data.ids })).status, 400);
  const inactiveSize = await admin.patch('/api/settings/sizes/3', { active: false });
  assert.equal(inactiveSize.status, 200);
  assert.equal((await admin.post('/api/settings/locations/bulk-update', { ids: data.ids, size_id: 3 })).status, 400);
  await admin.patch('/api/settings/sizes/3', { active: true });
});

test('edit one: occupied size change warns, other partner and deactivation refused', async () => {
  const id = await idOf('B-01-01'); // Kutyabarát goods
  const resize = await admin.patch(`/api/settings/locations/${id}`, { size_id: 3 });
  assert.equal(resize.status, 200);
  assert.match(resize.data.warning, /tárolási díj/);
  assert.equal(resize.data.size_code, 'XL');
  const other = await admin.patch(`/api/settings/locations/${id}`, { partner_id: fx.clients.konyha });
  assert.equal(other.status, 409);
  const same = await admin.patch(`/api/settings/locations/${id}`, { partner_id: fx.clients.kutya, pick_sequence: 7, note: 'Nehéz zsákok' });
  assert.equal(same.status, 200);
  assert.equal(same.data.partner_code, 'KUTYA');
  const deact = await admin.patch(`/api/settings/locations/${id}`, { active: false });
  assert.equal(deact.status, 409);
  assert.match(deact.data.error.message, /Csak üres raktárhely/);
  const dup = await admin.patch(`/api/settings/locations/${id}`, { code: 'B-01-02' });
  assert.equal(dup.status, 409);
  const noop = await admin.patch(`/api/settings/locations/${id}`, { note: 'Nehéz zsákok' });
  assert.equal(noop.data.warning, '');
  await admin.patch(`/api/settings/locations/${id}`, { size_id: 2, partner_id: null });

  const empty = await idOf('B-01-05');
  const off = await admin.patch(`/api/settings/locations/${empty}`, { active: false });
  assert.equal(off.status, 200);
  assert.equal(off.data.active, 0);
  assert.equal((await srv.query('SELECT action FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT 1', 'location', String(empty)))[0].action, 'delete');
  await admin.patch(`/api/settings/locations/${empty}`, { active: true });
});

test('delete: only empty locations without history', async () => {
  const occupiedId = await idOf('A-01-01');
  assert.equal((await admin.del(`/api/settings/locations/${occupiedId}`)).status, 409);
  // Had stock once: the ledger keeps it, so only deactivation is possible.
  await srv.call('stock.addStock', [{ productId: fx.products.alom, locationId: await idOf('B-01-06'), qty: 1, type: 'inbound' }], { as: 1 });
  await srv.call('stock.removeStock', [{ productId: fx.products.alom, locationId: await idOf('B-01-06'), qty: 1, type: 'pick' }], { as: 1 });
  const used = await admin.del(`/api/settings/locations/${await idOf('B-01-06')}`);
  assert.equal(used.status, 409);
  assert.match(used.data.error.message, /Inaktiváld helyette/);
  const fresh = await admin.post('/api/settings/locations', { code: 'TORLES-1', size_id: 1 });
  assert.equal((await admin.del(`/api/settings/locations/${fresh.data.id}`)).status, 200);
  assert.equal((await admin.del(`/api/settings/locations/${fresh.data.id}`)).status, 404);

  const { data } = await admin.get('/api/settings/locations?zone=F&ids_only=1');
  const bulk = await admin.post('/api/settings/locations/bulk-delete', { ids: [...data.ids, await idOf('B-01-06')] });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.data.deleted, 12);
  assert.deepEqual(bulk.data.skipped.map((s) => s.code), ['B-01-06']);
});

test('CSV export, then import: create, update, errors, preview changes nothing', async () => {
  const exp = await admin.get('/api/settings/locations/export?zone=P', { raw: true });
  assert.equal(exp.status, 200);
  const bytes = new Uint8Array(await exp.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel');
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /^Kód;Zóna;Méret;Típus;Fix partner;Komissiós sorrend;Aktív;Megjegyzés;Foglalja;Készlet \(db\)/);
  assert.match(text, /P-01-01;P;PAL;Tárolóhely;;\d+;igen;;;0/);

  const csv = [
    'Kód;Méret;Típus;Fix partner;Aktív;Megjegyzés',
    'P-01-01;L;;KONYHA;;átméretezve',        // update: size and fixed partner
    'J-01-01;M;tárolóhely;;igen;',            // new
    'j-01-02;PAL;Karantén (zárolt);;;',        // new, lower case code
    'J-01-03;NINCS;;;;',                      // unknown size
    'J-01-04;;;;;',                           // new without size
    'J-01-01;M;;;;',                          // duplicate in file
    'A-01-01;M;;;nem;',                        // deactivate an occupied location
    'B-01-01;M;;KONYHA;;',                    // other partner's goods
    'K 1;M;;;;',                              // bad code
  ].join('\r\n');
  const pre = await admin.post('/api/settings/locations/import', csvForm(csv, true));
  assert.equal(pre.status, 200, JSON.stringify(pre.data));
  assert.equal(pre.data.rows, 9);
  assert.equal(pre.data.valid, 3);
  assert.equal(pre.data.created, 2);
  assert.equal(pre.data.updated, 1);
  assert.deepEqual(pre.data.errors.map((e) => e.line), [5, 6, 7, 8, 9, 10]);
  assert.equal((await srv.query("SELECT COUNT(*) AS n FROM locations WHERE code LIKE 'J-%'"))[0].n, 0);

  const done = await admin.post('/api/settings/locations/import', csvForm(csv, false));
  assert.equal(done.status, 200);
  assert.equal(done.data.imported, 3);
  const rows = await srv.query("SELECT code, zone, size_id, kind, partner_id, note FROM locations WHERE code IN ('P-01-01', 'J-01-01', 'J-01-02') ORDER BY code");
  assert.deepEqual(rows, [
    { code: 'J-01-01', zone: 'J', size_id: 1, kind: 'storage', partner_id: null, note: '' },
    { code: 'J-01-02', zone: 'J', size_id: 4, kind: 'quarantine', partner_id: null, note: '' },
    { code: 'P-01-01', zone: 'P', size_id: 2, kind: 'storage', partner_id: fx.clients.konyha, note: 'átméretezve' },
  ]);

  // Re-importing the export changes nothing.
  const again = await admin.post('/api/settings/locations/import', csvForm(text, true));
  assert.equal(again.data.errors.length, 0);
  assert.equal(again.data.updated, 1, 'P-01-01 was changed above, the old export resets it');
  assert.equal(again.data.unchanged, 3);

  const noCode = await admin.post('/api/settings/locations/import', csvForm('Méret\r\nM', true));
  assert.equal(noCode.status, 400);
});

test('permissions: create without edit cannot update by import, deactivation needs delete', async () => {
  // A custom role: settings view and create only.
  const role = await admin.post('/api/roles', { name: 'Raktárhely rögzítő' });
  await admin.put(`/api/roles/${role.data.id}/permissions`, { permissions: { settings: ['view', 'create'] } });
  await srv.sql(`UPDATE roles SET key = 'loc_creator' WHERE id = ${role.data.id}`);
  const c = await srv.userWithRole('loc_creator');
  assert.equal((await c.post('/api/settings/locations', { code: 'L-01-01', size_id: 1 })).status, 200);
  assert.equal((await c.patch(`/api/settings/locations/${await idOf('L-01-01')}`, { note: 'x' })).status, 403);
  assert.equal((await c.post('/api/settings/locations/bulk-update', { ids: [await idOf('L-01-01')], size_id: 2 })).status, 403);
  assert.equal((await c.del(`/api/settings/locations/${await idOf('L-01-01')}`)).status, 403);
  assert.equal((await c.post('/api/settings/locations/bulk-delete', { ids: [await idOf('L-01-01')] })).status, 403);
  const pre = await c.post('/api/settings/locations/import', csvForm('Kód;Méret\r\nL-01-01;L\r\nL-01-02;M', true));
  assert.equal(pre.data.created, 1);
  assert.match(pre.data.errors[0].message, /nincs jogosultságod/);

  const editor = await srv.userWithRole('warehouse_manager');
  await srv.sql(`INSERT INTO role_permissions (role_id, module, action) VALUES (2, 'settings', 'edit')`);
  const id = await idOf('L-01-01');
  assert.equal((await editor.patch(`/api/settings/locations/${id}`, { note: 'ok' })).status, 200);
  const deact = await editor.patch(`/api/settings/locations/${id}`, { active: false });
  assert.equal(deact.status, 403);
  assert.match(deact.data.error.message, /törlése/);
  assert.equal((await editor.post('/api/settings/locations/bulk-update', { ids: [id], active: false })).status, 403);
  await srv.sql(`DELETE FROM role_permissions WHERE role_id = 2 AND module = 'settings' AND action = 'edit'`);
});
