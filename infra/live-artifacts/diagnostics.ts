// SPDX-License-Identifier: Apache-2.0
import { digestBytes } from '../../workers/shared/errors';

const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'SuppressedError', 'ArtifactsError']);
const ARTIFACTS_CODES = new Set(['ALREADY_EXISTS', 'NOT_FOUND', 'CREATE_IN_PROGRESS', 'IMPORT_IN_PROGRESS', 'FORK_IN_PROGRESS', 'INVALID_INPUT', 'INVALID_REPO_NAME', 'INVALID_TTL', 'INVALID_URL', 'REMOTE_AUTH_REQUIRED', 'UPSTREAM_UNAVAILABLE', 'MEMORY_LIMIT', 'INTERNAL_ERROR']);
export interface SafeDiagnosticError {
  type: string; name: string; artifactsCode?: string; numericCode?: number;
  messageDigest?: string; messageChars?: number; messageTruncated?: boolean;
}
export type SeedStage = 'get-repository' | 'read-info' | 'prepare-pack' | 'create-token' | 'receive-pack-fetch' | 'receive-pack-body' | 'parse-report' | 'revoke-token' | 'release-handle';
export interface SeedDiagnostics {
  stages: { stage: SeedStage; state: 'MAY_HAVE_DISPATCHED' | 'ACKNOWLEDGED' | 'UNKNOWN'; elapsedMs: number; detail?: Record<string, unknown>; error?: SafeDiagnosticError }[];
  revocation: 'NOT_CREATED' | 'MAY_HAVE_DISPATCHED' | 'ACKNOWLEDGED' | 'UNKNOWN';
  primaryError?: SafeDiagnosticError; revocationError?: SafeDiagnosticError; releaseError?: SafeDiagnosticError;
}
function field(value: unknown, key: string): unknown {
  try { return value !== null && (typeof value === 'object' || typeof value === 'function') ? (value as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}
export async function diagnosticError(value: unknown): Promise<SafeDiagnosticError> {
  const name = field(value, 'name'), code = field(value, 'code'), numeric = field(value, 'numericCode');
  const result: SafeDiagnosticError = { type: value === null ? 'null' : typeof value, name: typeof name === 'string' && ERROR_NAMES.has(name) ? name : 'UNKNOWN' };
  if (typeof code === 'string' && ARTIFACTS_CODES.has(code)) {
    result.artifactsCode = code;
    if (Number.isSafeInteger(numeric) && (numeric as number) >= 10000 && (numeric as number) <= 10999) result.numericCode = numeric as number;
  }
  const message = typeof value === 'string' ? value : field(value, 'message');
  if (typeof message === 'string') {
    const bounded = message.slice(0, 8192);
    result.messageDigest = await digestBytes(new TextEncoder().encode(bounded)); result.messageChars = bounded.length; result.messageTruncated = message.length > bounded.length;
  }
  return result;
}
export function diagnosticContentType(value: string | null): string {
  const mime = value?.split(';', 1)[0]?.trim().toLowerCase();
  return ['application/x-git-receive-pack-result', 'application/json', 'text/plain', 'text/html', 'application/octet-stream'].includes(mime ?? '') ? mime! : value === null ? 'MISSING' : 'OTHER';
}
