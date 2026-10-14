// SPDX-License-Identifier: Apache-2.0
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { initializeKernel } from '../../packages/protocol/src/node';
import { canonicalize } from '../../packages/protocol/src/index';
import type { Scope } from '../../packages/protocol/src/types';
import { AUTHORITY_SCHEMA } from './schema';
import { ModelCallIndex } from './model-calls';
import { PlatformError } from '../shared/errors';
import type { ModelCallFact } from '../shared/model-call';

before(initializeKernel);
const hash = (bytes: Uint8Array) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown) => new TextEncoder().encode(canonicalize(value));
const callId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const scope: Scope = { schemaVersion: 1, tenantId: 'tenant', projectId: 'project', projectIncarnation: 'owned-incarnation' };
function fixture(options: { legacy?: boolean; missingUsage?: boolean; invalidUsage?: boolean; external?: boolean } = {}) {
  const db = new DatabaseSync(':memory:'); db.exec(AUTHORITY_SCHEMA);
  const sql = { exec(query: string, ...bindings: (string | number | null)[]) { const rows = db.prepare(query).all(...bindings); return { toArray: () => rows, one: () => rows[0] }; } } as unknown as SqlStorage;
  const bytes = new Map<string, Uint8Array>(); let reads = 0, currentScope = scope;
  let hook: (() => Promise<void>) | null = null;
  const retain = (value: unknown, raw = false) => { const body = raw ? new TextEncoder().encode(JSON.stringify(value)) : encode(value); const digest = hash(body); bytes.set(digest, body); return digest; };
  const model = options.external ? 'owned-external-model' : '@cf/zai-org/glm-5.3', providerKind = options.external ? 'openai-compatible' : 'workers-ai';
  const request = { model, stream: false, store: false, ...(options.external ? { max_tokens: 128 } : { max_completion_tokens: 128, reasoning_effort: 'low' }),
    messages: [{ role: 'user', content: 'private fixture prompt must never appear in model outcome metadata' }] };
  const requestObjectDigest = retain(request);
  const usage = options.missingUsage ? null : { prompt_tokens: 12, completion_tokens: 4, total_tokens: options.invalidUsage ? 99 : 16, prompt_tokens_details: { cached_tokens: 3 } };
  const response = { id: 'owned-provider-response', model, choices: [{ message: { role: 'assistant', content: 'private fixture response text' }, finish_reason: 'stop' }], usage };
  const responseDigest = retain(response, true);
  const reservation = { scope, attemptId: 'owned-attempt', generation: '1', callId, requestDigest: hash(encode({ providerKind, request })), maximumCost: '100000' };
  db.prepare('INSERT INTO reservations(id,owner,maximum,state,payload) VALUES(?,?,?,?,?)').run(callId, reservation.attemptId, reservation.maximumCost, 'DISPATCHED', canonicalize(reservation));
  const build = () => new ModelCallIndex(sql, { get: async (digest: string, maximum = Infinity) => {
    reads++; if (hook) await hook(); const value = bytes.get(digest); if (!value) throw new PlatformError('REQUIRED_OBJECT_MISSING', 409);
    assert(value.length <= maximum); return value;
  } }, () => currentScope);
  const index = build(); if (!options.legacy) index.register(callId);
  const common = { scope, attemptId: reservation.attemptId, generation: '1', callId, requestDigest: requestObjectDigest, providerKind, requestedModel: model, producer: 'broker-observed', maximumReservedCost: reservation.maximumCost };
  const dispatch = { ...common, reasoningEffort: options.external ? null : 'low', state: 'MAY_HAVE_DISPATCHED' };
  const retainedResponse = { ...common, responseDigest, reportedModel: options.external ? null : model, responseId: options.external ? null : response.id, usage: options.external ? null : usage, outcome: 'RESPONSE' };
  const fact = (phase: ModelCallFact['phase'], envelope: unknown = phase === 'DISPATCH' ? dispatch : retainedResponse): ModelCallFact => ({ schemaVersion: 1, scope, attemptId: reservation.attemptId, generation: '1', callId, phase, observationDigest: retain(envelope) });
  return { db, index, build, bytes, fact, retain, request, requestObjectDigest, response, responseDigest, dispatch, retainedResponse, reservation,
    readCount: () => reads, hook: (value: (() => Promise<void>) | null) => { hook = value; }, changeScope: () => { currentScope = { ...scope, projectIncarnation: 'replacement' }; } };
}
const fails = (code: string) => (error: unknown) => error instanceof PlatformError && error.code === code;

test('verified response facts survive restart/exact replay and expose only bounded metadata without changing reservation ceilings', async () => {
  const f = fixture(); try {
    const before = f.db.prepare('SELECT * FROM reservations').all();
    assert.equal(f.index.outcome(callId).state, 'RESERVATION_ONLY');
    const dispatch = f.fact('DISPATCH'), response = f.fact('RESPONSE');
    await f.index.observe(dispatch); assert.equal(f.index.outcome(callId).state, 'MAY_HAVE_DISPATCHED');
    await f.build().observe(response); const result = f.build().outcome(callId), reads = f.readCount();
    assert.equal(result.state, 'RESPONSE_RETAINED'); assert.equal(result.usageStatus, 'VERIFIED'); assert.equal(result.usage?.total_tokens, 16);
    assert.equal(result.dispatchObservationDigest, dispatch.observationDigest); assert.equal(result.responseObservationDigest, response.observationDigest);
    assert.equal(result.responseDigest, f.responseDigest); assert.equal(result.requestObjectDigest, f.requestObjectDigest);
    assert(!JSON.stringify(result).includes('private fixture')); assert(JSON.stringify(result).length < 2048);
    await f.build().observe(response); await f.build().observe(dispatch); assert.equal(f.readCount(), reads, 'Exact replay never rereads or redispatches a model');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM model_call_facts').get()?.count, 2);
    assert.deepEqual(f.db.prepare('SELECT * FROM reservations').all(), before, 'No refund or settlement mutation');
  } finally { f.db.close(); }
});

test('all sixteen legacy dispatched calls remain explicitly unindexed without fabricated terminal observations', async () => {
  const f = fixture({ legacy: true }); try {
    for (let index = 1; index < 16; index++) { const id = 'aaaaaaaa-aaaa-4aaa-8aaa-' + index.toString(16).padStart(12, '0'); const reservation = { ...f.reservation, callId: id };
      f.db.prepare('INSERT INTO reservations(id,owner,maximum,state,payload) VALUES(?,?,?,?,?)').run(id, reservation.attemptId, '100000', 'DISPATCHED', canonicalize(reservation)); }
    const rows = f.db.prepare('SELECT * FROM reservations').all();
    for (const row of rows) { const result = f.index.outcome(String(row.id)); assert.equal(result.state, 'LEGACY_UNINDEXED'); assert.equal(result.usage, null); assert.equal(result.responseObservationDigest, null); }
    await assert.rejects(f.index.observe(f.fact('RESPONSE')), fails('LEGACY_MODEL_CALL_UNINDEXED'));
    assert.equal(f.readCount(), 0); assert.deepEqual(f.db.prepare('SELECT * FROM reservations').all(), rows);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM model_calls').get()?.count, 0);
  } finally { f.db.close(); }
});

test('scope, reservation, attempt and generation mismatches fail before any object read', async () => {
  const f = fixture(); try {
    const valid = f.fact('RESPONSE');
    for (const patch of [{ scope: { ...scope, projectIncarnation: 'foreign' } }, { attemptId: 'foreign' }, { generation: '2' }, { callId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }]) {
      await assert.rejects(f.index.observe({ ...valid, ...patch }), error => error instanceof PlatformError && error.status === 409);
    }
    assert.equal(f.readCount(), 0);
  } finally { f.db.close(); }
});

test('content-addressed envelope, normalized request and independently parsed provider response must all agree', async () => {
  for (const scenario of ['bytes', 'request', 'response-identity', 'declared-usage', 'extra-field'] as const) {
    const f = fixture(); try {
      let fact: ModelCallFact;
      if (scenario === 'bytes') { fact = f.fact('RESPONSE'); f.bytes.set(fact.observationDigest, encode({ different: 'bytes' })); }
      else if (scenario === 'request') { const altered = f.retain({ ...f.request, messages: [{ role: 'user', content: 'other intent' }] }); fact = f.fact('RESPONSE', { ...f.retainedResponse, requestDigest: altered }); }
      else if (scenario === 'response-identity') fact = f.fact('RESPONSE', { ...f.retainedResponse, responseId: 'invented-id' });
      else if (scenario === 'declared-usage') fact = f.fact('RESPONSE', { ...f.retainedResponse, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      else fact = f.fact('RESPONSE', { ...f.retainedResponse, candidateClaim: 'untrusted' });
      await assert.rejects(f.index.observe(fact), error => error instanceof PlatformError && error.status === 409, scenario);
      assert.equal(f.index.outcome(callId).state, 'RESERVATION_ONLY'); assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM model_call_facts').get()?.count, 0);
    } finally { f.db.close(); }
  }
});

test('conflicting immutable phase replay cannot replace a verified outcome', async () => {
  const f = fixture(); try {
    const valid = f.fact('RESPONSE'); await f.index.observe(valid); const result = f.index.outcome(callId), reads = f.readCount();
    await assert.rejects(f.index.observe(f.fact('RESPONSE', { ...f.retainedResponse, responseId: 'different' })), fails('MODEL_CALL_FACT_CONFLICT'));
    assert.equal(f.readCount(), reads); assert.deepEqual(f.index.outcome(callId), result);
    await assert.rejects(f.index.observe({ ...valid, phase: 'OTHER' as 'RESPONSE' }), fails('MODEL_CALL_FACT_INVALID'));
  } finally { f.db.close(); }
});

test('missing or invalid provider usage and external routes stay unpriced and explicitly uncertain', async () => {
  for (const [options, expected] of [[{ missingUsage: true }, 'MISSING'], [{ invalidUsage: true }, 'INVALID'], [{ external: true }, 'UNVERIFIED_ROUTE']] as const) {
    const f = fixture(options); try { await f.index.observe(f.fact('RESPONSE')); const result = f.index.outcome(callId); assert.equal(result.state, 'RESPONSE_RETAINED'); assert.equal(result.usageStatus, expected); assert.equal(result.usage, null); }
    finally { f.db.close(); }
  }
});

test('a changed incarnation during an R2 yield prevents retaining a formerly scoped observation', async () => {
  const f = fixture(); try { f.hook(async () => { f.changeScope(); }); await assert.rejects(f.index.observe(f.fact('RESPONSE')), fails('PROJECT_INCAR_CHANGED')); assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM model_call_facts').get()?.count, 0); }
  finally { f.db.close(); }
});

test('model index deadline never commits a late object continuation', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const f = fixture(); let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { entered = resolve; });
  f.hook(() => new Promise<void>(resolve => { release = resolve; entered(); }));
  try {
    const rejected = assert.rejects(f.index.observe(f.fact('RESPONSE')), fails('MODEL_CALL_INDEX_DEADLINE'));
    await barrier; context.mock.timers.tick(20000); await rejected; release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.readCount(), 1); assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM model_call_facts').get()?.count, 0);
  } finally { f.db.close(); }
});
