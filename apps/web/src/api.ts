import type { PlatformState } from '../../../services/types';
import { validProjectId } from './navigation';

type UnchangedState = { unchanged: true; viewToken: string };
export const FORCED_FULL_SNAPSHOT_MS = 60_000;

export class ApiError extends Error {
  constructor(message: string, public readonly status?: number, public readonly code?: string) { super(message); }
}

export function stateReadFailure(error: unknown): { kind: 'authentication' | 'project' | 'unavailable'; clearSnapshot: boolean; message: string } {
  const message = error instanceof Error ? error.message : 'Cannot reach the project API.';
  if (error instanceof ApiError && error.status === 404 && error.code === 'PROJECT_UNAVAILABLE') return { kind: 'project', clearSnapshot: true, message };
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return { kind: 'authentication', clearSnapshot: true, message };
  return { kind: 'unavailable', clearSnapshot: false, message };
}

export function projectSnapshotStatus(state: PlatformState | undefined, connected: boolean, connectionError: string): 'current' | 'unverified' | 'unavailable' {
  return !state ? 'unavailable' : connected && !connectionError ? 'current' : 'unverified';
}

function isUnchanged(value: PlatformState | UnchangedState): value is UnchangedState {
  return 'unchanged' in value && value.unchanged === true;
}

/** Share one accepted snapshot between the display, selection and command headers. */
export function createStateReader(read: (accepted?: PlatformState, force?: boolean) => Promise<PlatformState | UnchangedState>, now = () => Date.now()) {
  let accepted: PlatformState | undefined;
  let issued = 0;
  let newestResponse = 0;
  let lastFullAt = 0;
  let accessEpoch = 0;
  return async (force = false): Promise<PlatformState> => {
    const sequence = ++issued;
    const readEpoch = accessEpoch;
    let next: PlatformState | UnchangedState;
    try { next = await read(accepted, force || !accepted || now() - lastFullAt >= FORCED_FULL_SNAPSHOT_MS); }
    catch (error) {
      if (readEpoch !== accessEpoch) throw new ApiError('An earlier project read was discarded after access changed. Refresh the project.');
      if (accepted && sequence < newestResponse) return accepted;
      if (stateReadFailure(error).clearSnapshot) {
        accepted = undefined;
        lastFullAt = 0;
        newestResponse = Math.max(newestResponse, sequence);
        accessEpoch++;
      }
      throw error;
    }
    if (readEpoch !== accessEpoch) throw new ApiError('An earlier project read was discarded after access changed. Refresh the project.');
    if (isUnchanged(next)) {
      if (accepted && sequence < newestResponse) return accepted;
      if (!accepted || !accepted.viewToken || next.viewToken !== accepted.viewToken) {
        lastFullAt = 0;
        throw new ApiError('The service returned an unrelated snapshot cursor. Refresh the project.');
      }
      newestResponse = Math.max(newestResponse, sequence);
      return accepted;
    }
    const sameProject = accepted && next.tenantId === accepted.tenantId && next.projectId === accepted.projectId && next.projectIncarnation === accepted.projectIncarnation
      && next.session?.principalId === accepted.session?.principalId && next.session?.credentialClass === accepted.session?.credentialClass;
    let newerView = false;
    if (sameProject && accepted) {
      if (next.viewCursor && accepted.viewCursor) {
        const current = accepted.viewCursor, incoming = next.viewCursor;
        const currentRevision = BigInt(current.revision), incomingRevision = BigInt(incoming.revision);
        newerView = incomingRevision > currentRevision
          || incomingRevision === currentRevision && (incoming.eventSequence > current.eventSequence
            || incoming.eventSequence === current.eventSequence && (incoming.capsuleRowid > current.capsuleRowid
              || incoming.capsuleRowid === current.capsuleRowid && sequence >= newestResponse));
      } else {
        const currentRevision = BigInt(accepted.revision), incomingRevision = BigInt(next.revision);
        newerView = incomingRevision > currentRevision || incomingRevision === currentRevision && sequence >= newestResponse;
      }
    }
    if (!accepted || (sameProject ? newerView : sequence > newestResponse)) {
      accepted = next;
      lastFullAt = now();
    }
    newestResponse = Math.max(newestResponse, sequence);
    return accepted;
  };
}

const readState = createStateReader((accepted, force) => request<PlatformState | UnchangedState>('/api/state',
  accepted?.viewToken && !force ? { headers: { 'if-platform-view': accepted.viewToken } } : undefined));

export async function getState(force = false): Promise<PlatformState> {
  return readState(force);
}

/** The selected project is explicit in every project read, including downloads. */
export function projectApiPath(projectId: string | undefined, path: string): string {
  if (!path.startsWith('/api/') || path.includes('#')) throw new Error('Invalid project API path.');
  if (projectId === undefined) return path;
  if (!validProjectId(projectId)) throw new Error('Invalid project ID.');
  return `/api/projects/${encodeURIComponent(projectId)}/${path.slice(5)}`;
}

export function createProjectStateReader(projectId: string, read = request<PlatformState | UnchangedState>) {
  const path = projectApiPath(projectId, '/api/state');
  return createStateReader(async (accepted, force) => {
    const next = await read(path, accepted?.viewToken && !force ? { headers: { 'if-platform-view': accepted.viewToken } } : undefined);
    if (!isUnchanged(next) && next.projectId !== projectId) throw new ApiError('The service returned a different project. Refresh access.', 404, 'PROJECT_UNAVAILABLE');
    return next;
  });
}

/** One finite deadline covers headers and the complete bounded response body. */
export async function request<T = unknown>(path: string, init?: RequestInit, timeoutMs = 12_000, fetcher: typeof fetch = fetch, maximumBytes = 8 * 1024 * 1024): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    abort.abort(); reject(new ApiError('The service did not confirm a response before the deadline.'));
  }, timeoutMs); });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetcher(path, { ...init, signal: abort.signal, cache: 'no-store' });
      if (response.redirected || /text\/html/i.test(response.headers.get('content-type') ?? '')) throw new ApiError('Your login session needs attention. Sign in again, then refresh the project.', 401);
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (reader) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.length;
          if (size > maximumBytes) { void reader.cancel(); throw new ApiError(`The service response exceeded the ${maximumBytes / (1024 * 1024)} MiB limit.`); }
          chunks.push(next.value);
        }
      } finally { reader?.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      let value: unknown;
      try { value = text ? JSON.parse(text) : {}; } catch { throw new ApiError('The service returned an unreadable response. Its command outcome is not confirmed.'); }
      if (!response.ok) {
        const error = value as { error?: string | { message?: string; code?: string }; message?: string; reason?: string };
        const detail = typeof error.error === 'string' ? error.error : error.error?.message || error.error?.code;
        throw new ApiError(error.message || detail || error.reason || `Request failed (${response.status}).`, response.status, typeof error.error === 'object' ? error.error?.code : undefined);
      }
      return value as T;
    })()]);
  } finally { clearTimeout(timer); abort.abort(); }
}

export function downloadJSON(value: unknown, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
