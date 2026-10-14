// SPDX-License-Identifier: Apache-2.0
import { PlatformError } from '../shared/errors';

/** Diagnostic identities contain no source, prompt, response, credential or callback bytes. */
export interface RecoveryEvent {
  schemaVersion: 1;
  eventId: string;
  component: 'scheduler' | 'generation';
  operation: string;
  jobKey: string | null;
  code: string;
  firstAt: number;
  lastAt: number;
  occurrences: number;
}

export const MAX_RECOVERY_EVENTS = 32;
/** Last attempted boundary, never evidence that the operation completed. */
export type ExecutionStage = 'startup-alarm' | 'container-lookup' | 'outbound-intercept' | 'fixture-initialize'
  | 'container-start' | 'container-inactivity' | 'source-hydration' | 'candidate-start' | 'candidate-probes';

// Only locally defined identities are diagnostics. Native messages and arbitrary
// exception codes may contain customer data even when they resemble identifiers.
const recoveryCodes = new Set([
  'EVALUATOR_CONTINUATION_LOST', 'CALLBACK_NOT_ACKNOWLEDGED', 'CONTAINER_UNAVAILABLE', 'CANDIDATE_NOT_READY', 'SERVICE_DEADLINE_EXCEEDED',
  'IMAGE_DIGEST_MISMATCH', 'EVALUATION_CALLBACK_CHANGED', 'EVALUATION_DISPATCH_DEADLINE',
  'EVALUATION_GENERATION_CHANGED', 'EVALUATION_GENERATION_FENCED', 'EVALUATION_INSPECTION_DEADLINE',
  'EVALUATION_STATUS_DEADLINE', 'EVALUATION_TIMEOUT', 'FIXTURE_ALREADY_INITIALIZED', 'FIXTURE_CLOSE_DEADLINE',
  'FIXTURE_FENCED', 'FIXTURE_SNAPSHOT_DEADLINE', 'SCHEDULED_REQUEST_IDENTITY', 'REGISTERED_CHECKER_KEY_MISMATCH',
  'FIXTURE_BARRIER_DEADLINE', 'FIXTURE_BARRIER_CONTROL_DEADLINE', 'FIXTURE_BARRIER_CAPTURE_MISMATCH',
  'FIXTURE_BARRIER_READ_MISSING', 'FIXTURE_BARRIER_ALREADY_USED', 'FIXTURE_BARRIER_UNAVAILABLE',
  'SOURCE_OBJECTS_DIGEST_MISMATCH', 'SOURCE_BLOB_MISSING', 'INVALID_SOURCE_MANIFEST',
  'HYDRATION_DUPLICATE_DIRECTORY_ENTRY', 'HYDRATION_INCOMPLETE_INVENTORY', 'HYDRATION_INVALID_DIRECTORY_ENTRY',
  'HYDRATION_MODE_FAILED', 'HYDRATION_NOT_REGULAR_DIRECTORY', 'HYDRATION_NOT_REGULAR_FILE',
  'HYDRATION_READBACK_DIGEST_MISMATCH', 'HYDRATION_READBACK_MODE_MISMATCH', 'HYDRATION_READBACK_SIZE_MISMATCH',
  'HYDRATION_UNDECLARED_ENTRY', 'OBJECT_DIGEST_MISMATCH', 'OBJECT_READBACK_MISMATCH',
  'OBJECT_STORE_DEADLINE_EXCEEDED', 'REQUIRED_OBJECT_MISSING', 'SIZE_LIMIT',
]);
export const recoveryCode = (reason: unknown): string => {
  if (reason instanceof PlatformError && recoveryCodes.has(reason.code)) return reason.code;
  // Exact native identity only: never return any portion of a provider message.
  if (reason instanceof Error && reason.message === 'The container has not been started') return 'CONTAINER_NOT_STARTED';
  return 'UNCLASSIFIED_ERROR';
};

/** Coalesce the same fault while retaining the first sighting and a bounded recent history. */
export function foldRecoveryEvent(events: RecoveryEvent[], input: Omit<RecoveryEvent, 'schemaVersion' | 'firstAt' | 'lastAt' | 'occurrences'>, at: number): { events: RecoveryEvent[]; current: RecoveryEvent } {
  const bounded = events.slice(-MAX_RECOVERY_EVENTS);
  const index = bounded.findIndex(row => row.component === input.component && row.operation === input.operation && row.jobKey === input.jobKey && row.code === input.code);
  const previous = index < 0 ? null : bounded.splice(index, 1)[0]!;
  const current: RecoveryEvent = previous
    ? { ...previous, lastAt: at, occurrences: Math.min(Number.MAX_SAFE_INTEGER, previous.occurrences + 1) }
    : { schemaVersion: 1, ...input, firstAt: at, lastAt: at, occurrences: 1 };
  return { events: [...bounded, current].slice(-MAX_RECOVERY_EVENTS), current };
}

export const emitRecoveryOccurrence = (count: number): boolean => count > 0 && Number.isSafeInteger(count) && Number.isInteger(Math.log2(count));

/** Persist before logging. A log is a hint; the per-DO journal is the retained record. */
export async function recordRecovery(storage: DurableObjectStorage, component: RecoveryEvent['component'], operation: string, jobKey: string | null, reason: unknown): Promise<void> {
  const code = recoveryCode(reason);
  try {
    const current = await storage.transaction(async transaction => {
      const prior = await transaction.get<RecoveryEvent[]>('recovery-events-v1') ?? [];
      const next = foldRecoveryEvent(prior, { eventId: crypto.randomUUID(), component, operation, jobKey, code }, Date.now());
      await transaction.put('recovery-events-v1', next.events);
      if (next.current.occurrences === 1 && prior.length >= MAX_RECOVERY_EVENTS) {
        const evicted = await transaction.get<number>('recovery-events-evicted-v1') ?? 0;
        await transaction.put('recovery-events-evicted-v1', Math.min(Number.MAX_SAFE_INTEGER, evicted + 1));
      }
      return next.current;
    });
    if (emitRecoveryOccurrence(current.occurrences)) console.error(JSON.stringify({ type: 'evaluation-recovery', ...current, retained: true }));
  } catch {
    // The original recovery alarm and occupied generation remain authoritative.
    console.error(JSON.stringify({ type: 'evaluation-recovery-journal-unavailable', component, operation, jobKey, code, retained: false }));
  }
}

export async function readRecoveryEvents(storage: DurableObjectStorage): Promise<RecoveryEvent[]> {
  return await storage.get<RecoveryEvent[]>('recovery-events-v1') ?? [];
}

export async function readRecoveryEvictions(storage: DurableObjectStorage): Promise<number> {
  return await storage.get<number>('recovery-events-evicted-v1') ?? 0;
}
