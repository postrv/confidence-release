// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { ExternalEvaluator } from '../../services/evaluator.ts';
import type { GitStore } from '../../services/git.ts';
import type { Candidate } from '../../services/types.ts';
import type { AdmissionCandidate } from '../../packages/protocol/src/types.ts';

/** Measured host-subprocess evidence. This is NOT deployed Container isolation. */
export async function measureLocalCandidate(git: GitStore, source: AdmissionCandidate, directory: string) {
  const candidate: Candidate = { ...source, name: source.id, manifest: await git.manifest(source.commit), publicationBase: source.parent,
    attemptIds: [], submissionIds: [], composition: ['owned-weft-selection'], status: 'FROZEN', evaluationIds: [], createdAt: new Date().toISOString(), changedPaths: [] };
  const evaluator = new ExternalEvaluator(git, join(directory, 'probe-workspaces'));
  const plan = await evaluator.plan(candidate, 'retained-value-v1');
  const observations = [];
  // One live candidate child at a time; each job owns a fresh store and process.
  for (const job of plan.jobs) observations.push(await evaluator.runJob(candidate, plan, job));
  return { plan, observations };
}
