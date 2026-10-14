import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { CollaborationRole, CollaborationSession, CollaborationView, Collaborator } from '../../../packages/protocol/src/collaboration';
import { COLLABORATION_ROLES } from '../../../packages/protocol/src/collaboration';
import { ApiError, projectApiPath, request } from './api';
import { Badge, Identity } from './components';
import { collaborationCommands, collaborationScope, createInvitationSecret, freezeCollaborationCommand, type CollaborationContext } from './collaboration-commands';
import { invitationLink, matchingInvitationInspection, type InvitationInspection, type InvitationIntake } from './invitation-secret';
import { Icon } from './icons';
import { startVisiblePolling } from './polling';

const roleLabels: Record<CollaborationRole, string> = { viewer: 'Viewer', contributor: 'Contributor', reviewer: 'Reviewer', maintainer: 'Maintainer', owner: 'Owner' };
const roleAccess: Record<CollaborationRole, string> = {
  viewer: 'Read source and evidence', contributor: 'Read source; work needs a separate attempt grant', reviewer: 'Read source; approve protected publication',
  maintainer: 'Read source; sponsor work and request publication', owner: 'Manage access and protected project settings',
};
const formatTime = (at: number) => new Date(at * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
export function compactPrincipal(principalId: string): string {
  const separator = principalId.lastIndexOf('#');
  if (separator < 1) return principalId.length > 48 ? `${principalId.slice(0, 24)}...${principalId.slice(-16)}` : principalId;
  const subject = principalId.slice(separator + 1);
  const compactSubject = subject.length > 24 ? `${subject.slice(0, 8)}...${subject.slice(-8)}` : subject;
  try { return `${new URL(principalId.slice(0, separator)).hostname}#${compactSubject}`; }
  catch { return `${principalId.slice(0, separator)}#${compactSubject}`; }
}
type Tab = 'members' | 'invitations' | 'audit';
type MemberAction = { member: Collaborator; mode: 'role' | 'remove' | 'sessions' | 'review' };

function canAddReview(member: Collaborator): boolean {
  return member.active && (member.role === 'owner' || member.role === 'maintainer');
}

function Failure({ message }: { message: string }) {
  return <div className="notice danger" role="alert"><Icon name="error" /><p>{message}</p></div>;
}

function RoleSelect({ value, onChange, allowOwner, disabled }: { value: CollaborationRole; onChange(value: CollaborationRole): void; allowOwner?: boolean; disabled?: boolean }) {
  return <select aria-label="Role" value={value} onChange={event => onChange(event.target.value as CollaborationRole)} disabled={disabled}>
    {COLLABORATION_ROLES.filter(role => allowOwner || role !== 'owner').map(role => <option key={role} value={role}>{roleLabels[role]}</option>)}
  </select>;
}

export function migrationReviewKey(view: CollaborationView): string {
  return JSON.stringify([view.scope.tenantId, view.scope.projectId, view.scope.projectIncarnation, view.session.principalId, view.revision, view.migration]);
}

export function CollaborationMigration({ view, disabled, acknowledged, acknowledge, enable }: {
  view: CollaborationView; disabled: boolean; acknowledged: boolean; acknowledge(value: boolean): void; enable(): void;
}) {
  const migration = view.migration;
  const blocked = disabled || !migration || Boolean(migration.unresolvedPublicationId);
  return <section className="collaboration-migration" aria-label="Ownership migration review">
    <h2>Verified ownership is not enabled</h2>
    <p>{view.canEnable ? 'The current authenticated human administrator can establish the first owner.' : 'A verified human administrator must establish project ownership.'}</p>
    {view.canEnable && <>
      <p>All other legacy memberships will be suspended and their attempt grants revoked. Reinvite anyone who should keep access.</p>
      {!migration ? <div className="notice warning" role="status"><Icon name="time" /><p>The migration preview is unavailable. Refresh project access before enabling ownership.</p></div> : <>
        <dl className="migration-impact"><div><dt>Members to suspend</dt><dd>{migration.membersToSuspend}</dd></div><div><dt>Attempt grants to revoke</dt><dd>{migration.grantsToRevoke}</dd></div><div><dt>Approvals to invalidate</dt><dd>{migration.approvalsToInvalidate}</dd></div></dl>
        <details className="migration-members"><summary>Affected identities ({migration.membersToSuspend})</summary>
          {migration.memberSample.length ? <ul>{migration.memberSample.map(member => <li key={member.subject}><code>{member.subject}</code><span>{member.roles.join(', ')}</span></li>)}</ul> : <p>No other active legacy memberships are affected.</p>}
          {migration.sampleTruncated && <p className="small muted">Showing {migration.memberSample.length} of {migration.membersToSuspend} affected identities.</p>}
        </details>
        {migration.unresolvedPublicationId && <div className="notice warning" role="status"><Icon name="time" /><div><strong>An admitted publication is unresolved.</strong><p><code>{migration.unresolvedPublicationId}</code></p><p>Enabling ownership cannot cancel this operation. Resolve it before enabling verified ownership.</p></div></div>}
      </>}
      <label className="checkbox-line migration-acknowledgement"><input type="checkbox" checked={acknowledged} disabled={blocked} onChange={event => acknowledge(event.target.checked)} /><span>I reviewed this migration and accept its access changes.</span></label>
      <button className="button primary" disabled={blocked || !acknowledged} onClick={enable}><Icon name="shield" size={16} />Enable verified ownership</button>
    </>}
  </section>;
}

export function CollaborationMembers({ view, disabled, edit, reinvite }: { view: CollaborationView; disabled: boolean; edit(action: MemberAction): void; reinvite(member: Collaborator): void }) {
  return <table className="collaboration-list"><thead><tr><th className="member-identity" scope="col">Verified identity</th><th scope="col">Role</th><th scope="col">Access</th><th className="member-actions" scope="col">Actions</th></tr></thead><tbody>
    {view.members.map(member => <tr key={member.subject}><td className="member-identity"><strong>{member.subject === view.session.principalId ? 'You' : 'Project member'}</strong><code className="principal-summary" title={member.subject}>{compactPrincipal(member.subject)}</code><details className="principal-details"><summary>Full identity</summary><Identity label="Verified principal" value={member.subject} /></details><small>Verified {formatTime(member.verifiedAt)}</small></td><td className="member-role"><strong>{roleLabels[member.role]}</strong><span className="collaboration-permissions">{roleAccess[member.role]}</span>{canAddReview(member) && <span className="collaboration-permissions">{member.additionalReview ? 'Additional review permission granted' : 'Review permission not granted'}</span>}</td><td className="member-state"><Badge status={member.active ? 'active' : 'revoked'} />{member.sessionsRevokedBefore > 0 && <small>Sessions revoked {formatTime(member.sessionsRevokedBefore)}</small>}</td><td className="member-actions">{view.canManage && <><div className="collaboration-row-actions">
      <button className="icon-button" aria-label={`${member.active ? 'Change role for' : 'Reinvite'} ${member.subject}`} title={member.active ? 'Change role' : 'Reinvite member'} disabled={disabled} onClick={() => member.active ? edit({ member, mode: 'role' }) : reinvite(member)}><Icon name={member.active ? 'shield' : 'arrow'} size={15} /></button>
      {member.active && <button className="icon-button" aria-label={`Remove ${member.subject}`} title="Remove member" disabled={disabled} onClick={() => edit({ member, mode: 'remove' })}><Icon name="x" size={15} /></button>}
      <button className="icon-button" aria-label={`Revoke sessions for ${member.subject}`} title="Revoke sessions" disabled={disabled} onClick={() => edit({ member, mode: 'sessions' })}><Icon name="lock" size={15} /></button>
    </div>
      {canAddReview(member) && <button className="button" aria-label={`${member.additionalReview ? 'Revoke review permission from' : 'Grant review permission to'} ${member.subject}`} disabled={disabled} onClick={() => edit({ member, mode: 'review' })}>{member.additionalReview ? 'Revoke review permission' : 'Grant review permission'}</button>}
    </>}</td></tr>)}
  </tbody></table>;
}

export function ReviewPermissionEditor({ member, disabled, submit, close }: {
  member: Collaborator; disabled: boolean; submit(body: { subject: string; enabled: boolean }): void; close(): void;
}) {
  if (!canAddReview(member)) return null;
  const enabled = !member.additionalReview;
  const title = enabled ? 'Grant review permission' : 'Revoke review permission';
  return <section className="collaboration-editor" aria-label={title}><h2>{title}</h2><p><code>{member.subject}</code></p>
    <p>{roleLabels[member.role]} role and authoring permissions stay unchanged.</p>
    <p>{enabled ? 'Verified human approval can authorize the exact reviewed candidate after protected checks pass. Agents and services cannot approve.' : 'Verified human approval will no longer be available to this member. Unconsumed approvals will be invalidated; an already admitted publication keeps its recorded authority.'}</p>
    <div className="button-row"><button className="button primary" disabled={disabled} onClick={() => submit({ subject: member.subject, enabled })}><Icon name="shield" size={16} />{title}</button><button className="button" disabled={disabled} onClick={close}>Cancel</button></div>
  </section>;
}

function MemberEditor({ action, disabled, submit, close }: { action: MemberAction; disabled: boolean; submit(role: CollaborationRole): void; close(): void }) {
  const [role, setRole] = useState<CollaborationRole>(action.member.role === 'owner' ? 'maintainer' : action.member.role);
  const title = action.mode === 'remove' ? 'Remove project access' : action.mode === 'sessions' ? 'Revoke current sessions' : 'Change member role';
  return <section className="collaboration-editor" aria-label={title}><h2>{title}</h2><p><code>{action.member.subject}</code></p>
    {action.mode === 'role' ? <div className="collaboration-fields"><label className="collaboration-field">Role<RoleSelect value={role} onChange={setRole} disabled={disabled} /><small>{roleAccess[role]}</small></label></div>
      : <p>{action.mode === 'remove' ? 'Unconsumed review authority and attempt grants will be revoked. Previously admitted publication remains recorded.' : 'Existing tokens issued before this change will no longer authorize this project. The member must obtain a newly issued session.'}</p>}
    {action.member.role === 'owner' && <p>At least one active verified human owner must remain.</p>}
    <div className="button-row"><button className="button primary" disabled={disabled} onClick={() => submit(role)}><Icon name={action.mode === 'remove' ? 'x' : action.mode === 'sessions' ? 'lock' : 'check'} size={16} />{title}</button><button className="button" disabled={disabled} onClick={close}>Cancel</button></div>
  </section>;
}

function SecretDelivery({ origin, context }: { origin: string; context: CollaborationContext }) {
  const { delivery, deliveryContext } = useSyncExternalStore(collaborationCommands.subscribe, collaborationCommands.getSnapshot, collaborationCommands.getSnapshot);
  const [copied, setCopied] = useState('');
  if (!delivery || !deliveryContext || collaborationScope(context) !== collaborationScope(deliveryContext)) return null;
  const link = invitationLink(origin, delivery);
  return <section className="invitation-secret" aria-label="Invitation delivery"><h2>Invitation ready</h2><p>The link is shown only in this session. Share it privately with the intended recipient.</p><div className="secret-controls"><input aria-label="Invitation link" type="text" readOnly value={link} autoComplete="off" spellCheck={false} onFocus={event => event.currentTarget.select()} /><button className="icon-button" title="Copy invitation link" aria-label="Copy invitation link" onClick={() => { void navigator.clipboard.writeText(link).then(() => setCopied('Copied'), () => setCopied('Copy unavailable. Select the link to copy it.')); }}><Icon name={copied === 'Copied' ? 'check' : 'copy'} /></button><button className="button" onClick={() => collaborationCommands.clearDelivery()}>Dismiss link</button></div><span className="small" role="status">{copied}</span></section>;
}

export function Collaboration({ projectId, local, readOnly = false, intake, accepting = false, clearIntake, onAccepted, onChanged }: {
  projectId?: string; local: boolean; readOnly?: boolean; intake?: InvitationIntake; accepting?: boolean; clearIntake(): void; onAccepted(): void; onChanged(): void;
}) {
  const [view, setView] = useState<CollaborationView>();
  const [session, setSession] = useState<CollaborationSession>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('members');
  const [showInvite, setShowInvite] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [role, setRole] = useState<CollaborationRole>('viewer');
  const [hours, setHours] = useState('24');
  const [editor, setEditor] = useState<MemberAction>();
  const [notice, setNotice] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [inspection, setInspection] = useState<InvitationInspection>();
  const [inspectionError, setInspectionError] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [acknowledgedMigration, setAcknowledgedMigration] = useState('');
  const command = useSyncExternalStore(collaborationCommands.subscribe, collaborationCommands.getSnapshot, collaborationCommands.getSnapshot);
  const busy = Boolean(command.pending || preparing || loading || readOnly);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (local) { setLoading(false); return; }
    const issued = ++sequence.current;
    setLoading(true);
    try {
      const currentSession = await request<CollaborationSession>('/api/session');
      if (issued !== sequence.current) return;
      setView(previous => previous?.session.principalId === currentSession.principalId ? previous : undefined);
      const retained = collaborationCommands.getSnapshot();
      if (retained.deliveryContext && retained.deliveryContext.session.principalId !== currentSession.principalId) collaborationCommands.clearDelivery();
      setSession(currentSession);
      if (!accepting) {
        if (!projectId) throw new Error('Select a project to manage access.');
        const next = await request<CollaborationView>(projectApiPath(projectId, '/api/collaboration'));
        if (issued !== sequence.current) return;
        if (next.scope.projectId !== projectId || next.session.principalId !== currentSession.principalId || next.scope.tenantId !== currentSession.tenantId) throw new ApiError('The project access response belongs to another session or project.', 404, 'PROJECT_UNAVAILABLE');
        setView(next);
      }
      setError('');
    } catch (failure) {
      if (issued !== sequence.current) return;
      setView(undefined);
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) setSession(undefined);
      setError(failure instanceof ApiError && failure.status === 404 ? 'Collaboration is unavailable to this session.' : failure instanceof Error ? failure.message : 'Collaboration could not be read.');
    } finally { if (issued === sequence.current) setLoading(false); }
  }, [projectId, local, accepting]);
  useEffect(() => {
    setView(undefined); setLoading(true); setEditor(undefined); setError('');
    const stop = startVisiblePolling(document, window, () => { void refresh(); });
    return () => { ++sequence.current; stop(); };
  }, [refresh]);
  useEffect(() => {
    let current = true;
    setInspection(undefined); setInspectionError(''); setInspecting(false);
    const secret = intake?.secret;
    if (!accepting || !secret || !session || session.credentialClass !== 'human' || session.tenantId !== secret.scope.tenantId) return;
    const inspectionCommand = freezeCollaborationCommand({ scope: secret.scope, session, revision: '0' }, 'accept-invitation', { invitationId: secret.invitationId, token: secret.token });
    setInspecting(true);
    void request<InvitationInspection>(projectApiPath(secret.scope.projectId, '/api/collaboration/inspect-invitation'), { method: 'POST', headers: inspectionCommand.headers, body: inspectionCommand.body }).then(preview => {
      if (!current) return;
      if (!matchingInvitationInspection(secret, session, preview)) throw new Error('Invitation scope changed.');
      setInspection(preview);
    }).catch(() => { if (current) setInspectionError('This invitation is unavailable to your current session. It may have expired or been revoked.'); })
      .finally(() => { if (current) setInspecting(false); });
    return () => { current = false; };
  }, [accepting, intake?.secret, session?.principalId, session?.tenantId, session?.credentialClass, session?.authentication?.issuedAt]);
  const context: CollaborationContext | undefined = accepting ? intake?.secret && session ? { scope: intake.secret.scope, session, revision: '0' } : undefined : view;
  const confirmedInspection = intake?.secret && session && inspection && matchingInvitationInspection(intake.secret, session, inspection) ? inspection : undefined;
  const retryable = command.pending?.status === 'UNKNOWN' && context && collaborationScope(context) === collaborationScope(command.pending.context) && !error && !loading && !readOnly;

  async function change(operation: Parameters<typeof collaborationCommands.begin>[1], body: Record<string, unknown>, delivery?: Parameters<typeof collaborationCommands.begin>[3]) {
    if (!context || error || busy) return;
    setNotice(''); setError('');
    try {
      const confirmed = await collaborationCommands.begin(context, operation, body, delivery);
      if (confirmed) {
        setEditor(undefined); setShowInvite(false); setNotice('Change confirmed.');
        if (operation === 'accept-invitation') { clearIntake(); onAccepted(); }
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The change was not confirmed.'); }
    finally { void refresh(); onChanged(); }
  }
  async function invite(event: FormEvent) {
    event.preventDefault();
    if (!view || busy || !recipient.trim()) return;
    setPreparing(true); setError('');
    try {
      const { secret, tokenDigest } = await createInvitationSecret(view.scope);
      await change('create-invitation', { invitationId: secret.invitationId, recipientId: recipient.trim(), role, tokenDigest, expiresAt: Math.floor(Date.now() / 1000) + Number(hours) * 3600 }, secret);
    } catch { setError('The invitation could not be prepared. No link was created.'); }
    finally { setPreparing(false); }
  }
  async function retry() {
    if (!context || !retryable) return;
    const operation = command.pending?.operation;
    try {
      if (await collaborationCommands.retry(context)) {
        setEditor(undefined); setShowInvite(false); setNotice('Change confirmed.');
        if (operation === 'accept-invitation') { clearIntake(); onAccepted(); }
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The retry was not confirmed.'); }
    finally { void refresh(); onChanged(); }
  }

  return <section className={`collaboration ${accepting ? 'invitation-acceptance' : ''}`} aria-label={accepting ? 'Accept project invitation' : 'Project collaboration'}>
    <header className="collaboration-header"><div><h1>{accepting ? 'Join a project' : 'Project access'}</h1><p>{accepting ? 'Accept an invitation with your verified human identity.' : 'Verified people, explicit roles and recorded access changes.'}</p></div><button className="icon-button" title="Refresh collaboration" aria-label="Refresh collaboration" disabled={loading || preparing} onClick={() => void refresh()}><Icon name="refresh" /></button></header>
    {local ? <div className="collaboration-empty"><Icon name="lock" size={28} /><h2>Collaboration unavailable</h2><p>This local development adapter has a single pilot identity.</p></div> : <>
      {error && <Failure message={error} />}
      {command.pending && <div className={`notice ${command.pending.status === 'REJECTED' ? 'danger' : 'warning'}`} role="status"><Icon name="time" /><div><strong>{command.pending.status === 'UNKNOWN' ? 'Request outcome unconfirmed' : command.pending.status === 'REJECTED' ? 'Request rejected' : 'Waiting for confirmation'}</strong><p>{command.pending.detail || 'The authority is processing this request.'}</p>{command.pending.status === 'UNKNOWN' && <p>Keep this page open to recover the original request.</p>}{command.pending.detail === 'recent session required' && <p>Obtain a new sign-in session, then refresh before trying again.</p>}</div>{command.pending.status === 'UNKNOWN' && <button className="button" disabled={!retryable} onClick={() => void retry()}>Retry same request</button>}{command.pending.status === 'REJECTED' && <button className="button" onClick={() => { collaborationCommands.dismissRejection(); void refresh(); }}>Dismiss</button>}</div>}
      {notice && <div className="notice neutral" role="status"><Icon name="check" /><p>{notice}</p></div>}
      {accepting ? <>
        {intake?.error && <Failure message={intake.error} />}
        {session && <Identity label="Signed-in identity" value={session.principalId} />}
        {loading ? <p role="status">Checking your session...</p> : !intake?.secret ? <div className="collaboration-empty"><Icon name="lock" size={28} /><h2>No invitation loaded</h2><p>Open the private invitation link sent by a project owner.</p></div> : <>
          {inspecting && <p role="status">Checking invitation details...</p>}
          {inspectionError && <Failure message={inspectionError} />}
          {confirmedInspection && <dl><div><dt>Project</dt><dd>{confirmedInspection.scope.projectId}</dd></div><div><dt>Tenant</dt><dd>{confirmedInspection.scope.tenantId}</dd></div><div><dt>Proposed role</dt><dd><strong>{roleLabels[confirmedInspection.invitation.role]}</strong><p className="small muted">{roleAccess[confirmedInspection.invitation.role]}</p></dd></div><div><dt>Invited by</dt><dd><code>{confirmedInspection.invitation.inviter}</code></dd></div><div><dt>Expires</dt><dd>{formatTime(confirmedInspection.invitation.expiresAt)}</dd></div></dl>}
          {session && session.credentialClass !== 'human' && <Failure message="A verified human session is required to accept this invitation." />}
          {session && session.tenantId !== intake.secret.scope.tenantId && <Failure message="This invitation belongs to a different tenant." />}
          {confirmedInspection?.invitation.role === 'owner' && <p className="small muted">Accepting gives you ownership of this project. Existing owners keep their access.</p>}
          <div className="button-row"><button className="button primary" disabled={busy || Boolean(error) || !context || !confirmedInspection || session?.credentialClass !== 'human' || session?.tenantId !== intake.secret.scope.tenantId} onClick={() => void change('accept-invitation', { invitationId: intake.secret!.invitationId, token: intake.secret!.token })}><Icon name="check" size={16} />{confirmedInspection?.invitation.role === 'owner' ? 'Accept ownership' : 'Accept invitation'}</button><button className="button" disabled={Boolean(command.pending)} onClick={clearIntake}>Discard invitation</button></div>
        </>}
      </> : loading && !view ? <p role="status">Reading project access...</p> : view && <>
        <div className="collaboration-context"><Identity key={view.session.principalId} label="Signed-in identity" value={view.session.principalId} /><Badge status={view.canManage ? 'active' : 'neutral'}>{view.canManage ? 'Owner access' : 'Member access'}</Badge><span>Revision {view.revision}</span></div>
        {!view.enabled ? <CollaborationMigration view={view} disabled={busy || Boolean(error)} acknowledged={acknowledgedMigration === migrationReviewKey(view)} acknowledge={value => setAcknowledgedMigration(value ? migrationReviewKey(view) : '')} enable={() => void change('enable-collaboration', {})} /> : <>
          <div className="collaboration-tabs" role="tablist" aria-label="Collaboration views">{(['members', 'invitations', 'audit'] as const).map(item => <button key={item} id={`collaboration-tab-${item}`} role="tab" aria-selected={tab === item} aria-controls={`collaboration-panel-${item}`} onClick={() => setTab(item)}>{item === 'members' ? 'Members' : item === 'invitations' ? 'Invitations' : 'Audit log'}<span>{item === 'members' ? view.members.filter(member => member.active).length : item === 'invitations' ? view.invitations.filter(invite => invite.state === 'PENDING').length : view.audit.length}</span></button>)}</div>
          <SecretDelivery origin={window.location.origin} context={view} />
          <div id={`collaboration-panel-${tab}`} role="tabpanel" aria-labelledby={`collaboration-tab-${tab}`}>
            {tab !== 'audit' && <div className="collaboration-toolbar"><div><h2>{tab === 'members' ? 'People with project access' : 'Project invitations'}</h2><p>{tab === 'members' ? `${view.members.filter(member => member.active).length} active members` : 'Invitations grant access only after the intended recipient accepts.'}</p></div>{view.canManage && <button className="button primary" disabled={busy} onClick={() => { setShowInvite(!showInvite); setEditor(undefined); }}><Icon name="arrow" size={16} />Invite a person</button>}</div>}
            {showInvite && view.canManage && tab !== 'audit' && <form className="collaboration-form" onSubmit={event => void invite(event)}><h2>{role === 'owner' ? 'Invite a new owner' : 'Invite a collaborator'}</h2><div className="collaboration-fields"><label className="collaboration-field">Verified principal ID<input aria-label="Verified principal ID" required maxLength={160} value={recipient} onChange={event => setRecipient(event.target.value)} placeholder="https://issuer.example#subject" autoComplete="off" spellCheck={false} disabled={busy} /><small>Exact issuer and subject of the intended human recipient.</small></label><label className="collaboration-field">Role<RoleSelect value={role} onChange={setRole} allowOwner disabled={busy} /><small>{roleAccess[role]}</small></label><label className="collaboration-field">Expires in<select value={hours} onChange={event => setHours(event.target.value)} disabled={busy}><option value="1">1 hour</option><option value="24">24 hours</option><option value="72">3 days</option><option value="168">7 days</option></select></label></div>{role === 'owner' && <p className="small muted">The recipient must accept ownership. Your ownership remains active until you change your own role.</p>}<div className="button-row"><button className="button primary" type="submit" disabled={busy || !recipient.trim()}><Icon name="arrow" size={16} />Create invitation</button><button className="button" type="button" disabled={busy} onClick={() => setShowInvite(false)}>Cancel</button></div></form>}
            {editor && view.canManage && tab === 'members' && (editor.mode === 'review'
              ? <ReviewPermissionEditor member={editor.member} disabled={busy} close={() => setEditor(undefined)} submit={body => void change('set-collaborator-review', body)} />
              : <MemberEditor key={`${editor.member.subject}-${editor.mode}`} action={editor} disabled={busy} close={() => setEditor(undefined)} submit={nextRole => void change(editor.mode === 'sessions' ? 'revoke-member-sessions' : 'update-collaborator', editor.mode === 'sessions' ? { subject: editor.member.subject } : { subject: editor.member.subject, role: editor.mode === 'remove' ? editor.member.role : nextRole, active: editor.mode !== 'remove' })} />)}
            {tab === 'members' ? <CollaborationMembers view={view} disabled={busy || Boolean(error)} edit={setEditor} reinvite={member => { setRecipient(member.subject); setRole(member.role); setShowInvite(true); setEditor(undefined); }} /> : tab === 'invitations' ? view.invitations.length ? <table className="collaboration-list"><thead><tr><th className="member-identity" scope="col">Recipient</th><th scope="col">Role</th><th scope="col">Status</th><th className="member-actions" scope="col">Actions</th></tr></thead><tbody>{view.invitations.map(invite => <tr key={invite.id}><td className="member-identity"><strong><code>{invite.recipientId}</code></strong><small>Invited by {invite.inviter}</small></td><td className="member-role">{roleLabels[invite.role]}</td><td className="member-state"><Badge status={invite.state} /><small>Expires {formatTime(invite.expiresAt)}</small></td><td className="member-actions">{view.canManage && invite.state === 'PENDING' && <button className="icon-button" title="Revoke invitation" aria-label={`Revoke invitation for ${invite.recipientId}`} disabled={busy} onClick={() => void change('revoke-invitation', { invitationId: invite.id })}><Icon name="x" size={16} /></button>}</td></tr>)}</tbody></table> : <div className="collaboration-empty"><h2>No invitations</h2><p>Pending and completed invitations appear here.</p></div> : <><div className="collaboration-toolbar"><div><h2>Access history</h2><p>Latest {view.audit.length} recorded changes</p></div></div><ol className="collaboration-audit">{view.audit.map(entry => <li key={entry.id}><Icon name="activity" size={18} /><div><strong>{entry.kind.replaceAll('_', ' ').replaceAll('-', ' ')}</strong><p>Actor: <code>{entry.actor}</code></p><p>Target: <code>{entry.target}</code></p><details><summary>Recorded details</summary><pre>{JSON.stringify(entry.details, null, 2)}</pre></details></div><time dateTime={new Date(entry.at * 1000).toISOString()}>{formatTime(entry.at)}</time></li>)}</ol>{!view.audit.length && <p className="collaboration-empty">No access changes recorded.</p>}</>}
          </div>
        </>}
      </>}
    </>}
  </section>;
}
