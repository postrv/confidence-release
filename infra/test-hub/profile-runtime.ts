// SPDX-License-Identifier: Apache-2.0
// Separate local qualification: actual generated two-Worker profile, fresh SQLite and R2.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions, type V4WorkerOptions } from 'miniflare';
import { collaborationConfigurations } from '../collaboration-development.ts';
import { PINNED_WEFT_DEPENDENCY } from '../../packages/protocol/src/dependencies.ts';
import type { ProjectSummary } from '../../packages/project-model/src/types.ts';
import type { CollaborationView, ProjectJoinRequest } from '../../packages/protocol/src/collaboration.ts';
import type { HubMessage } from '../../packages/protocol/src/project-hub.ts';

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const run = promisify(execFile);
type ApiError = { error: { code: string } };
function responseObject(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON response object');
  return value as Record<string, unknown>;
}

export async function checkCollaborationProfile() {
  assert.ok(process.env.WEFT_DEPENDENCY_BUNDLE, 'WEFT_DEPENDENCY_BUNDLE is required for this separate qualification; missing authorized source must not skip.');
  const dependency = await readFile(process.env.WEFT_DEPENDENCY_BUNDLE);
  assert.equal(dependency.length, PINNED_WEFT_DEPENDENCY.bundle.bytes);
  assert.equal(hash(dependency), PINNED_WEFT_DEPENDENCY.bundle.sha256);
  const root = resolve('.'), directory = await mkdtemp(join(tmpdir(), 'confidence-hub-profile-'));
  const configurations = collaborationConfigurations(root, {
    accountId: 'a'.repeat(32), prefix: 'confidence-collab-dev-owned', workersDevSubdomain: 'owned',
    objectBucket: 'confidence-collab-dev-owned-objects', issuer: 'https://owned.cloudflareaccess.com', audience: 'b'.repeat(64), maintenance: false,
  });
  const app = configurations.app, authority = configurations.authority;
  const origin = app.vars.APP_ORIGIN as string, issuer = app.vars.AUTH_ISSUER as string;
  const serviceToken = randomBytes(32).toString('hex'), secretPath = join(directory, 'secrets.json');
  const pair = await generateKeyPair('ES256', { extractable: true }), kid = 'owned-profile-human';
  const jwk = { ...await exportJWK(pair.publicKey), kid, alg: 'ES256', use: 'sig' };
  const bundleDigests: Record<string, string> = {}, checks: string[] = [];
  const cases: { path: string; status: number }[] = [], outbound: string[] = [];
  const sourcePaths = ['infra/collaboration-development.ts', 'infra/test-hub/profile-runtime.ts',
    'workers/collaboration-only/app.ts', 'workers/collaboration-only/authority.ts', 'workers/collaboration-only/profile.ts',
    'workers/app/index.ts', 'workers/app/hub-routes.ts', 'workers/shared/auth.ts', 'workers/authority/index.ts',
    'workers/authority/project-catalog.ts', 'workers/authority/project-directory.ts', 'workers/authority/collaboration.ts',
    'workers/authority/project-hub.ts', 'workers/authority/pinned-dependency.ts'];
  const sourceDigests = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, hash(await readFile(resolve(root, path)))])));
  let runtime: Miniflare | undefined;
  let failure: string | undefined;
  try {
    await writeFile(secretPath, JSON.stringify({ APP_SERVICE_TOKEN: serviceToken }), { mode: 0o600 });
    const workers: V4WorkerOptions[] = [];
    for (const role of ['app', 'authority'] as const) {
      const config = configurations[role], configPath = join(directory, `${role}.json`), output = join(directory, role);
      await mkdir(output); await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      await run(resolve(root, 'node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--config', configPath, '--secrets-file', secretPath, '--outdir', output],
        { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      const files = await readdir(output), scripts = files.filter(file => file.endsWith('.js')); assert.equal(scripts.length, 1);
      for (const file of files.filter(file => /\.(js|wasm)$/.test(file))) bundleDigests[`${role}/${file}`] = hash(await readFile(join(output, file)));
      const worker: V4WorkerOptions = {
        name: config.name, modulesRoot: output,
        modules: [{ type: 'ESModule', path: join(output, scripts[0]!) }, ...files.filter(file => file.endsWith('.wasm')).map(file => ({ type: 'CompiledWasm' as const, path: join(output, file) }))],
        compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
        bindings: { ...config.vars, APP_SERVICE_TOKEN: serviceToken },
        outboundService: request => {
          outbound.push(request.url);
          assert.equal(request.url, app.vars.AUTH_JWKS_URL, 'Only the owned signing-key fixture may use outbound transport');
          assert.equal(request.method, 'GET'); return Response.json({ keys: [jwk] });
        },
      };
      if (role === 'app') {
        assert.deepEqual(config.services, [{ binding: 'AUTHORITY', service: authority.name }]);
        worker.serviceBindings = { AUTHORITY: authority.name, ASSETS: () => new Response('Owned static asset fixture') };
      } else {
        worker.durableObjects = Object.fromEntries(config.durable_objects.bindings.map((binding: { name: string; class_name: string }) => [binding.name, { className: binding.class_name, useSQLite: true }]));
        worker.r2Buckets = Object.fromEntries(config.r2_buckets.map((bucket: { binding: string; bucket_name: string }) => [bucket.binding, bucket.bucket_name]));
        assert.deepEqual(JSON.parse(config.vars.BOOTSTRAP_SUBJECTS), []);
        for (const omitted of ['ARTIFACTS', 'EVALUATOR', 'RUNNER', 'ROOT_SIGNING_KEY', 'AUTHORITY_SIGNING_KEY', 'CHECKER_PUBLIC_KEY']) assert.equal(omitted in worker.bindings!, false);
      }
      workers.push(worker);
    }
    const options = convertV4MiniflareOptions({ workers, resourcePersistencePath: join(directory, 'persist'), log: new Log(LogLevel.ERROR) });
    runtime = new Miniflare(options); await runtime.ready;
    checks.push('Exact generated app/authority wrappers packaged and run as separate Workers with only declared vars, one private service credential, assets, two Durable Object namespaces and R2; no source/evaluation/signing services or bootstrap subjects');
    const identity = (subject: string) => issuer + '#' + subject;
    const tokens = new Map<string, string>();
    for (const subject of ['alice', 'bob', 'stranger']) {
      const now = Math.floor(Date.now() / 1000);
      tokens.set(subject, await new SignJWT({ iss: issuer, aud: app.vars.AUTH_AUDIENCE, sub: subject, type: 'app', email: subject + '.owned@example.test', iat: now - 1, exp: now + 3600 })
        .setProtectedHeader({ alg: 'ES256', kid }).sign(pair.privateKey));
    }
    async function human<T = Record<string, unknown>>(subject: string, path: string, status = 200, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
      const response = await runtime!.dispatchFetch(origin + path, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: {
        'cf-access-jwt-assertion': tokens.get(subject)!, ...(body === undefined ? {} : { origin, 'content-type': 'application/json', 'x-platform-csrf': '1' }), ...extra,
      } });
      const result = responseObject(await response.json()); cases.push({ path, status: response.status });
      assert.equal(response.status, status, JSON.stringify(result)); return result as T;
    }
    assert.equal((await human('alice', '/api/session')).deploymentProfile, 'collaboration-only');
    assert.deepEqual((await human('alice', '/api/projects')).projects, []);
    const project = await human<ProjectSummary>('alice', '/api/projects', 201, { name: 'Owned deployment profile project' }, { 'idempotency-key': 'profile-create' });
    const projectPath = '/api/projects/' + project.projectId;
    assert.equal(project.capabilities.nativeWorkflow, false); assert.equal(project.capabilities.publication, false);
    assert.deepEqual(project.source, { status: 'EMPTY' });
    const contextHeaders = (subject: string) => ({ 'if-platform-principal': identity(subject), 'if-platform-incarnation': project.projectIncarnation });
    async function collaboration(operation: string, body: unknown) {
      const view = await human<CollaborationView>('alice', projectPath + '/collaboration');
      return human('alice', projectPath + '/collaboration/' + operation, 202, body,
        { ...contextHeaders('alice'), 'idempotency-key': 'profile-' + operation + '-' + view.revision, 'if-platform-revision': view.revision });
    }
    await collaboration('enable-collaboration', {});
    const enabled = await human<CollaborationView>('alice', projectPath + '/collaboration');
    assert.equal(enabled.members[0].role, 'owner'); assert.equal(enabled.members[0].additionalReview, undefined);
    checks.push('Fresh signed human creates a generic project and establishes owner membership through normal catalog/collaboration commands, with no native evaluation enrollment');
    const joinRequest = await human<ProjectJoinRequest>('bob', projectPath + '/join-requests', 202, {}, { ...contextHeaders('bob'), 'idempotency-key': 'bob-request' });
    assert.equal(joinRequest.verifiedEmail, 'bob.owned@example.test');
    assert.deepEqual((await human('alice', projectPath + '/join-requests')).requests, [joinRequest]);
    assert.deepEqual((await human('stranger', projectPath + '/join-requests')).requests, []);
    await human('bob', projectPath, 404);
    await collaboration('admit-join-request', { requestId: joinRequest.id });
    assert.equal((await human<ProjectSummary>('bob', projectPath)).permissions?.manage, false);
    checks.push('Project link request preserves signed email for owner review and admits the second human only after explicit fixed-maintainer admission');
    const instruction = await human('alice', projectPath + '/hub/messages', 202,
      { requestId: 'alice-instruction', kind: 'instruction', text: 'Acquire the pinned dependency and report in this discussion.' }, contextHeaders('alice'));
    const humanReply = await human('bob', projectPath + '/hub/messages', 202,
      { requestId: 'bob-handoff', kind: 'handoff', text: 'Connecting my deterministic local session.' }, contextHeaders('bob'));
    const token = randomBytes(32).toString('base64url'), connectionId = 'profile-local-agent';
    await human('bob', projectPath + '/hub/connections', 202,
      { connectionId, label: 'Owned deterministic session', tokenHash: 'sha256:' + hash(token), expiresAt: Math.floor(Date.now() / 1000) + 1800 }, contextHeaders('bob'));
    const agentHeaders = { authorization: 'Bearer ' + token, 'x-confidence-connection': connectionId, 'if-platform-incarnation': project.projectIncarnation };
    async function agent<T = Record<string, unknown>>(path: string, status = 200, body?: unknown): Promise<T> {
      const response = await runtime!.dispatchFetch(origin + projectPath + '/agent/' + path, { headers: { ...agentHeaders, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      const result = responseObject(await response.json()); cases.push({ path: '/agent/' + path, status: response.status });
      assert.equal(response.status, status, JSON.stringify(result)); return result as T;
    }
    assert.deepEqual((await agent('messages')).messages, [instruction, humanReply]);
    const agentBody = { requestId: 'agent-result', kind: 'result', text: 'Deterministic local tool session; no model qualification claimed.' };
    const result = await agent<HubMessage>('messages', 202, agentBody); assert.equal(result.actor.principalId, identity('bob')); assert.equal(result.actor.credentialClass, 'agent');
    assert.deepEqual(await agent('messages', 202, agentBody), result);
    checks.push('Two humans and one explicitly delegated agent exchange durable messages through real wrapper routes; exact retries preserve one message and parent attribution');
    await (await runtime.getR2Bucket('OBJECTS', authority.name)).put(`dependencies/weft/${PINNED_WEFT_DEPENDENCY.bundle.sha256}.bundle`, dependency);
    assert.deepEqual(await agent('dependencies/weft'), PINNED_WEFT_DEPENDENCY);
    const bundle = await runtime.dispatchFetch(origin + projectPath + '/agent/dependencies/weft/bundle', { headers: agentHeaders });
    assert.equal(bundle.status, 200); assert.equal(bundle.headers.get('cache-control'), 'no-store');
    assert.equal(hash(new Uint8Array(await bundle.arrayBuffer())), PINNED_WEFT_DEPENDENCY.bundle.sha256);
    checks.push('Scoped agent acquires the actual retained b1c5521 Git bundle from local R2 through the production authority wrapper and verifies its fixed SHA-256');
    await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
    assert.deepEqual((await human('alice', projectPath + '/hub')).messages, [instruction, humanReply, result]);
    assert.deepEqual((await agent('messages?after=' + humanReply.sequence)).messages, [result]);
    checks.push('Fresh runtime restart preserves memberships, agent capability, discussion and exact incremental cursor on the same SQLite/R2 persistence');
    for (const path of [projectPath + '/state', projectPath + '/weft', `/v1/projects/${project.projectId}/publish`, '/api/enroll'])
      assert.equal((await human<ApiError>('alice', path, 404)).error.code, 'COLLABORATION_ONLY_DEPLOYMENT');
    const privateWorker = await runtime.getWorker(authority.name);
    const denied = await privateWorker.fetch('https://authority.internal/internal/enroll', { method: 'POST', headers: { authorization: 'Bearer ' + serviceToken }, body: '{}' });
    assert.equal(denied.status, 404); assert.equal(responseObject(responseObject(await denied.json()).error).code, 'COLLABORATION_ONLY_DEPLOYMENT');
    await human('bob', projectPath + '/hub/connections/' + connectionId + '/revoke', 202, {}, contextHeaders('bob'));
    assert.equal((await agent<ApiError>('messages', 401)).error.code, 'HUB_AGENT_UNAUTHORIZED');
    assert.ok(outbound.length > 0); assert.ok(outbound.every(url => url === app.vars.AUTH_JWKS_URL));
    checks.push('Both wrappers reject native/source/evaluation/publication routes, revoked agent capabilities fail, and no outbound request reaches an actual external system');
    for (const path of sourcePaths) assert.equal(hash(await readFile(resolve(root, path))), sourceDigests[path], 'Source changed during qualification: ' + path);
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
  const report = { schemaVersion: 1, profile: 'collaboration-only', passed: !failure, generatedAt: new Date().toISOString(), node: process.version,
    bundleQualified: !failure, dependency: PINNED_WEFT_DEPENDENCY, checks, cases, sourceDigests, bundleDigests,
    configurationDigests: { app: hash(JSON.stringify(app)), authority: hash(JSON.stringify(authority)) },
    limitations: ['Synthetic signed Access app identities and owned JWKS transport; not real human login', 'Static assets use an owned fixture; this check covers backend deployment bindings', 'Local workerd and local R2/SQLite; no deployment or external network calls', 'Deterministic agent transport, no model invocation or native-agent qualification'],
    ...(failure ? { failure } : {}) };
  const reportPath = resolve(process.env.HUB_PROFILE_RUNTIME_REPORT || 'demo-output/collaboration-profile-runtime.json');
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (failure) throw Error(failure);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await checkCollaborationProfile();
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, cases: report.cases.length, report: process.env.HUB_PROFILE_RUNTIME_REPORT || 'demo-output/collaboration-profile-runtime.json' }));
}
