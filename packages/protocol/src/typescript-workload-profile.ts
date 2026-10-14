// SPDX-License-Identifier: Apache-2.0
import type { SourceManifest } from './types.ts';

/** Source and authoring contract for the local TypeScript workload. */
export const TYPESCRIPT_SEAT_INVENTORY_V1 = {
  id: 'typescript-seat-inventory-v1',
  sourcePaths: ['app.ts', 'cache.ts', 'domain.ts', 'presentation.ts', 'reservations.ts', 'validation.ts'],
  cohortGrants: ['cache.ts', 'reservations.ts', 'presentation.ts'],
  repairGrant: 'reservations.ts',
  maximumFileBytes: 1024 * 1024,
  maximumSourceBytes: 4 * 1024 * 1024,
  compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
    lib: ['ES2022', 'DOM'], types: [], strict: true, skipLibCheck: true,
    noEmitOnError: true, rootDir: 'src', outDir: 'dist',
  },
} as const;

/** The TypeScript checker only consumes these six immutable source files. */
export function assertTypeScriptSeatInventorySource(manifest: SourceManifest): void {
  const profile = TYPESCRIPT_SEAT_INVENTORY_V1;
  if (manifest?.schemaVersion !== 1 || manifest.pathProfile !== 'portable-ascii-v1'
    || !Array.isArray(manifest.entries) || manifest.entries.length !== profile.sourcePaths.length) throw new Error('TYPESCRIPT_PROFILE_SOURCE_SET');
  let total = 0;
  for (const [index, entry] of manifest.entries.entries()) {
    if (entry?.path !== profile.sourcePaths[index] || entry.mode !== '100644'
      || !/^(0|[1-9][0-9]*)$/.test(entry.bytes) || !/^sha256:[a-f0-9]{64}$/.test(entry.digest)) throw new Error('TYPESCRIPT_PROFILE_SOURCE_ENTRY');
    const size = Number(entry.bytes);
    if (!Number.isSafeInteger(size) || size > profile.maximumFileBytes) throw new Error('TYPESCRIPT_PROFILE_FILE_LIMIT');
    total += size;
    if (total > profile.maximumSourceBytes) throw new Error('TYPESCRIPT_PROFILE_SOURCE_LIMIT');
  }
}

/** Fail closed before the MJS authoring or protected checker sees TS source. */
export function containsTypeScriptSource(manifest: SourceManifest): boolean {
  return Array.isArray(manifest?.entries) && manifest.entries.some(entry => /\.(?:ts|tsx|mts|cts)$/i.test(entry.path));
}
