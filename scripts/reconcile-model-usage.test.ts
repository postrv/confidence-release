// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalize } from '../packages/protocol/src/index.ts';
import { reconcileModelUsage } from './reconcile-model-usage.ts';

const accountId = 'a'.repeat(32), bucketName = 'owned-usage-test';
const scope = { schemaVersion: 1, tenantId: 'owned-tenant', projectId: 'owned-project', projectIncarnation: 'owned-incarnation' };
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const callA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', callB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const digest = (value: Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const raw = (value: unknown) => Buffer.from(typeof value === 'string' ? value : canonicalize(value));
const key = (value: Uint8Array) => `objects/sha256/${digest(value).slice(7)}`;
const request = raw({ model: '@cf/zai-org/glm-5.3', reasoning_effort: 'low', stream: false, store: false, max_completion_tokens: 8192,
  messages: [{ role: 'user', content: 'private prompt never enters report' }] });
const reservationA = { callId: callA, attemptId: a, generation: '1',
  requestDigest: digest(raw({ providerKind: 'workers-ai', request: JSON.parse(request.toString()) })), maximumCost: '100000', state: 'DISPATCHED' };
const reservationB = { ...reservationA, callId: callB, attemptId: b, generation: '2' };
const snapshot = { project: { scope, revision: '31', maximumBudget: '2000000', reservedBudget: '0', settledBudget: '2000000' }, attempts: [{ id: a, generation: '1' }, { id: b, generation: '2' }],
  modelCalls: { limit: 2048, overflow: false, reservations: [reservationA, reservationB] } };
const snapshotBytes = Buffer.from(JSON.stringify(snapshot));
const response = Buffer.from(JSON.stringify({ id: 'owned-response', model: '@cf/zai-org/glm-5.3', choices: [{ message: { role: 'assistant', content: 'private response never enters report' } }],
  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 20 } } }));
const startA = raw({ scope, attemptId: a, generation: '1', callId: callA, requestDigest: digest(request), providerKind: 'workers-ai', requestedModel: '@cf/zai-org/glm-5.3', reasoningEffort: 'low', producer: 'broker-observed', state: 'MAY_HAVE_DISPATCHED', maximumReservedCost: '100000' });
const endA = raw({ scope, attemptId: a, generation: '1', callId: callA, requestDigest: digest(request), responseDigest: digest(response), providerKind: 'workers-ai', requestedModel: '@cf/zai-org/glm-5.3', reportedModel: '@cf/zai-org/glm-5.3', responseId: 'owned-response', usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 20 } }, producer: 'broker-observed', outcome: 'RESPONSE', maximumReservedCost: '100000' });
const startB = raw({ scope, attemptId: b, generation: '2', callId: callB, requestDigest: digest(request), providerKind: 'workers-ai', requestedModel: '@cf/zai-org/glm-5.3', reasoningEffort: 'low', producer: 'broker-observed', state: 'MAY_HAVE_DISPATCHED', maximumReservedCost: '100000' });
const deepseekModel = '@cf/deepseek-ai/deepseek-v4-flash-0731';
const deepseekRequest = raw({ model: deepseekModel, reasoning_effort: 'none', stream: false, store: false, max_completion_tokens: 8192,
  messages: [{ role: 'user', content: 'different private prompt' }] });
const deepseekUsage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 20 } };
const deepseekResponse = Buffer.from(JSON.stringify({ id: 'owned-deepseek-response', model: deepseekModel,
  choices: [{ message: { role: 'assistant', content: 'different private response' } }], usage: deepseekUsage }));
const deepseekStartB = raw({ scope, attemptId: b, generation: '2', callId: callB, requestDigest: digest(deepseekRequest), providerKind: 'workers-ai',
  requestedModel: deepseekModel, reasoningEffort: 'none', producer: 'broker-observed', state: 'MAY_HAVE_DISPATCHED', maximumReservedCost: '100000' });
const deepseekEndB = raw({ scope, attemptId: b, generation: '2', callId: callB, requestDigest: digest(deepseekRequest),
  responseDigest: digest(deepseekResponse), providerKind: 'workers-ai', requestedModel: deepseekModel, reportedModel: deepseekModel,
  responseId: 'owned-deepseek-response', usage: deepseekUsage, producer: 'broker-observed', outcome: 'RESPONSE', maximumReservedCost: '100000' });
const deepseekReservationB = { ...reservationB,
  requestDigest: digest(raw({ providerKind: 'workers-ai', request: JSON.parse(deepseekRequest.toString()) })) };
const mixedSnapshot = { ...snapshot, modelCalls: { ...snapshot.modelCalls, reservations: [reservationA, deepseekReservationB] } };
const mixedInventory = (extra: Uint8Array[] = [], omit: string[] = []) => mockInventory({ omit: [key(startB), ...omit],
  extra: [deepseekStartB, deepseekEndB, deepseekRequest, deepseekResponse, ...extra] });

function mockInventory(options: { truncate?: boolean; omitFinalResultInfo?: boolean; corrupt?: string; missing?: string; cursorLoop?: boolean; omit?: string | string[]; extra?: Uint8Array | Uint8Array[] } = {}) {
  const omitted = new Set(options.omit ? Array.isArray(options.omit) ? options.omit : [options.omit] : []);
  const extras = options.extra ? Array.isArray(options.extra) ? options.extra : [options.extra] : [];
  const values = [startA, endA, startB, request, response, raw('unrelated source'), ...extras].filter(value => !omitted.has(key(value)));
  const inventory = new Map(values.map(value => [key(value), value]));
  const calls: { method: string; url: string }[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input)); calls.push({ method: init?.method ?? 'GET', url: url.href });
    assert.equal(url.origin, 'https://api.cloudflare.com');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, 'Bearer owned-secret-credential');
    const keys = [...inventory.keys()].sort();
    if (url.pathname.endsWith('/objects')) {
      assert.equal(url.searchParams.get('prefix'), 'objects/sha256/');
      const cursor = url.searchParams.get('cursor');
      const start = cursor ? Number(cursor) : 0; const pageSize = Number(url.searchParams.get('per_page'));
      const pageKeys = keys.slice(start, start + pageSize);
      const next = start + pageKeys.length;
      const result = pageKeys.map(name => ({ key: name, size: inventory.get(name)!.length, custom_metadata: { digest: `sha256:${name.slice('objects/sha256/'.length)}` } }));
      const truncated = options.truncate ?? next < keys.length;
      return Response.json({ success: true, result,
        ...(!truncated && options.omitFinalResultInfo ? {} : { result_info: { is_truncated: truncated, cursor: options.cursorLoop ? '0' : String(next) } }) });
    }
    const object = inventory.get(url.pathname.slice(url.pathname.lastIndexOf('/objects/') + 1));
    if (!object || options.missing === url.pathname) return new Response(null, { status: 404 });
    return new Response(options.corrupt === url.pathname ? 'tampered' : Buffer.from(object));
  };
  return { fetcher: fetcher as typeof fetch, calls, inventory };
}
const options = (fetcher: typeof fetch) => ({ snapshot, snapshotBytes, accountId, bucketName, token: 'owned-secret-credential', fetcher,
  now: '2026-10-07T21:00:00.000Z', limits: { objects: 10, pages: 3, pageSize: 3, totalBytes: 8 * 1024 * 1024 } });
const withSnapshot = (fetcher: typeof fetch, changed: typeof snapshot) => ({ ...options(fetcher), snapshot: changed, snapshotBytes: Buffer.from(JSON.stringify(changed)) });

test('ordinary snapshots without the opt-in roster fail closed before any R2 request', async () => {
  const mock = mockInventory();
  const { modelCalls: _omitted, ...ordinary } = snapshot;
  await assert.rejects(reconcileModelUsage({ ...options(mock.fetcher), snapshot: ordinary,
    snapshotBytes: Buffer.from(JSON.stringify(ordinary)) }), /AUTHORITY_SNAPSHOT_SCHEMA/);
  assert.equal(mock.calls.length, 0);
});

test('paginated R2 inventory prices verified responses while a start-only reservation keeps total unknown', async () => {
  const mock = mockInventory(); const report = await reconcileModelUsage(options(mock.fetcher));
  assert.equal(report.status, 'OBSERVED_PARTIAL');
  assert.equal(report.inventory.complete, true);
  assert.equal(report.inventory.pages, 2);
  assert.equal(report.inventory.listedObjects, 6);
  assert.equal(report.attempts.length, 2);
  assert.equal(report.attempts[0]!.calls[0]!.state, 'VERIFIED_RESPONSE');
  assert.equal(report.attempts[0]!.calls[0]!.requestedModel, '@cf/zai-org/glm-5.3');
  assert.equal(report.attempts[0]!.calls[0]!.reasoningEffort, 'low');
  assert.equal(report.attempts[1]!.calls[0]!.state, 'UNCERTAIN_DISPATCH');
  assert.deepEqual(report.observedUsage, { promptTokens: 100, completionTokens: 50, cachedInputTokens: 20 });
  assert.equal(report.observedResponseEstimateUsd, '0.000337200');
  assert.deepEqual(report.price.models[0], { model: '@cf/zai-org/glm-5.3', observedOn: '2026-10-07',
    perMillion: { ordinaryInput: '1.40', cachedInput: '0.26', output: '4.40' } });
  assert.equal(report.estimatedTotalUsd, null);
  assert.equal(report.attempts[0]!.callCoverage, 'COMPLETE');
  assert.equal(report.attempts[1]!.callCoverage, 'INCOMPLETE');
  assert.equal(report.modelCalls.callCoverage, 'INCOMPLETE');
  assert.equal(report.modelCalls.unobservedCallCount, 0);
  assert.equal(report.protocolBudgetMicroUnits.settled, '2000000');
  assert.equal(report.remoteMutations, 0);
  assert(mock.calls.every(call => call.method === 'GET'));
  assert(!JSON.stringify(report).includes('private prompt'));
  assert(!JSON.stringify(report).includes('private response'));
  assert(!JSON.stringify(report).includes('owned-secret-credential'));
});

test('complete authority roster and verified response pair yield an estimate, not a bill', async () => {
  const mock = mockInventory({ omit: key(startB) });
  const changed = { ...snapshot, modelCalls: { ...snapshot.modelCalls, reservations: [reservationA] } };
  const report = await reconcileModelUsage(withSnapshot(mock.fetcher, changed));
  assert.equal(report.status, 'COMPLETE_ESTIMATE');
  assert.equal(report.modelCalls.callCoverage, 'COMPLETE');
  assert.equal(report.modelCalls.listedReservations, 1);
  assert.equal(report.observedResponseEstimateUsd, '0.000337200');
  assert.equal(report.estimatedTotalUsd, '0.000337200');
  assert(report.price.meaning.includes('not a Cloudflare invoice'));
});

test('mixed GLM and DeepSeek responses use their own rates and sum into one complete estimate', async () => {
  const mock = mixedInventory();
  const report = await reconcileModelUsage(withSnapshot(mock.fetcher, mixedSnapshot));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.status, 'COMPLETE_ESTIMATE');
  assert.equal(report.modelCalls.callCoverage, 'COMPLETE');
  assert.equal(report.inventory.listedObjects, 9);
  assert.equal(report.attempts[0]!.calls[0]!.observedResponseEstimateUsd, '0.000337200');
  assert.equal(report.attempts[1]!.calls[0]!.requestedModel, deepseekModel);
  assert.equal(report.attempts[1]!.calls[0]!.reasoningEffort, 'none');
  assert.equal(report.attempts[1]!.calls[0]!.state, 'VERIFIED_RESPONSE');
  assert.equal(report.attempts[1]!.calls[0]!.observedResponseEstimateUsd, '0.000101480');
  assert.deepEqual(report.price.models[1], { model: deepseekModel, observedOn: '2026-10-08',
    perMillion: { ordinaryInput: '0.44', cachedInput: '0.014', output: '1.32' } });
  assert.deepEqual(report.observedUsage, { promptTokens: 200, completionTokens: 100, cachedInputTokens: 40 });
  assert.equal(report.observedResponseEstimateUsd, '0.000438680');
  assert.equal(report.estimatedTotalUsd, '0.000438680');
  assert(mock.calls.every(call => call.method === 'GET'));
  assert(!JSON.stringify(report).includes('different private prompt'));
  assert(!JSON.stringify(report).includes('different private response'));
});

test('DeepSeek request with the wrong reasoning effort cannot be verified or priced', async () => {
  const wrongRequest = raw({ ...JSON.parse(deepseekRequest.toString()), reasoning_effort: 'low' });
  const wrongStart = raw({ ...JSON.parse(deepseekStartB.toString()), requestDigest: digest(wrongRequest) });
  const wrongEnd = raw({ ...JSON.parse(deepseekEndB.toString()), requestDigest: digest(wrongRequest) });
  const changed = { ...mixedSnapshot, modelCalls: { ...mixedSnapshot.modelCalls, reservations: [reservationA,
    { ...deepseekReservationB, requestDigest: digest(raw({ providerKind: 'workers-ai', request: JSON.parse(wrongRequest.toString()) })) }] } };
  const mock = mixedInventory([wrongRequest, wrongStart, wrongEnd], [key(deepseekStartB), key(deepseekEndB), key(deepseekRequest)]);
  const report = await reconcileModelUsage(withSnapshot(mock.fetcher, changed));
  assert.equal(report.attempts[1]!.calls[0]!.state, 'UNVERIFIED_RESPONSE');
  assert(report.attempts[1]!.calls[0]!.uncertainty.includes('MODEL_REQUEST_IDENTITY_MISMATCH'));
  assert.equal(report.attempts[1]!.calls[0]!.observedResponseEstimateUsd, null);
  assert.equal(report.observedResponseEstimateUsd, '0.000337200');
  assert.equal(report.estimatedTotalUsd, null);
});

test('DeepSeek response must identify the requested model before its usage is priced', async () => {
  const wrongResponse = Buffer.from(JSON.stringify({ ...JSON.parse(deepseekResponse.toString()), model: '@cf/zai-org/glm-5.3' }));
  const wrongEnd = raw({ ...JSON.parse(deepseekEndB.toString()), responseDigest: digest(wrongResponse) });
  const mock = mixedInventory([wrongResponse, wrongEnd], [key(deepseekEndB), key(deepseekResponse)]);
  const report = await reconcileModelUsage(withSnapshot(mock.fetcher, mixedSnapshot));
  assert.equal(report.attempts[1]!.calls[0]!.state, 'UNVERIFIED_RESPONSE');
  assert(report.attempts[1]!.calls[0]!.uncertainty.includes('MODEL_RESPONSE_IDENTITY_MISMATCH'));
  assert.equal(report.attempts[1]!.calls[0]!.observedResponseEstimateUsd, null);
  assert.equal(report.estimatedTotalUsd, null);
});

test('a broker start that disagrees with its model reasoning policy fails closed', async () => {
  const wrongStart = raw({ ...JSON.parse(deepseekStartB.toString()), reasoningEffort: 'low' });
  const mock = mixedInventory([wrongStart], [key(deepseekStartB)]);
  await assert.rejects(reconcileModelUsage(withSnapshot(mock.fetcher, mixedSnapshot)), /BROKER_REASONING_EFFORT_MISMATCH/);
});

test('same-call observations with different requested models cannot establish a price', async () => {
  const conflictedEnd = raw({ ...JSON.parse(deepseekEndB.toString()), requestedModel: '@cf/zai-org/glm-5.3' });
  const mock = mixedInventory([conflictedEnd], [key(deepseekEndB)]);
  const report = await reconcileModelUsage(withSnapshot(mock.fetcher, mixedSnapshot));
  assert.equal(report.attempts[1]!.calls[0]!.state, 'CONFLICT');
  assert(report.attempts[1]!.calls[0]!.uncertainty.includes('BROKER_CALL_IDENTITY_CONFLICT'));
  assert.equal(report.estimatedTotalUsd, null);
});

test('a reservation without any broker object is explicit and prevents a total', async () => {
  const report = await reconcileModelUsage(options(mockInventory({ omit: key(startB) }).fetcher));
  assert.equal(report.attempts[1]!.calls[0]!.state, 'UNOBSERVED_RESERVATION');
  assert.deepEqual(report.attempts[1]!.calls[0]!.observationDigests, []);
  assert.equal(report.modelCalls.unobservedCallCount, 1);
  assert.equal(report.estimatedTotalUsd, null);
});

test('a response without its start is not counted as complete even when linked bytes verify', async () => {
  const report = await reconcileModelUsage(options(mockInventory({ omit: key(startA) }).fetcher));
  assert.equal(report.attempts[0]!.calls[0]!.state, 'ORPHAN_RESPONSE');
  assert(report.attempts[0]!.calls[0]!.uncertainty.includes('START_OBSERVATION_MISSING'));
  assert.equal(report.attempts[0]!.observedResponseEstimateUsd, '0.000000000');
  assert.equal(report.estimatedTotalUsd, null);
});

test('a conflicting broker identity cannot be priced or treated as covered', async () => {
  const conflicting = raw({ scope, attemptId: a, generation: '1', callId: callA, requestDigest: `sha256:${'f'.repeat(64)}`,
    providerKind: 'workers-ai', requestedModel: '@cf/zai-org/glm-5.3', reasoningEffort: 'low', producer: 'broker-observed', state: 'MAY_HAVE_DISPATCHED', maximumReservedCost: '100000' });
  const report = await reconcileModelUsage(options(mockInventory({ extra: conflicting }).fetcher));
  assert.equal(report.attempts[0]!.calls[0]!.state, 'CONFLICT');
  assert.equal(report.attempts[0]!.observedResponseEstimateUsd, '0.000000000');
  assert.equal(report.estimatedTotalUsd, null);
});

test('the authority route-and-request digest must match the verified R2 request bytes', async () => {
  const changed = { ...snapshot, modelCalls: { ...snapshot.modelCalls, reservations: [
    { ...reservationA, requestDigest: `sha256:${'f'.repeat(64)}` }, reservationB] } };
  const report = await reconcileModelUsage(withSnapshot(mockInventory().fetcher, changed));
  assert.equal(report.attempts[0]!.calls[0]!.state, 'CONFLICT');
  assert(report.attempts[0]!.calls[0]!.uncertainty.includes('AUTHORITY_REQUEST_DIGEST_MISMATCH'));
  assert.equal(report.estimatedTotalUsd, null);
});

test('an R2 observation with no authority reservation is visible but never establishes cost', async () => {
  const changed = { ...snapshot, modelCalls: { ...snapshot.modelCalls, reservations: [reservationA] } };
  const report = await reconcileModelUsage(withSnapshot(mockInventory().fetcher, changed));
  assert.equal(report.attempts[1]!.calls[0]!.state, 'UNRESERVED_OBSERVATION');
  assert.equal(report.modelCalls.callCoverage, 'INCOMPLETE');
  assert.equal(report.estimatedTotalUsd, null);
});

test('an overflowing authority roster forbids totals and marks missing count unknown', async () => {
  const changed = { ...snapshot, modelCalls: { ...snapshot.modelCalls, overflow: true } };
  const report = await reconcileModelUsage(withSnapshot(mockInventory().fetcher, changed));
  assert.equal(report.modelCalls.callCoverage, 'ROSTER_OVERFLOW');
  assert.equal(report.modelCalls.unobservedCallCount, null);
  assert.equal(report.estimatedTotalUsd, null);
});

test('a final R2 page may omit result_info', async () => {
  const mock = mockInventory({ omitFinalResultInfo: true });
  const report = await reconcileModelUsage(options(mock.fetcher));
  assert.equal(report.inventory.complete, true);
  assert.equal(report.inventory.pages, 2);
  assert.equal(report.attempts[0]!.verifiedResponseCount, 1);
});

test('content-addressed list body mismatch blocks reconciliation', async () => {
  const mock = mockInventory();
  const corruptKey = [...mock.inventory.keys()].sort()[0]!;
  await assert.rejects(reconcileModelUsage(options(mockInventory({ corrupt: `/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/objects/${corruptKey}` }).fetcher)), /R2_OBJECT_DIGEST_MISMATCH/);
});

test('bounded pagination leaves inventory incomplete and never invents project cost', async () => {
  const mock = mockInventory(); const report = await reconcileModelUsage({ ...options(mock.fetcher), limits: { objects: 3, pages: 1, pageSize: 3, totalBytes: 8 * 1024 * 1024 } });
  assert.equal(report.inventory.complete, false);
  assert(report.inventory.issues.includes('SCAN_LIMIT_REACHED'));
  assert.equal(report.estimatedTotalUsd, null);
  assert.equal(report.inventory.listedObjects, 3);
});

test('missing linked response remains uncertain and cannot enter the price subtotal', async () => {
  const mock = mockInventory({ omit: key(response) }); const report = await reconcileModelUsage(options(mock.fetcher));
  assert.equal(report.inventory.complete, true);
  assert.equal(report.attempts[0]!.calls[0]!.state, 'UNVERIFIED_RESPONSE');
  assert(report.attempts[0]!.calls[0]!.uncertainty.includes('LINKED_BYTES_UNVERIFIED'));
  assert.equal(report.observedResponseEstimateUsd, '0.000000000');
  assert.equal(report.estimatedTotalUsd, null);
});

test('broker record from another project does not reinterpret this project’s model usage', async () => {
  const external = raw({ scope: { ...scope, projectIncarnation: 'different' }, attemptId: a, generation: '1', callId: callA,
    requestDigest: digest(request), providerKind: 'openai-compatible', requestedModel: 'external-model', producer: 'broker-observed',
    state: 'MAY_HAVE_DISPATCHED', maximumReservedCost: '100000' });
  const mock = mockInventory({ extra: external }); const report = await reconcileModelUsage(options(mock.fetcher));
  assert.equal(report.attempts[0]!.observedCallCount, 1);
  assert.equal(report.unmatchedObservationDigests.length, 0);
});


test('complete indexed call follows exactly its linked facts and source bytes without bucket discovery', async () => {
  const mock = mockInventory();
  const changed = { ...snapshot, modelCalls: { ...snapshot.modelCalls, reservations: [{ ...reservationA, outcome: {
    schemaVersion: 1, state: 'RESPONSE_RETAINED', providerKind: 'workers-ai', dispatchObservationDigest: digest(startA), responseObservationDigest: digest(endA),
  } }] } };
  const report = await reconcileModelUsage(withSnapshot(mock.fetcher, changed));
  assert.equal(report.inventory.mode, 'PROJECT_INDEX_LINKS'); assert.equal(report.inventory.pages, 0);
  assert.equal(report.status, 'COMPLETE_ESTIMATE'); assert.equal(report.modelCalls.callCoverage, 'COMPLETE');
  assert.equal(report.attempts[0].calls[0].state, 'VERIFIED_RESPONSE');
  assert.equal(mock.calls.length, 4); assert(mock.calls.every(call => !new URL(call.url).pathname.endsWith('/objects')));
  assert(report.limitations.some(value => value.includes('does not scan for orphaned')));
  assert(!JSON.stringify(report).includes('private prompt')); assert(!JSON.stringify(report).includes('private response'));
});

test('indexed response without its dispatch fact stays orphaned with total unknown', async () => {
  const mock = mockInventory();
  const changed = { ...snapshot, modelCalls: { ...snapshot.modelCalls, reservations: [{ ...reservationA, outcome: {
    schemaVersion: 1, state: 'RESPONSE_RETAINED', providerKind: 'workers-ai', dispatchObservationDigest: null, responseObservationDigest: digest(endA),
  } }] } };
  const report = await reconcileModelUsage(withSnapshot(mock.fetcher, changed));
  assert.equal(report.inventory.mode, 'PROJECT_INDEX_LINKS'); assert.equal(report.status, 'OBSERVED_PARTIAL');
  assert.equal(report.estimatedTotalUsd, null); assert.equal(report.attempts[0].calls[0].state, 'ORPHAN_RESPONSE');
  assert(report.attempts[0].calls[0].uncertainty.includes('START_OBSERVATION_MISSING'));
  assert(mock.calls.every(call => !new URL(call.url).pathname.endsWith('/objects')));
});

test('corrupt or crossed indexed links remain partial without falling back to a bucket-wide search', async () => {
  for (const crossed of [false, true]) {
    const mock = mockInventory();
    const changed = { ...snapshot, modelCalls: { ...snapshot.modelCalls, reservations: [{ ...reservationA, outcome: {
      schemaVersion: 1, state: 'MAY_HAVE_DISPATCHED', providerKind: 'workers-ai', dispatchObservationDigest: crossed ? digest(startB) : 'sha256:' + 'f'.repeat(64), responseObservationDigest: null,
    } }] } };
    const report = await reconcileModelUsage(withSnapshot(mock.fetcher, changed));
    assert.equal(report.status, 'OBSERVED_PARTIAL'); assert.equal(report.estimatedTotalUsd, null);
    assert(report.inventory.issues.includes('INDEXED_LINK_UNVERIFIED'));
    assert(mock.calls.every(call => !new URL(call.url).pathname.endsWith('/objects')));
  }
});

test('one legacy call preserves the explicit bounded discovery path without changing old reservations', async () => {
  const mock = mockInventory();
  const changed = { ...snapshot, modelCalls: { ...snapshot.modelCalls, reservations: [{ ...reservationA, outcome: {
    schemaVersion: 1, state: 'LEGACY_UNINDEXED', providerKind: null, dispatchObservationDigest: null, responseObservationDigest: null,
  } }] } };
  const before = JSON.stringify(changed); const report = await reconcileModelUsage(withSnapshot(mock.fetcher, changed));
  assert.equal(report.inventory.mode, 'BUCKET_DISCOVERY'); assert(mock.calls.some(call => new URL(call.url).pathname.endsWith('/objects')));
  assert.equal(JSON.stringify(changed), before); assert.equal(changed.modelCalls.reservations[0].state, 'DISPATCHED');
});
