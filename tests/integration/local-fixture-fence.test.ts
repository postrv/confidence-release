import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalPlatform } from '../../services/platform.ts';
import { ExternalEvaluator } from '../../services/evaluator.ts';
import type { Candidate } from '../../services/types.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

for (const scenario of ['overlap', 'unknown-stop', 'cache-benefit', 'expired-body'] as const) {
  test(`local fixture fences ${scenario} before termination and freezes one consistent store record`, { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'confidence-fixture-fence-'));
    const platform = new LocalPlatform(directory); await platform.initialize();
    const createServer = http.createServer, clockNow = Date.now;
    let paused: http.ClientRequest | undefined, pausedResponse: Promise<number> | undefined;
    let fixtureUrl = '', authorization = '', stopping = false;
    const bodyStarted = deferred(), lateStatuses: number[] = [];
    const payload = JSON.stringify({ value: -999 }), prefix = '{"value":';
    // The controller owns this request. It enters the real HTTP handler before
    // completion but deliberately finishes its body only after the fence.
    http.createServer = ((...args: any[]) => {
      const listener = args.pop() as http.RequestListener;
      return createServer(...args, (req: http.IncomingMessage, res: http.ServerResponse) => {
        const handle = async () => {
          if (req.headers['x-owned-paused-body'] === '1') {
            req.once('data', () => bodyStarted.resolve());
            return listener(req, res);
          }
          if (!fixtureUrl && req.method === 'GET' && req.url === '/store/value') {
            fixtureUrl = `http://127.0.0.1:${req.socket.localPort}/store/value`;
            authorization = String(req.headers.authorization);
            pausedResponse = new Promise<number>((resolveStatus, reject) => {
              paused = http.request(fixtureUrl, { method: 'PUT', headers: { authorization, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-owned-paused-body': '1' } }, response => { response.resume(); response.once('end', () => resolveStatus(response.statusCode!)); });
              paused.once('error', reject); paused.write(prefix);
            });
            // Observing one chunk and one event-loop turn proves the handler
            // has entered its asynchronous body read; no sleep races are used.
            await bodyStarted.promise; await new Promise<void>(resolve => setImmediate(resolve));
            if (scenario === 'expired-body') {
              const expired = clockNow() + 20_000; Date.now = () => expired;
              try { paused!.end(payload.slice(prefix.length)); lateStatuses.push(await pausedResponse); }
              finally { Date.now = clockNow; }
            }
          }
          return listener(req, res);
        };
        void handle().catch(error => { res.destroy(error instanceof Error ? error : new Error(String(error))); });
      });
    }) as typeof http.createServer;
    class OwnedStopHook extends ExternalEvaluator {
      protected override async stopCandidate(child: ChildProcess): Promise<boolean> {
        let stopped = false;
        try {
          stopping = true;
          for (const method of ['GET', 'PUT']) {
            const response = await fetch(fixtureUrl, { method, headers: { authorization, 'content-type': 'application/json' }, body: method === 'PUT' ? payload : undefined, signal: AbortSignal.timeout(1000) });
            await response.body?.cancel(); lateStatuses.push(response.status);
          }
          if (scenario !== 'expired-body') { paused!.end(payload.slice(prefix.length)); lateStatuses.push(await pausedResponse!); }
          assert.deepEqual(lateStatuses, [503, 503, 503], 'new access and a body admitted before the fence must all be rejected');
        } finally {
          paused?.destroy(); stopped = await super.stopCandidate(child);
        }
        assert.equal(stopped, true, 'the owned child actually terminates even in the missing-observation control');
        return scenario !== 'unknown-stop';
      }
    }
    try {
      const base = platform.state.acceptedHead, files = await platform.git.files(base);
      files['cache.mjs'] = Buffer.from(files['cache.mjs'].toString().replace('cacheTtlMs = 0', 'cacheTtlMs = 60000'));
      const candidate: Candidate = await (platform as any).freezeCandidate('Owned fixture fence', await platform.git.createCommit(files, base, 'Owned fixture fence'), [], [], base);
      const evaluator = new OwnedStopHook(platform.git, join(directory, 'evaluations'));
      const evaluation = await evaluator.plan(candidate, 'retained-value-v1');
      const job = evaluation.jobs.find(item => item.name === (scenario === 'cache-benefit' ? 'retained-cache-benefit' : 'overlapping-read-write'))!;
      const result = await evaluator.runJob(candidate, evaluation, job);
      assert.equal(stopping, true);
      assert.equal(result.outcome, scenario === 'unknown-stop' ? 'INCONCLUSIVE' : scenario === 'expired-body' ? 'ERROR' : 'PASS');
      if (scenario === 'cache-benefit') assert.equal(result.storeReadCount, 1);
      else {
        const store = result.diagnostics?.find((item: any) => item.kind === 'overlapping-read-write-store') as { value: number; reads: number; accesses: { method: string; value: number }[] };
        const probe = job.input.fixture as { values: { initial: number; replacement: number } };
        assert.equal(store.value, scenario === 'expired-body' ? probe.values.initial : probe.values.replacement);
        assert.equal(store.reads, scenario === 'expired-body' ? 0 : 2);
        assert.deepEqual(store.accesses.map(row => row.method), scenario === 'expired-body' ? [] : ['GET', 'PUT', 'GET']);
        assert.equal(result.storeReadCount, store.reads);
        const retained = JSON.stringify(store); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(JSON.stringify(store), retained);
      }
      if (scenario === 'unknown-stop') {
        assert.equal(job.runtime?.terminationObserved, false);
        await assert.rejects(evaluator.runJob(candidate, evaluation, job), /EVALUATION_GENERATION_UNRESOLVED/);
        job.runtime!.terminationObserved = true; evaluator.reconcileCapacity();
      }
    } finally {
      Date.now = clockNow; http.createServer = createServer; paused?.destroy();
      await pausedResponse?.catch(() => undefined);
      await platform.shutdown(); await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const method of ['GET', 'PUT'] as const) {
  test(`local fixture rejects owned ${method} access 129 without increasing its retained trace`, { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'confidence-fixture-bound-'));
    const platform = new LocalPlatform(directory); await platform.initialize();
    const createServer = http.createServer, bodyStarted = deferred();
    let controlled = false, controllerError: unknown, rejectedStatus: number | undefined;
    let paused: http.ClientRequest | undefined, pausedResponse: Promise<number> | undefined;
    const payload = JSON.stringify({ value: -999 }), prefix = '{"value":';
    http.createServer = ((...args: any[]) => {
      const listener = args.pop() as http.RequestListener;
      return createServer(...args, (req: http.IncomingMessage, res: http.ServerResponse) => {
        const handle = async () => {
          if (req.headers['x-owned-trace-bound'] === 'paused') req.once('data', () => bodyStarted.resolve());
          if (!controlled && req.method === 'GET' && req.url === '/store/value' && !req.headers['x-owned-trace-bound']) {
            controlled = true;
            const url = `http://127.0.0.1:${req.socket.localPort}/store/value`, authorization = String(req.headers.authorization);
            const headers = { authorization, 'x-owned-trace-bound': '1' };
            if (method === 'PUT') {
              pausedResponse = new Promise<number>((resolve, reject) => {
                paused = http.request(url, { method, headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-owned-trace-bound': 'paused' } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode!)); });
                paused.once('error', reject); paused.write(prefix);
              });
              await bodyStarted.promise; await new Promise<void>(resolve => setImmediate(resolve));
            }
            for (let index = 0; index < 128; index++) {
              const response = await fetch(url, { headers, signal: AbortSignal.timeout(1000) });
              assert.equal(response.status, 200); await response.body?.cancel();
            }
            if (method === 'PUT') {
              paused!.end(payload.slice(prefix.length)); rejectedStatus = await pausedResponse!;
            } else {
              const response = await fetch(url, { headers, signal: AbortSignal.timeout(1000) });
              rejectedStatus = response.status; await response.body?.cancel();
            }
          }
          return listener(req, res);
        };
        void handle().catch(error => { controllerError = error; res.destroy(error instanceof Error ? error : new Error(String(error))); });
      });
    }) as typeof http.createServer;
    try {
      const base = platform.state.acceptedHead, files = await platform.git.files(base);
      const candidate: Candidate = await (platform as any).freezeCandidate('Owned fixture bound', await platform.git.createCommit(files, base, 'Owned fixture bound'), [], [], base);
      const evaluator = new ExternalEvaluator(platform.git, join(directory, 'evaluations'));
      const evaluation = await evaluator.plan(candidate, 'retained-value-v1');
      const job = evaluation.jobs.find(item => item.name === 'retained-cache-benefit')!;
      const result = await evaluator.runJob(candidate, evaluation, job);
      if (controllerError) throw controllerError;
      assert.equal(controlled, true); assert.equal(rejectedStatus, 403);
      assert.equal(result.storeReadCount, 128, 'a rejected access must not append to the retained store trace');
      assert.notEqual(result.outcome, 'PASS'); assert.equal(result.runtimeObservation?.terminationObserved, true);
    } finally {
      http.createServer = createServer; paused?.destroy(); await pausedResponse?.catch(() => undefined);
      await platform.shutdown(); await rm(directory, { recursive: true, force: true });
    }
  });
}
