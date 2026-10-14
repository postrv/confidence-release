// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownedGit } from './owned-git.ts';

test('owned Git fixture serves real authenticated smart-Git discovery and preserves its base ref', async () => {
  const fixture = await ownedGit();
  try {
    const path = fixture.remote + '/info/refs?service=git-upload-pack';
    assert.equal((await fixture.fetch(new Request(path))).status, 403);
    const response = await fixture.fetch(new Request(path, { headers: { authorization: 'Bearer ' + fixture.token } }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /git-upload-pack-advertisement/);
    assert.ok((await response.text()).includes(fixture.base));
    assert.equal(await fixture.head(), fixture.base);
  } finally { await fixture.dispose(); }
});
