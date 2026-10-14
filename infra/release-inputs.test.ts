// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeInputDigests } from './release-inputs.ts';
import { ARTIFACTS_BINDING_SOURCES } from '../scripts/artifacts-binding-evidence.ts';
import { ARTIFACTS_PREFLIGHT_SOURCES } from '../scripts/provider-preflight-evidence.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const hash = (bytes: string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

test('release identity binds every local input copied into the production runner image', async () => {
  const inputs = await runtimeInputDigests(root);
  const dockerfile = await readFile(join(root, 'workers/runner/Dockerfile'), 'utf8');
  const copyLines = dockerfile.split('\n').filter(line => /^COPY /i.test(line) && !/^COPY --from=/i.test(line));
  assert(copyLines.length > 0);
  for (const line of copyLines) {
    // The current recipe uses explicit file paths. Reject a new COPY syntax
    // until its inputs are deliberately included in this release boundary.
    const sources = line.slice(5).trim().split(/\s+/).slice(0, -1);
    assert(sources.length > 0 && sources.every(path => /^[a-zA-Z0-9_.\/-]+$/.test(path)), `Unreviewed COPY input syntax: ${line}`);
    for (const path of sources) assert.equal(inputs[path], hash(await readFile(join(root, path), 'utf8')), `Runner image input must be pinned: ${path}`);
  }
});

test('release identity includes every built asset, including extensionless controls and hidden files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-release-assets-'));
  try {
    const original = await runtimeInputDigests(root);
    for (const path of Object.keys(original)) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await copyFile(join(root, path), join(directory, path));
    }
    assert.deepEqual(await runtimeInputDigests(directory), original);
    const assets = ['logo.png', 'font.woff2', 'manifest.json', '_headers', '_redirects', '.assetsignore', '.well-known/config'];
    for (const asset of assets) {
      const path = join(directory, 'apps/web/dist', asset);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `initial ${asset}`);
    }
    const retained = await runtimeInputDigests(directory);
    for (const asset of assets) assert.equal(retained[`apps/web/dist/${asset}`], hash(`initial ${asset}`));
    await writeFile(join(directory, 'apps/web/dist/_headers'), 'updated response headers');
    const changed = await runtimeInputDigests(directory);
    assert.notEqual(changed['apps/web/dist/_headers'], retained['apps/web/dist/_headers']);
    await rm(join(directory, 'apps/web/dist/logo.png'));
    assert.equal((await runtimeInputDigests(directory))['apps/web/dist/logo.png'], undefined);
    await symlink(join(directory, 'package.json'), join(directory, 'apps/web/dist/linked.json'));
    await assert.rejects(runtimeInputDigests(directory), /BUILT_APPLICATION_REGULAR_FILES_REQUIRED/);
    await rm(join(directory, 'apps/web/dist/linked.json'));
    await rm(join(directory, 'apps/web/dist/index.html'));
    await assert.rejects(runtimeInputDigests(directory), /BUILT_APPLICATION_REQUIRED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('initial deployment validates the last bootstrap configuration before secrets, packaging or remote work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-release-bootstrap-'));
  const run = promisify(execFile);
  try {
    const input = JSON.parse(await readFile(join(root, 'infra/pilot.example.json'), 'utf8'));
    input.accountId = '1'.repeat(32);
    input.projectionDatabase.id = '11111111-1111-4111-8111-111111111111';
    Object.assign(input.app, { origin: 'https://owned-release.invalid', issuer: 'https://issuer.invalid', audience: 'owned-release', jwksUrl: 'https://issuer.invalid/jwks', bootstrapSubjects: ['https://issuer.invalid#owned-human'] });
    const inputPath = join(directory, 'input.json'), output = join(directory, 'config');
    await writeFile(inputPath, JSON.stringify(input));
    await run(process.execPath, ['--import', 'tsx', join(root, 'infra/configure-pilot.ts'), 'configure', inputPath, output], { cwd: root, timeout: 30000 });
    const path = join(output, 'evaluator-bootstrap.json');
    await writeFile(path, await readFile(path, 'utf8') + '\n');
    // No secret directory is supplied. Even a regression cannot pass the
    // private-input preflight and dispatch a package or provider operation.
    await assert.rejects(run(process.execPath, ['--import', 'tsx', join(root, 'infra/deploy-pilot.ts'), output, '--deploy', '--initial'], { cwd: root, timeout: 30000 }), error => (error as Error & { stderr?: string }).stderr?.includes('BOOTSTRAP_CONFIGURATION_CHANGED') === true);
    const reports = (await readdir(output)).filter(path => /^deployment-[0-9]+\.json$/.test(path));
    assert.equal(reports.length, 1);
    const report = JSON.parse(await readFile(join(output, reports[0]), 'utf8'));
    assert.equal(report.status, 'FAILED');
    assert.deepEqual(report.stages, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('evidence and runner tool source changes after configuration invalidate deployment before packaging', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'confidence-release-evidence-')));
  const run = promisify(execFile);
  try {
    const workspace = join(directory, 'workspace'), output = join(directory, 'config');
    const original = await runtimeInputDigests(root);
    const evidenceSources = ['infra/live-artifacts-operator.ts', 'scripts/checker-inputs.ts', 'scripts/checker-digest.ts', 'packages/project-model/src/validation.ts',
      'fixtures/authoring-benchmark/biome.json',
      'infra/deployment-restoration-state.ts', 'infra/reconcile-restoration.ts',
      'services/narsil-context.mjs', 'services/interlinked-preview.mjs', 'scripts/install-narsil.mjs', 'scripts/install-interlinked.mjs',
      'scripts/interlinked-build-patch.mjs', 'integrations/narsil.json', 'integrations/interlinked.json', 'integrations/interlinked-biome.patch.json'];
    for (const path of [...ARTIFACTS_BINDING_SOURCES, ...ARTIFACTS_PREFLIGHT_SOURCES, ...evidenceSources]) assert.ok(original[path], `Evidence source must be pinned: ${path}`);
    for (const path of Object.keys(original)) {
      await mkdir(dirname(join(workspace, path)), { recursive: true });
      await copyFile(join(root, path), join(workspace, path));
    }
    await symlink(join(root, 'node_modules'), join(workspace, 'node_modules'), 'dir');
    const input = JSON.parse(await readFile(join(root, 'infra/pilot.example.json'), 'utf8'));
    input.accountId = '1'.repeat(32);
    input.projectionDatabase.id = '11111111-1111-4111-8111-111111111111';
    Object.assign(input.app, { origin: 'https://owned-release.invalid', issuer: 'https://issuer.invalid', audience: 'owned-release', jwksUrl: 'https://issuer.invalid/jwks', bootstrapSubjects: ['https://issuer.invalid#owned-human'] });
    const inputPath = join(directory, 'input.json');
    await writeFile(inputPath, JSON.stringify(input));
    await run(process.execPath, ['--import', 'tsx', join(workspace, 'infra/configure-pilot.ts'), 'configure', inputPath, output], { cwd: workspace, timeout: 30000 });
    const release = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'));
    assert.deepEqual(release.sourceDigests, await runtimeInputDigests(workspace));
    for (const source of evidenceSources) {
      const path = join(workspace, source), originalBytes = await readFile(path);
      await writeFile(path, Buffer.concat([originalBytes, Buffer.from(source.endsWith('.json') ? '\n' : '\n// Changed evidence identity requires reconfiguration.\n')]));
      assert.notEqual((await runtimeInputDigests(workspace))[source], release.sourceDigests[source]);
      // The isolated copy leaves the live evidence sources untouched. Dry run
      // additionally prevents this regression from dispatching a remote stage.
      await assert.rejects(run(process.execPath, ['--import', 'tsx', join(workspace, 'infra/deploy-pilot.ts'), output, '--dry-run'], { cwd: workspace, timeout: 30000 }), error => (error as Error & { stderr?: string }).stderr?.includes('RELEASE_SOURCE_CHANGED_RECONFIGURE_REQUIRED') === true);
      await writeFile(path, originalBytes);
    }
    const reports = (await readdir(output)).filter(path => /^deployment-[0-9]+\.json$/.test(path));
    assert.equal(reports.length, evidenceSources.length);
    for (const path of reports) {
      const report = JSON.parse(await readFile(join(output, path), 'utf8'));
      assert.equal(report.status, 'FAILED');
      assert.deepEqual(report.stages, []);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
