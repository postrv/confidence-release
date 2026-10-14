import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHash } from 'node:crypto';
import type { ImportedEntry, ImportedFileResponse, ProjectSummary } from '../../../packages/project-model/src/types';
import { IMPORTED_INVENTORY_BYTES } from '../../../packages/project-model/src/types';
import { canonicalProjectJson } from '../../../packages/project-model/src/json';
import { request } from './api';
import { ImportedFilePreview, ImportedSourceBrowser } from './ImportedSourceBrowser';
import { createImportedSourceReader, importedEntryKind, importedFilePage, importedPathLabel, importedSourceError, importedSourcePath, readImportedArchive, readImportedFile, readImportedTree } from './imported-source';

const entries: ImportedEntry[] = [
  { path: 'src/café & hello.ts', mode: '100644', oid: '1'.repeat(40), bytes: 5 },
  { path: 'bin/run.sh', mode: '100755', oid: '2'.repeat(40), bytes: 0 },
  { path: 'link', mode: '120000', oid: '3'.repeat(40), bytes: 4 },
  { path: 'submodule', mode: '160000', oid: '4'.repeat(40), bytes: null },
  { path: 'image.png', mode: '100644', oid: '5'.repeat(40), bytes: 20 },
];
const project: ProjectSummary = {
  projectId: 'repository', projectIncarnation: 'first-incarnation', name: 'Imported repository', description: '', revision: '2', roles: ['reader', 'export'], status: 'ACTIVE',
  createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', checks: [],
  source: { status: 'IMPORTED', head: 'a'.repeat(40), branch: 'main', archiveDigest: `sha256:${'b'.repeat(64)}`, inventoryDigest: `sha256:${'c'.repeat(64)}`,
    importedAt: '2026-10-09T00:00:00Z', importedBy: 'member', objectCount: 7, fileCount: entries.length, sourceBytes: 100, history: 'head-tree-only', warnings: [] },
  capabilities: { nativeWorkflow: false, repositoryChecks: false, publication: false, reason: 'Source and settings are retained.' },
};
const identity = { schemaVersion: 1 as const, projectId: project.projectId, projectIncarnation: project.projectIncarnation, head: 'a'.repeat(40), archiveDigest: `sha256:${'b'.repeat(64)}` };
const tree = () => ({ ...identity, entries: structuredClone(entries) });
const file = (index = 0): ImportedFileResponse => ({ ...identity, entry: entries[index], representation: 'text', text: 'hello' });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('import source requests pin project, incarnation and exact archive and encode paths as data', () => {
  const path = importedSourcePath(project, 'file', entries[0].path), url = new URL(path, 'https://example.test');
  assert.equal(url.pathname, '/api/projects/repository/source'); assert.equal(url.searchParams.get('incarnation'), project.projectIncarnation);
  assert.equal(url.searchParams.get('archive'), identity.archiveDigest); assert.equal(url.searchParams.get('path'), entries[0].path);
  assert.equal(url.searchParams.get('view'), 'file');
  assert.equal(new URL(importedSourcePath(project, 'archive'), url).searchParams.has('path'), false);
  assert.throws(() => importedSourcePath(project, 'tree', 'wrong')); assert.throws(() => importedSourcePath(project, 'file'));
  assert.throws(() => importedSourcePath({ ...project, source: { status: 'EMPTY' } }, 'tree'));
});

test('tree read accepts the declared formats and rejects mismatched source identities and malformed inventories', () => {
  assert.deepEqual(readImportedTree(tree(), project).entries, entries);
  for (const patch of [{ schemaVersion: 2 }, { projectId: 'other' }, { projectIncarnation: 'replacement' }, { head: 'd'.repeat(40) }, { archiveDigest: 'sha256:other' }]) {
    assert.throws(() => readImportedTree({ ...tree(), ...patch }, project), /does not match/);
  }
  for (const changed of [entries.slice(1), [...entries, entries[0]], entries.map((item, i) => i ? item : { ...item, path: '../outside' }),
    entries.map((item, i) => i ? item : { ...item, bytes: -1 }), entries.map((item, i) => i ? item : { ...item, oid: 'unverified' }),
    entries.map((item, i) => i ? item : { ...item, mode: 'directory' })]) assert.throws(() => readImportedTree({ ...identity, entries: changed }, project), /could not be verified/);
  assert.equal(importedEntryKind(entries[1]), 'Executable file'); assert.equal(importedEntryKind(entries[2]), 'Symbolic link'); assert.equal(importedEntryKind(entries[3]), 'Gitlink');
});

test('valid unusual Git names retain their exact path while labels expose controls and direction changes', () => {
  const path = 'src/tab\tline\nname\\literal\u202e.ts';
  const unusual = { ...entries[0], path };
  const inventory = { ...identity, entries: [unusual, ...entries.slice(1)] };
  assert.equal(readImportedTree(inventory, project).entries[0].path, path);
  assert.equal(new URL(importedSourcePath(project, 'file', path), 'https://example.test').searchParams.get('path'), path);
  const label = importedPathLabel(path); assert.match(label, /\\tline\\n/); assert.match(label, /\\\\literal\\u202e/); assert.doesNotMatch(label, /[\t\n\u202e]/);
});

test('file preview is bound to the selected entry and representation with a finite text bound', () => {
  assert.equal(readImportedFile(file(), project, entries[0]).text, 'hello');
  for (const entry of [{ ...entries[0], path: 'other' }, { ...entries[0], oid: entries[1].oid }, { ...entries[0], mode: '100755' }, { ...entries[0], bytes: 4 }]) {
    assert.throws(() => readImportedFile({ ...file(), entry }, project, entries[0]), /does not match/);
  }
  assert.throws(() => readImportedFile({ ...file(), text: 'x'.repeat(256 * 1024 + 1) }, project, entries[0]), /size limit/);
  assert.throws(() => readImportedFile({ ...file(), representation: 'gitlink' }, project, entries[0]), /representation/);
  assert.throws(() => readImportedFile({ ...file(), representation: 'symlink' }, project, entries[0]), /invalid/);
  assert.equal(readImportedFile({ ...identity, entry: entries[2], representation: 'symlink', text: 'dest' }, project, entries[2]).representation, 'symlink');
  assert.equal(readImportedFile({ ...identity, entry: entries[3], representation: 'gitlink' }, project, entries[3]).representation, 'gitlink');
  assert.equal(readImportedFile({ ...identity, entry: entries[4], representation: 'binary' }, project, entries[4]).representation, 'binary');
});

test('newer file selection cancels its predecessor and discards late content and failures', async () => {
  for (const fails of [false, true]) {
    const late = deferred<unknown>(), signals: AbortSignal[] = []; let reads = 0;
    const reader = createImportedSourceReader(project, 'member', async (_path, signal) => { signals.push(signal); return reads++ === 0 ? late.promise : { ...identity, entry: entries[1], representation: 'text', text: '' }; });
    const old = reader.file(entries[0]); const next = await reader.file(entries[1]);
    assert.equal(signals[0].aborted, true); assert.equal(next?.entry.path, entries[1].path);
    if (fails) late.reject(new Error('Earlier request failed')); else late.resolve(file());
    assert.equal(await old, undefined);
  }
});

test('source session cancellation fences a late tree response after project or account change', async () => {
  const late = deferred<unknown>(); let signal!: AbortSignal;
  const reader = createImportedSourceReader(project, 'member', async (_path, value) => { signal = value; return late.promise; });
  const pending = reader.tree(); reader.cancel(); late.resolve(tree());
  assert.equal(signal.aborted, true); assert.equal(await pending, undefined);
  const invalid = createImportedSourceReader(project, 'member', async () => ({ ...tree(), projectId: 'other' }));
  await assert.rejects(invalid.tree(), /does not match/);
});

test('source requests carry the original principal and explicit source response bounds', async () => {
  let observed: { headers: Record<string, string>; maximum: number } | undefined;
  const reader = createImportedSourceReader(project, 'issuer#original-member', async (_path, _signal, headers, maximum) => { observed = { headers, maximum }; return tree(); });
  await reader.tree();
  assert.deepEqual(observed, { headers: { 'if-platform-principal': 'issuer#original-member', 'if-platform-incarnation': project.projectIncarnation }, maximum: IMPORTED_INVENTORY_BYTES });
  assert.throws(() => createImportedSourceReader(project, ''), /confirm the account/);
});

test('source response bound supports large inventories without weakening ordinary API limits', async () => {
  const content = JSON.stringify({ longInventoryFixture: 'x'.repeat(8 * 1024 * 1024) });
  const fetcher = async () => new Response(content, { headers: { 'content-type': 'application/json' } });
  await assert.rejects(request('/api/state', undefined, 1000, fetcher), /8 MiB limit/);
  const value = await request<{ longInventoryFixture: string }>('/api/projects/repository/source', undefined, 1000, fetcher, IMPORTED_INVENTORY_BYTES);
  assert.equal(value.longInventoryFixture.length, 8 * 1024 * 1024);
});

test('Worker and local source errors explain size and account failures with a recoverable next step', async () => {
  for (const code of ['SIZE_LIMIT', 'SESSION_PRINCIPAL_CHANGED', 'SOURCE_EXPORT_DENIED']) {
    for (const body of [{ error: code }, { error: { code, message: code } }]) {
      try { await request('/api/projects/repository/source', undefined, 1000, async () => Response.json(body, { status: code === 'SIZE_LIMIT' ? 413 : 409 })); assert.fail('expected source error'); }
      catch (error) { assert.match(importedSourceError(error), code === 'SIZE_LIMIT' ? /download the original archive/ : /Refresh projects/); }
    }
  }
});

test('downloads reproduce the exact retained archive digest and discard a cancelled response', async () => {
  const archive = { schemaVersion: 1, format: 'confidence-git-archive-v1', head: identity.head, objects: [], checks: [], warnings: [], branch: 'main' };
  const expected = canonicalProjectJson(archive), archiveDigest = `sha256:${createHash('sha256').update(expected).digest('hex')}`;
  assert.equal(project.source.status, 'IMPORTED');
  const target = { ...project, source: { ...project.source, archiveDigest } } as ProjectSummary;
  assert.equal(new TextDecoder().decode(await readImportedArchive(archive, target)), expected);
  await assert.rejects(readImportedArchive({ ...archive, branch: 'tampered' }, target), /digest does not match/);
  await assert.rejects(readImportedArchive({ ...archive, head: 'f'.repeat(40) }, target), /does not match/);
  const late = deferred<unknown>();
  const reader = createImportedSourceReader(target, 'member', async () => late.promise);
  const pending = reader.archive(); reader.cancel(); late.resolve(archive); assert.equal(await pending, undefined);
});

test('file browsing pages and filters all retained paths without silently truncating the inventory', () => {
  const many = Array.from({ length: 520 }, (_, index) => ({ ...entries[0], path: `folder/file-${String(index).padStart(3, '0')}` }));
  const first = importedFilePage(many, '', 0); assert.equal(first.count, 520); assert.equal(first.pages, 6); assert.equal(first.entries.length, 100);
  const last = importedFilePage(many, '', 99); assert.equal(last.page, 5); assert.equal(last.entries.length, 20);
  const searched = importedFilePage(many, 'FILE-519', 0); assert.equal(searched.count, 1); assert.equal(searched.entries[0].path, 'folder/file-519');
  assert.equal(importedFilePage(many, 'absent', 2).page, 0);
});

test('source preview renders inert text and explicitly describes executable, binary, link and oversized entries', () => {
  const html = renderToStaticMarkup(createElement(ImportedFilePreview, { file: { ...file(), text: '<script>alert(1)</script>' } }));
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  for (const [index, representation, text, expected] of [[1, 'text', '', /Executable file/], [2, 'symlink', 'https://example.test', /target is not followed/],
    [3, 'gitlink', undefined, /was not imported or fetched/], [4, 'binary', undefined, /exact bytes are retained/], [0, 'too-large', undefined, /256 KiB preview limit/]] as const) {
    const result = renderToStaticMarkup(createElement(ImportedFilePreview, { file: { ...identity, entry: entries[index], representation, ...(text === undefined ? {} : { text }) } }));
    assert.match(result, expected); assert.doesNotMatch(result, /href=/);
  }
});

test('source archive download needs export or admin; unavailable identity suppresses source controls', () => {
  const render = (roles = project.roles, available = true) => renderToStaticMarkup(createElement(ImportedSourceBrowser, { project: { ...project, roles }, sessionScope: 'tenant/account/project', principalId: 'member', available }));
  assert.match(render(), /Download original archive/); assert.match(render(['admin']), /Download original archive/);
  assert.doesNotMatch(render(['reader']), /Download original archive/); assert.match(render(['reader']), /requires the export role/);
  assert.doesNotMatch(render(project.roles, false), /Download original archive/); assert.match(render(project.roles, false), /confirm your current account/);
});
