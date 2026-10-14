// SPDX-License-Identifier: Apache-2.0
import type { SourceManifest } from '../../packages/protocol/src/types';

export type PreviewSource = { commit: string; manifest: SourceManifest };

/** Read each verified content address at most once within one snapshot. */
export async function previewSourceFiles(
  sources: readonly PreviewSource[],
  readVerified: (digest: string, maximum: number) => Promise<Uint8Array>,
): Promise<Record<string, Record<string, string>>> {
  const verified = new Map<string, Uint8Array>();
  const sourceFiles: Record<string, Record<string, string>> = {};
  let previewBytes = 0;
  for (const source of sources) {
    // Current/selected sources may also occur in history. Charge and display
    // their first occurrence once; a later copy must not overwrite that view.
    if (Object.hasOwn(sourceFiles, source.commit)) continue;
    const preview: Record<string, string> = {};
    for (const entry of source.manifest.entries) if (Number(entry.bytes) + previewBytes <= 128 * 1024) {
      try {
        let data = verified.get(entry.digest);
        if (data === undefined) {
          data = await readVerified(entry.digest, 128 * 1024);
          verified.set(entry.digest, data);
        }
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(data);
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(decoded)) continue;
        preview[entry.path] = decoded;
        // The cap applies to every displayed entry, including reused bytes.
        previewBytes += data.length;
      } catch { /* Binary and larger files are available through verified bundles. */ }
    }
    sourceFiles[source.commit] = preview;
  }
  return sourceFiles;
}
