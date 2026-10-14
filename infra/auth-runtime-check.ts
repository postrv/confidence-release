// SPDX-License-Identifier: Apache-2.0
// Actual local Application/jose verification; owned fake JWKS TLS and authority.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPair, exportJWK, SignJWT, CompactSign } from 'jose';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { initializeKernel } from '../packages/protocol/src/node.ts';
import { canonicalize, sha256 } from '../packages/protocol/src/index.ts';
import { sameViewCursor } from '../workers/shared/view-cursor.ts';
import { COLLABORATION_OPERATIONS } from '../packages/protocol/src/collaboration.ts';

await initializeKernel();
const issuer = 'https://issuer.owned.test', audience = 'owned-confidence-test', tenant = 'owned-tenant', origin = 'https://app.owned.test';
const jwksUrl = issuer + '/cdn-cgi/access/certs', kid = 'owned-es256', serviceToken = 'owned-test-only-service-token-never-deploy';
const pair = await generateKeyPair('ES256', { extractable: true }), wrongPair = await generateKeyPair('ES256');
const jwk = { ...await exportJWK(pair.publicKey), kid, alg: 'ES256', use: 'sig' };
const rsaPair = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true }), wrongRsaPair = await generateKeyPair('RS256', { modulusLength: 2048 });
const rsaKid = 'owned-access-rs256', rsaJwk = { ...await exportJWK(rsaPair.publicKey), kid: rsaKid, alg: 'RS256', use: 'sig' };
let availableKeys = [jwk, rsaJwk], jwksAvailable = true;
const time = Math.floor(Date.now() / 1000);
const claims = { iss: issuer, aud: audience, sub: 'owned-subject', iat: time - 30, exp: time + 600, principal_class: 'human', tenant_id: tenant };
const directory = await mkdtemp(join(tmpdir(), 'confidence-auth-runtime-')), output = join(directory, 'bundle'); await mkdir(output);
const reportPath = resolve(process.env.AUTH_RUNTIME_REPORT || 'demo-output/auth-runtime.json');
const run = promisify(execFile);
await run(resolve('node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--config', 'infra/test-auth/wrangler.jsonc', '--outdir', output], { cwd: resolve('.'), env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
const scripts = (await readdir(output)).filter(name => name.endsWith('.js')); assert.equal(scripts.length, 1);
const authorityCalls: { path: string; authorizationMatches: boolean; contentType: string | null; body: any }[] = [], assets: { path: string; method: string }[] = [], jwksCalls: { url: string; method: string; permitted: boolean }[] = [];
const snapshot = {
  project: { scope: { schemaVersion: 1, tenantId: tenant, projectId: 'owned-project', projectIncarnation: 'owned-incarnation' }, revision: '7', observationRevision: '0', head: '1'.repeat(40), gate: 'OPEN', goalRevision: '1', policyRevision: '1', enrollmentDigest: 'sha256:' + '1'.repeat(64) },
  attempts: [{ id: 'owned-attempt', generation: '1', grantId: 'owned-grant', workBase: '1'.repeat(40), publicationBase: '1'.repeat(40), allowedPaths: ['cache.mjs'], assignment: 'Owned assignment' }],
  candidates: [], plans: [], evaluations: [], cleanups: [], reviews: [{ id: 'owned-review', proposalDigest: 'sha256:' + '4'.repeat(64), proposal: { candidateId: 'owned-candidate', expectedHead: '1'.repeat(40), goalRevision: '1', policyRevision: '1', planDigest: 'sha256:' + '5'.repeat(64), evidenceDigests: [], observationRevision: '0', expiresAt: time + 900 } }],
  publications: [], receipts: [], evidence: [], sequence: 1, submissions: [], runtime: [], approvals: [], events: [{ sequence: 1, payload: JSON.stringify({ id: 'owned-event', kind: 'owned-event', objectId: 'owned-project' }) }], observations: {}, sourceFiles: {}, sourceManifests: {}, capsules: [], baseline: { manifest: { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: [] } }, evaluationIds: {},
};
const viewCursor = { projectIncarnation: 'owned-incarnation', revision: '7', eventSequence: 1, capsuleRowid: 0 };
let callerPermissions: { review: boolean; sponsor: boolean; manage: boolean; export: boolean } | undefined;
const v4Options: Parameters<typeof convertV4MiniflareOptions>[0] = {
  name: 'owned-auth-runtime', modulesRoot: output,
  modules: [{ type: 'ESModule', path: join(output, scripts[0]) }, ...(await readdir(output)).filter(name => name.endsWith('.wasm')).map(name => ({ type: 'CompiledWasm' as const, path: join(output, name) }))],
  compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.ERROR),
  bindings: { AUTH_ISSUER: issuer, AUTH_AUDIENCE: audience, AUTH_JWKS_URL: jwksUrl, AUTH_TENANT_ID: tenant, APP_ORIGIN: origin, APP_SERVICE_TOKEN: serviceToken, DEFAULT_PROJECT_ID: 'owned-project', PI_ENABLED: 'true', CONDITIONAL_PUBLICATION_VERIFIED: 'false', MAINTENANCE_MODE: 'true', BOOTSTRAP_IDENTITY_ENABLED: 'true' },
  outboundService: async request => {
    const permitted = request.url === jwksUrl && request.method === 'GET'; jwksCalls.push({ url: request.url, method: request.method, permitted });
    return permitted ? (jwksAvailable ? Response.json({ keys: availableKeys }, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }) : new Response('Owned provider unavailable', { status: 503 })) : new Response('Owned outbound route denied', { status: 403 });
  },
  serviceBindings: {
    ASSETS: async request => { assets.push({ path: new URL(request.url).pathname, method: request.method }); return new Response('owned-public-asset', { headers: { 'x-owned-asset': '1' } }); },
    AUTHORITY: async request => {
      const body = await request.json() as any, path = new URL(request.url).pathname;
      const authorizationMatches = request.headers.get('authorization') === 'Bearer ' + serviceToken;
      authorityCalls.push({ path, authorizationMatches, contentType: request.headers.get('content-type'), body });
      if (!authorizationMatches) return Response.json({ error: { code: 'OWNED_SERVICE_AUTH_REQUIRED' } }, { status: 401 });
      if (['/internal/collaboration', '/internal/collaboration-command', '/internal/inspect-invitation'].includes(path)) {
        if (body.caller.projectId === 'inaccessible-project') return Response.json({ error: { code: 'PROJECT_UNAVAILABLE' } }, { status: 404 });
        if (body.caller.projectId === 'second-project' && body.command && body.command.expectedIncarnation !== 'second-incarnation') return Response.json({ error: { code: 'PROJECT_INCAR_CHANGED' } }, { status: 409 });
      }
      // Owned nonmember fixture: identity discovery must not reach this boundary.
      if ((body.caller?.principal ?? body.principal).id === issuer + '#owned-pending-subject') return Response.json({ error: { code: 'PROJECT_UNAVAILABLE' } }, { status: 404 });
      if (path.startsWith('/internal/projects/')) return Response.json({ ownedFakeDirectory: true, received: path }, { status: path === '/internal/projects/create' ? 201 : 200 });
      if (path === '/internal/conditional-snapshot') {
        const cursor = { ...viewCursor, ...(body.candidateId === undefined ? {} : { selectedCandidateId: body.candidateId }) };
        return Response.json(body.priorViewCursor && sameViewCursor(body.priorViewCursor, cursor)
          ? { unchanged: true, cursor } : { unchanged: false, cursor, snapshot: { ...snapshot, ...(callerPermissions ? { callerPermissions } : {}) } });
      }
      if (path === '/internal/snapshot') return Response.json(body.includeModelCalls === true
        ? { ...snapshot, modelCalls: { limit: 2048, overflow: false, reservations: [] } } : snapshot);
      if (path === '/internal/model-calls') return Response.json({ schemaVersion: 1, ownedFakeAuthority: true, projectId: body.caller.projectId, after: body.after, limit: body.limit, expectedIncarnation: body.expectedIncarnation, items: [], hasMore: false, nextCursor: body.after });
      if (path === '/internal/operations') return Response.json({ schemaVersion: 1, ownedFakeAuthority: true, projectId: body.caller.projectId, jobKey: body.jobKey ?? null, readiness: 'UNVERIFIED' });
      if (path === '/internal/export') return Response.json({ ownedFakeExport: true, kind: body.exportKind, publicationId: body.publicationId ?? null });
      if (path === '/internal/collaboration') return body.caller.principal.id === issuer + '#owned-guest'
        ? Response.json({ error: { code: 'REFERENCE_UNAVAILABLE' } }, { status: 404 })
        : Response.json({ ownedFakeCollaboration: true, revision: '7', members: [] });
      if (path === '/internal/inspect-invitation') return Response.json({ scope: snapshot.project.scope, invitation: { id: 'owned-invitation', recipientId: body.caller.principal.id, role: 'reviewer', inviter: issuer + '#owned-subject', createdAt: time, expiresAt: time + 3600, state: 'PENDING' } });
      // This mirrors one already tested real-authority rule solely to preserve
      // transport status. It proves forwarded class, not role membership.
      if (path === '/internal/command' && body.command.operation === 'approve-review' && body.caller.principal.credentialClass !== 'human') return Response.json({ error: { code: 'HUMAN_REQUIRED', ownedFakeAuthority: true } }, { status: 403 });
      return Response.json({ ownedFakeAuthority: true, received: path, principal: body.caller.principal }, { status: path === '/internal/enroll' ? 201 : 202 });
    },
  },
};
const options = convertV4MiniflareOptions(v4Options);
const runtime = new Miniflare(options), cases: unknown[] = [], checks: string[] = [];
async function token(overrides: Record<string, unknown> = {}, omit: string[] = []): Promise<string> {
  const payload: any = { ...claims, ...overrides }; for (const key of omit) delete payload[key];
  return new SignJWT(payload).setProtectedHeader({ alg: 'ES256', kid }).sign(pair.privateKey);
}
async function rawJwt(payload: string, header = JSON.stringify({ alg: 'ES256', kid })): Promise<string> {
  if (header === JSON.stringify({ alg: 'ES256', kid })) return new CompactSign(new TextEncoder().encode(payload)).setProtectedHeader({ alg: 'ES256', kid }).sign(pair.privateKey);
  const encodedHeader = Buffer.from(header).toString('base64url'), encodedPayload = Buffer.from(payload).toString('base64url'), signing = encodedHeader + '.' + encodedPayload;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(signing));
  return signing + '.' + Buffer.from(signature).toString('base64url');
}
async function expect(name: string, path: string, expectedStatus: number, config: { token?: string; access?: string; method?: string; headers?: Record<string, string>; body?: string; code?: string; forwards?: number; commands?: number; principalClass?: string; requestOrigin?: string } = {}): Promise<any> {
  const before = authorityCalls.length, assetsBefore = assets.length;
  const headers: Record<string, string> = { ...(config.token !== undefined ? { authorization: 'Bearer ' + config.token } : {}), ...(config.access !== undefined ? { 'cf-access-jwt-assertion': config.access } : {}), ...config.headers };
  const response = await runtime.dispatchFetch((config.requestOrigin ?? origin) + path, { method: config.method || 'GET', headers, ...(config.body !== undefined ? { body: config.body } : {}) });
  const text = await response.text(); let result: any; try { result = JSON.parse(text); } catch { result = { text }; }
  const errorCode = typeof result.error === 'string' ? result.error : result.error?.code;
  const forwards = authorityCalls.slice(before), commands = forwards.filter(call => ['/internal/command', '/internal/enroll', '/internal/collaboration-command'].includes(call.path));
  cases.push({ name, path, status: response.status, expectedStatus, ...(errorCode ? { error: errorCode } : {}), authorityForwards: forwards.length, authorityCommands: commands.length, assets: assets.length - assetsBefore, ...(config.principalClass ? { expectedPrincipalClass: config.principalClass } : {}) });
  assert.equal(response.status, expectedStatus, `${name}: ${text}`); if (config.code) assert.equal(errorCode, config.code, name);
  if (config.forwards !== undefined) assert.equal(forwards.length, config.forwards, `${name}: authority forwarding`);
  if (config.commands !== undefined) assert.equal(commands.length, config.commands, `${name}: authority command forwarding`);
  if (config.principalClass) for (const call of forwards) assert.equal((call.body.caller?.principal ?? call.body.principal).credentialClass, config.principalClass, name);
  return { result, response, forwards };
}
const mutationHeaders = { origin, 'x-platform-csrf': '1', 'content-type': 'application/json', 'idempotency-key': 'owned-command', 'if-platform-revision': '7' };
let failure: string | undefined;
try {
  await runtime.ready;
  const limits = await runtime.dispatchFetch(origin + '/_test/limits'); const controlBytes = (await limits.json() as { controlBytes: number }).controlBytes;
  assert.ok(Number.isSafeInteger(controlBytes) && controlBytes > 0 && controlBytes <= 2 * 1024 * 1024);
  for (const path of ['/', '/index.html', '/assets/owned.js', '/api', '/v1']) { const result = await expect('Public asset ' + path, path, 200, { forwards: 0 }); assert.equal(result.result.text, 'owned-public-asset'); }
  for (const path of ['/api/state', '/v1/projects/owned-project/state', '/api/unknown', '/v1/unknown']) await expect('Protected missing token ' + path, path, 401, { code: 'AUTHENTICATION_REQUIRED', forwards: 0 });
  checks.push('Production route prefixes keep assets public and /api/ plus /v1/ protected before any authority request');

  const valid = await token(); const principal = await expect('Real ES256 verified principal', '/_test/principal', 200, { token: valid, forwards: 0 });
  assert.deepEqual(principal.result, { id: issuer + '#owned-subject', tenantId: tenant, credentialClass: 'human', authentication: { issuer, subject: 'owned-subject', issuedAt: claims.iat, expiresAt: claims.exp, authenticatedAt: null } });
  const recentAuthentication = await expect('Only signed auth_time establishes recent authentication', '/_test/principal', 200, { token: await token({ auth_time: time - 60 }), headers: { 'auth-time': String(time), 'x-platform-authentication': String(time) }, forwards: 0 });
  assert.equal(recentAuthentication.result.authentication.authenticatedAt, time - 60);
  const state = await expect('Authenticated application state', '/api/state', 200, { token: valid, forwards: 1, principalClass: 'human' }); assert.equal(state.result.projectId, 'owned-project'); assert.equal(state.result.tenantId, tenant);
  assert.deepEqual(state.result.session, { principalId: issuer + '#owned-subject', credentialClass: 'human' });
  const directory = await expect('Verified human directory routes without default snapshot', '/api/projects', 200, { token: valid, forwards: 1, principalClass: 'human' });
  assert.equal(directory.forwards[0].body.defaultProjectId, 'owned-project');
  assert.equal(directory.forwards[0].body.principal.id, issuer + '#owned-subject');
  const createdProject = await expect('Project creation binds verified creator', '/api/projects', 201, { token: valid, method: 'POST', headers: mutationHeaders, body: '{"name":"Owned project"}', forwards: 1, principalClass: 'human' });
  assert.equal(createdProject.forwards[0].body.command.commandId, 'owned-command');
  const managedProject = await expect('Project management forwards separate metadata revision and incarnation', '/api/projects/second-project/update', 200, { token: valid, method: 'POST', headers: { ...mutationHeaders, 'if-platform-incarnation': 'second-incarnation' }, body: '{"name":"Updated project"}', forwards: 1 });
  assert.equal(managedProject.forwards[0].body.caller.projectId, 'second-project');
  assert.equal(managedProject.forwards[0].body.command.expectedRevision, '7');
  assert.equal(managedProject.forwards[0].body.command.expectedIncarnation, 'second-incarnation');
  for (const path of ['/api/projects', '/api/projects/owned-project']) {
    await expect('Project management still requires authentication ' + path, path, 401, { code: 'AUTHENTICATION_REQUIRED', forwards: 0 });
    await expect('Project directory rejects agent identity ' + path, path, 403, { token: await token({ principal_class: 'agent' }), code: 'HUMAN_REQUIRED', forwards: 0 });
  }
  const scopedState = await expect('Selected project rejects another project view cursor', '/api/projects/second-project/state', 200, { token: valid, headers: { 'if-platform-view': state.result.viewToken }, forwards: 1 });
  assert.equal(scopedState.forwards[0].body.caller.projectId, 'second-project');
  assert.equal(scopedState.forwards[0].body.priorViewCursor, null);
  for (const suffix of ['trust-config', 'checkpoint', 'checkpoint-attestation', 'receipts/owned-receipt/export']) {
    const scopedExport = await expect('Selected project owns exported material ' + suffix, '/api/projects/second-project/' + suffix, 200, { token: valid, forwards: 1 });
    assert.equal(scopedExport.forwards[0].body.caller.projectId, 'second-project');
  }
  checks.push('Real verified identity is preserved through directory/create/manage routes; scoped native aliases bind project IDs and reject cross-project view reuse without any identity bypass');
  const health = await expect('Health distinguishes a reachable snapshot from readiness', '/api/health', 200, { token: valid, forwards: 1 });
  assert.equal(health.result.ready, false); assert.equal(health.result.readiness, 'UNVERIFIED'); assert.equal(health.result.authoritySnapshot, 'OBSERVED');
  const operator = await expect('Scoped operator inspection forwards signed principal', '/v1/projects/owned-project/operations?jobKey=' + 'a'.repeat(64), 200, { token: valid, forwards: 1, principalClass: 'human' });
  assert.equal(operator.result.projectId, 'owned-project'); assert.equal(operator.result.jobKey, 'a'.repeat(64));
  await expect('Malformed operator job key stays local', '/v1/projects/owned-project/operations?jobKey=bad', 400, { token: valid, forwards: 0, code: 'OPERATIONS_QUERY_INVALID' });
  checks.push('Authenticated health reports observed liveness and unverified readiness; scoped operator inspection forwards only verified principal and a bounded job key');
  const idleState = await expect('Unchanged authenticated application state', '/api/state', 200, { token: valid, headers: { 'if-platform-view': state.result.viewToken }, forwards: 1, principalClass: 'human' });
  assert.deepEqual(idleState.result, { unchanged: true, viewToken: state.result.viewToken });
  assert.deepEqual(idleState.forwards[0].body.priorViewCursor, viewCursor);
  callerPermissions = { review: false, sponsor: true, manage: true, export: true };
  const permissionState = await expect('Authority permission summary is forwarded to the current session', '/api/state', 200, { token: valid, forwards: 1 });
  assert.deepEqual(permissionState.result.session, { principalId: issuer + '#owned-subject', credentialClass: 'human', permissions: callerPermissions });
  callerPermissions = undefined;
  const changedPrincipal = await token({ sub: 'second-owned-subject' });
  const otherPrincipal = await expect('Old principal cursor forces a full application read', '/api/state', 200, { token: changedPrincipal, headers: { 'if-platform-view': state.result.viewToken }, forwards: 1, principalClass: 'human' });
  assert.equal(otherPrincipal.forwards[0].body.priorViewCursor, null);
  assert.equal(otherPrincipal.result.session.principalId, issuer + '#second-owned-subject');
  assert.notEqual(otherPrincipal.result.viewToken, state.result.viewToken);
  const changedClass = await expect('Changed credential class forces a full application read', '/api/state', 200,
    { token: await token({ principal_class: 'agent' }), headers: { 'if-platform-view': state.result.viewToken }, forwards: 1, principalClass: 'agent' });
  assert.equal(changedClass.forwards[0].body.priorViewCursor, null);
  assert.equal(changedClass.result.session.credentialClass, 'agent');
  checks.push('Application conditional snapshots retain verified principal and capability scope, return a tiny unchanged marker, and reject reuse after identity change');
  const selected = await expect('Explicit selected candidate forwarded with a fresh view', '/api/state?candidateId=older-candidate', 200,
    { token: valid, headers: { 'if-platform-view': state.result.viewToken }, forwards: 1 });
  assert.equal(selected.forwards[0].body.candidateId, 'older-candidate');
  assert.equal(selected.forwards[0].body.priorViewCursor, null);
  assert.equal(selected.result.viewCursor.selectedCandidateId, 'older-candidate');
  const sameSelection = await expect('Same selected candidate reuses its own cursor', '/api/state?candidateId=older-candidate', 200,
    { token: valid, headers: { 'if-platform-view': selected.result.viewToken }, forwards: 1 });
  assert.equal(sameSelection.result.unchanged, true);
  for (const path of ['/api/state?candidateId=newer-candidate', '/api/state']) {
    const switchedSelection = await expect('Previous selection cannot be reused ' + path, path, 200,
      { token: valid, headers: { 'if-platform-view': selected.result.viewToken }, forwards: 1 });
    assert.equal(switchedSelection.forwards[0].body.priorViewCursor, null);
    assert.equal(switchedSelection.result.unchanged, undefined);
  }
  const selectedV1 = await expect('Scoped selected candidate with model roster', '/v1/projects/owned-project/state?candidateId=older-candidate&modelCalls=1', 200, { token: valid, forwards: 1 });
  assert.equal(selectedV1.forwards[0].body.candidateId, 'older-candidate');
  assert.equal(selectedV1.forwards[0].body.includeModelCalls, true);
  for (const route of ['/api/state', '/v1/projects/owned-project/state']) {
    await expect('Repeated selected candidate ' + route, route + '?candidateId=first&candidateId=second', 400, { token: valid, code: 'STATE_QUERY_INVALID', forwards: 0 });
    for (const value of ['', '..%2Fother']) await expect('Malformed selected candidate ' + route + value, route + '?candidateId=' + value, 400, { token: valid, code: 'INVALID_SELECTED_CANDIDATE', forwards: 0 });
    await expect('Unauthenticated selected candidate ' + route, route + '?candidateId=older-candidate', 401, { code: 'AUTHENTICATION_REQUIRED', forwards: 0 });
  }
  checks.push('Actual application state routes forward exact selected candidate, scope conditional reuse to that selector, and reject malformed/repeated or unauthenticated requests before authority reads');
  await expect('Frozen action rejects changed principal', '/v1/projects/owned-project/request-review', 409, { token: valid, method: 'POST', headers: { ...mutationHeaders, 'if-platform-principal': issuer + '#different-subject' }, body: '{}', code: 'SESSION_PRINCIPAL_CHANGED', forwards: 0 });
  const incarnationCommand = await expect('Frozen command forwards exact incarnation', '/v1/projects/owned-project/request-review', 202, { token: valid, method: 'POST', headers: { ...mutationHeaders, 'if-platform-principal': issuer + '#owned-subject', 'if-platform-incarnation': 'owned-incarnation' }, body: '{"candidateId":"owned-candidate","evaluationId":"owned-evaluation"}', forwards: 1, commands: 1 });
  assert.equal(incarnationCommand.forwards[0].body.command.expectedIncarnation, 'owned-incarnation');
  const normalRead = await expect('Authenticated v1 scoped read', '/v1/projects/owned-project/state', 200, { token: valid, forwards: 1, principalClass: 'human' });
  assert.equal('modelCalls' in normalRead.result, false);
  assert.equal('includeModelCalls' in normalRead.forwards[0].body, false);
  const rosterRead = await expect('Protected opt-in model roster', '/v1/projects/owned-project/state?modelCalls=1', 200, { token: valid, forwards: 1, principalClass: 'human' });
  assert.deepEqual(rosterRead.result.modelCalls, { limit: 2048, overflow: false, reservations: [] });
  assert.equal(rosterRead.forwards[0].body.includeModelCalls, true);
  await expect('Invalid model roster selector', '/v1/projects/owned-project/state?modelCalls=0', 400, { token: valid, code: 'MODEL_ROSTER_QUERY_INVALID', forwards: 0 });
  checks.push('Ordinary state reads omit model-roster work; an authenticated exact opt-in reaches the protected authority read');
  const modelPage = '/v1/projects/owned-project/model-calls?incarnation=owned-incarnation';
  const pageRead = await expect('Scoped human model-call page', modelPage + '&after=17&limit=25', 200, { token: valid, forwards: 1, principalClass: 'human' });
  assert.equal(pageRead.forwards[0].path, '/internal/model-calls');
  assert.equal(pageRead.forwards[0].body.caller.projectId, 'owned-project');
  assert.deepEqual({ after: pageRead.result.after, limit: pageRead.result.limit, expectedIncarnation: pageRead.result.expectedIncarnation }, { after: '17', limit: 25, expectedIncarnation: 'owned-incarnation' });
  assert.equal(pageRead.response.headers.get('cache-control'), 'no-store');
  await expect('Accounting pages still require authentication', modelPage, 401, { forwards: 0, code: 'AUTHENTICATION_REQUIRED' });
  await expect('Accounting route is read-only before command dispatch', modelPage, 405, { token: valid, method: 'POST', body: '{}', forwards: 0, code: 'METHOD_NOT_ALLOWED' });
  await expect('Agent cannot read human accounting page', modelPage, 403, { token: await token({ principal_class: 'agent' }), forwards: 0, code: 'HUMAN_REQUIRED' });
  await expect('Service cannot read human accounting page', modelPage, 403, { token: await token({ principal_class: 'service' }), forwards: 0, code: 'HUMAN_REQUIRED' });
  for (const query of ['after=0', 'incarnation=owned-incarnation&after=0&after=1', 'incarnation=owned-incarnation&limit=101', 'incarnation=owned-incarnation&after=9223372036854775808', 'incarnation=owned-incarnation&includePrompt=true']) {
    await expect('Malformed accounting page remains local ' + query, '/v1/projects/owned-project/model-calls?' + query, 400, { token: valid, forwards: 0 });
  }
  await expect('Accounting page header/query incarnation disagreement stays local', modelPage, 409, { token: valid, headers: { 'if-platform-incarnation': 'another-incarnation' }, forwards: 0, code: 'PROJECT_INCARNATION_CHANGED' });
  checks.push('Model-call pages bind verified human scope and incarnation, forward canonical bounded pagination only, and reject malformed, ambiguous, unauthenticated and nonhuman requests before authority reads; role checks remain at the real authority');

  const invalidClaims: [string, Record<string, unknown>, string[]?][] = [
    ['wrong issuer', { iss: issuer + '/other' }], ['wrong audience', { aud: 'other-audience' }], ['expired', { iat: time - 120, exp: time - 60 }], ['future not-before', { nbf: time + 120 }], ['future issued-at', { iat: time + 120, exp: time + 240 }], ['expiry before issued-at', { iat: time - 30, exp: time - 31 }],
    ['future authentication time', { auth_time: time + 120 }], ['authentication after issuance', { auth_time: time - 20 }], ['fractional authentication time', { auth_time: time - 60.5 }], ['negative authentication time', { auth_time: -1 }], ['string authentication time', { auth_time: String(time - 60) }], ['null authentication time', { auth_time: null }],
    ['missing subject', {}, ['sub']], ['empty subject', { sub: '' }], ['nonstring subject', { sub: 3 }], ['oversized subject', { sub: 'x'.repeat(1025) }], ['control character subject', { sub: 'user\u0000alias' }], ['missing issued-at', {}, ['iat']], ['nonnumber issued-at', { iat: 'yesterday' }], ['fractional issued-at', { iat: time - 30.5 }], ['negative issued-at', { iat: -1 }], ['missing expiry', {}, ['exp']], ['nonnumber expiry', { exp: 'tomorrow' }], ['fractional expiry', { exp: time + 600.5 }], ['unsafe integer expiry', { exp: Number.MAX_SAFE_INTEGER + 1 }], ['wrong tenant', { tenant_id: 'different-tenant' }], ['nonstring tenant', { tenant_id: 7 }],
  ];
  for (const [name, overrides, omit] of invalidClaims) await expect(name, '/api/state', 401, { token: await token(overrides, omit), code: 'AUTHENTICATION_FAILED', forwards: 0 });
  const wrongSignature = await new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid }).sign(wrongPair.privateKey);
  await expect('wrong signature', '/api/state', 401, { token: wrongSignature, code: 'AUTHENTICATION_FAILED', forwards: 0 });
  const damaged = valid.split('.'); damaged[1] = Buffer.from(JSON.stringify({ ...claims, sub: 'changed-after-signing' })).toString('base64url');
  await expect('altered signed payload', '/api/state', 401, { token: damaged.join('.'), code: 'AUTHENTICATION_FAILED', forwards: 0 });
  const hmac = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid }).sign(new Uint8Array(32));
  await expect('disallowed HMAC algorithm', '/api/state', 401, { token: hmac, code: 'AUTHENTICATION_FAILED', forwards: 0 });
  await expect('unsigned none algorithm', '/api/state', 401, { token: Buffer.from('{"alg":"none"}').toString('base64url') + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.', code: 'AUTHENTICATION_FAILED', forwards: 0 });
  for (const oversized of ['x'.repeat(16385), '']) await expect('bounded or empty bearer ' + oversized.length, '/api/state', 401, { token: oversized, code: 'AUTHENTICATION_REQUIRED', forwards: 0 });
  await expect('oversized Access assertion', '/api/state', 401, { access: 'x'.repeat(16385), code: 'AUTHENTICATION_REQUIRED', forwards: 0 });
  await expect('invalid bearer takes precedence over valid Access assertion', '/api/state', 401, { token: 'invalid', access: valid, code: 'AUTHENTICATION_FAILED', forwards: 0 });
  await expect('required credential class on bearer', '/api/state', 401, { token: await token({}, ['principal_class']), code: 'CREDENTIAL_CLASS_REQUIRED', forwards: 0 });
  await expect('bearer email cannot imply human', '/api/state', 401, { token: await token({ email: 'owned@example.test' }, ['principal_class']), code: 'CREDENTIAL_CLASS_REQUIRED', forwards: 0 });
  const absentTenant = await expect('configured tenant when claim absent', '/_test/principal', 200, { token: await token({}, ['tenant_id']), forwards: 0 }); assert.equal(absentTenant.result.tenantId, tenant);
  checks.push('Real jose ES256 verification rejects issuer/audience/time/nbf/signature/algorithm and required-claim failures, bounds credentials and pins tenant/subject identity');

  const accessHuman = await token({ type: 'app', email: 'owned@example.test' }, ['principal_class']);
  const accessPrincipal = await expect('Verified Access email fallback', '/_test/principal', 200, { access: accessHuman, forwards: 0 }); assert.equal(accessPrincipal.result.credentialClass, 'human'); assert.equal(accessPrincipal.result.id, issuer + '#owned-subject');
  assert.equal(accessPrincipal.result.verifiedEmail, 'owned@example.test');
  for (const email of ['invalid', 'two@@example.test', ' spaced@example.test', 'a\u0000@example.test', 'a'.repeat(321) + '@example.test']) {
    await expect('Malformed signed display email', '/_test/principal', 401, { access: await token({ type: 'app', email }, ['principal_class']), code: 'AUTHENTICATION_FAILED', forwards: 0 });
  }
  for (const credentialClass of ['agent', 'service']) {
    const explicit = await token({ principal_class: credentialClass, type: 'app', email: 'owned@example.test' });
    const result = await expect('Explicit Access ' + credentialClass + ' cannot become human', '/_test/principal', 200, { access: explicit, forwards: 0 }); assert.equal(result.result.credentialClass, credentialClass);
    assert.equal(result.result.verifiedEmail, undefined);
    const approved = await expect(credentialClass + ' approval forwards verified class and preserves domain403', '/api/approve', 403, { token: explicit, method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'owned-' + credentialClass, 'if-platform-revision': '7' }, body: JSON.stringify({ proposalDigest: snapshot.reviews[0].proposalDigest, principal: { credentialClass: 'human', id: 'spoofed-human' }, caller: { principal: { credentialClass: 'human' } } }), code: 'HUMAN_REQUIRED', forwards: 2, commands: 1, principalClass: credentialClass });
    assert.equal(approved.forwards[1].body.caller.principal.id, issuer + '#owned-subject');
  }
  checks.push('Verified Access fallback identifies human by subject; explicit agent/service classes survive email and caller-body spoofing through approval transport');

  // Access application assertions use RSA and an audience array, with human
  // identity supplied by verified sub/email rather than custom app claims.
  const accessClaims = { iss: issuer, aud: ['owned-other-application', audience], sub: 'owned-access-subject', iat: time - 30, exp: time + 600, type: 'app', email: 'owned-access@example.test' };
  const signAccess = (overrides: Record<string, unknown> = {}, privateKey = rsaPair.privateKey) => new SignJWT({ ...accessClaims, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: rsaKid }).sign(privateKey);
  const rsaAccess = await signAccess();
  const rsaPrincipal = await expect('Real RS256 Access-shaped assertion', '/_test/principal', 200, { access: rsaAccess, forwards: 0 });
  assert.deepEqual(rsaPrincipal.result, { id: issuer + '#owned-access-subject', tenantId: tenant, credentialClass: 'human', verifiedEmail: 'owned-access@example.test', authentication: { issuer, subject: 'owned-access-subject', issuedAt: accessClaims.iat, expiresAt: accessClaims.exp, authenticatedAt: null } });
  const bootstrap = await expect('Closed bootstrap returns only the verified Access subject', '/api/bootstrap-identity', 200, { access: rsaAccess, forwards: 0 });
  assert.deepEqual(bootstrap.result, { bootstrapSubject: issuer + '#owned-access-subject' });
  assert.equal(bootstrap.response.headers.get('cache-control'), 'no-store');
  assert.equal(bootstrap.response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(!JSON.stringify(bootstrap.result).includes(rsaAccess));
  await expect('Bootstrap requires an Access assertion', '/api/bootstrap-identity', 401, { code: 'BOOTSTRAP_ACCESS_ASSERTION_REQUIRED', forwards: 0 });
  await expect('Bootstrap rejects bearer credentials', '/api/bootstrap-identity', 401, { token: rsaAccess, code: 'BOOTSTRAP_ACCESS_ASSERTION_REQUIRED', forwards: 0 });
  await expect('Bootstrap rejects another audience', '/api/bootstrap-identity', 401, { access: await signAccess({ aud: 'other-audience' }), code: 'AUTHENTICATION_FAILED', forwards: 0 });
  await expect('Bootstrap rejects nonapplication assertions', '/api/bootstrap-identity', 401, { access: await signAccess({ type: 'org' }), code: 'BOOTSTRAP_ACCESS_ASSERTION_REQUIRED', forwards: 0 });
  await expect('Bootstrap requires signed human email', '/api/bootstrap-identity', 401, { access: await signAccess({ email: undefined, principal_class: 'human' }), code: 'BOOTSTRAP_ACCESS_ASSERTION_REQUIRED', forwards: 0 });
  await expect('Bootstrap rejects service assertions', '/api/bootstrap-identity', 403, { access: await signAccess({ principal_class: 'service' }), code: 'BOOTSTRAP_HUMAN_REQUIRED', forwards: 0 });
  await expect('Bootstrap rejects mutation methods', '/api/bootstrap-identity', 401, { access: rsaAccess, method: 'POST', code: 'BOOTSTRAP_ACCESS_ASSERTION_REQUIRED', forwards: 0 });
  checks.push('Closed identity bootstrap exposes only the signed Access human subject, never the JWT, and sends no authority command');
  const pendingAccess = await signAccess({ sub: 'owned-pending-subject' });
  const pendingIdentity = await expect('Self identity before project membership', '/api/session', 200, { access: pendingAccess, forwards: 0, commands: 0 });
  assert.deepEqual(pendingIdentity.result, { principalId: issuer + '#owned-pending-subject', tenantId: tenant, credentialClass: 'human', projectDiscussion: false, authentication: { ...rsaPrincipal.result.authentication, subject: 'owned-pending-subject' } });
  assert.equal(pendingIdentity.response.headers.get('cache-control'), 'no-store');
  assert.equal(pendingIdentity.response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(pendingIdentity.response.headers.get('access-control-allow-origin'), null);
  await expect('Self identity does not grant project membership', '/api/state', 404, { access: pendingAccess, forwards: 1, commands: 0, code: 'PROJECT_UNAVAILABLE' });
  const ownIdentity = await expect('Self identity ignores a spoofed principal header', '/api/session', 200, { access: rsaAccess, headers: { 'if-platform-principal': 'spoofed-subject', origin, 'sec-fetch-site': 'same-origin' }, forwards: 0 });
  assert.deepEqual(ownIdentity.result, { principalId: issuer + '#owned-access-subject', tenantId: tenant, credentialClass: 'human', projectDiscussion: false, authentication: rsaPrincipal.result.authentication });
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) await expect('Self identity rejects method ' + method, '/api/session', 405, { access: rsaAccess, method, code: 'METHOD_NOT_ALLOWED', forwards: 0 });
  await expect('Self identity rejects a query selector', '/api/session?subject=other', 404, { access: rsaAccess, code: 'SESSION_IDENTITY_UNAVAILABLE', forwards: 0 });
  await expect('Self identity rejects another URL origin', '/api/session', 404, { access: rsaAccess, requestOrigin: 'https://other.owned.test', code: 'SESSION_IDENTITY_UNAVAILABLE', forwards: 0 });
  for (const headers of [{ origin: 'https://other.owned.test' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }] as Record<string, string>[]) {
    await expect('Self identity rejects cross-origin browser request', '/api/session', 404, { access: rsaAccess, headers, code: 'SESSION_IDENTITY_UNAVAILABLE', forwards: 0 });
  }
  await expect('Self identity requires signed credentials', '/api/session', 401, { code: 'AUTHENTICATION_REQUIRED', forwards: 0 });
  await expect('Self identity bearer requires explicit signed human class', '/api/session', 401, { token: rsaAccess, code: 'CREDENTIAL_CLASS_REQUIRED', forwards: 0 });
  await expect('Self identity rejects mixed credentials', '/api/session', 401, { token: rsaAccess, access: rsaAccess, code: 'SESSION_CREDENTIALS_AMBIGUOUS', forwards: 0 });
  await expect('Self identity rejects malformed Authorization header', '/api/session', 401, { access: rsaAccess, headers: { authorization: 'Basic owned-nonbearer' }, code: 'SESSION_CREDENTIALS_AMBIGUOUS', forwards: 0 });
  for (const overrides of [{ type: 'org' }, { email: undefined, principal_class: 'human' }]) {
    await expect('Self identity requires Access app and human email claims', '/api/session', 401, { access: await signAccess(overrides), code: 'BOOTSTRAP_ACCESS_ASSERTION_REQUIRED', forwards: 0 });
  }
  for (const principal_class of ['agent', 'service']) await expect('Self identity rejects ' + principal_class, '/api/session', 403, { access: await signAccess({ principal_class }), code: 'HUMAN_REQUIRED', forwards: 0 });
  for (const overrides of [{ iss: issuer + '/other' }, { aud: 'other-app' }, { exp: time - 60 }, { tenant_id: 'other-tenant' }]) {
    await expect('Self identity rejects incorrect signed scope or lifetime', '/api/session', 401, { access: await signAccess(overrides), code: 'AUTHENTICATION_FAILED', forwards: 0 });
  }
  await expect('Self identity rejects an incorrect signature', '/api/session', 401, { access: await signAccess({}, wrongRsaPair.privateKey), code: 'AUTHENTICATION_FAILED', forwards: 0 });
  checks.push('Access-app or explicitly classified signed bearer human self identity is same-origin, read-only, pre-membership and token/email-free; query, method, mixed credentials, nonhuman and invalid signed claims stay local');
  const rsaState = await expect('RS256 Access authenticated application state', '/api/state', 200, { access: rsaAccess, forwards: 1, principalClass: 'human' });
  assert.deepEqual(rsaState.result.session, { principalId: issuer + '#owned-access-subject', credentialClass: 'human' });
  for (const [name, signed] of [
    ['RS256 Access wrong issuer', await signAccess({ iss: issuer + '/other' })],
    ['RS256 Access wrong audience array', await signAccess({ aud: ['owned-other-application'] })],
    ['RS256 Access wrong signature', await signAccess({}, wrongRsaPair.privateKey)],
  ]) await expect(name, '/api/state', 401, { access: signed, code: 'AUTHENTICATION_FAILED', forwards: 0 });
  await expect('RS256 Access human mutation requires Origin', '/v1/projects/owned-project/reconcile-publication', 403, { access: rsaAccess, method: 'POST', headers: { ...mutationHeaders, origin: '' }, body: '{}', code: 'ORIGIN_REQUIRED', forwards: 0 });
  const rsaMutation = await expect('RS256 Access guarded mutation forwards verified subject', '/v1/projects/owned-project/reconcile-publication', 202, { access: rsaAccess, method: 'POST', headers: { ...mutationHeaders, 'idempotency-key': 'owned-access-command', 'if-platform-principal': issuer + '#owned-access-subject', 'if-platform-incarnation': 'owned-incarnation' }, body: '{"publicationId":"owned-publication"}', forwards: 1, commands: 1, principalClass: 'human' });
  assert.deepEqual(rsaMutation.forwards[0].body.caller, { principal: rsaPrincipal.result, projectId: 'owned-project' });
  assert.deepEqual(rsaMutation.forwards[0].body.command.body, { publicationId: 'owned-publication' });
  assert.equal(rsaMutation.forwards[0].body.command.expectedIncarnation, 'owned-incarnation');
  await expect('RS256 service-shaped assertion cannot imply human', '/api/state', 401, { access: await signAccess({ email: undefined, common_name: 'owned-service-token' }), code: 'CREDENTIAL_CLASS_REQUIRED', forwards: 0 });
  for (const [name, overrides] of [
    ['Unrecognised explicit Access class', { principal_class: 'operator' }],
    ['Null explicit Access class', { principal_class: null }],
    ['Empty Access email', { email: '' }],
    ['Nonapplication Access email cannot imply human', { type: 'org' }],
    ['Access email without application type cannot imply human', { type: undefined }],
  ] as [string, Record<string, unknown>][]) await expect(name, '/api/state', 401, { access: await signAccess(overrides), code: 'CREDENTIAL_CLASS_REQUIRED', forwards: 0 });
  checks.push('Actual workerd verifies owned RSA2048/RS256 Access-shaped assertions from /cdn-cgi/access/certs, matches audience arrays without custom tenant/class claims, derives human identity from verified sub, rejects issuer/audience/signature failures and guards mutation forwarding');

  const duplicated = '{"sub":"discarded",' + JSON.stringify(claims).slice(1);
  const escapedDuplicate = '{"\\u0073ub":"discarded",' + JSON.stringify(claims).slice(1);
  const duplicateHeader = '{"alg":"HS256","alg":"ES256","kid":"' + kid + '"}';
  for (const [name, signed] of [['Duplicate signed subject', await rawJwt(duplicated)], ['Escaped duplicate signed subject', await rawJwt(escapedDuplicate)], ['Duplicate signed algorithm', await rawJwt(JSON.stringify(claims), duplicateHeader)]]) await expect(name, '/api/state', 401, { token: signed, code: 'AUTHENTICATION_FAILED', forwards: 0 });
  for (const [name, payload, header] of [
    ['Signed null payload', 'null', undefined], ['Signed array payload', '[]', undefined],
    ['Signed null header', JSON.stringify(claims), 'null'], ['Signed array header', JSON.stringify(claims), '[]'],
    ['Signed nonfinite expiry', JSON.stringify(claims).replace(`"exp":${claims.exp}`, '"exp":1e309'), undefined],
  ]) await expect(name!, '/api/state', 401, { token: await rawJwt(payload!, header), code: 'AUTHENTICATION_FAILED', forwards: 0 });
  checks.push('Validly signed duplicate JWT payload/header members, including escaped aliases, cannot be erased by parsing before identity interpretation');

  const v1Path = '/v1/projects/owned-project/reconcile-publication';
  for (const [name, headers, code, status] of [
    ['missing Origin', { ...mutationHeaders, origin: '' }, 'ORIGIN_REQUIRED', 403], ['cross Origin', { ...mutationHeaders, origin: 'https://outside.owned.test' }, 'ORIGIN_REQUIRED', 403], ['Origin trailing slash', { ...mutationHeaders, origin: origin + '/' }, 'ORIGIN_REQUIRED', 403], ['missing CSRF', { ...mutationHeaders, 'x-platform-csrf': '' }, 'CSRF_HEADER_REQUIRED', 403], ['wrong CSRF', { ...mutationHeaders, 'x-platform-csrf': 'true' }, 'CSRF_HEADER_REQUIRED', 403], ['non JSON', { ...mutationHeaders, 'content-type': 'text/plain' }, 'JSON_REQUIRED', 415], ['JSON prefix', { ...mutationHeaders, 'content-type': 'application/jsonp' }, 'JSON_REQUIRED', 415],
  ] as [string, Record<string, string>, string, number][]) for (const path of [v1Path, '/api/reconcile', '/api/projects', '/api/projects/second-project/update']) await expect(name + ' ' + path, path, status, { token: valid, method: 'POST', headers, body: '{}', code, forwards: 0 });
  const spoof = { caller: { principal: { id: 'spoofed-human', tenantId: 'wrong-tenant', credentialClass: 'service' }, projectId: 'spoofed-project' }, principal: { id: 'other-user' }, tenantId: 'other-tenant', projectId: 'other-project', operation: 'request-publication' };
  const forwarded = await expect('Human guarded v1 command ignores caller-body identity', v1Path, 202, { token: valid, method: 'POST', headers: { ...mutationHeaders, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(spoof), forwards: 1, commands: 1, principalClass: 'human' });
  assert.deepEqual(forwarded.forwards[0].body.caller, { principal: principal.result, projectId: 'owned-project' }); assert.equal(forwarded.forwards[0].body.command.operation, 'reconcile-publication'); assert.deepEqual(forwarded.forwards[0].body.command.body, spoof);
  for (const path of [v1Path, '/api/reconcile']) {
    await expect('Duplicate control JSON rejected ' + path, path, 400, { token: valid, method: 'POST', headers: mutationHeaders, body: '{"intent":"first","intent":"second"}', code: 'INVALID_CONTROL_JSON', forwards: 0, commands: 0 });
    await expect('Escaped duplicate control JSON rejected ' + path, path, 400, { token: valid, method: 'POST', headers: mutationHeaders, body: '{"intent":1,"\\u0069ntent":2}', code: 'INVALID_CONTROL_JSON', forwards: 0, commands: 0 });
    for (const [body, code] of [['{malformed', 'INVALID_CONTROL_JSON'], ['null', 'CONTROL_OBJECT_REQUIRED'], ['[]', 'CONTROL_OBJECT_REQUIRED']]) await expect('Malformed or nonobject control rejected ' + path + ' ' + body, path, 400, { token: valid, method: 'POST', headers: mutationHeaders, body, code, forwards: 0, commands: 0 });
    await expect('Oversized control JSON rejected ' + path, path, 413, { token: valid, method: 'POST', headers: mutationHeaders, body: JSON.stringify({ padding: 'x'.repeat(controlBytes) }), code: 'SIZE_LIMIT', forwards: 0, commands: 0 });
  }
  checks.push('Human state changes require exact Origin/CSRF/JSON, reject duplicate and bounded control bodies before authority, and derive caller from verified credentials plus scoped path');

  const collaborationHeaders = { ...mutationHeaders, 'if-platform-principal': issuer + '#owned-subject', 'if-platform-incarnation': 'owned-incarnation' };
  const session = await expect('Own session has no project dependency', '/api/session', 200, { token: valid, forwards: 0 });
  assert.deepEqual(session.result, { principalId: principal.result.id, tenantId: tenant, credentialClass: 'human', projectDiscussion: false, authentication: principal.result.authentication });
  for (const name of ['members', 'invitations', 'scope', 'revision', 'projectId']) assert.equal(name in session.result, false);
  const collaboration = await expect('Protected collaboration read uses narrow backend', '/api/collaboration', 200, { token: valid, forwards: 1 });
  assert.equal(collaboration.forwards[0].path, '/internal/collaboration');
  assert.deepEqual(collaboration.forwards[0].body, { caller: { principal: principal.result, projectId: 'owned-project' } });
  for (const read of [session, collaboration]) {
    assert.equal(read.response.headers.get('cache-control'), 'no-store');
    assert.equal(read.response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(read.response.headers.get('x-content-type-options'), 'nosniff');
  }
  const guestToken = await token({ sub: 'owned-guest' });
  const guestSession = await expect('Nonmember session has only own verified identity', '/api/session', 200, { token: guestToken, forwards: 0 });
  assert.equal(guestSession.result.principalId, issuer + '#owned-guest');
  await expect('Nonmember cannot read member roster', '/api/collaboration', 404, { token: guestToken, forwards: 1, code: 'REFERENCE_UNAVAILABLE' });
  const invitationToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const accepted = await expect('Invitation acceptance bypasses only general snapshot read', '/api/collaboration/accept-invitation', 202, {
    token: guestToken, method: 'POST', headers: { ...collaborationHeaders, 'if-platform-principal': issuer + '#owned-guest', 'if-platform-revision': '0' },
    body: JSON.stringify({ invitationId: 'owned-invitation', token: invitationToken }), forwards: 1, commands: 1,
  });
  assert.equal(accepted.forwards[0].path, '/internal/collaboration-command');
  assert.equal(accepted.forwards[0].body.command.expectedIncarnation, 'owned-incarnation');
  assert.equal(accepted.forwards[0].body.command.expectedRevision, '0');
  assert.equal(accepted.forwards[0].body.caller.principal.id, issuer + '#owned-guest');
  assert.ok(!JSON.stringify(accepted.result).includes(invitationToken));
  assert.equal(accepted.response.headers.get('referrer-policy'), 'no-referrer');
  const inspected = await expect('Invitation inspection returns authority role without a project snapshot', '/api/collaboration/inspect-invitation', 200, {
    token: guestToken, method: 'POST', headers: { ...collaborationHeaders, 'if-platform-principal': issuer + '#owned-guest', 'if-platform-revision': '0' },
    body: JSON.stringify({ invitationId: 'owned-invitation', token: invitationToken }), forwards: 1, commands: 0,
  });
  assert.equal(inspected.forwards[0].path, '/internal/inspect-invitation');
  assert.equal(inspected.result.invitation.role, 'reviewer');
  assert.equal(inspected.result.invitation.recipientId, issuer + '#owned-guest');
  assert.ok(!JSON.stringify(inspected.result).includes(invitationToken));
  assert.equal(inspected.response.headers.get('cache-control'), 'no-store');
  assert.equal(inspected.response.headers.get('referrer-policy'), 'no-referrer');
  await expect('Invitation inspection requires same-origin gesture', '/api/collaboration/inspect-invitation', 403, { token: guestToken, method: 'POST', headers: { ...collaborationHeaders, 'if-platform-principal': issuer + '#owned-guest', 'if-platform-revision': '0', origin: 'https://outside.owned.test' }, body: '{}', code: 'ORIGIN_REQUIRED', forwards: 0 });
  await expect('Invitation inspection requires revision sentinel', '/api/collaboration/inspect-invitation', 400, { token: valid, method: 'POST', headers: collaborationHeaders, body: '{}', code: 'ACCEPT_REVISION_REQUIRED', forwards: 0 });
  await expect('Generic v1 cannot bypass invitation inspection binding', '/v1/projects/owned-project/inspect-invitation', 404, { token: valid, method: 'POST', headers: mutationHeaders, body: '{}', code: 'COLLABORATION_ROUTE_REQUIRED', forwards: 0 });
  for (const operation of COLLABORATION_OPERATIONS) {
    if (operation !== 'accept-invitation') {
      const command = await expect('Dedicated collaboration command ' + operation, '/api/collaboration/' + operation, 202, {
        token: valid, method: 'POST', headers: collaborationHeaders, body: JSON.stringify(spoof), forwards: 1, commands: 1,
      });
      assert.deepEqual(command.forwards[0].body.caller, { principal: principal.result, projectId: 'owned-project' });
      assert.equal(command.forwards[0].body.command.operation, operation);
      assert.deepEqual(command.forwards[0].body.command.body, spoof);
    }
    await expect('Generic v1 cannot bypass collaboration binding ' + operation, '/v1/projects/owned-project/' + operation, 404, {
      token: valid, method: 'POST', headers: mutationHeaders, body: '{}', code: 'COLLABORATION_ROUTE_REQUIRED', forwards: 0,
    });
  }
  const scopedCollaboration = await expect('Selected project collaboration reads only selected authority', '/api/projects/second-project/collaboration', 200, { token: valid, forwards: 1 });
  assert.deepEqual(scopedCollaboration.forwards[0].body, { caller: { principal: principal.result, projectId: 'second-project' } });
  for (const operation of [...COLLABORATION_OPERATIONS, 'inspect-invitation']) {
    const command = await expect('Selected project collaboration command ' + operation, '/api/projects/second-project/collaboration/' + operation, operation === 'inspect-invitation' ? 200 : 202, {
      token: valid, method: 'POST', headers: { ...collaborationHeaders, 'if-platform-incarnation': 'second-incarnation', 'if-platform-revision': operation === 'accept-invitation' || operation === 'inspect-invitation' ? '0' : '7' },
      body: JSON.stringify(spoof), forwards: 1, commands: operation === 'inspect-invitation' ? 0 : 1,
    });
    assert.deepEqual(command.forwards[0].body.caller, { principal: principal.result, projectId: 'second-project' });
    assert.equal(command.forwards[0].body.command.operation, operation);
    assert.equal(command.forwards[0].body.command.expectedIncarnation, 'second-incarnation');
  }
  for (const operation of ['accept-invitation', 'inspect-invitation', 'create-invitation']) {
    const denied = await expect('Selected project failure never falls back to default ' + operation, '/api/projects/inaccessible-project/collaboration/' + operation, 404, {
      token: valid, method: 'POST', headers: { ...collaborationHeaders, 'if-platform-revision': operation === 'create-invitation' ? '7' : '0' }, body: '{}', forwards: 1, code: 'PROJECT_UNAVAILABLE',
    });
    assert.equal(denied.forwards[0].body.caller.projectId, 'inaccessible-project');
  }
  const deniedScope = await expect('Selected project rejects original project incarnation', '/api/projects/second-project/collaboration/create-invitation', 409, { token: valid, method: 'POST', headers: collaborationHeaders, body: '{}', forwards: 1, code: 'PROJECT_INCAR_CHANGED' });
  assert.equal(deniedScope.forwards[0].body.caller.projectId, 'second-project');
  await expect('Selected project still verifies signed tenant', '/api/projects/second-project/collaboration', 401, { token: await token({ tenant_id: 'other-tenant' }), forwards: 0, code: 'AUTHENTICATION_FAILED' });
  for (const path of ['/api/projects/illegal.project/collaboration', '/api/projects/%2Fother/collaboration', '/api/projects//collaboration', '/api/projects/']) {
    await expect('Malformed project alias never reads default ' + path, path, 404, { token: valid, forwards: 0, code: 'PROJECT_ROUTE_INVALID' });
  }
  await expect('Self identity has no project alias', '/api/projects/second-project/session', 404, { token: valid, forwards: 0, code: 'UNSUPPORTED_ROUTE' });
  checks.push('Collaboration aliases bind the selected project for every operation; authority denial is returned without default-project fallback; wrong incarnation, signed tenant and malformed aliases stay fenced; identity discovery is unscoped');
  const collaborationPath = '/api/collaboration/create-invitation';
  for (const [name, header, value, code, status] of [
    ['missing Origin', 'origin', '', 'ORIGIN_REQUIRED', 403], ['cross Origin', 'origin', 'https://outside.owned.test', 'ORIGIN_REQUIRED', 403],
    ['missing CSRF', 'x-platform-csrf', '', 'CSRF_HEADER_REQUIRED', 403], ['wrong content type', 'content-type', 'text/plain', 'JSON_REQUIRED', 415],
    ['missing expected principal', 'if-platform-principal', undefined, 'EXPECTED_PRINCIPAL_REQUIRED', 400],
    ['changed expected principal', 'if-platform-principal', issuer + '#other-subject', 'SESSION_PRINCIPAL_CHANGED', 409],
    ['missing expected incarnation', 'if-platform-incarnation', undefined, 'EXPECTED_INCARNATION_REQUIRED', 400],
    ['invalid expected incarnation', 'if-platform-incarnation', 'bad/incarnation', 'INVALID_EXPECTED_INCARNATION', 400],
    ['missing revision', 'if-platform-revision', undefined, 'EXPECTED_REVISION_REQUIRED', 400],
    ['noncanonical revision', 'if-platform-revision', '07', 'EXPECTED_REVISION_REQUIRED', 400],
    ['missing idempotency key', 'idempotency-key', undefined, 'IDEMPOTENCY_KEY_REQUIRED', 400],
  ] as [string, string, string | undefined, string, number][]) {
    const headers: Record<string, string> = { ...collaborationHeaders };
    if (value === undefined) delete headers[header]; else headers[header] = value;
    const rejected = await expect('Collaboration ' + name, collaborationPath, status, { token: valid, method: 'POST', headers, body: '{}', code, forwards: 0 });
    assert.equal(rejected.response.headers.get('cache-control'), 'no-store');
    assert.equal(rejected.response.headers.get('referrer-policy'), 'no-referrer');
  }
  for (const credentialClass of ['agent', 'service']) await expect('Collaboration denies ' + credentialClass + ' management', collaborationPath, 403, {
    token: await token({ principal_class: credentialClass }), method: 'POST', headers: collaborationHeaders, body: '{}', code: 'HUMAN_REQUIRED', forwards: 0,
  });
  await expect('Acceptance requires revision sentinel', '/api/collaboration/accept-invitation', 400, { token: valid, method: 'POST', headers: collaborationHeaders, body: '{}', code: 'ACCEPT_REVISION_REQUIRED', forwards: 0 });
  for (const path of ['/api/session', '/api/collaboration', collaborationPath]) {
    await expect('Collaboration query cannot carry secrets ' + path, path + '?token=owned-test-secret', 404, { token: valid, code: path === '/api/session' ? 'SESSION_IDENTITY_UNAVAILABLE' : 'UNSUPPORTED_ROUTE', forwards: 0 });
    await expect('Collaboration unsupported method ' + path, path, 405, { token: valid, method: 'DELETE', code: 'METHOD_NOT_ALLOWED', forwards: 0 });
  }
  await expect('Unknown collaboration operation', '/api/collaboration/change-owner-directly', 404, { token: valid, method: 'POST', headers: collaborationHeaders, body: '{}', code: 'UNSUPPORTED_ROUTE', forwards: 0 });
  for (const [body, code] of [['{"recipientId":"first","recipientId":"second"}', 'INVALID_CONTROL_JSON'], ['null', 'CONTROL_OBJECT_REQUIRED'], ['[]', 'CONTROL_OBJECT_REQUIRED']]) await expect('Collaboration strict control body ' + code, collaborationPath, 400, { token: valid, method: 'POST', headers: collaborationHeaders, body, code, forwards: 0 });
  await expect('Collaboration control body bounded separately', collaborationPath, 413, { token: valid, method: 'POST', headers: collaborationHeaders, body: JSON.stringify({ padding: 'x'.repeat(16 * 1024) }), code: 'SIZE_LIMIT', forwards: 0 });
  checks.push('Collaboration session reveals only verified self; reads use a separate protected authority method; dedicated human commands require Origin/CSRF/JSON, principal/incarnation/revision/idempotency binding, bounded strict JSON, no query secrets and private response headers; generic v1 cannot bypass the boundary; acceptance does not pre-read the project');

  const exported = await expect('Scoped portable export forwarding', '/api/receipts/owned-receipt/export', 200, { token: valid, forwards: 1 }); assert.equal(exported.result.kind, 'bundle'); assert.equal(exported.result.publicationId, 'owned-receipt');
  for (const path of ['/api/trust-config', '/api/checkpoint', '/api/checkpoint-attestation']) await expect('Protected export ' + path, path, 200, { token: valid, forwards: 1 });
  const events = await expect('Protected SSE routed through authorized snapshot', '/api/events?since=0', 200, { token: valid, forwards: 1 }); assert.match(events.result.text, /id: 1/);
  await expect('Malformed scoped path', '/v1/projects/illegal.project/state', 404, { token: valid, code: 'SCOPED_API_REQUIRED', forwards: 0 });
  await expect('Nonexistent authenticated v1 route', '/v1/unknown', 404, { token: valid, code: 'SCOPED_API_REQUIRED', forwards: 0 });
  await expect('Unsupported method does not mutate', v1Path, 405, { token: valid, method: 'DELETE', forwards: 0 });
  await expect('Missing idempotency key', v1Path, 400, { token: valid, method: 'POST', headers: { ...mutationHeaders, 'idempotency-key': '' }, body: '{}', code: 'IDEMPOTENCY_KEY_REQUIRED', forwards: 0 });
  await expect('Noncanonical revision', v1Path, 400, { token: valid, method: 'POST', headers: { ...mutationHeaders, 'if-platform-revision': '07' }, body: '{}', code: 'EXPECTED_REVISION_REQUIRED', forwards: 0 });
  assert.ok(authorityCalls.length > 0); assert.ok(authorityCalls.every(call => call.authorizationMatches && call.contentType === 'application/json'));
  assert.ok(jwksCalls.length > 0 && jwksCalls.every(call => call.permitted));
  checks.push('Authenticated routes forward only the app service credential and JSON to owned authority; JWKS uses only the configured owned HTTPS URL');
  const beforeCachedReads = jwksCalls.length;
  for (let read = 0; read < 3; read++) await expect('Cached verified human ' + read, '/api/state', 200, { token: valid, forwards: 1 });
  assert.equal(jwksCalls.length, beforeCachedReads);
  const rotatedPair = await generateKeyPair('ES256', { extractable: true });
  const rotatedKid = 'owned-rotated-es256', rotatedKey = { ...await exportJWK(rotatedPair.publicKey), kid: rotatedKid, alg: 'ES256', use: 'sig' };
  availableKeys = [jwk, rsaJwk, rotatedKey];
  const rotatedToken = await new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: rotatedKid }).sign(rotatedPair.privateKey);
  await expect('Unknown kid during cooldown', '/api/state', 401, { token: rotatedToken, code: 'AUTHENTICATION_FAILED', forwards: 0 });
  assert.equal(jwksCalls.length, beforeCachedReads);
  await runtime.dispatchFetch(origin + '/_test/advance-clock');
  await expect('Provider key rotation after cooldown', '/api/state', 200, { token: rotatedToken, forwards: 1 });
  assert.equal(jwksCalls.length, beforeCachedReads + 1);
  jwksAvailable = false;
  await expect('Known cached key during provider outage', '/api/state', 200, { token: valid, forwards: 1 });
  await runtime.dispatchFetch(origin + '/_test/advance-clock');
  const unknownToken = await new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'owned-unavailable-key' }).sign(rotatedPair.privateKey);
  await expect('Provider outage is retryable', '/api/state', 503, { token: unknownToken, code: 'AUTH_PROVIDER_UNAVAILABLE', forwards: 0 });
  jwksAvailable = true;
  await expect('Unknown key after provider recovers', '/api/state', 401, { token: unknownToken, code: 'AUTHENTICATION_FAILED', forwards: 0 });
  checks.push('Issuer-scoped key cache avoids repeated JWKS fetches, throttles unknown kids, refreshes rotated keys and distinguishes provider outage from session rejection');
  const clockResponse = await runtime.dispatchFetch(origin + '/_test/clock');
  const clockNow = (await clockResponse.json() as { now: number }).now;
  const expiringAccess = await signAccess({ iat: clockNow - 30, exp: clockNow + 12 });
  await expect('Short-lived Access session initially accepted', '/api/state', 200, { access: expiringAccess, forwards: 1, principalClass: 'human' });
  await runtime.dispatchFetch(origin + '/_test/advance-clock');
  await expect('Previously accepted Access session expired', '/api/state', 401, { access: expiringAccess, code: 'AUTHENTICATION_FAILED', forwards: 0 });
  const nextSubject = await signAccess({ sub: 'owned-next-subject' });
  const switched = await expect('Signed second Access subject', '/api/state', 200, { access: nextSubject, forwards: 1, principalClass: 'human' });
  assert.equal(switched.result.session.principalId, issuer + '#owned-next-subject');
  await expect('Frozen browser action denies changed Access subject', '/v1/projects/owned-project/reconcile-publication', 409, {
    access: nextSubject, method: 'POST', headers: { ...mutationHeaders, 'if-platform-principal': issuer + '#owned-access-subject' },
    body: '{"publicationId":"owned-publication"}', code: 'SESSION_PRINCIPAL_CHANGED', forwards: 0, commands: 0,
  });
  checks.push('An accepted Access assertion expires on a later request despite cached provider keys, and a new signed subject cannot replay a frozen browser action');
  await runtime.setOptions(convertV4MiniflareOptions({ ...v4Options, bindings: { ...v4Options.bindings, BOOTSTRAP_IDENTITY_ENABLED: 'false' } }));
  await expect('Bootstrap disappears after subjects are configured', '/api/bootstrap-identity', 404, { access: rsaAccess, code: 'BOOTSTRAP_IDENTITY_UNAVAILABLE', forwards: 0 });
  await runtime.setOptions(convertV4MiniflareOptions({ ...v4Options, bindings: { ...v4Options.bindings, BOOTSTRAP_IDENTITY_ENABLED: 'false', MAINTENANCE_MODE: 'false' } }));
  const activeIdentity = await expect('Self identity remains available in active mode with bootstrap disabled', '/api/session', 200, { access: pendingAccess, forwards: 0 });
  assert.deepEqual(activeIdentity.result, pendingIdentity.result);

  const replicaAudience = 'owned-replica-only-application', proxy = '/api/projects/owned-project/weft/api/workspaces/owned-workspace/';
  await runtime.setOptions(convertV4MiniflareOptions({ ...v4Options, bindings: { ...v4Options.bindings, AUTH_REPLICA_AUDIENCE: replicaAudience } }));
  const mainOnly = await signAccess({ aud: [audience] }), replicaOnly = await signAccess({ aud: [replicaAudience] });
  const replicaRead = await expect('Replica-only Access assertion reaches only scoped Weft proxy', proxy + 'sync', 202, { access: replicaOnly, forwards: 1, principalClass: 'human' });
  assert.equal(replicaRead.forwards[0].body.caller.principal.id, issuer + '#owned-access-subject');
  assert.equal(replicaRead.forwards[0].path, '/internal/weft-proxy');
  await expect('Main audience cannot be copied into replica configuration', proxy + 'sync', 401, { access: mainOnly, code: 'AUTHENTICATION_FAILED', forwards: 0 });
  await expect('Replica writes preserve human-origin guard', proxy + 'prepare', 403, { access: replicaOnly, method: 'POST', body: '{}', code: 'ORIGIN_REQUIRED', forwards: 0 });
  await expect('Replica writes preserve CSRF guard', proxy + 'prepare', 403, { access: replicaOnly, method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}', code: 'CSRF_HEADER_REQUIRED', forwards: 0 });
  await expect('Replica write retains same verified human attribution', proxy + 'prepare', 202, { access: replicaOnly, method: 'POST', headers: mutationHeaders, body: '{}', forwards: 1, principalClass: 'human' });
  await expect('Replica bearer cannot infer human from Access email', proxy + 'sync', 401, { token: replicaOnly, code: 'CREDENTIAL_CLASS_REQUIRED', forwards: 0 });
  for (const path of ['/api/session', '/api/bootstrap-identity', '/api/state', '/api/projects', '/api/projects/owned-project/weft', '/api/projects/owned-project/weft/handoffs/retained-request', '/v1/projects/owned-project/state', '/api/weft/api/workspaces/owned-workspace/sync', proxy + 'sync/', proxy + 'sync?revision=1', proxy.replace('/weft/', '/weft-extra/') + 'sync']) {
    await expect('Replica cannot access main or malformed proxy route ' + path, path, 401, { access: replicaOnly, code: 'AUTHENTICATION_FAILED', forwards: 0 });
  }
  for (const path of ['/v1/projects/owned-project/submit-weft-revision', '/api/projects/owned-project/approve', '/api/projects/owned-project/publish', '/api/projects/owned-project/collaboration/set-collaborator-review']) {
    await expect('Replica cannot submit, approve, publish or change membership ' + path, path, 401, { access: replicaOnly, method: 'POST', headers: mutationHeaders, body: '{}', code: 'AUTHENTICATION_FAILED', forwards: 0, commands: 0 });
  }
  const isolatedIdentity = await expect('Main audience remains available for browser identity', '/api/session', 200, { access: mainOnly, forwards: 0 });
  assert.equal(isolatedIdentity.result.principalId, replicaRead.forwards[0].body.caller.principal.id);
  await expect('Main audience retains project view', '/api/state', 200, { access: mainOnly, forwards: 1, principalClass: 'human' });
  await expect('Isolated proxy disables the legacy unscoped alias', '/api/weft/api/workspaces/owned-workspace/sync', 404, { access: mainOnly, code: 'UNSUPPORTED_ROUTE', forwards: 0 });
  for (const aud of [[audience, replicaAudience], [replicaAudience, audience], [audience, audience], [replicaAudience, replicaAudience]]) {
    const token = await signAccess({ aud });
    const path = aud.includes(audience) ? '/api/state' : proxy + 'sync';
    await expect('Multiple audience assertions cannot cross credential surfaces ' + aud.join(','), path, 401, { access: token, code: 'AUTH_AUDIENCE_ISOLATION', forwards: 0 });
    if (aud.includes(audience) && aud.includes(replicaAudience)) await expect('Mixed audiences rejected on replica surface', proxy + 'sync', 401, { access: token, code: 'AUTH_AUDIENCE_ISOLATION', forwards: 0 });
  }
  for (const value of ['', audience, 'UNCONFIGURED']) {
    await runtime.setOptions(convertV4MiniflareOptions({ ...v4Options, bindings: { ...v4Options.bindings, AUTH_REPLICA_AUDIENCE: value } }));
    await expect('Invalid replica audience fails closed ' + (value || 'empty'), '/api/state', 503, { access: mainOnly, code: 'AUTH_CONFIGURATION', forwards: 0 });
  }
  checks.push('Optional replica Access audience preserves legacy deployments, requires distinct valid configuration and exactly one signed audience, confines replica credentials to scoped Weft routes before authority forwarding, preserves origin/CSRF and human attribution, and rejects main, mixed and malformed proxy credential use');
  await runtime.setOptions(convertV4MiniflareOptions({ ...v4Options, bindings: { ...v4Options.bindings, COLLABORATION_ONLY: 'true' } }));
  const collaborationSession = await expect('Collaboration deployment advertises its smaller human workflow', '/api/session', 200, { access: rsaAccess, forwards: 0 });
  assert.equal(collaborationSession.result.deploymentProfile, 'collaboration-only');
  assert.equal(collaborationSession.result.projectDiscussion, false);
  await expect('Deployment profile still requires authentication', '/api/session', 401, { code: 'AUTHENTICATION_REQUIRED', forwards: 0 });
  for (const flag of ['true', 'false', 'TRUE', '1', '']) {
    await runtime.setOptions(convertV4MiniflareOptions({ ...v4Options, bindings: { ...v4Options.bindings, PROJECT_HUB_ENABLED: flag } }));
    const capabilities = await expect('Discussion capability reflects only the explicit enabled hub flag ' + (flag || 'empty'), '/api/session', 200, { access: rsaAccess, forwards: 0 });
    assert.equal(capabilities.result.projectDiscussion, flag === 'true');
    assert.equal(capabilities.result.deploymentProfile, undefined);
  }
  checks.push('Authenticated session discovery advertises the isolated deployment profile and discussion only when the exact hub flag is enabled, without reading authority or changing membership');
} catch (error) { failure = String((error as Error).message).slice(0, 1200); }
finally {
  const files = ['workers/shared/auth.ts', 'workers/shared/errors.ts', 'workers/shared/deadline.ts', 'workers/app/index.ts', 'workers/app/projects.ts', 'workers/app/replica-auth.ts', 'packages/project-model/src/types.ts', 'packages/project-model/src/json.ts', 'packages/project-model/src/validation.ts', 'packages/protocol/src/collaboration.ts', 'workers/app/adapter.ts', 'workers/app/transport.ts', 'infra/test-auth/worker.ts', 'infra/auth-runtime-check.ts', 'packages/protocol/wasm/confidence_protocol_bg.wasm', 'package-lock.json'];
  const testedInputs = Object.fromEntries(await Promise.all(files.map(async path => [path, await sha256(await readFile(resolve(path)))])));
  const installedVersions = Object.fromEntries(await Promise.all(['jose', 'wrangler', 'miniflare', 'workerd'].map(async name => [name, JSON.parse(await readFile(resolve('node_modules', name, 'package.json'), 'utf8')).version])));
  const compiledModules = Object.fromEntries(await Promise.all((await readdir(output)).filter(name => /\.(js|wasm)$/.test(name)).map(async name => [name, await sha256(await readFile(join(output, name)))])));
  const report = Buffer.from(JSON.stringify({ schemaVersion: 1, status: failure ? 'FAIL' : 'PASS', runtime: 'Actual local workerd Application Worker + jose/WebCrypto ES256 and RSA2048/RS256 verification; owned simulated HTTPS JWKS and fake authority/assets services', checks, cases, testedInputs, compiledModules, versions: { node: process.version, ...installedVersions }, jwks: { issuer, audience, tenant, url: jwksUrl, publicKeyDigest: await sha256(canonicalize(jwk)), accessRsaPublicKeyDigest: await sha256(canonicalize(rsaJwk)), requests: jwksCalls.length, deniedOutbound: jwksCalls.filter(call => !call.permitted).length }, authority: { calls: authorityCalls.length, serviceCredentialsMatched: authorityCalls.every(call => call.authorizationMatches), verifiedCallerClasses: [...new Set(authorityCalls.map(call => (call.body.caller?.principal ?? call.body.principal).credentialClass))], commands: authorityCalls.filter(call => call.path === '/internal/command').map(call => ({ operation: call.body.command.operation, class: call.body.caller.principal.credentialClass, callerSubject: call.body.caller.principal.id, tenantId: call.body.caller.principal.tenantId, projectId: call.body.caller.projectId })) }, assets: assets.length, ...(failure ? { failure } : {}), limitations: ['JWKS responses travel through Miniflare outboundService; no real network, certificate/TLS, issuer configuration, live OIDC or Cloudflare Access behavior is established.', 'Tokens are real ES256 and RSA2048/RS256 signatures with ephemeral owned keys, never production credentials. No private key or token is retained in this report.', 'Authority/assets are explicitly fake trace services. Forwarded verified caller class and transport status do not prove real project role membership; the separate authority harness tests those decisions.', 'Production auth and Application logic are imported directly; only test principal/limit inspection routes and external services are supplied by the harness.', 'Never deploy this test Worker or its Wrangler configuration.'] }, null, 2));
  // The expanded audience and verified-email case inventory is retained in full.
  // This is a local evidence-file bound, not a production request allowance.
  assert.ok(report.length <= 128 * 1024); await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, report);
  await runtime.dispose(); await rm(directory, { recursive: true, force: true });
}
if (failure) { process.stderr.write(JSON.stringify({ status: 'FAIL', cases: cases.length, report: reportPath, failure }) + '\n'); process.exitCode = 1; }
else process.stdout.write(JSON.stringify({ status: 'PASS', checks: checks.length, cases: cases.length, report: reportPath, jwksTls: 'simulated-owned' }) + '\n');
