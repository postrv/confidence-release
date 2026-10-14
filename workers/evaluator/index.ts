// SPDX-License-Identifier: Apache-2.0
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { Files } from '@cloudflare/sandbox';
import { canonicalize, containsTypeScriptSource, decodeBase64, digest, encodeBase64, getKernel, issuedStatement, parseStrictJson, sha256, signStatement, statement, type AdmissionEvidence, type GitObject, type Outcome } from '../../packages/protocol/src/index';
import '../authority/kernel';
import type { EvaluationCallback, EvaluationRequest } from '../authority/types';
import { errorResponse, PlatformError, readBounded, requireValue } from '../shared/errors';
import { ObjectStore } from '../shared/objects';
import { evaluationInput, probes, values, type Probe } from './recipes';
import { hydrateVerifiedSource } from './hydration';
import { boundedServiceFetch, withinDeadline } from '../shared/deadline';
import { oldestAge } from '../shared/age';
import { readRecoveryEvents, readRecoveryEvictions, recordRecovery, recoveryCode, type ExecutionStage } from './recovery';
import { runOverlappingReadWrite, validOverlapStoreTrace } from './overlap';

interface Env {
  EVALUATIONS: DurableObjectNamespace<EvaluationSandbox>;
  FIXTURES: DurableObjectNamespace<FixtureStore>;
  SCHEDULER: DurableObjectNamespace<EvaluationScheduler>;
  OBJECTS: R2Bucket; AUTHORITY: Fetcher;
  EVALUATOR_SERVICE_TOKEN: string; CHECKER_SIGNING_KEY: string; CHECKER_KEY_ID: string;
  EVALUATION_IMAGE_DIGEST: string; CHECKER_IMPLEMENTATION_DIGEST: string;
}
interface JobRecord {
  request: EvaluationRequest; requestDigest: string; jobKey: string; deadline: number;
  phase: 'RESERVED' | 'START_MAY_HAVE_DISPATCHED' | 'RUNNING' | 'STOP_REQUESTED' | 'STOPPED';
  executionStage?: ExecutionStage;
  callback?: EvaluationCallback; callbackFrozenAt?: number; callbackDelivered?: boolean; terminationObserved: boolean; fixtureClosed?: boolean;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
async function internal(request: Request, env: Env) {
  requireValue(env.EVALUATOR_SERVICE_TOKEN?.length >= 32, 'SERVICE_TOKEN_NOT_CONFIGURED', 503);
  requireValue(await sha256(request.headers.get('authorization') || '') === await sha256(`Bearer ${env.EVALUATOR_SERVICE_TOKEN}`), 'SERVICE_AUTHENTICATION_REQUIRED', 401);
}
async function parseRequest(request: Request, maximum = 8 * 1024 * 1024) {
  return parseStrictJson(decoder.decode(await readBounded(request.body, maximum)));
}
async function identity(request: EvaluationRequest) { return (await digest({ scope: request.scope, jobId: request.job.id })).slice(7); }
async function sourceObjects(request: EvaluationRequest, env: Env): Promise<GitObject[]> {
  const objects = request.source.objects.length ? request.source.objects : parseStrictJson(decoder.decode(await new ObjectStore(env.OBJECTS).get(request.source.objectsDigest, 8 * 1024 * 1024))) as GitObject[];
  requireValue(Array.isArray(objects) && await digest(objects) === request.source.objectsDigest, 'SOURCE_OBJECTS_DIGEST_MISMATCH');
  return objects;
}
async function validate(request: EvaluationRequest, env: Env): Promise<Probe> {
  requireValue(request.scope.schemaVersion === 1 && request.scope.projectId && request.scope.projectIncarnation, 'INVALID_SCOPE');
  requireValue((request.issuance === undefined) === (request.checkerKeyId === undefined), 'INCOMPLETE_CHECKER_ISSUANCE');
  if (request.issuance !== undefined) {
    const issuance = request.issuance;
    requireValue(issuance && typeof issuance === 'object' && Object.keys(issuance).sort().join(',') === 'authorityRevision,schemaVersion,scope,signerKeysetRevision'
      && issuance.schemaVersion === 1 && canonicalize(issuance.scope) === canonicalize(request.scope)
      && typeof issuance.signerKeysetRevision === 'string' && /^[1-9][0-9]{0,19}$/.test(issuance.signerKeysetRevision)
      && typeof issuance.authorityRevision === 'string' && /^[1-9][0-9]{0,19}$/.test(issuance.authorityRevision), 'INVALID_CHECKER_ISSUANCE');
    requireValue(BigInt(issuance.signerKeysetRevision) <= 18446744073709551615n && BigInt(issuance.authorityRevision) <= 18446744073709551615n, 'INVALID_CHECKER_ISSUANCE');
    requireValue(typeof request.checkerKeyId === 'string' && request.checkerKeyId === env.CHECKER_KEY_ID, 'REGISTERED_CHECKER_KEY_MISMATCH');
  }
  const evaluation = request.evaluation;
  requireValue(evaluation && typeof evaluation === 'object' && Object.keys(evaluation).sort().join(',') === 'contractBundleDigest,goalRevision,id,policyRevision,schemaVersion'
    && evaluation.schemaVersion === 1 && typeof evaluation.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(evaluation.id)
    && typeof evaluation.goalRevision === 'string' && evaluation.goalRevision.length > 0 && evaluation.goalRevision.length <= 128
    && typeof evaluation.policyRevision === 'string' && evaluation.policyRevision.length > 0 && evaluation.policyRevision.length <= 128
    && typeof evaluation.contractBundleDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(evaluation.contractBundleDigest), 'INVALID_EVALUATION_CONTEXT');
  const { digest: planDigest, ...plan } = request.plan;
  requireValue(await digest(plan) === planDigest && request.plan.candidateId === request.candidate.id && request.plan.candidateDigest === request.candidate.digest, 'INVALID_PLAN');
  requireValue(request.plan.jobs.filter(job => job.id === request.job.id && canonicalize(job) === canonicalize(request.job)).length === 1, 'UNREGISTERED_JOB');
  const probe = probes.find(p => request.job.id.endsWith(`:${p.id}`));
  requireValue(probe && request.job.required && request.job.evidenceClass === 'protected-behavioural', 'UNREGISTERED_RECIPE');
  requireValue(await digest(await evaluationInput(request.candidate, probe, env.EVALUATION_IMAGE_DIGEST, env.CHECKER_IMPLEMENTATION_DIGEST, request.scope, evaluation)) === request.job.inputDigest, 'INPUT_DIGEST_MISMATCH');
  requireValue(request.job.id === `${evaluation.id}:${probe.id}`, 'EVALUATION_EXECUTION_IDENTITY_MISMATCH');
  requireValue(request.source.commit === request.candidate.commit && request.source.commitBytesDigest === request.candidate.commitBytesDigest && request.source.manifestDigest === request.candidate.manifestDigest && await digest(request.source.manifest) === request.candidate.manifestDigest, 'SOURCE_IDENTITY_MISMATCH');
  requireValue(!containsTypeScriptSource(request.source.manifest), 'TYPESCRIPT_PROTECTED_PROFILE_UNREGISTERED', 409);
  const candidate = { id: request.candidate.id, digest: request.candidate.digest, commit: request.candidate.commit, commitBytesDigest: request.candidate.commitBytesDigest, parent: request.candidate.parent, manifestDigest: request.candidate.manifestDigest };
  const sourceCheck = JSON.parse(getKernel().validate_git_source(canonicalize({ candidate, manifest: request.source.manifest, gitObjects: await sourceObjects(request, env) })));
  requireValue(sourceCheck.valid, sourceCheck.reason || 'SOURCE_VERIFICATION_FAILED');
  return probe;
}

type ScheduledJobs = Record<string, { digest: string; object: string; status: 'QUEUED' | 'ACTIVE' | 'DONE'; priority?: number }>;
type ScheduledJob = { key: string; digest: string; object: string; status: 'QUEUED' | 'ACTIVE' | 'DONE'; priority: number; project_key: string; created_at_ms: number | null };
const DEPENDENCY_TIMEOUT_MS = 2000;
const MAX_PENDING_JOBS = 256;
const schedulerProject = (request: EvaluationRequest) => canonicalize(request.scope);

/** Two durable slots. Unknown dispatch keeps its slot until the whole generation is stopped. */
export class EvaluationScheduler extends DurableObject<Env> {
  private pumping = false;
  private readonly statusCalls = new Map<string, Promise<Awaited<ReturnType<EvaluationSandbox['status']>>>>();
  private readonly dispatchCalls = new Map<string, Promise<unknown>>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS scheduled_jobs(key TEXT PRIMARY KEY,digest TEXT NOT NULL,object TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('QUEUED','ACTIVE','DONE')),priority INTEGER NOT NULL,project_key TEXT NOT NULL,created_at_ms INTEGER CHECK(created_at_ms IS NULL OR created_at_ms >= 0)); CREATE INDEX IF NOT EXISTS scheduled_jobs_status ON scheduled_jobs(status); CREATE TABLE IF NOT EXISTS scheduler_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);");
      // Preexisting SQL rows and the older KV inventory have no trustworthy
      // creation time. NULL survives migrations and later duplicate requests.
      if (!ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(scheduled_jobs)').toArray().some(column => column.name === 'created_at_ms'))
        ctx.storage.sql.exec('ALTER TABLE scheduled_jobs ADD COLUMN created_at_ms INTEGER CHECK(created_at_ms IS NULL OR created_at_ms >= 0)');
      ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS scheduled_jobs_project_age ON scheduled_jobs(project_key,status,created_at_ms)');
      if (!ctx.storage.sql.exec('SELECT version FROM scheduler_schema WHERE id=1').toArray().length) {
        const legacy = await ctx.storage.get<ScheduledJobs>('jobs') || {};
        // The old bounded map remains an inert backup. Rows and the migration
        // marker commit together; a restart cannot partially migrate or reset it.
        ctx.storage.transactionSync(() => {
          requireValue(Object.keys(legacy).length <= 256, 'SCHEDULER_LEGACY_INVENTORY');
          for (const [key, job] of Object.entries(legacy)) {
            requireValue(/^[a-f0-9]{64}$/.test(key) && /^sha256:[a-f0-9]{64}$/.test(job.digest) && /^sha256:[a-f0-9]{64}$/.test(job.object) && ['QUEUED', 'ACTIVE', 'DONE'].includes(job.status) && [0, 1].includes(job.priority ?? 0), 'SCHEDULER_LEGACY_RECORD');
            const previous = ctx.storage.sql.exec<ScheduledJob>('SELECT * FROM scheduled_jobs WHERE key=?', key).toArray()[0];
            requireValue(!previous || previous.digest === job.digest && previous.object === job.object && previous.status === job.status && previous.priority === (job.priority ?? 0), 'SCHEDULER_MIGRATION_CONFLICT');
            ctx.storage.sql.exec('INSERT OR IGNORE INTO scheduled_jobs(key,digest,object,status,priority,project_key,created_at_ms) VALUES(?,?,?,?,?,?,NULL)', key, job.digest, job.object, job.status, job.priority ?? 0, 'legacy');
          }
          requireValue(ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM scheduled_jobs WHERE status='ACTIVE'").one().count <= 2, 'SCHEDULER_CAPACITY_CONFLICT');
          ctx.storage.sql.exec('INSERT INTO scheduler_schema VALUES(1,1)');
        });
      }
      if (this.pending() && await ctx.storage.getAlarm() === null) await ctx.storage.setAlarm(Date.now() + 1000);
    });
  }
  private pending(): boolean { return this.ctx.storage.sql.exec("SELECT key FROM scheduled_jobs WHERE status IN ('QUEUED','ACTIVE') LIMIT 1").toArray().length > 0; }
  /** Read-only, project-filtered inspection. Unknown queue age is explicit for legacy rows. */
  async operations(scope: EvaluationRequest['scope'], requestedJobKey?: string) {
    const projectKey = canonicalize(scope);
    const counts = this.ctx.storage.sql.exec<{ status: string; count: number }>("SELECT status,COUNT(*) AS count FROM scheduled_jobs WHERE project_key=? AND status IN ('QUEUED','ACTIVE') GROUP BY status", projectKey).toArray();
    const oldestQueued = this.ctx.storage.sql.exec<{ created_at_ms: number | null }>("SELECT created_at_ms FROM scheduled_jobs WHERE project_key=? AND status='QUEUED' ORDER BY created_at_ms LIMIT 1", projectKey).toArray()[0];
    const queuedAge = oldestAge(oldestQueued?.created_at_ms, Date.now());
    const selected = requestedJobKey
      ? this.ctx.storage.sql.exec<{ key: string }>('SELECT key FROM scheduled_jobs WHERE project_key=? AND key=? LIMIT 1', projectKey, requestedJobKey).toArray()
      : this.ctx.storage.sql.exec<{ key: string }>("SELECT key FROM scheduled_jobs WHERE project_key=? AND status='ACTIVE' ORDER BY rowid LIMIT 2", projectKey).toArray();
    requireValue(!requestedJobKey || selected.length === 1, 'EVALUATION_JOB_NOT_FOUND', 404);
    const generations = await Promise.all(selected.map(async row => {
      try { return { jobKey: row.key, inspection: 'OBSERVED' as const, state: await withinDeadline(() => this.env.EVALUATIONS.getByName(row.key).operations(), DEPENDENCY_TIMEOUT_MS, 'EVALUATION_INSPECTION_DEADLINE') }; }
      catch { return { jobKey: row.key, inspection: 'UNKNOWN' as const, state: null }; }
    }));
    const keys = new Set(selected.map(row => row.key));
    const recoveryEvents = (await readRecoveryEvents(this.ctx.storage)).filter(row => row.jobKey === null || keys.has(row.jobKey));
    return { schemaVersion: 1, scope, scheduler: { queued: counts.find(row => row.status === 'QUEUED')?.count ?? 0, active: counts.find(row => row.status === 'ACTIVE')?.count ?? 0, oldestQueuedAgeSeconds: queuedAge.ageSeconds, queuedAgeEvidence: queuedAge.evidence }, generations, recoveryEvents,
      recoveryEventCoverage: 'BOUNDED_RECENT_ONLY' };
  }
  async fetch(request: Request) {
    try {
      await internal(request, this.env);
      const input = await parseRequest(request) as EvaluationRequest;
      await validate(input, this.env);
      const key = await identity(input), requestDigest = await digest(input);
      const object = await new ObjectStore(this.env.OBJECTS).put(encoder.encode(canonicalize(input)));
      const status = this.ctx.storage.transactionSync(() => {
        const previous = this.ctx.storage.sql.exec<ScheduledJob>('SELECT * FROM scheduled_jobs WHERE key=?', key).toArray()[0];
        if (previous) { requireValue(previous.digest === requestDigest, 'JOB_ID_REUSE', 409); return previous.status; }
        const pending = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM scheduled_jobs WHERE status IN ('QUEUED','ACTIVE')").one().count;
        requireValue(pending < MAX_PENDING_JOBS, 'EVALUATION_QUEUE_FULL', 429);
        this.ctx.storage.sql.exec('INSERT INTO scheduled_jobs(key,digest,object,status,priority,project_key,created_at_ms) VALUES(?,?,?,?,?,?,?)', key, requestDigest, object, 'QUEUED', input.plan.jobs.length > 1 ? 1 : 0, schedulerProject(input), Date.now());
        return 'QUEUED';
      });
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      this.ctx.waitUntil(this.pump());
      return Response.json({ accepted: true, jobKey: key, status }, { status: 202 });
    } catch (error) { return errorResponse(error); }
  }
  async alarm() { await this.pump(); }
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      // Arm recovery before any downstream wait. A failed/stalled RPC cannot
      // consume the only durable wakeup or release its possibly dispatched slot.
      await this.ctx.storage.setAlarm(Date.now() + 2000);
      const finished: string[] = [];
      const active = this.ctx.storage.sql.exec<ScheduledJob>("SELECT * FROM scheduled_jobs WHERE status='ACTIVE' ORDER BY rowid LIMIT 2").toArray();
      for (const job of active) {
        const key = job.key;
        try {
          const result = await this.rpc(this.statusCalls, key, () => this.env.EVALUATIONS.getByName(key).status(), 'EVALUATION_STATUS_DEADLINE');
          if (result.phase === 'MISSING') {
            // The reserved slot is still held. Retry only the same retained job
            // at the same DO identity; run atomically deduplicates registration.
            await this.dispatch(job);
          }
          if (result.terminationObserved && result.callbackDelivered && result.fixtureClosed) finished.push(key);
        } catch (reason) { await recordRecovery(this.ctx.storage, 'scheduler', 'status', key, reason); }
      }
      for (const key of finished) { this.statusCalls.delete(key); this.dispatchCalls.delete(key); }
      const ready = this.ctx.storage.transactionSync(() => {
        for (const key of finished) this.ctx.storage.sql.exec("UPDATE scheduled_jobs SET status='DONE' WHERE key=? AND status='ACTIVE'", key);
        const active = this.ctx.storage.sql.exec<ScheduledJob>("SELECT * FROM scheduled_jobs WHERE status='ACTIVE' LIMIT 2").toArray();
        const queued = this.ctx.storage.sql.exec<ScheduledJob>("SELECT * FROM scheduled_jobs WHERE status='QUEUED' ORDER BY rowid LIMIT ?", MAX_PENDING_JOBS).toArray();
        const selected: ScheduledJob[] = [];
        while (active.length + selected.length < 2 && queued.length) {
          const occupancy = (job: ScheduledJob) => [...active, ...selected].filter(other => other.project_key === job.project_key).length;
          // Prefer projects without an occupied slot, then release evidence,
          // then FIFO. No history scan is needed, even after years of DONE rows.
          queued.sort((a, b) => occupancy(a) - occupancy(b) || b.priority - a.priority);
          const job = queued.shift()!; selected.push(job);
          this.ctx.storage.sql.exec("UPDATE scheduled_jobs SET status='ACTIVE' WHERE key=?", job.key);
        }
        return selected;
      });
      await Promise.all(ready.map(async job => {
        try { await this.dispatch(job); }
        catch (reason) { await recordRecovery(this.ctx.storage, 'scheduler', 'dispatch', job.key, reason); }
      }));
    } catch (reason) { await recordRecovery(this.ctx.storage, 'scheduler', 'pump', null, reason); }
    finally {
      this.pumping = false;
      if (this.pending()) await this.ctx.storage.setAlarm(Date.now() + 2000);
      else await this.ctx.storage.deleteAlarm();
    }
  }
  private async rpc<T>(calls: Map<string, Promise<T>>, key: string, operation: () => Promise<T>, code: string): Promise<T> {
    let pending = calls.get(key);
    if (!pending) {
      pending = Promise.resolve().then(operation); calls.set(key, pending);
      const clear = () => { if (calls.get(key) === pending) calls.delete(key); };
      // Only one unsettled call of each kind is retained per occupied slot.
      // A timeout observes the same call again; it does not dispatch a duplicate.
      this.ctx.waitUntil(pending.then(clear, clear));
    }
    return withinDeadline(() => pending!, DEPENDENCY_TIMEOUT_MS, code);
  }
  private async dispatch(job: ScheduledJob): Promise<void> {
    await this.rpc(this.dispatchCalls, job.key, async () => {
      const bytes = await new ObjectStore(this.env.OBJECTS).get(job.object, 8 * 1024 * 1024);
      const request = parseStrictJson(decoder.decode(bytes)) as EvaluationRequest;
      requireValue(await digest(request) === job.digest && await identity(request) === job.key, 'SCHEDULED_REQUEST_IDENTITY');
      return this.env.EVALUATIONS.getByName(job.key).run(request);
    }, 'EVALUATION_DISPATCH_DEADLINE');
  }
}

interface ReadBarrier { phase: 'ARMED' | 'CAPTURED' | 'RELEASED' | 'FENCED'; deadline: number; capturedValue?: number }
interface StoreState { active: boolean; value: number; reads: number; accesses: { method: string; value: number }[]; readBarrier?: ReadBarrier }
/** This storage is inaccessible to the candidate except through its restricted data interface. */
export class FixtureStore extends DurableObject<Env> {
  private barrier?: { captured: Promise<void>; markCaptured(): void; released: Promise<void>; release(): void };
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      // An in-flight data response cannot be reconstructed. Its durable stage
      // survives so a restarted fixture cannot silently resume the experiment.
      const state = await ctx.storage.get<StoreState>('state');
      if (state?.readBarrier && ['ARMED', 'CAPTURED'].includes(state.readBarrier.phase)) await this.close();
    });
  }
  async armReadBarrier(deadline: number): Promise<void> {
    requireValue(Number.isSafeInteger(deadline) && deadline > Date.now() && deadline <= Date.now() + 10000, 'FIXTURE_BARRIER_DEADLINE');
    await this.ctx.storage.transaction(async storage => {
      const state = await storage.get<StoreState>('state'); requireValue(state?.active, 'FIXTURE_FENCED', 403);
      requireValue(!state.readBarrier && state.reads === 0 && state.accesses.length === 0, 'FIXTURE_BARRIER_ALREADY_USED', 409);
      state.readBarrier = { phase: 'ARMED', deadline }; await storage.put('state', state);
    });
    let markCaptured!: () => void, release!: () => void;
    this.barrier = { captured: new Promise<void>(resolve => { markCaptured = resolve; }), markCaptured: () => markCaptured(),
      released: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
    try { await this.ctx.storage.setAlarm(deadline); } catch (error) { await this.close(); throw error; }
  }
  async waitForReadCapture(): Promise<{ capturedValue: number; reads: number }> {
    const state = await this.snapshot(); requireValue(state?.active && state.readBarrier && this.barrier, 'FIXTURE_FENCED', 403);
    await withinDeadline(() => this.barrier!.captured, Math.max(1, state.readBarrier.deadline - Date.now()), 'FIXTURE_BARRIER_DEADLINE');
    const current = await this.snapshot();
    requireValue(current?.active && current.readBarrier?.phase === 'CAPTURED' && current.readBarrier.deadline > Date.now() && current.readBarrier.capturedValue !== undefined, 'FIXTURE_FENCED', 403);
    return { capturedValue: current.readBarrier.capturedValue, reads: current.reads };
  }
  async releaseReadBarrier(): Promise<void> {
    await this.ctx.storage.transaction(async storage => {
      const state = await storage.get<StoreState>('state');
      requireValue(state?.active && state.readBarrier?.phase === 'CAPTURED' && state.readBarrier.deadline > Date.now() && this.barrier, 'FIXTURE_FENCED', 403);
      state.readBarrier.phase = 'RELEASED'; await storage.put('state', state);
    });
    this.barrier!.release();
  }
  async alarm(): Promise<void> { await this.close(); }
  async initialize(value: number) {
    await this.ctx.storage.transaction(async storage => {
      requireValue(!await storage.get('state') && !await storage.get('closed'), 'FIXTURE_ALREADY_INITIALIZED', 409);
      await storage.put('state', { active: true, value, reads: 0, accesses: [] } satisfies StoreState);
    });
  }
  async snapshot() { return await this.ctx.storage.get<StoreState>('state'); }
  async close() {
    await this.ctx.storage.transaction(async storage => {
      // Closing an as-yet uninitialized fixture still permanently fences it.
      // A late initialization for this registered job identity cannot reopen it.
      await storage.put('closed', true);
      const state = await storage.get<StoreState>('state');
      if (state) { state.active = false; if (state.readBarrier) state.readBarrier.phase = 'FENCED'; await storage.put('state', state); }
    });
    this.barrier?.markCaptured(); this.barrier?.release();
  }
  async fetch(request: Request) {
    try {
      const url = new URL(request.url);
      requireValue(url.pathname === '/store/value' && !url.search, 'FIXTURE_ROUTE_DENIED', 403);
      let value: number | undefined;
      // Candidate body I/O may yield to close(). No captured pre-I/O state is
      // used to authorize or overwrite the durable fixture after that yield.
      if (request.method === 'PUT') {
        const input = await parseRequest(request, 1024) as { value: number };
        requireValue(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 1 && Number.isSafeInteger(input.value), 'FIXTURE_INTEGER_REQUIRED');
        value = input.value;
      }
      const result = await this.ctx.storage.transaction(async storage => {
        const state = await storage.get<StoreState>('state');
        requireValue(state?.active, 'FIXTURE_FENCED', 403);
        requireValue(!state.readBarrier || state.readBarrier.deadline > Date.now(), 'FIXTURE_BARRIER_DEADLINE', 408);
        requireValue(state.accesses.length < 128, 'FIXTURE_ROUTE_DENIED', 403);
        let held = false;
        if (request.method === 'GET') {
          if (state.readBarrier && ['ARMED', 'CAPTURED'].includes(state.readBarrier.phase)) {
            requireValue(state.readBarrier.phase === 'ARMED' && state.readBarrier.deadline > Date.now() && this.barrier, 'FIXTURE_BARRIER_UNAVAILABLE', 409);
            state.readBarrier.phase = 'CAPTURED'; state.readBarrier.capturedValue = state.value; held = true;
          }
          state.reads++;
        }
        else if (request.method === 'PUT') state.value = value!;
        else return null;
        state.accesses.push({ method: request.method, value: state.value });
        await storage.put('state', state);
        return { value: state.value, held, deadline: state.readBarrier?.deadline };
      });
      if (result?.held) {
        // The capture transaction has committed. Waiting here leaves PUT and
        // the private release/close RPCs free to enter this Durable Object.
        this.barrier!.markCaptured();
        try { await withinDeadline(() => this.barrier!.released, Math.max(1, result.deadline! - Date.now()), 'FIXTURE_BARRIER_DEADLINE'); }
        catch (error) { await this.close(); throw error; }
        const current = await this.snapshot();
        requireValue(current?.active && current.readBarrier?.phase === 'RELEASED' && current.readBarrier.deadline > Date.now(), 'FIXTURE_FENCED', 403);
      }
      return result === null ? new Response(null, { status: 405 }) : Response.json({ value: result.value });
    } catch (error) { return errorResponse(error); }
  }
}
/** Controller-issued props bind the route; caller headers cannot select another fixture. */
export class FixtureEgress extends WorkerEntrypoint<Env, { jobKey: string }> {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.hostname !== 'fixture.internal' || url.pathname !== '/store/value') return new Response(null, { status: 403 });
    return this.env.FIXTURES.get(this.env.FIXTURES.idFromName(this.ctx.props.jobKey)).fetch(request);
  }
}

export class EvaluationSandbox extends DurableObject<Env> {
  private executing = false;
  /** Owned conformance replaces only native effects; production uses ctx.container. */
  protected executionContainer(): Container | undefined { return this.ctx.container; }
  /** Owned failure injection replaces only the initial alarm effect. */
  protected async armExecutionDeadline(deadline: number): Promise<void> { await this.ctx.storage.setAlarm(deadline); }
  /** Retains actual content-addressed R2 readback while exposing an owned timing seam. */
  protected async retainObservation(bytes: Uint8Array): Promise<string> { return new ObjectStore(this.env.OBJECTS).put(bytes); }
  /** A narrow lifecycle seam; production always uses its bound whole container. */
  protected stopContainer(): Pick<Container, 'running' | 'destroy' | 'inspect'> | undefined { return this.executionContainer(); }
  /** No status(), stop(), callback retry or container inspection effects. */
  async operations() {
    const record = await this.ctx.storage.get<JobRecord>('job');
    return { phase: record?.phase ?? 'MISSING', deadline: record?.deadline ?? null,
      executionStage: record?.executionStage ?? null,
      terminationObserved: record?.terminationObserved ?? false, fixtureClosed: record?.fixtureClosed ?? false,
      callbackFrozenAt: record?.callback ? record.callbackFrozenAt ?? null : null,
      callbackDelivered: record?.callbackDelivered ?? false,
      recoveryEvents: await readRecoveryEvents(this.ctx.storage), recoveryEvictions: await readRecoveryEvictions(this.ctx.storage) };
  }
  private sameJob(retained: JobRecord | undefined, record: JobRecord): asserts retained is JobRecord {
    requireValue(retained && retained.requestDigest === record.requestDigest && retained.jobKey === record.jobKey, 'EVALUATION_GENERATION_CHANGED', 409);
  }
  private open(record: JobRecord): void {
    requireValue(!record.terminationObserved && !record.callback && ['RESERVED', 'START_MAY_HAVE_DISPATCHED', 'RUNNING'].includes(record.phase) && record.deadline > Date.now(), 'EVALUATION_GENERATION_FENCED', 409);
  }
  private async continuation(record: JobRecord, phase?: JobRecord['phase'], stage?: ExecutionStage): Promise<JobRecord> {
    return this.ctx.storage.transaction(async storage => {
      const retained = await storage.get<JobRecord>('job'); this.sameJob(retained, record); this.open(retained);
      if (phase) retained.phase = phase;
      if (stage) retained.executionStage = stage;
      if (phase || stage) await storage.put('job', retained);
      return retained;
    });
  }
  private async stop(record: JobRecord) {
    const requested = await this.ctx.storage.transaction(async storage => {
      const retained = await storage.get<JobRecord>('job'); this.sameJob(retained, record);
      if (!retained.terminationObserved) { retained.phase = 'STOP_REQUESTED'; await storage.put('job', retained); }
      return retained;
    });
    Object.assign(record, requested);
    await this.ctx.storage.setAlarm(Date.now() + 5000);
    // Fixture fencing and native destruction are independent. A missing close
    // acknowledgment keeps the slot occupied but cannot leave the process alive.
    const closing = requested.fixtureClosed ? Promise.resolve(true) : withinDeadline(
      () => this.env.FIXTURES.getByName(record.jobKey).close(), DEPENDENCY_TIMEOUT_MS, 'FIXTURE_CLOSE_DEADLINE',
    ).then(() => true, async reason => { await recordRecovery(this.ctx.storage, 'generation', 'fixture-close', record.jobKey, reason); return false; });
    const container = this.stopContainer();
    // A dispatched native start need not be visible as running yet. Destroy
    // cancels that possible effect before a stop can release its reservation.
    let terminationObserved = requested.terminationObserved;
    if (!terminationObserved) {
      try { if (container) await container.destroy(); terminationObserved = !container || await container.inspect() === null; }
      catch (reason) { await recordRecovery(this.ctx.storage, 'generation', 'container-stop', record.jobKey, reason); }
    }
    const fixtureClosed = await closing;
    const stopped = await this.ctx.storage.transaction(async storage => {
      const retained = await storage.get<JobRecord>('job'); this.sameJob(retained, record);
      retained.terminationObserved ||= terminationObserved;
      retained.fixtureClosed ||= fixtureClosed;
      if (retained.terminationObserved) retained.phase = 'STOPPED';
      await storage.put('job', retained); return retained;
    });
    Object.assign(record, stopped);
    return record.terminationObserved && record.fixtureClosed === true;
  }
  async run(request: EvaluationRequest) {
    const probe = await validate(request, this.env), requestDigest = await digest(request);
    const initial: JobRecord = { request, requestDigest, jobKey: await identity(request), deadline: Date.now() + 30000, phase: 'RESERVED', executionStage: 'startup-alarm', terminationObserved: false };
    const registration = await this.ctx.storage.transaction(async storage => {
      const retained = await storage.get<JobRecord>('job');
      if (retained) {
        requireValue(retained.requestDigest === requestDigest, 'JOB_ID_REUSE', 409);
        return { record: retained, created: false };
      }
      await storage.put('job', initial);
      return { record: initial, created: true };
    });
    const record = registration.record;
    if (registration.created) {
      this.executing = true;
      try { await this.armExecutionDeadline(record.deadline); }
      catch (error) {
        await recordRecovery(this.ctx.storage, 'generation', 'startup-alarm', record.jobKey, error);
        this.executing = false; throw error;
      }
      // Internal RPC acknowledgment means durable registration, not completion.
      // This DO owns execution; scheduler response deadlines cannot cancel it.
      this.ctx.waitUntil(this.execute(record, probe).catch(async reason => {
        await recordRecovery(this.ctx.storage, 'generation', 'execution', record.jobKey, reason);
        await this.ctx.storage.setAlarm(Date.now() + 1000);
      }).finally(() => { this.executing = false; }));
    }
    return { accepted: true, jobKey: record.jobKey, requestDigest: record.requestDigest };
  }
  async status() {
    const record = await this.ctx.storage.get<JobRecord>('job');
    if (!record) return { terminationObserved: false, callbackDelivered: false, fixtureClosed: false, phase: 'MISSING' };
    if (!record.terminationObserved || !record.fixtureClosed || !record.callbackDelivered) await this.ctx.storage.setAlarm(Date.now() + 5000);
    // A terminal observation is not evidence that its generation stopped.
    // Retry whole-container termination even after INCONCLUSIVE is frozen.
    if ((!record.terminationObserved || !record.fixtureClosed) && (!this.executing || record.phase === 'STOP_REQUESTED' || Date.now() >= record.deadline)) {
      try { await this.stop(record); } catch (reason) { await recordRecovery(this.ctx.storage, 'generation', 'status-stop', record.jobKey, reason); await this.ctx.storage.setAlarm(Date.now() + 5000); }
    }
    if (!this.executing && !record.callback) {
      await recordRecovery(this.ctx.storage, 'generation', 'continuation-lost', record.jobKey, new PlatformError('EVALUATOR_CONTINUATION_LOST'));
      await this.freeze(record, 'INCONCLUSIVE', [], 'Evaluator continuation was lost; its generation is fenced and termination is observed separately.');
    }
    if (record.callback && !record.callbackDelivered) await this.deliver(record);
    if (!record.terminationObserved || !record.fixtureClosed || !record.callbackDelivered) await this.ctx.storage.setAlarm(Date.now() + 5000);
    return { terminationObserved: record.terminationObserved, callbackDelivered: !!record.callbackDelivered, fixtureClosed: record.fixtureClosed === true, phase: record.phase };
  }
  async alarm() {
    const record = await this.ctx.storage.get<JobRecord>('job');
    if (!record) return;
    if (!record.terminationObserved || !record.fixtureClosed || !record.callbackDelivered) await this.ctx.storage.setAlarm(Date.now() + 5000);
    if ((!record.terminationObserved || !record.fixtureClosed) && (record.callback || !this.executing || record.phase === 'STOP_REQUESTED' || Date.now() >= record.deadline)) {
      try { await this.stop(record); } catch (reason) { await recordRecovery(this.ctx.storage, 'generation', 'alarm-stop', record.jobKey, reason); /* Frozen output stays immutable; this generation still holds its slot. */ }
    }
    if (!record.callback && Date.now() >= record.deadline && !this.executing) await this.freeze(record, 'TIMEOUT', [], 'Durable deadline elapsed.');
    if (record.callback && !record.callbackDelivered) await this.deliver(record);
    if (!record.terminationObserved || !record.fixtureClosed || !record.callbackDelivered) await this.ctx.storage.setAlarm(Date.now() + 5000);
  }
  private async execute(record: JobRecord, probe: Probe) {
    const observations: unknown[] = [];
    let outcome: Outcome = 'PASS', error: string | undefined;
    let stage: ExecutionStage = 'container-lookup';
    try {
      record = await this.continuation(record, undefined, stage);
      const container = this.executionContainer();
      requireValue(container, 'CONTAINER_UNAVAILABLE', 503);
      const image = container.images.base;
      requireValue(image?.endsWith(`@${this.env.EVALUATION_IMAGE_DIGEST}`), 'IMAGE_DIGEST_MISMATCH', 503);
      const loopback = this.ctx.exports as unknown as { FixtureEgress(options: { props: { jobKey: string } }): Fetcher };
      stage = 'outbound-intercept'; record = await this.continuation(record, undefined, stage);
      await container.interceptOutboundHttp('fixture.internal', loopback.FixtureEgress({ props: { jobKey: record.jobKey } }));
      stage = 'fixture-initialize'; record = await this.continuation(record, undefined, stage);
      await this.env.FIXTURES.get(this.env.FIXTURES.idFromName(record.jobKey)).initialize(values(probe).initial);
      stage = 'container-start'; record = await this.continuation(record, 'START_MAY_HAVE_DISPATCHED', stage);
      // The reservation and fixture operations yield. Check the latest durable
      // generation immediately before native start, with no intervening await.
      const admitted = await this.ctx.storage.get<JobRecord>('job'); this.sameJob(admitted, record); this.open(admitted);
      requireValue(admitted.phase === 'START_MAY_HAVE_DISPATCHED', 'EVALUATION_GENERATION_FENCED', 409); record = admitted;
      container.start({ image, enableInternet: false, instance: 'lite', entrypoint: ['sleep', 'infinity'], env: { TZ: 'UTC', LC_ALL: 'C' } });
      stage = 'container-inactivity';
      await container.setInactivityTimeout(45000);
      stage = 'source-hydration'; record = await this.continuation(record, undefined, stage);
      const files = new Files(container);
      const objects = await sourceObjects(record.request, this.env); record = await this.continuation(record);
      const hydration = await hydrateVerifiedSource(files, container, record.request.source.manifest, objects);
      stage = 'candidate-start'; record = await this.continuation(record, undefined, stage);
      observations.push({ kind: 'source-hydration', ...hydration });
      const process = await container.exec(['node', '/workspace/server.mjs'], { cwd: '/workspace', env: { PORT: '8080', BIND_HOST: '0.0.0.0', FIXTURE_STORE_URL: 'http://fixture.internal/store/value', FIXTURE_DATA_TOKEN: 'job-scoped-data-only', TZ: 'UTC', LC_ALL: 'C' }, stdout: 'ignore', stderr: 'ignore' });
      // The harness deliberately does not use candidate stdout as an observation.
      void process.exitCode.catch(() => undefined);
      stage = 'candidate-probes'; record = await this.continuation(record, 'RUNNING', stage);
      const app = container.getTcpPort(8080);
      let ready = false;
      for (let retry = 0; retry < 40 && Date.now() < record.deadline; retry++) {
        try { const health = await app.fetch('http://candidate/health', { signal: AbortSignal.timeout(500), redirect: 'manual' }); await health.body?.cancel(); record = await this.continuation(record); if (health.ok) { ready = true; break; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      requireValue(ready, 'CANDIDATE_NOT_READY', 503);
      if (probe.assertion === 'overlap-freshness') {
        const requestValue = async (method: 'GET' | 'PUT', timeoutMs: number, value?: number) => {
          const response = await app.fetch('http://candidate/value', { method, body: method === 'PUT' ? canonicalize({ value }) : undefined,
            headers: method === 'PUT' ? { 'content-type': 'application/json' } : undefined, redirect: 'manual',
            signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, record.deadline - Date.now()))) });
          const body = decoder.decode(await readBounded(response.body, 16384));
          const parsed = parseStrictJson(body) as { value?: number };
          return { status: response.status, observed: Number.isSafeInteger(parsed.value) ? parsed.value! : null, responseDigest: await sha256(body) };
        };
        outcome = await runOverlappingReadWrite({ fixture: this.env.FIXTURES.getByName(record.jobKey), ...values(probe), deadline: record.deadline, observations,
          continuation: async () => { record = await this.continuation(record); }, read: timeoutMs => requestValue('GET', timeoutMs), write: value => requestValue('PUT', 3000, value) });
      } else {
      let expected = values(probe).initial;
      for (const [step, action] of probe.actions.entries()) {
        record = await this.continuation(record);
        requireValue(Date.now() < record.deadline, 'EVALUATION_TIMEOUT', 408);
        const isWrite = action === 'write' || action === 'write-later', next = action === 'write-later' ? values(probe).later : values(probe).replacement;
        const response = await app.fetch(`http://candidate${action === 'page' ? '/' : '/value'}`, { method: isWrite ? 'PUT' : 'GET', body: isWrite ? canonicalize({ value: next }) : undefined, headers: isWrite ? { 'content-type': 'application/json' } : undefined, redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, Math.min(3000, record.deadline - Date.now()))) });
        const body = decoder.decode(await readBounded(response.body, 16384));
        record = await this.continuation(record);
        if (!response.ok) outcome = 'ERROR';
        if (isWrite && response.ok) expected = next;
        let observed: number | null = null;
        if (action === 'page') {
          const match = /<p\s[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-label="Saved value"[^>]*>Saved value:\s*(-?\d+)<\/p>/.exec(body);
          observed = match ? Number(match[1]) : null;
        } else { const value = parseStrictJson(body) as { value?: number }; observed = Number.isSafeInteger(value.value) ? value.value! : null; }
        if (observed !== expected && outcome === 'PASS') outcome = 'FAIL';
        const store = await this.env.FIXTURES.get(this.env.FIXTURES.idFromName(record.jobKey)).snapshot();
        observations.push({ step, action, expected, observed, status: response.status, responseDigest: await sha256(body), storeReadCount: store?.reads || 0 });
      }
      }
    } catch (reason) {
      await recordRecovery(this.ctx.storage, 'generation', stage, record.jobKey, reason);
      const retained = await this.ctx.storage.get<JobRecord>('job'); this.sameJob(retained, record); record = retained;
      outcome = Date.now() >= record.deadline ? 'TIMEOUT' : 'ERROR'; error = recoveryCode(reason);
    }
    finally {
      try { if (!await this.stop(record)) outcome = 'INCONCLUSIVE'; }
      catch { outcome = 'INCONCLUSIVE'; error = 'Whole-container termination remains uncertain.'; }
    }
    await this.freeze(record, outcome, observations, error);
  }
  private async freeze(record: JobRecord, outcome: Outcome, observations: unknown[], error?: string) {
    let stage: 'freeze-load' | 'freeze-snapshot' | 'freeze-retain' | 'freeze-sign' | 'freeze-store' | 'callback-delivery' = 'freeze-load';
    try {
      const prior = await this.ctx.storage.get<JobRecord>('job');
      this.sameJob(prior, record); Object.assign(record, prior);
      if (prior.callback) return;
      stage = 'freeze-snapshot';
      const store = await withinDeadline(() => this.env.FIXTURES.getByName(record.jobKey).snapshot(), DEPENDENCY_TIMEOUT_MS, 'FIXTURE_SNAPSHOT_DEADLINE');
      // Stop has fenced the fixture. Judge store-dependent assertions against
      // these exact retained bytes, never an earlier pre-stop snapshot.
      if (outcome === 'PASS') {
        const probe = probes.find(item => record.request.job.id === `${record.request.evaluation.id}:${item.id}`);
        if (probe?.assertion === 'overlap-freshness' && !validOverlapStoreTrace(store, values(probe).initial, values(probe).replacement)) outcome = 'FAIL';
        if (probe?.assertion === 'cache-benefit' && store?.reads !== 1) outcome = 'FAIL';
      }
      const observation = { schemaVersion: 1, scope: record.request.scope, evaluation: record.request.evaluation, ...(record.request.issuance === undefined ? {} : { issuance: record.request.issuance, checkerKeyId: record.request.checkerKeyId }), jobId: record.request.job.id, inputDigest: record.request.job.inputDigest, candidateDigest: record.request.candidate.digest, outcome, observations, backingStore: store || null, terminationObserved: record.terminationObserved, completedAt: Math.floor(Date.now() / 1000), error: error || null, limitations: ['Finite declared traces are observations, not general correctness.', 'Store reads are measured outside the candidate; no latency benefit is claimed.'] };
      stage = 'freeze-retain';
      const bytes = encoder.encode(canonicalize(observation)), observationDigest = await this.retainObservation(bytes);
      const identity = { id: `evidence-${record.jobKey}`, jobId: record.request.job.id, inputDigest: record.request.job.inputDigest, observationDigest, candidateId: record.request.candidate.id, candidateDigest: record.request.candidate.digest, outcome, evidenceClass: 'protected-behavioural' as const, authorized: true };
      const evidence: AdmissionEvidence = { ...identity, digest: await digest(identity) };
      stage = 'freeze-sign';
      const key = await crypto.subtle.importKey('pkcs8', decodeBase64(this.env.CHECKER_SIGNING_KEY) as BufferSource, 'Ed25519', false, ['sign']);
      requireValue(record.request.checkerKeyId === undefined || record.request.checkerKeyId === this.env.CHECKER_KEY_ID, 'REGISTERED_CHECKER_KEY_MISMATCH');
      const envelope = await signStatement<unknown>(record.request.issuance === undefined ? await statement('evidence', evidence) : await issuedStatement('evidence', evidence, record.request.issuance), record.request.checkerKeyId ?? this.env.CHECKER_KEY_ID, key);
      const callback = { scope: record.request.scope, evidence, envelope, observationBase64: encodeBase64(bytes) };
      // Freeze signed bytes once, after the observation has survived verified R2 read-back.
      stage = 'freeze-store';
      const frozen = await this.ctx.storage.transaction(async storage => {
        const retained = await storage.get<JobRecord>('job'); this.sameJob(retained, record);
        if (!retained.callback) { retained.callback = callback; retained.callbackFrozenAt = Date.now(); await storage.put('job', retained); }
        return retained;
      });
      Object.assign(record, frozen);
      stage = 'callback-delivery';
      await this.deliver(record);
    } catch (reason) {
      await recordRecovery(this.ctx.storage, 'generation', stage, record.jobKey, reason);
      throw reason;
    }
  }
  private async deliver(record: JobRecord) {
    if (!record.callback || record.callbackDelivered) return;
    try {
      const response = await boundedServiceFetch(this.env.AUTHORITY, 'https://authority/internal/observation', { method: 'POST', headers: { authorization: `Bearer ${this.env.EVALUATOR_SERVICE_TOKEN}`, 'content-type': 'application/json' }, body: canonicalize(record.callback) }, DEPENDENCY_TIMEOUT_MS);
      if (response.ok) {
        const acknowledged = await this.ctx.storage.transaction(async storage => {
          const retained = await storage.get<JobRecord>('job'); this.sameJob(retained, record);
          requireValue(canonicalize(retained.callback) === canonicalize(record.callback), 'EVALUATION_CALLBACK_CHANGED', 409);
          retained.callbackDelivered = true; await storage.put('job', retained); return retained;
        });
        Object.assign(record, acknowledged); return;
      }
      await recordRecovery(this.ctx.storage, 'generation', 'callback', record.jobKey, new PlatformError('CALLBACK_NOT_ACKNOWLEDGED'));
    } catch (reason) { await recordRecovery(this.ctx.storage, 'generation', 'callback', record.jobKey, reason); }
    await this.ctx.storage.setAlarm(Date.now() + 5000);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      await internal(request, env);
      if (new URL(request.url).pathname === '/internal/operations' && request.method === 'POST') {
        const input = await parseRequest(request, 4096) as { scope: EvaluationRequest['scope']; jobKey?: string };
        requireValue(input && typeof input === 'object' && !Array.isArray(input) && input.scope?.schemaVersion === 1
          && typeof input.scope.tenantId === 'string' && typeof input.scope.projectId === 'string'
          && typeof input.scope.projectIncarnation === 'string' && (input.jobKey === undefined || /^[a-f0-9]{64}$/.test(input.jobKey)), 'OPERATIONS_SCOPE_REQUIRED');
        return Response.json(await env.SCHEDULER.getByName('bounded-evaluation-pool-v1').operations(input.scope, input.jobKey), { headers: { 'cache-control': 'no-store' } });
      }
      requireValue(new URL(request.url).pathname === '/internal/evaluate' && request.method === 'POST', 'ROUTE_NOT_FOUND', 404);
      return env.SCHEDULER.get(env.SCHEDULER.idFromName('bounded-evaluation-pool-v1')).fetch(request);
    } catch (error) { return errorResponse(error); }
  },
} satisfies ExportedHandler<Env>;
