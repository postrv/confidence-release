// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { canonicalize, sha256 } from '../packages/protocol/src/index.ts';
import { createHash } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'confidence-runner-workerd-')), bundleDirectory = join(directory, 'bundle'); await mkdir(bundleDirectory);
const reportPath = resolve(process.env.RUNNER_RUNTIME_REPORT || 'demo-output/runner-runtime.json');
await promisify(execFile)(resolve('node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--config', 'infra/test-runner/wrangler.jsonc', '--outdir', bundleDirectory], { cwd: resolve('.'), env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, maxBuffer: 4 * 1024 * 1024, timeout: 60000 });
const scripts = (await readdir(bundleDirectory)).filter(name => name.endsWith('.js')); assert.equal(scripts.length, 1);
const options = convertV4MiniflareOptions({ name: 'owned-runner-runtime', modulesRoot: bundleDirectory, modules: [{ type: 'ESModule', path: join(bundleDirectory, scripts[0]) }, ...(await readdir(bundleDirectory)).filter(name => name.endsWith('.wasm')).map(name => ({ type: 'CompiledWasm' as const, path: join(bundleDirectory, name) }))], compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat', 'enable_request_signal'], durableObjects: { ATTEMPTS: { className: 'OwnedRunner', useSQLite: true }, CALLBACKS: { className: 'OwnedCallbacks', useSQLite: true } }, serviceBindings: { AUTHORITY: 'owned-runner-runtime' }, r2Buckets: { OBJECTS: 'owned-runner-model-objects' }, resourcePersistencePath: join(directory, 'persist'), log: new Log(LogLevel.ERROR), bindings: { RUNNER_SERVICE_TOKEN: 'owned-test-only-service-token-not-a-credential', MAINTENANCE_MODE: 'false', MODEL_PROVIDER_KIND: 'openai-compatible', MODEL_NAME: 'owned-no-provider-call', MODEL_API_BASE_URL: 'https://owned-provider.invalid/v1', MODEL_API_KEY: 'owned-placeholder-not-a-provider-credential', MODEL_OUTPUT_TOKEN_FIELD: 'max_tokens', MODEL_REASONING_EFFORT: 'UNCONFIGURED', MODEL_MAXIMUM_CALL_COST: '100000', AUTHORING_IMAGE_DIGEST: 'sha256:' + '9'.repeat(64) } });
let runtime = new Miniflare(options); const checks: string[] = [];
async function call(path: string, body: unknown = {}): Promise<any> { const response = await runtime.dispatchFetch('http://owned.test' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result; }
try {
  await runtime.ready;
  let state = await call('/seed', { scope: { schemaVersion: 1, tenantId: 'tenant', projectId: 'project', projectIncarnation: 'owned-generation' }, attemptId: 'owned-attempt', commit: '1'.repeat(40) }); assert.equal(state.admits, true);
  const failed = await call('/stop'); assert.equal(failed.failure, 'OWNED_DESTROY_UNCONFIRMED'); state = failed.state;
  assert.equal(state.execution.lifecycle, 'STOP_REQUESTED'); assert.equal(state.execution.admissions, 'FENCED'); assert.equal(state.execution.capacityHeld, true); assert.equal(state.admits, false); assert.equal(state.container.running, 1); assert.equal(state.container.fence_delivered_at_destroy, 1);
  let callbacks = await call('/callbacks'); assert.equal(callbacks[0].lifecycle, 'STOP_REQUESTED');
  checks.push('Production stop durably fences the local broker and reports STOP_REQUESTED before owned fake destruction; failed destruction retains running generation and capacity');
  await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready; state = await call('/inspect');
  assert.equal(state.execution.lifecycle, 'UNKNOWN'); assert.equal(state.execution.admissions, 'FENCED'); assert.equal(state.execution.capacityHeld, true); assert.equal(state.admits, false); assert.equal(state.container.inactivity, 120000);
  assert.ok(state.outbox.some((row: any) => JSON.parse(row.payload).lifecycle === 'UNKNOWN' && row.state === 'PENDING'));
  checks.push('Actual workerd restart retains local fence/occupied capacity, restores inactivity configuration and durably queues trusted UNKNOWN before stop reconciliation');
  state = await call('/reconcile'); assert.equal(state.execution.lifecycle, 'STOPPED'); assert.equal(state.execution.capacityHeld, false); assert.equal(state.admits, false); assert.equal(state.container.running, 0); assert.equal(state.container.destroy_calls, 2);
  callbacks = await call('/callbacks'); assert.ok(callbacks.some((row: any) => row.lifecycle === 'UNKNOWN')); assert.equal(callbacks.at(-1).lifecycle, 'STOPPED'); assert.ok(callbacks.every((row: any) => row.generation === '1' && row.attemptId === 'owned-attempt')); assert.ok(state.outbox.every((row: any) => row.state === 'DELIVERED'));
  checks.push('Production alarm retries the same recorded generation, delivers fence then verified STOPPED, and releases local occupancy only after destroy plus inspect-null');
  const count = callbacks.length; await call('/stop'); await call('/reconcile'); assert.equal((await call('/callbacks')).length, count); assert.equal((await call('/inspect')).container.destroy_calls, 2);
  checks.push('Stopped retries preserve immutable callback IDs and do not destroy or reauthorize the old generation again');
  const stalled = { runnerName: 'stalled-callback' };
  await call('/seed', { ...stalled, scope: { schemaVersion: 1, tenantId: 'tenant', projectId: 'project', projectIncarnation: 'owned-stalled-generation' }, attemptId: 'stalled-callback', commit: '1'.repeat(40) });
  await call('/callback-hold', { hold: true });
  const failedPending = await call('/stop', stalled);
  assert.equal(failedPending.failure, 'OWNED_DESTROY_UNCONFIRMED'); assert.equal(failedPending.state.container.destroy_calls, 1); assert.equal(failedPending.state.execution.capacityHeld, true);
  assert.equal(failedPending.state.container.fence_delivered_at_destroy, 0); assert.equal(failedPending.state.admits, false);
  const stoppedPending = await call('/stop', stalled);
  assert.equal(stoppedPending.state.container.destroy_calls, 2); assert.equal(stoppedPending.state.container.running, 0); assert.equal(stoppedPending.state.execution.lifecycle, 'STOPPED');
  const pendingIds = stoppedPending.state.outbox.map((row: any) => row.id); assert.ok(stoppedPending.state.outbox.every((row: any) => row.state === 'PENDING'));
  await call('/callback-hold', { hold: false }); await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
  const recoveredPending = await call('/reconcile', stalled);
  assert.equal(recoveredPending.container.destroy_calls, 2); assert.deepEqual(recoveredPending.outbox.map((row: any) => row.id), pendingIds); assert.ok(recoveredPending.outbox.every((row: any) => row.state === 'DELIVERED'));
  checks.push('Pending callback cannot prevent destruction: failed native stop keeps capacity, native absence stops the generation, and restart delivers only the original immutable outbox identities');
  const startRaces: unknown[] = [];
  for (const scenario of [
    { id: 'stop-during-start-alarm', barrier: 'alarm', deadline: false, starts: 0 },
    { id: 'deadline-during-start-alarm', barrier: 'alarm', deadline: true, starts: 0 },
    { id: 'stop-during-inactivity-preparation', barrier: 'inactivity', deadline: false, starts: 1 },
  ] as const) {
    const body = { runnerName: scenario.id };
    await call('/start-seed', { ...body, scope: { schemaVersion: 1, tenantId: 'tenant', projectId: 'project', projectIncarnation: 'owned-generation' }, attemptId: scenario.id, commit: '1'.repeat(40), barrier: scenario.barrier });
    const pending = call('/start', body);
    let held: any;
    for (let retry = 0; retry < 250; retry++) { held = await call('/inspect', body); if (held.container.barrier_entered) break; await new Promise(done => setTimeout(done, 4)); }
    assert.equal(held.container.barrier_entered, 1, scenario.id + ': actual asynchronous preparation barrier not reached');
    assert.equal(held.execution.lifecycle, 'START_MAY_HAVE_DISPATCHED'); assert.equal(held.execution.capacityHeld, true);
    if (scenario.deadline) await call('/start-expire', body); else await call('/stop', body);
    const stopped = await call('/inspect', body); assert.equal(stopped.execution.lifecycle, 'STOPPED'); assert.equal(stopped.execution.admissions, 'FENCED');
    await call('/start-release', body); const completion = await pending;
    assert.equal(completion.failure, 'AUTHORING_GENERATION_FENCED');
    const final = await call('/inspect', body); assert.equal(final.execution.lifecycle, 'STOPPED'); assert.equal(final.execution.capacityHeld, false); assert.equal(final.container.running, 0); assert.equal(final.container.start_calls, scenario.starts); assert.equal(final.container.exec_calls, 0); assert.equal(final.admits, false);
    assert.deepEqual(final.startOptions, scenario.starts === 1 ? { image: 'owned-fake@sha256:' + '9'.repeat(64), enableInternet: false, instance: { vcpu: 1, memoryMib: 3072, diskMb: 2000 } } : null);
    await call('/start', body); assert.equal((await call('/inspect', body)).container.start_calls, scenario.starts);
    startRaces.push({ scenario: scenario.id, nativeStarts: final.container.start_calls, nativeExecs: final.container.exec_calls, startOptions: final.startOptions, lifecycle: final.execution.lifecycle, outcome: final.execution.outcome });
    checks.push(`Production start ${scenario.id} resumes only to a durable fence; no stopped generation restarts or begins workload execution`);
  }
  checks.push('Production native start selects the fixed 1 vCPU/3072 MiB/2000 MB authoring profile with internet disabled; pre-start fencing dispatches no container options');
  const modelRunner = { runnerName: 'owned-model-outbox' };
  const modelScope = { schemaVersion: 1, tenantId: 'tenant', projectId: 'project', projectIncarnation: 'owned-model-incarnation' };
  await call('/seed', { ...modelRunner, scope: modelScope, attemptId: 'owned-model-outbox', commit: '1'.repeat(40) });
  const modelCallId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const observationBase = { scope: modelScope, attemptId: 'owned-model-outbox', generation: '1', callId: modelCallId,
    requestDigest: 'sha256:' + '4'.repeat(64), providerKind: 'workers-ai', requestedModel: '@cf/zai-org/glm-5.3', producer: 'broker-observed', maximumReservedCost: '100000' };
  const queueModel = (phase: 'DISPATCH' | 'RESPONSE', extra: Record<string, unknown> = {}) => {
    const observation = canonicalize(phase === 'DISPATCH' ? { ...observationBase, reasoningEffort: 'low', state: 'MAY_HAVE_DISPATCHED', ...extra }
      : { ...observationBase, responseDigest: 'sha256:' + '5'.repeat(64), reportedModel: '@cf/zai-org/glm-5.3', responseId: 'owned-provider-response',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, outcome: 'RESPONSE', ...extra });
    const fact = { schemaVersion: 1, scope: modelScope, attemptId: 'owned-model-outbox', generation: '1', callId: extra.callId ?? modelCallId,
      phase, observationDigest: 'sha256:' + createHash('sha256').update(observation).digest('hex') };
    return { ...modelRunner, fact, observation };
  };
  const dispatchFact = queueModel('DISPATCH'); await call('/model-queue', dispatchFact);
  const queuedModel = await call('/inspect', modelRunner), immutableModel = queuedModel.outbox.find((row: any) => row.kind === 'MODEL');
  assert.equal(immutableModel.state, 'PENDING'); assert.equal(immutableModel.payload, canonicalize(dispatchFact.fact)); assert.equal(immutableModel.object_payload, dispatchFact.observation);
  await call('/model-ack-failure', { fail: true }); await call('/reconcile', modelRunner);
  assert.equal((await call('/model-receipts'))[modelCallId + '/DISPATCH'], dispatchFact.fact.observationDigest);
  assert.equal((await call('/inspect', modelRunner)).outbox.find((row: any) => row.kind === 'MODEL').state, 'PENDING');
  await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
  const modelFirstStop = await call('/stop', modelRunner); assert.equal(modelFirstStop.failure, 'OWNED_DESTROY_UNCONFIRMED');
  const modelStopped = await call('/stop', modelRunner); assert.equal(modelStopped.state.execution.lifecycle, 'STOPPED'); assert.equal(modelStopped.state.container.running, 0);
  await call('/reconcile', modelRunner);
  const afterLostAck = await call('/inspect', modelRunner);
  assert(afterLostAck.outbox.some((row: any) => row.kind === 'MODEL' && row.state === 'PENDING'));
  assert(afterLostAck.outbox.filter((row: any) => row.kind === 'RUNTIME').every((row: any) => row.state === 'DELIVERED'));
  assert.equal(afterLostAck.outbox.find((row: any) => row.kind === 'MODEL').payload, immutableModel.payload);
  checks.push('Model fact is durably queued before acknowledgement, survives actual workerd restart/lost ACK with exact bytes, and failed accounting never blocks confirmed STOPPED lifecycle callbacks');
  await call('/model-ack-failure', { fail: false }); await call('/reconcile', modelRunner);
  const responseFact = queueModel('RESPONSE'); await call('/model-queue', responseFact); await call('/reconcile', modelRunner);
  const completedModel = await call('/inspect', modelRunner);
  assert.equal(completedModel.execution.lifecycle, 'STOPPED'); assert.equal(completedModel.container.destroy_calls, 2); assert.equal(completedModel.container.exec_calls, 0);
  assert(completedModel.outbox.every((row: any) => row.state === 'DELIVERED'));
  assert.equal((await call('/model-receipts'))[modelCallId + '/RESPONSE'], responseFact.fact.observationDigest);
  await call('/model-queue', responseFact); await call('/reconcile', modelRunner);
  assert.equal(Object.keys(await call('/model-receipts')).length, 2);
  const conflictResponse = await runtime.dispatchFetch('http://owned.test/model-queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(queueModel('RESPONSE', { responseId: 'conflicting' })) });
  assert.equal(conflictResponse.status, 409); assert.match((await conflictResponse.json() as any).error, /MODEL_CALL_FACT_CONFLICT/);
  checks.push('Stopped controller accepts only its exact late model fact, repeats immutable acknowledgement without new effects, rejects phase substitution and never runs native/provider work');
  for (let index = 1; index <= 3; index++) { const id = 'dddddddd-dddd-4ddd-8ddd-' + String(index).padStart(12, '0'); for (const phase of ['DISPATCH','RESPONSE'] as const) await call('/model-queue', queueModel(phase, { callId: id })); }
  const ninth = await runtime.dispatchFetch('http://owned.test/model-queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(queueModel('DISPATCH', { callId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })) });
  assert.equal(ninth.status, 409); assert.match((await ninth.json() as any).error, /MODEL_CALL_FACT_LIMIT/);
  for (let index = 0; index < 4; index++) await call('/reconcile', modelRunner);
  const finalModels = await call('/inspect', modelRunner); assert.equal(finalModels.outbox.filter((row: any) => row.kind === 'MODEL').length, 8); assert(finalModels.outbox.every((row: any) => row.state === 'DELIVERED'));
  checks.push('Per-generation model outbox admits at most two immutable phases for each of four calls; a ninth fact is rejected and bounded replay drains existing metadata only');
  const inputs = ['infra/runner-runtime-check.ts', 'workers/runner/context.ts', 'workers/runner/diagnostics.ts', 'workers/runner/hydration.ts', 'packages/protocol/src/session-context.ts', 'workers/runner/index.ts', 'workers/shared/deadline.ts', 'workers/shared/model-call.ts', 'infra/test-runner/worker.ts', 'infra/test-runner/wrangler.jsonc', 'packages/protocol/wasm/confidence_protocol_bg.wasm'];
  const testedInputs = Object.fromEntries(await Promise.all(inputs.map(async path => [path, await sha256(await readFile(path))])));
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify({ schemaVersion: 1, status: 'PASS', runtime: 'Actual local workerd SQLite persistence with production AttemptRunner; owned fake container and callback receiver', testedInputs, checks, callbacks, startRaces, limitations: ['Native Container destruction, networking, workload and provider identity are not exercised.', 'Container effects use an explicit narrow executionContainer override; real production constructor, start, stop, alarm, local canAdmit fence and callback outbox run unchanged. The real alarm write is followed by an owned test scheduling barrier.', 'Automatic alarm timing is disabled for controlled fault order; a separate authority suite checks real alarm delivery.', 'The callback receiver acknowledges bytes only; actual authority grant fencing and held reservations are covered by the authority runtime suite.'] }, null, 2));
  process.stdout.write(JSON.stringify({ status: 'PASS', checks: checks.length, report: reportPath, nativeContainerEffects: 'not-tested-owned-fake' }) + '\n');
} finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
