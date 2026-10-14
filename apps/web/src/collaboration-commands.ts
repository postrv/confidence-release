import type { CollaborationOperation, CollaborationSession, InvitationLink } from '../../../packages/protocol/src/collaboration';
import { invitationDigestInput } from '../../../packages/protocol/src/collaboration';
import type { Scope } from '../../../packages/protocol/src/types';
import { ApiError, projectApiPath, request } from './api';

export interface CollaborationContext { scope: Scope; revision: string; session: CollaborationSession }
export interface CollaborationCommand {
  id: string;
  operation: CollaborationOperation;
  context: CollaborationContext;
  body: string;
  headers: Record<string, string>;
  status: 'SENDING' | 'UNKNOWN' | 'REJECTED';
  detail: string;
  delivery?: InvitationLink;
}
export interface CollaborationCommandSnapshot { pending?: CollaborationCommand; delivery?: InvitationLink; deliveryContext?: CollaborationContext; notice?: string }
export const collaborationScope = (context: CollaborationContext): string => JSON.stringify([context.scope.tenantId, context.scope.projectId, context.scope.projectIncarnation, context.session.principalId]);
export const collaborationCommandPath = (command: CollaborationCommand): string => projectApiPath(command.context.scope.projectId, `/api/collaboration/${command.operation}`);

export function freezeCollaborationCommand(context: CollaborationContext, operation: CollaborationOperation, body: Record<string, unknown>, id = crypto.randomUUID(), delivery?: InvitationLink): CollaborationCommand {
  if (context.session.credentialClass !== 'human' || context.session.tenantId !== context.scope.tenantId) throw new Error('This action requires the intended verified human session.');
  return { id, operation, context: structuredClone(context), body: JSON.stringify(body), status: 'SENDING', detail: '', delivery,
    headers: { 'Content-Type': 'application/json', 'X-Platform-CSRF': '1', 'Idempotency-Key': id, 'If-Platform-Principal': context.session.principalId, 'If-Platform-Incarnation': context.scope.projectIncarnation, 'If-Platform-Revision': context.revision } };
}

export async function createInvitationSecret(scope: Scope): Promise<{ secret: InvitationLink; tokenDigest: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const secret = { scope: structuredClone(scope), invitationId: crypto.randomUUID(), token };
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(invitationDigestInput(scope, secret.invitationId, token))));
  return { secret, tokenDigest: `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}` };
}

/** Invitation material is deliberately never passed to persistent command storage. */
export class CollaborationCommands {
  private snapshot: CollaborationCommandSnapshot = {};
  private listeners = new Set<() => void>();
  private active = false;
  constructor(private send = (command: CollaborationCommand) => request(collaborationCommandPath(command), { method: 'POST', headers: command.headers, body: command.body })) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private update(snapshot: CollaborationCommandSnapshot) { this.snapshot = snapshot; for (const listener of this.listeners) listener(); }
  clearDelivery() { this.update({ ...this.snapshot, delivery: undefined, deliveryContext: undefined }); }
  dismissRejection() { if (this.snapshot.pending?.status === 'REJECTED' && !this.active) this.update({}); }
  async begin(context: CollaborationContext, operation: CollaborationOperation, body: Record<string, unknown>, delivery?: InvitationLink): Promise<boolean> {
    if (this.snapshot.pending || this.active) throw new Error('Resolve the current collaboration request first.');
    this.update({ pending: freezeCollaborationCommand(context, operation, body, undefined, delivery) });
    return this.dispatch(context);
  }
  async retry(context: CollaborationContext): Promise<boolean> {
    if (this.snapshot.pending?.status !== 'UNKNOWN') throw new Error('Only an unconfirmed request can be retried.');
    return this.dispatch(context);
  }
  private async dispatch(context: CollaborationContext): Promise<boolean> {
    const command = this.snapshot.pending;
    if (!command || this.active) throw new Error('A collaboration request is already being sent.');
    if (collaborationScope(context) !== collaborationScope(command.context)) throw new Error('Restore the original signed-in identity and project before retrying this request.');
    const wasUnknown = command.status === 'UNKNOWN';
    this.active = true; this.update({ pending: { ...command, status: 'SENDING', detail: '' } });
    try {
      await this.send(command);
      this.update({ delivery: command.delivery, deliveryContext: command.delivery ? command.context : undefined, notice: 'The authority confirmed this change.' });
      return true;
    } catch (error) {
      const rejected = error instanceof ApiError && error.status !== undefined && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)
        && (!wasUnknown || (error.status === 409 && error.code === 'STALE_STATE'));
      // Neither the error payload nor a recovery export can echo a bearer token.
      const detail = error instanceof ApiError && error.code ? error.code.replaceAll('_', ' ').toLowerCase() : rejected ? 'The authority rejected this request.' : 'The response was not confirmed. Retry the same request while this page remains open.';
      this.update({ pending: { ...command, status: rejected ? 'REJECTED' : 'UNKNOWN', detail } });
      return false;
    } finally { this.active = false; }
  }
}

export const collaborationCommands = new CollaborationCommands();
