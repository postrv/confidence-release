import { FULL_RELEASE_JOB_COUNT } from '../../../workers/evaluator/recipes';
import type { Attempt, Candidate, Conflict, Evaluation, Job, Observation, Outcome, PlatformState, Review } from '../../../services/types';

/** A stopped authoring generation without accepted source cannot join a selection. */
export function stoppedWithoutSubmission(attempt: Attempt): boolean {
  return Boolean(attempt.terminationObserved && !attempt.submissionId && attempt.executionOutcome
    && !['COMPLETED', 'PENDING'].includes(attempt.executionOutcome));
}

const maxBudgetCounter = 18446744073709551615n;
const budgetCounter = (value: unknown): bigint | undefined => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= maxBudgetCounter ? BigInt(value) : undefined;

export function formatReservationUnits(value: string): string {
  return budgetCounter(value)?.toLocaleString('en-GB') ?? 'Unavailable';
}

/** UI guidance only; the authority rechecks the reservation atomically. */
export function repairReservationDecision(state: Pick<PlatformState, 'capabilities' | 'projectBudget'>): { allowed: boolean; reason?: string } {
  if (!state.capabilities.deployment) return { allowed: true };
  if (state.capabilities.maintenance) return { allowed: false, reason: 'Maintenance mode is read-only. Wait for the active deployment and a fresh project snapshot before starting a repair.' };
  const budget = state.projectBudget;
  if (!budget) return { allowed: false, reason: 'Project reservation totals are unavailable. Refresh the project snapshot before starting another repair.' };
  const maximum = budgetCounter(budget.maximumUnits), reserved = budgetCounter(budget.reservedUnits), settled = budgetCounter(budget.settledUnits);
  const available = budgetCounter(budget.availableUnits), required = budgetCounter(budget.repairReservationUnits), policyCap = budgetCounter(budget.policyCapUnits);
  if (maximum === undefined || reserved === undefined || settled === undefined || available === undefined || required === undefined || policyCap === undefined || required === 0n
    || reserved + settled > maximum || maximum - reserved - settled !== available) {
    return { allowed: false, reason: 'Project reservation totals need a fresh authoritative read before another repair.' };
  }
  if (available < required) {
    const shortage = required - available;
    const remedy = maximum <= policyCap && policyCap - maximum >= shortage
      ? 'An admin must record an audited budget increase before another attempt can be reserved.'
      : `The current pilot policy caps the project at ${formatReservationUnits(budget.policyCapUnits)} units. A reviewed policy change is required before another attempt can be reserved.`;
    return { allowed: false, reason: `A new repair needs ${formatReservationUnits(budget.repairReservationUnits)} internal reservation units; ${formatReservationUnits(budget.availableUnits)} remain. ${remedy}` };
  }
  return { allowed: true };
}

/** The smallest audited increase that admits one repair, never a provider-spend estimate. */
export function repairBudgetIncrease(state: Pick<PlatformState, 'capabilities' | 'projectBudget' | 'session'>): { increaseUnits: string; newMaximumUnits: string } | undefined {
  if (!state.capabilities.deployment || state.capabilities.maintenance || state.session?.credentialClass !== 'human' || repairReservationDecision(state).allowed) return undefined;
  const budget = state.projectBudget;
  if (!budget) return undefined;
  const maximum = budgetCounter(budget.maximumUnits), reserved = budgetCounter(budget.reservedUnits), settled = budgetCounter(budget.settledUnits);
  const available = budgetCounter(budget.availableUnits), required = budgetCounter(budget.repairReservationUnits), policyCap = budgetCounter(budget.policyCapUnits);
  if (maximum === undefined || reserved === undefined || settled === undefined || available === undefined || required === undefined || policyCap === undefined
    || required === 0n || reserved !== 0n || reserved + settled > maximum || maximum - reserved - settled !== available || available >= required) return undefined;
  const increase = required - available;
  if (increase > required || maximum + increase > policyCap || maximum + increase > maxBudgetCounter) return undefined;
  return { increaseUnits: increase.toString(), newMaximumUnits: (maximum + increase).toString() };
}

/** Distinguish a terminal authoring attempt from one still working on source. */
export function repairStage(attempt?: Attempt): { heading: string; description: string } {
  if (!attempt) return { heading: 'Original goals remain required', description: 'A repair must retain fresh writes, useful caching and the saved-value status.' };
  if (attempt.submissionId) return { heading: 'Repair submitted', description: 'Source was submitted from the failed candidate and counterexample.' };
  if (stoppedWithoutSubmission(attempt)) return { heading: 'Repair stopped without source', description: 'Stopped without accepted source. The failed candidate and counterexample remain; a fresh bounded attempt is needed.' };
  if (attempt.terminationObserved) return { heading: 'Repair stopped; source pending', description: 'Stopped. Source ingestion has not been observed yet.' };
  return { heading: 'Repair in progress', description: 'Working from the failed source and counterexample.' };
}

/** Reviews arrive in durable creation order from either authority adapter. */
export function currentReview(state: PlatformState, candidateId?: string): Review | undefined {
  return state.reviews.filter(review => review.candidateId === candidateId).at(-1);
}

export function currentConflict(state: PlatformState, selected: string[] = []): Conflict | undefined {
  const active = state.candidates.find(candidate => candidate.id === state.activeCandidateId);
  const mechanical = state.conflicts.filter(conflict => conflict.category === 'mechanical-overlap' && conflict.status === 'OPEN' && conflict.attemptIds.length === selected.length && conflict.attemptIds.every(id => selected.includes(id))).at(-1);
  if (mechanical) return mechanical;
  if (!active) return undefined;
  return state.conflicts.find(conflict => conflict.candidateId === active.id)
    ?? state.conflicts.find(conflict => conflict.repairCandidateId === active.id)
    ?? (active.repairOf ? state.conflicts.find(conflict => conflict.candidateId === active.repairOf) : undefined);
}

/** An exact retained failure remains relevant after a newer check changes the display outcome. */
export function recordedCandidateFailure(state: Pick<PlatformState, 'conflicts' | 'evidence'>, candidate?: Candidate): boolean {
  return Boolean(candidate && (candidate.outcome === 'FAIL'
    || state.conflicts.some(conflict => conflict.category === 'behavioural-interaction' && conflict.candidateId === candidate.id)
    || state.evidence.some(item => item.candidateId === candidate.id && item.outcome === 'FAIL')));
}

/** Resolve repair provenance from observed authority relations, including older successors. */
export function repairOrigin(state: Pick<PlatformState, 'candidates' | 'attempts' | 'conflicts' | 'evidence'>, candidate?: Candidate): Candidate | undefined {
  if (!candidate) return undefined;
  const declared = state.candidates.find(item => item.id === candidate.repairOf && recordedCandidateFailure(state, item));
  if (declared) return declared;
  const conflict = state.conflicts.find(item => item.category === 'behavioural-interaction' && item.repairCandidateId === candidate.id);
  const byConflict = state.candidates.find(item => item.id !== candidate.id && item.id === conflict?.candidateId && recordedCandidateFailure(state, item));
  if (byConflict) return byConflict;
  const bases = [...new Set(state.attempts.filter(item => item.role === 'repair' && candidate.attemptIds.includes(item.id)).map(item => item.workBase))];
  return bases.length === 1 ? state.candidates.find(item => item.id !== candidate.id && item.commit === bases[0] && recordedCandidateFailure(state, item)) : undefined;
}

/** The release story describes an evaluated candidate, not an unbound selection overlap. */
export function releaseConflict(state: PlatformState, candidate?: Candidate): Conflict | undefined {
  if (!candidate) return undefined;
  const conflicts = state.conflicts.filter(conflict => conflict.category === 'behavioural-interaction');
  return conflicts.find(conflict => conflict.candidateId === candidate.id)
    ?? conflicts.find(conflict => conflict.repairCandidateId === candidate.id)
    ?? (candidate.repairOf ? conflicts.find(conflict => conflict.candidateId === candidate.repairOf) : undefined);
}

/** Retain set-valued expectations and never invent absent HTTP metadata. */
export function observationExpected(observation: Observation): string {
  return observation.expectedOneOf?.length ? observation.expectedOneOf.join(' or ') : String(observation.expected ?? '—');
}

export function observationMismatch(observation: Observation): boolean {
  return observation.observed !== undefined && (observation.expectedOneOf?.length
    ? !observation.expectedOneOf.includes(observation.observed)
    : observation.expected !== undefined && observation.expected !== observation.observed);
}

/** Show an exact failed observation from the conflict's retained trace or named evidence. */
export function interactionMismatch(state: PlatformState, conflict?: Conflict): Observation | undefined {
  if (!conflict) return undefined;
  const traces = [
    conflict.counterexample ?? [],
    ...state.evidence.filter(item => conflict.evidenceIds.includes(item.id) && item.outcome === 'FAIL').map(item => item.observations),
  ];
  return traces.flat().find(observation => Number.isSafeInteger(observation.expected)
    && Number.isSafeInteger(observation.observed) && observation.expected !== observation.observed);
}

export function reviewBase(state: PlatformState, candidate?: Candidate): Candidate | undefined {
  return state.candidates.find(base => base.commit === candidate?.publicationBase);
}

/** A prior release does not complete the current candidate's publication step. */
export function publishedCandidate(state: PlatformState, candidateId?: string): boolean {
  return Boolean(candidateId && state.receipts.some(receipt => receipt.candidateId === candidateId));
}

export function measuredDuration(startedAt?: string, completedAt?: string): string {
  const start = Date.parse(startedAt ?? ''), end = Date.parse(completedAt ?? '');
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? `${((end - start) / 1000).toFixed(2)}s` : 'Not recorded';
}

/** Production jobs settle without embedding an outcome; their exact evidence supplies it. */
export function releaseJobOutcome(state: PlatformState, evaluation: Evaluation, job: Job): Outcome | undefined {
  const evidence = state.evidence.filter(item => item.candidateId === evaluation.candidateId && item.evaluationId === evaluation.id && item.jobId === job.id);
  if (evidence.length > 1) return 'INCONCLUSIVE';
  if (evidence.length === 1) return evidence[0]!.outcome;
  return ['PASS', 'FAIL', 'ERROR', 'TIMEOUT', 'CANCELLED', 'INCONCLUSIVE'].includes(job.status) ? job.status as Outcome : undefined;
}

/** Declared cache-pilot cases; each group allows the local and deployed registration names. */
export const releaseGoalCases = [
  { name: 'Fresh writes', cases: [['warm-read-write-read'], ['repeated-reads'], ['successive-writes'], ['cold-write-then-warm-write', 'cold-write'], ['audit-write-burst'], ['overlapping-read-write']] },
  { name: 'Useful caching', cases: [['retained-cache-benefit']] },
  { name: 'Accessible saved status', cases: [['accessible-saved-value', 'accessible-value'], ['audit-alternating-pages']] },
] as const;

/** Each inner list contains registered aliases for one required case. */
export function releaseGoalStatus(state: PlatformState, evaluation: Evaluation | undefined, cases: readonly (readonly string[])[]): Outcome | 'pending' {
  if (!evaluation) return 'pending';
  const jobs = cases.map(names => evaluation.jobs.filter(job => names.includes(job.name)));
  const outcomes = jobs.flat().map(job => releaseJobOutcome(state, evaluation, job));
  if (outcomes.includes('FAIL')) return 'FAIL';
  const otherOutcome = outcomes.find(outcome => outcome && outcome !== 'PASS');
  if (otherOutcome) return otherOutcome;
  return jobs.every(group => group.length > 0) && outcomes.every(outcome => outcome === 'PASS') ? 'PASS' : 'pending';
}

/** The deployed authority names the newest full plan still eligible under its current checker, goal and policy. */
export function currentReleasePlan(state: PlatformState, candidate?: Candidate): Evaluation | undefined {
  if (!candidate) return undefined;
  const plans = state.evaluations.filter(evaluation => evaluation.purpose !== 'diagnostic' && evaluation.candidateId === candidate.id && evaluation.contract === 'retained-value-v1');
  if (state.capabilities?.deployment === true) return plans.find(evaluation => evaluation.id === candidate.reviewEvaluationId);
  return plans.at(-1);
}

/** Register current checks without promoting a retained plan into current evidence. */
export function currentFinalChecksDecision(state: PlatformState, candidate?: Candidate): { allowed: boolean; reason: string } {
  if (!state.capabilities.deployment || state.session?.credentialClass !== 'human') return { allowed: false, reason: 'A verified human session in the deployed workspace is required.' };
  if (state.capabilities.maintenance) return { allowed: false, reason: 'Maintenance mode is read-only. Wait for the active deployment before running current final checks.' };
  if (!candidate || candidate.evaluationReadComplete !== true) return { allowed: false, reason: 'A complete authoritative view of this source and its checks is required. Refresh the selected candidate.' };
  if (candidate.reviewEvaluationId) return { allowed: false, reason: 'A current full evaluation is already registered for this exact source.' };
  if (recordedCandidateFailure(state, candidate)) return { allowed: false, reason: 'A retained behavioural failure requires a repair successor.' };
  if (state.publications.some(item => item.candidateId === candidate.id) || publishedCandidate(state, candidate.id)) return { allowed: false, reason: 'This source already has a recorded publication operation.' };
  if (state.evaluations.some(item => item.candidateId === candidate.id && item.purpose !== 'diagnostic' && (item.status !== 'SETTLED' || item.jobs.some(job => job.status !== 'SETTLED')))) return { allowed: false, reason: 'Wait for the registered checks on this source to finish before starting another evaluation.' };
  return { allowed: true, reason: `Run all ${FULL_RELEASE_JOB_COUNT} current final checks on this exact source. Historical results remain recorded and do not qualify this source for review.` };
}

/** One explicit retry of a settled infrastructure result, on the exact existing source. */
export function finalChecksRetryDecision(state: PlatformState, candidate?: Candidate): { allowed: boolean; reason: string } {
  if (!state.capabilities.deployment || state.session?.credentialClass !== 'human') return { allowed: false, reason: 'A verified human session in the deployed workspace is required.' };
  if (state.capabilities.maintenance) return { allowed: false, reason: 'Maintenance mode is read-only. Wait for the active deployment before running final checks again.' };
  const plan = currentReleasePlan(state, candidate);
  if (!candidate || !plan || plan.jobs.length !== FULL_RELEASE_JOB_COUNT || plan.jobs.some(job => !job.required)) return { allowed: false, reason: 'A current full evaluation plan is required for this exact source.' };
  if (state.evidence.some(item => item.candidateId === candidate.id && item.outcome === 'FAIL')) return { allowed: false, reason: 'A retained behavioural failure requires a repair successor.' };
  if (state.publications.some(item => item.candidateId === candidate.id) || publishedCandidate(state, candidate.id)) return { allowed: false, reason: 'This source already has a recorded publication operation.' };
  if (state.evaluations.some(item => item.candidateId === candidate.id && item.purpose !== 'diagnostic' && item.status !== 'SETTLED') || plan.jobs.some(job => job.status !== 'SETTLED')) return { allowed: false, reason: 'Wait for the registered checks on this source to finish before starting another evaluation.' };
  const results = plan.jobs.map(job => state.evidence.filter(item => item.candidateId === candidate.id && item.evaluationId === plan.id && item.jobId === job.id));
  if (results.some((items, index) => items.length !== 1 || items[0]!.evaluationInputDigest !== plan.jobs[index]!.evaluationInputDigest)) return { allowed: false, reason: 'Every final job needs one matching retained result before another evaluation.' };
  const outcomes = results.map(items => items[0]!.outcome);
  if (!['ERROR', 'INCONCLUSIVE'].includes(plan.outcome ?? '') || !outcomes.some(outcome => outcome === 'ERROR' || outcome === 'INCONCLUSIVE') || outcomes.some(outcome => !['PASS', 'ERROR', 'INCONCLUSIVE'].includes(outcome))) return { allowed: false, reason: 'Another evaluation is available only after inconclusive or error results.' };
  return { allowed: true, reason: `Run all ${FULL_RELEASE_JOB_COUNT} final checks once more on this exact source. The existing results remain recorded.` };
}

/** A PASS aggregate is reviewable only when every named original goal is proved. */
export function releaseGoalsPassed(state: PlatformState, candidate?: Candidate): boolean {
  const plan = currentReleasePlan(state, candidate);
  // The admission kernel rejects a retained failure on this exact candidate,
  // even if a later eligible plan passes. Do not offer a review it cannot publish.
  return Boolean(candidate?.outcome === 'PASS' && plan?.outcome === 'PASS' && plan.jobs.length === FULL_RELEASE_JOB_COUNT && plan.jobs.every(job => job.required)
    && !state.evidence.some(item => item.candidateId === candidate.id && item.outcome === 'FAIL')
    && releaseGoalCases.every(goal => releaseGoalStatus(state, plan, goal.cases) === 'PASS'));
}

/** Scope a selected release's evidence to its candidate, while counting every repair of its failed base. */
export function releaseMetrics(state: PlatformState, candidate?: Candidate) {
  const plan = currentReleasePlan(state, candidate);
  const requiredJobs = plan?.jobs.filter(job => job.required) ?? [];
  const passedJobs = plan ? requiredJobs.filter(job => releaseJobOutcome(state, plan, job) === 'PASS').length : 0;
  const completedGoals = plan ? releaseGoalCases.filter(goal => releaseGoalStatus(state, plan, goal.cases) === 'PASS').length : 0;
  const attempts = candidate ? state.attempts.filter(attempt => candidate.attemptIds.includes(attempt.id)) : state.attempts;
  const conflict = releaseConflict(state, candidate);
  const failedId = candidate && conflict?.candidateId === candidate.id ? candidate.id : candidate?.repairOf || conflict?.candidateId;
  const failedCandidate = failedId ? state.candidates?.find(item => item.id === failedId) : undefined;
  const repairAttempts = candidate && failedCandidate
    ? state.attempts.filter(attempt => attempt.role === 'repair' && attempt.workBase === failedCandidate.commit)
    : attempts.filter(attempt => attempt.role === 'repair');
  const relatedAttempts = [...new Map([...attempts, ...repairAttempts].map(attempt => [attempt.id, attempt])).values()];
  const attemptIds = new Set(relatedAttempts.map(attempt => attempt.id));
  const starts = [
    ...relatedAttempts.map(attempt => attempt.startedAt),
    ...state.events.filter(event => Boolean(event.objectId) && attemptIds.has(event.objectId!)).map(event => event.time),
  ].map(value => Date.parse(value ?? '')).filter(Number.isFinite);
  const firstStart = starts.length ? Math.min(...starts) : undefined;
  const evaluations = candidate ? state.evaluations.filter(evaluation => evaluation.candidateId === candidate.id) : [];
  const reviews = candidate ? state.reviews.filter(review => review.candidateId === candidate.id) : [];
  const publications = candidate ? state.publications.filter(publication => publication.candidateId === candidate.id) : [];
  const receipt = candidate ? state.receipts.filter(record => record.candidateId === candidate.id).at(-1) : undefined;
  const relatedIds = new Set([candidate?.id, ...relatedAttempts.map(attempt => attempt.id), ...evaluations.map(evaluation => evaluation.id), ...reviews.map(review => review.id), ...publications.map(publication => publication.id), receipt?.id]);
  const recordedTimes = [
    candidate?.createdAt,
    ...state.events.filter(event => Boolean(event.objectId) && relatedIds.has(event.objectId)).map(event => event.time),
    ...relatedAttempts.map(attempt => attempt.completedAt),
    ...evaluations.map(evaluation => evaluation.completedAt),
    ...reviews.map(review => review.approval?.approvedAt),
    ...publications.flatMap(publication => [publication.admittedAt, publication.dispatchedAt, publication.confirmedAt]),
  ].map(value => Date.parse(value ?? '')).filter(Number.isFinite);
  const receiptTime = Date.parse(receipt?.createdAt ?? '');
  const lastRecord = Number.isFinite(receiptTime) ? receiptTime : recordedTimes.length ? Math.max(...recordedTimes) : undefined;
  const spanSeconds = firstStart !== undefined && lastRecord !== undefined && lastRecord >= firstStart ? Math.round((lastRecord - firstStart) / 1000) : undefined;
  const recordedSpan = spanSeconds === undefined ? 'Unmeasured' : spanSeconds < 60 ? `${spanSeconds}s` : `${Math.floor(spanSeconds / 60)}m ${String(spanSeconds % 60).padStart(2, '0')}s`;
  const piUsed = [...attempts, ...repairAttempts].some(attempt => attempt.mode === 'pi');
  const approvalCount = (candidate ? reviews : state.reviews).filter(review => Boolean(review.approval)).length;
  return {
    completedGoals,
    totalGoals: releaseGoalCases.length,
    requiredJobs: requiredJobs.length,
    passedJobs,
    recordedSpan,
    spanBasis: receipt ? 'First attempt record to receipt' : candidate ? 'First attempt to latest related record' : 'First attempt to latest record',
    modelCost: piUsed ? 'Unmeasured' : attempts.length ? 'No model calls' : '—',
    repairAttempts: repairAttempts.length,
    repairContributors: candidate ? attempts.filter(attempt => attempt.role === 'repair').length : 0,
    reviewerTime: 'Unmeasured',
    approvalCount,
  };
}

/** A rejected initialization must not poison every later verifier attempt. */
export function retryableLoader<T>(initialize: () => Promise<T>, timeoutMs?: number): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (pending) return pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve().then(initialize);
    const bounded = timeoutMs ? Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Verifier initialization timed out. Retry loading the selected file.')), timeoutMs); })]) : work;
    pending = bounded.catch(error => { pending = undefined; throw error; }).finally(() => clearTimeout(timer));
    return pending;
  };
}
