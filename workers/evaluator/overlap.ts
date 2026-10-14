// SPDX-License-Identifier: Apache-2.0
import { withinDeadline } from '../shared/deadline';
import { requireValue } from '../shared/errors';

export interface ProbeResponse { status: number; observed: number | null; responseDigest: string }
export function validOverlapStoreTrace(state: { value: number; reads: number; accesses: { method: string; value: number }[] } | undefined, initial: number, replacement: number): boolean {
  const accesses = state?.accesses;
  return !!state && state.value === replacement && !!accesses && accesses.length >= 2 && accesses.length <= 128
    && accesses[0].method === 'GET' && accesses[0].value === initial && accesses[1].method === 'PUT' && accesses[1].value === replacement
    && accesses.slice(2).every(access => access.method === 'GET' && access.value === replacement) && state.reads === accesses.length - 1;
}
export interface ReadBarrierControl {
  armReadBarrier(deadline: number): Promise<void>;
  waitForReadCapture(): Promise<{ capturedValue: number; reads: number }>;
  releaseReadBarrier(): Promise<void>;
  close(): Promise<void>;
}
/** Controller-only ordering. Candidate requests never receive this control capability. */
export async function runOverlappingReadWrite(input: {
  fixture: ReadBarrierControl; initial: number; replacement: number; deadline: number;
  read(timeoutMs: number): Promise<ProbeResponse>; write(value: number): Promise<ProbeResponse>;
  continuation(): Promise<void>; observations: unknown[];
}): Promise<'PASS' | 'FAIL' | 'ERROR'> {
  const deadline = Math.min(input.deadline, Date.now() + 10000);
  requireValue(deadline > Date.now(), 'EVALUATION_TIMEOUT', 408);
  const control = <T>(operation: () => Promise<T>) => withinDeadline(operation, Math.max(1, Math.min(2000, deadline - Date.now())), 'FIXTURE_BARRIER_CONTROL_DEADLINE');
  let released = false;
  let pending: Promise<{ value: ProbeResponse | null; error: unknown }> | undefined;
  try {
    await control(() => input.fixture.armReadBarrier(deadline));
    await input.continuation();
    pending = input.read(Math.max(1, deadline - Date.now())).then(value => ({ value, error: null }), error => ({ value: null, error }));
    const captured = await control(() => input.fixture.waitForReadCapture());
    await input.continuation();
    requireValue(captured.capturedValue === input.initial && captured.reads === 1, 'FIXTURE_BARRIER_CAPTURE_MISMATCH');
    input.observations.push({ action: 'overlap-captured', expected: input.initial, observed: captured.capturedValue, storeReadCount: captured.reads });
    const write = await input.write(input.replacement); await input.continuation();
    input.observations.push({ action: 'write', expected: input.replacement, ...write });
    await control(() => input.fixture.releaseReadBarrier()); released = true;
    input.observations.push({ action: 'overlap-released', afterWriteStatus: write.status });
    const old = await withinDeadline(() => pending!, Math.max(1, deadline - Date.now()), 'FIXTURE_BARRIER_DEADLINE');
    if (old.error) throw old.error;
    requireValue(old.value, 'FIXTURE_BARRIER_READ_MISSING'); await input.continuation();
    input.observations.push({ action: 'overlap-read', expectedOneOf: [input.initial, input.replacement], ...old.value });
    const fresh = await input.read(3000); await input.continuation();
    input.observations.push({ action: 'read', expected: input.replacement, ...fresh });
    if ([write, old.value, fresh].some(response => response.status < 200 || response.status >= 300)) return 'ERROR';
    return write.observed === input.replacement && (old.value.observed === input.initial || old.value.observed === input.replacement)
      && fresh.observed === input.replacement ? 'PASS' : 'FAIL';
  } finally {
    // Cancellation, deadline and a failed control call all fence the held data
    // request. The evaluator's normal stop path independently confirms closure.
    if (!released) await control(() => input.fixture.close()).catch(() => undefined);
    if (pending) await withinDeadline(() => pending!, Math.max(1, deadline - Date.now()), 'FIXTURE_BARRIER_DEADLINE').catch(() => undefined);
  }
}
