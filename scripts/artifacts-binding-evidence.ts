// SPDX-License-Identifier: Apache-2.0
export const ARTIFACTS_BINDING_CHECKS = [
  'binding-source-ingest-exact', 'binding-blob-bytes-and-modes', 'r2-materialization-exact',
  'binding-conditional-publication-observed', 'binding-duplicate-retains-frozen-head',
  'binding-race-single-winner', 'binding-loser-retry-fixed-base', 'binding-fork-observes-current-head',
  'binding-unpublished-work-ref-roundtrip', 'binding-canonical-unchanged-by-work-ref',
  'binding-token-revocation-observed', 'binding-journaled-effects-resolved', 'owned-repositories-absent',
  'native-deployed-modules-and-bindings',
] as const;
export const ARTIFACTS_BINDING_SOURCES = [
  'infra/live-artifacts-check.ts', 'infra/live-artifacts-operator.ts', 'infra/live-artifacts/worker.ts', 'infra/live-artifacts/types.ts',
  'infra/live-artifacts/diagnostics.ts', 'infra/live-artifacts/seed-transport.ts',
  'scripts/provider-preflight.ts', 'scripts/provider-preflight-evidence.ts',
  'scripts/artifacts-binding-evidence.ts', 'workers/authority/artifacts.ts', 'workers/authority/kernel.ts', 'workers/authority/wrangler.jsonc',
  'workers/shared/objects.ts', 'workers/shared/errors.ts', 'packages/protocol/src/index.ts',
  'packages/protocol/wasm/confidence_protocol.js', 'packages/protocol/wasm/confidence_protocol_bg.wasm',
  'package.json', 'package-lock.json',
] as const;
