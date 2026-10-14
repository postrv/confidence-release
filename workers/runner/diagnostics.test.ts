// SPDX-License-Identifier: Apache-2.0
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeKernel } from '../../packages/protocol/src/node';
import { sha256 } from '../../packages/protocol/src/index';
import { parseDiagnosticResult, runAuthoringDiagnostic, sourceCoherence, DIAGNOSTIC_OUTPUT_LIMIT } from './diagnostics';
before(initializeKernel);
const execute = promisify(execFile);
const recipe = resolve('services/authoring-diagnostic.mjs');
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const pass = { schemaVersion: 1, kind: 'authoring-diagnostic', status: 'PASS', checks: [{ name: 'syntax:cache.mjs', status: 'PASS', summary: 'Owned syntax observation.' }], acceptanceEligible: false };
async function invoke(directory: string, paths: string[]) {
  const result = await execute(process.execPath, [recipe, ...paths], { cwd: directory, timeout: 10_000, maxBuffer: DIAGNOSTIC_OUTPUT_LIMIT, env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv });
  return parseDiagnosticResult(new TextEncoder().encode(result.stdout), 0, false);
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-authoring-diagnostic-'));
  await cp(resolve('fixtures/collaboration-demo'), directory, { recursive: true }); return directory;
}

test('authoring output cannot add acceptance claims or erase duplicate fields', () => {
  assert.equal(parseDiagnosticResult(bytes(pass), 0, false).status, 'PASS');
  for (const value of [{ ...pass, acceptanceEligible: true }, { ...pass, accepted: true }, { ...pass, checks: [{ ...pass.checks[0], status: 'FAIL' }] }, { ...pass, checks: [{ ...pass.checks[0], summary: 'x'.repeat(1025) }] }]) assert.equal(parseDiagnosticResult(bytes(value), 0, false).status, 'ERROR');
  const duplicate = '{"schemaVersion":1,"kind":"authoring-diagnostic","status":"FAIL","status":"PASS","checks":[],"acceptanceEligible":false}';
  assert.equal(parseDiagnosticResult(new TextEncoder().encode(duplicate), 0, false).status, 'ERROR');
  for (const [output, code, truncated] of [[bytes(pass), null, false], [bytes(pass), 0, true], [new Uint8Array(DIAGNOSTIC_OUTPUT_LIMIT + 1), 0, false]] as const) assert.equal(parseDiagnosticResult(output, code, truncated).status, 'ERROR');
});
test('public focused probe executes the owned demo API and catches the warm-cache interaction', async () => {
  const directory = await fixture();
  try {
    const baseline = await invoke(directory, ['cache.mjs']); assert.equal(baseline.status, 'PASS'); assert.equal(baseline.acceptanceEligible, false); assert.equal(baseline.checks.find(check => check.name === 'public-read-write-read')?.status, 'PASS');
    const cache = await readFile(join(directory, 'cache.mjs'), 'utf8'); await writeFile(join(directory, 'cache.mjs'), cache.replace('cacheTtlMs = 0', 'cacheTtlMs = 30000'));
    const mutation = await readFile(join(directory, 'mutation.mjs'), 'utf8'); await writeFile(join(directory, 'mutation.mjs'), mutation.replace('  invalidate();\n', ''));
    const interaction = await invoke(directory, ['cache.mjs', 'mutation.mjs']); assert.equal(interaction.status, 'FAIL'); assert.equal(interaction.checks.find(check => check.name === 'public-read-write-read')?.status, 'FAIL'); assert.equal(interaction.acceptanceEligible, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('missing full profile is explicitly skipped while invalid or missing declared source cannot pass', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-authoring-syntax-'));
  try {
    await writeFile(join(directory, 'file.mjs'), 'export const value = 1;\n');
    const valid = await invoke(directory, ['file.mjs']); assert.equal(valid.status, 'PASS'); assert.equal(valid.checks.find(check => check.name === 'public-read-write-read')?.status, 'SKIPPED');
    await writeFile(join(directory, 'file.mjs'), 'export const = ;\n'); assert.equal((await invoke(directory, ['file.mjs'])).status, 'FAIL');
    assert.equal((await invoke(directory, ['missing.mjs'])).status, 'ERROR'); assert.equal((await invoke(directory, ['../outside.mjs'])).status, 'ERROR');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('actual source changes during a bounded command mark feedback stale without elevating its PASS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-authoring-coherence-'));
  try {
    const path = join(directory, 'file.mjs'); await writeFile(path, 'export const value = 1;\n');
    const observation = await runAuthoringDiagnostic({ generation: 'owned-7', allowedPaths: ['file.mjs'], checkpoint: async () => ({ commit: 'a'.repeat(40), inventoryDigest: await sha256(await readFile(path)) }), execute: async command => {
      assert.deepEqual(command.argv.slice(0, 2), ['node', '/opt/confidence/authoring-diagnostic.mjs']); assert.equal(command.timeoutMs, 10000);
      const result = await execute(process.execPath, [recipe, 'file.mjs'], { cwd: directory, timeout: command.timeoutMs, maxBuffer: command.maximumOutputBytes, env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv });
      await writeFile(path, 'export const value = 2;\n'); return { stdout: new TextEncoder().encode(result.stdout), exitCode: 0, truncated: false };
    } });
    assert.equal(observation.result.status, 'PASS'); assert.equal(observation.sourceCoherence, 'CHANGED'); assert.equal(observation.acceptanceEligible, false); assert.equal(observation.snapshotAtomic, false); assert.equal(observation.trustClass, 'authoring-generation-diagnostic');
    assert.equal(sourceCoherence(null, observation.after), 'UNKNOWN');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('command response loss retains ERROR and missing checkpoint uncertainty', async () => {
  const observation = await runAuthoringDiagnostic({ generation: 'owned-8', allowedPaths: ['cache.mjs'], checkpoint: async () => null, execute: async () => { throw new Error('OWNED_RESPONSE_LOSS'); } });
  assert.equal(observation.result.status, 'ERROR'); assert.equal(observation.sourceCoherence, 'UNKNOWN'); assert.equal(observation.outputDigest, null); assert.equal(observation.acceptanceEligible, false);
});
