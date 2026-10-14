// SPDX-License-Identifier: Apache-2.0
// Proposed local-only recovery preparation. No provider/credential modules or dispatch hooks.
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireDeploymentLock } from './deployment-recovery.ts';
import { filePin, requireCondition } from './deployment-continuation-state.ts';
import { restorationClaim, restorationPath, restorationRecordExists, validateCurrentRestorationPointer,
  validateRestorationPlan, type RestorationTerminal } from './deployment-restoration-state.ts';

export async function inspectRestoration(planPath: string): Promise<{
  status: 'RESTORATION_INPUTS_PASS'; claim: typeof restorationClaim;
  remoteMutations: 0; credentialsLoaded: false; localWrites: 0;
}> {
  const { plan, finalizeBy } = await validateRestorationPlan(await filePin(resolve(planPath)));
  await validateCurrentRestorationPointer(plan);
  requireCondition(!await restorationRecordExists(restorationPath(plan.original.path)), 'RESTORATION_ALREADY_EXISTS');
  requireCondition(Date.now() <= finalizeBy, 'RESTORATION_REVIEW_EXPIRED_OR_INVALID');
  return { status: 'RESTORATION_INPUTS_PASS', claim: restorationClaim, remoteMutations: 0, credentialsLoaded: false, localWrites: 0 };
}

/** Exclusive creation leaves any torn write visible and blocking; never overwrite it. */
export async function finalizeRestoration(planPath: string): Promise<RestorationTerminal> {
  const pin = await filePin(resolve(planPath)), initial = await validateRestorationPlan(pin);
  const unlock = await acquireDeploymentLock(initial.plan.privateDirectory);
  try {
    const { plan } = await validateRestorationPlan(pin);
    await validateCurrentRestorationPointer(plan);
    const path = restorationPath(plan.original.path);
    requireCondition(!await restorationRecordExists(path), 'RESTORATION_ALREADY_EXISTS');
    const journal: RestorationTerminal = { schemaVersion: 1, operation: 'DEPLOYMENT_RESTORATION',
      status: 'RESTORED_BASELINE_RECONCILED', accountId: plan.accountId, workerNames: plan.workerNames,
      plan: pin, originalDigest: plan.original.digest, failedReleaseDigest: plan.failedRelease.digest,
      restoredReleaseDigest: plan.restoredRelease.digest, finalizedAt: new Date().toISOString(),
      claim: restorationClaim, remoteMutations: 0, credentialsLoaded: false };
    // Check the exact evidence and live pointer immediately before the exclusive write.
    const checked = await validateRestorationPlan(pin);
    await validateCurrentRestorationPointer(plan);
    const finalizedAt = Date.now();
    requireCondition(finalizedAt >= Date.parse(plan.review.reviewedAt) && finalizedAt <= checked.finalizeBy, 'RESTORATION_REVIEW_EXPIRED_OR_INVALID');
    journal.finalizedAt = new Date(finalizedAt).toISOString();
    const handle = await open(path, 'wx', 0o600).catch(() => { throw new Error('RESTORATION_ALREADY_EXISTS'); });
    try { await handle.writeFile(JSON.stringify(journal, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return journal;
  } finally { await unlock(); }
}

async function main(args: string[]): Promise<void> {
  const [mode, path] = args;
  requireCondition(args.length === 2 && ['inspect', 'finalize'].includes(mode ?? '') && path,
    'USAGE_RECONCILE_RESTORATION_INSPECT_OR_FINALIZE_PLAN');
  const result = mode === 'inspect' ? await inspectRestoration(path) : await finalizeRestoration(path);
  process.stdout.write(JSON.stringify({ status: result.status, claim: result.claim,
    remoteMutations: 0, credentialsLoaded: false, localWrites: mode === 'inspect' ? 0 : 1 }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch(error => {
    const message = error instanceof Error ? error.message : '';
    process.stderr.write((/^[A-Z_0-9]{1,100}$/.test(message) ? message : 'RESTORATION_PREPARATION_FAILED') + '\n'); process.exitCode = 1;
  });
}
