import { FULL_RELEASE_JOB_COUNT } from '../../workers/evaluator/recipes.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalPlatform } from '../../services/platform.ts';
import { auditProbes, publicProbes } from '../../services/probes.ts';
import { canonical, hashBytes } from '../../services/crypto.ts';

test('actual public PASS and both audit FAIL retain server evidence while excluding audit artifacts from repair capsule and rendered prompt', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-audit-disclosure-'));
  const platform = new LocalPlatform(directory); await platform.initialize();
  try {
    const base = platform.state.acceptedHead, files = await platform.git.files(base);
    files['cache.mjs'] = Buffer.from(files['cache.mjs'].toString().replace('cacheTtlMs = 0', 'cacheTtlMs = 60000'));
    // Owned negative control: incorrect presentation before a write or after a
    // write burst. No audit names, seeds or values appear in candidate source.
    files['presentation.mjs'] = Buffer.from('let pendingWrites = 0;\nexport function noteWrite() { pendingWrites++; }\nexport function renderStatus(value) {\n  const displayed = pendingWrites === 1 ? value : value - 1; pendingWrites = 0;\n  return `<!doctype html><html><body><main><p role="status" aria-live="polite" aria-label="Saved value">Saved value: ${displayed}</p></main></body></html>`;\n}\n');
    files['mutation.mjs'] = Buffer.from("import { invalidate } from './cache.mjs';\nimport { noteWrite } from './presentation.mjs';\nexport async function writeValue(value, writeStore) {\n  await writeStore(value); noteWrite(); invalidate(); return value;\n}\n");
    const commit = await platform.git.createCommit(files, base, 'Owned audit-only negative control');
    const candidate = await (platform as any).freezeCandidate('Owned audit-only negative control', commit, [], [], base);
    const evaluation = await platform.evaluate(candidate, 'retained-value-v1');
    assert.equal(evaluation.jobs.length, FULL_RELEASE_JOB_COUNT); assert.equal(candidate.outcome, 'FAIL');
    for (const probe of publicProbes) assert.equal(evaluation.jobs.find(job => job.name === probe.name)!.status, 'PASS', probe.name);
    const withheld = auditProbes.map(probe => {
      const job = evaluation.jobs.find(item => item.name === probe.name)!; assert.equal(job.status, 'FAIL', probe.name);
      const evidence = platform.state.evidence.find(item => item.id === job.evidenceId)!;
      assert.ok(evidence.observations.some(item => item.action === 'page' && item.expected !== item.observed));
      assert.ok(job.runtime?.terminationObserved);
      return evidence;
    });
    const conflict = (platform as any).failureConflict(candidate, []);
    // Evaluation workers retain evidence in completion order, which can differ
    // from the registered audit-probe order under concurrent execution.
    assert.deepEqual([...conflict.evidenceIds].sort(), withheld.map(evidence => evidence.id).sort());
    assert.equal(conflict.counterexample, undefined); assert.equal(conflict.reproducer, undefined);
    assert.match(conflict.summary, /withheld from repair; release remains blocked/);
    await assert.rejects(platform.review({ candidateId: candidate.id }), /NOT_PASSED/);
    // Simulate a persisted conflict produced by an older controller. The repair
    // selector must independently recheck policy instead of trusting its fields.
    conflict.counterexample = withheld.flatMap(evidence => evidence.observations);
    conflict.reproducer = auditProbes.flatMap(probe => probe.actions);
    conflict.witness = { rows: withheld.map(evidence => ({ name: 'legacy-audit', candidateId: candidate.id, evidenceId: evidence.id, outcome: evidence.outcome })), contrast: 1, scope: 'legacy audit details' };
    platform.state.conflicts.push(conflict); await platform.save();
    let actualRendered = '';
    const context = (platform as any).authoringContext.bind(platform);
    (platform as any).authoringContext = (...arguments_: unknown[]) => { const result = context(...arguments_); actualRendered = result.rendered; return result; };
    await platform.repair({ conflictId: conflict.id, commandId: 'owned-audit-only-repair' }); await platform.waitForIdle();
    const attempt = platform.state.attempts.find(item => item.id === conflict.repairAttemptId)!;
    assert.equal(attempt.status, 'SUBMITTED');
    const capsule = platform.state.capsules.find(item => item.id === attempt.capsuleId)!;
    assert.equal(capsule.selectorVersion, 'protected-repair-disclosure-v2');
    assert.equal(capsule.renderedContextDigest, hashBytes(actualRendered));
    assert.ok(capsule.selectedItems.some((item: any) => item.kind === 'withheld-observation'));
    assert.ok(!capsule.selectedItems.some((item: any) => item.kind === 'counterexample'));
    const capsuleBytes = await readFile(join(directory, 'capsules', capsule.id + '.json'), 'utf8');
    for (const evidence of withheld) {
      // Check actual complete trace/body and its attribution, not only job names.
      for (const artifact of [canonical(evidence.observations), evidence.id, evidence.jobId, evidence.fixtureDigest, evidence.observationDigest]) {
        assert.ok(!actualRendered.includes(artifact), `Prompt disclosed ${artifact.slice(0, 80)}`);
        assert.ok(!capsuleBytes.includes(artifact), `Capsule disclosed ${artifact.slice(0, 80)}`);
      }
      for (const observation of evidence.observations) {
        for (const [field, value] of Object.entries(observation).filter(([key]) => ['expected', 'observed', 'body'].includes(key))) {
          const encoded = JSON.stringify(field) + ':' + JSON.stringify(value);
          assert.ok(!actualRendered.includes(encoded), `Prompt disclosed actual audit ${field}`);
          assert.ok(!capsuleBytes.includes(encoded), `Capsule disclosed actual audit ${field}`);
        }
      }
    }
    for (const probe of auditProbes) for (const artifact of [probe.name, `"seed":${probe.seed}`, canonical(probe)]) {
      assert.ok(!actualRendered.includes(artifact)); assert.ok(!capsuleBytes.includes(artifact));
    }
    const repaired = platform.state.candidates.find(item => item.id === conflict.repairCandidateId)!;
    assert.equal(repaired.outcome, 'FAIL', 'A scripted no-op repair does not turn hidden failures into acceptance');
    assert.equal(conflict.status, 'REPAIR_FAILED'); await assert.rejects(platform.review({ candidateId: repaired.id }), /NOT_PASSED/);
    for (const evidence of withheld) {
      assert.ok(platform.state.evidence.some(item => item.id === evidence.id));
      const retained = JSON.parse(await readFile(join(directory, 'objects', evidence.observationDigest.slice(7) + '.json'), 'utf8'));
      assert.deepEqual(retained.observations, evidence.observations, 'Actual audit evidence remains durable for authority/release decisions');
    }
  } finally { await platform.shutdown(); await rm(directory, { recursive: true, force: true }); }
});
