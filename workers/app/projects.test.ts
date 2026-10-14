// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { projectApiScope, projectManagementRoute } from './projects';
import type { Principal } from '../shared/auth';

const principal: Principal = { id: 'issuer#owner', tenantId: 'tenant', credentialClass: 'human' };
const origin = 'https://app.example';
function fixture() {
  const calls: { path: string; body: any }[] = [];
  const env = { AUTH_ISSUER: 'https://issuer.example', AUTH_AUDIENCE: 'app', AUTH_JWKS_URL: 'https://issuer.example/keys', AUTH_TENANT_ID: 'tenant', APP_ORIGIN: origin,
    APP_SERVICE_TOKEN: 'private-service', DEFAULT_PROJECT_ID: 'legacy', AUTHORITY: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init!.body)) });
      assert.equal(new Headers(init!.headers).get('authorization'), 'Bearer private-service');
      return Response.json({ projectId: 'new-project' }, { status: 201 });
    } } as Fetcher };
  return { calls, env };
}
function command(path: string, body: string = '{}', headers: Record<string, string> = {}) {
  return new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-platform-csrf': '1', 'idempotency-key': 'intent-1', 'if-platform-revision': '3', 'if-platform-incarnation': 'incarnation-a', ...headers }, body });
}

test('directory and management bind verified identity and explicitly selected project', async () => {
  const { env, calls } = fixture();
  await projectManagementRoute(new Request(origin + '/api/projects'), env, principal);
  await projectManagementRoute(new Request(origin + '/api/projects/second'), env, principal);
  await projectManagementRoute(command('/api/projects/second/update', '{"name":"Renamed","description":"Details"}'), env, principal);
  assert.deepEqual(calls.map(item => item.path), ['/internal/projects/list', '/internal/projects/get', '/internal/projects/command']);
  assert.deepEqual(calls[0]!.body, { principal, defaultProjectId: 'legacy' });
  assert.deepEqual(calls[2]!.body, { caller: { principal, projectId: 'second' }, command: { commandId: 'intent-1', expectedRevision: '3', expectedIncarnation: 'incarnation-a', operation: 'update', body: { name: 'Renamed', description: 'Details' } } });
});

test('project management enforces human origin, CSRF, immutable intent context and strict JSON', async () => {
  const { env, calls } = fixture();
  const cases = [
    [command('/api/projects', '{}', { origin: 'https://other.example' }), 'ORIGIN_REQUIRED'],
    [command('/api/projects', '{}', { 'x-platform-csrf': '' }), 'CSRF_HEADER_REQUIRED'],
    [command('/api/projects', '{}', { 'idempotency-key': '' }), 'IDEMPOTENCY_KEY_REQUIRED'],
    [command('/api/projects/a/update', '{}', { 'if-platform-revision': '' }), 'EXPECTED_REVISION_REQUIRED'],
    [command('/api/projects/a/update', '{}', { 'if-platform-incarnation': '' }), 'EXPECTED_INCARNATION_REQUIRED'],
    [command('/api/projects', '{"name":"one","name":"two"}'), 'INVALID_PROJECT_JSON'],
    [command('/api/projects?projectId=other'), 'PROJECT_QUERY_INVALID'],
  ] as const;
  for (const [request, error] of cases) await assert.rejects(() => projectManagementRoute(request, env, principal), new RegExp(error));
  await assert.rejects(() => projectManagementRoute(new Request(origin + '/api/projects'), env, { ...principal, credentialClass: 'agent' }), /HUMAN_REQUIRED/);
  assert.equal(calls.length, 0);
});

test('import path supports archives over the signed control ceiling and forwards unchanged values', async () => {
  const { env, calls } = fixture(); const data = 'A'.repeat(8 * 1024 * 1024 + 32);
  const response = await projectManagementRoute(command('/api/projects/import-target/import', JSON.stringify({ archive: { data } })), env, principal);
  assert.equal(response?.status, 201); assert.equal(calls[0]!.body.command.body.archive.data, data);
  assert.equal(response?.headers.get('cache-control'), 'no-store');
  await assert.rejects(() => projectManagementRoute(command('/api/projects/import-target/import', ' '.repeat(16 * 1024 * 1024) + '{}'), env, principal), /SIZE_LIMIT/);
});

test('native aliases preserve project for every read and command without rewriting unscoped URLs', () => {
  for (const suffix of ['state', 'demo', 'select', 'review', 'approve', 'publish', 'reconcile', 'candidates/id/source', 'receipts/id/export', 'trust-config', 'checkpoint-attestation', 'collaboration', 'collaboration/create-invitation', 'collaboration/accept-invitation']) {
    assert.deepEqual(projectApiScope(`/api/projects/second/${suffix}`, 'legacy'), { projectId: 'second', pathname: `/api/${suffix}` });
  }
  assert.deepEqual(projectApiScope('/api/state', 'legacy'), { projectId: 'legacy', pathname: '/api/state' });
  for (const path of ['/api/projects/illegal.project/collaboration', '/api/projects//collaboration', '/api/projects/']) assert.throws(() => projectApiScope(path, 'legacy'), /PROJECT_ROUTE_INVALID/);
});

test('imported source reads bind human identity, exact source pins and inert paths', async () => {
  const { env, calls } = fixture();
  const sourceRequest = { incarnation: 'incarnation-a', archive: 'sha256:' + 'a'.repeat(64), view: 'file', path: 'unicode/שלום\\file\n.ts' };
  const query = new URLSearchParams(sourceRequest), url = origin + '/api/projects/second/source?' + query;
  const result = await projectManagementRoute(new Request(url), env, principal);
  assert.equal(result?.headers.get('cache-control'), 'no-store');
  assert.equal(result?.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(calls[0], { path: '/internal/projects/source', body: { caller: { principal, projectId: 'second' }, sourceRequest } });
  await assert.rejects(() => projectManagementRoute(new Request(url, { headers: { 'sec-fetch-site': 'cross-site' } }), env, principal), /SOURCE_ORIGIN_DENIED/);
  await assert.rejects(() => projectManagementRoute(new Request(url), env, { ...principal, credentialClass: 'agent' }), /HUMAN_REQUIRED/);
  await assert.rejects(() => projectManagementRoute(new Request(url + '&view=tree'), env, principal), /QUERY_INVALID/);
  await assert.rejects(() => projectManagementRoute(new Request(url, { method: 'POST' }), env, principal), /METHOD_NOT_ALLOWED/);
  assert.equal(calls.length, 1);
});
