// SPDX-License-Identifier: Apache-2.0
import { open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireDeploymentLock, retainDeploymentJson } from './deployment-recovery.ts';
import { validateDeploymentSecrets } from './deployment-secrets.ts';
import { runWranglerStage, type StageResult } from './deployment-stage.ts';
import { selectWranglerCredential } from '../scripts/provider-preflight.ts';
import { continuationPath, deploymentRoles, filePin, pinnedJson, readBounded, requireCondition, sha256,
  validateContinuationPlan, validateContinuationPayload, validateFinalReadback, validateJournal,
  type ContinuationJournal, type ContinuationPlan, type Pin } from './deployment-continuation-state.ts';

const implementationRoot = fileURLToPath(new URL('..', import.meta.url));
export const implementationPaths = ['infra/continue-deployment.ts', 'infra/deployment-continuation-state.ts',
  'infra/deployment-recovery.ts', 'infra/deployment-restoration-state.ts', 'infra/deployment-stage.ts', 'infra/deployment-secrets.ts',
  'infra/signing-configuration.ts', 'scripts/provider-preflight.ts', 'package.json', 'package-lock.json'];
type Hooks = { prepare: (plan: ContinuationPlan, configs: Record<string, any>) => Promise<void>;
  run: (sourceRoot: string, args: string[]) => Promise<StageResult> };
const liveHooks: Hooks = {
  async prepare(plan, configs) {
    await validateDeploymentSecrets(plan.privateDirectory, configs);
    const selected = selectWranglerCredential(plan.accountId);
    requireCondition(selected.account === plan.accountId && selected.credential && selected.checks.every(check => check.status === 'PASS'), 'CONTINUATION_WRANGLER_ACCOUNT_UNAVAILABLE');
  },
  run: (sourceRoot, args) => runWranglerStage(sourceRoot, args, true),
};
/** Exclusive creation is the dispatch-once identity. Even a torn initial write blocks retry. */
export async function createContinuationRecord(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'wx', 0o600).catch(() => { throw new Error('CONTINUATION_ALREADY_EXISTS'); });
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
}
export async function executeContinuation(planPath: string, hooks: Hooks = liveHooks): Promise<ContinuationJournal> {
  const pin = await filePin(planPath), initial = await validateContinuationPlan(pin);
  const releaseLock = await acquireDeploymentLock(initial.plan.privateDirectory);
  try {
    const { plan, original, release, remaining } = await validateContinuationPlan(pin);
    requireCondition(Date.now() >= Date.parse(plan.review.reviewedAt) && Date.now() <= Date.parse(plan.review.validUntil), 'CONTINUATION_REVIEW_EXPIRED');
    const path = continuationPath(plan.original.path);
    // Check before credentials: existing uncertain/complete work is never retried.
    try { await readFile(path); throw new Error('CONTINUATION_ALREADY_EXISTS'); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
    const configs = await validateContinuationPayload(plan, release);
    const implementationDigests = Object.fromEntries(await Promise.all(implementationPaths.map(async file => [file, sha256(await readBounded(join(implementationRoot, file)))])));
    await hooks.prepare(plan, configs);
    const journal: ContinuationJournal = { schemaVersion: 1, operation: 'DEPLOYMENT_CONTINUATION', status: 'STARTED', plan: pin,
      originalDigest: plan.original.digest, releaseDigest: plan.release.digest,
      observedEffect: { stage: original.stages.at(-1).name, status: 'OBSERVED_EXPECTED_EFFECT', readbackDigest: plan.readback.digest },
      startedAt: new Date().toISOString(), stages: [], implementationDigests };
    await createContinuationRecord(path, journal);
    try {
      for (const name of remaining) {
        await validateContinuationPlan(pin); await validateContinuationPayload(plan, release);
        requireCondition(Date.now() <= Date.parse(plan.review.validUntil), 'CONTINUATION_REVIEW_EXPIRED');
        const role = name.slice(7), stage = { name, status: 'STARTED', startedAt: new Date().toISOString() };
        journal.stages.push(stage); await retainDeploymentJson(path, journal);
        const result = await hooks.run(plan.sourceRoot, ['deploy', '--config', join(plan.configDirectory, `${role}.json`), '--secrets-file', join(plan.privateDirectory, `${role}.secrets.json`)]);
        Object.assign(stage, result, { status: result.exitCode === 0 && !result.errorCategory ? 'ACKNOWLEDGED' : 'UNKNOWN', completedAt: new Date().toISOString() });
        await retainDeploymentJson(path, journal);
        requireCondition(stage.status === 'ACKNOWLEDGED', 'CONTINUATION_STAGE_EFFECT_UNKNOWN');
      }
      journal.status = 'AWAITING_READBACK'; journal.completedAt = new Date().toISOString(); await retainDeploymentJson(path, journal); return journal;
    } catch (error) {
      const last = journal.stages.at(-1); if (last?.status === 'STARTED') { last.status = 'UNKNOWN'; last.completedAt = new Date().toISOString(); }
      journal.status = 'UNKNOWN'; journal.completedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : '';
      journal.reason = /^[A-Z_0-9]{1,100}$/.test(message) ? message : 'CONTINUATION_EFFECT_UNKNOWN';
      await retainDeploymentJson(path, journal); throw new Error(journal.reason);
    }
  } finally { await releaseLock(); }
}
export async function finalizeContinuation(planPath: string, readbackPath: string): Promise<ContinuationJournal> {
  const pin = await filePin(planPath), initial = await validateContinuationPlan(pin);
  const releaseLock = await acquireDeploymentLock(initial.plan.privateDirectory);
  try {
    const { plan, original, release, remaining } = await validateContinuationPlan(pin);
    await validateContinuationPayload(plan, release);
    const path = continuationPath(plan.original.path), journal = JSON.parse((await readBounded(path)).toString()) as ContinuationJournal;
    requireCondition(journal.status === 'AWAITING_READBACK' && journal.plan.path === pin.path && journal.plan.digest === pin.digest, 'CONTINUATION_NOT_AWAITING_READBACK');
    validateJournal(journal, plan, original, remaining);
    const readback = await filePin(readbackPath); await validateFinalReadback(journal, plan, remaining, readback);
    journal.finalReadback = readback; journal.finalizedAt = new Date().toISOString();
    requireCondition(Date.parse(journal.finalizedAt) >= Date.parse((await pinnedJson(readback)).completedAt), 'CONTINUATION_FINAL_TIME');
    journal.status = 'RECONCILED'; await retainDeploymentJson(path, journal); return journal;
  } finally { await releaseLock(); }
}
async function main(args: string[]): Promise<void> {
  const [mode, planPath, readbackPath] = args;
  requireCondition(['inspect', 'execute', 'finalize'].includes(mode ?? '') && planPath && args.length === (mode === 'finalize' ? 3 : 2), 'USAGE_CONTINUE_DEPLOYMENT_INSPECT_EXECUTE_OR_FINALIZE_PLAN_OPTIONAL_READBACK');
  if (mode === 'inspect') {
    const { plan, release, remaining } = await validateContinuationPlan(await filePin(resolve(planPath)));
    await validateContinuationPayload(plan, release);
    process.stdout.write(JSON.stringify({ status: 'CONTINUATION_INPUTS_PASS', originalReport: plan.original.path, remainingStages: remaining,
      originalStatusPreserved: 'UNKNOWN', remoteMutations: 0, credentialsLoaded: false }) + '\n');
  } else {
    const journal = mode === 'execute' ? await executeContinuation(resolve(planPath)) : await finalizeContinuation(resolve(planPath), resolve(readbackPath!));
    process.stdout.write(JSON.stringify({ status: journal.status, stages: journal.stages.map(stage => ({ name: stage.name, status: stage.status })), originalStatusPreserved: 'UNKNOWN' }) + '\n');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch(error => { const message = error instanceof Error ? error.message : '';
    process.stderr.write((/^[A-Z_0-9]{1,100}$/.test(message) ? message : 'CONTINUATION_PREPARATION_FAILED') + '\n'); process.exitCode = 1; });
}
