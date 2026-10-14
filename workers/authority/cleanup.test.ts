// SPDX-License-Identifier: Apache-2.0
import test, { before } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeKernel } from '../../packages/protocol/src/node';
import { canonicalize, decodeBase64, digest, encodeBase64 } from '../../packages/protocol/src/index';
import { advanceCleanup, verifyCleanupArchive, verifyCleanupSources, type CleanupActions, type CleanupRecord } from './cleanup';
import { ArtifactsRepository, type RepositorySnapshot } from './artifacts';
import { ObjectStore } from '../shared/objects';
import { PlatformError } from '../shared/errors';

before(initializeKernel);
const scope = { schemaVersion: 1 as const, tenantId: 'owned-test', projectId: 'cleanup', projectIncarnation: 'one' };
const archiveDigest = 'sha256:' + 'a'.repeat(64);
function record(): CleanupRecord {
  return { id: 'cleanup-one', scope, attemptId: 'one', generation: '1', repository: 'attempt-one', phase: 'STOP_REQUESTED', terminationObserved: false, credentialsRevoked: false, auxiliaryResources: null, archiveDigest: null, archiveObjects: 0, deleteAcknowledged: false, tombstonedAt: null, reason: null };
}
function fixture() {
  const observed = { stopped: false, pending: false, present: true, revoked: true, archive: true, deletes: 0, lostDelete: false };
  const saved: CleanupRecord[] = []; const trace: string[] = [];
  const actions: CleanupActions = {
    fenced: () => true, terminationObserved: async () => observed.stopped,
    pendingAttemptEffects: () => observed.pending, repositoryPresent: async () => observed.present,
    revokeCredentials: async () => { trace.push('revoke'); return observed.revoked; },
    removeAuxiliaryResources: async () => 'NOT_CONFIGURED',
    verifyArchive: async () => ({ complete: observed.archive, digest: archiveDigest, objects: 4 }),
    deleteRepository: async () => { trace.push('delete'); observed.deletes++; if (observed.lostDelete) throw new Error('owned lost acknowledgment'); return true; },
    save: async value => { trace.push(value.phase); saved.push(structuredClone(value)); }, now: () => 1000,
  };
  return { observed, saved, trace, actions };
}

test('cleanup waits for whole-generation stop and admitted attempt effects before revocation or deletion', async () => {
  const f = fixture(); let value = await advanceCleanup(record(), f.actions);
  assert.equal(value.phase, 'STOP_REQUESTED'); assert.equal(f.observed.deletes, 0); assert(!f.trace.includes('revoke'));
  f.observed.stopped = true; f.observed.pending = true;
  value = await advanceCleanup(value, f.actions);
  assert.equal(value.phase, 'STOP_REQUESTED'); assert(!f.trace.includes('revoke'));
  f.observed.pending = false; f.observed.archive = false;
  value = await advanceCleanup(value, f.actions);
  assert.equal(value.phase, 'CREDENTIALS_REVOKED'); assert.equal(value.reason, 'REQUIRED_ARCHIVE_INCOMPLETE'); assert.equal(f.observed.deletes, 0);
});

test('a deletion acknowledgment never proves absence and repeated observation never dispatches another delete', async () => {
  const f = fixture(); f.observed.stopped = true;
  let value = await advanceCleanup(record(), f.actions);
  assert.equal(value.phase, 'DELETE_MAY_HAVE_DISPATCHED'); assert.equal(value.deleteAcknowledged, true); assert.equal(f.observed.deletes, 1);
  assert(f.trace.indexOf('DELETE_MAY_HAVE_DISPATCHED') < f.trace.indexOf('delete'));
  value = await advanceCleanup(value, f.actions);
  assert.equal(value.phase, 'DELETE_MAY_HAVE_DISPATCHED'); assert.equal(f.observed.deletes, 1);
  f.observed.present = false; value = await advanceCleanup(value, f.actions);
  assert.equal(value.phase, 'TOMBSTONED'); assert.equal(value.tombstonedAt, 1000);
  await advanceCleanup(value, f.actions); assert.equal(f.observed.deletes, 1);
});

test('lost delete response retains dispatch uncertainty across controller reconstruction', async () => {
  const f = fixture(); f.observed.stopped = true; f.observed.lostDelete = true;
  const result = await advanceCleanup(record(), f.actions);
  assert.equal(result.phase, 'DELETE_MAY_HAVE_DISPATCHED'); assert.equal(result.reason, 'DELETE_OUTCOME_UNKNOWN');
  const retained = JSON.parse(JSON.stringify(f.saved.at(-1))) as CleanupRecord;
  await advanceCleanup(retained, f.actions); assert.equal(f.observed.deletes, 1);
  f.observed.present = false;
  assert.equal((await advanceCleanup(retained, f.actions)).phase, 'TOMBSTONED'); assert.equal(f.observed.deletes, 1);
});

test('failed durable preparation prevents deletion and a changed archive must be reverified', async () => {
  const f = fixture(); f.observed.stopped = true;
  const save = f.actions.save;
  f.actions.save = async value => { if (value.phase === 'DELETE_MAY_HAVE_DISPATCHED') throw new Error('owned durable write failure'); await save(value); };
  await assert.rejects(advanceCleanup(record(), f.actions), /durable write failure/); assert.equal(f.observed.deletes, 0);
  const retained = f.saved.at(-1)!; assert.equal(retained.phase, 'ARCHIVE_VERIFIED');
  f.actions.verifyArchive = async () => ({ complete: true, digest: 'sha256:' + 'b'.repeat(64), objects: 4 });
  const changed = await advanceCleanup(retained, f.actions);
  assert.equal(changed.phase, 'CREDENTIALS_REVOKED'); assert.equal(changed.archiveDigest, null); assert.equal(f.observed.deletes, 0);
});

test('a dependency added during the final provider read invalidates archive permission to delete', async () => {
  const f = fixture(); f.observed.stopped = true;
  let changed = false;
  f.actions.repositoryPresent = async () => { changed = true; return true; };
  f.actions.verifyArchive = async () => ({ complete: true, digest: changed ? 'sha256:' + 'b'.repeat(64) : archiveDigest, objects: changed ? 5 : 4 });
  const result = await advanceCleanup(record(), f.actions);
  assert.equal(result.phase, 'CREDENTIALS_REVOKED'); assert.equal(result.reason, 'ARCHIVE_CHANGED');
  assert.equal(result.archiveDigest, null); assert.equal(f.observed.deletes, 0);
  const retried = await advanceCleanup(result, f.actions);
  assert.equal(retried.phase, 'DELETE_MAY_HAVE_DISPATCHED'); assert.equal(f.observed.deletes, 1);
});

test('resource association conflict enters recovery hold and a lost current fence prevents mutation', async () => {
  const f = fixture(); f.observed.stopped = true;
  f.actions.revokeCredentials = async () => { throw new PlatformError('CLEANUP_ASSOCIATION_CONFLICT', 409); };
  const value = await advanceCleanup(record(), f.actions);
  assert.equal(value.phase, 'RECOVERY_HOLD'); assert.equal(f.observed.deletes, 0);
  f.actions.fenced = () => false;
  await assert.rejects(advanceCleanup(record(), f.actions), /CLEANUP_ADMISSIONS_NOT_FENCED/); assert.equal(f.observed.deletes, 0);
});

test('permanent archive failures durably hold cleanup, retaining their reason and preventing repeated effects', async () => {
  for (const [code, status] of [['REQUIRED_OBJECT_MISSING', 409], ['OBJECT_DIGEST_MISMATCH', 409], ['CLEANUP_ARCHIVE_LIMIT', 413]] as const) {
    const f = fixture(); f.observed.stopped = true; let reads = 0;
    f.actions.verifyArchive = async () => { reads++; throw new PlatformError(code, status); };
    const held = await advanceCleanup(record(), f.actions);
    assert.equal(held.phase, 'RECOVERY_HOLD'); assert.equal(held.reason, code);
    assert.equal(held.credentialsRevoked, true); assert.equal(f.observed.deletes, 0);
    assert.deepEqual(f.saved.at(-1), held);
    assert.deepEqual(await advanceCleanup(held, f.actions), held); assert.equal(reads, 1);
  }
});

test('archive timeouts and throttling stay retryable while final revalidation corruption holds deletion', async () => {
  for (const [code, status] of [['OBJECT_STORE_DEADLINE_EXCEEDED', 503], ['RETRY_LATER', 429]] as const) {
    const f = fixture(); f.observed.stopped = true;
    f.actions.verifyArchive = async () => { throw new PlatformError(code, status); };
    await assert.rejects(advanceCleanup(record(), f.actions), { code, status });
    assert.equal(f.saved.at(-1)!.phase, 'CREDENTIALS_REVOKED'); assert.equal(f.observed.deletes, 0);
    f.actions.verifyArchive = async () => ({ complete: true, digest: archiveDigest, objects: 4 });
    assert.equal((await advanceCleanup(f.saved.at(-1)!, f.actions)).phase, 'DELETE_MAY_HAVE_DISPATCHED');
  }
  const f = fixture(); f.observed.stopped = true; let reads = 0;
  f.actions.verifyArchive = async () => { if (++reads === 3) throw new PlatformError('RECEIPT_JOURNAL_MISMATCH', 409); return { complete: true, digest: archiveDigest, objects: 4 }; };
  const held = await advanceCleanup(record(), f.actions);
  assert.equal(held.phase, 'RECOVERY_HOLD'); assert.equal(held.reason, 'RECEIPT_JOURNAL_MISMATCH'); assert.equal(f.observed.deletes, 0);
});

test('repository cleanup rejects canonical/foreign targets and requires a complete post-revocation token inventory', async () => {
  let gets = 0, deletes = 0; let active = true, complete = true;
  const repo = {
    info: async () => ({ name: 'attempt-one', description: 'Confidence attempt attempt-one from canonical' }),
    listTokens: async () => ({ total: complete ? 1 : 2, tokens: [{ id: 'owned-token', state: active ? 'active' : 'revoked' }] }),
    revokeToken: async () => { active = false; return true; }, [Symbol.dispose]() {},
  };
  const adapter = new ArtifactsRepository({ get: async () => { gets++; return repo; }, delete: async () => { deletes++; return true; } } as unknown as Artifacts, {} as ObjectStore);
  await assert.rejects(adapter.deleteAttempt('attempt-one', 'one', 'attempt-one'), /CLEANUP_REPOSITORY_DENIED/); assert.equal(gets, 0);
  await assert.rejects(adapter.deleteAttempt('canonical', 'one', 'somebody-else'), /CLEANUP_REPOSITORY_DENIED/); assert.equal(gets, 0);
  complete = false;
  await assert.rejects(adapter.revokeAttemptCredentials('canonical', 'one', 'attempt-one'), /CLEANUP_TOKEN_INVENTORY_INCOMPLETE/); assert.equal(active, true);
  complete = true; assert.equal(await adapter.revokeAttemptCredentials('canonical', 'one', 'attempt-one'), true); assert.equal(active, false);
  assert.equal(await adapter.deleteAttempt('canonical', 'one', 'attempt-one'), true); assert.equal(deletes, 1);
  const tokens = Array.from({ length: 33 }, (_, index) => ({ id: `token-${index}`, state: 'active' }));
  let revocations = 0;
  const many = { ...repo, listTokens: async () => ({ total: tokens.length, tokens }), revokeToken: async (id: string) => { tokens.find(token => token.id === id)!.state = 'revoked'; revocations++; return true; } };
  const batched = new ArtifactsRepository({ get: async () => many } as unknown as Artifacts, {} as ObjectStore);
  assert.equal(await batched.revokeAttemptCredentials('canonical', 'one', 'attempt-one'), false); assert.equal(revocations, 32);
  assert.equal(await batched.revokeAttemptCredentials('canonical', 'one', 'attempt-one'), true); assert.equal(revocations, 33);
});

test('archival reads verify actual Git closure, separately retained file bytes and protected observations', async () => {
  const bundle = JSON.parse(await readFile(new URL('../../fixtures/protocol/valid-bundle.json', import.meta.url), 'utf8'));
  const data = new Map<string, Uint8Array>();
  const store = new ObjectStore({
    head: async (key: string) => data.has(key) ? {} : null,
    put: async (key: string, bytes: Uint8Array) => { data.set(key, bytes.slice()); },
    get: async (key: string) => { const bytes = data.get(key); return bytes ? { size: bytes.length, body: new Blob([bytes.slice().buffer]).stream() } : null; },
  } as unknown as R2Bucket);
  const { candidate } = bundle.inputs.witness;
  const source: RepositorySnapshot = { ...candidate, manifest: bundle.inputs.manifest, objects: [], objectsDigest: await store.put(new TextEncoder().encode(canonicalize(bundle.inputs.gitObjects))) };
  await store.put(new TextEncoder().encode(canonicalize(source.manifest)), source.manifestDigest);
  for (const object of bundle.inputs.gitObjects) if (object.type === 'blob') await store.put(decodeBase64(object.dataBase64));
  for (const observation of bundle.inputs.observations) await store.put(decodeBase64(observation.dataBase64), observation.digest);
  const references = bundle.inputs.observations.map((item: { digest: string }) => item.digest);
  const proof = await verifyCleanupSources([source], references, store); assert.equal(proof.objects, 4);
  // RepositorySnapshot represents a root commit with null; the kernel's
  // candidate representation deliberately uses the empty parent string.
  const originalCommit = bundle.inputs.gitObjects.find((item: { type: string }) => item.type === 'commit');
  const rootBytes = new TextEncoder().encode(Buffer.from(decodeBase64(originalCommit.dataBase64)).toString().replace(/^parent [a-f0-9]{40}\n/m, ''));
  const rootOid = createHash('sha1').update(`commit ${rootBytes.length}\0`).update(rootBytes).digest('hex');
  const rootObjects = bundle.inputs.gitObjects.map((item: { type: string }) => item.type === 'commit' ? { type: 'commit', oid: rootOid, dataBase64: encodeBase64(rootBytes) } : item);
  const rootSource = { ...source, commit: rootOid, parent: null, commitBytesDigest: await store.put(rootBytes), objectsDigest: await store.put(new TextEncoder().encode(canonicalize(rootObjects))) };
  assert.equal((await verifyCleanupSources([rootSource], references, store)).objects, 4);
  data.delete(store.key(source.manifest.entries[0]!.digest));
  await assert.rejects(verifyCleanupSources([source], references, store), /REQUIRED_OBJECT_MISSING/);
  await store.put(decodeBase64(bundle.inputs.gitObjects.find((item: { type: string }) => item.type === 'blob').dataBase64));
  const changed = structuredClone(source); changed.commitBytesDigest = await digest('interchanged raw source');
  await assert.rejects(verifyCleanupSources([changed], references, store), /COMMIT_BYTES_DIGEST_MISMATCH/);
});

test('a complete supported 2048-file tree archives in bounded batches and inventory changes reset its cursor', async () => {
  const data = new Map<string, Uint8Array>(); let reads = 0;
  const store = new ObjectStore({
    head: async (key: string) => data.has(key) ? {} : null,
    put: async (key: string, bytes: Uint8Array) => { data.set(key, bytes.slice()); },
    get: async (key: string) => { reads++; const bytes = data.get(key); return bytes ? { size: bytes.length, body: new Blob([bytes.slice().buffer]).stream() } : null; },
  } as unknown as R2Bucket);
  const empty = { schemaVersion: 1 as const, pathProfile: 'portable-ascii-v1' as const, entries: [] };
  const base: RepositorySnapshot = { commit: 'a'.repeat(40), parent: null, commitBytesDigest: archiveDigest, manifest: empty, manifestDigest: await digest(empty), objects: [], objectsDigest: archiveDigest };
  const entries = [];
  for (let index = 0; index < 2048; index++) {
    const bytes = new TextEncoder().encode(`retained file ${index}\n`);
    entries.push({ path: `files/${String(index).padStart(4, '0')}.txt`, mode: index % 2 ? '100644' as const : '100755' as const, bytes: String(bytes.length), digest: await store.put(bytes) });
  }
  const submission = { ...base, manifest: { ...empty, entries } };
  const adapter = new ArtifactsRepository({} as Artifacts, store);
  const source = await adapter.materialize(base, [{ id: 'large-owned-source', source: submission, base }], 'large-archive', 1791150000);
  reads = 0;
  let result = await verifyCleanupArchive([source], [], store, null, 32);
  assert.equal(result.complete, false); assert.equal(result.cursor.next, 32); assert(reads <= 64);
  let batches = 1;
  while (!result.complete) { reads = 0; result = await verifyCleanupArchive([source], [], store, result.cursor, 32); assert(reads <= 64); batches++; }
  assert.equal(result.objects, 2050); assert(batches > 60);
  const observation = await store.put(new TextEncoder().encode('new protected observation'));
  reads = 0;
  const changed = await verifyCleanupArchive([source], [observation], store, result.cursor, 32);
  assert.equal(changed.complete, false); assert.equal(changed.cursor.next, 32); assert.notEqual(changed.cursor.inventoryDigest, result.cursor.inventoryDigest); assert(reads <= 64);
});
