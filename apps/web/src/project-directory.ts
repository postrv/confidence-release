import type { ProjectDirectoryResponse, ProjectSummary } from '../../../packages/project-model/src/types';
import { ApiError, request } from './api';
import { validProjectId } from './navigation';

export interface DirectorySnapshot { data?: ProjectDirectoryResponse; loading: boolean; current: boolean; error: string }

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === 'string';
const nonempty = (value: unknown): value is string => text(value) && value.length > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function validSource(value: unknown): boolean {
  if (!record(value)) return false;
  if (value.status === 'EMPTY') return true;
  if (!text(value.head) || !/^[0-9a-f]{40}$/.test(value.head)) return false;
  if (value.status === 'ENROLLED') return nonempty(value.canonicalRepo) && nonempty(value.canonicalRef);
  return value.status === 'IMPORTED' && (value.branch === null || text(value.branch))
    && nonempty(value.archiveDigest) && nonempty(value.inventoryDigest) && nonempty(value.importedAt) && nonempty(value.importedBy)
    && count(value.objectCount) && count(value.fileCount) && count(value.sourceBytes) && value.history === 'head-tree-only' && strings(value.warnings);
}
function validCheck(value: unknown): boolean {
  return record(value) && nonempty(value.id) && nonempty(value.name) && strings(value.argv) && value.argv.length > 0
    && nonempty(value.argv[0]) && nonempty(value.cwd) && count(value.timeoutSeconds) && value.timeoutSeconds > 0
    && typeof value.required === 'boolean' && typeof value.enabled === 'boolean' && ['detected', 'manual'].includes(String(value.source))
    && value.evidenceClass === 'repository-check';
}
function validSummary(project: unknown): boolean {
  return record(project) && validProjectId(project.projectId) && validProjectId(project.projectIncarnation)
    && nonempty(project.name) && text(project.description) && text(project.revision) && /^(0|[1-9][0-9]*)$/.test(project.revision)
    && nonempty(project.createdAt) && nonempty(project.updatedAt) && ['ACTIVE', 'ARCHIVED'].includes(String(project.status))
    && strings(project.roles) && project.roles.every(role => ['admin', 'reader', 'reviewer', 'sponsor', 'export'].includes(role))
    && (project.permissions === undefined || record(project.permissions) && typeof project.permissions.manage === 'boolean')
    && Array.isArray(project.checks) && project.checks.length <= 32 && project.checks.every(validCheck)
    && new Set(project.checks.map(check => check.id)).size === project.checks.length && validSource(project.source)
    && record(project.capabilities) && typeof project.capabilities.nativeWorkflow === 'boolean'
    && typeof project.capabilities.repositoryChecks === 'boolean' && typeof project.capabilities.publication === 'boolean' && text(project.capabilities.reason)
    && (project.pendingImport === undefined || (record(project.pendingImport) && nonempty(project.pendingImport.commandId) && nonempty(project.pendingImport.principalId)));
}

export function readProjectSummary(value: unknown): ProjectSummary {
  if (!validSummary(value)) throw new ApiError('The project change response could not be verified. Recover the same command to confirm it.');
  return value as ProjectSummary;
}

export function readDirectoryResponse(value: unknown): ProjectDirectoryResponse {
  const directory = value as ProjectDirectoryResponse;
  if (!directory || directory.schemaVersion !== 1 || typeof directory.principalId !== 'string' || !directory.principalId
    || typeof directory.tenantId !== 'string' || !directory.tenantId || typeof directory.canCreate !== 'boolean'
    || !validProjectId(directory.defaultProjectId) || !count(directory.limit) || (directory.maintenance !== undefined && typeof directory.maintenance !== 'boolean') || !Array.isArray(directory.projects)
    || !directory.projects.every(validSummary)
    || directory.projects.length > 256 || new Set(directory.projects.map(project => project.projectId)).size !== directory.projects.length
    ) {
    throw new ApiError('The project directory response could not be verified. Refresh to try again.');
  }
  return directory;
}

/** Directory responses never change selected routes or recover a pending command. */
export function createProjectDirectory(read: () => Promise<unknown> = () => request('/api/projects')) {
  let snapshot: DirectorySnapshot = { loading: true, current: false, error: '' };
  let issued = 0, newest = 0, epoch = 0;
  const listeners = new Set<() => void>();
  const update = (next: DirectorySnapshot) => { snapshot = next; for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async refresh(): Promise<ProjectDirectoryResponse | undefined> {
      const sequence = ++issued, readEpoch = epoch;
      try {
        const data = readDirectoryResponse(await read());
        if (readEpoch !== epoch || sequence < newest) return snapshot.data;
        newest = sequence;
        update({ data, loading: false, current: true, error: '' });
        return data;
      } catch (error) {
        if (readEpoch !== epoch || sequence < newest) return snapshot.data;
        newest = sequence;
        const denied = error instanceof ApiError && (error.status === 401 || error.status === 403);
        if (denied) epoch++;
        update({ data: denied ? undefined : snapshot.data, loading: false, current: false,
          error: error instanceof Error ? error.message : 'The project directory is unavailable.' });
        return undefined;
      }
    },
  };
}

/** A completion may update only the view and authenticated account that requested it. */
export function observeDirectoryContext(store: { getSnapshot(): DirectorySnapshot }, route: () => string): () => boolean {
  const original = store.getSnapshot().data, originalRoute = route();
  return () => {
    const current = store.getSnapshot();
    return Boolean(original && current.current && current.data?.tenantId === original.tenantId
      && current.data.principalId === original.principalId && route() === originalRoute);
  };
}

export function projectSourceLabel(project: ProjectSummary): string {
  return project.source.status === 'ENROLLED' ? 'Release workflow' : project.source.status === 'IMPORTED' ? 'Repository imported' : 'Ready for source';
}

export function canManageProject(project: ProjectSummary): boolean { return project.permissions?.manage ?? project.roles.includes('admin'); }
