// SPDX-License-Identifier: Apache-2.0
import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalize } from '../../packages/protocol/src/index';
import { COLLABORATION_OPERATIONS, COLLABORATION_ROLES, invitationDigestInput, type CollaborationRole, type CollaborationView, type CollaborationInvitation, type ProjectJoinRequest } from '../../packages/protocol/src/collaboration';
import type { Scope } from '../../packages/protocol/src/types';
import type { Principal } from '../shared/auth';
import { requireValue } from '../shared/errors';
import type { AuthorityCommand, TrustedCaller } from './types';

/** Membership context is independent of source/evaluation enrollment. */
export interface CollaborationProject { scope: Scope; revision: string; unresolvedPublicationId?: string | null }

export const COLLABORATION_LIMITS = { members: 100, pendingInvitations: 50, audit: 100 } as const;
export const RECENT_SESSION_SECONDS = 900;
const MAX_INVITATION_SECONDS = 7 * 86400;
type IdentityRow = { id: string; issuer: string; subject: string; tenant_id: string; credential_class: string; verified_at: number; session_cutoff: number };
type MemberRow = { subject: string; role: CollaborationRole; owner: number; active: number; roles: string; verified_at: number; session_cutoff: number; credential_class: string };
type InvitationRow = { id: string; token_digest: string; recipient: string; inviter: string; role: CollaborationRole; expires_at: number; state: CollaborationInvitation['state']; created_at: number; payload: string };
type MemberState = { role: CollaborationRole; active: boolean };
type JoinRow = { id: string; subject: string; request_key: string; scope: string; created_at: number; issued_at: number; state: ProjectJoinRequest['state'] };
const JOIN_LIFETIME = 7 * 86400;
const supportsAdditionalReview = (role: CollaborationRole): boolean => role === 'owner' || role === 'maintainer';
const effectiveReview = (member: MemberRow): boolean => member.active === 1 && member.credential_class === 'human' && JSON.parse(member.roles).includes('reviewer');
const additionalReview = (member: MemberRow): boolean => supportsAdditionalReview(member.role) && effectiveReview(member);
export const collaborationOperation = (operation: string): boolean => (COLLABORATION_OPERATIONS as readonly string[]).includes(operation);
export const collaborationRoles = (role: CollaborationRole): string[] => role === 'owner' ? ['export', 'reader', 'sponsor'] : role === 'reviewer' ? ['reader', 'reviewer'] : role === 'maintainer' ? ['reader', 'sponsor'] : ['reader'];
export const collaborationCanHoldGrant = (role: CollaborationRole): boolean => role !== 'viewer';

function exactFields(body: Record<string, unknown>, keys: string[]): void {
  requireValue(Object.keys(body).sort().join(',') === keys.sort().join(','), 'SCHEMA_ERROR');
}
function subjectId(value: unknown): string {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 160 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value), 'MEMBERSHIP_SUBJECT_INVALID');
  return value;
}
function identifier(value: unknown): string {
  requireValue(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value), 'SCHEMA_ERROR'); return value;
}
function preset(value: unknown): CollaborationRole {
  requireValue(typeof value === 'string' && (COLLABORATION_ROLES as readonly string[]).includes(value), 'UNSUPPORTED_ROLE'); return value as CollaborationRole;
}
export function verifiedAuthentication(principal: Principal, tenantId: string, currentTime: number, recent = false): NonNullable<Principal['authentication']> {
  const auth = principal.authentication;
  requireValue(auth && typeof auth.issuer === 'string' && typeof auth.subject === 'string' && auth.issuer.startsWith('https://') && !auth.issuer.includes('#')
    && auth.subject.length > 0 && principal.id === `${auth.issuer}#${auth.subject}` && principal.tenantId === tenantId
    && Number.isSafeInteger(auth.issuedAt) && auth.issuedAt >= 0 && auth.issuedAt <= currentTime + 5
    && Number.isSafeInteger(auth.expiresAt) && auth.expiresAt > currentTime && auth.expiresAt > auth.issuedAt,
  'VERIFIED_IDENTITY_REQUIRED', 403);
  subjectId(principal.id);
  requireValue(auth.authenticatedAt == null || Number.isSafeInteger(auth.authenticatedAt) && auth.authenticatedAt >= 0 && auth.authenticatedAt <= auth.issuedAt + 5, 'VERIFIED_IDENTITY_REQUIRED', 403);
  if (recent) requireValue(currentTime - auth.issuedAt <= RECENT_SESSION_SECONDS && (auth.authenticatedAt == null || currentTime - auth.authenticatedAt <= RECENT_SESSION_SECONDS), 'RECENT_SESSION_REQUIRED', 403);
  return auth;
}
export function invitationTokenDigest(scope: Scope, id: string, token: unknown): string {
  requireValue(typeof token === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token), 'INVITATION_UNAVAILABLE', 404);
  return `sha256:${createHash('sha256').update(invitationDigestInput(scope, id, token)).digest('hex')}`;
}
export function requireRemainingHumanOwner(before: MemberState | null, after: MemberState, activeOwners: number): void {
  requireValue(!before?.active || before.role !== 'owner' || after.active && after.role === 'owner' || activeOwners > 1, 'LAST_HUMAN_OWNER_REQUIRED', 409);
}

/** All mutations run inside the authority's command transaction, including grant fencing. */
export class CollaborationStore {
  constructor(private readonly sql: SqlStorage, private readonly stop: (grant: { attempt_id: string; generation: string }) => void) {}
  private row<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T | null { return this.sql.exec<T>(query, ...bindings).toArray()[0] ?? null; }
  enabled(scope: Scope): boolean {
    const config = this.row<{ payload: string }>('SELECT payload FROM collaboration_config WHERE singleton=1');
    if (!config) return false;
    requireValue(canonicalize(JSON.parse(config.payload).scope) === canonicalize(scope), 'PROJECT_INCAR_CHANGED', 409); return true;
  }
  private identity(id: string): IdentityRow | null { return this.row<IdentityRow>('SELECT * FROM verified_identities WHERE id=?', id); }
  private member(id: string): MemberRow | null {
    return this.row<MemberRow>('SELECT c.subject,c.role,c.owner,m.active,m.roles,i.verified_at,i.session_cutoff,i.credential_class FROM collaborators c JOIN memberships m ON m.subject=c.subject JOIN verified_identities i ON i.id=c.subject WHERE c.subject=?', id);
  }
  private owner(id: string): boolean {
    const member = this.member(id); return Boolean(member?.active && member.owner === 1 && member.role === 'owner' && member.credential_class === 'human');
  }
  private assertSession(principal: Principal, scope: Scope, currentTime: number, recent = false): NonNullable<Principal['authentication']> {
    const auth = verifiedAuthentication(principal, scope.tenantId, currentTime, recent), identity = this.identity(principal.id);
    if (identity) {
      requireValue(identity.issuer === auth.issuer && identity.subject === auth.subject && identity.tenant_id === scope.tenantId && identity.credential_class === principal.credentialClass, 'IDENTITY_BINDING_CHANGED', 403);
      requireValue(auth.issuedAt > identity.session_cutoff, 'SESSION_REVOKED', 401);
    }
    return auth;
  }
  private register(principal: Principal, scope: Scope, currentTime: number): void {
    const auth = this.assertSession(principal, scope, currentTime, true);
    this.sql.exec('INSERT INTO verified_identities(id,issuer,subject,tenant_id,credential_class,verified_at,session_cutoff) VALUES(?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET verified_at=excluded.verified_at', principal.id, auth.issuer, auth.subject, scope.tenantId, principal.credentialClass, currentTime);
  }
  assertCaller(caller: TrustedCaller, scope: Scope, currentTime: number): void {
    requireValue(caller.projectId === scope.projectId && caller.principal.tenantId === scope.tenantId, 'PROJECT_UNAVAILABLE', 404);
    if (!this.enabled(scope)) return;
    this.assertSession(caller.principal, scope, currentTime);
    requireValue(this.identity(caller.principal.id), 'VERIFIED_IDENTITY_REQUIRED', 403);
  }
  requireOwner(caller: TrustedCaller, scope: Scope, currentTime: number, recent = true): void {
    this.assertCaller(caller, scope, currentTime);
    requireValue(caller.principal.credentialClass === 'human' && this.owner(caller.principal.id), 'HUMAN_OWNER_REQUIRED', 403);
    this.assertSession(caller.principal, scope, currentTime, recent);
  }
  canManage(caller: TrustedCaller, scope: Scope, currentTime: number): boolean {
    this.assertCaller(caller, scope, currentTime);
    return caller.principal.credentialClass === 'human' && this.owner(caller.principal.id);
  }
  canReview(id: string, scope: Scope): boolean {
    const member = this.member(id);
    return !this.enabled(scope) || Boolean(member?.active && member.credential_class === 'human' && JSON.parse(member.roles).includes('reviewer'));
  }
  assertGrantSubject(id: string, scope: Scope): void {
    if (!this.enabled(scope)) return;
    const member = this.member(id);
    requireValue(member?.active && collaborationCanHoldGrant(member.role), 'SUBJECT_UNAVAILABLE', 403);
  }
  recordAcceptanceAttempt(caller: TrustedCaller, scope: Scope, currentTime: number, recent = true): void {
    requireValue(caller.projectId === scope.projectId && caller.principal.tenantId === scope.tenantId, 'PROJECT_UNAVAILABLE', 404);
    this.assertSession(caller.principal, scope, currentTime, recent);
    requireValue(caller.principal.credentialClass === 'human', 'HUMAN_OWNER_REQUIRED', 403);
    this.sql.exec('DELETE FROM invitation_acceptance_limits WHERE window_start<?', currentTime - 3600);
    const prior = this.row<{ window_start: number; attempts: number }>('SELECT window_start,attempts FROM invitation_acceptance_limits WHERE subject=?', caller.principal.id);
    const freshWindow = !prior || currentTime - prior.window_start >= 60;
    requireValue(freshWindow || prior.attempts < 30, 'INVITATION_ACCEPTANCE_RATE_LIMIT', 429);
    this.sql.exec('INSERT INTO invitation_acceptance_limits(subject,window_start,attempts) VALUES(?,?,?) ON CONFLICT(subject) DO UPDATE SET window_start=excluded.window_start,attempts=excluded.attempts', caller.principal.id, freshWindow ? currentTime : prior.window_start, freshWindow ? 1 : prior.attempts + 1);
  }
  private invalidate(subject: string, revokeGrants: boolean, revokeApprovals = true): { approvalsInvalidated: number; grantsRevoked: number } {
    const approvalsInvalidated = revokeApprovals ? this.sql.exec('DELETE FROM approvals WHERE reviewer=? AND consumed_by IS NULL RETURNING proposal_digest', subject).toArray().length : 0;
    const grants = revokeGrants ? this.sql.exec<{ id: string; attempt_id: string; generation: string }>('SELECT id,attempt_id,generation FROM grants WHERE subject=? AND revoked=0', subject).toArray() : [];
    for (const grant of grants) { this.sql.exec('UPDATE grants SET revoked=1 WHERE id=?', grant.id); this.stop(grant); }
    return { approvalsInvalidated, grantsRevoked: grants.length };
  }
  private saveMember(subject: string, role: CollaborationRole, active: boolean, review = false): void {
    const roles = collaborationRoles(role);
    if (active && supportsAdditionalReview(role) && review) roles.push('reviewer');
    this.sql.exec('INSERT INTO memberships(subject,roles,active) VALUES(?,?,?) ON CONFLICT(subject) DO UPDATE SET roles=excluded.roles,active=excluded.active', subject, canonicalize(roles), active ? 1 : 0);
    this.sql.exec('INSERT INTO collaborators(subject,role,owner) VALUES(?,?,?) ON CONFLICT(subject) DO UPDATE SET role=excluded.role,owner=excluded.owner', subject, role, role === 'owner' ? 1 : 0);
  }
  hubMember(caller: TrustedCaller, project: CollaborationProject, permission: 'read' | 'edit' | 'connect' | 'owner', currentTime: number) {
    requireValue(this.enabled(project.scope), 'COLLABORATION_REQUIRED', 409);
    this.assertCaller(caller, project.scope, currentTime);
    const member = this.member(caller.principal.id);
    requireValue(member?.active === 1 && member.credential_class === 'human' && caller.principal.credentialClass === 'human', 'PROJECT_UNAVAILABLE', 404);
    if (permission === 'owner') this.requireOwner(caller, project.scope, currentTime);
    if (permission === 'edit' || permission === 'connect') requireValue(member.role !== 'viewer', 'PROJECT_EDIT_DENIED', 403);
    if (permission === 'connect') this.assertSession(caller.principal, project.scope, currentTime, true);
    return { scope: project.scope, principalId: member.subject, sessionIssuedAt: caller.principal.authentication!.issuedAt,
      sessionCutoff: member.session_cutoff, canPost: member.role !== 'viewer', canConnect: member.role !== 'viewer' };
  }
  hubDelegatedMember(parent: { scope: Scope; principalId: string; sessionIssuedAt: number }, project: CollaborationProject, permission: 'read' | 'edit') {
    requireValue(canonicalize(parent.scope) === canonicalize(project.scope), 'PROJECT_INCAR_CHANGED', 409);
    requireValue(this.enabled(project.scope), 'COLLABORATION_REQUIRED', 409);
    const member = this.member(parent.principalId);
    requireValue(member?.active === 1 && member.credential_class === 'human', 'PROJECT_UNAVAILABLE', 404);
    requireValue(Number.isSafeInteger(parent.sessionIssuedAt) && parent.sessionIssuedAt > member.session_cutoff, 'SESSION_REVOKED', 401);
    if (permission === 'edit') requireValue(member.role !== 'viewer', 'PROJECT_EDIT_DENIED', 403);
    return { ...parent, sessionCutoff: member.session_cutoff, canPost: member.role !== 'viewer', canConnect: member.role !== 'viewer' };
  }
  private joinRequest(row: JoinRow, currentTime: number): ProjectJoinRequest {
    const display = this.row<{ email: string }>('SELECT email FROM join_request_display WHERE id=?', row.id);
    return { id: row.id, subject: row.subject, createdAt: row.created_at, role: 'maintainer',
      ...(display ? { verifiedEmail: display.email } : {}),
      state: row.state === 'PENDING' && row.created_at + JOIN_LIFETIME <= currentTime ? 'REVOKED' : row.state };
  }
  joinRequests(caller: TrustedCaller, project: CollaborationProject, currentTime: number) {
    requireValue(caller.projectId === project.scope.projectId && caller.principal.tenantId === project.scope.tenantId, 'PROJECT_UNAVAILABLE', 404);
    requireValue(caller.principal.credentialClass === 'human', 'HUMAN_REQUIRED', 403);
    this.assertSession(caller.principal, project.scope, currentTime);
    const enabled = this.enabled(project.scope), canManage = enabled && this.owner(caller.principal.id);
    const own = this.row<JoinRow>('SELECT * FROM project_join_requests WHERE subject=? ORDER BY created_at DESC,rowid DESC LIMIT 1', caller.principal.id);
    return { canManage, canRequest: enabled && !this.member(caller.principal.id)?.active,
      ownRequest: own ? this.joinRequest(own, currentTime) : null,
      requests: canManage ? this.sql.exec<JoinRow>("SELECT * FROM project_join_requests WHERE state='PENDING' AND created_at>? ORDER BY created_at,id LIMIT 50", currentTime - JOIN_LIFETIME).toArray().map(row => this.joinRequest(row, currentTime)) : [] };
  }
  requestJoin(caller: TrustedCaller, project: CollaborationProject, request: { requestId: string; expectedIncarnation: string; body: Record<string, unknown> }, currentTime: number): ProjectJoinRequest {
    requireValue(request && request.expectedIncarnation === project.scope.projectIncarnation, 'PROJECT_INCAR_CHANGED', 409);
    const key = identifier(request.requestId); requireValue(request.body && typeof request.body === 'object' && !Array.isArray(request.body), 'SCHEMA_ERROR'); exactFields(request.body, []);
    const view = this.joinRequests(caller, project, currentTime);
    this.assertSession(caller.principal, project.scope, currentTime, true);
    requireValue(this.enabled(project.scope), 'COLLABORATION_REQUIRED', 409);
    const scope = canonicalize(project.scope), prior = this.row<JoinRow>('SELECT * FROM project_join_requests WHERE subject=? AND request_key=?', caller.principal.id, key);
    if (prior) { requireValue(prior.scope === scope, 'COMMAND_ID_REUSED', 409); return this.joinRequest(prior, currentTime); }
    requireValue(view.canRequest, 'MEMBERSHIP_ALREADY_ACTIVE', 409);
    requireValue(!this.row("SELECT id FROM project_join_requests WHERE subject=? AND state='PENDING' AND created_at>? LIMIT 1", caller.principal.id, currentTime - JOIN_LIFETIME), 'JOIN_REQUEST_ALREADY_PENDING', 409);
    requireValue(this.row<{ count: number }>('SELECT COUNT(*) AS count FROM project_join_requests')!.count < 1000, 'JOIN_REQUEST_LIMIT', 429);
    requireValue(this.row<{ count: number }>("SELECT COUNT(*) AS count FROM project_join_requests WHERE state='PENDING' AND created_at>?", currentTime - JOIN_LIFETIME)!.count < 50, 'JOIN_REQUEST_LIMIT', 429);
    requireValue(this.row<{ count: number }>('SELECT COUNT(*) AS count FROM project_join_requests WHERE subject=? AND created_at>?', caller.principal.id, currentTime - 3600)!.count < 5, 'JOIN_REQUEST_RATE_LIMIT', 429);
    this.register(caller.principal, project.scope, currentTime);
    const id = 'join-' + createHash('sha256').update(canonicalize({ scope: project.scope, subject: caller.principal.id, key })).digest('hex');
    this.sql.exec("INSERT INTO project_join_requests(id,subject,request_key,scope,created_at,issued_at,state) VALUES(?,?,?,?,?,?,'PENDING')", id, caller.principal.id, key, scope, currentTime, caller.principal.authentication!.issuedAt);
    if (caller.principal.verifiedEmail !== undefined) this.sql.exec('INSERT INTO join_request_display(id,email) VALUES(?,?)', id, caller.principal.verifiedEmail);
    return this.joinRequest({ id, subject: caller.principal.id, request_key: key, scope, created_at: currentTime, issued_at: caller.principal.authentication!.issuedAt, state: 'PENDING' }, currentTime);
  }
  private invitation(row: InvitationRow, currentTime: number): CollaborationInvitation {
    return { id: row.id, recipientId: row.recipient, inviter: row.inviter, role: row.role, createdAt: row.created_at, expiresAt: row.expires_at, state: row.state === 'PENDING' && row.expires_at <= currentTime ? 'EXPIRED' : row.state };
  }
  inspectInvitation(caller: TrustedCaller, project: CollaborationProject, command: AuthorityCommand, currentTime: number): { scope: Scope; invitation: CollaborationInvitation } {
    requireValue(command.operation === 'inspect-invitation' && command.expectedRevision === '0', 'SCHEMA_ERROR');
    requireValue(command.expectedIncarnation === project.scope.projectIncarnation, 'PROJECT_INCAR_CHANGED', 409);
    requireValue(caller.projectId === project.scope.projectId && caller.principal.tenantId === project.scope.tenantId, 'PROJECT_UNAVAILABLE', 404);
    requireValue(caller.principal.credentialClass === 'human', 'HUMAN_OWNER_REQUIRED', 403);
    this.assertSession(caller.principal, project.scope, currentTime);
    requireValue(this.enabled(project.scope), 'INVITATION_UNAVAILABLE', 404);
    exactFields(command.body, ['invitationId', 'token']); const id = identifier(command.body.invitationId);
    const tokenDigest = invitationTokenDigest(project.scope, id, command.body.token);
    const invite = this.row<InvitationRow>('SELECT * FROM invitations WHERE id=?', id);
    requireValue(invite && invite.recipient === caller.principal.id && invite.state === 'PENDING' && invite.expires_at > currentTime && this.owner(invite.inviter)
      && canonicalize(JSON.parse(invite.payload).scope) === canonicalize(project.scope), 'INVITATION_UNAVAILABLE', 404);
    requireValue(timingSafeEqual(Buffer.from(tokenDigest), Buffer.from(invite.token_digest)), 'INVITATION_UNAVAILABLE', 404);
    return { scope: project.scope, invitation: this.invitation(invite, currentTime) };
  }
  view(caller: TrustedCaller, project: CollaborationProject, bootstrap: string[], currentTime: number): CollaborationView {
    const enabled = this.enabled(project.scope), principal = caller.principal;
    this.assertCaller(caller, project.scope, currentTime);
    const membership = this.row<{ active: number; roles: string }>('SELECT active,roles FROM memberships WHERE subject=?', principal.id);
    requireValue(membership?.active, 'PROJECT_UNAVAILABLE', 404);
    const canEnable = !enabled && principal.credentialClass === 'human' && Boolean(principal.authentication) && bootstrap.includes(principal.id) && JSON.parse(membership.roles).includes('admin');
    const canManage = enabled && principal.credentialClass === 'human' && this.owner(principal.id);
    let migration: CollaborationView['migration'];
    if (canEnable) {
      const count = this.row<{ count: number }>('SELECT COUNT(*) AS count FROM memberships WHERE subject!=? AND active=1', principal.id)!.count;
      const sample = this.sql.exec<{ subject: string; roles: string }>('SELECT subject,roles FROM memberships WHERE subject!=? AND active=1 ORDER BY subject LIMIT 100', principal.id).toArray();
      migration = {
        membersToSuspend: count, memberSample: sample.map(row => ({ subject: row.subject, roles: JSON.parse(row.roles) })), sampleTruncated: sample.length < count,
        grantsToRevoke: this.row<{ count: number }>('SELECT COUNT(*) AS count FROM grants WHERE subject!=? AND revoked=0', principal.id)!.count,
        approvalsToInvalidate: this.row<{ count: number }>('SELECT COUNT(*) AS count FROM approvals WHERE consumed_by IS NULL')!.count,
        unresolvedPublicationId: project.unresolvedPublicationId ?? null,
      };
    }
    const members = enabled ? this.sql.exec<MemberRow>('SELECT c.subject,c.role,c.owner,m.active,m.roles,i.verified_at,i.session_cutoff,i.credential_class FROM collaborators c JOIN memberships m ON m.subject=c.subject JOIN verified_identities i ON i.id=c.subject ORDER BY c.subject LIMIT ?', COLLABORATION_LIMITS.members).toArray().map(row => ({ subject: row.subject, role: row.role, active: row.active === 1, verifiedAt: row.verified_at, sessionsRevokedBefore: row.session_cutoff, ...(additionalReview(row) ? { additionalReview: true } : {}) })) : [];
    const invitations = canManage ? this.sql.exec<InvitationRow>('SELECT * FROM invitations ORDER BY created_at DESC,id DESC LIMIT 100').toArray().map(row => this.invitation(row, currentTime)) : [];
    const events = enabled ? this.sql.exec<{ payload: string }>("SELECT payload FROM events WHERE json_extract(payload,'$.kind') IN ('enable-collaboration','create-invitation','accept-invitation','revoke-invitation','update-collaborator','set-collaborator-review','revoke-member-sessions','admit-join-request') ORDER BY sequence DESC LIMIT ?", COLLABORATION_LIMITS.audit).toArray() : [];
    const audit = events.map(row => { const event = JSON.parse(row.payload); return { id: event.id, kind: event.kind, actor: event.payload.actor, target: event.payload.subject ?? event.payload.recipientId ?? event.payload.invitationId ?? '', at: Math.floor(Date.parse(event.time) / 1000), details: event.payload }; });
    return { enabled, scope: project.scope, revision: project.revision, session: { principalId: principal.id, tenantId: principal.tenantId, credentialClass: principal.credentialClass, ...(principal.authentication ? { authentication: principal.authentication } : {}) }, canEnable, canManage, members, invitations, audit, limits: COLLABORATION_LIMITS, ...(migration ? { migration } : {}) };
  }
  apply(caller: TrustedCaller, project: CollaborationProject, command: AuthorityCommand, bootstrap: string[], currentTime: number): Record<string, unknown> {
    const { body, operation } = command, principal = caller.principal;
    requireValue(caller.projectId === project.scope.projectId && principal.tenantId === project.scope.tenantId, 'PROJECT_UNAVAILABLE', 404);
    requireValue(command.expectedIncarnation === project.scope.projectIncarnation, 'PROJECT_INCAR_CHANGED', 409);
    requireValue(principal.credentialClass === 'human', 'HUMAN_OWNER_REQUIRED', 403);
    this.assertSession(principal, project.scope, currentTime, true);
    const audit = { actor: principal.id, authorityRevision: (BigInt(project.revision) + 1n).toString() };
    if (operation === 'enable-collaboration') {
      exactFields(body, []); requireValue(!this.enabled(project.scope), 'COLLABORATION_ALREADY_ENABLED', 409);
      const member = this.row<{ active: number; roles: string }>('SELECT active,roles FROM memberships WHERE subject=?', principal.id);
      requireValue(bootstrap.includes(principal.id) && member?.active && JSON.parse(member.roles).includes('admin'), 'HUMAN_OWNER_REQUIRED', 403);
      this.register(principal, project.scope, currentTime); this.saveMember(principal.id, 'owner', true);
      this.sql.exec('INSERT INTO collaboration_config(singleton,payload) VALUES(1,?)', canonicalize({ scope: project.scope, enabledBy: principal.id, enabledAt: currentTime }));
      const invalidated = this.sql.exec('DELETE FROM approvals WHERE consumed_by IS NULL RETURNING proposal_digest').toArray().length;
      const legacy = this.sql.exec<{ subject: string }>('SELECT subject FROM memberships WHERE subject!=? AND active=1', principal.id).toArray();
      for (const member of legacy) this.sql.exec('UPDATE memberships SET active=0 WHERE subject=?', member.subject);
      // Orphaned or inactive legacy subjects must not recover old capabilities
      // when they later accept a fresh invitation.
      const grants = this.sql.exec<{ id: string; attempt_id: string; generation: string }>('SELECT id,attempt_id,generation FROM grants WHERE subject!=? AND revoked=0', principal.id).toArray();
      for (const grant of grants) { this.sql.exec('UPDATE grants SET revoked=1 WHERE id=?', grant.id); this.stop(grant); }
      return { ...audit, state: 'COLLABORATION_ENABLED', subject: principal.id, before: { roles: JSON.parse(member.roles), active: true }, after: { role: 'owner', active: true }, approvalsInvalidated: invalidated, legacyMembershipsSuspended: legacy.length, grantsRevoked: grants.length };
    }
    requireValue(this.enabled(project.scope), 'COLLABORATION_REQUIRED', 409);
    if (operation === 'accept-invitation') {
      exactFields(body, ['invitationId', 'token']);
      const id = identifier(body.invitationId), expectedDigest = invitationTokenDigest(project.scope, id, body.token);
      const invite = this.row<InvitationRow>('SELECT * FROM invitations WHERE id=?', id);
      requireValue(invite && invite.recipient === principal.id && invite.state === 'PENDING' && invite.expires_at > currentTime && this.owner(invite.inviter)
        && canonicalize(JSON.parse(invite.payload).scope) === canonicalize(project.scope), 'INVITATION_UNAVAILABLE', 404);
      requireValue(timingSafeEqual(Buffer.from(expectedDigest), Buffer.from(invite.token_digest)), 'INVITATION_UNAVAILABLE', 404);
      const before = this.member(principal.id);
      requireValue(!before?.active || invite.role === 'owner' && before.role !== 'owner', 'INVITATION_UNAVAILABLE', 404);
      const count = this.row<{ count: number }>('SELECT COUNT(*) AS count FROM collaborators')!.count;
      requireValue(before || count < COLLABORATION_LIMITS.members, 'COLLABORATION_MEMBER_LIMIT', 409);
      this.register(principal, project.scope, currentTime); this.saveMember(principal.id, invite.role, true);
      requireValue(this.sql.exec("UPDATE invitations SET state='ACCEPTED' WHERE id=? AND state='PENDING' RETURNING id", id).toArray().length === 1, 'INVITATION_UNAVAILABLE', 404);
      const invalidation = this.invalidate(principal.id, false);
      return { ...audit, state: 'INVITATION_ACCEPTED', invitationId: id, subject: principal.id, before: before ? { role: before.role, active: before.active === 1 } : null, after: { role: invite.role, active: true }, ...invalidation };
    }
    this.requireOwner(caller, project.scope, currentTime);
    if (operation === 'admit-join-request') {
      exactFields(body, ['requestId']); const id = identifier(body.requestId), request = this.row<JoinRow>('SELECT * FROM project_join_requests WHERE id=?', id);
      requireValue(request && request.state === 'PENDING' && request.created_at + JOIN_LIFETIME > currentTime && request.scope === canonicalize(project.scope), 'JOIN_REQUEST_UNAVAILABLE', 404);
      const identity = this.identity(request.subject), before = this.member(request.subject);
      requireValue(identity?.credential_class === 'human' && request.issued_at > identity.session_cutoff && !before?.active, 'JOIN_REQUEST_UNAVAILABLE', 404);
      requireValue(before || this.row<{ count: number }>('SELECT COUNT(*) AS count FROM collaborators')!.count < COLLABORATION_LIMITS.members, 'COLLABORATION_MEMBER_LIMIT', 409);
      this.saveMember(request.subject, 'maintainer', true);
      this.sql.exec("UPDATE project_join_requests SET state='ADMITTED' WHERE id=?", id);
      const invalidation = this.invalidate(request.subject, false);
      return { ...audit, state: 'JOIN_REQUEST_ADMITTED', requestId: id, subject: request.subject,
        before: before ? { role: before.role, active: before.active === 1 } : null, after: { role: 'maintainer', active: true }, ...invalidation };
    }
    if (operation === 'create-invitation') {
      exactFields(body, ['invitationId', 'recipientId', 'role', 'tokenDigest', 'expiresAt']);
      const id = identifier(body.invitationId), recipientId = subjectId(body.recipientId), role = preset(body.role), auth = principal.authentication!;
      requireValue(recipientId.startsWith(`${auth.issuer}#`) && recipientId.length > auth.issuer.length + 1 && recipientId !== principal.id, 'INVITATION_RECIPIENT_INVALID');
      requireValue(typeof body.tokenDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(body.tokenDigest), 'INVITATION_DIGEST_INVALID');
      requireValue(Number.isSafeInteger(body.expiresAt) && (body.expiresAt as number) > currentTime && (body.expiresAt as number) <= currentTime + MAX_INVITATION_SECONDS, 'INVITATION_EXPIRY_INVALID');
      const existing = this.member(recipientId), identity = this.identity(recipientId);
      requireValue(!identity || identity.credential_class === 'human', 'HUMAN_IDENTITY_REQUIRED', 403);
      requireValue(!existing?.active || role === 'owner' && existing.role !== 'owner', 'MEMBERSHIP_ALREADY_ACTIVE', 409);
      const count = this.row<{ count: number }>("SELECT COUNT(*) AS count FROM invitations WHERE state='PENDING' AND expires_at>? AND recipient!=?", currentTime, recipientId)!.count;
      requireValue(count < COLLABORATION_LIMITS.pendingInvitations, 'INVITATION_LIMIT', 429);
      const recent = this.row<{ count: number }>('SELECT COUNT(*) AS count FROM invitations WHERE inviter=? AND created_at>?', principal.id, currentTime - 3600)!.count;
      requireValue(recent < 100, 'INVITATION_RATE_LIMIT', 429);
      requireValue(!this.row('SELECT id FROM invitations WHERE id=? OR token_digest=?', id, body.tokenDigest), 'INVITATION_ID_REUSED', 409);
      this.sql.exec("UPDATE invitations SET state='REVOKED' WHERE recipient=? AND state='PENDING'", recipientId);
      this.sql.exec("INSERT INTO invitations(id,token_digest,recipient,inviter,role,expires_at,state,created_at,payload) VALUES(?,?,?,?,?,?,'PENDING',?,?)", id, body.tokenDigest, recipientId, principal.id, role, body.expiresAt as number, currentTime, canonicalize({ scope: project.scope }));
      return { ...audit, state: 'INVITATION_CREATED', invitationId: id, recipientId, role, expiresAt: body.expiresAt, before: null, after: { state: 'PENDING', role } };
    }
    if (operation === 'revoke-invitation') {
      exactFields(body, ['invitationId']); const id = identifier(body.invitationId), invite = this.row<InvitationRow>('SELECT * FROM invitations WHERE id=?', id);
      requireValue(invite && invite.state === 'PENDING', 'INVITATION_UNAVAILABLE', 404);
      this.sql.exec("UPDATE invitations SET state='REVOKED' WHERE id=?", id);
      return { ...audit, state: 'INVITATION_REVOKED', invitationId: id, recipientId: invite.recipient, before: { state: invite.state }, after: { state: 'REVOKED' } };
    }
    if (operation === 'update-collaborator') {
      exactFields(body, ['subject', 'role', 'active']); const subject = subjectId(body.subject), role = preset(body.role);
      requireValue(typeof body.active === 'boolean', 'SCHEMA_ERROR'); const active = body.active, retained = this.member(subject);
      requireValue(retained && retained.credential_class === 'human', 'MEMBER_UNAVAILABLE', 404);
      requireValue(!active || retained.active === 1, 'INVITATION_ACCEPTANCE_REQUIRED', 409);
      requireValue(role !== 'owner' || retained.role === 'owner', 'INVITATION_ACCEPTANCE_REQUIRED', 409);
      const before = { role: retained.role, active: retained.active === 1 }, after = { role, active };
      const owners = this.row<{ count: number }>("SELECT COUNT(*) AS count FROM collaborators c JOIN memberships m ON m.subject=c.subject JOIN verified_identities i ON i.id=c.subject WHERE c.owner=1 AND c.role='owner' AND m.active=1 AND i.credential_class='human'")!.count;
      const preserveReview = active && supportsAdditionalReview(role) && additionalReview(retained);
      const losesReview = effectiveReview(retained) && !(active && (role === 'reviewer' || preserveReview));
      requireRemainingHumanOwner(before, after, owners); this.saveMember(subject, role, active, preserveReview);
      const invalidation = this.invalidate(subject, !active || !collaborationCanHoldGrant(role), !active || losesReview);
      if (!active) this.sql.exec("UPDATE project_join_requests SET state='REVOKED' WHERE subject=?", subject);
      const invitationsRevoked = !active
        ? this.sql.exec("UPDATE invitations SET state='REVOKED' WHERE (inviter=? OR recipient=?) AND state='PENDING' RETURNING id", subject, subject).toArray().length
        : before.role === 'owner' && role !== 'owner' ? this.sql.exec("UPDATE invitations SET state='REVOKED' WHERE inviter=? AND state='PENDING' RETURNING id", subject).toArray().length : 0;
      return { ...audit, state: active ? 'MEMBERSHIP_ACTIVE' : 'MEMBERSHIP_REVOKED', subject, before, after, invitationsRevoked, ...invalidation };
    }
    if (operation === 'set-collaborator-review') {
      exactFields(body, ['subject', 'enabled']); const subject = subjectId(body.subject), member = this.member(subject);
      requireValue(typeof body.enabled === 'boolean', 'SCHEMA_ERROR');
      requireValue(member?.active === 1 && member.credential_class === 'human', 'MEMBER_UNAVAILABLE', 404);
      requireValue(supportsAdditionalReview(member.role), 'ADDITIONAL_REVIEW_UNAVAILABLE', 409);
      const before = additionalReview(member), enabled = body.enabled;
      this.saveMember(subject, member.role, true, enabled);
      const invalidation = this.invalidate(subject, false, before && !enabled);
      return { ...audit, state: 'COLLABORATOR_REVIEW_UPDATED', subject, before: { additionalReview: before }, after: { additionalReview: enabled }, ...invalidation };
    }
    requireValue(operation === 'revoke-member-sessions', 'UNSUPPORTED_OPERATION');
    exactFields(body, ['subject']); const subject = subjectId(body.subject), member = this.member(subject);
    requireValue(member, 'MEMBER_UNAVAILABLE', 404);
    // Include tokens already accepted under the provider verifier's clock skew.
    const cutoff = Math.max(currentTime + 5, member.session_cutoff);
    this.sql.exec('UPDATE verified_identities SET session_cutoff=? WHERE id=?', cutoff, subject);
    this.sql.exec("UPDATE project_join_requests SET state='REVOKED' WHERE subject=? AND state='PENDING'", subject);
    const invalidation = this.invalidate(subject, true);
    const invitationsRevoked = this.sql.exec("UPDATE invitations SET state='REVOKED' WHERE (inviter=? OR recipient=?) AND state='PENDING' RETURNING id", subject, subject).toArray().length;
    return { ...audit, state: 'PROJECT_SESSIONS_REVOKED', subject, before: { sessionsRevokedBefore: member.session_cutoff }, after: { sessionsRevokedBefore: cutoff }, invitationsRevoked, ...invalidation };
  }
}
