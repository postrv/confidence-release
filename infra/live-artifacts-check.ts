// SPDX-License-Identifier: Apache-2.0
// Preparation/packaging are local. Native provisioning/deployment is performed
// separately by live-artifacts-operator.ts against this exact owned journal.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalize } from '../packages/protocol/src/index.ts';
import { privateWranglerEnvironment } from '../scripts/provider-preflight.ts';
import { ARTIFACTS_BINDING_CHECKS, ARTIFACTS_BINDING_SOURCES } from '../scripts/artifacts-binding-evidence.ts';
import type { BindingJournal, BindingSnapshot } from './live-artifacts/types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = resolve(root, 'infra/live-artifacts');
const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const ensure = (value: unknown, reason: string): void => { if (!value) throw new Error(reason); };
export async function atomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { const file = await open(temporary, 'wx', 0o600); try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); } await rename(temporary, path); const parent = await open(dirname(path), 'r'); try { await parent.sync(); } finally { await parent.close(); } }
  finally { await rm(temporary, { force: true }); }
}
export function ownedJournal(journal: BindingJournal): boolean {
  try {
    const id = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(journal.runId) ? journal.runId.replaceAll('-', '').slice(0, 20) : '';
    const home = resolve(directory, '.runs', journal.runId);
    return journal.schemaVersion === 1 && !!id && /^[a-f0-9]{32}$/.test(journal.accountId) && /^[A-Za-z0-9][A-Za-z0-9_.-]{1,62}$/.test(journal.namespace)
      && journal.workerName === `confidence-artifacts-${id}` && journal.bucketName === journal.workerName && journal.canonicalName === `confidence-binding-${id}`
      && journal.attemptId === `binding-${id}` && journal.attemptName === `attempt-${journal.attemptId}` && Number.isSafeInteger(journal.expiresAt)
      && journal.configPath === resolve(home, 'wrangler.json') && journal.secretsPath === resolve(home, 'worker.secrets.json')
      && /^sha256:[a-f0-9]{64}$/.test(journal.configDigest) && /^sha256:[a-f0-9]{64}$/.test(journal.secretsDigest)
      && journal.sourceSetDigest === hash(canonicalize(journal.sourceDigests))
      && [journal.run, journal.cleanup].every(phase => ['NOT_DISPATCHED', 'MAY_HAVE_DISPATCHED', 'ACKNOWLEDGED', 'UNKNOWN'].includes(phase));
  } catch { return false; }
}
export function validEndpoint(endpoint: string, workerName: string): boolean {
  try { const url = new URL(endpoint); return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash && url.pathname === '/' && url.hostname.startsWith(workerName + '.') && /^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname); } catch { return false; }
}
export function verifiedNativeIdentity(proof: Record<string, unknown> | undefined, journal: BindingJournal, now = Date.now()): boolean {
  try {
    const observed = typeof proof?.observedAt === 'string' ? Date.parse(proof.observedAt) : NaN;
    return !!proof && proof.runId === journal.runId && proof.accountId === journal.accountId && proof.namespace === journal.namespace
      && proof.sourceSetDigest === journal.sourceSetDigest && proof.configDigest === journal.configDigest
      && proof.workerName === journal.workerName && proof.bucketName === journal.bucketName
      && proof.deployedModulesExact === true && proof.deployedBindingsExact === true && !!journal.bundleDigests
      && canonicalize(proof.bundleDigests) === canonicalize(journal.bundleDigests)
      && Number.isFinite(observed) && observed >= journal.expiresAt - 20 * 60 * 1000 && observed <= journal.expiresAt && observed <= now;
  } catch { return false; }
}
export function preRunReadiness(control: unknown, journal: BindingJournal, proof: Record<string, unknown> | undefined, now = Date.now()) {
  ensure(!!control && typeof control === 'object' && !Array.isArray(control), 'PRE_RUN_RESPONSE_SCHEMA');
  const status = control as Record<string, unknown>;
  ensure(Object.keys(status).length === 3 && ['status', 'runId', 'sourceSetDigest'].every(key => Object.hasOwn(status, key)) && status.status === 'NOT_STARTED', 'PRE_RUN_RESPONSE_SCHEMA');
  ensure(status.runId === journal.runId && status.sourceSetDigest === journal.sourceSetDigest, 'PRE_RUN_RESPONSE_ASSOCIATION');
  if (journal.run !== 'NOT_DISPATCHED' || journal.cleanup !== 'NOT_DISPATCHED') {
    return { status: 'RECONCILIATION_REQUIRED', reason: 'CONTROL_NOT_STARTED_AFTER_DISPATCH', providerGatePassed: false, checks: [], controlStatus: status };
  }
  const verifiedNative = verifiedNativeIdentity(proof, journal, now);
  return { status: verifiedNative ? 'PRE_RUN_READY' : 'FAIL', ...(verifiedNative ? {} : { reason: 'NATIVE_IDENTITY_REQUIRED' }), providerGatePassed: false,
    checks: [{ name: 'pre-run-control-and-native-identity', status: verifiedNative ? 'PASS' : 'FAIL', detail: { authenticatedControl: true, exactAccountAndRun: verifiedNative } }],
    controlStatus: status, nativeIdentity: proof ?? null };
}
export async function sourceIdentity() {
  const digests = Object.fromEntries(await Promise.all(ARTIFACTS_BINDING_SOURCES.map(async path => [path, hash(await readFile(resolve(root, path)))])));
  return { digests, digest: hash(canonicalize(digests)) };
}
export async function bundleIdentity(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (dir: string) => { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = resolve(dir, entry.name); if (entry.isDirectory()) await walk(file); else if (entry.isFile() && /\.(js|wasm)$/.test(file)) result[file.slice(path.length + 1)] = hash(await readFile(file)); } };
  await walk(path); ensure(Object.keys(result).some(path => path.endsWith('.js')) && Object.keys(result).some(path => path.endsWith('.wasm')), 'COMPLETE_WORKER_BUNDLE_REQUIRED'); return result;
}
async function readSnapshot(response: Response): Promise<unknown> {
  const reader = response.body?.getReader(); ensure(reader, 'SNAPSHOT_BODY_REQUIRED'); const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const next = await reader!.read(); if (next.done) break; length += next.value.length; ensure(length <= 256 * 1024, 'SNAPSHOT_BOUND'); chunks.push(next.value); } } finally { await reader!.cancel().catch(() => {}); reader!.releaseLock(); }
  ensure(response.ok, `CONTROL_HTTP_${response.status}`); return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export async function main(args = process.argv.slice(2)): Promise<unknown> {
  const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const modes = ['--prepare', '--package', '--run', '--reconcile', '--cleanup'].filter(flag => args.includes(flag));
  ensure(modes.length <= 1 && args.every(arg => !arg.startsWith('--') || [...modes, '--account', '--namespace', '--journal', '--endpoint', '--out'].includes(arg)), 'CLOSED_COMMAND_LINE');
  const mode = modes[0], out = resolve(value('--out') ?? resolve(directory, '.runs/report.json'));
  const identity = await sourceIdentity();
  const report: Record<string, any> = { schemaVersion: 1, status: 'BLOCKED', providerGatePassed: false, sourceDigests: identity.digests, sourceSetDigest: identity.digest, checks: [], limitations: [
    'This finite inert run uses the unchanged production ArtifactsRepository and real Artifacts/R2 bindings. It is not a ProjectAuthority/OIDC/Sandbox/model run or a portable publication receipt.',
    'An initial seed uses raw fixed-zero Git receive-pack solely to establish the owned baseline; subsequent publication, fork, ingest and work-ref operations use the production adapter.',
    'Native Worker/R2 provisioning, deployed-module identity and retirement are recorded separately by the operator. Metadata absence does not establish physical reclamation.',
    'Uncertain or active control requests are reconciled by observation and never automatically repeated. Incomplete cleanup can require exact native operator cleanup.',
  ] };
  let journal: BindingJournal | undefined, journalPath: string | undefined;
  let lock: Awaited<ReturnType<typeof open>> | undefined, lockPath: string | undefined;
  try {
    if (!mode) { await atomic(out, report); return report; }
    if (mode === '--prepare') {
      const accountId = value('--account') ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? '', namespace = value('--namespace') ?? '';
      ensure(/^[a-f0-9]{32}$/.test(accountId) && /^[A-Za-z0-9][A-Za-z0-9_.-]{1,62}$/.test(namespace), 'ACCOUNT_AND_NAMESPACE_REQUIRED');
      const runId = randomUUID(), id = runId.replaceAll('-', '').slice(0, 20), home = resolve(directory, '.runs', runId);
      const workerName = `confidence-artifacts-${id}`, canonicalName = `confidence-binding-${id}`, attemptId = `binding-${id}`, expiresAt = Date.now() + 20 * 60 * 1000;
      const secrets = { CONTROL_TOKEN: randomBytes(32).toString('hex') }, configPath = resolve(home, 'wrangler.json'), secretsPath = resolve(home, 'worker.secrets.json');
      const production = JSON.parse(await readFile(resolve(root, 'workers/authority/wrangler.jsonc'), 'utf8')) as { compatibility_date: string; compatibility_flags: string[]; rules: unknown[] };
      ensure(/^\d{4}-\d{2}-\d{2}$/.test(production.compatibility_date) && Array.isArray(production.compatibility_flags) && Array.isArray(production.rules), 'PRODUCTION_RUNTIME_PROFILE_REQUIRED');
      const config = { $schema: resolve(root, 'node_modules/wrangler/config-schema.json'), name: workerName, account_id: accountId, main: resolve(directory, 'worker.ts'), compatibility_date: production.compatibility_date, compatibility_flags: production.compatibility_flags, rules: production.rules, workers_dev: true, preview_urls: false,
        observability: { enabled: false }, artifacts: [{ binding: 'ARTIFACTS', namespace }], r2_buckets: [{ binding: 'OBJECTS', bucket_name: workerName }],
        vars: { RUN_ID: runId, ACCOUNT_ID: accountId, NAMESPACE: namespace, SOURCE_SET_DIGEST: identity.digest, EXPIRES_AT: String(expiresAt), CANONICAL_NAME: canonicalName, ATTEMPT_ID: attemptId }, secrets: { required: ['CONTROL_TOKEN'] } };
      await atomic(configPath, config); await atomic(secretsPath, secrets);
      let sourceRevision: string | null = null, sourceDirty: boolean | null = null;
      try { sourceRevision = (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 5000 })).stdout.trim(); sourceDirty = !!(await promisify(execFile)('git', ['status', '--porcelain'], { cwd: root, timeout: 5000 })).stdout.trim(); } catch {}
      journal = { schemaVersion: 1, runId, accountId, namespace, workerName, bucketName: workerName, canonicalName, attemptId, attemptName: `attempt-${attemptId}`, expiresAt, sourceSetDigest: identity.digest, sourceDigests: identity.digests, sourceRevision, sourceDirty,
        configPath, configDigest: hash(await readFile(configPath)), secretsPath, secretsDigest: hash(await readFile(secretsPath)), run: 'NOT_DISPATCHED', cleanup: 'NOT_DISPATCHED' };
      journalPath = resolve(home, 'journal.json'); await atomic(journalPath, journal); report.status = 'PREPARED'; report.journalPath = journalPath; report.workerName = workerName; report.bucketName = workerName;
    } else {
      journalPath = resolve(value('--journal') ?? ''); ensure(value('--journal'), 'OWNED_JOURNAL_REQUIRED');
      lockPath = `${journalPath}.lock`;
      try { lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); await lock.sync(); } catch { throw new Error('JOURNAL_LOCKED_INSPECT_BEFORE_RETRY'); }
      journal = JSON.parse(await readFile(journalPath, 'utf8')) as BindingJournal;
      ensure(ownedJournal(journal), 'OWNED_JOURNAL_REQUIRED'); ensure(identity.digest === journal.sourceSetDigest, 'SOURCE_INPUTS_CHANGED');
      ensure(hash(await readFile(journal.configPath)) === journal.configDigest && hash(await readFile(journal.secretsPath)) === journal.secretsDigest && ((await stat(journal.secretsPath)).mode & 0o077) === 0, 'PRIVATE_INPUT_ASSOCIATION');
      report.accountId = journal.accountId; report.namespace = journal.namespace; report.sourceRevision = journal.sourceRevision; report.sourceDirty = journal.sourceDirty; report.runId = journal.runId;
      report.expiresAt = journal.expiresAt; report.configDigest = journal.configDigest; report.workerName = journal.workerName; report.bucketName = journal.bucketName;
      if (mode === '--package') {
        const bundle = resolve(dirname(journal.configPath), 'bundle');
        await promisify(execFile)(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', '--dry-run', '--config', journal.configPath, '--outdir', bundle], { cwd: root, env: privateWranglerEnvironment(process.env), timeout: 120000, maxBuffer: 1024 * 1024 });
        journal.bundleDigests = await bundleIdentity(bundle); report.status = 'LOCAL_PACKAGE_PASS'; report.bundleDigests = journal.bundleDigests; await atomic(journalPath, journal);
      } else {
        ensure(Date.now() < journal.expiresAt, 'CONTROL_EXPIRED'); ensure(journal.bundleDigests && canonicalize(await bundleIdentity(resolve(dirname(journal.configPath), 'bundle'))) === canonicalize(journal.bundleDigests), 'PACKAGED_BYTES_CHANGED');
        const endpoint = value('--endpoint') ?? journal.endpoint ?? ''; ensure(validEndpoint(endpoint, journal.workerName), 'EXACT_WORKER_ENDPOINT_REQUIRED');
        ensure(!journal.endpoint || journal.endpoint === endpoint, 'ENDPOINT_CHANGED'); journal.endpoint = endpoint;
        const secret = JSON.parse(await readFile(journal.secretsPath, 'utf8')) as { CONTROL_TOKEN: string }; ensure(/^[a-f0-9]{64}$/.test(secret.CONTROL_TOKEN), 'CONTROL_SECRET_SCHEMA');
        const phase = mode === '--run' ? 'run' : mode === '--cleanup' ? 'cleanup' : null;
        if (phase) { ensure(journal[phase] === 'NOT_DISPATCHED', 'RECONCILE_BEFORE_RETRY'); journal[phase] = 'MAY_HAVE_DISPATCHED'; await atomic(journalPath, journal); }
        const route = mode === '--run' ? '/run' : mode === '--cleanup' ? '/cleanup' : journal.cleanup !== 'NOT_DISPATCHED' ? '/reconcile' : '/status';
        try {
          const observation = await readSnapshot(await fetch(new URL(route, endpoint), { method: phase ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(120000), headers: { authorization: `Bearer ${secret.CONTROL_TOKEN}` } }));
          if (mode === '--reconcile' && route === '/status' && !!observation && typeof observation === 'object' && (observation as { status?: unknown }).status === 'NOT_STARTED') {
            const fresh = await sourceIdentity(); ensure(fresh.digest === journal.sourceSetDigest, 'SOURCE_INPUTS_CHANGED');
            const native = JSON.parse(await readFile(resolve(dirname(journalPath), 'native-operator.json'), 'utf8')) as { identity?: Record<string, unknown> };
            Object.assign(report, preRunReadiness(observation, journal, native.identity)); report.bundleDigests = journal.bundleDigests;
          } else {
            const snapshot = observation as BindingSnapshot;
            ensure(snapshot?.schemaVersion === 1 && snapshot.runId === journal.runId && snapshot.accountId === journal.accountId && snapshot.namespace === journal.namespace && snapshot.sourceSetDigest === journal.sourceSetDigest && snapshot.canonicalName === journal.canonicalName && snapshot.attemptName === journal.attemptName, 'WORKER_SNAPSHOT_ASSOCIATION');
            if (phase) journal[phase] = 'ACKNOWLEDGED'; journal.snapshot = snapshot; await atomic(journalPath, journal);
            const fresh = await sourceIdentity(); ensure(fresh.digest === journal.sourceSetDigest, 'SOURCE_INPUTS_CHANGED');
            report.checks = [...snapshot.checks]; report.snapshot = snapshot; report.bundleDigests = journal.bundleDigests;
            const native = JSON.parse(await readFile(resolve(dirname(journalPath), 'native-operator.json'), 'utf8')) as { identity?: Record<string, unknown> };
            const proof = native.identity, verifiedNative = verifiedNativeIdentity(proof, journal);
            report.nativeIdentity = proof;
            report.checks.push({ name: 'native-deployed-modules-and-bindings', status: verifiedNative ? 'PASS' : 'FAIL', detail: { observedAt: proof?.observedAt ?? null, exactAccountAndRun: verifiedNative } });
            const counts = new Map<string, number>(); for (const check of report.checks) counts.set(check.name, (counts.get(check.name) ?? 0) + 1);
            report.providerGatePassed = snapshot.status === 'PASS' && snapshot.cleanupComplete && report.checks.every((check: { status: string }) => check.status === 'PASS') && ARTIFACTS_BINDING_CHECKS.every(name => counts.get(name) === 1);
            report.status = report.providerGatePassed ? 'PASS' : snapshot.status === 'FAIL' ? 'FAIL' : 'RECONCILIATION_REQUIRED';
          }
        } catch (error) { if (phase) { journal[phase] = 'UNKNOWN'; await atomic(journalPath, journal); } throw error; }
      }
    }
  } catch (error) { report.status = 'FAIL'; report.reason = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'OPERATION_UNCONFIRMED'; }
  finally { if (lock) { await lock.close(); await rm(lockPath!, { force: true }); } }
  report.completedAt = new Date().toISOString(); await atomic(out, report); return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await main() as Record<string, unknown>;
  process.stdout.write(JSON.stringify({ status: report.status, providerGatePassed: report.providerGatePassed, reason: report.reason, journalPath: report.journalPath, workerName: report.workerName, bucketName: report.bucketName }) + '\n');
  if (report.status === 'FAIL' || report.status === 'RECONCILIATION_REQUIRED') process.exitCode = 1;
}
