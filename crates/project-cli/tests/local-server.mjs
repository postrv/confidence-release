// SPDX-License-Identifier: Apache-2.0
// Runs the real Rust binary against the actual loopback application adapter.
// Only generated fixtures are used unless --project-source explicitly includes this checkout's committed HEAD.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, symlink, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { startServer } from '../../../services/server.ts';
const run = promisify(execFile), root = fileURLToPath(new URL('../../../', import.meta.url));
const binary = join(root, 'target/debug/confidence');
const directory = await mkdtemp(join(tmpdir(), 'confidence-cli-journey-'));
const fixture = join(directory, 'repository'); await mkdir(fixture);
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Confidence CLI test', GIT_AUTHOR_EMAIL: 'cli@example.invalid', GIT_COMMITTER_NAME: 'Confidence CLI test', GIT_COMMITTER_EMAIL: 'cli@example.invalid' };
const git = async (...args) => (await run('git', args, { cwd: fixture, env: gitEnv })).stdout.trim();
const cli = async (...args) => {
  const result = await run(binary, args, { cwd: root, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
};
let app, proxy;
const checks = [];
try {
  await git('init', '-b', 'main');
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'echo fixture' } }));
  await writeFile(join(fixture, 'test.mjs'), "import test from 'node:test'; test('fixture', () => {});\n");
  await git('add', '.'); await git('commit', '-m', 'first');
  const parent = await git('rev-parse', 'HEAD');
  await writeFile(join(fixture, 'binary.dat'), new Uint8Array([0, 255, 10, 128]));
  await writeFile(join(fixture, 'Unicode-λ.txt'), 'committed\n');
  await writeFile(join(fixture, 'run.sh'), '#!/bin/sh\nexit 0\n'); await chmod(join(fixture, 'run.sh'), 0o755);
  await symlink('/not-read/external', join(fixture, 'link'));
  await writeFile(join(fixture, 'asset'), `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 10000000\n`);
  await git('add', '.'); await git('update-index', '--add', '--cacheinfo', `160000,${parent},module`); await git('commit', '-m', 'second');
  const head = await git('rev-parse', 'HEAD');
  await writeFile(join(fixture, 'Unicode-λ.txt'), 'dirty local source must stay local\n');
  app = await startServer({ port: 0, dataDir: join(directory, 'app-data') });
  const target = `http://127.0.0.1:${app.port}`;
  const inspected = await cli('repo', 'inspect', fixture, '--json');
  assert.equal(inspected.head, head); assert.deepEqual(inspected.parents, [parent]); assert.equal(inspected.symlinks, 1); assert.equal(inspected.submodules, 1);
  assert.equal(inspected.worktree.changedPaths, 1); checks.push('exact HEAD and local exclusions');
  const journal = join(directory, 'import.json');
  const imported = await cli('project', 'import', fixture, '--target', target, '--name', 'Generated local import', '--journal', journal, '--local', '--confirm');
  assert.equal(imported.source.head, head); assert.equal(imported.source.archiveDigest, inspected.archiveDigest); assert.equal(imported.checks.length, 2);
  assert.equal(imported.capabilities.repositoryChecks, false); assert.equal(imported.capabilities.publication, false); checks.push('create and import real Rust CLI, exact archive readback');
  const packed = join(directory, 'archive.json');
  await cli('repo', 'pack', fixture, '--output', packed);
  const created = await cli('project', 'create', '--target', target, '--name', 'Packed source', '--journal', join(directory, 'create.json'), '--local', '--confirm');
  const savedChecks = [{ ...imported.checks[0], name: 'Saved disabled check', enabled: false, required: false, source: 'manual' }];
  await app.projects.command(created.projectId, { commandId: 'save-before-cli-import', expectedRevision: created.revision, expectedIncarnation: created.projectIncarnation, operation: 'checks', body: { checks: savedChecks } });
  const fromArchive = await cli('project', 'import-archive', packed, '--target', target, '--project', created.projectId, '--journal', join(directory, 'packed-import.json'), '--local', '--confirm');
  assert.deepEqual(fromArchive.checks, savedChecks, 'real CLI import preserves the project configuration');
  assert.equal(fromArchive.source.archiveDigest, inspected.archiveDigest); checks.push('pack and import-archive');
  const requestBefore = await readFile(journal);
  const resumed = await cli('project', 'resume', journal, '--local', '--confirm');
  assert.equal(resumed.projectId, imported.projectId); assert.equal(resumed.revision, imported.revision);
  assert.deepEqual(await readFile(journal), requestBefore); checks.push('identical import replay preserves journal and revision');
  const directoryState = await cli('project', 'list', '--target', target, '--local');
  assert.equal(directoryState.projects.filter(project => project.source.status === 'IMPORTED').length, 2); checks.push('list includes both independently imported projects');
  // Drop only the first successful create response after forwarding to the real
  // server. The first process must fail, and resume must not create a duplicate.
  let drop = true;
  proxy = http.createServer((request, response) => {
    const forwarded = http.request(`${target}${request.url}`, { method: request.method, headers: { ...request.headers, host: `127.0.0.1:${app.port}`, origin: target } }, upstream => {
      if (drop && request.method === 'POST' && request.url === '/api/projects') {
        drop = false; upstream.resume(); upstream.on('end', () => response.destroy());
      } else { response.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(response); }
    });
    forwarded.on('error', () => response.destroy()); request.pipe(forwarded);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const uncertainJournal = join(directory, 'uncertain-create.json');
  let failed = false;
  try { await cli('project', 'create', '--target', `http://127.0.0.1:${proxy.address().port}`, '--name', 'Lost response', '--journal', uncertainJournal, '--local', '--confirm'); }
  catch (error) { failed = true; assert.match(error.stderr, /server may have applied|Response read failed/); }
  assert.equal(failed, true);
  const recovered = await cli('project', 'resume', uncertainJournal, '--local', '--confirm');
  assert.equal(recovered.name, 'Lost response');
  const after = await cli('project', 'list', '--target', target, '--local');
  assert.equal(after.projects.filter(project => project.name === 'Lost response').length, 1); checks.push('lost successful response recovers exact create without duplicate project');
  if (process.argv.includes('--project-source')) {
    const sourceInspection = await cli('repo', 'inspect', root, '--json');
    assert.ok(sourceInspection.archiveBytes > 8 * 1024 * 1024, 'current project exercises a request beyond the old protocol JSON limit');
    const large = await cli('project', 'import', root, '--target', target, '--name', 'Committed project source validation', '--journal', join(directory, 'source-import.json'), '--local', '--confirm');
    assert.equal(large.source.head, sourceInspection.head); assert.equal(large.source.archiveDigest, sourceInspection.archiveDigest);
    checks.push(`actual checkout committed HEAD: ${sourceInspection.fileCount} files, ${sourceInspection.archiveBytes} archive bytes`);
  }
  console.log(JSON.stringify({ passed: checks.length, checks, providerCalls: 0, githubRuns: 0 }, null, 2));
} finally {
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  if (app) await app.close();
  await rm(directory, { recursive: true, force: true });
}
