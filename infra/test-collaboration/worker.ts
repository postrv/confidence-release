// SPDX-License-Identifier: Apache-2.0
// Test-only entry point. Never deploy: control routes deliberately bypass auth.
import application from '../../workers/app/index';
import authority from '../../workers/authority/index';
export { ProjectDirectory } from '../../workers/authority/index';
import { TestAuthority } from '../test-authority/worker';
import type { AuthorityEnv } from '../../workers/authority/types';
import { canonicalize } from '../../packages/protocol/src/index';

export class CollaborationTestAuthority extends TestAuthority {
  async seedOwner(input: any): Promise<unknown> {
    await this.seed(input);
    this.ctx.storage.sql.exec('UPDATE memberships SET subject=? WHERE subject=?', input.owner, 'human-1');
    return { seeded: true };
  }
  async inspectCollaboration(): Promise<unknown> {
    const tables = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray();
    const rows: Record<string, unknown> = {};
    for (const { name } of tables) {
      if (/^[a-z_]+$/.test(name) && !name.startsWith('_')) rows[name] = this.ctx.storage.sql.exec(`SELECT * FROM ${name}`).toArray();
    }
    return rows;
  }
  /** Local fixture only: preserve one pending invitation's lifetime while aging its history. */
  async ageInvitationToPastExpiry(input: { invitationId: string }): Promise<{ changedRows: number; invitationId?: string; createdAt?: number; expiresAt?: number; observedAt?: number }> {
    if (!input || Object.keys(input).join(',') !== 'invitationId' || typeof input.invitationId !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.invitationId)) return { changedRows: 0 };
    return this.ctx.storage.transactionSync(() => {
      const retained = this.ctx.storage.sql.exec<{ created_at: number; expires_at: number }>("SELECT created_at,expires_at FROM invitations WHERE id=? AND state='PENDING'", input.invitationId).toArray()[0];
      const observedAt = Math.floor(Date.now() / 1000);
      if (!retained || !Number.isSafeInteger(retained.created_at) || !Number.isSafeInteger(retained.expires_at)
        || retained.expires_at <= observedAt || retained.expires_at <= retained.created_at) return { changedRows: 0 };
      const expiresAt = observedAt - 1, createdAt = expiresAt - (retained.expires_at - retained.created_at);
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) return { changedRows: 0 };
      const changedRows = this.ctx.storage.sql.exec("UPDATE invitations SET created_at=?,expires_at=? WHERE id=? AND state='PENDING' AND created_at=? AND expires_at=? RETURNING id",
        createdAt, expiresAt, input.invitationId, retained.created_at, retained.expires_at).toArray().length;
      return { changedRows, invitationId: input.invitationId, createdAt, expiresAt, observedAt };
    });
  }
  async seedLegacyMigrationState(input: { subjects: string[]; reviewer: string; owner: string }): Promise<unknown> {
    const authority = this as any, project = authority.project(), expiresAt = Math.floor(Date.now() / 1000) + 600;
    if (input.subjects.length !== 6 || input.subjects.some(subject => !subject.startsWith('https://identity.owned.test#'))) throw Error('OWNED_SUBJECTS_REQUIRED');
    this.ctx.storage.transactionSync(() => {
      for (const [index, subject] of input.subjects.entries()) {
        const id = `owned-migration-grant-${index}`, attemptId = `owned-migration-attempt-${index}`;
        const grant = { id, subject, attemptId, generation: '1', operations: ['start-execution'], pathPrefixes: ['cache.mjs'], resources: [attemptId], destinations: [], maximumBudget: '1000', expiresAt, authorityGeneration: '1' };
        this.ctx.storage.sql.exec('INSERT INTO grants(id,subject,attempt_id,generation,revoked,expires_at,payload) VALUES(?,?,?,?,0,?,?)', id, subject, attemptId, '1', expiresAt, canonicalize(grant));
        authority.retain('attempt', attemptId, { id: attemptId, grantId: id, subject, generation: '1', repoName: attemptId, workBase: project.head, publicationBase: project.head, deadline: expiresAt, state: 'RESERVED', goalRevision: project.goalRevision, recipe: 'owned-legacy-migration-fixture' });
      }
      for (const [index, reviewer] of [input.reviewer, input.owner].entries()) this.ctx.storage.sql.exec('INSERT INTO approvals(proposal_digest,reviewer,expires_at,consumed_by) VALUES(?,?,?,NULL)', `sha256:${String(index + 7).repeat(64)}`, reviewer, expiresAt);
      this.ctx.storage.sql.exec('INSERT INTO reservations(id,owner,maximum,state,settled,payload) VALUES(?,?,?,?,?,?)', 'owned-migration-settled', 'owned-legacy-history', '12000', 'SETTLED', '8000', canonicalize({ testOnlyHistoricalReservation: true }));
      const revision = project.revision; project.settledBudget = '8000'; project.revision = (BigInt(revision) + 1n).toString(); authority.saveProject(project, revision);
    });
    return { grants: input.subjects.length, unusedApprovals: 2, settledBudget: '8000' };
  }
}

export default {
  async fetch(request: Request, env: AuthorityEnv & Record<string, any>): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/_test/')) {
      const stub = env.PROJECTS.getByName(`${env.AUTH_TENANT_ID}/${env.DEFAULT_PROJECT_ID}`) as DurableObjectStub<CollaborationTestAuthority>;
      if (path === '/_test/seed') return Response.json(await stub.seedOwner(await request.json()));
      if (path === '/_test/inspect') return Response.json(await stub.inspectCollaboration());
      if (path === '/_test/expire-invitation') {
        if (request.method !== 'POST') return Response.json({ changedRows: 0 }, { status: 405 });
        const result = await stub.ageInvitationToPastExpiry(await request.json());
        return Response.json(result, { status: result.changedRows === 1 ? 200 : 409 });
      }
      if (path === '/_test/migration-state') return Response.json(await stub.seedLegacyMigrationState(await request.json()));
      if (path === '/_test/evidence') return stub.api('evidence', await request.json());
      if (path === '/_test/drain') return Response.json(await stub.drain());
      if (path === '/_test/complete-effect') return Response.json(await stub.completeFakeEffect());
      return new Response('Not found', { status: 404 });
    }
    // Both production handlers run, including service-token validation. Only the
    // in-process service transport is substituted; no authorization is mocked.
    return application.fetch(request, { ...env, AUTHORITY: { fetch: (input: RequestInfo | URL, init?: RequestInit) => authority.fetch(new Request(input, init), env) } } as any);
  },
};
