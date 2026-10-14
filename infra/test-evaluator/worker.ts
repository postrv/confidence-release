// TEST ONLY. Never deploy: exposes fake execution state and scheduler inspection.
import { DurableObject } from 'cloudflare:workers';
import { EvaluationScheduler, EvaluationSandbox, FixtureStore as ProductionFixtureStore, FixtureEgress } from '../../workers/evaluator/index';
import { canonicalize, digest } from '../../packages/protocol/src/index';
import { ObjectStore } from '../../workers/shared/objects';
import { PlatformError } from '../../workers/shared/errors';
import type { EvaluationRequest, EvaluationCallback } from '../../workers/authority/types';
import { hydrationFixture } from './hydration-fixture';
export { FixtureEgress };

/** Inherits production fixture effects; finite test-only body/close controls. */
export class FixtureStore extends ProductionFixtureStore {
  private closeReleases: (() => void)[] = [];
  async holdCloseForTest(hold: boolean): Promise<void> { await this.ctx.storage.put('hold-close', hold); if (!hold) { for (const release of this.closeReleases) release(); this.closeReleases = []; } }
  async changeReadCountOnCloseForTest(): Promise<void> { await this.ctx.storage.put('change-read-count-on-close', true); }
  override async close(): Promise<void> {
    if (await this.ctx.storage.get('hold-close')) { await this.ctx.storage.put('close-entered', true); await new Promise<void>(resolve => this.closeReleases.push(resolve)); }
    await super.close();
    // Owned metadata fault only: no candidate source or extra data-plane I/O.
    await this.ctx.storage.transaction(async storage => {
      if (!await storage.get('change-read-count-on-close')) return;
      const state = await storage.get<NonNullable<Awaited<ReturnType<ProductionFixtureStore['snapshot']>>>>('state');
      if (!state || state.active) throw new Error('OWNED_CLOSED_FIXTURE_REQUIRED');
      state.reads++; await storage.put('state', state); await storage.delete('change-read-count-on-close');
    });
  }
  private held?: { entered: boolean; value: number; controller?: ReadableStreamDefaultController<Uint8Array>; response?: { status: number; body: unknown } };
  private overlapResponse?: { status: number; body: unknown };
  async startReadForTest(): Promise<void> {
    this.ctx.waitUntil(super.fetch(new Request('https://fixture.internal/store/value')).then(async response => { this.overlapResponse = { status: response.status, body: await response.json() }; }));
  }
  async inspectReadForTest(): Promise<unknown> { return this.overlapResponse ?? null; }
  async holdPutForTest(value: number): Promise<void> {
    if (this.held) throw new Error('OWNED_BODY_ALREADY_HELD');
    const held = this.held = { entered: false, value } as NonNullable<FixtureStore['held']>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { held.controller = controller; },
      pull() { held.entered = true; },
    }, { highWaterMark: 0 });
    const pending = super.fetch(new Request('https://fixture.internal/store/value', { method: 'PUT', body }));
    this.ctx.waitUntil(pending.then(async response => { held.response = { status: response.status, body: await response.json() }; }));
  }
  async releasePutForTest(): Promise<void> {
    if (!this.held?.controller || !this.held.entered) throw new Error('OWNED_BODY_NOT_WAITING');
    this.held.controller.enqueue(new TextEncoder().encode(JSON.stringify({ value: this.held.value })));
    this.held.controller.close(); this.held.controller = undefined;
  }
  async inspectHeldForTest(): Promise<unknown> { return { entered: this.held?.entered ?? false, response: this.held?.response ?? null, state: await super.snapshot(), closed: await this.ctx.storage.get('closed') === true, closeEntered: await this.ctx.storage.get('close-entered') === true }; }
}

type FakeState = { requestDigest: string; jobId: string; phase: 'RUNNING' | 'UNKNOWN' | 'STOPPED'; terminationObserved: boolean; callbackDelivered: boolean; fixtureClosed: boolean; registrations: number };
interface Env {
  SCHEDULER: DurableObjectNamespace<TestScheduler>; EVALUATIONS: DurableObjectNamespace<FakeEvaluation>;
  OBJECTS: R2Bucket; EVALUATOR_SERVICE_TOKEN: string;
  TEST_EVALUATIONS: DurableObjectNamespace<TestEvaluationSandbox>;
  FIXTURES: DurableObjectNamespace<FixtureStore>; CALLBACKS: DurableObjectNamespace<TestCallbackReceiver>;
}
export class TestScheduler extends EvaluationScheduler {
  // The production fetch and pump logic are unchanged. Only alarm timing is
  // disabled so controlled fake stop/callback transitions cannot race a timer.
  override async alarm(): Promise<void> {}
  async pumpForTest(): Promise<unknown> {
    for (let wait = 0; (this as any).pumping && wait < 8000; wait++) await new Promise(done => setTimeout(done, 2));
    if ((this as any).pumping) throw new Error('OWNED_PUMP_WAIT_BOUND');
    await super.alarm(); return this.inspect();
  }
  async inspect(): Promise<unknown> { return { jobs: Object.fromEntries(this.ctx.storage.sql.exec<{ key: string; digest: string; object: string; status: string; priority: number; project_key: string; created_at_ms?: number | null }>('SELECT * FROM scheduled_jobs ORDER BY rowid').toArray().map(({ key, ...job }) => [key, job])), pumping: (this as any).pumping, alarm: await this.ctx.storage.getAlarm() }; }
  async seedLegacySqlAgeForTest(input: { scope: EvaluationRequest['scope']; jobKey: string }): Promise<unknown> {
    if (this.ctx.storage.sql.exec('SELECT key FROM scheduled_jobs LIMIT 1').toArray().length) throw new Error('OWNED_LEGACY_SQL_TARGET_NOT_EMPTY');
    this.ctx.storage.sql.exec("DROP TABLE scheduled_jobs; CREATE TABLE scheduled_jobs(key TEXT PRIMARY KEY,digest TEXT NOT NULL,object TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('QUEUED','ACTIVE','DONE')),priority INTEGER NOT NULL,project_key TEXT NOT NULL)");
    this.ctx.storage.sql.exec('INSERT INTO scheduled_jobs VALUES(?,?,?,?,?,?)', input.jobKey, 'sha256:' + 'a'.repeat(64), 'sha256:' + 'b'.repeat(64), 'QUEUED', 0, canonicalize(input.scope));
    return this.inspect();
  }
  async seedLegacyForTest(jobs: unknown): Promise<void> {
    if (this.ctx.storage.sql.exec('SELECT key FROM scheduled_jobs LIMIT 1').toArray().length) throw new Error('OWNED_LEGACY_TARGET_NOT_EMPTY');
    await this.ctx.storage.put('jobs', jobs); this.ctx.storage.sql.exec('DELETE FROM scheduler_schema');
  }
}
export class FakeEvaluation extends DurableObject<Env> {
  private rpcReleases: (() => void)[] = [];
  async setHold(hold: 'status' | 'run' | null): Promise<void> { await this.ctx.storage.put('hold', hold); if (!hold) { for (const release of this.rpcReleases) release(); this.rpcReleases = []; } }
  private async hold(method: string): Promise<void> { if (await this.ctx.storage.get('hold') === method) { await this.ctx.storage.put('hold-entered', method); await this.ctx.storage.put('hold-count', (await this.ctx.storage.get<number>('hold-count') || 0) + 1); await new Promise<void>(resolve => this.rpcReleases.push(resolve)); } }
  async run(request: EvaluationRequest): Promise<unknown> {
    await this.hold('run');
    const requestDigest = await digest(request);
    const call = await this.ctx.storage.transaction(async storage => {
      const attempts = await storage.get<{ jobId: string; requestDigest: string; inputDigest: string; objectsDigest: string }[]>('attempts') || [];
      attempts.push({ jobId: request.job.id, requestDigest, inputDigest: request.job.inputDigest, objectsDigest: request.source.objectsDigest }); await storage.put('attempts', attempts);
      const previous = await storage.get<FakeState>('job'); if (previous && previous.requestDigest !== requestDigest) throw new Error('OWNED_FAKE_JOB_ID_REUSE');
      return { attempts: attempts.length, previous, armed: await storage.get<boolean>('armed') === true };
    });
    // Simulate loss before execution DO registration, rather than a candidate
    // failure. Missing state must be recoverable at the identical job identity.
    if (call.attempts === 1 || !call.armed) throw new Error('OWNED_FAKE_FAILURE_BEFORE_JOB_REGISTRATION');
    await this.ctx.storage.transaction(async storage => {
      const retained = await storage.get<FakeState>('job');
      if (retained) { if (retained.requestDigest !== requestDigest) throw new Error('OWNED_FAKE_JOB_ID_REUSE'); return; }
      await storage.put('job', { requestDigest, jobId: request.job.id, phase: 'RUNNING', terminationObserved: false, callbackDelivered: false, fixtureClosed: false, registrations: 1 } satisfies FakeState);
    });
    return this.status();
  }
  async status(): Promise<unknown> { await this.hold('status'); return this.readStatus(); }
  async operations(): Promise<unknown> { return { phase: (await this.readStatus() as { phase: string }).phase, ownedFake: true }; }
  private async readStatus(): Promise<unknown> {
    const state = await this.ctx.storage.get<FakeState>('job');
    return state ? { phase: state.phase, terminationObserved: state.terminationObserved, callbackDelivered: state.callbackDelivered, fixtureClosed: state.fixtureClosed } : { phase: 'MISSING', terminationObserved: false, callbackDelivered: false, fixtureClosed: false };
  }
  async arm(): Promise<void> { await this.ctx.storage.put('armed', true); }
  async setFakeState(input: Pick<FakeState, 'phase' | 'terminationObserved' | 'callbackDelivered'> & { fixtureClosed?: boolean }): Promise<unknown> {
    if (!['RUNNING', 'UNKNOWN', 'STOPPED'].includes(input.phase) || typeof input.terminationObserved !== 'boolean' || typeof input.callbackDelivered !== 'boolean') throw new Error('OWNED_FAKE_STATE_INVALID');
    const state = await this.ctx.storage.get<FakeState>('job'); if (!state) throw new Error('OWNED_FAKE_JOB_MISSING');
    Object.assign(state, input, { fixtureClosed: input.fixtureClosed ?? input.terminationObserved }); await this.ctx.storage.put('job', state); return this.inspect();
  }
  async inspect(): Promise<unknown> { return { state: await this.ctx.storage.get('job') || null, attempts: await this.ctx.storage.get('attempts') || [], status: await this.readStatus(), holdEntered: await this.ctx.storage.get('hold-entered') || null, holdCount: await this.ctx.storage.get('hold-count') || 0 }; }
}
/** Production status/alarm/stop logic; only whole-container effects are fake. */
export class TestEvaluationSandbox extends EvaluationSandbox {
  private releaseBarriers: (() => void)[] = [];
  private barrier: 'intercept' | 'inactivity' | 'freeze' | null = null;
  private async hold(stage: 'intercept' | 'inactivity' | 'freeze'): Promise<void> {
    if (this.barrier !== stage) return;
    this.ctx.storage.sql.exec('UPDATE owned_execution SET barrier_entered=barrier_entered+1 WHERE id=1');
    await new Promise<void>(resolve => { this.releaseBarriers.push(resolve); });
  }
  private consumeFault(name: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      const fault = this.ctx.storage.sql.exec<{ remaining: number }>('SELECT remaining FROM owned_execution_faults WHERE name=?', name).toArray()[0];
      if (!fault?.remaining) return false;
      this.ctx.storage.sql.exec('UPDATE owned_execution_faults SET remaining=remaining-1 WHERE name=?', name); return true;
    });
  }
  protected override async armExecutionDeadline(deadline: number): Promise<void> {
    if (this.consumeFault('startup-alarm')) throw new Error('PRIVATE_EXECUTION_CANARY_alarm');
    await super.armExecutionDeadline(deadline);
  }
  protected override async retainObservation(bytes: Uint8Array): Promise<string> {
    if (this.consumeFault('freeze-retain')) throw new PlatformError('OBJECT_STORE_DEADLINE_EXCEEDED');
    const retained = await super.retainObservation(bytes); this.ctx.storage.sql.exec('INSERT OR IGNORE INTO owned_retained_observations VALUES(?,?)', retained, bytes.length); await this.hold('freeze'); return retained;
  }
  protected override executionContainer(): Container {
    const storage = this.ctx.storage, controller = this;
    if (this.consumeFault('container-lookup')) throw new Error('PRIVATE_EXECUTION_CANARY_lookup');
    return {
      images: { base: `owned-fake@${this.env.EVALUATION_IMAGE_DIGEST}` },
      get running() { return storage.sql.exec<{ running: number }>('SELECT running FROM owned_execution WHERE id=1').one().running === 1; },
      async interceptOutboundHttp() { if (controller.consumeFault('outbound-intercept')) throw new Error('PRIVATE_EXECUTION_CANARY_intercept'); await controller.hold('intercept'); },
      start() { storage.sql.exec('UPDATE owned_execution SET start_calls=start_calls+1,pending=1 WHERE id=1'); },
      async setInactivityTimeout() { if (controller.consumeFault('container-inactivity')) throw new Error('The container has not been started'); await controller.hold('inactivity'); },
      async exec() { storage.sql.exec('UPDATE owned_execution SET exec_calls=exec_calls+1 WHERE id=1'); throw new Error('OWNED_EVALUATION_EXEC_FORBIDDEN'); },
      async destroy() { storage.sql.exec('UPDATE owned_execution SET destroy_calls=destroy_calls+1,running=0,pending=0 WHERE id=1'); },
      async inspect() { return storage.sql.exec<{ pending: number; running: number }>('SELECT pending,running FROM owned_execution WHERE id=1').toArray().some(row => row.pending || row.running) ? {} : null; },
    } as unknown as Container; // Explicit partial native-effects double; no application executes.
  }
  override async alarm(): Promise<void> {} // explicit invocation controls timing
  protected override stopContainer(): Pick<Container, 'running' | 'destroy' | 'inspect'> {
    const storage = this.ctx.storage;
    if (storage.sql.exec("SELECT name FROM sqlite_master WHERE name='owned_execution'").toArray().length) return this.executionContainer();
    return {
      async inspect() { return storage.sql.exec<{ running: number }>('SELECT running FROM owned_container WHERE id=1').one().running ? {} as ContainerInfo : null; },
      get running() { return storage.sql.exec<{ running: number }>('SELECT running FROM owned_container WHERE id=1').one().running === 1; },
      async destroy() {
        let fail = false;
        storage.transactionSync(() => {
          const row = storage.sql.exec<{ failures: number }>('SELECT failures FROM owned_container WHERE id=1').one();
          fail = row.failures > 0;
          storage.sql.exec('UPDATE owned_container SET destroy_calls=destroy_calls+1,failures=MAX(0,failures-1),running=? WHERE id=1', fail ? 1 : 0);
        });
        if (fail) throw new Error('OWNED_FAKE_DESTROY_UNCONFIRMED');
      },
    };
  }
  async setupStartForTest(stage: 'intercept' | 'inactivity' | 'freeze' | null): Promise<void> {
    this.barrier = stage;
    this.ctx.storage.sql.exec('CREATE TABLE owned_execution(id INTEGER PRIMARY KEY,running INTEGER NOT NULL,pending INTEGER NOT NULL,start_calls INTEGER NOT NULL,exec_calls INTEGER NOT NULL,destroy_calls INTEGER NOT NULL,barrier_entered INTEGER NOT NULL)');
    this.ctx.storage.sql.exec('INSERT INTO owned_execution VALUES(1,0,0,0,0,0,0)');
    this.ctx.storage.sql.exec('CREATE TABLE owned_retained_observations(digest TEXT PRIMARY KEY,bytes INTEGER NOT NULL)');
    this.ctx.storage.sql.exec('CREATE TABLE owned_execution_faults(name TEXT PRIMARY KEY,remaining INTEGER NOT NULL)');
  }
  async setupDiagnosticsForTest(faults: string[]): Promise<void> {
    await this.setupStartForTest(null);
    for (const name of faults) this.ctx.storage.sql.exec('INSERT INTO owned_execution_faults VALUES(?,1)', name);
  }
  async inspectStartForTest(): Promise<unknown> { return { job: await this.ctx.storage.get('job'), operations: await this.operations(), container: this.ctx.storage.sql.exec('SELECT * FROM owned_execution WHERE id=1').one(), retainedObservations: this.ctx.storage.sql.exec('SELECT * FROM owned_retained_observations').toArray() }; }
  async releaseStartForTest(): Promise<void> { this.barrier = null; for (const release of this.releaseBarriers) release(); this.releaseBarriers = []; }
  async releaseLastStartForTest(): Promise<void> { const release = this.releaseBarriers.pop(); if (!release) throw new Error('OWNED_START_BARRIER_MISSING'); release(); }
  async seedFreezeForTest(request: EvaluationRequest): Promise<void> { await this.setupStartForTest('freeze'); await this.ctx.storage.put('job', { request, requestDigest: await digest(request), jobKey: (await digest({ scope: request.scope, jobId: request.job.id })).slice(7), deadline: Date.now() + 30000, phase: 'START_MAY_HAVE_DISPATCHED', terminationObserved: false }); this.ctx.storage.sql.exec('UPDATE owned_execution SET pending=1 WHERE id=1'); }
  async freezeForTest(): Promise<unknown> { await (this as any).freeze(await this.ctx.storage.get('job'), 'INCONCLUSIVE', [], 'Owned synthetic pre-stop observation to test concurrent freeze selection.'); return this.inspectStartForTest(); }
  async finishStoreProbeForTest(outcome: 'PASS' | 'ERROR' | 'INCONCLUSIVE'): Promise<unknown> {
    if (!['PASS', 'ERROR', 'INCONCLUSIVE'].includes(outcome)) throw new Error('OWNED_OUTCOME_INVALID');
    const record = await this.ctx.storage.get<any>('job');
    if (!record || ![':overlapping-read-write', ':retained-cache-benefit'].some(suffix => record.request.job.id.endsWith(suffix))) throw new Error('OWNED_STORE_PROBE_REQUIRED');
    this.barrier = null;
    if (!await (this as any).stop(record)) outcome = 'INCONCLUSIVE';
    await (this as any).freeze(record, outcome, [{ kind: 'owned-synthetic-probe-completion' }]);
    return this.inspectStartForTest();
  }
  async stopStartForTest(deadline: boolean): Promise<unknown> {
    const record = await this.ctx.storage.get<any>('job'); if (!record) throw new Error('OWNED_START_NOT_REGISTERED');
    if (deadline) { record.deadline = Date.now() - 1; await this.ctx.storage.put('job', record); await super.alarm(); }
    else await (this as any).stop(record);
    return this.inspectStartForTest();
  }
  async alarmStartForTest(): Promise<unknown> { await super.alarm(); await this.ctx.storage.deleteAlarm(); return this.inspectStartForTest(); }
  async seedStopForTest(input: { request: EvaluationRequest; callback: EvaluationCallback }): Promise<void> {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS owned_container(id INTEGER PRIMARY KEY,running INTEGER NOT NULL,failures INTEGER NOT NULL,destroy_calls INTEGER NOT NULL)');
    this.ctx.storage.sql.exec('INSERT INTO owned_container(id,running,failures,destroy_calls) VALUES(1,1,1,0)');
    const jobKey = (await digest({ scope: input.request.scope, jobId: input.request.job.id })).slice(7);
    await this.ctx.storage.put('job', { request: input.request, requestDigest: await digest(input.request), jobKey, deadline: Date.now() - 1, phase: 'STOP_REQUESTED', callback: input.callback, callbackDelivered: false, terminationObserved: false });
  }
  async inspectStopForTest(): Promise<unknown> { return { job: await this.ctx.storage.get('job'), container: this.ctx.storage.sql.exec('SELECT running,failures,destroy_calls FROM owned_container WHERE id=1').one() }; }
  async alarmStopForTest(): Promise<unknown> { await super.alarm(); await this.ctx.storage.deleteAlarm(); return this.inspectStopForTest(); }
}
/** Owned receiver acknowledges bytes; it does not impersonate real authority. */
export class TestCallbackReceiver extends DurableObject<Env> {
  private releases: (() => void)[] = [];
  async setReject(reject: boolean): Promise<void> { await this.ctx.storage.put('reject', reject); }
  async setHold(hold: boolean): Promise<void> { await this.ctx.storage.put('hold', hold); if (!hold) { for (const release of this.releases) release(); this.releases = []; } }
  async releaseLast(): Promise<void> { const release = this.releases.pop(); if (!release) throw new Error('OWNED_HELD_CALLBACK_MISSING'); release(); }
  async inspect(): Promise<unknown> { return await this.ctx.storage.get('received') || []; }
  async fetch(request: Request): Promise<Response> {
    const body = await request.text(), bodyDigest = await digest(JSON.parse(body));
    const received = await this.ctx.storage.get<{ digest: string; acknowledged: boolean }[]>('received') || [];
    const acknowledged = !await this.ctx.storage.get('reject'); received.push({ digest: bodyDigest, acknowledged }); await this.ctx.storage.put('received', received);
    if (await this.ctx.storage.get('hold')) await new Promise<void>(resolve => this.releases.push(resolve));
    return Response.json({ ownedFakeAcknowledgement: acknowledged }, { status: acknowledged ? 200 : 503 });
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url), path = url.pathname, scheduler = env.SCHEDULER.getByName(url.searchParams.get('scheduler') || 'owned-scheduler');
      if (path === '/internal/observation') return env.CALLBACKS.getByName('owned-callback-receiver').fetch(request);
      const input: any = request.method === 'POST' ? await request.json() : {};
      if (path.startsWith('/fixture-')) {
        const fixture = env.FIXTURES.getByName(input.fixtureId);
        if (path === '/fixture-initialize') { await fixture.initialize(input.value); return Response.json({ initialized: true }); }
        if (path === '/fixture-inspect') return Response.json(await fixture.inspectHeldForTest());
        if (path === '/fixture-hold-put') { await fixture.holdPutForTest(input.value); return Response.json({ held: true }); }
        if (path === '/fixture-release-put') { await fixture.releasePutForTest(); return Response.json({ released: true }); }
        if (path === '/fixture-hold-close') { await fixture.holdCloseForTest(input.hold); return Response.json({ hold: input.hold }); }
        if (path === '/fixture-change-read-count-on-close') { await fixture.changeReadCountOnCloseForTest(); return Response.json({ armed: true }); }
        if (path === '/fixture-close') { await fixture.close(); return Response.json({ closed: true }); }
        if (path === '/fixture-get') return fixture.fetch(new Request('https://fixture.internal/store/value'));
        if (path === '/fixture-put') return fixture.fetch(new Request('https://fixture.internal/store/value', { method: 'PUT', body: JSON.stringify({ value: input.value }) }));
        if (path === '/fixture-arm-read') { await fixture.armReadBarrier(input.deadline); return Response.json({ armed: true }); }
        if (path === '/fixture-await-capture') return Response.json(await fixture.waitForReadCapture());
        if (path === '/fixture-release-read') { await fixture.releaseReadBarrier(); return Response.json({ released: true }); }
        if (path === '/fixture-start-read') { await fixture.startReadForTest(); return Response.json({ started: true }); }
        if (path === '/fixture-read-response') return Response.json(await fixture.inspectReadForTest());
        if (path === '/fixture-data-route') return fixture.fetch(new Request('https://fixture.internal' + input.path, { method: input.method }));
      }
      if (path === '/hydration-check') return Response.json(await hydrationFixture(input));
      if (path === '/callback-mode') { await env.CALLBACKS.getByName('owned-callback-receiver').setReject(input.reject); return Response.json({ reject: input.reject }); }
      if (path === '/callback-hold') { await env.CALLBACKS.getByName('owned-callback-receiver').setHold(input.hold); return Response.json({ hold: input.hold }); }
      if (path === '/callback-release-last') { await env.CALLBACKS.getByName('owned-callback-receiver').releaseLast(); return Response.json({ released: true }); }
      if (path === '/callback-inspect') return Response.json(await env.CALLBACKS.getByName('owned-callback-receiver').inspect());
      if (path.startsWith('/stop-')) {
        const stopped = env.TEST_EVALUATIONS.getByName(input.jobKey);
        if (path === '/stop-seed') { await stopped.seedStopForTest(input); return Response.json({ seeded: true }); }
        if (path === '/stop-status') return Response.json(await stopped.status());
        if (path === '/stop-alarm') return Response.json(await stopped.alarmStopForTest());
        if (path === '/stop-inspect') return Response.json(await stopped.inspectStopForTest());
      }
      if (path.startsWith('/start-')) {
        const starting = env.TEST_EVALUATIONS.getByName(input.jobKey);
        if (path === '/start-setup') { await starting.setupStartForTest(input.stage); return Response.json({ setup: true }); }
        if (path === '/start-diagnostics-setup') { await starting.setupDiagnosticsForTest(input.faults); return Response.json({ setup: true }); }
        if (path === '/start-run') return Response.json(await starting.run(input.request));
        if (path === '/start-inspect') return Response.json(await starting.inspectStartForTest());
        if (path === '/start-release') { await starting.releaseStartForTest(); return Response.json({ released: true }); }
        if (path === '/start-release-last') { await starting.releaseLastStartForTest(); return Response.json({ released: true }); }
        if (path === '/start-freeze-seed') { await starting.seedFreezeForTest(input.request); return Response.json({ seeded: true }); }
        if (path === '/start-freeze') return Response.json(await starting.freezeForTest());
        if (path === '/start-finish-store-probe') return Response.json(await starting.finishStoreProbeForTest(input.outcome));
        if (path === '/start-stop') return Response.json(await starting.stopStartForTest(input.deadline));
        if (path === '/start-status') return Response.json(await starting.status());
        if (path === '/start-alarm') return Response.json(await starting.alarmStartForTest());
      }
      if (path === '/enqueue') return scheduler.fetch(new Request('http://scheduler/internal', { method: 'POST', headers: { authorization: `Bearer ${env.EVALUATOR_SERVICE_TOKEN}`, 'content-type': 'application/json' }, body: canonicalize(input) }));
      if (path === '/seed-objects') return Response.json({ digest: await new ObjectStore(env.OBJECTS).put(new TextEncoder().encode(canonicalize(input))) });
      if (path === '/seed-legacy') { await scheduler.seedLegacyForTest(input); return Response.json({ seeded: true }); }
      if (path === '/seed-legacy-sql-age') return Response.json(await scheduler.seedLegacySqlAgeForTest(input));
      if (path === '/pump') return Response.json(await scheduler.pumpForTest());
      if (path === '/operations') return Response.json(await scheduler.operations(input.scope, input.jobKey));
      if (path === '/inspect') return Response.json(await scheduler.inspect());
      const executor = env.EVALUATIONS.getByName(input.jobKey);
      if (path === '/fake-inspect') return Response.json(await executor.inspect());
      if (path === '/fake-hold') { await executor.setHold(input.hold); return Response.json({ hold: input.hold }); }
      if (path === '/fake-arm') { await executor.arm(); return Response.json({ armed: true }); }
      if (path === '/fake-state') return Response.json(await executor.setFakeState(input.state));
      return Response.json({ error: 'UNKNOWN_OWNED_ROUTE' }, { status: 404 });
    } catch (error) { return Response.json({ error: String((error as Error).message) }, { status: 409 }); }
  },
};
