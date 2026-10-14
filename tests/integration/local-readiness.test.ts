import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalPlatform } from '../../services/platform.ts';
import type { Candidate } from '../../services/types.ts';

async function fixture(delayedHealth = false) {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-readiness-'));
  const platform = new LocalPlatform(directory);
  try {
    await platform.initialize();
    const base = platform.state.acceptedHead, files = await platform.git.files(base);
    if (delayedHealth) {
      const server = files['server.mjs'].toString();
      const health = "if (url.pathname === '/health') { response.end('ready'); return; }";
      assert.ok(server.includes(health));
      files['server.mjs'] = Buffer.from('let healthRequests = 0;\n' + server.replace(health,
        "if (url.pathname === '/health') { response.statusCode = ++healthRequests <= 100 ? 503 : 200; response.end('ready'); return; }"));
    }
    const commit = await platform.git.createCommit(files, base, 'Owned readiness fixture');
    const candidate: Candidate = await (platform as any).freezeCandidate('Readiness fixture', commit, [], [], base);
    const evaluation = await platform.evaluator.plan(candidate, 'freshness-v1');
    return { platform, candidate, evaluation, job: evaluation.jobs[0], async close() { await platform.shutdown(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) {
    await platform.shutdown(); await rm(directory, { recursive: true, force: true }); throw error;
  }
}

test('local readiness accepts more than 100 real health requests within the unchanged process deadline', { timeout: 30_000 }, async () => {
  const owned = await fixture(true), fetcher = globalThis.fetch;
  let healthRequests = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/health')) healthRequests++;
    return fetcher(input, init);
  };
  try {
    const evidence = await owned.platform.evaluator.runJob(owned.candidate, owned.evaluation, owned.job);
    assert.equal(evidence.outcome, 'PASS', evidence.error ?? 'The owned readiness fixture must complete its freshness probe');
    assert.ok(healthRequests > 100);
    assert.equal(evidence.observations.length, 3);
    assert.equal(evidence.runtimeObservation?.terminationObserved, true);
    assert.equal(owned.job.runtime?.terminationObserved, true);
    assert.equal((owned.job.input.environment as { resourceCeiling: { processSeconds: number } }).resourceCeiling.processSeconds, 15);
  } finally { globalThis.fetch = fetcher; await owned.close(); }
});

for (const offset of [0, 1]) {
  test(`local readiness at deadline plus ${offset}ms dispatches no behavioral probe and does not await health body cancellation`, { timeout: 15_000 }, async () => {
    const owned = await fixture(), fetcher = globalThis.fetch, clockNow = Date.now;
    let healthResponses = 0, behavioralRequests = 0, cancellations = 0;
    globalThis.fetch = async (input, init) => {
      if (!String(input).endsWith('/health')) { behavioralRequests++; return fetcher(input, init); }
      const response = await fetcher(input, init);
      void response.body?.cancel().catch(() => undefined);
      assert.equal(response.status, 200);
      healthResponses++;
      // The parent receives a valid health status exactly at/after its frozen
      // deadline. No real 15-second wait or child scheduling race is needed.
      const expired = Date.parse(owned.job.runtime!.deadline) + offset;
      Date.now = () => expired;
      return new Response(new ReadableStream<Uint8Array>({
        cancel() { cancellations++; return new Promise<void>(() => {}); },
      }), { status: 200 });
    };
    try {
      const evidence = await owned.platform.evaluator.runJob(owned.candidate, owned.evaluation, owned.job);
      assert.equal(evidence.outcome, 'TIMEOUT');
      assert.equal(evidence.error, 'Candidate readiness timeout');
      assert.equal(healthResponses, 1);
      assert.equal(cancellations, 1);
      assert.equal(behavioralRequests, 0);
      assert.deepEqual(evidence.observations, []);
      assert.equal(evidence.storeReadCount, 0);
      assert.equal(evidence.runtimeObservation?.terminationObserved, true);
      assert.equal(owned.job.runtime?.terminationObserved, true);
    } finally { globalThis.fetch = fetcher; Date.now = clockNow; await owned.close(); }
  });
}
