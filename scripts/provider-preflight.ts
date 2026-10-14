// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as git from 'isomorphic-git';
import { Volume, createFsFromVolume } from 'memfs';
import { ARTIFACTS_PREFLIGHT_CHECKS, ARTIFACTS_PREFLIGHT_SOURCES } from './provider-preflight-evidence.ts';

// Runtime import shares the actual Worker wire helpers without introducing
// Worker-global Buffer declarations into the native application's type scope.
const adapterUrl = new URL('../workers/authority/artifacts.ts', import.meta.url).href;
const { buildReceivePack, parseReceivePack, validateRemote } = await import(adapterUrl) as {
  buildReceivePack: (oldHead: string, newHead: string, ref: string, pack: Uint8Array) => Uint8Array;
  parseReceivePack: (bytes: Uint8Array, ref: string) => { accepted: boolean; reason: string };
  validateRemote: (remote: string) => URL;
};

type Check = { name: string; status: 'PASS' | 'FAIL' | 'BLOCKED'; detail: Record<string, unknown> };
type CreationPhase = 'NOT_DISPATCHED' | 'MAY_HAVE_DISPATCHED' | 'ACKNOWLEDGED' | 'UNKNOWN';
type Resources = {
  namespace?: string; repo?: string; repositoryId?: string; created: boolean | null;
  namespaceCreation: CreationPhase; repositoryCreation: CreationPhase; cleanup?: string;
};
type Report = {
  schemaVersion: 1; runId: string; startedAt: string; completedAt?: string;
  status: 'BLOCKED' | 'PASS' | 'FAIL' | 'SELF_TEST_PASS'; sourceRevision: string | null;
  accountId?: string; sourceDirty?: boolean;
  sourceDigests: Record<string, string>; versions: Record<string, string>; checks: Check[];
  resources: Resources; forkResources?: Resources; gitUpdates: GitDispatch[];
  limitations: string[];
};
type Repo = { id: string; name: string; remote: string; token: string; description: string };
type ApiEnvelope<T> = { result: T; success: boolean; errors?: { code: number }[] };
type RefResult = { oldHead: string; newHead: string; ref: string; httpStatus: number; accepted: boolean; responseDigest: string; requestDigest: string; report: string };
type GitDispatch = { remote: string; oldHead: string; newHead: string; ref: string; requestDigest: string; startedAt: string;
  phase: 'MAY_HAVE_DISPATCHED' | 'ACCEPTED' | 'REJECTED' | 'UNKNOWN'; result?: RefResult; reason?: string };
const hash = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const reportPath = resolve(value('--out') || 'preflight-output/provider-preflight.json');
const report: Report = {
  schemaVersion: 1, runId: randomUUID(), startedAt: new Date().toISOString(), status: 'BLOCKED', sourceRevision: null,
  sourceDigests: {}, versions: {}, checks: [], gitUpdates: [], resources: { created: false, namespaceCreation: 'NOT_DISPATCHED', repositoryCreation: 'NOT_DISPATCHED' },
  limitations: [
    'This bounded live preflight tests a fresh owned Artifacts repository. It is not a proof of all provider concurrency histories.',
    'It does not establish deployed Worker binding isolation, Sandbox lifecycle, broker egress, OIDC identity or end-to-end publication receipts.',
    'API acknowledgments and fetched bytes are observed separately. A missing response remains uncertainty.',
    'The documented REST API has no namespace-delete route; the fresh empty namespace remains after repository cleanup.',
  ],
};
let account = process.env.CLOUDFLARE_ACCOUNT_ID;
let credential = process.env.CLOUDFLARE_API_TOKEN;
let namespace = '', repoPath = '', createdRepo: Repo | undefined;
let forkPath = '', createdFork: Repo | undefined;
const API_ROOT = 'https://api.cloudflare.com/client/v4';
type WranglerCommand = 'whoami' | 'token' | 'namespaces';
type WranglerCapture = (command: WranglerCommand) => string;
type WranglerSelection = { account?: string; credential?: string; checks: Check[] };
export function privateWranglerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Routine renewal of the same OAuth login is allowed. Noninteractive mode
  // prevents a new browser login or consent flow when renewal is unavailable.
  const environment: NodeJS.ProcessEnv = { ...source, CI: 'true', WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_SANITIZE: 'true', WRANGLER_LOG: 'log' };
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_KEY', 'CLOUDFLARE_EMAIL', 'CF_EMAIL']) delete environment[key];
  return environment;
}
function captureWrangler(command: WranglerCommand): string {
  const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
  const commandArgs = command === 'whoami' ? ['whoami', '--json'] : command === 'token' ? ['auth', 'token', '--json'] : ['artifacts', 'namespaces', 'list', '--json'];
  // Never inherit stdio: auth-token output and arbitrary CLI failures are secret.
  // WRANGLER_WRITE_LOGS=false also prevents Wrangler's own logger persisting it.
  return execFileSync(process.execPath, [wrangler, ...commandArgs], { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    env: privateWranglerEnvironment(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
}
function cliFailure(error: unknown): Record<string, unknown> {
  const failure = error as { stdout?: unknown; stderr?: unknown; status?: unknown } | null;
  const diagnostics = String(failure?.stdout || '') + String(failure?.stderr || '');
  return { exitCode: typeof failure?.status === 'number' && Number.isInteger(failure.status) ? failure.status : null,
    authenticationExpired: /your auth token has expired|token-expired-non-interactive|token-expired-login-failed/i.test(diagnostics),
    apiErrorCodes: [...diagnostics.matchAll(/\[code: ([0-9]{1,9})\]/g)].map(match => Number(match[1])) };
}
function wranglerIdentity(raw: string, selectedAccount?: string): { account?: string; check: Check } {
  const auth = JSON.parse(raw) as { loggedIn?: unknown; authType?: unknown; tokenPermissions?: unknown; accounts?: unknown };
  const authenticated = auth.loggedIn === true;
  const oauth = auth.authType === 'OAuth Token';
  const artifactsWrite = Array.isArray(auth.tokenPermissions) && auth.tokenPermissions.includes('artifacts:write');
  const accountIds = Array.isArray(auth.accounts) ? auth.accounts.map(item => item && typeof item === 'object' && 'id' in item ? item.id : null).filter((id): id is string => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)) : [];
  const uniqueIds = [...new Set(accountIds)];
  const selected = selectedAccount ?? (uniqueIds.length === 1 ? uniqueIds[0] : undefined);
  const accountMatches = typeof selected === 'string' && /^[a-f0-9]{32}$/.test(selected) && uniqueIds.includes(selected);
  const permitted = authenticated && oauth && artifactsWrite && accountMatches;
  const reason = !authenticated ? 'WRANGLER_LOGIN_REQUIRED' : !oauth ? 'EXISTING_WRANGLER_OAUTH_REQUIRED' : !accountMatches ? 'WRANGLER_SELECTED_ACCOUNT_UNAVAILABLE' : !artifactsWrite ? 'WRANGLER_ARTIFACTS_SCOPE_REQUIRED' : 'WRANGLER_ACCOUNT_AND_SCOPE_VERIFIED';
  return { ...(accountMatches ? { account: selected } : {}), check: { name: 'wrangler-account-and-artifacts-scope', status: permitted ? 'PASS' : 'BLOCKED', detail: {
    authenticated, authType: oauth ? 'oauth' : 'unsupported', artifactsWrite, accountMatches, availableAccountCount: uniqueIds.length,
    ...(accountMatches ? { selectedAccount: selected } : {}), reason, mutationPerformed: false,
  } } };
}
export function selectWranglerCredential(selectedAccount?: string, capture: WranglerCapture = captureWrangler): WranglerSelection {
  const checks: Check[] = [];
  let identity: ReturnType<typeof wranglerIdentity>;
  try { identity = wranglerIdentity(capture('whoami'), selectedAccount); checks.push(identity.check); }
  catch (error) { checks.push({ name: 'wrangler-account-and-artifacts-scope', status: 'BLOCKED', detail: { reason: 'WRANGLER_IDENTITY_UNAVAILABLE', ...cliFailure(error), mutationPerformed: false } }); return { checks }; }
  if (identity.check.status !== 'PASS') return { account: identity.account, checks };
  try {
    // Installed 4.147.0 schema: oauth/api_token use token; api_key uses key/email.
    // This path deliberately uses the stored OAuth login, not environment keys.
    const token = JSON.parse(capture('token')) as { type?: unknown; token?: unknown };
    if (token.type !== 'oauth' || typeof token.token !== 'string' || token.token.length < 16 || token.token.length > 16384 || /[\s\x00-\x1f\x7f]/.test(token.token)) throw new Error('WRANGLER_TOKEN_SCHEMA');
    checks.push({ name: 'wrangler-private-credential', status: 'PASS', detail: { credentialSource: 'existing-wrangler-oauth', tokenRetrieved: true, tokenOutputPersisted: false, mutationPerformed: false } });
    return { account: identity.account, credential: token.token, checks };
  } catch (error) { checks.push({ name: 'wrangler-private-credential', status: 'BLOCKED', detail: { reason: 'WRANGLER_CREDENTIAL_UNAVAILABLE', ...cliFailure(error), tokenOutputPersisted: false, mutationPerformed: false } }); return { account: identity.account, checks }; }
}
function selectCredential(useWrangler: boolean, configuredAccount?: string, configuredCredential?: string, capture: WranglerCapture = captureWrangler): WranglerSelection {
  if (useWrangler) return selectWranglerCredential(configuredAccount, capture);
  const validAccount = typeof configuredAccount === 'string' && /^[a-f0-9]{32}$/.test(configuredAccount);
  const validToken = typeof configuredCredential === 'string' && configuredCredential.length >= 16 && configuredCredential.length <= 16384 && !/[\s\x00-\x1f\x7f]/.test(configuredCredential);
  const ready = validAccount && validToken;
  return { ...(ready ? { account: configuredAccount, credential: configuredCredential } : {}), checks: [{ name: 'provider-credentials', status: ready ? 'PASS' : 'BLOCKED', detail: {
    credentialSource: 'explicit-api-token', accountConfigured: validAccount, tokenConfigured: validToken,
    reason: ready ? 'EXPLICIT_API_TOKEN_SELECTED' : 'ARTIFACTS_API_CREDENTIALS_REQUIRED',
    ...(ready ? {} : { hint: 'Supply CLOUDFLARE_ACCOUNT_ID and an Artifacts-capable CLOUDFLARE_API_TOKEN privately, or use --use-wrangler.' }), mutationPerformed: false,
  } }] };
}
function check(name: string, condition: boolean, detail: Record<string, unknown> = {}) {
  report.checks.push({ name, status: condition ? 'PASS' : 'FAIL', detail });
  if (!condition) throw new Error(`CHECK_FAILED:${name}`);
}
let pendingSave = Promise.resolve();
async function persist() {
  const snapshot = JSON.stringify(report, null, 2) + '\n';
  const saving = pendingSave.then(() => persistSnapshot(snapshot));
  pendingSave = saving.catch(() => {});
  await saving;
}
async function persistSnapshot(snapshot: string) {
  await mkdir(dirname(reportPath), { recursive: true });
  const temporary = resolve(dirname(reportPath), `.${basename(reportPath)}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(snapshot); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, reportPath);
    const directory = await open(dirname(reportPath), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}
async function trackedGitUpdate(identity: Omit<GitDispatch, 'phase' | 'startedAt'>, send: () => Promise<RefResult>, save = persist, dispatches = report.gitUpdates): Promise<RefResult> {
  const dispatch: GitDispatch = { ...identity, startedAt: new Date().toISOString(), phase: 'MAY_HAVE_DISPATCHED' };
  dispatches.push(dispatch); await save();
  try {
    const result = await send();
    dispatch.phase = result.accepted ? 'ACCEPTED' : 'REJECTED'; dispatch.result = result; await save();
    return result;
  } catch (error) {
    dispatch.phase = 'UNKNOWN'; dispatch.reason = safeReason(error); await save(); throw error;
  }
}
async function trackedCreate<T>(kind: 'namespace' | 'repository', send: () => Promise<T>, save: () => Promise<void> = persist, resources: Resources = report.resources): Promise<T> {
  const field = kind === 'namespace' ? 'namespaceCreation' : 'repositoryCreation';
  resources[field] = 'MAY_HAVE_DISPATCHED';
  if (kind === 'repository') resources.created = null;
  resources.cleanup = 'CREATION_CONFIRMATION_PENDING';
  // Persist the dispatch fence before any request can possibly reach the provider.
  await save();
  try {
    const result = await send(); resources[field] = 'ACKNOWLEDGED';
    if (kind === 'repository') resources.created = true;
    await save();
    return result;
  } catch (error) {
    // A missing response is not evidence that an intended resource was never created.
    resources[field] = 'UNKNOWN'; resources.cleanup = 'RECONCILIATION_REQUIRED';
    if (kind === 'repository') resources.created = null;
    await save();
    throw error;
  }
}
async function bounded(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) { const { done, value: chunk } = await reader.read(); if (done) break; total += chunk.length; if (total > maximum) throw new Error('RESPONSE_SIZE_LIMIT'); chunks.push(chunk); }
  } finally { await reader.cancel().catch(() => {}); }
  const result = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  assert.match(account || '', /^[a-f0-9]{32}$/);
  const response = await fetch(`${API_ROOT}/accounts/${account}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = JSON.parse(new TextDecoder().decode(await bounded(response, 1024 * 1024))) as ApiEnvelope<T>;
  // Provider message bodies can contain arbitrary text; retain only numeric codes/status.
  if (!response.ok || parsed.success !== true) throw new Error(`ARTIFACTS_API_${response.status}:codes=${(parsed.errors || []).map(e => e.code).join(',')}`);
  return parsed.result;
}
function safeReason(error: unknown): string {
  const reason = error instanceof Error ? error.message : 'UNEXPECTED_ERROR';
  if (/^(ARTIFACTS_API_[0-9]+:codes=[0-9,]*|CHECK_FAILED:[a-z0-9-]+|[A-Z][A-Z0-9_:.-]+)$/.test(reason)) return reason;
  return error instanceof Error ? `UNEXPECTED_${error.name.replace(/[^A-Za-z0-9]/g, '')}` : 'UNEXPECTED_ERROR';
}
function httpClient(remote: string, token: string): git.HttpClient {
  const permitted = validateRemote(remote);
  return { async request({ url, method, headers, body }) {
    const target = new URL(url);
    if (target.origin !== permitted.origin || !target.pathname.startsWith(permitted.pathname + '/') || target.username || target.password) throw new Error('GIT_ROUTE_DENIED');
    const chunks: Uint8Array[] = []; let total = 0;
    if (body) for await (const chunk of body) { total += chunk.length; if (total > 4 * 1024 * 1024) throw new Error('REQUEST_SIZE_LIMIT'); chunks.push(chunk); }
    const payload = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { payload.set(chunk, offset); offset += chunk.length; }
    const outgoing = new Headers(headers); outgoing.delete('cookie'); outgoing.set('authorization', `Bearer ${token}`);
    const response = await fetch(target, { method, redirect: 'error', headers: outgoing, signal: AbortSignal.timeout(20_000), ...(total ? { body: payload.slice().buffer } : {}) });
    const bytes = await bounded(response, 4 * 1024 * 1024);
    return { url, method: method || 'GET', statusCode: response.status, statusMessage: response.statusText, headers: Object.fromEntries(response.headers.entries()), body: (async function* () { yield bytes; })() };
  } };
}
const fs = createFsFromVolume(new Volume()); const dir = '/preflight';
const objects = new Map<string, { type: 'commit' | 'tree' | 'blob'; bytes: Uint8Array }>();
async function retain(oid: string, type: 'commit' | 'tree' | 'blob') {
  const raw = await git.readObject({ fs, dir, oid, format: 'content' });
  objects.set(oid, { type, bytes: new Uint8Array(raw.object as Uint8Array) });
}
const binary = new Uint8Array([0, 255, 128, 13, 10, 37]);
async function makeCommit(label: string, parent?: string): Promise<string> {
  const blob = await git.writeBlob({ fs, dir, blob: new TextEncoder().encode(`Owned Confidence preflight ${label}\n`) }); await retain(blob, 'blob');
  const binaryOid = await git.writeBlob({ fs, dir, blob: binary }); await retain(binaryOid, 'blob');
  const tree = await git.writeTree({ fs, dir, tree: [{ path: 'fixture.txt', mode: '100644', type: 'blob', oid: blob }, { path: 'binary.bin', mode: '100755', type: 'blob', oid: binaryOid }] }); await retain(tree, 'tree');
  const identity = { name: 'Confidence owned preflight', email: 'preflight@confidence.invalid', timestamp: 1791158400, timezoneOffset: 0 };
  const oid = await git.writeCommit({ fs, dir, commit: { tree, parent: parent ? [parent] : [], author: identity, committer: identity, message: `${label}\n` } }); await retain(oid, 'commit');
  return oid;
}
async function closure(commit: string): Promise<string[]> {
  const entry = await git.readCommit({ fs, dir, oid: commit });
  const tree = await git.readTree({ fs, dir, oid: entry.commit.tree });
  return [commit, entry.commit.tree, ...tree.tree.map(item => item.oid)];
}
async function fixedUpdate(remote: string, token: string, oldHead: string, newHead: string, ref: string): Promise<RefResult> {
  const endpoint = validateRemote(remote);
  const packed = await git.packObjects({ fs, dir, oids: await closure(newHead) });
  if (!packed.packfile) throw new Error('PACK_CREATION_FAILED');
  const payload = buildReceivePack(oldHead, newHead, ref, packed.packfile);
  return trackedGitUpdate({ remote: endpoint.href, oldHead, newHead, ref, requestDigest: hash(payload) }, async () => {
  const response = await fetch(`${endpoint.href}/git-receive-pack`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result',
  }, body: payload.slice().buffer });
  const bytes = await bounded(response, 64 * 1024); const observed = parseReceivePack(bytes, ref);
  if (!response.ok) throw new Error(`GIT_HTTP_${response.status}`);
  return { oldHead, newHead, ref, httpStatus: response.status, accepted: observed.accepted, responseDigest: hash(bytes), requestDigest: hash(payload), report: observed.reason };
  });
}
async function head(remote: string, token: string, ref: string): Promise<string | null> {
  return (await git.listServerRefs({ http: httpClient(remote, token), url: remote, prefix: ref })).find(item => item.ref === ref)?.oid || null;
}
async function exactRoundtrip(remote: string, token: string, commit: string, branch: string, restPath = repoPath): Promise<Record<string, unknown>> {
  const returnedFs = createFsFromVolume(new Volume());
  await git.clone({ fs: returnedFs, dir: '/roundtrip', http: httpClient(remote, token), url: remote, ref: branch, singleBranch: true, depth: 1, noCheckout: true });
  assert.equal(await git.resolveRef({ fs: returnedFs, dir: '/roundtrip', ref: 'HEAD' }), commit);
  const ids = await closure(commit);
  for (const oid of ids) {
    const raw = await git.readObject({ fs: returnedFs, dir: '/roundtrip', oid, format: 'content' });
    assert.deepEqual(new Uint8Array(raw.object as Uint8Array), objects.get(oid)!.bytes);
  }
  const parsed = await git.readCommit({ fs: returnedFs, dir: '/roundtrip', oid: commit });
  const tree = await git.readTree({ fs: returnedFs, dir: '/roundtrip', oid: parsed.commit.tree });
  assert.equal(tree.tree.find(entry => entry.path === 'binary.bin')?.mode, '100755');
  const fileResponse = await fetch(`${API_ROOT}/accounts/${account}${restPath}/file?ref=${commit}&path=binary.bin`, { redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${credential}` } });
  assert.equal(fileResponse.status, 200); assert.deepEqual(await bounded(fileResponse, 1024), binary);
  return { commit, objectCount: ids.length, rawCommitDigest: hash(objects.get(commit)!.bytes), objectDigests: Object.fromEntries(ids.map(oid => [oid, hash(objects.get(oid)!.bytes)])), regularAndExecutableModes: true, restBinaryReadExact: true };
}
async function cleanup() {
  if (report.forkResources) await cleanupRepository(createdFork, forkPath, report.forkResources);
  await cleanupRepository(createdRepo, repoPath, report.resources);
  if (report.status === 'PASS') {
    const clean = [report.resources, report.forkResources].every(resource => resource && ['REPOSITORY_RETAINED_TOKENS_REVOKED', 'REPOSITORY_DELETION_ACKNOWLEDGED_NAMESPACE_RETAINED'].includes(resource.cleanup || ''));
    report.checks.push({ name: 'owned-repository-tokens-revoked', status: clean ? 'PASS' : 'FAIL', detail: { canonical: report.resources.cleanup, fork: report.forkResources?.cleanup, deletionIsAcknowledgmentOnly: true } });
    if (!clean) report.status = 'FAIL';
  }
}
async function cleanupRepository(created: Repo | undefined, path: string, resources: Resources) {
  if (!created) {
    if ([resources.namespaceCreation, resources.repositoryCreation].some(phase => phase === 'UNKNOWN' || phase === 'MAY_HAVE_DISPATCHED')) resources.cleanup = 'RECONCILIATION_REQUIRED';
    else if (resources.namespaceCreation === 'ACKNOWLEDGED') resources.cleanup = 'NO_REPOSITORY_CREATE_DISPATCHED_NAMESPACE_RETAINED';
    else resources.cleanup = 'NO_REMOTE_CREATE_DISPATCHED';
    return;
  }
  try {
    const current = await api<{ id: string; description: string }>(path);
    if (current.id !== created.id || current.description !== `Confidence disposable preflight ${report.runId}`) throw new Error('CLEANUP_ASSOCIATION_MISMATCH');
    const tokens = await api<{ id: string }[]>(`${path}/tokens?state=active&per_page=100`);
    if (!Array.isArray(tokens) || tokens.length >= 100 || tokens.some(token => typeof token.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(token.id))) throw new Error('TOKEN_INVENTORY_UNBOUNDED');
    for (const token of tokens) await api(`/artifacts/namespaces/${namespace}/tokens/${encodeURIComponent(token.id)}`, 'DELETE');
    const remaining = await api<unknown[]>(`${path}/tokens?state=active&per_page=100`);
    if (!Array.isArray(remaining) || remaining.length !== 0) throw new Error('TOKEN_REVOCATION_UNCONFIRMED');
    if (args.includes('--keep-repo')) resources.cleanup = 'REPOSITORY_RETAINED_TOKENS_REVOKED';
    else { await api(path, 'DELETE'); resources.cleanup = 'REPOSITORY_DELETION_ACKNOWLEDGED_NAMESPACE_RETAINED'; }
  } catch (error) { resources.cleanup = `CLEANUP_UNCONFIRMED:${safeReason(error)}`; }
  await persist();
}
async function main() {
  for (const filename of ARTIFACTS_PREFLIGHT_SOURCES) report.sourceDigests[filename] = hash(await readFile(resolve(root, filename)));
  try { report.sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); report.sourceDirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Source digests still pin the tested files. */ }
  for (const name of ['wrangler', 'isomorphic-git', 'memfs']) report.versions[name] = JSON.parse(await readFile(resolve(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  if (args.includes('--probe-wrangler')) {
    // Capture CLI output privately: whoami contains personal identity fields and
    // error diagnostics can contain arbitrary remote text. Retain only scope/code facts.
    try { const identity = wranglerIdentity(captureWrangler('whoami'), account); report.checks.push({ ...identity.check, name: 'wrangler-artifacts-scope' }); }
    catch (error) { report.checks.push({ name: 'wrangler-artifacts-scope', status: 'BLOCKED', detail: { reason: 'WRANGLER_IDENTITY_UNAVAILABLE', ...cliFailure(error), mutationPerformed: false } }); return; }
    try {
      const raw = captureWrangler('namespaces');
      const namespaces = JSON.parse(raw) as unknown;
      report.checks.push({ name: 'wrangler-artifacts-read-access', status: 'PASS', detail: { responseShape: Array.isArray(namespaces) ? 'array' : 'object', namespaceCount: Array.isArray(namespaces) ? namespaces.length : null, mutationPerformed: false } });
    } catch (error) {
      report.checks.push({ name: 'wrangler-artifacts-read-access', status: 'BLOCKED', detail: { ...cliFailure(error), mutationPerformed: false } });
    }
    report.status = 'BLOCKED';
    report.limitations.push('This read-only OAuth probe does not exercise Git publication. The separate --run path requires either an explicit Artifacts-capable API token or --use-wrangler with a verified account and Artifacts-capable existing login.');
    return;
  }
  await git.init({ fs, dir });
  const B = await makeCommit('baseline'), N = await makeCommit('child-N', B), N1 = await makeCommit('race-child-1', N), N2 = await makeCommit('race-child-2', N);
  if (args.includes('--self-test')) {
    const pack = await git.packObjects({ fs, dir, oids: await closure(N) });
    const packet = buildReceivePack(B, N, 'refs/heads/main', pack.packfile!);
    const text = new TextDecoder().decode(packet.slice(4, 4 + Number.parseInt(new TextDecoder().decode(packet.slice(0, 4)), 16) - 4));
    check('fixed-packet-preserves-old-new', text.startsWith(`${B} ${N} refs/heads/main\0`), { B, N, requestDigest: hash(packet) });
    const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
    check('strict-report-parser', parseReceivePack(new TextEncoder().encode(pkt('unpack ok\n') + pkt('ok refs/heads/main\n') + '0000'), 'refs/heads/main').accepted, {});
    const mockResources: Resources = { namespace: 'owned-mock-namespace', repo: 'owned-mock-repository', created: false, namespaceCreation: 'ACKNOWLEDGED', repositoryCreation: 'NOT_DISPATCHED' };
    const savedStates: Resources[] = []; let mockRemoteCreated = false;
    try {
      await trackedCreate('repository', async () => { mockRemoteCreated = true; throw new Error('SIMULATED_LOST_CREATE_RESPONSE'); }, async () => { savedStates.push(structuredClone(mockResources)); }, mockResources);
      throw new Error('MOCK_CREATE_RESPONSE_WAS_NOT_LOST');
    } catch (error) { assert.equal((error as Error).message, 'SIMULATED_LOST_CREATE_RESPONSE'); }
    check('lost-create-response-remains-unknown', mockRemoteCreated && savedStates[0]?.repositoryCreation === 'MAY_HAVE_DISPATCHED' && savedStates[0]?.created === null && mockResources.repositoryCreation === 'UNKNOWN' && mockResources.created === null && mockResources.cleanup === 'RECONCILIATION_REQUIRED' && mockResources.namespace === 'owned-mock-namespace' && mockResources.repo === 'owned-mock-repository', { observationClass: 'owned-local-mock', dispatchFencePersisted: savedStates[0]?.repositoryCreation, remoteAppliedInMock: mockRemoteCreated, resultingState: mockResources });
    const dispatches: GitDispatch[] = [], snapshots: GitDispatch[][] = [];
    await assert.rejects(trackedGitUpdate({ remote: `https://${'a'.repeat(32)}.artifacts.cloudflare.net/git/owned/local.git`, oldHead: B, newHead: N, ref: 'refs/heads/main', requestDigest: hash(packet) }, async () => { assert.equal(snapshots[0]?.[0]?.phase, 'MAY_HAVE_DISPATCHED'); throw new Error('SIMULATED_LOST_UPDATE_RESPONSE'); }, async () => { snapshots.push(structuredClone(dispatches)); }, dispatches), /SIMULATED_LOST_UPDATE_RESPONSE/);
    check('lost-git-response-retains-frozen-intent', dispatches[0]?.phase === 'UNKNOWN' && dispatches[0]?.oldHead === B && dispatches[0]?.newHead === N && dispatches[0]?.requestDigest === hash(packet), { observationClass: 'owned-local-mock', dispatchFencePersisted: true, frozenBaseRetained: true });
    const selectedAccount = 'a'.repeat(32), otherAccount = 'b'.repeat(32), mockToken = 'owned-local-mock-secret-do-not-record';
    const whoami = (permissions: string[], accounts = [selectedAccount]) => JSON.stringify({ loggedIn: true, authType: 'OAuth Token', email: 'private-identity@example.invalid', accounts: accounts.map(id => ({ id, name: 'Private account name' })), tokenPermissions: permissions });
    const calls: WranglerCommand[] = [];
    const noScope = selectCredential(true, selectedAccount, undefined, command => { calls.push(command); return whoami(['workers:write']); });
    check('wrangler-scope-gates-token-retrieval', noScope.checks[0]?.status === 'BLOCKED' && !noScope.credential && JSON.stringify(calls) === '["whoami"]', { observationClass: 'owned-local-mock', tokenRetrieved: false, missingArtifactsScope: true });
    calls.length = 0;
    const mismatch = selectCredential(true, otherAccount, undefined, command => { calls.push(command); return whoami(['artifacts:write']); });
    const ambiguous = selectCredential(true, undefined, undefined, () => whoami(['artifacts:write'], [selectedAccount, otherAccount]));
    check('wrangler-account-gates-token-retrieval', mismatch.checks[0]?.status === 'BLOCKED' && !mismatch.credential && JSON.stringify(calls) === '["whoami"]' && ambiguous.checks[0]?.status === 'BLOCKED', { observationClass: 'owned-local-mock', wrongAccountBlocked: true, ambiguousAccountBlocked: true });
    calls.length = 0;
    const selected = selectCredential(true, selectedAccount, 'ignored-environment-token', command => { calls.push(command); return command === 'whoami' ? whoami(['artifacts:write']) : JSON.stringify({ type: 'oauth', token: mockToken }); });
    const selectedFacts = JSON.stringify(selected.checks);
    check('wrangler-secret-is-in-memory-only', selected.account === selectedAccount && selected.credential === mockToken && selected.checks.every(item => item.status === 'PASS') && JSON.stringify(calls) === '["whoami","token"]' && !selectedFacts.includes(mockToken) && !selectedFacts.includes('private-identity') && !selectedFacts.includes('Private account name'), { observationClass: 'owned-local-mock', exactAccountSelected: true, credentialRetrievedPrivately: true, identityAndCredentialOmitted: true });
    const rejectedToken = selectCredential(true, selectedAccount, undefined, command => command === 'whoami' ? whoami(['artifacts:write']) : JSON.stringify({ type: 'api_key', key: mockToken, email: 'private-identity@example.invalid' }));
    const failedCli = selectCredential(true, selectedAccount, undefined, command => { if (command === 'whoami') return whoami(['artifacts:write']); throw Object.assign(new Error(`secret ${mockToken}`), { status: 1, stdout: `secret ${mockToken}`, stderr: `private-identity [code: 10000] ${mockToken}` }); });
    check('wrangler-cli-errors-sanitized', !failedCli.credential && failedCli.checks.at(-1)?.status === 'BLOCKED' && failedCli.checks.at(-1)?.detail.exitCode === 1 && JSON.stringify(failedCli.checks.at(-1)?.detail.apiErrorCodes) === '[10000]' && !JSON.stringify(failedCli.checks).includes(mockToken) && !JSON.stringify(failedCli.checks).includes('private-identity') && rejectedToken.checks.at(-1)?.status === 'BLOCKED' && !JSON.stringify(rejectedToken.checks).includes(mockToken), { observationClass: 'owned-local-mock', arbitraryErrorsOmitted: true, numericApiCodeRetained: true, globalApiKeyRejected: true });
    const explicit = selectCredential(false, selectedAccount, mockToken, () => { throw new Error('UNEXPECTED_WRANGLER_CALL'); });
    check('explicit-token-default-skips-wrangler', explicit.account === selectedAccount && explicit.credential === mockToken && explicit.checks[0]?.status === 'PASS' && !JSON.stringify(explicit.checks).includes(mockToken), { observationClass: 'owned-local-mock', credentialSource: 'explicit-api-token', wranglerInvoked: false });
    const privateEnv = privateWranglerEnvironment({ CLOUDFLARE_API_TOKEN: mockToken, CF_API_KEY: mockToken, CF_EMAIL: 'private-identity@example.invalid', WRANGLER_WRITE_LOGS: 'true', WRANGLER_TOKEN_URL: 'https://example.invalid/renew', PATH: '/owned/mock/bin' });
    check('wrangler-subprocess-protects-existing-login', privateEnv.WRANGLER_WRITE_LOGS === 'false' && privateEnv.WRANGLER_SEND_METRICS === 'false' && privateEnv.WRANGLER_TOKEN_URL === 'https://example.invalid/renew' && privateEnv.WRANGLER_AUTH_URL === undefined && privateEnv.CI === 'true' && !privateEnv.CLOUDFLARE_API_TOKEN && !privateEnv.CF_API_KEY && !privateEnv.CF_EMAIL && privateEnv.PATH === '/owned/mock/bin', { observationClass: 'owned-local-mock', diskLoggingDisabled: true, ordinaryRenewalPreserved: true, interactiveLoginDisabled: true, environmentCredentialOverrideRemoved: true });
    report.status = 'SELF_TEST_PASS'; return;
  }
  if (!args.includes('--run')) { report.checks.push({ name: 'explicit-live-run', status: 'BLOCKED', detail: { reason: 'RUN_FLAG_REQUIRED', hint: 'Add --run to create the fresh owned namespace and repository.' } }); return; }
  const selection = selectCredential(args.includes('--use-wrangler'), account, credential); report.checks.push(...selection.checks);
  if (!selection.account || !selection.credential || selection.checks.some(item => item.status !== 'PASS')) return;
  account = selection.account; credential = selection.credential;
  report.accountId = account;
  // No caller-supplied repository or namespace can enter the mutation path.
  namespace = `confidence-preflight-${report.runId.slice(0, 12)}`;
  const name = `owned-ref-check-${report.runId.slice(13, 21)}`;
  report.resources.namespace = namespace; report.resources.repo = name; await persist();
  await trackedCreate('namespace', () => api('/artifacts/namespaces', 'POST', { namespace }));
  repoPath = `/artifacts/namespaces/${namespace}/repos/${name}`;
  createdRepo = await trackedCreate('repository', () => api<Repo>(`/artifacts/namespaces/${namespace}/repos`, 'POST', { name, default_branch: 'main', read_only: false, description: `Confidence disposable preflight ${report.runId}` }));
  report.resources.repositoryId = createdRepo.id; await persist();
  const remote = validateRemote(createdRepo.remote);
  check('remote-binds-fresh-resources', remote.hostname === `${account}.artifacts.cloudflare.net` && remote.pathname === `/git/${namespace}/${name}.git`, { remote: remote.href });
  check('initial-ref-empty', await head(createdRepo.remote, createdRepo.token, 'refs/heads/main') === null);
  const first = await fixedUpdate(createdRepo.remote, createdRepo.token, '0'.repeat(40), B, 'refs/heads/main');
  check('owned-baseline-installed', first.accepted && await head(createdRepo.remote, createdRepo.token, 'refs/heads/main') === B, { dispatch: first });
  check('baseline-exact-roundtrip', true, await exactRoundtrip(createdRepo.remote, createdRepo.token, B, 'main'));
  const advance = await fixedUpdate(createdRepo.remote, createdRepo.token, B, N, 'refs/heads/main');
  check('fixed-base-child-update', advance.accepted && await head(createdRepo.remote, createdRepo.token, 'refs/heads/main') === N, { dispatch: advance });
  const duplicate = await fixedUpdate(createdRepo.remote, createdRepo.token, B, N, 'refs/heads/main');
  check('duplicate-retains-same-commit', await head(createdRepo.remote, createdRepo.token, 'refs/heads/main') === N, { dispatch: duplicate, acknowledgement: duplicate.accepted ? 'PROVIDER_IDEMPOTENT_ACK' : 'EXPECTED_OLD_REJECTED' });
  const forkName = `${name}-fork`;
  forkPath = `/artifacts/namespaces/${namespace}/repos/${forkName}`;
  report.forkResources = { namespace, repo: forkName, created: false, namespaceCreation: 'ACKNOWLEDGED', repositoryCreation: 'NOT_DISPATCHED' };
  createdFork = await trackedCreate('repository', () => api<Repo>(`${repoPath}/fork`, 'POST', { name: forkName, description: `Confidence disposable preflight ${report.runId}`, default_branch_only: false, read_only: false }), persist, report.forkResources);
  report.forkResources.repositoryId = createdFork.id; await persist();
  const forkRemote = validateRemote(createdFork.remote);
  check('fork-binds-fresh-resources', forkRemote.hostname === `${account}.artifacts.cloudflare.net` && forkRemote.pathname === `/git/${namespace}/${forkName}.git`, { remote: forkRemote.href });
  check('fork-observes-current-head', await head(createdFork.remote, createdFork.token, 'refs/heads/main') === N, { requestedHistoricalBase: B, currentCanonicalHead: N });
  const pinned = await fixedUpdate(createdFork.remote, createdFork.token, '0'.repeat(40), B, 'refs/heads/confidence-pinned-base');
  check('moving-head-fork-pinned-base', pinned.accepted, { dispatch: pinned, roundtrip: await exactRoundtrip(createdFork.remote, createdFork.token, B, 'confidence-pinned-base', forkPath) });
  const unpublished = await makeCommit('unpublished-repair-base', B);
  const transferred = await fixedUpdate(createdFork.remote, createdFork.token, '0'.repeat(40), unpublished, 'refs/heads/confidence-work');
  check('unpublished-work-source-transfer', transferred.accepted, { dispatch: transferred, publicationBase: B, roundtrip: await exactRoundtrip(createdFork.remote, createdFork.token, unpublished, 'confidence-work', forkPath) });
  check('fork-does-not-advance-canonical', await head(createdRepo.remote, createdRepo.token, 'refs/heads/main') === N && await head(createdFork.remote, createdFork.token, 'refs/heads/main') === N);
  const readToken = await api<{ id: string; plaintext: string; scope: string; expires_at: string }>(`/artifacts/namespaces/${namespace}/tokens`, 'POST', { repo: name, scope: 'read', ttl: 300 });
  assert.equal(readToken.scope, 'read');
  check('read-token-exact-roundtrip', true, await exactRoundtrip(createdRepo.remote, readToken.plaintext, N, 'main'));
  await api(`/artifacts/namespaces/${namespace}/tokens/${encodeURIComponent(readToken.id)}`, 'DELETE');
  const revokedRead = await fetch(`${remote.href}/info/refs?service=git-upload-pack`, { redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${readToken.plaintext}` } });
  const revokedBytes = await bounded(revokedRead, 64 * 1024);
  check('revoked-read-token-denied', revokedRead.status === 401 || revokedRead.status === 403, { httpStatus: revokedRead.status, responseDigest: hash(revokedBytes) });
  const race = await Promise.allSettled([fixedUpdate(createdRepo.remote, createdRepo.token, N, N1, 'refs/heads/main'), fixedUpdate(createdRepo.remote, createdRepo.token, N, N2, 'refs/heads/main')]);
  const dispatches = race.map(result => result.status === 'fulfilled' ? result.value : { uncertain: true, reason: safeReason(result.reason) });
  check('race-both-outcomes-observed', race.every(result => result.status === 'fulfilled'), { dispatches });
  const fulfilled = race.map(result => (result as PromiseFulfilledResult<RefResult>).value);
  const winners = fulfilled.filter(result => result.accepted);
  const observedHead = await head(createdRepo.remote, createdRepo.token, 'refs/heads/main');
  check('one-fixed-base-race-winner', winners.length === 1 && observedHead === winners[0].newHead, { dispatches: fulfilled, observedHead });
  const loser = fulfilled.find(result => !result.accepted)!;
  const retriedLoser = await fixedUpdate(createdRepo.remote, createdRepo.token, loser.oldHead, loser.newHead, loser.ref);
  check('loser-retry-keeps-original-base', !retriedLoser.accepted && await head(createdRepo.remote, createdRepo.token, 'refs/heads/main') === observedHead, { dispatch: retriedLoser });
  check('winning-source-exact-roundtrip', true, await exactRoundtrip(createdRepo.remote, createdRepo.token, observedHead!, 'main'));
  const currentDigests = Object.fromEntries(await Promise.all(ARTIFACTS_PREFLIGHT_SOURCES.map(async filename => [filename, hash(await readFile(resolve(root, filename)))])));
  check('source-inputs-unchanged', JSON.stringify(currentDigests) === JSON.stringify(report.sourceDigests), { files: ARTIFACTS_PREFLIGHT_SOURCES.length, sourceDirty: report.sourceDirty ?? null });
  check('all-git-dispatches-resolved', report.gitUpdates.length > 0 && report.gitUpdates.every(dispatch => dispatch.phase === 'ACCEPTED' || dispatch.phase === 'REJECTED'), { count: report.gitUpdates.length });
  report.status = 'PASS';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) { report.status = 'FAIL'; report.checks.push({ name: 'execution', status: 'FAIL', detail: { reason: safeReason(error) } }); }
  finally { await cleanup(); if (report.status === 'PASS' && ARTIFACTS_PREFLIGHT_CHECKS.some(name => !report.checks.some(check => check.name === name && check.status === 'PASS'))) report.status = 'FAIL'; report.completedAt = new Date().toISOString(); await persist(); }
  process.stdout.write(JSON.stringify({ status: report.status, report: reportPath, checks: report.checks.map(({ name, status }) => ({ name, status })), cleanup: report.resources.cleanup }) + '\n');
  if (report.status === 'FAIL') process.exitCode = 1;
  else if (report.status === 'BLOCKED') process.exitCode = 2;
}
