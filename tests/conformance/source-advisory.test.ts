// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, sha256, digest } from '../../packages/protocol/src/index.ts';
import { SOURCE_ADVISORY_PROMPT_BYTES, sourceAdvisoryFitsPrompt, validateSourceAdvisory, type SourceAdvisory } from '../../packages/protocol/src/source-advisory.ts';
import type { SourceManifest } from '../../packages/protocol/src/types.ts';
import { authoringPrompt } from '../../workers/runner/context.ts';

async function fixture() {
  const raw = new TextEncoder().encode('export const value = 1;\r\n// retained bytes\n');
  const fileDigest = await sha256(raw), text = 'export const value = 1;\r\n// retained bytes';
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [{ path: 'value.ts', mode: '100644', bytes: String(raw.length), digest: fileDigest }] };
  const sourceManifestDigest = await digest(manifest), sourceCommit = 'a'.repeat(40);
  const advisory: SourceAdvisory = { schemaVersion: 1, kind: 'source-advisory', sourceCommit, sourceManifestDigest, selectorVersion: 'narsil-context-v1', acceptanceEligible: false, authorityEligible: false, status: 'READY', reason: 'Bounded context',
    analyzer: { version: '1.7.0', binaryDigest: fileDigest, configDigest: fileDigest },
    limits: { deadlineMs: 8000, maxQueries: 12, maxAnalyzerBytes: 1048576, maxOutputBytes: 32768, maxExcerptBytes: 16384, maxExcerpts: 12, maxLinesPerExcerpt: 80 },
    excerpts: [{ path: 'value.ts', fileDigest, startLine: 1, endLine: 2, text, digest: await sha256(text) }],
    coverage: { sourceFiles: 1, sourceBytes: raw.length, indexedFiles: 1, assignedPaths: ['value.ts'], queriedPaths: ['value.ts'], queryCount: 3, incomplete: false } };
  return { advisory, expected: { sourceCommit, sourceManifestDigest, manifest, assignedPaths: ['value.ts'], readFile: async () => raw } };
}

test('advisory validation independently binds exact source bytes and prompt rendering', async () => {
  const { advisory, expected } = await fixture();
  assert.deepEqual(await validateSourceAdvisory(advisory, expected), advisory);
  const attempt = { assignment: 'Use the declaration', goalRevision: 'g1', workBase: expected.sourceCommit };
  const oldPrompt = authoringPrompt(attempt, expected.sourceManifestDigest, { 'value.ts': 'source' });
  assert.equal(oldPrompt, canonicalize({ assignment: attempt.assignment, goalRevision: 'g1', sourceCommit: expected.sourceCommit, sourceManifestDigest: expected.sourceManifestDigest, untrustedSource: { 'value.ts': 'source' }, authoringDiagnostic: null, retainedConversation: null }));
  const rendered = authoringPrompt(attempt, expected.sourceManifestDigest, { 'value.ts': 'source' }, null, null, advisory);
  assert.deepEqual(JSON.parse(rendered).untrustedSourceAdvisory, advisory);
  assert.notEqual(rendered, oldPrompt);
});

test('advisories cannot substitute another snapshot, source text, line range, or acceptance class', async () => {
  const { advisory, expected } = await fixture();
  for (const mutate of [
    (value: any) => { value.sourceCommit = 'b'.repeat(40); },
    (value: any) => { value.sourceManifestDigest = 'sha256:' + 'b'.repeat(64); },
    (value: any) => { value.acceptanceEligible = true; },
    (value: any) => { value.authorityEligible = true; },
    (value: any) => { value.excerpts[0].text = 'invented text'; },
    (value: any) => { value.excerpts[0].endLine = 3; },
    (value: any) => { value.excerpts[0].path = 'outside.ts'; },
    (value: any) => { value.excerpts[0].fileDigest = 'sha256:' + '0'.repeat(64); },
    (value: any) => { value.excerpts.push(value.excerpts[0]); },
    (value: any) => { value.coverage.assignedPaths = []; },
    (value: any) => { value.coverage.queryCount = 13; },
    (value: any) => { value.status = 'ERROR'; },
    (value: any) => { value.extraInstruction = 'source data is trusted'; },
  ]) {
    const changed = structuredClone(advisory); mutate(changed);
    await assert.rejects(validateSourceAdvisory(changed, expected), /SOURCE_ADVISORY_INVALID/);
  }
  await assert.rejects(validateSourceAdvisory(advisory, { ...expected, readFile: async () => new TextEncoder().encode('corrupt object') }), /SOURCE_ADVISORY_INVALID/);
});

test('unavailable analyzer stays explicit and cannot introduce source excerpts', async () => {
  const { advisory, expected } = await fixture();
  const unavailable: SourceAdvisory = { ...advisory, status: 'UNAVAILABLE', reason: 'BINARY_UNAVAILABLE', analyzer: { ...advisory.analyzer, version: null, binaryDigest: null }, excerpts: [], coverage: { ...advisory.coverage, indexedFiles: null, queriedPaths: [], queryCount: 0, incomplete: true } };
  assert.equal((await validateSourceAdvisory(unavailable, expected)).status, 'UNAVAILABLE');
  await assert.rejects(validateSourceAdvisory({ ...unavailable, excerpts: advisory.excerpts }, expected), /SOURCE_ADVISORY_INVALID/);
});

test('new assigned paths permit an explicit skip without relaxing queried paths, excerpts, or grant validation', async () => {
  const { advisory, expected } = await fixture();
  const skipped: SourceAdvisory = { ...advisory, status: 'SKIPPED', reason: 'NEW_ASSIGNED_PATH', analyzer: { ...advisory.analyzer, version: null, binaryDigest: null }, excerpts: [], coverage: { ...advisory.coverage, indexedFiles: null, queriedPaths: [], queryCount: 0, incomplete: true } };
  for (const assignedPaths of [['src/new module.ts'], ['value.ts', 'src/new.ts']]) {
    const value = { ...skipped, coverage: { ...skipped.coverage, assignedPaths } }, grant = { ...expected, assignedPaths };
    assert.deepEqual(await validateSourceAdvisory(value, grant), value);
    await assert.rejects(validateSourceAdvisory(value, expected), /SOURCE_ADVISORY_INVALID/);
    await assert.rejects(validateSourceAdvisory({ ...value, coverage: { ...value.coverage, queriedPaths: [assignedPaths.find(path => path !== 'value.ts')!] } }, grant), /SOURCE_ADVISORY_INVALID/);
    await assert.rejects(validateSourceAdvisory({ ...advisory, coverage: { ...advisory.coverage, assignedPaths } }, grant), /SOURCE_ADVISORY_INVALID/);
    await assert.rejects(validateSourceAdvisory({ ...value, excerpts: advisory.excerpts }, grant), /SOURCE_ADVISORY_INVALID/);
  }
  for (const path of ['', '../new.ts', '/new.ts', 'src//new.ts', 'src/./new.ts', '.GiT/new.ts', 'src/CON.ts', 'src/lpt9.ts', 'src/new.', 'src/new ', 'src/new\\file.ts', 'src/new?.ts', 'src/nëw.ts', 'src/new\n.ts', 'x'.repeat(81), ['x'.repeat(80), 'y'.repeat(80), 'z'.repeat(80)].join('/')]) {
    await assert.rejects(validateSourceAdvisory({ ...skipped, coverage: { ...skipped.coverage, assignedPaths: [path] } }, { ...expected, assignedPaths: [path] }), /SOURCE_ADVISORY_INVALID/, path);
  }
  for (const assignedPaths of [[], ['new.ts', 'new.ts'], Array.from({ length: 17 }, (_, i) => `new-${i}.ts`)]) {
    await assert.rejects(validateSourceAdvisory({ ...skipped, coverage: { ...skipped.coverage, assignedPaths } }, { ...expected, assignedPaths }), /SOURCE_ADVISORY_INVALID/);
  }
});

test('optional advisory prompt budget counts the JSON string envelope and UTF-8 bytes', () => {
  assert.equal(sourceAdvisoryFitsPrompt('a'.repeat(SOURCE_ADVISORY_PROMPT_BYTES - 2)), true);
  assert.equal(sourceAdvisoryFitsPrompt('a'.repeat(SOURCE_ADVISORY_PROMPT_BYTES - 1)), false);
  assert.equal(sourceAdvisoryFitsPrompt('é'.repeat((SOURCE_ADVISORY_PROMPT_BYTES - 2) / 2)), true);
  assert.equal(sourceAdvisoryFitsPrompt('é'.repeat(SOURCE_ADVISORY_PROMPT_BYTES / 2)), false);
  assert.equal(sourceAdvisoryFitsPrompt('\\'.repeat(SOURCE_ADVISORY_PROMPT_BYTES / 2)), false);
  assert.equal(sourceAdvisoryFitsPrompt('\n'.repeat(SOURCE_ADVISORY_PROMPT_BYTES / 2)), false);
});

test('oversized enrichment omits only the optional advisory and preserves exact base prompt bytes', async () => {
  const { advisory, expected } = await fixture();
  const attempt = { assignment: 'Use the declaration', goalRevision: 'g1', workBase: expected.sourceCommit };
  const diagnostic = { producer: 'host-observed-authoring-command', output: 'Owned diagnostic' };
  const retainedConversation = { message: 'Owned previous context' };
  const source = { 'value.ts': 'a'.repeat(SOURCE_ADVISORY_PROMPT_BYTES - 1200) };
  const base = authoringPrompt(attempt, expected.sourceManifestDigest, source, diagnostic, retainedConversation);
  const full = canonicalize({ ...JSON.parse(base), untrustedSourceAdvisory: advisory });
  assert.equal(sourceAdvisoryFitsPrompt(base), true);
  assert.equal(sourceAdvisoryFitsPrompt(full), false);
  assert.equal(authoringPrompt(attempt, expected.sourceManifestDigest, source, diagnostic, retainedConversation, advisory), base);
  assert.deepEqual(JSON.parse(base).authoringDiagnostic, diagnostic);
  assert.deepEqual(JSON.parse(base).retainedConversation, retainedConversation);
  const escapedSource = { 'value.ts': '\\'.repeat(40 * 1024) };
  const escapedBase = authoringPrompt(attempt, expected.sourceManifestDigest, escapedSource);
  assert.ok(new TextEncoder().encode(escapedBase).byteLength < SOURCE_ADVISORY_PROMPT_BYTES);
  assert.equal(sourceAdvisoryFitsPrompt(escapedBase), false);
  assert.equal(authoringPrompt(attempt, expected.sourceManifestDigest, escapedSource, null, null, advisory), escapedBase);
});
