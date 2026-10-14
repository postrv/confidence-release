// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { runWeftJourney } from '../weft-runtime-check.ts';

test('an exact collaboration revision survives live edits and travels through real source admission, review, conditional Git publication and receipt verification', { timeout: 180_000 }, async () => {
  const result = await runWeftJourney();
  assert.equal(result.verification.valid, true);
  assert.equal(result.publication.logicalPublications, 1);
  assert.equal(result.publication.gitReceivePackRequests, 1);
  assert.equal(result.selection.frozenUnaffectedByLaterEdits, true);
  assert.equal(result.sessions.sharedPhysicalWorktree, true);
  assert.equal(result.environment.humanApproval, 'synthetic-test-human');
  assert.equal(result.recovery.backpressureRetried, true);
  assert.equal(result.recovery.frozenResumedWithoutAcquisition, true);
  assert.equal(result.archivedProject.readableWithEditsDenied, true);
  assert.equal(result.environment.accessIngress, 'simulated-header-forwarding-with-real-JWT-verification');
  assert.equal(result.credentialAuthority.replicaAccess, 'exact scoped Weft proxy only');
  assert.notEqual(result.credentialAuthority.replicaAudience, result.credentialAuthority.applicationAudience);
  assert.equal(result.credentialAuthority.applicationCredentialOnProxyDenied, true);
  assert.equal(result.credentialAuthority.mixedAudienceDenied, true);
  assert.equal(result.credentialAuthority.replicaCredentialOnOtherAPIDenied, true);
  assert.deepEqual(result.credentialAuthority.deniedOperations, ['set-membership', 'submit-weft-revision', 'approve-review', 'request-publication']);
});
