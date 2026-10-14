// SPDX-License-Identifier: Apache-2.0
// Additive byte consumer only. Acquisition does not enroll an execution or publication profile.
import { canonicalize, decodeBase64, encodeBase64, getKernel } from '../../packages/protocol/src/index';
import type { SourceManifest } from '../../packages/protocol/src/types';
import { parseProjectJson } from '../../packages/project-model/src/json';
import type { ObjectStore } from '../shared/objects';
import { digestBytes, PlatformError, readBounded, requireValue } from '../shared/errors';
import { withinDeadline } from '../shared/deadline';
import type { WeftSourceClient } from './weft-source';

const MAX_FILES = 2000, MAX_FILE_BYTES = 512 * 1024, MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_BATCH_BYTES = 1024 * 1024, MAX_BATCH_HASHES = 32, MAX_RESPONSE_BYTES = 7 * 1024 * 1024;
const MAX_SELECTION_BYTES = 1024 * 1024, MAX_TIMEOUT_MS = 30000;
const encoder = new TextEncoder(), hashPattern = /^[a-f0-9]{64}$/;
export interface WeftSourceSelectionV2 { revision: number; root: string; privacyGeneration: number; profileHash: string }
export interface WeftSourceOptionsV2 {
  /** Reviewed source contract pin, not an attestation of the remote runtime's executable code. */
  weftContractRevision: string;
  /** Server-owned bound. A shorter deadline is useful for an already bounded caller. */
  timeoutMs?: number;
}
interface ManifestEntry { hash: string; size: number; mode: number; encoding: 'utf8' | 'base64' }
interface RetainedManifest { schema: 'weft.manifest.v2'; entries: Record<string, ManifestEntry>; root: string; bytes: number }
export interface WeftSourceMappingV2 {
  schema: 'confidence.weft-source-map.v2'; weftContractRevision: string; selection: WeftSourceSelectionV2;
  sourceManifestDigest: string; representation: 'exact-bytes-v2';
  entries: { path: string; weft: ManifestEntry; confidence: { digest: string; bytes: string; mode: '100644' | '100755' } }[];
}
export interface VerifiedWeftSourceV2 {
  selection: WeftSourceSelectionV2; manifest: SourceManifest; manifestDigest: string;
  contents: Map<string, Uint8Array>; mapping: WeftSourceMappingV2; mappingDigest: string;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const generation = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
function validatePath(path: string) {
  requireValue(path.length > 0 && path.length <= 240 && /^[A-Za-z0-9_./@ +()-]+$/.test(path), 'WEFT_UNSUPPORTED_PATH', 422);
  const parts = path.split('/');
  requireValue(parts.every(part => part && part !== '.' && part !== '..' && !part.endsWith('.') && !part.endsWith(' ') && !['.git', '.weft'].includes(part.toLowerCase())), 'WEFT_UNSUPPORTED_PATH', 422);
  requireValue(!parts.some(part => /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh|\.aws|credentials(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i.test(part)), 'WEFT_PRIVATE_PATH', 422);
}
function checkConfidenceManifest(manifest: SourceManifest) {
  const result: unknown = JSON.parse(getKernel().validate_manifest(canonicalize(manifest)));
  requireValue(record(result) && typeof result.valid === 'boolean', 'KERNEL_RESPONSE_INVALID', 503);
  requireValue(result.valid, typeof result.reason === 'string' ? result.reason : 'INVALID_MANIFEST', 422);
}

async function selectedManifest(value: unknown, expected: WeftSourceSelectionV2): Promise<{ retained: RetainedManifest; manifest: SourceManifest }> {
  requireValue(exact(value, ['schema', 'revision', 'manifest', 'privacyGeneration', 'profileHash']) && value.schema === 'weft.sync-selection.v2', 'WEFT_INVALID_SELECTION', 422);
  requireValue(value.revision === expected.revision && value.privacyGeneration === expected.privacyGeneration && value.profileHash === expected.profileHash, 'WEFT_SELECTION_MISMATCH', 409);
  const selected = value.manifest;
  requireValue(exact(selected, ['schema', 'entries', 'root', 'bytes']) && selected.schema === 'weft.manifest.v2' && record(selected.entries) && selected.root === expected.root &&
    typeof selected.bytes === 'number' && Number.isSafeInteger(selected.bytes) && selected.bytes >= 0, 'WEFT_INVALID_MANIFEST', 422);
  const paths = Object.keys(selected.entries).sort(); requireValue(paths.length <= MAX_FILES, 'WEFT_FILE_COUNT_LIMIT', 413);
  const entries: SourceManifest['entries'] = [], retained: Record<string, ManifestEntry> = {}, distinct = new Map<string, { size: number; encoding: string }>();
  let total = 0;
  for (const path of paths) {
    validatePath(path); const entry = selected.entries[path];
    requireValue(exact(entry, ['hash', 'size', 'mode', 'encoding']) && typeof entry.hash === 'string' && hashPattern.test(entry.hash) &&
      typeof entry.size === 'number' && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= MAX_FILE_BYTES &&
      (entry.mode === 0o100644 || entry.mode === 0o100755) && (entry.encoding === 'utf8' || entry.encoding === 'base64'), 'WEFT_UNSUPPORTED_ENTRY', 422);
    const prior = distinct.get(entry.hash);
    requireValue(!prior || prior.size === entry.size && prior.encoding === entry.encoding, 'WEFT_INCONSISTENT_CONTENT', 422);
    distinct.set(entry.hash, { size: entry.size, encoding: entry.encoding }); total += entry.size;
    requireValue(total <= MAX_SOURCE_BYTES, 'SOURCE_SIZE_LIMIT', 413);
    entries.push({ path, mode: entry.mode === 0o100755 ? '100755' : '100644', bytes: String(entry.size), digest: 'sha256:' + entry.hash });
    Object.defineProperty(retained, path, { value: { hash: entry.hash, size: entry.size, mode: entry.mode, encoding: entry.encoding }, enumerable: true });
  }
  requireValue(total === selected.bytes, 'WEFT_MANIFEST_LENGTH_MISMATCH', 422);
  requireValue(await digestBytes(encoder.encode('weft:manifest:v2\n' + canonicalize({ schema: selected.schema, entries: selected.entries }))) === 'sha256:' + expected.root, 'WEFT_MANIFEST_ROOT_MISMATCH', 422);
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries };
  // The independent kernel's actual capacity remains authoritative; never silently bypass an older verifier.
  checkConfidenceManifest(manifest);
  return { retained: { schema: 'weft.manifest.v2', entries: retained, root: expected.root, bytes: total }, manifest };
}

async function jsonRequest(client: WeftSourceClient, path: string, init: RequestInit, maximum: number, expires: number): Promise<unknown> {
  const abort = new AbortController(); let response: Response | undefined;
  try {
    return await withinDeadline(async () => {
      response = await client.fetch(path, { ...init, redirect: 'manual', signal: abort.signal });
      if (abort.signal.aborted) { void response.body?.cancel().catch(() => { /* Disposal must not extend an expired acquisition. */ }); throw new PlatformError('WEFT_ACQUISITION_DEADLINE', 503); }
      requireValue(response.status < 300 || response.status >= 400, 'WEFT_REDIRECT_DENIED', 503);
      if (!response.ok) {
        void response.body?.cancel().catch(() => { /* Do not expose upstream disposal diagnostics or extend this failure. */ });
        if (response.status === 401 || response.status === 403) throw new PlatformError('WEFT_ACCESS_DENIED', 403);
        if (response.status === 404) throw new PlatformError('WEFT_REVISION_UNAVAILABLE', 409);
        if (response.status === 409) throw new PlatformError('WEFT_SELECTION_UNAVAILABLE', 409);
        throw new PlatformError('WEFT_ACQUISITION_UNAVAILABLE', response.status >= 500 || response.status === 408 || response.status === 429 ? 503 : 422);
      }
      const stream = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal: abort.signal }) ?? null;
      const bytes = await readBounded(stream, maximum); requireValue(!abort.signal.aborted, 'WEFT_ACQUISITION_DEADLINE', 503);
      try {
        // Complete manifests may have 2,000 path keys. Preserve the signed kernel's smaller object-key ceiling.
        const value = parseProjectJson(new TextDecoder('utf8', { fatal: true }).decode(bytes));
        canonicalize(value); // Project JSON rejects duplicate keys; this also rejects unpaired surrogates.
        return value;
      } catch { throw new PlatformError('WEFT_INVALID_RESPONSE', 422); }
    }, expires - Date.now(), 'WEFT_ACQUISITION_DEADLINE');
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    // Service exceptions may include credential-bearing request details; expose only a stable safe code.
    throw new PlatformError('WEFT_ACQUISITION_UNAVAILABLE', 503);
  } finally {
    abort.abort();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => { /* Best effort disposal after a bounded read. */ });
  }
}

function utf8(bytes: Uint8Array): string | null {
  try { const text = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes); return text.includes('\0') ? null : text; }
  catch { return null; }
}
function decodeContent(value: unknown, entry: ManifestEntry): Uint8Array {
  requireValue(exact(value, ['encoding', 'content']) && typeof value.content === 'string', 'WEFT_INVALID_CONTENT', 422);
  requireValue(value.encoding === entry.encoding, 'WEFT_CONTENT_ENCODING_MISMATCH', 422);
  if (value.encoding === 'utf8') {
    const bytes = encoder.encode(value.content);
    requireValue(utf8(bytes) === value.content, 'WEFT_NONCANONICAL_ENCODING', 422); return bytes;
  }
  let bytes: Uint8Array;
  try { bytes = decodeBase64(value.content); } catch { throw new PlatformError('WEFT_NONCANONICAL_ENCODING', 422); }
  requireValue(encodeBase64(bytes) === value.content && utf8(bytes) === null, 'WEFT_NONCANONICAL_ENCODING', 422);
  return bytes;
}

/** Exact retained v2 acquisition, including a mandatory final empty-batch authority/profile check. */
export async function acquireWeftSourceV2(client: WeftSourceClient, selected: WeftSourceSelectionV2, options: WeftSourceOptionsV2): Promise<VerifiedWeftSourceV2> {
  requireValue(exact(selected, ['revision', 'root', 'privacyGeneration', 'profileHash']) && typeof selected.revision === 'number' && Number.isSafeInteger(selected.revision) && selected.revision >= 0 &&
    typeof selected.root === 'string' && hashPattern.test(selected.root) && generation(selected.privacyGeneration) && typeof selected.profileHash === 'string' && hashPattern.test(selected.profileHash), 'INVALID_WEFT_SELECTION');
  requireValue(typeof options?.weftContractRevision === 'string' && /^[a-f0-9]{40}$/.test(options.weftContractRevision), 'WEFT_CONTRACT_PIN_REQUIRED');
  const timeout = options.timeoutMs ?? MAX_TIMEOUT_MS;
  requireValue(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= MAX_TIMEOUT_MS, 'WEFT_DEADLINE_INVALID');
  const selection = { ...selected }, expires = Date.now() + timeout;
  const { retained, manifest } = await selectedManifest(await jsonRequest(client, `sync-v2/revisions/${selection.revision}`, { method: 'GET' }, MAX_SELECTION_BYTES, expires), selection);
  const distinct = new Map(Object.values(retained.entries).map(entry => [entry.hash, entry]));
  const batches: string[][] = []; let batch: string[] = [], batchBytes = 0;
  for (const [hash, entry] of distinct) {
    if (batch.length && (batch.length === MAX_BATCH_HASHES || batchBytes + entry.size > MAX_BATCH_BYTES)) { batches.push(batch); batch = []; batchBytes = 0; }
    batch.push(hash); batchBytes += entry.size;
  }
  if (batch.length) batches.push(batch); batches.push([]);
  const contents = new Map<string, Uint8Array>();
  for (const hashes of batches) {
    const response = await jsonRequest(client, 'sync-contents-v2', { method: 'POST', headers: { 'content-type': 'application/json' }, body: canonicalize({ schema: 'weft.sync-request.v2', ...selection, hashes }) }, MAX_RESPONSE_BYTES, expires);
    requireValue(exact(response, ['schema', 'revision', 'root', 'privacyGeneration', 'profileHash', 'objects']) && response.schema === 'weft.sync-contents.v2' &&
      response.revision === selection.revision && response.root === selection.root && response.privacyGeneration === selection.privacyGeneration && response.profileHash === selection.profileHash && record(response.objects), 'WEFT_CONTENT_SELECTION_MISMATCH', 409);
    requireValue(Object.keys(response.objects).length === hashes.length && hashes.every(hash => Object.hasOwn(response.objects as object, hash)), 'WEFT_INCOMPLETE_CONTENT', 422);
    for (const hash of hashes) {
      const entry = distinct.get(hash)!, bytes = decodeContent(response.objects[hash], entry);
      requireValue(bytes.length === entry.size, 'WEFT_CONTENT_LENGTH_MISMATCH', 422);
      const digest = await digestBytes(bytes); requireValue(digest === 'sha256:' + hash, 'WEFT_CONTENT_DIGEST_MISMATCH', 422); contents.set(digest, bytes);
    }
  }
  const manifestDigest = await digestBytes(encoder.encode(canonicalize(manifest)));
  const mapping: WeftSourceMappingV2 = { schema: 'confidence.weft-source-map.v2', weftContractRevision: options.weftContractRevision, selection,
    sourceManifestDigest: manifestDigest, representation: 'exact-bytes-v2',
    entries: manifest.entries.map(entry => ({ path: entry.path, weft: { ...retained.entries[entry.path] }, confidence: { digest: entry.digest, bytes: entry.bytes, mode: entry.mode } })) };
  return { selection, manifest, manifestDigest, contents, mapping, mappingDigest: await digestBytes(encoder.encode(canonicalize(mapping))) };
}

/** Persist only a completely acquired selection. No canonical source refs or local Git state are touched. */
export async function persistWeftSourceV2(source: VerifiedWeftSourceV2, objects: ObjectStore): Promise<{ manifestDigest: string; mappingDigest: string }> {
  const contents = new Map([...source.contents].map(([digest, bytes]) => [digest, bytes.slice()]));
  const required = new Set(source.manifest.entries.map(entry => entry.digest));
  requireValue(required.size === contents.size && [...required].every(digest => contents.has(digest)), 'WEFT_INCOMPLETE_CONTENT', 422);
  for (const entry of source.manifest.entries) requireValue(String(contents.get(entry.digest)!.length) === entry.bytes, 'WEFT_CONTENT_LENGTH_MISMATCH', 422);
  for (const [digest, bytes] of contents) requireValue(await digestBytes(bytes) === digest, 'WEFT_CONTENT_DIGEST_MISMATCH', 422);
  checkConfidenceManifest(source.manifest);
  const manifestBytes = encoder.encode(canonicalize(source.manifest)), mappingBytes = encoder.encode(canonicalize(source.mapping));
  requireValue(await digestBytes(manifestBytes) === source.manifestDigest && await digestBytes(mappingBytes) === source.mappingDigest && source.mapping.sourceManifestDigest === source.manifestDigest &&
    canonicalize(source.mapping.selection) === canonicalize(source.selection), 'WEFT_MAPPING_MISMATCH', 422);
  for (const [digest, bytes] of contents) await objects.put(bytes, digest);
  await objects.put(manifestBytes, source.manifestDigest); await objects.put(mappingBytes, source.mappingDigest);
  return { manifestDigest: source.manifestDigest, mappingDigest: source.mappingDigest };
}
