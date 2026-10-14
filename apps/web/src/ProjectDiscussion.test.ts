/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAgentConnection, DiscussionCommand, discussionAccessLost, discussionDraftAfterAcknowledgement, mergeDiscussionPage } from './project-discussion';
import { DiscussionThread, JoinAdmissionReview, ProjectJoinPanel } from './ProjectDiscussion';
import { ApiError } from './api';
import { routeForView, routeFromHash } from './navigation';

const scope = { schemaVersion: 1 as const, tenantId: 'tenant', projectId: 'project', projectIncarnation: 'incarnation' };
const actor = { principalId: 'https://issuer#human', credentialClass: 'human' as const };
const message = (sequence: string) => ({ sequence, requestId: `request-${sequence}`, kind: 'message' as const, text: `Message ${sequence}`, createdAt: 100, actor });
test('discussion links carry only the project, with no person or bearer credential', () => {
  assert.equal(routeForView('discussion', 'project'), '#/projects/project/discussion');
  assert.deepEqual(routeFromHash('#/projects/project/discussion'), { view: 'discussion', projectId: 'project' });
});
test('connection generation is private, independently random, and hashes the exact token text', async () => {
  const one = await createAgentConnection('https://confidence.example', scope, 'My agent', 100);
  const two = await createAgentConnection('https://confidence.example', scope, 'My agent', 100);
  assert.equal(Buffer.from(one.file.token, 'base64url').length, 32);
  assert.notEqual(one.file.token, two.file.token);
  assert.equal(one.registration.tokenHash, `sha256:${Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(one.file.token))).toString('hex')}`);
  assert.equal(one.registration.expiresAt, 86_500);
  assert.equal(JSON.stringify(one.registration).includes(one.file.token), false);
  assert.deepEqual(Object.keys(one.file).sort(), ['connectionId', 'origin', 'projectId', 'projectIncarnation', 'schemaVersion', 'token']);
});
test('incremental pages retain order, deduplicate retries and reject altered or regressing records', () => {
  const first = mergeDiscussionPage([], '0', { messages: [message('1'), message('2')], nextCursor: '2', hasMore: false });
  const second = mergeDiscussionPage(first, '2', { messages: [message('3')], nextCursor: '3', hasMore: false });
  assert.deepEqual(second.map(item => item.sequence), ['1', '2', '3']);
  assert.throws(() => mergeDiscussionPage(first, '2', { messages: [message('1')], nextCursor: '1', hasMore: false }));
  assert.throws(() => mergeDiscussionPage(first, '2', { messages: [message('3')], nextCursor: '4', hasMore: false }));
  assert.equal(mergeDiscussionPage(second, '3', { messages: [], nextCursor: '3', hasMore: false }).length, 3);
});
test('uncertain requests keep the same identity, exact body and account until acknowledged', async () => {
  const calls: { path: string; init: RequestInit }[] = [];
  const command = new DiscussionCommand(async (path, init) => { calls.push({ path, init }); if (calls.length === 1) throw new ApiError('Timeout'); return {}; });
  const body = { requestId: 'fixed', text: 'Original text', kind: 'handoff' };
  assert.equal(await command.begin('subject:project:incarnation', '/api/projects/project/hub/messages', body, { 'If-Platform-Principal': 'subject' }), false);
  body.text = 'Edited later';
  await assert.rejects(command.retry('different-account'));
  assert.equal(await command.retry('subject:project:incarnation'), true);
  assert.equal(calls[0].init.body, calls[1].init.body);
  assert.deepEqual(calls[0].init.headers, calls[1].init.headers);
  assert.equal(command.pending, undefined);
});
test('access loss after an uncertain response cannot declare the original append rejected', async () => {
  let calls = 0;
  const command = new DiscussionCommand(async () => { throw calls++ ? new ApiError('Revoked', 403) : new ApiError('Lost response'); });
  assert.equal(await command.begin('original', '/api/projects/project/hub/messages', { requestId: 'fixed' }, {}), false);
  assert.equal(await command.retry('original'), false);
  assert.equal(command.pending?.status, 'UNKNOWN');
  command.dismiss();
  assert.ok(command.pending);
});

test('agent and admission acknowledgements preserve unsent text; only the exact posted draft clears', async () => {
  const command = new DiscussionCommand(async () => ({}));
  const draft = 'Question still being composed';
  for (const path of ['/hub/connections', '/hub/connections/agent-a/revoke', '/join-requests', '/collaboration/admit-join-request']) {
    await command.begin('original', `/api/projects/project${path}`, { requestId: 'fixed' }, {});
    assert.equal(discussionDraftAfterAcknowledgement(draft, command.acknowledged), draft);
  }
  await command.begin('original', '/api/projects/project/hub/messages', { requestId: 'fixed', kind: 'question', text: draft }, {});
  assert.equal(discussionDraftAfterAcknowledgement(draft, command.acknowledged), '');
  assert.equal(discussionDraftAfterAcknowledgement('New text edited later', command.acknowledged), 'New text edited later');
});

test('a recovered message acknowledgement clears its original draft without clearing a newer draft', async () => {
  let calls = 0;
  const command = new DiscussionCommand(async () => { if (!calls++) throw new ApiError('Lost response'); return {}; });
  const original = { requestId: 'fixed', kind: 'message', text: 'Original draft' };
  assert.equal(await command.begin('original', '/api/projects/project/hub/messages', original, {}), false);
  assert.equal(discussionDraftAfterAcknowledgement(original.text, command.acknowledged), original.text);
  original.text = 'Edited while recovering';
  assert.equal(await command.retry('original'), true);
  assert.equal(discussionDraftAfterAcknowledgement('Original draft', command.acknowledged), '');
  assert.equal(discussionDraftAfterAcknowledgement(original.text, command.acknowledged), original.text);
});
test('changed-account responses clear private discussion state while temporary failures remain distinguishable', () => {
  for (const error of [new ApiError('Account changed', 409, 'SESSION_PRINCIPAL_CHANGED'), new ApiError('Revoked', 403), new ApiError('Expired', 401), new ApiError('Replaced', 409, 'HUB_SCOPE_MISMATCH')]) assert.equal(discussionAccessLost(error), true);
  assert.equal(discussionAccessLost(new ApiError('Unavailable', 503)), false);
  assert.equal(discussionAccessLost(new ApiError('Lost response')), false);
});
test('thread displays literal human/agent authors, message kinds and freshness without release authority claims', () => {
  const html = renderToStaticMarkup(createElement(DiscussionThread, { messages: [message('1'), { ...message('2'), kind: 'result', text: '<script>untrusted</script>', actor: { ...actor, credentialClass: 'agent', connectionId: 'agent-a', label: 'Laurence agent' } }], cursor: '2', checkedAt: 1000, error: 'Read unavailable', hasMore: false }));
  assert.match(html, /Human/); assert.match(html, /Laurence agent/); assert.match(html, /Agent/); assert.match(html, /result/);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /unverified/); assert.match(html, /Cursor 2/);
  assert.doesNotMatch(html, /Approved|Published|Checks passed/);
});
test('nonmember project-link view requests own access and contains no principal relay field', () => {
  const html = renderToStaticMarkup(createElement(ProjectJoinPanel, { view: { schemaVersion: 1, scope, projectName: 'Shared project', projectStatus: 'ACTIVE', revision: '1', canManage: false, canRequest: true, ownRequest: null, requests: [] }, disabled: false, requestAccess: () => {}, admit: () => {}, refresh: () => {} }));
  assert.match(html, /Request project access/); assert.match(html, /signed-in identity/);
  assert.doesNotMatch(html, /textarea|type="text"|Copy.*identity/);
});
test('owner admission prominently shows the verified sign-in email but confirms the stable request identity', () => {
  const join = { id: 'request-id', subject: 'https://issuer#opaque-subject', verifiedEmail: 'laurence@example.test', createdAt: 100, state: 'PENDING' as const, role: 'maintainer' as const };
  const view = { schemaVersion: 1 as const, scope, projectName: 'Shared project', projectStatus: 'ACTIVE' as const, revision: '1', canManage: true, canRequest: false, ownRequest: null, requests: [join] };
  const pending = renderToStaticMarkup(createElement(ProjectJoinPanel, { view, disabled: false, requestAccess: () => {}, admit: () => {}, refresh: () => {} }));
  assert.match(pending, /Verified sign-in email/);
  assert.match(pending, /<strong>laurence@example.test<\/strong>/);
  assert.match(pending, /<details>.*Full principal.*opaque-subject/s);
  assert.match(pending, /Review admission/);
  const admitted: string[] = [];
  const review = JoinAdmissionReview({ request: join, disabled: false, confirm: id => admitted.push(id), cancel: () => {} });
  const html = renderToStaticMarkup(review);
  assert.match(html, /Verified sign-in email/); assert.match(html, /laurence@example.test/);
  assert.match(html, /Review permission remains separate/);
  function click(node: ReactNode): void {
    Children.forEach(node, child => {
      if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) return;
      if (child.type === 'button' && child.props.children === 'Confirm maintainer access') child.props.onClick?.();
      else click(child.props.children);
    });
  }
  click(review);
  assert.deepEqual(admitted, ['request-id']);
  const missing = renderToStaticMarkup(createElement(JoinAdmissionReview, { request: { ...join, verifiedEmail: undefined }, disabled: false, confirm: () => {}, cancel: () => {} }));
  assert.match(missing, /Verified sign-in email not reported/);
  assert.match(missing, /opaque-subject/);
  assert.doesNotMatch(missing, /laurence@example.test/);
});
