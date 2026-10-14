/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Candidate, PlatformState } from '../../../services/types';
import { ReleaseStory } from './ReleaseStory';

function weftState(outcome?: 'PASS' | 'FAIL' | 'ERROR'): PlatformState {
  const candidate: Candidate = {
    id: `weft-${'a'.repeat(64)}`, name: 'Weft revision candidate', digest: 'candidate-digest',
    commit: 'frozen-source', commitBytesDigest: 'commit-bytes', manifestDigest: 'selected-manifest',
    manifest: { schemaVersion: 1, profile: 'ascii-regular-v1', entries: [] }, publicationBase: 'base',
    attemptIds: [], submissionIds: [], composition: [`weft:${'a'.repeat(64)}`],
    status: outcome ?? 'EVALUATING', outcome, evaluationIds: ['full-checks'], reviewEvaluationId: 'full-checks',
    createdAt: '2026-10-14T00:00:00Z', changedPaths: ['cache.mjs'], evaluationReadComplete: true,
  };
  const names = ['warm-read-write-read', 'repeated-reads', 'successive-writes', 'cold-write', 'retained-cache-benefit', 'accessible-value', 'audit-write-burst', 'audit-alternating-pages', 'overlapping-read-write'];
  return {
    schemaVersion: 1, tenantId: 'test-tenant', projectId: 'test-project', projectIncarnation: 'test-incarnation',
    revision: 3, observationRevision: 1, acceptedHead: 'base', enrollmentDigest: 'enrollment',
    goal: { id: 'goal', revision: '1', title: 'Bounded fixture', description: '', constraints: [], contracts: [], budget: { authoringSeconds: 600, evaluationSeconds: 300 } },
    attempts: [], candidates: [candidate], activeCandidateId: candidate.id, evaluations: [{
      id: 'full-checks', candidateId: candidate.id, contract: 'retained-value-v1', planDigest: 'plan',
      jobs: names.map(name => ({ id: name, name, required: true, checkerClass: 'external-behavioural',
        candidateId: candidate.id, evaluationInputDigest: name, input: {}, status: outcome ?? 'RUNNING' })),
      aggregation: 'all-required-pass', status: outcome ? 'SETTLED' : 'RUNNING', outcome, createdAt: candidate.createdAt,
    }], evidence: [], conflicts: [], capsules: [], reviews: [], publications: [], receipts: [], commands: [], events: [],
    demoStatus: 'READY', capabilities: { scripted: false, pi: false, publication: true, deployment: true }, limitations: [], gates: [],
  };
}

function render(state: PlatformState): string {
  return renderToStaticMarkup(createElement(ReleaseStory, { state, candidate: state.candidates[0] }));
}

test('a retained Weft selection is frozen source under release checks, not missing isolated contributions', () => {
  const html = render(weftState());
  assert.match(html, /Checking the frozen Weft selection/);
  assert.match(html, /Frozen source selection/);
  assert.match(html, /Later live edits do not change this candidate/);
  assert.match(html, /Release checks pending/);
  assert.match(html, /Working sessions<\/dt><dd>Not reported/);
  assert.match(html, /Working-session timing not reported/);
  assert.match(html, /Weft participant usage is not reported here/);
  assert.doesNotMatch(html, /Awaiting contributions|Each attempt will show|No attempts yet|isolated submission|Scripted attempts only|No model calls|Read model-call reservations/);
});

test('failed Weft checks direct corrective live edits and a new retained selection without promising a composition diagnosis', () => {
  const state = weftState('FAIL');
  const html = render(state);
  assert.match(html, /Frozen Weft source failed release checks/);
  assert.match(html, /Inspect this frozen source and its failed checks/);
  assert.match(html, /Make corrective edits in the live workspace, then select and submit a new retained revision/);
  assert.match(html, /This candidate remains unchanged/);
  assert.doesNotMatch(html, /diagnosis pending|wait for an interaction diagnosis|Awaiting contributions|Start a bounded repair/);
  state.candidates[0]!.outcome = 'PASS';
  state.evaluations[0]!.outcome = 'PASS';
  state.evidence = [{ candidateId: state.candidates[0]!.id, outcome: 'FAIL' } as PlatformState['evidence'][number]];
  assert.match(render(state), /Make corrective edits in the live workspace/);
});

test('passing Weft checks preserve exact human review and stale-base decisions', () => {
  const state = weftState('PASS');
  assert.match(render(state), /Prepare the exact review, then inspect the source and evidence/);
  assert.match(render(state), /Release checks passed/);
  // Synthetic review fixture only; this test does not create a human approval.
  state.reviews = [{ id: 'test-review', candidateId: state.candidates[0]!.id, proposalDigest: 'proposal',
    expectedHead: 'base', goalRevision: 'goal', policyRevision: 'policy', planDigest: 'plan', evidenceIds: [],
    observationRevision: state.observationRevision, expiresAt: '2099-01-01T00:00:00Z', status: 'READY' }];
  assert.match(render(state), /Reviewer decision<\/strong><p>Inspect the exact source and named evidence, then decide whether to approve/);
  assert.doesNotMatch(render(state), /The exact proposal is approved/);
  state.acceptedHead = 'changed-base';
  assert.match(render(state), /The review is stale or expired. Prepare a fresh proposal before approval/);
});

test('a Weft infrastructure error requires check results without inventing a source failure or interaction diagnosis', () => {
  const html = render(weftState('ERROR'));
  assert.match(html, /Release checks need attention/);
  assert.match(html, /Inspect the check results and obtain a current full evaluation before review/);
  assert.doesNotMatch(html, /Make corrective edits|diagnosis pending|wait for an interaction diagnosis|Release checks passed/);
});
