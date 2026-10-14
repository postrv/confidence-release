// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeKernel } from '../../packages/protocol/src/node.ts';
import { PROFILE_SOURCE_REVISION, qualifyRepositoryProfile } from './repository-profile-check.ts';

before(initializeKernel);
test('repository source probe roundtrips exact regular bytes and modes without changing live Git state', { timeout: 60_000 }, async t => {
  const repository = await mkdtemp(join(tmpdir(), 'confidence-source-profile-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', timeout: 10_000 }).trim();
  git('init', '--initial-branch=main');
  await writeFile(join(repository, 'app.ts'), 'export const value = 1;\n');
  await writeFile(join(repository, 'executable.sh'), '#!/bin/sh\nexit 0\n'); await chmod(join(repository, 'executable.sh'), 0o755);
  for (let index = 0; index < 5; index++) {
    const bytes = Buffer.alloc(1024 * 1024, index); bytes[0] = 0; bytes[1] = 255;
    await writeFile(join(repository, `data-${index}.bin`), bytes);
  }
  git('add', '--all'); git('-c', 'user.name=Owned source probe', '-c', 'user.email=probe@example.invalid', 'commit', '-m', 'owned fixture');
  const revision = git('rev-parse', 'HEAD');
  const report = await qualifyRepositoryProfile(repository, revision);
  assert.equal(report.passed, true); assert.equal(report.selectedCommit, revision);
  assert.equal(report.files, 7); assert.ok(report.sourceBytes > 4 * 1024 * 1024);
  assert.equal(report.binaryPaths.length, 5); assert.equal(report.executableFiles, 1);
  assert.equal(report.defaultProfileRejected, true); assert.equal(report.localHeadIndexAndDirtyPreserved, true);
  assert.ok(report.unqualified.includes('protected execution')); assert.ok(report.unqualified.includes('publication'));
  assert.match(PROFILE_SOURCE_REVISION, /^[a-f0-9]{40}$/);
  await assert.rejects(qualifyRepositoryProfile(repository, 'f'.repeat(40)));
});
