// SPDX-License-Identifier: Apache-2.0
import { canonicalize, sha256 } from './index.ts';
import type { SourceManifest } from './types.ts';

export const SOURCE_ADVISORY_BYTES = 32768;
export const SOURCE_ADVISORY_PROMPT_BYTES = 128 * 1024;

/** Leave 64 KiB below the broker's request ceiling for the SDK envelope and follow-up rounds. */
export function sourceAdvisoryFitsPrompt(renderedPrompt: string): boolean {
  return new TextEncoder().encode(JSON.stringify(renderedPrompt)).byteLength <= SOURCE_ADVISORY_PROMPT_BYTES;
}

const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, maximum: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
// Same individual-path profile as the authority kernel's valid_path grant check.
const portablePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 240
  && !/[^\x20-\x7e]|[\\<>:"|?*]/.test(value)
  && value.split('/').every(part => part.length > 0 && part.length <= 80 && !['.', '..'].includes(part)
    && part.toLowerCase() !== '.git' && !/[ .]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
export interface SourceExcerpt { path: string; fileDigest: string; startLine: number; endLine: number; text: string; digest: string }
export interface SourceAdvisory {
  schemaVersion: 1; kind: 'source-advisory'; sourceCommit: string; sourceManifestDigest: string;
  selectorVersion: 'narsil-context-v1'; acceptanceEligible: false; authorityEligible: false;
  status: 'READY' | 'SKIPPED' | 'UNAVAILABLE' | 'ERROR'; reason: string;
  analyzer: { version: string | null; binaryDigest: string | null; configDigest: string };
  limits: { deadlineMs: number; maxQueries: number; maxAnalyzerBytes: number; maxOutputBytes: 32768; maxExcerptBytes: 16384; maxExcerpts: 12; maxLinesPerExcerpt: 80 };
  excerpts: SourceExcerpt[];
  coverage: { sourceFiles: number; sourceBytes: number; indexedFiles: number | null; assignedPaths: string[]; queriedPaths: string[]; queryCount: number; incomplete: boolean };
}

/** Validate advisory source claims independently of the analyzer; never promote them to acceptance. */
export async function validateSourceAdvisory(value: unknown, expected: {
  sourceCommit: string; sourceManifestDigest: string; manifest: SourceManifest; assignedPaths: string[];
  readFile: (digest: string) => Promise<Uint8Array>;
}): Promise<SourceAdvisory> {
  function reject(): never { throw new Error('SOURCE_ADVISORY_INVALID'); }
  if (!isRecord(value) || !only(value, ['schemaVersion', 'kind', 'sourceCommit', 'sourceManifestDigest', 'selectorVersion', 'acceptanceEligible', 'authorityEligible', 'status', 'reason', 'analyzer', 'limits', 'excerpts', 'coverage'])
    || new TextEncoder().encode(canonicalize(value)).length > SOURCE_ADVISORY_BYTES
    || value.schemaVersion !== 1 || value.kind !== 'source-advisory' || value.selectorVersion !== 'narsil-context-v1'
    || value.sourceCommit !== expected.sourceCommit || value.sourceManifestDigest !== expected.sourceManifestDigest
    || value.acceptanceEligible !== false || value.authorityEligible !== false || !['READY', 'SKIPPED', 'UNAVAILABLE', 'ERROR'].includes(value.status)
    || typeof value.reason !== 'string' || value.reason.length > 256) reject();
  const { analyzer, limits, coverage, excerpts } = value;
  if (!isRecord(analyzer) || !only(analyzer, ['version', 'binaryDigest', 'configDigest']) || !hash(analyzer.configDigest)
    || !(analyzer.version === null || typeof analyzer.version === 'string' && /^\d+\.\d+\.\d+$/.test(analyzer.version))
    || !(analyzer.binaryDigest === null || hash(analyzer.binaryDigest))
    || value.status === 'READY' && (analyzer.version === null || analyzer.binaryDigest === null)) reject();
  if (!isRecord(limits) || !only(limits, ['deadlineMs', 'maxQueries', 'maxAnalyzerBytes', 'maxOutputBytes', 'maxExcerptBytes', 'maxExcerpts', 'maxLinesPerExcerpt'])
    || !integer(limits.deadlineMs, 30000) || !integer(limits.maxQueries, 32) || !integer(limits.maxAnalyzerBytes, 4 * 1024 * 1024)
    || limits.maxOutputBytes !== SOURCE_ADVISORY_BYTES || limits.maxExcerptBytes !== 16384 || limits.maxExcerpts !== 12 || limits.maxLinesPerExcerpt !== 80) reject();
  const entries = new Map(expected.manifest.entries.map(entry => [entry.path, entry]));
  const paths = (items: unknown, max: number, existing = true): items is string[] => Array.isArray(items) && items.length <= max && new Set(items).size === items.length && items.every(item => portablePath(item) && (!existing || entries.has(item)));
  if (!isRecord(coverage) || !only(coverage, ['sourceFiles', 'sourceBytes', 'indexedFiles', 'assignedPaths', 'queriedPaths', 'queryCount', 'incomplete'])
    || coverage.sourceFiles !== entries.size || coverage.sourceBytes !== expected.manifest.entries.reduce((sum, entry) => sum + Number(entry.bytes), 0)
    || !(coverage.indexedFiles === null || integer(coverage.indexedFiles, entries.size)) || !integer(coverage.queryCount, limits.maxQueries)
    || !paths(coverage.assignedPaths, 16, false) || !coverage.assignedPaths.length || canonicalize([...coverage.assignedPaths].sort()) !== canonicalize([...expected.assignedPaths].sort())
    || value.status === 'READY' && coverage.assignedPaths.some(path => !entries.has(path))
    || !paths(coverage.queriedPaths, 16) || typeof coverage.incomplete !== 'boolean'
    || !Array.isArray(excerpts) || excerpts.length > limits.maxExcerpts || value.status !== 'READY' && excerpts.length !== 0) reject();
  let total = 0; const seen = new Set<string>(), files = new Map<string, string[]>();
  for (const excerpt of excerpts) {
    if (!isRecord(excerpt) || !only(excerpt, ['path', 'fileDigest', 'startLine', 'endLine', 'text', 'digest']) || typeof excerpt.path !== 'string'
      || !integer(excerpt.startLine, 1024 * 1024) || excerpt.startLine < 1 || !integer(excerpt.endLine, 1024 * 1024)
      || excerpt.endLine < excerpt.startLine || excerpt.endLine - excerpt.startLine + 1 > limits.maxLinesPerExcerpt
      || typeof excerpt.text !== 'string' || !hash(excerpt.digest)) reject();
    const entry = entries.get(excerpt.path), key = `${excerpt.path}:${excerpt.startLine}:${excerpt.endLine}`;
    if (!entry || entry.digest !== excerpt.fileDigest || seen.has(key)) reject();
    seen.add(key); total += new TextEncoder().encode(excerpt.text).length; if (total > limits.maxExcerptBytes) reject();
    let lines = files.get(entry.digest);
    if (!lines) {
      const raw = await expected.readFile(entry.digest);
      if (raw.length !== Number(entry.bytes) || await sha256(raw) !== entry.digest) reject();
      lines = new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\n'); files.set(entry.digest, lines);
    }
    if (excerpt.endLine > lines.length || lines.slice(excerpt.startLine - 1, excerpt.endLine).join('\n') !== excerpt.text || await sha256(excerpt.text) !== excerpt.digest) reject();
  }
  return value as SourceAdvisory;
}
