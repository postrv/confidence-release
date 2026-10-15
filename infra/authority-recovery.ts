// SPDX-License-Identifier: Apache-2.0
/** NONPRODUCTION conformance adapter. No routes, environment reads, secret export,
 * native backup/PITR API, admission reopening or inference dispatch are provided.
 * The caller supplies owned stores and an independently retained commitment.
 * This bounded logical format is not a production disaster-recovery guarantee. */
import { canonicalize, decodeBase64, encodeBase64, resolveTrust, sha256 } from '../packages/protocol/src/index';
import type { Scope, SignerRole, TrustConfig } from '../packages/protocol/src/types';
import { AUTHORITY_SCHEMA } from '../workers/authority/schema';
import { PROJECT_CATALOG_SCHEMA } from '../workers/authority/project-catalog';
import { PROJECT_HUB_SCHEMA } from '../workers/authority/project-hub';

export const RECOVERY_PROFILE = 'owned-authority-recovery-conformance-v1' as const;
export const RECOVERY_MARKER = '__owned_authority_recovery_v1__';
export const RECOVERY_LIMITS = { rows: 10000, objects: 512, kv: 256, objectBytes: 4 * 1024 * 1024, totalObjectBytes: 8 * 1024 * 1024, encodedBytes: 16 * 1024 * 1024 } as const;
// This is the current constructor's trusted DDL, not SQL supplied by a backup.
export const RECOVERY_SCHEMA = AUTHORITY_SCHEMA + PROJECT_CATALOG_SCHEMA + PROJECT_HUB_SCHEMA
  + "CREATE INDEX IF NOT EXISTS outbox_pending_age ON outbox(created_at_ms) WHERE state='PENDING';";
type SqlValue = string | number | null | ArrayBuffer | Uint8Array;
type Cell = string | number | null | { blob: string };
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface RecoverySql {
  all(query: string, ...bindings: SqlValue[]): Record<string, SqlValue>[];
  exec(query: string, ...bindings: SqlValue[]): void;
  transaction<T>(body: () => T): T;
}
export interface OwnedRecoveryObjects {
  /** Adapter must reject pagination truncation; listing is local owned-test data. */
  inventory(): Promise<{ complete: true; entries: { key: string; bytes: Uint8Array }[] }>;
  putNew(key: string, bytes: Uint8Array): Promise<void>;
}
export interface OwnedRecoveryKv {
  entries(): Promise<[string, Json][]>;
  put(key: string, value: Json): Promise<void>;
}
export interface SignerCommitment { role: SignerRole; keyId: string; publicKeyBase64: string }
export interface OwnedRecoveryKeys {
  commitments(): Promise<SignerCommitment[]>;
  /** Sign an arbitrary conformance challenge; private key bytes never enter backup. */
  sign(role: SignerRole, challenge: Uint8Array): Promise<Uint8Array>;
}
export interface OwnedRecoveryFence {
  assertHeld(): void; // Must independently establish maintenance/broker/old-writer fences.
}
export interface OwnedRecoveryStores {
  sql: RecoverySql; kv: OwnedRecoveryKv; objects: OwnedRecoveryObjects; keys: OwnedRecoveryKeys; fence: OwnedRecoveryFence;
  alarm: { read(): Promise<number | null> };
}
interface Table { name: string; columns: string[]; rows: { rowid: number; cells: Cell[] }[] }
interface Body {
  schemaVersion: 1; profile: typeof RECOVERY_PROFILE; schemaSourceDigest: string;
  schema: { name: string; type: string; sql: string }[];
  scope: Scope; revision: string; trustDigest: string; alarm: number | null;
  tables: Table[]; sequences: { name: string; sequence: number }[];
  kv: [string, Json][]; objects: { key: string; digest: string; bytes: number; dataBase64: string }[];
  signers: SignerCommitment[]; complete: true;
}
export interface AuthorityRecoveryBackup { body: Body; digest: string }
export interface AuthorityRecoveryCommitment { profile: typeof RECOVERY_PROFILE; digest: string; scope: Scope; revision: string; trustDigest: string }
const fail = (code: string): never => { throw new Error(code); };
function need(ok: unknown, code: string): asserts ok { if (!ok) fail(code); }
const closed = (value: object, names: string[], code: string) => need(Object.keys(value).sort().join(',') === [...names].sort().join(','), code);
const quote = (name: string) => { need(/^[a-z_][a-z0-9_]*$/.test(name), 'RECOVERY_SQL_IDENTIFIER'); return '"' + name + '"'; };
const norm = (sql: string) => sql.replace(/\bIF NOT EXISTS\s+/g, '').replace(/\s+/g, ' ').trim();
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const encoded = (value: unknown): Uint8Array => new TextEncoder().encode(canonicalize(value));
const hash = (value: unknown) => sha256(encoded(value));
function valueCell(value: SqlValue): Cell {
  if (value instanceof ArrayBuffer || value instanceof Uint8Array) return { blob: encodeBase64(new Uint8Array(value)) };
  need(value === null || typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value), 'RECOVERY_SQL_VALUE'); return value;
}
function cellValue(value: Cell): SqlValue {
  if (value !== null && typeof value === 'object') {
    closed(value, ['blob'], 'RECOVERY_SQL_VALUE'); need(typeof value.blob === 'string', 'RECOVERY_SQL_VALUE');
    const bytes = decodeBase64(value.blob); need(encodeBase64(bytes) === value.blob, 'RECOVERY_SQL_VALUE'); return bytes;
  }
  return valueCell(value) as string | number | null;
}
function expectedSchema() {
  return RECOVERY_SCHEMA.split(';').map(x => x.trim()).filter(Boolean).map(sql => {
    const found = /^CREATE (?:UNIQUE )?(TABLE|INDEX) (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/.exec(sql);
    need(found, 'RECOVERY_TRUSTED_SCHEMA'); return { name: found[2]!, type: found[1]!.toLowerCase(), sql: norm(sql) };
  }).sort((a, b) => compare(a.name, b.name));
}
function schema(sql: RecoverySql) {
  // Exact known Cloudflare internal names only. Their values are owned by the
  // engine: KV and alarm are inventoried through storage APIs, never SQL reads.
  const rows = sql.all("SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT IN ('__cf_kv','_cf_KV','_cf_METADATA') ORDER BY name");
  const selected = rows.map(row => ({ name: String(row.name), type: String(row.type), sql: norm(String(row.sql)) }));
  need(canonicalize(selected) === canonicalize(expectedSchema()), 'RECOVERY_SCHEMA_INCOMPATIBLE'); return selected;
}
function snapshotSql(sql: RecoverySql) {
  const ddl = schema(sql); let count = 0;
  const tables = ddl.filter(x => x.type === 'table').map(item => {
    const columns = sql.all('PRAGMA table_info(' + quote(item.name) + ')').map(row => String(row.name));
    need(columns.length > 0 && !columns.includes('__recovery_rowid__'), 'RECOVERY_SCHEMA_INCOMPATIBLE');
    const raw = sql.all('SELECT rowid AS __recovery_rowid__,* FROM ' + quote(item.name) + ' ORDER BY rowid LIMIT ' + (RECOVERY_LIMITS.rows + 1));
    count += raw.length; need(count <= RECOVERY_LIMITS.rows, 'RECOVERY_ROW_LIMIT');
    const rows = raw.map(row => {
      need(typeof row.__recovery_rowid__ === 'number' && Number.isSafeInteger(row.__recovery_rowid__), 'RECOVERY_ROWID');
      return { rowid: row.__recovery_rowid__, cells: columns.map(column => valueCell(row[column]!)) };
    }); return { name: item.name, columns, rows };
  });
  const sequences = sql.all('SELECT name,seq FROM sqlite_sequence ORDER BY name').map(row => {
    need(['events', 'metadata_events', 'hub_messages'].includes(String(row.name)) && typeof row.seq === 'number' && Number.isSafeInteger(row.seq) && row.seq >= 0, 'RECOVERY_SEQUENCE'); return { name: String(row.name), sequence: row.seq };
  });
  need(sql.all('PRAGMA foreign_key_check').length === 0, 'RECOVERY_FOREIGN_KEYS');
  checkSequences(tables, sequences);
  return { schema: ddl, tables, sequences };
}
function checkSequences(tables: Table[], sequences: { name: string; sequence: number }[]) {
  for (const name of ['events', 'metadata_events', 'hub_messages']) {
    const rows = tables.find(table => table.name === name)!.rows;
    const retained = sequences.find(sequence => sequence.name === name);
    need(!rows.length || retained && retained.sequence >= Math.max(...rows.map(row => row.rowid)), 'RECOVERY_SEQUENCE');
  }
}
function projectAndTrust(tables: Table[]) {
  const rows = (name: string) => { const table = tables.find(x => x.name === name); need(table, 'RECOVERY_TABLE_INVENTORY'); return table.rows.map(row => Object.fromEntries(table.columns.map((column, i) => [column, cellValue(row.cells[i]!)]))); };
  const projects = rows('project'); need(projects.length === 1, 'RECOVERY_PROJECT_REQUIRED');
  const project = JSON.parse(String(projects[0]!.payload)) as { scope: Scope; revision: string; keysetRevision?: string; gate: string };
  need(project.scope?.schemaVersion === 1 && ['tenantId', 'projectId', 'projectIncarnation'].every(key => typeof project.scope[key as keyof Scope] === 'string') && /^(0|[1-9][0-9]*)$/.test(project.revision), 'RECOVERY_PROJECT_IDENTITY');
  const record = rows('records').find(row => row.kind === 'trust' && row.id === (project.keysetRevision ?? 'current')); need(record, 'RECOVERY_TRUST_REQUIRED');
  const trust = JSON.parse(String(record.payload)) as TrustConfig; const resolved = resolveTrust(trust);
  need(resolved.valid && resolved.keys && canonicalize(trust.scope) === canonicalize(project.scope), 'RECOVERY_TRUST_INVALID');
  return { project, trust, resolved };
}
async function keyAccess(keys: OwnedRecoveryKeys, tables: Table[], expected?: SignerCommitment[]) {
  const { resolved } = projectAndTrust(tables); const signers = [...await keys.commitments()].sort((a, b) => compare(a.role, b.role));
  need(signers.length === 3 && canonicalize(signers.map(x => x.role)) === canonicalize(['authority', 'checker', 'root']), 'RECOVERY_SIGNER_INVENTORY');
  if (expected) need(canonicalize(signers) === canonicalize(expected), 'RECOVERY_SIGNER_MISMATCH');
  for (const signer of signers) {
    closed(signer, ['role', 'keyId', 'publicKeyBase64'], 'RECOVERY_SIGNER_INVENTORY');
    const key = resolved.keys!.find(x => x.id === signer.keyId && x.roles.includes(signer.role));
    need(key && !resolved.revokedKeyIds?.includes(signer.keyId) && key.publicKeyBase64 === signer.publicKeyBase64, 'RECOVERY_SIGNER_MISMATCH');
    const nonce = encodeBase64(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = encoded({ purpose: RECOVERY_PROFILE, role: signer.role, keyId: signer.keyId, trust: await hash(projectAndTrust(tables).trust), nonce });
    const publicKey = await crypto.subtle.importKey('raw', decodeBase64(signer.publicKeyBase64).slice().buffer, 'Ed25519', false, ['verify']);
    need(await crypto.subtle.verify('Ed25519', publicKey, (await keys.sign(signer.role, challenge)).slice().buffer, challenge.slice().buffer), 'RECOVERY_SIGNER_POSSESSION');
  } return signers;
}
async function objectInventory(objects: OwnedRecoveryObjects) {
  const inventory = await objects.inventory(); need(inventory.complete === true && inventory.entries.length <= RECOVERY_LIMITS.objects, 'RECOVERY_OBJECT_INVENTORY');
  let total = 0; const seen = new Set<string>(); const result = [];
  for (const item of [...inventory.entries].sort((a, b) => compare(a.key, b.key))) {
    need(!seen.has(item.key) && (/^objects\/sha256\/[a-f0-9]{64}$/.test(item.key) || /^journal\/[a-zA-Z0-9/_-]+$/.test(item.key)), 'RECOVERY_OBJECT_KEY'); seen.add(item.key);
    total += item.bytes.length; need(item.bytes.length <= RECOVERY_LIMITS.objectBytes && total <= RECOVERY_LIMITS.totalObjectBytes, 'RECOVERY_OBJECT_LIMIT');
    const digest = await sha256(item.bytes); if (item.key.startsWith('objects/')) need(item.key === 'objects/sha256/' + digest.slice(7), 'RECOVERY_OBJECT_DIGEST');
    result.push({ key: item.key, digest, bytes: item.bytes.length, dataBase64: encodeBase64(item.bytes) });
  } return result;
}
async function kvInventory(kv: OwnedRecoveryKv) {
  const entries = [...await kv.entries()].sort((a, b) => compare(a[0], b[0])); need(entries.length <= RECOVERY_LIMITS.kv, 'RECOVERY_KV_LIMIT'); const seen = new Set<string>();
  const jsonOnly = (value: unknown, depth = 0): void => {
    need(depth <= 64, 'RECOVERY_KV_VALUE');
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isSafeInteger(value)) return;
    need(typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null), 'RECOVERY_KV_VALUE');
    for (const child of Object.values(value)) jsonOnly(child, depth + 1);
  };
  for (const [key, value] of entries) { need(typeof key === 'string' && key.length > 0 && key.length <= 256 && key !== RECOVERY_MARKER && !seen.has(key), 'RECOVERY_KV_INVENTORY'); seen.add(key); jsonOnly(value); canonicalize(value); }
  return entries;
}
function checkRequiredObjects(tables: Table[], objects: Body['objects']) {
  const present = new Set(objects.map(x => x.key)); const requireDigest = (value: unknown) => { if (value == null) return; need(typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) && present.has('objects/sha256/' + value.slice(7)), 'RECOVERY_REFERENCED_OBJECT_MISSING'); };
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    // Storage references, not arbitrary logical/implementation digests. The full
    // owned object inventory is retained as well, including immutable journals.
    for (const key of ['objectsDigest', 'observationDigest', 'requestObjectDigest', 'responseDigest', 'renderedContextDigest', 'sessionDigest', 'transportDigest']) if (key in record) requireDigest(record[key]);
    if ('manifest' in record && record.manifest && typeof record.manifest === 'object') {
      requireDigest(record.manifestDigest); const manifest = record.manifest as { entries?: { type?: string; digest?: string }[] };
      for (const entry of manifest.entries ?? []) if (entry.digest) requireDigest(entry.digest);
    }
    for (const nested of Object.values(record)) if (nested && typeof nested === 'object') walk(nested);
  };
  const { project } = projectAndTrust(tables);
  const publications = tables.find(x => x.name === 'publications')!;
  const payloadIndex = publications.columns.indexOf('payload');
  for (const row of publications.rows) {
    const publication = JSON.parse(String(row.cells[payloadIndex]));
    for (const [field, suffix, value] of [['preparedDigest', 'prepared', publication.preparedDescriptor], ['envelopeDigest', 'receipt', publication.envelope]] as const) if (publication[field]) {
      const key = `journal/${project.scope.projectIncarnation}/${publication.id}/${suffix}`;
      const stored = objects.find(x => x.key === key);
      need(stored && stored.digest === publication[field] && stored.dataBase64 === encodeBase64(encoded(value)), 'RECOVERY_PUBLICATION_JOURNAL_MISSING');
      if (field === 'preparedDigest') requireDigest(publication.witnessDigest);
    }
  }
  for (const table of tables) for (const row of table.rows) for (let index = 0; index < table.columns.length; index++) {
    if (table.columns[index] === 'payload' && typeof row.cells[index] === 'string') { try { walk(JSON.parse(row.cells[index] as string)); } catch (error) { if (error instanceof SyntaxError) fail('RECOVERY_PAYLOAD_JSON'); throw error; } }
    if (table.name === 'model_call_facts' && table.columns[index] === 'observation_digest') requireDigest(row.cells[index]);
  }
}
export async function captureAuthorityRecovery(stores: OwnedRecoveryStores): Promise<{ backup: AuthorityRecoveryBackup; commitment: AuthorityRecoveryCommitment }> {
  stores.fence.assertHeld(); const alarm = await stores.alarm.read(); need(alarm === null || Number.isSafeInteger(alarm) && alarm >= 0, 'RECOVERY_ALARM'); const before = snapshotSql(stores.sql); const kv = await kvInventory(stores.kv); const objects = await objectInventory(stores.objects); const signers = await keyAccess(stores.keys, before.tables);
  checkRequiredObjects(before.tables, objects); stores.fence.assertHeld();
  need(alarm === await stores.alarm.read() && canonicalize(before) === canonicalize(snapshotSql(stores.sql)) && canonicalize(kv) === canonicalize(await kvInventory(stores.kv)) && canonicalize(objects) === canonicalize(await objectInventory(stores.objects)), 'RECOVERY_CAPTURE_CHANGED');
  const { project, trust } = projectAndTrust(before.tables);
  const body: Body = { schemaVersion: 1, profile: RECOVERY_PROFILE, schemaSourceDigest: await sha256(encoded(RECOVERY_SCHEMA)), ...before, scope: project.scope, revision: project.revision, trustDigest: await hash(trust), alarm, kv, objects, signers, complete: true };
  const digest = await hash(body); need(encoded({ body, digest }).length <= RECOVERY_LIMITS.encodedBytes, 'RECOVERY_BACKUP_LIMIT');
  stores.fence.assertHeld();
  return { backup: { body, digest }, commitment: { profile: RECOVERY_PROFILE, digest, scope: project.scope, revision: project.revision, trustDigest: body.trustDigest } };
}
function emptyTarget(stores: OwnedRecoveryStores) {
  const target = snapshotSql(stores.sql); need(target.tables.every(x => x.rows.length === 0) && target.sequences.length === 0, 'RECOVERY_TARGET_NOT_EMPTY'); return target;
}
export async function restoreAuthorityRecovery(stores: OwnedRecoveryStores, backup: AuthorityRecoveryBackup, expected: AuthorityRecoveryCommitment): Promise<{ state: 'RESTORED_FENCED'; digest: string }> {
  stores.fence.assertHeld(); need(encoded(backup).length <= RECOVERY_LIMITS.encodedBytes, 'RECOVERY_BACKUP_LIMIT');
  closed(backup, ['body', 'digest'], 'RECOVERY_BACKUP_SHAPE'); const body = backup.body;
  closed(body, ['schemaVersion', 'profile', 'schemaSourceDigest', 'schema', 'scope', 'revision', 'trustDigest', 'alarm', 'tables', 'sequences', 'kv', 'objects', 'signers', 'complete'], 'RECOVERY_BACKUP_SHAPE');
  need(body.schemaVersion === 1 && body.profile === RECOVERY_PROFILE && expected.profile === RECOVERY_PROFILE && body.complete === true, 'RECOVERY_VERSION');
  need(await hash(body) === backup.digest && backup.digest === expected.digest && canonicalize(body.scope) === canonicalize(expected.scope) && body.revision === expected.revision && body.trustDigest === expected.trustDigest, 'RECOVERY_COMMITMENT_MISMATCH');
  need(body.schemaSourceDigest === await sha256(encoded(RECOVERY_SCHEMA)) && canonicalize(body.schema) === canonicalize(expectedSchema()), 'RECOVERY_SCHEMA_INCOMPATIBLE');
  need(body.alarm === null || Number.isSafeInteger(body.alarm) && body.alarm >= 0, 'RECOVERY_ALARM');
  const target = emptyTarget(stores); need(body.tables.length === target.tables.length, 'RECOVERY_TABLE_INVENTORY'); let rows = 0;
  for (let i = 0; i < target.tables.length; i++) {
    const table = body.tables[i]!, shape = target.tables[i]!; closed(table, ['name', 'columns', 'rows'], 'RECOVERY_TABLE_INVENTORY');
    need(table.name === shape.name && canonicalize(table.columns) === canonicalize(shape.columns), 'RECOVERY_TABLE_INVENTORY'); let last = -Infinity;
    for (const row of table.rows) { closed(row, ['rowid', 'cells'], 'RECOVERY_ROW_SHAPE'); need(Number.isSafeInteger(row.rowid) && row.rowid > last && row.cells.length === table.columns.length, 'RECOVERY_ROW_SHAPE'); last = row.rowid; row.cells.forEach(cellValue); }
    rows += table.rows.length; need(rows <= RECOVERY_LIMITS.rows, 'RECOVERY_ROW_LIMIT');
  }
  need(body.sequences.length <= 3 && new Set(body.sequences.map(x => x.name)).size === body.sequences.length && body.sequences.every(x => ['events', 'metadata_events', 'hub_messages'].includes(x.name) && Number.isSafeInteger(x.sequence) && x.sequence >= 0), 'RECOVERY_SEQUENCE');
  for (const sequence of body.sequences) closed(sequence, ['name', 'sequence'], 'RECOVERY_SEQUENCE');
  checkSequences(body.tables, body.sequences);
  const { project, trust } = projectAndTrust(body.tables); need(canonicalize(project.scope) === canonicalize(body.scope) && project.revision === body.revision && await hash(trust) === body.trustDigest, 'RECOVERY_PROJECT_IDENTITY');
  const objects = await objectInventory({ inventory: async () => ({ complete: true, entries: body.objects.map(x => ({ key: x.key, bytes: decodeBase64(x.dataBase64) })) }), putNew: async () => fail('UNREACHABLE') });
  need(canonicalize(objects) === canonicalize(body.objects), 'RECOVERY_OBJECT_INVENTORY'); checkRequiredObjects(body.tables, objects);
  const kv = await kvInventory({ entries: async () => body.kv, put: async () => fail('UNREACHABLE') }); need(canonicalize(kv) === canonicalize(body.kv), 'RECOVERY_KV_INVENTORY'); await keyAccess(stores.keys, body.tables, body.signers);
  need(await stores.alarm.read() === null, 'RECOVERY_TARGET_NOT_EMPTY');
  need((await kvInventory(stores.kv)).length === 0 && (await objectInventory(stores.objects)).length === 0, 'RECOVERY_TARGET_NOT_EMPTY'); stores.fence.assertHeld(); emptyTarget(stores);
  // A local sidecar survives partial object/KV writes. Never delete it or retry
  // into that nonempty target automatically. Reconcile or use a new owned target.
  const marker = (state: 'STARTED_UNKNOWN' | 'RESTORED_FENCED') => ({ profile: RECOVERY_PROFILE, digest: backup.digest, state, capturedAlarm: body.alarm });
  const readbackKv = async (state: 'STARTED_UNKNOWN' | 'RESTORED_FENCED', includeRestored: boolean) => {
    const actual = [...await stores.kv.entries()].sort((a, b) => compare(a[0], b[0]));
    stores.fence.assertHeld();
    const wanted = [...(includeRestored ? kv : []), [RECOVERY_MARKER, marker(state)] as [string, Json]].sort((a, b) => compare(a[0], b[0]));
    need(canonicalize(actual) === canonicalize(wanted), 'RECOVERY_KV_READBACK');
  };
  await stores.kv.put(RECOVERY_MARKER, marker('STARTED_UNKNOWN'));
  try {
    await readbackKv('STARTED_UNKNOWN', false);
    for (const object of objects) { stores.fence.assertHeld(); await stores.objects.putNew(object.key, decodeBase64(object.dataBase64)); }
    need(canonicalize(await objectInventory(stores.objects)) === canonicalize(objects), 'RECOVERY_OBJECT_READBACK');
    stores.fence.assertHeld(); stores.sql.transaction(() => {
      emptyTarget(stores); stores.sql.exec('PRAGMA defer_foreign_keys=ON');
      for (const table of body.tables) for (const row of table.rows) stores.sql.exec('INSERT INTO ' + quote(table.name) + '(rowid,' + table.columns.map(quote).join(',') + ') VALUES(' + Array(table.columns.length + 1).fill('?').join(',') + ')', row.rowid, ...row.cells.map(cellValue));
      stores.sql.exec('DELETE FROM sqlite_sequence'); for (const entry of body.sequences) stores.sql.exec('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)', entry.name, entry.sequence);
      need(canonicalize(snapshotSql(stores.sql)) === canonicalize({ schema: body.schema, tables: body.tables, sequences: body.sequences }), 'RECOVERY_SQL_READBACK');
    });
    for (const [key, value] of kv) { stores.fence.assertHeld(); await stores.kv.put(key, value); }
    await readbackKv('STARTED_UNKNOWN', true); stores.fence.assertHeld();
    await stores.kv.put(RECOVERY_MARKER, marker('RESTORED_FENCED'));
    stores.fence.assertHeld(); await readbackKv('RESTORED_FENCED', true); stores.fence.assertHeld();
  } catch (error) {
    // A final await can lose its fence or acknowledgment. Preserve uncertainty;
    // this best-effort diagnostic never authorizes reuse or reopening.
    try { await stores.kv.put(RECOVERY_MARKER, marker('STARTED_UNKNOWN')); } catch { /* Original failure remains unacknowledged. */ }
    throw error;
  }
  return { state: 'RESTORED_FENCED', digest: backup.digest };
}
