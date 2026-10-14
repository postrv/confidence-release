import type { SourceManifest } from '../packages/protocol/src/types.ts';

export interface NarsilContextLimits {
  /** maxQueries counts selection calls; readiness has a separate fixed 128-call cap, within this deadline/output budget. */
  deadlineMs: number; maxQueries: number; maxAnalyzerBytes: number;
  maxOutputBytes: number; maxExcerptBytes: number; maxExcerpts: number; maxLinesPerExcerpt: number;
}
export interface NarsilContextConfig {
  enabled?: boolean; includeSmallProjects?: boolean; binaryPath?: string;
  expectedVersion?: string; expectedBinaryDigest?: string;
  limits?: Partial<NarsilContextLimits>;
}
export interface NarsilContextInput {
  sourceCommit: string; sourceManifestDigest: string; manifest: SourceManifest;
  filesBase64: Record<string, string>; assignedPaths: string[]; config?: NarsilContextConfig;
}
export interface SourceAdvisory {
  schemaVersion: 1; kind: 'source-advisory'; sourceCommit: string; sourceManifestDigest: string;
  selectorVersion: 'narsil-context-v1'; acceptanceEligible: false; authorityEligible: false;
  status: 'READY' | 'SKIPPED' | 'UNAVAILABLE' | 'ERROR'; reason: string;
  analyzer: { version: string | null; binaryDigest: string | null; configDigest: string };
  limits: NarsilContextLimits;
  excerpts: { path: string; fileDigest: string; startLine: number; endLine: number; text: string; digest: string }[];
  /** Completeness describes indexing and bounded selection, never proof that a language's dependency graph is exhaustive. */
  coverage: { sourceFiles: number; sourceBytes: number; indexedFiles: number | null; assignedPaths: string[]; queriedPaths: string[]; queryCount: number; incomplete: boolean };
}
export function buildNarsilContext(input: NarsilContextInput): Promise<SourceAdvisory>;
