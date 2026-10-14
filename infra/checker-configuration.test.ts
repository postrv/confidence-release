// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkerInputPaths } from '../scripts/checker-inputs.ts';
import { runtimeInputDigests } from './release-inputs.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);

test('checker CLI, configuration and deployment preserve the complete configured source identity', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'confidence-checker-config-')));
  try {
    const workspace = join(directory, 'workspace');
    const inputs = new Set([...Object.keys(await runtimeInputDigests(root)), ...checkerInputPaths]);
    for (const path of inputs) {
      await mkdir(dirname(join(workspace, path)), { recursive: true });
      await copyFile(join(root, path), join(workspace, path));
    }
    await symlink(join(root, 'node_modules'), join(workspace, 'node_modules'), 'dir');
    // These are local-only production commands. Do not give their subprocesses
    // provider credentials, a home directory, or a private secret directory.
    const cli = async (path: string, ...args: string[]) => run(process.execPath, ['--import', 'tsx', join(workspace, path), ...args], {
      cwd: workspace, timeout: 30000, maxBuffer: 65536,
      env: { PATH: process.env.PATH },
    });
    const checkerDigest = async () => {
      const report = JSON.parse((await cli('scripts/checker-digest.ts')).stdout);
      assert.equal(report.schemaVersion, 1);
      assert.match(report.implementationDigest, /^sha256:[a-f0-9]{64}$/);
      assert.deepEqual(report.entries.map((entry: { path: string }) => entry.path), checkerInputPaths);
      return report.implementationDigest as string;
    };
    const config = JSON.parse(await readFile(join(root, 'infra/pilot.example.json'), 'utf8'));
    Object.assign(config, {
      accountId: '1'.repeat(32), maintenance: true, enablePi: false, enablePublication: false,
      publicationEvidence: null, artifactsBindingEvidence: null,
    });
    config.projectionDatabase.id = '11111111-1111-4111-8111-111111111111';
    Object.assign(config.app, {
      origin: 'https://owned-checker.invalid', issuer: 'https://owned-issuer.invalid', audience: 'owned-checker',
      jwksUrl: 'https://owned-issuer.invalid/jwks', bootstrapSubjects: ['https://owned-issuer.invalid#owned-human'],
    });
    const inputPath = join(directory, 'input.json');
    const configure = async (output: string, digest: string) => {
      await writeFile(inputPath, JSON.stringify({ ...config, checkerImplementationDigest: digest }));
      return cli('infra/configure-pilot.ts', 'configure', inputPath, output);
    };
    const assertConfigured = async (output: string, digest: string) => {
      const authority = JSON.parse(await readFile(join(output, 'authority.json'), 'utf8'));
      const evaluator = JSON.parse(await readFile(join(output, 'evaluator.json'), 'utf8'));
      const release = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'));
      assert.equal(authority.vars.CHECKER_IMPLEMENTATION_DIGEST, digest);
      assert.equal(evaluator.vars.CHECKER_IMPLEMENTATION_DIGEST, digest);
      assert.equal(authority.vars.MAINTENANCE_MODE, 'true');
      assert.equal(authority.vars.CONDITIONAL_PUBLICATION_VERIFIED, 'false');
      assert.equal(release.maintenance, true);
      assert.equal(release.enablePublication, false);
      assert.equal(release.enablePi, false);
      assert.deepEqual(release.sourceDigests, await runtimeInputDigests(workspace));
      for (const path of checkerInputPaths) {
        const expected = 'sha256:' + createHash('sha256').update(await readFile(join(workspace, path))).digest('hex');
        assert.equal(release.sourceDigests[path], expected, `Checker source must remain pinned at deployment: ${path}`);
      }
    };
    const originalDigest = await checkerDigest(), originalOutput = join(directory, 'original');
    await configure(originalOutput, originalDigest);
    await assertConfigured(originalOutput, originalDigest);

    for (const [index, source] of ['workers/authority/kernel.ts', 'workers/shared/deadline.ts', 'workers/shared/age.ts', 'workers/evaluator/recovery.ts', 'scripts/checker-inputs.ts'].entries()) {
      const path = join(workspace, source), originalBytes = await readFile(path);
      try {
        await writeFile(path, Buffer.concat([originalBytes, Buffer.from('\n// Changed checker provenance requires a fresh digest.\n')]));
        const staleOutput = join(directory, `stale-${index}`);
        await assert.rejects(configure(staleOutput, originalDigest), error =>
          (error as Error & { stderr?: string }).stderr?.includes('CONFIG_CHECKER_SOURCE_CHANGED') === true);
        await assert.rejects(readdir(staleOutput), { code: 'ENOENT' });
        // A newly reported digest must work, proving the stale rejection did
        // not come from a broken fixture or an unrelated configuration error.
        const updatedDigest = await checkerDigest(), updatedOutput = join(directory, `updated-${index}`);
        assert.notEqual(updatedDigest, originalDigest, `Missing checker input: ${source}`);
        await configure(updatedOutput, updatedDigest);
        await assertConfigured(updatedOutput, updatedDigest);
      } finally { await writeFile(path, originalBytes); }
    }

    const wasmPath = join(workspace, 'packages/protocol/wasm/confidence_protocol_bg.wasm');
    const originalWasm = await readFile(wasmPath);
    for (const source of ['crates/protocol/src/lib.rs', 'rust-toolchain.toml']) {
      const path = join(workspace, source), originalBytes = await readFile(path);
      try {
        const comment = source.endsWith('.toml') ? '#' : '//';
        await writeFile(path, Buffer.concat([originalBytes, Buffer.from(`\n${comment} Changed configured source without rebuilding WASM.\n`)]));
        assert.deepEqual(await readFile(wasmPath), originalWasm);
        assert.notEqual(await checkerDigest(), originalDigest, `Checker digest must change: ${source}`);
        const before = new Set(await readdir(originalOutput));
        await assert.rejects(cli('infra/deploy-pilot.ts', originalOutput, '--dry-run'), error =>
          (error as Error & { stderr?: string }).stderr?.includes('RELEASE_SOURCE_CHANGED_RECONFIGURE_REQUIRED') === true);
        const reports = (await readdir(originalOutput)).filter(path => !before.has(path) && /^deployment-[0-9]+\.json$/.test(path));
        assert.equal(reports.length, 1);
        const report = JSON.parse(await readFile(join(originalOutput, reports[0]), 'utf8'));
        assert.equal(report.status, 'FAILED');
        assert.equal(report.reason, 'RELEASE_SOURCE_CHANGED_RECONFIGURE_REQUIRED');
        assert.deepEqual(report.stages, []);
      } finally { await writeFile(path, originalBytes); }
    }
    await assertConfigured(originalOutput, originalDigest);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
