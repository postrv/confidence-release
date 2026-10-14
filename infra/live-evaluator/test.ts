// SPDX-License-Identifier: Apache-2.0
// Owned local tests. Synthetic signed records here never become a provider PASS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { initializeKernel } from '../../packages/protocol/src/node.ts';
import { canonicalize, decodeBase64, digest, encodeBase64, getKernel, issuedStatement, sha256, signStatement, type TrustConfig, type Outcome } from '../../packages/protocol/src/index.ts';
import { testKey } from '../../tests/conformance/vector.ts';
import { buildSource, fixturePaths, ownedNames } from './source.ts';
import { requests, runScope } from './requests.ts';
import { registeredGenerationDiagnostics } from './diagnostics.ts';
import { probes, values } from '../../workers/evaluator/recipes.ts';
import { awaitDeploymentAssociations, boundedBytes, deployedModulesMatch, deploymentAssociations, dispatchOnce, endpointOwned, evaluateProof, managedImageOwned, validatePrepared, type AssociationAttempt } from './client.ts';
import { main, templates } from '../live-evaluator-check.ts';
import type { PreparedRun, Phase, RetainedCallback } from './types.ts';
await initializeKernel();
test('registered diagnostics are bounded concurrent read-only calls and isolate unavailable journals', async () => {
  const keys = Array.from({ length: 20 }, (_, index) => index.toString(16).padStart(64, '0'));
  const calls: string[] = [], started = Date.now();
  const pending = registeredGenerationDiagnostics(keys, async key => {
    calls.push(key);
    if (key === keys[0]) return { phase: 'STOPPED', executionStage: 'outbound-intercept', recoveryEvents: [] };
    if (key === keys[1]) throw new Error('PRIVATE_DIAGNOSTIC_CANARY');
    return new Promise<never>(() => {});
  });
  await Promise.resolve(); assert.deepEqual(calls, keys);
  const result = await pending;
  assert.ok(Date.now() - started < 8000, 'Journal deadlines must run concurrently, not once per job');
  assert.deepEqual(result[keys[0]], { inspection: 'OBSERVED', state: { phase: 'STOPPED', executionStage: 'outbound-intercept', recoveryEvents: [] } });
  for (const key of keys.slice(1)) assert.deepEqual(result[key], { inspection: 'UNKNOWN', state: null });
  assert.equal(JSON.stringify(result).includes('PRIVATE_DIAGNOSTIC_CANARY'), false);
  for (const invalid of [[...keys, 'f'.repeat(64)], [keys[0], keys[0]], ['caller-selected-name']]) {
    await assert.rejects(registeredGenerationDiagnostics(invalid, async () => { throw new Error('Unregistered read must never run'); }), /OWNED_DIAGNOSTIC_PLAN_BOUND/);
  }
});
const runId = '69c7cf2d-7fd1-4624-9887-8bf2aebf81f1'; // Public deterministic identity only; not a live target.
const base = Object.fromEntries(await Promise.all(fixturePaths.map(async name => [name, await readFile(resolve('fixtures/collaboration-demo', name), 'utf8')])));
const good = await buildSource(base, 'good', runId), bad = await buildSource(base, 'bad', runId), sources = { good, bad };
const account = '1'.repeat(32), image = `registry.cloudflare.com/${account}/${ownedNames(runId).evaluator}-conformanceevaluation-base@sha256:${'2'.repeat(64)}`, checkerDigest = 'sha256:' + '3'.repeat(64);
const checker = await testKey('71'), rootKey = await testKey('72');
const trust: TrustConfig = { schemaVersion: 1, scope: runScope(runId), keysetRevision: '1', keys: [{ id: 'owned-root', publicKeyBase64: encodeBase64(new Uint8Array(await crypto.subtle.exportKey('raw', rootKey.publicKey))), roles: ['root'] }, { id: 'owned-checker', publicKeyBase64: encodeBase64(new Uint8Array(await crypto.subtle.exportKey('raw', checker.publicKey))), roles: ['checker'] }] };
const prepared: PreparedRun = { schemaVersion: 1, runId, scope: runScope(runId), names: ownedNames(runId), createdAt: '2026-10-05T00:00:00Z', sourceDigests: { fixed: 'sha256:' + '4'.repeat(64) }, fixtureDigests: { good: await digest(good), bad: await digest(bad) }, sourceRevision: '5'.repeat(40), sourceDirty: false };
const registered = await requests(sources, { runId, imageDigest: image.split('@')[1], checkerDigest, checkerKeyId: 'owned-checker' });
async function fixture(allBadPass = false, restartError = 'Evaluator continuation was lost; its generation is fenced and termination is observed separately.') {
  const callbacks: RetainedCallback[] = [], snapshot: any = { runId, scope: runScope(runId), trust, sources: { good: await digest(sources.good), bad: await digest(sources.bad) }, scheduler: {}, jobs: [] };
  for (const task of registered) {
    const outcome: Outcome = task.category === 'bad' && !allBadPass ? 'FAIL' : task.category === 'restart-fault' ? 'INCONCLUSIVE' : 'PASS';
    const overlap = task.request.job.id.endsWith(':overlapping-read-write'), value = values(probes.find(probe => probe.id === 'overlapping-read-write')!);
    const backingStore = overlap ? { active: false, value: value.replacement, reads: task.category === 'bad' && !allBadPass ? 1 : 2,
      accesses: [{ method: 'GET', value: value.initial }, { method: 'PUT', value: value.replacement }, ...(task.category === 'bad' && !allBadPass ? [] : [{ method: 'GET', value: value.replacement }])],
      readBarrier: { phase: 'FENCED', capturedValue: value.initial } } : { active: false };
    const observation = { jobId: task.request.job.id, inputDigest: task.request.job.inputDigest, candidateDigest: task.request.candidate.digest, outcome, scope: task.request.scope, evaluation: task.request.evaluation, terminationObserved: true, error: task.category === 'restart-fault' ? restartError : null, backingStore,
      observations: [{ kind: 'source-hydration', files: 4, modes: 'verified-regular-644-or-755', inventory: 'exact' }, ...(overlap ? [
        { action: 'overlap-captured', observed: value.initial, storeReadCount: 1 }, { action: 'write', observed: value.replacement, status: 200 },
        { action: 'overlap-released', afterWriteStatus: 200 }, { action: 'overlap-read', observed: value.initial, status: 200 },
        { action: 'read', observed: task.category === 'bad' && !allBadPass ? value.initial : value.replacement, status: 200 },
      ] : [])] };
    const identity = { id: `evidence-${task.jobKey}`, jobId: task.request.job.id, inputDigest: task.request.job.inputDigest, observationDigest: await digest(observation), candidateId: task.request.candidate.id, candidateDigest: task.request.candidate.digest, outcome, evidenceClass: 'protected-behavioural' as const, authorized: true };
    const evidence = { ...identity, digest: await digest(identity) }, envelope = await signStatement(await issuedStatement('evidence', evidence, task.request.issuance!), 'owned-checker', checker.privateKey);
    const callback: RetainedCallback = { scope: task.request.scope, evidence, envelope, observationBase64: encodeBase64(new TextEncoder().encode(canonicalize(observation))) }; callbacks.push(callback);
    snapshot.scheduler[task.jobKey] = { status: 'DONE' };
    const deadline = 1791160000000, callbackDigest = await digest(callback);
    const native = { jobKey: task.jobKey, jobId: task.request.job.id, requestDigest: task.requestDigest, configuredImage: image, phase: 'STOPPED', deadline, container: null, terminationObserved: true, callbackDelivered: true, callbackDigest, observedAt: '2026-10-05T00:00:00.500Z', abortIntent: task.category === 'restart-fault', controllerInstanceId: '11111111-1111-4111-8111-111111111111', abortRequest: task.category === 'restart-fault' ? { controllerInstanceId: '22222222-2222-4222-8222-222222222222', jobKey: task.jobKey, jobId: task.request.job.id, requestDigest: task.requestDigest, phase: 'RUNNING', deadline, observedAt: deadline - 1 } : null };
    const rejectionWitness = task.category === 'callback-fault' ? {
      schemaVersion: 1, runId, jobKey: task.jobKey, jobId: task.request.job.id, requestDigest: task.requestDigest,
      sourceDigest: await digest(sources.good), candidateDigest: task.request.candidate.digest, inputDigest: task.request.job.inputDigest,
      callbackDigest, evidenceDigest: evidence.digest, observationDigest: evidence.observationDigest,
      responseStatus: 503, deliveryNumber: 1, captureStartedAt: '2026-10-05T00:00:00.000Z', capturedAt: '2026-10-05T00:00:01.000Z',
      native: { ...native, callbackDelivered: false }, scheduler: { digest: task.requestDigest, object: task.requestDigest, status: 'ACTIVE', priority: 0 },
    } : null;
    snapshot.jobs.push({ category: task.category, dispatch: 'ACKNOWLEDGED', requestDigest: task.requestDigest, native, fixture: { state: structuredClone(backingStore), closed: true }, callback: { digest: callbackDigest, deliveries: task.category === 'callback-fault' ? 2 : 1, rejectedOnce: task.category === 'callback-fault', rejectionWitness } });
  }
  return { prepared, image, checkerDigest, trust, snapshot, callbacks, sources };
}
test('default driver is BLOCKED and makes no network calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owned-evaluator-default-')), original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('FORBIDDEN_TEST_NETWORK'); };
  try { const report = await main(['--out', join(dir, 'report.json')]); assert.equal(report.status, 'BLOCKED'); assert.equal(report.providerGatePassed, false); assert.equal(calls, 0); assert.equal(report.remoteMutations, 0); }
  finally { globalThis.fetch = original; await rm(dir, { recursive: true, force: true }); }
});
test('owned names and endpoint reject arbitrary account targets', () => {
  assert.throws(() => ownedNames('existing-project'), /OWNED_RUN_ID/); assert.equal(endpointOwned('https://example.com/', prepared.names.controller), false);
  assert.equal(endpointOwned(`https://${prepared.names.controller}.owned.workers.dev/`, prepared.names.controller), true); assert.equal(endpointOwned(`https://${prepared.names.controller}.owned.workers.dev/?token=secret`, prepared.names.controller), false);
});
test('both four-file source packages verify complete strong raw Git closure', async () => {
  for (const source of [good, bad]) { const checked = JSON.parse(getKernel().validate_git_source(canonicalize({ candidate: source.candidate, manifest: source.manifest, gitObjects: source.objects }))); assert.equal(checked.valid, true); assert.equal(source.manifest.entries.length, 4); assert.equal(source.objects.length, 6); }
  assert.notEqual(good.candidate.digest, bad.candidate.digest); assert.notEqual(good.candidate.commitBytesDigest, bad.candidate.commitBytesDigest);
  const forged = bad.objects.filter(object => object.type === 'blob').map(object => new TextDecoder().decode(decodeBase64(object.dataBase64))).join('\n'); assert.match(forged, /outcome:"PASS"/);
});
test('unexpected fixture inventory or changed transform fails visibly', async () => {
  await assert.rejects(buildSource({ ...base, 'extra.mjs': 'export {}' }, 'good', runId), /INVENTORY/);
  await assert.rejects(buildSource({ ...base, 'cache.mjs': 'export const cacheTtlMs = 999;' }, 'good', runId), /TRANSFORM/);
});
test('mode or raw commit substitution fails source verification', () => {
  const changed = structuredClone(good); changed.manifest.entries[0].mode = '100755'; assert.equal(JSON.parse(getKernel().validate_git_source(canonicalize({ candidate: changed.candidate, manifest: changed.manifest, gitObjects: changed.objects }))).valid, false);
  const substituted = structuredClone(good); substituted.objects.find(object => object.type === 'commit')!.dataBase64 = encodeBase64(new TextEncoder().encode('tree ' + 'a'.repeat(40) + '\n\nsubstitute\n')); assert.equal(JSON.parse(getKernel().validate_git_source(canonicalize({ candidate: substituted.candidate, manifest: substituted.manifest, gitObjects: substituted.objects }))).valid, false);
});
test('registration freezes18 normal jobs plus2 distinct bounded fault identities', () => {
  assert.equal(registered.length, 20); assert.equal(new Set(registered.map(task => task.jobKey)).size, 20); assert.equal(new Set(registered.map(task => task.request.job.id)).size, 20);
  assert.equal(registered.filter(task => task.category === 'good').length, 9); assert.equal(registered.filter(task => task.category === 'bad').length, 9);
  const normal = registered.find(task => task.category === 'good')!, repeat = registered.find(task => task.category === 'callback-fault')!;
  assert.equal(normal.request.job.inputDigest, repeat.request.job.inputDigest); assert.notEqual(normal.jobKey, repeat.jobKey); // Same semantic input, separate physical job.
});
test('local complete synthetic proof is explicitly finite', async () => { const result = await evaluateProof(await fixture()); assert.equal(result.goodRequiredJobs, 9); assert.equal(result.stoppedGenerations, 20); assert.equal(result.heldSlotWitnesses, 1); });
test('absent restart fixture needs an exact closed fence; normal jobs need retained inactive state', async () => {
  const absent = await fixture(); const restart = absent.snapshot.jobs.find((row: any) => row.category === 'restart-fault'); restart.fixture.state = null;
  assert.equal((await evaluateProof(absent)).stoppedGenerations, 20);
  restart.fixture.closed = false; await assert.rejects(evaluateProof(absent), /FIXTURE_FENCE/);
  const normal = await fixture(); normal.snapshot.jobs[0].fixture.state = null; await assert.rejects(evaluateProof(normal), /FIXTURE_FENCE/);
  const inactiveWithoutFence = await fixture(); inactiveWithoutFence.snapshot.jobs[0].fixture.closed = false; await assert.rejects(evaluateProof(inactiveWithoutFence), /FIXTURE_FENCE/);
  const active = await fixture(); active.snapshot.jobs[0].fixture.state.active = true; await assert.rejects(evaluateProof(active), /FIXTURE_FENCE/);
});
test('restart proof requires a new construction and exact prior running provenance plus signed continuation loss', async () => {
  for (const mutate of [
    (row: any) => { row.native.controllerInstanceId = row.native.abortRequest.controllerInstanceId; },
    (row: any) => { row.native.abortRequest = null; },
    (row: any) => { row.native.abortRequest.phase = 'RESERVED'; },
    (row: any) => { row.native.abortRequest.jobId = 'unrelated-job'; },
    (row: any) => { row.native.abortRequest.deadline++; },
    (row: any) => { row.native.abortRequest.observedAt = row.native.deadline; },
  ]) { const input = await fixture(); mutate(input.snapshot.jobs.find((row: any) => row.category === 'restart-fault')); await assert.rejects(evaluateProof(input), /RESTART_RECONCILIATION/); }
  await assert.rejects(evaluateProof(await fixture(false, 'Whole-container termination remains uncertain.')), /RESTART_RECONCILIATION/);
});
test('managed image owns exact script-class-image repository, rejecting prefix aliases', () => {
  assert.equal(managedImageOwned(image, account, prepared.names.evaluator), true);
  for (const wrong of [image.replace('-conformanceevaluation-base@', '-foreign-conformanceevaluation-base@'), image.replace('-conformanceevaluation-base@', '-conformanceevaluation-base-foreign@'), image.replace(account, '9'.repeat(32)), image.replace('-conformanceevaluation-base@', '-anotherevaluation-base@'), image.replace('@sha256:', ':tag@sha256:')]) assert.equal(managedImageOwned(wrong, account, prepared.names.evaluator), false);
});
async function deploymentFixture() {
  const configs = await templates(prepared, account, checkerDigest, { root: trust.keys[0].publicKeyBase64, checker: trust.keys[1].publicKeyBase64 }, 1791160000000, image);
  const ids: Record<string, string> = { EVALUATIONS: 'a'.repeat(32), SCHEDULER: 'b'.repeat(32), FIXTURES: 'c'.repeat(32), CONTROL: 'd'.repeat(32) };
  const settings = (config: any) => ({ compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags, bindings: [
    ...Object.entries(config.vars).map(([name, text]) => ({ name, text, type: 'plain_text' })), ...config.secrets.required.map((name: string) => ({ name, type: 'secret_text' })),
    ...config.r2_buckets.map((value: any) => ({ name: value.binding, type: 'r2_bucket', bucket_name: value.bucket_name })), ...config.services.map((value: any) => ({ name: value.binding, type: 'service', service: value.service })),
    ...config.durable_objects.bindings.map((value: any) => ({ name: value.name, type: 'durable_object_namespace', class_name: value.class_name, namespace_id: ids[value.name], ...(value.script_name ? { script_name: value.script_name } : {}) })),
  ] });
  const input = { prepared, account, image, configs, evaluator: settings(configs.evaluator), controller: settings(configs.controller), application: { id: 'e'.repeat(32), name: prepared.names.container, scheduling_policy: 'durable_object', durable_objects: { namespace_id: ids.EVALUATIONS } } };
  return input;
}
test('both deployed Workers require exact configs, capabilities and namespace/application associations', async () => {
  const input = await deploymentFixture();
  assert.equal(deploymentAssociations(input).namespaces.CONTROL.namespaceId, 'd'.repeat(32));
  const binding = (value: any, role: string, name: string) => value[role].bindings.find((item: any) => item.name === name);
  for (const mutate of [
    (v: any) => { v.evaluator.compatibility_date = '2026-09-01'; }, (v: any) => { v.controller.compatibility_flags = []; },
    (v: any) => { binding(v, 'controller', 'RUN_ID').text = 'another-run'; }, (v: any) => { binding(v, 'evaluator', 'EVALUATION_IMAGE_DIGEST').text = 'UNCONFIGURED'; },
    (v: any) => { binding(v, 'evaluator', 'OBJECTS').bucket_name = 'foreign'; }, (v: any) => { binding(v, 'controller', 'OBJECTS').bucket_name = 'foreign'; },
    (v: any) => { binding(v, 'evaluator', 'AUTHORITY').service = 'foreign'; }, (v: any) => { binding(v, 'controller', 'EVALUATOR').service = 'foreign'; },
    (v: any) => { binding(v, 'controller', 'EVALUATOR').environment = 'staging'; }, (v: any) => { binding(v, 'controller', 'EVALUATOR').entrypoint = 'other'; },
    (v: any) => { binding(v, 'controller', 'EVALUATIONS').namespace_id = 'f'.repeat(32); }, (v: any) => { binding(v, 'controller', 'FIXTURES').class_name = 'Foreign'; },
    (v: any) => { binding(v, 'controller', 'SCHEDULER').script_name = 'foreign'; }, (v: any) => { binding(v, 'evaluator', 'SCHEDULER').namespace_id = 'a'.repeat(32); },
    (v: any) => { binding(v, 'evaluator', 'CHECKER_SIGNING_KEY').type = 'plain_text'; }, (v: any) => { v.controller.bindings.push({ name: 'UNEXPECTED', type: 'service', service: 'foreign' }); },
    (v: any) => { v.evaluator.bindings.pop(); }, (v: any) => { v.application.durable_objects.namespace_id = 'f'.repeat(32); }, (v: any) => { v.application.scheduling_policy = 'regional'; },
  ]) { const wrong = structuredClone(input); mutate(wrong); assert.throws(() => deploymentAssociations(wrong), /DEPLOYED_|APPLICATION_/); }
});
test('deployment readback converges only after missing, extra and association mismatches all clear', async () => {
  const input = await deploymentFixture(), attempts: AssociationAttempt[] = [], signals: AbortSignal[] = [];
  let reads = 0;
  const association = await awaitDeploymentAssociations({ expected: input, bounds: { timeoutMs: 2000, intervalMs: 0, maximumAttempts: 4 },
    read: async signal => {
      signals.push(signal); const observed = structuredClone(input); reads++;
      if (reads === 1) observed.evaluator.bindings = observed.evaluator.bindings.filter(binding => binding.name !== 'CHECKER_SIGNING_KEY');
      if (reads === 2) observed.controller.bindings.push({ name: 'UNEXPECTED', type: 'service', service: 'foreign' } as any);
      if (reads === 3) observed.application.durable_objects.namespace_id = 'f'.repeat(32);
      return { ...observed, observed: true };
    }, retain: async attempt => { attempts.push(attempt); },
  });
  assert.equal(reads, 4); assert.equal(association.namespaceId, 'a'.repeat(32)); assert.ok(signals.every(signal => signal.aborted));
  assert.deepEqual(attempts.map(attempt => attempt.reason), ['DEPLOYED_BINDING_SET_MISMATCH', 'DEPLOYED_BINDING_SET_MISMATCH', 'APPLICATION_NAMESPACE_ASSOCIATION_MISMATCH', null]);
  assert.deepEqual(attempts[0].bindings.evaluator.missing, ['CHECKER_SIGNING_KEY']);
  assert.deepEqual(attempts[1].bindings.controller.extra, ['UNEXPECTED']);
  assert.equal(attempts[3].status, 'PASS');
  assert.equal(attempts[3].bindings.evaluator.observedCount, 10); assert.equal(attempts[3].bindings.controller.observedCount, 17);
});
test('a persistent extra deployed capability remains blocked at the read-only attempt limit', async () => {
  const input = await deploymentFixture(), attempts: AssociationAttempt[] = []; let reads = 0;
  input.evaluator.bindings.push({ name: 'UNEXPECTED', type: 'service', service: 'foreign' } as any);
  await assert.rejects(awaitDeploymentAssociations({ expected: input, bounds: { timeoutMs: 2000, intervalMs: 0, maximumAttempts: 3 },
    read: async () => { reads++; return { ...input, observed: true }; }, retain: async attempt => { attempts.push(attempt); },
  }), /DEPLOYMENT_ASSOCIATION_NOT_CONVERGED/);
  assert.equal(reads, 3); assert.equal(attempts.length, 3);
  assert.ok(attempts.every(attempt => attempt.status === 'RETRY' && attempt.reason === 'DEPLOYED_BINDING_SET_MISMATCH'));
});
test('deployment convergence retains binding names and types without secret, variable or error text', async () => {
  const input = await deploymentFixture(), attempts: AssociationAttempt[] = []; let reads = 0;
  for (const settings of [input.evaluator, input.controller]) for (const binding of settings.bindings) {
    if (binding.type === 'secret_text') (binding as any).text = 'PRIVATE_SECRET_CANARY';
    if (binding.type === 'plain_text') (binding as any).text = 'PRIVATE_VARIABLE_CANARY';
  }
  await assert.rejects(awaitDeploymentAssociations({ expected: input, bounds: { timeoutMs: 2000, intervalMs: 0, maximumAttempts: 2 },
    read: async () => { if (++reads === 1) throw new Error('PRIVATE_EXCEPTION_CANARY'); return { ...input, observed: true }; }, retain: async attempt => { attempts.push(attempt); },
  }), /DEPLOYMENT_ASSOCIATION_NOT_CONVERGED/);
  assert.deepEqual(attempts.map(attempt => attempt.reason), ['DEPLOYMENT_ASSOCIATION_READ_FAILED', 'DEPLOYED_PLAIN_VAR_MISMATCH']);
  assert.equal(attempts[0].bindings.evaluator.observedCount, null);
  assert.equal(JSON.stringify(attempts).includes('PRIVATE_'), false);
  assert.ok(attempts[1].bindings.evaluator.actualBindings.some(binding => binding.name === 'CHECKER_SIGNING_KEY' && binding.type === 'secret_text'));
});
test('a never-resolving deployment read is aborted within the shared polling deadline', async () => {
  const input = await deploymentFixture(), attempts: AssociationAttempt[] = []; let reads = 0, readSignal: AbortSignal | undefined;
  const started = Date.now();
  await assert.rejects(awaitDeploymentAssociations({ expected: input, bounds: { timeoutMs: 25, intervalMs: 0, maximumAttempts: 12 },
    read: async signal => { reads++; readSignal = signal; return new Promise<never>(() => {}); }, retain: async attempt => { attempts.push(attempt); },
  }), /DEPLOYMENT_ASSOCIATION_NOT_CONVERGED/);
  assert.equal(reads, 1); assert.equal(readSignal?.aborted, true); assert.ok(Date.now() - started < 1000);
  assert.equal(attempts.length, 1); assert.equal(attempts[0].reason, 'DEPLOYMENT_ASSOCIATION_READ_DEADLINE');
});
test('association evidence retention failure stops retries and invalid poll bounds dispatch no reads', async () => {
  const input = await deploymentFixture(); let reads = 0;
  const read = async () => { reads++; return { ...input, observed: true }; };
  await assert.rejects(awaitDeploymentAssociations({ expected: input, read, retain: async () => { throw new Error('OWNED_RETAIN_FAILURE'); } }), /OWNED_RETAIN_FAILURE/);
  assert.equal(reads, 1);
  for (const bounds of [{ timeoutMs: 45001, intervalMs: 0, maximumAttempts: 1 }, { timeoutMs: 1000, intervalMs: 0, maximumAttempts: 13 }]) {
    await assert.rejects(awaitDeploymentAssociations({ expected: input, read, retain: async () => {}, bounds }), /INVALID_ASSOCIATION_POLL_BOUNDS/);
  }
  assert.equal(reads, 1);
});
test('missing job, active native generation or unreleased scheduler slot cannot pass', async () => {
  const missing = await fixture(); missing.snapshot.jobs.pop(); await assert.rejects(evaluateProof(missing), /INCOMPLETE_PLAN/);
  const active = await fixture(); active.snapshot.jobs[0].native.container = { image, labels: {} }; await assert.rejects(evaluateProof(active), /NATIVE_STOP/);
  const held = await fixture(); held.snapshot.scheduler[registered[0].jobKey].status = 'ACTIVE'; await assert.rejects(evaluateProof(held), /NATIVE_STOP/);
});
test('wrong configured image or mismatched job identity cannot pass', async () => {
  const wrong = await fixture(); wrong.snapshot.jobs[0].native.configuredImage = image.replace('2'.repeat(64), '9'.repeat(64)); await assert.rejects(evaluateProof(wrong), /NATIVE_STOP/);
  const identity = await fixture(); identity.snapshot.jobs[0].native.requestDigest = 'sha256:' + '0'.repeat(64); await assert.rejects(evaluateProof(identity), /JOB_IDENTITY/);
});
test('altered signed envelope and observation bytes reject', async () => {
  const signature = await fixture(); signature.callbacks[0].envelope.signatures[0].sig = 'A'.repeat(88); signature.snapshot.jobs[0].callback.digest = signature.snapshot.jobs[0].native.callbackDigest = await digest(signature.callbacks[0]); await assert.rejects(evaluateProof(signature), /SIGNED_EVIDENCE/);
  const bytes = await fixture(); bytes.callbacks[0].observationBase64 = encodeBase64(new TextEncoder().encode('{}')); bytes.snapshot.jobs[0].callback.digest = bytes.snapshot.jobs[0].native.callbackDigest = await digest(bytes.callbacks[0]); await assert.rejects(evaluateProof(bytes), /EVIDENCE_BINDING/);
});
test('even signed overlap evidence requires capture, acknowledged write, ordered release and matching fixture fence', async () => {
  for (const mutate of [
    (observation: any) => { observation.observations.splice(3, 1); },
    (observation: any) => { observation.observations.find((entry: any) => entry.action === 'write').status = 500; },
    (observation: any) => { observation.backingStore.readBarrier.capturedValue++; },
    (observation: any) => { observation.observations.find((entry: any) => entry.action === 'read').observed = -1; },
    (observation: any) => { observation.observations.find((entry: any) => entry.action === 'overlap-read').observed = -1; },
    (observation: any) => { observation.backingStore.accesses.push({ method: 'PUT', value: observation.backingStore.value }); },
    (observation: any) => { observation.backingStore.accesses[2].value = observation.backingStore.readBarrier.capturedValue; },
    (observation: any) => { observation.backingStore.reads++; },
  ]) {
    const input = await fixture(); await rewriteOverlap(input, mutate);
    await assert.rejects(evaluateProof(input), /OVERLAP_/);
  }
});
async function rewriteOverlap(input: Awaited<ReturnType<typeof fixture>>, mutate: (observation: any) => void) {
  const task = registered.find(task => task.category === 'good' && task.request.job.id.endsWith(':overlapping-read-write'))!;
  const callback = input.callbacks.find(callback => callback.evidence.jobId === task.request.job.id)!;
  const observation = JSON.parse(new TextDecoder().decode(decodeBase64(callback.observationBase64))); mutate(observation);
  callback.observationBase64 = encodeBase64(new TextEncoder().encode(canonicalize(observation)));
  const { digest: _old, ...identity } = callback.evidence; identity.observationDigest = await digest(observation);
  callback.evidence = { ...identity, digest: await digest(identity) };
  callback.envelope = await signStatement(await issuedStatement('evidence', callback.evidence, task.request.issuance!), 'owned-checker', checker.privateKey);
  const row = input.snapshot.jobs.find((row: any) => row.native.jobKey === task.jobKey);
  row.fixture.state = structuredClone(observation.backingStore);
  row.native.callbackDigest = row.callback.digest = await digest(callback);
}
test('independent signed oracle accepts a retried overlapping read and bounded replacement-only store reads', async () => {
  for (const retryReads of [1, 2, 126]) {
    const input = await fixture();
    await rewriteOverlap(input, observation => {
      observation.observations.find((entry: any) => entry.action === 'overlap-read').observed = observation.backingStore.value;
      observation.backingStore.accesses.splice(2, Infinity, ...Array.from({ length: retryReads }, () => ({ method: 'GET', value: observation.backingStore.value })));
      observation.backingStore.reads = retryReads + 1;
    });
    assert.equal((await evaluateProof(input)).status, 'PASS');
  }
  const overBound = await fixture();
  await rewriteOverlap(overBound, observation => {
    observation.backingStore.accesses.splice(2, Infinity, ...Array.from({ length: 127 }, () => ({ method: 'GET', value: observation.backingStore.value })));
    observation.backingStore.reads = 128;
  });
  await assert.rejects(evaluateProof(overBound), /OVERLAP_STORE_TRACE_UNOBSERVED/);
});
test('callback repetition, observed restart and bad rejection are required', async () => {
  const callback = await fixture(); callback.snapshot.jobs.find((row: any) => row.category === 'callback-fault').callback.deliveries = 1; await assert.rejects(evaluateProof(callback), /CALLBACK_RETRY/);
  const restart = await fixture(); restart.snapshot.jobs.find((row: any) => row.category === 'restart-fault').native.abortIntent = false; await assert.rejects(evaluateProof(restart), /RESTART/);
  await assert.rejects(evaluateProof(await fixture(true)), /EXTERNAL_ORACLE/);
});
test('callback retry requires a bounded first-503 native-undelivered ACTIVE-slot witness for the same source and job', async () => {
  const valid = await fixture();
  const changedSource = structuredClone(valid); changedSource.snapshot.sources.good = 'sha256:' + '0'.repeat(64);
  await assert.rejects(evaluateProof(changedSource), /SOURCE_PACKAGE_MISMATCH/);
  const mutations: [string, (row: any) => void][] = [
    ['missing witness', row => { delete row.callback.rejectionWitness; }],
    ['wrong response', row => { row.callback.rejectionWitness.responseStatus = 200; }],
    ['wrong delivery', row => { row.callback.rejectionWitness.deliveryNumber = 2; }],
    ['wrong job', row => { row.callback.rejectionWitness.jobId = 'other-job'; }],
    ['wrong request', row => { row.callback.rejectionWitness.requestDigest = 'sha256:' + '0'.repeat(64); }],
    ['wrong source', row => { row.callback.rejectionWitness.sourceDigest = 'sha256:' + '0'.repeat(64); }],
    ['wrong callback', row => { row.callback.rejectionWitness.callbackDigest = 'sha256:' + '0'.repeat(64); }],
    ['wrong evidence', row => { row.callback.rejectionWitness.evidenceDigest = 'sha256:' + '0'.repeat(64); }],
    ['native already delivered', row => { row.callback.rejectionWitness.native.callbackDelivered = true; }],
    ['native callback changed', row => { row.callback.rejectionWitness.native.callbackDigest = 'sha256:' + '0'.repeat(64); }],
    ['native generation changed', row => { row.callback.rejectionWitness.native.deadline++; }],
    ['slot not active', row => { row.callback.rejectionWitness.scheduler.status = 'QUEUED'; }],
    ['slot belongs to another request', row => { row.callback.rejectionWitness.scheduler.digest = 'sha256:' + '0'.repeat(64); }],
    ['capture too slow', row => { row.callback.rejectionWitness.capturedAt = '2026-10-05T00:00:03.000Z'; }],
    ['native observation stale', row => { row.callback.rejectionWitness.native.observedAt = '2026-10-04T00:00:00.000Z'; }],
  ];
  for (const [name, mutate] of mutations) {
    const input = structuredClone(valid), row = input.snapshot.jobs.find((value: any) => value.category === 'callback-fault');
    mutate(row); await assert.rejects(evaluateProof(input), /CALLBACK_HELD_SLOT_WITNESS_UNOBSERVED/, name);
  }
});
test('possible effect commits before dispatch and cannot be repeated after a lost response', async () => {
  let phase: Phase = 'NOT_DISPATCHED', calls = 0; const writes: Phase[] = []; const read = () => phase, write = async (next: Phase) => { phase = next; writes.push(next); };
  await assert.rejects(dispatchOnce(read, write, async () => { assert.equal(phase, 'MAY_HAVE_DISPATCHED'); calls++; throw new Error('OWNED_LOST_REPLY'); }), /LOST_REPLY/);
  assert.equal(phase, 'UNKNOWN'); await assert.rejects(dispatchOnce(read, write, async () => { calls++; }), /MUST_NOT_REPEAT/); assert.equal(calls, 1); assert.deepEqual(writes, ['MAY_HAVE_DISPATCHED', 'UNKNOWN']);
});
test('failed durable intention prevents dispatch', async () => { let calls = 0; await assert.rejects(dispatchOnce(() => 'NOT_DISPATCHED', async () => { throw new Error('OWNED_FSYNC_FAILURE'); }, async () => { calls++; }), /FSYNC/); assert.equal(calls, 0); });
test('source drift, dirty revision and renamed resources fence live work', () => {
  validatePrepared(prepared, prepared.sourceDigests); assert.throws(() => validatePrepared(prepared, { changed: 'bytes' }), /SOURCE_CHANGED/);
  assert.throws(() => validatePrepared({ ...prepared, sourceDirty: true }, prepared.sourceDigests), /CLEAN_PINNED/);
  assert.throws(() => validatePrepared({ ...prepared, names: { ...prepared.names, bucket: 'some-existing-bucket' } }, prepared.sourceDigests), /OWNERSHIP/);
});
test('deployed module comparison includes exact JS and WASM bytes', async () => {
  const js = new TextEncoder().encode('export default {}'), wasm = new Uint8Array([0, 97, 115, 109]); const expected = { 'controller.js': js, 'kernel.wasm': wasm };
  const response = (value: Uint8Array, names = ['controller.js', 'kernel.wasm'], entrypoint = 'controller.js', extras: string[] = []) => { const form = new FormData(); form.append(names[0], new File([js.slice().buffer], 'controller.js')); form.append(names[1], new File([value.slice().buffer], 'kernel.wasm')); for (const name of extras) form.append(name, new File([wasm.slice().buffer], 'kernel.wasm')); const result = new Response(form); result.headers.set('cf-entrypoint', entrypoint); return result; };
  assert.equal(await deployedModulesMatch(response(wasm), expected), true); assert.equal(await deployedModulesMatch(response(new Uint8Array([1, 2])), expected), false);
  assert.equal(await deployedModulesMatch(response(wasm, ['controller.js', './kernel.wasm']), expected), true);
  assert.equal(await deployedModulesMatch(response(wasm, ['./controller.js', './kernel.wasm'], './controller.js'), expected), true);
  assert.equal(await deployedModulesMatch(response(new Uint8Array([1, 2]), ['controller.js', './kernel.wasm']), expected), false);
  for (const extra of ['kernel.wasm', './kernel.wasm', 'foreign.wasm']) assert.equal(await deployedModulesMatch(response(wasm, ['controller.js', 'kernel.wasm'], 'controller.js', [extra]), expected), false);
  for (const invalid of ['/kernel.wasm', '\\kernel.wasm', 'dir\\kernel.wasm', 'C:/kernel.wasm', '../kernel.wasm', '././kernel.wasm', 'dir/../kernel.wasm', 'dir/./kernel.wasm', 'dir//kernel.wasm']) {
    assert.equal(await deployedModulesMatch(response(wasm, ['controller.js', invalid]), expected), false, invalid);
    assert.equal(await deployedModulesMatch(response(wasm, ['controller.js', 'kernel.wasm'], invalid), expected), false, invalid);
  }
  assert.equal(await deployedModulesMatch(response(wasm), { 'controller.js': js, 'kernel.wasm': wasm, 'missing.wasm': wasm }), false);
  assert.equal(await deployedModulesMatch(response(wasm), { ...expected, './kernel.wasm': wasm }), false);
  const text = new FormData(); text.set('controller.js', new TextDecoder().decode(js)); text.set('kernel.wasm', new File([wasm.slice().buffer], 'kernel.wasm')); const textResponse = new Response(text); textResponse.headers.set('cf-entrypoint', 'controller.js'); assert.equal(await deployedModulesMatch(textResponse, expected), false);
});
test('actual streamed limit rejects and strict parser preserves duplicate fields', async () => {
  await assert.rejects(boundedBytes(new Response(new Uint8Array(129)), 128), /SIZE_LIMIT/);
  assert.throws(() => JSON.parse(getKernel().canonical_json('{"jobId":"first","jobId":"second"}')), /duplicate|JSON/i);
});
test('invalid selected account blocks before any provider call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owned-evaluator-gate-')); const report = await main(['--run', '--account', 'invalid', '--journal', join(dir, 'missing.json'), '--out', join(dir, 'report.json')]); assert.equal(report.providerGatePassed, false); assert.equal(report.remoteCalls, 0); await rm(dir, { recursive: true, force: true });
});
test('actual owned HTTP good and stale programs demonstrate external oracle despite forged PASS stdout', async () => {
  for (const [name, source] of Object.entries(sources)) {
    const dir = await mkdtemp(join(tmpdir(), `owned-evaluator-http-${name}-`)); let stored = 1234;
    const store = http.createServer(async (req, res) => { if (req.url !== '/store/value') { res.writeHead(403).end(); return; } if (req.method === 'PUT') { let raw = ''; for await (const chunk of req) raw += chunk; stored = JSON.parse(raw).value; } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ value: stored })); });
    await new Promise<void>(done => store.listen(0, '127.0.0.1', done)); const port = (store.address() as any).port;
    const blobs = await Promise.all(source.objects.filter(object => object.type === 'blob').map(async object => ({ digest: await sha256(decodeBase64(object.dataBase64)), bytes: decodeBase64(object.dataBase64) })));
    for (const entry of source.manifest.entries) await writeFile(join(dir, entry.path), blobs.find(blob => blob.digest === entry.digest)!.bytes);
    const child = spawn(process.execPath, ['server.mjs'], { cwd: dir, env: { PORT: '0', BIND_HOST: '127.0.0.1', FIXTURE_STORE_URL: `http://127.0.0.1:${port}/store/value`, FIXTURE_DATA_TOKEN: 'owned-local-only' }, stdio: ['ignore', 'pipe', 'ignore'] }); let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const origin = await new Promise<string>((done, reject) => { child.once('error', reject); child.once('exit', () => reject(new Error('OWNED_CHILD_EXIT_BEFORE_READY'))); child.stdout.on('data', chunk => { output += chunk.toString(); for (const line of output.split('\n')) { try { const event = JSON.parse(line); if (event.type === 'ready') done(`http://127.0.0.1:${event.port}`); } catch {} } }); });
      assert.equal((await (await fetch(origin + '/value')).json()).value, 1234);
      assert.equal((await (await fetch(origin + '/value', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 5678 }) })).json()).value, 5678);
      const observed = (await (await fetch(origin + '/value')).json()).value;
      assert.equal(observed, name === 'good' ? 5678 : 1234); if (name === 'bad') assert.match(output, /"outcome":"PASS"/);
    } finally { clearTimeout(timer); if (child.exitCode === null) { const stopped = new Promise(done => child.once('exit', done)); child.kill('SIGKILL'); await stopped; } store.closeAllConnections(); await new Promise<void>(done => store.close(() => done())); await rm(dir, { recursive: true, force: true }); }
  }
});
