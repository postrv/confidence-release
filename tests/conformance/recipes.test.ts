import assert from 'node:assert/strict';
import test from 'node:test';
import { digest } from '../../packages/protocol/src/index.ts';
import { evaluationInput, FULL_RELEASE_JOB_COUNT, makeEvaluationPlan, probes } from '../../workers/evaluator/recipes.ts';

test('protected recipe identity binds scope, candidate, checker, image and full required probe set', async () => {
  const scope = { schemaVersion: 1 as const, tenantId: 'tenant', projectId: 'project', projectIncarnation: 'generation-1' };
  const candidate = { id: 'candidate', digest: 'sha256:' + 'a'.repeat(64), commit: 'b'.repeat(40), commitBytesDigest: 'sha256:' + 'b'.repeat(64), parent: 'c'.repeat(40), manifestDigest: 'sha256:' + 'd'.repeat(64) };
  const image = 'sha256:' + 'e'.repeat(64), checker = 'sha256:' + 'f'.repeat(64);
  const evaluation = { schemaVersion: 1 as const, id: 'evaluation-1', goalRevision: '1', policyRevision: '1', contractBundleDigest: 'sha256:' + '1'.repeat(64) };
  const plan = await makeEvaluationPlan(candidate, image, checker, 'full', scope, evaluation);
  const { digest: identity, ...payload } = plan;
  assert.equal(identity, await digest(payload));
  assert.equal(plan.jobs.length, probes.length);
  assert.equal(plan.jobs.length, FULL_RELEASE_JOB_COUNT); assert.equal(FULL_RELEASE_JOB_COUNT, 9);
  assert.deepEqual(probes.slice(0, 8).map(probe => probe.id), ['warm-read-write-read', 'repeated-reads', 'successive-writes', 'cold-write', 'retained-cache-benefit', 'accessible-value', 'audit-write-burst', 'audit-alternating-pages']);
  assert.equal(probes[8].id, 'overlapping-read-write'); assert.equal(probes[8].audit, false);
  const overlap = await evaluationInput(candidate, probes[8], image, checker, scope, evaluation);
  assert.deepEqual(overlap.overlap?.order, ['arm-one-get', 'capture-old-value', 'acknowledge-candidate-put', 'release-old-get', 'complete-old-read', 'fresh-candidate-get']);
  assert.notEqual(await digest(overlap), await digest({ ...overlap, overlap: { ...overlap.overlap, maximumBarrierMs: 11000 } }));
  assert.deepEqual(overlap.overlap?.completedReadValues, [overlap.values.initial, overlap.values.replacement]);
  assert.notEqual(await digest(overlap), await digest({ ...overlap, overlap: { ...overlap.overlap, completedReadValues: [overlap.values.initial] } }));
  assert.deepEqual(overlap.overlap?.storeTrace, { prefix: ['GET(initial)', 'PUT(replacement)'], suffix: 'GET(replacement)-only', maximumAccesses: 128, readsMatchTrace: true });
  for (const probe of probes.slice(0, 8)) assert.equal(Object.hasOwn(await evaluationInput(candidate, probe, image, checker, scope, evaluation), 'overlap'), false);
  assert.ok(plan.jobs.every(job => job.required && job.evidenceClass === 'protected-behavioural'));
  const otherIncarnation = await makeEvaluationPlan(candidate, image, checker, 'full', { ...scope, projectIncarnation: 'generation-2' }, evaluation);
  assert.ok(plan.jobs.every((job, i) => job.inputDigest !== otherIncarnation.jobs[i].inputDigest));
  const otherImage = await makeEvaluationPlan(candidate, checker, checker, 'full', scope, evaluation);
  assert.notEqual(plan.digest, otherImage.digest);
  const rerun = await makeEvaluationPlan(candidate, image, checker, 'full', scope, { ...evaluation, id: 'evaluation-2' });
  assert.notEqual(rerun.digest, plan.digest);
  assert.ok(rerun.jobs.every((job, i) => job.id !== plan.jobs[i].id && job.inputDigest === plan.jobs[i].inputDigest));
  for (const change of [{ goalRevision: '2' }, { policyRevision: '2' }, { contractBundleDigest: 'sha256:' + '2'.repeat(64) }]) {
    const revised = await makeEvaluationPlan(candidate, image, checker, 'full', scope, { ...evaluation, ...change });
    assert.ok(revised.jobs.every((job, i) => job.inputDigest !== plan.jobs[i].inputDigest));
  }
  assert.equal((await makeEvaluationPlan(candidate, image, checker, 'freshness', scope, evaluation)).jobs.length, 1);
  await assert.rejects(makeEvaluationPlan(candidate, 'UNCONFIGURED', checker, 'full', scope, evaluation), /DIGESTS_REQUIRED/);
});
