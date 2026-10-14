import { performance } from 'node:perf_hooks';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { GitStore } from '../services/git.ts';

// Run with: node --import tsx scripts/benchmark-source.ts --compare
// The reference path is the prior per-file algorithm, reproduced here so one
// invocation measures it and the batched path with identical 1 KiB sources.
async function referenceCreate(store: GitStore, files: Record<string, Buffer>): Promise<string> {
  const index = join(store.directory, `index-${randomUUID()}`), env = { GIT_INDEX_FILE: index };
  try {
    await store.git(['read-tree', '--empty'], { env });
    for (const path of Object.keys(files).sort()) {
      const oid = (await store.git(['hash-object', '-w', '--stdin'], { input: files[path] })).toString().trim();
      await store.git(['update-index', '--add', '--cacheinfo', '100644', oid, path], { env });
    }
    const tree = (await store.git(['write-tree'], { env })).toString().trim();
    const commit = (await store.git(['commit-tree', tree], { input: 'Benchmark source import\n', env: {
      GIT_AUTHOR_NAME: 'Confidence materializer', GIT_AUTHOR_EMAIL: 'materializer@example.invalid', GIT_AUTHOR_DATE: '2026-10-04T12:00:00Z',
      GIT_COMMITTER_NAME: 'Confidence materializer', GIT_COMMITTER_EMAIL: 'materializer@example.invalid', GIT_COMMITTER_DATE: '2026-10-04T12:00:00Z',
    } })).toString().trim();
    await store.git(['update-ref', `refs/candidates/${commit}`, commit]);
    return commit;
  } finally { await rm(index, { force: true }); }
}

async function referenceEntries(store: GitStore, commit: string): Promise<{ path: string; oid: string }[]> {
  const tree = await store.git(['ls-tree', '-r', '-z', commit]);
  const entries = [];
  for (const line of tree.toString().split('\0').filter(Boolean)) {
    const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(line);
    if (!match) throw new Error('Unexpected benchmark tree entry');
    await store.git(['cat-file', 'blob', match[1]]); // previous manifest pass
    entries.push({ path: match[2], oid: match[1] });
  }
  return entries;
}

async function referencePrepare(store: GitStore, commit: string, workspace: string): Promise<Record<string, Buffer>> {
  const hydration = await referenceEntries(store, commit);
  await mkdir(workspace, { recursive: true });
  for (const entry of hydration) {
    const path = join(workspace, entry.path); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await store.git(['cat-file', 'blob', entry.oid])); await chmod(path, 0o644);
  }
  const source = await referenceEntries(store, commit);
  return Object.fromEntries(await Promise.all(source.map(async entry => [entry.path, await store.git(['cat-file', 'blob', entry.oid])])));
}

for (const count of [4, 100, 1000]) {
  const root = await mkdtemp(join(tmpdir(), `confidence-source-${count}-`));
  try {
    const files = Object.fromEntries(Array.from({ length: count }, (_, i) => {
      const path = `dir${String(Math.floor(i / 100)).padStart(2, '0')}/file${String(i).padStart(4, '0')}.txt`;
      return [path, Buffer.from(`${i}\n`.padEnd(1024, String(i % 10)))] as const;
    }));
    const measure = async (label: 'reference' | 'batched') => {
      const repo = join(root, `${label}.git`); execFileSync('git', ['init', '--bare', '--quiet', repo]);
      const store = new GitStore(repo, join(root, `${label}-remote.git`)), originalGit = store.git.bind(store);
      let processes = 0;
      store.git = async (...args: Parameters<GitStore['git']>) => { processes++; return originalGit(...args); };
      const start = performance.now();
      const commit = label === 'reference' ? await referenceCreate(store, files) : await store.createCommit(files, undefined, 'Benchmark source import');
      const createMs = performance.now() - start, createProcesses = processes;
      const prepareStart = performance.now(), workspace = join(root, `${label}-workspace`);
      const source = label === 'reference' ? await referencePrepare(store, commit, workspace) : (await store.hydrateWithFiles(commit, workspace)).files;
      const prepareMs = performance.now() - prepareStart, prepareProcesses = processes - createProcesses;
      if (Object.keys(source).length !== count) throw new Error('Incorrect source count');
      for (const [path, expected] of Object.entries(files)) {
        if (!source[path]?.equals(expected) || !(await readFile(join(workspace, path))).equals(expected)) throw new Error(`Source mismatch: ${path}`);
      }
      return { commit, createMs: +createMs.toFixed(1), createProcesses, prepareMs: +prepareMs.toFixed(1), prepareProcesses, totalMs: +(createMs + prepareMs).toFixed(1), totalProcesses: processes };
    };
    const reference = process.argv.includes('--compare') ? await measure('reference') : undefined;
    const batched = await measure('batched');
    if (reference && reference.commit !== batched.commit) throw new Error('Import changed exact Git commit');
    console.log(JSON.stringify({ count, reference, batched, exactCommit: reference ? reference.commit === batched.commit : undefined }));
  } finally { await rm(root, { recursive: true, force: true }); }
}
