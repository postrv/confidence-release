import test from 'node:test';
import assert from 'node:assert/strict';
import { ObjectStore } from '../shared/objects';
import { digestBytes } from '../shared/errors';

const bytes = new TextEncoder().encode('owned immutable object');
const deadline = { code: 'OBJECT_STORE_DEADLINE_EXCEEDED', status: 503 };
const bucket = (methods: object) => methods as R2Bucket;
const tick = () => new Promise(resolve => setTimeout(resolve, 1));
const object = (value: Uint8Array) => ({ size: value.length, body: new Blob([value.slice().buffer]).stream() });

test('R2 head deadline prevents later write dispatch after a delayed absence result', { timeout: 5000 }, async context => {
  // The digest precedes head. Hold the clock until head has entered so a busy
  // test runner cannot expire the operation before this fixture exists.
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let complete!: (value: null) => void, enteredHead!: () => void, writes = 0;
  const headStarted = new Promise<void>(resolve => { enteredHead = resolve; });
  const store = new ObjectStore(bucket({ head: () => new Promise(resolve => { complete = resolve; enteredHead(); }), put: async () => { writes++; } }), 20);
  const operation = store.put(bytes), rejected = assert.rejects(operation, deadline);
  await Promise.race([headStarted, operation]);
  context.mock.timers.tick(20); await rejected;
  complete(null); await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 0);
});

test('R2 get cancels a body arriving after the caller deadline', async () => {
  let complete!: (value: unknown) => void, cancelled = 0;
  const store = new ObjectStore(bucket({ get: () => new Promise(resolve => { complete = resolve; }) }), 20);
  await assert.rejects(store.get(await digestBytes(bytes)), deadline);
  complete({ size: bytes.length, body: new ReadableStream({ cancel() { cancelled++; } }) });
  await tick(); assert.equal(cancelled, 1);
});

test('R2 body deadline does not wait for a stalled cancellation', async () => {
  let cancelled = 0;
  const store = new ObjectStore(bucket({ get: async () => ({ size: bytes.length, body: new ReadableStream({ cancel() { cancelled++; return new Promise<void>(() => {}); } }) }) }), 20);
  await assert.rejects(store.get(await digestBytes(bytes)), deadline);
  assert.equal(cancelled, 1);
});

test('R2 read rejection cancels oversized bodies and still verifies content digests', async () => {
  let cancelled = 0;
  const oversized = new ObjectStore(bucket({ get: async () => ({ size: 100, body: new ReadableStream({ cancel() { cancelled++; } }) }) }));
  await assert.rejects(oversized.get(await digestBytes(bytes), 20), { code: 'SIZE_LIMIT', status: 413 });
  assert.equal(cancelled, 1);
  const corrupt = new ObjectStore(bucket({ get: async () => object(new TextEncoder().encode('wrong bytes')) }));
  await assert.rejects(corrupt.get(await digestBytes(bytes)), { code: 'OBJECT_DIGEST_MISMATCH', status: 409 });
});

test('timed-out conditional content write retains bytes and only reconciles on an explicit same-key retry', async () => {
  let complete!: () => void, writes = 0, reads = 0, retained: Uint8Array | null = null;
  const keys: string[] = [], digest = await digestBytes(bytes), input = bytes.slice();
  const store = new ObjectStore(bucket({
    head: async () => retained ? { size: retained.length } : null,
    get: async () => { reads++; return retained ? object(retained) : null; },
    put: (key: string, value: Uint8Array, options: R2PutOptions) => {
      keys.push(key); writes++; assert.deepEqual(options.onlyIf, { etagDoesNotMatch: '*' });
      return new Promise(resolve => { complete = () => { retained = value.slice(); resolve({}); }; });
    },
  }), 20);
  await assert.rejects(store.put(input), deadline);
  input.fill(0); complete(); await tick();
  assert.equal(reads, 0); assert.equal(writes, 1);
  assert.deepEqual(retained, bytes);
  assert.equal(await store.put(bytes), digest);
  assert.equal(reads, 1); assert.equal(writes, 1); assert.deepEqual(keys, [store.key(digest)]);
});

test('journal late write keeps single assignment and exact retry identity', { timeout: 5000 }, async context => {
  // Hashing and readback use real asynchronous work. Advance the deadline only
  // after the conditional write has started, then keep retry time deterministic.
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let complete!: () => void, enteredPut!: () => void, retained: Uint8Array | null = null, writes = 0, reads = 0;
  const putStarted = new Promise<void>(resolve => { enteredPut = resolve; });
  const key = 'journal/owned/intent', input = bytes.slice();
  const store = new ObjectStore(bucket({
    get: async (requested: string) => { assert.equal(requested, key); reads++; return retained ? object(retained) : null; },
    put: (requested: string, value: Uint8Array, options: R2PutOptions) => {
      assert.equal(requested, key); assert.deepEqual(options.onlyIf, { etagDoesNotMatch: '*' }); writes++;
      return new Promise(resolve => { complete = () => { retained = value.slice(); resolve({}); }; enteredPut(); });
    },
  }), 20);
  const operation = store.putJournal(key, input), rejected = assert.rejects(operation, deadline);
  await Promise.race([putStarted, operation]);
  context.mock.timers.tick(20); await rejected;
  input.fill(0); complete(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1); assert.equal(writes, 1); assert.deepEqual(retained, bytes);
  assert.equal(await store.putJournal(key, bytes), await digestBytes(bytes));
  assert.equal(reads, 3, 'the explicit retry checks existing intent and verifies its readback');
  await assert.rejects(store.putJournal(key, new TextEncoder().encode('different intent')), { code: 'JOURNAL_SINGLE_ASSIGNMENT', status: 409 });
  assert.deepEqual(retained, bytes); assert.equal(writes, 1);
});

test('one object deadline includes head, write and verified readback', { timeout: 5000 }, async context => {
  // Real scheduling can consume the entire budget before put starts. Advance
  // both the deadline timer and its Date checks only after each stage is ready.
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  let completePut!: () => void, enteredHead!: () => void, enteredPut!: () => void, reads = 0, settled = false;
  const headStarted = new Promise<void>(resolve => { enteredHead = resolve; });
  const putStarted = new Promise<void>(resolve => { enteredPut = resolve; });
  const store = new ObjectStore(bucket({
    head: () => new Promise(resolve => { setTimeout(() => resolve(null), 60); enteredHead(); }),
    put: () => new Promise(resolve => { completePut = () => resolve({}); enteredPut(); }),
    get: async () => { reads++; return object(bytes); },
  }), 100);
  const operation = store.put(bytes), pending = assert.rejects(operation, deadline).then(() => { settled = true; });
  await Promise.race([headStarted, operation]);
  context.mock.timers.tick(60);
  await Promise.race([putStarted, operation]);
  context.mock.timers.tick(39); await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(reads, 0);
  context.mock.timers.tick(1); await pending;
  // Each stage lasts less than 100ms, but their combined time exceeds it.
  // Resetting a fresh deadline for put/readback would incorrectly succeed.
  context.mock.timers.tick(20); completePut();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 0);
});

test('missing objects and successful journal readbacks preserve existing semantics', async () => {
  await assert.rejects(new ObjectStore(bucket({ get: async () => null })).get(await digestBytes(bytes)), { code: 'REQUIRED_OBJECT_MISSING', status: 409 });
  let saved: Uint8Array | null = null;
  const store = new ObjectStore(bucket({ get: async () => saved ? object(saved) : null, put: async (_key: string, value: Uint8Array) => { saved = value; return {}; } }));
  assert.equal(await store.putJournal('journal/owned/complete', bytes), await digestBytes(bytes));
  assert.deepEqual(saved, bytes);
});

test('journal reads bound both late R2 replies and stalled bodies without allowing continuation', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const key = 'journal/owned/read';
  let release!: (value: unknown) => void, started!: () => void, cancelled = 0, continued = false;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const late = new ObjectStore(bucket({ get: () => new Promise(resolve => { release = resolve; started(); }) }), 20);
  const operation = late.getJournal(key).then(() => { continued = true; });
  const rejected = assert.rejects(operation, deadline); await entered;
  context.mock.timers.tick(20); await rejected;
  release({ size: bytes.length, body: new ReadableStream({ cancel() { cancelled++; } }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1); assert.equal(continued, false);

  const stalled = new ObjectStore(bucket({ get: async () => ({ size: bytes.length, body: new ReadableStream({
    cancel() { cancelled++; return new Promise<void>(() => {}); },
  }) }) }), 20);
  const pending = assert.rejects(stalled.getJournal(key), deadline);
  await new Promise(resolve => setImmediate(resolve)); context.mock.timers.tick(20); await pending;
  assert.equal(cancelled, 2);
});

test('journal reads keep missing, bounded bytes and digest integrity distinct', async () => {
  const key = 'journal/owned/read', digest = await digestBytes(bytes);
  assert.equal(await new ObjectStore(bucket({ get: async () => null })).getJournal(key, digest), null);
  const store = new ObjectStore(bucket({ get: async () => object(bytes) }));
  assert.deepEqual(await store.getJournal(key, digest), bytes);
  await assert.rejects(store.getJournal(key, 'sha256:' + '0'.repeat(64)), { code: 'JOURNAL_DIGEST_MISMATCH', status: 409 });
  let cancelled = false;
  const large = new ObjectStore(bucket({ get: async () => ({ size: 1024 * 1024 + 1, body: new ReadableStream({ cancel() { cancelled = true; } }) }) }));
  await assert.rejects(large.getJournal(key), { code: 'SIZE_LIMIT', status: 413 }); assert.equal(cancelled, true);
  await assert.rejects(store.getJournal('objects/other'), { code: 'INVALID_JOURNAL', status: 400 });
});
