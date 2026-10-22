// Date and time helpers, imported straight into Node (no server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDate, isTime } from '../worker/lib/time.js';

test('isDate accepts real calendar days only', () => {
  for (const d of ['2026-10-16', '2028-02-29', '2026-12-31']) assert.equal(isDate(d), true, d);
  for (const d of ['2027-02-31', '2027-02-29', '2026-13-01', '2026-04-31', '2026-1-1', '', null, 20261016]) assert.equal(isDate(d), false, String(d));
});

test('isTime accepts HH:MM', () => {
  assert.equal(isTime('14:00'), true);
  assert.equal(isTime('24:00'), false);
  assert.equal(isTime('9:00'), false);
});
