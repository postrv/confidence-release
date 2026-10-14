import { useEffect, useState } from 'react';
import type { PlatformState, Candidate, Conflict, Attempt, AgentMode } from '../../../services/types';
import { Badge, Identity, Empty, PublicationGateNotice, short } from './components';
import { Icon } from './icons';
import { currentConflict, currentFinalChecksDecision, currentReleasePlan, finalChecksRetryDecision, formatReservationUnits, interactionMismatch, observationExpected, publishedCandidate, recordedCandidateFailure, releaseGoalsPassed, releaseJobOutcome, repairBudgetIncrease, repairOrigin, repairReservationDecision, stoppedWithoutSubmission } from './presentation';
import { isWeftSelection, ReleaseStory } from './ReleaseStory';
import { AttemptSource } from './AttemptSource';
import { LiveWorkspace } from './LiveWorkspace';
import { commandScope } from './commands';
import { publishedRecord } from './published-record';

export type RunCommand = (label: string, path: string, body: Record<string, unknown>) => Promise<boolean>;
interface Props { state: PlatformState; busy: string; command: RunCommand; openReview: () => void; selected: string[]; setSelected: (ids: string[]) => void; }
const individualSource = (state: PlatformState, attempt: Attempt): Candidate | undefined => attempt.submissionId
  ? state.candidates.find(candidate => candidate.attemptIds.length === 1 && candidate.attemptIds[0] === attempt.id && candidate.submissionIds?.includes(attempt.submissionId!))
  : undefined;
const inspectionKey = (state: PlatformState, attempt: Attempt): string => JSON.stringify([state.tenantId, state.projectId, state.projectIncarnation, attempt.id, attempt.submissionId]);

export function Workspace({ state, busy, command, openReview, selected, setSelected }: Props) {
  const scriptedAvailable = state.capabilities.scripted && !state.capabilities.deployment;
  const [preferredMode, setMode] = useState<AgentMode>(() => scriptedAvailable ? 'scripted' : 'pi');
  const [inspectedSource, setInspectedSource] = useState('');
  const [weftConnectionScope, setWeftConnectionScope] = useState('');
  const scope = commandScope(state);
  const weftConnected = weftConnectionScope === scope;
  // Derive the active mode each render so a capability change cannot leave a stale launch enabled.
  const mode: AgentMode = preferredMode === 'scripted' && scriptedAvailable ? 'scripted' : preferredMode === 'pi' && state.capabilities.pi ? 'pi' : scriptedAvailable ? 'scripted' : 'pi';
  const canLaunch = mode === 'scripted' ? scriptedAvailable : state.capabilities.pi;
  const candidate = state.candidates.find(c => c.id === state.activeCandidateId);
  const weftSelection = isWeftSelection(candidate);
  const weftWorkflow = weftConnected || weftSelection;
  const repairedSource = repairOrigin(state, candidate);
  const submittedSelected = selected.filter(id => state.attempts.some(attempt => attempt.id === id && Boolean(attempt.submissionId)));
  const conflict = currentConflict(state, submittedSelected);
  const repair = state.attempts.find(attempt => attempt.id === conflict?.repairAttemptId);
  const hasCohort = state.attempts.length > 0;
  const running = state.attempts.some(attempt => ['running', 'starting', 'provisioning', 'infrastructure_unknown', 'reserved', 'stop_requested', 'unknown', 'ingestion_pending'].includes(attempt.status.toLowerCase())) || state.conflicts.some(item => item.status === 'REPAIRING') || state.candidates.some(item => item.status === 'EVALUATING') || ['running', 'starting', 'evaluating'].includes(state.demoStatus.toLowerCase());
  const activePublication = state.publications.find(p => !['finalized', 'published', 'aborted'].includes(p.status.toLowerCase()));
  const finalPass = releaseGoalsPassed(state, candidate);
  const receiptRecorded = publishedCandidate(state, candidate?.id);
  const recorded = publishedRecord(state, candidate);
  const repairSubmissionRetained = Boolean(candidate && state.attempts.some(attempt => attempt.role === 'repair' && candidate.attemptIds.includes(attempt.id) && attempt.submissionId));
  const failedComposition = recordedCandidateFailure(state, candidate);
  const contradictoryPass = candidate?.outcome === 'PASS' && failedComposition;
  const failedRepair = Boolean(repairedSource && failedComposition);
  const interactionEvidenceFirst = Boolean(failedComposition && conflict?.category === 'behavioural-interaction' && conflict.candidateId === candidate?.id);
  const attempts = state.attempts.filter(attempt => attempt.role !== 'repair');
  const inspectedAttempt = attempts.find(attempt => inspectedSource === inspectionKey(state, attempt));
  const inspectedCandidate = inspectedAttempt && individualSource(state, inspectedAttempt);
  useEffect(() => { if (inspectedCandidate) document.getElementById('attempt-source-inspection')?.focus(); }, [inspectedSource]);
  const submittedCount = attempts.filter(attempt => Boolean(attempt.submissionId)).length;
  const stopped = attempts.filter(stoppedWithoutSubmission);
  const awaitingSource = attempts.filter(attempt => !attempt.submissionId && !stoppedWithoutSubmission(attempt));
  const explorationComplete = attempts.length > 0 && attempts.every(attempt => Boolean(attempt.submissionId));
  const composeActive = !failedComposition && !finalPass && Boolean((explorationComplete && !candidate) || (candidate && !candidate.outcome) || (candidate?.outcome === 'PASS' && !repairedSource));
  const repairComplete = Boolean(repairedSource && repairSubmissionRetained && finalPass);
  const repairActive = Boolean(conflict && !finalPass && !failedRepair);
  const repairStopped = Boolean(repair && stoppedWithoutSubmission(repair));
  const repairIngestionPending = Boolean(repair?.terminationObserved && !repair.submissionId && !repairStopped);
  const repairDescription = repairComplete ? 'Original goals passed after repair'
    : failedRepair ? contradictoryPass ? 'Retained failure blocks successor' : 'Successor failed checks'
    : repairStopped ? 'Stopped without accepted source'
    : repairIngestionPending ? 'Stopped; source ingestion pending'
    : repair?.submissionId ? 'Accepted source; successor pending'
    : repair ? 'Bounded attempt running'
    : conflict ? 'Ready for bounded repair' : 'Keep the useful contributions';
  const repairStatus = repairStopped ? 'stopped without accepted source'
    : repairIngestionPending ? 'stopped; source ingestion pending'
    : repair?.submissionId ? 'awaiting successor checks'
    : repair ? 'in progress'
    : conflict ? 'ready to start' : undefined;
  const repairCapacity = repairReservationDecision(state);
  const budgetIncrease = repairBudgetIncrease(state);
  const scriptedAttemptLimit = Number.isSafeInteger(state.goal.budget.maxAttempts) && (state.goal.budget.maxAttempts ?? 0) > 0 ? state.goal.budget.maxAttempts : undefined;
  const headline = receiptRecorded ? 'Publication recorded.'
    : finalPass ? repairedSource ? 'Final checks passed after repair.' : 'Final checks passed.'
    : failedRepair ? contradictoryPass ? 'Repair still has a recorded failure.' : 'Repair checks failed.'
    : conflict?.category === 'behavioural-interaction' ? 'Interaction found.'
    : candidate?.outcome === 'FAIL' ? 'Combined checks failed.'
    : conflict ? 'Composition needs a decision.'
    : candidate ? 'Checking as one.' : hasCohort ? 'Contributions in flight.' : 'Ready to begin.';

  if (recorded && candidate) return <>
    <section className="goal-heading goal-heading-active"><div><div className="eyebrow"><span className="goal-dot" /> Retained publication</div><h1>Publication recorded.</h1><p className="goal-description">{state.goal.title}</p></div></section>
    <LiveWorkspace readOnly state={state} busy={busy} command={command} openReview={openReview} onConnectionChange={connected => setWeftConnectionScope(connected ? scope : '')} />
    <ReleaseStory state={state} candidate={candidate} />
    <section className="panel"><div className="section-heading"><div><div className="section-kicker">Recorded source and receipt</div><h2>Inspect the published release.</h2></div><button className="button primary" onClick={openReview}><Icon name="shield" />Open recorded release</button></div><p>Inspect the exact source, export receipt #{recorded.receipt.sequence}, and verify the retained decision independently. Current checker eligibility is shown separately above.</p></section>
    {activePublication && <div className="notice warning" role="status"><Icon name="time" /><div><strong>A separate publication operation needs attention</strong><p>Operation {short(activePublication.id)} remains {activePublication.status.toLowerCase()}. Its outcome does not change this recorded receipt.</p></div></div>}
    {state.capabilities.deployment && <section className="notice neutral reservation-notice" aria-label="Future authoring capacity"><Icon name="activity" /><div><strong>Future authoring capacity · {state.projectBudget ? `${formatReservationUnits(state.projectBudget.availableUnits)} available` : 'unavailable'}</strong><p>Internal admission units apply to new work. No additional budget is needed to inspect or verify this recorded release. These units are not provider dollars or measured model cost.</p><details className="reservation-details"><summary>Budget details</summary><p>{state.projectBudget ? `Limit ${formatReservationUnits(state.projectBudget.maximumUnits)} · Policy cap ${formatReservationUnits(state.projectBudget.policyCapUnits)} · Held ${formatReservationUnits(state.projectBudget.reservedUnits)} · Settled ${formatReservationUnits(state.projectBudget.settledUnits)}.` : 'Authoritative reservation totals are not present in this snapshot.'}</p></details></div></section>}
    {state.attempts.length > 0 && <details className="panel"><summary>Recorded contribution and repair history · {state.attempts.length} attempts</summary><p>These are retained project attempts. Inclusion in this release is recorded separately for each attempt.</p><div className="attempt-grid">{state.attempts.map(attempt => <article className="attempt-card" key={attempt.id}><div className="attempt-card-top"><strong>{attempt.name}</strong><Badge status={attempt.status} /></div><p className="small muted">{candidate.attemptIds.includes(attempt.id) ? 'Included in this candidate’s contribution lineage' : 'Other retained project attempt'}</p><AttemptRows attempt={attempt} /><AttemptPaths attempt={attempt} /></article>)}</div></details>}
    <div className="workspace-footer"><span><Icon name="lock" size={14} /> Accepted head <code>{short(state.acceptedHead)}</code></span><span>The receipt records a historical publication observation.</span></div>
  </>;

  if (receiptRecorded) return <section className="panel"><h1>Receipt details unavailable for this source.</h1><p role="status">Refresh a complete matching view of this project, source and publication before inspecting the recorded release.</p></section>;

  return <>
    <section className={`goal-heading ${hasCohort ? 'goal-heading-active' : ''}`}>
      <div><div className="eyebrow"><span className="goal-dot" /> Goal {state.goal.id === 'goal' ? '' : short(state.goal.id, 6)}<span className="revision">Revision {short(state.goal.revision, 8)}</span></div><h1>{hasCohort ? <span>{headline}</span> : <>Better together.<br /><span>{headline}</span></>}</h1><p className="goal-description">{state.goal.title}</p></div>
      <div className="goal-summary"><span className="section-kicker">The release must preserve</span><div className="goal-obligation"><Icon name="refresh" /><span>Fresh values after every acknowledged write</span></div><div className="goal-obligation"><Icon name="spark" /><span>Useful caching on unchanged reads</span></div><div className="goal-obligation"><Icon name="check" /><span>An accessible, current saved-value status</span></div></div>
    </section>

    <LiveWorkspace state={state} busy={busy} command={command} openReview={openReview} onConnectionChange={connected => setWeftConnectionScope(connected ? scope : '')} />

    {!weftWorkflow && <div className={`journey ${hasCohort ? 'journey-active' : ''}`} role="group" aria-label="Release journey">
      <JourneyStep number="01" name="Explore" description="Three bounded attempts" done={explorationComplete} active={!explorationComplete && !candidate} />
      <span className="journey-line" />
      <JourneyStep number="02" name="Compose" description={contradictoryPass && !repairedSource ? 'Retained failure blocks this source' : failedComposition ? 'Integrated checks failed' : 'Check the whole selection'} done={finalPass} issue={failedComposition} active={composeActive} />
      <span className="journey-line" />
      <JourneyStep number="03" name="Repair" description={repairDescription} done={repairComplete} issue={failedRepair || repairStopped && !repairComplete} active={repairActive} statusLabel={repairComplete || failedRepair ? undefined : repairStatus} />
      <span className="journey-line" />
      <JourneyStep number="04" name="Release" description="Review, publish and record receipt" done={receiptRecorded} active={Boolean(finalPass && !receiptRecorded)} />
    </div>}

    {state.capabilities.deployment && <section className={`notice reservation-notice ${hasCohort ? 'reservation-compact' : ''} ${repairCapacity.allowed ? 'neutral' : 'warning'}`} aria-label="Project reservation capacity"><Icon name="activity" /><div><strong>Internal project reservation · {state.projectBudget ? `${formatReservationUnits(state.projectBudget.availableUnits)} available` : 'unavailable'}</strong>{hasCohort ? <p>{state.projectBudget ? `A new repair reserves ${formatReservationUnits(state.projectBudget.repairReservationUnits)} admission units.` : 'Authoritative reservation totals are unavailable.'}</p> : <p>{state.projectBudget ? `Limit ${formatReservationUnits(state.projectBudget.maximumUnits)} · Policy cap ${formatReservationUnits(state.projectBudget.policyCapUnits)} · Held ${formatReservationUnits(state.projectBudget.reservedUnits)} · Settled ${formatReservationUnits(state.projectBudget.settledUnits)} · One new repair reserves ${formatReservationUnits(state.projectBudget.repairReservationUnits)} units.` : 'Authoritative reservation totals are not present in this snapshot.'} These are admission units, not provider dollars or measured model cost.</p>}{hasCohort && conflict && !running && budgetIncrease && <button className="button small-button budget-increase" disabled={Boolean(busy)} onClick={() => void command('Record one-repair budget increase', '/api/increase-budget', { reason: 'One additional bounded repair for the recorded interaction, retaining all original goals.' })}>Increase internal limit by {formatReservationUnits(budgetIncrease.increaseUnits)}</button>}</div>{hasCohort && <details className="reservation-details"><summary>Budget details</summary><p>{state.projectBudget ? `Limit ${formatReservationUnits(state.projectBudget.maximumUnits)} · Policy cap ${formatReservationUnits(state.projectBudget.policyCapUnits)} · Held ${formatReservationUnits(state.projectBudget.reservedUnits)} · Settled ${formatReservationUnits(state.projectBudget.settledUnits)}.` : 'Authoritative reservation totals are not present in this snapshot.'} Admission units are not provider dollars or measured model cost.</p></details>}</section>}

    {(hasCohort || weftSelection) && <ReleaseStory state={state} candidate={candidate} />}
    {interactionEvidenceFirst && conflict && <ConflictView conflict={conflict} state={state} busy={busy} command={command} />}

    {stopped.length > 0 && <div className="notice warning" role="status"><Icon name="error" /><div><strong>{stopped.length} {stopped.length === 1 ? 'attempt stopped' : 'attempts stopped'} without accepted source</strong><p>{awaitingSource.length ? `${awaitingSource.length} ${awaitingSource.length === 1 ? 'attempt is' : 'attempts are'} still awaiting source. ` : ''}Individual checks cannot run for stopped attempts, and a full three-way comparison needs their contributions. Inspect retained private diagnostics to establish the cause before creating fresh attempts.</p></div></div>}

    {activePublication && <div className="notice warning"><Icon name="time" /><div><strong>Publication confirmation pending</strong><p>{activePublication.recoveryReason || `Operation ${short(activePublication.id)} has not reached a confirmed terminal state.`} The next publication stays blocked while this effect is reconciled.</p></div><button className="button small-button" disabled={Boolean(busy)} onClick={() => void command('Reconcile publication', '/api/reconcile', { publicationId: activePublication.id })}>Check the recorded effect</button></div>}

    {!hasCohort && !weftWorkflow && <section className="launch-panel"><div className="launch-art" aria-hidden="true"><svg viewBox="0 0 260 124"><defs><linearGradient id="flow" x1="0" y1="0" x2="1" y2="0"><stop stopColor="var(--accent)" /><stop offset="1" stopColor="var(--accent-bright)" /></linearGradient></defs><path d="M0 18h72c36 0 34 44 70 44h96M0 62h238M0 106h72c36 0 34-44 70-44" stroke="url(#flow)" strokeWidth="2" fill="none" /><circle cx="56" cy="18" r="9" fill="var(--sidebar-bg)" stroke="var(--accent)" /><circle cx="86" cy="62" r="9" fill="var(--sidebar-bg)" stroke="var(--accent)" /><circle cx="56" cy="106" r="9" fill="var(--sidebar-bg)" stroke="var(--accent)" /><circle cx="236" cy="62" r="18" fill="var(--accent-bright)" /><path d="m229 62 5 5 9-10" stroke="var(--ink)" strokeWidth="2" fill="none" /></svg></div><div><div className="section-kicker">Your first collaboration</div><h2>Launch a small, visible cohort.</h2><p>One agent enables caching. Another simplifies writes. A third improves the interface. Each gets its own workspace and bounded scope.</p><div className="launch-controls"><div className="mode-switch" aria-label="Agent execution mode"><button aria-pressed={mode === 'scripted'} className={mode === 'scripted' ? 'selected' : ''} disabled={!scriptedAvailable} title={scriptedAvailable ? undefined : 'Scripted execution is available only in the local demonstration runtime.'} onClick={() => setMode('scripted')}>Scripted demonstration</button><button aria-pressed={mode === 'pi'} className={mode === 'pi' ? 'selected' : ''} disabled={!state.capabilities.pi} title={state.capabilities.piReason} onClick={() => setMode('pi')}>Pi model mode</button></div><button className="button primary light" disabled={Boolean(busy) || !canLaunch} onClick={() => void command('Launch three attempts', '/api/demo', { mode, autoSelect: false })}><Icon name="play" size={16} />{busy === 'Launch three attempts' ? 'Starting…' : 'Launch 3 agents'}</button></div><p className="launch-footnote">{!canLaunch ? (state.capabilities.piReason || 'No execution mode is available in this runtime.') : mode === 'scripted' ? 'Real Git workspaces and HTTP checks; agent edits follow a deterministic script.' : 'Pi mode uses the configured model; observed execution appears on each attempt.'} {state.capabilities.deployment ? `Each authoring grant lasts up to ${state.goal.budget.authoringSeconds}s; fresh attempts require remaining project budget.` : `${scriptedAttemptLimit === undefined ? 'Attempt limit unavailable' : `${scriptedAttemptLimit} attempts maximum`} · ${state.goal.budget.authoringSeconds}s authoring budget`}</p></div></section>}

    {(hasCohort || !weftWorkflow) && <section className="attempts-section"><div className="section-heading"><div><div className="section-kicker">Parallel exploration</div><h2>Contributions, with their evidence.</h2></div><div className="section-heading-aside"><span className="budget-label">{state.capabilities.deployment ? `${state.attempts.length} attempts recorded` : scriptedAttemptLimit === undefined ? `${state.attempts.length} attempts recorded` : `${state.attempts.length} / ${scriptedAttemptLimit} attempts`}</span>{!state.capabilities.deployment && scriptedAttemptLimit !== undefined && <div className="budget-track" aria-label={`${state.attempts.length} of ${scriptedAttemptLimit} attempt slots used`}><span style={{ width: `${Math.min(100, state.attempts.length / scriptedAttemptLimit * 100)}%` }} /></div>}</div></div>{attempts.length ? <div className="attempt-grid">{attempts.map(attempt => <AttemptCard key={attempt.id} attempt={attempt} state={state} selected={submittedSelected.includes(attempt.id)} onSelect={() => setSelected(submittedSelected.includes(attempt.id) ? submittedSelected.filter(id => id !== attempt.id) : [...submittedSelected, attempt.id])} sourceOpen={inspectedSource === inspectionKey(state, attempt)} onInspectSource={() => setInspectedSource(inspectedSource === inspectionKey(state, attempt) ? '' : inspectionKey(state, attempt))} disabled={running || Boolean(busy)} />)}</div> : <div className="attempt-grid skeleton-grid">{[{ role: 'A', title: 'Enable useful caching', file: 'cache.mjs' }, { role: 'B', title: 'Simplify the write path', file: 'mutation.mjs' }, { role: 'C', title: 'Show the saved value', file: 'presentation.mjs' }].map(attempt => <div className="attempt-placeholder" key={attempt.role}><span className="attempt-avatar">{attempt.role}</span><h3>{attempt.title}</h3><p>Isolated workspace · bounded grant</p><code>{attempt.file}</code><span className="placeholder-state">Ready to launch</span></div>)}</div>}
      {inspectedAttempt && inspectedCandidate && <AttemptSource attempt={inspectedAttempt} candidate={inspectedCandidate} state={state} onClose={() => { setInspectedSource(''); requestAnimationFrame(() => document.getElementById(`inspect-source-${inspectedAttempt.id}`)?.focus()); }} />}
      {hasCohort && <div className="selection-bar"><div><Icon name="layers" /><div><strong>{submittedSelected.length} accepted {submittedSelected.length === 1 ? 'contribution' : 'contributions'} selected</strong><p>{candidate ? `Current composition: ${candidate.name}` : submittedCount === 0 ? `0 of ${attempts.length} attempts have accepted source. Waiting for submissions before composition.` : `${submittedCount} of ${attempts.length} attempts have accepted source. Individual checks do not establish combined behaviour.`}</p></div></div><button className="button primary" disabled={Boolean(busy) || running || submittedSelected.length === 0} onClick={() => void command('Compose and evaluate selection', '/api/select', { attemptIds: submittedSelected })}><Icon name="layers" size={16} />{busy === 'Compose and evaluate selection' ? 'Evaluating…' : 'Compose & evaluate'}<Icon name="arrow" size={16} /></button></div>}
    </section>}

    {conflict && !interactionEvidenceFirst && <ConflictView conflict={conflict} state={state} busy={busy} command={command} />}
    {candidate && <CandidatePanel candidate={candidate} repairedSource={repairedSource} state={state} finalPass={Boolean(finalPass)} busy={busy} openReview={openReview} command={command} />}
    <div className="workspace-footer"><span><Icon name="lock" size={14} /> Accepted head <code>{short(state.acceptedHead)}</code></span><span>Only the publication protocol can change this head.</span></div>
  </>;
}

function JourneyStep({ number, name, description, done, active, issue = false, statusLabel }: { number: string; name: string; description: string; done: boolean; active: boolean; issue?: boolean; statusLabel?: string }) {
  return <div className={['journey-step', done && 'done', active && 'current', issue && 'issue'].filter(Boolean).join(' ')} aria-current={active ? 'step' : undefined} role="group" aria-label={`${name}: ${statusLabel || (issue ? 'checks failed' : done ? 'complete' : active ? 'in progress' : 'pending')}`}><span className="journey-number">{issue ? <Icon name="error" size={15} /> : done ? <Icon name="check" size={15} /> : number}</span><div><strong>{name}</strong><span>{description}</span></div></div>;
}

function AttemptCard({ attempt, state, selected, onSelect, sourceOpen, onInspectSource, disabled }: { attempt: Attempt; state: PlatformState; selected: boolean; onSelect: () => void; sourceOpen: boolean; onInspectSource: () => void; disabled: boolean }) {
  const individual = individualSource(state, attempt);
  const evidence = state.evidence.filter(e => e.candidateId === individual?.id);
  const contract = evidence.find(e => e.outcome === 'FAIL') || evidence.at(-1);
  const stopped = stoppedWithoutSubmission(attempt);
  return <article className={`attempt-card ${selected ? 'is-selected' : ''}`}><div className="attempt-card-top"><div className={`attempt-avatar role-${attempt.role.toLowerCase()}`}>{attempt.role}</div><Badge status={attempt.status} /></div><h3>{attempt.name}</h3><AttemptRows attempt={attempt} /><AttemptPaths attempt={attempt} /><div className="individual-result">{contract ? <><Icon name={contract.outcome === 'PASS' ? 'check' : 'error'} size={15} /><span>Freshness · individual candidate</span><Badge status={contract.outcome} /></> : stopped ? <><Icon name="error" size={15} /><span>Individual check unavailable · no source</span></> : <><Icon name="time" size={15} /><span>Individual check pending</span></>}</div>{individual && <button id={`inspect-source-${attempt.id}`} className="button attempt-source-button" aria-expanded={sourceOpen} onClick={onInspectSource}>{sourceOpen ? 'Hide accepted source' : 'Inspect accepted source'}</button>}{attempt.submissionId && !individual && <p className="attempt-source-pending">Individual source snapshot pending.</p>}<label className="attempt-selection"><input type="checkbox" checked={selected} disabled={disabled || !attempt.submissionId} onChange={onSelect} /><span>{attempt.submissionId ? 'Include contribution' : stopped ? 'No accepted submission' : 'Awaiting immutable submission'}</span><code>{short(attempt.commit, 7)}</code></label>{stopped ? <div className="attempt-failure"><strong>{attempt.executionOutcome === 'BUDGET_EXHAUSTED' ? 'Reserved budget exhausted' : 'Model/provider cause unconfirmed'}</strong><p>{attempt.error} A new bounded attempt and grant are required to retry in this project, subject to remaining budget. This generation cannot resume.</p></div> : attempt.error && <p className="attempt-error">{attempt.error}</p>}<AttemptCapture attempt={attempt} state={state} /></article>;
}

function AttemptPaths({ attempt }: { attempt: Attempt }) {
  const changed = !attempt.submissionId ? 'No accepted source; changed files unavailable.'
    : !attempt.changedPaths ? 'Changed files were not reported for this accepted source.'
    : attempt.changedPaths.length === 0 ? 'No changed files recorded for this accepted source.' : '';
  return <div className="attempt-paths"><div className="attempt-path-group"><strong>Allowed to edit</strong><div className="attempt-files">{attempt.allowedPaths.length ? attempt.allowedPaths.map(path => <code key={path}>{path}</code>) : <span>Scope unavailable</span>}</div></div><div className="attempt-path-group"><strong>Recorded changes</strong>{changed ? <p>{changed}</p> : <div className="attempt-files">{attempt.changedPaths!.map(path => <code key={path}>{path}</code>)}</div>}</div></div>;
}

function AttemptRows({ attempt, observed, showAssignment = true }: { attempt: Attempt; observed?: string; showAssignment?: boolean }) {
  return <div className="intent-rows">{showAssignment && <div><span>Assigned</span><p>{attempt.assigned}</p></div>}<div><span>Agent intends</span><p>{attempt.intent || 'Intent not reported'}</p></div><div><span>Observed</span><p>{observed || attempt.observed || (attempt.submissionId ? 'Immutable source submitted; behavioural evidence belongs to its candidate.' : 'No completed observation yet.')}</p></div></div>;
}

function repairTask(assignment: string): string {
  try {
    const parsed: unknown = JSON.parse(assignment);
    if (parsed && typeof parsed === 'object' && 'task' in parsed && typeof parsed.task === 'string' && parsed.task.trim() && parsed.task.length <= 1024) return parsed.task;
  } catch { /* Local scripted assignments are plain text. */ }
  return assignment.length <= 240 ? assignment : 'Restore fresh reads after acknowledged writes in the failed composition.';
}

function RepairBrief({ attempt, conflict, state, evaluation }: { attempt: Attempt; conflict: Conflict; state: PlatformState; evaluation?: PlatformState['evaluations'][number] }) {
  const mismatch = interactionMismatch(state, conflict);
  const source = state.candidates.find(candidate => candidate.id === conflict.candidateId);
  const contributions = source?.attemptIds.map(id => state.attempts.find(item => item.id === id)?.role).filter((role): role is Attempt['role'] => Boolean(role)).join(' + ');
  const exactCandidate = state.candidates.find(candidate => candidate.id === conflict.repairCandidateId && candidate.attemptIds.includes(attempt.id));
  const retainedGoalsPassed = releaseGoalsPassed(state, exactCandidate);
  const capacity = repairReservationDecision(state);
  const decision = !attempt.submissionId
    ? stoppedWithoutSubmission(attempt) ? `No repair source to review. ${capacity.allowed ? 'A fresh bounded attempt is required.' : capacity.reason}` : 'Wait for accepted source before evaluating a repair.'
    : !exactCandidate || !evaluation?.outcome ? 'Wait for final checks on this exact repair candidate before review.'
    : evaluation.outcome === 'PASS' ? 'Inspect this exact candidate and its evidence before approval.' : 'Final checks did not pass. Repair the failed goals before review.';
  return <section className="repair-brief" aria-label="Repair decision summary">
    <div><span>Repair goal</span><p>{repairTask(attempt.assigned)}</p></div>
    {attempt.readOnlyContextPaths?.length ? <div><span>Source scope</span><p>May edit {attempt.allowedPaths.join(', ')}. Read-only source context: {attempt.readOnlyContextPaths.join(', ')}.</p></div> : null}
    <div><span>Failing witness</span><p>{mismatch ? `Recorded ${mismatch.action.toUpperCase()} expected ${mismatch.expected} but observed ${mismatch.observed}.` : 'The selected composition failed a recorded public check; inspect its evidence.'}</p></div>
    <div><span>Keep from the original work</span><p>{contributions ? `Selected contributions ${contributions} form the failed source. ` : ''}{retainedGoalsPassed ? 'This repair candidate passed the registered useful caching and accessible saved-value status checks.' : 'Useful caching and accessible saved-value status still require proof in the repair.'}</p></div>
    <div><span>Next decision</span><p>{decision}</p></div>
    <details className="repair-raw-assignment"><summary>Exact agent assignment</summary><pre className="bounded-log">{attempt.assigned}</pre></details>
  </section>;
}

function AttemptCapture({ attempt, state }: { attempt: Attempt; state: PlatformState }) {
  const capsule = state.capsules.filter(item => item.attemptId === attempt.id && item.generation === attempt.generation).at(-1);
  return <details className="attempt-details"><summary>Source, scope & execution<Icon name="chevron" size={13} /></summary><Identity label="Attempt" value={attempt.id} /><Identity label="Work base" value={attempt.workBase} /><Identity label="Grant" value={attempt.grantId} />{capsule && <Identity label="Context record" value={capsule.digest} />}<p className="small muted">Generation {attempt.generation} · {attempt.mode === 'pi' ? 'Pi mode' : 'Scripted agent'} · {attempt.terminationObserved ? 'Termination observed' : 'Termination not yet observed'}{capsule ? ` · ${capsule.missingTail ? 'Session tail unavailable' : 'Session context retained'}` : ''}</p>{attempt.log && <pre className="bounded-log">{attempt.log.slice(-10000)}</pre>}{attempt.outputTruncated && <p className="small muted">Output capture was truncated.</p>}</details>;
}

function ConflictView({ conflict, state, busy, command }: { conflict: Conflict; state: PlatformState; busy: string; command: RunCommand }) {
  const failure = state.evidence.find(e => conflict.evidenceIds.includes(e.id) && e.outcome === 'FAIL');
  const repairSuccessor = Boolean(state.candidates.find(candidate => candidate.id === conflict.candidateId)?.repairOf);
  const overlapping = failure?.jobId.endsWith(':overlapping-read-write');
  const trace = conflict.counterexample?.length
    ? conflict.counterexample.slice(0, 8).map(observation => `${overlapping && observation.action === 'read' ? 'FRESH READ' : overlapping && observation.action === 'overlap-read' ? 'OVERLAPPING READ' : observation.action.toUpperCase()} → HTTP ${observation.status}; expected ${observationExpected(observation)}, observed ${observation.observed ?? '—'}`)
    : conflict.reproducer ?? [];
  const wrong = failure?.observations.find(o => o.expected !== undefined && o.observed !== o.expected);
  const repairAttempt = state.attempts.find(a => a.id === conflict.repairAttemptId);
  const retryRepair = Boolean(repairAttempt && stoppedWithoutSubmission(repairAttempt));
  const priorRepairs = state.attempts.filter(attempt => attempt.role === 'repair' && attempt.workBase === repairAttempt?.workBase && attempt.id !== repairAttempt?.id);
  const repairEvaluation = currentReleasePlan(state, state.candidates.find(candidate => candidate.id === conflict.repairCandidateId));
  const repairObserved = repairEvaluation?.outcome ? `Repair candidate retained-value goal ${repairEvaluation.outcome}. This result applies to its exact candidate.` : undefined;
  const repairCapacity = repairReservationDecision(state);
  return <section className="conflict-panel"><div className="conflict-heading"><div className="conflict-icon"><Icon name="error" size={24} /></div><div><div className="section-kicker">{repairSuccessor ? 'A repair failed a registered check.' : conflict.category === 'behavioural-interaction' ? 'A clean merge. A failed behaviour.' : 'Composition requires a decision'}</div><h2>{wrong ? `The write saved ${wrong.expected}. The ${overlapping ? 'fresh' : 'next'} read returned ${wrong.observed}.` : conflict.summary}</h2><p>{conflict.witness?.rows.length === 4 && conflict.witness.rows.slice(0, 3).every(row => row.outcome === 'PASS') && conflict.witness.rows[3]?.outcome === 'FAIL' ? 'The baseline and both individual changes passed this freshness probe. Their combination left a warmed cache stale.' : conflict.summary}</p></div><Badge status={conflict.status} /></div><div className="conflict-body"><div className="witness-area"><div className="section-kicker">{repairSuccessor ? 'Current repair evidence' : 'Controlled interaction witness'}</div>{conflict.witness ? <><div className="witness-table" role="table" aria-label="Baseline and contribution interaction results"><div className="witness-row witness-header" role="row"><span role="columnheader">Fresh fixture per run</span><span role="columnheader">Freshness contract</span><span role="columnheader">Evidence</span></div>{conflict.witness.rows.map(row => <div key={row.evidenceId} className={`witness-row ${row.outcome === 'FAIL' ? 'failed-row' : ''}`} role="row"><strong role="cell">{row.name}</strong><span role="cell"><Badge status={row.outcome} /></span><code role="cell" title={row.evidenceId}>{short(row.evidenceId.replace(/^evidence-/, ''), 9)}</code></div>)}</div><p className="small muted">{conflict.witness.scope}</p></> : <p className="muted">{repairSuccessor ? 'This successor has its own failing protected evidence. The earlier A+B witness remains with the original candidate.' : 'Four-way evidence is still being gathered. This composition\'s failure remains recorded.'}</p>}</div><div className="reproducer-area"><div className="section-kicker">{overlapping ? 'Overlapping read/write trace' : 'Recorded failure trace'}</div>{trace.length ? <ol className="reproducer">{trace.map((line, index) => <li key={`${index}-${line}`}><span>{index + 1}</span><code>{line}</code></li>)}</ol> : <p className="muted">No HTTP counterexample was recorded in this snapshot. Inspect the retained evidence and diagnostics.</p>}<div className="failure-explanation"><Icon name="git" size={18} /><p>{repairSuccessor ? 'This successor failed its own protected trace. Inspect its exact evidence before choosing another repair.' : 'The composition enables caching and removes write invalidation in different files. File independence does not imply behavioural independence.'}</p></div></div></div><div className="repair-action"><div><Icon name="spark" /><div><strong>{retryRepair ? 'The repair stopped without accepted source.' : repairAttempt ? 'Repair continues from the exact failed source.' : 'Preserve the gains. Repair the interaction.'}</strong><p>{retryRepair ? `Attempt ${short(repairAttempt?.id)} ended ${repairAttempt?.status.toLowerCase()}. The failed candidate and this attempt remain recorded; a fresh attempt starts from the same source.` : repairAttempt ? `Fresh attempt ${short(repairAttempt.id)} · ${repairAttempt.status} · inherited contribution lineage retained` : 'The next attempt inherits this candidate and its counterexample. Freshness, caching and the useful interface remain required.'}</p>{!repairCapacity.allowed && (retryRepair || !repairAttempt) && <p role="status">{repairCapacity.reason}</p>}</div></div>{retryRepair ? <button className="button dark" disabled={Boolean(busy) || !repairCapacity.allowed} onClick={() => void command('Retry bounded repair', '/api/repair', { conflictId: conflict.id })}><Icon name="refresh" size={16} />Retry bounded repair<Icon name="arrow" size={16} /></button> : repairAttempt ? <Badge status={repairAttempt.status} /> : <button className="button dark" disabled={Boolean(busy) || !repairCapacity.allowed} onClick={() => void command('Start repair', '/api/repair', { conflictId: conflict.id })}><Icon name="spark" size={16} />Start a bounded repair<Icon name="arrow" size={16} /></button>}</div>{repairAttempt && <div className="repair-diagnostics"><RepairBrief attempt={repairAttempt} conflict={conflict} state={state} evaluation={repairEvaluation} /><AttemptRows attempt={repairAttempt} observed={repairObserved} showAssignment={false} /><AttemptPaths attempt={repairAttempt} />{repairAttempt.error && <p className="attempt-error">{repairAttempt.error}</p>}<AttemptCapture attempt={repairAttempt} state={state} /></div>}{priorRepairs.length > 0 && <details className="repair-provenance"><summary>Previous repair attempts · {priorRepairs.length}</summary>{priorRepairs.map(previous => <div key={previous.id}><Identity label="Attempt" value={previous.id} /><Badge status={previous.status} /><p className="small muted">{previous.submissionId ? 'Immutable source submitted; inspect its candidate evidence separately.' : stoppedWithoutSubmission(previous) ? 'Stopped without accepted source.' : 'Source admission still pending.'}</p><AttemptPaths attempt={previous} /></div>)}</details>}{repairAttempt && <details className="repair-provenance"><summary>Inspect source & selected context provenance</summary><Identity label="Failed candidate" value={conflict.candidateId} /><Identity label="Repair work base" value={repairAttempt.workBase} /><Identity label="Publication base" value={repairAttempt.publicationBase} /><Identity label="Context capsule" value={repairAttempt.capsuleId} />{state.capsules.filter(c => c.attemptId === repairAttempt.id).map(capsule => <div key={capsule.id}><Identity label="Rendered context" value={capsule.renderedContextDigest} /><p className="small muted">{capsule.adapter} · selector {capsule.selectorVersion} · {capsule.missingTail ? 'Context capture missing its tail' : 'Selected context retained'}</p>{capsule.limitations.map(limit => <p className="small muted" key={limit}>{limit}</p>)}</div>)}</details>}</section>;
}

function CurrentFinalJobs({ state, candidate, busy, command }: { state: PlatformState; candidate: Candidate; busy: string; command: RunCommand }) {
  const plan = currentReleasePlan(state, candidate);
  if (!plan) {
    if (!state.capabilities.deployment) return null;
    const decision = currentFinalChecksDecision(state, candidate);
    return <section className="candidate-jobs" aria-labelledby="candidate-jobs-title">
      <div className="candidate-jobs-heading"><h3 id="candidate-jobs-title">Current final checks required</h3></div>
      <p id="current-final-checks-reason" className="small muted">{decision.reason}</p>
      <button className="button small-button" aria-describedby="current-final-checks-reason" disabled={!decision.allowed || Boolean(busy)} onClick={() => void command('Run current final checks', '/api/evaluate', { candidateId: candidate.id })}>Run current final checks</button>
    </section>;
  }
  const jobs = plan.jobs.filter(job => job.required);
  const passed = jobs.filter(job => releaseJobOutcome(state, plan, job) === 'PASS').length;
  const status = releaseGoalsPassed(state, candidate) ? 'PASS' : plan.outcome === 'FAIL' ? 'FAIL' : 'pending';
  const retry = finalChecksRetryDecision(state, candidate);
  const retryVisible = state.capabilities.deployment && !['PASS', 'FAIL'].includes(plan.outcome ?? '')
    && state.evaluations.some(item => item.candidateId === candidate.id && item.purpose !== 'diagnostic' && ['ERROR', 'INCONCLUSIVE'].includes(item.outcome ?? ''));
  return <section className="candidate-jobs" aria-labelledby="candidate-jobs-title">
    <div className="candidate-jobs-heading"><div><div className="section-kicker">Current registered plan</div><h3 id="candidate-jobs-title">Required final jobs</h3></div><Badge status={status}>{passed} of {jobs.length} registered jobs passed</Badge></div>
    <p className="small muted">These outcomes belong to this candidate and plan <code title={plan.planDigest}>{short(plan.planDigest)}</code>.</p>
    {jobs.length ? <ul className="candidate-job-list">{jobs.map(job => <li key={job.id}><div><strong>{job.name}</strong><code title={job.id}>{short(job.id, 20)}</code></div><Badge status={releaseJobOutcome(state, plan, job) || 'pending'} /></li>)}</ul> : <p className="small muted">No required jobs are registered on the current plan.</p>}
    {retryVisible && <div className="notice warning"><Icon name="refresh" /><div><strong>{plan.status === 'SETTLED' ? 'Final checks need a conclusive result' : 'Final checks are in progress'}</strong><p id="final-check-retry-reason">{retry.reason}</p><button className="button small-button" aria-describedby="final-check-retry-reason" disabled={!retry.allowed || Boolean(busy)} onClick={() => void command('Run final checks again', '/api/evaluate', { candidateId: candidate.id })}>Run final checks again</button></div></div>}
  </section>;
}

function CandidatePanel({ candidate, repairedSource, state, finalPass, busy, openReview, command }: { candidate: Candidate; repairedSource?: Candidate; state: PlatformState; finalPass: boolean; busy: string; openReview: () => void; command: RunCommand }) {
  const finalPlan = currentReleasePlan(state, candidate);
  const evaluations = state.evaluations.filter(e => e.purpose !== 'diagnostic' && e.candidateId === candidate.id && (e.contract !== 'retained-value-v1' || e.id === finalPlan?.id));
  const repair = Boolean(repairedSource);
  const receipt = state.receipts.find(r => r.candidateId === candidate.id);
  const status = finalPass ? 'PASS' : candidate.outcome === 'PASS' ? 'PENDING' : candidate.outcome || candidate.status;
  return <section className="candidate-panel panel"><div className="section-heading"><div><div className="section-kicker">{repair ? finalPass ? 'Value-preserving successor' : candidate.outcome === 'FAIL' ? 'Repair successor · failed checks' : 'Repair successor · awaiting proof' : 'Prospective release'}</div><h2>{candidate.name}</h2></div><Badge status={status}>{finalPass ? 'Named contracts passed' : candidate.outcome === 'PASS' ? 'Final-goal checks required' : status}</Badge></div><div className="candidate-content"><div><p className="muted">{repair ? finalPass ? 'This exact successor passed the registered checks for fresh writes, useful caching and accessible saved-value status. Its publication parent is the accepted base recorded for this candidate.' : candidate.outcome === 'FAIL' ? `This successor starts from failed candidate ${short(repairedSource?.id)} and failed a registered check. Inspect its exact evidence before another repair; the original goals still apply.` : `This successor starts from failed candidate ${short(repairedSource?.id)}. Fresh writes, useful caching and accessible saved-value status still require final checks. Its publication parent is the accepted base recorded for this candidate.` : 'This immutable snapshot contains the selected contributions. Its integrated behaviour has its own evidence.'}</p><div className="contract-list">{evaluations.length ? evaluations.map(evaluation => <div className="contract-row" key={evaluation.id}><Icon name={evaluation.outcome === 'PASS' ? 'check' : evaluation.outcome === 'FAIL' ? 'error' : 'time'} size={17} /><div><strong>{evaluation.contract === 'freshness-v1' ? 'Write visibility' : 'Retained useful value'}</strong><span>{evaluation.contract === 'freshness-v1' ? 'Warm cache → write → fresh read' : 'Cache benefit + accessible saved-value status'}</span></div><Badge status={evaluation.outcome || evaluation.status} /></div>) : <Empty title="Integrated checks pending">The release needs applicable evidence for this exact candidate.</Empty>}</div></div><div className="candidate-identities"><Identity label="Exact commit" value={candidate.commit} /><Identity label="Source manifest" value={candidate.manifestDigest} /><Identity label="Publication base" value={candidate.publicationBase} /><Identity label="Candidate" value={candidate.digest} /></div></div><CurrentFinalJobs state={state} candidate={candidate} busy={busy} command={command} />{finalPass && !receipt && <PublicationGateNotice state={state} />}<div className="candidate-footer"><span><Icon name="shield" size={15} />{receipt ? 'Published outcome recorded in a portable receipt' : finalPass ? 'Eligible for exact human review' : 'Full final-goal evidence is required before review'}</span>{receipt ? <Badge status="published">Publication confirmed</Badge> : <button className="button primary" disabled={!finalPass || Boolean(busy)} onClick={() => { void command('Prepare exact review', '/api/review', { candidateId: candidate.id }).then(confirmed => { if (confirmed) openReview(); }); }}>Review this release<Icon name="arrow" size={16} /></button>}</div></section>;
}
