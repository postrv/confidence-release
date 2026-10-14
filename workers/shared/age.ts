// SPDX-License-Identifier: Apache-2.0
/** NULL sorts before recorded timestamps: one legacy pending row makes oldest age unknown. */
export function oldestAge(createdAtMs: number | null | undefined, observedAtMs: number): { ageSeconds: number | null; evidence: 'EMPTY' | 'LEGACY_UNKNOWN' | 'INVALID_TIMESTAMP' | 'RECORDED' } {
  if (createdAtMs === undefined) return { ageSeconds: null, evidence: 'EMPTY' };
  if (createdAtMs === null) return { ageSeconds: null, evidence: 'LEGACY_UNKNOWN' };
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0 || createdAtMs > observedAtMs + 1000) return { ageSeconds: null, evidence: 'INVALID_TIMESTAMP' };
  return { ageSeconds: Math.floor(Math.max(0, observedAtMs - createdAtMs) / 1000), evidence: 'RECORDED' };
}
