import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlatformState } from '../../../services/types';
import { SourceDiff } from './Diff';
import { Review } from './Review';

function state(): PlatformState {
  const candidate = { id: 'selected', name: 'Selected source', digest: 'sha256:selected', commit: 'b'.repeat(40),
    commitBytesDigest: 'sha256:commit', manifestDigest: 'sha256:manifest', publicationBase: 'a'.repeat(40),
    attemptIds: [], submissionIds: [], composition: [], changedPaths: ['changed.mjs'], status: 'PASS', outcome: 'PASS',
    evaluationIds: [], createdAt: '', manifest: { schemaVersion: 1, profile: 'ascii-regular-v1', entries: [{ path: 'changed.mjs', mode: '100644', size: 42, digest: 'sha256:file', gitOid: '' }] } } as PlatformState['candidates'][number];
  return {
    schemaVersion: 1, tenantId: 'tenant', projectId: 'project', projectIncarnation: 'incarnation', revision: 2, observationRevision: 1,
    acceptedHead: candidate.publicationBase, enrollmentDigest: 'enrollment', activeCandidateId: candidate.id, demoStatus: 'ACTIVE',
    attempts: [], candidates: [candidate], evaluations: [], evidence: [], conflicts: [], capsules: [], publications: [], receipts: [], commands: [], events: [],
    reviews: [{ id: 'review', candidateId: candidate.id, proposalDigest: 'sha256:proposal', expectedHead: candidate.publicationBase,
      goalRevision: 'goal', policyRevision: 'policy', planDigest: 'plan', evidenceIds: [], observationRevision: 1,
      expiresAt: '2099-01-01T00:00:00Z', status: 'READY' }],
    capabilities: { deployment: true, scripted: false, pi: true, publication: true }, limitations: [], gates: [],
    goal: { id: 'goal', revision: 'goal', title: 'Goal', description: '', constraints: [], contracts: [], budget: { authoringSeconds: 600, evaluationSeconds: 300 } },
  } as PlatformState;
}

const namedCases = ['warm-read-write-read', 'repeated-reads', 'successive-writes', 'cold-write', 'audit-write-burst', 'retained-cache-benefit', 'accessible-value', 'audit-alternating-pages', 'overlapping-read-write'];
function namedJobs(): PlatformState['evaluations'][number]['jobs'] {
  return namedCases.map(name => ({ id: `final:${name}`, name, required: true, checkerClass: 'external-behavioural',
    candidateId: 'selected', evaluationInputDigest: `input:${name}`, input: {}, status: 'PASS' }));
}

test('deployed approval remains locked while the bounded preview is the only inspected source', () => {
  const html = renderToStaticMarkup(createElement(Review, { state: state(), busy: '', command: async () => true, openVerify: () => {} }));
  assert.match(html, /Preview only: a shared 128 KiB budget may omit whole files/);
  assert.match(html, /Text preview unavailable: binary, budget or read failure/);
  assert.match(html, /Approval is locked until the complete candidate and publication base are loaded and verified above/);
  assert.match(html.match(/<label class="approval-check">[\s\S]*?<\/label>/)?.[0] ?? '', /disabled=""/);
  assert.match(html.match(/<button[^>]*>[^<]*<svg[^>]*>[\s\S]*?Approve this exact release<\/button>/)?.[0] ?? '', /disabled=""/);
  assert.match(html, /Inspect complete source before approval/);
});

test('the preview marks a deletion and a per-file line cutoff separately', () => {
  const base = state().candidates[0]!;
  const withText = { ...base, sourceFiles: { 'changed.mjs': Array.from({ length: 301 }, (_, line) => `line ${line}`).join('\n') } };
  const cutoff = renderToStaticMarkup(createElement(SourceDiff, { candidate: withText }));
  assert.match(cutoff, /First 300 lines shown/);
  assert.doesNotMatch(cutoff, /line 300/);
  const deleted = { ...base, manifest: { ...base.manifest, entries: [] }, sourceFiles: {} };
  const removal = renderToStaticMarkup(createElement(SourceDiff, { candidate: deleted, baseline: withText }));
  assert.match(removal, /Deleted in candidate/);
  assert.match(removal, /Deleted file/);
});

test('review preparation requires the currently eligible full plan', () => {
  const pilot = state();
  pilot.reviews = [];
  const props = { busy: '', command: async () => true, openVerify: () => {} };
  const stale = renderToStaticMarkup(createElement(Review, { ...props, state: pilot }));
  assert.match(stale, /No current eligible full release plan is recorded/);
  assert.match(stale, /<button class="button" aria-describedby="review-block-reason" disabled="">Prepare review<\/button>/);
  assert.match(stale, /Release checks are required before review/);

  pilot.candidates[0]!.reviewEvaluationId = 'current-full';
  pilot.evaluations = [{ id: 'current-full', candidateId: 'selected', contract: 'retained-value-v1', planDigest: 'current-plan',
    jobs: [], aggregation: 'all-required-pass', status: 'SETTLED', outcome: 'PASS', createdAt: '2026-10-08T00:00:00Z' }];
  const incomplete = renderToStaticMarkup(createElement(Review, { ...props, state: pilot }));
  assert.match(incomplete, /The current full plan does not prove every named release goal/);
  assert.match(incomplete, /Named release goals remain unproved/);
  assert.match(incomplete, /<button class="button" aria-describedby="review-block-reason" disabled="">Prepare review<\/button>/);

  pilot.evaluations[0]!.jobs = namedJobs();
  const ready = renderToStaticMarkup(createElement(Review, { ...props, state: pilot }));
  assert.match(ready, /<button class="button">Prepare review<\/button>/);
  assert.doesNotMatch(ready, /review-block-reason/);

  pilot.evidence = [{ id: 'old-failure', candidateId: 'selected', outcome: 'FAIL' } as PlatformState['evidence'][number]];
  const contradictory = renderToStaticMarkup(createElement(Review, { ...props, state: pilot }));
  assert.match(contradictory, /A retained failure blocks this source/);
  assert.match(contradictory, /A retained failure on this exact source blocks review/);
  assert.match(contradictory, /<button class="button" aria-describedby="review-block-reason" disabled="">Prepare review<\/button>/);
  pilot.evidence = [];

  pilot.reviews = state().reviews;
  const oldReview = renderToStaticMarkup(createElement(Review, { ...props, state: pilot }));
  assert.match(oldReview, /Bound state changed/);
  assert.match(oldReview, /<button class="text-button">Prepare again/);
});

test('an existing proposal cannot advance when its named release goals are unproved', () => {
  const pilot = state();
  pilot.capabilities.deployment = false;
  pilot.evaluations = [{ id: 'current-full', candidateId: 'selected', contract: 'retained-value-v1', planDigest: 'plan',
    jobs: [], aggregation: 'all-required-pass', status: 'SETTLED', outcome: 'PASS', createdAt: '2026-10-08T00:00:00Z' }];
  const props = { busy: '', command: async () => true, openVerify: () => {} };
  const blocked = renderToStaticMarkup(createElement(Review, { state: pilot, ...props }));
  assert.match(blocked, /Review is blocked by release checks/);
  assert.match(blocked, /current evidence does not prove every named release goal/);
  assert.match(blocked.match(/<label class="approval-check">[\s\S]*?<\/label>/)?.[0] ?? '', /disabled=""/);

  pilot.evaluations[0]!.jobs = namedJobs();
  const eligible = renderToStaticMarkup(createElement(Review, { state: pilot, ...props }));
  assert.doesNotMatch(eligible.match(/<label class="approval-check">[\s\S]*?<\/label>/)?.[0] ?? '', /disabled=""/);

  pilot.evaluations[0]!.jobs = [];
  pilot.reviews[0]!.status = 'APPROVED';
  pilot.reviews[0]!.approval = { principal: 'owner', approvedAt: '2026-10-08T00:00:00Z' };
  const approvedButBlocked = renderToStaticMarkup(createElement(Review, { state: pilot, ...props }));
  assert.match(approvedButBlocked, /Approval needs fresh release checks/);
  assert.match(approvedButBlocked.match(/<button[^>]*>[^<]*<svg[^>]*>[\s\S]*?Publish the approved commit<\/button>/)?.[0] ?? '', /disabled=""/);
});

test('an approved deployed review names the closed publication gate beside its disabled action', () => {
  const pilot = state();
  pilot.candidates[0]!.reviewEvaluationId = 'current-full';
  pilot.evaluations = [{ id: 'current-full', candidateId: 'selected', contract: 'retained-value-v1', planDigest: 'plan',
    jobs: namedJobs(), aggregation: 'all-required-pass', status: 'SETTLED', outcome: 'PASS', createdAt: '2026-10-08T00:00:00Z' }];
  pilot.reviews[0]!.status = 'APPROVED';
  pilot.reviews[0]!.approval = { principal: 'owner', approvedAt: '2026-10-08T00:00:00Z' };
  pilot.admission = { gate: 'CLOSED', reason: 'The authority publication gate is closed. New publication admission is blocked.' };
  pilot.capabilities.publication = false;
  const html = renderToStaticMarkup(createElement(Review, { state: pilot, busy: '', command: async () => true, openVerify: () => {} }));
  assert.match(html, /Approved\. Publication is waiting\./);
  assert.match(html, /The authority publication gate is closed\. New publication admission is blocked\./);
  assert.match(html.match(/<button[^>]*>[^<]*<svg[^>]*>[\s\S]*?Publish the approved commit<\/button>/)?.[0] ?? '', /disabled=""/);
  assert.doesNotMatch(html, /Approved\. Ready to publish\./);

  pilot.capabilities.publication = true;
  pilot.admission = { gate: 'OPEN', reason: 'Publication admission is open.' };
  pilot.evidence = [{ id: 'old-failure', candidateId: 'selected', outcome: 'FAIL' } as PlatformState['evidence'][number]];
  const contradictory = renderToStaticMarkup(createElement(Review, { state: pilot, busy: '', command: async () => true, openVerify: () => {} }));
  assert.match(contradictory, /A retained failure contradicts this candidate/);
  assert.match(contradictory.match(/<button[^>]*>[^<]*<svg[^>]*>[\s\S]*?Publish the approved commit<\/button>/)?.[0] ?? '', /disabled=""/);
});

test('a closed publication gate is visible before approval while review preparation stays available', () => {
  const pilot = state();
  pilot.reviews = [];
  pilot.candidates[0]!.reviewEvaluationId = 'current-full';
  pilot.evaluations = [{ id: 'current-full', candidateId: 'selected', contract: 'retained-value-v1', planDigest: 'plan',
    jobs: namedJobs(), aggregation: 'all-required-pass', status: 'SETTLED', outcome: 'PASS', createdAt: '2026-10-08T00:00:00Z' }];
  pilot.admission = { gate: 'CLOSED', reason: 'Owner approval to open the gate is pending.' };
  pilot.capabilities.publication = false;
  const props = { busy: '', command: async () => true, openVerify: () => {} };
  const preparing = renderToStaticMarkup(createElement(Review, { state: pilot, ...props }));
  assert.match(preparing, /Publication gate CLOSED/);
  assert.match(preparing, /Owner approval to open the gate is pending/);
  assert.ok(preparing.indexOf('Publication gate CLOSED') < preparing.indexOf('Next step'));
  assert.ok(preparing.indexOf('Publication gate CLOSED') < preparing.indexOf('Your approval is the boundary.'));
  assert.match(preparing, /<button class="button">Prepare review<\/button>/);

  pilot.reviews = state().reviews;
  const ready = renderToStaticMarkup(createElement(Review, { state: pilot, ...props }));
  assert.match(ready, /Publication gate CLOSED/);
  assert.match(ready, /An exact review can still be prepared after the required checks pass/);
  assert.ok(ready.indexOf('Publication gate CLOSED') < ready.indexOf('Approve this exact release'));
});

test('local review gives the bounded-preview limitation once', () => {
  const pilot = state();
  pilot.capabilities.deployment = false;
  const html = renderToStaticMarkup(createElement(Review, { state: pilot, busy: '', command: async () => true, openVerify: () => {} }));
  assert.equal((html.match(/complete source export is available in the deployed pilot/gi) ?? []).length, 1);
  assert.doesNotMatch(html, /Inspect complete source before approval/);
});

test('review, publication, recovery and export controls honor authoritative session permissions', () => {
  const pilot = state();
  pilot.capabilities.deployment = false;
  pilot.session = { principalId: 'owner', credentialClass: 'human', permissions: { review: false, sponsor: true, manage: true, export: true } };
  pilot.candidates[0]!.reviewEvaluationId = 'full';
  pilot.evaluations = [{ id: 'full', candidateId: 'selected', contract: 'retained-value-v1', planDigest: 'plan', jobs: namedJobs(), aggregation: 'all-required-pass', status: 'SETTLED', outcome: 'PASS', createdAt: '' }];
  const render = () => renderToStaticMarkup(createElement(Review, { state: pilot, busy: '', command: async () => true, openVerify() {} }));
  const button = (html: string, label: string) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(match => match[0].includes(label))?.[0] ?? '';
  const owner = render();
  assert.match(owner, /Your current role does not include release review/);
  assert.match(owner.match(/<label class="approval-check">[\s\S]*?<\/label>/)?.[0] ?? '', /disabled=""/);
  assert.match(button(owner, 'Approve this exact release'), /disabled=""/);
  pilot.reviews = [];
  assert.match(button(render(), 'Prepare review'), /disabled=""/);

  pilot.session.permissions = { review: true, sponsor: false, manage: false, export: false };
  assert.doesNotMatch(button(render(), 'Prepare review'), /disabled=""/);
  pilot.reviews = state().reviews;
  pilot.reviews[0]!.status = 'APPROVED';
  pilot.reviews[0]!.approval = { principal: 'reviewer', approvedAt: '' };
  assert.match(button(render(), 'Publish the approved commit'), /disabled=""/);
  pilot.publications = [{ id: 'publication', candidateId: 'selected', status: 'ADMITTED', dispatchCount: 0 } as PlatformState['publications'][number]];
  assert.match(button(render(), 'Reconcile this operation'), /disabled=""/);
  const selected = pilot.candidates[0]!;
  Object.assign(pilot.publications[0]!, { status: 'PUBLISHED', proposalDigest: 'proposal', oldHead: selected.publicationBase, newHead: selected.commit });
  pilot.receipts = [{ id: 'receipt', candidateId: 'selected', publicationId: 'publication', sequence: 1, digest: 'receipt-digest',
    logical: { schemaVersion: 1, scope: { schemaVersion: 1, tenantId: pilot.tenantId, projectId: pilot.projectId, projectIncarnation: pilot.projectIncarnation },
      outcome: 'PUBLISHED', operationId: 'publication', sequence: '1', enrollmentDigest: pilot.enrollmentDigest, candidateDigest: selected.digest,
      manifestDigest: selected.manifestDigest, oldHead: selected.publicationBase, newHead: selected.commit, proposalDigest: 'proposal' },
    envelope: null, createdAt: '' }];
  assert.match(button(render(), 'Export portable receipt'), /disabled=""/);
  pilot.session.permissions.export = true;
  assert.doesNotMatch(button(render(), 'Export portable receipt'), /disabled=""/);
});
