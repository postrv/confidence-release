// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_RESPONSE_BYTES, modelResponseLifetime, modelResponseStream, readModelResponse } from './model-response-stream.ts';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const reply = encode({ id: 'owned-response', model: 'owned-model', choices: [{ index: 0, message: { role: 'assistant', content: 'owned proposal' }, finish_reason: 'stop' }], usage: { total_tokens: 1 } });
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
async function remainingText(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let text = '';
  for (;;) { const chunk = await reader.read(); if (chunk.done) return text; text += decode(chunk.value); }
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const untilAborted = (signal: AbortSignal) => new Promise<Uint8Array>((_resolve, reject) => {
  signal.throwIfAborted(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('headers and bounded comments precede a retained single completion', { timeout: 3000 }, async () => {
  const retained = deferred<Uint8Array>();
  const failures: unknown[] = [];
  let calls = 0;
  const task = modelResponseStream({ lifetime: modelResponseLifetime(new AbortController().signal, 2000), heartbeatMs: 10,
    produce: () => { calls++; return retained.promise; }, onFailure: error => failures.push(error) });
  assert.equal(task.response.headers.get('content-type'), 'text/event-stream');
  const reader = task.response.body!.getReader();
  assert.equal(decode((await reader.read()).value!), ': model-pending\n\n');
  assert.equal(decode((await reader.read()).value!), ': model-pending\n\n');
  retained.resolve(reply);
  let terminal = '';
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; terminal += decode(chunk.value); }
  await task.completion;
  assert.equal(calls, 1);
  assert.deepEqual(failures, []);
  assert.equal(terminal.match(/chat.completion.chunk/g)?.length, 1);
  assert.equal(terminal.match(/\[DONE\]/g)?.length, 1);
  assert.match(terminal, /owned proposal/);
});

test('a stalled consumer queues one comment and a bounded terminal packet', { timeout: 3000 }, async () => {
  const retained = deferred<Uint8Array>();
  const task = modelResponseStream({ lifetime: modelResponseLifetime(new AbortController().signal, 2000), heartbeatMs: 5,
    produce: () => retained.promise, onFailure: error => assert.fail(String(error)) });
  await new Promise(resolve => setTimeout(resolve, 40));
  retained.resolve(reply);
  await task.completion;
  const text = await task.response.text();
  assert.equal(text.match(/: model-pending/g)?.length, 1);
  assert.equal(text.match(/\[DONE\]/g)?.length, 1);
});

for (const kind of ['client-disconnected', 'consumer-cancelled', 'deadline'] as const) {
  test(`${kind} cancels the single provider call and cannot emit a completion`, { timeout: 3000 }, async () => {
    const client = new AbortController();
    const lifetime = modelResponseLifetime(client.signal, kind === 'deadline' ? 20 : 2000);
    const failures: unknown[] = [];
    let calls = 0, aborted = false;
    const task = modelResponseStream({ lifetime, heartbeatMs: 5, produce: signal => {
      calls++;
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return untilAborted(signal);
    }, onFailure: (_error, termination) => failures.push(termination) });
    let text = '';
    const initial = task.response.body!.getReader(); await initial.read();
    if (kind === 'consumer-cancelled') await initial.cancel('untrusted private reason');
    else {
      if (kind === 'client-disconnected') client.abort('untrusted private reason');
      text = await remainingText(initial);
    }
    await task.completion;
    assert.equal(calls, 1);
    assert.equal(aborted, true);
    assert.deepEqual(failures, [kind]);
    assert.doesNotMatch(text, /owned proposal|chat.completion.chunk|\[DONE\]|private reason/);
    if (kind !== 'consumer-cancelled') assert.match(text, /MODEL_STREAM_FAILED/);
  });
}

test('a caller already disconnected cannot dispatch a provider request', async () => {
  const client = new AbortController(); client.abort();
  let calls = 0;
  const failures: unknown[] = [];
  const task = modelResponseStream({ lifetime: modelResponseLifetime(client.signal, 1000), produce: async () => { calls++; return reply; }, onFailure: (_error, termination) => failures.push(termination) });
  await task.completion;
  assert.equal(calls, 0);
  assert.deepEqual(failures, ['client-disconnected']);
  assert.doesNotMatch(await task.response.text(), /\[DONE\]/);
});

test('provider, response validation and retention failures stay explicit and sanitized', async t => {
  for (const stage of ['provider', 'response-validation', 'retention']) await t.test(stage, async () => {
    const failures: unknown[] = [];
    const task = modelResponseStream({ lifetime: modelResponseLifetime(new AbortController().signal, 1000),
      produce: async () => { throw new Error('private provider body or credential'); }, onFailure: error => failures.push(error) });
    await task.completion;
    const text = await task.response.text();
    assert.equal(failures.length, 1);
    assert.match(text, /MODEL_STREAM_FAILED/);
    assert.doesNotMatch(text, /private|credential|\[DONE\]|chat.completion.chunk/);
  });
});

test('late producer success after cancellation cannot resurrect a completion', async () => {
  const client = new AbortController(); const retained = deferred<Uint8Array>();
  const failures: unknown[] = [];
  const task = modelResponseStream({ lifetime: modelResponseLifetime(client.signal, 1000), produce: () => retained.promise, onFailure: (_error, termination) => failures.push(termination) });
  const initial = task.response.body!.getReader(); await initial.read();
  client.abort();
  retained.resolve(reply);
  await task.completion;
  assert.deepEqual(failures, ['client-disconnected']);
  assert.doesNotMatch(await remainingText(initial), /\[DONE\]|owned proposal/);
});

test('a producer ignoring abort cannot extend the response task deadline', { timeout: 1000 }, async () => {
  const late = deferred<Uint8Array>();
  let calls = 0;
  const failures: unknown[] = [];
  const task = modelResponseStream({ lifetime: modelResponseLifetime(new AbortController().signal, 20),
    produce: () => { calls++; return late.promise; }, onFailure: (_error, termination) => failures.push(termination) });
  await task.completion;
  assert.equal(calls, 1);
  assert.deepEqual(failures, ['deadline']);
  assert.doesNotMatch(await task.response.text(), /\[DONE\]|owned proposal/);
  late.reject(new Error('late private provider failure'));
  await new Promise(resolve => setTimeout(resolve, 0));
});

test('a never-settling upstream cancel cannot extend abort or size failure', { timeout: 1000 }, async t => {
  await t.test('abort', async () => {
    const client = new AbortController(); let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancellations++; return new Promise(() => {}); } });
    const reading = readModelResponse(body, client.signal);
    client.abort();
    await assert.rejects(reading, { name: 'AbortError' });
    assert.equal(cancellations, 1);
    assert.equal(body.locked, false);
  });
  await t.test('size', async () => {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MODEL_RESPONSE_BYTES + 1)); }, cancel() { cancellations++; return new Promise(() => {}); } });
    await assert.rejects(readModelResponse(body, new AbortController().signal), { code: 'SIZE_LIMIT' });
    assert.equal(cancellations, 1);
    assert.equal(body.locked, false);
  });
});

test('response reader abort cancels a blocked upstream body exactly once', async () => {
  const client = new AbortController(); let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancellations++; } });
  const reading = readModelResponse(body, client.signal);
  client.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(cancellations, 1);
  assert.equal(body.locked, false);
});

test('response byte bound and malformed completion never produce DONE', async t => {
  await t.test('bounded read', async () => {
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MODEL_RESPONSE_BYTES + 1)); }, cancel() { cancellations++; } });
    await assert.rejects(readModelResponse(body, new AbortController().signal), { code: 'SIZE_LIMIT' });
    assert.equal(cancellations, 1);
  });
  for (const value of [new Uint8Array(MODEL_RESPONSE_BYTES + 1), encode({ choices: null })]) await t.test('invalid completion', async () => {
    const errors: unknown[] = [];
    const task = modelResponseStream({ lifetime: modelResponseLifetime(new AbortController().signal, 1000), produce: async () => value, onFailure: error => errors.push(error) });
    await task.completion;
    assert.equal(errors.length, 1);
    assert.doesNotMatch(await task.response.text(), /\[DONE\]/);
  });
});
