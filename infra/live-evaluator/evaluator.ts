// SPDX-License-Identifier: Apache-2.0
// Owned conformance only: normal execution is the unchanged production implementation.
import production, { EvaluationSandbox, EvaluationScheduler, FixtureStore as ProductionFixtureStore, FixtureEgress } from '../../workers/evaluator/index';
import { digest } from '../../packages/protocol/src/index';
import type { NativeSnapshot, AbortRequest } from './types';
export { FixtureEgress };
/** Read-only retained fence inspection; all production fixture methods are inherited. */
export class FixtureStore extends ProductionFixtureStore {
  async inspectFence() {
    return this.ctx.storage.transaction(async storage => ({
      state: await storage.get<NonNullable<Awaited<ReturnType<ProductionFixtureStore['snapshot']>>>>('state') ?? null,
      closed: await storage.get('closed') === true,
    }));
  }
}
export class ConformanceEvaluation extends EvaluationSandbox {
  private readonly controllerInstanceId = crypto.randomUUID();
  /** No call to status(): observing a generation must not itself cause stop. */
  async inspectForConformance(jobKey: string): Promise<NativeSnapshot> {
    const record = await this.ctx.storage.get<any>('job');
    const abortRequest = await this.ctx.storage.get<AbortRequest>('owned-abort-intent') ?? null;
    if (record && (record.jobKey !== jobKey || (await digest({ scope: record.request.scope, jobId: record.request.job.id })).slice(7) !== jobKey)) throw new Error('OWNED_JOB_IDENTITY_MISMATCH');
    return { jobKey, jobId: record?.request?.job?.id ?? null, requestDigest: record?.requestDigest ?? null, phase: record?.phase ?? 'MISSING', deadline: record?.deadline ?? null,
      terminationObserved: record?.terminationObserved === true, callbackDelivered: record?.callbackDelivered === true,
      callbackDigest: record?.callback ? await digest(record.callback) : null, abortIntent: abortRequest !== null, controllerInstanceId: this.controllerInstanceId, abortRequest,
      container: await this.ctx.container!.inspect(), configuredImage: this.ctx.container!.images.base, observedAt: new Date().toISOString() };
  }
  /** One named owned controller fault; no start, stop or native effect is overridden. */
  async abortOnceWhenRunning(expectedJobId: string): Promise<void> {
    const end = Date.now() + 15000;
    for (;;) {
      const record = await this.ctx.storage.get<any>('job');
      if (await this.ctx.storage.get('owned-abort-intent')) throw new Error('OWNED_ABORT_ALREADY_DISPATCHED');
      if (record?.request?.job?.id === expectedJobId && record.phase === 'RUNNING' && !record.callback && record.deadline > Date.now()) {
        const intent = await this.ctx.storage.transaction(async storage => {
          const current = await storage.get<any>('job');
          if (await storage.get('owned-abort-intent')) throw new Error('OWNED_ABORT_ALREADY_DISPATCHED');
          if (current?.request?.job?.id !== expectedJobId || current.requestDigest !== record.requestDigest || current.jobKey !== record.jobKey || current.phase !== 'RUNNING' || current.callback || current.deadline <= Date.now()) throw new Error('OWNED_RUNNING_BOUNDARY_NOT_OBSERVED');
          const value: AbortRequest = { controllerInstanceId: this.controllerInstanceId, jobId: expectedJobId, jobKey: current.jobKey, requestDigest: current.requestDigest, phase: 'RUNNING', deadline: current.deadline, observedAt: Date.now() };
          await storage.put('owned-abort-intent', value); return value;
        });
        // The retained intent is not an abort acknowledgment. Recheck the
        // current generation immediately before the one synchronous abort.
        const current = await this.ctx.storage.get<any>('job');
        if (current?.request?.job?.id !== intent.jobId || current.jobKey !== intent.jobKey || current.requestDigest !== intent.requestDigest || current.phase !== 'RUNNING' || current.callback || current.deadline !== intent.deadline || current.deadline <= Date.now()) throw new Error('OWNED_RUNNING_BOUNDARY_NOT_OBSERVED');
        this.ctx.abort('Owned evaluator controller restart conformance');
      }
      if (record?.callback || Date.now() >= end) throw new Error('OWNED_RUNNING_BOUNDARY_NOT_OBSERVED');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}
export class ConformanceScheduler extends EvaluationScheduler {
  async inspectForConformance(): Promise<unknown> {
    const rows = this.ctx.storage.sql.exec<{ key: string; digest: string; object: string; status: string; priority: number }>('SELECT key,digest,object,status,priority FROM scheduled_jobs ORDER BY rowid LIMIT 257').toArray();
    if (rows.length > 256) throw new Error('CONFORMANCE_JOB_INVENTORY_EXCEEDED');
    return Object.fromEntries(rows.map(({ key, ...job }) => [key, job]));
  }
}
export default production;
