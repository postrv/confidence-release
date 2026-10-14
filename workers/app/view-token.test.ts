import test from 'node:test';
import assert from 'node:assert/strict';
import { issueViewToken, priorViewCursor } from './view-token';
import { sameViewCursor } from '../shared/view-cursor';

const scope = { principalId: 'verified-subject', tenantId: 'tenant', projectId: 'project', credentialClass: 'human' as const, pi: true, publication: false, maintenance: false };
const cursor = { projectIncarnation: 'incarnation', revision: '42', eventSequence: 57, capsuleRowid: 8 };

test('display cursor is reusable only for the same principal, project and deployed capabilities', () => {
  const token = issueViewToken(scope, cursor);
  assert.deepEqual(priorViewCursor(token, scope), cursor);
  for (const changed of [
    { principalId: 'other-subject' }, { tenantId: 'other-tenant' }, { projectId: 'other-project' },
    { credentialClass: 'agent' as const }, { pi: false }, { publication: true }, { maintenance: true },
  ]) assert.equal(priorViewCursor(token, { ...scope, ...changed }), null);
  for (const bad of ['%', 'x'.repeat(2049), issueViewToken(scope, { ...cursor, eventSequence: -1 })])
    assert.equal(priorViewCursor(bad, scope), null);
  assert.equal(sameViewCursor(cursor, { ...cursor, projectIncarnation: 're-enrolled' }), false);
});

test('selected candidate identity cannot reuse another selection or the unselected display cursor', () => {
  const selectedScope = { ...scope, selectedCandidateId: 'older-candidate' };
  const selectedCursor = { ...cursor, selectedCandidateId: 'older-candidate' };
  const token = issueViewToken(selectedScope, selectedCursor);
  assert.deepEqual(priorViewCursor(token, selectedScope), selectedCursor);
  assert.equal(priorViewCursor(token, scope), null);
  assert.equal(priorViewCursor(token, { ...scope, selectedCandidateId: 'new-candidate' }), null);
  assert.equal(priorViewCursor(issueViewToken(scope, cursor), selectedScope), null);
  assert.equal(priorViewCursor(issueViewToken(selectedScope, cursor), selectedScope), null);
  assert.equal(sameViewCursor(cursor, selectedCursor), false);
  assert.equal(sameViewCursor(selectedCursor, { ...selectedCursor, selectedCandidateId: 'new-candidate' }), false);
});
