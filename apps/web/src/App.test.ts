import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectDiscussionRoute, ProjectNavigation } from './App';
import { createSessionIdentity, projectDiscussionAvailable, type IdentityState } from './session-identity';

const principalId = 'https://issuer.test#human';
async function identity(extra: Record<string, unknown> = {}): Promise<IdentityState> {
  const store = createSessionIdentity(async () => ({ principalId, credentialClass: 'human', ...extra }));
  await store.refresh();
  return store.getSnapshot();
}
function navigation(discussionEnabled: boolean, collaborationOnly = false, nativeWorkflow = true) {
  return renderToStaticMarkup(createElement(ProjectNavigation, { profileKnown: true, collaborationOnly, nativeWorkflow, discussionEnabled, view: 'workspace', open() {} }));
}

test('disabled and legacy full deployments hide discussion even for native release projects', async () => {
  for (const extra of [{}, { projectDiscussion: false }]) {
    const state = await identity(extra);
    assert.equal(state.status, 'verified');
    const html = navigation(projectDiscussionAvailable(state, principalId));
    assert.doesNotMatch(html, /Discussion/);
    assert.match(html, /Workspace/);
    assert.match(html, /Release review/);
    assert.match(html, /Project access/);
  }
  assert.doesNotMatch(navigation(false, false, false), /Discussion/);
});

test('enabled and older collaboration-only sessions retain discussion navigation while explicit false wins', async () => {
  for (const extra of [{ projectDiscussion: true }, { deploymentProfile: 'collaboration-only' }]) {
    const state = await identity(extra);
    assert.equal(state.status, 'verified');
    assert.match(navigation(projectDiscussionAvailable(state, principalId), 'deploymentProfile' in extra), /Discussion/);
    assert.match(navigation(projectDiscussionAvailable(state, principalId), false, false), /Discussion/);
  }
  const disabled = await identity({ deploymentProfile: 'collaboration-only', projectDiscussion: false });
  assert.equal(disabled.status, 'verified');
  const html = navigation(projectDiscussionAvailable(disabled, principalId), true);
  assert.doesNotMatch(html, /Discussion|Release review/);
  assert.match(html, /Project access/);
});

test('unverified, changed-account and local-pilot sessions cannot expose unsupported discussion', async () => {
  const current = await identity({ projectDiscussion: true });
  assert.equal(projectDiscussionAvailable(current, 'another-account'), false);
  assert.equal(projectDiscussionAvailable(current), false);
  for (const state of [{ status: 'idle' }, { status: 'loading' }, { status: 'unavailable', signInRequired: true }] as IdentityState[]) {
    assert.equal(projectDiscussionAvailable(state, principalId), false);
  }
  const local = createSessionIdentity(async () => ({ principalId: 'local-pilot', credentialClass: 'human' }));
  await local.refresh();
  assert.equal(projectDiscussionAvailable(local.getSnapshot(), 'local-pilot'), false);
  assert.doesNotMatch(navigation(false), /Discussion/);
});

test('disabled direct discussion links render useful recovery without mounting the API-backed discussion', () => {
  let mounted = 0;
  function Discussion() { mounted++; return createElement('p', {}, 'Discussion loaded'); }
  const child = createElement(Discussion);
  const disabled = renderToStaticMarkup(createElement(ProjectDiscussionRoute, { enabled: false, openProjects() {}, children: child }));
  assert.equal(mounted, 0);
  assert.match(disabled, /Discussion is unavailable/);
  assert.match(disabled, /not enabled in this deployment/);
  assert.match(disabled, /Open projects/);
  assert.doesNotMatch(disabled, /Discussion loaded/);
  const active = renderToStaticMarkup(createElement(ProjectDiscussionRoute, { enabled: true, openProjects() {}, children: child }));
  assert.equal(mounted, 1);
  assert.match(active, /Discussion loaded/);
  assert.doesNotMatch(active, /unavailable/);
});
