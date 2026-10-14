// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authoringPrompt, promptSourceContext } from './context';

const attempt = { assignment: 'Only edit mutation.mjs; cache.mjs is read-only context.', goalRevision: 'goal-1', workBase: 'a'.repeat(40), allowedPaths: ['mutation.mjs'], readOnlyContextPaths: ['cache.mjs'] };
const manifest = { entries: [{ path: 'cache.mjs', digest: 'cache-digest' }, { path: 'mutation.mjs', digest: 'mutation-digest' }, { path: 'presentation.mjs', digest: 'presentation-digest' }] };
const source = new Map([['cache-digest', new TextEncoder().encode('export function invalidate() { cached = null; }\n')], ['mutation-digest', new TextEncoder().encode("import { invalidate } from './cache.mjs';\n")], ['presentation-digest', new TextEncoder().encode('private, unrelated source')]]);

test('repair prompt labels immutable adjacent source as context only and never widens write paths', async () => {
  const reads: string[] = [];
  const selected = await promptSourceContext(attempt, manifest, async (digest, maximum) => {
    reads.push(digest);
    const bytes = source.get(digest)!;
    assert.ok(bytes.length <= maximum);
    return bytes;
  });
  assert.deepEqual(reads, ['cache-digest', 'mutation-digest']);
  assert.deepEqual(Object.keys(selected.editableSource), ['mutation.mjs']);
  assert.deepEqual(Object.keys(selected.readOnlySource), ['cache.mjs']);
  const rendered = JSON.parse(authoringPrompt(attempt, 'sha256:manifest', selected.editableSource, null, null, null, selected.readOnlySource));
  assert.deepEqual(rendered.sourcePermissions, { editablePaths: ['mutation.mjs'], contextOnlyPaths: ['cache.mjs'] });
  assert.equal(rendered.untrustedReadOnlySource['cache.mjs'], new TextDecoder().decode(source.get('cache-digest')));
  assert.equal(rendered.untrustedSource['mutation.mjs'], new TextDecoder().decode(source.get('mutation-digest')));
  assert.equal(rendered.untrustedSource['cache.mjs'], undefined);
  assert.equal(rendered.untrustedReadOnlySource['mutation.mjs'], undefined);
  assert.equal(rendered.untrustedSource['presentation.mjs'], undefined);
  const ordinary = JSON.parse(authoringPrompt({ ...attempt, allowedPaths: ['mutation.mjs'] }, 'sha256:manifest', selected.editableSource));
  assert.equal(ordinary.untrustedReadOnlySource, undefined);
  assert.equal(ordinary.sourcePermissions, undefined);
});

test('read-only source must fit its own 16 KiB cap and the combined 128 KiB cap', async () => {
  await assert.rejects(promptSourceContext(attempt, manifest, async (digest, maximum) => {
    if (digest === 'cache-digest') assert.equal(maximum, 16 * 1024);
    return new Uint8Array(maximum + 1);
  }), /ASSIGNMENT_CONTEXT_LIMIT|SIZE_LIMIT/);
  await assert.rejects(promptSourceContext(attempt, manifest, async (digest, maximum) => {
    if (digest === 'cache-digest') return new Uint8Array(16 * 1024);
    assert.equal(maximum, 128 * 1024);
    return new Uint8Array(128 * 1024);
  }), /ASSIGNMENT_CONTEXT_LIMIT/);
});

test('missing or overlapping source paths fail before a repair prompt can be retained', async () => {
  const read = async (digest: string) => source.get(digest)!;
  await assert.rejects(promptSourceContext({ ...attempt, readOnlyContextPaths: ['mutation.mjs'] }, manifest, read), /ASSIGNMENT_CONTEXT_PATHS_INVALID/);
  await assert.rejects(promptSourceContext(attempt, { entries: manifest.entries.filter(entry => entry.path !== 'cache.mjs') }, read), /ASSIGNMENT_CONTEXT_SOURCE_MISSING/);
});
