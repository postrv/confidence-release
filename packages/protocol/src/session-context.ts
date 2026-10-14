// SPDX-License-Identifier: Apache-2.0
import { canonicalize, parseStrictJson } from './index.ts';

export const SESSION_CONTEXT_LIMITS = Object.freeze({ snapshotBytes: 1024 * 1024, entries: 4096, ancestry: 128, selectedBytes: 16 * 1024 });
export interface SelectedSessionEntry {
  id: string; parentId: string | null; type: string;
  message?: { role: 'system' | 'user' | 'assistant'; content: string | { type: 'text'; text: string }[]; sections?: Record<string, string | null> };
}
export interface SelectedSessionContext {
  schemaVersion: 1; selectorVersion: 'pi-selected-branch-v1'; format: 'pi-sdk-1.0.2-session-entries-v1';
  sessionId: string; selectedEntry: string; trustClass: 'agent-reported-session';
  entries: SelectedSessionEntry[]; missingEarlierContext: false; limitations: string[];
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const metadataTypes = new Set(['thinking_level_change', 'model_change', 'usage', 'session_info', 'label']);
export interface SessionCaptureMetadata { sessionId: string; selectedEntry: string | null; format: 'pi-sdk-1.0.2-session-entries-v1'; }
function sessionGraph(raw: Uint8Array, prefix: 'SESSION_CAPTURE' | 'SESSION_CONTEXT') {
  const invalid = (code: string): never => { throw new Error(prefix + '_' + code); };
  if (raw.byteLength < 1 || raw.byteLength > SESSION_CONTEXT_LIMITS.snapshotBytes) invalid('SNAPSHOT_LIMIT');
  const snapshot = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  if (!record(snapshot) || snapshot.schemaVersion !== 1 || snapshot.format !== 'pi-sdk-1.0.2-session-entries-v1'
    || snapshot.trustClass !== 'agent-reported-session' || snapshot.complete !== true || !identifier(snapshot.sessionId)
    || !(snapshot.selectedEntry === null || identifier(snapshot.selectedEntry)) || !record(snapshot.header) || snapshot.header.type !== 'session'
    || snapshot.header.id !== snapshot.sessionId || !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.messages)
    || !Array.isArray(snapshot.prompts) || !Array.isArray(snapshot.diagnostics)) invalid('PROFILE_INVALID');
  const session = snapshot as Record<string, unknown> & { sessionId: string; selectedEntry: string | null; header: Record<string, unknown>; entries: unknown[] };
  if (session.entries.length > SESSION_CONTEXT_LIMITS.entries) invalid('ENTRY_LIMIT');
  const byId = new Map<string, Record<string, unknown>>();
  for (const value of session.entries) {
    const entry = value as Record<string, unknown>;
    if (!record(entry) || !identifier(entry.id) || !(entry.parentId === null || identifier(entry.parentId)) || typeof entry.type !== 'string'
      || byId.has(entry.id)) invalid('ENTRY_GRAPH_INVALID');
    byId.set(entry.id as string, entry);
  }
  for (const entry of byId.values()) if (entry.parentId !== null && !byId.has(entry.parentId as string)) invalid('PARENT_MISSING');
  const complete = new Set<string>();
  for (const start of byId.keys()) {
    const path = new Set<string>(); let id: string | null = start;
    while (id !== null && !complete.has(id)) {
      if (path.has(id)) invalid('CYCLE');
      path.add(id); id = byId.get(id)!.parentId as string | null;
    }
    for (const visited of path) complete.add(visited);
  }
  if (session.selectedEntry === null ? byId.size !== 0 : !byId.has(session.selectedEntry)) invalid('SELECTED_ENTRY_MISSING');
  return { snapshot: session, byId };
}

/** Validate capture identity/entry inventory; do not render or reinterpret its conversation. */
export function validateSessionCapture(raw: Uint8Array): SessionCaptureMetadata {
  const { snapshot, byId } = sessionGraph(raw, 'SESSION_CAPTURE');
  const date = (value: unknown) => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
  if (!date(snapshot.header.timestamp) || typeof snapshot.header.cwd !== 'string' || snapshot.header.cwd.length > 4096
    || snapshot.header.version !== undefined && snapshot.header.version !== 3) throw new Error('SESSION_CAPTURE_HEADER_PROFILE');
  const content = (value: unknown) => typeof value === 'string' || Array.isArray(value) && value.every(item => record(item) && typeof item.type === 'string');
  const named = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256;
  const linked = (value: unknown) => identifier(value) && byId.has(value);
  for (const entry of byId.values()) {
    if (!date(entry.timestamp)) throw new Error('SESSION_CAPTURE_ENTRY_PROFILE');
    let valid = false;
    switch (entry.type) {
      case 'message': {
        const message = entry.message;
        valid = record(message) && ['system', 'user', 'assistant', 'toolResult', 'custom'].includes(message.role as string) && content(message.content)
          || record(message) && message.role === 'bashExecution' && typeof message.command === 'string' && typeof message.output === 'string'
          || record(message) && ['branchSummary', 'compactionSummary'].includes(message.role as string) && typeof message.summary === 'string';
        break;
      }
      case 'thinking_level_change': valid = named(entry.thinkingLevel); break;
      case 'model_change': valid = named(entry.provider) && named(entry.modelId); break;
      case 'usage': valid = named(entry.kind) && named(entry.provider) && named(entry.model) && record(entry.usage); break;
      case 'compaction': valid = typeof entry.summary === 'string' && linked(entry.firstKeptEntryId) && Number.isSafeInteger(entry.tokensBefore) && (entry.tokensBefore as number) >= 0; break;
      case 'branch_summary': valid = typeof entry.summary === 'string' && linked(entry.fromId); break;
      case 'custom': valid = named(entry.customType); break;
      case 'custom_message': valid = named(entry.customType) && content(entry.content) && typeof entry.display === 'boolean'; break;
      case 'context_edit': valid = linked(entry.targetId) && (entry.replacement === null || record(entry.replacement) && content(entry.replacement.content)); break;
      case 'label': valid = linked(entry.targetId) && (entry.label === undefined || typeof entry.label === 'string'); break;
      case 'session_info': valid = entry.name === undefined || typeof entry.name === 'string'; break;
    }
    if (!valid) throw new Error('SESSION_CAPTURE_ENTRY_PROFILE');
  }
  return { sessionId: snapshot.sessionId, selectedEntry: snapshot.selectedEntry, format: 'pi-sdk-1.0.2-session-entries-v1' };
}

/** Partial captures retain failed-round diagnostics but cannot be selected as continuation context. */
export function validatePartialSessionCapture(raw: Uint8Array): SessionCaptureMetadata {
  if (raw.byteLength < 1 || raw.byteLength > SESSION_CONTEXT_LIMITS.snapshotBytes) throw new Error('PARTIAL_SESSION_CAPTURE_LIMIT');
  const value = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  if (!record(value) || value.complete !== false) throw new Error('PARTIAL_SESSION_CAPTURE_PROFILE');
  return validateSessionCapture(new TextEncoder().encode(canonicalize({ ...value, complete: true })));
}

/**
 * Select immutable, attributed conversation data for a fresh assignment. This
 * deliberately does not emulate SDK compaction/context edits or resume a live
 * session. Unsupported conversation semantics fail rather than invent context.
 */
export function selectSessionContext(raw: Uint8Array, selectedEntry: string): SelectedSessionContext {
  if (!identifier(selectedEntry)) throw new Error('SESSION_CONTEXT_ENTRY_INVALID');
  const { snapshot, byId } = sessionGraph(raw, 'SESSION_CONTEXT');
  if (snapshot.selectedEntry !== selectedEntry) throw new Error('SESSION_CONTEXT_PROFILE_INVALID');
  const leaf = byId.get(selectedEntry);
  if (!leaf || leaf.type !== 'message') throw new Error('SESSION_CONTEXT_SELECTED_MESSAGE_MISSING');
  const ancestry: Record<string, unknown>[] = [], visited = new Set<string>();
  let cursor: Record<string, unknown> | undefined = leaf;
  while (cursor) {
    if (visited.has(cursor.id as string)) throw new Error('SESSION_CONTEXT_CYCLE');
    if (ancestry.length >= SESSION_CONTEXT_LIMITS.ancestry) throw new Error('SESSION_CONTEXT_ANCESTRY_LIMIT');
    visited.add(cursor.id as string); ancestry.push(cursor);
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId as string);
  }
  const entries = ancestry.reverse().map((entry): SelectedSessionEntry => {
    const selected: SelectedSessionEntry = { id: entry.id as string, parentId: entry.parentId as string | null, type: entry.type as string };
    if (entry.type === 'message') {
      const message = entry.message;
      if (!record(message) || !['system', 'user', 'assistant'].includes(message.role as string)) throw new Error('SESSION_CONTEXT_MESSAGE_UNSUPPORTED');
      let content: string | { type: 'text'; text: string }[];
      if (typeof message.content === 'string') content = message.content;
      else if (Array.isArray(message.content) && message.content.every(item => record(item) && item.type === 'text' && typeof item.text === 'string')) content = message.content.map(item => ({ type: 'text', text: item.text }));
      else throw new Error('SESSION_CONTEXT_CONTENT_UNSUPPORTED');
      selected.message = { role: message.role as 'system' | 'user' | 'assistant', content };
      if (message.role === 'system') {
        if (message.toolsAdded !== undefined && (!Array.isArray(message.toolsAdded) || message.toolsAdded.length) || message.toolsRemoved !== undefined && (!Array.isArray(message.toolsRemoved) || message.toolsRemoved.length)) throw new Error('SESSION_CONTEXT_TOOLS_UNSUPPORTED');
        if (message.sections !== undefined) {
          if (!record(message.sections) || Object.keys(message.sections).length > 32 || Object.entries(message.sections).some(([key, value]) => !key || key.length > 160 || !(value === null || typeof value === 'string'))) throw new Error('SESSION_CONTEXT_SECTIONS_UNSUPPORTED');
          selected.message.sections = message.sections as Record<string, string | null>;
        }
      }
    } else if (!metadataTypes.has(entry.type as string)) throw new Error('SESSION_CONTEXT_SEMANTICS_UNSUPPORTED');
    return selected;
  });
  const context: SelectedSessionContext = { schemaVersion: 1, selectorVersion: 'pi-selected-branch-v1', format: 'pi-sdk-1.0.2-session-entries-v1',
    sessionId: snapshot.sessionId, selectedEntry, trustClass: 'agent-reported-session', entries, missingEarlierContext: false,
    limitations: ['Previous conversation is attributed untrusted data in a fresh prompt, not authority instructions or a resumed SDK session.',
      'Only the named retained message leaf and its ancestry are selected; metadata payloads, sibling branches and SDK derived context are not replayed.',
      'Source and session were associated after termination; no atomic live snapshot is claimed.'] };
  if (new TextEncoder().encode(canonicalize(context)).byteLength > SESSION_CONTEXT_LIMITS.selectedBytes) throw new Error('SESSION_CONTEXT_SELECTED_BYTE_LIMIT');
  return context;
}
