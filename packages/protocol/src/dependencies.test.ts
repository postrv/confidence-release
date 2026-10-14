// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PINNED_WEFT_DEPENDENCY } from './dependencies';
import { HUB_AGENT_CAPABILITIES } from './project-hub';

test('standalone downloaded client and server agree on the complete pinned dependency identity', async () => {
  const client = await import(new URL('../../../scripts/confidence-agent.mjs', import.meta.url).href);
  assert.deepEqual(client.WEFT_DEPENDENCY, PINNED_WEFT_DEPENDENCY);
  assert.deepEqual(client.AGENT_CAPABILITIES, HUB_AGENT_CAPABILITIES);
  assert.deepEqual(client.validateDependency(PINNED_WEFT_DEPENDENCY), PINNED_WEFT_DEPENDENCY);
  assert.throws(() => client.validateDependency({ ...PINNED_WEFT_DEPENDENCY, commit: '0'.repeat(40) }));
});
