// SPDX-License-Identifier: Apache-2.0
// Preregistration and structural accounting for the TypeScript study. This
// script never upgrades a local fixture result into protected release evidence.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
export const SOURCE_FILES = Object.freeze(['app.ts', 'cache.ts', 'domain.ts', 'presentation.ts', 'reservations.ts', 'validation.ts']);
export const AUTHORING_CONFIG_FILES = Object.freeze(['package.json', 'tsconfig.json']);
export const ARMS = Object.freeze(['ordinary-branches-ci', 'confidence-core', 'confidence-narsil', 'confidence-interlinked', 'confidence-both']);
export const CHECKS = Object.freeze([
  'typed-availability-api', 'unchanged-read-benefit', 'acknowledged-reservation-freshness',
  'post-write-unchanged-read-benefit', 'idempotent-reservation', 'conflicting-idempotency-key',
  'bounded-input-and-capacity', 'accessible-live-status', 'health-route',
]);
const GRANTS = Object.freeze({ A: 'cache.ts', B: 'reservations.ts', C: 'presentation.ts', repair: 'reservations.ts' });
const HEX_SHA = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.trim().length > 0 && !/REPLACE_ME|TODO|PLACEHOLDER/i.test(value);
const date = value => typeof value === 'string' && TIME.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value;
function fail(message) { throw new Error(message); }
function requireField(condition, code) { if (!condition) fail(code); }

// Stable JSON is used only to bind this study's own records, never as a
// substitute for the project's source-manifest or receipt canonicalization.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) return JSON.stringify(value);
  fail('UNSUPPORTED_CANONICAL_VALUE');
}
export const recordDigest = value => sha(canonical(value));

export async function localProfileIdentity() {
  const entries = [];
  for (const path of SOURCE_FILES) {
    const bytes = await readFile(join(here, 'fixture', path));
    entries.push({ path, digest: sha(bytes), bytes: bytes.length });
  }
  const authoringConfigEntries = [];
  for (const path of AUTHORING_CONFIG_FILES) {
    const bytes = await readFile(join(here, 'fixture', path));
    authoringConfigEntries.push({ path, digest: sha(bytes), bytes: bytes.length });
  }
  const checker = await readFile(join(here, 'check.ts'));
  const child = await readFile(join(here, 'acceptance-child.mjs'));
  const sourceProfile = await readFile(join(root, 'packages/protocol/src/typescript-workload-profile.ts'));
  return {
    profile: 'typescript-seat-inventory-v1',
    sourceManifestDigest: sha(JSON.stringify(entries)),
    sourceEntries: entries,
    authoringConfigDigest: sha(JSON.stringify(authoringConfigEntries)),
    authoringConfigEntries,
    localOracleSourceDigest: recordDigest({ check: sha(checker), acceptanceChild: sha(child), sourceProfile: sha(sourceProfile) }),
    evidenceClass: 'LOCAL_FIXTURE_ONLY',
  };
}

function gitBytes(commit, path) {
  try { return execFileSync('git', ['show', `${commit}:${path}`], { cwd: root, maxBuffer: 2 * 1024 * 1024 }); }
  catch { fail(`BASELINE_COMMIT_FILE_UNAVAILABLE:${path}`); }
}

function verifyCommitMatchesProfile(commit, identity) {
  const entries = SOURCE_FILES.map(path => {
    const bytes = gitBytes(commit, `experiments/typescript-workload/fixture/${path}`);
    return { path, digest: sha(bytes), bytes: bytes.length };
  });
  requireField(sha(JSON.stringify(entries)) === identity.sourceManifestDigest, 'BASELINE_COMMIT_SOURCE_MISMATCH');
  const authoringConfigEntries = AUTHORING_CONFIG_FILES.map(path => {
    const bytes = gitBytes(commit, `experiments/typescript-workload/fixture/${path}`);
    return { path, digest: sha(bytes), bytes: bytes.length };
  });
  requireField(sha(JSON.stringify(authoringConfigEntries)) === identity.authoringConfigDigest, 'BASELINE_COMMIT_AUTHORING_CONFIG_MISMATCH');
  const oracle = recordDigest({
    check: sha(gitBytes(commit, 'experiments/typescript-workload/check.ts')),
    acceptanceChild: sha(gitBytes(commit, 'experiments/typescript-workload/acceptance-child.mjs')),
    sourceProfile: sha(gitBytes(commit, 'packages/protocol/src/typescript-workload-profile.ts')),
  });
  requireField(oracle === identity.localOracleSourceDigest, 'BASELINE_COMMIT_ORACLE_MISMATCH');
}

function validatePlan(plan, identity) {
  requireField(plain(plan) && plan.schemaVersion === 1, 'PLAN_SCHEMA');
  requireField(text(plan.studyId) && /^[a-z0-9][a-z0-9-]{3,63}$/.test(plan.studyId), 'STUDY_ID');
  requireField(COMMIT.test(plan.baselineCommit), 'BASELINE_COMMIT');
  requireField(plan.sourceManifestDigest === identity.sourceManifestDigest, 'SOURCE_MANIFEST_MISMATCH');
  requireField(plan.authoringConfigDigest === identity.authoringConfigDigest, 'AUTHORING_CONFIG_MISMATCH');
  requireField(plan.localOracleSourceDigest === identity.localOracleSourceDigest, 'LOCAL_ORACLE_MISMATCH');
  requireField(plain(plan.goals) && Object.keys(plan.goals).sort().join(',') === 'A,B,C,repair', 'GOALS');
  for (const [role, path] of Object.entries(GRANTS)) {
    requireField(plain(plan.goals[role]) && plan.goals[role].path === path && text(plan.goals[role].text), `GOAL_${role}`);
  }
  requireField(plain(plan.model) && text(plan.model.provider) && text(plan.model.name) && text(plan.model.revision) && text(plan.model.endpoint) && HEX_SHA.test(plan.model.generationSettingsDigest), 'MODEL_IDENTITY');
  let endpoint;
  try { endpoint = new URL(plan.model.endpoint); } catch { fail('MODEL_ENDPOINT'); }
  requireField(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'MODEL_ENDPOINT');
  requireField(plain(plan.prompts) && HEX_SHA.test(plan.prompts.publicPromptDigest) && HEX_SHA.test(plan.prompts.platformPolicyDigest) && plain(plan.prompts.assignmentPacketDigests) && Object.keys(plan.prompts.assignmentPacketDigests).sort().join(',') === 'A,B,C,repair' && Object.values(plan.prompts.assignmentPacketDigests).every(value => HEX_SHA.test(value)), 'PROMPT_DIGESTS');
  requireField(plain(plan.compiler) && HEX_SHA.test(plan.compiler.packageDigest) && text(plan.compiler.version), 'COMPILER_IDENTITY');
  requireField(plain(plan.evaluator) && HEX_SHA.test(plan.evaluator.imageDigest) && HEX_SHA.test(plan.evaluator.checkerDigest) && positive(plan.evaluator.slots), 'EVALUATOR_IDENTITY');
  requireField(plain(plan.integrations) && plain(plan.integrations.narsil) && plain(plan.integrations.interlinked), 'INTEGRATION_IDENTITY');
  for (const name of ['narsil', 'interlinked']) requireField(text(plan.integrations[name].version) && HEX_SHA.test(plan.integrations[name].digest) && HEX_SHA.test(plan.integrations[name].invocationConfigDigest), `INTEGRATION_${name.toUpperCase()}`);
  requireField(plan.integrations.interlinked.compilerPackageDigest === plan.compiler.packageDigest, 'INTERLINKED_COMPILER_MISMATCH');
  requireField(plain(plan.prices) && positive(plan.prices.inputMicroUsdPerMillionTokens) && nonnegative(plan.prices.cachedInputMicroUsdPerMillionTokens) && positive(plan.prices.outputMicroUsdPerMillionTokens), 'PRICE_SNAPSHOT');
  requireField(text(plan.prices.source) && date(plan.prices.observedAt), 'PRICE_PROVENANCE');
  requireField(HEX_SHA.test(plan.reviewRubricDigest), 'REVIEW_RUBRIC_DIGEST');
  const b = plan.budgets;
  requireField(plain(b) && ['providerCalls', 'inputTokens', 'outputTokens', 'outputTokensPerCall', 'modelCostMicroUsd', 'episodeWallMs', 'reviewerActiveMs'].every(key => positive(b[key])), 'BUDGETS');
  requireField(b.outputTokensPerCall <= b.outputTokens && b.outputTokensPerCall <= 32_768 && b.providerCalls <= 128 && b.inputTokens <= 10_000_000 && b.outputTokens <= 1_000_000 && b.modelCostMicroUsd <= 100_000_000 && b.episodeWallMs <= 86_400_000 && b.reviewerActiveMs <= b.episodeWallMs, 'BUDGET_LIMITS');
  requireField(positive(plan.repetitions) && plan.repetitions <= 20 && /^[0-9a-f]{64}$/.test(plan.randomizationSeed), 'REPETITIONS_OR_SEED');
  requireField(text(plan.reviewerPseudonym) && positive(plan.authoringCapacity) && plan.authoringCapacity === 3, 'REVIEWER_OR_CAPACITY');
  requireField(plan.arms === undefined || (Array.isArray(plan.arms) && canonical(plan.arms) === canonical(ARMS)), 'ARMS_MISMATCH');
  verifyCommitMatchesProfile(plan.baselineCommit, identity);
}

function orderFor(seed, replicate) {
  const order = [...ARMS];
  for (let i = order.length - 1; i > 0; i--) {
    const random = createHash('sha256').update(`${seed}:${replicate}:${i}`).digest().readUInt32BE(0);
    const j = random % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export function registerStudy(plan, identity) {
  validatePlan(plan, identity);
  const frozenPlan = structuredClone(plan);
  delete frozenPlan.arms;
  const digest = recordDigest(frozenPlan);
  return {
    schemaVersion: 1,
    recordType: 'typescript-equal-budget-preregistration',
    status: 'PREREGISTERED_LOCAL_PROFILE_ONLY',
    planDigest: digest,
    plan: frozenPlan,
    order: Array.from({ length: plan.repetitions }, (_, index) => ({ replicate: index + 1, arms: orderFor(plan.randomizationSeed, index + 1) })),
    requiredExternalGate: 'Production TypeScript authoring, protected acceptance, human review, live Artifacts publication and independent receipt verification must be demonstrated before outcome claims.',
  };
}

function validateChecks(checks) {
  requireField(Array.isArray(checks) && checks.length === CHECKS.length, 'NINE_CHECKS_REQUIRED');
  const names = new Set();
  for (const row of checks) {
    requireField(plain(row) && CHECKS.includes(row.name) && ['PASS', 'FAIL', 'ERROR'].includes(row.outcome) && !names.has(row.name), 'CHECK_VECTOR_INVALID');
    names.add(row.name);
  }
}

function pricedCost(calls, prices) {
  let sum = 0n;
  for (const call of calls) {
    const ordinary = BigInt(call.inputTokens - call.cachedInputTokens) * BigInt(prices.inputMicroUsdPerMillionTokens);
    const cached = BigInt(call.cachedInputTokens) * BigInt(prices.cachedInputMicroUsdPerMillionTokens);
    const output = BigInt(call.outputTokens) * BigInt(prices.outputMicroUsdPerMillionTokens);
    // Round each call up so a ceiling cannot be exceeded through many tiny
    // calls whose fractional estimated charges would otherwise disappear.
    sum += (ordinary + cached + output + 999999n) / 1000000n;
  }
  requireField(sum <= BigInt(Number.MAX_SAFE_INTEGER), 'COST_OVERFLOW');
  return Number(sum);
}

function validateRegistration(registration) {
  requireField(plain(registration) && registration.schemaVersion === 1 && registration.recordType === 'typescript-equal-budget-preregistration' && registration.status === 'PREREGISTERED_LOCAL_PROFILE_ONLY' && registration.planDigest === recordDigest(registration.plan), 'REGISTRATION_INVALID');
  const p = registration.plan;
  // Recheck the pinned Git tree, not a mutable checkout. The plan digest is
  // self-issued, so this is structural validation, not authentication of when
  // the registration was frozen or which prompts were actually sent.
  validatePlan(p, { sourceManifestDigest: p.sourceManifestDigest, authoringConfigDigest: p.authoringConfigDigest, localOracleSourceDigest: p.localOracleSourceDigest });
  requireField(positive(p.repetitions) && p.repetitions <= 20 && /^[0-9a-f]{64}$/.test(p.randomizationSeed), 'REGISTRATION_SCHEDULE');
  const expected = Array.from({ length: p.repetitions }, (_, index) => ({ replicate: index + 1, arms: orderFor(p.randomizationSeed, index + 1) }));
  requireField(canonical(registration.order) === canonical(expected), 'REGISTRATION_ORDER_MISMATCH');
}

export function validateEpisode(registration, episode) {
  validateRegistration(registration);
  const p = registration.plan, b = p.budgets;
  requireField(plain(episode) && episode.schemaVersion === 1 && episode.registrationDigest === registration.planDigest, 'EPISODE_REGISTRATION');
  requireField(ARMS.includes(episode.arm) && positive(episode.replicate) && episode.replicate <= p.repetitions, 'EPISODE_SLOT');
  requireField(episode.baselineCommit === p.baselineCommit && episode.sourceManifestDigest === p.sourceManifestDigest && episode.authoringConfigDigest === p.authoringConfigDigest, 'EPISODE_SOURCE_MISMATCH');
  requireField(canonical(episode.model) === canonical(p.model), 'EPISODE_MODEL_MISMATCH');
  requireField(episode.promptSetDigest === recordDigest(p.prompts), 'EPISODE_PROMPT_MISMATCH');
  requireField(episode.compilerDigest === p.compiler.packageDigest && episode.checkerDigest === p.evaluator.checkerDigest && episode.evaluatorImageDigest === p.evaluator.imageDigest, 'EPISODE_CHECKER_MISMATCH');
  const expectedIntegrations = { narsil: ['confidence-narsil', 'confidence-both'].includes(episode.arm), interlinked: ['confidence-interlinked', 'confidence-both'].includes(episode.arm) };
  requireField(canonical(episode.integrations) === canonical(expectedIntegrations), 'EPISODE_INTEGRATION_ARM_MISMATCH');
  requireField(date(episode.startedAt) && date(episode.finishedAt), 'EPISODE_TIME');
  const start = Date.parse(episode.startedAt), finish = Date.parse(episode.finishedAt);
  requireField(finish >= start, 'EPISODE_TIME_REVERSED');
  const protocolViolations = [];
  if (finish - start > b.episodeWallMs) protocolViolations.push('EPISODE_WALL_BUDGET');
  requireField(Array.isArray(episode.attempts) && episode.attempts.length >= 3 && episode.attempts.length <= 4, 'ATTEMPT_COUNT');
  const roles = episode.attempts.map(row => row.role);
  requireField(roles.slice(0, 3).join(',') === 'A,B,C' && (roles.length === 3 || roles[3] === 'repair'), 'ATTEMPT_ROLES');
  const callIds = new Set();
  let missingUsage = false;
  for (const attempt of episode.attempts) {
    requireField(attempt.grantedPath === GRANTS[attempt.role] && date(attempt.startedAt) && date(attempt.finishedAt), 'ATTEMPT_GRANT_OR_TIME');
    requireField(Date.parse(attempt.startedAt) >= start && Date.parse(attempt.finishedAt) <= finish && Date.parse(attempt.finishedAt) >= Date.parse(attempt.startedAt), 'ATTEMPT_OUTSIDE_EPISODE');
    requireField(['SUBMITTED', 'NO_SUBMISSION', 'STOPPED', 'TIMEOUT'].includes(attempt.status) && HEX_SHA.test(attempt.workBaseSourceDigest), 'ATTEMPT_STATUS_OR_BASE');
    requireField(attempt.role === 'repair' || attempt.workBaseSourceDigest === p.sourceManifestDigest, 'INITIAL_ATTEMPT_BASE_MISMATCH');
    requireField(attempt.status === 'SUBMITTED' ? HEX_SHA.test(attempt.submissionDigest) : attempt.submissionDigest === null, 'ATTEMPT_SUBMISSION_DIGEST');
    requireField(Array.isArray(attempt.providerCalls), 'ATTEMPT_CALLS');
    for (const call of attempt.providerCalls) {
      requireField(text(call.id) && !callIds.has(call.id) && ['OBSERVED', 'MISSING'].includes(call.usageStatus), 'CALL_ID_OR_USAGE_STATUS');
      if (call.usageStatus === 'OBSERVED') {
        requireField(nonnegative(call.inputTokens) && nonnegative(call.cachedInputTokens) && nonnegative(call.outputTokens) && call.cachedInputTokens <= call.inputTokens && HEX_SHA.test(call.providerUsageDigest), 'CALL_USAGE');
        if (call.outputTokens > b.outputTokensPerCall) protocolViolations.push(`PER_CALL_OUTPUT_BUDGET:${call.id}`);
      }
      else {
        requireField(call.inputTokens === null && call.cachedInputTokens === null && call.outputTokens === null && call.providerUsageDigest === null, 'MISSING_USAGE_MUST_BE_NULL');
        missingUsage = true;
      }
      callIds.add(call.id);
    }
  }
  const calls = episode.attempts.flatMap(row => row.providerCalls);
  if (calls.length > b.providerCalls) protocolViolations.push('PROVIDER_CALL_BUDGET');
  const inputTokens = missingUsage ? null : calls.reduce((sum, row) => sum + row.inputTokens, 0);
  const outputTokens = missingUsage ? null : calls.reduce((sum, row) => sum + row.outputTokens, 0);
  const estimatedModelCostMicroUsd = missingUsage ? null : pricedCost(calls, p.prices);
  if (!missingUsage) {
    if (inputTokens > b.inputTokens) protocolViolations.push('PROVIDER_INPUT_BUDGET');
    if (outputTokens > b.outputTokens) protocolViolations.push('PROVIDER_OUTPUT_BUDGET');
    if (estimatedModelCostMicroUsd > b.modelCostMicroUsd) protocolViolations.push('MODEL_COST_BUDGET');
  }
  requireField(Array.isArray(episode.advisories), 'ADVISORY_RECORDS');
  const expectedAdvisories = episode.attempts.flatMap(attempt => Object.entries(expectedIntegrations).filter(([, enabled]) => enabled).map(([tool]) => `${attempt.role}:${tool}`)).sort();
  const seenAdvisories = new Set();
  let advisoryElapsedMs = 0, advisoryBytesToModel = 0;
  for (const observation of episode.advisories) {
    const key = `${observation.attemptRole}:${observation.tool}`;
    requireField(expectedAdvisories.includes(key) && !seenAdvisories.has(key), 'ADVISORY_ARM_OR_DUPLICATE');
    requireField(['READY', 'FINDINGS', 'NO_BLOCKING_FINDINGS', 'UNAVAILABLE', 'ERROR', 'SKIPPED'].includes(observation.status) && nonnegative(observation.elapsedMs) && nonnegative(observation.bytesToModel) && observation.identityDigest === p.integrations[observation.tool].digest && observation.invocationConfigDigest === p.integrations[observation.tool].invocationConfigDigest, 'ADVISORY_OBSERVATION');
    if (observation.tool === 'interlinked') {
      const ranPreview = ['READY', 'FINDINGS', 'NO_BLOCKING_FINDINGS'].includes(observation.status);
      requireField(observation.resolvedCompilerDigest === null || HEX_SHA.test(observation.resolvedCompilerDigest), 'ADVISORY_COMPILER_DIGEST');
      if (observation.status === 'SKIPPED') requireField(observation.resolvedCompilerDigest === null, 'SKIPPED_ADVISORY_HAS_COMPILER');
      if (ranPreview && observation.resolvedCompilerDigest === null) protocolViolations.push(`INTERLINKED_COMPILER_UNOBSERVED:${observation.attemptRole}`);
      if (observation.resolvedCompilerDigest !== null && observation.resolvedCompilerDigest !== p.compiler.packageDigest) protocolViolations.push(`INTERLINKED_COMPILER_DRIFT:${observation.attemptRole}`);
    }
    seenAdvisories.add(key); advisoryElapsedMs += observation.elapsedMs; advisoryBytesToModel += observation.bytesToModel;
  }
  requireField(canonical([...seenAdvisories].sort()) === canonical(expectedAdvisories), 'ADVISORY_COVERAGE');
  requireField(plain(episode.human) && episode.human.reviewerPseudonym === p.reviewerPseudonym && Array.isArray(episode.human.activeIntervals) && Array.isArray(episode.human.decisions), 'HUMAN_EFFORT');
  requireField(nonnegative(episode.human.comprehensionErrors) && nonnegative(episode.human.repeatRequests) && nonnegative(episode.human.repeatedWorkMs), 'HUMAN_COUNTS');
  let reviewerActiveMs = 0, previousEnd = start;
  for (const interval of episode.human.activeIntervals) {
    requireField(date(interval.startedAt) && date(interval.finishedAt) && text(interval.activity), 'HUMAN_INTERVAL');
    const from = Date.parse(interval.startedAt), to = Date.parse(interval.finishedAt);
    requireField(from >= previousEnd && to >= from && to <= finish, 'HUMAN_INTERVAL_OVERLAP_OR_RANGE');
    reviewerActiveMs += to - from;
    previousEnd = to;
  }
  if (reviewerActiveMs > b.reviewerActiveMs) protocolViolations.push('HUMAN_TIME_BUDGET');
  requireField(episode.human.repeatedWorkMs <= reviewerActiveMs, 'REPEATED_WORK_EXCEEDS_ACTIVE_REVIEW');
  requireField(episode.human.answerSheetDigest === null || HEX_SHA.test(episode.human.answerSheetDigest), 'ANSWER_SHEET_DIGEST');
  if (episode.human.decisions.length > 0) requireField(HEX_SHA.test(episode.human.answerSheetDigest), 'ANSWER_SHEET_REQUIRED_FOR_DECISION');
  for (const decision of episode.human.decisions) requireField(['approve', 'reject', 'abstain'].includes(decision.kind) && date(decision.at) && Date.parse(decision.at) >= start && Date.parse(decision.at) <= finish && HEX_SHA.test(decision.candidateDigest), 'HUMAN_DECISION');
  requireField(Array.isArray(episode.evaluations), 'EVALUATIONS');
  for (const evaluation of episode.evaluations) {
    requireField(['baseline', 'A', 'B', 'C', 'combined', 'repair'].includes(evaluation.stage) && HEX_SHA.test(evaluation.sourceDigest) && HEX_SHA.test(evaluation.evidenceDigest) && date(evaluation.evaluatedAt) && Date.parse(evaluation.evaluatedAt) >= start && Date.parse(evaluation.evaluatedAt) <= finish, 'EVALUATION_IDENTITY');
    validateChecks(evaluation.checks);
  }
  for (const combined of episode.evaluations.filter(row => row.stage === 'combined')) {
    requireField(episode.attempts.slice(0, 3).every(row => row.status === 'SUBMITTED'), 'COMBINED_WITHOUT_THREE_SUBMISSIONS');
    for (const role of ['A', 'B', 'C']) requireField(episode.evaluations.some(row => row.stage === role && Date.parse(row.evaluatedAt) <= Date.parse(combined.evaluatedAt)), `COMBINED_WITHOUT_${role}_EVALUATION`);
  }
  const repair = episode.attempts.find(row => row.role === 'repair');
  if (repair) requireField(episode.evaluations.some(row => row.stage === 'combined' && row.sourceDigest === repair.workBaseSourceDigest && row.checks.some(check => check.outcome !== 'PASS') && Date.parse(row.evaluatedAt) <= Date.parse(repair.startedAt)), 'REPAIR_NOT_BASED_ON_FAILED_COMBINATION');
  requireField(plain(episode.outcome) && ['VERIFIED_RELEASE', 'FAILED', 'CENSORED', 'INCONCLUSIVE'].includes(episode.outcome.status) && text(episode.outcome.reason), 'OUTCOME');
  if (missingUsage) requireField(episode.outcome.status === 'INCONCLUSIVE', 'MISSING_USAGE_INCONCLUSIVE');
  if (episode.outcome.status === 'VERIFIED_RELEASE') {
    const passing = episode.evaluations.filter(row => ['combined', 'repair'].includes(row.stage) && row.sourceDigest === episode.outcome.sourceDigest && row.checks.every(check => check.outcome === 'PASS'));
    const approval = episode.human.decisions.filter(row => row.kind === 'approve' && row.candidateDigest === episode.outcome.sourceDigest);
    requireField(passing.length > 0 && approval.length > 0 && HEX_SHA.test(episode.outcome.sourceDigest) && text(episode.outcome.publicationId) && HEX_SHA.test(episode.outcome.receiptDigest) && HEX_SHA.test(episode.outcome.independentVerificationDigest) && date(episode.outcome.publishedAt) && date(episode.outcome.verifiedAt), 'RELEASE_EVIDENCE_FIELDS');
    requireField(passing.some(row => approval.some(decision => Date.parse(row.evaluatedAt) <= Date.parse(decision.at) && Date.parse(decision.at) <= Date.parse(episode.outcome.publishedAt))) && Date.parse(episode.outcome.publishedAt) <= Date.parse(episode.outcome.verifiedAt) && Date.parse(episode.outcome.verifiedAt) <= finish, 'RELEASE_ORDER');
  }
  return {
    slot: `${episode.replicate}:${episode.arm}`,
    accounting: { providerCalls: calls.length, inputTokens, outputTokens, estimatedModelCostMicroUsd, tokenAndCostCeilingsEnforced: !missingUsage, advisoryElapsedMs, advisoryBytesToModel, episodeWallMs: finish - start, reviewerActiveMs, reviewerDecisions: episode.human.decisions.length, comprehensionErrors: episode.human.comprehensionErrors, repeatRequests: episode.human.repeatRequests, repeatedWorkMs: episode.human.repeatedWorkMs },
    protocolViolations,
    reportedOutcome: episode.outcome.status,
    evidenceClass: 'STRUCTURAL_RECORD_ONLY',
    claimEligible: false,
    externalVerificationRequired: 'Verify provider usage, protected checks, human approval, publication and receipt against independent authoritative records.',
  };
}

export function validateStudy(registration, episodes) {
  validateRegistration(registration);
  requireField(Array.isArray(episodes), 'EPISODES_ARRAY');
  const seen = new Set(), records = [];
  for (const episode of episodes) {
    const row = validateEpisode(registration, episode);
    requireField(!seen.has(row.slot), 'DUPLICATE_EPISODE_SLOT');
    seen.add(row.slot); records.push(row);
  }
  const missing = registration.order.flatMap(row => row.arms.map(arm => `${row.replicate}:${arm}`)).filter(slot => !seen.has(slot));
  const expectedOrder = registration.order.flatMap(row => row.arms.map(arm => `${row.replicate}:${arm}`));
  const positions = new Map(expectedOrder.map((slot, index) => [slot, index]));
  const chronological = [...episodes].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const orderViolations = [];
  let lastPosition = -1, previousEnd = -Infinity;
  for (const episode of chronological) {
    const slot = `${episode.replicate}:${episode.arm}`;
    const position = positions.get(slot);
    if (position <= lastPosition) orderViolations.push(`REGISTERED_ORDER:${slot}`);
    if (Date.parse(episode.startedAt) < previousEnd) orderViolations.push(`EPISODE_OVERLAP:${slot}`);
    lastPosition = position;
    previousEnd = Date.parse(episode.finishedAt);
  }
  const structurallyWithinRegisteredLimits = missing.length === 0 && orderViolations.length === 0 && records.every(row => row.protocolViolations.length === 0 && row.accounting.tokenAndCostCeilingsEnforced);
  return { schemaVersion: 1, evidenceClass: 'STRUCTURAL_RECORD_ONLY', claimEligible: false, protocolCompliant: null, registrationAuthenticityVerified: false, expectedEpisodes: registration.plan.repetitions * ARMS.length, recordedEpisodes: records.length, missing, completeRecordSet: missing.length === 0, orderViolations, structurallyWithinRegisteredLimits, records };
}

async function main() {
  const [command, path, additional] = process.argv.slice(2);
  if (command === 'fingerprint' && !path) {
    process.stdout.write(JSON.stringify(await localProfileIdentity(), null, 2) + '\n'); return;
  }
  if (command === 'register' && path && !additional) {
    const plan = JSON.parse(await readFile(resolve(path), 'utf8'));
    process.stdout.write(JSON.stringify(registerStudy(plan, await localProfileIdentity()), null, 2) + '\n'); return;
  }
  if (command === 'validate' && path && additional) {
    const registration = JSON.parse(await readFile(resolve(path), 'utf8'));
    const episodes = JSON.parse(await readFile(resolve(additional), 'utf8'));
    const result = validateStudy(registration, episodes);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.completeRecordSet) process.exitCode = 2;
    return;
  }
  fail('USAGE: comparison-study.mjs fingerprint | register PLAN.json | validate REGISTRATION.json EPISODES.json');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
