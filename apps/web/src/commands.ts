import type { PlatformState } from '../../../services/types';
import type { ProjectDirectoryResponse, ProjectMetadataCommand, ProjectSummary } from '../../../packages/project-model/src/types';
import { ApiError, projectApiPath, request } from './api';
import { currentFinalChecksDecision, finalChecksRetryDecision, repairBudgetIncrease } from './presentation';
import { canManageProject, readProjectSummary } from './project-directory';

export interface PendingCommand {
  schemaVersion: 1;
  id: string;
  label: string;
  scope: string;
  path: string;
  body: string;
  headers: Record<string, string>;
  status: 'SENDING' | 'UNKNOWN' | 'REJECTED';
  detail: string;
  kind?: 'metadata';
}
export const commandScope = (state: PlatformState): string => JSON.stringify([state.tenantId, state.projectId, state.projectIncarnation, state.session?.principalId ?? 'local-pilot']);

/** Resolve semantic intent exactly once, before any network activity. */
export function freezeCommand(state: PlatformState, label: string, path: string, input: Record<string, unknown>, id: string = crypto.randomUUID(), scoped = false): PendingCommand {
  let body = structuredClone(input);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Idempotency-Key': id, 'X-Platform-CSRF': '1', 'If-Platform-Revision': String(state.revision) };
  if (state.capabilities.deployment) {
    if (!state.session?.principalId) throw new Error('Refresh to obtain the authenticated command context.');
    if (state.capabilities.maintenance) throw new Error('Maintenance mode is read-only. Refresh after the active release has been verified.');
    headers['If-Platform-Principal'] = state.session.principalId;
    headers['If-Platform-Incarnation'] = state.projectIncarnation;
    let operation: string;
    if (path === '/api/demo') { operation = 'launch-cohort'; body = { mode: input.mode }; }
    else if (path === '/api/select') {
      if (!Array.isArray(input.attemptIds) || !input.attemptIds.length || input.attemptIds.length > 4) throw new Error('Select one to four submitted contributions.');
      const submissionIds = input.attemptIds.map(id => state.attempts.find(attempt => attempt.id === id)?.submissionId);
      if (submissionIds.some(id => !id)) throw new Error('Every selected contribution needs an accepted immutable submission.');
      operation = 'materialize'; body = { submissionIds: submissionIds.sort(), evaluate: true };
    } else if (path === '/api/weft/submit') {
      if (state.session.permissions?.sponsor === false) throw new Error('Your project role does not allow release submissions.');
      if (input.schemaVersion !== 1 || typeof input.bindingId !== 'string' || !input.bindingId || typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 0
        || typeof input.root !== 'string' || !/^[a-f0-9]{64}$/.test(input.root) || typeof input.privacyGeneration !== 'number' || !Number.isSafeInteger(input.privacyGeneration) || input.privacyGeneration < 1
        || typeof input.expectedBase !== 'string' || !/^[a-f0-9]{40}$/.test(input.expectedBase)) throw new Error('Select an exact retained Weft revision before submitting it.');
      if (input.expectedBase !== state.acceptedHead) throw new Error('The release base changed. Select a workspace based on the current source.');
      operation = 'submit-weft-revision';
    } else if (path === '/api/repair') {
      const conflict = state.conflicts.find(conflict => conflict.id === input.conflictId);
      if (!conflict?.candidateId) throw new Error('The selected conflict has no repairable candidate.');
      operation = 'start-repair'; body = { candidateId: conflict.candidateId };
    } else if (path === '/api/evaluate') {
      const candidate = state.candidates.find(candidate => candidate.id === input.candidateId);
      const decision = candidate?.reviewEvaluationId ? finalChecksRetryDecision(state, candidate) : currentFinalChecksDecision(state, candidate);
      if (!decision.allowed || !candidate) throw new Error(decision.reason);
      operation = 'request-evaluation'; body = { candidateId: candidate.id };
    } else if (path === '/api/review') {
      const candidate = state.candidates.find(candidate => candidate.id === input.candidateId);
      if (!candidate?.reviewEvaluationId) throw new Error('Refresh after an eligible full evaluation has been recorded.');
      operation = 'prepare-review'; body = { candidateId: candidate.id, evaluationId: candidate.reviewEvaluationId };
    } else if (path === '/api/approve' || path === '/api/publish') {
      const review = state.reviews.find(review => review.proposalDigest === input.proposalDigest);
      if (!review) throw new Error('The exact review is no longer in this snapshot. Refresh before choosing a new action.');
      if (input.simulateLostResponse === true) throw new Error('Controlled response loss is only available in the local demonstration.');
      operation = path === '/api/approve' ? 'approve-review' : 'request-publication'; body = { reviewId: review.id, proposalDigest: review.proposalDigest };
    } else if (path === '/api/reconcile') {
      const publication = input.publicationId ? state.publications.find(item => item.id === input.publicationId) : state.publications.find(item => !['FINALIZED', 'PUBLISHED', 'ABORTED'].includes(item.status.toUpperCase()));
      if (!publication) throw new Error('There is no selected publication to reconcile.');
      operation = 'reconcile-publication'; body = { publicationId: publication.id };
    } else if (path === '/api/increase-budget') {
      const increase = repairBudgetIncrease(state);
      const reason = input.reason;
      if (!increase || !state.projectBudget) throw new Error('A verified human session and current capacity shortfall are required.');
      if (typeof reason !== 'string' || !reason || reason.trim() !== reason || new TextEncoder().encode(reason).length > 512 || /[\u0000-\u001f\u007f]/.test(reason)) throw new Error('An audited reason is required.');
      operation = 'increase-budget';
      body = { expectedMaximumBudget: state.projectBudget.maximumUnits, newMaximumBudget: increase.newMaximumUnits, reason };
    } else throw new Error('This action has no exact deployed command mapping.');
    path = `/v1/projects/${encodeURIComponent(state.projectId)}/${operation}`;
  } else {
    if (!['/api/demo', '/api/select', '/api/repair', '/api/review', '/api/approve', '/api/publish', '/api/reconcile'].includes(path)) throw new Error('Unsupported local command.');
    // The local adapter already retains the exact closed-schema high-level body.
    if (path === '/api/reconcile') body = {};
    body = { ...body, commandId: id };
    if (scoped) path = projectApiPath(state.projectId, path);
  }
  return { schemaVersion: 1, id, label, path, body: JSON.stringify(body), headers, scope: commandScope(state), status: 'SENDING', detail: '' };
}

export const metadataScope = (directory: Pick<ProjectDirectoryResponse, 'tenantId' | 'principalId'>, project?: Pick<ProjectSummary, 'projectId' | 'projectIncarnation'>): string =>
  JSON.stringify(['project-metadata-v1', directory.tenantId, project?.projectId ?? '', project?.projectIncarnation ?? '', directory.principalId]);

export function freezeMetadataCommand(directory: ProjectDirectoryResponse, project: ProjectSummary | undefined, label: string, operation: 'create' | Exclude<ProjectMetadataCommand['operation'], 'import'>, input: Record<string, unknown>, id: string = crypto.randomUUID()): PendingCommand {
  if (directory.maintenance) throw new Error('Maintenance mode is read-only. Project changes are paused.');
  if (!directory.principalId || !directory.tenantId) throw new Error('Refresh your project directory before sending changes.');
  if (operation === 'create' ? !directory.canCreate || project !== undefined : !project || !canManageProject(project)) throw new Error('Project administrator access is required for this change.');
  if (project?.status === 'ARCHIVED' && operation !== 'restore') throw new Error('Restore this project before changing its settings.');
  const body = JSON.stringify(structuredClone(input));
  if (new TextEncoder().encode(body).length > 24_000) throw new Error('These settings exceed the browser recovery record limit. Reduce the check configuration.');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Platform-CSRF': '1', 'Idempotency-Key': id, 'If-Platform-Principal': directory.principalId };
  if (project) { headers['If-Platform-Revision'] = project.revision; headers['If-Platform-Incarnation'] = project.projectIncarnation; }
  const record: PendingCommand = { schemaVersion: 1, kind: 'metadata', id, label, scope: metadataScope(directory, project), path: project ? projectApiPath(project.projectId, `/api/${operation}`) : '/api/projects', body, headers, status: 'SENDING', detail: '' };
  if (JSON.stringify(record).length > 32_768) throw new Error('These settings exceed the browser recovery record limit. Reduce the check configuration.');
  return record;
}

export function pendingProjectId(pending: PendingCommand): string | undefined {
  try { const scope = JSON.parse(pending.scope); return Array.isArray(scope) ? scope[0] === 'project-metadata-v1' ? scope[2] || undefined : scope[1] : undefined; }
  catch { return undefined; }
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface CommandSnapshot { pending?: PendingCommand; storageError?: string }
const storageKey = 'confidence.pending-command.v1';

/** Only an acknowledged result or explicit rejection unlocks a new intent. */
export class CommandSession {
  private snapshot: CommandSnapshot = {};
  private listeners = new Set<() => void>();
  private active = false;
  private acknowledgedResult: unknown;
  constructor(private storage: Storage, private send = (command: PendingCommand) => request(command.path, { method: 'POST', headers: command.headers, body: command.body })) {
    try {
      const retained = storage.getItem(storageKey);
      if (retained) {
        if (retained.length > 32_768) throw new Error('Invalid retained command');
        const pending = JSON.parse(retained) as PendingCommand;
        const nativePath = /^\/(api\/(?:projects\/[a-zA-Z0-9_-]+\/)?(?:demo|select|repair|review|approve|publish|reconcile)|v1\/projects\/[a-zA-Z0-9_-]+\/[a-z-]+)$/;
        const metadataPath = /^\/api\/projects(?:\/[a-zA-Z0-9_-]+\/(?:update|archive|restore|checks|cancel-import))?$/;
        if (pending.schemaVersion !== 1 || !['SENDING', 'UNKNOWN', 'REJECTED'].includes(pending.status) || typeof pending.scope !== 'string' || typeof pending.body !== 'string' || typeof pending.label !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(pending.id) || !(pending.kind === 'metadata' ? metadataPath : nativePath).test(pending.path) || pending.headers?.['Idempotency-Key'] !== pending.id) throw new Error('Invalid retained command');
        this.snapshot = { pending: { ...pending, ...(pending.status === 'SENDING' ? { status: 'UNKNOWN', detail: 'The page closed before acknowledgement. Recover the same command identity.' } as const : {}) } };
      }
    } catch { this.snapshot = { storageError: 'Pending command storage is unavailable or unreadable. Restore this browser session storage before sending new work.' }; }
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  getAcknowledgedResult = () => this.acknowledgedResult;
  private save(pending?: PendingCommand) {
    // Persist before dispatch. Storage failure must never silently lose a key.
    try {
      if (pending) this.storage.setItem(storageKey, JSON.stringify(pending)); else this.storage.removeItem(storageKey);
    } catch (error) {
      this.snapshot = { ...this.snapshot, storageError: 'Pending command storage could not be updated. Restore storage access before recovering this command.' };
      for (const listener of this.listeners) listener();
      throw error;
    }
    this.snapshot = { pending }; for (const listener of this.listeners) listener();
  }
  async begin(state: PlatformState, label: string, path: string, body: Record<string, unknown>, scoped = false): Promise<boolean> {
    if (this.snapshot.storageError) throw new Error(this.snapshot.storageError);
    if (this.snapshot.pending || this.active) throw new Error('Resolve the retained command before starting another action.');
    this.save(freezeCommand(state, label, path, body, undefined, scoped));
    return this.dispatch(state);
  }
  async beginMetadata(directory: ProjectDirectoryResponse, project: ProjectSummary | undefined, label: string, operation: 'create' | Exclude<ProjectMetadataCommand['operation'], 'import'>, body: Record<string, unknown>): Promise<boolean> {
    if (this.snapshot.storageError) throw new Error(this.snapshot.storageError);
    if (this.snapshot.pending || this.active) throw new Error('Resolve the retained command before starting another action.');
    this.save(freezeMetadataCommand(directory, project, label, operation, body));
    return this.dispatchScope(metadataScope(directory, project));
  }
  async retryMetadata(directory: ProjectDirectoryResponse, project?: ProjectSummary): Promise<boolean> {
    if (directory.maintenance) throw new Error('Maintenance mode is read-only. Recover this exact command after maintenance ends.');
    if (this.snapshot.pending?.status !== 'UNKNOWN' || this.snapshot.pending.kind !== 'metadata') throw new Error('Only an unconfirmed project change can be recovered.');
    return this.dispatchScope(metadataScope(directory, project));
  }
  async retry(state: PlatformState): Promise<boolean> {
    if (this.snapshot.pending?.status !== 'UNKNOWN') throw new Error('Only an unconfirmed command can be recovered.');
    return this.dispatch(state);
  }
  dismissRejection() {
    if (this.snapshot.pending?.status === 'REJECTED' && !this.active) this.save();
  }
  private async dispatch(state: PlatformState): Promise<boolean> {
    if (state.capabilities.deployment && state.capabilities.maintenance) throw new Error('Maintenance mode is read-only. Recover this exact command after the active release has been verified.');
    return this.dispatchScope(commandScope(state));
  }
  private async dispatchScope(scope: string): Promise<boolean> {
    const retained = this.snapshot.pending;
    if (!retained || this.active) throw new Error('A command is already being sent.');
    if (retained.scope !== scope) throw new Error('This command belongs to a different principal or project incarnation. Restore that session to recover it; it will not be replayed here.');
    const wasUnknown = retained.status === 'UNKNOWN';
    this.save({ ...retained, status: 'SENDING', detail: '' }); this.active = true;
    try {
      const response = await this.send(retained);
      if (retained.kind === 'metadata') {
        const project = readProjectSummary(response);
        const originalProject = pendingProjectId(retained), originalIncarnation = retained.headers['If-Platform-Incarnation'];
        if ((originalProject && project.projectId !== originalProject) || (originalIncarnation && project.projectIncarnation !== originalIncarnation)) throw new ApiError('The project change response named a different project. Recover the same command to confirm it.');
      }
      this.acknowledgedResult = response;
      this.save(); return true;
    } catch (error) {
      // A later access denial cannot establish that an earlier uncertain effect
      // never happened. Timeouts, transport errors and 5xx are also ambiguous.
      // STALE_STATE is emitted only by the authority after its dedup lookup and
      // before admission. Other 4xx may come from a changed app/auth/config gate
      // before that lookup, so cannot settle the original uncertain operation.
      const rejected = error instanceof ApiError && error.status !== undefined && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status) && (!wasUnknown || (error.status === 409 && error.code === 'STALE_STATE'));
      const pending: PendingCommand = { ...retained, status: rejected ? 'REJECTED' : 'UNKNOWN', detail: error instanceof Error ? error.message : 'No acknowledgement was received.' };
      try { this.save(pending); }
      catch { this.snapshot = { ...this.snapshot, pending }; for (const listener of this.listeners) listener(); }
      return false;
    } finally { this.active = false; }
  }
}
