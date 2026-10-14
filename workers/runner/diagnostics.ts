// SPDX-License-Identifier: Apache-2.0
import { parseStrictJson, sha256 } from '../../packages/protocol/src/index';

export const AUTHORING_DIAGNOSTIC_RECIPE = '/opt/confidence/authoring-diagnostic.mjs';
export const DIAGNOSTIC_OUTPUT_LIMIT = 16_384;
export type DiagnosticStatus = 'PASS' | 'FAIL' | 'ERROR' | 'SKIPPED';
export interface DiagnosticCheck { name: string; status: DiagnosticStatus; summary: string }
export interface DiagnosticResult {
  schemaVersion: 1; kind: 'authoring-diagnostic'; status: 'PASS' | 'FAIL' | 'ERROR';
  checks: DiagnosticCheck[]; acceptanceEligible: false;
}
export interface DiagnosticCheckpoint { commit: string | null; inventoryDigest: string | null }
export interface DiagnosticObservation {
  schemaVersion: 1; producer: 'host-observed-authoring-command'; trustClass: 'authoring-generation-diagnostic';
  generation: string; command: { argv: string[]; cwd: '/workspace'; recipe: 'public-demo-v1'; timeoutMs: 10000; maximumOutputBytes: 16384 };
  startedAt: string; completedAt: string; before: DiagnosticCheckpoint | null; after: DiagnosticCheckpoint | null;
  sourceCoherence: 'MATCHING_BOUNDARIES' | 'CHANGED' | 'UNKNOWN'; snapshotAtomic: false;
  result: DiagnosticResult; outputDigest: string | null; exitCode: number | null; outputTruncated: boolean;
  acceptanceEligible: false; limitations: string[];
}
const statuses = new Set(['PASS', 'FAIL', 'ERROR', 'SKIPPED']);
const errorResult = (summary: string): DiagnosticResult => ({ schemaVersion: 1, kind: 'authoring-diagnostic', status: 'ERROR', checks: [{ name: 'diagnostic-capture', status: 'ERROR', summary }], acceptanceEligible: false });
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const only = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).every(key => fields.includes(key));

/** Keep output strictly in the diagnostic class. Unknown/duplicate fields fail closed. */
export function parseDiagnosticResult(stdout: Uint8Array, exitCode: number | null, truncated: boolean): DiagnosticResult {
  if (truncated || stdout.byteLength > DIAGNOSTIC_OUTPUT_LIMIT || exitCode !== 0) return errorResult('The bounded authoring diagnostic command did not complete with usable output.');
  try {
    const value = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(stdout));
    if (!record(value) || !only(value, ['schemaVersion', 'kind', 'status', 'checks', 'limits', 'acceptanceEligible']) || value.schemaVersion !== 1 || value.kind !== 'authoring-diagnostic' || value.acceptanceEligible !== false || !['PASS', 'FAIL', 'ERROR'].includes(value.status as string) || !Array.isArray(value.checks) || !value.checks.length || value.checks.length > 18) throw new Error('DIAGNOSTIC_SHAPE');
    const checks = value.checks.map((check): DiagnosticCheck => {
      if (!record(check) || !only(check, ['name', 'status', 'summary']) || typeof check.name !== 'string' || !/^[a-zA-Z0-9:./_-]{1,300}$/.test(check.name) || !statuses.has(check.status as string) || typeof check.summary !== 'string' || check.summary.length > 1024) throw new Error('DIAGNOSTIC_CHECK_SHAPE');
      return { name: check.name, status: check.status as DiagnosticStatus, summary: check.summary };
    });
    if (new Set(checks.map(check => check.name)).size !== checks.length) throw new Error('DIAGNOSTIC_CHECK_DUPLICATE');
    if (value.limits !== undefined && (!record(value.limits) || !only(value.limits, ['maximumPaths', 'maximumOutputBytes', 'syntaxTimeoutMs', 'protectedAcceptance']) || value.limits.maximumPaths !== 16 || value.limits.maximumOutputBytes !== DIAGNOSTIC_OUTPUT_LIMIT || value.limits.syntaxTimeoutMs !== 2000 || value.limits.protectedAcceptance !== false)) throw new Error('DIAGNOSTIC_LIMIT_SHAPE');
    const derived = checks.some(check => check.status === 'ERROR') ? 'ERROR' : checks.some(check => check.status === 'FAIL') ? 'FAIL' : 'PASS';
    if (derived !== value.status) throw new Error('DIAGNOSTIC_STATUS_CONFLICT');
    return { schemaVersion: 1, kind: 'authoring-diagnostic', status: derived, checks, acceptanceEligible: false };
  } catch { return errorResult('The authoring diagnostic output was missing, malformed or outside its closed profile.'); }
}

export function sourceCoherence(before: DiagnosticCheckpoint | null, after: DiagnosticCheckpoint | null): DiagnosticObservation['sourceCoherence'] {
  if (!before || !after || !before.inventoryDigest || !after.inventoryDigest || !/^sha256:[a-f0-9]{64}$/.test(before.inventoryDigest) || !/^sha256:[a-f0-9]{64}$/.test(after.inventoryDigest)) return 'UNKNOWN';
  return before.commit === after.commit && before.inventoryDigest === after.inventoryDigest ? 'MATCHING_BOUNDARIES' : 'CHANGED';
}

export async function runAuthoringDiagnostic(options: {
  generation: string; allowedPaths: string[]; checkpoint: () => Promise<DiagnosticCheckpoint | null>;
  execute: (command: DiagnosticObservation['command']) => Promise<{ stdout: Uint8Array; exitCode: number | null; truncated: boolean }>;
  now?: () => string;
}): Promise<DiagnosticObservation> {
  if (!options.generation || options.generation.length > 128 || !options.allowedPaths.length || options.allowedPaths.length > 16 || new Set(options.allowedPaths).size !== options.allowedPaths.length || options.allowedPaths.some(path => !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.mjs$/.test(path) || path.length > 256 || path.startsWith('-') || path.split('/').some(part => part === '.' || part === '..'))) throw new Error('DIAGNOSTIC_PROFILE_UNAVAILABLE');
  const now = options.now ?? (() => new Date().toISOString());
  const command: DiagnosticObservation['command'] = { argv: ['node', AUTHORING_DIAGNOSTIC_RECIPE, ...options.allowedPaths], cwd: '/workspace', recipe: 'public-demo-v1', timeoutMs: 10000, maximumOutputBytes: DIAGNOSTIC_OUTPUT_LIMIT };
  const startedAt = now(); let before: DiagnosticCheckpoint | null = null, after: DiagnosticCheckpoint | null = null;
  let result = errorResult('The authoring generation did not provide a completed bounded command observation.'), outputDigest: string | null = null, exitCode: number | null = null, outputTruncated = false;
  try { before = await options.checkpoint(); } catch { /* capture uncertainty remains visible */ }
  try {
    const output = await options.execute(command); exitCode = output.exitCode; outputTruncated = output.truncated || output.stdout.byteLength > DIAGNOSTIC_OUTPUT_LIMIT;
    if (!outputTruncated) outputDigest = await sha256(output.stdout);
    result = parseDiagnosticResult(output.stdout, exitCode, outputTruncated);
  } catch { /* no failed command or missing response becomes PASS */ }
  try { after = await options.checkpoint(); } catch { /* capture uncertainty remains visible */ }
  return { schemaVersion: 1, producer: 'host-observed-authoring-command', trustClass: 'authoring-generation-diagnostic', generation: options.generation, command, startedAt, completedAt: now(), before, after,
    sourceCoherence: sourceCoherence(before, after), snapshotAtomic: false, result, outputDigest, exitCode, outputTruncated, acceptanceEligible: false, limitations: [
      'The writable authoring generation can influence its source and diagnostic execution. This observation cannot satisfy protected acceptance.',
      'Matching source boundaries do not establish an atomic snapshot or exclude an intervening edit that was reverted.',
      'The public focused probe covers only its declared in-memory API check; external protected checks remain independent.',
    ] };
}
