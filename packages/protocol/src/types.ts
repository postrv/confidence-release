export type Digest = `sha256:${string}`;
export type Outcome = 'PASS' | 'FAIL' | 'ERROR' | 'TIMEOUT' | 'CANCELLED' | 'INCONCLUSIVE';
export type EvidenceClass = 'protected-behavioural' | 'repository-check';
export interface Scope { schemaVersion: 1; tenantId: string; projectId: string; projectIncarnation: string }
export interface ManifestEntry { path: string; mode: '100644' | '100755'; bytes: string; digest: string }
export interface SourceManifest { schemaVersion: 1; pathProfile: 'portable-ascii-v1'; entries: ManifestEntry[] }
export interface GitObject { oid: string; type: 'commit' | 'tree' | 'blob'; dataBase64: string }
export interface AdmissionState {
  scope: Scope; revision: string; head: string; gate: 'OPEN' | 'CLOSED' | 'RECOVERY';
  policyRevision: string; goalRevision: string; observationRevision: string; publicationSequence: string;
  unresolvedPublicationId: string | null; sponsor: { id: string; canPublish: boolean };
  reviewer: { id: string; canApprove: boolean };
  approval: { proposalDigest: string; reviewerId: string; expiresAt: number; consumedBy: string | null };
}
export interface ReviewProposal {
  schemaVersion: 1; scope: Scope; candidateId: string; candidateDigest: string; expectedHead: string;
  newHead: string; manifestDigest: string; goalRevision: string; policyRevision: string;
  observationRevision: string; planDigest: string; evidenceDigests: string[];
  requiredEvidenceClass: EvidenceClass; expiresAt: number;
}
export interface AdmissionCandidate { id: string; digest: string; commit: string; commitBytesDigest: string; parent: string; manifestDigest: string }
export interface EvaluationPlan {
  digest: string; candidateId: string; candidateDigest: string;
  jobs: { id: string; inputDigest: string; required: boolean; evidenceClass: EvidenceClass }[];
}
export interface AdmissionEvidence {
  id: string; digest: string; jobId: string; inputDigest: string; observationDigest: string; candidateId: string; candidateDigest: string;
  outcome: Outcome; evidenceClass: EvidenceClass; authorized: boolean;
}
export interface AdmissionInput {
  state: AdmissionState; proposal: ReviewProposal; candidate: AdmissionCandidate; plan: EvaluationPlan;
  evidence: AdmissionEvidence[];
  command: { id: string; callerId: string; proposalDigest: string; expectedRevision: string; operationId: string };
  now: number;
}
export interface AdmissionResult {
  accepted: boolean; reason: string;
  delta?: { revision: string; sequence: string; head: string; approvalConsumedBy: string; unresolvedPublicationId: string };
  effects?: { kind: 'prepare-publication'; operationId: string; oldHead: string; newHead: string }[];
}
export type PublicationPhase = 'ADMITTED' | 'READY' | 'MAY_HAVE_DISPATCHED' | 'UNKNOWN' | 'RECOVERY_HOLD' | 'OBSERVED' | 'RECEIPT_DURABLE' | 'FINALIZED';
export interface PublicationTransition {
  phase: PublicationPhase; gate: 'OPEN' | 'CLOSED' | 'RECOVERY';
  event: 'PREPARED' | 'DISPATCH' | 'AMBIGUOUS' | 'OBSERVE_OLD' | 'OBSERVE_NEW' | 'DIVERGENCE' | 'RECEIPT_SAVED' | 'FINALIZE';
  verified: boolean;
}
export interface Envelope { payloadType: 'application/vnd.in-toto+json'; payload: string; signatures: { keyid: string; sig: string }[] }
export interface Statement<T> { _type: 'https://in-toto.io/Statement/v1'; subject: { name: string; digest: { sha256: string } }[]; predicateType: string; predicate: T }
export type SignerRole = 'root' | 'authority' | 'checker';
export type AttestationKind = 'enrollment' | 'admission' | 'publication' | 'evidence' | 'checkpoint' | 'key-lifecycle';
export interface TrustKey { id: string; publicKeyBase64: string; roles: SignerRole[] }
export interface LegacyTrustConfig { schemaVersion: 1; scope: Scope; keysetRevision: string; keys: TrustKey[] }
/** The genesis is independently selected; every later key is derived from its root-authorized chain. */
export interface VersionedTrustConfig { schemaVersion: 2; scope: Scope; keysetRevision: string; keys: TrustKey[]; genesis: LegacyTrustConfig; lifecycle: Envelope[] }
export type TrustConfig = LegacyTrustConfig | VersionedTrustConfig;
export interface IssuanceContext { schemaVersion: 1; scope: Scope; signerKeysetRevision: string; authorityRevision: string }
/** The statement subject hashes record, so an endorsement cannot change the logical record identity. */
export interface IssuedAttestation<T> { schemaVersion: 2; record: T; issuance: IssuanceContext }
export interface KeyLifecycle {
  schemaVersion: 1; scope: Scope; previousRevision: string; revision: string;
  predecessorTransitionDigest: string | null; effectiveSequence: string; authorityRevision: string;
  operation: 'rotate' | 'revoke'; role: SignerRole; oldKeyId: string; newKey?: TrustKey; reason: string;
}
export interface ResolvedTrust {
  valid: boolean; reason?: string; genesisDigest?: string; keysetRevision?: string; keys?: TrustKey[];
  revokedKeyIds?: string[]; transitionDigest?: string | null;
  epochs?: { keysetRevision: string; effectiveSequence: string; keys: TrustKey[] }[];
}
export interface AttestationVerification<T = unknown> {
  valid: boolean; reason?: string; record?: T; recordDigest?: string;
  issuance?: IssuanceContext | null; legacy?: boolean;
  limitations?: string[];
}
export interface Enrollment { schemaVersion: 1; scope: Scope; head: string; manifestDigest: string; trustDigest: string; sequence: '0'; importedHistory: true }
export interface LogicalReceipt {
  schemaVersion: 1; scope: Scope; operationId: string; sequence: string; enrollmentDigest: string;
  /** Required by v2 endorsements; absent only in legacy logical receipts. */
  authorityRevision?: string;
  predecessorReceiptDigest: string | null; oldHead: string; newHead: string; candidateDigest: string;
  manifestDigest: string; proposalDigest: string; witnessDigest: string; evidenceDigests: string[];
  outcome: 'PUBLISHED'; limitations: string[];
}
export interface AdmissionAttestation { schemaVersion: 1; scope: Scope; operationId: string; witnessDigest: string; proposalDigest: string; candidateDigest: string; oldHead: string; newHead: string; sequence: string; delta: NonNullable<AdmissionResult['delta']> }
export interface Checkpoint { schemaVersion: 1; scope: Scope; enrollmentDigest: string; sequence: string; receiptDigest: string }
export interface CheckpointAttestation {
  schemaVersion: 1; checkpoint: Checkpoint;
  issuance: { schemaVersion: 1; scope: Scope; authorityRevision: string; signerKeysetRevision: string };
}
export interface VerificationBundle {
  schemaVersion: 1; enrollment: Envelope; admission: Envelope; publication: Envelope;
  evidence: Envelope[]; history: Envelope[];
  /** At most 128 additive v2 endorsements; at most eight envelopes per included exact logical record. */
  endorsements?: Envelope[];
  inputs: { witness: AdmissionInput; manifest: SourceManifest; gitObjects: GitObject[]; observations: {digest: string; dataBase64: string}[] };
}
export interface VerificationResult {
  valid: boolean; integrity: boolean; authorization: boolean; publicationObservation: boolean;
  continuity: boolean; sourceVerified: boolean; receiptDigest?: string; sequence?: string;
  errors: string[]; limitations: string[];
}
