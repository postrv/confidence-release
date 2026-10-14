import { IMPORTED_INVENTORY_BYTES, IMPORTED_PREVIEW_BYTES, PROJECT_IMPORT_LIMITS, type ImportedEntry, type ImportedFileResponse, type ImportedTreeResponse, type ProjectSummary } from '../../../packages/project-model/src/types';
import { canonicalProjectJson } from '../../../packages/project-model/src/json';
import { ApiError, projectApiPath, request } from './api';

const PREVIEW_BYTES = IMPORTED_PREVIEW_BYTES;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export function importedSourceError(error: unknown): string {
  const code = error instanceof ApiError ? error.code ?? error.message : error instanceof Error ? error.message : '';
  if (code === 'SIZE_LIMIT' || code === 'PROJECT_INVENTORY_SIZE_LIMIT') return 'This retained file list exceeds the browser read limit. If you have export access, download the original archive to inspect its source.';
  if (code === 'SESSION_PRINCIPAL_CHANGED') return 'Your signed-in account changed. Refresh projects before reading or downloading source.';
  if (code === 'PROJECT_SOURCE_CHANGED' || code === 'PROJECT_INCAR_CHANGED') return 'The selected source identity changed. Refresh projects to select the current imported snapshot.';
  if (code === 'PROJECT_UNAVAILABLE' || code === 'SOURCE_EXPORT_DENIED') return 'Your account no longer has permission for this source request. Refresh projects to confirm your access.';
  if (code === 'REQUIRED_OBJECT_MISSING' || code === 'PROJECT_INVENTORY_INVALID' || code === 'OBJECT_DIGEST_MISMATCH') return 'Retained source could not be verified. Ask a project administrator to inspect storage before retrying.';
  return error instanceof Error ? error.message : 'The imported source could not be read.';
}
export function importedSourcePath(project: ProjectSummary, view: 'tree' | 'file' | 'archive', path?: string): string {
  if (project.source.status !== 'IMPORTED' || (view === 'file') !== (path !== undefined)) throw new Error('Choose an imported source and an exact file path.');
  const query = new URLSearchParams({ incarnation: project.projectIncarnation, archive: project.source.archiveDigest, view });
  if (path !== undefined) query.set('path', path);
  return projectApiPath(project.projectId, `/api/source?${query}`);
}

function identity(value: unknown, project: ProjectSummary): asserts value is Record<string, unknown> {
  if (!record(value) || project.source.status !== 'IMPORTED' || value.schemaVersion !== 1 || value.projectId !== project.projectId
    || value.projectIncarnation !== project.projectIncarnation || value.head !== project.source.head || value.archiveDigest !== project.source.archiveDigest) {
    throw new ApiError('The source response does not match this project and imported commit. Refresh projects before retrying.');
  }
}
function entry(value: unknown): value is ImportedEntry {
  return record(value) && typeof value.path === 'string' && value.path.length > 0 && new TextEncoder().encode(value.path).length <= 4096
    && !value.path.includes('\u0000') && !value.path.startsWith('/') && value.path.split('/').every(part => part && part !== '.' && part !== '..')
    && typeof value.oid === 'string' && /^[0-9a-f]{40}$/.test(value.oid) && ['100644', '100755', '120000', '160000'].includes(String(value.mode))
    && (value.mode === '160000' ? value.bytes === null : Number.isSafeInteger(value.bytes) && (value.bytes as number) >= 0 && (value.bytes as number) <= 4 * 1024 * 1024);
}
export function readImportedTree(value: unknown, project: ProjectSummary): ImportedTreeResponse {
  identity(value, project);
  if (!Array.isArray(value.entries) || value.entries.length > 4096 || project.source.status !== 'IMPORTED' || value.entries.length !== project.source.fileCount
    || !value.entries.every(entry) || new Set(value.entries.map(item => item.path)).size !== value.entries.length) throw new ApiError('The imported file list could not be verified. Retry the source read.');
  return value as unknown as ImportedTreeResponse;
}
export function readImportedFile(value: unknown, project: ProjectSummary, selected: ImportedEntry): ImportedFileResponse {
  identity(value, project);
  if (!entry(value.entry) || value.entry.path !== selected.path || value.entry.mode !== selected.mode || value.entry.oid !== selected.oid || value.entry.bytes !== selected.bytes
    || !['text', 'binary', 'symlink', 'gitlink', 'too-large'].includes(String(value.representation))) throw new ApiError('The file response does not match the selected imported file.');
  const representation = value.representation;
  if (representation === 'text' || representation === 'symlink') {
    if (typeof value.text !== 'string' || new TextEncoder().encode(value.text).length > PREVIEW_BYTES || new TextEncoder().encode(value.text).length !== selected.bytes
      || (representation === 'symlink' ? selected.mode !== '120000' : !['100644', '100755'].includes(selected.mode))) throw new ApiError('The file preview is invalid or exceeds its size limit.');
  } else if (value.text !== undefined || (representation === 'gitlink') !== (selected.mode === '160000')) throw new ApiError('The file representation is invalid.');
  return value as unknown as ImportedFileResponse;
}

export function importedEntryKind(value: ImportedEntry): string {
  return value.mode === '100755' ? 'Executable file' : value.mode === '120000' ? 'Symbolic link' : value.mode === '160000' ? 'Gitlink' : 'File';
}
/** Keep unusual but valid Git names legible without turning controls into layout or direction changes. */
export function importedPathLabel(path: string): string {
  return JSON.stringify(path).slice(1, -1).replace(/[\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, value => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
export function importedFilePage(entries: ImportedEntry[], search: string, page: number, pageSize = 100) {
  const filtered = entries.filter(item => item.path.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize)), current = Math.min(Math.max(0, page), pages - 1);
  return { entries: filtered.slice(current * pageSize, (current + 1) * pageSize), count: filtered.length, page: current, pages };
}

type SourceRead = (path: string, signal: AbortSignal, headers: Record<string, string>, maximumBytes: number) => Promise<unknown>;
const sourceRead: SourceRead = (path, signal, headers, maximumBytes) => request(path, { headers }, 20_000, (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.any([signal, init!.signal!]) }), maximumBytes);

/** Download bytes must reproduce the content-addressed retained archive, including its canonical encoding. */
export async function readImportedArchive(value: unknown, project: ProjectSummary): Promise<Uint8Array> {
  if (project.source.status !== 'IMPORTED' || !record(value) || value.schemaVersion !== 1 || value.format !== 'confidence-git-archive-v1' || value.head !== project.source.head) {
    throw new ApiError('The source archive does not match this imported commit.');
  }
  const bytes = new TextEncoder().encode(canonicalProjectJson(value));
  if (bytes.length > PROJECT_IMPORT_LIMITS.archiveBytes) throw new ApiError('The source archive exceeds its size limit.');
  const digest = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('')}`;
  if (digest !== project.source.archiveDigest) throw new ApiError('The source archive digest does not match this imported snapshot.');
  return bytes;
}

/** A replaced selection or source session cannot accept a late read, even if fetch ignores cancellation. */
export function createImportedSourceReader(project: ProjectSummary, principalId: string, read: SourceRead = sourceRead) {
  const expected = structuredClone(project);
  if (!principalId) throw new Error('Refresh projects to confirm the account reading this source.');
  const headers = { 'if-platform-principal': principalId, 'if-platform-incarnation': expected.projectIncarnation };
  let generation = 0, pending: AbortController | undefined;
  const cancel = () => { generation++; pending?.abort(); pending = undefined; };
  async function load<T>(path: string, validate: (value: unknown) => T | Promise<T>, maximumBytes = IMPORTED_INVENTORY_BYTES): Promise<T | undefined> {
    cancel(); const issued = generation, controller = new AbortController(); pending = controller;
    try {
      const value = await read(path, controller.signal, headers, maximumBytes);
      if (issued !== generation) return undefined;
      const result = await validate(value); return issued === generation ? result : undefined;
    }
    catch (error) { if (issued === generation) throw error; return undefined; }
    finally { if (issued === generation) pending = undefined; }
  }
  return { cancel,
    tree: () => load(importedSourcePath(expected, 'tree'), value => readImportedTree(value, expected)),
    file: (selected: ImportedEntry) => load(importedSourcePath(expected, 'file', selected.path), value => readImportedFile(value, expected, selected)),
    archive: () => load(importedSourcePath(expected, 'archive'), value => readImportedArchive(value, expected), PROJECT_IMPORT_LIMITS.archiveBytes),
  };
}
