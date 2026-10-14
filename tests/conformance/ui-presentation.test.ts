import test from 'node:test';
import assert from 'node:assert/strict';
import { currentConflict, currentReleasePlan, currentReview, formatReservationUnits, interactionMismatch, measuredDuration, publishedCandidate, releaseConflict, releaseGoalCases, releaseGoalStatus, releaseMetrics, repairBudgetIncrease, repairReservationDecision, repairStage, retryableLoader, reviewBase } from '../../apps/web/src/presentation';
import { VerificationSession } from '../../apps/web/src/verification-state';
import { createStateReader } from '../../apps/web/src/api';
import type { PlatformState } from '../../services/types';
import type { VerificationBundle } from '../../packages/protocol/src/types';

test('an earlier publication does not complete a newly selected candidate', () => {
  const state = { receipts: [{ candidateId: 'earlier' }], activeCandidateId: 'new-selection' } as unknown as PlatformState;
  assert.equal(publishedCandidate(state, state.activeCandidateId), false);
  assert.equal(publishedCandidate(state), false);
  assert.equal(publishedCandidate(state, 'earlier'), true);
  assert.equal(publishedCandidate({ ...state, receipts: [...state.receipts, { candidateId: 'new-selection' } as PlatformState['receipts'][number]] }, state.activeCandidateId), true);
});

test('repair guidance uses exact project reservation capacity and never presents it as provider cost', () => {
  const state = { capabilities: { deployment: true }, projectBudget: { maximumUnits: '2000000', reservedUnits: '200000', settledUnits: '1400000', availableUnits: '400000', repairReservationUnits: '400000', policyCapUnits: '3200000' } } as PlatformState;
  assert.deepEqual(repairReservationDecision(state), { allowed: true });
  assert.equal(formatReservationUnits('9007199254740993'), '9,007,199,254,740,993');
  const short = { ...state, projectBudget: { ...state.projectBudget!, settledUnits: '1400001', availableUnits: '399999' } };
  const decision = repairReservationDecision(short);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? '', /400,000 internal reservation units; 399,999 remain/);
  assert.match(decision.reason ?? '', /admin must record an audited budget increase/);
  assert.doesNotMatch(decision.reason ?? '', /\$|dollars|provider cost/i);
  const atCap = { ...state, projectBudget: { ...state.projectBudget!, maximumUnits: '3200000', reservedUnits: '0', settledUnits: '3200000', availableUnits: '0' } };
  assert.match(repairReservationDecision(atCap).reason ?? '', /reviewed policy change is required/);
  assert.equal(repairReservationDecision({ ...state, projectBudget: undefined }).allowed, false);
  assert.equal(repairReservationDecision({ ...state, projectBudget: { ...state.projectBudget!, availableUnits: '400001' } }).allowed, false);
  assert.deepEqual(repairReservationDecision({ ...state, capabilities: { ...state.capabilities, deployment: false }, projectBudget: undefined }), { allowed: true });
});

test('one-repair budget proposal uses the exact shortfall and stays within the policy cap', () => {
  const state = { capabilities: { deployment: true }, session: { principalId: 'owner', credentialClass: 'human' }, projectBudget: {
    maximumUnits: '2800000', reservedUnits: '0', settledUnits: '2800000', availableUnits: '0', repairReservationUnits: '400000', policyCapUnits: '3200000',
  } } as PlatformState;
  assert.deepEqual(repairBudgetIncrease(state), { increaseUnits: '400000', newMaximumUnits: '3200000' });
  assert.deepEqual(repairBudgetIncrease({ ...state, projectBudget: { ...state.projectBudget!, settledUnits: '2700000', availableUnits: '100000' } }), { increaseUnits: '300000', newMaximumUnits: '3100000' });
  assert.equal(repairBudgetIncrease({ ...state, projectBudget: { ...state.projectBudget!, maximumUnits: '3200000', settledUnits: '3200000' } }), undefined);
  assert.equal(repairBudgetIncrease({ ...state, projectBudget: { ...state.projectBudget!, reservedUnits: '100000', settledUnits: '2700000' } }), undefined);
  assert.equal(repairBudgetIncrease({ ...state, session: { principalId: 'agent', credentialClass: 'agent' } }), undefined);
  assert.equal(repairBudgetIncrease({ ...state, projectBudget: { ...state.projectBudget!, availableUnits: '1' } }), undefined);
  const maintenance = { ...state, capabilities: { ...state.capabilities, maintenance: true } };
  assert.equal(repairBudgetIncrease(maintenance), undefined);
  assert.deepEqual(repairReservationDecision(maintenance), { allowed: false, reason: 'Maintenance mode is read-only. Wait for the active deployment and a fresh project snapshot before starting a repair.' });
});

test('latest review follows durable input order, conflict follows active composition and base follows exact commit', () => {
  const state = { activeCandidateId: 'active', candidates: [{ id: 'baseline', commit: 'unrelated', attemptIds: [] }, { id: 'active', commit: 'new', publicationBase: 'old' }, { id: 'base', commit: 'old' }], reviews: [{ id: 'z-old', candidateId: 'active' }, { id: 'a-new', candidateId: 'active' }], conflicts: [{ id: 'current', candidateId: 'active' }, { id: 'later-unrelated', candidateId: 'other' }] } as unknown as PlatformState;
  assert.equal(currentReview(state, 'active')?.id, 'a-new');
  assert.equal(currentConflict(state)?.id, 'current');
  assert.equal(reviewBase(state, state.candidates[1])?.id, 'base');
  assert.equal(reviewBase(state, { ...state.candidates[1], publicationBase: 'missing' }), undefined);
  assert.equal(currentConflict({ ...state, activeCandidateId: undefined }), undefined);
});

test('interaction overview uses only an exact mismatch in the conflict trace or named failed evidence', () => {
  const mismatch = { step: 4, action: 'page', expected: 7976, observed: 4768, status: 200, responseDigest: 'response' };
  const conflict = { id: 'conflict', evidenceIds: ['named'], counterexample: [{ ...mismatch, observed: 7976 }, mismatch] } as PlatformState['conflicts'][number];
  const state = { evidence: [{ id: 'named', outcome: 'FAIL', observations: [{ ...mismatch, observed: 1 }] }, { id: 'other', outcome: 'FAIL', observations: [mismatch] }] } as unknown as PlatformState;
  assert.equal(interactionMismatch(state, conflict), mismatch);
  assert.equal(interactionMismatch(state, { ...conflict, counterexample: [] })?.observed, 1);
  assert.equal(interactionMismatch(state, { ...conflict, counterexample: [], evidenceIds: ['other-missing'] }), undefined);
  assert.equal(interactionMismatch(state), undefined);
});

test('release story selects only the behavioral conflict bound to its candidate', () => {
  const candidate = { id: 'selected', attemptIds: [] } as unknown as PlatformState['candidates'][number];
  const state = { conflicts: [
    { id: 'overlap', category: 'mechanical-overlap' },
    { id: 'unrelated', category: 'behavioural-interaction', candidateId: 'other' },
    { id: 'selected-interaction', category: 'behavioural-interaction', candidateId: 'selected' },
  ] } as unknown as PlatformState;
  assert.equal(releaseConflict(state), undefined);
  assert.equal(releaseConflict(state, candidate)?.id, 'selected-interaction');
  assert.equal(releaseConflict(state, { ...candidate, id: 'successor', repairOf: 'selected' })?.id, 'selected-interaction');
  assert.equal(releaseConflict({ ...state, conflicts: state.conflicts.slice(0, 2) }, candidate), undefined);
});

test('release metrics count exact required jobs and leave cost and attention unmeasured', () => {
  const candidate = { id: 'release', name: 'Selected release', attemptIds: ['first', 'repair'] } as PlatformState['candidates'][number];
  const state = {
    attempts: [
      { id: 'first', role: 'A', mode: 'pi', startedAt: '2026-10-07T12:00:00.000Z' },
      { id: 'repair', role: 'repair', mode: 'pi', startedAt: '2026-10-07T12:01:00.000Z' },
      { id: 'other-repair', role: 'repair', mode: 'pi', startedAt: '2026-10-08T12:00:00.000Z' },
    ],
    evaluations: [
      { candidateId: 'other', contract: 'retained-value-v1', jobs: [{ required: true, status: 'PASS' }] },
      { candidateId: 'release', contract: 'retained-value-v1', jobs: [
        { required: true, status: 'PASS' }, { required: true, status: 'FAIL' }, { required: false, status: 'PASS' },
      ] },
    ],
    events: [{ objectId: 'release', time: '2026-10-07T12:01:37.000Z' }, { objectId: 'unrelated', time: '2026-10-08T12:00:00.000Z' }], evidence: [], receipts: [], publications: [], candidates: [candidate], conflicts: [], demoStatus: 'ready',
    reviews: [{ candidateId: 'release', approval: { principal: 'reviewer' } }, { candidateId: 'other', approval: { principal: 'other-reviewer' } }],
  } as unknown as PlatformState;
  assert.deepEqual(releaseMetrics(state, candidate), {
    completedGoals: 0, totalGoals: 3, requiredJobs: 2, passedJobs: 1, recordedSpan: '1m 37s', spanBasis: 'First attempt to latest related record', modelCost: 'Unmeasured',
    repairAttempts: 1, repairContributors: 1, reviewerTime: 'Unmeasured', approvalCount: 1,
  });
  assert.equal(releaseMetrics(state).repairAttempts, 2);
  assert.equal(releaseMetrics(state).approvalCount, 2);
  assert.equal(releaseMetrics({ ...state, attempts: state.attempts.map(attempt => ({ ...attempt, mode: attempt.id === 'other-repair' ? 'pi' as const : 'scripted' as const })) }, candidate).modelCost, 'No model calls');
});

test('failed composition counts stopped repairs while the summary tracks the latest attempt', () => {
  const failed = { id: 'failed', name: 'A + B + C composition', commit: 'failed-source', attemptIds: ['a', 'b', 'c'], status: 'FAIL', outcome: 'FAIL' } as PlatformState['candidates'][number];
  const attempts = [
    ...['a', 'b', 'c'].map(id => ({ id, role: 'A', mode: 'pi', status: 'SUBMITTED', submissionId: `${id}-submission`, allowedPaths: [`${id}.mjs`], workBase: 'base' })),
    ...['repair-1', 'repair-2'].map(id => ({ id, role: 'repair', mode: 'pi', status: 'CANCELLED', workBase: 'failed-source', terminationObserved: true, executionOutcome: 'CANCELLED', allowedPaths: ['mutation.mjs'] })),
    { id: 'unrelated', role: 'repair', mode: 'pi', status: 'CANCELLED', workBase: 'other-source', terminationObserved: true, executionOutcome: 'CANCELLED', allowedPaths: ['mutation.mjs'] },
  ] as PlatformState['attempts'];
  const base = {
    attempts, candidates: [failed], conflicts: [{ id: 'conflict-failed', category: 'behavioural-interaction', candidateId: failed.id, repairAttemptId: 'repair-2', status: 'REPAIR_CANCELLED', summary: 'The combination failed.', evidenceIds: [], attemptIds: failed.attemptIds }],
    evaluations: [], evidence: [], events: [], reviews: [], publications: [], receipts: [], demoStatus: 'ACTIVE',
  } as unknown as PlatformState;
  const stoppedMetrics = releaseMetrics(base, failed);
  assert.equal(stoppedMetrics.repairAttempts, 2);
  assert.equal(stoppedMetrics.repairContributors, 0);
  assert.equal(stoppedMetrics.modelCost, 'Unmeasured');
  const recorded = {
    ...base,
    attempts: base.attempts.map(attempt => attempt.id === 'a' ? { ...attempt, startedAt: '2026-10-07T12:00:00.000Z' }
      : attempt.id === 'repair-2' ? { ...attempt, completedAt: '2026-10-07T12:04:00.000Z' }
        : attempt.id === 'unrelated' ? { ...attempt, completedAt: '2026-10-08T12:00:00.000Z' } : attempt),
    candidates: [{ ...failed, createdAt: '2026-10-07T12:01:00.000Z' }],
  } as PlatformState;
  assert.equal(releaseMetrics(recorded, recorded.candidates[0]).recordedSpan, '4m 00s');
  assert.equal(releaseMetrics(recorded, recorded.candidates[0]).spanBasis, 'First attempt to latest related record');
  assert.equal(releaseMetrics({ ...base, attempts: attempts.map(attempt => attempt.role === 'repair' ? attempt : { ...attempt, mode: 'scripted' }) as PlatformState['attempts'] }, failed).modelCost, 'Unmeasured');
  assert.equal(repairStage(base.attempts.find(attempt => attempt.id === base.conflicts[0]?.repairAttemptId)).heading, 'Repair stopped without source');
  assert.match(repairStage(base.attempts.find(attempt => attempt.id === base.conflicts[0]?.repairAttemptId)).description, /fresh bounded attempt is needed/);

  const running = {
    ...base,
    attempts: [...attempts, { id: 'repair-3', role: 'repair', mode: 'pi', status: 'RUNNING', workBase: 'failed-source', terminationObserved: false, allowedPaths: ['mutation.mjs'] }],
    conflicts: [{ ...base.conflicts[0]!, repairAttemptId: 'repair-3', status: 'REPAIRING' }],
  } as PlatformState;
  assert.equal(releaseMetrics(running, failed).repairAttempts, 3);
  assert.equal(releaseMetrics(running, failed).repairContributors, 0);
  assert.equal(repairStage(running.attempts.find(attempt => attempt.id === running.conflicts[0]?.repairAttemptId)).heading, 'Repair in progress');

  const successor: PlatformState['candidates'][number] = { ...failed, id: 'successor', name: 'Value-preserving repair', attemptIds: [...failed.attemptIds, 'repair-3'], repairOf: failed.id, outcome: 'PASS', status: 'PASS' };
  const submitted = { ...running, candidates: [failed, successor], attempts: running.attempts.map(attempt => attempt.id === 'repair-3' ? { ...attempt, status: 'SUBMITTED', submissionId: 'repair-3-submission' } : attempt) };
  assert.equal(releaseMetrics(submitted, successor).repairAttempts, 3);
  assert.equal(releaseMetrics(submitted, successor).repairContributors, 1);
});

test('deployed settled jobs use exact evidence and both registered probe aliases', () => {
  const names = ['warm-read-write-read', 'repeated-reads', 'successive-writes', 'cold-write', 'retained-cache-benefit', 'accessible-value', 'audit-write-burst', 'audit-alternating-pages', 'overlapping-read-write'];
  const plan = { id: 'evaluation', candidateId: 'release', contract: 'retained-value-v1', jobs: names.map(name => ({ id: `evaluation:${name}`, name, required: true, status: 'SETTLED' })) } as PlatformState['evaluations'][number];
  const candidate = { id: 'release', attemptIds: [] } as unknown as PlatformState['candidates'][number];
  const evidence: PlatformState['evidence'] = plan.jobs.map(job => ({
    id: `evidence:${job.id}`, candidateId: 'release', evaluationId: 'evaluation', jobId: job.id,
    evaluationInputDigest: 'input', checkerClass: 'external-behavioural', checkerId: 'fixture',
    environmentDigest: 'environment', fixtureDigest: 'fixture', outcome: 'PASS', observations: [],
    startedAt: '2026-10-07T12:00:00.000Z', completedAt: '2026-10-07T12:00:01.000Z',
    digest: `digest:${job.id}`, envelope: {}, limitations: [], observationDigest: 'observations',
  }));
  const state = { attempts: [], candidates: [candidate], conflicts: [], evaluations: [plan], evidence, events: [], reviews: [], publications: [], receipts: [] } as unknown as PlatformState;
  assert.equal(currentReleasePlan(state, candidate)?.id, plan.id, 'partial local snapshots retain their prior plan ordering');
  assert.equal(currentReleasePlan({ ...state, capabilities: { deployment: true } } as PlatformState, candidate), undefined, 'deployed snapshots need an authority-selected eligible plan');
  assert.equal(releaseMetrics(state, candidate).passedJobs, 9);
  assert.deepEqual(releaseGoalCases.map(goal => releaseGoalStatus(state, plan, goal.cases)), ['PASS', 'PASS', 'PASS']);
  const failedPresentation = { ...state, evidence: evidence.map(item => item.jobId.endsWith('audit-alternating-pages') ? { ...item, outcome: 'FAIL' as const } : item) };
  assert.deepEqual(releaseGoalCases.map(goal => releaseGoalStatus(failedPresentation, plan, goal.cases)), ['PASS', 'PASS', 'FAIL']);
  const missing = { ...state, evidence: evidence.filter(item => !item.jobId.endsWith('accessible-value')) };
  assert.equal(releaseGoalStatus(missing, plan, releaseGoalCases[2].cases), 'pending');
  const withReceipt = { ...state, attempts: [{ id: 'first', mode: 'pi', role: 'A' }], events: [{ objectId: 'first', time: '2026-10-07T12:00:00.000Z' }], receipts: [{ candidateId: 'release', createdAt: '2026-10-07T12:00:35.000Z' }] } as unknown as PlatformState;
  assert.equal(releaseMetrics(withReceipt, { ...candidate, attemptIds: ['first'] }).recordedSpan, '35s');
});

test('late prior-principal snapshots cannot restore private state after a newer authenticated response', async () => {
  let complete!: (state: PlatformState) => void;
  const previous = { tenantId: 't', projectId: 'p', projectIncarnation: 'i', revision: 100, session: { principalId: 'prior', credentialClass: 'human' } } as unknown as PlatformState;
  const current = { ...previous, revision: 3, session: { principalId: 'current', credentialClass: 'human' as const } };
  let calls = 0;
  const reader = createStateReader(() => calls++ ? Promise.resolve(current) : new Promise(resolve => { complete = resolve; }));
  const older = reader(); assert.strictEqual(await reader(), current); complete(previous); assert.strictEqual(await older, current);
});

test('verifier initialization retries after failure while concurrent consumers share successful initialization', async () => {
  let calls = 0;
  const load = retryableLoader(async () => { if (!calls++) throw new Error('Temporary module load failure'); return { ready: true }; });
  await assert.rejects(load(), /Temporary/);
  const [a, b] = await Promise.all([load(), load()]); assert.strictEqual(a, b); assert.equal(calls, 2);
});

test('failed input retry retains the latest file and clearing the checkpoint removes its retry', async () => {
  const session = new VerificationSession(); let calls = 0;
  await session.loadInput('bundle', 'latest.json', async () => { if (!calls++) throw new Error('Temporary initialization failure'); return { schemaVersion: 1 } as VerificationBundle; });
  assert.equal(session.getSnapshot().inputs.bundle.failed, true);
  await session.retryInput('bundle'); assert.equal(session.getSnapshot().inputs.bundle.name, 'latest.json'); assert.equal(session.getSnapshot().inputs.bundle.failed, undefined);
  await session.loadInput('checkpoint', 'checkpoint.json', async () => { calls++; throw new Error('Unreadable checkpoint'); });
  session.clearCheckpoint(); const before = calls; await session.retryInput('checkpoint'); assert.equal(calls, before);
});
