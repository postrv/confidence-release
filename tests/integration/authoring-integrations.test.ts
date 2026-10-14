// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { authoringIntegrations } from '../../services/authoring-integrations.ts';

test('operator defaults enable bounded Narsil auto context and Interlinked feedback only', () => {
  assert.deepEqual(authoringIntegrations({}), {
    narsil: { enabled: true, includeSmallProjects: false, binaryPath: resolve('.local-tools/narsil/narsil-mcp'), expectedVersion: '1.7.2' },
    interlinked: { mode: 'feedback', cliPath: resolve('.local-tools/interlinked/dist/index.js') },
  });
});

test('explicit off and diagnostic-only overrides survive the enabled defaults', () => {
  assert.deepEqual(authoringIntegrations({ CONFIDENCE_NARSIL_CONTEXT: 'off', CONFIDENCE_INTERLINKED_PREVIEW: 'off' }), { narsil: undefined, interlinked: undefined });
  assert.equal(authoringIntegrations({ CONFIDENCE_NARSIL_CONTEXT: 'off' }).interlinked?.mode, 'feedback');
  assert.equal(authoringIntegrations({ CONFIDENCE_INTERLINKED_PREVIEW: 'off' }).narsil?.includeSmallProjects, false);
  const configured = authoringIntegrations({ CONFIDENCE_NARSIL_CONTEXT: 'always', CONFIDENCE_INTERLINKED_PREVIEW: 'shadow',
    CONFIDENCE_NARSIL_BINARY: '/owned/narsil', CONFIDENCE_INTERLINKED_CLI: '/owned/preview.mjs' });
  assert.equal(configured.narsil?.includeSmallProjects, true); assert.equal(configured.narsil?.binaryPath, '/owned/narsil');
  assert.deepEqual(configured.interlinked, { mode: 'shadow', cliPath: '/owned/preview.mjs' });
});

test('invalid operator modes never silently become enabled defaults', () => {
  for (const value of ['', 'AUTO', 'enabled', ' auto ', 'feedback']) {
    assert.throws(() => authoringIntegrations({ CONFIDENCE_NARSIL_CONTEXT: value }), /INVALID_NARSIL_CONTEXT_MODE/);
  }
  for (const value of ['', 'FEEDBACK', 'enabled', ' feedback ', 'auto']) {
    assert.throws(() => authoringIntegrations({ CONFIDENCE_INTERLINKED_PREVIEW: value }), /INVALID_INTERLINKED_PREVIEW_MODE/);
  }
  assert.throws(() => authoringIntegrations({ CONFIDENCE_NARSIL_BINARY: 'repository/narsil' }), /AUTHORING_TOOL_ABSOLUTE_PATH_REQUIRED/);
  assert.throws(() => authoringIntegrations({ CONFIDENCE_INTERLINKED_CLI: './repository/preview' }), /AUTHORING_TOOL_ABSOLUTE_PATH_REQUIRED/);
});
