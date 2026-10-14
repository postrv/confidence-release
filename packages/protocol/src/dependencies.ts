// SPDX-License-Identifier: Apache-2.0
/** Operator-provisioned immutable dependency; no caller-selected remote or ref. */
export const PINNED_WEFT_DEPENDENCY = {
  schema: 'confidence.pinned-dependency.v1',
  name: 'weft',
  repository: 'https://d6f63b7e2306adea17b338d4b6b4c739.artifacts.cloudflare.net/git/weft/weft.git',
  repositoryId: 'g5r2hnjuyz0cd3j0',
  ref: 'refs/tags/confidence-weft-b1c5521',
  commit: 'b1c5521bf28a0144203c55b3f056885dce3535ff',
  tree: '95865f40a45e6bb3f68eabe88766e593c8eb8959',
  bundle: {
    format: 'git-bundle',
    sha256: '8174e542276c92ba6059fe3a02c0d61897757ec147d0e0481f026f3f4e7fa673',
    bytes: 756862,
    selfContained: true,
  },
} as const;

export type PinnedDependency = typeof PINNED_WEFT_DEPENDENCY;
