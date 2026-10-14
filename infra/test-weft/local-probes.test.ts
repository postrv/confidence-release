// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownedGit } from './owned-git.ts';
import { measureLocalCandidate } from './local-probes.ts';

test('real external checks report the bounded fixture failure, without synthetic PASS observations', { timeout: 60_000 }, async () => {
  const fixture = await ownedGit();
  try {
    const source = await fixture.git.files(fixture.base);
    const result = await measureLocalCandidate(fixture.git, { id: 'owned-baseline', digest: 'sha256:' + '1'.repeat(64), commit: fixture.base, commitBytesDigest: 'sha256:' + '2'.repeat(64), manifestDigest: 'sha256:' + '3'.repeat(64), parent: '' }, fixture.directory);
    assert.equal(result.observations.length, 9);
    assert.ok(result.observations.some(item => item.outcome === 'FAIL'));
    assert.ok(result.observations.every(item => item.runtimeObservation?.terminationObserved));
    assert.deepEqual(await fixture.git.files(fixture.base), source);
  } finally { await fixture.dispose(); }
});
