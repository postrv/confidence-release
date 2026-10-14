// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { PlatformError, requireValue } from '../../../workers/shared/errors';
import { IMPORTED_PREVIEW_BYTES, PROJECT_IMPORT_LIMITS, type ImportedEntry, type ImportedFileResponse, type ImportedSource,
  type ImportedSourceIdentity, type ImportedSourceRequest, type ProjectSummary } from './types';
import { parseProjectJson } from './validation';

export function importedSourceRequest(parameters: URLSearchParams): ImportedSourceRequest {
  requireValue([...parameters.keys()].every(key => ['incarnation', 'archive', 'view', 'path'].includes(key))
    && [...new Set(parameters.keys())].every(key => parameters.getAll(key).length === 1), 'PROJECT_SOURCE_QUERY_INVALID');
  const request = { incarnation: parameters.get('incarnation'), archive: parameters.get('archive'), view: parameters.get('view'),
    ...(parameters.has('path') ? { path: parameters.get('path') } : {}) };
  validateImportedSourceRequest(request); return request;
}
export function validateImportedSourceRequest(value: unknown): asserts value is ImportedSourceRequest {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'PROJECT_SOURCE_QUERY_INVALID');
  const request = value as Record<string, unknown>;
  requireValue(Object.keys(request).sort().join(',') === (request.view === 'file' ? 'archive,incarnation,path,view' : 'archive,incarnation,view')
    && typeof request.incarnation === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(request.incarnation)
    && typeof request.archive === 'string' && /^sha256:[0-9a-f]{64}$/.test(request.archive)
    && ['tree', 'file', 'archive'].includes(String(request.view)), 'PROJECT_SOURCE_QUERY_INVALID');
  if (request.view === 'file') requireValue(typeof request.path === 'string' && request.path.length > 0
    && new TextEncoder().encode(request.path).length <= 4096 && !request.path.includes('\0'), 'PROJECT_SOURCE_PATH_INVALID');
}
export function assertImportedSource(project: ProjectSummary, request: ImportedSourceRequest): ImportedSource {
  validateImportedSourceRequest(request);
  requireValue(project.roles.includes('reader') || project.roles.includes('admin'), 'PROJECT_UNAVAILABLE', 404);
  requireValue(project.source.status === 'IMPORTED', 'IMPORTED_SOURCE_UNAVAILABLE', 409);
  requireValue(project.projectIncarnation === request.incarnation && project.source.archiveDigest === request.archive, 'PROJECT_SOURCE_CHANGED', 409);
  if (request.view === 'archive') requireValue(project.roles.includes('export') || project.roles.includes('admin'), 'SOURCE_EXPORT_DENIED', 403);
  return project.source;
}
export function importedSourceIdentity(project: ProjectSummary, source: ImportedSource): ImportedSourceIdentity {
  return { schemaVersion: 1, projectId: project.projectId, projectIncarnation: project.projectIncarnation, head: source.head, archiveDigest: source.archiveDigest };
}
/** The digest is checked by the storage adapter before decoding this retained inventory. */
export function importedInventory(bytes: Uint8Array, source: ImportedSource): ImportedEntry[] {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new PlatformError('PROJECT_INVENTORY_INVALID', 409); }
  const inventory = value as { head?: unknown; entries?: unknown } | null;
  requireValue(inventory && inventory.head === source.head && Array.isArray(inventory.entries)
    && inventory.entries.length === source.fileCount && inventory.entries.length <= PROJECT_IMPORT_LIMITS.files, 'PROJECT_INVENTORY_INVALID', 409);
  const entries = inventory.entries as ImportedEntry[]; let previous: string | undefined;
  for (const entry of entries) {
    requireValue(entry && typeof entry.path === 'string' && entry.path.length > 0 && new TextEncoder().encode(entry.path).length <= 4096
      && !entry.path.includes('\0') && (previous === undefined || entry.path > previous)
      && /^(100644|100755|120000|160000)$/.test(entry.mode) && /^[0-9a-f]{40}$/.test(entry.oid)
      && (entry.mode === '160000' ? entry.bytes === null : Number.isSafeInteger(entry.bytes) && entry.bytes! >= 0 && entry.bytes! <= PROJECT_IMPORT_LIMITS.blobBytes), 'PROJECT_INVENTORY_INVALID', 409);
    previous = entry.path;
  }
  return entries;
}
/** Lookup is by exact retained path, never a filesystem operation or external fetch. */
export function importedFile(identity: ImportedSourceIdentity, entry: ImportedEntry, archiveBytes?: Uint8Array): ImportedFileResponse {
  const base = { ...identity, entry };
  if (entry.mode === '160000') return { ...base, representation: 'gitlink' };
  if (entry.bytes! > IMPORTED_PREVIEW_BYTES) return { ...base, representation: 'too-large' };
  requireValue(archiveBytes, 'PROJECT_ARCHIVE_REQUIRED', 409);
  const archive = parseProjectJson(archiveBytes);
  requireValue(archive.schemaVersion === 1 && archive.format === 'confidence-git-archive-v1' && archive.head === identity.head
    && Array.isArray(archive.objects) && archive.objects.length <= PROJECT_IMPORT_LIMITS.objects, 'PROJECT_ARCHIVE_FORMAT_INVALID', 409);
  const matches = archive.objects.filter((object: { oid?: unknown } | null) => object?.oid === entry.oid);
  requireValue(matches.length === 1 && matches[0].type === 'blob' && typeof matches[0].dataBase64 === 'string', 'PROJECT_ARCHIVE_BLOB_MISSING', 409);
  const encoded = matches[0].dataBase64 as string;
  requireValue(encoded.length <= 4 * Math.ceil(IMPORTED_PREVIEW_BYTES / 3), 'PROJECT_ARCHIVE_BLOB_LIMIT', 413);
  const data = Buffer.from(encoded, 'base64');
  requireValue(data.length === entry.bytes && data.toString('base64') === encoded
    && createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex') === entry.oid, 'PROJECT_ARCHIVE_OBJECT_ID_MISMATCH', 409);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
  catch { return { ...base, representation: 'binary' }; }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return { ...base, representation: 'binary' };
  return { ...base, representation: entry.mode === '120000' ? 'symlink' : 'text', text };
}
export function importedSourceHeaders(): Record<string, string> {
  return { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'referrer-policy': 'no-referrer' };
}
