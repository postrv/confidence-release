// SPDX-License-Identifier: Apache-2.0
// OWNED TEST ONLY. The callback receiver is a conformance observer, not ProjectAuthority.
import { DurableObject } from 'cloudflare:workers';
import { canonicalize, decodeBase64, digest, getKernel, parseStrictJson, sha256, verifyAttestation, type AdmissionEvidence, type Scope, type TrustConfig } from '../../packages/protocol/src/index';
import '../../workers/authority/kernel';
import { ObjectStore } from '../../workers/shared/objects';
import { readBounded, errorResponse, requireValue } from '../../workers/shared/errors';
import type { EvaluationRequest, EvaluationCallback } from '../../workers/authority/types';
import { OWNED_JOB_COUNT, requests, runScope } from './requests';
import { registeredGenerationDiagnostics } from './diagnostics';
import type { ConformanceEvaluation, ConformanceScheduler, FixtureStore } from './evaluator';
import type { CallbackRecord, FixtureName, Phase, RejectedCallbackWitness, SourcePackage } from './types';
interface Env {
  CONTROL: DurableObjectNamespace<ConformanceControl>;
  EVALUATOR: Fetcher; EVALUATIONS: DurableObjectNamespace<ConformanceEvaluation>;
  SCHEDULER: DurableObjectNamespace<ConformanceScheduler>; FIXTURES: DurableObjectNamespace<FixtureStore>;
  OBJECTS: R2Bucket; ADMIN_TOKEN: string; EVALUATOR_SERVICE_TOKEN: string;
  RUN_ID: string; EXPIRES_AT: string; CHECKER_KEY_ID: string; CHECKER_PUBLIC_KEY: string; ROOT_PUBLIC_KEY: string;
  EVALUATION_IMAGE_DIGEST: string; CHECKER_IMPLEMENTATION_DIGEST: string;
  GOOD_SOURCE_DIGEST: string; BAD_SOURCE_DIGEST: string;
}
type Task = { request: EvaluationRequest; requestDigest: string; jobKey: string; phase: Phase; category: 'good' | 'bad' | 'callback-fault' | 'restart-fault' };
type State = { sources: Partial<Record<FixtureName, string>>; tasks: Record<string, Task>; callbacks: Record<string, CallbackRecord>; admissionsClosed: boolean; restart: Phase; calls: number };
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const empty = (): State => ({ sources: {}, tasks: {}, callbacks: {}, admissionsClosed: false, restart: 'NOT_DISPATCHED', calls: 0 });
const scope = (env: Env): Scope => runScope(env.RUN_ID);
async function token(request: Request, expected: string) { requireValue(/^[a-f0-9]{64}$/.test(expected ?? '') && await sha256(request.headers.get('authorization') ?? '') === await sha256(`Bearer ${expected}`), 'OWNED_AUTHENTICATION_REQUIRED', 401); }
function live(env: Env) { requireValue(/^\d{13}$/.test(env.EXPIRES_AT) && Date.now() < Number(env.EXPIRES_AT), 'OWNED_ADMISSION_EXPIRED', 403); requireValue(/^sha256:[a-f0-9]{64}$/.test(env.EVALUATION_IMAGE_DIGEST) && /^sha256:[a-f0-9]{64}$/.test(env.CHECKER_IMPLEMENTATION_DIGEST), 'OWNED_DEPLOYMENT_NOT_PINNED', 503); }
async function json(request: Request, maximum = 256 * 1024) { return parseStrictJson(decoder.decode(await readBounded(request.body, maximum))); }
export class ConformanceControl extends DurableObject<Env> {
  private async state(): Promise<State> { return await this.ctx.storage.get<State>('state') ?? empty(); }
  private trust(): TrustConfig { return { schemaVersion: 1, scope: scope(this.env), keysetRevision: '1', keys: [{ id: 'owned-root', publicKeyBase64: this.env.ROOT_PUBLIC_KEY, roles: ['root'] }, { id: this.env.CHECKER_KEY_ID, publicKeyBase64: this.env.CHECKER_PUBLIC_KEY, roles: ['checker'] }] }; }
  private async admit(): Promise<void> {
    live(this.env);
    await this.ctx.storage.transaction(async storage => { const state = await storage.get<State>('state') ?? empty(); requireValue(!state.admissionsClosed && state.calls < 48, 'OWNED_ADMISSIONS_FENCED', 409); state.calls++; await storage.put('state', state); });
  }
  async seed(input: SourcePackage): Promise<unknown> {
    await this.admit(); requireValue(input && (input.name === 'good' || input.name === 'bad'), 'OWNED_SOURCE_NAME');
    const expected = input.name === 'good' ? this.env.GOOD_SOURCE_DIGEST : this.env.BAD_SOURCE_DIGEST; requireValue(await digest(input) === expected, 'OWNED_SOURCE_NOT_REGISTERED');
    requireValue(input.schemaVersion === 1 && input.candidate.id === `${this.env.RUN_ID.replaceAll('-', '')}_${input.name}`, 'OWNED_SOURCE_SCOPE');
    const checked = JSON.parse(getKernel().validate_git_source(canonicalize({ candidate: input.candidate, manifest: input.manifest, gitObjects: input.objects }))); requireValue(checked.valid, 'OWNED_SOURCE_VERIFICATION_FAILED');
    const store = new ObjectStore(this.env.OBJECTS); await store.put(encoder.encode(canonicalize(input.objects))); await store.put(encoder.encode(canonicalize(input.manifest)), input.candidate.manifestDigest);
    for (const object of input.objects.filter(object => object.type === 'blob')) await store.put(decodeBase64(object.dataBase64));
    await store.put(encoder.encode(canonicalize(input)), expected);
    await this.ctx.storage.transaction(async storage => { const state = await storage.get<State>('state') ?? empty(); requireValue(!state.admissionsClosed, 'OWNED_ADMISSIONS_FENCED'); requireValue(!state.sources[input.name] || state.sources[input.name] === expected, 'OWNED_SOURCE_CHANGED'); state.sources[input.name] = expected; await storage.put('state', state); });
    return { name: input.name, digest: expected, readBackVerified: true };
  }
  private async register(): Promise<void> {
    const state = await this.state(); if (Object.keys(state.tasks).length) return;
    requireValue(state.sources.good === this.env.GOOD_SOURCE_DIGEST && state.sources.bad === this.env.BAD_SOURCE_DIGEST, 'OWNED_SOURCES_REQUIRED');
    const store = new ObjectStore(this.env.OBJECTS), tasks: Record<string, Task> = {};
    const sources = { good: parseStrictJson(decoder.decode(await store.get(state.sources.good!, 256 * 1024))) as SourcePackage, bad: parseStrictJson(decoder.decode(await store.get(state.sources.bad!, 256 * 1024))) as SourcePackage };
    for (const task of await requests(sources, { runId: this.env.RUN_ID, imageDigest: this.env.EVALUATION_IMAGE_DIGEST, checkerDigest: this.env.CHECKER_IMPLEMENTATION_DIGEST, checkerKeyId: this.env.CHECKER_KEY_ID })) tasks[task.request.job.id] = { ...task, phase: 'NOT_DISPATCHED' };
    requireValue(Object.keys(tasks).length === OWNED_JOB_COUNT, 'OWNED_PLAN_BOUND');
    await this.ctx.storage.transaction(async storage => { const current = await storage.get<State>('state') ?? empty(); requireValue(!current.admissionsClosed, 'OWNED_ADMISSIONS_FENCED'); if (!Object.keys(current.tasks).length) { current.tasks = tasks; await storage.put('state', current); } });
  }
  async dispatch(): Promise<unknown> {
    await this.admit(); await this.register();
    requireValue(!Object.values((await this.state()).tasks).some(task => task.phase === 'MAY_HAVE_DISPATCHED' || task.phase === 'UNKNOWN'), 'OWNED_DISPATCH_UNRESOLVED', 409);
    // Arm the two separately attributed fault jobs before the normal plans.
    // The production scheduler still owns both actual slots and all later priority decisions.
    for (const [id, task] of Object.entries((await this.state()).tasks).sort(([, a], [, b]) => Number(b.category.endsWith('fault')) - Number(a.category.endsWith('fault')) || Number(b.category === 'restart-fault') - Number(a.category === 'restart-fault'))) {
      if (task.phase !== 'NOT_DISPATCHED') continue;
      const authorized = await this.ctx.storage.transaction(async storage => { const current = await storage.get<State>('state') ?? empty(); requireValue(!current.admissionsClosed && Date.now() < Number(this.env.EXPIRES_AT), 'OWNED_ADMISSIONS_FENCED'); if (current.tasks[id].phase !== 'NOT_DISPATCHED') return false; current.tasks[id].phase = 'MAY_HAVE_DISPATCHED'; await storage.put('state', current); return true; });
      if (!authorized) continue;
      if (task.category === 'restart-fault') await this.restartFault();
      let phase: Phase = 'UNKNOWN';
      try { const response = await this.env.EVALUATOR.fetch('https://evaluator/internal/evaluate', { method: 'POST', headers: { authorization: `Bearer ${this.env.EVALUATOR_SERVICE_TOKEN}`, 'content-type': 'application/json' }, body: canonicalize(task.request), signal: AbortSignal.timeout(10000) }); await response.body?.cancel(); if (response.status === 202) phase = 'ACKNOWLEDGED'; } catch { /* Possible enqueue remains retained, never automatically repeated. */ }
      await this.ctx.storage.transaction(async storage => { const current = await storage.get<State>('state') ?? empty(); current.tasks[id].phase = phase; await storage.put('state', current); });
      if (phase === 'UNKNOWN') break;
    }
    return this.inspect();
  }
  /** Normal class callback bytes are authenticated, verified and retained before acknowledging. */
  async callback(request: Request): Promise<Response> {
    const captureStarted = Date.now();
    await token(request, this.env.EVALUATOR_SERVICE_TOKEN); const callback = await json(request) as EvaluationCallback, current = await this.state();
    requireValue(canonicalize(callback.scope) === canonicalize(scope(this.env)), 'OWNED_CALLBACK_SCOPE');
    const task = current.tasks[callback.evidence?.jobId]; requireValue(task && task.phase !== 'NOT_DISPATCHED', 'OWNED_CALLBACK_JOB');
    const proof = verifyAttestation<AdmissionEvidence>({ trust: this.trust(), envelope: callback.envelope, kind: 'evidence', role: 'checker', authorityRevision: '1', allowLegacy: false });
    requireValue(proof.valid && canonicalize(proof.record) === canonicalize(callback.evidence) && canonicalize(proof.issuance) === canonicalize(task.request.issuance), 'OWNED_CALLBACK_SIGNATURE');
    const evidence = callback.evidence, { digest: claimed, ...identity } = evidence; requireValue(await digest(identity) === claimed && evidence.candidateId === task.request.candidate.id && evidence.candidateDigest === task.request.candidate.digest && evidence.inputDigest === task.request.job.inputDigest && evidence.authorized === true, 'OWNED_EVIDENCE_IDENTITY');
    const bytes = decodeBase64(callback.observationBase64); requireValue(bytes.length <= 65536 && await sha256(bytes) === evidence.observationDigest, 'OWNED_OBSERVATION_DIGEST');
    const observation = parseStrictJson(decoder.decode(bytes)) as any; requireValue(canonicalize(observation.scope) === canonicalize(task.request.scope) && canonicalize(observation.evaluation) === canonicalize(task.request.evaluation) && observation.jobId === evidence.jobId && observation.inputDigest === evidence.inputDigest && observation.candidateDigest === evidence.candidateDigest && observation.outcome === evidence.outcome, 'OWNED_OBSERVATION_IDENTITY');
    const store = new ObjectStore(this.env.OBJECTS); const persisted = await store.get(evidence.observationDigest, 65536); requireValue(await sha256(persisted) === evidence.observationDigest, 'OWNED_OBSERVATION_READBACK');
    const callbackDigest = await store.put(encoder.encode(canonicalize(callback)));
    let witness: RejectedCallbackWitness | null = null;
    if (task.category === 'callback-fault' && !current.callbacks[evidence.jobId]) {
      // Sample both production-owned records while the producer still awaits
      // this response. A later poll cannot reconstruct this held-slot boundary.
      const [native, scheduler] = await Promise.all([
        this.env.EVALUATIONS.getByName(task.jobKey).inspectForConformance(task.jobKey),
        this.env.SCHEDULER.getByName('bounded-evaluation-pool-v1').inspectForConformance() as Promise<Record<string, { digest: string; object: string; status: string; priority: number }>>,
      ]);
      const captured = Date.now(), slot = scheduler[task.jobKey], nativeObserved = Date.parse(native.observedAt);
      requireValue(captured - captureStarted <= 1500 && Number.isSafeInteger(nativeObserved) && nativeObserved >= captureStarted - 5000 && nativeObserved <= captured + 5000, 'OWNED_REJECTED_CALLBACK_HELD_SLOT_UNOBSERVED', 409);
      requireValue(native.jobKey === task.jobKey && native.jobId === evidence.jobId && native.requestDigest === task.requestDigest && native.callbackDigest === callbackDigest && native.callbackDelivered === false && native.terminationObserved === true && native.phase === 'STOPPED' && native.container === null && native.configuredImage.endsWith(`@${this.env.EVALUATION_IMAGE_DIGEST}`), 'OWNED_REJECTED_CALLBACK_HELD_SLOT_UNOBSERVED', 409);
      requireValue(slot?.status === 'ACTIVE' && slot.digest === task.requestDigest && slot.object === task.requestDigest && Number.isSafeInteger(slot.priority), 'OWNED_REJECTED_CALLBACK_HELD_SLOT_UNOBSERVED', 409);
      requireValue(current.sources.good === this.env.GOOD_SOURCE_DIGEST, 'OWNED_CALLBACK_SOURCE_CHANGED', 409);
      witness = { schemaVersion: 1, runId: this.env.RUN_ID, jobKey: task.jobKey, jobId: evidence.jobId, requestDigest: task.requestDigest,
        sourceDigest: current.sources.good, candidateDigest: evidence.candidateDigest, inputDigest: evidence.inputDigest,
        callbackDigest, evidenceDigest: evidence.digest, observationDigest: evidence.observationDigest,
        responseStatus: 503, deliveryNumber: 1, captureStartedAt: new Date(captureStarted).toISOString(), capturedAt: new Date(captured).toISOString(),
        native, scheduler: { digest: slot.digest, object: slot.object, status: 'ACTIVE', priority: slot.priority } };
    }
    const reject = await this.ctx.storage.transaction(async storage => {
      const state = await storage.get<State>('state') ?? empty(), prior = state.callbacks[evidence.jobId]; requireValue(!prior || prior.digest === callbackDigest, 'OWNED_CALLBACK_CONTRADICTION', 409);
      const rejectedOnce = task.category === 'callback-fault' && !prior;
      requireValue(!rejectedOnce || witness !== null, 'OWNED_REJECTED_CALLBACK_HELD_SLOT_UNOBSERVED', 409);
      state.callbacks[evidence.jobId] = { digest: callbackDigest, envelope: callback.envelope, observationDigest: evidence.observationDigest, evidenceDigest: evidence.digest, jobId: evidence.jobId, outcome: evidence.outcome, deliveries: (prior?.deliveries ?? 0) + 1, rejectedOnce: rejectedOnce || prior?.rejectedOnce === true, rejectionWitness: rejectedOnce ? witness : prior?.rejectionWitness ?? null };
      await storage.put('state', state); return rejectedOnce;
    });
    return Response.json({ retained: true, receiver: 'owned-conformance-not-project-authority' }, { status: reject ? 503 : 200 });
  }
  async restartFault(): Promise<unknown> {
    await this.admit(); const selected = Object.values((await this.state()).tasks).find(task => task.category === 'restart-fault'); requireValue(selected, 'OWNED_FAULT_JOB_REQUIRED');
    await this.ctx.storage.transaction(async storage => { const state = await storage.get<State>('state') ?? empty(); requireValue(state.restart === 'NOT_DISPATCHED', 'OWNED_RESTART_ALREADY_POSSIBLE', 409); state.restart = 'MAY_HAVE_DISPATCHED'; await storage.put('state', state); });
    this.ctx.waitUntil(this.env.EVALUATIONS.getByName(selected.jobKey).abortOnceWhenRunning(selected.request.job.id).catch(async () => { await this.ctx.storage.transaction(async storage => { const state = await storage.get<State>('state') ?? empty(); state.restart = 'UNKNOWN'; await storage.put('state', state); }); }));
    return { restart: 'MAY_HAVE_DISPATCHED', automaticRetry: false };
  }
  async closeAdmissions(): Promise<unknown> { await this.ctx.storage.transaction(async storage => { const state = await storage.get<State>('state') ?? empty(); state.admissionsClosed = true; await storage.put('state', state); }); return { admissionsClosed: true }; }
  async evidence(jobId: string): Promise<unknown> {
    const state = await this.state(); const task = state.tasks[jobId], callback = state.callbacks[jobId]; requireValue(task && callback, 'OWNED_EVIDENCE_NOT_AVAILABLE', 409);
    const store = new ObjectStore(this.env.OBJECTS), retained = await store.get(callback.digest, 128 * 1024); requireValue(await sha256(retained) === callback.digest, 'OWNED_CALLBACK_READBACK');
    return parseStrictJson(decoder.decode(retained));
  }
  async deployment(): Promise<unknown> {
    const jobKey = (await digest({ scope: scope(this.env), jobId: `${this.env.RUN_ID}_image_inspection_only` })).slice(7);
    return { runId: this.env.RUN_ID, image: await this.env.EVALUATIONS.getByName(jobKey).inspectForConformance(jobKey), checkerImplementationDigest: this.env.CHECKER_IMPLEMENTATION_DIGEST, admissionExpiresAt: Number(this.env.EXPIRES_AT) };
  }
  async inspect(): Promise<unknown> {
    const state = await this.state(), scheduler = await this.env.SCHEDULER.getByName('bounded-evaluation-pool-v1').inspectForConformance();
    const diagnostics = await registeredGenerationDiagnostics(Object.values(state.tasks).map(task => task.jobKey), key => this.env.EVALUATIONS.getByName(key).operations());
    const jobs = [];
    for (const task of Object.values(state.tasks)) jobs.push({ category: task.category, requestDigest: task.requestDigest, dispatch: task.phase, native: await this.env.EVALUATIONS.getByName(task.jobKey).inspectForConformance(task.jobKey), fixture: await this.env.FIXTURES.getByName(task.jobKey).inspectFence(), callback: state.callbacks[task.request.job.id] ?? null, diagnostics: diagnostics[task.jobKey] });
    return { schemaVersion: 1, runId: this.env.RUN_ID, scope: scope(this.env), observationClass: 'deployed-production-evaluator-with-owned-controller', receiver: 'owned-conformance-not-project-authority', expiresAt: Number(this.env.EXPIRES_AT), admissionsClosed: state.admissionsClosed, restart: state.restart, sources: state.sources, trust: this.trust(), scheduler, jobs };
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      requireValue(/^[a-f0-9-]{36}$/.test(env.RUN_ID), 'OWNED_RUN_NOT_CONFIGURED', 503); const path = new URL(request.url).pathname;
      if (path === '/internal/observation' && request.method === 'POST') return env.CONTROL.getByName(env.RUN_ID).callback(request);
      await token(request, env.ADMIN_TOKEN); const controller = env.CONTROL.getByName(env.RUN_ID);
      if (path === '/inspect' && request.method === 'GET') return Response.json(await controller.inspect());
      if (path === '/deployment' && request.method === 'GET') return Response.json(await controller.deployment());
      if (path === '/seed' && request.method === 'POST') return Response.json(await controller.seed(await json(request) as SourcePackage));
      if (path === '/evidence' && request.method === 'POST') { const input = await json(request, 1024) as { jobId: string }; requireValue(input && Object.keys(input).join(',') === 'jobId' && typeof input.jobId === 'string', 'OWNED_EVIDENCE_SELECTOR'); return Response.json(await controller.evidence(input.jobId)); }
      requireValue(request.method === 'POST' && (request.headers.get('content-type') ?? '').split(';')[0] === 'application/json' && canonicalize(await json(request, 128)) === '{}', 'OWNED_CLOSED_COMMAND_REQUIRED');
      if (path === '/dispatch') return Response.json(await controller.dispatch(), { status: 202 });
      if (path === '/restart-fault') return Response.json(await controller.restartFault(), { status: 202 });
      if (path === '/close') return Response.json(await controller.closeAdmissions());
      return new Response(null, { status: 404 });
    } catch (error) { return errorResponse(error); }
  },
} satisfies ExportedHandler<Env>;
