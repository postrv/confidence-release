/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CollaborationView } from '../../../packages/protocol/src/collaboration';
import { invitationDigestInput } from '../../../packages/protocol/src/collaboration';
import { CollaborationMembers, CollaborationMigration, ReviewPermissionEditor, compactPrincipal, migrationReviewKey } from './Collaboration';
import { CollaborationCommands, collaborationCommandPath, collaborationScope, createInvitationSecret, freezeCollaborationCommand, type CollaborationCommand, type CollaborationContext } from './collaboration-commands';
import { ApiError } from './api';
import { invitationLink, matchingInvitationInspection, takeInvitationFromLocation, type InvitationInspection } from './invitation-secret';
import { routeForView, viewFromHash } from './navigation';

const token = `${'r'.repeat(42)}A`;
const scope = { schemaVersion: 1 as const, tenantId: 'tenant', projectId: 'project', projectIncarnation: 'incarnation' };
const secret = { scope, invitationId: 'invite_a', token };
const context: CollaborationContext = { scope, revision: '4', session: { principalId: 'https://issuer.example#owner', tenantId: 'tenant', credentialClass: 'human' } };

test('invitation delivery material is removed from history before intake returns', () => {
  const location = { pathname: '/', search: '', hash: new URL(invitationLink('https://confidence.example', secret)).hash };
  let replaced = false;
  const result = takeInvitationFromLocation(location, { replaceState(data, unused, url) {
    assert.equal(data, null);
    assert.equal(url, '/#/accept');
    replaced = true;
  } });
  assert.equal(replaced, true);
  assert.deepEqual(result, { secret });
});

test('invalid and duplicate secret fields are stripped and never retained', () => {
  const goodHash = new URL(invitationLink('https://confidence.example', secret)).hash;
  for (const hash of [
    `${goodHash}&token=${token}`,
    `${goodHash}&role=admin`,
    goodHash.replace(token, 'short'),
    goodHash.replace('invite_a', '../other'),
    goodHash.replace(token, 'a'.repeat(2048)),
    goodHash.replace(token, 'r'.repeat(43)),
    goodHash.replace('schemaVersion=1', 'schemaVersion=2'),
    `#/accept?invitationId=invite_a&token=${token}`,
  ]) {
    let cleaned = '';
    const result = takeInvitationFromLocation({ pathname: '/', search: '', hash }, { replaceState(data, unused, url) { cleaned = String(url); } });
    assert.equal(cleaned, '/#/accept');
    assert.ok(result?.error);
    assert.equal(result.secret, undefined);
  }
});

test('invitation links keep secrets in the fragment and clean routes stay stable', () => {
  const link = new URL(invitationLink('https://confidence.example', secret));
  assert.equal(link.search, '');
  assert.equal(link.pathname, '/');
  assert.match(link.hash, /token=/);
  assert.equal(viewFromHash('#/accept'), 'accept');
  assert.equal(viewFromHash('#/collaboration'), 'collaboration');
  assert.equal(routeForView('collaboration'), '#/collaboration');
  assert.equal(takeInvitationFromLocation({ pathname: '/', search: '', hash: '#/collaboration' }, { replaceState() { assert.fail('must not modify ordinary routes'); } }), undefined);
});

test('invitation generation uses 256 random bits and the shared scoped digest domain', async () => {
  const one = await createInvitationSecret(scope);
  const two = await createInvitationSecret(scope);
  assert.match(one.secret.token, /^[a-zA-Z0-9_-]{42}[AEIMQUYcgkosw048]$/);
  assert.notEqual(one.secret.token, two.secret.token);
  assert.notEqual(one.secret.invitationId, two.secret.invitationId);
  const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(invitationDigestInput(scope, one.secret.invitationId, one.secret.token)))).toString('hex');
  assert.equal(one.tokenDigest, `sha256:${expected}`);
  assert.equal(Buffer.from(one.secret.token, 'base64url').length, 32);
});

test('collaboration commands always retain the exact invitation project independently of the directory default', () => {
  const current = structuredClone(context);
  const command = freezeCollaborationCommand({ ...current, revision: '0' }, 'accept-invitation', { invitationId: secret.invitationId, token });
  current.scope.projectId = 'directory-default';
  assert.equal(collaborationCommandPath(command), '/api/projects/project/collaboration/accept-invitation');
  assert.equal(command.headers['If-Platform-Incarnation'], scope.projectIncarnation);
  assert.equal(command.headers['If-Platform-Revision'], '0');
  assert.equal(command.headers['If-Platform-Principal'], context.session.principalId);
  assert.throws(() => collaborationCommandPath({ ...command, context: { ...context, scope: { ...scope, projectId: '../default' } } }));
});

test('uncertain collaboration commands retain the same secret and exact command, with no storage dependency', async () => {
  const sent: CollaborationCommand[] = [];
  const commands = new CollaborationCommands(async command => { sent.push(structuredClone(command)); if (sent.length === 1) throw new ApiError('timeout'); return {}; });
  assert.equal(await commands.begin(context, 'accept-invitation', { invitationId: secret.invitationId, token }), false);
  assert.equal(commands.getSnapshot().pending?.status, 'UNKNOWN');
  const frozen = commands.getSnapshot().pending!;
  assert.equal(await commands.retry({ ...context, revision: '99' }), true);
  assert.equal(sent[1]?.id, frozen.id);
  assert.equal(sent[1]?.body, frozen.body);
  assert.deepEqual(sent[1]?.headers, frozen.headers);
  assert.equal(commands.getSnapshot().pending, undefined);
  assert.equal(commands.getSnapshot().delivery, undefined);
});

test('retry refuses changed human or project scope and later access denial cannot erase uncertainty', async () => {
  let count = 0;
  const commands = new CollaborationCommands(async () => { count++; throw count === 1 ? new ApiError('timeout') : new ApiError('access denied', 403, 'MEMBERSHIP_REQUIRED'); });
  await commands.begin(context, 'create-invitation', { tokenDigest: 'sha256:public-digest' }, secret);
  await assert.rejects(commands.retry({ ...context, session: { ...context.session, principalId: 'https://issuer.example#other' } }), /original signed-in identity/);
  await assert.rejects(commands.retry({ ...context, scope: { ...scope, projectIncarnation: 'another' } }), /original signed-in identity/);
  assert.equal(count, 1);
  await commands.retry(context);
  assert.equal(commands.getSnapshot().pending?.status, 'UNKNOWN');
  commands.dismissRejection();
  assert.equal(commands.getSnapshot().pending?.status, 'UNKNOWN');
});

test('delivery appears only after confirmation and remains bound to the issuing identity', async () => {
  const commands = new CollaborationCommands(async () => ({}));
  await commands.begin(context, 'create-invitation', { invitationId: secret.invitationId, tokenDigest: 'sha256:public-digest' }, secret);
  assert.deepEqual(commands.getSnapshot().delivery, secret);
  assert.equal(collaborationScope(commands.getSnapshot().deliveryContext!), collaborationScope(context));
  commands.clearDelivery();
  assert.equal(commands.getSnapshot().delivery, undefined);
  assert.equal(commands.getSnapshot().deliveryContext, undefined);
});

test('member controls use server capabilities and escape identity metadata', () => {
  const view: CollaborationView = { ...context, enabled: true, canManage: false, canEnable: false,
    members: [{ subject: 'https://issuer.example#<script>alert(1)</script>', role: 'reviewer', active: true, verifiedAt: 1, sessionsRevokedBefore: 0 }],
    invitations: [], audit: [], limits: { members: 100, pendingInvitations: 100, audit: 100 } };
  const html = renderToStaticMarkup(createElement(CollaborationMembers, { view, disabled: false, edit() {}, reinvite() {} }));
  assert.doesNotMatch(html, /Change role for|Remove https|Revoke sessions for|<script>/);
  assert.match(html, /Copy Verified principal/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Reviewer/);
  const owner = renderToStaticMarkup(createElement(CollaborationMembers, { view: { ...view, canManage: true }, disabled: true, edit() {}, reinvite() {} }));
  const buttons = [...owner.matchAll(/<button\b[^>]*>/g)].filter(button => /Change role for|Remove https|Revoke sessions for/.test(button[0]));
  assert.equal(buttons.length, 3);
  for (const button of buttons) assert.match(button[0], /disabled=""/);
  const revoked = renderToStaticMarkup(createElement(CollaborationMembers, { view: { ...view, canManage: true, members: [{ ...view.members[0]!, active: false }] }, disabled: false, edit() {}, reinvite() {} }));
  assert.match(revoked, /Reinvite/);
  assert.doesNotMatch(revoked, /Change role for|Restore member access/);
});

test('additional review is explicit and only active owners and maintainers have its management control', () => {
  const view: CollaborationView = { ...context, enabled: true, canManage: true, canEnable: false,
    members: ['owner', 'maintainer', 'reviewer', 'contributor', 'viewer'].map(role => ({ subject: `https://issuer.example#${role}`, role: role as CollaborationView['members'][number]['role'], active: true, verifiedAt: 1, sessionsRevokedBefore: 0 })),
    invitations: [], audit: [], limits: { members: 100, pendingInvitations: 100, audit: 100 } };
  const render = (current: CollaborationView, disabled = false) => renderToStaticMarkup(createElement(CollaborationMembers, { view: current, disabled, edit() {}, reinvite() {} }));
  const initial = render(view);
  assert.equal([...initial.matchAll(/Review permission not granted/g)].length, 2);
  assert.match(initial, /Grant review permission to https:\/\/issuer.example#owner/);
  assert.match(initial, /Grant review permission to https:\/\/issuer.example#maintainer/);
  assert.doesNotMatch(initial, /Grant review permission to https:\/\/issuer.example#(?:reviewer|contributor|viewer)/);
  const granted = { ...view, members: view.members.map(member => member.role === 'owner' ? { ...member, additionalReview: true } : member) };
  assert.match(render(granted), /Owner<\/strong>/);
  assert.match(render(granted), /Additional review permission granted/);
  assert.match(render(granted), /Revoke review permission from https:\/\/issuer.example#owner/);
  assert.doesNotMatch(render({ ...granted, canManage: false }), /aria-label="(?:Grant|Revoke) review permission/);
  assert.doesNotMatch(render({ ...granted, members: granted.members.map(member => ({ ...member, active: false })) }), /aria-label="(?:Grant|Revoke) review permission|Additional review permission granted/);
  const buttons = [...render(granted, true).matchAll(/<button\b[^>]*>/g)].filter(button => /aria-label="(?:Grant|Revoke) review permission/.test(button[0]));
  assert.equal(buttons.length, 2);
  for (const button of buttons) assert.match(button[0], /disabled=""/);
});

test('review confirmation sends only the explicit permission change and preserves the authoring role', () => {
  function confirm(node: ReactNode): (() => void) | undefined {
    for (const child of Children.toArray(node)) {
      if (!isValidElement<{ children?: ReactNode; className?: string; onClick?: () => void }>(child)) continue;
      if (child.type === 'button' && child.props.className === 'button primary') return child.props.onClick;
      const nested = confirm(child.props.children);
      if (nested) return nested;
    }
  }
  for (const role of ['owner', 'maintainer'] as const) for (const additionalReview of [false, true]) {
    const member = { subject: `https://issuer.example#${role}`, role, active: true, verifiedAt: 1, sessionsRevokedBefore: 0, additionalReview };
    let command: CollaborationCommand | undefined;
    const editor = ReviewPermissionEditor({ member, disabled: false, close() {}, submit(body) {
      command = freezeCollaborationCommand(context, 'set-collaborator-review', body, '6e747390-45a8-4ac6-b959-6bdc5fa94279');
    } });
    const html = renderToStaticMarkup(editor);
    assert.match(html, /Verified human approval/);
    assert.match(html, new RegExp(`${role === 'owner' ? 'Owner' : 'Maintainer'} role and authoring permissions stay unchanged`));
    assert.doesNotMatch(html, /<select|Change member role|At least one active/);
    assert.ok(confirm(editor));
    confirm(editor)!();
    assert.equal(command?.operation, 'set-collaborator-review');
    assert.equal(collaborationCommandPath(command!), '/api/projects/project/collaboration/set-collaborator-review');
    assert.deepEqual(JSON.parse(command!.body), { subject: member.subject, enabled: !additionalReview });
    assert.equal(command?.headers['If-Platform-Revision'], context.revision);
    assert.equal(member.role, role);
  }
});

test('compact identity labels retain exact full identities for copying and never infer names or email addresses', () => {
  const subject = 'https://identity.owned.test#12345678-1234-1234-1234-123456789012';
  assert.equal(compactPrincipal(subject), 'identity.owned.test#12345678...56789012');
  assert.equal(compactPrincipal('https://identity.owned.test#reviewer'), 'identity.owned.test#reviewer');
  const view: CollaborationView = { ...context, enabled: true, canManage: false, canEnable: false,
    members: [{ subject, role: 'viewer', active: true, verifiedAt: 1, sessionsRevokedBefore: 0 }], invitations: [], audit: [], limits: { members: 100, pendingInvitations: 100, audit: 100 } };
  const html = renderToStaticMarkup(createElement(CollaborationMembers, { view, disabled: false, edit() {}, reinvite() {} }));
  assert.match(html, /identity.owned.test#12345678\.\.\.56789012/);
  assert.match(html, new RegExp(`Copy Verified principal: ${subject}`));
  assert.match(html, /Full identity/);
  assert.match(html, /Project member/);
  assert.doesNotMatch(html, /Verified person|Change role for|Invite|@/);
});

test('acceptance requires a current server-inspected invitation for this exact session and scope', () => {
  const inspection: InvitationInspection = { scope, invitation: { id: secret.invitationId, recipientId: context.session.principalId, role: 'owner', inviter: 'another-owner', createdAt: 1, expiresAt: 2000, state: 'PENDING' } };
  assert.equal(matchingInvitationInspection(secret, context.session, inspection, 1000), true);
  assert.equal(matchingInvitationInspection(secret, context.session, inspection, 2000), false);
  assert.equal(matchingInvitationInspection(secret, context.session, { ...inspection, scope: { ...scope, projectId: 'other' } }, 1000), false);
  assert.equal(matchingInvitationInspection(secret, context.session, { ...inspection, invitation: { ...inspection.invitation, recipientId: 'someone-else' } }, 1000), false);
  assert.equal(matchingInvitationInspection(secret, context.session, { ...inspection, invitation: { ...inspection.invitation, state: 'REVOKED' } }, 1000), false);
  assert.equal(matchingInvitationInspection(secret, context.session, { ...inspection, invitation: { ...inspection.invitation, id: 'other' } }, 1000), false);
});

test('migration acknowledgement is bound to the authoritative preview and unresolved work blocks enablement', () => {
  const view: CollaborationView = { ...context, enabled: false, canManage: false, canEnable: true, members: [], invitations: [], audit: [], limits: { members: 100, pendingInvitations: 100, audit: 100 },
    migration: { membersToSuspend: 3, memberSample: [{ subject: 'https://issuer.example#legacy-user', roles: ['reader', 'reviewer'] }], sampleTruncated: true, grantsToRevoke: 4, approvalsToInvalidate: 2, unresolvedPublicationId: null } };
  const render = (current: CollaborationView, acknowledged: boolean) => renderToStaticMarkup(createElement(CollaborationMigration, { view: current, disabled: false, acknowledged, acknowledge() {}, enable() {} }));
  const button = (html: string) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(match => match[0].includes('Enable verified ownership'))?.[0] ?? '';
  const unchecked = render(view, false);
  assert.match(button(unchecked), /disabled=""/);
  assert.match(unchecked, /Members to suspend<\/dt><dd>3/);
  assert.match(unchecked, /Attempt grants to revoke<\/dt><dd>4/);
  assert.match(unchecked, /Approvals to invalidate<\/dt><dd>2/);
  assert.match(unchecked, /<details class="migration-members"><summary>Affected identities \(3\)/);
  assert.match(unchecked, /Showing 1 of 3 affected identities/);
  assert.match(unchecked, /reader, reviewer/);
  assert.doesNotMatch(button(render(view, true)), /disabled=""/);

  const unresolved = { ...view, migration: { ...view.migration!, unresolvedPublicationId: 'admitted-publication' } };
  assert.match(button(render(unresolved, true)), /disabled=""/);
  assert.match(render(unresolved, true), /Enabling ownership cannot cancel this operation/);
  assert.match(button(render({ ...view, migration: undefined }, true)), /disabled=""/);
  assert.notEqual(migrationReviewKey(view), migrationReviewKey({ ...view, revision: '5' }));
  assert.notEqual(migrationReviewKey(view), migrationReviewKey({ ...view, migration: { ...view.migration!, grantsToRevoke: 5 } }));
  assert.notEqual(migrationReviewKey(view), migrationReviewKey({ ...view, session: { ...view.session, principalId: 'another-human' } }));
  const zero = { ...view, migration: { ...view.migration!, membersToSuspend: 0, memberSample: [], sampleTruncated: false, grantsToRevoke: 0, approvalsToInvalidate: 0 } };
  assert.match(button(render(zero, false)), /disabled=""/);
  assert.doesNotMatch(button(render(zero, true)), /disabled=""/);
  assert.doesNotMatch(render({ ...view, canEnable: false }, true), /type="checkbox"|Enable verified ownership<\/button>|Affected identities/);
});
