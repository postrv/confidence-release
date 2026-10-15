// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeKernel } from '../packages/protocol/src/node';
import { canonicalize, encodeBase64, sha256 } from '../packages/protocol/src/index';
import { testKey } from '../tests/conformance/vector';
import { captureAuthorityRecovery, restoreAuthorityRecovery, RECOVERY_SCHEMA, RECOVERY_MARKER,
  RECOVERY_LIMITS,
  type AuthorityRecoveryBackup, type AuthorityRecoveryCommitment, type OwnedRecoveryStores, type RecoverySql, type SignerCommitment } from './authority-recovery';

await initializeKernel();
const enc = (value: unknown) => new TextEncoder().encode(canonicalize(value));
const hash = (value: unknown) => sha256(enc(value));
const scope = { schemaVersion: 1 as const, tenantId: 'recovery-owned-tenant', projectId: 'recovery-owned-project', projectIncarnation: 'recovery-owned-incarnation' };
const pairs = { authority: await testKey('01'), checker: await testKey('02'), root: await testKey('03') };
const signers: SignerCommitment[] = await Promise.all((['authority', 'checker', 'root'] as const).map(async role => ({ role, keyId: role + '-1', publicKeyBase64: encodeBase64(new Uint8Array(await crypto.subtle.exportKey('raw', pairs[role].publicKey))) })));
const trust = { schemaVersion: 1, scope, keysetRevision: '1', keys: signers.map(x => ({ id: x.keyId, roles: [x.role], publicKeyBase64: x.publicKeyBase64 })) };

function owned() {
  const db = new DatabaseSync(':memory:'); db.exec(RECOVERY_SCHEMA);
  const sql: RecoverySql = {
    all: (query, ...bindings) => db.prepare(query).all(...bindings.map(x => x instanceof ArrayBuffer ? new Uint8Array(x) : x)) as never,
    exec: (query, ...bindings) => { db.prepare(query).run(...bindings.map(x => x instanceof ArrayBuffer ? new Uint8Array(x) : x)); },
    transaction(body) { db.exec('BEGIN IMMEDIATE'); try { const value = body(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } },
  };
  const kv = new Map<string, any>(), objects = new Map<string, Uint8Array>(); let fenced = true, puts = 0, failPut = false, alarm: number | null = null;
  const stores: OwnedRecoveryStores = { sql, alarm: { read: async () => alarm }, kv: { entries: async () => [...kv.entries()], put: async (key, value) => { kv.set(key, structuredClone(value)); } },
    objects: { inventory: async () => ({ complete: true, entries: [...objects].map(([key, bytes]) => ({ key, bytes: bytes.slice() })) }),
      putNew: async (key, bytes) => { assert.equal(objects.has(key), false); puts++; if (failPut) throw Error('OWNED_OBJECT_WRITE_LOST'); objects.set(key, bytes.slice()); } },
    keys: { commitments: async () => structuredClone(signers), sign: async (role, challenge) => new Uint8Array(await crypto.subtle.sign('Ed25519', pairs[role].privateKey, challenge.slice().buffer)) },
    fence: { assertHeld() { if (!fenced) throw Error('OWNED_EXTERNAL_FENCE_REQUIRED'); } },
  };
  const addObject = async (value: unknown) => { const bytes = enc(value), digest = await sha256(bytes); objects.set('objects/sha256/' + digest.slice(7), bytes); return digest; };
  return { db, sql, kv, objects, stores, addObject, close: () => db.close(), setFence: (value: boolean) => { fenced = value; }, setAlarm: (value: number | null) => { alarm = value; }, failObjectPut: () => { failPut = true; }, puts: () => puts };
}
async function populated() {
  const f = owned(), objectDigest = await f.addObject({ owned: 'source bytes' }), manifest = { entries: [{ path: 'cache.mjs', mode: '100644', digest: objectDigest }] };
  const manifestDigest = await f.addObject(manifest), objectsDigest = await f.addObject([{ owned: 'complete Git object closure' }]);
  const requestObjectDigest = await f.addObject({ model: 'owned-no-provider-call', messages: [] });
  const observationDigest = await f.addObject({ owned: 'dispatch observation', requestDigest: requestObjectDigest });
  const witness = { owned: 'immutable admission witness' }, witnessDigest = await f.addObject(witness);
  const descriptor = { operationId: 'unknown-publication', oldHead: 'a'.repeat(40), newHead: 'b'.repeat(40), witnessDigest }, preparedBytes = enc(descriptor), preparedDigest = await sha256(preparedBytes);
  f.objects.set('journal/' + scope.projectIncarnation + '/unknown-publication/prepared', preparedBytes);
  const project = { scope, revision: '17', keysetRevision: '1', gate: 'OPEN', head: 'a'.repeat(40), unresolvedPublicationId: 'unknown-publication', reservedBudget: '100000', settledBudget: '7' };
  f.sql.exec('INSERT INTO project VALUES(1,?,?)', project.revision, canonicalize(project));
  const record = async (kind: string, id: string, payload: unknown) => f.sql.exec('INSERT INTO records VALUES(?,?,?,?)', kind, id, await hash(payload), canonicalize(payload));
  await record('trust', '1', trust); await record('source', 'a'.repeat(40), { manifest, manifestDigest, objectsDigest });
  await record('attempt', 'owned-attempt', { id: 'owned-attempt', generation: '1', grantId: 'owned-grant', state: 'STOPPED' });
  f.sql.exec('INSERT INTO memberships VALUES(?,?,1)', 'owned-human', '["admin","reviewer"]');
  f.sql.exec('INSERT INTO verified_identities VALUES(?,?,?,?,?,?,?)', 'owned-human', 'https://identity.recovery.invalid', 'owned-human', scope.tenantId, 'human', 1, 15);
  f.sql.exec('INSERT INTO collaborators VALUES(?,?,1)', 'owned-human', 'owner');
  f.sql.exec('INSERT INTO collaboration_config VALUES(1,?)', canonicalize({ scope }));
  f.sql.exec('INSERT INTO invitations VALUES(?,?,?,?,?,?,?,?,?)', 'owned-invitation', 'sha256:' + '3'.repeat(64), 'owned-guest', 'owned-human', 'viewer', 20, 'PENDING', 1, '{}');
  f.sql.exec('INSERT INTO invitation_acceptance_limits VALUES(?,?,?)', 'owned-guest', 1, 3);
  f.sql.exec('INSERT INTO commands VALUES(?,?,?,?,?,?)', 'owned-human', 'fixed-retry', 'sha256:' + '4'.repeat(64), 'request-publication', 'COMMITTED', '{"id":"unknown-publication"}');
  f.sql.exec('INSERT INTO commands VALUES(?,?,?,?,?,?)', 'owned-human', 'fixed-rejection', 'sha256:' + '5'.repeat(64), 'create-attempt', 'REJECTED', '{"code":"STALE_STATE"}');
  f.sql.exec('INSERT INTO grants VALUES(?,?,?,?,?,?,?)', 'owned-grant', 'owned-agent', 'owned-attempt', '1', 1, 1, '{"revoked":true}');
  f.sql.exec('INSERT INTO reservations VALUES(?,?,?,?,?,?)', 'owned-attempt', 'owned-attempt', '400000', 'RESERVED', null, '{}');
  f.sql.exec('INSERT INTO reservations VALUES(?,?,?,?,?,?)', '00000000-0000-4000-8000-000000000001', 'owned-attempt', '100000', 'DISPATCHED', null, canonicalize({ requestDigest: requestObjectDigest, callId: '00000000-0000-4000-8000-000000000001' }));
  f.sql.exec('INSERT INTO model_calls VALUES(?,?)', '00000000-0000-4000-8000-000000000001', 1000);
  f.sql.exec('INSERT INTO model_call_facts VALUES(?,?,?,?,?)', '00000000-0000-4000-8000-000000000001', 'DISPATCH', observationDigest, canonicalize({ requestObjectDigest, responseDigest: null }), 1001);
  f.sql.exec('INSERT INTO approvals VALUES(?,?,?,?)', 'sha256:' + '6'.repeat(64), 'owned-human', 1, 'unknown-publication');
  f.sql.exec('INSERT INTO evidence VALUES(?,?,?,?)', 'owned-job', 'sha256:' + '7'.repeat(64), 'PASS', canonicalize({ observationDigest: objectDigest }));
  const publication = { id: 'unknown-publication', phase: 'UNCERTAIN', dispatchMayHaveOccurred: true, dispatchAttemptIds: ['fixed-dispatch-id'], preparedDescriptor: descriptor, preparedDigest, witnessDigest, witness };
  f.sql.exec('INSERT INTO publications VALUES(?,?,?,?,?,?,?,?)', publication.id, 'refs/heads/main', '1', 1, publication.phase, descriptor.oldHead, descriptor.newHead, canonicalize(publication));
  f.sql.exec('INSERT INTO receipts VALUES(?,?,?,?,?)', '0', 'sha256:' + '8'.repeat(64), 'historical-publication', 'sha256:' + '9'.repeat(64), '{"owned":"historical signed bytes"}');
  f.sql.exec('INSERT INTO events(sequence,id,digest,payload) VALUES(?,?,?,?)', 4, 'fixed-event-id', 'sha256:' + 'a'.repeat(64), '{"owned":"event"}');
  f.sql.exec('UPDATE sqlite_sequence SET seq=99 WHERE name=?', 'events');
  f.sql.exec('INSERT INTO outbox VALUES(?,?,?,?,?,?,?)', 'unknown-publication', 'publish', 'sha256:' + 'b'.repeat(64), '{"publicationId":"unknown-publication"}', 'PENDING', 7, null);
  f.sql.exec('INSERT INTO projection_replays VALUES(?,?,?)', 'frozen-replay', 'owned-human', '{"throughSequence":4,"nextSequence":2}');
  f.sql.exec('INSERT INTO pins VALUES(?,?)', 'unknown-publication', objectDigest);
  f.sql.exec('INSERT INTO cleanups VALUES(?,?,?,?,?)', 'cleanup-fixed', 'owned-attempt', '1', 'RECOVERY_HOLD', '{"reason":"UNKNOWN_DELETE"}');
  f.sql.exec('INSERT INTO cleanup_archives VALUES(?,?)', 'cleanup-fixed', '{"after":2,"version":2}');
  f.sql.exec('INSERT INTO project_metadata VALUES(1,?)', '{"owned":"catalog metadata"}');
  f.sql.exec('INSERT INTO metadata_commands VALUES(?,?,?,?,?)', 'owned-human', 'metadata-pending', 'sha256:' + 'c'.repeat(64), 'PENDING', new Uint8Array([0, 255]));
  f.sql.exec('INSERT INTO metadata_events VALUES(?,?,?,?,?,?)', 3, 'owned-human', 'metadata-fixed', 'rename', '{}', '2026-10-15T00:00:00Z');
  f.sql.exec('UPDATE sqlite_sequence SET seq=55 WHERE name=?', 'metadata_events');
  f.sql.exec('INSERT INTO project_join_requests VALUES(?,?,?,?,?,?,?)', 'join-fixed', 'owned-guest', 'join-request', canonicalize(scope), 1, 1, 'PENDING');
  f.sql.exec('INSERT INTO join_request_display VALUES(?,?)', 'join-fixed', 'owned@example.invalid');
  f.sql.exec('INSERT INTO hub_scope VALUES(1,?)', canonicalize(scope));
  f.sql.exec('INSERT INTO hub_messages VALUES(?,?,?,?,?,?,?,?)', 2, 'owned-actor', 'message-fixed', 'sha256:' + 'd'.repeat(64), 'discussion', 'Owned retained message', 1, '{}');
  f.sql.exec('UPDATE sqlite_sequence SET seq=77 WHERE name=?', 'hub_messages');
  f.sql.exec('INSERT INTO hub_connections VALUES(?,?,?,?,?,?,?,?,?)', 'owned-connection', 'owned-human', 1, 'owned revoked credential', 'sha256:' + 'e'.repeat(64), 'sha256:' + 'f'.repeat(64), 1, 10, 2);
  f.setAlarm(1700000000000);
  f.kv.set('owned-runtime-cursor', { after: 17, unknownModelCall: '00000000-0000-4000-8000-000000000001' });
  return f;
}
async function recommit(backup: AuthorityRecoveryBackup, expected: AuthorityRecoveryCommitment) {
  backup.digest = await hash(backup.body); return { ...expected, digest: backup.digest };
}
const unchangedEmpty = (f: ReturnType<typeof owned>) => { assert.equal(f.sql.all('SELECT * FROM project').length, 0); assert.equal(f.kv.size, 0); assert.equal(f.objects.size, 0); };

test('complete real SQLite schema/rowids/autoincrement, replay fences, unknown effects, KV and object/key commitments survive a fenced logical restore', async () => {
  const source = await populated(), target = owned(); try {
    const { backup, commitment } = await captureAuthorityRecovery(source.stores);
    assert.equal(backup.body.tables.every(x => x.rows.length > 0), true, 'fixture covers every current application table');
    const result = await restoreAuthorityRecovery(target.stores, backup, commitment); assert.equal(result.state, 'RESTORED_FENCED'); assert.equal(backup.body.alarm, 1700000000000); assert.equal(await target.stores.alarm.read(), null, 'restore never blindly arms the old wakeup');
    for (const table of backup.body.tables) {
      const original = source.sql.all('SELECT rowid AS owned_rowid,* FROM "' + table.name + '" ORDER BY rowid');
      assert.deepEqual(target.sql.all('SELECT rowid AS owned_rowid,* FROM "' + table.name + '" ORDER BY rowid'), original, table.name);
    }
    assert.deepEqual(target.objects, source.objects); assert.deepEqual(target.kv.get('owned-runtime-cursor'), source.kv.get('owned-runtime-cursor'));
    assert.equal((target.kv.get(RECOVERY_MARKER) as any).state, 'RESTORED_FENCED');
    target.sql.exec("INSERT INTO events(id,digest,payload) VALUES('new-after-restore','owned','{}')"); assert.equal(target.sql.all("SELECT sequence FROM events WHERE id='new-after-restore'")[0]!.sequence, 100);
    target.sql.exec("INSERT INTO metadata_events(actor,command_id,operation,payload,time) VALUES('owned','new','rename','{}','owned')"); assert.equal(target.sql.all("SELECT sequence FROM metadata_events WHERE command_id='new'")[0]!.sequence, 56);
    target.sql.exec("INSERT INTO hub_messages(actor_key,request_id,input_digest,kind,text,created_at,actor) VALUES('owned','new','owned','discussion','owned',1,'{}')"); assert.equal(target.sql.all("SELECT sequence FROM hub_messages WHERE request_id='new'")[0]!.sequence, 78);
    assert.equal(target.sql.all('SELECT state,settled FROM reservations WHERE id=?', '00000000-0000-4000-8000-000000000001')[0]!.state, 'DISPATCHED');
    assert.equal(target.sql.all('SELECT consumed_by FROM approvals')[0]!.consumed_by, 'unknown-publication');
    assert.doesNotMatch(JSON.stringify(backup), /PRIVATE KEY|privateKey|SIGNING_KEY|pkcs8/);
  } finally { source.close(); target.close(); }
});

test('independent commitment rejects changed SQL or omitted object bytes before any target write', async () => {
  const source = await populated(); try { const captured = await captureAuthorityRecovery(source.stores);
    for (const mutate of [(b: AuthorityRecoveryBackup) => { b.body.tables.find(x => x.name === 'commands')!.rows[0]!.cells[2] = 'changed'; }, (b: AuthorityRecoveryBackup) => { b.body.objects.pop(); }]) {
      const target = owned(); try { const backup = structuredClone(captured.backup); mutate(backup); await assert.rejects(restoreAuthorityRecovery(target.stores, backup, captured.commitment), /RECOVERY_COMMITMENT_MISMATCH/); unchangedEmpty(target); } finally { target.close(); }
    }
  } finally { source.close(); }
});

test('a recomputed self-digest cannot authorize missing tables, changed schema, unknown versions, missing referenced objects or journals', async () => {
  const source = await populated(); try { const captured = await captureAuthorityRecovery(source.stores);
    const cases: [RegExp, (b: AuthorityRecoveryBackup) => void][] = [
      [/RECOVERY_TABLE_INVENTORY/, b => { b.body.tables.pop(); }],
      [/RECOVERY_SEQUENCE/, b => { b.body.sequences = b.body.sequences.filter(x => x.name !== 'hub_messages'); }], [/RECOVERY_SCHEMA_INCOMPATIBLE/, b => { b.body.schemaSourceDigest = 'sha256:' + 'f'.repeat(64); }],
      [/RECOVERY_VERSION/, b => { (b.body as any).schemaVersion = 2; }], [/RECOVERY_REFERENCED_OBJECT_MISSING/, b => { b.body.objects = b.body.objects.filter(x => !x.key.startsWith('objects/')); }],
      [/RECOVERY_PUBLICATION_JOURNAL_MISSING/, b => { b.body.objects = b.body.objects.filter(x => !x.key.startsWith('journal/')); }],
    ];
    for (const [reason, mutate] of cases) { const target = owned(); try { const backup = structuredClone(captured.backup); mutate(backup); const expected = await recommit(backup, captured.commitment); await assert.rejects(restoreAuthorityRecovery(target.stores, backup, expected), reason); unchangedEmpty(target); } finally { target.close(); } }
  } finally { source.close(); }
});

test('missing keys and a false public-key claim fail a private-key possession challenge without exporting keys or writing target data', async () => {
  const source = await populated(); try { const { backup, commitment } = await captureAuthorityRecovery(source.stores);
    for (const wrong of ['missing', 'mismatched']) { const target = owned(); try {
      if (wrong === 'missing') target.stores.keys.commitments = async () => signers.slice(1);
      else target.stores.keys.sign = async (_role, challenge) => new Uint8Array(await crypto.subtle.sign('Ed25519', pairs.checker.privateKey, challenge.slice().buffer));
      await assert.rejects(restoreAuthorityRecovery(target.stores, backup, commitment), /RECOVERY_SIGNER_(INVENTORY|POSSESSION)/); unchangedEmpty(target);
    } finally { target.close(); } }
  } finally { source.close(); }
});

test('nonempty SQL, KV and object targets are refused; a restored target is never implicitly overwritten or retried', async () => {
  const source = await populated(); try { const { backup, commitment } = await captureAuthorityRecovery(source.stores);
    for (const kind of ['sql', 'kv', 'object', 'restored']) { const target = owned(); try {
      if (kind === 'sql') target.sql.exec("INSERT INTO memberships VALUES('existing','[]',1)");
      if (kind === 'kv') target.kv.set('existing', 'owned');
      if (kind === 'object') await target.addObject({ existing: 'owned' });
      if (kind === 'restored') await restoreAuthorityRecovery(target.stores, backup, commitment);
      const before = target.db.prepare('SELECT COUNT(*) AS count FROM commands').get()!.count;
      await assert.rejects(restoreAuthorityRecovery(target.stores, backup, commitment), /RECOVERY_(TARGET_NOT_EMPTY|KV_INVENTORY)/);
      assert.equal(target.db.prepare('SELECT COUNT(*) AS count FROM commands').get()!.count, before);
    } finally { target.close(); } }
  } finally { source.close(); }
});

test('incompatible actual target schema, lost external fence and a changing capture fail closed', async () => {
  const source = await populated(); try { const { backup, commitment } = await captureAuthorityRecovery(source.stores);
    const target = owned(); try { target.sql.exec('CREATE TABLE __cf_user_data(id TEXT)'); await assert.rejects(restoreAuthorityRecovery(target.stores, backup, commitment), /RECOVERY_SCHEMA_INCOMPATIBLE/); assert.equal(target.kv.size, 0); } finally { target.close(); }
    source.setFence(false); await assert.rejects(captureAuthorityRecovery(source.stores), /OWNED_EXTERNAL_FENCE_REQUIRED/); source.setFence(true);
    const inventory = source.stores.objects.inventory; let calls = 0; source.stores.objects.inventory = async () => { if (++calls === 2) await source.addObject({ arrived: 'after snapshot' }); return inventory(); };
    await assert.rejects(captureAuthorityRecovery(source.stores), /RECOVERY_CAPTURE_CHANGED/);
  } finally { source.close(); }
});

test('a failed object write retains an explicit UNKNOWN marker, leaves SQL empty and refuses automatic reuse of that target', async () => {
  const source = await populated(), target = owned(); try { const { backup, commitment } = await captureAuthorityRecovery(source.stores); target.failObjectPut();
    await assert.rejects(restoreAuthorityRecovery(target.stores, backup, commitment), /OWNED_OBJECT_WRITE_LOST/);
    assert.equal(target.sql.all('SELECT * FROM project').length, 0); assert.equal((target.kv.get(RECOVERY_MARKER) as any).state, 'STARTED_UNKNOWN');
    await assert.rejects(restoreAuthorityRecovery(target.stores, backup, commitment), /RECOVERY_KV_INVENTORY/); assert.equal(target.puts(), 1);
  } finally { source.close(); target.close(); }
});

test('silent KV drops, lost final marker writes and fence loss at the final await remain UNKNOWN and nonreusable', async () => {
  const source = await populated(); try { const { backup, commitment } = await captureAuthorityRecovery(source.stores);
    for (const fault of ['source-kv-drop', 'final-marker-drop', 'final-fence-loss']) {
      const target = owned(); try {
        const put = target.stores.kv.put; target.stores.kv.put = async (key, value) => {
          if (fault === 'source-kv-drop' && key === 'owned-runtime-cursor') return;
          if (fault === 'final-marker-drop' && key === RECOVERY_MARKER && (value as any).state === 'RESTORED_FENCED') return;
          await put(key, value);
          if (fault === 'final-fence-loss' && key === RECOVERY_MARKER && (value as any).state === 'RESTORED_FENCED') target.setFence(false);
        };
        await assert.rejects(restoreAuthorityRecovery(target.stores, backup, commitment), /RECOVERY_KV_READBACK|OWNED_EXTERNAL_FENCE_REQUIRED/);
        assert.equal((target.kv.get(RECOVERY_MARKER) as any).state, 'STARTED_UNKNOWN'); target.setFence(true);
        await assert.rejects(restoreAuthorityRecovery(target.stores, backup, commitment), /RECOVERY_TARGET_NOT_EMPTY/);
      } finally { target.close(); }
    }
  } finally { source.close(); }
});

test('capture and restore apply the same encoded-wrapper limit at its exact boundary', async () => {
  const source = await populated(), target = owned(); try {
    const initial = await captureAuthorityRecovery(source.stores), body = structuredClone(initial.backup.body);
    body.kv.push(['padding', '']); body.kv.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const overhead = enc({ body, digest: 'sha256:' + '0'.repeat(64) }).length;
    source.kv.set('padding', 'x'.repeat(RECOVERY_LIMITS.encodedBytes - overhead));
    const captured = await captureAuthorityRecovery(source.stores); assert.equal(enc(captured.backup).length, RECOVERY_LIMITS.encodedBytes);
    await restoreAuthorityRecovery(target.stores, captured.backup, captured.commitment);
    source.kv.set('padding', source.kv.get('padding') + 'x'); await assert.rejects(captureAuthorityRecovery(source.stores), /RECOVERY_BACKUP_LIMIT/);
  } finally { source.close(); target.close(); }
});

test('fresh unpredictable key challenges reject signatures replayed from an earlier capture', async () => {
  const source = await populated(), target = owned(); try {
    const signatures = new Map<string, Uint8Array>(), sign = source.stores.keys.sign;
    source.stores.keys.sign = async (role, challenge) => { const signature = await sign(role, challenge); signatures.set(role, signature); return signature; };
    const { backup, commitment } = await captureAuthorityRecovery(source.stores);
    target.stores.keys.sign = async role => signatures.get(role)!;
    await assert.rejects(restoreAuthorityRecovery(target.stores, backup, commitment), /RECOVERY_SIGNER_POSSESSION/); unchangedEmpty(target);
    assert.doesNotMatch(JSON.stringify(backup), /nonce|challenge|signatures/);
  } finally { source.close(); target.close(); }
});

test('v1 refuses unsupported structured KV values instead of silently converting binary or class instances to JSON', async () => {
  const source = await populated(); try {
    for (const value of [new Uint8Array([1, 2]), new Date(), new Map([['owned', 1]])]) {
      source.kv.set('unsupported', value); await assert.rejects(captureAuthorityRecovery(source.stores), /RECOVERY_KV_VALUE/);
    }
  } finally { source.close(); }
});
