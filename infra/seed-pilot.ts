// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, mkdir, rename, rm, lstat, readdir } from 'node:fs/promises';
import { dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as git from 'isomorphic-git';
import { Volume, createFsFromVolume } from 'memfs';
import { initializeKernel } from '../packages/protocol/src/node.ts';
import { canonicalize, digest, encodeBase64, getKernel, parseStrictJson, sha256, type GitObject, type SourceManifest } from '../packages/protocol/src/index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixturePaths = ['cache.mjs', 'mutation.mjs', 'presentation.mjs', 'server.mjs'] as const;
const API = 'https://api.cloudflare.com/client/v4', ZERO = '0'.repeat(40), REF = 'refs/heads/main';
const hash = (value: Uint8Array | string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,62}$/;
type Dictionary = Record<string, unknown>;
type Phase = 'NOT_DISPATCHED' | 'MAY_HAVE_DISPATCHED' | 'ACKNOWLEDGED' | 'UNKNOWN' | 'OBSERVED';
export type SeedConfig = { accountId: string; artifactsNamespace: string; repository: string };
export type SeedFixtureProfile = 'authoring-biome-v1';
type Gate = { account?: string; credential?: string; checks: { name: string; status: string; detail: Dictionary }[] };
export type SeedOptions = { run: boolean; useWrangler: boolean; fixtureProfile?: SeedFixtureProfile; expectedAccount?: string; apiToken?: string; repoTokenFile?: string; fetcher?: typeof fetch; credentialSelector?: (account: string) => Gate; timeoutMs?: number };
export interface SeedReport {
  schemaVersion: 1; runId: string; status: 'BLOCKED' | 'PASS'; updatedAt: string;
  fixtureProfile?: SeedFixtureProfile;
  target: SeedConfig; description: string; expectedHead: string; manifestDigest: string;
  sourceDigests: Record<string, string>; objectDigests: Record<string, string>;
  create: Phase; push: Phase; repositoryId: string | null; observedHead: string | null;
  rawSourceVerifiedAt: string | null; credentialsRevoked: boolean;
  blockers: string[]; checks: { name: string; status: string; detail: Dictionary }[];
  limitations: string[];
}
class SafeError extends Error { constructor(readonly code: string, readonly status?: number, readonly apiCodes: number[] = []) { super(code); } }
function ensure(condition: unknown, code: string): asserts condition { if (!condition) throw new SafeError(code); }
function object(value: unknown): Dictionary { ensure(value && typeof value === 'object' && !Array.isArray(value), 'API_OBJECT_REQUIRED'); return value as Dictionary; }
function tokenInventory(envelope: Dictionary): Dictionary[] {
  ensure(Array.isArray(envelope.result) && envelope.result.length <= 8, 'TOKEN_INVENTORY_INVALID'); const info = object(envelope.result_info);
  ensure((info.total_pages === 1 || info.total_pages === 0 && envelope.result.length === 0) && info.total_count === envelope.result.length, 'TOKEN_INVENTORY_INCOMPLETE');
  const tokens = envelope.result.map(object); ensure(tokens.every(token => typeof token.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(token.id) && ['active', 'revoked', 'expired'].includes(String(token.state)) && ['read', 'write'].includes(String(token.scope))), 'TOKEN_INVENTORY_SCHEMA');
  ensure(new Set(tokens.map(token => token.id)).size === tokens.length, 'TOKEN_INVENTORY_DUPLICATE'); return tokens;
}
async function bounded(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(); const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.length; ensure(length <= maximum, 'RESPONSE_SIZE_LIMIT'); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); }
  const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
}
async function persist(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true }); const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600); try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path); const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}
async function privateToken(path: string, runId: string): Promise<string> {
  const metadata = await lstat(path); ensure(metadata.isFile() && (metadata.mode & 0o077) === 0 && metadata.size <= 32768, 'PRIVATE_TOKEN_FILE_REQUIRED');
  const raw = (await readFile(path, 'utf8')).trim(); let token: unknown = raw;
  if (raw.startsWith('{')) { const saved = object(parseStrictJson(raw)); ensure(saved.runId === runId, 'PRIVATE_TOKEN_ASSOCIATION_MISMATCH'); token = saved.token; }
  ensure(typeof token === 'string' && token.length >= 16 && token.length <= 16384 && !/[\s\x00-\x1f\x7f]/.test(token), 'PRIVATE_REPO_TOKEN_INVALID'); return token;
}

/** The optional closed preset adds one immutable diagnostic configuration. */
export async function fixtureSource(fixtureProfile?: SeedFixtureProfile) {
  ensure(fixtureProfile === undefined || fixtureProfile === 'authoring-biome-v1', 'SEED_FIXTURE_PROFILE_INVALID');
  await initializeKernel(); const fs = createFsFromVolume(new Volume()), dir = '/seed'; await git.init({ fs, dir, defaultBranch: 'main' });
  ensure(canonicalize((await readdir(resolve(root, 'fixtures/collaboration-demo'))).sort()) === canonicalize([...fixturePaths]), 'FIXTURE_INVENTORY_CHANGED');
  const selectedPaths = [...fixturePaths, ...(fixtureProfile ? ['biome.json'] : [])].sort();
  const tree: git.TreeEntry[] = [], objects: GitObject[] = [], entries: SourceManifest['entries'] = [], sourceDigests: Record<string, string> = {};
  for (const path of selectedPaths) {
    const trackedPath = path === 'biome.json' ? 'fixtures/authoring-benchmark/biome.json' : `fixtures/collaboration-demo/${path}`;
    const fullPath = resolve(root, trackedPath), metadata = await lstat(fullPath); ensure(metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o111) === 0 && metadata.size <= 65536, 'FIXTURE_FILE_INVALID');
    const bytes = new Uint8Array(await readFile(fullPath)), oid = await git.writeBlob({ fs, dir, blob: bytes }), strong = await sha256(bytes);
    tree.push({ path, mode: '100644', type: 'blob', oid }); objects.push({ oid, type: 'blob', dataBase64: encodeBase64(bytes) }); entries.push({ path, mode: '100644', bytes: String(bytes.length), digest: strong }); sourceDigests[trackedPath] = strong;
  }
  const treeOid = await git.writeTree({ fs, dir, tree }), identity = { name: 'Confidence owned fixture', email: 'fixture@confidence.invalid', timestamp: 1791158400, timezoneOffset: 0 };
  const commit = await git.writeCommit({ fs, dir, commit: { tree: treeOid, parent: [], author: identity, committer: identity, message: 'Confidence collaboration baseline\n' } });
  for (const [oid, type] of [[treeOid, 'tree'], [commit, 'commit']] as const) { const raw = await git.readObject({ fs, dir, oid, format: 'content' }); objects.push({ oid, type, dataBase64: encodeBase64(new Uint8Array(raw.object as Uint8Array)) }); }
  const manifest: SourceManifest = { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries }, manifestDigest = await digest(manifest);
  const rawCommit = new Uint8Array((await git.readObject({ fs, dir, oid: commit, format: 'content' })).object as Uint8Array);
  const candidate = { id: 'owned-collaboration-baseline', digest: await digest({ commit, manifestDigest }), commit, commitBytesDigest: await sha256(rawCommit), parent: '', manifestDigest };
  const validated = JSON.parse(getKernel().validate_git_source(canonicalize({ candidate, manifest, gitObjects: objects }))); ensure(validated.valid, 'LOCAL_FIXTURE_SOURCE_INVALID');
  return { fs, dir, objects, manifest, manifestDigest, candidate, sourceDigests, objectDigests: Object.fromEntries(await Promise.all(objects.map(async item => [item.oid, await sha256(Uint8Array.from(atob(item.dataBase64), character => character.charCodeAt(0)))]))) };
}

export async function seedPilot(config: SeedConfig, reportPath: string, options: SeedOptions): Promise<SeedReport> {
  ensure(/^[a-f0-9]{32}$/.test(config.accountId) && namePattern.test(config.artifactsNamespace) && namePattern.test(config.repository) && config.repository.startsWith('owned-'), 'EXPLICIT_OWNED_SEED_TARGET_REQUIRED');
  const source = await fixtureSource(options.fixtureProfile); reportPath = resolve(reportPath); await mkdir(dirname(reportPath), { recursive: true });
  const lock = await open(reportPath + '.lock', 'wx', 0o600); const tokenPath = reportPath + '.repo-token';
  let report: SeedReport;
  try {
    let previous: SeedReport | undefined;
    try { previous = JSON.parse(await readFile(reportPath, 'utf8')) as SeedReport; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new SafeError('SEED_REPORT_INVALID'); }
    if (previous) ensure(previous.schemaVersion === 1 && previous.fixtureProfile === options.fixtureProfile && canonicalize(previous.target) === canonicalize(config) && previous.expectedHead === source.candidate.commit && previous.manifestDigest === source.manifestDigest && canonicalize(previous.sourceDigests) === canonicalize(source.sourceDigests), 'SEED_INTENT_OR_SOURCE_CHANGED');
    const runId = previous?.runId ?? randomUUID();
    report = previous ?? { schemaVersion: 1, runId, status: 'BLOCKED', updatedAt: '', ...(options.fixtureProfile ? { fixtureProfile: options.fixtureProfile } : {}), target: config, description: `Confidence owned seed ${runId} ${source.manifestDigest}`, expectedHead: source.candidate.commit, manifestDigest: source.manifestDigest, sourceDigests: source.sourceDigests, objectDigests: source.objectDigests, create: 'NOT_DISPATCHED', push: 'NOT_DISPATCHED', repositoryId: null, observedHead: null, rawSourceVerifiedAt: null, credentialsRevoked: false, blockers: [], checks: [], limitations: ['Canonical fixture initialization only; no Worker deployment, model execution or conditional-publication gate is established.', 'Create and push acknowledgments are separate from resource/ref/source observations. Uncertain dispatch is never repeated automatically.', 'Native source roundtrip time is retained; repeated completed runs observe metadata/current head using REST after bootstrap credentials were revoked.', 'The existing namespace and intended repository remain. Authority/R2 enrollment is a separate authenticated command.'] };
    report.status = 'BLOCKED'; report.blockers = []; report.checks = [];
    const save = async () => { report.updatedAt = new Date().toISOString(); await persist(reportPath, report); };
    if (!options.run) { report.blockers.push('EXPLICIT_RUN_REQUIRED'); await save(); return report; }
    let selection: Gate;
    if (options.useWrangler) {
      const { selectWranglerCredential } = await import(new URL('../scripts/provider-preflight.ts', import.meta.url).href) as { selectWranglerCredential: (account: string) => Gate };
      selection = (options.credentialSelector ?? selectWranglerCredential)(config.accountId);
    } else selection = { account: options.expectedAccount, credential: options.apiToken, checks: [] };
    report.checks = selection.checks;
    if (selection.account !== config.accountId || !selection.credential || selection.checks.some(check => check.status !== 'PASS')) { report.blockers.push('ARTIFACTS_CREDENTIAL_OR_ACCOUNT_REQUIRED'); await save(); return report; }
    const credential = selection.credential, fetcher = options.fetcher ?? fetch, timeout = options.timeoutMs ?? 20000;
    const namespacePath = `/accounts/${config.accountId}/artifacts/namespaces/${config.artifactsNamespace}`, repoPath = `${namespacePath}/repos/${config.repository}`;
    const request = async (path: string, method = 'GET', body?: unknown, missing = false): Promise<Dictionary | null> => {
      const response = await fetcher(API + path, { method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeout), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = object(parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(await bounded(response, 1024 * 1024))));
      if (missing && response.status === 404) return null;
      if (!response.ok || value.success !== true) throw new SafeError('ARTIFACTS_API_DENIED', response.status, Array.isArray(value.errors) ? value.errors.map(item => object(item).code).filter((code): code is number => typeof code === 'number' && Number.isInteger(code)) : []);
      return value;
    };
    try {
      const account = await request(`/accounts/${config.accountId}`); ensure(account && object(account.result).id === config.accountId, 'API_ACCOUNT_MISMATCH');
      const namespace = await request(namespacePath, 'GET', undefined, true); ensure(namespace && object(namespace.result).namespace === config.artifactsNamespace, 'NAMESPACE_NOT_PROVISIONED');
      let found = await request(repoPath, 'GET', undefined, true), repoToken: string | undefined;
      if (found && report.create === 'NOT_DISPATCHED') throw new SafeError('UNJOURNALED_EXISTING_REPOSITORY');
      if (!found) {
        if (report.create !== 'NOT_DISPATCHED') { report.create = 'UNKNOWN'; report.blockers.push('CREATE_UNRESOLVED_RESOURCE_NOT_OBSERVED'); await save(); return report; }
        report.create = 'MAY_HAVE_DISPATCHED'; await save();
        try {
          found = await request(`${namespacePath}/repos`, 'POST', { name: config.repository, default_branch: 'main', read_only: false, description: report.description }); ensure(found, 'CREATE_ACKNOWLEDGMENT_MISSING');
          const created = object(found.result); ensure(typeof created.token === 'string' && created.token.length >= 16 && created.token.length <= 16384 && !/[\s\x00-\x1f\x7f]/.test(created.token), 'REPO_TOKEN_REPLY_MISSING'); repoToken = created.token;
          // Only the returned repository token has a private restart sidecar. The
          // OAuth/API account credential stays in memory and never enters files.
          const secret = await open(tokenPath, 'wx', 0o600); try { await secret.writeFile(JSON.stringify({ runId, token: repoToken })); await secret.sync(); } finally { await secret.close(); }
          report.create = 'ACKNOWLEDGED'; await save();
          found = await request(repoPath); ensure(found, 'CREATED_RESOURCE_NOT_OBSERVED');
        } catch (error) { report.create = 'UNKNOWN'; await save(); throw error; }
      }
      const repo = object(found.result), remote = `https://${config.accountId}.artifacts.cloudflare.net/git/${config.artifactsNamespace}/${config.repository}.git`;
      ensure(repo.name === config.repository && repo.description === report.description && repo.default_branch === 'main' && repo.read_only !== true && repo.remote === remote && typeof repo.id === 'string', 'SEED_RESOURCE_ASSOCIATION_CONFLICT');
      ensure(report.repositoryId === null || report.repositoryId === repo.id, 'SEED_RESOURCE_ID_CHANGED'); report.repositoryId = repo.id; report.create = 'OBSERVED'; await save();
      const sourceAlreadyVerified = report.push === 'OBSERVED' && Boolean(report.rawSourceVerifiedAt);
      if (sourceAlreadyVerified) {
        const log = await request(`${repoPath}/log?ref=main&limit=1`); ensure(log && Array.isArray(log.result), 'COMPLETED_SEED_HEAD_UNAVAILABLE'); const observed = object(log.result[0]).hash; report.observedHead = typeof observed === 'string' && /^[a-f0-9]{40}$/.test(observed) ? observed : null; ensure(report.observedHead === report.expectedHead, 'COMPLETED_SEED_HEAD_CHANGED');
        if (report.credentialsRevoked) { report.status = 'PASS'; await save(); return report; }
      }
      if (!sourceAlreadyVerified) {
      if (!repoToken && !report.credentialsRevoked) { try { repoToken = await privateToken(options.repoTokenFile ? resolve(options.repoTokenFile) : tokenPath, runId); } catch { throw new SafeError('PRIVATE_REPO_TOKEN_REQUIRED_FOR_RECONCILIATION'); } }
      ensure(repoToken, 'REPO_TOKEN_REQUIRED');
      const http: git.HttpClient = { async request({ url, method, headers, body }) {
        const target = new URL(url); ensure(target.origin === new URL(remote).origin && target.pathname.startsWith(new URL(remote).pathname + '/') && !target.username && !target.password, 'GIT_ROUTE_DENIED');
        const chunks: Uint8Array[] = []; let size = 0; if (body) for await (const chunk of body) { size += chunk.length; ensure(size <= 1024 * 1024, 'GIT_REQUEST_SIZE_LIMIT'); chunks.push(chunk); }
        const payload = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { payload.set(chunk, offset); offset += chunk.length; }
        const outgoing = new Headers(headers); outgoing.delete('cookie'); outgoing.set('authorization', `Bearer ${repoToken}`);
        const response = await fetcher(target, { method, headers: outgoing, redirect: 'error', signal: AbortSignal.timeout(timeout), ...(size ? { body: payload.slice().buffer } : {}) });
        const bytes = await bounded(response, 4 * 1024 * 1024); return { url, method: method || 'GET', statusCode: response.status, statusMessage: response.statusText, headers: Object.fromEntries(response.headers.entries()), body: (async function* () { yield bytes; })() };
      } };
      const refs = await git.listServerRefs({ http, url: remote }); ensure(refs.length <= 64, 'SEED_REF_LIMIT');
      const current = refs.find(item => item.ref === REF)?.oid ?? null; report.observedHead = current; await save();
      if (current !== source.candidate.commit) {
        if (report.push !== 'NOT_DISPATCHED') { report.push = 'UNKNOWN'; report.blockers.push(current ? 'PUSH_DIVERGENCE_OBSERVED' : 'EMPTY_REF_DOES_NOT_PROVE_CANCELLATION'); await save(); return report; }
        ensure(current === null && refs.every(item => item.ref === 'HEAD'), 'SEED_REPOSITORY_NOT_EMPTY');
        const { buildReceivePack, parseReceivePack } = await import(new URL('../workers/authority/artifacts.ts', import.meta.url).href) as { buildReceivePack: (old: string, next: string, ref: string, pack: Uint8Array) => Uint8Array; parseReceivePack: (bytes: Uint8Array, ref: string) => { accepted: boolean } };
        const packed = await git.packObjects({ fs: source.fs, dir: source.dir, oids: source.objects.map(item => item.oid) }); ensure(packed.packfile, 'SEED_PACK_MISSING');
        const payload = buildReceivePack(ZERO, source.candidate.commit, REF, packed.packfile);
        report.push = 'MAY_HAVE_DISPATCHED'; await save();
        try {
          const response = await fetcher(remote + '/git-receive-pack', { method: 'POST', headers: { authorization: `Bearer ${repoToken}`, 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' }, body: payload.slice().buffer, redirect: 'error', signal: AbortSignal.timeout(timeout) });
          const ack = parseReceivePack(await bounded(response, 65536), REF); ensure(response.ok && ack.accepted, 'PUSH_ACKNOWLEDGMENT_MISSING'); report.push = 'ACKNOWLEDGED'; await save();
        } catch { report.push = 'UNKNOWN'; report.blockers.push('PUSH_OUTCOME_UNKNOWN'); await save(); return report; }
      }
      const returnedFs = createFsFromVolume(new Volume()), dir = '/roundtrip';
      await git.clone({ fs: returnedFs, dir, http, url: remote, ref: 'main', depth: 1, singleBranch: true, noCheckout: true }); ensure(await git.resolveRef({ fs: returnedFs, dir, ref: 'HEAD' }) === source.candidate.commit, 'ROUNDTRIP_HEAD_MISMATCH');
      for (const item of source.objects) { const readback = await git.readObject({ fs: returnedFs, dir, oid: item.oid, format: 'content' }); ensure(encodeBase64(new Uint8Array(readback.object as Uint8Array)) === item.dataBase64, 'ROUNDTRIP_RAW_SOURCE_MISMATCH'); }
      const parsed = await git.readCommit({ fs: returnedFs, dir, oid: source.candidate.commit }), returnedTree = await git.readTree({ fs: returnedFs, dir, oid: parsed.commit.tree });
      ensure(canonicalize(returnedTree.tree.map(item => ({ path: item.path, mode: item.mode, type: item.type })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        === canonicalize(source.manifest.entries.map(item => ({ path: item.path, mode: item.mode, type: 'blob' }))), 'ROUNDTRIP_FILE_MODE_MISMATCH');
      const after = await git.listServerRefs({ http, url: remote, prefix: REF }); ensure(after.find(item => item.ref === REF)?.oid === source.candidate.commit, 'SEED_HEAD_MOVED_DURING_ROUNDTRIP');
      report.push = 'OBSERVED'; report.observedHead = source.candidate.commit; report.rawSourceVerifiedAt = new Date().toISOString(); await save();
      }
      // Initial repo tokens are revoked before returning enrollment information.
      // The fresh owned association is rechecked on every invocation above.
      const inventory = await request(`${repoPath}/tokens?state=all&per_page=100&page=1`); ensure(inventory, 'TOKEN_INVENTORY_INVALID');
      for (const token of tokenInventory(inventory)) if (token.state === 'active') await request(`${namespacePath}/tokens/${token.id}`, 'DELETE');
      const reread = await request(`${repoPath}/tokens?state=all&per_page=100&page=1`); ensure(reread && tokenInventory(reread).every(token => token.state !== 'active'), 'TOKEN_REVOCATION_UNCONFIRMED');
      report.credentialsRevoked = true; report.status = 'PASS'; await save(); await rm(tokenPath, { force: true }); return report;
    } catch (error) {
      const safe = error instanceof SafeError ? error : new SafeError('SEED_INFRASTRUCTURE_UNAVAILABLE'); report.blockers.push(safe.code);
      if (safe.status !== undefined) report.checks.push({ name: 'provider-error', status: 'BLOCKED', detail: { httpStatus: safe.status, apiCodes: safe.apiCodes } });
      await save(); return report;
    }
  } finally { await lock.close(); await rm(reportPath + '.lock', { force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await initializeKernel();
    const args = process.argv.slice(2), positional: string[] = [], flags = new Map<string, string | true>();
    for (let index = 0; index < args.length; index++) {
      const argument = args[index]!; if (!argument.startsWith('--')) { positional.push(argument); continue; }
      ensure(!flags.has(argument) && ['--repository', '--repo-token-file', '--run', '--use-wrangler'].includes(argument), 'SEED_ARGUMENT_INVALID');
      if (argument === '--repository' || argument === '--repo-token-file') { const value = args[++index]; ensure(value && !value.startsWith('--'), 'SEED_ARGUMENT_VALUE_REQUIRED'); flags.set(argument, value); } else flags.set(argument, true);
    }
    ensure(positional.length === 2 && typeof flags.get('--repository') === 'string', 'USAGE_SEED_PILOT_INPUT_JSON_REPORT_JSON_REPOSITORY_OPTIONAL_RUN_USE_WRANGLER');
    const inputPath = resolve(positional[0]!); ensure((await lstat(inputPath)).size <= 1024 * 1024, 'CONFIG_SIZE_LIMIT');
    const config = object(parseStrictJson(await readFile(inputPath, 'utf8'))), repository = flags.get('--repository') as string;
    const report = await seedPilot({ accountId: String(config.accountId), artifactsNamespace: String(config.artifactsNamespace), repository }, positional[1]!, { run: flags.has('--run'), useWrangler: flags.has('--use-wrangler'), expectedAccount: process.env.CLOUDFLARE_ACCOUNT_ID, apiToken: process.env.CLOUDFLARE_API_TOKEN, repoTokenFile: flags.get('--repo-token-file') as string | undefined });
    process.stdout.write(JSON.stringify({ status: report.status, report: resolve(positional[1]!), blockers: report.blockers, create: report.create, push: report.push, ...(report.status === 'PASS' ? { enrollment: { canonicalRepo: repository, canonicalRef: REF, expectedHead: report.expectedHead, maximumBudget: '2000000' } } : {}) }) + '\n');
    if (report.status !== 'PASS') process.exitCode = 2;
  } catch (error) { process.stderr.write((error instanceof SafeError ? error.code : 'SEED_PILOT_FAILED') + '\n'); process.exitCode = 1; }
}
