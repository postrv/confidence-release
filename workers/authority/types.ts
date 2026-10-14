// SPDX-License-Identifier: Apache-2.0
import type { ModelCallOutcome } from '../shared/model-call';
import type { AdmissionCandidate, AdmissionEvidence, AdmissionInput, AdmissionState, Envelope, EvaluationPlan, LogicalReceipt, PublicationPhase, ReviewProposal, Scope, SourceManifest, IssuanceContext } from "../../packages/protocol/src/types";
import type { Principal } from "../shared/auth";
import type { RepositorySnapshot } from "./artifacts";
import type { EvaluationContext } from "../evaluator/recipes";
import type { CleanupRecord } from "./cleanup";
import type { WeftEnvironment } from "./weft-bridge";
export type { EvaluationContext } from "../evaluator/recipes";

export interface ProjectRecord {
  scope: Scope; revision: string; head: string; gate: AdmissionState["gate"];
  policyRevision: string; goalRevision: string; observationRevision: string; publicationSequence: string;
  unresolvedPublicationId: string | null; canonicalRepo: string; canonicalRef: string;
  keysetRevision?: string; enrollmentDigest: string; enrollment: Envelope; previousReceiptDigest: string | null;
  maximumBudget: string; reservedBudget: string; settledBudget: string;
}
export interface GrantRecord {
  id: string; subject: string; attemptId: string; generation: string;
  operations: string[]; pathPrefixes: string[]; resources: string[]; destinations: string[];
  maximumBudget: string; expiresAt: number; authorityGeneration: string;
}
export interface AttemptRecord {
  id: string; grantId: string; subject: string; generation: string; repoName: string;
  workBase: string; publicationBase: string; deadline: number; state: string;
  goalRevision: string; recipe: string; remote?: string; source?: RepositorySnapshot;
  assignment?: string; allowedPaths?: string[]; readOnlyContextPaths?: string[];
  contextReference?: { capsuleId: string; capsuleDigest: string; sessionDigest: string; sessionEntry: string; sessionId: string };
}
export interface CandidateRecord extends AdmissionCandidate {
  scope: Scope; source: RepositorySnapshot; contributorIds: string[]; recipe: string[];
}
export interface PreparedPublicationDescriptor {
  admission: Envelope; operationId: string; scope: Scope; enrollmentDigest: string; sequence: string;
  predecessorReceiptDigest: string | null; authorityRevision: string; oldHead: string; newHead: string;
  candidateDigest: string; objectsDigest: string; manifestDigest: string; proposalDigest: string; witnessDigest: string;
}
export interface PublicationRecord {
  id: string; sequence: string; phase: PublicationPhase; oldHead: string; newHead: string;
  candidateId: string; proposalDigest: string; witness: AdmissionInput; witnessDigest: string;
  admission?: Envelope; preparedDescriptor?: PreparedPublicationDescriptor; preparedDigest?: string; dispatchMayHaveOccurred: boolean; dispatchAttemptIds: string[];
  observationTime?: number; logical?: LogicalReceipt; logicalDigest?: string; envelope?: Envelope; envelopeDigest?: string;
  reason?: string;
}
export interface AuthorityCommand { commandId: string; expectedRevision: string; expectedIncarnation?: string; operation: string; body: Record<string, unknown> }
export interface TrustedCaller { principal: Principal; projectId: string }
export interface ProjectionEvent { id: string; scope: Scope; sequence: number; digest: string; kind: string; objectId: string; payload: unknown; time?: string }
export interface ContextCapsuleInput {
  id: string; stage: "rendered" | "session"; renderedContextDigest: string; diagnosticDigest: string | null;
  sourceAdvisoryDigest?: string | null;
  partialSessionDigest?: string | null;
  sourceCommit: string; sourceManifestDigest: string;
  sessionDigest: string | null; sessionFormat: "pi-sdk-1.0.2-session-entries-v1" | null;
  sessionId: string | null; selectedEntry: string | null; missingSessionTail: boolean;
  sessionReadError: string | null;
}
export interface ContextCapsuleRecord extends ContextCapsuleInput {
  digest: string; scope: Scope; attemptId: string; sourceCommit: string; sourceManifestDigest: string;
  goalRevision: string; adapter: string; generation: string; selectorVersion: string;
  selectedItems: unknown[]; producer: "controller-observed";
  sessionTrustClass: "agent-reported-session"; sourceSessionAtomicity: "NOT_ATOMIC";
}
export interface AttemptProposal {
  id: string; digest: string; scope: Scope; attemptId: string; generation: string; subject: string;
  grantId: string; goalRevision: string; policyRevision: string; publicationBase: string; kind: "repair" | "selection";
  rationale: string; candidateId: string | null; candidateDigest: string | null;
  submissionIds: string[]; sourceDigests: string[];
}
export interface ModelCallReservation {
  callId: string; attemptId: string; generation: string; requestDigest: string;
  maximumCost: string; state: string;
  /** Broker facts are independently checked; reservation state remains unchanged. */
  outcome?: ModelCallOutcome;
}
export interface AuthorityRead {
  /** Exact current/selected closure, independent of the bounded history arrays. */
  candidateRead?: { currentId: string | null; selectedId: string | null; candidateIds: string[]; incompleteIds: string[]; retainedFailureIds: string[]; planLimit: number; evidenceLimit: number; observationLimit: number; events: { sequence: number; payload: string }[] };
  project: ProjectRecord; attempts: AttemptRecord[]; candidates: CandidateRecord[]; plans: EvaluationPlan[];
  /** Advisory UI capabilities; each command still checks current authority state. */
  callerPermissions?: { review: boolean; sponsor: boolean; manage: boolean; export: boolean };
  cleanups: CleanupRecord[];
  proposals: AttemptProposal[];
  evaluations: (EvaluationContext & { planDigest: string; authorityRevision: string; eligible: boolean })[];
  reviews: { id: string; proposal: ReviewProposal }[]; publications: PublicationRecord[]; receipts: unknown[];
  evidence: unknown[]; sequence: number;
  submissions: { id: string; attemptId: string; source: RepositorySnapshot }[];
  /** Present only for an explicit protected roster read; complete only when overflow is false. Reservation ceilings are not provider spend. */
  modelCalls?: { limit: number; overflow: boolean; reservations: ModelCallReservation[] };
  runtime: { attemptId: string; generation: string; lifecycle: string; outcome: string; sourceCommit?: string }[];
  approvals: { proposal_digest: string; reviewer: string; expires_at: number; consumed_by: string | null }[];
  events: { sequence: number; payload: string }[];
  observations: Record<string, Record<string, unknown>>;
  sourceFiles: Record<string, Record<string, string>>;
  sourceManifests: Record<string, SourceManifest>;
  capsules: ContextCapsuleRecord[];
  baseline: RepositorySnapshot;
  evaluationIds: Record<string, string>;
}

export interface AuthorityEnv extends AuthorityBindings, WeftEnvironment {
  PROJECT_HUB_ENABLED?: string;
  ARTIFACTS: Artifacts;
  OBJECTS: R2Bucket;
  EVENTS: Queue<ProjectionEvent>;
  RUNNER: Fetcher;
  EVALUATOR: Fetcher;
  AUTHORITY_SIGNING_KEY: string;
  AUTHORITY_KEY_ID: string;
  ROOT_SIGNING_KEY: string;
  ROOT_KEY_ID: string;
  CHECKER_PUBLIC_KEY: string;
  CHECKER_KEY_ID: string;
  EVALUATION_IMAGE_DIGEST: string;
  ARTIFACTS_GIT_HOST: string;
  CHECKER_IMPLEMENTATION_DIGEST: string;
  BOOTSTRAP_SUBJECTS: string;
  AUTH_TENANT_ID: string;
  MAINTENANCE_MODE: string;
  CONDITIONAL_PUBLICATION_VERIFIED: string;
  APP_SERVICE_TOKEN: string;
  RUNNER_SERVICE_TOKEN: string;
  EVALUATOR_SERVICE_TOKEN: string;
  PROJECTOR_SERVICE_TOKEN: string;
}

export interface EvaluationRequest {
  scope: Scope;
  issuance?: IssuanceContext;
  checkerKeyId?: string;
  evaluation: EvaluationContext;
  plan: EvaluationPlan;
  candidate: AdmissionCandidate;
  source: RepositorySnapshot;
  job: EvaluationPlan["jobs"][number];
}
export interface EvaluationCallback {
  scope: Scope;
  evidence: AdmissionEvidence;
  envelope: Envelope;
  observationBase64: string;
}
