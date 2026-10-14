// SPDX-License-Identifier: Apache-2.0
import { digest, type Scope, type IssuanceContext, type EvaluationPlan, type AdmissionCandidate, type GitObject, type SourceManifest } from '../../packages/protocol/src/index';
import { FULL_RELEASE_JOB_COUNT, makeEvaluationPlan, type EvaluationContext } from '../../workers/evaluator/recipes';
import type { SourcePackage } from './types';
export const OWNED_JOB_COUNT = FULL_RELEASE_JOB_COUNT * 2 + 2;
export type Category = 'good' | 'bad' | 'callback-fault' | 'restart-fault';
// Exact wire shape, kept free of Worker ambient bindings for the native Node client.
export interface EvaluationRequest { scope: Scope; issuance?: IssuanceContext; checkerKeyId?: string; evaluation: EvaluationContext; plan: EvaluationPlan; candidate: AdmissionCandidate; job: EvaluationPlan['jobs'][number]; source: { commit: string; commitBytesDigest: string; parent: string | null; manifest: SourceManifest; manifestDigest: string; objects: GitObject[]; objectsDigest: string } }
export const runScope = (runId: string): Scope => ({ schemaVersion: 1, tenantId: 'owned-evaluator-conformance', projectId: `evaluator-${runId.replaceAll('-', '').slice(0, 20)}`, projectIncarnation: runId });
export async function requests(sources: { good: SourcePackage; bad: SourcePackage }, config: { runId: string; imageDigest: string; checkerDigest: string; checkerKeyId: string }) {
  const tasks: { request: EvaluationRequest; requestDigest: string; jobKey: string; category: Category }[] = [];
  for (const category of ['good', 'bad', 'callback-fault', 'restart-fault'] as const) {
    const source = sources[category === 'bad' ? 'bad' : 'good'], scope = runScope(config.runId);
    const evaluation = { schemaVersion: 1 as const, id: `${config.runId.replaceAll('-', '')}_${category.replaceAll('-', '_')}`, goalRevision: '1', policyRevision: '1', contractBundleDigest: await digest({ contract: 'latest-acknowledged-value-and-retained-benefit-v1', scope, conformance: 'good-nine-bad-nine-plus-two-faults-v2' }) };
    const plan = await makeEvaluationPlan(source.candidate, config.imageDigest, config.checkerDigest, category.endsWith('fault') ? 'freshness' : 'full', scope, evaluation);
    for (const job of plan.jobs) {
      const request: EvaluationRequest = { scope, evaluation, plan, candidate: source.candidate, job, checkerKeyId: config.checkerKeyId, issuance: { schemaVersion: 1, scope, signerKeysetRevision: '1', authorityRevision: '1' },
        source: { commit: source.candidate.commit, commitBytesDigest: source.candidate.commitBytesDigest, parent: null, manifest: source.manifest, manifestDigest: source.candidate.manifestDigest, objects: [], objectsDigest: await digest(source.objects) } };
      tasks.push({ request, requestDigest: await digest(request), jobKey: (await digest({ scope, jobId: job.id })).slice(7), category });
    }
  }
  if (tasks.length !== OWNED_JOB_COUNT) throw new Error('OWNED_PLAN_BOUND'); return tasks;
}
