import { FULL_RELEASE_JOB_COUNT } from '../workers/evaluator/recipes.ts';
import type { Evaluation } from './types.ts';
export interface Probe { name: string; seed: number; values: { initial: number; replacement: number; later: number }; actions: string[]; assertion: 'freshness' | 'cache-benefit' | 'presentation' | 'overlap-freshness'; disclosure: 'public' | 'audit-withheld-from-repair'; }
const values = (seed: number) => ({ initial: 1000 + (seed * 13) % 2000, replacement: 4000 + (seed * 17) % 2000, later: 7000 + (seed * 19) % 2000 });
const originalPublicProbes: Probe[] = [
  { name: 'warm-read-write-read', seed: 20261003, actions: ['read', 'write', 'read'], assertion: 'freshness' },
  { name: 'repeated-reads', seed: 20261004, actions: ['read', 'read', 'write', 'read', 'read'], assertion: 'freshness' },
  { name: 'successive-writes', seed: 20261005, actions: ['read', 'write', 'read', 'write-later', 'read'], assertion: 'freshness' },
  { name: 'cold-write-then-warm-write', seed: 20261006, actions: ['write', 'read', 'write-later', 'read'], assertion: 'freshness' },
  { name: 'retained-cache-benefit', seed: 20261103, actions: ['read', 'read'], assertion: 'cache-benefit' },
  { name: 'accessible-saved-value', seed: 20261104, actions: ['write', 'page', 'write-later', 'page'], assertion: 'presentation' },
].map(p => ({ ...p, values: values(p.seed), disclosure: 'public' } as Probe));
// Authored directly from the freshness/latest-acknowledged-value requirements;
// excluded from repair capsules. These are designed cases, not held-out research.
export const auditProbes: Probe[] = [
  { name: 'audit-write-burst', seed: 831119, actions: ['read', 'write', 'write-later', 'read', 'page'], assertion: 'freshness' },
  { name: 'audit-alternating-pages', seed: 291877, actions: ['page', 'write', 'page', 'write-later', 'page'], assertion: 'presentation' },
].map(p => ({ ...p, values: values(p.seed), disclosure: 'audit-withheld-from-repair' } as Probe));

// Append the public overlap case after the original eight complete-plan jobs.
export const overlappingReadWriteProbe: Probe = { name: 'overlapping-read-write', seed: 20261008, values: values(20261008), actions: ['overlap'], assertion: 'overlap-freshness', disclosure: 'public' };
export const publicProbes: Probe[] = [...originalPublicProbes, overlappingReadWriteProbe];
export const fullReleaseProbes: Probe[] = [...originalPublicProbes, ...auditProbes, overlappingReadWriteProbe];

/** Retained older plans remain readable but cannot qualify the current release. */
export function isCurrentFullReleasePlan(evaluation: Evaluation): boolean {
  return evaluation.purpose !== 'diagnostic' && evaluation.contract === 'retained-value-v1'
    && evaluation.jobs.length === FULL_RELEASE_JOB_COUNT && evaluation.jobs.every(job => job.required)
    && fullReleaseProbes.every(probe => evaluation.jobs.filter(job => job.name === probe.name).length === 1);
}
