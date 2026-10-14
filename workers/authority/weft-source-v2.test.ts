// SPDX-License-Identifier: Apache-2.0
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeKernel } from '../../packages/protocol/src/node';
import { canonicalize, encodeBase64 } from '../../packages/protocol/src/index';
import { digestBytes } from '../shared/errors';
import { ObjectStore } from '../shared/objects';
import * as git from 'isomorphic-git';
import { Volume, createFsFromVolume } from 'memfs';
import { ArtifactsRepository, snapshotFromClonedRepository } from './artifacts';
import type { WeftSourceClient } from './weft-source';
import { acquireWeftSourceV2, persistWeftSourceV2 } from './weft-source-v2';

before(initializeKernel);
// Synthetic caller-supplied contract identifier. It does not claim b1c5521 implements v2.
const encoder = new TextEncoder(), options = { weftContractRevision: 'c'.repeat(40) };
type Entry = { hash: string; size: number; mode: number; encoding: 'utf8' | 'base64' };
type Content = { encoding: 'utf8' | 'base64'; content: string };
type Files = Record<string, { bytes: string | Uint8Array; mode?: number }>;
async function fixture(files: Files) {
  const entries: Record<string, Entry> = {}, objects: Record<string, Content> = {};
  for (const path of Object.keys(files).sort()) {
    const raw = files[path].bytes, bytes = typeof raw === 'string' ? encoder.encode(raw) : raw;
    let text: string | null = null;
    try { text = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes); if (text.includes('\0')) text = null; } catch {}
    const encoding = text === null ? 'base64' : 'utf8', hash = (await digestBytes(bytes)).slice(7);
    Object.defineProperty(entries, path, { value: { hash, size: bytes.length, mode: files[path].mode ?? 0o100644, encoding }, enumerable: true, configurable: true });
    objects[hash] = { encoding, content: text ?? encodeBase64(bytes) };
  }
  const manifest = { schema: 'weft.manifest.v2', entries, root: '', bytes: Object.values(entries).reduce((sum, entry) => sum + entry.size, 0) };
  const selection = { revision: 4, root: '', privacyGeneration: 3, profileHash: 'a'.repeat(64) };
  const selected = { schema: 'weft.sync-selection.v2', revision: selection.revision, manifest, privacyGeneration: selection.privacyGeneration, profileHash: selection.profileHash };
  const rehash = async () => { manifest.root = (await digestBytes(encoder.encode('weft:manifest:v2\n' + canonicalize({ schema: manifest.schema, entries })))).slice(7); selection.root = manifest.root; };
  await rehash();
  const calls: { path: string; hashes?: string[] }[] = [];
  const client: WeftSourceClient = { async fetch(path, init) {
    if (path === 'sync-v2/revisions/4') { calls.push({ path }); return Response.json(selected); }
    assert.equal(path, 'sync-contents-v2'); assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init.body));
    assert.deepEqual(Object.keys(body).sort(), ['hashes', 'privacyGeneration', 'profileHash', 'revision', 'root', 'schema']);
    assert.deepEqual({ ...body, hashes: [] }, { schema: 'weft.sync-request.v2', ...selection, hashes: [] });
    calls.push({ path, hashes: body.hashes });
    return Response.json({ schema: 'weft.sync-contents.v2', ...selection, objects: Object.fromEntries(body.hashes.map((hash: string) => [hash, objects[hash]])) });
  } };
  return { client, calls, manifest, selection, selected, objects, rehash };
}
function changed(client: WeftSourceClient, transform: (path: string, value: Record<string, unknown>) => unknown): WeftSourceClient {
  return { async fetch(path, init) { return Response.json(transform(path, await (await client.fetch(path, init)).json() as Record<string, unknown>)); } };
}
function store() {
  const contents = new Map<string, Uint8Array>(); let writes = 0;
  const objects = new ObjectStore({ async head(key: string) { return contents.has(key) ? { size: contents.get(key)!.length } : null; },
    async put(key: string, value: Uint8Array) { writes++; contents.set(key, value.slice()); },
    async get(key: string) { const bytes = contents.get(key); return bytes ? { size: bytes.length, body: new Blob([bytes.slice().buffer]).stream() } : null; },
  } as unknown as R2Bucket);
  return { objects, contents, writes: () => writes };
}

test('independent Weft golden vector binds literal hashes, binary bytes, executable CRLF text and empty content', async () => {
  // Copied unchanged from Weft docs/evidence/byte-profile-v2-vector.json on 2026-10-14.
  // These synthetic exceptions approve no real repository files or running deployment.
  const vector = JSON.parse(await readFile(new URL('../../fixtures/weft/byte-profile-v2-vector.json', import.meta.url), 'utf8')) as {
    scope: string; profileHash: string; files: Record<string, Content & { mode: number }>;
    manifest: { schema: string; root: string; bytes: number; entries: Record<string, Entry> };
  };
  assert.equal(vector.profileHash, 'b97e74d3b1a541ab904b6c8687873df6677b91effe24f702400aa0acce0dfb58');
  assert.equal(vector.manifest.root, '210b4cffa5f8792ab2232e2b583cf0399864b1978b39e8a9029f48e8191c9c76');
  assert.match(vector.scope, /not a deployment or approval/);
  const selection = { revision: 4, root: vector.manifest.root, privacyGeneration: 1, profileHash: vector.profileHash };
  const objects = Object.fromEntries(Object.entries(vector.files).map(([path, file]) => [vector.manifest.entries[path].hash, { encoding: file.encoding, content: file.content }]));
  const client: WeftSourceClient = { async fetch(path, init) {
    if (path === 'sync-v2/revisions/4') return Response.json({ schema: 'weft.sync-selection.v2', revision: 4, manifest: vector.manifest, privacyGeneration: 1, profileHash: vector.profileHash });
    assert.equal(path, 'sync-contents-v2'); const hashes = JSON.parse(String(init?.body)).hashes as string[];
    return Response.json({ schema: 'weft.sync-contents.v2', ...selection, objects: Object.fromEntries(hashes.map(hash => [hash, objects[hash]])) });
  } };
  const source = await acquireWeftSourceV2(client, selection, options);
  assert.deepEqual(source.manifest.entries, [
    { path: 'empty', mode: '100644', bytes: '0', digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
    { path: 'fixture.bundle', mode: '100644', bytes: '2', digest: 'sha256:06eb7d6a69ee19e5fbdf749018d3d2abfa04bcbd1365db312eb86dc7169389b8' },
    { path: 'hello.txt', mode: '100755', bytes: '7', digest: 'sha256:cd2eca3535741f27a8ae40c31b0c41d4057a7a7b912b33b9aed86485d1c84676' },
  ]);
  assert.deepEqual(source.contents.get(source.manifest.entries[0].digest), new Uint8Array());
  assert.deepEqual(source.contents.get(source.manifest.entries[1].digest), new Uint8Array([0, 255]));
  assert.deepEqual(source.contents.get(source.manifest.entries[2].digest), new Uint8Array([104, 101, 108, 108, 111, 13, 10]));
});

test('independently calculated literal BOM vector keeps the BOM in raw source identity', async () => {
  // Separate from the upstream three-file golden vector, which contains no BOM.
  const hash = 'ce1147fdc2c0b2bae8886109c9ea731213a5bd591e0755f1fc3ec699b5f0b003';
  const selection = { revision: 4, root: '56a5eef156cd399655a0653d9acce602e94abfbe5438e01c7662c3b1a8dde8c5', privacyGeneration: 1, profileHash: 'a'.repeat(64) };
  const manifest = { schema: 'weft.manifest.v2', root: selection.root, bytes: 10, entries: { 'bom.txt': { hash, size: 10, mode: 33261, encoding: 'utf8' } } };
  const client: WeftSourceClient = { async fetch(path, init) {
    if (path === 'sync-v2/revisions/4') return Response.json({ schema: 'weft.sync-selection.v2', revision: 4, manifest, privacyGeneration: 1, profileHash: selection.profileHash });
    assert.equal(path, 'sync-contents-v2'); const hashes = JSON.parse(String(init?.body)).hashes as string[];
    return Response.json({ schema: 'weft.sync-contents.v2', ...selection, objects: hashes.length ? { [hash]: { encoding: 'utf8', content: '\uFEFFhello\r\n' } } : {} });
  } };
  const source = await acquireWeftSourceV2(client, selection, options);
  assert.deepEqual(source.contents.get('sha256:' + hash), new Uint8Array([239, 187, 191, 104, 101, 108, 108, 111, 13, 10]));
  assert.equal(source.manifest.entries[0].mode, '100755');
});

test('v2 preserves canonical binary, BOM/CRLF text, empty files, modes and duplicate hashes', async () => {
  const binary = new Uint8Array([0, 255, 128, 1]);
  const f = await fixture({ 'data.bin': { bytes: binary }, 'copy.bin': { bytes: binary, mode: 0o100755 }, 'app.ts': { bytes: '\uFEFFexport const n = 1;\r\n' }, empty: { bytes: '' } });
  const source = await acquireWeftSourceV2(f.client, f.selection, options);
  assert.equal(source.contents.size, 3); assert.deepEqual(source.contents.get(await digestBytes(binary)), binary);
  assert.equal(source.manifest.entries.find(entry => entry.path === 'copy.bin')?.mode, '100755');
  assert.equal(source.mapping.representation, 'exact-bytes-v2'); assert.equal(source.mapping.weftContractRevision, options.weftContractRevision);
  assert.deepEqual(source.selection, f.selection); assert.equal(source.mapping.selection.profileHash, f.selection.profileHash);
  assert.equal(source.mapping.entries.find(entry => entry.path === 'data.bin')?.weft.encoding, 'base64');
  assert.deepEqual(f.calls.filter(call => call.hashes).map(call => call.hashes!.length), [3, 0]);
  const retained = store(); await persistWeftSourceV2(source, retained.objects); const writes = retained.writes();
  await persistWeftSourceV2(source, retained.objects); assert.equal(retained.writes(), writes);
  assert.deepEqual(await retained.objects.get(await digestBytes(binary)), binary);
});

test('absence represents deletion and later live work cannot mutate acquired bytes', async () => {
  const initial = await fixture({ 'keep.ts': { bytes: 'selected\n' }, 'deleted.bin': { bytes: new Uint8Array([0]) } });
  const next = await fixture({ 'keep.ts': { bytes: 'selected\n' } });
  const source = await acquireWeftSourceV2(next.client, next.selection, options);
  assert.equal(initial.manifest.entries['deleted.bin'].encoding, 'base64');
  assert.deepEqual(source.manifest.entries.map(entry => entry.path), ['keep.ts']);
  next.objects[next.manifest.entries['keep.ts'].hash].content = 'later live edits';
  assert.equal(new TextDecoder().decode(source.contents.values().next().value), 'selected\n');
});

test('verified binary selection materializes a real exact Git candidate with a deletion and no remote write', async () => {
  const retained = store(), fs = createFsFromVolume(new Volume()), dir = '/source'; await git.init({ fs, dir });
  const blob = await git.writeBlob({ fs, dir, blob: encoder.encode('base\n') });
  const tree = await git.writeTree({ fs, dir, tree: ['gone.bin', 'script.mjs'].map(path => ({ path, mode: '100644', type: 'blob' as const, oid: blob })) });
  const identity = { name: 'Synthetic v2 test', email: 'v2@localhost', timestamp: 1791970000, timezoneOffset: 0 };
  const commit = await git.writeCommit({ fs, dir, commit: { tree, parent: [], author: identity, committer: identity, message: 'Owned base\n' } });
  const base = await snapshotFromClonedRepository(fs, dir, commit, retained.objects);
  const f = await fixture({ 'payload.bin': { bytes: new Uint8Array([0, 255, 254]) }, 'script.mjs': { bytes: 'export {};\r\n', mode: 0o100755 } });
  const selected = await acquireWeftSourceV2(f.client, f.selection, options); await persistWeftSourceV2(selected, retained.objects);
  const artifacts = new Proxy({}, { get() { throw new Error('No remote writes during staging'); } }) as Artifacts;
  const repository = new ArtifactsRepository(artifacts, retained.objects);
  const staged = await repository.materialize(base, [{ id: 'v2', source: selected, base }], 'v2', 1791970010);
  assert.equal(staged.manifestDigest, selected.manifestDigest); assert.deepEqual(staged.manifest, selected.manifest); assert.equal(staged.parent, commit);
  assert.equal(staged.manifest.entries.some(entry => entry.path === 'gone.bin'), false);
  assert.ok(staged.objects.some(object => object.type === 'blob' && object.dataBase64 === 'AP/+'));
  const repeated = await repository.materialize(base, [{ id: 'v2', source: selected, base }], 'v2', 1791970010);
  assert.equal(repeated.commit, staged.commit);
});

test('v2 rejects tampered roots, hashes, byte counts and incomplete or additional objects', async () => {
  const f = await fixture({ a: { bytes: 'abc' } }); const hash = f.manifest.entries.a.hash;
  await assert.rejects(acquireWeftSourceV2(changed(f.client, (path, value) => path.includes('revisions') ? { ...value, manifest: { ...f.manifest, root: 'b'.repeat(64) } } : value), f.selection, options), { code: 'WEFT_INVALID_MANIFEST' });
  for (const objects of [{}, { [hash]: f.objects[hash], ['b'.repeat(64)]: f.objects[hash] }, { [hash]: { encoding: 'utf8', content: 'abd' } }, { [hash]: { encoding: 'utf8', content: 'ab' } }])
    await assert.rejects(acquireWeftSourceV2(changed(f.client, (path, value) => path === 'sync-contents-v2' ? { ...value, objects } : value), f.selection, options));
  f.manifest.bytes++; await assert.rejects(acquireWeftSourceV2(f.client, f.selection, options), { code: 'WEFT_MANIFEST_LENGTH_MISMATCH' });
});

test('base64 must be padded, canonical, binary-needed, and match declared encoding', async () => {
  for (const content of ['AP8', 'AP9=', ' AP8=', 'AP8=\n', 'AP8===']) {
    const f = await fixture({ binary: { bytes: new Uint8Array([0, 255]) } }); f.objects[f.manifest.entries.binary.hash].content = content;
    await assert.rejects(acquireWeftSourceV2(f.client, f.selection, options), { code: 'WEFT_NONCANONICAL_ENCODING' });
  }
  const text = await fixture({ a: { bytes: 'text' } }); text.manifest.entries.a.encoding = 'base64';
  text.objects[text.manifest.entries.a.hash] = { encoding: 'base64', content: encodeBase64(encoder.encode('text')) }; await text.rehash();
  await assert.rejects(acquireWeftSourceV2(text.client, text.selection, options), { code: 'WEFT_NONCANONICAL_ENCODING' });
  const mismatch = await fixture({ a: { bytes: 'text' } }); mismatch.objects[mismatch.manifest.entries.a.hash].encoding = 'base64';
  await assert.rejects(acquireWeftSourceV2(mismatch.client, mismatch.selection, options), { code: 'WEFT_CONTENT_ENCODING_MISMATCH' });
});

test('UTF-8 wire objects cannot carry NUL, malformed surrogates or unknown members', async () => {
  for (const content of ['\0', '\uD800']) {
    const f = await fixture({ a: { bytes: 'x' } }); f.objects[f.manifest.entries.a.hash].content = content;
    await assert.rejects(acquireWeftSourceV2(f.client, f.selection, options));
  }
  const f = await fixture({ a: { bytes: 'x' } });
  await assert.rejects(acquireWeftSourceV2(changed(f.client, (_path, value) => ({ ...value, extra: true })), f.selection, options));
  const invalid = { async fetch() { return new Response('{"schema":"weft.sync-selection.v2","schema":"weft.sync-selection.v2"}'); } };
  await assert.rejects(acquireWeftSourceV2(invalid, f.selection, options), { code: 'WEFT_INVALID_RESPONSE' });
  const malformed = { async fetch() { return new Response(new Uint8Array([123, 34, 255, 34, 58, 49, 125])); } };
  await assert.rejects(acquireWeftSourceV2(malformed, f.selection, options), { code: 'WEFT_INVALID_RESPONSE' });
});

test('complete 661-entry manifests pass without weakening the signed protocol object-key limit', async () => {
  const f = await fixture(Object.fromEntries(Array.from({ length: 661 }, (_, index) => [`src/f${index}.ts`, { bytes: 'export {};\n' }])));
  const source = await acquireWeftSourceV2(f.client, f.selection, options);
  assert.equal(source.manifest.entries.length, 661); assert.equal(source.contents.size, 1);
  assert.equal(f.calls.filter(call => call.hashes?.length).length, 1);
});

test('retained selection, privacy generation and profile identity must stay exact through final authorization', async () => {
  const f = await fixture({ a: { bytes: 'x' } });
  for (const field of ['privacyGeneration', 'profileHash', 'revision', 'root']) {
    const value = field === 'profileHash' || field === 'root' ? 'b'.repeat(64) : 99;
    await assert.rejects(acquireWeftSourceV2(changed(f.client, (path, body) => path === 'sync-contents-v2' ? { ...body, [field]: value } : body), f.selection, options), { code: 'WEFT_CONTENT_SELECTION_MISMATCH' });
  }
  const denied: WeftSourceClient = { async fetch(path, init) { if (path === 'sync-contents-v2' && JSON.parse(String(init?.body)).hashes.length === 0) return new Response('', { status: 403 }); return f.client.fetch(path, init); } };
  await assert.rejects(acquireWeftSourceV2(denied, f.selection, options), { code: 'WEFT_ACCESS_DENIED' });
  const changedProfile: WeftSourceClient = { async fetch(path, init) {
    const response = await f.client.fetch(path, init);
    if (path !== 'sync-contents-v2' || JSON.parse(String(init?.body)).hashes.length) return response;
    return Response.json({ ...await response.json() as Record<string, unknown>, profileHash: 'b'.repeat(64) });
  } };
  await assert.rejects(acquireWeftSourceV2(changedProfile, f.selection, options), { code: 'WEFT_CONTENT_SELECTION_MISMATCH' });
  const empty = await fixture({}); await acquireWeftSourceV2(empty.client, empty.selection, options);
  assert.deepEqual(empty.calls.map(call => call.hashes), [undefined, []]);
});

test('batches independently enforce 32 distinct hashes and one MiB decoded contents', async () => {
  const many = await fixture(Object.fromEntries(Array.from({ length: 35 }, (_, index) => ['file' + index, { bytes: String(index) }])));
  await acquireWeftSourceV2(many.client, many.selection, options);
  assert.deepEqual(many.calls.filter(call => call.hashes).map(call => call.hashes!.length), [32, 3, 0]);
  const large = await fixture(Object.fromEntries(['a', 'b', 'c'].map(value => [value, { bytes: value.repeat(400 * 1024) }])));
  await acquireWeftSourceV2(large.client, large.selection, options);
  assert.deepEqual(large.calls.filter(call => call.hashes).map(call => call.hashes!.length), [2, 1, 0]);
});

test('the expanded kernel admits a complete source above the legacy four MiB ceiling', async () => {
  const f = await fixture(Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`f${index}.ts`, { bytes: 'x'.repeat(512 * 1024) }])));
  const source = await acquireWeftSourceV2(f.client, f.selection, options);
  assert.equal(source.manifest.entries.reduce((sum, entry) => sum + Number(entry.bytes), 0), 17 * 512 * 1024);
  assert.equal(source.contents.size, 1); assert.deepEqual(f.calls.filter(call => call.hashes).map(call => call.hashes!.length), [1, 0]);
});

test('duplicate hashes cannot declare different sizes or encodings and modes/paths remain bounded', async () => {
  for (const field of ['size', 'encoding']) {
    const f = await fixture({ a: { bytes: 'x' }, b: { bytes: 'x' } });
    if (field === 'size') f.manifest.entries.b.size = 2; else f.manifest.entries.b.encoding = 'base64';
    await f.rehash(); await assert.rejects(acquireWeftSourceV2(f.client, f.selection, options), { code: 'WEFT_INCONSISTENT_CONTENT' });
    assert.equal(f.calls.length, 1);
  }
  const unsupported: Files[] = [{ '.env': { bytes: 'x' } }, { 'a': { bytes: 'x', mode: 0o120000 } }, { 'A': { bytes: 'x' }, 'a': { bytes: 'y' } }];
  for (const files of unsupported) {
    const f = await fixture(files); await assert.rejects(acquireWeftSourceV2(f.client, f.selection, options)); assert.equal(f.calls.length, 1);
  }
});

test('v2 profile refuses oversized files or trees before reading content and requires a pin', async () => {
  const large = await fixture({ a: { bytes: 'x'.repeat(512 * 1024 + 1) } });
  await assert.rejects(acquireWeftSourceV2(large.client, large.selection, options), { code: 'WEFT_UNSUPPORTED_ENTRY' });
  const tree = await fixture(Object.fromEntries(Array.from({ length: 33 }, (_, index) => ['f' + index, { bytes: 'x'.repeat(512 * 1024) }])));
  await assert.rejects(acquireWeftSourceV2(tree.client, tree.selection, options), { code: 'SOURCE_SIZE_LIMIT' });
  assert.equal(tree.calls.length, 1);
  const small = await fixture({}); await assert.rejects(acquireWeftSourceV2(small.client, small.selection, { weftContractRevision: 'HEAD' }), { code: 'WEFT_CONTRACT_PIN_REQUIRED' });
});

test('deadline aborts a stalled body even if the client ignores the fetch signal', async () => {
  const f = await fixture({}); let cancelled = false;
  const stalled: WeftSourceClient = { async fetch() { return new Response(new ReadableStream({ cancel() { cancelled = true; } })); } };
  await assert.rejects(acquireWeftSourceV2(stalled, f.selection, { ...options, timeoutMs: 15 }), { code: 'WEFT_ACQUISITION_DEADLINE' });
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(cancelled, true);
});

test('content response wire bytes and v1 downgrade remain refused', async () => {
  const f = await fixture({ a: { bytes: 'x' } });
  const oversized: WeftSourceClient = { async fetch(path, init) { return path === 'sync-contents-v2' ? new Response(new Uint8Array(7 * 1024 * 1024 + 1)) : f.client.fetch(path, init); } };
  await assert.rejects(acquireWeftSourceV2(oversized, f.selection, options), { code: 'SIZE_LIMIT' });
  await assert.rejects(acquireWeftSourceV2(changed(f.client, (_path, value) => ({ ...value, schema: 'weft.sync-selection.v1' })), f.selection, options), { code: 'WEFT_INVALID_SELECTION' });
  for (const status of [401, 403, 404, 409, 302]) {
    const failed: WeftSourceClient = { async fetch() { return new Response('', { status }); } };
    await assert.rejects(acquireWeftSourceV2(failed, f.selection, options));
  }
});

test('transient upstream refusals are retryable while selected revision remains unchanged', async () => {
  for (const status of [408, 429, 503]) {
    const f = await fixture({ a: { bytes: 'x' } }); let failed = false;
    const client: WeftSourceClient = { async fetch(path, init) { if (path === 'sync-contents-v2' && !failed) { failed = true; return new Response('non-JSON backpressure', { status }); } return f.client.fetch(path, init); } };
    await assert.rejects(acquireWeftSourceV2(client, f.selection, options), { status: 503 });
    const source = await acquireWeftSourceV2(client, f.selection, options); assert.deepEqual(source.selection, f.selection);
  }
});

test('persistence refuses mutated acquired bytes before any R2 write', async () => {
  const f = await fixture({ a: { bytes: new Uint8Array([0, 255]) } });
  const source = await acquireWeftSourceV2(f.client, f.selection, options), retained = store();
  source.contents.values().next().value![0] = 1;
  await assert.rejects(persistWeftSourceV2(source, retained.objects), { code: 'WEFT_CONTENT_DIGEST_MISMATCH' });
  assert.equal(retained.writes(), 0);
});
