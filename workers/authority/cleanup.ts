// SPDX-License-Identifier: Apache-2.0
import { digest, canonicalize, getKernel, parseStrictJson, type GitObject, type Scope } from '../../packages/protocol/src/index';
import type { RepositorySnapshot } from './artifacts';
import { ObjectStore, MAX_FILE_BYTES, MAX_MANIFEST_BYTES } from '../shared/objects';
import { PlatformError, requireValue } from '../shared/errors';

export type CleanupPhase = 'STOP_REQUESTED' | 'CREDENTIALS_REVOKED' | 'ARCHIVE_VERIFIED' | 'DELETE_MAY_HAVE_DISPATCHED' | 'TOMBSTONED' | 'RECOVERY_HOLD';
export interface CleanupRecord {
  id: string; scope: Scope; attemptId: string; generation: string; repository: string;
  phase: CleanupPhase; terminationObserved: boolean; credentialsRevoked: boolean;
  auxiliaryResources: 'NOT_CONFIGURED' | 'REMOVED' | null;
  archiveDigest: string | null; archiveObjects: number;
  deleteAcknowledged: boolean; tombstonedAt: number | null; reason: string | null;
}
export interface CleanupActions {
  /** Current durable grant/attempt fence, including any unresolved dependent effects. */
  fenced(): boolean;
  terminationObserved(): Promise<boolean>;
  pendingAttemptEffects(): boolean;
  repositoryPresent(): Promise<boolean>;
  revokeCredentials(): Promise<boolean>;
  removeAuxiliaryResources(): Promise<'NOT_CONFIGURED' | 'REMOVED'>;
  verifyArchive(): Promise<{ complete: boolean; digest?: string; objects?: number }>;
  deleteRepository(): Promise<boolean>;
  /** Must durably commit before returning; especially before deleteRepository(). */
  save(record: CleanupRecord): Promise<void>;
  now(): number;
}

class CleanupArchiveFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

/**
 * Workspace cleanup never deletes retained evidence or authority tombstones.
 * After possible delete dispatch, retries only observe the same repository.
 */
export async function advanceCleanup(initial: CleanupRecord, actions: CleanupActions): Promise<CleanupRecord> {
  let current = structuredClone(initial);
  const save = async (change: Partial<CleanupRecord>) => {
    const next = { ...current, ...change };
    await actions.save(next); current = next;
  };
  const verifyArchive = async () => {
    try {
      const archive = await actions.verifyArchive();
      if (archive.complete) requireValue(archive.digest && /^sha256:[a-f0-9]{64}$/.test(archive.digest)
        && Number.isSafeInteger(archive.objects) && archive.objects! >= 0, 'INVALID_CLEANUP_ARCHIVE', 409);
      return archive;
    } catch (error) {
      // Only archive validation failures are permanent here. Timeouts, provider
      // failures and throttling remain retryable with the same cleanup identity.
      if (error instanceof PlatformError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429)
        throw new CleanupArchiveFailure(error.code);
      throw error;
    }
  };
  if (current.phase === 'TOMBSTONED' || current.phase === 'RECOVERY_HOLD') return current;
  try {
    requireValue(actions.fenced(), 'CLEANUP_ADMISSIONS_NOT_FENCED', 409);
    if (current.phase === 'STOP_REQUESTED') {
      if (!await actions.terminationObserved() || actions.pendingAttemptEffects()) {
        await save({ reason: 'WAITING_FOR_TERMINATION_AND_EFFECTS' }); return current;
      }
      await save({ terminationObserved: true, reason: null });
      if (!await actions.revokeCredentials()) {
        await save({ reason: 'CREDENTIAL_REVOCATION_UNCONFIRMED' }); return current;
      }
      const auxiliaryResources = await actions.removeAuxiliaryResources();
      await save({ phase: 'CREDENTIALS_REVOKED', credentialsRevoked: true, auxiliaryResources });
    }
    if (current.phase === 'CREDENTIALS_REVOKED') {
      const archive = await verifyArchive();
      if (!archive.complete) { await save({ reason: 'REQUIRED_ARCHIVE_INCOMPLETE' }); return current; }
      await save({ phase: 'ARCHIVE_VERIFIED', archiveDigest: archive.digest, archiveObjects: archive.objects!, reason: null });
    }
    if (current.phase === 'ARCHIVE_VERIFIED') {
      // A restart or yield cannot turn an older successful read into permission to
      // delete after its required archive inventory or current fence has changed.
      // Required bytes are application-write-once and remain pinned; an operator
      // deleting R2 content is outside this retained-store guarantee.
      const archive = await verifyArchive();
      if (!archive.complete || archive.digest !== current.archiveDigest) {
        await save({ phase: 'CREDENTIALS_REVOKED', archiveDigest: null, archiveObjects: 0, reason: 'ARCHIVE_CHANGED' }); return current;
      }
      requireValue(actions.fenced() && !actions.pendingAttemptEffects(), 'CLEANUP_EFFECTS_UNSETTLED', 409);
      if (!await actions.revokeCredentials()) { await save({ reason: 'CREDENTIAL_REVOCATION_UNCONFIRMED' }); return current; }
      // repositoryPresent() also validates the exact owned resource association.
      if (!await actions.repositoryPresent()) {
        await save({ phase: 'TOMBSTONED', tombstonedAt: actions.now(), reason: 'REPOSITORY_ABSENCE_OBSERVED' }); return current;
      }
      // Token revocation and provider inspection yield. Recheck the selected
      // closure after both, before committing the nonrepeatable delete intent.
      const finalArchive = await verifyArchive();
      if (!finalArchive.complete || finalArchive.digest !== current.archiveDigest) {
        await save({ phase: 'CREDENTIALS_REVOKED', archiveDigest: null, archiveObjects: 0, reason: 'ARCHIVE_CHANGED' }); return current;
      }
      requireValue(actions.fenced() && !actions.pendingAttemptEffects(), 'CLEANUP_EFFECTS_UNSETTLED', 409);
      await save({ phase: 'DELETE_MAY_HAVE_DISPATCHED', reason: null });
      let acknowledged: boolean;
      try { acknowledged = await actions.deleteRepository(); }
      catch { await save({ reason: 'DELETE_OUTCOME_UNKNOWN' }); return current; }
      await save({ deleteAcknowledged: acknowledged });
    }
    if (current.phase === 'DELETE_MAY_HAVE_DISPATCHED') {
      if (await actions.repositoryPresent()) {
        await save({ reason: 'WAITING_FOR_REPOSITORY_ABSENCE' }); return current;
      }
      await save({ phase: 'TOMBSTONED', tombstonedAt: actions.now(), reason: 'REPOSITORY_ABSENCE_OBSERVED' });
    }
    return current;
  } catch (error) {
    if (error instanceof CleanupArchiveFailure || error instanceof PlatformError && ['CLEANUP_ASSOCIATION_CONFLICT', 'CLEANUP_REPOSITORY_DENIED'].includes(error.code)) {
      await save({ phase: 'RECOVERY_HOLD', reason: error.code }); return current;
    }
    throw error;
  }
}

export interface CleanupArchiveCursor { inventoryDigest: string; next: number; total: number }
export interface CleanupArchiveResult { complete: boolean; digest: string; objects: number; cursor: CleanupArchiveCursor }

/** Bounded read-only archival work; the authority persists its cursor between alarms. */
export async function verifyCleanupArchive(sources: RepositorySnapshot[], observationDigests: string[], objects: ObjectStore, cursor?: CleanupArchiveCursor | null, maximumSteps = 32): Promise<CleanupArchiveResult> {
  requireValue(sources.length <= 64 && observationDigests.length <= 256, 'CLEANUP_ARCHIVE_LIMIT', 413);
  requireValue(Number.isSafeInteger(maximumSteps) && maximumSteps > 0 && maximumSteps <= 64, 'INVALID_ARCHIVE_BATCH', 400);
  const orderedSources = [...sources].sort((a, b) => canonicalize([a.commit, a.manifestDigest, a.objectsDigest]).localeCompare(canonicalize([b.commit, b.manifestDigest, b.objectsDigest])));
  const references = new Map<string, number>(); const allObjects = new Set<string>();
  for (const source of orderedSources) {
    allObjects.add(source.manifestDigest); allObjects.add(source.objectsDigest);
    for (const entry of source.manifest.entries) { references.set(entry.digest, MAX_FILE_BYTES); allObjects.add(entry.digest); }
  }
  for (const reference of observationDigests) { references.set(reference, MAX_FILE_BYTES); allObjects.add(reference); }
  const orderedReferences = [...references].sort(([a], [b]) => a.localeCompare(b));
  // Hash bounded segments so the inventory for many full supported trees does
  // not itself exceed the kernel's maximum single JSON input size.
  const segments: string[] = [];
  for (let start = 0; start < orderedReferences.length; start += 512) segments.push(await digest(orderedReferences.slice(start, start + 512)));
  const inventoryDigest = await digest({ sources: orderedSources.map(source => ({ commit: source.commit, parent: source.parent, commitBytesDigest: source.commitBytesDigest, manifestDigest: source.manifestDigest, objectsDigest: source.objectsDigest })), referenceSegments: segments });
  const total = orderedSources.length + orderedReferences.length;
  let next = cursor?.inventoryDigest === inventoryDigest ? cursor.next : 0;
  requireValue(Number.isSafeInteger(next) && next >= 0 && next <= total && (cursor?.inventoryDigest !== inventoryDigest || cursor.total === total), 'INVALID_ARCHIVE_CURSOR', 409);
  const end = Math.min(total, next + maximumSteps);
  for (; next < end; next++) {
    if (next < orderedSources.length) {
      const source = orderedSources[next]!;
      const manifest = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(await objects.get(source.manifestDigest, MAX_MANIFEST_BYTES)));
      requireValue(canonicalize(manifest) === canonicalize(source.manifest), 'ARCHIVED_MANIFEST_MISMATCH', 409);
      const gitObjects = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(await objects.get(source.objectsDigest, 8 * 1024 * 1024))) as GitObject[];
      requireValue(Array.isArray(gitObjects), 'ARCHIVED_SOURCE_OBJECTS_INVALID', 409);
      const result = JSON.parse(getKernel().validate_git_source(canonicalize({ candidate: { id: 'retained-cleanup-source', digest: source.objectsDigest, commit: source.commit, commitBytesDigest: source.commitBytesDigest, parent: source.parent ?? "", manifestDigest: source.manifestDigest }, manifest: source.manifest, gitObjects })));
      requireValue(result.valid, result.reason || 'ARCHIVED_SOURCE_INVALID', 409);
    } else {
      const [reference, maximum] = orderedReferences[next - orderedSources.length]!;
      await objects.get(reference, maximum);
    }
  }
  return { complete: next === total, digest: inventoryDigest, objects: allObjects.size, cursor: { inventoryDigest, next, total } };
}

/** Convenience for bounded local checks; production uses one cursor batch per alarm. */
export async function verifyCleanupSources(sources: RepositorySnapshot[], observationDigests: string[], objects: ObjectStore): Promise<{ digest: string; objects: number }> {
  let result = await verifyCleanupArchive(sources, observationDigests, objects);
  while (!result.complete) result = await verifyCleanupArchive(sources, observationDigests, objects, result.cursor);
  return { digest: result.digest, objects: result.objects };
}
