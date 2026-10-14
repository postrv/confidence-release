// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, open, rename } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { canonicalize, digest } from '../packages/protocol/src/index.ts';
import { initializeKernel } from '../packages/protocol/src/node.ts';
import { validateSessionCapture, selectSessionContext } from '../packages/protocol/src/session-context.ts';
import { validateSourceAdvisory } from '../packages/protocol/src/source-advisory.ts';
import type { SourceManifest } from '../packages/protocol/src/types.ts';

const root = resolve('.'), runId = randomUUID();
const imageName = 'confidence-owned-runner-image-' + runId + ':smoke';
const containerName = 'confidence-owned-runner-image-' + runId;
const output = resolve(process.env.RUNNER_IMAGE_SMOKE_REPORT || 'demo-output/runner-image-smoke.json');
const retained = join(dirname(output), 'runner-image', runId);
const hash = (bytes: string | Uint8Array) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
class CheckFailure extends Error { constructor(readonly code: string, readonly details?: unknown) { super(code); } }
function requireCheck(value: unknown, code: string): asserts value { if (!value) throw new CheckFailure(code); }
async function command(args: string[], options: { executable?: string; input?: string; timeout?: number; maximum?: number; allowFailure?: boolean } = {}) {
  const child = spawn(options.executable || 'docker', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), oversized = false, timedOut = false;
  const maximum = options.maximum ?? 2 * 1024 * 1024;
  const collect = (kind: 'stdout' | 'stderr', bytes: Buffer) => {
    if (stdout.length + stderr.length + bytes.length > maximum) { oversized = true; child.kill('SIGKILL'); return; }
    if (kind === 'stdout') stdout = Buffer.concat([stdout, bytes]); else stderr = Buffer.concat([stderr, bytes]);
  };
  child.stdout.on('data', bytes => collect('stdout', bytes)); child.stderr.on('data', bytes => collect('stderr', bytes));
  child.stdin.on('error', () => {}); child.stdin.end(options.input || '');
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeout ?? 30_000);
  const code = await new Promise<number | null>(resolveExit => { child.once('error', () => resolveExit(null)); child.once('close', resolveExit); }).finally(() => clearTimeout(timer));
  if (!options.allowFailure && (code !== 0 || timedOut || oversized)) throw new CheckFailure(timedOut ? 'LOCAL_COMMAND_TIMEOUT' : oversized ? 'LOCAL_COMMAND_OUTPUT_LIMIT' : 'LOCAL_COMMAND_FAILED', { executable: options.executable || 'docker', arguments: args, exitCode: code, stderrTail: stderr.toString('utf8').slice(-4096), stdoutDigest: hash(stdout), stderrDigest: hash(stderr) });
  return { code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), stdoutDigest: hash(stdout), stderrDigest: hash(stderr), stdoutBytes: stdout.length, stderrBytes: stderr.length, timedOut, oversized };
}
async function inspect(kind: 'image' | 'container', name: string): Promise<any | null> {
  const result = await command([kind, 'inspect', name], { maximum: 128 * 1024, allowFailure: true });
  if (result.code !== 0) {
    requireCheck(result.code !== null && !result.timedOut && !result.oversized, 'INSPECTION_UNOBSERVED');
    const error = result.stderr.trim();
    requireCheck(error === 'Error response from daemon: No such ' + kind + ': ' + name || error === 'Error: No such ' + kind + ': ' + name || error === 'Error: No such object: ' + name, 'INSPECTION_ABSENCE_UNOBSERVED');
    return null;
  }
  const parsed = JSON.parse(result.stdout); requireCheck(Array.isArray(parsed) && parsed.length === 1, 'INSPECTION_INVALID'); return parsed[0];
}
async function save(report: unknown) {
  await mkdir(dirname(output), { recursive: true }); const temporary = output + '.' + runId + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  await rename(temporary, output); const directory = await open(dirname(output), 'r'); try { await directory.sync(); } finally { await directory.close(); }
}

const report: any = { schemaVersion: 1, evidenceClass: 'owned-local-production-runner-image-mock', status: 'FAIL', runId, startedAt: new Date().toISOString(), sourceRevision: null, sourceDirty: null, sourceDigests: {}, image: null, runtime: { network: 'none', cpus: '1', memoryBytes: 805306368, maximumPids: 128, readOnlyRoot: true, hostBinds: [], privateEnvironmentPassed: false }, phases: [], cleanup: { containerAbsenceEstablished: false, ownedImageTagAbsenceEstablished: false, imageAbsenceEstablished: false, sharedImageRetained: false, unresolvedResources: [] }, providerGatePassed: false, limitations: [
  'Actual production Dockerfile, copied Pi child and fixed diagnostic recipe run with production-only dependencies under the pinned Node image. Model responses are owned loopback fixtures; no real model or provider is called.',
  'Docker execution on this host does not certify Cloudflare Container lifecycle, broker interception, Artifacts transport, authority grants, protected evaluation isolation or full release readiness.',
  'Correction uses one bounded actual SDK session. Explicit retained-context continuation uses a fresh SDK session and attributed selected data, never native live-session resume.',
  'Raw owned mock SDK snapshots are retained separately in ignored local artifacts; this report contains identities and bounded diagnostic metadata only.',
  'Only the fresh exact owned container and image tag are removed. Shared pre-existing image bytes remain retained; no pruning or account resource mutation is performed.'
] };
report.ownedResourceNames = { image: imageName, container: containerName };
let containerMayExist = false, imageMayExist = false;
report.effects = { imageBuild: 'NOT_DISPATCHED', containerCreate: 'NOT_DISPATCHED' };
try {
  const revision = await command(['rev-parse', 'HEAD'], { executable: 'git', maximum: 1024 }); report.sourceRevision = revision.stdout.trim();
  const dirty = await command(['status', '--porcelain'], { executable: 'git', maximum: 65536 }); report.sourceDirty = Boolean(dirty.stdout.trim());
  for (const path of ['workers/runner/Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'services/pi-child.mjs', 'services/pi-turn-error.mjs', 'services/authoring-diagnostic.mjs', 'services/narsil-context.mjs', 'services/interlinked-preview.mjs', 'integrations/narsil.json', 'integrations/interlinked.json', 'scripts/install-narsil.mjs', 'scripts/install-interlinked.mjs', 'scripts/interlinked-build-patch.mjs', 'integrations/interlinked-biome.patch.json', 'scripts/runner-image-smoke.ts', 'scripts/runner-image-fixture.mjs', 'scripts/authoring-tools-image-fixture.mjs', 'packages/protocol/src/session-context.ts', 'packages/protocol/src/source-advisory.ts', 'fixtures/collaboration-demo/cache.mjs', 'fixtures/collaboration-demo/mutation.mjs', 'fixtures/collaboration-demo/presentation.mjs', 'fixtures/collaboration-demo/server.mjs']) report.sourceDigests[path] = hash(await readFile(resolve(path)));
  requireCheck(await inspect('image', imageName) === null && await inspect('container', containerName) === null, 'OWNED_NAME_NOT_FRESH');
  imageMayExist = true;
  report.effects.imageBuild = 'MAY_HAVE_DISPATCHED'; await save(report);
  const built = await command(['build', '--platform', 'linux/amd64', '-f', 'workers/runner/Dockerfile', '-t', imageName, '.'], { timeout: 2400_000, maximum: 2 * 1024 * 1024 });
  report.effects.imageBuild = 'ACKNOWLEDGED';
  report.build = { exitCode: built.code, stdoutDigest: built.stdoutDigest, stderrDigest: built.stderrDigest, stdoutBytes: built.stdoutBytes, stderrBytes: built.stderrBytes };
  const image = await inspect('image', imageName); requireCheck(image?.Id && image.Os === 'linux' && image.Architecture === 'amd64', 'PRODUCTION_IMAGE_IDENTITY_UNOBSERVED');
  report.image = { id: image.Id, os: image.Os, architecture: image.Architecture, ownedTag: imageName, productionDockerfileDigest: report.sourceDigests['workers/runner/Dockerfile'] };
  await save(report);
  containerMayExist = true;
  report.effects.containerCreate = 'MAY_HAVE_DISPATCHED'; await save(report);
  await command(['run', '-d', '--name', containerName, '--label', 'confidence.owned-runner-image-test=' + runId, '--platform', 'linux/amd64', '--network', 'none', '--read-only', '--cpus', '1', '--memory', '768m', '--pids-limit', '128', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--tmpfs', '/workspace:rw,nosuid,nodev,size=16777216', '--tmpfs', '/agent:rw,nosuid,nodev,size=16777216', '--tmpfs', '/test:rw,nosuid,nodev,size=16777216', '--tmpfs', '/home/owned:rw,nosuid,nodev,size=16777216', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=268435456', image.Id, 'sleep', '360']);
  report.effects.containerCreate = 'ACKNOWLEDGED';
  const container = await inspect('container', containerName); requireCheck(container?.Image === image.Id && container.Config.Labels['confidence.owned-runner-image-test'] === runId && container.HostConfig.NetworkMode === 'none' && container.HostConfig.ReadonlyRootfs === true && !(container.HostConfig.Binds?.length) && container.HostConfig.Memory === 805306368 && container.HostConfig.PidsLimit === 128, 'RUNTIME_CONFINEMENT_MISMATCH');
  report.container = { id: container.Id, ownedName: containerName, associationVerified: true };
  await save(report);
  const toolFixture = await readFile('scripts/authoring-tools-image-fixture.mjs', 'utf8'); requireCheck(Buffer.byteLength(toolFixture) < 64 * 1024, 'TOOL_FIXTURE_SIZE_LIMIT');
  const toolResult = await command(['exec', '-i', '-e', 'HOME=/home/owned', '-w', '/workspace', containerName, 'node', '--input-type=module'], { input: toolFixture, timeout: 150_000, maximum: 128 * 1024 });
  report.tools = JSON.parse(toolResult.stdout);
  requireCheck(report.tools.status === 'PASS' && report.tools.narsil.version === 'narsil-mcp 1.7.2' && report.tools.interlinked.code === 'TS2322'
    && report.tools.interlinked.mjsBiome?.code === 'lint/suspicious/noDebugger' && report.tools.interlinked.mjsBiome.correctedStatus === 'NO_BLOCKING_FINDINGS', 'INSTALLED_AUTHORING_TOOLS_UNOBSERVED');
  await save(report);
  const fixture = await readFile('scripts/runner-image-fixture.mjs', 'utf8'); requireCheck(Buffer.byteLength(fixture) < 64 * 1024, 'FIXTURE_SIZE_LIMIT');
  await command(['exec', '-i', containerName, 'node', '-e', "const fs=require('node:fs');const b=fs.readFileSync(0);if(b.length>65536)process.exit(1);fs.writeFileSync('/test/fixture.mjs',b,{flag:'wx',mode:0o600})"], { input: fixture, maximum: 16384 });
  const files = Object.fromEntries(await Promise.all(['cache.mjs', 'mutation.mjs', 'presentation.mjs', 'server.mjs'].map(async path => [path, await readFile('fixtures/collaboration-demo/' + path, 'utf8')])));
  const expectedCache = files['cache.mjs'].replace('cacheTtlMs = 0', 'cacheTtlMs = 60000'); requireCheck(expectedCache !== files['cache.mjs'], 'FIXTURE_PROFILE_CHANGED');
  await mkdir(retained, { recursive: true, mode: 0o700 });
  await initializeKernel();
  let selected: ReturnType<typeof selectSessionContext> | undefined, firstSession: any, previousSource: any;
  for (const phase of ['initial', 'continued']) {
    const reference = firstSession ? { sessionId: firstSession.sessionId, sessionEntry: firstSession.selectedEntry, sessionDigest: firstSession.digest } : undefined;
    const input = phase === 'initial' ? { phase, files, expectedCache } : { phase, expectedCache, reference, retainedContext: selected };
    const result = await command(['exec', '-i', '-w', '/workspace', containerName, 'node', '/test/fixture.mjs'], { input: JSON.stringify(input), timeout: 60_000, maximum: 2 * 1024 * 1024 });
    const observed = JSON.parse(result.stdout); requireCheck(observed.status === 'PASS' && observed.phase === phase && /^v24\./.test(observed.versions.node), 'IN_IMAGE_OBSERVATION_INVALID');
    const expectedInputs = { 'package.json': report.sourceDigests['package.json'], 'package-lock.json': report.sourceDigests['package-lock.json'], 'pi-child.mjs': report.sourceDigests['services/pi-child.mjs'], 'pi-turn-error.mjs': report.sourceDigests['services/pi-turn-error.mjs'], 'authoring-diagnostic.mjs': report.sourceDigests['services/authoring-diagnostic.mjs'], 'narsil-context.mjs': report.sourceDigests['services/narsil-context.mjs'], 'interlinked-preview.mjs': report.sourceDigests['services/interlinked-preview.mjs'] };
    requireCheck(canonicalize(observed.imageInputs) === canonicalize(expectedInputs), 'COPIED_PRODUCTION_INPUT_MISMATCH');
    const exactFiles = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, Buffer.from(phase === 'continued' && path === 'cache.mjs' ? expectedCache : bytes)]));
    const manifest: SourceManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: Object.entries(exactFiles).sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, mode: '100644', bytes: String(bytes.length), digest: hash(bytes) })) };
    await validateSourceAdvisory(observed.sourceAdvisory, { sourceCommit: '1'.repeat(40), sourceManifestDigest: await digest(manifest), manifest, assignedPaths: ['cache.mjs'], readFile: async contentDigest => {
      const entry = manifest.entries.find(entry => entry.digest === contentDigest); requireCheck(entry, 'ADVISORY_SOURCE_UNAVAILABLE'); return exactFiles[entry.path];
    } });
    requireCheck(observed.sourceAdvisory.status === 'READY' && observed.previewStatuses.length === observed.requests, 'AUTHORING_INTEGRATION_UNOBSERVED');
    const snapshotBytes = Buffer.from(observed.sessionBytesBase64, 'base64'); requireCheck(snapshotBytes.length <= 1024 * 1024 && hash(snapshotBytes) === observed.session.digest, 'SESSION_BYTES_MISMATCH');
    const capture = validateSessionCapture(snapshotBytes); requireCheck(capture.sessionId === observed.session.sessionId && capture.selectedEntry === observed.session.selectedEntry, 'SESSION_SELECTED_ENTRY_MISMATCH');
    const context = selectSessionContext(snapshotBytes, observed.session.selectedEntry);
    requireCheck(phase === 'initial' ? observed.requests === 2 && observed.feedbackObserved : observed.requests === 1 && observed.retainedContextObserved && observed.session.sessionId !== firstSession.sessionId && canonicalize(observed.sourceBefore) === canonicalize(previousSource), 'SESSION_CONTINUATION_MISMATCH');
    for (const path of Object.keys(files)) requireCheck(observed.sourceAfter[path].mode === 0o644 && observed.sourceAfter[path].digest === hash(path === 'cache.mjs' ? expectedCache : files[path]), 'SOURCE_READBACK_MISMATCH');
    await writeFile(join(retained, phase + '-session.json'), snapshotBytes, { flag: 'wx', mode: 0o600 });
    delete observed.sessionBytesBase64;
    observed.session.captureValidated = true; observed.session.selectedContextDigest = await digest(context); observed.session.selectedContextBytes = Buffer.byteLength(canonicalize(context));
    observed.session.retainedArtifact = phase + '-session.json';
    report.phases.push(observed);
    if (phase === 'initial') { selected = context; firstSession = observed.session; previousSource = observed.sourceAfter; }
    await save(report);
  }
  report.status = 'PASS';
} catch (error) { report.failureCode = error instanceof CheckFailure ? error.code : 'LOCAL_RUNNER_IMAGE_CHECK_FAILED'; if (error instanceof CheckFailure && error.details) report.failureDetails = error.details; }
finally {
  if (containerMayExist) {
    try {
      const current = await inspect('container', containerName);
      if (current) { requireCheck(current.Config.Labels['confidence.owned-runner-image-test'] === runId && (!report.container || current.Id === report.container.id), 'CLEANUP_CONTAINER_ASSOCIATION_MISMATCH'); await command(['rm', '-f', current.Id]); }
      report.cleanup.containerAbsenceEstablished = report.effects.containerCreate === 'ACKNOWLEDGED' && await inspect('container', containerName) === null;
      if (!report.cleanup.containerAbsenceEstablished) report.cleanup.unresolvedResources.push(containerName);
    } catch { report.cleanup.unresolvedResources.push(containerName); }
  }
  if (imageMayExist) {
    try {
      const current = await inspect('image', imageName);
      if (current) {
        requireCheck(!report.image || current.Id === report.image.id, 'CLEANUP_IMAGE_ASSOCIATION_MISMATCH');
        const shared = (current.RepoTags || []).filter((tag: string) => tag !== imageName).length > 0 || (current.RepoDigests || []).length > 0;
        await command(['image', 'rm', imageName]); report.cleanup.sharedImageRetained = shared;
        const after = await inspect('image', current.Id); report.cleanup.imageAbsenceEstablished = after === null;
        requireCheck(shared || after === null, 'OWNED_IMAGE_ABSENCE_UNOBSERVED');
      }
      report.cleanup.ownedImageTagAbsenceEstablished = report.effects.imageBuild === 'ACKNOWLEDGED' && await inspect('image', imageName) === null;
      if (!report.cleanup.ownedImageTagAbsenceEstablished) report.cleanup.unresolvedResources.push(imageName);
    } catch { report.cleanup.unresolvedResources.push(imageName); }
  }
  report.completedAt = new Date().toISOString();
  if (report.cleanup.unresolvedResources.length || !report.cleanup.containerAbsenceEstablished || !report.cleanup.ownedImageTagAbsenceEstablished) report.status = 'FAIL';
  await save(report);
}
process.stdout.write(JSON.stringify({ status: report.status, evidenceClass: report.evidenceClass, phases: report.phases.length, report: output, sourceRevision: report.sourceRevision, imageId: report.image?.id || null, cleanup: report.cleanup, providerGatePassed: false }) + '\n');
if (report.status !== 'PASS') process.exitCode = 1;
