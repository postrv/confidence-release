// SPDX-License-Identifier: Apache-2.0
import test, { before } from "node:test";
import assert from "node:assert/strict";
import * as git from "isomorphic-git";
import { Volume, createFsFromVolume } from "memfs";
import { initializeKernel } from "../../packages/protocol/src/node";
import { canonicalize, getKernel } from "../../packages/protocol/src/index";
import { digestBytes, PlatformError } from "../shared/errors";
import { ObjectStore } from "../shared/objects";
import { ArtifactsRepository, snapshotFromClonedRepository } from "./artifacts";
import { acquireWeftSource, persistWeftSource, WEFT_SOURCE_REVISION, type WeftSourceClient } from "./weft-source";

before(initializeKernel);
const encoder = new TextEncoder();
type Files = Record<string, { text: string; mode?: number }>;
type Manifest = { schema: string; entries: Record<string, { hash: string; size: number; mode: number }>; root: string; bytes: number };

async function retainedFixture(files: Files) {
  const entries: Manifest["entries"] = {};
  const objects: Record<string, string> = {};
  let total = 0;
  for (const path of Object.keys(files).sort()) {
    const { text, mode = 0o100644 } = files[path];
    const bytes = encoder.encode(text); const hash = (await digestBytes(bytes)).slice(7);
    Object.defineProperty(entries, path, { value: { hash, size: bytes.length, mode }, enumerable: true });
    objects[hash] = text; total += bytes.length;
  }
  const root = (await digestBytes(encoder.encode(`weft:manifest:v1\n${canonicalize({ schema: "weft.manifest.v1", entries })}`))).slice(7);
  const manifest: Manifest = { schema: "weft.manifest.v1", entries, root, bytes: total };
  const selection = { revision: 7, root, privacyGeneration: 3 };
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const selected = { schema: "weft.sync-selection.v1", revision: selection.revision, manifest, privacyGeneration: selection.privacyGeneration };
  const client: WeftSourceClient = { async fetch(path, init) {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, body });
    if (path === `sync/revisions/${selection.revision}`) return Response.json(selected);
    assert.equal(path, "sync-contents"); assert.equal(init?.method, "POST");
    assert.deepEqual(Object.keys(body!).sort(), ["hashes", "privacyGeneration", "revision", "root", "schema"]);
    assert.equal(body!.schema, "weft.sync-request.v1"); assert.equal(body!.revision, selection.revision);
    assert.equal(body!.root, selection.root); assert.equal(body!.privacyGeneration, selection.privacyGeneration);
    const hashes = body!.hashes as string[];
    return Response.json({ schema: "weft.sync-contents.v1", ...selection, objects: Object.fromEntries(hashes.map(hash => [hash, objects[hash]])) });
  } };
  return { client, calls, selection, selected, objects, manifest };
}

function objectStore() {
  const data = new Map<string, Uint8Array>(); let writes = 0;
  const store = new ObjectStore({
    async head(key: string) { return data.has(key) ? { size: data.get(key)!.length } : null; },
    async put(key: string, value: Uint8Array) { writes++; if (!data.has(key)) data.set(key, value.slice()); return {}; },
    async get(key: string) { const bytes = data.get(key); return bytes ? { size: bytes.length, body: new Blob([bytes.slice().buffer]).stream() } : null; },
  } as unknown as R2Bucket);
  return { store, data, writes: () => writes };
}

function transformed(client: WeftSourceClient, transform: (path: string, value: any) => unknown): WeftSourceClient {
  return { async fetch(path, init) { const response = await client.fetch(path, init); return Response.json(transform(path, await response.json())); } };
}

test("retained acquisition preserves exact UTF-8 bytes, executable modes, and verifiable mapping", async () => {
  const text = "\uFEFFexport default 'caf\u00e9';\r\n";
  const fixture = await retainedFixture({ "server.mjs": { text, mode: 0o100755 }, "nested/copy.mjs": { text }, "empty.mjs": { text: "" } });
  const source = await acquireWeftSource(fixture.client, fixture.selection);
  assert.equal(WEFT_SOURCE_REVISION, "b1c5521bf28a0144203c55b3f056885dce3535ff");
  assert.deepEqual(source.selection, fixture.selection);
  assert.deepEqual(source.manifest.entries.map(entry => [entry.path, entry.mode]), [["empty.mjs", "100644"], ["nested/copy.mjs", "100644"], ["server.mjs", "100755"]]);
  assert.equal(source.contents.size, 2, "duplicate blobs transfer only once");
  const entry = source.manifest.entries.find(item => item.path === "server.mjs")!;
  assert.deepEqual(source.contents.get(entry.digest), encoder.encode(text));
  assert.equal(source.manifestDigest, await digestBytes(encoder.encode(canonicalize(source.manifest))));
  assert.equal(source.mappingDigest, await digestBytes(encoder.encode(canonicalize(source.mapping))));
  assert.equal(source.mapping.sourceManifestDigest, source.manifestDigest);
  assert.deepEqual(source.mapping.entries.find(item => item.path === "server.mjs"), { path: "server.mjs", weft: fixture.manifest.entries["server.mjs"], confidence: { digest: entry.digest, bytes: entry.bytes, mode: "100755" } });
  assert.deepEqual(fixture.calls.map(call => call.path), ["sync/revisions/7", "sync-contents", "sync-contents"]);
  assert.deepEqual(fixture.calls.at(-1)!.body!.hashes, [], "final empty acquisition reauthorizes the exact selection");
  const stored = objectStore();
  assert.deepEqual(await persistWeftSource(source, stored.store), { manifestDigest: source.manifestDigest, mappingDigest: source.mappingDigest });
  assert.deepEqual(await stored.store.get(entry.digest), encoder.encode(text));
  assert.equal(stored.writes(), 4, "two distinct blobs plus source manifest and source mapping");
  await persistWeftSource(source, stored.store);
  assert.equal(stored.writes(), 4, "retry reuses content-addressed objects");
});

test("exact selection stages a valid immutable Git source including deletion without a remote write", async () => {
  const stored = objectStore();
  const fs = createFsFromVolume(new Volume()); const dir = "/base";
  await git.init({ fs, dir });
  const old = encoder.encode("old\n"); const blob = await git.writeBlob({ fs, dir, blob: old });
  const tree = await git.writeTree({ fs, dir, tree: ["delete.mjs", "server.mjs"].map(path => ({ path, mode: "100644", type: "blob" as const, oid: blob })) });
  const identity = { name: "Synthetic test", email: "test@example.invalid", timestamp: 1791970000, timezoneOffset: 0 };
  const commit = await git.writeCommit({ fs, dir, commit: { tree, parent: [], author: identity, committer: identity, message: "Test base\n" } });
  const base = await snapshotFromClonedRepository(fs, dir, commit, stored.store);
  const fixture = await retainedFixture({ "server.mjs": { text: "new\r\n", mode: 0o100755 } });
  const source = await acquireWeftSource(fixture.client, fixture.selection);
  await persistWeftSource(source, stored.store);
  const artifacts = new Proxy({}, { get() { throw new Error("Staging must not call Artifacts or update any remote ref"); } }) as Artifacts;
  const repository = new ArtifactsRepository(artifacts, stored.store);
  const staged = await repository.materialize(base, [{ id: "weft-test", source, base }], "weft-test", 1791970010);
  assert.deepEqual(staged.manifest, source.manifest);
  assert.equal(staged.manifestDigest, source.manifestDigest);
  assert.equal(staged.parent, base.commit);
  assert.deepEqual(staged.manifest.entries.map(entry => entry.path), ["server.mjs"]);
  const validation = JSON.parse(getKernel().validate_git_source(canonicalize({ candidate: { id: "weft-test", digest: source.manifestDigest, commit: staged.commit, commitBytesDigest: staged.commitBytesDigest, parent: base.commit, manifestDigest: staged.manifestDigest }, manifest: staged.manifest, gitObjects: staged.objects })));
  assert.equal(validation.valid, true);
  const repeated = await repository.materialize(base, [{ id: "weft-test", source, base }], "weft-test", 1791970010);
  assert.equal(repeated.commit, staged.commit);
  fixture.objects[fixture.manifest.entries["server.mjs"].hash] = "subsequent live work";
  assert.equal(new TextDecoder().decode(await stored.store.get(staged.manifest.entries[0].digest)), "new\r\n");
});

test("acquisition rejects tampered roots, contents, missing blobs, extra blobs, and incorrect byte counts", async () => {
  const fixture = await retainedFixture({ "server.mjs": { text: "original\n" } });
  const hash = fixture.manifest.entries["server.mjs"].hash;
  for (const [mutate, error] of [
    [(path: string, value: any) => { if (path.startsWith("sync/revisions")) value.manifest.entries["server.mjs"].mode = 0o100755; return value; }, /WEFT_MANIFEST_ROOT_MISMATCH/],
    [(path: string, value: any) => { if (path === "sync-contents") value.objects[hash] = "modified\n"; return value; }, /WEFT_CONTENT_DIGEST_MISMATCH/],
    [(path: string, value: any) => { if (path === "sync-contents") delete value.objects[hash]; return value; }, /WEFT_INCOMPLETE_CONTENT/],
    [(path: string, value: any) => { if (path === "sync-contents") value.objects["a".repeat(64)] = "extra"; return value; }, /WEFT_INCOMPLETE_CONTENT/],
    [(path: string, value: any) => { if (path === "sync-contents") value.objects[hash] = "short"; return value; }, /WEFT_CONTENT_LENGTH_MISMATCH/],
    [(path: string, value: any) => { if (path.startsWith("sync/revisions")) value.manifest.bytes++; return value; }, /WEFT_MANIFEST_LENGTH_MISMATCH/],
  ] as const) await assert.rejects(acquireWeftSource(transformed(fixture.client, mutate), fixture.selection), error);
});

test("unsupported filesystem cases and unregistered workloads fail before contents are requested", async () => {
  for (const [files, error] of [
    [{ "link.mjs": { text: "target", mode: 0o120000 } }, /WEFT_UNSUPPORTED_ENTRY/],
    [{ "CON.mjs": { text: "content" } }, /DEVICE_PATH/],
    [{ ".weft/state": { text: "private" } }, /WEFT_UNSUPPORTED_PATH/],
    [{ ".env": { text: "private" } }, /WEFT_PRIVATE_PATH/],
    [{ "a.mjs": { text: "a" }, "A.mjs": { text: "A" } }, /COLLISION/],
    [{ "server.ts": { text: "export default 1" } }, /TYPESCRIPT_PROTECTED_PROFILE_UNREGISTERED/],
  ] as [Files, RegExp][]) {
    const fixture = await retainedFixture(files);
    await assert.rejects(acquireWeftSource(fixture.client, fixture.selection), error);
    assert.equal(fixture.calls.filter(call => call.path === "sync-contents").length, 0);
  }
});

test("batched acquisition binds one privacy generation and rechecks access after all bytes", async () => {
  const fixture = await retainedFixture(Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`file-${i}.mjs`, { text: `export default ${i};\n` }])));
  const source = await acquireWeftSource(fixture.client, fixture.selection);
  assert.equal(source.manifest.entries.length, 35);
  assert.deepEqual(fixture.calls.filter(call => call.body).map(call => (call.body!.hashes as string[]).length), [32, 3, 0]);
  await assert.rejects(acquireWeftSource(transformed(fixture.client, (path, value) => {
    if (path === "sync-contents") value.privacyGeneration++;
    return value;
  }), fixture.selection), /WEFT_CONTENT_SELECTION_MISMATCH/);
  const revoked: WeftSourceClient = { async fetch(path, init) {
    if (path === "sync-contents" && JSON.parse(String(init!.body)).hashes.length === 0) return new Response(null, { status: 403 });
    return fixture.client.fetch(path, init);
  } };
  await assert.rejects(acquireWeftSource(revoked, fixture.selection), /WEFT_ACCESS_DENIED/);
  await assert.rejects(acquireWeftSource(transformed(fixture.client, (path, value) => {
    if (path === "sync-contents" && Object.keys(value.objects).length === 0) value.privacyGeneration++;
    return value;
  }), fixture.selection), /WEFT_CONTENT_SELECTION_MISMATCH/);
});

test("empty selections are reauthorized and malformed JSON or binary content never passes", async () => {
  const empty = await retainedFixture({});
  const source = await acquireWeftSource(empty.client, empty.selection);
  assert.equal(source.contents.size, 0); assert.equal(empty.calls.length, 2);
  const malformed: WeftSourceClient = { async fetch() { return new Response('{"schema":"weft.sync-selection.v1","schema":"weft.sync-selection.v1"}'); } };
  await assert.rejects(acquireWeftSource(malformed, empty.selection), /WEFT_INVALID_RESPONSE/);
  const binary = await retainedFixture({ "binary.mjs": { text: "\0" } });
  await assert.rejects(acquireWeftSource(binary.client, binary.selection), /WEFT_UNSUPPORTED_CONTENT/);
  const invalidUtf8: WeftSourceClient = { async fetch() { return new Response(new Uint8Array([0xff])); } };
  await assert.rejects(acquireWeftSource(invalidUtf8, empty.selection), /WEFT_INVALID_RESPONSE/);
});

test("supported paths named like JavaScript prototype members retain their own exact entries", async () => {
  const files = Object.fromEntries([["__proto__", { text: "prototype-name\n" }], ["constructor", { text: "constructor-name\n" }]]);
  const fixture = await retainedFixture(files);
  const source = await acquireWeftSource(fixture.client, fixture.selection);
  assert.deepEqual(source.manifest.entries.map(entry => entry.path), ["__proto__", "constructor"]);
  for (const entry of source.manifest.entries) assert.equal(new TextDecoder().decode(source.contents.get(entry.digest)), files[entry.path].text);
  assert.equal(source.mapping.entries[0].weft.hash, fixture.manifest.entries["__proto__"].hash);
});

test("persistence rejects post-acquisition content mutation before the first write", async () => {
  const fixture = await retainedFixture({ "server.mjs": { text: "immutable\n" } });
  const source = await acquireWeftSource(fixture.client, fixture.selection);
  source.contents.values().next().value![0] = 120;
  const stored = objectStore();
  await assert.rejects(persistWeftSource(source, stored.store), /WEFT_CONTENT_DIGEST_MISMATCH/);
  assert.equal(stored.writes(), 0);
});

test("content batches honor the one MiB byte bound independently of the hash count", async () => {
  const fixture = await retainedFixture({
    "a.mjs": { text: "a".repeat(400 * 1024) },
    "b.mjs": { text: "b".repeat(400 * 1024) },
    "c.mjs": { text: "c".repeat(400 * 1024) },
  });
  const source = await acquireWeftSource(fixture.client, fixture.selection);
  assert.equal(source.contents.size, 3);
  assert.deepEqual(fixture.calls.filter(call => call.body).map(call => (call.body!.hashes as string[]).length), [2, 1, 0]);
  for (const call of fixture.calls.filter(call => call.body)) {
    const bytes = (call.body!.hashes as string[]).reduce((sum, hash) => sum + encoder.encode(fixture.objects[hash]).length, 0);
    assert.ok(bytes <= 1024 * 1024);
  }
});

test("source ceilings, wrong selections, unavailable content, and upstream redirects are rejected", async () => {
  const fixture = await retainedFixture({ "server.mjs": { text: "retained\n" } });
  await assert.rejects(acquireWeftSource(fixture.client, { ...fixture.selection, root: "f".repeat(64) }), /WEFT_INVALID_MANIFEST/);
  await assert.rejects(acquireWeftSource(fixture.client, { ...fixture.selection, privacyGeneration: 2 }), /WEFT_PRIVACY_GENERATION_CHANGED/);
  for (const [status, error] of [[401, /WEFT_ACCESS_DENIED/], [403, /WEFT_ACCESS_DENIED/], [404, /WEFT_REVISION_UNAVAILABLE/], [302, /WEFT_REDIRECT_DENIED/], [503, /WEFT_ACQUISITION_UNAVAILABLE/]] as const) {
    await assert.rejects(acquireWeftSource({ async fetch() { return new Response(null, { status }); } }, fixture.selection), error);
  }
  const large = await retainedFixture(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`file-${i}.mjs`, { text: String(i).repeat(512 * 1024) }])));
  await assert.rejects(acquireWeftSource(large.client, large.selection), /SOURCE_SIZE_LIMIT/);
  assert.equal(large.calls.length, 1, "total source limit rejects before transferring contents");
});

test("transient coordinator refusal during acquisition preserves retryability for the saved handoff", async () => {
  const fixture = await retainedFixture({ "server.mjs": { text: "retained\n" } });
  for (const status of [408, 429]) {
    const client: WeftSourceClient = { async fetch(path, init) {
      return path === "sync-contents" ? new Response(null, { status }) : fixture.client.fetch(path, init);
    } };
    await assert.rejects(acquireWeftSource(client, fixture.selection),
      (error: unknown) => error instanceof PlatformError && error.status === 503);
  }
  assert.equal((await acquireWeftSource(fixture.client, fixture.selection)).manifest.entries.length, 1);
});
