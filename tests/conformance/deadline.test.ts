import test from 'node:test';
import assert from 'node:assert/strict';
import { withinDeadline, boundedServiceFetch } from '../../workers/shared/deadline';

test('pending RPC times out without making its late result a new operation', async () => {
  let complete!: (value: string) => void;
  let calls = 0;
  const original = new Promise<string>(resolve => { complete = resolve; });
  await assert.rejects(withinDeadline(() => { calls++; return original; }, 15, 'OWNED_DEADLINE'), { code: 'OWNED_DEADLINE', status: 503 });
  complete('original operation finished');
  assert.equal(await original, 'original operation finished');
  assert.equal(calls, 1);
});

test('deadline propagates synchronous failures and observes late rejection', async () => {
  await assert.rejects(withinDeadline(() => { throw new Error('owned synchronous failure'); }, 100), /owned synchronous failure/);
  let reject!: (error: Error) => void;
  await assert.rejects(withinDeadline(() => new Promise<never>((_, fail) => { reject = fail; }), 10), { code: 'SERVICE_DEADLINE_EXCEEDED' });
  reject(new Error('owned late rejection'));
  await new Promise(resolve => setTimeout(resolve, 1));
});

test('expired deadline never invokes an operation', async () => {
  let calls = 0;
  await assert.rejects(withinDeadline(async () => { calls++; }, 0), { code: 'SERVICE_DEADLINE_EXCEEDED' });
  assert.equal(calls, 0);
});

test('service deadline includes body cancellation and aborts a stalled fetch', async () => {
  let signal!: AbortSignal;
  const pending = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => { signal = init!.signal!; return new Promise<Response>(() => {}); } };
  await assert.rejects(boundedServiceFetch(pending, 'https://owned.invalid', {}, 15), { code: 'SERVICE_DEADLINE_EXCEEDED' });
  assert.equal(signal.aborted, true);
  const body = new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => {}) });
  await assert.rejects(boundedServiceFetch({ fetch: async () => new Response(body) }, 'https://owned.invalid', {}, 15), { code: 'SERVICE_DEADLINE_EXCEEDED' });
});

test('status-only calls dispose response bodies and preserve status', async () => {
  let disposed = false;
  const body = new ReadableStream<Uint8Array>({ cancel: () => { disposed = true; } });
  const response = await boundedServiceFetch({ fetch: async () => new Response(body, { status: 202 }) }, 'https://owned.invalid');
  assert.equal(response.status, 202);
  assert.equal(disposed, true);
});
