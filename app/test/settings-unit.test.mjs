// Pure helpers of Beállítások and Felhasználók, imported straight into Node (no server): the
// generic courier and invoicing form validation (with adapter style field definitions, since the
// adapters may still be stubs), location code patterns, company formats, Budapest day bounds,
// permission normalisation and temporary passwords.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budapestDayStartIso, cleanFields, deriveZone, diff, missingRequired, normalizeCompany, patternCodes } from '../worker/routes/settings.js';
import { normalizePermissions, permissionObject, temporaryPassword } from '../worker/routes/users.js';
import { passwordProblem } from '../worker/lib/auth.js';

const DEFS = {
  credentialFields: [
    { key: 'username', label: 'Felhasználónév', type: 'text', required: true },
    { key: 'password', label: 'Jelszó', type: 'password', required: true },
    { key: 'sandbox', label: 'Teszt rendszer', type: 'checkbox' },
  ],
  settingFields: [
    { key: 'client_number', label: 'Ügyfélszám', type: 'number', required: true },
    { key: 'label_format', label: 'Címke', type: 'select', options: [{ value: 'A4', label: 'A4' }, { value: 'A6', label: 'A6' }], required: true },
    { key: 'service', label: 'Szolgáltatás', type: 'select', options: ['24H', 'SAT'] },
    { key: 'sender_name', label: 'Feladó', type: 'text' },
  ],
};

test('cleanFields: types, unknown keys dropped, credentials keep or clear', () => {
  const errors = {};
  const s = cleanFields(DEFS.settingFields, { client_number: '12 345'.replace(' ', ''), label_format: 'A6', service: 'SAT', sender_name: '  Fully  ', extra: 'x' }, 'settings', errors);
  assert.deepEqual(s, { client_number: 12345, label_format: 'A6', service: 'SAT', sender_name: 'Fully' });
  assert.deepEqual(errors, {});

  const bad = {};
  cleanFields(DEFS.settingFields, { client_number: 'abc', label_format: 'A3', service: 'X' }, 'settings', bad);
  assert.deepEqual(Object.keys(bad).sort(), ['settings.client_number', 'settings.label_format', 'settings.service']);

  const c = cleanFields(DEFS.credentialFields, { username: '', password: ' p a ss ', sandbox: '1' }, 'credentials');
  assert.deepEqual(c, { password: ' p a ss ', sandbox: true }, 'empty keeps the stored value, passwords are not trimmed');
  assert.deepEqual(cleanFields(DEFS.credentialFields, { username: null }, 'credentials'), { username: null }, 'null clears');
  const notObject = {};
  cleanFields(DEFS.credentialFields, 'x', 'credentials', notObject);
  assert.ok(notObject.credentials);
  assert.deepEqual(cleanFields(DEFS.credentialFields, undefined, 'credentials'), {});
});

test('missingRequired: merges stored and incoming values', () => {
  assert.deepEqual(missingRequired(DEFS.credentialFields, {}, {}, 'credentials'), { 'credentials.username': 'Kötelező mező.', 'credentials.password': 'Kötelező mező.' });
  assert.deepEqual(missingRequired(DEFS.credentialFields, { username: 'u', password: 'p' }, {}, 'credentials'), {});
  assert.deepEqual(Object.keys(missingRequired(DEFS.credentialFields, { username: 'u', password: 'p' }, { password: null }, 'credentials')), ['credentials.password']);
  assert.deepEqual(Object.keys(missingRequired(DEFS.settingFields, { client_number: 1 }, { label_format: '' }, 'settings')), ['settings.label_format']);
});

test('patternCodes: letter ranges, lists, padding, positions', () => {
  const base = { separator: '-', pad: 2, rack_from: 1, rack_to: 2, level_from: 1, level_to: 1 };
  assert.deepEqual(patternCodes({ ...base, prefixes: 'A-C' }).codes.map((c) => c.code), ['A-01-01', 'A-02-01', 'B-01-01', 'B-02-01', 'C-01-01', 'C-02-01']);
  assert.deepEqual(patternCodes({ ...base, prefixes: 'hv, k' }).codes.map((c) => c.code), ['HV-01-01', 'HV-02-01', 'K-01-01', 'K-02-01']);
  assert.deepEqual(patternCodes({ ...base, prefixes: 'A', rack_from: 3, rack_to: 2, pad: 3 }).codes.map((c) => c.code), ['A-002-001', 'A-003-001'], 'reversed range');
  assert.deepEqual(patternCodes({ ...base, prefixes: 'P', rack_to: 1, pos_from: 1, pos_to: 2, separator: '' }).codes.map((c) => c.code), ['P010101', 'P010102']);
  assert.equal(patternCodes({ ...base, prefixes: 'A' }).codes[0].zone, 'A');
  const big = patternCodes({ ...base, prefixes: 'A-Z', rack_to: 100, level_to: 10 });
  assert.equal(big.total, 26000);
  assert.equal(big.codes.length, 0, 'too many: nothing generated');
});

test('deriveZone and company formats', () => {
  assert.equal(deriveZone('A-01-03'), 'A');
  assert.equal(deriveZone('RAMPA-BE'), 'RAMPA');
  assert.equal(deriveZone('12.04'), '12');
  const c = { tax_number: '12345678 2 13', eu_vat_number: 'hu 12345678', bank_account: 'hu42 1177 3005 1234 5678 0000 0000', website: 'http://fully.hu', country: '' };
  assert.deepEqual(normalizeCompany(c), {});
  assert.equal(c.tax_number, '12345678-2-13');
  assert.equal(c.eu_vat_number, 'HU12345678');
  assert.equal(c.bank_account, 'HU42 1177 3005 1234 5678 0000 0000');
  assert.equal(c.website, 'http://fully.hu');
  assert.equal(c.country, 'HU');
  const bad = normalizeCompany({ tax_number: '1234', company_reg_number: 'abc', bank_account: '123', website: 'nem web', country: 'Magyar' });
  assert.deepEqual(Object.keys(bad).sort(), ['bank_account', 'company_reg_number', 'country', 'tax_number', 'website']);
});

test('budapestDayStartIso across daylight saving time', () => {
  assert.equal(budapestDayStartIso('2026-01-15'), '2026-01-14T23:00:00.000Z');
  assert.equal(budapestDayStartIso('2026-07-01'), '2026-06-30T22:00:00.000Z');
  assert.equal(budapestDayStartIso('2026-03-29'), '2026-03-28T23:00:00.000Z', 'DST starts at 02:00 that day');
  assert.equal(budapestDayStartIso('2026-10-25'), '2026-10-24T22:00:00.000Z', 'DST ends at 03:00 that day');
});

test('diff lists only changed keys', () => {
  assert.deepEqual(diff({ a: 1, b: [1], c: null }, { a: 1, b: [2], c: undefined, d: 'x' }), { b: [[1], [2]], d: [null, 'x'] });
});

test('permissions: valid keys only, any action implies view, matrix order', () => {
  assert.deepEqual(normalizePermissions({ picking: ['approve', 'edit'], inbound: ['create'] }),
    ['inbound:view', 'inbound:create', 'picking:view', 'picking:edit', 'picking:approve']);
  assert.throws(() => normalizePermissions({ quotes: ['approve'] }), /Érvénytelen jogosultság: quotes:approve/);
  assert.throws(() => normalizePermissions({ settings: 'view' }), /Érvénytelen/);
  assert.throws(() => normalizePermissions(null), /modulonként/);
  assert.deepEqual(normalizePermissions({}), []);
  const obj = permissionObject(['users:edit', 'users:view', 'orders:view']);
  assert.deepEqual(obj.users, ['view', 'edit']);
  assert.deepEqual(obj.billing, []);
  assert.equal(Object.keys(obj).length, 12);
});

test('temporary passwords are strong enough and unambiguous', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const p = temporaryPassword();
    assert.match(p, /^[a-km-zA-HJ-NP-Z2-9]{4}-[a-km-zA-HJ-NP-Z2-9]{4}-[a-km-zA-HJ-NP-Z2-9]{4}$/);
    assert.equal(passwordProblem(p), null);
    seen.add(p);
  }
  assert.equal(seen.size, 200);
});
