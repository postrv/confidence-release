// SPDX-License-Identifier: Apache-2.0
// Ordered release identity inputs, shared by reporting and deployment validation.
export const checkerInputPaths = [
  '.dockerignore',
  'scripts/checker-inputs.ts',
  'workers/evaluator/index.ts', 'workers/evaluator/recovery.ts', 'workers/evaluator/recipes.ts', 'workers/evaluator/hydration.ts', 'workers/evaluator/overlap.ts', 'workers/evaluator/Dockerfile',
  'workers/authority/kernel.ts',
  'workers/shared/errors.ts', 'workers/shared/objects.ts', 'workers/shared/deadline.ts', 'workers/shared/age.ts',
  'packages/protocol/src/index.ts', 'packages/protocol/src/types.ts', 'packages/protocol/src/typescript-workload-profile.ts',
  'packages/protocol/wasm/confidence_protocol.js', 'packages/protocol/wasm/confidence_protocol_bg.wasm',
  'crates/protocol/Cargo.toml', 'crates/protocol/src/lib.rs', 'crates/protocol/src/capability.rs',
  'crates/protocol/src/composition.rs', 'crates/protocol/src/execution.rs',
  'rust-toolchain.toml', 'Cargo.lock', 'package-lock.json',
] as const;
