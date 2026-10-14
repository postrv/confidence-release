// SPDX-License-Identifier: Apache-2.0
// Read-only qualification preflight. This module neither enrolls a project nor changes acceptance limits.
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalize } from '../packages/protocol/src/index.ts';
import { CONFIDENCE_REPOSITORY_RECIPE } from '../workers/evaluator/repository-recipes.ts';

export const REVIEWED_CONFIDENCE_REVISION = '5892c0a76d0baf422133981fa1cb66d6ebfb9852';
export const REVIEWED_WEFT_REVISION = 'b1c5521bf28a0144203c55b3f056885dce3535ff';
const WEFT_PROTOCOL_DIGEST = '9e73e69158156a173c7d9c810b07d3bfcfcf3ec43545cbee6974d328674c1192';
const MiB = 1024 * 1024;
// Historical compatibility ceilings, not mutable runtime configuration or a grant to exceed them.
const BASELINE = { sourceBytes: 4 * MiB, fileBytes: MiB, files: 2048, pathBytes: 65536, jsonBytes: 8 * MiB,
  importObjectBytes: 8 * MiB, importArchiveBytes: 16 * MiB, proxyBodyBytes: MiB, proxyResponseBytes: 8 * MiB,
  portableBytes: 8 * MiB, portableReservedBytes: MiB + 2 * 65536,
  weft: { fileBytes: 512 * 1024, files: 2000, snapshotBytes: 8 * MiB, bodyBytes: 12 * MiB } } as const;
const AUDIT_OBJECTS = 8192, AUDIT_BYTES = 32 * MiB;

export const CONFIDENCE_REPOSITORY_PROFILE = {
  id: 'confidence-repository-v1', qualification: 'unqualified',
  capture: { selection: 'exact-committed-Git-tree', exclusions: [] as string[], required: 'all paths, bytes, modes and deletions; no silent filtering' },
  fixtureExceptions: 'owner-review-required',
  toolchain: { node: '24.x exact image digest still required', rust: '1.98.0', target: 'wasm32-unknown-unknown', components: ['rustfmt', 'clippy'], wasmPack: '0.13.1', dependencies: ['package-lock.json', 'Cargo.lock'] },
  recipe: { status: 'unregistered', trustedDefinition: 'workers/evaluator/repository-recipes.ts',
    controlInputs: CONFIDENCE_REPOSITORY_RECIPE.controlInputs,
    commands: CONFIDENCE_REPOSITORY_RECIPE.sourceCommands.map(argv => ({ argv, purpose: 'actual CI source gate; image and protected execution qualification separate' })) },
  ciReference: { source: '.github/workflows/validate.yml', commands: ['npm ci', 'npm run test:local', 'cargo fmt --check', 'cargo clippy --workspace --all-targets -- -D warnings', 'npm run test:pi', 'npm run compare:workflows', 'npm run demo', 'npm run verify -- demo-output/receipt.json demo-output/trust.json demo-output/checkpoint.json', 'npm run verify -- demo-output/receipt.json demo-output/trust.json demo-output/checkpoint-attestation.json'], conditionalImages: ['npm run test:container', 'npm run test:runner-image'] },
  unqualified: ['whole-repository-live-capture', 'protected-execution', 'full-runtime-CI', 'Docker-image-checks', 'Weft-source-and-dependency-closure', 'publication-and-portable-verification'],
  protectedRequirements: ['offline pinned dependencies and toolchain', 'no signing/service/source credentials inside candidate execution', 'external exit/timeout/output/whole-generation termination observations', 'registered evidence class, policy and exact review plan', 'candidate bytes hydrated and read back before execution', 'fresh owned execution directory; no local HEAD/index changes'],
} as const;

export interface RepositoryPreflightOptions { repository: string; revision?: string; weftSource?: string }
interface TreeEntry { path: string; mode: string; type: string; oid: string }
interface BlobEntry extends TreeEntry { bytes: number | null; digest: string | null; utf8: boolean | null; nul: boolean | null; lfs: boolean }
interface Blocker { code: string; scope: 'capture' | 'source' | 'import' | 'receipt' | 'execution'; path?: string; observed?: number; maximum?: number }
interface GitObject { oid: string; type: string; dataBase64: string }
interface WeftValidator { LIMITS: typeof BASELINE.weft; validPath(path: string): unknown; isPrivatePath(path: string): boolean; screenText(text: string): void }
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const size = (value: unknown) => Buffer.byteLength(canonicalize(value));
const exactCommit = (value: string) => { if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('EXACT_COMMIT_REQUIRED'); return value; };

function gitRead(repository: string, args: string[], maximum = MiB, input?: string): Buffer {
  try { return Buffer.from(execFileSync('git', ['--no-optional-locks', '-C', resolve(repository), ...args], { input, maxBuffer: maximum, timeout: 30000,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' }, stdio: ['pipe', 'pipe', 'pipe'] })); }
  catch { throw new Error('GIT_READ_FAILED'); } // Git diagnostics may contain private repository names or input bytes.
}

function inventory(repository: string, revision: string): { tree: TreeEntry[]; objects: GitObject[]; blobs: Map<string, Buffer> } {
  if (gitRead(repository, ['rev-parse', '--verify', `${revision}^{commit}`]).toString().trim() !== revision) throw new Error('EXACT_COMMIT_REQUIRED');
  const raw = gitRead(repository, ['ls-tree', '-r', '-t', '-z', revision], 4 * MiB);
  const tree: TreeEntry[] = new TextDecoder('utf8', { fatal: true }).decode(raw).split('\0').filter(Boolean).map(row => {
    const split = row.indexOf('\t'), meta = row.slice(0, split).split(' '), path = row.slice(split + 1);
    if (split < 0 || meta.length !== 3 || !/^[a-f0-9]{40}$/.test(meta[2]!) || !path) throw new Error('GIT_TREE_INVALID');
    return { mode: meta[0]!, type: meta[1]!, oid: meta[2]!, path };
  });
  const root = gitRead(repository, ['rev-parse', `${revision}^{tree}`]).toString().trim();
  const identities = [...new Set([revision, root, ...tree.filter(entry => entry.type !== 'commit').map(entry => entry.oid)])].sort();
  if (identities.length > AUDIT_OBJECTS) throw new Error('AUDIT_OBJECT_COUNT_LIMIT');
  const batch = gitRead(repository, ['cat-file', '--batch'], AUDIT_BYTES + AUDIT_OBJECTS * 128, identities.join('\n') + '\n');
  const blobs = new Map<string, Buffer>(), objects: GitObject[] = []; let offset = 0, total = 0;
  for (const expected of identities) {
    const end = batch.indexOf(10, offset); if (end < offset) throw new Error('GIT_BATCH_INCOMPLETE');
    const [oid, type, count] = batch.subarray(offset, end).toString().split(' '), length = Number(count);
    if (oid !== expected || !['commit', 'tree', 'blob'].includes(type!) || !Number.isSafeInteger(length) || length < 0) throw new Error('GIT_BATCH_INVALID');
    total += length; if (total > AUDIT_BYTES) throw new Error('AUDIT_BYTE_LIMIT');
    const bytes = batch.subarray(end + 1, end + 1 + length); offset = end + length + 2;
    if (bytes.length !== length || batch[offset - 1] !== 10) throw new Error('GIT_BATCH_INCOMPLETE');
    if (createHash('sha1').update(`${type} ${length}\0`).update(bytes).digest('hex') !== oid) throw new Error('GIT_OBJECT_IDENTITY');
    blobs.set(oid, bytes); objects.push({ oid, type: type!, dataBase64: Buffer.from(bytes).toString('base64') });
  }
  if (offset !== batch.length) throw new Error('GIT_BATCH_EXTRA_BYTES');
  return { tree, objects, blobs };
}

async function weftValidator(repository?: string): Promise<WeftValidator | null> {
  if (!repository) return null;
  const source = gitRead(repository, ['show', `${REVIEWED_WEFT_REVISION}:src/protocol/content.js`], MiB);
  if (hash(source) !== WEFT_PROTOCOL_DIGEST) throw new Error('WEFT_VALIDATOR_DIGEST_MISMATCH');
  // Only the reviewed immutable module is executed. No code from the candidate is loaded.
  return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as WeftValidator;
}

function checkPaths(entries: BlobEntry[], blockers: Blocker[]) {
  const prefixes = new Map<string, { path: string; file: boolean }>();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const path = parts.slice(0, index).join('/'), folded = path.toLowerCase(), file = index === parts.length, prior = prefixes.get(folded);
      if (prior && (prior.path !== path || prior.file !== file)) blockers.push({ code: 'CASE_PATH_COLLISION', scope: 'capture', path: entry.path });
      else prefixes.set(folded, { path, file });
    }
  }
}

function checkEntry(entry: BlobEntry, bytes: Buffer | undefined, validator: WeftValidator | null, blockers: Blocker[]): string | null {
  const add = (code: string) => blockers.push({ code, scope: 'capture', path: entry.path });
  if (entry.mode === '160000') { add('SUBMODULE_CONTENT_NOT_CAPTURED'); return null; }
  if (!['100644', '100755'].includes(entry.mode)) add('UNSUPPORTED_MODE');
  if (!bytes) throw new Error('GIT_BLOB_MISSING');
  entry.bytes = bytes.length; entry.digest = 'sha256:' + hash(bytes); entry.nul = bytes.includes(0);
  entry.lfs = bytes.subarray(0, 43).toString() === 'version https://git-lfs.github.com/spec/v1\n';
  if (entry.lfs) add('LFS_PAYLOAD_NOT_CAPTURED');
  let text: string | null = null;
  try { text = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes); entry.utf8 = true; } catch { entry.utf8 = false; }
  if (!entry.utf8 || entry.nul) add('WEFT_BINARY_CONTENT');
  if (validator) {
    try { validator.validPath(entry.path); if (validator.isPrivatePath(entry.path)) add('WEFT_PRIVATE_PATH'); validator.screenText(entry.path); }
    catch (error) { add('WEFT_' + safeWeftCode(error)); }
    if (text !== null) { try { validator.screenText(text); } catch (error) { if (safeWeftCode(error) !== 'UNSUPPORTED_CONTENT' || !entry.nul) add('WEFT_' + safeWeftCode(error)); } }
  }
  return text;
}
function safeWeftCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'VALIDATION_FAILED';
}

export async function auditConfidenceRepository(options: RepositoryPreflightOptions) {
  const revision = exactCommit(options.revision ?? REVIEWED_CONFIDENCE_REVISION);
  const selected = inventory(options.repository, revision), validator = await weftValidator(options.weftSource);
  const blockers: Blocker[] = [], entries: BlobEntry[] = [], textFiles: Record<string, { text: string; mode: number }> = {};
  for (const item of selected.tree.filter(entry => entry.type !== 'tree').sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const entry: BlobEntry = { ...item, bytes: null, digest: null, utf8: null, nul: null, lfs: false };
    const text = checkEntry(entry, selected.blobs.get(entry.oid), validator, blockers); entries.push(entry);
    if (text !== null) Object.defineProperty(textFiles, entry.path, { value: { text, mode: Number.parseInt(entry.mode, 8) }, enumerable: true });
  }
  checkPaths(entries, blockers);
  const sourceBytes = entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0), pathBytes = entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.path), 0);
  const closureJSON = canonicalize(selected.objects), closureBytes = [...selected.blobs.values()].reduce((sum, value) => sum + value.length, 0);
  const manifest = entries.every(entry => ['100644', '100755'].includes(entry.mode)) ? { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: entries.map(entry => ({ path: entry.path, mode: entry.mode, bytes: String(entry.bytes), digest: entry.digest })) } : null;
  const textEnvelopeBytes = size({ files: textFiles });
  const over = (code: string, scope: Blocker['scope'], observed: number, maximum: number, path?: string) => { if (observed > maximum) blockers.push({ code, scope, observed, maximum, ...(path ? { path } : {}) }); };
  for (const entry of entries) {
    over('WEFT_FILE_BYTES', 'capture', entry.bytes ?? 0, BASELINE.weft.fileBytes, entry.path);
    over('CONFIDENCE_FILE_BYTES', 'source', entry.bytes ?? 0, BASELINE.fileBytes, entry.path);
  }
  over('WEFT_FILE_COUNT', 'capture', entries.length, BASELINE.weft.files);
  over('WEFT_SNAPSHOT_BYTES', 'capture', sourceBytes, BASELINE.weft.snapshotBytes);
  over('WEFT_BODY_BYTES', 'capture', textEnvelopeBytes, BASELINE.weft.bodyBytes);
  over('WEFT_PROXY_BODY_BYTES', 'capture', textEnvelopeBytes, BASELINE.proxyBodyBytes);
  over('WEFT_PROXY_RESPONSE_BYTES', 'capture', textEnvelopeBytes, BASELINE.proxyResponseBytes);
  over('CONFIDENCE_SOURCE_BYTES', 'source', sourceBytes, BASELINE.sourceBytes);
  over('CONFIDENCE_FILE_COUNT', 'source', entries.length, BASELINE.files);
  over('CONFIDENCE_PATH_BYTES', 'source', pathBytes, BASELINE.pathBytes);
  over('PROJECT_IMPORT_OBJECT_BYTES', 'import', closureBytes, BASELINE.importObjectBytes);
  over('PROJECT_IMPORT_EXPANDED_BYTES', 'import', sourceBytes, BASELINE.importObjectBytes);
  over('PROJECT_IMPORT_ARCHIVE_BYTES_LOWER_BOUND', 'import', Buffer.byteLength(closureJSON), BASELINE.importArchiveBytes);
  over('PROTOCOL_GIT_BYTES', 'source', closureBytes, BASELINE.jsonBytes);
  over('PROTOCOL_JSON_BYTES', 'source', Buffer.byteLength(closureJSON), BASELINE.jsonBytes);
  over('PORTABLE_RECEIPT_CAPACITY', 'receipt', Buffer.byteLength(closureJSON) + BASELINE.portableReservedBytes, BASELINE.portableBytes);
  if (!validator) blockers.push({ code: 'WEFT_VALIDATOR_UNAVAILABLE', scope: 'capture' });
  if (entries.some(entry => /\.(ts|tsx|mts|cts)$/i.test(entry.path))) blockers.push({ code: 'TYPESCRIPT_PROTECTED_PROFILE_UNREGISTERED', scope: 'execution' });
  const fixturePaths = ['cache.mjs', 'mutation.mjs', 'presentation.mjs', 'server.mjs'];
  if (canonicalize(entries.map(entry => entry.path)) !== canonicalize(fixturePaths)) blockers.push({ code: 'WEFT_EXECUTION_PROFILE_UNSUPPORTED', scope: 'execution' });
  blockers.push({ code: 'PROTECTED_EXECUTION_UNQUALIFIED', scope: 'execution' });
  return {
    schema: 'confidence.repository-preflight.v1', revision, qualified: false,
    compatibilityBaseline: { confidence: REVIEWED_CONFIDENCE_REVISION, weft: REVIEWED_WEFT_REVISION, limits: BASELINE },
    profile: CONFIDENCE_REPOSITORY_PROFILE,
    inventory: { files: entries.length, bytes: sourceBytes, pathBytes, entries, binaryPaths: entries.filter(entry => entry.utf8 === false || entry.nul).map(entry => entry.path), lfsPaths: entries.filter(entry => entry.lfs).map(entry => entry.path) },
    closure: { objects: selected.objects.length, decodedBytes: closureBytes, jsonBytes: Buffer.byteLength(closureJSON), digest: 'sha256:' + hash(closureJSON) },
    sourceManifest: manifest ? { jsonBytes: size(manifest), digest: 'sha256:' + hash(canonicalize(manifest)) } : null,
    weft: { revision: REVIEWED_WEFT_REVISION, protocolDigest: 'sha256:' + WEFT_PROTOCOL_DIGEST, scanner: validator ? 'checked' : 'unavailable', textFilesEnvelopeBytes: textEnvelopeBytes, textEnvelopeOmitsUnsupportedBinary: entries.some(entry => entry.utf8 === false) },
    blockers,
  };
}

async function main() {
  const flags = process.argv.slice(2), values: Record<string, string> = {};
  if (flags.length % 2 !== 0) throw new Error('USAGE: --repo PATH --revision FULL_COMMIT --weft-source PATH');
  for (let index = 0; index < flags.length; index += 2) {
    const name = flags[index]!;
    if (!['--repo', '--revision', '--weft-source'].includes(name) || Object.hasOwn(values, name)) throw new Error('INVALID_ARGUMENT');
    values[name] = flags[index + 1]!;
  }
  const report = await auditConfidenceRepository({ repository: values['--repo'] ?? '.', revision: values['--revision'], weftSource: values['--weft-source'] ?? process.env.WEFT_SOURCE });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = report.blockers.length ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void main().catch(error => { process.stderr.write(JSON.stringify({ code: error instanceof Error && /^[A-Z_: -]+$/.test(error.message) ? error.message : 'PREFLIGHT_FAILED' }) + '\n'); process.exitCode = 2; });
