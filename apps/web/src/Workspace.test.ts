/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Attempt, Candidate, PlatformState } from '../../../services/types';
import { Workspace } from './Workspace';
import { ReleaseStory } from './ReleaseStory';
import { AttemptSource } from './AttemptSource';
import { Evidence } from './Inspection';
import { freezeCommand } from './commands';
import { currentConflict, currentReleasePlan, releaseConflict, releaseMetrics, repairOrigin } from './presentation';

function state(availableUnits: string, retry = false): PlatformState {
  const repair: Attempt = { id: 'repair', name: 'Repair', role: 'repair', mode: 'pi', status: 'CANCELLED', assigned: 'Repair the failed source',
    workBase: 'failed-source', publicationBase: 'base', generation: 1, grantId: 'grant', allowedPaths: ['mutation.mjs'],
    terminationObserved: true, executionOutcome: 'CANCELLED' };
  return {
    schemaVersion: 1, tenantId: 'tenant', projectId: 'project', projectIncarnation: 'incarnation', revision: 1, observationRevision: 1,
    acceptedHead: 'base', enrollmentDigest: 'enrollment',
    goal: { id: 'goal', revision: '1', title: 'Preserve useful work', description: '', constraints: [], contracts: [], budget: { authoringSeconds: 600, evaluationSeconds: 300 } },
    attempts: retry ? [repair] : [], candidates: [{ id: 'failed', name: 'Failed composition', commit: 'failed-source', status: 'FAIL', outcome: 'FAIL', attemptIds: [], publicationBase: 'base' } as unknown as PlatformState['candidates'][number]],
    evaluations: [], evidence: [], conflicts: [{ id: 'conflict', candidateId: 'failed', attemptIds: [], category: 'behavioural-interaction', status: 'OPEN', summary: 'A stale read', evidenceIds: [], ...(retry ? { repairAttemptId: 'repair' } : {}) }],
    capsules: [], reviews: [], publications: [], receipts: [], commands: [], events: [], activeCandidateId: 'failed', demoStatus: 'READY',
    capabilities: { scripted: false, pi: true, publication: false, deployment: true }, limitations: [], gates: [],
    projectBudget: { maximumUnits: '2000000', reservedUnits: '0', settledUnits: (2000000n - BigInt(availableUnits)).toString(), availableUnits, repairReservationUnits: '400000', policyCapUnits: '2800000' },
  };
}

function repairButton(html: string, label: string): string {
  const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).filter(button => button.includes(label));
  assert.equal(buttons.length, 1);
  return buttons[0]!;
}

function journeyStep(html: string, name: string): string {
  const marker = `<strong>${name}</strong>`;
  const end = html.indexOf(marker);
  const start = html.lastIndexOf('<div class="journey-step', end);
  assert.ok(start >= 0 && end > start, `Missing ${name} journey step`);
  return html.slice(start, end + marker.length);
}

test('a frozen Weft candidate shows its release story without inventing an isolated agent cohort', () => {
  const current = state('400000');
  current.conflicts = [];
  current.candidates = [{ id: `weft-${'a'.repeat(64)}`, name: 'Weft revision candidate', digest: 'candidate-digest',
    commit: 'frozen-source', commitBytesDigest: 'commit-bytes', manifestDigest: 'selected-manifest',
    manifest: { schemaVersion: 1, profile: 'ascii-regular-v1', entries: [] }, publicationBase: 'base',
    attemptIds: [], submissionIds: [], composition: [`weft:${'a'.repeat(64)}`], status: 'EVALUATING',
    evaluationIds: [], createdAt: '2026-10-14T00:00:00Z', changedPaths: ['cache.mjs'] }];
  current.activeCandidateId = current.candidates[0]!.id;
  const html = renderToStaticMarkup(createElement(Workspace, { state: current, busy: '', command: async () => true,
    openReview: () => {}, selected: [], setSelected: () => {} }));
  assert.match(html, /Checking the frozen Weft selection/);
  assert.match(html, /Later live edits do not change this candidate/);
  assert.match(html, /Release checks pending/);
  assert.doesNotMatch(html, /Launch a small, visible cohort|Ready to launch|Three bounded attempts|Awaiting contributions/);
});

test('deployed repair controls stop below the exact reservation threshold and explain the units', () => {
  const props = { busy: '', command: async () => true, openReview: () => {}, selected: [], setSelected: () => {} };
  const exhausted = renderToStaticMarkup(createElement(Workspace, { ...props, state: state('0') }));
  assert.match(repairButton(exhausted, 'Start a bounded repair'), /\bdisabled=""/);
  assert.match(exhausted, /0 available/);
  assert.match(exhausted, /One new repair reserves 400,000 units/);
  assert.match(exhausted, /admission units, not provider dollars or measured model cost/);
  assert.match(exhausted, /admin must record an audited budget increase/);
  assert.match(exhausted, /<h1>Better together\.<br\/><span>Interaction found\.<\/span><\/h1>/);
  assert.doesNotMatch(exhausted, /Verified as one\./);

  const retry = renderToStaticMarkup(createElement(Workspace, { ...props, state: state('399999', true) }));
  assert.match(repairButton(retry, 'Retry bounded repair'), /\bdisabled=""/);
  const funded = renderToStaticMarkup(createElement(Workspace, { ...props, state: state('400000', true) }));
  assert.doesNotMatch(repairButton(funded, 'Retry bounded repair'), /\bdisabled=""/);

  const cappedState = state('0', true);
  cappedState.tenantId = 'pilot';
  cappedState.projectId = 'competition-demo-r2';
  cappedState.projectIncarnation = 'c23de474-7628-47be-9cbd-65595953b3ee';
  cappedState.projectBudget!.maximumUnits = '3600000';
  cappedState.projectBudget!.settledUnits = '3600000';
  cappedState.projectBudget!.policyCapUnits = '3600000';
  const capped = renderToStaticMarkup(createElement(Workspace, { ...props, state: cappedState }));
  assert.match(repairButton(capped, 'Retry bounded repair'), /\bdisabled=""/);
  assert.match(capped, /Policy cap 3,600,000/);
  assert.match(capped, /reviewed policy change is required/);
  assert.doesNotMatch(capped, /admin must record an audited budget increase/);

  const currentPilot = state('0', true);
  currentPilot.tenantId = 'pilot';
  currentPilot.projectId = 'competition-demo-r2';
  currentPilot.projectIncarnation = 'c23de474-7628-47be-9cbd-65595953b3ee';
  currentPilot.session = { principalId: 'owner', credentialClass: 'human' };
  currentPilot.projectBudget!.maximumUnits = '3200000';
  currentPilot.projectBudget!.settledUnits = '3200000';
  currentPilot.projectBudget!.policyCapUnits = '3600000';
  const readyForAmendment = renderToStaticMarkup(createElement(Workspace, { ...props, state: currentPilot }));
  assert.match(readyForAmendment, /admin must record an audited budget increase/);
  assert.match(readyForAmendment, /Increase internal limit by 400,000/);
});

test('concurrency repair displays the exact cache edit scope and read-only mutation context', () => {
  const pilot = state('400000', true);
  const task = 'Repair overlapping-read/write cache freshness in cache.mjs. Prevent an old in-flight read from refilling or overwriting the cache after an acknowledged write. Preserve enabled caching with TTL 60 seconds, useful cache hits and accessible saved-value status. The failing source is your exact work base. Only edit cache.mjs; mutation.mjs is read-only context.';
  pilot.attempts[0]!.assigned = JSON.stringify({ task, counterexamples: [{ marker: 'retained-overlap' }] });
  pilot.attempts[0]!.allowedPaths = ['cache.mjs']; pilot.attempts[0]!.readOnlyContextPaths = ['mutation.mjs'];
  const html = renderToStaticMarkup(createElement(Workspace, { state: pilot, busy: '', command: async () => true, openReview: () => {}, selected: [], setSelected: () => {} }));
  const summary = html.split('<details class="repair-raw-assignment">')[0]!;
  assert.match(summary, /Prevent an old in-flight read.*after an acknowledged write/);
  assert.match(summary, /TTL 60 seconds/);
  assert.match(summary, /May edit cache.mjs. Read-only source context: mutation.mjs/);
  assert.doesNotMatch(summary, /May edit mutation.mjs/);
});

test('three terminal repairs remain a current action without claiming work is in progress', () => {
  const pilot = state('0', true);
  const last = pilot.attempts[0]!;
  pilot.attempts.unshift({ ...last, id: 'repair-1' }, { ...last, id: 'repair-2' });
  const html = renderToStaticMarkup(createElement(Workspace, { state: pilot, busy: '', command: async () => true, openReview: () => {}, selected: [], setSelected: () => {} }));
  const step = journeyStep(html, 'Repair');
  assert.match(step, /journey-step current issue/);
  assert.match(step, /aria-current="step" role="group" aria-label="Repair: stopped without accepted source"/);
  assert.doesNotMatch(step, /in progress/);
  assert.match(html, /<strong>Repair<\/strong><span>Stopped without accepted source<\/span>/);
  assert.match(html, /Previous repair attempts · 2/);
  assert.match(html, /A new repair needs 400,000 internal reservation units; 0 remain/);

  last.status = 'COMPLETED';
  last.executionOutcome = 'COMPLETED';
  const awaitingIngestion = renderToStaticMarkup(createElement(Workspace, { state: pilot, busy: '', command: async () => true, openReview: () => {}, selected: [], setSelected: () => {} }));
  assert.match(journeyStep(awaitingIngestion, 'Repair'), /aria-label="Repair: stopped; source ingestion pending"/);
  assert.match(awaitingIngestion, /The repair stopped; source ingestion is pending/);
  assert.doesNotMatch(journeyStep(awaitingIngestion, 'Repair'), /in progress/);
});

test('repair view summarizes the recorded failure and keeps the exact assignment behind a disclosure', () => {
  const pilot = state('0', true);
  const assignment = JSON.stringify({ task: 'Restore write freshness in mutation.mjs while keeping the cache and saved status.', contextPolicy: 'Retained technical context marker', counterexamples: [{ observed: 4768 }] });
  pilot.attempts[0]!.assigned = assignment;
  pilot.attempts[0]!.readOnlyContextPaths = ['cache.mjs'];
  pilot.conflicts[0]!.counterexample = [{ step: 3, action: 'GET', expected: 7976, observed: 4768, status: 200, responseDigest: 'observation' }];
  const html = renderToStaticMarkup(createElement(Workspace, { state: pilot, busy: '', command: async () => true, openReview: () => {}, selected: [], setSelected: () => {} }));
  const summary = html.split('<details class="repair-raw-assignment">')[0]!;
  assert.match(summary, /Restore write freshness in mutation\.mjs while keeping the cache and saved status/);
  assert.match(summary, /Recorded GET expected 7976 but observed 4768/);
  assert.match(summary, /Useful caching and accessible saved-value status still require proof/);
  assert.match(summary, /May edit mutation\.mjs\. Read-only source context: cache\.mjs/);
  assert.match(html, /<strong>Allowed to edit<\/strong><div class="attempt-files"><code>mutation\.mjs<\/code>/);
  assert.match(html, /<strong>Recorded changes<\/strong><p>No accepted source; changed files unavailable\.<\/p>/);
  assert.match(summary, /Next decision<\/span><p>No repair source to review\. A new repair needs 400,000 internal reservation units; 0 remain\. An admin must record an audited budget increase/);
  assert.doesNotMatch(summary, /Retained technical context marker/);
  assert.match(html, /<details class="repair-raw-assignment"><summary>Exact agent assignment<\/summary><pre class="bounded-log">/);
  assert.match(html, /Retained technical context marker/);
});

test('retained failure is labeled as historical while the exact repair target remains visible', () => {
  const pilot = state('400000', true);
  pilot.candidates[0]!.outcomeProvenance = 'retained';
  const html = renderToStaticMarkup(createElement(ReleaseStory, { state: pilot, candidate: pilot.candidates[0] }));
  assert.match(html, /This failure was recorded under an earlier checker, goal, or policy version/);
  assert.match(html, /The failure remains a repair target/);
  assert.match(html, /A current full evaluation is required before review/);
  assert.match(html, /The combination exposed an interaction/);
  assert.match(html, /1<span class="score-context">For this failure/);
});

test('retained failure controls the journey and repair lineage after a newer pass on the same source', () => {
  const pilot = state('400000', true);
  const failure = (id: string, candidateId: string): PlatformState['evidence'][number] => ({ id, candidateId, evaluationId: 'old-evaluation', jobId: `old:${id}`,
    evaluationInputDigest: `old-input:${id}`, checkerClass: 'external-behavioural', checkerId: 'checker', environmentDigest: '', fixtureDigest: '',
    outcome: 'FAIL', observations: [], startedAt: '', completedAt: '', digest: id, observationDigest: id, envelope: null, limitations: [] });
  const failed = pilot.candidates[0]!;
  failed.outcome = 'PASS';
  failed.status = 'PASS';
  failed.outcomeProvenance = 'current';
  failed.reviewEvaluationId = 'current-full';
  const names = ['warm-read-write-read', 'repeated-reads', 'successive-writes', 'cold-write', 'retained-cache-benefit', 'accessible-value', 'audit-write-burst', 'audit-alternating-pages', 'overlapping-read-write'];
  pilot.evaluations = [{ id: 'current-full', candidateId: failed.id, contract: 'retained-value-v1', planDigest: 'current-plan',
    jobs: names.map(name => ({ id: `current:${name}`, name, required: true, checkerClass: 'external-behavioural', candidateId: failed.id,
      evaluationInputDigest: `input:${name}`, input: {}, status: 'PASS' })), aggregation: 'all-required-pass', status: 'SETTLED', outcome: 'PASS', createdAt: '' }];
  pilot.evidence = [failure('retained-failure', failed.id)];
  assert.equal(releaseMetrics(pilot, failed).completedGoals, 3, 'current check results stay visible as measurements');
  const props = { state: pilot, busy: '', command: async () => true, openReview: () => {}, selected: [], setSelected: () => {} };
  const html = renderToStaticMarkup(createElement(Workspace, props));
  assert.match(journeyStep(html, 'Compose'), /journey-step issue/);
  assert.match(html, /Retained failure blocks this source/);
  assert.match(html, /Interaction found/);
  assert.ok(html.indexOf('class="conflict-panel"') >= 0 && html.indexOf('class="conflict-panel"') < html.indexOf('class="attempts-section"'), 'the retained conflict leads the workspace');
  assert.doesNotMatch(html, /Eligible for exact human review/);

  const successor = { ...failed, id: 'successor', name: 'Repair successor', commit: 'successor-source', repairOf: failed.id,
    attemptIds: ['repair'], reviewEvaluationId: undefined };
  pilot.candidates.push(successor);
  pilot.conflicts[0]!.repairCandidateId = successor.id;
  pilot.attempts[0]!.submissionId = 'repair-source';
  assert.equal(repairOrigin(pilot, successor)?.id, failed.id);
  pilot.activeCandidateId = successor.id;
  const inherited = renderToStaticMarkup(createElement(Workspace, { ...props, state: pilot }));
  assert.match(inherited, /Repair successor · awaiting proof/);

  pilot.evidence.push(failure('successor-failure', successor.id));
  pilot.conflicts.push({ id: 'successor-conflict', candidateId: successor.id, attemptIds: ['repair'], category: 'behavioural-interaction', status: 'REPAIR_CONTRADICTED', summary: 'Retained failure', evidenceIds: ['successor-failure'] });
  const contradicted = renderToStaticMarkup(createElement(Workspace, { ...props, state: pilot }));
  assert.match(contradicted, /Repair still has a recorded failure/);
  assert.match(journeyStep(contradicted, 'Repair'), /journey-step issue/);
  assert.match(contradicted, /Retained failure blocks successor/);
  assert.equal(repairOrigin(pilot, successor)?.id, failed.id);
});

test('attempt and repair paths distinguish edit scope from accepted changed files', () => {
  const pilot = state('400000', true);
  const repair = pilot.attempts[0]!;
  repair.allowedPaths = ['src/very/long/repair/permission/mutation.mjs'];
  pilot.attempts.unshift({ ...repair, id: 'A', role: 'A', name: 'Cache attempt', allowedPaths: ['src/very/long/granted/cache.mjs'],
    submissionId: 'source-A', changedPaths: ['src/very/long/recorded/cache.mjs', 'tests/cache.test.mjs'], status: 'COMPLETED' });
  pilot.attempts.push({ ...repair, id: 'repair-old', allowedPaths: ['src/very/long/previous/mutation.mjs'] });
  const html = renderToStaticMarkup(createElement(Workspace, { state: pilot, busy: '', command: async () => true, openReview: () => {}, selected: [], setSelected: () => {} }));
  assert.match(html, /<strong>Allowed to edit<\/strong><div class="attempt-files"><code>src\/very\/long\/granted\/cache\.mjs<\/code><\/div><\/div><div class="attempt-path-group"><strong>Recorded changes<\/strong><div class="attempt-files"><code>src\/very\/long\/recorded\/cache\.mjs<\/code><code>tests\/cache\.test\.mjs<\/code>/);
  assert.match(html, /<strong>Allowed to edit<\/strong><div class="attempt-files"><code>src\/very\/long\/repair\/permission\/mutation\.mjs<\/code><\/div><\/div><div class="attempt-path-group"><strong>Recorded changes<\/strong><p>No accepted source; changed files unavailable\.<\/p>/);
  assert.match(html, /Previous repair attempts · 1[\s\S]*<code>src\/very\/long\/previous\/mutation\.mjs<\/code>[\s\S]*No accepted source; changed files unavailable/);
});

test('the hero and journey distinguish submitted, failed, checked and published repair stages', () => {
  const props = { busy: '', command: async () => true, openReview: () => {}, selected: [], setSelected: () => {} };
  const pending = state('400000');
  pending.conflicts = [];
  pending.candidates[0]!.status = 'EVALUATING';
  pending.candidates[0]!.outcome = undefined;
  assert.match(renderToStaticMarkup(createElement(Workspace, { ...props, state: pending })), /<span>Checking as one\.<\/span>/);

  const verified = state('0', true);
  verified.candidates.push({ ...verified.candidates[0]!, id: 'successor', name: 'Repaired candidate', status: 'EVALUATING', outcome: undefined, attemptIds: ['repair'] });
  verified.activeCandidateId = 'successor';
  verified.conflicts[0]!.repairCandidateId = 'successor';
  verified.attempts[0]!.submissionId = 'repair-source';
  const beforeChecks = renderToStaticMarkup(createElement(Workspace, { ...props, state: verified }));
  assert.match(beforeChecks, /Repair successor · awaiting proof/);
  assert.match(beforeChecks, /still require final checks/);
  assert.doesNotMatch(beforeChecks, /This exact successor passed/);
  assert.doesNotMatch(journeyStep(beforeChecks, 'Repair'), /journey-step done/);
  verified.candidates[1]!.status = 'PASS';
  verified.candidates[1]!.outcome = 'PASS';
  verified.candidates[1]!.reviewEvaluationId = 'final-check';
  verified.evaluations = [{ id: 'final-check', candidateId: 'successor', contract: 'retained-value-v1', planDigest: 'plan', jobs: [], aggregation: 'all-required-pass', status: 'PASS', outcome: 'PASS', createdAt: '2026-10-08T00:00:00Z' }];
  const incompleteChecks = renderToStaticMarkup(createElement(Workspace, { ...props, state: verified }));
  assert.doesNotMatch(incompleteChecks, /Verified as one|Eligible for exact human review|Named contracts passed/);
  assert.match(incompleteChecks, /Final-goal checks required/);
  assert.match(incompleteChecks, /0 of 0 registered jobs passed/);
  assert.doesNotMatch(incompleteChecks, /<span class="badge good"><span class="badge-dot"><\/span>0 of 0 registered jobs passed/);
  const names = ['warm-read-write-read', 'repeated-reads', 'successive-writes', 'cold-write', 'retained-cache-benefit', 'accessible-value', 'audit-write-burst', 'audit-alternating-pages', 'overlapping-read-write'];
  verified.evaluations[0]!.jobs = names.map(name => ({ id: `final-check:${name}`, name, required: true, checkerClass: 'external-behavioural',
    candidateId: 'successor', evaluationInputDigest: `final-check:${name}`, input: {}, status: 'PASS' }));
  const afterChecks = renderToStaticMarkup(createElement(Workspace, { ...props, state: verified }));
  assert.match(afterChecks, /<span>Final checks passed after repair\.<\/span>/);
  assert.match(afterChecks, /This repair candidate passed the registered useful caching and accessible saved-value status checks/);
  assert.doesNotMatch(afterChecks, /still require proof in the repair/);
  assert.match(afterChecks, /Value-preserving successor/);
  assert.match(afterChecks, /This exact successor passed the registered checks/);
  assert.match(journeyStep(afterChecks, 'Repair'), /journey-step done/);
  assert.match(afterChecks, /<strong>Repair<\/strong><span>Original goals passed after repair<\/span>/);
  assert.match(journeyStep(afterChecks, 'Release'), /journey-step current/);
  verified.candidates[1]!.outcome = 'FAIL';
  const inconsistent = renderToStaticMarkup(createElement(Workspace, { ...props, state: verified }));
  assert.doesNotMatch(inconsistent, /Final checks passed after repair|Eligible for exact human review/);
  assert.match(inconsistent, /<span>Repair checks failed\.<\/span>/);
  assert.match(journeyStep(inconsistent, 'Repair'), /journey-step issue/);
  assert.match(journeyStep(inconsistent, 'Repair'), /aria-label="Repair: checks failed"/);
  assert.match(inconsistent, /<strong>Repair<\/strong><span>Successor failed checks<\/span>/);
  verified.candidates[1]!.outcome = 'PASS';
  const successor = verified.candidates[1]!;
  Object.assign(successor, { digest: 'successor-digest', manifestDigest: 'successor-manifest', commit: 'published-source' });
  verified.publications.push({ id: 'publication', candidateId: successor.id, proposalDigest: 'proposal', oldHead: successor.publicationBase,
    newHead: successor.commit, status: 'PUBLISHED', admittedAt: '', dispatchCount: 1, admissionWitness: null });
  verified.receipts.push({ id: 'receipt', sequence: 1, candidateId: successor.id, publicationId: 'publication', digest: 'receipt-digest',
    logical: { schemaVersion: 1, scope: { schemaVersion: 1, tenantId: verified.tenantId, projectId: verified.projectId, projectIncarnation: verified.projectIncarnation },
      outcome: 'PUBLISHED', operationId: 'publication', sequence: '1', enrollmentDigest: verified.enrollmentDigest, candidateDigest: successor.digest,
      manifestDigest: successor.manifestDigest, oldHead: successor.publicationBase, newHead: successor.commit, proposalDigest: 'proposal' },
    envelope: {}, createdAt: '2026-10-08T01:00:00Z' });
  const published = renderToStaticMarkup(createElement(Workspace, { ...props, state: verified }));
  assert.match(published, /<h1>Publication recorded\.<\/h1>/);
  assert.match(published, /Published release record/);
  assert.match(published, /Open recorded release/);
  assert.doesNotMatch(published, /aria-label="Release: pending"|Compose &amp; evaluate/);
});

test('release summary follows the current checker plan after a same-candidate re-evaluation', () => {
  const pilot = state('0', true);
  const candidate: PlatformState['candidates'][number] = { ...pilot.candidates[0]!, id: 'successor', name: 'Repaired candidate', status: 'PASS', outcome: 'PASS',
    attemptIds: ['repair'], repairOf: 'failed', reviewEvaluationId: 'current-full' };
  pilot.candidates.push(candidate);
  pilot.activeCandidateId = candidate.id;
  pilot.conflicts[0]!.repairCandidateId = candidate.id;
  const names = ['warm-read-write-read', 'repeated-reads', 'successive-writes', 'cold-write', 'retained-cache-benefit', 'accessible-value', 'audit-write-burst', 'audit-alternating-pages', 'overlapping-read-write'];
  const plan = (id: string, outcome: 'PASS' | 'FAIL') => ({ id, candidateId: candidate.id, contract: 'retained-value-v1' as const,
    planDigest: id, jobs: names.map(name => ({ id: `${id}:${name}`, name, required: true, checkerClass: 'external-behavioural' as const,
      candidateId: candidate.id, evaluationInputDigest: `${id}:${name}`, input: {}, status: outcome })),
    aggregation: 'all-required-pass' as const, status: 'SETTLED', outcome, createdAt: '2026-10-08T00:00:00Z' });
  // The deployed authority sends newest evaluations first. The earlier checker
  // result remains visible as history but cannot supply the current release.
  pilot.evaluations = [plan('current-full', 'PASS'), plan('old-checker-full', 'FAIL')];
  assert.equal(currentReleasePlan(pilot, candidate)?.id, 'current-full');
  assert.deepEqual([releaseMetrics(pilot, candidate).passedJobs, releaseMetrics(pilot, candidate).requiredJobs], [9, 9]);
  const current = renderToStaticMarkup(createElement(ReleaseStory, { state: pilot, candidate }));
  assert.match(current, /Original goals passed after repair/);
  assert.match(current, /Completed goals<\/dt><dd>3\/3<span class="score-context">9\/9 required checks passed/);
  assert.match(current, /Successor checked as one/);
  pilot.evidence = [{ id: 'old-failure', candidateId: candidate.id, outcome: 'FAIL', evaluationId: 'old-checker-full' } as PlatformState['evidence'][number]];
  const contradictory = renderToStaticMarkup(createElement(ReleaseStory, { state: pilot, candidate }));
  assert.match(contradictory, /A retained failure contradicts this later pass/);
  assert.match(contradictory, /Repair from the failed source/);
  assert.doesNotMatch(contradictory, /Original goals passed after repair|Successor checked as one/);
  pilot.evidence = [];
  pilot.reviews = [{ id: 'review', candidateId: candidate.id, proposalDigest: 'proposal', expectedHead: pilot.acceptedHead,
    goalRevision: 'goal', policyRevision: 'policy', planDigest: 'current-full', evidenceIds: [], observationRevision: pilot.observationRevision,
    expiresAt: '2099-01-01T00:00:00Z', status: 'READY' }];
  const readyForHuman = renderToStaticMarkup(createElement(ReleaseStory, { state: pilot, candidate }));
  assert.match(readyForHuman, /Reviewer decision<\/strong><p>Inspect the exact source and named evidence, then decide whether to approve/);
  pilot.reviews = [];

  candidate.reviewEvaluationId = undefined;
  // A passing historical projection must not make the release eligible when
  // the authority has no current full plan under the new checker.
  assert.equal(currentReleasePlan(pilot, candidate), undefined);
  const outdated = renderToStaticMarkup(createElement(ReleaseStory, { state: pilot, candidate }));
  assert.match(outdated, /Completed goals<\/dt><dd>0\/3<span class="score-context">Final checks pending on this candidate/);
  assert.match(outdated, /Current full release proof is unavailable/);
  assert.match(outdated, /No current eligible full release plan is recorded for this source/);
  assert.match(outdated, /No current eligible successor plan/);
  assert.match(outdated, /<span class="badge warning"><span class="badge-dot"><\/span>pending<\/span>/);
  assert.doesNotMatch(outdated, /Original goals passed after repair|9\/9|Successor checked as one|Prepare the exact review/);
  const workspace = renderToStaticMarkup(createElement(Workspace, { state: pilot, busy: '', command: async () => true, openReview: () => {}, selected: [], setSelected: () => {} }));
  assert.match(workspace, /Final-goal checks required/);
  assert.doesNotMatch(workspace, /Verified as one|Eligible for exact human review|Named contracts passed/);
});

test('candidate shows only current required jobs with their exact evidence outcomes', () => {
  const pilot = state('0', true);
  const candidate: PlatformState['candidates'][number] = { ...pilot.candidates[0]!, id: 'successor', name: 'Repair successor', outcome: 'FAIL',
    status: 'FAIL', attemptIds: ['repair'], repairOf: 'failed', reviewEvaluationId: 'current-plan' };
  pilot.candidates.push(candidate);
  pilot.activeCandidateId = candidate.id;
  const job = (id: string, name: string, required = true, status = 'PASS') => ({ id, name, required, checkerClass: 'external-behavioural' as const,
    candidateId: candidate.id, evaluationInputDigest: `${id}-input`, input: {}, status });
  pilot.evaluations = [
    { id: 'current-plan', candidateId: candidate.id, contract: 'retained-value-v1', planDigest: 'current-digest', aggregation: 'all-required-pass',
      status: 'SETTLED', outcome: 'FAIL', createdAt: '2026-10-08T00:00:00Z', jobs: [job('fresh', 'warm-read-write-read'), job('cache', 'retained-cache-benefit'), job('saved', 'accessible-saved-value', true, 'QUEUED'), job('optional', 'optional-diagnostic', false)] },
    { id: 'old-plan', candidateId: candidate.id, contract: 'retained-value-v1', planDigest: 'old-digest', aggregation: 'all-required-pass',
      status: 'SETTLED', outcome: 'PASS', createdAt: '2026-10-07T00:00:00Z', jobs: [job('old', 'historical-only')] },
  ];
  pilot.evidence = [{ id: 'cache-failure', candidateId: candidate.id, evaluationId: 'current-plan', jobId: 'cache', evaluationInputDigest: 'cache-input',
    checkerClass: 'external-behavioural', checkerId: 'checker', environmentDigest: 'environment', fixtureDigest: 'fixture', outcome: 'FAIL',
    observations: [], startedAt: '2026-10-08T00:00:00Z', completedAt: '2026-10-08T00:01:00Z', digest: 'evidence-digest', envelope: {},
    limitations: [], observationDigest: 'observation-digest' }];
  const html = renderToStaticMarkup(createElement(Workspace, { state: pilot, busy: '', command: async () => true, openReview: () => {}, selected: [], setSelected: () => {} }));
  const jobs = html.slice(html.indexOf('class="candidate-jobs"'), html.indexOf('class="candidate-footer"'));
  assert.equal(html.match(/class="contract-row"/g)?.length, 1);
  assert.match(jobs, /current-digest/);
  assert.equal(jobs.match(/<li>/g)?.length, 3);
  assert.match(jobs, /<strong>warm-read-write-read<\/strong>[\s\S]*?<span class="badge good">[\s\S]*?PASS/);
  assert.match(jobs, /<strong>retained-cache-benefit<\/strong>[\s\S]*?<span class="badge bad">[\s\S]*?FAIL/);
  assert.match(jobs, /<strong>accessible-saved-value<\/strong>[\s\S]*?<span class="badge warning">[\s\S]*?pending/);
  assert.doesNotMatch(jobs, /optional-diagnostic|historical-only|old-digest/);
});

test('in-flight integrated checks do not ask the reviewer to start a repair', () => {
  const pilot = state('400000');
  const candidate = pilot.candidates[0]!;
  candidate.status = 'EVALUATING';
  candidate.outcome = undefined;
  pilot.conflicts = [];
  const html = renderToStaticMarkup(createElement(ReleaseStory, { state: pilot, candidate }));
  assert.match(html, /Checking the combined source/);
  assert.match(html, /Wait for the integrated checks on this exact source before deciding whether repair is needed/);
  assert.doesNotMatch(html, /Start a bounded repair|needs a passing repair/);
});

test('an existing cohort leads with the failed release story and keeps budget accounting accessible', () => {
  const pilot = state('0', true);
  const original = pilot.attempts[0]!;
  pilot.attempts.unshift(...(['A', 'B', 'C'] as const).map(role => ({ ...original, id: role, role, name: `Agent ${role}`, status: 'COMPLETED', submissionId: `source-${role}`, executionOutcome: 'COMPLETED', changedPaths: [`${role.toLowerCase()}.mjs`] } as Attempt)));
  pilot.candidates[0]!.attemptIds = ['A', 'B', 'C'];
  pilot.conflicts[0]!.attemptIds = ['A', 'B', 'C'];
  pilot.conflicts[0]!.counterexample = [{ step: 3, action: 'GET', expected: 7976, observed: 4768, status: 200, responseDigest: 'observation' }];
  pilot.conflicts[0]!.witness = { rows: ['Baseline', 'A', 'B', 'A+B'].map((name, index) => ({ name, candidateId: `candidate-${index}`, evidenceId: `evidence-${index}`, outcome: index === 3 ? 'FAIL' as const : 'PASS' as const })), contrast: 1, scope: 'Fresh fixture for each run' };
  const html = renderToStaticMarkup(createElement(Workspace, { state: pilot, busy: '', command: async () => true, openReview: () => {}, selected: ['A', 'B', 'C'], setSelected: () => {} }));
  assert.match(html, /class="goal-heading goal-heading-active"/);
  assert.match(html, /<h1><span>Interaction found\.<\/span><\/h1>/);
  assert.doesNotMatch(html, /Better together\./);
  assert.match(html, /class="journey journey-active" role="group" aria-label="Release journey"/);
  assert.match(html, /class="journey-step current issue" aria-current="step" role="group" aria-label="Repair: stopped without accepted source"/);
  assert.match(html, /<strong>Repair<\/strong><span>Stopped without accepted source<\/span>/);
  assert.match(html, /class="notice reservation-notice reservation-compact warning"/);
  assert.match(html, /A new repair reserves 400,000 admission units/);
  assert.match(html, /<summary>Budget details<\/summary>/);
  assert.match(html, /Admission units are not provider dollars or measured model cost/);
  assert.match(html, /Next step<\/strong><p>A new repair needs 400,000 internal reservation units; 0 remain\. An admin must record an audited budget increase/);
  assert.match(html, /Then create a fresh bounded repair grant and check the repaired candidate against the original goals/);
  assert.match(html, /Expected 7,976 · observed 4,768/);
  assert.ok(html.indexOf('Release at a glance') < html.indexOf('Contributions, with their evidence.'));
  assert.equal(html.match(/aria-label="Baseline and contribution interaction results"/g)?.length, 1);
  assert.ok(html.indexOf('Controlled interaction witness') < html.indexOf('Contributions, with their evidence.'));
  assert.match(html, /<strong role="cell">A\+B<\/strong><span role="cell"><span class="badge bad"/);
});

test('the release story distinguishes recorded changed paths from edit permissions', () => {
  const pilot = state('400000', true);
  const original = pilot.attempts[0]!;
  pilot.attempts = [
    { ...original, id: 'A', role: 'A', name: 'Caching task', submissionId: 'source-A', allowedPaths: ['granted-only-a.mjs'], changedPaths: ['cache.mjs', 'tests/cache.mjs'] },
    { ...original, id: 'B', role: 'B', name: 'Write task', submissionId: 'source-B', allowedPaths: ['granted-only-b.mjs'], changedPaths: undefined },
    { ...original, id: 'C', role: 'C', name: 'Status task', submissionId: 'source-C', allowedPaths: ['granted-only-c.mjs'], changedPaths: [] },
  ];
  pilot.candidates[0]!.attemptIds = ['A', 'B', 'C'];
  const html = renderToStaticMarkup(createElement(ReleaseStory, { state: pilot, candidate: pilot.candidates[0] }));
  assert.match(html, /<div class="story-path-list"><code>cache\.mjs<\/code><code>tests\/cache\.mjs<\/code><\/div>/);
  assert.match(html, /Changed paths were not reported for this accepted source/);
  assert.match(html, /No changed paths were recorded for this accepted source/);
  assert.doesNotMatch(html, /granted-only-[abc]\.mjs/);
  assert.match(html, /Next step<\/strong><p>Start a fresh bounded repair grant, then check the exact successor against the original goals/);
  assert.doesNotMatch(html, /audited budget increase/);
});

test('the first-fold decision waits for an active repair instead of requesting another grant', () => {
  const pilot = state('0', true);
  pilot.attempts[0]!.status = 'RUNNING';
  pilot.attempts[0]!.terminationObserved = false;
  pilot.attempts[0]!.executionOutcome = 'PENDING';
  const html = renderToStaticMarkup(createElement(ReleaseStory, { state: pilot, candidate: pilot.candidates[0] }));
  assert.match(html, /Next step<\/strong><p>A bounded repair is in progress/);
  assert.doesNotMatch(html, /audited budget increase/);
  pilot.attempts[0]!.submissionId = 'accepted-repair-source';
  const submitted = renderToStaticMarkup(createElement(ReleaseStory, { state: pilot, candidate: pilot.candidates[0] }));
  assert.match(submitted, /Next step<\/strong><p>The repair submitted source\. Wait for its exact successor/);
  assert.doesNotMatch(submitted, /audited budget increase/);
});

test('release story names source and diagnosis waits before a repair decision', () => {
  const pilot = state('400000');
  pilot.capabilities.deployment = false;
  pilot.conflicts = [];
  const failed = { ...pilot.candidates[0]!, attemptIds: ['A'] };
  pilot.candidates = [];
  pilot.activeCandidateId = undefined;
  pilot.attempts = [{ id: 'A', name: 'Cache attempt', role: 'A', mode: 'scripted', status: 'RUNNING', assigned: 'Enable caching',
    workBase: 'base', publicationBase: 'base', generation: 1, grantId: 'grant', allowedPaths: ['cache.mjs'],
    terminationObserved: false, executionOutcome: 'PENDING' }];

  const waiting = renderToStaticMarkup(createElement(ReleaseStory, { state: pilot }));
  assert.match(waiting, /Wait for accepted source from the remaining attempts/);
  assert.doesNotMatch(waiting, /Select completed contributions/);

  pilot.attempts[0]!.submissionId = 'source-A';
  pilot.candidates = [failed];
  pilot.activeCandidateId = failed.id;
  const diagnosing = renderToStaticMarkup(createElement(ReleaseStory, { state: pilot, candidate: failed }));
  assert.match(diagnosing, /Combined checks failed; diagnosis pending/);
  assert.match(diagnosing, /Interaction diagnosis pending/);
  assert.match(diagnosing, /wait for an interaction diagnosis before deciding on repair/);
  assert.doesNotMatch(diagnosing, /No interaction recorded/);
  assert.match(diagnosing, /class="release-decision" role="status" aria-live="polite"/);

  pilot.conflicts = [{ id: 'conflict', candidateId: failed.id, attemptIds: ['A'], category: 'behavioural-interaction', status: 'OPEN', summary: 'A stale read', evidenceIds: [] }];
  const diagnosed = renderToStaticMarkup(createElement(ReleaseStory, { state: pilot, candidate: failed }));
  assert.match(diagnosed, /The combination exposed an interaction/);
  assert.match(diagnosed, /Start a bounded repair/);
  assert.doesNotMatch(diagnosed, /diagnosis pending/);
});

test('a failed repair successor follows its own failure before its predecessor conflict', () => {
  const pilot = state('0', true);
  pilot.attempts[0]!.submissionId = 'repair-source';
  pilot.candidates.push({ ...pilot.candidates[0]!, id: 'successor', name: 'Repair successor', commit: 'successor-source', repairOf: 'failed', attemptIds: ['repair'] });
  pilot.conflicts[0]!.repairCandidateId = 'successor';
  pilot.conflicts.push({ id: 'successor-conflict', candidateId: 'successor', attemptIds: ['repair'], category: 'behavioural-interaction', status: 'OPEN', summary: 'The repair still returns a stale value.', evidenceIds: [] });
  pilot.activeCandidateId = 'successor';
  const selected = pilot.candidates[1]!;
  assert.equal(currentConflict(pilot)?.candidateId, 'successor');
  assert.equal(releaseConflict(pilot, selected)?.candidateId, 'successor');
  assert.equal(repairOrigin(pilot, selected)?.id, 'failed');
  const html = renderToStaticMarkup(createElement(ReleaseStory, { state: pilot, candidate: selected }));
  assert.match(html, /The repair still fails a release check/);
  assert.match(html, /Successor failed checks/);
  assert.match(html, /Inspect the exact failure before another bounded repair/);
  assert.doesNotMatch(html, /Wait for its exact successor and final-goal checks/);
  const workspace = renderToStaticMarkup(createElement(Workspace, { state: pilot, busy: '', command: async () => false, openReview: () => {}, selected: [], setSelected: () => {} }));
  assert.match(workspace, /Current repair evidence/);
  assert.match(workspace, /earlier A\+B witness remains with the original candidate/);
  assert.doesNotMatch(workspace, /The composition enables caching and removes write invalidation/);
  pilot.attempts.push({ ...pilot.attempts[0]!, id: 'second-repair', workBase: 'successor-source', submissionId: undefined, status: 'RUNNING', terminationObserved: false, executionOutcome: 'PENDING' });
  pilot.conflicts[1]!.repairAttemptId = 'second-repair';
  const inProgress = renderToStaticMarkup(createElement(ReleaseStory, { state: pilot, candidate: selected }));
  assert.match(inProgress, /A bounded repair is in progress/);
  assert.doesNotMatch(inProgress, /Inspect the exact failure before another bounded repair/);
});

function sourceCandidate(id: string, commit: string, parent: string, hashes: [string, string, string], attemptIds: string[] = [], submissionIds: string[] = []): Candidate {
  const paths = ['cache.mjs', 'mutation.mjs', 'presentation.mjs'];
  return { id, name: id, digest: `sha256:${id}`, commit, commitBytesDigest: `sha256:commit-${id}`, manifestDigest: `sha256:manifest-${id}`,
    publicationBase: parent, attemptIds, submissionIds, composition: submissionIds, status: 'PASS', outcome: 'PASS',
    evaluationIds: [], createdAt: '2026-10-08T00:00:00Z', changedPaths: paths,
    manifest: { schemaVersion: 1, profile: 'ascii-regular-v1', entries: paths.map((path, index) => ({ path, mode: '100644' as const, size: 1, digest: `sha256:${hashes[index]}`, gitOid: '' })) } };
}

test('a submitted original attempt can open its own immutable source, while pending or mismatched submissions cannot', () => {
  const pilot = state('400000');
  pilot.activeCandidateId = undefined;
  pilot.conflicts = [];
  const base = sourceCandidate('baseline', 'a'.repeat(40), 'prior', ['0', '0', '0']);
  const individual = sourceCandidate('A-individual', 'b'.repeat(40), base.commit, ['1', '0', '0'], ['A'], ['source-A']);
  base.sourceFiles = { 'cache.mjs': 'cache disabled' };
  individual.sourceFiles = { 'cache.mjs': 'cache enabled' };
  pilot.candidates = [base, individual];
  pilot.attempts = [{ id: 'A', name: 'A · Read acceleration', role: 'A', mode: 'pi', status: 'SUBMITTED', assigned: 'Enable caching',
    workBase: base.commit, publicationBase: base.commit, generation: 1, grantId: 'grant-A', allowedPaths: ['cache.mjs'],
    submissionId: 'source-A', commit: individual.commit, changedPaths: ['cache.mjs'] }];
  const props = { state: pilot, busy: '', command: async () => true, openReview: () => {}, selected: [], setSelected: () => {} };
  const ready = renderToStaticMarkup(createElement(Workspace, props));
  assert.match(ready, /Inspect accepted source/);
  assert.doesNotMatch(ready, /id="attempt-source-inspection"/);
  const source = renderToStaticMarkup(createElement(AttemptSource, { attempt: pilot.attempts[0]!, candidate: individual, state: pilot, onClose: () => {} }));
  assert.match(source, /Accepted submission · agent A/);
  assert.match(source, /source-A/);
  assert.match(source, /cache disabled/);
  assert.match(source, /cache enabled/);
  assert.match(source, /Inspect complete source before approval/);
  individual.sourceFiles = {};
  const omitted = renderToStaticMarkup(createElement(AttemptSource, { attempt: pilot.attempts[0]!, candidate: individual, state: pilot, onClose: () => {} }));
  assert.match(omitted, /Text preview unavailable: binary, budget or read failure/);
  assert.match(omitted, /The preview may omit or truncate source/);
  assert.match(omitted, /Inspect complete source before approval/);
  pilot.attempts[0]!.submissionId = undefined;
  assert.doesNotMatch(renderToStaticMarkup(createElement(Workspace, props)), /Inspect accepted source/);
  pilot.attempts[0]!.submissionId = 'different-submission';
  assert.doesNotMatch(renderToStaticMarkup(createElement(Workspace, props)), /Inspect accepted source/);
});

test('repair copy separates inherited attempts from original source edits proven retained or superseded', () => {
  const pilot = state('400000');
  const base = sourceCandidate('baseline', 'a'.repeat(40), 'prior', ['0', '0', '0']);
  const a = sourceCandidate('A-individual', 'b'.repeat(40), base.commit, ['1', '0', '0'], ['A'], ['source-A']);
  const b = sourceCandidate('B-individual', 'c'.repeat(40), base.commit, ['0', '1', '0'], ['B'], ['source-B']);
  const c = sourceCandidate('C-individual', 'd'.repeat(40), base.commit, ['0', '0', '1'], ['C'], ['source-C']);
  const failed = sourceCandidate('failed', 'e'.repeat(40), base.commit, ['1', '1', '1'], ['A', 'B', 'C'], ['source-A', 'source-B', 'source-C']);
  failed.outcome = 'FAIL';
  const repaired = sourceCandidate('successor', 'f'.repeat(40), base.commit, ['1', '0', '1'], ['A', 'B', 'C', 'repair'], ['source-A', 'source-B', 'source-C', 'source-repair']);
  repaired.repairOf = failed.id;
  repaired.reviewEvaluationId = 'full';
  pilot.candidates = [base, a, b, c, failed, repaired];
  pilot.activeCandidateId = repaired.id;
  const original = (role: 'A' | 'B' | 'C', commit: string): Attempt => ({ id: role, name: `Agent ${role}`, role, mode: 'pi', status: 'SUBMITTED', assigned: `Work ${role}`,
    workBase: base.commit, publicationBase: base.commit, generation: 1, grantId: `grant-${role}`, allowedPaths: [],
    submissionId: `source-${role}`, commit, changedPaths: [role === 'A' ? 'cache.mjs' : role === 'B' ? 'mutation.mjs' : 'presentation.mjs'] });
  // Submission commits belong to isolated workspaces; materialized individual commits can differ.
  pilot.attempts = [original('A', '1'.repeat(40)), original('B', '2'.repeat(40)), original('C', '3'.repeat(40)), {
    id: 'repair', name: 'Repair', role: 'repair', mode: 'pi', status: 'SUBMITTED', assigned: 'Restore write freshness',
    workBase: failed.commit, publicationBase: base.commit, generation: 1, grantId: 'grant-repair', allowedPaths: ['mutation.mjs'],
    submissionId: 'source-repair', commit: repaired.commit }];
  pilot.conflicts = [{ id: 'conflict', category: 'behavioural-interaction', candidateId: failed.id, repairCandidateId: repaired.id,
    repairAttemptId: 'repair', attemptIds: ['A', 'B', 'C'], status: 'RESOLVED', summary: 'Stale read', evidenceIds: [] }];
  const names = ['warm-read-write-read', 'repeated-reads', 'successive-writes', 'cold-write', 'audit-write-burst', 'retained-cache-benefit', 'accessible-value', 'audit-alternating-pages', 'overlapping-read-write'];
  pilot.evaluations = [{ id: 'full', candidateId: repaired.id, contract: 'retained-value-v1', planDigest: 'full-plan',
    jobs: names.map(name => ({ id: `full:${name}`, name, required: true, checkerClass: 'external-behavioural', candidateId: repaired.id,
      evaluationInputDigest: `input:${name}`, input: {}, status: 'PASS' })),
    aggregation: 'all-required-pass', status: 'SETTLED', outcome: 'PASS', createdAt: '2026-10-08T00:00:00Z' }];
  const html = renderToStaticMarkup(createElement(ReleaseStory, { state: pilot, candidate: repaired }));
  assert.match(html, /Original goals passed after repair/);
  assert.match(html, /A and C submitted source edits remain byte-identical on the changed paths/);
  assert.match(html, /B submitted source edit was superseded in this source/);
  assert.match(html, /Registered checks for fresh writes, useful caching and accessible saved status passed on this exact source/);
  assert.match(html, /Submitted source edit superseded/);
  assert.doesNotMatch(html, /Useful work, preserved through repair/);
});


function overlapFailureState(): PlatformState {
  const pilot = state('400000');
  const selected = pilot.candidates[0]!;
  selected.repairOf = 'earlier-failed-source';
  selected.reviewEvaluationId = 'current-nine';
  selected.evaluationIds = ['old-eight', 'current-nine'];
  selected.attemptIds = ['accepted-repair'];
  pilot.attempts = [{ id: 'accepted-repair', name: 'Prior repair', role: 'repair', mode: 'pi', status: 'SUBMITTED', assigned: 'Restore sequential freshness', workBase: 'earlier-failed-source', publicationBase: 'base', generation: 1, grantId: 'prior-grant', allowedPaths: ['mutation.mjs'], submissionId: 'accepted-source', terminationObserved: true, executionOutcome: 'COMPLETED' }];
  pilot.session = { principalId: 'owner', credentialClass: 'human' };
  const names = ['warm-read-write-read', 'repeated-reads', 'successive-writes', 'cold-write', 'retained-cache-benefit', 'accessible-value', 'audit-write-burst', 'audit-alternating-pages', 'overlapping-read-write'];
  pilot.evaluations = [{ id: 'current-nine', candidateId: selected.id, contract: 'retained-value-v1', planDigest: 'current-plan', aggregation: 'all-required-pass', status: 'SETTLED', outcome: 'FAIL', createdAt: '2026-10-08T00:00:00Z',
    jobs: names.map(name => ({ id: `current-nine:${name}`, name, candidateId: selected.id, required: true, checkerClass: 'external-behavioural', evaluationInputDigest: `input:${name}`, input: {}, status: name === 'overlapping-read-write' ? 'FAIL' : 'PASS' })) }];
  pilot.evidence = [{ id: 'overlap-failure', candidateId: selected.id, evaluationId: 'current-nine', jobId: 'current-nine:overlapping-read-write', evaluationInputDigest: 'input:overlapping-read-write', checkerClass: 'external-behavioural', checkerId: 'checker', environmentDigest: 'environment', fixtureDigest: 'fixture', outcome: 'FAIL',
    observations: [
      { action: 'write', expected: 5136, observed: 5136, status: 200, responseDigest: 'sha256:' + 'a'.repeat(64) },
      { action: 'overlap-read', expectedOneOf: [2104, 5136], observed: 2104, status: 200, responseDigest: 'sha256:' + 'b'.repeat(64) },
      { action: 'read', expected: 5136, observed: 2104, status: 200, responseDigest: 'sha256:' + 'b'.repeat(64) },
    ], diagnostics: [{ action: 'overlap-captured', expected: 2104, observed: 2104, storeReadCount: 1 }, { action: 'overlap-released', afterWriteStatus: 200 }],
    startedAt: '', completedAt: '2026-10-08T00:00:01Z', digest: 'evidence-digest', observationDigest: 'observation-digest', envelope: {}, limitations: [] }];
  pilot.conflicts[0]!.evidenceIds = ['overlap-failure'];
  pilot.conflicts[0]!.counterexample = pilot.evidence[0]!.observations;
  pilot.reviews = [{ id: 'old-review', candidateId: selected.id, proposalDigest: 'old-proposal', expectedHead: pilot.acceptedHead, goalRevision: '1', policyRevision: '1', planDigest: 'old-eight-plan', evidenceIds: [], observationRevision: 0, expiresAt: '2020-01-01T00:00:00Z', status: 'PREPARED' }];
  return pilot;
}

test('an eight-pass overlap failure shows the retained concurrent trace and prioritizes repair over its expired review', () => {
  const pilot = overlapFailureState();
  const props = { state: pilot, busy: '', command: async () => false, openReview: () => {}, selected: [], setSelected: () => {} };
  const html = renderToStaticMarkup(createElement(Workspace, props));
  assert.match(html, /Overlapping read\/write trace/);
  assert.match(html, /WRITE → HTTP 200; expected 5136, observed 5136/);
  assert.match(html, /OVERLAPPING READ → HTTP 200; expected 2104 or 5136, observed 2104/);
  assert.match(html, /FRESH READ → HTTP 200; expected 5136, observed 2104/);
  assert.match(html, /The write saved 5136. The fresh read returned 2104/);
  assert.doesNotMatch(html, /Seed value 0|GET before expiry; expected 1|Read → write → read/);
  assert.match(html, /Inspect the exact failure before another bounded repair/);
  assert.doesNotMatch(html, /The review is stale or expired. Prepare a fresh proposal/);
  assert.doesNotMatch(repairButton(html, 'Start a bounded repair'), /disabled/);
  const frozen = freezeCommand(pilot, 'Start repair', '/api/repair', { conflictId: 'conflict' }, 'owned-command');
  assert.deepEqual(JSON.parse(frozen.body), { candidateId: 'failed' }, 'the action must target the currently failing successor, not its predecessor');

  pilot.attempts.push({ id: 'next-repair', name: 'Cache repair', role: 'repair', mode: 'pi', status: 'RUNNING', assigned: 'Fix the overlapping read', workBase: 'failed-source', publicationBase: 'base', generation: 1, grantId: 'next-grant', allowedPaths: ['cache.mjs'] });
  pilot.conflicts[0]!.repairAttemptId = 'next-repair';
  const running = renderToStaticMarkup(createElement(ReleaseStory, { state: pilot, candidate: pilot.candidates[0] }));
  assert.match(running, /A bounded repair is in progress/);
  assert.doesNotMatch(running, /Prepare a fresh proposal|Inspect the exact failure before another bounded repair/);
});

test('overlap inspection preserves allowed old responses and marks only the fresh-read mismatch', () => {
  const pilot = overlapFailureState();
  const render = () => renderToStaticMarkup(createElement(Evidence, { state: pilot }));
  const html = render();
  assert.match(html, /HTTP observations<\/span><strong>3<\/strong>/);
  assert.match(html, /2104 or 5136/);
  assert.equal((html.match(/class="mismatch"/g) ?? []).length, 1);
  assert.match(html, /class="mismatch"[^>]*><td>Not recorded<\/td><td><code>read<\/code>/);
  assert.match(html, /Retained checker diagnostics \(2\)/);
  assert.match(html, /Harness-observed store reads<\/span><strong class="metric-unavailable">Not recorded/);
  pilot.evidence[0]!.observations[1]!.observed = 5136;
  assert.equal((render().match(/class="mismatch"/g) ?? []).length, 1, 'a retried overlapping read may return the new value');
  pilot.evidence[0]!.observations[1]!.observed = 9999;
  assert.equal((render().match(/class="mismatch"/g) ?? []).length, 2, 'a response outside the signed allowed set is a mismatch');
});

test('missing retained counterexample does not fabricate a seeded sequential trace', () => {
  const pilot = overlapFailureState();
  pilot.conflicts[0]!.counterexample = [];
  const html = renderToStaticMarkup(createElement(Workspace, { state: pilot, busy: '', command: async () => false, openReview: () => {}, selected: [], setSelected: () => {} }));
  assert.match(html, /No HTTP counterexample was recorded in this snapshot/);
  assert.doesNotMatch(html, /Seed value 0|GET before expiry; expected 1/);
});
