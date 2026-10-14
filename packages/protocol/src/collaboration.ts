// SPDX-License-Identifier: Apache-2.0
import type { Scope } from './types';
import { canonicalize } from './index';

export const COLLABORATION_ROLES = ['viewer', 'contributor', 'reviewer', 'maintainer', 'owner'] as const;
export type CollaborationRole = typeof COLLABORATION_ROLES[number];
export const COLLABORATION_OPERATIONS = ['enable-collaboration', 'create-invitation', 'accept-invitation', 'revoke-invitation', 'update-collaborator', 'set-collaborator-review', 'revoke-member-sessions', 'admit-join-request'] as const;
export type CollaborationOperation = typeof COLLABORATION_OPERATIONS[number];

export interface CollaborationSession {
  principalId: string;
  tenantId: string;
  credentialClass: 'human' | 'agent' | 'service';
  authentication?: { issuer: string; subject: string; issuedAt: number; expiresAt: number; authenticatedAt?: number | null };
}
export interface Collaborator {
  subject: string;
  role: CollaborationRole;
  active: boolean;
  verifiedAt: number;
  sessionsRevokedBefore: number;
  /** Explicit review permission in addition to an active owner/maintainer preset. Absent means false. */
  additionalReview?: boolean;
}
export interface CollaborationInvitation {
  id: string;
  recipientId: string;
  role: CollaborationRole;
  inviter: string;
  createdAt: number;
  expiresAt: number;
  state: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
}
export interface ProjectJoinRequest {
  id: string;
  subject: string;
  /** Signed Access email for human recognition only; never used as an identity or grant. */
  verifiedEmail?: string;
  createdAt: number;
  state: 'PENDING' | 'ADMITTED' | 'REVOKED';
  role: 'maintainer';
}
export interface ProjectJoinRequestsView {
  schemaVersion: 1;
  scope: Scope;
  projectName: string;
  projectStatus: 'ACTIVE' | 'ARCHIVED';
  revision: string;
  canManage: boolean;
  canRequest: boolean;
  ownRequest: ProjectJoinRequest | null;
  requests: ProjectJoinRequest[];
}
export interface CollaborationAudit {
  id: string;
  kind: string;
  actor: string;
  target: string;
  at: number;
  details: Record<string, unknown>;
}
export interface CollaborationView {
  enabled: boolean;
  scope: Scope;
  revision: string;
  session: CollaborationSession;
  canEnable: boolean;
  canManage: boolean;
  members: Collaborator[];
  invitations: CollaborationInvitation[];
  audit: CollaborationAudit[];
  limits: { members: number; pendingInvitations: number; audit: number };
  migration?: {
    membersToSuspend: number;
    memberSample: { subject: string; roles: string[] }[];
    sampleTruncated: boolean;
    grantsToRevoke: number;
    approvalsToInvalidate: number;
    unresolvedPublicationId: string | null;
  };
}
export interface CreateInvitationBody {
  invitationId: string;
  recipientId: string;
  role: CollaborationRole;
  tokenDigest: string;
  expiresAt: number;
}
export interface InvitationLink {
  scope: Scope;
  invitationId: string;
  token: string;
}
export function invitationDigestInput(scope: Scope, invitationId: string, token: string): string {
  return canonicalize({ domain: 'confidence/invitation/v1', scope, invitationId, token });
}
