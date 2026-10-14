import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitStore } from '../../services/git.ts';
import { hashBytes } from '../../services/crypto.ts';

async function withStore(run: (store: GitStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'confidence-git-batch-'));
  const repository = join(root, 'source.git');
  execFileSync('git', ['init', '--bare', '--quiet', repository]);
  try { await run(new GitStore(repository, join(root, 'remote.git')), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('batch source preparation keeps exact binary bytes, paths, modes, and constant Git process count', async () => withStore(async (store, root) => {
  const files = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
    `nested directory/file ${String(index).padStart(3, '0')}.bin`,
    Buffer.from(index === 0 ? [0, 10, 255, 0, 13] : [index, 10, index, 0]),
  ]));
  files['duplicate.bin'] = files['nested directory/file 000.bin'];
  const originalGit = store.git.bind(store); let commands = 0;
  store.git = async (...args: Parameters<GitStore['git']>) => { commands++; return originalGit(...args); };
  const commit = await store.createCommit(files, undefined, 'Batch source test', { 'nested directory/file 000.bin': '100755' });
  assert.equal(commands, 6, 'Import and index update should use a fixed number of Git processes');
  const workspace = join(root, 'workspace');
  const { manifest, files: hydrated } = await store.hydrateWithFiles(commit, workspace);
  assert.equal(commands, 8, 'Tree and blobs should each be read in one Git process');
  assert.equal(manifest.entries.length, Object.keys(files).length);
  for (const [path, expected] of Object.entries(files)) {
    const entry = manifest.entries.find(item => item.path === path)!;
    assert.ok(entry); assert.equal(entry.size, expected.length); assert.equal(entry.digest, hashBytes(expected));
    assert.deepEqual(hydrated[path], expected);
    assert.deepEqual(await readFile(join(workspace, path)), expected);
  }
  assert.equal(manifest.entries.find(item => item.path === 'nested directory/file 000.bin')!.mode, '100755');
  assert.ok(((await stat(join(workspace, 'nested directory/file 000.bin'))).mode & 0o111) !== 0);
  assert.equal(manifest.entries.find(item => item.path === 'duplicate.bin')!.gitOid, manifest.entries.find(item => item.path === 'nested directory/file 000.bin')!.gitOid);
}));

test('batch reader rejects object type and byte tampering', async () => withStore(async store => {
  const commit = await store.createCommit({ 'binary.bin': Buffer.from([0, 10, 255, 0]) }, undefined, 'Tamper check');
  const oid = (await store.manifest(commit)).entries[0].gitOid;
  await assert.rejects(store.batchObjects([{ oid, type: 'tree' }]), /identity mismatch/);
  const originalGit = store.git.bind(store);
  store.git = async (...args: Parameters<GitStore['git']>) => {
    const output = await originalGit(...args);
    if (args[0][0] === 'cat-file' && args[0][1] === '--batch') {
      const changed = Buffer.from(output); changed[changed.indexOf(10) + 1] ^= 1; return changed;
    }
    return output;
  };
  await assert.rejects(store.files(commit), /digest mismatch/);
}));

test('batched import produces the same Git commit as the previous per-file import', async () => withStore(async (store, root) => {
  const files = { 'empty.txt': Buffer.alloc(0), 'nested/binary.bin': Buffer.from([0, 10, 255, 13]), 'space name.txt': Buffer.from('hello\n') };
  const modes = { 'nested/binary.bin': '100755' };
  const message = 'Exact commit comparison';
  const imported = await store.createCommit(files, undefined, message, modes);
  const env = { GIT_INDEX_FILE: join(root, 'previous-index') };
  await store.git(['read-tree', '--empty'], { env });
  for (const path of Object.keys(files).sort()) {
    const oid = (await store.git(['hash-object', '-w', '--stdin'], { input: files[path as keyof typeof files] })).toString().trim();
    await store.git(['update-index', '--add', '--cacheinfo', modes[path as keyof typeof modes] || '100644', oid, path], { env });
  }
  const tree = (await store.git(['write-tree'], { env })).toString().trim();
  const previous = (await store.git(['commit-tree', tree], { input: message + '\n', env: {
    GIT_AUTHOR_NAME: 'Confidence materializer', GIT_AUTHOR_EMAIL: 'materializer@example.invalid', GIT_AUTHOR_DATE: '2026-10-04T12:00:00Z',
    GIT_COMMITTER_NAME: 'Confidence materializer', GIT_COMMITTER_EMAIL: 'materializer@example.invalid', GIT_COMMITTER_DATE: '2026-10-04T12:00:00Z',
  } })).toString().trim();
  assert.equal(imported, previous);
}));

test('source size and case-fold limits reject before batch blob reads', async () => withStore(async store => {
  const tooLarge = await store.createCommit({ 'large.bin': Buffer.alloc(1024 * 1024 + 1) }, undefined, 'Oversized source');
  const originalGit = store.git.bind(store); let blobReads = 0;
  store.git = async (...args: Parameters<GitStore['git']>) => { if (args[0][0] === 'cat-file' && args[0][1] === '--batch') blobReads++; return originalGit(...args); };
  await assert.rejects(store.manifest(tooLarge), /1 MiB file limit/);
  const collision = await store.createCommit({ 'Dir/a.txt': Buffer.from('a'), 'dir/b.txt': Buffer.from('b') }, undefined, 'Case-fold collision');
  await assert.rejects(store.manifest(collision), /Case-fold path collision/);
  assert.equal(blobReads, 0);
}));
