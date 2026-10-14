// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorityRuntime } from './authority-runtime.ts';

test('fresh authority enrollment ingests a real isolated Git repository without candidate rows or source publication', { timeout: 60_000 }, async () => {
  const runtime = await authorityRuntime();
  try {
    const enrolled = await runtime.enroll();
    assert.equal(enrolled.state, 'ENROLLED');
    const snapshot = await runtime.snapshot();
    assert.equal(snapshot.project.head, runtime.git.base);
    assert.deepEqual(snapshot.candidates, []);
    assert.equal(runtime.git.writes(), 0);
    assert.equal(await runtime.git.head(), runtime.git.base);
  } finally { await runtime.dispose(); }
});
