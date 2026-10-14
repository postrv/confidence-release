// SPDX-License-Identifier: Apache-2.0
import { canonicalize, encodeBase64, getKernel, type SourceManifest } from '../../packages/protocol/src/index';
import { digestBytes, readBounded, requireValue } from '../shared/errors';

interface HydrationFiles {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  readFile(path: string): Promise<{ body: ReadableStream<Uint8Array> | null }>;
  lstat(path: string): Promise<{ type: string; size: bigint; mode: number }>;
}
type VerifiedObjects = { get(digest: string, maximumBytes: number): Promise<Uint8Array> };
type Mode = '644' | '755';

// An absolute path from the portable source profile is at most 251 bytes.
// Keep each command well below ordinary argv limits without one process per file.
const MODE_BATCH_FILES = 64;
// Match the portable source profile and the verified ObjectStore.get bound.
const MAX_FILE_BYTES = 1 * 1024 * 1024;

/** Materialize only the verified source closure before the agent process starts. */
export async function hydrateAuthoringSource(
  manifest: SourceManifest,
  objects: VerifiedObjects,
  files: HydrationFiles,
  chmod: (mode: Mode, paths: string[]) => Promise<void>,
  retainBase64: boolean,
): Promise<Record<string, string>> {
  const checked = JSON.parse(getKernel().validate_manifest(canonicalize(manifest))) as { valid: boolean; reason: string };
  requireValue(checked.valid, checked.reason || 'INVALID_SOURCE_MANIFEST', 409);
  const cached = new Map<string, Uint8Array>();
  const parents = new Set(['/workspace']);
  const paths: Record<Mode, string[]> = { '644': [], '755': [] };
  const base64: Record<string, string> = {};
  requireValue((await files.lstat('/workspace')).type === 'directory', 'WORK_BASE_DIRECTORY_NOT_REGULAR', 409);
  for (const entry of manifest.entries) {
    let data = cached.get(entry.digest);
    if (!data) { data = await objects.get(entry.digest, MAX_FILE_BYTES); cached.set(entry.digest, data); }
    requireValue(data.length === Number(entry.bytes), 'WORK_BASE_SOURCE_SIZE_MISMATCH', 409);
    const path = `/workspace/${entry.path}`, parent = path.slice(0, path.lastIndexOf('/'));
    if (retainBase64) base64[entry.path] = encodeBase64(data);
    // Check each new ancestor before descending so a symlinked source parent
    // cannot redirect the next mkdir or writeFile outside the cloned workspace.
    let directory = '/workspace';
    for (const component of parent.slice('/workspace'.length).split('/').filter(Boolean)) {
      directory += `/${component}`;
      if (parents.has(directory)) continue;
      await files.mkdir(directory, { recursive: true });
      requireValue((await files.lstat(directory)).type === 'directory', 'WORK_BASE_DIRECTORY_NOT_REGULAR', 409);
      parents.add(directory);
    }
    await files.writeFile(path, data.slice());
    paths[entry.mode === '100755' ? '755' : '644'].push(path);
  }
  for (const mode of ['644', '755'] as const) {
    for (let start = 0; start < paths[mode].length; start += MODE_BATCH_FILES) {
      await chmod(mode, paths[mode].slice(start, start + MODE_BATCH_FILES));
    }
  }
  // Neither write nor chmod acknowledgement proves the workspace has the
  // declared regular leaves. Verify type, size, mode and immutable bytes before
  // any authoring process can run.
  for (const entry of manifest.entries) {
    const path = `/workspace/${entry.path}`;
    const stat = await files.lstat(path);
    requireValue(stat.type === 'file', 'WORK_BASE_HYDRATION_NOT_REGULAR_FILE', 409);
    requireValue(stat.size === BigInt(entry.bytes), 'WORK_BASE_HYDRATION_SIZE_MISMATCH', 409);
    requireValue(Number.isInteger(stat.mode) && (stat.mode & 0o7777) === (entry.mode === '100755' ? 0o755 : 0o644), 'WORK_BASE_HYDRATION_MODE_MISMATCH', 409);
    const readback = await files.readFile(path);
    const observed = await readBounded(readback.body, MAX_FILE_BYTES);
    requireValue(observed.length === Number(entry.bytes) && await digestBytes(observed) === entry.digest, 'WORK_BASE_HYDRATION_MISMATCH', 409);
  }
  return base64;
}
