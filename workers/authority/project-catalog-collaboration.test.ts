// SPDX-License-Identifier: Apache-2.0
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeKernel } from '../../packages/protocol/src/node';
import { CollaborationStore } from './collaboration';
import { ProjectCatalog, PROJECT_CATALOG_SCHEMA } from './project-catalog';
import { AUTHORITY_SCHEMA } from './schema';
import type { AuthorityCommand, AuthorityEnv, TrustedCaller } from './types';
import { PlatformError } from '../shared/errors';

before(initializeKernel);

test('generic collaboration preserves terminal rejection identity across restart and changed state', () => {
  const db = new DatabaseSync(':memory:');
  const storage = {
    sql: { exec(query: string, ...bindings: (string | number | null)[]) {
      if (query.includes('CREATE TABLE')) { db.exec(query); return { toArray: () => [] }; }
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    } },
    transactionSync<T>(callback: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  db.exec(AUTHORITY_SCHEMA + PROJECT_CATALOG_SCHEMA);
  const now = Math.floor(Date.now() / 1000), incarnation = 'generic-incarnation';
  const caller: TrustedCaller = { projectId: 'generic', principal: { id: 'https://identity.example/#owner', tenantId: 'tenant', credentialClass: 'human',
    authentication: { issuer: 'https://identity.example/', subject: 'owner', issuedAt: now - 5, expiresAt: now + 3600 } } };
  const collaborators = new CollaborationStore(storage.sql as unknown as SqlStorage, () => { throw Error('Generic project has no execution grants'); });
  const env = { AUTH_TENANT_ID: 'tenant', MAINTENANCE_MODE: 'false' } as AuthorityEnv;
  const build = () => new ProjectCatalog({ storage } as unknown as DurableObjectState, env, collaborators);
  const catalog = build();
  const rejected = (action: () => unknown, code: string) => assert.throws(action, error => error instanceof PlatformError && error.code === code);
  try {
    catalog.initialize(caller, { projectIncarnation: incarnation, name: 'Generic collaboration', description: '', createdAt: new Date().toISOString() });
    catalog.draftCollaborationCommand(caller, { commandId: 'enable', expectedRevision: '1', expectedIncarnation: incarnation, operation: 'enable-collaboration', body: {} });
    const invalid: AuthorityCommand = { commandId: 'review-request', expectedRevision: '2', expectedIncarnation: incarnation,
      operation: 'set-collaborator-review', body: { subject: caller.principal.id, enabled: 'true' } };
    rejected(() => catalog.draftCollaborationCommand(caller, invalid), 'SCHEMA_ERROR');
    rejected(() => build().draftCollaborationCommand(caller, { ...invalid, body: { subject: caller.principal.id, enabled: true } }), 'COMMAND_ID_REUSED');
    assert.equal(catalog.collaborationView(caller).members[0].additionalReview, undefined);
    catalog.draftCollaborationCommand(caller, { ...invalid, commandId: 'new-review-request', body: { subject: caller.principal.id, enabled: true } });
    rejected(() => build().draftCollaborationCommand(caller, invalid), 'SCHEMA_ERROR');
    assert.equal(catalog.collaborationView(caller).revision, '3', 'Rejected replay never increments metadata revision');
    assert.equal(db.prepare("SELECT state FROM commands WHERE caller=? AND id=?").get(caller.principal.id, invalid.commandId)?.state, 'REJECTED');
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM events WHERE json_extract(payload,'$.kind')='command-rejected'").get()?.total, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM project').get()?.total, 0, 'Generic membership does not enroll native execution');
  } finally { db.close(); }
});
