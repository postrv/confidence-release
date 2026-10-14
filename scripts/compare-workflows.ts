import { FULL_RELEASE_JOB_COUNT } from '../workers/evaluator/recipes.ts';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LocalPlatform, protocolManifest } from '../services/platform.ts';
import { ExternalEvaluator, checkerLimitations } from '../services/evaluator.ts';
import { GitStore } from '../services/git.ts';
import { canonical, digest, hashBytes } from '../services/crypto.ts';
import { verifyBundle } from '../packages/protocol/src/index.ts';
import type { Candidate, Evidence, Evaluation, Observation, Outcome } from '../services/types.ts';

// Fixed-source/local scripted comparison. No model credentials are used and no
// performance, attention, or agent-quality advantage is inferred from it.
const repository = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.env.CONFIDENCE_COMPARISON_OUTPUT || 'demo-output/comparison.json');
const directory = await mkdtemp(join(tmpdir(), 'confidence-comparison-'));
await mkdir(dirname(output), { recursive: true });
const platform = new LocalPlatform(join(directory, 'confidence'));
const conventional = new GitStore(join(directory, 'conventional', 'branches.git'), join(directory, 'conventional', 'accepted.git'));
const ci = new ExternalEvaluator(conventional, join(directory, 'conventional', 'ci'));
const MAX_REPORT_BYTES = 512 * 1024;
type Observed = Pick<Evidence, 'outcome' | 'observations' | 'diagnostics' | 'storeReadCount' | 'runtimeObservation' | 'observationDigest'>;
type JobRecord = { name: string; id: string; inputDigest: string; fixtureDigest: string; outcome: Outcome; storeReadCount: number; observationDigest: string; observations: Observation[]; diagnostics: unknown[]; terminationObserved: boolean; signedEvidenceDigest?: string };
type Lane = { evaluationId: string; planDigest: string; outcome: Outcome; jobs: JobRecord[] };
const report: any = {
  schemaVersion: 1, status: 'RUNNING', mode: 'local-scripted-fixed-source-paired-checks', generatedAt: new Date().toISOString(),
  method: {
    sampleSize: 1, frozenSources: 6, protectedJobsPerSourcePerLane: FULL_RELEASE_JOB_COUNT, pairedLaneJobs: 6 * FULL_RELEASE_JOB_COUNT,
    authoring: 'One shared four-attempt deterministic scripted cohort; exact resulting commit objects replayed in both lanes.',
    conventional: 'Ordinary isolated Git branches, complete identical protected CI logs, explicit scripted local approval and fixed-head Git publication.',
    confidence: 'Same source and protected checks; typed attributed attempts, composition, interaction witness, repair capsule, exact review and signed portable receipt.',
    ordering: 'Alternate which lane runs first for each source; every job starts a new candidate process and backing store. Evidence reuse disabled.',
    compared: ['Frozen source identity', 'Checker and complete job input identity', 'Observed responses, freshness, backing-store counts and accessible status', 'Retained coordination and publication records'],
    unmeasured: ['Model quality', 'Real-model cost and equal-budget success rates', 'Latency or throughput improvement', 'Human sponsor attention or comprehension', 'General program correctness'],
  },
  identity: {}, cases: [], conclusion: null,
  limitations: ['Predetermined authored edits and one designed fixture, with synthetic approval by the comparison script. This is a record and checker-equivalence comparison, not an end-to-end human/model study.', 'The conventional driver receives the same frozen integration and repair source. It is not asked to independently rediscover an already known repair.', 'Ordinary CI with these same checks detects the conflict. Conventional tools can also add provenance, review bindings, signatures and capsules; the plain branch/CI driver here does not add those features.', ...checkerLimitations],
  liveReleaseGates: ['Run paired ordinary-branch and Confidence workflows with the same real model, exact tasks, useful-goal criteria, total authoring/evaluation budgets and frozen checker inputs.', 'Measure sponsor attention, comprehension errors, repeated work, total cost and useful release completion; retain negative and inconclusive results.', 'Establish live Artifacts conditional-publication and Cloudflare candidate/checker isolation separately.'],
};
async function save(): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + '\n'); assert.ok(bytes.length <= MAX_REPORT_BYTES, 'Comparison report exceeded its 512 KiB bound'); await writeFile(output, bytes);
}
function outcome(jobs: JobRecord[]): Outcome { return jobs.every(job => job.outcome === 'PASS') ? 'PASS' : jobs.some(job => job.outcome === 'FAIL') ? 'FAIL' : 'INCONCLUSIVE'; }
function recordJob(name: string, id: string, inputDigest: string, fixtureDigest: string, evidence: Observed, signedEvidenceDigest?: string): JobRecord {
  assert.ok(typeof evidence.storeReadCount === 'number' && Number.isSafeInteger(evidence.storeReadCount) && evidence.storeReadCount >= 0, 'Comparison requires an observed backing-store read count');
  return { name, id, inputDigest, fixtureDigest, outcome: evidence.outcome, storeReadCount: evidence.storeReadCount, observationDigest: evidence.observationDigest, observations: structuredClone(evidence.observations), diagnostics: structuredClone(evidence.diagnostics ?? []), terminationObserved: evidence.runtimeObservation?.terminationObserved === true, ...(signedEvidenceDigest ? { signedEvidenceDigest } : {}) };
}
function observable(jobs: JobRecord[]): unknown {
  // Ports/PIDs, timestamps, per-run job IDs and observation hashes are expected
  // to differ. Actual outcome, body digest, values, HTTP status and store counts
  // are compared in full; no check or failure is removed from the paired set.
  return jobs.map(job => ({ name: job.name, inputDigest: job.inputDigest, fixtureDigest: job.fixtureDigest, outcome: job.outcome, storeReadCount: job.storeReadCount, observations: job.observations, diagnostics: job.diagnostics, terminationObserved: job.terminationObserved }));
}
async function runConfidence(candidate: Candidate): Promise<Lane> {
  const evaluation = await platform.evaluate(candidate, 'retained-value-v1'); assert.equal(evaluation.jobs.length, FULL_RELEASE_JOB_COUNT);
  const jobs = evaluation.jobs.map(job => { const evidence = platform.state.evidence.find(item => item.id === job.evidenceId)!; assert.ok(evidence); return recordJob(job.name, job.id, job.evaluationInputDigest, evidence.fixtureDigest, evidence, evidence.digest); });
  return { evaluationId: evaluation.id, planDigest: evaluation.planDigest, outcome: outcome(jobs), jobs };
}
async function runConventional(candidate: Candidate): Promise<Lane> {
  const evaluation: Evaluation = await ci.plan(candidate, 'retained-value-v1'); assert.equal(evaluation.jobs.length, FULL_RELEASE_JOB_COUNT); const jobs: JobRecord[] = [];
  for (const job of evaluation.jobs) {
    const actual = await ci.runJob(candidate, evaluation, job); const observationDigest = digest(actual);
    // Retain complete CI observations before the candidate workspace is removed.
    await writeFile(join(directory, 'conventional', `${job.id}.json`), canonical(actual));
    jobs.push(recordJob(job.name, job.id, job.evaluationInputDigest, actual.fixtureDigest, { ...actual, observationDigest }));
    assert.ok(actual.runtimeObservation?.terminationObserved, 'Conventional candidate generation remained uncertain');
    await rm(join(directory, 'conventional', 'ci', job.id), { recursive: true, force: true });
  }
  return { evaluationId: evaluation.id, planDigest: evaluation.planDigest, outcome: outcome(jobs), jobs };
}
try {
  await save(); await platform.initialize(); const baseline = platform.state.acceptedHead;
  process.stdout.write('Preparing one labelled scripted cohort and exact integration/repair source.\n');
  await platform.startDemo({ mode: 'scripted', autoSelect: true, commandId: 'comparison-source-cohort' }); await platform.waitForIdle();
  assert.equal(platform.state.error, undefined); const conflict = platform.state.conflicts.find(item => item.category === 'behavioural-interaction' && item.status === 'OPEN')!; assert.ok(conflict?.candidateId);
  const integrated = platform.state.candidates.find(candidate => candidate.id === conflict.candidateId)!;
  await platform.repair({ conflictId: conflict.id, commandId: 'comparison-source-repair' }); await platform.waitForIdle(); assert.equal(platform.state.error, undefined);
  const repair = platform.state.candidates.find(candidate => candidate.id === platform.state.activeCandidateId)!; assert.equal(repair.outcome, 'PASS');
  const attempts = ['A', 'B', 'C'].map(role => platform.state.attempts.find(attempt => attempt.role === role)!);
  assert.equal(platform.state.attempts.length, 4); assert.ok(platform.state.attempts.every(attempt => attempt.mode === 'scripted' && attempt.terminationObserved));
  const cases = [
    { name: 'baseline', candidate: platform.state.candidates.find(candidate => candidate.name === 'Baseline')! },
    ...attempts.map(attempt => ({ name: attempt.role, candidate: platform.state.candidates.find(candidate => candidate.attemptIds.length === 1 && candidate.attemptIds[0] === attempt.id)! })),
    { name: 'integrated-A+B+C', candidate: integrated }, { name: 'repair-retains-A+C', candidate: repair },
  ];
  assert.equal(cases.length, 6); assert.ok(cases.every(item => item.candidate));
  assert.equal(await conventional.initialize(join(repository, 'fixtures/collaboration-demo')), baseline);
  const preparationEvaluations = platform.state.evaluations.length, preparationJobs = platform.state.evaluations.reduce((count, evaluation) => count + evaluation.jobs.length, 0);
  for (const { name, candidate } of cases) {
    const commitBytes = await platform.git.git(['cat-file', 'commit', candidate.commit]);
    assert.equal(candidate.commitBytesDigest, hashBytes(commitBytes));
    assert.equal(candidate.digest, digest({ commit: candidate.commit, commitBytesDigest: candidate.commitBytesDigest, parent: candidate.publicationBase, manifestDigest: candidate.manifestDigest, attemptIds: candidate.attemptIds, composition: candidate.composition, materializer: 'whole-file-delta-v1' }));
    await conventional.git(['fetch', platform.git.directory, `${candidate.commit}:refs/heads/${name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`]);
    assert.deepEqual(await conventional.git(['cat-file', 'commit', candidate.commit]), commitBytes);
    assert.equal(digest(protocolManifest(await conventional.manifest(candidate.commit))), candidate.manifestDigest);
  }
  const planIdentity = await ci.plan(repair, 'retained-value-v1'); const firstInput: any = planIdentity.jobs[0].input;
  report.identity = {
    contract: 'retained-value-v1', checker: firstInput.checker, checkerImplementationDigest: firstInput.checkerImplementationDigest,
    runtimeBinaryDigest: firstInput.environment.runtimeBinaryDigest, environment: firstInput.environment, compositionRecipe: firstInput.compositionRecipe,
    agentRecipe: 'scripted-fixture-v1', agentRecipeSourceDigest: hashBytes(await readFile(join(repository, 'services/agent-child.mjs'))),
    fixtureSource: Object.fromEntries(await Promise.all(['cache.mjs', 'mutation.mjs', 'presentation.mjs', 'server.mjs'].map(async path => [path, hashBytes(await readFile(join(repository, 'fixtures/collaboration-demo', path)))]))),
    protectedProbeDigests: planIdentity.jobs.map(job => ({ name: job.name, digest: digest(job.input.fixture) })),
    kernelDigest: hashBytes(await readFile(join(repository, 'packages/protocol/wasm/confidence_protocol_bg.wasm'))),
  };
  report.budgets = { sharedSourcePreparation: { authoredAttempts: 4, realModelCalls: 0, declaredAuthoringSecondsPerAttempt: platform.state.goal.budget.authoringSeconds, registeredEvaluations: preparationEvaluations, registeredJobs: preparationJobs, extraBoundedReducerRuns: ((conflict.reduction as any)?.history || []).length, reducerRunsIncludedInRegisteredJobs: true }, pairedChecks: { sources: 6, jobsPerSourcePerLane: FULL_RELEASE_JOB_COUNT, jobsPerLane: cases.length * FULL_RELEASE_JOB_COUNT, secondsCeilingPerJob: 15, failFast: false, reusedResults: 0 } };
  for (const [index, { name, candidate }] of cases.entries()) {
    let confidence: Lane, conventionalLane: Lane;
    if (index % 2 === 0) { confidence = await runConfidence(candidate); conventionalLane = await runConventional(candidate); }
    else { conventionalLane = await runConventional(candidate); confidence = await runConfidence(candidate); }
    const equivalent = canonical(observable(confidence.jobs)) === canonical(observable(conventionalLane.jobs));
    report.cases.push({ name, commit: candidate.commit, commitBytesDigest: candidate.commitBytesDigest, manifestDigest: candidate.manifestDigest, candidateDigest: candidate.digest, conventionalBranch: `refs/heads/${name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`, firstLane: index % 2 === 0 ? 'confidence' : 'conventional', completeObservationsEquivalent: equivalent, conventional: conventionalLane, confidence });
    await save(); assert.ok(equivalent, `Paired observations differed for ${name}`); assert.ok(confidence.jobs.every(job => job.terminationObserved && ['PASS', 'FAIL'].includes(job.outcome)), 'A paired job was unresolved');
    assert.equal(confidence.outcome, index === cases.length - 1 ? 'PASS' : 'FAIL', `Designed fixture result changed for ${name}`);
    process.stdout.write(JSON.stringify({ source: name, jobsPerLane: FULL_RELEASE_JOB_COUNT, conventional: conventionalLane.outcome, confidence: confidence.outcome, completeObservationsEquivalent: equivalent }) + '\n');
  }
  assert.equal(report.cases.find((item: any) => item.name === 'integrated-A+B+C').conventional.outcome, 'FAIL');
  assert.equal(report.cases.at(-1).conventional.outcome, 'PASS');
  const repairedCI = report.cases.at(-1).conventional as Lane;
  const conventionalApproval = { mode: 'scripted-local-comparison-decision', reviewer: 'comparison-script', exactCommit: repair.commit, manifestDigest: repair.manifestDigest, ciLogDigest: digest(repairedCI), approved: repairedCI.outcome === 'PASS' };
  assert.ok(conventionalApproval.approved); await conventional.publish(baseline, repair.commit); await conventional.verifyRemote(repair.commit); assert.equal(await conventional.remoteHead(), repair.commit);
  const review = await platform.review({ candidateId: repair.id, commandId: 'comparison-review' });
  await platform.approve({ proposalDigest: review.proposalDigest, commandId: 'comparison-approval' });
  await platform.publish({ proposalDigest: review.proposalDigest, commandId: 'comparison-publication' }); await platform.reconcile();
  const receipt = platform.state.receipts.at(-1)!; assert.ok(receipt); const bundle = await platform.exportReceipt(receipt.id), trust = platform.trustConfig(); const verified = verifyBundle(bundle, trust); assert.ok(verified.valid, JSON.stringify(verified));
  assert.equal(await platform.git.remoteHead(), await conventional.remoteHead());
  const sourceBundlePath = join(dirname(output), 'comparison-source.gitbundle');
  await platform.git.git(['bundle', 'create', sourceBundlePath, ...cases.map(item => `refs/candidates/${item.candidate.commit}`)]); await conventional.git(['bundle', 'verify', sourceBundlePath]);
  const receiptPath = join(dirname(output), 'comparison-receipt.json'), trustPath = join(dirname(output), 'comparison-trust.json');
  await writeFile(receiptPath, JSON.stringify(bundle, null, 2)); await writeFile(trustPath, JSON.stringify(trust, null, 2));
  const repairAttempt = platform.state.attempts.find(attempt => attempt.role === 'repair')!, capsule = platform.state.capsules.find(item => item.id === repairAttempt.capsuleId)!;
  report.records = {
    conventional: { branches: report.cases.map((item: any) => ({ ref: item.conventionalBranch, commit: item.commit })), protectedCiLogs: report.cases.map((item: any) => ({ source: item.name, planDigest: item.conventional.planDigest, logDigest: digest(item.conventional) })), logHandoff: { failedCommit: integrated.commit, fullJobLogsInReport: true, repairCommit: repair.commit, repairSourceFrozenForBothLanes: true }, approval: conventionalApproval, publication: { oldHead: baseline, newHead: await conventional.remoteHead(), exactRemoteSourceVerified: true, adapter: 'native-git-fixed-head-force-with-lease' } },
    confidence: {
      attempts: platform.state.attempts.map(attempt => ({ id: attempt.id, role: attempt.role, mode: attempt.mode, assigned: attempt.assigned, intent: attempt.intent, observed: attempt.observed, commit: attempt.commit, workBase: attempt.workBase, allowedPaths: attempt.allowedPaths, capsuleId: attempt.capsuleId, terminationObserved: attempt.terminationObserved })),
      composition: { integratedCommit: integrated.commit, contributors: integrated.submissionIds, repairedCommit: repair.commit, inheritedAndRepairContributors: repair.submissionIds, repairOf: repair.repairOf, retainedValue: ['Enabled caching passes one-backing-store-read probe', 'C accessible saved status exposes latest acknowledged value'], lineageQualification: 'B is retained in contribution provenance; restoring invalidation reverses B’s source change to preserve the full useful goal.' },
      interaction: { conflictId: conflict.id, summary: conflict.summary, witness: conflict.witness, reproducer: (conflict.reduction as any)?.reducedTrace, reductionScope: (conflict.reduction as any)?.status },
      repairCapsule: { id: capsule.id, digest: capsule.digest, exactFailedWorkBase: repairAttempt.workBase, failedCommit: integrated.commit, sourceCommit: capsule.sourceCommit, sourceManifestDigest: capsule.sourceManifestDigest, selectedItems: capsule.selectedItems, sessionDigest: capsule.sessionDigest, renderedContextDigest: capsule.renderedContextDigest, missingTail: capsule.missingTail, limitations: capsule.limitations },
      review: { proposalDigest: review.proposalDigest, exactCommit: repair.commit, planDigest: review.planDigest, evidenceCount: review.evidenceIds.length, observationRevision: review.observationRevision, approval: review.approval, status: review.status },
      publication: platform.state.publications.map(publication => ({ id: publication.id, oldHead: publication.oldHead, newHead: publication.newHead, status: publication.status, dispatchCount: publication.dispatchCount, receiptId: publication.receiptId })),
      receipt: { logicalDigest: receipt.digest, sequence: receipt.sequence, verification: verified, bundle: receiptPath, independentlySelectedTrust: trustPath },
    },
  };
  assert.equal(repairAttempt.workBase, integrated.commit); assert.ok(review.approval?.consumedBy); assert.equal(platform.state.publications[0].status, 'FINALIZED');
  report.artifacts = { sourceGitBundle: { path: sourceBundlePath, digest: hashBytes(await readFile(sourceBundlePath)) }, receiptBundle: { path: receiptPath, digest: hashBytes(await readFile(receiptPath)) }, separateTrust: { path: trustPath, digest: hashBytes(await readFile(trustPath)) } };
  report.conclusion = { sameFrozenSource: true, completePairedObservationsEquivalent: true, ordinaryCiDetectsIntegratedConflict: true, bothRetainUsefulGoalAfterSameRepair: true, bothPublishSameExactCommit: true, confidencePortableReceiptVerified: true, measuredWorkflowAdvantage: null, result: 'Checker equivalence demonstrated; Confidence retains additional typed coordination and portable authorization/publication records. A real-model and sponsor comparison remains unmeasured.' };
  report.status = 'PASS'; await save(); process.stdout.write(JSON.stringify({ status: report.status, report: output, pairedJobs: report.cases.reduce((total: number, item: any) => total + item.conventional.jobs.length + item.confidence.jobs.length, 0), sameProtectedObservations: true, ordinaryCiDetectsConflict: true, realModelCalls: 0, measuredWorkflowAdvantage: null, receiptVerified: verified.valid }) + '\n');
} catch (error) {
  report.status = 'INCONCLUSIVE'; report.error = error instanceof Error ? error.message.slice(0, 256) : 'COMPARISON_FAILED'; await save(); throw error;
} finally { await platform.shutdown().catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
