/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlatformState } from '../../../services/types';
import { ApiError } from './api';
import { CommandSession, freezeCommand, type PendingCommand } from './commands';
import { currentFinalChecksDecision, finalChecksRetryDecision, releaseGoalCases, releaseGoalsPassed } from './presentation';
import { Workspace } from './Workspace';

function retryState(): PlatformState {
  const candidateId = 'exact-source', evaluationId = 'current-full';
  const names = releaseGoalCases.flatMap(goal => goal.cases.map(aliases => aliases[0]));
  return {
    schemaVersion: 1, tenantId: 'tenant', projectId: 'project', projectIncarnation: 'incarnation', revision: 50, observationRevision: 20,
    acceptedHead: 'base', enrollmentDigest: 'enrollment', activeCandidateId: candidateId,
    session: { principalId: 'issuer#owner', credentialClass: 'human' },
    capabilities: { deployment: true, pi: true, publication: false, scripted: false },
    goal: { id: 'goal', revision: '1', title: 'Fresh values and useful caching', description: '', constraints: [], contracts: [], budget: { authoringSeconds: 600, evaluationSeconds: 30 } },
    attempts: [], candidates: [{ id: candidateId, name: 'Accepted repair source', digest: 'candidate-digest', commit: 'commit', commitBytesDigest: 'commit-bytes', manifestDigest: 'manifest',
      manifest: { schemaVersion: 1, profile: 'ascii-regular-v1', entries: [] }, publicationBase: 'base', attemptIds: [], submissionIds: [], composition: [],
      status: 'INCONCLUSIVE', outcome: 'INCONCLUSIVE', outcomeProvenance: 'current', evaluationIds: [evaluationId], reviewEvaluationId: evaluationId, changedPaths: [], createdAt: '' }],
    evaluations: [{ id: evaluationId, candidateId, contract: 'retained-value-v1', planDigest: 'plan', aggregation: 'all-required-pass', status: 'SETTLED', outcome: 'INCONCLUSIVE', createdAt: '',
      jobs: names.map(name => ({ id: `${evaluationId}:${name}`, name, required: true, checkerClass: 'external-behavioural', candidateId, evaluationInputDigest: `input-${name}`, input: {}, status: 'SETTLED' })) }],
    evidence: names.map((name, index) => ({ id: `evidence-${name}`, digest: `digest-${name}`, candidateId, evaluationId, jobId: `${evaluationId}:${name}`, evaluationInputDigest: `input-${name}`,
      checkerClass: 'external-behavioural', checkerId: 'checker', environmentDigest: 'environment', fixtureDigest: 'fixture', outcome: index === 0 ? 'ERROR' : 'PASS',
      observations: [], startedAt: '', completedAt: '', envelope: null, limitations: [], observationDigest: `observation-${name}` })),
    conflicts: [], capsules: [], reviews: [], publications: [], receipts: [], commands: [], events: [], demoStatus: 'READY', limitations: [], gates: [],
  };
}

function render(state: PlatformState, busy = ''): string {
  return renderToStaticMarkup(createElement(Workspace, { state, busy, command: async () => true, openReview: () => {}, selected: [], setSelected: () => {} }));
}
function retryButton(html: string): string {
  const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).filter(button => button.includes('Run final checks again'));
  assert.equal(buttons.length, 1);
  return buttons[0]!;
}

function retainedState(): PlatformState {
  const state = retryState(), candidate = state.candidates[0]!, plan = state.evaluations[0]!;
  candidate.reviewEvaluationId = undefined; candidate.evaluationReadComplete = true;
  candidate.outcome = 'PASS'; candidate.status = 'PASS'; candidate.outcomeProvenance = 'retained';
  plan.jobs = plan.jobs.filter(job => job.name !== 'overlapping-read-write'); plan.outcome = 'PASS';
  state.evidence = state.evidence.filter(item => plan.jobs.some(job => job.id === item.jobId)).map(item => ({ ...item, outcome: 'PASS' }));
  return state;
}

function currentChecksButton(html: string): string {
  const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).filter(button => button.includes('Run current final checks'));
  assert.equal(buttons.length, 1);
  return buttons[0]!;
}

test('retained eight-case PASS offers exact current checks without qualifying the old result for review', () => {
  const state = retainedState(), candidate = state.candidates[0]!, before = structuredClone(state);
  assert.equal(currentFinalChecksDecision(state, candidate).allowed, true);
  assert.doesNotMatch(currentChecksButton(render(state)), /\bdisabled=""/);
  assert.match(render(state), /all 9 current final checks/);
  assert.match(render(state), /<button[^>]*disabled=""[^>]*>Review this release/);
  assert.equal(releaseGoalsPassed(state, candidate), false);
  const command = freezeCommand(state, 'Run current final checks', '/api/evaluate', { candidateId: candidate.id, evaluationId: 'old-plan', source: 'replacement' }, 'current-command');
  assert.equal(command.path, '/v1/projects/project/request-evaluation');
  assert.deepEqual(JSON.parse(command.body), { candidateId: candidate.id });
  assert.equal(command.headers['If-Platform-Revision'], '50');
  assert.deepEqual(state, before, 'rendering and freezing must preserve every historical result');
});

test('a changed checker or an unevaluated immutable candidate may register current checks only with complete authority context', () => {
  const state = retryState(), candidate = state.candidates[0]!;
  candidate.reviewEvaluationId = undefined; candidate.evaluationReadComplete = true; candidate.outcomeProvenance = 'retained';
  assert.equal(currentFinalChecksDecision(state, candidate).allowed, true, 'nine historical jobs do not imply current checker eligibility');
  state.evaluations = []; state.evidence = []; candidate.evaluationIds = []; candidate.outcome = undefined;
  assert.equal(currentFinalChecksDecision(state, candidate).allowed, true);
  for (const completeness of [false, undefined]) {
    candidate.evaluationReadComplete = completeness;
    assert.equal(currentFinalChecksDecision(state, candidate).allowed, false);
    assert.match(currentChecksButton(render(state)), /\bdisabled=""/);
    assert.throws(() => freezeCommand(state, 'Run current final checks', '/api/evaluate', { candidateId: candidate.id }), /complete authoritative view/);
  }
});

test('current checks respect maintenance, verified human sessions, pending commands and pending source evaluations', () => {
  const paused = retainedState(); paused.capabilities.maintenance = true;
  assert.equal(currentFinalChecksDecision(paused, paused.candidates[0]).allowed, false);
  assert.match(currentChecksButton(render(paused)), /\bdisabled=""/);
  assert.match(currentChecksButton(render(retainedState(), 'Commands paused')), /\bdisabled=""/);
  for (const credentialClass of ['agent', 'service'] as const) {
    const state = retainedState(); state.session!.credentialClass = credentialClass;
    assert.equal(currentFinalChecksDecision(state, state.candidates[0]).allowed, false);
  }
  const unsigned = retainedState(); unsigned.session = undefined;
  assert.equal(currentFinalChecksDecision(unsigned, unsigned.candidates[0]).allowed, false);
  const local = retainedState(); local.capabilities.deployment = false;
  assert.equal(currentFinalChecksDecision(local, local.candidates[0]).allowed, false);
  assert.doesNotMatch(render(local), />Run current final checks</);
  for (const pendingJob of [true, false]) {
    const state = retainedState();
    if (pendingJob) state.evaluations[0]!.jobs[0]!.status = 'PENDING';
    else state.evaluations[0]!.status = 'RUNNING';
    assert.equal(currentFinalChecksDecision(state, state.candidates[0]).allowed, false);
    assert.match(currentChecksButton(render(state)), /\bdisabled=""/);
    assert.throws(() => freezeCommand(state, 'Run current final checks', '/api/evaluate', { candidateId: 'exact-source' }), /Wait for the registered checks/);
  }
});

test('retained failures and any recorded publication keep current-check registration unavailable', () => {
  for (const failureSource of ['evidence', 'conflict', 'outcome']) {
    const state = retainedState(), candidate = state.candidates[0]!;
    if (failureSource === 'evidence') state.evidence[0]!.outcome = 'FAIL';
    else if (failureSource === 'conflict') state.conflicts.push({ id: 'retained-failure', category: 'behavioural-interaction', candidateId: candidate.id, attemptIds: [], status: 'OPEN', summary: '', evidenceIds: [] });
    else candidate.outcome = 'FAIL';
    assert.equal(currentFinalChecksDecision(state, candidate).allowed, false);
    assert.throws(() => freezeCommand(state, 'Run current final checks', '/api/evaluate', { candidateId: candidate.id }), /repair successor/);
  }
  const state = retainedState(), candidate = state.candidates[0]!;
  state.publications.push({ candidateId: candidate.id, status: 'UNKNOWN' } as PlatformState['publications'][number]);
  assert.equal(currentFinalChecksDecision(state, candidate).allowed, false);
  state.publications = []; state.receipts.push({ candidateId: candidate.id } as PlatformState['receipts'][number]);
  assert.equal(currentFinalChecksDecision(state, candidate).allowed, false);
});

test('once a current full plan appears the migration action disappears and cannot start a duplicate', () => {
  const state = retainedState(), candidate = state.candidates[0]!;
  candidate.reviewEvaluationId = 'new-current';
  state.evaluations.push({ ...structuredClone(retryState().evaluations[0]!), id: 'new-current', status: 'RUNNING', outcome: undefined });
  assert.equal(currentFinalChecksDecision(state, candidate).allowed, false);
  assert.doesNotMatch(render(state), />Run current final checks</);
  assert.throws(() => freezeCommand(state, 'Run current final checks', '/api/evaluate', { candidateId: candidate.id }), /Wait for the registered checks/);
});

test('an uncertain current-check request blocks new intent and survives reload with its exact original identity', async () => {
  const data = new Map<string, string>(), sent: PendingCommand[] = [], state = retainedState();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const first = new CommandSession(storage, async command => { sent.push(structuredClone(command)); throw new ApiError('Response lost'); });
  assert.equal(await first.begin(state, 'Run current final checks', '/api/evaluate', { candidateId: 'exact-source' }), false);
  await assert.rejects(first.begin(state, 'Run current final checks', '/api/evaluate', { candidateId: 'exact-source' }), /Resolve the retained command/);
  state.revision = 90; state.candidates[0]!.reviewEvaluationId = 'new-admitted-plan';
  const recovered = new CommandSession(storage, async command => { sent.push(structuredClone(command)); });
  assert.equal(await recovered.retry(state), true);
  for (const key of ['id', 'scope', 'path', 'body', 'headers'] as const) assert.deepEqual(sent[1]![key], sent[0]![key]);
  assert.equal(sent.length, 2);
});

test('one terminal error offers a fresh nine-job evaluation of the exact source through the existing scoped command', () => {
  const state = retryState(), candidate = state.candidates[0]!;
  assert.equal(finalChecksRetryDecision(state, candidate).allowed, true);
  assert.doesNotMatch(retryButton(render(state)), /\bdisabled=""/);
  assert.match(render(state), /all 9 final checks once more on this exact source/);
  const command = freezeCommand(state, 'Run final checks again', '/api/evaluate', { candidateId: candidate.id, evaluationId: 'injected', source: 'replacement' }, 'retry-command');
  assert.equal(command.path, '/v1/projects/project/request-evaluation');
  assert.deepEqual(JSON.parse(command.body), { candidateId: candidate.id });
  assert.equal(command.headers['If-Platform-Revision'], '50');
  assert.equal(command.headers['If-Platform-Incarnation'], 'incarnation');
  assert.equal(command.headers['If-Platform-Principal'], 'issuer#owner');
  candidate.id = 'different-source';
  assert.deepEqual(JSON.parse(command.body), { candidateId: 'exact-source' });
});

test('retry stays disabled for maintenance, a command in flight, or any running checks on this source', () => {
  const paused = retryState(); paused.capabilities.maintenance = true;
  assert.match(retryButton(render(paused)), /\bdisabled=""/);
  assert.throws(() => freezeCommand(paused, 'Retry', '/api/evaluate', { candidateId: 'exact-source' }), /Maintenance mode/);
  assert.match(retryButton(render(retryState(), 'Sending')), /\bdisabled=""/);
  for (const samePlan of [true, false]) {
    const running = retryState();
    if (samePlan) { running.evaluations[0]!.status = 'RUNNING'; running.evaluations[0]!.jobs[7]!.status = 'PENDING'; running.evidence.pop(); }
    else { running.evaluations.push({ ...structuredClone(running.evaluations[0]!), id: 'new-full', status: 'RUNNING', outcome: undefined }); running.candidates[0]!.reviewEvaluationId = 'new-full'; }
    assert.match(retryButton(render(running)), /\bdisabled=""/);
    assert.throws(() => freezeCommand(running, 'Retry', '/api/evaluate', { candidateId: 'exact-source' }), /Wait for the registered checks/);
  }
});

test('missing, duplicate or mismatched evidence cannot unlock another evaluation', () => {
  const cases = [
    (state: PlatformState) => { state.evidence.pop(); },
    (state: PlatformState) => { state.evidence.push(structuredClone(state.evidence[0]!)); },
    (state: PlatformState) => { state.evidence[0]!.evaluationInputDigest = 'different-input'; },
    (state: PlatformState) => { state.evidence[0]!.candidateId = 'another-source'; },
    (state: PlatformState) => { state.evidence[0]!.evaluationId = 'older-evaluation'; },
  ];
  for (const mutate of cases) {
    const state = retryState(); mutate(state);
    assert.equal(finalChecksRetryDecision(state, state.candidates[0]).allowed, false);
    assert.throws(() => freezeCommand(state, 'Retry', '/api/evaluate', { candidateId: 'exact-source' }), /matching retained result/);
  }
});

test('only a current full plan with an explicit inconclusive result can retry; retained failures still require source repair', () => {
  const state = retryState(); state.evidence[0]!.outcome = 'INCONCLUSIVE';
  assert.equal(finalChecksRetryDecision(state, state.candidates[0]).allowed, true);
  state.candidates[0]!.reviewEvaluationId = undefined;
  assert.equal(finalChecksRetryDecision(state, state.candidates[0]).allowed, false, 'an old checker plan is not current');
  state.candidates[0]!.reviewEvaluationId = 'current-full';
  state.evidence.push({ ...state.evidence[0]!, id: 'later-failure', evaluationId: 'another-plan', jobId: 'later-job', outcome: 'FAIL' });
  assert.equal(finalChecksRetryDecision(state, state.candidates[0]).allowed, false, 'a failure from any plan survives');
  assert.throws(() => freezeCommand(state, 'Retry', '/api/evaluate', { candidateId: 'exact-source' }), /repair successor/);
  const local = retryState(); local.capabilities.deployment = false;
  assert.equal(finalChecksRetryDecision(local, local.candidates[0]).allowed, false);
  assert.throws(() => freezeCommand(local, 'Retry', '/api/evaluate', { candidateId: 'exact-source' }), /Unsupported local command/);
});

test('a later nine-job PASS leaves the earlier error recorded and hides the retry action', () => {
  const state = retryState(), candidate = state.candidates[0]!, old = state.evaluations[0]!;
  const latest = { ...structuredClone(old), id: 'a-new-full', planDigest: 'latest-plan', outcome: 'PASS' as const };
  latest.jobs = latest.jobs.map(job => ({ ...job, id: `a-new:${job.name}` }));
  state.evaluations.unshift(latest); candidate.reviewEvaluationId = latest.id; candidate.outcome = 'PASS';
  state.evidence.push(...latest.jobs.map(job => ({ ...state.evidence[0]!, id: `new:${job.id}`, jobId: job.id, evaluationId: latest.id, evaluationInputDigest: job.evaluationInputDigest, outcome: 'PASS' as const })));
  assert.equal(releaseGoalsPassed(state, candidate), true);
  assert.equal(state.evidence.filter(item => item.outcome === 'ERROR').length, 1);
  assert.doesNotMatch(render(state), />Run final checks again</);
  assert.equal(finalChecksRetryDecision(state, candidate).allowed, false);
  state.evidence.push({ ...state.evidence[0]!, id: 'late-failure', evaluationId: 'older-plan', outcome: 'FAIL' });
  assert.equal(releaseGoalsPassed(state, candidate), false);
});

test('lost evaluation acknowledgement and reload recover the original command instead of starting another plan', async () => {
  const data = new Map<string, string>(), sent: PendingCommand[] = [], state = retryState();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const first = new CommandSession(storage, async command => { sent.push(structuredClone(command)); throw new ApiError('Response lost'); });
  assert.equal(await first.begin(state, 'Run final checks again', '/api/evaluate', { candidateId: 'exact-source' }), false);
  await assert.rejects(first.begin(state, 'Run final checks again', '/api/evaluate', { candidateId: 'exact-source' }), /Resolve the retained command/);
  state.revision = 60; state.candidates[0]!.reviewEvaluationId = 'already-admitted-new-plan';
  const recovered = new CommandSession(storage, async command => { sent.push(structuredClone(command)); });
  assert.equal(await recovered.retry(state), true);
  for (const key of ['id', 'scope', 'path', 'body', 'headers'] as const) assert.deepEqual(sent[1]![key], sent[0]![key]);
  assert.equal(sent.length, 2);
  assert.equal(recovered.getSnapshot().pending, undefined);
});

test('a retained eight-case infrastructure result cannot retry as the current nine-case release plan', () => {
  const state = retryState();
  state.evaluations[0]!.jobs = state.evaluations[0]!.jobs.filter(job => job.name !== 'overlapping-read-write');
  assert.equal(state.evaluations[0]!.jobs.length, 8);
  assert.equal(finalChecksRetryDecision(state, state.candidates[0]).allowed, false);
  assert.throws(() => freezeCommand(state, 'Run final checks again', '/api/evaluate', { candidateId: state.candidates[0]!.id }), /current full evaluation plan/);
});
