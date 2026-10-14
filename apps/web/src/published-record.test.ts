/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlatformState } from '../../../services/types';
import { publishedRecord } from './published-record';
import { currentReleasePlan, releaseGoalsPassed } from './presentation';
import { ReleaseStory } from './ReleaseStory';
import { Workspace } from './Workspace';
import { Review } from './Review';

function state(): PlatformState {
  const candidate = { id: 'selected', name: 'Published repair', digest: 'candidate', commit: 'published-source', manifestDigest: 'manifest',
    commitBytesDigest: 'commit-bytes', publicationBase: 'base', manifest: { schemaVersion: 1 as const, profile: 'ascii-regular-v1' as const, entries: [] },
    attemptIds: [], submissionIds: [], composition: [], status: 'PASS', outcome: 'PASS' as const, outcomeProvenance: 'retained' as const,
    evaluationIds: [], evaluationReadComplete: true, changedPaths: [], createdAt: '2026-10-09T00:00:00Z' };
  return { schemaVersion: 1, tenantId: 'tenant', projectId: 'project', projectIncarnation: 'incarnation', enrollmentDigest: 'enrollment',
    revision: 100, observationRevision: 47, acceptedHead: 'a-later-head', activeCandidateId: candidate.id,
    goal: { id: 'goal', revision: '1', title: 'Preserve useful work', description: '', constraints: [], contracts: [], budget: { authoringSeconds: 600, evaluationSeconds: 300 } },
    candidates: [candidate], attempts: [], evaluations: [], evidence: [], conflicts: [], capsules: [], reviews: [], commands: [], events: [],
    publications: [{ id: 'operation', candidateId: candidate.id, proposalDigest: 'proposal', oldHead: 'base', newHead: candidate.commit,
      status: 'PUBLISHED', admittedAt: '', confirmedAt: '', dispatchCount: 1, admissionWitness: null }],
    receipts: [{ id: 'receipt', publicationId: 'operation', candidateId: candidate.id, sequence: 1, digest: 'receipt-digest', envelope: null, createdAt: '',
      logical: { schemaVersion: 1, scope: { schemaVersion: 1, tenantId: 'tenant', projectId: 'project', projectIncarnation: 'incarnation' },
        operationId: 'operation', sequence: '1', enrollmentDigest: 'enrollment', outcome: 'PUBLISHED', oldHead: 'base', newHead: candidate.commit,
        candidateDigest: candidate.digest, manifestDigest: candidate.manifestDigest, proposalDigest: 'proposal' } }],
    demoStatus: 'ACTIVE', capabilities: { deployment: true, scripted: false, pi: true, publication: false }, limitations: [], gates: [],
    projectBudget: { maximumUnits: '3600000', reservedUnits: '0', settledUnits: '3600000', availableUnits: '0', repairReservationUnits: '400000', policyCapUnits: '3600000' },
  };
}
const story = (value: PlatformState) => renderToStaticMarkup(createElement(ReleaseStory, { state: value, candidate: value.candidates[0] }));
const workspace = (value: PlatformState) => renderToStaticMarkup(createElement(Workspace, { state: value, busy: '', command: async () => true, openReview() {}, selected: [], setSelected() {} }));
const review = (value: PlatformState) => renderToStaticMarkup(createElement(Review, { state: value, busy: '', command: async () => true, openVerify() {} }));

test('checker rollover preserves a candidate-scoped publication story without manufacturing current eligibility', () => {
  const value = state(), before = JSON.stringify(value);
  assert.equal(publishedRecord(value, value.candidates[0])?.receipt.sequence, 1);
  assert.equal(currentReleasePlan(value, value.candidates[0]), undefined);
  assert.equal(releaseGoalsPassed(value, value.candidates[0]), false);
  const html = story(value);
  assert.match(html, /Published release record/);
  assert.match(html, /Not evaluated under the current checker/);
  assert.match(html, /does not establish the current remote head or authorize another publication/);
  assert.doesNotMatch(html, /0\/3|3\/3|9\/9|Current full release proof is unavailable|Final checks pending on this candidate/);
  assert.equal(JSON.stringify(value), before, 'display must preserve original receipt and state bytes');
});

test('exact receipt/source/project/publication mismatches cannot become a published presentation', () => {
  const changes: [string, (value: PlatformState) => void][] = [
    ['tenant', v => { (v.receipts[0]!.logical.scope as any).tenantId = 'another'; }],
    ['project', v => { (v.receipts[0]!.logical.scope as any).projectId = 'another'; }],
    ['incarnation', v => { (v.receipts[0]!.logical.scope as any).projectIncarnation = 'another'; }],
    ['enrollment', v => { v.receipts[0]!.logical.enrollmentDigest = 'another'; }],
    ['candidate', v => { v.receipts[0]!.logical.candidateDigest = 'another'; }],
    ['manifest', v => { v.receipts[0]!.logical.manifestDigest = 'another'; }],
    ['source', v => { v.receipts[0]!.logical.newHead = 'another'; }],
    ['base', v => { v.receipts[0]!.logical.oldHead = 'another'; }],
    ['proposal', v => { v.receipts[0]!.logical.proposalDigest = 'another'; }],
    ['operation', v => { v.receipts[0]!.logical.operationId = 'another'; }],
    ['sequence', v => { v.receipts[0]!.logical.sequence = '2'; }],
    ['publication candidate', v => { v.publications[0]!.candidateId = 'another'; }],
    ['publication source', v => { v.publications[0]!.newHead = 'another'; }],
    ['unresolved effect', v => { v.publications[0]!.status = 'UNKNOWN'; }],
    ['missing publication', v => { v.publications = []; }],
    ['missing logical receipt', v => { v.receipts[0]!.logical = {}; }],
    ['ambiguous publication', v => { v.publications.push(structuredClone(v.publications[0]!)); }],
    ['ambiguous receipt', v => { v.receipts.push(structuredClone(v.receipts[0]!)); }],
  ];
  for (const [name, change] of changes) {
    const value = state(); change(value);
    assert.equal(publishedRecord(value, value.candidates[0]), undefined, name);
    assert.doesNotMatch(story(value), /Published release record/, name);
    assert.match(review(value), /Receipt details unavailable/, name);
    assert.doesNotMatch(workspace(value), /Publication recorded\./, name);
  }
});

test('a prior candidate receipt cannot complete a newly selected source', () => {
  const value = state();
  value.candidates[0]!.id = 'new-selection'; value.activeCandidateId = 'new-selection';
  assert.equal(publishedRecord(value, value.candidates[0]), undefined);
  assert.doesNotMatch(story(value), /Published release record/);
  assert.doesNotMatch(workspace(value), /Open recorded release/);
});

test('published workspace preserves budget totals as future capacity and offers inspection instead of repeat work', () => {
  const value = state(), before = JSON.stringify(value), html = workspace(value);
  assert.match(html, /Future authoring capacity · 0 available/);
  assert.match(html, /No additional budget is needed to inspect or verify this recorded release/);
  assert.match(html, /Limit 3,600,000 · Policy cap 3,600,000 · Held 0 · Settled 3,600,000/);
  assert.match(html, /Open recorded release/);
  assert.doesNotMatch(html, /Compose &amp; evaluate|Start a bounded repair|Run current final checks|Increase internal limit|Launch 3 agents/);
  assert.equal(JSON.stringify(value), before);
});

test('published review exports the exact retained receipt while respecting role restrictions', () => {
  const value = state();
  value.session = { principalId: 'owner', credentialClass: 'human', permissions: { review: true, sponsor: true, manage: true, export: false } };
  const html = review(value);
  assert.match(html, /Recorded release\./);
  assert.match(html, /Receipt #1/);
  assert.match(html, /disabled=""[^>]*>[\s\S]*?Export portable receipt/);
  assert.match(html, /Verify independently/);
  assert.match(html, /Inspect complete recorded source/);
  assert.doesNotMatch(html, /before approval/);
  assert.doesNotMatch(html, /Prepare review|Approve this exact release|Publish the approved commit|Review checks incomplete/);
});

test('a current failing plan remains visible alongside the immutable earlier publication', () => {
  const value = state(); value.candidates[0]!.reviewEvaluationId = 'current';
  value.evaluations = [{ id: 'current', candidateId: 'selected', contract: 'retained-value-v1', planDigest: 'current-plan', jobs: [],
    aggregation: 'all-required-pass', status: 'SETTLED', outcome: 'FAIL', createdAt: '' }];
  const html = story(value);
  assert.match(html, /Published release record/);
  assert.match(html, /Current checks failed/);
  assert.match(html, /Current checker<\/dt><dd>FAIL/);
  assert.equal(releaseGoalsPassed(value, value.candidates[0]), false);
});

test('retained same-source failures stay visible without attributing a different candidate failure to this receipt', () => {
  const value = state();
  value.evidence = [{ candidateId: 'another-candidate', outcome: 'FAIL' } as PlatformState['evidence'][number]];
  assert.doesNotMatch(story(value), /A failure is also recorded for this source/);
  value.evidence[0]!.candidateId = 'selected';
  assert.match(story(value), /A failure is also recorded for this source/);
  assert.match(story(value), /does not dismiss another recorded failure/);
  assert.match(story(value), /Published release record/);
});
