// SPDX-License-Identifier: Apache-2.0
import { validateSessionCapture } from "../../packages/protocol/src/session-context";
import { canonicalize } from "../../packages/protocol/src/index";
import { sourceAdvisoryFitsPrompt } from "../../packages/protocol/src/source-advisory";
import { requireValue } from "../shared/errors";
interface PromptAssignment { assignment?: string; goalRevision: string; workBase: string; allowedPaths?: string[] }
interface PromptSourceAssignment { allowedPaths?: string[]; readOnlyContextPaths?: string[] }
interface PromptSourceManifest { entries: { path: string; digest: string }[] }
const MAX_ASSIGNED_SOURCE_BYTES = 128 * 1024;
const MAX_READ_ONLY_SOURCE_BYTES = 16 * 1024;

/** Select immutable manifest bytes for both runner rendering and authority replay. */
export async function promptSourceContext(attempt: PromptSourceAssignment, manifest: PromptSourceManifest, readFile: (digest: string, maximumBytes: number) => Promise<Uint8Array>): Promise<{ editableSource: Record<string, string>; readOnlySource: Record<string, string> }> {
  const editablePaths = attempt.allowedPaths ?? [], readOnlyPaths = attempt.readOnlyContextPaths ?? [];
  requireValue(editablePaths.length > 0 && readOnlyPaths.length <= 1 && new Set([...editablePaths, ...readOnlyPaths]).size === editablePaths.length + readOnlyPaths.length, "ASSIGNMENT_CONTEXT_PATHS_INVALID", 409);
  const editableSource: Record<string, string> = {}, readOnlySource: Record<string, string> = {};
  const selected = new Set([...editablePaths, ...readOnlyPaths]);
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    if (!selected.has(entry.path)) continue;
    const readOnly = readOnlyPaths.includes(entry.path);
    const maximumBytes = readOnly ? MAX_READ_ONLY_SOURCE_BYTES : MAX_ASSIGNED_SOURCE_BYTES;
    const bytes = await readFile(entry.digest, maximumBytes);
    requireValue(bytes.length <= maximumBytes, "ASSIGNMENT_CONTEXT_LIMIT", 413);
    totalBytes += bytes.length;
    requireValue(totalBytes <= MAX_ASSIGNED_SOURCE_BYTES, "ASSIGNMENT_CONTEXT_LIMIT", 413);
    (readOnly ? readOnlySource : editableSource)[entry.path] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  // A write grant may target a new file. A context-only path must already
  // exist in the immutable checkpoint or the repair context is incomplete.
  requireValue(Object.keys(readOnlySource).length === readOnlyPaths.length, "ASSIGNMENT_CONTEXT_SOURCE_MISSING", 409);
  return { editableSource, readOnlySource };
}

/** Host-rendered assignment bytes; retained diagnostics keep their weaker class. */
export function authoringPrompt(attempt: PromptAssignment, sourceManifestDigest: string, sourceContext: Record<string, string>, diagnostic: unknown = null, retainedConversation: unknown = null, sourceAdvisory: unknown = null, readOnlySource: Record<string, string> = {}): string {
  const contextOnlyPaths = Object.keys(readOnlySource);
  const base = { assignment: attempt.assignment ?? "", goalRevision: attempt.goalRevision, sourceCommit: attempt.workBase, sourceManifestDigest,
    untrustedSource: sourceContext, ...(contextOnlyPaths.length ? { sourcePermissions: { editablePaths: attempt.allowedPaths ?? [], contextOnlyPaths }, untrustedReadOnlySource: readOnlySource } : {}),
    authoringDiagnostic: diagnostic, retainedConversation };
  if (sourceAdvisory) {
    const enriched = canonicalize({ ...base, untrustedSourceAdvisory: sourceAdvisory });
    if (sourceAdvisoryFitsPrompt(enriched)) return enriched;
  }
  return canonicalize(base);
}
export interface SessionMetadata { sessionId: string; selectedEntry: string | null; format: "pi-sdk-1.0.2-session-entries-v1" }
export function sessionMetadata(raw: Uint8Array): SessionMetadata { return validateSessionCapture(raw); }
