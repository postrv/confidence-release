import test from 'node:test';
import assert from 'node:assert/strict';
import type { PlatformState, Attempt, Capsule } from '../../services/types.ts';
import { runtimePresentation } from '../../apps/web/src/runtime.ts';
import { ApiError, createStateReader, FORCED_FULL_SNAPSHOT_MS, projectSnapshotStatus, stateReadFailure } from '../../apps/web/src/api.ts';
import { VerificationSession } from '../../apps/web/src/verification-state.ts';
import type { Checkpoint, TrustConfig, VerificationBundle, VerificationResult } from '../../packages/protocol/src/types.ts';

const snapshot = (options: Partial<PlatformState> = {}): PlatformState => ({ capabilities: { deployment: true, scripted: false, pi: false, publication: false }, attempts: [], capsules: [], ...options } as PlatformState);
const pi = (options: Partial<Attempt> = {}): Attempt => ({ id: 'owned-attempt', mode: 'pi', status: 'PROVISIONING', generation: 2, ...options } as Attempt);
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('runtime labels distinguish closed deployment, configuration and observed execution', () => {
  assert.equal(runtimePresentation().label, 'Runtime unavailable');
  assert.equal(runtimePresentation(snapshot({ demoMode: 'pi' })).label, 'Cloudflare pilot · execution disabled');
  const configured = snapshot({ capabilities: { deployment: true, scripted: false, pi: true, publication: false }, demoMode: 'pi' });
  assert.equal(runtimePresentation(configured).label, 'Cloudflare pilot · Pi ready');
  assert.equal(runtimePresentation({ ...configured, attempts: [pi()] }).label, 'Pi mode · awaiting execution');
  assert.equal(runtimePresentation({ ...configured, attempts: [pi({ status: 'RUNNING' })] }).label, 'Pi execution observed');
  assert.equal(runtimePresentation(snapshot({ capabilities: { deployment: false, scripted: true, pi: false, publication: true } })).label, 'Local scripted demonstration · ready');
});

test('retained Pi session labels require the exact attempt generation and a complete capture', () => {
  const state = snapshot({ attempts: [pi({ status: 'SUBMITTED', terminationObserved: true })] });
  const capsule = { attemptId: 'owned-attempt', generation: 2, sessionDigest: 'sha256:owned', missingTail: false } as Capsule;
  for (const changed of [{ generation: 1 }, { attemptId: 'another-attempt' }, { missingTail: true }, { sessionDigest: '' }]) {
    assert.equal(runtimePresentation({ ...state, capsules: [{ ...capsule, ...changed }] }).label, 'Pi execution observed');
  }
  assert.equal(runtimePresentation({ ...state, capsules: [capsule] }).label, 'Pi session retained');
  assert.match(runtimePresentation({ ...state, capsules: [capsule] }).detail, /does not establish model quality or a real-provider result/);
});

test('overlapping refreshes return the accepted snapshot for both display and contribution selection', async () => {
  const responses = [deferred<PlatformState>(), deferred<PlatformState>()];
  let index = 0;
  const read = createStateReader(() => responses[index++].promise);
  const early = read(), later = read();
  const latest = snapshot({ tenantId: 'tenant', projectId: 'project', projectIncarnation: 'current', revision: 12, attempts: [pi({ id: 'new-contribution' })] });
  responses[1].resolve(latest);
  assert.strictEqual(await later, latest);
  responses[0].resolve({ ...latest, revision: 9, attempts: [] });
  const received = await early;
  assert.strictEqual(received, latest);
  assert.deepEqual(received.attempts.map(attempt => attempt.id), ['new-contribution']);
});

test('late responses cannot restore a previous project incarnation or its command revision', async () => {
  const responses = Array.from({ length: 3 }, () => deferred<PlatformState>());
  let index = 0;
  const read = createStateReader(() => responses[index++].promise);
  const initial = read(), oldProject = read(), newProject = read();
  const current = snapshot({ tenantId: 'tenant', projectId: 'project', projectIncarnation: 'new', revision: 4 });
  responses[0].resolve(current);
  await initial;
  // Even a lower revision confirms the scope of the newer request.
  responses[2].resolve({ ...current, revision: 3 });
  assert.strictEqual(await newProject, current);
  responses[1].resolve({ ...current, projectIncarnation: 'old', revision: 900 });
  assert.strictEqual(await oldProject, current);
});

test('an older refresh failure cannot override a subsequent successful refresh', async () => {
  const responses = [deferred<PlatformState>(), deferred<PlatformState>()];
  let index = 0;
  const read = createStateReader(() => responses[index++].promise);
  const early = read(), later = read();
  const current = snapshot({ projectIncarnation: 'current', revision: 4 });
  responses[1].resolve(current);
  await later;
  responses[0].reject(new Error('Older request timed out'));
  assert.strictEqual(await early, current);
});

test('unchanged display snapshots reuse accepted state and force a full read every minute', async () => {
  let time = 1000;
  const requests: { token?: string; force?: boolean }[] = [];
  const initial = snapshot({ tenantId: 'tenant', projectId: 'project', projectIncarnation: 'incarnation', revision: 4,
    viewToken: 'scoped-token', viewCursor: { projectIncarnation: 'incarnation', revision: '4', eventSequence: 2, capsuleRowid: 0 } });
  const read = createStateReader(async (accepted, force) => {
    requests.push({ token: accepted?.viewToken, force });
    return force ? initial : { unchanged: true as const, viewToken: 'scoped-token' };
  }, () => time);
  assert.strictEqual(await read(), initial);
  assert.strictEqual(await read(), initial);
  time += FORCED_FULL_SNAPSHOT_MS - 1;
  assert.strictEqual(await read(), initial);
  time++;
  assert.strictEqual(await read(), initial);
  assert.deepEqual(requests.map(item => item.force), [true, false, false, true]);
});

test('same-revision failure events and late capsules cannot regress behind an older response', async () => {
  const responses = Array.from({ length: 3 }, () => deferred<PlatformState>());
  let index = 0;
  const read = createStateReader(() => responses[index++].promise);
  const base = snapshot({ tenantId: 'tenant', projectId: 'project', projectIncarnation: 'incarnation', revision: 4,
    viewToken: 'base', viewCursor: { projectIncarnation: 'incarnation', revision: '4', eventSequence: 1, capsuleRowid: 0 } });
  const first = read(); responses[0].resolve(base); assert.strictEqual(await first, base);
  const older = read(), newer = read();
  const event = { ...base, viewToken: 'event', viewCursor: { ...base.viewCursor!, eventSequence: 2 } };
  const capsule = { ...base, viewToken: 'capsule', viewCursor: { ...base.viewCursor!, eventSequence: 2, capsuleRowid: 1 } };
  responses[2].resolve(capsule); assert.strictEqual(await newer, capsule);
  responses[1].resolve(event); assert.strictEqual(await older, capsule);
});

test('an older same-cursor response cannot restore a previous credential class', async () => {
  const responses = Array.from({ length: 3 }, () => deferred<PlatformState>());
  let index = 0;
  const read = createStateReader(() => responses[index++].promise);
  const current = snapshot({ tenantId: 'tenant', projectId: 'project', projectIncarnation: 'incarnation', revision: 4,
    session: { principalId: 'subject', credentialClass: 'human' }, viewToken: 'human',
    viewCursor: { projectIncarnation: 'incarnation', revision: '4', eventSequence: 1, capsuleRowid: 0 } });
  const first = read(); responses[0].resolve(current); await first;
  const old = read(), newer = read();
  const changed = { ...current, session: { principalId: 'subject', credentialClass: 'agent' as const }, viewToken: 'agent' };
  responses[2].resolve(changed); assert.strictEqual(await newer, changed);
  responses[1].resolve(current); assert.strictEqual(await old, changed);
});

test('membership revocation clears the accepted project and fences a late private snapshot', async () => {
  const current = snapshot({ tenantId: 'tenant', projectId: 'project', projectIncarnation: 'incarnation', revision: 7,
    session: { principalId: 'owner', credentialClass: 'human' }, viewToken: 'owner-view' });
  const late = deferred<PlatformState>();
  const calls: { accepted?: PlatformState; force?: boolean }[] = [];
  let number = 0;
  const denied = new ApiError('PROJECT_UNAVAILABLE', 404, 'PROJECT_UNAVAILABLE');
  const read = createStateReader(async (accepted, force) => {
    calls.push({ accepted, force });
    switch (number++) {
      case 0: return current;
      case 1: return late.promise;
      case 2: throw denied;
      default: return { ...current, revision: 8 };
    }
  });
  assert.strictEqual(await read(), current);
  const older = read();
  await assert.rejects(read(), denied);
  assert.deepEqual(stateReadFailure(denied), { kind: 'project', clearSnapshot: true, message: 'PROJECT_UNAVAILABLE' });
  assert.equal(projectSnapshotStatus(undefined, false, denied.message), 'unavailable');
  late.resolve(current);
  await assert.rejects(older, /discarded after access changed/);
  const restored = await read();
  assert.equal(restored.revision, 8);
  assert.equal(calls[3].accepted, undefined, 'the next read must not reuse a private cursor');
  assert.equal(calls[3].force, true);
});

test('a network failure retains only an explicitly unverified display snapshot', async () => {
  const current = snapshot({ tenantId: 'tenant', projectId: 'project', projectIncarnation: 'incarnation', revision: 7,
    session: { principalId: 'owner', credentialClass: 'human' }, viewToken: 'owner-view' });
  const offline = new TypeError('Failed to fetch');
  const calls: { accepted?: PlatformState; force?: boolean }[] = [];
  let number = 0;
  const read = createStateReader(async (accepted, force) => {
    calls.push({ accepted, force });
    if (number++ === 0) return current;
    if (number === 2) throw offline;
    return { unchanged: true, viewToken: 'owner-view' } as const;
  });
  assert.strictEqual(await read(), current);
  await assert.rejects(read(), offline);
  assert.deepEqual(stateReadFailure(offline), { kind: 'unavailable', clearSnapshot: false, message: 'Failed to fetch' });
  assert.equal(projectSnapshotStatus(current, false, offline.message), 'unverified');
  assert.strictEqual(await read(), current);
  assert.strictEqual(calls[2].accepted, current, 'a later authenticated read may safely reuse the last cursor');
  assert.equal(calls[2].force, false);
  assert.equal(projectSnapshotStatus(current, true, ''), 'current');
});

const receiptBundle = { schemaVersion: 1 } as VerificationBundle;
const trustConfiguration = { schemaVersion: 2 } as TrustConfig;
const verifiedReceipt = { valid: true, receiptDigest: 'sha256:current' } as VerificationResult;
async function readyVerifier() {
  const session = new VerificationSession();
  await session.loadInput('bundle', 'receipt.json', async () => receiptBundle);
  await session.loadInput('trust', 'trust.json', async () => trustConfiguration);
  return session;
}

test('receipt file reads and project downloads cannot replace a later input or surface stale errors', async () => {
  for (const [earlierName, latestName] of [['upload.json', 'project.json'], ['project.json', 'upload.json']]) {
    for (const fails of [false, true]) {
      const session = new VerificationSession(), earlier = deferred<VerificationBundle>();
      const oldLoad = session.loadInput('bundle', earlierName, () => earlier.promise);
      await session.loadInput('bundle', latestName, async () => receiptBundle);
      if (fails) earlier.reject(new Error('Superseded input failed'));
      else earlier.resolve({ ...receiptBundle, schemaVersion: 1 });
      await oldLoad;
      assert.strictEqual(session.getSnapshot().inputs.bundle.value, receiptBundle);
      assert.equal(session.getSnapshot().inputs.bundle.name, latestName);
      assert.equal(session.getSnapshot().error, '');
      assert.equal(session.getSnapshot().inputs.bundle.pending, false);
    }
  }
});

test('changing inputs invalidates pending verification results and errors without clearing a newer report', async () => {
  for (const fails of [false, true]) {
    const session = await readyVerifier(), earlier = deferred<VerificationResult>();
    const oldVerification = session.verify(() => earlier.promise);
    assert.equal(session.getSnapshot().busy, true);
    await session.loadInput('trust', 'new-trust.json', async () => trustConfiguration);
    assert.equal(session.getSnapshot().busy, false);
    assert.equal(session.getSnapshot().result, undefined);
    await session.verify(async inputs => {
      assert.strictEqual(inputs.trust, trustConfiguration);
      return verifiedReceipt;
    });
    if (fails) earlier.reject(new Error('Superseded verification failed'));
    else earlier.resolve({ ...verifiedReceipt, valid: false });
    await oldVerification;
    assert.strictEqual(session.getSnapshot().result, verifiedReceipt);
    assert.equal(session.getSnapshot().busy, false);
    assert.equal(session.getSnapshot().error, '');
  }
});

test('verification waits for an optional checkpoint and clearing it cancels its pending read', async () => {
  const session = await readyVerifier(), checkpoint = deferred<Checkpoint>();
  const loading = session.loadInput('checkpoint', 'checkpoint.json', () => checkpoint.promise);
  let calls = 0;
  await session.verify(async () => { calls++; return verifiedReceipt; });
  assert.equal(calls, 0);
  session.clearCheckpoint();
  await session.verify(async inputs => { assert.equal(inputs.checkpoint, undefined); return verifiedReceipt; });
  checkpoint.resolve({ schemaVersion: 1 } as Checkpoint);
  await loading;
  assert.equal(session.getSnapshot().inputs.checkpoint.value, undefined);
  assert.equal(session.getSnapshot().inputs.checkpoint.pending, false);
  assert.strictEqual(session.getSnapshot().result, verifiedReceipt);
  await session.loadInput('checkpoint', 'no-checkpoint.json', async () => null);
  await session.verify(async inputs => { assert.equal(inputs.checkpoint, null); return verifiedReceipt; });
  assert.strictEqual(session.getSnapshot().result, verifiedReceipt);
});

test('independent input reads are retained and current read failures remain visible', async () => {
  const session = new VerificationSession(), trust = deferred<TrustConfig>(), bundle = deferred<VerificationBundle>();
  const trustLoad = session.loadInput('trust', 'trust.json', () => trust.promise);
  const bundleLoad = session.loadInput('bundle', 'receipt.json', () => bundle.promise);
  bundle.resolve(receiptBundle); await bundleLoad;
  trust.resolve(trustConfiguration); await trustLoad;
  assert.strictEqual(session.getSnapshot().inputs.bundle.value, receiptBundle);
  assert.strictEqual(session.getSnapshot().inputs.trust.value, trustConfiguration);
  await session.loadInput('bundle', 'unreadable.json', async () => { throw new Error('Cannot parse selected file'); });
  assert.equal(session.getSnapshot().inputs.bundle.value, undefined);
  assert.equal(session.getSnapshot().error, 'Cannot parse selected file');
  assert.equal(session.getSnapshot().inputs.bundle.pending, false);
});

test('an old export failure cannot overwrite a newer verification report', async () => {
  const session = await readyVerifier(), exportResponse = deferred<void>();
  const exporting = session.exportFile(() => exportResponse.promise);
  await session.verify(async () => verifiedReceipt);
  exportResponse.reject(new Error('Old export request failed'));
  await exporting;
  assert.strictEqual(session.getSnapshot().result, verifiedReceipt);
  assert.equal(session.getSnapshot().error, '');
});
