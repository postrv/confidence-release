// SPDX-License-Identifier: Apache-2.0
import { IMPORTED_PREVIEW_BYTES, PROJECT_IMPORT_LIMITS, type ImportedSourceRequest, type ProjectMetadataCommand, type ProjectRole, type ProjectSummary } from '../../packages/project-model/src/types';
import { canonicalProjectJson } from '../../packages/project-model/src/json';
import { projectDigest, validateProjectChecks, validateRepositoryArchive, validateProjectDetails } from '../../packages/project-model/src/validation';
import { assertImportedSource, importedSourceIdentity, importedInventory, importedFile, importedSourceHeaders } from '../../packages/project-model/src/source';
import { PlatformError, requireValue } from '../shared/errors';
import { ObjectStore } from '../shared/objects';
import type { AuthorityCommand, AuthorityEnv, ProjectRecord, TrustedCaller } from './types';
import type { CollaborationProject, CollaborationStore } from './collaboration';
import type { ProjectJoinRequestsView } from '../../packages/protocol/src/collaboration';

export const PROJECT_CATALOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS project_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS metadata_commands(caller TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,result TEXT,PRIMARY KEY(caller,id));
CREATE TABLE IF NOT EXISTS metadata_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,command_id TEXT NOT NULL,operation TEXT NOT NULL,payload TEXT NOT NULL,time TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_join_requests(id TEXT PRIMARY KEY,subject TEXT NOT NULL,request_key TEXT NOT NULL,scope TEXT NOT NULL,created_at INTEGER NOT NULL,issued_at INTEGER NOT NULL,state TEXT NOT NULL,UNIQUE(subject,request_key));
CREATE TABLE IF NOT EXISTS join_request_display(id TEXT PRIMARY KEY,email TEXT NOT NULL);
`;
type Metadata = Omit<ProjectSummary, 'roles' | 'capabilities' | 'pendingImport'> & { tenantId: string; ownerPrincipalId: string };
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const exact = (body: Record<string, unknown>, keys: string[]) => requireValue(Object.keys(body).sort().join(',') === keys.sort().join(','), 'PROJECT_SCHEMA_INVALID');

/** Shares the project's membership table; the directory never grants access. */
export class ProjectCatalog {
  constructor(private readonly ctx: DurableObjectState, private readonly env: AuthorityEnv, private readonly collaboration: CollaborationStore) {}
  private row<T extends Record<string, SqlStorageValue>>(query: string, ...args: SqlStorageValue[]): T | undefined { return this.ctx.storage.sql.exec<T>(query, ...args).toArray()[0]; }
  private native(): ProjectRecord | null { const row = this.row<{ payload: string }>('SELECT payload FROM project WHERE singleton=1'); return row ? JSON.parse(row.payload) : null; }
  private metadata(): Metadata {
    const retained = this.row<{ payload: string }>('SELECT payload FROM project_metadata WHERE singleton=1'); if (retained) return JSON.parse(retained.payload);
    const project = this.native(); requireValue(project, 'PROJECT_UNAVAILABLE', 404);
    const created = this.row<{ payload: string }>('SELECT payload FROM events ORDER BY sequence LIMIT 1');
    const createdAt = created ? JSON.parse(created.payload).time : '1970-01-01T00:00:00.000Z';
    return { tenantId: project.scope.tenantId, projectId: project.scope.projectId, projectIncarnation: project.scope.projectIncarnation,
      ownerPrincipalId: '', name: project.canonicalRepo, description: '', status: 'ACTIVE', revision: '0', createdAt, updatedAt: createdAt,
      source: { status: 'ENROLLED', head: project.head, canonicalRepo: project.canonicalRepo, canonicalRef: project.canonicalRef }, checks: [] };
  }
  collaborationContext(): CollaborationProject {
    const native = this.native(); if (native) return native;
    const metadata = this.metadata();
    return { scope: { schemaVersion: 1, tenantId: metadata.tenantId, projectId: metadata.projectId, projectIncarnation: metadata.projectIncarnation }, revision: metadata.revision };
  }
  private bootstrap(): string[] { return this.native() ? JSON.parse(this.env.BOOTSTRAP_SUBJECTS || '[]') : [this.metadata().ownerPrincipalId]; }
  private roles(caller: TrustedCaller, metadata: Metadata): ProjectRole[] {
    requireValue(caller.principal.tenantId === metadata.tenantId && caller.projectId === metadata.projectId && caller.principal.tenantId === this.env.AUTH_TENANT_ID, 'PROJECT_UNAVAILABLE', 404);
    const member = this.row<{ roles: string; active: number }>('SELECT roles,active FROM memberships WHERE subject=?', caller.principal.id);
    requireValue(member?.active, 'PROJECT_UNAVAILABLE', 404); const roles = JSON.parse(member.roles) as ProjectRole[];
    const native = this.native();
    if (native) {
      requireValue(native.scope.projectIncarnation === metadata.projectIncarnation && native.scope.projectId === metadata.projectId && native.scope.tenantId === metadata.tenantId, 'PROJECT_INCAR_CHANGED', 409);
      this.collaboration.assertCaller(caller, native.scope, Math.floor(Date.now() / 1000));
    }
    const context = this.collaborationContext(), enabled = this.collaboration.enabled(context.scope);
    if (enabled) this.collaboration.assertCaller(caller, context.scope, Math.floor(Date.now() / 1000));
    requireValue(roles.includes('reader') || !enabled && roles.includes('admin'), 'PROJECT_UNAVAILABLE', 404); return roles;
  }
  private admin(caller: TrustedCaller, metadata: Metadata): void {
    const roles = this.roles(caller, metadata), context = this.collaborationContext();
    if (this.collaboration.enabled(context.scope)) this.collaboration.requireOwner(caller, context.scope, Math.floor(Date.now() / 1000));
    else requireValue(roles.includes('admin') && caller.principal.credentialClass === 'human', 'HUMAN_ADMIN_REQUIRED', 403);
    requireValue(this.env.MAINTENANCE_MODE !== 'true', 'MAINTENANCE_READ_ONLY', 503);
  }
  summary(caller: TrustedCaller): ProjectSummary {
    const metadata = this.metadata(), roles = this.roles(caller, metadata), native = this.native();
    const { tenantId: _tenant, ownerPrincipalId: _owner, ...result } = metadata;
    const context = this.collaborationContext();
    const manage = this.collaboration.enabled(context.scope) ? this.collaboration.canManage(caller, context.scope, Math.floor(Date.now() / 1000)) : caller.principal.credentialClass === 'human' && roles.includes('admin');
    const pending = manage ? this.row<{ caller: string; id: string }>("SELECT caller,id FROM metadata_commands WHERE state='PENDING' LIMIT 1") : undefined;
    if (native) result.source = { status: 'ENROLLED', head: native.head, canonicalRepo: native.canonicalRepo, canonicalRef: native.canonicalRef };
    return { ...result, roles, permissions: { manage }, ...(pending ? { pendingImport: { commandId: pending.id, principalId: pending.caller } } : {}), capabilities: { nativeWorkflow: Boolean(native), repositoryChecks: false, publication: Boolean(native),
      reason: native ? 'Existing enrolled workflow and its registered protected checks apply.' : 'Imported repository checks are configured independently. Managed execution and protected publication are not registered for this repository.' } };
  }
  collaborationView(caller: TrustedCaller) {
    this.roles(caller, this.metadata());
    return this.collaboration.view(caller, this.collaborationContext(), this.bootstrap(), Math.floor(Date.now() / 1000));
  }
  hubContext(caller: TrustedCaller, permission: 'read' | 'edit' | 'connect' | 'owner') {
    this.roles(caller, this.metadata()); requireValue(!this.isArchived(), 'PROJECT_ARCHIVED', 409);
    if (permission !== 'read') requireValue(this.env.MAINTENANCE_MODE !== 'true', 'MAINTENANCE_READ_ONLY', 503);
    return this.collaboration.hubMember(caller, this.collaborationContext(), permission, Math.floor(Date.now() / 1000));
  }
  hubDelegatedContext(parent: Parameters<CollaborationStore['hubDelegatedMember']>[0], permission: 'read' | 'edit') {
    requireValue(!this.isArchived(), 'PROJECT_ARCHIVED', 409);
    if (permission !== 'read') requireValue(this.env.MAINTENANCE_MODE !== 'true', 'MAINTENANCE_READ_ONLY', 503);
    return this.collaboration.hubDelegatedMember(parent, this.collaborationContext(), permission);
  }
  joinRequests(caller: TrustedCaller): ProjectJoinRequestsView {
    const metadata = this.metadata(), project = this.collaborationContext();
    requireValue(metadata.tenantId === this.env.AUTH_TENANT_ID, 'PROJECT_UNAVAILABLE', 404);
    const result = this.collaboration.joinRequests(caller, project, Math.floor(Date.now() / 1000));
    return { schemaVersion: 1, scope: project.scope, revision: project.revision, projectName: metadata.name,
      projectStatus: metadata.status, ...result, canRequest: result.canRequest && metadata.status === 'ACTIVE' && this.env.MAINTENANCE_MODE !== 'true' };
  }
  requestJoin(caller: TrustedCaller, request: Parameters<CollaborationStore['requestJoin']>[2]) {
    requireValue(this.env.MAINTENANCE_MODE !== 'true', 'MAINTENANCE_READ_ONLY', 503);
    return this.ctx.storage.transactionSync(() => {
      requireValue(!this.isArchived(), 'PROJECT_ARCHIVED', 409);
      return this.collaboration.requestJoin(caller, this.collaborationContext(), request, Math.floor(Date.now() / 1000));
    });
  }
  inspectInvitation(caller: TrustedCaller, command: AuthorityCommand) {
    requireValue(!this.isArchived(), 'PROJECT_ARCHIVED', 409);
    const project = this.collaborationContext(), currentTime = Math.floor(Date.now() / 1000);
    this.ctx.storage.transactionSync(() => this.collaboration.recordAcceptanceAttempt(caller, project.scope, currentTime, false));
    return this.collaboration.inspectInvitation(caller, project, command, currentTime);
  }
  draftCollaborationCommand(caller: TrustedCaller, command: AuthorityCommand): unknown {
    requireValue(this.isDraft(), 'PROJECT_UNAVAILABLE', 404);
    requireValue(validId(command.commandId) && typeof command.expectedRevision === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(command.expectedRevision)
      && command.body && typeof command.body === 'object' && !Array.isArray(command.body), 'SCHEMA_ERROR');
    requireValue(this.env.MAINTENANCE_MODE !== 'true', 'MAINTENANCE_READ_ONLY', 503);
    const project = this.collaborationContext(); requireValue(command.expectedIncarnation === project.scope.projectIncarnation, 'PROJECT_INCAR_CHANGED', 409);
    requireValue(!this.isArchived(), 'PROJECT_ARCHIVED', 409);
    const currentTime = Math.floor(Date.now() / 1000), requestDigest = projectDigest(command);
    if (command.operation === 'accept-invitation') this.ctx.storage.transactionSync(() => this.collaboration.recordAcceptanceAttempt(caller, project.scope, currentTime));
    try { return this.ctx.storage.transactionSync(() => {
      const metadata = this.metadata(), context = this.collaborationContext();
      const prior = this.row<{ digest: string; state: string; result: string }>('SELECT digest,state,result FROM commands WHERE caller=? AND id=?', caller.principal.id, command.commandId);
      if (prior) {
        this.roles(caller, metadata);
        if (command.operation !== 'accept-invitation') this.collaboration.requireOwner(caller, context.scope, currentTime);
        requireValue(prior.digest === requestDigest, 'COMMAND_ID_REUSED', 409);
        const result = JSON.parse(prior.result); if (prior.state === 'REJECTED') throw new PlatformError(result.code, result.status); return result;
      }
      if (command.operation === 'accept-invitation') requireValue(command.expectedRevision === '0', 'INVITATION_REVISION_INVALID', 409);
      else { this.roles(caller, metadata); requireValue(metadata.revision === command.expectedRevision, 'STALE_STATE', 409); }
      const result = this.collaboration.apply(caller, context, command, this.bootstrap(), currentTime);
      metadata.revision = (BigInt(metadata.revision) + 1n).toString(); metadata.updatedAt = new Date().toISOString();
      this.ctx.storage.sql.exec('UPDATE project_metadata SET payload=? WHERE singleton=1', canonicalProjectJson(metadata));
      this.ctx.storage.sql.exec("INSERT INTO commands(caller,id,digest,operation,state,result) VALUES(?,?,?,?,'COMMITTED',?)", caller.principal.id, command.commandId, requestDigest, command.operation, canonicalProjectJson(result));
      const event = { id: crypto.randomUUID(), scope: context.scope, kind: command.operation, objectId: command.commandId, payload: result, time: metadata.updatedAt };
      this.ctx.storage.sql.exec('INSERT INTO events(id,digest,payload) VALUES(?,?,?)', event.id, projectDigest(event), canonicalProjectJson(event));
      return result;
    }); } catch (error) {
      if (error instanceof PlatformError && error.status >= 400 && error.status < 500 && error.code !== 'PROJECT_INCAR_CHANGED') {
        // Keep terminal rejection identity just as the native authority does.
        // Only a currently authorized member may retain a command tombstone.
        this.ctx.storage.transactionSync(() => {
          const metadata = this.metadata(), context = this.collaborationContext();
          try { this.roles(caller, metadata); } catch { throw error; }
          const prior = this.row<{ digest: string }>('SELECT digest FROM commands WHERE caller=? AND id=?', caller.principal.id, command.commandId);
          if (prior) { requireValue(prior.digest === requestDigest, 'COMMAND_ID_REUSED', 409); return; }
          this.ctx.storage.sql.exec("INSERT INTO commands(caller,id,digest,operation,state,result) VALUES(?,?,?,?,'REJECTED',?)", caller.principal.id, command.commandId, requestDigest, command.operation,
            canonicalProjectJson({ code: error.code, status: error.status, message: error.message }));
          const event = { id: crypto.randomUUID(), scope: context.scope, kind: 'command-rejected', objectId: command.commandId,
            payload: { operation: command.operation, code: error.code, requestDigest }, time: new Date().toISOString() };
          this.ctx.storage.sql.exec('INSERT INTO events(id,digest,payload) VALUES(?,?,?)', event.id, projectDigest(event), canonicalProjectJson(event));
        });
      }
      throw error;
    }
  }
  async readSource(caller: TrustedCaller, request: ImportedSourceRequest): Promise<Response> {
    requireValue(caller.principal.credentialClass === 'human', 'HUMAN_REQUIRED', 403);
    const project = this.summary(caller), source = assertImportedSource(project, request);
    const store = new ObjectStore(this.env.OBJECTS), identity = importedSourceIdentity(project, source);
    const authorized = () => assertImportedSource(this.summary(caller), request);
    const headers = importedSourceHeaders();
    if (request.view === 'archive') {
      const bytes = await store.get(source.archiveDigest, PROJECT_IMPORT_LIMITS.archiveBytes);
      authorized();
      return new Response(bytes.slice().buffer, { headers: { ...headers, 'content-type': 'application/json',
        'content-disposition': `attachment; filename="confidence-source-${source.head}.json"` } });
    }
    const retained = await store.get(source.inventoryDigest, PROJECT_IMPORT_LIMITS.inventoryBytes);
    authorized();
    const entries = importedInventory(retained, source);
    if (request.view === 'tree') return Response.json({ ...identity, entries }, { headers });
    const entry = entries.find(item => item.path === request.path);
    requireValue(entry, 'PROJECT_SOURCE_PATH_NOT_FOUND', 404);
    let archive: Uint8Array | undefined;
    if (entry.mode !== '160000' && entry.bytes! <= IMPORTED_PREVIEW_BYTES) {
      archive = await store.get(source.archiveDigest, PROJECT_IMPORT_LIMITS.archiveBytes);
      authorized();
    }
    return Response.json(importedFile(identity, entry, archive), { headers });
  }
  initialize(caller: TrustedCaller, input: { projectIncarnation: string; name: string; description: string; createdAt: string }): ProjectSummary {
    requireValue(this.env.MAINTENANCE_MODE !== 'true' && caller.principal.credentialClass === 'human' && caller.principal.tenantId === this.env.AUTH_TENANT_ID, 'PROJECT_CREATION_DENIED', 403);
    requireValue(validId(caller.projectId) && validId(input.projectIncarnation) && Number.isFinite(Date.parse(input.createdAt)), 'PROJECT_SCHEMA_INVALID');
    const details = validateProjectDetails({ name: input.name, description: input.description });
    this.ctx.storage.transactionSync(() => {
      const row = this.row<{ payload: string }>('SELECT payload FROM project_metadata WHERE singleton=1');
      if (row) { const existing = JSON.parse(row.payload) as Metadata; requireValue(existing.projectIncarnation === input.projectIncarnation && existing.ownerPrincipalId === caller.principal.id && existing.tenantId === caller.principal.tenantId && existing.projectId === caller.projectId, 'PROJECT_CREATION_CONFLICT', 409); return; }
      requireValue(!this.native(), 'ALREADY_ENROLLED', 409);
      const metadata: Metadata = { tenantId: caller.principal.tenantId, projectId: caller.projectId, projectIncarnation: input.projectIncarnation,
        ownerPrincipalId: caller.principal.id, ...details, status: 'ACTIVE', revision: '1', createdAt: input.createdAt, updatedAt: input.createdAt, source: { status: 'EMPTY' }, checks: [] };
      this.ctx.storage.sql.exec('INSERT INTO project_metadata(singleton,payload) VALUES(1,?)', canonicalProjectJson(metadata));
      this.ctx.storage.sql.exec('INSERT INTO memberships(subject,roles,active) VALUES(?,?,1)', caller.principal.id, canonicalProjectJson(['admin', 'export', 'reader', 'reviewer', 'sponsor']));
    }); return this.summary(caller);
  }
  isArchived(): boolean { const row = this.row<{ payload: string }>('SELECT payload FROM project_metadata WHERE singleton=1'); return Boolean(row && JSON.parse(row.payload).status === 'ARCHIVED'); }
  isDraft(): boolean { return !this.native() && Boolean(this.row('SELECT singleton FROM project_metadata WHERE singleton=1')); }
  private quiescent(): void {
    const project = this.native(); if (!project) return;
    requireValue(project.gate === 'CLOSED' && project.unresolvedPublicationId === null && project.reservedBudget === '0'
      && !this.row('SELECT id FROM grants WHERE revoked=0 AND expires_at>? LIMIT 1', Math.floor(Date.now() / 1000))
      && !this.row("SELECT id FROM outbox WHERE state='PENDING' LIMIT 1")
      && !this.row("SELECT id FROM cleanups WHERE phase!='TOMBSTONED' LIMIT 1"), 'PROJECT_ACTIVITY_PENDING', 409);
  }
  async command(caller: TrustedCaller, command: ProjectMetadataCommand): Promise<ProjectSummary> {
    requireValue(validId(command.commandId) && typeof command.expectedRevision === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(command.expectedRevision)
      && validId(command.expectedIncarnation) && ['update', 'archive', 'restore', 'checks', 'import', 'cancel-import'].includes(command.operation)
      && command.body && typeof command.body === 'object' && !Array.isArray(command.body), 'PROJECT_SCHEMA_INVALID');
    const metadata = this.metadata(); this.admin(caller, metadata);
    requireValue(command.expectedIncarnation === metadata.projectIncarnation, 'PROJECT_INCAR_CHANGED', 409);
    const requestDigest = projectDigest(command);
    const prior = this.row<{ digest: string; state: string; result: string | null }>('SELECT digest,state,result FROM metadata_commands WHERE caller=? AND id=?', caller.principal.id, command.commandId);
    if (prior) { requireValue(prior.digest === requestDigest, 'COMMAND_ID_REUSED', 409); if (prior.state === 'COMPLETE') return JSON.parse(prior.result!); requireValue(prior.state === 'PENDING', 'COMMAND_CANCELLED', 409); }
    requireValue(metadata.revision === command.expectedRevision, 'STALE_STATE', 409);
    const pending = this.row<{ caller: string; id: string }>("SELECT caller,id FROM metadata_commands WHERE state='PENDING' LIMIT 1");
    requireValue(!pending || pending.caller === caller.principal.id && pending.id === command.commandId || command.operation === 'cancel-import', 'PROJECT_IMPORT_PENDING', 409);
    requireValue(metadata.status === 'ACTIVE' || command.operation === 'restore', 'PROJECT_ARCHIVED', 409);
    if (command.operation === 'update') Object.assign(metadata, validateProjectDetails(command.body));
    if (command.operation === 'archive') { exact(command.body, []); this.quiescent(); metadata.status = 'ARCHIVED'; }
    if (command.operation === 'restore') { exact(command.body, []); requireValue(metadata.status === 'ARCHIVED', 'PROJECT_NOT_ARCHIVED', 409); metadata.status = 'ACTIVE'; }
    if (command.operation === 'checks') { exact(command.body, ['checks']); metadata.checks = validateProjectChecks(command.body.checks); }
    if (command.operation === 'cancel-import') {
      exact(command.body, ['commandId', 'principalId', 'reason']);
      requireValue(typeof command.body.reason === 'string' && command.body.reason.trim().length > 0 && command.body.reason.length <= 512, 'PROJECT_CANCELLATION_REASON_REQUIRED');
      requireValue(pending && pending.id === command.body.commandId && pending.caller === command.body.principalId, 'PROJECT_PENDING_IMPORT_CHANGED', 409);
    }
    if (command.operation === 'import') {
      exact(command.body, ['archive']); requireValue(metadata.source.status === 'EMPTY' && !this.native(), 'PROJECT_SOURCE_ALREADY_IMPORTED', 409);
      const imported = validateRepositoryArchive(command.body.archive);
      // Record fixed identity before R2 effects; retries may repeat only these content-addressed writes.
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO metadata_commands(caller,id,digest,state) VALUES(?,?,?,'PENDING')", caller.principal.id, command.commandId, requestDigest);
      const store = new ObjectStore(this.env.OBJECTS);
      await store.put(new TextEncoder().encode(canonicalProjectJson(imported.archive)), imported.digest);
      const inventory = { head: imported.archive.head, entries: imported.entries }; const inventoryDigest = projectDigest(inventory); await store.put(new TextEncoder().encode(canonicalProjectJson(inventory)), inventoryDigest);
      const current = this.metadata(); this.admin(caller, current);
      const completed = this.row<{ result: string | null }>("SELECT result FROM metadata_commands WHERE caller=? AND id=? AND state='COMPLETE'", caller.principal.id, command.commandId);
      if (completed?.result) return JSON.parse(completed.result);
      requireValue(current.revision === command.expectedRevision && current.status === 'ACTIVE' && current.projectIncarnation === command.expectedIncarnation, 'STALE_STATE', 409);
      metadata.source = { status: 'IMPORTED', head: imported.archive.head, branch: imported.archive.branch, archiveDigest: imported.digest, inventoryDigest,
        importedAt: new Date().toISOString(), importedBy: caller.principal.id, objectCount: imported.archive.objects.length,
        fileCount: imported.entries.length, sourceBytes: imported.objectBytes, history: 'head-tree-only', warnings: imported.warnings };
      // Saved configuration belongs to the project; suggestions initialize only an empty list.
      if (metadata.checks.length === 0) metadata.checks = imported.archive.checks;
    }
    metadata.revision = (BigInt(metadata.revision) + 1n).toString(); metadata.updatedAt = new Date().toISOString();
    return this.ctx.storage.transactionSync(() => {
      const current = this.metadata(); this.admin(caller, current); requireValue(current.revision === command.expectedRevision, 'STALE_STATE', 409);
      if (command.operation === 'cancel-import') this.ctx.storage.sql.exec("UPDATE metadata_commands SET state='CANCELLED',result=? WHERE caller=? AND id=? AND state='PENDING'", canonicalProjectJson({ code: 'COMMAND_CANCELLED', cancelledBy: caller.principal.id, reason: command.body.reason }), String(command.body.principalId), String(command.body.commandId));
      this.ctx.storage.sql.exec('INSERT INTO project_metadata(singleton,payload) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload', canonicalProjectJson(metadata));
      // Complete this import in the same SQLite transaction before deriving its response.
      this.ctx.storage.sql.exec("UPDATE metadata_commands SET state='COMPLETE' WHERE caller=? AND id=? AND state='PENDING'", caller.principal.id, command.commandId);
      const result = this.summary(caller);
      this.ctx.storage.sql.exec("INSERT INTO metadata_commands(caller,id,digest,state,result) VALUES(?,?,?,'COMPLETE',?) ON CONFLICT(caller,id) DO UPDATE SET state='COMPLETE',result=excluded.result", caller.principal.id, command.commandId, requestDigest, canonicalProjectJson(result));
      this.ctx.storage.sql.exec('INSERT INTO metadata_events(actor,command_id,operation,payload,time) VALUES(?,?,?,?,?)', caller.principal.id, command.commandId, command.operation, canonicalProjectJson({ revision: metadata.revision, requestDigest, ...(metadata.source.status === 'IMPORTED' ? { archiveDigest: metadata.source.archiveDigest } : {}) }), metadata.updatedAt);
      return result;
    });
  }
}
