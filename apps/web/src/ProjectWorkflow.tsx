import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PlatformState } from '../../../services/types';
import { downloadJSON, createProjectStateReader, projectSnapshotStatus, stateReadFailure } from './api';
import { CommandSession, commandScope, pendingProjectId } from './commands';
import { Workspace, type RunCommand } from './Workspace';
import { Review } from './Review';
import { Evidence, Timeline } from './Inspection';
import { CloudflareRuntime } from './Cloudflare';
import type { View } from './navigation';
import { Verifier } from './Verifier';
import { BrandMark, Icon } from './icons';
import { createRefreshQueue, startVisiblePolling } from './polling';
import { createSessionIdentity } from './session-identity';
import { ProjectAccess } from './ProjectAccess';
import { observeCommand } from './command-observer';

export function ProjectWorkflow({ projectId, view, setView, commands, readOnly = false }: { projectId: string; view: View; setView: (view: View) => void; commands: CommandSession; readOnly?: boolean }) {
  const [state, setState] = useState<PlatformState>();
  const [readState] = useState(() => createProjectStateReader(projectId));
  const lifecycle = useRef(0);
  const observedScope = useRef<string | undefined>(undefined);
  const commandView = useRef({ view, generation: 0 });
  if (commandView.current.view !== view) commandView.current = { view, generation: commandView.current.generation + 1 };
  useEffect(() => { lifecycle.current++; return () => { lifecycle.current++; identity.clear(); }; }, []);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [connectionIssue, setConnectionIssue] = useState<'authentication' | 'project' | 'unavailable' | ''>('');
  const [identity] = useState(() => createSessionIdentity());
  const identityState = useSyncExternalStore(identity.subscribe, identity.getSnapshot);
  const { pending: pendingCommand, storageError } = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  const actionsBusy = busy || (pendingCommand || storageError || connectionError || state?.capabilities.maintenance || readOnly ? 'Commands paused' : '');
  const snapshotStatus = projectSnapshotStatus(state, connected, connectionError);
  const snapshotVerified = snapshotStatus === 'current';
  const connectionTitle = connectionIssue === 'project' ? 'Project access is unavailable.' : connectionIssue === 'authentication' ? 'Sign-in or project access needs attention.' : 'Live state is temporarily unavailable.';
  const emptyTitle = connectionIssue === 'project' ? 'Project access unavailable' : connectionIssue === 'authentication' ? 'Project session unavailable' : connectionError ? 'Project state unavailable' : 'Opening the project';
  const emptyDetail = connectionIssue === 'project' ? 'This identity cannot currently read the project. Refresh after access is restored.' : connectionIssue === 'authentication' ? 'Sign in with a project member identity, then refresh.' : connectionError ? 'Refresh when the project API is available.' : 'Reading the authoritative snapshot…';
  const seenSubmissions = useRef({ incarnation: '', ids: [] as string[] });


  const [refresh] = useState(() => createRefreshQueue(async force => {
    const generation = lifecycle.current;
    try {
      const next = await readState(force);
      if (generation !== lifecycle.current) return;
      identity.clear();
      observedScope.current = commandScope(next);
      setState(next);
      setConnectionError(''); setConnectionIssue(''); setConnected(true);
      const available = next.attempts.filter(a => a.role !== 'repair' && a.submissionId).map(a => a.id);
      const reset = seenSubmissions.current.incarnation !== commandScope(next);
      const added = available.filter(id => reset || !seenSubmissions.current.ids.includes(id));
      seenSubmissions.current = { incarnation: commandScope(next), ids: available };
      setSelected(previous => [...new Set([...(reset ? [] : previous.filter(id => available.includes(id))), ...added])]);
    } catch (e) {
      if (generation !== lifecycle.current) return;
      const failure = stateReadFailure(e);
      identity.clear();
      setConnected(false); setConnectionError(failure.message); setConnectionIssue(failure.kind);
      if (failure.clearSnapshot) {
        observedScope.current = undefined;
        setState(undefined); setSelected([]);
        seenSubmissions.current = { incarnation: '', ids: [] };
      }
      if (failure.kind === 'project') await identity.refresh();
    }
  }));

  useEffect(() => {
    // Both adapters support snapshots. One bounded poll avoids the deployed
    // finite SSE response repeatedly reconnecting alongside another poll loop.
    // A hidden tab resumes with an immediate authenticated read when visible.
    return startVisiblePolling(document, window, () => { void refresh(); });
  }, [refresh]);

  const command: RunCommand = async (label, path, body) => {
    if (readOnly) { setError('Project changes are paused. Restore the project or refresh its current access.'); return false; }
    if (!state || connectionError) { setError('Refresh a current authenticated project snapshot before sending work.'); return false; }
    if (state.capabilities.maintenance) { setError('Maintenance mode is read-only. Refresh after the active release has been verified.'); return false; }
    const generation = lifecycle.current, viewGeneration = commandView.current.generation, originalScope = commandScope(state);
    setBusy(label); setError(''); setNotice('');
    return observeCommand(() => commands.begin(state, label, path, body, true), {
      current: () => generation === lifecycle.current && viewGeneration === commandView.current.generation && originalScope === observedScope.current,
      acknowledged: () => setNotice(`${label}: request recorded. Follow the operation's observed state below.`),
      failed: e => setError(e instanceof Error ? e.message : 'The command could not be sent.'),
      finished: () => { setBusy(''); void refresh(true); },
    }).finally(() => { if (generation === lifecycle.current) setBusy(''); });
  };

  async function recoverCommand() {
    if (readOnly) return;
    if (!state || connectionError) return;
    if (state.capabilities.maintenance) { setError('Maintenance mode is read-only. Recover the same command after the active release has been verified.'); return; }
    const generation = lifecycle.current, viewGeneration = commandView.current.generation, originalScope = commandScope(state);
    setBusy('Recovering the same command'); setError('');
    await observeCommand(() => commands.retry(state), {
      current: () => generation === lifecycle.current && viewGeneration === commandView.current.generation && originalScope === observedScope.current,
      acknowledged: () => setNotice('The retained command is acknowledged. Its original identity and exact inputs were preserved.'),
      failed: e => setError(e instanceof Error ? e.message : String(e)),
      finished: () => { setBusy(''); void refresh(true); },
    });
    if (generation === lifecycle.current) setBusy('');
  }

  return <div className="project-workflow">
    <div className="workflow-toolbar"><span className={`connection-dot ${snapshotVerified ? 'connected' : ''}`} /><span role="status">{snapshotStatus === 'current' ? 'Workflow snapshot current' : snapshotStatus === 'unverified' ? 'Workflow snapshot unverified' : 'Opening workflow…'}</span><button className="text-button" onClick={() => void refresh(true)}>Refresh</button></div>
      {state?.capabilities.maintenance && <div className="notice warning" role="status"><Icon name="lock" /><div><strong>Maintenance mode · commands paused</strong><p>Inspect the project read-only. New work can begin after the active deployment is independently verified and a fresh snapshot shows maintenance off.</p></div></div>}
      {connectionError && <div className="notice danger" role="alert"><Icon name="error" /><div><strong>{connectionTitle}</strong><p>{connectionError} {state ? 'The displayed snapshot and identity are unverified until refresh.' : 'No project snapshot is displayed.'} Commands are paused. Uploaded receipt verification remains available without a project snapshot.</p></div><button className="button" onClick={() => void refresh(true)}>Refresh state</button>{connectionIssue === 'authentication' && <button className="button" onClick={() => window.location.assign('/')}>Sign in again</button>}</div>}
      {storageError && <div className="notice danger" role="alert"><p>{storageError}</p></div>}
      {pendingCommand && pendingCommand.kind !== 'metadata' && pendingProjectId(pendingCommand) === projectId && <section className="notice warning" role="status" aria-live="polite"><Icon name="time" /><div><strong>{pendingCommand.status === 'UNKNOWN' ? 'Command outcome unknown' : pendingCommand.status === 'REJECTED' ? 'Command rejected' : 'Awaiting command acknowledgement'}</strong><p>{pendingCommand.label}. {pendingCommand.detail}</p><p className="small">{pendingCommand.status === 'REJECTED' ? 'Dismiss this rejection, refresh, and deliberately choose new inputs if appropriate.' : 'New actions are paused. Recovery resends the same command key, revision and exact inputs; it does not start a new intent.'}</p>{state && pendingCommand.scope !== commandScope(state) && <p>This belongs to another principal or project incarnation. Restore its original session to recover it.</p>}</div>{pendingCommand.status === 'UNKNOWN' && <button className="button" disabled={Boolean(busy || connectionError || state?.capabilities.maintenance || readOnly) || !state || pendingCommand.scope !== commandScope(state)} onClick={() => void recoverCommand()}>Recover same command</button>}{pendingCommand.status === 'REJECTED' && <button className="button" onClick={() => commands.dismissRejection()}>Dismiss rejection</button>}<button className="button" onClick={() => downloadJSON(pendingCommand, `confidence-command-${pendingCommand.id}.json`)}>Export recovery record</button></section>}
      {error && <div className="notice danger command-notice" role="alert"><Icon name="error" /><div><strong>The command was not confirmed.</strong><p>{error}</p></div><button className="icon-button" aria-label="Dismiss command error" onClick={() => setError('')}><Icon name="x" /></button></div>}
      {notice && <div className="notice neutral command-notice" role="status"><Icon name="activity" /><p>{notice}</p><button className="icon-button" aria-label="Dismiss command notice" onClick={() => setNotice('')}><Icon name="x" /></button></div>}

      {view === 'verify' ? <><div className="page-heading"><div className="eyebrow">Portable evidence</div><h1>Verify beyond this workspace.</h1><p>Inspect a signed receipt under keys you selected, without asking the publication service to judge itself.</p></div><Verifier projectId={projectId} receiptId={state?.receipts.at(-1)?.id} projectAvailable={snapshotVerified} /></> : !state && connectionIssue === 'project' ? <ProjectAccess identity={identityState} refresh={() => void refresh(true)} copy={() => void identity.copy(value => navigator.clipboard.writeText(value))} /> : !state ? <div className="loading-state" role="status"><BrandMark /><h2>{emptyTitle}</h2><p>{emptyDetail}</p><button className="button" onClick={() => setView('verify')}>Verify retained files independently</button></div> : view === 'workspace' ? <Workspace state={state} busy={actionsBusy} command={command} selected={selected} setSelected={setSelected} openReview={() => setView('review')} /> : view === 'review' ? <Review key={commandScope(state)} state={state} busy={actionsBusy} command={command} openVerify={() => setView('verify')} /> : view === 'evidence' ? <Evidence state={state} /> : view === 'timeline' ? <Timeline state={state} /> : <CloudflareRuntime state={state} />}
  </div>;
}
