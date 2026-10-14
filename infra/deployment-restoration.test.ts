// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { acquireDeploymentLock, assertDeploymentClear, inspectDeploymentHistory, pointToDeployment, retainDeploymentJson } from './deployment-recovery.ts';
import { continuationPath, continuationReadbackChecks, deploymentRoles, filePin, sha256, validateContinuationTerminal, type ContinuationPlan } from './deployment-continuation-state.ts';
import { executeContinuation, finalizeContinuation } from './continue-deployment.ts';
import { finalizeRestoration, inspectRestoration } from './reconcile-restoration.ts';
import { matchRestorationAncestry, mergeRestorationDependencies, restorationClaim, restorationDependencies, restorationPath,
  validateRestorationDependencies, validateRestorationTerminal, type RestorationObligations, type RestorationPlan, type RestorationRecord } from './deployment-restoration-state.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const accountId = 'a'.repeat(32), workerNames = deploymentRoles.map(role => `owned-${role}`);
const project = { tenantId: 'owned-tenant', projectId: 'owned-project', incarnation: 'owned-incarnation' };
const stamp = (offset: number) => new Date(Date.now() + offset).toISOString();
const remoteStages = ['projection-migration', ...deploymentRoles.map(role => `deploy-${role}`)];

async function fixture(packageMetadata = false) {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-restoration-'));
  const configDirectory = join(directory, 'failed'), restoredDirectory = join(directory, 'restored');
  const privateDirectory = join(directory, 'private'), evidenceDirectory = join(directory, 'evidence');
  for (const path of [configDirectory, restoredDirectory, privateDirectory, evidenceDirectory]) await mkdir(path);
  const write = async (path: string, value: unknown) => { await mkdir(dirname(path), { recursive: true }); await retainDeploymentJson(path, value); };
  const sourceDigests = { 'apps/web/dist/index.html': sha256('owned app'), 'apps/web/dist/_headers': sha256('owned headers') };
  const configs: Record<string, string> = {}, bundles: Record<string, string> = {};
  for (const [index, role] of deploymentRoles.entries()) {
    const path = join(restoredDirectory, `${role}.json`);
    await write(path, { account_id: accountId, name: workerNames[index], main: `/retained/inert-source/workers/${role}/index.ts`,
      vars: { AUTH_TENANT_ID: project.tenantId, DEFAULT_PROJECT_ID: project.projectId } });
    configs[role] = (await filePin(path)).digest;
    await mkdir(join(restoredDirectory, 'bundles', role), { recursive: true });
    const module = `owned inert ${role} module`;
    await writeFile(join(restoredDirectory, 'bundles', role, 'index.js'), module); bundles[`${role}/index.js`] = sha256(module);
    if (packageMetadata) for (const name of ['README.md', 'index.js.map']) {
      const metadata = `owned inert ${role} ${name}`;
      await writeFile(join(restoredDirectory, 'bundles', role, name), metadata); bundles[`${role}/${name}`] = sha256(metadata);
    }
  }
  await writeFile(join(restoredDirectory, 'bundles/app/_headers'), 'owned headers'); bundles['app/_headers'] = sourceDigests['apps/web/dist/_headers'];
  await write(join(configDirectory, 'release.json'), { schemaVersion: 1, accountId, names: workerNames, sourceDigests, configs, variant: 'failed' });
  await write(join(restoredDirectory, 'release.json'), { schemaVersion: 1, accountId, names: workerNames, sourceDigests, configs, variant: 'restored' });
  const failedRelease = await filePin(join(configDirectory, 'release.json')), restoredRelease = await filePin(join(restoredDirectory, 'release.json'));
  const original: any = { schemaVersion: 1, operation: 'DEPLOY', status: 'UNKNOWN', initial: false,
    accountId, targetWorkerNames: workerNames, releaseDigest: failedRelease.digest, secretAssociationsValidated: true,
    startedAt: stamp(-15000), completedAt: stamp(-12000), stages: [
      ...deploymentRoles.map(role => ({ name: `package-${role}`, status: 'LOCAL_PACKAGE_PASS' })),
      ...remoteStages.slice(0, 3).map((name, index) => ({ name, status: index === 2 ? 'UNKNOWN' : 'ACKNOWLEDGED',
        startedAt: stamp(-14500 + index * 500), completedAt: stamp(-14250 + index * 500) }))] };
  const originalPath = join(configDirectory, 'deployment-123.json'); await write(originalPath, original);
  const pointer = { schemaVersion: 1, accountId, workerNames, reportPath: originalPath };
  const pointerPath = join(privateDirectory, '.deployment-state.json'), snapshotPath = join(evidenceDirectory, 'pointer-snapshot.json');
  await write(pointerPath, pointer); await write(snapshotPath, pointer);
  const observationPath = join(evidenceDirectory, 'owned-observation.json');
  await write(observationPath, { operation: 'OWNED_INERT_FIXTURE', noRealEvidence: true });
  const evidence = [await filePin(observationPath)];
  const restoration: RestorationRecord = { schemaVersion: 1, operation: 'RESTORATION_RECORD', disposition: 'RESTORED_BASELINE',
    accountId, workerNames, originalDigest: (await filePin(originalPath)).digest, failedReleaseDigest: failedRelease.digest,
    restoredReleaseDigest: restoredRelease.digest, startedAt: stamp(-11000), completedAt: stamp(-10000), evidence };
  const obligations: RestorationObligations = { schemaVersion: 1, operation: 'RESTORATION_OBLIGATION_REVIEW', accountId, workerNames,
    originalDigest: restoration.originalDigest, restoredReleaseDigest: restoredRelease.digest,
    runtime: { observedAt: stamp(-5000), project, revision: '1', publicationAdmission: 'CLOSED', unresolvedPublications: 0,
      pendingOutbox: 0, pendingCleanup: 0, queuedEvaluations: 0, activeEvaluations: 0, reservedBudget: 0, currentExecutionObligations: 'RESOLVED', evidence },
    resources: { observedAt: stamp(-5000), activeCurrentExecutions: 0, unknownCurrentExecutions: 0,
      unresolvedCleanup: [], disposition: 'CURRENT_RESOURCE_OBLIGATIONS_RESOLVED', evidence },
    data: { observedAt: stamp(-5000), projectionMigration: 'ACKNOWLEDGED_COMPATIBLE', durableObjectSchema: 'RESTORED_CODE_COMPATIBLE',
      authorization: 'RESTORED_POLICY_COMPATIBLE', historicalReceipts: 'PRESERVED', applicationWrites: 'RECONCILED_WITH_RESTORED_BASELINE',
      automaticRollback: 'NOT_PERFORMED', unresolved: [], evidence }, migrationInventory: 'SEPARATE_PRE_ENABLE_REVIEW_REQUIRED' };
  const versions = deploymentRoles.map((_role, index) => `${String(index).repeat(8)}-1111-4111-8111-111111111111`);
  const readback: any = { schemaVersion: 1, status: 'READBACK_PASS', accountId, releaseDigest: restoredRelease.digest,
    remoteMutations: 0, startedAt: stamp(-8000), completedAt: stamp(-6000),
    workers: deploymentRoles.map((role, index) => ({ role, name: workerNames[index], versionId: versions[index], moduleDigests: { 'index.js': bundles[`${role}/index.js`] } })),
    checks: continuationReadbackChecks.map(name => ({ name, status: 'PASS', detail: name.endsWith('-modules') ? {
      moduleDigests: { 'index.js': bundles[`${name.slice(0, -8)}/index.js`] }, assetControlDigests: name === 'app-modules' ? { _headers: sourceDigests['apps/web/dist/_headers'] } : {},
    } : name.endsWith('-active-version') ? { singleVersionAt100Percent: true }
      : name.endsWith('-stable-deployment') ? { versionId: versions[deploymentRoles.indexOf(name.slice(0, -18) as any)] } : {} })) };
  const planPath = join(evidenceDirectory, 'plan.json');
  const paths = { readback: join(evidenceDirectory, 'readback.json'), restoration: join(evidenceDirectory, 'restoration.json'), obligations: join(evidenceDirectory, 'obligations.json') };
  await write(paths.readback, readback); await write(paths.restoration, restoration); await write(paths.obligations, obligations);
  const plan: RestorationPlan = { schemaVersion: 1, operation: 'RECONCILE_RESTORED_BASELINE', accountId, workerNames, project,
    configDirectory, restoredDirectory, privateDirectory, evidenceDirectory, original: await filePin(originalPath),
    pointer: await filePin(pointerPath), pointerSnapshot: await filePin(snapshotPath), failedRelease, restoredRelease,
    readback: await filePin(paths.readback), restoration: await filePin(paths.restoration), obligations: await filePin(paths.obligations), bundles,
    review: { reviewedBy: 'owned-fixture-reviewer', reviewedAt: stamp(-3000), validUntil: stamp(300000),
      disposition: 'RESTORED_BASELINE_CURRENT_OBLIGATIONS_RESOLVED', residualUncertainty: restorationClaim } };
  const savePlan = () => write(planPath, plan);
  const repin = async () => { await write(paths.readback, readback); await write(paths.restoration, restoration); await write(paths.obligations, obligations);
    plan.readback = await filePin(paths.readback); plan.restoration = await filePin(paths.restoration); plan.obligations = await filePin(paths.obligations); await savePlan(); };
  await savePlan();
  const fence = (config = configDirectory) => assertDeploymentClear(privateDirectory, config, accountId, workerNames, join(config, 'deployment-999.json'));
  return { directory, plan, planPath, original, pointer, restoration, obligations, readback, write, repin, savePlan, fence,
    cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function continuationSuccessor(f: Awaited<ReturnType<typeof fixture>>) {
  await finalizeRestoration(f.planPath);
  const dependencies = [await filePin(restorationPath(f.plan.original.path))];
  const configDirectory = join(f.directory, 'successor'), sourceRoot = join(f.directory, 'source');
  await mkdir(configDirectory); await mkdir(sourceRoot);
  const sourceDigests: Record<string, string> = {}, configs: Record<string, string> = {};
  for (const path of ['package.json', 'package-lock.json', 'infra/deploy-pilot.ts', 'infra/deployment-recovery.ts', 'infra/release-inputs.ts',
    'apps/web/dist/index.html', 'apps/web/dist/_headers', ...deploymentRoles.map(role => `workers/${role}/index.ts`),
    'packages/protocol/src/index.ts', 'packages/protocol/wasm/module.wasm', 'migrations/001.sql']) {
    const bytes = path.endsWith('_headers') ? 'owned headers' : 'owned inert successor source';
    await mkdir(dirname(join(sourceRoot, path)), { recursive: true }); await writeFile(join(sourceRoot, path), bytes); sourceDigests[path] = sha256(bytes);
  }
  for (const [index, role] of deploymentRoles.entries()) {
    const path = join(configDirectory, `${role}.json`);
    await f.write(path, { account_id: accountId, name: workerNames[index], main: join(sourceRoot, `workers/${role}/index.ts`) });
    configs[role] = (await filePin(path)).digest;
  }
  for (const path of Object.keys(f.plan.bundles)) {
    const target = join(configDirectory, 'bundles', path); await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(f.plan.restoredDirectory, 'bundles', path)));
  }
  await f.write(join(configDirectory, 'release.json'), { schemaVersion: 1, accountId, names: workerNames, sourceDigests, configs });
  const release = await filePin(join(configDirectory, 'release.json'));
  const original: any = { ...f.original, releaseDigest: release.digest, restorationDependencies: dependencies,
    stages: [...deploymentRoles.map(role => ({ name: `package-${role}`, status: 'LOCAL_PACKAGE_PASS' })),
      ...remoteStages.slice(0, 5).map((name, index) => ({ name, status: index === 4 ? 'UNKNOWN' : 'ACKNOWLEDGED', startedAt: stamp(-4000), completedAt: stamp(-3000) }))],
    startedAt: stamp(-4000), completedAt: stamp(-2500) };
  const originalPath = join(configDirectory, 'deployment-456.json'); await f.write(originalPath, original);
  await f.write(f.plan.pointer.path, { schemaVersion: 1, accountId, workerNames, reportPath: originalPath, restorationDependencies: dependencies });
  const readbackPath = join(configDirectory, 'readback-456.json');
  const readback = { ...f.readback, status: 'BLOCKED', releaseDigest: release.digest, startedAt: stamp(-2000), completedAt: stamp(-1000),
    checks: f.readback.checks.map((check: any) => ({ ...check, status: check.name === 'app-bindings' ? 'BLOCKED' : 'PASS' })) };
  await f.write(readbackPath, readback);
  const plan: ContinuationPlan = { schemaVersion: 1, operation: 'CONTINUE_DEPLOYMENT', sourceRoot, configDirectory, privateDirectory: f.plan.privateDirectory,
    accountId, workerNames, original: await filePin(originalPath), pointer: await filePin(f.plan.pointer.path), release,
    readback: await filePin(readbackPath), bundles: { ...f.plan.bundles },
    review: { reviewedBy: 'owned-continuation-fixture', reviewedAt: stamp(-500), validUntil: stamp(300000), effectReview: 'OBSERVED_EXPECTED_EFFECT',
      dataObligations: 'REVIEWED', evidence: f.obligations.runtime.evidence } };
  const planPath = join(f.directory, 'continuation-plan.json'), save = () => f.write(planPath, plan);
  await save();
  const fullReadback = async () => {
    const path = join(configDirectory, 'readback-999.json');
    await f.write(path, { ...readback, status: 'READBACK_PASS', startedAt: stamp(0), completedAt: stamp(0),
      checks: readback.checks.map((check: any) => ({ ...check, status: 'PASS' })) }); return path;
  };
  const fence = () => assertDeploymentClear(plan.privateDirectory, configDirectory, accountId, workerNames, join(configDirectory, 'deployment-999.json'));
  return { plan, planPath, original, dependencies, save, fullReadback, fence };
}

test('valid restoration ancestry supports only the observed projector continuation suffix and survives pointer movement', async () => {
  const f = await fixture();
  try {
    const c = await continuationSuccessor(f), original = await readFile(c.plan.original.path), pointer = await readFile(c.plan.pointer.path);
    const ancestor = await readFile(f.plan.original.path), commands: string[][] = [];
    const result = await executeContinuation(c.planPath, { prepare: async () => {}, run: async (_source, args) => {
      commands.push(args); return { exitCode: 0, stdoutDigest: sha256('ack'), stderrDigest: sha256(''), apiErrorCodes: [] };
    } });
    assert.equal(result.observedEffect.stage, 'deploy-projector'); assert.equal(result.status, 'AWAITING_READBACK');
    assert.deepEqual(result.stages.map(stage => stage.name), ['deploy-app']);
    assert.deepEqual(commands, [['deploy', '--config', join(c.plan.configDirectory, 'app.json'), '--secrets-file', join(c.plan.privateDirectory, 'app.secrets.json')]]);
    await finalizeContinuation(c.planPath, await c.fullReadback());
    assert.equal(await validateContinuationTerminal(c.plan.original.path, accountId, workerNames), true);
    assert.deepEqual(await readFile(c.plan.original.path), original); assert.deepEqual(await readFile(c.plan.pointer.path), pointer);
    assert.deepEqual(await readFile(f.plan.original.path), ancestor);
    const admission = (await c.fence())!.restorationAdmission!;
    assert.deepEqual(admission.restorationDependencies, c.dependencies);
    const next = join(c.plan.configDirectory, 'deployment-999.json');
    await f.write(next, { schemaVersion: 1, operation: 'DEPLOY', status: 'DEPLOYMENT_ACKNOWLEDGED', accountId, targetWorkerNames: workerNames,
      restorationDependencies: c.dependencies, stages: remoteStages.map(name => ({ name, status: 'ACKNOWLEDGED' })) });
    await pointToDeployment(c.plan.privateDirectory, accountId, workerNames, next, admission);
    await writeFile(join(c.plan.sourceRoot, 'workers/app/index.ts'), 'future source');
    assert.equal(await validateContinuationTerminal(c.plan.original.path, accountId, workerNames), true);
    await f.write(f.obligations.runtime.evidence[0]!.path, { tampered: true });
    assert.equal(await validateContinuationTerminal(c.plan.original.path, accountId, workerNames), false);
    await assert.rejects(c.fence());
  } finally { await f.cleanup(); }
});

test('missing, mismatched, malformed or invalid ancestor evidence blocks continuation before credentials', async t => {
  for (const kind of ['original-omitted', 'pointer-omitted', 'pointer-different', 'duplicate', 'missing', 'evidence', 'scope']) await t.test(kind, async () => {
    const f = await fixture(); let calls = 0;
    try {
      const c = await continuationSuccessor(f), pointer = JSON.parse(await readFile(c.plan.pointer.path, 'utf8'));
      if (kind === 'original-omitted') delete c.original.restorationDependencies;
      if (kind === 'pointer-omitted') delete pointer.restorationDependencies;
      if (kind === 'pointer-different') pointer.restorationDependencies = [{ ...c.dependencies[0], digest: sha256('different') }];
      if (kind === 'duplicate') c.original.restorationDependencies = [...c.dependencies, ...c.dependencies];
      if (kind === 'missing') await rm(c.dependencies[0]!.path);
      if (kind === 'evidence') await f.write(f.obligations.runtime.evidence[0]!.path, { tampered: true });
      if (kind === 'scope') {
        const terminal = JSON.parse(await readFile(c.dependencies[0]!.path, 'utf8')); terminal.accountId = 'b'.repeat(32);
        await f.write(c.dependencies[0]!.path, terminal);
        c.original.restorationDependencies = pointer.restorationDependencies = [await filePin(c.dependencies[0]!.path)];
      }
      await f.write(c.plan.original.path, c.original); c.plan.original = await filePin(c.plan.original.path);
      await f.write(c.plan.pointer.path, pointer); c.plan.pointer = await filePin(c.plan.pointer.path); await c.save();
      await assert.rejects(executeContinuation(c.planPath, { prepare: async () => { calls++; }, run: async () => { calls++; throw new Error('unexpected dispatch'); } }));
      assert.equal(calls, 0); assert.equal(await validateContinuationTerminal(c.plan.original.path, accountId, workerNames), false);
    } finally { await f.cleanup(); }
  });
});

test('ancestor tampering after preparation prevents dispatch and preserves unknown records', async () => {
  const f = await fixture(); let dispatches = 0;
  try {
    const c = await continuationSuccessor(f), original = await readFile(c.plan.original.path), pointer = await readFile(c.plan.pointer.path);
    await assert.rejects(executeContinuation(c.planPath, {
      prepare: async () => { await f.write(f.obligations.runtime.evidence[0]!.path, { tampered: true }); },
      run: async () => { dispatches++; throw new Error('unexpected dispatch'); },
    }), /CONTINUATION_PIN_CHANGED/);
    assert.equal(dispatches, 0);
    const sidecar = JSON.parse(await readFile(continuationPath(c.plan.original.path), 'utf8'));
    assert.equal(sidecar.status, 'UNKNOWN'); assert.deepEqual(sidecar.stages, []);
    assert.deepEqual(await readFile(c.plan.original.path), original); assert.deepEqual(await readFile(c.plan.pointer.path), pointer);
  } finally { await f.cleanup(); }
});

test('ancestor tampering after the acknowledged suffix blocks finalization and terminal recognition', async () => {
  const f = await fixture();
  try {
    const c = await continuationSuccessor(f);
    await executeContinuation(c.planPath, { prepare: async () => {}, run: async () => ({ exitCode: 0, stdoutDigest: sha256('ack'), stderrDigest: sha256(''), apiErrorCodes: [] }) });
    await f.write(f.obligations.runtime.evidence[0]!.path, { tampered: true });
    await assert.rejects(finalizeContinuation(c.planPath, await c.fullReadback()), /CONTINUATION_PIN_CHANGED/);
    assert.equal(await validateContinuationTerminal(c.plan.original.path, accountId, workerNames), false);
    await assert.rejects(c.fence());
  } finally { await f.cleanup(); }
});

test('local restoration preserves original uncertainty and pointer; inspect makes no writes', async () => {
  const f = await fixture();
  try {
    const original = await readFile(f.plan.original.path), pointer = await readFile(f.plan.pointer.path);
    const before = (await readdir(f.directory, { recursive: true })).sort();
    await assert.rejects(f.fence(), /PRIOR_DEPLOYMENT_UNRESOLVED/);
    const inspected = await inspectRestoration(f.planPath);
    assert.equal(inspected.localWrites, 0); assert.equal(inspected.credentialsLoaded, false); assert.equal(inspected.remoteMutations, 0);
    assert.deepEqual((await readdir(f.directory, { recursive: true })).sort(), before);
    const final = await finalizeRestoration(f.planPath);
    assert.equal(final.status, 'RESTORED_BASELINE_RECONCILED'); assert.deepEqual(final.claim, restorationClaim);
    assert.deepEqual(await readFile(f.plan.original.path), original); assert.deepEqual(await readFile(f.plan.pointer.path), pointer);
    assert.equal(await validateRestorationTerminal(f.plan.original.path, accountId, workerNames), true);
    const clearance = await f.fence(); assert.equal(clearance?.restorationAdmission?.restorationDependencies.length, 1);
    assert.equal(await validateContinuationTerminal(f.plan.original.path, accountId, workerNames), false);
    await assert.rejects(finalizeRestoration(f.planPath), /RESTORATION_ALREADY_EXISTS/);
  } finally { await f.cleanup(); }
});

test('readback must be fresh, complete, uniquely named and exactly associated with restored modules and controls', async t => {
  for (const kind of ['missing', 'duplicate', 'blocked', 'wrong-account', 'failed-release', 'old', 'future', 'version', 'stable-version', 'role',
    'worker-module', 'check-module', 'missing-control', 'changed-control', 'extra-control', 'mutation']) await t.test(kind, async () => {
    const f = await fixture();
    try {
      const report = f.readback, modules = report.checks.find((check: any) => check.name === 'app-modules').detail;
      if (kind === 'missing') report.checks.pop();
      if (kind === 'duplicate') report.checks[0] = report.checks[1];
      if (kind === 'blocked') report.checks[0].status = 'BLOCKED';
      if (kind === 'wrong-account') report.accountId = 'b'.repeat(32);
      if (kind === 'failed-release') report.releaseDigest = f.plan.failedRelease.digest;
      if (kind === 'old') report.startedAt = stamp(-1000000);
      if (kind === 'future') report.completedAt = stamp(10000);
      if (kind === 'version') delete report.workers[0].versionId;
      if (kind === 'stable-version') report.checks.find((check: any) => check.name === 'authority-stable-deployment').detail.versionId = report.workers[1].versionId;
      if (kind === 'role') report.workers[0].role = 'runner';
      if (kind === 'worker-module') report.workers[4].moduleDigests['index.js'] = sha256('unreviewed');
      if (kind === 'check-module') modules.moduleDigests['other.js'] = sha256('unreviewed');
      if (kind === 'missing-control') delete modules.assetControlDigests;
      if (kind === 'changed-control') modules.assetControlDigests._headers = sha256('unreviewed');
      if (kind === 'extra-control') modules.assetControlDigests._redirects = sha256('unreviewed');
      if (kind === 'mutation') report.remoteMutations = 1;
      await f.repin(); await assert.rejects(finalizeRestoration(f.planPath));
      await assert.rejects(f.fence(), /PRIOR_DEPLOYMENT_UNRESOLVED/);
    } finally { await f.cleanup(); }
  });
});

test('retained Wrangler metadata is digest-pinned without becoming deployed modules or asset controls', async () => {
  const f = await fixture(true);
  try {
    assert.equal(Object.keys(f.plan.bundles).length, 16);
    const original = await readFile(f.plan.original.path), pointer = await readFile(f.plan.pointer.path);
    const inspected = await inspectRestoration(f.planPath);
    assert.equal(inspected.status, 'RESTORATION_INPUTS_PASS'); assert.equal(inspected.localWrites, 0);
    assert.deepEqual(await readFile(f.plan.original.path), original); assert.deepEqual(await readFile(f.plan.pointer.path), pointer);
    assert(f.readback.workers.every((worker: any) => Object.keys(worker.moduleDigests).join(',') === 'index.js'));
  } finally { await f.cleanup(); }
});

test('known packaging metadata cannot hide tampering, unknown files or runtime proof changes', async t => {
  for (const kind of ['readme-tamper', 'map-tamper', 'missing-metadata', 'unlisted-metadata', 'unknown-file', 'nested-readme',
    'other-map', 'extra-module', 'metadata-as-module', 'changed-control']) await t.test(kind, async () => {
    const f = await fixture(true);
    try {
      const base = join(f.plan.restoredDirectory, 'bundles');
      let expected = /RESTORATION_BUNDLE_ROLE/;
      if (kind === 'readme-tamper' || kind === 'map-tamper') {
        await writeFile(join(base, 'app', kind === 'readme-tamper' ? 'README.md' : 'index.js.map'), 'changed');
        expected = /RESTORATION_BUNDLE_CHANGED/;
      }
      if (kind === 'missing-metadata') {
        await rm(join(base, 'app/README.md')); expected = /RESTORATION_BUNDLE_SET_CHANGED/;
      }
      if (kind === 'unlisted-metadata') {
        delete f.plan.bundles['app/index.js.map']; expected = /RESTORATION_BUNDLE_SET_CHANGED/;
      }
      const extra: Record<string, string> = { 'unknown-file': 'app/NOTES.md', 'nested-readme': 'app/nested/README.md',
        'other-map': 'app/other.js.map', 'extra-module': 'app/README.md.js' };
      if (extra[kind]) {
        const path = extra[kind]!; await mkdir(dirname(join(base, path)), { recursive: true });
        await writeFile(join(base, path), 'unreviewed'); f.plan.bundles[path] = sha256('unreviewed');
        if (kind === 'extra-module') expected = /RESTORATION_MODULE_ASSOCIATION/;
      }
      if (kind === 'metadata-as-module') {
        f.readback.workers[4].moduleDigests['README.md'] = f.plan.bundles['app/README.md'];
        f.readback.checks.find((check: any) => check.name === 'app-modules').detail.moduleDigests['README.md'] = f.plan.bundles['app/README.md'];
        expected = /RESTORATION_MODULE_ASSOCIATION/;
      }
      if (kind === 'changed-control') {
        await writeFile(join(base, 'app/_headers'), 'changed'); f.plan.bundles['app/_headers'] = sha256('changed');
      }
      await f.repin(); await assert.rejects(inspectRestoration(f.planPath), expected);
      assert(!(await readdir(f.plan.configDirectory)).some(name => name.endsWith('.restoration.json')));
    } finally { await f.cleanup(); }
  });
});

test('typed runtime, resource, data, scope and short reviewer authorization are mandatory', async t => {
  for (const kind of ['runtime-pending', 'runtime-project', 'runtime-incarnation', 'execution-unknown', 'resource-unknown', 'resource-cleanup',
    'budget-reserved', 'budget-missing', 'budget-string', 'data-unresolved', 'authorization-unknown', 'receipt-unknown', 'rollback', 'migration-inferred', 'review-missing', 'review-expired',
    'review-long', 'review-future', 'resource-stale', 'restoration-before-original', 'restoration-wrong-release', 'claim-success']) await t.test(kind, async () => {
    const f = await fixture();
    try {
      const obligations: any = f.obligations, review: any = f.plan.review;
      if (kind === 'runtime-pending') obligations.runtime.pendingOutbox = 1;
      if (kind === 'runtime-project') obligations.runtime.project = { ...project, projectId: 'other-project' };
      if (kind === 'runtime-incarnation') obligations.runtime.project = { ...project, incarnation: 'other-incarnation' };
      if (kind === 'budget-reserved') obligations.runtime.reservedBudget = 1;
      if (kind === 'budget-missing') delete obligations.runtime.reservedBudget;
      if (kind === 'budget-string') obligations.runtime.reservedBudget = '0';
      if (kind === 'execution-unknown') obligations.runtime.currentExecutionObligations = 'UNKNOWN';
      if (kind === 'resource-unknown') obligations.resources.unknownCurrentExecutions = 1;
      if (kind === 'resource-cleanup') obligations.resources.unresolvedCleanup = ['pending'];
      if (kind === 'data-unresolved') obligations.data.unresolved = ['unknown application writes'];
      if (kind === 'authorization-unknown') obligations.data.authorization = 'UNKNOWN';
      if (kind === 'receipt-unknown') obligations.data.historicalReceipts = 'NOT_READ';
      if (kind === 'rollback') obligations.data.automaticRollback = 'PERFORMED';
      if (kind === 'migration-inferred') obligations.migrationInventory = 'INFERRED_COMPLETE';
      if (kind === 'review-missing') review.reviewedBy = '';
      if (kind === 'review-expired') review.validUntil = stamp(-1000);
      if (kind === 'review-long') review.validUntil = stamp(3600000);
      if (kind === 'review-future') review.reviewedAt = stamp(10000);
      if (kind === 'resource-stale') obligations.resources.observedAt = stamp(-1000000);
      if (kind === 'restoration-before-original') f.restoration.startedAt = stamp(-20000);
      if (kind === 'restoration-wrong-release') f.restoration.restoredReleaseDigest = f.plan.failedRelease.digest;
      if (kind === 'claim-success') review.residualUncertainty = { ...restorationClaim, failedReleaseSucceeded: true };
      await f.repin(); await assert.rejects(finalizeRestoration(f.planPath));
    } finally { await f.cleanup(); }
  });
});

test('input pin drift, aliases and retained package changes fail closed before creating a sidecar', async t => {
  for (const kind of ['original', 'pointer', 'snapshot', 'failed-release', 'restored-release', 'config', 'bundle', 'evidence', 'plan-scope', 'same-release', 'symlink']) await t.test(kind, async () => {
    const f = await fixture();
    try {
      const paths: Record<string, string> = { original: f.plan.original.path, pointer: f.plan.pointer.path, snapshot: f.plan.pointerSnapshot.path,
        'failed-release': f.plan.failedRelease.path, 'restored-release': f.plan.restoredRelease.path, config: join(f.plan.restoredDirectory, 'app.json'),
        bundle: join(f.plan.restoredDirectory, 'bundles/app/index.js'), evidence: f.obligations.data.evidence[0]!.path };
      if (paths[kind]) await writeFile(paths[kind], 'changed');
      if (kind === 'plan-scope') { f.plan.accountId = 'b'.repeat(32); await f.savePlan(); }
      if (kind === 'same-release') { f.plan.restoredRelease = f.plan.failedRelease; await f.savePlan(); }
      if (kind === 'symlink') { await rm(f.plan.readback.path); await symlink(f.plan.restoration.path, f.plan.readback.path); }
      await assert.rejects(finalizeRestoration(f.planPath));
      assert(!(await readdir(f.plan.configDirectory)).some(name => name.endsWith('.restoration.json')));
    } finally { await f.cleanup(); }
  });
});

test('retained bundle traversal rejects empty-directory breadth and excessive depth', async t => {
  for (const kind of ['wide', 'deep']) await t.test(kind, async () => {
    const f = await fixture();
    try {
      const bundles = join(f.plan.restoredDirectory, 'bundles');
      if (kind === 'wide') for (let index = 0; index < 128; index++) await mkdir(join(bundles, `empty-${index}`));
      else await mkdir(join(bundles, ...Array.from({ length: 9 }, () => 'empty')), { recursive: true });
      await assert.rejects(finalizeRestoration(f.planPath), /RESTORATION_BUNDLE_DIRECTORY_LIMIT/);
    } finally { await f.cleanup(); }
  });
});

test('old observations cannot be made fresh by a new reviewer timestamp', async () => {
  const f = await fixture();
  try {
    f.original.startedAt = stamp(-1400000); f.original.completedAt = stamp(-1300000);
    for (const stage of f.original.stages.slice(5)) { stage.startedAt = stamp(-1390000); stage.completedAt = stamp(-1380000); }
    await f.write(f.plan.original.path, f.original); f.plan.original = await filePin(f.plan.original.path);
    f.restoration.originalDigest = f.plan.original.digest; f.obligations.originalDigest = f.plan.original.digest;
    f.restoration.startedAt = stamp(-1200000); f.restoration.completedAt = stamp(-1100000);
    f.readback.startedAt = stamp(-1000000); f.readback.completedAt = stamp(-990000);
    await f.repin();
    await assert.rejects(finalizeRestoration(f.planPath), /RESTORATION_REVIEW_EXPIRED_OR_INVALID/);
  } finally { await f.cleanup(); }
});

test('concurrent finalization, durable partial records and continuation conflicts cannot replace an outcome', async t => {
  await t.test('concurrent', async () => {
    const f = await fixture();
    try {
      const outcomes = await Promise.allSettled([finalizeRestoration(f.planPath), finalizeRestoration(f.planPath)]);
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1); await f.fence();
    } finally { await f.cleanup(); }
  });
  for (const kind of ['torn-restoration', 'torn-continuation', 'started-continuation', 'lock']) await t.test(kind, async () => {
    const f = await fixture(); let unlock: (() => Promise<void>) | undefined;
    try {
      if (kind === 'torn-restoration') await writeFile(restorationPath(f.plan.original.path), '{');
      if (kind === 'torn-continuation') await writeFile(continuationPath(f.plan.original.path), '{');
      if (kind === 'started-continuation') await f.write(continuationPath(f.plan.original.path), { status: 'STARTED' });
      if (kind === 'lock') unlock = await acquireDeploymentLock(f.plan.privateDirectory);
      await assert.rejects(finalizeRestoration(f.planPath)); await assert.rejects(f.fence());
    } finally { await unlock?.(); await f.cleanup(); }
  });
});

test('immutable history survives expiration and moved/deleted live pointers, but tampering re-fences', async t => {
  const f = await fixture();
  try {
    await finalizeRestoration(f.planPath);
    t.mock.method(Date, 'now', () => new Date('2099-01-01').getTime());
    assert.equal(await validateRestorationTerminal(f.plan.original.path, accountId, workerNames), true);
    await assert.rejects(inspectRestoration(f.planPath), /RESTORATION_REVIEW_EXPIRED/);
    await rm(f.plan.pointer.path);
    assert.equal(await validateRestorationTerminal(f.plan.original.path, accountId, workerNames), true);
    await assert.rejects(f.fence(), /DEPLOYMENT_HISTORY_INVENTORY_REQUIRED/);
    await f.write(f.plan.pointer.path, f.pointer);
    await f.fence();
    await writeFile(f.plan.readback.path, '{}');
    assert.equal(await validateRestorationTerminal(f.plan.original.path, accountId, workerNames), false);
    await assert.rejects(f.fence(), /PRIOR_DEPLOYMENT_UNRESOLVED/);
  } finally { await f.cleanup(); }
});

test('terminal claim tampering and subsequently added continuation records re-fence', async t => {
  for (const kind of ['claim', 'status', 'plan', 'time', 'continuation']) await t.test(kind, async () => {
    const f = await fixture();
    try {
      const journal: any = await finalizeRestoration(f.planPath); await f.fence();
      if (kind === 'claim') journal.claim = { ...restorationClaim, historicalTransientEffectsAbsent: true };
      if (kind === 'status') journal.status = 'DEPLOYMENT_ACKNOWLEDGED';
      if (kind === 'plan') journal.plan.digest = sha256('different');
      if (kind === 'time') journal.finalizedAt = '2099-01-01T00:00:00.000Z';
      if (kind === 'continuation') await writeFile(continuationPath(f.plan.original.path), '{');
      else await f.write(restorationPath(f.plan.original.path), journal);
      assert.equal(await validateRestorationTerminal(f.plan.original.path, accountId, workerNames), false);
      await assert.rejects(f.fence(), /PRIOR_DEPLOYMENT_UNRESOLVED/);
    } finally { await f.cleanup(); }
  });
});

test('nested immutable ancestry is memoized and cyclic/conflicting ancestry is rejected', async () => {
  const first = await fixture(), second = await fixture();
  try {
    await finalizeRestoration(first.planPath);
    const firstPin = await filePin(restorationPath(first.plan.original.path));
    const inherit = async (pins: typeof firstPin[]) => {
      second.original.restorationDependencies = pins;
      await second.write(second.plan.original.path, second.original); second.plan.original = await filePin(second.plan.original.path);
      second.restoration.originalDigest = second.plan.original.digest; second.obligations.originalDigest = second.plan.original.digest;
      const snapshot = { ...second.pointer, restorationDependencies: pins };
      await second.write(second.plan.pointer.path, snapshot); await second.write(second.plan.pointerSnapshot.path, snapshot);
      second.plan.pointer = await filePin(second.plan.pointer.path); second.plan.pointerSnapshot = await filePin(second.plan.pointerSnapshot.path);
      await second.repin();
    };
    await inherit([firstPin]); await finalizeRestoration(second.planPath);
    const secondPin = await filePin(restorationPath(second.plan.original.path));
    await validateRestorationDependencies(mergeRestorationDependencies([firstPin, secondPin]), accountId, workerNames);
    // A self-referencing old digest is never accepted as a second version of an ancestor.
    await inherit([secondPin]);
    const terminal: any = JSON.parse(await readFile(secondPin.path, 'utf8'));
    terminal.plan = await filePin(second.planPath); terminal.originalDigest = second.plan.original.digest;
    await second.write(secondPin.path, terminal);
    await assert.rejects(validateRestorationDependencies([await filePin(secondPin.path)], accountId, workerNames), /RESTORATION_DEPENDENCY_CONFLICT/);
    assert.equal(await validateRestorationTerminal(second.plan.original.path, accountId, workerNames), false);
  } finally { await first.cleanup(); await second.cleanup(); }
});

test('successor pointer/journal carry exact ancestry across release directories, including historical failures', async () => {
  const f = await fixture();
  try {
    await finalizeRestoration(f.planPath);
    let originalPointer = await readFile(f.plan.pointer.path);
    for (let index = 0; index < 2; index++) {
      const next = join(f.directory, `next-${index}`); await mkdir(next);
      const clearance = await f.fence(next), admission = clearance!.restorationAdmission!;
      const path = join(next, `deployment-${200 + index}.json`);
      const journal = { schemaVersion: 1, operation: 'DEPLOY', status: 'DEPLOYMENT_ACKNOWLEDGED', initial: false, accountId,
        targetWorkerNames: workerNames, restorationDependencies: admission.restorationDependencies,
        stages: remoteStages.map(name => ({ name, status: 'ACKNOWLEDGED' })) };
      await f.write(path, journal);
      await assert.rejects(pointToDeployment(f.plan.privateDirectory, accountId, workerNames, path), /RESTORATION_ADMISSION_REQUIRED/);
      await pointToDeployment(f.plan.privateDirectory, accountId, workerNames, path, admission);
      assert.notDeepEqual(await readFile(f.plan.pointer.path), originalPointer); originalPointer = await readFile(f.plan.pointer.path);
      await f.fence(next);
      assert.equal(await validateRestorationTerminal(f.plan.original.path, accountId, workerNames), true);
    }
    // Same-config scanning also continues to recognize the old unresolved journal.
    await f.fence();
    const original = await readFile(f.plan.original.path);
    await writeFile(f.plan.original.path, '{}');
    await assert.rejects(f.fence(join(f.directory, 'next-1')));
    await writeFile(f.plan.original.path, original);
    await rm(restorationPath(f.plan.original.path));
    await assert.rejects(f.fence(join(f.directory, 'next-1')));
  } finally { await f.cleanup(); }
});

test('admission CAS, canonical bounded dependencies and journal matching reject ancestry loss', async t => {
  for (const kind of ['pointer-changed', 'journal-missing', 'duplicate', 'conflicting', 'scope', 'too-many', 'sidecar-changed']) await t.test(kind, async () => {
    const f = await fixture();
    try {
      await finalizeRestoration(f.planPath);
      const admission = (await f.fence())!.restorationAdmission!, next = join(f.plan.configDirectory, 'deployment-456.json');
      const journal: any = { schemaVersion: 1, operation: 'DEPLOY', accountId, targetWorkerNames: workerNames, restorationDependencies: admission.restorationDependencies };
      if (kind === 'pointer-changed') await f.write(f.plan.pointer.path, { ...f.pointer, changed: true });
      if (kind === 'journal-missing') delete journal.restorationDependencies;
      if (kind === 'duplicate') admission.restorationDependencies.push(admission.restorationDependencies[0]!);
      if (kind === 'conflicting') admission.restorationDependencies.push({ ...admission.restorationDependencies[0]!, digest: sha256('other') });
      if (kind === 'scope') journal.accountId = 'b'.repeat(32);
      if (kind === 'too-many') admission.restorationDependencies = Array.from({ length: 17 }, (_, index) => ({ path: join(f.plan.configDirectory, `deployment-${index}.json.restoration.json`), digest: sha256('owned') }));
      if (kind === 'sidecar-changed') await writeFile(restorationPath(f.plan.original.path), '{}');
      await f.write(next, journal);
      const before = await readFile(f.plan.pointer.path);
      await assert.rejects(pointToDeployment(f.plan.privateDirectory, accountId, workerNames, next, admission));
      assert.deepEqual(await readFile(f.plan.pointer.path), before);
    } finally { await f.cleanup(); }
  });
  assert.throws(() => restorationDependencies([]), /DEPENDENCIES_INVALID/);
  assert.throws(() => matchRestorationAncestry({ schemaVersion: 1, accountId, workerNames, reportPath: '/owned/deployment-1.json' }, { restorationDependencies: [] }), /DEPENDENCIES_INVALID/);
});

test('pointer/journal ancestry disagreement and torn current restorations never become legacy absence', async t => {
  for (const kind of ['pointer-omits', 'journal-omits', 'torn-restoration']) await t.test(kind, async () => {
    const f = await fixture();
    try {
      await finalizeRestoration(f.planPath);
      const next = join(f.plan.configDirectory, 'deployment-456.json'), admission = (await f.fence())!.restorationAdmission!;
      const journal: any = { schemaVersion: 1, operation: 'DEPLOY', status: 'DEPLOYMENT_ACKNOWLEDGED', initial: false,
        accountId, targetWorkerNames: workerNames, restorationDependencies: admission.restorationDependencies,
        stages: remoteStages.map(name => ({ name, status: 'ACKNOWLEDGED' })) };
      await f.write(next, journal);
      if (kind === 'torn-restoration') {
        await writeFile(restorationPath(f.plan.original.path), '{');
        await assert.rejects(pointToDeployment(f.plan.privateDirectory, accountId, workerNames, next), /PRIOR_DEPLOYMENT_UNRESOLVED/);
      } else {
        await pointToDeployment(f.plan.privateDirectory, accountId, workerNames, next, admission);
        if (kind === 'pointer-omits') {
          const pointer = JSON.parse(await readFile(f.plan.pointer.path, 'utf8')); delete pointer.restorationDependencies; await f.write(f.plan.pointer.path, pointer);
        } else { delete journal.restorationDependencies; await f.write(next, journal); }
        await assert.rejects(f.fence(), /DEPLOYMENT_JOURNAL_UNREADABLE/);
      }
    } finally { await f.cleanup(); }
  });
});

test('pointer creation recomputes exact same-config historical ancestry beyond its current target', async t => {
  for (const kind of ['valid', 'witnessless', 'omitted', 'additional', 'stale-pin', 'stale-pointer', 'null-pointer']) await t.test(kind, async () => {
    const f = await fixture(); let extra: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      await finalizeRestoration(f.planPath);
      // An owned legacy pointer targets a separate ACK, while the restored
      // historical journal remains in the destination configuration.
      const current = join(f.directory, 'current'); await mkdir(current);
      const currentPath = join(current, 'deployment-456.json'), next = join(f.plan.configDirectory, 'deployment-789.json');
      const ack: any = { schemaVersion: 1, operation: 'DEPLOY', status: 'DEPLOYMENT_ACKNOWLEDGED', initial: false,
        accountId, targetWorkerNames: workerNames, stages: remoteStages.map(name => ({ name, status: 'ACKNOWLEDGED' })) };
      await f.write(currentPath, ack);
      await f.write(f.plan.pointer.path, { schemaVersion: 1, accountId, workerNames, reportPath: currentPath });
      const clearance = await assertDeploymentClear(f.plan.privateDirectory, f.plan.configDirectory, accountId, workerNames, next);
      const admission = structuredClone(clearance!.restorationAdmission!);
      assert.equal(admission.restorationDependencies.length, 1);
      if (kind === 'omitted') admission.restorationDependencies = [];
      if (kind === 'additional') {
        extra = await fixture(); await finalizeRestoration(extra.planPath);
        admission.restorationDependencies = mergeRestorationDependencies(admission.restorationDependencies, [await filePin(restorationPath(extra.plan.original.path))]);
      }
      if (kind === 'stale-pin') admission.restorationDependencies[0]!.digest = sha256('stale pin');
      if (kind === 'stale-pointer') admission.priorPointer.digest = sha256('stale pointer');
      if (kind === 'null-pointer') await f.write(f.plan.pointer.path, null);
      await f.write(next, { ...ack, ...(kind === 'witnessless' ? {} : { restorationDependencies: admission.restorationDependencies }) });
      const before = await readFile(f.plan.pointer.path), unlock = await acquireDeploymentLock(f.plan.privateDirectory);
      try {
        const advance = () => pointToDeployment(f.plan.privateDirectory, accountId, workerNames, next, kind === 'witnessless' ? undefined : admission);
        if (kind === 'valid') {
          await advance();
          const pointer = JSON.parse(await readFile(f.plan.pointer.path, 'utf8'));
          assert.equal(pointer.reportPath, next); assert.deepEqual(pointer.restorationDependencies, admission.restorationDependencies);
          await f.fence();
        } else {
          await assert.rejects(advance(), /RESTORATION_(ADMISSION_REQUIRED|ADMISSION_CHANGED|POINTER_INVALID)/);
          assert.deepEqual(await readFile(f.plan.pointer.path), before);
        }
      } finally { await unlock(); }
    } finally { await extra?.cleanup(); await f.cleanup(); }
  });
});

test('first-use inventory cannot erase a restored UNKNOWN history when the stable pointer is absent', async () => {
  const f = await fixture();
  try {
    await finalizeRestoration(f.planPath); await rm(f.plan.pointer.path);
    const inventory = await inspectDeploymentHistory(f.plan.privateDirectory, f.plan.configDirectory, accountId, workerNames);
    assert.equal(inventory.reports.find(report => report.path.endsWith('deployment-123.json'))?.blocker, 'PRIOR_DEPLOYMENT_UNRESOLVED');
    const path = join(f.directory, 'inventory.json'); await f.write(path, inventory);
    await assert.rejects(assertDeploymentClear(f.plan.privateDirectory, f.plan.configDirectory, accountId, workerNames, join(f.plan.configDirectory, 'deployment-999.json'), path), /DEPLOYMENT_RESTORATION_HISTORY_REQUIRES_POINTER/);
  } finally { await f.cleanup(); }
});

test('lost pointer cannot enter legacy inventory after restoration ancestry, even with a reviewed ACK successor', async t => {
  for (const kind of ['legacy-no-ancestry', 'valid', 'tampered', 'missing', 'null-field', 'empty-field', 'torn-sidecar', 'directory-sidecar']) await t.test(kind, async () => {
    const f = await fixture();
    try {
      const next = join(f.directory, 'next'); await mkdir(next);
      const ancestry = ['valid', 'tampered', 'missing', 'null-field', 'empty-field'].includes(kind);
      if (ancestry) await finalizeRestoration(f.planPath);
      const admission = ancestry ? (await f.fence(next))!.restorationAdmission! : undefined;
      const nextPath = join(next, 'deployment-456.json'), readbackPath = join(next, 'readback-789.json');
      const journal: any = { schemaVersion: 1, operation: 'DEPLOY', status: 'DEPLOYMENT_ACKNOWLEDGED', initial: false,
        accountId, targetWorkerNames: workerNames, startedAt: stamp(-2000), completedAt: stamp(-1000), releaseDigest: f.plan.restoredRelease.digest,
        stages: remoteStages.map(name => ({ name, status: 'ACKNOWLEDGED' })),
        ...(admission ? { restorationDependencies: admission.restorationDependencies } : {}) };
      await f.write(nextPath, journal);
      if (admission) await pointToDeployment(f.plan.privateDirectory, accountId, workerNames, nextPath, admission);
      await rm(f.plan.pointer.path);
      if (kind === 'tampered') await writeFile(restorationPath(f.plan.original.path), '{}');
      if (kind === 'missing') await rm(restorationPath(f.plan.original.path));
      if (kind === 'null-field' || kind === 'empty-field') {
        await rm(restorationPath(f.plan.original.path)); journal.restorationDependencies = kind === 'null-field' ? null : [];
        await f.write(nextPath, journal);
      }
      if (kind === 'torn-sidecar') await writeFile(join(next, 'deployment-987.json.restoration.json'), '{');
      if (kind === 'directory-sidecar') await mkdir(join(next, 'deployment-987.json.restoration.json'));
      await f.write(readbackPath, { ...f.readback, startedAt: stamp(-800), completedAt: stamp(-500) });
      const inventory = await inspectDeploymentHistory(f.plan.privateDirectory, next, accountId, workerNames);
      const entries = Object.fromEntries(inventory.reports.map(entry => [entry.path, entry]));
      inventory.reconciliations = [{ unknownReport: 'failed/deployment-123.json', unknownDigest: entries['failed/deployment-123.json']!.digest,
        supersedingReport: 'next/deployment-456.json', supersedingDigest: entries['next/deployment-456.json']!.digest,
        readbackReport: 'next/readback-789.json', readbackDigest: (await filePin(readbackPath)).digest,
        reviewedBy: 'owned-fixture-reviewer', reviewedAt: stamp(0), effectReview: 'RECONCILED', dataObligations: 'REVIEWED', evidenceDigest: sha256('owned review') }];
      const inventoryPath = join(f.directory, 'reviewed-inventory.json'); await f.write(inventoryPath, inventory);
      const admissionCheck = () => assertDeploymentClear(f.plan.privateDirectory, next, accountId, workerNames, join(next, 'deployment-999.json'), inventoryPath);
      if (kind === 'legacy-no-ancestry') assert.deepEqual((await admissionCheck())!.reconciledReports, ['failed/deployment-123.json']);
      else await assert.rejects(admissionCheck(), /DEPLOYMENT_RESTORATION_HISTORY_REQUIRES_POINTER/);
    } finally { await f.cleanup(); }
  });
});

test('inspect CLI is local-only with no credential imports, hooks or filesystem writes', async () => {
  const f = await fixture();
  try {
    const before = (await readdir(f.directory, { recursive: true })).sort();
    const run = promisify(execFile);
    const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', join(root, 'infra/reconcile-restoration.ts'), 'inspect', f.planPath], {
      cwd: root, env: { PATH: process.env.PATH, HOME: '/nonexistent-owned-home', CLOUDFLARE_API_TOKEN: 'owned-must-not-be-read' }, timeout: 15000,
    });
    assert.equal(stderr, ''); assert.equal(JSON.parse(stdout).localWrites, 0); assert(!stdout.includes('owned-must-not-be-read'));
    assert.deepEqual((await readdir(f.directory, { recursive: true })).sort(), before);
    for (const file of ['infra/reconcile-restoration.ts', 'infra/deployment-restoration-state.ts']) {
      const source = await readFile(join(root, file), 'utf8');
      assert(!/provider-preflight|deployment-secrets|deployment-stage|process\.env|\bfetch\(|child_process/.test(source));
    }
  } finally { await f.cleanup(); }
});
