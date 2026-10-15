// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { initializeKernel } from '../packages/protocol/src/node';
import { canonicalize, digest, encodeBase64, signStatement, statement } from '../packages/protocol/src/index';
import { vector, testKey } from '../tests/conformance/vector';
import { FULL_RELEASE_JOB_COUNT } from '../workers/evaluator/recipes';
import { RECOVERY_MARKER } from './authority-recovery';

test('actual production authority restores owned SQL/KV/R2, restarts and reconciles fixed UNKNOWN effects without redispatch or model refund', { timeout: 90000 }, async () => {
  await initializeKernel(); const fixture = await vector(true), checker = await testKey('02');
  const directory = await mkdtemp(join(tmpdir(), 'confidence-authority-recovery-owned-')), output = join(directory, 'bundle'); await mkdir(output);
  let runtime: Miniflare | undefined, sourceFenced = false, deniedOutbound = 0;
  try {
    const childEnv = { ...process.env }; for (const key of Object.keys(childEnv)) if (!['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'].includes(key)) delete childEnv[key];
    // Dedicated ambient contexts keep the Worker graph out of unrelated Node
    // infrastructure typechecks; this auto-discovered test gates both contexts.
    for (const config of ['infra/authority-recovery-fixture/tsconfig.json', 'infra/authority-recovery-fixture/tsconfig.host.json'])
      await promisify(execFile)(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', config], { env: childEnv, timeout: 30000, maxBuffer: 1024 * 1024 });
    await promisify(execFile)(resolve('node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--config', 'infra/authority-recovery-fixture/wrangler.jsonc', '--outdir', output], {
      env: { ...childEnv, PATH: dirname(process.execPath) + ':' + childEnv.PATH, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(directory, 'wrangler.log') }, timeout: 60000, maxBuffer: 3 * 1024 * 1024,
    });
    const files = await readdir(output), scripts = files.filter(name => name.endsWith('.js')); assert.equal(scripts.length, 1);
    const privateBytes = async (key: CryptoKey) => encodeBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', key)));
    const authorityPublic = fixture.trust.keys.find(x => x.id === 'authority-1')!.publicKeyBase64;
    const checkerPublic = fixture.trust.keys.find(x => x.id === 'checker-1')!.publicKeyBase64;
    const authoritySecret = await privateBytes(fixture.authority.privateKey), checkerSecret = await privateBytes(checker.privateKey);
    const options = () => convertV4MiniflareOptions({ name: 'owned-authority-recovery', modulesRoot: output,
      modules: [{ type: 'ESModule', path: join(output, scripts[0]!) }, ...files.filter(name => name.endsWith('.wasm')).map(name => ({ type: 'CompiledWasm' as const, path: join(output, name) }))],
      compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.ERROR),
      durableObjects: { SOURCES: { className: 'RecoverySource', useSQLite: true }, TARGETS: { className: 'RecoveryTarget', useSQLite: true } },
      r2Buckets: { SOURCE_OBJECTS: 'owned-local-recovery-source', TARGET_OBJECTS: 'owned-local-recovery-target' }, resourcePersistencePath: join(directory, 'persist'),
      bindings: { OWNED_RECOVERY_FIXTURE: 'true', OWNED_SOURCE_FENCED: String(sourceFenced), OWNED_PUBLIC_SIGNERS: JSON.stringify([
        { role: 'authority', keyId: 'authority-1', publicKeyBase64: authorityPublic }, { role: 'checker', keyId: 'checker-1', publicKeyBase64: checkerPublic }, { role: 'root', keyId: 'authority-1', publicKeyBase64: authorityPublic },
      ]), ROOT_KEY_ID: 'authority-1', AUTHORITY_KEY_ID: 'authority-1', ROOT_SIGNING_KEY: authoritySecret, AUTHORITY_SIGNING_KEY: authoritySecret, OWNED_CHECKER_KEY: checkerSecret,
        CHECKER_KEY_ID: 'checker-1', CHECKER_PUBLIC_KEY: checkerPublic, AUTH_TENANT_ID: fixture.input.state.scope.tenantId,
        BOOTSTRAP_SUBJECTS: '["human-1"]', EVALUATION_IMAGE_DIGEST: 'sha256:' + '1'.repeat(64), CHECKER_IMPLEMENTATION_DIGEST: 'sha256:' + '2'.repeat(64),
        CONDITIONAL_PUBLICATION_VERIFIED: 'true', PI_ENABLED: 'false', ARTIFACTS_GIT_HOST: '1'.repeat(32) + '.artifacts.cloudflare.net' },
      outboundService: async () => { deniedOutbound++; return new Response('Owned recovery forbids network', { status: 403 }); },
    });
    // Synthetic keys exist only in this owned local process. None are read from
    // environment, files, browser sessions, account configuration or providers.
    const runtimeOptions = options;
    runtime = new Miniflare(runtimeOptions()); await runtime.ready;
    async function call(side: 'source' | 'target', action: string, body: unknown = {}, expected = 200): Promise<any> {
      const response = await runtime!.dispatchFetch('http://owned-recovery.test/' + side + '/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
    }
    const jobs = await Promise.all(Array.from({ length: FULL_RELEASE_JOB_COUNT }, async (_, index) => ({ id: 'recovery-owned-job-' + index,
      inputDigest: await digest({ candidate: fixture.input.candidate.digest, owned: index }), required: true, evidenceClass: 'protected-behavioural' })));
    const planBase = { candidateId: fixture.input.candidate.id, candidateDigest: fixture.input.candidate.digest, jobs }, plan = { ...planBase, digest: await digest(planBase) };
    const enrollmentPredicate = JSON.parse(Buffer.from(fixture.bundle.enrollment.payload, 'base64').toString()).predicate;
    await call('source', 'seed', { scope: fixture.input.state.scope, candidate: fixture.input.candidate, plan, manifest: fixture.bundle.inputs.manifest,
      gitObjects: fixture.bundle.inputs.gitObjects, baselineSource: fixture.baselineSource, trust: fixture.trust, enrollmentPredicate, enrollment: fixture.bundle.enrollment });
    const caller = { principal: { id: 'human-1', tenantId: fixture.input.state.scope.tenantId, credentialClass: 'human' }, projectId: fixture.input.state.scope.projectId };
    const project = (state: any) => JSON.parse(state.project[0].payload);
    async function command(operation: string, body: unknown, id: string) {
      const request = { caller, command: { commandId: id, expectedRevision: project(await call('source', 'inspect')).revision, operation, body } };
      return { request, result: await call('source', 'command', request) };
    }
    const attempt = await command('create-attempt', { subject: 'human-1', maximumBudget: '100000', recipe: 'pi-json-proposal-v1', assignment: 'Owned recovery fixture; no execution',
      allowedPaths: ['cache.mjs'], pathPrefixes: ['cache.mjs'], operations: ['checkpoint-context', 'model-inference', 'read-source', 'start-execution', 'submit-output', 'write-attempt'], destinations: ['1'.repeat(32) + '.artifacts.cloudflare.net', 'model.internal'] }, 'fixed-create-attempt');
    const model = { scope: fixture.input.state.scope, attemptId: attempt.result.id, generation: '1', callId: '00000000-0000-4000-8000-000000000001', requestDigest: 'sha256:' + '3'.repeat(64), maximumCost: '100000' };
    assert.equal((await call('source', 'model-reservation', model)).state, 'DISPATCHED');
    // Owned setup retires fake provisioning; no real fork/runner/model exists.
    await call('source', 'settle-owned-effects');
    for (const job of jobs) {
      const observation = { outcome: 'PASS', ownedSyntheticJob: job.id }, base = { id: 'evidence-' + job.id, jobId: job.id, inputDigest: job.inputDigest,
        observationDigest: await digest(observation), candidateId: fixture.input.candidate.id, candidateDigest: fixture.input.candidate.digest,
        outcome: 'PASS', evidenceClass: 'protected-behavioural', authorized: true };
      const evidence = { ...base, digest: await digest(base) };
      await call('source', 'observation', { scope: fixture.input.state.scope, evidence, envelope: await signStatement(await statement('evidence', evidence), 'checker-1', checker.privateKey),
        observationBase64: encodeBase64(new TextEncoder().encode(canonicalize(observation))) });
    }
    const review = (await command('prepare-review', { candidateId: fixture.input.candidate.id, evaluationId: 'plan-1' }, 'fixed-review')).result;
    await command('approve-review', { reviewId: review.id, proposalDigest: review.proposalDigest }, 'fixed-synthetic-approval');
    const publication = await command('request-publication', { reviewId: review.id, proposalDigest: review.proposalDigest }, 'fixed-publication');
    let before = await call('source', 'inspect');
    for (let batch = 0; batch < 8 && before.dispatches.length === 0; batch++) before = await call('source', 'advance');
    assert.equal(before.dispatches.length, 1); const unknown = JSON.parse(before.publications[0].payload);
    assert.equal(unknown.dispatchMayHaveOccurred, true); assert.equal(unknown.reason, 'OLD_HEAD_DOES_NOT_PROVE_CANCELLATION');
    await call('source', 'fence'); sourceFenced = true;
    const captured = await call('source', 'capture'), originalRows = await call('source', 'rows'), originalKv = await call('source', 'kv');
    assert.equal((await call('target', 'restore', captured)).state, 'RESTORED_FENCED');
    assert.deepEqual(await call('target', 'rows'), originalRows);
    assert.deepEqual((await call('target', 'kv')).filter(([key]: [string]) => key !== RECOVERY_MARKER), originalKv);
    // Real workerd restart invokes the unchanged production constructor, which
    // adds only an original-identity reconciliation wake, not a replacement push.
    await runtime.dispose(); runtime = new Miniflare(runtimeOptions()); await runtime.ready;
    const restarted = await call('target', 'inspect');
    const wakeId = 'restart-reconcile-' + unknown.id, wakePayload = { publicationId: unknown.id };
    assert.equal(originalRows.outbox.some((row: any) => row.id === wakeId), false, 'the reconciliation wake did not exist before reconstruction');
    const wake = restarted.outbox.filter((row: any) => row.id === wakeId);
    assert.equal(wake.length, 1, 'constructor creates exactly one fixed-identity reconciliation wake');
    assert.deepEqual(Object.fromEntries(['id', 'kind', 'digest', 'payload', 'state'].map(key => [key, wake[0][key]])),
      { id: wakeId, kind: 'reconcile', digest: await digest(wakePayload), payload: canonicalize(wakePayload), state: 'PENDING' });
    assert.equal(typeof restarted.alarm, 'number', 'constructor arms a wakeup; inherited automatic delivery remains suppressed in this fixture');
    assert.equal(restarted.dispatches.length, 1); assert.equal(project(restarted).gate, 'OPEN', 'old stored row cannot disable the external maintenance fence');
    const denied = await call('target', 'command', { caller, command: { commandId: 'new-after-restore', expectedRevision: project(restarted).revision, operation: 'set-admission-gate', body: { gate: 'OPEN' } } }, 409);
    assert.equal(denied.error, 'MAINTENANCE_READ_ONLY');
    assert.deepEqual(await call('target', 'original-model', model), { admitted: false, state: 'ALREADY_DISPATCHED' });
    assert.deepEqual(await call('target', 'original-command', [caller, publication.request.command]), publication.result);
    await call('target', 'advance'); const reconciled = await call('target', 'inspect');
    const delivered = reconciled.outbox.filter((row: any) => row.id === wakeId);
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0], { ...wake[0], state: 'DELIVERED', attempts: wake[0].attempts + 1 }, 'manual production alarm delivers the same reconciliation row exactly once without replacing its identity or payload');
    assert.equal(delivered[0].state, 'DELIVERED');
    assert.equal(reconciled.dispatches.length, 1, 'UNKNOWN external effect must never get another conditionalPublish call');
    const retained = JSON.parse(reconciled.publications[0].payload);
    assert.equal(retained.id, unknown.id); assert.equal(retained.oldHead, unknown.oldHead); assert.equal(retained.newHead, unknown.newHead);
    assert.deepEqual(retained.dispatchAttemptIds, unknown.dispatchAttemptIds); assert.equal(retained.reason, 'OLD_HEAD_DOES_NOT_PROVE_CANCELLATION');
    for (const name of ['commands', 'approvals', 'reservations', 'model_calls', 'model_call_facts', 'grants', 'pins']) assert.deepEqual((await call('target', 'rows'))[name], originalRows[name], name);
    assert.equal(reconciled.fakeRunnerRequest, undefined); assert.equal(deniedOutbound, 0, 'every network route is denied; no provider is contacted');
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
