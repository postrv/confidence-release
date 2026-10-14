import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { initializeKernel } from '../../packages/protocol/src/node';
import { digest, encodeBase64, getKernel, sha256 } from '../../packages/protocol/src/index';
import { sourceInspectionKey, sourceText, verifySourceExport, type SourceExport } from '../../apps/web/src/source';
import type { Candidate } from '../../services/types';
import { previewSourceFiles } from '../../workers/authority/source-preview';
import { scope, vector } from './vector';

before(initializeKernel);
async function fixture() {
  const { bundle, input } = await vector();
  const candidate = { ...input.candidate, publicationBase: input.candidate.parent } as unknown as Candidate;
  const value: SourceExport = { schemaVersion: 1, scope, candidateId: candidate.id, candidateDigest: candidate.digest, version: 'candidate', source: { ...input.candidate, manifest: bundle.inputs.manifest, objects: bundle.inputs.gitObjects, objectsDigest: await digest(bundle.inputs.gitObjects) } };
  return { candidate, value };
}

test('complete source inspection verifies selected commit, archive and every file using the actual Rust kernel', async () => {
  const { candidate, value } = await fixture();
  const result = await verifySourceExport(value, scope, candidate, 'candidate', getKernel());
  assert.equal(sourceText(result.files.get('README.md')), 'A verified useful change.\n');
  assert.equal(result.export.source.objects.length, 3);
  const base = { ...value, version: 'base' as const };
  const frozenBase = { ...candidate, publicationBase: value.source.commit };
  assert.equal((await verifySourceExport(base, scope, frozenBase, 'base', getKernel())).export.source.commit, frozenBase.publicationBase);
});

test('source inspection refuses another candidate, project, version or frozen commit before accepting files', async () => {
  const { candidate, value } = await fixture();
  for (const changed of [
    { ...value, candidateId: 'other' }, { ...value, candidateDigest: 'sha256:other' },
    { ...value, scope: { ...scope, projectIncarnation: 'replaced' } }, { ...value, version: 'base' as const },
    { ...value, source: { ...value.source, commit: 'a'.repeat(40) } },
    { ...value, source: { ...value.source, manifestDigest: 'sha256:' + '0'.repeat(64) } },
  ]) await assert.rejects(verifySourceExport(changed, scope, candidate, 'candidate', getKernel()), /does not match/);
});

test('source content and archive metadata failures never produce a verified download', async () => {
  const { candidate, value } = await fixture();
  const changed = structuredClone(value); changed.source.objects[2].dataBase64 = btoa('Different ordinary file content.');
  await assert.rejects(verifySourceExport(changed, scope, candidate, 'candidate', getKernel()), /Source identity verification failed/);
  await assert.rejects(verifySourceExport({ ...value, source: { ...value.source, objectsDigest: 'sha256:' + '0'.repeat(64) } }, scope, candidate, 'candidate', getKernel()), /archive identity/);
  assert.match(sourceText(new Uint8Array([255, 254])), /Binary file/);
  assert.match(sourceText(new Uint8Array([65, 0, 66])), /Binary file/);
  assert.match(sourceText(undefined), /File absent/);
});

test('a candidate omitted by the shared preview budget still has complete verified base and candidate exports with executable mode', async () => {
  const content = new TextEncoder().encode('x'.repeat(130 * 1024));
  const oid = (type: string, data: Uint8Array) => createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
  const blobOid = oid('blob', content);
  const name = new TextEncoder().encode('100755 large.mjs\0');
  const tree = new Uint8Array(name.length + 20); tree.set(name); tree.set(Buffer.from(blobOid, 'hex'), name.length);
  const treeOid = oid('tree', tree);
  const rootBytes = new TextEncoder().encode(`tree ${treeOid}\nauthor Test <test@example.invalid> 1791150000 +0000\ncommitter Test <test@example.invalid> 1791150000 +0000\n\nBase\n`);
  const root = oid('commit', rootBytes);
  const childBytes = new TextEncoder().encode(`tree ${treeOid}\nparent ${root}\nauthor Test <test@example.invalid> 1791150000 +0000\ncommitter Test <test@example.invalid> 1791150000 +0000\n\nCandidate\n`);
  const child = oid('commit', childBytes);
  const manifest = { schemaVersion: 1 as const, pathProfile: 'portable-ascii-v1' as const, entries: [{ path: 'large.mjs', mode: '100755' as const, bytes: String(content.length), digest: await sha256(content) }] };
  const manifestDigest = await digest(manifest);
  const candidate = { id: 'large-candidate', digest: await digest({ child, root, manifestDigest }), commit: child, commitBytesDigest: await sha256(childBytes), manifestDigest, publicationBase: root } as Candidate;
  const objects = async (commit: string, commitBytes: Uint8Array) => {
    const values = [{ oid: commit, type: 'commit' as const, dataBase64: encodeBase64(commitBytes) }, { oid: treeOid, type: 'tree' as const, dataBase64: encodeBase64(tree) }, { oid: blobOid, type: 'blob' as const, dataBase64: encodeBase64(content) }].sort((a, b) => a.oid.localeCompare(b.oid));
    return { values, digest: await digest(values) };
  };
  const baseObjects = await objects(root, rootBytes), candidateObjects = await objects(child, childBytes);
  const base: SourceExport = { schemaVersion: 1, scope, candidateId: candidate.id, candidateDigest: candidate.digest, version: 'base', source: { commit: root, parent: null, commitBytesDigest: await sha256(rootBytes), manifest, manifestDigest, objects: baseObjects.values, objectsDigest: baseObjects.digest } };
  const next: SourceExport = { schemaVersion: 1, scope, candidateId: candidate.id, candidateDigest: candidate.digest, version: 'candidate', source: { commit: child, parent: root, commitBytesDigest: candidate.commitBytesDigest, manifest, manifestDigest, objects: candidateObjects.values, objectsDigest: candidateObjects.digest } };
  const preview = await previewSourceFiles([{ commit: root, manifest }, { commit: child, manifest }], async () => content);
  assert.deepEqual(preview[root], {}); assert.deepEqual(preview[child], {});
  const checkedBase = await verifySourceExport(base, scope, candidate, 'base', getKernel());
  const checkedNext = await verifySourceExport(next, scope, candidate, 'candidate', getKernel());
  assert.deepEqual(checkedBase.files.get('large.mjs'), content);
  assert.deepEqual(checkedNext.files.get('large.mjs'), content);
  assert.equal(checkedNext.export.source.manifest.entries[0]?.mode, '100755');
  const state = { ...scope, revision: 3, observationRevision: 2 };
  assert.notEqual(sourceInspectionKey(state, candidate), sourceInspectionKey(state, { ...candidate, publicationBase: '0'.repeat(40) }));
  assert.notEqual(sourceInspectionKey(state, candidate), sourceInspectionKey(state, { ...candidate, id: 'another-selection', digest: 'sha256:another' }));
  assert.notEqual(sourceInspectionKey(state, candidate), sourceInspectionKey({ ...state, revision: 4 }, candidate));
});
