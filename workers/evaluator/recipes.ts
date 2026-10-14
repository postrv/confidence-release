// SPDX-License-Identifier: Apache-2.0
import { digest, type AdmissionCandidate, type EvaluationPlan, type Scope } from '../../packages/protocol/src/index';

export interface EvaluationContext {
  schemaVersion: 1;
  id: string;
  goalRevision: string;
  policyRevision: string;
  contractBundleDigest: string;
}

export interface Probe {
  id: string; seed: number; actions: ('read' | 'write' | 'write-later' | 'page' | 'overlap')[];
  assertion: 'freshness' | 'cache-benefit' | 'presentation' | 'overlap-freshness'; audit: boolean;
}
export const FULL_RELEASE_JOB_COUNT = 9;
export const probes: Probe[] = [
  { id: 'warm-read-write-read', seed: 20261003, actions: ['read', 'write', 'read'], assertion: 'freshness', audit: false },
  { id: 'repeated-reads', seed: 20261004, actions: ['read', 'read', 'write', 'read', 'read'], assertion: 'freshness', audit: false },
  { id: 'successive-writes', seed: 20261005, actions: ['read', 'write', 'read', 'write-later', 'read'], assertion: 'freshness', audit: false },
  { id: 'cold-write', seed: 20261006, actions: ['write', 'read', 'write-later', 'read'], assertion: 'freshness', audit: false },
  { id: 'retained-cache-benefit', seed: 20261103, actions: ['read', 'read'], assertion: 'cache-benefit', audit: false },
  { id: 'accessible-value', seed: 20261104, actions: ['write', 'page', 'write-later', 'page'], assertion: 'presentation', audit: false },
  { id: 'audit-write-burst', seed: 831119, actions: ['read', 'write', 'write-later', 'read', 'page'], assertion: 'freshness', audit: true },
  { id: 'audit-alternating-pages', seed: 291877, actions: ['page', 'write', 'page', 'write-later', 'page'], assertion: 'presentation', audit: true },
  { id: 'overlapping-read-write', seed: 20261008, actions: ['overlap'], assertion: 'overlap-freshness', audit: false },
];
export function values(probe: Probe) {
  return { initial: 1000 + (probe.seed * 13) % 2000, replacement: 4000 + (probe.seed * 17) % 2000, later: 7000 + (probe.seed * 19) % 2000 };
}
export async function evaluationInput(candidate: AdmissionCandidate, probe: Probe, imageDigest: string, checkerDigest: string, scope: Scope, evaluation: EvaluationContext) {
  return {
    schemaVersion: 1, scope, candidateDigest: candidate.digest, commit: candidate.commit, commitBytesDigest: candidate.commitBytesDigest,
    sourceManifestDigest: candidate.manifestDigest, imageDigest, checkerDigest,
    goalRevision: evaluation.goalRevision, policyRevision: evaluation.policyRevision, contractBundleDigest: evaluation.contractBundleDigest,
    contract: 'latest-acknowledged-value-and-retained-benefit-v1', probe, values: values(probe),
    ...(probe.assertion === 'overlap-freshness' ? { overlap: { schemaVersion: 1, barrier: 'private-external-store-capture-before-write-v1',
      order: ['arm-one-get', 'capture-old-value', 'acknowledge-candidate-put', 'release-old-get', 'complete-old-read', 'fresh-candidate-get'],
      assertion: 'fresh-read-equals-acknowledged-write', completedReadValues: [values(probe).initial, values(probe).replacement],
      storeTrace: { prefix: ['GET(initial)', 'PUT(replacement)'], suffix: 'GET(replacement)-only', maximumAccesses: 128, readsMatchTrace: true },
      maximumBarrierMs: 10000, candidateControl: 'none' } } : {}),
    entrypoint: ['node', '/workspace/server.mjs'], dependencyProfile: 'node-builtins-only-v1',
    reset: 'fresh-container-and-external-store-per-job', deadlineSeconds: 30,
    responseBytes: 16384, outputBytes: 65536, network: 'fixture-internal-only',
  };
}
export async function makeEvaluationPlan(candidate: AdmissionCandidate, imageDigest: string, checkerDigest: string, contract: 'freshness' | 'full' = 'full', scope: Scope, evaluation: EvaluationContext): Promise<EvaluationPlan> {
  if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest) || !/^sha256:[0-9a-f]{64}$/.test(checkerDigest)) throw new Error('EVALUATOR_DEPLOYMENT_DIGESTS_REQUIRED');
  if (evaluation.schemaVersion !== 1 || !evaluation.id || !evaluation.goalRevision || !evaluation.policyRevision || !/^sha256:[0-9a-f]{64}$/.test(evaluation.contractBundleDigest)) throw new Error('INVALID_EVALUATION_CONTEXT');
  const jobs = await Promise.all((contract === 'freshness' ? probes.slice(0, 1) : probes).map(async probe => ({
    id: `${evaluation.id}:${probe.id}`, inputDigest: await digest(await evaluationInput(candidate, probe, imageDigest, checkerDigest, scope, evaluation)),
    required: true, evidenceClass: 'protected-behavioural' as const,
  })));
  const identity = { candidateId: candidate.id, candidateDigest: candidate.digest, jobs };
  return { digest: await digest(identity), ...identity };
}
export async function buildEvaluationPlan(scope: Scope, candidate: AdmissionCandidate, evaluation: EvaluationContext, env: { EVALUATION_IMAGE_DIGEST: string; CHECKER_IMPLEMENTATION_DIGEST: string }, contract: 'freshness' | 'full' = 'full'): Promise<EvaluationPlan> {
  if (scope.schemaVersion !== 1) throw new Error('INVALID_EVALUATION_SCOPE');
  return makeEvaluationPlan(candidate, env.EVALUATION_IMAGE_DIGEST, env.CHECKER_IMPLEMENTATION_DIGEST, contract, scope, evaluation);
}
