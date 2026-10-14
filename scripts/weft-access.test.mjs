// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createConfidenceAccessFetch } from './weft-access.mjs';

const origin = 'https://confidence-dev.invalid', projectId = 'weft-fixture';
const endpoint = `${origin}/api/projects/${projectId}/weft/api/workspaces/shared`;
const token = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.signature';
const headers = { Authorization: `Bearer ${token}`, Origin: origin, 'X-Platform-CSRF': '1', 'Content-Type': 'application/json' };

test('the scoped adapter forwards the unchanged application JWT using the existing Confidence CLI Access header', async () => {
  let received;
  const fetcher = createConfidenceAccessFetch({ origin, projectId }, async request => {
    received = request;
    return Response.json({ accepted: true });
  });
  const abort = new AbortController();
  const response = await fetcher(`${endpoint}/prepare`, { method: 'POST', headers, body: '{"id":"test-operation"}', signal: abort.signal, redirect: 'error' });
  assert.equal((await response.json()).accepted, true);
  assert.equal(received.url, `${endpoint}/prepare`);
  assert.equal(received.headers.get('CF-Access-Token'), token);
  assert.equal(received.headers.has('Authorization'), false);
  assert.equal(received.headers.has('CF-Access-Jwt-Assertion'), false);
  assert.equal(received.headers.get('Origin'), origin);
  assert.equal(received.headers.get('X-Platform-CSRF'), '1');
  assert.equal(received.headers.get('Content-Type'), 'application/json');
  assert.equal(await received.text(), '{"id":"test-operation"}');
  assert.equal(received.redirect, 'error');
  abort.abort(); assert.equal(received.signal.aborted, true);
  assert.equal(headers.Authorization, `Bearer ${token}`);
});

test('credentials cannot leave the configured HTTPS project proxy, including redirects and normalized path tricks', async () => {
  let calls = 0;
  const fetcher = createConfidenceAccessFetch({ origin, projectId }, async request => { calls++; assert.equal(request.redirect, 'error'); return new Response(); });
  for (const url of [
    endpoint.replace(origin, 'https://elsewhere.invalid'), endpoint.replace('https:', 'http:'),
    `${origin}/api/projects/other/weft/api/workspaces/shared/state`, `${origin}/api/state`,
    `${endpoint}/../../../other/state`, `${endpoint}/%2fstate`, `${endpoint}/state?token=unexpected`, `${endpoint}/state#fragment`,
    `${origin}/api/projects/${projectId}/weft/api/workspaces`,
  ]) await assert.rejects(fetcher(url, { headers }), /WEFT_ACCESS_DESTINATION/);
  assert.equal(calls, 0);
  await fetcher(new Request(`${endpoint}/state`, { headers, redirect: 'follow' }));
  await fetcher(`${endpoint}/state`, { headers, redirect: 'manual' });
  assert.equal(calls, 2);
});

test('missing or ambiguous credentials and application headers fail before dispatch', async () => {
  let calls = 0;
  const fetcher = createConfidenceAccessFetch({ origin, projectId }, async () => { calls++; return new Response(); });
  for (const changed of [
    { ...headers, Authorization: '' }, { ...headers, Authorization: 'Bearer not-a-jwt' },
    { ...headers, 'CF-Access-Token': token }, { ...headers, 'CF-Access-Jwt-Assertion': token },
    { ...headers, Cookie: 'CF_Authorization=other' }, { ...headers, Origin: 'https://elsewhere.invalid' },
    { ...headers, 'X-Platform-CSRF': '' },
  ]) await assert.rejects(fetcher(`${endpoint}/state`, { headers: changed }), /WEFT_ACCESS_/);
  assert.equal(calls, 0);
});

test('configuration accepts only an exact HTTPS application origin and supported project identifier', () => {
  for (const value of ['http://localhost:8787', `${origin}/`, `${origin}/path`, `${origin}?query=x`, 'https://name:password@confidence-dev.invalid']) {
    assert.throws(() => createConfidenceAccessFetch({ origin: value, projectId }), /WEFT_ACCESS_CONFIGURATION/);
  }
  for (const value of ['', '../other', 'project/name', 'project%2fother']) {
    assert.throws(() => createConfidenceAccessFetch({ origin, projectId: value }), /WEFT_ACCESS_CONFIGURATION/);
  }
});

test('explicit preload refuses missing scope before the CLI can dispatch a request', () => {
  const env = { ...process.env }; delete env.CONFIDENCE_ORIGIN; delete env.CONFIDENCE_PROJECT_ID;
  const result = spawnSync(process.execPath, ['--import', new URL('./weft-access.mjs', import.meta.url).href, '-e', 'process.stdout.write("must-not-run")'], { env, encoding: 'utf8', timeout: 5000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WEFT_ACCESS_CONFIGURATION/);
  assert.equal(result.stdout, '');
});

test('explicit configured preload installs the scoped fetch before the CLI starts', () => {
  const result = spawnSync(process.execPath, ['--import', new URL('./weft-access.mjs', import.meta.url).href, '-e',
    'fetch("data:text/plain,unscoped").then(() => process.exit(1), error => { if (error.message !== "WEFT_ACCESS_DESTINATION") process.exit(2); })'],
  { env: { ...process.env, CONFIDENCE_ORIGIN: origin, CONFIDENCE_PROJECT_ID: projectId }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
