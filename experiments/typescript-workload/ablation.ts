// SPDX-License-Identifier: Apache-2.0
/** Four-arm local advisory ablation on one frozen TypeScript source/proposal. No model calls. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceManifest } from '../../packages/protocol/src/types.ts';
import { validateSourceAdvisory } from '../../packages/protocol/src/source-advisory.ts';
import { digest, hashBytes } from '../../services/crypto.ts';
import { buildNarsilContext, type NarsilContextInput, type SourceAdvisory } from '../../services/narsil-context.mjs';
import { runInterlinkedPreview, interlinkedPreviewFeedback, type InterlinkedObservation } from '../../services/interlinked-preview.mjs';
import type { checkTypeScriptWorkload } from './check.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixture');
const files = ['app.ts', 'cache.ts', 'domain.ts', 'presentation.ts', 'reservations.ts', 'validation.ts'] as const;
const support = ['package.json', 'tsconfig.json'] as const;
const CACHE_BEFORE = 'export const availabilityTtlMs = 0;';
const CACHE_INVALID = 'export const availabilityTtlMs: number = "sixty seconds";';
const MODEL_REGISTRATION = Object.freeze({ provider: 'workers-ai', model: '@cf/zai-org/glm-5.3',
  perArm: { maximumCalls: 24, maximumInputTokens: 120000, maximumOutputTokens: 48000, maximumOutputTokensPerCall: 8192 } });
const SOURCE_TREE_ENTRY_LIMIT = 32, SOURCE_TREE_BYTE_LIMIT = 8 * 1024 * 1024;
const CHECKER_OUTPUT_LIMIT = 1024 * 1024, CHECKER_TIMEOUT_MS = 60_000;
const ORDERS = [
  ['neither', 'narsil-only', 'interlinked-only', 'both'],
  ['both', 'interlinked-only', 'narsil-only', 'neither'],
  ['narsil-only', 'neither', 'both', 'interlinked-only'],
  ['interlinked-only', 'both', 'neither', 'narsil-only'],
] as const;
type Arm = 'neither' | 'narsil-only' | 'interlinked-only' | 'both';
type CheckerResult = Awaited<ReturnType<typeof checkTypeScriptWorkload>>;
type Dependencies = {
  context: typeof buildNarsilContext;
  preview: typeof runInterlinkedPreview;
  validate: typeof validateSourceAdvisory;
  checker: (directory: string, compiler: string) => Promise<CheckerResult>;
};
type Options = { repetitions?: number; narsilBinary?: string; interlinkedCli?: string; compiler?: string; dependencies?: Partial<Dependencies> };
const sha1 = (bytes: Uint8Array | string) => createHash('sha1').update(bytes).digest('hex');
const sha256 = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const hashShape = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const millis = (start: number) => Math.round(performance.now() - start);
function ensure(value: unknown, code: string): asserts value { if (!value) throw Error(code); }

async function frozenSource() {
  const source = new Map<string, Buffer>();
  for (const name of [...files, ...support]) {
    const path = join(fixture, name), info = await lstat(path);
    ensure(info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024, 'ABLATION_SOURCE_PATH_INVALID');
    source.set(name, await readFile(path));
  }
  const entries = files.map(path => ({ path, mode: '100644' as const, bytes: String(source.get(path)!.length), digest: hashBytes(source.get(path)!) }));
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries };
  const manifestDigest = digest(manifest);
  const sourceId = sha1(manifestDigest); // Synthetic identity for the local advisory; not a Git commit.
  const before = source.get('cache.ts')!.toString('utf8');
  ensure(before.split(CACHE_BEFORE).length === 2, 'ABLATION_PROPOSAL_ANCHOR_CHANGED');
  const proposed = before.replace(CACHE_BEFORE, CACHE_INVALID);
  return { source, manifest, manifestDigest, sourceId, proposed, proposalDigest: sha256(proposed) };
}

async function copySource(source: Map<string, Buffer>, replaceCache?: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-ts-ablation-'));
  for (const name of [...files, ...support]) await writeFile(join(directory, name), name === 'cache.ts' && replaceCache !== undefined ? replaceCache : source.get(name)!);
  return directory;
}

async function sourceInventory(directory: string): Promise<{ path: string; type: 'file' | 'directory'; bytes?: number; digest?: string }[]> {
  const entries: { path: string; type: 'file' | 'directory'; bytes?: number; digest?: string }[] = [];
  let totalBytes = 0;
  async function walk(base: string, prefix: string, depth: number): Promise<void> {
    ensure(depth <= 4, 'ABLATION_SOURCE_TREE_LIMIT');
    for (const entry of await readdir(base, { withFileTypes: true })) {
      ensure(entries.length < SOURCE_TREE_ENTRY_LIMIT, 'ABLATION_SOURCE_TREE_LIMIT');
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(base, entry.name), info = await lstat(absolute);
      if (info.isDirectory()) {
        entries.push({ path, type: 'directory' });
        await walk(absolute, path, depth + 1);
      } else {
        ensure(info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024, 'ABLATION_SOURCE_TREE_INVALID');
        totalBytes += info.size;
        ensure(totalBytes <= SOURCE_TREE_BYTE_LIMIT, 'ABLATION_SOURCE_TREE_LIMIT');
        const bytes = await readFile(absolute);
        ensure(bytes.length === info.size, 'ABLATION_SOURCE_TREE_CHANGED');
        entries.push({ path, type: 'file', bytes: bytes.length, digest: sha256(bytes) });
      }
    }
  }
  await walk(directory, '', 0);
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function sourceMatches(directory: string, source: Map<string, Buffer>, replaceCache?: string): Promise<boolean> {
  const expected = [...files, ...support].map(path => {
    const bytes = path === 'cache.ts' && replaceCache !== undefined ? Buffer.from(replaceCache) : source.get(path)!;
    return { path, type: 'file' as const, bytes: bytes.length, digest: sha256(bytes) };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  try { return JSON.stringify(await sourceInventory(directory)) === JSON.stringify(expected); }
  catch { return false; }
}

async function runCheckerIsolated(directory: string, compiler: string): Promise<CheckerResult> {
  const checkPath = fileURLToPath(new URL('./check.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), checkPath, directory], {
    cwd: resolve(here, '../..'), env: { ...process.env, CONFIDENCE_TS_PROFILE_COMPILER: compiler }, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
  const lengths = { stdout: 0, stderr: 0 };
  let overflow = false, timedOut = false, spawnFailed = false;
  for (const stream of ['stdout', 'stderr'] as const) child[stream].on('data', (chunk: Buffer) => {
    lengths[stream] += chunk.length;
    if (lengths[stream] > CHECKER_OUTPUT_LIMIT) { overflow = true; child.kill('SIGKILL'); }
    else output[stream].push(chunk);
  });
  child.once('error', () => { spawnFailed = true; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, CHECKER_TIMEOUT_MS);
  const code = await new Promise<number | null>(done => child.once('close', done)).finally(() => clearTimeout(timer));
  ensure(!spawnFailed && !timedOut && !overflow, 'ABLATION_CHECKER_PROCESS_FAILED');
  let value: CheckerResult;
  try { value = JSON.parse(Buffer.concat(output.stdout).toString('utf8')) as CheckerResult; }
  catch { throw Error('ABLATION_CHECKER_OUTPUT_INVALID'); }
  ensure(value && typeof value === 'object' && value.identity && hashShape(value.identity.compilerDigest)
    && hashShape(value.identity.checkerDigest) && value.identity.nodeRuntime && hashShape(value.identity.nodeRuntime.executableDigest)
    && value.compilation && ['PASS', 'FAIL', 'ERROR'].includes(value.compilation.status)
    && typeof value.compilation.diagnostics === 'string' && ['PASS', 'FAIL', 'ERROR'].includes(value.status)
    && code === (value.status === 'PASS' ? 0 : value.status === 'FAIL' ? 1 : 2), 'ABLATION_CHECKER_OUTPUT_INVALID');
  return value;
}

export async function runTypeScriptAblation(options: Options = {}) {
  const repetitions = options.repetitions ?? 2;
  ensure(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 4, 'ABLATION_REPETITIONS_INVALID');
  const narsilBinary = await realpath(options.narsilBinary ?? resolve('.local-tools/narsil/narsil-mcp'));
  const interlinkedCli = await realpath(options.interlinkedCli ?? resolve('.local-tools/interlinked/dist/index.js'));
  const compiler = await realpath(options.compiler ?? resolve('.local-tools/interlinked/node_modules/typescript/bin/tsc'));
  for (const path of [narsilBinary, interlinkedCli, compiler]) ensure((await lstat(path)).isFile(), 'ABLATION_TOOL_PATH_INVALID');
  const toolDigests = { narsilBinaryDigest: sha256(await readFile(narsilBinary)), interlinkedCliDigest: sha256(await readFile(interlinkedCli)),
    compilerEntrypointDigest: sha256(await readFile(compiler)) };
  const implementationPaths = { harness: fileURLToPath(import.meta.url),
    narsilAdapter: fileURLToPath(new URL('../../services/narsil-context.mjs', import.meta.url)),
    interlinkedAdapter: fileURLToPath(new URL('../../services/interlinked-preview.mjs', import.meta.url)),
    checker: fileURLToPath(new URL('./check.ts', import.meta.url)),
    sourceProfile: fileURLToPath(new URL('../../packages/protocol/src/typescript-workload-profile.ts', import.meta.url)),
    acceptanceChild: fileURLToPath(new URL('./acceptance-child.mjs', import.meta.url)) };
  const implementationDigests = Object.fromEntries(await Promise.all(Object.entries(implementationPaths).map(async ([name, path]) => [name, sha256(await readFile(path))])));
  const dependency: Dependencies = { context: options.dependencies?.context ?? buildNarsilContext,
    preview: options.dependencies?.preview ?? runInterlinkedPreview, validate: options.dependencies?.validate ?? validateSourceAdvisory,
    checker: options.dependencies?.checker ?? runCheckerIsolated };
  const frozen = await frozenSource();
  const sourceFileDigests = Object.fromEntries([...files, ...support].map(name => [name, sha256(frozen.source.get(name)!)]));
  let baseline: CheckerResult, proposed: CheckerResult, oracleSourceUnchanged = false;
  const oracleStart = performance.now();
  const baselineDirectory = await copySource(frozen.source), proposedDirectory = await copySource(frozen.source, frozen.proposed);
  try {
    baseline = await dependency.checker(baselineDirectory, compiler);
    proposed = await dependency.checker(proposedDirectory, compiler);
    oracleSourceUnchanged = await sourceMatches(baselineDirectory, frozen.source)
      && await sourceMatches(proposedDirectory, frozen.source, frozen.proposed);
  } finally {
    await Promise.all([rm(baselineDirectory, { recursive: true, force: true }), rm(proposedDirectory, { recursive: true, force: true })]);
  }
  const oracleElapsedMs = millis(oracleStart);
  const oracleSameCompiler = baseline.identity.compilerDigest === proposed.identity.compilerDigest;
  const oracleSameChecker = hashShape(baseline.identity.checkerDigest) && baseline.identity.checkerDigest === proposed.identity.checkerDigest;
  const oracleSameNodeRuntime = hashShape(baseline.identity.nodeRuntime?.executableDigest)
    && digest(baseline.identity.nodeRuntime) === digest(proposed.identity.nodeRuntime);
  const oracleExpected = oracleSourceUnchanged && baseline.compilation.status === 'PASS' && proposed.compilation.status === 'FAIL'
    && /TS2322/.test(proposed.compilation.diagnostics) && oracleSameCompiler && oracleSameChecker && oracleSameNodeRuntime;
  const input: NarsilContextInput = { sourceCommit: frozen.sourceId, sourceManifestDigest: frozen.manifestDigest,
    manifest: frozen.manifest, filesBase64: Object.fromEntries(files.map(name => [name, frozen.source.get(name)!.toString('base64')])),
    assignedPaths: ['cache.ts'], config: { enabled: true, binaryPath: narsilBinary, expectedVersion: '1.7.2', expectedBinaryDigest: toolDigests.narsilBinaryDigest } };
  const byDigest = new Map(files.map(name => [hashBytes(frozen.source.get(name)!), frozen.source.get(name)!]));
  const arms = [];
  for (let repetition = 0; repetition < repetitions; repetition++) for (const arm of ORDERS[repetition] as readonly Arm[]) {
    const directory = await copySource(frozen.source);
    try {
      const hasNarsil = arm === 'narsil-only' || arm === 'both';
      const hasInterlinked = arm === 'interlinked-only' || arm === 'both';
      let narsil: { status: string; reason: string; elapsedMs: number; excerptBytes: number; excerptCount: number; selectedPaths: string[]; analyzerBinaryDigest: string | null; verifiedAgainstSource: boolean; adviceDigest: string } | null = null;
      let interlinked: { status: string; reason: string; elapsedMs: number; ts2322: boolean; blocking: boolean; feedbackBytes: number; feedbackDigest: string; cliEntryDigest: string | null; coherent: boolean; terminated: boolean } | null = null;
      if (hasNarsil) {
        const started = performance.now(); const advice: SourceAdvisory = await dependency.context(input);
        let verified = false;
        if (advice.status === 'READY') {
          await dependency.validate(advice, { ...input, readFile: async contentDigest => {
            const value = byDigest.get(contentDigest); ensure(value, 'ABLATION_ADVISORY_SOURCE_MISSING'); return value;
          } });
          verified = true;
        }
        narsil = { status: advice.status, reason: advice.reason, elapsedMs: millis(started),
          excerptBytes: advice.excerpts.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0), excerptCount: advice.excerpts.length,
          selectedPaths: [...new Set(advice.excerpts.map(item => item.path))].sort(), analyzerBinaryDigest: advice.analyzer.binaryDigest,
          verifiedAgainstSource: verified, adviceDigest: digest(advice) };
      }
      if (hasInterlinked) {
        const started = performance.now(); const observation: InterlinkedObservation = await dependency.preview({ cwd: directory,
          files: { 'cache.ts': frozen.proposed }, allowedPaths: ['cache.ts'], cliPath: interlinkedCli, generation: `${repetition + 1}`, timeoutMs: 30_000 });
        const feedback = interlinkedPreviewFeedback(observation);
        interlinked = { status: observation.status, reason: observation.reason, elapsedMs: millis(started),
          ts2322: observation.failures.some(item => item.tool === 'tsc' && item.code === 'TS2322'), blocking: observation.blocking,
          feedbackBytes: Buffer.byteLength(JSON.stringify(feedback)), feedbackDigest: digest(feedback), cliEntryDigest: observation.identity?.cliEntryDigest ?? null,
          coherent: observation.sourceCoherence === 'COHERENT', terminated: observation.process?.terminationObserved === true };
      }
      arms.push({ repetition: repetition + 1, order: arms.length + 1, arm, sourceManifestDigest: frozen.manifestDigest,
        proposalDigest: frozen.proposalDigest, modelRegistration: MODEL_REGISTRATION, modelCalls: 0, providerInputTokens: 0,
        providerOutputTokens: 0, narsil, interlinked, sourceUnchanged: await sourceMatches(directory, frozen.source) });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  const toolBytesStable = toolDigests.narsilBinaryDigest === sha256(await readFile(narsilBinary))
    && toolDigests.interlinkedCliDigest === sha256(await readFile(interlinkedCli))
    && toolDigests.compilerEntrypointDigest === sha256(await readFile(compiler));
  const implementationBytesStable = (await Promise.all(Object.entries(implementationPaths).map(async ([name, path]) =>
    implementationDigests[name] === sha256(await readFile(path))))).every(Boolean);
  const readiness = oracleExpected && toolBytesStable && implementationBytesStable && arms.every(row => row.sourceUnchanged
    && (!row.narsil || row.narsil.status === 'READY' && row.narsil.verifiedAgainstSource && row.narsil.analyzerBinaryDigest === toolDigests.narsilBinaryDigest)
    && (!row.interlinked || row.interlinked.status === 'FINDINGS' && row.interlinked.ts2322 && row.interlinked.blocking && row.interlinked.coherent
      && row.interlinked.terminated && row.interlinked.cliEntryDigest === toolDigests.interlinkedCliDigest));
  return { schemaVersion: 1, kind: 'typescript-advisory-ablation-v1', status: readiness ? 'LOCAL_PREFLIGHT_PASS' : 'INCOMPLETE',
    generatedAt: new Date().toISOString(), sampleClass: 'fixed-proposal-local-advisory-replay', repetitions, orderSchedule: ORDERS.slice(0, repetitions),
    source: { fixture: 'experiments/typescript-workload/fixture', syntheticSourceId: frozen.sourceId,
      sourceManifestDigest: frozen.manifestDigest, fileDigests: sourceFileDigests },
    proposal: { path: 'cache.ts', digest: frozen.proposalDigest, kind: 'fixed-invalid-type', expectedCompilerCode: 'TS2322' },
    modelRegistration: MODEL_REGISTRATION, observedModelCalls: 0,
    oracle: { baselineCompilation: baseline.compilation.status, proposedCompilation: proposed.compilation.status,
      proposedCheckerStatus: proposed.status, compilerDigest: proposed.identity.compilerDigest, sameCompiler: oracleSameCompiler,
      checkerDigest: proposed.identity.checkerDigest, sameChecker: oracleSameChecker,
      nodeRuntime: proposed.identity.nodeRuntime, sameNodeRuntime: oracleSameNodeRuntime,
      expectedErrorObserved: oracleExpected, sourceUnchanged: oracleSourceUnchanged, elapsedMs: oracleElapsedMs },
    tools: { ...toolDigests, bytesStable: toolBytesStable }, implementationDigests,
    implementationBytesStable, arms, limitations: [
      'No model was called. Equal model/provider/budget values are registrations; this run measures advisory overhead and one fixed diagnostic, not coding success or provider cost.',
      'The source ID is synthetic and is not an immutable Git commit or Cloudflare Artifacts object.',
      'A single fixed invalid cache proposal does not estimate value on other proposals, the repair stage, or a real three-agent cohort.',
      'Local process timings vary with host load and caches. The checker runs on the host and is not protected Cloudflare acceptance evidence.',
      'Interlinked reports local findings without exhaustive coverage; Narsil excerpts are verified against input bytes but may omit relevant relationships.',
      'This runner contains no Cloudflare API calls; remote side effects of pinned local tools were not independently instrumented.'
    ] };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2); const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const out = value('--out'); ensure(out && args.length === 2, 'ABLATION_ARGUMENTS_REQUIRED');
  const result = await runTypeScriptAblation();
  await mkdir(dirname(resolve(out)), { recursive: true });
  const file = await open(out, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(result, null, 2) + '\n'); } finally { await file.close(); }
  process.stdout.write(JSON.stringify({ status: result.status, report: resolve(out), arms: result.arms.length,
    modelCalls: result.observedModelCalls, oracleExpected: result.oracle.expectedErrorObserved }) + '\n');
  if (result.status !== 'LOCAL_PREFLIGHT_PASS') process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'ABLATION_FAILED';
    process.stderr.write(`${code}\n`); process.exitCode = 1; });
}
