export * from './types.ts';
export * from './typescript-workload-profile.ts';
import type { Envelope, Statement, AdmissionInput, AdmissionResult, VerificationResult, AttestationKind, IssuanceContext, IssuedAttestation, TrustConfig, VersionedTrustConfig, ResolvedTrust, AttestationVerification, SignerRole } from './types.ts';

/** Pure verification capacity; application source profiles retain their own admission limits. */
export const MAX_JSON_BYTES = 32 * 1024 * 1024;
function validString(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) { const tail = value.charCodeAt(++i); if (!(tail >= 0xdc00 && tail <= 0xdfff)) throw new Error('MALFORMED_UNICODE'); }
    else if (n >= 0xdc00 && n <= 0xdfff) throw new Error('MALFORMED_UNICODE');
  }
}
/** Closed RFC8785 profile: strings, booleans, null and safe integers only. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { validString(value); return JSON.stringify(value); }
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) throw new Error('NONCANONICAL_NUMBER'); return JSON.stringify(value); }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new Error('UNSUPPORTED_JSON_VALUE');
      items.push(canonicalize(value[index]));
    }
    return '[' + items.join(',') + ']';
  }
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => { validString(key); return JSON.stringify(key) + ':' + canonicalize((value as Record<string, unknown>)[key]); }).join(',') + '}';
  }
  throw new Error('UNSUPPORTED_JSON_VALUE');
}
export async function sha256(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const hash = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return 'sha256:' + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export async function digest(value: unknown): Promise<string> { return sha256(canonicalize(value)); }
export function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('INVALID_BASE64');
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
export function encodeBase64(value: Uint8Array): string {
  let s = ''; for (let offset = 0; offset < value.length; offset += 8192) s += String.fromCharCode(...value.subarray(offset, offset + 8192)); return btoa(s);
}
export function dssePAE(payloadType: string, payload: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`DSSEv1 ${new TextEncoder().encode(payloadType).length} ${payloadType} ${payload.length} `);
  const out = new Uint8Array(prefix.length + payload.length); out.set(prefix); out.set(payload, prefix.length); return out;
}
export async function signStatement<T>(statement: Statement<T>, keyid: string, privateKey: CryptoKey): Promise<Envelope> {
  const payloadType = 'application/vnd.in-toto+json' as const;
  const bytes = new TextEncoder().encode(canonicalize(statement));
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, dssePAE(payloadType, bytes) as BufferSource));
  return { payloadType, payload: encodeBase64(bytes), signatures: [{ keyid, sig: encodeBase64(signature) }] };
}
export async function statement<T>(kind: 'enrollment'|'admission'|'publication'|'evidence'|'checkpoint', predicate: T): Promise<Statement<T>> {
  return { _type: 'https://in-toto.io/Statement/v1', subject: [{ name: `confidence/${kind}`, digest: { sha256: (await digest(predicate)).slice(7) } }], predicateType: `https://confidence.dev/attestation/${kind}/v1`, predicate };
}
export async function issuedStatement<T>(kind: AttestationKind, record: T, issuance: IssuanceContext): Promise<Statement<IssuedAttestation<T>>> {
  return { _type: 'https://in-toto.io/Statement/v1', subject: [{ name: `confidence/${kind}`, digest: { sha256: (await digest(record)).slice(7) } }], predicateType: `https://confidence.dev/attestation/${kind}/v2`, predicate: { schemaVersion: 2, record, issuance } };
}
export interface Kernel {
  evaluate_admission(input: string): string;
  transition_publication(input: string): string;
  validate_manifest(input: string): string;
  validate_git_source(input: string): string;
  verify_bundle(bundle: string, trust: string, checkpoint: string): string;
  canonical_json(input: string): string;
  validate_grant(input: string): string;
  grant_inclusion(input: string): string;
  budget_transition(input: string): string;
  compose_manifests(input: string): string;
  transplant_manifest(input: string): string;
  transition_execution(input: string): string;
  resolve_trust(input: string): string;
  advance_keyset(input: string): string;
  verify_attestation(input: string): string;
}
let kernel: Kernel | undefined;
export function installKernel(value: Kernel): void { kernel = value; }
export function getKernel(): Kernel { if (!kernel) throw new Error('PROTOCOL_KERNEL_NOT_INITIALIZED'); return kernel; }
/** Reject duplicate members before they can be erased by JSON.parse. */
export function parseStrictJson(input: string): unknown { return JSON.parse(getKernel().canonical_json(input)); }
export function evaluateAdmission(input: AdmissionInput): AdmissionResult { return JSON.parse(getKernel().evaluate_admission(canonicalize(input))) as AdmissionResult; }
export function verifyBundle(bundle: unknown, trust: unknown, checkpoint: unknown = null): VerificationResult {
  return JSON.parse(getKernel().verify_bundle(canonicalize(bundle), canonicalize(trust), canonicalize(checkpoint))) as VerificationResult;
}
export function resolveTrust(trust: TrustConfig): ResolvedTrust { return JSON.parse(getKernel().resolve_trust(canonicalize(trust))) as ResolvedTrust; }
export function advanceKeyset(trust: TrustConfig, transition: Envelope): { valid: boolean; reason?: string; trust?: VersionedTrustConfig; resolved?: ResolvedTrust } {
  return JSON.parse(getKernel().advance_keyset(canonicalize({ trust, transition })));
}
export function verifyAttestation<T>(input: { trust: TrustConfig; envelope: Envelope; role: SignerRole; kind: AttestationKind; sequence?: string; authorityRevision?: string; allowLegacy?: boolean }): AttestationVerification<T> {
  return JSON.parse(getKernel().verify_attestation(canonicalize(input))) as AttestationVerification<T>;
}
