// SPDX-License-Identifier: Apache-2.0
// Owned mock rehearsal of the production Pi adapter. Never calls a provider.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeKernel } from '../../packages/protocol/src/node.ts';
import { validateSourceAdvisory } from '../../packages/protocol/src/source-advisory.ts';
import { buildNarsilContext } from '../../services/narsil-context.mjs';
import { runInterlinkedPreview } from '../../services/interlinked-preview.mjs';
import { ExternalEvaluator } from '../../services/evaluator.ts';
import { GitStore } from '../../services/git.ts';
import { canonical, digest, hashBytes } from '../../services/crypto.ts';
import { fullReleaseProbes } from '../../services/probes.ts';
import type { Candidate } from '../../services/types.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ARMS = ['neither', 'narsil-only', 'interlinked-only', 'both'] as const;
export type Arm = typeof ARMS[number];
export const PATHS = ['cache.mjs', 'mutation.mjs', 'presentation.mjs'] as const;
export const SOURCE_PATHS = [...PATHS, 'server.mjs'].sort();
export const TASK = 'Enable a 60-second read cache while preserving every read after an acknowledged write, including an older in-flight read finishing after that write. Retain one backing-store read for repeated unchanged reads. Render the latest saved value in <p role="status" aria-live="polite" aria-label="Saved value">Saved value: VALUE</p> inside the existing document/main structure. Preserve the HTTP API and existing exports. Change only cache.mjs, mutation.mjs and presentation.mjs.';
export const BIOME = await readFile(join(root, 'fixtures/authoring-benchmark/biome.json'), 'utf8');
export const modes = (arm: Arm) => ({ narsil: arm === 'narsil-only' || arm === 'both' ? 'always' : 'off', interlinked: arm === 'interlinked-only' || arm === 'both' ? 'feedback' : 'off' });

export async function fixture(variant: 'original-control' | 'biome-covered') {
  assert(['original-control', 'biome-covered'].includes(variant));
  const files: Record<string, string> = {};
  for (const path of SOURCE_PATHS) files[path] = await readFile(join(root, 'fixtures/collaboration-demo', path), 'utf8');
  if (variant === 'biome-covered') files['biome.json'] = BIOME;
  const manifest = { schemaVersion: 1 as const, pathProfile: 'portable-ascii-v1' as const, entries: Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1).map(([path, bytes]) => ({ path, mode: '100644' as const, bytes: String(Buffer.byteLength(bytes)), digest: hashBytes(bytes) })) };
  return { variant, files, manifest, sourceManifestDigest: digest(manifest), taskDigest: hashBytes(TASK), grantDigest: digest(PATHS), checksDigest: digest(fullReleaseProbes) };
}

export function mockProposal(files: Record<string, string>, faulty: boolean): Record<string, string> {
  assert.equal(files['cache.mjs'].split('cacheTtlMs = 0').length, 2, 'Owned control changed');
  assert.equal(files['presentation.mjs'].split('<p>${value}</p>').length, 2, 'Owned control changed');
  return {
    'cache.mjs': (faulty ? 'debugger;\n' : '') + files['cache.mjs'].replace('cacheTtlMs = 0', 'cacheTtlMs = 60000'),
    'mutation.mjs': files['mutation.mjs'],
    'presentation.mjs': files['presentation.mjs'].replace('<p>${value}</p>', '<p role="status" aria-live="polite" aria-label="Saved value">Saved value: ${value}</p>'),
  };
}

export function coverage(arm: Arm, advisory: any, previews: any[], canary: any) {
  const enabled = modes(arm);
  const narsil = enabled.narsil === 'off' ? 'DISABLED' : advisory?.status === 'READY' && advisory.coverage.queryCount > 0 ? 'OBSERVED' : 'UNMEASURED';
  // A clean preview does not prove that a checker actually ran. Retain an
  // independently staged known finding against the exact immutable config.
  const interlinked = enabled.interlinked === 'off' ? 'DISABLED' : canary?.status === 'FINDINGS'
    && canary.failures.some((row: any) => row.tool === 'biome' && row.code === 'lint/suspicious/noDebugger')
    && previews.length > 0 && previews.every(row => ['FINDINGS', 'NO_BLOCKING_FINDINGS'].includes(row.status)
      && row.sourceCoherence === 'COHERENT' && row.process?.terminationObserved) ? 'OBSERVED_NARROW_BIOME_RULE' : 'UNMEASURED';
  return { narsil, interlinked, comparisonEligible: false, reason: 'Owned mock responses cannot measure model quality, even when actual tool coverage is observed.' };
}

export class Journal {
  private constructor(private handle: Awaited<ReturnType<typeof open>>) {}
  private bytes = 0;
  static async create(path: string) { return new Journal(await open(path, 'wx', 0o600)); }
  async append(kind: string, data: unknown) {
    const line = JSON.stringify({ schemaVersion: 1, time: new Date().toISOString(), kind, data }) + '\n';
    if (Buffer.byteLength(line) > 8 * 1024 * 1024 || this.bytes + Buffer.byteLength(line) > 64 * 1024 * 1024) throw new Error('BENCHMARK_JOURNAL_LIMIT');
    await this.handle.write(line); await this.handle.sync(); this.bytes += Buffer.byteLength(line);
  }
  async close() { await this.handle.close(); }
}

async function runPi(config: string, workspace: string) {
  const child = spawn(process.execPath, [join(root, 'services/pi-child.mjs'), config], { cwd: workspace, detached: true,
    env: { PATH: dirname(process.execPath) + ':/usr/bin:/bin', HOME: join(dirname(config), 'home'), PI_OFFLINE: '1', TZ: 'UTC', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', bytes = 0, overflow = false, timedOut = false;
  const kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  for (const stream of ['stdout', 'stderr'] as const) child[stream]!.on('data', chunk => {
    bytes += chunk.length; if (bytes > 128 * 1024) { overflow = true; kill(); }
    else if (stream === 'stdout') stdout += chunk; else stderr += chunk;
  });
  const timer = setTimeout(() => { timedOut = true; kill(); }, 90_000);
  const exit = await new Promise<{ code: number | null; signal: string | null }>(done => { child.once('error', () => done({ code: null, signal: 'SPAWN_ERROR' })); child.once('close', (code, signal) => done({ code, signal })); }).finally(() => clearTimeout(timer));
  kill();
  let groupAbsent = !child.pid;
  for (let i = 0; i < 20 && !groupAbsent; i++) { try { process.kill(-child.pid!, 0); } catch (error: any) { groupAbsent = error.code === 'ESRCH'; } if (!groupAbsent) await new Promise(done => setTimeout(done, 25)); }
  return { ...exit, stdout, stderr, overflow, timedOut, terminationObserved: groupAbsent };
}

async function evaluate(git: GitStore, evaluator: ExternalEvaluator, files: Record<string, string>, parent: string, name: string) {
  const commit = await git.createCommit(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, Buffer.from(text)])), parent, name);
  const raw = await git.git(['cat-file', 'commit', commit]);
  const manifest = await git.manifest(commit);
  const protocol = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: manifest.entries.map(row => ({ path: row.path, mode: row.mode, bytes: String(row.size), digest: row.digest })) };
  const candidate = { id: name, commit, commitBytesDigest: hashBytes(raw), manifestDigest: digest(protocol), digest: digest({ commit, manifest: protocol }), publicationBase: parent } as Candidate;
  const plan = await evaluator.plan(candidate, 'retained-value-v1');
  const jobs = [];
  for (const job of plan.jobs) jobs.push({ name: job.name, inputDigest: job.evaluationInputDigest, evidence: await evaluator.runJob(candidate, plan, job) });
  return { commit, sourceManifestDigest: candidate.manifestDigest, planDigest: plan.planDigest, status: jobs.every(row => row.evidence.outcome === 'PASS') ? 'PASS' : 'FAIL', jobs, protectedAcceptance: false };
}

export async function rehearse(outputDirectory: string, variant: 'original-control' | 'biome-covered' = 'biome-covered') {
  outputDirectory = resolve(outputDirectory);
  await initializeKernel();
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  const journal = await Journal.create(join(outputDirectory, 'events.jsonl'));
  const frozen = await fixture(variant), runId = randomUUID();
  const report: any = { schemaVersion: 1, kind: 'owned-authoring-tools-rehearsal-v1', runId, status: 'INCOMPLETE', fixture: frozen,
    mode: 'OWNED_MOCK_ONLY', realModelCalls: 0, providerTokens: 0, providerCostMicroUsd: 0, actualBilledCostMicroUsd: null,
    order: ARMS, arms: [], startedAt: new Date().toISOString(), acceptanceEligible: false, measuredQualityAdvantage: null,
    limitations: ['One designed four-file HTTP workload, not a general coding benchmark or TypeScript product test.', 'Mock output is predetermined. Provider tokens, cost, model quality and Cloudflare lifecycle are not measured.', 'Local sibling processes are not hostile-code containment. Only the owned scripted proposal may run here.', 'Original-control and biome-covered are separate datasets. Never compare their outcomes as matched arms.', 'Interlinked coverage is limited to observed rules; a clean result is not exhaustive coverage.'] };
  const implementationPaths = ['services/pi-child.mjs', 'services/pi-turn-error.mjs', 'services/authoring-diagnostic.mjs', 'services/narsil-context.mjs',
    'services/interlinked-preview.mjs', 'services/evaluator.ts', 'services/probes.ts', 'workers/evaluator/overlap.ts', 'package-lock.json',
    'experiments/authoring-tools/benchmark.ts'];
  report.implementationDigests = {};
  for (const path of implementationPaths) report.implementationDigests[path] = hashBytes(await readFile(join(root, path)));
  report.runtime = { node: process.version, platform: process.platform, architecture: process.arch, executableDigest: hashBytes(await readFile(process.execPath)), isolation: 'local-owned-fixture-only' };
  await journal.append('registration', report);
  const temporary = await mkdtemp(join(tmpdir(), 'confidence-tools-benchmark-'));
  try {
    const sourceDirectory = join(temporary, 'source'); await mkdir(sourceDirectory);
    for (const [path, bytes] of Object.entries(frozen.files)) await writeFile(join(sourceDirectory, path), bytes);
    const git = new GitStore(join(temporary, 'source.git'), join(temporary, 'accepted.git'));
    const baseline = await git.initialize(sourceDirectory), evaluator = new ExternalEvaluator(git, join(temporary, 'evaluations'));
    report.baseline = await evaluate(git, evaluator, frozen.files, baseline, 'baseline');
    await journal.append('baseline', report.baseline);
    const narsilBinary = join(root, '.local-tools/narsil/narsil-mcp'), interlinkedCli = join(root, '.local-tools/interlinked/dist/index.js');
    for (const arm of ARMS) {
      const started = performance.now(), workspace = join(temporary, arm), agentDir = join(outputDirectory, arm);
      await mkdir(workspace); await mkdir(agentDir, { mode: 0o700 });
      for (const [path, bytes] of Object.entries(frozen.files)) await writeFile(join(workspace, path), bytes);
      const row: any = { arm, modes: modes(arm), sourceManifestDigest: frozen.sourceManifestDigest, taskDigest: frozen.taskDigest,
        grantDigest: frozen.grantDigest, checksDigest: frozen.checksDigest, status: 'INCOMPLETE', calls: [], providerUsage: null, providerCost: null };
      let server: http.Server | undefined;
      try {
        let advisory: any = null, canary: any = null;
        if (row.modes.narsil !== 'off') {
          const at = performance.now(); advisory = await buildNarsilContext({ sourceCommit: baseline, sourceManifestDigest: frozen.sourceManifestDigest, manifest: frozen.manifest,
            filesBase64: Object.fromEntries(Object.entries(frozen.files).map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')])), assignedPaths: [...PATHS],
            config: { enabled: true, includeSmallProjects: true, binaryPath: narsilBinary, expectedVersion: '1.7.2', limits: { deadlineMs: 30000 } } });
          await validateSourceAdvisory(advisory, { sourceCommit: baseline, sourceManifestDigest: frozen.sourceManifestDigest, manifest: frozen.manifest, assignedPaths: [...PATHS],
            readFile: async contentDigest => { const entry = frozen.manifest.entries.find(entry => entry.digest === contentDigest); assert(entry); return Buffer.from(frozen.files[entry.path]); } });
          row.narsil = { elapsedMs: Math.round(performance.now() - at), advisory };
        }
        if (row.modes.interlinked !== 'off') {
          canary = await runInterlinkedPreview({ cwd: workspace, files: mockProposal(frozen.files, true), allowedPaths: [...PATHS], cliPath: interlinkedCli, generation: 'coverage-canary' });
          row.coverageCanary = canary;
        }
        const prompt = canonical({ assignment: TASK, allowedPaths: PATHS, source: Object.fromEntries(PATHS.map(path => [path, frozen.files[path]])), ...(advisory ? { untrustedSourceAdvisory: advisory } : {}) });
        row.promptBytes = Buffer.byteLength(prompt); row.promptDigest = hashBytes(prompt);
        row.contextBytes = advisory ? Buffer.byteLength(canonical(advisory)) : 0;
        server = http.createServer(async (request, response) => {
          try {
            assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.method, 'POST'); assert.equal(request.headers.authorization, 'Bearer owned-benchmark-mock');
            let raw = ''; for await (const chunk of request) { raw += chunk; assert(Buffer.byteLength(raw) <= 192 * 1024); }
            const body = JSON.parse(raw); assert.equal(body.model, 'owned-benchmark-mock'); assert(row.calls.length < 4);
            const proposal = mockProposal(frozen.files, row.calls.length === 0);
            const content = JSON.stringify({ files: proposal, rationale: 'Predetermined owned transport rehearsal, not model-authored code.' });
            const observation = { requestDigest: hashBytes(raw), requestBytes: Buffer.byteLength(raw), responseDigest: hashBytes(content), responseBytes: Buffer.byteLength(content), mock: true, usage: null };
            row.calls.push(observation); await journal.append('mock-call', { arm, ...observation });
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(`data: ${JSON.stringify({ id: 'owned-mock', object: 'chat.completion.chunk', created: 1791676800, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'owned-mock', object: 'chat.completion.chunk', created: 1791676800, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
          } catch { response.writeHead(400).end('{}'); }
        });
        await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
        const config = join(agentDir, 'config.json');
        await writeFile(config, JSON.stringify({ agentDir, brokerUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, brokerToken: 'owned-benchmark-mock', model: 'owned-benchmark-mock', prompt, allowedPaths: PATHS,
          ...(row.modes.interlinked !== 'off' ? { interlinked: { mode: 'feedback', cliPath: interlinkedCli } } : {}) }), { flag: 'wx', mode: 0o600 });
        row.process = await runPi(config, workspace);
        let session: any = null;
        for (const name of ['session.json', 'partial-session.json']) try { const raw = await readFile(join(agentDir, name)); session = JSON.parse(raw.toString()); row.session = { name, digest: hashBytes(raw), bytes: raw.length, complete: session.complete }; break; } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
        row.coverage = coverage(arm, advisory, session?.previews ?? [], canary);
        const after: Record<string, string> = {};
        assert.deepEqual((await readdir(workspace)).sort(), Object.keys(frozen.files).sort(), 'Workspace inventory changed');
        for (const [path, bytes] of Object.entries(frozen.files)) { after[path] = await readFile(join(workspace, path), 'utf8'); if (!PATHS.includes(path as any)) assert.equal(after[path], bytes, 'Immutable file changed'); }
        // Only exact owned mock output is eligible for local execution.
        const allowed = [mockProposal(frozen.files, false), mockProposal(frozen.files, true)];
        assert(allowed.some(proposal => PATHS.every(path => proposal[path] === after[path])), 'Unowned candidate cannot run on host');
        row.evaluation = await evaluate(git, evaluator, after, baseline, arm);
        row.status = row.process.code === 0 && row.process.terminationObserved && !row.process.overflow && !row.process.timedOut && row.evaluation.status === 'PASS' ? 'OWNED_REHEARSAL_PASS' : 'INCOMPLETE';
      } catch (error) { row.error = error instanceof Error ? error.message.slice(0, 512) : 'BENCHMARK_FAILED'; }
      finally {
        if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); }
        row.elapsedMs = Math.round(performance.now() - started); report.arms.push(row); await journal.append('arm', row);
      }
    }
    report.implementationStable = true;
    for (const path of implementationPaths) if (report.implementationDigests[path] !== hashBytes(await readFile(join(root, path)))) report.implementationStable = false;
    report.status = report.implementationStable && report.arms.every((row: any) => row.status === 'OWNED_REHEARSAL_PASS') ? 'OWNED_REHEARSAL_PASS' : 'INCOMPLETE';
  } finally {
    await rm(temporary, { recursive: true, force: true }); report.temporaryWorkspaceRemoved = true;
    report.completedAt = new Date().toISOString(); await journal.append('complete', { status: report.status, temporaryWorkspaceRemoved: true }); await journal.close();
    await writeFile(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert(args.length === 3 && args[0] === '--mock' && ['original-control', 'biome-covered'].includes(args[1]), 'Usage: benchmark.ts --mock original-control|biome-covered /new/private/output-directory');
  const result = await rehearse(resolve(args[2]), args[1] as 'original-control' | 'biome-covered');
  process.stdout.write(JSON.stringify({ status: result.status, report: join(resolve(args[2]), 'report.json'), realModelCalls: 0, measuredQualityAdvantage: null }) + '\n');
  if (result.status !== 'OWNED_REHEARSAL_PASS') process.exitCode = 1;
}
