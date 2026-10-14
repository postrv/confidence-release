// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomic, bundleIdentity, main, ownedJournal, preRunReadiness, sourceIdentity, validEndpoint, verifiedNativeIdentity } from '../live-artifacts-check.ts';
import type { BindingJournal } from './types.ts';

test('binding controls require exact owned names, paths, account and source identity', () => {
  const runId = '00000000-0000-4000-8000-000000000001', id = runId.replaceAll('-', '').slice(0, 20);
  const home = fileURLToPath(new URL(`./.runs/${runId}/`, import.meta.url));
  const sourceDigests = {}, sourceSetDigest = 'sha256:' + createHash('sha256').update('{}').digest('hex');
  const journal: BindingJournal = { schemaVersion: 1, runId, accountId: 'a'.repeat(32), namespace: 'confidence', workerName: `confidence-artifacts-${id}`, bucketName: `confidence-artifacts-${id}`,
    canonicalName: `confidence-binding-${id}`, attemptId: `binding-${id}`, attemptName: `attempt-binding-${id}`, expiresAt: 1791158400000, sourceSetDigest, sourceDigests, sourceRevision: null, sourceDirty: true,
    configPath: resolve(home, 'wrangler.json'), configDigest: 'sha256:' + 'b'.repeat(64), secretsPath: resolve(home, 'worker.secrets.json'), secretsDigest: 'sha256:' + 'c'.repeat(64), run: 'NOT_DISPATCHED', cleanup: 'NOT_DISPATCHED' };
  assert.equal(ownedJournal(journal), true);
  for (const change of [{ workerName: 'retained-production' }, { bucketName: 'retained-storage' }, { attemptName: 'retained-attempt' }, { accountId: 'invalid' }, { namespace: '../another' }, { secretsPath: '/tmp/private.json' }, { sourceSetDigest: 'sha256:' + 'd'.repeat(64) }, { run: 'RETRY' }]) assert.equal(ownedJournal({ ...journal, ...change } as BindingJournal), false);
  assert.equal(validEndpoint(`https://${journal.workerName}.owned.workers.dev`, journal.workerName), true);
  for (const endpoint of [`http://${journal.workerName}.owned.workers.dev`, `https://${journal.workerName}.owned.workers.dev/other`, `https://${journal.workerName}.owned.workers.dev?token=wrong`, `https://${journal.workerName}.owned.workers.dev.evil.invalid`, `https://different.owned.workers.dev`, `https://private@${journal.workerName}.owned.workers.dev`]) assert.equal(validEndpoint(endpoint, journal.workerName), false);
  journal.bundleDigests = { 'worker.js': 'sha256:' + '1'.repeat(64), 'kernel.wasm': 'sha256:' + '2'.repeat(64) };
  const proof = { runId, accountId: journal.accountId, namespace: journal.namespace, sourceSetDigest, configDigest: journal.configDigest, workerName: journal.workerName, bucketName: journal.bucketName, bundleDigests: journal.bundleDigests, deployedModulesExact: true, deployedBindingsExact: true, observedAt: new Date(journal.expiresAt - 1000).toISOString() };
  assert.equal(verifiedNativeIdentity(proof, journal, journal.expiresAt), true);
  for (const change of [{ accountId: 'b'.repeat(32) }, { workerName: 'different' }, { deployedModulesExact: false }, { deployedBindingsExact: false }, { bundleDigests: {} }, { sourceSetDigest: 'sha256:' + '3'.repeat(64) }, { observedAt: new Date(journal.expiresAt - 1200001).toISOString() }, { observedAt: new Date(journal.expiresAt + 1).toISOString() }]) assert.equal(verifiedNativeIdentity({ ...proof, ...change }, journal, journal.expiresAt), false);
  assert.equal(verifiedNativeIdentity({ ...proof, observedAt: new Date(journal.expiresAt + 1).toISOString() }, journal, journal.expiresAt + 1000), false);
});
test('binding journal replacement persists only private complete JSON', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'confidence-binding-control-'));
  try { const path = resolve(directory, 'journal.json'); await atomic(path, { phase: 'MAY_HAVE_DISPATCHED' }); await atomic(path, { phase: 'UNKNOWN' }); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { phase: 'UNKNOWN' }); assert.equal((await stat(path)).mode & 0o077, 0); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
test('read-only pre-run status is ready without claiming binding checks or dispatching a run', async () => {
  const runId = randomUUID(), id = runId.replaceAll('-', '').slice(0, 20);
  const home = fileURLToPath(new URL(`./.runs/${runId}/`, import.meta.url));
  const configPath = resolve(home, 'wrangler.json'), secretsPath = resolve(home, 'worker.secrets.json'), journalPath = resolve(home, 'journal.json');
  const bundlePath = resolve(home, 'bundle'), out = resolve(home, 'report.json');
  const digest = (bytes: string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const previousFetch = globalThis.fetch;
  try {
    await mkdir(bundlePath, { recursive: true });
    await writeFile(resolve(bundlePath, 'worker.js'), 'export default {}');
    await writeFile(resolve(bundlePath, 'kernel.wasm'), 'wasm fixture');
    await atomic(configPath, {}); await atomic(secretsPath, { CONTROL_TOKEN: 'a'.repeat(64) });
    const source = await sourceIdentity();
    const workerName = `confidence-artifacts-${id}`, expiresAt = Date.now() + 10 * 60 * 1000;
    const journal: BindingJournal = { schemaVersion: 1, runId, accountId: 'b'.repeat(32), namespace: 'confidence', workerName, bucketName: workerName,
      canonicalName: `confidence-binding-${id}`, attemptId: `binding-${id}`, attemptName: `attempt-binding-${id}`, expiresAt,
      sourceSetDigest: source.digest, sourceDigests: source.digests, sourceRevision: null, sourceDirty: true,
      configPath, configDigest: digest(await readFile(configPath, 'utf8')), secretsPath, secretsDigest: digest(await readFile(secretsPath, 'utf8')),
      bundleDigests: await bundleIdentity(bundlePath), run: 'NOT_DISPATCHED', cleanup: 'NOT_DISPATCHED' };
    const proof = { runId, accountId: journal.accountId, namespace: journal.namespace, sourceSetDigest: journal.sourceSetDigest,
      configDigest: journal.configDigest, workerName, bucketName: workerName, bundleDigests: journal.bundleDigests,
      deployedModulesExact: true, deployedBindingsExact: true, observedAt: new Date().toISOString() };
    await atomic(journalPath, journal); await atomic(resolve(home, 'native-operator.json'), { identity: proof });
    const observation = { status: 'NOT_STARTED', runId, sourceSetDigest: source.digest };
    const endpoint = `https://${workerName}.owned.workers.dev/`;
    let calls = 0;
    globalThis.fetch = async (input, init) => { calls++; assert.equal(String(input), `${endpoint}status`); assert.equal(init?.method, 'GET'); return Response.json(observation); };
    const report = await main(['--reconcile', '--journal', journalPath, '--endpoint', endpoint, '--out', out]) as Record<string, any>;
    assert.equal(calls, 1); assert.equal(report.status, 'PRE_RUN_READY'); assert.equal(report.providerGatePassed, false);
    assert.deepEqual(report.controlStatus, observation); assert.equal(report.snapshot, undefined);
    assert.deepEqual(report.checks.map((check: { name: string }) => check.name), ['pre-run-control-and-native-identity']);
    assert.equal((JSON.parse(await readFile(journalPath, 'utf8')) as BindingJournal).run, 'NOT_DISPATCHED');
    assert.equal(preRunReadiness(observation, { ...journal, run: 'MAY_HAVE_DISPATCHED' }, proof).status, 'RECONCILIATION_REQUIRED');
    assert.equal(preRunReadiness(observation, journal, { ...proof, deployedBindingsExact: false }).status, 'FAIL');
    assert.throws(() => preRunReadiness({ ...observation, sourceSetDigest: digest('different') }, journal, proof), /PRE_RUN_RESPONSE_ASSOCIATION/);
    assert.throws(() => preRunReadiness({ ...observation, checks: [] }, journal, proof), /PRE_RUN_RESPONSE_SCHEMA/);
  } finally { globalThis.fetch = previousFetch; await rm(home, { recursive: true, force: true }); }
});
