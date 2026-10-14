// SPDX-License-Identifier: Apache-2.0
// Owned offline tool fixture, passed to Node stdin; never added to the image.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInterlinkedPreview } from '/opt/confidence/interlinked-preview.mjs';
import { buildNarsilContext } from '/opt/confidence/narsil-context.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = bytes => 'sha256:' + sha(bytes);
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value !== null && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const execute = promisify(execFile);
let stage = 'RUNTIME', directory;
try {
  assert.match(process.version, /^v24\./); assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  const os = await readFile('/etc/os-release', 'utf8'); assert.match(os, /VERSION_CODENAME=bookworm/);
  const narsilInstall = JSON.parse(await readFile('/opt/narsil/confidence-installation.json', 'utf8'));
  const interlinkedInstall = JSON.parse(await readFile('/opt/interlinked/confidence-installation.json', 'utf8'));
  assert.equal(narsilInstall.version, '1.7.2'); assert.equal(narsilInstall.kind, 'published-crate-local-build');
  assert.equal(sha(await readFile('/opt/narsil/narsil-mcp')), narsilInstall.executableSha256);
  assert.equal(interlinkedInstall.revision, '31b5259f29ee823ac23f8d7571b818bf5f609c71');
  assert.equal(interlinkedInstall.buildPatch.id, 'confidence-interlinked-retained-biome-v1');
  assert.equal(sha(await readFile('/opt/interlinked/confidence-patches/interlinked-biome.patch.json')), interlinkedInstall.buildPatch.patchSha256);
  assert.equal(sha(await readFile('/opt/interlinked/confidence-patches/biome.upstream.ts')), interlinkedInstall.buildPatch.originalSha256);
  assert.equal(sha(await readFile('/opt/interlinked/confidence-patches/biome.modified.ts')), interlinkedInstall.buildPatch.patchedSha256);
  assert.match(await readFile('/opt/narsil/LICENSE-MIT', 'utf8'), /Permission is hereby granted/);
  assert.match(await readFile('/opt/narsil/LICENSE-APACHE', 'utf8'), /Apache License/);
  assert.match(await readFile('/opt/interlinked/LICENSE', 'utf8'), /2026 Quentin Cody/);
  const { stdout: version } = await execute('/opt/narsil/narsil-mcp', ['--version'], { timeout: 10000, maxBuffer: 8192 });
  assert.equal(version.trim(), 'narsil-mcp 1.7.2');
  directory = await mkdtemp('/tmp/confidence-owned-tools-');
  await mkdir('/tmp/confidence-home', { recursive: true });
  stage = 'INTERLINKED_TS_OVERLAY';
  // Keep checker projects as siblings: the TS config must not own the MJS fixture.
  const tsDirectory = join(directory, 'ts'); await mkdir(tsDirectory);
  const original = 'export const value: number = 1;\n';
  await writeFile(join(tsDirectory, 'file.ts'), original);
  await writeFile(join(tsDirectory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', lib: ['ES2022'], skipLibCheck: true }, include: ['file.ts'] }));
  const options = { cwd: tsDirectory, cliPath: '/opt/interlinked/dist/index.js', allowedPaths: ['file.ts'], timeoutMs: 30000, generation: 'owned-image-fixture' };
  const invalid = await runInterlinkedPreview({ ...options, files: { 'file.ts': 'export const value: number = "incorrect";\n' } });
  assert.equal(invalid.status, 'FINDINGS', JSON.stringify(invalid)); assert(invalid.failures.some(row => row.tool === 'tsc' && row.code === 'TS2322'));
  const valid = await runInterlinkedPreview({ ...options, files: { 'file.ts': 'export const value: number = 2;\n' } });
  assert.equal(valid.status, 'NO_BLOCKING_FINDINGS', JSON.stringify(valid)); assert.equal(valid.coverage.status, 'NOT_REPORTED');
  assert.equal(await readFile(join(tsDirectory, 'file.ts'), 'utf8'), original);
  for (const preview of [invalid, valid]) { assert.equal(preview.acceptanceEligible, false); assert.equal(preview.sourceCoherence, 'COHERENT'); assert.equal(preview.process.terminationObserved, true); assert(Number.isSafeInteger(preview.cliElapsedMs)); }
  stage = 'INTERLINKED_MJS_BIOME';
  const mjsDirectory = join(directory, 'mjs'); await mkdir(mjsDirectory);
  const mjsOriginal = 'export function value() { return 1; }\n';
  await writeFile(join(mjsDirectory, 'file.mjs'), mjsOriginal);
  await writeFile(join(mjsDirectory, 'biome.json'), JSON.stringify({ formatter: { enabled: false }, linter: { enabled: true, rules: { recommended: false, suspicious: { noDebugger: 'error' } } }, assist: { enabled: false } }));
  const mjsInventory = (await readdir(mjsDirectory)).sort();
  const mjsOptions = { ...options, cwd: mjsDirectory, allowedPaths: ['file.mjs'] };
  const mjsInvalid = await runInterlinkedPreview({ ...mjsOptions, files: { 'file.mjs': 'export function value() { debugger; return 2; }\n' } });
  assert.equal(mjsInvalid.status, 'FINDINGS', JSON.stringify(mjsInvalid));
  assert(mjsInvalid.failures.some(row => row.tool === 'biome' && row.code === 'lint/suspicious/noDebugger'));
  const mjsValid = await runInterlinkedPreview({ ...mjsOptions, files: { 'file.mjs': 'export function value() { return 2; }\n' } });
  assert.equal(mjsValid.status, 'NO_BLOCKING_FINDINGS', JSON.stringify(mjsValid));
  for (const preview of [mjsInvalid, mjsValid]) { assert.equal(preview.sourceCoherence, 'COHERENT'); assert.equal(preview.acceptanceEligible, false); assert.equal(preview.process.terminationObserved, true); }
  assert.equal(await readFile(join(mjsDirectory, 'file.mjs'), 'utf8'), mjsOriginal);
  assert.deepEqual((await readdir(mjsDirectory)).sort(), mjsInventory);
  stage = 'NARSIL_CONTEXT';
  const files = {
    'cache.mjs': 'let cached;\nexport function readValue(readStore) { return cached ??= readStore(); }\nexport function invalidate() { cached = undefined; }\n',
    'mutation.mjs': 'import { invalidate } from "./cache.mjs";\nexport function writeValue(value, writeStore) { writeStore(value); invalidate(); return value; }\n',
    'presentation.mjs': 'export function render(value) { return String(value); }\n',
    'server.mjs': 'import { readValue } from "./cache.mjs";\nexport function read() { return readValue(() => 1); }\n',
    'extra.mjs': 'export const extra = 1;\n',
  };
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1).map(([path, content]) => ({ path, mode: '100644', bytes: String(Buffer.byteLength(content)), digest: hash(content) }));
  const manifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries };
  const input = { sourceCommit: 'a'.repeat(40), sourceManifestDigest: hash(canonical(manifest)), manifest, assignedPaths: ['cache.mjs'], filesBase64: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, Buffer.from(content).toString('base64')])), config: { enabled: true, binaryPath: '/opt/narsil/narsil-mcp', expectedVersion: '1.7.2', expectedBinaryDigest: 'sha256:' + narsilInstall.executableSha256, limits: { deadlineMs: 30000 } } };
  const first = await buildNarsilContext(input), second = await buildNarsilContext(input);
  assert.equal(first.status, 'READY', JSON.stringify(first)); assert.deepEqual(second, first);
  assert.equal(first.acceptanceEligible, false); assert.equal(first.authorityEligible, false);
  assert(first.excerpts.some(excerpt => excerpt.path === 'mutation.mjs'));
  for (const excerpt of first.excerpts) {
    assert.equal(excerpt.text, files[excerpt.path].split('\n').slice(excerpt.startLine - 1, excerpt.endLine).join('\n'));
    assert.equal(excerpt.digest, hash(excerpt.text)); assert.equal(excerpt.fileDigest, hash(files[excerpt.path]));
  }
  const newPath = await buildNarsilContext({ ...input, assignedPaths: ['cache.mjs', 'new-file.mjs'], config: { ...input.config, binaryPath: '/missing-owned-narsil' } });
  assert.equal(newPath.status, 'SKIPPED'); assert.equal(newPath.reason, 'NEW_ASSIGNED_PATH');
  assert.equal(newPath.analyzer.binaryDigest, null); assert.equal(newPath.coverage.queryCount, 0); assert.deepEqual(newPath.excerpts, []);
  assert.deepEqual(newPath.coverage.assignedPaths, ['cache.mjs', 'new-file.mjs']);
  const result = { schemaVersion: 1, status: 'PASS', node: process.version, platform: process.platform, architecture: process.arch, operatingSystem: 'bookworm', network: 'none',
    narsil: { version: version.trim(), buildKind: narsilInstall.kind, revision: narsilInstall.revision, archiveSha256: narsilInstall.archiveSha256, executableSha256: narsilInstall.executableSha256, rustc: narsilInstall.rustc, profile: narsilInstall.profile, status: first.status, reason: first.reason, sameAdvisory: true, sourceManifestDigest: input.sourceManifestDigest, excerptPaths: first.excerpts.map(excerpt => excerpt.path), exactSourceVerified: true, coverage: first.coverage, acceptanceEligible: false, authorityEligible: false, deadlineMs: input.config.limits.deadlineMs, newAssignedPath: { status: newPath.status, reason: newPath.reason, queryCount: newPath.coverage.queryCount, skippedBeforeBinaryLookup: newPath.analyzer.binaryDigest === null } },
    interlinked: { revision: interlinkedInstall.revision, runtimeManifestSha256: interlinkedInstall.runtimeManifestSha256, buildPatch: interlinkedInstall.buildPatch, invalidType: invalid.status, code: invalid.failures.find(row => row.code === 'TS2322').code, validType: valid.status, originalSourceUnchanged: true, coverage: valid.coverage.status, acceptanceEligible: false,
      mjsBiome: { status: mjsInvalid.status, code: mjsInvalid.failures.find(row => row.code === 'lint/suspicious/noDebugger').code, correctedStatus: mjsValid.status, sourceCoherence: mjsValid.sourceCoherence, originalSourceUnchanged: true, temporaryFilesRemoved: true, coverage: mjsValid.coverage.status, acceptanceEligible: false } }, licensesRetained: true,
    limitations: ['The Narsil executable was rebuilt from the published locked crate for Bookworm; it is not the upstream Linux release artifact.', 'Owned offline fixtures validate tool integration, not protected acceptance or model-quality/throughput improvement.', 'The source commit is a synthetic fixture identity; source bytes and excerpts are digest verified.'] };
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) { process.stderr.write(JSON.stringify({ status: 'FAIL', stage, message: String(error.message).slice(0, 16384) }) + '\n'); process.exitCode = 1; }
finally { if (directory) await rm(directory, { recursive: true, force: true }); }
