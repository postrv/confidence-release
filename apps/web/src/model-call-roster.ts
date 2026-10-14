import type { PlatformState } from '../../../services/types';

export interface ModelCallSummary {
  count: number;
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const counter = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value);

/** Only an explicit authenticated authority read can supply these call counts. */
export function modelCallSummary(raw: unknown, state: Pick<PlatformState, 'tenantId' | 'projectId' | 'projectIncarnation' | 'revision'>): ModelCallSummary {
  if (!object(raw) || !object(raw.project) || !object(raw.project.scope) || !object(raw.modelCalls)) throw new Error('Model-call roster unavailable.');
  const scope = raw.project.scope, roster = raw.modelCalls;
  if (scope.tenantId !== state.tenantId || scope.projectId !== state.projectId || scope.projectIncarnation !== state.projectIncarnation
    || raw.project.revision !== String(state.revision)) throw new Error('The model-call roster belongs to a different project revision. Refresh the project before reading it again.');
  if (!Number.isSafeInteger(roster.limit) || Number(roster.limit) < 1 || Number(roster.limit) > 2048
    || !Array.isArray(roster.reservations) || roster.reservations.length > Number(roster.limit) || roster.overflow !== false) {
    throw new Error('The model-call roster is incomplete or exceeded its bound. The call count remains unknown.');
  }
  const ids = new Set<string>();
  for (const item of roster.reservations) {
    if (!object(item) || typeof item.callId !== 'string' || !/^[0-9a-f-]{36}$/.test(item.callId) || ids.has(item.callId)
      || typeof item.attemptId !== 'string' || !counter(item.generation) || !counter(item.maximumCost)
      || typeof item.requestDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(item.requestDigest)) {
      throw new Error('The model-call roster contains an invalid reservation. The call count remains unknown.');
    }
    ids.add(item.callId);
    if (item.state !== 'DISPATCHED' && item.state !== 'SETTLED') throw new Error('The model-call roster contains an unknown reservation state. The call count remains unknown.');
  }
  return { count: roster.reservations.length };
}
