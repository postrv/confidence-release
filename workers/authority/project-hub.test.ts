// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { ProjectHubStore, agentTokenDigest, type HubMemberContext, type HubParent } from './project-hub';
import { PlatformError } from '../shared/errors';
import type { TrustedCaller } from './types';

const scope = { schemaVersion: 1 as const, tenantId: 'tenant', projectId: 'project', projectIncarnation: 'incarnation' };
const alice: TrustedCaller = { projectId: 'project', principal: { id: 'alice', tenantId: 'tenant', credentialClass: 'human' } };
const bob: TrustedCaller = { ...alice, principal: { ...alice.principal, id: 'bob' } };
const rejects = (action: () => unknown, code: string) => assert.throws(action, error => error instanceof PlatformError && error.code === code);

function fixture() {
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
  let now = 2000;
  let active = true;
  let canPost = true;
  let canConnect = true;
  let cutoff = 0;
  let humanIssuedAt = 1000;
  let currentScope = { ...scope };
  let authorizations = 0;
  const context = (principalId: string, sessionIssuedAt = humanIssuedAt): HubMemberContext => {
    authorizations++;
    if (!active) throw new PlatformError('MEMBERSHIP_REQUIRED', 403);
    return { scope: currentScope, principalId, sessionIssuedAt, sessionCutoff: cutoff, canPost, canConnect };
  };
  const authorization = {
    authorizeHuman(caller: TrustedCaller) { return context(caller.principal.id); },
    authorizeMember(parent: HubParent) { return context(parent.principalId, parent.sessionIssuedAt); },
  };
  const build = () => new ProjectHubStore(storage as unknown as ConstructorParameters<typeof ProjectHubStore>[0], authorization, () => now);
  const token = Buffer.from(randomBytes(32)).toString('base64url');
  const connection = { connectionId: 'conn-1', label: 'Local deterministic session', tokenHash: `sha256:${createHash('sha256').update(token).digest('hex')}`, expiresAt: 3000 };
  const credentials = { projectId: scope.projectId, projectIncarnation: scope.projectIncarnation, connectionId: connection.connectionId, token };
  return {
    db, hub: build(), build, connection, credentials,
    time: (value: number) => { now = value; },
    revokeMember: () => { active = false; },
    cutoff: (value: number) => { cutoff = value; },
    sessionIssuedAt: (value: number) => { humanIssuedAt = value; },
    permissions: (post: boolean, connect = post) => { canPost = post; canConnect = connect; },
    scope: (value: typeof scope) => { currentScope = value; },
    authorizationCount: () => authorizations,
  };
}

test('append-only messages have server sequence, timestamp and trusted actor; lost responses reconcile across restart', () => {
  const f = fixture();
  try {
    const body = { requestId: 'request-1', kind: 'instruction', text: 'Investigate the current revision.\nKeep the existing publication policy.' };
    const first = f.hub.postHuman(alice, body);
    assert.equal(first.sequence, '1');
    assert.equal(first.createdAt, 2000);
    assert.deepEqual(first.actor, { principalId: 'alice', credentialClass: 'human' });
    f.time(2100);
    assert.deepEqual(f.build().postHuman(alice, body), first);
    rejects(() => f.hub.postHuman(alice, { ...body, text: 'different' }), 'HUB_REQUEST_CONFLICT');
    assert.equal(f.hub.postHuman(bob, body).sequence, '2');
    assert.equal(f.hub.messages(alice).messages.length, 2);
  } finally { f.db.close(); }
});

test('message pagination is monotonic, bounded to 100 and retains earlier text', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 103; i++) f.hub.postHuman(alice, { requestId: `request-${i}`, kind: 'message', text: `Message ${i}` });
    const first = f.hub.messages(alice);
    assert.equal(first.messages.length, 100);
    assert.equal(first.nextCursor, '100');
    assert.equal(first.hasMore, true);
    const rest = f.hub.messages(alice, first.nextCursor);
    assert.deepEqual(rest.messages.map(message => message.sequence), ['101', '102', '103']);
    assert.equal(rest.hasMore, false);
    assert.equal(f.hub.messages(alice, '103').nextCursor, '103');
    for (const invalid of ['-1', '01', '1.0', '1e2', '9223372036854775808', 0, null]) rejects(() => f.hub.messages(alice, invalid), 'HUB_CURSOR_INVALID');
  } finally { f.db.close(); }
});

test('JSON expansion cannot make an accepted discussion page unreadable; byte-bounded cursors preserve every message', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 100; i++) f.hub.postHuman(alice, { requestId: `escaped-${i}`, kind: 'message', text: `${i % 2 ? '"' : '\u0001'}`.repeat(8191) + 'x' });
    f.hub.registerConnection(alice, f.connection);
    let cursor = '0', pages = 0;
    const seen: string[] = [];
    for (;;) {
      const page = f.hub.readAgent(f.credentials, cursor);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 900 * 1024, 'The complete page must fit the client response limit after JSON escaping.');
      assert.ok(page.messages.length > 0);
      assert.equal(page.nextCursor, page.messages.at(-1)!.sequence);
      assert.equal(page.hasMore, page.nextCursor !== '100');
      seen.push(...page.messages.map(message => message.sequence));
      cursor = page.nextCursor; pages++;
      if (!page.hasMore) break;
      assert.ok(pages < 100);
    }
    assert.ok(pages > 1);
    assert.deepEqual(seen, Array.from({ length: 100 }, (_, index) => String(index + 1)));
    assert.equal(f.hub.messages(alice, cursor).messages.length, 0);
  } finally { f.db.close(); }
});

test('message schema rejects actor injection and unsupported kinds, preserves bytes and enforces the UTF-8 byte limit', () => {
  const f = fixture();
  try {
    const body = { requestId: 'message', kind: 'result', text: 'x' };
    for (const changed of [{ actor: { principalId: 'bob' } }, { sequence: '42' }, { kind: 'approval' }, { text: '' }, { text: ' \n ' }, { text: '\ud800' }, { requestId: '../invalid' }]) {
      rejects(() => f.hub.postHuman(alice, { ...body, ...changed }), 'HUB_MESSAGE_INVALID');
    }
    const exact = 'é'.repeat(4096);
    assert.equal(f.hub.postHuman(alice, { ...body, text: exact }).text, exact);
    const marked = '\ufeffKeep this prefix.\r\n';
    assert.equal(f.hub.postHuman(alice, { ...body, requestId: 'marked-text', text: marked }).text, marked);
    rejects(() => f.hub.postHuman(alice, { ...body, requestId: 'large', text: `${exact}x` }), 'HUB_MESSAGE_TOO_LARGE');
    rejects(() => f.hub.postHuman(alice, { kind: 'question', text: 'What is the selected revision?' }), 'HUB_MESSAGE_INVALID');
  } finally { f.db.close(); }
});

test('every human operation checks current scope, membership, credential class and session cutoff', () => {
  const f = fixture();
  try {
    f.hub.postHuman(alice, { requestId: 'existing', kind: 'message', text: 'Existing' });
    rejects(() => f.hub.messages({ ...alice, projectId: 'other' }), 'HUB_SCOPE_MISMATCH');
    rejects(() => f.hub.messages({ ...alice, principal: { ...alice.principal, tenantId: 'other' } }), 'HUB_SCOPE_MISMATCH');
    rejects(() => f.hub.messages({ ...alice, principal: { ...alice.principal, credentialClass: 'agent' } }), 'HUB_HUMAN_REQUIRED');
    f.permissions(false);
    assert.equal(f.hub.view(alice).capabilities.post, false);
    rejects(() => f.hub.postHuman(alice, { requestId: 'existing', kind: 'message', text: 'Existing' }), 'HUB_POST_FORBIDDEN');
    rejects(() => f.hub.registerConnection(alice, f.connection), 'HUB_CONNECTION_FORBIDDEN');
    f.cutoff(1000);
    rejects(() => f.hub.messages(alice), 'SESSION_REVOKED');
    f.cutoff(0); f.revokeMember();
    rejects(() => f.hub.messages(alice), 'MEMBERSHIP_REQUIRED');
  } finally { f.db.close(); }
});

test('connection registration persists only hashes, retries idempotently and rejects conflicting identity or token reuse', () => {
  const f = fixture();
  try {
    const registered = f.hub.registerConnection(alice, f.connection);
    assert.deepEqual(f.hub.registerConnection(alice, { ...f.connection }), registered);
    assert.equal(registered.principalId, 'alice');
    assert.equal(JSON.stringify(registered).includes(f.credentials.token), false);
    assert.equal(JSON.stringify(registered).includes(f.connection.tokenHash), false);
    rejects(() => f.hub.registerConnection(alice, { ...f.connection, label: 'changed' }), 'HUB_CONNECTION_CONFLICT');
    rejects(() => f.hub.registerConnection(bob, f.connection), 'HUB_CONNECTION_CONFLICT');
    rejects(() => f.hub.registerConnection(alice, { ...f.connection, connectionId: 'other' }), 'HUB_TOKEN_ALREADY_REGISTERED');
    const saved = JSON.stringify(f.db.prepare('SELECT * FROM hub_connections').all());
    assert.equal(saved.includes(f.credentials.token), false);
    assert.equal(saved.includes(f.connection.tokenHash), true);
    assert.equal(f.hub.view(bob).connections.length, 0);
    assert.equal(f.hub.view(alice).connections.length, 1);
  } finally { f.db.close(); }
});

test('connection inputs cannot inject identity, exceed a day, or use malformed digests', () => {
  const f = fixture();
  try {
    for (const changed of [{ principalId: 'bob' }, { token: f.credentials.token }, { expiresAt: 2000 }, { expiresAt: 88401 }, { expiresAt: 3000.5 }, { label: '' }, { label: 'x'.repeat(81) }, { tokenHash: 'abc' }, { connectionId: '../bad' }]) {
      rejects(() => f.hub.registerConnection(alice, { ...f.connection, ...changed }), 'HUB_CONNECTION_INVALID');
    }
    assert.doesNotThrow(() => f.hub.registerConnection(alice, { ...f.connection, expiresAt: 88400 }));
  } finally { f.db.close(); }
});

test('each member has at most 32 active connections; retries preserve identity and permission changes remain effective', () => {
  const f = fixture();
  const input = (id: string) => ({ ...f.connection, connectionId: id, tokenHash: `sha256:${createHash('sha256').update(`synthetic-${id}`).digest('hex')}` });
  try {
    const first = f.hub.registerConnection(alice, f.connection);
    for (let i = 0; i < 31; i++) f.hub.registerConnection(alice, input(`active-${i}`));
    assert.deepEqual(f.build().registerConnection(alice, f.connection), first);
    rejects(() => f.hub.registerConnection(alice, input('over-active-limit')), 'HUB_CONNECTION_LIMIT');
    assert.doesNotThrow(() => f.hub.registerConnection(bob, input('other-member')));
    f.hub.revokeConnection(alice, 'active-0');
    assert.doesNotThrow(() => f.hub.registerConnection(alice, input('replacement')));
    f.permissions(false);
    rejects(() => f.hub.registerConnection(alice, f.connection), 'HUB_CONNECTION_FORBIDDEN');
  } finally { f.db.close(); }
});

test('expired and session-revoked connections do not consume a fresh member active allowance', () => {
  const f = fixture();
  const input = (id: string, expiresAt: number) => ({ ...f.connection, connectionId: id, expiresAt, tokenHash: `sha256:${createHash('sha256').update(`synthetic-${id}`).digest('hex')}` });
  try {
    for (let i = 0; i < 32; i++) f.hub.registerConnection(alice, input(`expired-${i}`, 2001));
    f.time(2001);
    for (let i = 0; i < 32; i++) f.hub.registerConnection(alice, input(`old-session-${i}`, 3000));
    rejects(() => f.hub.registerConnection(alice, input('over-limit', 3000)), 'HUB_CONNECTION_LIMIT');
    f.time(2002); f.cutoff(1000); f.sessionIssuedAt(2002);
    assert.doesNotThrow(() => f.hub.registerConnection(alice, input('new-session', 3000)));
  } finally { f.db.close(); }
});

test('the project retains at most 1000 connection identities even after expiry or revocation; existing retries remain available', () => {
  const f = fixture();
  try {
    const first = f.hub.registerConnection(alice, f.connection);
    f.db.exec(`WITH RECURSIVE numbers(n) AS (VALUES(2) UNION ALL SELECT n+1 FROM numbers WHERE n<1000)
      INSERT INTO hub_connections(id,principal_id,session_issued_at,label,token_hash,input_digest,created_at,expires_at,revoked_at)
      SELECT 'synthetic-'||n,'fixture',1000,'Retained fixture','synthetic-hash-'||n,'synthetic-input',1500,1600,1550 FROM numbers`);
    assert.deepEqual(f.hub.registerConnection(alice, f.connection), first);
    const next = { ...f.connection, connectionId: 'over-retained-limit', tokenHash: `sha256:${'0'.repeat(64)}` };
    rejects(() => f.hub.registerConnection(alice, next), 'HUB_CONNECTION_LIMIT');
    f.hub.revokeConnection(alice, f.connection.connectionId);
    rejects(() => f.hub.registerConnection(alice, next), 'HUB_CONNECTION_LIMIT');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM hub_connections').get()!.count, 1000);
  } finally { f.db.close(); }
});

test('older active connections remain visible for revocation ahead of newer inactive history', () => {
  const f = fixture();
  try {
    f.hub.registerConnection(alice, f.connection);
    f.time(2100);
    for (let i = 0; i < 100; i++) {
      const connectionId = `historical-${i}`;
      f.hub.registerConnection(alice, { ...f.connection, connectionId, tokenHash: `sha256:${createHash('sha256').update(`synthetic-${i}`).digest('hex')}` });
      f.hub.revokeConnection(alice, connectionId);
    }
    const view = f.hub.view(alice);
    assert.equal(view.connections.length, 100);
    assert.equal(view.hasMoreConnections, true);
    assert.equal(view.connections[0]!.connectionId, f.connection.connectionId);
  } finally { f.db.close(); }
});

test('agent credential has an independent actor and checks current parent membership on every operation', () => {
  const f = fixture();
  try {
    f.hub.registerConnection(alice, f.connection);
    const body = { requestId: 'result-1', kind: 'result', text: 'Deterministic fixture completed.' };
    const first = f.hub.postAgent(f.credentials, body);
    assert.deepEqual(first.actor, { principalId: 'alice', credentialClass: 'agent', connectionId: 'conn-1', label: f.connection.label });
    assert.deepEqual(f.build().postAgent(f.credentials, body), first);
    const before = f.authorizationCount();
    assert.equal(f.hub.readAgent(f.credentials).messages.length, 1);
    assert.equal(f.hub.authorizeAgent(f.credentials, 'dependency').scope.projectId, 'project');
    assert.equal(f.authorizationCount(), before + 2);
    f.permissions(false);
    assert.equal(f.hub.readAgent(f.credentials).messages.length, 1);
    rejects(() => f.hub.postAgent(f.credentials, body), 'HUB_POST_FORBIDDEN');
    f.revokeMember();
    rejects(() => f.hub.readAgent(f.credentials), 'MEMBERSHIP_REQUIRED');
    rejects(() => f.hub.authorizeAgent(f.credentials, 'dependency'), 'MEMBERSHIP_REQUIRED');
  } finally { f.db.close(); }
});

test('agent token, exact project and incarnation are required and unsupported authority operations are rejected', () => {
  const f = fixture();
  try {
    f.hub.registerConnection(alice, f.connection);
    for (const changes of [{ token: Buffer.from(randomBytes(32)).toString('base64url') }, { token: 'bad' }, { connectionId: 'unknown' }, { projectId: 'other' }, { projectIncarnation: 'other' }]) {
      rejects(() => f.hub.readAgent({ ...f.credentials, ...changes }), 'HUB_AGENT_UNAUTHORIZED');
    }
    for (const operation of ['approve', 'publish', 'connect', 'release', 'write-replica']) rejects(() => f.hub.authorizeAgent(f.credentials, operation as 'read'), 'HUB_AGENT_SCOPE_INVALID');
  } finally { f.db.close(); }
});

test('connection revocation and session cutoff deny agent retries and dependency reads, including after restart', () => {
  const f = fixture();
  try {
    f.hub.registerConnection(alice, f.connection);
    const body = { requestId: 'once', kind: 'message', text: 'One message' };
    f.hub.postAgent(f.credentials, body);
    rejects(() => f.hub.revokeConnection(bob, 'conn-1'), 'HUB_CONNECTION_UNAVAILABLE');
    f.cutoff(1000);
    rejects(() => f.hub.readAgent(f.credentials), 'SESSION_REVOKED');
    f.cutoff(0);
    const revoked = f.hub.revokeConnection(alice, 'conn-1');
    assert.equal(revoked.revokedAt, 2000);
    assert.deepEqual(f.hub.revokeConnection(alice, 'conn-1'), revoked);
    assert.equal(f.hub.registerConnection(alice, f.connection).revokedAt, 2000);
    rejects(() => f.build().postAgent(f.credentials, body), 'HUB_AGENT_UNAUTHORIZED');
    rejects(() => f.hub.authorizeAgent(f.credentials, 'dependency'), 'HUB_AGENT_UNAUTHORIZED');
    assert.equal(f.hub.messages(alice).messages.length, 1);
  } finally { f.db.close(); }
});

test('connection expiration is enforced independently of current parent membership', () => {
  const f = fixture();
  try {
    f.hub.registerConnection(alice, f.connection);
    f.time(2999); assert.doesNotThrow(() => f.hub.readAgent(f.credentials));
    f.time(3000); rejects(() => f.hub.readAgent(f.credentials), 'HUB_AGENT_UNAUTHORIZED');
  } finally { f.db.close(); }
});

test('changing incarnation cannot expose or append to another incarnation thread', () => {
  const f = fixture();
  try {
    f.hub.postHuman(alice, { requestId: 'original', kind: 'message', text: 'Original incarnation' });
    f.scope({ ...scope, projectIncarnation: 'replacement' });
    rejects(() => f.hub.messages(alice), 'HUB_SCOPE_MISMATCH');
    rejects(() => f.hub.postHuman(alice, { requestId: 'replacement', kind: 'message', text: 'Replacement incarnation' }), 'HUB_SCOPE_MISMATCH');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM hub_messages').get()!.count, 1);
  } finally { f.db.close(); }
});

test('token digest uses the canonical random-token text and rejects noncanonical encodings', () => {
  const token = Buffer.from(randomBytes(32)).toString('base64url');
  assert.equal(agentTokenDigest(token), `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`);
  for (const invalid of ['', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}B`, `${token}=`, null, 1]) rejects(() => agentTokenDigest(invalid), 'HUB_AGENT_UNAUTHORIZED');
});

test('durable message capacity refuses new posts while preserving exact idempotent outcomes and all retained messages', () => {
  const f = fixture();
  try {
    const body = { requestId: 'first', kind: 'message', text: 'Retain this outcome.' };
    const first = f.hub.postHuman(alice, body);
    f.db.exec(`WITH RECURSIVE numbers(n) AS (VALUES(2) UNION ALL SELECT n+1 FROM numbers WHERE n<10000)
      INSERT INTO hub_messages(actor_key,request_id,input_digest,kind,text,created_at,actor)
      SELECT 'synthetic-capacity-fixture',CAST(n AS TEXT),'fixture','message','Retained fixture',2000,'{"principalId":"fixture","credentialClass":"human"}' FROM numbers`);
    assert.deepEqual(f.hub.postHuman(alice, body), first);
    rejects(() => f.hub.postHuman(alice, { ...body, requestId: 'over-capacity' }), 'HUB_MESSAGE_CAPACITY');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM hub_messages').get()!.count, 10000);
    assert.equal(f.hub.messages(alice, '9999').messages[0]!.sequence, '10000');
  } finally { f.db.close(); }
});
