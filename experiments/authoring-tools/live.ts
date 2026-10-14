// SPDX-License-Identifier: Apache-2.0
// Uses the existing authenticated authority API and broker. No provider keys,
// authentication refresh, deployment, budget increases, or publication here.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { ARMS, PATHS, TASK, Journal, fixture, modes, type Arm } from './benchmark.ts';
import { canonical, digest } from '../../services/crypto.ts';
import { initializeKernel } from '../../packages/protocol/src/node.ts';
import { probes } from '../../workers/evaluator/recipes.ts';
import type { AdmissionEvidence, EvaluationPlan } from '../../packages/protocol/src/types.ts';

// Deliberately avoid importing Worker environment bindings into the host tool.
// Complete response bytes are retained; only this projection drives progress.
interface AuthorityState {
  project: { scope: LivePlan['scope']; head: string; goalRevision: string; policyRevision: string; gate: string; unresolvedPublicationId: string | null;
    revision: string; maximumBudget: string; reservedBudget: string; settledBudget: string };
  modelCalls?: { overflow: boolean; reservations: { attemptId: string; maximumCost: string; [key: string]: unknown }[] };
  sourceManifests: Record<string, unknown>;
  runtime: { attemptId: string; generation: string; lifecycle: string; verified: boolean; outcome: string; sourceCommit?: string }[];
  submissions: { id: string; attemptId: string; source: { commit: string; manifestDigest?: string; manifest?: unknown }; [key: string]: unknown }[];
  candidates: { id: string }[];
  plans: EvaluationPlan[];
  evidence: AdmissionEvidence[];
  candidateRead?: { incompleteIds: string[] };
  cleanups: { attemptId: string; phase: string; [key: string]: unknown }[];
  events: { payload: string }[];
  callerPermissions?: { sponsor?: boolean };
  capsules: { attemptId: string; generation: string; stage: string; sessionDigest?: string | null; sourceAdvisoryDigest?: string | null; missingSessionTail: boolean; [key: string]: unknown }[];
}

export interface LivePlan {
  schemaVersion: 1;
  runId: string;
  origin: string;
  scope: { schemaVersion: 1; tenantId: string; projectId: string; projectIncarnation: string };
  principalId: string;
  variant: 'original-control' | 'biome-covered';
  sourceCommit: string;
  sourceManifestDigest: string;
  goalRevision: string;
  policyRevision: string;
  artifactsGitHost: string;
  model: string;
  runnerImageDigest: string;
  evaluatorImageDigest: string;
  checkerDigest: string;
  modelMaximumCallCost: '100000';
  perArmReservationUnits: '300000' | '400000';
  arms: Arm[];
  authoringMs: number;
  ingestionMs: number;
  evaluationMs: number;
  cleanupMs: number;
  authorizedModelSpendMicroUsd: number;
  reviewedMaximumCallMicroUsd: number;
  // Conservatively charged prior calls under the same cumulative authorization.
  priorModelSpendAllowanceMicroUsd?: number;
  pricingEvidenceDigest: string;
  // Operator authorization reference, not a signature or inferred dollar cap.
  authorizationReference: string;
}
export interface LiveTransport {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  verifyDeployment: (plan: LivePlan, arm: Arm) => Promise<{ runnerImageDigest: string; evaluatorImageDigest: string; checkerDigest: string; model: string; modelMaximumCallCost: string; narsil: string; interlinked: string; readbackDigest: string }>;
}
const sha = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const RECOVERY_STALE_REPLACEMENTS = 2;
type FrozenCommand = { path: string; body: string; headers: Record<string, string> };
type RecoveryPin = { attemptId: string; runtime: AuthorityState['runtime'][number]; submission: AuthorityState['submissions'][number];
  modelCalls: NonNullable<AuthorityState['modelCalls']>; budget: Pick<AuthorityState['project'], 'maximumBudget' | 'reservedBudget' | 'settledBudget'> };
class AuthorityHttpError extends Error {
  constructor(readonly status: number, readonly code?: string) { super(`Authority HTTP ${status}`); }
}
function authorityCommandDigest(frozen: FrozenCommand, operation: string) {
  return digest({ commandId: frozen.headers['Idempotency-Key'], expectedRevision: frozen.headers['If-Platform-Revision'],
    expectedIncarnation: frozen.headers['If-Platform-Incarnation'], operation, body: JSON.parse(frozen.body) });
}
function callIdentities(calls: NonNullable<AuthorityState['modelCalls']>) {
  const identities = calls.reservations.map(call => {
    assert(typeof call.callId === 'string' && typeof call.generation === 'string' && sha(call.requestDigest), 'RECOVERY_CALL_IDENTITY_REQUIRED');
    return { callId: call.callId, attemptId: call.attemptId, generation: call.generation, requestDigest: call.requestDigest, maximumCost: call.maximumCost };
  }).sort((a, b) => a.callId.localeCompare(b.callId));
  assert.equal(new Set(identities.map(call => call.callId)).size, identities.length, 'RECOVERY_CALL_IDENTITY_REQUIRED');
  return identities;
}

export function maximumCallsPerArm(plan: Pick<LivePlan, 'modelMaximumCallCost' | 'perArmReservationUnits'>) {
  assert.equal(plan.modelMaximumCallCost, '100000');
  assert(['300000', '400000'].includes(plan.perArmReservationUnits), 'Invalid per-arm reservation ceiling');
  return Number(BigInt(plan.perArmReservationUnits) / BigInt(plan.modelMaximumCallCost));
}

export function validateLivePlan(plan: LivePlan) {
  assert.equal(plan.schemaVersion, 1); assert.match(plan.runId, /^[a-zA-Z0-9_-]{8,64}$/);
  const url = new URL(plan.origin);
  assert(url.protocol === 'https:' && url.origin === plan.origin && !url.username && !url.password, 'Exact HTTPS application origin required');
  assert.equal(plan.scope.schemaVersion, 1);
  for (const value of [plan.scope.tenantId, plan.scope.projectId, plan.scope.projectIncarnation]) assert.match(value, /^[a-zA-Z0-9_-]{1,128}$/);
  assert(typeof plan.principalId === 'string' && plan.principalId.length > 0 && plan.principalId.length <= 512, 'Invalid principal');
  assert(['original-control', 'biome-covered'].includes(plan.variant), 'Invalid fixture variant'); assert.match(plan.sourceCommit, /^[a-f0-9]{40}$/);
  assert([plan.sourceManifestDigest, plan.runnerImageDigest, plan.evaluatorImageDigest, plan.checkerDigest].every(sha), 'Invalid immutable digest');
  assert(Array.isArray(plan.arms) && plan.arms.length >= 1 && plan.arms.length <= 4 && new Set(plan.arms).size === plan.arms.length
    && plan.arms.every(arm => ARMS.includes(arm)), 'One to four distinct registered arms required');
  const callsPerArm = maximumCallsPerArm(plan);
  assert(typeof plan.model === 'string' && plan.model.length > 0 && plan.model.length < 128, 'Invalid model identifier');
  assert.match(plan.artifactsGitHost, /^[a-zA-Z0-9.-]+$/);
  for (const [value, maximum] of [[plan.authoringMs, 660000], [plan.ingestionMs, 120000], [plan.evaluationMs, 300000], [plan.cleanupMs, 120000]]) assert(Number.isSafeInteger(value) && value >= 1000 && value <= maximum, 'Invalid phase deadline');
  assert(typeof plan.authorizationReference === 'string' && plan.authorizationReference.trim().length >= 8 && plan.authorizationReference.length <= 512, 'Explicit authorization reference required');
  for (const value of [plan.goalRevision, plan.policyRevision]) assert(typeof value === 'string' && value.length > 0 && value.length <= 128, 'Invalid goal or policy revision');
  assert(Number.isSafeInteger(plan.authorizedModelSpendMicroUsd) && plan.authorizedModelSpendMicroUsd > 0 && plan.authorizedModelSpendMicroUsd <= 100000000, 'Invalid approved model ceiling');
  assert(Number.isSafeInteger(plan.reviewedMaximumCallMicroUsd) && plan.reviewedMaximumCallMicroUsd > 0 && plan.reviewedMaximumCallMicroUsd <= 2000000, 'Invalid reviewed per-call USD upper bound');
  const prior = plan.priorModelSpendAllowanceMicroUsd === undefined ? 0 : plan.priorModelSpendAllowanceMicroUsd;
  assert(Number.isSafeInteger(prior) && prior >= 0 && prior <= plan.authorizedModelSpendMicroUsd, 'Invalid prior model-spend allowance');
  assert(prior + plan.reviewedMaximumCallMicroUsd * callsPerArm * plan.arms.length <= plan.authorizedModelSpendMicroUsd, 'Registered cumulative potential spend exceeds approved ceiling');
  assert(sha(plan.pricingEvidenceDigest), 'Independently reviewed provider price/bound evidence required');
}

export const maximumRequests = (plan: LivePlan) => Math.min(1152, plan.arms.length * (Math.ceil(plan.authoringMs / 5000) + Math.ceil(plan.ingestionMs / 5000) + Math.ceil(plan.evaluationMs / 5000) + Math.ceil(plan.cleanupMs / 5000) + 36));

export function assertMatchedState(state: AuthorityState, plan: LivePlan) {
  assert.equal(canonical(state.project.scope), canonical(plan.scope), 'Benchmark scope changed');
  assert.equal(state.project.head, plan.sourceCommit, 'Benchmark canonical source changed');
  assert.equal(state.project.goalRevision, plan.goalRevision, 'Benchmark goal changed');
  assert.equal(state.project.policyRevision, plan.policyRevision, 'Benchmark policy changed');
  assert.equal(state.project.gate, 'CLOSED', 'Benchmark publication must remain closed');
  assert.equal(state.project.unresolvedPublicationId, null, 'Unresolved publication');
  assert(state.modelCalls && !state.modelCalls.overflow, 'Complete model-call roster required');
  assert.equal(digest(state.sourceManifests[plan.sourceCommit]), plan.sourceManifestDigest, 'Benchmark source manifest changed');
}

export function completedPlan(state: Pick<AuthorityState, 'plans' | 'evidence' | 'candidateRead'>, candidateId: string) {
  if (state.candidateRead?.incompleteIds.includes(candidateId)) return undefined;
  return state.plans.find(plan => {
    if (plan.candidateId !== candidateId || plan.jobs.length !== probes.length || new Set(plan.jobs.map(job => job.id)).size !== probes.length) return false;
    const prefixes = new Set<string>();
    for (const probe of probes) {
      const job = plan.jobs.find(job => job.id.endsWith(':' + probe.id));
      if (!job || !job.required || job.evidenceClass !== 'protected-behavioural' || !sha(job.inputDigest)) return false;
      prefixes.add(job.id.slice(0, -probe.id.length));
      if (!state.evidence.some(item => item.jobId === job.id && item.candidateId === candidateId && item.candidateDigest === plan.candidateDigest
        && item.inputDigest === job.inputDigest && item.evidenceClass === 'protected-behavioural' && item.authorized === true
        && ['PASS', 'FAIL', 'ERROR', 'TIMEOUT', 'CANCELLED', 'INCONCLUSIVE'].includes(item.outcome))) return false;
    }
    return prefixes.size === 1;
  });
}

export function latestStopped(state: Pick<AuthorityState, 'runtime'>, attemptId: string) {
  const latest = state.runtime.filter(item => item.attemptId === attemptId && item.generation === '1').at(-1);
  return latest?.lifecycle === 'STOPPED' && latest.verified === true ? latest : undefined;
}

export function ingestionResult(state: Pick<AuthorityState, 'submissions' | 'events'>, attemptId: string, commit: string) {
  const submission = state.submissions.find(item => item.attemptId === attemptId && item.source.commit === commit);
  if (submission) return { status: 'READY' as const, submission };
  for (const record of state.events) {
    const event = JSON.parse(record.payload);
    if (event.kind === 'source-submission-rejected' && event.objectId === attemptId && event.payload?.commit === commit
      || event.kind === 'effect-rejected' && event.objectId === `${attemptId}-submission-1` && event.payload?.effect === 'ingest-submission') return { status: 'REJECTED' as const, rejection: event };
  }
  return { status: 'PENDING' as const };
}

export class LiveBenchmark {
  private index = 0;
  private held = false;
  private requests = 0;
  private constructor(readonly plan: LivePlan, private directory: string, private transport: LiveTransport, private journal: Journal) {}
  static async create(plan: LivePlan, directory: string, transport: LiveTransport, approval: 'APPROVED_REAL_MODEL_BENCHMARK') {
    assert.equal(approval, 'APPROVED_REAL_MODEL_BENCHMARK'); validateLivePlan(plan); await initializeKernel();
    const input = await fixture(plan.variant); assert.equal(input.sourceManifestDigest, plan.sourceManifestDigest, 'Plan must bind exact benchmark source');
    await mkdir(directory, { recursive: false, mode: 0o700 });
    const journal = await Journal.create(join(directory, 'events.jsonl'));
    const maximumCalls = maximumCallsPerArm(plan) * plan.arms.length;
    const priorModelSpendAllowanceMicroUsd = plan.priorModelSpendAllowanceMicroUsd ?? 0;
    const reviewedPotentialModelSpendMicroUsd = plan.reviewedMaximumCallMicroUsd * maximumCalls;
    await journal.append('registration', { plan, planDigest: digest(plan), task: TASK, allowedPaths: PATHS, taskDigest: input.taskDigest, checksDigest: input.checksDigest,
      maximumCalls, maximumReservationUnits: String(BigInt(plan.perArmReservationUnits) * BigInt(plan.arms.length)), maximumRequests: maximumRequests(plan),
      reviewedPotentialModelSpendMicroUsd, priorModelSpendAllowanceMicroUsd,
      reviewedCumulativeModelSpendMicroUsd: priorModelSpendAllowanceMicroUsd + reviewedPotentialModelSpendMicroUsd,
      recovery: { operations: ['materialize', 'request-cleanup'], requiresCompletedAcceptedSource: true, maximumExactReplaysPerOperation: 1,
        maximumRecordedStaleReplacementsPerOperation: RECOVERY_STALE_REPLACEMENTS, sharesPhaseDeadline: true, modelCallsAdded: 0 },
      unitsAreProviderSpend: false, actualBilledCostMicroUsd: null, counterfactualComparisonPlanned: plan.arms.length > 1 });
    return new LiveBenchmark(structuredClone(plan), directory, transport, journal);
  }
  private async request(path: string, init: RequestInit = {}, phase?: { name: string; deadline: number }) {
    if (phase) assert(Date.now() < phase.deadline, `BENCHMARK_${phase.name.toUpperCase()}_TIMEOUT`);
    assert(++this.requests <= maximumRequests(this.plan), 'BENCHMARK_REQUEST_LIMIT');
    const response = await this.transport.fetch(this.plan.origin + path, { ...init, redirect: 'error',
      signal: AbortSignal.timeout(phase ? Math.min(10000, Math.max(1, phase.deadline - Date.now())) : 10000) });
    const reader = response.body?.getReader(); let length = 0; const chunks: Uint8Array[] = [];
    if (reader) try { while (true) { const row = await reader.read(); if (row.done) break; length += row.value.length; assert(length <= 8 * 1024 * 1024, 'BENCHMARK_RESPONSE_LIMIT'); chunks.push(row.value); } } finally { await reader.cancel().catch(() => undefined); }
    const body = Buffer.concat(chunks).toString('utf8');
    if (phase) assert(Date.now() < phase.deadline, `BENCHMARK_${phase.name.toUpperCase()}_TIMEOUT`);
    if (!response.ok) {
      let code: string | undefined;
      try { const parsed = JSON.parse(body); if (typeof parsed?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(parsed.error.code)) code = parsed.error.code; } catch { /* Retain uncertain HTTP status without trusting malformed error bytes. */ }
      throw new AuthorityHttpError(response.status, code);
    }
    return JSON.parse(body);
  }
  private async state(candidateId?: string, phase?: { name: string; deadline: number }) {
    const state = await this.request(`/v1/projects/${this.plan.scope.projectId}/state?modelCalls=1${candidateId ? '&candidateId=' + encodeURIComponent(candidateId) : ''}`, {}, phase) as AuthorityState;
    assertMatchedState(state, this.plan); return state;
  }
  private freeze(arm: Arm, operation: string, body: Record<string, unknown>, revision: string, commandId = `${this.plan.runId}-${arm}-${operation}`): FrozenCommand {
    return { path: `/v1/projects/${this.plan.scope.projectId}/${operation}`, body: canonical(body), headers: {
      'Content-Type': 'application/json', 'Origin': this.plan.origin, 'X-Platform-CSRF': '1', 'Idempotency-Key': commandId,
      'If-Platform-Revision': revision, 'If-Platform-Incarnation': this.plan.scope.projectIncarnation, 'If-Platform-Principal': this.plan.principalId,
    } };
  }
  private assertRecoveryState(state: AuthorityState, pin: RecoveryPin) {
    assert.equal(state.callerPermissions?.sponsor, true, 'RECOVERY_SPONSOR_REQUIRED');
    assert(state.runtime.filter(item => item.attemptId === pin.attemptId).every(item => item.generation === '1'), 'RECOVERY_GENERATION_CHANGED');
    const runtime = latestStopped(state, pin.attemptId);
    assert(runtime && runtime.outcome === 'COMPLETED', 'RECOVERY_COMPLETED_RUNTIME_REQUIRED');
    assert.equal(canonical(runtime), canonical(pin.runtime), 'RECOVERY_RUNTIME_CHANGED');
    const submissions = state.submissions.filter(item => item.id === pin.submission.id);
    assert.equal(submissions.length, 1, 'RECOVERY_SUBMISSION_REQUIRED');
    assert.equal(state.submissions.filter(item => item.attemptId === pin.attemptId).length, 1, 'RECOVERY_SUBMISSION_CHANGED');
    assert.equal(canonical(submissions[0]), canonical(pin.submission), 'RECOVERY_SUBMISSION_CHANGED');
    assert.equal(submissions[0].attemptId, pin.attemptId); assert.equal(submissions[0].source.commit, runtime.sourceCommit);
    assert(sha(pin.submission.source.manifestDigest), 'RECOVERY_SOURCE_MANIFEST_REQUIRED');
    assert.equal(digest(pin.submission.source.manifest), pin.submission.source.manifestDigest, 'RECOVERY_SOURCE_MANIFEST_CHANGED');
    assert.equal(digest(state.sourceManifests[pin.submission.source.commit]), pin.submission.source.manifestDigest, 'RECOVERY_SOURCE_MANIFEST_CHANGED');
    assert.equal(canonical(callIdentities(state.modelCalls!)), canonical(callIdentities(pin.modelCalls)), 'RECOVERY_MODEL_ROSTER_CHANGED');
    for (const key of ['maximumBudget', 'reservedBudget', 'settledBudget'] as const) assert.equal(state.project[key], pin.budget[key], 'RECOVERY_BUDGET_CHANGED');
  }
  private async command(arm: Arm, operation: string, body: Record<string, unknown>, recovery?: { pin: RecoveryPin; phase: { name: string; deadline: number } }) {
    assert(!recovery || ['materialize', 'request-cleanup'].includes(operation), 'RECOVERY_OPERATION_FORBIDDEN');
    const state = await this.state(undefined, recovery?.phase);
    if (recovery) this.assertRecoveryState(state, recovery.pin);
    const operationId = `${this.plan.runId}-${arm}-${operation}`;
    let frozen = this.freeze(arm, operation, body, state.project.revision);
    await this.journal.append('command-dispatch', { arm, operation, frozen });
    let replacements = 0, replayed = false;
    while (true) {
      let error: unknown;
      try {
        const result = await this.request(frozen.path, { method: 'POST', headers: frozen.headers, body: frozen.body }, recovery?.phase);
        await this.journal.append('command-acknowledged', { arm, operation, result }); return result;
      } catch (caught) { error = caught; await this.journal.append('command-unresolved', { arm, operation, frozen,
        response: caught instanceof AuthorityHttpError ? { status: caught.status, code: caught.code ?? null } : { status: null, code: null } }); }
      if (!recovery) throw error;
      const stale = error instanceof AuthorityHttpError && error.status === 409 && error.code === 'STALE_STATE';
      const uncertain = !(error instanceof assert.AssertionError) && (!(error instanceof AuthorityHttpError) || error.status >= 500);
      if (!stale && (!uncertain || replayed)) throw error;
      if (stale) assert(replacements < RECOVERY_STALE_REPLACEMENTS, 'BENCHMARK_RECOVERY_LIMIT');
      const current = await this.state(undefined, recovery.phase); this.assertRecoveryState(current, recovery.pin);
      await this.journal.append('recovery-observation', { arm, operation, operationId, revision: current.project.revision, digest: digest(current) });
      if (stale) {
        // Revision is part of the authority command digest. Only a durable,
        // exact rejection permits a new command identity for the same intent.
        const events = current.events.map(record => JSON.parse(record.payload));
        const rejections = events.filter(event => event.kind === 'command-rejected' && event.objectId === frozen.headers['Idempotency-Key']);
        assert.equal(rejections.length, 1, 'RECOVERY_RECORDED_REJECTION_REQUIRED');
        assert.equal(rejections[0].payload?.operation, operation, 'RECOVERY_RECORDED_REJECTION_REQUIRED');
        assert.equal(rejections[0].payload?.code, 'STALE_STATE', 'RECOVERY_RECORDED_REJECTION_REQUIRED');
        assert.equal(rejections[0].payload?.requestDigest, authorityCommandDigest(frozen, operation), 'RECOVERY_RECORDED_REJECTION_REQUIRED');
        assert(!events.some(event => event.kind === operation && event.objectId === frozen.headers['Idempotency-Key']), 'RECOVERY_COMMAND_OUTCOME_CONFLICT');
        assert(BigInt(current.project.revision) > BigInt(frozen.headers['If-Platform-Revision']), 'RECOVERY_REVISION_NOT_ADVANCED');
        await this.journal.append('command-rejection-confirmed', { arm, operation, operationId, event: rejections[0], stateDigest: digest(current) });
        const rejectedCommandId = frozen.headers['Idempotency-Key'];
        frozen = this.freeze(arm, operation, body, current.project.revision, `${operationId}-recovery-${++replacements}`);
        await this.journal.append('command-recovery-dispatch', { arm, operation, operationId, rejectedCommandId, frozen, requestDigest: authorityCommandDigest(frozen, operation), replacement: replacements, modelCallsAdded: 0 });
      } else {
        // Lost/invalid responses may hide a commit. Replay the exact frozen
        // request once; never rebase an uncertain command or restart authoring.
        replayed = true;
        await this.journal.append('command-replay-dispatch', { arm, operation, operationId, frozen, requestDigest: authorityCommandDigest(frozen, operation), modelCallsAdded: 0 });
      }
    }
  }
  private async poll(arm: Arm, phase: string, milliseconds: number, predicate: (state: AuthorityState) => boolean, candidateId?: string, deadline = Date.now() + milliseconds) {
    let selectedCandidate: string | undefined;
    while (Date.now() < deadline) {
      const state = await this.state(selectedCandidate, { name: phase, deadline });
      await this.journal.append('observation', { arm, phase, revision: state.project.revision, digest: digest(state) });
      if (candidateId && !selectedCandidate) {
        // Materialization acknowledges queued work; selecting its not-yet-retained
        // candidate is a genuine 404. Wait for existence within this same deadline.
        assert(Array.isArray(state.candidates), 'Candidate inventory required');
        if (state.candidates.some(candidate => candidate.id === candidateId)) {
          selectedCandidate = candidateId;
          continue;
        }
      } else if (predicate(state)) return state;
      await sleep(Math.min(5000, Math.max(1, deadline - Date.now())));
    }
    throw new Error(`BENCHMARK_${phase.toUpperCase()}_TIMEOUT`);
  }
  async runNextArm() {
    assert(!this.held && this.index < this.plan.arms.length, 'Resolve prior arm before continuing'); this.held = true;
    const arm = this.plan.arms[this.index], startedAt = new Date().toISOString(), started = performance.now();
    const row: any = { schemaVersion: 1, arm, planDigest: digest(this.plan), startedAt, status: 'INCOMPLETE', acceptanceEligible: false, actualBilledCostMicroUsd: null,
      providerTokens: null, estimatedProviderCostMicroUsd: null, qualityAdvantage: null, cleanup: 'NOT_REQUESTED' };
    let attemptId: string | undefined;
    try {
      const deployment = await this.transport.verifyDeployment(this.plan, arm), expected = modes(arm);
      for (const key of ['runnerImageDigest', 'evaluatorImageDigest', 'checkerDigest', 'model', 'modelMaximumCallCost'] as const) assert.equal(deployment[key], this.plan[key], 'Deployment changed');
      assert.equal(deployment.narsil, expected.narsil); assert.equal(deployment.interlinked, expected.interlinked); assert(sha(deployment.readbackDigest));
      row.deployment = deployment; await this.journal.append('deployment-readback', { arm, deployment });
      const before = await this.state();
      assert(BigInt(before.project.maximumBudget) - BigInt(before.project.reservedBudget) - BigInt(before.project.settledBudget) >= BigInt(this.plan.perArmReservationUnits), 'BENCHMARK_RESERVATION_UNAVAILABLE');
      await writeFile(join(this.directory, arm + '-before.json'), canonical(before), { flag: 'wx', mode: 0o600 });
      const reservation = await this.command(arm, 'create-attempt', { subject: this.plan.principalId, maximumBudget: this.plan.perArmReservationUnits,
        recipe: 'pi-json-proposal-v1', assignment: TASK, workBase: this.plan.sourceCommit, publicationBase: this.plan.sourceCommit,
        allowedPaths: [...PATHS], pathPrefixes: [...PATHS], operations: ['checkpoint-context', 'model-inference', 'read-source', 'start-execution', 'submit-output', 'write-attempt'], destinations: [this.plan.artifactsGitHost, 'model.internal'].sort() });
      assert(typeof reservation.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(reservation.id)); attemptId = reservation.id; row.attemptId = attemptId;
      await this.command(arm, 'start-execution', { attemptId });
      let stopped = await this.poll(arm, 'authoring', this.plan.authoringMs, state => !!latestStopped(state, attemptId!));
      const runtime = latestStopped(stopped, attemptId!)!; row.runtime = runtime;
      if (runtime.outcome === 'COMPLETED') {
        assert(typeof runtime.sourceCommit === 'string' && /^[a-f0-9]{40}$/.test(runtime.sourceCommit), 'Completed runtime source missing');
        stopped = await this.poll(arm, 'ingestion', this.plan.ingestionMs, state => ingestionResult(state, attemptId!, runtime.sourceCommit!).status !== 'PENDING');
        row.ingestion = ingestionResult(stopped, attemptId!, runtime.sourceCommit);
      } else assert(['FAILED', 'CANCELLED', 'BUDGET_EXHAUSTED'].includes(runtime.outcome), 'Runtime outcome unresolved');
      const calls = stopped.modelCalls!.reservations.filter(call => call.attemptId === attemptId);
      row.modelReservations = calls; row.modelCalls = calls.length;
      assert(calls.length <= maximumCallsPerArm(this.plan) && calls.every(call => call.maximumCost === this.plan.modelMaximumCallCost), 'MODEL_RESERVATION_BOUND_CHANGED');
      row.capsules = stopped.capsules.filter(item => item.attemptId === attemptId && item.generation === '1');
      const captured = row.capsules.find((item: any) => item.stage === 'session' && sha(item.sessionDigest) && !item.missingSessionTail);
      row.toolEvidence = { sessionReference: captured?.sessionDigest ?? null,
        sourceAdvisoryReference: row.capsules.find((item: any) => sha(item.sourceAdvisoryDigest))?.sourceAdvisoryDigest ?? null,
        coverage: 'UNMEASURED_UNTIL_ARTIFACT_COLLECTION', completeness: captured ? 'REFERENCES_RETAINED' : 'MISSING_COMPLETE_SESSION', modeFlagsAreCoverage: false };
      const submission = runtime.outcome === 'COMPLETED' && row.ingestion.status === 'READY' ? row.ingestion.submission : undefined;
      const recoveryPin: RecoveryPin | undefined = submission ? structuredClone({ attemptId: attemptId!, runtime: latestStopped(stopped, attemptId!)!,
        submission, modelCalls: stopped.modelCalls!, budget: { maximumBudget: stopped.project.maximumBudget,
          reservedBudget: stopped.project.reservedBudget, settledBudget: stopped.project.settledBudget } }) : undefined;
      if (submission) {
        row.submission = submission;
        const deadline = Date.now() + this.plan.evaluationMs;
        const candidate = await this.command(arm, 'materialize', { submissionIds: [submission.id], evaluate: true }, { pin: recoveryPin!, phase: { name: 'evaluation', deadline } });
        assert(typeof candidate.id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(candidate.id)); row.candidateId = candidate.id;
        const evaluated = await this.poll(arm, 'evaluation', this.plan.evaluationMs, state => !!completedPlan(state, candidate.id), candidate.id, deadline);
        row.authorityEvidence = evaluated.evidence.filter((item: any) => item.candidateId === candidate.id);
        row.authorityPlans = evaluated.plans.filter(plan => plan.candidateId === candidate.id);
        row.status = row.authorityEvidence.some((item: any) => item.outcome !== 'PASS') ? 'AUTHORITY_REPORTED_NONPASS' : 'AUTHORITY_REPORTED_PASS';
        await writeFile(join(this.directory, arm + '-evaluated.json'), canonical(evaluated), { flag: 'wx', mode: 0o600 });
      } else { row.status = row.ingestion?.status === 'REJECTED' ? 'INGESTION_REJECTED' : 'NO_SUBMISSION'; await writeFile(join(this.directory, arm + '-stopped.json'), canonical(stopped), { flag: 'wx', mode: 0o600 }); }
      await this.journal.append('result-before-cleanup', row);
      const cleanupDeadline = Date.now() + this.plan.cleanupMs;
      await this.command(arm, 'request-cleanup', { attemptId, reason: `Completed bounded benchmark ${this.plan.runId} ${arm}; retain archive and authoritative evidence.` },
        recoveryPin ? { pin: recoveryPin, phase: { name: 'cleanup', deadline: cleanupDeadline } } : undefined);
      row.cleanup = 'REQUESTED';
      const cleaned = await this.poll(arm, 'cleanup', this.plan.cleanupMs, state => state.cleanups.some(item => item.attemptId === attemptId && item.phase === 'TOMBSTONED'), undefined, cleanupDeadline);
      row.cleanup = 'TOMBSTONED'; await writeFile(join(this.directory, arm + '-final.json'), canonical(cleaned), { flag: 'wx', mode: 0o600 });
      this.index++; this.held = false;
    } catch (error) {
      row.codingStatus = row.status; row.status = 'INCOMPLETE';
      row.error = error instanceof Error ? error.message.slice(0, 512) : 'BENCHMARK_FAILED';
      row.needsOperatorReconciliation = true;
      // A timeout cannot establish termination. Keep the exact attempt ID and
      // fence subsequent arms; the authority's existing 600s grant remains.
      row.unresolvedAttemptId = attemptId ?? null;
    } finally {
      row.completedAt = new Date().toISOString(); row.elapsedMs = Math.round(performance.now() - started);
      await this.journal.append('arm-result', row); await writeFile(join(this.directory, arm + '-report.json'), JSON.stringify(row, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    return row;
  }
  async close() { await this.journal.close(); }
}
