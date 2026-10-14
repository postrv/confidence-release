// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { auditConfidenceRepository, REVIEWED_CONFIDENCE_REVISION } from '../confidence-repository-profile.ts';

const weftSource = process.env.WEFT_SOURCE;
assert.ok(weftSource, 'WEFT_SOURCE_REQUIRED: this separate qualification lane requires the pinned Weft repository');

test('real pinned scanner reports private paths and test canaries without emitting their contents', async t => {
  const repository = await mkdtemp(join(tmpdir(), 'confidence-scanner-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  await writeFile(join(repository, '.env.fixture'), 'owned test file');
  await writeFile(join(repository, 'scanner.txt'), ['WEFT', 'SECRET', 'CANARY', 'synthetic_preflight_fixture'].join('_'));
  git('add', '--all'); git('-c', 'user.name=Owned Profile Test', '-c', 'user.email=profile@localhost', 'commit', '-m', 'test: scanner fixture');
  const report = await auditConfidenceRepository({ repository, revision: git('rev-parse', 'HEAD'), weftSource });
  assert.equal(report.weft.scanner, 'checked');
  assert.ok(report.blockers.some(item => item.code === 'WEFT_SECRET_BLOCKED' && item.path === 'scanner.txt'));
  assert.ok(report.blockers.some(item => item.code === 'WEFT_PRIVATE_PATH' && item.path === '.env.fixture'));
  assert.ok(!JSON.stringify(report).includes('synthetic_preflight_fixture'));
});

test('exact reviewed Confidence tree retains all paths and reports the real baseline blockers', async () => {
  const report = await auditConfidenceRepository({ repository: resolve('.'), revision: REVIEWED_CONFIDENCE_REVISION, weftSource });
  assert.equal(report.inventory.files, 661); assert.equal(report.inventory.bytes, 8782732);
  assert.equal(report.closure.objects, 727); assert.equal(report.closure.decodedBytes, 8815644); assert.equal(report.closure.jsonBytes, 11814074);
  assert.equal(report.sourceManifest?.digest, 'sha256:ef6849faa0b61b6d1fcf06b624da340568739130753d91ec2cfddd2281f141c2');
  assert.deepEqual(report.inventory.binaryPaths, ['fixtures/demo/source.gitbundle']);
  assert.deepEqual(report.blockers.filter(item => item.code === 'WEFT_SECRET_BLOCKED').map(item => item.path), [
    'crates/project-cli/tests/journal.rs', 'infra/model-configuration.test.ts', 'infra/runner-runtime-check.ts', 'scripts/weft-access.test.mjs',
    'tests/integration/authoring-tools-benchmark.test.ts', 'tests/integration/narsil-platform.test.ts', 'tests/integration/pi-adapter.test.ts', 'tests/integration/pi-context.test.ts',
  ]);
  for (const code of ['WEFT_SNAPSHOT_BYTES', 'CONFIDENCE_SOURCE_BYTES', 'PROJECT_IMPORT_OBJECT_BYTES', 'PROTOCOL_JSON_BYTES', 'PORTABLE_RECEIPT_CAPACITY', 'WEFT_PROXY_BODY_BYTES', 'WEFT_PROXY_RESPONSE_BYTES', 'TYPESCRIPT_PROTECTED_PROFILE_UNREGISTERED', 'WEFT_EXECUTION_PROFILE_UNSUPPORTED', 'PROTECTED_EXECUTION_UNQUALIFIED'])
    assert.ok(report.blockers.some(item => item.code === code), code);
});
