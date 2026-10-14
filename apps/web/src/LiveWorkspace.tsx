import { useEffect, useRef, useState } from 'react';
import type { Scope } from '../../../packages/protocol/src/types';
import type { WeftSelection, WeftWorkspaceView } from '../../../packages/protocol/src/weft';
import type { PlatformState } from '../../../services/types';
import { ApiError, projectApiPath, request, stateReadFailure } from './api';
import { commandScope } from './commands';
import { Badge, Identity } from './components';
import { SourceDiff } from './Diff';
import { SourceInspection } from './SourceInspection';
import { reviewBase } from './presentation';
import type { RunCommand } from './Workspace';

const POLL_MS = 5000;
const STALE_MS = 15_000;
const FRESHNESS_TICK_MS = 1000;
const sameScope = (one: Scope, two: Scope) => one.tenantId === two.tenantId && one.projectId === two.projectId && one.projectIncarnation === two.projectIncarnation;
export interface WeftRead { view?: WeftWorkspaceView; checkedAt?: number; error?: string }
interface PollClock { schedule(callback: () => void, milliseconds: number): unknown; cancel(timer: unknown): void; now(): number }

export async function readWeftWorkspace(scope: Scope, read?: (path: string) => Promise<WeftWorkspaceView>, signal?: AbortSignal): Promise<WeftWorkspaceView> {
  const fetcher: typeof fetch = (input, init) => fetch(input, { ...init, signal: signal ? AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal });
  const load = read ?? ((path: string) => request<WeftWorkspaceView>(path, undefined, 12_000, fetcher, 512 * 1024));
  const view = await load(projectApiPath(scope.projectId, '/api/weft'));
  if (view.schemaVersion !== 1 || !view.scope || !sameScope(view.scope, scope) || view.binding && !sameScope(view.binding.scope, scope)) {
    throw new ApiError('The live workspace response names a different project. Refresh access.', 404, 'PROJECT_UNAVAILABLE');
  }
  return view;
}

/** A new poll starts only after the prior request settles. Disposed sessions cannot update the display. */
export function createWeftPoller(read: (signal: AbortSignal) => Promise<WeftWorkspaceView>, publish: (value: WeftRead) => void, clock: PollClock = {
  schedule: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds),
  cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>), now: () => Date.now(),
}): () => void {
  let stopped = false, snapshot: WeftRead = {};
  let timer: unknown;
  const abort = new AbortController();
  async function poll() {
    if (stopped) return;
    try {
      const view = await read(abort.signal);
      if (stopped) return;
      snapshot = { view, checkedAt: clock.now(), error: view.error };
    } catch (error) {
      if (stopped) return;
      const failure = stateReadFailure(error);
      snapshot = { ...(failure.clearSnapshot ? {} : snapshot), error: failure.message };
    }
    publish(snapshot);
    if (!stopped) timer = clock.schedule(() => { void poll(); }, POLL_MS);
  }
  void poll();
  return () => { stopped = true; abort.abort(); if (timer !== undefined) clock.cancel(timer); };
}

export function freezeWeftHead(view: WeftWorkspaceView): WeftSelection {
  if (!view.binding || !view.head || view.error) throw new Error('A current retained Weft revision is required.');
  return { schemaVersion: 1, bindingId: view.binding.id, revision: view.head.revision, root: view.head.root,
    privacyGeneration: view.head.privacyGeneration, expectedBase: view.binding.sourceBase };
}

export function retainWeftSelection(selected: WeftSelection | undefined, previous: WeftWorkspaceView | undefined, next: WeftWorkspaceView | undefined): WeftSelection | undefined {
  return previous && next?.binding && sameScope(previous.scope, next.scope) && selected?.bindingId === next.binding.id ? selected : undefined;
}

interface PanelProps {
  state: PlatformState; busy: string; read: WeftRead; selected?: WeftSelection; now: number;
  select(): void; submit(): void; openReview(): void; readOnly?: boolean;
}

export function LiveWorkspacePanel({ state, busy, read, selected, now, select, submit, openReview, readOnly = false }: PanelProps) {
  const [inspectedId, setInspectedId] = useState('');
  const view = read.view, binding = view?.binding;
  if (view && !binding) return null;
  if (!view || !binding) return read.error ? <section className="panel live-workspace"><h2>Live workspace unavailable</h2><p role="status">{read.error}</p></section> : null;
  const stale = Boolean(read.error || !read.checkedAt || now - read.checkedAt > STALE_MS);
  const baseChanged = state.acceptedHead !== binding.sourceBase;
  const canSubmit = !readOnly && view.canSubmit && !state.capabilities.maintenance && state.session?.permissions?.sponsor !== false;
  const selectedUnavailable = !selected || selected.bindingId !== binding.id || selected.expectedBase !== binding.sourceBase || selected.privacyGeneration !== view.head?.privacyGeneration;
  const disabled = Boolean(busy) || stale || !canSubmit || baseChanged || selectedUnavailable;
  const inspected = state.candidates.find(candidate => candidate.id === inspectedId);
  const exactHandoff = inspected && view.handoffs.find(handoff => handoff.candidateId === inspected.id && handoff.state === 'READY');
  return <section className="panel live-workspace" aria-labelledby="live-workspace-heading">
    <div className="section-heading"><div><div className="section-kicker">Work together through Weft</div><h2 id="live-workspace-heading">Live workspace</h2></div><Badge status={stale ? 'unknown' : 'active'}>{stale ? 'Connection unverified' : 'Recently checked'}</Badge></div>
    <p className="small muted">{read.checkedAt ? `Last checked ${new Date(read.checkedAt).toLocaleTimeString()}. ` : ''}Refreshes every five seconds after each response. {view.observedAt && `Coordinator observed ${new Date(view.observedAt).toLocaleTimeString()}.`}</p>
    {read.error && <p className="notice warning" role="status">{read.error} The retained display may be out of date.</p>}
    <div className="live-workspace-columns">
      <div className="live-workspace-current"><h3>Current live work</h3><Identity label="Workspace" value={binding.workspaceId} />{binding.alternativeId && <Identity label="Alternative" value={binding.alternativeId} />}
        <div className="live-revision"><span>Accepted by shared coordinator</span><strong>{view.head ? `Revision ${view.head.revision}` : 'Not reported'}</strong></div>
        <Identity label="Working content root" value={view.head?.root} />
        <dl className="live-acknowledgements"><div><dt>Participants and sessions</dt><dd>Not reported</dd></div><div><dt>Received by replicas</dt><dd>Not reported</dd></div><div><dt>Applied to replica disks</dt><dd>Not reported</dd></div></dl>
        <p className="small muted">Coordinator acceptance does not confirm replica download or disk application.</p>
        <button className="button" disabled={Boolean(busy) || stale || !view.head || !canSubmit || baseChanged} onClick={select}>{selected ? 'Select current revision instead' : 'Select current revision'}</button>
      </div>
      <div className="live-workspace-selection"><h3>Frozen release selection</h3>{selected ? <><div className="live-revision"><span>Selected retained working contents</span><strong>Revision {selected.revision}</strong></div><Identity label="Selected content root" value={selected.root} /><Identity label="Expected publication base" value={selected.expectedBase} /><p className="small muted">Further live edits leave this selection unchanged. Submission starts protected release checks; review, approval and publication are separate steps.</p></> : <p className="muted">Select the observed revision to keep its exact contents while work continues.</p>}
        {baseChanged && <p className="notice warning" role="status">The release base changed. Connect a workspace based on the current source before submitting another revision.</p>}
        {!canSubmit && <p className="small muted">{readOnly ? 'This live view is read-only while inspecting a recorded publication. New work requires a separate release selection.' : state.capabilities.maintenance ? 'Maintenance mode is read-only. Release submissions are paused.' : 'Your project role does not allow release submissions.'}</p>}
        {selected && selectedUnavailable && <p className="small muted">The selected privacy or workspace binding changed. Refresh and select an available revision.</p>}
        <button className="button primary" disabled={disabled} onClick={submit}>Submit revision for release checks</button>
      </div>
    </div>
    <details className="live-activity"><summary>Recent coordinator activity · {view.activity.length}{view.conflicts.length ? ` · ${view.conflicts.length} unresolved conflicts` : ''}</summary>
      {view.activity.length ? <ul>{view.activity.map((event, index) => <li key={index}><strong>{event.kind}</strong>{event.revision !== null && ` · revision ${event.revision}`}{event.actor && <> · <code>{event.actor}</code></>}<p>{event.detail}</p></li>)}</ul> : <p className="muted">No recent coordinator activity reported.</p>}
      {view.conflicts.map(conflict => <p className="notice warning" key={conflict.id}>Conflict <code>{conflict.id}</code> · actor <code>{conflict.actor}</code> · shared revision {conflict.sharedRevision} · {conflict.pathCount} paths. This work has not been accepted as the shared revision.</p>)}
    </details>
    {view.handoffs.length > 0 && <div className="live-handoffs"><h3>Release submissions</h3><p className="small muted">Handoff readiness describes source transfer. Evaluation, human approval and publication are recorded separately on the candidate.</p>{view.handoffs.map(handoff => {
      const candidate = state.candidates.find(candidate => candidate.id === handoff.candidateId);
      return <article className="live-handoff" key={handoff.id}><div className="live-handoff-heading"><strong>Selected revision {handoff.selected.revision}</strong><Badge status={handoff.state}>{handoff.state === 'READY' ? 'Source candidate ready' : handoff.state === 'FROZEN' ? 'Contents retained; staging' : handoff.state === 'PENDING' ? 'Acquiring selected contents' : 'Transfer rejected'}</Badge></div>
        <Identity label="Handoff request" value={handoff.requestId} /><Identity label="Handoff record" value={handoff.id} /><Identity label="Confidence candidate" value={handoff.candidateId} />{handoff.reason && <p role="status">{handoff.reason}</p>}
        {handoff.state === 'READY' && candidate && <div className="button-row"><button className="button small-button" aria-expanded={inspectedId === candidate.id} onClick={() => setInspectedId(inspectedId === candidate.id ? '' : candidate.id)}>Inspect candidate {candidate.id.slice(0, 10)}</button>{candidate.id === state.activeCandidateId && <button className="button small-button" onClick={openReview}>Open candidate review</button>}</div>}
      </article>;
    })}</div>}
    {inspected && exactHandoff && <section className="live-source-inspection" aria-label="Selected handoff candidate"><h3>Candidate from retained revision {exactHandoff.selected.revision}</h3><Identity label="Exact candidate commit" value={inspected.commit} /><SourceDiff candidate={inspected} baseline={reviewBase(state, inspected)} completeInspectionAvailable /><SourceInspection key={`${inspected.id}:${inspected.commit}`} candidate={inspected} state={state} onVerified={() => {}} /></section>}
  </section>;
}

interface LiveWorkspaceProps { state: PlatformState; busy: string; command: RunCommand; openReview(): void; onConnectionChange(connected: boolean): void; readOnly?: boolean }

function LiveWorkspaceSession({ state, busy, command, openReview, onConnectionChange, readOnly = false }: LiveWorkspaceProps) {
  const [snapshot, setSnapshot] = useState<{ read: WeftRead; selected?: WeftSelection }>({ read: {} });
  const [now, setNow] = useState(Date.now());
  const notifyConnection = useRef(onConnectionChange);
  notifyConnection.current = onConnectionChange;
  const scopeKey = commandScope(state);
  useEffect(() => createWeftPoller(signal => readWeftWorkspace(state, undefined, signal), read => {
    setSnapshot(previous => ({ read, selected: retainWeftSelection(previous.selected, previous.read.view, read.view) }));
    notifyConnection.current(Boolean(read.view?.binding));
  }), [scopeKey]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), FRESHNESS_TICK_MS); return () => clearInterval(timer); }, []);
  return <LiveWorkspacePanel state={state} busy={busy} read={snapshot.read} selected={snapshot.selected} now={now} readOnly={readOnly}
    select={() => { if (!readOnly && snapshot.read.view) setSnapshot({ ...snapshot, selected: freezeWeftHead(snapshot.read.view) }); }}
    submit={() => { if (!readOnly && snapshot.selected) void command('Submit revision for release checks', '/api/weft/submit', { ...snapshot.selected }); }} openReview={openReview} />;
}

export function LiveWorkspace(props: LiveWorkspaceProps) {
  return props.state.capabilities.deployment ? <LiveWorkspaceSession key={commandScope(props.state)} {...props} /> : null;
}
