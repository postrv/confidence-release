import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeKernel } from '../../packages/protocol/src/node.ts';
import { selectSessionContext, validateSessionCapture, validatePartialSessionCapture, SESSION_CONTEXT_LIMITS } from '../../packages/protocol/src/session-context.ts';

await initializeKernel();
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function snapshot() {
  return { schemaVersion: 1, format: 'pi-sdk-1.0.2-session-entries-v1', sessionId: 'owned-session', selectedEntry: 'left', complete: true,
    trustClass: 'agent-reported-session', header: { type: 'session', id: 'owned-session', timestamp: '2026-10-05T00:00:00Z', cwd: '/owned' },
    entries: [
      { id: 'root', parentId: null, type: 'message', message: { role: 'system', content: 'Prior host instructions are historical data.', sections: { task: 'Old task' } } },
      { id: 'user', parentId: 'root', type: 'message', message: { role: 'user', content: 'Prior request' } },
      { id: 'left', parentId: 'user', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Selected reply' }] } },
      { id: 'right', parentId: 'user', type: 'message', message: { role: 'assistant', content: 'Sibling must not be selected' } },
    ] as any[], messages: [{ role: 'assistant', content: 'Spoofed aggregate is not selected' }], prompts: [], diagnostics: [] };
}
test('selected SDK ancestry preserves attributed text and excludes siblings and aggregate projections', () => {
  const selected = selectSessionContext(bytes(snapshot()), 'left');
  assert.deepEqual(selected.entries.map(entry => entry.id), ['root', 'user', 'left']);
  assert.equal(selected.entries[0].message?.role, 'system'); assert.deepEqual(selected.entries[0].message?.sections, { task: 'Old task' });
  assert.equal(selected.trustClass, 'agent-reported-session'); assert.equal(selected.missingEarlierContext, false);
  assert(!JSON.stringify(selected).includes('Sibling')); assert(!JSON.stringify(selected).includes('Spoofed'));
  assert.throws(() => selectSessionContext(bytes(snapshot()), 'right'), /PROFILE_INVALID/, 'Only the capsule-recorded selected message is supported');
});
function captureSnapshot() {
  const value = snapshot(); value.header.timestamp = '2026-10-05T00:00:00.000Z';
  value.entries = value.entries.map(entry => ({ ...entry, timestamp: value.header.timestamp }));
  return value;
}
test('partial diagnostic captures retain SDK identity but remain ineligible for continuation', () => {
  const partial = { ...captureSnapshot(), complete: false, previews: [{ kind: 'interlinked-preview', acceptanceEligible: false }] };
  assert.equal(validatePartialSessionCapture(bytes(partial)).sessionId, 'owned-session');
  assert.throws(() => validateSessionCapture(bytes(partial)), /PROFILE_INVALID/);
  assert.throws(() => selectSessionContext(bytes(partial), 'left'), /PROFILE_INVALID/);
  assert.throws(() => validatePartialSessionCapture(bytes(captureSnapshot())), /PARTIAL_SESSION_CAPTURE_PROFILE/);
  partial.entries[1].parentId = 'missing';
  assert.throws(() => validatePartialSessionCapture(bytes(partial)), /PARENT_MISSING/);
});
test('valid large captures remain retained independently of continuation byte and ancestry ceilings', () => {
  const large = captureSnapshot(); large.entries[2].message.content = 'x'.repeat(192 * 1024);
  assert.deepEqual(validateSessionCapture(bytes(large)), { sessionId: 'owned-session', selectedEntry: 'left', format: large.format });
  assert.throws(() => selectSessionContext(bytes(large), 'left'), /SELECTED_BYTE_LIMIT/);
  const deep = captureSnapshot(); deep.entries = Array.from({ length: 256 }, (_, index) => ({ id: index === 255 ? 'left' : 'node-' + index,
    parentId: index ? 'node-' + (index - 1) : null, timestamp: deep.header.timestamp, type: 'message', message: { role: 'user', content: '' } }));
  assert.equal(validateSessionCapture(bytes(deep)).selectedEntry, 'left');
  assert.throws(() => selectSessionContext(bytes(deep), 'left'), /ANCESTRY_LIMIT/);
});
test('capture profile accepts the actual pinned SDK session manager header and entries', async () => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const session = SessionManager.inMemory('/owned');
  session.appendMessage({ role: 'system', content: 'Fixed owned host prompt', timestamp: Date.now() });
  session.appendMessage({ role: 'user', content: 'x'.repeat(192 * 1024), timestamp: Date.now() });
  const raw = bytes({ ...captureSnapshot(), sessionId: session.getSessionId(), selectedEntry: session.getLeafId(), header: session.getHeader(), entries: session.getEntries() });
  assert.deepEqual(validateSessionCapture(raw), { sessionId: session.getSessionId(), selectedEntry: session.getLeafId(), format: 'pi-sdk-1.0.2-session-entries-v1' });
  assert.throws(() => selectSessionContext(raw, session.getLeafId()!), /SELECTED_BYTE_LIMIT/);
});
test('capture validation rejects missing named entries, identity/profile corruption and invalid inventories', () => {
  const missing = captureSnapshot(); missing.entries = [];
  assert.throws(() => validateSessionCapture(bytes(missing)), /SELECTED_ENTRY_MISSING/);
  const header = captureSnapshot(); header.header.id = 'different-session';
  assert.throws(() => validateSessionCapture(bytes(header)), /PROFILE_INVALID/);
  const duplicate = captureSnapshot(); duplicate.entries.push(duplicate.entries[0]);
  assert.throws(() => validateSessionCapture(bytes(duplicate)), /ENTRY_GRAPH_INVALID/);
  const cycle = captureSnapshot(); cycle.entries[0].parentId = 'left';
  assert.throws(() => validateSessionCapture(bytes(cycle)), /CYCLE/);
  const dangling = captureSnapshot(); dangling.entries[1].parentId = 'absent';
  assert.throws(() => validateSessionCapture(bytes(dangling)), /PARENT_MISSING/);
  const profile = captureSnapshot(); profile.entries[1].type = 'unknown-entry-format';
  assert.throws(() => validateSessionCapture(bytes(profile)), /ENTRY_PROFILE/);
  assert.throws(() => validateSessionCapture(new Uint8Array(SESSION_CONTEXT_LIMITS.snapshotBytes + 1)), /SNAPSHOT_LIMIT/);
});
test('capture retains structurally closed SDK compaction/edit records without pretending to replay them', () => {
  const sdk = captureSnapshot(); sdk.entries[1] = { id: 'user', parentId: 'root', timestamp: sdk.header.timestamp, type: 'compaction', summary: 'An attributed summary', firstKeptEntryId: 'root', tokensBefore: 100 };
  sdk.entries.push({ id: 'edit', parentId: 'right', timestamp: sdk.header.timestamp, type: 'context_edit', targetId: 'root', replacement: { content: 'Attributed context edit' } });
  assert.equal(validateSessionCapture(bytes(sdk)).selectedEntry, 'left');
  assert.throws(() => selectSessionContext(bytes(sdk), 'left'), /SEMANTICS_UNSUPPORTED/);
  sdk.entries.at(-1).targetId = 'missing';
  assert.throws(() => validateSessionCapture(bytes(sdk)), /ENTRY_PROFILE/);
});
test('invalid immutable entry identities, missing ancestry, cycles and duplicate raw JSON fail closed', () => {
  const duplicate = snapshot(); duplicate.entries.push(duplicate.entries[0]);
  assert.throws(() => selectSessionContext(bytes(duplicate), 'left'), /ENTRY_GRAPH_INVALID/);
  const missing = snapshot(); missing.entries[1].parentId = 'absent';
  assert.throws(() => selectSessionContext(bytes(missing), 'left'), /PARENT_MISSING/);
  const cycle = snapshot(); cycle.entries[0].parentId = 'left';
  assert.throws(() => selectSessionContext(bytes(cycle), 'left'), /CYCLE/);
  const offBranchCycle = snapshot(); offBranchCycle.entries[3].parentId = 'right';
  assert.throws(() => selectSessionContext(bytes(offBranchCycle), 'left'), /CYCLE/);
  const wrongSession = snapshot(); wrongSession.header.id = 'other-session';
  assert.throws(() => selectSessionContext(bytes(wrongSession), 'left'), /PROFILE_INVALID/);
  assert.throws(() => selectSessionContext(new TextEncoder().encode(JSON.stringify(snapshot()).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')), 'left'));
});
test('unsupported compaction, context edits, tool declarations and nontext data are not approximated', () => {
  for (const type of ['compaction', 'context_edit', 'custom_message', 'branch_summary']) {
    const unsupported = snapshot(); unsupported.entries[1] = { id: 'user', parentId: 'root', type };
    assert.throws(() => selectSessionContext(bytes(unsupported), 'left'), /SEMANTICS_UNSUPPORTED/);
  }
  const image = snapshot(); image.entries[2].message.content = [{ type: 'image', data: 'untrusted' }];
  assert.throws(() => selectSessionContext(bytes(image), 'left'), /CONTENT_UNSUPPORTED/);
  const tools = snapshot(); tools.entries[0].message.toolsAdded = [{ name: 'untrusted-tool' }];
  assert.throws(() => selectSessionContext(bytes(tools), 'left'), /TOOLS_UNSUPPORTED/);
  const incomplete = snapshot(); incomplete.complete = false;
  assert.throws(() => selectSessionContext(bytes(incomplete), 'left'), /PROFILE_INVALID/);
});
test('snapshot, entry, ancestry and selected context ceilings reject rather than truncate history', () => {
  assert.throws(() => selectSessionContext(new Uint8Array(SESSION_CONTEXT_LIMITS.snapshotBytes + 1), 'left'), /SNAPSHOT_LIMIT/);
  const entries = snapshot(); entries.entries = Array.from({ length: SESSION_CONTEXT_LIMITS.entries + 1 }, (_, index) => ({ id: 'node-' + index, parentId: null, type: 'message', message: { role: 'user', content: '' } }));
  assert.throws(() => selectSessionContext(bytes(entries), 'left'), /ENTRY_LIMIT/);
  const chain = snapshot(); chain.entries = Array.from({ length: SESSION_CONTEXT_LIMITS.ancestry + 1 }, (_, index) => ({ id: index === SESSION_CONTEXT_LIMITS.ancestry ? 'left' : 'node-' + index, parentId: index ? 'node-' + (index - 1) : null, type: 'message', message: { role: 'user', content: '' } }));
  assert.throws(() => selectSessionContext(bytes(chain), 'left'), /ANCESTRY_LIMIT/);
  const context = snapshot(); context.entries[2].message.content = 'x'.repeat(SESSION_CONTEXT_LIMITS.selectedBytes);
  assert.throws(() => selectSessionContext(bytes(context), 'left'), /SELECTED_BYTE_LIMIT/);
});
