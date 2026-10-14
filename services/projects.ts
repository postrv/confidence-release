// SPDX-License-Identifier: Apache-2.0
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalProjectJson } from '../packages/project-model/src/json.ts';
import { projectDigest, validateProjectChecks, validateRepositoryArchive, validateProjectDetails } from '../packages/project-model/src/validation.ts';
import { IMPORTED_PREVIEW_BYTES, PROJECT_IMPORT_LIMITS, type ImportedSourceRequest, type CreateProjectCommand, ImportedSource, ProjectDirectoryResponse, ProjectMetadataCommand, ProjectSummary } from '../packages/project-model/src/types.ts';
import { assertImportedSource, importedSourceIdentity, importedInventory, importedFile, importedSourceHeaders } from '../packages/project-model/src/source.ts';
import { PlatformError, requireValue } from '../workers/shared/errors.ts';
import type { LocalPlatform } from './platform.ts';

const principalId = 'local-pilot';
const limit = 100;
interface Catalog {
  schemaVersion: 1;
  projects: Record<string, ProjectSummary>;
  commands: Record<string, { digest: string; result: ProjectSummary }>;
}
const exact = (body: Record<string, unknown>, fields: string[]) => requireValue(Object.keys(body).sort().join(',') === [...fields].sort().join(','), 'PROJECT_SCHEMA_INVALID');
const unavailable = (source: 'EMPTY' | 'IMPORTED') => ({ nativeWorkflow: false, repositoryChecks: false, publication: false,
  reason: source === 'EMPTY' ? 'Import a committed repository to retain its source and configure checks.' : 'Repository source and check definitions are retained. Checks have not run; protected review and publication are not enrolled.' });

/** Loopback single-operator adapter. New projects never initialize the demonstration fixture. */
export class LocalProjects {
  private catalog!: Catalog;
  private tail: Promise<void> = Promise.resolve();
  private readonly directory: string;
  constructor(private readonly platform: LocalPlatform) { this.directory = join(platform.directory, 'project-directory'); }

  private async write(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + '.' + randomUUID() + '.tmp';
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(canonicalProjectJson(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const parent = await open(dirname(path), 'r'); try { await parent.sync(); } finally { await parent.close(); }
  }
  async initialize(): Promise<void> {
    try { this.catalog = JSON.parse(await readFile(join(this.directory, 'catalog.json'), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const timestamp = new Date().toISOString();
      const legacy: ProjectSummary = { projectId: this.platform.state.projectId, projectIncarnation: this.platform.state.projectIncarnation,
        name: 'Cache collaboration', description: 'The original verified collaboration demonstration.', status: 'ACTIVE', revision: '0',
        createdAt: timestamp, updatedAt: timestamp, roles: ['admin', 'export', 'reader', 'reviewer', 'sponsor'], checks: [],
        source: { status: 'ENROLLED', head: this.platform.state.acceptedHead, canonicalRepo: 'local/collaboration-demo', canonicalRef: 'refs/heads/main' },
        capabilities: { nativeWorkflow: true, repositoryChecks: false, publication: true, reason: 'Local demonstration workflow; observed evidence is shown in the project.' } };
      this.catalog = { schemaVersion: 1, projects: { [legacy.projectId]: legacy }, commands: {} };
      await this.write(join(this.directory, 'catalog.json'), this.catalog);
    }
    requireValue(this.catalog.schemaVersion === 1 && this.catalog.projects && this.catalog.commands, 'PROJECT_CATALOG_INVALID', 503);
  }
  private fresh(summary: ProjectSummary): ProjectSummary {
    const result = structuredClone(summary);
    if (result.projectId === this.platform.state.projectId && result.source.status === 'ENROLLED') result.source.head = this.platform.state.acceptedHead;
    return result;
  }
  get(projectId: string): ProjectSummary {
    const project = Object.hasOwn(this.catalog.projects, projectId) ? this.catalog.projects[projectId] : undefined; requireValue(project, 'PROJECT_UNAVAILABLE', 404);
    return this.fresh(project);
  }
  async readSource(projectId: string, request: ImportedSourceRequest): Promise<Response> {
    const project = this.get(projectId), source = assertImportedSource(project, request), identity = importedSourceIdentity(project, source);
    const read = async (kind: 'archives' | 'inventories', digest: string, maximum: number): Promise<Uint8Array> => {
      const file = await open(join(this.directory, kind, digest.slice(7) + '.json'), 'r');
      try {
        requireValue((await file.stat()).size <= maximum, 'SIZE_LIMIT', 413);
        const bytes = await file.readFile();
        requireValue(bytes.length <= maximum && 'sha256:' + createHash('sha256').update(bytes).digest('hex') === digest, 'OBJECT_DIGEST_MISMATCH', 409);
        assertImportedSource(this.get(projectId), request); return bytes;
      } finally { await file.close(); }
    };
    const headers = importedSourceHeaders();
    if (request.view === 'archive') return new Response((await read('archives', source.archiveDigest, PROJECT_IMPORT_LIMITS.archiveBytes)).slice().buffer, {
      headers: { ...headers, 'content-type': 'application/json', 'content-disposition': `attachment; filename="confidence-source-${source.head}.json"` } });
    const entries = importedInventory(await read('inventories', source.inventoryDigest, PROJECT_IMPORT_LIMITS.inventoryBytes), source);
    if (request.view === 'tree') return Response.json({ ...identity, entries }, { headers });
    const entry = entries.find(item => item.path === request.path); requireValue(entry, 'PROJECT_SOURCE_PATH_NOT_FOUND', 404);
    const archive = entry.mode !== '160000' && entry.bytes! <= IMPORTED_PREVIEW_BYTES ? await read('archives', source.archiveDigest, PROJECT_IMPORT_LIMITS.archiveBytes) : undefined;
    return Response.json(importedFile(identity, entry, archive), { headers });
  }
  list(): ProjectDirectoryResponse {
    return { schemaVersion: 1, principalId, tenantId: 'local-tenant', canCreate: Object.keys(this.catalog.projects).filter(id => id !== this.platform.state.projectId).length < limit, maintenance: false, defaultProjectId: this.platform.state.projectId,
      projects: Object.values(this.catalog.projects).map(project => this.fresh(project)).sort((a, b) => a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId)), limit };
  }
  assertNative(projectId: string, mutation: boolean): void {
    const project = this.get(projectId);
    requireValue(project.capabilities.nativeWorkflow && projectId === this.platform.state.projectId, 'NATIVE_WORKFLOW_UNAVAILABLE', 409);
    if (mutation) requireValue(project.status === 'ACTIVE', 'PROJECT_ARCHIVED', 409);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn); this.tail = next.then(() => {}, () => {}); return next;
  }
  private previous(commandId: string, digest: string, scope = 'directory'): ProjectSummary | undefined {
    requireValue(/^[a-zA-Z0-9_-]{1,128}$/.test(commandId), 'IDEMPOTENCY_KEY_REQUIRED');
    const key = `${scope}:${commandId}`;
    const previous = Object.hasOwn(this.catalog.commands, key) ? this.catalog.commands[key] : undefined;
    requireValue(!previous || previous.digest === digest, 'COMMAND_ID_REUSED', 409);
    return previous ? structuredClone(previous.result) : undefined;
  }
  private async commit(commandId: string, digest: string, project: ProjectSummary, scope = 'directory'): Promise<ProjectSummary> {
    const next = structuredClone(this.catalog);
    next.projects[project.projectId] = project; next.commands[`${scope}:${commandId}`] = { digest, result: project };
    await this.write(join(this.directory, 'catalog.json'), next); this.catalog = next;
    return structuredClone(project);
  }
  create(command: CreateProjectCommand): Promise<ProjectSummary> {
    return this.serial(async () => {
      const digest = projectDigest({ principalId, operation: 'create', ...command });
      const previous = this.previous(command.commandId, digest); if (previous) return previous;
      requireValue(Object.keys(this.catalog.projects).filter(id => id !== this.platform.state.projectId).length < limit, 'PROJECT_LIMIT_REACHED', 409);
      requireValue(command.body && Object.keys(command.body).every(key => ['name', 'description'].includes(key)), 'PROJECT_SCHEMA_INVALID');
      const { name, description } = validateProjectDetails(command.body);
      const timestamp = new Date().toISOString(), projectId = `project-${randomUUID()}`;
      return this.commit(command.commandId, digest, { projectId, projectIncarnation: randomUUID(), name, description, status: 'ACTIVE', revision: '1', createdAt: timestamp, updatedAt: timestamp,
        roles: ['admin', 'export', 'reader', 'reviewer', 'sponsor'], source: { status: 'EMPTY' }, checks: [], capabilities: unavailable('EMPTY') });
    });
  }
  command(projectId: string, command: ProjectMetadataCommand): Promise<ProjectSummary> {
    return this.serial(async () => {
      const digest = projectDigest({ principalId, projectId, ...command });
      const previous = this.previous(command.commandId, digest, projectId); if (previous) return previous;
      const current = this.get(projectId);
      requireValue(command.expectedIncarnation === current.projectIncarnation, 'PROJECT_INCAR_CHANGED', 409);
      requireValue(command.expectedRevision === current.revision, 'STALE_STATE', 409);
      requireValue(command.body && typeof command.body === 'object' && !Array.isArray(command.body), 'PROJECT_OBJECT_REQUIRED');
      const next = structuredClone(current);
      if (command.operation !== 'restore') requireValue(current.status === 'ACTIVE', 'PROJECT_ARCHIVED', 409);
      if (command.operation === 'update') {
        Object.assign(next, validateProjectDetails(command.body));
      } else if (command.operation === 'archive' || command.operation === 'restore') {
        exact(command.body, []);
        if (command.operation === 'archive' && current.capabilities.nativeWorkflow) {
          requireValue((this.platform.state.admission === undefined || this.platform.state.admission.gate === 'CLOSED')
            && (this.platform.state.projectBudget === undefined || this.platform.state.projectBudget.reservedUnits === '0')
            && this.platform.state.demoStatus !== 'RUNNING' && !this.platform.state.attempts.some(item => ['RUNNING', 'PROVISIONING', 'INFRASTRUCTURE_UNKNOWN'].includes(item.status))
            && !this.platform.state.evaluations.some(item => ['RUNNING', 'INFRASTRUCTURE_UNKNOWN'].includes(item.status))
            && !this.platform.state.publications.some(item => !['FINALIZED', 'REJECTED'].includes(item.status)), 'PROJECT_WORK_IN_FLIGHT', 409);
        }
        if (command.operation === 'restore') requireValue(current.status === 'ARCHIVED', 'PROJECT_NOT_ARCHIVED', 409);
        next.status = command.operation === 'archive' ? 'ARCHIVED' : 'ACTIVE';
      } else if (command.operation === 'checks') {
        exact(command.body, ['checks']); next.checks = structuredClone(validateProjectChecks(command.body.checks));
      } else if (command.operation === 'import') {
        exact(command.body, ['archive']); requireValue(current.source.status === 'EMPTY', 'PROJECT_SOURCE_ALREADY_SET', 409);
        const imported = validateRepositoryArchive(command.body.archive);
        await this.write(join(this.directory, 'archives', imported.digest.slice(7) + '.json'), imported.archive);
        const inventory = { head: imported.archive.head, entries: imported.entries };
        await this.write(join(this.directory, 'inventories', projectDigest(inventory).slice(7) + '.json'), inventory);
        const source: ImportedSource = { status: 'IMPORTED', head: imported.archive.head, branch: imported.archive.branch, archiveDigest: imported.digest, inventoryDigest: projectDigest({ head: imported.archive.head, entries: imported.entries }),
          importedAt: new Date().toISOString(), importedBy: principalId, objectCount: imported.archive.objects.length, fileCount: imported.entries.length,
          sourceBytes: imported.objectBytes, history: 'head-tree-only', warnings: imported.warnings };
        next.source = source;
        // Match the Durable Object: an import never replaces saved project checks.
        if (next.checks.length === 0) next.checks = structuredClone(imported.archive.checks);
        next.capabilities = unavailable('IMPORTED');
      } else if (command.operation === 'cancel-import') throw new PlatformError('PROJECT_IMPORT_NOT_PENDING', 409);
      else throw new PlatformError('UNSUPPORTED_ROUTE', 404);
      next.revision = String(BigInt(current.revision) + 1n); next.updatedAt = new Date().toISOString();
      return this.commit(command.commandId, digest, next, projectId);
    });
  }
}
