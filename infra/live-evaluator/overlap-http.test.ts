// SPDX-License-Identifier: Apache-2.0
// Owned loopback fixtures only. These local assertions are not protected evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { initializeKernel } from '../../packages/protocol/src/node.ts';
import { decodeBase64, digest, sha256 } from '../../packages/protocol/src/index.ts';
import { runOverlappingReadWrite, validOverlapStoreTrace, type ProbeResponse, type ReadBarrierControl } from '../../workers/evaluator/overlap.ts';
import { buildSequentiallyFixedFiles, buildSource, fixturePaths } from './source.ts';

await initializeKernel();
const base = Object.fromEntries(await Promise.all(fixturePaths.map(async path => [path, await readFile(resolve('fixtures/collaboration-demo', path), 'utf8')])));
const sequential = buildSequentiallyFixedFiles(base);
const fixedSource = await buildSource(base, 'good', '90d78b11-843d-405c-9f19-876ef6f0c751');
const fixedBlobs = await Promise.all(fixedSource.objects.filter(object => object.type === 'blob').map(async object => ({ digest: await sha256(decodeBase64(object.dataBase64)), bytes: decodeBase64(object.dataBase64) })));
const fixed = Object.fromEntries(fixedSource.manifest.entries.map(entry => [entry.path, new TextDecoder().decode(fixedBlobs.find(blob => blob.digest === entry.digest)!.bytes)]));
const retrying: Record<string, string> = { ...fixed, 'cache.mjs': fixed['cache.mjs'].replace('  const value = await readStore();', '  const value = await readStore();\n  if (generation !== cacheGeneration) return readValue(readStore);') };

test('overlap regression pins the exact reviewed c0 source, with only a cache generation guard in the good fixture', async () => {
  const entries = await Promise.all(fixturePaths.map(async path => ({ path, mode: '100644', bytes: String(new TextEncoder().encode(sequential[path]).length), digest: await sha256(new TextEncoder().encode(sequential[path])) })));
  assert.equal(await digest({ schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries }), 'sha256:b6ee12bbe9554ba65893a4e1924fa19188710b1db878937347de03f33a4ab084');
  assert.equal(entries[0].digest, 'sha256:5cf32521dcea3041c6b59bc9bfc1582b452a07d40095ee0eaffc6b5beea4d1c7');
  assert.equal(await sha256(new TextEncoder().encode(fixed['cache.mjs'])), 'sha256:91a67f55ecbd9b2f312e79eaeb21ad5a7b6e74d4e5d40c573795adca51b73ffd');
  for (const path of fixturePaths.slice(1)) assert.equal(fixed[path], sequential[path], path);
  const guardedBaseline = { ...base, 'cache.mjs': fixed['cache.mjs'].replace('// Read cache enabled with a 60-second TTL.', "// Baseline: cache is intentionally disabled. A's declared task enables this TTL.").replace('export const cacheTtlMs = 60000;', 'export const cacheTtlMs = 0;') };
  assert.deepEqual(buildSequentiallyFixedFiles(guardedBaseline), sequential, 'Historical concurrency-bad bytes stay pinned even when fresh local demos carry the guard.');
  assert.deepEqual(await buildSource(guardedBaseline, 'good', '90d78b11-843d-405c-9f19-876ef6f0c751'), fixedSource);
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

for (const [name, files, expected, overlappingValue] of [['reviewed sequential source', sequential, 'FAIL', 'initial'], ['generation guarded source', fixed, 'PASS', 'initial'], ['retrying generation guarded source', retrying, 'PASS', 'replacement']] as const) {
  test(`actual HTTP protected overlap sequence: ${name} returns ${expected}`, { timeout: 12000 }, async () => {
    const initial = 101, replacement = 202, dir = await mkdtemp(join(tmpdir(), 'owned-overlap-http-'));
    let stored = initial, reads = 0, armed = false, closed = false, rejectWrite = false;
    const captured = deferred<{ capturedValue: number; reads: number }>(), released = deferred<void>();
    const timeline: string[] = [], observations: unknown[] = [];
    const accesses: { method: string; value: number }[] = [];
    const fixture: ReadBarrierControl = {
      async armReadBarrier() { assert.equal(armed, false); armed = true; timeline.push('armed'); },
      waitForReadCapture() { return captured.promise; },
      async releaseReadBarrier() { timeline.push('released'); released.resolve(); },
      async close() { closed = true; timeline.push('closed'); released.resolve(); },
    };
    const store = http.createServer(async (request, response) => {
      try {
        if (request.url !== '/store/value' || request.headers.authorization !== 'Bearer owned-local-only' || closed) { response.writeHead(403).end(); return; }
        if (request.method === 'GET') {
          const value = stored; reads++; accesses.push({ method: 'GET', value });
          if (armed && reads === 1) {
            timeline.push('old-read-captured'); captured.resolve({ capturedValue: value, reads }); await released.promise;
            if (closed) { response.writeHead(410).end(); return; }
            timeline.push('old-read-returned');
          } else timeline.push('fresh-store-read');
          response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ value })); return;
        }
        if (request.method === 'PUT') {
          if (rejectWrite) { response.writeHead(503).end(); return; }
          let raw = ''; for await (const chunk of request) raw += chunk;
          stored = JSON.parse(raw).value; accesses.push({ method: 'PUT', value: stored }); timeline.push('write-committed');
          response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ value: stored })); return;
        }
        response.writeHead(405).end();
      } catch { response.writeHead(500).end(); }
    });
    await new Promise<void>(done => store.listen(0, '127.0.0.1', done));
    const address = store.address(); assert.ok(address && typeof address !== 'string');
    for (const path of fixturePaths) await writeFile(join(dir, path), files[path]);
    const child = spawn(process.execPath, ['server.mjs'], { cwd: dir, env: { PORT: '0', BIND_HOST: '127.0.0.1', FIXTURE_STORE_URL: `http://127.0.0.1:${address.port}/store/value`, FIXTURE_DATA_TOKEN: 'owned-local-only' }, stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = new Promise<void>(done => child.once('exit', () => done()));
    const timer = setTimeout(() => { void fixture.close(); store.closeAllConnections(); child.kill('SIGKILL'); }, 10000);
    try {
      const origin = await new Promise<string>((done, reject) => {
        let output = ''; child.once('error', reject); child.once('exit', () => reject(new Error('OWNED_CHILD_EXIT_BEFORE_READY')));
        child.stdout.on('data', chunk => { output += chunk.toString(); for (const line of output.split('\n')) { try { const event = JSON.parse(line); if (event.type === 'ready') done(`http://127.0.0.1:${event.port}`); } catch {} } });
      });
      async function probe(method: 'GET' | 'PUT', timeoutMs: number, value?: number): Promise<ProbeResponse> {
        const response = await fetch(origin + '/value', { method, signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json' }, body: method === 'PUT' ? JSON.stringify({ value }) : undefined });
        const bytes = new Uint8Array(await response.arrayBuffer()); let observed: number | null = null;
        try { observed = JSON.parse(new TextDecoder().decode(bytes)).value; } catch { /* Error response has no value. */ }
        return { status: response.status, observed, responseDigest: await sha256(bytes) };
      }
      const outcome = await runOverlappingReadWrite({ fixture, initial, replacement, deadline: Date.now() + 5000,
        read: timeout => probe('GET', timeout),
        write: async value => { const response = await probe('PUT', 2000, value); timeline.push('write-acknowledged'); return response; },
        continuation: async () => { assert.equal(closed, false); }, observations });
      assert.equal(outcome, expected);
      assert.deepEqual(timeline.slice(0, 6), ['armed', 'old-read-captured', 'write-committed', 'write-acknowledged', 'released', 'old-read-returned']);
      assert.deepEqual(observations.map(value => (value as any).action), ['overlap-captured', 'write', 'overlap-released', 'overlap-read', 'read']);
      const old = observations[3] as ProbeResponse, fresh = observations[4] as ProbeResponse;
      assert.equal(old.observed, overlappingValue === 'initial' ? initial : replacement); assert.equal(old.status, 200); assert.equal(stored, replacement);
      assert.deepEqual((observations[3] as any).expectedOneOf, [initial, replacement]);
      assert.equal(fresh.observed, expected === 'PASS' ? replacement : initial);
      assert.equal(reads, expected === 'PASS' ? 2 : 1);
      assert.equal(validOverlapStoreTrace({ value: stored, reads, accesses }, initial, replacement), true);
      const cachedReads = reads;
      assert.equal((await probe('GET', 2000)).observed, fresh.observed);
      assert.equal(reads, cachedReads, 'The generation fence must retain read/read caching.');
      rejectWrite = true;
      assert.equal((await probe('PUT', 2000, 303)).status, 500);
      assert.equal((await probe('GET', 2000)).observed, fresh.observed);
      assert.equal(stored, replacement); assert.equal(reads, cachedReads, 'A rejected write retains the existing cache semantics.');
    } finally {
      clearTimeout(timer); await fixture.close();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited; store.closeAllConnections(); await new Promise<void>(done => store.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  });
}
