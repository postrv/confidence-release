// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { collaborationRuntime } from './collaboration-runtime.ts';
import { sha256, verifyBundle } from '../packages/protocol/src/index.ts';
import { invitationDigestInput } from '../packages/protocol/src/collaboration.ts';

const cases: { name: string; status: number; code?: string }[] = [], checks: string[] = [];
const bundles: Record<string, Record<string, string>> = {};
let failure: string | undefined;

async function scenario(finalizeBeforeMigration: boolean) {
  const label = finalizeBeforeMigration ? 'finalized-history' : 'admitted-history';
  const runtime = await collaborationRuntime(); bundles[label] = runtime.bundleDigests;
  const base = `/api/projects/${runtime.scope.projectId}`, id = (name: string) => runtime.issuer + '#' + name;
  const tokens = new Map<string, string>();
  for (const name of ['owner', 'legacy-admin', 'legacy-reviewer', 'legacy-agent', 'legacy-service', 'legacy-inactive', 'legacy-orphan']) tokens.set(name, await runtime.token(name, { principal_class: name === 'legacy-agent' ? 'agent' : name === 'legacy-service' ? 'service' : 'human' }));
  const inspect = async () => await (await runtime.fetch('/_test/inspect')).json() as Record<string, any[]>;
  async function request(name: string, path: string, expected: number, init: RequestInit = {}, description = path): Promise<any> {
    const response = await runtime.fetch(path, { ...init, headers: { authorization: 'Bearer ' + tokens.get(name), ...init.headers } });
    const text = await response.text(); let value: any; try { value = JSON.parse(text); } catch { value = { text }; }
    cases.push({ name: `${label}: ${description}`, status: response.status, ...(value.error ? { code: value.error.code } : {}) });
    assert.equal(response.status, expected, `${description}: ${text}`); return value;
  }
  const view = (name = 'owner', expected = 200) => request(name, base + '/collaboration', expected);
  async function command(name: string, operation: string, body: unknown, expected = 202, options: { revision?: string; commandId?: string; collaboration?: boolean } = {}) {
    const revision = options.revision ?? (await view(name)).revision;
    return request(name, options.collaboration ? `${base}/collaboration/${operation}` : `/v1/projects/${runtime.scope.projectId}/${operation}`, expected, {
      method: 'POST', headers: { origin: runtime.origin, 'content-type': 'application/json', 'x-platform-csrf': '1', 'idempotency-key': options.commandId ?? randomUUID(), 'if-platform-revision': revision, 'if-platform-principal': id(name), 'if-platform-incarnation': runtime.scope.projectIncarnation }, body: JSON.stringify(body),
    }, `${name} ${operation}`);
  }
  try {
    const ownerEdit = { commandId: randomUUID(), revision: (await view()).revision };
    const adminBody = { subject: id('legacy-admin'), roles: ['admin', 'export', 'reader', 'reviewer', 'sponsor'], active: true };
    await command('owner', 'set-membership', adminBody, 202, ownerEdit);
    const adminEdit = { commandId: randomUUID(), revision: (await view('legacy-admin')).revision };
    const reviewerBody = { subject: id('legacy-reviewer'), roles: ['reader', 'reviewer'], active: true };
    await command('legacy-admin', 'set-membership', reviewerBody, 202, adminEdit);
    for (const subject of ['legacy-agent', 'legacy-service', 'legacy-inactive']) await command('owner', 'set-membership', { subject: id(subject), roles: ['reader'], active: subject !== 'legacy-inactive' });
    const nonBootstrap = await view('legacy-admin'); assert.equal(nonBootstrap.canEnable, false); assert.equal(nonBootstrap.migration, undefined);
    await command('legacy-admin', 'enable-collaboration', {}, 403, { collaboration: true });
    const humanOwnerToken = tokens.get('owner')!;
    tokens.set('owner', await runtime.token('owner', { principal_class: 'agent' }));
    await command('owner', 'enable-collaboration', {}, 403, { collaboration: true, revision: (await inspect()).project[0].revision });
    tokens.set('owner', await runtime.token('owner', { iat: Math.floor(Date.now() / 1000) - 901 }));
    await command('owner', 'enable-collaboration', {}, 403, { collaboration: true, revision: (await inspect()).project[0].revision });
    tokens.set('owner', humanOwnerToken);
    checks.push(`${label}: Only the configured bootstrap principal with a recent verified human token can enable migration; other legacy administrators cannot inspect the preview`);

    const review = await command('legacy-reviewer', 'prepare-review', { candidateId: runtime.candidateId, evaluationId: 'plan-1' });
    await command('legacy-reviewer', 'approve-review', { reviewId: review.id, proposalDigest: review.proposalDigest });
    const publication = await command('owner', 'request-publication', { reviewId: review.id, proposalDigest: review.proposalDigest });
    assert.equal(publication.state, 'ADMITTED');
    if (finalizeBeforeMigration) {
      assert.equal((await runtime.fetch('/_test/drain')).status, 200);
      assert.equal((await runtime.fetch('/_test/complete-effect')).status, 200);
      await command('owner', 'reconcile-publication', { publicationId: publication.id });
      assert.equal((await runtime.fetch('/_test/drain')).status, 200);
    }
    const fixture = await runtime.fetch('/_test/migration-state', { method: 'POST', body: JSON.stringify({ subjects: ['legacy-admin', 'legacy-reviewer', 'legacy-agent', 'legacy-service', 'legacy-inactive', 'legacy-orphan'].map(id), reviewer: id('legacy-reviewer'), owner: id('owner') }) });
    assert.equal(fixture.status, 200);
    await command('owner', 'set-admission-gate', { gate: 'CLOSED' });
    await runtime.restart({ publicationVerified: false });
    const before = await inspect(), beforeProject = JSON.parse(before.project[0].payload), preview = await view();
    assert.equal(beforeProject.gate, 'CLOSED');
    assert.equal(preview.migration.membersToSuspend, 4); assert.equal(preview.migration.memberSample.length, 4);
    assert.equal(preview.migration.sampleTruncated, false); assert.equal(preview.migration.grantsToRevoke, 6);
    assert.equal(preview.migration.approvalsToInvalidate, 2);
    assert.equal(preview.migration.unresolvedPublicationId, finalizeBeforeMigration ? null : publication.id);
    const result = await command('owner', 'enable-collaboration', {}, 202, { collaboration: true });
    assert.equal(result.legacyMembershipsSuspended, preview.migration.membersToSuspend);
    assert.equal(result.grantsRevoked, preview.migration.grantsToRevoke); assert.equal(result.approvalsInvalidated, preview.migration.approvalsToInvalidate);
    const after = await inspect(), afterProject = JSON.parse(after.project[0].payload);
    assert.equal(afterProject.revision, (BigInt(beforeProject.revision) + 1n).toString());
    assert.deepEqual({ ...afterProject, revision: beforeProject.revision }, beforeProject);
    for (const table of ['records', 'evidence', 'publications', 'receipts', 'reservations', 'pins']) assert.deepEqual(after[table], before[table], `${table} historical rows must be byte-preserved`);
    assert.deepEqual(after.approvals, before.approvals.filter(row => row.consumed_by !== null));
    assert.equal(after.approvals.length, 1); assert.equal(after.approvals[0].consumed_by, publication.id);
    assert.deepEqual(after.events.slice(0, before.events.length), before.events);
    assert.deepEqual(after.commands.slice(0, before.commands.length), before.commands);
    assert.deepEqual(after.memberships.filter(row => row.active).map(row => row.subject), [id('owner')]);
    assert.deepEqual(after.collaborators.map(row => [row.subject, row.role, row.owner]), [[id('owner'), 'owner', 1]]);
    assert.deepEqual(after.verified_identities.map(row => [row.id, row.credential_class]), [[id('owner'), 'human']]);
    assert.equal(after.grants.length, 6); assert.ok(after.grants.every(row => row.revoked === 1));
    const stops = after.outbox.filter(row => row.kind === 'stop-attempt' && row.state === 'PENDING').map(row => JSON.parse(row.payload).attemptId).sort();
    assert.deepEqual(stops, after.grants.map(row => row.attempt_id).sort());
    checks.push(`${label}: Preview counts match atomic migration with admission CLOSED and publication/PI bindings disabled; legacy human and machine memberships suspend, grants revoke and durable stop intents queue`);
    checks.push(`${label}: Project scope/head/budgets/gate/publication lineage, candidate/evidence/source records, receipts, consumed approval witness, reservations and prior audit/idempotency history remain byte-preserved`);

    for (const name of ['legacy-admin', 'legacy-reviewer', 'legacy-agent', 'legacy-service']) await request(name, base + '/state', 404, {}, `${name} cannot read migrated native project`);
    await command('owner', 'set-membership', adminBody, 409, ownerEdit);
    await command('legacy-admin', 'set-membership', reviewerBody, 404, adminEdit);
    await command('owner', 'set-membership', adminBody, 409);
    await command('owner', 'set-membership', adminBody, 409, { revision: beforeProject.revision });
    const machineGrant = await command('owner', 'create-attempt', { subject: id('legacy-agent'), maximumBudget: '400000', recipe: 'pi-json-proposal-v1', assignment: 'Owned migration authorization check, do not execute.', allowedPaths: ['cache.mjs'], pathPrefixes: ['cache.mjs'], operations: ['start-execution'], destinations: ['1'.repeat(32) + '.artifacts.cloudflare.net'] }, 400);
    assert.equal(machineGrant.error.code, 'SUBJECT_UNAVAILABLE');
    await command('owner', 'approve-review', { reviewId: review.id, proposalDigest: review.proposalDigest }, 403);
    const enabled = await view(); assert.equal(enabled.migration, undefined); assert.equal(enabled.canManage, true);
    assert.deepEqual(enabled.members.map((row: any) => [row.subject, row.role]), [[id('owner'), 'owner']]);
    checks.push(`${label}: Cached/stale legacy membership administration cannot restore access, no legacy machine becomes verified, and verified ownership does not confer reviewer power`);
    for (const name of ['legacy-inactive', 'legacy-orphan']) {
      const invitationId = randomUUID(), token = randomBytes(32).toString('base64url');
      await command('owner', 'create-invitation', { invitationId, recipientId: id(name), role: 'contributor', tokenDigest: await sha256(invitationDigestInput(runtime.scope, invitationId, token)), expiresAt: Math.floor(Date.now() / 1000) + 600 }, 202, { collaboration: true });
      await command(name, 'accept-invitation', { invitationId, token }, 202, { collaboration: true, revision: '0' });
      const grant = (await inspect()).grants.find(row => row.subject === id(name))!;
      assert.equal(grant.revoked, 1);
      const denied = await command(name, 'start-execution', { attemptId: grant.attempt_id }, 403);
      assert.equal(denied.error.code, 'GRANT_REVOKED');
      assert.equal((await inspect()).outbox.some(row => row.kind === 'start-attempt' && JSON.parse(row.payload).attemptId === grant.attempt_id), false);
    }
    checks.push(`${label}: Inactive and orphan legacy grant rows remain revoked after their human subjects freshly accept contributor invitations; no old-grant execution intent is queued`);
    if (finalizeBeforeMigration) {
      const bundle = await request('owner', `${base}/receipts/${publication.id}/export`, 200);
      const trust = await request('owner', base + '/trust-config', 200);
      const verified = verifyBundle(bundle, trust); assert.equal(verified.valid, true, JSON.stringify(verified));
      checks.push('Finalized legacy publication still exports and independently verifies after migration with publication disabled');
    } else {
      const current = (await inspect()).publications.find(row => row.id === publication.id)!;
      assert.equal(current.phase, 'ADMITTED'); assert.equal(current.unresolved, 1);
      assert.deepEqual(JSON.parse(current.payload).witness, JSON.parse(before.publications.find(row => row.id === publication.id)!.payload).witness);
      checks.push('Previously admitted unresolved publication remains unresolved with its exact witness; migration does not cancel or rewrite pre-existing admitted work');
    }
    const retainedCollaborators = (await inspect()).collaborators;
    await runtime.restart();
    const restarted = await inspect(); assert.deepEqual(restarted.collaborators, retainedCollaborators); assert.deepEqual(restarted.grants, after.grants);
    await request('legacy-admin', base + '/state', 404, {}, 'Restart preserves legacy suspension');
    assert.equal((await view()).enabled, true);
    checks.push(`${label}: Restart preserves verified owner, suspended legacy members and revoked grants`);
  } finally { await runtime.dispose(); }
}

try { await scenario(true); await scenario(false); }
catch (error) { failure = error instanceof Error ? error.message : String(error); }
const inputs = ['infra/collaboration-migration-check.ts', 'infra/collaboration-runtime.ts', 'infra/test-collaboration/worker.ts', 'infra/test-collaboration/wrangler.jsonc', 'infra/test-authority/worker.ts', 'workers/app/index.ts', 'workers/app/projects.ts', 'workers/app/adapter.ts', 'workers/shared/auth.ts', 'workers/authority/index.ts', 'workers/authority/collaboration.ts', 'workers/authority/schema.ts', 'workers/authority/project-catalog.ts', 'workers/authority/project-directory.ts', 'workers/authority/project-directory-read.ts', 'workers/evaluator/recipes.ts', 'packages/protocol/src/collaboration.ts', 'packages/project-model/src/types.ts', 'package-lock.json'];
const sourceDigests: Record<string, string> = {};
for (const path of inputs) sourceDigests[path] = 'sha256:' + createHash('sha256').update(await readFile(path)).digest('hex');
const output = resolve(process.env.COLLABORATION_MIGRATION_REPORT || 'demo-output/collaboration-migration-v1.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ schemaVersion: 1, passed: !failure, generatedAt: new Date().toISOString(), environment: 'Local workerd, verified synthetic JWTs, production app/authority, SQLite and R2', limitations: ['Not a live pilot migration or Cloudflare Access login rehearsal', 'Repository/evaluator effects are owned fakes; grant and settled-budget history are explicit test-only fixture rows', 'Migration queues stops but this test does not demonstrate physical cancellation of a running remote container', 'Existing admitted work retains its historical authority; resolve outstanding publication before an operational migration', 'Recent provider token issuance is not proof of user reauthentication', 'Imported drafts retain their existing separate membership policy'], sourceDigests, bundledRuntimeDigests: bundles, checks, cases, ...(failure ? { failure } : {}) }, null, 2) + '\n');
console.log(JSON.stringify({ passed: !failure, checks: checks.length, cases: cases.length, report: output }));
if (failure) throw Error(failure);
