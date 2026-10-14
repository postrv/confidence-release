// interlinked-tdd: exempt -- Type declarations only; runtime bridge validation has focused tests.
// SPDX-License-Identifier: Apache-2.0
import type { Scope } from "./types";

/** Application bridge schema; this does not extend the signed release protocol. */
export interface WeftSelection {
  schemaVersion: 1;
  bindingId: string;
  revision: number;
  root: string;
  privacyGeneration: number;
  expectedBase: string;
  context?: { note: string };
}

export interface WeftBinding {
  id: string;
  scope: Scope;
  workspaceId: string;
  alternativeId: string | null;
  sourceRepo: string;
  sourceRepositoryId: string;
  sourceRef: string;
  sourceBase: string;
  weftSourceRevision: string;
}

export interface WeftHandoff {
  schemaVersion: 1;
  id: string;
  requestDigest: string;
  requestId: string;
  scope: Scope;
  submittedBy: string;
  authenticationIssuedAt?: number;
  selected: WeftSelection;
  binding: WeftBinding;
  candidateId: string;
  admittedAt: number;
  policyRevision: string;
  goalRevision: string;
  state: "PENDING" | "FROZEN" | "READY" | "REJECTED";
  reason?: string;
  sourceCommit?: string;
  sourceManifestDigest?: string;
  mappingDigest?: string;
  provenanceDigest?: string;
}

export interface WeftWorkspaceView {
  schemaVersion: 1;
  scope: Scope;
  binding: WeftBinding | null;
  canSubmit: boolean;
  observedAt: string | null;
  head: { revision: number; root: string; privacyGeneration: number } | null;
  activity: { kind: string; revision: number | null; actor: string | null; detail: string }[];
  conflicts: { id: string; actor: string; sharedRevision: number; pathCount: number }[];
  participants: null;
  replicas: null;
  handoffs: WeftHandoff[];
  error?: string;
}
