// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { initializeKernel } from '../packages/protocol/src/node.ts';
import { digest, decodeBase64, encodeBase64, canonicalize, signStatement, statement } from '../packages/protocol/src/index.ts';
import { vector, testKey } from '../tests/conformance/vector.ts';
import { FULL_RELEASE_JOB_COUNT } from '../workers/evaluator/recipes.ts';

export async function collaborationRuntime(origin = 'https://collaboration.owned.test', flags: { publicationVerified?: boolean; hubEnabled?: boolean } = {}) {
  await initializeKernel();
  const fixture = await vector(true), scope = fixture.input.state.scope;
  const issuer = 'https://identity.owned.test', audience = 'owned-collaboration', kid = 'owned-human-key';
  const pair = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...await exportJWK(pair.publicKey), kid, alg: 'ES256', use: 'sig' };
  const jwksUrl = issuer + '/cdn-cgi/access/certs';
  const directory = await mkdtemp(join(tmpdir(), 'confidence-collaboration-')), output = join(directory, 'bundle');
  await mkdir(output);
  await promisify(execFile)(resolve('node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--config', 'infra/test-collaboration/wrangler.jsonc', '--outdir', output], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
  const files = await readdir(output), scripts = files.filter(name => name.endsWith('.js'));
  assert.equal(scripts.length, 1);
  const bundleDigests: Record<string, string> = {};
  for (const name of files.filter(name => /\.(js|wasm)$/.test(name))) bundleDigests[name] = 'sha256:' + createHash('sha256').update(await readFile(join(output, name))).digest('hex');
  const signingKey = Buffer.from(await crypto.subtle.exportKey('pkcs8', fixture.authority.privateKey)).toString('base64');
  let publicationVerified = flags.publicationVerified !== false;
  const options = () => convertV4MiniflareOptions({
    name: 'owned-collaboration', modulesRoot: output,
    modules: [{ type: 'ESModule', path: join(output, scripts[0]) }, ...files.filter(name => name.endsWith('.wasm')).map(name => ({ type: 'CompiledWasm' as const, path: join(output, name) }))],
    compatibilityDate: '2026-10-08', compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.ERROR),
    durableObjects: { PROJECTS: { className: 'CollaborationTestAuthority', useSQLite: true }, PROJECT_DIRECTORY: { className: 'ProjectDirectory', useSQLite: true } },
    r2Buckets: { OBJECTS: 'owned-test-only-objects' }, resourcePersistencePath: join(directory, 'persist'),
    bindings: {
      AUTH_ISSUER: issuer, AUTH_AUDIENCE: audience, AUTH_JWKS_URL: jwksUrl, AUTH_TENANT_ID: scope.tenantId,
      APP_ORIGIN: origin, APP_SERVICE_TOKEN: 'owned-collaboration-service-token-never-deploy', DEFAULT_PROJECT_ID: scope.projectId,
      PI_ENABLED: 'false', MAINTENANCE_MODE: 'false', CONDITIONAL_PUBLICATION_VERIFIED: String(publicationVerified), BOOTSTRAP_IDENTITY_ENABLED: 'false',
      PROJECT_HUB_ENABLED: String(flags.hubEnabled === true),
      BOOTSTRAP_SUBJECTS: JSON.stringify([issuer + '#owner']),
      ROOT_KEY_ID: 'authority-1', ROOT_SIGNING_KEY: signingKey, AUTHORITY_KEY_ID: 'authority-1', AUTHORITY_SIGNING_KEY: signingKey,
      CHECKER_KEY_ID: 'checker-1', CHECKER_PUBLIC_KEY: fixture.trust.keys.find(key => key.roles.includes('checker'))!.publicKeyBase64,
      EVALUATION_IMAGE_DIGEST: 'sha256:' + '1'.repeat(64), CHECKER_IMPLEMENTATION_DIGEST: 'sha256:' + '2'.repeat(64),
      ARTIFACTS_GIT_HOST: '1'.repeat(32) + '.artifacts.cloudflare.net',
    },
    outboundService: request => request.url === jwksUrl && request.method === 'GET'
      ? Response.json({ keys: [jwk] }) : new Response('Owned external route denied', { status: 403 }),
    serviceBindings: { ASSETS: async request => {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const root = resolve('apps/web/dist'), path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!path.startsWith(root + '/')) return new Response('Not found', { status: 404 });
      try {
        const bytes = await readFile(path);
        const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
        return new Response(bytes, { headers: { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
      } catch { return new Response('Not found', { status: 404 }); }
    } },
  });
  let runtime = new Miniflare(options());
  await runtime.ready;
  const jobs = await Promise.all(Array.from({ length: FULL_RELEASE_JOB_COUNT }, async (_, index) => ({ id: index === FULL_RELEASE_JOB_COUNT - 1 ? 'collaboration:overlapping-read-write' : `collaboration-job-${index + 1}`, inputDigest: await digest({ candidate: fixture.input.candidate.digest, ownedSyntheticCase: index + 1 }), required: true, evidenceClass: 'protected-behavioural' as const })));
  const planBase = { candidateId: fixture.input.candidate.id, candidateDigest: fixture.input.candidate.digest, jobs };
  const seed = { scope, owner: issuer + '#owner', candidate: fixture.input.candidate, plan: { ...planBase, digest: await digest(planBase) }, manifest: fixture.bundle.inputs.manifest, gitObjects: fixture.bundle.inputs.gitObjects, baselineSource: fixture.baselineSource, trust: fixture.trust, enrollmentPredicate: JSON.parse(Buffer.from(decodeBase64(fixture.bundle.enrollment.payload)).toString()).predicate, enrollment: fixture.bundle.enrollment };
  const seeded = await runtime.dispatchFetch(origin + '/_test/seed', { method: 'POST', body: JSON.stringify(seed) });
  assert.equal(seeded.status, 200, await seeded.text());
  const checker = await testKey('02');
  for (const job of jobs) {
    const observation = { outcome: 'PASS', ownedSyntheticJob: job.id };
    const evidenceBase = { id: `evidence-${job.id}`, jobId: job.id, inputDigest: job.inputDigest, observationDigest: await digest(observation), candidateId: fixture.input.candidate.id, candidateDigest: fixture.input.candidate.digest, outcome: 'PASS' as const, evidenceClass: 'protected-behavioural' as const, authorized: true };
    const evidence = { ...evidenceBase, digest: await digest(evidenceBase) };
    const callback = { scope, evidence, envelope: await signStatement(await statement('evidence', evidence), 'checker-1', checker.privateKey), observationBase64: encodeBase64(new TextEncoder().encode(canonicalize(observation))) };
    const response = await runtime.dispatchFetch(origin + '/_test/evidence', { method: 'POST', body: JSON.stringify(callback) });
    assert.equal(response.status, 200, await response.text());
  }
  async function token(subject: string, overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: issuer, aud: audience, sub: subject, tenant_id: scope.tenantId, principal_class: 'human', iat: now - 5, exp: now + 3600, ...overrides }).setProtectedHeader({ alg: 'ES256', kid }).sign(pair.privateKey);
  }
  return {
    issuer, scope, origin, token, candidateId: fixture.input.candidate.id, bundleDigests,
    fetch: (path: string, init?: RequestInit) => runtime.dispatchFetch(origin + path, init as any),
    async putDependency(bytes: Uint8Array) {
      const { PINNED_WEFT_DEPENDENCY } = await import('../packages/protocol/src/dependencies.ts');
      assert.equal(bytes.length, PINNED_WEFT_DEPENDENCY.bundle.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), PINNED_WEFT_DEPENDENCY.bundle.sha256);
      await (await runtime.getR2Bucket('OBJECTS')).put(`dependencies/weft/${PINNED_WEFT_DEPENDENCY.bundle.sha256}.bundle`, bytes);
    },
    async restart(next: { publicationVerified?: boolean } = {}) { await runtime.dispose(); if (next.publicationVerified !== undefined) publicationVerified = next.publicationVerified; runtime = new Miniflare(options()); await runtime.ready; },
    async dispose() { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); },
  };
}
