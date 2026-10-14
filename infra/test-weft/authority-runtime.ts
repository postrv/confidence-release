// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { initializeKernel } from '../../packages/protocol/src/node.ts';
import { encodeBase64 } from '../../packages/protocol/src/index.ts';
import { testKey } from '../../tests/conformance/vector.ts';
import { ownedGit, OWNED_ARTIFACTS_HOST, OWNED_REPOSITORY } from './owned-git.ts';

interface RuntimeOptions { weft?: (request: Request) => Promise<Response>; connections?: unknown[]; replicaAudience?: string }

export async function authorityRuntime(options: RuntimeOptions = {}) {
  await initializeKernel();
  const git = await ownedGit(), directory = await mkdtemp(join(tmpdir(), 'confidence-weft-authority-'));
  const cleanup: (() => Promise<void>)[] = [() => git.dispose(), () => rm(directory, { recursive: true, force: true })];
  let disposed = false;
  async function dispose() {
    if (disposed) return; disposed = true;
    const errors = [];
    for (const close of cleanup.reverse()) { try { await close(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'Owned authority fixture cleanup failed');
  }
  try {
  const output = join(directory, 'bundle'); await mkdir(output);
  await promisify(execFile)(resolve('node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--config', 'infra/test-weft/wrangler.jsonc', '--outdir', output], {
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NODE_OPTIONS: '--max-old-space-size=384' }, timeout: 60_000, maxBuffer: 3 * 1024 * 1024,
  });
  const files = await readdir(output), scripts = files.filter(file => file.endsWith('.js')); assert.equal(scripts.length, 1);
  const bundleDigests: Record<string, string> = {};
  for (const file of files.filter(file => /\.(js|wasm)$/.test(file))) bundleDigests[file] = 'sha256:' + createHash('sha256').update(await readFile(join(output, file))).digest('hex');
  const rootKey = await testKey('03'), authorityKey = await testKey('01'), checkerKey = await testKey('02');
  const issuer = 'https://identity.weft.owned.test', audience = 'weft-owned-collaboration', kid = 'owned-human-key';
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...await exportJWK(pair.publicKey), kid, alg: 'ES256', use: 'sig' }, jwksUrl = issuer + '/cdn-cgi/access/certs';
  const origin = 'https://confidence.weft.owned.test', projectId = 'weft-owned-project', tenantId = 'weft-owned-tenant';
  const privateKey = async (key: CryptoKey) => encodeBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', key)));
  const keyBindings = { ROOT_KEY_ID: 'root-1', ROOT_SIGNING_KEY: await privateKey(rootKey.privateKey),
    AUTHORITY_KEY_ID: 'authority-1', AUTHORITY_SIGNING_KEY: await privateKey(authorityKey.privateKey),
    CHECKER_KEY_ID: 'checker-1', CHECKER_PUBLIC_KEY: encodeBase64(new Uint8Array(await crypto.subtle.exportKey('raw', checkerKey.publicKey))) };
  let connections = options.connections || [];
  let evaluationImageDigest = 'sha256:' + '1'.repeat(64);
  let lostResponsePath: string | null = null;
  const evaluationRequests: Record<string, unknown>[] = [];
  const runtimeOptions = () => convertV4MiniflareOptions({
    name: 'owned-weft-confidence', modulesRoot: output,
    modules: [{ type: 'ESModule', path: join(output, scripts[0]) }, ...files.filter(file => file.endsWith('.wasm')).map(file => ({ type: 'CompiledWasm' as const, path: join(output, file) }))],
    compatibilityDate: '2026-10-08', compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.ERROR),
    durableObjects: { PROJECTS: { className: 'WeftTestAuthority', useSQLite: true }, PROJECT_DIRECTORY: { className: 'ProjectDirectory', useSQLite: true } },
    r2Buckets: { OBJECTS: 'owned-weft-confidence-objects' }, resourcePersistencePath: join(directory, 'persist'),
    bindings: { ...keyBindings, AUTH_ISSUER: issuer, AUTH_AUDIENCE: audience, AUTH_JWKS_URL: jwksUrl, AUTH_TENANT_ID: tenantId,
      ...(options.replicaAudience === undefined ? {} : { AUTH_REPLICA_AUDIENCE: options.replicaAudience }),
      APP_ORIGIN: origin, APP_SERVICE_TOKEN: 'owned-weft-service-token-never-deploy', DEFAULT_PROJECT_ID: projectId,
      PI_ENABLED: 'false', MAINTENANCE_MODE: 'false', CONDITIONAL_PUBLICATION_VERIFIED: 'true', BOOTSTRAP_IDENTITY_ENABLED: 'false',
      BOOTSTRAP_SUBJECTS: JSON.stringify([issuer + '#owner']), EVALUATION_IMAGE_DIGEST: evaluationImageDigest, CHECKER_IMPLEMENTATION_DIGEST: 'sha256:' + '2'.repeat(64),
      ARTIFACTS_GIT_HOST: OWNED_ARTIFACTS_HOST, TEST_GIT_REMOTE: git.remote, TEST_GIT_TOKEN: git.token, TEST_REPOSITORY: OWNED_REPOSITORY,
      WEFT_CONNECTIONS: JSON.stringify(connections), WEFT_SERVICE_TOKEN: 'owned-weft-admin-local-test-only-credential',
    },
    serviceBindings: {
      ASSETS: async () => new Response('Owned test does not serve assets', { status: 404 }),
      WEFT: async request => options.weft ? options.weft(new Request(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
        ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.arrayBuffer() }) })) : new Response('Weft not connected', { status: 503 }),
      TEST_EVALUATOR: async request => { evaluationRequests.push(await request.json() as Record<string, unknown>); return Response.json({ accepted: true }); },
    },
    outboundService: async request => {
      if (request.url === jwksUrl && request.method === 'GET') return Response.json({ keys: [jwk] });
      if (new URL(request.url).hostname === OWNED_ARTIFACTS_HOST) return git.fetch(new Request(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
        ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.arrayBuffer() }) }));
      return new Response('Owned external route denied', { status: 403 });
    },
  });
  let runtime = new Miniflare(runtimeOptions()); cleanup.push(() => runtime.dispose()); await runtime.ready;
  async function token(subject = 'owner', overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: issuer, aud: audience, sub: subject, tenant_id: tenantId, principal_class: 'human', iat: now - 5, exp: now + 3600, ...overrides }).setProtectedHeader({ alg: 'ES256', kid }).sign(pair.privateKey);
  }
  async function request(path: string, init: RequestInit = {}, subject = 'owner', expected = 200) {
    const response = await runtime.dispatchFetch(origin + path, { ...init, headers: { authorization: 'Bearer ' + await token(subject), ...init.headers } } as never);
    const text = await response.text(); assert.equal(response.status, expected, `${path}: ${text}`);
    if (lostResponsePath === path) { lostResponsePath = null; throw Error('OWNED_RESPONSE_LOST_AFTER_AUTHORITY_COMMIT'); }
    return JSON.parse(text);
  }
  let incarnation = '';
  const mutationHeaders = () => ({ origin, 'content-type': 'application/json', 'x-platform-csrf': '1', ...(incarnation ? { 'if-platform-incarnation': incarnation } : {}) });
  return {
    origin, issuer, audience, projectId, tenantId, git, checkerKey, evaluationRequests, directory, token, request, bundleDigests,
    loseResponseOnce(path: string) { assert.equal(lostResponsePath, null); lostResponsePath = path; },
    fetch: (path: string, init?: RequestInit) => runtime.dispatchFetch(origin + path, init as never),
    async enroll() {
      const result = await request(`/v1/projects/${projectId}/enroll`, { method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ canonicalRepo: OWNED_REPOSITORY, canonicalRef: 'refs/heads/main', expectedHead: git.base, maximumBudget: '0' }) }, 'owner', 201);
      incarnation = result.scope.projectIncarnation; return result;
    },
    async snapshot(subject = 'owner') { return request(`/v1/projects/${projectId}/state`, {}, subject); },
    async command(operation: string, body: Record<string, unknown>, selected: { id?: string; subject?: string; expected?: number; revision?: string } = {}) {
      const subject = selected.subject || 'owner', current = await this.snapshot(subject);
      return request(`/v1/projects/${projectId}/${operation}`, { method: 'POST', headers: { ...mutationHeaders(), 'idempotency-key': selected.id || randomUUID(), 'if-platform-revision': selected.revision || current.project.revision }, body: JSON.stringify(body) }, subject, selected.expected || 202);
    },
    async connect(next: unknown[], imageDigest = 'sha256:' + '1'.repeat(64)) { connections = next; evaluationImageDigest = imageDigest; await runtime.dispose(); runtime = new Miniflare(runtimeOptions()); await runtime.ready; },
    async control(path: string, body?: unknown, expected = 200) {
      const response = await runtime.dispatchFetch(origin + '/_test/' + path, { method: 'POST', body: JSON.stringify(body || {}) });
      const text = await response.text(); assert.equal(response.status, expected, text); return JSON.parse(text);
    },
    dispose,
  };
  } catch (error) { await dispose(); throw error; }
}
