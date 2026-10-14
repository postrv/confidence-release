import { useEffect, useLayoutEffect, useState } from 'react';
import type { ProjectCheck, ProjectDirectoryResponse, ProjectMetadataCommand, ProjectSummary } from '../../../packages/project-model/src/types';
import { Icon } from './icons';
import { canManageProject, projectSourceLabel } from './project-directory';
import type { View } from './navigation';
import type { createUnsavedChanges } from './unsaved-changes';
import { ImportedSourceBrowser } from './ImportedSourceBrowser';

export type ManageProject = (project: ProjectSummary | undefined, label: string, operation: 'create' | Exclude<ProjectMetadataCommand['operation'], 'import'>, body: Record<string, unknown>) => Promise<ProjectSummary | false>;

function ChangedTime({ value }: { value: string }) {
  const parsed = new Date(value);
  return <time dateTime={value}>{Number.isNaN(parsed.getTime()) ? 'Update time unavailable' : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>;
}

interface ProjectsProps { directory: ProjectDirectoryResponse; disabled: boolean; manage: ManageProject; open: (project: ProjectSummary, view?: View) => void; collaborationOnly?: boolean }

export function Projects(props: ProjectsProps) {
  return props.collaborationOnly ? <CollaborationProjects {...props} /> : <RepositoryProjects {...props} />;
}

function CollaborationProjects({ directory, disabled, manage, open }: ProjectsProps) {
  const [creating, setCreating] = useState(false), [name, setName] = useState(''), [description, setDescription] = useState('');
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (disabled || !directory.canCreate || !name.trim()) return;
    if (await manage(undefined, 'Create project', 'create', { name: name.trim(), description: description.trim() })) { setCreating(false); setName(''); setDescription(''); }
  }
  return <><div className="project-hub-heading"><div className="page-heading"><div className="eyebrow">Private collaboration</div><h1>Projects</h1><p>Create a project for shared discussion, collaborators and their scoped agent connections.</p></div><button className="button primary" disabled={disabled || !directory.canCreate} onClick={() => setCreating(!creating)}>New project</button></div>
    <p className="small muted">This deployment supports collaboration and the pinned Weft dependency. Managed execution, release evaluation and publication are not available here.</p>
    {creating && <form className="panel project-form" onSubmit={event => void create(event)}><h2>Create a project</h2><label>Project name<input autoFocus required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label><label>Description (optional)<textarea rows={3} maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} /></label><p>Enable verified ownership in Project access, then share the Discussion link. No source import is required.</p><div className="button-row"><button className="button primary" disabled={disabled || !name.trim()}>Create project</button><button type="button" className="button" onClick={() => setCreating(false)}>Cancel</button></div></form>}
    {directory.projects.length ? <div className="project-grid">{directory.projects.map(project => <article className="project-card" key={project.projectId}><div className="project-card-top"><span className="project-status">{project.status === 'ARCHIVED' ? 'Archived' : 'Private collaboration'}</span><button className="icon-button" aria-label={`Settings for ${project.name}`} onClick={() => open(project, 'settings')}><Icon name="settings" /></button></div><h2><button onClick={() => open(project, 'discussion')}>{project.name}</button></h2><p>{project.description || 'Shared project discussion'}</p><div className="button-row"><button className="button" onClick={() => open(project, 'discussion')}>Open discussion</button><button className="button" onClick={() => open(project, 'collaboration')}>Project access</button></div></article>)}</div> : <section className="project-empty"><Icon name="layers" size={32} /><h2>{directory.canCreate ? 'No projects yet' : 'No project access yet'}</h2><p>{directory.canCreate ? 'Create a project to start a shared discussion, or open a project link from a collaborator.' : 'Open a project link from a collaborator to request access using your own sign-in.'}</p>{directory.canCreate && <button className="button primary" disabled={disabled} onClick={() => setCreating(true)}>Create your first project</button>}</section>}
  </>;
}

function RepositoryProjects({ directory, disabled, manage, open }: ProjectsProps) {
  const [search, setSearch] = useState(''), [filter, setFilter] = useState<'ACTIVE' | 'ARCHIVED'>('ACTIVE');
  const [creating, setCreating] = useState(false), [name, setName] = useState(''), [description, setDescription] = useState('');
  const visible = directory.projects.filter(project => project.status === filter && `${project.name} ${project.description} ${project.projectId}`.toLowerCase().includes(search.toLowerCase()))
    .sort((left, right) => Number(right.projectId === directory.defaultProjectId) - Number(left.projectId === directory.defaultProjectId));
  const active = directory.projects.filter(project => project.status === 'ACTIVE');
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (disabled || !directory.canCreate || !name.trim()) return;
    if (await manage(undefined, 'Create project', 'create', { name: name.trim(), description: description.trim() })) {
      setCreating(false); setName(''); setDescription(''); setFilter('ACTIVE');
    }
  }
  return <>
    <div className="project-hub-heading"><div className="page-heading"><div className="eyebrow"><span className="goal-dot" /> Private workspaces</div><h1>Projects</h1><p>{active.length} active {active.length === 1 ? 'project' : 'projects'}</p></div><button className="button primary" disabled={disabled || !directory.canCreate} onClick={() => setCreating(!creating)} aria-expanded={creating}><Icon name="layers" />New project</button></div>
    {!directory.canCreate && <p className="small muted directory-permissions">You can open the projects shared with your account. Project creation is unavailable for this account.</p>}
    {creating && <form className="panel project-form new-project-form" onSubmit={event => void create(event)} aria-labelledby="new-project-title"><div className="section-heading"><div><div className="section-kicker">A fresh workspace</div><h2 id="new-project-title">Create a project</h2></div><button type="button" className="icon-button" aria-label="Close new project" onClick={() => setCreating(false)}><Icon name="x" /></button></div><label>Project name<input autoFocus required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="For example, Customer portal" /></label><label>Description <span className="muted">(optional)</span><textarea rows={3} maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} placeholder="What are you building?" /></label><p className="small muted">You’ll start with an empty workspace. Import a committed repository next, then review the suggested checks.</p><div className="button-row"><button className="button primary" disabled={disabled || !name.trim()}>Create project</button><button type="button" className="button" onClick={() => setCreating(false)}>Cancel</button></div></form>}
    <div className="project-directory-toolbar"><div className="project-filter" aria-label="Project status"><button aria-pressed={filter === 'ACTIVE'} onClick={() => setFilter('ACTIVE')}>Active <span>{active.length}</span></button><button aria-pressed={filter === 'ARCHIVED'} onClick={() => setFilter('ARCHIVED')}>Archived <span>{directory.projects.length - active.length}</span></button></div><label className="project-search"><Icon name="search" size={17} /><span className="visually-hidden">Find a project</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a project…" /></label></div>
    {visible.length ? <div className="project-grid">{visible.map(project => <article className={`project-card ${project.status === 'ARCHIVED' ? 'archived' : ''}`} key={project.projectId}><div className="project-card-top"><span className="project-card-icon"><Icon name={project.source.status === 'EMPTY' ? 'layers' : 'git'} size={22} /></span><span className="project-status">{project.status === 'ARCHIVED' ? 'Archived' : projectSourceLabel(project)}</span><button className="icon-button" aria-label={`Settings for ${project.name}`} title="Project settings" onClick={() => open(project, 'settings')}><Icon name="settings" size={17} /></button></div><h2><button onClick={() => open(project)}>{project.name}</button></h2><p className="project-card-description">{project.description || 'No description'}</p><dl className="project-card-details"><div><dt>Source</dt><dd>{project.source.status === 'EMPTY' ? 'Not imported yet' : <code>{project.source.head.slice(0, 12)}</code>}</dd></div><div><dt>Checks</dt><dd>{project.capabilities.nativeWorkflow ? 'Protected release checks' : project.checks.length ? `${project.checks.filter(check => check.enabled).length} configured` : 'Not configured'}</dd></div></dl><div className="project-card-footer"><span>{project.projectId === directory.defaultProjectId ? 'Default project' : <>Updated <ChangedTime value={project.updatedAt} /></>}</span><button className="text-button" onClick={() => open(project)}>{projectActionLabel(project)}<Icon name="arrow" size={15} /></button></div></article>)}</div> : <section className="project-empty"><Icon name={search ? 'search' : 'layers'} size={32} /><h2>{search ? 'No matching projects' : filter === 'ARCHIVED' ? 'No archived projects' : directory.canCreate ? 'No projects yet' : 'No project access yet'}</h2><p>{search ? 'Try another name or clear your search.' : filter === 'ARCHIVED' ? 'No archived projects in this account.' : directory.canCreate ? 'Your first project starts with a committed repository.' : 'An invitation from a project owner is required.'}</p>{search && <button className="button" onClick={() => setSearch('')}><Icon name="x" size={15} />Clear search</button>}{!search && filter === 'ACTIVE' && directory.canCreate && <button className="button primary" disabled={disabled} onClick={() => setCreating(true)}><Icon name="layers" />Create your first project</button>}</section>}
    <div className="project-directory-note"><Icon name="lock" size={15} /><p>Only projects available to your account are listed. Each project keeps its own source and settings.</p></div>
  </>;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function projectActionLabel(project: ProjectSummary): string {
  if (project.status === 'ARCHIVED') return 'Inspect project';
  if (project.capabilities.nativeWorkflow) return 'Open release workflow';
  if (project.source.status === 'IMPORTED') return 'Browse source';
  return canManageProject(project) ? 'Import source' : 'Open project';
}

export function importCommand(projectId: string, origin: string, repositoryPath = './my-repo'): string {
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  return `confidence project import ${quote(repositoryPath)}${local ? ' --local' : ''} --target ${quote(origin)} --project ${quote(projectId)} --confirm`;
}

export function repositoryCommands(projectId: string, origin: string, repositoryPath: string) {
  const path = repositoryPath.trim();
  if (!path || path.length > 1024 || /[\u0000-\u001f\u007f]/.test(path)) return null;
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  const positionalPath = path.startsWith('-') ? `./${path}` : path;
  return { inspect: `confidence repo inspect ${quote(positionalPath)} --json`,
    signIn: local ? null : `confidence auth login --target ${quote(origin)}`,
    import: importCommand(projectId, origin, positionalPath) };
}

function ImportCommand({ label, command, disabled }: { label: string; command: string; disabled: boolean }) {
  const [copied, setCopied] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  async function copy() {
    if (disabled || copied === 'copying') return;
    setCopied('copying');
    try { await navigator.clipboard.writeText(command); setCopied('copied'); }
    catch { setCopied('failed'); }
  }
  return <div className="import-command-row"><div className="import-command-heading"><strong>{label}</strong>
    <button type="button" className="icon-button" disabled={disabled || copied === 'copying'} title={`Copy ${label.toLowerCase()} command`}
      aria-label={`Copy ${label.toLowerCase()} command`} onClick={() => void copy()}><Icon name={copied === 'copied' ? 'check' : 'copy'} size={16} /></button></div>
    <pre><code>{command}</code></pre><span className="import-copy-feedback" role="status">{copied === 'copied' ? 'Copied.' : copied === 'failed' ? 'Copy unavailable. Select the command to copy it.' : copied === 'copying' ? 'Copying...' : ''}</span></div>;
}

export function ImportGuide({ project, origin, disabled = false }: { project: ProjectSummary; origin: string; disabled?: boolean }) {
  const [repositoryPath, setRepositoryPath] = useState('./my-repo');
  const commands = repositoryCommands(project.projectId, origin, repositoryPath);
  return <section className="import-guide" aria-labelledby="import-title"><div className="section-heading"><div><div className="section-kicker"><Icon name="terminal" size={16} /> Committed source</div><h2 id="import-title">Import a local repository</h2></div><span className="project-status">Rust CLI</span></div>
    <label className="repository-path">Repository path<input value={repositoryPath} onChange={event => setRepositoryPath(event.target.value)} maxLength={1024}
      placeholder="./my-repo" autoComplete="off" spellCheck={false} disabled={disabled} /></label>
    {commands ? <div className="import-commands"><ImportCommand key={commands.inspect} label="Inspect source" command={commands.inspect} disabled={disabled} />
      {commands.signIn && <ImportCommand key={commands.signIn} label="Sign in" command={commands.signIn} disabled={disabled} />}
      <ImportCommand key={commands.import} label="Import source" command={commands.import} disabled={disabled} /></div>
      : <p className="notice warning" role="status">Enter a repository path without control characters.</p>}
    <details className="import-installation"><summary>CLI installation</summary><pre><code>cargo install --locked --path crates/project-cli</code></pre></details>
    <details><summary>Import scope and recovery</summary><p>Committed HEAD and its tree are included. Uncommitted and ignored files, parent history, submodule repositories and Git LFS content are excluded.</p>
      <p>Saved checks are preserved. Detected checks initialize an empty configuration.</p><p>16 MiB archive, 4 MiB per file, 4,096 files. The original CLI journal recovers an unconfirmed import.</p></details></section>;
}

export function RepositoryWorkspace({ project, origin, openSettings, sessionScope = project.projectId, principalId, sourceAvailable = true }: { project: ProjectSummary; origin: string; openSettings: () => void; sessionScope?: string; principalId?: string; sourceAvailable?: boolean }) {
  const imported = project.source.status === 'IMPORTED' ? project.source : undefined;
  return <><div className="project-hub-heading"><div className="page-heading"><div className="eyebrow"><span className="goal-dot" /> Repository workspace</div><h1>{project.name}</h1><p>{project.description || (imported ? 'Committed source retained' : 'No source imported')}</p></div><button className="button" onClick={openSettings}><Icon name="settings" />Project settings</button></div><div className="repository-overview"><section className="panel"><div className="section-kicker"><Icon name="git" /> Source</div><h2>{imported ? 'Committed source imported' : 'No source imported'}</h2>{imported ? <><code className="source-head">{imported.head}</code><dl className="repository-metrics"><div><dt>Files</dt><dd>{imported.fileCount.toLocaleString()}</dd></div><div><dt>Source size</dt><dd>{(imported.sourceBytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB</dd></div><div><dt>Branch</dt><dd>{imported.branch || 'Detached HEAD'}</dd></div></dl><p className="small muted">Imported <ChangedTime value={imported.importedAt} />. This is a retained snapshot of committed source.</p>{imported.warnings.length > 0 && <details className="import-warnings"><summary>{imported.warnings.length} source {imported.warnings.length === 1 ? 'note' : 'notes'}</summary><ul>{imported.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}</> : <p>Committed HEAD has not been imported.</p>}</section><section className="panel"><div className="section-kicker"><Icon name="check" /> Check configuration</div><h2>{project.checks.length ? `${project.checks.filter(check => check.enabled).length} ${project.checks.filter(check => check.enabled).length === 1 ? 'check' : 'checks'} enabled` : 'No checks configured'}</h2><p>{project.checks.length ? 'These are saved definitions. They have not been executed by this workspace.' : 'No saved check definitions.'}</p>{project.checks.length > 0 && <ul className="configured-check-list">{project.checks.slice(0, 5).map(check => <li key={check.id}><span>{check.name}</span><span>{check.enabled ? 'Configured' : 'Disabled'}</span></li>)}{project.checks.length > 5 && <li>{project.checks.length - 5} more in settings</li>}</ul>}<button className="text-button" onClick={openSettings}>{canManageProject(project) ? 'Configure checks' : 'Inspect checks'}<Icon name="arrow" size={15} /></button></section></div><section className="notice neutral capability-note" role="status"><Icon name="server" /><div><strong>Repository capabilities</strong><p>{project.capabilities.reason}</p><p>Importing source and saving checks do not create passing evidence or authorize a publication.</p></div></section>{imported && <ImportedSourceBrowser project={project} sessionScope={sessionScope} principalId={principalId} available={sourceAvailable} />}{project.status === 'ACTIVE' && project.source.status === 'EMPTY' && canManageProject(project) && <ImportGuide project={project} origin={origin} disabled={!sourceAvailable} />}</>;
}

export function CheckConfiguration({ checks, setChecks, disabled }: { checks: ProjectCheck[]; setChecks: (checks: ProjectCheck[]) => void; disabled: boolean }) {
  const change = (id: string, patch: Partial<ProjectCheck>) => setChecks(checks.map(check => check.id === id ? { ...check, ...patch } : check));
  return <><div className="section-heading"><div><div className="section-kicker">Repository checks</div><h2>Commands you choose</h2></div><button type="button" className="button" disabled={disabled || checks.length >= 32} onClick={() => setChecks([...checks, { id: `check-${crypto.randomUUID().slice(0, 8)}`, name: 'New check', argv: [''], cwd: '.', timeoutSeconds: 120, required: true, enabled: true, source: 'manual', evidenceClass: 'repository-check' }])}>Add check</button></div><p className="muted">Review suggested commands before enabling them. Saving a definition does not execute it or mark it as passed.</p>{!checks.length && <div className="check-empty">No checks configured yet. Import a repository to get suggestions, or add a command.</div>}<div className="check-editor-list">{checks.map((check, index) => <fieldset key={check.id} className="check-editor" disabled={disabled}><legend>Check {index + 1} · {check.source === 'detected' ? 'Suggested from repository' : 'Custom command'}</legend><div className="check-editor-heading"><label>Check name<input required maxLength={120} value={check.name} onChange={event => change(check.id, { name: event.target.value })} /></label><button type="button" className="icon-button" title="Remove check" aria-label={`Remove ${check.name}`} onClick={() => setChecks(checks.filter(item => item.id !== check.id))}><Icon name="x" /></button></div><div className="check-fields"><label>Executable<input required value={check.argv[0] || ''} placeholder="npm" onChange={event => change(check.id, { argv: [event.target.value, ...check.argv.slice(1)] })} /></label><label>Working directory<input required value={check.cwd} placeholder="." onChange={event => change(check.id, { cwd: event.target.value })} /></label><label>Time limit (seconds)<input required type="number" min={1} max={900} value={check.timeoutSeconds} onChange={event => change(check.id, { timeoutSeconds: Number(event.target.value) })} /></label></div><label>Arguments <span className="muted">(one per line)</span><textarea rows={Math.max(2, Math.min(5, check.argv.length))} value={check.argv.slice(1).join('\n')} placeholder={'run\ntest'} onChange={event => change(check.id, { argv: [check.argv[0], ...(event.target.value ? event.target.value.split('\n') : [])] })} /></label><div className="check-flags"><label className="checkbox-line"><input type="checkbox" checked={check.enabled} onChange={event => change(check.id, { enabled: event.target.checked })} />Enabled</label><label className="checkbox-line"><input type="checkbox" checked={check.required} onChange={event => change(check.id, { required: event.target.checked })} />Required</label><span className="small muted">{check.id}</span></div></fieldset>)}</div></>;
}

export function PendingImport({ project, disabled, manage }: { project: ProjectSummary; disabled: boolean; manage: ManageProject }) {
  const [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false);
  if (!project.pendingImport || !canManageProject(project)) return null;
  async function cancel(event: React.FormEvent) {
    event.preventDefault();
    if (!project.pendingImport || !confirmed || !reason.trim()) return;
    await manage(project, 'Cancel pending import', 'cancel-import', { ...project.pendingImport, reason: reason.trim() });
  }
  return <form className="panel project-form import-recovery" onSubmit={event => void cancel(event)} aria-labelledby="pending-import-title"><div className="section-kicker"><Icon name="time" /> Import recovery</div><h2 id="pending-import-title">An import is awaiting confirmation</h2><p className="muted">Use the original CLI journal to recover the same import. If you intend to abandon it, cancel the recorded operation here before starting another import.</p><p className="small">Import command <code>{project.pendingImport.commandId}</code></p><label>Reason for cancellation<textarea required maxLength={512} rows={2} value={reason} disabled={disabled} onChange={event => setReason(event.target.value)} /></label><label className="checkbox-line"><input type="checkbox" checked={confirmed} disabled={disabled} onChange={event => setConfirmed(event.target.checked)} /><span>I want to stop this recorded import. Its original command cannot be resumed after cancellation.</span></label><button className="button danger-button" disabled={disabled || !confirmed || !reason.trim()}>Cancel this import</button></form>;
}

interface ProjectSettingsProps { project: ProjectSummary; disabled: boolean; manage: ManageProject; draftScope?: string; drafts?: ReturnType<typeof createUnsavedChanges>; collaborationOnly?: boolean }

export function ProjectSettings(props: ProjectSettingsProps) {
  return props.collaborationOnly ? <CollaborationProjectSettings {...props} /> : <RepositoryProjectSettings {...props} />;
}

function CollaborationProjectSettings({ project, disabled, manage, draftScope, drafts }: ProjectSettingsProps) {
  const [base, setBase] = useState(project), [name, setName] = useState(project.name), [description, setDescription] = useState(project.description);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const dirty = name !== base.name || description !== base.description, changed = project.revision !== base.revision;
  const canManage = canManageProject(project), readOnly = disabled || !canManage || project.status === 'ARCHIVED';
  useLayoutEffect(() => draftScope && drafts ? drafts.register(draftScope, dirty) : undefined, [draftScope, drafts, dirty]);
  function reload() { setBase(project); setName(project.name); setDescription(project.description); setConfirmArchive(false); }
  useEffect(() => { if (changed && !dirty) reload(); }, [project.revision, dirty]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (readOnly || changed || !dirty || !name.trim()) return;
    const result = await manage(base, 'Save project details', 'update', { name: name.trim(), description: description.trim() });
    if (result) { setBase(result); setName(result.name); setDescription(result.description); }
  }
  return <><div className="page-heading"><div className="eyebrow">Project settings</div><h1>{project.name}</h1><p>Manage this collaboration project's name and lifecycle. Membership is managed in Project access.</p></div>
    {!canManage && <p className="notice neutral">Only the project owner can change these settings.</p>}
    {changed && dirty && <div className="notice warning"><p>Project settings changed while you were editing. Your draft still uses the original revision.</p><button className="button" onClick={() => { if (window.confirm('Discard your unsaved project settings and load the saved settings?')) reload(); }}>Discard draft and reload</button></div>}
    <form className="panel project-form" onSubmit={event => void save(event)}><h2>Name and purpose</h2><label>Project name<input required maxLength={120} disabled={readOnly} value={name} onChange={event => setName(event.target.value)} /></label><label>Description<textarea rows={4} maxLength={2000} disabled={readOnly} value={description} onChange={event => setDescription(event.target.value)} /></label><button className="button primary" disabled={readOnly || changed || !dirty || !name.trim()}>Save project details</button></form>
    <section className="panel project-archive"><h2>{project.status === 'ARCHIVED' ? 'Restore this project' : 'Archive this project'}</h2><p>Archived projects retain their records and stop discussion and agent access until restored.</p>{project.status === 'ARCHIVED' ? <button className="button" disabled={disabled || !canManage} onClick={() => void manage(project, 'Restore project', 'restore', {})}>Restore project</button> : confirmArchive ? <><p>Archive <strong>{project.name}</strong>?</p><div className="button-row"><button className="button danger-button" disabled={disabled || !canManage || dirty} onClick={() => void manage(project, 'Archive project', 'archive', {}).then(result => { if (result) setConfirmArchive(false); })}>Confirm archive</button><button className="button" onClick={() => setConfirmArchive(false)}>Cancel</button></div></> : <button className="button" disabled={disabled || !canManage || dirty} onClick={() => setConfirmArchive(true)}>Archive project</button>}</section>
  </>;
}

function RepositoryProjectSettings({ project, disabled, manage, draftScope, drafts }: ProjectSettingsProps) {
  const [base, setBase] = useState(project), [name, setName] = useState(project.name), [description, setDescription] = useState(project.description);
  const [checks, setChecks] = useState(() => structuredClone(project.checks)), [confirmArchive, setConfirmArchive] = useState(false);
  const detailsDirty = name !== base.name || description !== base.description;
  const checksDirty = JSON.stringify(checks) !== JSON.stringify(base.checks);
  const dirty = detailsDirty || checksDirty;
  useLayoutEffect(() => draftScope && drafts ? drafts.register(draftScope, dirty) : undefined, [draftScope, drafts, dirty]);
  const changed = base.revision !== project.revision;
  const canEdit = canManageProject(project), readOnly = disabled || !canEdit || project.status === 'ARCHIVED';
  function reload() { setBase(project); setName(project.name); setDescription(project.description); setChecks(structuredClone(project.checks)); setConfirmArchive(false); }
  function discard() { if (window.confirm('Discard your unsaved project settings and check changes and load the saved settings?')) reload(); }
  useEffect(() => { if (changed && !detailsDirty && !checksDirty) reload(); }, [project.revision, detailsDirty, checksDirty]);
  async function saveDetails(event: React.FormEvent) {
    event.preventDefault();
    const result = await manage(base, 'Save project details', 'update', { name: name.trim(), description: description.trim() });
    if (result) { setBase(result); setName(result.name); setDescription(result.description); }
  }
  async function saveChecks(event: React.FormEvent) {
    event.preventDefault();
    const result = await manage(base, 'Save check configuration', 'checks', { checks });
    if (result) { setBase(result); setChecks(structuredClone(result.checks)); }
  }
  return <><div className="page-heading"><div className="eyebrow">Project settings</div><h1>Make this workspace yours.</h1><p>Manage {project.name} and the checks configured for its source.</p></div>{!canEdit && <div className="notice neutral"><Icon name="lock" /><p>Your account can inspect these settings. A project administrator can change them.</p></div>}{changed && (detailsDirty || checksDirty) && <div className="notice warning" role="status"><Icon name="refresh" /><div><strong>Project settings changed while you were editing.</strong><p>Your draft still uses its original revision. Reload the latest settings before saving.</p></div><button className="button" onClick={discard}>Discard draft and reload</button></div>}{dirty && <div className="notice neutral" role="status"><Icon name="settings" /><div><strong>You have unsaved changes.</strong><p>Save each edited section before leaving or archiving this project.</p></div><button className="button" onClick={discard}>Discard changes</button></div>}<PendingImport key={project.pendingImport?.commandId ?? 'none'} project={project} disabled={disabled} manage={manage} /><div className="project-settings-layout"><div><form className="panel project-form" onSubmit={event => void saveDetails(event)}><div className="section-kicker">Details</div><h2>Name and purpose</h2><label>Project name<input required maxLength={120} disabled={readOnly} value={name} onChange={event => setName(event.target.value)} /></label><label>Description<textarea rows={4} maxLength={2000} disabled={readOnly} value={description} onChange={event => setDescription(event.target.value)} /></label><button className="button primary" disabled={readOnly || changed || !detailsDirty || !name.trim()}>Save details</button></form><form className="panel project-form checks-form" onSubmit={event => void saveChecks(event)}><CheckConfiguration checks={checks} setChecks={setChecks} disabled={readOnly || project.capabilities.nativeWorkflow} />{project.capabilities.nativeWorkflow ? <p className="small muted">This enrolled workflow uses its protected release contract. Repository check definitions cannot replace those checks.</p> : <button className="button primary" disabled={readOnly || changed || !checksDirty}>Save check configuration</button>}</form></div><aside><section className="panel project-settings-summary"><div className="section-kicker">Project identity</div><h2>Private workspace</h2><dl><div><dt>Project ID</dt><dd><code>{project.projectId}</code></dd></div><div><dt>Status</dt><dd>{project.status === 'ACTIVE' ? 'Active' : 'Archived'}</dd></div><div><dt>Your roles</dt><dd>{project.roles.join(', ')}</dd></div><div><dt>Created</dt><dd><ChangedTime value={project.createdAt} /></dd></div></dl></section><section className="panel project-archive"><div className="section-kicker">Lifecycle</div><h2>{project.status === 'ARCHIVED' ? 'Restore this project' : 'Archive this project'}</h2><p>{project.status === 'ARCHIVED' ? 'Restore this workspace to make project changes available again.' : 'Archive projects you are no longer working on. Their source and settings are retained for inspection and can be restored.'}</p>{project.status === 'ARCHIVED' ? <button className="button" disabled={disabled || !canEdit} onClick={() => void manage(project, 'Restore project', 'restore', {})}><Icon name="refresh" />Restore project</button> : confirmArchive ? <><p className="archive-confirmation">Archive <strong>{project.name}</strong> now?</p><div className="button-row"><button className="button danger-button" disabled={disabled || !canEdit || dirty} onClick={() => void manage(project, 'Archive project', 'archive', {}).then(confirmed => { if (confirmed) setConfirmArchive(false); })}>Confirm archive</button><button className="button" onClick={() => setConfirmArchive(false)}>Cancel</button></div></> : <button className="button" disabled={disabled || !canEdit || dirty} onClick={() => setConfirmArchive(true)}><Icon name="pause" />Archive project</button>}</section></aside></div></>;
}
