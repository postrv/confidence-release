// SPDX-License-Identifier: Apache-2.0
// Production EvaluationSandbox stop/status/alarm against an owned fake container.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { initializeKernel } from '../packages/protocol/src/node.ts';
import { canonicalize, digest, encodeBase64, sha256, signStatement, statement, verifyAttestation } from '../packages/protocol/src/index.ts';
import { vector } from '../tests/conformance/vector.ts';
import { buildEvaluationPlan, probes, values } from '../workers/evaluator/recipes.ts';
import { validOverlapStoreTrace } from '../workers/evaluator/overlap.ts';

await initializeKernel(); const fixture = await vector();
const directory = await mkdtemp(join(tmpdir(), 'confidence-evaluator-stop-')), bundleDirectory = join(directory, 'bundle'); await mkdir(bundleDirectory);
const reportPath = resolve(process.env.EVALUATOR_STOP_RUNTIME_REPORT || 'demo-output/evaluator-stop-runtime.json');
const run = promisify(execFile);
await run(resolve('node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--config', 'infra/test-evaluator/wrangler.jsonc', '--outdir', bundleDirectory], { cwd: resolve('.'), env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
const scripts = (await readdir(bundleDirectory)).filter(name => name.endsWith('.js')); assert.equal(scripts.length, 1);
const options = convertV4MiniflareOptions({ name: 'owned-evaluator-stop-runtime', modulesRoot: bundleDirectory, modules: [{ type: 'ESModule', path: join(bundleDirectory, scripts[0]) }, ...(await readdir(bundleDirectory)).filter(name => name.endsWith('.wasm')).map(name => ({ type: 'CompiledWasm' as const, path: join(bundleDirectory, name) }))], compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'], durableObjects: { SCHEDULER: { className: 'TestScheduler', useSQLite: true }, EVALUATIONS: { className: 'FakeEvaluation', useSQLite: true }, TEST_EVALUATIONS: { className: 'TestEvaluationSandbox', useSQLite: true }, FIXTURES: { className: 'FixtureStore', useSQLite: true }, CALLBACKS: { className: 'TestCallbackReceiver', useSQLite: true } }, serviceBindings: { AUTHORITY: 'owned-evaluator-stop-runtime' }, r2Buckets: { OBJECTS: 'owned-evaluator-stop-objects' }, resourcePersistencePath: join(directory, 'persist'), log: new Log(LogLevel.ERROR), bindings: { EVALUATION_IMAGE_DIGEST: 'sha256:' + '1'.repeat(64), CHECKER_IMPLEMENTATION_DIGEST: 'sha256:' + '2'.repeat(64), CHECKER_KEY_ID: 'checker-1', CHECKER_SIGNING_KEY: Buffer.from('302e020100300506032b657004220420' + '02'.repeat(32), 'hex').toString('base64'), EVALUATOR_SERVICE_TOKEN: 'owned-test-only-evaluator-service-not-a-credential' } });
let runtime = new Miniflare(options); const checks: string[] = [], results: unknown[] = [], hydrationResults: unknown[] = [], fixtureResults: unknown[] = [], diagnosticResults: unknown[] = [], finalSnapshotResults: unknown[] = [];
async function call(path: string, body: unknown = {}, expectedStatus = 200): Promise<any> {
  const response = await runtime.dispatchFetch('http://owned.test' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); assert.equal(response.status, expectedStatus, JSON.stringify(result)); return result;
}
// Public deterministic TEST key, matching the conformance fixture's checker.
// Never deploy it. The callback receiver records bytes without authorizing them.
const checker = await crypto.subtle.importKey('pkcs8', Buffer.from('302e020100300506032b657004220420' + '02'.repeat(32), 'hex'), 'Ed25519', false, ['sign']);
async function seed(id: string) {
  const scope = fixture.input.state.scope, candidate = fixture.input.candidate;
  const evaluation = { schemaVersion: 1 as const, id, goalRevision: '1', policyRevision: '1', contractBundleDigest: await digest({ contracts: ['freshness-v1'], revision: 'owned-stop-test' }) };
  const plan = await buildEvaluationPlan(scope, candidate, evaluation, { EVALUATION_IMAGE_DIGEST: 'sha256:' + '1'.repeat(64), CHECKER_IMPLEMENTATION_DIGEST: 'sha256:' + '2'.repeat(64) }, 'freshness');
  const request = { scope, evaluation, candidate, plan, job: plan.jobs[0], source: { commit: candidate.commit, commitBytesDigest: candidate.commitBytesDigest, parent: candidate.parent, manifest: fixture.bundle.inputs.manifest, manifestDigest: candidate.manifestDigest, objects: fixture.bundle.inputs.gitObjects, objectsDigest: await digest(fixture.bundle.inputs.gitObjects) } };
  const observation = { schemaVersion: 1, scope, evaluation, jobId: request.job.id, inputDigest: request.job.inputDigest, candidateDigest: candidate.digest, outcome: 'INCONCLUSIVE' as const, observations: [], terminationObserved: false, limitations: ['Synthetic frozen observation for an owned fake-container lifecycle regression. No application execution.'] };
  const observationBase64 = encodeBase64(new TextEncoder().encode(canonicalize(observation)));
  const identity = { id: `owned-evidence-${id}`, jobId: request.job.id, inputDigest: request.job.inputDigest, observationDigest: await digest(observation), candidateId: candidate.id, candidateDigest: candidate.digest, outcome: 'INCONCLUSIVE' as const, evidenceClass: 'protected-behavioural' as const, authorized: true };
  const evidence = { ...identity, digest: await digest(identity) }, envelope = await signStatement(await statement('evidence', evidence), 'checker-1', checker);
  const callback = { scope, evidence, envelope, observationBase64 }, jobKey = (await digest({ scope, jobId: request.job.id })).slice(7);
  await call('/stop-seed', { jobKey, request, callback }); return { jobKey, callback, callbackDigest: await digest(callback) };
}
async function inspect(jobKey: string) { return call('/stop-inspect', { jobKey }); }
async function unchanged(jobKey: string, callback: unknown) { const state = await inspect(jobKey); assert.equal(canonicalize(state.job.callback), canonicalize(callback)); return state; }
try {
  await runtime.ready;
  const fixtureId = 'owned-held-candidate-put';
  await call('/fixture-initialize', { fixtureId, value: 7 });
  await call('/fixture-hold-put', { fixtureId, value: 91 });
  let heldFixture: any;
  for (let retry = 0; retry < 250; retry++) { heldFixture = await call('/fixture-inspect', { fixtureId }); if (heldFixture.entered) break; await new Promise(done => setTimeout(done, 4)); }
  assert.equal(heldFixture.entered, true, 'Production PUT did not reach held body read'); assert.equal(heldFixture.response, null);
  await call('/fixture-close', { fixtureId });
  assert.equal((await call('/fixture-inspect', { fixtureId })).state.active, false);
  await call('/fixture-release-put', { fixtureId });
  for (let retry = 0; retry < 250; retry++) { heldFixture = await call('/fixture-inspect', { fixtureId }); if (heldFixture.response) break; await new Promise(done => setTimeout(done, 4)); }
  assert.equal(heldFixture.response.status, 403); assert.equal(heldFixture.response.body.error.code, 'FIXTURE_FENCED');
  assert.equal(heldFixture.closed, true);
  assert.deepEqual(heldFixture.state, { active: false, value: 7, reads: 0, accesses: [] });
  assert.equal((await call('/fixture-get', { fixtureId }, 403)).error.code, 'FIXTURE_FENCED');
  assert.equal((await call('/fixture-initialize', { fixtureId, value: 92 }, 409)).error, 'FIXTURE_ALREADY_INITIALIZED');
  fixtureResults.push({ case: 'held-put-close-release', status: heldFixture.response.status, state: heldFixture.state });
  checks.push('Actual workerd production FixtureStore rejects a candidate PUT held at body read after close commits; late body release and GET/reinitialize cannot reopen or mutate it');

  const countedId = 'owned-concurrent-fixture-reads';
  await call('/fixture-initialize', { fixtureId: countedId, value: 17 });
  const counted = await Promise.all(Array.from({ length: 32 }, () => call('/fixture-get', { fixtureId: countedId })));
  assert.ok(counted.every(read => read.value === 17));
  let countedState = (await call('/fixture-inspect', { fixtureId: countedId })).state;
  assert.equal(countedState.reads, 32); assert.equal(countedState.accesses.length, 32);
  const competing = await Promise.all([...Array.from({ length: 32 }, async () => {
    const response = await runtime.dispatchFetch('http://owned.test/fixture-get', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fixtureId: countedId }) });
    const body = await response.json() as any; assert.ok(response.status === 200 || response.status === 403);
    if (response.status === 403) assert.equal(body.error.code, 'FIXTURE_FENCED');
    return response.status;
  }), call('/fixture-close', { fixtureId: countedId }).then(() => 0)]);
  countedState = (await call('/fixture-inspect', { fixtureId: countedId })).state;
  assert.equal(countedState.active, false); assert.equal(countedState.reads, 32 + competing.filter(status => status === 200).length); assert.equal(countedState.accesses.length, countedState.reads);
  fixtureResults.push({ case: 'concurrent-get-close', state: countedState, completedBeforeFence: competing.filter(status => status === 200).length });
  checks.push('Actual workerd serializes concurrent fixture GET accounting and close; successful reads count exactly once and no stale reader overwrites the closed state');

  const initializedId = 'owned-concurrent-fixture-initialize';
  const initialize = await Promise.all(Array.from({ length: 16 }, async (_, value) => {
    const response = await runtime.dispatchFetch('http://owned.test/fixture-initialize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fixtureId: initializedId, value }) });
    const body = await response.json() as any; assert.ok(response.status === 200 || response.status === 409);
    if (response.status === 409) assert.equal(body.error, 'FIXTURE_ALREADY_INITIALIZED');
    return { status: response.status, value };
  }));
  assert.equal(initialize.filter(row => row.status === 200).length, 1);
  assert.equal((await call('/fixture-inspect', { fixtureId: initializedId })).state.value, initialize.find(row => row.status === 200)!.value);
  const absentId = 'owned-close-before-fixture-initialize';
  await call('/fixture-close', { fixtureId: absentId });
  assert.equal((await call('/fixture-inspect', { fixtureId: absentId })).state, undefined);
  assert.equal((await call('/fixture-inspect', { fixtureId: absentId })).closed, true);
  assert.equal((await call('/fixture-initialize', { fixtureId: absentId, value: 101 }, 409)).error, 'FIXTURE_ALREADY_INITIALIZED');
  await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
  assert.equal((await call('/fixture-initialize', { fixtureId: absentId, value: 102 }, 409)).error, 'FIXTURE_ALREADY_INITIALIZED');
  assert.equal((await call('/fixture-get', { fixtureId: absentId }, 403)).error.code, 'FIXTURE_FENCED');
  assert.equal((await call('/fixture-inspect', { fixtureId: absentId })).closed, true);
  assert.deepEqual((await call('/fixture-inspect', { fixtureId })).state, heldFixture.state);
  fixtureResults.push({ case: 'concurrent-initialize-and-absent-close-restart', winners: 1, absentFenceSurvivedRestart: true });
  checks.push('Actual workerd accepts only one concurrent initialization and retains a permanent close-before-initialize fence across restart without inventing absent fixture contents');
  const overlapId = 'owned-captured-read-write-release';
  await call('/fixture-initialize', { fixtureId: overlapId, value: 11 });
  await call('/fixture-arm-read', { fixtureId: overlapId, deadline: Date.now() + 9000 });
  assert.equal((await call('/fixture-release-read', { fixtureId: overlapId }, 409)).error, 'FIXTURE_FENCED');
  await call('/fixture-start-read', { fixtureId: overlapId });
  assert.deepEqual(await call('/fixture-await-capture', { fixtureId: overlapId }), { capturedValue: 11, reads: 1 });
  assert.equal(await call('/fixture-read-response', { fixtureId: overlapId }), null);
  assert.deepEqual(await call('/fixture-put', { fixtureId: overlapId, value: 91 }), { value: 91 });
  assert.equal(await call('/fixture-read-response', { fixtureId: overlapId }), null, 'PUT must acknowledge while the old GET remains held');
  for (const path of ['/store/value?release=true', '/store/barrier', '/store/snapshot']) assert.equal((await call('/fixture-data-route', { fixtureId: overlapId, path, method: 'GET' }, 403)).error.code, 'FIXTURE_ROUTE_DENIED');
  await call('/fixture-release-read', { fixtureId: overlapId });
  let overlapResponse: any;
  for (let retry = 0; retry < 250; retry++) { overlapResponse = await call('/fixture-read-response', { fixtureId: overlapId }); if (overlapResponse) break; await new Promise(done => setTimeout(done, 4)); }
  assert.deepEqual(overlapResponse, { status: 200, body: { value: 11 } });
  assert.deepEqual(await call('/fixture-get', { fixtureId: overlapId }), { value: 91 });
  assert.equal((await call('/fixture-arm-read', { fixtureId: overlapId, deadline: Date.now() + 9000 }, 409)).error, 'FIXTURE_BARRIER_ALREADY_USED');
  await call('/fixture-close', { fixtureId: overlapId });
  const overlapState = (await call('/fixture-inspect', { fixtureId: overlapId })).state;
  assert.equal(overlapState.readBarrier.phase, 'FENCED'); assert.equal(overlapState.readBarrier.capturedValue, 11);
  assert.deepEqual(overlapState.accesses, [{ method: 'GET', value: 11 }, { method: 'PUT', value: 91 }, { method: 'GET', value: 91 }]);
  fixtureResults.push({ case: 'private-barrier-capture-write-release', state: overlapState });
  checks.push('Actual workerd captures one old GET outside its storage transaction, acknowledges PUT before release, returns only captured bytes and then current bytes; candidate routes cannot inspect or release the barrier');

  for (const mode of ['close', 'deadline'] as const) {
    const fixtureId = `owned-read-barrier-${mode}`;
    await call('/fixture-initialize', { fixtureId, value: 31 });
    await call('/fixture-arm-read', { fixtureId, deadline: Date.now() + (mode === 'deadline' ? 400 : 9000) });
    await call('/fixture-start-read', { fixtureId }); await call('/fixture-await-capture', { fixtureId });
    if (mode === 'close') await call('/fixture-close', { fixtureId });
    let response: any;
    for (let retry = 0; retry < 400; retry++) { response = await call('/fixture-read-response', { fixtureId }); if (response) break; await new Promise(done => setTimeout(done, 4)); }
    assert.ok(response && [403, 503].includes(response.status)); assert.ok(['FIXTURE_FENCED', 'FIXTURE_BARRIER_DEADLINE'].includes(response.body.error.code));
    const state = (await call('/fixture-inspect', { fixtureId })).state;
    assert.equal(state.active, false); assert.equal(state.value, 31); assert.equal(state.readBarrier.phase, 'FENCED');
    assert.equal((await call('/fixture-release-read', { fixtureId }, 409)).error, 'FIXTURE_FENCED');
    assert.equal((await call('/fixture-put', { fixtureId, value: 99 }, 403)).error.code, 'FIXTURE_FENCED');
    fixtureResults.push({ case: `private-barrier-${mode}`, response, state });
  }
  checks.push('Actual workerd close and finite barrier deadline both wake and reject the held read, permanently fence its fixture and prohibit later release or writes');

  for (const phase of ['ARMED', 'CAPTURED'] as const) {
    const fixtureId = `owned-read-barrier-restart-${phase}`;
    await call('/fixture-initialize', { fixtureId, value: 41 });
    await call('/fixture-arm-read', { fixtureId, deadline: Date.now() + 9000 });
    if (phase === 'CAPTURED') { await call('/fixture-start-read', { fixtureId }); await call('/fixture-await-capture', { fixtureId }); }
    assert.equal((await call('/fixture-inspect', { fixtureId })).state.readBarrier.phase, phase);
    await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
    const state = (await call('/fixture-inspect', { fixtureId })).state;
    assert.equal(state.active, false); assert.equal(state.readBarrier.phase, 'FENCED');
    assert.equal((await call('/fixture-get', { fixtureId }, 403)).error.code, 'FIXTURE_FENCED');
    assert.equal((await call('/fixture-release-read', { fixtureId }, 409)).error, 'FIXTURE_FENCED');
    assert.equal((await call('/fixture-initialize', { fixtureId, value: 99 }, 409)).error, 'FIXTURE_ALREADY_INITIALIZED');
    fixtureResults.push({ case: `private-barrier-restart-${phase}`, state });
  }
  checks.push('Actual persisted workerd reconstruction fences both ARMED and CAPTURED barriers, preserving observations while preventing reinitialization, late release and data access');
  for (const scenario of [
    { probe: 'overlapping-read-write', changeOnClose: false, outcome: 'PASS', expected: 'PASS' },
    { probe: 'overlapping-read-write', changeOnClose: true, outcome: 'PASS', expected: 'FAIL' },
    { probe: 'overlapping-read-write', changeOnClose: true, outcome: 'ERROR', expected: 'ERROR' },
    { probe: 'overlapping-read-write', changeOnClose: true, outcome: 'INCONCLUSIVE', expected: 'INCONCLUSIVE' },
    { probe: 'retained-cache-benefit', changeOnClose: false, outcome: 'PASS', expected: 'PASS' },
    { probe: 'retained-cache-benefit', changeOnClose: true, outcome: 'PASS', expected: 'FAIL' },
  ] as const) {
    const scope = fixture.input.state.scope, candidate = fixture.input.candidate, probe = probes.find(item => item.id === scenario.probe)!;
    const evaluation = { schemaVersion: 1 as const, id: `owned-final-store-${finalSnapshotResults.length}`, goalRevision: '1', policyRevision: '1', contractBundleDigest: await digest({ revision: 'owned-final-store-snapshot' }) };
    const plan = await buildEvaluationPlan(scope, candidate, evaluation, { EVALUATION_IMAGE_DIGEST: 'sha256:' + '1'.repeat(64), CHECKER_IMPLEMENTATION_DIGEST: 'sha256:' + '2'.repeat(64) });
    const request = { scope, evaluation, candidate, plan, job: plan.jobs.find(job => job.id === `${evaluation.id}:${probe.id}`)!, source: { commit: candidate.commit, commitBytesDigest: candidate.commitBytesDigest, parent: candidate.parent, manifest: fixture.bundle.inputs.manifest, manifestDigest: candidate.manifestDigest, objects: fixture.bundle.inputs.gitObjects, objectsDigest: await digest(fixture.bundle.inputs.gitObjects) } };
    const jobKey = (await digest({ scope, jobId: request.job.id })).slice(7), fixtureId = jobKey, expectedValues = values(probe);
    await call('/start-freeze-seed', { jobKey, request });
    await call('/fixture-initialize', { fixtureId, value: expectedValues.initial });
    if (probe.assertion === 'overlap-freshness') {
      await call('/fixture-arm-read', { fixtureId, deadline: Date.now() + 9000 });
      await call('/fixture-start-read', { fixtureId });
      assert.deepEqual(await call('/fixture-await-capture', { fixtureId }), { capturedValue: expectedValues.initial, reads: 1 });
      await call('/fixture-put', { fixtureId, value: expectedValues.replacement });
      await call('/fixture-release-read', { fixtureId });
      for (let retry = 0; retry < 250 && !await call('/fixture-read-response', { fixtureId }); retry++) await new Promise(done => setTimeout(done, 4));
      assert.deepEqual(await call('/fixture-read-response', { fixtureId }), { status: 200, body: { value: expectedValues.initial } });
    }
    await call('/fixture-get', { fixtureId });
    const before = (await call('/fixture-inspect', { fixtureId })).state;
    assert.equal(before.active, true);
    assert.equal(probe.assertion === 'overlap-freshness' ? validOverlapStoreTrace(before, expectedValues.initial, expectedValues.replacement) : before.reads === 1, true);
    if (scenario.changeOnClose) await call('/fixture-change-read-count-on-close', { fixtureId });
    const frozen = await call('/start-finish-store-probe', { jobKey, outcome: scenario.outcome });
    const after = (await call('/fixture-inspect', { fixtureId })).state, callback = frozen.job.callback;
    const bytes = Buffer.from(callback.observationBase64, 'base64'), observation = JSON.parse(bytes.toString('utf8'));
    assert.equal(after.active, false); assert.equal(after.reads, before.reads + Number(scenario.changeOnClose));
    assert.deepEqual(observation.backingStore, after, 'The signed observation must retain the exact final closed fixture snapshot');
    assert.equal(observation.outcome, scenario.expected, `${scenario.probe}/${scenario.outcome}/metadata-change=${scenario.changeOnClose}`);
    assert.equal(callback.evidence.outcome, observation.outcome);
    assert.equal(callback.evidence.observationDigest, await sha256(bytes));
    const verified = verifyAttestation({ trust: fixture.trust, envelope: callback.envelope, role: 'checker', kind: 'evidence', allowLegacy: true });
    assert.equal(verified.valid, true, verified.reason ?? 'Checker attestation verification failed'); assert.deepEqual(verified.record, callback.evidence);
    assert.deepEqual(frozen.retainedObservations, [{ digest: callback.evidence.observationDigest, bytes: bytes.length }]);
    assert.equal(frozen.job.terminationObserved && frozen.job.fixtureClosed && frozen.job.callbackDelivered, true);
    assert.equal(frozen.container.destroy_calls, 1); assert.equal(frozen.container.exec_calls, 0);
    const callbackDigest = await digest(callback); await call('/start-status', { jobKey });
    assert.equal(await digest((await call('/start-inspect', { jobKey })).job.callback), callbackDigest, 'Later status must preserve selected signed bytes');
    finalSnapshotResults.push({ probe: probe.id, metadataChangedDuringClose: scenario.changeOnClose, priorOutcome: scenario.outcome, signedOutcome: observation.outcome, observationDigest: callback.evidence.observationDigest, finalReads: after.reads, finalAccesses: after.accesses.length });
  }
  checks.push('Actual workerd stop/freeze/sign retains the exact closed fixture snapshot: normal overlap and cache-benefit traces pass, metadata changes during close make their would-PASS results FAIL, ERROR/INCONCLUSIVE stay unchanged, and later status preserves signed bytes');
  const sourceBytes = [new Uint8Array(), new Uint8Array([0, 255, 13, 10, 128])];
  const hydrationManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: await Promise.all(sourceBytes.map(async (bytes, index) => ({ path: index ? 'nested/executable.bin' : 'empty.txt', mode: index ? '100755' : '100644', bytes: String(bytes.length), digest: await sha256(bytes) }))) };
  const hydrationObjects = sourceBytes.map((bytes, index) => ({ oid: String(index).repeat(40), type: 'blob', dataBase64: encodeBase64(bytes) }));
  const successfulHydration = await call('/hydration-check', { fault: 'none', manifest: hydrationManifest, objects: hydrationObjects });
  assert.equal(successfulHydration.accepted, true); assert.equal(successfulHydration.candidateEntrypointDispatches, 1);
  assert.deepEqual(successfulHydration.observation, { files: 2, bytes: 5, modes: 'verified-regular-644-or-755', inventory: 'exact' });
  assert.deepEqual(successfulHydration.chmods.map((item: any) => item.mode), ['644', '755']); assert.equal(successfulHydration.reads.length, 2);
  hydrationResults.push({ fault: 'none', ...successfulHydration });
  checks.push('Production hydration helper verifies empty/binary bytes, nested complete inventory and explicit 644/755 modes before the owned candidate-dispatch marker');
  const faults = { 'corrupt-write': 'HYDRATION_READBACK_DIGEST_MISMATCH', 'truncate-write': 'HYDRATION_READBACK_SIZE_MISMATCH', 'ignore-regular-chmod': 'HYDRATION_READBACK_MODE_MISMATCH', 'ignore-executable-chmod': 'HYDRATION_READBACK_MODE_MISMATCH', 'write-symlink': 'HYDRATION_NOT_REGULAR_FILE', 'oversized-readback': 'SIZE_LIMIT', 'undeclared-source': 'HYDRATION_UNDECLARED_ENTRY', 'reject-chmod': 'HYDRATION_MODE_FAILED' };
  for (const [fault, error] of Object.entries(faults)) {
    const result = await call('/hydration-check', { fault, manifest: hydrationManifest, objects: hydrationObjects });
    assert.equal(result.accepted, false, fault); assert.equal(result.error, error, fault); assert.equal(result.candidateEntrypointDispatches, 0, fault);
    hydrationResults.push({ fault, ...result });
  }
  checks.push('Corrupt/partial acknowledged writes, both mode failures, symlink, oversized readback, undeclared source and failed chmod all prevent the owned dispatch marker');
  const first = await seed('owned-status-then-alarm');
  let status = await call('/stop-status', { jobKey: first.jobKey });
  assert.deepEqual(status, { terminationObserved: false, callbackDelivered: true, fixtureClosed: true, phase: 'STOP_REQUESTED' });
  let state = await unchanged(first.jobKey, first.callback); assert.equal(state.container.running, 1); assert.equal(state.container.destroy_calls, 1);
  checks.push('Production status retries a frozen INCONCLUSIVE generation; first owned destroy failure retains stop request and occupied capacity despite delivered callback');
  await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
  state = await call('/stop-alarm', { jobKey: first.jobKey });
  assert.equal(state.job.terminationObserved, true); assert.equal(state.job.callbackDelivered, true); assert.equal(state.job.phase, 'STOPPED'); assert.equal(state.container.destroy_calls, 2); assert.equal(state.container.running, 0); await unchanged(first.jobKey, first.callback);
  results.push({ case: 'status-failed-stop-restart-alarm', callbackDigest: first.callbackDigest, confirmedStops: state.container.destroy_calls, phase: state.job.phase, eligibleForSchedulerRelease: state.job.terminationObserved && state.job.callbackDelivered && state.job.fixtureClosed });
  checks.push('Actual workerd restart preserves the frozen callback and failed stop record; production alarm retries destroy and confirms termination without replacing signed observation bytes');

  const second = await seed('owned-alarm-then-status'); state = await call('/stop-alarm', { jobKey: second.jobKey });
  assert.equal(state.job.terminationObserved, false); assert.equal(state.job.callbackDelivered, true); assert.equal(state.container.destroy_calls, 1); await unchanged(second.jobKey, second.callback);
  status = await call('/stop-status', { jobKey: second.jobKey }); assert.equal(status.terminationObserved, true); assert.equal(status.callbackDelivered, true);
  state = await unchanged(second.jobKey, second.callback); assert.equal(state.container.destroy_calls, 2); assert.equal(state.container.running, 0);
  results.push({ case: 'alarm-failed-stop-status', callbackDigest: second.callbackDigest, confirmedStops: state.container.destroy_calls, phase: state.job.phase, eligibleForSchedulerRelease: state.job.terminationObserved && state.job.callbackDelivered && state.job.fixtureClosed });
  checks.push('Production alarm and status both reconcile frozen terminal output; reverse invocation order also retries exactly one failed destroy before confirming stop');

  await call('/callback-mode', { reject: true }); const third = await seed('owned-stop-before-delivery');
  await call('/stop-status', { jobKey: third.jobKey }); state = await call('/stop-alarm', { jobKey: third.jobKey });
  assert.equal(state.job.terminationObserved, true); assert.equal(state.job.callbackDelivered, false); assert.equal(state.container.destroy_calls, 2); await unchanged(third.jobKey, third.callback);
  checks.push('Confirmed termination with rejected callback still fails the scheduler release condition; signed INCONCLUSIVE remains unchanged');
  await call('/callback-mode', { reject: false }); status = await call('/stop-status', { jobKey: third.jobKey }); assert.equal(status.terminationObserved, true); assert.equal(status.callbackDelivered, true);
  state = await unchanged(third.jobKey, third.callback); assert.equal(state.container.destroy_calls, 2);
  const received = await call('/callback-inspect'); for (const item of [first, second, third]) { const attempts = received.filter((row: any) => row.digest === item.callbackDigest); assert.ok(attempts.length >= 1); assert.equal(attempts.filter((row: any) => row.acknowledged).length, 1); }
  results.push({ case: 'stop-confirmed-before-callback', callbackDigest: third.callbackDigest, confirmedStops: state.container.destroy_calls, phase: state.job.phase, eligibleForSchedulerRelease: state.job.terminationObserved && state.job.callbackDelivered && state.job.fixtureClosed });
  checks.push('Callback retry sends identical retained bytes and completes release only after both termination and delivery; already stopped generations are not destroyed again');
  const stalledClose = await seed('owned-stalled-fixture-close');
  await call('/fixture-hold-close', { fixtureId: stalledClose.jobKey, hold: true });
  let started = Date.now(); status = await call('/stop-status', { jobKey: stalledClose.jobKey }); assert.ok(Date.now() - started < 8000);
  assert.equal(status.terminationObserved, false); assert.equal(status.fixtureClosed, false);
  state = await unchanged(stalledClose.jobKey, stalledClose.callback); assert.equal(state.container.destroy_calls, 1);
  started = Date.now(); status = await call('/stop-status', { jobKey: stalledClose.jobKey }); assert.ok(Date.now() - started < 8000);
  assert.equal(status.terminationObserved, true); assert.equal(status.fixtureClosed, false); assert.equal(status.callbackDelivered, true);
  state = await unchanged(stalledClose.jobKey, stalledClose.callback); assert.equal(state.container.destroy_calls, 2); assert.equal(state.container.running, 0);
  assert.equal((await call('/fixture-inspect', { fixtureId: stalledClose.jobKey })).closed, false);
  await call('/fixture-hold-close', { fixtureId: stalledClose.jobKey, hold: false });
  await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
  status = await call('/stop-status', { jobKey: stalledClose.jobKey }); assert.equal(status.terminationObserved, true); assert.equal(status.fixtureClosed, true); assert.equal(status.callbackDelivered, true);
  state = await unchanged(stalledClose.jobKey, stalledClose.callback); assert.equal(state.container.destroy_calls, 2);
  checks.push('Held fixture close cannot delay native destruction indefinitely; actual workerd retains unresolved closure separately from confirmed stop and reconciles after restart without re-destroying the stopped generation');
  const stalledCallback = await seed('owned-stalled-callback'); await call('/callback-hold', { hold: true });
  started = Date.now(); status = await call('/stop-status', { jobKey: stalledCallback.jobKey }); assert.ok(Date.now() - started < 8000); assert.equal(status.callbackDelivered, false);
  started = Date.now(); status = await call('/stop-status', { jobKey: stalledCallback.jobKey }); assert.ok(Date.now() - started < 8000); assert.equal(status.terminationObserved, true); assert.equal(status.fixtureClosed, true); assert.equal(status.callbackDelivered, false);
  state = await unchanged(stalledCallback.jobKey, stalledCallback.callback); assert.equal(state.container.destroy_calls, 2);
  await call('/callback-hold', { hold: false }); await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
  status = await call('/stop-status', { jobKey: stalledCallback.jobKey }); assert.equal(status.callbackDelivered, true); state = await unchanged(stalledCallback.jobKey, stalledCallback.callback); assert.equal(state.container.destroy_calls, 2);
  checks.push('Held authority responses bound evaluator status attempts; stop remains confirmed, callback identity remains frozen and delivery reconciles after restart before capacity becomes releasable');
  const startRaces: unknown[] = [];
  for (const scenario of [
    { id: 'owned-intercept-stop', stage: 'intercept', deadline: false, starts: 0 },
    { id: 'owned-intercept-deadline', stage: 'intercept', deadline: true, starts: 0 },
    { id: 'owned-inactivity-stop', stage: 'inactivity', deadline: false, starts: 1 },
    { id: 'owned-inactivity-deadline', stage: 'inactivity', deadline: true, starts: 1 },
  ] as const) {
    const scope = fixture.input.state.scope, candidate = fixture.input.candidate;
    const evaluation = { schemaVersion: 1 as const, id: scenario.id, goalRevision: '1', policyRevision: '1', contractBundleDigest: await digest({ contracts: ['freshness-v1'], revision: 'owned-start-barrier' }) };
    const plan = await buildEvaluationPlan(scope, candidate, evaluation, { EVALUATION_IMAGE_DIGEST: 'sha256:' + '1'.repeat(64), CHECKER_IMPLEMENTATION_DIGEST: 'sha256:' + '2'.repeat(64) }, 'freshness');
    const request = { scope, evaluation, issuance: { schemaVersion: 1 as const, scope, signerKeysetRevision: '1', authorityRevision: '1' }, checkerKeyId: 'checker-1', candidate, plan, job: plan.jobs[0], source: { commit: candidate.commit, commitBytesDigest: candidate.commitBytesDigest, parent: candidate.parent, manifest: fixture.bundle.inputs.manifest, manifestDigest: candidate.manifestDigest, objects: fixture.bundle.inputs.gitObjects, objectsDigest: await digest(fixture.bundle.inputs.gitObjects) } };
    const jobKey = (await digest({ scope, jobId: request.job.id })).slice(7);
    await call('/start-setup', { jobKey, stage: scenario.stage });
    const accepted = await call('/start-run', { jobKey, request }); assert.equal(accepted.accepted, true); assert.equal(accepted.jobKey, jobKey); assert.equal(accepted.requestDigest, await digest(request));
    let held: any;
    for (let retry = 0; retry < 250; retry++) { held = await call('/start-inspect', { jobKey }); if (held.container.barrier_entered) break; await new Promise(done => setTimeout(done, 4)); }
    assert.equal(held.container.barrier_entered, 1, scenario.id + ': production preparation barrier not reached');
    assert.equal(held.container.start_calls, scenario.starts); assert.equal(held.job.terminationObserved, false);
    // The production run method, rather than FakeEvaluation, must deduplicate
    // registration while its original execution is suspended.
    await call('/start-run', { jobKey, request });
    const reused = await call('/start-run', { jobKey, request: { ...request, issuance: { ...request.issuance, authorityRevision: '2' } } }, 409);
    assert.equal(reused.error, 'JOB_ID_REUSE');
    await call('/start-stop', { jobKey, deadline: scenario.deadline });
    const stopped = await call('/start-inspect', { jobKey }); assert.equal(stopped.job.phase, 'STOPPED'); assert.equal(stopped.job.terminationObserved, true); assert.equal(stopped.container.destroy_calls, 1); assert.equal(stopped.container.pending, 0);
    await call('/start-release', { jobKey });
    let completion: any;
    for (let retry = 0; retry < 250; retry++) { completion = await call('/start-status', { jobKey }); if (completion.callbackDelivered) break; await new Promise(done => setTimeout(done, 4)); }
    assert.equal(completion.phase, 'STOPPED'); assert.equal(completion.terminationObserved, true); assert.equal(completion.fixtureClosed, true); assert.equal(completion.callbackDelivered, true);
    const final = await call('/start-inspect', { jobKey }); assert.equal(final.job.phase, 'STOPPED'); assert.equal(final.job.terminationObserved, true); assert.equal(final.container.start_calls, scenario.starts); assert.equal(final.container.exec_calls, 0); assert.equal(final.container.pending, 0);
    assert.equal(final.job.callback.evidence.outcome, scenario.deadline ? 'TIMEOUT' : 'ERROR');
    const callbackDigest = await digest(final.job.callback); await call('/start-status', { jobKey }); await call('/start-alarm', { jobKey });
    assert.equal(await digest((await call('/start-inspect', { jobKey })).job.callback), callbackDigest);
    startRaces.push({ scenario: scenario.id, nativeStarts: final.container.start_calls, nativeExecs: final.container.exec_calls, nativeDestroyCalls: final.container.destroy_calls, callbackDigest, phase: final.job.phase, outcome: final.job.callback.evidence.outcome });
    checks.push(`Production run ${scenario.id} acknowledges durable registration before held preparation, then preserves stopped identity, deduplicates retries and never executes candidate code`);
  }
  for (const scenario of [
    { id: 'owned-failed-startup-alarm', faults: ['startup-alarm'], stage: 'startup-alarm', failedStage: 'startup-alarm', code: 'UNCLASSIFIED_ERROR', accepted: false, outcome: 'INCONCLUSIVE', starts: 0 },
    { id: 'owned-failed-observation-retention', faults: ['outbound-intercept', 'freeze-retain'], stage: 'outbound-intercept', failedStage: 'freeze-retain', code: 'OBJECT_STORE_DEADLINE_EXCEEDED', accepted: true, outcome: 'INCONCLUSIVE', starts: 0 },
    { id: 'owned-failed-container-lookup', faults: ['container-lookup'], stage: 'container-lookup', failedStage: 'container-lookup', code: 'UNCLASSIFIED_ERROR', accepted: true, outcome: 'ERROR', starts: 0 },
    { id: 'owned-failed-container-inactivity', faults: ['container-inactivity'], stage: 'container-start', failedStage: 'container-inactivity', code: 'CONTAINER_NOT_STARTED', accepted: true, outcome: 'ERROR', starts: 1 },
  ] as const) {
    const scope = fixture.input.state.scope, candidate = fixture.input.candidate;
    const evaluation = { schemaVersion: 1 as const, id: scenario.id, goalRevision: '1', policyRevision: '1', contractBundleDigest: await digest({ contracts: ['freshness-v1'], revision: 'owned-diagnostic-failures' }) };
    const plan = await buildEvaluationPlan(scope, candidate, evaluation, { EVALUATION_IMAGE_DIGEST: 'sha256:' + '1'.repeat(64), CHECKER_IMPLEMENTATION_DIGEST: 'sha256:' + '2'.repeat(64) }, 'freshness');
    const request = { scope, evaluation, issuance: { schemaVersion: 1 as const, scope, signerKeysetRevision: '1', authorityRevision: '1' }, checkerKeyId: 'checker-1', candidate, plan, job: plan.jobs[0], source: { commit: candidate.commit, commitBytesDigest: candidate.commitBytesDigest, parent: candidate.parent, manifest: fixture.bundle.inputs.manifest, manifestDigest: candidate.manifestDigest, objects: fixture.bundle.inputs.gitObjects, objectsDigest: await digest(fixture.bundle.inputs.gitObjects) } };
    const jobKey = (await digest({ scope, jobId: request.job.id })).slice(7);
    await call('/start-diagnostics-setup', { jobKey, faults: scenario.faults });
    await call('/callback-mode', { reject: true });
    await call('/start-run', { jobKey, request }, scenario.accepted ? 200 : 409);
    let failed: any;
    for (let retry = 0; retry < 250; retry++) {
      failed = await call('/start-inspect', { jobKey });
      if (failed.operations.recoveryEvents.some((event: any) => event.operation === scenario.failedStage)
        && (scenario.outcome === 'ERROR' ? failed.job.callback && failed.operations.recoveryEvents.some((event: any) => event.operation === 'callback') : scenario.accepted ? failed.operations.recoveryEvents.some((event: any) => event.operation === 'execution') : true)) break;
      await new Promise(done => setTimeout(done, 4));
    }
    const failure = failed.operations.recoveryEvents.find((event: any) => event.operation === scenario.failedStage);
    assert.equal(failure?.code, scenario.code); assert.equal(failed.operations.executionStage, scenario.stage);
    assert.equal(JSON.stringify(failed.operations).includes('PRIVATE_EXECUTION_CANARY'), false);
    assert.equal(failed.container.start_calls, scenario.starts); assert.equal(failed.container.exec_calls, 0);
    if (scenario.outcome === 'INCONCLUSIVE') assert.equal(failed.job.callback, undefined);
    if (scenario.id === 'owned-failed-observation-retention') {
      assert.ok(failed.operations.recoveryEvents.some((event: any) => event.operation === 'outbound-intercept' && event.code === 'UNCLASSIFIED_ERROR'));
      assert.equal(failed.retainedObservations.length, 0);
    }
    // Reconstruct actual workerd over the same durable storage. No reexecution
    // is allowed even when the first run never armed its own durable alarm.
    await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
    const retained = await call('/start-inspect', { jobKey });
    assert.equal(retained.operations.executionStage, scenario.stage);
    assert.deepEqual(retained.operations.recoveryEvents, failed.operations.recoveryEvents);
    await call('/start-run', { jobKey, request });
    const held = await call('/start-status', { jobKey });
    assert.equal(held.terminationObserved, true); assert.equal(held.fixtureClosed, true); assert.equal(held.callbackDelivered, false);
    assert.equal(held.terminationObserved && held.fixtureClosed && held.callbackDelivered, false);
    const frozen = await call('/start-inspect', { jobKey }), callbackDigest = await digest(frozen.job.callback);
    assert.equal(frozen.job.callback.evidence.outcome, scenario.outcome);
    assert.equal(JSON.stringify(frozen.operations).includes('PRIVATE_EXECUTION_CANARY'), false);
    assert.equal(Buffer.from(frozen.job.callback.observationBase64, 'base64').toString().includes('PRIVATE_EXECUTION_CANARY'), false);
    assert.equal(frozen.container.start_calls, scenario.starts); assert.equal(frozen.container.exec_calls, 0);
    assert.equal(frozen.retainedObservations.length, 1);
    assert.ok(frozen.operations.recoveryEvents.some((event: any) => event.operation === scenario.failedStage && event.eventId === failure.eventId));
    await call('/callback-mode', { reject: false });
    const delivered = await call('/start-status', { jobKey });
    assert.equal(delivered.terminationObserved && delivered.fixtureClosed && delivered.callbackDelivered, true);
    await call('/start-run', { jobKey, request }); await call('/start-status', { jobKey }); await call('/start-alarm', { jobKey });
    const final = await call('/start-inspect', { jobKey });
    assert.equal(await digest(final.job.callback), callbackDigest); assert.equal(final.container.start_calls, scenario.starts); assert.equal(final.container.exec_calls, 0);
    diagnosticResults.push({ scenario: scenario.id, stage: final.operations.executionStage, failureCode: failure.code, outcome: final.job.callback.evidence.outcome, callbackDigest, recoverySurvivedRestart: true, nativeStarts: final.container.start_calls, nativeExecs: final.container.exec_calls });
    checks.push(`Production ${scenario.id} preserves safe failure diagnostics across workerd reconstruction, deduplicates execution, retains the slot until callback acknowledgment and freezes one unchanged signed result`);
  }
  const delayed = await seed('owned-delivery-after-stop'); await call('/callback-hold', { hold: true });
  const heldStatus = call('/stop-status', { jobKey: delayed.jobKey });
  for (let retry = 0; retry < 250; retry++) { if ((await call('/callback-inspect')).some((row: any) => row.digest === delayed.callbackDigest)) break; await new Promise(done => setTimeout(done, 4)); }
  const heldAlarm = call('/stop-alarm', { jobKey: delayed.jobKey });
  for (let retry = 0; retry < 250; retry++) { if ((await call('/callback-inspect')).filter((row: any) => row.digest === delayed.callbackDigest).length === 2) break; await new Promise(done => setTimeout(done, 4)); }
  assert.equal((await call('/callback-inspect')).filter((row: any) => row.digest === delayed.callbackDigest).length, 2);
  const stoppedBeforeAcknowledgment = await inspect(delayed.jobKey); assert.equal(stoppedBeforeAcknowledgment.job.phase, 'STOPPED'); assert.equal(stoppedBeforeAcknowledgment.job.terminationObserved, true); assert.equal(stoppedBeforeAcknowledgment.job.callbackDelivered, false);
  // Acknowledge the fresh STOPPED snapshot first; the older STOP_REQUESTED
  // delivery returns last and must not roll phase/termination back.
  await call('/callback-release-last'); await heldAlarm;
  assert.equal((await inspect(delayed.jobKey)).job.callbackDelivered, true);
  await call('/callback-hold', { hold: false }); await heldStatus;
  const afterAcknowledgment = await unchanged(delayed.jobKey, delayed.callback); assert.equal(afterAcknowledgment.job.phase, 'STOPPED'); assert.equal(afterAcknowledgment.job.terminationObserved, true); assert.equal(afterAcknowledgment.job.callbackDelivered, true); assert.equal(afterAcknowledgment.container.destroy_calls, 2);
  checks.push('Delayed callback acknowledgments after concurrent confirmed stop preserve the latest durable termination/phase and identical frozen signed bytes');
  results.push({ case: 'callback-ack-after-concurrent-stop', callbackDigest: delayed.callbackDigest, confirmedStops: 2, phase: afterAcknowledgment.job.phase, eligibleForSchedulerRelease: afterAcknowledgment.job.terminationObserved && afterAcknowledgment.job.callbackDelivered && afterAcknowledgment.job.fixtureClosed });
  const scope = fixture.input.state.scope, candidate = fixture.input.candidate;
  const evaluation = { schemaVersion: 1 as const, id: 'owned-freeze-after-stop', goalRevision: '1', policyRevision: '1', contractBundleDigest: await digest({ contracts: ['freshness-v1'], revision: 'owned-freeze-barrier' }) };
  const plan = await buildEvaluationPlan(scope, candidate, evaluation, { EVALUATION_IMAGE_DIGEST: 'sha256:' + '1'.repeat(64), CHECKER_IMPLEMENTATION_DIGEST: 'sha256:' + '2'.repeat(64) }, 'freshness');
  const request = { scope, evaluation, issuance: { schemaVersion: 1 as const, scope, signerKeysetRevision: '1', authorityRevision: '1' }, checkerKeyId: 'checker-1', candidate, plan, job: plan.jobs[0], source: { commit: candidate.commit, commitBytesDigest: candidate.commitBytesDigest, parent: candidate.parent, manifest: fixture.bundle.inputs.manifest, manifestDigest: candidate.manifestDigest, objects: fixture.bundle.inputs.gitObjects, objectsDigest: await digest(fixture.bundle.inputs.gitObjects) } };
  const freezeJobKey = (await digest({ scope, jobId: request.job.id })).slice(7);
  await call('/start-freeze-seed', { jobKey: freezeJobKey, request });
  const olderFreeze = call('/start-freeze', { jobKey: freezeJobKey });
  for (let retry = 0; retry < 250; retry++) { if ((await call('/start-inspect', { jobKey: freezeJobKey })).container.barrier_entered === 1) break; await new Promise(done => setTimeout(done, 4)); }
  assert.equal((await call('/start-inspect', { jobKey: freezeJobKey })).container.barrier_entered, 1);
  const newerFreeze = call('/start-status', { jobKey: freezeJobKey });
  for (let retry = 0; retry < 250; retry++) { if ((await call('/start-inspect', { jobKey: freezeJobKey })).container.barrier_entered === 2) break; await new Promise(done => setTimeout(done, 4)); }
  const readyFreezes = await call('/start-inspect', { jobKey: freezeJobKey }); assert.equal(readyFreezes.container.barrier_entered, 2); assert.equal(readyFreezes.job.phase, 'STOPPED'); assert.equal(readyFreezes.job.terminationObserved, true); assert.equal(readyFreezes.retainedObservations.length, 2);
  await call('/start-release-last', { jobKey: freezeJobKey }); await newerFreeze;
  const selected = await call('/start-inspect', { jobKey: freezeJobKey }), selectedDigest = await digest(selected.job.callback); assert.equal(selected.job.callbackDelivered, true);
  await call('/start-release', { jobKey: freezeJobKey }); await olderFreeze;
  const preserved = await call('/start-inspect', { jobKey: freezeJobKey }); assert.equal(preserved.job.phase, 'STOPPED'); assert.equal(preserved.job.terminationObserved, true); assert.equal(preserved.job.callbackDelivered, true); assert.equal(await digest(preserved.job.callback), selectedDigest); assert.equal(preserved.container.pending, 0); assert.equal(preserved.retainedObservations.length, 2);
  checks.push('Two production freezes retain actual R2 observations; older pre-stop freeze returns last but cannot replace selected signed bytes, delivered acknowledgment or confirmed termination');
  results.push({ case: 'older-freeze-after-selected-stop', callbackDigest: selectedDigest, phase: preserved.job.phase, actualRetainedObservations: 2, eligibleForSchedulerRelease: preserved.job.terminationObserved && preserved.job.callbackDelivered && preserved.job.fixtureClosed });
  assert.ok(results.every((result: any) => result.eligibleForSchedulerRelease === true));
  const testedInputs = Object.fromEntries(await Promise.all(['infra/evaluator-stop-runtime-check.ts', 'workers/shared/deadline.ts', 'workers/shared/age.ts', 'workers/evaluator/index.ts', 'workers/evaluator/recovery.ts', 'workers/evaluator/hydration.ts', 'workers/evaluator/overlap.ts', 'workers/evaluator/recipes.ts', 'infra/test-evaluator/worker.ts', 'infra/test-evaluator/hydration-fixture.ts', 'packages/protocol/wasm/confidence_protocol_bg.wasm'].map(async path => [path, await sha256(await readFile(resolve(path)))])));
  const report = Buffer.from(JSON.stringify({ schemaVersion: 1, status: 'PASS', runtime: 'Actual local workerd EvaluationSandbox run/status/alarm/stop and FixtureStore fencing with persistent SQLite/R2 and explicitly fake whole-container and Files effects', checks, testedInputs, results, startRaces, hydrationResults, fixtureResults, diagnosticResults, finalSnapshotResults, received: await call('/callback-inspect'), limitations: ['Test-only seeded lifecycle outcomes and finite final-store metadata faults use public conformance keys; no candidate application, model, container, provider or live Cloudflare result is claimed.', 'Native container effects use executionContainer/stopContainer overrides with owned scheduling barriers. Production run, registration, validation, execution continuation, freeze, status/alarm/stop and callback logic run unchanged; one initial alarm and observation retention fail through owned seams.', 'The production hydration helper runs against owned fake Files/exec effects. This tests validation and ordering, not Sandbox shim or live Container semantics; test Git IDs are placeholders because source ingestion is tested separately.', 'EvaluationSandbox test alarm timing is disabled for deterministic invocation; FixtureStore deadline alarms and restart use actual runtime/persistent storage.', 'Scheduler release eligibility requires terminationObserved && callbackDelivered && fixtureClosed; the separate scheduler runtime suite exercises actual slot accounting.'] }, null, 2));
  assert.ok(report.length <= 64 * 1024); await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, report);
  process.stdout.write(JSON.stringify({ status: 'PASS', checks: checks.length, cases: results.length, hydrationCases: hydrationResults.length, report: reportPath, containerEffects: 'owned-fake' }) + '\n');
} finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
