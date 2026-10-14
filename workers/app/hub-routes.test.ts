// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentHubRoute, humanHubRoute } from './hub-routes';
import type { Principal } from '../shared/auth';

const origin = 'https://confidence.owned.test';
const human: Principal = { id: 'issuer#alice', tenantId: 'tenant', credentialClass: 'human' };
function fixture() {
  const calls: { path: string; body: any }[] = [];
  const env = { APP_ORIGIN: origin, PROJECT_HUB_ENABLED: 'true', APP_SERVICE_TOKEN: 'private-service-secret',
    AUTHORITY: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-service-secret');
      calls.push({ path: String(input), body: JSON.parse(String(init?.body)) }); return Response.json({ ok: true });
    } } as Fetcher };
  const headers = { authorization: `Bearer ${'A'.repeat(43)}`, 'x-confidence-connection': 'local-1', 'if-platform-incarnation': 'incarnation' };
  return { env, calls, headers };
}
test('opaque agent credentials reach only a scoped hub authority and never a general command', async () => {
  const f = fixture();
  const response = await agentHubRoute(new Request(`${origin}/api/projects/project/agent/messages?after=12`, { headers: f.headers }), f.env);
  assert.equal(response?.status, 200); assert.equal(f.calls[0]!.path, 'https://authority.internal/internal/project-agent');
  assert.deepEqual(f.calls[0]!.body, { projectId: 'project', credentials: { projectId: 'project', projectIncarnation: 'incarnation', connectionId: 'local-1', token: 'A'.repeat(43) }, operation: 'messages', after: '12' });
  for (const suffix of ['approve', 'publish', 'connections', 'messages/extra']) {
    await assert.rejects(agentHubRoute(new Request(`${origin}/api/projects/project/agent/${suffix}`, { headers: f.headers }), f.env), /UNSUPPORTED_ROUTE/);
  }
  assert.equal(f.calls.length, 1);
});
test('agent routes reject missing credentials, wrong origin, duplicate query, mutations outside messages and disabled deployments', async () => {
  const f = fixture(), url = `${origin}/api/projects/project/agent/messages`;
  for (const headers of [{}, { ...f.headers, authorization: 'Bearer general.jwt.token' }, { ...f.headers, origin: 'https://evil.test' }, { ...f.headers, 'if-platform-incarnation': '../other' }]) {
    await assert.rejects(agentHubRoute(new Request(url, { headers }), f.env));
  }
  await assert.rejects(agentHubRoute(new Request(`${url}?after=1&after=2`, { headers: f.headers }), f.env), /HUB_QUERY_INVALID/);
  await assert.rejects(agentHubRoute(new Request(url, { headers: f.headers }), { ...f.env, PROJECT_HUB_ENABLED: 'false' }), /UNSUPPORTED_ROUTE/);
  await assert.rejects(agentHubRoute(new Request(`${origin}/api/projects/project/agent/dependencies/weft`, { method: 'POST', headers: f.headers }), f.env), /METHOD_NOT_ALLOWED/);
  assert.equal(f.calls.length, 0);
});
test('human hub mutations preserve CSRF, expected identity and incarnation; joins derive the actor from authentication', async () => {
  const f = fixture();
  const headers = { origin, 'content-type': 'application/json', 'x-platform-csrf': '1', 'if-platform-principal': human.id, 'if-platform-incarnation': 'incarnation', 'idempotency-key': 'join-1' };
  await humanHubRoute(new Request(`${origin}/api/projects/project/join-requests`, { method: 'POST', headers, body: '{}' }), f.env, human);
  assert.deepEqual(f.calls[0]!.body, { caller: { principal: human, projectId: 'project' }, request: { requestId: 'join-1', expectedIncarnation: 'incarnation', body: {} } });
  await assert.rejects(humanHubRoute(new Request(`${origin}/api/projects/project/hub/messages`, { method: 'POST', headers: { ...headers, 'if-platform-principal': 'other' }, body: '{}' }), f.env, human), /SESSION_PRINCIPAL_CHANGED/);
  await assert.rejects(humanHubRoute(new Request(`${origin}/api/projects/project/hub/messages`, { method: 'POST', headers: { ...headers, origin: 'https://evil.test' }, body: '{}' }), f.env, human), /ORIGIN_REQUIRED/);
  assert.equal(f.calls.length, 1);
});
