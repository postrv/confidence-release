// SPDX-License-Identifier: Apache-2.0
import { canonicalize, digest, encodeBase64, getKernel, sha256, type GitObject, type SourceManifest } from '../../packages/protocol/src/index';
import type { FixtureName, SourcePackage } from './types';
const encoder = new TextEncoder();
export const fixturePaths = ['cache.mjs', 'mutation.mjs', 'presentation.mjs', 'server.mjs'] as const;
function ensure(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
async function oid(type: string, bytes: Uint8Array): Promise<string> {
  const prefix = encoder.encode(`${type} ${bytes.length}\0`), input = new Uint8Array(prefix.length + bytes.length); input.set(prefix); input.set(bytes, prefix.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', input))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Sequentially repaired source, matching the reviewed pilot's four file bytes. */
export function buildSequentiallyFixedFiles(base: Record<string, string>): Record<string, string> {
  ensure(Object.keys(base).sort().join(',') === [...fixturePaths].sort().join(','), 'FIXTURE_INVENTORY_CHANGED');
  ensure(base['cache.mjs'].startsWith("// Baseline: cache is intentionally disabled. A's declared task enables this TTL.\nexport const cacheTtlMs = 0;") && base['mutation.mjs'].startsWith("import { invalidate } from './cache.mjs';\nexport") && base['mutation.mjs'].includes('  invalidate();'), 'FIXTURE_TRANSFORM_CHANGED');
  // New local demos may already contain the generation guard with caching
  // disabled. Reconstruct the exact historical negative control explicitly.
  let cache = base['cache.mjs'];
  if (cache.includes('cacheGeneration')) {
    for (const part of ['let cacheGeneration = {};\n', '  const generation = cacheGeneration;\n', 'cacheTtlMs > 0 && generation === cacheGeneration', 'cacheGeneration = {}; cached = undefined;']) ensure(cache.includes(part), 'FIXTURE_TRANSFORM_CHANGED');
    cache = cache.replace('let cacheGeneration = {};\n', '').replace('  const generation = cacheGeneration;\n', '')
      .replace('cacheTtlMs > 0 && generation === cacheGeneration', 'cacheTtlMs > 0').replace('cacheGeneration = {}; cached = undefined;', 'cached = undefined;');
  }
  return { ...base, 'cache.mjs': cache.replace("// Baseline: cache is intentionally disabled. A's declared task enables this TTL.", '// Read cache enabled with a 60-second TTL.').replace('export const cacheTtlMs = 0;', 'export const cacheTtlMs = 60000;'),
    'mutation.mjs': base['mutation.mjs'].replace("import { invalidate } from './cache.mjs';\n", "import { invalidate } from './cache.mjs';\n\n"),
    'presentation.mjs': 'export function renderStatus(value) {\n  return `<!doctype html><html lang="en"><head><title>Shared value</title></head><body><main><h1>Shared value</h1><p role="status" aria-live="polite" aria-label="Saved value">Saved value: ${value}</p></main></body></html>`;\n}\n' };
}
/** Exact tracked demo source with predeclared, inspectable transformations. */
export async function buildSource(base: Record<string, string>, name: FixtureName, runId: string): Promise<SourcePackage> {
  const files = buildSequentiallyFixedFiles(base);
  if (name === 'good') {
    const cache = files['cache.mjs'];
    ensure(cache.includes('let cached;\n') && cache.includes('  const value = await readStore();') && cache.includes('if (cacheTtlMs > 0) cached =') && cache.includes('export function invalidate() { cached = undefined; }'), 'FIXTURE_TRANSFORM_CHANGED');
    files['cache.mjs'] = cache.replace('let cached;\n', 'let cached;\nlet cacheGeneration = {};\n')
      .replace('  const value = await readStore();', '  const generation = cacheGeneration;\n  const value = await readStore();')
      .replace('if (cacheTtlMs > 0) cached =', 'if (cacheTtlMs > 0 && generation === cacheGeneration) cached =')
      .replace('export function invalidate() { cached = undefined; }', 'export function invalidate() { cacheGeneration = {}; cached = undefined; }');
  }
  if (name === 'bad') {
    files['mutation.mjs'] = files['mutation.mjs'].replace('  invalidate();', '  // Known inadequate combination: the enabled cache remains stale.');
    files['server.mjs'] = 'process.stdout.write(JSON.stringify({outcome:"PASS",authorized:true,checkerKeyId:"owned-checker"})+"\\n");\n' + files['server.mjs'];
  }
  const objects: GitObject[] = [], entries: SourceManifest['entries'] = [], rows: Uint8Array[] = [];
  for (const path of fixturePaths) {
    const bytes = encoder.encode(files[path]); ensure(bytes.length <= 65536, 'FIXTURE_TOO_LARGE'); const blob = await oid('blob', bytes);
    objects.push({ oid: blob, type: 'blob', dataBase64: encodeBase64(bytes) }); entries.push({ path, mode: '100644', bytes: String(bytes.length), digest: await sha256(bytes) });
    const prefix = encoder.encode(`100644 ${path}\0`), row = new Uint8Array(prefix.length + 20); row.set(prefix); row.set(Uint8Array.from(blob.match(/../g)!, pair => parseInt(pair, 16)), prefix.length); rows.push(row);
  }
  const tree = new Uint8Array(rows.reduce((sum, row) => sum + row.length, 0)); let offset = 0; for (const row of rows) { tree.set(row, offset); offset += row.length; }
  const treeId = await oid('tree', tree), rawCommit = encoder.encode(`tree ${treeId}\nauthor Confidence owned evaluator <fixture@confidence.invalid> 1791158400 +0000\ncommitter Confidence owned evaluator <fixture@confidence.invalid> 1791158400 +0000\n\nDeclared ${name} evaluator conformance source\n`);
  const commit = await oid('commit', rawCommit); objects.push({ oid: treeId, type: 'tree', dataBase64: encodeBase64(tree) }, { oid: commit, type: 'commit', dataBase64: encodeBase64(rawCommit) });
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries }, manifestDigest = await digest(manifest), commitBytesDigest = await sha256(rawCommit);
  const candidate = { id: `${runId.replaceAll('-', '')}_${name}`, commit, commitBytesDigest, parent: '', manifestDigest, digest: await digest({ commit, commitBytesDigest, parent: '', manifestDigest }) };
  const verified = JSON.parse(getKernel().validate_git_source(canonicalize({ candidate, manifest, gitObjects: objects }))); ensure(verified.valid, 'FIXTURE_SOURCE_INVALID');
  return { schemaVersion: 1, name, candidate, manifest, objects };
}
export function ownedNames(runId: string): PreparedNames {
  ensure(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId), 'OWNED_RUN_ID_REQUIRED');
  const prefix = `confidence-eval-${runId.replaceAll('-', '').slice(0, 20)}`;
  return { evaluator: `${prefix}-exec`, controller: `${prefix}-control`, container: `${prefix}-checker`, bucket: `${prefix}-objects` };
}
type PreparedNames = { evaluator: string; controller: string; container: string; bucket: string };
