// SPDX-License-Identifier: Apache-2.0
import { OWNED_JOB_COUNT } from './requests';
import { withinDeadline } from '../../workers/shared/deadline';
import { requireValue } from '../../workers/shared/errors';

export type DiagnosticRead<T> = { inspection: 'OBSERVED'; state: T } | { inspection: 'UNKNOWN'; state: null };

/** The controller supplies its retained plan, never a caller-selected DO key. */
export async function registeredGenerationDiagnostics<T>(jobKeys: string[], inspect: (jobKey: string) => Promise<T>): Promise<Record<string, DiagnosticRead<T>>> {
  requireValue(jobKeys.length <= OWNED_JOB_COUNT && new Set(jobKeys).size === jobKeys.length && jobKeys.every(key => /^[a-f0-9]{64}$/.test(key)), 'OWNED_DIAGNOSTIC_PLAN_BOUND');
  // All reads share the same two-second window. A slow journal must not multiply
  // the bounded job snapshot latency or discard independently observed native state.
  return Object.fromEntries(await Promise.all(jobKeys.map(async jobKey => {
    let value: DiagnosticRead<T>;
    try { value = { inspection: 'OBSERVED', state: await withinDeadline(() => inspect(jobKey), 2000, 'EVALUATION_INSPECTION_DEADLINE') }; }
    catch { value = { inspection: 'UNKNOWN', state: null }; }
    return [jobKey, value];
  })));
}
