// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTypeScriptAblation } from './ablation.ts';
import type { NarsilContextInput, SourceAdvisory } from '../../services/narsil-context.mjs';
import type { InterlinkedObservation, runInterlinkedPreview } from '../../services/interlinked-preview.mjs';

const sha = (value: Uint8Array | string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

test('four arms receive identical source, proposal, compiler and registered budgets with no model dispatch', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'confidence-ablation-test-'));
  const narsilBinary = join(temp, 'narsil-mcp'), interlinkedCli = join(temp, 'interlinked.js'), compiler = join(temp, 'tsc');
  try {
    await writeFile(narsilBinary, 'owned binary'); await writeFile(interlinkedCli, 'owned cli'); await writeFile(compiler, 'owned compiler');
    let contextCalls = 0, previewCalls = 0, checkerCalls = 0;
    let addUnexpectedFile = false, checkerDrift = false;
    const inheritedCompiler = process.env.CONFIDENCE_TS_PROFILE_COMPILER;
    const dependencies = {
      checker: (async (directory: string, selectedCompiler: string) => {
        checkerCalls++;
        assert.equal(selectedCompiler, await realpath(compiler));
        assert.equal(process.env.CONFIDENCE_TS_PROFILE_COMPILER, inheritedCompiler);
        const invalid = (await readFile(join(directory, 'cache.ts'), 'utf8')).includes('"sixty seconds"');
        return { identity: { compilerDigest: 'sha256:' + 'c'.repeat(64), checkerDigest: 'sha256:' + (checkerDrift && invalid ? 'f' : 'd').repeat(64),
          nodeRuntime: { version: process.version, platform: process.platform, arch: process.arch, executableDigest: 'sha256:' + 'e'.repeat(64) } },
          compilation: { status: invalid ? 'FAIL' : 'PASS', diagnostics: invalid ? 'TS2322 fixed proposal' : '' },
          status: invalid ? 'FAIL' : 'PASS' } as any;
      }) as any,
      context: (async (input: NarsilContextInput) => {
        contextCalls++; assert.equal(input.config?.expectedBinaryDigest, sha('owned binary'));
        assert.deepEqual(input.assignedPaths, ['cache.ts']);
        return { status: 'READY', reason: 'COMPLETE', analyzer: { binaryDigest: sha('owned binary') }, excerpts: [],
          coverage: { incomplete: false } } as unknown as SourceAdvisory;
      }) as any,
      validate: (async (advice: SourceAdvisory, input: NarsilContextInput) => {
        assert.equal(advice.status, 'READY'); assert.equal(input.sourceCommit.length, 40);
        assert.equal(input.sourceManifestDigest.startsWith('sha256:'), true);
      }) as any,
      preview: (async (options: Parameters<typeof runInterlinkedPreview>[0]) => {
        previewCalls++; assert.deepEqual(options.allowedPaths, ['cache.ts']);
        assert.equal((await readFile(join(options.cwd, 'cache.ts'), 'utf8')).includes('"sixty seconds"'), false);
        assert.equal(options.files['cache.ts']?.includes('"sixty seconds"'), true);
        if (addUnexpectedFile) await writeFile(join(options.cwd, 'unexpected.ts'), 'export const unexpected = true;\n');
        return { status: 'FINDINGS', reason: 'fixed-type-error', blocking: true, sourceCoherence: 'COHERENT',
          process: { terminationObserved: true }, identity: { cliEntryDigest: sha('owned cli') },
          failures: [{ path: 'cache.ts', tool: 'tsc', code: 'TS2322', line: 1, severity: 'error', message: 'fixed type error' }] } as InterlinkedObservation;
      }) as any,
    };
    const report = await runTypeScriptAblation({ repetitions: 1, narsilBinary, interlinkedCli, compiler, dependencies });
    assert.equal(report.status, 'LOCAL_PREFLIGHT_PASS');
    assert.equal(checkerCalls, 2); assert.equal(contextCalls, 2); assert.equal(previewCalls, 2);
    assert.deepEqual(report.arms.map(row => row.arm), ['neither', 'narsil-only', 'interlinked-only', 'both']);
    assert.equal(new Set(report.arms.map(row => row.sourceManifestDigest)).size, 1);
    assert.equal(new Set(report.arms.map(row => row.proposalDigest)).size, 1);
    assert.equal(new Set(report.arms.map(row => JSON.stringify(row.modelRegistration))).size, 1);
    assert(report.arms.every(row => row.sourceUnchanged && row.modelCalls === 0 && row.providerInputTokens === 0 && row.providerOutputTokens === 0));
    assert.equal(report.modelRegistration.perArm.maximumOutputTokensPerCall, 8192);
    assert.equal(report.oracle.sourceUnchanged, true);
    assert.equal(report.oracle.sameChecker, true); assert.equal(report.oracle.sameNodeRuntime, true);
    assert.equal(report.implementationBytesStable, true);
    assert(/^sha256:[a-f0-9]{64}$/.test(report.implementationDigests.checker));
    assert(/^sha256:[a-f0-9]{64}$/.test(report.implementationDigests.acceptanceChild));
    assert(report.arms.every(row => !row.narsil || /^sha256:[a-f0-9]{64}$/.test(row.narsil.adviceDigest)));
    assert(report.arms.every(row => !row.interlinked || /^sha256:[a-f0-9]{64}$/.test(row.interlinked.feedbackDigest)));
    assert.equal(report.observedModelCalls, 0); assert.equal(Object.hasOwn(report, 'remoteMutations'), false);
    assert.equal(process.env.CONFIDENCE_TS_PROFILE_COMPILER, inheritedCompiler);

    addUnexpectedFile = true;
    const changed = await runTypeScriptAblation({ repetitions: 1, narsilBinary, interlinkedCli, compiler, dependencies });
    assert.equal(changed.status, 'INCOMPLETE');
    assert.deepEqual(changed.arms.map(row => row.sourceUnchanged), [true, true, false, false]);

    addUnexpectedFile = false; checkerDrift = true;
    const drifted = await runTypeScriptAblation({ repetitions: 1, narsilBinary, interlinkedCli, compiler, dependencies });
    assert.equal(drifted.status, 'INCOMPLETE');
    assert.equal(drifted.oracle.sameChecker, false);
    assert.equal(drifted.oracle.sourceUnchanged, true);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
