// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditConfidenceRepository, CONFIDENCE_REPOSITORY_PROFILE } from './confidence-repository-profile.ts';

const git = (repository: string, ...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const repository = await mkdtemp(join(tmpdir(), 'confidence-profile-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  git(repository, 'init', '--initial-branch=main');
  await writeFile(join(repository, 'app.ts'), 'export const value = 1;\n');
  await writeFile(join(repository, 'data.bin'), Buffer.from([0, 255, 1]));
  await writeFile(join(repository, 'script.sh'), '#!/bin/sh\nexit 0\n'); await chmod(join(repository, 'script.sh'), 0o755);
  await writeFile(join(repository, '.env.fixture'), 'local-only test value\n');
  await writeFile(join(repository, 'scanner.txt'), ['WEFT', 'SECRET', 'CANARY', 'synthetic_preflight_fixture'].join('_'));
  await writeFile(join(repository, 'pointer.txt'), 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 7\n');
  git(repository, 'add', '--all');
  git(repository, '-c', 'user.name=Owned Profile Test', '-c', 'user.email=profile@localhost', 'commit', '-m', 'test: complete fixture');
  return { repository, revision: git(repository, 'rev-parse', 'HEAD') };
}

test('declared repository profile does not claim execution or approve fixture exceptions', () => {
  assert.equal(CONFIDENCE_REPOSITORY_PROFILE.qualification, 'unqualified');
  assert.deepEqual(CONFIDENCE_REPOSITORY_PROFILE.capture.exclusions, []);
  assert.equal(CONFIDENCE_REPOSITORY_PROFILE.fixtureExceptions, 'owner-review-required');
  assert.ok(CONFIDENCE_REPOSITORY_PROFILE.unqualified.includes('protected-execution'));
  assert.ok(CONFIDENCE_REPOSITORY_PROFILE.recipe.commands.some(command => command.argv.join(' ') === 'npm run test:local'));
});

test('preflight retains every committed entry and leaves HEAD, staging and dirty work untouched', async t => {
  const input = await fixture(t);
  await writeFile(join(input.repository, 'app.ts'), 'staged work\n'); git(input.repository, 'add', 'app.ts');
  await writeFile(join(input.repository, 'app.ts'), 'later dirty work\n');
  await writeFile(join(input.repository, 'notes.local'), 'unrelated dirty file\n');
  const index = await readFile(join(input.repository, '.git/index'));
  const report = await auditConfidenceRepository(input);
  assert.equal(report.inventory.files, 6);
  assert.equal(report.inventory.entries.find(entry => entry.path === 'script.sh')?.mode, '100755');
  assert.ok(report.inventory.entries.some(entry => entry.path === '.env.fixture'));
  assert.deepEqual(report.inventory.binaryPaths, ['data.bin']);
  assert.deepEqual(report.inventory.lfsPaths, ['pointer.txt']);
  assert.ok(report.blockers.some(item => item.code === 'WEFT_VALIDATOR_UNAVAILABLE'));
  assert.ok(report.blockers.some(item => item.code === 'WEFT_BINARY_CONTENT' && item.path === 'data.bin'));
  assert.ok(report.blockers.some(item => item.code === 'LFS_PAYLOAD_NOT_CAPTURED'));
  assert.equal(report.qualified, false);
  assert.equal(git(input.repository, 'rev-parse', 'HEAD'), input.revision);
  assert.deepEqual(await readFile(join(input.repository, '.git/index')), index);
  assert.equal(await readFile(join(input.repository, 'app.ts'), 'utf8'), 'later dirty work\n');
  assert.equal(await readFile(join(input.repository, 'notes.local'), 'utf8'), 'unrelated dirty file\n');
  assert.ok(!JSON.stringify(report).includes('synthetic_preflight_fixture'));
});

test('unsupported modes and case collisions are reported without dropping tracked paths', async t => {
  const input = await fixture(t);
  await symlink('app.ts', join(input.repository, 'link'));
  git(input.repository, 'add', 'link');
  const oid = git(input.repository, 'rev-parse', 'HEAD:app.ts');
  git(input.repository, 'update-index', '--add', '--cacheinfo', `100644,${oid},APP.ts`);
  git(input.repository, 'update-index', '--add', '--cacheinfo', `160000,${input.revision},submodule`);
  git(input.repository, '-c', 'user.name=Owned Profile Test', '-c', 'user.email=profile@localhost', 'commit', '-m', 'test: unsupported source');
  const report = await auditConfidenceRepository({ repository: input.repository, revision: git(input.repository, 'rev-parse', 'HEAD') });
  assert.equal(report.inventory.files, 9);
  assert.ok(report.blockers.some(item => item.code === 'UNSUPPORTED_MODE' && item.path === 'link'));
  assert.ok(report.blockers.some(item => item.code === 'SUBMODULE_CONTENT_NOT_CAPTURED' && item.path === 'submodule'));
  assert.ok(report.blockers.some(item => item.code === 'CASE_PATH_COLLISION'));
  assert.equal(report.sourceManifest, null);
});

test('preflight requires an exact immutable commit identity', async t => {
  const input = await fixture(t);
  await assert.rejects(auditConfidenceRepository({ ...input, revision: 'HEAD' }), /EXACT_COMMIT_REQUIRED/);
  await assert.rejects(auditConfidenceRepository({ ...input, revision: 'f'.repeat(40) }), /GIT_READ_FAILED/);
});
