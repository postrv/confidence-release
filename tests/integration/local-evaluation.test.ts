import { FULL_RELEASE_JOB_COUNT } from '../../workers/evaluator/recipes.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { ExternalEvaluator, Semaphore } from '../../services/evaluator.ts';
import { LocalPlatform } from '../../services/platform.ts';
import type { Candidate } from '../../services/types.ts';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => resolve = done); return { promise, resolve }; }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-evaluation-'));
  const platform = new LocalPlatform(directory); await platform.initialize();
  const base = platform.state.acceptedHead, files = await platform.git.files(base);
  files['cache.mjs'] = Buffer.from(files['cache.mjs'].toString().replace('cacheTtlMs = 0', 'cacheTtlMs = 60000'));
  files['presentation.mjs'] = Buffer.from('export function renderStatus(value) { return `<p role="status" aria-live="polite" aria-label="Saved value">Saved value: ${value}</p>`; }\n');
  const commit = await platform.git.createCommit(files, base, 'Owned passing evaluation fixture');
  const candidate: Candidate = await (platform as any).freezeCandidate('Passing fixture', commit, [], [], base);
  return { platform, directory, candidate, async close() { await platform.shutdown(); await rm(directory, { recursive: true, force: true }); } };
}

test('semaphore transfers reservations without a fresh caller stealing a waiting slot and fences resumed tasks', async () => {
  const capacity = new Semaphore(1), first = await capacity.acquire();
  let waitingStarted = false, freshStarted = false;
  const waiting = capacity.acquire().then(release => { waitingStarted = true; return release; });
  first();
  const fresh = capacity.acquire().then(release => { freshStarted = true; return release; });
  const second = await waiting;
  assert.ok(waitingStarted); assert.equal(freshStarted, false);
  second(); const third = await fresh; third(); third();
  const held = await capacity.acquire();
  let dispatched = false;
  const queued = capacity.run(async () => { dispatched = true; });
  held(); capacity.block();
  await assert.rejects(queued, /EVALUATION_GENERATION_UNRESOLVED/);
  assert.equal(dispatched, false);
  await assert.rejects(capacity.acquire(), /EVALUATION_GENERATION_UNRESOLVED/);
  capacity.unblock(); (await capacity.acquire())();
});

test('local plans use two actual slots, keep queued jobs truthful, and durably retain all nine isolated results before cleanup', { timeout: 30_000 }, async () => {
  const owned = await fixture(); const { platform, candidate, directory } = owned;
  const bothStarted = deferred(), continueJobs = deferred();
  let active = 0, maximum = 0, starts = 0;
  const original = platform.evaluator.runJob.bind(platform.evaluator);
  platform.evaluator.runJob = async (source, evaluation, job, onRuntime, onStart) => {
    let started = false;
    try {
      return await original(source, evaluation, job, onRuntime, async () => {
        await onStart?.(); started = true; active++; maximum = Math.max(maximum, active); starts++;
        if (starts === 2) bothStarted.resolve();
        await continueJobs.promise;
      });
    } finally { if (started) active--; }
  };
  try {
    const pending = platform.evaluate(candidate, 'retained-value-v1');
    await bothStarted.promise;
    const plan = platform.state.evaluations.at(-1)!;
    assert.equal(plan.jobs.filter(job => job.status === 'RUNNING').length, 2);
    assert.equal(plan.jobs.filter(job => job.status === 'QUEUED').length, FULL_RELEASE_JOB_COUNT - 2);
    continueJobs.resolve(); const result = await pending;
    assert.equal(result.outcome, 'PASS'); assert.equal(maximum, 2); assert.equal(starts, FULL_RELEASE_JOB_COUNT); assert.equal(active, 0);
    const evidence = result.jobs.map(job => platform.state.evidence.find(item => item.id === job.evidenceId)!);
    assert.equal(new Set(evidence.map(item => item.runtimeObservation?.candidateProcessId)).size, FULL_RELEASE_JOB_COUNT);
    assert.equal(new Set(evidence.map(item => item.runtimeObservation?.candidateOrigin)).size, FULL_RELEASE_JOB_COUNT);
    assert.equal(new Set(evidence.map(item => item.runtimeObservation?.fixtureOrigin)).size, FULL_RELEASE_JOB_COUNT);
    for (const job of result.jobs) {
      assert.equal(job.status, 'PASS'); assert.equal(job.runtime?.terminationObserved, true);
      const retained = evidence.find(item => item.jobId === job.id)!;
      assert.ok(await readFile(join(directory, 'objects', retained.observationDigest.slice(7) + '.json')));
      await assert.rejects(stat(join(directory, 'evaluations', job.id)), { code: 'ENOENT' });
    }
    const saved = JSON.parse(await readFile(join(directory, 'authority', 'state.json'), 'utf8'));
    assert.equal(saved.evaluations.at(-1).jobs.filter((job: any) => job.evidenceId).length, FULL_RELEASE_JOB_COUNT);
    assert.equal((await platform.review({ candidateId: candidate.id })).evidenceIds.length, FULL_RELEASE_JOB_COUNT);
  } finally { continueJobs.resolve(); await owned.close(); }
});

test('infrastructure failure stops further dispatch and evaluate waits for its already-started sibling', { timeout: 30_000 }, async () => {
  const owned = await fixture(); const { platform, candidate } = owned;
  const siblingStarted = deferred(), finishSibling = deferred(); let starts = 0, settled = false;
  const original = platform.evaluator.runJob.bind(platform.evaluator);
  platform.evaluator.runJob = (source, evaluation, job, onRuntime, onStart) => original(source, evaluation, job, onRuntime, async () => {
    await onStart?.(); const ordinal = ++starts;
    if (ordinal === 1) { await siblingStarted.promise; throw new Error('OWNED_START_PERSISTENCE_FAILURE'); }
    siblingStarted.resolve(); await finishSibling.promise;
  });
  try {
    const pending = platform.evaluate(candidate, 'retained-value-v1');
    const rejection = assert.rejects(pending, /OWNED_START_PERSISTENCE_FAILURE/).then(() => { settled = true; });
    await siblingStarted.promise; await delay(20); assert.equal(settled, false);
    finishSibling.resolve(); await rejection;
    assert.equal(starts, 2);
    const evaluation = platform.state.evaluations.at(-1)!;
    assert.equal(evaluation.status, 'INFRASTRUCTURE_UNKNOWN'); assert.equal(evaluation.outcome, 'INCONCLUSIVE');
    assert.equal(evaluation.jobs.filter(job => job.status === 'QUEUED').length, FULL_RELEASE_JOB_COUNT - 2);
    assert.equal(evaluation.jobs.filter(job => job.evidenceId).length, 1);
    const revision = platform.state.revision; await delay(30); assert.equal(platform.state.revision, revision, 'No detached completion remains after rejection');
    await assert.rejects(platform.review({ candidateId: candidate.id }), /EVALUATION_GENERATION_UNRESOLVED/);
    await platform.reconcile(); assert.equal(evaluation.status, 'COMPLETED'); assert.equal(evaluation.outcome, 'INCONCLUSIVE');
  } finally { finishSibling.resolve(); await owned.close(); }
});

test('a failed initial plan write dispatches nothing and remains reconcilable without a restart', { timeout: 30_000 }, async () => {
  const owned = await fixture(); const { platform, candidate } = owned;
  const save = platform.save.bind(platform); let fail = true;
  platform.save = async () => { if (fail) { fail = false; throw new Error('OWNED_PLAN_SAVE_FAILURE'); } await save(); };
  try {
    await assert.rejects(platform.evaluate(candidate, 'retained-value-v1'), /OWNED_PLAN_SAVE_FAILURE/);
    const evaluation = platform.state.evaluations.at(-1)!;
    assert.equal(evaluation.status, 'INFRASTRUCTURE_UNKNOWN');
    assert.ok(evaluation.jobs.every(job => job.status === 'QUEUED' && !job.runtime));
    await platform.reconcile(); assert.equal(evaluation.status, 'COMPLETED'); assert.equal(evaluation.outcome, 'INCONCLUSIVE');
  } finally { await owned.close(); }
});

test('unconfirmed termination holds capacity and blocks review until explicit absence reconciliation', { timeout: 30_000 }, async () => {
  const owned = await fixture(); const { platform, candidate, directory } = owned;
  class MissingStopObservation extends ExternalEvaluator {
    private missing = true;
    protected override async stopCandidate(child: ChildProcess) {
      const actuallyStopped = await super.stopCandidate(child);
      assert.ok(actuallyStopped, 'Owned test subprocess must really be stopped');
      if (this.missing) { this.missing = false; return false; }
      return true;
    }
  }
  platform.evaluator = new MissingStopObservation(platform.git, join(directory, 'evaluations'));
  try {
    await assert.rejects(platform.evaluate(candidate, 'retained-value-v1'), /EVALUATION_GENERATION_UNRESOLVED/);
    const evaluation = platform.state.evaluations.at(-1)!;
    const uncertain = evaluation.jobs.find(job => job.runtime && !job.runtime.terminationObserved)!;
    assert.ok(uncertain); assert.equal(uncertain.status, 'INCONCLUSIVE');
    assert.ok(evaluation.jobs.some(job => job.status === 'QUEUED'));
    assert.ok(await stat(join(directory, 'evaluations', uncertain.id)), 'Uncertain workspace remains retained');
    const next = await platform.evaluator.plan(candidate, 'retained-value-v1');
    await assert.rejects(platform.evaluator.runJob(candidate, next, next.jobs[0]), /EVALUATION_GENERATION_UNRESOLVED/);
    await assert.rejects(platform.evaluate(candidate, 'retained-value-v1'), /EVALUATION_GENERATION_UNRESOLVED/);
    await assert.rejects(platform.review({ candidateId: candidate.id }), /EVALUATION_GENERATION_UNRESOLVED/);
    await assert.rejects(platform.approve({ proposalDigest: 'unavailable' }), /EVALUATION_GENERATION_UNRESOLVED/);
    await assert.rejects(platform.publish({ proposalDigest: 'unavailable' }), /EVALUATION_GENERATION_UNRESOLVED/);
    await platform.reconcile();
    assert.equal(uncertain.runtime?.terminationObserved, true); assert.equal(evaluation.outcome, 'INCONCLUSIVE');
    assert.equal((await platform.evaluate(candidate, 'retained-value-v1')).outcome, 'PASS');
  } finally { await owned.close(); }
});

test('diagnostic uncertainty is durable, reconciles held capacity, and never changes candidate acceptance or creates evidence', { timeout: 30_000 }, async () => {
  const owned = await fixture(); const { platform, candidate, directory } = owned;
  try {
    await platform.evaluate(candidate, 'retained-value-v1');
    const evidenceCount = platform.state.evidence.length;
    const stopping = platform.evaluator as unknown as { stopCandidate(child: ChildProcess): Promise<boolean> };
    const stop = stopping.stopCandidate.bind(platform.evaluator);
    stopping.stopCandidate = async child => { assert.ok(await stop(child)); return false; };
    await assert.rejects(platform.evaluator.diagnostic(candidate, ['read']), /EVALUATION_GENERATION_UNRESOLVED/);
    const diagnostic = platform.state.evaluations.at(-1)!;
    assert.equal(diagnostic.purpose, 'diagnostic'); assert.equal(diagnostic.status, 'INFRASTRUCTURE_UNKNOWN');
    assert.equal(platform.state.evidence.length, evidenceCount); assert.equal(candidate.outcome, 'PASS');
    await assert.rejects(platform.review({ candidateId: candidate.id }), /EVALUATION_GENERATION_UNRESOLVED/);
    const saved = JSON.parse(await readFile(join(directory, 'authority', 'state.json'), 'utf8'));
    assert.equal(saved.evaluations.at(-1).purpose, 'diagnostic');
    assert.equal(saved.evaluations.at(-1).jobs[0].runtime.terminationObserved, false);
    await platform.reconcile(); assert.equal(diagnostic.jobs[0].runtime?.terminationObserved, true); assert.equal(candidate.outcome, 'PASS');
    stopping.stopCandidate = stop;
    assert.equal((await platform.evaluator.diagnostic(candidate, ['read'])).outcome, 'PASS', 'The held slot is reusable only after absence reconciliation');
    platform.state.evaluations.at(-1)!.contract = 'retained-value-v1';
    assert.equal((await platform.review({ candidateId: candidate.id })).evidenceIds.length, FULL_RELEASE_JOB_COUNT, 'Explicit diagnostic purpose excludes even a PASS row with an acceptance contract label');
    stopping.stopCandidate = async child => { assert.ok(await stop(child)); return false; };
    await assert.rejects(platform.evaluator.diagnostic(candidate, ['read']), /EVALUATION_GENERATION_UNRESOLVED/);
    const restarted = new LocalPlatform(directory); await restarted.initialize();
    try {
      assert.equal(restarted.state.evaluations.at(-1)?.outcome, 'INCONCLUSIVE');
      assert.equal(restarted.state.evaluations.at(-1)?.status, 'COMPLETED');
      assert.equal(restarted.state.candidates.find(item => item.id === candidate.id)?.outcome, 'PASS');
      assert.equal(restarted.state.evidence.length, evidenceCount);
      assert.equal((await restarted.review({ candidateId: candidate.id })).evidenceIds.length, FULL_RELEASE_JOB_COUNT);
    } finally { await restarted.shutdown(); }
  } finally { await owned.close(); }
});

test('diagnostic persistence failure before dispatch remains explicitly reconcilable without starting a process', { timeout: 30_000 }, async () => {
  const owned = await fixture(); const { platform, candidate } = owned;
  const save = platform.save.bind(platform); let fail = true;
  platform.save = async () => { if (fail) { fail = false; throw new Error('OWNED_DIAGNOSTIC_SAVE_FAILURE'); } await save(); };
  try {
    await assert.rejects(platform.evaluator.diagnostic(candidate, ['read']), /OWNED_DIAGNOSTIC_SAVE_FAILURE/);
    const diagnostic = platform.state.evaluations.at(-1)!;
    assert.equal(diagnostic.status, 'INFRASTRUCTURE_UNKNOWN'); assert.equal(diagnostic.jobs[0].runtime, undefined);
    await platform.reconcile(); assert.equal(diagnostic.status, 'COMPLETED'); assert.equal(diagnostic.outcome, 'INCONCLUSIVE');
    assert.equal((await platform.evaluator.diagnostic(candidate, ['read'])).outcome, 'PASS');
  } finally { await owned.close(); }
});

test('a failed stop observation still closes every harness listener and retains its generation for reconciliation', { timeout: 30_000 }, async () => {
  const owned = await fixture(); const { platform, candidate } = owned;
  const servers: http.Server[] = [], createServer = http.createServer;
  http.createServer = ((...args: Parameters<typeof http.createServer>) => { const server = createServer(...args); servers.push(server); return server; }) as typeof http.createServer;
  const stopping = platform.evaluator as unknown as { stopCandidate(child: ChildProcess): Promise<boolean> };
  const stop = stopping.stopCandidate.bind(platform.evaluator); let fail = true;
  stopping.stopCandidate = async child => { const stopped = await stop(child); if (fail) { fail = false; assert.ok(stopped); throw new Error('OWNED_STOP_OBSERVATION_FAILURE'); } return stopped; };
  try {
    await assert.rejects(platform.evaluate(candidate, 'retained-value-v1'), /OWNED_STOP_OBSERVATION_FAILURE/);
    assert.ok(servers.length >= 2); assert.ok(servers.every(server => !server.listening));
    assert.ok(platform.state.evaluations.at(-1)!.jobs.some(job => job.runtime && !job.runtime.terminationObserved));
    await platform.reconcile(); assert.equal((await platform.evaluate(candidate, 'retained-value-v1')).outcome, 'PASS');
  } finally { http.createServer = createServer; await owned.close(); }
});
