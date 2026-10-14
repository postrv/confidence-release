// SPDX-License-Identifier: Apache-2.0
// Offline comparison of the previous per-blob binding path with the current
// cloned-pack path. Timing excludes fixture construction and simulates R2 and
// Artifacts with local memory; binding-call counts are the portable result.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import * as git from "isomorphic-git";
import { Volume, createFsFromVolume } from "memfs";
import { initializeKernel } from "../../packages/protocol/src/node";
import { canonicalize, digest, encodeBase64, getKernel } from "../../packages/protocol/src/index";
import type { GitObject, ManifestEntry, SourceManifest } from "../../packages/protocol/src/types";
import { snapshotFromClonedRepository, type RepositorySnapshot } from "./artifacts";
import { ObjectStore, MAX_FILE_BYTES, MAX_MANIFEST_BYTES, MAX_SOURCE_BYTES } from "../shared/objects";
import { requireValue } from "../shared/errors";

const dir = "/repository";
const encoder = new TextEncoder();

async function fixture(count: number) {
  const fs = createFsFromVolume(new Volume());
  await fs.promises.mkdir(dir, { recursive: true });
  await git.init({ fs, dir, defaultBranch: "main" });
  const children: git.TreeEntry[] = [];
  const objectIds: string[] = [];
  for (let index = 0; index < count; index++) {
    const blob = encoder.encode(`export const file${index} = ${index};\n`);
    const oid = await git.writeBlob({ fs, dir, blob }); objectIds.push(oid);
    children.push({ path: `file-${String(index).padStart(4, "0")}.mjs`, mode: index % 2 ? "100755" : "100644", type: "blob", oid });
  }
  const src = await git.writeTree({ fs, dir, tree: children });
  const tree = await git.writeTree({ fs, dir, tree: [{ path: "src", mode: "040000", type: "tree", oid: src }] });
  const identity = { name: "Confidence benchmark", email: "benchmark@example.invalid", timestamp: 1791000000, timezoneOffset: 0 };
  const commit = await git.writeCommit({ fs, dir, commit: { tree, parent: [], author: identity, committer: identity, message: "Source benchmark\n" } });
  objectIds.push(src, tree, commit);
  const packed = await git.packObjects({ fs, dir, oids: objectIds, write: true });
  await git.indexPack({ fs, dir, filepath: `.git/objects/pack/${packed.filename}` });
  for (const oid of objectIds) await fs.promises.unlink(`${dir}/.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`);
  const readFile = fs.promises.readFile.bind(fs.promises);
  const reads = { count: 0 };
  fs.promises.readFile = async (...args: Parameters<typeof readFile>) => { reads.count++; return readFile(...args); };
  return { fs, commit, reads };
}

function store() {
  const data = new Map<string, Uint8Array>();
  const stats = { writes: 0 };
  const objects = new ObjectStore({
    async head(key: string) { return data.has(key) ? { size: data.get(key)!.length } : null; },
    async put(key: string, value: Uint8Array) { stats.writes++; if (!data.has(key)) data.set(key, value.slice()); return {}; },
    async get(key: string) { const bytes = data.get(key); return bytes ? { size: bytes.length, body: new Blob([bytes.slice().buffer]).stream() } : null; },
  } as unknown as R2Bucket);
  return { objects, stats };
}

// Prior loop for these supported fixtures, adapted only to normalize Node Buffer-backed Git bytes so
// the offline R2 mock hashes the same byte range as the Worker runtime.
async function previous(fs: git.FsClient, commitId: string, objects: ObjectStore, modeledArtifactsCalls: { count: number }): Promise<RepositorySnapshot> {
  const commit = await git.readCommit({ fs, dir, oid: commitId });
  requireValue(commit.commit.parent.length <= 1, "UNSUPPORTED_COMMIT_PARENTS");
  const closure = new Map<string, GitObject>();
  const rawCommit = new Uint8Array((await git.readObject({ fs, dir, oid: commitId, format: "content" })).object as Uint8Array);
  const retain = (oid: string, type: GitObject["type"], data: Uint8Array) => { closure.set(oid, { oid, type, dataBase64: encodeBase64(data) }); };
  retain(commitId, "commit", rawCommit);
  const entries: ManifestEntry[] = []; let size = 0;
  const walk = async (oid: string, prefix: string, depth: number): Promise<void> => {
    requireValue(depth <= 24, "TREE_DEPTH_LIMIT", 413);
    const raw = await git.readObject({ fs, dir, oid, format: "content" }); retain(oid, "tree", raw.object as Uint8Array);
    const tree = await git.readTree({ fs, dir, oid });
    for (const child of tree.tree) {
      const path = prefix ? `${prefix}/${child.path}` : child.path;
      if (child.type === "tree") { requireValue(child.mode === "040000", "UNSUPPORTED_GIT_MODE"); await walk(child.oid, path, depth + 1); continue; }
      requireValue(child.type === "blob" && (child.mode === "100644" || child.mode === "100755"), "UNSUPPORTED_GIT_MODE");
      modeledArtifactsCalls.count++;
      const bytes = new Uint8Array((await git.readBlob({ fs, dir, oid: child.oid })).blob);
      const blob = new Blob([bytes]);
      requireValue(blob.size <= MAX_FILE_BYTES, "FILE_SIZE_LIMIT", 413);
      const content = new Uint8Array(await blob.arrayBuffer());
      size += content.length;
      requireValue(size <= MAX_SOURCE_BYTES && entries.length < 2048, "SOURCE_SIZE_LIMIT", 413);
      const contentDigest = await objects.put(content);
      entries.push({ path, mode: child.mode, bytes: String(content.length), digest: contentDigest });
      retain(child.oid, "blob", content);
    }
  };
  await walk(commit.commit.tree, "", 0);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: "portable-ascii-v1", entries };
  const validation = JSON.parse(getKernel().validate_manifest(canonicalize(manifest))) as { valid: boolean; reason?: string };
  requireValue(validation.valid, validation.reason ?? "INVALID_MANIFEST");
  const manifestBytes = encoder.encode(canonicalize(manifest));
  requireValue(manifestBytes.length <= MAX_MANIFEST_BYTES, "MANIFEST_SIZE_LIMIT", 413);
  const manifestDigest = await objects.put(manifestBytes);
  const objectList = [...closure.values()].sort((a, b) => a.oid.localeCompare(b.oid));
  const commitBytesDigest = await objects.put(rawCommit);
  const exact = JSON.parse(getKernel().validate_git_source(canonicalize({ candidate: { id: commitId, digest: await digest(manifest), commit: commitId, commitBytesDigest, parent: commit.commit.parent[0] ?? "", manifestDigest }, manifest, gitObjects: objectList }))) as { valid: boolean; reason: string };
  requireValue(exact.valid, exact.reason);
  const objectsDigest = await objects.put(encoder.encode(canonicalize(objectList)));
  return { commit: commitId, parent: commit.commit.parent[0] ?? null, commitBytesDigest, manifest, manifestDigest, objects: objectList, objectsDigest };
}

await initializeKernel();
const results = [];
for (const count of [4, 100, 1000]) {
  const { fs, commit, reads } = await fixture(count);
  const oldStore = store(); const modeledArtifactsCalls = { count: 0 };
  const startOld = performance.now();
  const old = await previous(fs, commit, oldStore.objects, modeledArtifactsCalls);
  const oldMs = performance.now() - startOld; const oldFsReads = reads.count;
  const newStore = store(); reads.count = 0;
  const startNew = performance.now();
  const next = await snapshotFromClonedRepository(fs, dir, commit, newStore.objects);
  const newMs = performance.now() - startNew; const newFsReads = reads.count;
  assert.deepEqual(next, old);
  results.push({ files: count, snapshotEqual: true, previous: { localMs: Number(oldMs.toFixed(1)), modeledArtifactsReadBlobCalls: modeledArtifactsCalls.count, localFsReads: oldFsReads, r2Writes: oldStore.stats.writes }, batched: { localMs: Number(newMs.toFixed(1)), modeledArtifactsReadBlobCalls: 0, localFsReads: newFsReads, r2Writes: newStore.stats.writes } });
}
console.log(JSON.stringify({ scope: "One offline run per packed-Git fixture size with memfs and in-memory R2; no Cloudflare latency, clone transfer, or production Worker timing included. Artifacts readBlob call counts are modeled from the corresponding code paths, not provider observations.", results }, null, 2));
