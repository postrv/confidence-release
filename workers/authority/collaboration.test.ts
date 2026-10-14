// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CollaborationStore, collaborationCanHoldGrant, collaborationOperation, collaborationRoles, invitationTokenDigest, requireRemainingHumanOwner, verifiedAuthentication } from './collaboration';
import { AUTHORITY_SCHEMA } from './schema';
import { PROJECT_CATALOG_SCHEMA } from './project-catalog';
import { PlatformError } from '../shared/errors';
import type { Principal } from '../shared/auth';
import type { Scope } from '../../packages/protocol/src/types';
import { COLLABORATION_ROLES } from '../../packages/protocol/src/collaboration';
import { encodeBase64 } from '../../packages/protocol/src/index';

const scope: Scope = { schemaVersion: 1, tenantId: 'tenant', projectId: 'project', projectIncarnation: 'incarnation' };
const principal: Principal = { id: 'https://identity.example/#alice', tenantId: 'tenant', credentialClass: 'human', authentication: { issuer: 'https://identity.example/', subject: 'alice', issuedAt: 1000, expiresAt: 5000, authenticatedAt: null } };
const rejects = (action: () => unknown, code: string) => assert.throws(action, error => error instanceof PlatformError && error.code === code);
const randomToken = () => encodeBase64(randomBytes(32)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('verified identities bind the exact issuer, subject and configured tenant', () => {
  assert.equal(verifiedAuthentication(principal, 'tenant', 1100), principal.authentication);
  for (const changes of [{ id: 'https://identity.example/#bob' }, { tenantId: 'other' }, { authentication: undefined },
    { authentication: { ...principal.authentication!, issuer: 'http://identity.example/' } },
    { authentication: { ...principal.authentication!, issuer: 'https://identity.example/#other' } },
    { authentication: { ...principal.authentication!, subject: '' } }]) {
    rejects(() => verifiedAuthentication({ ...principal, ...changes }, 'tenant', 1100), 'VERIFIED_IDENTITY_REQUIRED');
  }
});

test('expired, future and nonintegral verified token times fail closed', () => {
  for (const changes of [{ expiresAt: 1100 }, { expiresAt: 999 }, { issuedAt: 1106 }, { issuedAt: 1000.5 }, { issuedAt: Number.NaN }, { issuedAt: -1 }, { authenticatedAt: 1006 }, { authenticatedAt: -1 }, { authenticatedAt: 1000.5 }]) {
    rejects(() => verifiedAuthentication({ ...principal, authentication: { ...principal.authentication!, ...changes } }, 'tenant', 1100), 'VERIFIED_IDENTITY_REQUIRED');
  }
});

test('recent-session control measures token issuance and honors older provider authentication when supplied', () => {
  assert.doesNotThrow(() => verifiedAuthentication(principal, 'tenant', 1900, true));
  rejects(() => verifiedAuthentication(principal, 'tenant', 1901, true), 'RECENT_SESSION_REQUIRED');
  assert.doesNotThrow(() => verifiedAuthentication(principal, 'tenant', 1901));
  rejects(() => verifiedAuthentication({ ...principal, authentication: { ...principal.authentication!, authenticatedAt: 1 } }, 'tenant', 1100, true), 'RECENT_SESSION_REQUIRED');
  assert.doesNotThrow(() => verifiedAuthentication({ ...principal, authentication: { ...principal.authentication!, authenticatedAt: 1000 } }, 'tenant', 1100, true));
});

test('invitation digests bind project, incarnation, tenant and invitation identifier', () => {
  const token = randomToken();
  const digest = invitationTokenDigest(scope, 'invite', token);
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(invitationTokenDigest({ ...scope }, 'invite', token), digest);
  for (const other of [{ ...scope, tenantId: 'other' }, { ...scope, projectId: 'other' }, { ...scope, projectIncarnation: 'other' }]) assert.notEqual(invitationTokenDigest(other, 'invite', token), digest);
  assert.notEqual(invitationTokenDigest(scope, 'another-invite', token), digest);
  assert.notEqual(invitationTokenDigest(scope, 'invite', randomToken()), digest);
});

test('invitation token parsing requires exactly 256 bits with one canonical encoding', () => {
  for (const invalid of ['', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}B`, `${'A'.repeat(42)}=`, `${'A'.repeat(42)}+`, `${'A'.repeat(42)}/`, null, 1, { token: 'A'.repeat(43) }]) rejects(() => invitationTokenDigest(scope, 'invite', invalid), 'INVITATION_UNAVAILABLE');
  for (const last of 'AEIMQUYcgkosw048') assert.match(invitationTokenDigest(scope, 'invite', `${'A'.repeat(42)}${last}`), /^sha256:/);
});

test('last active human owner cannot be removed or demoted', () => {
  for (const role of COLLABORATION_ROLES) for (const active of [false, true]) {
    if (role === 'owner' && active) assert.doesNotThrow(() => requireRemainingHumanOwner({ role: 'owner', active: true }, { role, active }, 1));
    else rejects(() => requireRemainingHumanOwner({ role: 'owner', active: true }, { role, active }, 1), 'LAST_HUMAN_OWNER_REQUIRED');
    assert.doesNotThrow(() => requireRemainingHumanOwner({ role: 'owner', active: true }, { role, active }, 2));
  }
  assert.doesNotThrow(() => requireRemainingHumanOwner({ role: 'reviewer', active: true }, { role: 'viewer', active: false }, 1));
});

test('ownership carries no implicit approval or unrestricted administrator grants', () => {
  assert.deepEqual(collaborationRoles('owner'), ['export', 'reader', 'sponsor']);
  assert.deepEqual(collaborationRoles('reviewer'), ['reader', 'reviewer']);
  for (const role of COLLABORATION_ROLES) {
    assert.equal(collaborationRoles(role).includes('admin'), false);
    assert.equal(collaborationRoles(role).includes('reviewer'), role === 'reviewer');
    assert.equal(collaborationRoles(role).includes('export'), role === 'owner');
  }
  assert.equal(collaborationOperation('set-membership'), false);
  assert.equal(collaborationOperation('accept-invitation'), true);
  assert.equal(collaborationOperation('set-collaborator-review'), true);
  assert.equal(collaborationOperation('admit-join-request'), true);
});

test('viewer is read-only while other human presets may receive separate attempt capabilities', () => {
  assert.equal(collaborationCanHoldGrant('viewer'), false);
  for (const role of ['contributor', 'reviewer', 'maintainer', 'owner'] as const) assert.equal(collaborationCanHoldGrant(role), true);
  assert.deepEqual(collaborationRoles('viewer'), ['reader']);
  assert.deepEqual(collaborationRoles('contributor'), ['reader']);
});

function joinFixture() {
  const db = new DatabaseSync(':memory:'); db.exec(AUTHORITY_SCHEMA + PROJECT_CATALOG_SCHEMA);
  const sql = { exec(query: string, ...bindings: (string | number | null)[]) { const rows = db.prepare(query).all(...bindings); return { toArray: () => rows }; } } as unknown as SqlStorage;
  const store = new CollaborationStore(sql, () => assert.fail('Generic membership has no execution grants'));
  const owner = { projectId: scope.projectId, principal }, project = { scope, revision: '0' };
  db.prepare('INSERT INTO memberships(subject,roles,active) VALUES(?,?,1)').run(principal.id, '["admin"]');
  const apply = (operation: string, body: Record<string, unknown>) => store.apply(owner, project,
    { operation, body, commandId: 'owned-unit', expectedRevision: '0', expectedIncarnation: scope.projectIncarnation }, [principal.id], 1100);
  apply('enable-collaboration', {});
  const caller = (name: string) => ({ projectId: scope.projectId, principal: { ...principal,
    id: principal.authentication!.issuer + '#' + name, authentication: { ...principal.authentication!, subject: name } } });
  const request = (name: string, requestId = 'owned-request') => store.requestJoin(caller(name), project, { requestId, expectedIncarnation: scope.projectIncarnation, body: {} }, 1100);
  return { db, store, project, caller, apply, request };
}

test('join requests cap pending identities and derive every subject from verified caller', () => {
  const f = joinFixture();
  try {
    const first = f.request('guest-0');
    assert.equal(first.subject, f.caller('guest-0').principal.id);
    assert.deepEqual(f.request('guest-0'), first);
    rejects(() => f.request('guest-0', 'another-pending'), 'JOIN_REQUEST_ALREADY_PENDING');
    rejects(() => f.store.requestJoin(f.caller('guest-0'), f.project, { requestId: 'forged', expectedIncarnation: scope.projectIncarnation, body: { subject: principal.id } }, 1100), 'SCHEMA_ERROR');
    for (let i = 1; i < 50; i++) f.request('guest-' + i);
    rejects(() => f.request('guest-50'), 'JOIN_REQUEST_LIMIT');
    assert.deepEqual(f.store.joinRequests(f.caller('guest-0'), f.project, 1100).requests, []);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM project_join_requests').get()!.count, 50);
  } finally { f.db.close(); }
});

test('same-second rejoin history preserves newest selection, limits repeat requests and never reactivates by replay', () => {
  const f = joinFixture();
  try {
    for (let i = 0; i < 5; i++) {
      const pending = f.request('guest', 'request-' + i);
      assert.equal(f.store.joinRequests(f.caller('guest'), f.project, 1100).ownRequest?.id, pending.id);
      rejects(() => f.request('guest', 'second-pending-' + i), 'JOIN_REQUEST_ALREADY_PENDING');
      f.apply('admit-join-request', { requestId: pending.id });
      f.apply('update-collaborator', { subject: pending.subject, role: 'maintainer', active: false });
      assert.equal(f.request('guest', 'request-' + i).state, 'REVOKED');
      rejects(() => f.apply('admit-join-request', { requestId: pending.id }), 'JOIN_REQUEST_UNAVAILABLE');
      assert.equal(f.db.prepare('SELECT active FROM memberships WHERE subject=?').get(pending.subject)!.active, 0);
    }
    rejects(() => f.request('guest', 'rate-limited'), 'JOIN_REQUEST_RATE_LIMIT');
  } finally { f.db.close(); }
});

test('join display email comes only from the trusted caller and is visible only to its subject and owner', () => {
  const f = joinFixture();
  try {
    const guest = f.caller('opaque-guest'), verifiedEmail = 'laurence.owned@example.test';
    const caller = { ...guest, principal: { ...guest.principal, verifiedEmail } };
    const request = { requestId: 'owned-email', expectedIncarnation: scope.projectIncarnation, body: {} };
    const pending = f.store.requestJoin(caller, f.project, request, 1100);
    assert.equal(pending.subject, guest.principal.id); assert.equal(pending.verifiedEmail, verifiedEmail);
    assert.deepEqual(f.store.requestJoin(guest, f.project, request, 1100), pending, 'Replay preserves the original signed display context');
    assert.equal(f.store.joinRequests(guest, f.project, 1100).ownRequest?.verifiedEmail, verifiedEmail);
    assert.equal(f.store.joinRequests({ projectId: scope.projectId, principal }, f.project, 1100).requests[0]?.verifiedEmail, verifiedEmail);
    const stranger = f.store.joinRequests(f.caller('stranger'), f.project, 1100);
    assert.deepEqual(stranger.requests, []); assert.equal(stranger.ownRequest, null);
    rejects(() => f.store.requestJoin(f.caller('stranger'), f.project, { ...request, body: { verifiedEmail } }, 1100), 'SCHEMA_ERROR');
    assert.equal(f.request('legacy-without-email').verifiedEmail, undefined);
  } finally { f.db.close(); }
});

test('valid older sessions may post discussion while new agent grants still require a recent session', () => {
  const f = joinFixture();
  try {
    const caller = { projectId: scope.projectId, principal };
    assert.equal(f.store.hubMember(caller, f.project, 'edit', 2000).canPost, true);
    rejects(() => f.store.hubMember(caller, f.project, 'connect', 2000), 'RECENT_SESSION_REQUIRED');
    rejects(() => f.store.hubMember(caller, f.project, 'edit', 5000), 'VERIFIED_IDENTITY_REQUIRED');
  } finally { f.db.close(); }
});
