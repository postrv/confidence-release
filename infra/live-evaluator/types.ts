// SPDX-License-Identifier: Apache-2.0
import type { AdmissionCandidate, AdmissionEvidence, Envelope, GitObject, Scope, SourceManifest } from '../../packages/protocol/src/types';
export type FixtureName = 'good' | 'bad';
export type Phase = 'NOT_DISPATCHED' | 'MAY_HAVE_DISPATCHED' | 'ACKNOWLEDGED' | 'UNKNOWN';
export interface SourcePackage { schemaVersion: 1; name: FixtureName; candidate: AdmissionCandidate; manifest: SourceManifest; objects: GitObject[] }
export interface PreparedRun {
  schemaVersion: 1; runId: string; scope: Scope; createdAt: string;
  names: { evaluator: string; controller: string; container: string; bucket: string };
  sourceDigests: Record<string, string>; fixtureDigests: Record<FixtureName, string>;
  sourceRevision: string | null; sourceDirty: boolean | null;
}
export interface NativeSnapshot {
  jobKey: string; jobId: string | null; requestDigest: string | null; phase: string;
  deadline: number | null; terminationObserved: boolean; callbackDelivered: boolean;
  callbackDigest: string | null; abortIntent: boolean;
  controllerInstanceId: string; abortRequest: AbortRequest | null;
  container: { image: string; labels: Record<string, string> } | null;
  configuredImage: string; observedAt: string;
}
export interface AbortRequest { controllerInstanceId: string; jobId: string; jobKey: string; requestDigest: string; phase: 'RUNNING'; deadline: number; observedAt: number }
export interface RejectedCallbackWitness {
  schemaVersion: 1; runId: string; jobKey: string; jobId: string; requestDigest: string;
  sourceDigest: string; candidateDigest: string; inputDigest: string;
  callbackDigest: string; evidenceDigest: string; observationDigest: string;
  responseStatus: 503; deliveryNumber: 1; captureStartedAt: string; capturedAt: string;
  native: NativeSnapshot;
  scheduler: { digest: string; object: string; status: 'ACTIVE'; priority: number };
}
export interface CallbackRecord { digest: string; envelope: Envelope; observationDigest: string; evidenceDigest: string; jobId: string; outcome: string; deliveries: number; rejectedOnce: boolean; rejectionWitness: RejectedCallbackWitness | null }
export interface RetainedCallback { scope: Scope; evidence: AdmissionEvidence; envelope: Envelope; observationBase64: string }
export interface RunJournal {
  schemaVersion: 1; prepared: PreparedRun; accountId: string;
  createBucket: Phase; bootstrapController: Phase; deployEvaluator: Phase; deployController: Phase;
  seedGood: Phase; seedBad: Phase; dispatch: Phase; faults: Phase;
  image: string | null; evaluatorVersion: string | null; controllerVersion: string | null;
  configDigests: Record<string, string>; expiresAt: number | null; endpoint: string | null;
  unresolvedResources: string[]; cleanup: Record<string, Phase>;
}
