// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// Apply only the reviewed patch to the exact pinned upstream source. A source,
// patch, pattern count or resulting-byte change requires an explicit new pin.
export function applyInterlinkedBuildPatch(original, patchBytes, expectedPatchSha256) {
  if (sha(patchBytes) !== expectedPatchSha256) throw new Error('Pinned build patch SHA-256 mismatch');
  const patch = JSON.parse(patchBytes.toString('utf8'));
  if (patch.schemaVersion !== 1 || patch.id !== 'confidence-interlinked-retained-biome-v1'
    || patch.sourcePath !== 'src/harness/check-engine/tool-runners/biome.ts'
    || !Array.isArray(patch.replacements) || patch.replacements.length !== 2) throw new Error('Pinned build patch shape mismatch');
  if (sha(original) !== patch.originalSha256) throw new Error('Pinned build patch upstream source SHA-256 mismatch');
  let modified = original.toString('utf8');
  for (const { before, after } of patch.replacements) {
    if (typeof before !== 'string' || !before.length || typeof after !== 'string' || modified.split(before).length !== 2) throw new Error('Pinned build patch pattern mismatch');
    modified = modified.replace(before, () => after);
  }
  if (sha(modified) !== patch.patchedSha256) throw new Error('Pinned build patch result SHA-256 mismatch');
  return { modified, provenance: { id: patch.id, sourcePath: patch.sourcePath, patchSha256: expectedPatchSha256,
    originalSha256: patch.originalSha256, patchedSha256: patch.patchedSha256 } };
}
