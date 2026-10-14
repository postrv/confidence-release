// SPDX-License-Identifier: Apache-2.0
// Local evidence validation only. Restoration resolves current obligations,
// never the historical UNKNOWN effect or the success of the failed release.
import { lstat, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { continuationPath, continuationReadbackChecks, deploymentRoles, pinnedJson,
  readBounded, remainingStages, requireCondition, sha256, type Pin } from './deployment-continuation-state.ts';

type Scope = { accountId: string; workerNames: string[] };
type ProjectScope = { tenantId: string; projectId: string; incarnation: string };
export type RestorationRecord = Scope & {
  schemaVersion: 1; operation: 'RESTORATION_RECORD'; disposition: 'RESTORED_BASELINE';
  originalDigest: string; failedReleaseDigest: string; restoredReleaseDigest: string;
  startedAt: string; completedAt: string; evidence: Pin[];
};
export type RestorationObligations = Scope & {
  schemaVersion: 1; operation: 'RESTORATION_OBLIGATION_REVIEW';
  originalDigest: string; restoredReleaseDigest: string;
  runtime: { observedAt: string; project: ProjectScope; revision: string;
    publicationAdmission: 'CLOSED'; unresolvedPublications: 0; pendingOutbox: 0; pendingCleanup: 0;
    queuedEvaluations: 0; activeEvaluations: 0; reservedBudget: 0; currentExecutionObligations: 'RESOLVED'; evidence: Pin[] };
  resources: { observedAt: string; activeCurrentExecutions: 0; unknownCurrentExecutions: 0;
    unresolvedCleanup: string[]; disposition: 'CURRENT_RESOURCE_OBLIGATIONS_RESOLVED'; evidence: Pin[] };
  data: { observedAt: string; projectionMigration: 'ACKNOWLEDGED_COMPATIBLE';
    durableObjectSchema: 'RESTORED_CODE_COMPATIBLE'; authorization: 'RESTORED_POLICY_COMPATIBLE';
    historicalReceipts: 'PRESERVED'; applicationWrites: 'RECONCILED_WITH_RESTORED_BASELINE';
    automaticRollback: 'NOT_PERFORMED'; unresolved: string[]; evidence: Pin[] };
  migrationInventory: 'SEPARATE_PRE_ENABLE_REVIEW_REQUIRED';
};
export const restorationClaim = {
  currentBaseline: 'RESTORED_BASELINE', currentObligations: 'RESOLVED',
  historicalFailedStageEffects: 'UNKNOWN_RETAINED', failedReleaseSucceeded: false,
  historicalTransientEffectsAbsent: false, collaborationEnableAuthorized: false,
} as const;
export type RestorationPlan = Scope & {
  schemaVersion: 1; operation: 'RECONCILE_RESTORED_BASELINE';
  project: ProjectScope;
  configDirectory: string; restoredDirectory: string; privateDirectory: string; evidenceDirectory: string;
  original: Pin; pointer: Pin; pointerSnapshot: Pin; failedRelease: Pin; restoredRelease: Pin;
  readback: Pin; restoration: Pin; obligations: Pin;
  bundles: Record<string, string>;
  review: { reviewedBy: string; reviewedAt: string; validUntil: string;
    disposition: 'RESTORED_BASELINE_CURRENT_OBLIGATIONS_RESOLVED'; residualUncertainty: typeof restorationClaim };
};
export type RestorationTerminal = Scope & {
  schemaVersion: 1; operation: 'DEPLOYMENT_RESTORATION'; status: 'RESTORED_BASELINE_RECONCILED';
  plan: Pin; originalDigest: string; failedReleaseDigest: string; restoredReleaseDigest: string;
  finalizedAt: string; claim: typeof restorationClaim; remoteMutations: 0; credentialsLoaded: false;
};
export type RestorationAdmission = { priorPointer: Pin; restorationDependencies: Pin[] };
export type RestorationPointer = Scope & { schemaVersion: 1; reportPath: string; restorationDependencies?: Pin[] };
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const versionPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const restorationFreshnessMs = 15 * 60 * 1000;
export const maxRestorationDependencies = 16;
const time = (value: unknown): number => typeof value === 'string' ? Date.parse(value) : NaN;
const exactPath = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && resolve(value) === value;
const sameScope = (value: any, scope: Scope): boolean => value?.accountId === scope.accountId && isDeepStrictEqual(value?.workerNames, scope.workerNames);
const validDigest = (value: unknown): value is string => typeof value === 'string' && digestPattern.test(value);
export const restorationPath = (original: string): string => `${original}.restoration.json`;

export async function restorationRecordExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function pinShape(pin: Pin): boolean {
  return !!pin && exactPath(pin.path) && validDigest(pin.digest) && Object.keys(pin).sort().join(',') === 'digest,path';
}
/** Absent ancestry is supported only for legacy records; supplied lists are canonical. */
export function restorationDependencies(value: unknown): Pin[] {
  if (value === undefined) return [];
  requireCondition(Array.isArray(value) && value.length > 0 && value.length <= maxRestorationDependencies
    && value.every(pin => pinShape(pin) && /^deployment-[0-9]+\.json\.restoration\.json$/.test(relative(dirname(pin.path), pin.path)))
    && new Set(value.map(pin => pin.path)).size === value.length
    && isDeepStrictEqual(value.map(pin => pin.path), value.map(pin => pin.path).sort()), 'RESTORATION_DEPENDENCIES_INVALID');
  return value;
}
export function mergeRestorationDependencies(...lists: Pin[][]): Pin[] {
  const pins = new Map<string, Pin>();
  for (const pin of lists.flat()) {
    requireCondition(pinShape(pin) && (!pins.has(pin.path) || pins.get(pin.path)!.digest === pin.digest), 'RESTORATION_DEPENDENCY_CONFLICT');
    pins.set(pin.path, pin);
  }
  const result = [...pins.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (result.length) restorationDependencies(result);
  return result;
}
export function validateRestorationPointer(pointer: RestorationPointer, scope: Scope): void {
  requireCondition(pointer?.schemaVersion === 1 && sameScope(pointer, scope) && exactPath(pointer.reportPath)
    && /^deployment-[0-9]+\.json$/.test(relative(dirname(pointer.reportPath), pointer.reportPath)), 'RESTORATION_POINTER_INVALID');
  restorationDependencies(pointer.restorationDependencies);
}
export function matchRestorationAncestry(pointer: RestorationPointer, report: any): Pin[] {
  const inherited = restorationDependencies(pointer.restorationDependencies);
  requireCondition(isDeepStrictEqual(inherited, restorationDependencies(report?.restorationDependencies)), 'RESTORATION_ANCESTRY_MISMATCH');
  return inherited;
}
async function evidencePins(pins: Pin[], directory: string): Promise<void> {
  requireCondition(Array.isArray(pins) && pins.length >= 1 && pins.length <= 8
    && new Set(pins.map(pin => pin?.path)).size === pins.length, 'RESTORATION_EVIDENCE_REQUIRED');
  for (const pin of pins) {
    requireCondition(pinShape(pin) && dirname(pin.path) === directory && /^[a-zA-Z0-9_-]+\.json$/.test(relative(directory, pin.path)), 'RESTORATION_EVIDENCE_PATH');
    await pinnedJson(pin);
  }
}
async function bundleManifest(plan: RestorationPlan, release: any, readback: any): Promise<void> {
  requireCondition(plan.bundles && typeof plan.bundles === 'object' && !Array.isArray(plan.bundles)
    && Object.keys(plan.bundles).length >= 5 && Object.keys(plan.bundles).length <= 160
    && Object.entries(plan.bundles).every(([path, digest]) => /^[a-zA-Z0-9_.\/-]+$/.test(path)
      && !path.split('/').some(part => part === '.' || part === '..' || !part) && validDigest(digest)), 'RESTORATION_BUNDLE_MANIFEST');
  const actual: string[] = [];
  let directories = 0;
  async function walk(path: string, depth = 0): Promise<void> {
    requireCondition(++directories <= 128 && depth <= 8, 'RESTORATION_BUNDLE_DIRECTORY_LIMIT');
    requireCondition((await lstat(join(plan.restoredDirectory, 'bundles', path))).isDirectory(), 'RESTORATION_BUNDLE_DIRECTORY');
    for (const entry of await readdir(join(plan.restoredDirectory, 'bundles', path), { withFileTypes: true })) {
      const name = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(name, depth + 1);
      else { requireCondition(entry.isFile() && actual.length < 160, 'RESTORATION_BUNDLE_FILE'); actual.push(name); }
    }
  }
  await walk('');
  requireCondition(isDeepStrictEqual(actual.sort(), Object.keys(plan.bundles).sort()), 'RESTORATION_BUNDLE_SET_CHANGED');
  for (const [path, digest] of Object.entries(plan.bundles)) requireCondition(sha256(await readBounded(join(plan.restoredDirectory, 'bundles', path), 32 * 1024 * 1024)) === digest, 'RESTORATION_BUNDLE_CHANGED');
  for (const [index, role] of deploymentRoles.entries()) {
    const config = await pinnedJson({ path: join(plan.restoredDirectory, `${role}.json`), digest: release.configs?.[role] });
    requireCondition(config.account_id === plan.accountId && config.name === plan.workerNames[index]
      && typeof config.main === 'string' && config.main.endsWith('/index.ts'), 'RESTORATION_CONFIG_ASSOCIATION');
    if (role === 'app') requireCondition(config.vars?.AUTH_TENANT_ID === plan.project.tenantId
      && config.vars?.DEFAULT_PROJECT_ID === plan.project.projectId, 'RESTORATION_PROJECT_ASSOCIATION');
    const files = Object.entries(plan.bundles).filter(([path]) => path.startsWith(`${role}/`));
    const modules = Object.fromEntries(files.filter(([path]) => /\.(js|wasm)$/.test(path)).map(([path, digest]) => [path.slice(role.length + 1), digest]));
    const controls: Record<string, string> = {};
    if (role === 'app') for (const name of ['_headers', '_redirects']) {
      const key = `apps/web/dist/${name}`;
      if (Object.hasOwn(release.sourceDigests, key)) {
        requireCondition(validDigest(release.sourceDigests[key]), 'RESTORATION_CONTROL_MANIFEST'); controls[name] = release.sourceDigests[key];
      }
    }
    // Wrangler's inert package metadata remains in the complete, digest-pinned inventory.
    requireCondition(modules['index.js'] && Object.keys(modules).length <= 32
      && files.every(([path, digest]) => /\.(js|wasm)$/.test(path) || controls[path.slice(role.length + 1)] === digest
        || path === `${role}/README.md` || path === `${role}/index.js.map`), 'RESTORATION_BUNDLE_ROLE');
    const worker = readback.workers[index], detail = readback.checks.find((check: any) => check.name === `${role}-modules`).detail;
    requireCondition(isDeepStrictEqual(detail?.moduleDigests, modules) && isDeepStrictEqual(worker.moduleDigests, modules), 'RESTORATION_MODULE_ASSOCIATION');
    requireCondition(isDeepStrictEqual(detail?.assetControlDigests, controls), 'RESTORATION_CONTROL_ASSOCIATION');
    requireCondition(worker.role === role && worker.name === plan.workerNames[index] && versionPattern.test(worker.versionId)
      && readback.checks.find((check: any) => check.name === `${role}-active-version`).detail?.singleVersionAt100Percent === true
      && readback.checks.find((check: any) => check.name === `${role}-stable-deployment`).detail?.versionId === worker.versionId, 'RESTORATION_VERSION_ASSOCIATION');
  }
  requireCondition(Object.keys(plan.bundles).every(path => deploymentRoles.some(role => path.startsWith(`${role}/`))), 'RESTORATION_BUNDLE_ROLE');
}

type ValidationContext = { pins: Map<string, string>; visiting: Set<string>; valid: Set<string>; reserved: number };
const context = (reserved = 0): ValidationContext => ({ pins: new Map(), visiting: new Set(), valid: new Set(), reserved });
export async function validateRestorationDependencies(pins: Pin[], accountId: string, workerNames: string[]): Promise<void> {
  if (pins.length) restorationDependencies(pins);
  const ctx = context();
  for (const pin of pins) await terminal(pin, { accountId, workerNames }, ctx);
}
async function terminal(pin: Pin, scope: Scope, ctx: ValidationContext): Promise<void> {
  requireCondition(pinShape(pin) && (!ctx.pins.has(pin.path) || ctx.pins.get(pin.path) === pin.digest)
    && !ctx.visiting.has(pin.path), 'RESTORATION_DEPENDENCY_CONFLICT');
  ctx.pins.set(pin.path, pin.digest);
  requireCondition(ctx.pins.size + ctx.reserved <= maxRestorationDependencies, 'RESTORATION_DEPENDENCY_LIMIT');
  if (ctx.valid.has(pin.path)) return;
  ctx.visiting.add(pin.path);
  const journal = await pinnedJson(pin) as RestorationTerminal;
  requireCondition(journal?.schemaVersion === 1 && journal.operation === 'DEPLOYMENT_RESTORATION'
    && journal.status === 'RESTORED_BASELINE_RECONCILED' && sameScope(journal, scope)
    && journal.remoteMutations === 0 && journal.credentialsLoaded === false
    && isDeepStrictEqual(journal.claim, restorationClaim), 'RESTORATION_TERMINAL_INVALID');
  const { plan } = await validatePlan(journal.plan, time(journal.finalizedAt), ctx);
  requireCondition(pin.path === restorationPath(plan.original.path) && sameScope(plan, scope)
    && journal.originalDigest === plan.original.digest && journal.failedReleaseDigest === plan.failedRelease.digest
    && journal.restoredReleaseDigest === plan.restoredRelease.digest, 'RESTORATION_TERMINAL_ASSOCIATION');
  requireCondition(!await restorationRecordExists(continuationPath(plan.original.path)), 'RESTORATION_CONTINUATION_CONFLICT');
  ctx.visiting.delete(pin.path); ctx.valid.add(pin.path);
}
/** Historical validation reads retained immutable inputs, never today's pointer or source tree. */
export async function validateRestorationTerminal(originalPath: string, accountId: string, workerNames: string[]): Promise<boolean> {
  try {
    const path = restorationPath(originalPath), bytes = await readBounded(path);
    await terminal({ path, digest: sha256(bytes) }, { accountId, workerNames }, context()); return true;
  } catch { return false; }
}
export async function validateRestorationPlan(pin: Pin, at = Date.now()): Promise<{ plan: RestorationPlan; original: any; finalizeBy: number }> {
  // Reserve the terminal being proposed, so it cannot create an unadmittable seventeenth record.
  return validatePlan(pin, at, context(1));
}
async function validatePlan(pin: Pin, at: number, ctx: ValidationContext): Promise<{ plan: RestorationPlan; original: any; finalizeBy: number }> {
  requireCondition(pinShape(pin), 'RESTORATION_PLAN_PIN');
  const plan = await pinnedJson(pin) as RestorationPlan;
  requireCondition(plan?.schemaVersion === 1 && plan.operation === 'RECONCILE_RESTORED_BASELINE'
    && [plan.configDirectory, plan.restoredDirectory, plan.privateDirectory, plan.evidenceDirectory].every(exactPath)
    && new Set([plan.configDirectory, plan.restoredDirectory, plan.privateDirectory, plan.evidenceDirectory]).size === 4
    && /^[a-f0-9]{32}$/.test(plan.accountId) && Array.isArray(plan.workerNames) && plan.workerNames.length === 5
    && new Set(plan.workerNames).size === 5 && plan.workerNames.every(name => typeof name === 'string' && /^[a-z][a-z0-9-]+$/.test(name))
    && plan.project && Object.keys(plan.project).sort().join(',') === 'incarnation,projectId,tenantId'
    && Object.values(plan.project).every(value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value)), 'RESTORATION_PLAN_INVALID');
  requireCondition(pinShape(plan.original) && dirname(plan.original.path) === plan.configDirectory
    && /^deployment-[0-9]+\.json$/.test(relative(plan.configDirectory, plan.original.path))
    && pinShape(plan.pointer) && plan.pointer.path === join(plan.privateDirectory, '.deployment-state.json')
    && pinShape(plan.pointerSnapshot) && plan.pointerSnapshot.digest === plan.pointer.digest
    && plan.failedRelease?.path === join(plan.configDirectory, 'release.json')
    && plan.restoredRelease?.path === join(plan.restoredDirectory, 'release.json')
    && plan.failedRelease.digest !== plan.restoredRelease.digest, 'RESTORATION_PATH_ASSOCIATION');
  for (const input of [plan.pointerSnapshot, plan.readback, plan.restoration, plan.obligations]) {
    requireCondition(pinShape(input) && dirname(input.path) === plan.evidenceDirectory
      && /^[a-zA-Z0-9_-]+\.json$/.test(relative(plan.evidenceDirectory, input.path)), 'RESTORATION_EVIDENCE_PATH');
  }
  requireCondition(new Set([pin.path, plan.pointerSnapshot.path, plan.readback.path, plan.restoration.path, plan.obligations.path]).size === 5, 'RESTORATION_EVIDENCE_ALIAS');
  const original = await pinnedJson(plan.original); remainingStages(original);
  const failed = await pinnedJson(plan.failedRelease), restored = await pinnedJson(plan.restoredRelease);
  requireCondition(original.accountId === plan.accountId && isDeepStrictEqual(original.targetWorkerNames, plan.workerNames)
    && original.releaseDigest === plan.failedRelease.digest
    && [failed, restored].every(release => release.schemaVersion === 1 && release.accountId === plan.accountId
      && isDeepStrictEqual(release.names, plan.workerNames) && release.sourceDigests && typeof release.sourceDigests === 'object'
      && !Array.isArray(release.sourceDigests) && Object.keys(release.sourceDigests).length > 0
      && Object.values(release.sourceDigests).every(validDigest)), 'RESTORATION_RELEASE_ASSOCIATION');
  const pointer = await pinnedJson(plan.pointerSnapshot) as RestorationPointer;
  validateRestorationPointer(pointer, plan);
  requireCondition(pointer.reportPath === plan.original.path, 'RESTORATION_POINTER_ASSOCIATION');
  for (const inherited of matchRestorationAncestry(pointer, original)) await terminal(inherited, plan, ctx);
  const restoration = await pinnedJson(plan.restoration) as RestorationRecord;
  requireCondition(restoration?.schemaVersion === 1 && restoration.operation === 'RESTORATION_RECORD'
    && restoration.disposition === 'RESTORED_BASELINE' && sameScope(restoration, plan)
    && restoration.originalDigest === plan.original.digest && restoration.failedReleaseDigest === plan.failedRelease.digest
    && restoration.restoredReleaseDigest === plan.restoredRelease.digest
    && time(restoration.startedAt) >= time(original.completedAt) && time(restoration.completedAt) >= time(restoration.startedAt), 'RESTORATION_RECORD_INVALID');
  await evidencePins(restoration.evidence, plan.evidenceDirectory);
  const readback = await pinnedJson(plan.readback);
  requireCondition(readback?.schemaVersion === 1 && readback.status === 'READBACK_PASS' && readback.accountId === plan.accountId
    && readback.releaseDigest === plan.restoredRelease.digest && readback.remoteMutations === 0
    && time(readback.startedAt) >= time(restoration.completedAt) && time(readback.completedAt) >= time(readback.startedAt)
    && Array.isArray(readback.workers) && readback.workers.length === 5
    && Array.isArray(readback.checks) && readback.checks.length === 44
    && isDeepStrictEqual(readback.checks.map((check: any) => check.name).sort(), [...continuationReadbackChecks].sort())
    && readback.checks.every((check: any) => check.status === 'PASS'), 'RESTORATION_READBACK_INVALID');
  await bundleManifest(plan, restored, readback);
  const obligations = await pinnedJson(plan.obligations) as RestorationObligations;
  requireCondition(obligations?.schemaVersion === 1 && obligations.operation === 'RESTORATION_OBLIGATION_REVIEW'
    && sameScope(obligations, plan) && obligations.originalDigest === plan.original.digest
    && obligations.restoredReleaseDigest === plan.restoredRelease.digest
    && obligations.migrationInventory === 'SEPARATE_PRE_ENABLE_REVIEW_REQUIRED', 'RESTORATION_OBLIGATIONS_INVALID');
  const { runtime, resources, data } = obligations;
  requireCondition(runtime && isDeepStrictEqual(runtime.project, plan.project)
    && typeof runtime.revision === 'string' && /^[1-9][0-9]{0,19}$/.test(runtime.revision)
    && runtime.publicationAdmission === 'CLOSED' && runtime.currentExecutionObligations === 'RESOLVED'
    && [runtime.unresolvedPublications, runtime.pendingOutbox, runtime.pendingCleanup, runtime.queuedEvaluations, runtime.activeEvaluations, runtime.reservedBudget].every(count => count === 0), 'RESTORATION_RUNTIME_UNRESOLVED');
  requireCondition(resources?.disposition === 'CURRENT_RESOURCE_OBLIGATIONS_RESOLVED'
    && resources.activeCurrentExecutions === 0 && resources.unknownCurrentExecutions === 0
    && Array.isArray(resources.unresolvedCleanup) && resources.unresolvedCleanup.length === 0, 'RESTORATION_RESOURCES_UNRESOLVED');
  requireCondition(data?.projectionMigration === 'ACKNOWLEDGED_COMPATIBLE' && data.durableObjectSchema === 'RESTORED_CODE_COMPATIBLE'
    && data.authorization === 'RESTORED_POLICY_COMPATIBLE' && data.historicalReceipts === 'PRESERVED'
    && data.applicationWrites === 'RECONCILED_WITH_RESTORED_BASELINE' && data.automaticRollback === 'NOT_PERFORMED'
    && Array.isArray(data.unresolved) && data.unresolved.length === 0, 'RESTORATION_DATA_UNRESOLVED');
  for (const review of [runtime, resources, data]) {
    requireCondition(time(review.observedAt) >= time(restoration.completedAt), 'RESTORATION_OBSERVATION_TIME');
    await evidencePins(review.evidence, plan.evidenceDirectory);
  }
  const review = plan.review, observations = [readback.startedAt, runtime.observedAt, resources.observedAt, data.observedAt];
  requireCondition(review && typeof review.reviewedBy === 'string' && review.reviewedBy.trim().length > 0 && review.reviewedBy.length <= 128
    && review.disposition === 'RESTORED_BASELINE_CURRENT_OBLIGATIONS_RESOLVED'
    && isDeepStrictEqual(review.residualUncertainty, restorationClaim)
    && time(review.reviewedAt) >= Math.max(time(readback.completedAt), ...observations.map(time))
    && time(review.validUntil) > time(review.reviewedAt) && time(review.validUntil) - time(review.reviewedAt) <= restorationFreshnessMs
    && at >= time(review.reviewedAt) && at <= time(review.validUntil)
    && observations.every(value => at >= time(value) && at - time(value) <= restorationFreshnessMs), 'RESTORATION_REVIEW_EXPIRED_OR_INVALID');
  requireCondition(!await restorationRecordExists(continuationPath(plan.original.path)), 'RESTORATION_CONTINUATION_CONFLICT');
  return { plan, original, finalizeBy: Math.min(time(review.validUntil), ...observations.map(value => time(value) + restorationFreshnessMs)) };
}

export async function validateCurrentRestorationPointer(plan: RestorationPlan): Promise<void> {
  const pointer = await pinnedJson(plan.pointer) as RestorationPointer;
  requireCondition(isDeepStrictEqual(pointer, await pinnedJson(plan.pointerSnapshot)), 'RESTORATION_POINTER_CHANGED');
}
