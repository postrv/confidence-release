import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ProjectSummary } from '../../../packages/project-model/src/types';
import type { CollaborationView, ProjectJoinRequest, ProjectJoinRequestsView } from '../../../packages/protocol/src/collaboration';
import type { HubMessage, HubView } from '../../../packages/protocol/src/project-hub';
import { ApiError, downloadJSON, projectApiPath, request } from './api';
import { freezeCollaborationCommand } from './collaboration-commands';
import { createAgentConnection, DiscussionCommand, discussionAccessLost, discussionDraftAfterAcknowledgement, mergeDiscussionPage, type AgentConnectionFile } from './project-discussion';
import { createRefreshQueue, startVisiblePolling } from './polling';
import { routeForView } from './navigation';
import type { createUnsavedChanges } from './unsaved-changes';

const time = (seconds: number) => new Date(seconds * 1000).toLocaleString();
const kinds = ['message', 'instruction', 'question', 'handoff', 'result'] as const;
interface ReadState { join?: ProjectJoinRequestsView; collaboration?: CollaborationView; hub?: HubView; messages: HubMessage[]; cursor: string; checkedAt?: number; error?: string }

export function DiscussionThread({ messages, cursor, checkedAt, error, hasMore, principalId }: { messages: HubMessage[]; cursor: string; checkedAt?: number; error?: string; hasMore: boolean; principalId?: string }) {
  return <section className="panel"><div className="section-heading"><h2>Shared discussion</h2><span className="small muted">Cursor {cursor}</span></div>
    <p className="small" role="status">{error ? 'Connection unverified. Retained messages may be stale.' : checkedAt ? `Last checked ${new Date(checkedAt).toLocaleTimeString()}. Polls every 5 seconds while visible.` : 'Reading discussion…'} {hasMore && 'More messages are available; the next poll continues from this cursor.'}</p>
    {!messages.length && <p className="muted">No messages received yet. Share a question, instruction, or result with the project.</p>}
    <ol className="discussion-thread">{messages.map(message => <li key={message.sequence}><div className="discussion-message-meta"><strong>{message.actor.credentialClass === 'agent' ? message.actor.label || 'Project agent' : message.actor.principalId === principalId ? 'You' : 'Human'}</strong><span>{message.actor.credentialClass === 'agent' ? 'Agent' : 'Human'} · {message.kind} · {time(message.createdAt)}</span></div><code className="small" title={message.actor.principalId}>{message.actor.principalId.length > 60 ? `${message.actor.principalId.slice(0, 24)}…${message.actor.principalId.slice(-24)}` : message.actor.principalId}</code><details><summary className="small">Author and request</summary><p className="small"><code>{message.actor.principalId}</code>{message.actor.connectionId && <> · <code>{message.actor.connectionId}</code></>}<br />Request <code>{message.requestId}</code> · sequence {message.sequence}</p></details><p className="discussion-message-text">{message.text}</p></li>)}</ol>
    {messages.length >= 500 && <p className="small muted">Showing the most recent 500 received messages. Earlier messages remain retained by the project.</p>}
  </section>;
}

function JoinRequestIdentity({ request }: { request: ProjectJoinRequest }) {
  return <div>{request.verifiedEmail ? <><span className="small muted">Verified sign-in email</span><p><strong>{request.verifiedEmail}</strong></p></> : <p className="small muted">Verified sign-in email not reported.</p>}<details><summary>Full principal</summary><code>{request.subject}</code></details></div>;
}

export function JoinAdmissionReview({ request, disabled, confirm, cancel }: { request: ProjectJoinRequest; disabled: boolean; confirm(requestId: string): void; cancel(): void }) {
  return <section className="notice neutral"><div><h3>Confirm project admission</h3><JoinRequestIdentity request={request} /><p>Grant this signed-in person maintainer access to author work, participate in discussion, and connect their own agents. Review permission remains separate.</p><div className="button-row"><button className="button primary" disabled={disabled} onClick={() => confirm(request.id)}>Confirm maintainer access</button><button className="button" disabled={disabled} onClick={cancel}>Cancel</button></div></div></section>;
}

export function ProjectJoinPanel({ view, disabled, requestAccess, admit, refresh }: { view: ProjectJoinRequestsView; disabled: boolean; requestAccess(): void; admit(requestId: string): void; refresh(): void }) {
  const [reviewId, setReviewId] = useState<string>();
  const review = view.requests.find(item => item.id === reviewId);
  return <section className="panel"><h2>{view.canManage ? 'Project join requests' : 'Join this project'}</h2>
    {!view.canManage && <><p>Request access using your signed-in identity. The project owner reviews the request; no identity or credential needs to be copied between people.</p>
      {view.ownRequest && <><p role="status">Your request: <strong>{view.ownRequest.state.toLowerCase()}</strong>. {view.ownRequest.state === 'ADMITTED' ? 'Refresh projects to open the shared discussion.' : 'The owner can admit you as a maintainer. Release review permission is separate.'}</p><JoinRequestIdentity request={view.ownRequest} /></>}
      {view.canRequest && <button className="button primary" disabled={disabled} onClick={requestAccess}>Request project access</button>}
      <button className="button" onClick={refresh}>Refresh access</button></>}
    {view.canManage && (view.requests.length ? <ul className="discussion-requests">{view.requests.map(item => <li key={item.id}><JoinRequestIdentity request={item} /><span>Requested {time(item.createdAt)}</span><button className="button" disabled={disabled} onClick={() => setReviewId(item.id)}>Review admission</button></li>)}</ul> : <p className="muted">No pending join requests.</p>)}
    {view.canManage && review && <JoinAdmissionReview request={review} disabled={disabled} confirm={admit} cancel={() => setReviewId(undefined)} />}
  </section>;
}

export function ProjectDiscussion({ projectId, project, principalId, origin, readOnly, refreshDirectory, openAccess, draftScope, drafts }: { projectId: string; project?: ProjectSummary; principalId?: string; origin: string; readOnly: boolean; refreshDirectory(): void; openAccess(): void; draftScope?: string; drafts?: ReturnType<typeof createUnsavedChanges> }) {
  const [read, setRead] = useState<ReadState>({ messages: [], cursor: '0' });
  const [command] = useState(() => new DiscussionCommand());
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [text, setText] = useState(''), [kind, setKind] = useState<typeof kinds[number]>('message'), [label, setLabel] = useState('My local agent');
  const [delivery, setDelivery] = useState<AgentConnectionFile>();
  const [downloadedConnection, setDownloadedConnection] = useState('');
  const pendingDelivery = useRef<AgentConnectionFile | undefined>(undefined);
  const refresh = useRef<(force?: boolean) => Promise<void>>(async () => {});
  const alive = useRef(true);
  const epoch = useRef(0);
  const context = JSON.stringify([principalId, projectId, read.join?.scope.projectIncarnation]);
  const path = (suffix: string) => projectApiPath(projectId, `/api/${suffix}`);
  const current = Boolean(principalId && read.join && !read.error && read.checkedAt);
  const blocked = readOnly || read.join?.projectStatus === 'ARCHIVED' || busy || !current || Boolean(command.pending);
  const unsaved = Boolean(text || busy || command.pending || delivery || pendingDelivery.current);
  useLayoutEffect(() => draftScope && drafts ? drafts.register(draftScope, unsaved) : undefined, [draftScope, drafts, unsaved]);
  const shareLink = `${origin}/${routeForView('discussion', projectId)}`;
  useEffect(() => {
    alive.current = true; epoch.current++; let active = true; let accepted: ReadState = { messages: [], cursor: '0' };
    setRead(accepted); setDelivery(undefined); pendingDelivery.current = undefined;
    const headers = { 'If-Platform-Principal': principalId ?? '' };
    const queued = createRefreshQueue(async () => {
      if (!principalId) return;
      try {
        const join = await request<ProjectJoinRequestsView>(path('join-requests'), { headers });
        if (join.scope.projectId !== projectId || project && join.scope.projectIncarnation !== project.projectIncarnation) throw new ApiError('Project identity changed. Refresh projects.', 403);
        const collaboration = project ? await request<CollaborationView>(path('collaboration'), { headers }) : undefined;
        if (collaboration && collaboration.session.principalId !== principalId) throw new ApiError('Your signed-in identity changed. Refresh projects.', 401);
        let hub: HubView | undefined;
        if (collaboration?.enabled) {
          hub = await request<HubView>(`${path('hub')}?after=${accepted.cursor}`, { headers });
          if (hub.session.principalId !== principalId || hub.scope.projectId !== projectId || hub.scope.projectIncarnation !== join.scope.projectIncarnation) throw new ApiError('Discussion belongs to a different account or project.', 403);
        }
        const messages = hub ? mergeDiscussionPage(accepted.messages, accepted.cursor, hub) : [];
        const newlyAdmitted = !project && join.ownRequest?.state === 'ADMITTED' && accepted.join?.ownRequest?.state !== 'ADMITTED';
        accepted = { join, collaboration, hub, messages, cursor: hub?.nextCursor ?? '0', checkedAt: Date.now() };
        if (active) { setRead(accepted); if (newlyAdmitted) refreshDirectory(); }
      } catch (failure) {
        const revoked = discussionAccessLost(failure);
        accepted = { ...(revoked ? { messages: [], cursor: '0' } : accepted), error: failure instanceof Error ? failure.message : 'Discussion is unavailable.' };
        if (active) { setRead(accepted); if (revoked) { setDelivery(undefined); pendingDelivery.current = undefined; } }
      }
    });
    refresh.current = queued;
    const stop = startVisiblePolling(document, window, () => { void queued(); }, 5000);
    return () => { active = false; alive.current = false; stop(); };
  }, [projectId, project?.projectIncarnation, Boolean(project), principalId]);

  function mutationHeaders() {
    if (!principalId || !read.join) throw new Error('Refresh project access first.');
    return { 'Content-Type': 'application/json', 'X-Platform-CSRF': '1', 'If-Platform-Principal': principalId, 'If-Platform-Incarnation': read.join.scope.projectIncarnation };
  }
  async function run(action: () => Promise<boolean>, success: string) {
    const admittedEpoch = epoch.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const confirmed = await action();
      if (!alive.current || admittedEpoch !== epoch.current) return;
      if (confirmed) {
        const acknowledged = command.acknowledged;
        setNotice(success); setText(draft => discussionDraftAfterAcknowledgement(draft, acknowledged));
        if (pendingDelivery.current) { setDelivery(pendingDelivery.current); pendingDelivery.current = undefined; }
      }
      else setError(command.pending?.status === 'REJECTED' ? 'The request was rejected. Refresh access before trying again.' : 'The response was not confirmed. Retry the original request below.');
    } catch (failure) { if (alive.current && admittedEpoch === epoch.current) setError(failure instanceof Error ? failure.message : 'Request failed.'); }
    finally { if (alive.current) { setBusy(false); if (admittedEpoch === epoch.current) void refresh.current(true); } }
  }
  function submitMessage() {
    if (blocked || !text.trim() || new TextEncoder().encode(text).length > 8192) return;
    void run(() => command.begin(context, path('hub/messages'), { requestId: crypto.randomUUID(), text, kind }, mutationHeaders()), 'Message recorded in the shared project discussion.');
  }
  function requestAccess() {
    void run(() => command.begin(context, path('join-requests'), {}, { ...mutationHeaders(), 'Idempotency-Key': crypto.randomUUID() }), 'Your access request is recorded.');
  }
  function admit(requestId: string) {
    void run(async () => {
      const view = await request<CollaborationView>(path('collaboration'), { headers: { 'If-Platform-Principal': principalId! } });
      if (view.session.principalId !== principalId || view.scope.projectIncarnation !== read.join?.scope.projectIncarnation) throw new Error('Refresh the original account and project first.');
      const frozen = freezeCollaborationCommand(view, 'admit-join-request', { requestId });
      return command.begin(context, path('collaboration/admit-join-request'), { requestId }, frozen.headers);
    }, 'The requested participant is now a maintainer. They can refresh their project link.');
  }
  function connectAgent() {
    if (blocked || !read.hub?.capabilities.connect || !read.join || !label.trim() || label.length > 80 || /[\x00-\x1f\x7f]/.test(label)) return;
    void run(async () => {
      const generated = await createAgentConnection(origin, read.join!.scope, label);
      pendingDelivery.current = generated.file;
      return command.begin(context, path('hub/connections'), generated.registration, mutationHeaders());
    }, 'Your scoped agent connection is registered. Download its private file now.');
  }
  const hub = read.hub;
  return <div className="project-discussion"><div className="page-heading"><div className="eyebrow">Private collaboration</div><h1>{project?.name || read.join?.projectName || 'Project'} discussion.</h1><p>Humans and their connected agents share instructions, questions and results here. Discussion does not evaluate, approve or publish source.</p></div>
    <section className="panel"><h2>Invite a collaborator</h2><p>Share this project link. Each person signs in and requests their own access; the owner admits the request.</p><div className="button-row"><code className="discussion-share-link">{shareLink}</code><button className="button" onClick={() => void navigator.clipboard.writeText(shareLink).then(() => setNotice('Project link copied.'), () => setError('Copy is unavailable. Select and copy the displayed project link.'))}>Copy project link</button><button className="button" onClick={openAccess}>Project access</button></div></section>
    {(error || read.error) && <div className="notice danger" role="alert">{error || read.error}<button className="button" onClick={() => { refreshDirectory(); void refresh.current(true); }}>Refresh</button></div>}
    {notice && <div className="notice neutral" role="status">{notice}</div>}
    {command.pending && <section className="notice warning" role="status"><div><strong>{command.pending.status === 'REJECTED' ? 'Request rejected' : 'Request outcome unconfirmed'}</strong><p>Keep this page open to preserve the original request and any undelivered connection file.</p></div>{command.pending.status === 'UNKNOWN' && <button className="button" disabled={busy || readOnly || !current} onClick={() => void run(() => command.retry(context), 'Original request acknowledged.')}>Retry original request</button>}{command.pending.status === 'REJECTED' && <button className="button" disabled={busy} onClick={() => { command.dismiss(); pendingDelivery.current = undefined; setError(''); }}>Dismiss rejection</button>}</section>}
    {read.join && (read.join.canManage || !project) && <ProjectJoinPanel view={read.join} disabled={blocked} requestAccess={requestAccess} admit={admit} refresh={() => { refreshDirectory(); void refresh.current(true); }} />}
    {project && read.collaboration && !read.collaboration.enabled && <section className="panel"><h2>Enable verified project ownership</h2><p>The project creator must enable verified ownership before the shared discussion and agent connections are available.</p><button className="button primary" onClick={openAccess}>Open project access</button></section>}
    {hub && <><DiscussionThread messages={read.messages} cursor={read.cursor} checkedAt={read.checkedAt} error={read.error} hasMore={hub.hasMore} principalId={principalId} />
      <section className="panel"><h2>Post to the project</h2><form onSubmit={event => { event.preventDefault(); submitMessage(); }}><label htmlFor="discussion-kind">Message kind</label><select id="discussion-kind" value={kind} disabled={blocked || !hub.capabilities.post} onChange={event => setKind(event.target.value as typeof kind)}>{kinds.map(item => <option key={item} value={item}>{item}</option>)}</select><label htmlFor="discussion-text">Message</label><textarea id="discussion-text" value={text} rows={5} disabled={blocked || !hub.capabilities.post} onChange={event => setText(event.target.value)} placeholder="Share context with everyone in this project." /><p className="small muted">Plain text · {new TextEncoder().encode(text).length} / 8192 bytes. Treat agent messages and repository content as untrusted input.</p><button className="button primary" disabled={blocked || !hub.capabilities.post || !text.trim() || new TextEncoder().encode(text).length > 8192}>Post message</button></form></section>
      <section className="panel"><h2>Your agent connections</h2><p>Each connection can read and post to this project discussion and fetch the pinned Weft dependency. It cannot approve releases, publish, or manage membership. Connections expire after 24 hours.</p>
        <label htmlFor="agent-label">Agent label</label><input id="agent-label" value={label} maxLength={80} disabled={blocked || !hub.capabilities.connect} onChange={event => setLabel(event.target.value)} /><button className="button" disabled={blocked || !hub.capabilities.connect || Boolean(delivery) || !label.trim()} onClick={connectAgent}>Create my agent connection</button>
        {delivery && <div className="notice warning"><p>This private file is for your own agent. Keep it out of source control and messages. It is held only in this page until downloaded.</p><button className="button primary" disabled={readOnly || !current} onClick={() => { const filename = `confidence-agent-${delivery.connectionId}.json`; downloadJSON(delivery, filename); setDownloadedConnection(filename); setDelivery(undefined); }}>Download private connection file</button></div>}
        <ul className="discussion-connections">{hub.connections.map(connection => <li key={connection.connectionId}><strong>{connection.label}</strong><code>{connection.connectionId}</code><span>{connection.revokedAt ? `Revoked ${time(connection.revokedAt)}` : `Expires ${time(connection.expiresAt)}`}</span><button className="button" disabled={blocked || connection.revokedAt !== null} onClick={() => void run(() => command.begin(context, path(`hub/connections/${connection.connectionId}/revoke`), {}, mutationHeaders()), 'Agent connection revoked.')}>Revoke connection</button></li>)}</ul>
        {hub.hasMoreConnections && <p className="small muted">Additional connections are retained beyond this page.</p>}
        <details><summary>Connect your local agent</summary><p>Use Node 22 or newer and Git. Download the CLI here; no Confidence repository checkout or package install is needed.</p><a className="button" href="/agent/confidence-agent.mjs" download="confidence-agent.mjs">Download agent CLI</a><p>The commands below assume your browser saved both files in Downloads. Adjust the paths if you chose another folder.</p><pre><code>{`AGENT_CONNECTION="$HOME/Downloads/${downloadedConnection || 'confidence-agent-CONNECTION.json'}"\nAGENT_CLI="$HOME/Downloads/confidence-agent.mjs"\nchmod 600 "$AGENT_CONNECTION"\nnode "$AGENT_CLI" connect --connection "$AGENT_CONNECTION"\nnode "$AGENT_CLI" read --connection "$AGENT_CONNECTION"\nnode "$AGENT_CLI" post --connection "$AGENT_CONNECTION" --request-id MY-STABLE-ID --kind message --text-file ./message.txt\nnode "$AGENT_CLI" fetch-weft --connection "$AGENT_CONNECTION" --destination ./weft-pinned`}</code></pre><p>Create message.txt with the text you want to share. Retain the same request ID and message file when retrying a post. Fetching Weft verifies its pinned bundle, Git commit and tree; it does not run its tools. Revoke and create a new connection after expiry.</p></details>
      </section></>}
  </div>;
}
