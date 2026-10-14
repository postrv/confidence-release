// SPDX-License-Identifier: Apache-2.0
import { FULL_RELEASE_JOB_COUNT } from "../evaluator/recipes";
import type { AdmissionEvidence, LogicalReceipt, Outcome, SourceManifest } from "../../packages/protocol/src/types";
import type { AuthorityRead, CandidateRecord, ProjectRecord } from "../authority/types";
import type { PlatformState, ProjectReservationBudget, Attempt, Candidate, Evidence, Evaluation, Observation, Review, Publication, Receipt, Conflict } from "../../services/types";
import { PILOT_ATTEMPT_RESERVATION_UNITS, pilotBudgetPolicyCapUnits } from "../shared/pilot-budget";

const numeric = (value: string): number => { const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error("UI_COUNTER_RANGE"); return n; };
const iso = (seconds: number | undefined) => seconds ? new Date(seconds * 1000).toISOString() : "";
function changedManifestPaths(base: SourceManifest, current: SourceManifest): string[] {
  const before = new Map(base.entries.map(entry => [entry.path, entry]));
  const after = new Map(current.entries.map(entry => [entry.path, entry]));
  return [...new Set([...before.keys(), ...after.keys()])].filter(path => {
    const old = before.get(path), next = after.get(path);
    return old?.mode !== next?.mode || old?.bytes !== next?.bytes || old?.digest !== next?.digest;
  }).sort();
}
const maxCounter = 18446744073709551615n;
const budgetCounter = (value: unknown): bigint | undefined => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= maxCounter ? BigInt(value) : undefined;
function projectReservationBudget(project: ProjectRecord): ProjectReservationBudget | undefined {
  const maximum = budgetCounter(project.maximumBudget), reserved = budgetCounter(project.reservedBudget), settled = budgetCounter(project.settledBudget);
  if (maximum === undefined || reserved === undefined || settled === undefined || reserved + settled > maximum) return undefined;
  return { maximumUnits: maximum.toString(), reservedUnits: reserved.toString(), settledUnits: settled.toString(),
    availableUnits: (maximum - reserved - settled).toString(), repairReservationUnits: PILOT_ATTEMPT_RESERVATION_UNITS,
    policyCapUnits: pilotBudgetPolicyCapUnits(project.scope) };
}

/** Checker diagnostics share the retained array with HTTP response observations. */
function isHttpObservation(value: unknown): value is Observation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (item.step === undefined || Number.isSafeInteger(item.step) && Number(item.step) >= 0)
    && typeof item.action === "string" && item.action.length > 0 && item.action.length <= 128
    && Number.isSafeInteger(item.status) && Number(item.status) >= 100 && Number(item.status) <= 599
    && typeof item.responseDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(item.responseDigest)
    && (item.storeReadCount === undefined || Number.isSafeInteger(item.storeReadCount) && Number(item.storeReadCount) >= 0)
    && [item.expected, item.observed].every(value => value === undefined || typeof value === "number" && Number.isFinite(value))
    && (item.expectedOneOf === undefined || Array.isArray(item.expectedOneOf) && item.expectedOneOf.length > 0
      && item.expectedOneOf.every(value => typeof value === "number" && Number.isFinite(value)))
    && (item.body === undefined || typeof item.body === "string");
}

/** Display projection of authoritative records. Its labels never authorize effects. */
export function uiSnapshot(read: AuthorityRead, capabilities: { pi: boolean; publication: boolean; maintenance?: boolean }): PlatformState {
  const project = read.project;
  const contextEvents = [...new Map([...(read.candidateRead?.events ?? []), ...read.events].map(event => [event.sequence, event])).values()].sort((a, b) => a.sequence - b.sequence);
  const projectBudget = projectReservationBudget(project);
  const admission: NonNullable<PlatformState["admission"]> = { gate: project.gate, reason: project.gate === "RECOVERY"
    ? "An unresolved publication requires reconciliation. New publication admission is blocked."
    : project.gate === "CLOSED" ? "The authority publication gate is closed. New publication admission is blocked."
    : !capabilities.publication ? "The authority gate is open, but conditional publication is disabled in this deployment."
    : "The authority gate is open. Publication still requires current applicable evidence, exact approval and no unresolved operation." };
  // Command events are keyed by command ID, not attempt ID. Bind their retained
  // result IDs to the admission time so the release span begins at the cohort
  // grant rather than a later execution observation.
  const attemptStart = new Map<string, string>();
  for (const row of contextEvents) {
    const event = JSON.parse(row.payload) as { kind?: string; time?: string; payload?: { id?: string; state?: string; attempts?: { id?: string }[] } };
    if (!event.time || !Number.isFinite(Date.parse(event.time))) continue;
    let ids: (string | undefined)[] = [];
    if (event.kind === "launch-cohort") ids = event.payload?.attempts?.map(item => item.id) ?? [];
    else if (event.kind === "create-attempt" || event.kind === "start-repair" || event.kind === "accept-proposal" && event.payload?.state === "REPAIR_RESERVED") ids = [event.payload?.id];
    for (const id of ids) if (typeof id === "string" && (!attemptStart.has(id) || Date.parse(event.time) < Date.parse(attemptStart.get(id)!))) attemptStart.set(id, event.time);
  }
  const eventTime = (objectId: string) => { const event = contextEvents.map(row => JSON.parse(row.payload) as { objectId: string; time?: string }).find(item => item.objectId === objectId); return event?.time ?? ""; };
  const attempts: Attempt[] = read.attempts.map(attempt => {
    const observed = read.runtime.filter(item => item.attemptId === attempt.id && item.generation === attempt.generation); const runtime = observed.filter(item => item.lifecycle === "STOPPED").at(-1) ?? observed.at(-1); const submission = read.submissions.find(item => item.attemptId === attempt.id);
    const workBaseManifest = read.sourceManifests[attempt.workBase] ?? (read.baseline.commit === attempt.workBase ? read.baseline.manifest : undefined);
    const outcome = runtime?.outcome;
    const terminalFailure = !submission && runtime?.lifecycle === "STOPPED" && outcome && outcome !== "COMPLETED" && outcome !== "PENDING";
    const role: Attempt["role"] = attempt.workBase !== attempt.publicationBase ? "repair" : attempt.allowedPaths?.includes("cache.mjs") ? "A" : attempt.allowedPaths?.includes("mutation.mjs") ? "B" : "C";
    return { id: attempt.id, name: role === "repair" ? "Repair · Keep the useful work" : role === "A" ? "A · Read acceleration" : role === "B" ? "B · Write simplification" : "C · Accessible saved status", role, mode: "pi",
      status: submission ? "SUBMITTED" : terminalFailure ? outcome : runtime?.lifecycle === "STOPPED" && outcome === "COMPLETED" ? "INGESTION_PENDING" : runtime?.lifecycle ?? "PROVISIONING", assigned: attempt.assignment ?? "", workBase: attempt.workBase, publicationBase: attempt.publicationBase,
      ...(runtime ? { executionLifecycle: runtime.lifecycle, executionOutcome: runtime.outcome,
        observed: `Execution ${runtime.lifecycle.toLowerCase().replaceAll('_', ' ')}; outcome ${runtime.outcome.toLowerCase().replaceAll('_', ' ')}.${submission ? ' Immutable source submitted.' : terminalFailure ? ' No immutable submission was accepted. The runtime outcome alone does not identify a model or provider fault.' : outcome === 'COMPLETED' ? ' Source ingestion is pending.' : ' No completed source observation yet.'}`,
        ...(terminalFailure ? { error: outcome === 'BUDGET_EXHAUSTED' ? 'This attempt exhausted its reserved budget before submitting source.' : 'This attempt stopped before submitting source. Its cause is not available in the public snapshot.' } : {}) } : {}),
      generation: numeric(attempt.generation), grantId: attempt.grantId, allowedPaths: attempt.allowedPaths ?? [], ...(attemptStart.has(attempt.id) ? { startedAt: attemptStart.get(attempt.id)! } : {}), ...(attempt.readOnlyContextPaths?.length ? { readOnlyContextPaths: attempt.readOnlyContextPaths } : {}), ...(submission ? { submissionId: submission.id, commit: submission.source.commit } : {}),
      ...(submission && workBaseManifest ? { changedPaths: changedManifestPaths(workBaseManifest, submission.source.manifest) } : {}), terminationObserved: runtime?.lifecycle === "STOPPED" };
  });
  const rawEvidence = read.evidence as AdmissionEvidence[];
  const evidence: Evidence[] = rawEvidence.map(item => {
    const observation = read.observations[item.digest] ?? read.observations[item.id] ?? {}; const plan = read.plans.find(plan => plan.jobs.some(job => job.id === item.jobId));
    const retained: unknown[] = Array.isArray(observation.observations) ? observation.observations : [];
    const observations = retained.filter(isHttpObservation), diagnostics = retained.filter(value => !isHttpObservation(value));
    return { id: item.id, candidateId: item.candidateId, evaluationId: plan ? read.evaluationIds[plan.digest]! : "", jobId: item.jobId, evaluationInputDigest: item.inputDigest,
      checkerClass: "external-behavioural", checkerId: "protected-http-harness-v1", environmentDigest: typeof observation.environmentDigest === 'string' ? observation.environmentDigest : "", fixtureDigest: typeof observation.fixtureDigest === 'string' ? observation.fixtureDigest : "", outcome: item.outcome, observations,
      ...(diagnostics.length ? { diagnostics } : {}), storeReadCount: observations.at(-1)?.storeReadCount, startedAt: iso(typeof observation.startedAt === 'number' ? observation.startedAt : undefined), completedAt: iso(typeof observation.completedAt === "number" ? observation.completedAt : undefined), digest: item.digest, observationDigest: item.observationDigest, envelope: null,
      limitations: ["A registered checker signed this exact observation. Full input identities are retained in the finite plan and portable bundle.", "Finite declared traces do not establish general correctness."], ...(typeof observation.error === "string" ? { error: observation.error } : {}) };
  });
  const evaluations: Evaluation[] = read.plans.map(plan => {
    const results = plan.jobs.map(job => rawEvidence.find(item => item.jobId === job.id)); const all = results.every(Boolean);
    const retained = rawEvidence.filter(item => plan.jobs.some(job => job.id === item.jobId));
    const contradiction = new Set(retained.map(item => item.jobId)).size !== retained.length;
    const outcome: Outcome | undefined = retained.some(item => item.outcome === "FAIL") ? "FAIL" : contradiction ? "INCONCLUSIVE" : all ? results.every(item => item?.outcome === "PASS") ? "PASS" : "INCONCLUSIVE" : undefined;
    return { id: read.evaluationIds[plan.digest]!, candidateId: plan.candidateId, contract: plan.jobs.length === 1 ? "freshness-v1" : "retained-value-v1", planDigest: plan.digest,
      jobs: plan.jobs.map(job => ({ id: job.id, name: job.id.split(":").at(-1)!, required: job.required, checkerClass: "external-behavioural", candidateId: plan.candidateId, evaluationInputDigest: job.inputDigest, input: {}, status: rawEvidence.some(item => item.jobId === job.id) ? "SETTLED" : "PENDING" })),
      aggregation: "all-required-pass", status: all ? "SETTLED" : "RUNNING", ...(outcome ? { outcome } : {}), createdAt: eventTime(plan.candidateId) };
  });
  const convert = (record: CandidateRecord): Candidate => {
    const selected = record.contributorIds.map(id => read.submissions.find(submission => submission.id === id)).filter(Boolean);
    const attemptIds = selected.map(item => item!.attemptId); const member = attempts.filter(attempt => attemptIds.includes(attempt.id));
    // contributorIds includes inherited repairs. The current recipe identifies
    // the repair that was actually materialized into this successor.
    const directRepairs = record.recipe.flatMap(id => {
      const submission = read.submissions.find(item => item.id === id);
      const attempt = member.find(item => item.id === submission?.attemptId);
      return attempt?.role === "repair" ? [attempt] : [];
    });
    const repairAttempt = directRepairs.length === 1 ? directRepairs[0] : undefined;
    const failedSource = repairAttempt ? read.candidates.find(candidate => candidate.id !== record.id && candidate.commit === repairAttempt.workBase) : undefined;
    const checks = evaluations.filter(item => item.candidateId === record.id);
    const eligible = read.candidateRead?.incompleteIds.includes(record.id) ? [] : read.evaluations.filter(item => item.eligible).map(item => checks.find(check => check.id === item.id)).filter((item): item is Evaluation => Boolean(item));
    // A checker, goal or policy update can make every old evaluation ineligible
    // for release. Keep its observed outcome visible for diagnosis and repair;
    // only an eligible full evaluation may be selected for review below.
    const retained = read.evaluations.map(item => checks.find(check => check.id === item.id)).filter((item): item is Evaluation => Boolean(item));
    const displayed = eligible.find(item => item.contract === "retained-value-v1")
      ?? retained.find(item => item.contract === "retained-value-v1") ?? eligible[0] ?? retained[0];
    const changedPaths = changedManifestPaths(read.sourceManifests[record.parent] ?? read.baseline.manifest, record.source.manifest);
    // A Weft handoff contains exact working source without isolated attempt submissions.
    // Keep it out of the named baseline controls used by composition diagnostics.
    const weftRevision = record.recipe.length === 1 && /^weft:[a-f0-9]{64}$/.test(record.recipe[0]);
    return { id: record.id, name: weftRevision ? "Weft revision candidate" : record.contributorIds.length === 0 ? "Baseline" : member.some(item => item.role === "repair") ? "Value-preserving repair" : member.map(item => item.role).join(" + ") + (record.contributorIds.length === 1 ? " individually" : " composition"), digest: record.digest,
      commit: record.commit, commitBytesDigest: record.commitBytesDigest, manifestDigest: record.manifestDigest, manifest: { schemaVersion: 1, profile: "ascii-regular-v1", entries: record.source.manifest.entries.map(entry => ({ path: entry.path, mode: entry.mode, size: numeric(entry.bytes), digest: entry.digest, gitOid: "" })) },
      evaluationReadComplete: Boolean(read.candidateRead?.candidateIds.includes(record.id) && !read.candidateRead.incompleteIds.includes(record.id)),
      publicationBase: record.parent, attemptIds, submissionIds: record.contributorIds, composition: record.recipe, ...(failedSource ? { repairOf: failedSource.id } : {}), status: displayed?.outcome ?? "EVALUATING", ...(displayed?.outcome ? { outcome: displayed.outcome, outcomeProvenance: eligible.includes(displayed) ? "current" : "retained" } : {}), ...(eligible.find(item => item.jobs.length === FULL_RELEASE_JOB_COUNT && item.jobs.every(job => job.required)) ? { reviewEvaluationId: eligible.find(item => item.jobs.length === FULL_RELEASE_JOB_COUNT && item.jobs.every(job => job.required))!.id } : {}), evaluationIds: checks.map(item => item.id), createdAt: eventTime(record.id), changedPaths, sourceFiles: read.sourceFiles[record.commit] };
  };
  const candidates = read.candidates.map(convert);
  const diagnostic = read.candidates.find(item => item.recipe[0] === "controlled-A-plus-B");
  const reviewRecords = read.reviews as { id: string; proposal: import("../../packages/protocol/src/types").ReviewProposal; proposalDigest?: string }[];
  const reviews: Review[] = reviewRecords.map(review => {
    const approval = read.approvals.find(item => item.proposal_digest === review.proposalDigest);
    return { id: review.id, candidateId: review.proposal.candidateId, proposalDigest: review.proposalDigest ?? "", expectedHead: review.proposal.expectedHead, goalRevision: review.proposal.goalRevision, policyRevision: review.proposal.policyRevision,
      planDigest: review.proposal.planDigest, evidenceIds: evidence.filter(item => review.proposal.evidenceDigests.includes(item.digest)).map(item => item.id), observationRevision: numeric(review.proposal.observationRevision), expiresAt: iso(review.proposal.expiresAt), status: approval ? "APPROVED" : "PREPARED",
      ...(approval ? { approval: { principal: approval.reviewer, approvedAt: "", ...(approval.consumed_by ? { consumedBy: approval.consumed_by } : {}) } } : {}) };
  });
  const publications: Publication[] = read.publications.map(item => ({ id: item.id, candidateId: item.candidateId, proposalDigest: item.proposalDigest, oldHead: item.oldHead, newHead: item.newHead,
    status: item.phase === "FINALIZED" ? "PUBLISHED" : item.phase, admittedAt: iso(item.witness.now), confirmedAt: iso(item.observationTime), dispatchCount: item.dispatchAttemptIds.length, ...(item.reason ? { recoveryReason: item.reason } : {}), admissionWitness: item.witness }));
  const receipts: Receipt[] = (read.receipts as { logical: LogicalReceipt; envelope: unknown }[]).map(item => ({ id: item.logical.operationId, sequence: numeric(item.logical.sequence), candidateId: read.publications.find(publication => publication.id === item.logical.operationId)?.candidateId ?? "", publicationId: item.logical.operationId,
    digest: read.publications.find(publication => publication.id === item.logical.operationId)?.logicalDigest ?? "", logical: { ...item.logical }, envelope: item.envelope, createdAt: iso(read.publications.find(publication => publication.id === item.logical.operationId)?.observationTime) }));
  const attemptDeadline = new Map(read.attempts.map(attempt => [attempt.id, attempt.deadline]));
  const repairStarted = new Map<string, number>(), candidateReady = new Map<string, number>();
  for (const row of contextEvents) {
    const event = JSON.parse(row.payload) as { kind: string; objectId: string; payload?: { id?: string; state?: string } };
    if (event.kind === "start-repair" || event.kind === "accept-proposal" && event.payload?.state === "REPAIR_RESERVED") {
      if (event.payload?.id) repairStarted.set(event.payload.id, row.sequence);
    }
    if (event.kind === "candidate-ready") candidateReady.set(event.objectId, row.sequence);
  }
  const conflicts: Conflict[] = candidates.filter(candidate => candidate.attemptIds.length > 1 && candidate.id !== diagnostic?.id
    && (read.candidateRead?.retainedFailureIds.includes(candidate.id) || evidence.some(item => item.candidateId === candidate.id && item.outcome === "FAIL"))).map(candidate => {
    const failures = evidence.filter(item => item.candidateId === candidate.id && item.outcome === "FAIL");
    const fail = failures.find(item => item.jobId.endsWith(":warm-read-write-read"))
      ?? failures.find(item => item.observations.some(observation => observation.expected !== undefined && observation.observed !== observation.expected)) ?? failures[0];
    const controls = [candidates.find(item => item.name === "Baseline"), candidates.find(item => item.name === "A individually"), candidates.find(item => item.name === "B individually"), candidates.find(item => item.id === diagnostic?.id)];
    const rows = controls.map(control => { const check = evidence.find(item => item.candidateId === control?.id && item.jobId.endsWith(":warm-read-write-read")); return check && control ? { name: control.name, candidateId: control.id, evidenceId: check.id, outcome: check.outcome } : null; }).filter((row): row is NonNullable<typeof row> => row !== null);
    const source = read.candidates.find(item => item.id === candidate.id);
    const repair = attempts.filter(item => item.role === "repair" && item.workBase === source?.commit).sort((left, right) =>
      (attemptDeadline.get(left.id) ?? 0) - (attemptDeadline.get(right.id) ?? 0)
      || (repairStarted.get(left.id) ?? 0) - (repairStarted.get(right.id) ?? 0)
      || left.id.localeCompare(right.id)).at(-1);
    const repaired = repair ? candidates.filter(item => item.attemptIds.includes(repair.id)).sort((left, right) =>
      (candidateReady.get(left.id) ?? 0) - (candidateReady.get(right.id) ?? 0) || left.id.localeCompare(right.id)).at(-1) : undefined;
    const repairedFull = repaired && evaluations.find(item => item.id === repaired.reviewEvaluationId && item.candidateId === repaired.id
      && item.contract === "retained-value-v1" && item.jobs.length === FULL_RELEASE_JOB_COUNT && item.jobs.every(job => job.required));
    const repairedFailure = repaired && (read.candidateRead?.retainedFailureIds.includes(repaired.id) || evidence.some(item => item.candidateId === repaired.id && item.outcome === "FAIL"));
    const repairStatus = repairedFull?.outcome === "PASS" && !repairedFailure ? "RESOLVED"
      : repaired?.outcome === "PASS" && repairedFailure ? "REPAIR_CONTRADICTED"
      : repaired?.outcome && repaired.outcome !== "PASS" ? `REPAIR_${repaired.outcome}`
      : repaired ? "REPAIR_CHECKS_PENDING"
      : repair?.terminationObserved && !repair.submissionId && repair.executionOutcome && repair.executionOutcome !== "COMPLETED" && repair.executionOutcome !== "PENDING" ? `REPAIR_${repair.executionOutcome}` : repair ? "REPAIRING" : "OPEN";
    return { id: `conflict-${candidate.id}`, candidateId: candidate.id, attemptIds: candidate.attemptIds, category: "behavioural-interaction", status: repairStatus, ...(repair ? { repairAttemptId: repair.id } : {}), ...(repaired ? { repairCandidateId: repaired.id } : {}), summary: "The composition failed a registered behavioural trace.", evidenceIds: fail ? [fail.id] : [], counterexample: fail?.observations,
      ...(!candidate.repairOf && rows.length === 4 ? { witness: { rows, contrast: rows[3]!.outcome === "FAIL" && rows.slice(0, 3).every(row => row.outcome === "PASS") ? 1 : 0, scope: "Controlled baseline, A, B and A+B snapshots checked with fresh external fixtures. The selected candidate is tracked separately." } } : {}) };
  });
  const latest = read.events.map(row => JSON.parse(row.payload) as { kind: string; objectId: string }).reverse().find(event => event.kind === "candidate-ready" && event.objectId !== diagnostic?.id && (!event.objectId.endsWith("-individual") || candidates.find(candidate => candidate.id === event.objectId)?.attemptIds.some(id => attempts.find(attempt => attempt.id === id)?.role === "repair")));
  const activeCandidateId = read.candidateRead ? read.candidateRead.currentId : latest?.objectId;
  return { schemaVersion: 1, projectId: project.scope.projectId, projectIncarnation: project.scope.projectIncarnation, tenantId: project.scope.tenantId, revision: numeric(project.revision), observationRevision: numeric(project.observationRevision), acceptedHead: project.head, enrollmentDigest: project.enrollmentDigest,
    goal: { id: project.goalRevision, revision: project.goalRevision, title: "Keep writes fresh. Preserve useful work.", description: "Deliver fresh acknowledged values, useful repeated-read caching and an accessible saved-value status.", constraints: ["Protected traces use fresh evaluation containers and an external backing store", "Exact human approval is required before canonical publication"], contracts: ["freshness-v1", "retained-value-v1"], budget: { authoringSeconds: 600, evaluationSeconds: 300 } },
    attempts, candidates, evaluations, evidence, conflicts, capsules: read.capsules.map(capsule => ({ id: capsule.id, attemptId: capsule.attemptId, digest: capsule.digest, sourceCommit: capsule.sourceCommit, sourceManifestDigest: capsule.sourceManifestDigest, goalRevision: capsule.goalRevision, adapter: capsule.adapter, generation: numeric(capsule.generation), selectorVersion: capsule.selectorVersion, sessionDigest: capsule.sessionDigest ?? "", renderedContextDigest: capsule.renderedContextDigest, selectedItems: capsule.selectedItems, missingTail: capsule.missingSessionTail, limitations: ["Host-rendered outer prompt bytes are retained separately from the agent-reported SDK session.", "Source and conversation are associated without an atomic live snapshot.", ...(capsule.missingSessionTail ? ["The session tail is missing or could not be validated."] : [])] })), reviews, publications, receipts, commands: [], events: read.events.map(row => { const event = JSON.parse(row.payload) as { id: string; kind: string; objectId: string; time?: string }; return { id: event.id, sequence: row.sequence, time: event.time ?? "", type: event.kind, message: event.kind.replace(/-/g, " "), objectId: event.objectId }; }),
    ...(activeCandidateId ? { activeCandidateId } : {}), demoStatus: attempts.length ? "ACTIVE" : "READY", demoMode: "pi", admission,
    ...(projectBudget ? { projectBudget } : {}),
    capabilities: { scripted: false, pi: capabilities.pi, piReason: capabilities.maintenance ? "Maintenance mode is read-only." : capabilities.pi ? "" : "Configure a provider model, immutable authoring image and broker before starting Pi.", publication: capabilities.publication && project.gate === "OPEN", deployment: true, ...(capabilities.maintenance !== undefined ? { maintenance: capabilities.maintenance } : {}) },
    limitations: ["Cloudflare closed pilot. Provider runtime gates remain separate from packaging checks.", "Text source previews are capped at 128 KiB per snapshot; portable bundles retain verified objects.", ...(read.candidateRead?.incompleteIds.length ? [`Candidate view exceeds its bounded plan/evidence profile; review is unavailable for: ${read.candidateRead.incompleteIds.join(', ')}.`] : [])], gates: [
      { name: "Conditional Artifacts publication", status: capabilities.publication ? "configured" : "unverified", detail: capabilities.publication ? "Conditional publication is enabled by deployment configuration. This flag is not a current provider health check." : "Conditional publication is disabled in this deployment. Required provider and binding evidence must be retained before enabling it." },
      { name: "Authority publication admission", status: admission.gate, detail: admission.reason! },
    ] };
}
