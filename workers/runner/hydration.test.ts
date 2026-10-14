// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeKernel } from '../../packages/protocol/src/node';
import { sha256, type SourceManifest } from '../../packages/protocol/src/index';
import { hydrateAuthoringSource } from './hydration';

await initializeKernel();

function fakeFiles() {
  const directories = new Map<string, 'directory' | 'symlink'>([['/workspace', 'directory']]);
  const written = new Map<string, { bytes: Uint8Array; mode: number }>();
  const calls = { mkdir: 0, write: 0, read: 0, lstat: 0, chmod: 0 };
  let corrupt: string | undefined;
  let linkedLeaf: string | undefined;
  let reportedSize: bigint | undefined;
  let ignoreChmod = false;
  return {
    directories, written, calls,
    setCorrupt(path: string) { corrupt = path; },
    setLinkedLeaf(path: string) { linkedLeaf = path; },
    setReportedSize(size: bigint) { reportedSize = size; },
    setIgnoreChmod() { ignoreChmod = true; },
    async mkdir(path: string, _options: { recursive: true }) {
      calls.mkdir++;
      const parent = path.slice(0, path.lastIndexOf('/'));
      assert.equal(directories.get(parent), 'directory', 'a symlink parent must never be traversed');
      if (!directories.has(path)) directories.set(path, 'directory');
    },
    async lstat(path: string) {
      calls.lstat++;
      const value = written.get(path);
      return {
        type: path === linkedLeaf ? 'symlink' : directories.get(path) ?? (value ? 'file' : 'missing'),
        size: path === linkedLeaf || value ? (reportedSize ?? BigInt(value?.bytes.length ?? 0)) : 0n,
        mode: value?.mode ?? 0o755,
      };
    },
    async writeFile(path: string, bytes: Uint8Array) {
      calls.write++;
      assert.equal(directories.get(path.slice(0, path.lastIndexOf('/'))), 'directory');
      const copy = bytes.slice(); if (path === corrupt) copy[0] ^= 1;
      written.set(path, { bytes: copy, mode: 0o600 });
    },
    async readFile(path: string) {
      calls.read++;
      const value = written.get(path); assert.ok(value);
      return new Response(value.bytes.slice().buffer);
    },
    async chmod(mode: '644' | '755', paths: string[]) {
      calls.chmod++; assert.ok(paths.length > 0 && paths.length <= 64);
      for (const path of paths) { const value = written.get(path); assert.ok(value); if (!ignoreChmod) value.mode = Number.parseInt(mode, 8); }
    },
  };
}

test('runner hydration preserves exact bytes and modes while reusing an immutable blob', async () => {
  const fixture = fakeFiles(), originals = new Map<string, Uint8Array>();
  const entries: SourceManifest['entries'] = [];
  for (let i = 0; i < 100; i++) {
    const path = `dir${Math.floor(i / 25)}/file${i}.bin`;
    const bytes = i === 1 ? originals.get('dir0/file0.bin')! : Uint8Array.from([i, 0, 255, 10]);
    originals.set(path, bytes);
    entries.push({ path, mode: i % 7 === 0 ? '100755' : '100644', bytes: String(bytes.length), digest: await sha256(bytes) });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries };
  const byDigest = new Map(entries.map(entry => [entry.digest, originals.get(entry.path)!]));
  let gets = 0;
  const context = await hydrateAuthoringSource(manifest, { async get(digest) { gets++; return byDigest.get(digest)!.slice(); } }, fixture, fixture.chmod, true);
  assert.equal(gets, 99, 'identical immutable blobs need one verified object read');
  assert.equal(fixture.calls.mkdir, 4, 'directory creation is per distinct parent');
  assert.equal(fixture.calls.chmod, 3, 'modes are applied in bounded groups');
  assert.equal(fixture.calls.write, 100); assert.equal(fixture.calls.read, 100);
  for (const entry of entries) {
    const actual = fixture.written.get(`/workspace/${entry.path}`)!;
    assert.deepEqual(actual.bytes, originals.get(entry.path));
    assert.equal(actual.mode, entry.mode === '100755' ? 0o755 : 0o644);
    assert.equal(context[entry.path], Buffer.from(actual.bytes).toString('base64'));
  }
});

test('runner hydration rejects a symlink parent before writing, and rejects changed readback', async () => {
  const bytes = Uint8Array.from([0, 255, 10]);
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [{ path: 'nested/file.bin', mode: '100644', bytes: '3', digest: await sha256(bytes) }] };
  const objects = { async get() { return bytes.slice(); } };
  const linked = fakeFiles(); linked.directories.set('/workspace/nested', 'symlink');
  await assert.rejects(hydrateAuthoringSource(manifest, objects, linked, linked.chmod, false), /WORK_BASE_DIRECTORY_NOT_REGULAR/);
  assert.equal(linked.calls.write, 0);
  const corrupted = fakeFiles(); corrupted.setCorrupt('/workspace/nested/file.bin');
  await assert.rejects(hydrateAuthoringSource(manifest, objects, corrupted, corrupted.chmod, false), /WORK_BASE_HYDRATION_MISMATCH/);
  const invalid = { ...manifest, entries: [{ ...manifest.entries[0], path: '../escape.bin' }] } as SourceManifest;
  const rejected = fakeFiles();
  await assert.rejects(hydrateAuthoringSource(invalid, objects, rejected, rejected.chmod, false));
  assert.equal(rejected.calls.write, 0);
});

test('runner hydration rejects a symlink leaf before reading it', async () => {
  const bytes = Uint8Array.from([0, 255, 10]);
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [{ path: 'nested/file.bin', mode: '100644', bytes: '3', digest: await sha256(bytes) }] };
  const files = fakeFiles();
  files.setLinkedLeaf('/workspace/nested/file.bin');
  await assert.rejects(hydrateAuthoringSource(manifest, { async get() { return bytes.slice(); } }, files, files.chmod, false), /WORK_BASE_HYDRATION_NOT_REGULAR_FILE/);
  assert.equal(files.calls.read, 0);
});

test('runner hydration rejects a successful but ineffective chmod before reading', async () => {
  const bytes = Uint8Array.from([0, 255, 10]);
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [{ path: 'nested/file.bin', mode: '100755', bytes: '3', digest: await sha256(bytes) }] };
  const files = fakeFiles();
  files.setIgnoreChmod();
  await assert.rejects(hydrateAuthoringSource(manifest, { async get() { return bytes.slice(); } }, files, files.chmod, false), /WORK_BASE_HYDRATION_MODE_MISMATCH/);
  assert.equal(files.calls.chmod, 1);
  assert.equal(files.calls.read, 0);
});

test('runner hydration rejects a wrong leaf size before reading', async () => {
  const bytes = Uint8Array.from([0, 255, 10]);
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [{ path: 'nested/file.bin', mode: '100644', bytes: '3', digest: await sha256(bytes) }] };
  const files = fakeFiles();
  files.setReportedSize(4n);
  await assert.rejects(hydrateAuthoringSource(manifest, { async get() { return bytes.slice(); } }, files, files.chmod, false), /WORK_BASE_HYDRATION_SIZE_MISMATCH/);
  assert.equal(files.calls.read, 0);
});
