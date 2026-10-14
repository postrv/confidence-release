// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireDeploymentLock, assertDeploymentClear, retainDeploymentJson } from './deployment-recovery.ts';
import { createContinuationRecord, executeContinuation, finalizeContinuation } from './continue-deployment.ts';
import { continuationPath, continuationReadbackChecks, deploymentRoles, filePin, sha256,
  validateContinuationPlan, validateContinuationPayload, validateContinuationTerminal, type ContinuationPlan } from './deployment-continuation-state.ts';
import { runWranglerStage, stageErrorCategory } from './deployment-stage.ts';
const names = deploymentRoles.map(role => `owned-${role}`), accountId = 'a'.repeat(32);
const stamp = (offset: number) => new Date(Date.now() + offset).toISOString();
const ack = { exitCode: 0, stdoutDigest: sha256('ack'), stderrDigest: sha256(''), apiErrorCodes: [] };
async function fixture(assetControls: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'deployment-continuation-')), sourceRoot = join(root, 'source');
  const configDirectory = join(root, 'config'), privateDirectory = join(root, 'private');
  const originalPath = join(configDirectory, 'deployment-123.json'), planPath = join(root, 'plan.json');
  await Promise.all([mkdir(configDirectory), mkdir(privateDirectory), mkdir(sourceRoot)]);
  const write = async (path: string, bytes: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); };
  const sourceDigests: Record<string, string> = {};
  for (const path of ['package.json', 'package-lock.json', 'infra/deploy-pilot.ts', 'infra/deployment-recovery.ts', 'infra/release-inputs.ts',
    'apps/web/dist/index.html', ...deploymentRoles.map(role => `workers/${role}/index.ts`), 'packages/protocol/src/index.ts', 'packages/protocol/wasm/module.wasm', 'migrations/001.sql']) {
    await write(join(sourceRoot, path), 'owned inert source'); sourceDigests[path] = sha256('owned inert source');
  }
  for (const [name, bytes] of Object.entries(assetControls)) {
    const path = `apps/web/dist/${name}`; await write(join(sourceRoot, path), bytes); sourceDigests[path] = sha256(bytes);
  }
  const configs: Record<string, string> = {}, bundles: Record<string, string> = {};
  for (const [index, role] of deploymentRoles.entries()) {
    const config = { account_id: accountId, name: names[index], main: join(sourceRoot, `workers/${role}/index.ts`),
      ...(role === 'app' && Object.keys(assetControls).length ? { assets: { binding: 'ASSETS', directory: join(sourceRoot, 'apps/web/dist') } } : {}) };
    await retainDeploymentJson(join(configDirectory, `${role}.json`), config); configs[role] = (await filePin(join(configDirectory, `${role}.json`))).digest;
    await write(join(configDirectory, 'bundles', role, 'index.js'), 'owned inert module'); bundles[`${role}/index.js`] = sha256('owned inert module');
  }
  await retainDeploymentJson(join(configDirectory, 'release.json'), { schemaVersion: 1, accountId, names, sourceDigests, configs });
  const release = await filePin(join(configDirectory, 'release.json'));
  const original: any = { schemaVersion: 1, operation: 'DEPLOY', status: 'UNKNOWN', initial: false, accountId,
    targetWorkerNames: names, releaseDigest: release.digest, secretAssociationsValidated: true,
    startedAt: stamp(-4000), completedAt: stamp(-2000), stages: [
      ...deploymentRoles.map(role => ({ name: `package-${role}`, status: 'LOCAL_PACKAGE_PASS' })),
      ...['projection-migration', 'deploy-authority', 'deploy-runner'].map((name, index) => ({ name, status: index === 2 ? 'UNKNOWN' : 'ACKNOWLEDGED', startedAt: stamp(-3900 + index * 500), completedAt: stamp(-3500 + index * 500) }))] };
  await retainDeploymentJson(originalPath, original);
  const pointerPath = join(privateDirectory, '.deployment-state.json');
  await retainDeploymentJson(pointerPath, { schemaVersion: 1, accountId, workerNames: names, reportPath: originalPath });
  const readbackPath = join(configDirectory, 'readback-123.json');
  const readback = { schemaVersion: 1, status: 'BLOCKED', accountId, releaseDigest: release.digest, remoteMutations: 0,
    startedAt: stamp(-1500), completedAt: stamp(-1000), workers: names.map(name => ({ name })),
    checks: continuationReadbackChecks.map(name => ({ name, status: ['app-bindings', 'app-modules'].includes(name) ? 'BLOCKED' : 'PASS', ...(name.endsWith('-modules') ? {
      detail: { moduleDigests: { 'index.js': sha256('owned inert module') },
        ...(name === 'app-modules' && Object.keys(assetControls).length ? { assetControlDigests: Object.fromEntries(Object.entries(assetControls).map(([key, bytes]) => [key, sha256(bytes)])) } : {}) },
    } : {}) })) };
  await retainDeploymentJson(readbackPath, readback);
  const evidencePath = join(root, 'operator-evidence.json'); await retainDeploymentJson(evidencePath, { status: 'OWNED_DATA_REVIEW', maintenance: true, held: 0 });
  const plan: ContinuationPlan = { schemaVersion: 1, operation: 'CONTINUE_DEPLOYMENT', sourceRoot, configDirectory, privateDirectory,
    accountId, workerNames: names, original: await filePin(originalPath), pointer: await filePin(pointerPath), release,
    readback: await filePin(readbackPath), bundles,
    review: { reviewedBy: 'owned-test', reviewedAt: stamp(-500), validUntil: stamp(300000), effectReview: 'OBSERVED_EXPECTED_EFFECT', dataObligations: 'REVIEWED', evidence: [await filePin(evidencePath)] } };
  await retainDeploymentJson(planPath, plan);
  const savePlan = () => retainDeploymentJson(planPath, plan);
  const fullReadback = async () => { const path = join(configDirectory, 'readback-999.json');
    await retainDeploymentJson(path, { ...readback, status: 'READBACK_PASS', startedAt: stamp(0), completedAt: stamp(0), checks: readback.checks.map(check => ({ ...check, status: 'PASS' })) }); return path; };
  const fence = () => assertDeploymentClear(privateDirectory, configDirectory, accountId, names, join(configDirectory, 'deployment-999.json'));
  return { root, plan, planPath, original, readback, savePlan, fullReadback, fence, write, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('observed runner effect continues exactly evaluator/projector/app and requires independent final readback', async () => {
  const f = await fixture(); let preparations = 0; const commands: string[][] = [];
  try {
    const original = await readFile(f.plan.original.path), pointer = await readFile(f.plan.pointer.path);
    await assert.rejects(f.fence(), /PRIOR_DEPLOYMENT_UNRESOLVED/);
    const result = await executeContinuation(f.planPath, { prepare: async () => { preparations++; }, run: async (_root, args) => { commands.push(args); return ack; } });
    assert.equal(result.status, 'AWAITING_READBACK'); assert.equal(preparations, 1);
    assert.deepEqual(result.stages.map(stage => stage.name), ['deploy-evaluator', 'deploy-projector', 'deploy-app']);
    assert.deepEqual(commands, ['evaluator', 'projector', 'app'].map(role => ['deploy', '--config', join(f.plan.configDirectory, `${role}.json`), '--secrets-file', join(f.plan.privateDirectory, `${role}.secrets.json`)]));
    assert.equal(result.observedEffect.stage, 'deploy-runner'); assert.equal(result.observedEffect.status, 'OBSERVED_EXPECTED_EFFECT');
    await assert.rejects(f.fence(), /PRIOR_DEPLOYMENT_UNRESOLVED/);
    await assert.rejects(finalizeContinuation(f.planPath, f.plan.readback.path), /CONTINUATION_READBACK_INVALID/);
    await finalizeContinuation(f.planPath, await f.fullReadback()); await f.fence();
    assert.equal(await validateContinuationTerminal(f.plan.original.path, accountId, names), true);
    assert.deepEqual(await readFile(f.plan.original.path), original); assert.deepEqual(await readFile(f.plan.pointer.path), pointer);
    await assert.rejects(executeContinuation(f.planPath, { prepare: async () => { preparations++; }, run: async () => ack }), /CONTINUATION_ALREADY_EXISTS/);
    assert.equal(preparations, 1);
    await assert.rejects(finalizeContinuation(f.planPath, await f.fullReadback()), /CONTINUATION_NOT_AWAITING_READBACK/);
  } finally { await f.cleanup(); }
});

test('asset controls remain separate from runtime modules and are pinned through continuation history', async () => {
  const controls = { _headers: '/*\n  Referrer-Policy: no-referrer\n', _redirects: '/old /new 301\n' };
  const f = await fixture(controls);
  try {
    await f.write(join(f.plan.configDirectory, 'bundles/app/_headers'), controls._headers);
    f.plan.bundles['app/_headers'] = sha256(controls._headers); await f.savePlan();
    const checked = await validateContinuationPlan(await filePin(f.planPath));
    await validateContinuationPayload(checked.plan, checked.release);
    assert.deepEqual(f.readback.checks.find(check => check.name === 'app-modules')!.detail!.moduleDigests,
      { 'index.js': sha256('owned inert module') });
    await executeContinuation(f.planPath, { prepare: async () => {}, run: async () => ack });
    await finalizeContinuation(f.planPath, await f.fullReadback()); await f.fence();
    await f.write(join(f.plan.sourceRoot, 'apps/web/dist/_headers'), 'future deployment headers');
    await f.fence();
    assert.equal(await validateContinuationTerminal(f.plan.original.path, accountId, names), true);
  } finally { await f.cleanup(); }
});

test('initial asset-control association cannot be omitted, changed, aliased or fabricated', async t => {
  for (const kind of ['missing', 'changed', 'extra', 'alias', 'null', 'other-role', 'legacy-extra', 'bundled-wrong', 'bundled-nested', 'bundled-other-role', 'bundled-unscoped']) await t.test(kind, async () => {
    const headers = '/*\n  Referrer-Policy: no-referrer\n';
    const f = await fixture(kind === 'legacy-extra' ? {} : { _headers: headers });
    try {
      const detail = f.readback.checks.find(check => check.name === 'app-modules')!.detail!;
      if (kind === 'missing') delete detail.assetControlDigests;
      if (kind === 'changed') detail.assetControlDigests = { _headers: sha256('changed') };
      if (kind === 'extra') detail.assetControlDigests = { _headers: sha256(headers), _redirects: sha256('unreviewed') };
      if (kind === 'alias') detail.assetControlDigests = { './_headers': sha256(headers) };
      if (kind === 'null') detail.assetControlDigests = null as any;
      if (kind === 'other-role') f.readback.checks.find(check => check.name === 'runner-modules')!.detail!.assetControlDigests = { _headers: sha256(headers) };
      if (kind === 'legacy-extra') detail.assetControlDigests = { _headers: sha256(headers) };
      if (kind.startsWith('bundled-')) {
        const path = ({ 'bundled-wrong': 'app/_headers', 'bundled-nested': 'app/nested/_headers', 'bundled-other-role': 'runner/_headers', 'bundled-unscoped': 'unscoped/_headers' } as Record<string, string>)[kind]!;
        f.plan.bundles[path] = sha256(kind === 'bundled-wrong' ? 'changed' : headers);
      }
      await retainDeploymentJson(f.plan.readback.path, f.readback); f.plan.readback = await filePin(f.plan.readback.path); await f.savePlan();
      await assert.rejects(validateContinuationPlan(await filePin(f.planPath)), /CONTINUATION_(READBACK|BUNDLE)_ASSET_CONTROL_ASSOCIATION/);
    } finally { await f.cleanup(); }
  });
});

test('final readback must independently retain the exact source-pinned asset controls', async t => {
  for (const kind of ['missing', 'changed', 'extra', 'alias']) await t.test(kind, async () => {
    const headers = '/*\n  Referrer-Policy: no-referrer\n';
    const f = await fixture({ _headers: headers });
    try {
      await executeContinuation(f.planPath, { prepare: async () => {}, run: async () => ack });
      const path = await f.fullReadback(), final = JSON.parse(await readFile(path, 'utf8'));
      const detail = final.checks.find((check: any) => check.name === 'app-modules').detail;
      if (kind === 'missing') delete detail.assetControlDigests;
      if (kind === 'changed') detail.assetControlDigests = { _headers: sha256('changed') };
      if (kind === 'extra') detail.assetControlDigests = { _headers: sha256(headers), _redirects: sha256('extra') };
      if (kind === 'alias') detail.assetControlDigests = { './_headers': sha256(headers) };
      await retainDeploymentJson(path, final);
      await assert.rejects(finalizeContinuation(f.planPath, path), /CONTINUATION_READBACK_ASSET_CONTROL_ASSOCIATION/);
      await assert.rejects(f.fence(), /PRIOR_DEPLOYMENT_UNRESOLVED/);
    } finally { await f.cleanup(); }
  });
});

test('lock and durable dispatch identity prevent overlapping or repeated continuations before credentials', async () => {
  const f = await fixture(); let calls = 0; const hooks = { prepare: async () => { calls++; }, run: async () => { calls++; return ack; } };
  try {
    const unlock = await acquireDeploymentLock(f.plan.privateDirectory);
    await assert.rejects(executeContinuation(f.planPath, hooks), /DEPLOYMENT_LOCK_PRESENT/); await unlock();
    await createContinuationRecord(continuationPath(f.plan.original.path), { status: 'STARTED' });
    await assert.rejects(executeContinuation(f.planPath, hooks), /CONTINUATION_ALREADY_EXISTS/); assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

test('any restoration sidecar conflicts with continuation before credentials or dispatch', async () => {
  const f = await fixture(); let calls = 0;
  try {
    await f.write(`${f.plan.original.path}.restoration.json`, '{');
    await assert.rejects(executeContinuation(f.planPath, { prepare: async () => { calls++; }, run: async () => { calls++; return ack; } }), /CONTINUATION_RESTORATION_CONFLICT/);
    assert.equal(calls, 0); await assert.rejects(f.fence(), /PRIOR_DEPLOYMENT_UNRESOLVED/);
  } finally { await f.cleanup(); }
});

test('a later conflicting restoration re-fences an otherwise complete continuation', async () => {
  const f = await fixture();
  try {
    await executeContinuation(f.planPath, { prepare: async () => {}, run: async () => ack });
    await finalizeContinuation(f.planPath, await f.fullReadback()); await f.fence();
    await f.write(`${f.plan.original.path}.restoration.json`, '{}');
    assert.equal(await validateContinuationTerminal(f.plan.original.path, accountId, names), false);
    await assert.rejects(f.fence(), /PRIOR_DEPLOYMENT_UNRESOLVED/);
  } finally { await f.cleanup(); }
});

test('malformed restoration ancestry on either continuation input fails before credential preparation', async t => {
  for (const target of ['original', 'pointer']) for (const value of [null, [], {}, 'malformed']) await t.test(`${target}:${JSON.stringify(value)}`, async () => {
    const f = await fixture(); let calls = 0;
    try {
      if (target === 'original') {
        f.original.restorationDependencies = value; await retainDeploymentJson(f.plan.original.path, f.original);
        f.plan.original = await filePin(f.plan.original.path);
      } else {
        const pointer = JSON.parse(await readFile(f.plan.pointer.path, 'utf8')); pointer.restorationDependencies = value;
        await retainDeploymentJson(f.plan.pointer.path, pointer); f.plan.pointer = await filePin(f.plan.pointer.path);
      }
      await f.savePlan();
      await assert.rejects(executeContinuation(f.planPath, { prepare: async () => { calls++; }, run: async () => { calls++; return ack; } }), /RESTORATION_DEPENDENCIES_INVALID/);
      assert.equal(calls, 0);
    } finally { await f.cleanup(); }
  });
});

test('historical continuation validation also refuses malformed original ancestry', async () => {
  const f = await fixture();
  try {
    await executeContinuation(f.planPath, { prepare: async () => {}, run: async () => ack });
    await finalizeContinuation(f.planPath, await f.fullReadback());
    f.original.restorationDependencies = [];
    await retainDeploymentJson(f.plan.original.path, f.original); f.plan.original = await filePin(f.plan.original.path); await f.savePlan();
    const path = continuationPath(f.plan.original.path), journal = JSON.parse(await readFile(path, 'utf8'));
    journal.originalDigest = f.plan.original.digest; journal.plan = await filePin(f.planPath); await retainDeploymentJson(path, journal);
    await assert.rejects(validateContinuationPlan(await filePin(f.planPath)), /RESTORATION_DEPENDENCIES_INVALID/);
    assert.equal(await validateContinuationTerminal(f.plan.original.path, accountId, names), false);
  } finally { await f.cleanup(); }
});

test('unknown suffix stops immediately, remains fenced, and cannot be dispatched again', async () => {
  const f = await fixture(); let calls = 0;
  try {
    await assert.rejects(executeContinuation(f.planPath, { prepare: async () => {}, run: async () => { calls++; return { ...ack, exitCode: 1, errorCategory: 'NETWORK' }; } }), /CONTINUATION_STAGE_EFFECT_UNKNOWN/);
    const journal = JSON.parse(await readFile(continuationPath(f.plan.original.path), 'utf8'));
    assert.equal(journal.status, 'UNKNOWN'); assert.deepEqual(journal.stages.map((stage: any) => [stage.name, stage.status]), [['deploy-evaluator', 'UNKNOWN']]);
    await assert.rejects(executeContinuation(f.planPath, { prepare: async () => {}, run: async () => { calls++; return ack; } }), /CONTINUATION_ALREADY_EXISTS/);
    await assert.rejects(finalizeContinuation(f.planPath, await f.fullReadback()), /CONTINUATION_NOT_AWAITING_READBACK/);
    await assert.rejects(f.fence(), /PRIOR_DEPLOYMENT_UNRESOLVED/); assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test('exception after durable STARTED retains UNKNOWN without leaking exception content', async () => {
  const f = await fixture();
  try {
    await assert.rejects(executeContinuation(f.planPath, { prepare: async () => {}, run: async () => { throw new Error('secret token should never persist'); } }), /CONTINUATION_EFFECT_UNKNOWN/);
    const raw = await readFile(continuationPath(f.plan.original.path), 'utf8'); assert(!raw.includes('secret token'));
    assert.equal(JSON.parse(raw).stages[0].status, 'UNKNOWN'); await assert.rejects(f.fence(), /PRIOR_DEPLOYMENT_UNRESOLVED/);
  } finally { await f.cleanup(); }
});

test('plan/readback identity, completed prefix and explicit review are all mandatory', async t => {
  for (const kind of ['wrong-account', 'wrong-pointer', 'missing-check', 'runner-blocked', 'duplicate-check', 'readback-mutation', 'unknown-migration', 'later-stage-present', 'readback-module-drift', 'review-missing', 'expired-review']) await t.test(kind, async () => {
    const f = await fixture(); let calls = 0;
    try {
      if (kind === 'wrong-account') f.plan.accountId = 'b'.repeat(32);
      if (kind === 'wrong-pointer') { const ptr = JSON.parse(await readFile(f.plan.pointer.path, 'utf8')); ptr.reportPath = join(f.plan.configDirectory, 'deployment-124.json'); await retainDeploymentJson(f.plan.pointer.path, ptr); f.plan.pointer = await filePin(f.plan.pointer.path); }
      if (kind === 'missing-check') f.readback.checks.pop();
      if (kind === 'runner-blocked') f.readback.checks.find(check => check.name === 'runner-modules')!.status = 'BLOCKED';
      if (kind === 'duplicate-check') f.readback.checks[0] = f.readback.checks[1]!;
      if (kind === 'readback-mutation') f.readback.remoteMutations = 1;
      if (kind === 'readback-module-drift') f.readback.checks.find(check => check.name === 'runner-modules')!.detail!.moduleDigests['index.js'] = sha256('different package');
      if (kind === 'unknown-migration') f.original.stages[5].status = 'UNKNOWN';
      if (kind === 'later-stage-present') f.original.stages.push({ name: 'deploy-evaluator', status: 'STARTED' });
      if (kind === 'review-missing') f.plan.review.dataObligations = 'PENDING' as any;
      if (kind === 'expired-review') { f.plan.review.reviewedAt = stamp(-900); f.plan.review.validUntil = stamp(-100); }
      await retainDeploymentJson(f.plan.original.path, f.original); f.plan.original = await filePin(f.plan.original.path);
      await retainDeploymentJson(f.plan.readback.path, f.readback); f.plan.readback = await filePin(f.plan.readback.path); await f.savePlan();
      await assert.rejects(executeContinuation(f.planPath, { prepare: async () => { calls++; }, run: async () => { calls++; return ack; } }), /CONTINUATION_/);
      assert.equal(calls, 0);
    } finally { await f.cleanup(); }
  });
});

test('source, config, retained bundle, pointer and report drift stop before credentials', async t => {
  for (const kind of ['source', 'new-project-model', 'new-asset', 'config', 'bundle', 'pointer', 'report']) await t.test(kind, async () => {
    const f = await fixture(); let calls = 0;
    try {
      const paths: Record<string, string> = { source: join(f.plan.sourceRoot, 'workers/app/index.ts'), 'new-asset': join(f.plan.sourceRoot, 'apps/web/dist/unreviewed'),
        'new-project-model': join(f.plan.sourceRoot, 'packages/project-model/src/validation.ts'),
        config: join(f.plan.configDirectory, 'app.json'), bundle: join(f.plan.configDirectory, 'bundles/app/index.js'), pointer: f.plan.pointer.path, report: f.plan.original.path };
      await f.write(paths[kind]!, 'drift');
      await assert.rejects(executeContinuation(f.planPath, { prepare: async () => { calls++; }, run: async () => { calls++; return ack; } }), /CONTINUATION_/); assert.equal(calls, 0);
    } finally { await f.cleanup(); }
  });
});

test('payload is revalidated between stages; drift never dispatches next suffix', async () => {
  const f = await fixture(); let calls = 0;
  try {
    await assert.rejects(executeContinuation(f.planPath, { prepare: async () => {}, run: async () => { calls++; await f.write(join(f.plan.sourceRoot, 'workers/app/index.ts'), 'changed'); return ack; } }), /CONTINUATION_SOURCE_CHANGED/);
    assert.equal(calls, 1); await assert.rejects(f.fence(), /PRIOR_DEPLOYMENT_UNRESOLVED/);
  } finally { await f.cleanup(); }
});

test('terminal fence verifies full readback bytes and original identity, across next release directory', async () => {
  const f = await fixture();
  try {
    await executeContinuation(f.planPath, { prepare: async () => {}, run: async () => ack }); const readback = await f.fullReadback(); await finalizeContinuation(f.planPath, readback);
    const next = join(f.root, 'next'); await mkdir(next);
    await assertDeploymentClear(f.plan.privateDirectory, next, accountId, names, join(next, 'deployment-999.json'));
    // Reconciled history is independent of subsequently edited deployment source.
    await f.write(join(f.plan.sourceRoot, 'workers/app/index.ts'), 'future source'); await f.fence();
    const bytes = await readFile(readback); await f.write(readback, '{}'); await assert.rejects(f.fence(), /PRIOR_DEPLOYMENT_UNRESOLVED/); await writeFile(readback, bytes);
    await f.write(f.plan.original.path, JSON.stringify({ ...f.original, status: 'UNKNOWN', reason: 'CHANGED' }));
    await assert.rejects(f.fence(), /PRIOR_DEPLOYMENT_UNRESOLVED/);
  } finally { await f.cleanup(); }
});

test('finite diagnostics persist no raw provider text and do not mistake output wording for success', async () => {
  assert.equal(stageErrorCategory('Worker version was deployed, but we could not finish applying settings: SECRET', false, 1), 'POST_UPLOAD_CONTAINER_SETTINGS');
  assert.equal(stageErrorCategory('fetch failed SECRET', false, 1), 'NETWORK');
  assert.equal(stageErrorCategory('token-expired SECRET', false, 1), 'AUTHENTICATION');
  assert.equal(stageErrorCategory('[code: 10000] SECRET', false, 1), 'PROVIDER_API');
  assert.equal(stageErrorCategory('arbitrary SECRET', false, 1), 'CLI_FAILURE');
  assert.equal(stageErrorCategory('', true, 0), 'TIMEOUT');
  const root = await mkdtemp(join(tmpdir(), 'owned-wrangler-stage-'));
  try {
    await mkdir(join(root, 'node_modules/wrangler/bin'), { recursive: true });
    await writeFile(join(root, 'node_modules/wrangler/bin/wrangler.js'), "process.stderr.write('Worker version was deployed, but we could not finish applying settings: SECRET [code: 10000]'); process.exitCode=1;");
    const result = await runWranglerStage(root, [], false, 5000);
    assert.equal(result.errorCategory, 'POST_UPLOAD_CONTAINER_SETTINGS'); assert.deepEqual(result.apiErrorCodes, [10000]); assert.equal(result.exitCode, 1);
    assert(!JSON.stringify(result).includes('SECRET')); assert.match(result.stderrDigest, /^sha256:[a-f0-9]{64}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('a descendant retaining inherited output cannot leave the stage pending indefinitely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owned-wrangler-pipe-')); let childPid: number | undefined;
  try {
    await mkdir(join(root, 'node_modules/wrangler/bin'), { recursive: true });
    await writeFile(join(root, 'node_modules/wrangler/bin/wrangler.js'), `
      const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs');
      const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:['ignore',process.stdout,process.stderr]});
      writeFileSync('owned-child.pid',String(child.pid)); child.unref();
    `);
    const started = Date.now(), result = await runWranglerStage(root, [], false, 5000);
    childPid = Number(await readFile(join(root, 'owned-child.pid'), 'utf8'));
    assert.equal(result.exitCode, 0); assert.equal(result.errorCategory, 'OUTPUT_DRAIN_TIMEOUT');
    assert(Date.now() - started < 4000, 'bounded output drain should settle before the overall stage timeout');
  } finally { if (childPid) process.kill(childPid, 'SIGKILL'); await rm(root, { recursive: true, force: true }); }
});
