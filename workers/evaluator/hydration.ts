// SPDX-License-Identifier: Apache-2.0
import type { Files } from '@cloudflare/sandbox';
import { canonicalize, decodeBase64, getKernel, sha256, type GitObject, type SourceManifest } from '../../packages/protocol/src/index';
import { readBounded, requireValue } from '../shared/errors';

export type HydrationFiles = Pick<Files, 'mkdir' | 'writeFile' | 'readFile' | 'lstat' | 'readDirectory'>;
export type HydrationExecutor = Pick<Container, 'exec'>;

/** Called before any candidate entrypoint. A write acknowledgement is insufficient. */
export async function hydrateVerifiedSource(files: HydrationFiles, container: HydrationExecutor, manifest: SourceManifest, objects: GitObject[]): Promise<{ files: number; bytes: number; modes: 'verified-regular-644-or-755'; inventory: 'exact' }> {
  const checked = JSON.parse(getKernel().validate_manifest(canonicalize(manifest)));
  requireValue(checked.valid, checked.reason || 'INVALID_SOURCE_MANIFEST');
  const blobs = new Map<string, Uint8Array>();
  for (const object of objects.filter(item => item.type === 'blob')) {
    const bytes = decodeBase64(object.dataBase64); blobs.set(await sha256(bytes), bytes);
  }
  await files.mkdir('/workspace', { recursive: true });
  const expectedFiles = new Set(manifest.entries.map(entry => '/workspace/' + entry.path));
  const expectedDirectories = new Set(['/workspace']);
  let total = 0;
  for (const entry of manifest.entries) {
    const bytes = blobs.get(entry.digest), target = '/workspace/' + entry.path, parent = target.slice(0, target.lastIndexOf('/'));
    requireValue(bytes && bytes.length === Number(entry.bytes), 'SOURCE_BLOB_MISSING');
    for (let directory = parent; directory !== '/workspace'; directory = directory.slice(0, directory.lastIndexOf('/'))) expectedDirectories.add(directory);
    await files.mkdir(parent, { recursive: true }); await files.writeFile(target, bytes);
    const permission = entry.mode === '100755' ? '755' : '644';
    const chmod = await container.exec(['chmod', permission, target], { stdout: 'ignore', stderr: 'ignore' });
    requireValue(await chmod.exitCode === 0, 'HYDRATION_MODE_FAILED');
    const stat = await files.lstat(target);
    requireValue(stat.type === 'file', 'HYDRATION_NOT_REGULAR_FILE');
    requireValue(stat.size === BigInt(entry.bytes), 'HYDRATION_READBACK_SIZE_MISMATCH');
    requireValue(Number.isInteger(stat.mode) && (stat.mode & 0o7777) === (entry.mode === '100755' ? 0o755 : 0o644), 'HYDRATION_READBACK_MODE_MISMATCH');
    const response = await files.readFile(target), observed = await readBounded(response.body, Number(entry.bytes));
    requireValue(observed.length === Number(entry.bytes) && await sha256(observed) === entry.digest, 'HYDRATION_READBACK_DIGEST_MISMATCH');
    total += observed.length;
  }
  // The pinned image may not supply undeclared source or redirect hydration through links.
  const pending = ['/workspace'], seen = new Set<string>();
  while (pending.length) {
    const directory = pending.pop()!;
    requireValue((await files.lstat(directory)).type === 'directory', 'HYDRATION_NOT_REGULAR_DIRECTORY');
    for (const item of await files.readDirectory(directory)) {
      requireValue(item.name.length > 0 && !item.name.includes('/') && item.name !== '.' && item.name !== '..', 'HYDRATION_INVALID_DIRECTORY_ENTRY');
      const path = directory + '/' + item.name;
      requireValue(!seen.has(path), 'HYDRATION_DUPLICATE_DIRECTORY_ENTRY'); seen.add(path);
      if (item.type === 'directory') { requireValue(expectedDirectories.has(path), 'HYDRATION_UNDECLARED_ENTRY'); pending.push(path); }
      else requireValue(item.type === 'file' && expectedFiles.has(path), 'HYDRATION_UNDECLARED_ENTRY');
    }
  }
  requireValue(seen.size === expectedFiles.size + expectedDirectories.size - 1 && [...expectedFiles].every(path => seen.has(path)), 'HYDRATION_INCOMPLETE_INVENTORY');
  return { files: manifest.entries.length, bytes: total, modes: 'verified-regular-644-or-755', inventory: 'exact' };
}
