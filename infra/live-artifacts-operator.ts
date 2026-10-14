// SPDX-License-Identifier: Apache-2.0
// Native lifecycle for the finite, inert binding check. Every mutation is
// durably recorded before dispatch; uncertainty is reconciled by observation.
import { createHash } from 'node:crypto';
import { lstat, open, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalize } from '../packages/protocol/src/index.ts';
import { privateWranglerEnvironment, selectWranglerCredential } from '../scripts/provider-preflight.ts';
import { atomic, bundleIdentity, ownedJournal, sourceIdentity, validEndpoint } from './live-artifacts-check.ts';
import type { BindingJournal } from './live-artifacts/types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
export const hash = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const ensure = (value: unknown, code: string): void => { if (!value) throw new Error(code); };
type Phase = 'MAY_HAVE_DISPATCHED' | 'ACKNOWLEDGED' | 'UNKNOWN';
interface NativeJournal {
  schemaVersion: 1; runId: string; accountId: string; namespace: string; sourceSetDigest: string;
  configDigest: string; bundleDigests: Record<string, string>; workerName: string; bucketName: string;
  effects: Record<string, { phase: Phase; result?: unknown; reason?: string }>;
  observations: { at: string; resource: string; status: number; bodyDigest: string }[];
  identity?: Record<string, unknown>; archiveDigest?: string; retainedFenceDigest?: string;
  status: string; reason?: string; completedAt?: string;
}
interface Archive { schemaVersion: 1; runId: string; sourceSetDigest: string; totalBytes: number;
  objects: { key: string; bytes: number; sha256: string; base64: string }[]; archiveDigest: string }
export async function bounded(response: Response, maximum = 4 * 1024 * 1024): Promise<Uint8Array> {
  ensure(response.body, 'RESPONSE_BODY_REQUIRED'); const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const item = await reader.read(); if (item.done) break; bytes += item.value.length; ensure(bytes <= maximum, 'RESPONSE_BOUND'); chunks.push(item.value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return new Uint8Array(Buffer.concat(chunks));
}
export function exactAbsence(status: number, body: any, code: number): boolean {
  return status === 404 && body?.success === false && Array.isArray(body.errors)
    && body.errors.some((item: any) => item.code === code) && !body.errors.some((item: any) => item.code === 10000);
}
function moduleName(name: string): string | null {
  const logical = name.startsWith('./') ? name.slice(2) : name;
  return !logical || logical.startsWith('/') || logical.includes('\\') || /^[A-Za-z]:/.test(logical)
    || logical.split('/').some(part => !part || part === '.' || part === '..') ? null : logical;
}
export async function modulesExact(response: Response, expected: Record<string, string>): Promise<boolean> {
  if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('multipart/')) return false;
  const bytes = await bounded(response), form = await new Response(bytes.slice().buffer, { headers: response.headers }).formData();
  const actual: Record<string, string> = Object.create(null);
  for (const [name, part] of form.entries()) {
    const logical = moduleName(name); if (!logical || !Object.hasOwn(expected, logical) || Object.hasOwn(actual, logical) || !(part instanceof File)) return false;
    actual[logical] = hash(new Uint8Array(await part.arrayBuffer()));
  }
  const entry = moduleName(response.headers.get('cf-entrypoint') ?? '');
  return !!entry && entry.endsWith('.js') && Object.hasOwn(expected, entry)
    && canonicalize({ ...actual }) === canonicalize(expected);
}
export function bindingsExact(settings: any, config: any): boolean {
  try {
    if (settings.compatibility_date !== config.compatibility_date
      || canonicalize([...(settings.compatibility_flags ?? [])].sort()) !== canonicalize([...config.compatibility_flags].sort())
      || !Array.isArray(settings.bindings)) return false;
    const expected = [
      { name: 'ARTIFACTS', type: 'artifacts', namespace: config.artifacts[0].namespace },
      { name: 'OBJECTS', type: 'r2_bucket', bucket_name: config.r2_buckets[0].bucket_name },
      { name: 'CONTROL_TOKEN', type: 'secret_text' },
      ...Object.entries(config.vars).map(([name, text]) => ({ name, type: 'plain_text', text })),
    ];
    if (settings.bindings.length !== expected.length || new Set(settings.bindings.map((item: any) => item.name)).size !== expected.length) return false;
    return expected.every(binding => {
      const actual = settings.bindings.find((item: any) => item.name === binding.name);
      return actual && Object.entries(binding).every(([key, value]) => actual[key] === value)
        && (!actual.jurisdiction || actual.jurisdiction === 'default' || binding.type !== 'r2_bucket')
        && (!actual.preview_bucket_name || binding.type !== 'r2_bucket');
    });
  } catch { return false; }
}
export function configExact(config: unknown, journal: BindingJournal, production: { compatibility_date: string; compatibility_flags: string[]; rules: unknown[] }): boolean {
  const expected = { $schema: resolve(root, 'node_modules/wrangler/config-schema.json'), name: journal.workerName, account_id: journal.accountId,
    main: resolve(root, 'infra/live-artifacts/worker.ts'), compatibility_date: production.compatibility_date, compatibility_flags: production.compatibility_flags,
    rules: production.rules, workers_dev: true, preview_urls: false, observability: { enabled: false },
    artifacts: [{ binding: 'ARTIFACTS', namespace: journal.namespace }], r2_buckets: [{ binding: 'OBJECTS', bucket_name: journal.bucketName }],
    vars: { RUN_ID: journal.runId, ACCOUNT_ID: journal.accountId, NAMESPACE: journal.namespace, SOURCE_SET_DIGEST: journal.sourceSetDigest,
      EXPIRES_AT: String(journal.expiresAt), CANONICAL_NAME: journal.canonicalName, ATTEMPT_ID: journal.attemptId }, secrets: { required: ['CONTROL_TOKEN'] } };
  try { return canonicalize(config) === canonicalize(expected); } catch { return false; }
}
export function verifiedArchive(value: unknown, journal: Pick<BindingJournal, 'runId' | 'sourceSetDigest'>): Archive {
  const archive = value as Archive;
  ensure(archive?.schemaVersion === 1 && archive.runId === journal.runId && archive.sourceSetDigest === journal.sourceSetDigest
    && Array.isArray(archive.objects) && archive.objects.length <= 128, 'ARCHIVE_ASSOCIATION');
  const keys = new Set<string>(); let total = 0;
  for (const item of archive.objects) {
    ensure(!keys.has(item.key) && (/^objects\/sha256\/[a-f0-9]{64}$/.test(item.key) || /^binding-check\/(snapshot\.json|run-claim|cleanup-claim|cleanup-finished)$/.test(item.key)), 'ARCHIVE_KEY'); keys.add(item.key);
    ensure(typeof item.base64 === 'string' && item.base64.length <= 3 * 1024 * 1024 && Number.isSafeInteger(item.bytes) && item.bytes >= 0, 'ARCHIVE_OBJECT_SCHEMA');
    const bytes = Buffer.from(item.base64, 'base64'); ensure(bytes.toString('base64') === item.base64 && bytes.length === item.bytes && hash(bytes) === item.sha256, 'ARCHIVE_BYTES'); total += bytes.length;
  }
  ensure(total <= 2 * 1024 * 1024 && total === archive.totalBytes && keys.has('binding-check/run-claim') && keys.has('binding-check/snapshot.json'), 'ARCHIVE_COMPLETE');
  const { archiveDigest, ...body } = archive; ensure(hash(canonicalize(body)) === archiveDigest, 'ARCHIVE_DIGEST'); return archive;
}
export async function dispatchOnce(effects: NativeJournal['effects'], name: string, save: () => Promise<void>, action: () => Promise<unknown>): Promise<void> {
  ensure(!effects[name], 'NATIVE_RECONCILE_BEFORE_RETRY'); effects[name] = { phase: 'MAY_HAVE_DISPATCHED' }; await save();
  try { effects[name] = { phase: 'ACKNOWLEDGED', result: await action() }; await save(); }
  catch (error) { effects[name] = { phase: 'UNKNOWN', reason: error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'NATIVE_RESPONSE_UNCONFIRMED' }; await save(); throw error; }
}
async function privateFile(path: string, maximum: number): Promise<Uint8Array> {
  const info = await lstat(path); ensure(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.size <= maximum, 'PRIVATE_REGULAR_FILE_REQUIRED'); return new Uint8Array(await readFile(path));
}
export async function main(args = process.argv.slice(2)): Promise<Record<string, unknown>> {
  const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const modes = ['--deploy', '--inspect', '--reconcile', '--retire'].filter(flag => args.includes(flag));
  ensure(modes.length === 1 && args.every(arg => !arg.startsWith('--') || [...modes, '--journal'].includes(arg)) && value('--journal'), 'CLOSED_COMMAND_LINE');
  const path = resolve(value('--journal')!), home = dirname(path), nativePath = resolve(home, 'native-operator.json'), lockPath = `${path}.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined, journal: BindingJournal | undefined, native: NativeJournal | undefined;
  const save = async () => { await atomic(nativePath, native); };
  try {
    try { lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); await lock.sync(); } catch { throw new Error('JOURNAL_LOCKED_INSPECT_BEFORE_RETRY'); }
    journal = JSON.parse(Buffer.from(await privateFile(path, 64 * 1024)).toString('utf8')) as BindingJournal;
    ensure(ownedJournal(journal) && path === resolve(dirname(journal.configPath), 'journal.json'), 'OWNED_JOURNAL_REQUIRED');
    ensure((await sourceIdentity()).digest === journal.sourceSetDigest, 'SOURCE_INPUTS_CHANGED');
    const configBytes = await privateFile(journal.configPath, 64 * 1024), secretBytes = await privateFile(journal.secretsPath, 1024);
    ensure(hash(configBytes) === journal.configDigest && hash(secretBytes) === journal.secretsDigest, 'PRIVATE_INPUT_ASSOCIATION');
    ensure(journal.bundleDigests && canonicalize(await bundleIdentity(resolve(home, 'bundle'))) === canonicalize(journal.bundleDigests), 'PACKAGED_BYTES_CHANGED');
    const config = JSON.parse(Buffer.from(configBytes).toString('utf8')), secret = JSON.parse(Buffer.from(secretBytes).toString('utf8'));
    const production = JSON.parse(await readFile(resolve(root, 'workers/authority/wrangler.jsonc'), 'utf8'));
    ensure(configExact(config, journal, production), 'EXACT_NATIVE_CONFIG_REQUIRED');
    ensure(/^[a-f0-9]{64}$/.test(secret.CONTROL_TOKEN) && Object.keys(secret).length === 1, 'CONTROL_SECRET_SCHEMA');
    try { native = JSON.parse(Buffer.from(await privateFile(nativePath, 256 * 1024)).toString('utf8')) as NativeJournal; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const association = { schemaVersion: 1 as const, runId: journal.runId, accountId: journal.accountId, namespace: journal.namespace,
      sourceSetDigest: journal.sourceSetDigest, configDigest: journal.configDigest, bundleDigests: journal.bundleDigests!, workerName: journal.workerName, bucketName: journal.bucketName };
    if (native) { for (const [key, expected] of Object.entries(association)) ensure(canonicalize((native as any)[key]) === canonicalize(expected), 'NATIVE_JOURNAL_ASSOCIATION'); }
    else { ensure(modes[0] === '--deploy', 'NATIVE_JOURNAL_REQUIRED'); native = { ...association, effects: {}, observations: [], status: 'PREPARED' }; await save(); }
    const selected = selectWranglerCredential(journal.accountId); ensure(selected.account === journal.accountId && selected.credential && selected.checks.every(check => check.status === 'PASS'), 'PRIVATE_NATIVE_CREDENTIAL_REQUIRED');
    const apiRoot = `https://api.cloudflare.com/client/v4/accounts/${journal.accountId}`;
    const request = async (resource: string, method = 'GET', body?: unknown, raw = false) => {
      const response = await fetch(`${apiRoot}${resource}`, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { authorization: `Bearer ${selected.credential}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(resource.includes('/objects/') && method === 'DELETE' ? { 'cf-r2-data-catalog-check': 'true' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const bytes = response.body ? await bounded(response) : new Uint8Array();
      native!.observations.push({ at: new Date().toISOString(), resource, status: response.status, bodyDigest: hash(bytes) }); await save();
      let parsed: any = null; if (!raw && bytes.length) { try { parsed = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new Error('NATIVE_JSON_REQUIRED'); } }
      return { status: response.status, body: parsed, bytes, headers: response.headers };
    };
    const account = await request(''); ensure(account.status === 200 && account.body.success === true && account.body.result.id === journal.accountId, 'SELECTED_ACCOUNT_UNVERIFIED');
    const workerPath = `/workers/scripts/${journal.workerName}`, bucketPath = `/r2/buckets/${journal.bucketName}`;
    const absence = async (kind: 'worker' | 'bucket') => { const found = await request(kind === 'worker' ? workerPath + '/settings' : bucketPath); return exactAbsence(found.status, found.body, kind === 'worker' ? 10007 : 10006); };
    const identity = async () => {
      const modules = await request(workerPath + '/content/v2', 'GET', undefined, true);
      ensure(await modulesExact(new Response(modules.bytes.slice().buffer, { status: modules.status, headers: modules.headers }), journal!.bundleDigests!), 'DEPLOYED_MODULE_BYTES_MISMATCH');
      const settings = await request(workerPath + '/settings');
      ensure(settings.status === 200 && settings.body?.success === true && bindingsExact(settings.body.result, config), 'DEPLOYED_BINDINGS_MISMATCH');
      const bucket = await request(bucketPath); ensure(bucket.status === 200 && bucket.body?.success === true && bucket.body.result.name === journal!.bucketName, 'DEPLOYED_R2_ASSOCIATION');
      const subdomain = await request('/workers/subdomain'); ensure(subdomain.status === 200 && subdomain.body?.success === true && /^[a-z0-9-]+$/.test(subdomain.body.result.subdomain), 'WORKERS_SUBDOMAIN_REQUIRED');
      const endpoint = `https://${journal!.workerName}.${subdomain.body.result.subdomain}.workers.dev/`;
      ensure(validEndpoint(endpoint, journal!.workerName) && (!journal!.endpoint || journal!.endpoint === endpoint), 'ENDPOINT_ASSOCIATION'); journal!.endpoint = endpoint; await atomic(path, journal);
      native!.identity = { ...association, deployedModulesExact: true, deployedBindingsExact: true, observedAt: new Date().toISOString() }; await save();
    };
    if (modes[0] === '--deploy') {
      ensure(Date.now() < journal.expiresAt && journal.run === 'NOT_DISPATCHED', 'CONTROL_EXPIRED_OR_ALREADY_RUN');
      const namespace = await request(`/artifacts/namespaces/${journal.namespace}`); ensure(namespace.status === 200 && namespace.body?.success === true && namespace.body.result.namespace === journal.namespace, 'EXACT_NAMESPACE_UNOBSERVED');
      ensure(await absence('worker') && await absence('bucket'), 'FRESH_NATIVE_NAMES_UNVERIFIED');
      await dispatchOnce(native.effects, 'create-bucket', save, async () => { const result = await request('/r2/buckets', 'POST', { name: journal!.bucketName }); ensure(result.status === 200 && result.body?.success === true && result.body.result.name === journal!.bucketName, 'R2_CREATE_UNACKNOWLEDGED'); return { name: journal!.bucketName }; });
      await dispatchOnce(native.effects, 'deploy-worker', save, async () => {
        const output = await promisify(execFile)(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--config', journal!.configPath, '--secrets-file', journal!.secretsPath],
          { cwd: root, env: privateWranglerEnvironment(process.env), timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
        return { outputDigest: hash(output.stdout + output.stderr) };
      });
      await identity(); native.status = 'DEPLOYED_IDENTITY_PASS';
    } else if (modes[0] === '--inspect') { ensure(Date.now() < journal.expiresAt, 'CONTROL_EXPIRED'); await identity(); native.status = 'DEPLOYED_IDENTITY_PASS'; }
    else if (modes[0] === '--reconcile') {
      const workerAbsent = await absence('worker'), bucketAbsent = await absence('bucket');
      native.status = workerAbsent && bucketAbsent ? 'NATIVE_ABSENCE_PASS' : 'RECONCILIATION_REQUIRED';
      if (!workerAbsent && !native.effects['delete-worker'] && Date.now() < journal.expiresAt) { await identity(); native.status = 'DEPLOYED_IDENTITY_PASS'; }
    } else {
      ensure(native.identity && journal.snapshot?.cleanupComplete && journal.cleanup !== 'NOT_DISPATCHED', 'BINDING_REPOSITORY_CLEANUP_REQUIRED');
      const control = async (route: string, method = 'GET', body?: unknown) => {
        ensure(journal!.endpoint && validEndpoint(journal!.endpoint, journal!.workerName) && Date.now() < journal!.expiresAt, 'CONTROL_EXPIRED_OR_ENDPOINT_REQUIRED');
        const response = await fetch(new URL(route, journal!.endpoint), { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${secret.CONTROL_TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const bytes = await bounded(response); ensure(response.ok, 'RETIRE_CONTROL_UNACKNOWLEDGED'); return JSON.parse(Buffer.from(bytes).toString('utf8'));
      };
      const archivePath = resolve(home, 'r2-archive.json'); let archive: Archive;
      if (!native.archiveDigest) {
        archive = verifiedArchive(await control('/archive'), journal); await atomic(archivePath, archive);
        native.archiveDigest = archive.archiveDigest; native.retainedFenceDigest = archive.objects.find(item => item.key === 'binding-check/run-claim')!.sha256; await save();
      } else { archive = verifiedArchive(JSON.parse(Buffer.from(await privateFile(archivePath, 4 * 1024 * 1024)).toString('utf8')), journal); ensure(archive.archiveDigest === native.archiveDigest, 'ARCHIVE_CHANGED'); }
      if (!native.effects['retire-objects']) await dispatchOnce(native.effects, 'retire-objects', save, async () => {
        const retired = await control('/retire-objects', 'POST', { archiveDigest: archive.archiveDigest });
        ensure(retired.runId === journal!.runId && retired.archiveDigest === archive.archiveDigest && retired.runFenced === true && retired.retainedFenceKey === 'binding-check/run-claim' && retired.retainedFenceDigest === native!.retainedFenceDigest, 'RETAINED_FENCE_UNCONFIRMED'); return retired;
      });
      if (!native.effects['delete-worker']) {
        const inventory = await control('/object-inventory'); ensure(inventory.runId === journal.runId && inventory.truncated === false && canonicalize(inventory.keys) === canonicalize(['binding-check/run-claim']), 'FENCE_ONLY_INVENTORY_REQUIRED');
        const fence = await request(bucketPath + '/objects/binding-check/run-claim', 'GET', undefined, true); ensure(fence.status === 200 && hash(fence.bytes) === native.retainedFenceDigest, 'EXACT_FENCE_BYTES_REQUIRED');
        await dispatchOnce(native.effects, 'delete-worker', save, async () => { const result = await request(workerPath, 'DELETE'); ensure(result.status >= 200 && result.status < 300 && (!result.body || result.body.success === true), 'WORKER_DELETE_UNACKNOWLEDGED'); return { acknowledged: true }; });
      }
      ensure(await absence('worker'), 'WORKER_ABSENCE_REQUIRED_BEFORE_FENCE_DELETE');
      if (!native.effects['delete-fence']) {
        const fence = await request(bucketPath + '/objects/binding-check/run-claim', 'GET', undefined, true); ensure(fence.status === 200 && hash(fence.bytes) === native.retainedFenceDigest, 'EXACT_FENCE_BYTES_REQUIRED');
        await dispatchOnce(native.effects, 'delete-fence', save, async () => { const result = await request(bucketPath + '/objects/binding-check/run-claim', 'DELETE', undefined, true); ensure(result.status >= 200 && result.status < 300, 'FENCE_DELETE_UNACKNOWLEDGED'); return { key: 'binding-check/run-claim' }; });
      }
      if (!native.effects['delete-bucket']) {
        const exists = await request(bucketPath); ensure(exists.status === 200 && exists.body?.success === true && exists.body.result.name === journal.bucketName, 'EXACT_BUCKET_REQUIRED');
        const fence = await request(bucketPath + '/objects/binding-check/run-claim', 'GET', undefined, true); ensure(fence.status === 404, 'FENCE_ABSENCE_REQUIRED');
        // The complete fenced inventory had exactly one key; the Worker is now
        // absent and that exact key is absent. No force-empty operation is used.
        await dispatchOnce(native.effects, 'delete-bucket', save, async () => { const result = await request(bucketPath, 'DELETE'); ensure(result.status >= 200 && result.status < 300 && (!result.body || result.body.success === true), 'R2_DELETE_UNACKNOWLEDGED'); return { acknowledged: true, emptyFencedInventory: true }; });
      }
      ensure(await absence('bucket'), 'EXACT_R2_ABSENCE_UNVERIFIED'); native.status = 'RETIRED_NATIVE_ABSENCE_PASS';
    }
    ensure((await sourceIdentity()).digest === journal.sourceSetDigest, 'SOURCE_INPUTS_CHANGED');
    native.completedAt = new Date().toISOString(); await save();
  } catch (error) {
    const reason = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'NATIVE_OPERATION_UNCONFIRMED';
    if (native) { native.reason = reason; native.status = Object.values(native.effects).some(effect => effect.phase !== 'ACKNOWLEDGED') ? 'RECONCILIATION_REQUIRED' : 'FAIL'; native.completedAt = new Date().toISOString(); await save(); }
    else return { status: 'FAIL', reason };
  } finally { if (lock) { await lock.close(); await rm(lockPath, { force: true }); } }
  return { status: native!.status, reason: native!.reason, runId: native!.runId, endpoint: journal?.endpoint, nativeJournalPath: nativePath };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const report = await main(); process.stdout.write(JSON.stringify(report) + '\n'); if (report.status === 'FAIL' || report.status === 'RECONCILIATION_REQUIRED') process.exitCode = 1; }
  catch { process.stderr.write('SANITIZED_NATIVE_OPERATOR_FAILURE\n'); process.exitCode = 1; }
}
