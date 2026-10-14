import type { Scope } from '../../../packages/protocol/src/types';
import type { HubMessage, HubMessagePage } from '../../../packages/protocol/src/project-hub';
import { ApiError, request } from './api';

export function discussionAccessLost(error: unknown): boolean {
  return error instanceof ApiError && ([401, 403, 404].includes(error.status ?? 0) || error.status === 409 && ['SESSION_PRINCIPAL_CHANGED', 'HUB_SCOPE_MISMATCH'].includes(error.code ?? ''));
}

export interface AgentConnectionFile { schemaVersion: 1; origin: string; projectId: string; projectIncarnation: string; connectionId: string; token: string }
export async function createAgentConnection(origin: string, scope: Scope, label: string, now = Math.floor(Date.now() / 1000)) {
  const parsed = new URL(origin);
  if (parsed.origin !== origin || parsed.protocol !== 'https:') throw new Error('Agent connections require the canonical HTTPS application origin.');
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const connectionId = crypto.randomUUID();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  const tokenHash = `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const file: AgentConnectionFile = { schemaVersion: 1, origin, projectId: scope.projectId, projectIncarnation: scope.projectIncarnation, connectionId, token };
  return { file, registration: { connectionId, label: label.trim(), tokenHash, expiresAt: now + 86400 } };
}

export function mergeDiscussionPage(existing: HubMessage[], after: string, page: Pick<HubMessagePage, 'messages' | 'nextCursor' | 'hasMore'>): HubMessage[] {
  const decimal = /^(0|[1-9][0-9]{0,18})$/;
  if (!decimal.test(after) || !decimal.test(page.nextCursor) || !Array.isArray(page.messages) || page.messages.length > 100) throw new Error('Invalid discussion cursor.');
  let previous = BigInt(after);
  for (const message of page.messages) {
    if (!decimal.test(message.sequence) || BigInt(message.sequence) <= previous) throw new Error('Discussion records changed order. Refresh the project.');
    previous = BigInt(message.sequence);
  }
  if (previous !== BigInt(page.nextCursor)) throw new Error('The discussion cursor does not match its records.');
  return [...existing, ...page.messages].slice(-500);
}

export interface PendingDiscussionCommand { context: string; path: string; body?: string; headers: Record<string, string>; method: string; status: 'UNKNOWN' | 'REJECTED' | 'SENDING' }

/** An unrelated acknowledgement must not discard unsent or subsequently edited text. */
export function discussionDraftAfterAcknowledgement(draft: string, command?: Pick<PendingDiscussionCommand, 'path' | 'body'>): string {
  if (!command?.path.endsWith('/hub/messages') || !command.body) return draft;
  try { return JSON.parse(command.body).text === draft ? '' : draft; }
  catch { return draft; }
}

/** Memory only: retries retain exact inputs, without storing human or agent credentials in browser persistence. */
export class DiscussionCommand {
  pending?: PendingDiscussionCommand;
  acknowledged?: Pick<PendingDiscussionCommand, 'path' | 'body'>;
  private active = false;
  constructor(private send: (path: string, init: RequestInit) => Promise<unknown> = request) {}
  async begin(context: string, path: string, body: unknown, headers: Record<string, string>, method = 'POST') {
    if (this.pending || this.active) throw new Error('Resolve the pending discussion request first.');
    this.pending = { context, path, body: body === undefined ? undefined : JSON.stringify(body), headers: { ...headers }, method, status: 'SENDING' };
    return this.dispatch(context);
  }
  async retry(context: string) {
    if (this.pending?.status !== 'UNKNOWN') throw new Error('Only an unconfirmed request can be retried.');
    return this.dispatch(context);
  }
  dismiss() { if (!this.active && this.pending?.status === 'REJECTED') this.pending = undefined; }
  private async dispatch(context: string) {
    const pending = this.pending;
    if (!pending || this.active || pending.context !== context) throw new Error('Restore the original account and project before retrying.');
    const wasUnknown = pending.status === 'UNKNOWN';
    this.active = true; pending.status = 'SENDING';
    try {
      await this.send(pending.path, { method: pending.method, headers: pending.headers, body: pending.body });
      this.acknowledged = { path: pending.path, body: pending.body };
      this.pending = undefined; return true;
    }
    catch (error) { pending.status = !wasUnknown && error instanceof ApiError && error.status && [400, 401, 403, 404, 409, 410, 422].includes(error.status) ? 'REJECTED' : 'UNKNOWN'; return false; }
    finally { this.active = false; }
  }
}
