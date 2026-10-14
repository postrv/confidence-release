import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize } from '../packages/protocol/src/index.ts';
import type { IssuanceContext } from '../packages/protocol/src/types.ts';

// The local adapter only emits I-JSON values. Shared protocol verification also
// rejects duplicate JSON members and validates every interpreted record.
export function canonical(value: unknown): string {
  // Optional local fields are omitted before the shared closed canonical profile.
  // Every signed/interpreted value then follows the same safe-integer semantics.
  return canonicalize(JSON.parse(JSON.stringify(value)));
}
export function digest(value: unknown): string { return hashBytes(Buffer.from(canonical(value))); }
export function hashBytes(value: Uint8Array | string): string { return 'sha256:' + createHash('sha256').update(value).digest('hex'); }
export function pae(type: string, payload: Uint8Array): Buffer {
  const t = Buffer.from(type); return Buffer.concat([Buffer.from(`DSSEv1 ${t.length} `), t, Buffer.from(` ${payload.length} `), Buffer.from(payload)]);
}
export interface Envelope { payloadType: string; payload: string; signatures: { keyid: string; sig: string }[]; }
export class LocalKeys {
  private keys: Record<string, { privatePem: string; publicPem: string }>;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 }); const path = join(directory, 'keys.json');
    if (existsSync(path)) this.keys = JSON.parse(readFileSync(path, 'utf8'));
    else {
      if (existsSync(join(directory, 'state.json'))) throw new Error('MISSING_AUTHORITY_KEYS_REENROLLMENT_REQUIRED');
      this.keys = Object.fromEntries(['checker', 'decision', 'root'].map(role => {
        const key = generateKeyPairSync('ed25519');
        return [role, { privatePem: key.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicPem: key.publicKey.export({ format: 'pem', type: 'spki' }).toString() }];
      }));
      const temporary = path + '.tmp'; writeFileSync(temporary, canonical(this.keys), { mode: 0o600, flag: 'wx' });
      const file = openSync(temporary, 'r'); try { fsyncSync(file); } finally { closeSync(file); }
      renameSync(temporary, path); const parent = openSync(directory, 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
    }
  }
  keyId(role: string): string { return hashBytes(Buffer.from(this.keys[role].publicPem)); }
  envelope(role: string, statement: unknown): Envelope {
    const payloadType = 'application/vnd.in-toto+json'; const payload = Buffer.from(canonical(statement));
    return { payloadType, payload: payload.toString('base64'), signatures: [{ keyid: this.keyId(role), sig: sign(null, pae(payloadType, payload), createPrivateKey(this.keys[role].privatePem)).toString('base64') }] };
  }
  attest(role: string, kind: 'enrollment' | 'admission' | 'publication' | 'evidence' | 'checkpoint', record: unknown, issuance?: IssuanceContext): Envelope {
    return this.envelope(role, { _type: 'https://in-toto.io/Statement/v1', subject: [{ name: `confidence/${kind}`, digest: { sha256: digest(record).slice(7) } }], predicateType: `https://confidence.dev/attestation/${kind}/${issuance ? 'v2' : 'v1'}`, predicate: issuance ? { schemaVersion: 2, record, issuance } : record });
  }
  publicConfig(projectId: string, incarnation: string): Record<string, unknown> {
    const keys = Object.entries(this.keys).map(([role, key]) => ({ id: this.keyId(role), roles: [role === 'decision' ? 'authority' : role], publicKeyBase64: createPublicKey(key.publicPem).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') }));
    return { schemaVersion: 1, scope: { schemaVersion: 1, projectId, projectIncarnation: incarnation, tenantId: 'local-tenant' }, keysetRevision: '1', keys };
  }
  verify(envelope: Envelope, role: string): unknown {
    if (envelope.payloadType !== 'application/vnd.in-toto+json' || envelope.signatures.length !== 1) throw new Error('Unsupported DSSE envelope');
    const signature = envelope.signatures[0]; const payload = Buffer.from(envelope.payload, 'base64');
    if (signature.keyid !== this.keyId(role) || !verify(null, pae(envelope.payloadType, payload), createPublicKey(this.keys[role].publicPem), Buffer.from(signature.sig, 'base64'))) throw new Error('Signature or role invalid');
    const parsed = JSON.parse(payload.toString('utf8')); if (canonical(parsed) !== payload.toString('utf8')) throw new Error('Noncanonical signed payload'); return parsed;
  }
}
