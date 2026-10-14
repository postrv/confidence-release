import { FULL_RELEASE_JOB_COUNT } from '../workers/evaluator/recipes.ts';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LocalPlatform } from '../services/platform.ts';
import { canonical, hashBytes } from '../services/crypto.ts';
import type { Candidate, Evidence } from '../services/types.ts';

// Local owned fixtures only. Each lane executes the actual Platform.evaluate
// path, including planning, durable evidence, serialized saves and cleanup.
const args = process.argv.slice(2);
function option(name: string, fallback: string) { const at = args.indexOf(name); return at === -1 ? fallback : args[at + 1]; }
assert.ok(args.every((value, at) => at % 2 ? args[at - 1] === '--samples' || args[at - 1] === '--output' : value === '--samples' || value === '--output'), 'Usage: benchmark-evaluation.ts [--samples 1..10] [--output path]');
const samples = Number(option('--samples', '5'));
assert.ok(Number.isSafeInteger(samples) && samples >= 1 && samples <= 10, 'Samples must be an integer from 1 to 10');
const output = resolve(option('--output', `demo-output/evaluation-throughput-${new Date().toISOString().replaceAll(':', '-')}.json`));
const repository = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'confidence-evaluation-benchmark-'));
type Result = { repetition: number; concurrency: 1 | 2; source: string; elapsedMs: number; outcome: string; jobs: number; observedMaximumActiveJobs: number; gitCalls: number; sourceDigest: string; inputDigests: string[]; observationsDigest: string; allTerminated: boolean; signedEvidence: number; processCount: number; fixtureCount: number };
const results: Result[] = [], equivalent = new Map<string, string>();
const sourceInputs = ['services/platform.ts', 'services/evaluator.ts', 'services/git.ts', 'services/types.ts', 'services/crypto.ts', 'services/probes.ts', 'services/http-bounds.ts', 'workers/evaluator/overlap.ts', 'workers/shared/deadline.ts', 'workers/shared/errors.ts', 'scripts/benchmark-evaluation.ts', 'packages/protocol/wasm/confidence_protocol_bg.wasm', ...['cache.mjs', 'mutation.mjs', 'presentation.mjs', 'server.mjs'].map(path => 'fixtures/collaboration-demo/' + path)];
const report: Record<string, unknown> = {
  schemaVersion: 1, status: 'RUNNING', generatedAt: new Date().toISOString(),
  method: {
    scope: 'Local trusted fixed-source fixture; actual LocalPlatform.evaluate at bounded concurrency one and two.',
    elapsedBoundary: 'Immediately before evaluate to its resolved result: plan creation, source hydration, fresh HTTP jobs, durable signed evidence/state and cleanup included. Fixture preparation, authoring, review and publication excluded.',
    repetitionsPerPassingLane: samples, repetitionsPerNegativeLane: 1,
    order: 'Alternate lane order per repetition; fresh platform/data directory for each lane; same exact Git source and complete checker inputs across lanes.',
    requiredJobsPerPlan: FULL_RELEASE_JOB_COUNT, resultReuse: false, failFast: false,
    negativeSources: ['stale-read-interaction', 'cache-disabled'],
    outcomeComparison: 'Exact input digests plus outcome, every HTTP observation and backing-store count; runtime IDs/times/signatures naturally differ.',
    limitations: ['Small local sample with uncontrolled host contention; no p95 or general speed claim.', 'No Cloudflare, real model, sponsor-time, cost, useful-goal-throughput or competitor measurement.', 'Serial lane uses the same current implementation configured for one job, not a checkout of historical code.', 'Raw temporary platform artifacts are removed after measurement; this report retains source/input identities, observation hashes and measured summaries.'],
  },
  runtime: { node: process.version, platform: process.platform, architecture: process.arch, nodeBinaryDigest: hashBytes(await readFile(process.execPath)) },
  inputs: Object.fromEntries(await Promise.all(sourceInputs.map(async path => [path, hashBytes(await readFile(join(repository, path)))]))),
  results,
};
async function save() { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
function observable(evidence: Evidence[]) { return evidence.map(item => ({ inputDigest: item.evaluationInputDigest, outcome: item.outcome, observations: item.observations, diagnostics: item.diagnostics ?? [], storeReadCount: item.storeReadCount })); }
async function candidate(platform: LocalPlatform, name: string, files: Record<string, Buffer>): Promise<Candidate> {
  const base = platform.state.acceptedHead;
  const commit = await platform.git.createCommit(files, base, `Owned throughput source: ${name}`);
  return (platform as unknown as { freezeCandidate(name: string, commit: string, attempts: string[], composition: string[], base: string): Promise<Candidate> }).freezeCandidate(name, commit, [], [], base);
}
try {
  await save();
  for (let repetition = 0; repetition < samples; repetition++) {
    const order: (1 | 2)[] = repetition % 2 ? [2, 1] : [1, 2];
    for (const concurrency of order) {
      const platform = new LocalPlatform(join(directory, `${repetition}-${concurrency}`), concurrency); await platform.initialize();
      try {
        const files = await platform.git.files(platform.state.acceptedHead);
        files['cache.mjs'] = Buffer.from(files['cache.mjs'].toString().replace('cacheTtlMs = 0', 'cacheTtlMs = 60000'));
        files['presentation.mjs'] = Buffer.from('export function renderStatus(value) { return `<p role="status" aria-live="polite" aria-label="Saved value">Saved value: ${value}</p>`; }\n');
        const sources = [{ name: 'passing-retained-value', files }];
        if (repetition === 0) sources.push(
          { name: 'stale-read-interaction', files: { ...files, 'mutation.mjs': Buffer.from(files['mutation.mjs'].toString().replace('  invalidate();', '  // Owned stale-read fixture omits invalidation.')) } },
          { name: 'cache-disabled', files: { ...files, 'cache.mjs': Buffer.from(files['cache.mjs'].toString().replace('cacheTtlMs = 60000', 'cacheTtlMs = 0')) } },
        );
        let active = 0, maximum = 0, gitCalls = 0;
        const run = platform.evaluator.runJob.bind(platform.evaluator), git = platform.git.git.bind(platform.git);
        platform.git.git = async (...parameters) => { gitCalls++; return git(...parameters); };
        platform.evaluator.runJob = async (source, evaluation, job, onRuntime, onStart) => {
          let started = false;
          try { return await run(source, evaluation, job, onRuntime, async () => { await onStart?.(); started = true; active++; maximum = Math.max(maximum, active); }); }
          finally { if (started) active--; }
        };
        for (const source of sources) {
          const frozen = await candidate(platform, source.name, source.files);
          maximum = 0; gitCalls = 0;
          const start = performance.now(), evaluation = await platform.evaluate(frozen, 'retained-value-v1'), elapsedMs = performance.now() - start;
          const evidence = evaluation.jobs.map(job => platform.state.evidence.find(item => item.id === job.evidenceId)!);
          assert.equal(evaluation.jobs.length, FULL_RELEASE_JOB_COUNT); assert.equal(active, 0); assert.equal(maximum, concurrency);
          assert.equal(evaluation.outcome, source.name === 'passing-retained-value' ? 'PASS' : 'FAIL');
          assert.ok(evidence.every(item => item.runtimeObservation?.terminationObserved));
          const observation = canonical(observable(evidence)), prior = equivalent.get(source.name);
          if (prior !== undefined) assert.equal(observation, prior, 'Complete source/check observations changed between lanes or repetitions');
          else equivalent.set(source.name, observation);
          const result: Result = { repetition, concurrency, source: source.name, elapsedMs, outcome: evaluation.outcome!, jobs: evaluation.jobs.length, observedMaximumActiveJobs: maximum, gitCalls, sourceDigest: frozen.digest, inputDigests: evidence.map(item => item.evaluationInputDigest), observationsDigest: hashBytes(observation), allTerminated: true, signedEvidence: evidence.filter(item => item.envelope).length, processCount: new Set(evidence.map(item => item.runtimeObservation!.candidateProcessId)).size, fixtureCount: new Set(evidence.map(item => item.runtimeObservation!.fixtureOrigin)).size };
          assert.equal(result.processCount, FULL_RELEASE_JOB_COUNT); assert.equal(result.fixtureCount, FULL_RELEASE_JOB_COUNT); assert.equal(result.signedEvidence, FULL_RELEASE_JOB_COUNT);
          results.push(result); await save();
          process.stdout.write(JSON.stringify({ repetition, concurrency, source: source.name, elapsedMs: Math.round(elapsedMs), outcome: evaluation.outcome, gitCalls }) + '\n');
        }
      } finally { await platform.shutdown(); }
    }
  }
  function distribution(concurrency: 1 | 2) {
    const values = results.filter(result => result.source === 'passing-retained-value' && result.concurrency === concurrency).map(result => result.elapsedMs).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2), median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    return { samples: values.length, minimumMs: values[0], medianMs: median, maximumMs: values.at(-1) };
  }
  const serial = distribution(1), parallel = distribution(2);
  report.summary = { serial, parallel, medianElapsedReductionFraction: 1 - parallel.medianMs / serial.medianMs, medianServiceRateRatio: serial.medianMs / parallel.medianMs, checkedPlans: results.length, checkedJobs: results.reduce((total, result) => total + result.jobs, 0), observationsEquivalent: true, allFreshJobsDurablyRecordedDuringMeasurement: true };
  report.status = 'PASS'; await save(); process.stdout.write(JSON.stringify({ output, ...report.summary as object }) + '\n');
} catch (error) {
  report.status = 'INCONCLUSIVE'; report.error = error instanceof Error ? error.message.slice(0, 512) : 'BENCHMARK_FAILED'; await save(); throw error;
} finally { await rm(directory, { recursive: true, force: true }); }
