// SPDX-License-Identifier: Apache-2.0
// Run with: node --import tsx scripts/benchmark-authoring-hydration.ts
// The reference is the previous runner hydration loop. Both paths preserve
// the same output bytes and modes; the optimized path additionally checks
// leaf type, size and mode before readback. Counts use local mocked boundaries.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { initializeKernel } from '../packages/protocol/src/node';
import { sha256, type SourceManifest } from '../packages/protocol/src/index';
import { readBounded } from '../workers/shared/errors';
import { hydrateAuthoringSource } from '../workers/runner/hydration';

await initializeKernel();

type Mode = '644' | '755';
function mockBoundary(source: Map<string, Uint8Array>) {
  const directories = new Set(['/workspace']);
  const files = new Map<string, { bytes: Uint8Array; mode: Mode }>();
  const calls = { objectGet: 0, objectHead: 0, objectReadback: 0, mkdir: 0, writeFile: 0, chmod: 0, readFile: 0, lstat: 0 };
  const io = {
    async mkdir(path: string, _options: { recursive: true }) {
      calls.mkdir++;
      let current = '';
      for (const component of path.split('/').filter(Boolean)) { current += `/${component}`; directories.add(current); }
    },
    async lstat(path: string) {
      calls.lstat++;
      const value = files.get(path);
      return {
        type: directories.has(path) ? 'directory' : value ? 'file' : 'missing',
        size: BigInt(value?.bytes.length ?? 0),
        mode: value ? Number.parseInt(value.mode, 8) : 0o755,
      };
    },
    async writeFile(path: string, bytes: Uint8Array) {
      calls.writeFile++;
      assert.ok(directories.has(path.slice(0, path.lastIndexOf('/'))));
      files.set(path, { bytes: bytes.slice(), mode: '644' });
    },
    async readFile(path: string) {
      calls.readFile++;
      const value = files.get(path); assert.ok(value);
      return new Response(value.bytes.slice().buffer);
    },
    async chmod(mode: Mode, paths: string[]) {
      calls.chmod++;
      for (const path of paths) { const value = files.get(path); assert.ok(value); value.mode = mode; }
    },
  };
  const objects = {
    async get(digest: string, _maximum: number) {
      calls.objectGet++;
      const bytes = source.get(digest); assert.ok(bytes);
      assert.equal(await sha256(bytes), digest, 'ObjectStore.get verifies the content address');
      return bytes.slice();
    },
    async put(bytes: Uint8Array) {
      // The source object already exists. ObjectStore.put first checks HEAD,
      // then reads the retained object back, even for a duplicate digest.
      calls.objectHead++; calls.objectReadback++;
      const digest = await sha256(bytes);
      assert.deepEqual(source.get(digest), bytes);
      return digest;
    },
  };
  return { io, objects, files, calls };
}

async function reference(manifest: SourceManifest, boundary: ReturnType<typeof mockBoundary>) {
  for (const entry of manifest.entries) {
    const data = await boundary.objects.get(entry.digest, 1024 * 1024);
    const path = `/workspace/${entry.path}`;
    await boundary.io.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await boundary.io.writeFile(path, data);
    await boundary.io.chmod(entry.mode === '100755' ? '755' : '644', [path]);
    const response = await boundary.io.readFile(path);
    assert.equal(await boundary.objects.put(await readBounded(response.body, 1024 * 1024)), entry.digest);
  }
}

const results = [];
for (const count of [4, 100, 1000]) {
  const originals = new Map<string, Uint8Array>();
  const entries: SourceManifest['entries'] = [];
  for (let index = 0; index < count; index++) {
    const path = `dir${String(Math.floor(index / 100)).padStart(2, '0')}/file${String(index).padStart(4, '0')}.bin`;
    const bytes = index % 10 === 9 ? originals.get(`dir${String(Math.floor((index - 1) / 100)).padStart(2, '0')}/file${String(index - 1).padStart(4, '0')}.bin`)!.slice() : Uint8Array.from({ length: 1024 }, (_, byte) => byte < 4 ? (index >>> (24 - byte * 8)) & 255 : (index + byte * 17) & 255);
    originals.set(path, bytes);
    entries.push({ path, mode: index % 7 === 0 ? '100755' : '100644', bytes: String(bytes.length), digest: await sha256(bytes) });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries };
  const objects = new Map(entries.map(entry => [entry.digest, originals.get(entry.path)!]));
  const measure = async (label: 'reference' | 'optimized') => {
    const boundary = mockBoundary(objects), start = performance.now();
    if (label === 'reference') await reference(manifest, boundary);
    else await hydrateAuthoringSource(manifest, boundary.objects, boundary.io, boundary.io.chmod, false);
    const elapsedMs = +(performance.now() - start).toFixed(1);
    for (const entry of entries) {
      const file = boundary.files.get(`/workspace/${entry.path}`); assert.ok(file);
      assert.deepEqual(file.bytes, originals.get(entry.path));
      assert.equal(file.mode, entry.mode === '100755' ? '755' : '644');
      assert.equal(await sha256(file.bytes), entry.digest);
    }
    return { elapsedMs, calls: boundary.calls, totalBoundaryCalls: Object.values(boundary.calls).reduce((a, b) => a + b, 0), exactBytesModesAndDigests: true };
  };
  const samples: Record<'reference' | 'optimized', Awaited<ReturnType<typeof measure>>[]> = { reference: [], optimized: [] };
  for (let round = 0; round < 5; round++) {
    for (const label of (round % 2 ? ['optimized', 'reference'] : ['reference', 'optimized']) as ('reference' | 'optimized')[]) {
      samples[label].push(await measure(label));
    }
  }
  const summarize = (label: 'reference' | 'optimized') => {
    const timings = samples[label].map(sample => sample.elapsedMs).sort((a, b) => a - b);
    for (const sample of samples[label]) assert.deepEqual(sample.calls, samples[label][0].calls);
    return { medianMs: timings[2], p95Ms: timings[4], samplesMs: samples[label].map(sample => sample.elapsedMs), calls: samples[label][0].calls, totalBoundaryCalls: samples[label][0].totalBoundaryCalls, exactBytesModesAndDigests: true };
  };
  results.push({ files: count, bytes: count * 1024, distinctBlobs: objects.size, reference: summarize('reference'), optimized: summarize('optimized') });
}
const sourceFiles = ['workers/runner/index.ts', 'workers/runner/hydration.ts', 'workers/shared/objects.ts', 'scripts/benchmark-authoring-hydration.ts'];
const sourceDigests = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, 'sha256:' + createHash('sha256').update(await readFile(path)).digest('hex')])));
console.log(JSON.stringify({ schemaVersion: 1, kind: 'paired-local-mock-authoring-hydration-comparison', date: '2026-10-08', command: 'node --import tsx scripts/benchmark-authoring-hydration.ts', environment: { node: process.version, platform: process.platform, arch: process.arch }, inputs: { fileCounts: [4, 100, 1000], bytesPerFile: 1024, fiveAlternatingPairedRuns: true, sameManifestAndObjects: true, optimizedAddsLeafTypeSizeModeChecks: true, repeatedBlobAtEveryTenthPath: true, executableAtEverySeventhPath: true, sourceDigests }, results, limitations: ['Local mocked Files and R2 boundaries, not Cloudflare RPC latency or billable operation counts.', 'Five in-process timing samples per size remain illustrative; there is no native container or network latency in the timing.', 'Reference reproduces the previous runner hydration loop with the object already present; the optimized path additionally checks leaf type, size and mode. Native container, Git clone, model, and end-to-end journey time are excluded.'] }, null, 2));
