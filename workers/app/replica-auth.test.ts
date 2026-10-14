// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { initializeKernel } from '../../packages/protocol/src/node';
import { authenticate, type AuthConfig } from '../shared/auth';
import { isWeftReplicaRequest } from './replica-auth';

const origin = 'https://replica-auth.owned.test';
const proxy = '/api/projects/owned-project/weft/api/workspaces/owned-workspace/';
const env: AuthConfig = { AUTH_ISSUER: 'https://replica-issuer.owned.test', AUTH_AUDIENCE: 'main-application', AUTH_REPLICA_AUDIENCE: 'replica-application', AUTH_JWKS_URL: 'https://replica-issuer.owned.test/keys', AUTH_TENANT_ID: 'owned-tenant', APP_ORIGIN: origin };
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
const originalFetch = globalThis.fetch;
before(async () => {
  await initializeKernel();
  pair = await generateKeyPair('ES256', { extractable: true });
  const key = { ...await exportJWK(pair.publicKey), kid: 'replica-auth-test', alg: 'ES256', use: 'sig' };
  globalThis.fetch = async target => {
    assert.equal(String(target), env.AUTH_JWKS_URL);
    return Response.json({ keys: [key] });
  };
});
after(() => { globalThis.fetch = originalFetch; });

async function request(aud: string | string[], path = '/api/state', overrides: Record<string, unknown> = {}): Promise<Request> {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ iss: env.AUTH_ISSUER, aud, sub: 'same-person', type: 'app', email: 'synthetic@example.invalid', iat: now - 1, exp: now + 60, ...overrides }).setProtectedHeader({ alg: 'ES256', kid: 'replica-auth-test' }).sign(pair.privateKey);
  return new Request(origin + path, { headers: { 'cf-access-jwt-assertion': token } });
}

test('only normalized scoped Weft proxy shapes select the replica audience', () => {
  for (const suffix of ['sync', 'sync/revisions/7/provenance', 'operations/operation-1', 'prepare']) {
    for (const method of ['GET', 'POST']) assert.equal(isWeftReplicaRequest(new Request(origin + proxy + suffix, { method }), origin), true);
  }
  for (const path of ['/api/weft/api/workspaces/owned-workspace/sync', '/api/projects/owned-project/weft', '/api/projects/owned-project/weft/handoffs/id', '/api/projects/owned-project/weft/submit', '/api/projects/owned-project/approve', '/api/session', proxy, proxy + 'sync?revision=7', proxy + 'sync/', proxy + 'sync//revisions/7', proxy + 'sync%2frevisions/7', proxy.replace('owned-project', 'bad.project') + 'sync', '/api/projects/owned-project/weft-extra/api/workspaces/owned-workspace/sync', proxy + 'a'.repeat(241)]) {
    assert.equal(isWeftReplicaRequest(new Request(origin + path), origin), false, path);
  }
  assert.equal(isWeftReplicaRequest(new Request('https://other.owned.test' + proxy + 'sync'), origin), false);
  assert.equal(isWeftReplicaRequest(new Request(origin + proxy + 'sync', { method: 'DELETE' }), origin), false);
});

test('distinct verified audiences preserve human attribution while denying cross-surface and mixed credentials', async () => {
  const main = await authenticate(await request(env.AUTH_AUDIENCE), env);
  const replica = await authenticate(await request([env.AUTH_REPLICA_AUDIENCE!], proxy + 'sync'), env, { replicaOnly: true });
  assert.equal(replica.id, main.id);
  assert.equal(replica.credentialClass, 'human');
  assert.equal(replica.authentication?.issuer, env.AUTH_ISSUER);
  assert.equal(replica.authentication?.subject, 'same-person');
  await assert.rejects(authenticate(await request(env.AUTH_REPLICA_AUDIENCE!), env), /AUTHENTICATION_FAILED/);
  await assert.rejects(authenticate(await request(env.AUTH_AUDIENCE, proxy + 'sync'), env, { replicaOnly: true }), /AUTHENTICATION_FAILED/);
  for (const aud of [[env.AUTH_AUDIENCE, env.AUTH_REPLICA_AUDIENCE!], [env.AUTH_AUDIENCE, env.AUTH_AUDIENCE], [env.AUTH_REPLICA_AUDIENCE!, env.AUTH_REPLICA_AUDIENCE!]]) {
    const replicaOnly = !aud.includes(env.AUTH_AUDIENCE);
    await assert.rejects(authenticate(await request(aud), env, { replicaOnly }), /AUTH_AUDIENCE_ISOLATION/);
  }
  await assert.rejects(authenticate(await request(env.AUTH_REPLICA_AUDIENCE!, proxy + 'sync', { iss: 'https://other.owned.test' }), env, { replicaOnly: true }), /AUTHENTICATION_FAILED/);
});

test('invalid configured replica audiences fail closed and omission preserves existing audience behavior', async () => {
  for (const value of ['', env.AUTH_AUDIENCE, 'a'.repeat(513), ' contains spaces ', 'UNCONFIGURED']) {
    const invalid = { ...env, AUTH_REPLICA_AUDIENCE: value };
    await assert.rejects(authenticate(await request(env.AUTH_AUDIENCE), invalid), /AUTH_CONFIGURATION/);
  }
  const { AUTH_REPLICA_AUDIENCE: _replica, ...legacy } = env;
  const multi = await request(['legacy-extra-audience', env.AUTH_AUDIENCE]);
  assert.equal((await authenticate(multi, legacy)).id, env.AUTH_ISSUER + '#same-person');
  assert.equal((await authenticate(multi, legacy, { replicaOnly: true })).id, env.AUTH_ISSUER + '#same-person');
  const agent = await authenticate(await request(env.AUTH_AUDIENCE, '/api/state', { principal_class: 'agent' }), env);
  assert.equal(agent.credentialClass, 'agent');
});
