export function applyInterlinkedBuildPatch(original: Buffer, patchBytes: Buffer, expectedPatchSha256: string): {
  modified: string;
  provenance: { id: string; sourcePath: string; patchSha256: string; originalSha256: string; patchedSha256: string };
};
