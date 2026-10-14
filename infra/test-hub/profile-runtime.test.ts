// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCollaborationProfile } from './profile-runtime.ts';

test('generated collaboration-only deployment bindings support the real isolated project and agent journey', async () => {
  const report = await checkCollaborationProfile();
  assert.equal(report.passed, true);
  assert.equal(report.profile, 'collaboration-only');
  assert.equal(report.bundleQualified, true);
  assert.ok(report.checks.length >= 7);
});
