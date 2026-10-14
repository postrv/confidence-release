import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { digest, hashBytes } from './crypto.ts';
import { GitStore } from './git.ts';
import type { Candidate, Evidence, Evaluation, Job, Observation, Outcome } from './types.ts';
import { boundedResponse } from './http-bounds.ts';

import { publicProbes, fullReleaseProbes, type Probe } from './probes.ts';
export { publicProbes } from './probes.ts';
import { runOverlappingReadWrite, validOverlapStoreTrace, type ReadBarrierControl } from '../workers/evaluator/overlap.ts';
export class Semaphore {
  private active = 0;
  private waiting: { resolve: () => void; reject: (error: Error) => void }[] = [];
  private blocked = false;
  constructor(private limit: number) { if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('INVALID_CAPACITY'); }
  assertOpen(): void { if (this.blocked) throw new Error('EVALUATION_GENERATION_UNRESOLVED'); }
  async acquire(): Promise<() => void> {
    this.assertOpen();
    if (this.active >= this.limit) await new Promise<void>((resolve, reject) => this.waiting.push({ resolve, reject }));
    else this.active++;
    let released = false;
    return () => {
      if (released) return; released = true;
      const next = this.waiting.shift();
      // Transfer the occupied slot directly. A newly arriving caller cannot
      // take it while the waiting continuation is resuming.
      if (next) next.resolve(); else this.active--;
    };
  }
  block(): void {
    this.blocked = true;
    for (const waiting of this.waiting.splice(0)) waiting.reject(new Error('EVALUATION_GENERATION_UNRESOLVED'));
  }
  unblock(): void { this.blocked = false; }
  async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try { this.assertOpen(); return await task(); } finally { release(); }
  }
}
const supportedEnvironment = { runtime: process.version, architecture: process.arch, platform: process.platform, timezone: 'UTC', locale: 'C', dependencyProfile: 'node-builtins-only-v1', clock: 'uncontrolled-wall-clock-trace-before-60s-ttl', network: 'shared-host-network-unrestricted-intended-loopback-job-store-and-candidate-interface', candidatePortProtocol: 'child-bound-ephemeral-port-stdout-ready-v1', resourceCeiling: { processSeconds: 15, outputBytes: 65536, responseBytes: 16384 }, isolation: 'local-sibling-subprocesses-shared-host-not-hostile-code-containment', cacheable: false };
export const checkerLimitations = [
  'External harness and signing keys are outside candidate processes. Local subprocesses share an OS identity; this is not hostile-code isolation.',
  'Backing-store reads are counted by the harness-owned HTTP store, not candidate counters. Counts demonstrate these probes, not measured latency.',
  'Freshness is observed for the declared traces before the enabled cache TTL expires. These observations do not establish general correctness.',
  'Local clock, process identifiers and ephemeral ports are not hermetic inputs. Evidence reuse is disabled; runtime observations are retained and production network containment remains a separate gate.',
];
async function listen(server: http.Server): Promise<number> { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return (server.address() as any).port; }
async function close(server: http.Server): Promise<void> { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
export async function stopProcess(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const observed = new Promise<boolean>(resolve => child.once('close', () => resolve(true)));
  try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  const graceful = await Promise.race([observed, delay(1000).then(() => false)]);
  if (graceful) return true;
  try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  return await Promise.race([observed, delay(1000).then(() => false)]);
}
export class ExternalEvaluator {
  private capacity = new Semaphore(2);
  private held = new Map<string, { job: Job; release: () => void }>();
  private binaryDigest?: string;
  private implementationDigest?: string;
  constructor(private git: GitStore, private directory: string, private diagnosticObserver?: (evaluation: Evaluation) => Promise<void>) {}
  protected stopCandidate(child: ChildProcess): Promise<boolean> { return stopProcess(child); }
  async plan(candidate: Candidate, contract: Evaluation['contract']): Promise<Evaluation> {
    this.binaryDigest ||= hashBytes(await readFile(process.execPath));
    this.implementationDigest ||= digest({ evaluator: hashBytes(await readFile(new URL('./evaluator.ts', import.meta.url))), responseBounds: hashBytes(await readFile(new URL('./http-bounds.ts', import.meta.url))), contract: digest(fullReleaseProbes), overlap: hashBytes(await readFile(new URL('../workers/evaluator/overlap.ts', import.meta.url))), deadline: hashBytes(await readFile(new URL('../workers/shared/deadline.ts', import.meta.url))), errors: hashBytes(await readFile(new URL('../workers/shared/errors.ts', import.meta.url))) });
    const id = `evaluation-${randomUUID()}`, probes = contract === 'freshness-v1' ? [publicProbes[0]] : fullReleaseProbes;
    const jobs: Job[] = probes.map(probe => {
      const input = { schemaVersion: 1, candidateDigest: candidate.digest, exactCommitBytesDigest: candidate.commitBytesDigest, sourceManifestDigest: candidate.manifestDigest, compositionRecipe: 'whole-file-delta-v1', goalRevision: '1', contract, checker: 'external-http-harness-v1', checkerImplementationDigest: this.implementationDigest, invocation: { entrypoint: 'server.mjs', arguments: [], buildFlags: [], outputs: ['HTTP status', 'inert JSON', 'accessible HTML', 'store HTTP access log'], environment: { TZ: 'UTC', LC_ALL: 'C' } }, environment: { ...supportedEnvironment, runtimeBinaryDigest: this.binaryDigest }, fixture: probe, fixtureDigest: digest(probe), fixtureReset: 'new-harness-store-and-candidate-process-every-job', networkPolicy: 'local-unrestricted-host-network-job-data-route-v1', capabilities: ['job-scoped-fixture-data'], secrets: 'none', independentFreshRun: true };
      return { id: `job-${randomUUID()}`, name: probe.name, required: true, checkerClass: 'external-behavioural', candidateId: candidate.id, input, evaluationInputDigest: digest(input), status: 'QUEUED' };
    });
    const identity = { candidateId: candidate.id, candidateDigest: candidate.digest, jobs: jobs.map(j => ({ id: j.id, inputDigest: j.evaluationInputDigest, required: true, evidenceClass: 'protected-behavioural' })) };
    return { id, candidateId: candidate.id, contract, planDigest: digest(identity), jobs, aggregation: 'all-required-pass', status: 'QUEUED', createdAt: new Date().toISOString() };
  }
  reconcileCapacity(): void {
    for (const [id, reservation] of this.held) if (reservation.job.runtime?.terminationObserved) { reservation.release(); this.held.delete(id); }
    if (!this.held.size) this.capacity.unblock();
  }
  async runJob(candidate: Candidate, evaluation: Evaluation, job: Job, onRuntime?: () => Promise<void>, onStart?: () => Promise<void>): Promise<Omit<Evidence, 'id' | 'digest' | 'envelope' | 'observationDigest'>> {
    const release = await this.capacity.acquire();
    try {
      this.capacity.assertOpen();
      await onStart?.();
      const workspace = join(this.directory, job.id); await mkdir(workspace, { recursive: true });
      await this.git.hydrate(candidate.commit, workspace);
      const probe = job.input.fixture as Probe, token = randomBytes(24).toString('hex');
      let stored = probe.values.initial, count = 0; const accesses: { method: string; value: number }[] = [];
      let fixtureClosed = false, fixtureDeadline = Number.POSITIVE_INFINITY;
      const fenceFixture = () => { fixtureClosed = true; barrier?.release(); };
      const fixtureOpen = () => { if (Date.now() >= fixtureDeadline) fenceFixture(); return !fixtureClosed; };
      let barrier: { captured: boolean; capture: Promise<{ capturedValue: number; reads: number }>; capturedRead(value: { capturedValue: number; reads: number }): void; released: Promise<void>; release(): void } | undefined;
      const fixtureControl: ReadBarrierControl = {
        async armReadBarrier(deadline) {
          if (barrier || fixtureClosed || deadline <= Date.now()) throw new Error('FIXTURE_BARRIER_ARM_INVALID');
          let capturedRead!: (value: { capturedValue: number; reads: number }) => void, release!: () => void;
          const capture = new Promise<{ capturedValue: number; reads: number }>(resolve => { capturedRead = resolve; });
          const released = new Promise<void>(resolve => { release = resolve; });
          fixtureDeadline = Math.min(fixtureDeadline, deadline);
          barrier = { captured: false, capture, capturedRead, released, release };
        },
        async waitForReadCapture() { if (!barrier) throw new Error('FIXTURE_BARRIER_UNAVAILABLE'); return barrier.capture; },
        async releaseReadBarrier() { if (!barrier?.captured || !fixtureOpen()) throw new Error('FIXTURE_BARRIER_UNAVAILABLE'); barrier.release(); },
        async close() { fenceFixture(); },
      };
      const store = http.createServer(async (req, res) => {
        if (req.url !== '/store/value' || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
        res.setHeader('content-type', 'application/json');
        if (!fixtureOpen()) { res.writeHead(503).end('{}'); return; }
        if (req.method === 'GET') {
          if (accesses.length >= 128) { res.writeHead(403).end('{}'); return; }
          const value = stored; count++; accesses.push({ method: 'GET', value });
          if (barrier && !barrier.captured) {
            barrier.captured = true; barrier.capturedRead({ capturedValue: value, reads: count });
            await barrier.released;
            if (!fixtureOpen()) { res.writeHead(503).end('{}'); return; }
          }
          res.end(JSON.stringify({ value })); return;
        }
        if (req.method === 'PUT') {
          let raw = '';
          try { for await (const chunk of req) { raw += chunk; if (raw.length > 1024) { res.writeHead(413).end(); return; } } }
          catch { res.writeHead(fixtureOpen() ? 400 : 503).end('{}'); return; }
          if (!fixtureOpen()) { res.writeHead(503).end('{}'); return; }
          if (accesses.length >= 128) { res.writeHead(403).end('{}'); return; }
          try { const next = JSON.parse(raw).value; if (!Number.isSafeInteger(next)) throw new Error(); stored = next; accesses.push({ method: 'PUT', value: stored }); res.end(JSON.stringify({ value: stored })); }
          catch { res.writeHead(400).end('{}'); } return;
        } res.writeHead(405).end();
      });
      try {
        const storePort = await listen(store);
        // Let the child bind port 0 itself. Reserving and then releasing a port
        // allowed a parallel job to take it before this child started listening.
        const child = spawn(process.execPath, ['server.mjs'], { cwd: workspace, detached: true, env: { PATH: process.env.PATH, HOME: join(workspace, '.home'), TZ: 'UTC', LC_ALL: 'C', PORT: '0', BIND_HOST: '127.0.0.1', FIXTURE_STORE_URL: `http://127.0.0.1:${storePort}/store/value`, FIXTURE_DATA_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', truncated = false, spawnError: Error | undefined;
        const capture = (chunk: Buffer) => { if (output.length < 65536) output += chunk.toString().slice(0, 65536 - output.length); else truncated = true; };
        let port = 0, readyLine = '', readinessError: string | undefined;
        child.stdout!.on('data', (chunk: Buffer) => {
          capture(chunk);
          if (port || readinessError) return;
          readyLine += chunk.toString('utf8');
          const newline = readyLine.indexOf('\n');
          if (newline < 0) { if (readyLine.length > 1024) readinessError = 'Candidate readiness line exceeded limit'; return; }
          if (newline > 1024) { readinessError = 'Candidate readiness line exceeded limit'; return; }
          try {
            const announcement = JSON.parse(readyLine.slice(0, newline));
            if (announcement?.type !== 'ready' || !Number.isSafeInteger(announcement.port) || announcement.port < 1 || announcement.port > 65535) throw new Error('Invalid ready announcement');
            port = announcement.port;
          } catch { readinessError = 'Candidate readiness announcement invalid'; }
        });
        child.stderr!.on('data', capture); child.once('error', error => spawnError = error);
        const startedAt = new Date().toISOString(), observations: Observation[] = [], diagnostics: unknown[] = []; let outcome: Outcome = 'PASS', error: string | undefined;
        const expires = Date.now() + 15_000; fixtureDeadline = expires;
        let frozenStore: { value: number; reads: number; accesses: { method: string; value: number }[] };
        job.runtime = { pid: child.pid!, startedAt, deadline: new Date(expires).toISOString(), terminationObserved: false };
        try {
          await onRuntime?.();
          let ready = false;
          // Readiness shares the declared process deadline. A separate poll
          // count rejected otherwise valid slow starts well before that limit.
          while (Date.now() < expires) {
            if (spawnError) throw spawnError;
            if (child.exitCode !== null) throw new Error('Candidate exited before readiness');
            if (readinessError) throw new Error(readinessError);
            if (port) {
              const remaining = expires - Date.now();
              if (remaining <= 0) break;
              try {
                const res = await fetch(`http://127.0.0.1:${port}/health`, { redirect: 'error', signal: AbortSignal.timeout(Math.min(150, remaining)) });
                // Health uses only the status. Body disposal must not hold the
                // deadline open, including when a cancellation never settles.
                void res.body?.cancel().catch(() => undefined);
                if (res.ok && Date.now() < expires) { ready = true; break; }
              } catch {}
            }
            const remaining = expires - Date.now();
            if (remaining > 0) await delay(Math.min(20, remaining));
          }
          if (!ready || Date.now() >= expires) throw new Error('Candidate readiness timeout');
          let expected = probe.values.initial;
          if (probe.assertion === 'overlap-freshness') {
            const rows: unknown[] = [];
            const requestValue = async (method: 'GET' | 'PUT', timeoutMs: number, value?: number) => {
              const response = await fetch(`http://127.0.0.1:${port}/value`, { method, redirect: 'error', headers: { 'content-type': 'application/json' }, body: method === 'PUT' ? JSON.stringify({ value }) : undefined, signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, expires - Date.now()))) });
              const body = new TextDecoder('utf-8', { fatal: true }).decode(await boundedResponse(response, 16384));
              const parsed = JSON.parse(body).value;
              return { status: response.status, observed: Number.isSafeInteger(parsed) ? parsed as number : null, responseDigest: hashBytes(body) };
            };
            try {
              outcome = await runOverlappingReadWrite({ fixture: fixtureControl, initial: probe.values.initial, replacement: probe.values.replacement, deadline: expires,
                read: timeoutMs => requestValue('GET', timeoutMs), write: value => requestValue('PUT', 2000, value), continuation: async () => {}, observations: rows });
            } finally {
              diagnostics.push({ kind: 'overlapping-read-write-ordering', events: rows });
              for (const [step, row] of rows.entries()) {
                const value = row as Record<string, unknown>;
                if (typeof value.status !== 'number' || typeof value.responseDigest !== 'string') continue;
                observations.push({ step, action: String(value.action), ...(typeof value.expected === 'number' ? { expected: value.expected } : {}), ...(typeof value.observed === 'number' ? { observed: value.observed } : {}), status: value.status, responseDigest: value.responseDigest, ...(typeof value.storeReadCount === 'number' ? { storeReadCount: value.storeReadCount } : {}) });
              }
            }
          } else for (const [step, action] of probe.actions.entries()) {
            const isWrite = action === 'write' || action === 'write-later';
            const value = action === 'write-later' ? probe.values.later : probe.values.replacement;
            const endpoint = `http://127.0.0.1:${port}/${action === 'page' ? '' : 'value'}`;
            const response = await fetch(endpoint, { method: isWrite ? 'PUT' : 'GET', redirect: 'error', headers: { 'content-type': 'application/json' }, body: isWrite ? JSON.stringify({ value }) : undefined, signal: AbortSignal.timeout(Math.min(2000, Math.max(1, expires - Date.now()))) });
            const body = new TextDecoder('utf-8', { fatal: true }).decode(await boundedResponse(response, 16384));
            if (!response.ok) throw new Error(`Application HTTP ${response.status}`);
            if (isWrite) expected = value;
            let observed: number | undefined;
            if (action === 'page') {
              const accessible = /<p\s[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-label="Saved value"[^>]*>Saved value:\s*(-?\d+)<\/p>/.exec(body);
              observed = accessible ? Number(accessible[1]) : undefined;
              if (!accessible || observed !== expected) outcome = 'FAIL';
            } else {
              observed = JSON.parse(body).value;
              if (!Number.isSafeInteger(observed)) throw new Error('Invalid candidate JSON response');
              if (observed !== expected) outcome = 'FAIL';
            }
            observations.push({ step, action, expected, ...(observed === undefined ? {} : { observed }), status: response.status, responseDigest: hashBytes(body), ...(action === 'page' ? { body } : {}), storeReadCount: count });
          }
          if (Date.now() >= expires) outcome = 'TIMEOUT';
        } catch (reason) { error = String((reason as Error).message); outcome = /timeout|aborted/i.test(error) ? 'TIMEOUT' : 'ERROR'; }
        finally {
          // Close synchronously before termination/persistence can yield. Requests
          // already awaiting a body must recheck this fence before any mutation.
          fenceFixture();
          frozenStore = { value: stored, reads: count, accesses: structuredClone(accesses) };
          if (outcome === 'PASS' && Date.now() >= fixtureDeadline) outcome = 'TIMEOUT';
          if (probe.assertion === 'overlap-freshness') {
            diagnostics.push({ kind: 'overlapping-read-write-store', ...frozenStore });
            if (outcome === 'PASS' && !validOverlapStoreTrace(frozenStore, probe.values.initial, probe.values.replacement)) outcome = 'FAIL';
          }
          if (outcome === 'PASS' && probe.assertion === 'cache-benefit' && frozenStore.reads !== 1) outcome = 'FAIL';
          const terminated = await this.stopCandidate(child); if (!terminated) { outcome = 'INCONCLUSIVE'; error = 'Candidate termination could not be observed; generation remains uncertain'; }
          job.runtime.terminationObserved = terminated; await onRuntime?.();
        }
        return { candidateId: candidate.id, evaluationId: evaluation.id, jobId: job.id, evaluationInputDigest: job.evaluationInputDigest, checkerClass: 'external-behavioural', checkerId: 'external-http-harness-v1', environmentDigest: digest({ ...supportedEnvironment, runtimeBinaryDigest: this.binaryDigest! }), fixtureDigest: digest(probe), outcome, observations, ...(diagnostics.length ? { diagnostics } : {}), storeReadCount: frozenStore.reads, startedAt, completedAt: new Date().toISOString(), runtimeObservation: { candidateProcessId: child.pid!, candidateOrigin: port ? `http://127.0.0.1:${port}` : 'unavailable', fixtureOrigin: `http://127.0.0.1:${storePort}`, terminationObserved: job.runtime.terminationObserved }, limitations: [...checkerLimitations, ...(truncated ? ['Candidate process output truncated at 65536 bytes.'] : [])], ...(error ? { error } : {}) };
      } finally { await fixtureControl.close(); await close(store); }
    } finally {
      if (job.runtime && !job.runtime.terminationObserved) {
        // Unknown termination retains this exact reservation. Pending callers
        // are rejected; reconciliation may release it only after observation.
        this.held.set(job.id, { job, release }); this.capacity.block();
      } else release();
    }
  }
  async diagnostic(candidate: Candidate, actions: string[]): Promise<{ outcome: Outcome; observations: Observation[] }> {
    const evaluation = await this.plan(candidate, 'freshness-v1'), job = evaluation.jobs[0];
    evaluation.id = `diagnostic-${randomUUID()}`; evaluation.purpose = 'diagnostic'; evaluation.status = 'RUNNING';
    job.name = 'bounded-trace-reduction';
    job.input.fixture = { ...publicProbes[0], name: 'bounded-trace-reduction', actions };
    job.input.fixtureDigest = digest(job.input.fixture);
    job.evaluationInputDigest = digest(job.input);
    evaluation.planDigest = digest({ candidateId: candidate.id, candidateDigest: candidate.digest, jobs: [{ id: job.id, inputDigest: job.evaluationInputDigest, required: true, evidenceClass: 'protected-behavioural' }] });
    // Persist the diagnostic generation too: an uncertain reducer process must
    // survive controller restart without becoming invisible to capacity gates.
    try {
      await this.diagnosticObserver?.(evaluation);
      const result = await this.runJob(candidate, evaluation, job, () => this.diagnosticObserver?.(evaluation) ?? Promise.resolve(), async () => { job.status = 'RUNNING'; await this.diagnosticObserver?.(evaluation); });
      job.status = result.outcome; evaluation.outcome = result.outcome; evaluation.completedAt = new Date().toISOString();
      if (!job.runtime?.terminationObserved) throw new Error('EVALUATION_GENERATION_UNRESOLVED');
      evaluation.status = 'COMPLETED'; await this.diagnosticObserver?.(evaluation);
      return { outcome: result.outcome, observations: result.observations };
    } catch (error) {
      evaluation.status = 'INFRASTRUCTURE_UNKNOWN'; evaluation.outcome = 'INCONCLUSIVE';
      if (!job.runtime || job.runtime.terminationObserved) job.status = 'INCONCLUSIVE';
      await this.diagnosticObserver?.(evaluation); throw error;
    }
  }
  async reduce(candidate: Candidate): Promise<unknown> {
    const original = ['read', 'read', 'write', 'read', 'read']; let current = [...original];
    const history: unknown[] = []; let finalChecks: any[] = [];
    while (history.length < 24) {
      finalChecks = []; let reduced = false;
      for (let index = 0; index < current.length; index++) {
        if (history.length >= 24) return { original, reducedTrace: current, status: 'budget-exhausted', history };
        const trial = current.filter((_, n) => n !== index), result = await this.diagnostic(candidate, trial);
        const check = { startingTrace: [...current], removedIndex: index, trial, outcome: result.outcome, observations: result.observations };
        history.push(check); finalChecks.push(check);
        if (result.outcome === 'FAIL') { current = trial; reduced = true; break; }
      }
      if (!reduced) return { original, reducedTrace: current, status: finalChecks.every(c => c.outcome === 'PASS') ? 'one-deletion-minimal-for-this-observed-failure' : 'best-found-with-unresolved-probes', finalChecks, history, scope: 'Real HTTP probes, single-action deletions only. No global minimum or full-contract PASS claim.' };
    }
    return { original, reducedTrace: current, status: 'budget-exhausted', history };
  }
}
