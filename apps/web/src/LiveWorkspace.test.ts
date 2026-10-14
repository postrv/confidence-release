/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WeftWorkspaceView } from '../../../packages/protocol/src/weft';
import type { PlatformState } from '../../../services/types';
import { ApiError } from './api';
import { CommandSession, freezeCommand, type PendingCommand } from './commands';
import { createWeftPoller, freezeWeftHead, LiveWorkspacePanel, readWeftWorkspace, retainWeftSelection, type WeftRead } from './LiveWorkspace';

const scope = { schemaVersion: 1 as const, tenantId: 'tenant', projectId: 'project', projectIncarnation: 'incarnation' };
const base = 'b'.repeat(40);
function workspace(): WeftWorkspaceView {
  return { schemaVersion: 1, scope, binding: { id: 'binding', scope, workspaceId: 'shared', alternativeId: null, sourceRepo: 'fixture', sourceRepositoryId: 'repo-id', sourceRef: 'refs/heads/main', sourceBase: base, weftSourceRevision: 'c'.repeat(40) },
    canSubmit: true, observedAt: '2026-10-14T12:00:00.000Z', head: { revision: 12, root: 'a'.repeat(64), privacyGeneration: 1 },
    activity: [{ kind: 'accepted', revision: 12, actor: 'session-a', detail: 'Accepted tool result' }], conflicts: [], participants: null, replicas: null, handoffs: [] };
}
function state(): PlatformState {
  return { ...scope, revision: 4, acceptedHead: base, capabilities: { deployment: true, maintenance: false }, session: { principalId: 'human', credentialClass: 'human' }, candidates: [], reviews: [], publications: [], receipts: [] } as unknown as PlatformState;
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const drain = () => new Promise<void>(resolve => setImmediate(resolve));

test('recorded-publication live inspection cannot select or submit future release work', () => {
  const view = workspace();
  const html = renderToStaticMarkup(createElement(LiveWorkspacePanel, { state: state(), busy: '', read: { view, checkedAt: 100 },
    selected: freezeWeftHead(view), now: 200, readOnly: true, select() {}, submit() {}, openReview() {} }));
  assert.match(html, /read-only while inspecting a recorded publication/);
  assert.match(html, /New work requires a separate release selection/);
  for (const label of ['Select current revision instead', 'Submit revision for release checks']) {
    const button = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(item => item[0]).find(item => item.includes(label));
    assert.ok(button); assert.match(button, /disabled=""/);
  }
  assert.doesNotMatch(html, /Your project role does not allow release submissions/);
});

test('selection remains exact when live work advances and clears on binding or incarnation change', () => {
  const first = workspace(), selected = freezeWeftHead(first);
  const advanced = structuredClone(first); advanced.head!.revision++; advanced.head!.root = 'd'.repeat(64);
  assert.deepEqual(selected, { schemaVersion: 1, bindingId: 'binding', revision: 12, root: 'a'.repeat(64), privacyGeneration: 1, expectedBase: base });
  assert.equal(retainWeftSelection(selected, first, advanced), selected);
  assert.equal(retainWeftSelection(selected, first, { ...advanced, binding: { ...advanced.binding!, id: 'replacement' } }), undefined);
  assert.equal(retainWeftSelection(selected, first, { ...advanced, scope: { ...scope, projectIncarnation: 'new' } }), undefined);
  assert.equal(retainWeftSelection(selected, first, { ...advanced, binding: null }), undefined);
});

test('project workspace reads reject a different authority scope or inconsistent binding', async () => {
  const read = async (value: WeftWorkspaceView) => readWeftWorkspace(scope, async path => { assert.equal(path, '/api/projects/project/weft'); return value; });
  assert.equal((await read(workspace())).binding?.workspaceId, 'shared');
  await assert.rejects(read({ ...workspace(), scope: { ...scope, projectId: 'other' } }), /different project/);
  await assert.rejects(read({ ...workspace(), binding: { ...workspace().binding!, scope: { ...scope, projectIncarnation: 'other' } } }), /different project/);
});

test('polling waits for completion, uses a bounded interval and discards an old project response', async () => {
  const pending = deferred<WeftWorkspaceView>(); const emitted: WeftRead[] = [];
  const timers: { callback: () => void; milliseconds: number }[] = []; let calls = 0;
  const stop = createWeftPoller(async () => { calls++; return pending.promise; }, value => emitted.push(value), {
    schedule: (callback, milliseconds) => { timers.push({ callback, milliseconds }); return timers.length; }, cancel: () => {}, now: () => 100,
  });
  assert.equal(calls, 1); assert.equal(timers.length, 0);
  pending.resolve(workspace()); await drain();
  assert.equal(emitted[0]?.checkedAt, 100); assert.equal(timers.length, 1); assert.ok(timers[0]!.milliseconds >= 3000);
  stop(); timers[0]!.callback(); await drain(); assert.equal(calls, 1);
  const old = deferred<WeftWorkspaceView>(); let oldSignal: AbortSignal | undefined;
  const stopOld = createWeftPoller(signal => { oldSignal = signal; return old.promise; }, value => emitted.push(value));
  stopOld(); assert.equal(oldSignal?.aborted, true); old.resolve({ ...workspace(), scope: { ...scope, projectId: 'old' } }); await drain();
  assert.equal(emitted.length, 1);
});

test('authorization loss clears the retained live snapshot; network uncertainty is labeled', async () => {
  for (const [error, cleared] of [[new ApiError('Access revoked', 403), true], [new ApiError('Request timed out'), false]] as const) {
    const emitted: WeftRead[] = []; const timers: (() => void)[] = []; let calls = 0;
    const stop = createWeftPoller(async () => { if (calls++) throw error; return workspace(); }, value => emitted.push(value), {
      schedule: callback => { timers.push(callback); return timers.length; }, cancel: () => {}, now: () => 100,
    });
    await drain(); timers.shift()!(); await drain(); stop();
    assert.equal(emitted[1]?.view === undefined, cleared); assert.equal(emitted[1]?.error, error.message);
  }
});

test('the handoff command freezes the selection and response-loss recovery retains its identity', async () => {
  const selected = freezeWeftHead(workspace());
  const frozen = freezeCommand(state(), 'Submit revision for release checks', '/api/weft/submit', selected as unknown as Record<string, unknown>, 'handoff-1');
  selected.revision = 13; selected.root = 'e'.repeat(64);
  assert.equal(frozen.path, '/v1/projects/project/submit-weft-revision');
  assert.equal(JSON.parse(frozen.body).revision, 12);
  assert.equal(frozen.headers['If-Platform-Incarnation'], scope.projectIncarnation);
  let retained: string | null = null; const storage = { getItem: () => retained, setItem: (_key: string, value: string) => { retained = value; }, removeItem: () => { retained = null; } };
  const sent: PendingCommand[] = [];
  const first = new CommandSession(storage, async command => { sent.push(structuredClone(command)); throw new ApiError('Response lost'); });
  await first.begin(state(), 'Submit revision for release checks', '/api/weft/submit', JSON.parse(frozen.body));
  const recovered = new CommandSession(storage, async command => { sent.push(structuredClone(command)); return { accepted: true }; });
  await recovered.retry({ ...state(), revision: 99 });
  assert.equal(sent[1]!.id, sent[0]!.id); assert.equal(sent[1]!.body, sent[0]!.body); assert.deepEqual(sent[1]!.headers, sent[0]!.headers);
});

test('workspace display separates coordinator acceptance, replica acknowledgements and release selection', () => {
  const view = workspace(), selected = freezeWeftHead(view); view.head!.revision = 13;
  const html = renderToStaticMarkup(createElement(LiveWorkspacePanel, { state: state(), busy: '', read: { view, checkedAt: 100 }, selected, now: 200, select: () => {}, submit: () => {}, openReview: () => {} }));
  assert.match(html, /Accepted by shared coordinator/); assert.match(html, /Revision 13/); assert.match(html, /Frozen release selection/); assert.match(html, /Revision 12/);
  assert.match(html, /Participants and sessions/); assert.match(html, /Received by replicas/); assert.match(html, /Applied to replica disks/); assert.match(html, /Not reported/);
  assert.match(html, /session-a/); assert.match(html, /Submit revision for release checks/); assert.doesNotMatch(html, /All replicas synchronized/);
  const stale = renderToStaticMarkup(createElement(LiveWorkspacePanel, { state: state(), busy: '', read: { view, checkedAt: 100, error: 'Connection interrupted' }, selected, now: 20_000, select: () => {}, submit: () => {}, openReview: () => {} }));
  assert.match(stale, /Connection unverified/); assert.match(stale, /disabled=""[^>]*>Submit revision for release checks/);
});

test('an unconfigured project has no live workspace panel and a changed release base disables submission', () => {
  const props = { state: state(), busy: '', read: { view: { ...workspace(), binding: null }, checkedAt: 100 }, now: 200, select: () => {}, submit: () => {}, openReview: () => {} };
  assert.equal(renderToStaticMarkup(createElement(LiveWorkspacePanel, props)), '');
  const html = renderToStaticMarkup(createElement(LiveWorkspacePanel, { ...props, state: { ...state(), acceptedHead: 'new-base' }, read: { view: workspace(), checkedAt: 100 }, selected: freezeWeftHead(workspace()) }));
  assert.match(html, /release base changed/); assert.match(html, /disabled=""[^>]*>Submit revision for release checks/);
});

test('current maintenance or sponsor revocation disables a previously permitted live selection immediately', () => {
  for (const restricted of [
    { ...state(), capabilities: { ...state().capabilities, maintenance: true } },
    { ...state(), session: { ...state().session!, permissions: { sponsor: false } as NonNullable<PlatformState['session']>['permissions'] } },
  ]) {
    const html = renderToStaticMarkup(createElement(LiveWorkspacePanel, { state: restricted, busy: '',
      read: { view: workspace(), checkedAt: 100 }, selected: freezeWeftHead(workspace()), now: 200,
      select: () => {}, submit: () => {}, openReview: () => {} }));
    assert.match(html, /disabled=""[^>]*>Select current revision instead/);
    assert.match(html, /disabled=""[^>]*>Submit revision for release checks/);
    assert.match(html, /Maintenance mode is read-only|role does not allow release submissions/);
  }
});

test('a denied uncertain Weft retry retains exact bytes and can reconcile after the live base advances', async () => {
  let retained: string | null = null;
  const storage = { getItem: () => retained, setItem: (_key: string, value: string) => { retained = value; }, removeItem: () => { retained = null; } };
  const sent: PendingCommand[] = [];
  const first = new CommandSession(storage, async command => { sent.push(structuredClone(command)); throw new ApiError('Response lost'); });
  await first.begin(state(), 'Submit revision for release checks', '/api/weft/submit', { ...freezeWeftHead(workspace()) });
  const advanced = { ...state(), revision: 99, acceptedHead: 'd'.repeat(40) };
  const denied = new CommandSession(storage, async command => { sent.push(structuredClone(command)); throw new ApiError('Access revoked', 403); });
  assert.equal(await denied.retry(advanced), false);
  assert.equal(denied.getSnapshot().pending?.status, 'UNKNOWN');
  denied.dismissRejection();
  await assert.rejects(denied.begin(advanced, 'Submit revision for release checks', '/api/weft/submit', { ...freezeWeftHead(workspace()) }), /Resolve the retained command/);
  const recovered = new CommandSession(storage, async command => { sent.push(structuredClone(command)); return { accepted: true }; });
  assert.equal(await recovered.retry(advanced), true);
  for (const command of sent.slice(1)) {
    assert.equal(command.id, sent[0]!.id);
    assert.equal(command.body, sent[0]!.body);
    assert.deepEqual(command.headers, sent[0]!.headers);
  }
  assert.equal(recovered.getSnapshot().pending, undefined);
});

test('a ready handoff points at its frozen candidate and never opens a different active review', () => {
  const view = workspace();
  view.handoffs = [{ schemaVersion: 1, id: 'handoff-record', requestId: 'request-identity', requestDigest: 'digest', scope,
    submittedBy: 'human', selected: freezeWeftHead(view), binding: view.binding!, candidateId: 'frozen-candidate', admittedAt: 100,
    policyRevision: '1', goalRevision: '1', state: 'READY', sourceCommit: 'f'.repeat(40) }];
  const current = state(); current.activeCandidateId = 'other-candidate'; current.candidates = [{ id: 'frozen-candidate' } as PlatformState['candidates'][number]];
  const html = renderToStaticMarkup(createElement(LiveWorkspacePanel, { state: current, busy: '', read: { view, checkedAt: 100 }, now: 200, select: () => {}, submit: () => {}, openReview: () => {} }));
  assert.match(html, /request-identity/); assert.match(html, /Source candidate ready/); assert.match(html, /Inspect candidate frozen-can/);
  assert.doesNotMatch(html, /Open candidate review/); assert.doesNotMatch(html, /other-candidate/);
});

test('malformed selection, changed release base and an insufficient project role cannot become browser commands', () => {
  const selection = freezeWeftHead(workspace());
  const freeze = (input: Record<string, unknown>, current = state()) => freezeCommand(current, 'Submit revision for release checks', '/api/weft/submit', input);
  assert.throws(() => freeze({ ...selection, revision: Number.NaN }), /exact retained/);
  assert.throws(() => freeze({ ...selection, root: 'latest' }), /exact retained/);
  assert.throws(() => freeze({ ...selection }, { ...state(), acceptedHead: 'c'.repeat(40) }), /release base changed/);
  const restricted = state(); restricted.session = { ...restricted.session!, permissions: { sponsor: false } as NonNullable<PlatformState['session']>['permissions'] };
  assert.throws(() => freeze({ ...selection }, restricted), /role does not allow/);
});
