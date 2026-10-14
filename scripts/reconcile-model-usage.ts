// SPDX-License-Identifier: Apache-2.0
/** Read-only, bounded operator inventory of retained broker-observed Workers AI calls. */
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from '../packages/protocol/src/index.ts';
import { selectWranglerCredential } from './provider-preflight.ts';

const API = 'https://api.cloudflare.com/client/v4';
const PRICE_SOURCE = 'https://developers.cloudflare.com/workers-ai/platform/pricing/';
// Cloudflare's 2026-10-01 pricing page. Rates are integer nano-USD per token.
const MODEL_POLICIES = [
  { model: '@cf/zai-org/glm-5.3', reasoningEffort: 'low', observedOn: '2026-10-07',
    rate: { ordinaryInput: 1400n, cachedInput: 260n, output: 4400n },
    perMillion: { ordinaryInput: '1.40', cachedInput: '0.26', output: '4.40' } },
  { model: '@cf/deepseek-ai/deepseek-v4-flash-0731', reasoningEffort: 'none', observedOn: '2026-10-08',
    rate: { ordinaryInput: 440n, cachedInput: 14n, output: 1320n },
    perMillion: { ordinaryInput: '0.44', cachedInput: '0.014', output: '1.32' } }
] as const;
type ModelPolicy = (typeof MODEL_POLICIES)[number];
const modelPolicy = (model: unknown): ModelPolicy | undefined => MODEL_POLICIES.find(item => item.model === model);
const DEFAULT_LIMITS = { objects: 5000, pages: 20, pageSize: 500, envelopeBytes: 128 * 1024, linkedBytes: 524288, totalBytes: 64 * 1024 * 1024 } as const;
type Json = Record<string, unknown>;
type Scope = { schemaVersion: 1; tenantId: string; projectId: string; projectIncarnation: string };
type Attempt = { id: string; generation: string };
type ModelReservation = { callId: string; attemptId: string; generation: string; requestDigest: string; maximumCost: string; state: string;
  outcome?: { schemaVersion: 1; state: string; providerKind: string | null; dispatchObservationDigest: string | null; responseObservationDigest: string | null } };
type Snapshot = { project: { scope: Scope; revision: string; maximumBudget: string; reservedBudget: string; settledBudget: string };
  attempts: Attempt[]; modelCalls: { limit: number; overflow: boolean; reservations: ModelReservation[] } };
type Limits = { objects: number; pages: number; pageSize: number; envelopeBytes: number; linkedBytes: number; totalBytes: number };
type WorkersAiUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokens_details?: { cached_tokens: number }; neurons_decimal?: string };
type Observation = { digest: string; callId: string; attemptId: string; generation: string; requestDigest: string; responseDigest?: string; state?: string; outcome?: string; providerKind: string; requestedModel: string; reasoningEffort?: string; reportedModel?: string | null; responseId?: string | null; usage?: WorkersAiUsage | null; maximumReservedCost: string };
type UsageTotals = { promptTokens: number; completionTokens: number; cachedInputTokens: number | null };
type CallReport = { callId: string; state: 'VERIFIED_RESPONSE' | 'UNCERTAIN_DISPATCH' | 'ORPHAN_RESPONSE' | 'CONFLICT' | 'UNVERIFIED_RESPONSE' | 'UNOBSERVED_RESERVATION' | 'UNRESERVED_OBSERVATION'; observationDigests: string[]; requestDigest: string | null; responseDigest: string | null; requestedModel: string | null; reasoningEffort: string | null; maximumReservedCostMicroUnits: string; usage: UsageTotals | null; observedResponseEstimateUsd: string | null; uncertainty: string[] };
type Coverage = 'COMPLETE' | 'INCOMPLETE' | 'ROSTER_OVERFLOW';
type AttemptReport = { attemptId: string; generation: string; observedCallCount: number; verifiedResponseCount: number; uncertainCallCount: number; unobservedCallCount: number | null; callCoverage: Coverage; observedUsage: UsageTotals; observedResponseEstimateUsd: string; estimatedTotalUsd: string | null; calls: CallReport[] };
export type UsageReport = { schemaVersion: 2; status: 'COMPLETE_ESTIMATE' | 'OBSERVED_PARTIAL'; generatedAt: string; accountId: string; bucketName: string; projectId: string; projectIncarnation: string; authorityRevision: string; snapshotDigest: string; protocolBudgetMicroUnits: { maximum: string; reserved: string; settled: string; meaning: string }; price: { source: string; sourceUpdatedOn: string; currency: 'USD'; models: { model: string; observedOn: string; perMillion: { ordinaryInput: string; cachedInput: string; output: string } }[]; meaning: string }; inventory: { mode: 'BUCKET_DISCOVERY' | 'PROJECT_INDEX_LINKS'; prefix: string; listedObjects: number; inspectedObjects: number; skippedLargeObjects: number; pages: number; bytesRead: number; complete: boolean; issues: string[] }; modelCalls: { limit: number; listedReservations: number; overflow: boolean; callCoverage: Coverage; unobservedCallCount: number | null }; attempts: AttemptReport[]; unmatchedObservationDigests: string[]; observedUsage: UsageTotals; observedResponseEstimateUsd: string; estimatedTotalUsd: string | null; limitations: string[]; remoteMutations: 0 };
type Options = { snapshot: unknown; snapshotBytes: Uint8Array; accountId: string; bucketName: string; token: string; fetcher?: typeof fetch; now?: string; limits?: Partial<Limits> };
const sha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const utf8 = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const objectKey = (digest: string): string => { ensure(/^sha256:[0-9a-f]{64}$/.test(digest), 'INVALID_OBJECT_DIGEST'); return `objects/sha256/${digest.slice(7)}`; };
function ensure(value: unknown, code: string): asserts value { if (!value) throw Error(code); }
const record = (value: unknown): value is Json => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const safeCounter = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value);
const price = (nanoUsd: bigint): string => `${nanoUsd / 1_000_000_000n}.${(nanoUsd % 1_000_000_000n).toString().padStart(9, '0')}`;
const sumUsage = (a: UsageTotals, b: UsageTotals): UsageTotals => ({ promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens,
  cachedInputTokens: a.cachedInputTokens === null || b.cachedInputTokens === null ? null : a.cachedInputTokens + b.cachedInputTokens });
const emptyUsage = (): UsageTotals => ({ promptTokens: 0, completionTokens: 0, cachedInputTokens: 0 });
function usageTotals(value: WorkersAiUsage | null | undefined): UsageTotals | null {
  if (!value) return null;
  const cached = value.prompt_tokens_details?.cached_tokens ?? null;
  if (!Number.isSafeInteger(value.prompt_tokens) || !Number.isSafeInteger(value.completion_tokens) || !Number.isSafeInteger(value.total_tokens)
    || value.prompt_tokens < 0 || value.completion_tokens < 0 || value.total_tokens !== value.prompt_tokens + value.completion_tokens
    || cached !== null && (!Number.isSafeInteger(cached) || cached < 0 || cached > value.prompt_tokens)) return null;
  return { promptTokens: value.prompt_tokens, completionTokens: value.completion_tokens, cachedInputTokens: cached };
}
function responseIdentity(raw: Uint8Array, policy: ModelPolicy): { reportedModel: string; responseId: string; usage: WorkersAiUsage | null } {
  const value = JSON.parse(utf8(raw)) as unknown;
  ensure(record(value) && value.model === policy.model && typeof value.id === 'string' && value.id.length > 0
    && Array.isArray(value.choices) && value.choices.length === 1, 'MODEL_RESPONSE_IDENTITY_MISMATCH');
  const choice = value.choices[0];
  ensure(record(choice) && record(choice.message) && typeof choice.message.content === 'string', 'MODEL_RESPONSE_SHAPE_INVALID');
  const responseUsage = value.usage;
  if (responseUsage === null || responseUsage === undefined) return { reportedModel: policy.model, responseId: value.id, usage: null };
  ensure(record(responseUsage) && Number.isSafeInteger(responseUsage.prompt_tokens) && Number.isSafeInteger(responseUsage.completion_tokens)
    && Number.isSafeInteger(responseUsage.total_tokens), 'MODEL_USAGE_INVALID');
  const usage: WorkersAiUsage = { prompt_tokens: Number(responseUsage.prompt_tokens), completion_tokens: Number(responseUsage.completion_tokens), total_tokens: Number(responseUsage.total_tokens) };
  if (responseUsage.prompt_tokens_details !== null && responseUsage.prompt_tokens_details !== undefined) {
    ensure(record(responseUsage.prompt_tokens_details) && Number.isSafeInteger(responseUsage.prompt_tokens_details.cached_tokens), 'MODEL_USAGE_INVALID');
    usage.prompt_tokens_details = { cached_tokens: Number(responseUsage.prompt_tokens_details.cached_tokens) };
  }
  if (responseUsage.neurons !== null && responseUsage.neurons !== undefined) {
    ensure(typeof responseUsage.neurons === 'number' && Number.isFinite(responseUsage.neurons) && responseUsage.neurons >= 0, 'MODEL_USAGE_INVALID');
    usage.neurons_decimal = String(responseUsage.neurons);
  }
  return { reportedModel: policy.model, responseId: value.id, usage };
}
function requestIdentity(raw: Uint8Array, policy: ModelPolicy): Json {
  const value = JSON.parse(utf8(raw)) as unknown;
  ensure(record(value) && utf8(raw) === canonicalize(value) && value.model === policy.model && value.reasoning_effort === policy.reasoningEffort
    && value.stream === false && value.store === false && Number.isSafeInteger(value.max_completion_tokens)
    && Number(value.max_completion_tokens) > 0 && Number(value.max_completion_tokens) <= 8192
    && Array.isArray(value.messages) && value.messages.length > 0 && value.messages.length <= 32, 'MODEL_REQUEST_IDENTITY_MISMATCH');
  return value;
}
function estimatedNanoUsd(usage: UsageTotals & { cachedInputTokens: number }, policy: ModelPolicy): bigint {
  return BigInt(usage.promptTokens - usage.cachedInputTokens) * policy.rate.ordinaryInput
    + BigInt(usage.cachedInputTokens) * policy.rate.cachedInput + BigInt(usage.completionTokens) * policy.rate.output;
}
function validIndexReference(value: unknown): boolean {
  return record(value) && value.schemaVersion === 1
    && ['LEGACY_UNINDEXED', 'RESERVATION_ONLY', 'MAY_HAVE_DISPATCHED', 'RESPONSE_RETAINED'].includes(String(value.state))
    && (value.providerKind === null || ['workers-ai','openai-compatible'].includes(String(value.providerKind)))
    && ['dispatchObservationDigest','responseObservationDigest'].every(key => value[key] === null || typeof value[key] === 'string' && /^sha256:[0-9a-f]{64}$/.test(value[key] as string));
}
function validSnapshot(value: unknown): Snapshot {
  ensure(record(value) && record(value.project) && record(value.project.scope) && Array.isArray(value.attempts)
    && record(value.modelCalls) && Array.isArray(value.modelCalls.reservations), 'AUTHORITY_SNAPSHOT_SCHEMA');
  const scope = value.project.scope;
  ensure(scope.schemaVersion === 1 && typeof scope.tenantId === 'string' && typeof scope.projectId === 'string'
    && typeof scope.projectIncarnation === 'string' && scope.projectIncarnation.length > 0, 'AUTHORITY_SCOPE_SCHEMA');
  ensure(safeCounter(value.project.revision) && safeCounter(value.project.maximumBudget)
    && safeCounter(value.project.reservedBudget) && safeCounter(value.project.settledBudget), 'AUTHORITY_BUDGET_SCHEMA');
  ensure(value.attempts.every(item => record(item) && typeof item.id === 'string' && item.id.length > 0 && safeCounter(item.generation)), 'AUTHORITY_ATTEMPTS_SCHEMA');
  ensure(new Set(value.attempts.map(item => (item as Attempt).id)).size === value.attempts.length, 'AUTHORITY_ATTEMPTS_DUPLICATE');
  const roster = value.modelCalls;
  const reservations = roster.reservations as unknown[];
  ensure(Number.isSafeInteger(roster.limit) && Number(roster.limit) > 0 && Number(roster.limit) <= 2048
    && typeof roster.overflow === 'boolean' && reservations.length <= Number(roster.limit), 'AUTHORITY_MODEL_ROSTER_BOUND');
  ensure(reservations.every(item => record(item) && typeof item.callId === 'string' && /^[0-9a-f-]{36}$/.test(item.callId)
    && typeof item.attemptId === 'string' && typeof item.generation === 'string' && safeCounter(item.generation)
    && typeof item.requestDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(item.requestDigest)
    && safeCounter(item.maximumCost) && BigInt(item.maximumCost) > 0n && typeof item.state === 'string'
    && ['DISPATCHED', 'SETTLED'].includes(item.state)
    && (item.outcome === undefined || validIndexReference(item.outcome))), 'AUTHORITY_MODEL_ROSTER_SCHEMA');
  ensure(new Set(reservations.map(item => (item as ModelReservation).callId)).size === reservations.length, 'AUTHORITY_MODEL_ROSTER_DUPLICATE');
  const attempts = new Map(value.attempts.map(item => [(item as Attempt).id, (item as Attempt).generation]));
  ensure(reservations.every(item => attempts.get((item as ModelReservation).attemptId) === (item as ModelReservation).generation), 'AUTHORITY_ATTEMPT_ROSTER_INCOMPLETE');
  return value as unknown as Snapshot;
}
function boundLimits(input: Partial<Limits> | undefined): Limits {
  const limits = { ...DEFAULT_LIMITS, ...input } as Limits;
  for (const [key, maximum] of Object.entries(DEFAULT_LIMITS)) ensure(Number.isSafeInteger(limits[key as keyof Limits]) && limits[key as keyof Limits] > 0 && limits[key as keyof Limits] <= maximum, 'SCAN_LIMIT_INVALID');
  ensure(limits.pageSize <= limits.objects, 'SCAN_PAGE_LIMIT_INVALID');
  return limits;
}
async function bytes(response: Response, maximum: number): Promise<Uint8Array> {
  ensure(response.body, 'R2_BODY_MISSING');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let count = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; count += next.value.byteLength; ensure(count <= maximum, 'R2_BODY_LIMIT'); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return new Uint8Array(Buffer.concat(chunks));
}
function classifyEnvelope(raw: Uint8Array, digest: string, targetScope: Scope): Observation | null {
  let parsed: unknown;
  try { parsed = JSON.parse(utf8(raw)); } catch { return null; }
  if (!record(parsed) || parsed.producer !== 'broker-observed') return null;
  ensure(utf8(raw) === canonicalize(parsed), 'BROKER_ENVELOPE_NONCANONICAL');
  ensure(record(parsed.scope) && parsed.scope.schemaVersion === 1 && typeof parsed.scope.tenantId === 'string'
    && typeof parsed.scope.projectId === 'string' && typeof parsed.scope.projectIncarnation === 'string', 'BROKER_SCOPE_SCHEMA');
  if (canonicalize(parsed.scope) !== canonicalize(targetScope)) return null;
  ensure(typeof parsed.callId === 'string' && /^[0-9a-f-]{36}$/.test(parsed.callId)
    && typeof parsed.attemptId === 'string' && typeof parsed.generation === 'string'
    && /^sha256:[0-9a-f]{64}$/.test(String(parsed.requestDigest))
    && (parsed.state === 'MAY_HAVE_DISPATCHED') !== (parsed.outcome === 'RESPONSE')
    && parsed.providerKind === 'workers-ai' && modelPolicy(parsed.requestedModel)
    && safeCounter(parsed.maximumReservedCost), 'BROKER_ENVELOPE_SCHEMA');
  if (parsed.state === 'MAY_HAVE_DISPATCHED') ensure(parsed.reasoningEffort === modelPolicy(parsed.requestedModel)!.reasoningEffort, 'BROKER_REASONING_EFFORT_MISMATCH');
  if (parsed.outcome === 'RESPONSE') ensure(/^sha256:[0-9a-f]{64}$/.test(String(parsed.responseDigest)), 'BROKER_RESPONSE_DIGEST_SCHEMA');
  return { ...parsed, digest } as Observation;
}

/** A total is available only when every authority reservation has verified provider usage. */
export async function reconcileModelUsage(options: Options): Promise<UsageReport> {
  const snapshot = validSnapshot(options.snapshot), limits = boundLimits(options.limits);
  ensure(/^[0-9a-f]{32}$/.test(options.accountId) && /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(options.bucketName), 'R2_TARGET_INVALID');
  ensure(typeof options.token === 'string' && options.token.length >= 16 && !/[\s\x00-\x1f\x7f]/.test(options.token), 'R2_CREDENTIAL_INVALID');
  ensure(options.snapshotBytes.byteLength <= 8 * 1024 * 1024 && options.snapshotBytes.byteLength > 0
    && JSON.stringify(options.snapshot) === JSON.stringify(JSON.parse(utf8(options.snapshotBytes))), 'AUTHORITY_SNAPSHOT_BYTES_INVALID');
  const fetcher = options.fetcher ?? fetch;
  const prefix = 'objects/sha256/';
  const indexed = snapshot.modelCalls.reservations.length > 0 && snapshot.modelCalls.reservations.every(call => call.outcome && call.outcome.state !== 'LEGACY_UNINDEXED');
  const inventory = { mode: indexed ? 'PROJECT_INDEX_LINKS' as const : 'BUCKET_DISCOVERY' as const, prefix, listedObjects: 0, inspectedObjects: 0, skippedLargeObjects: 0, pages: 0, bytesRead: 0, complete: false, issues: [] as string[] };
  const groups = new Map<string, { start: Observation[]; response: Observation[] }>();
  const unmatched: string[] = [];
  const attemptById = new Map(snapshot.attempts.map(item => [item.id, item]));
  const headers = { authorization: `Bearer ${options.token}` };
  const endpoint = `${API}/accounts/${options.accountId}/r2/buckets/${options.bucketName}/objects`;
  async function get(path: string, limit: number): Promise<Uint8Array> {
    ensure(inventory.bytesRead + limit <= limits.totalBytes, 'SCAN_TOTAL_BYTES_LIMIT');
    const response = await fetcher(path, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
    ensure(response.status === 200, 'R2_GET_UNAVAILABLE');
    const body = await bytes(response, limit); inventory.bytesRead += body.byteLength; return body;
  }
  async function linked(digest: string, maximum: number): Promise<Uint8Array> {
    const body = await get(`${endpoint}/${objectKey(digest)}`, maximum);
    ensure(sha(body) === digest, 'R2_LINKED_DIGEST_MISMATCH'); return body;
  }
  const collect = (body: Uint8Array, digest: string, expectedCallId?: string) => {
    const observation = classifyEnvelope(body, digest, snapshot.project.scope);
    if (expectedCallId) ensure(observation?.callId === expectedCallId, 'INDEXED_CALL_IDENTITY_MISMATCH');
    if (!observation) return;
    if (attemptById.get(observation.attemptId)?.generation !== observation.generation) { unmatched.push(digest); return; }
    const group = groups.get(observation.callId) ?? { start: [], response: [] };
    (observation.state === 'MAY_HAVE_DISPATCHED' ? group.start : group.response).push(observation);
    groups.set(observation.callId, group);
  };
  if (indexed) {
    for (const call of snapshot.modelCalls.reservations) {
      const outcome = call.outcome!;
      if (outcome.providerKind !== null && outcome.providerKind !== 'workers-ai') { inventory.issues.push('INDEXED_PROVIDER_ROUTE_UNSUPPORTED'); continue; }
      for (const reference of [outcome.dispatchObservationDigest, outcome.responseObservationDigest]) {
        if (!reference) continue;
        if (inventory.listedObjects >= limits.objects) { inventory.issues.push('SCAN_LIMIT_REACHED'); break; }
        inventory.listedObjects++;
        try { const body = await linked(reference, limits.envelopeBytes); inventory.inspectedObjects++; collect(body, reference, call.callId); }
        catch { inventory.issues.push('INDEXED_LINK_UNVERIFIED'); }
      }
    }
    inventory.complete = inventory.issues.length === 0;
  }
  let cursor: string | null = null; const seenCursors = new Set<string>(), seenKeys = new Set<string>();
  while (!indexed && inventory.pages < limits.pages && inventory.listedObjects < limits.objects) {
    if (inventory.bytesRead + 2 * 1024 * 1024 > limits.totalBytes) { inventory.issues.push('SCAN_TOTAL_BYTES_LIMIT'); break; }
    const url = new URL(endpoint); url.searchParams.set('prefix', prefix); url.searchParams.set('per_page', String(Math.min(limits.pageSize, limits.objects - inventory.listedObjects)));
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = JSON.parse(utf8(await get(url.href, 2 * 1024 * 1024))) as unknown;
    // Cloudflare omits result_info altogether when the final page fits.
    ensure(record(page) && page.success === true && Array.isArray(page.result)
      && (page.result_info === undefined || record(page.result_info) && typeof page.result_info.is_truncated === 'boolean'), 'R2_LIST_SCHEMA');
    ensure(page.result.length <= Math.min(limits.pageSize, limits.objects - inventory.listedObjects), 'R2_LIST_PAGE_LIMIT');
    inventory.pages++;
    for (const item of page.result) {
      ensure(record(item) && typeof item.key === 'string' && /^objects\/sha256\/[0-9a-f]{64}$/.test(item.key)
        && Number.isSafeInteger(item.size) && Number(item.size) >= 0 && !seenKeys.has(item.key), 'R2_LIST_OBJECT_SCHEMA');
      seenKeys.add(item.key); inventory.listedObjects++;
      if (Number(item.size) > limits.envelopeBytes) { inventory.skippedLargeObjects++; continue; }
      if (inventory.bytesRead + limits.envelopeBytes > limits.totalBytes) { inventory.issues.push('SCAN_TOTAL_BYTES_LIMIT'); break; }
      const body = await get(`${endpoint}/${item.key}`, limits.envelopeBytes);
      const expected = `sha256:${item.key.slice(prefix.length)}`;
      ensure(body.byteLength === Number(item.size) && sha(body) === expected, 'R2_OBJECT_DIGEST_MISMATCH');
      if (record(item.custom_metadata) && item.custom_metadata.digest !== undefined) ensure(item.custom_metadata.digest === expected, 'R2_CUSTOM_DIGEST_MISMATCH');
      inventory.inspectedObjects++;
      collect(body, expected);
    }
    if (inventory.issues.length) break;
    if (!page.result_info || !page.result_info.is_truncated) { inventory.complete = true; break; }
    const next = page.result_info.cursor;
    if (typeof next !== 'string' || !next || seenCursors.has(next) || page.result.length === 0) { inventory.issues.push('R2_PAGINATION_UNCERTAIN'); break; }
    seenCursors.add(next); cursor = next;
  }
  if (!inventory.complete && !inventory.issues.length) inventory.issues.push('SCAN_LIMIT_REACHED');
  if (inventory.skippedLargeObjects) inventory.issues.push('LARGE_OBJECTS_UNINSPECTED');
  const reservationById = new Map(snapshot.modelCalls.reservations.map(item => [item.callId, item]));
  const callsByAttempt = new Map<string, CallReport[]>();
  for (const [callId, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const first = group.start[0] ?? group.response[0]!;
    const observations = [...group.start, ...group.response];
    const uncertainty: string[] = [];
    if (group.start.length !== 1 || group.response.length > 1) uncertainty.push('BROKER_OBSERVATION_PAIR_INCOMPLETE_OR_CONFLICTING');
    if (observations.some(item => item.attemptId !== first.attemptId || item.generation !== first.generation || item.requestDigest !== first.requestDigest
      || item.maximumReservedCost !== first.maximumReservedCost || item.providerKind !== first.providerKind
      || item.requestedModel !== first.requestedModel)) uncertainty.push('BROKER_CALL_IDENTITY_CONFLICT');
    const reservation = reservationById.get(callId);
    if (!reservation) uncertainty.push('AUTHORITY_RESERVATION_MISSING');
    else if (reservation.attemptId !== first.attemptId || reservation.generation !== first.generation
      || reservation.maximumCost !== first.maximumReservedCost) uncertainty.push('AUTHORITY_RESERVATION_IDENTITY_MISMATCH');
    let state: CallReport['state'] = !reservation ? 'UNRESERVED_OBSERVATION'
      : group.start.length > 1 || group.response.length > 1 || uncertainty.includes('BROKER_CALL_IDENTITY_CONFLICT')
        || uncertainty.includes('AUTHORITY_RESERVATION_IDENTITY_MISMATCH') ? 'CONFLICT'
      : group.response.length === 0 ? 'UNCERTAIN_DISPATCH' : group.start.length === 0 ? 'ORPHAN_RESPONSE' : 'UNVERIFIED_RESPONSE';
    let responseDigest: string | null = group.response[0]?.responseDigest ?? null;
    let usage: UsageTotals | null = null, estimate: string | null = null;
    if (state !== 'CONFLICT' && state !== 'UNRESERVED_OBSERVATION') {
      try {
        const policy = modelPolicy(first.requestedModel)!;
        const request = requestIdentity(await linked(first.requestDigest, 192 * 1024), policy);
        const authorityRequestDigest = sha(new TextEncoder().encode(canonicalize({ providerKind: first.providerKind, request })));
        if (authorityRequestDigest !== reservation!.requestDigest) {
          uncertainty.push('AUTHORITY_REQUEST_DIGEST_MISMATCH'); state = 'CONFLICT';
        } else if (group.response[0] && responseDigest) {
          const responseBody = await linked(responseDigest, limits.linkedBytes);
          const identity = responseIdentity(responseBody, policy);
          const observed = group.response[0];
          ensure(identity.reportedModel === observed.reportedModel && identity.responseId === observed.responseId
            && canonicalize(identity.usage) === canonicalize(observed.usage), 'R2_RESPONSE_IDENTITY_MISMATCH');
          usage = usageTotals(identity.usage);
          if (!usage) uncertainty.push('PROVIDER_USAGE_UNAVAILABLE');
          else if (usage.cachedInputTokens === null) uncertainty.push('CACHED_INPUT_USAGE_UNREPORTED');
          if (state === 'UNVERIFIED_RESPONSE') state = 'VERIFIED_RESPONSE';
        } else uncertainty.push('RESPONSE_UNOBSERVED_AFTER_RESERVATION');
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        uncertainty.push(['MODEL_REQUEST_IDENTITY_MISMATCH', 'MODEL_RESPONSE_IDENTITY_MISMATCH', 'MODEL_RESPONSE_SHAPE_INVALID',
          'MODEL_USAGE_INVALID', 'R2_RESPONSE_IDENTITY_MISMATCH'].includes(code) ? code : 'LINKED_BYTES_UNVERIFIED');
        if (state !== 'UNCERTAIN_DISPATCH' && state !== 'ORPHAN_RESPONSE') state = 'UNVERIFIED_RESPONSE';
        usage = null;
      }
    }
    if (state === 'ORPHAN_RESPONSE') uncertainty.push('START_OBSERVATION_MISSING');
    if (state === 'VERIFIED_RESPONSE' && uncertainty.length === 0 && usage?.cachedInputTokens !== null && usage)
      estimate = price(estimatedNanoUsd(usage as UsageTotals & { cachedInputTokens: number }, modelPolicy(first.requestedModel)!));
    const call: CallReport = { callId, state, observationDigests: observations.map(item => item.digest).sort(), requestDigest: first.requestDigest, responseDigest,
      requestedModel: first.requestedModel, reasoningEffort: group.start[0]?.reasoningEffort ?? null,
      maximumReservedCostMicroUnits: first.maximumReservedCost, usage, observedResponseEstimateUsd: estimate, uncertainty: [...new Set(uncertainty)] };
    callsByAttempt.set(first.attemptId, [...(callsByAttempt.get(first.attemptId) ?? []), call]);
  }
  for (const reservation of snapshot.modelCalls.reservations) if (!groups.has(reservation.callId)) {
    const call: CallReport = { callId: reservation.callId, state: 'UNOBSERVED_RESERVATION', observationDigests: [],
      requestDigest: reservation.requestDigest, responseDigest: null, maximumReservedCostMicroUnits: reservation.maximumCost,
      requestedModel: null, reasoningEffort: null, usage: null, observedResponseEstimateUsd: null, uncertainty: ['BROKER_OBSERVATION_MISSING'] };
    callsByAttempt.set(reservation.attemptId, [...(callsByAttempt.get(reservation.attemptId) ?? []), call]);
  }
  const inventoryComplete = inventory.complete && inventory.issues.length === 0 && unmatched.length === 0;
  const attempts = snapshot.attempts.map(attempt => {
    const calls = (callsByAttempt.get(attempt.id) ?? []).sort((left, right) => left.callId.localeCompare(right.callId));
    const observedUsage = calls.reduce((sum, call) => call.state === 'VERIFIED_RESPONSE' && call.uncertainty.length === 0 && call.usage ? sumUsage(sum, call.usage) : sum, emptyUsage());
    const priced = calls.filter(call => call.observedResponseEstimateUsd !== null)
      .reduce((sum, call) => sum + BigInt(call.observedResponseEstimateUsd!.replace('.', '')), 0n);
    const complete = inventoryComplete && !snapshot.modelCalls.overflow && calls.every(call => call.state === 'VERIFIED_RESPONSE' && call.uncertainty.length === 0 && call.observedResponseEstimateUsd !== null);
    const callCoverage: Coverage = snapshot.modelCalls.overflow ? 'ROSTER_OVERFLOW' : complete ? 'COMPLETE' : 'INCOMPLETE';
    return { attemptId: attempt.id, generation: attempt.generation, observedCallCount: calls.filter(call => call.state !== 'UNOBSERVED_RESERVATION').length,
      verifiedResponseCount: calls.filter(call => call.state === 'VERIFIED_RESPONSE' && call.uncertainty.length === 0).length,
      uncertainCallCount: calls.filter(call => call.state !== 'VERIFIED_RESPONSE' || call.uncertainty.length > 0).length,
      unobservedCallCount: snapshot.modelCalls.overflow ? null : calls.filter(call => call.state === 'UNOBSERVED_RESERVATION').length,
      callCoverage, observedUsage, observedResponseEstimateUsd: price(priced), estimatedTotalUsd: complete ? price(priced) : null, calls };
  });
  const observedUsage = attempts.reduce((sum, attempt) => sumUsage(sum, attempt.observedUsage), emptyUsage());
  const priced = attempts.reduce((sum, attempt) => sum + BigInt(attempt.observedResponseEstimateUsd.replace('.', '')), 0n);
  const coverage: Coverage = snapshot.modelCalls.overflow ? 'ROSTER_OVERFLOW'
    : inventoryComplete && attempts.every(attempt => attempt.callCoverage === 'COMPLETE') ? 'COMPLETE' : 'INCOMPLETE';
  const total = coverage === 'COMPLETE' ? price(priced) : null;
  return { schemaVersion: 2, status: total === null ? 'OBSERVED_PARTIAL' : 'COMPLETE_ESTIMATE', generatedAt: options.now ?? new Date().toISOString(), accountId: options.accountId,
    bucketName: options.bucketName, projectId: snapshot.project.scope.projectId, projectIncarnation: snapshot.project.scope.projectIncarnation,
    authorityRevision: snapshot.project.revision, snapshotDigest: sha(options.snapshotBytes),
    protocolBudgetMicroUnits: { maximum: snapshot.project.maximumBudget, reserved: snapshot.project.reservedBudget, settled: snapshot.project.settledBudget,
      meaning: 'Protocol reservation ceilings; not observed Workers AI usage or billed USD.' },
    price: { source: PRICE_SOURCE, sourceUpdatedOn: '2026-10-01', currency: 'USD', models: MODEL_POLICIES.map(({ model, observedOn, perMillion }) => ({ model, observedOn, perMillion })),
      meaning: 'Dated token-rate estimate for complete authority-matched usage only; not a Cloudflare invoice.' },
    inventory, modelCalls: { limit: snapshot.modelCalls.limit, listedReservations: snapshot.modelCalls.reservations.length,
      overflow: snapshot.modelCalls.overflow, callCoverage: coverage,
      unobservedCallCount: snapshot.modelCalls.overflow ? null : attempts.reduce((sum, attempt) => sum + attempt.unobservedCallCount!, 0) },
    attempts, unmatchedObservationDigests: unmatched.sort(), observedUsage, observedResponseEstimateUsd: price(priced), estimatedTotalUsd: total,
    limitations: [
      ...(indexed ? ['Project-index mode follows only the retained authority call links; it does not scan for orphaned or unindexed objects elsewhere in the shared bucket.'] : []),
      ...(coverage === 'ROSTER_OVERFLOW' ? ['The authority model-call roster exceeded its snapshot bound; total usage is unknown.'] : []),
      ...(coverage === 'INCOMPLETE' ? ['At least one authority reservation, broker observation, provider usage field or R2 object could not be completely verified.'] : []),
      'A broker envelope is content-addressed and linked to verified request/response bytes, but it is not a signed provider billing record.',
      'A dispatch without a verified response may have incurred an unknown charge. Skipped, missing or unlisted objects cannot be assumed absent.',
      'The dated model-specific prices are applied to covered calls; this report does not prove those rates were in force for every call.',
      'The quoted price is the dated public token rate. Cloudflare bills in Neurons and account free allocation or prepaid credits can change the invoice.'
    ], remoteMutations: 0 };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2); const flag = (name: string) => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1] ?? null; };
  const snapshotPath = flag('--snapshot'), accountId = flag('--account-id'), bucketName = flag('--bucket'), outputPath = flag('--out');
  ensure(snapshotPath && accountId && bucketName && outputPath && args.length === 8, 'USAGE_ARGUMENTS_REQUIRED');
  ensure(resolve(outputPath) !== resolve(snapshotPath), 'USAGE_OUTPUT_OVERWRITES_INPUT');
  const snapshotBytes = await readFile(snapshotPath); ensure(snapshotBytes.length <= 8 * 1024 * 1024, 'AUTHORITY_SNAPSHOT_LIMIT');
  const snapshot = JSON.parse(utf8(snapshotBytes)); validSnapshot(snapshot);
  const selected = selectWranglerCredential(accountId);
  ensure(selected.account === accountId && selected.credential && selected.checks.every(check => check.status === 'PASS'), 'WRANGLER_OAUTH_UNAVAILABLE');
  const report = await reconcileModelUsage({ snapshot, snapshotBytes, accountId, bucketName, token: selected.credential });
  const file = await open(outputPath, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); } finally { await file.close(); }
  process.stdout.write(JSON.stringify({ status: report.status, report: resolve(outputPath), attempts: report.attempts.length,
    observedCalls: report.attempts.reduce((sum, item) => sum + item.observedCallCount, 0), coverage: report.modelCalls.callCoverage,
    estimatedTotalUsd: report.estimatedTotalUsd }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'USAGE_RECONCILIATION_FAILED';
    process.stderr.write(`${code}\n`); process.exitCode = 1; });
}
