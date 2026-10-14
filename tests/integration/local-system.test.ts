import { FULL_RELEASE_JOB_COUNT } from '../../workers/evaluator/recipes.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { LocalPlatform } from '../../services/platform.ts';
import { verifyBundle } from '../../packages/protocol/src/index.ts';
import { startServer } from '../../services/server.ts';
import { boundedResponse } from '../../services/http-bounds.ts';

test('real concurrent Git/HTTP workflow retains value, reconciles a lost response and exports complete independently verifiable source', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-integration-'));
  let platform = new LocalPlatform(directory); await platform.initialize();
  try {
    // Leave room for an extra attempt so repair admission, rather than the budget,
    // must prevent concurrent commands from repairing the same conflict twice.
    platform.state.goal.budget.maxAttempts = 5;
    const initialHead = platform.state.acceptedHead;
    const launches = await Promise.all([platform.startDemo({ mode: 'scripted', autoSelect: false, commandId: 'same-launch' }), platform.startDemo({ mode: 'scripted', autoSelect: false, commandId: 'same-launch' })]);
    assert.deepEqual(launches[0], launches[1]); await platform.waitForIdle(); assert.equal(platform.state.attempts.length, 3);
    const attempts = platform.state.attempts;
    assert.ok(Math.max(...attempts.map(a => Date.parse(a.startedAt!))) < Math.min(...attempts.map(a => Date.parse(a.completedAt!))), 'All three authoring processes overlapped');
    assert.ok(attempts.every(a => a.terminationObserved && a.status === 'SUBMITTED' && a.capsuleId));
    await assert.rejects(platform.startDemo({ mode: 'pi', autoSelect: false, commandId: 'same-launch' }), /COMMAND_ID_REUSED/);
    const selection = { attemptIds: attempts.map(a => a.id), commandId: 'select-once' };
    const selected = await Promise.all([platform.select(selection), platform.select(selection)]);
    assert.ok(['RESERVED', 'FAILED'].includes(selected[1].state));
    assert.equal(platform.state.conflicts.length, 1, 'Concurrent same command did not rerun selection');
    const conflict = platform.state.conflicts[0];
    assert.deepEqual(conflict.witness?.rows.map(row => row.outcome), ['PASS', 'PASS', 'PASS', 'FAIL']);
    assert.equal(conflict.witness?.contrast, 1); assert.equal(platform.state.acceptedHead, initialHead);
    const badRead = conflict.counterexample?.find(o => o.action === 'read' && o.observed !== o.expected); assert.ok(badRead);
    assert.deepEqual((conflict.reduction as any).reducedTrace, ['read', 'write', 'read']);
    assert.match((conflict.reduction as any).status, /^one-deletion-minimal/);
    const repairs = await Promise.allSettled([
      platform.repair({ conflictId: conflict.id, commandId: 'repair-once' }),
      platform.repair({ conflictId: conflict.id, commandId: 'competing-repair' }),
    ]);
    assert.equal(repairs[0].status, 'fulfilled');
    assert.equal(repairs[1].status, 'rejected');
    if (repairs[1].status === 'rejected') assert.match(String(repairs[1].reason), /REPAIR_NOT_AVAILABLE/);
    await platform.waitForIdle();
    assert.equal(platform.state.attempts.filter(attempt => attempt.role === 'repair').length, 1);
    const candidate = platform.state.candidates.find(c => c.id === platform.state.activeCandidateId)!;
    const finalEvaluation = platform.state.evaluations.find(e => e.candidateId === candidate.id)!;
    const finalResults = finalEvaluation.jobs.map(job => ({
      name: job.name, status: job.status, runtime: job.runtime,
      error: platform.state.evidence.find(item => item.id === job.evidenceId)?.error,
    }));
    assert.equal(candidate.outcome, 'PASS', JSON.stringify(finalResults)); assert.equal(candidate.attemptIds.length, 4); assert.equal(candidate.publicationBase, initialHead);
    assert.equal(finalEvaluation.jobs.length, FULL_RELEASE_JOB_COUNT); assert.ok(finalEvaluation.jobs.every(j => j.status === 'PASS' && j.runtime?.terminationObserved));
    const capsule = platform.state.capsules.at(-1)!;
    assert.ok(JSON.stringify(capsule.selectedItems).includes(conflict.candidateId!));
    assert.ok(!JSON.stringify(capsule.selectedItems).includes('audit-write-burst'), 'Audit cases were withheld from repair capsule');
    const review = await platform.review({ candidateId: candidate.id, commandId: 'review-once' });
    await platform.approve({ proposalDigest: review.proposalDigest, commandId: 'approve-once' });
    const published = await platform.publish({ proposalDigest: review.proposalDigest, commandId: 'publish-once', simulateLostResponse: true });
    assert.equal(published.state, 'UNKNOWN'); assert.equal(platform.state.acceptedHead, initialHead);
    assert.equal(await platform.git.remoteHead(), candidate.commit);
    await assert.rejects(platform.publish({ proposalDigest: review.proposalDigest, commandId: 'publish-again' }), /PUBLICATION_UNRESOLVED|APPROVAL_CONSUMED/);
    await platform.shutdown(); platform = new LocalPlatform(directory); await platform.initialize();
    assert.equal(platform.state.publications.length, 1); assert.equal(platform.state.publications[0].status, 'FINALIZED'); assert.equal(platform.state.acceptedHead, candidate.commit);
    assert.equal(platform.state.receipts.length, 1);
    await Promise.all([platform.reconcile(), platform.reconcile()]); assert.equal(platform.state.receipts.length, 1);
    const receipt = platform.state.receipts[0], bundle = await platform.exportReceipt(receipt.id), trust = platform.trustConfig();
    const verification = verifyBundle(bundle, trust); assert.equal(verification.valid, true, JSON.stringify(verification));
    assert.ok(verification.integrity && verification.authorization && verification.publicationObservation && verification.continuity && verification.sourceVerified);
    const tampered = structuredClone(bundle); tampered.inputs.observations[0].dataBase64 = Buffer.from('{}').toString('base64');
    assert.equal(verifyBundle(tampered, trust).valid, false);
    const wrongTrust = structuredClone(trust); wrongTrust.keys.find((k: any) => k.roles.includes('root')).roles = ['checker']; assert.equal(verifyBundle(bundle, wrongTrust).valid, false);
    assert.ok((await readFile(join(directory, 'bundles', candidate.id + '.gitbundle'))).subarray(0, 17).toString().startsWith('# v2 git bundle'));
    const retained = await platform.publish({ proposalDigest: review.proposalDigest, commandId: 'publish-once', simulateLostResponse: true }); assert.equal(retained.publicationId, published.publicationId); assert.equal(platform.state.publications.length, 1);
  } finally { await platform.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('freshness-only repairs cannot silently disable the cache or drop C', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-value-traps-')); const platform = new LocalPlatform(directory); await platform.initialize();
  try {
    await platform.startDemo({ mode: 'scripted', autoSelect: false, commandId: 'traps-demo' }); await platform.waitForIdle();
    const base = platform.state.acceptedHead, files = await platform.git.files(base);
    files['cache.mjs'] = Buffer.from(files['cache.mjs'].toString().replace('cacheTtlMs = 0', 'cacheTtlMs = 60000'));
    files['presentation.mjs'] = Buffer.from('export function renderStatus(value) { return `<p role="status" aria-live="polite" aria-label="Saved value">Saved value: ${value}</p>`; }\n');
    const useful = await platform.git.createCommit(files, base, 'Known-good retained-value control');
    const good = await (platform as any).freezeCandidate('Known-good control', useful, [], [], base); await platform.evaluate(good, 'retained-value-v1');
    const controlResults = platform.state.evaluations.find(e => e.candidateId === good.id)?.jobs.map(job => {
      const evidence = platform.state.evidence.find(item => item.id === job.evidenceId);
      return { name: job.name, status: job.status, outcome: evidence?.outcome, storeReadCount: evidence?.storeReadCount,
        trace: evidence?.observations.map(({ action, expected, observed, status }) => ({ action, expected, observed, status })), error: evidence?.error };
    });
    assert.equal(good.outcome, 'PASS', JSON.stringify(controlResults));
    const disabledFiles = { ...files, 'cache.mjs': Buffer.from(files['cache.mjs'].toString().replace('cacheTtlMs = 60000', 'cacheTtlMs = 0')) };
    const disabled = await (platform as any).freezeCandidate('Inadequate cache-disabled repair', await platform.git.createCommit(disabledFiles, base, 'Disable cache trap'), [], [], base);
    await platform.evaluate(disabled, 'retained-value-v1'); assert.equal(disabled.outcome, 'FAIL');
    const cacheJob = platform.state.evaluations.find(e => e.candidateId === disabled.id)!.jobs.find(j => j.name === 'retained-cache-benefit')!;
    assert.equal(platform.state.evidence.find(e => e.id === cacheJob.evidenceId)!.storeReadCount, 2);
    const droppedFiles = { ...files, 'presentation.mjs': (await platform.git.files(base))['presentation.mjs'] };
    const dropped = await (platform as any).freezeCandidate('Inadequate C-dropped repair', await platform.git.createCommit(droppedFiles, base, 'Drop C trap'), [], [], base);
    await platform.evaluate(dropped, 'retained-value-v1'); assert.equal(dropped.outcome, 'FAIL');
    const presentationJob = platform.state.evaluations.find(e => e.candidateId === dropped.id)!.jobs.find(j => j.name === 'accessible-saved-value')!;
    assert.equal(presentationJob.status, 'FAIL');
    await assert.rejects(platform.review({ candidateId: disabled.id }), /NOT_PASSED/);
  } finally { await platform.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('local HTTP API rejects cross-origin, unrecognized hosts, missing session and duplicate request digests', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-api-')); const running = await startServer({ port: 0, dataDir: directory }); const url = `http://127.0.0.1:${running.port}`;
  try {
    const snapshot = await fetch(url + '/api/state'); assert.equal(snapshot.status, 200); assert.ok(snapshot.headers.get('set-cookie'));
    const cookie = snapshot.headers.get('set-cookie')!.split(';')[0];
    const unauthorized = await fetch(url + '/api/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(unauthorized.status, 401);
    const crossed = await fetch(url + '/api/demo', { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: 'https://outside.example', 'x-platform-csrf': '1' }, body: '{}' }); assert.equal(crossed.status, 403);
    const rebound = await new Promise<number | undefined>((resolveStatus, reject) => { const request = http.get(url + '/api/state', { headers: { host: `unexpected.example:${running.port}` } }, response => { response.resume(); resolveStatus(response.statusCode); }); request.on('error', reject); }); assert.equal(rebound, 403);
    const noCsrf = await fetch(url + '/api/demo', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' }); assert.equal(noCsrf.status, 403);
    const duplicate = await fetch(url + '/api/demo', { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-platform-csrf': '1' }, body: '{"mode":"scripted","mode":"pi"}' }); assert.equal(duplicate.status, 409);
    const anchor = await fetch(url + '/api/trust-config'); assert.equal((await anchor.json()).scope.projectId, 'collaboration-demo');
  } finally { await running.close(); await rm(directory, { recursive: true, force: true }); }
});

test('response readers cancel oversized chunked bodies before collecting them', async () => {
  let cancelled = false; const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(128)); }, cancel() { cancelled = true; } });
  await assert.rejects(boundedResponse(new Response(stream), 64), /ceiling/); assert.ok(cancelled);
});

test('native fixed-head leases allow one winner, preserve executable modes and reject unsupported source paths', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-git-cas-')); const platform = new LocalPlatform(directory); await platform.initialize();
  try {
    const base = platform.state.acceptedHead, files = await platform.git.files(base);
    const a = await platform.git.createCommit({ ...files, 'intent.txt': Buffer.from('A\n') }, base, 'Competing successor A', { 'server.mjs': '100755' });
    const b = await platform.git.createCommit({ ...files, 'intent.txt': Buffer.from('B\n') }, base, 'Competing successor B');
    const observations = await Promise.allSettled([platform.git.publish(base, a), platform.git.publish(base, b)]);
    assert.equal(observations.filter(result => result.status === 'fulfilled').length, 1);
    const winner = await platform.git.remoteHead(); assert.ok(winner === a || winner === b); await platform.git.verifyRemote(winner);
    await assert.rejects(platform.git.publish(base, winner === a ? b : a), /git push failed/); assert.equal(await platform.git.remoteHead(), winner);
    const workspace = join(directory, 'mode-hydration'); await platform.git.hydrate(a, workspace);
    const mode = (await platform.git.manifest(a)).entries.find(entry => entry.path === 'server.mjs')!.mode; assert.equal(mode, '100755');
    const executable = (await import('node:fs/promises')).stat; assert.ok(((await executable(join(workspace, 'server.mjs'))).mode & 0o111) !== 0);
    await assert.rejects(platform.git.createCommit({ '../escape': Buffer.from('bad') }, base, 'Reject traversal'), /Unsupported/);
    await assert.rejects(platform.git.createCommit({ '.GiT/config': Buffer.from('bad') }, base, 'Reject metadata entry'), /Unsupported/);
    await assert.rejects(platform.git.createCommit({ 'regular': Buffer.from('bad') }, base, 'Reject symlink mode', { regular: '120000' }), /Unsupported mode/);
    const returned = await platform.git.bundle(a, join(directory, 'native-roundtrip.gitbundle')); assert.ok(returned.bytes.length > 0);
  } finally { await platform.shutdown(); await rm(directory, { recursive: true, force: true }); }
});
