// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, open, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Check, Journal, Probe, Report, Snapshot } from './live-container/types';
import { continuationEligible, deployedWorkerMatches, deployedVariablesMatch } from './live-container/continuation';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = resolve(root, 'infra/live-container');
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const digest = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const sources = ['worker.ts', 'types.ts', 'child-observation.ts', 'continuation.ts', 'test.ts', 'child-timing.test.mjs', 'README.md', 'Dockerfile', 'inert.mjs', 'network.mjs', 'child.mjs', 'heartbeat-observation.mjs', 'wrangler.jsonc'];

export function privateEnvironment(account?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: 'true', WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_SANITIZE: 'true' };
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_KEY', 'CLOUDFLARE_EMAIL', 'CF_EMAIL', 'CLOUDFLARE_API_BASE_URL', 'CF_API_BASE_URL', 'LIVE_CONTAINER_ADMIN_TOKEN']) delete env[key];
  if (account) env.CLOUDFLARE_ACCOUNT_ID = account; else delete env.CLOUDFLARE_ACCOUNT_ID;
  return env;
}
export function accountGate(raw: string, account: string): Check {
  const value = JSON.parse(raw) as { loggedIn?: unknown; authType?: unknown; accounts?: { id?: unknown }[]; tokenPermissions?: unknown };
  const matches = /^[a-f0-9]{32}$/.test(account) && Array.isArray(value.accounts) && value.accounts.some(entry => entry.id === account);
  const permissions = Array.isArray(value.tokenPermissions) ? value.tokenPermissions : [];
  const workers = permissions.includes('workers:write') || permissions.includes('workers_scripts:write');
  const containers = permissions.includes('containers:write');
  const oauth = value.loggedIn === true && value.authType === 'OAuth Token';
  return { name: 'selected-existing-wrangler-account', status: oauth && matches && workers && containers ? 'PASS' : 'BLOCKED', observationClass: 'configuration',
    detail: { authenticatedOAuth: oauth, selectedAccountMatches: matches, workersPermission: workers, containersPermission: containers,
      observedScopes: permissions.filter((scope): scope is string => typeof scope === 'string' && /^[a-z0-9_.-]+(?::[a-z0-9_.-]+)?$/.test(scope)),
      missingScopes: [...(!workers ? ['workers:write or workers_scripts:write'] : []), ...(!containers ? ['containers:write'] : [])], mutationPerformed: false } };
}
export function ownedJournal(journal: Journal): boolean {
  return journal.schemaVersion === 1 && /^[a-f0-9-]{36}$/.test(journal.runId) &&
    journal.workerName === `confidence-live-${journal.runId.replaceAll('-', '').slice(0, 20)}` && journal.containerName === `${journal.workerName}-inert`;
}
export function classifyFailure(journal?: Journal): Report['status'] {
  return journal && [journal.deploy, journal.start, journal.stop, journal.workerDelete].some(phase => phase === 'MAY_HAVE_DISPATCHED' || phase === 'UNKNOWN') ? 'RECONCILIATION_REQUIRED' : 'FAIL';
}
export function validEndpoint(endpoint: string, workerName: string): boolean {
  try { const url = new URL(endpoint); return url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && url.hostname.startsWith(`${workerName}.`) && /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname); } catch { return false; }
}
export class CaptureFailure extends Error {
  constructor(readonly reason: 'TIMEOUT' | 'OUTPUT_LIMIT' | 'EXIT_FAILURE' | 'SPAWN_FAILURE', readonly exitCode: number | null = null) { super('PRIVATE_SUBPROCESS_FAILED'); }
}
/** The event loop stays available during build/deploy. Raw output is never attached to errors. */
export async function boundedCapture(command: string, argv: string[], options: { cwd?: string; account?: string; timeout?: number; maximum?: number } = {}): Promise<string> {
  const maximum = options.maximum ?? 1024 * 1024;
  return new Promise((resolveCapture, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(command, argv, { cwd: options.cwd ?? directory, env: privateEnvironment(options.account), stdio: ['ignore', 'pipe', 'pipe'], detached });
    const stdout: Buffer[] = []; let size = 0, failure: CaptureFailure | undefined, settled = false;
    const kill = (signal: NodeJS.Signals) => { try { if (detached && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* group already exited */ } };
    let escalation: NodeJS.Timeout | undefined;
    const fail = (reason: CaptureFailure['reason']) => { if (failure) return; failure = new CaptureFailure(reason); kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), 1000); };
    const timer = setTimeout(() => fail('TIMEOUT'), options.timeout ?? 30_000);
    const collect = (chunk: Buffer, retain: boolean) => { size += chunk.byteLength; if (size > maximum) { fail('OUTPUT_LIMIT'); return; } if (retain) stdout.push(chunk); };
    child.stdout.on('data', chunk => collect(Buffer.from(chunk), true));
    child.stderr.on('data', chunk => collect(Buffer.from(chunk), false));
    const complete = (exitCode: number | null, spawnFailed = false) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (escalation) { clearTimeout(escalation); kill('SIGKILL'); }
      if (failure || spawnFailed || exitCode !== 0) reject(failure || new CaptureFailure(spawnFailed ? 'SPAWN_FAILURE' : 'EXIT_FAILURE', exitCode));
      else resolveCapture(Buffer.concat(stdout).toString('utf8'));
    };
    child.once('error', () => complete(null, true)); child.once('close', code => complete(code));
  });
}
function capture(argv: string[], account?: string, timeout = 30_000): Promise<string> {
  return boundedCapture(process.execPath, [wrangler, ...argv], { account, timeout });
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
export async function atomic(path: string, value: unknown): Promise<void> {
  const parent = dirname(path), firstCreated = await mkdir(parent, { recursive: true });
  if (firstCreated) {
    // Persist newly created directory links as well as the final file entry.
    let ancestor = parent;
    for (;;) { await syncDirectory(ancestor); if (ancestor === dirname(firstCreated)) break; ancestor = dirname(ancestor); }
  }
  const pending = `${path}.pending-${randomUUID()}`; const handle = await open(pending, 'wx', 0o600);
  let renamed = false;
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); await handle.close();
    await rename(pending, path); renamed = true; await syncDirectory(parent);
  } finally { await handle.close().catch(() => {}); if (!renamed) await rm(pending, { force: true }); }
}
export function applicationList(body: unknown): { count: number; complete: boolean } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const envelope = body as { success?: unknown; result?: unknown; errors?: unknown; result_info?: unknown };
  if (envelope.success !== true || !Array.isArray(envelope.result) || !Array.isArray(envelope.errors) || envelope.errors.length) return null;
  const info = envelope.result_info;
  if (info !== undefined && (!info || typeof info !== 'object' || Array.isArray(info))) return null;
  const next = info ? (info as { next_page_token?: unknown }).next_page_token : undefined;
  if (next !== undefined && next !== null && typeof next !== 'string') return null;
  return { count: envelope.result.length, complete: next === undefined || next === null || next === '' };
}
async function boundedJSON(response: Response, maximum = 128 * 1024): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw new Error('RESPONSE_BODY_REQUIRED');
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maximum) { await reader.cancel(); throw new Error('RESPONSE_LIMIT'); } chunks.push(value); } } finally { reader.releaseLock(); }
  const output = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(output));
}
export async function deploymentAvailable(options: {
  runId: string; inspect: () => Promise<{ status: number; body: unknown }>;
  associated: () => Promise<boolean>; attempts?: number; pause?: () => Promise<void>;
}): Promise<{ ready: boolean; attempts: number; lastHTTPStatus: number | null; associationVerified: boolean }> {
  let lastHTTPStatus: number | null = null, associationVerified = false;
  const maximum = Math.min(20, Math.max(1, options.attempts ?? 20));
  for (let attempt = 1; attempt <= maximum; attempt++) {
    try {
      const response = await options.inspect(); lastHTTPStatus = response.status;
      const snapshot = response.body as Partial<Snapshot> | null;
      if (response.status === 200 && snapshot?.runId === options.runId && snapshot.observationClass === 'deployed-native-container') {
        // A preexisting generation is an uncertainty fence, never a ready target.
        if (snapshot.generation !== null || snapshot.container !== null) return { ready: false, attempts: attempt, lastHTTPStatus, associationVerified: false };
        associationVerified = await options.associated();
        if (associationVerified) return { ready: true, attempts: attempt, lastHTTPStatus, associationVerified };
      }
    } catch { /* bounded read-only observation remains unavailable */ }
    if (attempt < maximum) await (options.pause?.() ?? new Promise(resolve => setTimeout(resolve, 500)));
  }
  return { ready: false, attempts: maximum, lastHTTPStatus, associationVerified };
}

export async function main(argv = process.argv.slice(2)) {
  const value = (flag: string) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
  const out = resolve(value('--out') || resolve(directory, '.runs/report.json'));
  const continuing = argv.includes('--continue-before-start'); const originalPath = value('--deployment-report') ? resolve(value('--deployment-report')!) : '';
  if (continuing && (!originalPath || !value('--out') || out === originalPath || out === resolve(value('--journal') || '.') || ['--run', '--reconcile', '--stop', '--prepare', '--package', '--self-test', '--check-account'].some(flag => argv.includes(flag)))) throw new Error('DISTINCT_CONTINUATION_PROOF_AND_REPORT_REQUIRED');
  const templateConfig = JSON.parse(await readFile(resolve(directory, 'wrangler.jsonc'), 'utf8')) as { compatibility_date: string };
  const report: Report = { schemaVersion: 1, status: 'BLOCKED', providerGatePassed: false, checks: [], sourceDigests: {},
    generatedAt: new Date().toISOString(), sourceRevision: null, sourceDirty: null, versions: { node: process.version }, compatibilityDate: templateConfig.compatibility_date, limitations: [
    'Local tests and Wrangler dry-run are not deployed provider evidence. PROVIDER_PASS requires the actual authenticated newly deployed Worker and native Container observations.',
    'Response loss is explicitly injected with ctx.abort after start dispatch; it is not an observed spontaneous provider outage.',
    'The gate observes a changing detached-child heartbeat after its parent exits and inspect:null after destroying the whole generation; it does not enumerate each dead process afterward.',
    'This tests one inert generation, bounded fixed commands, fixture egress and binary/mode hydration. It does not establish production runner/evaluator isolation, Artifacts publication, model execution or all concurrency histories.',
    'Stopping a generation is separate from deleting the Worker, Durable Object namespace, Container application and uploaded image. Unresolved resource names remain in the journal until independently reconciled.',
  ] };
  for (const file of sources) report.sourceDigests[file] = digest(await readFile(resolve(directory, file)));
  report.sourceDigests['package-lock.json'] = digest(await readFile(resolve(root, 'package-lock.json')));
  report.sourceDigests['package.json'] = digest(await readFile(resolve(root, 'package.json')));
  report.sourceDigests['live-container-check.ts'] = digest(await readFile(fileURLToPath(import.meta.url)));
  for (const name of ['wrangler', '@cloudflare/sandbox', '@cloudflare/workers-types', 'workerd', 'miniflare', 'tsx', 'typescript']) {
    try { const installed = JSON.parse(await readFile(resolve(root, 'node_modules', name, 'package.json'), 'utf8')) as { version?: unknown };
      if (typeof installed.version === 'string') report.versions[name] = installed.version;
    } catch { /* unavailable versions are omitted, never inferred from ranges */ }
  }
  try {
    const revision = (await boundedCapture('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 5000 })).trim();
    if (/^[a-f0-9]{40,64}$/.test(revision)) report.sourceRevision = revision;
    report.sourceDirty = Boolean((await boundedCapture('git', ['status', '--porcelain'], { cwd: root, timeout: 5000 })).trim());
  } catch { /* source digests still bind the actual working files */ }
  let journal: Journal | undefined, journalPath = value('--journal') ? resolve(value('--journal')!) : '';
  let lock: FileHandle | undefined;
  let mayWriteJournal = false;
  const save = async () => { report.journal = journal; if (journal && journalPath && mayWriteJournal) await atomic(journalPath, journal); await atomic(out, report); };
  const finish = async () => {
    try { await save(); }
    finally { if (lock) { await lock.close(); await rm(`${journalPath}.lock`, { force: true }); await syncDirectory(dirname(journalPath)); lock = undefined; } }
    console.log(JSON.stringify({ status: report.status, providerGatePassed: report.providerGatePassed, reportPath: out, ...(journalPath ? { journalPath } : {}) }));
    return report;
  };
  const check = (name: string, passed: boolean, observationClass: Check['observationClass'], detail: Record<string, unknown>) => {
    report.checks.push({ name, status: passed ? 'PASS' : 'FAIL', observationClass, detail }); if (!passed) throw new Error('CHECK_FAILED');
  };
  try {
    if (argv.includes('--self-test')) {
      await capture(['--version']);
      await boundedCapture(process.execPath, ['--import', 'tsx', '--test', resolve(directory, 'test.ts'), resolve(directory, 'child-timing.test.mjs')], { cwd: root, timeout: 30_000 });
      report.checks.push({ name: 'owned-local-tests', status: 'PASS', observationClass: 'owned-local-test', detail: { providerMutations: 0 } }); report.status = 'SELF_TEST_PASS';
    } else if (argv.includes('--package')) {
      await capture(['deploy', '--dry-run', '--config', resolve(directory, 'wrangler.jsonc'), '--outdir', resolve(directory, 'dist')]);
      report.checks.push({ name: 'wrangler-dry-run', status: 'PASS', observationClass: 'local-package', detail: { uploaded: false, actualContainerStarted: false, imageBuildNotEstablished: true } }); report.status = 'PACKAGE_PASS';
    } else if (argv.includes('--prepare')) {
      const runId = randomUUID(), workerName = `confidence-live-${runId.replaceAll('-', '').slice(0, 20)}`;
      const runDirectory = resolve(directory, '.runs', runId); journalPath = resolve(runDirectory, 'journal.json');
      journal = { schemaVersion: 1, runId, workerName, containerName: `${workerName}-inert`, createdAt: new Date().toISOString(), deploy: 'NOT_DISPATCHED', start: 'NOT_DISPATCHED', stop: 'NOT_DISPATCHED', workerDelete: 'NOT_DISPATCHED', unresolvedResources: [], observations: [], checks: [] };
      mayWriteJournal = true;
      report.checks.push({ name: 'owned-resource-plan', status: 'PASS', observationClass: 'configuration', detail: { journalPath, remoteMutations: 0 } });
    } else if (argv.includes('--check-account')) {
      // Explicit read-only inspection. Default/package/self-test never touch auth.
      const account = value('--account') || process.env.CLOUDFLARE_ACCOUNT_ID || '';
      if (!/^[a-f0-9]{32}$/.test(account)) throw new Error('SELECTED_ACCOUNT_REQUIRED');
      const gate = accountGate(await capture(['whoami', '--json'], account), account); report.checks.push(gate);
      if (gate.status !== 'PASS') return finish();
      const credential = JSON.parse(await capture(['auth', 'token', '--json'], account)) as { type?: unknown; token?: unknown };
      if (credential.type !== 'oauth' || typeof credential.token !== 'string' || credential.token.length < 20) throw new Error('EXISTING_OAUTH_REQUIRED');
      const probeName = `confidence-live-readonly-${randomUUID().replaceAll('-', '')}`;
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/containers/applications?name=${probeName}`, {
        headers: { authorization: `Bearer ${credential.token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      const list = applicationList(await boundedJSON(response));
      report.checks.push({ name: 'read-only-container-api-envelope', status: response.ok && list?.complete ? 'PASS' : 'BLOCKED', observationClass: 'configuration',
        detail: { httpStatus: response.status, responseEnvelopeVerified: list !== null, paginationComplete: list?.complete ?? false, ...(list ? { matchingApplicationCount: list.count } : {}), remoteMutations: 0 } });
    } else if (argv.includes('--run') || continuing || argv.includes('--reconcile') || argv.includes('--stop')) {
      // No auth or provider call occurs unless an explicit live mode and a prepared owned journal are selected.
      if (!journalPath) throw new Error('OWNED_JOURNAL_REQUIRED');
      journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal;
      if (!ownedJournal(journal)) throw new Error('OWNED_JOURNAL_REQUIRED');
      // One process owns dispatch/reconciliation for this journal. A crash leaves the lock
      // for reviewed recovery; no timeout guesses whether an earlier mutation occurred.
      lock = await open(`${journalPath}.lock`, 'wx', 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      await lock.sync(); await syncDirectory(dirname(journalPath));
      journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal;
      if (!ownedJournal(journal)) throw new Error('OWNED_JOURNAL_REQUIRED');
      mayWriteJournal = true;
      const account = value('--account') || process.env.CLOUDFLARE_ACCOUNT_ID || '';
      let originalConfig: any;
      if (continuing) {
        const original = JSON.parse(await readFile(originalPath, 'utf8')) as Report;
        originalConfig = JSON.parse(await readFile(resolve(dirname(journalPath), 'wrangler.json'), 'utf8'));
        const template = JSON.parse(await readFile(resolve(directory, 'wrangler.jsonc'), 'utf8'));
        const eligible = continuationEligible(journal, original, originalConfig, template, report.sourceDigests, account, Date.now(), { worker: resolve(directory, 'worker.ts'), dockerfile: resolve(directory, 'Dockerfile'), directory });
        report.checks.push({ name: 'untouched-deployment-before-start', status: eligible ? 'PASS' : 'BLOCKED', observationClass: 'configuration', detail: { deploymentReportDigest: digest(await readFile(originalPath)), concreteConfigDigest: digest(await readFile(resolve(dirname(journalPath), 'wrangler.json'))), originalExpiryPreserved: eligible, startDispatched: false } });
        if (!eligible || !journal.endpoint || !validEndpoint(journal.endpoint, journal.workerName)) { report.status = 'RECONCILIATION_REQUIRED'; return finish(); }
      }
      const gate = accountGate(await capture(['whoami', '--json'], account), account); report.checks.push(gate);
      if (gate.status !== 'PASS') return finish();
      if (journal.accountId && journal.accountId !== account) throw new Error('JOURNAL_ACCOUNT_MISMATCH');
      journal.accountId = account;
      const admin = process.env.LIVE_CONTAINER_ADMIN_TOKEN || ''; if (!/^[a-f0-9]{64}$/.test(admin)) throw new Error('DEDICATED_ADMIN_TOKEN_REQUIRED');
      if (argv.includes('--run')) {
        if (journal.deploy !== 'NOT_DISPATCHED' || journal.start !== 'NOT_DISPATCHED') { report.status = 'RECONCILIATION_REQUIRED'; return finish(); }
        const credential = JSON.parse(await capture(['auth', 'token', '--json'], account)) as { type?: unknown; token?: unknown };
        if (credential.type !== 'oauth' || typeof credential.token !== 'string' || credential.token.length < 20) throw new Error('EXISTING_OAUTH_REQUIRED');
        const headers = { authorization: `Bearer ${credential.token}` };
        const api = `https://api.cloudflare.com/client/v4/accounts/${account}`;
        const worker = await fetch(`${api}/workers/scripts/${journal.workerName}`, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
        const workerBody = worker.status === 404 ? await boundedJSON(worker) as { errors?: { code?: number }[] } : null;
        check('fresh-worker-name-absence', worker.status === 404 && Boolean(workerBody?.errors?.some(item => item.code === 10007)), 'configuration', { httpStatus: worker.status, workerName: journal.workerName });
        const applications = await fetch(`${api}/containers/applications?name=${encodeURIComponent(journal.containerName)}`, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
        const apps = applicationList(await boundedJSON(applications));
        check('fresh-container-name-absence', applications.ok && apps?.complete === true && apps.count === 0, 'configuration', { httpStatus: applications.status, containerName: journal.containerName, responseEnvelopeVerified: apps !== null, paginationComplete: apps?.complete });
        const template = JSON.parse(await readFile(resolve(directory, 'wrangler.jsonc'), 'utf8'));
        template.name = journal.workerName; template.account_id = account; template.main = resolve(directory, 'worker.ts');
        template.containers[0].name = journal.containerName;
        template.containers[0].images.inert = { dockerfile: resolve(directory, 'Dockerfile'), build_context: directory };
        template.vars = { RUN_ID: journal.runId, RUN_EXPIRES_AT: String(Date.now() + 600_000) };
        const config = resolve(dirname(journalPath), 'wrangler.json'); await atomic(config, template);
        // Package the concrete prepared target before any mutation.
        await capture(['deploy', '--dry-run', '--config', config, '--outdir', resolve(dirname(journalPath), 'dist')], account);
        const secrets = resolve(dirname(journalPath), '.ephemeral-secrets.json');
        await atomic(secrets, { ADMIN_TOKEN: admin });
        journal.deploy = 'MAY_HAVE_DISPATCHED'; journal.unresolvedResources = [journal.workerName, journal.containerName, `${journal.workerName}:LiveContainerHarness namespace`, `${journal.containerName}:inert registry image`];
        await save();
        let deployed = '';
        try { deployed = await capture(['deploy', '--config', config, '--secrets-file', secrets], account, 300_000); }
        finally { await rm(secrets, { force: true }); }
        const endpoint = [...deployed.matchAll(/https:\/\/[a-z0-9.-]+\.workers\.dev\/?/g)].map(match => match[0]).find(url => validEndpoint(url, journal!.workerName));
        if (!endpoint) { journal.deploy = 'UNKNOWN'; report.status = 'RECONCILIATION_REQUIRED'; return finish(); }
        journal.endpoint = endpoint.endsWith('/') ? endpoint : `${endpoint}/`; journal.deploy = 'ACKNOWLEDGED'; await save();
      }
      if (!journal.endpoint || !validEndpoint(journal.endpoint, journal.workerName)) { report.status = 'RECONCILIATION_REQUIRED'; return finish(); }
      let requestCount = 0;
      const request = async (route: string, mutate = false): Promise<{ status: number; body: unknown }> => {
        if (++requestCount > 40) throw new Error('CLIENT_REQUEST_BUDGET');
        const response = await fetch(new URL(route, journal!.endpoint!), { method: mutate ? 'POST' : 'GET', headers: { authorization: `Bearer ${admin}` }, redirect: 'error', signal: AbortSignal.timeout(route === 'ready' ? 55_000 : route === 'child' ? 25_000 : 20_000) });
        return { status: response.status, body: await boundedJSON(response) };
      };
      const inspect = async () => {
        const result = await request('inspect'); const snapshot = result.body as Snapshot;
        if (result.status !== 200 || snapshot.runId !== journal!.runId || snapshot.observationClass !== 'deployed-native-container') throw new Error('OWNED_DEPLOYMENT_NOT_OBSERVED');
        journal!.observations.push(snapshot); await save(); return snapshot;
      };
      if (argv.includes('--stop')) {
        journal.stop = 'MAY_HAVE_DISPATCHED'; await save(); await request('stop', true); const snapshot = await inspect();
        check('owned-generation-stop', snapshot.container === null && snapshot.generation?.phase === 'STOPPED' && !snapshot.generation.capacityHeld, 'deployed-native-container', { generation: journal.runId });
        journal.stop = 'ACKNOWLEDGED'; report.status = 'BLOCKED';
      } else if (argv.includes('--reconcile')) {
        await inspect(); report.status = 'RECONCILIATION_REQUIRED';
      } else {
        const credential = JSON.parse(await capture(['auth', 'token', '--json'], account)) as { type?: unknown; token?: unknown };
        if (credential.type !== 'oauth' || typeof credential.token !== 'string' || credential.token.length < 20) throw new Error('EXISTING_OAUTH_REQUIRED');
        const oauthToken = credential.token;
        const api = `https://api.cloudflare.com/client/v4/accounts/${account}`;
        if (continuing) {
          const content = await fetch(`${api}/workers/scripts/${journal.workerName}/content/v2`, { headers: { authorization: `Bearer ${oauthToken}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
          const sourceMatches = await deployedWorkerMatches(content, await readFile(resolve(dirname(journalPath), 'dist/worker.js')));
          check('unchanged-deployed-worker-bytes', sourceMatches, 'configuration', { matchedRetainedPackage: sourceMatches, sourceReturnedToOperator: false, startDispatched: false });
        }
        const readyDeadline = Date.now() + 60_000;
        const readinessRequest = async (url: URL | string, token: string) => {
          const remaining = readyDeadline - Date.now(); if (remaining <= 0) throw new Error('READINESS_UNOBSERVED');
          const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(Math.min(5000, remaining)) });
          return { status: response.status, body: await boundedJSON(response) };
        };
        const available = await deploymentAvailable({ runId: journal.runId,
          inspect: () => readinessRequest(new URL('inspect', journal!.endpoint!), admin),
          associated: async () => {
            const applications = await readinessRequest(`${api}/containers/applications?name=${encodeURIComponent(journal!.containerName)}`, oauthToken);
            const settings = await readinessRequest(`${api}/workers/scripts/${journal!.workerName}/settings`, oauthToken);
            const list = applicationList(applications.body);
            const app = (applications.body as { result?: { id?: string; name?: string; durable_objects?: { namespace_id?: string } }[] }).result?.[0];
            const bindings = (settings.body as { success?: boolean; result?: { bindings?: { type?: string; name?: string; class_name?: string; namespace_id?: string }[] } }).result?.bindings;
            return (!continuing || deployedVariablesMatch(settings.body, originalConfig) && Number(originalConfig.vars.RUN_EXPIRES_AT) > Date.now()) && applications.status === 200 && settings.status === 200 && (settings.body as { success?: boolean }).success === true && list?.complete === true && list.count === 1 && app?.name === journal!.containerName && typeof app.id === 'string' && typeof app.durable_objects?.namespace_id === 'string' && /^[a-f0-9]{32}$/.test(app.durable_objects.namespace_id) &&
              Array.isArray(bindings) && bindings.some(binding => binding.type === 'durable_object_namespace' && binding.name === 'HARNESS' && binding.class_name === 'LiveContainerHarness' && binding.namespace_id === app.durable_objects?.namespace_id);
          },
        });
        report.checks.push({ name: 'deployment-availability-before-start', status: available.ready ? 'PASS' : 'BLOCKED', observationClass: 'configuration', detail: { ...available, state: available.ready ? 'READY_OBSERVED' : 'READY_UNOBSERVED', startDispatched: false } });
        journal.checks = report.checks;
        if (!available.ready) { report.status = 'BLOCKED'; return finish(); }
        if (continuing && Number(originalConfig.vars.RUN_EXPIRES_AT) <= Date.now()) { report.status = 'BLOCKED'; return finish(); }
        journal.start = 'MAY_HAVE_DISPATCHED'; await save();
        // A missing response is deliberately not retried. Inspect and fixed readiness observation follow.
        try { await request('start', true); } catch { /* dispatch uncertainty retained in journal */ }
        const started = await inspect();
        check('single-start-dispatch-after-controller-abort', started.generation?.startDispatches === 1 && started.controllerBoots > started.generation.controllerBootsAtDispatch && started.generation.faultInjection === 'controller-abort-after-start', 'deployed-native-container', { faultInjected: true, startDispatchCount: started.generation?.startDispatches, controllerBoots: started.controllerBoots });
        journal.start = 'ACKNOWLEDGED'; await save();
        const readiness = await request('ready', true); check('native-readiness', readiness.status === 200 && (readiness.body as Snapshot).generation?.phase === 'READY', 'deployed-native-container', { fixedHTTPProbe: true });
        const probeResult = await request('probe', true); const probe = probeResult.body as Probe;
        check('binary-hydration-and-modes', probeResult.status === 200 && probe.hydration.expectedDigest === probe.hydration.observedDigest && probe.hydration.expectedDigest === probe.hydration.executableDigest && probe.hydration.binarySize === 4096 && probe.hydration.regularMode === '644' && probe.hydration.executableMode === '755', 'deployed-native-container', { ...probe.hydration });
        check('internet-disabled-inert-fixture-intercept', probe.network.allowed === 200 && probe.network.controllerGeneration === journal.runId && probe.network.forgedHeadersIgnored && probe.network.denied === 403 && probe.network.redirectDenied === 403 && probe.network.otherPortBlocked, 'deployed-native-container', { ...probe.network, publicNetworkRequestForwarded: false });
        let child: { status: number; body: unknown } | undefined;
        try { child = await request('child', true); } catch { /* uncertain child dispatch is never repeated */ }
        const childObserved = child?.status === 200 && (child.body as Snapshot).generation?.childSpawnPhase === 'ACKNOWLEDGED';
        let childSnapshot: Snapshot | undefined = childObserved ? child!.body as Snapshot : undefined;
        // Classify from retained progress only. This observation neither retries
        // the spawn nor treats a missing response as child termination.
        if (!childObserved) { try { childSnapshot = await inspect(); } catch { /* retained stage unavailable */ } }
        check('detached-child-after-parent-exit', childObserved, 'deployed-native-container', { httpStatus: child?.status ?? null, responseObserved: child !== undefined, childPid: childSnapshot?.generation?.childPid ?? null,
          childSpawnPhase: childSnapshot?.generation?.childSpawnPhase ?? null, childProgress: childSnapshot?.generation?.childProgress ?? null, heartbeatChangedAfterParentExit: childObserved ? true : null });
        await request('deadline', true);
        let stopped: Snapshot | undefined;
        for (let attempt = 0; attempt < 20; attempt++) { const snapshot = await inspect(); if (snapshot.generation?.phase === 'STOPPED') { stopped = snapshot; break; } await new Promise(resolve => setTimeout(resolve, 500)); }
        check('deadline-whole-generation-destruction', stopped?.container === null && stopped.generation?.stopReason === 'deadline' && stopped.generation.capacityHeld === false && Boolean(stopped.generation.stopObservedAt), 'deployed-native-container', { nativeInspectionAbsent: stopped?.container === null, generation: journal.runId });
        journal.stop = 'ACKNOWLEDGED'; report.providerGatePassed = true; report.status = 'PROVIDER_PASS';
      }
      journal.checks = report.checks;
    } else report.checks.push({ name: 'explicit-live-run-required', status: 'BLOCKED', observationClass: 'configuration', detail: { remoteCalls: 0, remoteMutations: 0 } });
  } catch (error) {
    report.status = classifyFailure(journal) === 'RECONCILIATION_REQUIRED' ? 'RECONCILIATION_REQUIRED' : !journal || journal.deploy === 'NOT_DISPATCHED' ? 'BLOCKED' : 'FAIL';
    report.checks.push({ name: 'sanitized-operation-failure', status: 'BLOCKED', observationClass: 'configuration', detail: { rawErrorOmitted: true, automaticRetry: false,
      ...(error instanceof CaptureFailure ? { subprocessReason: error.reason, exitCode: error.exitCode } : {}) } });
  }
  return finish();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const report = await main(); if (report.status === 'FAIL') process.exitCode = 1; }
  catch { console.error(JSON.stringify({ status: 'RECONCILIATION_REQUIRED', providerGatePassed: false, reportPersisted: false, inspectJournalBeforeRetry: true, rawErrorOmitted: true })); process.exitCode = 1; }
}
