// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { PROJECT_IMPORT_LIMITS, type ImportedEntry, type ProjectCheck, type RepositoryArchive } from './types';
import { canonicalProjectJson, parseProjectJson as parseJson } from './json';
import { PlatformError, requireValue } from '../../../workers/shared/errors';

export function parseProjectJson(input: string | Uint8Array): Record<string, unknown> {
  try {
    const raw = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
    requireValue(new TextEncoder().encode(raw).length <= PROJECT_IMPORT_LIMITS.archiveBytes, 'PROJECT_ARCHIVE_SIZE_LIMIT', 413);
    const result = parseJson(raw); requireValue(record(result), 'PROJECT_OBJECT_REQUIRED'); return result;
  } catch (error) { if (error instanceof PlatformError) throw error; throw new PlatformError('INVALID_PROJECT_JSON'); }
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exact = (value: unknown, keys: string[]) => requireValue(record(value) && Object.keys(value).sort().join(',') === keys.sort().join(','), 'PROJECT_SCHEMA_INVALID');
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
export const projectDigest = (value: unknown): string => 'sha256:' + createHash('sha256').update(canonicalProjectJson(value)).digest('hex');
export function validateProjectDetails(body: Record<string, unknown>): { name: string; description: string } {
  requireValue(Object.keys(body).every(key => key === 'name' || key === 'description'), 'PROJECT_SCHEMA_INVALID');
  requireValue(typeof body.name === 'string' && body.name.trim() === body.name && body.name.length > 0 && new TextEncoder().encode(body.name).length <= 120 && !/[\u0000-\u001f\u007f]/.test(body.name), 'PROJECT_NAME_INVALID');
  const description = body.description ?? '';
  requireValue(typeof description === 'string' && new TextEncoder().encode(description).length <= 2048 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description), 'PROJECT_DESCRIPTION_INVALID');
  return { name: body.name, description };
}

export function validateProjectChecks(value: unknown): ProjectCheck[] {
  requireValue(Array.isArray(value) && value.length <= PROJECT_IMPORT_LIMITS.checks, 'PROJECT_CHECK_LIMIT');
  const ids = new Set<string>();
  for (const check of value) {
    exact(check, ['id', 'name', 'argv', 'cwd', 'timeoutSeconds', 'required', 'enabled', 'source', 'evidenceClass']);
    requireValue(typeof check.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(check.id) && !ids.has(check.id), 'PROJECT_CHECK_ID_INVALID'); ids.add(check.id);
    requireValue(text(check.name, 120) && check.name.trim().length > 0 && Array.isArray(check.argv) && check.argv.length > 0 && check.argv.length <= 64
      && check.argv.every((argument: unknown) => text(argument, 2048)) && check.argv[0].length > 0, 'PROJECT_CHECK_COMMAND_INVALID');
    requireValue(text(check.cwd, 1024) && (check.cwd === '.' || check.cwd.length > 0 && !check.cwd.startsWith('/') && !check.cwd.includes('\\') && check.cwd.split('/').every((part: string) => part && part !== '.' && part !== '..')), 'PROJECT_CHECK_DIRECTORY_INVALID');
    requireValue(Number.isSafeInteger(check.timeoutSeconds) && check.timeoutSeconds >= 1 && check.timeoutSeconds <= 900
      && typeof check.required === 'boolean' && typeof check.enabled === 'boolean' && ['detected', 'manual'].includes(check.source)
      && check.evidenceClass === 'repository-check', 'PROJECT_CHECK_CONFIGURATION_INVALID');
  }
  requireValue(new TextEncoder().encode(canonicalProjectJson(value)).length <= 32 * 1024, 'PROJECT_CHECK_CONFIGURATION_LIMIT', 413);
  return value as ProjectCheck[];
}

export interface ValidatedImport { archive: RepositoryArchive; digest: string; entries: ImportedEntry[]; objectBytes: number; warnings: string[] }
/** Preserve exact Git objects; never execute hooks, dereference symlinks, or fetch gitlinks/history. */
export function validateRepositoryArchive(value: unknown): ValidatedImport {
  exact(value, ['schemaVersion', 'format', 'head', 'branch', 'objects', 'checks', 'warnings']);
  const archive = value as RepositoryArchive;
  requireValue(archive.schemaVersion === 1 && archive.format === 'confidence-git-archive-v1' && /^[a-f0-9]{40}$/.test(archive.head), 'PROJECT_ARCHIVE_FORMAT_INVALID');
  requireValue(archive.branch === null || text(archive.branch, 1024) && archive.branch.length > 0, 'PROJECT_ARCHIVE_BRANCH_INVALID');
  validateProjectChecks(archive.checks);
  requireValue(Array.isArray(archive.warnings) && archive.warnings.length <= 64 && archive.warnings.every(item => text(item, 512)), 'PROJECT_ARCHIVE_WARNINGS_INVALID');
  requireValue(new TextEncoder().encode(canonicalProjectJson(archive.warnings)).length <= 8192, 'PROJECT_ARCHIVE_WARNINGS_LIMIT', 413);
  requireValue(Array.isArray(archive.objects) && archive.objects.length > 0 && archive.objects.length <= PROJECT_IMPORT_LIMITS.objects, 'PROJECT_ARCHIVE_OBJECT_LIMIT', 413);
  const objects = new Map<string, { type: string; data: Uint8Array }>(); let objectBytes = 0;
  for (const object of archive.objects) {
    exact(object, ['oid', 'type', 'dataBase64']);
    requireValue(/^[a-f0-9]{40}$/.test(object.oid) && !objects.has(object.oid) && ['commit', 'tree', 'blob'].includes(object.type)
      && typeof object.dataBase64 === 'string' && object.dataBase64.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(object.dataBase64)
      && (object.dataBase64.indexOf('=') === -1 || object.dataBase64.indexOf('=') >= object.dataBase64.length - 2), 'PROJECT_ARCHIVE_OBJECT_INVALID');
    const data = Buffer.from(object.dataBase64, 'base64');
    requireValue(data.toString('base64') === object.dataBase64 && data.length <= PROJECT_IMPORT_LIMITS.blobBytes, 'PROJECT_ARCHIVE_BLOB_LIMIT', 413);
    objectBytes += data.length; requireValue(objectBytes <= PROJECT_IMPORT_LIMITS.objectBytes, 'PROJECT_ARCHIVE_SOURCE_LIMIT', 413);
    requireValue(createHash('sha1').update(`${object.type} ${data.length}\0`).update(data).digest('hex') === object.oid, 'PROJECT_ARCHIVE_OBJECT_ID_MISMATCH');
    objects.set(object.oid, { type: object.type, data });
  }
  const commit = objects.get(archive.head); requireValue(commit?.type === 'commit', 'PROJECT_ARCHIVE_HEAD_MISSING');
  const headerEnd = Buffer.from(commit.data).indexOf('\n\n'); requireValue(headerEnd >= 0, 'PROJECT_ARCHIVE_COMMIT_INVALID');
  // Commit messages and optional signature headers may use arbitrary bytes; preserve them exactly.
  const headers: string[] = Buffer.from(commit.data.subarray(0, headerEnd)).toString('latin1').split('\n'); const treeHeaders = headers.filter(line => line.startsWith('tree '));
  requireValue(treeHeaders.length === 1 && /^tree [a-f0-9]{40}$/.test(treeHeaders[0]!) && headers[0] === treeHeaders[0], 'PROJECT_ARCHIVE_COMMIT_INVALID');
  requireValue(headers.filter(line => line.startsWith('parent ')).every(line => /^parent [a-f0-9]{40}$/.test(line)), 'PROJECT_ARCHIVE_COMMIT_INVALID');
  const seen = new Set<string>([archive.head]), entries: ImportedEntry[] = []; let sourceBytes = 0;
  const walk = (oid: string, prefix: string, depth: number): void => {
    requireValue(depth <= PROJECT_IMPORT_LIMITS.depth, 'PROJECT_ARCHIVE_TREE_DEPTH', 413);
    const tree = objects.get(oid); requireValue(tree?.type === 'tree', 'PROJECT_ARCHIVE_TREE_MISSING'); seen.add(oid);
    let position = 0; const names = new Set<string>(); let previous: Uint8Array | undefined;
    while (position < tree.data.length) {
      const space = tree.data.indexOf(32, position), zero = tree.data.indexOf(0, space + 1);
      requireValue(space > position && zero > space && zero + 21 <= tree.data.length, 'PROJECT_ARCHIVE_TREE_INVALID');
      const mode = new TextDecoder().decode(tree.data.subarray(position, space));
      const nameBytes = tree.data.subarray(space + 1, zero); let name: string;
      try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); } catch { throw new PlatformError('PROJECT_ARCHIVE_PATH_ENCODING_UNSUPPORTED'); }
      requireValue(name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !names.has(name), 'PROJECT_ARCHIVE_TREE_NAME_INVALID'); names.add(name);
      requireValue(['40000', '100644', '100755', '120000', '160000'].includes(mode), 'PROJECT_ARCHIVE_MODE_INVALID');
      const ordering = new Uint8Array(nameBytes.length + 1); ordering.set(nameBytes); ordering[nameBytes.length] = mode === '40000' ? 47 : 0;
      requireValue(!previous || Buffer.compare(previous, ordering) < 0, 'PROJECT_ARCHIVE_TREE_ORDER_INVALID'); previous = ordering;
      const child = Buffer.from(tree.data.subarray(zero + 1, zero + 21)).toString('hex'); position = zero + 21;
      const path = prefix ? `${prefix}/${name}` : name; requireValue(new TextEncoder().encode(path).length <= 4096, 'PROJECT_ARCHIVE_PATH_LIMIT', 413);
      if (mode === '40000') { walk(child, path, depth + 1); continue; }
      requireValue(entries.length < PROJECT_IMPORT_LIMITS.files, 'PROJECT_ARCHIVE_FILE_LIMIT', 413);
      if (mode === '160000') { entries.push({ path, oid: child, mode, bytes: null }); continue; }
      const blob = objects.get(child); requireValue(blob?.type === 'blob', 'PROJECT_ARCHIVE_BLOB_MISSING'); seen.add(child); sourceBytes += blob.data.length;
      requireValue(sourceBytes <= PROJECT_IMPORT_LIMITS.objectBytes, 'PROJECT_ARCHIVE_EXPANDED_SOURCE_LIMIT', 413);
      entries.push({ path, oid: child, mode: mode as ImportedEntry['mode'], bytes: blob.data.length });
    }
  };
  walk(treeHeaders[0]!.slice(5), '', 0);
  requireValue(seen.size === objects.size, 'PROJECT_ARCHIVE_UNREACHABLE_OBJECT');
  const warnings = [...archive.warnings, 'Only the selected HEAD and its tree are retained; parent history is not imported.'];
  if (entries.some(entry => entry.mode === '160000')) warnings.push('Submodule commit references are retained; submodule repositories are not imported.');
  if (entries.some(entry => entry.mode === '120000')) warnings.push('Symbolic links are retained as Git blobs and are not followed.');
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  // JSON escaping and repeated directory prefixes can exceed raw Git path sizes.
  requireValue(new TextEncoder().encode(canonicalProjectJson({ head: archive.head, entries })).length <= PROJECT_IMPORT_LIMITS.inventoryBytes, 'PROJECT_INVENTORY_SIZE_LIMIT', 413);
  const serialized = canonicalProjectJson(archive); requireValue(new TextEncoder().encode(serialized).length <= PROJECT_IMPORT_LIMITS.archiveBytes, 'PROJECT_ARCHIVE_SIZE_LIMIT', 413);
  return { archive, digest: projectDigest(archive), entries, objectBytes, warnings };
}
