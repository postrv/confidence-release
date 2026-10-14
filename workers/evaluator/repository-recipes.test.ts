// SPDX-License-Identifier: Apache-2.0
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initializeKernel } from '../../packages/protocol/src/node';
import { digest, type SourceManifest } from '../../packages/protocol/src/index';
import { CONFIDENCE_REPOSITORY_RECIPE as recipe, assertConfidenceRepositoryInputs, prepareConfidenceRepositoryChecks, repositoryImageChecksRequired } from './repository-recipes';

const root = fileURLToPath(new URL('../..', import.meta.url));
before(initializeKernel);
const base: SourceManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: Object.entries(recipe.controlInputs).map(([path, digest]) =>
  ({ path, digest, mode: '100644' as const, bytes: '1' })).sort((a, b) => a.path < b.path ? -1 : 1) };
const add = (path: string, manifest = base): SourceManifest => ({ ...manifest, entries: [...manifest.entries, { path, mode: '100644' as const, bytes: '1', digest: 'sha256:' + 'a'.repeat(64) }].sort((a, b) => a.path < b.path ? -1 : 1) });
const scope = { schemaVersion: 1 as const, tenantId: 't', projectId: 'p', projectIncarnation: 'i' };
const evaluation = { schemaVersion: 1 as const, id: 'evaluation', goalRevision: '1', policyRevision: '1', contractBundleDigest: 'sha256:' + 'a'.repeat(64) };

test('recipe pins match the reviewed CI foundation, including dependency versions and package scripts', () => {
  assert.equal(recipe.foundation, '8b6a3f0906e18f102d2aeda28972b12b5c4e4c86');
  for (const [path, expected] of Object.entries(recipe.controlInputs)) {
    const bytes = readFileSync(`${root}/${path}`);
    assert.equal('sha256:' + createHash('sha256').update(bytes).digest('hex'), expected, path);
  }
  const workflow = readFileSync(`${root}/.github/workflows/validate.yml`, 'utf8');
  for (const argv of [...recipe.sourceCommands, ...recipe.imageCommands]) assert.ok(workflow.includes(argv.join(' ')), argv.join(' '));
});

test('prepared repository checks require the reviewed public-export CI gate while execution remains unregistered', async () => {
  const manifest = add('scripts/public-source.mjs');
  const candidate = { id: 'candidate', digest: 'sha256:' + 'b'.repeat(64), commit: 'a'.repeat(40), commitBytesDigest: 'sha256:' + 'c'.repeat(64), parent: 'b'.repeat(40), manifestDigest: await digest(manifest) };
  const prepared = await prepareConfidenceRepositoryChecks({ scope, candidate, manifest, base, evaluation });
  assert.equal(prepared.sourceCommands.filter(argv => argv.join(' ') === 'node --test scripts/public-source.test.mjs').length, 1);
  assert.ok(prepared.sourceCommands.some(argv => argv.join(' ') === 'npm run test:local'));
  assert.deepEqual(prepared.imageCommands, [['npm', 'run', 'test:container'], ['npm', 'run', 'test:runner-image']]);
  assert.equal(prepared.registration, 'unregistered');
  assert.ok(prepared.qualificationRequired.includes('registered-authority-evaluator-and-repository-evidence-admission'));
});

test('changing, removing, making executable or adding dependency controls requires another reviewed recipe', () => {
  assert.doesNotThrow(() => assertConfidenceRepositoryInputs(base));
  for (const entries of [base.entries.slice(1), base.entries.map((entry, i) => i ? entry : { ...entry, digest: 'sha256:' + 'b'.repeat(64) }),
    base.entries.map((entry, i) => i ? entry : { ...entry, mode: '100755' as const })]) {
    assert.throws(() => assertConfidenceRepositoryInputs({ ...base, entries }), /REPOSITORY_RECIPE_INPUT_CHANGED/);
  }
  for (const path of ['new/Cargo.toml', '.npmrc', '.cargo/config.toml']) assert.throws(() => assertConfidenceRepositoryInputs(add(path)), /REPOSITORY_RECIPE_INPUT_ADDED/);
});

test('image qualification follows the trusted base classifier, including deletions, modes and both sides of moves', () => {
  assert.equal(repositoryImageChecksRequired(base, add('docs/guide.md')), false);
  assert.equal(repositoryImageChecksRequired(base, add('apps/web/src/New.tsx')), false);
  assert.equal(repositoryImageChecksRequired(base, base), true);
  assert.equal(repositoryImageChecksRequired(add('workers/runner/deleted.ts'), base), true);
  assert.equal(repositoryImageChecksRequired(add('workers/runner/moved.ts'), add('docs/moved.ts')), true);
  const source = add('workers/runner/index.ts');
  assert.equal(repositoryImageChecksRequired(source, { ...source, entries: source.entries.map(entry => entry.path.endsWith('index.ts') ? { ...entry, mode: '100755' } : entry) }), true);
});

test('preparation binds source, policy and scope but remains unregistered and cannot claim protected behavioural evidence', async () => {
  const manifest = add('apps/web/src/New.tsx');
  const candidate = { id: 'candidate', digest: 'sha256:' + 'b'.repeat(64), commit: 'a'.repeat(40), commitBytesDigest: 'sha256:' + 'c'.repeat(64), parent: 'b'.repeat(40), manifestDigest: await digest(manifest) };
  const input = { scope, candidate, manifest, base, evaluation };
  const prepared = await prepareConfidenceRepositoryChecks(input);
  assert.equal(prepared.registration, 'unregistered');
  assert.equal(prepared.evidenceClass, 'repository-check');
  assert.equal(prepared.imagesRequired, false);
  assert.ok(prepared.qualificationRequired.includes('separately-pinned-weft-journey'));
  assert.equal((await prepareConfidenceRepositoryChecks(input)).preparationDigest, prepared.preparationDigest);
  assert.notEqual((await prepareConfidenceRepositoryChecks({ ...input, evaluation: { ...evaluation, policyRevision: '2' } })).preparationDigest, prepared.preparationDigest);
  assert.notEqual((await prepareConfidenceRepositoryChecks({ ...input, scope: { ...scope, projectIncarnation: 'other' } })).preparationDigest, prepared.preparationDigest);
  await assert.rejects(prepareConfidenceRepositoryChecks({ ...input, candidate: { ...candidate, manifestDigest: 'sha256:' + 'f'.repeat(64) } }), /SOURCE_IDENTITY_MISMATCH/);
});
