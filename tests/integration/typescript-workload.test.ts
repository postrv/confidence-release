import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTypeScriptWorkload } from '../../experiments/typescript-workload/check.ts';
import { runInterlinkedPreview } from '../../services/interlinked-preview.mjs';
import { buildNarsilContext } from '../../services/narsil-context.mjs';
import { digest, hashBytes } from '../../services/crypto.ts';
import { validateSourceAdvisory } from '../../packages/protocol/src/source-advisory.ts';

const fixture = fileURLToPath(new URL('../../experiments/typescript-workload/fixture/', import.meta.url));
const names = ['app.ts', 'cache.ts', 'domain.ts', 'presentation.ts', 'reservations.ts', 'validation.ts'];
type Change = { name: string; before: string; after: string };
const A: Change = { name: 'cache.ts', before: 'export const availabilityTtlMs = 0;', after: 'export const availabilityTtlMs = 60000;' };
const B: Change = { name: 'reservations.ts', before: '  invalidateAvailability();', after: '  // Baseline caching is disabled, so invalidation appears unnecessary.' };
const C: Change = { name: 'presentation.ts', before: '<p>Seats remaining: ${snapshot.remaining}</p>', after: '<p role="status" aria-live="polite" aria-label="Seats remaining">Seats remaining: ${snapshot.remaining}</p>' };
const repair: Change = { name: 'reservations.ts', before: B.after, after: B.before };

async function check(changes: Change[]) {
  const source = await mkdtemp(join(tmpdir(), 'confidence-ts-profile-test-'));
  try {
    for (const name of names) await writeFile(join(source, name), await readFile(join(fixture, name)));
    for (const { name, before, after } of changes) {
      const path = join(source, name), original = await readFile(path, 'utf8');
      assert.equal(original.split(before).length, 2, `Controlled edit must match exactly once in ${name}`);
      await writeFile(path, original.replace(before, after));
    }
    return await checkTypeScriptWorkload(source);
  } finally { await rm(source, { recursive: true, force: true }); }
}

function outcomes(result: Awaited<ReturnType<typeof check>>) {
  return Object.fromEntries((result.acceptance?.checks ?? []).map((row: any) => [row.name, row.outcome]));
}

test('fixed TypeScript profile detects the interaction and preserves the retained goals after repair', { timeout: 90_000 }, async () => {
  const baseline = await check([]);
  assert.equal(baseline.compilation.status, 'PASS');
  assert.equal(outcomes(baseline)['acknowledged-reservation-freshness'], 'PASS');
  assert.equal(outcomes(baseline)['unchanged-read-benefit'], 'FAIL');
  assert.equal(outcomes(baseline)['post-write-unchanged-read-benefit'], 'FAIL');
  assert.equal(outcomes(baseline)['accessible-live-status'], 'FAIL');
  assert.match(baseline.identity.compilerDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(baseline.identity.profileDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(baseline.acceptanceEligible, false);
  assert.equal(baseline.entries.length, names.length);
  assert.equal(baseline.identity.compilerPackages[0]?.name, 'typescript');
  assert.ok(baseline.identity.compilerPackages[0]!.files > 1);
  assert.equal(baseline.identity.nodeRuntime.version, process.version);
  assert.match(baseline.identity.nodeRuntime.executableDigest, /^sha256:[0-9a-f]{64}$/);

  const a = await check([A]);
  const b = await check([B]);
  const c = await check([C]);
  assert.equal(outcomes(a)['unchanged-read-benefit'], 'PASS');
  assert.equal(outcomes(a)['post-write-unchanged-read-benefit'], 'PASS');
  assert.equal(outcomes(a)['acknowledged-reservation-freshness'], 'PASS');
  assert.equal(outcomes(b)['acknowledged-reservation-freshness'], 'PASS');
  assert.equal(outcomes(c)['accessible-live-status'], 'PASS');

  const integrated = await check([A, B, C]);
  assert.equal(outcomes(integrated)['unchanged-read-benefit'], 'PASS');
  assert.equal(outcomes(integrated)['acknowledged-reservation-freshness'], 'FAIL');

  // Apply the repair to the failed A+B+C source, preserving its other edits.
  const repaired = await check([A, B, C, repair]);
  assert.equal(repaired.status, 'PASS', JSON.stringify(repaired.acceptance));
  assert.ok(Object.values(outcomes(repaired)).every(value => value === 'PASS'));
});

test('cache benefit must survive the first acknowledged reservation', async () => {
  const result = await check([
    { ...A, after: `${A.after}\nlet cacheEnabled = true;` },
    { name: 'cache.ts', before: 'if (cached && Date.now() < cached.expiresAt)', after: 'if (cacheEnabled && cached && Date.now() < cached.expiresAt)' },
    { name: 'cache.ts', before: 'if (availabilityTtlMs > 0)', after: 'if (cacheEnabled && availabilityTtlMs > 0)' },
    { name: 'cache.ts', before: 'cached = undefined; }', after: 'cached = undefined; cacheEnabled = false; }' },
    C,
  ]);
  assert.equal(outcomes(result)['unchanged-read-benefit'], 'PASS');
  assert.equal(outcomes(result)['acknowledged-reservation-freshness'], 'PASS');
  assert.equal(outcomes(result)['post-write-unchanged-read-benefit'], 'FAIL');
  assert.equal(result.status, 'FAIL');
});

test('equivalent labelled live status passes regardless of attribute order', async () => {
  const alternate: Change = { ...C, after: '<output aria-label="Seats remaining" role="status">Seats remaining: ${snapshot.remaining}</output>' };
  const result = await check([A, alternate]);
  assert.equal(outcomes(result)['accessible-live-status'], 'PASS', JSON.stringify(result.acceptance));
  assert.equal(result.status, 'PASS', JSON.stringify(result.acceptance));
  const politeRegion: Change = { ...C, after: '<div aria-label="Seats remaining" aria-live="polite">Seats remaining: ${snapshot.remaining}</div>' };
  const region = await check([A, politeRegion]);
  assert.equal(outcomes(region)['accessible-live-status'], 'PASS', JSON.stringify(region.acceptance));
  assert.equal(region.status, 'PASS', JSON.stringify(region.acceptance));
});

test('fixed compiler rejects an invalid TypeScript proposal before behavioral execution', async () => {
  const result = await check([{ ...A, after: 'export const availabilityTtlMs: number = "sixty seconds";' }]);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.compilation.status, 'FAIL');
  assert.equal(result.acceptance, null);
  assert.match(result.compilation.diagnostics, /TS2322/);
});

test('local checker rejects undeclared source before compilation', async () => {
  const source = await mkdtemp(join(tmpdir(), 'confidence-ts-extra-source-'));
  try {
    for (const name of names) await writeFile(join(source, name), await readFile(join(fixture, name)));
    await writeFile(join(source, 'extra.ts'), 'export const unexpected = true;\n');
    await assert.rejects(checkTypeScriptWorkload(source), /TYPESCRIPT_PROFILE_SOURCE_SET/);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('local checker does not follow a source symlink', async () => {
  const source = await mkdtemp(join(tmpdir(), 'confidence-ts-symlink-source-'));
  try {
    for (const name of names) await writeFile(join(source, name), await readFile(join(fixture, name)));
    await rm(join(source, 'cache.ts'));
    await symlink(join(source, 'app.ts'), join(source, 'cache.ts'));
    await assert.rejects(checkTypeScriptWorkload(source));
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('local checker rejects executable source instead of inventing a regular Git mode', async () => {
  const source = await mkdtemp(join(tmpdir(), 'confidence-ts-executable-source-'));
  try {
    for (const name of names) await writeFile(join(source, name), await readFile(join(fixture, name)));
    await chmod(join(source, 'cache.ts'), 0o755);
    await assert.rejects(checkTypeScriptWorkload(source), /UNSUPPORTED_SOURCE_PATH:cache\.ts/);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('real Interlinked preview reports a TypeScript proposal error without changing source', { skip: !process.env.CONFIDENCE_INTERLINKED_TEST_CLI, timeout: 60_000 }, async () => {
  const source = await mkdtemp(join(tmpdir(), 'confidence-ts-preview-test-'));
  try {
    for (const name of [...names, 'tsconfig.json', 'package.json']) await writeFile(join(source, name), await readFile(join(fixture, name)));
    const original = await readFile(join(source, 'cache.ts'));
    const preview = await runInterlinkedPreview({ cwd: source, cliPath: process.env.CONFIDENCE_INTERLINKED_TEST_CLI!, allowedPaths: ['cache.ts'], files: { 'cache.ts': 'export const availabilityTtlMs: number = "invalid";\n' }, timeoutMs: 30_000 });
    assert.equal(preview.status, 'FINDINGS', JSON.stringify(preview));
    assert.ok(preview.failures.some((finding: any) => finding.tool === 'tsc' && finding.code === 'TS2322'));
    assert.equal(preview.sourceCoherence, 'COHERENT');
    assert.equal(preview.acceptanceEligible, false);
    assert.deepEqual(await readFile(join(source, 'cache.ts')), original);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('real Narsil selects and verifies context from the six-file TypeScript source', { skip: !process.env.CONFIDENCE_NARSIL_TEST_BINARY, timeout: 30_000 }, async () => {
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(join(fixture, name))])));
  const entries = names.map(path => ({ path, mode: '100644' as const, bytes: String(files[path].length), digest: hashBytes(files[path]) }));
  const manifest = { schemaVersion: 1 as const, pathProfile: 'portable-ascii-v1' as const, entries };
  const source = { sourceCommit: 'a'.repeat(40), sourceManifestDigest: digest(manifest), manifest, filesBase64: Object.fromEntries(names.map(path => [path, files[path].toString('base64')])), assignedPaths: ['cache.ts'], config: { enabled: true, binaryPath: process.env.CONFIDENCE_NARSIL_TEST_BINARY!, expectedVersion: '1.7.2' } };
  const advice = await buildNarsilContext(source);
  assert.equal(advice.status, 'READY', advice.reason);
  assert.equal(advice.coverage.sourceFiles, 6);
  assert.equal(advice.coverage.incomplete, false);
  assert.ok(advice.excerpts.some((excerpt: any) => excerpt.path === 'reservations.ts'));
  await validateSourceAdvisory(advice, { ...source, readFile: async contentDigest => files[entries.find(entry => entry.digest === contentDigest)!.path] });
});
