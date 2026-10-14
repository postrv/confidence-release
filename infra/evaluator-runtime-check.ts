import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { initializeKernel } from '../packages/protocol/src/node.ts';
import { digest, sha256 } from '../packages/protocol/src/index.ts';
import { vector } from '../tests/conformance/vector.ts';
import { buildEvaluationPlan, FULL_RELEASE_JOB_COUNT } from '../workers/evaluator/recipes.ts';
import type { AdmissionCandidate, EvaluationPlan, GitObject, Scope, SourceManifest, IssuanceContext } from '../packages/protocol/src/types.ts';
// Keep host and Workers ambient types separate while sending the exact shared
// wire fields accepted by production scheduler validation.
type EvaluationContext = { schemaVersion: 1; id: string; goalRevision: string; policyRevision: string; contractBundleDigest: string };
type EvaluationRequest = { scope: Scope; evaluation: EvaluationContext; issuance?: IssuanceContext; checkerKeyId?: string; plan: EvaluationPlan; candidate: AdmissionCandidate; job: EvaluationPlan['jobs'][number]; source: { commit: string; commitBytesDigest: string; parent: string | null; manifest: SourceManifest; manifestDigest: string; objects: GitObject[]; objectsDigest: string } };

await initializeKernel(); const fixture = await vector();
const directory = await mkdtemp(join(tmpdir(), 'confidence-evaluator-workerd-')), bundleDirectory = join(directory, 'bundle'); await mkdir(bundleDirectory);
const reportPath = resolve(process.env.EVALUATOR_RUNTIME_REPORT || 'demo-output/evaluator-runtime.json');
const imageDigest = 'sha256:' + '1'.repeat(64), checkerDigest = 'sha256:' + '2'.repeat(64);
const deployment = { EVALUATION_IMAGE_DIGEST: imageDigest, CHECKER_IMPLEMENTATION_DIGEST: checkerDigest };
const source = { commit: fixture.input.candidate.commit, commitBytesDigest: fixture.input.candidate.commitBytesDigest, parent: fixture.input.candidate.parent, manifest: fixture.bundle.inputs.manifest, manifestDigest: fixture.input.candidate.manifestDigest, objects: [], objectsDigest: await digest(fixture.bundle.inputs.gitObjects) };
const evaluation = (id: string): EvaluationContext => ({ schemaVersion: 1, id, goalRevision: '1', policyRevision: '1', contractBundleDigest: 'sha256:' + '3'.repeat(64) });
const diagnosticIds = ['diagnostic-one', 'diagnostic-two', 'diagnostic-queued-first'];
const diagnostics = await Promise.all(diagnosticIds.map(id => buildEvaluationPlan(fixture.input.state.scope, fixture.input.candidate, evaluation(id), deployment, 'freshness')));
const releaseEvaluation = evaluation('release-full-plan');
const releasePlan = await buildEvaluationPlan(fixture.input.state.scope, fixture.input.candidate, releaseEvaluation, deployment, 'full'); assert.equal(releasePlan.jobs.length, FULL_RELEASE_JOB_COUNT);
const requests: EvaluationRequest[] = [...diagnostics.map((plan, index) => ({ scope: fixture.input.state.scope, evaluation: evaluation(diagnosticIds[index]), candidate: fixture.input.candidate, plan, source, job: plan.jobs[0] })), ...releasePlan.jobs.slice(0, 2).map(job => ({ scope: fixture.input.state.scope, evaluation: releaseEvaluation, candidate: fixture.input.candidate, plan: releasePlan, source, job }))];
for (const request of requests) { request.issuance = { schemaVersion: 1, scope: request.scope, signerKeysetRevision: '1', authorityRevision: '1' }; request.checkerKeyId = 'checker-1'; }
const keys = await Promise.all(requests.map(async request => (await digest({ scope: request.scope, jobId: request.job.id })).slice(7)));
const requestDigests = await Promise.all(requests.map(request => digest(request)));
const run = promisify(execFile);
await run(resolve('node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--config', 'infra/test-evaluator/wrangler.jsonc', '--outdir', bundleDirectory], { cwd: resolve('.'), env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
const scripts = (await readdir(bundleDirectory)).filter(name => name.endsWith('.js')); assert.equal(scripts.length, 1);
const options = convertV4MiniflareOptions({ name: 'owned-evaluator-runtime', modulesRoot: bundleDirectory, modules: [{ type: 'ESModule', path: join(bundleDirectory, scripts[0]) }, ...(await readdir(bundleDirectory)).filter(name => name.endsWith('.wasm')).map(name => ({ type: 'CompiledWasm' as const, path: join(bundleDirectory, name) }))], compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'], durableObjects: { SCHEDULER: { className: 'TestScheduler', useSQLite: true }, EVALUATIONS: { className: 'FakeEvaluation', useSQLite: true } }, r2Buckets: { OBJECTS: 'owned-evaluator-test-objects' }, resourcePersistencePath: join(directory, 'persist'), log: new Log(LogLevel.ERROR), bindings: { ...deployment, CHECKER_KEY_ID: 'checker-1', EVALUATOR_SERVICE_TOKEN: 'owned-test-service-token-'.padEnd(40, 'x') } });
let runtime = new Miniflare(options); const checks: string[] = [];
async function call(path: string, body?: unknown, status = 200): Promise<any> {
  const response = await runtime.dispatchFetch('http://owned.test' + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result: any = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
}
async function fake(index: number): Promise<any> { return call('/fake-inspect', { jobKey: keys[index] }); }
async function set(index: number, phase: string, terminationObserved: boolean, callbackDelivered: boolean): Promise<void> { await call('/fake-state', { jobKey: keys[index], state: { phase, terminationObserved, callbackDelivered } }); }
async function pump(): Promise<any> { return call('/pump', {}); }
function count(state: any, status: string): number { return Object.values(state.jobs).filter((job: any) => job.status === status).length; }
try {
  await runtime.ready; assert.equal((await call('/seed-objects', fixture.bundle.inputs.gitObjects)).digest, source.objectsDigest);
  const partialIssuance = structuredClone(requests[0]); delete partialIssuance.checkerKeyId; assert.equal((await call('/enqueue', partialIssuance, 400)).error.code, 'INCOMPLETE_CHECKER_ISSUANCE');
  const wrongChecker = structuredClone(requests[0]); wrongChecker.checkerKeyId = 'unregistered-checker'; assert.equal((await call('/enqueue', wrongChecker, 400)).error.code, 'REGISTERED_CHECKER_KEY_MISMATCH');
  const extraIssuance = structuredClone(requests[0]); (extraIssuance.issuance as any).unexpected = true; assert.equal((await call('/enqueue', extraIssuance, 400)).error.code, 'INVALID_CHECKER_ISSUANCE');
  const foreignIssuance = structuredClone(requests[0]); foreignIssuance.issuance!.scope = { ...foreignIssuance.scope, projectIncarnation: 'foreign' }; assert.equal((await call('/enqueue', foreignIssuance, 400)).error.code, 'INVALID_CHECKER_ISSUANCE');
  assert.equal(Object.keys((await call('/inspect')).jobs).length, 0); checks.push('Production validation freezes closed scope-bound issuance and checker identity before dispatch; partial, unknown-field, foreign-scope and wrong configured key requests reserve no slot');
  const wrongInput = structuredClone(requests[0]); wrongInput.job.inputDigest = 'sha256:' + '9'.repeat(64); wrongInput.plan.jobs[0] = wrongInput.job; wrongInput.plan.digest = await digest({ candidateId: wrongInput.plan.candidateId, candidateDigest: wrongInput.plan.candidateDigest, jobs: wrongInput.plan.jobs });
  assert.equal((await call('/enqueue', wrongInput, 400)).error.code, 'INPUT_DIGEST_MISMATCH');
  const tampered = structuredClone(requests[0]); const badObjects = structuredClone(fixture.bundle.inputs.gitObjects); badObjects.find(object => object.type === 'blob')!.dataBase64 = Buffer.from('tampered').toString('base64'); tampered.source.objects = badObjects; tampered.source.objectsDigest = await digest(badObjects);
  const invalidSource = await call('/enqueue', tampered, 400); assert.ok(invalidSource.error.code); assert.equal(Object.keys((await call('/inspect')).jobs).length, 0); checks.push('Production fetch validates registered real recipe input digest and raw Git/WASM source closure before reserving a slot');
  await call('/enqueue', requests[0], 202); await call('/enqueue', requests[1], 202); let state = await pump();
  assert.equal(count(state, 'ACTIVE'), 2); for (const index of [0, 1]) { const execution = await fake(index); assert.equal(execution.status.phase, 'MISSING'); assert.ok(execution.attempts.length >= 1); assert.equal(execution.state, null); }
  checks.push('Both durable slots remain ACTIVE after owned failures before executor registration; execution status is MISSING');
  for (const index of [2, 3, 4]) await call('/enqueue', requests[index], 202); state = await pump(); assert.equal(count(state, 'ACTIVE'), 2); assert.equal(count(state, 'QUEUED'), 3);
  for (const index of [2, 3, 4]) assert.equal((await fake(index)).attempts.length, 0);
  const retainedBeforeRestart = structuredClone(state.jobs); await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
  state = await call('/inspect'); assert.deepEqual(state.jobs, retainedBeforeRestart); for (const index of [0, 1]) await call('/fake-arm', { jobKey: keys[index] });
  state = await pump(); assert.equal(count(state, 'ACTIVE'), 2);
  for (const index of [0, 1]) { const execution = await fake(index); assert.equal(execution.state.registrations, 1); assert.equal(execution.status.phase, 'RUNNING'); assert.ok(execution.attempts.length >= 2); assert.ok(execution.attempts.every((attempt: any) => attempt.requestDigest === requestDigests[index] && attempt.jobId === requests[index].job.id && attempt.inputDigest === requests[index].job.inputDigest)); }
  checks.push('Fresh workerd restarts retain SQLite reservations and R2 requests; MISSING retries exact immutable request at the same DO/job identity and makes progress');
  const beforeUnknown = (await fake(0)).attempts.length; await set(0, 'UNKNOWN', false, false); state = await pump(); assert.equal(state.jobs[keys[0]].status, 'ACTIVE'); assert.equal((await fake(0)).attempts.length, beforeUnknown);
  await set(0, 'STOPPED', true, false); state = await pump(); assert.equal(state.jobs[keys[0]].status, 'ACTIVE'); assert.equal(count(state, 'QUEUED'), 3);
  checks.push('UNKNOWN causes no repeat run; confirmed stop without delivered callback still holds capacity');
  for (const index of [2, 3, 4]) await call('/fake-arm', { jobKey: keys[index] });
  await set(0, 'STOPPED', true, true); state = await pump(); assert.equal(state.jobs[keys[0]].status, 'DONE'); assert.equal(state.jobs[keys[3]].status, 'ACTIVE'); assert.equal(state.jobs[keys[2]].status, 'QUEUED'); assert.equal((await fake(3)).status.phase, 'MISSING');
  state = await pump(); assert.equal((await fake(3)).status.phase, 'RUNNING'); assert.equal((await fake(3)).state.registrations, 1);
  checks.push('Joint stop and callback confirmation releases a slot; full-plan release job outranks the earlier queued diagnostic and first-run failure recovers');
  await set(1, 'UNKNOWN', false, false); const unknownAttempts = (await fake(1)).attempts.length; const beforeSecondRestart = structuredClone((await pump()).jobs);
  await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready; state = await pump(); assert.deepEqual(state.jobs, beforeSecondRestart); assert.equal((await fake(1)).attempts.length, unknownAttempts);
  await set(1, 'STOPPED', true, true); state = await pump(); assert.equal(state.jobs[keys[4]].status, 'ACTIVE'); assert.equal(state.jobs[keys[2]].status, 'QUEUED'); await pump(); assert.equal((await fake(4)).status.phase, 'RUNNING');
  await set(3, 'STOPPED', true, true); state = await pump(); assert.equal(state.jobs[keys[2]].status, 'ACTIVE'); await pump(); assert.equal((await fake(2)).status.phase, 'RUNNING');
  await set(4, 'STOPPED', true, true); await set(2, 'UNKNOWN', false, true); state = await pump(); assert.equal(state.jobs[keys[2]].status, 'ACTIVE');
  await set(2, 'STOPPED', true, true); state = await pump(); assert.equal(count(state, 'DONE'), 5); assert.equal(count(state, 'ACTIVE'), 0); assert.equal(count(state, 'QUEUED'), 0);
  checks.push('Restart preserves UNKNOWN occupancy; queued release jobs complete before diagnostics, callback without stop holds, and all five jobs eventually settle');
  const duplicate = await call('/enqueue', requests[0], 202); assert.equal(duplicate.status, 'DONE'); state = await pump(); assert.equal(count(state, 'DONE'), 5);
  const changedBody = structuredClone(requests[0]); changedBody.source.objects = fixture.bundle.inputs.gitObjects; const reused = await call('/enqueue', changedBody, 409); assert.equal(reused.error.code, 'JOB_ID_REUSE');
  const executions = await Promise.all(keys.map((_, index) => fake(index))); executions.forEach((execution, index) => { assert.equal(execution.state.registrations, 1); assert.ok(execution.attempts.every((attempt: any) => attempt.requestDigest === requestDigests[index])); });
  checks.push('Completed duplicate enqueue replays DONE; same job identity with a changed request rejects, with one fake registration for every retained request');
  // Seed the exact old KV representation, then instantiate a fresh workerd so
  // the production constructor performs its durable, atomic migration.
  const legacy: Record<string, unknown> = { [keys[0]]: { digest: requestDigests[0], object: requestDigests[0], status: 'DONE', priority: 0 } };
  for (let index = 1; index < 256; index++) legacy[index.toString(16).padStart(64, '0')] = { digest: 'sha256:' + '4'.repeat(64), object: 'sha256:' + '5'.repeat(64), status: 'DONE', priority: index % 2 };
  await call('/seed-legacy?scheduler=legacy-history', legacy);
  const pendingLegacy = Object.fromEntries(Object.entries(legacy).map(([key, value]) => [key, { ...(value as object), status: 'QUEUED' }]));
  await call('/seed-legacy?scheduler=legacy-full-queue', pendingLegacy);
  const occupiedLegacy = { ...legacy, [keys[0]]: { digest: requestDigests[0], object: requestDigests[0], status: 'ACTIVE', priority: 0 }, [keys[1]]: { digest: requestDigests[1], object: requestDigests[1], status: 'ACTIVE', priority: 0 } };
  delete (occupiedLegacy as Record<string, unknown>)[(255).toString(16).padStart(64, '0')];
  await call('/seed-legacy?scheduler=legacy-occupied', occupiedLegacy);
  await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
  const occupied = await call('/inspect?scheduler=legacy-occupied'); assert.equal(count(occupied, 'ACTIVE'), 2); assert.equal(count(occupied, 'DONE'), 254); assert.ok(occupied.alarm > Date.now());
  for (const key of [keys[0], keys[1]]) { const { project_key, created_at_ms, ...actual } = occupied.jobs[key]; assert.equal(created_at_ms, null); assert.deepEqual(actual, occupiedLegacy[key]); }
  let migrated = await call('/inspect?scheduler=legacy-history'); assert.equal(count(migrated, 'DONE'), 256);
  for (const [key, value] of Object.entries(legacy)) { const { project_key, created_at_ms, ...actual } = migrated.jobs[key]; assert.equal(created_at_ms, null); assert.deepEqual(actual, value); }
  assert.equal((await call('/enqueue?scheduler=legacy-history', requests[0], 202)).status, 'DONE');
  assert.equal((await call('/enqueue?scheduler=legacy-history', changedBody, 409)).error.code, 'JOB_ID_REUSE');
  await call('/enqueue?scheduler=legacy-history', requests[1], 202); migrated = await call('/pump?scheduler=legacy-history', {}); migrated = await call('/pump?scheduler=legacy-history', {});
  assert.equal(count(migrated, 'DONE'), 257); assert.equal(migrated.jobs[keys[1]].status, 'DONE');
  assert.equal((await call('/enqueue?scheduler=legacy-full-queue', requests[1], 429)).error.code, 'EVALUATION_QUEUE_FULL');
  assert.equal(Object.keys((await call('/inspect?scheduler=legacy-full-queue')).jobs).length, 256);
  await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
  assert.deepEqual((await call('/inspect?scheduler=legacy-history')).jobs, migrated.jobs);
  assert.equal((await call('/enqueue?scheduler=legacy-history', requests[0], 202)).status, 'DONE');
  checks.push('Actual workerd preserves both occupied slots and immutable identities when migrating legacy state, migrates 256 legacy terminal jobs atomically, preserves old identity conflicts across restarts and completes job 257; 256 pending jobs still reject new work without adding a row');
  const sqlAgeKey = 'f'.repeat(64), sqlAgeScheduler = 'legacy-sql-age';
  await call('/seed-legacy-sql-age?scheduler=' + sqlAgeScheduler, { scope: requests[0].scope, jobKey: sqlAgeKey });
  await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
  const legacySql = await call('/operations?scheduler=' + sqlAgeScheduler, { scope: requests[0].scope });
  assert.equal(legacySql.scheduler.queued, 1); assert.equal(legacySql.scheduler.queuedAgeEvidence, 'LEGACY_UNKNOWN'); assert.equal(legacySql.scheduler.oldestQueuedAgeSeconds, null);
  assert.equal((await call('/inspect?scheduler=' + sqlAgeScheduler)).jobs[sqlAgeKey].created_at_ms, null);
  await call('/enqueue?scheduler=' + sqlAgeScheduler, requests[0], 202);
  let sqlAgeJobs = (await call('/inspect?scheduler=' + sqlAgeScheduler)).jobs;
  const newQueuedAt = sqlAgeJobs[keys[0]].created_at_ms;
  assert.ok(Number.isSafeInteger(newQueuedAt) && newQueuedAt > 0 && newQueuedAt <= Date.now());
  await call('/enqueue?scheduler=' + sqlAgeScheduler, requests[0], 202);
  assert.equal((await call('/inspect?scheduler=' + sqlAgeScheduler)).jobs[keys[0]].created_at_ms, newQueuedAt);
  await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
  sqlAgeJobs = (await call('/inspect?scheduler=' + sqlAgeScheduler)).jobs;
  assert.equal(sqlAgeJobs[sqlAgeKey].created_at_ms, null); assert.equal(sqlAgeJobs[keys[0]].created_at_ms, newQueuedAt);
  checks.push('Old scheduler SQL and KV inventories migrate with unknown creation time; new enqueue keeps its original timestamp through duplicate delivery and workerd restart');

  const schedulingRequests: EvaluationRequest[] = [];
  for (const [index, projectId, kind] of [[0, 'project-a', 'freshness'], [1, 'project-a', 'freshness'], [2, 'project-a', 'full'], [3, 'project-b', 'freshness']] as const) {
    const scope = { ...fixture.input.state.scope, projectId }, context = evaluation('bounded-rpc-' + index);
    const plan = await buildEvaluationPlan(scope, fixture.input.candidate, context, deployment, kind);
    schedulingRequests.push({ scope, evaluation: context, candidate: fixture.input.candidate, plan, source, job: plan.jobs[0], issuance: { schemaVersion: 1, scope, signerKeysetRevision: '1', authorityRevision: '1' }, checkerKeyId: 'checker-1' });
  }
  const boundedKeys = await Promise.all(schedulingRequests.map(async request => (await digest({ scope: request.scope, jobId: request.job.id })).slice(7)));
  for (const request of schedulingRequests) await call('/enqueue?scheduler=bounded-rpc', request, 202);
  for (const jobKey of boundedKeys) await call('/fake-arm', { jobKey });
  await call('/pump?scheduler=bounded-rpc', {});
  await call('/fake-state', { jobKey: boundedKeys[0], state: { phase: 'STOPPED', terminationObserved: true, callbackDelivered: true, fixtureClosed: false } });
  let bounded = await call('/pump?scheduler=bounded-rpc', {}); assert.equal(bounded.jobs[boundedKeys[0]].status, 'ACTIVE'); assert.equal(count(bounded, 'QUEUED'), 2);
  await call('/fake-state', { jobKey: boundedKeys[0], state: { phase: 'STOPPED', terminationObserved: true, callbackDelivered: true, fixtureClosed: true } });
  await call('/fake-hold', { jobKey: boundedKeys[3], hold: 'run' });
  let started = Date.now(); bounded = await call('/pump?scheduler=bounded-rpc', {}); assert.ok(Date.now() - started < 8000);
  assert.equal(bounded.jobs[boundedKeys[3]].status, 'ACTIVE'); assert.equal(bounded.jobs[boundedKeys[2]].status, 'QUEUED'); assert.equal(count(bounded, 'ACTIVE'), 2); assert.ok(bounded.alarm > Date.now());
  assert.equal((await call('/fake-inspect', { jobKey: boundedKeys[3] })).holdEntered, 'run');
  await call('/pump?scheduler=bounded-rpc', {}); assert.equal((await call('/fake-inspect', { jobKey: boundedKeys[3] })).holdCount, 1);
  await call('/fake-hold', { jobKey: boundedKeys[3], hold: null });
  await call('/fake-hold', { jobKey: boundedKeys[1], hold: 'status' });
  started = Date.now(); bounded = await call('/pump?scheduler=bounded-rpc', {}); assert.ok(Date.now() - started < 8000);
  assert.equal(bounded.jobs[boundedKeys[1]].status, 'ACTIVE'); assert.equal(bounded.jobs[boundedKeys[3]].status, 'ACTIVE'); assert.equal((await call('/fake-inspect', { jobKey: boundedKeys[3] })).state.registrations, 1); assert.ok(bounded.alarm > Date.now());
  const projectA = await call('/operations?scheduler=bounded-rpc', { scope: schedulingRequests[0].scope });
  assert.equal(projectA.scheduler.active, 1); assert.equal(projectA.scheduler.queued, 1);
  assert.equal(projectA.scheduler.queuedAgeEvidence, 'RECORDED'); assert.ok(Number.isSafeInteger(projectA.scheduler.oldestQueuedAgeSeconds));
  assert.ok(projectA.recoveryEvents.some((event: any) => event.operation === 'status' && event.jobKey === boundedKeys[1] && event.code === 'EVALUATION_STATUS_DEADLINE' && event.occurrences >= 1));
  const projectB = await call('/operations?scheduler=bounded-rpc', { scope: schedulingRequests[3].scope });
  assert.equal(projectB.scheduler.active, 1); assert.ok(projectB.recoveryEvents.every((event: any) => event.jobKey === null || event.jobKey === boundedKeys[3]));
  assert.deepEqual(projectA.generations.map((generation: any) => generation.jobKey), [boundedKeys[1]]);
  assert.equal(projectA.generations[0].inspection, 'OBSERVED');
  assert.equal((await call('/operations?scheduler=bounded-rpc', { scope: schedulingRequests[3].scope, jobKey: boundedKeys[1] }, 409)).error, 'EVALUATION_JOB_NOT_FOUND');
  await call('/pump?scheduler=bounded-rpc', {}); assert.equal((await call('/fake-inspect', { jobKey: boundedKeys[1] })).holdCount, 1);
  await call('/fake-hold', { jobKey: boundedKeys[1], hold: null });
  await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
  const retainedRecovery = await call('/operations?scheduler=bounded-rpc', { scope: schedulingRequests[0].scope });
  assert.equal(retainedRecovery.recoveryEvents.find((event: any) => event.operation === 'status')?.eventId, projectA.recoveryEvents.find((event: any) => event.operation === 'status')?.eventId);
  checks.push('A held status RPC creates one bounded, scoped durable recovery event; operator inspection is read-only, filters another project, and survives workerd restart');
  checks.push('Fixture-close confirmation is required for slot release; a free slot favors another project over a busy project’s full plan, and held run/status RPCs remain single dispatched calls across repeated bounded pump attempts, retain occupied slots and durable wakeups while unrelated work progresses');
  const testedInputs = Object.fromEntries(await Promise.all(['infra/evaluator-runtime-check.ts', 'infra/test-evaluator/worker.ts', 'workers/shared/deadline.ts', 'workers/shared/age.ts', 'workers/evaluator/index.ts', 'workers/evaluator/recovery.ts', 'workers/evaluator/recipes.ts', 'workers/shared/objects.ts', 'packages/protocol/wasm/confidence_protocol_bg.wasm'].map(async path => [path, await sha256(await readFile(resolve(path)))])));
  await mkdir(dirname(reportPath), { recursive: true }); const reportBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, status: 'PASS', runtime: 'Actual local Miniflare/workerd SQLite Durable Objects and R2; fake evaluation execution', compatibilityDate: '2026-10-01', testedInputs, checks, requests: requests.map((request, index) => ({ jobKey: keys[index], jobId: request.job.id, planDigest: request.plan.digest, planJobs: request.plan.jobs.length, inputDigest: request.job.inputDigest, requestDigest: requestDigests[index], commit: request.candidate.commit, commitBytesDigest: request.candidate.commitBytesDigest, manifestDigest: request.candidate.manifestDigest, objectsDigest: request.source.objectsDigest, status: state.jobs[keys[index]].status, fakeRunAttempts: executions[index].attempts.length, fakeRegistrations: executions[index].state.registrations })), limitations: ['Test-only synthetic conformance Git source and image/checker deployment digest labels; actual registered recipe inputs and WASM source validation run in production scheduler fetch.', 'Fake execution uses controlled MISSING, UNKNOWN, stop and callback flags. No application, container, actual checker observation, model, provider or Cloudflare deployment outcome is claimed.', 'Automatic alarm timing is disabled by the test subclass; explicit pumping invokes unchanged production scheduler logic.', 'Fake executor transactionality does not establish production EvaluationSandbox container execution or callback conformance.'] }, null, 2));
  assert.ok(reportBytes.length <= 64 * 1024, 'Owned runtime report exceeds its 64 KiB bound'); await writeFile(reportPath, reportBytes);
  process.stdout.write(JSON.stringify({ status: 'PASS', checks: checks.length, retainedJobs: 5, allDone: true, report: reportPath, containerExecution: 'not-tested-fake' }) + '\n');
} finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
