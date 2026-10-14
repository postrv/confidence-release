// SPDX-License-Identifier: Apache-2.0
// A continuation reconciles one observed effect; it never rewrites a missing CLI ACK.
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { matchRestorationAncestry, restorationDependencies, validateRestorationDependencies } from './deployment-restoration-state.ts';

export type Pin = { path: string; digest: string };
export type ContinuationPlan = {
  schemaVersion: 1; operation: 'CONTINUE_DEPLOYMENT'; sourceRoot: string;
  configDirectory: string; privateDirectory: string; accountId: string; workerNames: string[];
  original: Pin; pointer: Pin; release: Pin; readback: Pin;
  bundles: Record<string, string>;
  review: { reviewedBy: string; reviewedAt: string; validUntil: string;
    effectReview: 'OBSERVED_EXPECTED_EFFECT'; dataObligations: 'REVIEWED'; evidence: Pin[] };
};
export type ContinuationStage = { name: string; status: string; startedAt: string; completedAt?: string;
  exitCode?: number | null; stdoutDigest?: string; stderrDigest?: string; apiErrorCodes?: number[]; errorCategory?: string };
export type ContinuationJournal = { schemaVersion: 1; operation: 'DEPLOYMENT_CONTINUATION';
  status: 'STARTED' | 'UNKNOWN' | 'AWAITING_READBACK' | 'RECONCILED'; plan: Pin;
  originalDigest: string; releaseDigest: string; observedEffect: { stage: string; status: 'OBSERVED_EXPECTED_EFFECT'; readbackDigest: string };
  startedAt: string; completedAt?: string; finalizedAt?: string; finalReadback?: Pin;
  stages: ContinuationStage[]; reason?: string; implementationDigests: Record<string, string> };
export const deploymentRoles = ['authority', 'runner', 'evaluator', 'projector', 'app'] as const;
export const continuationReadbackChecks = ['generated-release', 'local-source-identity', 'selected-account', 'script-list-complete', 'account-route-inventory',
  ...deploymentRoles.flatMap(role => ['script-present', 'exposure', 'custom-domains', 'active-version', 'bindings', 'modules', 'stable-deployment'].map(check => `${role}-${check}`)),
  'runner-immutable-image', 'evaluator-immutable-image', 'local-namespace-separation', 'evaluator-image-shared-digest'];
export const sha256 = (bytes: string | Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export function requireCondition(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const timestamp = (value: unknown): number => typeof value === 'string' ? Date.parse(value) : NaN;
export async function readBounded(path: string, limit = 1024 * 1024): Promise<Buffer> {
  const info = await lstat(path); requireCondition(info.isFile() && info.size > 0 && info.size <= limit, 'CONTINUATION_INPUT_INVALID');
  const bytes = await readFile(path); requireCondition(bytes.length <= limit, 'CONTINUATION_INPUT_INVALID'); return bytes;
}
export async function pinnedJson(pin: Pin): Promise<any> {
  requireCondition(pin && isAbsolute(pin.path) && digestPattern.test(pin.digest), 'CONTINUATION_PIN_INVALID');
  const bytes = await readBounded(pin.path); requireCondition(sha256(bytes) === pin.digest, 'CONTINUATION_PIN_CHANGED');
  return JSON.parse(bytes.toString('utf8'));
}
export async function filePin(path: string): Promise<Pin> { return { path: resolve(path), digest: sha256(await readBounded(path)) }; }
export function continuationPath(original: string): string { return `${original}.continuation.json`; }

export function remainingStages(original: any): string[] {
  requireCondition(original?.schemaVersion === 1 && original.operation === 'DEPLOY' && original.initial === false
    && original.status === 'UNKNOWN' && original.secretAssociationsValidated === true && Array.isArray(original.stages), 'CONTINUATION_ORIGINAL_UNSUPPORTED');
  const names = ['projection-migration', ...deploymentRoles.map(role => `deploy-${role}`)];
  const packages = original.stages.slice(0, 5), remote = original.stages.slice(5);
  requireCondition(isDeepStrictEqual(packages.map((stage: any) => [stage.name, stage.status]), deploymentRoles.map(role => [`package-${role}`, 'LOCAL_PACKAGE_PASS']))
    && remote.length >= 2 && remote.length < names.length
    && isDeepStrictEqual(remote.map((stage: any) => stage.name), names.slice(0, remote.length))
    && remote.slice(0, -1).every((stage: any) => stage.status === 'ACKNOWLEDGED')
    && remote.at(-1).status === 'UNKNOWN'
    && Number.isFinite(timestamp(original.completedAt))
    && remote.every((stage: any) => Number.isFinite(timestamp(stage.startedAt)) && timestamp(stage.completedAt) >= timestamp(stage.startedAt))
    && timestamp(original.completedAt) >= timestamp(remote.at(-1).completedAt), 'CONTINUATION_STAGE_PREFIX_INVALID');
  return names.slice(remote.length);
}
function readbackMatches(readback: any, plan: ContinuationPlan, after: number, allowedBlocked: string[]): void {
  requireCondition(readback?.schemaVersion === 1 && readback.accountId === plan.accountId && readback.releaseDigest === plan.release.digest
    && readback.remoteMutations === 0 && timestamp(readback.startedAt) >= after && timestamp(readback.completedAt) >= timestamp(readback.startedAt)
    && ['READBACK_PASS', 'BLOCKED'].includes(readback.status)
    && Array.isArray(readback.workers) && isDeepStrictEqual(readback.workers.map((worker: any) => worker.name).sort(), [...plan.workerNames].sort())
    && Array.isArray(readback.checks) && isDeepStrictEqual(readback.checks.map((check: any) => check.name).sort(), [...continuationReadbackChecks].sort())
    && readback.checks.every((check: any) => check.status === 'PASS' || check.status === 'BLOCKED' && allowedBlocked.includes(check.name))
    && (readback.status === 'READBACK_PASS') === readback.checks.every((check: any) => check.status === 'PASS'), 'CONTINUATION_READBACK_INVALID');
}
function assetControlDigests(release: any, role: string): Record<string, string> {
  const inputs = release.sourceDigests;
  requireCondition(inputs && typeof inputs === 'object' && !Array.isArray(inputs), 'CONTINUATION_ASSET_CONTROL_MANIFEST');
  const expected: Record<string, string> = {};
  if (role === 'app') for (const name of ['_headers', '_redirects']) {
    const path = `apps/web/dist/${name}`;
    if (Object.hasOwn(inputs, path)) {
      requireCondition(typeof inputs[path] === 'string' && digestPattern.test(inputs[path]), 'CONTINUATION_ASSET_CONTROL_MANIFEST');
      expected[name] = inputs[path];
    }
  }
  return expected;
}
function readbackAssetControlsMatch(readback: any, release: any): void {
  for (const role of deploymentRoles) {
    const expected = assetControlDigests(release, role);
    const observed = readback.checks.find((check: any) => check.name === `${role}-modules`)?.detail?.assetControlDigests;
    requireCondition(observed === undefined && Object.keys(expected).length === 0 || isDeepStrictEqual(observed, expected), 'CONTINUATION_READBACK_ASSET_CONTROL_ASSOCIATION');
  }
}
/** Only immutable retained records are checked here, so later source changes do not rewrite history. */
export async function validateContinuationPlan(pin: Pin): Promise<{ plan: ContinuationPlan; original: any; release: any; remaining: string[] }> {
  const plan = await pinnedJson(pin) as ContinuationPlan;
  requireCondition(plan?.schemaVersion === 1 && plan.operation === 'CONTINUE_DEPLOYMENT'
    && [plan.sourceRoot, plan.configDirectory, plan.privateDirectory].every(path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path)
    && /^[a-f0-9]{32}$/.test(plan.accountId) && Array.isArray(plan.workerNames) && plan.workerNames.length === 5
    && new Set(plan.workerNames).size === 5 && plan.workerNames.every(name => typeof name === 'string' && /^[a-z0-9-]+$/.test(name)), 'CONTINUATION_PLAN_INVALID');
  requireCondition(plan.original?.path && dirname(plan.original.path) === plan.configDirectory
    && /^deployment-[0-9]+\.json$/.test(relative(plan.configDirectory, plan.original.path))
    && plan.pointer?.path === join(plan.privateDirectory, '.deployment-state.json')
    && plan.release?.path === join(plan.configDirectory, 'release.json')
    && dirname(plan.readback?.path ?? '') === plan.configDirectory, 'CONTINUATION_PATH_ASSOCIATION');
  const restored = await lstat(`${plan.original.path}.restoration.json`).then(() => true, error => {
    if (error.code === 'ENOENT') return false; throw error;
  });
  requireCondition(!restored, 'CONTINUATION_RESTORATION_CONFLICT');
  const original = await pinnedJson(plan.original), release = await pinnedJson(plan.release);
  const remaining = remainingStages(original);
  requireCondition(original.accountId === plan.accountId && isDeepStrictEqual(original.targetWorkerNames, plan.workerNames)
    && original.releaseDigest === plan.release.digest && release.schemaVersion === 1 && release.accountId === plan.accountId
    && isDeepStrictEqual(release.names, plan.workerNames), 'CONTINUATION_TARGET_MISMATCH');
  await validateRestorationDependencies(restorationDependencies(original.restorationDependencies), plan.accountId, plan.workerNames);
  const readback = await pinnedJson(plan.readback);
  readbackMatches(readback, plan, timestamp(original.completedAt), remaining.flatMap(stage => [`${stage.slice(7)}-bindings`, `${stage.slice(7)}-modules`]));
  const review = plan.review;
  requireCondition(review && typeof review.reviewedBy === 'string' && review.reviewedBy.trim().length > 0 && review.reviewedBy.length <= 128
    && review.effectReview === 'OBSERVED_EXPECTED_EFFECT' && review.dataObligations === 'REVIEWED'
    && timestamp(review.reviewedAt) >= timestamp(readback.completedAt) && timestamp(review.validUntil) > timestamp(review.reviewedAt)
    && timestamp(review.validUntil) - timestamp(review.reviewedAt) <= 3600000
    && Array.isArray(review.evidence) && review.evidence.length >= 1 && review.evidence.length <= 8, 'CONTINUATION_REVIEW_REQUIRED');
  for (const evidence of review.evidence) await pinnedJson(evidence);
  requireCondition(plan.bundles && typeof plan.bundles === 'object' && Object.keys(plan.bundles).length >= 5
    && Object.keys(plan.bundles).length <= 128 && Object.entries(plan.bundles).every(([path, digest]) => /^[a-zA-Z0-9_.\/-]+$/.test(path)
      && !path.split('/').includes('..') && !isAbsolute(path) && digestPattern.test(digest))
    && deploymentRoles.every(role => plan.bundles[`${role}/index.js`]), 'CONTINUATION_BUNDLE_MANIFEST');
  // Readback records the exact local modules it compared, even for a blocked
  // suffix. A new pin cannot silently substitute different retained packages.
  for (const role of deploymentRoles) {
    const modules = Object.fromEntries(Object.entries(plan.bundles).filter(([path]) => path.startsWith(role + '/') && /\.(js|wasm)$/.test(path))
      .map(([path, digest]) => [path.slice(role.length + 1), digest]));
    requireCondition(isDeepStrictEqual(readback.checks.find((check: any) => check.name === `${role}-modules`)?.detail?.moduleDigests, modules), 'CONTINUATION_READBACK_MODULE_ASSOCIATION');
  }
  for (const [path, hash] of Object.entries(plan.bundles).filter(([path]) => ['_headers', '_redirects'].includes(path.split('/').at(-1)!))) {
    const [role, name] = path.split('/');
    requireCondition(deploymentRoles.includes(role as typeof deploymentRoles[number]) && path === `${role}/${name}`
      && assetControlDigests(release, role!)[name!] === hash, 'CONTINUATION_BUNDLE_ASSET_CONTROL_ASSOCIATION');
  }
  readbackAssetControlsMatch(readback, release);
  return { plan, original, release, remaining };
}
async function filesUnder(root: string, directory: string, complete: boolean): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    if (!complete && entry.name.startsWith('.')) continue;
    const path = `${directory}/${entry.name}`;
    requireCondition(!entry.isSymbolicLink(), 'CONTINUATION_SOURCE_SYMLINK');
    if (entry.isDirectory()) paths.push(...await filesUnder(root, path, complete));
    else if (entry.isFile() && (complete || /\.(ts|js|mjs|wasm|css|html|jsonc|sql)$/.test(entry.name) || entry.name === 'Dockerfile')) paths.push(path);
    else requireCondition(!complete, 'CONTINUATION_SOURCE_NONREGULAR');
    requireCondition(paths.length <= 2048, 'CONTINUATION_SOURCE_LIMIT');
  }
  return paths;
}
/** Pin the old payload independently of the newer recovery executable. No old code is imported. */
export async function validateContinuationPayload(plan: ContinuationPlan, release: any): Promise<Record<string, any>> {
  const pointer = await pinnedJson(plan.pointer);
  requireCondition(pointer.schemaVersion === 1 && pointer.accountId === plan.accountId && isDeepStrictEqual(pointer.workerNames, plan.workerNames)
    && pointer.reportPath === plan.original.path, 'CONTINUATION_POINTER_MISMATCH');
  const original = await pinnedJson(plan.original);
  await validateRestorationDependencies(matchRestorationAncestry(pointer, original), plan.accountId, plan.workerNames);
  const inputs = release.sourceDigests;
  requireCondition(inputs && typeof inputs === 'object' && Object.keys(inputs).length > 0 && Object.keys(inputs).length <= 2048
    && ['package.json', 'package-lock.json', 'infra/deploy-pilot.ts', 'infra/deployment-recovery.ts', 'infra/release-inputs.ts', 'apps/web/dist/index.html'].every(path => inputs[path]), 'CONTINUATION_SOURCE_MANIFEST');
  for (const [path, digest] of Object.entries(inputs)) {
    requireCondition(/^[a-zA-Z0-9_.\/-]+$/.test(path) && !isAbsolute(path) && !path.split('/').includes('..') && digestPattern.test(String(digest)), 'CONTINUATION_SOURCE_PATH');
    requireCondition(sha256(await readBounded(join(plan.sourceRoot, path), 32 * 1024 * 1024)) === digest, 'CONTINUATION_SOURCE_CHANGED');
  }
  // Older retained releases predate project-model. If the new directory exists,
  // its complete source set must be pinned even when an input was omitted.
  const projectModelExists = await lstat(join(plan.sourceRoot, 'packages/project-model/src')).then(() => true, error => {
    if (error.code === 'ENOENT') return false; throw error;
  });
  const directories = ['workers', 'packages/protocol/src', 'packages/protocol/wasm', 'migrations', 'apps/web/dist'];
  if (projectModelExists || Object.keys(inputs).some(path => path.startsWith('packages/project-model/src/'))) directories.push('packages/project-model/src');
  for (const directory of directories) {
    const actual = await filesUnder(plan.sourceRoot, directory, directory === 'apps/web/dist');
    requireCondition(isDeepStrictEqual(actual.sort(), Object.keys(inputs).filter(path => path.startsWith(directory + '/')).sort()), 'CONTINUATION_SOURCE_SET_CHANGED');
  }
  const configs: Record<string, any> = {};
  for (const [index, role] of deploymentRoles.entries()) {
    const path = join(plan.configDirectory, `${role}.json`), config = await pinnedJson({ path, digest: release.configs?.[role] });
    requireCondition(config.account_id === plan.accountId && config.name === plan.workerNames[index]
      && config.main === join(plan.sourceRoot, `workers/${role}/index.ts`), 'CONTINUATION_CONFIG_ASSOCIATION');
    configs[role] = config;
  }
  const bundleFiles = await filesUnder(plan.configDirectory, 'bundles', true);
  requireCondition(isDeepStrictEqual(bundleFiles.map(path => path.slice(8)).sort(), Object.keys(plan.bundles).sort()), 'CONTINUATION_BUNDLE_SET_CHANGED');
  for (const [path, digest] of Object.entries(plan.bundles)) requireCondition(sha256(await readBounded(join(plan.configDirectory, 'bundles', path), 32 * 1024 * 1024)) === digest, 'CONTINUATION_BUNDLE_CHANGED');
  return configs;
}
export async function validateContinuationTerminal(originalPath: string, account: string, names: string[]): Promise<boolean> {
  try {
    const journal = JSON.parse((await readBounded(continuationPath(originalPath))).toString()) as ContinuationJournal;
    requireCondition(journal.schemaVersion === 1 && journal.operation === 'DEPLOYMENT_CONTINUATION' && journal.status === 'RECONCILED', 'CONTINUATION_NOT_FINAL');
    const { plan, original, remaining } = await validateContinuationPlan(journal.plan);
    validateJournal(journal, plan, original, remaining);
    requireCondition(plan.original.path === originalPath && plan.accountId === account && isDeepStrictEqual(plan.workerNames, names), 'CONTINUATION_TARGET_MISMATCH');
    await validateFinalReadback(journal, plan, remaining, journal.finalReadback!);
    requireCondition(timestamp(journal.finalizedAt) >= timestamp((await pinnedJson(journal.finalReadback!)).completedAt), 'CONTINUATION_FINAL_TIME');
    return true;
  } catch { return false; }
}
export function validateJournal(journal: ContinuationJournal, plan: ContinuationPlan, original: any, remaining: string[]): void {
  requireCondition(journal.schemaVersion === 1 && journal.operation === 'DEPLOYMENT_CONTINUATION'
    && journal.originalDigest === plan.original.digest && journal.releaseDigest === plan.release.digest
    && isDeepStrictEqual(journal.observedEffect, { stage: original.stages.at(-1).name, status: 'OBSERVED_EXPECTED_EFFECT', readbackDigest: plan.readback.digest })
    && timestamp(journal.startedAt) >= timestamp(plan.review.reviewedAt) && timestamp(journal.startedAt) <= timestamp(plan.review.validUntil)
    && Array.isArray(journal.stages) && journal.stages.length <= remaining.length
    && isDeepStrictEqual(journal.stages.map(stage => stage.name), remaining.slice(0, journal.stages.length))
    && journal.stages.every((stage, index) => timestamp(stage.startedAt) >= (index ? timestamp(journal.stages[index - 1]!.completedAt) : timestamp(journal.startedAt)))
    && journal.implementationDigests && Object.keys(journal.implementationDigests).length > 0
    && Object.values(journal.implementationDigests).every(digest => digestPattern.test(digest)), 'CONTINUATION_JOURNAL_INVALID');
}
export async function validateFinalReadback(journal: ContinuationJournal, plan: ContinuationPlan, remaining: string[], pin: Pin): Promise<void> {
  requireCondition(isDeepStrictEqual(journal.stages.map(stage => stage.name), remaining)
    && journal.stages.every(stage => stage.status === 'ACKNOWLEDGED' && stage.exitCode === 0 && !stage.errorCategory
      && digestPattern.test(stage.stdoutDigest ?? '') && digestPattern.test(stage.stderrDigest ?? '')
      && timestamp(stage.completedAt) >= timestamp(stage.startedAt))
    && timestamp(journal.completedAt) >= timestamp(journal.stages.at(-1)?.completedAt)
    && dirname(pin?.path ?? '') === plan.configDirectory, 'CONTINUATION_INCOMPLETE');
  const readback = await pinnedJson(pin);
  readbackMatches(readback, plan, timestamp(journal.completedAt), []);
  const initial = await pinnedJson(plan.readback);
  const release = await pinnedJson(plan.release);
  readbackAssetControlsMatch(initial, release);
  readbackAssetControlsMatch(readback, release);
  for (const role of deploymentRoles) requireCondition(isDeepStrictEqual(
    readback.checks.find((check: any) => check.name === `${role}-modules`)?.detail?.moduleDigests,
    initial.checks.find((check: any) => check.name === `${role}-modules`)?.detail?.moduleDigests), 'CONTINUATION_FINAL_MODULE_ASSOCIATION');
}
