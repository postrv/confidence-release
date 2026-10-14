// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { serveCollaborationAuthority } from './profile';
test('private route filtering refuses release and import effects before dispatch and preserves allowed command bodies', async () => {
  let calls = 0; const serve = async () => { calls++; return Response.json({ served: true }); };
  for (const path of ['/internal/enroll', '/internal/command', '/internal/runner/git'])
    assert.equal((await serveCollaborationAuthority(new Request(`https://owned.test${path}`), serve)).status, 404);
  for (const operation of ['import', 'checks', 'cancel-import']) {
    const request = new Request('https://owned.test/internal/projects/command', { method: 'POST', body: JSON.stringify({ command: { operation } }) });
    assert.equal((await serveCollaborationAuthority(request, serve)).status, 404);
  }
  assert.equal(calls, 0);
  const request = new Request('https://owned.test/internal/projects/command', { method: 'POST', body: JSON.stringify({ command: { operation: 'update' } }) });
  await serveCollaborationAuthority(request, async () => { assert.equal((await request.json() as any).command.operation, 'update'); return serve(); });
  assert.equal(calls, 1);
});
