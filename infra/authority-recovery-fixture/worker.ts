// SPDX-License-Identifier: Apache-2.0
// TEST ONLY. NEVER DEPLOY. Local Miniflare owns every store and signer. The
// production Application/Authority expose none of these recovery test methods.
import { TestAuthority } from '../test-authority/worker';
import { ObjectStore } from '../../workers/shared/objects';
import { canonicalize, decodeBase64, sha256 } from '../../packages/protocol/src/index';
import type { AuthorityEnv } from '../../workers/authority/types';
import { captureAuthorityRecovery, restoreAuthorityRecovery, RECOVERY_LIMITS,
  type OwnedRecoveryStores, type AuthorityRecoveryBackup, type AuthorityRecoveryCommitment, type SignerCommitment } from '../authority-recovery';

interface FixtureEnv extends AuthorityEnv {
  SOURCE_OBJECTS: R2Bucket; TARGET_OBJECTS: R2Bucket;
  SOURCES: DurableObjectNamespace<RecoverySource>; TARGETS: DurableObjectNamespace<RecoveryTarget>;
  OWNED_RECOVERY_FIXTURE: string; OWNED_SOURCE_FENCED: string; OWNED_PUBLIC_SIGNERS: string; OWNED_CHECKER_KEY: string;
}
abstract class RecoveryAuthority extends TestAuthority {
  constructor(ctx: DurableObjectState, env: FixtureEnv, target: boolean) {
    super(ctx, { ...env, OBJECTS: target ? env.TARGET_OBJECTS : env.SOURCE_OBJECTS, MAINTENANCE_MODE: target || env.OWNED_SOURCE_FENCED === 'true' ? 'true' : 'false' });
  }
  private stores(): OwnedRecoveryStores {
    const env = this.env as FixtureEnv, sql = this.ctx.storage.sql;
    return {
      sql: { all: (query, ...bindings) => sql.exec(query, ...bindings as SqlStorageValue[]).toArray(), exec: (query, ...bindings) => { sql.exec(query, ...bindings as SqlStorageValue[]); }, transaction: body => this.ctx.storage.transactionSync(body) },
      alarm: { read: () => this.ctx.storage.getAlarm() },
      kv: { entries: async () => [...await this.ctx.storage.list()] as never, put: (key, value) => this.ctx.storage.put(key, value) },
      objects: {
        inventory: async () => {
          const entries: { key: string; bytes: Uint8Array }[] = []; let cursor: string | undefined;
          do {
            const page = await env.OBJECTS.list({ limit: RECOVERY_LIMITS.objects + 1, ...(cursor ? { cursor } : {}) });
            for (const listed of page.objects) {
              if (entries.length >= RECOVERY_LIMITS.objects || listed.size > RECOVERY_LIMITS.objectBytes) throw Error('OWNED_OBJECT_INVENTORY_BOUND');
              const value = await env.OBJECTS.get(listed.key); if (!value || value.size !== listed.size) throw Error('OWNED_OBJECT_CHANGED');
              entries.push({ key: listed.key, bytes: new Uint8Array(await value.arrayBuffer()) });
            }
            cursor = page.truncated ? page.cursor : undefined;
          } while (cursor);
          return { complete: true, entries };
        },
        putNew: async (key, bytes) => {
          const store = new ObjectStore(env.OBJECTS);
          if (await env.OBJECTS.head(key)) throw Error('OWNED_OBJECT_TARGET_NOT_EMPTY');
          if (key.startsWith('objects/sha256/')) await store.put(bytes, 'sha256:' + key.slice('objects/sha256/'.length));
          else await store.putJournal(key, bytes);
        },
      },
      keys: {
        commitments: async () => JSON.parse(env.OWNED_PUBLIC_SIGNERS) as SignerCommitment[],
        sign: async (role, challenge) => {
          const secret = role === 'root' ? env.ROOT_SIGNING_KEY! : role === 'authority' ? env.AUTHORITY_SIGNING_KEY : env.OWNED_CHECKER_KEY;
          const key = await crypto.subtle.importKey('pkcs8', decodeBase64(secret).slice().buffer, 'Ed25519', false, ['sign']);
          return new Uint8Array(await crypto.subtle.sign('Ed25519', key, challenge.slice().buffer));
        },
      },
      fence: { assertHeld() { if (env.OWNED_RECOVERY_FIXTURE !== 'true' || env.MAINTENANCE_MODE !== 'true') throw Error('OWNED_EXTERNAL_FENCE_REQUIRED'); } },
    };
  }
  async seedRecovery(input: any) {
    const result = await this.seed(input);
    // The old shared fixture stores this manifest inline; this recovery fixture
    // deliberately includes its independently addressed object as well.
    if (input.baselineSource) {
      const store = new ObjectStore(this.env.OBJECTS); await store.put(new TextEncoder().encode(canonicalize(input.baselineSource.manifest)), input.baselineSource.manifestDigest);
      for (const object of input.baselineSource.gitObjects) if (object.type === 'blob') { const bytes = decodeBase64(object.dataBase64); await store.put(bytes, await sha256(bytes)); }
    }
    return result;
  }
  async fenceRecovery() { this.env.MAINTENANCE_MODE = 'true'; await this.ctx.storage.deleteAlarm(); return { state: 'OWNED_FENCED' }; }
  async captureRecovery(): Promise<unknown> { return captureAuthorityRecovery(this.stores()); }
  async restoreRecovery(input: unknown): Promise<unknown> { const selected = input as { backup: AuthorityRecoveryBackup; commitment: AuthorityRecoveryCommitment }; return restoreAuthorityRecovery(this.stores(), selected.backup, selected.commitment); }
  recoveryRows() {
    const tables = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT IN ('__cf_kv','_cf_KV','_cf_METADATA') ORDER BY name").toArray();
    return Object.fromEntries(tables.map(({ name }) => [name, this.ctx.storage.sql.exec('SELECT rowid AS owned_rowid,* FROM "' + name + '" ORDER BY rowid').toArray()]));
  }
  async recoveryKv() { return [...await this.ctx.storage.list()]; }
  async probeOriginalModel(input: Parameters<TestAuthority['reserveModel']>[0]) {
    if (!this.ctx.storage.sql.exec('SELECT id FROM reservations WHERE id=?', input.callId).toArray().length) throw Error('OWNED_EXISTING_CALL_ONLY');
    const before = this.env.MAINTENANCE_MODE; this.env.MAINTENANCE_MODE = 'false';
    try { return await this.reserveModel(input); } finally { this.env.MAINTENANCE_MODE = before; }
  }
  async probeOriginalCommand(input: Parameters<TestAuthority['command']>) {
    if (!this.ctx.storage.sql.exec('SELECT id FROM commands WHERE caller=? AND id=?', input[0].principal.id, input[1].commandId).toArray().length) throw Error('OWNED_EXISTING_COMMAND_ONLY');
    const before = this.env.MAINTENANCE_MODE; this.env.MAINTENANCE_MODE = 'false';
    try { return await this.command(...input); } finally { this.env.MAINTENANCE_MODE = before; }
  }
}
export class RecoverySource extends RecoveryAuthority { constructor(ctx: DurableObjectState, env: FixtureEnv) { super(ctx, env, false); } }
export class RecoveryTarget extends RecoveryAuthority { constructor(ctx: DurableObjectState, env: FixtureEnv) { super(ctx, env, true); } }
export default {
  async fetch(request: Request, env: FixtureEnv) {
    const url = new URL(request.url);
    if (env.OWNED_RECOVERY_FIXTURE !== 'true' || url.protocol !== 'http:' || url.hostname !== 'owned-recovery.test') return new Response('Local owned fixture only', { status: 404 });
    const match = /^\/(source|target)\/([a-z-]+)$/.exec(url.pathname); if (!match) return new Response(null, { status: 404 });
    const stub = (match[1] === 'source' ? env.SOURCES : env.TARGETS).getByName('owned-authority-recovery') as DurableObjectStub<RecoverySource>;
    try {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const raw = await request.text(); if (raw.length > RECOVERY_LIMITS.encodedBytes + 4096) throw Error('OWNED_REQUEST_BOUND');
      const body = raw ? JSON.parse(raw) : {}; let value: unknown;
      switch (match[2]) {
        case 'seed': value = await stub.seedRecovery(body); break;
        case 'command': value = await stub.command(body.caller, body.command); break;
        case 'observation': value = await stub.reportEvidence(body); break;
        case 'model-reservation': value = await stub.reserveModel(body); break;
        case 'settle-owned-effects': value = await stub.settleOwnedEffects(); break;
        case 'advance': value = await stub.advanceOnce(); break;
        case 'inspect': value = await stub.inspect(); break;
        case 'rows': value = await stub.recoveryRows(); break;
        case 'kv': value = await stub.recoveryKv(); break;
        case 'fence': value = await stub.fenceRecovery(); break;
        case 'capture': value = await stub.captureRecovery(); break;
        case 'restore': value = await stub.restoreRecovery(body); break;
        case 'original-model': value = await stub.probeOriginalModel(body); break;
        case 'original-command': value = await stub.probeOriginalCommand(body); break;
        default: return new Response(null, { status: 404 });
      }
      return Response.json(value);
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'OWNED_RECOVERY_ERROR' }, { status: 409 }); }
  },
};
