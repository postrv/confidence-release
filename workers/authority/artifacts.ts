// SPDX-License-Identifier: Apache-2.0
import * as git from "isomorphic-git";
import { Volume, createFsFromVolume } from "memfs";
import { canonicalize, containsTypeScriptSource, digest, encodeBase64, decodeBase64, getKernel } from "../../packages/protocol/src/index";
import type { GitObject, SourceManifest, ManifestEntry } from "../../packages/protocol/src/types";
import { ObjectStore, MAX_SOURCE_BYTES, MAX_CONFIDENCE_REPOSITORY_SOURCE_BYTES, MAX_FILE_BYTES, MAX_MANIFEST_BYTES } from "../shared/objects";
import { digestBytes, readBounded, requireValue, PlatformError } from "../shared/errors";
import { withinDeadline } from "../shared/deadline";

export interface RepositorySnapshot {
  commit: string;
  parent: string | null;
  commitBytesDigest: string;
  manifest: SourceManifest;
  manifestDigest: string;
  objects: GitObject[];
  objectsDigest: string;
}

export interface FixedPublication { oldHead: string; newHead: string; canonicalRef: string; objectsDigest: string }

/** An internal consumer capability, never an enrollment or execution authorization. */
export type SourceProfile = "confidence-repository-v1";

function sourceProfileLimit(profile: SourceProfile | undefined): number {
  requireValue(profile === undefined || profile === "confidence-repository-v1", "UNREGISTERED_SOURCE_PROFILE", 409);
  return profile === "confidence-repository-v1" ? MAX_CONFIDENCE_REPOSITORY_SOURCE_BYTES : MAX_SOURCE_BYTES;
}

const MAX_GIT_TRANSFER = 32 * 1024 * 1024;
const GIT_TRANSFER_TIMEOUT_MS = 20_000;
const MAX_OBJECTS = 8192;
const MAX_GIT_REFS = 8192;
const MAX_GIT_STORAGE = 64 * 1024 * 1024;
const MAX_TOKEN_INVENTORY = 4096;
const TOKEN_REVOCATION_BATCH = 32;
const ARTIFACTS_RPC_TIMEOUT_MS = 5000;
const TOKEN_INVENTORY_TIMEOUT_MS = 20_000;
const ARTIFACTS_RPC_DEADLINE = "ARTIFACTS_RPC_DEADLINE_EXCEEDED";

export function validateRemote(remote: string): URL {
  const url = new URL(remote);
  requireValue(url.protocol === "https:" && !url.port && /^[a-f0-9]{32}\.artifacts\.cloudflare\.net$/.test(url.hostname) &&
    /^\/git\/[a-zA-Z0-9][a-zA-Z0-9_.-]{1,62}\/[a-zA-Z0-9][a-zA-Z0-9_.-]*\.git$/.test(url.pathname) && !url.username && !url.password && !url.search && !url.hash,
  "UNTRUSTED_ARTIFACTS_REMOTE");
  return url;
}

export function validateCanonicalRef(ref: string): void {
  requireValue(typeof ref === "string" && ref.startsWith("refs/heads/") && ref.length <= 160, "INVALID_CANONICAL_REF");
  const branch = ref.slice("refs/heads/".length);
  requireValue(branch.split("/").every(component => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(component) && !component.includes("..") && !component.endsWith(".") && !component.endsWith(".lock")), "INVALID_CANONICAL_REF");
}

function memoryRepository() {
  const fs = createFsFromVolume(new Volume());
  let allocated = 0;
  const original = fs.promises.writeFile.bind(fs.promises);
  fs.promises.writeFile = async (...args: Parameters<typeof original>) => {
    const data = args[1];
    allocated += typeof data === "string" ? new TextEncoder().encode(data).length :
      data instanceof Uint8Array ? data.byteLength : 0;
    requireValue(allocated <= MAX_GIT_STORAGE, "GIT_STORAGE_LIMIT", 413);
    return original(...args);
  };
  return fs;
}

function gitTransferSignal(caller?: AbortSignal): AbortSignal {
  // The same deadline remains attached while the response body is consumed.
  // An aborted write is uncertain; callers retain its fixed old/new identity.
  const deadline = AbortSignal.timeout(GIT_TRANSFER_TIMEOUT_MS);
  return caller ? AbortSignal.any([caller, deadline]) : deadline;
}

/** Build an exact source closure from the single, already-fetched Git pack. The caller must first prove HEAD equals expectedCommit. */
export async function snapshotFromClonedRepository(fs: git.FsClient, dir: string, expectedCommit: string, objects: ObjectStore, profile?: SourceProfile): Promise<RepositorySnapshot> {
  const sourceLimit = sourceProfileLimit(profile);
  requireValue(/^[a-f0-9]{40}$/.test(expectedCommit), "INVALID_GIT_OID");
  // isomorphic-git caches the pack index and pack bytes on this operation-local
  // object. Without it, each blob read reopens those files after the clone.
  const cache = {};
  const commit = await git.readCommit({ fs, dir, oid: expectedCommit, cache });
  requireValue(commit.commit.parent.length <= 1, "UNSUPPORTED_COMMIT_PARENTS");
  const rawCommit = await git.readObject({ fs, dir, oid: expectedCommit, format: "content", cache });
  requireValue(rawCommit.type === "commit", "INVALID_GIT_OBJECT_TYPE");
  // Normalize Buffer-backed local Git reads before hashing/persisting; Buffer.slice()
  // otherwise retains its backing slab instead of making a bounded byte copy.
  const commitBytes = new Uint8Array(rawCommit.object as Uint8Array);
  const closure = new Map<string, GitObject>();
  const blobs = new Map<string, { bytes: Uint8Array; digest: string }>();
  const trees = new Map<string, Awaited<ReturnType<typeof git.readTree>>["tree"]>();
  const retain = (oid: string, type: GitObject["type"], data: Uint8Array) => {
    if (closure.has(oid)) return;
    requireValue(closure.size < MAX_OBJECTS, "OBJECT_COUNT_LIMIT", 413);
    closure.set(oid, { oid, type, dataBase64: encodeBase64(data) });
  };
  retain(expectedCommit, "commit", commitBytes);
  const entries: ManifestEntry[] = [];
  let size = 0;
  const walk = async (oid: string, prefix: string, depth: number): Promise<void> => {
    requireValue(depth <= 24, "TREE_DEPTH_LIMIT", 413);
    let tree = trees.get(oid);
    if (!tree) {
      const raw = await git.readObject({ fs, dir, oid, format: "content", cache });
      requireValue(raw.type === "tree", "INVALID_GIT_OBJECT_TYPE");
      retain(oid, "tree", raw.object as Uint8Array);
      tree = (await git.readTree({ fs, dir, oid, cache })).tree;
      trees.set(oid, tree);
    }
    for (const child of tree) {
      const path = prefix ? `${prefix}/${child.path}` : child.path;
      if (child.type === "tree") { requireValue(child.mode === "040000", "UNSUPPORTED_GIT_MODE"); await walk(child.oid, path, depth + 1); continue; }
      requireValue(child.type === "blob" && (child.mode === "100644" || child.mode === "100755"), "UNSUPPORTED_GIT_MODE");
      requireValue(entries.length < 2048, "SOURCE_SIZE_LIMIT", 413);
      let blob = blobs.get(child.oid);
      if (!blob) {
        const raw = await git.readObject({ fs, dir, oid: child.oid, format: "content", cache });
        requireValue(raw.type === "blob", "INVALID_GIT_OBJECT_TYPE");
        const bytes = new Uint8Array(raw.object as Uint8Array);
        requireValue(bytes.length <= MAX_FILE_BYTES, "FILE_SIZE_LIMIT", 413);
        blob = { bytes, digest: await digestBytes(bytes) };
        blobs.set(child.oid, blob);
        retain(child.oid, "blob", bytes);
      }
      size += blob.bytes.length;
      requireValue(size <= sourceLimit, "SOURCE_SIZE_LIMIT", 413);
      entries.push({ path, mode: child.mode, bytes: String(blob.bytes.length), digest: blob.digest });
    }
  };
  await walk(commit.commit.tree, "", 0);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: "portable-ascii-v1", entries };
  const validation = JSON.parse(getKernel().validate_manifest(canonicalize(manifest))) as { valid: boolean; reason?: string };
  requireValue(validation.valid, validation.reason ?? "INVALID_MANIFEST");
  const manifestBytes = new TextEncoder().encode(canonicalize(manifest));
  requireValue(manifestBytes.length <= MAX_MANIFEST_BYTES, "MANIFEST_SIZE_LIMIT", 413);
  const manifestDigest = await digestBytes(manifestBytes);
  const commitBytesDigest = await digestBytes(commitBytes);
  const objectList = [...closure.values()].sort((a, b) => a.oid.localeCompare(b.oid));
  const exact = JSON.parse(getKernel().validate_git_source(canonicalize({ candidate: { id: expectedCommit, digest: await digest(manifest), commit: expectedCommit, commitBytesDigest, parent: commit.commit.parent[0] ?? "", manifestDigest }, manifest, gitObjects: objectList }))) as { valid: boolean; reason: string };
  requireValue(exact.valid, exact.reason);
  requireValue(profile === "confidence-repository-v1" || !containsTypeScriptSource(manifest), "TYPESCRIPT_PROTECTED_PROFILE_UNREGISTERED", 409);
  const objectListBytes = new TextEncoder().encode(canonicalize(objectList));
  const objectsDigest = await digestBytes(objectListBytes);
  // No R2 persistence begins until the complete bounded Git/source validation passes.
  for (const blob of blobs.values()) await objects.put(blob.bytes, blob.digest);
  await objects.put(manifestBytes, manifestDigest);
  await objects.put(commitBytes, commitBytesDigest);
  await objects.put(objectListBytes, objectsDigest);
  return { commit: expectedCommit, parent: commit.commit.parent[0] ?? null,
    commitBytesDigest, manifest, manifestDigest, objects: objectList, objectsDigest };
}

/** Bounded HTTP, fixed destination, no redirects, credential injection outside candidate execution. */
export function gitHttp(remote: string, token: string): git.HttpClient {
  const root = validateRemote(remote);
  let transferred = 0;
  return {
    async request({ url, method, headers, body, signal }) {
      const target = new URL(url);
      requireValue(target.origin === root.origin && target.pathname.startsWith(`${root.pathname}/`), "GIT_ROUTE_DENIED", 403);
      const requestHeaders = new Headers(headers);
      requestHeaders.delete("cookie"); requestHeaders.set("authorization", `Bearer ${token}`);
      const chunks: Uint8Array[] = [];
      let requestBytes = 0;
      if (body) for await (const chunk of body) { requestBytes += chunk.byteLength; requireValue(requestBytes <= MAX_GIT_TRANSFER, "SIZE_LIMIT", 413); chunks.push(chunk); }
      const payload = new Uint8Array(requestBytes);
      let offset = 0; for (const chunk of chunks) { payload.set(chunk, offset); offset += chunk.byteLength; }
      const response = await fetch(target, { method, headers: requestHeaders, body: requestBytes ? payload.slice().buffer : undefined, redirect: "manual", signal: gitTransferSignal(signal) });
      requireValue(response.status < 300 || response.status >= 400, "GIT_REDIRECT_DENIED", 502);
      const bytes = await readBounded(response.body, MAX_GIT_TRANSFER - transferred);
      transferred += bytes.length;
      return { url, method: method ?? "GET", statusCode: response.status, statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers.entries()), body: (async function* () { yield bytes; })() };
    },
  };
}

export class ArtifactsRepository {
  constructor(private readonly artifacts: Artifacts, private readonly objects: ObjectStore,
    private readonly rpcTimeoutMs = ARTIFACTS_RPC_TIMEOUT_MS,
    private readonly inventoryTimeoutMs = TOKEN_INVENTORY_TIMEOUT_MS) {}

  private binding<T>(operation: () => Promise<T>, expires?: number): Promise<T> {
    const remaining = expires === undefined ? this.rpcTimeoutMs : Math.min(this.rpcTimeoutMs, expires - Date.now());
    // Artifacts RPCs have no AbortSignal. A timeout is an uncertain result;
    // the caller's durable operation identity remains fixed for observation.
    return withinDeadline(operation, remaining, ARTIFACTS_RPC_DEADLINE);
  }

  private async get(name: string): Promise<ArtifactsRepo> {
    const pending = Promise.resolve().then(() => this.artifacts.get(name));
    try { return await this.binding(() => pending); }
    catch (error) {
      // A late capability cannot be reached by the caller's `using` block.
      // Dispose it if the lookup eventually succeeds after the deadline.
      void pending.then(repo => { try { repo[Symbol.dispose](); } catch { /* best effort */ } }, () => {});
      throw error;
    }
  }

  async identity(name: string): Promise<string> {
    using repo = await this.get(name);
    const info = await this.binding(() => repo.info());
    requireValue(typeof info.id === "string" && info.id.length > 0, "REPOSITORY_IDENTITY_UNAVAILABLE", 503);
    return info.id;
  }

  private async revokeActiveTokens(repo: ArtifactsRepo, inventoryError: string): Promise<boolean> {
    const expires = Date.now() + this.inventoryTimeoutMs;
    const inventory = async () => {
      const result = await this.binding(() => repo.listTokens(), expires);
      // listTokens exposes no cursor. A partial response cannot establish that
      // every initial/session credential has been revoked.
      requireValue(Number.isSafeInteger(result.total) && result.total >= 0 && result.total === result.tokens.length && result.total <= MAX_TOKEN_INVENTORY && new Set(result.tokens.map(token => token.id)).size === result.total, inventoryError, 409);
      return result.tokens;
    };
    const before = await inventory();
    for (const token of before.filter(token => token.state === "active").slice(0, TOKEN_REVOCATION_BATCH)) await this.binding(() => repo.revokeToken(token.id), expires);
    // A false revoke acknowledgment means not found, not necessarily failure.
    // Read back metadata to establish that no active credentials remain.
    return (await inventory()).every(token => token.state === "expired" || token.state === "revoked");
  }

  private cleanupName(canonicalName: string, attemptId: string, attemptName: string) {
    requireValue(/^[a-zA-Z0-9_-]{1,128}$/.test(attemptId) && attemptName === `attempt-${attemptId}` && attemptName !== canonicalName, "CLEANUP_REPOSITORY_DENIED", 403);
    return `Confidence attempt ${attemptName} from ${canonicalName}`;
  }

  async attemptPresent(canonicalName: string, attemptId: string, attemptName: string): Promise<boolean> {
    const association = this.cleanupName(canonicalName, attemptId, attemptName);
    try {
      using repo = await this.get(attemptName);
      const info = await this.binding(() => repo.info());
      requireValue(info.name === attemptName && info.description === association, "CLEANUP_ASSOCIATION_CONFLICT", 409);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "NOT_FOUND") return false;
      throw error;
    }
  }

  async revokeAttemptCredentials(canonicalName: string, attemptId: string, attemptName: string): Promise<boolean> {
    if (!await this.attemptPresent(canonicalName, attemptId, attemptName)) return true;
    using repo = await this.get(attemptName);
    const association = this.cleanupName(canonicalName, attemptId, attemptName);
    const info = await this.binding(() => repo.info()); requireValue(info.name === attemptName && info.description === association, "CLEANUP_ASSOCIATION_CONFLICT", 409);
    return await this.revokeActiveTokens(repo, "CLEANUP_TOKEN_INVENTORY_INCOMPLETE");
  }

  async deleteAttempt(canonicalName: string, attemptId: string, attemptName: string): Promise<boolean> {
    if (!await this.attemptPresent(canonicalName, attemptId, attemptName)) return false;
    // An acknowledgment remains separate from a later metadata absence read.
    return this.binding(() => this.artifacts.delete(attemptName));
  }

  async head(name: string, ref: string): Promise<string | null> {
    validateCanonicalRef(ref);
    using repo = await this.get(name);
    const info = await this.binding(() => repo.info());
    validateRemote(info.remote);
    const token = await this.binding(() => repo.createToken("read", 60));
    try {
      // The binding log API resolves short branch names, but not full refs.
      // Git discovery preserves the branch identity even when a tag has the
      // same short name. This observation never changes a fixed publication.
      const refs = await git.listServerRefs({ http: gitHttp(info.remote, token.plaintext), url: info.remote, protocolVersion: 1 });
      requireValue(refs.length <= MAX_GIT_REFS, "GIT_REF_COUNT_LIMIT", 413);
      const matches = refs.filter(entry => entry.ref === ref);
      requireValue(matches.length <= 1, "AMBIGUOUS_GIT_REF", 502);
      const head = matches[0]?.oid;
      requireValue(head === undefined || /^[a-f0-9]{40}$/.test(head) && head !== "0".repeat(40), "INVALID_GIT_REF_OID", 502);
      return head ?? null;
    } finally { await this.binding(() => repo.revokeToken(token.plaintext)); }
  }

  async fork(canonicalName: string, attemptName: string, dispatch: { allowed?: boolean; before?: () => void } = {}): Promise<{ name: string; remote: string }> {
    const association = `Confidence attempt ${attemptName} from ${canonicalName}`;
    // Names are deterministic. A lost fork response is reconciled by the same external identity.
    try {
      using existing = await this.get(attemptName);
      const info = await this.binding(() => existing.info());
      requireValue(info.name === attemptName && info.description === association && !info.readOnly, "FORK_ASSOCIATION_CONFLICT", 409);
      validateRemote(info.remote);
      // This reconciliation runs only before the authority's durable provisioning
      // marker. A lost fork response must not leave its initial bearer active.
      requireValue(await this.revokeActiveTokens(existing, "FORK_TOKEN_INVENTORY_INCOMPLETE"), "INITIAL_TOKEN_REVOCATION_PENDING", 503);
      return { name: attemptName, remote: info.remote };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "NOT_FOUND") throw error;
    }
    // A previously dispatched fork may still be invisible to get(). Retrying
    // an absent observation must not dispatch another native fork.
    requireValue(dispatch.allowed !== false, "FORK_EFFECT_UNRESOLVED", 503);
    using repo = await this.get(canonicalName);
    // The caller persists this fence synchronously before the external RPC.
    // If persistence fails, no fork call may begin.
    dispatch.before?.();
    const created = await this.binding(() => repo.fork(attemptName, { readOnly: false, defaultBranchOnly: false, description: association }));
    requireValue(created.name === attemptName, "FORK_ASSOCIATION_CONFLICT", 409); validateRemote(created.remote);
    using fork = await this.get(attemptName);
    const info = await this.binding(() => fork.info());
    requireValue(info.name === attemptName && info.description === association && info.remote === created.remote && !info.readOnly, "FORK_ASSOCIATION_CONFLICT", 409);
    // Initial create/fork tokens never enter an authoring container.
    await this.binding(() => fork.revokeToken(created.token));
    requireValue(await this.revokeActiveTokens(fork, "FORK_TOKEN_INVENTORY_INCOMPLETE"), "INITIAL_TOKEN_REVOCATION_PENDING", 503);
    return { name: created.name, remote: created.remote };
  }

  async gateway(name: string, request: Request, writable: boolean): Promise<Response> {
    using repo = await this.get(name);
    const info = await this.binding(() => repo.info());
    const root = validateRemote(info.remote);
    const target = new URL(request.url);
    const service = target.searchParams.get("service");
    const read = request.method === "GET" && target.pathname === `${root.pathname}/info/refs` && target.search === "?service=git-upload-pack" ||
      request.method === "POST" && target.pathname === `${root.pathname}/git-upload-pack` && !target.search;
    const write = request.method === "GET" && target.pathname === `${root.pathname}/info/refs` && service === "git-receive-pack" && target.search === "?service=git-receive-pack" ||
      request.method === "POST" && target.pathname === `${root.pathname}/git-receive-pack` && !target.search;
    requireValue(target.origin === root.origin && !target.username && !target.password && (read || writable && write), "GIT_ROUTE_DENIED", 403);
    // Bound upload bytes before granting a token or sending the Git request.
    const requestBody = request.method === "POST" ? await readBounded(request.body, MAX_GIT_TRANSFER) : null;
    const token = await this.binding(() => repo.createToken(write ? "write" : "read", 60));
    try {
      const headers = new Headers(request.headers);
      for (const name of ["authorization", "cookie", "x-platform-owner", "x-attempt-id", "x-project-id"]) headers.delete(name);
      headers.set("authorization", `Bearer ${token.plaintext}`); headers.set("accept-encoding", "identity"); headers.delete("content-length");
      const response = await fetch(new Request(request.url, { method: request.method, headers, body: requestBody?.slice().buffer, signal: gitTransferSignal(request.signal), redirect: "manual" }));
      requireValue(response.status < 300 || response.status >= 400, "GIT_REDIRECT_DENIED", 502);
      const body = await readBounded(response.body, MAX_GIT_TRANSFER); const responseHeaders = new Headers(response.headers); responseHeaders.delete("content-length");
      return new Response(body.slice().buffer, { status: response.status, statusText: response.statusText, headers: responseHeaders });
    } finally { await this.binding(() => repo.revokeToken(token.plaintext)); }
  }

  async ingest(name: string, ref: string, expectedCommit: string, profile?: SourceProfile): Promise<RepositorySnapshot> {
    sourceProfileLimit(profile);
    requireValue(/^[a-f0-9]{40}$/.test(expectedCommit), "INVALID_GIT_OID");
    using repo = await this.get(name);
    const info = await this.binding(() => repo.info());
    const token = await this.binding(() => repo.createToken("read", 60));
    const fs = memoryRepository();
    const dir = "/repository";
    try {
      await git.clone({ fs, dir, http: gitHttp(info.remote, token.plaintext), url: info.remote, ref, singleBranch: true, depth: 1, noCheckout: true });
      const tip = await git.resolveRef({ fs, dir, ref: "HEAD" });
      requireValue(tip === expectedCommit, "SUBMISSION_REF_MOVED", 409);
      return await snapshotFromClonedRepository(fs, dir, expectedCommit, this.objects, profile);
    } finally { await this.binding(() => repo.revokeToken(token.plaintext)); }
  }

  /** Compose verified leaf identities; imported source is never executed by this service. */
  async materialize(base: RepositorySnapshot, sources: { id: string; source: Pick<RepositorySnapshot, "manifest">; base: Pick<RepositorySnapshot, "manifest"> }[], candidateId: string, timestamp: number, profile?: SourceProfile): Promise<RepositorySnapshot> {
    const sourceLimit = sourceProfileLimit(profile);
    const transplanted = sources.map(item => {
      const result = JSON.parse(getKernel().transplant_manifest(canonicalize({ originalBase: item.base.manifest, desired: item.source.manifest, currentBase: base.manifest }))) as { accepted: boolean; manifest: SourceManifest; reason: string };
      requireValue(result.accepted, result.reason, 409);
      return { id: item.id, manifest: result.manifest };
    });
    const combined = JSON.parse(getKernel().compose_manifests(canonicalize({ base: base.manifest, submissions: transplanted }))) as { accepted: boolean; manifest: SourceManifest; reason: string };
    requireValue(combined.accepted, combined.reason, 409);
    requireValue(combined.manifest.entries.reduce((total, entry) => total + Number(entry.bytes), 0) <= sourceLimit, "SOURCE_SIZE_LIMIT", 413);
    requireValue(profile === "confidence-repository-v1" || !containsTypeScriptSource(combined.manifest), "TYPESCRIPT_PROTECTED_PROFILE_UNREGISTERED", 409);
    const fs = memoryRepository(); const dir = "/materialization"; await git.init({ fs, dir });
    const objects = new Map<string, GitObject>();
    const retain = async (oid: string, type: GitObject["type"]) => {
      const raw = await git.readObject({ fs, dir, oid, format: "content" });
      requireValue(raw.object instanceof Uint8Array, "GIT_OBJECT_FORMAT");
      objects.set(oid, { oid, type, dataBase64: encodeBase64(raw.object) });
    };
    interface Directory { files: { path: string; mode: "100644" | "100755"; oid: string }[]; directories: Map<string, Directory> }
    const root: Directory = { files: [], directories: new Map() };
    for (const entry of combined.manifest.entries) {
      const content = await this.objects.get(entry.digest, MAX_FILE_BYTES);
      requireValue(String(content.length) === entry.bytes, "MANIFEST_LENGTH_MISMATCH");
      const oid = await git.writeBlob({ fs, dir, blob: content }); await retain(oid, "blob");
      const parts = entry.path.split("/"); let cursor = root;
      for (const component of parts.slice(0, -1)) { let next = cursor.directories.get(component); if (!next) { next = { files: [], directories: new Map() }; cursor.directories.set(component, next); } cursor = next; }
      cursor.files.push({ path: parts.at(-1)!, mode: entry.mode, oid });
    }
    const writeTree = async (directory: Directory): Promise<string> => {
      const tree: git.TreeEntry[] = directory.files.map(file => ({ ...file, type: "blob" }));
      for (const [path, child] of directory.directories) tree.push({ path, type: "tree", mode: "040000", oid: await writeTree(child) });
      const oid = await git.writeTree({ fs, dir, tree }); await retain(oid, "tree"); return oid;
    };
    const tree = await writeTree(root);
    const identity = { name: "Confidence materializer", email: "materializer@confidence.invalid", timestamp, timezoneOffset: 0 };
    const commit = await git.writeCommit({ fs, dir, commit: { tree, parent: [base.commit], author: identity, committer: identity, message: `Integrate candidate ${candidateId}\n` } });
    await retain(commit, "commit");
    const manifestDigest = await this.objects.put(new TextEncoder().encode(canonicalize(combined.manifest)));
    const objectList = [...objects.values()].sort((a, b) => a.oid.localeCompare(b.oid));
    const commitBytesDigest = await this.objects.put(decodeBase64(objects.get(commit)!.dataBase64));
    const validation = JSON.parse(getKernel().validate_git_source(canonicalize({ candidate: { id: candidateId, digest: await digest({ commit, manifestDigest }), commit, commitBytesDigest, parent: base.commit, manifestDigest }, manifest: combined.manifest, gitObjects: objectList }))) as { valid: boolean; reason: string };
    requireValue(validation.valid, validation.reason);
    return { commit, parent: base.commit, manifest: combined.manifest, manifestDigest, objects: objectList,
      objectsDigest: await this.objects.put(new TextEncoder().encode(canonicalize(objectList))), commitBytesDigest };
  }

  async conditionalPublish(name: string, operation: FixedPublication): Promise<{ accepted: boolean; report: string }> {
    return this.writeFixedRef(name, operation, true);
  }

  async installWorkRef(name: string, source: RepositorySnapshot): Promise<void> {
    const ref = "refs/heads/confidence-work";
    const current = await this.head(name, ref);
    if (current === source.commit) return;
    requireValue(current === null, "WORK_REF_ASSOCIATION_CONFLICT", 409);
    const result = await this.writeFixedRef(name, { oldHead: "0".repeat(40), newHead: source.commit, canonicalRef: ref, objectsDigest: source.objectsDigest }, false);
    requireValue(result.accepted && await this.head(name, ref) === source.commit, "WORK_BASE_INSTALLATION_UNKNOWN", 503);
  }

  private async writeFixedRef(name: string, operation: FixedPublication, requireChild: boolean): Promise<{ accepted: boolean; report: string }> {
    requireValue(/^[a-f0-9]{40}$/.test(operation.oldHead) && /^[a-f0-9]{40}$/.test(operation.newHead), "INVALID_GIT_OID");
    validateCanonicalRef(operation.canonicalRef);
    using repo = await this.get(name);
    const info = await this.binding(() => repo.info());
    const remote = validateRemote(info.remote);
    const raw = await this.objects.get(operation.objectsDigest, MAX_GIT_STORAGE);
    const objects = JSON.parse(new TextDecoder().decode(raw)) as GitObject[];
    requireValue(objects.length <= MAX_OBJECTS, "OBJECT_COUNT_LIMIT", 413);
    const fs = memoryRepository(); const dir = "/publication";
    await git.init({ fs, dir });
    for (const object of objects) {
      const oid = await git.writeObject({ fs, dir, type: object.type, object: decodeBase64(object.dataBase64), format: "content" });
      requireValue(oid === object.oid, "GIT_OBJECT_ID_MISMATCH");
    }
    const commit = await git.readCommit({ fs, dir, oid: operation.newHead });
    if (requireChild) requireValue(commit.commit.parent.length === 1 && commit.commit.parent[0] === operation.oldHead, "PUBLICATION_MUST_BE_CHILD");
    const packed = await git.packObjects({ fs, dir, oids: objects.map(object => object.oid) });
    requireValue(packed.packfile && packed.packfile.byteLength <= MAX_GIT_TRANSFER, "PACK_SIZE_LIMIT", 413);
    const bytes = buildReceivePack(operation.oldHead, operation.newHead, operation.canonicalRef, packed.packfile);
    // The 60-second token is for the transfer, not the preceding R2 reads and
    // pack construction, which can legitimately consume most of its lifetime.
    const token = await this.binding(() => repo.createToken("write", 60));
    try {
      // This transport intentionally never fetches or substitutes a fresh expected-old value.
      const response = await fetch(`${remote.href}/git-receive-pack`, { method: "POST", redirect: "manual", headers: {
        authorization: `Bearer ${token.plaintext}`, "content-type": "application/x-git-receive-pack-request", accept: "application/x-git-receive-pack-result",
      }, body: bytes.slice().buffer, signal: gitTransferSignal() });
      requireValue(response.status < 300 || response.status >= 400, "GIT_REDIRECT_DENIED", 502);
      const report = parseReceivePack(await readBounded(response.body, 64 * 1024), operation.canonicalRef);
      return { accepted: response.ok && report.accepted, report: report.reason };
    } finally { await this.binding(() => repo.revokeToken(token.plaintext)); }
  }
}

export function buildReceivePack(oldHead: string, newHead: string, ref: string, packfile: Uint8Array): Uint8Array {
  requireValue(/^[a-f0-9]{40}$/.test(oldHead) && /^[a-f0-9]{40}$/.test(newHead), "INVALID_REF_UPDATE"); validateCanonicalRef(ref);
  const command = new TextEncoder().encode(`${oldHead} ${newHead} ${ref}\0report-status\n`);
  const prefix = new TextEncoder().encode((command.length + 4).toString(16).padStart(4, "0"));
  const result = new Uint8Array(prefix.length + command.length + 4 + packfile.length);
  result.set(prefix); result.set(command, 4); result.set(new TextEncoder().encode("0000"), 4 + command.length);
  result.set(packfile, 8 + command.length); return result;
}

export function parseReceivePack(bytes: Uint8Array, ref: string): { accepted: boolean; reason: string } {
  let offset = 0; let flushed = false; const lines: string[] = [];
  while (offset < bytes.length) {
    requireValue(offset + 4 <= bytes.length, "INVALID_GIT_REPORT", 502);
    const lengthText = new TextDecoder().decode(bytes.subarray(offset, offset + 4));
    requireValue(/^[a-fA-F0-9]{4}$/.test(lengthText), "INVALID_GIT_REPORT", 502);
    const length = Number.parseInt(lengthText, 16); offset += 4;
    if (length === 0) { flushed = true; break; }
    requireValue(length >= 4 && offset + length - 4 <= bytes.length, "INVALID_GIT_REPORT", 502);
    lines.push(new TextDecoder().decode(bytes.subarray(offset, offset + length - 4)).trim()); offset += length - 4;
  }
  requireValue(flushed && offset === bytes.length, "INVALID_GIT_REPORT", 502);
  const accepted = lines.length === 2 && lines[0] === "unpack ok" && lines[1] === `ok ${ref}`;
  return { accepted, reason: accepted ? "REF_UPDATE_ACKNOWLEDGED" : "REF_UPDATE_REJECTED" };
}
