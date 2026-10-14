// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { weftRuntime, WEFT_REVISION } from './weft-runtime.ts';

test('pinned Weft retains the selection while independent sessions share one daemon and a second replica applies later work', { timeout: 120_000 }, async () => {
  const sourceBase = { repo: 'owned-source', repositoryId: 'owned-source-identity', branch: 'main', oid: '1'.repeat(40) };
  const runtime = await weftRuntime({ 'hello.mjs': { text: 'export const value = "initial";\n', mode: 0o100644 }, 'other.mjs': { text: 'export const other = "initial";\n', mode: 0o100644 } }, { sourceBase });
  try {
    assert.equal(runtime.sourceRevision, WEFT_REVISION);
    const [first, second] = await Promise.all([
      runtime.session('owned-session-one', { kind: 'replace', path: 'hello.mjs', oldText: 'initial', newText: 'selected' }),
      runtime.session('owned-session-two', { kind: 'replace', path: 'other.mjs', oldText: 'initial', newText: 'shared' }),
    ]);
    assert.equal(first.state, 'accepted'); assert.equal(second.state, 'accepted');
    const selectedRevision = Math.max(first.acceptedRevision, second.acceptedRevision);
    const frozen = await runtime.selection(selectedRevision);
    const provenance = await runtime.client.call(`sync/revisions/${selectedRevision}/provenance`);
    assert.deepEqual(provenance.sourceBase, sourceBase); assert.equal(provenance.publicationMode, 'external');
    assert.equal(provenance.sourcesBindingPresent, false); assert.equal(provenance.sourcePublicationAvailable, false);
    assert.equal(provenance.root, frozen.manifest.root);
    const later = await runtime.session('owned-session-one', { kind: 'replace', path: 'hello.mjs', oldText: 'selected', newText: 'later' });
    assert.equal(later.state, 'accepted'); assert.ok(later.acceptedRevision > selectedRevision);
    const peer = await runtime.syncPeer();
    assert.equal(peer.appliedRevision, later.acceptedRevision);
    assert.match(await readFile(join(runtime.peer, 'hello.mjs'), 'utf8'), /later/);
    assert.deepEqual(await runtime.selection(selectedRevision), frozen);
    assert.deepEqual(await runtime.client.call(`sync/revisions/${selectedRevision}/provenance`), provenance);
    const evidence = await runtime.evidence();
    const concurrent = evidence.independentSessions.slice(0, 2);
    assert.equal(new Set(concurrent.map(item => item.pid)).size, 2);
    assert.ok(Math.max(...concurrent.map(item => item.startedAt)) < Math.min(...concurrent.map(item => item.endedAt)));
    assert.equal(new Set(evidence.independentSessions.map(item => item.session)).size, 2);
    assert.equal(evidence.indexPreserved, true); assert.equal(evidence.headPreserved, true);
    await runtime.client.call('revoke', { id: 'owned-peer' });
    await assert.rejects(runtime.syncPeer(), { code: 'UNAUTHORIZED' });
    await assert.rejects(runtime.client.call('publication', { action: 'prepare', id: 'owned-denied-publication', revision: first.acceptedRevision, message: 'test' }));
  } finally { await runtime.dispose(); }
});
