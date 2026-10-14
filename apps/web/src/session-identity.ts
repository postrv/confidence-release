import { ApiError, request } from './api';

export interface SessionIdentity { principalId: string; credentialClass: 'human'; deploymentProfile?: 'collaboration-only'; projectDiscussion?: boolean }
export type IdentityState = { status: 'idle' | 'loading' }
  | { status: 'unavailable'; signInRequired: boolean }
  | { status: 'verified'; identity: SessionIdentity; copy: 'idle' | 'copying' | 'copied' | 'failed' };

function sessionIdentity(value: unknown): SessionIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['principalId', 'credentialClass', 'tenantId', 'authentication', 'deploymentProfile', 'projectDiscussion'].includes(key))
    || !('principalId' in value) || typeof value.principalId !== 'string' || !value.principalId.length || value.principalId.length > 16384
    || !('credentialClass' in value) || value.credentialClass !== 'human') throw new ApiError('The service did not return a verified human identity.');
  if ('tenantId' in value && (typeof value.tenantId !== 'string' || !value.tenantId || value.tenantId.length > 128)) throw new ApiError('The service did not return a verified human identity.');
  if ('deploymentProfile' in value && value.deploymentProfile !== 'collaboration-only') throw new ApiError('The service returned an unknown deployment profile.');
  if ('projectDiscussion' in value && typeof value.projectDiscussion !== 'boolean') throw new ApiError('The service returned an invalid discussion capability.');
  if ('authentication' in value) {
    const authentication = value.authentication;
    if (!authentication || typeof authentication !== 'object' || Array.isArray(authentication)
      || Object.keys(authentication).some(key => !['issuer', 'subject', 'issuedAt', 'expiresAt', 'authenticatedAt'].includes(key))
      || !('issuer' in authentication) || typeof authentication.issuer !== 'string' || !authentication.issuer
      || !('subject' in authentication) || typeof authentication.subject !== 'string' || !authentication.subject
      || `${authentication.issuer}#${authentication.subject}` !== value.principalId
      || !('issuedAt' in authentication) || !Number.isSafeInteger(authentication.issuedAt) || Number(authentication.issuedAt) < 0
      || !('expiresAt' in authentication) || !Number.isSafeInteger(authentication.expiresAt) || Number(authentication.expiresAt) < 0
      || ('authenticatedAt' in authentication && authentication.authenticatedAt !== null && (!Number.isSafeInteger(authentication.authenticatedAt) || Number(authentication.authenticatedAt) < 0))) throw new ApiError('The service did not return a verified human identity.');
  }
  return { principalId: value.principalId, credentialClass: value.credentialClass, ...('deploymentProfile' in value ? { deploymentProfile: 'collaboration-only' as const } : {}), ...('projectDiscussion' in value ? { projectDiscussion: value.projectDiscussion as boolean } : {}) };
}

/** Older collaboration-only deployments predate the explicit capability. Other omissions stay disabled. */
export function projectDiscussionAvailable(state: IdentityState, principalId?: string): boolean {
  return state.status === 'verified' && state.identity.principalId === principalId
    && (state.identity.projectDiscussion ?? state.identity.deploymentProfile === 'collaboration-only');
}

/** A self-identity read is separate from project state and command/recovery storage. */
export function createSessionIdentity(read: () => Promise<unknown> = () => request('/api/session')) {
  let state: IdentityState = { status: 'idle' };
  let epoch = 0;
  const listeners = new Set<() => void>();
  const update = (next: IdentityState) => { state = next; for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    clear() { epoch++; if (state.status !== 'idle') update({ status: 'idle' }); },
    async refresh() {
      const current = ++epoch;
      update({ status: 'loading' });
      try {
        const identity = sessionIdentity(await read());
        if (epoch === current) update({ status: 'verified', identity, copy: 'idle' });
      } catch (error) {
        if (epoch === current) update({ status: 'unavailable', signInRequired: error instanceof ApiError && (error.status === 401 || error.status === 403) });
      }
    },
    async copy(write: (value: string) => Promise<void>) {
      if (state.status !== 'verified' || state.copy === 'copying') return;
      const current = epoch, identity = state.identity;
      update({ status: 'verified', identity, copy: 'copying' });
      try {
        await write(identity.principalId);
        if (epoch === current) update({ status: 'verified', identity, copy: 'copied' });
      } catch {
        if (epoch === current) update({ status: 'verified', identity, copy: 'failed' });
      }
    },
  };
}
