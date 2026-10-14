// TEST ONLY. No model, Git or native container executes. Never deploy this Worker.
import { DurableObject } from 'cloudflare:workers';
import { AttemptRunner, BrokerGateway, type RunnerEnv } from '../../workers/runner/index';
import { canonicalize } from '../../packages/protocol/src/index';
import { ObjectStore } from '../../workers/shared/objects';
import type { ModelCallFact } from '../../workers/shared/model-call';
export { BrokerGateway };

interface Env extends RunnerEnv { CALLBACKS: DurableObjectNamespace<OwnedCallbacks> }
export class OwnedRunner extends AttemptRunner {
  private releaseBarrier?: () => void;
  private barrier: 'alarm' | 'inactivity' | null = null;
  private async heldPreparation(stage: 'alarm' | 'inactivity'): Promise<void> {
    if (this.barrier !== stage) return;
    this.ctx.storage.sql.exec('UPDATE owned_container SET barrier_entered=1 WHERE id=1');
    await new Promise<void>(resolve => { this.releaseBarrier = resolve; });
  }
  protected override async armExecutionDeadline(deadline: number): Promise<void> { await super.armExecutionDeadline(deadline); await this.heldPreparation('alarm'); }
  override async alarm(): Promise<void> {} // explicit invocation controls fault order
  protected override executionContainer(): Container {
    const storage = this.ctx.storage;
    storage.sql.exec('CREATE TABLE IF NOT EXISTS owned_container(id INTEGER PRIMARY KEY,running INTEGER NOT NULL,failures INTEGER NOT NULL,destroy_calls INTEGER NOT NULL,fence_delivered_at_destroy INTEGER NOT NULL,inactivity INTEGER NOT NULL,start_calls INTEGER NOT NULL,exec_calls INTEGER NOT NULL,barrier_entered INTEGER NOT NULL)');
    storage.sql.exec('INSERT OR IGNORE INTO owned_container VALUES(1,0,0,0,0,0,0,0,0)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS owned_start_options(id INTEGER PRIMARY KEY,options TEXT NOT NULL)');
    const controller = this;
    return {
      images: { agent: `owned-fake@${this.env.AUTHORING_IMAGE_DIGEST}` },
      get running() { return storage.sql.exec<{ running: number }>('SELECT running FROM owned_container WHERE id=1').one().running === 1; },
      async setInactivityTimeout(value: number) { storage.sql.exec('UPDATE owned_container SET inactivity=? WHERE id=1', value); await controller.heldPreparation('inactivity'); },
      async interceptOutboundHttps() {}, async interceptOutboundHttp() {},
      start(options: ContainerStartupOptions) {
        storage.sql.exec('INSERT OR REPLACE INTO owned_start_options(id,options) VALUES(1,?)', JSON.stringify(options));
        storage.sql.exec('UPDATE owned_container SET start_calls=start_calls+1,running=1 WHERE id=1');
      },
      async exec() { storage.sql.exec('UPDATE owned_container SET exec_calls=exec_calls+1 WHERE id=1'); throw new Error('OWNED_NATIVE_WORKLOAD_FORBIDDEN'); },
      async destroy() {
        let fail = false;
        storage.transactionSync(() => {
          fail = storage.sql.exec<{ failures: number }>('SELECT failures FROM owned_container WHERE id=1').one().failures > 0;
          const fence = storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM outbox WHERE state='DELIVERED' AND json_extract(payload,'$.lifecycle') IN ('UNKNOWN','STOP_REQUESTED')").one().count;
          storage.sql.exec('UPDATE owned_container SET destroy_calls=destroy_calls+1,failures=MAX(0,failures-1),running=?,fence_delivered_at_destroy=? WHERE id=1', fail ? 1 : 0, fence > 0 ? 1 : 0);
        });
        if (fail) throw new Error('OWNED_DESTROY_UNCONFIRMED');
      },
      async inspect() { return storage.sql.exec<{ running: number }>('SELECT running FROM owned_container WHERE id=1').one().running === 1 ? { image: 'owned-fake', labels: {} } : null; },
    } as unknown as Container; // Explicit partial native-effects double; no workload is permitted.
  }
  async seedStart(input: { scope: unknown; attemptId: string; commit: string; barrier: 'alarm' | 'inactivity' }): Promise<unknown> {
    this.barrier = input.barrier;
    await this.provision({ scope: input.scope, attempt: { id: input.attemptId, generation: '1', workBase: input.commit, publicationBase: input.commit, remote: 'https://' + '1'.repeat(32) + '.artifacts.cloudflare.net/git/owned/attempt.git', source: { commit: input.commit } } } as any);
    return this.inspectOwned();
  }
  async startOwned(): Promise<unknown> { try { return { result: await this.start(), state: await this.inspectOwned() }; } catch (error) { return { failure: String((error as Error).message), state: await this.inspectOwned() }; } }
  async releaseStart(): Promise<void> { this.barrier = null; this.releaseBarrier?.(); this.releaseBarrier = undefined; }
  async expireStart(): Promise<unknown> { const row = this.ctx.storage.sql.exec<{ execution: string }>('SELECT execution FROM state WHERE id=1').one(); const execution = JSON.parse(row.execution); execution.deadline = Date.now() - 1; this.ctx.storage.sql.exec('UPDATE state SET execution=? WHERE id=1', canonicalize(execution)); await super.alarm(); await this.ctx.storage.deleteAlarm(); return this.inspectOwned(); }
  async seed(input: { scope: unknown; attemptId: string; commit: string; completed?: boolean }): Promise<unknown> {
    const assignment = { scope: input.scope, attempt: { id: input.attemptId, generation: '1', workBase: input.commit, publicationBase: input.commit, remote: 'https://' + '1'.repeat(32) + '.artifacts.cloudflare.net/git/owned/attempt.git' } };
    const execution = { generation: '1', lifecycle: 'RUNNING', outcome: input.completed ? 'COMPLETED' : 'PENDING', admissions: 'OPEN', deadline: Date.now() + 600000, capacityHeld: true, ...(input.completed ? { commit: input.commit } : {}) };
    this.ctx.storage.sql.exec('INSERT INTO state(id,assignment,execution) VALUES(1,?,?)', canonicalize(assignment), canonicalize(execution));
    this.ctx.storage.sql.exec('UPDATE owned_container SET running=1,failures=1 WHERE id=1'); return this.inspectOwned();
  }
  async inspectOwned(): Promise<unknown> {
    const state = this.ctx.storage.sql.exec<{ execution: string }>('SELECT execution FROM state WHERE id=1').toArray()[0];
    const options = this.ctx.storage.sql.exec<{ options: string }>('SELECT options FROM owned_start_options WHERE id=1').toArray()[0];
    return { execution: state ? JSON.parse(state.execution) : null, container: this.ctx.storage.sql.exec('SELECT * FROM owned_container').one(), startOptions: options ? JSON.parse(options.options) : null, outbox: this.ctx.storage.sql.exec('SELECT * FROM outbox ORDER BY rowid').toArray(), admits: await this.canAdmit('1') };
  }
  async stopOwned(): Promise<unknown> { try { await this.stop('owned-cancellation'); } catch (error) { return { failure: String((error as Error).message), state: await this.inspectOwned() }; } return { state: await this.inspectOwned() }; }
  async reconcileOwned(): Promise<unknown> { await super.alarm(); await this.ctx.storage.deleteAlarm(); return this.inspectOwned(); }
}
export class OwnedCallbacks extends DurableObject<Env> {
  private releases: (() => void)[] = [];
  async hold(value: boolean): Promise<void> { await this.ctx.storage.put('hold', value); if (!value) { for (const release of this.releases) release(); this.releases = []; } }
  async modelAckFailure(value: boolean): Promise<void> { await this.ctx.storage.put('model-ack-failure', value); }
  async modelReceipts(): Promise<unknown> { return await this.ctx.storage.get('model-receipts') || {}; }
  async fetch(request: Request): Promise<Response> {
    const input = await request.json();
    if (new URL(request.url).pathname === '/internal/runner/model-call-fact') {
      const fact = input as ModelCallFact;
      const bytes = await new ObjectStore(this.env.OBJECTS).get(fact.observationDigest, 16384);
      const envelope = JSON.parse(new TextDecoder().decode(bytes));
      if (envelope.callId !== fact.callId || envelope.attemptId !== fact.attemptId || envelope.generation !== fact.generation) throw Error('OWNED_MODEL_ENVELOPE_IDENTITY');
      const receipts = await this.ctx.storage.get<Record<string, string>>('model-receipts') || {}, key = fact.callId + '/' + fact.phase;
      if (receipts[key] && receipts[key] !== fact.observationDigest) throw Error('OWNED_MODEL_FACT_CONFLICT');
      receipts[key] = fact.observationDigest; await this.ctx.storage.put('model-receipts', receipts);
      if (await this.ctx.storage.get('model-ack-failure')) return Response.json({ outcome: 'owned-lost-ack' }, { status: 503 });
    }
    const entries = await this.ctx.storage.get<unknown[]>('entries') || []; entries.push(input); await this.ctx.storage.put('entries', entries);
    if (await this.ctx.storage.get('hold')) await new Promise<void>(resolve => this.releases.push(resolve));
    return Response.json({ acknowledged: true });
  }
  async inspect(): Promise<unknown[]> { return await this.ctx.storage.get('entries') || []; }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/internal/runner/observation' || path === '/internal/runner/model-call-fact') return env.CALLBACKS.getByName('owned-callbacks').fetch(request);
      const input = request.method === 'POST' ? await request.json() as any : {};
      if (path === '/callback-hold') { await env.CALLBACKS.getByName('owned-callbacks').hold(input.hold); return Response.json({ hold: input.hold }); }
      if (path === '/model-ack-failure') { await env.CALLBACKS.getByName('owned-callbacks').modelAckFailure(input.fail); return Response.json({ fail: input.fail }); }
      if (path === '/model-receipts') return Response.json(await env.CALLBACKS.getByName('owned-callbacks').modelReceipts());
      const runner = env.ATTEMPTS.getByName(input.runnerName ?? 'owned-runner') as DurableObjectStub<OwnedRunner>;
      if (path === '/model-queue') return Response.json(await runner.recordModelCall(input.fact, input.observation));
      if (path === '/start-seed') return Response.json(await runner.seedStart(input));
      if (path === '/start') return Response.json(await runner.startOwned());
      if (path === '/start-release') { await runner.releaseStart(); return Response.json({ released: true }); }
      if (path === '/start-expire') return Response.json(await runner.expireStart());
      if (path === '/seed') return Response.json(await runner.seed(input));
      if (path === '/inspect') return Response.json(await runner.inspectOwned());
      if (path === '/stop') return Response.json(await runner.stopOwned());
      if (path === '/reconcile') return Response.json(await runner.reconcileOwned());
      if (path === '/callbacks') return Response.json(await env.CALLBACKS.getByName('owned-callbacks').inspect());
      return Response.json({ error: 'OWNED_ROUTE_UNKNOWN' }, { status: 404 });
    } catch (error) { return Response.json({ error: String((error as Error).message) }, { status: 409 }); }
  },
};
