// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { runOverlappingReadWrite, validOverlapStoreTrace, type ProbeResponse, type ReadBarrierControl } from './overlap';

test('controlled overlap trace accepts bounded replacement reads and rejects extra writes, stale retries and mismatched accounting', () => {
  const prefix = [{ method: 'GET', value: 1 }, { method: 'PUT', value: 2 }];
  for (const laterReads of [0, 1, 2, 126]) {
    const state = { value: 2, reads: 1 + laterReads, accesses: [...prefix, ...Array.from({ length: laterReads }, () => ({ method: 'GET', value: 2 }))] };
    assert.equal(validOverlapStoreTrace(state, 1, 2), true);
    assert.equal(validOverlapStoreTrace({ ...state, reads: state.reads + 1 }, 1, 2), false);
  }
  for (const accesses of [[], prefix.slice(0, 1), [...prefix, { method: 'PUT', value: 2 }], [...prefix, { method: 'GET', value: 1 }],
    [...prefix, ...Array.from({ length: 127 }, () => ({ method: 'GET', value: 2 }))]]) {
    assert.equal(validOverlapStoreTrace({ value: 2, reads: accesses.length - 1, accesses }, 1, 2), false);
  }
  assert.equal(validOverlapStoreTrace({ value: 3, reads: 1, accesses: prefix }, 1, 2), false);
});

test('uncertain arm and a stopped continuation immediately after arm both close the private fixture without candidate I/O', async () => {
  for (const failure of ['arm', 'continuation']) {
    let closed = 0, requests = 0;
    const fixture: ReadBarrierControl = {
      async armReadBarrier() { if (failure === 'arm') throw new Error('ARM_ACK_LOST'); },
      async waitForReadCapture() { throw new Error('UNEXPECTED_CAPTURE_WAIT'); },
      async releaseReadBarrier() { throw new Error('UNEXPECTED_RELEASE'); },
      async close() { closed++; },
    };
    await assert.rejects(runOverlappingReadWrite({ fixture, initial: 1, replacement: 2, deadline: Date.now() + 5000, observations: [],
      read: async () => { requests++; throw new Error('UNEXPECTED_READ'); }, write: async () => { requests++; throw new Error('UNEXPECTED_WRITE'); },
      continuation: async () => { throw new Error('GENERATION_STOPPED'); } }), failure === 'arm' ? /ARM_ACK_LOST/ : /GENERATION_STOPPED/);
    assert.equal(closed, 1); assert.equal(requests, 0);
  }
});

test('wrong capture or failed candidate write closes and drains the outstanding read without release or a fresh read', async () => {
  for (const failure of ['capture', 'write']) {
    let closed = 0, reads = 0, writes = 0, resolved = false;
    let rejectRead!: (error: Error) => void;
    const pending = new Promise<ProbeResponse>((_resolve, reject) => { rejectRead = reject; });
    const fixture: ReadBarrierControl = {
      async armReadBarrier() {},
      async waitForReadCapture() { return { capturedValue: failure === 'capture' ? 99 : 1, reads: 1 }; },
      async releaseReadBarrier() { throw new Error('UNEXPECTED_RELEASE'); },
      async close() { closed++; resolved = true; rejectRead(new Error('HELD_READ_FENCED')); },
    };
    await assert.rejects(runOverlappingReadWrite({ fixture, initial: 1, replacement: 2, deadline: Date.now() + 5000, observations: [],
      read: async () => { reads++; return pending; }, write: async () => { writes++; throw new Error('WRITE_TRANSPORT_FAILED'); },
      continuation: async () => {} }), failure === 'capture' ? /FIXTURE_BARRIER_CAPTURE_MISMATCH/ : /WRITE_TRANSPORT_FAILED/);
    assert.equal(closed, 1); assert.equal(resolved, true); assert.equal(reads, 1); assert.equal(writes, failure === 'write' ? 1 : 0);
  }
});
