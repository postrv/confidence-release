// SPDX-License-Identifier: Apache-2.0
import { requireValue } from '../shared/errors';

export const AUTHORITY_CAPACITY_THRESHOLDS = {
  records: { alert: 10_000, stop: 20_000 },
  sqliteBytes: { alert: 50 * 1024 * 1024, stop: 100 * 1024 * 1024 },
} as const;
const discretionary = new Set([
  'launch-cohort', 'create-attempt', 'start-execution', 'start-repair', 'request-repair', 'propose-selection',
  'accept-proposal', 'submit-weft-revision', 'materialize', 'request-evaluation', 'prepare-review', 'approve-review',
  'request-publication', 'create-goal', 'set-policy', 'increase-budget',
]);
/** Existing admitted effects and safety/recovery writes deliberately remain outside this gate. */
export function isNewAuthorityWork(operation: string, body: Record<string, unknown>): boolean {
  return discretionary.has(operation) || operation === 'set-admission-gate' && body.gate === 'OPEN';
}
export function authorityCapacity(recordsRows: number, sqliteBytes: number) {
  requireValue([recordsRows, sqliteBytes].every(value => Number.isSafeInteger(value) && value >= 0), 'AUTHORITY_CAPACITY_UNAVAILABLE', 503);
  const values = { records: recordsRows, sqliteBytes };
  const dimensions = ['records', 'sqliteBytes'] as const;
  const alerts = dimensions.filter(key => values[key] >= AUTHORITY_CAPACITY_THRESHOLDS[key].alert);
  const stops = dimensions.filter(key => values[key] >= AUTHORITY_CAPACITY_THRESHOLDS[key].stop);
  return { scope: 'PER_PROJECT_AUTHORITY' as const, status: stops.length ? 'STOP' as const : alerts.length ? 'ALERT' as const : 'NORMAL' as const,
    recordsRows, sqliteBytes, alertDimensions: alerts, stopDimensions: stops, thresholds: AUTHORITY_CAPACITY_THRESHOLDS,
    newWorkAdmission: stops.length ? 'STOPPED' as const : 'OPEN' as const, recoveryWritesMayExceedThreshold: true as const };
}
export function observeAuthorityCapacity(sql: Pick<SqlStorage, 'exec' | 'databaseSize'>) {
  const { count } = sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM records').one();
  return authorityCapacity(count, sql.databaseSize);
}
export function requireAuthorityCapacity(sql: Pick<SqlStorage, 'exec' | 'databaseSize'>, operation: string, body: Record<string, unknown>): void {
  if (isNewAuthorityWork(operation, body))
    requireValue(observeAuthorityCapacity(sql).newWorkAdmission === 'OPEN', 'AUTHORITY_CAPACITY_STOP', 503);
}
