// SPDX-License-Identifier: Apache-2.0
import type { SeedDiagnostics } from './diagnostics';
export interface BindingCheck { name: string; status: 'PASS' | 'FAIL'; detail: unknown }
export interface Effect { name: string; input: unknown; phase: 'MAY_HAVE_DISPATCHED' | 'ACKNOWLEDGED' | 'UNKNOWN' | 'OBSERVED_ABSENT'; result?: unknown; reason?: string; diagnostics?: SeedDiagnostics }
export interface BindingSnapshot {
  schemaVersion: 1; runId: string; accountId: string; namespace: string; sourceSetDigest: string;
  canonicalName: string; attemptId: string; attemptName: string; canonicalId?: string;
  status: 'RUNNING' | 'PASS' | 'FAIL'; startedAt: string; completedAt?: string;
  checks: BindingCheck[]; effects: Effect[]; cleanupComplete: boolean; reason?: string;
}
export interface BindingJournal {
  schemaVersion: 1; runId: string; accountId: string; namespace: string; workerName: string; bucketName: string;
  canonicalName: string; attemptId: string; attemptName: string; expiresAt: number; sourceSetDigest: string;
  sourceDigests: Record<string, string>; sourceRevision: string | null; sourceDirty: boolean | null;
  configPath: string; configDigest: string; secretsPath: string; secretsDigest: string;
  bundleDigests?: Record<string, string>; endpoint?: string;
  run: 'NOT_DISPATCHED' | 'MAY_HAVE_DISPATCHED' | 'ACKNOWLEDGED' | 'UNKNOWN';
  cleanup: 'NOT_DISPATCHED' | 'MAY_HAVE_DISPATCHED' | 'ACKNOWLEDGED' | 'UNKNOWN';
  snapshot?: BindingSnapshot;
}
