import { useEffect, useReducer, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ProjectSummary } from '../../../packages/project-model/src/types';
import { downloadJSON } from './api';
import { CommandSession, metadataScope, pendingProjectId } from './commands';
import { createProjectDirectory, observeDirectoryContext } from './project-directory';
import { collaborationRoute, navigationReducer, routeForView, routeFromHash, type AppRoute, type AppView, type View } from './navigation';
import { Projects, ProjectSettings, RepositoryWorkspace, type ManageProject } from './Projects';
import { ProjectWorkflow } from './ProjectWorkflow';
import { createSessionIdentity, projectDiscussionAvailable } from './session-identity';
import { ProjectAccess } from './ProjectAccess';
import { AccountIdentity } from './AccountIdentity';
import { Verifier } from './Verifier';
import { BrandMark, Icon, type IconName } from './icons';
import { ThemeToggle } from './ThemeToggle';
import { createRefreshQueue, startVisiblePolling } from './polling';
import { Collaboration } from './Collaboration';
import { ProjectDiscussion } from './ProjectDiscussion';
import { takeInvitationFromLocation, type InvitationIntake } from './invitation-secret';
import { createGuardedNavigation, createUnsavedChanges, DISCARD_DISCUSSION_MESSAGE, DISCARD_SETTINGS_MESSAGE, protectedDraftScope } from './unsaved-changes';

const projectNavigation: { id: View; label: string; icon: IconName }[] = [
  { id: 'workspace', label: 'Workspace', icon: 'layers' },
  { id: 'discussion', label: 'Discussion', icon: 'activity' },
  { id: 'review', label: 'Release review', icon: 'git' },
  { id: 'evidence', label: 'Evidence', icon: 'shield' },
  { id: 'timeline', label: 'Event history', icon: 'activity' },
  { id: 'collaboration', label: 'Project access', icon: 'lock' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export function ProjectNavigation({ profileKnown, collaborationOnly, nativeWorkflow, discussionEnabled, view, open }: {
  profileKnown: boolean; collaborationOnly: boolean; nativeWorkflow: boolean; discussionEnabled: boolean; view: AppView; open: (view: View) => void;
}) {
  const nav = projectNavigation.filter(item => (item.id !== 'discussion' || discussionEnabled)
    && (!profileKnown || collaborationOnly ? ['discussion', 'collaboration', 'settings'].includes(item.id) : nativeWorkflow || ['workspace', 'settings', 'collaboration', 'discussion'].includes(item.id)));
  return <>{nav.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} aria-current={view === item.id ? 'page' : undefined} onClick={() => open(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</>;
}

export function ProjectDiscussionRoute({ enabled, openProjects, children }: { enabled: boolean; openProjects: () => void; children: ReactNode }) {
  return enabled ? <>{children}</> : <section className="panel project-empty"><Icon name="activity" size={32} /><h2>Discussion is unavailable</h2><p>Project discussion is not enabled in this deployment. Open projects to continue with its available workflows.</p><button className="button" onClick={openProjects}>Open projects</button></section>;
}

function PendingAccess({ refresh }: { refresh: () => void }) {
  const [identity] = useState(() => createSessionIdentity());
  const state = useSyncExternalStore(identity.subscribe, identity.getSnapshot);
  useEffect(() => { void identity.refresh(); return () => identity.clear(); }, [identity]);
  return <ProjectAccess identity={state} refresh={() => { refresh(); void identity.refresh(); }} copy={() => void identity.copy(value => navigator.clipboard.writeText(value))} />;
}

export default function App({ initialInvitation }: { initialInvitation?: InvitationIntake }) {
  const [invitation, setInvitation] = useState(initialInvitation);
  const [{ route: requestedRoute, notice }, navigate] = useReducer(navigationReducer, undefined, () => ({ route: routeFromHash(window.location.hash), notice: '' }));
  const setRoute = (route: AppRoute) => navigate({ type: 'route', route });
  const setNotice = (notice: string) => navigate({ type: 'notice', notice });
  const [directoryStore] = useState(() => createProjectDirectory());
  const [deploymentIdentityStore] = useState(createSessionIdentity);
  const [drafts] = useState(createUnsavedChanges);
  const [browserNavigation] = useState(() => createGuardedNavigation(window, {
    sessionId: crypto.randomUUID(), changed: setRoute,
    hasChanges: current => drafts.hasChanges(protectedDraftScope(directoryStore.getSnapshot().data, current)),
    canLeave: current => !drafts.hasChanges(protectedDraftScope(directoryStore.getSnapshot().data, current)) || window.confirm(current.view === 'discussion' ? DISCARD_DISCUSSION_MESSAGE : DISCARD_SETTINGS_MESSAGE),
  }));
  const directory = useSyncExternalStore(directoryStore.subscribe, directoryStore.getSnapshot);
  const deploymentIdentity = useSyncExternalStore(deploymentIdentityStore.subscribe, deploymentIdentityStore.getSnapshot);
  const profileKnown = directory.data?.principalId === 'local-pilot' || deploymentIdentity.status === 'verified' && deploymentIdentity.identity.principalId === directory.data?.principalId;
  const collaborationOnly = profileKnown && deploymentIdentity.status === 'verified' && deploymentIdentity.identity.deploymentProfile === 'collaboration-only';
  const discussionEnabled = projectDiscussionAvailable(deploymentIdentity, directory.data?.principalId);
  const landingView: View = collaborationOnly ? discussionEnabled ? 'discussion' : 'collaboration' : 'workspace';
  const route = collaborationOnly ? collaborationRoute(requestedRoute, directory.data?.projects.find(item => item.projectId === directory.data?.defaultProjectId)?.projectId) : requestedRoute;
  const [refreshDirectory] = useState(() => createRefreshQueue(async () => { await directoryStore.refresh(); }));
  const [commands] = useState(() => new CommandSession({ getItem: key => window.sessionStorage.getItem(key), setItem: (key, value) => window.sessionStorage.setItem(key, value), removeItem: key => window.sessionStorage.removeItem(key) }));
  const commandState = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [help, setHelp] = useState(false);
  const [showIdentity, setShowIdentity] = useState(false);
  const selectedId = route.view === 'accept' ? invitation?.secret?.scope.projectId ?? route.projectId : route.view === 'projects' ? undefined : route.projectId ?? directory.data?.defaultProjectId;
  const project = directory.data?.projects.find(item => item.projectId === selectedId);
  const scopeKey = JSON.stringify([directory.data?.tenantId, project?.projectId, project?.projectIncarnation, directory.data?.principalId]);
  const nativeView = Boolean(profileKnown && !collaborationOnly && project?.capabilities.nativeWorkflow && !['settings', 'projects', 'collaboration', 'accept', 'discussion'].includes(route.view));
  const blocked = Boolean(busy || !directory.current || !profileKnown || commandState.pending || commandState.storageError || directory.data?.maintenance);
  const pending = commandState.pending;
  const pendingProject = pending && directory.data?.projects.find(item => item.projectId === pendingProjectId(pending));
  const recoverable = Boolean(pending?.kind === 'metadata' && directory.current && directory.data && pending.scope === metadataScope(directory.data, pendingProject));
  const setView = (view: AppView, projectId: string | undefined = selectedId) => {
    browserNavigation.navigate(routeForView(view, projectId));
  };
  useEffect(() => {
    const receiveInvitation = () => {
      const received = takeInvitationFromLocation(window.location, window.history);
      if (received) setInvitation(received);
    };
    window.addEventListener('hashchange', receiveInvitation);
    window.addEventListener('popstate', receiveInvitation);
    const stop = browserNavigation.listen();
    return () => { stop(); window.removeEventListener('hashchange', receiveInvitation); window.removeEventListener('popstate', receiveInvitation); };
  }, [browserNavigation]);
  useEffect(() => startVisiblePolling(document, window, () => { void refreshDirectory(); }, 60_000), [refreshDirectory]);
  useEffect(() => { void deploymentIdentityStore.refresh(); return () => deploymentIdentityStore.clear(); }, [deploymentIdentityStore, directory.data?.principalId]);
  useEffect(() => { if (route !== requestedRoute) browserNavigation.navigate(routeForView(route.view, route.projectId)); }, [route.view, route.projectId, requestedRoute.view, requestedRoute.projectId, browserNavigation]);
  useEffect(() => { navigate({ type: 'notice', notice: '' }); }, [scopeKey]);
  useEffect(() => {
    document.title = `Confidence · ${route.view === 'projects' ? 'Projects' : project?.name || 'Project'}`;
    window.scrollTo({ top: 0, behavior: 'instant' });
    document.getElementById('main-content')?.focus({ preventScroll: true });
  }, [route.view, selectedId, project?.name]);

  const manage: ManageProject = async (target, label, operation, body) => {
    if (!directory.current || !directory.data || directory.data.maintenance) { setError('Refresh the project directory before changing a project.'); return false; }
    const stillCurrent = observeDirectoryContext(directoryStore, () => window.location.hash);
    setBusy(label); setError(''); setNotice('');
    try {
      const confirmed = await commands.beginMetadata(directory.data, target, label, operation, body);
      if (confirmed) {
        const result = commands.getAcknowledgedResult() as ProjectSummary | undefined;
        await refreshDirectory(true);
        if (!stillCurrent()) return false;
        setNotice(`${label}: saved.`);
        if (operation === 'create' && result?.projectId) setView(landingView, result.projectId);
        return result?.projectId ? result : false;
      }
      return false;
    } catch (failure) { if (stillCurrent()) setError(failure instanceof Error ? failure.message : 'The project change was not confirmed.'); return false; }
    finally { setBusy(''); void refreshDirectory(true); }
  };

  async function recover() {
    if (!directory.data || !recoverable || directory.data.maintenance) return;
    const stillCurrent = observeDirectoryContext(directoryStore, () => window.location.hash);
    setBusy('Recovering project change'); setError('');
    try { if (await commands.retryMetadata(directory.data, pendingProject)) { await refreshDirectory(true); if (stillCurrent()) setNotice('The original project change is acknowledged.'); } }
    catch (failure) { if (stillCurrent()) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(''); void refreshDirectory(true); }
  }

  const openProject = (value: ProjectSummary, view: View = landingView) => setView(view, value.projectId);
  const localIdentity = directory.data?.principalId === 'local-pilot';
  const localEnvironment = ['127.0.0.1', 'localhost'].includes(window.location.hostname);
  function closeIdentity() {
    setShowIdentity(false);
    requestAnimationFrame(() => document.getElementById('account-identity-trigger')?.focus());
  }
  return <div className="app-shell projects-shell">
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to main content</a>
    <aside className="sidebar"><button className="brand" onClick={() => setView('projects')} aria-label="Confidence projects"><BrandMark /><span>confidence<span className="brand-period">.</span></span></button>
      <div className="project-switcher"><label htmlFor="project-switch">Current project</label><select id="project-switch" value={project?.projectId ?? ''} onChange={event => event.target.value ? setView(landingView, event.target.value) : setView('projects')}><option value="">All projects</option>{directory.data?.projects.map(item => <option value={item.projectId} key={item.projectId}>{item.name}{item.status === 'ARCHIVED' ? ' · Archived' : ''}</option>)}</select></div>
      <nav aria-label="Main navigation"><button className={`nav-item ${route.view === 'projects' ? 'active' : ''}`} aria-current={route.view === 'projects' ? 'page' : undefined} onClick={() => setView('projects')}><Icon name="layers" /><span>All projects</span></button>{selectedId && <><div className="sidebar-label">PROJECT</div><ProjectNavigation profileKnown={profileKnown} collaborationOnly={collaborationOnly} nativeWorkflow={Boolean(project?.capabilities.nativeWorkflow)} discussionEnabled={discussionEnabled} view={route.view} open={setView} /></>}
        {profileKnown && !collaborationOnly && <><div className="sidebar-label">TOOLS</div><button className={`nav-item ${route.view === 'verify' ? 'active' : ''}`} aria-current={route.view === 'verify' ? 'page' : undefined} onClick={() => setView('verify')}><Icon name="file" /><span>Verify a receipt</span></button>{project?.capabilities.nativeWorkflow && <button className={`nav-item ${route.view === 'integration' ? 'active' : ''}`} aria-current={route.view === 'integration' ? 'page' : undefined} onClick={() => setView('integration')}><Icon name="cloud" /><span>Runtime</span></button>}</>}
      </nav><div className="sidebar-bottom"><button className="nav-item" onClick={() => setHelp(!help)} aria-expanded={help}><Icon name="help" /><span>How this works</span></button><div className="user-row"><span className="user-avatar">{directory.current ? 'S' : '?'}</span><div><strong>{directory.current ? localIdentity ? 'Local development' : 'Signed-in member' : 'Session unverified'}</strong><span>{directory.current ? localIdentity ? 'Local pilot identity' : 'Private collaboration' : 'Refresh to confirm access'}</span></div><span className={`user-status ${directory.current ? '' : 'unverified'}`} /></div></div></aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumbs"><button onClick={() => setView('projects')}>Projects</button>{selectedId && <><Icon name="chevron" size={13} /><strong>{project?.name || (route.view === 'accept' ? 'Project invitation' : 'Project unavailable')}</strong></>}<span className="project-private"><Icon name="lock" size={12} />Private</span></div><div className="topbar-status"><button id="account-identity-trigger" type="button" className="icon-button" aria-label="Your identity" title="Your identity" aria-expanded={showIdentity} aria-controls="account-identity" onClick={() => setShowIdentity(!showIdentity)}><Icon name="shield" size={16} /></button><ThemeToggle /><span className={`connection-dot ${directory.current ? 'connected' : ''}`} /><span className="connection-label" role="status">{directory.current ? 'Directory current' : directory.loading ? 'Loading projects' : 'Directory unavailable'}</span><button className="icon-button" aria-label="Refresh projects" title="Refresh projects" onClick={() => void refreshDirectory(true)}><Icon name="refresh" size={16} /></button></div></header>
    <main id="main-content" tabIndex={-1}>
      {localEnvironment && <div className="local-environment" role="note"><Icon name="terminal" size={14} /><span>Local test environment</span></div>}
      {showIdentity && <AccountIdentity key={`identity:${directory.data?.principalId ?? 'unverified'}`} expectedPrincipalId={directory.data?.principalId} local={localIdentity || localEnvironment} refreshDirectory={() => void refreshDirectory(true)} close={closeIdentity} />}
      {directory.error && <div className="notice danger" role="alert"><Icon name="error" /><div><strong>Project directory unavailable</strong><p>{directory.error} {directory.data && 'The displayed directory is unverified. Project changes are paused.'}</p></div><button className="button" onClick={() => void refreshDirectory(true)}>Refresh projects</button></div>}
      {directory.data?.maintenance && <div className="notice warning" role="status"><Icon name="lock" /><p>Maintenance mode is read-only. Project changes are paused.</p></div>}
      {project?.status === 'ARCHIVED' && <div className="notice neutral" role="status"><Icon name="pause" /><div><strong>This project is archived.</strong><p>Its source and settings are retained. Restore it in settings to resume project changes.</p></div><button className="button" onClick={() => setView('settings')}>Open settings</button></div>}
      {commandState.storageError && <div className="notice danger" role="alert">{commandState.storageError}</div>}
      {pending && (pending.kind === 'metadata' || !nativeView || pendingProjectId(pending) !== project?.projectId) && <section className="notice warning pending-project-command" role="status"><Icon name="time" /><div><strong>{pending.status === 'UNKNOWN' ? 'Command outcome unknown' : pending.status === 'REJECTED' ? 'Command rejected' : 'Awaiting acknowledgement'}</strong><p>{pending.label}. {pending.detail}</p><p className="small">New actions are paused. Recovery preserves the original project, command key and exact inputs.</p>{pending.kind === 'metadata' && !recoverable && <p className="small">{directory.current ? 'Restore the original account and project access to recover this change.' : 'Refresh the project directory to confirm the original account and project access.'}</p>}</div><div className="button-row">{pending.status === 'UNKNOWN' && pending.kind === 'metadata' && <button className="button" disabled={!recoverable || Boolean(busy) || directory.data?.maintenance} onClick={() => void recover()}>Recover same command</button>}{pending.kind !== 'metadata' && pendingProjectId(pending) && <button className="button" onClick={() => setView('workspace', pendingProjectId(pending))}>Open original project</button>}{pending.status === 'REJECTED' && <button className="button" onClick={() => commands.dismissRejection()}>Dismiss rejection</button>}<button className="button" onClick={() => downloadJSON(pending, `confidence-command-${pending.id}.json`)}>Export recovery record</button></div></section>}
      {error && <div className="notice danger" role="alert"><Icon name="error" /><p>{error}</p><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><Icon name="x" /></button></div>}
      {notice && <div className="notice neutral" role="status"><Icon name="check" /><p>{notice}</p><button className="icon-button" aria-label="Dismiss notice" onClick={() => setNotice('')}><Icon name="x" /></button></div>}
      {help && <section className="panel onboarding"><div className="section-heading"><h2>{collaborationOnly ? 'Work together in a private project.' : 'From source to evidence.'}</h2><button className="icon-button" aria-label="Close help" onClick={() => setHelp(false)}><Icon name="x" /></button></div>{collaborationOnly ? <><p>Create a project, enable verified ownership in Project access, and share its Discussion link. Each collaborator signs in and requests their own access.</p><p>Post questions and results, download your own scoped agent connection, and fetch the pinned Weft dependency. Release checks and publication are not available in this deployment.</p></> : <><p>Create a project, import a local repository, and choose checks that reflect its goals. Each project keeps its own source, settings and access.</p><p>An enrolled release workflow can add bounded agent contributions, protected checks, exact review and publication receipts. The workspace shows which capabilities are available for the selected project.</p><p>You can verify an exported receipt independently with your separately retained trust files.</p></>}</section>}
      {!profileKnown && route.view !== 'accept' ? <div className="loading-state" role="status"><BrandMark /><h2>{deploymentIdentity.status === 'unavailable' ? 'Deployment identity unavailable' : 'Checking your sign-in'}</h2><p>Confirming the available application capabilities for this account.</p><button className="button" onClick={() => { void deploymentIdentityStore.refresh(); void refreshDirectory(true); }}>Refresh sign-in</button></div>
      : route.view === 'accept' ? <Collaboration key={`accept:${invitation?.secret?.invitationId ?? 'none'}`} local={localIdentity} accepting intake={invitation} clearIntake={() => setInvitation(undefined)} onChanged={() => { void refreshDirectory(true); }} onAccepted={() => { if (invitation?.secret) setView('collaboration', invitation.secret.scope.projectId); void refreshDirectory(true); }} />
      : route.view === 'collaboration' ? <Collaboration key={`collaboration:${selectedId ?? 'none'}:${directory.data?.principalId ?? 'unknown'}`} projectId={selectedId} local={localIdentity} readOnly={!directory.current || Boolean(directory.data?.maintenance) || project?.status === 'ARCHIVED'} clearIntake={() => setInvitation(undefined)} onChanged={() => { void refreshDirectory(true); }} onAccepted={() => { void refreshDirectory(true); }} />
      : route.view === 'discussion' && selectedId ? <ProjectDiscussionRoute enabled={discussionEnabled} openProjects={() => setView('projects')}><ProjectDiscussion key={`discussion:${selectedId}:${project?.projectIncarnation ?? 'pending'}:${directory.data?.principalId ?? 'unknown'}`} projectId={selectedId} project={project} principalId={directory.current ? directory.data?.principalId : undefined} draftScope={protectedDraftScope(directory.data, route)} drafts={drafts} origin={window.location.origin} readOnly={!directory.current || Boolean(directory.data?.maintenance) || project?.status === 'ARCHIVED'} refreshDirectory={() => void refreshDirectory(true)} openAccess={() => setView('collaboration')} /></ProjectDiscussionRoute>
      : route.view === 'projects' ? directory.data ? <Projects key={directory.data.principalId} directory={directory.data} collaborationOnly={collaborationOnly} disabled={blocked} manage={manage} open={openProject} /> : <div className="loading-state" role="status"><BrandMark /><h2>{directory.loading ? 'Opening your projects' : 'Projects unavailable'}</h2><p>{directory.loading ? 'Reading your project directory…' : 'Refresh projects to confirm your current account.'}</p>{!collaborationOnly && <button className="button" onClick={() => setView('verify')}>Verify retained files</button>}</div>
      : route.view === 'verify' && (!project || !nativeView) ? <><div className="page-heading"><div className="eyebrow">Portable evidence</div><h1>Verify a receipt.</h1><p>Choose your receipt and separately retained trust files to inspect them in this browser.</p></div><Verifier key={scopeKey} projectAvailable={false} /></>
      : !project ? directory.loading ? <div className="loading-state" role="status"><BrandMark /><h2>Opening the project</h2><p>Reading your project access…</p></div> : <PendingAccess key={directory.data?.principalId ?? 'unknown'} refresh={() => void refreshDirectory(true)} />
      : route.view === 'settings' ? <ProjectSettings key={scopeKey} project={project} collaborationOnly={collaborationOnly} disabled={blocked} manage={manage} draftScope={scopeKey} drafts={drafts} />
      : nativeView ? <ProjectWorkflow key={scopeKey} projectId={project.projectId} view={route.view as View} setView={view => setView(view)} commands={commands} readOnly={project.status === 'ARCHIVED' || !directory.current || Boolean(directory.data?.maintenance)} />
      : route.view === 'workspace' ? <RepositoryWorkspace key={scopeKey} project={project} origin={window.location.origin} openSettings={() => setView('settings')} sessionScope={scopeKey} principalId={directory.data?.principalId} sourceAvailable={directory.current} />
      : <section className="panel project-empty"><Icon name="server" size={32} /><h2>This workflow is not configured</h2><p>{project.capabilities.reason}</p><button className="button" onClick={() => setView('workspace')}>Open repository workspace</button></section>}
    </main><footer className="app-footer"><button onClick={() => setHelp(!help)} aria-expanded={help}>How this works</button><span>confidence<span>.</span></span><p>Concurrent exploration. Explicit authority. Inspectable outcomes.</p><button onClick={() => setView('projects')}>Your projects<Icon name="arrow" size={14} /></button></footer></div>
  </div>;
}
