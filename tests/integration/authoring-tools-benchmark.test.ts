// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeKernel } from '../../packages/protocol/src/node.ts';
import { ARMS, BIOME, Journal, PATHS, TASK, coverage, fixture, mockProposal, modes } from '../../experiments/authoring-tools/benchmark.ts';
import { LiveBenchmark, assertMatchedState, completedPlan, ingestionResult, latestStopped, maximumCallsPerArm, maximumRequests, validateLivePlan, type LivePlan } from '../../experiments/authoring-tools/live.ts';
import { accessTransport } from '../../experiments/authoring-tools/live-cli.ts';
import { probes } from '../../workers/evaluator/recipes.ts';
import { collectArtifacts } from '../../experiments/authoring-tools/collect.ts';
import { digest, hashBytes } from '../../services/crypto.ts';
import { fixtureSource } from '../../infra/seed-pilot.ts';

await initializeKernel();
const source = await fixture('original-control');
const plan: LivePlan = { schemaVersion: 1, runId: 'owned-benchmark-test', origin: 'https://owned.example.invalid',
  scope: { schemaVersion: 1, tenantId: 'owned', projectId: 'owned', projectIncarnation: 'owned' }, principalId: 'owned-owner',
  variant: 'original-control', sourceCommit: '1'.repeat(40), sourceManifestDigest: source.sourceManifestDigest,
  goalRevision: 'goal', policyRevision: 'policy', artifactsGitHost: 'artifacts.example.invalid', model: 'owned-test',
  runnerImageDigest: 'sha256:' + '2'.repeat(64), evaluatorImageDigest: 'sha256:' + '3'.repeat(64), checkerDigest: 'sha256:' + '4'.repeat(64),
  modelMaximumCallCost: '100000', perArmReservationUnits: '400000', arms: [...ARMS], authoringMs: 1000, ingestionMs: 1000, evaluationMs: 1000, cleanupMs: 1000,
  authorizedModelSpendMicroUsd: 1600000, reviewedMaximumCallMicroUsd: 100000, pricingEvidenceDigest: 'sha256:' + '7'.repeat(64),
  authorizationReference: 'Owned fixture only; no network or provider authorization.' };
const state = (): any => ({ project: { scope: plan.scope, head: plan.sourceCommit, goalRevision: plan.goalRevision, policyRevision: plan.policyRevision,
  gate: 'CLOSED', unresolvedPublicationId: null, revision: '1', maximumBudget: '1600000', reservedBudget: '0', settledBudget: '0' },
  modelCalls: { overflow: false, reservations: [] }, sourceManifests: { [plan.sourceCommit]: source.manifest } });

test('benchmark freezes separate original and Biome datasets without changing control bytes', async () => {
  const covered = await fixture('biome-covered');
  assert.equal(Object.keys(source.files).length, 4); assert.equal(Object.keys(covered.files).length, 5);
  for (const path of Object.keys(source.files)) assert.equal(covered.files[path], source.files[path]);
  assert.equal(covered.files['biome.json'], BIOME); assert.notEqual(covered.sourceManifestDigest, source.sourceManifestDigest);
  assert.equal(covered.taskDigest, source.taskDigest); assert.equal(covered.grantDigest, source.grantDigest); assert.equal(covered.checksDigest, source.checksDigest);
  assert.equal((await fixtureSource('authoring-biome-v1')).manifestDigest, covered.sourceManifestDigest);
  assert.deepEqual(Object.keys(mockProposal(source.files, false)).sort(), [...PATHS].sort());
  assert.match(mockProposal(source.files, true)['cache.mjs'], /^debugger;/);
  assert.throws(() => mockProposal({ ...source.files, 'cache.mjs': 'changed' }, false));
});

test('enabled arms explicitly force Narsil, and skips or clean previews cannot manufacture coverage', () => {
  assert.deepEqual(ARMS.map(arm => modes(arm).narsil), ['off', 'always', 'off', 'always']);
  const preview = { status: 'NO_BLOCKING_FINDINGS', sourceCoherence: 'COHERENT', process: { terminationObserved: true } };
  assert.equal(coverage('both', { status: 'SKIPPED' }, [preview], null).narsil, 'UNMEASURED');
  assert.equal(coverage('both', { status: 'READY', coverage: { queryCount: 1 } }, [preview], null).interlinked, 'UNMEASURED');
  const canary = { status: 'FINDINGS', failures: [{ tool: 'biome', code: 'lint/suspicious/noDebugger' }] };
  const result = coverage('both', { status: 'READY', coverage: { queryCount: 2 } }, [preview], canary);
  assert.equal(result.narsil, 'OBSERVED'); assert.equal(result.interlinked, 'OBSERVED_NARROW_BIOME_RULE'); assert.equal(result.comparisonEligible, false);
  assert.equal(coverage('both', { status: 'READY', coverage: { queryCount: 2 } }, [{ ...preview, sourceCoherence: 'CHANGED' }], canary).interlinked, 'UNMEASURED');
});

test('live registration accepts explicit subsets and rejects duplicate arms, widened budgets, unsupported origins and time bounds', () => {
  validateLivePlan(plan);
  validateLivePlan({ ...plan, arms: ['both'] }); validateLivePlan({ ...plan, arms: ['neither', 'both'] });
  validateLivePlan({ ...plan, arms: ['both'], reviewedMaximumCallMicroUsd: 400000, authorizedModelSpendMicroUsd: 1600000 });
  validateLivePlan({ ...plan, arms: ['both'], reviewedMaximumCallMicroUsd: 1505000, authorizedModelSpendMicroUsd: 7000000 });
  assert.equal(maximumRequests({ ...plan, authoringMs: 660000, ingestionMs: 120000, evaluationMs: 300000, cleanupMs: 120000 }), 1104);
  for (const altered of [
    { arms: [] }, { arms: ['unknown'] }, { arms: ['both', 'both', 'both', 'both'] }, { perArmReservationUnits: '800000' },
    { modelMaximumCallCost: '1' }, { origin: 'http://owned.example.invalid' }, { origin: 'https://owned.example.invalid/path' },
    { origin: 'https://owner:secret@owned.example.invalid' }, { authoringMs: 660001 }, { authorizationReference: '' },
    { authorizedModelSpendMicroUsd: 1599999 }, { reviewedMaximumCallMicroUsd: 2000001 }, { pricingEvidenceDigest: '' },
  ]) assert.throws(() => validateLivePlan({ ...plan, ...altered } as LivePlan));
});

test('live admission includes prior uncertain calls and admits only closed three- or four-call grants', () => {
  const retry: LivePlan = { ...plan, arms: ['both'], perArmReservationUnits: '300000',
    priorModelSpendAllowanceMicroUsd: 1505000, reviewedMaximumCallMicroUsd: 1505000, authorizedModelSpendMicroUsd: 7000000 };
  validateLivePlan(retry);
  assert.equal(maximumCallsPerArm(retry), 3); assert.equal(maximumCallsPerArm(plan), 4);
  validateLivePlan({ ...retry, authorizedModelSpendMicroUsd: 6020000 });
  assert.throws(() => validateLivePlan({ ...retry, authorizedModelSpendMicroUsd: 6019999 }), /cumulative potential spend/);
  assert.throws(() => validateLivePlan({ ...retry, perArmReservationUnits: '400000' }), /cumulative potential spend/);
  assert.throws(() => validateLivePlan({ ...retry, arms: ['neither', 'both'] }), /cumulative potential spend/);
  validateLivePlan({ ...retry, perArmReservationUnits: '400000', priorModelSpendAllowanceMicroUsd: 0 });
  const { priorModelSpendAllowanceMicroUsd: _prior, ...fresh } = retry;
  validateLivePlan({ ...fresh, perArmReservationUnits: '400000' });
  for (const prior of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null, '1505000', 7000001]) {
    assert.throws(() => validateLivePlan({ ...retry, priorModelSpendAllowanceMicroUsd: prior } as LivePlan), /Invalid prior model-spend allowance/);
  }
  for (const budget of ['200000', '300001', '399999', '400001', '0300000', '-300000', '3e5', 300000]) {
    assert.throws(() => validateLivePlan({ ...retry, perArmReservationUnits: budget } as LivePlan), /Invalid per-arm reservation ceiling/);
  }
  for (const cost of ['75000', '99999', '100001', 100000]) assert.throws(() => validateLivePlan({ ...retry, modelMaximumCallCost: cost } as LivePlan));
  for (const cost of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    assert.throws(() => validateLivePlan({ ...retry, reviewedMaximumCallMicroUsd: cost }), /Invalid reviewed per-call USD upper bound/);
  }
});

test('live source, scope, goal, policy, publication and complete usage roster are hard gates', () => {
  assertMatchedState(state(), plan);
  for (const altered of [
    { head: '5'.repeat(40) }, { gate: 'OPEN' }, { goalRevision: 'new' }, { policyRevision: 'new' },
    { unresolvedPublicationId: 'unknown' }, { scope: { ...plan.scope, projectIncarnation: 'new' } },
  ]) assert.throws(() => assertMatchedState({ ...state(), project: { ...state().project, ...altered } }, plan));
  assert.throws(() => assertMatchedState({ ...state(), modelCalls: { overflow: true, reservations: [] } }, plan));
  assert.throws(() => assertMatchedState({ ...state(), sourceManifests: {} }, plan));
});

test('journals cannot overwrite existing evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-benchmark-journal-'));
  try {
    const path = join(directory, 'events.jsonl'), journal = await Journal.create(path);
    await journal.append('failure', { observed: false }); await journal.close();
    await assert.rejects(Journal.create(path), { code: 'EEXIST' });
    assert.equal(JSON.parse((await readFile(path, 'utf8')).trim()).kind, 'failure');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('lost authority response retains exact command and prevents replacement dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-benchmark-live-'));
  let posts = 0;
  try {
    const benchmark = await LiveBenchmark.create(plan, join(directory, 'run'), {
      verifyDeployment: async (_plan, arm) => ({ ...plan, ...modes(arm), readbackDigest: 'sha256:' + '6'.repeat(64) }),
      fetch: async (_url, init) => { if (init.method === 'POST') { posts++; throw new Error('Owned lost response'); } return Response.json(state()); },
    }, 'APPROVED_REAL_MODEL_BENCHMARK');
    const result = await benchmark.runNextArm(); assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.needsOperatorReconciliation, true);
    assert.equal(posts, 1); await assert.rejects(benchmark.runNextArm(), /Resolve prior arm/); assert.equal(posts, 1); await benchmark.close();
    const journal = (await readFile(join(directory, 'run/events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const sent = journal.find(row => row.kind === 'command-dispatch'), unknown = journal.find(row => row.kind === 'command-unresolved');
    assert.deepEqual(unknown.data.frozen, sent.data.frozen);
    assert.equal(sent.data.frozen.headers['Idempotency-Key'], plan.runId + '-neither-create-attempt');
    assert.equal(sent.data.frozen.headers.Origin, plan.origin);
    assert.equal(JSON.parse(sent.data.frozen.body).maximumBudget, '400000');
    assert.deepEqual(JSON.parse(sent.data.frozen.body).allowedPaths, PATHS);
    assert.deepEqual(JSON.parse(sent.data.frozen.body).operations, ['checkpoint-context', 'model-inference', 'read-source', 'start-execution', 'submit-output', 'write-attempt']);
    assert(!journal.some(row => row.data?.operation === 'increase-budget' || row.data?.operation === 'request-publication'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('three-call retry records cumulative bounds, dispatches the exact grant and holds unexpected reservations', async () => {
  const retry: LivePlan = { ...plan, arms: ['both'], perArmReservationUnits: '300000',
    priorModelSpendAllowanceMicroUsd: 1505000, reviewedMaximumCallMicroUsd: 1505000, authorizedModelSpendMicroUsd: 7000000 };
  for (const [available, calls, cost] of [[300000, 3, '100000'], [300000, 4, '100000'], [300000, 3, '99999'], [299999, 0, '100000']] as const) {
    const directory = await mkdtemp(join(tmpdir(), 'confidence-benchmark-cumulative-'));
    const operations: string[] = []; let started = false, cleaned = false;
    try {
      const benchmark = await LiveBenchmark.create(retry, join(directory, 'run'), {
        verifyDeployment: async (_plan, arm) => ({ ...retry, ...modes(arm), readbackDigest: 'sha256:' + '6'.repeat(64) }),
        fetch: async (url, init) => {
          if (init.method === 'POST') {
            const operation = new URL(url).pathname.split('/').at(-1)!; operations.push(operation);
            if (operation === 'create-attempt') assert.equal(JSON.parse(String(init.body)).maximumBudget, '300000');
            if (operation === 'start-execution') started = true;
            if (operation === 'request-cleanup') cleaned = true;
            return Response.json({ id: 'attempt' });
          }
          return Response.json({ ...state(), project: { ...state().project, maximumBudget: '400000', settledBudget: String(400000 - available) },
            runtime: started ? [{ attemptId: 'attempt', generation: '1', lifecycle: 'STOPPED', verified: true, outcome: 'BUDGET_EXHAUSTED' }] : [],
            modelCalls: { overflow: false, reservations: started ? Array.from({ length: calls }, () => ({ attemptId: 'attempt', maximumCost: cost })) : [] },
            submissions: [], events: [], capsules: [], cleanups: cleaned ? [{ attemptId: 'attempt', phase: 'TOMBSTONED' }] : [] });
        },
      }, 'APPROVED_REAL_MODEL_BENCHMARK');
      const result = await benchmark.runNextArm(); await benchmark.close();
      const registration = JSON.parse((await readFile(join(directory, 'run/events.jsonl'), 'utf8')).split('\n')[0]).data;
      assert.equal(registration.maximumCalls, 3); assert.equal(registration.maximumReservationUnits, '300000');
      assert.equal(registration.reviewedPotentialModelSpendMicroUsd, 4515000);
      assert.equal(registration.priorModelSpendAllowanceMicroUsd, 1505000); assert.equal(registration.reviewedCumulativeModelSpendMicroUsd, 6020000);
      assert.equal(registration.unitsAreProviderSpend, false); assert.equal(registration.actualBilledCostMicroUsd, null);
      if (available < 300000) {
        assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.error, 'BENCHMARK_RESERVATION_UNAVAILABLE'); assert.deepEqual(operations, []);
      } else if (calls > 3 || cost !== '100000') {
        assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.error, 'MODEL_RESERVATION_BOUND_CHANGED');
        assert.equal(result.needsOperatorReconciliation, true); assert.equal(result.modelCalls, calls);
        assert.deepEqual(operations, ['create-attempt', 'start-execution']);
      } else {
        assert.equal(result.status, 'NO_SUBMISSION'); assert.equal(result.cleanup, 'TOMBSTONED'); assert.equal(result.modelCalls, 3);
        assert.deepEqual(operations, ['create-attempt', 'start-execution', 'request-cleanup']);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('latest verified termination and source ingestion are separate observations', () => {
  const runtime = { attemptId: 'attempt', generation: '1', lifecycle: 'STOPPED', verified: true, outcome: 'COMPLETED', sourceCommit: 'c'.repeat(40) };
  assert(latestStopped({ runtime: [runtime] }, 'attempt'));
  assert.equal(latestStopped({ runtime: [{ ...runtime, verified: false }] }, 'attempt'), undefined);
  assert.equal(latestStopped({ runtime: [runtime, { ...runtime, lifecycle: 'UNKNOWN' }] }, 'attempt'), undefined);
  assert.equal(ingestionResult({ submissions: [], events: [] }, 'attempt', runtime.sourceCommit).status, 'PENDING');
  assert.equal(ingestionResult({ submissions: [{ id: 'submission', attemptId: 'attempt', source: { commit: 'd'.repeat(40) } }], events: [] }, 'attempt', runtime.sourceCommit).status, 'PENDING');
  assert.equal(ingestionResult({ submissions: [], events: [{ payload: JSON.stringify({ kind: 'source-submission-rejected', objectId: 'attempt', payload: { commit: runtime.sourceCommit } }) }] }, 'attempt', runtime.sourceCommit).status, 'REJECTED');
});

test('Access transport is destination-scoped and never places credentials in URL or returned metadata', async () => {
  const token = 'a'.repeat(16) + '.' + 'b'.repeat(16) + '.' + 'c'.repeat(16);
  let received: any;
  const transport = accessTransport(plan.origin, token, async (url, init) => { received = { url, init }; return Response.json({ ok: true }); });
  await transport(plan.origin + '/api/session', {});
  assert.equal(received.init.headers.get('cf-access-token'), token); assert.equal(received.url.includes(token), false); assert.equal(received.init.redirect, 'error');
  await assert.rejects(transport('https://other.example.invalid/api/session', {}));
  await assert.rejects(transport(plan.origin + '/unrelated', {}));
  assert.throws(() => accessTransport(plan.origin, 'not-a-token'));
});

test('live arm waits after STOPPED for matching ingestion before evaluation and cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-benchmark-ingestion-'));
  const selected: LivePlan = { ...plan, arms: ['both'], ingestionMs: 6000 };
  let started = false, materialized = false, cleaned = false, readsAfterStart = 0;
  const operations: string[] = [];
  const commit = 'c'.repeat(40), candidateDigest = 'sha256:' + '9'.repeat(64);
  const jobs = probes.map(probe => ({ id: 'evaluation:' + probe.id, inputDigest: 'sha256:' + '8'.repeat(64), required: true, evidenceClass: 'protected-behavioural' as const }));
  try {
    const benchmark = await LiveBenchmark.create(selected, join(directory, 'run'), {
      verifyDeployment: async (_plan, arm) => ({ ...selected, ...modes(arm), readbackDigest: 'sha256:' + '6'.repeat(64) }),
      fetch: async (url, init) => {
        if (init.method === 'POST') {
          const operation = new URL(url).pathname.split('/').at(-1)!; operations.push(operation);
          if (operation === 'start-execution') started = true;
          if (operation === 'materialize') { assert(readsAfterStart >= 3, 'Materialized before source ingestion'); materialized = true; }
          if (operation === 'request-cleanup') { assert(materialized, 'Cleanup before full checks'); cleaned = true; }
          return Response.json({ id: operation === 'materialize' ? 'candidate' : 'attempt' });
        }
        if (started) readsAfterStart++;
        return Response.json({ ...state(), callerPermissions: { sponsor: true }, sourceManifests: { ...state().sourceManifests, [commit]: source.manifest },
          runtime: started ? [{ attemptId: 'attempt', generation: '1', lifecycle: 'STOPPED', verified: true, outcome: 'COMPLETED', sourceCommit: commit }] : [],
          modelCalls: { overflow: false, reservations: started ? [{ callId: 'call', attemptId: 'attempt', generation: '1', requestDigest: 'sha256:' + 'd'.repeat(64), maximumCost: '100000' }] : [] },
          submissions: readsAfterStart >= 3 ? [{ id: 'submission', attemptId: 'attempt', source: { commit, manifest: source.manifest, manifestDigest: source.sourceManifestDigest } }] : [], events: [],
          capsules: [{ attemptId: 'attempt', generation: '1', stage: 'session', sessionDigest: 'sha256:' + 'b'.repeat(64), missingSessionTail: false }],
          candidates: materialized ? [{ id: 'candidate' }] : [],
          plans: materialized ? [{ digest: 'sha256:' + 'a'.repeat(64), candidateId: 'candidate', candidateDigest, jobs }] : [],
          evidence: materialized ? jobs.map(job => ({ ...job, jobId: job.id, candidateId: 'candidate', candidateDigest, authorized: true, outcome: 'PASS' })) : [],
          cleanups: cleaned ? [{ attemptId: 'attempt', phase: 'TOMBSTONED' }] : [] });
      },
    }, 'APPROVED_REAL_MODEL_BENCHMARK');
    const result = await benchmark.runNextArm(); await benchmark.close();
    assert.equal(result.status, 'AUTHORITY_REPORTED_PASS'); assert.equal(result.ingestion.status, 'READY'); assert.equal(result.cleanup, 'TOMBSTONED');
    assert.equal(result.toolEvidence.completeness, 'REFERENCES_RETAINED'); assert.equal(result.toolEvidence.coverage, 'UNMEASURED_UNTIL_ARTIFACT_COLLECTION');
    assert.deepEqual(operations, ['create-attempt', 'start-execution', 'materialize', 'request-cleanup']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('malformed authority state is retained as incomplete before any mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-benchmark-malformed-'));
  let posts = 0;
  try {
    const benchmark = await LiveBenchmark.create({ ...plan, arms: ['both'] }, join(directory, 'run'), {
      verifyDeployment: async (_plan, arm) => ({ ...plan, ...modes(arm), readbackDigest: 'sha256:' + '6'.repeat(64) }),
      fetch: async (_url, init) => { if (init.method === 'POST') posts++; return new Response('not JSON'); },
    }, 'APPROVED_REAL_MODEL_BENCHMARK');
    const result = await benchmark.runNextArm(); assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.needsOperatorReconciliation, true); assert.equal(posts, 0); await benchmark.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('completion requires the exact nine protected job inputs, not nine arbitrary or duplicate results', () => {
  const jobs = probes.map(probe => ({ id: 'evaluation:' + probe.id, inputDigest: 'sha256:' + '8'.repeat(64), required: true, evidenceClass: 'protected-behavioural' as const }));
  const candidateId = 'candidate', candidateDigest = 'sha256:' + '9'.repeat(64);
  const complete: any = { plans: [{ digest: 'sha256:' + 'a'.repeat(64), candidateId, candidateDigest, jobs }], evidence: jobs.map(job => ({ ...job,
    jobId: job.id, candidateId, candidateDigest, authorized: true, outcome: 'PASS' })) };
  assert(completedPlan(complete, candidateId));
  assert.equal(completedPlan({ ...complete, candidateRead: { incompleteIds: [candidateId] } }, candidateId), undefined);
  assert.equal(completedPlan({ ...complete, evidence: complete.evidence.slice(1) }, candidateId), undefined);
  for (const patch of [{ inputDigest: 'wrong' }, { candidateDigest: 'wrong' }, { authorized: false }, { outcome: 'unknown' }, { evidenceClass: 'repository-check' }]) {
    const changed = structuredClone(complete); Object.assign(changed.evidence[0], patch); assert.equal(completedPlan(changed, candidateId), undefined);
  }
  const duplicate = structuredClone(complete); duplicate.plans[0].jobs[0] = duplicate.plans[0].jobs[1]; assert.equal(completedPlan(duplicate, candidateId), undefined);
});

test('wrong deployment modes stop before any authority mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-benchmark-pin-'));
  let requests = 0;
  try {
    const benchmark = await LiveBenchmark.create(plan, join(directory, 'run'), {
      verifyDeployment: async () => ({ ...plan, narsil: 'always', interlinked: 'feedback', readbackDigest: 'sha256:' + '6'.repeat(64) }),
      fetch: async () => { requests++; return Response.json(state()); },
    }, 'APPROVED_REAL_MODEL_BENCHMARK');
    const result = await benchmark.runNextArm(); assert.equal(result.status, 'INCOMPLETE'); assert.equal(requests, 0); await benchmark.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('ingestion timeout and uncertain cleanup hold reconciliation instead of reporting successful completion', async () => {
  for (const outcome of ['COMPLETED', 'FAILED']) {
    const directory = await mkdtemp(join(tmpdir(), 'confidence-benchmark-cleanup-'));
    const operations: string[] = [];
    try {
      const benchmark = await LiveBenchmark.create({ ...plan, arms: ['both'] }, join(directory, 'run'), {
        verifyDeployment: async (_plan, arm) => ({ ...plan, ...modes(arm), readbackDigest: 'sha256:' + '6'.repeat(64) }),
        fetch: async (url, init) => {
          if (init.method === 'POST') { const operation = new URL(url).pathname.split('/').at(-1)!; operations.push(operation);
            if (operation === 'request-cleanup') throw new Error('Owned cleanup response lost');
            return Response.json({ id: 'attempt' }); }
          return Response.json({ ...state(), runtime: [{ attemptId: 'attempt', generation: '1', lifecycle: 'STOPPED', verified: true, outcome, sourceCommit: 'c'.repeat(40) }],
            submissions: [], events: [], capsules: [], cleanups: [] });
        },
      }, 'APPROVED_REAL_MODEL_BENCHMARK');
      const result = await benchmark.runNextArm(); await benchmark.close();
      assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.needsOperatorReconciliation, true); assert.equal(result.unresolvedAttemptId, 'attempt');
      assert(!operations.includes('materialize'), 'No un-ingested source may be evaluated');
      if (outcome === 'COMPLETED') { assert.equal(result.error, 'BENCHMARK_INGESTION_TIMEOUT'); assert(!operations.includes('request-cleanup'), 'Ingestion uncertainty must retain the attempt'); }
      else { assert.equal(result.codingStatus, 'NO_SUBMISSION'); assert.equal(result.toolEvidence.completeness, 'MISSING_COMPLETE_SESSION'); assert(operations.includes('request-cleanup')); }
      await assert.rejects(benchmark.runNextArm(), /Resolve prior arm/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

async function materializationEpisode(options: { pendingReads?: number; evaluationMs?: number; unavailable?: { selected: boolean; status: number };
  scopeChanged?: boolean; evaluationReady?: boolean; onRead?: (selected: boolean) => void } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-benchmark-materialize-'));
  const selected: LivePlan = { ...plan, arms: ['both'], evaluationMs: options.evaluationMs ?? 1000 };
  const operations: string[] = [], materializationReads: boolean[] = [];
  let started = false, materialized = false, candidateVisible = false, cleaned = false, unfilteredReads = 0;
  const commit = 'c'.repeat(40), candidateDigest = 'sha256:' + '9'.repeat(64);
  const jobs = probes.map(probe => ({ id: 'evaluation:' + probe.id, inputDigest: 'sha256:' + '8'.repeat(64), required: true, evidenceClass: 'protected-behavioural' as const }));
  let benchmark: LiveBenchmark | undefined;
  try {
    benchmark = await LiveBenchmark.create(selected, join(directory, 'run'), {
      verifyDeployment: async (_plan, arm) => ({ ...selected, ...modes(arm), readbackDigest: 'sha256:' + '6'.repeat(64) }),
      fetch: async (url, init) => {
        const request = new URL(url);
        if (init.method === 'POST') {
          const operation = request.pathname.split('/').at(-1)!; operations.push(operation);
          if (operation === 'start-execution') started = true;
          if (operation === 'materialize') { materialized = true; return Response.json({ id: 'candidate', state: 'MATERIALIZATION_PENDING' }, { status: 202 }); }
          if (operation === 'request-cleanup') cleaned = true;
          return Response.json({ id: 'attempt' });
        }
        const scoped = request.searchParams.has('candidateId');
        if (materialized && !cleaned) {
          materializationReads.push(scoped); options.onRead?.(scoped);
          if (options.unavailable?.selected === scoped) return Response.json({ error: { code: 'REFERENCE_UNAVAILABLE' } }, { status: options.unavailable.status });
          if (scoped) {
            assert.equal(request.searchParams.get('candidateId'), 'candidate');
            if (!candidateVisible) return Response.json({ error: { code: 'REFERENCE_UNAVAILABLE' } }, { status: 404 });
          } else candidateVisible = ++unfilteredReads > (options.pendingReads ?? 0);
        }
        const evaluated = scoped && options.evaluationReady !== false;
        return Response.json({ ...state(), callerPermissions: { sponsor: true }, sourceManifests: { ...state().sourceManifests, [commit]: source.manifest }, project: { ...state().project,
          ...(materialized && options.scopeChanged ? { scope: { ...plan.scope, projectIncarnation: 'changed' } } : {}) },
          runtime: started ? [{ attemptId: 'attempt', generation: '1', lifecycle: 'STOPPED', verified: true, outcome: 'COMPLETED', sourceCommit: commit }] : [],
          modelCalls: { overflow: false, reservations: started ? [{ callId: 'call', attemptId: 'attempt', generation: '1', requestDigest: 'sha256:' + 'd'.repeat(64), maximumCost: '100000' }] : [] },
          submissions: started ? [{ id: 'submission', attemptId: 'attempt', source: { commit, manifest: source.manifest, manifestDigest: source.sourceManifestDigest } }] : [], events: [], capsules: [],
          candidates: [{ id: 'unrelated-candidate' }, ...(candidateVisible ? [{ id: 'candidate' }] : [])],
          plans: evaluated ? [{ digest: 'sha256:' + 'a'.repeat(64), candidateId: 'candidate', candidateDigest, jobs }] : [],
          evidence: evaluated ? jobs.map(job => ({ ...job, jobId: job.id, candidateId: 'candidate', candidateDigest, authorized: true, outcome: 'PASS' })) : [],
          cleanups: cleaned ? [{ attemptId: 'attempt', phase: 'TOMBSTONED' }] : [] });
      },
    }, 'APPROVED_REAL_MODEL_BENCHMARK');
    const result = await benchmark.runNextArm();
    if (result.status === 'INCOMPLETE') {
      const dispatched = [...operations]; await assert.rejects(benchmark.runNextArm(), /Resolve prior arm/); assert.deepEqual(operations, dispatched);
    }
    return { result, operations, materializationReads };
  } finally { await benchmark?.close(); await rm(directory, { recursive: true, force: true }); }
}

test('materialization acknowledgment waits for exact candidate existence before scoped evaluation reads', async () => {
  const { result, operations, materializationReads } = await materializationEpisode({ pendingReads: 1, evaluationMs: 6000 });
  assert.equal(result.status, 'AUTHORITY_REPORTED_PASS'); assert.equal(result.cleanup, 'TOMBSTONED');
  assert.equal(result.authorityEvidence.length, 9);
  assert.deepEqual(materializationReads.slice(0, 3), [false, false, true]);
  assert.deepEqual(operations, ['create-attempt', 'start-execution', 'materialize', 'request-cleanup']);
});

test('pending materialization times out without selecting another candidate or redispatching commands', async () => {
  const { result, operations, materializationReads } = await materializationEpisode({ pendingReads: Infinity });
  assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.error, 'BENCHMARK_EVALUATION_TIMEOUT');
  assert.equal(result.candidateId, 'candidate'); assert.equal(result.unresolvedAttemptId, 'attempt');
  assert.equal(result.cleanup, 'NOT_REQUESTED'); assert.equal(result.needsOperatorReconciliation, true);
  assert(materializationReads.every(selected => !selected));
  assert.deepEqual(operations, ['create-attempt', 'start-execution', 'materialize']);
});

test('candidate waiting and scoped evaluation share the registered deadline', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const { result, materializationReads, operations } = await materializationEpisode({ evaluationReady: false,
    onRead: selected => { now += selected ? 200 : 900; } });
  assert.equal(result.error, 'BENCHMARK_EVALUATION_TIMEOUT'); assert.deepEqual(materializationReads, [false, true]);
  assert.deepEqual(operations, ['create-attempt', 'start-execution', 'materialize']);
});

test('candidate polling fails closed on genuine HTTP failures and changed project scope', async () => {
  for (const selected of [false, true]) for (const status of [401, 403, 404, 500]) {
    const { result, operations, materializationReads } = await materializationEpisode({ unavailable: { selected, status } });
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.error, `Authority HTTP ${status}`);
    assert.deepEqual(materializationReads, selected ? [false, true] : [false]);
    assert.deepEqual(operations, ['create-attempt', 'start-execution', 'materialize']);
  }
  const { result, materializationReads } = await materializationEpisode({ scopeChanged: true });
  assert.equal(result.status, 'INCOMPLETE'); assert.match(result.error, /Benchmark scope changed/);
  assert.deepEqual(materializationReads, [false]);
});

type RecoveryResponse = 'stale' | 'unrecorded-stale' | 'wrong-rejection' | 'conflicting-outcome' | 'lost' | 'lost-committed'
  | 'malformed-committed' | 'unavailable-committed' | 'forbidden' | 'other-conflict';
async function recoveryEpisode(options: { operation?: 'materialize' | 'request-cleanup'; responses?: RecoveryResponse[];
  drift?: (snapshot: any) => void; initialPinDrift?: boolean; onRecoveryRead?: () => void; exhaustRequests?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-benchmark-recovery-'));
  const selected: LivePlan = { ...plan, arms: ['both'] };
  const targeted = options.operation ?? 'materialize', commit = 'c'.repeat(40), candidateDigest = 'sha256:' + '9'.repeat(64);
  const jobs = probes.map(probe => ({ id: 'evaluation:' + probe.id, inputDigest: 'sha256:' + '8'.repeat(64), required: true, evidenceClass: 'protected-behavioural' as const }));
  const intents: { operation: string; body: string; headers: Record<string, string>; signal: AbortSignal | null | undefined }[] = [];
  const committed = new Map<string, { digest: string; result?: any; error?: string }>(), events: any[] = [];
  const effects = { materialize: 0, cleanup: 0 }; let revision = 1, started = false, failures = 0, targetedDispatches = 0, readsAfterStart = 0;
  let benchmark: LiveBenchmark | undefined;
  try {
    benchmark = await LiveBenchmark.create(selected, join(directory, 'run'), {
      verifyDeployment: async (_plan, arm) => ({ ...selected, ...modes(arm), readbackDigest: 'sha256:' + '6'.repeat(64) }),
      fetch: async (url, init) => {
        const request = new URL(url);
        if (init.method === 'POST') {
          const operation = request.pathname.split('/').at(-1)!, headers = Object.fromEntries(new Headers(init.headers).entries()), body = String(init.body);
          const commandId = headers['idempotency-key'];
          const requestDigest = digest({ commandId, expectedRevision: headers['if-platform-revision'], expectedIncarnation: headers['if-platform-incarnation'], operation, body: JSON.parse(body) });
          intents.push({ operation, body, headers, signal: init.signal });
          const prior = committed.get(commandId);
          if (prior) {
            assert.equal(prior.digest, requestDigest, 'Rebased an existing authority command identity');
            return prior.error ? Response.json({ error: { code: prior.error } }, { status: 409 }) : Response.json(prior.result, { status: 202 });
          }
          const response = operation === targeted ? options.responses?.[targetedDispatches++] : undefined;
          if (response) failures++;
          if (response === 'forbidden' || response === 'other-conflict') return Response.json({ error: { code: response === 'forbidden' ? 'ROLE_REQUIRED' : 'COMMAND_ID_REUSED' } }, { status: response === 'forbidden' ? 403 : 409 });
          if (response === 'lost') { if (options.exhaustRequests) (benchmark as any).requests = maximumRequests(selected) - 1; throw new Error('Owned response lost before observation'); }
          if (response?.includes('stale') || response === 'wrong-rejection' || response === 'conflicting-outcome') {
            // An automatic individual candidate callback advances the revision
            // immediately before the frozen materialization command arrives.
            revision++;
            if (response !== 'unrecorded-stale') {
              committed.set(commandId, { digest: requestDigest, error: 'STALE_STATE' });
              events.push({ kind: 'command-rejected', objectId: commandId, payload: { operation, code: 'STALE_STATE',
                requestDigest: response === 'wrong-rejection' ? 'sha256:' + '0'.repeat(64) : requestDigest } });
              if (response === 'conflicting-outcome') events.push({ kind: operation, objectId: commandId, payload: { id: 'conflicting-effect' } });
            }
            return Response.json({ error: { code: 'STALE_STATE' } }, { status: 409 });
          }
          if (operation === 'start-execution') started = true;
          if (operation === 'materialize') effects.materialize++;
          if (operation === 'request-cleanup') effects.cleanup++;
          const result = { id: operation === 'materialize' ? 'candidate' : operation === 'request-cleanup' ? 'cleanup' : 'attempt' };
          committed.set(commandId, { digest: requestDigest, result }); revision++;
          events.push({ kind: operation, objectId: commandId, payload: result });
          if (response === 'lost-committed') throw new Error('Owned committed response lost');
          if (response === 'malformed-committed') return new Response('not JSON', { status: 202 });
          if (response === 'unavailable-committed') return Response.json({ error: { code: 'INFRASTRUCTURE_UNAVAILABLE' } }, { status: 503 });
          return Response.json(result, { status: 202 });
        }
        const evaluated = effects.materialize > 0 && request.searchParams.get('candidateId') === 'candidate';
        if (started) readsAfterStart++;
        const snapshot: any = { ...state(), project: { ...state().project, scope: { ...plan.scope }, revision: String(revision) }, callerPermissions: { sponsor: true },
          sourceManifests: { ...state().sourceManifests, [commit]: source.manifest },
          runtime: started ? [{ attemptId: 'attempt', generation: '1', lifecycle: 'STOPPED', verified: true, outcome: 'COMPLETED', sourceCommit: commit }] : [],
          modelCalls: { overflow: false, reservations: started ? [{ callId: 'call', attemptId: 'attempt', generation: '1', requestDigest: 'sha256:' + 'd'.repeat(64), maximumCost: '100000', state: 'SETTLED' }] : [] },
          submissions: started ? [{ id: 'submission', attemptId: 'attempt', source: { commit, manifestDigest: source.sourceManifestDigest, manifest: source.manifest } }] : [],
          events: events.map(event => ({ payload: JSON.stringify(event) })), capsules: [],
          candidates: [{ id: 'attempt-individual' }, ...(effects.materialize ? [{ id: 'candidate' }] : [])],
          plans: evaluated ? [{ digest: 'sha256:' + 'a'.repeat(64), candidateId: 'candidate', candidateDigest, jobs }] : [],
          evidence: evaluated ? jobs.map(job => ({ ...job, jobId: job.id, candidateId: 'candidate', candidateDigest, authorized: true, outcome: 'PASS' })) : [],
          cleanups: effects.cleanup ? [{ attemptId: 'attempt', phase: 'TOMBSTONED' }] : [] };
        if (failures) { options.drift?.(snapshot); options.onRecoveryRead?.(); }
        else if (options.initialPinDrift && (targeted === 'materialize' ? readsAfterStart >= 3 : effects.materialize > 0)) options.drift?.(snapshot);
        return Response.json(snapshot);
      },
    }, 'APPROVED_REAL_MODEL_BENCHMARK');
    const result = await benchmark.runNextArm();
    if (result.status === 'INCOMPLETE') { const count = intents.length; await assert.rejects(benchmark.runNextArm(), /Resolve prior arm/); assert.equal(intents.length, count); }
    await benchmark.close(); benchmark = undefined;
    const journal = (await readFile(join(directory, 'run/events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(intents.filter(intent => intent.operation === 'create-attempt').length, 1);
    assert.equal(intents.filter(intent => intent.operation === 'start-execution').length, 1);
    assert(!intents.some(intent => !['create-attempt', 'start-execution', 'materialize', 'request-cleanup'].includes(intent.operation)));
    return { result, intents, effects, journal };
  } finally { await benchmark?.close(); await rm(directory, { recursive: true, force: true }); }
}

test('recorded callback revision races reconcile unchanged materialization and cleanup without another model execution', async () => {
  for (const operation of ['materialize', 'request-cleanup'] as const) {
    const { result, intents, effects, journal } = await recoveryEpisode({ operation, responses: ['stale', 'stale'] });
    assert.equal(result.status, 'AUTHORITY_REPORTED_PASS'); assert.equal(result.cleanup, 'TOMBSTONED'); assert.equal(result.authorityEvidence.length, 9); assert.equal(result.modelCalls, 1);
    assert.deepEqual(effects, { materialize: 1, cleanup: 1 });
    const attempts = intents.filter(intent => intent.operation === operation), id = `${plan.runId}-both-${operation}`;
    assert.equal(attempts.length, 3); assert(attempts.every(intent => intent.body === attempts[0].body));
    assert.deepEqual(attempts.map(intent => intent.headers['idempotency-key']), [id, id + '-recovery-1', id + '-recovery-2']);
    assert.equal(journal.filter(row => row.kind === 'command-dispatch' && row.data.operation === operation).length, 1);
    const recoveries = journal.filter(row => row.kind === 'command-recovery-dispatch');
    assert.equal(recoveries.length, 2); assert(recoveries.every(row => row.data.operationId === id && row.data.modelCallsAdded === 0));
    assert.equal(journal.filter(row => row.kind === 'command-rejection-confirmed').length, 2);
  }
});

test('uncertain committed responses replay only the exact durable command and cannot duplicate effects', async () => {
  for (const operation of ['materialize', 'request-cleanup'] as const) for (const response of ['lost-committed', 'malformed-committed', 'unavailable-committed'] as const) {
    const { result, intents, effects, journal } = await recoveryEpisode({ operation, responses: [response] });
    assert.equal(result.status, 'AUTHORITY_REPORTED_PASS'); assert.equal(result.cleanup, 'TOMBSTONED'); assert.deepEqual(effects, { materialize: 1, cleanup: 1 });
    const attempts = intents.filter(intent => intent.operation === operation); assert.equal(attempts.length, 2);
    assert.equal(attempts[1].body, attempts[0].body); assert.deepEqual(attempts[1].headers, attempts[0].headers);
    assert.equal(journal.filter(row => row.kind === 'command-replay-dispatch').length, 1); assert.equal(journal.filter(row => row.kind === 'command-recovery-dispatch').length, 0);
  }
});

test('an uncertain dispatch followed by a durable stale rejection requires exact replay before a fresh identity', async () => {
  const { result, intents, effects } = await recoveryEpisode({ responses: ['lost', 'stale'] });
  assert.equal(result.status, 'AUTHORITY_REPORTED_PASS'); assert.deepEqual(effects, { materialize: 1, cleanup: 1 });
  const attempts = intents.filter(intent => intent.operation === 'materialize'); assert.equal(attempts.length, 3);
  assert.deepEqual(attempts[1].headers, attempts[0].headers); assert.equal(attempts[2].headers['idempotency-key'], attempts[0].headers['idempotency-key'] + '-recovery-1');
  const bounded = await recoveryEpisode({ responses: ['stale', 'lost', 'stale'] });
  assert.equal(bounded.result.status, 'AUTHORITY_REPORTED_PASS'); assert.deepEqual(bounded.effects, { materialize: 1, cleanup: 1 });
  const four = bounded.intents.filter(intent => intent.operation === 'materialize'); assert.equal(four.length, 4);
  assert.deepEqual(four[2].headers, four[1].headers); assert.equal(four[3].headers['idempotency-key'], four[0].headers['idempotency-key'] + '-recovery-2');
});

test('definitive nonstale rejections and unproven or conflicting stale outcomes never authorize a replacement', async () => {
  for (const response of ['forbidden', 'other-conflict', 'unrecorded-stale', 'wrong-rejection', 'conflicting-outcome'] as const) {
    const { result, intents, effects } = await recoveryEpisode({ responses: [response] });
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.cleanup, 'NOT_REQUESTED'); assert.equal(result.needsOperatorReconciliation, true);
    assert.equal(intents.filter(intent => intent.operation === 'materialize').length, 1); assert.deepEqual(effects, { materialize: 0, cleanup: 0 });
    assert(!intents.some(intent => intent.operation === 'request-cleanup'));
  }
});

test('recovery fences changed identity, accepted bytes, model roster, permissions and budget', async () => {
  const changes = [
    (snapshot: any) => { snapshot.project.scope.projectIncarnation = 'changed'; },
    (snapshot: any) => { snapshot.project.head = 'e'.repeat(40); },
    (snapshot: any) => { snapshot.project.goalRevision = 'changed'; },
    (snapshot: any) => { snapshot.project.policyRevision = 'changed'; },
    (snapshot: any) => { snapshot.project.gate = 'OPEN'; },
    (snapshot: any) => { snapshot.project.unresolvedPublicationId = 'changed'; },
    (snapshot: any) => { snapshot.runtime[0].generation = '2'; },
    (snapshot: any) => { snapshot.runtime.push({ ...snapshot.runtime[0], generation: '2' }); },
    (snapshot: any) => { snapshot.runtime[0].verified = false; },
    (snapshot: any) => { snapshot.runtime[0].sourceCommit = 'e'.repeat(40); },
    (snapshot: any) => { snapshot.submissions[0].id = 'changed'; },
    (snapshot: any) => { snapshot.submissions.push({ ...snapshot.submissions[0], id: 'new-submission' }); },
    (snapshot: any) => { snapshot.submissions[0].source.manifestDigest = 'sha256:' + 'e'.repeat(64); },
    (snapshot: any) => { delete snapshot.sourceManifests['c'.repeat(40)]; },
    (snapshot: any) => { snapshot.modelCalls.overflow = true; },
    (snapshot: any) => { snapshot.modelCalls.reservations.push({ ...snapshot.modelCalls.reservations[0], callId: 'new-call' }); },
    (snapshot: any) => { snapshot.modelCalls.reservations[0].requestDigest = 'sha256:' + 'e'.repeat(64); },
    (snapshot: any) => { snapshot.callerPermissions.sponsor = false; },
    (snapshot: any) => { snapshot.project.maximumBudget = '1600001'; },
    (snapshot: any) => { snapshot.project.reservedBudget = '1'; },
    (snapshot: any) => { snapshot.project.settledBudget = '1'; },
  ];
  for (const drift of changes) {
    const { result, intents } = await recoveryEpisode({ responses: ['stale'], drift });
    assert.equal(result.status, 'INCOMPLETE'); assert.equal(result.cleanup, 'NOT_REQUESTED');
    assert.equal(intents.filter(intent => intent.operation === 'materialize').length, 1);
  }
});

test('completed-source recovery guards drift before the initial materialize or cleanup dispatch', async () => {
  for (const operation of ['materialize', 'request-cleanup'] as const) {
    const { result, intents } = await recoveryEpisode({ operation, initialPinDrift: true, drift: snapshot => { snapshot.modelCalls.reservations.push({ ...snapshot.modelCalls.reservations[0], callId: 'new-call' }); } });
    assert.equal(result.status, 'INCOMPLETE'); assert.match(result.error, /RECOVERY_MODEL_ROSTER_CHANGED/);
    assert.equal(intents.filter(intent => intent.operation === operation).length, 0);
  }
});

test('repeated revision races and uncertain responses terminate within the registered recovery bounds', async () => {
  for (const operation of ['materialize', 'request-cleanup'] as const) {
    const stale = await recoveryEpisode({ operation, responses: ['stale', 'stale', 'stale'] });
    assert.equal(stale.result.status, 'INCOMPLETE'); assert.equal(stale.result.error, 'BENCHMARK_RECOVERY_LIMIT');
    assert.equal(stale.intents.filter(intent => intent.operation === operation).length, 3);
    const uncertain = await recoveryEpisode({ operation, responses: ['lost', 'lost'] });
    assert.equal(uncertain.result.status, 'INCOMPLETE'); assert.equal(uncertain.intents.filter(intent => intent.operation === operation).length, 2);
    const attempts = uncertain.intents.filter(intent => intent.operation === operation); assert.deepEqual(attempts[1].headers, attempts[0].headers);
    assert.equal(uncertain.journal.filter(row => row.kind === 'command-recovery-dispatch').length, 0);
  }
});

test('reconciliation requests share the evaluation deadline and cannot exceed the global request cap', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  for (const operation of ['materialize', 'request-cleanup'] as const) {
    const expired = await recoveryEpisode({ operation, responses: ['stale'], onRecoveryRead: () => { now += 1001; } });
    assert.equal(expired.result.error, operation === 'materialize' ? 'BENCHMARK_EVALUATION_TIMEOUT' : 'BENCHMARK_CLEANUP_TIMEOUT');
    assert.equal(expired.intents.filter(intent => intent.operation === operation).length, 1);
    assert(expired.intents.every(intent => intent.signal instanceof AbortSignal));
  }
  const capped = await recoveryEpisode({ responses: ['lost'], exhaustRequests: true });
  assert.equal(capped.result.error, 'BENCHMARK_REQUEST_LIMIT'); assert.equal(capped.intents.filter(intent => intent.operation === 'materialize').length, 1);
});

test('offline artifact collection verifies retained bytes and distinguishes invocation from exhaustive coverage', async () => {
  const prompt = { assignment: TASK, sourceCommit: plan.sourceCommit, sourceManifestDigest: plan.sourceManifestDigest, goalRevision: plan.goalRevision,
    untrustedSource: Object.fromEntries(PATHS.map(path => [path, source.files[path]])) };
  const stdout = JSON.stringify({ ok: true, preview: true, elapsedMs: 1, failures: [] });
  const session = { schemaVersion: 1, format: 'pi-sdk-1.0.2-session-entries-v1', trustClass: 'agent-reported-session', complete: true, sessionId: 'owned-session', selectedEntry: null,
    header: { type: 'session', id: 'owned-session', timestamp: '2026-10-11T00:00:00Z', cwd: '/owned' }, entries: [], messages: [], prompts: [], diagnostics: [],
    previews: [{ kind: 'interlinked-preview', acceptanceEligible: false, status: 'NO_BLOCKING_FINDINGS', sourceCoherence: 'COHERENT', process: { terminationObserved: true },
      identity: { cliEntryDigest: 'sha256:' + 'b'.repeat(64) }, capture: { stdout, stdoutDigest: hashBytes(stdout) }, failures: [] }] };
  const rawPrompt = Buffer.from(JSON.stringify(prompt)), rawSession = Buffer.from(JSON.stringify(session));
  const artifacts = new Map([[hashBytes(rawPrompt), rawPrompt], [hashBytes(rawSession), rawSession]]);
  const report = { planDigest: digest(plan), arm: 'both', attemptId: 'attempt', capsules: [{ attemptId: 'attempt', generation: '1', stage: 'session',
    renderedContextDigest: hashBytes(rawPrompt), sessionDigest: hashBytes(rawSession), sessionId: 'owned-session', selectedEntry: null, missingSessionTail: false }] };
  const result = await collectArtifacts(plan, report, async reference => artifacts.get(reference)!);
  assert.equal(result.status, 'ARTIFACTS_COLLECTED'); assert.equal(result.narsil, 'UNMEASURED'); assert.equal(result.interlinked, 'OBSERVED_PREVIEW_INVOCATION');
  assert.equal(result.comparisonEligible, false); assert.equal(result.actualBilledCostMicroUsd, null); assert.equal(result.promptBytes, rawPrompt.length);
  await assert.rejects(collectArtifacts(plan, report, async () => Buffer.from('{}')), /digest mismatch/);
  const missing = await collectArtifacts(plan, { ...report, capsules: [] }, async () => { throw new Error('Unexpected read'); });
  assert.equal(missing.status, 'INCOMPLETE_ARTIFACTS'); assert.equal(missing.interlinked, 'UNMEASURED');
});

async function collectPartialPreviews(previews: unknown[], arm: 'both' | 'neither' = 'both') {
  const session = { schemaVersion: 1, format: 'pi-sdk-1.0.2-session-entries-v1', trustClass: 'agent-reported-session', complete: false,
    sessionId: 'owned-partial-session', selectedEntry: null,
    header: { type: 'session', id: 'owned-partial-session', timestamp: '2026-10-11T00:00:00Z', cwd: '/owned' },
    entries: [], messages: [], prompts: [], diagnostics: [], previews };
  const raw = Buffer.from(JSON.stringify(session)), reference = hashBytes(raw);
  const report = { planDigest: digest(plan), arm, attemptId: 'attempt', capsules: [{ attemptId: 'attempt', generation: '1', stage: 'session',
    partialSessionDigest: reference, missingSessionTail: true }] };
  const result = await collectArtifacts(plan, report, async requested => { assert.equal(requested, reference); return raw; });
  assert.equal(result.status, 'INCOMPLETE_ARTIFACTS'); assert.equal(result.sessionComplete, false);
  assert.equal(result.comparisonEligible, false); assert.equal(result.acceptanceEligible, false); assert.equal(result.actualBilledCostMicroUsd, null);
  return result;
}

const retainedPreview = () => {
  const stdout = JSON.stringify({ ok: true, preview: true, elapsedMs: 1, failures: [] });
  return { kind: 'interlinked-preview', acceptanceEligible: false, status: 'NO_BLOCKING_FINDINGS', sourceCoherence: 'COHERENT',
    process: { terminationObserved: true }, identity: { cliEntryDigest: 'sha256:' + 'b'.repeat(64) },
    capture: { stdout, stdoutDigest: hashBytes(stdout) }, failures: [] };
};

test('missing previews cannot produce an observed-invocation limitation', async () => {
  const result = await collectPartialPreviews([]);
  assert.equal(result.interlinked, 'UNMEASURED'); assert.deepEqual(result.previews, []);
  assert.match(result.limitations.at(-1)!, /invocation is not established by the retained artifacts/);
  assert(!result.limitations.some(text => text.includes('invocation is observed')));
  const disabled = await collectPartialPreviews([], 'neither');
  assert.equal(disabled.interlinked, 'DISABLED'); assert.match(disabled.limitations.at(-1)!, /Interlinked was disabled/);
});

test('invalid preview evidence remains unmeasured in both metrics and limitation text', async () => {
  for (const patch of [
    { status: 'UNSUPPORTED' }, { sourceCoherence: 'CHANGED' }, { process: { terminationObserved: false } },
    { acceptanceEligible: true }, { identity: { cliEntryDigest: 'invalid' } },
    { capture: { stdout: '{}', stdoutDigest: hashBytes('different bytes') } },
  ]) {
    const invalid = { ...retainedPreview(), ...patch };
    for (const previews of [[invalid], [retainedPreview(), invalid]]) {
      const result = await collectPartialPreviews(previews);
      assert.equal(result.interlinked, 'UNMEASURED');
      assert.match(result.limitations.at(-1)!, /invocation is not established by the retained artifacts/);
      assert(!result.limitations.some(text => text.includes('invocation is observed')));
    }
  }
});

test('valid retained preview invocation does not promote an incomplete session or prove exhaustive coverage', async () => {
  for (const status of ['NO_BLOCKING_FINDINGS', 'FINDINGS']) {
    const result = await collectPartialPreviews([{ ...retainedPreview(), status }]);
    assert.equal(result.interlinked, 'OBSERVED_PREVIEW_INVOCATION'); assert.equal(result.previews.length, 1);
    assert.match(result.limitations.at(-1)!, /^Preview invocation is observed; exhaustive checker coverage and a quality advantage are not established\.$/);
    assert.equal(result.promptCount, 0); assert.equal(result.promptBytes, null);
  }
});

const retainedFailedPreview = () => ({ ...retainedPreview(), status: 'ERROR', reason: 'CLI_TIMEOUT', elapsedMs: 17001, cliElapsedMs: null,
  process: { terminationObserved: true, exitCode: null, signal: 'SIGTERM', stdoutBytes: 0, stderrBytes: 0 },
  capture: { stdout: '', stdoutDigest: hashBytes(''), stderr: '', stderrDigest: hashBytes('') } });

test('retained terminated CLI timeouts establish failed invocation, not a successful preview or checker coverage', async () => {
  for (const previews of [[retainedFailedPreview(), retainedFailedPreview()], [retainedPreview(), retainedFailedPreview()]]) {
    const result = await collectPartialPreviews(previews);
    assert.equal(result.interlinked, 'OBSERVED_FAILED_INVOCATION');
    assert.match(result.limitations.at(-1)!, /At least one retained preview invocation failed/);
    assert.match(result.limitations.at(-1)!, /successful complete preview set, exhaustive checker coverage and a quality advantage are not established/);
    assert.deepEqual(result.previews.at(-1), { status: 'ERROR', outcome: 'FAILED_PREVIEW', reason: 'CLI_TIMEOUT', elapsedMs: 17001, cliElapsedMs: null,
      sourceCoherence: 'COHERENT', terminationObserved: true, cliEntryDigest: 'sha256:' + 'b'.repeat(64), exitCode: null, signal: 'SIGTERM',
      stdoutBytes: 0, stderrBytes: 0, observedRules: [] });
    assert.equal(result.previews[0].outcome, previews[0].status === 'ERROR' ? 'FAILED_PREVIEW' : 'REPORTED_PREVIEW_RESULT');
  }
  const failed = retainedFailedPreview();
  const exited = await collectPartialPreviews([{ ...failed, reason: 'CLI_INVALID_OUTPUT', process: { ...failed.process, exitCode: 2, signal: null } }]);
  assert.equal(exited.interlinked, 'OBSERVED_FAILED_INVOCATION'); assert.equal(exited.previews[0].exitCode, 2);
  const disabled = await collectPartialPreviews([failed], 'neither');
  assert.equal(disabled.interlinked, 'DISABLED'); assert.match(disabled.limitations.at(-1)!, /Interlinked was disabled/);
});

test('failed preview classification requires retained process evidence and never promotes absent or invalid captures', async () => {
  const failed = retainedFailedPreview();
  for (const patch of [
    { reason: '' }, { reason: 'x'.repeat(1025) }, { reason: null }, { sourceCoherence: 'CHANGED' }, { acceptanceEligible: true },
    { identity: { cliEntryDigest: 'invalid' } }, { status: 'UNAVAILABLE' },
    { process: { ...failed.process, terminationObserved: false } }, { process: { ...failed.process, signal: null } },
    { reason: 'CLI_SPAWN_FAILED', process: { ...failed.process, signal: null } },
    { reason: 'PREVIEW_ABORTED', process: { ...failed.process, signal: null } },
    { process: { ...failed.process, signal: 'not-a-signal' } }, { process: { ...failed.process, signal: null, exitCode: -1 } },
    { process: { ...failed.process, stdoutBytes: 1 } }, { process: { ...failed.process, stderrBytes: 1 } },
    { capture: { ...failed.capture, stdoutDigest: hashBytes('changed') } }, { capture: { ...failed.capture, stderrDigest: hashBytes('changed') } },
    { capture: { stdout: '', stdoutDigest: hashBytes('') } },
  ]) {
    const invalid = { ...failed, ...patch };
    const result = await collectPartialPreviews([retainedPreview(), invalid]);
    assert.equal(result.interlinked, 'UNMEASURED'); assert.equal(result.previews.at(-1)!.outcome, 'UNMEASURED');
    assert.match(result.limitations.at(-1)!, /invocation is not established by the retained artifacts/);
    assert((result.previews.at(-1)!.reason?.length ?? 0) <= 1024);
  }
  const mixed = await collectPartialPreviews([failed, { ...failed, process: { ...failed.process, signal: null } }]);
  assert.equal(mixed.interlinked, 'OBSERVED_FAILED_INVOCATION');
  assert.deepEqual(mixed.previews.map(preview => preview.outcome), ['FAILED_PREVIEW', 'UNMEASURED']);
});
