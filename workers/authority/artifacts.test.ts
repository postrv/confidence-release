// SPDX-License-Identifier: Apache-2.0
import test, { before, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import * as git from "isomorphic-git";
import { Volume, createFsFromVolume } from "memfs";
import { initializeKernel } from "../../packages/protocol/src/node";
import { canonicalize, digest, getKernel } from "../../packages/protocol/src/index";
import type { SourceManifest } from "../../packages/protocol/src/types";
import { ObjectStore } from "../shared/objects";
import { ArtifactsRepository, buildReceivePack, gitHttp, parseReceivePack, snapshotFromClonedRepository, validateRemote, type RepositorySnapshot, type SourceProfile } from "./artifacts";

before(initializeKernel);
const remote = "https://" + "a".repeat(32) + ".artifacts.cloudflare.net/git/confidence/attempt-fixed.git";
const forkInfo = { name: "attempt-fixed", description: "Confidence attempt attempt-fixed from canonical", readOnly: false, remote };
const packetLine = (value: string) => `${(new TextEncoder().encode(value).length + 4).toString(16).padStart(4, "0")}${value}`;

function stalledGitResponse(context: TestContext): Promise<void> {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const signal = input instanceof Request ? input.signal : init?.signal;
    started();
    assert.ok(signal, "Git transfer must supply a cancellation signal");
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      // Headers and part of a body arrive, but the peer never finishes it.
      controller.enqueue(new TextEncoder().encode("0010"));
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    } }));
  });
  return ready;
}

function objectStore(): ObjectStore {
  const data = new Map<string, Uint8Array>();
  return new ObjectStore({
    async head(key: string) { return data.has(key) ? { size: data.get(key)!.length } : null; },
    async put(key: string, value: Uint8Array) { if (!data.has(key)) data.set(key, value.slice()); return {}; },
    async get(key: string) { const bytes = data.get(key); return bytes ? { size: bytes.length, body: new Blob([bytes.slice().buffer]).stream() } : null; },
  } as unknown as R2Bucket);
}

async function clonedFixture(files: { path: string; mode: string; bytes: Uint8Array }[], packed = false) {
  const fs = createFsFromVolume(new Volume()); const dir = "/repository";
  await fs.promises.mkdir(dir, { recursive: true });
  await git.init({ fs, dir, defaultBranch: "main" });
  const objectIds: string[] = [];
  const writeTree = async (items: typeof files): Promise<string> => {
    const children = new Map<string, typeof files>();
    for (const item of items) {
      const [first, ...rest] = item.path.split("/");
      const group = children.get(first) ?? []; group.push({ ...item, path: rest.join("/") }); children.set(first, group);
    }
    const entries: git.TreeEntry[] = [];
    for (const [name, group] of children) {
      const leaf = group[0]!;
      if (leaf.path) entries.push({ path: name, mode: "040000", type: "tree", oid: await writeTree(group) });
      else { const oid = await git.writeBlob({ fs, dir, blob: leaf.bytes }); objectIds.push(oid); entries.push({ path: name, mode: leaf.mode, type: "blob", oid }); }
    }
    const oid = await git.writeTree({ fs, dir, tree: entries }); objectIds.push(oid); return oid;
  };
  const tree = await writeTree(files);
  const identity = { name: "Confidence fixture", email: "fixture@example.invalid", timestamp: 1791000000, timezoneOffset: 0 };
  const commit = await git.writeCommit({ fs, dir, commit: { tree, parent: [], author: identity, committer: identity, message: "Source fixture\n" } });
  objectIds.push(commit);
  if (packed) {
    const packedObjects = await git.packObjects({ fs, dir, oids: [...new Set(objectIds)], write: true });
    await git.indexPack({ fs, dir, filepath: `.git/objects/pack/${packedObjects.filename}` });
    for (const oid of new Set(objectIds)) await fs.promises.unlink(`${dir}/.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`);
  }
  return { fs, dir, commit };
}

test("cloned Git source preserves exact bytes and modes while storing repeated blob OIDs once", async context => {
  const bytes = new Uint8Array([0, 255, 10, 128]);
  const { fs, dir, commit } = await clonedFixture([
    { path: "a.bin", mode: "100644", bytes },
    { path: "nested/b.bin", mode: "100755", bytes },
    { path: "nested/c.mjs", mode: "100644", bytes: new TextEncoder().encode("export default 7;\n") },
  ], true);
  const store = objectStore();
  const put = store.put.bind(store); let writes = 0;
  context.mock.method(store, "put", async (...args: Parameters<ObjectStore["put"]>) => { writes++; return put(...args); });
  const source = await snapshotFromClonedRepository(fs, dir, commit, store);
  assert.equal(source.commit, commit);
  assert.deepEqual(source.manifest.entries.map(entry => [entry.path, entry.mode, entry.bytes]), [
    ["a.bin", "100644", "4"], ["nested/b.bin", "100755", "4"], ["nested/c.mjs", "100644", "18"],
  ]);
  assert.deepEqual(await store.get(source.manifest.entries[0]!.digest), bytes);
  assert.equal(source.manifest.entries[0]!.digest, source.manifest.entries[1]!.digest);
  assert.equal(source.objects.filter(object => object.type === "blob").length, 2);
  assert.equal(writes, 5, "two distinct blobs and three source metadata objects are persisted");
  assert.equal(JSON.parse(getKernel().validate_git_source(canonicalize({ candidate: { id: commit, digest: await digest(source.manifest), commit, commitBytesDigest: source.commitBytesDigest, parent: "", manifestDigest: source.manifestDigest }, manifest: source.manifest, gitObjects: source.objects }))).valid, true);
});

test("cloned Git source rejects unsupported modes and oversized bytes before R2 persistence", async context => {
  for (const [mode, bytes, reason] of [
    ["120000", new TextEncoder().encode("target"), /UNSUPPORTED_GIT_MODE/],
    ["100644", new Uint8Array(1024 * 1024 + 1), /FILE_SIZE_LIMIT/],
  ] as const) {
    const { fs, dir, commit } = await clonedFixture([{ path: "bad.bin", mode, bytes }]);
    const store = objectStore(); let writes = 0;
    context.mock.method(store, "put", async () => { writes++; throw new Error("R2 persistence must not begin"); });
    await assert.rejects(snapshotFromClonedRepository(fs, dir, commit, store), reason);
    assert.equal(writes, 0);
  }
  const { fs, dir, commit } = await clonedFixture(Array.from({ length: 5 }, (_, index) => ({
    path: `large-${index}.bin`, mode: "100644", bytes: new Uint8Array(1024 * 1024),
  })));
  const store = objectStore(); let writes = 0;
  context.mock.method(store, "put", async () => { writes++; throw new Error("R2 persistence must not begin"); });
  await assert.rejects(snapshotFromClonedRepository(fs, dir, commit, store), /SOURCE_SIZE_LIMIT/);
  assert.equal(writes, 0);
});

test("unregistered TypeScript source cannot persist immutable R2 objects", async context => {
  const { fs, dir, commit } = await clonedFixture([{ path: "APP.TS", mode: "100644", bytes: new TextEncoder().encode("export const value = 1;\n") }], true);
  const store = objectStore(); let writes = 0;
  context.mock.method(store, "put", async () => { writes++; throw new Error("R2 persistence must not begin"); });
  await assert.rejects(snapshotFromClonedRepository(fs, dir, commit, store), /TYPESCRIPT_PROTECTED_PROFILE_UNREGISTERED/);
  assert.equal(writes, 0);
});

test("only the explicit registered source profile accepts TypeScript and the 16 MiB boundary", async context => {
  const bytes = new Uint8Array(1024 * 1024); bytes.set([0, 255, 128]);
  const files = Array.from({ length: 16 }, (_, index) => ({ path: `source-${index}.ts`, mode: index ? "100644" : "100755", bytes }));
  const { fs, dir, commit } = await clonedFixture(files, true);
  const store = objectStore(); const source = await snapshotFromClonedRepository(fs, dir, commit, store, "confidence-repository-v1");
  assert.equal(source.manifest.entries.reduce((total, entry) => total + Number(entry.bytes), 0), 16 * 1024 * 1024);
  assert.equal(source.manifest.entries[0]!.mode, "100755");
  assert.deepEqual(await store.get(source.manifest.entries[0]!.digest), bytes);
  const noWrites = objectStore(); let writes = 0;
  context.mock.method(noWrites, "put", async () => { writes++; throw new Error("R2 persistence must not begin"); });
  await assert.rejects(snapshotFromClonedRepository(fs, dir, commit, noWrites), /SOURCE_SIZE_LIMIT/);
  const oversized = await clonedFixture([...files, { path: "one-byte-over.bin", mode: "100644", bytes: new Uint8Array(1) }]);
  await assert.rejects(snapshotFromClonedRepository(oversized.fs, oversized.dir, oversized.commit, noWrites, "confidence-repository-v1"), /SOURCE_SIZE_LIMIT/);
  assert.equal(writes, 0);
});

test("the registered source profile retains regular-mode, per-file, entry-count and path restrictions", async context => {
  for (const [files, reason] of [
    [[{ path: "bad.ts", mode: "120000", bytes: new Uint8Array(1) }], /UNSUPPORTED_GIT_MODE/],
    [[{ path: "bad.ts", mode: "100644", bytes: new Uint8Array(1024 * 1024 + 1) }], /FILE_SIZE_LIMIT/],
    [[{ path: "CON.ts", mode: "100644", bytes: new Uint8Array(1) }], /PATH/],
    [Array.from({ length: 2049 }, (_, index) => ({ path: `file-${index}.ts`, mode: "100644", bytes: new Uint8Array(1) })), /SOURCE_SIZE_LIMIT/],
  ] as const) {
    const { fs, dir, commit } = await clonedFixture([...files]); const store = objectStore(); let writes = 0;
    context.mock.method(store, "put", async () => { writes++; throw new Error("R2 persistence must not begin"); });
    await assert.rejects(snapshotFromClonedRepository(fs, dir, commit, store, "confidence-repository-v1"), reason);
    assert.equal(writes, 0);
  }
});

test("unknown source profiles fail closed before Git, credentials, or persistence", async () => {
  const unknown = "unregistered-repository-v2" as SourceProfile;
  const store = objectStore(); const repository = new ArtifactsRepository({ async get() { throw new Error("No capability may be acquired"); } } as unknown as Artifacts, store);
  await assert.rejects(snapshotFromClonedRepository({} as git.FsClient, "/missing", "a".repeat(40), store, unknown), /UNREGISTERED_SOURCE_PROFILE/);
  await assert.rejects(repository.ingest("canonical", "main", "a".repeat(40), unknown), /UNREGISTERED_SOURCE_PROFILE/);
  await assert.rejects(repository.materialize({} as RepositorySnapshot, [], "candidate", 1000, unknown), /UNREGISTERED_SOURCE_PROFILE/);
});

test("legacy materialization cannot compose beyond its 4 MiB bound or admit TypeScript", async context => {
  const store = objectStore(), repository = new ArtifactsRepository({} as Artifacts, store);
  const base = await snapshot(store, { "source.mjs": "original" });
  const large = await snapshot(store, Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`${index}.mjs`, "x".repeat(1024 * 1024)])));
  const typescript = await snapshot(store, { "source.ts": "export default 1;" });
  let writes = 0; context.mock.method(store, "put", async () => { writes++; throw new Error("R2 persistence must not begin"); });
  for (const [source, reason] of [[large, /SOURCE_SIZE_LIMIT/], [typescript, /TYPESCRIPT_PROTECTED_PROFILE_UNREGISTERED/]] as const)
    await assert.rejects(repository.materialize(base, [{ id: "selection", source, base }], "candidate", 1000), reason);
  assert.equal(writes, 0);
});

test("cloned Git source rejects an object whose bytes no longer match its Git ID before R2 persistence", async context => {
  const { fs, dir, commit } = await clonedFixture([{ path: "source.mjs", mode: "100644", bytes: new TextEncoder().encode("safe") }]);
  const parsed = await git.readCommit({ fs, dir, oid: commit });
  const tree = await git.readTree({ fs, dir, oid: parsed.commit.tree });
  const oid = tree.tree[0]!.oid;
  const changed = new TextEncoder().encode("unsafe");
  const wrapped = new Uint8Array([...new TextEncoder().encode(`blob ${changed.length}\0`), ...changed]);
  await fs.promises.writeFile(`${dir}/.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`, deflateSync(wrapped));
  const store = objectStore(); let writes = 0;
  context.mock.method(store, "put", async () => { writes++; throw new Error("R2 persistence must not begin"); });
  await assert.rejects(snapshotFromClonedRepository(fs, dir, commit, store), /SHA check failed|GIT_OBJECT_IDENTITY/);
  assert.equal(writes, 0);
});

async function snapshot(store: ObjectStore, values: Record<string, string>): Promise<RepositorySnapshot> {
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: "portable-ascii-v1", entries: await Promise.all(Object.entries(values).sort(([a], [b]) => a < b ? -1 : 1).map(async ([path, value]) => {
    const bytes = new TextEncoder().encode(value);
    return { path, mode: "100644" as const, bytes: String(bytes.length), digest: await store.put(bytes) };
  })) };
  return { commit: "b".repeat(40), parent: null, commitBytesDigest: "sha256:" + "0".repeat(64), manifest, manifestDigest: await digest(manifest), objects: [], objectsDigest: "sha256:" + "1".repeat(64) };
}

test("materializer constructs deterministic exact Git closure from independent verified leaves", async () => {
  const store = objectStore(); const repository = new ArtifactsRepository({} as Artifacts, store);
  const base = await snapshot(store, { "a.mjs": "original A", "nested/b.mjs": "original B" });
  const a = await snapshot(store, { "a.mjs": "new A", "nested/b.mjs": "original B" });
  const b = await snapshot(store, { "a.mjs": "original A", "nested/b.mjs": "new B" });
  const selected = [{ id: "A", source: a, base }, { id: "B", source: b, base }];
  const result = await repository.materialize(base, selected, "candidate-fixed", 1000);
  const retry = await repository.materialize(base, selected, "candidate-fixed", 1000);
  assert.deepEqual(retry, result);
  assert.equal(result.parent, base.commit);
  assert.deepEqual(result.manifest.entries.map(entry => entry.digest), [a.manifest.entries[0]!.digest, b.manifest.entries[1]!.digest]);
  assert.equal(JSON.parse(getKernel().validate_git_source(canonicalize({ candidate: { id: "candidate-fixed", digest: await digest(result.manifest), commit: result.commit, commitBytesDigest: result.commitBytesDigest, parent: base.commit, manifestDigest: result.manifestDigest }, manifest: result.manifest, gitObjects: result.objects }))).valid, true);
  await assert.rejects(repository.materialize(base, [{ id: "A", source: a, base }, { id: "B", source: await snapshot(store, { "a.mjs": "incompatible A", "nested/b.mjs": "original B" }), base }], "overlap", 1000), /CONFLICT/);
});

test("receive-pack retains the admitted old/new values and parses only one complete acknowledgment", () => {
  const oldHead = "a".repeat(40); const newHead = "b".repeat(40); const ref = "refs/heads/main";
  const packet = buildReceivePack(oldHead, newHead, ref, new TextEncoder().encode("PACK"));
  assert.ok(new TextDecoder().decode(packet).includes(`${oldHead} ${newHead} ${ref}\0report-status\n0000PACK`));
  const line = (value: string) => `${(value.length + 4).toString(16).padStart(4, "0")}${value}`;
  const ack = new TextEncoder().encode(line("unpack ok\n") + line(`ok ${ref}\n`) + "0000");
  assert.equal(parseReceivePack(ack, ref).accepted, true);
  assert.equal(parseReceivePack(new TextEncoder().encode(line("unpack ok\n") + line(`ng ${ref} stale old value\n`) + "0000"), ref).accepted, false);
  assert.throws(() => parseReceivePack(new Uint8Array([...ack, 65]), ref), /INVALID_GIT_REPORT/);
  assert.throws(() => validateRemote("https://example.com/git/n/repo.git"), /UNTRUSTED_ARTIFACTS_REMOTE/);
});

test("lost fork response reconciles its fixed association and revokes orphan initial tokens", async () => {
  const revoked: string[] = [];
  let active = true;
  const existing = {
    [Symbol.dispose]() {},
    async info() { return forkInfo; },
    async listTokens() { return { total: 2, tokens: [{ id: "orphan-initial", state: active ? "active" : "revoked" }, { id: "old-revoked", state: "revoked" }] }; },
    async revokeToken(id: string) { revoked.push(id); active = false; return true; },
  };
  const repository = new ArtifactsRepository({ async get() { return existing; } } as unknown as Artifacts, objectStore());
  assert.equal((await repository.fork("canonical", "attempt-fixed")).name, "attempt-fixed");
  assert.deepEqual(revoked, ["orphan-initial"]);
  await assert.rejects(repository.fork("different-canonical", "attempt-fixed"), /FORK_ASSOCIATION_CONFLICT/);
  assert.deepEqual(revoked, ["orphan-initial"]);
});

test("fork reconciliation waits for a complete bounded revocation read-back", async () => {
  const tokens = Array.from({ length: 33 }, (_, index) => ({ id: `initial-${index}`, state: "active" }));
  let total = 34, revocations = 0, ignoreAcknowledgment = false, disposals = 0;
  const repository = new ArtifactsRepository({ async get() {
    let disposed = false;
    return {
      [Symbol.dispose]() { disposed = true; disposals++; },
      async info() { return forkInfo; },
      async listTokens() { await Promise.resolve(); assert.equal(disposed, false); return { total, tokens: tokens.map(token => ({ ...token })) }; },
      async revokeToken(id: string) { assert.equal(disposed, false); revocations++; if (!ignoreAcknowledgment) tokens.find(token => token.id === id)!.state = "revoked"; return true; },
    };
  } } as unknown as Artifacts, objectStore());
  await assert.rejects(repository.fork("canonical", "attempt-fixed"), /FORK_TOKEN_INVENTORY_INCOMPLETE/);
  assert.equal(revocations, 0);
  total = tokens.length;
  await assert.rejects(repository.fork("canonical", "attempt-fixed"), /INITIAL_TOKEN_REVOCATION_PENDING/);
  assert.equal(revocations, 32); assert.equal(tokens.filter(token => token.state === "active").length, 1);
  ignoreAcknowledgment = true;
  await assert.rejects(repository.fork("canonical", "attempt-fixed"), /INITIAL_TOKEN_REVOCATION_PENDING/);
  ignoreAcknowledgment = false;
  assert.deepEqual(await repository.fork("canonical", "attempt-fixed"), { name: "attempt-fixed", remote });
  assert.equal(disposals, 4); assert.equal(tokens.filter(token => token.state === "active").length, 0);
});

test("a fork still being prepared is retried by its identity before any replacement fork", async () => {
  let created = false, preparing = true, active = true, forks = 0;
  const repository = new ArtifactsRepository({ async get(name: string) {
    if (name === "canonical") return {
      [Symbol.dispose]() {},
      async fork(target: string, options: unknown) { forks++; created = true; assert.equal(target, "attempt-fixed"); assert.deepEqual(options, { readOnly: false, defaultBranchOnly: false, description: forkInfo.description }); return { ...forkInfo, token: "initial-plaintext" }; },
    };
    if (!created) throw Object.assign(new Error("Owned missing repository"), { code: "NOT_FOUND" });
    if (preparing) throw Object.assign(new Error("Owned fork pending"), { code: "FORK_IN_PROGRESS" });
    return {
      [Symbol.dispose]() {}, async info() { return forkInfo; },
      async listTokens() { return { total: 1, tokens: [{ id: "initial-id", state: active ? "active" : "revoked" }] }; },
      async revokeToken(id: string) { assert.equal(id, "initial-id"); active = false; return true; },
    };
  } } as unknown as Artifacts, objectStore());
  await assert.rejects(repository.fork("canonical", "attempt-fixed"), /Owned fork pending/);
  await assert.rejects(repository.fork("canonical", "attempt-fixed"), /Owned fork pending/);
  assert.equal(forks, 1);
  preparing = false;
  assert.equal((await repository.fork("canonical", "attempt-fixed")).remote, remote);
  assert.equal(active, false); assert.equal(forks, 1);
});

test("a ready fork revokes its initial plaintext token and releases both capabilities", async () => {
  let created = false, active = true;
  const revoked: string[] = [], disposed: string[] = [];
  const repository = new ArtifactsRepository({ async get(name: string) {
    if (name === "canonical") return {
      [Symbol.dispose]() { disposed.push("canonical"); },
      async fork() { created = true; return { ...forkInfo, token: "initial-plaintext" }; },
    };
    if (!created) throw Object.assign(new Error("Owned absent fork"), { code: "NOT_FOUND" });
    return {
      [Symbol.dispose]() { disposed.push("fork"); }, async info() { return forkInfo; },
      async revokeToken(token: string) { revoked.push(token); active = false; return true; },
      async listTokens() { return { total: 1, tokens: [{ id: "initial-id", state: active ? "active" : "revoked" }] }; },
    };
  } } as unknown as Artifacts, objectStore());
  assert.deepEqual(await repository.fork("canonical", "attempt-fixed"), { name: "attempt-fixed", remote });
  assert.deepEqual(revoked, ["initial-plaintext"]); assert.deepEqual(disposed, ["fork", "canonical"]);
});

test("a stalled Artifacts lookup releases a capability that arrives after its deadline", async () => {
  let resolveLookup!: (repo: unknown) => void, disposals = 0;
  const pending = new Promise<unknown>(resolve => { resolveLookup = resolve; });
  const repository = new ArtifactsRepository({ get: () => pending } as unknown as Artifacts, objectStore(), 20);
  await assert.rejects(repository.attemptPresent("canonical", "fixed", "attempt-fixed"), /ARTIFACTS_RPC_DEADLINE_EXCEEDED/);
  resolveLookup({ [Symbol.dispose]() { disposals++; }, async info() { throw new Error("Late capability must not be used"); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposals, 1);
});

test("a timed-out fork is reconciled by its fixed repository name without a second fork", async () => {
  let created = false, active = true, forks = 0;
  const repository = new ArtifactsRepository({ async get(name: string) {
    if (name === "canonical") return {
      [Symbol.dispose]() {},
      async fork() { created = true; forks++; return new Promise(() => {}); },
    };
    if (!created) throw Object.assign(new Error("Owned missing repository"), { code: "NOT_FOUND" });
    return {
      [Symbol.dispose]() {}, async info() { return forkInfo; },
      async listTokens() { return { total: 1, tokens: [{ id: "orphan", state: active ? "active" : "revoked" }] }; },
      async revokeToken(id: string) { assert.equal(id, "orphan"); active = false; return true; },
    };
  } } as unknown as Artifacts, objectStore(), 20);
  await assert.rejects(repository.fork("canonical", "attempt-fixed"), /ARTIFACTS_RPC_DEADLINE_EXCEEDED/);
  assert.deepEqual(await repository.fork("canonical", "attempt-fixed"), { name: "attempt-fixed", remote });
  assert.equal(forks, 1); assert.equal(active, false);
});

test("an uncertain fork waits for visibility and never dispatches again while lookup says absent", async () => {
  let visible = false, dispatched = false, forks = 0;
  const repository = new ArtifactsRepository({ async get(name: string) {
    if (name === "canonical") return { [Symbol.dispose]() {}, async fork() { forks++; return new Promise(() => {}); } };
    if (!visible) throw Object.assign(new Error("Fork not yet visible"), { code: "NOT_FOUND" });
    return { [Symbol.dispose]() {}, async info() { return forkInfo; },
      async listTokens() { return { total: 0, tokens: [] }; } };
  } } as unknown as Artifacts, objectStore(), 20);
  await assert.rejects(repository.fork("canonical", "attempt-fixed", {
    allowed: !dispatched, before: () => { dispatched = true; },
  }), /ARTIFACTS_RPC_DEADLINE_EXCEEDED/);
  assert.equal(dispatched, true); assert.equal(forks, 1);
  await assert.rejects(repository.fork("canonical", "attempt-fixed", { allowed: !dispatched }), /FORK_EFFECT_UNRESOLVED/);
  assert.equal(forks, 1);
  visible = true;
  assert.deepEqual(await repository.fork("canonical", "attempt-fixed", { allowed: !dispatched }), { name: "attempt-fixed", remote });
  assert.equal(forks, 1);
});

test("a failed durable fork fence prevents the external call", async () => {
  let forks = 0;
  const repository = new ArtifactsRepository({ async get(name: string) {
    if (name !== "canonical") throw Object.assign(new Error("Absent"), { code: "NOT_FOUND" });
    return { [Symbol.dispose]() {}, async fork() { forks++; throw new Error("Should not be called"); } };
  } } as unknown as Artifacts, objectStore());
  await assert.rejects(repository.fork("canonical", "attempt-fixed", { before: () => { throw new Error("Journal unavailable"); } }), /Journal unavailable/);
  assert.equal(forks, 0);
});

test("a late token inventory cannot begin revocation after its deadline", async () => {
  let resolveInventory!: (value: unknown) => void, revocations = 0;
  const inventory = new Promise<unknown>(resolve => { resolveInventory = resolve; });
  const repo = { [Symbol.dispose]() {}, async info() { return forkInfo; },
    listTokens: () => inventory, async revokeToken() { revocations++; return true; } };
  const repository = new ArtifactsRepository({ async get() { return repo; } } as unknown as Artifacts, objectStore(), 20, 50);
  await assert.rejects(repository.revokeAttemptCredentials("canonical", "fixed", "attempt-fixed"), /ARTIFACTS_RPC_DEADLINE_EXCEEDED/);
  resolveInventory({ total: 1, tokens: [{ id: "orphan", state: "active" }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(revocations, 0);
});

test("head observes the exact full Git branch and distinguishes an absent work ref", async context => {
  const calls: string[] = [], expected = "a".repeat(40), other = "b".repeat(40);
  const repository = new ArtifactsRepository({ async get() {
    calls.push("get");
    return {
      [Symbol.dispose]() { calls.push("dispose"); }, async info() { return forkInfo; },
      async log() { throw new Error("Binding log does not resolve full refs"); },
      async createToken(scope: string, ttl: number) { assert.equal(scope, "read"); assert.equal(ttl, 60); calls.push("mint"); return { plaintext: "owned-head-token" }; },
      async revokeToken(token: string) { assert.equal(token, "owned-head-token"); calls.push("revoke"); return true; },
    };
  } } as unknown as Artifacts, objectStore());
  context.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push("fetch"); assert.equal(String(url), `${remote}/info/refs?service=git-upload-pack`);
    assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "manual"); assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer owned-head-token");
    return new Response(packetLine("# service=git-upload-pack\n") + "0000" +
      packetLine(`${other} HEAD\0symref=HEAD:refs/heads/main-next\n`) +
      packetLine(`${other} refs/tags/main\n`) + packetLine(`${other} refs/heads/main-next\n`) +
      packetLine(`${expected} refs/heads/main\n`) + "0000", { headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
  });
  assert.equal(await repository.head("attempt-fixed", "refs/heads/main"), expected);
  assert.equal(await repository.head("attempt-fixed", "refs/heads/confidence-work"), null);
  assert.deepEqual(calls, ["get", "mint", "fetch", "revoke", "dispose", "get", "mint", "fetch", "revoke", "dispose"]);
  calls.length = 0;
  await assert.rejects(repository.head("attempt-fixed", "main"), /INVALID_CANONICAL_REF/);
  await assert.rejects(repository.head("attempt-fixed", "refs/tags/main"), /INVALID_CANONICAL_REF/);
  assert.deepEqual(calls, []);
});

test("head bounds the Git ref inventory and rejects invalid observed object IDs", async context => {
  let revocations = 0, disposals = 0;
  const repository = new ArtifactsRepository({ async get() { return {
    [Symbol.dispose]() { disposals++; }, async info() { return forkInfo; },
    async createToken() { return { plaintext: "owned-head-token" }; },
    async revokeToken() { revocations++; return true; },
  }; } } as unknown as Artifacts, objectStore());
  let advertisement = "";
  context.mock.method(globalThis, "fetch", async () => new Response(advertisement, { headers: { "content-type": "application/x-git-upload-pack-advertisement" } }));
  for (const oid of ["not-an-object-id", "0".repeat(40)]) {
    advertisement = packetLine("# service=git-upload-pack\n") + "0000" + packetLine(`${oid} refs/heads/main\0report-status\n`) + "0000";
    await assert.rejects(repository.head("attempt-fixed", "refs/heads/main"), /INVALID_GIT_REF_OID/);
  }
  advertisement = packetLine("# service=git-upload-pack\n") + "0000" +
    Array.from({ length: 8193 }, (_, index) => packetLine(`${"a".repeat(40)} refs/heads/branch-${index}${index === 0 ? "\0report-status" : ""}\n`)).join("") + "0000";
  await assert.rejects(repository.head("attempt-fixed", "refs/heads/main"), /GIT_REF_COUNT_LIMIT/);
  assert.equal(revocations, 3); assert.equal(disposals, 3);
});

test("head releases its read token and capability after a failed or stalled Git observation", async context => {
  const calls: string[] = [];
  const repository = new ArtifactsRepository({ async get() { return {
    [Symbol.dispose]() { calls.push("dispose"); }, async info() { return forkInfo; },
    async createToken() { calls.push("mint"); return { plaintext: "owned-head-token" }; },
    async revokeToken(token: string) { assert.equal(token, "owned-head-token"); calls.push("revoke"); return true; },
  }; } } as unknown as Artifacts, objectStore());
  context.mock.method(globalThis, "fetch", async () => { throw new Error("Owned head observation unavailable"); });
  await assert.rejects(repository.head("attempt-fixed", "refs/heads/main"), /Owned head observation unavailable/);
  assert.deepEqual(calls, ["mint", "revoke", "dispose"]);
  calls.length = 0;
  const deadline = new AbortController();
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => { assert.equal(milliseconds, 20_000); return deadline.signal; });
  const ready = stalledGitResponse(context);
  const reason = new DOMException("Owned head observation stalled", "TimeoutError");
  const rejected = assert.rejects(repository.head("attempt-fixed", "refs/heads/main"), error => error === reason);
  await ready; deadline.abort(reason); await rejected;
  assert.deepEqual(calls, ["mint", "revoke", "dispose"]);
});

test("Git broker bounds uploads before minting a token and scopes read requests narrowly", async context => {
  const calls: string[] = [];
  const token = "art_v1_" + "b".repeat(40) + "?expires=2000000000";
  const repository = new ArtifactsRepository({ async get() { return {
    [Symbol.dispose]() { calls.push("dispose"); }, async info() { return forkInfo; },
    async createToken(scope: string, ttl: number) { calls.push(`mint:${scope}:${ttl}`); return { plaintext: token }; },
    async revokeToken(value: string) { assert.equal(value, token); calls.push("revoke"); return true; },
  }; } } as unknown as Artifacts, objectStore());
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    assert.ok(input instanceof Request); calls.push("fetch");
    assert.equal(input.headers.get("authorization"), `Bearer ${token}`);
    assert.equal(input.headers.has("cookie"), false); assert.equal(input.redirect, "manual");
    return new Response("0000");
  });
  const response = await repository.gateway("attempt-fixed", new Request(`${remote}/info/refs?service=git-upload-pack`, { headers: { cookie: "owned-cookie" } }), true);
  assert.equal(await response.text(), "0000"); assert.deepEqual(calls, ["mint:read:60", "fetch", "revoke", "dispose"]);
  calls.length = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (let index = 0; index < 33; index++) controller.enqueue(chunk); controller.close(); } });
  const upload = new Request(`${remote}/git-receive-pack`, { method: "POST", body, duplex: "half" } as RequestInit);
  await assert.rejects(repository.gateway("attempt-fixed", upload, true), /SIZE_LIMIT/);
  assert.deepEqual(calls, ["dispose"]);
});

for (const transport of ["clone", "gateway"] as const) for (const cancellation of ["deadline", "caller"] as const) {
  test(`${transport} aborts a stalled response body on ${cancellation}`, async context => {
    const deadline = new AbortController(), caller = new AbortController(), calls: string[] = [];
    context.mock.method(AbortSignal, "timeout", (milliseconds: number) => { assert.equal(milliseconds, 20_000); return deadline.signal; });
    const ready = stalledGitResponse(context);
    const repository = new ArtifactsRepository({ async get() { return {
      [Symbol.dispose]() { calls.push("dispose"); }, async info() { return forkInfo; },
      async createToken() { calls.push("mint"); return { plaintext: "owned-read-token" }; },
      async revokeToken(token: string) { assert.equal(token, "owned-read-token"); calls.push("revoke"); return true; },
    }; } } as unknown as Artifacts, objectStore());
    const url = `${remote}/info/refs?service=git-upload-pack`;
    const result = transport === "clone" ? gitHttp(remote, "owned-read-token").request({ url, signal: caller.signal }) :
      repository.gateway("attempt-fixed", new Request(url, { signal: caller.signal }), false);
    const reason = new DOMException("Owned stalled transfer", cancellation === "deadline" ? "TimeoutError" : "AbortError");
    const rejected = assert.rejects(result, error => error === reason);
    await ready;
    (cancellation === "deadline" ? deadline : caller).abort(reason);
    await rejected;
    assert.deepEqual(calls, transport === "gateway" ? ["mint", "revoke", "dispose"] : []);
  });
}

test("fixed ref publication prepares retained bytes before minting and never substitutes a newer head", async context => {
  const store = objectStore(), order: string[] = [], ref = "refs/heads/main";
  const repository = new ArtifactsRepository({ async get() { return {
    [Symbol.dispose]() { order.push("dispose"); }, async info() { return forkInfo; },
    async createToken(scope: string, ttl: number) { order.push("mint"); assert.equal(scope, "write"); assert.equal(ttl, 60); return { plaintext: "owned-transfer-token" }; },
    async revokeToken(token: string) { order.push("revoke"); assert.equal(token, "owned-transfer-token"); return true; },
    async log() { throw new Error("Fixed publication must not substitute a current ref observation"); },
  }; } } as unknown as Artifacts, store);
  const base = await snapshot(store, { "a.mjs": "owned initial bytes" });
  const updated = await snapshot(store, { "a.mjs": "owned updated bytes" });
  const source = await repository.materialize(base, [{ id: "owned-change", source: updated, base }], "owned-publication", 1000);
  const get = store.get.bind(store);
  context.mock.method(store, "get", async (...args: Parameters<ObjectStore["get"]>) => { order.push("archive"); return get(...args); });
  context.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    order.push("fetch"); assert.equal(url, `${remote}/git-receive-pack`); assert.equal(init?.redirect, "manual");
    const command = new TextDecoder().decode(new Uint8Array(init!.body as ArrayBuffer));
    assert.ok(command.includes(`${base.commit} ${source.commit} ${ref}\0report-status\n`));
    return new Response(packetLine("unpack ok\n") + packetLine(`ok ${ref}\n`) + "0000");
  });
  assert.equal((await repository.conditionalPublish("canonical", { oldHead: base.commit, newHead: source.commit, canonicalRef: ref, objectsDigest: source.objectsDigest })).accepted, true);
  assert.deepEqual(order, ["archive", "mint", "fetch", "revoke", "dispose"]);
  order.length = 0;
  await assert.rejects(repository.conditionalPublish("canonical", { oldHead: "c".repeat(40), newHead: source.commit, canonicalRef: ref, objectsDigest: source.objectsDigest }), /PUBLICATION_MUST_BE_CHILD/);
  assert.deepEqual(order, ["archive", "dispose"]);
  order.length = 0;
  context.mock.method(globalThis, "fetch", async () => { order.push("fetch"); throw new Error("Owned transfer response unavailable"); });
  await assert.rejects(repository.conditionalPublish("canonical", { oldHead: base.commit, newHead: source.commit, canonicalRef: ref, objectsDigest: source.objectsDigest }), /Owned transfer response unavailable/);
  assert.deepEqual(order, ["archive", "mint", "fetch", "revoke", "dispose"]);
  order.length = 0;
  const deadline = new AbortController();
  context.mock.method(AbortSignal, "timeout", (milliseconds: number) => { assert.equal(milliseconds, 20_000); return deadline.signal; });
  const ready = stalledGitResponse(context);
  const reason = new DOMException("Owned publication response stalled", "TimeoutError");
  const rejected = assert.rejects(repository.conditionalPublish("canonical", { oldHead: base.commit, newHead: source.commit, canonicalRef: ref, objectsDigest: source.objectsDigest }), error => error === reason);
  await ready;
  deadline.abort(reason);
  await rejected;
  assert.deepEqual(order, ["archive", "mint", "revoke", "dispose"]);
});

test("Artifacts remotes follow documented host, namespace and repository naming", () => {
  assert.equal(validateRemote(remote).href, remote);
  for (const invalid of [remote.replace(".net/", ".net:8443/"), remote.replace("/confidence/", "/x/"), remote.replace("/confidence/", "/-invalid/"), remote.replace("/attempt-fixed.git", "/.hidden.git")]) {
    assert.throws(() => validateRemote(invalid), /UNTRUSTED_ARTIFACTS_REMOTE/);
  }
});
