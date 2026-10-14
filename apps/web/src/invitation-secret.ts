import type { CollaborationInvitation, CollaborationSession, InvitationLink } from '../../../packages/protocol/src/collaboration';
import { COLLABORATION_ROLES } from '../../../packages/protocol/src/collaboration';
import type { Scope } from '../../../packages/protocol/src/types';
export type InvitationSecret = InvitationLink;

export interface InvitationIntake {
  secret?: InvitationSecret;
  error?: string;
}

export interface InvitationInspection { scope: Scope; invitation: CollaborationInvitation }

export function matchingInvitationInspection(secret: InvitationSecret, session: CollaborationSession, preview: InvitationInspection, now = Date.now() / 1000): boolean {
  return preview.scope?.schemaVersion === 1 && preview.scope.tenantId === secret.scope.tenantId && preview.scope.projectId === secret.scope.projectId
    && preview.scope.projectIncarnation === secret.scope.projectIncarnation && preview.invitation?.id === secret.invitationId
    && preview.invitation.recipientId === session.principalId && preview.invitation.state === 'PENDING' && preview.invitation.expiresAt > now
    && COLLABORATION_ROLES.includes(preview.invitation.role);
}

/** Strip delivery material before rendering or making any application request. */
export function takeInvitationFromLocation(location: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'replaceState'>): InvitationIntake | undefined {
  if (!location.hash.startsWith('#/accept?')) return undefined;
  const raw = location.hash.slice('#/accept?'.length);
  history.replaceState(null, '', `${location.pathname}${location.search}#/accept`);
  const params = new URLSearchParams(raw);
  const invitationId = params.get('invitationId');
  const token = params.get('token');
  const tenantId = params.get('tenantId'), projectId = params.get('projectId'), projectIncarnation = params.get('projectIncarnation');
  const validId = (value: string | null): value is string => Boolean(value && /^[a-zA-Z0-9_-]{1,128}$/.test(value));
  if (raw.length > 2048 || [...params.keys()].length !== 6 || params.get('schemaVersion') !== '1' || !validId(invitationId)
    || !validId(tenantId) || !validId(projectId) || !validId(projectIncarnation)
    || !token || !/^[a-zA-Z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token)) return { error: 'This invitation link is incomplete or invalid.' };
  return { secret: { scope: { schemaVersion: 1, tenantId, projectId, projectIncarnation }, invitationId, token } };
}

export function invitationLink(origin: string, secret: InvitationSecret): string {
  const params = new URLSearchParams({ schemaVersion: '1', tenantId: secret.scope.tenantId, projectId: secret.scope.projectId, projectIncarnation: secret.scope.projectIncarnation, invitationId: secret.invitationId, token: secret.token });
  return `${origin}/#/accept?${params.toString()}`;
}
