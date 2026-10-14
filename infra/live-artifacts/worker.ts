// SPDX-License-Identifier: Apache-2.0
import '../../workers/authority/kernel';
import * as git from 'isomorphic-git';
import { Volume, createFsFromVolume } from 'memfs';
import { ArtifactsRepository, buildReceivePack, parseReceivePack, validateRemote, type RepositorySnapshot } from '../../workers/authority/artifacts';
import { ObjectStore } from '../../workers/shared/objects';
import { readBounded, requireValue, digestBytes } from '../../workers/shared/errors';
import { canonicalize, encodeBase64, decodeBase64 } from '../../packages/protocol/src/index';
import type { GitObject, SourceManifest } from '../../packages/protocol/src/types';
import type { BindingSnapshot, Effect } from './types';
import { diagnosticContentType, diagnosticError, type SeedDiagnostics, type SeedStage } from './diagnostics';
import { requireSeedResponse, seedRequest } from './seed-transport';

interface Env {
  ARTIFACTS: Artifacts; OBJECTS: R2Bucket; CONTROL_TOKEN: string; RUN_ID: string; ACCOUNT_ID: string;
  NAMESPACE: string; SOURCE_SET_DIGEST: string; EXPIRES_AT: string; CANONICAL_NAME: string; ATTEMPT_ID: string;
}
const KEY = 'binding-check/snapshot.json';
const BINARY = new Uint8Array([0, 255, 128, 13, 10, 37]);
const reason = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_:-]{0,150}$/.test(error.message) ? error.message : 'BINDING_OPERATION_UNCONFIRMED';
const active = (env: Env) => requireValue(Number.isSafeInteger(Number(env.EXPIRES_AT)) && Date.now() < Number(env.EXPIRES_AT), 'CONTROL_EXPIRED', 403);
async function load(env: Env): Promise<BindingSnapshot | null> {
  const object = await env.OBJECTS.get(KEY);
  return object ? JSON.parse(new TextDecoder().decode(await readBounded(object.body, 256 * 1024))) as BindingSnapshot : null;
}
async function retain(env: Env, snapshot: BindingSnapshot): Promise<void> {
  await env.OBJECTS.put(KEY, JSON.stringify(snapshot));
}
async function effect<T>(env: Env, snapshot: BindingSnapshot, name: string, input: unknown, action: () => Promise<T>, summarize: (value: T) => unknown = () => ({ acknowledged: true })): Promise<T> {
  active(env);
  const item: Effect = { name, input, phase: 'MAY_HAVE_DISPATCHED' }; snapshot.effects.push(item); await retain(env, snapshot);
  try { const result = await action(); item.phase = 'ACKNOWLEDGED'; item.result = summarize(result); await retain(env, snapshot); return result; }
  catch (error) { item.phase = 'UNKNOWN'; item.reason = reason(error); await retain(env, snapshot); throw error; }
}
function check(snapshot: BindingSnapshot, name: string, passed: boolean, detail: unknown = {}): void {
  snapshot.checks.push({ name, status: passed ? 'PASS' : 'FAIL', detail });
  requireValue(passed, `CHECK_FAILED:${name}`);
}
async function fixture(store: ObjectStore, label: string, parent: string | null): Promise<RepositorySnapshot> {
  const fs = createFsFromVolume(new Volume()), dir = '/fixture'; await git.init({ fs, dir });
  const files = [{ path: 'binary.bin', mode: '100755' as const, bytes: BINARY }, { path: 'fixture.txt', mode: '100644' as const, bytes: new TextEncoder().encode(`Owned binding fixture ${label}\n`) }];
  const objects: GitObject[] = [], entries: SourceManifest['entries'] = [];
  const capture = async (oid: string, type: GitObject['type']) => {
    const raw = await git.readObject({ fs, dir, oid, format: 'content' });
    const bytes = new Uint8Array(raw.object as Uint8Array); objects.push({ oid, type, dataBase64: encodeBase64(bytes) }); return bytes;
  };
  const treeEntries: git.TreeEntry[] = [];
  for (const file of files) {
    const oid = await git.writeBlob({ fs, dir, blob: file.bytes }); await capture(oid, 'blob');
    entries.push({ path: file.path, mode: file.mode, bytes: String(file.bytes.length), digest: await store.put(file.bytes) });
    treeEntries.push({ path: file.path, mode: file.mode, type: 'blob', oid });
  }
  const tree = await git.writeTree({ fs, dir, tree: treeEntries }); await capture(tree, 'tree');
  const identity = { name: 'Owned binding check', email: 'binding@confidence.invalid', timestamp: 1791158400, timezoneOffset: 0 };
  const commit = await git.writeCommit({ fs, dir, commit: { tree, parent: parent ? [parent] : [], author: identity, committer: identity, message: `${label}\n` } });
  const commitBytes = await capture(commit, 'commit');
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries };
  objects.sort((a, b) => a.oid.localeCompare(b.oid));
  return { commit, parent, manifest, manifestDigest: await store.put(new TextEncoder().encode(canonicalize(manifest))),
    commitBytesDigest: await store.put(commitBytes), objects, objectsDigest: await store.put(new TextEncoder().encode(canonicalize(objects))) };
}
function exact(a: RepositorySnapshot, b: RepositorySnapshot): boolean {
  return a.commit === b.commit && a.parent === b.parent && a.commitBytesDigest === b.commitBytesDigest && a.manifestDigest === b.manifestDigest && a.objectsDigest === b.objectsDigest;
}
async function seed(env: Env, source: RepositorySnapshot, snapshot: BindingSnapshot): Promise<{ accepted: boolean; report: string }> {
  const item = snapshot.effects.at(-1); requireValue(item?.name === 'seed-baseline' && item.phase === 'MAY_HAVE_DISPATCHED', 'SEED_INTENT_REQUIRED');
  const diagnostics: SeedDiagnostics = { stages: [], revocation: 'NOT_CREATED' }; item.diagnostics = diagnostics;
  const stage = async <T>(name: SeedStage, action: () => Promise<T>, summarize?: (value: T) => Promise<Record<string, unknown>> | Record<string, unknown>): Promise<T> => {
    const started = Date.now(), observation: SeedDiagnostics['stages'][number] = { stage: name, state: 'MAY_HAVE_DISPATCHED', elapsedMs: 0 };
    diagnostics.stages.push(observation); await retain(env, snapshot);
    try {
      const result = await action(); observation.state = 'ACKNOWLEDGED'; observation.elapsedMs = Date.now() - started;
      if (summarize) observation.detail = await summarize(result);
      await retain(env, snapshot); return result;
    } catch (error) { observation.state = 'UNKNOWN'; observation.elapsedMs = Date.now() - started; observation.error = await diagnosticError(error); await retain(env, snapshot); throw error; }
  };
  let repo: ArtifactsRepo | undefined, token: ArtifactsCreateTokenResult | undefined, result: { accepted: boolean; report: string } | undefined;
  let failed = false, failure: unknown;
  try {
    await stage('get-repository', async () => { repo = await env.ARTIFACTS.get(env.CANONICAL_NAME); });
    const remote = await stage('read-info', async () => {
      const info = await repo!.info(), remote = validateRemote(info.remote);
      requireValue(remote.hostname === `${env.ACCOUNT_ID}.artifacts.cloudflare.net` && remote.pathname === `/git/${env.NAMESPACE}/${env.CANONICAL_NAME}.git`, 'REMOTE_ASSOCIATION'); return remote;
    });
    const bytes = await stage('prepare-pack', async () => {
      const fs = createFsFromVolume(new Volume()), dir = '/seed'; await git.init({ fs, dir });
      for (const object of source.objects) requireValue(await git.writeObject({ fs, dir, type: object.type, object: decodeBase64(object.dataBase64), format: 'content' }) === object.oid, 'OBJECT_IDENTITY');
      const packed = await git.packObjects({ fs, dir, oids: source.objects.map(object => object.oid) }); requireValue(packed.packfile, 'PACK_REQUIRED');
      return buildReceivePack('0'.repeat(40), source.commit, 'refs/heads/main', packed.packfile);
    }, async bytes => ({ bytes: bytes.length, requestDigest: await digestBytes(bytes), objects: source.objects.length }));
    await stage('create-token', async () => { token = await repo!.createToken('write', 60); }, () => ({
      requestedTtlSeconds: 60, writeScope: token?.scope === 'write', plaintextPresentAndBounded: typeof token?.plaintext === 'string' && token.plaintext.length > 0 && token.plaintext.length <= 16384 && !/[\s\x00-\x1f\x7f]/.test(token.plaintext), expiryParseable: Number.isFinite(Date.parse(token?.expiresAt ?? '')),
    }));
    const response = await stage('receive-pack-fetch', () => fetch(seedRequest(remote, token!.plaintext, bytes)), response => ({ status: response.status, contentType: diagnosticContentType(response.headers.get('content-type')) }));
    requireSeedResponse(response);
    const body = await stage('receive-pack-body', () => readBounded(response.body, 64 * 1024), async bytes => ({ bytes: bytes.length, responseDigest: await digestBytes(bytes) }));
    result = await stage('parse-report', async () => {
      const parsed = parseReceivePack(body, 'refs/heads/main'); requireValue(response.ok && parsed.accepted, 'BASELINE_SEED_UNCONFIRMED'); return { accepted: parsed.accepted, report: parsed.reason };
    });
  } catch (error) { failed = true; failure = error; diagnostics.primaryError = await diagnosticError(error); }
  finally {
    if (repo && token) {
      diagnostics.revocation = 'MAY_HAVE_DISPATCHED';
      try { await stage('revoke-token', async () => { requireValue(await repo!.revokeToken(token!.plaintext), 'SEED_TOKEN_REVOCATION_UNCONFIRMED'); }); diagnostics.revocation = 'ACKNOWLEDGED'; }
      catch (error) { diagnostics.revocation = 'UNKNOWN'; diagnostics.revocationError = await diagnosticError(error); if (!failed) { failed = true; failure = error; } }
    }
    if (repo) {
      try { await stage('release-handle', async () => { repo![Symbol.dispose](); }); }
      catch (error) { diagnostics.releaseError = await diagnosticError(error); if (!failed) { failed = true; failure = error; } }
    }
    await retain(env, snapshot);
  }
  if (failed) throw failure;
  requireValue(result, 'SEED_RESULT_MISSING'); return result;
}
async function noActiveTokens(env: Env, name: string): Promise<boolean> {
  using repo = await env.ARTIFACTS.get(name); const tokens = await repo.listTokens();
  return tokens.total === tokens.tokens.length && tokens.total <= 128 && tokens.tokens.every(token => token.state === 'expired' || token.state === 'revoked');
}
async function absent(env: Env, name: string): Promise<boolean> {
  try { using repo = await env.ARTIFACTS.get(name); await repo.info(); return false; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'NOT_FOUND') return true; throw error; }
}
async function run(env: Env, snapshot: BindingSnapshot): Promise<void> {
  const store = new ObjectStore(env.OBJECTS), repository = new ArtifactsRepository(env.ARTIFACTS, store);
  const base = await fixture(store, 'baseline', null), desired = await fixture(store, 'unpublished-change', base.commit);
  const created = await effect(env, snapshot, 'create-canonical', { name: snapshot.canonicalName }, () => env.ARTIFACTS.create(snapshot.canonicalName, { description: `Confidence binding check ${env.RUN_ID}`, setDefaultBranch: 'main', readOnly: false }), value => ({ id: value.id, name: value.name, remote: value.remote }));
  snapshot.canonicalId = created.id; await retain(env, snapshot);
  { using repo = await env.ARTIFACTS.get(snapshot.canonicalName); requireValue(await repo.revokeToken(created.token), 'INITIAL_CREDENTIAL_REVOCATION'); }
  await effect(env, snapshot, 'seed-baseline', { oldHead: '0'.repeat(40), newHead: base.commit, ref: 'refs/heads/main', objectsDigest: base.objectsDigest }, () => seed(env, base, snapshot));
  const ingested = await effect(env, snapshot, 'ingest-baseline', { commit: base.commit }, () => repository.ingest(snapshot.canonicalName, 'main', base.commit), value => ({ commit: value.commit, manifestDigest: value.manifestDigest, objectsDigest: value.objectsDigest }));
  check(snapshot, 'binding-source-ingest-exact', exact(base, ingested), { commit: base.commit, commitBytesDigest: base.commitBytesDigest, objectsDigest: base.objectsDigest });
  const binary = ingested.manifest.entries.find(entry => entry.path === 'binary.bin'); requireValue(binary, 'BINARY_ENTRY_MISSING');
  { using repo = await env.ARTIFACTS.get(snapshot.canonicalName); const tree = await repo.readCommit(base.commit); requireValue(tree, 'BASELINE_COMMIT_MISSING');
    const blob = ingested.objects.find(object => object.type === 'blob' && object.dataBase64 === encodeBase64(BINARY)); requireValue(blob, 'BINARY_BLOB_MISSING');
    const fromBinding = await repo.readBlob(blob.oid); requireValue(fromBinding, 'BINARY_BLOB_MISSING');
    check(snapshot, 'binding-blob-bytes-and-modes', fromBinding instanceof Blob && binary.mode === '100755' && ingested.manifest.entries.some(entry => entry.mode === '100644') && await digestBytes(new Uint8Array(await fromBinding.arrayBuffer())) === binary.digest, { bytes: fromBinding.size, mode: binary.mode, digest: binary.digest }); }
  const candidate = await effect(env, snapshot, 'materialize-candidate', { base: base.commit, desired: desired.commit }, () => repository.materialize(ingested, [{ id: 'desired', source: desired, base: ingested }], 'binding-candidate', 1791158401), value => ({ commit: value.commit, objectsDigest: value.objectsDigest }));
  check(snapshot, 'r2-materialization-exact', candidate.parent === base.commit && canonicalize(candidate.manifest) === canonicalize(desired.manifest), { parent: candidate.parent, commit: candidate.commit, manifestDigest: candidate.manifestDigest });
  const operation = { oldHead: base.commit, newHead: candidate.commit, canonicalRef: 'refs/heads/main', objectsDigest: candidate.objectsDigest };
  const published = await effect(env, snapshot, 'publish-candidate', operation, () => repository.conditionalPublish(snapshot.canonicalName, operation), value => value);
  const publishedSource = await repository.ingest(snapshot.canonicalName, 'main', candidate.commit);
  check(snapshot, 'binding-conditional-publication-observed', published.accepted && exact(candidate, publishedSource), { ...operation, result: published });
  const duplicate = await effect(env, snapshot, 'repeat-frozen-publication', operation, () => repository.conditionalPublish(snapshot.canonicalName, operation), value => value);
  const duplicateHead = await repository.head(snapshot.canonicalName, 'refs/heads/main');
  check(snapshot, 'binding-duplicate-retains-frozen-head', duplicateHead === candidate.commit, { ...operation, result: duplicate, observedHead: duplicateHead });
  const children = await Promise.all(['race-one', 'race-two'].map(id => repository.materialize(candidate, [{ id, source: desired, base: desired }], id, 1791158402)));
  const raceOperations = children.map(child => ({ oldHead: candidate.commit, newHead: child.commit, canonicalRef: 'refs/heads/main', objectsDigest: child.objectsDigest }));
  // One durable intent covers both sends so concurrent persistence cannot erase
  // an earlier fence. A missing outcome leaves the whole finite race UNKNOWN.
  const race = await effect(env, snapshot, 'race-frozen-publications', raceOperations, async () => {
    const outcomes = await Promise.allSettled(raceOperations.map(input => repository.conditionalPublish(snapshot.canonicalName, input)));
    return outcomes.map(outcome => outcome.status === 'fulfilled' ? { observed: true, ...outcome.value } : { observed: false, accepted: false, report: reason(outcome.reason) });
  }, value => value);
  const winner = race.findIndex(result => result.observed && result.accepted), loser = winner === 0 ? 1 : 0;
  requireValue(winner >= 0, 'RACE_WINNER_MISSING');
  const raceHead = await repository.head(snapshot.canonicalName, 'refs/heads/main');
  check(snapshot, 'binding-race-single-winner', race.every(result => result.observed) && race.filter(result => result.accepted).length === 1 && raceHead === children[winner].commit, { operations: raceOperations, results: race, observedHead: raceHead, expectedHead: children[winner].commit });
  const retried = await effect(env, snapshot, 'retry-frozen-loser', raceOperations[loser], () => repository.conditionalPublish(snapshot.canonicalName, raceOperations[loser]), value => value);
  const loserRetryHead = await repository.head(snapshot.canonicalName, 'refs/heads/main');
  check(snapshot, 'binding-loser-retry-fixed-base', !retried.accepted && loserRetryHead === children[winner].commit, { operation: raceOperations[loser], result: retried, observedHead: loserRetryHead, expectedHead: children[winner].commit });
  await effect(env, snapshot, 'fork-current-canonical', { canonicalName: snapshot.canonicalName, attemptName: snapshot.attemptName }, () => repository.fork(snapshot.canonicalName, snapshot.attemptName), value => value);
  const forkHead = await repository.head(snapshot.attemptName, 'refs/heads/main');
  check(snapshot, 'binding-fork-observes-current-head', forkHead === children[winner].commit, { frozenPublicationBase: base.commit, expectedHead: children[winner].commit, observedHead: forkHead });
  const initialWorkHead = await repository.head(snapshot.attemptName, 'refs/heads/confidence-work');
  requireValue(initialWorkHead === null, 'WORK_REF_ALREADY_PRESENT');
  await effect(env, snapshot, 'install-unpublished-work-ref', { attemptName: snapshot.attemptName, commit: desired.commit, objectsDigest: desired.objectsDigest, initialWorkHead }, () => repository.installWorkRef(snapshot.attemptName, desired));
  const installedWorkHead = await repository.head(snapshot.attemptName, 'refs/heads/confidence-work');
  const transferred = await repository.ingest(snapshot.attemptName, 'confidence-work', desired.commit);
  check(snapshot, 'binding-unpublished-work-ref-roundtrip', initialWorkHead === null && installedWorkHead === desired.commit && exact(desired, transferred), { commit: desired.commit, publicationBase: base.commit, objectsDigest: desired.objectsDigest, initialWorkHead, observedHead: installedWorkHead });
  const canonicalAfterWorkHead = await repository.head(snapshot.canonicalName, 'refs/heads/main'), attemptAfterWorkHead = await repository.head(snapshot.attemptName, 'refs/heads/main');
  check(snapshot, 'binding-canonical-unchanged-by-work-ref', canonicalAfterWorkHead === children[winner].commit && attemptAfterWorkHead === children[winner].commit, { canonicalHead: canonicalAfterWorkHead, attemptMainHead: attemptAfterWorkHead, expectedHead: children[winner].commit });
  const revoked = await effect(env, snapshot, 'revoke-attempt-credentials', { attemptName: snapshot.attemptName }, () => repository.revokeAttemptCredentials(snapshot.canonicalName, snapshot.attemptId, snapshot.attemptName));
  check(snapshot, 'binding-token-revocation-observed', revoked && await noActiveTokens(env, snapshot.canonicalName) && await noActiveTokens(env, snapshot.attemptName));
  check(snapshot, 'binding-journaled-effects-resolved', snapshot.effects.every(item => item.phase === 'ACKNOWLEDGED'), { effects: snapshot.effects.length });
  snapshot.status = 'PASS'; snapshot.completedAt = new Date().toISOString(); await retain(env, snapshot);
}
async function cleanup(env: Env, snapshot: BindingSnapshot): Promise<void> {
  requireValue(snapshot.status !== 'RUNNING', 'RUN_STILL_ACTIVE', 409);
  const repository = new ArtifactsRepository(env.ARTIFACTS, new ObjectStore(env.OBJECTS));
  if (!await absent(env, snapshot.attemptName)) {
    requireValue(await repository.revokeAttemptCredentials(snapshot.canonicalName, snapshot.attemptId, snapshot.attemptName), 'ATTEMPT_REVOCATION_UNCONFIRMED');
    if (!snapshot.effects.some(item => item.name === 'delete-attempt')) await effect(env, snapshot, 'delete-attempt', { name: snapshot.attemptName }, () => repository.deleteAttempt(snapshot.canonicalName, snapshot.attemptId, snapshot.attemptName));
  }
  if (!await absent(env, snapshot.canonicalName)) {
    using repo = await env.ARTIFACTS.get(snapshot.canonicalName); const info = await repo.info();
    requireValue(info.name === snapshot.canonicalName && info.description === `Confidence binding check ${env.RUN_ID}` && (!snapshot.canonicalId || info.id === snapshot.canonicalId), 'CLEANUP_ASSOCIATION');
    const tokens = await repo.listTokens(); requireValue(tokens.total === tokens.tokens.length && tokens.total <= 128, 'TOKEN_INVENTORY_INCOMPLETE');
    for (const token of tokens.tokens.filter(token => token.state === 'active')) await repo.revokeToken(token.id);
    requireValue(await noActiveTokens(env, snapshot.canonicalName), 'CANONICAL_REVOCATION_UNCONFIRMED');
    if (!snapshot.effects.some(item => item.name === 'delete-canonical')) await effect(env, snapshot, 'delete-canonical', { name: snapshot.canonicalName, id: info.id }, () => env.ARTIFACTS.delete(snapshot.canonicalName));
  }
  await reconcileCleanup(env, snapshot);
}
async function reconcileCleanup(env: Env, snapshot: BindingSnapshot): Promise<void> {
  snapshot.cleanupComplete = await absent(env, snapshot.attemptName) && await absent(env, snapshot.canonicalName);
  if (snapshot.cleanupComplete) {
    for (const item of snapshot.effects) if (['delete-attempt', 'delete-canonical'].includes(item.name) && item.phase !== 'ACKNOWLEDGED') { item.phase = 'OBSERVED_ABSENT'; item.result = { absenceObservedAt: new Date().toISOString(), acknowledgmentClaimed: false }; }
    if (!snapshot.checks.some(item => item.name === 'owned-repositories-absent')) check(snapshot, 'owned-repositories-absent', true, { canonicalName: snapshot.canonicalName, attemptName: snapshot.attemptName, physicalErasureClaimed: false });
  }
  const resolved = snapshot.checks.find(item => item.name === 'binding-journaled-effects-resolved');
  if (resolved) { resolved.status = snapshot.effects.every(item => item.phase === 'ACKNOWLEDGED' || item.phase === 'OBSERVED_ABSENT') ? 'PASS' : 'FAIL'; resolved.detail = { effects: snapshot.effects.length, includesCleanup: true }; }
  await retain(env, snapshot);
}
async function archive(env: Env, snapshot: BindingSnapshot) {
  requireValue(snapshot.cleanupComplete, 'REPOSITORY_CLEANUP_REQUIRED', 409);
  const listed = await env.OBJECTS.list({ limit: 129 });
  requireValue(!listed.truncated && listed.objects.length <= 128, 'ARCHIVE_OBJECT_BOUND');
  let total = 0;
  const objects: { key: string; bytes: number; sha256: string; base64: string }[] = [];
  for (const item of listed.objects.sort((a, b) => a.key.localeCompare(b.key))) {
    requireValue(/^objects\/sha256\/[a-f0-9]{64}$/.test(item.key) || /^binding-check\/(snapshot\.json|run-claim|cleanup-claim|cleanup-finished)$/.test(item.key), 'ARCHIVE_FOREIGN_OBJECT');
    total += item.size; requireValue(total <= 2 * 1024 * 1024, 'ARCHIVE_BYTE_BOUND');
    const object = await env.OBJECTS.get(item.key); requireValue(object, 'ARCHIVE_OBJECT_MISSING');
    const bytes = await readBounded(object.body, 2 * 1024 * 1024);
    requireValue(bytes.length === item.size, 'ARCHIVE_OBJECT_CHANGED');
    objects.push({ key: item.key, bytes: bytes.length, sha256: await digestBytes(bytes), base64: encodeBase64(bytes) });
  }
  const body = { schemaVersion: 1, runId: env.RUN_ID, sourceSetDigest: env.SOURCE_SET_DIGEST, totalBytes: total, objects };
  return { ...body, archiveDigest: await digestBytes(new TextEncoder().encode(canonicalize(body))) };
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      active(env); requireValue(/^[a-f0-9]{64}$/.test(env.CONTROL_TOKEN) && request.headers.get('authorization') === `Bearer ${env.CONTROL_TOKEN}`, 'UNAUTHORIZED', 401);
      const url = new URL(request.url); requireValue(!url.search && !url.hash && (url.pathname === '/retire-objects' || Number(request.headers.get('content-length') || 0) <= 0), 'CLOSED_CONTROL_REQUEST');
      let snapshot = await load(env);
      if (url.pathname === '/object-inventory' && request.method === 'GET') { const inventory = await env.OBJECTS.list({ limit: 129 }); return Response.json({ runId: env.RUN_ID, keys: inventory.objects.map(item => item.key), truncated: inventory.truncated }); }
      if (url.pathname === '/archive' && request.method === 'GET') { requireValue(snapshot, 'RUN_NOT_STARTED', 409); return Response.json(await archive(env, snapshot)); }
      if (url.pathname === '/retire-objects' && request.method === 'POST') {
        requireValue(snapshot, 'RUN_NOT_STARTED', 409);
        const input = JSON.parse(new TextDecoder().decode(await readBounded(request.body, 1024))) as { archiveDigest?: string };
        requireValue(Object.keys(input).length === 1 && /^sha256:[a-f0-9]{64}$/.test(input.archiveDigest ?? ''), 'ARCHIVE_DIGEST_REQUIRED');
        const retained = await archive(env, snapshot); requireValue(input.archiveDigest === retained.archiveDigest, 'ARCHIVE_CHANGED', 409);
        const fence = retained.objects.find(item => item.key === 'binding-check/run-claim'); requireValue(fence, 'RUN_FENCE_MISSING');
        const deletedKeys = retained.objects.filter(item => item.key !== fence.key).map(item => item.key);
        active(env); await env.OBJECTS.delete(deletedKeys);
        const after = await env.OBJECTS.list({ limit: 2 }); requireValue(!after.truncated && after.objects.length === 1 && after.objects[0].key === fence.key, 'OBJECT_RETIREMENT_UNCONFIRMED');
        // Keep the atomic run fence until the native operator has removed the
        // Worker. Otherwise a delayed /run could recreate resources after this
        // retirement request but before deployment deletion is observed.
        return Response.json({ runId: env.RUN_ID, archiveDigest: retained.archiveDigest, deletedKeys, retainedFenceKey: fence.key, retainedFenceDigest: fence.sha256, runFenced: true });
      }
      if (url.pathname === '/status' && request.method === 'GET') return Response.json(snapshot ?? { status: 'NOT_STARTED', runId: env.RUN_ID, sourceSetDigest: env.SOURCE_SET_DIGEST });
      if (url.pathname === '/reconcile' && request.method === 'GET') { requireValue(snapshot && await env.OBJECTS.head('binding-check/cleanup-finished'), 'CLEANUP_STILL_ACTIVE', 409); await reconcileCleanup(env, snapshot); return Response.json(snapshot); }
      if (url.pathname === '/cleanup' && request.method === 'POST') {
        requireValue(snapshot && snapshot.status !== 'RUNNING', 'RUN_STILL_ACTIVE', 409);
        requireValue(await env.OBJECTS.put('binding-check/cleanup-claim', env.RUN_ID, { onlyIf: { etagDoesNotMatch: '*' } }), 'RECONCILE_BEFORE_RETRY', 409);
        try { await cleanup(env, snapshot); } finally { await env.OBJECTS.put('binding-check/cleanup-finished', env.RUN_ID); }
        return Response.json(snapshot);
      }
      requireValue(url.pathname === '/run' && request.method === 'POST', 'CONTROL_ROUTE_DENIED', 404);
      requireValue(!snapshot, 'RECONCILE_BEFORE_RETRY', 409);
      const claim = await env.OBJECTS.put('binding-check/run-claim', env.RUN_ID, { onlyIf: { etagDoesNotMatch: '*' } }); requireValue(claim, 'RUN_ALREADY_DISPATCHED', 409);
      snapshot = { schemaVersion: 1, runId: env.RUN_ID, accountId: env.ACCOUNT_ID, namespace: env.NAMESPACE, sourceSetDigest: env.SOURCE_SET_DIGEST, canonicalName: env.CANONICAL_NAME, attemptId: env.ATTEMPT_ID, attemptName: `attempt-${env.ATTEMPT_ID}`, status: 'RUNNING', startedAt: new Date().toISOString(), effects: [], checks: [], cleanupComplete: false };
      await retain(env, snapshot);
      try { await run(env, snapshot); } catch (error) { snapshot.status = 'FAIL'; snapshot.reason = reason(error); snapshot.completedAt = new Date().toISOString(); await retain(env, snapshot); }
      return Response.json(snapshot);
    } catch (error) { return Response.json({ error: reason(error) }, { status: error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 500 }); }
  },
};
