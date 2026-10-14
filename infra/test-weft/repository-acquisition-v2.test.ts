// SPDX-License-Identifier: Apache-2.0
// Exact real Git source, synthetic v2 wire peer. This approves no file exceptions or deployment.
import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import nativeFs from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalize, encodeBase64, getKernel } from '../../packages/protocol/src/index.ts';
import { initializeKernel } from '../../packages/protocol/src/node.ts';
import { auditConfidenceRepository, REVIEWED_CONFIDENCE_REVISION } from '../confidence-repository-profile.ts';
import { snapshotFromClonedRepository, ArtifactsRepository } from '../../workers/authority/artifacts.ts';
import { acquireWeftSourceV2, persistWeftSourceV2 } from '../../workers/authority/weft-source-v2.ts';
import type { WeftSourceClient } from '../../workers/authority/weft-source.ts';
import { ObjectStore } from '../../workers/shared/objects.ts';
import { digestBytes } from '../../workers/shared/errors.ts';

before(initializeKernel);
const PROFILE = 'confidence-repository-v1', encoder = new TextEncoder();
const EXPECTED_MANIFEST = 'sha256:ef6849faa0b61b6d1fcf06b624da340568739130753d91ec2cfddd2281f141c2';
const EXPECTED_WEFT_ROOT = 'e062f92f3b35b3d8ac775c5889502908b99b2b1fcefc5f9fb43d1b7c745b36c0';
type Entry = { hash: string; size: number; mode: number; encoding: 'utf8' | 'base64' };
type Content = { encoding: 'utf8' | 'base64'; content: string };
function retainedObjects() {
  const data = new Map<string, Uint8Array>();
  const objects = new ObjectStore({
    async head(key: string) { return data.has(key) ? { size: data.get(key)!.length } : null; },
    async put(key: string, bytes: Uint8Array) { data.set(key, bytes.slice()); },
    async get(key: string) { const bytes = data.get(key); return bytes ? { size: bytes.length, body: new Blob([bytes.slice().buffer]).stream() } : null; },
  } as unknown as ConstructorParameters<typeof ObjectStore>[0]);
  return { data, objects };
}

test('all 661 exact Confidence files acquire, map and materialize through the synthetic v2 contract', { timeout: 60000 }, async t => {
  const repository = resolve('.');
  const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', '-C', repository, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10000 }).trim();
  const gitDirectory = git('rev-parse', '--absolute-git-dir');
  const before = { head: git('rev-parse', 'HEAD'), index: await readFile(join(gitDirectory, 'index')) };
  const preflight = await auditConfidenceRepository({ repository, revision: REVIEWED_CONFIDENCE_REVISION });
  assert.equal(preflight.inventory.files, 661); assert.equal(preflight.inventory.bytes, 8782732);
  assert.equal(preflight.sourceManifest?.digest, EXPECTED_MANIFEST);
  assert.equal(preflight.qualified, false, 'capacity and synthetic peer do not qualify real Weft capture or protected checks');

  // isomorphic-git consumes a normal cloned repository, not Git's linked-worktree
  // .git indirection. Pack the exact selected closure into an owned fixture so
  // this same acquisition test also works from an integration worktree.
  const fixtureRepository = await mkdtemp(join(tmpdir(), 'confidence-v2-source-'));
  t.after(() => rm(fixtureRepository, { recursive: true, force: true }));
  const tree = git('ls-tree', '-r', '-t', '-z', REVIEWED_CONFIDENCE_REVISION).split('\0').filter(Boolean);
  const identities = [...new Set([REVIEWED_CONFIDENCE_REVISION, git('rev-parse', `${REVIEWED_CONFIDENCE_REVISION}^{tree}`),
    ...tree.map(row => row.slice(0, row.indexOf('\t')).split(' ')[2])])];
  assert.equal(identities.length, preflight.closure.objects);
  const pack = execFileSync('git', ['--no-optional-locks', '-C', repository, 'pack-objects', '--stdout'], {
    input: identities.join('\n') + '\n', maxBuffer: 16 * 1024 * 1024, timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  execFileSync('git', ['init', '--initial-branch=main', fixtureRepository], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', fixtureRepository, 'index-pack', '--stdin'], {
    input: pack, timeout: 20000, maxBuffer: 65536, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const retained = retainedObjects();
  const base = await snapshotFromClonedRepository(nativeFs, fixtureRepository, REVIEWED_CONFIDENCE_REVISION, retained.objects, PROFILE);
  assert.equal(base.manifestDigest, EXPECTED_MANIFEST); assert.equal(base.objects.length, 727);
  const entries: Record<string, Entry> = {}, wireContents: Record<string, Content> = {};
  for (const entry of base.manifest.entries) {
    const bytes = await retained.objects.get(entry.digest, 512 * 1024);
    let text: string | null = null;
    try { text = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes); if (text.includes('\0')) text = null; } catch {}
    const encoding = text === null ? 'base64' : 'utf8', hash = entry.digest.slice(7);
    Object.defineProperty(entries, entry.path, { value: { hash, size: bytes.length, mode: Number.parseInt(entry.mode, 8), encoding }, enumerable: true });
    wireContents[hash] = { encoding, content: text ?? encodeBase64(bytes) };
  }
  const root = (await digestBytes(encoder.encode('weft:manifest:v2\n' + canonicalize({ schema: 'weft.manifest.v2', entries })))).slice(7);
  assert.equal(root, EXPECTED_WEFT_ROOT, 'literal independently calculated root covers all exact Git blobs and modes');
  const selection = { revision: 17, root, privacyGeneration: 3, profileHash: 'd'.repeat(64) };
  const manifest = { schema: 'weft.manifest.v2', entries, root, bytes: 8782732 };
  const batches: string[][] = [];
  const client: WeftSourceClient = { async fetch(path, init) {
    if (path === 'sync-v2/revisions/17') return Response.json({ schema: 'weft.sync-selection.v2', revision: 17, manifest, privacyGeneration: 3, profileHash: selection.profileHash });
    assert.equal(path, 'sync-contents-v2'); const body = JSON.parse(String(init?.body));
    assert.deepEqual({ ...body, hashes: [] }, { schema: 'weft.sync-request.v2', ...selection, hashes: [] });
    const hashes = body.hashes as string[]; assert.ok(hashes.length <= 32); batches.push(hashes);
    const total = hashes.reduce((sum, hash) => sum + Object.values(entries).find(entry => entry.hash === hash)!.size, 0);
    assert.ok(total <= 1024 * 1024);
    return Response.json({ schema: 'weft.sync-contents.v2', ...selection, objects: Object.fromEntries(hashes.map(hash => [hash, wireContents[hash]])) });
  } };
  // Synthetic pin and policy hash are explicit test inputs, never a claim that legacy b1c5521 supports v2.
  const acquired = await acquireWeftSourceV2(client, selection, { weftContractRevision: 'c'.repeat(40) });
  assert.deepEqual(acquired.manifest, base.manifest); assert.equal(acquired.manifestDigest, EXPECTED_MANIFEST);
  assert.equal(acquired.mapping.entries.length, 661); assert.deepEqual(batches.at(-1), []);
  assert.equal(acquired.contents.size, new Set(base.manifest.entries.map(entry => entry.digest)).size);
  for (const entry of acquired.mapping.entries) {
    assert.equal(entry.weft.hash, entry.confidence.digest.slice(7)); assert.equal(String(entry.weft.size), entry.confidence.bytes);
    assert.equal(entry.weft.mode.toString(8), entry.confidence.mode);
    assert.deepEqual(acquired.contents.get(entry.confidence.digest), await retained.objects.get(entry.confidence.digest, 512 * 1024));
  }
  assert.equal(acquired.mapping.entries.find(entry => entry.path === 'fixtures/demo/source.gitbundle')?.weft.encoding, 'base64');
  assert.equal(acquired.manifest.entries.find(entry => entry.path === 'scripts/install-wasm-pack-ci.sh')?.mode, '100755');
  await persistWeftSourceV2(acquired, retained.objects);
  const noRemote = new Proxy({}, { get() { throw new Error('Full source staging must not write a remote ref'); } }) as ConstructorParameters<typeof ArtifactsRepository>[0];
  const adapter = new ArtifactsRepository(noRemote, retained.objects);
  const staged = await adapter.materialize(base, [{ id: 'full-v2-selection', source: acquired, base }], 'full-v2-selection', 1791970010, PROFILE);
  assert.equal(staged.manifestDigest, EXPECTED_MANIFEST); assert.equal(staged.parent, REVIEWED_CONFIDENCE_REVISION);
  assert.equal(JSON.parse(getKernel().validate_git_source(canonicalize({ candidate: { id: 'full-v2-selection', digest: acquired.manifestDigest, commit: staged.commit,
    commitBytesDigest: staged.commitBytesDigest, parent: REVIEWED_CONFIDENCE_REVISION, manifestDigest: staged.manifestDigest }, manifest: staged.manifest, gitObjects: staged.objects }))).valid, true);
  // A later mutable wire peer cannot alter the frozen source or its immutable object mapping.
  const selectedFile = acquired.manifest.entries[0]; wireContents[selectedFile.digest.slice(7)].content = 'later live work';
  assert.deepEqual(await retained.objects.get(selectedFile.digest), acquired.contents.get(selectedFile.digest));
  assert.equal(git('rev-parse', 'HEAD'), before.head); assert.deepEqual(await readFile(join(gitDirectory, 'index')), before.index);
});
