// SPDX-License-Identifier: Apache-2.0
import type { ImportedSourceRequest } from '../../packages/project-model/src/types';
import { DurableObject } from "cloudflare:workers";
import { createHash, timingSafeEqual } from "node:crypto";
import { canonicalize, containsTypeScriptSource, decodeBase64, digest, dssePAE, encodeBase64, evaluateAdmission, getKernel, signStatement, statement, verifyAttestation, verifyBundle, parseStrictJson } from "../../packages/protocol/src/index";
import type { AdmissionEvidence, AdmissionInput, CheckpointAttestation, Enrollment, Envelope, EvaluationPlan, LogicalReceipt, ReviewProposal, Scope, TrustConfig, VerificationBundle, IssuanceContext, TrustKey, SignerRole } from "../../packages/protocol/src/types";
import { ObjectStore, MAX_CONTROL_BYTES, MAX_MANIFEST_BYTES } from "../shared/objects";
import { sameViewCursor, type ViewCursor } from "../shared/view-cursor";
import { errorResponse, PlatformError, readBounded, requireValue } from "../shared/errors";
import { boundedServiceFetch, withinDeadline } from "../shared/deadline";
import { oldestAge } from "../shared/age";
import type { Principal } from "../shared/auth";
import { ArtifactsRepository, validateCanonicalRef } from "./artifacts";
import type { AttemptProposal, ContextCapsuleInput, ContextCapsuleRecord, AttemptRecord, AuthorityCommand, AuthorityEnv, AuthorityRead, CandidateRecord, EvaluationCallback, EvaluationContext, EvaluationRequest, GrantRecord, ProjectRecord, ProjectionEvent, PublicationRecord, PreparedPublicationDescriptor, TrustedCaller } from "./types";
import { AUTHORITY_SCHEMA } from "./schema";
import { initializeKernel } from "./kernel";
import { FULL_RELEASE_JOB_COUNT, makeEvaluationPlan, probes } from "../evaluator/recipes";
import { selectSessionContext, validatePartialSessionCapture } from "../../packages/protocol/src/session-context";
import { checkedTrust, currentSigner, prepareKeyLifecycle, signIssued, type LifecycleChange } from "./key-lifecycle";
import { authoringPrompt, promptSourceContext, sessionMetadata } from "../runner/context";
import { validateSourceAdvisory, SOURCE_ADVISORY_BYTES, type SourceAdvisory } from "../../packages/protocol/src/source-advisory";
import { advanceCleanup, verifyCleanupArchive as verifySourceArchive, type CleanupArchiveCursor, type CleanupRecord } from "./cleanup";
import { historyRequest, projectionEvent, replayBody, PROJECTION_PAGE_SIZE, PROJECTION_PAGE_BYTES, PROJECTION_EVENT_BYTES, type ProjectionHistoryRequest, type ProjectionHistoryPage, type ProjectionReplayRecord } from "../shared/projection";
import { previewSourceFiles } from "./source-preview";
import { invalidateMembershipApprovals, membershipAllows, membershipChange, requireRemainingAdmin, type MembershipState } from "./membership";
import { CollaborationStore, collaborationOperation } from "./collaboration";
import { PILOT_ATTEMPT_RESERVATION_UNITS, PILOT_BUDGET_POLICY_CAP_UNITS, pilotBudgetPolicyCapUnits } from "../shared/pilot-budget";
import { ProjectCatalog, PROJECT_CATALOG_SCHEMA } from './project-catalog';
import { ProjectDirectory } from './project-directory';
import { ProjectHubStore, type HubAgentCredentials } from './project-hub';
import { pinnedWeftDependency } from './pinned-dependency';
import type { WeftBinding, WeftHandoff, WeftWorkspaceView } from '../../packages/protocol/src/weft';
import { configuredWeftBinding, validateWeftSelection, verifyWeftProvenance, weftClient, weftJson, weftProxyPermission, parseWeftSync, parseWeftActivity } from './weft-bridge';
import { acquireWeftSource, persistWeftSource } from './weft-source';
import { parseProjectJson } from '../../packages/project-model/src/validation';
import { PROJECT_IMPORT_LIMITS, type CreateProjectCommand, type ProjectMetadataCommand } from '../../packages/project-model/src/types';
export { ProjectDirectory } from './project-directory';

import { assertPortableAdmission, assertPortableEndorsements, assertPortableIssued, portableBytes, PORTABLE_BUNDLE_BYTES, PORTABLE_HISTORY_LIMIT } from "./portable-profile";

type PreparedPortableInputs = Pick<VerificationBundle["inputs"], "gitObjects" | "observations"> & { candidateId: string; evidenceDigests: string[] };
type RepairCounterexample = { evidenceDigest: string; observationDigest: string; observation?: unknown };
const MODEL_CALL_ROSTER_LIMIT = 2048;
const CANDIDATE_VIEW_PLAN_LIMIT = 128;
const CANDIDATE_VIEW_EVIDENCE_LIMIT = 128;
// Two direct roots (current and explicitly selected) each retain the complete
// supported128-evidence profile before any repair ancestors use the remainder.
const CANDIDATE_VIEW_OBSERVATION_LIMIT = 256;
const CANDIDATE_VIEW_RECORD_BUDGET = 256;
const mergeBy = <T>(original: T[], extra: T[], key: (item: T) => string): T[] => [...new Map([...original, ...extra].map(item => [key(item), item])).values()];

/** Prefer the shortest public trace that shows a successful write followed by a stale value. */
const staleWriteStep = (observation: unknown): number => {
  if (!observation || typeof observation !== "object") return Number.MAX_SAFE_INTEGER;
  const rows = (observation as { observations?: unknown }).observations;
  if (!Array.isArray(rows)) return Number.MAX_SAFE_INTEGER;
  let acknowledgedWrite = false, step = 0;
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as { action?: unknown; status?: unknown; expected?: unknown; observed?: unknown };
    if (typeof row.action !== "string") continue;
    step++;
    if (["write", "write-later"].includes(row.action) && row.status === 200 && row.expected === row.observed) acknowledgedWrite = true;
    else if (acknowledgedWrite && ["read", "page"].includes(row.action) && row.status === 200 && Number.isSafeInteger(row.expected) && Number.isSafeInteger(row.observed) && row.expected !== row.observed) return step;
  }
  return Number.MAX_SAFE_INTEGER;
};
const compactRepairAssignment = (items: RepairCounterexample[], preferredDigest?: string): RepairCounterexample[] => {
  const selected = preferredDigest ?? items.filter(item => item.observation !== undefined).sort((left, right) => {
    const a = staleWriteStep(left.observation), b = staleWriteStep(right.observation);
    return a < b ? -1 : a > b ? 1 : left.evidenceDigest.localeCompare(right.evidenceDigest);
  })[0]?.evidenceDigest;
  return items.map(item => ({ evidenceDigest: item.evidenceDigest, observationDigest: item.observationDigest,
    ...(item.evidenceDigest === selected ? { observation: item.observation } : {}) }));
};

const now = () => Math.floor(Date.now() / 1000);
const selectedSession = (raw: Uint8Array, entry: string) => { try { return selectSessionContext(raw, entry); } catch { throw new PlatformError("CONTINUATION_SESSION_UNSUPPORTED", 409); } };
const bytes = (value: unknown) => new TextEncoder().encode(canonicalize(value));
const hash = (value: unknown) => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
const string = (value: unknown, code = "SCHEMA_ERROR"): string => { requireValue(typeof value === "string" && value.length > 0 && value.length <= 160, code); return value; };
const text = (value: unknown): string => { requireValue(typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= 32768, "TEXT_SIZE_LIMIT"); return value; };
const counter = (value: unknown): string => { const text = string(value); requireValue(/^(0|[1-9][0-9]{0,19})$/.test(text) && BigInt(text) <= 18446744073709551615n, "INVALID_COUNTER"); return text; };
// Each human-admin increase adds at most 400,000 aggregate admission units.
// Only the exact existing R2 incarnation has an audited step beyond 2,800,000.
const PILOT_BUDGET_STEP = BigInt(PILOT_ATTEMPT_RESERVATION_UNITS);
const PILOT_BUDGET_CAP = BigInt(PILOT_BUDGET_POLICY_CAP_UNITS);
const set = (value: unknown): string[] => { requireValue(Array.isArray(value) && value.length <= 128, "SCHEMA_ERROR"); const result = value.map(item => string(item)); requireValue(result.every((item, index) => !index || result[index - 1]! < item), "UNSORTED_SCOPE_SET"); return result; };
const registeredContracts = (value: unknown): string[] => { const result = set(value); requireValue(result.length > 0 && result.every(id => ["freshness-v1", "retained-value-v1"].includes(id)), "UNREGISTERED_CONTRACT"); return result; };
const tokenEqual = (supplied: string | null, expected: string): boolean => {
  if (!supplied || !expected) return false;
  const a = new TextEncoder().encode(supplied); const b = new TextEncoder().encode(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
};

import { ModelCallIndex } from './model-calls';
import { authorityCapacity, isNewAuthorityWork, requireAuthorityCapacity } from './capacity';
import { MODEL_CALL_FACT_BYTES, MODEL_CALL_PAGE_BYTES, MODEL_CALL_PAGE_LIMIT, type ModelCallFact } from '../shared/model-call';

export class ProjectAuthority extends DurableObject<AuthorityEnv> {
  private readonly objects: ObjectStore;
  private readonly modelCalls: ModelCallIndex;
  private readonly repository: ArtifactsRepository;
  private readonly collaborators: CollaborationStore;
  private readonly catalog: ProjectCatalog;
  private readonly hub: ProjectHubStore;
  constructor(ctx: DurableObjectState, env: AuthorityEnv) {
    super(ctx, env);
    this.objects = new ObjectStore(env.OBJECTS); this.repository = new ArtifactsRepository(env.ARTIFACTS, this.objects);
    this.modelCalls = new ModelCallIndex(ctx.storage.sql, this.objects, () => this.project().scope);
    this.collaborators = new CollaborationStore(ctx.storage.sql, grant => this.effect(crypto.randomUUID(), "stop-attempt", { scope: this.project().scope, attemptId: grant.attempt_id, generation: grant.generation }));
    this.catalog = new ProjectCatalog(ctx, env, this.collaborators);
    this.hub = new ProjectHubStore(ctx.storage, {
      authorizeHuman: (caller, operation) => this.catalog.hubContext(caller, operation === 'connect' ? 'connect' : operation === 'read' ? 'read' : 'edit'),
      authorizeMember: (parent, operation) => this.catalog.hubDelegatedContext(parent, operation === 'post' ? 'edit' : 'read'),
    });
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(AUTHORITY_SCHEMA + PROJECT_CATALOG_SCHEMA);
      // Existing SQLite objects keep their original rows. Do not assign a
      // migration-time age to work whose enqueue time was never recorded.
      if (!this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(outbox)').toArray().some(column => column.name === 'created_at_ms'))
        this.ctx.storage.sql.exec('ALTER TABLE outbox ADD COLUMN created_at_ms INTEGER CHECK(created_at_ms IS NULL OR created_at_ms >= 0)');
      this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS outbox_pending_age ON outbox(created_at_ms) WHERE state='PENDING'");
      await initializeKernel();
      // A committed outbox survives a crash before the caller could setAlarm().
      // Never redispatch a possibly applied publication during restart recovery.
      for (const row of this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM publications WHERE unresolved=1").toArray()) {
        const id = `restart-reconcile-${row.id}`; this.effect(id, "reconcile", { publicationId: row.id }); this.ctx.storage.sql.exec("UPDATE outbox SET state='PENDING' WHERE id=?", id);
      }
      if (this.row("SELECT id FROM outbox WHERE state='PENDING' LIMIT 1")) await this.ctx.storage.setAlarm(Date.now() + 100);
      else { const next = this.row<{ expiry: number | null }>("SELECT MIN(expires_at) AS expiry FROM grants WHERE revoked=0"); if (next?.expiry) await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, next.expiry * 1000)); }
    });
  }
  private row<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(sql: string, ...bindings: SqlStorageValue[]): T | null { return this.ctx.storage.sql.exec<T>(sql, ...bindings).toArray()[0] ?? null; }
  private project(): ProjectRecord { const row = this.row<{ payload: string }>("SELECT payload FROM project WHERE singleton=1"); requireValue(row, "PROJECT_UNAVAILABLE", 404); return JSON.parse(row.payload) as ProjectRecord; }
  private record<T>(kind: string, id: string): T { const row = this.row<{ payload: string }>("SELECT payload FROM records WHERE kind=? AND id=?", kind, id); requireValue(row, "REFERENCE_UNAVAILABLE", 404); return JSON.parse(row.payload) as T; }
  private trust(project = this.project()): TrustConfig { return this.record<TrustConfig>("trust", project.keysetRevision ?? "current"); }
  private enrollmentRecord(project: ProjectRecord): Enrollment { const predicate = (JSON.parse(new TextDecoder().decode(decodeBase64(project.enrollment.payload))) as { predicate: Enrollment | { record: Enrollment } }).predicate; return "record" in predicate ? predicate.record : predicate; }
  private records<T>(kind: string): T[] { return this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM records WHERE kind=? ORDER BY id LIMIT 2048", kind).toArray().map(row => JSON.parse(row.payload) as T); }
  private cleanups(): CleanupRecord[] { return this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM cleanups ORDER BY id LIMIT 2048").toArray().map(row => JSON.parse(row.payload) as CleanupRecord); }
  private retain(kind: string, id: string, value: unknown): void {
    const payload = canonicalize(value); requireValue(new TextEncoder().encode(payload).length <= MAX_CONTROL_BYTES, "CONTROL_RECORD_LIMIT", 413);
    const digest = hash(value); const previous = this.row<{ digest: string }>("SELECT digest FROM records WHERE kind=? AND id=?", kind, id);
    requireValue(!previous || previous.digest === digest, "IMMUTABLE_IDENTITY_CONFLICT", 409);
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO records(kind,id,digest,payload) VALUES(?,?,?,?)", kind, id, digest, payload);
  }
  private retainedEvidence(candidateId?: string): AdmissionEvidence[] {
    // Admission must not silently omit a failure behind a project-wide page.
    // Fetch one beyond the kernel ceiling so excess evidence fails closed.
    const primary = candidateId ? this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM evidence WHERE json_extract(payload,'$.candidateId')=? ORDER BY job_id LIMIT 129", candidateId) : this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM evidence ORDER BY job_id LIMIT 512");
    const contradictions = candidateId ? this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM records WHERE kind='evidence-contradiction' AND json_extract(payload,'$.candidateId')=? ORDER BY id LIMIT 129", candidateId).toArray().map(row => JSON.parse(row.payload) as AdmissionEvidence) : this.records<AdmissionEvidence>("evidence-contradiction");
    return [...primary.toArray().map(row => JSON.parse(row.payload) as AdmissionEvidence), ...contradictions];
  }
  private evaluationContext(project: ProjectRecord, id: string): EvaluationContext {
    const goal = this.row<{ payload: string }>("SELECT payload FROM records WHERE kind='goal' AND id=?", project.goalRevision);
    const policy = this.row<{ payload: string }>("SELECT payload FROM records WHERE kind='policy' AND id=?", project.policyRevision);
    return { schemaVersion: 1, id, goalRevision: project.goalRevision, policyRevision: project.policyRevision, contractBundleDigest: hash({ schemaVersion: 1, scope: project.scope, goal: goal ? JSON.parse(goal.payload) : { revision: "1", contracts: ["freshness-v1", "retained-value-v1"] }, policy: policy ? JSON.parse(policy.payload) : { revision: "1", contracts: ["freshness-v1", "retained-value-v1"] }, checker: this.env.CHECKER_IMPLEMENTATION_DIGEST }) };
  }
  private registerEvaluation(project: ProjectRecord, evaluation: EvaluationContext, plan: EvaluationPlan, candidate: CandidateRecord): void {
    requireValue(evaluation.goalRevision === project.goalRevision && evaluation.policyRevision === project.policyRevision && evaluation.contractBundleDigest === this.evaluationContext(project, evaluation.id).contractBundleDigest, "EVALUATION_POLICY_CHANGED", 409);
    this.retain("plan", evaluation.id, plan); this.retain("evaluation", evaluation.id, { ...evaluation, planDigest: plan.digest, authorityRevision: project.revision });
    const trust = this.trust(project); currentSigner(trust, this.env.CHECKER_KEY_ID, "checker");
    const issuance: IssuanceContext = { schemaVersion: 1, scope: project.scope, authorityRevision: project.revision, signerKeysetRevision: trust.keysetRevision };
    for (const job of plan.jobs) {
      const probe = probes.find(item => job.id === `${evaluation.id}:${item.id}`); requireValue(probe, "UNREGISTERED_JOB");
      this.retain("evaluation-job", job.id, { evaluationId: evaluation.id, candidateId: candidate.id, inputDigest: job.inputDigest, audit: probe.audit, issuance, checkerKeyId: this.env.CHECKER_KEY_ID });
      this.effect(job.id, "evaluate", { scope: project.scope, issuance, checkerKeyId: this.env.CHECKER_KEY_ID, evaluation, plan, candidate, source: candidate.source, job } satisfies EvaluationRequest);
    }
  }
  private retainedEndorsement(recordDigest: string, envelopeDigest: string): string | null {
    const retained = [...this.records<{ logicalDigest?: string; recordDigest?: string; envelope: Envelope; envelopeDigest: string }>("publication-endorsement"), ...this.records<{ logicalDigest?: string; recordDigest?: string; envelope: Envelope; envelopeDigest: string }>("attestation-endorsement")].find(item => (item.logicalDigest ?? item.recordDigest) === recordDigest && hash(item.envelope) === envelopeDigest);
    return retained ? envelopeDigest.slice(7) : null;
  }
  private endorsementCount(recordDigest: string): number { return new Set([...this.records<{ logicalDigest: string; envelope: Envelope }>("publication-endorsement").filter(item => item.logicalDigest === recordDigest), ...this.records<{ recordDigest: string; envelope: Envelope }>("attestation-endorsement").filter(item => item.recordDigest === recordDigest)].map(item => hash(item.envelope))).size; }
  private endorsementTarget(kind: string, id: unknown, project = this.project()): { record: unknown; authorityRevision: string; publicationId: string | null } {
    if (kind === "enrollment") return { record: this.enrollmentRecord(project), authorityRevision: "1", publicationId: null };
    if (kind === "evidence") {
      const evidence = this.retainedEvidence().find(item => item.digest === id); requireValue(evidence, "REFERENCE_UNAVAILABLE", 404);
      const registration = this.record<{ evaluationId: string; issuance?: IssuanceContext }>("evaluation-job", evidence.jobId); const historical = registration.issuance?.authorityRevision ?? this.record<{ authorityRevision: string }>("evaluation", registration.evaluationId).authorityRevision; requireValue(historical, "EVIDENCE_REVISION_UNAVAILABLE", 409);
      return { record: evidence, authorityRevision: historical, publicationId: null };
    }
    requireValue(kind === "admission" || kind === "publication", "ENDORSEMENT_KIND_UNSUPPORTED"); const publication = this.publication(string(id));
    if (kind === "publication") { requireValue(publication.phase === "FINALIZED" && publication.logical && publication.logical.authorityRevision, "RECEIPT_REVISION_UNAVAILABLE", 409); return { record: publication.logical, authorityRevision: publication.logical.authorityRevision, publicationId: publication.id }; }
    requireValue(publication.admission, "ADMISSION_NOT_SIGNED", 409); const predicate = JSON.parse(new TextDecoder().decode(decodeBase64(publication.admission.payload))).predicate; return { record: predicate.schemaVersion === 2 ? predicate.record : predicate, authorityRevision: publication.witness.state.revision, publicationId: publication.id };
  }
  private assertAttestationAuthorized(kind: "enrollment" | "evidence" | "admission", record: unknown, envelope: Envelope, project = this.project()): void {
    const role = kind === "enrollment" ? "root" : kind === "evidence" ? "checker" : "authority"; const trust = this.trust(project);
    const valid = (candidate: Envelope) => { const result = verifyAttestation({ trust, envelope: candidate, kind, role, allowLegacy: true, sequence: kind === "enrollment" ? "0" : kind === "admission" ? (record as { sequence: string }).sequence : (BigInt(project.publicationSequence) + 1n).toString() }); return result.valid && canonicalize(result.record) === canonicalize(record); };
    requireValue(valid(envelope) || this.records<{ recordDigest: string; envelope: Envelope }>("attestation-endorsement").some(item => item.recordDigest === hash(record) && valid(item.envelope)), "ATTESTATION_AUTHORIZATION_REVOKED", 409);
  }
  private publicFailures(candidateId: string): AdmissionEvidence[] {
    return this.retainedEvidence(candidateId).filter(item => item.outcome === "FAIL" && this.record<{ audit: boolean }>("evaluation-job", item.jobId).audit === false);
  }
  private concurrencyFailure(candidateId: string): AdmissionEvidence | undefined {
    return this.publicFailures(candidateId).find(item => item.jobId.endsWith(":overlapping-read-write"));
  }
  private assertEvaluationCurrent(project: ProjectRecord, id: string): void {
    const evaluation = this.record<EvaluationContext>("evaluation", id);
    requireValue(evaluation.goalRevision === project.goalRevision && evaluation.policyRevision === project.policyRevision && evaluation.contractBundleDigest === this.evaluationContext(project, id).contractBundleDigest, "STALE_EVALUATION_POLICY", 409);
  }
  private assertReviewCurrent(project: ProjectRecord, review: { proposal: ReviewProposal; planId: string }): void {
    this.assertEvaluationCurrent(project, review.planId);
    const proposal = review.proposal;
    requireValue(canonicalize(proposal.scope) === canonicalize(project.scope) && proposal.expectedHead === project.head
      && proposal.goalRevision === project.goalRevision && proposal.policyRevision === project.policyRevision
      && proposal.observationRevision === project.observationRevision, "REVIEW_BOUND_STATE_CHANGED", 409);
  }
  private saveProject(project: ProjectRecord, priorRevision: string): void {
    const written = this.ctx.storage.sql.exec("UPDATE project SET revision=?,payload=? WHERE singleton=1 AND revision=?", project.revision, canonicalize(project), priorRevision).rowsWritten;
    requireValue(written === 1, "STALE_STATE", 409);
  }
  private roles(caller: TrustedCaller, project = this.project()): string[] {
    requireValue(caller.principal.tenantId === project.scope.tenantId && caller.projectId === project.scope.projectId, "PROJECT_UNAVAILABLE", 404);
    const row = this.row<{ roles: string; active: number }>("SELECT roles,active FROM memberships WHERE subject=?", caller.principal.id);
    requireValue(row?.active, "PROJECT_UNAVAILABLE", 404);
    this.collaborators.assertCaller(caller, project.scope, now());
    return JSON.parse(row.roles) as string[];
  }
  private role(caller: TrustedCaller, required: string): void {
    const project = this.project(), roles = this.roles(caller, project);
    if (this.collaborators.enabled(project.scope)) {
      if (required === "admin") { this.collaborators.requireOwner(caller, project.scope, now()); return; }
      requireValue(roles.includes(required), "SCOPE_DENIED", 403); return;
    }
    requireValue(roles.includes(required) || roles.includes("admin"), "SCOPE_DENIED", 403);
  }
  private weftBinding(): WeftBinding {
    const project = this.project(), binding = configuredWeftBinding(this.env.WEFT_CONNECTIONS, project.scope);
    requireValue(binding && binding.sourceRepo === project.canonicalRepo && binding.sourceRef === project.canonicalRef, "WEFT_PROJECT_NOT_CONNECTED", 409);
    return binding;
  }
  private weftPermission(caller: TrustedCaller, edit: boolean): void {
    this.role(caller, "reader");
    if (!edit) return;
    // Contributors and reviewers need an explicit bounded work grant in the
    // existing model. V1 exposes live edits only to sponsors/maintainers.
    this.role(caller, "sponsor");
    requireValue(!this.catalog.isArchived(), "PROJECT_ARCHIVED", 409);
    requireValue(this.env.MAINTENANCE_MODE !== "true", "MAINTENANCE_READ_ONLY", 503);
  }
  private weftHandoffId(caller: TrustedCaller, requestId: string): string {
    return hash({ scope: this.project().scope, submittedBy: caller.principal.id, requestId }).slice(7);
  }
  async weftHandoff(caller: TrustedCaller, requestId: string): Promise<WeftHandoff> {
    this.role(caller, "reader");
    requireValue(/^[a-zA-Z0-9_-]{1,128}$/.test(requestId), "INVALID_COMMAND_ID");
    return this.record<WeftHandoff>("weft-handoff", this.weftHandoffId(caller, requestId));
  }
  async weftWorkspace(caller: TrustedCaller): Promise<WeftWorkspaceView> {
    this.role(caller, "reader");
    const project = this.project(), binding = configuredWeftBinding(this.env.WEFT_CONNECTIONS, project.scope);
    const roles = this.roles(caller);
    const view: WeftWorkspaceView = { schemaVersion: 1, scope: project.scope, binding, canSubmit: !this.catalog.isArchived() && this.env.MAINTENANCE_MODE !== "true" && (roles.includes("sponsor") || !this.collaborators.enabled(project.scope) && roles.includes("admin")),
      observedAt: null, head: null, activity: [], conflicts: [], participants: null, replicas: null,
      handoffs: this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM records WHERE kind='weft-handoff' ORDER BY rowid DESC LIMIT 32").toArray().map(row => JSON.parse(row.payload)) };
    if (!binding) return view;
    this.weftBinding();
    try {
      const client = weftClient(this.env, binding), sync = parseWeftSync(await weftJson(client, "sync"));
      const selected = sync.head;
      await verifyWeftProvenance(await weftJson(client, `sync/revisions/${selected.revision}/provenance`), binding, selected);
      view.head = selected;
      view.conflicts = sync.conflicts;
      view.activity = parseWeftActivity(await weftJson(client, "state"));
      view.observedAt = new Date().toISOString();
    } catch (error) { view.error = error instanceof PlatformError ? error.code : "WEFT_SERVICE_UNAVAILABLE"; view.canSubmit = false; }
    this.role(caller, "reader");
    requireValue(canonicalize(configuredWeftBinding(this.env.WEFT_CONNECTIONS, this.project().scope)) === canonicalize(binding), "WEFT_BINDING_CHANGED", 409);
    return view;
  }
  async weftProxy(caller: TrustedCaller, input: { workspaceId: string; method: string; path: string; body?: unknown }): Promise<Response> {
    const permission = weftProxyPermission(input.method, input.path);
    this.weftPermission(caller, permission === "edit");
    const binding = this.weftBinding();
    requireValue(binding.workspaceId === input.workspaceId && binding.alternativeId === null, "WEFT_WORKSPACE_MISMATCH", 403);
    const control = weftClient(this.env, binding);
    const head = parseWeftSync(await weftJson(control, "sync")).head;
    await verifyWeftProvenance(await weftJson(control, `sync/revisions/${head.revision}/provenance`), binding, head);
    this.weftPermission(caller, permission === "edit");
    // Participant credentials never leave this authority. Every replica call
    // uses current Confidence authentication and membership, including retries.
    const actor = `confidence-${hash({ scope: binding.scope, actor: caller.principal.id }).slice(7, 55)}`;
    const credentialId = `${binding.id}/${actor}/${permission}`;
    let grant = this.row<{ payload: string }>("SELECT payload FROM records WHERE kind='weft-participant-credential' AND id=?", credentialId);
    if (!grant) {
      const issued = await weftJson(weftClient(this.env, binding), "invite", { id: actor, name: "Confidence participant", role: permission });
      requireValue(issued.id === actor && typeof issued.token === "string" && issued.token.length >= 32, "WEFT_CREDENTIAL_INVALID", 502);
      this.weftPermission(caller, permission === "edit");
      this.ctx.storage.transactionSync(() => {
        grant = this.row<{ payload: string }>("SELECT payload FROM records WHERE kind='weft-participant-credential' AND id=?", credentialId);
        if (!grant) { const value = { token: issued.token, actor }; this.retain("weft-participant-credential", credentialId, value); grant = { payload: canonicalize(value) }; }
      });
    }
    this.weftPermission(caller, permission === "edit");
    const response = await weftClient(this.env, binding, JSON.parse(grant!.payload).token, 60_000).fetch(input.path,
      { method: input.method, ...(input.method === "POST" ? { body: canonicalize(input.body) } : {}) });
    // Revocation cannot undo an already dispatched edit. It does prevent this
    // response or any subsequent request from disclosing project content.
    this.weftPermission(caller, permission === "edit");
    return response;
  }
  private updateWeftHandoff(handoff: WeftHandoff): void {
    this.ctx.storage.sql.exec("UPDATE records SET payload=?,digest=? WHERE kind='weft-handoff' AND id=?", canonicalize(handoff), hash(handoff), handoff.id);
  }
  private assertWeftSubmitter(handoff: WeftHandoff): void {
    const row = this.row<{ active: number; roles: string }>("SELECT active,roles FROM memberships WHERE subject=?", handoff.submittedBy);
    const enabled = this.collaborators.enabled(this.project().scope);
    const roles: string[] = row ? JSON.parse(row.roles) : [];
    requireValue(row?.active && (roles.includes("sponsor") || !enabled && roles.includes("admin")), "WEFT_SUBMITTER_REVOKED", 403);
    if (enabled) {
      const identity = this.row<{ session_cutoff: number }>("SELECT session_cutoff FROM verified_identities WHERE id=?", handoff.submittedBy);
      requireValue(identity && handoff.authenticationIssuedAt !== undefined && handoff.authenticationIssuedAt > identity.session_cutoff, "WEFT_SUBMITTER_SESSION_REVOKED", 403);
    }
  }
  private async freezeWeftHandoff(id: string): Promise<void> {
    let handoff = this.record<WeftHandoff>("weft-handoff", id);
    if (handoff.state === "READY" || handoff.state === "REJECTED") return;
    this.assertWeftSubmitter(handoff);
    requireValue(canonicalize(this.weftBinding()) === canonicalize(handoff.binding), "WEFT_BINDING_CHANGED", 409);
    requireValue(await this.repository.identity(handoff.binding.sourceRepo) === handoff.binding.sourceRepositoryId, "WEFT_REPOSITORY_IDENTITY_CHANGED", 409);
    if (handoff.state === "PENDING") {
      const client = weftClient(this.env, handoff.binding), path = `sync/revisions/${handoff.selected.revision}/provenance`;
      const provenance = await weftJson(client, path);
      await verifyWeftProvenance(provenance, handoff.binding, handoff.selected);
      const acquired = await acquireWeftSource(client, handoff.selected);
      const after = await weftJson(client, path);
      await verifyWeftProvenance(after, handoff.binding, handoff.selected);
      requireValue(canonicalize(after) === canonicalize(provenance), "WEFT_PROVENANCE_CHANGED", 409);
      const fixturePaths = ["cache.mjs", "mutation.mjs", "presentation.mjs", "server.mjs"];
      const base = this.record<import("./artifacts").RepositorySnapshot>("source", handoff.binding.sourceBase);
      requireValue(canonicalize(base.manifest.entries.map(entry => entry.path).sort()) === canonicalize(fixturePaths)
        && acquired.manifest.entries.every(entry => fixturePaths.includes(entry.path)), "WEFT_EXECUTION_PROFILE_UNSUPPORTED", 409);
      const persisted = await persistWeftSource(acquired, this.objects);
      const source = await this.repository.materialize(base, [{ id: handoff.id, source: acquired, base }], handoff.candidateId, handoff.admittedAt);
      requireValue(source.manifestDigest === acquired.manifestDigest, "WEFT_SOURCE_MAPPING_CHANGED", 409);
      const provenanceDigest = await this.objects.put(bytes(provenance));
      this.ctx.storage.transactionSync(() => {
        const current = this.record<WeftHandoff>("weft-handoff", id);
        if (current.state !== "PENDING") return;
        this.assertWeftSubmitter(current);
        this.retain("weft-frozen-source", id, { ...source, objects: [] });
        this.updateWeftHandoff({ ...current, state: "FROZEN", sourceCommit: source.commit, sourceManifestDigest: source.manifestDigest, mappingDigest: persisted.mappingDigest, provenanceDigest });
      });
      handoff = this.record<WeftHandoff>("weft-handoff", id);
    }
    if (handoff.state !== "FROZEN") return;
    const project = this.project(), source = this.record<import("./artifacts").RepositorySnapshot>("weft-frozen-source", id);
    const candidateBase = { scope: handoff.scope, id: handoff.candidateId, commit: source.commit, commitBytesDigest: source.commitBytesDigest,
      parent: handoff.binding.sourceBase, manifestDigest: source.manifestDigest, contributorIds: [] as string[], recipe: [`weft:${id}`] };
    const candidate: CandidateRecord = { ...candidateBase, digest: hash(candidateBase), source };
    const evaluation = this.evaluationContext(project, `${candidate.id}-evaluation`);
    const plan = await makeEvaluationPlan(candidate, this.env.EVALUATION_IMAGE_DIGEST, this.env.CHECKER_IMPLEMENTATION_DIGEST, "full", project.scope, evaluation);
    this.ctx.storage.transactionSync(() => {
      const state = this.project(), current = this.record<WeftHandoff>("weft-handoff", id);
      if (current.state === "READY") return;
      this.assertWeftSubmitter(current);
      requireValue(state.head === candidate.parent, "PUBLICATION_BASE_MOVED", 409);
      requireValue(state.policyRevision === handoff.policyRevision && state.goalRevision === handoff.goalRevision, "STALE_EVALUATION_POLICY", 409);
      this.retain("candidate", candidate.id, candidate); this.retain("source", source.commit, source);
      this.registerEvaluation(state, evaluation, plan, candidate);
      this.updateWeftHandoff({ ...current, state: "READY" });
      const revision = state.revision; state.revision = (BigInt(revision) + 1n).toString(); this.saveProject(state, revision);
      this.event(state, "candidate-ready", candidate.id, { commit: candidate.commit, manifestDigest: candidate.manifestDigest, weftHandoffId: id });
    });
  }
  async collaboration(caller: TrustedCaller): Promise<import("../../packages/protocol/src/collaboration").CollaborationView> {
    return this.catalog.collaborationView(caller);
  }
  async collaborationCommand(caller: TrustedCaller, command: AuthorityCommand): Promise<unknown> {
    requireValue(collaborationOperation(command.operation), "UNSUPPORTED_OPERATION", 400);
    if (command.operation === 'admit-join-request') requireValue(this.env.PROJECT_HUB_ENABLED === 'true', 'PROJECT_HUB_UNAVAILABLE', 404);
    if (this.catalog.isDraft()) return this.catalog.draftCollaborationCommand(caller, command);
    return this.command(caller, command);
  }
  async inspectInvitation(caller: TrustedCaller, command: AuthorityCommand): Promise<unknown> {
    return this.catalog.inspectInvitation(caller, command);
  }
  private effect(id: string, kind: string, payload: unknown): void { const prior = this.row<{ digest: string }>("SELECT digest FROM outbox WHERE id=?", id); requireValue(!prior || prior.digest === hash(payload), "OUTBOX_IDENTITY_CONFLICT", 409); this.ctx.storage.sql.exec("INSERT OR IGNORE INTO outbox(id,kind,digest,payload,state,created_at_ms) VALUES(?,?,?,?, 'PENDING',?)", id, kind, hash(payload), canonicalize(payload), Date.now()); }
  private event(project: ProjectRecord, kind: string, objectId: string, payload: unknown): void {
    const event = { id: crypto.randomUUID(), scope: project.scope, kind, objectId, payload, time: new Date().toISOString() };
    this.ctx.storage.sql.exec("INSERT INTO events(id,digest,payload) VALUES(?,?,?)", event.id, hash(event), canonicalize(event));
    const sequence = this.row<{ sequence: number }>("SELECT sequence FROM events WHERE id=?", event.id)!.sequence;
    let identity = { ...event, sequence };
    // Projection transport is a bounded view. The complete authority event is
    // retained above; large records get an explicit reference, never truncation.
    if (bytes({ ...identity, digest: hash(identity) }).length > PROJECTION_EVENT_BYTES) identity = { ...identity, payload: { schemaVersion: 1, projection: "AUTHORITY_EVENT_REFERENCE", eventId: event.id, eventDigest: hash(event), payloadDigest: hash(payload), payloadBytes: bytes(payload).length } };
    const projected = { ...identity, digest: hash(identity) }; projectionEvent(projected);
    this.effect(event.id, "projection", projected);
  }
  private projectionPage(scope: Scope, afterSequence: number, throughSequence: number): ProjectionEvent[] {
    const rows = this.ctx.storage.sql.exec<{ payload: string }>("SELECT o.payload FROM events e JOIN outbox o ON o.id=e.id WHERE o.kind='projection' AND e.sequence>? AND e.sequence<=? ORDER BY e.sequence LIMIT ?", afterSequence, throughSequence, PROJECTION_PAGE_SIZE).toArray();
    const events: ProjectionEvent[] = []; let size = 1024;
    for (const row of rows) {
      const event = JSON.parse(row.payload); projectionEvent(event);
      const { digest: expected, ...identity } = event;
      requireValue(event.sequence === afterSequence + events.length + 1 && canonicalize(event.scope) === canonicalize(scope) && hash(identity) === expected, "PROJECTION_RETAINED_HISTORY_INVALID", 409);
      const length = new TextEncoder().encode(row.payload).length;
      if (size + length > PROJECTION_PAGE_BYTES) break;
      size += length; events.push(event);
    }
    requireValue(afterSequence === throughSequence || events.length > 0, "PROJECTION_HISTORY_UNAVAILABLE", 409);
    return events;
  }
  async projectionHistory(request: ProjectionHistoryRequest): Promise<ProjectionHistoryPage> {
    historyRequest(request); const project = this.project();
    requireValue(canonicalize(request.scope) === canonicalize(project.scope) && request.scope.tenantId === this.env.AUTH_TENANT_ID, "PROJECTION_SCOPE_CHANGED", 409);
    const original = this.row<{ payload: string; sequence: number; event_payload: string }>("SELECT o.payload,e.sequence,e.payload AS event_payload FROM outbox o JOIN events e ON e.id=o.id WHERE o.kind='projection' AND o.id=?", request.target.id);
    requireValue(original, "PROJECTION_TARGET_UNAVAILABLE", 404); const target = JSON.parse(original.payload); projectionEvent(target);
    const { digest: targetDigest, ...targetIdentity } = target;
    requireValue(hash(targetIdentity) === targetDigest && target.digest === request.target.digest && target.sequence === request.target.sequence && target.sequence === original.sequence && canonicalize(target.scope) === canonicalize(project.scope) && canonicalize(JSON.parse(original.event_payload).scope) === canonicalize(project.scope), "PROJECTION_TARGET_MISMATCH", 409);
    const events = this.projectionPage(project.scope, request.afterSequence, request.throughSequence);
    const nextSequence = events.at(-1)?.sequence ?? request.afterSequence;
    return { ...request, events, nextSequence, complete: nextSequence === request.throughSequence };
  }
  async attemptContext(caller: TrustedCaller, request: { attemptId: string; generation: string; evidenceDigests?: string[] }): Promise<unknown> {
    const project = this.project(); this.roles(caller, project); const attempt = this.record<AttemptRecord>("attempt", string(request.attemptId)); requireValue(request.generation === attempt.generation, "GRANT_GENERATION_FENCED", 403);
    const grant = this.checkGrant(project, attempt, caller.principal.id, "read-source", null, "0");
    const source = this.record<import("./artifacts").RepositorySnapshot>("source", attempt.workBase);
    const { editableSource: assignedSource, readOnlySource } = await promptSourceContext(attempt, source.manifest, (digest, maximumBytes) => this.objects.get(digest, maximumBytes));
    const selected = set(request.evidenceDigests ?? []); requireValue(selected.length <= 8, "CONTEXT_REFERENCE_LIMIT"); const evidence: unknown[] = []; let observationBytes = 0;
    if (selected.length) this.checkGrant(project, attempt, caller.principal.id, "read-evidence", null, "0");
    for (const evidenceDigest of selected) {
      const item = this.retainedEvidence().find(item => item.digest === evidenceDigest); requireValue(item, "REFERENCE_UNAVAILABLE", 404); const registered = this.record<{ audit: boolean }>("evaluation-job", item.jobId); const candidate = this.record<CandidateRecord>("candidate", item.candidateId);
      requireValue(registered.audit === false && (candidate.contributorIds.some(id => this.record<{ attemptId: string }>("submission", id).attemptId === attempt.id) || grant.resources.includes(candidate.id)), "CONTEXT_REFERENCE_DENIED", 403);
      const raw = await this.objects.get(item.observationDigest, MAX_CONTROL_BYTES); observationBytes += raw.length; requireValue(observationBytes <= 16384, "PUBLIC_CONTEXT_LIMIT", 413);
      evidence.push({ evidence: item, observation: JSON.parse(getKernel().canonical_json(new TextDecoder("utf-8", { fatal: true }).decode(raw))), producer: "registered-checker", trustClass: "public-checker-observation" });
    }
    const current = this.project(); this.roles(caller, current); this.checkGrant(current, attempt, caller.principal.id, "read-source", null, "0"); if (selected.length) this.checkGrant(current, attempt, caller.principal.id, "read-evidence", null, "0");
    return { scope: project.scope, revision: current.revision, attemptId: attempt.id, generation: attempt.generation, goalRevision: attempt.goalRevision, sourceCommit: source.commit, sourceManifestDigest: source.manifestDigest, assignedSource, ...(Object.keys(readOnlySource).length ? { readOnlySource } : {}), evidence };
  }
  async candidateSource(caller: TrustedCaller, candidateId: string, version: "candidate" | "base"): Promise<unknown> {
    const project = this.project(); this.role(caller, "reader");
    requireValue(version === "candidate" || version === "base", "SOURCE_VERSION_INVALID");
    const candidate = this.record<CandidateRecord>("candidate", string(candidateId));
    const retained = version === "candidate" ? candidate.source : this.record<import("./artifacts").RepositorySnapshot>("source", candidate.parent);
    const objects = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(await withinDeadline(() => this.objects.get(retained.objectsDigest, 8 * 1024 * 1024), 5000))) as import("../../packages/protocol/src/types").GitObject[];
    const source = { ...retained, objects };
    requireValue(source.commit === (version === "candidate" ? candidate.commit : candidate.parent), "SOURCE_IDENTITY_MISMATCH", 409);
    if (version === "candidate") requireValue(source.manifestDigest === candidate.manifestDigest && source.commitBytesDigest === candidate.commitBytesDigest, "SOURCE_IDENTITY_MISMATCH", 409);
    const checked = JSON.parse(getKernel().validate_git_source(canonicalize({ candidate: { id: candidate.id, digest: candidate.digest, commit: source.commit, commitBytesDigest: source.commitBytesDigest, parent: source.parent ?? "", manifestDigest: source.manifestDigest }, manifest: source.manifest, gitObjects: source.objects }))) as { valid: boolean; reason: string };
    requireValue(checked.valid, checked.reason, 409);
    const result = { schemaVersion: 1, scope: project.scope, candidateId: candidate.id, candidateDigest: candidate.digest, version, source };
    // Match the bytes emitted by Response.json and the application/browser
    // transport caps. An export that cannot traverse those caps is not reviewable.
    requireValue(new TextEncoder().encode(JSON.stringify(result)).length <= 8 * 1024 * 1024, "SOURCE_VIEW_LIMIT", 413);
    this.role(caller, "reader");
    requireValue(canonicalize(this.project().scope) === canonicalize(project.scope), "PROJECT_INCAR_CHANGED", 409);
    return result;
  }
  protected modelCallRoster(project: ProjectRecord): NonNullable<AuthorityRead["modelCalls"]> {
    const modelRows = this.ctx.storage.sql.exec<{ id: string; owner: string; maximum: string; state: string; payload: string }>(
      "SELECT id,owner,maximum,state,payload FROM reservations WHERE id!=owner ORDER BY rowid LIMIT ?", MODEL_CALL_ROSTER_LIMIT + 1,
    ).toArray();
    return {
      limit: MODEL_CALL_ROSTER_LIMIT,
      overflow: modelRows.length > MODEL_CALL_ROSTER_LIMIT,
      reservations: modelRows.slice(0, MODEL_CALL_ROSTER_LIMIT).map(row => {
        const retained = JSON.parse(row.payload) as Parameters<ProjectAuthority["reserveModel"]>[0];
        requireValue(row.id === retained.callId && row.owner === retained.attemptId && row.maximum === retained.maximumCost
          && canonicalize(retained.scope) === canonicalize(project.scope), "MODEL_RESERVATION_RECORD_INVALID", 409);
        return { callId: row.id, attemptId: row.owner, generation: retained.generation,
          requestDigest: retained.requestDigest, maximumCost: row.maximum, state: row.state, outcome: this.modelCalls.outcome(row.id) };
      }),
    };
  }
  modelCallPage(caller: TrustedCaller, input: { after: string; limit: number; expectedIncarnation: string }): unknown {
    this.role(caller, 'admin'); requireValue(caller.principal.credentialClass === 'human', 'HUMAN_ADMIN_REQUIRED', 403);
    const project = this.project();
    requireValue(input.expectedIncarnation === project.scope.projectIncarnation, 'PROJECT_INCAR_CHANGED', 409);
    requireValue(typeof input.after === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(input.after) && BigInt(input.after) <= 9223372036854775807n
      && Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= MODEL_CALL_PAGE_LIMIT, 'MODEL_CALL_PAGE_INVALID', 400);
    const rows = this.ctx.storage.sql.exec<{ cursor: string; id: string; owner: string; maximum: string; state: string; payload: string }>(
      'SELECT CAST(rowid AS TEXT) AS cursor,id,owner,maximum,state,payload FROM reservations WHERE id!=owner AND rowid>CAST(? AS INTEGER) ORDER BY rowid LIMIT ?', input.after, input.limit + 1,
    ).toArray();
    const reservations: (NonNullable<AuthorityRead['modelCalls']>['reservations'][number] & { cursor: string })[] = [];
    let more = rows.length > input.limit;
    for (const row of rows.slice(0, input.limit)) {
      const value = JSON.parse(row.payload) as Parameters<ProjectAuthority['reserveModel']>[0];
      requireValue(row.id === value.callId && row.owner === value.attemptId && row.maximum === value.maximumCost
        && canonicalize(value.scope) === canonicalize(project.scope), 'MODEL_RESERVATION_RECORD_INVALID', 409);
      const item = { cursor: row.cursor, callId: row.id, attemptId: row.owner, generation: value.generation,
        requestDigest: value.requestDigest, maximumCost: row.maximum, state: row.state, outcome: this.modelCalls.outcome(row.id) };
      if (new TextEncoder().encode(JSON.stringify(reservations)).length + new TextEncoder().encode(JSON.stringify(item)).length > MODEL_CALL_PAGE_BYTES - 4096) { more = true; break; }
      reservations.push(item);
    }
    requireValue(rows.length === 0 || reservations.length > 0, 'MODEL_CALL_PAGE_BYTES', 413);
    const result = { schemaVersion: 1, scope: project.scope, authorityRevision: project.revision, after: input.after, limit: input.limit,
      nextCursor: more ? reservations.at(-1)!.cursor : null, reservations,
      accounting: 'Internal reservation ceilings; verified provider response usage is not an invoice.' };
    requireValue(new TextEncoder().encode(JSON.stringify(result)).length <= MODEL_CALL_PAGE_BYTES, 'MODEL_CALL_PAGE_BYTES', 413);
    return result;
  }
  async observeModelCall(fact: ModelCallFact): Promise<unknown> { return this.modelCalls.observe(fact); }
  private currentCandidateId(): string | null {
    // The event window is display history, not the current-release index. Keep
    // the existing exclusion of diagnostic and non-repair individual candidates.
    const row = this.row<{ id: string }>(`SELECT c.id FROM events e
      JOIN records c ON c.kind='candidate' AND c.id=json_extract(e.payload,'$.objectId')
      WHERE json_extract(e.payload,'$.kind')='candidate-ready'
        AND COALESCE(json_extract(c.payload,'$.recipe[0]'),'')!='controlled-A-plus-B'
        AND (substr(c.id,-11)!='-individual' OR EXISTS (
          SELECT 1 FROM json_each(c.payload,'$.contributorIds') member
          JOIN records s ON s.kind='submission' AND s.id=member.value
          JOIN records a ON a.kind='attempt' AND a.id=json_extract(s.payload,'$.attemptId')
          WHERE json_extract(a.payload,'$.workBase')!=json_extract(a.payload,'$.publicationBase')))
      ORDER BY e.sequence DESC LIMIT 1`);
    return row?.id ?? null;
  }
  private pinCandidateRead(project: ProjectRecord, captured: Pick<AuthorityRead, 'attempts' | 'candidates' | 'plans' | 'evaluations' | 'reviews' | 'submissions' | 'runtime' | 'sourceManifests' | 'evaluationIds'>, evidence: AdmissionEvidence[], selectedId?: string): NonNullable<AuthorityRead['candidateRead']> {
    const currentId = this.currentCandidateId();
    const pending = [...new Set([currentId, selectedId].filter((id): id is string => Boolean(id)))];
    const roots = [...pending], candidateIds: string[] = [], incompleteIds: string[] = [], retainedFailureIds: string[] = [], events: AuthorityRead['events'] = [];
    let planBudget = CANDIDATE_VIEW_RECORD_BUDGET, evidenceBudget = CANDIDATE_VIEW_RECORD_BUDGET, contributorBudget = CANDIDATE_VIEW_RECORD_BUDGET;
    const contributors = new Set<string>();
    const pinnedAttempts = new Set<string>();
    let contributorAttempts = 0, relatedAttempts = 0;
    const pinAttempt = (attempt: AttemptRecord, related = false): boolean => {
      if (pinnedAttempts.has(attempt.id)) return true;
      if (related ? relatedAttempts >= 32 : contributorAttempts >= CANDIDATE_VIEW_RECORD_BUDGET) return false;
      if (related) relatedAttempts++; else contributorAttempts++;
      pinnedAttempts.add(attempt.id);
      captured.attempts = mergeBy(captured.attempts, [attempt], item => item.id);
      captured.sourceManifests[attempt.workBase] = this.record<import('./artifacts').RepositorySnapshot>('source', attempt.workBase).manifest;
      const latest = this.row<{ payload: string }>("SELECT payload FROM records WHERE kind='runtime-observation' AND json_extract(payload,'$.attemptId')=? AND json_extract(payload,'$.generation')=? ORDER BY (json_extract(payload,'$.lifecycle')='STOPPED') DESC,rowid DESC LIMIT 1", attempt.id, attempt.generation);
      if (latest) captured.runtime = [...captured.runtime.filter(item => item.attemptId !== attempt.id || item.generation !== attempt.generation), JSON.parse(latest.payload)];
      const admission = this.row<{ sequence: number; payload: string }>(`SELECT sequence,payload FROM events
        WHERE (json_extract(payload,'$.kind') IN ('create-attempt','start-repair','accept-proposal') AND json_extract(payload,'$.payload.id')=?)
          OR (json_extract(payload,'$.kind')='launch-cohort' AND EXISTS (SELECT 1 FROM json_each(events.payload,'$.payload.attempts') WHERE json_extract(value,'$.id')=?))
        ORDER BY sequence LIMIT 1`, attempt.id, attempt.id);
      if (admission && !events.some(event => event.sequence === admission.sequence)) events.push(admission);
      return true;
    };
    for (const id of pending) {
      if (candidateIds.includes(id)) continue;
      // Finite lineage guard: an unsupported closure is explicit, never a
      // silently complete view. General paginated lineage is separate work.
      if (candidateIds.length >= 32) { incompleteIds.push(...roots); break; }
      const candidate = this.record<CandidateRecord>('candidate', id);
      requireValue(canonicalize(candidate.scope) === canonicalize(project.scope), 'CANDIDATE_SCOPE_CHANGED', 409);
      if (candidate.contributorIds.length > 128) incompleteIds.push(id);
      candidateIds.push(id); captured.candidates = mergeBy(captured.candidates, [candidate], item => item.id);
      const ready = this.row<{ sequence: number; payload: string }>("SELECT sequence,payload FROM events WHERE json_extract(payload,'$.kind')='candidate-ready' AND json_extract(payload,'$.objectId')=? ORDER BY sequence DESC LIMIT 1", id);
      if (ready) events.push(ready);
      for (const commit of new Set([candidate.parent, candidate.commit])) {
        const source = this.record<import('./artifacts').RepositorySnapshot>('source', commit);
        captured.sourceManifests[commit] = source.manifest;
      }
      for (const submissionId of candidate.contributorIds.slice(0, 128)) {
        if (!contributors.has(submissionId) && contributorBudget === 0) { incompleteIds.push(id); break; }
        if (!contributors.has(submissionId)) { contributors.add(submissionId); contributorBudget--; }
        const submission = { ...this.record<AuthorityRead['submissions'][number]>('submission', submissionId), id: submissionId };
        const attempt = this.record<AttemptRecord>('attempt', submission.attemptId);
        captured.submissions = mergeBy(captured.submissions, [submission], item => item.id);
        if (!pinAttempt(attempt)) incompleteIds.push(id);
        // Only direct repair recipe members establish this successor's failed
        // base. Inherited contributors remain exact without recursively walking
        // every historical repair branch.
        if (candidate.recipe.includes(submissionId) && attempt.workBase !== attempt.publicationBase) {
          const parent = this.row<{ id: string }>("SELECT id FROM records WHERE kind='candidate' AND json_extract(payload,'$.commit')=? AND id!=? ORDER BY id LIMIT 1", attempt.workBase, id);
          if (parent && !pending.includes(parent.id)) pending.push(parent.id);
        }
      }
      // A repair without accepted source is not a contributor yet. Resolve
      // the latest repair directly, using admission order to break deadline ties.
      const repair = this.row<{ payload: string }>(`SELECT a.payload FROM records a
        WHERE a.kind='attempt' AND json_extract(a.payload,'$.workBase')=?
          AND json_extract(a.payload,'$.workBase')!=json_extract(a.payload,'$.publicationBase')
        ORDER BY json_extract(a.payload,'$.deadline') DESC,
          COALESCE((SELECT MAX(e.sequence) FROM events e WHERE json_extract(e.payload,'$.kind') IN ('start-repair','accept-proposal') AND json_extract(e.payload,'$.payload.id')=a.id),0) DESC,a.id DESC LIMIT 1`, candidate.commit);
      if (repair) {
        const attempt = JSON.parse(repair.payload) as AttemptRecord;
        if (!pinAttempt(attempt, true)) incompleteIds.push(id);
        const successor = this.row<{ id: string }>(`SELECT c.id FROM records s
          JOIN records c ON c.kind='candidate' AND EXISTS (SELECT 1 FROM json_each(c.payload,'$.recipe') WHERE value=s.id)
          JOIN events e ON json_extract(e.payload,'$.kind')='candidate-ready' AND json_extract(e.payload,'$.objectId')=c.id
          WHERE s.kind='submission' AND json_extract(s.payload,'$.attemptId')=? ORDER BY e.sequence DESC LIMIT 1`, attempt.id);
        if (successor && !pending.includes(successor.id)) pending.push(successor.id);
      }
      const planCapacity = Math.min(planBudget, CANDIDATE_VIEW_PLAN_LIMIT);
      const planRows = this.ctx.storage.sql.exec<{ id: string; payload: string }>("SELECT id,payload FROM records WHERE kind='plan' AND json_extract(payload,'$.candidateId')=? ORDER BY rowid DESC LIMIT ?", id, planCapacity + 1).toArray();
      const plans = planRows.slice(0, planCapacity); planBudget -= plans.length;
      const retained = this.retainedEvidence(id);
      if (planRows.length > planCapacity || retained.length > CANDIDATE_VIEW_EVIDENCE_LIMIT) incompleteIds.push(id);
      // Even an overflowing supported-evidence view keeps a real retained
      // failure visible; overflow itself makes the candidate ineligible below.
      for (const query of ["SELECT payload FROM evidence WHERE json_extract(payload,'$.candidateId')=? AND outcome='FAIL' ORDER BY job_id LIMIT 1", "SELECT payload FROM records WHERE kind='evidence-contradiction' AND json_extract(payload,'$.candidateId')=? AND json_extract(payload,'$.outcome')='FAIL' ORDER BY id LIMIT 1"]) {
        const failure = this.row<{ payload: string }>(query, id); if (failure) { retained.unshift(JSON.parse(failure.payload)); retainedFailureIds.push(id); }
      }
      const distinct = mergeBy([], retained, item => item.digest);
      if (distinct.length > evidenceBudget) incompleteIds.push(id);
      const included = distinct.slice(0, Math.min(CANDIDATE_VIEW_EVIDENCE_LIMIT, evidenceBudget)); evidenceBudget -= included.length;
      evidence.splice(0, evidence.length, ...mergeBy(evidence, included, item => item.digest));
      for (const row of plans) {
        const plan = JSON.parse(row.payload) as EvaluationPlan;
        const evaluation = this.record<AuthorityRead['evaluations'][number]>('evaluation', row.id);
        captured.plans = mergeBy(captured.plans, [plan], item => item.digest);
        captured.evaluationIds[plan.digest] = row.id;
        captured.evaluations = mergeBy(captured.evaluations, [{ ...evaluation, eligible: !incompleteIds.includes(id) && evaluation.goalRevision === project.goalRevision && evaluation.policyRevision === project.policyRevision && evaluation.contractBundleDigest === this.evaluationContext(project, row.id).contractBundleDigest }], item => item.id);
      }
      const review = this.row<{ payload: string }>("SELECT payload FROM records WHERE kind='review' AND json_extract(payload,'$.proposal.candidateId')=? ORDER BY rowid DESC LIMIT 1", id);
      if (review) { const value = JSON.parse(review.payload) as AuthorityRead['reviews'][number]; captured.reviews = [...captured.reviews.filter(item => item.id !== value.id), value]; }
    }
    captured.evaluations = captured.evaluations.map(item => incompleteIds.some(id => captured.plans.some(plan => plan.candidateId === id && plan.digest === item.planDigest)) ? { ...item, eligible: false } : item)
      .sort((a, b) => BigInt(a.authorityRevision) > BigInt(b.authorityRevision) ? -1 : BigInt(a.authorityRevision) < BigInt(b.authorityRevision) ? 1 : a.id.localeCompare(b.id));
    return { currentId, selectedId: selectedId ?? null, candidateIds, incompleteIds: [...new Set(incompleteIds)], retainedFailureIds: [...new Set(retainedFailureIds)], planLimit: CANDIDATE_VIEW_PLAN_LIMIT, evidenceLimit: CANDIDATE_VIEW_EVIDENCE_LIMIT, observationLimit: CANDIDATE_VIEW_OBSERVATION_LIMIT, events: events.sort((a, b) => a.sequence - b.sequence) };
  }
  async snapshot(caller: TrustedCaller, includeModelCalls = false, selectedCandidateId?: string): Promise<AuthorityRead> {
    const project = this.project(); this.role(caller, "reader");
    const modelCalls = includeModelCalls ? this.modelCallRoster(project) : undefined;
    let detailedModelCalls = false;
    if (modelCalls && caller.principal.credentialClass === 'human') { try { this.role(caller, 'admin'); detailedModelCalls = true; } catch { /* Preserve the legacy reader reservation shape. */ } }
    if (modelCalls && !detailedModelCalls) for (const reservation of modelCalls.reservations) delete reservation.outcome;
    if (selectedCandidateId !== undefined) requireValue(typeof selectedCandidateId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(selectedCandidateId), 'INVALID_SELECTED_CANDIDATE');
    const evidence = this.retainedEvidence();
    const historyEvidenceDigests = new Set(evidence.map(item => item.digest));
    // Capture one SQL projection before yielding to R2. Later membership is rechecked,
    // but later observations must not be mixed into an earlier revision snapshot.
    const captured = {
      attempts: this.records<AttemptRecord>("attempt"),
      ...(modelCalls ? { modelCalls } : {}),
      proposals: this.records<AttemptProposal>("attempt-proposal"), cleanups: this.cleanups(), candidates: this.records<CandidateRecord>("candidate"), plans: this.records<EvaluationPlan>("plan"), reviews: this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM records WHERE kind='review' ORDER BY rowid DESC LIMIT 2048").toArray().reverse().map(row => JSON.parse(row.payload) as AuthorityRead["reviews"][number]),
      evaluations: this.records<EvaluationContext & { planDigest: string; authorityRevision: string }>("evaluation").map(evaluation => ({ ...evaluation, eligible: evaluation.goalRevision === project.goalRevision && evaluation.policyRevision === project.policyRevision && evaluation.contractBundleDigest === this.evaluationContext(project, evaluation.id).contractBundleDigest })).sort((a, b) => BigInt(a.authorityRevision) > BigInt(b.authorityRevision) ? -1 : BigInt(a.authorityRevision) < BigInt(b.authorityRevision) ? 1 : a.id.localeCompare(b.id)),
      publications: this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM publications ORDER BY sequence").toArray().map(row => JSON.parse(row.payload) as PublicationRecord),
      receipts: this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM receipts ORDER BY sequence").toArray().map(row => JSON.parse(row.payload)),
      sequence: this.row<{ sequence: number }>("SELECT COALESCE(MAX(sequence),0) AS sequence FROM events")!.sequence,
      submissions: this.ctx.storage.sql.exec<{ id: string; payload: string }>("SELECT id,payload FROM records WHERE kind='submission'").toArray().map(row => ({ id: row.id, ...JSON.parse(row.payload) })),
      // Runtime event IDs are random identities, not lifecycle ordering. The
      // application selects the latest observation from this durable order.
      // Take the newest bounded page so long-lived projects keep current state.
      runtime: this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM records WHERE kind='runtime-observation' ORDER BY rowid DESC LIMIT 2048").toArray().reverse().map(row => JSON.parse(row.payload) as AuthorityRead["runtime"][number]), capsules: this.records<AuthorityRead["capsules"][number]>("context-capsule"),
      approvals: this.ctx.storage.sql.exec<{ proposal_digest: string; reviewer: string; expires_at: number; consumed_by: string | null }>("SELECT * FROM approvals").toArray(),
      events: this.ctx.storage.sql.exec<{ sequence: number; payload: string }>("SELECT sequence,payload FROM events ORDER BY sequence DESC LIMIT 256").toArray().reverse(),
      baseline: this.record<import("./artifacts").RepositorySnapshot>("source", this.enrollmentRecord(project).head),
      sourceManifests: Object.fromEntries(this.records<import("./artifacts").RepositorySnapshot>("source").map(source => [source.commit, source.manifest])),
      evaluationIds: Object.fromEntries(this.ctx.storage.sql.exec<{ id: string; payload: string }>("SELECT id,payload FROM records WHERE kind='plan'").toArray().map(row => [(JSON.parse(row.payload) as EvaluationPlan).digest, row.id])),
    };
    const candidateRead = this.pinCandidateRead(project, captured, evidence, selectedCandidateId);
    const extraObservations = evidence.filter(item => !historyEvidenceDigests.has(item.digest)).sort((a, b) => Number(b.outcome === 'FAIL') - Number(a.outcome === 'FAIL'));
    const includedObservations = new Set(extraObservations.slice(0, CANDIDATE_VIEW_OBSERVATION_LIMIT).map(item => item.digest));
    candidateRead.incompleteIds = [...new Set([...candidateRead.incompleteIds, ...extraObservations.slice(CANDIDATE_VIEW_OBSERVATION_LIMIT).map(item => item.candidateId)])];
    const incompletePlans = new Set(captured.plans.filter(plan => candidateRead.incompleteIds.includes(plan.candidateId)).map(plan => plan.digest));
    captured.evaluations = captured.evaluations.map(item => incompletePlans.has(item.planDigest) ? { ...item, eligible: false } : item);
    const selectedSources = candidateRead.candidateIds.map(id => captured.candidates.find(candidate => candidate.id === id)!.source);
    const sourceFiles = await previewSourceFiles(
      [captured.baseline, this.record<import("./artifacts").RepositorySnapshot>("source", project.head), ...selectedSources, ...captured.candidates.slice(-16).map(candidate => candidate.source)],
      (contentDigest, maximum) => this.objects.get(contentDigest, maximum),
    );
    const observations: AuthorityRead["observations"] = {};
    for (const item of evidence) if (historyEvidenceDigests.has(item.digest) || includedObservations.has(item.digest)) observations[item.digest] = JSON.parse(new TextDecoder().decode(await this.objects.get(item.observationDigest, MAX_CONTROL_BYTES))) as Record<string, unknown>;
    this.role(caller, "reader");
    const current = this.project(), roles = this.roles(caller, current), human = caller.principal.credentialClass === "human";
    requireValue(canonicalize(current.scope) === canonicalize(project.scope), 'PROJECT_INCAR_CHANGED', 409);
    // R2 yields may demote an admin while preserving reader permission.
    if (modelCalls && detailedModelCalls) {
      try { this.role(caller, 'admin'); } catch { for (const reservation of modelCalls.reservations) delete reservation.outcome; }
    }
    const collaborationEnabled = this.collaborators.enabled(current.scope), legacyAdmin = !collaborationEnabled && roles.includes("admin");
    const permits = (role: string) => roles.includes(role) || legacyAdmin;
    const owner = collaborationEnabled && Boolean(this.row("SELECT subject FROM collaborators WHERE subject=? AND role='owner' AND owner=1", caller.principal.id));
    const callerPermissions = { review: human && permits("reviewer"), sponsor: human && permits("sponsor"), manage: human && (legacyAdmin || owner), export: permits("export") };
    return { project, ...captured, candidateRead, evidence, observations, sourceFiles, callerPermissions };
  }
  /** An owner inspection is evidence about these stores, not a release readiness verdict. */
  async operations(caller: TrustedCaller, jobKey?: string): Promise<unknown> {
    this.role(caller, 'admin'); requireValue(caller.principal.credentialClass === 'human', 'HUMAN_ADMIN_REQUIRED', 403);
    const project = this.project();
    const authorityObservedAt = Date.now();
    const outbox = this.ctx.storage.sql.exec<{ kind: string; count: number }>("SELECT kind,COUNT(*) AS count FROM outbox WHERE state='PENDING' GROUP BY kind").toArray();
    const oldestOutbox = this.row<{ created_at_ms: number | null }>("SELECT created_at_ms FROM outbox WHERE state='PENDING' ORDER BY created_at_ms LIMIT 1");
    const outboxAge = oldestAge(oldestOutbox?.created_at_ms, authorityObservedAt);
    const cleanups = this.ctx.storage.sql.exec<{ phase: string; count: number }>('SELECT phase,COUNT(*) AS count FROM cleanups GROUP BY phase').toArray();
    const publications = this.ctx.storage.sql.exec<{ id: string; phase: string }>('SELECT id,phase FROM publications WHERE unresolved=1 LIMIT 2').toArray();
    const history = this.ctx.storage.sql.exec<{ kind: string; count: number }>("SELECT 'records' AS kind,COUNT(*) AS count FROM records UNION ALL SELECT 'events',COUNT(*) FROM events UNION ALL SELECT 'outbox',COUNT(*) FROM outbox UNION ALL SELECT 'evidence',COUNT(*) FROM evidence UNION ALL SELECT 'receipts',COUNT(*) FROM receipts").toArray();
    const capacity = authorityCapacity(history.find(row => row.kind === 'records')!.count, this.ctx.storage.sql.databaseSize);
    let evaluator: unknown;
    try {
      evaluator = await withinDeadline(async () => {
        const response = await this.env.EVALUATOR.fetch('https://evaluator.internal/internal/operations', {
          method: 'POST', headers: { authorization: `Bearer ${this.env.EVALUATOR_SERVICE_TOKEN}`, 'content-type': 'application/json' },
          body: canonicalize({ scope: project.scope, ...(jobKey ? { jobKey } : {}) }),
        });
        requireValue(response.ok, 'EVALUATOR_INSPECTION_UNAVAILABLE', 503);
        return parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(response.body, 32768)));
      }, 5000, 'EVALUATOR_INSPECTION_DEADLINE');
    } catch { evaluator = { inspection: 'UNKNOWN' }; }
    this.role(caller, 'admin'); requireValue(caller.principal.credentialClass === 'human'
      && canonicalize(this.project().scope) === canonicalize(project.scope) && this.project().revision === project.revision, 'OPERATOR_SCOPE_CHANGED', 409);
    return { schemaVersion: 1, scope: project.scope, authorityRevision: project.revision, authorityObservedAt,
      inspectionCompletedAt: Date.now(), atomicAcrossServices: false,
      authority: { gate: project.gate, maintenance: this.env.MAINTENANCE_MODE === 'true', pendingOutbox: outbox,
        oldestPendingOutboxAgeSeconds: outboxAge.ageSeconds, outboxAgeEvidence: outboxAge.evidence, cleanupPhases: cleanups,
        unresolvedPublications: publications, historyRows: history, sqliteBytes: capacity.sqliteBytes, capacity,
        maximumBudgetMicroUnits: project.maximumBudget,
        reservedBudgetMicroUnits: project.reservedBudget, settledBudgetMicroUnits: project.settledBudget },
      evaluator, unobserved: ['projectionLag', 'deadLetterBacklog', 'providerSpend', 'containerResourceReturn'], readiness: 'UNVERIFIED' };
  }
  /** Check durable display watermarks before any R2 preview or observation read. */
  async conditionalSnapshot(caller: TrustedCaller, prior: ViewCursor | null, selectedCandidateId?: string): Promise<{ unchanged: true; cursor: ViewCursor } | { unchanged: false; cursor: ViewCursor; snapshot: AuthorityRead }> {
    const project = this.project(); this.role(caller, "reader");
    if (selectedCandidateId !== undefined) requireValue(typeof selectedCandidateId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(selectedCandidateId), 'INVALID_SELECTED_CANDIDATE');
    const cursor: ViewCursor = {
      projectIncarnation: project.scope.projectIncarnation, revision: project.revision,
      eventSequence: this.row<{ sequence: number }>("SELECT COALESCE(MAX(sequence),0) AS sequence FROM events")!.sequence,
      // Runtime context capsules can be inserted after their runtime event.
      capsuleRowid: this.row<{ rowid: number }>("SELECT COALESCE(MAX(rowid),0) AS rowid FROM records WHERE kind='context-capsule'")!.rowid,
      ...(selectedCandidateId === undefined ? {} : { selectedCandidateId }),
    };
    if (prior && sameViewCursor(prior, cursor)) return { unchanged: true, cursor };
    return { unchanged: false, cursor, snapshot: await this.snapshot(caller, false, selectedCandidateId) };
  }
  async command(caller: TrustedCaller, command: AuthorityCommand): Promise<unknown> {
    if (command.operation === 'admit-join-request') requireValue(this.env.PROJECT_HUB_ENABLED === 'true', 'PROJECT_HUB_UNAVAILABLE', 404);
    if (command.operation === "accept-invitation") this.ctx.storage.transactionSync(() => this.collaborators.recordAcceptanceAttempt(caller, this.project().scope, now()));
    if (this.catalog.isArchived()) { this.roles(caller); throw new PlatformError('PROJECT_ARCHIVED', 409); }
    try { return await this.performCommand(caller, command); }
    catch (error) {
      if (error instanceof PlatformError && error.code !== "PROJECT_INCAR_CHANGED" && error.status >= 400 && error.status < 500 && typeof command.commandId === "string" && typeof command.operation === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(command.commandId) && this.env.MAINTENANCE_MODE !== "true") {
        // Rejected application commands have the same caller/id/digest tombstone
        // as admitted commands. A retry cannot silently become a different intent.
        const project = this.project(); const membership = this.row<{ active: number }>("SELECT active FROM memberships WHERE subject=?", caller.principal.id);
        if (membership?.active && caller.principal.tenantId === project.scope.tenantId && caller.projectId === project.scope.projectId) { this.ctx.storage.transactionSync(() => {
          try { this.roles(caller, project); } catch { throw error; }
          const requestDigest = hash(command); const prior = this.row<{ digest: string }>("SELECT digest FROM commands WHERE caller=? AND id=?", caller.principal.id, command.commandId);
          if (prior) { requireValue(prior.digest === requestDigest, "COMMAND_ID_REUSED", 409); return; }
          this.ctx.storage.sql.exec("INSERT INTO commands(caller,id,digest,operation,state,result) VALUES(?,?,?,?,?,?)", caller.principal.id, command.commandId, requestDigest, command.operation, "REJECTED", canonicalize({ code: error.code, status: error.status, message: error.message }));
          this.event(project, "command-rejected", command.commandId, { operation: command.operation, code: error.code, requestDigest });
        }); await this.ctx.storage.setAlarm(Date.now() + 100); }
      }
      throw error;
    }
  }
  private async performCommand(caller: TrustedCaller, command: AuthorityCommand): Promise<unknown> {
    requireValue(typeof command.commandId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(command.commandId), "INVALID_COMMAND_ID");
    requireValue(typeof command.operation === "string" && /^[a-z-]{1,64}$/.test(command.operation) && command.body && typeof command.body === "object" && !Array.isArray(command.body), "SCHEMA_ERROR");
    counter(command.expectedRevision);
    if (command.expectedIncarnation !== undefined) requireValue(command.expectedIncarnation === this.project().scope.projectIncarnation, "PROJECT_INCAR_CHANGED", 409);
    requireValue(this.env.MAINTENANCE_MODE !== "true", "MAINTENANCE_READ_ONLY", 503);
    if (command.operation === "replay-projection") { this.role(caller, "admin"); requireValue(caller.principal.credentialClass === "human", "HUMAN_ADMIN_REQUIRED", 403); replayBody(command.body); requireValue(canonicalize(command.body.scope) === canonicalize(this.project().scope), "PROJECTION_SCOPE_CHANGED", 409); }
    const requestDigest = hash(command);
    const prior = this.row<{ digest: string; result: string; state: string }>("SELECT digest,result,state FROM commands WHERE caller=? AND id=?", caller.principal.id, command.commandId);
    if (prior) { this.authorizeReplay(caller, command); requireValue(prior.digest === requestDigest, "COMMAND_ID_REUSED", 409); const result = JSON.parse(prior.result); if (prior.state === "REJECTED") throw new PlatformError(result.code, result.status, result.message); return result; }
    if (isNewAuthorityWork(command.operation, command.body)) { this.roles(caller); requireAuthorityCapacity(this.ctx.storage.sql, command.operation, command.body); }
    if (command.operation === "create-attempt" && command.body.contextCapsuleId != null) {
      this.role(caller, "sponsor"); requireValue(caller.principal.credentialClass === "human", "HUMAN_REQUIRED", 403);
      const project = this.project(); const capsule = this.record<ContextCapsuleRecord>("context-capsule", string(command.body.contextCapsuleId));
      requireValue(capsule.digest === command.body.contextCapsuleDigest && capsule.sourceCommit === command.body.workBase && capsule.goalRevision === project.goalRevision && canonicalize(capsule.scope) === canonicalize(project.scope) && capsule.sessionDigest && !capsule.missingSessionTail && capsule.selectedEntry === command.body.sessionEntry, "CONTINUATION_CONTEXT_MISMATCH", 409);
      const selected = selectedSession(await this.objects.get(capsule.sessionDigest, MAX_CONTROL_BYTES), string(command.body.sessionEntry)); requireValue(selected.sessionId === capsule.sessionId, "CONTINUATION_SESSION_MISMATCH", 409);
      this.record<import("./artifacts").RepositorySnapshot>("source", capsule.sourceCommit);
    }
    if (command.operation === "approve-review") {
      this.role(caller, "reviewer"); requireValue(caller.principal.credentialClass === "human", "HUMAN_REQUIRED", 403);
      const project = this.project(); requireValue(project.revision === command.expectedRevision, "STALE_STATE", 409);
      const review = this.record<{ proposal: ReviewProposal; proposalDigest: string; planId: string }>("review", string(command.body.reviewId));
      this.assertReviewCurrent(project, review);
      requireValue(review.proposalDigest === command.body.proposalDigest && now() < review.proposal.expiresAt, "APPROVAL_SCOPE_OR_EXPIRY", 409);
      const candidate = this.record<CandidateRecord>("candidate", review.proposal.candidateId);
      requireValue(candidate.digest === review.proposal.candidateDigest && candidate.commit === review.proposal.newHead && candidate.parent === review.proposal.expectedHead && candidate.manifestDigest === review.proposal.manifestDigest, "REVIEW_SOURCE_IDENTITY_MISMATCH", 409);
      // Approval is unavailable if either immutable snapshot is missing,
      // invalid, or too large for the complete reader-authorized export.
      await this.candidateSource(caller, candidate.id, "candidate");
      await this.candidateSource(caller, candidate.id, "base");
    }
    let preparedLifecycle: Awaited<ReturnType<typeof prepareKeyLifecycle>> | undefined;
    let preparedEndorsement: { publicationId: string; logicalDigest: string; envelope: Envelope; envelopeDigest: string; keysetRevision: string } | undefined;
    if (["rotate-key", "revoke-key", "endorse-publication", "endorse-record"].includes(command.operation)) {
      this.role(caller, "admin"); requireValue(caller.principal.credentialClass === "human", "HUMAN_ADMIN_REQUIRED", 403); const project = this.project(); requireValue(project.revision === command.expectedRevision, "STALE_STATE", 409);
      const trust = this.trust(project); if (command.operation === "rotate-key") requireValue(project.unresolvedPublicationId === null, "PENDING_PUBLICATION_KEY_ROTATION_FENCED", 409);
      if (command.operation === "endorse-record") {
        const kind = string(command.body.kind); requireValue(["enrollment", "admission", "publication", "evidence"].includes(kind), "ENDORSEMENT_KIND_UNSUPPORTED");
        const target = this.endorsementTarget(kind, command.body.recordId, project);
        const envelope = command.body.envelope as Envelope; const verified = verifyAttestation({ trust, envelope, role: kind === "enrollment" ? "root" : kind === "evidence" ? "checker" : "authority", kind: kind as "enrollment" | "admission" | "publication" | "evidence", authorityRevision: target.authorityRevision, allowLegacy: false }); requireValue(verified.valid && verified.recordDigest && verified.issuance?.signerKeysetRevision === trust.keysetRevision && canonicalize(verified.record) === canonicalize(target.record), "ENDORSEMENT_INVALID", 409);
        const envelopeDigest = await this.objects.put(bytes(envelope)); preparedEndorsement = { publicationId: "", logicalDigest: verified.recordDigest, envelope, envelopeDigest, keysetRevision: trust.keysetRevision };
      } else if (command.operation === "endorse-publication") {
        const publication = this.publication(string(command.body.publicationId)); requireValue(publication.phase === "FINALIZED" && publication.logical && publication.logicalDigest && publication.logical.authorityRevision, "RECEIPT_REVISION_UNAVAILABLE", 409);
        const envelope = await this.sign("publication", publication.logical, publication.logical.authorityRevision);
        const envelopeDigest = await this.objects.put(bytes(envelope)); preparedEndorsement = { publicationId: publication.id, logicalDigest: publication.logicalDigest, envelope, envelopeDigest, keysetRevision: trust.keysetRevision };
      } else {
        requireValue(this.env.ROOT_SIGNING_KEY && this.env.ROOT_KEY_ID, "ROOT_SIGNER_NOT_CONFIGURED", 409);
        const role = string(command.body.role); requireValue(["root", "authority", "checker"].includes(role), "UNSUPPORTED_KEY_ROLE");
        const change: LifecycleChange = { operation: command.operation === "rotate-key" ? "rotate" : "revoke", role: role as SignerRole, oldKeyId: string(command.body.oldKeyId), effectiveSequence: (BigInt(project.publicationSequence) + 1n).toString(), authorityRevision: (BigInt(project.revision) + 1n).toString(), reason: string(command.body.reason), ...(command.body.newKey == null ? {} : { newKey: command.body.newKey as TrustKey }) };
        const rootPrivateKey = await crypto.subtle.importKey("pkcs8", decodeBase64(this.env.ROOT_SIGNING_KEY).slice().buffer, "Ed25519", false, ["sign"]);
        try { preparedLifecycle = await prepareKeyLifecycle({ trust, change, rootKeyId: this.env.ROOT_KEY_ID, rootPrivateKey }); } catch (error) { throw new PlatformError(error instanceof Error ? error.message : "KEY_LIFECYCLE_INVALID", 409); }
      }
    }
    let preparedPortable: PreparedPortableInputs | undefined;
    if (command.operation === "request-publication") {
      this.role(caller, "sponsor"); const project = this.project(); requireValue(project.revision === command.expectedRevision, "STALE_STATE", 409);
      const review = this.record<{ proposal: ReviewProposal }>("review", string(command.body.reviewId));
      const candidate = this.record<CandidateRecord>("candidate", review.proposal.candidateId);
      const evidence = this.retainedEvidence(candidate.id);
      assertPortableAdmission(0, Number(project.publicationSequence));
      const raw = await this.objects.get(candidate.source.objectsDigest, PORTABLE_BUNDLE_BYTES);
      let total = raw.length; assertPortableAdmission(total, Number(project.publicationSequence));
      const gitObjects = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as VerificationBundle["inputs"]["gitObjects"];
      const observations: VerificationBundle["inputs"]["observations"] = [];
      for (const item of evidence) {
        const dataBase64 = encodeBase64(await this.objects.get(item.observationDigest, MAX_CONTROL_BYTES));
        total += dataBase64.length + 128; assertPortableAdmission(total, Number(project.publicationSequence));
        observations.push({ digest: item.observationDigest, dataBase64 });
      }
      preparedPortable = { candidateId: candidate.id, evidenceDigests: evidence.map(item => item.digest), gitObjects, observations };
    }
    let preparedPlan: EvaluationPlan | undefined;
    let preparedEvaluation: EvaluationContext | undefined;
    let preparedBaseline: CandidateRecord | undefined;
    let repairCounterexamples: RepairCounterexample[] | undefined;
    if (command.operation === "request-evaluation") {
      this.role(caller, "sponsor");
      const candidate = this.record<CandidateRecord>("candidate", string(command.body.candidateId));
      requireValue(!containsTypeScriptSource(candidate.source.manifest), "TYPESCRIPT_PROTECTED_PROFILE_UNREGISTERED", 409);
      const project = this.project(); preparedEvaluation = this.evaluationContext(project, crypto.randomUUID());
      preparedPlan = await makeEvaluationPlan(candidate, this.env.EVALUATION_IMAGE_DIGEST, this.env.CHECKER_IMPLEMENTATION_DIGEST, "full", project.scope, preparedEvaluation);
    }
    if (command.operation === "launch-cohort") {
      this.role(caller, "sponsor"); const project = this.project(); const source = this.record<import("./artifacts").RepositorySnapshot>("source", project.head);
      requireValue(!containsTypeScriptSource(source.manifest), "TYPESCRIPT_AUTHORING_PROFILE_UNREGISTERED", 409);
      requireValue(["cache.mjs", "mutation.mjs", "presentation.mjs", "server.mjs"].every(path => source.manifest.entries.some(entry => entry.path === path)), "COLLABORATION_FIXTURE_REQUIRED");
      const base = { id: `baseline-${project.scope.projectIncarnation}`, scope: project.scope, commit: source.commit, commitBytesDigest: source.commitBytesDigest, parent: source.parent ?? "", manifestDigest: source.manifestDigest, contributorIds: [], recipe: ["enrolled-baseline"] };
      preparedBaseline = { ...base, digest: hash(base), source }; preparedEvaluation = this.evaluationContext(project, `${preparedBaseline.id}-evaluation`);
      preparedPlan = await makeEvaluationPlan(preparedBaseline, this.env.EVALUATION_IMAGE_DIGEST, this.env.CHECKER_IMPLEMENTATION_DIGEST, "freshness", project.scope, preparedEvaluation);
    }
    if (command.operation === "start-repair" || command.operation === "accept-proposal" && this.record<AttemptProposal>("attempt-proposal", string(command.body.proposalId)).kind === "repair") {
      this.role(caller, "sponsor"); const candidateId = command.operation === "start-repair" ? string(command.body.candidateId) : string(this.record<AttemptProposal>("attempt-proposal", string(command.body.proposalId)).candidateId); let includedBytes = 0;
      const failures = this.publicFailures(candidateId).sort((a, b) => Number(b.jobId.endsWith(":overlapping-read-write")) - Number(a.jobId.endsWith(":overlapping-read-write")));
      repairCounterexamples = [];
      for (const failure of failures) {
        const item: NonNullable<typeof repairCounterexamples>[number] = { evidenceDigest: failure.digest, observationDigest: failure.observationDigest };
        const retained = await this.objects.get(failure.observationDigest, MAX_CONTROL_BYTES);
        if (includedBytes + retained.length <= 16384) { item.observation = JSON.parse(getKernel().canonical_json(new TextDecoder().decode(retained))); includedBytes += retained.length; }
        repairCounterexamples.push(item);
      }
    }
    let result: unknown;
    this.ctx.storage.transactionSync(() => {
      const duplicate = this.row<{ digest: string; result: string; state: string }>("SELECT digest,result,state FROM commands WHERE caller=? AND id=?", caller.principal.id, command.commandId);
      if (duplicate) { this.authorizeReplay(caller, command); requireValue(duplicate.digest === requestDigest, "COMMAND_ID_REUSED", 409); result = JSON.parse(duplicate.result); if (duplicate.state === "REJECTED") { const rejection = result as { code: string; status: number; message: string }; throw new PlatformError(rejection.code, rejection.status, rejection.message); } return; }
      const project = this.project();
      if (isNewAuthorityWork(command.operation, command.body)) { this.roles(caller, project); requireAuthorityCapacity(this.ctx.storage.sql, command.operation, command.body); }
      if (command.operation === "accept-invitation") requireValue(command.expectedRevision === "0", "INVITATION_REVISION_INVALID", 409);
      else { this.roles(caller, project); requireValue(project.revision === command.expectedRevision, "STALE_STATE", 409); }
      const original = project.revision;
      result = this.apply(caller, project, command, preparedPlan, preparedBaseline, repairCounterexamples, preparedEvaluation, preparedLifecycle, preparedEndorsement, preparedPortable);
      project.revision = (BigInt(original) + 1n).toString(); this.saveProject(project, original);
      this.ctx.storage.sql.exec("INSERT INTO commands(caller,id,digest,operation,state,result) VALUES(?,?,?,?,?,?)", caller.principal.id, command.commandId, requestDigest, command.operation, "COMMITTED", canonicalize(result));
      this.event(project, command.operation, command.commandId, result);
    });
    await this.ctx.storage.setAlarm(Date.now() + 100);
    return result;
  }
  private authorizeReplay(caller: TrustedCaller, command: AuthorityCommand): void {
    const project = this.project(); this.roles(caller, project);
    if (command.operation === "submit-weft-revision") this.role(caller, "sponsor");
    if (command.operation === "set-membership") requireValue(!this.collaborators.enabled(project.scope), "COLLABORATION_MEMBERSHIP_REQUIRED", 409);
    if (this.collaborators.enabled(project.scope) && collaborationOperation(command.operation) && command.operation !== "accept-invitation") this.collaborators.requireOwner(caller, project.scope, now());
  }
  private apply(caller: TrustedCaller, project: ProjectRecord, command: AuthorityCommand, preparedPlan?: EvaluationPlan, preparedBaseline?: CandidateRecord, repairCounterexamples?: RepairCounterexample[], preparedEvaluation?: EvaluationContext, preparedLifecycle?: Awaited<ReturnType<typeof prepareKeyLifecycle>>, preparedEndorsement?: { publicationId: string; logicalDigest: string; envelope: Envelope; envelopeDigest: string; keysetRevision: string }, preparedPortable?: PreparedPortableInputs): unknown {
    const body = { ...command.body };
    requireAuthorityCapacity(this.ctx.storage.sql, command.operation, body);
    if (collaborationOperation(command.operation)) return this.collaborators.apply(caller, project, command, JSON.parse(this.env.BOOTSTRAP_SUBJECTS || "[]"), now());
    if (command.operation === "replay-projection") {
      this.role(caller, "admin"); requireValue(caller.principal.credentialClass === "human", "HUMAN_ADMIN_REQUIRED", 403); replayBody(body);
      requireValue(canonicalize(body.scope) === canonicalize(project.scope), "PROJECTION_SCOPE_CHANGED", 409);
      const latest = this.row<{ sequence: number }>("SELECT COALESCE(MAX(sequence),0) AS sequence FROM events")!.sequence;
      let replay: ProjectionReplayRecord;
      if (body.replayId === null) {
        const throughSequence = body.throughSequence ?? latest; requireValue(throughSequence <= latest, "PROJECTION_REPLAY_FUTURE", 409);
        replay = { id: crypto.randomUUID(), scope: project.scope, requester: caller.principal.id, throughSequence, nextSequence: 0, queued: 0 };
      } else {
        const prior = this.row<{ payload: string }>("SELECT payload FROM projection_replays WHERE id=?", body.replayId); requireValue(prior, "PROJECTION_REPLAY_UNAVAILABLE", 404); replay = JSON.parse(prior.payload);
        requireValue(replay.requester === caller.principal.id && replay.throughSequence === body.throughSequence && replay.nextSequence === body.afterSequence && canonicalize(replay.scope) === canonicalize(project.scope), "PROJECTION_REPLAY_CURSOR_CHANGED", 409);
      }
      const events = this.projectionPage(project.scope, replay.nextSequence, replay.throughSequence);
      for (const event of events) this.effect(`projection-replay/${replay.id}/${event.sequence}`, "projection-replay", event);
      replay.nextSequence = events.at(-1)?.sequence ?? replay.nextSequence; replay.queued += events.length;
      this.ctx.storage.sql.exec("INSERT INTO projection_replays(id,requester,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", replay.id, replay.requester, canonicalize(replay));
      return { replayId: replay.id, scope: replay.scope, throughSequence: replay.throughSequence, nextSequence: replay.nextSequence, queuedEventIds: events.map(event => event.id), queued: replay.queued, complete: replay.nextSequence === replay.throughSequence, delivery: "QUEUED", limitation: "Queue send acknowledgement does not establish D1 application." };
    }
    if (["launch-cohort", "start-repair", "create-attempt", "materialize", "revoke-grant", "set-admission-gate", "request-publication"].includes(command.operation)) requireValue(caller.principal.credentialClass === "human", "HUMAN_REQUIRED", 403);
    if (command.operation === "endorse-record") {
      this.role(caller, "admin"); requireValue(caller.principal.credentialClass === "human", "HUMAN_ADMIN_REQUIRED", 403);
      const kind = string(body.kind); requireValue(["enrollment", "admission", "publication", "evidence"].includes(kind), "ENDORSEMENT_KIND_UNSUPPORTED");
      const target = this.endorsementTarget(kind, body.recordId, project); const record = target.record; const publicationId = target.publicationId;
      const envelope = body.envelope as Envelope; requireValue(preparedEndorsement && preparedEndorsement.envelopeDigest === hash(envelope) && preparedEndorsement.keysetRevision === this.trust(project).keysetRevision, "ENDORSEMENT_NOT_PREPARED", 409);
      const verified = verifyAttestation({ trust: this.trust(project), envelope, role: kind === "enrollment" ? "root" : kind === "evidence" ? "checker" : "authority", kind: kind as "enrollment" | "admission" | "publication" | "evidence", authorityRevision: target.authorityRevision, allowLegacy: false });
      requireValue(verified.valid && verified.issuance?.signerKeysetRevision === this.trust(project).keysetRevision && canonicalize(verified.record) === canonicalize(record), "ENDORSEMENT_INVALID", 409);
      const recordDigest = hash(record); requireValue(body.recordDigest === recordDigest, "ENDORSEMENT_RECORD_MISMATCH", 409);
      const duplicate = this.retainedEndorsement(recordDigest, hash(envelope)); if (duplicate) return { id: duplicate, state: "ENDORSEMENT_RETAINED", recordDigest };
      requireValue(this.endorsementCount(recordDigest) < 7, "ENDORSEMENT_LIMIT", 429);
      this.assertEndorsementCapacity(envelope);
      const id = hash(envelope).slice(7); this.retain("attestation-endorsement", id, { kind, publicationId, recordDigest, envelope, envelopeDigest: preparedEndorsement.envelopeDigest }); this.ctx.storage.sql.exec("INSERT OR IGNORE INTO pins(owner,digest) VALUES(?,?)", `endorsement/${id}`, preparedEndorsement.envelopeDigest);
      return { id, state: "ENDORSEMENT_RETAINED", recordDigest };
    }
    if (command.operation === "rotate-key" || command.operation === "revoke-key") {
      this.role(caller, "admin"); requireValue(caller.principal.credentialClass === "human" && preparedLifecycle, "KEY_LIFECYCLE_NOT_PREPARED", 403);
      if (command.operation === "rotate-key") requireValue(project.unresolvedPublicationId === null, "PENDING_PUBLICATION_KEY_ROTATION_FENCED", 409);
      requireValue(preparedLifecycle.record.previousRevision === this.trust(project).keysetRevision && preparedLifecycle.record.authorityRevision === (BigInt(project.revision) + 1n).toString(), "KEYSET_CHANGED", 409);
      this.retain("key-lifecycle", preparedLifecycle.record.revision, { record: preparedLifecycle.record, envelope: preparedLifecycle.envelope, transitionDigest: preparedLifecycle.transitionDigest });
      this.retain("trust", preparedLifecycle.trust.keysetRevision, preparedLifecycle.trust); project.keysetRevision = preparedLifecycle.trust.keysetRevision; if (command.operation === "revoke-key") project.gate = "CLOSED";
      return { id: project.keysetRevision, state: command.operation === "rotate-key" ? "KEY_ROTATION_RECORDED" : "KEY_REVOCATION_RECORDED", transitionDigest: preparedLifecycle.transitionDigest };
    }
    if (command.operation === "endorse-publication") {
      this.role(caller, "admin"); requireValue(caller.principal.credentialClass === "human" && preparedEndorsement && preparedEndorsement.keysetRevision === this.trust(project).keysetRevision, "KEYSET_CHANGED", 409);
      const publication = this.publication(preparedEndorsement.publicationId); requireValue(publication.phase === "FINALIZED" && publication.logicalDigest === preparedEndorsement.logicalDigest, "RECEIPT_SINGLE_ASSIGNMENT", 409);
      const duplicate = this.retainedEndorsement(publication.logicalDigest!, preparedEndorsement.envelopeDigest); if (duplicate) return { id: duplicate, state: "ENDORSEMENT_RETAINED", logicalDigest: publication.logicalDigest, envelopeDigest: preparedEndorsement.envelopeDigest };
      requireValue(this.endorsementCount(publication.logicalDigest!) < 7, "ENDORSEMENT_LIMIT", 429);
      this.assertEndorsementCapacity(preparedEndorsement.envelope);
      const id = `${publication.id}/${preparedEndorsement.envelopeDigest.slice(7)}`; this.retain("publication-endorsement", id, preparedEndorsement); this.ctx.storage.sql.exec("INSERT OR IGNORE INTO pins(owner,digest) VALUES(?,?)", id, preparedEndorsement.envelopeDigest);
      return { id, state: "ENDORSEMENT_RETAINED", logicalDigest: publication.logicalDigest, envelopeDigest: preparedEndorsement.envelopeDigest };
    }
    if (command.operation === "launch-cohort") {
      this.role(caller, "sponsor"); requireValue(body.mode === "pi", "LIVE_DEMO_REQUIRES_PI"); requireValue(this.records<AttemptRecord>("attempt").length === 0, "COHORT_ALREADY_STARTED", 409); requireValue(preparedBaseline && preparedPlan, "BASELINE_PLAN_REQUIRED");
      requireValue(preparedEvaluation, "BASELINE_PLAN_REQUIRED"); this.retain("candidate", preparedBaseline.id, preparedBaseline); this.registerEvaluation(project, preparedEvaluation, preparedPlan, preparedBaseline);
      const assignments = [
        { path: "cache.mjs", assignment: "Enable a 60-second read cache in cache.mjs. Preserve existing write-side invalidation." },
        { path: "mutation.mjs", assignment: "Remove the invalidate() call in mutation.mjs that seems redundant because the assigned baseline disables caching. Keep successful writes." },
        { path: "presentation.mjs", assignment: "Render saved value in <p role=\"status\" aria-live=\"polite\" aria-label=\"Saved value\">Saved value: VALUE</p>. Keep document/main structure." },
      ];
      const destination = this.env.ARTIFACTS_GIT_HOST; requireValue(/^[a-f0-9]{32}\.artifacts\.cloudflare\.net$/.test(destination), "ARTIFACTS_HOST_UNCONFIGURED", 409);
      const attempts = assignments.map(assignment => {
        const result = this.apply(caller, project, { ...command, operation: "create-attempt", body: { subject: caller.principal.id, maximumBudget: PILOT_ATTEMPT_RESERVATION_UNITS, recipe: "pi-json-proposal-v1", assignment: assignment.assignment, allowedPaths: [assignment.path], pathPrefixes: [assignment.path], operations: ["checkpoint-context", "model-inference", "propose-selection", "read-evidence", "read-source", "request-repair", "start-execution", "submit-output", "write-attempt"], destinations: [destination, "model.internal"].sort() } }) as { id: string };
        this.effect(`${result.id}-start`, "start-attempt", { scope: project.scope, attemptId: result.id, generation: "1" }); return result;
      }); return { state: "COHORT_RESERVED", attempts };
    }
    if (command.operation === "set-membership") {
      requireValue(!this.collaborators.enabled(project.scope), "COLLABORATION_MEMBERSHIP_REQUIRED", 409);
      this.role(caller, "admin"); requireValue(caller.principal.credentialClass === "human", "HUMAN_ADMIN_REQUIRED", 403);
      const { subject, roles, active } = membershipChange(body);
      const retained = this.row<{ roles: string; active: number }>("SELECT roles,active FROM memberships WHERE subject=?", subject);
      const before: MembershipState | null = retained ? { roles: JSON.parse(retained.roles), active: retained.active === 1 } : null;
      const after: MembershipState = { roles, active };
      if (membershipAllows(before, "admin") && !membershipAllows(after, "admin")) {
        const admins = this.row<{ count: number }>("SELECT COUNT(*) AS count FROM memberships WHERE active=1 AND EXISTS (SELECT 1 FROM json_each(memberships.roles) WHERE value='admin')")!.count;
        requireRemainingAdmin(before, after, admins);
      }
      this.ctx.storage.sql.exec("INSERT INTO memberships(subject,roles,active) VALUES(?,?,?) ON CONFLICT(subject) DO UPDATE SET roles=excluded.roles,active=excluded.active", subject, canonicalize(roles), active ? 1 : 0);
      const approvalsInvalidated = invalidateMembershipApprovals(before, after)
        ? this.ctx.storage.sql.exec("DELETE FROM approvals WHERE reviewer=? AND consumed_by IS NULL", subject).rowsWritten : 0;
      const grants = active ? [] : this.ctx.storage.sql.exec<{ id: string; attempt_id: string; generation: string }>("SELECT id,attempt_id,generation FROM grants WHERE subject=? AND revoked=0", subject).toArray();
      for (const grant of grants) { this.ctx.storage.sql.exec("UPDATE grants SET revoked=1 WHERE id=?", grant.id); this.effect(crypto.randomUUID(), "stop-attempt", { scope: project.scope, attemptId: grant.attempt_id, generation: grant.generation }); }
      return { state: active ? "MEMBERSHIP_ACTIVE" : "MEMBERSHIP_REVOKED", actor: caller.principal.id, subject, before, after,
        authorityRevision: (BigInt(project.revision) + 1n).toString(), approvalsInvalidated, grantsRevoked: grants.length };
    }
    if (command.operation === "increase-budget") {
      this.role(caller, "admin"); requireValue(caller.principal.credentialClass === "human", "HUMAN_ADMIN_REQUIRED", 403);
      requireValue(command.expectedIncarnation === project.scope.projectIncarnation, "PROJECT_INCAR_CHANGED", 409);
      requireValue(Object.keys(body).sort().join(",") === "expectedMaximumBudget,newMaximumBudget,reason", "SCHEMA_ERROR");
      const previousMaximumBudget = counter(body.expectedMaximumBudget);
      const maximumBudget = counter(body.newMaximumBudget);
      const reason = string(body.reason);
      requireValue(reason.trim() === reason && reason.length > 0 && new TextEncoder().encode(reason).length <= 512 && !/[\u0000-\u001f\u007f]/.test(reason), "BUDGET_REASON_REQUIRED");
      requireValue(previousMaximumBudget === project.maximumBudget, "BUDGET_LIMIT_CHANGED", 409);
      const before = BigInt(previousMaximumBudget), after = BigInt(maximumBudget);
      requireValue(after > before && after - before <= PILOT_BUDGET_STEP && after <= BigInt(pilotBudgetPolicyCapUnits(project.scope)), "BUDGET_INCREASE_DENIED", 409);
      const accounted = BigInt(counter(project.reservedBudget)) + BigInt(counter(project.settledBudget));
      requireValue(accounted <= before && accounted <= after, "INVALID_BUDGET_STATE", 409);
      const amendmentId = hash({ scope: project.scope, actor: caller.principal.id, commandId: command.commandId });
      const amendment = { schemaVersion: 1, scope: project.scope, id: amendmentId, actor: caller.principal.id, commandId: command.commandId,
        authorityRevision: (BigInt(project.revision) + 1n).toString(), previousMaximumBudget, maximumBudget,
        reservedBudget: project.reservedBudget, settledBudget: project.settledBudget, reason };
      this.retain("budget-amendment", amendmentId, amendment);
      project.maximumBudget = maximumBudget;
      return { id: amendmentId, state: "BUDGET_INCREASED", previousMaximumBudget, maximumBudget, reservedBudget: project.reservedBudget, settledBudget: project.settledBudget };
    }
    if (command.operation === "start-repair") {
      this.role(caller, "sponsor"); const candidate = this.record<CandidateRecord>("candidate", string(body.candidateId));
      requireValue(this.retainedEvidence(candidate.id).some(item => item.outcome === "FAIL"), "FAILED_CANDIDATE_REQUIRED", 409);
      const failures = this.publicFailures(candidate.id);
      const concurrencyFailure = this.concurrencyFailure(candidate.id);
      if (concurrencyFailure) requireValue(repairCounterexamples?.some(item => item.evidenceDigest === concurrencyFailure.digest && item.observation !== undefined), "COUNTEREXAMPLE_CONTEXT_LIMIT", 409);
      const allowedPaths = [concurrencyFailure ? "cache.mjs" : "mutation.mjs"], readOnlyContextPaths = [concurrencyFailure ? "mutation.mjs" : "cache.mjs"];
      const task = concurrencyFailure
        ? "Repair overlapping-read/write cache freshness in cache.mjs. Prevent an old in-flight read from refilling or overwriting the cache after an acknowledged write. Preserve enabled caching with TTL 60 seconds, useful cache hits and accessible saved-value status. The failing source is your exact work base. Only edit cache.mjs; mutation.mjs is read-only context."
        : "Repair stale writes in mutation.mjs. Preserve enabled caching and accessible saved-value status. The failing source is your exact work base. Only edit mutation.mjs; cache.mjs is read-only context.";
      const assignment = canonicalize({ task, failedCandidate: candidate.digest, publicContract: "Fresh acknowledged values plus retained cache benefit and accessible saved status", counterexamples: compactRepairAssignment(repairCounterexamples ?? [], concurrencyFailure?.digest), contextPolicy: "One decisive public failure observation is included; other public failures retain digest references. Full observations remain retained in the assignment capsule and evidence store." });
      const result = this.apply(caller, project, { ...command, operation: "create-attempt", body: { subject: caller.principal.id, maximumBudget: PILOT_ATTEMPT_RESERVATION_UNITS, recipe: "pi-json-proposal-v1", assignment, allowedPaths, readOnlyContextPaths, pathPrefixes: allowedPaths, workBase: candidate.commit, publicationBase: candidate.parent, operations: ["checkpoint-context", "model-inference", "propose-selection", "read-evidence", "read-source", "request-repair", "start-execution", "submit-output", "write-attempt"], destinations: [this.env.ARTIFACTS_GIT_HOST, "model.internal"].sort() } }) as { id: string };
      const capsule = { id: result.id, scope: project.scope, attemptId: result.id, sourceCommit: candidate.commit, sourceManifestDigest: candidate.manifestDigest, goalRevision: project.goalRevision, adapter: "pi-sdk-1.0.2-json-proposal-v1", generation: "1", selectorVersion: "repair-explicit-v1", selectedEvidence: failures.map(item => item.digest), selectedItems: repairCounterexamples ?? [], assignmentDigest: hash(assignment), producer: "controller-selected-assignment", missingSessionTail: true }; this.retain("assignment-capsule", result.id, { ...capsule, digest: hash(capsule) });
      this.effect(`${result.id}-start`, "start-attempt", { scope: project.scope, attemptId: result.id, generation: "1" }); return { ...result, state: "REPAIR_RESERVED" };
    }
    if (["checkpoint-context", "request-repair", "propose-selection"].includes(command.operation)) {
      const attempt = this.record<AttemptRecord>("attempt", string(body.attemptId));
      requireValue(body.generation === attempt.generation && body.goalRevision === attempt.goalRevision && attempt.goalRevision === project.goalRevision, "ATTEMPT_CONTEXT_CHANGED", 409);
      const grant = this.checkGrant(project, attempt, caller.principal.id, command.operation, null, "0");
      requireValue(!this.row("SELECT id FROM cleanups WHERE attempt_id=?", attempt.id), "ATTEMPT_CLEANUP_FENCED", 409);
      if (command.operation === "checkpoint-context") {
        requireValue(this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM records WHERE kind='context-declaration' AND json_extract(payload,'$.attemptId')=?", attempt.id).one().count < 16, "CONTEXT_DECLARATION_LIMIT", 429);
        const selectedEvidence = set(body.selectedEvidence ?? []); requireValue(selectedEvidence.length <= 8, "CONTEXT_REFERENCE_LIMIT");
        const selectedItems = selectedEvidence.map(evidenceDigest => {
          const evidence = this.retainedEvidence().find(item => item.digest === evidenceDigest); requireValue(evidence, "REFERENCE_UNAVAILABLE", 404);
          const registration = this.record<{ audit: boolean }>("evaluation-job", evidence.jobId); const candidate = this.record<CandidateRecord>("candidate", evidence.candidateId);
          requireValue(registration.audit === false && (candidate.contributorIds.some(id => this.record<{ attemptId: string }>("submission", id).attemptId === attempt.id) || grant.resources.includes(candidate.id)), "CONTEXT_REFERENCE_DENIED", 403);
          return { evidenceDigest, observationDigest: evidence.observationDigest, producer: "registered-checker", trustClass: "public-counterexample-reference" };
        });
        const declaration = { schemaVersion: 1, scope: project.scope, attemptId: attempt.id, generation: attempt.generation, subject: caller.principal.id, goalRevision: project.goalRevision,
          sourceCommit: attempt.workBase, producer: "agent-reported", trustClass: "untrusted-context-declaration", outcome: string(body.outcome), context: text(body.context), selectedItems,
          predecessorId: body.predecessorId == null ? null : string(body.predecessorId) };
        requireValue(bytes(declaration.context).length <= 8192, "CONTEXT_DECLARATION_LIMIT", 413);
        if (declaration.predecessorId) { const predecessor = this.record<{ attemptId: string; generation: string }>("context-declaration", declaration.predecessorId); requireValue(predecessor.attemptId === attempt.id && predecessor.generation === attempt.generation, "CONTEXT_PREDECESSOR_MISMATCH", 409); }
        const id = crypto.randomUUID(); this.retain("context-declaration", id, declaration); return { id, digest: hash(declaration), state: "ATTRIBUTED_CONTEXT_RETAINED" };
      }
      requireValue(this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM records WHERE kind='attempt-proposal'").one().count < 256 && this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM records WHERE kind='attempt-proposal' AND json_extract(payload,'$.attemptId')=?", attempt.id).one().count < 32, "PROPOSAL_LIMIT", 429);
      const kind: AttemptProposal["kind"] = command.operation === "request-repair" ? "repair" : "selection"; const submissionIds = kind === "selection" ? set(body.submissionIds) : [];
      requireValue(kind !== "selection" || submissionIds.length > 0 && submissionIds.length <= 4, "SELECTION_LIMIT");
      const candidate = kind === "repair" ? this.record<CandidateRecord>("candidate", string(body.candidateId)) : null;
      if (candidate) { requireValue(candidate.contributorIds.some(id => this.record<{ attemptId: string }>("submission", id).attemptId === attempt.id) || grant.resources.includes(candidate.id), "PROPOSAL_REFERENCE_DENIED", 403); requireValue(this.retainedEvidence(candidate.id).some(item => item.outcome === "FAIL"), "FAILED_CANDIDATE_REQUIRED", 409); }
      const sourceDigests = submissionIds.map(id => { const submission = this.record<{ attemptId: string; source: import("./artifacts").RepositorySnapshot }>("submission", id); requireValue(submission.attemptId === attempt.id || grant.resources.includes(submission.attemptId), "PROPOSAL_REFERENCE_DENIED", 403); return hash(submission.source); });
      requireValue(body.publicationBase === project.head, "PROPOSAL_BASE_CHANGED", 409);
      const proposed = { id: crypto.randomUUID(), scope: project.scope, attemptId: attempt.id, generation: attempt.generation, subject: caller.principal.id, grantId: grant.id, goalRevision: project.goalRevision, policyRevision: project.policyRevision, publicationBase: project.head, kind,
        rationale: text(body.rationale), candidateId: candidate?.id ?? null, candidateDigest: candidate?.digest ?? null, submissionIds, sourceDigests };
      requireValue(bytes(proposed.rationale).length <= 2048, "PROPOSAL_RATIONALE_LIMIT", 413);
      const proposal: AttemptProposal = { ...proposed, digest: hash(proposed) }; this.retain("attempt-proposal", proposal.id, proposal); return { id: proposal.id, digest: proposal.digest, state: "PROPOSAL_RETAINED" };
    }
    if (command.operation === "accept-proposal") {
      this.role(caller, "sponsor"); requireValue(caller.principal.credentialClass === "human", "HUMAN_REQUIRED", 403);
      const proposal = this.record<AttemptProposal>("attempt-proposal", string(body.proposalId)); const attempt = this.record<AttemptRecord>("attempt", proposal.attemptId);
      requireValue(body.proposalDigest === proposal.digest && canonicalize(proposal.scope) === canonicalize(project.scope) && proposal.goalRevision === project.goalRevision && proposal.policyRevision === project.policyRevision && proposal.publicationBase === project.head && proposal.generation === attempt.generation && proposal.grantId === attempt.grantId, "PROPOSAL_CONTEXT_CHANGED", 409);
      requireValue(this.row<{ active: number }>("SELECT active FROM memberships WHERE subject=?", proposal.subject)?.active, "PROPOSAL_SUBJECT_REVOKED", 403);
      this.checkGrant(project, attempt, proposal.subject, proposal.kind === "repair" ? "request-repair" : "propose-selection", null, "0");
      requireValue(!this.row("SELECT id FROM records WHERE kind='accepted-proposal' AND id=?", proposal.id), "PROPOSAL_ALREADY_ACCEPTED", 409);
      if (proposal.candidateId) requireValue(this.record<CandidateRecord>("candidate", proposal.candidateId).digest === proposal.candidateDigest, "PROPOSAL_REFERENCE_CHANGED", 409);
      proposal.submissionIds.forEach((id, index) => requireValue(hash(this.record<{ source: import("./artifacts").RepositorySnapshot }>("submission", id).source) === proposal.sourceDigests[index], "PROPOSAL_REFERENCE_CHANGED", 409));
      const result = this.apply(caller, project, { ...command, operation: proposal.kind === "repair" ? "start-repair" : "materialize", body: proposal.kind === "repair" ? { candidateId: proposal.candidateId } : { submissionIds: proposal.submissionIds, evaluate: true } }, undefined, undefined, repairCounterexamples);
      this.retain("accepted-proposal", proposal.id, { scope: project.scope, proposalDigest: proposal.digest, sponsor: caller.principal.id, commandId: command.commandId, result }); return result;
    }
    if (command.operation === "set-policy") {
      this.role(caller, "admin"); requireValue(caller.principal.credentialClass === "human", "HUMAN_REQUIRED", 403); const revision = (BigInt(project.policyRevision) + 1n).toString();
      this.retain("policy", revision, { scope: project.scope, revision, previous: project.policyRevision, contracts: registeredContracts(body.contracts), reason: string(body.reason), protectedChecker: this.env.CHECKER_IMPLEMENTATION_DIGEST }); project.policyRevision = revision; return { id: revision, state: "POLICY_UPDATED" };
    }
    if (command.operation === "create-goal") {
      this.role(caller, "sponsor"); requireValue(caller.principal.credentialClass === "human", "HUMAN_REQUIRED", 403);
      const revision = crypto.randomUUID(); this.retain("goal", revision, { scope: project.scope, revision, predecessor: project.goalRevision, description: string(body.description), contracts: registeredContracts(body.contracts), creator: caller.principal.id });
      project.goalRevision = revision; return { id: revision, state: "CREATED" };
    }
    if (command.operation === "create-attempt") {
      let inheritedCacheRepair = false;
      if (body.contextCapsuleId != null) {
        const capsule = this.record<ContextCapsuleRecord>("context-capsule", string(body.contextCapsuleId)); const originalAttempt = this.record<AttemptRecord>("attempt", capsule.attemptId); const retainedGrant = this.row<{ payload: string }>("SELECT payload FROM grants WHERE id=?", originalAttempt.grantId); requireValue(retainedGrant, "CONTINUATION_GRANT_UNAVAILABLE", 409); const originalGrant = JSON.parse(retainedGrant.payload) as GrantRecord;
        inheritedCacheRepair = originalAttempt.allowedPaths?.length === 1 && originalAttempt.allowedPaths[0] === "cache.mjs" && originalAttempt.readOnlyContextPaths?.length === 1 && originalAttempt.readOnlyContextPaths[0] === "mutation.mjs";
        const inherited = { publicationBase: originalAttempt.publicationBase, subject: originalAttempt.subject, recipe: originalAttempt.recipe, assignment: originalAttempt.assignment, allowedPaths: originalAttempt.allowedPaths, readOnlyContextPaths: originalAttempt.readOnlyContextPaths, pathPrefixes: originalGrant.pathPrefixes, operations: originalGrant.operations, destinations: originalGrant.destinations };
        for (const [key, value] of Object.entries(inherited)) { requireValue(body[key] == null || canonicalize(body[key]) === canonicalize(value), "CONTINUATION_ASSIGNMENT_CHANGED", 409); body[key] = value; }
        body.maximumBudget ??= originalGrant.maximumBudget; requireValue(BigInt(counter(body.maximumBudget)) <= BigInt(originalGrant.maximumBudget), "CONTINUATION_BUDGET_WIDENED", 409);
      }
      this.role(caller, "sponsor"); const id = crypto.randomUUID(); const grantId = crypto.randomUUID();
      requireValue(body.recipe === "pi-json-proposal-v1", "UNREGISTERED_EXECUTION_RECIPE");
      requireValue(this.row<{ count: number }>("SELECT COUNT(*) AS count FROM reservations WHERE id=owner AND state != 'SETTLED'")!.count < 4, "AUTHORING_CAPACITY", 429);
      const subject = string(body.subject); requireValue(this.row<{ active: number }>("SELECT active FROM memberships WHERE subject=?", subject)?.active, "SUBJECT_UNAVAILABLE");
      this.collaborators.assertGrantSubject(subject, project.scope);
      const maximumBudget = counter(body.maximumBudget); const reserved = JSON.parse(getKernel().budget_transition(canonicalize({ limit: project.maximumBudget, held: project.reservedBudget, settled: project.settledBudget, reservation: maximumBudget, phase: "NONE", event: "RESERVE", observedCost: null }))) as { accepted: boolean; reason: string; held: string; settled: string };
      requireValue(reserved.accepted, reserved.reason, 409); project.reservedBudget = reserved.held;
      const workBase = typeof body.workBase === "string" ? body.workBase : project.head;
      requireValue(workBase === project.head || Boolean(this.row("SELECT id FROM records WHERE kind='source' AND id=?", workBase)), "WORK_BASE_UNAVAILABLE");
      requireValue(!containsTypeScriptSource(this.record<import("./artifacts").RepositorySnapshot>("source", workBase).manifest), "TYPESCRIPT_AUTHORING_PROFILE_UNREGISTERED", 409);
      let contextReference: AttemptRecord["contextReference"];
      if (body.contextCapsuleId != null) {
        const capsule = this.record<ContextCapsuleRecord>("context-capsule", string(body.contextCapsuleId)); requireValue(capsule.digest === body.contextCapsuleDigest && capsule.sourceCommit === workBase && capsule.goalRevision === project.goalRevision && canonicalize(capsule.scope) === canonicalize(project.scope) && capsule.sessionDigest && !capsule.missingSessionTail && capsule.selectedEntry === body.sessionEntry, "CONTINUATION_CONTEXT_MISMATCH", 409);
        contextReference = { capsuleId: capsule.id, capsuleDigest: capsule.digest, sessionDigest: capsule.sessionDigest, sessionEntry: string(body.sessionEntry), sessionId: string(capsule.sessionId) };
      } else requireValue(body.contextCapsuleDigest == null && body.sessionEntry == null, "CONTINUATION_CONTEXT_REQUIRED", 409);
      const attempt: AttemptRecord = { id, grantId, subject, generation: "1", repoName: `attempt-${id}`, workBase, publicationBase: typeof body.publicationBase === "string" ? body.publicationBase : project.head, deadline: now() + 600, state: "RESERVED", goalRevision: project.goalRevision, recipe: string(body.recipe), assignment: text(body.assignment), allowedPaths: set(body.allowedPaths), ...(body.readOnlyContextPaths != null ? { readOnlyContextPaths: set(body.readOnlyContextPaths) } : {}), ...(contextReference ? { contextReference } : {}) };
      const mutationRepair = attempt.allowedPaths?.length === 1 && attempt.allowedPaths[0] === "mutation.mjs" && attempt.readOnlyContextPaths?.length === 1 && attempt.readOnlyContextPaths[0] === "cache.mjs";
      const cacheRepair = attempt.allowedPaths?.length === 1 && attempt.allowedPaths[0] === "cache.mjs" && attempt.readOnlyContextPaths?.length === 1 && attempt.readOnlyContextPaths[0] === "mutation.mjs";
      requireValue(!attempt.readOnlyContextPaths || mutationRepair || cacheRepair, "READ_ONLY_CONTEXT_PATHS_INVALID", 409);
      requireValue(!cacheRepair || inheritedCacheRepair || this.records<CandidateRecord>("candidate").some(candidate => candidate.commit === workBase && candidate.parent === attempt.publicationBase && this.concurrencyFailure(candidate.id)), "CONCURRENCY_FAILURE_REQUIRED", 409);
      requireValue(Boolean(this.row("SELECT id FROM records WHERE kind='source' AND id=?", attempt.publicationBase)), "PUBLICATION_BASE_UNAVAILABLE", 409);
      const grant: GrantRecord = { id: grantId, subject, attemptId: id, generation: "1", operations: set(body.operations), resources: [id], pathPrefixes: set(body.pathPrefixes), destinations: set(body.destinations), maximumBudget, expiresAt: now() + 600, authorityGeneration: "1" };
      requireValue(!attempt.readOnlyContextPaths || (grant.pathPrefixes.length === 1 && grant.pathPrefixes[0] === attempt.allowedPaths?.[0]), "READ_ONLY_CONTEXT_WRITE_SCOPE", 409);
      const wireGrant = { scope: project.scope, id: grant.id, subjectId: grant.subject, attemptId: grant.attemptId, generation: grant.generation, authorityGeneration: grant.authorityGeneration, operations: grant.operations, resources: grant.resources, pathPrefixes: grant.pathPrefixes, destinations: grant.destinations, startsAt: grant.expiresAt - 600, expiresAt: grant.expiresAt, budgetMicroUnits: grant.maximumBudget, revoked: false };
      const containment = JSON.parse(getKernel().grant_inclusion(canonicalize({ parent: wireGrant, child: wireGrant }))) as { accepted: boolean; reason: string }; requireValue(containment.accepted, containment.reason);
      requireValue(attempt.allowedPaths?.length && ["model-inference", "read-source", "start-execution", "submit-output", "write-attempt"].every(operation => grant.operations.includes(operation)) && grant.destinations.includes("model.internal") && grant.destinations.includes(this.env.ARTIFACTS_GIT_HOST), "EXECUTION_RECIPE_GRANT_INCOMPLETE");
      for (const path of attempt.allowedPaths) { const pathAdmission = JSON.parse(getKernel().validate_grant(canonicalize({ grant: wireGrant, currentScope: project.scope, subjectId: subject, attemptId: id, currentGeneration: "1", currentAuthorityGeneration: "1", operation: "write-attempt", resource: id, path, destination: null, now: now(), maximumCost: "0", availableBudget: maximumBudget }))) as { accepted: boolean; reason: string }; requireValue(pathAdmission.accepted, pathAdmission.reason); }
      this.retain("attempt", id, attempt); this.ctx.storage.sql.exec("INSERT INTO grants(id,subject,attempt_id,generation,expires_at,payload) VALUES(?,?,?,?,?,?)", grantId, subject, id, "1", grant.expiresAt, canonicalize(grant));
      this.ctx.storage.sql.exec("INSERT INTO reservations(id,owner,maximum,state,payload) VALUES(?,?,?,?,?)", id, id, maximumBudget, "RESERVED", canonicalize({ attemptId: id }));
      this.effect(id, "provision-attempt", { scope: project.scope, attempt }); return { id, grantId, state: "RESERVED", statusUrl: `/v1/projects/${project.scope.projectId}/attempts/${id}` };
    }
    if (command.operation === "revoke-grant") {
      this.role(caller, "admin"); const id = string(body.grantId);
      const written = this.ctx.storage.sql.exec("UPDATE grants SET revoked=1 WHERE id=?", id).rowsWritten; requireValue(written === 1, "REFERENCE_UNAVAILABLE", 404);
      const grant = this.row<{ attempt_id: string; generation: string }>("SELECT attempt_id,generation FROM grants WHERE id=?", id)!;
      this.effect(crypto.randomUUID(), "stop-attempt", { scope: project.scope, attemptId: grant.attempt_id, generation: grant.generation }); return { id, state: "REVOKED_STOP_REQUESTED" };
    }
    if (command.operation === "cancel-attempt") {
      const attempt = this.record<AttemptRecord>("attempt", string(body.attemptId)); const roles = this.roles(caller, project);
      if (!roles.some(role => role === "sponsor" || role === "admin")) { requireValue(caller.principal.id === attempt.subject, "SCOPE_DENIED", 403); this.checkGrant(project, attempt, caller.principal.id, "start-execution", null, "0"); }
      const reason = string(body.reason); const cancellationId = hash({ callerId: caller.principal.id, commandId: command.commandId }); this.ctx.storage.sql.exec("UPDATE grants SET revoked=1 WHERE id=?", attempt.grantId);
      this.retain("cancellation", cancellationId, { scope: project.scope, attemptId: attempt.id, generation: attempt.generation, callerId: caller.principal.id, reason, state: "STOP_REQUESTED" });
      this.effect(`${cancellationId}-cancel-stop`, "stop-attempt", { scope: project.scope, attemptId: attempt.id, generation: attempt.generation });
      return { id: attempt.id, state: "STOP_REQUESTED", generation: attempt.generation };
    }
    if (command.operation === "request-cleanup") {
      const attempt = this.record<AttemptRecord>("attempt", string(body.attemptId)); const roles = this.roles(caller, project);
      if (!roles.some(role => role === "sponsor" || role === "admin")) {
        requireValue(caller.principal.id === attempt.subject, "SCOPE_DENIED", 403);
        const grant = this.row<{ payload: string }>("SELECT payload FROM grants WHERE id=?", attempt.grantId);
        const retained = grant ? JSON.parse(grant.payload) as GrantRecord : null;
        requireValue(retained && retained.subject === caller.principal.id && retained.attemptId === attempt.id && retained.generation === attempt.generation, "GRANT_GENERATION_FENCED", 403);
      }
      const previous = this.row<{ payload: string }>("SELECT payload FROM cleanups WHERE attempt_id=?", attempt.id);
      if (previous) return { id: (JSON.parse(previous.payload) as CleanupRecord).id, state: (JSON.parse(previous.payload) as CleanupRecord).phase };
      const id = crypto.randomUUID(); const cleanup: CleanupRecord = { id, scope: project.scope, attemptId: attempt.id, generation: attempt.generation, repository: attempt.repoName, phase: "STOP_REQUESTED", terminationObserved: false, credentialsRevoked: false, auxiliaryResources: null, archiveDigest: null, archiveObjects: 0, deleteAcknowledged: false, tombstonedAt: null, reason: string(body.reason) };
      this.ctx.storage.sql.exec("UPDATE grants SET revoked=1 WHERE id=?", attempt.grantId);
      this.ctx.storage.sql.exec("INSERT INTO cleanups(id,attempt_id,generation,phase,payload) VALUES(?,?,?,?,?)", id, attempt.id, attempt.generation, cleanup.phase, canonicalize(cleanup));
      this.effect(`${id}-cleanup-stop`, "stop-attempt", { scope: project.scope, attemptId: attempt.id, generation: attempt.generation });
      this.effect(`${id}-cleanup`, "cleanup-attempt", { cleanupId: id });
      return { id, state: cleanup.phase };
    }
    if (command.operation === "submit-attempt") {
      const attempt = this.record<AttemptRecord>("attempt", string(body.attemptId)); this.checkGrant(project, attempt, caller.principal.id, "submit-output", null, "0");
      requireValue(!this.row("SELECT id FROM cleanups WHERE attempt_id=?", attempt.id), "ATTEMPT_CLEANUP_FENCED", 409);
      const id = crypto.randomUUID(); const commit = string(body.commit); requireValue(/^[a-f0-9]{40}$/.test(commit), "INVALID_GIT_OID");
      this.effect(id, "ingest-submission", { scope: project.scope, attemptId: attempt.id, submissionId: id, commit, ref: string(body.ref), admittedAt: now(), grant: this.checkGrant(project, attempt, caller.principal.id, "submit-output", null, "0") });
      return { id, state: "INGESTION_PENDING" };
    }
    if (command.operation === "start-execution") {
      const attempt = this.record<AttemptRecord>("attempt", string(body.attemptId)); this.checkGrant(project, attempt, caller.principal.id, "start-execution", null, "0");
      const id = crypto.randomUUID(); this.effect(id, "start-attempt", { scope: project.scope, attemptId: attempt.id, generation: attempt.generation }); return { id, state: "EXECUTION_START_RESERVED" };
    }
    if (command.operation === "submit-weft-revision") {
      this.role(caller, "sponsor");
      requireValue(command.expectedIncarnation === project.scope.projectIncarnation, "PROJECT_INCAR_CHANGED", 409);
      const binding = this.weftBinding(), selected = validateWeftSelection(body, binding);
      requireValue(project.head === selected.expectedBase, "PUBLICATION_BASE_MOVED", 409);
      const id = this.weftHandoffId(caller, command.commandId);
      const candidateId = `weft-${id}`;
      const handoff: WeftHandoff = { schemaVersion: 1, id, requestId: command.commandId, requestDigest: hash(command), scope: project.scope,
        submittedBy: caller.principal.id, ...(caller.principal.authentication ? { authenticationIssuedAt: caller.principal.authentication.issuedAt } : {}), selected, binding, candidateId, admittedAt: now(), policyRevision: project.policyRevision,
        goalRevision: project.goalRevision, state: "PENDING" };
      this.retain("weft-handoff", id, handoff);
      this.effect(`weft-${id}`, "weft-handoff", { handoffId: id });
      return { id, candidateId, state: "PENDING" };
    }
    if (command.operation === "materialize") {
      this.role(caller, "sponsor"); const submissionIds = set(body.submissionIds); requireValue(submissionIds.length > 0 && submissionIds.length <= 4, "SELECTION_LIMIT");
      const sources = submissionIds.map(id => this.record<{ attemptId: string; source: import("./artifacts").RepositorySnapshot }>("submission", id));
      const id = crypto.randomUUID(); this.effect(id, "materialize", { scope: project.scope, candidateId: id, submissionIds, sources, publicationBase: project.head, recipe: submissionIds, timestamp: now(), evaluate: body.evaluate === true });
      return { id, state: "MATERIALIZATION_PENDING" };
    }
    if (command.operation === "request-evaluation") {
      this.role(caller, "sponsor"); const candidate = this.record<CandidateRecord>("candidate", string(body.candidateId));
      requireValue(preparedPlan && preparedEvaluation && preparedPlan.candidateDigest === candidate.digest, "EVALUATION_INPUT_UNAVAILABLE"); const plan = preparedPlan; const id = preparedEvaluation.id;
      this.registerEvaluation(project, preparedEvaluation, plan, candidate);
      return { id, state: "EVALUATION_RESERVED", planDigest: plan.digest };
    }
    if (command.operation === "prepare-review") {
      this.role(caller, "reviewer"); const candidate = this.record<CandidateRecord>("candidate", string(body.candidateId)); const plan = this.record<EvaluationPlan>("plan", string(body.evaluationId));
      this.assertEvaluationCurrent(project, string(body.evaluationId));
      requireValue(plan.candidateId === candidate.id && plan.candidateDigest === candidate.digest && plan.jobs.length === FULL_RELEASE_JOB_COUNT && plan.jobs.every(job => job.required && job.evidenceClass === "protected-behavioural"), "REVIEW_PLAN_MISMATCH", 409);
      const evidence = this.retainedEvidence(candidate.id);
      requireValue(!evidence.some(item => item.outcome === "FAIL"), "CANDIDATE_RETAINED_FAILURE", 409);
      const proposal: ReviewProposal = { schemaVersion: 1, scope: project.scope, candidateId: candidate.id, candidateDigest: candidate.digest, expectedHead: project.head, newHead: candidate.commit,
        manifestDigest: candidate.manifestDigest, goalRevision: project.goalRevision, policyRevision: project.policyRevision, observationRevision: project.observationRevision,
        planDigest: plan.digest, evidenceDigests: evidence.map(item => item.digest).sort(), requiredEvidenceClass: "protected-behavioural", expiresAt: now() + 900 };
      const proposalDigest = hash(proposal); const id = crypto.randomUUID(); this.retain("review", id, { id, proposal, proposalDigest, planId: string(body.evaluationId) });
      return { id, state: "REVIEW_READY", proposal, proposalDigest };
    }
    if (command.operation === "approve-review") {
      this.role(caller, "reviewer"); requireValue(caller.principal.credentialClass === "human", "HUMAN_REQUIRED", 403);
      const review = this.record<{ proposal: ReviewProposal; proposalDigest: string; planId: string }>("review", string(body.reviewId));
      this.assertReviewCurrent(project, review);
      requireValue(review.proposalDigest === body.proposalDigest && now() < review.proposal.expiresAt, "APPROVAL_SCOPE_OR_EXPIRY", 409);
      const existing = this.row<{ reviewer: string; consumed_by: string | null }>("SELECT reviewer,consumed_by FROM approvals WHERE proposal_digest=?", review.proposalDigest);
      requireValue(!existing || existing.reviewer === caller.principal.id && !existing.consumed_by, "APPROVAL_ALREADY_RECORDED", 409);
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO approvals(proposal_digest,reviewer,expires_at) VALUES(?,?,?)", review.proposalDigest, caller.principal.id, review.proposal.expiresAt);
      return { id: review.proposalDigest, state: "APPROVED", expiresAt: review.proposal.expiresAt };
    }
    if (command.operation === "request-publication") {
      this.role(caller, "sponsor"); requireValue(this.env.CONDITIONAL_PUBLICATION_VERIFIED === "true", "PROVIDER_CONDITIONAL_UPDATE_UNVERIFIED", 409);
      const review = this.record<{ proposal: ReviewProposal; proposalDigest: string; planId: string }>("review", string(body.reviewId));
      this.assertEvaluationCurrent(project, review.planId);
      requireValue(typeof body.proposalDigest === "string" && body.proposalDigest === review.proposalDigest, "PUBLICATION_PROPOSAL_MISMATCH", 409);
      const requestedProposalDigest = body.proposalDigest;
      const approval = this.row<{ reviewer: string; expires_at: number; consumed_by: string | null }>("SELECT reviewer,expires_at,consumed_by FROM approvals WHERE proposal_digest=?", review.proposalDigest); requireValue(approval, "APPROVAL_REQUIRED", 409);
      const reviewer = this.row<{ active: number; roles: string }>("SELECT active,roles FROM memberships WHERE subject=?", approval.reviewer);
      const candidate = this.record<CandidateRecord>("candidate", review.proposal.candidateId); const operationId = crypto.randomUUID();
      const input: AdmissionInput = { state: { scope: project.scope, revision: project.revision, head: project.head, gate: project.gate, policyRevision: project.policyRevision, goalRevision: project.goalRevision,
        observationRevision: project.observationRevision, publicationSequence: project.publicationSequence, unresolvedPublicationId: project.unresolvedPublicationId,
        sponsor: { id: caller.principal.id, canPublish: true }, reviewer: { id: approval.reviewer, canApprove: Boolean(reviewer?.active && (JSON.parse(reviewer.roles) as string[]).some(role => role === "reviewer" || role === "admin") && this.collaborators.canReview(approval.reviewer, project.scope)) },
        approval: { proposalDigest: review.proposalDigest, reviewerId: approval.reviewer, expiresAt: approval.expires_at, consumedBy: approval.consumed_by } },
        proposal: review.proposal, candidate: { id: candidate.id, digest: candidate.digest, commit: candidate.commit, commitBytesDigest: candidate.commitBytesDigest, parent: candidate.parent, manifestDigest: candidate.manifestDigest }, plan: this.record("plan", review.planId),
        evidence: this.retainedEvidence(candidate.id),
        command: { id: command.commandId, callerId: caller.principal.id, proposalDigest: requestedProposalDigest, expectedRevision: command.expectedRevision, operationId }, now: now() };
      this.assertAttestationAuthorized("enrollment", this.enrollmentRecord(project), project.enrollment, project);
      for (const item of input.evidence) this.assertAttestationAuthorized("evidence", item, this.record<Envelope>("evidence-envelope-digest", item.digest), project);
      const admission = evaluateAdmission(input); requireValue(admission.accepted && admission.delta, admission.reason, 409);
      requireValue(preparedPortable?.candidateId === candidate.id && canonicalize(preparedPortable.evidenceDigests) === canonicalize(input.evidence.map(item => item.digest)), "PORTABLE_INPUTS_CHANGED", 409);
      const history = this.receiptHistory((BigInt(project.publicationSequence) + 1n).toString());
      const exportBase = { schemaVersion: 1, enrollment: project.enrollment, admission: null, publication: null, evidence: input.evidence.map(item => this.record<Envelope>("evidence-envelope-digest", item.digest)), history,
        endorsements: [], inputs: { witness: input, manifest: candidate.source.manifest, gitObjects: preparedPortable.gitObjects, observations: preparedPortable.observations } };
      assertPortableAdmission(portableBytes(exportBase), history.length); this.assertEndorsementCapacity();
      const consumed = this.ctx.storage.sql.exec("UPDATE approvals SET consumed_by=? WHERE proposal_digest=? AND consumed_by IS NULL", operationId, review.proposalDigest).rowsWritten; requireValue(consumed === 1, "APPROVAL_ALREADY_CONSUMED", 409);
      const publication: PublicationRecord = { id: operationId, sequence: admission.delta.sequence, phase: "ADMITTED", oldHead: project.head, newHead: candidate.commit, candidateId: candidate.id,
        proposalDigest: review.proposalDigest, witness: input, witnessDigest: hash(input), dispatchMayHaveOccurred: false, dispatchAttemptIds: [] };
      this.ctx.storage.sql.exec("INSERT INTO publications(id,canonical_ref,sequence,unresolved,phase,old_head,new_head,payload) VALUES(?,?,?,1,?,?,?,?)", operationId, project.canonicalRef, publication.sequence, publication.phase, publication.oldHead, publication.newHead, canonicalize(publication));
      project.unresolvedPublicationId = operationId; this.effect(operationId, "publish", { publicationId: operationId });
      for (const required of [candidate.manifestDigest, candidate.source.objectsDigest, publication.witnessDigest, ...input.proposal.evidenceDigests]) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO pins(owner,digest) VALUES(?,?)", operationId, required);
      return { id: operationId, state: "ADMITTED", sequence: publication.sequence };
    }
    if (command.operation === "reconcile-publication") { this.role(caller, "sponsor"); const id = string(body.publicationId ?? project.unresolvedPublicationId, "NO_UNRESOLVED_PUBLICATION"); this.publication(id); this.effect(crypto.randomUUID(), "reconcile", { publicationId: id }); return { id, state: "RECONCILIATION_QUEUED" }; }
    if (command.operation === "set-admission-gate") { this.role(caller, "admin"); requireValue(body.gate === "CLOSED" || body.gate === "OPEN" && this.env.CONDITIONAL_PUBLICATION_VERIFIED === "true", "INVALID_GATE_CHANGE"); requireValue(project.gate !== "RECOVERY", "RECOVERY_PRECONDITIONS_REQUIRED", 409); project.gate = body.gate; return { state: project.gate }; }
    throw new PlatformError("UNSUPPORTED_OPERATION", 400);
  }

  private checkGrant(project: ProjectRecord, attempt: AttemptRecord, subject: string, operation: string, destination: string | null, maximumCost: string, path: string | null = null, availableBudget?: string): GrantRecord {
    this.collaborators.assertGrantSubject(subject, project.scope);
    const row = this.row<{ payload: string; revoked: number }>("SELECT payload,revoked FROM grants WHERE id=?", attempt.grantId); requireValue(row, "GRANT_UNAVAILABLE", 403);
    const grant = JSON.parse(row.payload) as GrantRecord;
    const accepted = JSON.parse(getKernel().validate_grant(canonicalize({ grant: { scope: project.scope, id: grant.id, subjectId: grant.subject, attemptId: grant.attemptId,
      generation: grant.generation, authorityGeneration: grant.authorityGeneration, operations: grant.operations, resources: grant.resources, pathPrefixes: grant.pathPrefixes, destinations: grant.destinations,
      startsAt: grant.expiresAt - 600, expiresAt: grant.expiresAt, budgetMicroUnits: grant.maximumBudget, revoked: Boolean(row.revoked) }, currentScope: project.scope, subjectId: subject, attemptId: attempt.id,
      currentGeneration: attempt.generation, currentAuthorityGeneration: "1", operation, resource: attempt.id, path, destination, now: now(), maximumCost, availableBudget: availableBudget ?? grant.maximumBudget }))) as { accepted: boolean; reason: string };
    requireValue(accepted.accepted, accepted.reason, 403); return grant;
  }

  async enroll(caller: TrustedCaller, request: { canonicalRepo: string; canonicalRef: string; expectedHead: string; maximumBudget: string }): Promise<unknown> {
    requireValue(this.env.MAINTENANCE_MODE !== "true" && caller.principal.credentialClass === "human" && caller.principal.tenantId === this.env.AUTH_TENANT_ID, "ENROLLMENT_DENIED", 403);
    const admins = JSON.parse(this.env.BOOTSTRAP_SUBJECTS || "[]") as string[]; requireValue(admins.includes(caller.principal.id), "ENROLLMENT_DENIED", 403);
    requireValue(!this.catalog.isArchived(), 'PROJECT_ARCHIVED', 409);
    requireValue(!this.catalog.isDraft(), 'PROJECT_IMPORT_WORKFLOW_REQUIRED', 409);
    requireValue(!this.row("SELECT singleton FROM project WHERE singleton=1"), "ALREADY_ENROLLED", 409);
    const initialBudget = counter(request.maximumBudget);
    requireValue(BigInt(initialBudget) <= PILOT_BUDGET_CAP, "PILOT_ENROLLMENT_BUDGET_CAP", 409);
    const canonicalRepo = string(request.canonicalRepo); const canonicalRef = string(request.canonicalRef); validateCanonicalRef(canonicalRef); const expectedHead = string(request.expectedHead);
    requireValue(await this.repository.head(canonicalRepo, canonicalRef) === expectedHead, "ENROLLMENT_HEAD_MISMATCH", 409);
    const source = await this.repository.ingest(canonicalRepo, canonicalRef, expectedHead);
    requireValue(!containsTypeScriptSource(source.manifest), "TYPESCRIPT_PROTECTED_PROFILE_UNREGISTERED", 409);
    const scope: Scope = { schemaVersion: 1, tenantId: caller.principal.tenantId, projectId: caller.projectId, projectIncarnation: crypto.randomUUID() };
    const signingKey = await crypto.subtle.importKey("pkcs8", decodeBase64(this.env.AUTHORITY_SIGNING_KEY).slice().buffer, "Ed25519", true, ["sign"]);
    const publicJwk = await crypto.subtle.exportKey("jwk", signingKey); requireValue(publicJwk.x, "SIGNING_PUBLIC_KEY_UNAVAILABLE", 503);
    const publicKeyBase64 = publicJwk.x.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - publicJwk.x.length % 4) % 4);
    requireValue(this.env.ROOT_SIGNING_KEY && this.env.ROOT_KEY_ID && new Set([this.env.ROOT_KEY_ID, this.env.AUTHORITY_KEY_ID, this.env.CHECKER_KEY_ID]).size === 3, "ROOT_SIGNER_NOT_CONFIGURED", 409);
    const rootSigningKey = await crypto.subtle.importKey("pkcs8", decodeBase64(this.env.ROOT_SIGNING_KEY).slice().buffer, "Ed25519", true, ["sign"]); const rootJwk = await crypto.subtle.exportKey("jwk", rootSigningKey); requireValue(rootJwk.x, "ROOT_PUBLIC_KEY_UNAVAILABLE", 503);
    const rootPublicKey = rootJwk.x.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - rootJwk.x.length % 4) % 4);
    requireValue(new Set([rootPublicKey, publicKeyBase64, this.env.CHECKER_PUBLIC_KEY].map(value => encodeBase64(decodeBase64(value)))).size === 3, "SIGNING_ROLES_REQUIRE_DISTINCT_KEYS", 409);
    const trust: TrustConfig = { schemaVersion: 1, scope, keysetRevision: "1", keys: [{ id: this.env.AUTHORITY_KEY_ID, publicKeyBase64, roles: ["authority"] }, { id: this.env.CHECKER_KEY_ID, publicKeyBase64: this.env.CHECKER_PUBLIC_KEY, roles: ["checker"] }, { id: this.env.ROOT_KEY_ID, publicKeyBase64: rootPublicKey, roles: ["root"] }] }; checkedTrust(trust);
    const enrollment: Enrollment = { schemaVersion: 1, scope, head: expectedHead, manifestDigest: source.manifestDigest, trustDigest: await digest(trust), sequence: "0", importedHistory: true };
    const envelope = await this.sign("enrollment", enrollment, "1", trust); const enrollmentDigest = await digest(enrollment);
    await this.objects.putJournal(`journal/${scope.projectIncarnation}/enrollment`, bytes(envelope));
    // A fresh ref observation is required after long source reads, before local activation.
    requireValue(await this.repository.head(canonicalRepo, canonicalRef) === expectedHead, "ENROLLMENT_HEAD_MOVED", 409);
    this.ctx.storage.transactionSync(() => {
      requireValue(!this.row("SELECT singleton FROM project WHERE singleton=1"), "ALREADY_ENROLLED", 409);
      const project: ProjectRecord = { scope, keysetRevision: "1", revision: "1", head: expectedHead, gate: this.env.CONDITIONAL_PUBLICATION_VERIFIED === "true" ? "OPEN" : "CLOSED", policyRevision: "1", goalRevision: "1", observationRevision: "0", publicationSequence: "0", unresolvedPublicationId: null,
        canonicalRepo, canonicalRef, enrollmentDigest, enrollment: envelope, previousReceiptDigest: null, maximumBudget: initialBudget, reservedBudget: "0", settledBudget: "0" };
      this.ctx.storage.sql.exec("INSERT INTO project(singleton,revision,payload) VALUES(1,?,?)", project.revision, canonicalize(project));
      for (const subject of admins) this.ctx.storage.sql.exec("INSERT INTO memberships(subject,roles,active) VALUES(?,?,1)", subject, canonicalize(["admin", "reader", "reviewer", "sponsor"]));
      this.retain("source", expectedHead, { ...source, objects: [] }); this.retain("trust", "current", trust); this.retain("trust", "1", trust); this.event(project, "enrolled", scope.projectId, { head: expectedHead, importedHistory: true });
    });
    await this.ctx.storage.setAlarm(Date.now() + 100); return { state: "ENROLLED", scope, enrollmentDigest };
  }

  async reportEvidence(callback: EvaluationCallback): Promise<unknown> {
    const project = this.project(); requireValue(canonicalize(callback.scope) === canonicalize(project.scope), "PROJECT_UNAVAILABLE", 404);
    const registration = this.record<{ evaluationId: string; issuance?: IssuanceContext; checkerKeyId?: string }>("evaluation-job", callback.evidence.jobId);
    const plan = this.record<EvaluationPlan>("plan", registration.evaluationId);
    const job = plan.jobs.find(item => item.id === callback.evidence.jobId)!;
    const evidence = callback.evidence;
    requireValue(evidence.candidateId === plan.candidateId && evidence.candidateDigest === plan.candidateDigest && evidence.inputDigest === job.inputDigest && evidence.evidenceClass === job.evidenceClass && evidence.authorized === true, "EVIDENCE_INPUT_MISMATCH", 409);
    const { digest: evidenceDigest, ...unsigned } = evidence; requireValue(await digest(unsigned) === evidenceDigest, "EVIDENCE_DIGEST_MISMATCH", 409);
    const observation = decodeBase64(callback.observationBase64); requireValue(observation.length <= MAX_CONTROL_BYTES, "OBSERVATION_SIZE_LIMIT", 413);
    await this.objects.put(observation, evidence.observationDigest);
    await this.verifyChecker(callback.envelope, evidence, registration);
    await this.objects.put(bytes(callback.envelope));
    let contradictory = false;
    this.ctx.storage.transactionSync(() => {
      const current = this.project(); const currentVerification = verifyAttestation<AdmissionEvidence>({ trust: this.trust(current), envelope: callback.envelope, role: "checker", kind: "evidence", sequence: current.publicationSequence, ...(registration.issuance ? { authorityRevision: registration.issuance.authorityRevision, allowLegacy: false } : { allowLegacy: true }) }); requireValue(currentVerification.valid, "CHECKER_SIGNATURE_INVALID", 403);
      const prior = this.row<{ digest: string }>("SELECT digest FROM evidence WHERE job_id=?", job.id);
      if (prior?.digest === evidence.digest) return;
      contradictory = Boolean(prior);
      if (prior) {
        if (this.row("SELECT id FROM records WHERE kind='evidence-contradiction' AND id=?", evidence.digest)) return;
        this.retain("evidence-contradiction", evidence.digest, evidence);
      } else this.ctx.storage.sql.exec("INSERT INTO evidence(job_id,digest,outcome,payload) VALUES(?,?,?,?)", job.id, evidence.digest, evidence.outcome, canonicalize(evidence));
      this.retain("evidence-envelope-digest", evidence.digest, callback.envelope);
      const revision = current.revision; current.observationRevision = (BigInt(current.observationRevision) + 1n).toString(); current.revision = (BigInt(revision) + 1n).toString(); this.saveProject(current, revision);
      this.event(current, contradictory ? "contradictory-evidence-recorded" : "evidence-recorded", evidence.id, { outcome: evidence.outcome, candidateId: evidence.candidateId, digest: evidence.digest });
    });
    await this.ctx.storage.setAlarm(Date.now() + 100); return { state: contradictory ? "CONTRADICTORY_EVIDENCE_RETAINED" : "EVIDENCE_RETAINED", id: evidence.id };
  }
  private async verifyChecker(envelope: Envelope, evidence: AdmissionEvidence, registration: { issuance?: IssuanceContext; checkerKeyId?: string }): Promise<void> {
    const verified = verifyAttestation<AdmissionEvidence>({ trust: this.trust(), envelope, role: "checker", kind: "evidence", sequence: this.project().publicationSequence, ...(registration.issuance ? { authorityRevision: registration.issuance.authorityRevision, allowLegacy: false } : { allowLegacy: true }) });
    requireValue(verified.valid, "CHECKER_SIGNATURE_INVALID", 403); requireValue(canonicalize(verified.record) === canonicalize(evidence), "EVIDENCE_ENVELOPE_MISMATCH", 409);
    if (registration.issuance) requireValue(canonicalize(verified.issuance) === canonicalize(registration.issuance) && envelope.signatures.some(signature => signature.keyid === registration.checkerKeyId), "EVIDENCE_ISSUANCE_MISMATCH", 409);
  }

  private publication(id: string): PublicationRecord { const row = this.row<{ payload: string }>("SELECT payload FROM publications WHERE id=?", id); requireValue(row, "REFERENCE_UNAVAILABLE", 404); return JSON.parse(row.payload) as PublicationRecord; }
  private mutatePublication(id: string, mutation: (publication: PublicationRecord, project: ProjectRecord) => void): PublicationRecord {
    let selected!: PublicationRecord; this.ctx.storage.transactionSync(() => { selected = this.publication(id); const project = this.project(); const prior = project.revision; mutation(selected, project);
      this.ctx.storage.sql.exec("UPDATE publications SET phase=?,payload=? WHERE id=?", selected.phase, canonicalize(selected), id); project.revision = (BigInt(prior) + 1n).toString(); this.saveProject(project, prior); }); return selected;
  }
  private transition(publication: PublicationRecord, project: ProjectRecord, event: string, verified = false): void {
    const transition = JSON.parse(getKernel().transition_publication(canonicalize({ phase: publication.phase, gate: project.gate, event, verified }))) as { accepted: boolean; phase: PublicationRecord["phase"]; gate: ProjectRecord["gate"]; reason: string };
    requireValue(transition.accepted, transition.reason, 409); publication.phase = transition.phase; project.gate = transition.gate;
  }
  private async sign<T>(kind: "enrollment" | "admission" | "publication" | "checkpoint", predicate: T, authorityRevision = this.project().revision, selectedTrust = this.trust()): Promise<Envelope> {
    const root = kind === "enrollment" || kind === "checkpoint"; const secret = root ? this.env.ROOT_SIGNING_KEY : this.env.AUTHORITY_SIGNING_KEY; const keyId = root ? this.env.ROOT_KEY_ID : this.env.AUTHORITY_KEY_ID; requireValue(secret && keyId, "SIGNER_NOT_CONFIGURED", 409);
    const privateKey = await crypto.subtle.importKey("pkcs8", decodeBase64(secret).slice().buffer, "Ed25519", false, ["sign"]);
    try { const envelope = await signIssued({ trust: selectedTrust, kind, record: predicate, role: root ? "root" : "authority", keyId, privateKey, authorityRevision, ...(kind === "publication" ? { sequence: (predicate as LogicalReceipt).sequence } : {}) }); if (kind === "admission" || kind === "publication") assertPortableIssued(envelope); return envelope; }
    catch (error) { throw new PlatformError(error instanceof Error ? error.message : "SIGNER_UNAUTHORIZED", 409); }
  }

  private receiptHistory(before: string): Envelope[] {
    const rows = this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM receipts WHERE length(sequence) < length(?) OR (length(sequence)=length(?) AND sequence<?) ORDER BY length(sequence),sequence LIMIT ?", before, before, before, PORTABLE_HISTORY_LIMIT + 1).toArray();
    requireValue(rows.length <= PORTABLE_HISTORY_LIMIT, "PORTABLE_HISTORY_CAPACITY", 409);
    return rows.map(row => (JSON.parse(row.payload) as { envelope: Envelope }).envelope);
  }
  private assertEndorsementCapacity(additional?: Envelope): void {
    // A disclosed bounded pilot profile: all retained endorsements fit the
    // reserved bundle allowance, including later compromise rehabilitation.
    const rows = this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM records WHERE kind IN ('attestation-endorsement','publication-endorsement') LIMIT 129").toArray();
    requireValue(rows.length <= 128, "PORTABLE_ENDORSEMENT_CAPACITY", 413);
    const envelopes = [...new Map(rows.map(row => { const envelope = (JSON.parse(row.payload) as { envelope: Envelope }).envelope; return [hash(envelope), envelope] as const; })).values()];
    if (additional && !envelopes.some(envelope => hash(envelope) === hash(additional))) envelopes.push(additional);
    assertPortableEndorsements(envelopes);
  }
  private async portableBundle(publication: PublicationRecord): Promise<VerificationBundle> {
    const project = this.project(); requireValue(publication.phase === "FINALIZED" && publication.admission && publication.envelope, "PUBLICATION_NOT_FINALIZED", 409);
    const candidate = this.record<CandidateRecord>("candidate", publication.candidateId);
    const evidence = publication.witness.evidence.map(item => this.record<Envelope>("evidence-envelope-digest", item.digest));
    const observations = await Promise.all(publication.witness.evidence.map(async item => ({ digest: item.observationDigest, dataBase64: encodeBase64(await this.objects.get(item.observationDigest, MAX_CONTROL_BYTES)) })));
    const gitObjects = JSON.parse(new TextDecoder().decode(await this.objects.get(candidate.source.objectsDigest, 8 * 1024 * 1024))) as VerificationBundle["inputs"]["gitObjects"];
    const history = this.receiptHistory(publication.sequence);
    const includedDigests = new Set([project.enrollmentDigest, publication.logicalDigest!, hash((JSON.parse(new TextDecoder().decode(decodeBase64(publication.admission.payload))).predicate as { record?: unknown }).record ?? JSON.parse(new TextDecoder().decode(decodeBase64(publication.admission.payload))).predicate), ...publication.witness.evidence.map(item => hash(item)), ...history.map(envelope => { const predicate = JSON.parse(new TextDecoder().decode(decodeBase64(envelope.payload))).predicate; return hash(predicate.schemaVersion === 2 ? predicate.record : predicate); })]);
    const endorsements = [...this.records<{ publicationId: string; logicalDigest: string; envelope: Envelope }>("publication-endorsement").filter(item => includedDigests.has(item.logicalDigest)).map(item => item.envelope), ...this.records<{ recordDigest: string; envelope: Envelope }>("attestation-endorsement").filter(item => includedDigests.has(item.recordDigest)).map(item => item.envelope)];
    const uniqueEndorsements = [...new Map(endorsements.map(envelope => [hash(envelope), envelope])).values()];
    assertPortableEndorsements(uniqueEndorsements);
    const bundle: VerificationBundle = { schemaVersion: 1, ...(uniqueEndorsements.length ? { endorsements: uniqueEndorsements } : {}), enrollment: project.enrollment, admission: publication.admission, publication: publication.envelope, evidence, history, inputs: { witness: publication.witness, manifest: candidate.source.manifest, gitObjects, observations } };
    requireValue(portableBytes(bundle) <= PORTABLE_BUNDLE_BYTES, "PORTABLE_BUNDLE_SIZE_LIMIT", 413); return bundle;
  }

  private async completePendingCapsules(commit: string): Promise<void> {
    for (const pending of this.records<{ attemptId: string; generation: string; input: ContextCapsuleInput }>("pending-context-capsule").filter(item => item.input.sourceCommit === commit)) {
      try { await this.retainRuntimeCapsule(this.record<AttemptRecord>("attempt", pending.attemptId), pending.input); }
      catch (error) { if (!(error instanceof PlatformError) || error.status >= 500) throw error; this.retain("context-capture-rejection", pending.input.id, { attemptId: pending.attemptId, code: error.code }); }
    }
  }
  private pendingCleanupEffects(attemptId: string): boolean {
    if (this.project().unresolvedPublicationId !== null) return true;
    return Boolean(this.row("SELECT id FROM outbox WHERE state='PENDING' AND ((kind IN ('start-attempt','stop-attempt','ingest-submission') AND json_extract(payload,'$.attemptId')=?) OR (kind='provision-attempt' AND json_extract(payload,'$.attempt.id')=?) OR kind='materialize') LIMIT 1", attemptId, attemptId));
  }

  private async cleanupAttempt(id: string): Promise<CleanupRecord> {
    const row = this.row<{ payload: string }>("SELECT payload FROM cleanups WHERE id=?", id); requireValue(row, "REFERENCE_UNAVAILABLE", 404);
    const cleanup = JSON.parse(row.payload) as CleanupRecord; const attempt = this.record<AttemptRecord>("attempt", cleanup.attemptId);
    requireValue(attempt.generation === cleanup.generation && attempt.repoName === cleanup.repository && canonicalize(cleanup.scope) === canonicalize(this.project().scope), "CLEANUP_ASSOCIATION_CONFLICT", 409);
    const canonicalRepo = this.project().canonicalRepo;
    return advanceCleanup(cleanup, {
      fenced: () => Boolean(this.row("SELECT id FROM grants WHERE id=? AND revoked=1 AND generation=?", attempt.grantId, cleanup.generation)) && this.record<AttemptRecord>("attempt", attempt.id).generation === cleanup.generation,
      terminationObserved: async () => Boolean(this.row("SELECT id FROM records WHERE kind='runtime-observation' AND json_extract(payload,'$.attemptId')=? AND json_extract(payload,'$.generation')=? AND json_extract(payload,'$.verified')=1 AND json_extract(payload,'$.lifecycle')='STOPPED' LIMIT 1", attempt.id, cleanup.generation)),
      pendingAttemptEffects: () => this.pendingCleanupEffects(attempt.id),
      repositoryPresent: () => this.repository.attemptPresent(canonicalRepo, attempt.id, attempt.repoName),
      revokeCredentials: () => this.repository.revokeAttemptCredentials(canonicalRepo, attempt.id, attempt.repoName),
      removeAuxiliaryResources: async () => "NOT_CONFIGURED",
      verifyArchive: () => this.verifyCleanupArchive(cleanup.id),
      deleteRepository: () => this.repository.deleteAttempt(canonicalRepo, attempt.id, attempt.repoName),
      save: async updated => { this.ctx.storage.transactionSync(() => {
        const previous = this.row<{ payload: string }>("SELECT payload FROM cleanups WHERE id=?", updated.id)!;
        const retained = JSON.parse(previous.payload) as CleanupRecord;
        requireValue(retained.attemptId === updated.attemptId && retained.generation === updated.generation && retained.repository === updated.repository, "CLEANUP_ASSOCIATION_CONFLICT", 409);
        if (previous.payload === canonicalize(updated)) return;
        this.ctx.storage.sql.exec("UPDATE cleanups SET phase=?,payload=? WHERE id=? AND generation=?", updated.phase, canonicalize(updated), updated.id, updated.generation);
        const state = this.project(), revision = state.revision; state.revision = (BigInt(revision) + 1n).toString(); this.saveProject(state, revision);
        if (retained.phase !== updated.phase) this.event(state, "cleanup-progress", updated.id, { attemptId: updated.attemptId, generation: updated.generation, phase: updated.phase });
      }); },
      now,
    });
  }

  private async verifyCleanupArchive(id: string): Promise<{ complete: boolean; digest?: string; objects?: number }> {
    const project = this.project(); const trust = this.trust(project);
    // Rowid watermarks describe a finite immutable inventory. Any new record,
    // evidence, final receipt or trust/head change invalidates the selection.
    // Cursors are consumed before awaits; no SQLite cursor crosses external I/O.
    const selection = () => {
      const state = this.project();
      return { records: this.row<{ n: number }>("SELECT COALESCE(MAX(rowid),0) AS n FROM records")!.n,
        evidence: this.row<{ n: number }>("SELECT COALESCE(MAX(rowid),0) AS n FROM evidence")!.n,
        receipts: this.row<{ n: number }>("SELECT COALESCE(MAX(rowid),0) AS n FROM publications WHERE phase='FINALIZED'")!.n,
        head: state.head, enrollmentDigest: state.enrollmentDigest, trustDigest: hash(this.trust(state)) };
    };
    const selected = selection(); const snapshotDigest = hash(selected);
    const enrollmentHead = this.enrollmentRecord(project).head;
    requireValue(this.row("SELECT id FROM records WHERE kind='source' AND id=?", selected.head) && this.row("SELECT id FROM records WHERE kind='source' AND id=?", enrollmentHead), "REQUIRED_SOURCE_ARCHIVE_MISSING", 409);
    type Progress = { version: 2; snapshotDigest: string; stage: 'records' | 'evidence' | 'receipts' | 'complete'; after: number; source: CleanupArchiveCursor | null; chain: string; objects: number };
    const previous = this.row<{ payload: string }>("SELECT payload FROM cleanup_archives WHERE cleanup_id=?", id);
    let progress: Progress = previous ? JSON.parse(previous.payload) as Progress : { version: 2, snapshotDigest, stage: 'records', after: 0, source: null, chain: snapshotDigest, objects: 0 };
    if (progress.version !== 2 || progress.snapshotDigest !== snapshotDigest) progress = { version: 2, snapshotDigest, stage: 'records', after: 0, source: null, chain: snapshotDigest, objects: 0 };
    const save = () => this.ctx.storage.sql.exec("INSERT INTO cleanup_archives(cleanup_id,payload) VALUES(?,?) ON CONFLICT(cleanup_id) DO UPDATE SET payload=excluded.payload", id, canonicalize(progress));
    const pin = (references: string[]) => { for (const reference of new Set(references)) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO pins(owner,digest) VALUES(?,?)", id, reference); };
    const completeRow = (rowid: number, recordDigest: string, objects: number) => { progress.chain = hash({ predecessor: progress.chain, stage: progress.stage, rowid, recordDigest }); progress.after = rowid; progress.objects += objects; progress.source = null; save(); };
    try {
      if (progress.stage === 'records') {
        const rows = this.ctx.storage.sql.exec<{ rowid: number; kind: string; payload: string }>("SELECT rowid,kind,payload FROM records WHERE rowid>? AND rowid<=? AND kind IN ('source','attempt','evidence-contradiction','pending-context-capsule','context-capsule','attestation-endorsement','publication-endorsement','runtime-observation') ORDER BY rowid LIMIT 4", progress.after, selected.records).toArray();
        for (const row of rows) {
          const record = JSON.parse(row.payload);
          if (row.kind === 'source') {
            const source = record as import('./artifacts').RepositorySnapshot;
            pin([source.manifestDigest, source.objectsDigest, ...source.manifest.entries.map(entry => entry.digest)]);
            const archive = await verifySourceArchive([source], [], this.objects, progress.source, 16);
            progress.source = archive.cursor; save();
            if (!archive.complete) return { complete: false };
            completeRow(row.rowid, hash(record), archive.objects);
          } else {
            let references: string[];
            if (row.kind === 'attempt') {
              requireValue(this.row("SELECT id FROM records WHERE kind='source' AND id=?", record.workBase) && this.row("SELECT id FROM records WHERE kind='source' AND id=?", record.publicationBase), "REQUIRED_SOURCE_ARCHIVE_MISSING", 409);
              references = [];
            } else if (row.kind === 'evidence-contradiction') references = [record.observationDigest, hash(this.record<Envelope>('evidence-envelope-digest', record.digest))];
            else if (row.kind.endsWith('endorsement')) references = [record.envelopeDigest];
            else if (row.kind === 'runtime-observation') references = record.logsDigest ? [record.logsDigest] : [];
            else { const capsule = row.kind === 'pending-context-capsule' ? record.input : record; references = [capsule.renderedContextDigest, capsule.sourceManifestDigest, capsule.sessionDigest, capsule.partialSessionDigest, capsule.diagnosticDigest, capsule.sourceAdvisoryDigest].filter((reference): reference is string => reference != null); }
            pin(references); for (const reference of new Set(references)) await this.objects.get(reference, MAX_MANIFEST_BYTES);
            completeRow(row.rowid, hash(record), new Set(references).size);
          }
        }
        if (rows.length === 4) return { complete: false };
        progress.stage = 'evidence'; progress.after = 0; save(); return { complete: false };
      }
      if (progress.stage === 'evidence') {
        const rows = this.ctx.storage.sql.exec<{ rowid: number; payload: string }>("SELECT rowid,payload FROM evidence WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 8", progress.after, selected.evidence).toArray();
        for (const row of rows) {
          const evidence = JSON.parse(row.payload) as AdmissionEvidence;
          const references = [evidence.observationDigest, hash(this.record<Envelope>('evidence-envelope-digest', evidence.digest))];
          pin(references); for (const reference of references) await this.objects.get(reference, MAX_CONTROL_BYTES);
          completeRow(row.rowid, hash(evidence), references.length);
        }
        if (rows.length === 8) return { complete: false };
        progress.stage = 'receipts'; progress.after = 0; save(); return { complete: false };
      }
      if (progress.stage === 'receipts') {
        const rows = this.ctx.storage.sql.exec<{ rowid: number; payload: string }>("SELECT rowid,payload FROM publications WHERE phase='FINALIZED' AND rowid>? AND rowid<=? ORDER BY rowid LIMIT 1", progress.after, selected.receipts).toArray();
        for (const row of rows) {
          const publication = JSON.parse(row.payload) as PublicationRecord;
          requireValue(publication.logicalDigest && publication.envelopeDigest && publication.preparedDigest && publication.envelope, "INCOMPLETE_ACCEPTED_RECEIPT", 409);
          pin([publication.witnessDigest, publication.envelopeDigest]);
          const journalBytes = await this.objects.getJournal(`journal/${project.scope.projectIncarnation}/${publication.id}/receipt`, publication.envelopeDigest);
          requireValue(journalBytes, "REQUIRED_RECEIPT_JOURNAL_MISSING", 409);
          requireValue(new TextDecoder().decode(journalBytes) === canonicalize(publication.envelope), "RECEIPT_JOURNAL_MISMATCH", 409);
          const prepared = await this.objects.getJournal(`journal/${project.scope.projectIncarnation}/${publication.id}/prepared`, publication.preparedDigest);
          requireValue(prepared, "REQUIRED_PREPARED_JOURNAL_MISSING", 409);
          await this.objects.get(publication.witnessDigest, MAX_CONTROL_BYTES);
          const verified = verifyBundle(await this.portableBundle(publication), trust, { schemaVersion: 1, scope: project.scope, enrollmentDigest: project.enrollmentDigest, sequence: publication.sequence, receiptDigest: publication.logicalDigest });
          requireValue(verified.valid && verified.receiptDigest === publication.logicalDigest, "ARCHIVED_RECEIPT_INVALID", 409);
          completeRow(row.rowid, publication.logicalDigest, 3);
        }
        if (rows.length) return { complete: false };
        progress.stage = 'complete'; save();
      }
      // The cleanup state machine also rechecks grant/effect fences immediately
      // before deletion. Never certify a cursor against a changed dependency set.
      if (hash(selection()) !== snapshotDigest) return { complete: false };
      return { complete: true, digest: hash({ snapshotDigest, archiveDigest: progress.chain }), objects: progress.objects };
    } catch (error) {
      if (!(error instanceof PlatformError) || error.status < 500 && error.status !== 408 && error.status !== 429) throw error;
      console.log(JSON.stringify({ type: "cleanup-archive-incomplete", cleanupId: id, code: error.code })); return { complete: false };
    }
  }

  private async publish(id: string, dispatch: boolean): Promise<void> {
    let publication = this.publication(id); if (publication.phase === "FINALIZED") return;
    const project = this.project(); const candidate = this.record<CandidateRecord>("candidate", publication.candidateId);
    if (publication.phase === "ADMITTED") {
      const decision = evaluateAdmission(publication.witness); requireValue(decision.accepted && decision.delta, "STORED_ADMISSION_INCONSISTENT", 409);
      const record = { schemaVersion: 1, scope: project.scope, operationId: id, witnessDigest: publication.witnessDigest, proposalDigest: publication.proposalDigest,
        candidateDigest: candidate.digest, oldHead: publication.oldHead, newHead: publication.newHead, sequence: publication.sequence, delta: decision.delta };
      const fixed = { operationId: id, scope: project.scope, enrollmentDigest: project.enrollmentDigest, sequence: publication.sequence, predecessorReceiptDigest: project.previousReceiptDigest,
        oldHead: publication.oldHead, newHead: publication.newHead, candidateDigest: candidate.digest, objectsDigest: candidate.source.objectsDigest, manifestDigest: candidate.manifestDigest, proposalDigest: publication.proposalDigest, witnessDigest: publication.witnessDigest };
      const journalKey = `journal/${project.scope.projectIncarnation}/${id}/prepared`;
      if (!publication.preparedDescriptor) {
        // Upgrade recovery: an earlier version could write R2 before recording
        // its exact descriptor in SQLite. Reuse only a fully checked journal.
        const prior = await this.objects.getJournal(journalKey);
        let descriptor: PreparedPublicationDescriptor;
        if (prior) {
          descriptor = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(prior)) as PreparedPublicationDescriptor;
          requireValue(descriptor && typeof descriptor === "object" && canonicalize(descriptor) === canonicalize({ ...fixed, admission: descriptor.admission, authorityRevision: descriptor.authorityRevision }), "PREPARED_JOURNAL_MISMATCH", 409);
          counter(descriptor.authorityRevision);
          requireValue(BigInt(descriptor.authorityRevision) >= BigInt(publication.witness.state.revision) && BigInt(descriptor.authorityRevision) <= BigInt(this.project().revision), "PREPARED_JOURNAL_REVISION_MISMATCH", 409);
          const verified = verifyAttestation({ trust: this.trust(), envelope: descriptor.admission, kind: "admission", role: "authority", authorityRevision: publication.witness.state.revision, sequence: publication.sequence, allowLegacy: true });
          requireValue(verified.valid && canonicalize(verified.record) === canonicalize(record), "PREPARED_JOURNAL_ADMISSION_INVALID", 409);
        } else descriptor = { ...fixed, admission: await this.sign("admission", record, publication.witness.state.revision), authorityRevision: this.project().revision };
        publication = this.mutatePublication(id, (current, state) => {
          requireValue(current.phase === "ADMITTED", "PUBLICATION_PHASE_CHANGED", 409);
          if (current.preparedDescriptor) return; // A concurrent finalizer already selected it.
          this.assertAttestationAuthorized("admission", record, descriptor.admission, state);
          current.preparedDescriptor = descriptor; current.admission = descriptor.admission;
        });
      }
      const descriptor = publication.preparedDescriptor!;
      requireValue(canonicalize(descriptor) === canonicalize({ ...fixed, admission: descriptor.admission, authorityRevision: descriptor.authorityRevision }), "PREPARED_DESCRIPTOR_MISMATCH", 409);
      this.assertAttestationAuthorized("admission", record, descriptor.admission);
      await this.objects.put(bytes(publication.witness), publication.witnessDigest);
      const preparedDigest = await this.objects.putJournal(journalKey, bytes(descriptor));
      publication = this.mutatePublication(id, (current, state) => {
        requireValue(current.phase === "ADMITTED" && hash(current.preparedDescriptor) === preparedDigest, "PUBLICATION_PHASE_CHANGED", 409);
        this.assertAttestationAuthorized("admission", record, descriptor.admission, state);
        current.admission = descriptor.admission; current.preparedDigest = preparedDigest; this.transition(current, state, "PREPARED", true);
      });
    }
    if (dispatch && publication.phase === "READY") {
      const predicate = JSON.parse(new TextDecoder().decode(decodeBase64(publication.admission!.payload))).predicate; this.assertAttestationAuthorized("admission", predicate.schemaVersion === 2 ? predicate.record : predicate, publication.admission!);
      for (const item of publication.witness.evidence) this.assertAttestationAuthorized("evidence", item, this.record<Envelope>("evidence-envelope-digest", item.digest));
      requireValue(this.env.MAINTENANCE_MODE !== "true" && this.env.CONDITIONAL_PUBLICATION_VERIFIED === "true", "PUBLISHER_FENCED", 503);
      publication = this.mutatePublication(id, (current, state) => { current.dispatchMayHaveOccurred = true; current.dispatchAttemptIds.push(crypto.randomUUID()); this.transition(current, state, "DISPATCH"); });
      try { await this.repository.conditionalPublish(project.canonicalRepo, { oldHead: publication.oldHead, newHead: publication.newHead, canonicalRef: project.canonicalRef, objectsDigest: candidate.source.objectsDigest }); }
      catch { publication = this.mutatePublication(id, (current, state) => { current.reason = "REMOTE_EFFECT_UNKNOWN"; this.transition(current, state, "AMBIGUOUS"); }); }
    }
    const head = await this.repository.head(project.canonicalRepo, project.canonicalRef);
    if (head === publication.oldHead) { if (publication.dispatchMayHaveOccurred) this.mutatePublication(id, (current, state) => { current.reason = "OLD_HEAD_DOES_NOT_PROVE_CANCELLATION"; this.transition(current, state, "OBSERVE_OLD"); }); return; }
    if (head !== publication.newHead) { this.mutatePublication(id, (current, state) => { current.reason = "CANONICAL_DIVERGENCE"; this.transition(current, state, "DIVERGENCE"); }); return; }
    const observed = await this.repository.ingest(project.canonicalRepo, project.canonicalRef, publication.newHead);
    if (observed.manifestDigest !== candidate.manifestDigest || observed.commitBytesDigest !== candidate.source.commitBytesDigest) { this.mutatePublication(id, (current, state) => { current.reason = "PUBLICATION_CONTENT_MISMATCH"; this.transition(current, state, "DIVERGENCE"); }); return; }
    publication = this.mutatePublication(id, (current, state) => { if (current.phase !== "OBSERVED" && current.phase !== "RECEIPT_DURABLE") { this.transition(current, state, "OBSERVE_NEW", true); current.observationTime = now(); } });
    if (publication.phase === "OBSERVED") {
      const logical: LogicalReceipt = publication.logical ?? { schemaVersion: 1, scope: project.scope, operationId: id, sequence: publication.sequence, enrollmentDigest: project.enrollmentDigest, predecessorReceiptDigest: project.previousReceiptDigest, authorityRevision: this.project().revision,
        oldHead: publication.oldHead, newHead: publication.newHead, candidateDigest: candidate.digest, manifestDigest: candidate.manifestDigest, proposalDigest: publication.proposalDigest, witnessDigest: publication.witnessDigest, evidenceDigests: publication.witness.proposal.evidenceDigests,
        outcome: "PUBLISHED", limitations: ["Authority-attested recorded state; remote publication independently observed by repository adapter."] };
      const logicalDigest = await digest(logical);
      publication = this.mutatePublication(id, current => { requireValue(!current.logicalDigest || current.logicalDigest === logicalDigest, "RECEIPT_SINGLE_ASSIGNMENT", 409); current.logical = logical; current.logicalDigest = logicalDigest; });
      const envelope = await this.sign("publication", logical, logical.authorityRevision); const envelopeDigest = await this.objects.putJournal(`journal/${project.scope.projectIncarnation}/${id}/receipt`, bytes(envelope));
      publication = this.mutatePublication(id, (current, state) => { const verified = verifyAttestation({ trust: this.trust(state), envelope, role: "authority", kind: "publication", authorityRevision: logical.authorityRevision, sequence: logical.sequence, allowLegacy: false }); requireValue(verified.valid, "SIGNER_AUTHORIZATION_CHANGED", 409); if (!current.envelopeDigest) { current.envelope = envelope; current.envelopeDigest = envelopeDigest; } this.transition(current, state, "RECEIPT_SAVED", true); });
    }
    if (publication.phase === "RECEIPT_DURABLE") this.mutatePublication(id, (current, state) => {
      requireValue(current.envelopeDigest && current.logicalDigest && current.logical && current.envelope, "RECEIPT_NOT_DURABLE", 409);
      this.transition(current, state, "FINALIZE", true); this.ctx.storage.sql.exec("INSERT OR IGNORE INTO receipts(sequence,logical_digest,publication_id,envelope_digest,payload) VALUES(?,?,?,?,?)", current.sequence, current.logicalDigest, id, current.envelopeDigest, canonicalize({ logical: current.logical, envelope: current.envelope }));
      this.ctx.storage.sql.exec("UPDATE publications SET unresolved=0 WHERE id=?", id); state.head = current.newHead; state.publicationSequence = current.sequence; state.previousReceiptDigest = current.logicalDigest; state.unresolvedPublicationId = null;
      this.event(state, "publication-finalized", id, { newHead: current.newHead, receiptDigest: current.logicalDigest });
    });
  }

  async alarm(): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const expired = this.ctx.storage.sql.exec<{ id: string; attempt_id: string; generation: string }>("SELECT id,attempt_id,generation FROM grants WHERE revoked=0 AND expires_at<=?", now()).toArray();
      if (expired.length) { const project = this.project(); const revision = project.revision;
        for (const grant of expired) { this.ctx.storage.sql.exec("UPDATE grants SET revoked=1 WHERE id=?", grant.id); this.effect(`${grant.id}-expiry-stop`, "stop-attempt", { scope: project.scope, attemptId: grant.attempt_id, generation: grant.generation }); this.event(project, "grant-expired-stop-requested", grant.attempt_id, { grantId: grant.id }); }
        project.revision = (BigInt(revision) + 1n).toString(); this.saveProject(project, revision);
      }
    });
    // Rotate failed deliveries behind work that has had fewer attempts. One
    // unavailable service must not occupy the entire batch forever and prevent
    // a later cancellation or projection from reaching an available service.
    const tasks = this.ctx.storage.sql.exec<{ id: string; kind: string; payload: string }>("SELECT id,kind,payload FROM outbox WHERE state='PENDING' ORDER BY attempts,rowid LIMIT 8").toArray();
    // Persist the next wakeup before any external operation. A timeout is an
    // unknown delivery: keep its fixed identity and let the recipient dedup.
    if (tasks.length) await this.ctx.storage.setAlarm(Date.now() + 5000);
    for (const task of tasks) {
      try {
        const payload = JSON.parse(task.payload) as Record<string, unknown>;
        if (task.kind === "projection" || task.kind === "projection-replay") await withinDeadline(() => this.env.EVENTS.send(payload as unknown as ProjectionEvent), 5000);
        else if (task.kind === "publish" || task.kind === "reconcile") await this.publish(string(payload.publicationId), task.kind === "publish");
        else if (task.kind === "evaluate") { const response = await boundedServiceFetch(this.env.EVALUATOR, "https://evaluator.internal/internal/evaluate", { method: "POST", headers: { authorization: `Bearer ${this.env.EVALUATOR_SERVICE_TOKEN}`, "content-type": "application/json" }, body: task.payload }); requireValue(response.ok, "EVALUATOR_UNAVAILABLE", 503); }
        else if (task.kind === "cleanup-attempt") { const cleanup = await this.cleanupAttempt(string(payload.cleanupId)); if (!["TOMBSTONED", "RECOVERY_HOLD"].includes(cleanup.phase)) { this.ctx.storage.sql.exec("UPDATE outbox SET attempts=attempts+1 WHERE id=?", task.id); continue; } }
        else if (task.kind === "provision-attempt") {
          const attempt = payload.attempt as AttemptRecord; const project = this.project(); const source = this.record<import("./artifacts").RepositorySnapshot>("source", attempt.workBase);
          if (this.collaborators.enabled(project.scope)) this.checkGrant(project, attempt, attempt.subject, "read-source", null, "0");
          const previous = this.row<{ payload: string }>("SELECT payload FROM records WHERE kind='provisioning' AND id=?", attempt.id);
          let provisioned: { name: string; remote: string; workBase: string; initialTokensRevoked: boolean };
          if (previous) { provisioned = JSON.parse(previous.payload); requireValue(provisioned.workBase === attempt.workBase && provisioned.name === attempt.repoName && provisioned.initialTokensRevoked, "PROVISIONING_ASSOCIATION_CONFLICT", 409); }
          else { const dispatchMarker = { canonicalRepo: project.canonicalRepo, attemptName: attempt.repoName, workBase: attempt.workBase };
            const priorForkDispatch = this.row<{ payload: string }>("SELECT payload FROM records WHERE kind='fork-dispatch' AND id=?", attempt.id);
            if (priorForkDispatch) requireValue(canonicalize(JSON.parse(priorForkDispatch.payload)) === canonicalize(dispatchMarker), "FORK_DISPATCH_IDENTITY_CONFLICT", 409);
            const fork = await this.repository.fork(project.canonicalRepo, attempt.repoName, {
              allowed: !priorForkDispatch,
              before: () => this.retain("fork-dispatch", attempt.id, dispatchMarker),
            });
            if (this.collaborators.enabled(this.project().scope)) this.checkGrant(this.project(), attempt, attempt.subject, "read-source", null, "0");
            await this.repository.installWorkRef(attempt.repoName, source);
            provisioned = { ...fork, workBase: attempt.workBase, initialTokensRevoked: true }; this.retain("provisioning", attempt.id, provisioned);
          }
          // A lost runner response reuses the installed base marker. It must not
          // overwrite or reject a work ref that the authorized agent later moved.
          if (this.collaborators.enabled(this.project().scope)) this.checkGrant(this.project(), attempt, attempt.subject, "read-source", null, "0");
          const response = await boundedServiceFetch(this.env.RUNNER, "https://runner.internal/internal/provision", { method: "POST", headers: { authorization: `Bearer ${this.env.RUNNER_SERVICE_TOKEN}`, "content-type": "application/json" }, body: canonicalize({ scope: project.scope, attempt: { ...attempt, remote: provisioned.remote, source } }) }); requireValue(response.ok, "RUNNER_UNAVAILABLE", 503);
        } else if (task.kind === "stop-attempt" || task.kind === "start-attempt") {
          if (task.kind === "start-attempt" && this.collaborators.enabled(this.project().scope)) {
            const attempt = this.record<AttemptRecord>("attempt", string(payload.attemptId)); this.checkGrant(this.project(), attempt, attempt.subject, "start-execution", null, "0");
          }
          const response = await boundedServiceFetch(this.env.RUNNER, `https://runner.internal/internal/${task.kind === "stop-attempt" ? "stop" : "start"}`, { method: "POST", headers: { authorization: `Bearer ${this.env.RUNNER_SERVICE_TOKEN}`, "content-type": "application/json" }, body: task.payload }); requireValue(response.ok, "RUNNER_UNAVAILABLE", 503);
        }
        else if (task.kind === "weft-handoff") await this.freezeWeftHandoff(string(payload.handoffId));
        else if (task.kind === "ingest-submission") {
          if (this.row("SELECT id FROM records WHERE kind='submission' AND id=?", string(payload.submissionId))) { await this.completePendingCapsules(string(payload.commit)); this.ctx.storage.sql.exec("UPDATE outbox SET state='DELIVERED' WHERE id=?", task.id); continue; }
          const attempt = this.record<AttemptRecord>("attempt", string(payload.attemptId)); const source = await this.repository.ingest(attempt.repoName, string(payload.ref), string(payload.commit));
          const base = this.record<import("./artifacts").RepositorySnapshot>("source", attempt.workBase);
          const prior = new Map(base.manifest.entries.map(entry => [entry.path, entry])); const current = new Map(source.manifest.entries.map(entry => [entry.path, entry]));
          this.ctx.storage.transactionSync(() => { const project = this.project(); const grant = payload.grant as GrantRecord; requireValue(grant && grant.attemptId === attempt.id && grant.generation === attempt.generation, "SUBMISSION_ADMISSION_MISSING", 409);
            for (const path of new Set([...prior.keys(), ...current.keys()])) if (canonicalize(prior.get(path) ?? null) !== canonicalize(current.get(path) ?? null)) {
              const validation = JSON.parse(getKernel().validate_grant(canonicalize({ grant: { scope: project.scope, id: grant.id, subjectId: grant.subject, attemptId: grant.attemptId, generation: grant.generation, authorityGeneration: grant.authorityGeneration, operations: grant.operations, resources: grant.resources, pathPrefixes: grant.pathPrefixes, destinations: grant.destinations, startsAt: grant.expiresAt - 600, expiresAt: grant.expiresAt, budgetMicroUnits: grant.maximumBudget, revoked: false }, currentScope: project.scope, subjectId: attempt.subject, attemptId: attempt.id, currentGeneration: attempt.generation, currentAuthorityGeneration: "1", operation: "write-attempt", resource: attempt.id, path, destination: null, now: Number(payload.admittedAt), maximumCost: "0", availableBudget: grant.maximumBudget }))) as { accepted: boolean; reason: string }; requireValue(validation.accepted, validation.reason, 403);
            }
            this.retain("source", source.commit, { ...source, objects: [] });
            this.retain("submission", string(payload.submissionId), { attemptId: attempt.id, source: { ...source, objects: [] }, admittedAt: now() });
            if (payload.individualEvaluation === true) { const id = `${attempt.id}-individual`; this.effect(id, "materialize", { scope: project.scope, candidateId: id, submissionIds: [string(payload.submissionId)], sources: [{ attemptId: attempt.id, source: { ...source, objects: [] } }], publicationBase: project.head, recipe: [string(payload.submissionId)], timestamp: Number(payload.admittedAt), evaluate: true, contract: attempt.workBase === attempt.publicationBase ? "freshness" : "full" }); }
            const cohort = this.records<AttemptRecord>("attempt").filter(item => item.workBase === item.publicationBase && item.publicationBase === project.head);
            const pair = [cohort.find(item => item.allowedPaths?.length === 1 && item.allowedPaths[0] === "cache.mjs"), cohort.find(item => item.allowedPaths?.length === 1 && item.allowedPaths[0] === "mutation.mjs")];
            const ready = pair.map(item => item ? this.ctx.storage.sql.exec<{ id: string; payload: string }>("SELECT id,payload FROM records WHERE kind='submission' ORDER BY id").toArray().map(row => ({ id: row.id, ...JSON.parse(row.payload) as { attemptId: string; source: import("./artifacts").RepositorySnapshot } })).find(submission => submission.attemptId === item.id) : undefined);
            if (ready.every(Boolean)) {
              const controls = ready.map(item => item!).sort((a, b) => a.id.localeCompare(b.id)); const id = `interaction-${project.scope.projectIncarnation}`;
              if (!this.row("SELECT id FROM outbox WHERE id=?", id)) this.effect(id, "materialize", { scope: project.scope, candidateId: id, submissionIds: controls.map(item => item.id), sources: controls.map(item => ({ attemptId: item.attemptId, source: item.source })), publicationBase: project.head, recipe: ["controlled-A-plus-B", ...controls.map(item => item.id)], timestamp: Number(payload.admittedAt), evaluate: true, contract: "freshness" });
            }
            const revision = project.revision; project.revision = (BigInt(revision) + 1n).toString(); this.saveProject(project, revision); this.event(project, "submission-ready", string(payload.submissionId), { attemptId: attempt.id, commit: source.commit }); });
          await this.completePendingCapsules(source.commit);
        } else if (task.kind === "materialize") {
          if (this.row("SELECT id FROM records WHERE kind='candidate' AND id=?", string(payload.candidateId))) { this.ctx.storage.sql.exec("UPDATE outbox SET state='DELIVERED' WHERE id=?", task.id); continue; }
          const project = this.project(); const sources = payload.sources as { attemptId: string; source: import("./artifacts").RepositorySnapshot }[];
          const base = this.record<import("./artifacts").RepositorySnapshot>("source", string(payload.publicationBase));
          const materializationSources = sources.map(item => { const attempt = this.record<AttemptRecord>("attempt", item.attemptId); return { id: item.attemptId, source: item.source, base: this.record<import("./artifacts").RepositorySnapshot>("source", attempt.publicationBase) }; });
          const source = await this.repository.materialize(base, materializationSources, string(payload.candidateId), Number(payload.timestamp));
          const inherited = sources.flatMap(item => { const attempt = this.record<AttemptRecord>("attempt", item.attemptId); return this.records<CandidateRecord>("candidate").find(candidate => candidate.commit === attempt.workBase)?.contributorIds ?? []; });
          const candidateBase = { scope: project.scope, id: string(payload.candidateId), commit: source.commit, commitBytesDigest: source.commitBytesDigest, parent: string(payload.publicationBase), manifestDigest: source.manifestDigest, contributorIds: [...new Set([...inherited, ...payload.submissionIds as string[]])].sort(), recipe: payload.recipe as string[] };
          const candidate: CandidateRecord = { ...candidateBase, digest: await digest(candidateBase), source: { ...source, objects: [] } };
          const evaluation = this.evaluationContext(project, `${candidate.id}-evaluation`);
          requireValue(!containsTypeScriptSource(source.manifest), "TYPESCRIPT_PROTECTED_PROFILE_UNREGISTERED", 409);
          const plan = payload.evaluate === true ? await makeEvaluationPlan(candidate, this.env.EVALUATION_IMAGE_DIGEST, this.env.CHECKER_IMPLEMENTATION_DIGEST, payload.contract === "freshness" ? "freshness" : "full", project.scope, evaluation) : null;
          this.ctx.storage.transactionSync(() => { const state = this.project(); requireValue(state.head === candidate.parent, "PUBLICATION_BASE_MOVED", 409); this.retain("candidate", candidate.id, candidate); this.retain("source", source.commit, { ...source, objects: [] }); if (plan) this.registerEvaluation(state, evaluation, plan, candidate); const revision = state.revision; state.revision = (BigInt(revision) + 1n).toString(); this.saveProject(state, revision); this.event(state, "candidate-ready", candidate.id, { commit: candidate.commit, manifestDigest: candidate.manifestDigest }); });
        } else throw new PlatformError("UNKNOWN_OUTBOX_EFFECT", 409);
        this.ctx.storage.sql.exec("UPDATE outbox SET state='DELIVERED',attempts=attempts+1 WHERE id=?", task.id);
      } catch (error) {
        if (error instanceof PlatformError && error.status >= 400 && error.status < 500 && (["ingest-submission", "materialize", "weft-handoff"].includes(task.kind)
          || error.status === 403 && ["provision-attempt", "start-attempt"].includes(task.kind) && this.collaborators.enabled(this.project().scope))) {
          this.ctx.storage.transactionSync(() => {
            if (task.kind === "weft-handoff") { const handoff = this.record<WeftHandoff>("weft-handoff", string(JSON.parse(task.payload).handoffId)); this.updateWeftHandoff({ ...handoff, state: "REJECTED", reason: error.code }); }
            this.ctx.storage.sql.exec("UPDATE outbox SET state='REJECTED',attempts=attempts+1 WHERE id=?", task.id); this.event(this.project(), "effect-rejected", task.id, { effect: task.kind, code: error.code });
          });
        } else this.ctx.storage.sql.exec("UPDATE outbox SET attempts=attempts+1 WHERE id=?", task.id);
        console.log(JSON.stringify({ type: "outbox-pending", id: task.id, kind: task.kind, code: error instanceof PlatformError ? error.code : "INFRASTRUCTURE_UNAVAILABLE" }));
      }
    }
    if (this.row("SELECT id FROM outbox WHERE state='PENDING' LIMIT 1")) await this.ctx.storage.setAlarm(Date.now() + 5000);
    else { const next = this.row<{ expiry: number | null }>("SELECT MIN(expires_at) AS expiry FROM grants WHERE revoked=0"); if (next?.expiry) await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, next.expiry * 1000)); }
  }

  async broker(scope: Scope, attemptId: string, generation: string, operation: "git-read" | "git-write", request: Request): Promise<Response> {
    requireValue(this.env.MAINTENANCE_MODE !== "true", "MAINTENANCE_READ_ONLY", 503);
    const project = this.project(); requireValue(canonicalize(scope) === canonicalize(project.scope), "PROJECT_UNAVAILABLE", 404);
    const attempt = this.record<AttemptRecord>("attempt", attemptId); requireValue(attempt.generation === generation, "GRANT_GENERATION_FENCED", 403);
    this.checkGrant(project, attempt, attempt.subject, operation === "git-write" ? "write-attempt" : "read-source", new URL(request.url).hostname, "0");
    const response = await this.repository.gateway(attempt.repoName, request, operation === "git-write");
    if (this.collaborators.enabled(this.project().scope)) this.checkGrant(this.project(), attempt, attempt.subject, operation === "git-write" ? "write-attempt" : "read-source", new URL(request.url).hostname, "0");
    return response;
  }
  async reserveModel(input: { scope: Scope; attemptId: string; generation: string; callId: string; requestDigest: string; maximumCost: string }): Promise<unknown> {
    requireValue(this.env.MAINTENANCE_MODE !== "true", "MAINTENANCE_READ_ONLY", 503);
    let result: unknown; this.ctx.storage.transactionSync(() => {
      const project = this.project(); requireValue(canonicalize(input.scope) === canonicalize(project.scope), "PROJECT_UNAVAILABLE", 404);
      const attempt = this.record<AttemptRecord>("attempt", input.attemptId); requireValue(attempt.generation === input.generation, "GRANT_GENERATION_FENCED", 403);
      const prior = this.row<{ payload: string }>("SELECT payload FROM reservations WHERE id=?", input.callId);
      if (prior) { const retained = JSON.parse(prior.payload) as { requestDigest: string }; requireValue(retained.requestDigest === input.requestDigest, "COMMAND_ID_REUSED", 409); result = { admitted: false, state: "ALREADY_DISPATCHED" }; return; }
      const calls = this.ctx.storage.sql.exec<{ maximum: string }>("SELECT maximum FROM reservations WHERE owner=? AND id != ?", attempt.id, attempt.id).toArray();
      requireValue(calls.length < 4, "MODEL_CALL_LIMIT", 429);
      const row = this.row<{ payload: string }>("SELECT payload FROM grants WHERE id=?", attempt.grantId)!; const grant = JSON.parse(row.payload) as GrantRecord;
      const spent = calls.reduce((sum, item) => sum + BigInt(item.maximum), 0n); requireValue(spent <= BigInt(grant.maximumBudget), "BUDGET_EXHAUSTED", 409);
      this.checkGrant(project, attempt, attempt.subject, "model-inference", "model.internal", counter(input.maximumCost), null, (BigInt(grant.maximumBudget) - spent).toString());
      this.ctx.storage.sql.exec("INSERT INTO reservations(id,owner,maximum,state,payload) VALUES(?,?,?,?,?)", input.callId, attempt.id, input.maximumCost, "DISPATCHED", canonicalize(input));
      this.modelCalls.register(input.callId);
      result = { admitted: true, state: "DISPATCHED", callId: input.callId };
    }); return result;
  }
  private async retainRuntimeCapsule(attempt: AttemptRecord, input: ContextCapsuleInput): Promise<void> {
    const project = this.project(); requireValue(input.id === `${attempt.id}/${attempt.generation}/${input.stage}` && ["rendered", "session"].includes(input.stage), "CAPSULE_IDENTITY_MISMATCH", 409);
    if (this.row("SELECT id FROM records WHERE kind='context-capsule' AND id=?", input.id)) { const prior = this.record<ContextCapsuleRecord>("context-capsule", input.id); for (const [key, value] of Object.entries(input)) requireValue(canonicalize(prior[key as keyof ContextCapsuleRecord]) === canonicalize(value), "CAPSULE_SINGLE_ASSIGNMENT", 409); return; }
    const source = this.record<import("./artifacts").RepositorySnapshot>("source", attempt.workBase);
    const { editableSource: sourceContext, readOnlySource } = await promptSourceContext(attempt, source.manifest, (digest, maximumBytes) => this.objects.get(digest, maximumBytes));
    let diagnostic: unknown = null;
    if (input.diagnosticDigest) { diagnostic = JSON.parse(getKernel().canonical_json(new TextDecoder("utf-8", { fatal: true }).decode(await this.objects.get(input.diagnosticDigest, 32768)))); const observed = diagnostic as { producer?: string; generation?: string; acceptanceEligible?: boolean }; requireValue(observed.producer === "host-observed-authoring-command" && observed.generation === attempt.generation && observed.acceptanceEligible === false, "CAPSULE_DIAGNOSTIC_CLASS", 409); }
    let sourceAdvisory: SourceAdvisory | null = null;
    if (input.sourceAdvisoryDigest) sourceAdvisory = await validateSourceAdvisory(parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(await this.objects.get(input.sourceAdvisoryDigest, SOURCE_ADVISORY_BYTES))), {
      sourceCommit: source.commit, sourceManifestDigest: source.manifestDigest, manifest: source.manifest, assignedPaths: attempt.allowedPaths ?? [], readFile: contentDigest => this.objects.get(contentDigest, 1024 * 1024),
    });
    const retainedConversation = attempt.contextReference ? selectedSession(await this.objects.get(attempt.contextReference.sessionDigest, MAX_CONTROL_BYTES), attempt.contextReference.sessionEntry) : null;
    const expectedPrompt = new TextEncoder().encode(authoringPrompt(attempt, source.manifestDigest, sourceContext, diagnostic, retainedConversation, sourceAdvisory, readOnlySource));
    const actualPrompt = await this.objects.get(input.renderedContextDigest, 192 * 1024);
    requireValue(encodeBase64(actualPrompt) === encodeBase64(expectedPrompt), "CAPSULE_RENDERED_CONTEXT_MISMATCH", 409);
    requireValue(/^[a-f0-9]{40}$/.test(input.sourceCommit), "INVALID_GIT_OID");
    const manifestRaw = await this.objects.get(input.sourceManifestDigest, MAX_MANIFEST_BYTES); const manifestCheck = JSON.parse(getKernel().validate_manifest(new TextDecoder("utf-8", { fatal: true }).decode(manifestRaw))) as { valid: boolean; reason: string }; requireValue(manifestCheck.valid, manifestCheck.reason, 409);
    if (input.stage === "rendered") requireValue(input.sourceCommit === source.commit && input.sourceManifestDigest === source.manifestDigest && input.sessionDigest === null && input.missingSessionTail === true, "CAPSULE_SOURCE_MISMATCH", 409);
    if (input.sessionDigest) { const metadata = sessionMetadata(await this.objects.get(input.sessionDigest, MAX_CONTROL_BYTES)); requireValue(input.stage === "session" && input.sessionFormat === metadata.format && input.sessionId === metadata.sessionId && input.selectedEntry === metadata.selectedEntry && !input.missingSessionTail && input.sessionReadError === null, "CAPSULE_SESSION_MISMATCH", 409); }
    else requireValue(input.sessionFormat === null && input.sessionId === null && input.selectedEntry === null && input.missingSessionTail, "CAPSULE_MISSING_TAIL_REQUIRED", 409);
    if (input.partialSessionDigest) {
      requireValue(input.stage === "session" && !input.sessionDigest && input.missingSessionTail, "CAPSULE_PARTIAL_SESSION_CLASS", 409);
      validatePartialSessionCapture(await this.objects.get(input.partialSessionDigest, MAX_CONTROL_BYTES));
    }
    const checkpointSource = this.row<{ payload: string }>("SELECT payload FROM records WHERE kind='source' AND id=?", input.sourceCommit);
    if (!checkpointSource) {
      this.retain("pending-context-capsule", input.id, { attemptId: attempt.id, generation: attempt.generation, input });
      for (const reference of [input.renderedContextDigest, input.sourceManifestDigest, input.diagnosticDigest, input.sessionDigest, input.sourceAdvisoryDigest, input.partialSessionDigest].filter((value): value is string => typeof value === "string")) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO pins(owner,digest) VALUES(?,?)", `capsule/${input.id}`, reference);
      return;
    }
    requireValue((JSON.parse(checkpointSource.payload) as import("./artifacts").RepositorySnapshot).manifestDigest === input.sourceManifestDigest, "CAPSULE_SOURCE_CORRESPONDENCE_MISMATCH", 409);
    const assignment = this.row<{ payload: string }>("SELECT payload FROM records WHERE kind='assignment-capsule' AND id=?", attempt.id);
    const capsule = { ...input, scope: project.scope, attemptId: attempt.id, goalRevision: attempt.goalRevision, adapter: "pi-sdk-1.0.2-json-proposal-v1", generation: attempt.generation, selectorVersion: "host-rendered-assignment-v1", selectedItems: assignment ? (JSON.parse(assignment.payload) as { selectedItems: unknown[] }).selectedItems : [], producer: "controller-observed" as const, sessionTrustClass: "agent-reported-session" as const, sourceSessionAtomicity: "NOT_ATOMIC" as const };
    this.ctx.storage.transactionSync(() => {
      const current = this.project(); requireValue(canonicalize(current.scope) === canonicalize(project.scope) && this.record<AttemptRecord>("attempt", attempt.id).generation === attempt.generation, "CAPSULE_SCOPE_CHANGED", 409);
      this.retain("context-capsule", input.id, { ...capsule, digest: hash(capsule) });
      for (const reference of [input.renderedContextDigest, input.sourceManifestDigest, input.diagnosticDigest, input.sessionDigest, input.sourceAdvisoryDigest, input.partialSessionDigest].filter((value): value is string => typeof value === "string")) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO pins(owner,digest) VALUES(?,?)", `capsule/${input.id}`, reference);
    });
  }
  async runtimeObservation(input: { scope: Scope; attemptId: string; generation: string; lifecycle: string; outcome: string; verified: boolean; eventId: string; logsDigest?: string; sourceCommit?: string; capsule?: ContextCapsuleInput }): Promise<unknown> {
    const project = this.project(); requireValue(canonicalize(input.scope) === canonicalize(project.scope), "PROJECT_UNAVAILABLE", 404);
    const attempt = this.record<AttemptRecord>("attempt", input.attemptId); requireValue(attempt.generation === input.generation, "GRANT_GENERATION_FENCED", 403);
    this.ctx.storage.transactionSync(() => {
      const prior = this.row<{ digest: string }>("SELECT digest FROM records WHERE kind='runtime-observation' AND id=?", input.eventId);
      if (prior) { requireValue(prior.digest === hash(input), "RUNTIME_OBSERVATION_REUSED", 409); return; }
      this.retain("runtime-observation", input.eventId, input);
      if (input.verified && input.capsule && ["RUNNING", "STOP_REQUESTED"].includes(input.lifecycle)) {
        try { this.checkGrant(project, attempt, attempt.subject, "checkpoint-context", null, "0"); this.retain("runtime-context-admission", input.eventId, { capsule: input.capsule, attemptId: attempt.id, generation: attempt.generation }); }
        catch (error) { if (!(error instanceof PlatformError)) throw error; this.retain("context-capture-rejection", input.eventId, { attemptId: attempt.id, code: error.code }); }
      }
      requireValue(["START_MAY_HAVE_DISPATCHED", "RUNNING", "UNKNOWN", "STOP_REQUESTED", "STOPPED"].includes(input.lifecycle) && ["PENDING", "COMPLETED", "FAILED", "CANCELLED", "BUDGET_EXHAUSTED"].includes(input.outcome), "INVALID_RUNTIME_OBSERVATION");
      const outputAdmissionId = `${attempt.id}/${attempt.generation}`;
      type OutputAdmission = { commit: string; admittedAt: number; grant: GrantRecord };
      if (input.verified && input.lifecycle === "STOP_REQUESTED" && input.outcome === "COMPLETED" && input.sourceCommit) {
        try {
          requireValue(!this.row("SELECT id FROM cleanups WHERE attempt_id=?", attempt.id), "ATTEMPT_CLEANUP_FENCED", 409);
          requireValue(/^[a-f0-9]{40}$/.test(input.sourceCommit), "INVALID_GIT_OID");
          const retained = this.row<{ payload: string }>("SELECT payload FROM records WHERE kind='runtime-output-admission' AND id=?", outputAdmissionId);
          if (retained) requireValue((JSON.parse(retained.payload) as OutputAdmission).commit === input.sourceCommit, "RUNTIME_OUTPUT_CONFLICT", 409);
          else this.retain("runtime-output-admission", outputAdmissionId, { commit: input.sourceCommit, admittedAt: now(), grant: this.checkGrant(project, attempt, attempt.subject, "submit-output", null, "0") } satisfies OutputAdmission);
        } catch (error) { if (!(error instanceof PlatformError)) throw error; this.event(this.project(), "source-submission-rejected", attempt.id, { code: error.code, commit: input.sourceCommit }); }
      }
      if (input.verified && ["UNKNOWN", "STOP_REQUESTED"].includes(input.lifecycle)) this.ctx.storage.sql.exec("UPDATE grants SET revoked=1 WHERE id=?", attempt.grantId);
      if (input.lifecycle === "STOPPED" && input.verified) {
        if (input.sourceCommit && input.outcome === "COMPLETED") {
          // Output admission can be fenced or expired while a stop confirmation is in flight.
          // Whole-generation termination still releases capacity exactly once.
          try { const retained = this.row<{ payload: string }>("SELECT payload FROM records WHERE kind='runtime-output-admission' AND id=?", outputAdmissionId);
            const cleanupRow = this.row<{ phase: string }>("SELECT phase FROM cleanups WHERE attempt_id=?", attempt.id);
            requireValue(!cleanupRow || cleanupRow.phase === "STOP_REQUESTED", "ATTEMPT_CLEANUP_FENCED", 409);
            const admission = retained ? JSON.parse(retained.payload) as OutputAdmission : { commit: input.sourceCommit, admittedAt: now(), grant: this.checkGrant(project, attempt, attempt.subject, "submit-output", null, "0") };
            requireValue(admission.commit === input.sourceCommit, "RUNTIME_OUTPUT_CONFLICT", 409); const id = `${attempt.id}-submission-${attempt.generation}`;
            this.effect(id, "ingest-submission", { scope: project.scope, attemptId: attempt.id, submissionId: id, commit: admission.commit, ref: "refs/heads/confidence-work", admittedAt: admission.admittedAt, grant: admission.grant, individualEvaluation: true });
          } catch (error) { if (!(error instanceof PlatformError)) throw error; this.event(this.project(), "source-submission-rejected", attempt.id, { code: error.code, commit: input.sourceCommit }); }
        }
        const reservation = this.row<{ maximum: string; state: string }>("SELECT maximum,state FROM reservations WHERE id=?", attempt.id)!;
        if (reservation.state !== "SETTLED") {
          const current = this.project(); const budget = JSON.parse(getKernel().budget_transition(canonicalize({ limit: current.maximumBudget, held: current.reservedBudget, settled: current.settledBudget, reservation: reservation.maximum, phase: "DISPATCHED", event: "SETTLE", observedCost: null }))) as { accepted: boolean; reason: string; held: string; settled: string };
          requireValue(budget.accepted, budget.reason, 409); const prior = current.revision; current.reservedBudget = budget.held; current.settledBudget = budget.settled; current.revision = (BigInt(prior) + 1n).toString(); this.saveProject(current, prior);
          this.ctx.storage.sql.exec("UPDATE reservations SET state='SETTLED',settled=maximum WHERE id=?", attempt.id);
        }
        this.ctx.storage.sql.exec("UPDATE grants SET revoked=1 WHERE id=?", attempt.grantId);
      }
      this.event(this.project(), "execution-observed", attempt.id, input);
    });
    // Fence and settle before any R2 yield. A retry uses the admission frozen
    // before the trusted STOP_REQUESTED callback revoked its grant.
    if (input.capsule && this.row("SELECT id FROM records WHERE kind='runtime-context-admission' AND id=?", input.eventId) && !this.row("SELECT id FROM records WHERE kind='context-capture-rejection' AND id=?", input.eventId)) {
      try { await this.retainRuntimeCapsule(attempt, input.capsule); }
      catch (error) { if (!(error instanceof PlatformError)) throw error; if (error.status >= 500 || error.code === "REQUIRED_OBJECT_MISSING") throw error; this.retain("context-capture-rejection", input.eventId, { attemptId: attempt.id, code: error.code }); }
    }
    await this.ctx.storage.setAlarm(Date.now() + 100); return { state: "RUNTIME_OBSERVATION_RETAINED" };
  }
  async api(operation: "project-hub" | "project-agent" | "join-requests" | "request-join" | "weft-workspace" | "weft-handoff" | "weft-proxy" | "catalog-source" | "catalog" | "catalog-initialize" | "catalog-command" | "projection-history" | "attempt-context" | "candidate-source" | "snapshot" | "conditional-snapshot" | "operations" | "command" | "collaboration" | "collaboration-command" | "inspect-invitation" | "enroll" | "evidence" | "model" | "model-call-fact" | "model-calls" | "runtime" | "export" | "broker", payload: unknown, request?: Request): Promise<Response> {
    try {
      if (operation === 'project-hub' || operation === 'project-agent') {
        requireValue(this.env.PROJECT_HUB_ENABLED === 'true', 'PROJECT_HUB_UNAVAILABLE', 404);
        const input = payload as { caller: TrustedCaller; projectId?: string; credentials: HubAgentCredentials; operation: string; expectedIncarnation?: string; after?: string; body?: unknown; connectionId?: string; bundle?: boolean };
        const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
        if (operation === 'project-agent') {
          requireValue(['messages', 'post', 'dependency'].includes(input.operation), 'UNSUPPORTED_ROUTE', 404);
          requireValue(input.projectId === input.credentials?.projectId, 'HUB_AGENT_UNAUTHORIZED', 401);
          if (input.operation === 'dependency') return await pinnedWeftDependency(this.env.OBJECTS, input.bundle === true, () => { this.hub.authorizeAgent(input.credentials, 'dependency'); });
          return Response.json(input.operation === 'messages' ? this.hub.readAgent(input.credentials, input.after) : this.hub.postAgent(input.credentials, input.body), { status: input.operation === 'post' ? 202 : 200, headers });
        }
        requireValue(['view', 'messages', 'post', 'connect', 'revoke', 'dependency'].includes(input.operation), 'UNSUPPORTED_ROUTE', 404);
        const mutation = ['post', 'connect', 'revoke'].includes(input.operation);
        const authorize = () => {
          const context = this.catalog.hubContext(input.caller, input.operation === 'connect' ? 'connect' : input.operation === 'post' ? 'edit' : 'read');
          if (mutation) requireValue(this.env.MAINTENANCE_MODE !== 'true', 'MAINTENANCE_READ_ONLY', 503);
          if (mutation || input.expectedIncarnation !== undefined) requireValue(input.expectedIncarnation === context.scope.projectIncarnation, 'PROJECT_INCAR_CHANGED', 409);
        };
        authorize();
        if (input.operation === 'dependency') return await pinnedWeftDependency(this.env.OBJECTS, input.bundle === true, authorize);
        if (input.operation === 'revoke') requireValue(input.body && typeof input.body === 'object' && !Array.isArray(input.body) && Object.keys(input.body).length === 0, 'HUB_BODY_INVALID');
        const result = input.operation === 'view' ? this.hub.view(input.caller, input.after)
          : input.operation === 'messages' ? this.hub.messages(input.caller, input.after)
          : input.operation === 'post' ? this.hub.postHuman(input.caller, input.body)
          : input.operation === 'connect' ? this.hub.registerConnection(input.caller, input.body)
          : this.hub.revokeConnection(input.caller, input.connectionId);
        return Response.json(result, { status: mutation ? 202 : 200, headers });
      }
      if (operation === 'join-requests' || operation === 'request-join') {
        requireValue(this.env.PROJECT_HUB_ENABLED === 'true', 'PROJECT_HUB_UNAVAILABLE', 404);
        const input = payload as { caller: TrustedCaller; request: Parameters<ProjectCatalog['requestJoin']>[1] };
        return Response.json(operation === 'join-requests' ? this.catalog.joinRequests(input.caller) : this.catalog.requestJoin(input.caller, input.request),
          { status: operation === 'request-join' ? 202 : 200, headers: { 'cache-control': 'no-store' } });
      }
      if (operation === "weft-workspace" || operation === "weft-handoff" || operation === "weft-proxy") {
        const input = payload as { caller: TrustedCaller; requestId: string; proxy: Parameters<ProjectAuthority["weftProxy"]>[1] };
        if (operation === "weft-proxy") return await this.weftProxy(input.caller, input.proxy);
        return Response.json(operation === "weft-workspace" ? await this.weftWorkspace(input.caller) : await this.weftHandoff(input.caller, input.requestId), { headers: { "cache-control": "no-store" } });
      }
      if (operation === 'catalog-source') {
        const input = payload as { caller: TrustedCaller; sourceRequest: ImportedSourceRequest };
        return await this.catalog.readSource(input.caller, input.sourceRequest);
      }
      if (operation === 'catalog' || operation === 'catalog-initialize' || operation === 'catalog-command') {
        const input = payload as { caller: TrustedCaller; creation: Parameters<ProjectCatalog['initialize']>[1]; command: ProjectMetadataCommand };
        const value = operation === 'catalog' ? this.catalog.summary(input.caller) : operation === 'catalog-initialize' ? this.catalog.initialize(input.caller, input.creation) : await this.catalog.command(input.caller, input.command);
        return Response.json(value, { headers: { 'cache-control': 'no-store' } });
      }
      const input = payload as { caller: TrustedCaller; includeModelCalls?: boolean; jobKey?: string; priorViewCursor?: ViewCursor | null; command: AuthorityCommand; enrollment: Parameters<ProjectAuthority["enroll"]>[1]; exportKind: "trust" | "checkpoint" | "checkpoint-attestation" | "bundle"; publicationId?: string; scope: Scope; attemptId: string; generation: string; operation: "git-read" | "git-write"; contextRequest: Parameters<ProjectAuthority["attemptContext"]>[1]; candidateId: string; version: "candidate" | "base" };
      if (operation === "candidate-source") return Response.json(await this.candidateSource(input.caller, input.candidateId, input.version), { headers: { "cache-control": "no-store" } });
      if (operation === "attempt-context") return Response.json(await this.attemptContext(input.caller, input.contextRequest));
      if (operation === "projection-history") return new Response(canonicalize(await this.projectionHistory(payload as ProjectionHistoryRequest)), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      if (operation === "collaboration") return Response.json(await this.collaboration(input.caller), { headers: { "cache-control": "no-store" } });
      if (operation === "collaboration-command") return Response.json(await this.collaborationCommand(input.caller, input.command), { status: 202, headers: { "cache-control": "no-store" } });
      if (operation === "inspect-invitation") return Response.json(await this.inspectInvitation(input.caller, input.command), { headers: { "cache-control": "no-store" } });
      if (operation === "snapshot") return Response.json(await this.snapshot(input.caller, input.includeModelCalls === true, input.candidateId));
      if (operation === "operations") return Response.json(await this.operations(input.caller, input.jobKey), { headers: { 'cache-control': 'no-store' } });
      if (operation === "conditional-snapshot") return Response.json(await this.conditionalSnapshot(input.caller, input.priorViewCursor ?? null, input.candidateId));
      if (operation === "command") return Response.json(await this.command(input.caller, input.command), { status: 202 });
      if (operation === "enroll") return Response.json(await this.enroll(input.caller, input.enrollment), { status: 201 });
      if (operation === "evidence") return Response.json(await this.reportEvidence(payload as EvaluationCallback));
      if (operation === "model") return Response.json(await this.reserveModel(payload as Parameters<ProjectAuthority["reserveModel"]>[0]));
      if (operation === 'model-call-fact') return Response.json(await this.observeModelCall(payload as ModelCallFact));
      if (operation === 'model-calls') { const page = payload as { caller: TrustedCaller; after: string; limit: number; expectedIncarnation: string }; return Response.json(this.modelCallPage(page.caller, page)); }
      if (operation === "runtime") return Response.json(await this.runtimeObservation(payload as Parameters<ProjectAuthority["runtimeObservation"]>[0]));
      if (operation === "export") return Response.json(await this.export(input.caller, input.exportKind, input.publicationId));
      requireValue(operation === "broker" && request, "UNSUPPORTED_OPERATION", 404); return await this.broker(input.scope, input.attemptId, input.generation, input.operation, request);
    } catch (error) { return errorResponse(error); }
  }
  async export(caller: TrustedCaller, kind: "trust" | "checkpoint" | "checkpoint-attestation" | "bundle", publicationId?: string): Promise<unknown> {
    this.role(caller, "reader"); const project = this.project();
    if (kind === "trust") return this.trust();
    if (kind === "checkpoint") return { schemaVersion: 1, scope: project.scope, enrollmentDigest: project.enrollmentDigest, sequence: project.publicationSequence, receiptDigest: project.previousReceiptDigest ?? project.enrollmentDigest };
    if (kind === "checkpoint-attestation") {
      const trust = this.trust();
      const attestation: CheckpointAttestation = { schemaVersion: 1,
        checkpoint: { schemaVersion: 1, scope: project.scope, enrollmentDigest: project.enrollmentDigest, sequence: project.publicationSequence, receiptDigest: project.previousReceiptDigest ?? project.enrollmentDigest },
        issuance: { schemaVersion: 1, scope: project.scope, authorityRevision: project.revision, signerKeysetRevision: trust.keysetRevision } };
      const envelope = await this.sign("checkpoint", attestation.checkpoint, attestation.issuance.authorityRevision, trust);
      const envelopeDigest = await this.objects.put(bytes(envelope));
      // A read yielding to revocation cannot return privileged data or a newly revoked signature.
      this.role(caller, "reader"); const checked = verifyAttestation({ trust: this.trust(), envelope, kind: "checkpoint", role: "root", authorityRevision: attestation.issuance.authorityRevision, allowLegacy: false }); requireValue(checked.valid, "SIGNER_AUTHORIZATION_CHANGED", 409);
      const id = `${attestation.checkpoint.sequence}/${attestation.issuance.authorityRevision}`;
      this.retain("checkpoint-attestation", id, { attestation, envelopeDigest });
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO pins(owner,digest) VALUES(?,?)", `checkpoint/${id}`, envelopeDigest);
      return envelope;
    }
    this.role(caller, "export"); requireValue(publicationId, "PUBLICATION_REQUIRED"); const publication = this.publication(publicationId);
    const bundle = await this.portableBundle(publication);
    this.role(caller, "reader"); this.role(caller, "export"); return bundle;
  }
}

export default {
  async fetch(request: Request, env: AuthorityEnv): Promise<Response> {
    try {
      await initializeKernel(); const path = new URL(request.url).pathname;
      const token = request.headers.get("authorization");
      if (env.PROJECTOR_SERVICE_TOKEN) requireValue(env.PROJECTOR_SERVICE_TOKEN.length >= 32 && [env.APP_SERVICE_TOKEN, env.RUNNER_SERVICE_TOKEN, env.EVALUATOR_SERVICE_TOKEN].every(other => other !== env.PROJECTOR_SERVICE_TOKEN), "SERVICE_TOKEN_ALIAS", 503);
      if (path === "/internal/projection/history") {
        requireValue(request.method === "POST" && !new URL(request.url).search, "PROJECTION_REQUEST_METHOD", 405);
        requireValue(typeof env.PROJECTOR_SERVICE_TOKEN === "string" && env.PROJECTOR_SERVICE_TOKEN.length >= 32 && [env.APP_SERVICE_TOKEN, env.RUNNER_SERVICE_TOKEN, env.EVALUATOR_SERVICE_TOKEN].every(other => other !== env.PROJECTOR_SERVICE_TOKEN) && tokenEqual(token, env.PROJECTOR_SERVICE_TOKEN), "AUTHENTICATION_FAILED", 401);
        const history = JSON.parse(getKernel().canonical_json(new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(request.body, 4096)))); historyRequest(history);
        requireValue(history.scope.tenantId === env.AUTH_TENANT_ID, "PROJECTION_SCOPE_CHANGED", 409);
        const stub = env.PROJECTS.getByName(`${history.scope.tenantId}/${history.scope.projectId}`) as DurableObjectStub<ProjectAuthority>;
        return stub.api("projection-history", history);
      }
      if (path === "/internal/observation") {
        requireValue(tokenEqual(token, env.EVALUATOR_SERVICE_TOKEN), "AUTHENTICATION_FAILED", 401);
        const callback = JSON.parse(getKernel().canonical_json(new TextDecoder().decode(await readBounded(request.body, MAX_CONTROL_BYTES)))) as EvaluationCallback;
        const stub = env.PROJECTS.getByName(`${callback.scope.tenantId}/${callback.scope.projectId}`) as DurableObjectStub<ProjectAuthority>;
        return stub.api("evidence", callback);
      }
      if (path.startsWith("/internal/runner/")) {
        requireValue(tokenEqual(token, env.RUNNER_SERVICE_TOKEN), "AUTHENTICATION_FAILED", 401);
        if (path === "/internal/runner/git") {
          const scope = JSON.parse(new TextDecoder().decode(decodeBase64(request.headers.get("x-controller-scope") ?? ""))) as Scope;
          const attemptId = string(request.headers.get("x-controller-attempt")); const generation = counter(request.headers.get("x-controller-generation"));
          const target = new URL(request.url).searchParams.get("target"); requireValue(target, "SCHEMA_ERROR");
          const stub = env.PROJECTS.getByName(`${scope.tenantId}/${scope.projectId}`) as DurableObjectStub<ProjectAuthority>;
          const incoming = new Request(target, { method: request.headers.get("x-controller-method") ?? "GET", headers: { "content-type": request.headers.get("content-type") ?? "application/octet-stream", "git-protocol": request.headers.get("git-protocol") ?? "version=1" }, body: request.headers.get("x-controller-method") === "POST" ? (await readBounded(request.body, 32 * 1024 * 1024)).slice().buffer : undefined });
          return stub.api("broker", { scope, attemptId, generation, operation: request.headers.get("x-controller-operation") === "git-write" ? "git-write" : "git-read" }, incoming);
        }
        if (path === '/internal/runner/model-call-fact') requireValue(request.method === 'POST' && !new URL(request.url).search, 'METHOD_NOT_ALLOWED', 405);
        const body = JSON.parse(getKernel().canonical_json(new TextDecoder().decode(await readBounded(request.body, path === '/internal/runner/model-call-fact' ? MODEL_CALL_FACT_BYTES : MAX_CONTROL_BYTES)))) as Parameters<ProjectAuthority["reserveModel"]>[0] & Parameters<ProjectAuthority["runtimeObservation"]>[0];
        const stub = env.PROJECTS.getByName(`${body.scope.tenantId}/${body.scope.projectId}`) as DurableObjectStub<ProjectAuthority>;
        if (path === "/internal/runner/model-reserve") return stub.api("model", body);
        if (path === '/internal/runner/model-call-fact') return stub.api('model-call-fact', body);
        if (path === "/internal/runner/observation") return stub.api("runtime", body);
        return new Response("Not found", { status: 404 });
      }
      requireValue(tokenEqual(token, env.APP_SERVICE_TOKEN), "AUTHENTICATION_FAILED", 401);
      if (path === '/internal/project-agent') {
        requireValue(env.PROJECT_HUB_ENABLED === 'true', 'PROJECT_HUB_UNAVAILABLE', 404);
        requireValue(request.method === 'POST' && !new URL(request.url).search, 'METHOD_NOT_ALLOWED', 405);
        const input = parseProjectJson(await readBounded(request.body, 64 * 1024));
        const credentials = input.credentials as unknown as HubAgentCredentials;
        requireValue(typeof input.projectId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(input.projectId)
          && credentials && credentials.projectId === input.projectId, 'HUB_AGENT_UNAUTHORIZED', 401);
        const project = env.PROJECTS.getByName(`${env.AUTH_TENANT_ID}/${input.projectId}`) as DurableObjectStub<ProjectAuthority>;
        return project.api('project-agent', input);
      }
      if (path.startsWith('/internal/projects/')) {
        requireValue(request.method === 'POST' && !new URL(request.url).search, 'METHOD_NOT_ALLOWED', 405);
        // Import envelopes have a separate bounded JSON grammar; signed protocol limits remain unchanged.
        const input = parseProjectJson(await readBounded(request.body, PROJECT_IMPORT_LIMITS.archiveBytes));
        if (path === '/internal/projects/list' || path === '/internal/projects/create') {
          const principal = input.principal as Principal; requireValue(principal && principal.tenantId === env.AUTH_TENANT_ID, 'PROJECT_DIRECTORY_DENIED', 403);
          const directory = env.PROJECT_DIRECTORY.getByName(principal.tenantId) as DurableObjectStub<ProjectDirectory>;
          return directory.api(path === '/internal/projects/list' ? 'list' : 'create', { principal, defaultProjectId: input.defaultProjectId as string, command: input.command as unknown as CreateProjectCommand });
        }
        const caller = input.caller as TrustedCaller;
        requireValue(caller && /^[a-zA-Z0-9_-]{1,128}$/.test(caller.projectId) && caller.principal?.tenantId === env.AUTH_TENANT_ID, 'PROJECT_SCHEMA_INVALID');
        const project = env.PROJECTS.getByName(`${caller.principal.tenantId}/${caller.projectId}`) as DurableObjectStub<ProjectAuthority>;
        if (path === '/internal/projects/source') return project.api('catalog-source', input);
        if (path === '/internal/projects/get') return project.api('catalog', input);
        if (path === '/internal/projects/command') return project.api('catalog-command', input);
        throw new PlatformError('UNSUPPORTED_ROUTE', 404);
      }
      const payload = JSON.parse(getKernel().canonical_json(new TextDecoder().decode(await readBounded(request.body, MAX_CONTROL_BYTES)))) as { caller: TrustedCaller; command: AuthorityCommand; enrollment: Parameters<ProjectAuthority["enroll"]>[1]; exportKind: "trust" | "checkpoint" | "checkpoint-attestation" | "bundle"; publicationId?: string };
      requireValue(payload.caller && /^[a-zA-Z0-9_-]{1,128}$/.test(payload.caller.projectId) && payload.caller.principal.tenantId === env.AUTH_TENANT_ID, "SCHEMA_ERROR");
      const stub = env.PROJECTS.getByName(`${payload.caller.principal.tenantId}/${payload.caller.projectId}`) as DurableObjectStub<ProjectAuthority>;
      if (path === '/internal/project-hub') return stub.api('project-hub', payload);
      if (path === "/internal/weft-workspace") return stub.api("weft-workspace", payload);
      if (path === "/internal/join-requests") return stub.api("join-requests", payload);
      if (path === "/internal/request-join") return stub.api("request-join", payload);
      if (path === "/internal/weft-handoff") return stub.api("weft-handoff", payload);
      if (path === "/internal/weft-proxy") return stub.api("weft-proxy", payload);
      if (path === "/internal/attempt-context") return stub.api("attempt-context", payload);
      if (path === "/internal/candidate-source") return stub.api("candidate-source", payload);
      if (path === "/internal/snapshot") return stub.api("snapshot", payload);
      if (path === "/internal/operations") return stub.api("operations", payload);
      if (path === '/internal/model-calls') return stub.api('model-calls', payload);
      if (path === "/internal/conditional-snapshot") return stub.api("conditional-snapshot", payload);
      if (path === "/internal/collaboration") return stub.api("collaboration", payload);
      if (path === "/internal/collaboration-command") return stub.api("collaboration-command", payload);
      if (path === "/internal/inspect-invitation") return stub.api("inspect-invitation", payload);
      if (path === "/internal/enroll") return stub.api("enroll", payload);
      if (path === "/internal/export") return stub.api("export", payload);
      if (path === "/internal/command") return stub.api("command", payload);
      return new Response("Not found", { status: 404 });
    } catch (error) { return errorResponse(error); }
  },
} satisfies ExportedHandler<AuthorityEnv>;
