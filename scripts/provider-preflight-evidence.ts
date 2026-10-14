// SPDX-License-Identifier: Apache-2.0
/** Finite provider observations required before enabling conditional publication. */
export const ARTIFACTS_PREFLIGHT_CHECKS = [
  'remote-binds-fresh-resources', 'initial-ref-empty', 'owned-baseline-installed', 'baseline-exact-roundtrip',
  'fixed-base-child-update', 'duplicate-retains-same-commit', 'fork-binds-fresh-resources',
  'fork-observes-current-head', 'moving-head-fork-pinned-base', 'unpublished-work-source-transfer',
  'fork-does-not-advance-canonical', 'read-token-exact-roundtrip', 'revoked-read-token-denied',
  'race-both-outcomes-observed', 'one-fixed-base-race-winner', 'loser-retry-keeps-original-base',
  'winning-source-exact-roundtrip', 'source-inputs-unchanged', 'all-git-dispatches-resolved',
  'owned-repository-tokens-revoked',
] as const;
/** Includes transitive local runtime imports used by the shared adapter helpers. */
export const ARTIFACTS_PREFLIGHT_SOURCES = [
  'scripts/provider-preflight.ts', 'scripts/provider-preflight-evidence.ts', 'workers/authority/artifacts.ts',
  'workers/shared/objects.ts', 'workers/shared/errors.ts', 'packages/protocol/src/index.ts',
  'package.json', 'package-lock.json',
] as const;
