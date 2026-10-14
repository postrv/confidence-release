// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { serveCollaborationApp } from './profile';
test('closed application serves the UI but never dispatches any API; open profile still refuses release authority', async () => {
  let calls = 0; const serve = async () => { calls++; return Response.json({ served: true }); };
  assert.equal((await serveCollaborationApp(new Request('https://owned.test/'), true, serve)).status, 200);
  for (const path of ['/api/session', '/api/projects', '/api/projects/p/agent/messages'])
    assert.equal((await serveCollaborationApp(new Request(`https://owned.test${path}`), true, serve)).status, 503);
  assert.equal(calls, 1);
  for (const path of ['/api/projects/p/approve', '/api/projects/p/publish', '/v1/enroll'])
    assert.equal((await serveCollaborationApp(new Request(`https://owned.test${path}`), false, serve)).status, 404);
  assert.equal(calls, 1);
  assert.equal((await serveCollaborationApp(new Request('https://owned.test/api/projects'), false, serve)).status, 200);
  assert.equal(calls, 2);
});
