import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from './api';
import { ProjectAccess } from './ProjectAccess';
import { createSessionIdentity, type IdentityState } from './session-identity';

const first = { principalId: 'https://issuer.test#first', credentialClass: 'human' as const };
const second = { principalId: 'https://issuer.test#second', credentialClass: 'human' as const };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function html(identity: IdentityState) {
  return renderToStaticMarkup(createElement(ProjectAccess, { identity, refresh() {}, copy() {} }));
}

test('self identity is separate from project membership and copy writes only the subject', async () => {
  const session = createSessionIdentity(async () => first);
  await session.refresh();
  assert.deepEqual(session.getSnapshot(), { status: 'verified', identity: first, copy: 'idle' });
  const writes: string[] = [];
  await session.copy(async value => { writes.push(value); });
  assert.deepEqual(writes, [first.principalId]);
  assert.deepEqual(session.getSnapshot(), { status: 'verified', identity: first, copy: 'copied' });
  const rendered = html(session.getSnapshot());
  assert.match(rendered, /Your sign-in is verified/);
  assert.match(rendered, /Project access is granted separately/);
  assert.match(rendered, /No project access has been changed/);
  assert.match(rendered, /Refresh access/);
  assert.doesNotMatch(rendered, /Signed-in member|Approve|Publish|Grant access/);
});

test('rich collaboration session metadata remains separate from the copyable self identity', async () => {
  const session = createSessionIdentity(async () => ({ ...first, tenantId: 'tenant', authentication: {
    issuer: 'https://issuer.test', subject: 'first', issuedAt: 100, expiresAt: 200, authenticatedAt: null,
  } }));
  await session.refresh();
  assert.deepEqual(session.getSnapshot(), { status: 'verified', identity: first, copy: 'idle' });
  const copied: string[] = [];
  await session.copy(async value => { copied.push(value); });
  assert.deepEqual(copied, [first.principalId]);
});
test('the optional server deployment profile is retained without changing the copyable principal', async () => {
  const session = createSessionIdentity(async () => ({ ...first, deploymentProfile: 'collaboration-only' }));
  await session.refresh();
  assert.deepEqual(session.getSnapshot(), { status: 'verified', identity: { ...first, deploymentProfile: 'collaboration-only' }, copy: 'idle' });
  const copied: string[] = [];
  await session.copy(async value => { copied.push(value); });
  assert.deepEqual(copied, [first.principalId]);
  const invalid = createSessionIdentity(async () => ({ ...first, deploymentProfile: 'full-owner' }));
  await invalid.refresh();
  assert.equal(invalid.getSnapshot().status, 'unavailable');
});

test('the optional discussion capability accepts only booleans and never changes copied identity', async () => {
  for (const projectDiscussion of [false, true]) {
    const session = createSessionIdentity(async () => ({ ...first, projectDiscussion }));
    await session.refresh();
    assert.deepEqual(session.getSnapshot(), { status: 'verified', identity: { ...first, projectDiscussion }, copy: 'idle' });
    const copied: string[] = [];
    await session.copy(async value => { copied.push(value); });
    assert.deepEqual(copied, [first.principalId]);
  }
  for (const projectDiscussion of ['true', 'false', 1, 0, null, {}, [], undefined]) {
    const session = createSessionIdentity(async () => ({ ...first, projectDiscussion }));
    await session.refresh();
    assert.deepEqual(session.getSnapshot(), { status: 'unavailable', signInRequired: false });
  }
});

test('authentication loss clears a verified identity and leaves no copy action', async () => {
  let denied = false;
  const session = createSessionIdentity(async () => { if (denied) throw new ApiError('expired', 401); return first; });
  await session.refresh(); denied = true;
  const pending = session.refresh();
  assert.deepEqual(session.getSnapshot(), { status: 'loading' });
  await pending;
  assert.deepEqual(session.getSnapshot(), { status: 'unavailable', signInRequired: true });
  const rendered = html(session.getSnapshot());
  assert.match(rendered, /Sign in again/);
  assert.doesNotMatch(rendered, /first|Copy identity/);
  await session.copy(async () => { assert.fail('unverified identity cannot be copied'); });
});

test('late identity responses cannot restore identity after a member read or session reset', async () => {
  const held = deferred<unknown>(); const session = createSessionIdentity(() => held.promise);
  const pending = session.refresh(); session.clear(); held.resolve(first); await pending;
  assert.deepEqual(session.getSnapshot(), { status: 'idle' });
});

test('a slower old identity cannot replace a later session or its failure', async () => {
  for (const fail of [false, true]) {
    const older = deferred<unknown>(), newer = deferred<unknown>(); let reads = 0;
    const session = createSessionIdentity(() => (++reads === 1 ? older : newer).promise);
    const a = session.refresh(), b = session.refresh();
    if (fail) newer.reject(new ApiError('forbidden', 403)); else newer.resolve(second);
    await b; older.resolve(first); await a;
    assert.deepEqual(session.getSnapshot(), fail ? { status: 'unavailable', signInRequired: true } : { status: 'verified', identity: second, copy: 'idle' });
  }
});

test('identity changes discard outstanding clipboard results and reset copied state', async () => {
  let current = first; const session = createSessionIdentity(async () => current);
  await session.refresh(); const clipboard = deferred<void>();
  const copy = session.copy(value => { assert.equal(value, first.principalId); return clipboard.promise; });
  assert.match(html(session.getSnapshot()), /aria-label="Copy identity" disabled=""/);
  current = second; await session.refresh(); clipboard.resolve(); await copy;
  assert.deepEqual(session.getSnapshot(), { status: 'verified', identity: second, copy: 'idle' });
  assert.doesNotMatch(html(session.getSnapshot()), /first|Identity copied/);
});

test('clipboard rejection keeps the verified identity available for manual copying', async () => {
  const session = createSessionIdentity(async () => first); await session.refresh();
  await session.copy(async () => { throw new Error('clipboard unavailable'); });
  const rendered = html(session.getSnapshot());
  assert.match(rendered, /Select and copy the identity shown above/);
  assert.match(rendered, /https:\/\/issuer.test#first/);
});

test('malformed, nonhuman and extra-field identity responses cannot become verified', async () => {
  for (const value of [null, [], {}, { ...first, principalId: '' }, { ...first, principalId: 'x'.repeat(16385) },
    { ...first, credentialClass: 'service' }, { ...first, email: 'unexpected' }, { ...first, token: 'unexpected' },
    { ...first, tenantId: '' }, { ...first, tenantId: 1 }, { ...first, authentication: {} },
    { ...first, authentication: { issuer: 'https://issuer.test', subject: 'another', issuedAt: 100, expiresAt: 200 } },
    { ...first, authentication: { issuer: 'https://issuer.test', subject: 'first', issuedAt: '100', expiresAt: 200 } },
    { ...first, authentication: { issuer: 'https://issuer.test', subject: 'first', issuedAt: 100, expiresAt: 200, token: 'unexpected' } }]) {
    const session = createSessionIdentity(async () => value); await session.refresh();
    assert.deepEqual(session.getSnapshot(), { status: 'unavailable', signInRequired: false });
    assert.doesNotMatch(html(session.getSnapshot()), /Copy identity|unexpected/);
  }
});

test('provider unavailability does not falsely instruct the user to sign in again', async () => {
  const session = createSessionIdentity(async () => { throw new ApiError('provider unavailable', 503); }); await session.refresh();
  assert.match(html(session.getSnapshot()), /Refresh access to try again/);
  assert.doesNotMatch(html(session.getSnapshot()), /Sign in again|Copy identity/);
});
