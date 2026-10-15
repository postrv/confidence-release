// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { collaborationRuntime } from './collaboration-runtime.ts';
import { sha256, verifyBundle } from '../packages/protocol/src/index.ts';
import { invitationDigestInput, type CollaborationRole } from '../packages/protocol/src/collaboration.ts';

const runtime = await collaborationRuntime(undefined, { hubEnabled: true });
const projectPath = '/api/projects/' + runtime.scope.projectId;
const cases: { name: string; status: number; code?: string }[] = [], checks: string[] = [];
const credentials = new Map<string, string>();
const accessHumans = new Set<string>();
for (const name of ['owner', 'contributor', 'reviewer', 'guest', 'successor', 'maintainer']) credentials.set(name, await runtime.token(name));
const id = (name: string) => runtime.issuer + '#' + name;
async function issuedAtAfter(cutoff: number, clock = {
  now: Date.now, monotonicNow: () => performance.now(),
  sleep: (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
}): Promise<number> {
  assert.ok(Number.isSafeInteger(cutoff) && cutoff >= 0 && Number.isSafeInteger((cutoff + 1) * 1000), 'Observed session cutoff must be a safe integer timestamp');
  const deadline = clock.monotonicNow() + 15_000;
  // A timer can wake before the wall-clock second boundary. Observe iat itself.
  for (;;) {
    const now = clock.now(), issuedAt = Math.floor(now / 1000);
    if (issuedAt > cutoff) return issuedAt;
    const remaining = deadline - clock.monotonicNow();
    assert.ok(remaining > 0, 'Fixture clock did not advance beyond the observed session cutoff');
    await clock.sleep(Math.min(Math.max(1, (cutoff + 1) * 1000 - now), remaining));
  }
}
async function assertIssuanceClockBoundaries() {
  let now = 100_500, elapsed = 0;
  const sleeps: number[] = [];
  const issuedAt = await issuedAtAfter(100, { now: () => now, monotonicNow: () => elapsed, sleep: async milliseconds => {
    sleeps.push(milliseconds); const advanced = sleeps.length === 1 ? milliseconds - 1 : milliseconds;
    now += advanced; elapsed += advanced;
  } });
  assert.equal(issuedAt, 101); assert.deepEqual(sleeps, [500, 1], 'An early wake must recheck the integer-second cutoff');
  let frozenElapsed = 0;
  await assert.rejects(issuedAtAfter(100, { now: () => 100_999, monotonicNow: () => frozenElapsed,
    sleep: async () => { frozenElapsed += 5000; } }), /Fixture clock did not advance/);
  assert.equal(frozenElapsed, 15_000, 'A stalled wall clock must fail within the monotonic deadline');
  assert.equal(await issuedAtAfter(100, { now: () => 101_000, monotonicNow: () => 0,
    sleep: async () => assert.fail('An already fresh issuance time must not sleep') }), 101);
}
async function request(name: string, path: string, expected: number | number[], init: RequestInit = {}, label = path) {
  const headers = new Headers();
  headers.set(accessHumans.has(name) ? 'cf-access-jwt-assertion' : 'authorization', accessHumans.has(name) ? credentials.get(name)! : 'Bearer ' + credentials.get(name));
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  const response = await runtime.fetch(path, { ...init, headers });
  const text = await response.text(); let result: any; try { result = JSON.parse(text); } catch { result = { text }; }
  cases.push({ name: label, status: response.status, ...(result.error ? { code: result.error.code } : {}) });
  assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${label}: expected ${expected}, received ${response.status}: ${text}`);
  if (path.startsWith('/api/collaboration') || path.startsWith(projectPath + '/collaboration')) assert.equal(response.headers.get('cache-control'), 'no-store');
  return result;
}
async function view(name = 'owner') { return request(name, projectPath + '/collaboration', 200); }
async function metadataCommand(name: string, operation: string, body: unknown, expected = 200) {
  const current = await request(name, projectPath, 200);
  return request(name, projectPath + '/' + operation, expected, { method: 'POST', headers: {
    origin: runtime.origin, 'content-type': 'application/json', 'x-platform-csrf': '1',
    'idempotency-key': randomUUID(), 'if-platform-revision': current.revision,
    'if-platform-incarnation': runtime.scope.projectIncarnation,
  }, body: JSON.stringify(body) }, name + ': metadata ' + operation);
}
async function projectCommand(name: string, operation: string, body: unknown, expected = 202, commandId = randomUUID()) {
  const current = await view(name);
  return request(name, `/v1/projects/${runtime.scope.projectId}/${operation}`, expected, { method: 'POST', headers: {
    origin: runtime.origin, 'content-type': 'application/json', 'x-platform-csrf': '1',
    'idempotency-key': commandId, 'if-platform-revision': current.revision,
    'if-platform-principal': id(name), 'if-platform-incarnation': runtime.scope.projectIncarnation,
  }, body: JSON.stringify(body) }, name + ': ' + operation);
}
async function command(name: string, operation: string, body: unknown, expected: number | number[] = 202, options: { revision?: string; commandId?: string; label?: string; incarnation?: string } = {}) {
  const revision = options.revision ?? (['accept-invitation', 'inspect-invitation'].includes(operation) ? '0' : (await view(name)).revision);
  return request(name, projectPath + '/collaboration/' + operation, expected, { method: 'POST', headers: {
    origin: runtime.origin, 'content-type': 'application/json', 'x-platform-csrf': '1',
    'idempotency-key': options.commandId ?? randomUUID(), 'if-platform-revision': revision,
    'if-platform-principal': id(name), 'if-platform-incarnation': options.incarnation ?? runtime.scope.projectIncarnation,
  }, body: JSON.stringify(body) }, options.label ?? name + ': ' + operation);
}
async function invitation(recipient: string, role: CollaborationRole, owner = 'owner', lifetime = 3600) {
  const invitationId = randomUUID(), token = randomBytes(32).toString('base64url');
  await command(owner, 'create-invitation', { invitationId, recipientId: id(recipient), role, tokenDigest: await sha256(invitationDigestInput(runtime.scope, invitationId, token)), expiresAt: Math.floor(Date.now() / 1000) + lifetime });
  return { invitationId, token };
}
async function assertDeniedCommandIsReadOnly(name: string, status: number, code: string) {
  const inspect = async () => await (await runtime.fetch('/_test/inspect')).json() as Record<string, any[]>;
  const before = await inspect();
  const denied = await request(name, `/v1/projects/${runtime.scope.projectId}/create-goal`, status, { method: 'POST', headers: {
    origin: runtime.origin, 'content-type': 'application/json', 'x-platform-csrf': '1',
    'idempotency-key': randomUUID(), 'if-platform-revision': before.project[0].revision,
    'if-platform-principal': id(name), 'if-platform-incarnation': runtime.scope.projectIncarnation,
  }, body: JSON.stringify({ description: 'Owned denied command invariant', contracts: [] }) }, `Rejected ${code} command cannot persist bookkeeping`);
  assert.equal(denied.error.code, code);
  const after = await inspect();
  for (const table of ['project', 'commands', 'events', 'outbox']) assert.deepEqual(after[table], before[table], `${code} must not mutate ${table}`);
}
let failure: string | undefined;
try {
  await assertIssuanceClockBoundaries();
  checks.push('JWT fixture issuance rechecks early timer wakes and bounds a stalled clock before signing above the observed cutoff');
  const disabled = await view(); assert.equal(disabled.enabled, false); assert.equal(disabled.canEnable, true);
  assert.deepEqual((await request('owner', '/api/state', 200)).session.permissions, { review: true, sponsor: true, manage: true, export: true });
  await request('guest', '/api/session', 200, {}, 'Nonmember obtains only own verified identity');
  await request('guest', '/api/collaboration', 404, {}, 'Nonmember cannot enumerate project collaboration');
  assert.deepEqual((await request('guest', '/api/projects', 200)).projects, []);
  await request('guest', projectPath, 404, {}, 'Nonmember cannot read native project metadata');
  await request('owner', '/api/projects/other-owned-project/collaboration', 404, {}, 'Missing selected project does not fall back to default collaboration');
  await command('owner', 'enable-collaboration', {});
  const enabled = await view(); assert.equal(enabled.enabled, true); assert.deepEqual(enabled.members.map((member: any) => [member.subject, member.role]), [[id('owner'), 'owner']]);
  assert.deepEqual((await request('owner', '/api/state', 200)).session.permissions, { review: false, sponsor: true, manage: true, export: true });
  const ownedMetadata = await request('owner', projectPath, 200);
  assert.deepEqual(ownedMetadata.permissions, { manage: true }); assert.equal(ownedMetadata.roles.includes('admin'), false); assert.equal(ownedMetadata.roles.includes('reviewer'), false);
  const renamed = await metadataCommand('owner', 'update', { name: 'Owned collaboration project', description: 'Local signed-identity rehearsal' });
  assert.equal(renamed.name, 'Owned collaboration project');
  assert.equal((await request('owner', '/api/projects', 200)).projects[0].name, renamed.name);
  checks.push('Configured bootstrap owner is established from a verified human JWT, not a submitted role or unverified membership');

  const invite = await invitation('contributor', 'contributor');
  const preview = await command('contributor', 'inspect-invitation', invite, 200);
  assert.equal(preview.invitation.role, 'contributor'); assert.equal(preview.invitation.recipientId, id('contributor')); assert.equal('token' in preview.invitation, false);
  await command('guest', 'inspect-invitation', invite, 404, { label: 'Invitation preview does not disclose role to other identities' });
  await command('guest', 'accept-invitation', invite, 404, { label: 'Only exact named recipient can accept' });
  await command('contributor', 'accept-invitation', invite, 409, { incarnation: 'other-incarnation', label: 'Invitation is bound to exact project incarnation' });
  await request('contributor', '/api/state', 404, {}, 'Invitation alone does not grant project visibility');
  const acceptId = randomUUID();
  const accepted = await command('contributor', 'accept-invitation', invite, 202, { commandId: acceptId });
  assert.deepEqual(await command('contributor', 'accept-invitation', invite, 202, { commandId: acceptId }), accepted);
  await command('contributor', 'accept-invitation', invite, 404, { label: 'Consumed invitation cannot create a second admission' });
  const contributor = await view('contributor'); assert.equal(contributor.canManage, false); assert.deepEqual(contributor.invitations, []);
  assert.deepEqual((await request('contributor', '/api/state', 200, {}, 'Accepted collaborator sees project through production adapter')).session.permissions, { review: false, sponsor: false, manage: false, export: false });
  assert.deepEqual((await request('contributor', projectPath, 200)).permissions, { manage: false });
  assert.equal((await request('contributor', projectPath + '/state', 200)).projectId, runtime.scope.projectId);
  await metadataCommand('contributor', 'update', { name: 'Unprivileged metadata change' }, 403);
  const privateDraft = await request('owner', '/api/projects', 201, { method: 'POST', headers: {
    origin: runtime.origin, 'content-type': 'application/json', 'x-platform-csrf': '1', 'idempotency-key': randomUUID(),
  }, body: JSON.stringify({ name: 'Private owner draft' }) });
  assert.equal(privateDraft.capabilities.nativeWorkflow, false);
  await request('contributor', '/api/projects/' + privateDraft.projectId, 404, {}, 'Native invitation does not grant access to separate private draft');
  const draftCollaboration = await request('owner', '/api/projects/' + privateDraft.projectId + '/collaboration', 200, {}, 'Imported draft has its own collaboration context');
  assert.equal(draftCollaboration.scope.projectId, privateDraft.projectId); assert.equal(draftCollaboration.enabled, false);
  assert.deepEqual((await request('contributor', '/api/projects', 200)).projects.map((project: any) => project.projectId), [runtime.scope.projectId]);
  await command('contributor', 'create-invitation', {}, 403, { label: 'Contributor cannot manage membership' });
  checks.push('Recipient, incarnation, one-use acceptance and exact idempotent replay enforced through production Application and SQLite authority');
  checks.push('Scoped native metadata uses verified owner management without admin/reviewer privilege; project directory and private drafts preserve independent authorization');

  const reviewInvite = await invitation('reviewer', 'reviewer'); await command('reviewer', 'accept-invitation', reviewInvite);
  assert.deepEqual((await request('reviewer', '/api/state', 200)).session.permissions, { review: true, sponsor: false, manage: false, export: false });
  const review = await projectCommand('reviewer', 'prepare-review', { candidateId: runtime.candidateId, evaluationId: 'plan-1' });
  await projectCommand('owner', 'approve-review', { reviewId: review.id, proposalDigest: review.proposalDigest }, 403);
  await projectCommand('contributor', 'approve-review', { reviewId: review.id, proposalDigest: review.proposalDigest }, 403);
  await projectCommand('reviewer', 'approve-review', { reviewId: review.id, proposalDigest: review.proposalDigest });
  assert.equal((await (await runtime.fetch('/_test/inspect')).json() as any).approvals.length, 1);
  checks.push('A separately invited reviewer can approve; ownership and contribution do not imply reviewer authority');
  await command('owner', 'update-collaborator', { subject: id('contributor'), role: 'owner', active: true }, 409, { label: 'Owner cannot promote another human without acceptance' });
  await command('owner', 'update-collaborator', { subject: id('owner'), role: 'viewer', active: true }, 409, { label: 'Final verified human owner cannot demote self' });
  await command('owner', 'update-collaborator', { subject: id('owner'), role: 'owner', active: false }, 409, { label: 'Final verified human owner cannot remove self' });
  const revokedInvite = await invitation('guest', 'viewer');
  await command('owner', 'revoke-invitation', { invitationId: revokedInvite.invitationId });
  await command('guest', 'accept-invitation', revokedInvite, 404, { label: 'Revoked invitation remains unavailable' });
  const expiredInvite = await invitation('guest', 'viewer');
  await command('guest', 'inspect-invitation', expiredInvite, 200, { label: 'Invitation is available before fixture aging' });
  const beforeAging = (await (await runtime.fetch('/_test/inspect')).json() as any).invitations as any[];
  const originalInvite = beforeAging.find(row => row.id === expiredInvite.invitationId)!;
  const expire = (invitationId: string) => runtime.fetch('/_test/expire-invitation', { method: 'POST', body: JSON.stringify({ invitationId }) });
  assert.equal((await runtime.fetch('/_test/expire-invitation')).status, 405, 'Fixture aging requires POST');
  const extraField = await runtime.fetch('/_test/expire-invitation', { method: 'POST', body: JSON.stringify({ invitationId: expiredInvite.invitationId, expiresAt: 0 }) });
  assert.equal(extraField.status, 409); assert.deepEqual(await extraField.json(), { changedRows: 0 }, 'Fixture aging accepts no arbitrary timestamp');
  for (const invitationId of [randomUUID(), revokedInvite.invitationId, reviewInvite.invitationId]) {
    const refused = await expire(invitationId); assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { changedRows: 0 }, 'Missing, revoked and accepted invitations cannot be aged');
  }
  const agedResponse = await expire(expiredInvite.invitationId); assert.equal(agedResponse.status, 200);
  const aged = await agedResponse.json() as { changedRows: number; invitationId: string; createdAt: number; expiresAt: number; observedAt: number };
  assert.equal(aged.changedRows, 1); assert.equal(aged.invitationId, expiredInvite.invitationId);
  assert.ok(aged.createdAt < aged.expiresAt && aged.expiresAt < aged.observedAt);
  assert.equal(aged.expiresAt - aged.createdAt, originalInvite.expires_at - originalInvite.created_at, 'Fixture aging preserves the admitted positive lifetime');
  const afterAging = (await (await runtime.fetch('/_test/inspect')).json() as any).invitations as any[];
  assert.deepEqual(afterAging.filter(row => row.id !== expiredInvite.invitationId), beforeAging.filter(row => row.id !== expiredInvite.invitationId));
  assert.deepEqual(afterAging.find(row => row.id === expiredInvite.invitationId), { ...originalInvite, created_at: aged.createdAt, expires_at: aged.expiresAt }, 'Only the exact invitation history timestamps change');
  await command('guest', 'accept-invitation', expiredInvite, 404, { label: 'Expired invitation cannot be accepted' });
  checks.push('Last-owner guard, recipient consent, explicit revocation and expiration are authoritative');

  // Explicit additional review uses real authenticated commands and approvals.
  // This runtime remains a synthetic-identity protocol test, not a human release.
  const reviewPermission = (subject: string, enabled: boolean) => ({ subject: id(subject), enabled });
  const unusedApprovals = async (subject: string) => {
    const retained = await (await runtime.fetch('/_test/inspect')).json() as { approvals: { reviewer: string; consumed_by: string | null }[] };
    return retained.approvals.filter(item => item.reviewer === id(subject) && item.consumed_by === null);
  };
  const collaborator = async (subject: string) => (await view()).members.find((member: any) => member.subject === id(subject));
  // The authority permits one unused approval per proposal. Remove the earlier
  // reviewer witness through its real permission transition before testing others.
  await command('owner', 'update-collaborator', { subject: id('reviewer'), role: 'maintainer', active: true });
  await command('owner', 'update-collaborator', { subject: id('reviewer'), role: 'reviewer', active: true });
  assert.equal((await collaborator('owner')).additionalReview, undefined);
  await command('contributor', 'set-collaborator-review', reviewPermission('owner', true), 403);
  await command('owner', 'set-collaborator-review', reviewPermission('contributor', true), 409);
  await command('owner', 'set-collaborator-review', reviewPermission('reviewer', true), 409);
  await command('owner', 'set-collaborator-review', reviewPermission('guest', true), 404);
  await command('owner', 'set-collaborator-review', { subject: id('owner'), enabled: 'true' }, 400);
  await command('owner', 'set-collaborator-review', { ...reviewPermission('owner', true), role: 'owner' }, 400);
  const freshAdministrator = credentials.get('owner')!;
  const reviewRevision = (await view()).revision;
  for (const principal_class of ['agent', 'service']) {
    credentials.set('owner', await runtime.token('owner', { principal_class }));
    await command('owner', 'set-collaborator-review', reviewPermission('owner', true), 403, { revision: reviewRevision });
  }
  credentials.set('owner', await runtime.token('owner', { iat: Math.floor(Date.now() / 1000) - 901 }));
  await command('owner', 'set-collaborator-review', reviewPermission('owner', true), 403, { revision: reviewRevision });
  credentials.set('owner', freshAdministrator);
  const reviewCommandId = randomUUID(), enabledReview = await command('owner', 'set-collaborator-review', reviewPermission('owner', true), 202, { revision: reviewRevision, commandId: reviewCommandId });
  assert.deepEqual(await command('owner', 'set-collaborator-review', reviewPermission('owner', true), 202, { revision: reviewRevision, commandId: reviewCommandId }), enabledReview);
  const reused = await command('owner', 'set-collaborator-review', reviewPermission('owner', false), 409, { revision: reviewRevision, commandId: reviewCommandId });
  assert.equal(reused.error.code, 'COMMAND_ID_REUSED');
  assert.equal((await collaborator('owner')).additionalReview, true);
  assert.equal((await request('owner', '/api/state', 200)).session.permissions.review, true);
  await projectCommand('owner', 'approve-review', { reviewId: review.id, proposalDigest: review.proposalDigest });
  assert.equal((await unusedApprovals('owner')).length, 1);
  const disabledReview = await command('owner', 'set-collaborator-review', reviewPermission('owner', false));
  assert.equal(disabledReview.approvalsInvalidated, 1); assert.equal((await unusedApprovals('owner')).length, 0);
  await projectCommand('owner', 'approve-review', { reviewId: review.id, proposalDigest: review.proposalDigest }, 403);
  await command('owner', 'set-collaborator-review', reviewPermission('owner', true));
  assert.equal((await unusedApprovals('owner')).length, 0, 'Restoring review permission must not resurrect approval');
  await command('owner', 'set-collaborator-review', reviewPermission('owner', false));
  assert.equal((await collaborator('owner')).additionalReview, undefined);

  await command('maintainer', 'accept-invitation', await invitation('maintainer', 'maintainer'));
  assert.equal((await collaborator('maintainer')).additionalReview, undefined);
  await command('owner', 'set-collaborator-review', reviewPermission('maintainer', true));
  await projectCommand('maintainer', 'approve-review', { reviewId: review.id, proposalDigest: review.proposalDigest });
  await command('owner', 'update-collaborator', { subject: id('maintainer'), role: 'maintainer', active: true });
  assert.equal((await collaborator('maintainer')).additionalReview, true);
  assert.equal((await unusedApprovals('maintainer')).length, 1);
  const stillReviewer = await command('owner', 'update-collaborator', { subject: id('maintainer'), role: 'reviewer', active: true });
  assert.equal(stillReviewer.approvalsInvalidated, 0); assert.equal((await collaborator('maintainer')).additionalReview, undefined);
  assert.equal((await unusedApprovals('maintainer')).length, 1, 'Effective review permission survived the preset change');
  const lostReview = await command('owner', 'update-collaborator', { subject: id('maintainer'), role: 'maintainer', active: true });
  assert.equal(lostReview.approvalsInvalidated, 1); assert.equal((await unusedApprovals('maintainer')).length, 0);
  assert.equal((await collaborator('maintainer')).additionalReview, undefined);
  await command('owner', 'set-collaborator-review', reviewPermission('maintainer', true));
  await projectCommand('maintainer', 'approve-review', { reviewId: review.id, proposalDigest: review.proposalDigest });
  const removedReviewer = await command('owner', 'update-collaborator', { subject: id('maintainer'), role: 'maintainer', active: false });
  assert.equal(removedReviewer.approvalsInvalidated, 1); assert.equal((await collaborator('maintainer')).additionalReview, undefined);
  await command('owner', 'set-collaborator-review', reviewPermission('maintainer', true), 404);
  await command('maintainer', 'set-collaborator-review', reviewPermission('owner', true), 404, { revision: (await view()).revision });
  await command('maintainer', 'accept-invitation', await invitation('maintainer', 'maintainer'));
  assert.equal((await collaborator('maintainer')).additionalReview, undefined); assert.equal((await unusedApprovals('maintainer')).length, 0);
  const reviewAudit = (await view()).audit.find((event: any) => event.kind === 'set-collaborator-review');
  assert.equal(reviewAudit.actor, id('owner')); assert.ok(reviewAudit.target); assert.equal(typeof reviewAudit.details.after.additionalReview, 'boolean');
  await projectCommand('reviewer', 'approve-review', { reviewId: review.id, proposalDigest: review.proposalDigest });
  checks.push('Recent human owner explicitly grants additional review only to active verified human owners/maintainers; command replay is idempotent, conflicting reuse fails, effective permission loss invalidates unused approvals and restoration never resurrects them');

  const oldView = await view();
  await command('owner', 'update-collaborator', { subject: id('reviewer'), role: 'viewer', active: true });
  assert.equal((await (await runtime.fetch('/_test/inspect')).json() as any).approvals.length, 0);
  await projectCommand('reviewer', 'approve-review', { reviewId: review.id, proposalDigest: review.proposalDigest }, 403);
  await projectCommand('owner', 'request-publication', { reviewId: review.id, proposalDigest: review.proposalDigest }, 409);
  await command('owner', 'update-collaborator', { subject: id('reviewer'), role: 'reviewer', active: true }, 409, { revision: oldView.revision, label: 'Stale membership edit cannot overwrite newer policy' });
  await command('owner', 'update-collaborator', { subject: id('reviewer'), role: 'reviewer', active: true });
  assert.equal((await (await runtime.fetch('/_test/inspect')).json() as any).approvals.length, 0);
  await projectCommand('owner', 'request-publication', { reviewId: review.id, proposalDigest: review.proposalDigest }, 409);
  await projectCommand('reviewer', 'approve-review', { reviewId: review.id, proposalDigest: review.proposalDigest });
  const admitted = await projectCommand('owner', 'request-publication', { reviewId: review.id, proposalDigest: review.proposalDigest });
  assert.equal(admitted.state, 'ADMITTED');
  await command('owner', 'update-collaborator', { subject: id('reviewer'), role: 'viewer', active: true });
  const consumed = (await (await runtime.fetch('/_test/inspect')).json() as any).approvals;
  assert.equal(consumed.length, 1); assert.equal(consumed[0].consumed_by, admitted.id);
  await runtime.fetch('/_test/drain'); await runtime.fetch('/_test/complete-effect');
  await projectCommand('owner', 'reconcile-publication', { publicationId: admitted.id }); await runtime.fetch('/_test/drain');
  const bundle = await request('owner', `/api/receipts/${admitted.id}/export`, 200, {}, 'Owner can export finalized portable receipt');
  const trust = await request('owner', '/api/trust-config', 200);
  const verified = verifyBundle(bundle, trust); assert.equal(verified.valid, true, JSON.stringify(verified));
  await request('reviewer', `/api/receipts/${admitted.id}/export`, 403, {}, 'Viewer cannot export restricted portable bundle');
  await command('owner', 'update-collaborator', { subject: id('reviewer'), role: 'reviewer', active: true });
  checks.push('Revocation before admission invalidates approval, restoration requires a new approval, and revocation after admission preserves historical witness; owner export verifies independently');
  const revokedSession = await command('owner', 'revoke-member-sessions', { subject: id('contributor') });
  await request('contributor', '/api/state', 401, {}, 'Project session cutoff blocks an otherwise valid old JWT');
  await request('contributor', projectPath, 401, {}, 'Native metadata enforces the same session cutoff');
  await request('contributor', '/api/projects', 503, {}, 'Directory fails closed when a project rejects the old session');
  await assertDeniedCommandIsReadOnly('contributor', 401, 'SESSION_REVOKED');
  await command('contributor', 'set-collaborator-review', reviewPermission('owner', true), 401, { revision: (await view()).revision, label: 'Revoked session cannot change additional review rights' });
  await command('contributor', 'accept-invitation', invite, 401, { commandId: acceptId, label: 'Old-session idempotent replay is reauthorized' });
  const cutoff = revokedSession.after.sessionsRevokedBefore, issuedAt = await issuedAtAfter(cutoff);
  assert.ok(issuedAt > cutoff, 'Replacement JWT issuance must be strictly above the observed session cutoff');
  credentials.set('contributor', await runtime.token('contributor', { iat: cutoff }));
  const atCutoff = await request('contributor', '/api/state', 401, {}, 'Provider-issued JWT exactly at the cutoff remains revoked');
  assert.equal(atCutoff.error.code, 'SESSION_REVOKED');
  credentials.set('contributor', await runtime.token('contributor', { iat: issuedAt }));
  await request('contributor', '/api/state', 200, {}, 'New provider-issued JWT above cutoff restores active member session');
  await command('owner', 'update-collaborator', { subject: id('contributor'), role: 'contributor', active: false });
  await request('contributor', '/api/state', 404, {}, 'Deactivated membership removes project visibility immediately');
  await request('contributor', projectPath, 404, {}, 'Deactivated member cannot retain metadata access');
  assert.deepEqual((await request('contributor', '/api/projects', 200)).projects, []);
  await command('owner', 'update-collaborator', { subject: id('contributor'), role: 'contributor', active: true }, 409, { label: 'Reactivation requires new recipient acceptance' });
  checks.push('Revision concurrency, project session cutoff, replay authorization and non-silent reactivation survive the full API path');

  // The runtime's test authority leaves alarms inert, so these commands verify
  // work authorization and durable dispatch intent without executing a runner.
  credentials.set('matrix', await runtime.token('matrix'));
  const matrixInvite = await invitation('matrix', 'contributor');
  await command('matrix', 'accept-invitation', matrixInvite);
  const attemptInput = {
    subject: id('matrix'), maximumBudget: '400000', recipe: 'pi-json-proposal-v1', assignment: 'Owned permission matrix reservation; do not execute.',
    allowedPaths: ['cache.mjs'], pathPrefixes: ['cache.mjs'],
    operations: ['checkpoint-context', 'model-inference', 'read-source', 'start-execution', 'submit-output', 'write-attempt'],
    destinations: ['1'.repeat(32) + '.artifacts.cloudflare.net', 'model.internal'],
  };
  await projectCommand('matrix', 'create-attempt', attemptInput, 403);
  await projectCommand('matrix', 'create-goal', { description: 'Unprivileged goal', contracts: [] }, 403);
  await projectCommand('matrix', 'set-admission-gate', { gate: 'CLOSED' }, 403);
  await projectCommand('reviewer', 'create-attempt', { ...attemptInput, subject: id('reviewer') }, 403);
  const legacyEdit = await projectCommand('owner', 'set-membership', { subject: id('matrix'), roles: ['admin'], active: true }, 409);
  assert.equal(legacyEdit.error.code, 'COLLABORATION_MEMBERSHIP_REQUIRED');
  const grantedAttempt = await projectCommand('owner', 'create-attempt', attemptInput);
  assert.equal(grantedAttempt.state, 'RESERVED');
  const inspectMatrix = async () => (await (await runtime.fetch('/_test/inspect')).json()) as {
    grants: { id: string; subject: string; revoked: number }[];
    outbox: { kind: string; payload: string; state: string }[];
  };
  const grantedRows = await inspectMatrix();
  assert.equal(grantedRows.grants.find(row => row.id === grantedAttempt.grantId)?.revoked, 0);
  const ownStart = await projectCommand('matrix', 'start-execution', { attemptId: grantedAttempt.id });
  assert.equal(ownStart.state, 'EXECUTION_START_RESERVED');
  await projectCommand('reviewer', 'start-execution', { attemptId: grantedAttempt.id }, 403);
  await projectCommand('matrix', 'revoke-grant', { grantId: grantedAttempt.grantId }, 403);
  const matrixDemotion = await command('owner', 'update-collaborator', { subject: id('matrix'), role: 'viewer', active: true });
  assert.equal(matrixDemotion.grantsRevoked, 1);
  const revokedRows = await inspectMatrix();
  assert.equal(revokedRows.grants.find(row => row.id === grantedAttempt.grantId)?.revoked, 1);
  assert.ok(revokedRows.outbox.some(row => row.kind === 'stop-attempt' && row.state === 'PENDING'
    && JSON.parse(row.payload).attemptId === grantedAttempt.id), 'Viewer demotion queues a durable stop for existing work');
  await projectCommand('matrix', 'start-execution', { attemptId: grantedAttempt.id }, 403);
  await projectCommand('matrix', 'create-goal', { description: 'Viewer goal', contracts: [] }, 403);
  await projectCommand('matrix', 'set-admission-gate', { gate: 'CLOSED' }, 403);
  await projectCommand('owner', 'create-attempt', attemptInput, 403);
  await command('owner', 'update-collaborator', { subject: id('matrix'), role: 'contributor', active: true });
  assert.equal((await inspectMatrix()).grants.find(row => row.id === grantedAttempt.grantId)?.revoked, 1);
  await projectCommand('matrix', 'start-execution', { attemptId: grantedAttempt.id }, 403);
  const matrixHumanToken = credentials.get('matrix')!;
  for (const credentialClass of ['agent', 'service']) {
    credentials.set('matrix', await runtime.token('matrix', { principal_class: credentialClass }));
    const changedClass = await request('matrix', '/api/state', 403, {}, `Verified ${credentialClass} class cannot reuse a human collaborator identity`);
    assert.equal(changedClass.error.code, 'IDENTITY_BINDING_CHANGED');
    await assertDeniedCommandIsReadOnly('matrix', 403, 'IDENTITY_BINDING_CHANGED');
  }
  credentials.set('matrix', matrixHumanToken);
  await command('owner', 'update-collaborator', { subject: id('matrix'), role: 'contributor', active: false });
  assert.equal(JSON.stringify(await inspectMatrix()).includes(matrixInvite.token), false);
  checks.push('Role matrix enforces separate sponsoring, administration and subject-bound attempt grants; Viewer demotion revokes grants and durably queues stop; restored roles never reactivate grants; legacy membership editing and machine reuse of verified human identities are denied');

  await command('successor', 'accept-invitation', await invitation('successor', 'maintainer'));
  await command('owner', 'set-collaborator-review', reviewPermission('successor', true));
  const successorInvite = await invitation('successor', 'owner'); await command('successor', 'accept-invitation', successorInvite);
  assert.equal((await collaborator('successor')).additionalReview, undefined, 'New invitation acceptance clears the previous additional capability');
  await command('owner', 'set-collaborator-review', reviewPermission('owner', true));
  const pendingBeforeDemotion = await invitation('guest', 'viewer');
  const revision = (await view()).revision;
  const concurrent = await Promise.all([
    command('owner', 'update-collaborator', { subject: id('owner'), role: 'maintainer', active: true }, [202, 409], { revision }),
    command('successor', 'update-collaborator', { subject: id('successor'), role: 'maintainer', active: true }, [202, 409], { revision }),
  ]);
  assert.equal(concurrent.filter(result => !result.error).length, 1);
  if (concurrent[0].error) {
    const newInvite = await invitation('successor', 'owner'); await command('successor', 'accept-invitation', newInvite);
    await command('owner', 'update-collaborator', { subject: id('owner'), role: 'maintainer', active: true });
  }
  await command('guest', 'accept-invitation', pendingBeforeDemotion, 404, { label: 'Demoted inviter cannot leave live invitations behind' });
  const ownerAfterDemotion = (await view('successor')).members.find((member: any) => member.subject === id('owner'));
  assert.equal(ownerAfterDemotion.role, 'maintainer'); assert.equal(ownerAfterDemotion.additionalReview, true, 'Active owner to maintainer transition preserves explicit review permission');
  assert.equal((await view('successor')).members.filter((member: any) => member.role === 'owner' && member.active).length, 1);
  await command('successor', 'update-collaborator', { subject: id('successor'), role: 'maintainer', active: true }, 409, { label: 'Concurrent demotions retain final owner' });
  checks.push('Accepted two-owner handover and same-revision concurrent demotions preserve at least one verified owner; inviter demotion cancels pending invitations');

  const freshOwner = credentials.get('successor')!;
  credentials.set('successor', await runtime.token('successor', { iat: Math.floor(Date.now() / 1000) - 901 }));
  await command('successor', 'revoke-member-sessions', { subject: id('reviewer') }, 403, { label: 'Sensitive management requires recently issued provider token' });
  credentials.set('successor', freshOwner);
  const beforeRestart = await view('successor'); await runtime.restart();
  assert.deepEqual((await view('successor')).members, beforeRestart.members);
  await request('contributor', '/api/state', 404, {}, 'Restart preserves deactivation');
  await command('guest', 'accept-invitation', pendingBeforeDemotion, 404, { label: 'Restart preserves invitation revocation' });
  const retained = await (await runtime.fetch('/_test/inspect')).text();
  for (const secret of [invite.token, reviewInvite.token, successorInvite.token, revokedInvite.token, expiredInvite.token, pendingBeforeDemotion.token]) assert.equal(retained.includes(secret), false, 'No raw invitation tokens retained in SQL commands, events or invitation table');
  assert.ok(beforeRestart.audit.some((event: any) => event.actor === id('successor')));
  checks.push('Durable state and audit attribution survive fresh workerd restart; raw invitation secrets absent from every SQL table');

  const generic = await request('successor', '/api/projects', 201, { method: 'POST', headers: {
    origin: runtime.origin, 'content-type': 'application/json', 'x-platform-csrf': '1', 'idempotency-key': 'owned-generic-collaboration',
  }, body: JSON.stringify({ name: 'Owned generic collaboration', description: 'No source or evaluator enrollment' }) });
  const genericPath = '/api/projects/' + generic.projectId;
  const genericView = (name = 'successor') => request(name, genericPath + '/collaboration', 200);
  const genericCommand = async (name: string, operation: string, body: unknown, expected = 202, saved?: { id: string; revision: string }) => request(name, genericPath + '/collaboration/' + operation, expected, {
    method: 'POST', headers: { origin: runtime.origin, 'content-type': 'application/json', 'x-platform-csrf': '1',
      'if-platform-principal': id(name), 'if-platform-incarnation': generic.projectIncarnation,
      'if-platform-revision': saved?.revision ?? (operation === 'accept-invitation' || operation === 'inspect-invitation' ? '0' : (await genericView()).revision),
      'idempotency-key': saved?.id ?? randomUUID() }, body: JSON.stringify(body),
  });
  assert.equal((await genericView()).canEnable, true, 'Catalog creator can enable without deployment bootstrap changes');
  await genericCommand('successor', 'enable-collaboration', {});
  const enabledGeneric = await genericView(); assert.equal(enabledGeneric.enabled, true);
  assert.equal(enabledGeneric.members[0].role, 'owner'); assert.equal(enabledGeneric.members[0].additionalReview, undefined);
  const rejectedReviewIdentity = { id: 'owned-generic-rejected-review', revision: enabledGeneric.revision };
  const malformedReview = { subject: id('successor'), enabled: 'true' };
  assert.equal((await genericCommand('successor', 'set-collaborator-review', malformedReview, 400, rejectedReviewIdentity)).error.code, 'SCHEMA_ERROR');
  await runtime.restart();
  assert.equal((await genericCommand('successor', 'set-collaborator-review', { subject: id('successor'), enabled: true }, 409, rejectedReviewIdentity)).error.code, 'COMMAND_ID_REUSED');
  assert.equal((await genericCommand('successor', 'set-collaborator-review', malformedReview, 400, rejectedReviewIdentity)).error.code, 'SCHEMA_ERROR');
  assert.equal((await genericView()).members.find((member: any) => member.subject === id('successor')).additionalReview, undefined);
  checks.push('Generic collaboration terminal rejection retains exact command identity across workerd restart; changed reuse cannot silently grant review permission');
  const genericMetadata = await request('successor', genericPath, 200);
  assert.equal(genericMetadata.capabilities.nativeWorkflow, false); assert.equal(genericMetadata.capabilities.publication, false);
  assert.deepEqual(genericMetadata.source, { status: 'EMPTY' });
  await request('successor', `/v1/projects/${generic.projectId}/state`, 404, {}, 'Generic collaboration creates no native evaluation ProjectRecord');
  const joinPath = genericPath + '/join-requests';
  const signedGuestEmail = 'laurence.owned@example.test';
  credentials.set('guest', await runtime.token('guest', { principal_class: undefined, type: 'app', email: signedGuestEmail }));
  accessHumans.add('guest');
  const joinView = await request('guest', joinPath, 200);
  assert.equal(joinView.projectName, generic.name); assert.equal(joinView.canRequest, true); assert.deepEqual(joinView.requests, []);
  const joinRequest = (name: string, key: string, expected = 202, body: unknown = {}, incarnation = generic.projectIncarnation) => request(name, joinPath, expected, {
    method: 'POST', headers: { origin: runtime.origin, 'content-type': 'application/json', 'x-platform-csrf': '1',
      'if-platform-principal': id(name), 'if-platform-incarnation': incarnation, 'idempotency-key': key }, body: JSON.stringify(body),
  });
  assert.equal((await joinRequest('guest', 'wrong-incarnation', 409, {}, 'different-incarnation')).error.code, 'PROJECT_INCAR_CHANGED');
  assert.equal((await joinRequest('guest', 'injected-subject', 400, { subject: id('successor') })).error.code, 'SCHEMA_ERROR');
  assert.equal((await joinRequest('guest', 'injected-email', 400, { verifiedEmail: 'forged.owned@example.test' })).error.code, 'SCHEMA_ERROR');
  const pendingJoin = await joinRequest('guest', 'owned-link-request');
  assert.equal(pendingJoin.subject, id('guest')); assert.equal(pendingJoin.state, 'PENDING');
  assert.equal(pendingJoin.verifiedEmail, signedGuestEmail, 'Only the server-verified Access claim supplies display email');
  assert.deepEqual(await joinRequest('guest', 'owned-link-request'), pendingJoin);
  assert.equal((await joinRequest('guest', 'second-pending-request', 409)).error.code, 'JOIN_REQUEST_ALREADY_PENDING');
  await request('guest', genericPath, 404, {}, 'Requesting membership grants no project read access');
  const ownerJoins = await request('successor', joinPath, 200); assert.deepEqual(ownerJoins.requests, [pendingJoin]);
  assert.equal((await request('guest', joinPath, 200)).ownRequest.verifiedEmail, signedGuestEmail);
  const otherJoinView = await request('contributor', joinPath, 200);
  assert.deepEqual(otherJoinView.requests, []); assert.equal(otherJoinView.ownRequest, null);
  assert.equal(JSON.stringify(otherJoinView).includes(signedGuestEmail), false, 'Third parties cannot enumerate verified email display context');
  await genericCommand('guest', 'admit-join-request', { requestId: pendingJoin.id }, 404);
  const admissionIdentity = { id: 'owned-link-admission', revision: (await genericView()).revision };
  const admittedJoin = await genericCommand('successor', 'admit-join-request', { requestId: pendingJoin.id }, 202, admissionIdentity);
  assert.equal(admittedJoin.after.role, 'maintainer'); assert.deepEqual(await genericCommand('successor', 'admit-join-request', { requestId: pendingJoin.id }, 202, admissionIdentity), admittedJoin);
  assert.equal((await genericCommand('successor', 'admit-join-request', { requestId: 'changed-request' }, 409, admissionIdentity)).error.code, 'COMMAND_ID_REUSED');
  assert.equal((await request('guest', genericPath, 200)).capabilities.nativeWorkflow, false);
  assert.ok((await request('guest', '/api/projects', 200)).projects.some((project: any) => project.projectId === generic.projectId));
  await genericCommand('successor', 'set-collaborator-review', { subject: id('guest'), enabled: true });
  assert.equal((await genericView()).members.find((member: any) => member.subject === id('guest')).additionalReview, true);
  const hubPath = genericPath + '/hub', agentPath = genericPath + '/agent';
  const hubPost = (name: string, suffix: string, body: unknown, expected = 202, incarnation = generic.projectIncarnation) => request(name, hubPath + suffix, expected, {
    method: 'POST', headers: { origin: runtime.origin, 'content-type': 'application/json', 'x-platform-csrf': '1',
      'if-platform-principal': id(name), 'if-platform-incarnation': incarnation }, body: JSON.stringify(body),
  });
  const message = { requestId: 'owner-instruction', kind: 'instruction', text: 'Inspect the pinned Weft dependency and report here.' };
  assert.deepEqual((await request('guest', hubPath, 200)).capabilities, { post: true, connect: true });
  const posted = await hubPost('successor', '/messages', message);
  assert.deepEqual(posted.actor, { principalId: id('successor'), credentialClass: 'human' });
  assert.deepEqual(await hubPost('successor', '/messages', message), posted, 'Lost human post response reconciles by request identity');
  assert.equal((await hubPost('successor', '/messages', { ...message, text: 'Conflicting replay' }, 409)).error.code, 'HUB_REQUEST_CONFLICT');
  assert.equal((await hubPost('successor', '/messages', message, 409, 'wrong-incarnation')).error.code, 'PROJECT_INCAR_CHANGED');
  const reply = await hubPost('guest', '/messages', { requestId: 'second-human-handoff', kind: 'handoff', text: 'I will connect my local deterministic tool session to this discussion.' });
  assert.deepEqual(reply.actor, { principalId: id('guest'), credentialClass: 'human' });
  const agentToken = randomBytes(32).toString('base64url'), connectionId = 'owned-local-agent';
  const registration = { connectionId, label: 'Deterministic local agent fixture', tokenHash: 'sha256:' + createHash('sha256').update(agentToken).digest('hex'), expiresAt: Math.floor(Date.now() / 1000) + 1800 };
  const connection = await hubPost('guest', '/connections', registration);
  assert.deepEqual(await hubPost('guest', '/connections', registration), connection);
  assert.equal('tokenHash' in connection, false); assert.equal('token' in connection, false);
  const agentRequest = async (suffix: string, expected = 200, body?: unknown, overrides: Record<string, string> = {}) => {
    const response = await runtime.fetch(agentPath + suffix, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      headers: { authorization: 'Bearer ' + agentToken, 'x-confidence-connection': connectionId, 'if-platform-incarnation': generic.projectIncarnation,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...overrides } });
    const result = await response.json() as any;
    cases.push({ name: 'Scoped local agent: ' + suffix, status: response.status, ...(result.error ? { code: result.error.code } : {}) });
    assert.equal(response.status, expected, JSON.stringify(result)); return result;
  };
  assert.deepEqual((await agentRequest('/messages')).messages, [posted, reply]);
  const agentMessage = { requestId: 'local-result', kind: 'result', text: 'Deterministic fixture result; no native model execution claimed.' };
  const agentPosted = await agentRequest('/messages', 202, agentMessage);
  assert.deepEqual(agentPosted.actor, { principalId: id('guest'), credentialClass: 'agent', connectionId, label: registration.label });
  assert.deepEqual(await agentRequest('/messages', 202, agentMessage), agentPosted);
  assert.equal((await agentRequest('/messages', 409, { ...agentMessage, text: 'Conflicting result' })).error.code, 'HUB_REQUEST_CONFLICT');
  await agentRequest('/messages', 401, undefined, { 'if-platform-incarnation': 'different-incarnation' });
  await agentRequest('/publish', 404, {});
  for (const suffix of ['/collaboration', '/join-requests', '/hub', '/state']) {
    const denied = await runtime.fetch(genericPath + suffix, { headers: { authorization: 'Bearer ' + agentToken } });
    assert.equal(denied.status, 401, 'Opaque discussion token cannot enter signed human project routes');
  }
  const dependency = await agentRequest('/dependencies/weft'); assert.equal(dependency.commit, 'b1c5521bf28a0144203c55b3f056885dce3535ff');
  assert.equal((await agentRequest('/dependencies/weft/bundle', 503)).error.code, 'DEPENDENCY_UNAVAILABLE', 'Missing operator-provisioned bundle fails closed');
  if (process.env.WEFT_DEPENDENCY_BUNDLE) {
    const bundle = await readFile(process.env.WEFT_DEPENDENCY_BUNDLE);
    await runtime.putDependency(bundle);
    const received = await runtime.fetch(agentPath + '/dependencies/weft/bundle', { headers: { authorization: 'Bearer ' + agentToken,
      'x-confidence-connection': connectionId, 'if-platform-incarnation': generic.projectIncarnation } });
    assert.equal(received.status, 200); assert.equal(received.headers.get('cache-control'), 'no-store');
    const bytes = new Uint8Array(await received.arrayBuffer());
    assert.equal(bytes.length, dependency.bundle.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), dependency.bundle.sha256);
    assert.deepEqual(bytes, new Uint8Array(bundle));
    checks.push('Exact real b1c5521 Weft Git bundle operator-provisioned into local R2 and acquired byte-for-byte through authenticated scoped agent application/authority route');
  }
  await runtime.restart();
  assert.equal((await request('guest', joinPath, 200)).ownRequest.verifiedEmail, signedGuestEmail);
  assert.deepEqual((await request('successor', hubPath, 200)).messages, [posted, reply, agentPosted]);
  assert.deepEqual((await agentRequest('/messages')).messages, [posted, reply, agentPosted]);
  assert.deepEqual((await agentRequest('/messages?after=' + reply.sequence)).messages, [agentPosted]);
  const temporaryToken = randomBytes(32).toString('base64url'), temporaryId = 'owned-revoked-agent';
  await hubPost('guest', '/connections', { ...registration, connectionId: temporaryId, tokenHash: 'sha256:' + createHash('sha256').update(temporaryToken).digest('hex') });
  await hubPost('successor', '/connections/' + temporaryId + '/revoke', {}, 404);
  const revokedConnection = await hubPost('guest', '/connections/' + temporaryId + '/revoke', {});
  assert.deepEqual(await hubPost('guest', '/connections/' + temporaryId + '/revoke', {}), revokedConnection);
  assert.equal((await agentRequest('/messages', 401, undefined, { authorization: 'Bearer ' + temporaryToken, 'x-confidence-connection': temporaryId })).error.code, 'HUB_AGENT_UNAUTHORIZED');
  const currentOwnerToken = credentials.get('successor')!;
  credentials.set('successor', await runtime.token('successor', { iat: Math.floor(Date.now() / 1000) - 1800 }));
  await hubPost('successor', '/messages', { requestId: 'valid-older-session', kind: 'message', text: 'A valid thirty-minute human session may continue discussion.' });
  assert.equal((await hubPost('successor', '/connections', { ...registration, connectionId: 'older-session-connection' }, 403)).error.code, 'RECENT_SESSION_REQUIRED');
  credentials.set('successor', currentOwnerToken);
  checks.push('Verified signed Access email is retained only for requester/owner join review; body injection and third-party email disclosure are rejected; valid older human sessions may post while connection grants require recent authentication');
  checks.push('Real application and authority retain human and scoped-agent discussion with exact attribution, retry/conflict identity, restart persistence, incarnation fences, narrow credential authority and pinned dependency metadata');
  await genericCommand('successor', 'update-collaborator', { subject: id('guest'), role: 'maintainer', active: false });
  await agentRequest('/messages', 404); await agentRequest('/dependencies/weft', 404);
  assert.equal((await joinRequest('guest', 'owned-link-request')).state, 'REVOKED');
  await genericCommand('successor', 'admit-join-request', { requestId: pendingJoin.id }, 202, admissionIdentity);
  await request('guest', genericPath, 404, {}, 'Duplicate admission cannot restore removed membership');
  const pendingAgain = await joinRequest('guest', 'owned-new-link-request');
  await genericCommand('successor', 'revoke-member-sessions', { subject: id('guest') });
  assert.equal((await genericCommand('successor', 'admit-join-request', { requestId: pendingAgain.id }, 404)).error.code, 'JOIN_REQUEST_UNAVAILABLE');
  await request('guest', joinPath, 401, {}, 'Project session cutoff applies to link join status');
  const invitationId = randomUUID(), genericToken = randomBytes(32).toString('base64url');
  await genericCommand('successor', 'create-invitation', { invitationId, recipientId: id('contributor'), role: 'maintainer',
    tokenDigest: await sha256(invitationDigestInput(enabledGeneric.scope, invitationId, genericToken)), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  await genericCommand('contributor', 'inspect-invitation', { invitationId, token: genericToken }, 200);
  await genericCommand('contributor', 'accept-invitation', { invitationId, token: genericToken });
  assert.equal((await request('contributor', genericPath, 200)).permissions.manage, false);
  await genericCommand('successor', 'update-collaborator', { subject: id('contributor'), role: 'reviewer', active: true });
  await hubPost('contributor', '/messages', { requestId: 'reviewer-question', kind: 'question', text: 'Reviewers may discuss without gaining live edit authority.' });
  await genericCommand('successor', 'update-collaborator', { subject: id('contributor'), role: 'viewer', active: true });
  assert.deepEqual((await request('contributor', hubPath, 200)).capabilities, { post: false, connect: false });
  assert.equal((await hubPost('contributor', '/messages', { requestId: 'viewer-post', kind: 'message', text: 'Denied' }, 403)).error.code, 'PROJECT_EDIT_DENIED');
  assert.equal((await hubPost('contributor', '/connections', { ...registration, connectionId: 'viewer-agent' }, 403)).error.code, 'PROJECT_EDIT_DENIED');
  await genericCommand('successor', 'update-collaborator', { subject: id('contributor'), role: 'maintainer', active: true });
  const cutoffToken = randomBytes(32).toString('base64url'), cutoffConnection = 'owned-cutoff-agent';
  await hubPost('contributor', '/connections', { ...registration, connectionId: cutoffConnection, tokenHash: 'sha256:' + createHash('sha256').update(cutoffToken).digest('hex') });
  await genericCommand('successor', 'revoke-member-sessions', { subject: id('contributor') });
  assert.equal((await agentRequest('/messages', 401, undefined, { authorization: 'Bearer ' + cutoffToken, 'x-confidence-connection': cutoffConnection })).error.code, 'SESSION_REVOKED');
  const contributorCutoff = (await genericView()).members.find((member: any) => member.subject === id('contributor')).sessionsRevokedBefore;
  credentials.set('contributor', await runtime.token('contributor', { iat: await issuedAtAfter(contributorCutoff) }));
  await runtime.restart(); assert.equal((await genericView('contributor')).members.find((member: any) => member.subject === id('contributor')).active, true);
  const archiveGeneric = await request('successor', genericPath, 200);
  await request('successor', genericPath + '/archive', 200, { method: 'POST', headers: {
    origin: runtime.origin, 'content-type': 'application/json', 'x-platform-csrf': '1', 'idempotency-key': 'archive-generic-collaboration',
    'if-platform-incarnation': generic.projectIncarnation, 'if-platform-revision': archiveGeneric.revision }, body: '{}' });
  assert.equal((await request('contributor', joinPath, 200)).canRequest, false);
  assert.equal((await joinRequest('contributor', 'archived-join', 409)).error.code, 'PROJECT_ARCHIVED');
  assert.equal((await genericCommand('successor', 'set-collaborator-review', { subject: id('contributor'), enabled: true }, 409)).error.code, 'PROJECT_ARCHIVED');
  assert.equal((await request('contributor', hubPath, 409)).error.code, 'PROJECT_ARCHIVED');
  checks.push('Generic catalog project supports creator-owned collaboration, targeted invitations, fixed-maintainer link requests, idempotent owner admission, directory discovery, additional review, revocation/session cutoff and archive checks without native source/evaluation enrollment');
} catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); }
finally {
  await runtime.dispose();
  const inputs = ['infra/collaboration-runtime.ts', 'infra/collaboration-runtime-check.ts', 'infra/test-collaboration/worker.ts', 'infra/test-collaboration/wrangler.jsonc', 'infra/test-authority/worker.ts', 'packages/protocol/src/collaboration.ts', 'packages/protocol/src/project-hub.ts', 'packages/protocol/src/dependencies.ts', 'packages/project-model/src/types.ts', 'workers/shared/auth.ts', 'workers/app/index.ts', 'workers/app/hub-routes.ts', 'workers/app/projects.ts', 'workers/app/adapter.ts', 'workers/authority/index.ts', 'workers/authority/collaboration.ts', 'workers/authority/project-hub.ts', 'workers/authority/pinned-dependency.ts', 'workers/authority/schema.ts', 'workers/authority/project-catalog.ts', 'workers/authority/project-directory.ts', 'workers/authority/project-directory-read.ts', 'workers/evaluator/recipes.ts', 'package-lock.json'];
  const sourceDigests: Record<string, string> = {};
  for (const path of inputs) sourceDigests[path] = 'sha256:' + createHash('sha256').update(await readFile(path)).digest('hex');
  const output = resolve(process.env.COLLABORATION_RUNTIME_REPORT || 'demo-output/collaboration-runtime.json'); await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ schemaVersion: 1, passed: !failure, generatedAt: new Date().toISOString(), runtimePlatform: { node: process.version, platform: process.platform, arch: process.arch }, environment: 'Local real workerd, jose verification, production Application and ProjectAuthority, SQLite and R2', qualifications: { pinnedWeftBundle: Boolean(process.env.WEFT_DEPENDENCY_BUNDLE) && !failure }, limitations: ['Synthetic owned JWT issuer, not a live Cloudflare Access human-login rehearsal', 'Repository and evaluation effects are owned fakes', 'Token issuance recency is not proof of user reauthentication', ...(!process.env.WEFT_DEPENDENCY_BUNDLE ? ['Real pinned bundle transport unqualified; set WEFT_DEPENDENCY_BUNDLE for the separate authorized source qualification lane'] : [])], sourceDigests, bundledRuntimeDigests: runtime.bundleDigests, checks, cases, ...(failure ? { failure } : {}) }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: !failure, checks: checks.length, cases: cases.length, report: output }));
}
if (failure) throw new Error(failure);
