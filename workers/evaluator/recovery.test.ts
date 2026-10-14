import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformError } from '../shared/errors';
import { emitRecoveryOccurrence, foldRecoveryEvent, MAX_RECOVERY_EVENTS, recoveryCode, type RecoveryEvent } from './recovery';

test('retries coalesce against the fixed job identity and keep a bounded recent journal', () => {
  const jobKey = 'a'.repeat(64);
  let events: RecoveryEvent[] = [];
  for (let count = 1; count <= 100; count++) {
    const next = foldRecoveryEvent(events, { eventId: crypto.randomUUID(), component: 'scheduler', operation: 'status', jobKey, code: 'EVALUATION_STATUS_DEADLINE' }, count);
    events = next.events;
    assert.equal(next.current.occurrences, count);
    assert.equal(next.current.firstAt, 1);
    assert.equal(next.current.lastAt, count);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0]?.jobKey, jobKey);
  assert.equal(recoveryCode(new PlatformError('EVALUATION_STATUS_DEADLINE')), 'EVALUATION_STATUS_DEADLINE');
  assert.equal(recoveryCode(new Error('secret-bearing reason')), 'UNCLASSIFIED_ERROR');
  assert.equal(recoveryCode(new PlatformError('SECRET_CANARY')), 'UNCLASSIFIED_ERROR');
  assert.equal(recoveryCode(new PlatformError('OBJECT_STORE_DEADLINE_EXCEEDED')), 'OBJECT_STORE_DEADLINE_EXCEEDED');
  assert.equal(recoveryCode(new PlatformError('CALLBACK_NOT_ACKNOWLEDGED')), 'CALLBACK_NOT_ACKNOWLEDGED');
  assert.equal(recoveryCode(new Error('The container has not been started')), 'CONTAINER_NOT_STARTED');
  assert.equal(recoveryCode(new Error('The container has not been started PRIVATE_CANARY')), 'UNCLASSIFIED_ERROR');
  assert.deepEqual([1, 2, 3, 4, 8, 9, 16].filter(emitRecoveryOccurrence), [1, 2, 4, 8, 16]);
  for (let i = 0; i < MAX_RECOVERY_EVENTS + 20; i++) {
    events = foldRecoveryEvent(events, { eventId: String(i), component: 'generation', operation: `phase-${i}`, jobKey, code: 'UNCLASSIFIED_ERROR' }, 101 + i).events;
  }
  assert.equal(events.length, MAX_RECOVERY_EVENTS);
  assert.equal(events[0]?.operation, 'phase-20');
  assert.equal(events.at(-1)?.operation, `phase-${MAX_RECOVERY_EVENTS + 19}`);
});
