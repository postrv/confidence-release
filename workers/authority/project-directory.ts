// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from 'cloudflare:workers';
import type { CreateProjectCommand, ProjectDirectoryResponse, ProjectSummary } from '../../packages/project-model/src/types';
import { canonicalProjectJson } from '../../packages/project-model/src/json';
import { projectDigest, validateProjectDetails } from '../../packages/project-model/src/validation';
import type { Principal } from '../shared/auth';
import { errorResponse, PlatformError, requireValue } from '../shared/errors';
import type { AuthorityEnv } from './types';
import type { ProjectAuthority } from './index';
import { readDirectoryProject, readDirectoryProjects, readProjectResponse } from './project-directory-read';

const PROJECT_LIMIT = 100;
interface Creation { projectId: string; projectIncarnation: string; name: string; description: string; createdAt: string }
/** Tenant-local discovery index. Every returned item is authorized freshly by its project authority. */
export class ProjectDirectory extends DurableObject<AuthorityEnv> {
  constructor(ctx: DurableObjectState, env: AuthorityEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS directory_projects(project_id TEXT PRIMARY KEY,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS directory_commands(caller TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,result TEXT,PRIMARY KEY(caller,id));`);
    });
  }
  private caller(principal: Principal): void {
    requireValue(principal && principal.tenantId === this.env.AUTH_TENANT_ID && principal.credentialClass === 'human'
      && typeof principal.id === 'string' && principal.id.length > 0 && principal.id.length <= 512, 'PROJECT_DIRECTORY_DENIED', 403);
  }
  private project(tenantId: string, projectId: string): DurableObjectStub<ProjectAuthority> {
    return this.env.PROJECTS.getByName(`${tenantId}/${projectId}`) as DurableObjectStub<ProjectAuthority>;
  }
  async api(operation: 'list' | 'create', input: { principal: Principal; defaultProjectId?: string; command?: CreateProjectCommand }): Promise<Response> {
    try {
      const result = operation === 'list' ? await this.list(input.principal, input.defaultProjectId ?? '') : await this.create(input.principal, input.command!);
      return Response.json(result, { status: operation === 'create' ? 201 : 200, headers: { 'cache-control': 'no-store' } });
    } catch (error) { return errorResponse(error); }
  }
  async list(principal: Principal, defaultProjectId: string): Promise<ProjectDirectoryResponse> {
    this.caller(principal); requireValue(/^[a-zA-Z0-9_-]{1,128}$/.test(defaultProjectId), 'PROJECT_SCHEMA_INVALID');
    const ids = this.ctx.storage.sql.exec<{ project_id: string }>('SELECT project_id FROM directory_projects ORDER BY created_at,project_id LIMIT ?', PROJECT_LIMIT).toArray().map(row => row.project_id);
    if (!ids.includes(defaultProjectId)) ids.unshift(defaultProjectId);
    const projects = await readDirectoryProjects(ids, projectId =>
      this.project(principal.tenantId, projectId).api('catalog', { caller: { principal, projectId } }));
    return { schemaVersion: 1, principalId: principal.id, tenantId: principal.tenantId, canCreate: this.env.MAINTENANCE_MODE !== 'true' && ids.filter(id => id !== defaultProjectId).length < PROJECT_LIMIT,
      defaultProjectId, projects, limit: PROJECT_LIMIT, maintenance: this.env.MAINTENANCE_MODE === 'true' };
  }
  async create(principal: Principal, command: CreateProjectCommand): Promise<ProjectSummary> {
    this.caller(principal); requireValue(this.env.MAINTENANCE_MODE !== 'true', 'MAINTENANCE_READ_ONLY', 503);
    requireValue(command && /^[a-zA-Z0-9_-]{1,128}$/.test(command.commandId) && command.body && typeof command.body === 'object' && !Array.isArray(command.body), 'PROJECT_SCHEMA_INVALID');
    const details = validateProjectDetails(command.body), digest = projectDigest(command);
    let retained = this.ctx.storage.sql.exec<{ digest: string; payload: string; result: string | null }>('SELECT digest,payload,result FROM directory_commands WHERE caller=? AND id=?', principal.id, command.commandId).toArray()[0];
    if (retained) {
      requireValue(retained.digest === digest, 'COMMAND_ID_REUSED', 409);
      if (retained.result) {
        const previous = JSON.parse(retained.result) as ProjectSummary;
        const authorization = await readDirectoryProject(() => this.project(principal.tenantId, previous.projectId).api('catalog', { caller: { principal, projectId: previous.projectId } }));
        requireValue(authorization, 'PROJECT_UNAVAILABLE', 404); return previous;
      }
    } else {
      const creation: Creation = { projectId: `p-${crypto.randomUUID()}`, projectIncarnation: crypto.randomUUID(), ...details, createdAt: new Date().toISOString() };
      this.ctx.storage.transactionSync(() => {
        requireValue(this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM directory_projects').one().count < PROJECT_LIMIT, 'PROJECT_LIMIT_REACHED', 409);
        this.ctx.storage.sql.exec('INSERT INTO directory_projects(project_id,created_at) VALUES(?,?)', creation.projectId, creation.createdAt);
        this.ctx.storage.sql.exec('INSERT INTO directory_commands(caller,id,digest,payload) VALUES(?,?,?,?)', principal.id, command.commandId, digest, canonicalProjectJson(creation));
      }); retained = { digest, payload: canonicalProjectJson(creation), result: null };
    }
    const creation = JSON.parse(retained.payload) as Creation;
    const response = await readProjectResponse(() => this.project(principal.tenantId, creation.projectId).api('catalog-initialize', { caller: { principal, projectId: creation.projectId }, creation }));
    if (!response.ok) { const error = response.value as { error?: { code?: string } }; throw new PlatformError(error.error?.code ?? 'PROJECT_CREATION_UNAVAILABLE', response.status); }
    const summary = response.value as ProjectSummary;
    return this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.sql.exec<{ result: string | null }>('SELECT result FROM directory_commands WHERE caller=? AND id=?', principal.id, command.commandId).one();
      if (current.result) return JSON.parse(current.result) as ProjectSummary;
      this.ctx.storage.sql.exec('UPDATE directory_commands SET result=? WHERE caller=? AND id=?', canonicalProjectJson(summary), principal.id, command.commandId); return summary;
    });
  }
}
