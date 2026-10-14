// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, open, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeKernel } from '../packages/protocol/src/node.ts';
import { canonicalize, digest, parseStrictJson, type TrustConfig } from '../packages/protocol/src/index.ts';
import { checkerInputPaths } from '../scripts/checker-inputs.ts';
import { atomic, accountGate, applicationList, boundedCapture, privateEnvironment } from './live-container-check.ts';
import { buildSource, fixturePaths, ownedNames } from './live-evaluator/source.ts';
import { OWNED_JOB_COUNT, runScope } from './live-evaluator/requests.ts';
import { awaitDeploymentAssociations, boundedBytes, deployedModulesMatch, dispatchOnce, endpointOwned, ensure, evaluateProof, jsonResponse, managedImageOwned, validatePrepared } from './live-evaluator/client.ts';
import type { PreparedRun, RunJournal, SourcePackage, Phase } from './live-evaluator/types.ts';
const root = fileURLToPath(new URL('..', import.meta.url)), directory = resolve(root, 'infra/live-evaluator');
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const hash = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const limitations = [
  'This gate uses unchanged production evaluator execution, hydration, recipes, fixture routes and whole-container stop on two real scheduler slots. Its authenticated controller/callback receiver is an owned conformance observer, not application identity or ProjectAuthority admission.',
  'Nine good and nine inadequate-combination jobs plus two separately labelled fault jobs are finite observations, not arbitrary-program correctness or performance evidence.',
  'The restart fault is one controller abort. Callback503 is injected once after immutable retention. The production30-second deadline is unchanged; no artificially forced deadline PASS is claimed.',
  'No Artifacts, publication, real model, authoring runtime, application OIDC, complete binding-isolation or full competition readiness is established.',
  'Deployment/image acknowledgments and final generation absence are separate from named infrastructure cleanup and physical storage reclamation.',
];
async function cli(args: string[], account?: string, timeout = 30000): Promise<string> { return boundedCapture(process.execPath, [wrangler, ...args], { cwd: root, account, timeout, maximum: 2 * 1024 * 1024 }); }
export async function inputDigests(): Promise<Record<string, string>> {
  const own = (await readdir(directory)).filter(name => /\.(ts|jsonc|json|md)$/.test(name)).map(name => `infra/live-evaluator/${name}`);
  const paths = [...new Set([...checkerInputPaths, ...own, 'infra/live-evaluator-check.ts', 'infra/live-container-check.ts', 'infra/live-container/types.ts', 'infra/live-container/continuation.ts', 'workers/authority/kernel.ts', 'workers/authority/types.ts', 'workers/evaluator/wrangler.jsonc', 'package.json', ...fixturePaths.map(name => `fixtures/collaboration-demo/${name}`)])].sort();
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(resolve(root, path)))])));
}
async function revision(): Promise<{ sourceRevision: string | null; sourceDirty: boolean | null }> {
  try { return { sourceRevision: (await boundedCapture('git', ['rev-parse', 'HEAD'], { cwd: root })).trim(), sourceDirty: Boolean((await boundedCapture('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root })).trim()) }; }
  catch { return { sourceRevision: null, sourceDirty: null }; }
}
async function sourceFiles(): Promise<Record<string, string>> { return Object.fromEntries(await Promise.all(fixturePaths.map(async name => [name, await readFile(resolve(root, 'fixtures/collaboration-demo', name), 'utf8')]))); }
async function privateJson(path: string): Promise<any> { const info = await stat(path); ensure(info.isFile() && (info.mode & 0o077) === 0 && info.size <= 65536, 'PRIVATE_FILE_REQUIRED'); return parseStrictJson(await readFile(path, 'utf8')); }
export async function templates(prepared: PreparedRun, account: string, checkerDigest: string, publicKeys: any, expiry = 0, image: string | null = null): Promise<Record<string, any>> {
  const evaluator = JSON.parse(await readFile(resolve(directory, 'evaluator.wrangler.jsonc'), 'utf8')), controller = JSON.parse(await readFile(resolve(directory, 'controller.wrangler.jsonc'), 'utf8'));
  for (const [role, config] of Object.entries({ evaluator, controller })) {
    config.$schema = resolve(root, 'node_modules/wrangler/config-schema.json'); config.account_id = account; config.name = prepared.names[role as 'evaluator' | 'controller']; config.main = resolve(directory, `${role}.ts`);
    config.r2_buckets[0].bucket_name = prepared.names.bucket;
  }
  evaluator.exports.ConformanceEvaluation.container = prepared.names.container; evaluator.containers[0].name = prepared.names.container;
  evaluator.containers[0].images.base = image ? { image } : { dockerfile: resolve(root, 'workers/evaluator/Dockerfile'), build_context: root };
  evaluator.services[0].service = prepared.names.controller; controller.services[0].service = prepared.names.evaluator;
  for (const binding of controller.durable_objects.bindings.filter((binding: any) => binding.script_name)) binding.script_name = prepared.names.evaluator;
  const imageDigest = image?.split('@')[1] ?? 'UNCONFIGURED'; Object.assign(evaluator.vars, { CHECKER_IMPLEMENTATION_DIGEST: checkerDigest, EVALUATION_IMAGE_DIGEST: imageDigest });
  Object.assign(controller.vars, { RUN_ID: prepared.runId, EXPIRES_AT: String(expiry), CHECKER_PUBLIC_KEY: publicKeys.checker, ROOT_PUBLIC_KEY: publicKeys.root, CHECKER_IMPLEMENTATION_DIGEST: checkerDigest, EVALUATION_IMAGE_DIGEST: imageDigest, GOOD_SOURCE_DIGEST: prepared.fixtureDigests.good, BAD_SOURCE_DIGEST: prepared.fixtureDigests.bad });
  const bootstrap = { $schema: resolve(root, 'node_modules/wrangler/config-schema.json'), account_id: account, name: prepared.names.controller, main: resolve(root, 'infra/bootstrap.ts'), compatibility_date: '2026-10-01', workers_dev: false, preview_urls: false };
  return { evaluator, controller, bootstrap };
}
async function checkerDigest(): Promise<string> { const entries = await Promise.all(checkerInputPaths.map(async path => ({ path, digest: hash(await readFile(resolve(root, path))) }))); return hash(canonicalize({ schemaVersion: 1, entries })); }
async function writeConfigs(runDirectory: string, configs: Record<string, any>): Promise<Record<string, string>> { const hashes: Record<string, string> = {}; for (const [name, config] of Object.entries(configs)) { const path = resolve(runDirectory, `${name}.json`); await atomic(path, config); hashes[name] = hash(await readFile(path)); } return hashes; }
async function modules(path: string): Promise<Record<string, Uint8Array>> {
  const paths: string[] = []; const walk = async (dir: string) => { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = resolve(dir, entry.name); if (entry.isDirectory()) await walk(file); else if (/\.(js|wasm)$/.test(entry.name)) paths.push(file); } }; await walk(path);
  return Object.fromEntries(await Promise.all(paths.map(async file => [file.slice(path.length + 1), new Uint8Array(await readFile(file))])));
}
export async function prepareRun(runDirectory: string): Promise<PreparedRun> {
  await initializeKernel(); await mkdir(dirname(runDirectory), { recursive: true, mode: 0o700 }); await mkdir(runDirectory, { recursive: false, mode: 0o700 }); const runId = randomUUID(), base = await sourceFiles();
  const good = await buildSource(base, 'good', runId), bad = await buildSource(base, 'bad', runId);
  const prepared: PreparedRun = { schemaVersion: 1, runId, scope: runScope(runId), createdAt: new Date().toISOString(), names: ownedNames(runId), sourceDigests: await inputDigests(), fixtureDigests: { good: await digest(good), bad: await digest(bad) }, ...await revision() };
  const checker = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']), rootKey = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']); ensure('privateKey' in checker && 'publicKey' in checker && 'publicKey' in rootKey, 'KEY_GENERATION_FAILED');
  const publicKeys = { checker: Buffer.from(await webcrypto.subtle.exportKey('raw', checker.publicKey)).toString('base64'), root: Buffer.from(await webcrypto.subtle.exportKey('raw', rootKey.publicKey)).toString('base64') };
  const serviceToken = randomBytes(32).toString('hex');
  await atomic(resolve(runDirectory, 'controller.secrets.json'), { ADMIN_TOKEN: randomBytes(32).toString('hex'), EVALUATOR_SERVICE_TOKEN: serviceToken });
  await atomic(resolve(runDirectory, 'evaluator.secrets.json'), { EVALUATOR_SERVICE_TOKEN: serviceToken, CHECKER_SIGNING_KEY: Buffer.from(await webcrypto.subtle.exportKey('pkcs8', checker.privateKey)).toString('base64') });
  for (const [name, source] of Object.entries({ good, bad })) await atomic(resolve(runDirectory, `${name}.source.json`), source);
  await atomic(resolve(runDirectory, 'public-keys.json'), publicKeys); await atomic(resolve(runDirectory, 'prepared.json'), prepared);
  const journal: RunJournal = { schemaVersion: 1, prepared, accountId: '', createBucket: 'NOT_DISPATCHED', bootstrapController: 'NOT_DISPATCHED', deployEvaluator: 'NOT_DISPATCHED', deployController: 'NOT_DISPATCHED', seedGood: 'NOT_DISPATCHED', seedBad: 'NOT_DISPATCHED', dispatch: 'NOT_DISPATCHED', faults: 'NOT_DISPATCHED', image: null, evaluatorVersion: null, controllerVersion: null, configDigests: {}, expiresAt: null, endpoint: null, unresolvedResources: [], cleanup: {} };
  await atomic(resolve(runDirectory, 'journal.json'), journal); return prepared;
}
export async function main(args = process.argv.slice(2)): Promise<any> {
  await initializeKernel(); const report: any = { schemaVersion: 1, status: 'BLOCKED', providerGatePassed: false, generatedAt: new Date().toISOString(), checks: [], limitations, sourceDigests: await inputDigests(), ...await revision(), remoteCalls: 0, remoteMutations: 0 };
  report.compatibilityDate = '2026-10-01'; report.versions = { node: process.version };
  for (const name of ['wrangler', '@cloudflare/sandbox', '@cloudflare/workers-types', 'tsx', 'typescript']) report.versions[name] = JSON.parse(await readFile(resolve(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  report.checkerImplementationDigest = await checkerDigest();
  const value = (name: string) => args[args.indexOf(name) + 1]; const destination = args.includes('--out') ? resolve(value('--out')) : resolve(directory, '.runs', `report-${Date.now()}.json`);
  const out = args.includes('--prepare') ? resolve(destination, 'preparation-report.json') : destination;
  // A live report is incrementally retained only by its creating invocation.
  // Existing historical outputs are never replaced by another invocation/mode.
  if (!args.includes('--prepare')) {
    await mkdir(dirname(out), { recursive: true, mode: 0o700 });
    let claim;
    try { claim = await open(out, 'wx', 0o600); await claim.writeFile(JSON.stringify(report) + '\n'); await claim.sync(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ...report, reason: 'IMMUTABLE_REPORT_ALREADY_EXISTS' }; throw error; }
    finally { await claim?.close(); }
  }
  let journal: RunJournal | undefined, lock: Awaited<ReturnType<typeof open>> | undefined, journalPath: string | undefined;
  const retain = async () => { report.generatedAt = new Date().toISOString(); if (journal && journalPath) { report.journal = journal; await atomic(journalPath, journal); } await atomic(out, report); };
  try {
    ensure(args.every(arg => !arg.startsWith('--') || ['--prepare', '--package', '--self-test', '--run', '--reconcile', '--close', '--journal', '--account', '--out'].includes(arg)), 'CLOSED_COMMAND_LINE_REQUIRED');
    ensure(['--prepare', '--package', '--self-test', '--run', '--reconcile', '--close'].filter(mode => args.includes(mode)).length <= 1, 'ONE_MODE_REQUIRED');
    if (args.includes('--prepare')) { const prepared = await prepareRun(destination); report.prepared = prepared; report.status = 'PREPARED'; await atomic(out, report); return report; }
    if (args.includes('--self-test')) { const output = await boundedCapture(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', resolve(directory, 'test.ts'), resolve(directory, 'overlap-http.test.ts')], { cwd: root, timeout: 60000, maximum: 256 * 1024 }); report.status = 'SELF_TEST_PASS'; report.testOutputDigest = hash(output); report.tests = Number(/# tests ([0-9]+)/.exec(output)?.[1] ?? 0); report.checks.push({ name: 'owned-local-tests', status: 'PASS', observationClass: 'owned-local-test' }); await retain(); return report; }
    if (!['--package', '--run', '--reconcile', '--close'].some(mode => args.includes(mode))) { report.checks.push({ name: 'explicit-live-run-required', status: 'BLOCKED', mutationPerformed: false }); await retain(); return report; }
    ensure(args.includes('--journal'), 'OWNED_JOURNAL_REQUIRED'); journalPath = resolve(value('--journal')); const runDirectory = dirname(journalPath); ensure(journalPath !== out, 'DISTINCT_IMMUTABLE_REPORT_REQUIRED');
    lock = await open(journalPath + '.lock', 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await lock.sync();
    journal = parseStrictJson(await readFile(journalPath, 'utf8')) as RunJournal; ensure(canonicalize(journal.prepared.names) === canonicalize(ownedNames(journal.prepared.runId)), 'OWNED_JOURNAL_INVALID');
    const publicKeys = await privateJson(resolve(runDirectory, 'public-keys.json')), controllerSecrets = await privateJson(resolve(runDirectory, 'controller.secrets.json')), evaluatorSecrets = await privateJson(resolve(runDirectory, 'evaluator.secrets.json'));
    ensure(Object.keys(controllerSecrets).sort().join(',') === 'ADMIN_TOKEN,EVALUATOR_SERVICE_TOKEN' && /^[a-f0-9]{64}$/.test(controllerSecrets.ADMIN_TOKEN) && /^[a-f0-9]{64}$/.test(controllerSecrets.EVALUATOR_SERVICE_TOKEN) && evaluatorSecrets.EVALUATOR_SERVICE_TOKEN === controllerSecrets.EVALUATOR_SERVICE_TOKEN && Object.keys(evaluatorSecrets).sort().join(',') === 'CHECKER_SIGNING_KEY,EVALUATOR_SERVICE_TOKEN', 'SECRET_ASSOCIATIONS');
    const checker = await webcrypto.subtle.importKey('pkcs8', Buffer.from(evaluatorSecrets.CHECKER_SIGNING_KEY, 'base64'), 'Ed25519', true, ['sign']), jwk = await webcrypto.subtle.exportKey('jwk', checker); ensure(jwk.x && Buffer.from(jwk.x, 'base64url').toString('base64') === publicKeys.checker && publicKeys.checker !== publicKeys.root, 'CHECKER_PUBLIC_KEY_MISMATCH');
    const checkerHash = await checkerDigest(), sources = { good: parseStrictJson(await readFile(resolve(runDirectory, 'good.source.json'), 'utf8')) as SourcePackage, bad: parseStrictJson(await readFile(resolve(runDirectory, 'bad.source.json'), 'utf8')) as SourcePackage };
    ensure(await digest(sources.good) === journal.prepared.fixtureDigests.good && await digest(sources.bad) === journal.prepared.fixtureDigests.bad, 'FIXTURE_SOURCE_CHANGED');
    const account = args.includes('--account') ? value('--account') : journal.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || '';
    if (args.includes('--package')) {
      ensure([journal.createBucket, journal.bootstrapController, journal.deployEvaluator, journal.deployController, journal.seedGood, journal.seedBad, journal.dispatch].every(phase => phase === 'NOT_DISPATCHED'), 'RETAIN_DISPATCHED_CONFIGURATION');
      ensure(canonicalize(journal.prepared.sourceDigests) === canonicalize(report.sourceDigests), 'SOURCE_CHANGED');
      const configs = await templates(journal.prepared, /^[a-f0-9]{32}$/.test(account) ? account : '0'.repeat(32), checkerHash, publicKeys); await writeConfigs(runDirectory, configs);
      for (const role of ['evaluator', 'controller']) { const output = await cli(['deploy', '--dry-run', '--config', resolve(runDirectory, `${role}.json`), '--outdir', resolve(runDirectory, 'bundle', role)], undefined, 300000); report.checks.push({ name: `package-${role}`, status: 'PASS', observationClass: 'local-package', outputDigest: hash(output) }); }
      report.status = 'PACKAGE_PASS'; await retain(); return report;
    }
    validatePrepared(journal.prepared, report.sourceDigests); ensure(report.sourceDirty === false && report.sourceRevision === journal.prepared.sourceRevision, 'CLEAN_SOURCE_REVISION_CHANGED'); ensure(/^[a-f0-9]{32}$/.test(account) && (!journal.accountId || journal.accountId === account), 'EXACT_SELECTED_ACCOUNT_REQUIRED');
    const gate = accountGate(await cli(['whoami', '--json'], account), account); report.checks.push(gate); ensure(gate.status === 'PASS', 'WRANGLER_SELECTED_ACCOUNT_UNAVAILABLE');
    const selected = JSON.parse(await cli(['auth', 'token', '--json'], account)); ensure(selected.type === 'oauth' && typeof selected.token === 'string' && selected.token.length >= 20, 'EXISTING_OAUTH_REQUIRED');
    const credential = selected.token; const apiRoot = `https://api.cloudflare.com/client/v4/accounts/${account}`;
    const api = async (path: string, method = 'GET', body?: unknown, signal?: AbortSignal) => {
      ensure(path.startsWith('/') && !path.includes('..'), 'SCOPED_API_PATH'); report.remoteCalls++; if (method !== 'GET') report.remoteMutations++;
      const response = await fetch(apiRoot + path, { method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) }); const result = await jsonResponse(response);
      (report.apiObservations ??= []).push({ path, method, status: response.status, responseDigest: hash(canonicalize(result)), numericErrors: Array.isArray(result.errors) ? result.errors.map((error: any) => error.code).filter((code: unknown) => typeof code === 'number' && Number.isInteger(code)) : [] });
      return { status: response.status, body: result };
    };
    const control = async (path: string, body?: unknown) => {
      ensure(journal!.endpoint && endpointOwned(journal!.endpoint, journal!.prepared.names.controller), 'OWNED_ENDPOINT_REQUIRED'); report.remoteCalls++; if (body !== undefined) report.remoteMutations++;
      const response = await fetch(new URL(path, journal!.endpoint), { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${controllerSecrets.ADMIN_TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : canonicalize(body), redirect: 'error', signal: AbortSignal.timeout(body === undefined ? 20000 : 60000) }); const result = await jsonResponse(response); ensure(response.ok, 'OWNED_CONTROL_UNACKNOWLEDGED'); return result;
    };
    const once = <T>(key: keyof RunJournal, effect: () => Promise<T>) => dispatchOnce(() => journal![key] as Phase, async phase => { (journal as any)[key] = phase; await retain(); }, effect);
    if (args.includes('--reconcile')) { report.snapshot = await control('/inspect'); report.status = 'RECONCILIATION_REQUIRED'; await retain(); return report; }
    if (args.includes('--close')) { await dispatchOnce(() => journal!.cleanup.admissionsClose ?? 'NOT_DISPATCHED', async phase => { journal!.cleanup.admissionsClose = phase; await retain(); }, () => control('/close', {})); report.snapshot = await control('/inspect'); report.status = 'RECONCILIATION_REQUIRED'; await retain(); return report; }
    ensure([journal.createBucket, journal.bootstrapController, journal.deployEvaluator, journal.deployController, journal.seedGood, journal.seedBad, journal.dispatch, journal.faults].every(phase => phase === 'NOT_DISPATCHED'), 'POSSIBLE_EFFECT_MUST_NOT_REPEAT');
    journal.accountId = account; journal.unresolvedResources = [journal.prepared.names.bucket, journal.prepared.names.controller, journal.prepared.names.evaluator, journal.prepared.names.container]; await retain();
    const names = journal.prepared.names;
    const bucket = await api(`/r2/buckets/${names.bucket}`); ensure(bucket.status === 404 && bucket.body.success === false && Array.isArray(bucket.body.errors) && bucket.body.errors.some((error: any) => error.code === 10006) && !bucket.body.errors.some((error: any) => error.code === 10000), 'EXACT_R2_NAME_ABSENCE_UNVERIFIED');
    for (const name of [names.controller, names.evaluator]) { const found = await api(`/workers/scripts/${name}/settings`); ensure(found.status === 404 && found.body.success === false && found.body.errors?.some((error: any) => error.code === 10007), 'FRESH_WORKER_NAME_ABSENCE_UNVERIFIED'); }
    const applications = await api(`/containers/applications?name=${names.container}`); ensure(applications.status === 200 && applicationList(applications.body)?.complete === true && !applications.body.result.some((application: any) => application.name === names.container), 'FRESH_APPLICATION_NAME_ABSENCE_UNVERIFIED');
    const initial = await templates(journal.prepared, account, checkerHash, publicKeys); journal.configDigests = await writeConfigs(runDirectory, initial); await retain();
    for (const role of ['evaluator', 'controller']) { const output = await cli(['deploy', '--dry-run', '--config', resolve(runDirectory, `${role}.json`), '--outdir', resolve(runDirectory, 'bundle', role)], account, 300000); report.checks.push({ name: `package-${role}`, status: 'PASS', outputDigest: hash(output) }); }
    await once('createBucket', async () => { const result = await api('/r2/buckets', 'POST', { name: names.bucket }); ensure(result.status === 200 && result.body.success === true && result.body.result?.name === names.bucket, 'R2_CREATE_UNACKNOWLEDGED'); const observed = await api(`/r2/buckets/${names.bucket}`); ensure(observed.status === 200 && observed.body.success === true && observed.body.result?.name === names.bucket, 'R2_CREATE_NOT_OBSERVED'); return true; });
    const deploy = async (role: string, secrets = true) => { const output = await cli(['deploy', '--config', resolve(runDirectory, `${role}.json`), ...(secrets ? ['--secrets-file', resolve(runDirectory, `${role}.secrets.json`)] : [])], account, 300000); const version = /Current Version ID:\s*([a-f0-9-]{36})/.exec(output)?.[1] ?? null; report.checks.push({ name: `deploy-${role}`, status: 'ACKNOWLEDGED', outputDigest: hash(output), version });
      if (role === 'evaluator') journal!.evaluatorVersion = version; if (role === 'controller') journal!.controllerVersion = version; return output; };
    await once('bootstrapController', () => deploy('bootstrap', false));
    await once('deployEvaluator', async () => { const output = await deploy('evaluator'); journal!.evaluatorVersion = /Current Version ID:\s*([a-f0-9-]{36})/.exec(output)?.[1] ?? null; return true; });
    await once('deployController', async () => { const output = await deploy('controller'); journal!.controllerVersion = /Current Version ID:\s*([a-f0-9-]{36})/.exec(output)?.[1] ?? null; const endpoint = output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\/?/)?.[0]; ensure(endpoint && endpointOwned(new URL(endpoint).href, names.controller), 'OWNED_DEPLOYMENT_ENDPOINT_UNOBSERVED'); journal!.endpoint = new URL(endpoint).href; return true; });
    let deployment: any;
    for (let retry = 0; retry < 20; retry++) { try { deployment = await control('/deployment'); break; } catch { await new Promise(resolve => setTimeout(resolve, 1000)); } }
    ensure(deployment?.runId === journal.prepared.runId && deployment.image?.container === null && deployment.image?.phase === 'MISSING', 'PRESTART_NATIVE_ABSENCE_UNOBSERVED');
    const image = deployment.image.configuredImage; ensure(managedImageOwned(image, account, names.evaluator), 'EXACT_MANAGED_IMAGE_UNOBSERVED');
    journal.image = image; journal.expiresAt = Date.now() + 20 * 60000;
    const armed = await templates(journal.prepared, account, checkerHash, publicKeys, journal.expiresAt, image); journal.configDigests = await writeConfigs(runDirectory, armed); await retain();
    // These are distinct, explicitly journaled updates before any job is admitted.
    for (const role of ['evaluator', 'controller']) {
      const output = await cli(['deploy', '--dry-run', '--config', resolve(runDirectory, `${role}.json`), '--outdir', resolve(runDirectory, 'bundle', role)], account, 300000); report.checks.push({ name: `pin-package-${role}`, status: 'PASS', outputDigest: hash(output) });
      await dispatchOnce(() => journal!.cleanup[`pin-${role}`] ?? 'NOT_DISPATCHED', async phase => { journal!.cleanup[`pin-${role}`] = phase; await retain(); }, () => deploy(role));
    }
    for (const role of ['evaluator', 'controller']) {
      report.remoteCalls++; const response = await fetch(`${apiRoot}/workers/scripts/${names[role as 'evaluator' | 'controller']}/content/v2`, { headers: { authorization: `Bearer ${credential}` }, redirect: 'error', signal: AbortSignal.timeout(20000) }); ensure(await deployedModulesMatch(response, await modules(resolve(runDirectory, 'bundle', role))), 'DEPLOYED_MODULE_BYTES_MISMATCH');
    }
    report.association = await awaitDeploymentAssociations({ expected: { prepared: journal.prepared, account, image, configs: armed },
      read: async signal => {
        const responses = await Promise.allSettled([
          api(`/workers/scripts/${names.evaluator}/settings`, 'GET', undefined, signal),
          api(`/workers/scripts/${names.controller}/settings`, 'GET', undefined, signal),
          api(`/containers/applications?name=${names.container}`, 'GET', undefined, signal),
        ]);
        const [settings, controllerSettings, apps] = responses.map(response => response.status === 'fulfilled' ? response.value : undefined);
        return { observed: settings?.status === 200 && settings.body.success === true && controllerSettings?.status === 200 && controllerSettings.body.success === true && apps?.status === 200 && applicationList(apps.body)?.complete === true && apps.body.result.length === 1,
          evaluator: settings?.body.result, controller: controllerSettings?.body.result, application: Array.isArray(apps?.body.result) ? apps.body.result[0] : undefined };
      },
      retain: async attempt => { (report.associationAttempts ??= []).push(attempt); await retain(); },
    }); await retain();
    const observed = await control('/deployment'); ensure(observed.runId === journal.prepared.runId && observed.image.configuredImage === image && observed.image.container === null && observed.admissionExpiresAt === journal.expiresAt && Date.now() < journal.expiresAt, 'PINNED_DEPLOYMENT_NOT_READY');
    await once('seedGood', () => control('/seed', sources.good)); await once('seedBad', () => control('/seed', sources.bad));
    await once('dispatch', () => control('/dispatch', {})); journal.faults = 'MAY_HAVE_DISPATCHED'; await retain();
    const observations = []; let snapshot: any; const observationDeadline = Math.min(journal.expiresAt, Date.now() + 360000);
    for (let poll = 0; poll < 240 && Date.now() < observationDeadline; poll++) { snapshot = await control('/inspect'); observations.push({ at: new Date().toISOString(), jobs: snapshot.jobs.map((row: any) => ({ category: row.category, native: row.native, callback: row.callback ? { digest: row.callback.digest, deliveries: row.callback.deliveries, rejectedOnce: row.callback.rejectedOnce } : null })), scheduler: snapshot.scheduler }); report.observations = observations; report.snapshot = snapshot; await retain(); if (snapshot.jobs.length === OWNED_JOB_COUNT && snapshot.jobs.every((row: any) => row.native.phase === 'STOPPED' && row.native.container === null && row.native.callbackDelivered) && Object.values(snapshot.scheduler).every((job: any) => job.status === 'DONE')) break; await new Promise(resolve => setTimeout(resolve, 1000)); }
    const callbacks = []; for (const row of snapshot?.jobs ?? []) callbacks.push(await control('/evidence', { jobId: row.native.jobId }));
    const trust: TrustConfig = { schemaVersion: 1, scope: journal.prepared.scope, keysetRevision: '1', keys: [{ id: 'owned-root', publicKeyBase64: publicKeys.root, roles: ['root'] }, { id: 'owned-checker', publicKeyBase64: publicKeys.checker, roles: ['checker'] }] };
    report.snapshot = snapshot; report.callbacks = callbacks; report.proof = await evaluateProof({ prepared: journal.prepared, image, checkerDigest: checkerHash, trust, snapshot, callbacks, sources });
    journal.faults = 'ACKNOWLEDGED'; report.status = 'PROVIDER_PASS'; report.providerGatePassed = true;
    await dispatchOnce(() => journal!.cleanup.admissionsClose ?? 'NOT_DISPATCHED', async phase => { journal!.cleanup.admissionsClose = phase; await retain(); }, () => control('/close', {}));
    report.cleanupRequired = { exactNames: names, allNativeGenerationsAbsent: true, infrastructureAbsenceUnverified: true }; await retain(); return report;
  } catch (error) {
    const uncertain = journal && (['createBucket', 'bootstrapController', 'deployEvaluator', 'deployController', 'seedGood', 'seedBad', 'dispatch'].some(key => ['MAY_HAVE_DISPATCHED', 'UNKNOWN'].includes((journal as any)[key])) || Object.values(journal.cleanup).some(phase => ['MAY_HAVE_DISPATCHED', 'UNKNOWN'].includes(phase)) || journal.dispatch === 'ACKNOWLEDGED' && (!report.snapshot || report.snapshot.jobs?.some((row: any) => row.native.phase !== 'STOPPED' || row.native.container !== null || !row.native.callbackDelivered) || Object.values(report.snapshot.scheduler ?? {}).some((job: any) => job.status !== 'DONE')));
    report.status = uncertain ? 'RECONCILIATION_REQUIRED' : journal?.dispatch === 'ACKNOWLEDGED' ? 'FAIL' : 'BLOCKED';
    report.reason = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'SANITIZED_OPERATION_FAILURE'; report.providerGatePassed = false;
    if (!args.includes('--prepare')) await retain(); return report;
  } finally { if (lock && journalPath) { await lock.close(); await rm(journalPath + '.lock', { force: true }); } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const report = await main(); process.stdout.write(JSON.stringify({ status: report.status, providerGatePassed: report.providerGatePassed, reason: report.reason ?? null, runId: report.prepared?.runId ?? report.journal?.prepared?.runId ?? null, tests: report.tests ?? null }) + '\n'); if (['BLOCKED', 'RECONCILIATION_REQUIRED'].includes(report.status)) process.exitCode = 2; if (report.status === 'FAIL') process.exitCode = 1; }
  catch { process.stderr.write('SANITIZED_LOCAL_PREPARATION_FAILURE\n'); process.exitCode = 1; }
}
