import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, getHashes, webcrypto } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, release } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  output: { type: 'string' },
  samples: { type: 'string', default: '7' },
  'target-ms': { type: 'string', default: '40' },
} });
const sampleCount = Number(values.samples);
const targetMs = Number(values['target-ms']);
assert(Number.isInteger(sampleCount) && sampleCount >= 3 && sampleCount <= 31, 'samples must be 3..31');
assert(Number.isInteger(targetMs) && targetMs >= 10 && targetMs <= 1000, 'target-ms must be 10..1000');

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const blakePackagePath = wranglerRequire.resolve('blake3-wasm/package.json');
const blakePackage = JSON.parse(readFileSync(blakePackagePath, 'utf8'));
const wasmPath = resolve(dirname(blakePackagePath), 'dist/wasm/nodejs/blake3_js_bg.wasm');
const moduleStarted = performance.now();
const blake3 = wranglerRequire('blake3-wasm');
const moduleLoadMs = performance.now() - moduleStarted;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function input(length) {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index++) bytes[index] = index % 251;
  return bytes;
}

// First 32 output bytes from the upstream unkeyed known-answer vectors.
const vectorSource = 'https://github.com/BLAKE3-team/BLAKE3/blob/f55849f89cd85083c1c9daa2c5de20766f309c00/test_vectors/test_vectors.json';
const vectors = [
  [0, 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'],
  [1, '2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213'],
  [64, '4eed7141ea4a5cd4b788606bd23f46e212af9cacebacdc7d1f4c6dc7f2511b98'],
  [1024, '42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7'],
  [1025, 'd00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444'],
  [2048, 'e776b6028c7cd22a4d0ba182a8bf62205d2ef576467e838ed6f2529b85fba24a'],
];
for (const [length, expected] of vectors) {
  assert.equal(blake3.hash(input(length)).toString('hex'), expected, `BLAKE3 vector ${length}`);
}

const methods = [
  { name: 'sha256-node', hash: sha256 },
  { name: 'sha256-webcrypto', async: true, hash: async bytes => Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex') },
  { name: 'blake3-wasm', hash: bytes => blake3.hash(bytes).toString('hex') },
];
let consumed = 0;
async function measure(method, bytes, iterations) {
  const started = performance.now();
  if (method.async) {
    for (let index = 0; index < iterations; index++) consumed ^= (await method.hash(bytes)).charCodeAt(0);
  } else {
    for (let index = 0; index < iterations; index++) consumed ^= method.hash(bytes).charCodeAt(0);
  }
  return performance.now() - started;
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
const results = [];
for (const bytesLength of [0, 64, 1024, 64 * 1024, 1024 * 1024, 4 * 1024 * 1024]) {
  const bytes = input(bytesLength);
  const expectedSha256 = sha256(bytes);
  assert.equal(await methods[1].hash(bytes), expectedSha256, `SHA-256 agreement at ${bytesLength}`);
  const measurements = new Map();
  for (const method of methods) {
    await measure(method, bytes, 16);
    let iterations = 1;
    let elapsedMs = await measure(method, bytes, iterations);
    while (elapsedMs < targetMs / 2 && iterations < 65536) {
      iterations *= 2;
      elapsedMs = await measure(method, bytes, iterations);
    }
    iterations = Math.max(1, Math.min(65536, Math.ceil(iterations * targetMs / elapsedMs)));
    measurements.set(method.name, { iterations, sampleMilliseconds: [] });
  }
  // Rotate execution order so each implementation gets both early and late samples.
  for (let sample = 0; sample < sampleCount; sample++) {
    for (let offset = 0; offset < methods.length; offset++) {
      const method = methods[(sample + offset) % methods.length];
      const measurement = measurements.get(method.name);
      measurement.sampleMilliseconds.push(await measure(method, bytes, measurement.iterations));
    }
  }
  const implementations = Object.fromEntries(methods.map(method => {
    const measurement = measurements.get(method.name);
    const samples = measurement.sampleMilliseconds.map(value => value / measurement.iterations);
    const medianMillisecondsPerHash = median(samples);
    return [method.name, {
      ...measurement,
      medianMillisecondsPerHash,
      minMillisecondsPerHash: Math.min(...samples),
      maxMillisecondsPerHash: Math.max(...samples),
      medianMiBPerSecond: bytesLength === 0 ? null : bytesLength / 1024 / 1024 / (medianMillisecondsPerHash / 1000),
    }];
  }));
  const blakeMs = implementations['blake3-wasm'].medianMillisecondsPerHash;
  results.push({
    bytes: bytesLength,
    sha256: expectedSha256,
    blake3: blake3.hash(bytes).toString('hex'),
    implementations,
    blake3SpeedupOverNodeSha256: implementations['sha256-node'].medianMillisecondsPerHash / blakeMs,
    blake3SpeedupOverWebCryptoSha256: implementations['sha256-webcrypto'].medianMillisecondsPerHash / blakeMs,
  });
}

const report = {
  schemaVersion: 1,
  kind: 'local-content-hash-microbenchmark',
  observedAt: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  source: { path: relative(root, fileURLToPath(import.meta.url)), sha256: sha256(readFileSync(fileURLToPath(import.meta.url))) },
  environment: {
    node: process.version, openssl: process.versions.openssl, v8: process.versions.v8,
    platform: process.platform, arch: process.arch, release: release(), cpu: cpus()[0]?.model,
    nativeBlake3Available: getHashes().includes('blake3'),
  },
  blake3: {
    package: blakePackage.name, version: blakePackage.version, source: 'existing Wrangler development dependency; experiment only',
    wasmBytes: statSync(wasmPath).size, wasmSha256: sha256(readFileSync(wasmPath)),
    moduleLoadMs, moduleLoadScope: 'one local CommonJS import including synchronous WASM initialization; no process startup',
  },
  correctness: { vectorSource, blake3KnownAnswerLengths: vectors.map(([length]) => length), sha256AgreementAllSizes: true },
  methodology: {
    samples: sampleCount, targetMillisecondsPerSample: targetMs, inputPattern: 'byte[index] = index % 251',
    scope: 'sequential warm one-shot hashing of preallocated bytes into 64-character hex strings',
    order: 'rotated per sample; implementation-specific iteration calibration',
    excluded: ['input allocation', 'canonical JSON', 'network and storage', 'signing and verification', 'WASM module initialization'],
    speedup: 'SHA-256 milliseconds per hash divided by BLAKE3 milliseconds per hash; below 1 means BLAKE3 is slower',
  },
  limitations: [
    'Local Node wall-clock evidence only; not a Cloudflare Worker CPU, browser, or end-to-end benchmark.',
    'The existing blake3-wasm 2.1.5 artifact is not a current Rust BLAKE3 wasm32_simd build or native BLAKE3 benchmark.',
    'WASM input copies and JavaScript bindings are included; the existing Rust verifier SHA-256 implementation is not measured.',
    'Node WebCrypto asynchronous scheduling costs differ from Workers and browser runtimes.',
    'Single-machine warm medians cannot establish production savings, security improvements, or a universal algorithm ranking.',
  ],
  consumed,
  results,
};
const json = JSON.stringify(report, null, 2) + '\n';
if (values.output) {
  writeFileSync(resolve(values.output), json, { flag: 'wx' });
  console.log(`Hash benchmark written to ${values.output}`);
} else {
  process.stdout.write(json);
}
