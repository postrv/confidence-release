import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectDirectoryResponse } from '../../../packages/project-model/src/types';
import { routeFromHash } from './navigation';
import { createGuardedNavigation, createUnsavedChanges, protectedDraftScope, settingsDraftScope, type NavigationBrowser } from './unsaved-changes';

function browser(initial = '#/projects') {
  const listeners = new Map<string, Set<EventListener>>();
  const entries = [{ hash: initial, state: null as unknown }];
  let index = 0;
  const emit = (type: string, event = new Event(type, { cancelable: true })) => {
    if (type === 'beforeunload') Object.defineProperty(event, 'returnValue', { value: '', writable: true });
    for (const listener of listeners.get(type) ?? []) listener(event);
    return event;
  };
  const location = { get hash() { return entries[index].hash; } };
  const history = {
    get state() { return entries[index].state; },
    pushState(state: unknown, _unused: string, hash?: string | URL | null) { entries.splice(index + 1); entries.push({ state, hash: String(hash) }); index++; },
    replaceState(state: unknown, _unused: string, hash?: string | URL | null) { entries[index] = { state, hash: String(hash) }; },
    go(delta = 0) { index += delta; assert.ok(index >= 0 && index < entries.length); emit('popstate'); emit('hashchange'); },
  };
  const host: NavigationBrowser = {
    location, history,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  return { host, emit, entries, externalHash(hash: string) { history.pushState(null, '', hash); emit('hashchange'); } };
}

test('dirty registration only protects its exact account, tenant, project and incarnation', () => {
  const guard = createUnsavedChanges();
  const project = { projectId: 'repo', projectIncarnation: 'first' };
  const directory = { tenantId: 'tenant', principalId: 'owner', defaultProjectId: 'repo', projects: [project] } as ProjectDirectoryResponse;
  const route = routeFromHash('#/projects/repo/settings'), scope = settingsDraftScope(directory, route)!;
  const release = guard.register(scope, true);
  assert.equal(guard.hasChanges(scope), true);
  for (const changed of [undefined, { ...directory, principalId: 'teammate' }, { ...directory, tenantId: 'other' },
    { ...directory, projects: [{ ...project, projectIncarnation: 'second' }] }, { ...directory, projects: [] }]) {
    assert.equal(guard.hasChanges(settingsDraftScope(changed as ProjectDirectoryResponse | undefined, route)), false);
  }
  assert.equal(guard.hasChanges(settingsDraftScope(directory, routeFromHash('#/projects/repo/workspace'))), false);
  const newer = guard.register(scope, true); release();
  assert.equal(guard.hasChanges(scope), true, 'stale editor cleanup must not remove its replacement');
  newer(); assert.equal(guard.hasChanges(scope), false);
});

test('save failure keeps protection; a clean saved or discarded draft removes it', () => {
  const guard = createUnsavedChanges(); guard.register('scope', true);
  assert.equal(guard.hasChanges('scope'), true);
  // Rejected/uncertain commands do not register a clean draft.
  guard.register('scope', true); assert.equal(guard.hasChanges('scope'), true);
  guard.register('scope', false); assert.equal(guard.hasChanges('scope'), false);
});

test('discussion recovery and private delivery stay mounted when navigation or reload is cancelled', () => {
  const project = { projectId: 'repo', projectIncarnation: 'first' };
  const directory = { tenantId: 'tenant', principalId: 'owner', defaultProjectId: 'repo', projects: [project] } as ProjectDirectoryResponse;
  const fake = browser('#/projects/repo/discussion'), drafts = createUnsavedChanges();
  const scope = protectedDraftScope(directory, routeFromHash(fake.host.location.hash))!;
  drafts.register(scope, true);
  const visited: string[] = [];
  const navigation = createGuardedNavigation(fake.host, { sessionId: 'discussion',
    hasChanges: route => drafts.hasChanges(protectedDraftScope(directory, route)),
    canLeave: route => !drafts.hasChanges(protectedDraftScope(directory, route)),
    changed: route => visited.push(route.view) });
  const stop = navigation.listen();
  for (const target of ['#/projects', '#/projects/another/discussion', '#/projects/repo/collaboration']) {
    assert.equal(navigation.navigate(target), false);
    assert.equal(fake.host.location.hash, '#/projects/repo/discussion');
  }
  assert.equal(fake.emit('beforeunload').defaultPrevented, true);
  assert.deepEqual(visited, []);
  assert.equal(drafts.hasChanges(protectedDraftScope({ ...directory, principalId: 'other' }, routeFromHash(fake.host.location.hash))), false);
  assert.equal(drafts.hasChanges(protectedDraftScope({ ...directory, projects: [{ ...project, projectIncarnation: 'replacement' }] } as ProjectDirectoryResponse, routeFromHash(fake.host.location.hash))), false);
  drafts.register(scope, false);
  assert.equal(fake.emit('beforeunload').defaultPrevented, false);
  assert.equal(navigation.navigate('#/projects/repo/collaboration'), true);
  stop();
});

test('nonmember join-request recovery has its own account and project scope without fabricating membership', () => {
  const directory = { tenantId: 'tenant', principalId: 'requester', projects: [] } as unknown as ProjectDirectoryResponse;
  const route = routeFromHash('#/projects/shared/discussion');
  const scope = protectedDraftScope(directory, route);
  assert.ok(scope);
  assert.notEqual(scope, protectedDraftScope({ ...directory, principalId: 'other' }, route));
  assert.notEqual(scope, protectedDraftScope(directory, routeFromHash('#/projects/another/discussion')));
  assert.equal(protectedDraftScope(undefined, route), undefined);
  assert.equal(protectedDraftScope(directory, { view: 'discussion' }), undefined);
  assert.equal(protectedDraftScope(directory, { view: 'collaboration', projectId: 'shared' }), undefined);
});

test('sidebar, project switch and tool navigation retain the editor when discard is cancelled', () => {
  const fake = browser('#/projects/repo/settings'); let permitted = false, confirmations = 0;
  const seen: string[] = [];
  const navigation = createGuardedNavigation(fake.host, { sessionId: 'session', hasChanges: () => true,
    canLeave: () => { confirmations++; return permitted; }, changed: route => seen.push(route.view) });
  navigation.listen();
  assert.equal(navigation.navigate('#/projects/repo/settings'), true); assert.equal(confirmations, 0);
  for (const target of ['#/projects', '#/projects/another/workspace', '#/projects/repo/verify']) {
    assert.equal(navigation.navigate(target), false); assert.equal(fake.host.location.hash, '#/projects/repo/settings');
  }
  assert.deepEqual(seen, []); assert.equal(fake.entries.length, 1);
  permitted = true; assert.equal(navigation.navigate('#/projects'), true);
  assert.deepEqual(seen, ['projects']); assert.equal(fake.entries.length, 2);
});

test('cancelled Back and Forward retain both editor and usable history entries', () => {
  const fake = browser(); let dirty = false, permit = false, confirmations = 0;
  const seen: string[] = [];
  const navigation = createGuardedNavigation(fake.host, { sessionId: 'session', hasChanges: () => dirty,
    canLeave: route => { if (route.view !== 'settings' || !dirty) return true; confirmations++; return permit; },
    changed: route => seen.push(route.view) });
  navigation.listen(); navigation.navigate('#/projects/repo/settings'); navigation.navigate('#/projects/repo/workspace');
  fake.host.history.go(-1); dirty = true;
  const before = structuredClone(fake.entries), visits = seen.length;
  fake.host.history.go(-1);
  assert.equal(fake.host.location.hash, '#/projects/repo/settings'); assert.deepEqual(fake.entries, before); assert.equal(seen.length, visits);
  fake.host.history.go(1);
  assert.equal(fake.host.location.hash, '#/projects/repo/settings'); assert.deepEqual(fake.entries, before); assert.equal(seen.length, visits);
  assert.equal(confirmations, 2, 'popstate and hashchange must not display duplicate prompts');
  permit = true; fake.host.history.go(1);
  assert.equal(fake.host.location.hash, '#/projects/repo/workspace'); assert.equal(seen.at(-1), 'workspace');
});

test('external hash edits are guarded without remounting a cancelled draft', () => {
  const fake = browser('#/projects/repo/settings'); const seen: string[] = [];
  const navigation = createGuardedNavigation(fake.host, { sessionId: 'session', hasChanges: () => true,
    canLeave: () => false, changed: route => seen.push(route.view) });
  navigation.listen(); fake.externalHash('#/projects/other/workspace');
  assert.equal(fake.host.location.hash, '#/projects/repo/settings'); assert.deepEqual(seen, []);
});

test('reload and close prompt only for a current dirty scope; listeners clean up', () => {
  const fake = browser('#/projects/repo/settings'); let currentScope = 'owner', dirty = true;
  const navigation = createGuardedNavigation(fake.host, { sessionId: 'session', hasChanges: () => currentScope === 'owner' && dirty,
    canLeave: () => true, changed: () => {} });
  const stop = navigation.listen();
  assert.equal(fake.emit('beforeunload').defaultPrevented, true);
  dirty = false; assert.equal(fake.emit('beforeunload').defaultPrevented, false);
  dirty = true; currentScope = 'another-account'; assert.equal(fake.emit('beforeunload').defaultPrevented, false);
  currentScope = 'owner'; stop(); assert.equal(fake.emit('beforeunload').defaultPrevented, false);
});

test('an initial empty hash still supports cancelled Back without becoming stuck', () => {
  const fake = browser(''); let dirty = false;
  const navigation = createGuardedNavigation(fake.host, { sessionId: 'session', hasChanges: () => dirty,
    canLeave: () => !dirty, changed: () => {} });
  navigation.listen(); navigation.navigate('#/projects/repo/settings'); dirty = true;
  fake.host.history.go(-1); assert.equal(fake.host.location.hash, '#/projects/repo/settings');
  dirty = false; assert.equal(navigation.navigate('#/projects'), true);
});
