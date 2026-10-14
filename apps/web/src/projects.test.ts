import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectDirectoryResponse, ProjectSummary } from '../../../packages/project-model/src/types';
import type { PlatformState } from '../../../services/types';
import { ApiError, createProjectStateReader, projectApiPath } from './api';
import { CommandSession, commandScope, freezeCommand, freezeMetadataCommand, metadataScope, type PendingCommand } from './commands';
import { collaborationRoute, navigationReducer, routeForView, routeFromHash, viewFromHash } from './navigation';
import { canManageProject, createProjectDirectory, observeDirectoryContext, readDirectoryResponse } from './project-directory';
import { importCommand, ImportGuide, PendingImport, projectActionLabel, Projects, ProjectSettings, repositoryCommands, RepositoryWorkspace } from './Projects';
import { observeCommand } from './command-observer';

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return { projectId: 'repo-one', projectIncarnation: 'incarnation-one', name: 'Customer portal', description: 'The customer-facing app',
    status: 'ACTIVE', revision: '3', createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', roles: ['admin', 'reader'],
    source: { status: 'EMPTY' }, checks: [], capabilities: { nativeWorkflow: false, repositoryChecks: false, publication: false, reason: 'Repository checks require a configured execution profile.' }, ...overrides };
}
function directory(overrides: Partial<ProjectDirectoryResponse> = {}): ProjectDirectoryResponse {
  return { schemaVersion: 1, principalId: 'issuer#owner', tenantId: 'tenant', canCreate: true, defaultProjectId: 'pilot', projects: [project()], limit: 100, ...overrides };
}
function storage() {
  const entries = new Map<string, string>();
  return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('project actions distinguish an enrolled release from imported source and preserve management capabilities', () => {
  assert.equal(projectActionLabel(project({ capabilities: { nativeWorkflow: true, repositoryChecks: false, publication: true, reason: 'Native' } })), 'Open release workflow');
  assert.equal(projectActionLabel(project()), 'Import source');
  assert.equal(projectActionLabel(project({ permissions: { manage: false } })), 'Open project');
  assert.equal(projectActionLabel(project({ status: 'ARCHIVED' })), 'Inspect project');
  const source = { status: 'IMPORTED' as const, head: 'a'.repeat(40), archiveDigest: 'sha256:' + 'b'.repeat(64), inventoryDigest: 'sha256:' + 'c'.repeat(64),
    importedAt: '2026-10-12T00:00:00Z', importedBy: 'issuer#owner', fileCount: 1, objectCount: 3, sourceBytes: 100, branch: 'main', history: 'head-tree-only' as const, warnings: [] };
  assert.equal(projectActionLabel(project({ source })), 'Browse source');
});
test('collaboration-only projects open discussion without offering source import or check execution', () => {
  const html = renderToStaticMarkup(createElement(Projects, { directory: directory(), collaborationOnly: true, disabled: false, manage: async () => false as const, open() {} }));
  assert.match(html, /Open discussion/);
  assert.doesNotMatch(html, /Import source|Not imported yet|Protected release checks|Not configured/);
  const empty = renderToStaticMarkup(createElement(Projects, { directory: directory({ projects: [] }), collaborationOnly: true, disabled: false, manage: async () => false as const, open() {} }));
  assert.match(empty, /shared discussion/);
  assert.doesNotMatch(empty, /committed repository/);
  const settings = renderToStaticMarkup(createElement(ProjectSettings, { project: project(), collaborationOnly: true, disabled: false, manage: async () => false as const }));
  assert.match(settings, /Name and purpose/); assert.match(settings, /Archive project/);
  assert.doesNotMatch(settings, /Add check|Save check configuration|Executable|Import recovery/);
  for (const view of ['workspace', 'review', 'evidence', 'timeline', 'integration', 'verify'] as const) assert.deepEqual(collaborationRoute({ view, projectId: 'p' }), { view: 'discussion', projectId: 'p' });
  for (const view of ['accept', 'discussion', 'collaboration', 'settings', 'projects'] as const) assert.deepEqual(collaborationRoute({ view, projectId: 'p' }), { view, projectId: 'p' });
  assert.deepEqual(collaborationRoute({ view: 'verify' }), { view: 'projects' });
});
test('verified project owners can update metadata and archive through explicit manage permission', () => {
  const owner = project({ roles: ['reader', 'sponsor', 'export'], permissions: { manage: true } });
  assert.equal(freezeMetadataCommand(directory(), owner, 'Archive project', 'archive', {}).path, '/api/projects/repo-one/archive');
  assert.throws(() => freezeMetadataCommand(directory(), project({ permissions: { manage: false } }), 'Archive project', 'archive', {}), /administrator access/);
});

test('the default authorized workflow is first in the directory and a noncreator empty state does not promise project creation', () => {
  const other = project({ projectId: 'other', name: 'Other repository' });
  const pilot = project({ projectId: 'pilot', name: 'Cache collaboration', capabilities: { nativeWorkflow: true, repositoryChecks: false, publication: true, reason: 'Native' } });
  const html = renderToStaticMarkup(createElement(Projects, { directory: directory({ projects: [other, pilot] }), disabled: false, manage: async () => false as const, open() {} }));
  assert(html.indexOf('Cache collaboration') < html.indexOf('Other repository'));
  assert.match(html, /Open release workflow/);
  assert.match(html, /Default project/);
  const unavailable = renderToStaticMarkup(createElement(Projects, { directory: directory({ projects: [], canCreate: false }), disabled: false, manage: async () => false as const, open() {} }));
  assert.match(unavailable, /No project access yet/);
  assert.doesNotMatch(unavailable, /Create your first project/);
});

test('repository commands quote actual paths and preserve explicit project and deployment scope', () => {
  const commands = repositoryCommands('repo-one', 'https://owned.example', "/tmp/Customer portal's source");
  assert(commands);
  assert.equal(commands.inspect, "confidence repo inspect '/tmp/Customer portal'\\''s source' --json");
  assert.match(commands.import, /--project 'repo-one' --confirm$/);
  assert.equal(commands.signIn, "confidence auth login --target 'https://owned.example'");
  const local = repositoryCommands('repo-two', 'http://127.0.0.1:8879', '-source');
  assert(local); assert.equal(local.signIn, null);
  assert.match(local.import, /'\.\/-source' --local/);
  for (const invalid of ['', ' ', '/tmp/bad\npath', '/tmp/bad\u0000path', 'x'.repeat(1025)]) assert.equal(repositoryCommands('repo-one', 'https://owned.example', invalid), null);
});

test('import commands are copyable per step only for an active managed empty workspace', () => {
  const guide = renderToStaticMarkup(createElement(ImportGuide, { project: project(), origin: 'https://owned.example', disabled: true }));
  assert.match(guide, /Repository path/);
  for (const label of ['inspect source', 'sign in', 'import source']) assert.match(guide, new RegExp(`disabled=""[^>]*aria-label="Copy ${label} command"`));
  const reader = renderToStaticMarkup(createElement(RepositoryWorkspace, { project: project({ permissions: { manage: false } }), origin: 'https://owned.example', openSettings() {} }));
  const archived = renderToStaticMarkup(createElement(RepositoryWorkspace, { project: project({ status: 'ARCHIVED' }), origin: 'https://owned.example', openSettings() {} }));
  for (const html of [reader, archived]) assert.doesNotMatch(html, /Repository path|Copy import source command/);
  assert.match(reader, /Inspect checks/);
});
const native = { tenantId: 'tenant', projectId: 'pilot', projectIncarnation: 'native-incarnation', revision: 5,
  session: { principalId: 'issuer#owner', credentialClass: 'human' }, capabilities: { deployment: false }, attempts: [], candidates: [] } as unknown as PlatformState;

test('acknowledged project notices clear on view, project and browser-history navigation without settling a pending command', async () => {
  const session = new CommandSession(storage(), async () => project());
  const settings = routeFromHash('#/projects/repo-one/settings');
  assert.equal(await session.beginMetadata(directory(), project({ status: 'ARCHIVED' }), 'Restore project', 'restore', {}), true);
  const acknowledged = navigationReducer({ route: settings, notice: '' }, { type: 'notice', notice: 'Restore project: saved.' });
  assert.equal(navigationReducer(acknowledged, { type: 'route', route: routeFromHash('#/projects/repo-one/settings') }).notice, 'Restore project: saved.', 'duplicate hash notification does not erase a current acknowledgement');
  for (const nextHash of ['#/projects/repo-one/workspace', '#/projects/pilot/settings', '#/projects']) {
    const changed = navigationReducer(acknowledged, { type: 'route', route: routeFromHash(nextHash) });
    assert.equal(changed.notice, '', nextHash);
    assert.equal(navigationReducer(changed, { type: 'route', route: settings }).notice, '', 'returning through history cannot revive the old success notice');
  }
  const uncertain = new CommandSession(storage(), async () => { throw new ApiError('Acknowledgement lost'); });
  await uncertain.beginMetadata(directory(), project(), 'Save details', 'update', { name: 'Later name', description: '' });
  const pending = structuredClone(uncertain.getSnapshot().pending);
  navigationReducer(acknowledged, { type: 'route', route: routeFromHash('#/projects/pilot/workspace') });
  assert.deepEqual(uncertain.getSnapshot().pending, pending, 'navigation only dismisses success copy; original pending recovery stays retained');
});

test('project routes preserve legacy views and keep explicit projects separate from fallback links', () => {
  assert.deepEqual(routeFromHash(''), { view: 'projects' });
  assert.deepEqual(routeFromHash('#/projects'), { view: 'projects' });
  for (const [view, suffix] of [['workspace', 'workspace'], ['review', 'review'], ['evidence', 'evidence'], ['timeline', 'history'], ['verify', 'verify'], ['integration', 'runtime'], ['settings', 'settings'], ['collaboration', 'collaboration'], ['accept', 'accept']] as const) {
    assert.equal(viewFromHash(`#/${suffix}`), view);
    assert.deepEqual(routeFromHash(`#/${suffix}`), { view });
    const route = routeForView(view, 'repo_2');
    assert.equal(route, `#/projects/repo_2/${suffix}`);
    assert.deepEqual(routeFromHash(route), { view, projectId: 'repo_2' });
  }
  for (const hash of ['#/projects/%2F/workspace', '#/projects/a/unknown', '#/projects/../workspace', '#/projects/%ZZ/workspace', '#/projects/a/workspace?project=b']) assert.deepEqual(routeFromHash(hash), { view: 'projects' });
  assert.throws(() => routeForView('workspace', '../other'));
});

test('project metadata controls honor explicit owner capabilities without fabricating administrator roles', () => {
  const owner = project({ roles: ['reader', 'sponsor', 'export'], permissions: { manage: true } });
  const ownerRead = readDirectoryResponse(directory({ projects: [owner] })).projects[0];
  assert.equal(canManageProject(ownerRead), true);
  assert.deepEqual(ownerRead.roles, ['reader', 'sponsor', 'export']);
  assert.equal(canManageProject(project({ permissions: { manage: false } })), false);
  assert.equal(canManageProject(project()), true);
  assert.equal(canManageProject(project({ roles: ['reader'] })), false);
});

test('state, source and receipt reads explicitly scope the selected project', async () => {
  assert.equal(projectApiPath('repo-one', '/api/candidates/source-1/source?version=base'), '/api/projects/repo-one/candidates/source-1/source?version=base');
  assert.equal(projectApiPath('repo-one', '/api/receipts/1/export'), '/api/projects/repo-one/receipts/1/export');
  assert.equal(projectApiPath(undefined, '/api/state'), '/api/state');
  assert.throws(() => projectApiPath('../wrong', '/api/state'));
  const old = deferred<PlatformState>(), seen: string[] = [];
  const oldRead = createProjectStateReader('old', async path => { seen.push(String(path)); return old.promise; });
  const newRead = createProjectStateReader('new', async path => { seen.push(String(path)); return { ...native, projectId: 'new', revision: 1 }; });
  const earlier = oldRead();
  const current = await newRead();
  old.resolve({ ...native, projectId: 'old', revision: 999 });
  assert.equal((await earlier).projectId, 'old');
  assert.equal(current.projectId, 'new');
  assert.deepEqual(seen, ['/api/projects/old/state', '/api/projects/new/state']);
  await assert.rejects(createProjectStateReader('new', async () => ({ ...native, projectId: 'old' }))(), { status: 404, code: 'PROJECT_UNAVAILABLE' });
});

test('directory authentication loss discards private projects and fences a late earlier response', async () => {
  const late = deferred<ProjectDirectoryResponse>(); let calls = 0;
  const reader = createProjectDirectory(async () => { if (++calls === 1) return directory(); if (calls === 2) return late.promise; throw new ApiError('Sign in again', 401); });
  await reader.refresh();
  const earlier = reader.refresh();
  await reader.refresh();
  assert.equal(reader.getSnapshot().data, undefined);
  late.resolve(directory()); await earlier;
  assert.equal(reader.getSnapshot().data, undefined);
  assert.equal(reader.getSnapshot().current, false);
});

test('newer directory principal wins over a late successful read and old failures', async () => {
  for (const failure of [false, true]) {
    const late = deferred<ProjectDirectoryResponse>(); let calls = 0;
    const reader = createProjectDirectory(async () => ++calls === 1 ? late.promise : directory({ principalId: 'issuer#other', projects: [] }));
    const earlier = reader.refresh(); await reader.refresh();
    if (failure) late.reject(new ApiError('Old access denied', 403)); else late.resolve(directory());
    await earlier;
    assert.equal(reader.getSnapshot().data?.principalId, 'issuer#other');
    assert.equal(reader.getSnapshot().current, true);
  }
  assert.throws(() => readDirectoryResponse(directory({ projects: [project(), project()] })), /could not be verified/);
});

test('project management freezes the metadata revision and exact scoped identity independently of native workflow revision', () => {
  const list = directory(), target = list.projects[0];
  const frozen = freezeMetadataCommand(list, target, 'Rename', 'update', { name: 'New name', description: '' }, 'rename-once');
  target.revision = '500'; target.name = 'Later name';
  assert.equal(frozen.path, '/api/projects/repo-one/update');
  assert.equal(frozen.headers['If-Platform-Revision'], '3');
  assert.equal(frozen.headers['If-Platform-Incarnation'], 'incarnation-one');
  assert.equal(frozen.headers['If-Platform-Principal'], 'issuer#owner');
  assert.deepEqual(JSON.parse(frozen.body), { name: 'New name', description: '' });
  assert.equal(frozen.scope, metadataScope(list, target));
  const create = freezeMetadataCommand(list, undefined, 'Create', 'create', { name: 'New' }, 'create-once');
  assert.equal(create.path, '/api/projects');
  assert.equal(create.headers['If-Platform-Revision'], undefined);
  assert.throws(() => freezeMetadataCommand(directory({ canCreate: false }), undefined, 'Create', 'create', { name: 'New' }), /administrator/);
  assert.throws(() => freezeMetadataCommand(list, project({ roles: ['reader'] }), 'Rename', 'update', {}), /administrator/);
  assert.throws(() => freezeMetadataCommand(list, project({ status: 'ARCHIVED' }), 'Rename', 'update', {}), /Restore/);
  assert.equal(freezeMetadataCommand(list, project({ status: 'ARCHIVED' }), 'Restore', 'restore', {}).path, '/api/projects/repo-one/restore');
});

test('unknown project changes survive reload without allowing native or other project intents', async () => {
  const retained = storage(), sent: PendingCommand[] = [], list = directory();
  const first = new CommandSession(retained, async command => { sent.push(structuredClone(command)); throw new ApiError('Response lost'); });
  assert.equal(await first.beginMetadata(list, list.projects[0], 'Archive', 'archive', {}), false);
  assert.equal(first.getSnapshot().pending?.status, 'UNKNOWN');
  await assert.rejects(first.begin(native, 'Launch', '/api/demo', { mode: 'scripted' }), /Resolve the retained command/);
  await assert.rejects(first.beginMetadata(list, project({ projectId: 'other' }), 'Rename', 'update', { name: 'Other' }), /Resolve the retained command/);
  const recovered = new CommandSession(retained, async command => { sent.push(structuredClone(command)); return project({ status: 'ARCHIVED', revision: '4' }); });
  await assert.rejects(recovered.retryMetadata(directory({ principalId: 'issuer#other' }), list.projects[0]), /different principal/);
  await assert.rejects(recovered.retryMetadata(list, project({ projectIncarnation: 'replacement' })), /different principal/);
  assert.equal(await recovered.retryMetadata(list, project({ status: 'ARCHIVED', revision: '4' })), true);
  for (const field of ['id', 'path', 'scope', 'headers', 'body'] as const) assert.deepEqual(sent[1][field], sent[0][field]);
  assert.equal(recovered.getSnapshot().pending, undefined);
});

test('metadata commands persist before dispatch and a later access denial cannot settle an uncertain change', async () => {
  let calls = 0;
  const unavailable = new CommandSession({ ...storage(), setItem: () => { throw new Error('Storage unavailable'); } }, async () => { calls++; });
  await assert.rejects(unavailable.beginMetadata(directory(), undefined, 'Create', 'create', { name: 'New' }), /Storage unavailable/);
  assert.equal(calls, 0);
  const session = new CommandSession(storage(), async () => { throw calls++ ? new ApiError('Access denied', 403) : new ApiError('Timed out'); });
  await session.beginMetadata(directory(), project(), 'Save checks', 'checks', { checks: [] });
  await session.retryMetadata(directory(), project());
  assert.equal(session.getSnapshot().pending?.status, 'UNKNOWN');
});

test('local project commands use explicit aliases without changing legacy command records', () => {
  const old = freezeCommand(native, 'Launch', '/api/demo', { mode: 'scripted' }, 'legacy');
  const scoped = freezeCommand(native, 'Launch', '/api/demo', { mode: 'scripted' }, 'scoped', true);
  assert.equal(old.path, '/api/demo');
  assert.equal(scoped.path, '/api/projects/pilot/demo');
  assert.equal(scoped.scope, old.scope);
});

test('repository workspace and settings distinguish configuration from executed release evidence', () => {
  const target = project({ checks: [{ id: 'unit', name: 'Unit tests', argv: ['npm', 'test'], cwd: '.', timeoutSeconds: 120, enabled: true, required: true, source: 'detected', evidenceClass: 'repository-check' }] });
  const html = renderToStaticMarkup(createElement(RepositoryWorkspace, { project: target, origin: 'https://owned.example', openSettings() {} }));
  assert.match(html, /1 check enabled/);
  assert.match(html, /They have not been executed/);
  assert.match(html, /do not create passing evidence or authorize a publication/);
  assert.match(html, /confidence project import/);
  assert.doesNotMatch(html, /Launch 3 agents|cache\.mjs|Fresh values after/);
  const readonly = renderToStaticMarkup(createElement(ProjectSettings, { project: { ...target, roles: ['reader'] }, disabled: false, manage: async () => false as const }));
  assert.match(readonly, /A project administrator can change them/);
  assert.match(readonly, /<fieldset[^>]*disabled/);
  const archived = renderToStaticMarkup(createElement(ProjectSettings, { project: { ...target, status: 'ARCHIVED' }, disabled: false, manage: async () => false as const }));
  assert.match(archived, /Restore project/);
  assert.doesNotMatch(archived, />Confirm archive</);
});

test('directory names come from metadata and import commands safely quote target arguments', () => {
  const html = renderToStaticMarkup(createElement(Projects, { directory: directory(), disabled: false, manage: async () => false as const, open() {} }));
  assert.match(html, /Customer portal/);
  assert.doesNotMatch(html, /Cache collaboration|Competition workspace/);
  assert.equal(importCommand('repo-one', 'https://owned.example'), "confidence project import './my-repo' --target 'https://owned.example' --project 'repo-one' --confirm");
  assert.match(importCommand('repo-one', "https://owned.example/it's"), /it'\\''s/);
  assert.match(importCommand('repo-one', 'http://127.0.0.1:8879'), /'\.\/my-repo' --local --target/);
});

test('maintenance blocks project mutations and exact retries before dispatch', async () => {
  let calls = 0;
  const session = new CommandSession(storage(), async () => { calls++; throw new ApiError('Interrupted'); });
  await assert.rejects(session.beginMetadata(directory({ maintenance: true }), undefined, 'Create', 'create', { name: 'New' }), /Maintenance/);
  assert.equal(calls, 0);
  await session.beginMetadata(directory(), undefined, 'Create', 'create', { name: 'New' });
  await assert.rejects(session.retryMetadata(directory({ maintenance: true })), /Maintenance/);
  assert.equal(calls, 1);
  assert.equal(session.getSnapshot().pending?.status, 'UNKNOWN');
});

test('pending import cancellation names the exact operation and requires a deliberate reason and confirmation', () => {
  const target = project({ pendingImport: { commandId: 'original-import', principalId: 'issuer#owner' } });
  const html = renderToStaticMarkup(createElement(PendingImport, { project: target, disabled: false, manage: async () => false as const }));
  assert.match(html, /original-import/);
  assert.match(html, /Reason for cancellation/);
  assert.match(html, /original command cannot be resumed after cancellation/);
  assert.match(html, /disabled="">Cancel this import/);
  assert.equal(renderToStaticMarkup(createElement(PendingImport, { project: { ...target, roles: ['reader'] }, disabled: false, manage: async () => false as const })), '');
  const frozen = freezeMetadataCommand(directory(), target, 'Cancel import', 'cancel-import', { ...target.pendingImport, reason: 'Abandon the interrupted fixture' }, 'cancel-import');
  assert.equal(frozen.path, '/api/projects/repo-one/cancel-import');
  assert.deepEqual(JSON.parse(frozen.body), { commandId: 'original-import', principalId: 'issuer#owner', reason: 'Abandon the interrupted fixture' });
});

test('late command acknowledgement settles the retained intent without navigating or refreshing an old view', async () => {
  for (const outcome of ['confirmed', 'unknown', 'error'] as const) {
    const response = deferred<unknown>(), session = new CommandSession(storage(), () => response.promise);
    let generation = 1;
    const effects: string[] = [];
    const observed = observeCommand(() => session.begin(native, 'Prepare review', '/api/review', {}, true), {
      current: () => generation === 1, acknowledged: () => effects.push('navigate'), failed: () => effects.push('error'), finished: () => effects.push('refresh'),
    });
    assert.equal(session.getSnapshot().pending?.status, 'SENDING');
    generation++;
    if (outcome === 'confirmed') response.resolve({ accepted: true });
    else response.reject(new ApiError(outcome === 'unknown' ? 'Response lost' : 'Rejected', outcome === 'unknown' ? undefined : 409, outcome === 'error' ? 'INVALID_REQUEST' : undefined));
    assert.equal(await observed, false);
    assert.deepEqual(effects, []);
    if (outcome === 'confirmed') assert.equal(session.getSnapshot().pending, undefined);
    else assert.ok(session.getSnapshot().pending, 'uncertain or rejected command remains explicitly recoverable');
  }
});

test('current command observation confirms only acknowledged work and always finishes its view', async () => {
  for (const confirmed of [false, true]) {
    const effects: string[] = [];
    assert.equal(await observeCommand(async () => confirmed, { current: () => true, acknowledged: () => effects.push('ack'), failed: () => effects.push('error'), finished: () => effects.push('refresh') }), confirmed);
    assert.deepEqual(effects, confirmed ? ['ack', 'refresh'] : ['refresh']);
  }
});

test('a newer workflow principal or incarnation fences old command effects before the directory refreshes', async () => {
  for (const changed of [{ ...native, session: { ...native.session, principalId: 'issuer#other' } }, { ...native, projectIncarnation: 'new-incarnation' }, undefined]) {
    const response = deferred<unknown>(), session = new CommandSession(storage(), () => response.promise);
    const originalScope = commandScope(native);
    let acceptedScope: string | undefined = originalScope;
    const effects: string[] = [];
    const observed = observeCommand(() => session.begin(native, 'Prepare review', '/api/review', {}, true), {
      current: () => acceptedScope === originalScope, acknowledged: () => effects.push('navigate'), failed: () => effects.push('error'), finished: () => effects.push('refresh'),
    });
    if (changed) {
      const read = createProjectStateReader(native.projectId, async () => changed as PlatformState);
      acceptedScope = commandScope(await read());
    } else acceptedScope = undefined;
    response.resolve({ accepted: true });
    assert.equal(await observed, false);
    assert.deepEqual(effects, []);
    assert.equal(session.getSnapshot().pending, undefined);
  }
});

test('project creation acknowledgement cannot navigate a different account, tenant or selected route', async () => {
  for (const change of ['principal', 'tenant', 'route', 'unavailable', 'none']) {
    let currentDirectory = directory(), route = '#/projects', denied = false;
    const store = createProjectDirectory(async () => { if (denied) throw new ApiError('Sign in again', 401); return currentDirectory; });
    await store.refresh();
    const response = deferred<unknown>(), session = new CommandSession(storage(), () => response.promise);
    const effects: string[] = [];
    const observed = observeCommand(async () => {
      const acknowledged = await session.beginMetadata(currentDirectory, undefined, 'Create', 'create', { name: 'New workspace' });
      await store.refresh();
      return acknowledged;
    }, { current: observeDirectoryContext(store, () => route), acknowledged: () => effects.push('navigate'), failed: () => effects.push('error'), finished: () => effects.push('notice') });
    if (change === 'principal') currentDirectory = directory({ principalId: 'issuer#other' });
    if (change === 'tenant') currentDirectory = directory({ tenantId: 'another-tenant' });
    if (change === 'route') route = '#/projects/existing/settings';
    if (change === 'unavailable') denied = true;
    response.resolve(project({ projectId: 'newly-created' }));
    assert.equal(await observed, change === 'none');
    assert.deepEqual(effects, change === 'none' ? ['navigate', 'notice'] : []);
    assert.equal(session.getSnapshot().pending, undefined, 'backend acknowledgement remains settled across account/view changes');
  }
});

test('malformed project variants become a recoverable directory error before any rendering', async () => {
  const invalid: unknown[] = [null, { ...project(), projectId: undefined }, { ...project(), source: { status: 'IMPORTED' } },
    { ...project(), source: { status: 'ENROLLED' } }, { ...project(), checks: [null] }, { ...project(), checks: [{ argv: null }] },
    { ...project(), pendingImport: {} }, { ...project(), roles: [null] }, { ...project(), capabilities: { nativeWorkflow: false } },
    { ...project(), capabilities: { ...project().capabilities, reason: {} } },
    { ...project(), permissions: {} }, { ...project(), permissions: { manage: 'true' } }];
  for (const malformed of invalid) {
    assert.throws(() => readDirectoryResponse({ ...directory(), projects: [malformed] }), /response could not be verified/);
  }
  for (const patch of [{ maintenance: 'true' }, { limit: null }, { defaultProjectId: undefined }]) assert.throws(() => readDirectoryResponse({ ...directory(), ...patch }), /response could not be verified/);
  let malformed = false;
  const store = createProjectDirectory(async () => malformed ? { ...directory(), projects: [{ ...project(), source: { status: 'IMPORTED' } }] } : directory());
  await store.refresh(); malformed = true; await store.refresh();
  assert.equal(store.getSnapshot().current, false);
  assert.equal(store.getSnapshot().data?.projects[0].source.status, 'EMPTY');
  assert.match(store.getSnapshot().error, /response could not be verified/);
});

test('malformed or mismatched project acknowledgements retain the exact uncertain intent', async () => {
  for (const response of [null, { accepted: true }, project({ projectId: 'another-project' }), project({ projectIncarnation: 'replaced' })]) {
    const sent: PendingCommand[] = []; let attempt = 0;
    const session = new CommandSession(storage(), async command => { sent.push(structuredClone(command)); return attempt++ === 0 ? response : project(); });
    assert.equal(await session.beginMetadata(directory(), project(), 'Save', 'update', { name: 'Customer portal', description: '' }), false);
    assert.equal(session.getSnapshot().pending?.status, 'UNKNOWN');
    assert.equal(await session.retryMetadata(directory(), project()), true);
    for (const field of ['id', 'path', 'scope', 'headers', 'body'] as const) assert.deepEqual(sent[1][field], sent[0][field]);
    assert.equal(session.getSnapshot().pending, undefined);
  }
});
