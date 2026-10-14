// SPDX-License-Identifier: Apache-2.0
import type { Scope } from '../../packages/protocol/src/types';
import { requireValue } from './errors';

export const MODEL_CALL_FACT_BYTES = 2048;
export const MODEL_CALL_PAGE_BYTES = 128 * 1024;
export const MODEL_CALL_PAGE_LIMIT = 100;
export interface ModelCallFact {
  schemaVersion: 1; scope: Scope; attemptId: string; generation: string; callId: string;
  phase: 'DISPATCH' | 'RESPONSE'; observationDigest: string;
}
export const modelCallObservationKeys = (phase: ModelCallFact['phase']): string[] => (phase === 'DISPATCH'
  ? ['scope','attemptId','generation','callId','requestDigest','providerKind','requestedModel','reasoningEffort','producer','state','maximumReservedCost']
  : ['scope','attemptId','generation','callId','requestDigest','responseDigest','providerKind','requestedModel','reportedModel','responseId','usage','producer','outcome','maximumReservedCost']).sort();
export interface ModelCallUsage {
  prompt_tokens: number; completion_tokens: number; total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number }; neurons_decimal?: string;
}
export interface ModelCallOutcome {
  schemaVersion: 1;
  state: 'LEGACY_UNINDEXED' | 'RESERVATION_ONLY' | 'MAY_HAVE_DISPATCHED' | 'RESPONSE_RETAINED';
  dispatchObservationDigest: string | null; responseObservationDigest: string | null;
  requestObjectDigest: string | null; responseDigest: string | null;
  providerKind: 'workers-ai' | 'openai-compatible' | null;
  requestedModel: string | null; reportedModel: string | null; responseId: string | null;
  usage: ModelCallUsage | null; usageStatus: 'VERIFIED' | 'MISSING' | 'INVALID' | 'UNVERIFIED_ROUTE';
  observedAt: number | null;
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
export function validateModelCallFact(value: unknown): asserts value is ModelCallFact {
  requireValue(record(value) && Object.keys(value).sort().join(',') === 'attemptId,callId,generation,observationDigest,phase,schemaVersion,scope'
    && value.schemaVersion === 1 && identifier(value.attemptId) && typeof value.callId === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.callId)
    && typeof value.generation === 'string' && /^[1-9][0-9]{0,19}$/.test(value.generation) && BigInt(value.generation) <= 18446744073709551615n
    && ['DISPATCH', 'RESPONSE'].includes(String(value.phase)) && typeof value.observationDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.observationDigest)
    && record(value.scope) && Object.keys(value.scope).sort().join(',') === 'projectId,projectIncarnation,schemaVersion,tenantId'
    && value.scope.schemaVersion === 1 && identifier(value.scope.tenantId) && identifier(value.scope.projectId) && identifier(value.scope.projectIncarnation)
    && new TextEncoder().encode(JSON.stringify(value)).length <= MODEL_CALL_FACT_BYTES, 'MODEL_CALL_FACT_INVALID', 400);
}
export function verifiedModelCallUsage(value: ModelCallUsage | null): boolean {
  return value !== null && [value.prompt_tokens, value.completion_tokens, value.total_tokens].every(x => Number.isSafeInteger(x) && x >= 0)
    && Number.isSafeInteger(value.prompt_tokens + value.completion_tokens) && value.total_tokens === value.prompt_tokens + value.completion_tokens
    && (value.prompt_tokens_details === undefined || Number.isSafeInteger(value.prompt_tokens_details.cached_tokens)
      && value.prompt_tokens_details.cached_tokens >= 0 && value.prompt_tokens_details.cached_tokens <= value.prompt_tokens);
}
