// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { digestBytes } from '../shared/errors';
import { ObjectStore } from '../shared/objects';
import { previewSourceFiles, type PreviewSource } from './source-preview';

const encode = (value: string) => new TextEncoder().encode(value);
const object = (value: Uint8Array) => ({ size: value.length, body: new Blob([value.slice().buffer]).stream() });

test('32 source-preview entries reuse seven verified R2 blobs without changing their displayed bytes', async () => {
  const values = Array.from({ length: 7 }, (_, index) => `verified-content-${index}`);
  const blobs = await Promise.all(values.map(async value => ({ digest: await digestBytes(encode(value)), bytes: encode(value) })));
  const byDigest = new Map(blobs.map(item => [item.digest, item.bytes]));
  let gets = 0;
  const store = new ObjectStore({ get: async (key: string) => {
    gets++;
    const value = byDigest.get(`sha256:${key.slice('objects/sha256/'.length)}`);
    return value ? object(value) : null;
  } } as R2Bucket);
  const sources: PreviewSource[] = Array.from({ length: 8 }, (_, source) => ({
    commit: `source-${source}`,
    manifest: { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: Array.from({ length: 4 }, (_, file) => {
      const blob = blobs[(source * 4 + file) % blobs.length]!;
      return { path: `file-${file}.mjs`, mode: '100644' as const, bytes: String(blob.bytes.length), digest: blob.digest };
    }) },
  }));

  const result = await previewSourceFiles(sources, (digest, maximum) => store.get(digest, maximum));
  assert.equal(gets, 7, 'the 32 entries must trigger only seven digest-verified R2 reads');
  assert.equal(Object.keys(result).length, 8);
  for (let source = 0; source < 8; source++) for (let file = 0; file < 4; file++) {
    assert.equal(result[`source-${source}`]?.[`file-${file}.mjs`], values[(source * 4 + file) % values.length]);
  }
});

test('preview limit counts repeated entries and failed reads are retryable', async () => {
  const large = encode('x'.repeat(70 * 1024));
  let largeReads = 0;
  const capped = await previewSourceFiles([
    { commit: 'first', manifest: { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [{ path: 'a.mjs', mode: '100644', bytes: String(large.length), digest: 'large' }] } },
    { commit: 'second', manifest: { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [{ path: 'b.mjs', mode: '100644', bytes: String(large.length), digest: 'large' }] } },
  ], async () => { largeReads++; return large; });
  assert.equal(capped.first?.['a.mjs'], 'x'.repeat(70 * 1024));
  assert.deepEqual(capped.second, {});
  assert.equal(largeReads, 1);

  let attempts = 0;
  const retried = await previewSourceFiles([{ commit: 'retry', manifest: { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [
    { path: 'a.mjs', mode: '100644', bytes: '2', digest: 'same' },
    { path: 'b.mjs', mode: '100644', bytes: '2', digest: 'same' },
  ] } }], async () => { if (++attempts === 1) throw Error('transient'); return encode('ok'); });
  assert.equal(attempts, 2);
  assert.deepEqual(retried.retry, { 'b.mjs': 'ok' });
});

test('a UTF-8 decodable file with binary control bytes is omitted from the text preview', async () => {
  const binary = new Uint8Array([65, 0, 66]);
  const preview = await previewSourceFiles([{ commit: 'binary', manifest: { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [
    { path: 'payload.bin', mode: '100644', bytes: String(binary.length), digest: await digestBytes(binary) },
  ] } }], async () => binary);
  assert.deepEqual(preview.binary, {});
});

test('a selected source repeated by history retains its first complete bounded preview', async () => {
  const content = encode('x'.repeat(70 * 1024));
  const selected: PreviewSource = { commit: 'selected', manifest: { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [
    { path: 'cache.mjs', mode: '100644', bytes: String(content.length), digest: 'selected-content' },
  ] } };
  let reads = 0;
  const preview = await previewSourceFiles([selected, selected], async () => { reads++; return content; });
  assert.equal(preview.selected?.['cache.mjs'], 'x'.repeat(70 * 1024));
  assert.equal(reads, 1);
});
