import { useState } from 'react';
import type { Attempt, Candidate, PlatformState } from '../../../services/types';
import { Badge, short } from './components';
import { Icon } from './icons';
import { request } from './api';
import { modelCallSummary, type ModelCallSummary } from './model-call-roster';
import { publishedRecord } from './published-record';
import { PublishedReleaseStory } from './PublishedRecord';
import { currentReleasePlan, currentReview, interactionMismatch, recordedCandidateFailure, releaseConflict, releaseGoalCases, releaseGoalStatus, releaseGoalsPassed, releaseMetrics, repairReservationDecision, repairStage, stoppedWithoutSubmission } from './presentation';

function reviewNeedsRefresh(state: PlatformState, candidate: Candidate, review: NonNullable<ReturnType<typeof currentReview>>): boolean {
  const expiry = Date.parse(review.expiresAt);
  return review.expectedHead !== state.acceptedHead || review.observationRevision !== state.observationRevision
    || !Number.isFinite(expiry) || expiry < Date.now()
    || state.capabilities.deployment && review.planDigest !== currentReleasePlan(state, candidate)?.planDigest;
}

export function isWeftSelection(candidate?: Candidate): boolean {
  return candidate?.composition?.length === 1 && /^weft:[a-f0-9]{64}$/.test(candidate.composition[0]);
}

function decision(state: PlatformState, candidate?: Candidate): string {
  const individualChecksActive = state.candidates.some(item => item.attemptIds.length === 1 && item.status === 'EVALUATING');
  if (!candidate) return state.attempts.some(stoppedWithoutSubmission)
    ? 'Stopped attempts have no accepted source. Inspect private diagnostics, then create fresh bounded attempts before the full combination can be checked.'
    : state.attempts.some(attempt => attempt.role !== 'repair' && !attempt.submissionId)
      ? 'Wait for accepted source from the remaining attempts, then evaluate the selected contributions as one.'
      : (individualChecksActive || state.attempts.some(attempt => attempt.role !== 'repair') && ['running', 'starting', 'evaluating'].includes(state.demoStatus.toLowerCase()))
        ? 'Wait for the individual checks to settle, then evaluate the selected contributions together.'
        : 'Choose the accepted contributions, then evaluate their combined source.';
  if (state.receipts.some(receipt => receipt.candidateId === candidate.id)) return 'Publication is recorded. Export the receipt and verify it independently.';
  if (state.publications.some(publication => publication.candidateId === candidate.id)) return 'Publication has an unresolved or pending effect. Reconcile that exact operation.';
  const plan = currentReleasePlan(state, candidate);
  const failed = recordedCandidateFailure(state, candidate) || plan?.outcome === 'FAIL';
  if (isWeftSelection(candidate) && failed) return 'Inspect this frozen source and its failed checks. Make corrective edits in the live workspace, then select and submit a new retained revision. This candidate remains unchanged.';
  if (candidate.outcome === 'PASS' && state.evidence.some(item => item.candidateId === candidate.id && item.outcome === 'FAIL')) return 'A retained failure contradicts this candidate’s later pass. Repair from the failed source, then check the successor against the original goals.';
  // A proposal cannot supersede a retained failure on its exact source.
  const review = failed ? undefined : currentReview(state, candidate.id);
  if (review && reviewNeedsRefresh(state, candidate, review)) return currentReleasePlan(state, candidate)
    ? 'The review is stale or expired. Prepare a fresh proposal before approval.'
    : 'The review is stale and no current eligible full plan is recorded. Recheck the original goals before preparing a new proposal.';
  if (review && !releaseGoalsPassed(state, candidate)) return 'The current evidence does not prove every named release goal on this source. Recheck the missing cases before approval or publication.';
  if (review?.approval) return 'The exact proposal is approved. Publish the bound commit when the gate is open.';
  if (review) return 'Inspect the exact source and named evidence, then decide whether to approve.';
  if (!candidate.outcome || candidate.status === 'EVALUATING') return 'Wait for the integrated checks on this exact source before deciding whether repair is needed.';
  if (candidate.outcome === 'PASS' && !plan) return 'No current eligible full release plan is recorded for this source. Recheck the original goals before preparing review.';
  if (candidate.outcome === 'PASS' && !plan?.outcome) return 'Wait for the integrated checks on this exact source before deciding whether repair is needed.';
  if (candidate.outcome === 'PASS' && plan?.outcome === 'FAIL') return 'The current full release checks failed. Inspect the exact failure before another review or repair decision.';
  if (plan?.outcome === 'PASS' && releaseGoalCases.some(goal => releaseGoalStatus(state, plan, goal.cases) !== 'PASS')) return 'The current plan does not prove every original goal. Recheck the missing goal cases before preparing review.';
  if (failed || plan?.outcome !== 'PASS') {
    if (isWeftSelection(candidate)) return 'Release checks have not passed on this frozen source. Inspect the check results and obtain a current full evaluation before review.';
    const conflict = releaseConflict(state, candidate);
    if (conflict) {
      const successor = state.candidates.find(item => item.id === conflict.repairCandidateId);
      if (releaseGoalsPassed(state, successor)) return 'The repair successor passed. Select its exact source and evidence for review.';
      if (successor?.outcome === 'FAIL') {
        const capacity = repairReservationDecision(state);
        return `The repair successor failed its registered checks. Inspect the exact failure before another bounded repair.${!capacity.allowed && capacity.reason ? ` ${capacity.reason}` : ''}`;
      }
      if (successor) return 'The repair successor is being checked. Wait for its exact final-goal evidence before review.';
      const repair = state.attempts.find(attempt => attempt.id === conflict.repairAttemptId);
      if (conflict.candidateId === candidate.id && repair?.submissionId) return 'The repair submitted source. Wait for its exact successor and final-goal checks before review.';
      if (conflict.candidateId === candidate.id && repair?.terminationObserved && !repair.submissionId && !stoppedWithoutSubmission(repair)) return 'The repair stopped; source ingestion is pending. Wait for accepted source before checking its exact successor.';
      if (conflict.candidateId === candidate.id && repair && !stoppedWithoutSubmission(repair)) return 'A bounded repair is in progress. Wait for accepted source before checking the exact successor.';
      if (candidate.outcome === 'FAIL' && (candidate.repairOf || state.conflicts.some(item => item.repairCandidateId === candidate.id))) {
        const capacity = repairReservationDecision(state);
        return `This repair successor failed its registered checks. Inspect the exact failure before another bounded repair.${!capacity.allowed && capacity.reason ? ` ${capacity.reason}` : ''}`;
      }
      if (repair?.submissionId) return 'The repair submitted source. Wait for its exact successor and final-goal checks before review.';
      if (repair?.terminationObserved && !repair.submissionId && !stoppedWithoutSubmission(repair)) return 'The repair stopped; source ingestion is pending. Wait for accepted source before checking its exact successor.';
      if (repair && !stoppedWithoutSubmission(repair)) return 'A bounded repair is in progress. Wait for accepted source before checking the exact successor.';
      const capacity = repairReservationDecision(state);
      if (!capacity.allowed && capacity.reason) return `${capacity.reason} Then create a fresh bounded repair grant and check the repaired candidate against the original goals.`;
      return state.capabilities.deployment
        ? 'Start a fresh bounded repair grant, then check the exact successor against the original goals.'
        : 'Start a bounded repair, then check the exact successor against the original goals.';
    }
    return 'Combined checks failed. Inspect the exact evidence and wait for an interaction diagnosis before deciding on repair.';
  }
  return 'Prepare the exact review, then inspect the source and evidence.';
}

function contributionResult(state: PlatformState, attempt: Attempt): string {
  const individual = state.candidates.find(candidate => candidate.attemptIds.length === 1 && candidate.attemptIds[0] === attempt.id);
  const check = state.evaluations.find(evaluation => evaluation.candidateId === individual?.id && evaluation.contract === 'freshness-v1' && evaluation.purpose !== 'diagnostic');
  return check?.outcome === 'PASS' ? 'Individual freshness passed' : check?.outcome ? `Individual freshness ${check.outcome.toLowerCase()}` : attempt.submissionId ? 'Individual check pending' : stoppedWithoutSubmission(attempt) ? 'No accepted submission' : 'Submission pending';
}

/** Describe source observations only; an edit grant is not evidence of an edit. */
function ChangedPaths({ attempt }: { attempt: Attempt }) {
  const message = !attempt.submissionId ? 'No accepted source; changed paths are unavailable.'
    : !attempt.changedPaths ? 'Changed paths were not reported for this accepted source.'
    : attempt.changedPaths.length === 0 ? 'No changed paths were recorded for this accepted source.' : '';
  return <div className="story-paths"><span>Recorded changes</span>{message
    ? <span className="story-path-message">{message}</span>
    : <div className="story-path-list">{attempt.changedPaths!.map(path => <code key={path}>{path}</code>)}</div>}</div>;
}

type SourceEffect = 'retained' | 'superseded' | 'changed-again' | 'no-edit' | 'unknown';
function sourceEffect(state: PlatformState, candidate: Candidate | undefined, attempt: Attempt): SourceEffect {
  if (!candidate || !attempt.submissionId) return 'unknown';
  const base = state.candidates.find(item => item.commit === candidate.publicationBase);
  const individual = state.candidates.find(item => item.attemptIds.length === 1 && item.attemptIds[0] === attempt.id
    && item.submissionIds?.includes(attempt.submissionId!));
  if (!base?.manifest?.entries || !individual?.manifest?.entries || !candidate.manifest?.entries
    || individual.publicationBase !== candidate.publicationBase) return 'unknown';
  const identity = (source: Candidate, path: string) => {
    const entry = source.manifest.entries.find(item => item.path === path);
    return entry ? `${entry.mode}:${entry.digest}:${entry.size}` : 'absent';
  };
  const paths = [...new Set([...base.manifest.entries, ...individual.manifest.entries].map(item => item.path))]
    .filter(path => identity(base, path) !== identity(individual, path));
  if (!paths.length) return 'no-edit';
  if (paths.every(path => identity(candidate, path) === identity(individual, path))) return 'retained';
  if (paths.every(path => identity(candidate, path) === identity(base, path))) return 'superseded';
  return 'changed-again';
}

const effectLabel: Record<Exclude<SourceEffect, 'unknown'>, string> = {
  retained: 'Submitted source edit retained', superseded: 'Submitted source edit superseded',
  'changed-again': 'Submitted source changed again', 'no-edit': 'No source difference from base',
};
function roles(agents: Attempt[]): string {
  const names = agents.map(agent => agent.role);
  return names.length < 2 ? names[0] ?? '' : names.length === 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function ModelCallReadout({ state }: { state: PlatformState }) {
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<{ key: string; summary?: ModelCallSummary; error?: string }>();
  const key = `${state.tenantId}/${state.projectId}/${state.projectIncarnation}/${state.revision}/${state.session?.principalId ?? ''}`;
  const current = result?.key === key ? result : undefined;
  if (!state.capabilities.deployment) return null;
  async function readRoster() {
    setReading(true);
    try {
      const raw = await request<unknown>(`/v1/projects/${encodeURIComponent(state.projectId)}/state?modelCalls=1`, {
        headers: { 'if-platform-incarnation': state.projectIncarnation,
          ...(state.session?.principalId ? { 'if-platform-principal': state.session.principalId } : {}) },
      });
      setResult({ key, summary: modelCallSummary(raw, state) });
    } catch (error) {
      setResult({ key, error: error instanceof Error ? error.message : 'Could not read the model-call roster.' });
    } finally { setReading(false); }
  }
  return <div className="score-model-readout">
    <button type="button" disabled={reading} onClick={() => void readRoster()}>{reading ? 'Reading…' : 'Read model-call reservations'}</button>
    {current?.summary && <p role="status">Authority admitted {current.summary.count.toLocaleString('en-GB')} model-call {current.summary.count === 1 ? 'slot' : 'slots'} at this revision. Provider responses and cost require separate verified usage evidence.</p>}
    {current?.error && <p role="alert">{current.error}</p>}
  </div>;
}

export function ReleaseStory({ state, candidate }: { state: PlatformState; candidate?: Candidate }) {
  const recorded = publishedRecord(state, candidate);
  if (recorded && candidate) return <PublishedReleaseStory state={state} candidate={candidate} record={recorded} />;
  if (candidate && state.receipts.some(item => item.candidateId === candidate.id)) return <section className="release-story"><h2>Receipt details unavailable for this source.</h2><p role="status">Refresh a complete matching view of this project, source and publication before inspecting the recorded release.</p></section>;
  const weftSelection = isWeftSelection(candidate);
  const originals = state.attempts.filter(attempt => attempt.role !== 'repair' && (!candidate || candidate.attemptIds.includes(attempt.id)));
  const submittedCount = originals.filter(attempt => Boolean(attempt.submissionId)).length;
  const conflict = releaseConflict(state, candidate);
  const awaitingDiagnosis = !weftSelection && candidate?.outcome === 'FAIL' && !conflict;
  const mismatch = interactionMismatch(state, conflict);
  const repair = state.attempts.find(attempt => attempt.id === conflict?.repairAttemptId);
  const isSuccessor = Boolean(candidate && (candidate.repairOf || conflict?.repairCandidateId === candidate.id));
  const failedCandidate = state.candidates.find(item => item.id === (candidate?.repairOf || (isSuccessor ? conflict?.candidateId : undefined)));
  const lineageRetained = Boolean(failedCandidate && failedCandidate.attemptIds.every(id => candidate?.attemptIds.includes(id)));
  const finalPlan = currentReleasePlan(state, candidate);
  const effects = originals.map(attempt => ({ attempt, effect: sourceEffect(state, candidate, attempt) }));
  const retainedEdits = effects.filter(item => item.effect === 'retained').map(item => item.attempt);
  const supersededEdits = effects.filter(item => item.effect === 'superseded').map(item => item.attempt);
  const changedAgain = effects.filter(item => item.effect === 'changed-again').map(item => item.attempt);
  const finalGoalsPassed = releaseGoalsPassed(state, candidate);
  const contradictoryFailure = Boolean(candidate?.outcome === 'PASS' && state.evidence.some(item => item.candidateId === candidate.id && item.outcome === 'FAIL'));
  const noEligiblePlan = Boolean(candidate?.outcome === 'PASS' && !finalPlan);
  const missingNamedGoals = Boolean(candidate?.outcome === 'PASS' && finalPlan?.outcome === 'PASS' && !finalGoalsPassed);
  const waitingForChecks = Boolean(candidate && (!candidate.outcome || candidate.status === 'EVALUATING' || candidate.outcome === 'PASS' && !finalGoalsPassed));
  const metrics = releaseMetrics(state, candidate);
  const publication = state.receipts.some(receipt => receipt.candidateId === candidate?.id);
  const displayedStatus = publication ? 'published' : candidate?.outcome === 'PASS' && !finalGoalsPassed ? 'pending' : candidate?.outcome || candidate?.status || state.demoStatus;
  const review = currentReview(state, candidate?.id);
  const reviewReady = review && candidate && finalGoalsPassed && !review.approval && !publication && !reviewNeedsRefresh(state, candidate, review);
  const decisionLabel = reviewReady ? 'Reviewer decision' : 'Next step';
  const stage = repairStage(repair);
  const repairHeading = isSuccessor ? candidate?.outcome === 'FAIL' ? 'Successor failed checks' : contradictoryFailure ? 'Retained failure blocks successor' : noEligiblePlan ? 'No current eligible successor plan' : missingNamedGoals ? 'Named goals unproved on successor' : finalGoalsPassed ? 'Successor checked as one' : 'Successor under evaluation' : stage.heading;
  const repairDescription = isSuccessor ? [
    lineageRetained ? 'The successor records the selected attempts in its lineage.' : 'Compare the successor’s contribution lineage with the failed candidate.',
    retainedEdits.length ? `${roles(retainedEdits)} ${retainedEdits.length === 1 ? 'submitted source edit remains' : 'submitted source edits remain'} byte-identical on the changed paths.` : '',
    supersededEdits.length ? `${roles(supersededEdits)} ${supersededEdits.length === 1 ? 'submitted source edit was' : 'submitted source edits were'} superseded in this source.` : '',
    changedAgain.length ? `${roles(changedAgain)} ${changedAgain.length === 1 ? 'submitted source edit changed' : 'submitted source edits changed'} again.` : '',
    finalGoalsPassed ? 'Registered checks for fresh writes, useful caching and accessible saved status passed on this exact source.' : finalPlan ? 'The registered final checks have not all passed on this exact source.' : 'The original goals still require exact final checks.',
  ].filter(Boolean).join(' ')
    : repair ? `Attempt ${short(repair.id)} · ${stage.description}` : stage.description;

  return <section className="release-story" aria-labelledby="release-story-title">
    <div className="release-story-heading"><div><div className="section-kicker">Release at a glance</div><h2 id="release-story-title">{isSuccessor && candidate?.outcome === 'FAIL' ? 'The repair still fails a release check.' : contradictoryFailure ? 'A retained failure blocks this source.' : candidate?.outcome === 'PASS' && finalPlan?.outcome === 'FAIL' ? 'Current full release checks failed.' : noEligiblePlan ? 'Current full release proof is unavailable.' : missingNamedGoals ? 'Named release goals remain unproved.' : isSuccessor && finalGoalsPassed ? 'Original goals passed after repair.' : isSuccessor && waitingForChecks ? 'Repair proof is still pending.' : weftSelection ? recordedCandidateFailure(state, candidate) ? 'Frozen Weft source failed release checks.' : waitingForChecks ? 'Checking the frozen Weft selection.' : 'From a frozen selection to a release decision.' : conflict ? 'The combination exposed an interaction.' : awaitingDiagnosis ? 'Combined checks failed; diagnosis pending.' : waitingForChecks ? 'Checking the combined source.' : 'From parallel work to one decision.'}</h2><p>{candidate ? `Showing the exact ${candidate.name} candidate and its evidence.${conflict?.category === 'behavioural-interaction' ? ' Repair activity includes all attempts for its failed composition.' : ''}` : 'Follow the project so far; metrics cover all recorded attempts until a candidate is selected.'}</p>{candidate?.outcomeProvenance === 'retained' && <p className="story-provenance" role="note">This {candidate.outcome === 'FAIL' ? 'failure' : 'pass'} was recorded under an earlier checker, goal, or policy version. {candidate.outcome === 'FAIL' ? 'The failure remains a repair target.' : 'The result is retained for context.'} A current full evaluation is required before review.</p>}{candidate?.outcome === 'PASS' && state.evidence.some(item => item.candidateId === candidate.id && item.outcome === 'FAIL') && <p className="story-provenance" role="note">A retained failure contradicts this later pass. The source needs a repair successor before release.</p>}</div><Badge status={displayedStatus} /></div>
    <div className="release-decision" role="status" aria-live="polite"><Icon name={publication ? 'shield' : 'arrow'} size={17} /><div><strong>{decisionLabel}</strong><p>{decision(state, candidate)}</p></div></div>
    <dl className="release-scoreboard" aria-label={candidate ? 'Selected candidate metrics' : 'Project metrics so far'}>
      <div><dt>Completed goals</dt><dd>{candidate ? `${metrics.completedGoals}/${metrics.totalGoals}` : '—'}<span className="score-context">{candidate ? metrics.requiredJobs ? `${metrics.passedJobs}/${metrics.requiredJobs} required checks passed` : 'Final checks pending on this candidate' : 'Select a candidate for its goals'}</span></dd></div>
      <div><dt>Recorded span</dt><dd>{metrics.recordedSpan}<span className="score-context">{weftSelection ? 'Working-session timing not reported' : metrics.spanBasis}</span></dd></div>
      <div><dt>Model cost</dt><dd className={weftSelection || metrics.modelCost === 'Unmeasured' ? 'score-unmeasured' : undefined}>{weftSelection ? 'Not reported' : metrics.modelCost}<span className="score-context">{weftSelection ? 'Weft participant usage is not reported here' : metrics.modelCost === 'Unmeasured' ? 'Cloudflare billing and complete usage unverified' : metrics.modelCost === 'No model calls' ? 'Scripted attempts only' : 'No attempts yet'}</span></dd>{!weftSelection && metrics.modelCost === 'Unmeasured' && <ModelCallReadout state={state} />}</div>
      {weftSelection ? <div><dt>Working sessions</dt><dd>Not reported<span className="score-context">See live workspace for reported activity</span></dd></div> : <div><dt>Repair attempts</dt><dd>{metrics.repairAttempts}<span className="score-context">{candidate ? `${conflict?.category === 'behavioural-interaction' ? 'For this failure · ' : ''}${metrics.repairContributors} included in candidate` : 'Recorded in this project'}</span></dd></div>}
      <div><dt>Reviewer time</dt><dd className="score-unmeasured">{metrics.reviewerTime}<span className="score-context">{metrics.approvalCount} {metrics.approvalCount === 1 ? 'approval' : 'approvals'} recorded</span></dd></div>
    </dl>
    {weftSelection && candidate ? <div className="release-story-grid">
      <div className="release-story-stage"><div className="story-stage-label"><span>01</span> Frozen source</div><h3>Frozen source selection</h3><p>The retained Weft revision became this exact candidate. Later live edits do not change this candidate.</p><code className="story-id">Commit {candidate.commit}</code><code className="story-id">Manifest {candidate.manifestDigest}</code></div>
      <div className="release-story-stage"><div className="story-stage-label"><span>02</span> Release checks</div><h3>{recordedCandidateFailure(state, candidate) || finalPlan?.outcome === 'FAIL' ? 'Release checks failed' : finalGoalsPassed ? 'Release checks passed' : finalPlan?.outcome && finalPlan.outcome !== 'PASS' ? 'Release checks need attention' : 'Release checks pending'}</h3><p>Confidence checks this frozen source against the required release goals. Passing checks still requires exact human review before publication.</p><div className="story-goals">{releaseGoalCases.map(goal => { const status = releaseGoalStatus(state, finalPlan, goal.cases); return <div key={goal.name}><Icon name={status === 'PASS' ? 'check' : status === 'FAIL' ? 'error' : 'time'} size={15} /><span>{goal.name}</span><Badge status={status} /></div>; })}</div></div>
      <div className="release-story-stage"><div className="story-stage-label"><span>03</span> Live work</div><h3>Further work stays live</h3><p>Work can continue in the connected workspace. To include corrective edits, select and submit a new retained revision for its own release checks.</p></div>
    </div> : <div className="release-story-grid">
      <div className="release-story-stage"><div className="story-stage-label"><span>01</span> Contributions</div><h3>{originals.length ? submittedCount === originals.length ? `${originals.length} isolated ${originals.length === 1 ? 'submission' : 'submissions'}` : `${submittedCount} of ${originals.length} submitted` : 'Awaiting contributions'}</h3>{originals.length ? <ul className="story-contributions">{originals.map(attempt => { const effect = sourceEffect(state, candidate, attempt); return <li key={attempt.id}><span className={`story-agent role-${attempt.role.toLowerCase()}`}>{attempt.role}</span><div><strong>{attempt.name}</strong><span>{contributionResult(state, attempt)}</span><ChangedPaths attempt={attempt} />{effect !== 'unknown' && <span className="story-source-effect">{effectLabel[effect]}</span>}</div></li>; })}</ul> : <p>Each attempt will show its own source, scope and check.</p>}</div>
      <div className="release-story-stage"><div className="story-stage-label"><span>02</span> Interaction</div><h3>{conflict ? isSuccessor ? 'An earlier combination failed' : 'The combination failed' : awaitingDiagnosis ? 'Interaction diagnosis pending' : candidate && !finalPlan ? 'Current interaction proof unavailable' : candidate ? 'No interaction recorded' : 'Combine and test'}</h3><p>{conflict?.summary || (awaitingDiagnosis ? 'The integrated checks failed. A controlled interaction witness has not been recorded yet.' : candidate && !finalPlan ? 'A current eligible full plan is required before drawing a conclusion about this source.' : candidate ? 'Inspect the integrated candidate’s exact checks before drawing a conclusion.' : 'Passing individual checks cannot establish the behaviour of their combination.')}</p>{mismatch && <div className="story-mismatch"><span>Recorded {mismatch.action} mismatch</span><strong>Expected {mismatch.expected?.toLocaleString('en-GB')} · observed {mismatch.observed?.toLocaleString('en-GB')}</strong></div>}{conflict?.witness && <div className="story-evidence"><Icon name="shield" size={15} /><span>{conflict.witness.rows.filter(row => row.outcome === 'PASS').map(row => row.name).join(', ') || 'No rows'} passed · {conflict.witness.rows.filter(row => row.outcome === 'FAIL').map(row => row.name).join(', ') || 'no rows'} failed</span></div>}{conflict && <code className="story-id">Conflict {short(conflict.id.replace(/^conflict-/, ''), 8)}</code>}</div>
      <div className="release-story-stage"><div className="story-stage-label"><span>03</span> Repair & retention</div><h3>{repairHeading}</h3><p>{repairDescription}</p><div className="story-goals">{releaseGoalCases.map(goal => { const status = releaseGoalStatus(state, finalPlan, goal.cases); return <div key={goal.name}><Icon name={status === 'PASS' ? 'check' : status === 'FAIL' ? 'error' : 'time'} size={15} /><span>{goal.name}</span><Badge status={status} /></div>; })}</div></div>
    </div>}
  </section>;
}
