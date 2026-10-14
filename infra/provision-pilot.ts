// SPDX-License-Identifier: Apache-2.0
// Creates empty named resources only. No repository, object, secret, or Worker
// upload is part of provisioning. The default command makes no API request.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

type Dictionary = Record<string, unknown>;
type Kind = 'r2' | 'queue' | 'd1' | 'artifacts';
type ResourceState = 'PLANNED' | 'OBSERVED' | 'MAY_HAVE_DISPATCHED' | 'UNKNOWN' | 'ACKNOWLEDGED' | 'BLOCKED';
interface Resource {
  key: string; kind: Kind; name: string; state: ResourceState; id?: string;
  attemptId?: string; createMayHaveOccurred?: boolean; observedAt?: string;
  reason?: string; httpStatus?: number; apiCodes?: number[];
}
interface Config {
  accountId: string; artifactsNamespace: string; objectBucket?: string;
  eventQueue?: string; deadLetterQueue?: string; projectionDatabase?: { name: string; id: string };
}
interface Report {
  schemaVersion: 1; scopeDigest: string; accountId: string; status: 'BLOCKED' | 'PASS';
  mode: 'PLAN' | 'RUN'; accountVerified: boolean; updatedAt: string;
  resources: Resource[]; blockers: string[]; operatorConfig?: { projectionDatabase: { name: string; id: string } };
  credentialSource?: 'explicit-api-token' | 'existing-wrangler-oauth';
  authenticationChecks?: CredentialSelection['checks'];
  limitations: string[]; sources: string[];
}
interface Options {
  run: boolean; token?: string; expectedAccount?: string; fetcher?: typeof fetch;
  timeoutMs?: number; progress?: (resource: Resource) => void;
  artifactsOnly?: boolean; useWrangler?: boolean; credentialSelector?: (account: string) => CredentialSelection;
}
interface CredentialSelection { account?: string; credential?: string; checks: { name: string; status: string; detail: Dictionary }[]; }
const accountPattern = /^[a-f0-9]{32}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_JSON_BYTES = 256 * 1024, MAX_PAGES = 25;
const sources = [
  'https://developers.cloudflare.com/api/resources/accounts/methods/get/',
  'https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/get/',
  'https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/',
  'https://developers.cloudflare.com/api/resources/queues/methods/list/',
  'https://developers.cloudflare.com/api/resources/queues/methods/create/',
  'https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/list/',
  'https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/',
  'https://developers.cloudflare.com/artifacts/api/rest-api/',
];
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const ensure = (condition: unknown, code: string): void => { if (!condition) throw new SafeError(code); };
class SafeError extends Error {
  constructor(readonly code: string, readonly httpStatus?: number, readonly apiCodes?: number[]) { super(code); }
}
function dictionary(value: unknown): Dictionary {
  ensure(value && typeof value === 'object' && !Array.isArray(value), 'CONFIG_OBJECT_REQUIRED'); return value as Dictionary;
}
function safeName(value: unknown, minimum = 2): string {
  ensure(typeof value === 'string' && value.length >= minimum && value.length <= 63 && /^[a-z][a-z0-9-]*[a-z0-9]$/.test(value), 'CONFIG_RESOURCE_NAME'); return value as string;
}
function parseConfig(value: unknown, artifactsOnly = false): Config {
  const config = dictionary(value);
  ensure(config.schemaVersion === 1 && typeof config.accountId === 'string' && (accountPattern.test(config.accountId) || config.accountId === 'REPLACE_WITH_32_HEX_ACCOUNT_ID'), 'CONFIG_ACCOUNT');
  ensure(typeof config.artifactsNamespace === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,62}$/.test(config.artifactsNamespace), 'CONFIG_ARTIFACTS_NAMESPACE');
  const scope = { accountId: config.accountId as string, artifactsNamespace: config.artifactsNamespace as string };
  if (artifactsOnly) return scope;
  const database = dictionary(config.projectionDatabase);
  ensure(typeof database.id === 'string' && (uuidPattern.test(database.id) || database.id === 'REPLACE_WITH_D1_UUID' || database.id === 'UNCONFIGURED'), 'CONFIG_D1_ID');
  const result = { ...scope, objectBucket: safeName(config.objectBucket, 3), eventQueue: safeName(config.eventQueue), deadLetterQueue: safeName(config.deadLetterQueue), projectionDatabase: { name: safeName(database.name), id: database.id as string } };
  ensure(result.eventQueue !== result.deadLetterQueue, 'CONFIG_QUEUES_DISTINCT'); return result;
}
function intendedResources(config: Config, artifactsOnly = false): Resource[] {
  const artifacts: Resource = { key: 'artifactsNamespace', kind: 'artifacts', name: config.artifactsNamespace, state: 'PLANNED' };
  if (artifactsOnly) return [artifacts];
  ensure(config.objectBucket && config.deadLetterQueue && config.eventQueue && config.projectionDatabase, 'FULL_PROVISION_CONFIG_REQUIRED');
  return [
    { key: 'objectBucket', kind: 'r2', name: config.objectBucket!, state: 'PLANNED' },
    { key: 'deadLetterQueue', kind: 'queue', name: config.deadLetterQueue!, state: 'PLANNED' },
    { key: 'eventQueue', kind: 'queue', name: config.eventQueue!, state: 'PLANNED' },
    { key: 'projectionDatabase', kind: 'd1', name: config.projectionDatabase!.name, state: 'PLANNED' },
    artifacts,
  ];
}
async function boundedFile(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size; ensure(size <= MAX_JSON_BYTES, 'LOCAL_JSON_SIZE_LIMIT');
    const buffer = Buffer.alloc(size + 1); const { bytesRead } = await handle.read(buffer, 0, size + 1, 0);
    ensure(bytesRead <= size, 'LOCAL_JSON_CHANGED'); return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
async function persist(path: string, report: Report): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`; const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path); const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function readReport(path: string, config: Config, planned: Resource[], scopeDigest: string): Promise<Report | null> {
  let prior: Dictionary;
  try { prior = dictionary(JSON.parse(await boundedFile(path))); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new SafeError('EXISTING_REPORT_INVALID');
  }
  ensure(prior.schemaVersion === 1 && prior.scopeDigest === scopeDigest && prior.accountId === config.accountId && Array.isArray(prior.resources) && prior.resources.length === planned.length, 'REPORT_SCOPE_MISMATCH');
  const resources = (prior.resources as unknown[]).map((raw, index): Resource => {
    const value = dictionary(raw), intent = planned[index];
    ensure(value.key === intent.key && value.name === intent.name && value.kind === intent.kind && ['PLANNED', 'OBSERVED', 'MAY_HAVE_DISPATCHED', 'UNKNOWN', 'ACKNOWLEDGED', 'BLOCKED'].includes(String(value.state)), 'REPORT_RESOURCE_MISMATCH');
    const result: Resource = { ...intent, state: value.state as ResourceState };
    if (value.id !== undefined) {
      ensure(typeof value.id === 'string' && value.id.length <= 128 && (intent.kind === 'artifacts' || intent.kind === 'r2' ? value.id === intent.name : /^[a-zA-Z0-9-]+$/.test(value.id)), 'REPORT_ID_INVALID');
      result.id = value.id as string;
    }
    if (value.attemptId !== undefined) { ensure(typeof value.attemptId === 'string' && uuidPattern.test(value.attemptId), 'REPORT_ATTEMPT_INVALID'); result.attemptId = value.attemptId as string; }
    if (value.createMayHaveOccurred === true) result.createMayHaveOccurred = true;
    if (result.state === 'UNKNOWN' || result.state === 'MAY_HAVE_DISPATCHED') result.createMayHaveOccurred = true;
    if (typeof value.reason === 'string' && /^[A-Z_]{1,96}$/.test(value.reason)) result.reason = value.reason;
    if (typeof value.httpStatus === 'number' && Number.isSafeInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) result.httpStatus = value.httpStatus;
    if (Array.isArray(value.apiCodes)) result.apiCodes = value.apiCodes.filter((code): code is number => typeof code === 'number' && Number.isSafeInteger(code)).slice(0, 16);
    if (typeof value.observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(value.observedAt) && value.observedAt.length <= 32) result.observedAt = value.observedAt;
    return result;
  });
  return { schemaVersion: 1, scopeDigest, accountId: config.accountId, mode: 'PLAN', accountVerified: false, status: 'BLOCKED', updatedAt: new Date().toISOString(), resources, blockers: [], limitations: [], sources };
}
class CloudflareApi {
  constructor(private readonly account: string, private readonly token: string, private readonly fetcher: typeof fetch, private readonly timeoutMs: number) {}
  async request(method: 'GET' | 'POST', path: string, body?: unknown, allowAbsent = false): Promise<{ result: unknown; resultInfo: Dictionary; status: number } | null> {
    ensure(path.startsWith(`/accounts/${this.account}`) && !path.includes('..'), 'API_SCOPE_REQUIRED');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response | undefined;
    try {
      response = await this.fetcher('https://api.cloudflare.com/client/v4' + path, { method, headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, redirect: 'error' });
      const length = response.headers.get('content-length');
      if (length !== null) ensure(/^\d+$/.test(length) && Number(length) <= MAX_JSON_BYTES, 'API_RESPONSE_SIZE_LIMIT');
      ensure(response.body, 'API_RESPONSE_MISSING'); const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; ensure(size <= MAX_JSON_BYTES, 'API_RESPONSE_SIZE_LIMIT'); chunks.push(chunk.value); } }
      finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const bytes = Buffer.concat(chunks, size); let payload: Dictionary;
      try { payload = dictionary(JSON.parse(bytes.toString('utf8'))); } catch { throw new SafeError('API_RESPONSE_INVALID', response.status); }
      const codes = Array.isArray(payload.errors) ? payload.errors.map(error => dictionary(error).code).filter((code): code is number => typeof code === 'number' && Number.isSafeInteger(code)).slice(0, 16) : [];
      if (allowAbsent && response.status === 404 && payload.success === false) return null;
      if (!response.ok || payload.success !== true) throw new SafeError('API_REQUEST_REJECTED', response.status, codes);
      return { result: payload.result, resultInfo: payload.result_info && typeof payload.result_info === 'object' ? dictionary(payload.result_info) : {}, status: response.status };
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError(controller.signal.aborted ? 'API_TIMEOUT' : 'API_TRANSPORT_UNCERTAIN', response?.status);
    } finally { clearTimeout(timeout); }
  }
}
function observedIdentity(resource: Resource, value: unknown, config: Config): string {
  const result = dictionary(value);
  if (resource.kind === 'r2') { ensure(result.name === resource.name, 'RESOURCE_NAME_MISMATCH'); return resource.name; }
  if (resource.kind === 'artifacts') { ensure(result.namespace === resource.name, 'RESOURCE_NAME_MISMATCH'); return resource.name; }
  if (resource.kind === 'queue') { ensure(result.queue_name === resource.name && typeof result.queue_id === 'string' && accountPattern.test(result.queue_id), 'QUEUE_IDENTITY_MISMATCH'); return result.queue_id as string; }
  ensure(result.name === resource.name && typeof result.uuid === 'string' && uuidPattern.test(result.uuid), 'D1_IDENTITY_MISMATCH');
  if (uuidPattern.test(config.projectionDatabase!.id)) ensure(result.uuid === config.projectionDatabase!.id, 'D1_CONFIGURED_ID_MISMATCH');
  return result.uuid as string;
}
async function lookup(api: CloudflareApi, config: Config, resource: Resource): Promise<string | null> {
  const base = `/accounts/${config.accountId}`;
  if (resource.kind === 'r2' || resource.kind === 'artifacts') {
    const path = resource.kind === 'r2' ? `/r2/buckets/${resource.name}` : `/artifacts/namespaces/${resource.name}`;
    const value = await api.request('GET', base + path, undefined, true); return value ? observedIdentity(resource, value.result, config) : null;
  }
  if (resource.kind === 'd1' && uuidPattern.test(config.projectionDatabase!.id)) {
    const value = await api.request('GET', `${base}/d1/database/${config.projectionDatabase!.id}`, undefined, true);
    // A configured UUID is an identity assertion, never a create request.
    ensure(value, 'D1_CONFIGURED_ID_NOT_FOUND'); return observedIdentity(resource, value!.result, config);
  }
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({ page: String(page), name: resource.name });
    if (resource.kind === 'd1') params.set('per_page', '100');
    const endpoint = resource.kind === 'queue' ? '/queues' : '/d1/database';
    const response = await api.request('GET', `${base}${endpoint}?${params}`); ensure(response && Array.isArray(response.result), 'API_LIST_INVALID');
    const list = response!.result as unknown[]; const matches = list.filter(value => dictionary(value)[resource.kind === 'queue' ? 'queue_name' : 'name'] === resource.name);
    ensure(matches.length <= 1, 'RESOURCE_NAME_AMBIGUOUS'); if (matches.length) return observedIdentity(resource, matches[0], config);
    if (list.length === 0) return null;
    const totalPages = response!.resultInfo.total_pages, totalCount = response!.resultInfo.total_count, perPage = response!.resultInfo.per_page;
    if (typeof totalPages === 'number' && Number.isSafeInteger(totalPages) && totalPages >= 0 && page >= totalPages) return null;
    if (typeof totalCount === 'number' && Number.isSafeInteger(totalCount) && totalCount >= 0 && typeof perPage === 'number' && Number.isSafeInteger(perPage) && perPage > 0 && page * perPage >= totalCount) return null;
    if (resource.kind === 'd1' && list.length < 100) return null;
    // Queue pagination comes from installed Wrangler's page/name list route.
    // When metadata is absent, continue until an explicit empty page.
  }
  throw new SafeError('API_LIST_PAGE_BOUND');
}
function createRequest(config: Config, resource: Resource): { path: string; body: unknown } {
  const base = `/accounts/${config.accountId}`;
  if (resource.kind === 'r2') return { path: `${base}/r2/buckets`, body: { name: resource.name } };
  if (resource.kind === 'queue') return { path: `${base}/queues`, body: { queue_name: resource.name } };
  if (resource.kind === 'd1') return { path: `${base}/d1/database`, body: { name: resource.name } };
  return { path: `${base}/artifacts/namespaces`, body: { namespace: resource.name } };
}
async function provision(config: Config, reportPath: string, options: Options): Promise<Report> {
  const planned = intendedResources(config, options.artifactsOnly), scopeDigest = hash(JSON.stringify({ accountId: config.accountId, resources: planned.map(({ key, kind, name }) => ({ key, kind, name })) }));
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await open(reportPath + '.lock', 'wx', 0o600); } catch { throw new SafeError('REPORT_LOCK_HELD'); }
  try {
    await lock.writeFile(JSON.stringify({ processId: process.pid, createdAt: new Date().toISOString() })); await lock.sync();
    const report = await readReport(reportPath, config, planned, scopeDigest) ?? { schemaVersion: 1 as const, scopeDigest, accountId: config.accountId, mode: 'PLAN' as const, accountVerified: false, status: 'BLOCKED' as const, updatedAt: new Date().toISOString(), resources: planned, blockers: [], limitations: [], sources };
    report.mode = options.run ? 'RUN' : 'PLAN'; report.status = 'BLOCKED'; report.blockers = [];
    const priorDatabase = report.resources.find(resource => resource.kind === 'd1');
    if (priorDatabase?.id && uuidPattern.test(priorDatabase.id)) report.operatorConfig = { projectionDatabase: { name: priorDatabase.name, id: priorDatabase.id } };
    report.limitations = [
      'Only empty resources are provisioned; no Worker deployment, repository creation, Git push, object upload, secret installation, or data export occurs.',
      'A create with no usable acknowledgement remains unresolved. Later runs reconcile by intended name and never automatically repeat that create.',
      'The resource report is an operator-owned local journal, not a provider conditional-publication or runtime-isolation conformance result.',
      'An Artifacts namespace created without a jurisdiction is unrestricted. Existing namespaces are not reconfigured.',
    ];
    const save = async () => { report.updatedAt = new Date().toISOString(); await persist(reportPath, report); };
    let token = options.token, expectedAccount = options.expectedAccount;
    if (options.run && options.useWrangler) {
      const { selectWranglerCredential } = await import(new URL('../scripts/provider-preflight.ts', import.meta.url).href) as { selectWranglerCredential: (account: string) => CredentialSelection };
      const selected = (options.credentialSelector ?? selectWranglerCredential)(config.accountId);
      token = selected.credential; expectedAccount = selected.account; report.authenticationChecks = selected.checks; report.credentialSource = 'existing-wrangler-oauth';
      if (selected.checks.some(check => check.status !== 'PASS')) report.blockers.push('WRANGLER_ACCOUNT_AND_ARTIFACTS_SCOPE_REQUIRED');
    } else if (options.run) report.credentialSource = 'explicit-api-token';
    if (!options.run) report.blockers.push('EXPLICIT_RUN_REQUIRED');
    if (!token) report.blockers.push('CLOUDFLARE_API_TOKEN_REQUIRED');
    if (!accountPattern.test(config.accountId)) report.blockers.push('CONFIG_ACCOUNT_REQUIRED');
    if (expectedAccount !== config.accountId || !accountPattern.test(expectedAccount ?? '')) report.blockers.push('MATCHING_CLOUDFLARE_ACCOUNT_ID_REQUIRED');
    if (report.blockers.length) { await save(); return report; }
    const api = new CloudflareApi(config.accountId, token!, options.fetcher ?? fetch, options.timeoutMs ?? 15_000);
    await save();
    try {
      const account = await api.request('GET', `/accounts/${config.accountId}`); ensure(account && dictionary(account.result).id === config.accountId, 'API_ACCOUNT_MISMATCH'); report.accountVerified = true; await save();
      for (const resource of report.resources) {
        let identity: string | null;
        try { identity = await lookup(api, config, resource); } catch (error) {
          const issue = error instanceof SafeError ? error : new SafeError('RESOURCE_LOOKUP_FAILED');
          resource.reason = issue.code; resource.httpStatus = issue.httpStatus; resource.apiCodes = issue.apiCodes;
          if (!resource.createMayHaveOccurred) resource.state = 'BLOCKED'; report.blockers.push(issue.code); await save(); return report;
        }
        if (identity) {
          ensure(!resource.id || resource.id === identity, 'PREVIOUS_RESOURCE_ID_MISMATCH');
          resource.id = identity; resource.state = 'OBSERVED'; resource.observedAt = new Date().toISOString(); delete resource.reason; delete resource.httpStatus; delete resource.apiCodes;
          if (resource.kind === 'd1') report.operatorConfig = { projectionDatabase: { name: resource.name, id: identity } };
          await save(); options.progress?.(resource); continue;
        }
        if (resource.createMayHaveOccurred || resource.state === 'UNKNOWN' || resource.state === 'MAY_HAVE_DISPATCHED') {
          resource.state = 'UNKNOWN'; resource.reason = 'CREATE_UNRESOLVED_NAME_NOT_OBSERVED'; report.blockers.push(resource.reason); await save(); return report;
        }
        if (resource.id) { resource.state = 'BLOCKED'; resource.reason = 'PREVIOUS_RESOURCE_NO_LONGER_OBSERVED'; report.blockers.push(resource.reason); await save(); return report; }
        resource.state = 'MAY_HAVE_DISPATCHED'; resource.createMayHaveOccurred = true; resource.attemptId = randomUUID(); delete resource.reason;
        // Retain the intent before the API boundary. A crash here is deliberately
        // treated as an uncertain effect, rather than repeating a create.
        await save(); const request = createRequest(config, resource);
        try {
          const created = await api.request('POST', request.path, request.body); ensure(created, 'CREATE_ACKNOWLEDGEMENT_MISSING');
          identity = observedIdentity(resource, created!.result, config); resource.id = identity; resource.state = 'ACKNOWLEDGED'; resource.observedAt = new Date().toISOString();
          if (resource.kind === 'd1') report.operatorConfig = { projectionDatabase: { name: resource.name, id: identity } };
          await save(); options.progress?.(resource);
        } catch (error) {
          const issue = error instanceof SafeError ? error : new SafeError('CREATE_UNCERTAIN'); resource.state = 'UNKNOWN'; resource.reason = issue.code; resource.httpStatus = issue.httpStatus; resource.apiCodes = issue.apiCodes;
          report.blockers.push(issue.code); await save(); return report;
        }
      }
      report.status = 'PASS'; await save(); return report;
    } catch (error) {
      const issue = error instanceof SafeError ? error : new SafeError('PROVISIONING_FAILED'); report.blockers.push(issue.code); await save(); return report;
    }
  } finally { await lock.close(); await rm(reportPath + '.lock', { force: true }); }
}

async function selfTest(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'confidence-provision-test-'));
  const accountId = '1'.repeat(32), d1Id = '12345678-1234-1234-1234-123456789abc', dummyToken = 'owned-test-token-do-not-retain';
  const config: Config = { accountId, objectBucket: 'owned-bucket', deadLetterQueue: 'owned-dead', eventQueue: 'owned-events', artifactsNamespace: 'owned-artifacts', projectionDatabase: { name: 'owned-database', id: 'REPLACE_WITH_D1_UUID' } };
  const resources = new Map<string, Dictionary>(); const requests: { path: string; method: string }[] = [];
  let loseFirstCreate = true, pendingBucket: Dictionary | null = null, wrongAccount = false, oversize = false, denyResource = false;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer ' + dummyToken); const url = new URL(request.url!, 'http://owned.test'); const path = url.pathname.replace('/client/v4/accounts/' + accountId, ''); const method = request.method!; requests.push({ path, method });
      const send = (result: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ success: status < 400, result, errors: status < 400 ? [] : [{ code: 1001, message: dummyToken }] })); };
      if (path === '') { send({ id: wrongAccount ? '2'.repeat(32) : accountId }); return; }
      if (oversize) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(' '.repeat(MAX_JSON_BYTES + 1)); return; }
      if (denyResource) { send(null, 403); return; }
      if (method === 'GET') {
        if (path === '/queues' || path === '/d1/database') { const name = url.searchParams.get('name'); send([...resources.values()].filter(item => item.queue_name === name || item.name === name && item.uuid)); return; }
        send(resources.get(path) ?? null, resources.has(path) ? 200 : 404); return;
      }
      assert.equal(method, 'POST'); let body = ''; for await (const chunk of request) body += chunk.toString(); const value = JSON.parse(body);
      let result: Dictionary, key: string;
      if (path === '/r2/buckets') { result = { name: value.name }; key = path + '/' + value.name; }
      else if (path === '/queues') { result = { queue_name: value.queue_name, queue_id: (value.queue_name === config.eventQueue ? '3' : '4').repeat(32) }; key = path + '/' + result.queue_id; }
      else if (path === '/d1/database') { result = { name: value.name, uuid: d1Id }; key = path + '/' + d1Id; }
      else { assert.equal(path, '/artifacts/namespaces'); result = { namespace: value.namespace }; key = path + '/' + value.namespace; }
      if (loseFirstCreate) { loseFirstCreate = false; pendingBucket = result; response.destroy(); return; }
      resources.set(key, result); send(result);
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address === 'object');
  const ownedFetch: typeof fetch = (url, init) => { const target = new URL(String(url)); assert.equal(target.origin, 'https://api.cloudflare.com'); return fetch(`http://127.0.0.1:${address.port}${target.pathname}${target.search}`, init); };
  const options: Options = { run: true, token: dummyToken, expectedAccount: accountId, fetcher: ownedFetch, timeoutMs: 1000 };
  const reportPath = join(directory, 'report.json');
  try {
    const planned = await provision(config, reportPath, { ...options, run: false }); assert.equal(planned.status, 'BLOCKED'); assert.equal(requests.length, 0);
    const missingToken = await provision(config, reportPath, { ...options, token: undefined }); assert.equal(missingToken.status, 'BLOCKED'); assert.equal(requests.length, 0);
    const mismatchedAccount = await provision(config, reportPath, { ...options, expectedAccount: '2'.repeat(32) }); assert.equal(mismatchedAccount.status, 'BLOCKED'); assert.equal(requests.length, 0);
    wrongAccount = true; const deniedAccount = await provision(config, reportPath, options); assert.ok(deniedAccount.blockers.includes('API_ACCOUNT_MISMATCH')); assert.equal(requests.filter(request => request.method === 'POST').length, 0); wrongAccount = false;
    const lost = await provision(config, reportPath, options); assert.equal(lost.resources[0].state, 'UNKNOWN'); assert.equal(requests.filter(request => request.method === 'POST').length, 1);
    const stillOld = await provision(config, reportPath, options); assert.equal(stillOld.resources[0].state, 'UNKNOWN'); assert.equal(requests.filter(request => request.method === 'POST').length, 1);
    resources.set('/r2/buckets/' + config.objectBucket, pendingBucket!); const reconciled = await provision(config, reportPath, options); assert.equal(reconciled.status, 'PASS'); assert.equal(reconciled.operatorConfig!.projectionDatabase.id, d1Id); assert.equal(requests.filter(request => request.method === 'POST').length, 5);
    const repeated = await provision({ ...config, projectionDatabase: { ...config.projectionDatabase!, id: d1Id } }, reportPath, options); assert.equal(repeated.status, 'PASS'); assert.equal(requests.filter(request => request.method === 'POST').length, 5);
    const wrongD1 = await provision({ ...config, projectionDatabase: { ...config.projectionDatabase!, id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' } }, reportPath, options); assert.ok(wrongD1.blockers.includes('D1_CONFIGURED_ID_NOT_FOUND')); assert.equal(requests.filter(request => request.method === 'POST').length, 5);
    oversize = true; const oversized = await provision(config, join(directory, 'oversized.json'), options); assert.ok(oversized.blockers.includes('API_RESPONSE_SIZE_LIMIT')); assert.equal(requests.filter(request => request.method === 'POST').length, 5); oversize = false;
    denyResource = true; const denied = await provision(config, join(directory, 'denied.json'), options); assert.equal(denied.resources[0].httpStatus, 403); assert.deepEqual(denied.resources[0].apiCodes, [1001]); assert.equal(requests.filter(request => request.method === 'POST').length, 5);
    for (const path of ['report.json', 'oversized.json', 'denied.json']) assert.equal((await readFile(join(directory, path), 'utf8')).includes(dummyToken), false);
    denyResource = false; requests.length = 0;
    const namespaceOnly = parseConfig({ schemaVersion: 1, accountId, artifactsNamespace: 'owned.namespace-only' }, true), namespaceReport = join(directory, 'namespace-only.json');
    const oauth: Options = { run: true, artifactsOnly: true, useWrangler: true, fetcher: ownedFetch, timeoutMs: 1000, credentialSelector: () => ({ account: accountId, credential: dummyToken, checks: [{ name: 'owned-oauth-scope', status: 'PASS', detail: { scope: 'artifacts:write' } }] }) };
    const namespacePlan = await provision(namespaceOnly, namespaceReport, { ...oauth, run: false, credentialSelector: () => { throw new Error('Plan must not inspect credentials'); } });
    assert.equal(namespacePlan.status, 'BLOCKED'); assert.equal(requests.length, 0); assert.deepEqual(namespacePlan.resources.map(resource => resource.key), ['artifactsNamespace']);
    const insufficientScope = await provision(namespaceOnly, namespaceReport, { ...oauth, credentialSelector: () => ({ account: accountId, checks: [{ name: 'owned-oauth-scope', status: 'BLOCKED', detail: {} }] }) });
    assert.ok(insufficientScope.blockers.includes('WRANGLER_ACCOUNT_AND_ARTIFACTS_SCOPE_REQUIRED')); assert.equal(requests.length, 0);
    loseFirstCreate = true;
    const namespaceLost = await provision(namespaceOnly, namespaceReport, oauth); assert.equal(namespaceLost.resources[0].state, 'UNKNOWN');
    const namespacePending = await provision(namespaceOnly, namespaceReport, oauth); assert.equal(namespacePending.resources[0].state, 'UNKNOWN'); assert.equal(requests.filter(request => request.method === 'POST').length, 1);
    resources.set('/artifacts/namespaces/' + namespaceOnly.artifactsNamespace, pendingBucket!);
    const namespaceObserved = await provision(namespaceOnly, namespaceReport, oauth); assert.equal(namespaceObserved.status, 'PASS'); assert.equal(namespaceObserved.credentialSource, 'existing-wrangler-oauth');
    assert.equal(namespaceObserved.operatorConfig, undefined); assert.equal(requests.filter(request => request.method === 'POST').length, 1);
    assert.equal((await provision(namespaceOnly, namespaceReport, oauth)).status, 'PASS'); assert.equal(requests.filter(request => request.method === 'POST').length, 1);
    assert.ok(requests.every(request => request.path === '' || request.path === '/artifacts/namespaces' || request.path === '/artifacts/namespaces/' + namespaceOnly.artifactsNamespace));
    const beforeScopeChange = requests.length;
    await assert.rejects(provision(config, namespaceReport, options), /REPORT_SCOPE_MISMATCH/); assert.equal(requests.length, beforeScopeChange);
    assert.equal((await readFile(namespaceReport, 'utf8')).includes(dummyToken), false);
    process.stdout.write(JSON.stringify({ result: 'PASS', checks: ['Default plan and missing credentials make no network calls', 'Expected and returned account mismatch deny mutation', 'Owned HTTP lost-create response retained UNKNOWN across fresh invocation', 'Absent intended name never repeats uncertain POST', 'Observed delayed effect reconciles and remaining empty resources provision once', 'D1 UUID exported then verified on repeat; wrong configured UUID denies creation', 'Actual streamed response limit bounds API reads', 'Provider error text and bearer credential absent from retained reports', 'Artifacts-only mode reads no credentials during planning and mutates no unrelated resources', 'Existing OAuth scope and account gate Artifacts-only creation without retaining credentials', 'Artifacts-only lost create reconciles without repeat and journal scope cannot widen'], remoteMutations: 0 }) + '\n');
  } finally { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--self-test') await selfTest();
    else {
      const allowed = ['--run', '--artifacts-only', '--use-wrangler'];
      const run = args.includes('--run'), artifactsOnly = args.includes('--artifacts-only'), useWrangler = args.includes('--use-wrangler'); const positional = args.filter(arg => !allowed.includes(arg));
      ensure(positional.length === 2 && allowed.every(flag => args.filter(arg => arg === flag).length <= 1) && positional.every(arg => !arg.startsWith('--')), 'USAGE_PROVISION_PILOT_INPUT_JSON_REPORT_JSON_OPTIONAL_RUN_ARTIFACTS_ONLY_USE_WRANGLER');
      const config = parseConfig(JSON.parse(await boundedFile(resolve(positional[0]))), artifactsOnly);
      const reportPath = resolve(positional[1]);
      const report = await provision(config, reportPath, { run, artifactsOnly, useWrangler, token: process.env.CLOUDFLARE_API_TOKEN, expectedAccount: process.env.CLOUDFLARE_ACCOUNT_ID, progress: resource => process.stdout.write(JSON.stringify({ resource: resource.key, intendedName: resource.name, state: resource.state }) + '\n') });
      process.stdout.write(JSON.stringify({ status: report.status, mode: report.mode, accountVerified: report.accountVerified, report: reportPath, blockers: report.blockers, resources: report.resources.map(({ key, kind, name, state, id }) => ({ key, kind, intendedName: name, state, id })), operatorConfig: report.operatorConfig }) + '\n');
      if (run && report.status !== 'PASS') process.exitCode = 2;
    }
  } catch (error) { process.stderr.write((error instanceof SafeError ? error.code : 'PILOT_PROVISION_FAILED') + '\n'); process.exitCode = 1; }
}
