// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { acquireDeploymentLock, assertDeploymentClear, inspectDeploymentHistory, pointToDeployment, retainDeploymentJson } from './deployment-recovery.ts';

const names = ['pilot-authority', 'pilot-runner', 'pilot-evaluator', 'pilot-projector', 'pilot-app'];
const account = 'a'.repeat(32);
const moduleUrl = new URL('./deployment-recovery.ts', import.meta.url).href;
const remoteStages = ['projection-migration', 'deploy-authority', 'deploy-runner', 'deploy-evaluator', 'deploy-projector', 'deploy-app'];
const readbackCheckNames = ['generated-release', 'local-source-identity', 'selected-account', 'script-list-complete',
  ...['authority', 'runner', 'evaluator', 'projector', 'app'].flatMap(role =>
    ['script-present', 'exposure', 'custom-domains', 'active-version', 'bindings', 'modules', 'stable-deployment'].map(check => `${role}-${check}`)),
  'runner-immutable-image', 'evaluator-immutable-image', 'local-namespace-separation', 'evaluator-image-shared-digest'];
const report = (status: string, stages: { name: string; status: string }[]) => ({
  schemaVersion: 1, operation: 'DEPLOY', initial: false, status,
  accountId: account, targetWorkerNames: names, stages,
});
const digest = (bytes: string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
async function inventoryFile(secrets: string, config: string): Promise<string> {
  const path = join(dirname(secrets), 'history-inventory.json');
  await retainDeploymentJson(path, await inspectDeploymentHistory(secrets, config, account, names));
  return path;
}

test('SIGKILL after a durably STARTED remote stage fences a later release directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-deploy-crash-'));
  const secrets = join(directory, 'private'), first = join(directory, 'release-a'), next = join(directory, 'release-b');
  await Promise.all([mkdir(secrets), mkdir(first), mkdir(next)]);
  const path = join(first, 'deployment-123.json');
  const code = `
    import { acquireDeploymentLock, pointToDeployment, retainDeploymentJson } from ${JSON.stringify(moduleUrl)};
    const privateDirectory = process.env.PRIVATE_DIRECTORY;
    const reportPath = process.env.REPORT_PATH;
    await acquireDeploymentLock(privateDirectory);
    const names = ${JSON.stringify(names)};
    await retainDeploymentJson(reportPath, ${JSON.stringify(report('BLOCKED', []))});
    await pointToDeployment(privateDirectory, ${JSON.stringify(account)}, names, reportPath);
    await retainDeploymentJson(reportPath, ${JSON.stringify(report('BLOCKED', [{ name: 'projection-migration', status: 'ACKNOWLEDGED' }, { name: 'deploy-authority', status: 'STARTED' }]))});
    process.stdout.write('REMOTE_STAGE_STARTED\\n');
    await new Promise(() => {});
  `;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, PRIVATE_DIRECTORY: secrets, REPORT_PATH: path },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((accept, reject) => {
      let output = '', error = '';
      child!.stdout!.on('data', chunk => { output += chunk.toString(); if (output.includes('REMOTE_STAGE_STARTED')) accept(); });
      child!.stderr!.on('data', chunk => { error += chunk.toString(); });
      child!.once('error', reject);
      child!.once('exit', code => reject(new Error(`child exited before injection: ${code} ${error}`)));
    });
    child.kill('SIGKILL');
    await new Promise<void>(accept => child!.once('close', () => accept()));
    const retained = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(retained.stages.at(-1).status, 'STARTED');
    // A killed process leaves its lock. An operator may clear that lock after
    // checking the PID, but doing so cannot erase the uncertain remote stage.
    await assert.rejects(acquireDeploymentLock(secrets), /DEPLOYMENT_LOCK_PRESENT/);
    await unlink(join(secrets, '.deployment.lock'));
    await assert.rejects(assertDeploymentClear(secrets, next, account, names, join(next, 'deployment-124.json')),
      error => error instanceof Error && error.message === 'PRIOR_DEPLOYMENT_UNRESOLVED'
        && 'stageName' in error && error.stageName === 'deploy-authority');
    assert.deepEqual(retained.stages.map((stage: { name: string }) => stage.name), ['projection-migration', 'deploy-authority']);
  } finally { child?.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
});

test('status alone cannot clear an incomplete remote deployment; completed exact sequence can', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-deploy-order-'));
  const secrets = join(directory, 'private'), config = join(directory, 'config');
  await Promise.all([mkdir(secrets), mkdir(config)]);
  const path = join(config, 'deployment-123.json');
  try {
    await pointToDeployment(secrets, account, names, path);
    await retainDeploymentJson(path, report('DEPLOYMENT_ACKNOWLEDGED', []));
    await assert.rejects(assertDeploymentClear(secrets, config, account, names, join(config, 'deployment-124.json')),
      /PRIOR_DEPLOYMENT_UNRESOLVED/);
    await retainDeploymentJson(path, report('DEPLOYMENT_ACKNOWLEDGED', [{ name: 'deploy-authority', status: 'ACKNOWLEDGED' }]));
    await assert.rejects(assertDeploymentClear(secrets, config, account, names, join(config, 'deployment-124.json')),
      /PRIOR_DEPLOYMENT_UNRESOLVED/);
    await retainDeploymentJson(path, { ...report('LOCAL_PACKAGES_PASS', []), operation: 'LOCAL_PACKAGE' });
    await assert.rejects(assertDeploymentClear(secrets, config, account, names, join(config, 'deployment-124.json')),
      /DEPLOYMENT_POINTER_TARGET_MISMATCH/);
    await retainDeploymentJson(path, report('DEPLOYMENT_ACKNOWLEDGED', remoteStages.map(name => ({ name, status: 'ACKNOWLEDGED' }))));
    await assertDeploymentClear(secrets, config, account, names, join(config, 'deployment-124.json'));
    const release = await acquireDeploymentLock(secrets);
    await release();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a local-package label cannot hide remote work; genuine pre-remote failures can retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-deploy-operations-'));
  const secrets = join(directory, 'private'), config = join(directory, 'config');
  await Promise.all([mkdir(secrets), mkdir(config)]);
  const next = join(config, 'deployment-999.json');
  try {
    const path = join(config, 'deployment-123.json');
    await retainDeploymentJson(path, { ...report('LOCAL_PACKAGES_PASS', [{ name: 'deploy-authority', status: 'STARTED' }]), operation: 'LOCAL_PACKAGE' });
    let inventory = await inventoryFile(secrets, config);
    await assert.rejects(assertDeploymentClear(secrets, config, account, names, next, inventory), /DEPLOYMENT_JOURNAL_INVALID/);
    await retainDeploymentJson(path, { ...report('LOCAL_PACKAGES_PASS', [{ name: 'package-authority', status: 'LOCAL_PACKAGE_PASS' }]), operation: 'LOCAL_PACKAGE' });
    await retainDeploymentJson(join(config, 'deployment-124.json'), report('FAILED', [{ name: 'package-authority', status: 'FAILED' }]));
    await retainDeploymentJson(join(config, 'deployment-125.json'), report('BLOCKED', []));
    inventory = await inventoryFile(secrets, config);
    await assertDeploymentClear(secrets, config, account, names, next, inventory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('old same-directory UNKNOWN is caught before the first stable pointer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-deploy-legacy-'));
  const secrets = join(directory, 'private'), config = join(directory, 'config');
  await Promise.all([mkdir(secrets), mkdir(config)]);
  try {
    await retainDeploymentJson(join(config, 'deployment-123.json'), report('UNKNOWN', [{ name: 'projection-migration', status: 'UNKNOWN' }]));
    const inventory = await inventoryFile(secrets, config);
    await assert.rejects(assertDeploymentClear(secrets, config, account, names, join(config, 'deployment-124.json'), inventory),
      /PRIOR_DEPLOYMENT_UNRESOLVED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('first use needs a fresh bounded inventory across sibling release directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-deploy-history-'));
  const secrets = join(directory, 'secrets'), previous = join(directory, 'config'), next = join(directory, 'config-next');
  await Promise.all([mkdir(secrets), mkdir(previous), mkdir(next)]);
  const nextReport = join(next, 'deployment-999.json');
  try {
    await assert.rejects(assertDeploymentClear(secrets, next, account, names, nextReport),
      /DEPLOYMENT_HISTORY_INVENTORY_REQUIRED/);
    const inventory = await inventoryFile(secrets, next);
    await assertDeploymentClear(secrets, next, account, names, nextReport, inventory);
    await retainDeploymentJson(join(previous, 'deployment-123.json'), report('UNKNOWN', [{ name: 'deploy-runner', status: 'UNKNOWN' }]));
    await assert.rejects(assertDeploymentClear(secrets, next, account, names, nextReport, inventory),
      /DEPLOYMENT_HISTORY_INVENTORY_STALE/);
    const refreshed = await inventoryFile(secrets, next);
    await assert.rejects(assertDeploymentClear(secrets, next, account, names, nextReport, refreshed),
      /PRIOR_DEPLOYMENT_UNRESOLVED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an oversized history layout refuses inventory instead of silently skipping release directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-deploy-history-limit-'));
  const secrets = join(directory, 'secrets'), config = join(directory, 'config');
  await Promise.all([mkdir(secrets), mkdir(config)]);
  try {
    for (let index = 0; index < 128; index++) await mkdir(join(directory, `release-${index}`));
    await assert.rejects(inspectDeploymentHistory(secrets, config, account, names), /DEPLOYMENT_HISTORY_LIMIT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('later full ACK needs explicit digest-bound reconciliation and independent readback to supersede historical UNKNOWN', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-deploy-reconcile-'));
  const secrets = join(directory, 'secrets'), previous = join(directory, 'config'), later = join(directory, 'config-later'), next = join(directory, 'config-next');
  await Promise.all([mkdir(secrets), mkdir(previous), mkdir(later), mkdir(next)]);
  const unknownPath = join(previous, 'deployment-123.json'), laterPath = join(later, 'deployment-456.json');
  const readbackPath = join(later, 'readback-789.json'), inventoryPath = join(directory, 'reviewed-history.json');
  const releaseDigest = `sha256:${'b'.repeat(64)}`;
  try {
    await retainDeploymentJson(unknownPath, { ...report('UNKNOWN', [
      ...['bootstrap-authority', 'bootstrap-runner', 'bootstrap-evaluator', 'projection-migration', 'deploy-authority'].map(name => ({ name, status: 'ACKNOWLEDGED' })),
      { name: 'deploy-runner', status: 'UNKNOWN' }]), initial: true, targetWorkerNames: undefined,
      freshPrivateServiceNamesObserved: names.slice(0, 3), startedAt: '2026-10-01T00:00:00.000Z', releaseDigest: `sha256:${'a'.repeat(64)}` });
    await retainDeploymentJson(laterPath, { ...report('DEPLOYMENT_ACKNOWLEDGED', remoteStages.map(name => ({ name, status: 'ACKNOWLEDGED' }))),
      targetWorkerNames: undefined, startedAt: '2026-10-02T00:00:00.000Z', completedAt: '2026-10-02T00:01:00.000Z', releaseDigest });
    await retainDeploymentJson(readbackPath, { schemaVersion: 1, status: 'READBACK_PASS', accountId: account,
      releaseDigest, completedAt: '2026-10-03T00:00:00.000Z', remoteMutations: 0,
      checks: readbackCheckNames.map(name => ({ name, status: 'PASS' })), workers: names.map(name => ({ name })) });
    const unknownBytes = await readFile(unknownPath), inventory = await inspectDeploymentHistory(secrets, next, account, names);
    await retainDeploymentJson(inventoryPath, inventory);
    await assert.rejects(assertDeploymentClear(secrets, next, account, names, join(next, 'deployment-999.json'), inventoryPath),
      /PRIOR_DEPLOYMENT_UNRESOLVED/);
    const entries = Object.fromEntries(inventory.reports.map(entry => [entry.path, entry]));
    const reconciliation = { unknownReport: 'config/deployment-123.json', unknownDigest: entries['config/deployment-123.json']!.digest,
      supersedingReport: 'config-later/deployment-456.json', supersedingDigest: entries['config-later/deployment-456.json']!.digest,
      readbackReport: 'config-later/readback-789.json', readbackDigest: digest(await readFile(readbackPath, 'utf8')),
      reviewedBy: 'owner-operator', reviewedAt: '2026-10-08T06:00:00.000Z', effectReview: 'RECONCILED' as const,
      dataObligations: 'REVIEWED' as const, evidenceDigest: `sha256:${'c'.repeat(64)}` };
    await retainDeploymentJson(inventoryPath, { ...inventory, reconciliations: [{ ...reconciliation, unknownDigest: `sha256:${'0'.repeat(64)}` }] });
    await assert.rejects(assertDeploymentClear(secrets, next, account, names, join(next, 'deployment-999.json'), inventoryPath),
      /PRIOR_DEPLOYMENT_UNRESOLVED/);
    await retainDeploymentJson(inventoryPath, { ...inventory, reconciliations: [reconciliation] });
    const accepted = await assertDeploymentClear(secrets, next, account, names, join(next, 'deployment-999.json'), inventoryPath);
    assert.equal(accepted?.inventoryDigest, digest(await readFile(inventoryPath, 'utf8')));
    assert.deepEqual(accepted?.reconciledReports, ['config/deployment-123.json']);
    assert.deepEqual(await readFile(unknownPath), unknownBytes);
    await retainDeploymentJson(unknownPath, { ...JSON.parse(unknownBytes.toString()), freshPrivateServiceNamesObserved: ['wrong-authority', ...names.slice(1, 3)] });
    const changedInventory = await inspectDeploymentHistory(secrets, next, account, names);
    const changedDigest = changedInventory.reports.find(entry => entry.path === 'config/deployment-123.json')!.digest;
    await retainDeploymentJson(inventoryPath, { ...changedInventory, reconciliations: [{ ...reconciliation, unknownDigest: changedDigest }] });
    await assert.rejects(assertDeploymentClear(secrets, next, account, names, join(next, 'deployment-999.json'), inventoryPath),
      /PRIOR_DEPLOYMENT_UNRESOLVED/);
    await retainDeploymentJson(unknownPath, JSON.parse(unknownBytes.toString()));
    await retainDeploymentJson(inventoryPath, { ...inventory, reconciliations: [reconciliation] });
    await retainDeploymentJson(readbackPath, { schemaVersion: 1, status: 'BLOCKED', accountId: account,
      releaseDigest, completedAt: '2026-10-03T00:00:00.000Z', remoteMutations: 0,
      checks: readbackCheckNames.map(name => ({ name, status: name === 'runner-modules' ? 'BLOCKED' : 'PASS' })), workers: names.map(name => ({ name })) });
    await assert.rejects(assertDeploymentClear(secrets, next, account, names, join(next, 'deployment-999.json'), inventoryPath),
      /PRIOR_DEPLOYMENT_UNRESOLVED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the production wrapper refuses a new release before secrets, packaging, or provider calls', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'confidence-deploy-wrapper-'));
  const secrets = join(directory, 'private'), previous = join(directory, 'previous'), next = join(directory, 'next');
  await Promise.all([mkdir(secrets), mkdir(previous)]);
  const run = promisify(execFile);
  try {
    const input = JSON.parse(await readFile(join(root, 'infra/pilot.example.json'), 'utf8'));
    input.accountId = account;
    input.projectionDatabase.id = '11111111-1111-4111-8111-111111111111';
    Object.assign(input.app, { origin: 'https://owned-release.invalid', issuer: 'https://issuer.invalid', audience: 'owned-release', jwksUrl: 'https://issuer.invalid/jwks', bootstrapSubjects: ['https://issuer.invalid#owned-human'] });
    const inputPath = join(directory, 'input.json'); await writeFile(inputPath, JSON.stringify(input));
    await run(process.execPath, ['--import', 'tsx', join(root, 'infra/configure-pilot.ts'), 'configure', inputPath, next], { cwd: root, timeout: 30_000 });
    const generated = JSON.parse(await readFile(join(next, 'release.json'), 'utf8'));
    const oldReport = join(previous, 'deployment-123.json');
    await retainDeploymentJson(oldReport, { ...report('UNKNOWN', [{ name: 'deploy-runner', status: 'UNKNOWN' }]), targetWorkerNames: generated.names });
    await assert.rejects(run(process.execPath, ['--import', 'tsx', join(root, 'infra/deploy-pilot.ts'), next, secrets, '--deploy'], { cwd: root, timeout: 30_000 }),
      error => error instanceof Error && 'stderr' in error && String(error.stderr).includes('DEPLOYMENT_HISTORY_INVENTORY_REQUIRED'));
    const historyPath = join(directory, 'history-inventory.json');
    await run(process.execPath, ['--import', 'tsx', join(root, 'infra/inspect-deployment-history.ts'), next, secrets, historyPath], { cwd: root, timeout: 30_000 });
    const history = JSON.parse(await readFile(historyPath, 'utf8'));
    assert.equal(history.reports.find((item: { path: string }) => item.path === 'previous/deployment-123.json')?.blocker, 'PRIOR_DEPLOYMENT_UNRESOLVED');
    await assert.rejects(run(process.execPath, ['--import', 'tsx', join(root, 'infra/inspect-deployment-history.ts'), next, secrets, historyPath], { cwd: root, timeout: 30_000 }),
      error => error instanceof Error && 'stderr' in error && String(error.stderr).includes('EEXIST'));
    await assert.rejects(run(process.execPath, ['--import', 'tsx', join(root, 'infra/deploy-pilot.ts'), next, secrets, '--deploy', `--history-inventory=${historyPath}`], { cwd: root, timeout: 30_000 }),
      error => error instanceof Error && 'stderr' in error && String(error.stderr).includes('PRIOR_DEPLOYMENT_UNRESOLVED'));
    await pointToDeployment(secrets, account, generated.names, oldReport);
    await assert.rejects(run(process.execPath, ['--import', 'tsx', join(root, 'infra/deploy-pilot.ts'), next, secrets, '--deploy'], { cwd: root, timeout: 30_000 }),
      error => error instanceof Error && 'stderr' in error && String(error.stderr).includes('PRIOR_DEPLOYMENT_UNRESOLVED'));
    const reports = (await readdir(next)).filter(name => /^deployment-[0-9]+\.json$/.test(name));
    assert.equal(reports.length, 3);
    const blocked = await Promise.all(reports.map(async path => JSON.parse(await readFile(join(next, path), 'utf8'))));
    assert.deepEqual(blocked.map(item => item.reason).sort(), ['DEPLOYMENT_HISTORY_INVENTORY_REQUIRED', 'PRIOR_DEPLOYMENT_UNRESOLVED', 'PRIOR_DEPLOYMENT_UNRESOLVED']);
    assert(blocked.every(item => item.status === 'FAILED' && item.stages.length === 0));
    assert.equal(blocked.find(item => item.reason === 'PRIOR_DEPLOYMENT_UNRESOLVED')?.blockedByStage, 'deploy-runner');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
