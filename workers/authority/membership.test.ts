// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformError } from '../shared/errors';
import { invalidateMembershipApprovals, membershipAllows, membershipChange, requireRemainingAdmin, type MembershipState } from './membership';

const member = (roles: MembershipState['roles'], active = true): MembershipState => ({ roles, active });
const invalid = (value: Record<string, unknown>, code: string) => assert.throws(() => membershipChange(value),
  error => error instanceof PlatformError && error.code === code);

test('membership input preserves stable subjects and rejects ambiguous or unsupported changes', () => {
  const value = { subject: 'https://identity.example/#verified-subject', roles: ['reader', 'reviewer'], active: true };
  assert.deepEqual(membershipChange(value), value);
  assert.deepEqual(membershipChange({ subject: 'owned-agent', roles: [], active: true }), { subject: 'owned-agent', roles: [], active: true });
  for (const subject of ['', ' leading', 'trailing ', 'control\u0000subject', 'control\u0085subject', 'x'.repeat(161), null, 1]) {
    invalid({ ...value, subject }, 'MEMBERSHIP_SUBJECT_INVALID');
  }
  invalid({ ...value, displayName: 'unrecognized' }, 'SCHEMA_ERROR');
  invalid({ subject: value.subject, roles: value.roles }, 'SCHEMA_ERROR');
  invalid({ ...value, active: 1 }, 'SCHEMA_ERROR');
  invalid({ ...value, roles: ['owner'] }, 'UNSUPPORTED_ROLE');
  invalid({ ...value, roles: [null] }, 'UNSUPPORTED_ROLE');
  invalid({ ...value, roles: Array(1) }, 'UNSUPPORTED_ROLE');
  invalid({ ...value, roles: ['reviewer', 'reader'] }, 'UNSORTED_SCOPE_SET');
  invalid({ ...value, roles: ['reader', 'reader'] }, 'UNSORTED_SCOPE_SET');
});

test('the last active administrator cannot lose access or the administrator role', () => {
  for (const after of [member(['admin'], false), member(['reader']), member([])]) {
    assert.throws(() => requireRemainingAdmin(member(['admin']), after, 1),
      error => error instanceof PlatformError && error.code === 'LAST_ADMIN_REQUIRED' && error.status === 409);
    assert.doesNotThrow(() => requireRemainingAdmin(member(['admin']), after, 2));
  }
  assert.doesNotThrow(() => requireRemainingAdmin(member(['admin']), member(['admin']), 1));
  assert.doesNotThrow(() => requireRemainingAdmin(null, member(['reader']), 1));
  assert.doesNotThrow(() => requireRemainingAdmin(member(['admin'], false), member([]), 1));
});

test('review authority transitions invalidate approval but independent role edits do not', () => {
  assert.equal(membershipAllows(member(['admin']), 'reviewer'), true);
  assert.equal(membershipAllows(member(['reviewer'], false), 'reviewer'), false);
  assert.equal(invalidateMembershipApprovals(member(['reviewer']), member(['reader'])), true);
  assert.equal(invalidateMembershipApprovals(member(['admin']), member(['sponsor'])), true);
  assert.equal(invalidateMembershipApprovals(member(['reviewer']), member(['reviewer'], false)), true);
  assert.equal(invalidateMembershipApprovals(member(['reviewer'], false), member(['reviewer'])), true);
  assert.equal(invalidateMembershipApprovals(member(['reader']), member(['reader'], false)), true);
  assert.equal(invalidateMembershipApprovals(member(['reviewer']), member(['export', 'reviewer'])), false);
  assert.equal(invalidateMembershipApprovals(member(['admin']), member(['reviewer'])), false);
  assert.equal(invalidateMembershipApprovals(member(['reader']), member(['reader', 'sponsor'])), false);
});
