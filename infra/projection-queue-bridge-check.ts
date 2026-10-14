// SPDX-License-Identifier: Apache-2.0
// Local workerd bridge: production authority replay outbox -> Miniflare Queue
// broker -> unchanged projector -> actual local D1. Never deploy this fixture.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { canonicalize, digest, sha256 } from '../packages/protocol/src/index';
import type { ProjectionEvent } from '../workers/authority/types';

type Source = {
  failedEvent?: string;
  project: { revision: string };
  originals: { event: ProjectionEvent; state: string }[];
  tasks: { id: string; state: string }[];
  sent: ProjectionEvent[];
};
type View = {
  inbox: { id: string; digest: string }[];
  events: { project_key: string; sequence: number; event_id: string; kind: string; object_id: string; payload: string }[];
  watermarks: { project_key: string; sequence: number }[];
};

const directory = await mkdtemp(join(tmpdir(), 'confidence-projection-queue-bridge-'));
const bundle = join(directory, 'bundle');
await mkdir(bundle);
const reportPath = resolve(process.env.PROJECTION_BRIDGE_REPORT || 'demo-output/projection-queue-bridge.json');
let runtime: Miniflare | undefined;
try {
  await promisify(execFile)(resolve('node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--config', 'infra/test-projector/wrangler.jsonc', '--outdir', bundle], {
    cwd: resolve('.'), timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  const scripts = (await readdir(bundle)).filter(name => name.endsWith('.js'));
  assert.equal(scripts.length, 1);
  const queueName = 'owned-projection-queue-bridge';
  runtime = new Miniflare(convertV4MiniflareOptions({
    name: 'owned-projection-queue-bridge', modulesRoot: bundle,
    modules: [{ type: 'ESModule', path: join(bundle, scripts[0]) }, ...(await readdir(bundle)).filter(name => name.endsWith('.wasm')).map(name => ({ type: 'CompiledWasm' as const, path: join(bundle, name) }))],
    compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { PROJECTS: { className: 'ProjectionAuthority', useSQLite: true } },
    serviceBindings: { AUTHORITY: 'owned-projection-queue-bridge' },
    r2Buckets: { OBJECTS: 'owned-projection-queue-bridge-objects' },
    d1Databases: { DB: 'owned-projection-queue-bridge-db' },
    queueProducers: { EVENTS: queueName },
    queueConsumers: { [queueName]: { maxBatchSize: 32, maxBatchTimeout: 0, maxRetries: 10, deadLetterQueue: queueName + '-dlq' } },
    bindings: {
      NATIVE_QUEUE_BRIDGE: 'true', AUTH_TENANT_ID: 'owned-test-tenant', MAINTENANCE_MODE: 'false',
      PROJECTOR_SERVICE_TOKEN: 'owned-projector-token-not-a-secret-0001',
      APP_SERVICE_TOKEN: 'owned-app-token-not-a-secret-000000001',
      RUNNER_SERVICE_TOKEN: 'owned-runner-token-not-a-secret-00001',
      EVALUATOR_SERVICE_TOKEN: 'owned-evaluator-token-not-a-secret-01',
    },
    log: new Log(LogLevel.ERROR),
  }));
  await runtime.ready;
  const migration = await readFile(resolve('migrations/0001_projection.sql'), 'utf8');
  const db = await runtime.getD1Database('DB');
  await db.exec(migration.split('\n').filter(line => line.trim() && !line.trimStart().startsWith('--')).join('\n'));
  const scope = { schemaVersion: 1, tenantId: 'owned-test-tenant', projectId: 'owned-queue-bridge', projectIncarnation: 'incarnation-one' };
  const projectKey = `${scope.tenantId}/${scope.projectId}/${scope.projectIncarnation}`;
  const post = async <T>(path: string, body: unknown): Promise<{ status: number; body: T }> => {
    const response = await runtime!.dispatchFetch('http://owned.test' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as T };
  };
  const fixture = async <T>(path: string, body: Record<string, unknown> = {}): Promise<T> => {
    const response = await post<T>('/fixture/' + path, { scope, ...body });
    assert.equal(response.status, 200, `${path} failed`);
    return response.body;
  };
  const view = async (): Promise<View> => {
    const response = await runtime!.dispatchFetch('http://owned.test/inspect');
    assert.equal(response.status, 200);
    return response.json() as Promise<View>;
  };
  const exact = (actual: View, originals: Source['originals']): boolean =>
    actual.inbox.length === originals.length && actual.events.length === originals.length &&
    actual.watermarks.length === 1 && actual.watermarks[0].project_key === projectKey && actual.watermarks[0].sequence === originals.length &&
    originals.every(({ event }) => actual.inbox.filter(row => row.id === event.id && row.digest === event.digest).length === 1 &&
      actual.events.filter(row => row.project_key === projectKey && row.sequence === event.sequence && row.event_id === event.id && row.kind === event.kind && row.object_id === event.objectId && row.payload === canonicalize(event.payload)).length === 1);
  const wait = async (predicate: () => Promise<boolean>): Promise<void> => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('LOCAL_QUEUE_DELIVERY_WINDOW_EXPIRED');
  };

  const seeded = await fixture<Source>('seed', { count: 5, large: false });
  assert.equal(seeded.originals.length, 5);
  const queue = await runtime.getQueueProducer<ProjectionEvent>('EVENTS');
  await queue.send(seeded.originals[4].event);
  await wait(async () => exact(await view(), seeded.originals));
  await wait(async () => (await queue.metrics()).backlogCount === 0);
  const gapView = await view();
  assert(exact(gapView, seeded.originals));

  // The local broker has drained. Erase only this disposable view, then use a
  // real human-admin replay command and the authority's retained originals.
  await db.batch(['DELETE FROM watermarks', 'DELETE FROM events', 'DELETE FROM inbox'].map(sql => db.prepare(sql)));
  assert.deepEqual(await view(), { inbox: [], events: [], watermarks: [] });
  const caller = { principal: { id: 'owned-human', tenantId: scope.tenantId, credentialClass: 'human' }, projectId: scope.projectId };
  const request = { scope, caller, command: { commandId: 'owned-queue-bridge-replay', expectedRevision: seeded.project.revision, operation: 'replay-projection', body: { scope, afterSequence: 0, throughSequence: 5, replayId: null } } };
  await fixture('fail-next-send');
  const replay = await post<{ delivery: string; queuedEventIds: string[]; complete: boolean }>('/fixture/command', request);
  assert.equal(replay.status, 202, JSON.stringify(replay.body));
  assert.equal(replay.body.delivery, 'QUEUED');
  assert.deepEqual(replay.body.queuedEventIds, seeded.originals.map(item => item.event.id));
  assert(replay.body.complete);
  await wait(async () => Boolean((await fixture<Source>('inspect')).failedEvent));
  let source = await fixture<Source>('inspect');
  assert(source.failedEvent && replay.body.queuedEventIds.includes(source.failedEvent));
  for (let attempt = 0; attempt < 20 && (source.tasks.some(task => task.state === 'PENDING') || source.originals.some(item => item.state === 'PENDING') || source.sent.filter(event => event.id === source.failedEvent).length < 2); attempt++) source = await fixture<Source>('pump');
  assert(source.tasks.every(task => task.state === 'DELIVERED'));
  assert(source.originals.every(item => item.state === 'DELIVERED'));
  await wait(async () => exact(await view(), (await fixture<Source>('inspect')).originals));
  await wait(async () => (await queue.metrics()).backlogCount === 0);
  source = await fixture<Source>('inspect');
  const finalView = await view();
  assert(exact(finalView, source.originals));
  const duplicateSends = source.sent.filter(event => event.id === source.failedEvent);
  assert(duplicateSends.length >= 2);
  assert(duplicateSends.every(event => canonicalize(event) === canonicalize(duplicateSends[0])));
  assert.equal(finalView.inbox.filter(row => row.id === source.failedEvent).length, 1);

  const denied = await post<unknown>('/fixture/command', { ...request, caller: { ...caller, principal: { ...caller.principal, credentialClass: 'service' } }, command: { ...request.command, commandId: 'owned-queue-bridge-denied', expectedRevision: source.project.revision } });
  assert.equal(denied.status, 403);
  assert.deepEqual((await fixture<Source>('inspect')).tasks.map(task => task.id), source.tasks.map(task => task.id), 'A denied service caller must not queue replay tasks');

  const testedInputs = Object.fromEntries(await Promise.all([
    'workers/authority/index.ts', 'workers/projector/index.ts', 'infra/test-projector/worker.ts',
    'infra/projection-queue-bridge-check.ts', 'migrations/0001_projection.sql',
  ].map(async path => [path, await sha256(await readFile(resolve(path)))])));
  const report = {
    schemaVersion: 1, status: 'PASS', runtime: 'Local Miniflare/workerd Queue broker, authority Durable Object, unchanged projector and D1',
    checks: ['Queue gap fetched retained authority originals and projected the exact five-row prefix', 'Human-admin replay sent five fixed original identities through the authority outbox and Queue into the erased view', 'Lost send response repeated one original message identity without a duplicate D1 row', 'Non-human replay was denied without adding replay tasks'],
    initialSourceDigest: await digest(seeded.originals), finalSourceDigest: await digest(source.originals),
    gapViewDigest: await digest(gapView), finalViewDigest: await digest(finalView),
    retainedOriginals: source.originals.length, duplicateSendCount: duplicateSends.length, failedEventId: source.failedEvent,
    testedInputs, bundledWorkerDigest: await sha256(await readFile(join(bundle, scripts[0]))),
    limitations: ['All events, identity and permissions are synthetic owned local fixtures.', 'The Queue broker is local Miniflare, not native Cloudflare delivery; dead-letter routing and backlog soak are untested.', 'The disposable D1 erase is local and is performed only after observed local Queue drain; this is not a production maintenance procedure.'],
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ status: 'PASS', checks: report.checks.length, retainedOriginals: source.originals.length, duplicateSendCount: duplicateSends.length, report: reportPath }) + '\n');
} finally {
  if (runtime) await runtime.dispose();
  await rm(directory, { recursive: true, force: true });
}
