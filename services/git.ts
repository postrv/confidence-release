import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile, chmod, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { digest, hashBytes } from './crypto.ts';
import type { Manifest, SourceEntry } from './types.ts';
const run = promisify(execFile);
const gitEnv = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
export class GitStore {
  constructor(public directory: string, public canonicalRemote: string) {}
  async git(args: string[], options: { input?: string | Buffer; env?: Record<string, string>; cwd?: string; maxOutputBytes?: number } = {}): Promise<Buffer> {
    const command = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args], { cwd: options.cwd || this.directory, env: { ...gitEnv, ...options.env }, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
    if (options.input !== undefined) command.stdin!.end(options.input);
    return new Promise((res, rej) => {
      const chunks: Buffer[] = []; let stdoutBytes = 0, stderr = '', exceeded = false;
      command.stdout!.on('data', (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes > (options.maxOutputBytes ?? 32 * 1024 * 1024)) { exceeded = true; command.kill(); } else chunks.push(chunk); });
      command.stderr!.on('data', (chunk: Buffer) => { if (stderr.length < 2000) stderr += chunk.toString().slice(0, 2000 - stderr.length); });
      command.on('error', rej);
      command.on('close', code => exceeded ? rej(new Error(`git ${args[0]} output limit exceeded`)) : code === 0 ? res(Buffer.concat(chunks, stdoutBytes)) : rej(new Error(`git ${args[0]} failed (${code}): ${stderr}`)));
    });
  }
  async initialize(fixture: string): Promise<string> {
    await mkdir(this.directory, { recursive: true }); await mkdir(this.canonicalRemote, { recursive: true });
    await run('git', ['init', '--bare', this.directory], { env: gitEnv });
    await run('git', ['init', '--bare', this.canonicalRemote], { env: gitEnv });
    const files: Record<string, Buffer> = {};
    for (const file of (await readdir(fixture)).sort()) files[file] = await readFile(join(fixture, file));
    const commit = await this.createCommit(files, undefined, 'Owned collaboration fixture baseline');
    await this.git(['update-ref', 'refs/heads/accepted', commit]);
    await this.git(['push', this.canonicalRemote, `${commit}:refs/heads/main`]);
    return commit;
  }
  async createCommit(files: Record<string, Buffer>, parent: string | undefined, message: string, modes: Record<string, string> = {}): Promise<string> {
    const index = join(this.directory, `index-${randomUUID()}`); const env = { GIT_INDEX_FILE: index };
    try {
      const paths = Object.keys(files).sort();
      const importChunks: Buffer[] = []; const imported = new Set<string>();
      const indexRows: string[] = [];
      for (const path of paths) {
        validatePath(path); const mode = modes[path] || '100644'; if (!['100644', '100755'].includes(mode)) throw new Error('Unsupported mode');
        const bytes = files[path];
        const oid = gitObjectOid('blob', bytes);
        if (!imported.has(oid)) {
          importChunks.push(Buffer.from(`blob\ndata ${bytes.length}\n`), bytes, Buffer.from('\n'));
          imported.add(oid);
        }
        indexRows.push(`${mode} ${oid}\t${path}\0`);
      }
      if (importChunks.length) await this.git(['fast-import', '--quiet'], { input: Buffer.concat(importChunks) });
      await this.git(['read-tree', '--empty'], { env });
      if (indexRows.length) await this.git(['update-index', '-z', '--index-info'], { env, input: indexRows.join('') });
      const tree = (await this.git(['write-tree'], { env })).toString().trim();
      const commit = (await this.git(['commit-tree', tree, ...(parent ? ['-p', parent] : [])], { input: message + '\n', env: { GIT_AUTHOR_NAME: 'Confidence materializer', GIT_AUTHOR_EMAIL: 'materializer@example.invalid', GIT_AUTHOR_DATE: '2026-10-04T12:00:00Z', GIT_COMMITTER_NAME: 'Confidence materializer', GIT_COMMITTER_EMAIL: 'materializer@example.invalid', GIT_COMMITTER_DATE: '2026-10-04T12:00:00Z' } })).toString().trim();
      await this.git(['update-ref', `refs/candidates/${commit}`, commit]); return commit;
    } finally { await rm(index, { force: true }); }
  }
  async manifest(commit: string): Promise<Manifest> {
    return (await this.sourceSnapshot(commit)).manifest;
  }
  private async sourceSnapshot(commit: string): Promise<{ manifest: Manifest; files: Record<string, Buffer> }> {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Exact SHA-1 Git commit required');
    const tree = await this.git(['ls-tree', '-r', '-l', '-z', commit]); const entries: SourceEntry[] = [];
    const folds = new Map<string, string>(); let total = 0, pathBytes = 0;
    for (const line of tree.toString().split('\0').filter(Boolean)) {
      const match = /^([0-9]{6}) blob ([a-f0-9]{40})\s+([0-9]+)\t(.+)$/.exec(line);
      if (!match || !['100644', '100755'].includes(match[1])) throw new Error('Unsupported tree entry: regular files only');
      const [, mode, gitOid, sizeText, path] = match; validatePath(path);
      const size = Number(sizeText); if (!Number.isSafeInteger(size) || size > 1024 * 1024) throw new Error('1 MiB file limit');
      total += size; pathBytes += path.length;
      if (entries.length >= 2048 || total > 4 * 1024 * 1024 || pathBytes > 64 * 1024) throw new Error('Source profile limit');
      const components = path.split('/');
      for (let n = 1; n <= components.length; n++) {
        const prefix = components.slice(0, n).join('/'), folded = prefix.toLowerCase();
        if (folds.has(folded) && folds.get(folded) !== prefix) throw new Error('Case-fold path collision'); folds.set(folded, prefix);
      }
      entries.push({ path, mode: mode as SourceEntry['mode'], size, digest: '', gitOid });
    }
    const objects = await this.batchObjects([...new Set(entries.map(entry => entry.gitOid))].map(oid => ({ oid, type: 'blob' as const })), 5 * 1024 * 1024);
    const files: Record<string, Buffer> = {};
    for (const entry of entries) {
      const bytes = objects.get(entry.gitOid)!;
      if (bytes.length !== entry.size) throw new Error('Git blob size changed during source read');
      entry.digest = hashBytes(bytes); files[entry.path] = bytes;
    }
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    for (let n = 1; n < entries.length; n++) if (entries[n].path.startsWith(entries[n - 1].path + '/')) throw new Error('File/directory collision');
    return { manifest: { schemaVersion: 1, profile: 'ascii-regular-v1', entries }, files };
  }
  async files(commit: string): Promise<Record<string, Buffer>> {
    return (await this.sourceSnapshot(commit)).files;
  }
  async hydrate(commit: string, workspace: string): Promise<Manifest> {
    return (await this.hydrateWithFiles(commit, workspace)).manifest;
  }
  async hydrateWithFiles(commit: string, workspace: string): Promise<{ manifest: Manifest; files: Record<string, Buffer> }> {
    const snapshot = await this.sourceSnapshot(commit); const { manifest, files } = snapshot;
    await mkdir(workspace, { recursive: true }); const made = new Set([resolve(workspace)]);
    for (const entry of manifest.entries) {
      const file = resolve(workspace, entry.path); if (!file.startsWith(resolve(workspace) + '/')) throw new Error('Escape');
      const parent = dirname(file); if (!made.has(parent)) { await mkdir(parent, { recursive: true }); made.add(parent); }
      await writeFile(file, files[entry.path], { mode: entry.mode === '100755' ? 0o755 : 0o644 });
      await chmod(file, entry.mode === '100755' ? 0o755 : 0o644);
    } return snapshot;
  }
  async batchObjects(requests: { oid: string; type: 'blob' | 'tree' | 'commit' }[], maxBytes = 8 * 1024 * 1024, cwd?: string): Promise<Map<string, Buffer>> {
    const unique = new Map<string, 'blob' | 'tree' | 'commit'>();
    for (const { oid, type } of requests) {
      if (!/^[a-f0-9]{40}$/.test(oid) || !['blob', 'tree', 'commit'].includes(type) || unique.has(oid) && unique.get(oid) !== type) throw new Error('Invalid Git object request');
      unique.set(oid, type);
    }
    if (!unique.size) return new Map();
    const output = await this.git(['cat-file', '--batch'], { cwd, input: [...unique.keys()].join('\n') + '\n', maxOutputBytes: maxBytes + unique.size * 64 });
    const objects = new Map<string, Buffer>(); let cursor = 0, total = 0;
    for (const [oid, expectedType] of unique) {
      const end = output.indexOf(10, cursor); if (end < 0) throw new Error('Truncated Git batch header');
      const header = output.toString('ascii', cursor, end);
      const match = /^([a-f0-9]{40}) (blob|tree|commit) ([0-9]+)$/.exec(header);
      if (!match || match[1] !== oid || match[2] !== expectedType) throw new Error('Git batch object identity mismatch');
      const size = Number(match[3]); if (!Number.isSafeInteger(size) || total + size > maxBytes) throw new Error('Git batch object limit');
      const start = end + 1, after = start + size;
      if (after >= output.length || output[after] !== 10) throw new Error('Truncated Git batch object');
      const bytes = output.subarray(start, after);
      if (gitObjectOid(expectedType, bytes) !== oid) throw new Error('Git batch object digest mismatch');
      objects.set(oid, bytes); cursor = after + 1; total += size;
    }
    if (cursor !== output.length) throw new Error('Trailing Git batch data');
    return objects;
  }
  async bundle(commit: string, destination: string): Promise<{ bytes: Buffer; digest: string }> {
    await this.git(['bundle', 'create', destination, `refs/candidates/${commit}`]);
    const verifyDirectory = destination + '-verify.git'; await run('git', ['init', '--bare', verifyDirectory], { env: gitEnv });
    try {
      await this.git(['bundle', 'verify', destination], { cwd: verifyDirectory });
      await this.git(['fetch', destination, `refs/candidates/${commit}:refs/heads/roundtrip`], { cwd: verifyDirectory });
      const raw = await this.git(['cat-file', 'commit', commit]);
      const returned = await this.git(['cat-file', 'commit', commit], { cwd: verifyDirectory });
      if (!raw.equals(returned)) throw new Error('Git bundle exact-object mismatch');
      const sourceManifest = await this.manifest(commit);
      const returnedObjects = await this.batchObjects(sourceManifest.entries.map(entry => ({ oid: entry.gitOid, type: 'blob' })), 4 * 1024 * 1024, verifyDirectory);
      for (const entry of sourceManifest.entries) {
        const returnedBytes = returnedObjects.get(entry.gitOid)!;
        if (hashBytes(returnedBytes) !== entry.digest) throw new Error('Git bundle content mismatch');
      }
      const bytes = await readFile(destination); return { bytes, digest: hashBytes(bytes) };
    } finally { await rm(verifyDirectory, { recursive: true, force: true }); }
  }
  async remoteHead(): Promise<string> { return (await this.git(['ls-remote', this.canonicalRemote, 'refs/heads/main'])).toString().trim().split(/\s+/)[0]; }
  async publish(oldHead: string, newHead: string): Promise<void> {
    await this.git(['push', `--force-with-lease=refs/heads/main:${oldHead}`, this.canonicalRemote, `${newHead}:refs/heads/main`]);
  }
  async verifyRemote(newHead: string): Promise<void> {
    const expected = await this.git(['cat-file', 'commit', newHead]); const actual = await this.git(['cat-file', 'commit', newHead], { cwd: this.canonicalRemote });
    if (!actual.equals(expected)) throw new Error('Remote raw commit mismatch');
    const manifest = await this.manifest(newHead);
    const remote = await this.batchObjects(manifest.entries.map(entry => ({ oid: entry.gitOid, type: 'blob' })), 4 * 1024 * 1024, this.canonicalRemote);
    for (const entry of manifest.entries) if (hashBytes(remote.get(entry.gitOid)!) !== entry.digest) throw new Error('Remote source mismatch');
  }
}
function gitObjectOid(type: 'blob' | 'tree' | 'commit', bytes: Buffer): string {
  return createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
}
export function validatePath(path: string): void {
  if (!path || path.length > 240 || path.startsWith('/') || /[^\x20-\x7e]|[\\<>:"|?*]/.test(path)) throw new Error('Unsupported source path');
  for (const component of path.split('/')) if (!component || component.length > 80 || ['.', '..'].includes(component) || component.toLowerCase() === '.git' || /[ .]$/.test(component) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component)) throw new Error('Unsupported source component');
}
export function changedPaths(base: Manifest, next: Manifest): string[] {
  const a = new Map(base.entries.map(e => [e.path, e])), b = new Map(next.entries.map(e => [e.path, e]));
  return [...new Set([...a.keys(), ...b.keys()])].sort().filter(path => digest(a.get(path) || null) !== digest(b.get(path) || null));
}
