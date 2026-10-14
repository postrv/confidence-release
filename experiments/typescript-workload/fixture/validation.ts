// SPDX-License-Identifier: Apache-2.0
export function parseReservation(value: unknown): { requestId: string; seats: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid reservation body');
  const row = value as Record<string, unknown>;
  if (typeof row.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(row.requestId)) throw new Error('Invalid request ID');
  if (!Number.isSafeInteger(row.seats) || (row.seats as number) < 1 || (row.seats as number) > 12) throw new Error('Invalid seat count');
  return { requestId: row.requestId, seats: row.seats as number };
}
