export type Outcome = 'PASS' | 'FAIL' | 'ERROR' | 'TIMEOUT' | 'CANCELLED' | 'INCONCLUSIVE';
export type AgentMode = 'scripted' | 'pi';
export interface Event { id: string; sequence: number; time: string; type: string; message: string; objectId?: string; }
export interface SourceEntry { path: string; mode: '100644' | '100755'; size: number; digest: string; gitOid: string; }
export interface Manifest { schemaVersion: 1; profile: 'ascii-regular-v1'; entries: SourceEntry[]; }
export interface ContinuationRequest { contextCapsuleId: string; contextCapsuleDigest: string; workBase: string; sessionEntry: string; commandId?: string; }
export interface ContinuationReference {
  capsuleId: string; capsuleDigest: string; originalAttemptId: string; sourceCommit: string; sourceManifestDigest: string;
  sessionDigest: string; sessionEntry: string; sessionId: string; selectedContextDigest: string; selectorVersion: 'pi-selected-branch-v1';
}
export interface Attempt {
  id: string; name: string; role: 'A' | 'B' | 'C' | 'repair'; mode: AgentMode;
  status: string; assigned: string; intent?: string; observed?: string;
  workBase: string; publicationBase: string; generation: number; grantId: string;
  allowedPaths: string[]; readOnlyContextPaths?: string[]; startedAt?: string; completedAt?: string; submissionId?: string;
  commit?: string; changedPaths?: string[]; capsuleId?: string; error?: string;
  partialSessionDigest?: string;
  previewTransport?: 'host-ipc-v1';
  previewLifecycle?: { schemaVersion: 1; hostOwned: true; invalid: boolean; runs: { round: number; state: 'PREPARING' | 'RUNNING' | 'SETTLED'; pid?: number; terminationObserved: boolean }[] };
  log?: string; outputTruncated?: boolean; pid?: number; terminationObserved?: boolean;
  executionLifecycle?: string; executionOutcome?: string;
  contextReference?: ContinuationReference;
  reservation?: { id: string; authoringSeconds: number; status: 'HELD' | 'RELEASED' };
}
export interface Candidate {
  id: string; name: string; digest: string; commit: string; commitBytesDigest: string;
  manifestDigest: string; manifest: Manifest; publicationBase: string;
  attemptIds: string[]; submissionIds: string[]; composition: string[];
  status: string; outcome?: Outcome; evaluationIds: string[]; createdAt: string;
  /** A retained outcome can guide diagnosis but cannot qualify a release. */
  outcomeProvenance?: 'current' | 'retained';
  repairOf?: string; changedPaths: string[]; sourceFiles?: Record<string, string>;
  reviewEvaluationId?: string;
  /** Explicit authority proof that this candidate's bounded evaluation read is complete. */
  evaluationReadComplete?: boolean;
}
export interface Job {
  id: string; name: string; required: boolean; checkerClass: 'external-behavioural';
  candidateId: string; evaluationInputDigest: string; input: Record<string, unknown>;
  status: string; evidenceId?: string;
  runtime?: { pid: number; startedAt: string; deadline: string; terminationObserved: boolean };
}
export interface Evaluation {
  id: string; candidateId: string; contract: 'freshness-v1' | 'retained-value-v1';
  /** Diagnostic lifecycle records never supply acceptance evidence. Legacy rows are acceptance plans. */
  purpose?: 'diagnostic';
  planDigest: string; jobs: Job[]; aggregation: 'all-required-pass'; status: string;
  outcome?: Outcome; createdAt: string; completedAt?: string;
}
export interface Observation {
  step?: number; action: string; expected?: number; expectedOneOf?: number[]; observed?: number; status: number;
  responseDigest: string; body?: string; storeReadCount?: number;
}
export interface Evidence {
  id: string; candidateId: string; evaluationId: string; jobId: string;
  evaluationInputDigest: string; checkerClass: 'external-behavioural'; checkerId: string;
  environmentDigest: string; fixtureDigest: string; outcome: Outcome;
  observations: Observation[]; diagnostics?: unknown[]; storeReadCount?: number; startedAt: string; completedAt: string;
  digest: string; envelope: unknown; limitations: string[]; error?: string;
  observationDigest: string;
  runtimeObservation?: { candidateProcessId: number; candidateOrigin: string; fixtureOrigin: string; terminationObserved: boolean };
}
export interface Conflict {
  id: string; category: 'behavioural-interaction' | 'mechanical-overlap'; candidateId?: string;
  attemptIds: string[]; status: string; summary: string; evidenceIds: string[];
  witness?: { rows: { name: string; candidateId: string; evidenceId: string; outcome: Outcome }[]; contrast: number; scope: string };
  counterexample?: Observation[]; reproducer?: string[]; repairAttemptId?: string;
  repairCandidateId?: string; reduction?: unknown;
}
export interface Capsule {
  id: string; attemptId: string; digest: string; sourceCommit: string; sourceManifestDigest: string;
  goalRevision: string; adapter: string; generation: number; selectorVersion: string;
  sessionDigest: string; renderedContextDigest: string; selectedItems: unknown[];
  sessionFormat?: string; sessionId?: string; selectedSessionEntry?: string | null;
  missingTail: boolean; limitations: string[];
}
export interface Review {
  id: string; candidateId: string; proposalDigest: string; expectedHead: string;
  goalRevision: string; policyRevision: string; planDigest: string; evidenceIds: string[];
  observationRevision: number; expiresAt: string; status: string; approval?: { principal: string; approvedAt: string; consumedBy?: string };
  protocolProposal?: unknown;
}
export interface Publication {
  id: string; candidateId: string; proposalDigest: string; oldHead: string; newHead: string;
  status: string; admittedAt: string; dispatchedAt?: string; confirmedAt?: string;
  dispatchCount: number; receiptId?: string; recoveryReason?: string; admissionWitness: unknown;
}
export interface Receipt { id: string; sequence: number; candidateId: string; publicationId: string; digest: string; logical: Record<string, unknown>; envelope: unknown; createdAt: string; }
export interface Command { id: string; principal: string; digest: string; operation: string; result: unknown; }
/** Exact internal admission units, not measured model usage or provider currency. */
export interface ProjectReservationBudget {
  maximumUnits: string; reservedUnits: string; settledUnits: string; availableUnits: string;
  repairReservationUnits: string; policyCapUnits: string;
}
export interface PlatformState {
  /** Display cache hints. They do not authorize commands or replace revision checks. */
  viewToken?: string;
  viewCursor?: import('../workers/shared/view-cursor').ViewCursor;
  session?: { principalId: string; credentialClass: 'human' | 'agent' | 'service'; permissions?: { review: boolean; sponsor: boolean; manage: boolean; export: boolean } };
  schemaVersion: 1; projectId: string; projectIncarnation: string; tenantId: string;
  revision: number; observationRevision: number; acceptedHead: string; enrollmentDigest: string;
  goal: { id: string; revision: string; title: string; description: string; constraints: string[]; contracts: string[]; budget: { maxAttempts?: number; authoringSeconds: number; evaluationSeconds: number } };
  attempts: Attempt[]; candidates: Candidate[]; evaluations: Evaluation[]; evidence: Evidence[];
  conflicts: Conflict[]; capsules: Capsule[]; reviews: Review[]; publications: Publication[];
  receipts: Receipt[]; commands: Command[]; events: Event[];
  activeCandidateId?: string; demoStatus: string; demoMode?: AgentMode; error?: string;
  admission?: { gate: 'OPEN' | 'CLOSED' | 'RECOVERY'; reason?: string };
  projectBudget?: ProjectReservationBudget;
  capabilities: { scripted: boolean; pi: boolean; piReason?: string; publication: boolean; deployment: boolean; maintenance?: boolean };
  limitations: string[]; gates: { name: string; status: string; detail: string }[];
}
