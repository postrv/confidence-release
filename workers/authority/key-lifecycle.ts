/** Pure signing/interpretation helpers. Admission and durable epoch selection remain in the authority. */
import { advanceKeyset, canonicalize, digest, issuedStatement, resolveTrust, signStatement, verifyAttestation } from '../../packages/protocol/src/index.ts';
import type { AttestationKind, Envelope, IssuanceContext, KeyLifecycle, SignerRole, TrustConfig, TrustKey, VersionedTrustConfig } from '../../packages/protocol/src/types.ts';

export function checkedTrust(trust: TrustConfig) {
  const resolved = resolveTrust(trust);
  if (!resolved.valid || !resolved.keys || !resolved.keysetRevision || !resolved.genesisDigest) throw new Error(resolved.reason ?? 'INVALID_TRUST');
  return resolved as typeof resolved & { keys: TrustKey[]; keysetRevision: string; genesisDigest: string };
}

export function genesisTrust(trust: TrustConfig) { return trust.schemaVersion === 2 ? trust.genesis : trust; }

export function currentSigner(trust: TrustConfig, keyId: string, role: SignerRole): TrustKey {
  const resolved = checkedTrust(trust);
  const key = resolved.keys.find(key => key.id === keyId && key.roles.includes(role));
  if (!key || resolved.revokedKeyIds?.includes(keyId)) throw new Error('CURRENT_SIGNER_ROLE_MISMATCH');
  return key;
}

/** Read-back verification detects a secret whose public key does not match its independently authorized ID. */
export async function signIssued<T>(input: { trust: TrustConfig; kind: AttestationKind; record: T; role: SignerRole; keyId: string; privateKey: CryptoKey; authorityRevision: string; sequence?: string }): Promise<Envelope> {
  const resolved = checkedTrust(input.trust);
  currentSigner(input.trust, input.keyId, input.role);
  const issuance: IssuanceContext = { schemaVersion: 1, scope: input.trust.scope, signerKeysetRevision: resolved.keysetRevision, authorityRevision: input.authorityRevision };
  const envelope = await signStatement(await issuedStatement(input.kind, input.record, issuance), input.keyId, input.privateKey);
  const verified = verifyAttestation<T>({ trust: input.trust, envelope, role: input.role, kind: input.kind, authorityRevision: input.authorityRevision, ...(input.sequence === undefined ? {} : { sequence: input.sequence }), allowLegacy: false });
  if (!verified.valid || canonicalize(verified.record) !== canonicalize(input.record)) throw new Error(verified.reason ?? 'SIGNATURE_READBACK_MISMATCH');
  return envelope;
}

export interface LifecycleChange {
  operation: 'rotate' | 'revoke'; role: SignerRole; oldKeyId: string; newKey?: TrustKey;
  effectiveSequence: string; authorityRevision: string; reason: string;
}

/** Prepare a root-signed successor. Caller must compare-and-set the same previous epoch and project revision. */
export async function prepareKeyLifecycle(input: { trust: TrustConfig; change: LifecycleChange; rootKeyId: string; rootPrivateKey: CryptoKey }): Promise<{ record: KeyLifecycle; envelope: Envelope; trust: VersionedTrustConfig; transitionDigest: string }> {
  const before = checkedTrust(input.trust);
  currentSigner(input.trust, input.rootKeyId, 'root');
  const { newKey, ...change } = input.change;
  const record: KeyLifecycle = { schemaVersion: 1, scope: input.trust.scope, previousRevision: before.keysetRevision, revision: (BigInt(before.keysetRevision) + 1n).toString(), predecessorTransitionDigest: before.transitionDigest ?? null, ...change, ...(newKey === undefined ? {} : { newKey }) };
  const issuance: IssuanceContext = { schemaVersion: 1, scope: input.trust.scope, signerKeysetRevision: before.keysetRevision, authorityRevision: record.authorityRevision };
  const envelope = await signStatement(await issuedStatement('key-lifecycle', record, issuance), input.rootKeyId, input.rootPrivateKey);
  const advanced = advanceKeyset(input.trust, envelope);
  if (!advanced.valid || !advanced.trust) throw new Error(advanced.reason ?? 'INVALID_KEY_LIFECYCLE');
  return { record, envelope, trust: advanced.trust, transitionDigest: await digest(record) };
}

/** A later authorized issuer can add an endorsement without changing the immutable logical record. */
export async function endorseRecord<T>(input: { trust: TrustConfig; kind: Exclude<AttestationKind, 'key-lifecycle'>; record: T; role: SignerRole; keyId: string; privateKey: CryptoKey; authorityRevision: string; sequence?: string }) {
  return { envelope: await signIssued(input), recordDigest: await digest(input.record) };
}
