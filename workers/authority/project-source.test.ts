// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { assertImportedSource, importedFile, importedInventory, importedSourceRequest } from '../../packages/project-model/src/source';
import { IMPORTED_PREVIEW_BYTES, type ImportedEntry, type ImportedSource, type ImportedSourceIdentity, type ProjectSummary } from '../../packages/project-model/src/types';

const identity: ImportedSourceIdentity = { schemaVersion: 1, projectId: 'one', projectIncarnation: 'incarnation', head: 'a'.repeat(40), archiveDigest: 'sha256:' + 'b'.repeat(64) };
function content(data: Uint8Array, mode: ImportedEntry['mode'] = '100644') {
  const entry: ImportedEntry = { path: 'dir/hello.mjs', mode, oid: createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'), bytes: data.length };
  const archive = Buffer.from(JSON.stringify({ schemaVersion: 1, format: 'confidence-git-archive-v1', head: identity.head, objects: [{ ...entry, type: 'blob', dataBase64: Buffer.from(data).toString('base64') }] }));
  return { entry, archive };
}
test('retained text preserves BOM and executable/symlink content without dereferencing', () => {
  for (const [text, mode] of [['\ufeffexport const n = 1;\n', '100755'], ['../../elsewhere', '120000'], ['version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 42\n', '100644']] as const) {
    const { entry, archive } = content(Buffer.from(text), mode); const result = importedFile(identity, entry, archive);
    assert.equal(result.text, text); assert.equal(result.entry.mode, mode);
    assert.equal(result.representation, mode === '120000' ? 'symlink' : 'text');
    assert.equal(Buffer.byteLength(result.text!), entry.bytes);
  }
});
test('binary data is not rendered and gitlinks or oversized files never require an archive read', () => {
  for (const bytes of [Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xfe]), Buffer.from('escape\x1bsequence')]) {
    const value = content(bytes); assert.equal(importedFile(identity, value.entry, value.archive).representation, 'binary');
  }
  assert.equal(importedFile(identity, { path: 'submodule', oid: 'f'.repeat(40), mode: '160000', bytes: null }).representation, 'gitlink');
  assert.equal(importedFile(identity, { path: 'large', oid: 'f'.repeat(40), mode: '100644', bytes: IMPORTED_PREVIEW_BYTES + 1 }).representation, 'too-large');
  const atLimit = content(Buffer.alloc(IMPORTED_PREVIEW_BYTES, 65)); assert.equal(importedFile(identity, atLimit.entry, atLimit.archive).text?.length, IMPORTED_PREVIEW_BYTES);
});
test('selected blob must match retained bytes, Git oid and source head', () => {
  const { entry, archive } = content(Buffer.from('hello'));
  assert.throws(() => importedFile(identity, { ...entry, bytes: 6 }, archive), /OBJECT_ID_MISMATCH/);
  assert.throws(() => importedFile(identity, { ...entry, oid: 'c'.repeat(40) }, archive), /BLOB_MISSING/);
  assert.throws(() => importedFile({ ...identity, head: 'd'.repeat(40) }, entry, archive), /FORMAT_INVALID/);
  const value = JSON.parse(archive.toString()); value.objects[0].dataBase64 = Buffer.from('other').toString('base64');
  assert.throws(() => importedFile(identity, entry, Buffer.from(JSON.stringify(value))), /OBJECT_ID_MISMATCH/);
});
test('source queries require immutable pins and preserve exact unusual filenames', () => {
  const query = new URLSearchParams({ incarnation: identity.projectIncarnation, archive: identity.archiveDigest, view: 'file', path: 'a\\b/line\n\u202ename.ts' });
  assert.equal(importedSourceRequest(query).path, query.get('path'));
  for (const edit of [(q: URLSearchParams) => q.append('view', 'archive'), (q: URLSearchParams) => q.delete('archive'), (q: URLSearchParams) => q.set('extra', 'x'), (q: URLSearchParams) => q.set('view', 'archive'), (q: URLSearchParams) => q.set('incarnation', '')]) {
    const changed = new URLSearchParams(query); edit(changed); assert.throws(() => importedSourceRequest(changed), /QUERY_INVALID/);
  }
});
test('source scope and export roles are distinct from reader access', () => {
  const source = { status: 'IMPORTED', head: identity.head, archiveDigest: identity.archiveDigest } as ImportedSource;
  const project = { projectId: identity.projectId, projectIncarnation: identity.projectIncarnation, source, roles: ['reader'] } as ProjectSummary;
  const request = { incarnation: identity.projectIncarnation, archive: identity.archiveDigest, view: 'tree' } as const;
  assert.equal(assertImportedSource(project, request), source);
  assert.throws(() => assertImportedSource(project, { ...request, view: 'archive' }), /EXPORT_DENIED/);
  assert.throws(() => assertImportedSource(project, { ...request, incarnation: 'different' }), /SOURCE_CHANGED/);
  assert.throws(() => assertImportedSource({ ...project, roles: [] }, request), /UNAVAILABLE/);
  assert.equal(assertImportedSource({ ...project, roles: ['reader', 'export'] }, { ...request, view: 'archive' }), source);
});
test('inventory validates retained head, count, strict ordering and representations', () => {
  const entry = content(Buffer.from('hello')).entry, source = { head: identity.head, fileCount: 1 } as ImportedSource;
  const encoded = (entries: unknown[], head = identity.head) => Buffer.from(JSON.stringify({ head, entries }));
  assert.deepEqual(importedInventory(encoded([entry]), source), [entry]);
  for (const bytes of [encoded([entry], 'c'.repeat(40)), encoded([entry, entry]), encoded([{ ...entry, mode: '40000' }]), encoded([{ ...entry, bytes: -1 }])]) assert.throws(() => importedInventory(bytes, source), /INVENTORY_INVALID/);
});
