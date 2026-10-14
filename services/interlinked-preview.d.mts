export type InterlinkedStatus = 'NO_BLOCKING_FINDINGS' | 'FINDINGS' | 'UNAVAILABLE' | 'ERROR';
export interface InterlinkedFailure { path: string; tool: 'pre_block' | 'biome' | 'tsc' | 'pre_warn'; code: string; line: number; column?: number; message: string; severity: 'error' | 'warning'; hint?: string; }
export interface InterlinkedObservation {
  schemaVersion: 1; kind: 'interlinked-preview'; producer: 'host-invoked-interlinked-cli'; trustClass: 'authoring-generation-diagnostic';
  acceptanceEligible: false; generation: string; status: InterlinkedStatus; blocking: boolean; reason: string;
  startedAt: string; completedAt: string; elapsedMs: number; cliElapsedMs: number | null; failures: InterlinkedFailure[];
  coverage: { status: 'NOT_REPORTED'; typescriptTargetPaths: string[]; typescriptExcludedPaths: string[]; limitations: string[] };
  sourceCoherence: 'UNKNOWN' | 'COHERENT' | 'CHANGED'; inputDigest?: string;
  identity?: { cliPath: string; cliEntryDigest: string; nodeVersion: string; nodePath: string; adapter: string };
  before?: { entries: { path: string; digest: string | null }[]; digest: string; scope: string };
  after?: { entries: { path: string; digest: string | null }[]; digest: string; scope: string };
  process?: { exitCode: number | null; signal: string | null; terminationObserved: boolean; stdoutBytes: number; stderrBytes: number };
  capture?: { stdout: string; stderr: string; stdoutDigest: string; stderrDigest: string };
  limits: typeof INTERLINKED_PREVIEW_LIMITS;
}
export const INTERLINKED_PREVIEW_LIMITS: Readonly<{ paths: number; fileBytes: number; inputBytes: number; stdoutBytes: number; stderrBytes: number; failures: number; timeoutMs: number; maximumTimeoutMs: number; cleanupMs: number; feedbackBytes: number }>;
export type PreviewLifecycle = { phase: 'PREPARING' } | { phase: 'SPAWNED'; pid?: number } | { phase: 'SETTLED'; pid?: number; terminationObserved: boolean };
export function runInterlinkedPreview(options: { cwd: string; files: Record<string, string>; allowedPaths: string[]; cliPath?: string; generation?: string | number; nodePath?: string; timeoutMs?: number; signal?: AbortSignal; onLifecycle?: (event: PreviewLifecycle) => Promise<void> | void; homePath?: string; temporaryPath?: string }): Promise<InterlinkedObservation>;
export function interlinkedPreviewFeedback(observation: InterlinkedObservation): { kind: string; status: InterlinkedStatus; acceptanceEligible: false; reason: string; coverage: string; failures: Omit<InterlinkedFailure, 'tool' | 'column'>[]; omittedFailures: number };
export const interlinkedFeedback: typeof interlinkedPreviewFeedback;
