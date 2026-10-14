// SPDX-License-Identifier: Apache-2.0
import { canonicalize, containsTypeScriptSource, getKernel, parseStrictJson } from "../../packages/protocol/src/index";
import type { SourceManifest } from "../../packages/protocol/src/types";
import { ObjectStore, MAX_CONTROL_BYTES, MAX_MANIFEST_BYTES, MAX_SOURCE_BYTES } from "../shared/objects";
import { digestBytes, PlatformError, readBounded, requireValue } from "../shared/errors";
import { withinDeadline } from "../shared/deadline";

/** Contract reviewed against this immutable Weft source revision, not its live checkout. */
export const WEFT_SOURCE_REVISION = "b1c5521bf28a0144203c55b3f056885dce3535ff";
const MAX_WEFT_FILES = 2000;
const MAX_WEFT_FILE_BYTES = 512 * 1024;
const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_BATCH_HASHES = 32;
// JSON may encode each control byte as six ASCII bytes; bound the wire envelope too.
const MAX_CONTENT_RESPONSE_BYTES = MAX_BATCH_BYTES * 6 + 64 * 1024;
const ACQUISITION_TIMEOUT_MS = 30_000;
const encoder = new TextEncoder();
const hashPattern = /^[a-f0-9]{64}$/;

/** The caller binds this client to one authorized workspace/alternative server-side. */
export interface WeftSourceClient {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export interface WeftSourceSelection {
  revision: number;
  root: string;
  privacyGeneration?: number;
}

interface WeftManifestEntry { hash: string; size: number; mode: number }
interface WeftManifest {
  schema: "weft.manifest.v1";
  entries: Record<string, WeftManifestEntry>;
  root: string;
  bytes: number;
}
interface RetainedSelection {
  schema: "weft.sync-selection.v1";
  revision: number;
  manifest: WeftManifest;
  privacyGeneration: number;
}

export interface WeftSourceMapping {
  schema: "confidence.weft-source-map.v1";
  /** Validator contract pin; this is not an attestation of the remote deployment's executable code. */
  weftContractRevision: string;
  selection: Required<WeftSourceSelection>;
  sourceManifestDigest: string;
  representation: "exact-utf8-bytes-v1";
  entries: {
    path: string;
    weft: { hash: string; size: number; mode: number };
    confidence: { digest: string; bytes: string; mode: "100644" | "100755" };
  }[];
}

export interface VerifiedWeftSource {
  selection: Required<WeftSourceSelection>;
  manifest: SourceManifest;
  manifestDigest: string;
  /** Distinct exact UTF-8 byte contents, indexed by Confidence SHA-256 digest. */
  contents: Map<string, Uint8Array>;
  mapping: WeftSourceMapping;
  mappingDigest: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function generation(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Reject source outside both the pinned Weft format and Confidence's existing profile. */
function validateWeftPath(path: string): void {
  requireValue(path.length > 0 && path.length <= 240 && /^[A-Za-z0-9_./@ +()-]+$/.test(path), "WEFT_UNSUPPORTED_PATH", 422);
  const parts = path.split("/");
  requireValue(parts.every(part => part && part !== "." && part !== ".." && !part.endsWith(".") && !part.endsWith(" ") &&
    ![".git", ".weft"].includes(part.toLowerCase())), "WEFT_UNSUPPORTED_PATH", 422);
  requireValue(!parts.some(part => /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh|\.aws|credentials(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i.test(part)), "WEFT_PRIVATE_PATH", 422);
}

async function validateSelection(value: unknown, expected: WeftSourceSelection): Promise<{ retained: RetainedSelection; manifest: SourceManifest }> {
  requireValue(exactKeys(value, ["schema", "revision", "manifest", "privacyGeneration"]) && value.schema === "weft.sync-selection.v1", "WEFT_INVALID_SELECTION", 422);
  requireValue(value.revision === expected.revision && generation(value.privacyGeneration), "WEFT_SELECTION_MISMATCH", 409);
  requireValue(expected.privacyGeneration === undefined || expected.privacyGeneration === value.privacyGeneration, "WEFT_PRIVACY_GENERATION_CHANGED", 409);
  const selected = value.manifest;
  requireValue(exactKeys(selected, ["schema", "entries", "root", "bytes"]) && selected.schema === "weft.manifest.v1" &&
    record(selected.entries) && selected.root === expected.root && typeof selected.bytes === "number" && Number.isSafeInteger(selected.bytes) && selected.bytes >= 0, "WEFT_INVALID_MANIFEST", 422);
  const paths = Object.keys(selected.entries).sort();
  requireValue(paths.length <= MAX_WEFT_FILES, "WEFT_FILE_COUNT_LIMIT", 413);
  const entries: SourceManifest["entries"] = [];
  const weftEntries: Record<string, WeftManifestEntry> = {};
  const sizes = new Map<string, number>();
  let total = 0;
  for (const path of paths) {
    validateWeftPath(path);
    const entry = selected.entries[path];
    requireValue(exactKeys(entry, ["hash", "size", "mode"]) && typeof entry.hash === "string" && hashPattern.test(entry.hash) &&
      typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= MAX_WEFT_FILE_BYTES &&
      (entry.mode === 0o100644 || entry.mode === 0o100755), "WEFT_UNSUPPORTED_ENTRY", 422);
    const size = entry.size;
    requireValue(!sizes.has(entry.hash) || sizes.get(entry.hash) === size, "WEFT_INCONSISTENT_CONTENT_SIZE", 422);
    sizes.set(entry.hash, size);
    total += size;
    requireValue(total <= MAX_SOURCE_BYTES, "SOURCE_SIZE_LIMIT", 413);
    entries.push({ path, mode: entry.mode === 0o100755 ? "100755" : "100644", bytes: String(size), digest: `sha256:${entry.hash}` });
    Object.defineProperty(weftEntries, path, { value: { hash: entry.hash, size, mode: entry.mode }, enumerable: true });
  }
  requireValue(total === selected.bytes, "WEFT_MANIFEST_LENGTH_MISMATCH", 422);
  const root = await digestBytes(encoder.encode(`weft:manifest:v1\n${canonicalize({ schema: selected.schema, entries: selected.entries })}`));
  requireValue(root === `sha256:${expected.root}`, "WEFT_MANIFEST_ROOT_MISMATCH", 422);
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: "portable-ascii-v1", entries };
  const validation = JSON.parse(getKernel().validate_manifest(canonicalize(manifest))) as { valid: boolean; reason?: string };
  requireValue(validation.valid, validation.reason ?? "INVALID_MANIFEST", 422);
  requireValue(!containsTypeScriptSource(manifest), "TYPESCRIPT_PROTECTED_PROFILE_UNREGISTERED", 409);
  return { retained: { schema: "weft.sync-selection.v1", revision: expected.revision, privacyGeneration: value.privacyGeneration,
    manifest: { schema: "weft.manifest.v1", entries: weftEntries, root: expected.root, bytes: total } }, manifest };
}

async function jsonRequest(client: WeftSourceClient, path: string, init: RequestInit, maximum: number, expires: number): Promise<unknown> {
  const abort = new AbortController();
  let response: Response | undefined;
  try {
    return await withinDeadline(async () => {
      response = await client.fetch(path, { ...init, redirect: "manual", signal: abort.signal });
      if (abort.signal.aborted) { void response.body?.cancel().catch(() => { /* Cancellation is best effort after deadline. */ }); throw new PlatformError("WEFT_ACQUISITION_DEADLINE", 503); }
      requireValue(response.status < 300 || response.status >= 400, "WEFT_REDIRECT_DENIED", 503);
      if (!response.ok) {
        void response.body?.cancel().catch(() => { /* Never extend an already failed acquisition for disposal. */ });
        if (response.status === 401 || response.status === 403) throw new PlatformError("WEFT_ACCESS_DENIED", 403);
        if (response.status === 404) throw new PlatformError("WEFT_REVISION_UNAVAILABLE", 409);
        if (response.status === 409) throw new PlatformError("WEFT_SELECTION_UNAVAILABLE", 409);
        // Weft's bounded coordinator explicitly asks clients to retry 429 under the same identity.
        throw new PlatformError("WEFT_ACQUISITION_UNAVAILABLE", response.status >= 500 || response.status === 408 || response.status === 429 ? 503 : 422);
      }
      // Abort the stream as well as fetch, including custom service clients that ignore fetch's signal.
      const stream = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal: abort.signal }) ?? null;
      const bytes = await readBounded(stream, maximum);
      requireValue(!abort.signal.aborted, "WEFT_ACQUISITION_DEADLINE", 503);
      try { return parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new PlatformError("WEFT_INVALID_RESPONSE", 422); }
    }, expires - Date.now(), "WEFT_ACQUISITION_DEADLINE");
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    // Service exceptions can contain credential-bearing request details; expose only a stable safe code.
    throw new PlatformError("WEFT_ACQUISITION_UNAVAILABLE", 503);
  } finally {
    abort.abort();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => { /* Best effort disposal after a bounded read. */ });
  }
}

/** Read only an exact retained revision. No latest lookup, tool execution, Git ref write, or R2 write occurs here. */
export async function acquireWeftSource(client: WeftSourceClient, selected: WeftSourceSelection): Promise<VerifiedWeftSource> {
  requireValue(Number.isSafeInteger(selected.revision) && selected.revision >= 0 && typeof selected.root === "string" && hashPattern.test(selected.root) &&
    (selected.privacyGeneration === undefined || generation(selected.privacyGeneration)), "INVALID_WEFT_SELECTION");
  const expires = Date.now() + ACQUISITION_TIMEOUT_MS;
  const selectionPath = `sync/revisions/${selected.revision}`;
  const { retained, manifest } = await validateSelection(await jsonRequest(client, selectionPath, { method: "GET" }, MAX_CONTROL_BYTES, expires), selected);
  const selection: Required<WeftSourceSelection> = { revision: retained.revision, root: retained.manifest.root, privacyGeneration: retained.privacyGeneration };
  const contents = new Map<string, Uint8Array>();
  const distinct = new Map(Object.values(retained.manifest.entries).map(entry => [entry.hash, entry.size]));
  const batches: string[][] = [];
  let batch: string[] = [], batchBytes = 0;
  for (const [hash, size] of distinct) {
    if (batch.length && (batch.length === MAX_BATCH_HASHES || batchBytes + size > MAX_BATCH_BYTES)) { batches.push(batch); batch = []; batchBytes = 0; }
    batch.push(hash); batchBytes += size;
  }
  if (batch.length) batches.push(batch);
  // A final empty acquisition rechecks authorization/privacy even for an empty tree.
  batches.push([]);
  for (const hashes of batches) {
    const payload = { schema: "weft.sync-request.v1", ...selection, hashes };
    const result = await jsonRequest(client, "sync-contents", { method: "POST", headers: { "content-type": "application/json" }, body: canonicalize(payload) }, MAX_CONTENT_RESPONSE_BYTES, expires);
    requireValue(exactKeys(result, ["schema", "revision", "root", "privacyGeneration", "objects"]) && result.schema === "weft.sync-contents.v1" &&
      result.revision === selection.revision && result.root === selection.root && result.privacyGeneration === selection.privacyGeneration && record(result.objects), "WEFT_CONTENT_SELECTION_MISMATCH", 409);
    requireValue(Object.keys(result.objects).length === hashes.length && hashes.every(hash => Object.hasOwn(result.objects as object, hash)), "WEFT_INCOMPLETE_CONTENT", 422);
    for (const hash of hashes) {
      const text = result.objects[hash];
      requireValue(typeof text === "string" && !text.includes("\0"), "WEFT_UNSUPPORTED_CONTENT", 422);
      // Strict JSON rejects unpaired surrogates. Roundtrip keeps UTF-8 BOMs and all line endings.
      const bytes = encoder.encode(text);
      requireValue(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) === text, "WEFT_UNSUPPORTED_CONTENT", 422);
      requireValue(bytes.length === distinct.get(hash), "WEFT_CONTENT_LENGTH_MISMATCH", 422);
      const digest = await digestBytes(bytes);
      requireValue(digest === `sha256:${hash}`, "WEFT_CONTENT_DIGEST_MISMATCH", 422);
      contents.set(digest, bytes);
    }
  }
  const manifestBytes = encoder.encode(canonicalize(manifest));
  requireValue(manifestBytes.length <= MAX_MANIFEST_BYTES, "MANIFEST_SIZE_LIMIT", 413);
  const manifestDigest = await digestBytes(manifestBytes);
  const mapping: WeftSourceMapping = {
    schema: "confidence.weft-source-map.v1", weftContractRevision: WEFT_SOURCE_REVISION, selection,
    sourceManifestDigest: manifestDigest, representation: "exact-utf8-bytes-v1",
    entries: manifest.entries.map(entry => ({ path: entry.path, weft: { ...retained.manifest.entries[entry.path] },
      confidence: { digest: entry.digest, bytes: entry.bytes, mode: entry.mode } })),
  };
  return { selection, manifest, manifestDigest, contents, mapping, mappingDigest: await digestBytes(encoder.encode(canonicalize(mapping))) };
}

/** Content-addressed persistence begins only after acquisition validated the complete selection. */
export async function persistWeftSource(source: VerifiedWeftSource, objects: ObjectStore): Promise<{ manifestDigest: string; mappingDigest: string }> {
  const required = new Set(source.manifest.entries.map(entry => entry.digest));
  requireValue(required.size === source.contents.size && [...required].every(digest => source.contents.has(digest)), "WEFT_INCOMPLETE_CONTENT", 422);
  for (const entry of source.manifest.entries) requireValue(String(source.contents.get(entry.digest)!.length) === entry.bytes, "WEFT_CONTENT_LENGTH_MISMATCH", 422);
  // Recheck all content identities before the first persistent write, including callers holding mutable buffers.
  for (const [digest, bytes] of source.contents) requireValue(await digestBytes(bytes) === digest, "WEFT_CONTENT_DIGEST_MISMATCH", 422);
  const manifestBytes = encoder.encode(canonicalize(source.manifest));
  const mappingBytes = encoder.encode(canonicalize(source.mapping));
  requireValue(await digestBytes(manifestBytes) === source.manifestDigest && await digestBytes(mappingBytes) === source.mappingDigest &&
    source.mapping.sourceManifestDigest === source.manifestDigest, "WEFT_MAPPING_MISMATCH", 422);
  for (const [digest, bytes] of source.contents) await objects.put(bytes, digest);
  await objects.put(manifestBytes, source.manifestDigest);
  await objects.put(mappingBytes, source.mappingDigest);
  return { manifestDigest: source.manifestDigest, mappingDigest: source.mappingDigest };
}
