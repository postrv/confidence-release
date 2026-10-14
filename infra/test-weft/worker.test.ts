// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorityRuntime } from './authority-runtime.ts';

test('production application rejects an unauthenticated release request before creating authority state', { timeout: 60_000 }, async () => {
  const runtime = await authorityRuntime();
  try {
    const response = await runtime.fetch('/v1/projects/' + runtime.projectId + '/submit-weft-revision', { method: 'POST', body: '{}' });
    assert.equal(response.status, 401);
    assert.equal(await runtime.git.head(), runtime.git.base);
  } finally { await runtime.dispose(); }
});
