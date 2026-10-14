import test from 'node:test';
import assert from 'node:assert/strict';
import { uiSnapshot } from './adapter';
import { currentFinalChecksDecision, currentReleasePlan, measuredDuration, releaseGoalsPassed, releaseMetrics, reviewBase, stoppedWithoutSubmission } from '../../apps/web/src/presentation';
import type { AuthorityRead } from '../authority/types';

function read(): AuthorityRead {
  return { project: { scope: { tenantId: 't', projectId: 'p', projectIncarnation: 'i' }, revision: '4', observationRevision: '2', goalRevision: '1', head: 'base', gate: 'OPEN' },
    attempts: [{ id: 'attempt', generation: '2', workBase: 'base', publicationBase: 'base', allowedPaths: ['cache.mjs'] }], runtime: [], submissions: [],
    evidence: [], observations: {}, plans: [], candidates: [], reviews: [], approvals: [], publications: [], receipts: [], capsules: [], events: [], evaluations: [], evaluationIds: {}, sourceFiles: {}, sourceManifests: {}, baseline: { manifest: { entries: [] } },
  } as unknown as AuthorityRead;
}

test('a frozen Weft source with no attempt contributors is a release candidate, never the baseline control', () => {
  const input = read(), handoffId = 'a'.repeat(64), candidateId = `weft-${handoffId}`;
  const original = { path: 'cache.mjs', mode: '100644', bytes: '4', digest: 'sha256:' + 'b'.repeat(64) };
  const base = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [original] } as AuthorityRead['baseline']['manifest'];
  const selected = { ...base, entries: [{ ...original, digest: 'sha256:' + 'c'.repeat(64) }] } as AuthorityRead['baseline']['manifest'];
  input.baseline = { ...input.baseline, commit: 'base', manifest: base };
  input.sourceManifests.base = base;
  input.sourceFiles['frozen-commit'] = { 'cache.mjs': 'kept' };
  input.candidates = [
    { id: candidateId, digest: 'candidate-digest', commit: 'frozen-commit', parent: 'base', manifestDigest: 'selected-manifest', contributorIds: [], recipe: [`weft:${handoffId}`], source: { manifest: selected } },
    { id: 'enrolled-baseline', digest: 'base-digest', commit: 'base', parent: 'original-parent', manifestDigest: 'base-manifest', contributorIds: [], recipe: ['enrolled-baseline'], source: { manifest: base } },
  ] as unknown as AuthorityRead['candidates'];
  input.candidateRead = { currentId: candidateId, selectedId: null, candidateIds: [candidateId, 'enrolled-baseline'], incompleteIds: [], planLimit: 128, evidenceLimit: 128, observationLimit: 256, retainedFailureIds: [], events: [] };
  const state = uiSnapshot(input, { pi: true, publication: false });
  state.session = { principalId: 'owner', credentialClass: 'human' };
  const candidate = state.candidates.find(item => item.id === candidateId)!;
  assert.equal(candidate.name, 'Weft revision candidate');
  assert.equal(state.activeCandidateId, candidateId);
  assert.equal(state.candidates.find(item => item.name === 'Baseline')?.id, 'enrolled-baseline');
  assert.deepEqual(candidate.attemptIds, []); assert.deepEqual(candidate.submissionIds, []);
  assert.deepEqual(candidate.composition, [`weft:${handoffId}`]);
  assert.deepEqual(candidate.changedPaths, ['cache.mjs']);
  assert.deepEqual(candidate.sourceFiles, { 'cache.mjs': 'kept' });
  assert.equal(reviewBase(state, candidate)?.commit, 'base');
  assert.equal(currentFinalChecksDecision(state, candidate).allowed, true);
});

test('exact current candidate survives an unrelated timeline window and an explicit older selection', () => {
  const input = read();
  input.candidates = ['current', 'older'].map(id => ({ id, digest: id, commit: id, parent: 'base', manifestDigest: id, contributorIds: [], recipe: [], source: { manifest: { entries: [] } } })) as unknown as AuthorityRead['candidates'];
  input.events = Array.from({ length: 256 }, (_, index) => ({ sequence: index + 20, payload: JSON.stringify({ id: `event-${index}`, kind: 'execution-observed', objectId: 'attempt' }) }));
  input.candidateRead = { currentId: 'current', selectedId: 'older', candidateIds: ['current', 'older'], incompleteIds: [], planLimit: 128, evidenceLimit: 128, observationLimit: 256, retainedFailureIds: [],
    events: [{ sequence: 1, payload: JSON.stringify({ id: 'ready', kind: 'candidate-ready', objectId: 'current', time: '2026-10-08T00:00:00Z' }) }] };
  const state = uiSnapshot(input, { pi: true, publication: false });
  assert.equal(state.activeCandidateId, 'current');
  assert.equal(state.candidates.find(candidate => candidate.id === 'current')?.createdAt, '2026-10-08T00:00:00Z');
  assert.ok(state.candidates.every(candidate => candidate.evaluationReadComplete === true));
  assert.equal(state.events.length, 256, 'pinned context must not extend or reorder the display timeline');
  input.candidateRead.currentId = null;
  input.events = input.candidateRead.events;
  assert.equal(uiSnapshot(input, { pi: true, publication: false }).activeCandidateId, undefined, 'an exact empty selection must not fall back to history');
});

test('explicit candidate view overflow preserves observed PASS but cannot expose an eligible review plan', () => {
  const input = read();
  input.candidates = [{ id: 'selected', digest: 'candidate-digest', commit: 'selected', parent: 'base', manifestDigest: 'manifest', contributorIds: [], recipe: [], source: { manifest: { entries: [] } } }] as unknown as AuthorityRead['candidates'];
  const plan = { digest: 'plan', candidateId: 'selected', candidateDigest: 'candidate-digest', jobs: Array.from({ length: 9 }, (_, index) => ({ id: `job-${index}`, inputDigest: `input-${index}`, required: true, evidenceClass: 'protected-behavioural' as const })) };
  input.plans = [plan]; input.evaluationIds.plan = 'evaluation';
  input.evaluations = [{ id: 'evaluation', planDigest: 'plan', eligible: true }] as AuthorityRead['evaluations'];
  input.evidence = plan.jobs.map(job => ({ ...job, id: job.id, jobId: job.id, candidateId: 'selected', digest: job.id, outcome: 'PASS' }));
  input.candidateRead = { currentId: 'selected', selectedId: null, candidateIds: ['selected'], incompleteIds: ['selected'], planLimit: 128, evidenceLimit: 128, observationLimit: 256, retainedFailureIds: [], events: [] };
  const state = uiSnapshot(input, { pi: true, publication: false });
  assert.equal(state.candidates[0]?.outcome, 'PASS');
  assert.equal(state.candidates[0]?.outcomeProvenance, 'retained');
  assert.equal(state.candidates[0]?.reviewEvaluationId, undefined);
  assert.equal(state.candidates[0]?.evaluationReadComplete, false);
  assert.equal(releaseGoalsPassed(state, state.candidates[0]), false);
  assert.ok(state.limitations.some(item => /bounded plan\/evidence profile/.test(item)));
});

test('current-check admission distinguishes stale profile from incomplete or legacy candidate history', () => {
  const input = read();
  input.candidates = [{ id: 'selected', digest: 'candidate', commit: 'selected', parent: 'base', manifestDigest: 'manifest', contributorIds: [], recipe: [], source: { manifest: { entries: [] } } }] as unknown as AuthorityRead['candidates'];
  const plan = { digest: 'old-plan', candidateId: 'selected', candidateDigest: 'candidate', jobs: Array.from({ length: 8 }, (_, index) => ({ id: `old:${index}`, inputDigest: `input-${index}`, required: true, evidenceClass: 'protected-behavioural' as const })) };
  input.plans = [plan]; input.evaluationIds['old-plan'] = 'old-evaluation';
  input.evaluations = [{ id: 'old-evaluation', planDigest: 'old-plan', eligible: false }] as AuthorityRead['evaluations'];
  input.evidence = plan.jobs.map(job => ({ id: job.id, jobId: job.id, candidateId: 'selected', digest: job.id, inputDigest: job.inputDigest, outcome: 'PASS' }));
  input.candidateRead = { currentId: 'selected', selectedId: null, candidateIds: ['selected'], incompleteIds: [], planLimit: 128, evidenceLimit: 128, observationLimit: 256, retainedFailureIds: [], events: [] };
  const decide = () => {
    const state = uiSnapshot(input, { pi: true, publication: false });
    state.session = { principalId: 'owner', credentialClass: 'human' };
    assert.equal(state.candidates[0]?.outcome, 'PASS');
    assert.equal(state.candidates[0]?.outcomeProvenance, 'retained');
    assert.equal(releaseGoalsPassed(state, state.candidates[0]), false);
    return currentFinalChecksDecision(state, state.candidates[0]).allowed;
  };
  assert.equal(decide(), true);
  input.candidateRead.incompleteIds = ['selected']; assert.equal(decide(), false);
  input.candidateRead.incompleteIds = []; input.candidateRead.candidateIds = []; assert.equal(decide(), false);
  input.candidateRead = undefined; assert.equal(decide(), false);
});

test('authoritative evaluation order selects a newer full pass over an earlier infrastructure error and preserves later failures', () => {
  const input = read();
  const names = ['warm-read-write-read', 'repeated-reads', 'successive-writes', 'cold-write', 'retained-cache-benefit', 'accessible-value', 'audit-write-burst', 'audit-alternating-pages', 'overlapping-read-write'];
  input.candidates = [{ id: 'candidate', digest: 'candidate-digest', commit: 'candidate-commit', parent: 'base', manifestDigest: 'manifest', contributorIds: [], recipe: [], source: { manifest: { entries: [] } } }] as unknown as AuthorityRead['candidates'];
  for (const id of ['z-old', 'a-new']) {
    const plan = { digest: `${id}-plan`, candidateId: 'candidate', candidateDigest: 'candidate-digest', jobs: names.map(name => ({ id: `${id}:${name}`, inputDigest: `${name}-input`, required: true, evidenceClass: 'protected-behavioural' as const })) };
    input.plans.push(plan); input.evaluationIds[plan.digest] = id;
    input.evidence.push(...plan.jobs.map((job, index) => ({ id: job.id, digest: `${job.id}-digest`, candidateId: 'candidate', jobId: job.id, inputDigest: job.inputDigest, outcome: id === 'z-old' && index === 0 ? 'ERROR' : 'PASS' })));
  }
  // snapshot() orders these by authorityRevision. Plan storage order and UUID
  // lexical order both disagree, and neither is an evaluation-selection rule.
  input.evaluations = [{ id: 'a-new', planDigest: 'a-new-plan', authorityRevision: '50', eligible: true }, { id: 'z-old', planDigest: 'z-old-plan', authorityRevision: '40', eligible: true }] as AuthorityRead['evaluations'];
  const current = uiSnapshot(input, { pi: true, publication: false });
  assert.equal(current.candidates[0]!.reviewEvaluationId, 'a-new');
  assert.equal(current.evaluations.find(item => item.id === 'z-old')!.outcome, 'INCONCLUSIVE');
  assert.equal(releaseGoalsPassed(current, current.candidates[0]), true);

  input.evaluations[0]!.eligible = false;
  const checkerChanged = uiSnapshot(input, { pi: true, publication: false });
  assert.equal(checkerChanged.candidates[0]!.reviewEvaluationId, 'z-old');
  assert.equal(releaseGoalsPassed(checkerChanged, checkerChanged.candidates[0]), false);

  input.evaluations[0]!.eligible = true;
  input.evidence.push({ id: 'late-failure', digest: 'late-failure-digest', candidateId: 'candidate', jobId: 'z-old:warm-read-write-read', inputDigest: 'warm-read-write-read-input', outcome: 'FAIL' });
  const contradicted = uiSnapshot(input, { pi: true, publication: false });
  assert.equal(contradicted.candidates[0]!.reviewEvaluationId, 'a-new');
  assert.equal(releaseGoalsPassed(contradicted, contradicted.candidates[0]), false);
});

test('deployed attempt display uses current generation, durable observation order and exact terminal outcome', () => {
  for (const outcome of ['FAILED', 'CANCELLED', 'BUDGET_EXHAUSTED', 'COMPLETED']) {
    const input = read();
    input.runtime = [{ attemptId: 'attempt', generation: '1', lifecycle: 'STOPPED', outcome: 'COMPLETED' }, { attemptId: 'attempt', generation: '2', lifecycle: 'RUNNING', outcome: 'PENDING' }, { attemptId: 'attempt', generation: '2', lifecycle: 'STOPPED', outcome }];
    const attempt = uiSnapshot(input, { pi: true, publication: false }).attempts[0];
    assert.equal(attempt.executionOutcome, outcome); assert.equal(attempt.terminationObserved, true);
    assert.equal(attempt.status, outcome === 'COMPLETED' ? 'INGESTION_PENDING' : outcome);
    assert.equal(Boolean(attempt.error), outcome !== 'COMPLETED');
    assert.equal(stoppedWithoutSubmission(attempt), outcome !== 'COMPLETED');
    if (outcome !== 'COMPLETED') {
      assert.match(attempt.observed ?? '', /No immutable submission was accepted/);
      assert.match(attempt.observed ?? '', /does not identify a model or provider fault/);
      assert.doesNotMatch(attempt.error ?? '', /provider failed|model failed/i);
    }
  }
});

test('an accepted submission is composable even when a later runtime stop is reported', () => {
  const input = read();
  input.runtime = [{ attemptId: 'attempt', generation: '2', lifecycle: 'STOPPED', outcome: 'CANCELLED' }];
  input.submissions = [{ id: 'accepted', attemptId: 'attempt', source: { commit: 'accepted-source' } as AuthorityRead['baseline'] }];
  const attempt = uiSnapshot(input, { pi: true, publication: false }).attempts[0];
  assert.equal(attempt.status, 'SUBMITTED');
  assert.equal(stoppedWithoutSubmission(attempt), false);
});

test('deployed release span starts at the retained cohort admission, before execution observations', () => {
  const input = read();
  input.events = [
    { sequence: 1, payload: JSON.stringify({ id: 'launch-event', kind: 'launch-cohort', objectId: 'launch-command', time: '2026-10-08T00:00:00Z', payload: { state: 'COHORT_RESERVED', attempts: [{ id: 'attempt' }] } }) },
    { sequence: 2, payload: JSON.stringify({ id: 'runtime-event', kind: 'execution-observed', objectId: 'attempt', time: '2026-10-08T00:00:17Z', payload: { lifecycle: 'RUNNING' } }) },
  ] as AuthorityRead['events'];
  const state = uiSnapshot(input, { pi: true, publication: false });
  assert.equal(state.attempts[0]?.startedAt, '2026-10-08T00:00:00Z');
  assert.equal(releaseMetrics(state).recordedSpan, '17s');

  input.attempts.push({ ...input.attempts[0], id: 'repair', workBase: 'failed-source' });
  input.events.push({ sequence: 3, payload: JSON.stringify({ id: 'repair-event', kind: 'accept-proposal', objectId: 'repair-command', time: '2026-10-08T00:01:00Z', payload: { id: 'repair', state: 'REPAIR_RESERVED' } }) } as AuthorityRead['events'][number]);
  assert.equal(uiSnapshot(input, { pi: true, publication: false }).attempts.find(attempt => attempt.id === 'repair')?.startedAt, '2026-10-08T00:01:00Z');
});

test('deployed attempts show changed paths from their accepted source and exact work base', () => {
  const input = read();
  const entry = (path: string, digest: string, mode = '100644') => ({ path, mode, bytes: '2', digest });
  const base = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [entry('cache.mjs', 'sha256:' + 'a'.repeat(64)), entry('mutation.mjs', 'sha256:' + 'b'.repeat(64))] };
  input.sourceManifests.base = base as AuthorityRead['baseline']['manifest'];
  input.submissions = [{ id: 'accepted', attemptId: 'attempt', source: { commit: 'new-source', manifest: { ...base, entries: [entry('cache.mjs', 'sha256:' + 'c'.repeat(64)), entry('mutation.mjs', 'sha256:' + 'b'.repeat(64))] } } as AuthorityRead['baseline'] }];
  assert.deepEqual(uiSnapshot(input, { pi: true, publication: false }).attempts[0]?.changedPaths, ['cache.mjs']);
  input.sourceManifests = {};
  assert.equal(uiSnapshot(input, { pi: true, publication: false }).attempts[0]?.changedPaths, undefined);
});

test('evidence without observed start time and input identities does not claim measured duration or invented identities', () => {
  const input = read(); input.evidence = [{ id: 'e', digest: 'd', outcome: 'PASS' }]; input.observations.d = { completedAt: 100 };
  const evidence = uiSnapshot(input, { pi: false, publication: false }).evidence[0];
  assert.equal(evidence.startedAt, ''); assert.equal(evidence.environmentDigest, ''); assert.equal(evidence.fixtureDigest, '');
  assert.equal(evidence.storeReadCount, undefined);
  assert.equal(measuredDuration(evidence.startedAt, evidence.completedAt), 'Not recorded');
  assert.equal(measuredDuration('2026-10-05T10:00:00Z', '2026-10-05T10:00:02.500Z'), '2.50s');
  assert.equal(measuredDuration('2026-10-05T10:00:01Z', '2026-10-05T10:00:00Z'), 'Not recorded');
});

test('retained source-hydration diagnostics do not become HTTP rows or invented store measurements', () => {
  const input = read(); input.evidence = [{ id: 'e', digest: 'd', outcome: 'PASS' }];
  const hydration = { kind: 'source-hydration', files: 4, bytes: 1200, modes: 'verified-regular-644-or-755', inventory: 'exact' };
  const response = { step: 0, action: 'read', expected: 1234, observed: 1234, status: 200, responseDigest: 'sha256:' + 'a'.repeat(64), storeReadCount: 1 };
  const malformed = [null, { ...response, step: -1 }, { ...response, status: '200' }, { ...response, responseDigest: 'missing' }, { ...response, storeReadCount: -1 }, { ...response, observed: '<untrusted>' }];
  input.observations.d = { observations: [hydration, response, ...malformed], completedAt: 100 };
  const evidence = uiSnapshot(input, { pi: false, publication: false }).evidence[0];
  assert.deepEqual(evidence.observations, [response]);
  assert.deepEqual(evidence.diagnostics, [hydration, ...malformed]);
  assert.equal(evidence.storeReadCount, 1);

  input.observations.d = { observations: [hydration], error: 'Stopped before candidate HTTP response', completedAt: 100 };
  const interrupted = uiSnapshot(input, { pi: false, publication: false }).evidence[0];
  assert.deepEqual(interrupted.observations, []);
  assert.deepEqual(interrupted.diagnostics, [hydration]);
  assert.equal(interrupted.storeReadCount, undefined);

  const { storeReadCount: _count, ...unmeasuredResponse } = response;
  input.observations.d = { observations: [unmeasuredResponse] };
  const unmeasured = uiSnapshot(input, { pi: false, publication: false }).evidence[0];
  assert.deepEqual(unmeasured.observations, [unmeasuredResponse]);
  assert.equal(unmeasured.storeReadCount, undefined);
  input.observations.d = { observations: [{ ...response, storeReadCount: 0 }] };
  assert.equal(uiSnapshot(input, { pi: false, publication: false }).evidence[0].storeReadCount, 0);
});

test('publication configuration and authority admission gates remain distinct in the product snapshot', () => {
  for (const gate of ['OPEN', 'CLOSED', 'RECOVERY'] as const) {
    for (const configured of [false, true]) {
      const input = read(); input.project.gate = gate;
      const state = uiSnapshot(input, { pi: true, publication: configured });
      assert.equal(state.admission?.gate, gate);
      assert.equal(state.capabilities.publication, configured && gate === 'OPEN');
      assert.equal(state.gates.find(item => item.name === 'Conditional Artifacts publication')?.status, configured ? 'configured' : 'unverified');
      assert.deepEqual(state.gates.find(item => item.name === 'Authority publication admission'), { name: 'Authority publication admission', status: gate, detail: state.admission?.reason });
      assert.match(state.admission?.reason ?? '', gate === 'RECOVERY' ? /unresolved publication.*blocked/ : gate === 'CLOSED' ? /gate is closed.*blocked/ : configured ? /current applicable evidence, exact approval/ : /disabled in this deployment/);
    }
  }
});

test('maintenance is explicit in the project snapshot so the browser can pause new commands', () => {
  const paused = uiSnapshot(read(), { pi: false, publication: false, maintenance: true });
  assert.equal(paused.capabilities.maintenance, true);
  assert.match(paused.capabilities.piReason ?? '', /Maintenance mode is read-only/);
  const active = uiSnapshot(read(), { pi: true, publication: false, maintenance: false });
  assert.equal(active.capabilities.maintenance, false);
});

test('project reservation projection preserves exact internal counters and fails closed on inconsistent totals', () => {
  const input = read();
  const defaultScope = input.project.scope;
  Object.assign(input.project, { maximumBudget: '2000000', reservedBudget: '200000', settledBudget: '1400000' });
  assert.equal(uiSnapshot(input, { pi: true, publication: false }).goal.budget.maxAttempts, undefined);
  assert.deepEqual(uiSnapshot(input, { pi: true, publication: false }).projectBudget, {
    maximumUnits: '2000000', reservedUnits: '200000', settledUnits: '1400000', availableUnits: '400000', repairReservationUnits: '400000', policyCapUnits: '2800000',
  });
  input.project.scope = { schemaVersion: 1, tenantId: 'pilot', projectId: 'competition-demo-r2', projectIncarnation: 'c23de474-7628-47be-9cbd-65595953b3ee' };
  assert.equal(uiSnapshot(input, { pi: true, publication: false }).projectBudget?.policyCapUnits, '3600000');
  const r2Scope = input.project.scope;
  for (const wrongScope of [
    { ...r2Scope, tenantId: 'another-tenant' },
    { ...r2Scope, projectId: 'another-project' },
    { ...r2Scope, projectIncarnation: 'another-incarnation' },
  ]) {
    input.project.scope = wrongScope;
    assert.equal(uiSnapshot(input, { pi: true, publication: false }).projectBudget?.policyCapUnits, '2800000');
  }
  input.project.scope = defaultScope;
  input.project.settledBudget = '1400001';
  assert.equal(uiSnapshot(input, { pi: true, publication: false }).projectBudget?.availableUnits, '399999');
  Object.assign(input.project, { maximumBudget: '9007199254740993', reservedBudget: '9007199254740992', settledBudget: '0' });
  assert.equal(uiSnapshot(input, { pi: true, publication: false }).projectBudget?.availableUnits, '1');
  input.project.settledBudget = '2';
  assert.equal(uiSnapshot(input, { pi: true, publication: false }).projectBudget, undefined);
  input.project.maximumBudget = '02000000';
  assert.equal(uiSnapshot(input, { pi: true, publication: false }).projectBudget, undefined);
});

test('a failed or cancelled repair is terminal in the conflict display instead of holding the UI in REPAIRING', () => {
  const input = read();
  const source = { commit: 'composition', parent: 'base', manifest: { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [] }, commitBytesDigest: 'bytes', manifestDigest: 'manifest', objects: [], objectsDigest: 'objects' } as AuthorityRead['baseline'];
  input.attempts.push({ ...input.attempts[0], id: 'b', allowedPaths: ['mutation.mjs'] }, { ...input.attempts[0], id: 'repair', workBase: 'composition' });
  input.submissions = [{ id: 'sa', attemptId: 'attempt', source }, { id: 'sb', attemptId: 'b', source }];
  input.candidates = [{ id: 'c', scope: input.project.scope, digest: 'candidate', commit: 'composition', parent: 'base', commitBytesDigest: 'bytes', manifestDigest: 'manifest', source, contributorIds: ['sa', 'sb'], recipe: ['selection'] }];
  input.plans = [{ digest: 'plan', candidateId: 'c', candidateDigest: 'candidate', jobs: Array.from({ length: 9 }, (_, i) => ({ id: `job-${i}`, inputDigest: `input-${i}`, required: true, evidenceClass: 'protected-behavioural' })) }];
  input.evaluationIds.plan = 'evaluation'; input.evaluations = [{ id: 'evaluation', planDigest: 'plan', eligible: true }] as AuthorityRead['evaluations'];
  input.evidence = [{ id: 'failure', digest: 'failure', candidateId: 'c', jobId: 'job-0', outcome: 'FAIL' }];
  for (const outcome of ['FAILED', 'CANCELLED', 'BUDGET_EXHAUSTED']) {
    input.runtime = [{ attemptId: 'repair', generation: '2', lifecycle: 'STOPPED', outcome }];
    assert.equal(uiSnapshot(input, { pi: true, publication: false }).conflicts[0].status, `REPAIR_${outcome}`);
  }
  input.runtime = [{ attemptId: 'repair', generation: '2', lifecycle: 'STOPPED', outcome: 'COMPLETED' }];
  assert.equal(uiSnapshot(input, { pi: true, publication: false }).conflicts[0].status, 'REPAIRING');
});

test('a checker change retains the failed composition and its repair target without reusing old evidence for review', () => {
  const input = read();
  const source = { commit: 'composition', parent: 'base', manifest: { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [] }, commitBytesDigest: 'bytes', manifestDigest: 'manifest', objects: [], objectsDigest: 'objects' } as AuthorityRead['baseline'];
  input.attempts.push({ ...input.attempts[0]!, id: 'b', allowedPaths: ['mutation.mjs'] }, { ...input.attempts[0]!, id: 'repair', workBase: 'composition' });
  input.submissions = [{ id: 'sa', attemptId: 'attempt', source }, { id: 'sb', attemptId: 'b', source }];
  input.candidates = [{ id: 'failed', scope: input.project.scope, digest: 'candidate', commit: 'composition', parent: 'base', commitBytesDigest: 'bytes', manifestDigest: 'manifest', source, contributorIds: ['sa', 'sb'], recipe: ['selection'] }];
  input.plans = [{ digest: 'old-plan', candidateId: 'failed', candidateDigest: 'candidate', jobs: Array.from({ length: 8 }, (_, i) => ({ id: `old:${i === 0 ? 'warm-read-write-read' : `case-${i}`}`, inputDigest: `old-input-${i}`, required: true, evidenceClass: 'protected-behavioural' })) }];
  input.evaluationIds['old-plan'] = 'old-evaluation';
  input.evaluations = [{ id: 'old-evaluation', planDigest: 'old-plan', eligible: false, authorityRevision: '10' }] as AuthorityRead['evaluations'];
  input.evidence = [{ id: 'old-failure', digest: 'old-failure', candidateId: 'failed', jobId: 'old:warm-read-write-read', outcome: 'FAIL' }];
  input.observations['old-failure'] = { observations: [{ step: 2, action: 'GET', expected: 7976, observed: 4768, status: 200, responseDigest: 'sha256:' + 'a'.repeat(64) }] };
  input.runtime = [{ attemptId: 'repair', generation: '2', lifecycle: 'STOPPED', outcome: 'CANCELLED' }];

  const historical = uiSnapshot(input, { pi: true, publication: false });
  const candidate = historical.candidates.find(item => item.id === 'failed')!;
  assert.equal(candidate.outcome, 'FAIL');
  assert.equal(candidate.outcomeProvenance, 'retained');
  assert.equal(candidate.reviewEvaluationId, undefined);
  assert.equal(historical.conflicts[0]?.id, 'conflict-failed');
  assert.equal(historical.conflicts[0]?.repairAttemptId, 'repair');
  assert.equal(historical.conflicts[0]?.status, 'REPAIR_CANCELLED');
  assert.equal(historical.conflicts[0]?.counterexample?.[0]?.observed, 4768);
  assert.equal(currentReleasePlan(historical, candidate), undefined);
  assert.equal(releaseMetrics(historical, candidate).repairAttempts, 1);

  // A current one-job success cannot erase the retained eight-job failure.
  input.plans.push({ digest: 'new-freshness', candidateId: 'failed', candidateDigest: 'candidate', jobs: [{ id: 'new:freshness', inputDigest: 'fresh-input', required: true, evidenceClass: 'protected-behavioural' }] });
  input.evaluationIds['new-freshness'] = 'new-freshness-evaluation';
  input.evaluations.unshift({ id: 'new-freshness-evaluation', planDigest: 'new-freshness', eligible: true, authorityRevision: '11' } as AuthorityRead['evaluations'][number]);
  input.evidence.push({ id: 'new-freshness-pass', digest: 'new-freshness-pass', candidateId: 'failed', jobId: 'new:freshness', outcome: 'PASS' });
  const partial = uiSnapshot(input, { pi: true, publication: false });
  assert.equal(partial.candidates[0]?.outcome, 'FAIL');
  assert.equal(partial.candidates[0]?.outcomeProvenance, 'retained');
  assert.equal(partial.conflicts[0]?.id, 'conflict-failed');
  assert.equal(partial.candidates[0]?.reviewEvaluationId, undefined);

  // Even a later full PASS on this same source cannot nullify retained FAIL.
  const names = ['warm-read-write-read', 'repeated-reads', 'successive-writes', 'cold-write', 'retained-cache-benefit', 'accessible-value', 'audit-write-burst', 'audit-alternating-pages', 'overlapping-read-write'];
  input.plans.push({ digest: 'new-full', candidateId: 'failed', candidateDigest: 'candidate', jobs: names.map(name => ({ id: `new:${name}`, inputDigest: `input:${name}`, required: true, evidenceClass: 'protected-behavioural' })) });
  input.evaluationIds['new-full'] = 'new-full-evaluation';
  input.evaluations.unshift({ id: 'new-full-evaluation', planDigest: 'new-full', eligible: true, authorityRevision: '12' } as AuthorityRead['evaluations'][number]);
  input.evidence.push(...names.map(name => ({ id: `pass:${name}`, digest: `pass:${name}`, candidateId: 'failed', jobId: `new:${name}`, outcome: 'PASS' as const })));
  const contradictory = uiSnapshot(input, { pi: true, publication: false });
  assert.equal(contradictory.candidates[0]?.outcome, 'PASS');
  assert.equal(contradictory.candidates[0]?.outcomeProvenance, 'current');
  assert.equal(contradictory.conflicts[0]?.id, 'conflict-failed');
  assert.equal(currentReleasePlan(contradictory, contradictory.candidates[0])?.id, 'new-full-evaluation');
  assert.equal(releaseGoalsPassed(contradictory, contradictory.candidates[0]), false);
  input.evidence = input.evidence.slice(1);
  const withoutContradiction = uiSnapshot(input, { pi: true, publication: false });
  assert.equal(releaseGoalsPassed(withoutContradiction, withoutContradiction.candidates[0]), true);
});

test('a later repair and its successor supersede earlier repairs despite reversed UUID order', () => {
  const input = read();
  const source = { commit: 'composition', parent: 'base', manifest: { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [] }, commitBytesDigest: 'bytes', manifestDigest: 'manifest', objects: [], objectsDigest: 'objects' } as AuthorityRead['baseline'];
  const earlier = { ...input.attempts[0], id: 'z-earlier', workBase: 'composition', deadline: 1000 };
  const later = { ...input.attempts[0], id: 'a-later', workBase: 'composition', allowedPaths: ['mutation.mjs'], readOnlyContextPaths: ['cache.mjs'], deadline: 1001 };
  input.attempts.push({ ...input.attempts[0], id: 'b', allowedPaths: ['mutation.mjs'] }, later, earlier);
  input.submissions = [{ id: 'sa', attemptId: 'attempt', source }, { id: 'sb', attemptId: 'b', source }, { id: 'sold', attemptId: earlier.id, source: { ...source, commit: 'earlier-source' } }];
  input.candidates = [
    { id: 'failed', scope: input.project.scope, digest: 'candidate', commit: 'composition', parent: 'base', commitBytesDigest: 'bytes', manifestDigest: 'manifest', source, contributorIds: ['sa', 'sb'], recipe: ['selection'] },
    { id: 'earlier-candidate', scope: input.project.scope, digest: 'earlier-candidate', commit: 'earlier-source', parent: 'base', commitBytesDigest: 'bytes', manifestDigest: 'manifest', source: { ...source, commit: 'earlier-source' }, contributorIds: ['sa', 'sb', 'sold'], recipe: ['sold'] },
  ];
  input.plans = [{ digest: 'failed-plan', candidateId: 'failed', candidateDigest: 'candidate', jobs: [{ id: 'failed-job', inputDigest: 'input', required: true, evidenceClass: 'protected-behavioural' }] }];
  input.evaluationIds['failed-plan'] = 'failed-evaluation'; input.evaluations = [{ id: 'failed-evaluation', planDigest: 'failed-plan', eligible: true }] as AuthorityRead['evaluations'];
  input.evidence = [{ id: 'failure', digest: 'failure', candidateId: 'failed', jobId: 'failed-job', outcome: 'FAIL' }];
  input.runtime = [{ attemptId: earlier.id, generation: '2', lifecycle: 'STOPPED', outcome: 'CANCELLED' }, { attemptId: later.id, generation: '2', lifecycle: 'RUNNING', outcome: 'PENDING' }];
  let state = uiSnapshot(input, { pi: true, publication: false });
  assert.equal(state.conflicts[0].repairAttemptId, later.id);
  assert.equal(state.conflicts[0].repairCandidateId, undefined);
  assert.equal(state.conflicts[0].status, 'REPAIRING');
  assert.deepEqual(state.attempts.find(attempt => attempt.id === later.id)?.readOnlyContextPaths, ['cache.mjs']);
  assert.equal(state.attempts.filter(attempt => attempt.role === 'repair').length, 2);

  // A later start in the same second is ordered by the retained command events.
  earlier.deadline = later.deadline;
  input.events = [
    { sequence: 1, payload: JSON.stringify({ kind: 'start-repair', objectId: 'cmd-old', payload: { id: earlier.id, state: 'REPAIR_RESERVED' } }) },
    { sequence: 2, payload: JSON.stringify({ kind: 'start-repair', objectId: 'cmd-new', payload: { id: later.id, state: 'REPAIR_RESERVED' } }) },
  ];
  state = uiSnapshot(input, { pi: true, publication: false });
  assert.equal(state.conflicts[0].repairAttemptId, later.id);

  input.submissions.push({ id: 'snew', attemptId: later.id, source: { ...source, commit: 'later-source' } });
  input.candidates.push({ id: 'later-candidate', scope: input.project.scope, digest: 'later-candidate', commit: 'later-source', parent: 'base', commitBytesDigest: 'bytes', manifestDigest: 'manifest', source: { ...source, commit: 'later-source' }, contributorIds: ['sa', 'sb', 'snew'], recipe: ['snew'] });
  input.plans.push({ digest: 'later-plan', candidateId: 'later-candidate', candidateDigest: 'later-candidate', jobs: [{ id: 'later-job', inputDigest: 'input', required: true, evidenceClass: 'protected-behavioural' }] });
  input.evaluationIds['later-plan'] = 'later-evaluation'; input.evaluations.push({ id: 'later-evaluation', planDigest: 'later-plan', eligible: true } as AuthorityRead['evaluations'][number]);
  input.evidence.push({ id: 'later-pass', digest: 'later-pass', candidateId: 'later-candidate', jobId: 'later-job', outcome: 'PASS' });
  state = uiSnapshot(input, { pi: true, publication: false });
  assert.equal(state.conflicts[0].repairCandidateId, 'later-candidate');
  assert.equal(state.conflicts[0].status, 'REPAIR_CHECKS_PENDING', 'a one-job PASS does not resolve the integrated failure');
  assert.equal(state.candidates.find(candidate => candidate.id === 'later-candidate')?.repairOf, 'failed');

  const names = ['warm-read-write-read', 'repeated-reads', 'successive-writes', 'cold-write', 'retained-cache-benefit', 'accessible-value', 'audit-write-burst', 'audit-alternating-pages', 'overlapping-read-write'];
  input.plans.push({ digest: 'full-plan', candidateId: 'later-candidate', candidateDigest: 'later-candidate', jobs: names.map(name => ({ id: `full:${name}`, inputDigest: `full-input:${name}`, required: true, evidenceClass: 'protected-behavioural' })) });
  input.evaluationIds['full-plan'] = 'full-evaluation';
  input.evaluations.push({ id: 'full-evaluation', planDigest: 'full-plan', eligible: true } as AuthorityRead['evaluations'][number]);
  input.evidence.push(...names.map(name => ({ id: `full-pass:${name}`, digest: `full-pass:${name}`, candidateId: 'later-candidate', jobId: `full:${name}`, outcome: 'PASS' as const })));
  state = uiSnapshot(input, { pi: true, publication: false });
  assert.equal(state.conflicts[0].status, 'RESOLVED', 'eligible nine-job PASS resolves the repair');

  input.plans.push({ digest: 'old-repair-plan', candidateId: 'later-candidate', candidateDigest: 'later-candidate', jobs: [{ id: 'old-repair:stale-write', inputDigest: 'old-repair-input', required: true, evidenceClass: 'protected-behavioural' }] });
  input.evaluationIds['old-repair-plan'] = 'old-repair-evaluation';
  input.evaluations.push({ id: 'old-repair-evaluation', planDigest: 'old-repair-plan', eligible: false } as AuthorityRead['evaluations'][number]);
  input.evidence.push({ id: 'old-repair-failure', digest: 'old-repair-failure', candidateId: 'later-candidate', jobId: 'old-repair:stale-write', outcome: 'FAIL' });
  state = uiSnapshot(input, { pi: true, publication: false });
  assert.equal(state.conflicts.find(conflict => conflict.candidateId === 'failed')?.status, 'REPAIR_CONTRADICTED', 'retained exact-candidate FAIL blocks a later full PASS');
  assert.equal(releaseGoalsPassed(state, state.candidates.find(candidate => candidate.id === 'later-candidate')), false);
});

test('a second repair successor names its immediate failed source despite inherited repair contributors', () => {
  const input = read();
  const source = { commit: 'failed-source', parent: 'base', manifest: { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [] }, commitBytesDigest: 'bytes', manifestDigest: 'manifest', objects: [], objectsDigest: 'objects' } as AuthorityRead['baseline'];
  input.attempts.push(
    { ...input.attempts[0]!, id: 'first-repair', workBase: 'failed-source' },
    { ...input.attempts[0]!, id: 'second-repair', workBase: 'first-source' },
  );
  input.submissions = [
    { id: 'original', attemptId: 'attempt', source },
    { id: 'first', attemptId: 'first-repair', source: { ...source, commit: 'first-source' } },
    { id: 'second', attemptId: 'second-repair', source: { ...source, commit: 'second-source' } },
  ];
  const candidate = (id: string, commit: string, contributors: string[], recipe: string[]) => ({
    id, scope: input.project.scope, digest: id, commit, parent: 'base', commitBytesDigest: 'bytes', manifestDigest: 'manifest',
    source: { ...source, commit }, contributorIds: contributors, recipe,
  });
  input.candidates = [
    candidate('failed', 'failed-source', ['original'], ['original']),
    candidate('first-candidate', 'first-source', ['original', 'first'], ['first']),
    candidate('second-candidate', 'second-source', ['original', 'first', 'second'], ['second']),
  ];
  const result = uiSnapshot(input, { pi: true, publication: false });
  assert.equal(result.candidates.find(item => item.id === 'first-candidate')?.repairOf, 'failed');
  assert.equal(result.candidates.find(item => item.id === 'second-candidate')?.repairOf, 'first-candidate');
});


test('step-free overlap responses retain the exact counterexample and allowed values, while barriers remain diagnostics', () => {
  const input = read();
  const source = { commit: 'accepted-repair', parent: 'base', manifest: { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [] }, commitBytesDigest: 'bytes', manifestDigest: 'manifest', objects: [], objectsDigest: 'objects' } as AuthorityRead['baseline'];
  input.attempts.push({ ...input.attempts[0]!, id: 'b', allowedPaths: ['mutation.mjs'] });
  input.submissions = [{ id: 'sa', attemptId: 'attempt', source }, { id: 'sb', attemptId: 'b', source }];
  input.candidates = [{ id: 'current', scope: input.project.scope, digest: 'candidate', commit: source.commit, parent: 'base', commitBytesDigest: 'bytes', manifestDigest: 'manifest', source, contributorIds: ['sa', 'sb'], recipe: ['selection'] }];
  const names = ['warm-read-write-read', 'repeated-reads', 'successive-writes', 'cold-write', 'retained-cache-benefit', 'accessible-value', 'audit-write-burst', 'audit-alternating-pages', 'overlapping-read-write'];
  input.plans = [{ digest: 'nine-plan', candidateId: 'current', candidateDigest: 'candidate', jobs: names.map(name => ({ id: `nine:${name}`, inputDigest: `input:${name}`, required: true, evidenceClass: 'protected-behavioural' })) }];
  input.evaluationIds['nine-plan'] = 'nine';
  input.evaluations = [{ id: 'nine', planDigest: 'nine-plan', eligible: true }] as AuthorityRead['evaluations'];
  input.evidence = names.map(name => ({ id: name, digest: name, candidateId: 'current', jobId: `nine:${name}`, outcome: name === 'overlapping-read-write' ? 'FAIL' : 'PASS' }));
  const hydration = { kind: 'source-hydration', files: 4, bytes: 3119, inventory: 'exact' };
  const captured = { action: 'overlap-captured', expected: 2104, observed: 2104, storeReadCount: 1 };
  const released = { action: 'overlap-released', afterWriteStatus: 200 };
  const write = { action: 'write', expected: 5136, observed: 5136, status: 200, responseDigest: 'sha256:' + 'a'.repeat(64) };
  const overlapping = { action: 'overlap-read', expectedOneOf: [2104, 5136], observed: 2104, status: 200, responseDigest: 'sha256:' + 'b'.repeat(64) };
  const fresh = { action: 'read', expected: 5136, observed: 2104, status: 200, responseDigest: overlapping.responseDigest };
  const retained = [hydration, captured, write, released, overlapping, fresh];
  const original = structuredClone(retained);
  input.observations['overlapping-read-write'] = { observations: retained };
  const projected = uiSnapshot(input, { pi: true, publication: false });
  const failure = projected.evidence.find(item => item.id === 'overlapping-read-write')!;
  assert.ok(failure.observations.every(item => item.step === undefined && item.storeReadCount === undefined));
  assert.deepEqual(failure.observations, [write, overlapping, fresh]);
  assert.deepEqual(failure.diagnostics, [hydration, captured, released]);
  assert.equal(failure.storeReadCount, undefined, 'a barrier count must not become an HTTP measurement');
  assert.deepEqual(projected.conflicts[0]?.counterexample, [write, overlapping, fresh]);
  assert.equal(projected.conflicts[0]?.candidateId, 'current');
  assert.equal(projected.candidates[0]?.outcome, 'FAIL');
  assert.equal(releaseGoalsPassed(projected, projected.candidates[0]), false);
  assert.deepEqual(retained, original, 'projection must not invent or mutate signed rows');

  const malformed = [
    { ...write, step: -1 }, { ...write, step: 0.5 }, { ...write, status: undefined },
    { ...overlapping, expectedOneOf: [] }, { ...overlapping, expectedOneOf: [2104, '5136'] },
    { ...overlapping, expectedOneOf: [NaN] }, { ...overlapping, expectedOneOf: '2104 or 5136' },
  ];
  input.observations['overlapping-read-write'] = { observations: malformed };
  const rejected = uiSnapshot(input, { pi: true, publication: false }).evidence.find(item => item.id === 'overlapping-read-write')!;
  assert.deepEqual(rejected.observations, []);
  assert.deepEqual(rejected.diagnostics, malformed);
});
