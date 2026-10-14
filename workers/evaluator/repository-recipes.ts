// SPDX-License-Identifier: Apache-2.0
import { canonicalize, digest, getKernel, type AdmissionCandidate, type Scope, type SourceManifest } from '../../packages/protocol/src/index';
import { requireValue } from '../shared/errors';
import type { EvaluationContext } from './recipes';

/** Reviewed CI inputs, outside the candidate's authority to redefine its gate. */
export const CONFIDENCE_REPOSITORY_RECIPE = {
  schemaVersion: 1,
  id: 'confidence-repository-v1',
  foundation: '8b6a3f0906e18f102d2aeda28972b12b5c4e4c86',
  evidenceClass: 'repository-check',
  toolchain: { nodeMajor: 24, rust: '1.98.0', wasmPack: '0.13.1', cargoJobs: 2 },
  dependencyInstallation: 'image-build-only-from-locked-inputs',
  candidateNetwork: 'none',
  candidateCredentials: 'none',
  capture: 'complete-regular-file-tree',
  exclusions: [],
  controlInputs: {
    '.github/workflows/validate.yml': 'sha256:ba0eb7a0994f8c8a7c859d87020d7de74fceed40c44ef4972a4cc33395da0d40',
    'Cargo.lock': 'sha256:b10f93a31c2c0dc2012c5c21e29758642bd2604de9e61c13e623ad786dbc03ca',
    'Cargo.toml': 'sha256:795dd339af068fe04d1c0b812afc2f826bc66c161e458081829949cf34b24a6b',
    'crates/project-cli/Cargo.toml': 'sha256:f398bdc09b6dd7e1f0a693dc1b33f901d07e75c48cbb9926d56d2b8f52421b31',
    'crates/protocol/Cargo.toml': 'sha256:a0267f1d7eabf854f2c1a557b2f77facf254212f4638418b77044535d1f3edc6',
    'crates/verifier-cli/Cargo.toml': 'sha256:31328f218dce919563e323cca26de411a7e98228adbaea4493f8785d1e5ce7eb',
    'package-lock.json': 'sha256:2de84d043e4b7fb3b39a457d1dfee7014256e84613ed91ac40240235e4d35629',
    'package.json': 'sha256:9d34d268321813f2d06c3c4709ac58bafd20e76cf1c5467abf044ed93a0c7acd',
    'rust-toolchain.toml': 'sha256:69375af455ac1385a4a88db3502e65353f8d387cf51c69c43790b26f44bbf755',
  },
  sourceCommands: [
    ['npm', 'run', 'test:local'],
    ['node', '--test', 'scripts/public-source.test.mjs'],
    ['node', '--import', 'tsx', '--test', '--test-concurrency=1', 'scripts/weft-access.test.mjs', 'infra/weft-development/configure.test.ts'],
    ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'infra/weft-development/tsconfig.json'],
    ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'infra/test-weft/tsconfig.json'],
    ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'infra/test-weft/tsconfig.runner.json'],
    ['node', '--test', 'scripts/confidence-agent.test.mjs'],
    ['node', '--import', 'tsx', '--test', 'packages/protocol/src/dependencies.test.ts', 'packages/protocol/src/project-hub.test.ts'],
    ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'infra/test-hub/tsconfig.json'],
    ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'infra/test-weft/tsconfig.repository-profile.json'],
    ['cargo', 'fmt', '--check'],
    ['cargo', 'clippy', '--workspace', '--all-targets', '--', '-D', 'warnings'],
    ['npm', 'run', 'test:pi'],
    ['npm', 'run', 'compare:workflows'],
    ['npm', 'run', 'demo'],
    ['npm', 'run', 'verify', '--', 'demo-output/receipt.json', 'demo-output/trust.json', 'demo-output/checkpoint.json'],
    ['npm', 'run', 'verify', '--', 'demo-output/receipt.json', 'demo-output/trust.json', 'demo-output/checkpoint-attestation.json'],
  ],
  imageCommands: [['npm', 'run', 'test:container'], ['npm', 'run', 'test:runner-image']],
  qualificationRequired: [
    'immutable-toolchain-and-offline-dependency-image',
    'unprivileged-candidate-with-protected-checker-and-toolchain',
    'exact-source-hydration-and-external-process-outcomes',
    'bounded-output-deadline-and-observed-whole-generation-termination',
    'registered-authority-evaluator-and-repository-evidence-admission',
    'required-image-gates-when-outside-docs-or-web',
    'separately-pinned-weft-journey',
  ],
} as const;

function controlPath(path: string): boolean {
  return path === 'package.json' || path === 'package-lock.json' || path === 'Cargo.lock'
    || path === 'rust-toolchain.toml' || path === 'Cargo.toml' || path.endsWith('/Cargo.toml')
    || /(^|\/)(?:\.npmrc|\.cargo\/config(?:\.toml)?)$/.test(path);
}

/** This does not enroll a project, authorize execution, or accept a claimed PASS. */
export function assertConfidenceRepositoryInputs(manifest: SourceManifest): void {
  const checked = JSON.parse(getKernel().validate_manifest(canonicalize(manifest))) as { valid: boolean; reason?: string };
  requireValue(checked.valid, checked.reason ?? 'INVALID_SOURCE_MANIFEST', 422);
  const pins: Record<string, string> = CONFIDENCE_REPOSITORY_RECIPE.controlInputs;
  const entries = new Map(manifest.entries.map(entry => [entry.path, entry]));
  for (const [path, expected] of Object.entries(pins)) {
    const entry = entries.get(path);
    requireValue(entry?.digest === expected && entry.mode === '100644', 'REPOSITORY_RECIPE_INPUT_CHANGED', 409);
  }
  // New dependency manifests or package-manager configuration need a new recipe;
  // they cannot redirect a pinned package script to an unreviewed installation.
  requireValue(manifest.entries.every(entry => !controlPath(entry.path) || Object.hasOwn(pins, entry.path)), 'REPOSITORY_RECIPE_INPUT_ADDED', 409);
}

export function repositoryImageChecksRequired(base: SourceManifest, candidate: SourceManifest): boolean {
  const previous = new Map(base.entries.map(entry => [entry.path, entry]));
  const current = new Map(candidate.entries.map(entry => [entry.path, entry]));
  const changed = [...new Set([...previous.keys(), ...current.keys()])].filter(path =>
    canonicalize(previous.get(path) ?? null) !== canonicalize(current.get(path) ?? null));
  // Match the foundation's trusted CI classifier. Both sides of a rename count.
  return changed.length === 0 || changed.some(path => !path.startsWith('docs/') && !path.startsWith('apps/web/'));
}

export async function prepareConfidenceRepositoryChecks(input: {
  scope: Scope; candidate: AdmissionCandidate; base: SourceManifest; manifest: SourceManifest; evaluation: EvaluationContext;
}) {
  const { scope, candidate, base, manifest, evaluation } = input;
  requireValue(scope.schemaVersion === 1 && scope.tenantId && scope.projectId && scope.projectIncarnation, 'INVALID_SCOPE');
  requireValue(evaluation.schemaVersion === 1 && evaluation.id && evaluation.goalRevision && evaluation.policyRevision
    && /^sha256:[a-f0-9]{64}$/.test(evaluation.contractBundleDigest), 'INVALID_EVALUATION_CONTEXT');
  assertConfidenceRepositoryInputs(base); assertConfidenceRepositoryInputs(manifest);
  requireValue(await digest(manifest) === candidate.manifestDigest, 'SOURCE_IDENTITY_MISMATCH', 409);
  const imagesRequired = repositoryImageChecksRequired(base, manifest);
  const prepared = {
    schemaVersion: 1, profileId: CONFIDENCE_REPOSITORY_RECIPE.id,
    recipeDigest: await digest(CONFIDENCE_REPOSITORY_RECIPE), scope, candidate, evaluation,
    sourceCommands: CONFIDENCE_REPOSITORY_RECIPE.sourceCommands,
    imageCommands: imagesRequired ? CONFIDENCE_REPOSITORY_RECIPE.imageCommands : [], imagesRequired,
    evidenceClass: CONFIDENCE_REPOSITORY_RECIPE.evidenceClass,
    registration: 'unregistered' as const,
    qualificationRequired: CONFIDENCE_REPOSITORY_RECIPE.qualificationRequired,
  };
  return { ...prepared, preparationDigest: await digest(prepared) };
}
