// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PINNED_WEFT_DEPENDENCY } from '../../packages/protocol/src/dependencies';
import { pinnedWeftDependency, WEFT_DEPENDENCY_KEY } from './pinned-dependency';

test('dependency metadata is a fixed identity behind authorization, with no backend token or locator', async () => {
  const bucket = { get: () => { throw Error('must not read'); } } as unknown as R2Bucket;
  let checks = 0;
  const response = await pinnedWeftDependency(bucket, false, () => { checks++; });
  assert.deepEqual(await response.json(), PINNED_WEFT_DEPENDENCY); assert.equal(checks, 1);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  await assert.rejects(pinnedWeftDependency(bucket, false, () => { throw Error('revoked'); }), /revoked/);
});

test('missing, incomplete and tampered dependency bodies are refused', async () => {
  const make = (value: unknown) => ({ get: async (key: string) => { assert.equal(key, WEFT_DEPENDENCY_KEY); return value; } }) as unknown as R2Bucket;
  await assert.rejects(pinnedWeftDependency(make(null), true, () => {}), /DEPENDENCY_UNAVAILABLE/);
  await assert.rejects(pinnedWeftDependency(make({ size: 1 }), true, () => {}), /DEPENDENCY_UNAVAILABLE/);
  for (const length of [1, PINNED_WEFT_DEPENDENCY.bundle.bytes]) {
    const body = new Response(new Uint8Array(length)).body;
    await assert.rejects(pinnedWeftDependency(make({ size: PINNED_WEFT_DEPENDENCY.bundle.bytes, body }), true, () => {}), /DEPENDENCY_INTEGRITY_FAILED/);
  }
});

test('revocation during object read prevents returning previously authorized bytes and disposes the body', async () => {
  let active = true, cancelled = 0;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }, { highWaterMark: 0 });
  const bucket = { get: async () => { active = false; return { size: PINNED_WEFT_DEPENDENCY.bundle.bytes, body }; } } as unknown as R2Bucket;
  await assert.rejects(pinnedWeftDependency(bucket, true, () => { if (!active) throw Error('revoked'); }), /revoked/);
  assert.equal(cancelled, 1);
});


test('dependency deadline disposes a late R2 body before any read or authorization continuation', { timeout: 5000 }, async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let release!: (value: unknown) => void, started!: () => void, cancelled = 0, reads = 0, authorizations = 0;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const bucket = { get: () => new Promise(resolve => { release = resolve; started(); }) } as unknown as R2Bucket;
  const operation = pinnedWeftDependency(bucket, true, () => { authorizations++; });
  const rejected = assert.rejects(operation, { code: 'DEPENDENCY_READ_TIMEOUT', status: 503 });
  await entered; context.mock.timers.tick(15_000); await rejected;
  release({ size: PINNED_WEFT_DEPENDENCY.bundle.bytes, body: new ReadableStream<Uint8Array>({
    pull() { reads++; }, cancel() { cancelled++; },
  }, { highWaterMark: 0 }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1); assert.equal(reads, 0); assert.equal(authorizations, 1);
});

test('dependency body timeout cancels the reader without awaiting stalled cancellation', { timeout: 5000 }, async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let started!: () => void, cancelled = 0;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const body = new ReadableStream<Uint8Array>({
    pull() { started(); }, cancel() { cancelled++; return new Promise<void>(() => {}); },
  }, { highWaterMark: 0 });
  const bucket = { get: async () => ({ size: PINNED_WEFT_DEPENDENCY.bundle.bytes, body }) } as unknown as R2Bucket;
  const rejected = assert.rejects(pinnedWeftDependency(bucket, true, () => {}), { code: 'DEPENDENCY_READ_TIMEOUT', status: 503 });
  await entered; context.mock.timers.tick(15_000); await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1);
});
