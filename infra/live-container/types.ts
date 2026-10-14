// SPDX-License-Identifier: Apache-2.0
import type { ChildProgress } from './child-observation';
export type Phase = 'NOT_DISPATCHED' | 'MAY_HAVE_DISPATCHED' | 'ACKNOWLEDGED' | 'UNKNOWN';
export interface Generation {
  runId: string; generation: string; image: string; phase: 'START_MAY_HAVE_DISPATCHED' | 'READY' | 'STOPPING' | 'STOPPED' | 'UNKNOWN';
  startDispatches: number; deadline: number; capacityHeld: boolean; controllerBootsAtDispatch: number;
  faultInjection: 'controller-abort-after-start'; childPid?: number; childHeartbeat?: string;
  childSpawnPhase?: Phase; childProgress?: ChildProgress; probePhase?: Phase; probe?: Probe; stopReason?: string; stopObservedAt?: string;
}
export interface Probe {
  hydration: { expectedDigest: string; observedDigest: string; executableDigest: string; binarySize: number; regularMode: string; executableMode: string };
  network: { allowed: number; controllerGeneration: string; forgedHeadersIgnored: boolean; denied: number; redirectDenied: number; otherPortBlocked: boolean };
}
export interface Snapshot {
  runId: string; controllerBoots: number; generation: Generation | null;
  container: { image: string; labels: Record<string, string> } | null;
  observedAt: string; observationClass: 'deployed-native-container';
}
export interface Check { name: string; status: 'PASS' | 'FAIL' | 'BLOCKED'; observationClass: 'deployed-native-container' | 'owned-local-test' | 'local-package' | 'configuration'; detail: Record<string, unknown>; }
export interface Journal {
  schemaVersion: 1; runId: string; workerName: string; containerName: string; createdAt: string; accountId?: string;
  deploy: Phase; endpoint?: string; start: Phase; stop: Phase; workerDelete: Phase;
  unresolvedResources: string[]; observations: Snapshot[]; checks: Check[];
}
export interface Report {
  schemaVersion: 1; status: 'BLOCKED' | 'PACKAGE_PASS' | 'SELF_TEST_PASS' | 'PROVIDER_PASS' | 'FAIL' | 'RECONCILIATION_REQUIRED';
  providerGatePassed: boolean; checks: Check[]; journal?: Journal; sourceDigests: Record<string, string>; limitations: string[];
  generatedAt: string; sourceRevision: string | null; sourceDirty: boolean | null; versions: Record<string, string>; compatibilityDate: string;
}
