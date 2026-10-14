// SPDX-License-Identifier: Apache-2.0
import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalize } from '../../packages/protocol/src/index';
import type { Scope } from '../../packages/protocol/src/types';
import {
  HUB_AGENT_CAPABILITIES, HUB_LIMITS, HUB_MESSAGE_KINDS,
  type HubActor, type HubConnection, type HubConnectionBody, type HubMessage, type HubMessagePage,
  type HubMessageKind, type HubView,
} from '../../packages/protocol/src/project-hub';
import { requireValue } from '../shared/errors';
import type { TrustedCaller } from './types';

export const PROJECT_HUB_SCHEMA = `
CREATE TABLE IF NOT EXISTS hub_scope (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hub_messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_key TEXT NOT NULL, request_id TEXT NOT NULL, input_digest TEXT NOT NULL,
  kind TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, actor TEXT NOT NULL,
  UNIQUE(actor_key, request_id)
);
CREATE TABLE IF NOT EXISTS hub_connections (
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, session_issued_at INTEGER NOT NULL,
  label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, input_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS hub_connections_principal ON hub_connections(principal_id, created_at DESC, id);
`;

export interface HubParent { scope: Scope; principalId: string; sessionIssuedAt: number }
export interface HubMemberContext extends HubParent {
  sessionCutoff: number;
  canPost: boolean;
  canConnect: boolean;
}
export type HubHumanOperation = 'read' | 'post' | 'connect';
export type HubAgentOperation = 'read' | 'post' | 'dependency';
export interface HubAuthorization {
  /** Must freshly authorize the current verified human and native/generic project membership. */
  authorizeHuman(caller: TrustedCaller, operation: HubHumanOperation): HubMemberContext;
  /** Must freshly resolve membership and session cutoff, with no cached authorization decision. */
  authorizeMember(parent: HubParent, operation: HubAgentOperation): HubMemberContext;
}
export interface HubAgentCredentials {
  projectId: string;
  projectIncarnation: string;
  connectionId: string;
  token: string;
}
export interface HubAuthorizedAgent extends HubParent { actor: HubActor; expiresAt: number }
type MessageRow = Record<string, SqlStorageValue> & {
  sequence: string; request_id: string; input_digest: string; kind: HubMessageKind; text: string; created_at: number; actor: string;
};
type ConnectionRow = Record<string, SqlStorageValue> & {
  id: string; principal_id: string; session_issued_at: number; label: string; token_hash: string;
  input_digest: string; created_at: number; expires_at: number; revoked_at: number | null;
};
const MESSAGE_COLUMNS = 'CAST(sequence AS TEXT) AS sequence, request_id, input_digest, kind, text, created_at, actor';
const encoder = new TextEncoder();
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const digest = (value: string) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validText = (value: unknown): value is string => typeof value === 'string' && new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(encoder.encode(value)) === value;

function object(value: unknown, keys: string[], required: string[], code: string): Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), code);
  const body = value as Record<string, unknown>;
  requireValue(Object.keys(body).every(key => keys.includes(key)) && required.every(key => Object.hasOwn(body, key)), code);
  return body;
}
function messageBody(value: unknown): { requestId: string; kind: HubMessageKind; text: string } {
  const body = object(value, ['requestId', 'kind', 'text'], ['requestId', 'kind', 'text'], 'HUB_MESSAGE_INVALID');
  requireValue(typeof body.requestId === 'string' && ID.test(body.requestId), 'HUB_MESSAGE_INVALID');
  requireValue(typeof body.kind === 'string' && (HUB_MESSAGE_KINDS as readonly string[]).includes(body.kind), 'HUB_MESSAGE_INVALID');
  requireValue(validText(body.text) && body.text.trim().length > 0, 'HUB_MESSAGE_INVALID');
  requireValue(encoder.encode(body.text).length <= HUB_LIMITS.messageBytes, 'HUB_MESSAGE_TOO_LARGE', 413);
  return { requestId: body.requestId, kind: body.kind as HubMessageKind, text: body.text };
}
function connectionBody(value: unknown): HubConnectionBody {
  const body = object(value, ['connectionId', 'label', 'tokenHash', 'expiresAt'], ['connectionId', 'label', 'tokenHash', 'expiresAt'], 'HUB_CONNECTION_INVALID');
  requireValue(typeof body.connectionId === 'string' && ID.test(body.connectionId), 'HUB_CONNECTION_INVALID');
  requireValue(validText(body.label) && body.label.trim().length > 0 && body.label.length <= 80 && !/[\u0000-\u001f\u007f]/.test(body.label), 'HUB_CONNECTION_INVALID');
  requireValue(typeof body.tokenHash === 'string' && /^sha256:[0-9a-f]{64}$/.test(body.tokenHash), 'HUB_CONNECTION_INVALID');
  requireValue(integer(body.expiresAt), 'HUB_CONNECTION_INVALID');
  return { connectionId: body.connectionId, label: body.label, tokenHash: body.tokenHash, expiresAt: body.expiresAt };
}
function cursor(value: unknown): string {
  requireValue(typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n, 'HUB_CURSOR_INVALID');
  return value;
}
function message(row: MessageRow): HubMessage {
  return { sequence: row.sequence, requestId: row.request_id, kind: row.kind, text: row.text, createdAt: row.created_at, actor: JSON.parse(row.actor) as HubActor };
}
function connection(row: ConnectionRow): HubConnection {
  return { connectionId: row.id, label: row.label, principalId: row.principal_id, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at, capabilities: [...HUB_AGENT_CAPABILITIES] };
}

/** The browser registers only this digest; a submitted raw token is never written to SQL or returned. */
export function agentTokenDigest(value: unknown): string {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value), 'HUB_AGENT_UNAUTHORIZED', 401);
  return digest(value);
}

/** Durable discussion and narrowly delegated capabilities. No method accepts release or publication authority. */
export class ProjectHubStore {
  constructor(
    private readonly storage: Pick<DurableObjectStorage, 'sql' | 'transactionSync'>,
    private readonly authorization: HubAuthorization,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) { this.storage.sql.exec(PROJECT_HUB_SCHEMA); }

  private row<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T | null {
    return this.storage.sql.exec<T>(query, ...bindings).toArray()[0] ?? null;
  }
  private bindScope(scope: Scope): void {
    const serialized = canonicalize(scope);
    const saved = this.row<{ payload: string }>('SELECT payload FROM hub_scope WHERE singleton=1');
    requireValue(!saved || saved.payload === serialized, 'HUB_SCOPE_MISMATCH', 409);
    if (!saved) this.storage.sql.exec('INSERT INTO hub_scope(singleton,payload) VALUES (1,?)', serialized);
  }
  private checkContext(context: HubMemberContext): void {
    requireValue(integer(context.sessionIssuedAt) && integer(context.sessionCutoff) && typeof context.canPost === 'boolean' && typeof context.canConnect === 'boolean', 'HUB_AUTH_CONFIGURATION', 503);
    requireValue(context.sessionIssuedAt > context.sessionCutoff, 'SESSION_REVOKED', 401);
  }
  private human(caller: TrustedCaller, operation: HubHumanOperation): HubMemberContext {
    requireValue(caller.principal.credentialClass === 'human', 'HUB_HUMAN_REQUIRED', 403);
    const context = this.authorization.authorizeHuman(caller, operation);
    this.checkContext(context);
    requireValue(context.principalId === caller.principal.id && context.scope.projectId === caller.projectId && context.scope.tenantId === caller.principal.tenantId, 'HUB_SCOPE_MISMATCH', 403);
    requireValue(operation !== 'post' || context.canPost, 'HUB_POST_FORBIDDEN', 403);
    requireValue(operation !== 'connect' || context.canConnect, 'HUB_CONNECTION_FORBIDDEN', 403);
    this.bindScope(context.scope);
    return context;
  }
  private page(scope: Scope, after: unknown): HubMessagePage {
    const afterCursor = cursor(after);
    const rows = this.storage.sql.exec<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM hub_messages WHERE hub_messages.sequence>CAST(? AS INTEGER) ORDER BY hub_messages.sequence ASC LIMIT ?`, afterCursor, HUB_LIMITS.pageMessages + 1).toArray();
    const messages: HubMessage[] = [];
    // Reserve the longest cursor and boolean representation. JSON escaping can
    // expand valid 8 KiB text sixfold, so a count limit alone is insufficient.
    let bytes = encoder.encode(JSON.stringify({ scope, messages: [], nextCursor: '9223372036854775807', hasMore: false })).length;
    for (const row of rows.slice(0, HUB_LIMITS.pageMessages)) {
      const next = message(row), size = encoder.encode(JSON.stringify(next)).length + (messages.length ? 1 : 0);
      if (bytes + size > HUB_LIMITS.pageBytes) {
        requireValue(messages.length > 0, 'HUB_STORAGE_UNAVAILABLE', 503);
        break;
      }
      messages.push(next); bytes += size;
    }
    return { scope, messages, nextCursor: messages.at(-1)?.sequence ?? afterCursor, hasMore: rows.length > messages.length };
  }
  private append(actor: HubActor, value: unknown): HubMessage {
    const body = messageBody(value);
    const actorKey = canonicalize({ principalId: actor.principalId, credentialClass: actor.credentialClass, connectionId: actor.connectionId ?? null });
    const inputDigest = digest(canonicalize({ kind: body.kind, text: body.text }));
    const existing = this.row<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM hub_messages WHERE actor_key=? AND request_id=?`, actorKey, body.requestId);
    if (existing) {
      requireValue(existing.input_digest === inputDigest, 'HUB_REQUEST_CONFLICT', 409);
      return message(existing);
    }
    const retained = this.row<{ count: number }>('SELECT COUNT(*) AS count FROM hub_messages');
    requireValue(retained && retained.count < HUB_LIMITS.totalMessages, 'HUB_MESSAGE_CAPACITY', 409);
    const saved = this.row<MessageRow>(`INSERT INTO hub_messages(actor_key,request_id,input_digest,kind,text,created_at,actor) VALUES (?,?,?,?,?,?,?) RETURNING ${MESSAGE_COLUMNS}`,
      actorKey, body.requestId, inputDigest, body.kind, body.text, this.now(), canonicalize(actor));
    requireValue(saved, 'HUB_STORAGE_UNAVAILABLE', 503);
    return message(saved);
  }

  messages(caller: TrustedCaller, after: unknown = '0'): HubMessagePage {
    return this.storage.transactionSync(() => this.page(this.human(caller, 'read').scope, after));
  }
  view(caller: TrustedCaller, after: unknown = '0'): HubView {
    return this.storage.transactionSync(() => {
      const context = this.human(caller, 'read');
      const connections = this.storage.sql.exec<ConnectionRow>(`SELECT * FROM hub_connections WHERE principal_id=?
        ORDER BY CASE WHEN revoked_at IS NULL AND expires_at>? AND session_issued_at>? THEN 0 ELSE 1 END,
        created_at DESC,id ASC LIMIT ?`, context.principalId, this.now(), context.sessionCutoff, HUB_LIMITS.pageConnections + 1).toArray();
      return { ...this.page(context.scope, after), session: { principalId: context.principalId, credentialClass: 'human' },
        capabilities: { post: context.canPost, connect: context.canConnect }, connections: connections.slice(0, HUB_LIMITS.pageConnections).map(connection),
        hasMoreConnections: connections.length > HUB_LIMITS.pageConnections, limits: HUB_LIMITS };
    });
  }
  postHuman(caller: TrustedCaller, body: unknown): HubMessage {
    return this.storage.transactionSync(() => {
      const context = this.human(caller, 'post');
      return this.append({ principalId: context.principalId, credentialClass: 'human' }, body);
    });
  }
  registerConnection(caller: TrustedCaller, value: unknown): HubConnection {
    return this.storage.transactionSync(() => {
      const context = this.human(caller, 'connect');
      const body = connectionBody(value);
      const inputDigest = digest(canonicalize(body));
      const existing = this.row<ConnectionRow>('SELECT * FROM hub_connections WHERE id=?', body.connectionId);
      if (existing) {
        requireValue(existing.principal_id === context.principalId && existing.input_digest === inputDigest, 'HUB_CONNECTION_CONFLICT', 409);
        return connection(existing);
      }
      const now = this.now();
      requireValue(body.expiresAt > now && body.expiresAt <= now + HUB_LIMITS.connectionLifetimeSeconds, 'HUB_CONNECTION_INVALID');
      requireValue(!this.row('SELECT id FROM hub_connections WHERE token_hash=?', body.tokenHash), 'HUB_TOKEN_ALREADY_REGISTERED', 409);
      const retained = this.row<{ total: number; active: number }>(`SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN principal_id=? AND revoked_at IS NULL AND expires_at>? AND session_issued_at>? THEN 1 ELSE 0 END),0) AS active
        FROM hub_connections`, context.principalId, now, context.sessionCutoff);
      requireValue(retained && retained.total < HUB_LIMITS.totalConnections && retained.active < HUB_LIMITS.activeConnectionsPerMember, 'HUB_CONNECTION_LIMIT', 409);
      const saved = this.row<ConnectionRow>('INSERT INTO hub_connections(id,principal_id,session_issued_at,label,token_hash,input_digest,created_at,expires_at,revoked_at) VALUES (?,?,?,?,?,?,?,?,NULL) RETURNING *',
        body.connectionId, context.principalId, context.sessionIssuedAt, body.label, body.tokenHash, inputDigest, now, body.expiresAt);
      requireValue(saved, 'HUB_STORAGE_UNAVAILABLE', 503);
      return connection(saved);
    });
  }
  revokeConnection(caller: TrustedCaller, connectionId: unknown): HubConnection {
    return this.storage.transactionSync(() => {
      // A member downgraded to read-only can still revoke their own earlier capability.
      const context = this.human(caller, 'read');
      requireValue(typeof connectionId === 'string' && ID.test(connectionId), 'HUB_CONNECTION_UNAVAILABLE', 404);
      const row = this.row<ConnectionRow>('SELECT * FROM hub_connections WHERE id=? AND principal_id=?', connectionId, context.principalId);
      requireValue(row, 'HUB_CONNECTION_UNAVAILABLE', 404);
      if (row.revoked_at === null) {
        row.revoked_at = this.now();
        this.storage.sql.exec('UPDATE hub_connections SET revoked_at=? WHERE id=?', row.revoked_at, row.id);
      }
      return connection(row);
    });
  }
  private agent(credentials: HubAgentCredentials, operation: HubAgentOperation): HubAuthorizedAgent {
    requireValue(['read', 'post', 'dependency'].includes(operation), 'HUB_AGENT_SCOPE_INVALID', 403);
    const tokenHash = agentTokenDigest(credentials.token);
    requireValue(typeof credentials.connectionId === 'string' && ID.test(credentials.connectionId), 'HUB_AGENT_UNAUTHORIZED', 401);
    const row = this.row<ConnectionRow>('SELECT * FROM hub_connections WHERE id=?', credentials.connectionId);
    requireValue(row && row.revoked_at === null && row.expires_at > this.now() && timingSafeEqual(encoder.encode(tokenHash), encoder.encode(row.token_hash)), 'HUB_AGENT_UNAUTHORIZED', 401);
    const stored = this.row<{ payload: string }>('SELECT payload FROM hub_scope WHERE singleton=1');
    requireValue(stored, 'HUB_AGENT_UNAUTHORIZED', 401);
    const scope = JSON.parse(stored.payload) as Scope;
    requireValue(scope.projectId === credentials.projectId && scope.projectIncarnation === credentials.projectIncarnation, 'HUB_AGENT_UNAUTHORIZED', 401);
    const parent = { scope, principalId: row.principal_id, sessionIssuedAt: row.session_issued_at };
    const context = this.authorization.authorizeMember(parent, operation);
    this.checkContext(context);
    requireValue(context.principalId === parent.principalId && context.sessionIssuedAt === parent.sessionIssuedAt && canonicalize(context.scope) === stored.payload, 'HUB_AGENT_UNAUTHORIZED', 401);
    requireValue(operation !== 'post' || context.canPost, 'HUB_POST_FORBIDDEN', 403);
    return { ...parent, expiresAt: row.expires_at, actor: { principalId: row.principal_id, credentialClass: 'agent', connectionId: row.id, label: row.label } };
  }
  authorizeAgent(credentials: HubAgentCredentials, operation: HubAgentOperation): HubAuthorizedAgent {
    return this.storage.transactionSync(() => this.agent(credentials, operation));
  }
  readAgent(credentials: HubAgentCredentials, after: unknown = '0'): HubMessagePage {
    return this.storage.transactionSync(() => this.page(this.agent(credentials, 'read').scope, after));
  }
  postAgent(credentials: HubAgentCredentials, body: unknown): HubMessage {
    return this.storage.transactionSync(() => this.append(this.agent(credentials, 'post').actor, body));
  }
}
