// SPDX-License-Identifier: Apache-2.0
// Durable, local fence for an interrupted five-Worker deployment. The pointer
// lives beside the stable private secret files, across generated release dirs.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, opendir, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { filePin, pinnedJson, validateContinuationTerminal, type Pin } from './deployment-continuation-state.ts';
import { matchRestorationAncestry, mergeRestorationDependencies, restorationDependencies, restorationPath,
  restorationRecordExists, validateRestorationDependencies, validateRestorationPointer, validateRestorationTerminal,
  type RestorationAdmission, type RestorationPointer } from './deployment-restoration-state.ts';

type Stage = { name: string; status: string };
type Report = { schemaVersion: number; operation: string; status: string; initial: boolean;
  accountId?: string; targetWorkerNames?: string[]; stages: Stage[];
  startedAt?: string; completedAt?: string; releaseDigest?: string;
  freshPrivateServiceNamesObserved?: string[]; restorationDependencies?: Pin[] };
type Pointer = RestorationPointer;
type InventoryEntry = { path: string; digest: string; operation: string; status: string;
  blocker: string | null; blockedStage: string | null };
type Reconciliation = { unknownReport: string; supersedingReport: string; readbackReport: string;
  unknownDigest: string; supersedingDigest: string; readbackDigest: string;
  reviewedBy: string; reviewedAt: string;
  effectReview: 'RECONCILED'; dataObligations: 'REVIEWED'; evidenceDigest: string };
export type DeploymentHistoryInventory = { schemaVersion: 1; root: string; accountId: string;
  workerNames: string[]; reports: InventoryEntry[]; reconciliations: Reconciliation[] };
const roles = ['authority', 'runner', 'evaluator', 'projector', 'app'];
const stateName = '.deployment-state.json';
const lockName = '.deployment.lock';

export class DeploymentFence extends Error {
  readonly reportName: string;
  readonly stageName: string;
  constructor(code: string, reportPath = '', stageName = '') {
    super(code); this.name = 'DeploymentFence'; this.reportName = basename(reportPath); this.stageName = stageName;
  }
}

async function boundedJsonWithDigest(path: string): Promise<{ value: unknown; digest: string }> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 1024 * 1024 || info.size === 0) throw new Error('DEPLOYMENT_JOURNAL_INVALID');
  const bytes = await readFile(path);
  if (bytes.length > 1024 * 1024) throw new Error('DEPLOYMENT_JOURNAL_INVALID');
  return { value: JSON.parse(bytes.toString('utf8')),
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
}
async function boundedJson(path: string): Promise<unknown> { return (await boundedJsonWithDigest(path)).value; }

/** A rename and parent-directory sync keep STARTED visible after a crash. */
export async function retainDeploymentJson(path: string, value: unknown): Promise<void> {
  const pending = `${path}.${randomUUID()}.pending`;
  let handle;
  try {
    handle = await open(pending, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync(); await handle.close(); handle = undefined;
    await rename(pending, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close().catch(() => {});
    await unlink(pending).catch(() => {});
  }
}

/** A stale lock is never cleared automatically; inspect its recorded process. */
export async function acquireDeploymentLock(privateDirectory: string): Promise<() => Promise<void>> {
  const path = join(privateDirectory, lockName);
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
    await handle.sync();
    const directory = await open(privateDirectory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle?.close().catch(() => {});
    if (handle) await unlink(path).catch(() => {});
    throw new DeploymentFence(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'
      ? 'DEPLOYMENT_LOCK_PRESENT' : 'DEPLOYMENT_LOCK_UNAVAILABLE');
  }
  return async () => {
    await handle!.close(); await unlink(path);
    const directory = await open(privateDirectory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  };
}

const remote = (stage: Stage): boolean => !stage.name.startsWith('package-');
function reportBlocker(report: unknown, path: string, accountId: string, workerNames: string[]): DeploymentFence | null {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return new DeploymentFence('DEPLOYMENT_JOURNAL_INVALID', path);
  const value = report as Report;
  if (value.schemaVersion !== 1 || !Array.isArray(value.stages)
    || value.stages.some(stage => !stage || typeof stage.name !== 'string' || typeof stage.status !== 'string')) return new DeploymentFence('DEPLOYMENT_JOURNAL_INVALID', path);
  if (value.operation === 'LOCAL_PACKAGE') return value.stages.some(remote) ? new DeploymentFence('DEPLOYMENT_JOURNAL_INVALID', path) : null;
  if (value.operation !== 'DEPLOY') return new DeploymentFence('DEPLOYMENT_JOURNAL_INVALID', path);
  const stages = value.stages.filter(remote);
  if (value.accountId && value.accountId !== accountId
    || value.targetWorkerNames && JSON.stringify(value.targetWorkerNames) !== JSON.stringify(workerNames)) return new DeploymentFence('DEPLOYMENT_TARGET_CHANGED', path);
  if (stages.length === 0) return value.status === 'FAILED' || value.status === 'BLOCKED'
    ? null : new DeploymentFence('PRIOR_DEPLOYMENT_UNRESOLVED', path);
  const expected = [...(value.initial ? ['bootstrap-authority', 'bootstrap-runner', 'bootstrap-evaluator'] : []),
    'projection-migration', ...roles.map(role => `deploy-${role}`)];
  const acknowledged = value.status === 'DEPLOYMENT_ACKNOWLEDGED'
    && JSON.stringify(stages.map(stage => stage.name)) === JSON.stringify(expected)
    && stages.every(stage => stage.status === 'ACKNOWLEDGED');
  return acknowledged ? null : new DeploymentFence('PRIOR_DEPLOYMENT_UNRESOLVED', path, stages.at(-1)?.name);
}

const journalName = /^deployment-[0-9]+\.json$/;
const readbackName = /^readback-[0-9]+\.json$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const maxRootEntries = 1024, maxReleaseDirectories = 128, maxDirectoryEntries = 1024, maxReports = 256;
const readbackChecks = ['generated-release', 'local-source-identity', 'selected-account', 'script-list-complete',
  ...roles.flatMap(role => [`${role}-script-present`, `${role}-exposure`, `${role}-custom-domains`,
    `${role}-active-version`, `${role}-bindings`, `${role}-modules`, `${role}-stable-deployment`]),
  'runner-immutable-image', 'evaluator-immutable-image', 'local-namespace-separation', 'evaluator-image-shared-digest'];

type HistoryScan = { inventory: DeploymentHistoryInventory; reports: Map<string, Report>;
  blockers: Map<string, DeploymentFence>; restorationHistoryPresent: boolean };

/** Inspect only journal files in the root and its immediate release directories. */
async function scanDeploymentHistory(privateDirectory: string, configDirectory: string,
  accountId: string, workerNames: string[]): Promise<HistoryScan> {
  const secrets = resolve(privateDirectory), config = resolve(configDirectory), root = dirname(secrets);
  if (dirname(config) !== root || config === secrets
    || !(await lstat(root)).isDirectory() || !(await lstat(secrets)).isDirectory()
    || !(await lstat(config)).isDirectory())
    throw new DeploymentFence('DEPLOYMENT_HISTORY_ROOT_INVALID');
  const entries: InventoryEntry[] = [], reports = new Map<string, Report>(), blockers = new Map<string, DeploymentFence>();
  let restorationHistoryPresent = false;
  async function inspectDirectory(directory: string, limit: number): Promise<void> {
    let count = 0;
    for await (const entry of await opendir(directory)) {
      if (++count > limit) throw new DeploymentFence('DEPLOYMENT_HISTORY_LIMIT');
      if (entry.name.endsWith('.restoration.json')) restorationHistoryPresent = true;
      if (!journalName.test(entry.name)) continue;
      const path = join(directory, entry.name), relative = path.slice(root.length + 1);
      if (++reportCount > maxReports) throw new DeploymentFence('DEPLOYMENT_HISTORY_LIMIT');
      try {
        const { value, digest } = await boundedJsonWithDigest(path);
        const blocker = reportBlocker(value, path, accountId, workerNames);
        const report = value as Report;
        if (report && typeof report === 'object' && Object.hasOwn(report, 'restorationDependencies')) restorationHistoryPresent = true;
        entries.push({ path: relative, digest, operation: typeof report?.operation === 'string' ? report.operation : '',
          status: typeof report?.status === 'string' ? report.status : '',
          blocker: blocker?.message ?? null, blockedStage: blocker?.stageName ?? null });
        reports.set(relative, report);
        if (blocker) blockers.set(relative, blocker);
      } catch (error) {
        if (error instanceof DeploymentFence) throw error;
        throw new DeploymentFence('DEPLOYMENT_JOURNAL_UNREADABLE', path);
      }
    }
  }
  let reportCount = 0, directoryCount = 0, rootCount = 0;
  await inspectDirectory(root, maxRootEntries);
  for await (const entry of await opendir(root)) {
    if (++rootCount > maxRootEntries) throw new DeploymentFence('DEPLOYMENT_HISTORY_LIMIT');
    if (entry.isSymbolicLink()) throw new DeploymentFence('DEPLOYMENT_HISTORY_ROOT_INVALID');
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    if (directory === secrets) continue;
    if (++directoryCount > maxReleaseDirectories) throw new DeploymentFence('DEPLOYMENT_HISTORY_LIMIT');
    await inspectDirectory(directory, maxDirectoryEntries);
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { inventory: { schemaVersion: 1, root, accountId, workerNames, reports: entries, reconciliations: [] }, reports, blockers, restorationHistoryPresent };
}

/** Produce a private, bounded inventory for an operator to review before first use. */
export async function inspectDeploymentHistory(privateDirectory: string, configDirectory: string,
  accountId: string, workerNames: string[]): Promise<DeploymentHistoryInventory> {
  return (await scanDeploymentHistory(privateDirectory, configDirectory, accountId, workerNames)).inventory;
}

function acknowledged(report: Report | undefined, path: string, accountId: string, workerNames: string[]): boolean {
  return !!report && report.operation === 'DEPLOY' && report.status === 'DEPLOYMENT_ACKNOWLEDGED'
    && report.accountId === accountId
    && (isDeepStrictEqual(report.targetWorkerNames, workerNames)
      || report.targetWorkerNames === undefined && report.initial === false)
    && !reportBlocker(report, path, accountId, workerNames)
    && typeof report.releaseDigest === 'string' && digestPattern.test(report.releaseDigest);
}

function originalTargetMatches(report: Report, workerNames: string[]): boolean {
  if (isDeepStrictEqual(report.targetWorkerNames, workerNames)) return true;
  // The first pilot journal predates targetWorkerNames. Its three provider-
  // observed bootstrap names bind the only Worker names reached before the
  // interrupted initial runner deployment. Other legacy shapes stay blocked.
  const stages = report.stages.filter(remote);
  return report.targetWorkerNames === undefined && report.initial === true
    && isDeepStrictEqual(report.freshPrivateServiceNamesObserved, workerNames.slice(0, 3))
    && isDeepStrictEqual(stages.map(stage => stage.name),
      ['bootstrap-authority', 'bootstrap-runner', 'bootstrap-evaluator', 'projection-migration', 'deploy-authority', 'deploy-runner'])
    && stages.slice(0, -1).every(stage => stage.status === 'ACKNOWLEDGED')
    && ['UNKNOWN', 'STARTED'].includes(stages.at(-1)?.status ?? '');
}

async function reconciliationValid(item: Reconciliation, scan: HistoryScan): Promise<boolean> {
  const { inventory, reports, blockers } = scan;
  if (!item || typeof item !== 'object' || !blockers.has(item.unknownReport)
    || item.unknownReport === item.supersedingReport
    || !digestPattern.test(item.evidenceDigest)
    || typeof item.reviewedBy !== 'string' || !item.reviewedBy.trim()
    || typeof item.reviewedAt !== 'string' || !Number.isFinite(Date.parse(item.reviewedAt))
    || item.effectReview !== 'RECONCILED' || item.dataObligations !== 'REVIEWED') return false;
  const original = reports.get(item.unknownReport), later = reports.get(item.supersedingReport);
  const originalStage = original?.stages?.filter(remote).at(-1);
  if (!original || !['UNKNOWN', 'STARTED'].includes(originalStage?.status ?? '')
    || original.accountId !== inventory.accountId || !originalTargetMatches(original, inventory.workerNames)
    || blockers.get(item.unknownReport)?.message !== 'PRIOR_DEPLOYMENT_UNRESOLVED'
    || !acknowledged(later, item.supersedingReport, inventory.accountId, inventory.workerNames)) return false;
  const firstStarted = Date.parse(original.startedAt ?? ''), laterStarted = Date.parse(later!.startedAt ?? '');
  const laterCompleted = Date.parse(later!.completedAt ?? '');
  if (!Number.isFinite(firstStarted) || !Number.isFinite(laterStarted) || !Number.isFinite(laterCompleted)
    || laterStarted <= firstStarted || laterCompleted < laterStarted) return false;
  const originalEntry = inventory.reports.find(entry => entry.path === item.unknownReport);
  const laterEntry = inventory.reports.find(entry => entry.path === item.supersedingReport);
  if (!originalEntry || !laterEntry || item.unknownDigest !== originalEntry.digest
    || item.supersedingDigest !== laterEntry.digest
    || !item.readbackReport || !digestPattern.test(item.readbackDigest)) return false;
  const parts = item.readbackReport.split('/');
  if (parts.length !== 2 || !parts[0] || parts[0] === '.' || parts[0] === '..'
    || parts[0] !== dirname(item.supersedingReport) || !readbackName.test(parts[1]!)) return false;
  try {
    const { value, digest } = await boundedJsonWithDigest(join(inventory.root, ...parts));
    const readback = value as { schemaVersion?: number; status?: string; accountId?: string; completedAt?: string;
      releaseDigest?: string; remoteMutations?: number; checks?: Stage[]; workers?: { name?: string }[] };
    return digest === item.readbackDigest && readback?.schemaVersion === 1 && readback.status === 'READBACK_PASS'
      && readback.accountId === inventory.accountId && readback.remoteMutations === 0
      && readback.releaseDigest === later!.releaseDigest
      && Number.isFinite(Date.parse(readback.completedAt ?? ''))
      && Date.parse(readback.completedAt ?? '') >= laterCompleted
      && Date.parse(item.reviewedAt) >= Date.parse(readback.completedAt ?? '')
      && Array.isArray(readback.checks) && readback.checks.length > 0
      && readback.checks.every(check => check?.status === 'PASS')
      && new Set(readback.checks.map(check => check.name)).size === readback.checks.length
      && readbackChecks.every(name => readback.checks!.some(check => check.name === name))
      && Array.isArray(readback.workers)
      && isDeepStrictEqual(readback.workers.map(worker => worker.name).sort(), [...inventory.workerNames].sort());
  } catch { return false; }
}

/** Fail closed across config directories through the stable private pointer. */
export async function assertDeploymentClear(privateDirectory: string, configDirectory: string,
  accountId: string, workerNames: string[], currentReportPath: string,
  reviewedInventoryPath?: string): Promise<{ inventoryDigest?: string; reconciledReports: string[]; restorationAdmission?: RestorationAdmission } | undefined> {
  const pointerPath = join(privateDirectory, stateName);
  let pointer: Pointer | null = null;
  let pointerPin: Pin | undefined, dependencies: Pin[] = [];
  try { const found = await boundedJsonWithDigest(pointerPath); pointer = found.value as Pointer;
    pointerPin = { path: resolve(pointerPath), digest: found.digest }; }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
      throw new DeploymentFence('DEPLOYMENT_POINTER_UNREADABLE', pointerPath);
  }
  const recognized = async (path: string): Promise<boolean> => {
    if (await validateContinuationTerminal(path, accountId, workerNames)) return true;
    if (!await validateRestorationTerminal(path, accountId, workerNames)) return false;
    dependencies = mergeRestorationDependencies(dependencies, [await filePin(restorationPath(path))]);
    return true;
  };
  if (pointer) {
    if (pointer.schemaVersion !== 1 || pointer.accountId !== accountId
      || JSON.stringify(pointer.workerNames) !== JSON.stringify(workerNames)
      || typeof pointer.reportPath !== 'string' || !pointer.reportPath.startsWith('/'))
      throw new DeploymentFence('DEPLOYMENT_POINTER_INVALID', pointerPath);
    try {
      const prior = await boundedJson(pointer.reportPath);
      if (!prior || typeof prior !== 'object' || Array.isArray(prior)
        || (prior as Report).operation !== 'DEPLOY'
        || (prior as Report).accountId !== accountId
        || JSON.stringify((prior as Report).targetWorkerNames) !== JSON.stringify(workerNames))
        throw new DeploymentFence('DEPLOYMENT_POINTER_TARGET_MISMATCH', pointer.reportPath);
      dependencies = matchRestorationAncestry(pointer, prior);
      await validateRestorationDependencies(dependencies, accountId, workerNames);
      const blocker = reportBlocker(prior, pointer.reportPath, accountId, workerNames);
      if (!blocker && await restorationRecordExists(restorationPath(pointer.reportPath)))
        throw new DeploymentFence('RESTORATION_TERMINAL_CONFLICT', pointer.reportPath);
      if (blocker && !(blocker.message === 'PRIOR_DEPLOYMENT_UNRESOLVED'
        && await recognized(pointer.reportPath))) throw blocker;
    } catch (error) {
      if (error instanceof DeploymentFence) throw error;
      throw new DeploymentFence('DEPLOYMENT_JOURNAL_UNREADABLE', pointer.reportPath);
    }
  } else {
    if (!reviewedInventoryPath) throw new DeploymentFence('DEPLOYMENT_HISTORY_INVENTORY_REQUIRED', pointerPath);
    const scan = await scanDeploymentHistory(privateDirectory, configDirectory, accountId, workerNames);
    // A lost pointer is not first use once restoration ancestry exists. The
    // legacy inventory cannot recreate its CAS witness or silently discard pins.
    if (scan.restorationHistoryPresent) throw new DeploymentFence('DEPLOYMENT_RESTORATION_HISTORY_REQUIRES_POINTER', pointerPath);
    let reviewed: DeploymentHistoryInventory, digest: string;
    try {
      const parsed = await boundedJsonWithDigest(reviewedInventoryPath);
      reviewed = parsed.value as DeploymentHistoryInventory; digest = parsed.digest;
    } catch { throw new DeploymentFence('DEPLOYMENT_HISTORY_INVENTORY_UNREADABLE', reviewedInventoryPath); }
    if (!reviewed || typeof reviewed !== 'object' || !Array.isArray(reviewed.reconciliations)
      || reviewed.reconciliations.length > maxReports
      || !isDeepStrictEqual({ ...reviewed, reconciliations: [] }, scan.inventory))
      throw new DeploymentFence('DEPLOYMENT_HISTORY_INVENTORY_STALE', reviewedInventoryPath);
    const reconciledReports: string[] = [];
    for (const [path, blocker] of scan.blockers) {
      const matches = reviewed.reconciliations.filter(item => item?.unknownReport === path);
      if (matches.length !== 1 || !(await reconciliationValid(matches[0]!, scan))) throw blocker;
      reconciledReports.push(path);
    }
    if (reviewed.reconciliations.length !== reconciledReports.length)
      throw new DeploymentFence('DEPLOYMENT_HISTORY_RECONCILIATION_INVALID', reviewedInventoryPath);
    return { inventoryDigest: digest, reconciledReports };
  }
  // Also catch a historical unresolved report in this config directory before
  // the pointer was introduced. The pointer protects later release directories.
  for (const name of await readdir(configDirectory)) {
    if (!/^deployment-[0-9]+\.json$/.test(name)) continue;
    const path = resolve(configDirectory, name);
    if (path === currentReportPath || path === pointer?.reportPath) continue;
    try {
      const prior = await boundedJson(path) as Report;
      const inherited = restorationDependencies(prior?.restorationDependencies);
      await validateRestorationDependencies(inherited, accountId, workerNames);
      dependencies = mergeRestorationDependencies(dependencies, inherited);
      const blocker = reportBlocker(prior, path, accountId, workerNames);
      if (!blocker && await restorationRecordExists(restorationPath(path)))
        throw new DeploymentFence('RESTORATION_TERMINAL_CONFLICT', path);
      if (blocker && !(blocker.message === 'PRIOR_DEPLOYMENT_UNRESOLVED'
        && await recognized(path))) throw blocker;
    } catch (error) {
      if (error instanceof DeploymentFence) throw error;
      throw new DeploymentFence('DEPLOYMENT_JOURNAL_UNREADABLE', path);
    }
  }
  if (dependencies.length) {
    await validateRestorationDependencies(dependencies, accountId, workerNames);
    return { reconciledReports: [], restorationAdmission: { priorPointer: pointerPin!, restorationDependencies: dependencies } };
  }
}

export async function pointToDeployment(privateDirectory: string, accountId: string,
  workerNames: string[], reportPath: string, admission?: RestorationAdmission): Promise<void> {
  const path = resolve(privateDirectory, stateName);
  let prior: Pointer | undefined, pointerPresent = false;
  try { prior = await boundedJson(path) as Pointer; pointerPresent = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DeploymentFence('DEPLOYMENT_POINTER_UNREADABLE', path); }
  let expected: RestorationAdmission | undefined;
  if (pointerPresent) {
    validateRestorationPointer(prior!, { accountId, workerNames });
    // The caller holds the deployment lock. Include same-config historical
    // restorations again, not just the current pointer's inherited list.
    expected = (await assertDeploymentClear(privateDirectory, dirname(resolve(reportPath)), accountId, workerNames, resolve(reportPath)))?.restorationAdmission;
  }
  if (expected && !admission) throw new DeploymentFence('RESTORATION_ADMISSION_REQUIRED', path);
  let dependencies: Pin[] | undefined;
  if (admission) {
    if (!expected || !isDeepStrictEqual(expected, admission)) throw new DeploymentFence('RESTORATION_ADMISSION_CHANGED', path);
    dependencies = restorationDependencies(admission.restorationDependencies);
    const next = await boundedJson(reportPath) as Report;
    if (next?.accountId !== accountId || !isDeepStrictEqual(next.targetWorkerNames, workerNames)
      || !isDeepStrictEqual(next.restorationDependencies, dependencies)) throw new DeploymentFence('RESTORATION_ANCESTRY_MISMATCH', reportPath);
    // The lock is owned by deploy-pilot; recheck after all evidence awaits.
    await pinnedJson(admission.priorPointer);
  } else {
    let next: Report | undefined;
    try { next = await boundedJson(reportPath) as Report; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (restorationDependencies(next?.restorationDependencies).length) throw new DeploymentFence('RESTORATION_ADMISSION_REQUIRED', reportPath);
  }
  await retainDeploymentJson(join(privateDirectory, stateName), {
    schemaVersion: 1, accountId, workerNames, reportPath: resolve(reportPath),
    ...(dependencies ? { restorationDependencies: dependencies } : {}),
  } satisfies Pointer);
}
