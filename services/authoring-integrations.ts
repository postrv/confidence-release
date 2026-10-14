// SPDX-License-Identifier: Apache-2.0
import { isAbsolute, resolve } from 'node:path';

/** Operator-owned settings only. Repository files cannot enable tools or choose binaries. */
export function authoringIntegrations(env: NodeJS.ProcessEnv = process.env) {
  const narsilMode = env.CONFIDENCE_NARSIL_CONTEXT ?? 'auto';
  const previewMode = env.CONFIDENCE_INTERLINKED_PREVIEW ?? 'feedback';
  if (!['off', 'auto', 'always'].includes(narsilMode)) throw new Error('INVALID_NARSIL_CONTEXT_MODE');
  if (!['off', 'shadow', 'feedback'].includes(previewMode)) throw new Error('INVALID_INTERLINKED_PREVIEW_MODE');
  const binaryPath = env.CONFIDENCE_NARSIL_BINARY ?? resolve('.local-tools/narsil/narsil-mcp');
  const cliPath = env.CONFIDENCE_INTERLINKED_CLI ?? resolve('.local-tools/interlinked/dist/index.js');
  if (!isAbsolute(binaryPath) || !isAbsolute(cliPath)) throw new Error('AUTHORING_TOOL_ABSOLUTE_PATH_REQUIRED');
  const expectedVersion = env.CONFIDENCE_NARSIL_VERSION ?? '1.7.2';
  if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) throw new Error('INVALID_NARSIL_VERSION');
  return {
    narsil: narsilMode === 'off' ? undefined : { enabled: true, includeSmallProjects: narsilMode === 'always', binaryPath, expectedVersion,
      ...(env.CONFIDENCE_NARSIL_BINARY_DIGEST ? { expectedBinaryDigest: env.CONFIDENCE_NARSIL_BINARY_DIGEST } : {}) },
    interlinked: previewMode === 'off' ? undefined : { mode: previewMode as 'shadow' | 'feedback', cliPath },
  };
}
