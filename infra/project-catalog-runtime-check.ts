// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { IMPORTED_PREVIEW_BYTES, type ProjectCheck, type ProjectSummary, type ProjectDirectoryResponse, type ImportedFileResponse, type ImportedTreeResponse, type ImportedSourceRequest, type RepositoryArchive } from '../packages/project-model/src/types';
import { projectDigest } from '../packages/project-model/src/validation';
import { archiveFixture, archiveObject } from './test-projects/fixtures';

const directory = await mkdtemp(join(tmpdir(), 'confidence-project-catalog-')), bundle = join(directory, 'bundle'); await mkdir(bundle);
const run = promisify(execFile);
await run(resolve('node_modules/.bin/wrangler'), ['deploy', '--dry-run', '--config', 'infra/test-projects/wrangler.jsonc', '--outdir', bundle], { cwd: resolve('.'), env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, maxBuffer: 4 * 1024 * 1024, timeout: 60000 });
const scripts = (await readdir(bundle)).filter(file => file.endsWith('.js')); assert.equal(scripts.length, 1);
const options = convertV4MiniflareOptions({ name: 'confidence-projects-test-only', modulesRoot: bundle, modules: [{ type: 'ESModule', path: join(bundle, scripts[0]!) }, ...(await readdir(bundle)).filter(file => file.endsWith('.wasm')).map(file => ({ type: 'CompiledWasm' as const, path: join(bundle, file) }))], compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'], durableObjects: { PROJECTS: { className: 'TestProjectAuthority', useSQLite: true }, PROJECT_DIRECTORY: { className: 'ProjectDirectory', useSQLite: true } }, r2Buckets: { OBJECTS: 'owned-projects-test-only' }, resourcePersistencePath: join(directory, 'persist'), log: new Log(LogLevel.ERROR), bindings: { AUTH_TENANT_ID: 'owned-test', MAINTENANCE_MODE: 'false', APP_SERVICE_TOKEN: 'owned-test-app-token-long-enough', BOOTSTRAP_SUBJECTS: '["owner"]' } });
let runtime = new Miniflare(options); const checks: string[] = [];
const principal = (id = 'owner') => ({ id, tenantId: 'owned-test', credentialClass: 'human' });
const caller = (projectId: string, id = 'owner') => ({ principal: principal(id), projectId });
async function request<T = ProjectSummary>(path: string, body: unknown, status = 200, code?: string): Promise<T> {
  const response = await runtime.dispatchFetch('http://owned.test' + path, { method: 'POST', headers: { authorization: 'Bearer owned-test-app-token-long-enough', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json() as any; assert.equal(response.status, status, JSON.stringify(value)); if (code) assert.equal(value.error?.code, code, JSON.stringify(value)); return value;
}
const create = (id: string, name: string, owner = 'owner') => request('/internal/projects/create', { principal: principal(owner), command: { commandId: id, body: { name, description: 'Owned runtime validation' } } }, 201);
const get = (projectId: string, owner = 'owner') => request('/internal/projects/get', { caller: caller(projectId, owner) });
const list = (owner = 'owner') => request<ProjectDirectoryResponse>('/internal/projects/list', { principal: principal(owner), defaultProjectId: 'existing-pilot' });
function intent(project: ProjectSummary, commandId: string, operation: string, body: unknown) { return { caller: caller(project.projectId), command: { commandId, expectedRevision: project.revision, expectedIncarnation: project.projectIncarnation, operation, body } }; }
function sourceIntent(project: ProjectSummary, view: ImportedSourceRequest['view'], path?: string, owner = 'owner') {
  if (project.source.status !== 'IMPORTED') throw new Error('Owned source test needs an imported project');
  return { caller: caller(project.projectId, owner), sourceRequest: { incarnation: project.projectIncarnation, archive: project.source.archiveDigest, view, ...(path === undefined ? {} : { path }) } };
}
async function sourceResponse(input: ReturnType<typeof sourceIntent>) {
  const response = await runtime.dispatchFetch('http://owned.test/internal/projects/source', { method: 'POST', headers: { authorization: 'Bearer owned-test-app-token-long-enough', 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(response.status, 200, response.status === 200 ? '' : await response.text());
  for (const [key, value] of Object.entries({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; sandbox" })) assert.equal(response.headers.get(key), value);
  return response;
}
function inspectionFixture(): RepositoryArchive {
  const text = archiveObject('blob', 'hello\n'), link = archiveObject('blob', '../target'), binary = archiveObject('blob', Buffer.from([0, 0xff, 10]));
  const boundary = archiveObject('blob', 'x'.repeat(IMPORTED_PREVIEW_BYTES)), large = archiveObject('blob', 'y'.repeat(IMPORTED_PREVIEW_BYTES + 1));
  const entries = [['100644', 'README.md', text.oid], ['100644', 'boundary.txt', boundary.oid], ['100644', 'large.txt', large.oid], ['120000', 'link', link.oid], ['100644', 'payload.bin', binary.oid], ['160000', 'submodule', '1'.repeat(40)], ['100755', 'é.sh', text.oid]];
  const tree = archiveObject('tree', Buffer.concat(entries.map(([mode, name, oid]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid!, 'hex')]))));
  const commit = archiveObject('commit', `tree ${tree.oid}\nauthor Source Test <test@example.test> 0 +0000\ncommitter Source Test <test@example.test> 0 +0000\n\nOwned source inspection\n`);
  return { schemaVersion: 1, format: 'confidence-git-archive-v1', head: commit.oid, branch: 'main', objects: [commit, tree, text, link, binary, boundary, large], checks: [], warnings: [] };
}
try {
  await runtime.ready;
  assert.deepEqual((await list()).projects, []);
  let first = await create('create-first', 'First project'); const second = await create('create-second', 'Second project', 'other');
  assert.equal(first.source.status, 'EMPTY'); assert.equal(first.revision, '1'); assert.deepEqual((await list()).projects.map(project => project.projectId), [first.projectId]);
  assert.equal((await list('other')).projects[0]!.projectId, second.projectId);
  assert.deepEqual(await create('create-first', 'First project'), first);
  await request('/internal/projects/create', { principal: principal(), command: { commandId: 'create-first', body: { name: 'Different' } } }, 409, 'COMMAND_ID_REUSED');
  await request('/internal/projects/get', { caller: caller(second.projectId) }, 404, 'PROJECT_UNAVAILABLE');
  await request('/internal/projects/list', { principal: { ...principal(), tenantId: 'another-tenant' }, defaultProjectId: 'existing-pilot' }, 403, 'PROJECT_DIRECTORY_DENIED');
  checks.push('Real authority routing creates independent projects with creator-only membership, exact create replay, conflict rejection and tenant isolation.');

  const delayedCreate = { principal: principal(), command: { commandId: 'owned-timed-out-create', body: { name: 'Owned timed out creation', description: 'Owned deadline recovery' } } };
  await request('/internal/projects/create', delayedCreate, 503, 'PROJECT_DIRECTORY_UNAVAILABLE');
  const directoryCommands = await request<{ id: string; payload: string; result: string | null }[]>('/test/directory', {});
  const pendingCreate = directoryCommands.find(row => row.id === delayedCreate.command.commandId)!;
  assert.equal(pendingCreate.result, null, 'a timed out response cannot commit a directory result');
  const creation = JSON.parse(pendingCreate.payload);
  assert.equal((await get(creation.projectId)).name, delayedCreate.command.body.name, 'the original creation may already have committed');
  await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
  const recoveredCreate = await request('/internal/projects/create', delayedCreate, 201);
  assert.equal(recoveredCreate.projectId, creation.projectId); assert.equal(recoveredCreate.projectIncarnation, creation.projectIncarnation);
  assert.equal((await list()).projects.filter(project => project.projectId === creation.projectId).length, 1);
  await request('/test/change', { projectId: recoveredCreate.projectId, operation: 'directory-read-stall' });
  await request('/internal/projects/create', delayedCreate, 503, 'PROJECT_DIRECTORY_UNAVAILABLE');
  assert.deepEqual(await request('/internal/projects/create', delayedCreate, 201), recoveredCreate);
  await request('/test/change', { projectId: recoveredCreate.projectId, operation: 'member', subject: 'owner', roles: ['reader'], active: false });
  await request('/internal/projects/create', delayedCreate, 404, 'PROJECT_UNAVAILABLE');
  checks.push('Stalled creation and replay response bodies meet the directory deadline; durable pending creation recovers the original project/incarnation after restart, and replay still rechecks revocation.');

  await request('/test/change', { projectId: first.projectId, operation: 'member', subject: 'teammate', roles: ['reader'], active: true });
  assert.equal((await list('teammate')).projects[0]!.projectId, first.projectId);
  await request('/internal/projects/command', { ...intent(first, 'reader-denied', 'update', { name: 'Not allowed' }), caller: caller(first.projectId, 'teammate') }, 403, 'HUMAN_ADMIN_REQUIRED');
  await request('/test/change', { projectId: first.projectId, operation: 'member', subject: 'teammate', roles: ['reader'], active: false });
  assert.deepEqual((await list('teammate')).projects, []);
  checks.push('Directory authorization reads current project memberships; revocation immediately removes access and reader cannot manage metadata.');

  const rename = intent(first, 'rename-first', 'update', { name: 'Renamed project', description: 'Line one\nLine two' });
  first = await request('/internal/projects/command', rename); assert.equal(first.revision, '2');
  assert.deepEqual(await request('/internal/projects/command', rename), first);
  await request('/internal/projects/command', { ...rename, command: { ...rename.command, commandId: 'stale-rename' } }, 409, 'STALE_STATE');
  await request('/internal/projects/command', { ...intent(first, 'wrong-incarnation', 'archive', {}), command: { ...intent(first, 'wrong-incarnation', 'archive', {}).command, expectedIncarnation: 'wrong' } }, 409, 'PROJECT_INCAR_CHANGED');
  first = await request('/internal/projects/command', intent(first, 'archive-first', 'archive', {})); assert.equal(first.status, 'ARCHIVED');
  await request('/internal/projects/command', intent(first, 'archived-update', 'update', { name: 'Denied' }), 409, 'PROJECT_ARCHIVED');
  assert.equal((await get(first.projectId)).status, 'ARCHIVED');
  first = await request('/internal/projects/command', intent(first, 'restore-first', 'restore', {})); assert.equal(first.status, 'ACTIVE');
  checks.push('Metadata commands retain exact idempotency, revision/incarnation conflicts, archive write fencing and readable restoration.');

  const check: ProjectCheck = { id: 'node-test', name: 'Saved disabled test', argv: ['node', '--test', 'test/custom.mjs'], cwd: '.', timeoutSeconds: 37, required: false, enabled: false, source: 'manual', evidenceClass: 'repository-check' };
  const detected: ProjectCheck = { ...check, name: 'Detected test', argv: ['node', '--test'], timeoutSeconds: 300, required: true, enabled: true, source: 'detected' };
  first = await request('/internal/projects/command', intent(first, 'configure-checks', 'checks', { checks: [check] }));
  assert.equal(first.checks[0]!.evidenceClass, 'repository-check'); assert.equal(first.capabilities.repositoryChecks, false); assert.equal(first.capabilities.publication, false);
  checks.push('Check configuration is persisted while managed execution/publication remain explicitly unavailable for generic source.');

  const invalidBlob = archiveObject('blob', 'data');
  const invalidTree = archiveObject('tree', Buffer.concat([Buffer.from('100644 '), Buffer.from([255, 0]), Buffer.from(invalidBlob.oid, 'hex')]));
  const invalidHead = archiveObject('commit', `tree ${invalidTree.oid}\nauthor Test <test@example.test> 0 +0000\ncommitter Test <test@example.test> 0 +0000\n\ntest\n`);
  const invalidSource = { ...archiveFixture(), head: invalidHead.oid, objects: [invalidBlob, invalidTree, invalidHead] };
  await request('/test/change', { projectId: first.projectId, operation: 'fault', active: true });
  await request('/internal/projects/command', intent(first, 'invalid-filename', 'import', { archive: invalidSource }), 400, 'PROJECT_ARCHIVE_PATH_ENCODING_UNSUPPORTED');
  assert.deepEqual(await get(first.projectId), first);
  assert.equal((await request<{ exists: boolean }>('/test/object', { digest: projectDigest(invalidSource) })).exists, false);
  await request('/test/change', { projectId: first.projectId, operation: 'fault', active: false });
  checks.push('Unsupported filename encoding is rejected with a definitive 400 before an import intent or R2 write, even when R2 is unavailable.');

  const source = archiveFixture(true); source.checks = [detected];
  const importIntent = intent(first, 'large-import', 'import', { archive: source });
  assert.ok(Buffer.byteLength(JSON.stringify(importIntent)) > 8 * 1024 * 1024);
  first = await request('/internal/projects/command', importIntent);
  assert.equal(first.pendingImport, undefined);
  assert.deepEqual(first.checks, [check], 'detected checks must not replace saved configuration or re-enable a disabled check');
  assert.equal(first.source.status, 'IMPORTED'); if (first.source.status !== 'IMPORTED') throw new Error('Import state missing');
  assert.equal(first.source.head, source.head); assert.equal(first.source.archiveDigest, projectDigest(source)); assert.ok(first.source.sourceBytes > 8 * 1024 * 1024 - 2048);
  const archive = await request<{ exists: boolean; bytes: number; digest: string; head: string }>('/test/object', { digest: first.source.archiveDigest });
  assert.equal(archive.exists, true); assert.ok(archive.bytes > 8 * 1024 * 1024); assert.equal(archive.digest, first.source.archiveDigest); assert.equal(archive.head, source.head);
  assert.deepEqual(await request('/internal/projects/command', importIntent), first);
  checks.push('Workerd imports and R2-verifies an >11MiB JSON archive containing a 4MiB blob and nearly8MiB raw Git objects, preserving merge HEAD, UTF8 paths, symlink/gitlink modes and nonUTF8 commit message.');

  const laterChecks = [{ ...check, name: 'Edited after import' }];
  const later = await request('/internal/projects/command', intent(first, 'edit-checks-after-import', 'checks', { checks: laterChecks }));
  assert.deepEqual(await request('/internal/projects/command', importIntent), first);
  assert.deepEqual((await get(first.projectId)).checks, later.checks, 'import replay must not rewind later check edits');
  let noSuggestions = await create('create-no-suggestions', 'Saved checks without suggestions');
  noSuggestions = await request('/internal/projects/command', intent(noSuggestions, 'save-without-suggestions', 'checks', { checks: [check] }));
  // Do not pre-store the archive needed by the later injected R2 write failure.
  const noSuggestionsSource = archiveFixture(); noSuggestionsSource.warnings = ['Owned preservation case without detected checks.'];
  noSuggestions = await request('/internal/projects/command', intent(noSuggestions, 'import-without-suggestions', 'import', { archive: noSuggestionsSource }));
  assert.deepEqual(noSuggestions.checks, [check]);

  let recovery = await create('create-recovery', 'Recovery project');
  await request('/test/change', { projectId: recovery.projectId, operation: 'fault', active: true });
  const failed = intent(recovery, 'fixed-failed-import', 'import', { archive: archiveFixture() });
  await request('/internal/projects/command', failed, 503, 'OWNED_R2_UNAVAILABLE');
  recovery = await get(recovery.projectId); assert.equal(recovery.pendingImport?.commandId, 'fixed-failed-import');
  await request('/internal/projects/command', intent(recovery, 'rename-during-pending', 'update', { name: 'Blocked' }), 409, 'PROJECT_IMPORT_PENDING');
  recovery = await request('/internal/projects/command', intent(recovery, 'cancel-failed-import', 'cancel-import', { commandId: 'fixed-failed-import', principalId: 'owner', reason: 'Owned failed-upload recovery test' }));
  assert.equal(recovery.pendingImport, undefined); assert.equal(recovery.source.status, 'EMPTY');
  await request('/test/change', { projectId: recovery.projectId, operation: 'fault', active: false });
  await request('/internal/projects/command', failed, 409, 'COMMAND_CANCELLED');
  const detectedArchive = archiveFixture(); detectedArchive.checks = [detected];
  recovery = await request('/internal/projects/command', intent(recovery, 'new-recovery-import', 'import', { archive: detectedArchive })); assert.equal(recovery.source.status, 'IMPORTED');
  assert.deepEqual(recovery.checks, [detected], 'suggestions initialize an empty project configuration');
  checks.push('Import preserves configured and disabled checks, initializes only empty configuration, and exact replay cannot rewind a later check edit.');
  checks.push('Durable pending import survives R2 failure, exposes its identity to admin, blocks conflicting commands, supports explicit cancellation and tombstones the old key before retry.');

  let inspected = await create('create-source-inspection', 'Source inspection');
  const inspectionSource = inspectionFixture();
  inspected = await request('/internal/projects/command', intent(inspected, 'import-source-inspection', 'import', { archive: inspectionSource }));
  if (inspected.source.status !== 'IMPORTED') throw new Error('Owned inspection source missing');
  const sourceIdentity = { schemaVersion: 1, projectId: inspected.projectId, projectIncarnation: inspected.projectIncarnation, head: inspectionSource.head, archiveDigest: inspected.source.archiveDigest };
  const sourceTree = await (await sourceResponse(sourceIntent(inspected, 'tree'))).json() as ImportedTreeResponse;
  assert.deepEqual({ ...sourceTree, entries: undefined }, { ...sourceIdentity, entries: undefined });
  assert.deepEqual(sourceTree.entries.map(entry => [entry.path, entry.mode, entry.bytes]), [['README.md', '100644', 6], ['boundary.txt', '100644', IMPORTED_PREVIEW_BYTES], ['large.txt', '100644', IMPORTED_PREVIEW_BYTES + 1], ['link', '120000', 9], ['payload.bin', '100644', 3], ['submodule', '160000', null], ['é.sh', '100755', 6]]);
  const sourceFile = async (path: string, owner = 'owner') => await (await sourceResponse(sourceIntent(inspected, 'file', path, owner))).json() as ImportedFileResponse;
  const executable = await sourceFile('é.sh'); assert.equal(executable.entry.mode, '100755'); assert.equal(executable.representation, 'text'); assert.equal(executable.text, 'hello\n');
  const symlink = await sourceFile('link'); assert.equal(symlink.representation, 'symlink'); assert.equal(symlink.text, '../target');
  const binary = await sourceFile('payload.bin'); assert.equal(binary.representation, 'binary'); assert.equal(binary.text, undefined);
  const boundaryFile = await sourceFile('boundary.txt'); assert.equal(boundaryFile.representation, 'text'); assert.equal(boundaryFile.text?.length, IMPORTED_PREVIEW_BYTES);
  const control = (operation: 'arm' | 'wait' | 'release' | 'inspect', digest?: string) => request<{ reads: Record<string, number> }>('/test/read-control', { projectId: inspected.projectId, operation, ...(digest ? { digest } : {}) });
  const archiveKey = `objects/sha256/${inspected.source.archiveDigest.slice(7)}`;
  const readBeforeSpecialFiles = (await control('inspect')).reads[archiveKey];
  const gitlink = await sourceFile('submodule'); assert.equal(gitlink.representation, 'gitlink'); assert.equal(gitlink.entry.oid, '1'.repeat(40)); assert.equal(gitlink.text, undefined);
  const largeFile = await sourceFile('large.txt'); assert.equal(largeFile.representation, 'too-large'); assert.equal(largeFile.text, undefined);
  assert.equal((await control('inspect')).reads[archiveKey], readBeforeSpecialFiles, 'gitlinks and oversized previews never load the archive');
  await request('/internal/projects/source', sourceIntent(inspected, 'file', '../target'), 404, 'PROJECT_SOURCE_PATH_NOT_FOUND');
  const download = await sourceResponse(sourceIntent(inspected, 'archive'));
  assert.equal(download.headers.get('content-disposition'), `attachment; filename="confidence-source-${inspectionSource.head}.json"`);
  const downloadBytes = Buffer.from(await download.arrayBuffer());
  assert.equal('sha256:' + createHash('sha256').update(downloadBytes).digest('hex'), inspected.source.archiveDigest);
  assert.deepEqual(JSON.parse(downloadBytes.toString()), inspectionSource);
  const largeSourcePreview = await request<ImportedFileResponse>('/internal/projects/source', sourceIntent(first, 'file', 'README.md'));
  assert.equal(largeSourcePreview.representation, 'too-large'); assert.equal(largeSourcePreview.entry.bytes, 4 * 1024 * 1024); assert.equal(largeSourcePreview.text, undefined);
  checks.push('Source reads preserve exact project/incarnation/archive/HEAD identities, executable mode, symlink target and unfetched gitlink; binary and oversized files are explicit, the 256 KiB preview boundary holds, and an authenticated archive download matches its retained SHA-256 bytes.');

  const readBeforePins = (await control('inspect')).reads;
  const treeIntent = sourceIntent(inspected, 'tree');
  await request('/internal/projects/source', { ...treeIntent, sourceRequest: { ...treeIntent.sourceRequest, incarnation: 'stale-incarnation' } }, 409, 'PROJECT_SOURCE_CHANGED');
  await request('/internal/projects/source', { ...treeIntent, sourceRequest: { ...treeIntent.sourceRequest, archive: 'sha256:' + '0'.repeat(64) } }, 409, 'PROJECT_SOURCE_CHANGED');
  await request('/internal/projects/source', { ...treeIntent, caller: caller(second.projectId) }, 404, 'PROJECT_UNAVAILABLE');
  await request('/internal/projects/source', sourceIntent(inspected, 'tree', undefined, 'other'), 404, 'PROJECT_UNAVAILABLE');
  await request('/internal/projects/source', { ...treeIntent, caller: { ...treeIntent.caller, principal: { ...treeIntent.caller.principal, credentialClass: 'agent' } } }, 403, 'HUMAN_REQUIRED');
  assert.deepEqual((await control('inspect')).reads, readBeforePins, 'wrong pins and unauthorized readers cannot start R2 source reads');
  await request('/test/change', { projectId: inspected.projectId, operation: 'member', subject: 'source-reader', roles: ['reader'], active: true });
  assert.equal((await sourceFile('README.md', 'source-reader')).text, 'hello\n');
  await request('/internal/projects/source', sourceIntent(inspected, 'archive', undefined, 'source-reader'), 403, 'SOURCE_EXPORT_DENIED');
  await request('/test/change', { projectId: inspected.projectId, operation: 'member', subject: 'source-reader', roles: ['reader', 'export'], active: true });
  const memberArchive = await sourceResponse(sourceIntent(inspected, 'archive', undefined, 'source-reader'));
  assert.equal('sha256:' + createHash('sha256').update(Buffer.from(await memberArchive.arrayBuffer())).digest('hex'), inspected.source.archiveDigest);
  await request('/test/change', { projectId: inspected.projectId, operation: 'member', subject: 'source-reader', roles: ['reader', 'export'], active: false });
  await request('/internal/projects/source', sourceIntent(inspected, 'tree', undefined, 'source-reader'), 404, 'PROJECT_UNAVAILABLE');
  checks.push('Workerd source authorization denies wrong immutable pins, other projects, nonmembers and agents before R2 access; readers inspect source while archive download separately requires export membership and revocation removes both.');

  for (const view of ['tree', 'file', 'archive'] as const) {
    await request('/test/change', { projectId: inspected.projectId, operation: 'member', subject: 'source-reader', roles: ['reader', 'export'], active: true });
    await control('arm', view === 'tree' ? inspected.source.inventoryDigest : inspected.source.archiveDigest);
    const pendingRead = request('/internal/projects/source', sourceIntent(inspected, view, view === 'file' ? 'README.md' : undefined, 'source-reader'), view === 'archive' ? 403 : 404, view === 'archive' ? 'SOURCE_EXPORT_DENIED' : 'PROJECT_UNAVAILABLE');
    await control('wait');
    await request('/test/change', { projectId: inspected.projectId, operation: 'member', subject: 'source-reader', roles: ['reader'], active: view === 'archive' });
    await control('release'); await pendingRead;
  }
  await request('/test/change', { projectId: inspected.projectId, operation: 'member', subject: 'source-reader', roles: ['reader'], active: false });
  checks.push('Revocation during actual R2 reads is rechecked after await: inventory/tree and file archive responses refuse a removed member, and archive export refuses an export-role downgrade before returning bytes.');

  for (const [view, digest] of [['tree', inspected.source.inventoryDigest], ['archive', inspected.source.archiveDigest]] as const) {
    for (const operation of ['remove', 'corrupt'] as const) {
      await request('/test/object-change', { digest, operation });
      await request('/internal/projects/source', sourceIntent(inspected, view), 409, operation === 'remove' ? 'REQUIRED_OBJECT_MISSING' : 'OBJECT_DIGEST_MISMATCH');
      await request('/test/object-change', { digest, operation: 'restore' });
    }
  }
  assert.equal((await sourceFile('README.md')).text, 'hello\n');
  inspected = await request('/internal/projects/command', intent(inspected, 'archive-inspected-project', 'archive', {}));
  assert.equal(inspected.status, 'ARCHIVED');
  assert.deepEqual(await request<ImportedTreeResponse>('/internal/projects/source', sourceIntent(inspected, 'tree')), sourceTree);
  assert.equal((await sourceFile('link')).representation, 'symlink');
  checks.push('Missing and corrupt retained R2 inventories or archives fail with explicit 409 integrity errors; restoring exact bytes recovers reads, and archiving the project preserves authenticated immutable inspection.');

  await request('/test/change', { projectId: 'existing-pilot', operation: 'native', subject: 'owner' });
  let native = await get('existing-pilot'); assert.equal(native.revision, '0'); assert.equal(native.source.status, 'ENROLLED');
  assert.ok((await list()).projects.some(project => project.projectId === 'existing-pilot'));
  native = await request('/internal/projects/command', intent(native, 'archive-native', 'archive', {}));
  await request('/internal/command', { caller: caller('existing-pilot'), command: { commandId: 'native-command-after-archive', expectedRevision: '98', operation: 'set-gate', body: { gate: 'OPEN' } } }, 409, 'PROJECT_ARCHIVED');
  assert.equal((await get('existing-pilot')).source.status, 'ENROLLED');
  checks.push('Existing signed-project metadata is derived without reenrollment; archived native commands are denied and enrolled source remains readable.');

  const managedBeforeCapacity = (await request<unknown[]>('/test/directory', {})).length;
  for (let index = managedBeforeCapacity; index < 100; index += 8) {
    await Promise.all(Array.from({ length: Math.min(8, 100 - index) }, (_, offset) => create(`capacity-${index + offset}`, `Capacity project ${index + offset}`)));
  }
  const directoryReadStarted = Date.now(), fullDirectory = await list(), directoryReadMs = Date.now() - directoryReadStarted;
  assert.equal(fullDirectory.limit, 100); assert.equal(fullDirectory.canCreate, false);
  assert.equal(fullDirectory.projects.length, 99, '100 managed projects minus two denied members plus the existing native pilot');
  await request('/internal/projects/create', { principal: principal(), command: { commandId: 'over-capacity', body: { name: 'Must remain bounded' } } }, 409, 'PROJECT_LIMIT_REACHED');
  await runtime.dispose(); runtime = new Miniflare(options); await runtime.ready;
  const restartedDirectoryReadStarted = Date.now(), restartedDirectory = await list(), restartedDirectoryReadMs = Date.now() - restartedDirectoryReadStarted;
  assert.equal(restartedDirectory.canCreate, false); assert.deepEqual(restartedDirectory.projects.map(project => project.projectId), fullDirectory.projects.map(project => project.projectId));
  assert.equal((await get(first.projectId)).source.status, 'IMPORTED'); assert.deepEqual(await request('/internal/projects/command', importIntent), first);
  assert.deepEqual((await get(first.projectId)).checks, laterChecks);
  assert.deepEqual((await get(noSuggestions.projectId)).checks, [check]);
  assert.deepEqual((await get(recovery.projectId)).checks, [detected]);
  assert.equal((await get('existing-pilot')).status, 'ARCHIVED'); assert.deepEqual((await list('teammate')).projects, []);
  assert.equal((await get(inspected.projectId)).status, 'ARCHIVED');
  assert.deepEqual(await request<ImportedTreeResponse>('/internal/projects/source', sourceIntent(inspected, 'tree')), sourceTree);
  assert.equal((await sourceFile('é.sh')).text, 'hello\n');
  const archivedDownload = await sourceResponse(sourceIntent(inspected, 'archive'));
  assert.equal('sha256:' + createHash('sha256').update(Buffer.from(await archivedDownload.arrayBuffer())).digest('hex'), sourceIdentity.archiveDigest);
  await request('/internal/projects/source', sourceIntent(inspected, 'tree', undefined, 'source-reader'), 404, 'PROJECT_UNAVAILABLE');
  checks.push('Restarted workerd retains directory, metadata, R2 source, command replay, archive and revoked membership state.');
  checks.push('The complete 100-managed-project directory plus native pilot lists successfully before and after a cold workerd restart within the production shared deadline, while the 101st creation is rejected.');
  const output = resolve(process.env.PROJECT_CATALOG_RUNTIME_REPORT || 'demo-output/project-catalog-runtime.json'); await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ status: 'PASS', checks, importedArchiveBytes: archive.bytes, importedObjectBytes: first.source.sourceBytes, directoryProfile: { managedProjects: 100, listedProjects: fullDirectory.projects.length, directoryReadMs, restartedDirectoryReadMs }, productionAuthority: true, runtime: 'workerd', providerEffects: false }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'PASS', checks: checks.length, report: output }));
} finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
