// SPDX-License-Identifier: Apache-2.0
import type { Scope } from './types';

export const HUB_MESSAGE_KINDS = ['message', 'instruction', 'question', 'handoff', 'result'] as const;
export type HubMessageKind = typeof HUB_MESSAGE_KINDS[number];
export const HUB_LIMITS = {
  messageBytes: 8192, totalMessages: 10000, pageMessages: 100, pageBytes: 900 * 1024,
  pageConnections: 100, activeConnectionsPerMember: 32, totalConnections: 1000, connectionLifetimeSeconds: 86400,
} as const;
export const HUB_AGENT_CAPABILITIES = ['discussion:read', 'discussion:post', 'dependency:weft:read'] as const;

export interface HubActor {
  principalId: string;
  credentialClass: 'human' | 'agent';
  /** Present only for a delegated agent connection. The parent stays the member principal. */
  connectionId?: string;
  label?: string;
}
export interface HubMessage {
  /** Canonical decimal SQLite sequence, represented as text to avoid rounding. */
  sequence: string;
  requestId: string;
  kind: HubMessageKind;
  text: string;
  createdAt: number;
  actor: HubActor;
}
export interface HubPostBody {
  /** Generate and save this before sending to reconcile an uncertain response. Required for every post. */
  requestId: string;
  kind: HubMessageKind;
  text: string;
}
export interface HubMessagePage {
  scope: Scope;
  messages: HubMessage[];
  nextCursor: string;
  hasMore: boolean;
}
export interface HubConnection {
  connectionId: string;
  label: string;
  principalId: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  capabilities: readonly typeof HUB_AGENT_CAPABILITIES[number][];
}
export interface HubConnectionBody {
  /** A unique, stable registration identity; the same body retries safely. */
  connectionId: string;
  label: string;
  /** sha256:<lowercase hex> of UTF-8 canonical base64url token text, NOT decoded token bytes. */
  tokenHash: string;
  expiresAt: number;
}
export interface HubView extends HubMessagePage {
  session: { principalId: string; credentialClass: 'human' };
  capabilities: { post: boolean; connect: boolean };
  connections: HubConnection[];
  hasMoreConnections: boolean;
  limits: typeof HUB_LIMITS;
}
/** Download to the participating local agent; never store this object in browser persistence or logs. */
export interface HubConnectionFile {
  schemaVersion: 1;
  origin: string;
  projectId: string;
  projectIncarnation: string;
  connectionId: string;
  /** 32 browser-generated random bytes encoded as 43 canonical unpadded base64url characters. */
  token: string;
}
