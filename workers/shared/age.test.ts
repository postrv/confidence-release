import test from 'node:test';
import assert from 'node:assert/strict';
import { oldestAge } from './age';

test('oldest pending age never invents a timestamp for legacy or empty rows', () => {
  assert.deepEqual(oldestAge(undefined, 200_000), { ageSeconds: null, evidence: 'EMPTY' });
  assert.deepEqual(oldestAge(null, 200_000), { ageSeconds: null, evidence: 'LEGACY_UNKNOWN' });
  assert.deepEqual(oldestAge(75_000, 200_000), { ageSeconds: 125, evidence: 'RECORDED' });
  assert.deepEqual(oldestAge(200_500, 200_000), { ageSeconds: 0, evidence: 'RECORDED' });
  assert.deepEqual(oldestAge(201_001, 200_000), { ageSeconds: null, evidence: 'INVALID_TIMESTAMP' });
  assert.deepEqual(oldestAge(-1, 200_000), { ageSeconds: null, evidence: 'INVALID_TIMESTAMP' });
});
