// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { checkPublicationEvidence, checkArtifactsBindingEvidence } from './configure-pilot.ts';
import { ARTIFACTS_PREFLIGHT_CHECKS, ARTIFACTS_PREFLIGHT_SOURCES } from '../scripts/provider-preflight-evidence.ts';
import { ARTIFACTS_BINDING_CHECKS, ARTIFACTS_BINDING_SOURCES } from '../scripts/artifacts-binding-evidence.ts';
import { canonicalize } from '../packages/protocol/src/index.ts';

const accountId = '1'.repeat(32), namespace = 'owned.config-check';
const hash = (bytes: Uint8Array | string) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
async function evidence(checks: readonly string[], sources: readonly string[]) {
  return {
    schemaVersion: 1, status: 'PASS', accountId, namespace, completedAt: new Date().toISOString(),
    checks: checks.map(name => ({ name, status: 'PASS', detail: name === 'remote-binds-fresh-resources' ? { remote: `https://${accountId}.artifacts.cloudflare.net/git/${namespace}/owned-repo.git` } : {} })),
    resources: { namespace, repo: 'owned-repo', namespaceCreation: 'ACKNOWLEDGED', repositoryCreation: 'ACKNOWLEDGED' },
    sourceDigests: Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(resolve(path)))]))),
  };
}
async function bindingEvidence() {
  const report = await evidence(ARTIFACTS_BINDING_CHECKS, ARTIFACTS_BINDING_SOURCES);
  const runId = '11111111-1111-4111-8111-111111111111', workerName = `confidence-artifacts-${runId.replaceAll('-', '').slice(0, 20)}`;
  const completedAt = Date.now() - 2000, expiresAt = completedAt + 5 * 60 * 1000;
  const sourceSetDigest = hash(canonicalize(report.sourceDigests)), configDigest = 'sha256:' + '3'.repeat(64);
  const bundleDigests = { 'worker.js': 'sha256:' + '4'.repeat(64), 'protocol.wasm': 'sha256:' + '5'.repeat(64) };
  const nativeIdentity = { runId, accountId, namespace, workerName, bucketName: workerName, sourceSetDigest, configDigest, bundleDigests,
    deployedModulesExact: true, deployedBindingsExact: true, observedAt: new Date(completedAt - 60 * 1000).toISOString() };
  return { ...report, completedAt: new Date(completedAt).toISOString(), runId, workerName, bucketName: workerName, expiresAt, sourceSetDigest, configDigest, bundleDigests, nativeIdentity };
}

test('publication requires complete named provider observations for this account and current source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-artifacts-gate-'));
  try {
    const path = join(directory, 'provider.json'), input = join(directory, 'input.json');
    const config = { enablePublication: true, publicationEvidence: 'provider.json', accountId };
    const complete = await evidence(ARTIFACTS_PREFLIGHT_CHECKS, ARTIFACTS_PREFLIGHT_SOURCES);
    await writeFile(path, JSON.stringify(complete));
    assert.equal(await checkPublicationEvidence(config, input), hash(await readFile(path)));
    const variants = [
      { report: { ...complete, status: 'SELF_TEST_PASS' }, reason: /GATE_NOT_PASSED/ },
      { report: { ...complete, checks: complete.checks.slice(0, 10) }, reason: /REQUIRED_CHECKS/ },
      { report: { ...complete, checks: [...complete.checks, complete.checks[0]] }, reason: /REQUIRED_CHECKS/ },
      { report: { ...complete, checks: complete.checks.map((check, index) => index ? check : { ...check, status: 'BLOCKED' }) }, reason: /GATE_NOT_PASSED/ },
      { report: { ...complete, accountId: '2'.repeat(32) }, reason: /ACCOUNT_MISMATCH/ },
      { report: { ...complete, completedAt: '' }, reason: /INCOMPLETE/ },
      { report: { ...complete, resources: { ...complete.resources, repositoryCreation: 'UNKNOWN' } }, reason: /RESOURCE_IDENTITY/ },
      { report: { ...complete, resources: { ...complete.resources, repo: 'another-repo' } }, reason: /ACCOUNT_MISMATCH/ },
      { report: { ...complete, sourceDigests: { ...complete.sourceDigests, 'workers/shared/errors.ts': 'sha256:' + '0'.repeat(64) } }, reason: /SOURCE_CHANGED/ },
    ];
    for (const { report, reason } of variants) {
      await writeFile(path, JSON.stringify(report));
      await assert.rejects(checkPublicationEvidence(config, input), reason);
    }
    assert.equal(await checkPublicationEvidence({ enablePublication: false }, input), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('publication separately requires current binding evidence from its configured namespace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-artifacts-binding-gate-'));
  try {
    const path = join(directory, 'binding.json'), input = join(directory, 'input.json');
    const config = { enablePublication: true, artifactsBindingEvidence: 'binding.json', artifactsNamespace: namespace, accountId };
    const complete = await bindingEvidence();
    await writeFile(path, JSON.stringify(complete));
    assert.equal(await checkArtifactsBindingEvidence(config, input), hash(await readFile(path)));
    await assert.rejects(checkArtifactsBindingEvidence({ ...config, artifactsBindingEvidence: undefined }, input), /LIVE_ARTIFACTS_BINDING_EVIDENCE_REQUIRED/);
    await assert.rejects(checkArtifactsBindingEvidence({ ...config, artifactsNamespace: 'other-namespace' }, input), /NAMESPACE_MISMATCH/);
    for (const changed of [
      { ...complete, checks: complete.checks.slice(0, -1) },
      { ...complete, status: 'SELF_TEST_PASS' },
      { ...complete, accountId: '2'.repeat(32) },
      { ...complete, sourceDigests: { ...complete.sourceDigests, 'packages/protocol/wasm/confidence_protocol_bg.wasm': 'sha256:' + '0'.repeat(64) } },
    ]) {
      await writeFile(path, JSON.stringify(changed));
      await assert.rejects(checkArtifactsBindingEvidence(config, input), /LIVE_ARTIFACTS_BINDING_/);
    }
    assert.equal(await checkArtifactsBindingEvidence({ enablePublication: false }, input), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('binding evidence admits only native deployment proof for the same prepared run and bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-artifacts-native-gate-'));
  try {
    const path = join(directory, 'binding.json'), input = join(directory, 'input.json');
    const config = { enablePublication: true, artifactsBindingEvidence: 'binding.json', artifactsNamespace: namespace, accountId };
    const complete = await bindingEvidence(), proof = complete.nativeIdentity;
    const variants = [
      { ...complete, nativeIdentity: undefined },
      ...['runId', 'accountId', 'namespace', 'sourceSetDigest', 'configDigest', 'workerName', 'bucketName'].map(key => ({ ...complete, nativeIdentity: { ...proof, [key]: 'different-run-input' } })),
      { ...complete, nativeIdentity: { ...proof, deployedModulesExact: false } },
      { ...complete, nativeIdentity: { ...proof, deployedBindingsExact: 1 } },
      { ...complete, nativeIdentity: { ...proof, bundleDigests: { ...proof.bundleDigests, 'worker.js': 'sha256:' + '0'.repeat(64) } } },
      { ...complete, nativeIdentity: { ...proof, bundleDigests: undefined } },
      { ...complete, sourceSetDigest: 'sha256:' + '0'.repeat(64), nativeIdentity: { ...proof, sourceSetDigest: 'sha256:' + '0'.repeat(64) } },
      { ...complete, configDigest: 'unbound', nativeIdentity: { ...proof, configDigest: 'unbound' } },
      { ...complete, runId: 'invalid', nativeIdentity: { ...proof, runId: 'invalid' } },
      { ...complete, workerName: 'unrelated-worker', nativeIdentity: { ...proof, workerName: 'unrelated-worker' } },
      { ...complete, bucketName: 'unrelated-bucket', nativeIdentity: { ...proof, bucketName: 'unrelated-bucket' } },
      { ...complete, bundleDigests: {}, nativeIdentity: { ...proof, bundleDigests: {} } },
      { ...complete, bundleDigests: { 'worker.js': 'sha256:' + '4'.repeat(64) }, nativeIdentity: { ...proof, bundleDigests: { 'worker.js': 'sha256:' + '4'.repeat(64) } } },
      { ...complete, bundleDigests: { 'worker.js': 'invalid', 'protocol.wasm': 'invalid' }, nativeIdentity: { ...proof, bundleDigests: { 'worker.js': 'invalid', 'protocol.wasm': 'invalid' } } },
    ];
    for (const changed of variants) {
      await writeFile(path, JSON.stringify(changed));
      await assert.rejects(checkArtifactsBindingEvidence(config, input), /LIVE_ARTIFACTS_BINDING_(RUN|BUNDLE|NATIVE)_IDENTITY/);
    }
    // JSON member order is not part of the frozen module identity.
    await writeFile(path, JSON.stringify({ ...complete, nativeIdentity: { ...proof, bundleDigests: Object.fromEntries(Object.entries(proof.bundleDigests).reverse()) } }));
    assert.equal(await checkArtifactsBindingEvidence(config, input), hash(await readFile(path)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native observations must fall inside the prepared run window and precede report completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-artifacts-native-time-'));
  try {
    const path = join(directory, 'binding.json'), input = join(directory, 'input.json');
    const config = { enablePublication: true, artifactsBindingEvidence: 'binding.json', artifactsNamespace: namespace, accountId };
    const complete = await bindingEvidence();
    const observed = (time: string | number) => ({ ...complete, nativeIdentity: { ...complete.nativeIdentity, observedAt: typeof time === 'string' ? time : new Date(time).toISOString() } });
    for (const changed of [
      observed('invalid'), observed(complete.expiresAt - 20 * 60 * 1000 - 1), observed(complete.expiresAt + 1),
      observed(Date.parse(complete.completedAt) + 1),
      { ...complete, expiresAt: undefined }, { ...complete, expiresAt: String(complete.expiresAt) },
      { ...complete, completedAt: new Date(Date.now() + 60 * 1000).toISOString() },
    ]) {
      await writeFile(path, JSON.stringify(changed));
      await assert.rejects(checkArtifactsBindingEvidence(config, input), /LIVE_ARTIFACTS_BINDING_NATIVE_OBSERVATION_TIME/);
    }
    await writeFile(path, JSON.stringify(observed(complete.expiresAt - 20 * 60 * 1000)));
    assert.equal(await checkArtifactsBindingEvidence(config, input), hash(await readFile(path)));
    // A completed observation stays admissible after control access expires.
    const expiredAt = Date.parse(complete.completedAt) - 1;
    await writeFile(path, JSON.stringify({ ...observed(expiredAt), expiresAt: expiredAt }));
    assert.equal(await checkArtifactsBindingEvidence(config, input), hash(await readFile(path)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('generated Artifacts configuration gives namespace control only to the private authority', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-artifacts-config-'));
  try {
    const config = JSON.parse(await readFile(resolve('infra/pilot.example.json'), 'utf8'));
    Object.assign(config, { accountId, artifactsNamespace: namespace });
    config.projectionDatabase.id = '11111111-1111-4111-8111-111111111111';
    Object.assign(config.app, { origin: 'https://owned-app.invalid', issuer: 'https://owned-issuer.invalid', audience: 'owned-app', jwksUrl: 'https://owned-issuer.invalid/jwks', bootstrapSubjects: ['https://owned-issuer.invalid#owned-human'] });
    const input = join(directory, 'input.json'), output = join(directory, 'config');
    await writeFile(input, JSON.stringify(config));
    await promisify(execFile)(process.execPath, ['--import', 'tsx', resolve('infra/configure-pilot.ts'), 'configure', input, output], { maxBuffer: 65536 });
    for (const role of ['authority', 'runner', 'evaluator', 'projector', 'app']) {
      const generated = JSON.parse(await readFile(join(output, role + '.json'), 'utf8'));
      assert.deepEqual(generated.artifacts ?? [], role === 'authority' ? [{ binding: 'ARTIFACTS', namespace, remote: false }] : []);
      assert.equal(generated.workers_dev, false);
      assert.equal(generated.secrets.required.includes('CLOUDFLARE_API_TOKEN'), false);
    }
    const release = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'));
    assert.equal(release.enablePublication, false);
    assert.equal(release.publicationEvidenceDigest, null);
    assert.equal(release.artifactsBindingEvidenceDigest, null);
    const types = join(directory, 'authority-env.d.ts');
    await promisify(execFile)(process.execPath, [resolve('node_modules/wrangler/bin/wrangler.js'), 'types', types, '--config', join(output, 'authority.json'), '--include-runtime=false'], {
      maxBuffer: 65536, env: { ...process.env, CI: 'true', WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false' },
    });
    assert.match(await readFile(types, 'utf8'), /ARTIFACTS:\s*Artifacts;/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
