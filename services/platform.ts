import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, open, readdir, lstat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { initializeKernel } from '../packages/protocol/src/node.ts';
import { decodeBase64, evaluateAdmission, getKernel, parseStrictJson, verifyBundle } from '../packages/protocol/src/index.ts';
import { selectSessionContext, validatePartialSessionCapture, SESSION_CONTEXT_LIMITS, type SelectedSessionContext } from '../packages/protocol/src/session-context.ts';
import type { AdmissionInput, AdmissionEvidence, EvaluationPlan, ReviewProposal, SourceManifest, TrustConfig, VerificationBundle, GitObject, LogicalReceipt } from '../packages/protocol/src/types.ts';
import { canonical, digest, hashBytes, LocalKeys } from './crypto.ts';
import { GitStore, changedPaths } from './git.ts';
import { ExternalEvaluator, publicProbes, stopProcess } from './evaluator.ts';
import { isCurrentFullReleasePlan } from './probes.ts';
import { createModelBroker } from './model-broker.ts';
import { authoringIntegrations } from './authoring-integrations.ts';
import { buildNarsilContext } from './narsil-context.mjs';
import { runInterlinkedPreview, INTERLINKED_PREVIEW_LIMITS } from './interlinked-preview.mjs';
import { sourceAdvisoryFitsPrompt, validateSourceAdvisory, type SourceAdvisory } from '../packages/protocol/src/source-advisory.ts';
import type { AgentMode, Attempt, Candidate, Capsule, Conflict, ContinuationReference, ContinuationRequest, Evaluation, Evidence, Manifest, PlatformState, Publication, Receipt, Review } from './types.ts';

const repository = fileURLToPath(new URL('..', import.meta.url));
const id = (prefix: string) => `${prefix}-${randomUUID()}`;
const now = () => new Date().toISOString();
const seconds = () => Math.floor(Date.now() / 1000);
export function protocolManifest(manifest: Manifest): SourceManifest { return { schemaVersion: 1, pathProfile: 'portable-ascii-v1', entries: manifest.entries.map(e => ({ path: e.path, mode: e.mode, bytes: String(e.size), digest: e.digest })) }; }
const assignments: Record<string, { name: string; task: string; intent: string; paths: string[] }> = {
  A: { name: 'A · Read acceleration', task: 'Enable a 60-second read cache in cache.mjs while keeping the existing write-side invalidation behavior.', intent: 'Cache unchanged reads; assumes existing write-side invalidation remains.', paths: ['cache.mjs'] },
  B: { name: 'B · Write simplification', task: 'Remove the invalidate() call in mutation.mjs that appears redundant because the pinned baseline disables caching. Keep the write behavior.', intent: 'Simplify the write path; assumes cache remains disabled as in the assigned baseline.', paths: ['mutation.mjs'] },
  C: { name: 'C · Accessible saved status', task: 'Change presentation.mjs so the saved value is server-rendered in <p role="status" aria-live="polite" aria-label="Saved value">Saved value: VALUE</p>. Preserve the document/main structure.', intent: 'Expose the latest acknowledged saved value through an accessible status.', paths: ['presentation.mjs'] },
  repair: { name: 'Repair · Keep the useful work', task: 'Repair the observed stale read while preserving A’s enabled cache, B’s contribution lineage and C’s accessible saved-value status. Only edit mutation.mjs. Restore correct write-side invalidation or an equivalent repair. Do not disable caching or remove the status.', intent: 'Use the exact counterexample to repair invalidation while retaining caching and accessible status.', paths: ['mutation.mjs'] },
};
export class LocalPlatform extends EventEmitter {
  state!: PlatformState; keys!: LocalKeys; git!: GitStore; evaluator!: ExternalEvaluator;
  private saveTail: Promise<void> = Promise.resolve(); private busy = false; private selecting = false; private closing = false; private activeEvaluations = 0;
  private publicationTail: Promise<unknown> = Promise.resolve(); private children = new Map<string, ChildProcess>();
  private continuationTail: Promise<unknown> = Promise.resolve(); private continuationPending = 0;
  private previews = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private stoppingAttempts = new Set<string>();
  private enrollment: any;
  private retainedTrust?: TrustConfig;
  constructor(public directory = resolve(repository, '.local-data'), private readonly evaluationConcurrency: 1 | 2 = 2) {
    super(); if (![1, 2].includes(evaluationConcurrency)) throw new Error('INVALID_EVALUATION_CONCURRENCY');
  }
  async initialize(): Promise<void> {
    await initializeKernel(); await mkdir(this.directory, { recursive: true });
    for (const folder of ['authority', 'objects', 'sessions', 'capsules', 'workspaces', 'evaluations', 'publications', 'receipts', 'bundles', 'private-config']) await mkdir(join(this.directory, folder), { recursive: true, mode: 0o700 });
    this.keys = new LocalKeys(join(this.directory, 'authority'));
    this.git = new GitStore(join(this.directory, 'source.git'), join(this.directory, 'canonical.git'));
    this.evaluator = new ExternalEvaluator(this.git, join(this.directory, 'evaluations'), async evaluation => {
      if (!this.state.evaluations.some(item => item.id === evaluation.id)) { this.assertOpen(); this.state.evaluations.push(evaluation); }
      await this.save();
    });
    const statePath = join(this.directory, 'authority', 'state.json');
    if (existsSync(statePath)) {
      this.state = JSON.parse(await readFile(statePath, 'utf8'));
      this.retainedTrust = JSON.parse(await readFile(join(this.directory, 'trust-config.json'), 'utf8')) as TrustConfig;
      this.enrollment = JSON.parse(await readFile(join(this.directory, 'authority', 'enrollment.json'), 'utf8'));
      for (const attempt of this.state.attempts) if (attempt.status === 'RUNNING' || attempt.status === 'PROVISIONING') { attempt.status = 'INFRASTRUCTURE_UNKNOWN'; attempt.error = 'Controller restarted before a durable termination observation. Reconcile the retained generation.'; }
      for (const evaluation of this.state.evaluations) if (evaluation.status === 'RUNNING') { evaluation.status = 'INFRASTRUCTURE_UNKNOWN'; evaluation.outcome = 'INCONCLUSIVE'; }
      if (this.state.demoStatus === 'RUNNING') this.state.demoStatus = 'INFRASTRUCTURE_UNKNOWN';
      await this.record('controller.restarted', 'Loaded retained authority state; unfinished execution remains uncertain.');
      await this.reconcile();
    } else {
      const head = await this.git.initialize(join(repository, 'fixtures/collaboration-demo'));
      this.state = {
        schemaVersion: 1, projectId: 'collaboration-demo', projectIncarnation: id('incarnation'), tenantId: 'local-tenant', revision: 1, observationRevision: 0, acceptedHead: head, enrollmentDigest: '',
        goal: { id: 'goal', revision: '1', title: 'Faster reads. Fresh writes. Clear saved status.', description: 'Integrate concurrent contributions without losing useful work. Every read after an acknowledged write must expose the new value. Retain one backing-store read for repeated unchanged reads and an accessible server-rendered saved-value status.', constraints: ['Read → write → read must return the latest acknowledged value before cache expiry.', 'Two unchanged reads use exactly one harness-observed store read.', 'Saved status exposes the latest value with an accessible label.', 'Publish only the exact evaluated and approved Git commit.'], contracts: ['freshness-v1', 'retained-value-v1'], budget: { maxAttempts: 4, authoringSeconds: 120, evaluationSeconds: 15 } },
        attempts: [], candidates: [], evaluations: [], evidence: [], conflicts: [], capsules: [], reviews: [], publications: [], receipts: [], commands: [], events: [], demoStatus: 'READY',
        capabilities: { scripted: true, pi: false, publication: true, deployment: false },
        limitations: ['Local single-operator development adapter. Loopback API has local browser session protection; no production OIDC enrollment is claimed.', 'Scripted attempts are concurrent real child processes with predetermined edits, not model agents. Pi is an explicit optional JSON proposal adapter.', 'Candidate and harness processes share an OS identity. No hostile-code containment or network isolation is established by this local mode.', 'Native Git fixed-head publication is demonstrated locally. Artifacts service and Cloudflare containment require their own live conformance gates.', 'Designed fixture cases and audit probes establish only their observed requirements, not general semantic safety.'],
        gates: [{ name: 'Native Git exact objects', status: 'available', detail: 'Exact commit/tree/blob source validation and bundle roundtrip run for every candidate.' }, { name: 'Protected HTTP checker', status: 'available', detail: 'Sibling host harness owns fresh backing store and access counts; production isolation remains a deployment gate.' }, { name: 'Real model execution', status: 'not-configured', detail: 'Configure the explicit model broker after the local scripted walkthrough.' }, { name: 'Cloudflare deployment', status: 'not-confirmed', detail: 'Local execution does not claim live Artifacts, Sandbox or Workers outcomes.' }],
      };
      const manifest = protocolManifest(await this.git.manifest(head));
      const trust = this.trustConfig();
      const predicate = { schemaVersion: 1, scope: this.scope(), head, manifestDigest: digest(manifest), trustDigest: digest(trust.schemaVersion === 2 ? trust.genesis : trust), sequence: '0', importedHistory: true };
      this.enrollment = { predicate, envelope: this.keys.attest('root', 'enrollment', predicate, this.issuance()) };
      this.state.enrollmentDigest = digest(predicate);
      await this.durableWrite(join(this.directory, 'authority', 'enrollment.json'), this.enrollment);
      await this.durableWrite(join(this.directory, 'trust-config.json'), this.trustConfig());
      await this.record('project.enrolled', 'Enrolled the owned fixture baseline and retained a separate trust configuration.');
    }
    this.state.capabilities.pi = !!(process.env.PI_MODEL && process.env.PI_MODEL_BASE_URL && process.env.OPENAI_API_KEY);
    this.state.capabilities.piReason = this.state.capabilities.pi ? 'Explicit Pi broker configured. Model edits and outcomes will be reported as actually observed.' : 'PI_MODEL, PI_MODEL_BASE_URL and host OPENAI_API_KEY are not all configured.';
    await this.save();
  }
  scope() { return { schemaVersion: 1 as const, tenantId: this.state.tenantId, projectId: this.state.projectId, projectIncarnation: this.state.projectIncarnation }; }
  trustConfig(): any {
    if (!this.retainedTrust) {
      const genesis = this.keys.publicConfig(this.state.projectId, this.state.projectIncarnation) as unknown as import('../packages/protocol/src/types.ts').LegacyTrustConfig;
      this.retainedTrust = { schemaVersion: 2, scope: genesis.scope, keysetRevision: genesis.keysetRevision, keys: genesis.keys, genesis, lifecycle: [] };
    }
    return structuredClone(this.retainedTrust);
  }
  private issuance(authorityRevision = String(this.state.revision)) { return { schemaVersion: 1 as const, scope: this.scope(), authorityRevision, signerKeysetRevision: this.trustConfig().keysetRevision }; }
  async checkpointAttestation() {
    const receipt = this.state.receipts.at(-1);
    const checkpoint = { schemaVersion: 1, scope: this.scope(), enrollmentDigest: this.state.enrollmentDigest, sequence: String(receipt?.sequence ?? 0), receiptDigest: receipt?.digest ?? this.state.enrollmentDigest };
    const envelope = this.keys.attest('root', 'checkpoint', checkpoint, this.issuance());
    await this.durableWrite(join(this.directory, 'authority', `checkpoint-${checkpoint.sequence}-${this.state.revision}.json`), envelope);
    return envelope;
  }
  snapshot(): PlatformState { return structuredClone(this.state); }
  private assertOpen(): void { if (this.closing) throw new Error('PLATFORM_CLOSING'); }
  private async durableWrite(path: string, value: unknown): Promise<void> {
    const temporary = path + '.' + randomUUID() + '.tmp'; await mkdir(dirname(path), { recursive: true });
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(canonical(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const parent = await open(dirname(path), 'r'); try { await parent.sync(); } finally { await parent.close(); }
  }
  async save(): Promise<void> {
    this.state.revision++; const snapshot = structuredClone(this.state);
    const next = this.saveTail.then(() => this.durableWrite(join(this.directory, 'authority', 'state.json'), snapshot));
    this.saveTail = next.catch(() => {}); await next;
  }
  async record(type: string, message: string, objectId?: string): Promise<void> {
    const event = { id: id('event'), sequence: this.state.events.length + 1, time: now(), type, message, ...(objectId ? { objectId } : {}) };
    this.state.events.push(event); await this.save(); this.emit('event', event);
  }
  private command(principal: string, commandId: string, operation: string, body: unknown): { previous?: any; reserve: () => Promise<void>; commit: (result: unknown) => Promise<void> } {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(commandId)) throw new Error('COMMAND_ID_INVALID');
    const requestDigest = digest({ operation, body }), previous = this.state.commands.find(c => c.id === commandId && c.principal === principal);
    if (previous && previous.digest !== requestDigest) throw new Error('COMMAND_ID_REUSED_WITH_DIFFERENT_REQUEST');
    return { ...(previous ? { previous: previous.result } : {}), reserve: async () => {
      if (!this.state.commands.some(c => c.id === commandId && c.principal === principal)) this.state.commands.push({ id: commandId, principal, digest: requestDigest, operation, result: { commandId, state: 'RESERVED', statusUrl: '/api/state' } });
      await this.save();
    }, commit: async result => {
      const existing = this.state.commands.find(c => c.id === commandId && c.principal === principal);
      if (existing) existing.result = result; else this.state.commands.push({ id: commandId, principal, digest: requestDigest, operation, result }); await this.save();
    } };
  }
  async startDemo(body: { mode?: AgentMode; autoSelect?: boolean; commandId?: string } = {}): Promise<unknown> {
    this.assertOpen();
    const mode = body.mode || 'scripted', commandId = body.commandId || id('command'); const command = this.command('local-sponsor', commandId, 'demo', { mode, autoSelect: body.autoSelect !== false });
    if (command.previous) return command.previous;
    if (this.continuationPending || this.busy || this.state.evaluations.some(e => e.status === 'INFRASTRUCTURE_UNKNOWN') || this.state.attempts.some(a => ['RUNNING', 'PROVISIONING', 'INFRASTRUCTURE_UNKNOWN'].includes(a.status))) throw new Error('AUTHORING_CAPACITY_HELD');
    if (this.state.attempts.length + 3 > (this.state.goal.budget.maxAttempts ?? 0)) throw new Error('GOAL_ATTEMPT_BUDGET_EXHAUSTED');
    if (mode === 'pi' && !this.state.capabilities.pi) throw new Error('MODEL_NOT_CONFIGURED');
    this.busy = true; this.state.demoStatus = 'RUNNING'; this.state.demoMode = mode; delete this.state.error;
    const result = { commandId, state: 'RUNNING', statusUrl: '/api/state', mode };
    try { await command.commit(result); } catch (error) { this.busy = false; throw error; }
    void this.runDemo(mode, body.autoSelect !== false).catch(async error => { this.state.demoStatus = 'ERROR'; this.state.error = String(error.message); await this.record('demo.failed', this.state.error!); }).finally(() => { this.busy = false; });
    return result;
  }
  async waitForIdle(): Promise<void> { while (this.busy || this.continuationPending || this.selecting || this.activeEvaluations || this.previews.size) await new Promise(resolve => setTimeout(resolve, 25)); await this.saveTail; }
  /** A new attempt with explicit immutable source/context references, never a live-session resume. */
  async continueAttempt(body: ContinuationRequest): Promise<unknown> {
    this.assertOpen();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['contextCapsuleId', 'contextCapsuleDigest', 'workBase', 'sessionEntry', 'commandId'].includes(key))
      || typeof body.contextCapsuleId !== 'string' || !/^capsule-[A-Za-z0-9_-]{1,128}$/.test(body.contextCapsuleId)
      || typeof body.contextCapsuleDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(body.contextCapsuleDigest)
      || typeof body.workBase !== 'string' || !/^[a-f0-9]{40}$/.test(body.workBase)
      || typeof body.sessionEntry !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(body.sessionEntry)
      || body.commandId !== undefined && (typeof body.commandId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.commandId))) throw new Error('CONTINUATION_REFERENCE_INVALID');
    const normalized = { ...body, commandId: body.commandId ?? id('command') };
    this.continuationPending++;
    const result = this.continuationTail.then(() => this.continueSerialized(normalized));
    this.continuationTail = result.catch(() => {});
    try { return await result; } finally { this.continuationPending--; }
  }
  private assertContinuationCapacity(): void {
    this.assertOpen();
    if (this.busy || this.selecting || this.children.size || this.state.attempts.some(attempt => ['RUNNING', 'PROVISIONING', 'INFRASTRUCTURE_UNKNOWN'].includes(attempt.status))
      || this.state.evaluations.some(evaluation => ['RUNNING', 'INFRASTRUCTURE_UNKNOWN'].includes(evaluation.status) || evaluation.jobs.some(job => job.runtime && !job.runtime.terminationObserved))) throw new Error('AUTHORING_CAPACITY_HELD');
    if (this.state.attempts.length >= (this.state.goal.budget.maxAttempts ?? 0)) throw new Error('GOAL_ATTEMPT_BUDGET_EXHAUSTED');
  }
  private async retainedJson(path: string, maximum: number, missing: string): Promise<unknown> {
    let file;
    try { file = await open(path, 'r'); } catch { throw new Error(missing); }
    try {
      const stat = await file.stat(); if (!stat.isFile()) throw new Error(missing);
      if (stat.size > maximum) throw new Error('CONTINUATION_RETAINED_OBJECT_LIMIT');
      const bytes = Buffer.alloc(maximum + 1); let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
        if (!bytesRead) break; size += bytesRead;
      }
      if (size > maximum) throw new Error('CONTINUATION_RETAINED_OBJECT_LIMIT');
      return parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    } finally { await file.close(); }
  }
  private async continueSerialized(body: ContinuationRequest & { commandId: string }): Promise<unknown> {
    const { commandId, ...request } = body, command = this.command('local-sponsor', commandId, 'continue', request);
    if (command.previous) return command.previous;
    this.assertContinuationCapacity();
    const retained = this.state.capsules.find(capsule => capsule.id === body.contextCapsuleId);
    if (!retained || retained.digest !== body.contextCapsuleDigest) throw new Error('CONTINUATION_CAPSULE_REFERENCE_MISMATCH');
    const capsule = await this.retainedJson(join(this.directory, 'capsules', retained.id + '.json'), 256 * 1024, 'CONTINUATION_CAPSULE_MISSING') as Capsule;
    if (!capsule || capsule.id !== retained.id || capsule.digest !== body.contextCapsuleDigest || digest({ ...capsule, digest: undefined }) !== capsule.digest || canonical(capsule) !== canonical(retained)) throw new Error('CONTINUATION_CAPSULE_CORRUPTED');
    const original = this.state.attempts.find(attempt => attempt.id === capsule.attemptId);
    if (!original || original.capsuleId !== capsule.id || original.status !== 'SUBMITTED' || !original.terminationObserved || original.commit !== capsule.sourceCommit
      || capsule.sourceCommit !== body.workBase || capsule.goalRevision !== this.state.goal.revision || !assignments[original.role]
      || !['pi', 'scripted'].includes(original.mode) || !Array.isArray(original.allowedPaths) || canonical(original.allowedPaths) !== canonical(assignments[original.role].paths)) throw new Error('CONTINUATION_SOURCE_ASSIGNMENT_MISMATCH');
    if (original.mode !== 'pi' || capsule.sessionFormat !== 'pi-sdk-1.0.2-session-entries-v1' || capsule.missingTail || !capsule.sessionId || capsule.selectedSessionEntry !== body.sessionEntry) throw new Error('CONTINUATION_SESSION_REFERENCE_MISMATCH');
    // Configuration is checked before admission, without making a model call.
    if (!this.state.capabilities.pi || !process.env.PI_MODEL || !process.env.PI_MODEL_BASE_URL || !process.env.OPENAI_API_KEY) throw new Error('MODEL_NOT_CONFIGURED');
    let destination: URL;
    try { destination = new URL(process.env.PI_MODEL_BASE_URL.replace(/\/$/, '') + '/chat/completions'); } catch { throw new Error('MODEL_ROUTE_INVALID'); }
    if (destination.protocol !== 'https:' || destination.username || destination.password || destination.search || destination.hash) throw new Error('MODEL_ROUTE_INVALID');
    const session = await this.retainedJson(join(this.directory, 'sessions', original.id + '.json'), 1536 * 1024, 'CONTINUATION_SESSION_MISSING') as { dataBase64: string; digest: string; format: string };
    if (!session || typeof session.dataBase64 !== 'string' || session.digest !== capsule.sessionDigest || session.format !== capsule.sessionFormat) throw new Error('CONTINUATION_SESSION_CORRUPTED');
    const sessionBytes = decodeBase64(session.dataBase64);
    if (sessionBytes.byteLength > SESSION_CONTEXT_LIMITS.snapshotBytes || hashBytes(sessionBytes) !== capsule.sessionDigest) throw new Error('CONTINUATION_SESSION_CORRUPTED');
    const context = selectSessionContext(sessionBytes, body.sessionEntry);
    if (context.sessionId !== capsule.sessionId) throw new Error('CONTINUATION_SESSION_IDENTITY_MISMATCH');
    let manifest: Manifest;
    try {
      const head = (await this.git.git(['rev-parse', '--verify', `refs/attempts/${original.id}`])).toString().trim();
      if (head !== body.workBase) throw new Error('CONTINUATION_SOURCE_REF_MISMATCH');
      manifest = await this.git.manifest(body.workBase);
    } catch { throw new Error('CONTINUATION_SOURCE_REF_MISMATCH'); }
    if (digest(protocolManifest(manifest)) !== capsule.sourceManifestDigest) throw new Error('CONTINUATION_SOURCE_MANIFEST_MISMATCH');
    const commitBytes = await this.git.git(['cat-file', 'commit', body.workBase]), parent = /^parent ([a-f0-9]{40})\n/m.exec(commitBytes.toString())?.[1] || '';
    const source = { id: capsule.id, digest: capsule.digest, commit: body.workBase, commitBytesDigest: hashBytes(commitBytes), parent, manifestDigest: capsule.sourceManifestDigest };
    const checked = JSON.parse(getKernel().validate_git_source(canonical({ candidate: source, manifest: protocolManifest(manifest), gitObjects: await this.gitObjects(body.workBase) })));
    if (!checked.valid) throw new Error('CONTINUATION_SOURCE_IDENTITY_INVALID');
    const reference: ContinuationReference = { capsuleId: capsule.id, capsuleDigest: capsule.digest, originalAttemptId: original.id,
      sourceCommit: body.workBase, sourceManifestDigest: capsule.sourceManifestDigest, sessionDigest: capsule.sessionDigest,
      sessionEntry: body.sessionEntry, sessionId: context.sessionId, selectedContextDigest: digest(context), selectorVersion: context.selectorVersion };
    this.assertContinuationCapacity();
    this.busy = true;
    try {
      await command.reserve();
      const attempt = await this.newAttempt(original.role, original.mode, body.workBase, { original, reference });
      const result = { commandId, attemptId: attempt.id, grantId: attempt.grantId, reservationId: attempt.reservation!.id, mode: attempt.mode, state: 'RUNNING', contextReference: reference, statusUrl: '/api/state' };
      await command.commit(result);
      void this.executeAttempt(attempt, undefined, context).catch(async error => {
        attempt.status = attempt.terminationObserved ? 'FAILED' : 'INFRASTRUCTURE_UNKNOWN'; attempt.error = String(error.message);
        await this.record('continuation.failed', attempt.error!, attempt.id);
      }).finally(() => { this.busy = false; });
      return result;
    } catch (error) { this.busy = false; throw error; }
  }
  private async runDemo(mode: AgentMode, autoSelect: boolean): Promise<void> {
    this.assertOpen();
    const base = this.state.acceptedHead;
    await this.record('cohort.launched', `${mode === 'scripted' ? 'Scripted demonstration' : 'Pi model'} cohort: three bounded concurrent authoring processes.`);
    const admissions = await Promise.allSettled(['A', 'B', 'C'].map(role => this.newAttempt(role as Attempt['role'], mode, base)));
    const rejected = admissions.find(result => result.status === 'rejected'); if (rejected) throw rejected.reason;
    const cohort = admissions.map(result => (result as PromiseFulfilledResult<Attempt>).value);
    // Starts are all dispatched before waiting for any completion.
    const starts = await Promise.allSettled(cohort.map(attempt => this.executeAttempt(attempt)));
    const failed = starts.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
    this.assertOpen();
    const baseline = await this.freezeCandidate('Baseline', base, [], [], base);
    await this.evaluate(baseline, 'freshness-v1');
    for (const attempt of cohort) {
      if (attempt.status !== 'SUBMITTED') continue;
      const candidate = await this.compose([attempt.id], `Agent ${attempt.role}`);
      if (candidate) { await this.evaluate(candidate, 'freshness-v1'); attempt.observed = `Individual freshness ${candidate.outcome}. Final retained-value goal is evaluated only for a selected release.`; await this.record('attempt.individual-result', `${attempt.role}: individual freshness ${candidate.outcome}.`, attempt.id); }
    }
    this.state.demoStatus = 'SUBMITTED'; await this.save();
    if (autoSelect && cohort.every(a => a.status === 'SUBMITTED')) await this.select({ attemptIds: cohort.map(a => a.id), commandId: id('command') }, true);
  }
  private async newAttempt(role: Attempt['role'], mode: AgentMode, base: string, continuation?: { original: Attempt; reference: ContinuationReference }): Promise<Attempt> {
    this.assertOpen();
    if (this.state.attempts.length >= (this.state.goal.budget.maxAttempts ?? 0)) throw new Error('GOAL_ATTEMPT_BUDGET_EXHAUSTED');
    const assignment = assignments[role];
    const attempt: Attempt = { id: id('attempt'), name: continuation ? continuation.original.name + ' · continuation' : assignment.name, role, mode, status: 'PROVISIONING', assigned: continuation?.original.assigned ?? assignment.task, intent: mode === 'scripted' ? assignment.intent : undefined, workBase: base, publicationBase: continuation?.original.publicationBase ?? this.state.acceptedHead, generation: 1, grantId: id('grant'), allowedPaths: [...(continuation?.original.allowedPaths ?? assignment.paths)], ...(continuation ? { contextReference: continuation.reference, reservation: { id: id('reservation'), authoringSeconds: this.state.goal.budget.authoringSeconds, status: 'HELD' as const } } : {}) };
    this.state.attempts.push(attempt); await this.record('attempt.admitted', `Reserved ${this.state.goal.budget.authoringSeconds}s for ${attempt.name}; allowed paths: ${attempt.allowedPaths.join(', ')}.`, attempt.id); return attempt;
  }
  /** Disclosure is registered checker policy, never a field supplied by an agent or conflict. */
  private publicRepairEvidence(candidateId: string, evidenceIds?: string[]): Evidence[] {
    const registered = new Set(publicProbes.map(probe => digest(probe)));
    return this.state.evidence.filter(evidence => {
      if (evidence.candidateId !== candidateId || (evidenceIds && !evidenceIds.includes(evidence.id))) return false;
      const evaluation = this.state.evaluations.find(item => item.id === evidence.evaluationId && item.candidateId === candidateId);
      const job = evaluation?.jobs.find(item => item.id === evidence.jobId && item.evidenceId === evidence.id);
      return !!job && job.evaluationInputDigest === evidence.evaluationInputDigest && digest(job.input) === job.evaluationInputDigest
        && job.input.fixtureDigest === evidence.fixtureDigest && digest(job.input.fixture) === evidence.fixtureDigest
        && registered.has(evidence.fixtureDigest);
    });
  }
  private failureConflict(candidate: Candidate, attemptIds: string[]): Conflict {
    const failed = this.state.evidence.filter(e => e.candidateId === candidate.id && e.outcome === 'FAIL');
    const publicFailures = this.publicRepairEvidence(candidate.id, failed.map(e => e.id));
    const stale = publicFailures.find(e => e.observations.some(o => o.action === 'read' && o.expected !== o.observed));
    const counterexample = stale || publicFailures[0];
    return { id: id('conflict'), category: 'behavioural-interaction', candidateId: candidate.id, attemptIds, status: 'OPEN',
      summary: stale ? `After an acknowledged write, the next read returned ${stale.observations.find(o => o.action === 'read' && o.expected !== o.observed)!.observed}; expected ${stale.observations.find(o => o.action === 'read' && o.expected !== o.observed)!.expected}.`
        : counterexample ? 'Selected composition failed the retained-value contract.' : 'Protected audit checks failed. Detailed audit observations are withheld from repair; release remains blocked.',
      evidenceIds: failed.map(e => e.id), ...(counterexample ? { counterexample: counterexample.observations, reproducer: counterexample.observations.map(o => o.action) } : {}) };
  }
  private authoringContext(attempt: Attempt, baseManifest: Manifest, source: Record<string, Buffer>, repairConflict?: Conflict, retainedConversation?: SelectedSessionContext, advisory?: SourceAdvisory): { selectedItems: any[]; rendered: string } {
    const selectedItems: any[] = [{ kind: 'goal', trustClass: 'authority-assignment', goalRevision: this.state.goal.revision, description: this.state.goal.description }, { kind: 'source', trustClass: 'host-verified-source', commit: attempt.workBase, manifestDigest: digest(protocolManifest(baseManifest)) }, { kind: 'public-contract', trustClass: 'registered-contract-description', probes: publicProbes }];
    const advisoryItem = advisory ? { kind: 'source-advisory', trustClass: 'untrusted-source-context', authorityEligible: false, acceptanceEligible: false, digest: digest(advisory), includedInPrompt: true, advisory } : undefined;
    if (advisoryItem) selectedItems.push(advisoryItem);
    if (attempt.contextReference) {
      if (!retainedConversation || digest(retainedConversation) !== attempt.contextReference.selectedContextDigest || attempt.workBase !== attempt.contextReference.sourceCommit || digest(protocolManifest(baseManifest)) !== attempt.contextReference.sourceManifestDigest) throw new Error('CONTINUATION_RENDERED_CONTEXT_MISMATCH');
      selectedItems.push({ kind: 'retained-conversation', trustClass: 'agent-reported-session', authorityEligible: false, acceptanceEligible: false, reference: attempt.contextReference, retainedConversation });
    }
    if (repairConflict) {
      // Re-select from the protected plan even for conflicts retained by older controllers.
      const publicFailures = this.publicRepairEvidence(repairConflict.candidateId!, repairConflict.evidenceIds).filter(e => e.outcome === 'FAIL');
      const trace = publicFailures.find(e => e.observations.some(o => o.action === 'read' && o.expected !== o.observed)) || publicFailures[0];
      const witness = repairConflict.witness?.rows.every(row => this.publicRepairEvidence(row.candidateId, [row.evidenceId]).some(e => e.outcome === row.outcome)) ? repairConflict.witness : undefined;
      if (trace) selectedItems.push({ kind: 'counterexample', trustClass: 'checker-observation', candidateId: repairConflict.candidateId, evidenceIds: publicFailures.map(e => e.id), reproducer: trace.observations.map(o => o.action), observations: trace.observations, ...(witness ? { witness } : {}) });
      else selectedItems.push({ kind: 'withheld-observation', trustClass: 'authority-disclosure-policy', candidateId: repairConflict.candidateId, message: 'Protected audit checks failed. Detailed audit observations are withheld from repair; release remains blocked.' });
      selectedItems.push({ kind: 'contributions', trustClass: 'authority-lineage', attemptIds: repairConflict.attemptIds });
    }
    const render = (includeAdvisory: boolean) => canonical({ assignment: attempt.assigned, allowedPaths: attempt.allowedPaths, context: selectedItems.filter(item => includeAdvisory || item !== advisoryItem), source: Object.fromEntries(Object.entries(source).filter(([path]) => !includeAdvisory || advisory?.status !== 'READY' || attempt.allowedPaths.includes(path)).map(([path, bytes]) => [path, bytes.toString('utf8')])) });
    let rendered = render(true);
    if (advisoryItem && !sourceAdvisoryFitsPrompt(rendered)) { advisoryItem.includedInPrompt = false; rendered = render(false); }
    return { selectedItems, rendered };
  }
  private async executeAttempt(attempt: Attempt, repairConflict?: Conflict, retainedConversation?: SelectedSessionContext): Promise<void> {
    const workspace = join(this.directory, 'workspaces', attempt.id);
    let broker: Awaited<ReturnType<typeof createModelBroker>> | undefined; const brokerObservations: any[] = [];
    try {
      this.assertOpen();
      const { manifest: baseManifest, files: source } = await this.git.hydrateWithFiles(attempt.workBase, workspace);
      this.assertOpen();
      const integrations: Partial<ReturnType<typeof authoringIntegrations>> = attempt.mode === 'pi' ? authoringIntegrations() : {};
      let advisory: SourceAdvisory | undefined;
      if (integrations.narsil) {
        const manifest = protocolManifest(baseManifest), sourceManifestDigest = digest(manifest);
        const result = await buildNarsilContext({ sourceCommit: attempt.workBase, sourceManifestDigest, manifest, filesBase64: Object.fromEntries(Object.entries(source).map(([path, bytes]) => [path, bytes.toString('base64')])), assignedPaths: attempt.allowedPaths, config: integrations.narsil });
        if (result.reason === 'TERMINATION_UNCONFIRMED') throw new Error('NARSIL_TERMINATION_UNCONFIRMED');
        this.assertOpen();
        advisory = await validateSourceAdvisory(result, { sourceCommit: attempt.workBase, sourceManifestDigest, manifest, assignedPaths: attempt.allowedPaths, readFile: async contentDigest => {
          const entry = manifest.entries.find(entry => entry.digest === contentDigest); if (!entry) throw new Error('ADVISORY_SOURCE_UNAVAILABLE'); return source[entry.path];
        } });
        await this.durableWrite(join(this.directory, 'objects', digest(advisory).slice(7) + '.json'), advisory);
      }
      const { selectedItems, rendered } = this.authoringContext(attempt, baseManifest, source, repairConflict, retainedConversation, advisory);
      this.assertOpen();
      if (attempt.mode === 'pi') broker = await createModelBroker(observation => brokerObservations.push({ kind: 'model-request', trustClass: 'broker-observed-model-request', ...observation }));
      if (integrations.interlinked) { attempt.previewTransport = 'host-ipc-v1'; attempt.previewLifecycle = { schemaVersion: 1, hostOwned: true, invalid: false, runs: [] }; await this.save(); }
      const config = { role: attempt.role, generation: attempt.generation, assignment: attempt.assigned, contextDigest: hashBytes(rendered), delayMs: 700, ...(broker ? { agentDir: join(this.directory, 'private-config', attempt.id + '-pi'), brokerUrl: broker.url, brokerToken: broker.token, model: broker.model, prompt: rendered, allowedPaths: attempt.allowedPaths, ...(integrations.interlinked ? { interlinked: { mode: integrations.interlinked.mode, transport: 'host-ipc-v1' } } : {}) } : {}) };
      const configPath = join(this.directory, 'private-config', attempt.id + '.json'); await this.durableWrite(configPath, config);
      // No await between the final fence and tracking the newly owned child.
      this.assertOpen();
      const child = spawn(process.execPath, [join(repository, 'services', attempt.mode === 'pi' ? 'pi-child.mjs' : 'agent-child.mjs'), configPath], { cwd: workspace, detached: true, env: { PATH: process.env.PATH, HOME: join(workspace, '.home'), TZ: 'UTC', LC_ALL: 'C', PI_OFFLINE: '1' }, stdio: integrations.interlinked ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
      this.children.set(attempt.id, child); attempt.status = 'RUNNING'; attempt.pid = child.pid; attempt.startedAt = now(); attempt.terminationObserved = false;
      if (integrations.interlinked) this.previewRequests(child, attempt, workspace, integrations.interlinked.cliPath);
      let output = '', truncated = false;
      const capture = (chunk: Buffer) => { if (output.length < 65536) output += chunk.toString().slice(0, 65536 - output.length); else truncated = true; };
      child.stdout!.on('data', capture); child.stderr!.on('data', capture);
      const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolveExit, reject) => {
        const deadline = setTimeout(() => { void this.stopAuthoring(child, attempt).catch(() => {}); }, this.state.goal.budget.authoringSeconds * 1000);
        child.once('error', reject); child.once(integrations.interlinked ? 'exit' : 'close', (code, signal) => { clearTimeout(deadline); this.stoppingAttempts.add(attempt.id);
          // Explicit IPC disconnect can prevent ChildProcess's aggregate close
          // event on some Node versions. Observe exit and both output streams.
          void Promise.all([this.authoringChannelsClosed(child), this.drainPreview(attempt)]).then(() => resolveExit({ code, signal }), reject);
        });
      });
      // Register exit observation before persistence can yield to shutdown.
      void exitPromise.catch(() => {});
      await this.record('attempt.running', `${attempt.name} is executing (${attempt.mode === 'pi' ? 'Pi JSON proposal adapter 1.0.2' : 'scripted fixture recipe'}).`, attempt.id);
      const exit = await exitPromise;
      attempt.completedAt = now(); attempt.terminationObserved = this.previewSettled(attempt); if (attempt.terminationObserved && attempt.reservation) attempt.reservation.status = 'RELEASED'; attempt.log = output; attempt.outputTruncated = truncated; this.children.delete(attempt.id);
      if (!attempt.terminationObserved) throw new Error('PREVIEW_TERMINATION_UNCONFIRMED');
      let sessionBytes = Buffer.from(canonical({ output, truncated, exit, brokerObservations }));
      if (attempt.mode === 'pi' && exit.code !== 0) {
        try {
          const handle = await open(join(this.directory, 'private-config', attempt.id + '-pi', 'partial-session.json'), 'r');
          let partial: Buffer;
          try { const buffer = Buffer.alloc(SESSION_CONTEXT_LIMITS.snapshotBytes + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); partial = buffer.subarray(0, bytesRead); }
          finally { await handle.close(); }
          validatePartialSessionCapture(partial);
          const partialSessionDigest = hashBytes(partial);
          await this.durableWrite(join(this.directory, 'sessions', attempt.id + '-partial.json'), { dataBase64: partial.toString('base64'), digest: partialSessionDigest, complete: false, acceptanceEligible: false });
          attempt.partialSessionDigest = partialSessionDigest;
        } catch { /* Missing/invalid partial output never becomes a resumable session. */ }
      }
      let sessionFormat = attempt.mode === 'pi' ? 'pi-process-transcript-v1-incomplete' : 'scripted-process-transcript-v1', sessionId: string | undefined, selectedSessionEntry: string | null | undefined;
      if (attempt.mode === 'pi' && exit.code === 0) {
        const handle = await open(join(this.directory, 'private-config', attempt.id + '-pi', 'session.json'), 'r');
        try {
          const bounded = Buffer.alloc(1024 * 1024 + 1); const { bytesRead } = await handle.read(bounded, 0, bounded.length, 0);
          if (bytesRead > 1024 * 1024) throw new Error('SESSION_SNAPSHOT_SIZE_LIMIT');
          sessionBytes = bounded.subarray(0, bytesRead);
        } finally { await handle.close(); }
        const reported = JSON.parse(output.trim());
        if (reported.type !== 'model_result' || reported.session?.digest !== hashBytes(sessionBytes) || reported.session.format !== 'pi-sdk-1.0.2-session-entries-v1') throw new Error('SESSION_SNAPSHOT_IDENTITY_MISMATCH');
        sessionFormat = reported.session.format;
        if (typeof reported.session.sessionId !== 'string' || reported.session.sessionId.length > 128 || reported.session.selectedEntry !== null && (typeof reported.session.selectedEntry !== 'string' || reported.session.selectedEntry.length > 128)) throw new Error('SESSION_SNAPSHOT_METADATA_INVALID');
        sessionId = reported.session.sessionId; selectedSessionEntry = reported.session.selectedEntry;
        selectedItems.push({ kind: 'authoring-diagnostics', trustClass: 'authoring-generation-diagnostic', acceptanceEligible: false, observations: reported.diagnostics, modelCalls: reported.modelCalls });
        if (reported.previews?.length) selectedItems.push({ kind: 'changeset-previews', trustClass: 'authoring-generation-diagnostic', acceptanceEligible: false, observations: reported.previews, retainedInSession: true });
      }
      const sessionDigest = hashBytes(sessionBytes); await this.durableWrite(join(this.directory, 'sessions', attempt.id + '.json'), { dataBase64: sessionBytes.toString('base64'), digest: sessionDigest, format: sessionFormat });
      if (exit.code !== 0) throw new Error(`Agent process exited ${exit.code ?? exit.signal}. ${output.slice(-1200)}`);
      const { files, modes } = await this.readWorkspace(workspace);
      const commit = await this.git.createCommit(files, attempt.workBase, `${attempt.name} submission`, modes);
      const resultManifest = await this.git.manifest(commit), actualChanges = changedPaths(baseManifest, resultManifest);
      if (actualChanges.some(path => !attempt.allowedPaths.includes(path))) throw new Error('SUBMISSION_OUTSIDE_ACTUAL_PATH_GRANT');
      attempt.commit = commit; attempt.changedPaths = actualChanges; attempt.submissionId = id('submission');
      const capsule: Capsule = { id: id('capsule'), attemptId: attempt.id, digest: '', sourceCommit: commit, sourceManifestDigest: digest(protocolManifest(resultManifest)), goalRevision: this.state.goal.revision, adapter: attempt.mode === 'pi' ? 'pi-sdk-1.0.2-json-proposal-v1' : 'scripted-fixture-v1', generation: attempt.generation, selectorVersion: attempt.contextReference?.selectorVersion ?? 'protected-repair-disclosure-v2', sessionDigest, sessionFormat, ...(sessionId ? { sessionId, selectedSessionEntry } : {}), renderedContextDigest: hashBytes(rendered), selectedItems: [...selectedItems, ...brokerObservations], missingTail: truncated, limitations: ['Source and finalized process transcript are associated after process termination; no atomic live filesystem/model snapshot claim.', 'Agent output is an attributed claim. It cannot authorize publication or satisfy protected acceptance.'] };
      capsule.digest = digest({ ...capsule, digest: undefined }); await this.durableWrite(join(this.directory, 'capsules', capsule.id + '.json'), capsule);
      this.state.capsules.push(capsule); attempt.capsuleId = capsule.id; attempt.status = 'SUBMITTED';
      await this.git.git(['update-ref', `refs/attempts/${attempt.id}`, commit]);
      await this.record('attempt.submitted', `${attempt.name} submitted immutable Git ${commit.slice(0, 10)} and retained source/context capsule.`, attempt.id);
    } catch (error) {
      if (!attempt.pid && (error as Error).message === 'PLATFORM_CLOSING') {
        attempt.terminationObserved = true; attempt.completedAt = now(); if (attempt.reservation) attempt.reservation.status = 'RELEASED';
      }
      attempt.status = attempt.terminationObserved ? 'FAILED' : 'INFRASTRUCTURE_UNKNOWN'; attempt.error = String((error as Error).message); await this.record('attempt.failed', `${attempt.name}: ${attempt.error}`, attempt.id);
    }
    finally { await broker?.close(); await rm(join(this.directory, 'private-config', attempt.id + '.json'), { force: true }); }
  }
  /** Local Pi supplies proposals only. The controller owns the CLI, grant and lifecycle journal. */
  private previewRequests(child: ChildProcess, attempt: Attempt, workspace: string, cliPath: string): void {
    child.on('message', message => {
      const request = message as { type?: string; round?: number; files?: Record<string, string> };
      const journal = attempt.previewLifecycle!;
      if (this.closing || this.stoppingAttempts.has(attempt.id) || !child.connected || child.exitCode !== null || child.signalCode !== null) return;
      if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['type', 'round', 'files'].includes(key))
        || request.type !== 'confidence-preview-request' || request.round !== journal.runs.length || journal.runs.length >= 3 || this.previews.has(attempt.id)
        || !request.files || typeof request.files !== 'object' || Array.isArray(request.files) || Object.keys(request.files).length < 1
        || Object.entries(request.files).some(([path, bytes]) => !attempt.allowedPaths.includes(path) || typeof bytes !== 'string' || Buffer.byteLength(bytes) > INTERLINKED_PREVIEW_LIMITS.fileBytes)
        || Buffer.byteLength(JSON.stringify(request.files)) > INTERLINKED_PREVIEW_LIMITS.inputBytes) {
        journal.invalid = true; void this.save().catch(() => {}); void this.stopAuthoring(child, attempt).catch(() => {}); return;
      }
      const run: NonNullable<Attempt['previewLifecycle']>['runs'][number] = { round: request.round!, state: 'PREPARING', terminationObserved: false };
      journal.runs.push(run); const abort = new AbortController();
      const done = (async () => {
        try {
          // Durable uncertainty precedes dispatch. A missing PID after restart
          // cannot be converted to absence merely because the Pi owner is gone.
          await this.save();
          const homePath = join(this.directory, 'private-config', attempt.id + '-preview'), temporaryPath = join(homePath, 'tmp');
          await mkdir(temporaryPath, { recursive: true, mode: 0o700 });
          if (this.closing || this.stoppingAttempts.has(attempt.id) || !child.connected || child.exitCode !== null || child.signalCode !== null) abort.abort();
          const observation = await runInterlinkedPreview({ cwd: workspace, files: request.files!, allowedPaths: attempt.allowedPaths, cliPath, generation: attempt.generation, signal: abort.signal, homePath, temporaryPath,
            onLifecycle: async event => {
              if (event.phase === 'SPAWNED' && event.pid !== undefined) { run.pid = event.pid; run.state = 'RUNNING'; }
              if (event.phase === 'SETTLED') { run.terminationObserved = event.terminationObserved; if (event.terminationObserved) run.state = 'SETTLED'; }
              try { await this.save(); } catch (error) { journal.invalid = true; throw error; }
            },
          });
          // Missing/invalid CLI inputs may return before any process exists.
          if (!journal.invalid && run.pid === undefined && !observation.process) { run.state = 'SETTLED'; run.terminationObserved = true; }
          await this.save();
          if (child.connected && child.exitCode === null && child.signalCode === null) child.send({ type: 'confidence-preview-result', round: request.round, cancelled: abort.signal.aborted || this.closing || journal.invalid || observation.reason === 'PREVIEW_LIFECYCLE_FAILED', observation }, () => {});
        } catch {
          journal.invalid = true; abort.abort();
          if (child.connected) child.send({ type: 'confidence-preview-result', round: request.round, cancelled: true }, () => {});
          await this.save().catch(() => {});
        } finally { this.previews.delete(attempt.id); }
      })();
      this.previews.set(attempt.id, { abort, done });
    });
    child.once('disconnect', () => { this.stoppingAttempts.add(attempt.id); this.previews.get(attempt.id)?.abort.abort(); });
  }
  private async drainPreview(attempt: Attempt): Promise<void> {
    const active = this.previews.get(attempt.id); active?.abort.abort(); await active?.done;
  }
  private async authoringChannelsClosed(child: ChildProcess): Promise<void> {
    await Promise.all([
      ...[child.stdout, child.stderr].map(stream => !stream || stream.destroyed ? Promise.resolve() : new Promise<void>(resolve => stream.once('close', resolve))),
      !child.connected ? Promise.resolve() : new Promise<void>(resolve => child.once('disconnect', resolve)),
    ]);
  }
  private async stopAuthoring(child: ChildProcess, attempt: Attempt): Promise<boolean> {
    this.stoppingAttempts.add(attempt.id);
    if (child.connected) child.disconnect();
    // Stop the owned analyzer before the Pi owner, with grace exceeding the
    // adapter's bounded group cleanup. Incomplete drainage keeps capacity held.
    const active = this.previews.get(attempt.id); active?.abort.abort();
    if (active) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([active.done, new Promise(resolve => { deadline = setTimeout(resolve, INTERLINKED_PREVIEW_LIMITS.cleanupMs + 1000); })]); }
      finally { clearTimeout(deadline); }
    }
    let stopped: boolean;
    if (attempt.previewTransport === 'host-ipc-v1') {
      const exited = () => child.exitCode !== null || child.signalCode !== null;
      const waitExit = async () => {
        if (exited()) return true;
        let deadline: ReturnType<typeof setTimeout> | undefined, listener: () => void;
        try { return await new Promise<boolean>(resolve => { listener = () => resolve(true); child.once('exit', listener); deadline = setTimeout(() => resolve(false), 1000); }); }
        finally { clearTimeout(deadline); child.off('exit', listener!); }
      };
      const signal = (value: NodeJS.Signals) => { if (!exited()) { try { process.kill(-child.pid!, value); } catch { child.kill(value); } } };
      signal('SIGTERM'); stopped = await waitExit();
      if (!stopped) { signal('SIGKILL'); stopped = await waitExit(); }
    } else stopped = await stopProcess(child);
    if (stopped) await this.authoringChannelsClosed(child);
    return stopped && this.previewSettled(attempt);
  }
  private previewSettled(attempt: Attempt, reconcile = false): boolean {
    const journal = attempt.previewLifecycle;
    if (journal === undefined) return attempt.previewTransport === undefined;
    if (attempt.previewTransport !== 'host-ipc-v1' || !journal || journal.schemaVersion !== 1 || journal.hostOwned !== true || journal.invalid !== false || !Array.isArray(journal.runs) || journal.runs.length > 3) return false;
    for (const [round, run] of journal.runs.entries()) {
      if (!run || run.round !== round || !['PREPARING', 'RUNNING', 'SETTLED'].includes(run.state) || typeof run.terminationObserved !== 'boolean'
        || run.pid !== undefined && (!Number.isSafeInteger(run.pid) || run.pid <= 0)) return false;
      if (reconcile && run.state === 'RUNNING' && run.pid !== undefined) {
        // Never signal a persisted PID: it may have been reused by another task.
        try { process.kill(-run.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { run.state = 'SETTLED'; run.terminationObserved = true; } }
      }
      if (run.state !== 'SETTLED' || !run.terminationObserved) return false;
    }
    return true;
  }
  private async readWorkspace(workspace: string, prefix = ''): Promise<{ files: Record<string, Buffer>; modes: Record<string, string> }> {
    const files: Record<string, Buffer> = {}, modes: Record<string, string> = {};
    for (const name of (await readdir(join(workspace, prefix))).sort()) {
      const path = prefix ? `${prefix}/${name}` : name; if (path === '.home') continue;
      const stat = await lstat(join(workspace, path));
      if (stat.isSymbolicLink()) throw new Error('UNSUPPORTED_SYMLINK_SUBMISSION');
      if (stat.isDirectory()) { const nested = await this.readWorkspace(workspace, path); Object.assign(files, nested.files); Object.assign(modes, nested.modes); }
      else if (stat.isFile()) { if (stat.size > 1024 * 1024) throw new Error('SOURCE_FILE_LIMIT'); files[path] = await readFile(join(workspace, path)); modes[path] = (stat.mode & 0o111) ? '100755' : '100644'; }
      else throw new Error('UNSUPPORTED_SOURCE_ENTRY');
    } return { files, modes };
  }
  async candidateSource(candidateId: string, version: 'candidate' | 'base') {
    if (version !== 'candidate' && version !== 'base') throw new Error('SOURCE_VERSION_INVALID');
    const candidate = this.state.candidates.find(item => item.id === candidateId);
    if (!candidate) throw new Error('CANDIDATE_NOT_FOUND');
    const commit = version === 'candidate' ? candidate.commit : candidate.publicationBase;
    const commitBytes = await this.git.git(['cat-file', 'commit', commit]);
    const parent = /^parent ([a-f0-9]{40})$/m.exec(commitBytes.toString())?.[1] ?? null;
    const manifest = protocolManifest(await this.git.manifest(commit)), objects = await this.gitObjects(commit);
    const source = { commit, parent, commitBytesDigest: hashBytes(commitBytes), manifest, manifestDigest: digest(manifest), objects, objectsDigest: digest(objects) };
    if (version === 'candidate' && (source.manifestDigest !== candidate.manifestDigest || source.commitBytesDigest !== candidate.commitBytesDigest)) throw new Error('SOURCE_IDENTITY_MISMATCH');
    const checked = JSON.parse(getKernel().validate_git_source(canonical({ candidate: { id: candidate.id, digest: candidate.digest, commit, parent: parent ?? '', commitBytesDigest: source.commitBytesDigest, manifestDigest: source.manifestDigest }, manifest, gitObjects: objects })));
    if (!checked.valid) throw new Error(checked.reason);
    const result = { schemaVersion: 1, scope: this.scope(), candidateId: candidate.id, candidateDigest: candidate.digest, version, source };
    if (Buffer.byteLength(canonical(result)) > 8 * 1024 * 1024) throw new Error('SOURCE_VIEW_LIMIT');
    return result;
  }
  async gitObjects(commit: string): Promise<GitObject[]> {
    const commitBytes = await this.git.git(['cat-file', 'commit', commit]); const root = /^tree ([a-f0-9]{40})\n/.exec(commitBytes.toString())![1];
    const tree = (await this.git.git(['ls-tree', '-r', '-t', '-z', commit])).toString();
    const objects = new Map<string, GitObject['type']>([[commit, 'commit'], [root, 'tree']]);
    for (const line of tree.split('\0').filter(Boolean)) { const match = /^\d+ (tree|blob) ([a-f0-9]{40})\t/.exec(line); if (!match) throw new Error('Unsupported raw tree object'); objects.set(match[2], match[1] as GitObject['type']); }
    const bytes = await this.git.batchObjects([...objects].map(([oid, type]) => ({ oid, type })));
    return [...objects].map(([oid, type]) => ({ oid, type, dataBase64: bytes.get(oid)!.toString('base64') }));
  }
  private async freezeCandidate(name: string, commit: string, attemptIds: string[], composition: string[], publicationBase: string, repairOf?: string): Promise<Candidate> {
    const manifest = await this.git.manifest(commit), manifestDigest = digest(protocolManifest(manifest));
    const commitBytes = await this.git.git(['cat-file', 'commit', commit]);
    const candidate: Candidate = { id: id('candidate'), name, digest: digest({ commit, commitBytesDigest: hashBytes(commitBytes), parent: publicationBase, manifestDigest, attemptIds, composition, materializer: 'whole-file-delta-v1' }), commit, commitBytesDigest: hashBytes(commitBytes), manifestDigest, manifest, publicationBase, attemptIds, submissionIds: attemptIds.map(a => this.state.attempts.find(x => x.id === a)!.submissionId!), composition, status: 'READY', evaluationIds: [], createdAt: now(), changedPaths: changedPaths(await this.git.manifest(publicationBase), manifest), ...(repairOf ? { repairOf } : {}) };
    const manifestResult = JSON.parse(getKernel().validate_manifest(canonical(protocolManifest(manifest)))); if (!manifestResult.valid) throw new Error(manifestResult.reason);
    const parent = /^parent ([a-f0-9]{40})\n/m.exec(commitBytes.toString())?.[1] || '';
    const checked = JSON.parse((getKernel() as any).validate_git_source(canonical({ candidate: { id: candidate.id, digest: candidate.digest, commit, commitBytesDigest: candidate.commitBytesDigest, parent, manifestDigest }, manifest: protocolManifest(manifest), gitObjects: await this.gitObjects(commit) })));
    if (!checked.valid) throw new Error(checked.reason);
    const bundle = await this.git.bundle(commit, join(this.directory, 'bundles', candidate.id + '.gitbundle'));
    await this.durableWrite(join(this.directory, 'objects', candidate.id + '-source.json'), { candidateDigest: candidate.digest, manifest: protocolManifest(manifest), commitBytesDigest: candidate.commitBytesDigest, gitBundleDigest: bundle.digest });
    candidate.sourceFiles = Object.fromEntries(Object.entries(await this.git.files(commit)).map(([path, bytes]) => [path, bytes.toString('utf8')]));
    this.state.candidates.push(candidate); await this.record('candidate.materialized', `${name}: exact Git objects, strong manifest and native bundle roundtrip verified.`, candidate.id); return candidate;
  }
  async compose(attemptIds: string[], name = 'Selected composition'): Promise<Candidate | undefined> {
    if (attemptIds.length < 1 || attemptIds.length > 4 || new Set(attemptIds).size !== attemptIds.length) throw new Error('SELECTION_LIMIT');
    const attempts = attemptIds.map(a => this.state.attempts.find(x => x.id === a));
    if (attempts.some(a => !a || a.status !== 'SUBMITTED' || !a.commit || a.publicationBase !== this.state.acceptedHead)) throw new Error('SELECTION_NOT_CURRENT_SUBMISSIONS');
    const base = this.state.acceptedHead, baseManifest = await this.git.manifest(base), baseFiles = await this.git.files(base), result = { ...baseFiles }; const writes = new Map<string, any>();
    const manifests = await Promise.all((attempts as Attempt[]).map(a => this.git.manifest(a.commit!)));
    const composed = JSON.parse((getKernel() as any).compose_manifests(canonical({ base: protocolManifest(baseManifest), submissions: manifests.map((manifest, n) => ({ id: attempts[n]!.submissionId!, manifest: protocolManifest(manifest) })) })));
    if (!composed.accepted) {
      const conflict: Conflict = { id: id('conflict'), category: 'mechanical-overlap', attemptIds, status: 'OPEN', summary: `${composed.reason}: ${canonical(composed.conflicts || [])}`, evidenceIds: [] };
      this.state.conflicts.push(conflict); await this.record('composition.mechanical-conflict', conflict.summary, conflict.id); return undefined;
    }
    const modes: Record<string, string> = Object.fromEntries(baseManifest.entries.map(e => [e.path, e.mode]));
    for (const attempt of attempts as Attempt[]) {
      if (attempt.workBase !== base) throw new Error('SPECULATIVE_BASE_REQUIRES_REPAIR_LINEAGE');
      const manifest = await this.git.manifest(attempt.commit!), files = await this.git.files(attempt.commit!);
      for (const path of changedPaths(baseManifest, manifest)) {
        const entry = manifest.entries.find(e => e.path === path) || null;
        if (writes.has(path) && digest(writes.get(path)) !== digest(entry)) {
          const conflict: Conflict = { id: id('conflict'), category: 'mechanical-overlap', attemptIds, status: 'OPEN', summary: `Different immutable writes to ${path}.`, evidenceIds: [] };
          this.state.conflicts.push(conflict); await this.record('composition.mechanical-conflict', conflict.summary, conflict.id); return undefined;
        }
        writes.set(path, entry); if (entry) { result[path] = files[path]; modes[path] = entry.mode; } else { delete result[path]; delete modes[path]; }
      }
    }
    const commit = await this.git.createCommit(result, base, `${name}\nContributors: ${attemptIds.join(', ')}`, modes);
    if (digest(protocolManifest(await this.git.manifest(commit))) !== digest(composed.manifest)) throw new Error('MATERIALIZATION_DIFFERS_FROM_KERNEL');
    return this.freezeCandidate(name, commit, attemptIds, attempts.map(a => a!.submissionId!), base);
  }
  private protocolPlan(candidate: Candidate, evaluation: Evaluation): EvaluationPlan {
    const input = { candidateId: candidate.id, candidateDigest: candidate.digest, jobs: evaluation.jobs.map(job => ({ id: job.id, inputDigest: job.evaluationInputDigest, required: job.required, evidenceClass: 'protected-behavioural' as const })) };
    return { ...input, digest: digest(input) };
  }
  private admissionEvidence(evidence: Evidence, candidate: Candidate): AdmissionEvidence {
    const withoutDigest: any = { id: evidence.id, jobId: evidence.jobId, inputDigest: evidence.evaluationInputDigest, candidateId: candidate.id, candidateDigest: candidate.digest, outcome: evidence.outcome, evidenceClass: 'protected-behavioural', authorized: true, observationDigest: (evidence as any).observationDigest };
    return { ...withoutDigest, digest: digest(withoutDigest) };
  }
  async evaluate(candidate: Candidate, contract: Evaluation['contract']): Promise<Evaluation> {
    this.assertOpen(); this.activeEvaluations++;
    try { return await this.evaluateOpen(candidate, contract); } finally { this.activeEvaluations--; }
  }
  private async evaluateOpen(candidate: Candidate, contract: Evaluation['contract']): Promise<Evaluation> {
    this.assertEvaluationSettled();
    const evaluation = await this.evaluator.plan(candidate, contract); this.assertOpen(); candidate.evaluationIds.push(evaluation.id); candidate.status = 'EVALUATING'; evaluation.status = 'RUNNING'; this.state.evaluations.push(evaluation);
    try { await this.record('evaluation.frozen', `Frozen ${evaluation.jobs.length} named fresh HTTP jobs for ${candidate.name} (${contract}).`, evaluation.id); }
    catch (error) {
      evaluation.status = 'INFRASTRUCTURE_UNKNOWN'; evaluation.outcome = 'INCONCLUSIVE';
      candidate.status = 'INCONCLUSIVE'; candidate.outcome = 'INCONCLUSIVE';
      await this.save(); throw error;
    }
    let next = 0, interrupted = false;
    const failures: unknown[] = [];
    const worker = async () => {
      while (!interrupted && next < evaluation.jobs.length) {
        const job = evaluation.jobs[next++];
        try {
          this.assertOpen();
          const observation = await this.evaluator.runJob(candidate, evaluation, job, () => this.save(), async () => { this.assertOpen(); job.status = 'RUNNING'; await this.save(); this.assertOpen(); });
          if (!job.runtime?.terminationObserved || !observation.runtimeObservation?.terminationObserved) interrupted = true;
          const observationDigest = digest(observation); await this.durableWrite(join(this.directory, 'objects', observationDigest.slice(7) + '.json'), observation);
          const evidence: Evidence = { ...observation, id: id('evidence'), digest: '', envelope: null, observationDigest } as any;
          const admissionEvidence = this.admissionEvidence(evidence, candidate); evidence.digest = admissionEvidence.digest; evidence.envelope = this.keys.attest('checker', 'evidence', admissionEvidence, this.issuance());
          this.state.evidence.push(evidence); job.evidenceId = evidence.id; job.status = evidence.outcome; this.state.observationRevision++;
          await this.record('evaluation.observation', `${candidate.name} · ${job.name}: ${evidence.outcome} (${evidence.storeReadCount} backing-store reads).`, evidence.id);
          // Each job's output and signed attribution are durable before cleanup.
          if (job.runtime?.terminationObserved) await rm(join(this.directory, 'evaluations', job.id), { recursive: true, force: true });
        } catch (error) {
          interrupted = true; failures.push(error);
          if (!job.runtime || job.runtime.terminationObserved) job.status = 'INCONCLUSIVE';
        }
      }
    };
    // Await both workers even after infrastructure failure. No started job may
    // mutate state after this operation returns or rejects.
    await Promise.allSettled(Array.from({ length: Math.min(this.evaluationConcurrency, evaluation.jobs.length) }, worker));
    if (interrupted) {
      evaluation.status = 'INFRASTRUCTURE_UNKNOWN'; evaluation.outcome = 'INCONCLUSIVE';
      candidate.status = 'INCONCLUSIVE'; candidate.outcome = 'INCONCLUSIVE';
      await this.record('evaluation.interrupted', `${candidate.name}: evaluation interrupted; retained results and unfinished reservations require reconciliation.`, evaluation.id);
      throw failures[0] ?? new Error('EVALUATION_GENERATION_UNRESOLVED');
    }
    const outcomes = evaluation.jobs.map(j => this.state.evidence.find(e => e.id === j.evidenceId)!.outcome);
    evaluation.outcome = outcomes.every(o => o === 'PASS') ? 'PASS' : outcomes.includes('FAIL') ? 'FAIL' : 'INCONCLUSIVE'; evaluation.status = 'COMPLETED'; evaluation.completedAt = now();
    candidate.outcome = evaluation.outcome; candidate.status = evaluation.outcome === 'PASS' ? 'CHECKED' : evaluation.outcome === 'FAIL' ? 'FAILED' : 'INCONCLUSIVE';
    await this.record('evaluation.closed', `${candidate.name}: ${contract} ${evaluation.outcome}. Every named job has a retained outcome.`, evaluation.id); return evaluation;
  }
  async select(body: { attemptIds: string[]; commandId?: string }, internal = false): Promise<any> {
    this.assertOpen();
    const normalized = { ...body, commandId: body.commandId || id('command') };
    if (this.selecting) {
      const command = this.command('local-sponsor', normalized.commandId, 'select', { attemptIds: body.attemptIds });
      if (command.previous) return command.previous;
      throw new Error('EVALUATION_BACKPRESSURE');
    }
    this.selecting = true;
    try { return await this.selectSerialized(normalized, internal); } finally { this.selecting = false; }
  }
  private async selectSerialized(body: { attemptIds: string[]; commandId?: string }, internal = false): Promise<any> {
    const commandId = body.commandId || id('command'), command = this.command('local-sponsor', commandId, 'select', { attemptIds: body.attemptIds }); if (command.previous) return command.previous;
    if ((this.busy || this.continuationPending) && !internal) throw new Error('AUTHORING_OR_REPAIR_STILL_RUNNING');
    await command.reserve();
    const roles = body.attemptIds.map(a => this.state.attempts.find(x => x.id === a)?.role), candidate = await this.compose(body.attemptIds, roles.join(' + '));
    if (!candidate) { const result = { state: 'MECHANICAL_CONFLICT' }; await command.commit(result); return result; }
    this.state.activeCandidateId = candidate.id;
    await this.evaluate(candidate, 'retained-value-v1');
    if (candidate.outcome === 'FAIL') {
      const conflict = this.failureConflict(candidate, body.attemptIds);
      if (roles.includes('A') && roles.includes('B')) {
        const A = body.attemptIds.find(a => this.state.attempts.find(x => x.id === a)?.role === 'A')!, B = body.attemptIds.find(a => this.state.attempts.find(x => x.id === a)?.role === 'B')!;
        const pair = await this.compose([A, B], 'A + B interaction witness'); if (pair) await this.evaluate(pair, 'freshness-v1');
        const baseline = [...this.state.candidates].reverse().find(c => c.name === 'Baseline')!;
        const individual = (attempt: string) => [...this.state.candidates].reverse().find(c => c.attemptIds.length === 1 && c.attemptIds[0] === attempt)!;
        const rows = [['Baseline', baseline], ['A', individual(A)], ['B', individual(B)], ['A+B', pair!]].map(([name, c]) => { const ca = c as Candidate, ev = this.state.evidence.find(e => e.candidateId === ca.id)!; return { name: name as string, candidateId: ca.id, evidenceId: ev.id, outcome: ev.outcome }; });
        const f = (n: number) => rows[n].outcome === 'FAIL' ? 1 : 0;
        conflict.witness = { rows, contrast: f(3) - f(1) - f(2) + f(0), scope: 'Four fresh runs of the same declared freshness contract. Tested combination versus tested components; no unique cause, universal independence or statistical significance claim.' };
        if (pair?.outcome === 'FAIL') { this.assertOpen(); conflict.reduction = await this.evaluator.reduce(pair); }
      }
      this.state.conflicts.push(conflict); this.state.demoStatus = 'CONFLICT'; await this.record('conflict.detected', conflict.summary, conflict.id);
    } else this.state.demoStatus = candidate.outcome === 'PASS' ? 'READY_FOR_REVIEW' : 'INCONCLUSIVE';
    const result = { candidateId: candidate.id, state: candidate.status, outcome: candidate.outcome, statusUrl: '/api/state' }; await command.commit(result); return result;
  }
  async repair(body: { conflictId: string; commandId?: string }): Promise<any> {
    this.assertOpen();
    const commandId = body.commandId || id('command'), command = this.command('local-sponsor', commandId, 'repair', { conflictId: body.conflictId }); if (command.previous) return command.previous;
    const conflict = this.state.conflicts.find(c => c.id === body.conflictId);
    if (!conflict?.candidateId || conflict.status !== 'OPEN' || this.busy || this.selecting || this.continuationPending || this.state.evaluations.some(e => e.status === 'INFRASTRUCTURE_UNKNOWN')) throw new Error('REPAIR_NOT_AVAILABLE');
    this.assertContinuationCapacity();
    const failing = this.state.candidates.find(c => c.id === conflict.candidateId)!;
    // Hold authoring capacity before persistence yields to another command.
    this.busy = true;
    let attempt: Attempt;
    let result: { attemptId: string; state: string; statusUrl: string };
    try {
      await command.reserve();
      attempt = await this.newAttempt('repair', this.state.demoMode || 'scripted', failing.commit); conflict.status = 'REPAIRING'; conflict.repairAttemptId = attempt.id;
      result = { attemptId: attempt.id, state: 'RUNNING', statusUrl: '/api/state' }; await command.commit(result);
    } catch (error) { this.busy = false; throw error; }
    void (async () => {
      await this.executeAttempt(attempt, conflict); this.assertOpen(); if (attempt.status !== 'SUBMITTED') throw new Error(attempt.error || 'Repair did not submit');
      const files = await this.git.files(attempt.commit!); const modes = Object.fromEntries((await this.git.manifest(attempt.commit!)).entries.map(e => [e.path, e.mode]));
      const commit = await this.git.createCommit(files, this.state.acceptedHead, 'Retained-value repair\nInherited lineage: ' + failing.submissionIds.join(', ') + '\nRepair: ' + attempt.submissionId, modes);
      const repairedName = 'Repaired ' + failing.attemptIds.map(reference => this.state.attempts.find(a => a.id === reference)!.role).join(' + ');
      const candidate = await this.freezeCandidate(repairedName, commit, [...failing.attemptIds, attempt.id], [...failing.composition, attempt.submissionId!], this.state.acceptedHead, failing.id);
      await this.evaluate(candidate, 'retained-value-v1'); conflict.repairCandidateId = candidate.id; conflict.status = candidate.outcome === 'PASS' ? 'RESOLVED' : 'REPAIR_FAILED'; this.state.activeCandidateId = candidate.id; this.state.demoStatus = candidate.outcome === 'PASS' ? 'READY_FOR_REVIEW' : 'CONFLICT';
      await this.record('repair.completed', `Repair from the exact failed source: retained-value goal ${candidate.outcome}.`, candidate.id);
    })().catch(async error => { conflict.status = 'REPAIR_FAILED'; this.state.error = String(error.message); await this.record('repair.failed', this.state.error!); }).finally(() => { this.busy = false; }); return result;
  }
  async review(body: { candidateId: string; commandId?: string }): Promise<Review> {
    const commandId = body.commandId || id('command'), command = this.command('local-sponsor', commandId, 'review', { candidateId: body.candidateId }); if (command.previous) return command.previous;
    if (this.busy || this.selecting) throw new Error('AUTHORING_OR_REPAIR_STILL_RUNNING');
    this.assertEvaluationSettled();
    await command.reserve();
    const candidate = this.state.candidates.find(c => c.id === body.candidateId); if (!candidate || candidate.publicationBase !== this.state.acceptedHead) throw new Error('REVIEW_CANDIDATE_STALE');
    const evaluation = [...this.state.evaluations].reverse().find(e => e.candidateId === candidate.id && isCurrentFullReleasePlan(e) && e.outcome === 'PASS');
    if (!evaluation) throw new Error('REQUIRED_RETAINED_VALUE_PLAN_NOT_PASSED');
    const evidence = evaluation.jobs.map(job => this.state.evidence.find(e => e.id === job.evidenceId)!);
    if (this.state.evidence.some(e => e.candidateId === candidate.id && e.outcome === 'FAIL')) throw new Error('CONTRADICTORY_FAILURE_RETAINED');
    const proposal: ReviewProposal = { schemaVersion: 1, scope: this.scope(), candidateId: candidate.id, candidateDigest: candidate.digest, expectedHead: this.state.acceptedHead, newHead: candidate.commit, manifestDigest: candidate.manifestDigest, goalRevision: this.state.goal.revision, policyRevision: '1', observationRevision: String(this.state.observationRevision), planDigest: this.protocolPlan(candidate, evaluation).digest, evidenceDigests: evidence.map(e => e.digest).sort(), requiredEvidenceClass: 'protected-behavioural', expiresAt: seconds() + 900 };
    const review: Review = { id: id('review'), candidateId: candidate.id, proposalDigest: digest(proposal), expectedHead: proposal.expectedHead, goalRevision: proposal.goalRevision, policyRevision: proposal.policyRevision, planDigest: proposal.planDigest, evidenceIds: evidence.map(e => e.id), observationRevision: this.state.observationRevision, expiresAt: new Date(proposal.expiresAt * 1000).toISOString(), status: 'PREPARED', protocolProposal: proposal };
    this.state.reviews.push(review); await this.record('review.prepared', `Exact review prepared for ${candidate.name}; commit ${candidate.commit.slice(0, 10)}, ${evidence.length} external observations.`, review.id); await command.commit(review); return review;
  }
  async approve(body: { proposalDigest: string; commandId?: string }): Promise<Review> {
    const commandId = body.commandId || id('command'), command = this.command('local-sponsor', commandId, 'approve', { proposalDigest: body.proposalDigest }); if (command.previous) return command.previous;
    this.assertEvaluationSettled(); await command.reserve();
    const review = this.state.reviews.find(r => r.proposalDigest === body.proposalDigest); if (!review || review.expectedHead !== this.state.acceptedHead || review.observationRevision !== this.state.observationRevision || Date.parse(review.expiresAt) <= Date.now() || review.approval?.consumedBy) throw new Error('REVIEW_STALE_OR_CONSUMED');
    if (!this.state.evaluations.some(evaluation => evaluation.candidateId === review.candidateId && evaluation.planDigest === review.planDigest && isCurrentFullReleasePlan(evaluation))) throw new Error('REVIEW_PROFILE_STALE');
    review.approval = { principal: 'local-sponsor', approvedAt: now() }; review.status = 'APPROVED';
    await this.record('review.approved', 'Local sponsor approval recorded for this exact proposal once.', review.id); await command.commit(review); return review;
  }
  async publish(body: { proposalDigest: string; commandId?: string; simulateLostResponse?: boolean }): Promise<any> {
    const result = this.publicationTail.then(() => this.publishSerialized(body)); this.publicationTail = result.catch(() => {}); return result;
  }
  private async publishSerialized(body: { proposalDigest: string; commandId?: string; simulateLostResponse?: boolean }): Promise<any> {
    const commandId = body.commandId || id('command'), command = this.command('local-sponsor', commandId, 'publish', { proposalDigest: body.proposalDigest, simulateLostResponse: body.simulateLostResponse === true }); if (command.previous) return command.previous;
    this.assertEvaluationSettled();
    const review = this.state.reviews.find(r => r.proposalDigest === body.proposalDigest); if (!review?.approval) throw new Error('EXACT_HUMAN_APPROVAL_REQUIRED');
    const candidate = this.state.candidates.find(c => c.id === review.candidateId)!;
    const evaluation = this.state.evaluations.find(e => e.planDigest === review.planDigest && e.candidateId === candidate.id)!;
    if (!evaluation || !isCurrentFullReleasePlan(evaluation)) throw new Error('REVIEW_PROFILE_STALE');
    const publicationId = id('publication'); const proposal = review.protocolProposal as ReviewProposal;
    const evidence = review.evidenceIds.map(e => this.state.evidence.find(x => x.id === e)!);
    const witness: AdmissionInput = { state: { scope: this.scope(), revision: String(this.state.revision), head: this.state.acceptedHead, gate: this.state.publications.some(p => p.status === 'RECOVERY_HOLD') ? 'RECOVERY' : 'OPEN', policyRevision: '1', goalRevision: this.state.goal.revision, observationRevision: String(this.state.observationRevision), publicationSequence: String(this.state.receipts.length), unresolvedPublicationId: this.state.publications.find(p => p.status !== 'FINALIZED')?.id || null, sponsor: { id: 'local-sponsor', canPublish: true }, reviewer: { id: 'local-sponsor', canApprove: true }, approval: { proposalDigest: review.proposalDigest, reviewerId: review.approval.principal, expiresAt: proposal.expiresAt, consumedBy: review.approval.consumedBy || null } }, proposal, candidate: { id: candidate.id, digest: candidate.digest, commit: candidate.commit, commitBytesDigest: candidate.commitBytesDigest, parent: candidate.publicationBase, manifestDigest: candidate.manifestDigest }, plan: this.protocolPlan(candidate, evaluation), evidence: evidence.map(e => this.admissionEvidence(e, candidate)), command: { id: commandId, callerId: 'local-sponsor', proposalDigest: review.proposalDigest, expectedRevision: String(this.state.revision), operationId: publicationId }, now: seconds() };
    for (const e of evidence) this.keys.verify(e.envelope as any, 'checker');
    const admission = evaluateAdmission(witness); if (!admission.accepted) throw new Error(admission.reason);
    const publication: Publication = { id: publicationId, candidateId: candidate.id, proposalDigest: review.proposalDigest, oldHead: witness.state.head, newHead: candidate.commit, status: 'ADMITTED', admittedAt: now(), dispatchCount: 0, admissionWitness: witness };
    review.approval.consumedBy = publication.id; review.status = 'CONSUMED'; this.state.publications.push(publication);
    await command.commit({ publicationId: publication.id, state: 'ADMITTED', statusUrl: '/api/state' });
    await this.record('publication.admitted', 'Shared Rust kernel admitted the exact proposal; its fixed old/new heads are retained.', publication.id);
    const admissionPredicate = { schemaVersion: 1, scope: this.scope(), operationId: publication.id, witnessDigest: digest(witness), proposalDigest: review.proposalDigest, candidateDigest: candidate.digest, oldHead: publication.oldHead, newHead: publication.newHead, sequence: admission.delta!.sequence, delta: admission.delta! };
    await this.durableWrite(join(this.directory, 'publications', publication.id + '.json'), { witness, admission: this.keys.attest('decision', 'admission', admissionPredicate, this.issuance(witness.state.revision)), sourceGitBundleDigest: hashBytes(await readFile(join(this.directory, 'bundles', candidate.id + '.gitbundle'))) });
    this.transitionPublication(publication, 'PREPARED', true); await this.save();
    this.transitionPublication(publication, 'DISPATCH', false); publication.dispatchCount++; publication.dispatchedAt = now(); await this.save();
    try {
      await this.git.publish(publication.oldHead, publication.newHead);
      if (body.simulateLostResponse) { this.transitionPublication(publication, 'AMBIGUOUS', false); publication.recoveryReason = 'Owned fault injection: remote update completed, its response was discarded. Confirmation is pending.'; await this.record('publication.unknown', publication.recoveryReason, publication.id); }
      else await this.reconcilePublication(publication);
    } catch (error) {
      if (['MAY_HAVE_DISPATCHED', 'UNKNOWN'].includes(publication.status)) this.transitionPublication(publication, 'AMBIGUOUS', false);
      publication.recoveryReason = `Publication requires reconciliation: ${String((error as Error).message)}`; await this.record('publication.unknown', publication.recoveryReason, publication.id);
    }
    const result = { publicationId: publication.id, state: publication.status, ...(publication.receiptId ? { receiptId: publication.receiptId } : {}), statusUrl: '/api/state' }; await command.commit(result); return result;
  }
  private transitionPublication(publication: Publication, event: string, verified: boolean): void {
    const transition = JSON.parse(getKernel().transition_publication(canonical({ phase: publication.status, gate: publication.status === 'RECOVERY_HOLD' ? 'RECOVERY' : 'OPEN', event, verified })));
    if (!transition.accepted) throw new Error(transition.reason); publication.status = transition.phase;
  }
  private assertEvaluationSettled(): void {
    if (this.state.attempts.some(attempt => !this.previewSettled(attempt))) throw new Error('AUTHORING_PREVIEW_UNRESOLVED');
    if (this.state.evaluations.some(evaluation => ['RUNNING', 'INFRASTRUCTURE_UNKNOWN'].includes(evaluation.status) || evaluation.jobs.some(job => job.runtime && !job.runtime.terminationObserved))) throw new Error('EVALUATION_GENERATION_UNRESOLVED');
  }
  async reconcile(body?: { commandId?: string }): Promise<any> {
    const command = body?.commandId ? this.command('local-sponsor', body.commandId, 'reconcile', {}) : undefined;
    if (command?.previous) return command.previous;
    await command?.reserve();
    const result = this.publicationTail.then(() => this.reconcileSerialized()); this.publicationTail = result.catch(() => {});
    const outcome = await result; await command?.commit(outcome); return outcome;
  }
  private async reconcileSerialized(): Promise<any> {
    for (const attempt of this.state.attempts.filter(a => a.status === 'INFRASTRUCTURE_UNKNOWN')) {
      if (!this.previewSettled(attempt, true)) continue;
      if (!attempt.pid) continue;
      try { process.kill(attempt.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { attempt.terminationObserved = true; if (attempt.reservation) attempt.reservation.status = 'RELEASED'; attempt.status = 'FAILED'; attempt.error = 'Retained process is absent after restart. Its result was not invented or replayed.'; } }
    }
    for (const evaluation of this.state.evaluations.filter(e => e.status === 'INFRASTRUCTURE_UNKNOWN')) {
      for (const job of evaluation.jobs) {
        if (!job.runtime || job.runtime.terminationObserved) continue;
        try { process.kill(job.runtime.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { job.runtime.terminationObserved = true; job.status = 'INCONCLUSIVE'; } }
      }
      if (evaluation.jobs.every(job => job.runtime?.terminationObserved || !job.runtime && ['QUEUED', 'INCONCLUSIVE'].includes(job.status))) {
        evaluation.status = 'COMPLETED'; evaluation.outcome = 'INCONCLUSIVE';
        const candidate = this.state.candidates.find(c => c.id === evaluation.candidateId); if (candidate && evaluation.purpose !== 'diagnostic') { candidate.status = 'INCONCLUSIVE'; candidate.outcome = 'INCONCLUSIVE'; }
      }
    }
    this.evaluator.reconcileCapacity();
    for (const publication of this.state.publications.filter(p => p.status !== 'FINALIZED')) await this.reconcilePublication(publication);
    await this.save(); return { publications: this.state.publications.map(p => ({ id: p.id, state: p.status, receiptId: p.receiptId })), statusUrl: '/api/state' };
  }
  private async reconcilePublication(publication: Publication): Promise<void> {
    if (publication.status === 'FINALIZED') return;
    if (publication.status === 'ADMITTED') {
      if (!existsSync(join(this.directory, 'publications', publication.id + '.json'))) {
        const witness = publication.admissionWitness as AdmissionInput; const replayed = evaluateAdmission(witness);
        if (!replayed.accepted) throw new Error('RETAINED_ADMISSION_INVALID');
        const candidate = this.state.candidates.find(c => c.id === publication.candidateId)!;
        const predicate = { schemaVersion: 1, scope: this.scope(), operationId: publication.id, witnessDigest: digest(witness), proposalDigest: publication.proposalDigest, candidateDigest: candidate.digest, oldHead: publication.oldHead, newHead: publication.newHead, sequence: replayed.delta!.sequence, delta: replayed.delta! };
        await this.durableWrite(join(this.directory, 'publications', publication.id + '.json'), { witness, admission: this.keys.attest('decision', 'admission', predicate, this.issuance(witness.state.revision)), sourceGitBundleDigest: hashBytes(await readFile(join(this.directory, 'bundles', candidate.id + '.gitbundle'))) });
      }
      this.transitionPublication(publication, 'PREPARED', true); await this.save();
    }
    if (publication.status === 'READY') {
      this.transitionPublication(publication, 'DISPATCH', false); publication.dispatchCount++; publication.dispatchedAt = now(); await this.save();
      try { await this.git.publish(publication.oldHead, publication.newHead); }
      catch (error) { this.transitionPublication(publication, 'AMBIGUOUS', false); publication.recoveryReason = 'Fixed admitted-head recovery dispatch requires observation: ' + String((error as Error).message); await this.save(); }
    }
    const head = await this.git.remoteHead();
    if (head === publication.newHead) {
      await this.git.verifyRemote(publication.newHead);
      if (!['OBSERVED', 'RECEIPT_DURABLE'].includes(publication.status)) this.transitionPublication(publication, 'OBSERVE_NEW', true);
      publication.confirmedAt ||= now(); await this.save(); await this.finalize(publication); return;
    }
    if (head === publication.oldHead) {
      if (['MAY_HAVE_DISPATCHED', 'UNKNOWN'].includes(publication.status)) this.transitionPublication(publication, 'OBSERVE_OLD', false);
      publication.recoveryReason = 'The old head is still observed. That does not prove an in-flight dispatch was cancelled; the publication slot remains occupied.';
    } else {
      if (['MAY_HAVE_DISPATCHED', 'UNKNOWN', 'RECOVERY_HOLD'].includes(publication.status)) this.transitionPublication(publication, 'DIVERGENCE', false);
      publication.recoveryReason = 'Canonical divergence: unexpected head. Publication halted; no rewind or automatic adoption.';
    }
    await this.record('publication.reconciliation-pending', publication.recoveryReason!, publication.id);
  }
  private async finalize(publication: Publication): Promise<void> {
    let receipt = this.state.receipts.find(r => r.publicationId === publication.id);
    if (!receipt) {
      const candidate = this.state.candidates.find(c => c.id === publication.candidateId)!;
      const witness = publication.admissionWitness as AdmissionInput;
      const logical: LogicalReceipt = { schemaVersion: 1, scope: this.scope(), operationId: publication.id, sequence: String(this.state.receipts.length + 1), enrollmentDigest: this.state.enrollmentDigest, predecessorReceiptDigest: this.state.receipts.at(-1)?.digest || null, oldHead: publication.oldHead, newHead: publication.newHead, candidateDigest: candidate.digest, manifestDigest: candidate.manifestDigest, proposalDigest: publication.proposalDigest, witnessDigest: digest(witness), evidenceDigests: witness.proposal.evidenceDigests, outcome: 'PUBLISHED', authorityRevision: String(this.state.revision), limitations: this.state.limitations };
      receipt = { id: id('receipt'), sequence: Number(logical.sequence), candidateId: candidate.id, publicationId: publication.id, digest: digest(logical), logical: logical as any, envelope: this.keys.attest('decision', 'publication', logical, this.issuance(logical.authorityRevision)), createdAt: now() };
      // Frozen logical outcome and selected signature are retained first. Restart
      // reads this exact object instead of issuing a different receipt identity.
      const receiptPath = join(this.directory, 'receipts', publication.id + '.json');
      if (existsSync(receiptPath)) receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
      else await this.durableWrite(receiptPath, receipt);
      this.state.receipts.push(receipt!); publication.receiptId = receipt!.id; await this.save();
    }
    if (publication.status === 'OBSERVED') this.transitionPublication(publication, 'RECEIPT_SAVED', true);
    await this.save(); const bundle = await this.exportReceipt(receipt!.id);
    const verified = verifyBundle(bundle, this.trustConfig()); if (!verified.valid) throw new Error('FINAL_RECEIPT_VERIFY_FAILED: ' + verified.errors.join(', '));
    await this.durableWrite(join(this.directory, 'bundles', receipt!.id + '.json'), bundle);
    await this.durableWrite(join(this.directory, 'checkpoint.json'), { schemaVersion: 1, scope: this.scope(), enrollmentDigest: this.state.enrollmentDigest, sequence: String(receipt!.sequence), receiptDigest: receipt!.digest });
    this.transitionPublication(publication, 'FINALIZE', true); this.state.acceptedHead = publication.newHead; this.state.demoStatus = 'PUBLISHED';
    await this.record('publication.confirmed', 'Remote raw commit and source match the approved candidate. Portable receipt passes the independent Rust verifier.', publication.id);
  }
  async exportReceipt(receiptId: string): Promise<VerificationBundle> {
    const receipt = this.state.receipts.find(r => r.id === receiptId); if (!receipt) throw new Error('RECEIPT_NOT_FOUND');
    const publication = this.state.publications.find(p => p.id === receipt.publicationId)!, candidate = this.state.candidates.find(c => c.id === receipt.candidateId)!;
    const prepared = JSON.parse(await readFile(join(this.directory, 'publications', publication.id + '.json'), 'utf8'));
    const witness = prepared.witness as AdmissionInput;
    const evidence = witness.evidence.map(e => this.state.evidence.find(x => x.id === e.id)!);
    const observations = await Promise.all(evidence.map(async e => { const observationDigest = (e as any).observationDigest; const bytes = await readFile(join(this.directory, 'objects', observationDigest.slice(7) + '.json')); if (hashBytes(bytes) !== observationDigest) throw new Error('RETAINED_OBSERVATION_CORRUPTED'); return { digest: observationDigest, dataBase64: bytes.toString('base64') }; }));
    return { schemaVersion: 1, enrollment: this.enrollment.envelope, admission: prepared.admission, publication: receipt.envelope as any, evidence: evidence.map(e => e.envelope as any), history: this.state.receipts.filter(r => r.sequence < receipt.sequence).map(r => r.envelope as any), inputs: { witness, manifest: protocolManifest(candidate.manifest), gitObjects: await this.gitObjects(candidate.commit), observations } } as VerificationBundle;
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    for (const [attemptId, child] of this.children) { const attempt = this.state.attempts.find(a => a.id === attemptId)!; const terminated = await this.stopAuthoring(child, attempt); attempt.terminationObserved = terminated; if (terminated && attempt.reservation) attempt.reservation.status = 'RELEASED'; }
    await this.waitForIdle();
    await this.save();
  }
}
