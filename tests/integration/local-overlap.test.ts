import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalPlatform } from '../../services/platform.ts';
import { FULL_RELEASE_JOB_COUNT } from '../../workers/evaluator/recipes.ts';
import { fullReleaseProbes, isCurrentFullReleasePlan } from '../../services/probes.ts';
import type { Candidate } from '../../services/types.ts';

const originalCases = ['warm-read-write-read', 'repeated-reads', 'successive-writes', 'cold-write-then-warm-write', 'retained-cache-benefit', 'accessible-saved-value', 'audit-write-burst', 'audit-alternating-pages'];

test('the ninth real HTTP case retains its barrier proof and separates stale refills from guarded and retrying caches', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-local-overlap-'));
  const platform = new LocalPlatform(directory); await platform.initialize();
  try {
    assert.equal(fullReleaseProbes.length, FULL_RELEASE_JOB_COUNT);
    assert.deepEqual(fullReleaseProbes.slice(0, 8).map(probe => probe.name), originalCases);
    const base = platform.state.acceptedHead, baseline = await platform.git.files(base);
    assert.match(baseline['cache.mjs'].toString(), /cacheTtlMs = 0/);
    const cache = baseline['cache.mjs'].toString().replace('cacheTtlMs = 0', 'cacheTtlMs = 60000');
    const unguarded = cache.replace('let cacheGeneration = {};\n', '').replace('  const generation = cacheGeneration;\n', '').replace(' && generation === cacheGeneration', '').replace('cacheGeneration = {}; ', '');
    const retrying = cache.replace('  const value = await readStore();', '  const value = await readStore();\n  if (generation !== cacheGeneration) return readValue(readStore);');
    const results: { candidate: Candidate; expected: string }[] = [];
    for (const [name, source, expected] of [['unguarded', unguarded, 'FAIL'], ['guarded', cache, 'PASS'], ['retrying', retrying, 'PASS']] as const) {
      const files = { ...baseline, 'cache.mjs': Buffer.from(source), 'presentation.mjs': Buffer.from('export function renderStatus(value) { return `<p role="status" aria-live="polite" aria-label="Saved value">Saved value: ${value}</p>`; }\n') };
      const commit = await platform.git.createCommit(files, base, `Owned overlap ${name}`);
      const candidate: Candidate = await (platform as any).freezeCandidate(name, commit, [], [], base);
      const evaluation = await platform.evaluate(candidate, 'retained-value-v1');
      results.push({ candidate, expected });
      assert.equal(evaluation.jobs.length, FULL_RELEASE_JOB_COUNT);
      assert.deepEqual(evaluation.jobs.slice(0, 8).map(job => job.name), originalCases);
      assert.ok(evaluation.jobs.slice(0, 8).every(job => job.status === 'PASS'));
      assert.equal(evaluation.outcome, expected);
      const job = evaluation.jobs.at(-1)!; assert.equal(job.name, 'overlapping-read-write');
      const evidence = platform.state.evidence.find(item => item.id === job.evidenceId)!;
      assert.equal(evidence.outcome, expected); assert.equal(evidence.runtimeObservation?.terminationObserved, true);
      assert.deepEqual(evidence.observations.map(row => row.action), ['write', 'overlap-read', 'read']);
      assert.ok(evidence.observations.every(row => row.status === 200));
      const ordering = evidence.diagnostics?.[0] as { kind: string; events: any[] };
      assert.equal(ordering.kind, 'overlapping-read-write-ordering');
      assert.deepEqual(ordering.events.map(row => row.action), ['overlap-captured', 'write', 'overlap-released', 'overlap-read', 'read']);
      assert.equal(ordering.events[0].observed, ordering.events[0].expected);
      assert.equal(ordering.events[2].afterWriteStatus, 200);
      const store = evidence.diagnostics?.[1] as { value: number; reads: number; accesses: { method: string; value: number }[] };
      assert.equal(store.value, ordering.events[1].observed);
      assert.deepEqual(store.accesses.slice(0, 2).map(row => row.method), ['GET', 'PUT']);
      assert.equal(store.reads, store.accesses.length - 1);
      assert.equal(ordering.events[4].observed === ordering.events[4].expected, expected === 'PASS');
      if (name === 'retrying') {
        assert.equal(ordering.events[3].observed, ordering.events[4].observed);
        assert.equal(evidence.observations[1].expected, undefined, 'a safe retry has no false expected-initial mismatch');
      }
      const retained = JSON.parse(await readFile(join(directory, 'objects', evidence.observationDigest.slice(7) + '.json'), 'utf8'));
      assert.deepEqual(retained.diagnostics, evidence.diagnostics);
    }
    assert.deepEqual((await platform.git.files(base))['cache.mjs'], baseline['cache.mjs']);
    assert.equal(platform.state.evidence.filter(item => item.candidateId === results[0]!.candidate.id).length, FULL_RELEASE_JOB_COUNT);
    await assert.rejects(platform.review({ candidateId: results[0]!.candidate.id }), /NOT_PASSED/);
    for (const result of results.slice(1)) assert.equal((await platform.review({ candidateId: result.candidate.id })).evidenceIds.length, FULL_RELEASE_JOB_COUNT);
  } finally { await platform.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('retained eight-case plans stay visible but cannot prepare, approve or publish the current release', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-local-profile-'));
  const platform = new LocalPlatform(directory); await platform.initialize();
  try {
    const base = platform.state.acceptedHead, files = await platform.git.files(base);
    files['cache.mjs'] = Buffer.from(files['cache.mjs'].toString().replace('cacheTtlMs = 0', 'cacheTtlMs = 60000'));
    files['presentation.mjs'] = Buffer.from('export function renderStatus(value) { return `<p role="status" aria-live="polite" aria-label="Saved value">Saved value: ${value}</p>`; }\n');
    const candidate: Candidate = await (platform as any).freezeCandidate('Owned profile history', await platform.git.createCommit(files, base, 'Owned profile history'), [], [], base);
    const evaluation = await platform.evaluate(candidate, 'retained-value-v1');
    const review = await platform.review({ candidateId: candidate.id });
    assert.equal(isCurrentFullReleasePlan(evaluation), true);
    // Test-only retained history representing a review created under the old profile.
    evaluation.jobs = evaluation.jobs.slice(0, 8);
    assert.equal(isCurrentFullReleasePlan(evaluation), false);
    const evidenceBefore = platform.state.evidence.length;
    await assert.rejects(platform.review({ candidateId: candidate.id }), /NOT_PASSED/);
    await assert.rejects(platform.approve({ proposalDigest: review.proposalDigest }), /REVIEW_PROFILE_STALE/);
    review.approval = { principal: 'local-sponsor', approvedAt: new Date().toISOString() };
    await assert.rejects(platform.publish({ proposalDigest: review.proposalDigest }), /REVIEW_PROFILE_STALE/);
    assert.equal(platform.state.evidence.length, evidenceBefore); assert.equal(platform.state.publications.length, 0);
    assert.equal(await platform.git.remoteHead(), base);
  } finally { await platform.shutdown(); await rm(directory, { recursive: true, force: true }); }
});
