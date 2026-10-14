// SPDX-License-Identifier: Apache-2.0
// Separate source-capacity qualification; no project enrollment, execution, or publication.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import nativeFs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { canonicalize, digest, getKernel } from '../../packages/protocol/src/index.ts';
import { initializeKernel } from '../../packages/protocol/src/node.ts';
import { ArtifactsRepository, snapshotFromClonedRepository } from '../../workers/authority/artifacts.ts';
import { ObjectStore } from '../../workers/shared/objects.ts';

export const PROFILE_SOURCE_REVISION = '5892c0a76d0baf422133981fa1cb66d6ebfb9852';
const PROFILE = 'confidence-repository-v1';
const MAXIMUM = 32 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function git(repository: string, args: string[], input?: Uint8Array | string): Buffer {
  return execFileSync('git', ['--no-optional-locks', '-C', repository, ...args], {
    input, maxBuffer: MAXIMUM, timeout: 30_000,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
}
function memoryStore() {
  const values = new Map<string, Uint8Array>(); let writes = 0;
  const store = new ObjectStore({
    async head(key: string) { const value = values.get(key); return value ? { size: value.length } : null; },
    async put(key: string, value: Uint8Array) { writes++; if (!values.has(key)) values.set(key, value.slice()); return {}; },
    async get(key: string) { const value = values.get(key); return value ? { size: value.length, body: new Blob([value.slice().buffer]).stream() } : null; },
  } as unknown as R2Bucket);
  return { store, writes: () => writes };
}

/** Fixed-host test transport; it exposes upload-pack only and never a publication endpoint. */
async function ownedSourceGit() {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-repository-source-'));
  const canonical = join(directory, 'source.git');
  git(directory, ['init', '--bare', '--initial-branch=main', canonical]);
  const remote = `https://${'1'.repeat(32)}.artifacts.cloudflare.net/git/owned/source.git`;
  const token = 'owned-profile-read-capability-test-only';
  return {
    directory, canonical, remote, token,
    async head() { return git(canonical, ['rev-parse', 'refs/heads/main']).toString().trim(); },
    async fetch(request: Request) {
      const url = new URL(request.url), root = new URL(remote);
      assert.equal(url.origin, root.origin); assert.equal(request.headers.get('authorization'), `Bearer ${token}`);
      const suffix = url.pathname.slice(root.pathname.length);
      assert.ok(url.pathname.startsWith(root.pathname + '/') &&
        (request.method === 'GET' && suffix === '/info/refs' && url.search === '?service=git-upload-pack' ||
          request.method === 'POST' && suffix === '/git-upload-pack' && !url.search));
      const body = Buffer.from(await request.arrayBuffer());
      const bytes = Buffer.from(execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'http-backend'], {
        input: body, maxBuffer: MAXIMUM, timeout: 20_000,
        env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_PROJECT_ROOT: directory, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: '/source.git' + suffix, QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method, CONTENT_TYPE: request.headers.get('content-type') || '', CONTENT_LENGTH: String(body.length),
          REMOTE_USER: 'owned-test', SERVER_PROTOCOL: 'HTTP/1.1' },
      }));
      const separator = bytes.indexOf('\r\n\r\n'); assert.ok(separator >= 0);
      const headers = new Headers(); let status = 200;
      for (const line of bytes.subarray(0, separator).toString().split('\r\n')) {
        const colon = line.indexOf(':'); assert.ok(colon > 0);
        const name = line.slice(0, colon), value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') status = Number(value.slice(0, 3)); else headers.set(name, value);
      }
      return new Response(new Uint8Array(bytes.subarray(separator + 4)).buffer, { status, headers });
    },
    async dispose() { await rm(directory, { recursive: true, force: true }); },
  };
}

/** Requires the exact commit locally. All Git mutations occur in owned temporary repositories. */
export async function qualifyRepositoryProfile(repository: string, revision = PROFILE_SOURCE_REVISION) {
  assert.match(revision, /^[a-f0-9]{40}$/);
  repository = resolve(repository);
  assert.equal(git(repository, ['rev-parse', '--verify', `${revision}^{commit}`]).toString().trim(), revision);
  const tree = git(repository, ['ls-tree', '-r', '-t', '-z', revision]).toString().split('\0').filter(Boolean).map(row => {
    const split = row.indexOf('\t'), [mode, type, oid] = row.slice(0, split).split(' ');
    assert.ok(split > 0); return { mode: mode!, type: type!, oid: oid!, path: row.slice(split + 1) };
  });
  const root = git(repository, ['rev-parse', `${revision}^{tree}`]).toString().trim();
  const objectIds = [...new Set([revision, root, ...tree.map(entry => entry.oid)])];
  assert.ok(objectIds.length <= 8192);
  const pack = git(repository, ['pack-objects', '--stdout'], objectIds.join('\n') + '\n');
  const fixture = await ownedSourceGit(), originalFetch = globalThis.fetch;
  try {
    git(fixture.canonical, ['unpack-objects'], pack);
    git(fixture.canonical, ['update-ref', 'refs/heads/main', revision]);
    await writeFile(join(fixture.canonical, 'shallow'), revision + '\n');
    const worktree = join(fixture.directory, 'working');
    git(fixture.directory, ['clone', '--depth=1', '--no-hardlinks', 'file://' + fixture.canonical, worktree]);
    const files = tree.filter(entry => entry.type === 'blob').sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    assert.ok(files.length > 1);
    const dirtyPath = files[0]!.path;
    await writeFile(join(worktree, dirtyPath), 'owned staged fixture work\n'); git(worktree, ['add', '--', dirtyPath]);
    await writeFile(join(worktree, dirtyPath), 'owned later dirty fixture work\n');
    await writeFile(join(worktree, 'unrelated-profile.local'), 'owned unrelated work\n');
    const state = async () => ({
      head: git(worktree, ['rev-parse', 'HEAD']).toString().trim(),
      symbolicHead: git(worktree, ['symbolic-ref', 'HEAD']).toString().trim(),
      index: hash(await readFile(join(worktree, '.git/index'))),
      tracked: hash(await readFile(join(worktree, dirtyPath))),
      unrelated: hash(await readFile(join(worktree, 'unrelated-profile.local'))),
    });
    const before = await state(), retained = memoryStore();
    const source = await snapshotFromClonedRepository(nativeFs, worktree, revision, retained.store, PROFILE);
    assert.deepEqual(source.manifest.entries.map(entry => [entry.path, entry.mode]), files.map(entry => [entry.path, entry.mode]));
    const byPath = new Map(files.map(entry => [entry.path, entry]));
    const binary: string[] = [];
    for (const entry of source.manifest.entries) {
      const bytes = await retained.store.get(entry.digest);
      assert.equal(bytes.length, Number(entry.bytes));
      assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), byPath.get(entry.path)!.oid);
      if (bytes.includes(0)) binary.push(entry.path);
    }
    assert.equal(await digest(source.objects), source.objectsDigest);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(await retained.store.get(source.objectsDigest, MAXIMUM))), source.objects);
    const rejected = memoryStore();
    await assert.rejects(snapshotFromClonedRepository(nativeFs, worktree, revision, rejected.store), /SOURCE_SIZE_LIMIT|TYPESCRIPT_PROTECTED_PROFILE_UNREGISTERED/);
    assert.equal(rejected.writes(), 0);

    // Real Git smart HTTP at an approved fixed host, backed by the owned local Git process.
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => fixture.fetch(new Request(input, init));
    let minted = 0, revoked = 0;
    const adapter = new ArtifactsRepository({ async get() { return {
      [Symbol.dispose]() {}, async info() { return { remote: fixture.remote }; },
      async createToken(scope: string) { assert.equal(scope, 'read'); minted++; return { plaintext: fixture.token }; },
      async revokeToken(token: string) { assert.equal(token, fixture.token); revoked++; return true; },
    }; } } as unknown as Artifacts, retained.store);
    const ingested = await adapter.ingest('owned-profile-source', 'main', revision, PROFILE);
    assert.deepEqual(ingested, source);
    assert.equal(minted, 1); assert.equal(revoked, 1);

    const addedBytes = new Uint8Array([0, 255, 128, 10]);
    const addedPath = 'profile-qualification.ts'; assert.ok(!byPath.has(addedPath));
    const addedDigest = await retained.store.put(addedBytes);
    const desired = { ...source.manifest, entries: [...source.manifest.entries.slice(1), {
      path: addedPath, mode: '100755' as const, bytes: String(addedBytes.length), digest: addedDigest,
    }].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
    const materialized = await adapter.materialize(source, [{ id: 'owned-retained-selection', source: { manifest: desired }, base: source }], 'owned-profile-candidate', 1791000000, PROFILE);
    assert.deepEqual(materialized.manifest, desired); assert.equal(materialized.parent, revision);
    assert.notEqual(materialized.commit, revision);
    const valid = JSON.parse(getKernel().validate_git_source(canonicalize({ candidate: {
      id: 'owned-profile-candidate', digest: await digest(desired), commit: materialized.commit,
      commitBytesDigest: materialized.commitBytesDigest, parent: revision, manifestDigest: materialized.manifestDigest,
    }, manifest: desired, gitObjects: materialized.objects })));
    assert.equal(valid.valid, true);
    assert.deepEqual(await retained.store.get(addedDigest), addedBytes);
    assert.equal(await digest(source.manifest), source.manifestDigest);
    assert.equal(await fixture.head(), revision);
    assert.deepEqual(await state(), before);
    const implementation = Object.fromEntries(await Promise.all([
      'workers/authority/artifacts.ts', 'workers/shared/objects.ts', 'infra/test-weft/repository-profile-check.ts',
      'packages/protocol/wasm/confidence_protocol_bg.wasm',
    ].map(async path => [path, 'sha256:' + hash(await readFile(new URL('../../' + path, import.meta.url)))])));
    return {
      schema: 'confidence.repository-source-qualification.v1', passed: true,
      implementation,
      profile: PROFILE, selectedCommit: revision, sourceManifest: source.manifestDigest,
      files: files.length, sourceBytes: source.manifest.entries.reduce((total, entry) => total + Number(entry.bytes), 0),
      closureObjects: source.objects.length, closureJSONBytes: Buffer.byteLength(canonicalize(source.objects)),
      executableFiles: files.filter(entry => entry.mode === '100755').length, binaryPaths: binary,
      candidateCommit: materialized.commit, candidateManifest: materialized.manifestDigest,
      gitSourceVerified: true, persistedBytesVerified: true, defaultProfileRejected: true,
      localHeadIndexAndDirtyPreserved: true, canonicalRefUnchanged: true,
      transport: 'real local git-http-backend with fixed-host test transport and synthetic read capability',
      objectStore: 'in-memory R2 test binding with production ObjectStore digest/readback validation',
      unqualified: ['authority enrollment', 'protected execution', 'human approval', 'publication', 'deployed integration'],
    };
  } finally { globalThis.fetch = originalFetch; await fixture.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await initializeKernel();
  const report = await qualifyRepositoryProfile(resolve('.'));
  assert.equal(report.files, 661); assert.equal(report.sourceBytes, 8782732);
  assert.equal(report.sourceManifest, 'sha256:ef6849faa0b61b6d1fcf06b624da340568739130753d91ec2cfddd2281f141c2');
  await mkdir('demo-output', { recursive: true });
  await writeFile('demo-output/confidence-repository-source.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
