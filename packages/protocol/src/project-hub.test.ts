// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { HUB_AGENT_CAPABILITIES, HUB_LIMITS, HUB_MESSAGE_KINDS } from './project-hub';

test('discussion messages and delegated capabilities do not grant protected workflow operations', () => {
  const capabilities: readonly string[] = HUB_AGENT_CAPABILITIES;
  const kinds: readonly string[] = HUB_MESSAGE_KINDS;
  assert.ok(capabilities.includes('discussion:read') && capabilities.includes('discussion:post'));
  assert.ok(capabilities.includes('dependency:weft:read'));
  for (const forbidden of ['approve', 'publish', 'candidate:submit', 'replica:write', 'connection:create']) {
    assert.equal(capabilities.includes(forbidden), false);
    assert.equal(kinds.includes(forbidden), false);
  }
  assert.ok(HUB_LIMITS.connectionLifetimeSeconds <= 24 * 60 * 60);
  assert.ok(HUB_LIMITS.pageMessages <= 100 && HUB_LIMITS.messageBytes <= 8 * 1024);
});
