// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CollaborationStore, invitationTokenDigest } from '../workers/authority/collaboration';
import { AUTHORITY_SCHEMA } from '../workers/authority/schema';
import { PROJECT_CATALOG_SCHEMA } from '../workers/authority/project-catalog';
import { PlatformError } from '../workers/shared/errors';
import type { Principal } from '../workers/shared/auth';
import type { Scope } from '../packages/protocol/src/types';

const scope: Scope = { schemaVersion: 1, tenantId: 'owned-tenant', projectId: 'owned-project', projectIncarnation: 'owned-incarnation' };
const issuer = 'https://identity.owned.test';
function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec(AUTHORITY_SCHEMA + PROJECT_CATALOG_SCHEMA);
  const sql = { exec(query: string, ...bindings: (string | number | null)[]) {
    const rows = db.prepare(query).all(...bindings); return { toArray: () => rows };
  } } as unknown as SqlStorage;
  const store = new CollaborationStore(sql, () => assert.fail('Invitation expiry must not operate on execution grants'));
  const principal = (name: string): Principal => ({ id: issuer + '#' + name, tenantId: scope.tenantId, credentialClass: 'human',
    authentication: { issuer, subject: name, issuedAt: 1000, expiresAt: 5000, authenticatedAt: null } });
  const caller = (name: string) => ({ projectId: scope.projectId, principal: principal(name) }), project = { scope, revision: '0' };
  db.prepare('INSERT INTO memberships(subject,roles,active) VALUES(?,?,1)').run(principal('owner').id, '["admin"]');
  const apply = (name: string, operation: string, body: Record<string, unknown>, now: number) => store.apply(caller(name), project,
    { operation, body, commandId: 'owned-expiry-command', expectedRevision: '0', expectedIncarnation: scope.projectIncarnation }, [principal('owner').id], now);
  apply('owner', 'enable-collaboration', {}, 1100);
  const token = 'A'.repeat(43), invitationId = 'owned-expiry-invitation';
  const create = (expiresAt: number, now = 1100) => apply('owner', 'create-invitation', {
    invitationId, recipientId: principal('guest').id, role: 'viewer', tokenDigest: invitationTokenDigest(scope, invitationId, token), expiresAt,
  }, now);
  return { db, create, accept: (now: number) => apply('guest', 'accept-invitation', { invitationId, token }, now) };
}
const unavailable = (action: () => unknown, code: string, status: number) => assert.throws(action,
  error => error instanceof PlatformError && error.code === code && error.status === status);

test('actual SQLite invitation creation rejects expiry at/past validation time and preserves the inclusive seven-day maximum', () => {
  for (const [expiry, valid] of [[1099, false], [1100, false], [1101, true], [1100 + 7 * 86400, true], [1101 + 7 * 86400, false]] as const) {
    const f = fixture(); try {
      if (valid) { assert.equal(f.create(expiry).state, 'INVITATION_CREATED'); assert.equal(f.db.prepare('SELECT expires_at FROM invitations').get()!.expires_at, expiry); }
      else { unavailable(() => f.create(expiry), 'INVITATION_EXPIRY_INVALID', 400); assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM invitations').get()!.count, 0); }
    } finally { f.db.close(); }
  }
});

test('actual SQLite invitation creation deterministically reproduces the crossed-second fixture failure', () => {
  const f = fixture(); try {
    // A body formed at t=1100 with lifetime one second arrives after an awaited read at t=1101.
    const expiryFromEarlierRead = 1100 + 1;
    unavailable(() => f.create(expiryFromEarlierRead, 1101), 'INVITATION_EXPIRY_INVALID', 400);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM invitations').get()!.count, 0);
  } finally { f.db.close(); }
});

test('actual SQLite invitation acceptance succeeds just before expiry and rejects at/after expiry without consuming the invitation', () => {
  for (const now of [1100, 1101, 1102]) {
    const f = fixture(); try {
      f.create(1101);
      if (now < 1101) {
        assert.equal(f.accept(now).state, 'INVITATION_ACCEPTED');
        assert.equal(f.db.prepare('SELECT active FROM memberships WHERE subject=?').get(issuer + '#guest')!.active, 1);
      } else {
        unavailable(() => f.accept(now), 'INVITATION_UNAVAILABLE', 404);
        assert.equal(f.db.prepare('SELECT state FROM invitations').get()!.state, 'PENDING');
        assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM memberships WHERE subject=?').get(issuer + '#guest')!.count, 0);
      }
    } finally { f.db.close(); }
  }
});
