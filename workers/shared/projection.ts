// SPDX-License-Identifier: Apache-2.0
import { canonicalize } from '../../packages/protocol/src/index';
import type { Scope } from '../../packages/protocol/src/types';
import type { ProjectionEvent } from '../authority/types';
import { requireValue } from './errors';

export const PROJECTION_PAGE_SIZE = 32;
export const PROJECTION_PAGE_BYTES = 128 * 1024;
export const PROJECTION_EVENT_BYTES = 64 * 1024;
export interface ProjectionTarget { id: string; digest: string; sequence: number }
export interface ProjectionHistoryRequest { schemaVersion: 1; scope: Scope; afterSequence: number; throughSequence: number; target: ProjectionTarget }
export interface ProjectionHistoryPage extends ProjectionHistoryRequest { events: ProjectionEvent[]; nextSequence: number; complete: boolean }
export interface ProjectionReplayBody { scope: Scope; afterSequence: number; throughSequence: number | null; replayId: string | null }
export interface ProjectionReplayRecord { id: string; scope: Scope; requester: string; throughSequence: number; nextSequence: number; queued: number }
const identifier = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_./:-]{1,160}$/.test(value);
export function closed(value: unknown, keys: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key) || optional.includes(key)) && keys.every(key => Object.hasOwn(value, key)), 'PROJECTION_SCHEMA');
}
export function projectionSequence(value: unknown): asserts value is number { requireValue(Number.isSafeInteger(value) && Number(value) >= 0, 'PROJECTION_SEQUENCE'); }
export function projectionScope(value: unknown): asserts value is Scope {
  closed(value, ['schemaVersion', 'tenantId', 'projectId', 'projectIncarnation']);
  requireValue(value.schemaVersion === 1 && [value.tenantId, value.projectId, value.projectIncarnation].every(item => typeof item === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(item)), 'PROJECTION_SCOPE');
}
export function projectionEvent(value: unknown): asserts value is ProjectionEvent {
  closed(value, ['id', 'scope', 'sequence', 'digest', 'kind', 'objectId', 'payload'], ['time']); projectionScope(value.scope); projectionSequence(value.sequence);
  requireValue(Number(value.sequence) > 0 && identifier(value.id) && identifier(value.objectId) && typeof value.kind === 'string' && value.kind.length > 0 && value.kind.length <= 160 && typeof value.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.digest) && (value.time === undefined || typeof value.time === 'string' && value.time.length <= 32), 'PROJECTION_EVENT');
  requireValue(new TextEncoder().encode(canonicalize(value)).length <= PROJECTION_EVENT_BYTES, 'PROJECTION_EVENT_LIMIT', 413);
}
export function historyRequest(value: unknown): asserts value is ProjectionHistoryRequest {
  closed(value, ['schemaVersion', 'scope', 'afterSequence', 'throughSequence', 'target']); projectionScope(value.scope); projectionSequence(value.afterSequence); projectionSequence(value.throughSequence);
  closed(value.target, ['id', 'digest', 'sequence']); projectionSequence(value.target.sequence);
  requireValue(value.schemaVersion === 1 && identifier(value.target.id) && typeof value.target.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.target.digest) && value.target.sequence === Number(value.throughSequence) + 1 && Number(value.afterSequence) <= Number(value.throughSequence), 'PROJECTION_HISTORY_WINDOW');
}
export function replayBody(value: unknown): asserts value is ProjectionReplayBody {
  closed(value, ['scope', 'afterSequence', 'throughSequence', 'replayId']); projectionScope(value.scope); projectionSequence(value.afterSequence);
  if (value.throughSequence !== null) projectionSequence(value.throughSequence);
  requireValue(value.replayId === null ? value.afterSequence === 0 : identifier(value.replayId) && value.throughSequence !== null, 'PROJECTION_REPLAY_CURSOR');
}
