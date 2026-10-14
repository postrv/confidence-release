// SPDX-License-Identifier: Apache-2.0
import { canonicalize, digest, getKernel } from '../../packages/protocol/src/index';
import type { Scope } from '../../packages/protocol/src/types';
import { digestBytes, requireValue } from '../shared/errors';
import { withinDeadline } from '../shared/deadline';
import { normalizeModelRequest, workersAiReasoningEffort, workersAiResponseIdentity } from '../runner/model-policy';
import { MODEL_RESPONSE_BYTES } from '../runner/model-response-stream';
import { modelCallObservationKeys, validateModelCallFact, verifiedModelCallUsage, type ModelCallFact, type ModelCallOutcome } from '../shared/model-call';
import type { ObjectStore } from '../shared/objects';

interface Reservation { scope: Scope; callId: string; attemptId: string; generation: string; requestDigest: string; maximumCost: string }
type Metadata = Omit<ModelCallOutcome, 'schemaVersion' | 'state' | 'dispatchObservationDigest' | 'responseObservationDigest' | 'observedAt'>;
const empty: Metadata = { requestObjectDigest: null, responseDigest: null, providerKind: null, requestedModel: null, reportedModel: null, responseId: null, usage: null, usageStatus: 'MISSING' };
const decode = (raw: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(raw);
const boundedText = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** Immutable linked metadata only. Reservation ceilings and settled amounts never change here. */
export class ModelCallIndex {
  constructor(private readonly sql: SqlStorage, private readonly objects: Pick<ObjectStore, 'get'>, private readonly currentScope: () => Scope) {}
  register(callId: string): void { this.sql.exec('INSERT INTO model_calls(call_id,created_at_ms) VALUES(?,?)', callId, Date.now()); }
  private reservation(fact: ModelCallFact): Reservation {
    requireValue(canonicalize(this.currentScope()) === canonicalize(fact.scope), 'PROJECT_INCAR_CHANGED', 409);
    const row = this.sql.exec<{ owner: string; maximum: string; payload: string }>('SELECT owner,maximum,payload FROM reservations WHERE id=?', fact.callId).toArray()[0];
    requireValue(row, 'MODEL_CALL_RESERVATION_MISSING', 409);
    const value = JSON.parse(row.payload) as Reservation;
    requireValue(value.callId === fact.callId && row.owner === fact.attemptId && value.attemptId === fact.attemptId && value.generation === fact.generation
      && row.maximum === value.maximumCost && canonicalize(value.scope) === canonicalize(fact.scope), 'MODEL_CALL_RESERVATION_MISMATCH', 409);
    requireValue(this.sql.exec('SELECT call_id FROM model_calls WHERE call_id=?', fact.callId).toArray().length === 1, 'LEGACY_MODEL_CALL_UNINDEXED', 409);
    return value;
  }
  outcome(callId: string): ModelCallOutcome {
    const indexed = this.sql.exec('SELECT call_id FROM model_calls WHERE call_id=?', callId).toArray().length === 1;
    const facts = this.sql.exec<{ phase: string; observation_digest: string; payload: string; observed_at_ms: number }>('SELECT phase,observation_digest,payload,observed_at_ms FROM model_call_facts WHERE call_id=? ORDER BY phase', callId).toArray();
    const dispatch = facts.find(x => x.phase === 'DISPATCH'), response = facts.find(x => x.phase === 'RESPONSE'), latest = response ?? dispatch;
    return { schemaVersion: 1, ...empty, ...(latest ? JSON.parse(latest.payload) as Metadata : {}),
      state: response ? 'RESPONSE_RETAINED' : dispatch ? 'MAY_HAVE_DISPATCHED' : indexed ? 'RESERVATION_ONLY' : 'LEGACY_UNINDEXED',
      dispatchObservationDigest: dispatch?.observation_digest ?? null, responseObservationDigest: response?.observation_digest ?? null, observedAt: latest?.observed_at_ms ?? null };
  }
  async observe(fact: ModelCallFact): Promise<{ state: 'MODEL_CALL_FACT_RETAINED' }> {
    validateModelCallFact(fact);
    const reservation = this.reservation(fact);
    const prior = this.sql.exec<{ observation_digest: string }>('SELECT observation_digest FROM model_call_facts WHERE call_id=? AND phase=?', fact.callId, fact.phase).toArray()[0];
    if (prior) { requireValue(prior.observation_digest === fact.observationDigest, 'MODEL_CALL_FACT_CONFLICT', 409); return { state: 'MODEL_CALL_FACT_RETAINED' }; }
    const expires = Date.now() + 20000; let closed = false;
    const check = () => { requireValue(!closed && Date.now() < expires, 'MODEL_CALL_INDEX_DEADLINE', 503); this.reservation(fact); };
    const read = async (contentDigest: string, maximum: number) => {
      check(); const bytes = await this.objects.get(contentDigest, maximum); check();
      requireValue(bytes.length <= maximum && await digestBytes(bytes) === contentDigest, 'MODEL_CALL_OBJECT_MISMATCH', 409); check(); return bytes;
    };
    try { return await withinDeadline(async () => {
      const envelopeRaw = await read(fact.observationDigest, 16384); const envelopeText = decode(envelopeRaw);
      const envelope = JSON.parse(getKernel().canonical_json(envelopeText)) as Record<string, unknown>;
      requireValue(object(envelope) && Object.keys(envelope).sort().join(',') === modelCallObservationKeys(fact.phase).join(',') && object(envelope.scope) && envelopeText === canonicalize(envelope) && envelope.producer === 'broker-observed' && envelope.callId === fact.callId
        && envelope.attemptId === fact.attemptId && envelope.generation === fact.generation && canonicalize(envelope.scope) === canonicalize(fact.scope)
        && envelope.maximumReservedCost === reservation.maximumCost && ['workers-ai', 'openai-compatible'].includes(String(envelope.providerKind))
        && boundedText(envelope.requestedModel, 160), 'MODEL_CALL_OBSERVATION_MISMATCH', 409);
      const providerKind = envelope.providerKind as 'workers-ai' | 'openai-compatible';
      const requestObjectDigest = envelope.requestDigest as string;
      requireValue(/^sha256:[a-f0-9]{64}$/.test(requestObjectDigest), 'MODEL_CALL_OBSERVATION_MISMATCH', 409);
      const requestRaw = await read(requestObjectDigest, 192 * 1024), requestText = decode(requestRaw);
      const request = JSON.parse(getKernel().canonical_json(requestText)) as Record<string, unknown>;
      requireValue(object(request) && requestText === canonicalize(request) && request.model === envelope.requestedModel, 'MODEL_CALL_REQUEST_MISMATCH', 409);
      const { reasoning_effort: effort, ...submitted } = request;
      const workersAi = providerKind === 'workers-ai';
      const expectedEffort = workersAi ? workersAiReasoningEffort(String(request.model)) : undefined;
      requireValue(effort === expectedEffort, 'MODEL_CALL_REQUEST_MISMATCH', 409);
      const outputField = workersAi || request.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens';
      requireValue(canonicalize(normalizeModelRequest(submitted, String(request.model), outputField, expectedEffort).request) === requestText
        && await digest({ providerKind, request }) === reservation.requestDigest, 'MODEL_CALL_REQUEST_MISMATCH', 409); check();
      const metadata: Metadata = { ...empty, requestObjectDigest, providerKind, requestedModel: String(request.model) };
      if (fact.phase === 'DISPATCH') {
        requireValue(envelope.state === 'MAY_HAVE_DISPATCHED' && envelope.outcome === undefined && envelope.reasoningEffort === (expectedEffort ?? null), 'MODEL_CALL_OBSERVATION_MISMATCH', 409);
      } else {
        requireValue(envelope.outcome === 'RESPONSE' && envelope.state === undefined && typeof envelope.responseDigest === 'string'
          && /^sha256:[a-f0-9]{64}$/.test(envelope.responseDigest), 'MODEL_CALL_OBSERVATION_MISMATCH', 409);
        metadata.responseDigest = envelope.responseDigest;
        const responseRaw = await read(envelope.responseDigest, MODEL_RESPONSE_BYTES);
        if (workersAi) {
          const identity = workersAiResponseIdentity(responseRaw, String(request.model));
          requireValue(boundedText(identity.reportedModel, 160) && boundedText(identity.responseId, 256)
            && canonicalize(identity.usage) === canonicalize(envelope.usage) && identity.reportedModel === envelope.reportedModel
            && identity.responseId === envelope.responseId, 'MODEL_CALL_RESPONSE_MISMATCH', 409);
          metadata.reportedModel = identity.reportedModel; metadata.responseId = identity.responseId;
          metadata.usageStatus = identity.usage === null ? 'MISSING' : verifiedModelCallUsage(identity.usage) ? 'VERIFIED' : 'INVALID';
          metadata.usage = metadata.usageStatus === 'VERIFIED' ? identity.usage : null;
        } else {
          // The existing external adapter does not attest provider-specific identity/usage.
          requireValue(envelope.reportedModel === null && envelope.responseId === null && envelope.usage === null, 'MODEL_CALL_RESPONSE_MISMATCH', 409);
          metadata.usageStatus = 'UNVERIFIED_ROUTE';
        }
      }
      check();
      const existing = this.sql.exec<{ observation_digest: string }>('SELECT observation_digest FROM model_call_facts WHERE call_id=? AND phase=?', fact.callId, fact.phase).toArray()[0];
      if (existing) requireValue(existing.observation_digest === fact.observationDigest, 'MODEL_CALL_FACT_CONFLICT', 409);
      else this.sql.exec('INSERT INTO model_call_facts(call_id,phase,observation_digest,payload,observed_at_ms) VALUES(?,?,?,?,?)', fact.callId, fact.phase, fact.observationDigest, canonicalize(metadata), Date.now());
      return { state: 'MODEL_CALL_FACT_RETAINED' as const };
    }, 20000, 'MODEL_CALL_INDEX_DEADLINE'); } finally { closed = true; }
  }
}
