// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveFixture, archiveObject as object } from '../../infra/test-projects/fixtures';
import { canonicalProjectJson } from '../../packages/project-model/src/json';
import { parseProjectJson, validateProjectChecks, validateRepositoryArchive } from '../../packages/project-model/src/validation';

test('archive retains raw merge HEAD, non-UTF8 commit message, UTF8 names, executable mode, symlink and gitlink', () => {
  const archive = archiveFixture(), checked = validateRepositoryArchive(archive);
  assert.equal(checked.archive.head, archive.head); assert.equal(checked.entries.length, 4);
  assert.equal(checked.entries.find(entry => entry.path === 'é.sh')?.mode, '100755');
  assert.equal(checked.entries.find(entry => entry.path === 'link')?.mode, '120000');
  assert.equal(checked.entries.find(entry => entry.path === 'submodule')?.bytes, null);
  assert.equal(checked.warnings.length, 3);
});
test('archive verifies object identity and complete reachable closure before persistence', () => {
  const archive = archiveFixture(); const mismatch = structuredClone(archive); mismatch.objects[0]!.dataBase64 = Buffer.from('changed').toString('base64');
  assert.throws(() => validateRepositoryArchive(mismatch), /PROJECT_ARCHIVE_OBJECT_ID_MISMATCH/);
  assert.throws(() => validateRepositoryArchive({ ...archive, objects: archive.objects.slice(0, -1) }), /PROJECT_ARCHIVE_BLOB_MISSING/);
  assert.throws(() => validateRepositoryArchive({ ...archive, objects: [...archive.objects, object('blob', 'unreachable')] }), /PROJECT_ARCHIVE_UNREACHABLE_OBJECT/);
  assert.throws(() => validateRepositoryArchive({ ...archive, objects: [...archive.objects, archive.objects[0]] }), /PROJECT_ARCHIVE_OBJECT_INVALID/);
});
test('archive rejects empty names and unsupported filename encoding as client errors', () => {
  const blob = object('blob', 'data');
  for (const [name, code] of [[Buffer.alloc(0), 'PROJECT_ARCHIVE_TREE_NAME_INVALID'], [Buffer.from([255]), 'PROJECT_ARCHIVE_PATH_ENCODING_UNSUPPORTED']] as const) {
    const tree = object('tree', Buffer.concat([Buffer.from('100644 '), name, Buffer.from([0]), Buffer.from(blob.oid, 'hex')]));
    const commit = object('commit', `tree ${tree.oid}\nauthor Test <test@example.test> 0 +0000\ncommitter Test <test@example.test> 0 +0000\n\ntest\n`);
    assert.throws(() => validateRepositoryArchive({ ...archiveFixture(), head: commit.oid, objects: [blob, tree, commit] }), (error: unknown) => error instanceof Error && error.message === code && 'status' in error && error.status === 400);
  }
});
test('strict project parser rejects duplicate keys, unsafe numbers and excess depth', () => {
  for (const value of ['{"a":1,"a":2}', '{"a":{"x":true,"x":false}}', '{"x":9007199254740992}', '{"x":1.5}', '{"x":NaN}', '{"x":1}extra', '{"x":1,}']) assert.throws(() => parseProjectJson(value), /INVALID_PROJECT_JSON/);
  assert.throws(() => parseProjectJson('{"x":' + '['.repeat(66) + '0' + ']'.repeat(66) + '}'), /INVALID_PROJECT_JSON/);
  assert.equal(canonicalProjectJson(parseProjectJson('{"z":null,"a":[true,2,"quote\\\""]}')), '{"a":[true,2,"quote\\\""],"z":null}');
  const prototype = parseProjectJson('{"__proto__":{"injected":true}}');
  assert.equal(Object.getPrototypeOf(prototype), Object.prototype); assert.equal(Object.hasOwn(prototype, '__proto__'), true); assert.equal(({} as { injected?: boolean }).injected, undefined);
});
test('strict parser accepts an archive beyond signed protocol JSON ceiling; 4MiB blobs validate without regex recursion', () => {
  const archive = archiveFixture(true);
  const bytes = canonicalProjectJson(archive); assert.ok(Buffer.byteLength(bytes) > 8 * 1024 * 1024);
  const parsed = parseProjectJson(bytes); assert.equal(validateRepositoryArchive(parsed).archive.head, archive.head);
});
test('check definitions are bounded exact argv configuration and never protected evidence', () => {
  const check = { id: 'node-test', name: 'Node tests', argv: ['node', '--test'], cwd: '.', timeoutSeconds: 60, required: true, enabled: true, source: 'detected', evidenceClass: 'repository-check' };
  assert.equal(validateProjectChecks([check]).length, 1);
  assert.throws(() => validateProjectChecks([{ ...check, evidenceClass: 'protected-behavioural' }]), /PROJECT_CHECK_CONFIGURATION_INVALID/);
  assert.throws(() => validateProjectChecks([{ ...check, cwd: '../outside' }]), /PROJECT_CHECK_DIRECTORY_INVALID/);
  assert.throws(() => validateProjectChecks([{ ...check, argv: Array(64).fill('x'.repeat(1024)) }]), /PROJECT_CHECK_CONFIGURATION_LIMIT/);
});

test('import admission bounds serialized path inventory independently of unique Git object bytes', () => {
  const blob = object('blob', 'ok');
  let tree = object('tree', Buffer.concat(Array.from({ length: 1024 }, (_, index) => Buffer.concat([
    Buffer.from(`100644 file-${String(index).padStart(4, '0')}\0`), Buffer.from(blob.oid, 'hex'),
  ]))));
  const objects = [blob, tree];
  // Ordinary bounded Git names; JSON escaping and shared parent paths expand inventory.
  for (let depth = 0; depth < 16; depth++) {
    tree = object('tree', Buffer.concat([Buffer.from('40000 ' + '\u0001'.repeat(190) + '\0'), Buffer.from(tree.oid, 'hex')]));
    objects.push(tree);
  }
  const commit = object('commit', `tree ${tree.oid}\nauthor Test <test@example.test> 0 +0000\ncommitter Test <test@example.test> 0 +0000\n\ninventory capacity\n`);
  objects.push(commit);
  const archive = { ...archiveFixture(), head: commit.oid, objects };
  assert.ok(Buffer.byteLength(JSON.stringify(archive)) < 100_000);
  assert.throws(() => validateRepositoryArchive(archive), /PROJECT_INVENTORY_SIZE_LIMIT/);
});
