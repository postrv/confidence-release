// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorityCapacity, isNewAuthorityWork, requireAuthorityCapacity } from './capacity';
import { PlatformError } from '../shared/errors';

test('per-project capacity alerts and stops at inclusive independent row/SQLite byte boundaries', () => {
  for (const [records, bytes, status, alerts, stops] of [
    [9999, 50 * 1024 * 1024 - 1, 'NORMAL', [], []],
    [10000, 0, 'ALERT', ['records'], []], [0, 50 * 1024 * 1024, 'ALERT', ['sqliteBytes'], []],
    [19999, 100 * 1024 * 1024 - 1, 'ALERT', ['records', 'sqliteBytes'], []],
    [20000, 0, 'STOP', ['records'], ['records']], [0, 100 * 1024 * 1024, 'STOP', ['sqliteBytes'], ['sqliteBytes']],
    [20001, 100 * 1024 * 1024 + 1, 'STOP', ['records', 'sqliteBytes'], ['records', 'sqliteBytes']],
  ] as const) {
    const result = authorityCapacity(records, bytes); assert.equal(result.status, status); assert.deepEqual(result.alertDimensions, alerts); assert.deepEqual(result.stopDimensions, stops);
    assert.equal(result.newWorkAdmission, status === 'STOP' ? 'STOPPED' : 'OPEN'); assert.equal(result.scope, 'PER_PROJECT_AUTHORITY'); assert.equal(result.recoveryWritesMayExceedThreshold, true);
  }
});

test('new work including nested proposal/cohort paths and reopening is fenced; admitted effect recovery is allowed', () => {
  for (const operation of ['launch-cohort', 'create-attempt', 'start-execution', 'start-repair', 'request-repair', 'propose-selection', 'accept-proposal', 'submit-weft-revision', 'materialize', 'request-evaluation', 'prepare-review', 'approve-review', 'request-publication', 'create-goal', 'set-policy', 'increase-budget'])
    assert.equal(isNewAuthorityWork(operation, {}), true, operation);
  assert.equal(isNewAuthorityWork('set-admission-gate', { gate: 'OPEN' }), true);
  for (const operation of ['reconcile-publication', 'replay-projection', 'request-cleanup', 'cancel-attempt', 'revoke-grant', 'revoke-key', 'rotate-key', 'endorse-record', 'endorse-publication', 'submit-attempt', 'checkpoint-context', 'set-membership'])
    assert.equal(isNewAuthorityWork(operation, {}), false, operation);
  assert.equal(isNewAuthorityWork('set-admission-gate', { gate: 'CLOSED' }), false);
});

test('capacity refusal is transient503 and never queries storage for recovery work', () => {
  let reads = 0;
  const sql = { databaseSize: 100 * 1024 * 1024, exec: () => { reads++; return { one: () => ({ count: 0 }) }; } } as unknown as SqlStorage;
  requireAuthorityCapacity(sql, 'revoke-grant', {}); assert.equal(reads, 0);
  assert.throws(() => requireAuthorityCapacity(sql, 'create-attempt', {}), error => error instanceof PlatformError && error.code === 'AUTHORITY_CAPACITY_STOP' && error.status === 503);
  assert.equal(reads, 1);
  for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => authorityCapacity(value, 0), error => error instanceof PlatformError && error.code === 'AUTHORITY_CAPACITY_UNAVAILABLE' && error.status === 503);
});
