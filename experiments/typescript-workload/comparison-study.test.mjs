// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARMS, CHECKS, localProfileIdentity, recordDigest, registerStudy, validateEpisode, validateStudy } from './comparison-study.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const digest = `sha256:${'a'.repeat(64)}`;
const otherDigest = `sha256:${'b'.repeat(64)}`;
const at = second => `2026-10-07T12:00:${String(second).padStart(2, '0')}Z`;
const copy = value => structuredClone(value);
function moveTimes(value, offsetMs) {
  if (Array.isArray(value)) return value.map(row => moveTimes(row, offsetMs));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, row]) => [key, moveTimes(row, offsetMs)]));
  if (typeof value === 'string' && /^2026-10-07T12:00:\d\dZ$/.test(value)) return new Date(Date.parse(value) + offsetMs).toISOString().replace('.000Z', 'Z');
  return value;
}

async function registration() {
  const identity = await localProfileIdentity();
  const plan = {
    schemaVersion: 1, studyId: 'seat-inventory-paired-01',
    baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceManifestDigest: identity.sourceManifestDigest,
    authoringConfigDigest: identity.authoringConfigDigest,
    localOracleSourceDigest: identity.localOracleSourceDigest,
    goals: {
      A: { path: 'cache.ts', text: 'Cache unchanged availability reads with a bounded TTL.' },
      B: { path: 'reservations.ts', text: 'Simplify write-side invalidation while keeping reservations correct.' },
      C: { path: 'presentation.ts', text: 'Expose the latest count in an accessible live status.' },
      repair: { path: 'reservations.ts', text: 'Repair the failed combination while retaining all original goals.' },
    },
    model: { provider: 'test-provider', name: 'test-model', revision: 'fixed-01', endpoint: 'https://owned.invalid/v1', generationSettingsDigest: digest },
    prompts: { publicPromptDigest: digest, platformPolicyDigest: otherDigest, assignmentPacketDigests: { A: digest, B: digest, C: digest, repair: otherDigest } },
    compiler: { packageDigest: digest, version: '5.9.3' },
    evaluator: { imageDigest: digest, checkerDigest: otherDigest, slots: 2 },
    integrations: { narsil: { version: '1.7.2', digest, invocationConfigDigest: digest }, interlinked: { version: 'fixed-01', digest: otherDigest, invocationConfigDigest: otherDigest, compilerPackageDigest: digest } },
    prices: { inputMicroUsdPerMillionTokens: 1_400_000, cachedInputMicroUsdPerMillionTokens: 260_000, outputMicroUsdPerMillionTokens: 4_400_000, source: 'test-only fixed price', observedAt: at(0) },
    reviewRubricDigest: otherDigest,
    budgets: { providerCalls: 24, inputTokens: 120_000, outputTokens: 48_000, outputTokensPerCall: 8_192, modelCostMicroUsd: 100_000, episodeWallMs: 60_000, reviewerActiveMs: 30_000 },
    repetitions: 2, randomizationSeed: '1'.repeat(64), reviewerPseudonym: 'reviewer-1', authoringCapacity: 3,
  };
  return { identity, plan, study: registerStudy(plan, identity) };
}

function episode(study, arm = 'ordinary-branches-ci', replicate = 1) {
  const p = study.plan;
  return {
    schemaVersion: 1, registrationDigest: study.planDigest, arm, replicate,
    baselineCommit: p.baselineCommit, sourceManifestDigest: p.sourceManifestDigest, authoringConfigDigest: p.authoringConfigDigest,
    model: copy(p.model), compilerDigest: p.compiler.packageDigest,
    promptSetDigest: recordDigest(p.prompts),
    checkerDigest: p.evaluator.checkerDigest, evaluatorImageDigest: p.evaluator.imageDigest,
    integrations: { narsil: arm === 'confidence-narsil' || arm === 'confidence-both', interlinked: arm === 'confidence-interlinked' || arm === 'confidence-both' },
    startedAt: at(0), finishedAt: at(20),
    attempts: ['A', 'B', 'C'].map((role, index) => ({ role, grantedPath: { A: 'cache.ts', B: 'reservations.ts', C: 'presentation.ts' }[role], status: 'SUBMITTED', workBaseSourceDigest: p.sourceManifestDigest, submissionDigest: digest, startedAt: at(index + 1), finishedAt: at(10 + index), providerCalls: [{ id: `call-${role}`, usageStatus: 'OBSERVED', inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, providerUsageDigest: digest }] })),
    advisories: ['A', 'B', 'C'].flatMap(role => [
      ...(['confidence-narsil', 'confidence-both'].includes(arm) ? [{ attemptRole: role, tool: 'narsil', status: 'READY', elapsedMs: 100, bytesToModel: 500, identityDigest: p.integrations.narsil.digest, invocationConfigDigest: p.integrations.narsil.invocationConfigDigest }] : []),
      ...(['confidence-interlinked', 'confidence-both'].includes(arm) ? [{ attemptRole: role, tool: 'interlinked', status: 'SKIPPED', elapsedMs: 0, bytesToModel: 0, identityDigest: p.integrations.interlinked.digest, invocationConfigDigest: p.integrations.interlinked.invocationConfigDigest, resolvedCompilerDigest: null }] : []),
    ]),
    human: { reviewerPseudonym: p.reviewerPseudonym, activeIntervals: [{ startedAt: at(12), finishedAt: at(15), activity: 'Read failed source and CI output' }], decisions: [{ kind: 'reject', at: at(16), candidateDigest: digest }], answerSheetDigest: digest, comprehensionErrors: 0, repeatRequests: 1, repeatedWorkMs: 1000 },
    evaluations: [
      ...['A', 'B', 'C'].map((stage, index) => ({ stage, sourceDigest: otherDigest, evidenceDigest: digest, evaluatedAt: at(12 + index), checks: CHECKS.map(name => ({ name, outcome: 'FAIL' })) })),
      { stage: 'combined', sourceDigest: digest, evidenceDigest: otherDigest, evaluatedAt: at(15), checks: CHECKS.map(name => ({ name, outcome: name === 'acknowledged-reservation-freshness' ? 'FAIL' : 'PASS' })) },
    ],
    outcome: { status: 'FAILED', reason: 'Warm cache returned the old count after an acknowledged reservation.' },
  };
}

test('preregistration freezes exact six-file source, oracle, common budgets and a reproducible complete order', async () => {
  const { identity, plan, study } = await registration();
  assert.equal(identity.sourceEntries.length, 6);
  assert.equal(identity.authoringConfigEntries.length, 2);
  assert.equal(study.status, 'PREREGISTERED_LOCAL_PROFILE_ONLY');
  assert.equal(study.order.length, 2);
  assert.deepEqual(study.order.map(row => [...row.arms].sort()), [ARMS, ARMS].map(row => [...row].sort()));
  assert.deepEqual(registerStudy(plan, identity), study);
  const altered = copy(plan); altered.goals.A.path = 'domain.ts';
  assert.throws(() => registerStudy(altered, identity), /GOAL_A/);
  const alteredSource = copy(plan); alteredSource.sourceManifestDigest = otherDigest;
  assert.throws(() => registerStudy(alteredSource, identity), /SOURCE_MANIFEST_MISMATCH/);
  const alteredAuthoringConfig = copy(plan); alteredAuthoringConfig.authoringConfigDigest = otherDigest;
  assert.throws(() => registerStudy(alteredAuthoringConfig, identity), /AUTHORING_CONFIG_MISMATCH/);
  const changedPrelaunchBudget = copy(plan); changedPrelaunchBudget.budgets.outputTokensPerCall = 16_384;
  assert.notEqual(registerStudy(changedPrelaunchBudget, identity).planDigest, study.planDigest);
  const excessiveBudget = copy(plan); excessiveBudget.budgets.outputTokensPerCall = 32_769;
  assert.throws(() => registerStudy(excessiveBudget, identity), /BUDGET_LIMITS/);
  const unsafeEndpoint = copy(plan); unsafeEndpoint.model.endpoint = 'https://secret@example.invalid/v1?key=hidden';
  assert.throws(() => registerStudy(unsafeEndpoint, identity), /MODEL_ENDPOINT/);
  const malformedPrompt = copy(plan); malformedPrompt.prompts.assignmentPacketDigests.B = 'not-a-digest';
  assert.throws(() => registerStudy(malformedPrompt, identity), /PROMPT_DIGESTS/);
  const malformedSettings = copy(plan); malformedSettings.model.generationSettingsDigest = 'not-a-digest';
  assert.throws(() => registerStudy(malformedSettings, identity), /MODEL_IDENTITY/);
  const malformedInvocation = copy(plan); malformedInvocation.integrations.narsil.invocationConfigDigest = 'not-a-digest';
  assert.throws(() => registerStudy(malformedInvocation, identity), /INTEGRATION_NARSIL/);
  const mismatchedPreviewCompiler = copy(plan); mismatchedPreviewCompiler.integrations.interlinked.compilerPackageDigest = otherDigest;
  assert.throws(() => registerStudy(mismatchedPreviewCompiler, identity), /INTERLINKED_COMPILER_MISMATCH/);
});

test('structural records count every call and reviewer interval but never prove a real release', async () => {
  const { study } = await registration();
  const row = validateEpisode(study, episode(study));
  assert.equal(row.accounting.providerCalls, 3);
  assert.equal(row.accounting.inputTokens, 3000);
  assert.equal(row.accounting.outputTokens, 300);
  assert.equal(row.accounting.reviewerActiveMs, 3000);
  assert.equal(row.accounting.reviewerDecisions, 1);
  assert.equal(row.accounting.estimatedModelCostMicroUsd, 5520);
  assert.equal(row.claimEligible, false);
  assert.equal(row.evidenceClass, 'STRUCTURAL_RECORD_ONLY');
  const reportedRelease = episode(study);
  reportedRelease.evaluations.at(-1).checks = CHECKS.map(name => ({ name, outcome: 'PASS' }));
  reportedRelease.human.decisions = [{ kind: 'approve', at: at(16), candidateDigest: digest }];
  reportedRelease.outcome = { status: 'VERIFIED_RELEASE', reason: 'Reported successful release', sourceDigest: digest, publicationId: 'reported-publication', receiptDigest: digest, independentVerificationDigest: otherDigest, publishedAt: at(17), verifiedAt: at(18) };
  assert.equal(validateEpisode(study, reportedRelease).claimEligible, false);
});

test('mismatched arms and acceptance vectors are rejected; over-budget episodes stay visible', async () => {
  const { study } = await registration();
  const wrongArm = episode(study, 'confidence-both'); wrongArm.integrations.interlinked = false;
  assert.throws(() => validateEpisode(study, wrongArm), /EPISODE_INTEGRATION_ARM_MISMATCH/);
  const wrongSource = episode(study); wrongSource.sourceManifestDigest = otherDigest;
  assert.throws(() => validateEpisode(study, wrongSource), /EPISODE_SOURCE_MISMATCH/);
  const wrongPrompt = episode(study); wrongPrompt.promptSetDigest = otherDigest;
  assert.throws(() => validateEpisode(study, wrongPrompt), /EPISODE_PROMPT_MISMATCH/);
  const wrongInvocation = episode(study, 'confidence-narsil'); wrongInvocation.advisories[0].invocationConfigDigest = otherDigest;
  assert.throws(() => validateEpisode(study, wrongInvocation), /ADVISORY_OBSERVATION/);
  const tooManyTokens = episode(study); tooManyTokens.attempts[0].providerCalls[0].inputTokens = 120_001;
  assert.ok(validateEpisode(study, tooManyTokens).protocolViolations.includes('PROVIDER_INPUT_BUDGET'));
  const wrongChecks = episode(study); wrongChecks.evaluations[0].checks.pop();
  assert.throws(() => validateEpisode(study, wrongChecks), /NINE_CHECKS_REQUIRED/);
  const tooMuchReview = episode(study); tooMuchReview.human.activeIntervals = [{ startedAt: at(0), finishedAt: at(31), activity: 'Extended review' }]; tooMuchReview.finishedAt = at(40);
  assert.ok(validateEpisode(study, tooMuchReview).protocolViolations.includes('HUMAN_TIME_BUDGET'));
  const overlappingReview = episode(study); overlappingReview.human.activeIntervals.push({ startedAt: at(14), finishedAt: at(17), activity: 'Second review interval' });
  assert.throws(() => validateEpisode(study, overlappingReview), /HUMAN_INTERVAL_OVERLAP_OR_RANGE/);
  const noApproval = episode(study); noApproval.outcome = { status: 'VERIFIED_RELEASE', reason: 'Claimed release', sourceDigest: digest, publicationId: 'x', receiptDigest: digest, independentVerificationDigest: digest };
  assert.throws(() => validateEpisode(study, noApproval), /RELEASE_EVIDENCE_FIELDS/);
  const baselineOnly = episode(study); baselineOnly.evaluations.at(-1).stage = 'baseline'; baselineOnly.evaluations.at(-1).checks = CHECKS.map(name => ({ name, outcome: 'PASS' })); baselineOnly.human.decisions = [{ kind: 'approve', at: at(16), candidateDigest: digest }]; baselineOnly.outcome = { status: 'VERIFIED_RELEASE', reason: 'Claimed baseline release', sourceDigest: digest, publicationId: 'x', receiptDigest: digest, independentVerificationDigest: digest, publishedAt: at(17), verifiedAt: at(18) };
  assert.throws(() => validateEpisode(study, baselineOnly), /RELEASE_EVIDENCE_FIELDS/);
  const exactRepair = episode(study); exactRepair.attempts.push({ role: 'repair', grantedPath: 'reservations.ts', status: 'SUBMITTED', workBaseSourceDigest: digest, submissionDigest: otherDigest, startedAt: at(16), finishedAt: at(19), providerCalls: [] });
  assert.equal(validateEpisode(study, exactRepair).protocolViolations.length, 0);
  exactRepair.attempts[3].workBaseSourceDigest = otherDigest;
  assert.throws(() => validateEpisode(study, exactRepair), /REPAIR_NOT_BASED_ON_FAILED_COMBINATION/);
  const wrongPreviewCompiler = episode(study, 'confidence-interlinked'); wrongPreviewCompiler.advisories[0].status = 'FINDINGS'; wrongPreviewCompiler.advisories[0].resolvedCompilerDigest = otherDigest;
  assert.ok(validateEpisode(study, wrongPreviewCompiler).protocolViolations.includes('INTERLINKED_COMPILER_DRIFT:A'));
  const failedPreviewWithCompiler = episode(study, 'confidence-interlinked'); failedPreviewWithCompiler.advisories[0].status = 'UNAVAILABLE'; failedPreviewWithCompiler.advisories[0].resolvedCompilerDigest = digest;
  assert.deepEqual(validateEpisode(study, failedPreviewWithCompiler).protocolViolations, []);
});

test('missing provider usage is retained as inconclusive and a full matrix cannot omit failed arms', async () => {
  const { study } = await registration();
  const missingUsage = episode(study);
  Object.assign(missingUsage.attempts[0].providerCalls[0], { usageStatus: 'MISSING', inputTokens: null, cachedInputTokens: null, outputTokens: null, providerUsageDigest: null });
  missingUsage.outcome = { status: 'INCONCLUSIVE', reason: 'Provider response did not expose trustworthy usage.' };
  const row = validateEpisode(study, missingUsage);
  assert.equal(row.accounting.tokenAndCostCeilingsEnforced, false);
  assert.equal(row.accounting.estimatedModelCostMicroUsd, null);
  const notInconclusive = copy(missingUsage); notInconclusive.outcome.status = 'FAILED';
  assert.throws(() => validateEpisode(study, notInconclusive), /MISSING_USAGE_INCONCLUSIVE/);
  const partial = validateStudy(study, [missingUsage]);
  assert.equal(partial.recordedEpisodes, 1);
  assert.equal(partial.expectedEpisodes, 10);
  assert.equal(partial.completeRecordSet, false);
  assert.equal(partial.missing.length, 9);
  assert.equal(partial.protocolCompliant, null);
  assert.equal(partial.registrationAuthenticityVerified, false);
  assert.throws(() => validateStudy(study, [missingUsage, missingUsage]), /DUPLICATE_EPISODE_SLOT/);
  const tampered = copy(study); tampered.order[0].arms.reverse();
  assert.throws(() => validateStudy(tampered, []), /REGISTRATION_ORDER_MISMATCH/);
  const forgedSource = copy(study); forgedSource.plan.sourceManifestDigest = otherDigest; forgedSource.planDigest = recordDigest(forgedSource.plan);
  assert.throws(() => validateStudy(forgedSource, []), /BASELINE_COMMIT_SOURCE_MISMATCH/);
  const [firstArm, secondArm] = study.order[0].arms;
  const first = episode(study, firstArm), second = episode(study, secondArm);
  first.startedAt = at(1);
  const outOfOrder = validateStudy(study, [first, second]);
  assert.ok(outOfOrder.orderViolations.some(value => value.startsWith('REGISTERED_ORDER:')));
  assert.ok(outOfOrder.orderViolations.some(value => value.startsWith('EPISODE_OVERLAP:')));
  assert.equal(outOfOrder.structurallyWithinRegisteredLimits, false);
});

test('a complete correctly ordered matrix is structurally consistent but never an authenticated product result', async () => {
  const { study } = await registration();
  const slots = study.order.flatMap(row => row.arms.map(arm => ({ arm, replicate: row.replicate })));
  const episodes = slots.map(({ arm, replicate }, index) => moveTimes(episode(study, arm, replicate), index * 25_000));
  const result = validateStudy(study, episodes);
  assert.equal(result.completeRecordSet, true);
  assert.equal(result.structurallyWithinRegisteredLimits, true);
  assert.deepEqual(result.orderViolations, []);
  assert.equal(result.protocolCompliant, null);
  assert.equal(result.claimEligible, false);
});

test('CLI fingerprint and registration are usable without writing to the repository', async () => {
  const { plan, identity } = await registration();
  const directory = await mkdtemp(join(tmpdir(), 'confidence-ts-study-test-'));
  try {
    const planPath = join(directory, 'plan.json'); await writeFile(planPath, JSON.stringify(plan));
    const cli = join(here, 'comparison-study.mjs');
    const fingerprint = JSON.parse(execFileSync(process.execPath, [cli, 'fingerprint'], { encoding: 'utf8' }));
    assert.equal(fingerprint.sourceManifestDigest, identity.sourceManifestDigest);
    const registered = JSON.parse(execFileSync(process.execPath, [cli, 'register', planPath], { encoding: 'utf8' }));
    assert.equal(registered.planDigest, registerStudy(plan, identity).planDigest);
    const regPath = join(directory, 'registration.json'), episodesPath = join(directory, 'episodes.json');
    await writeFile(regPath, JSON.stringify(registered)); await writeFile(episodesPath, '[]');
    assert.throws(() => execFileSync(process.execPath, [cli, 'validate', regPath, episodesPath], { encoding: 'utf8' }), error => error.status === 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
