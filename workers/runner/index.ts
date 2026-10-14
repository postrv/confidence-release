// SPDX-License-Identifier: Apache-2.0
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Files } from "@cloudflare/sandbox";
import { timingSafeEqual } from "node:crypto";
import { canonicalize, digest, encodeBase64, getKernel } from "../../packages/protocol/src/index";
import type { Scope, SourceManifest } from "../../packages/protocol/src/types";
import type { AttemptRecord, ContextCapsuleInput } from "../authority/types";
import { initializeKernel } from "../authority/kernel";
import { ObjectStore, MAX_CONTROL_BYTES, MAX_FILE_BYTES, MAX_SOURCE_BYTES } from "../shared/objects";
import { digestBytes, errorResponse, PlatformError, readBounded, requireValue } from "../shared/errors";
import { validateRemote } from "../authority/artifacts";
import { modelDispatchTimeoutMs, modelRoute, normalizeModelRequest, workersAiBindingInput, workersAiFailureDiagnostic, workersAiModel, workersAiReasoningEffort, workersAiResponseIdentity } from "./model-policy";
import { authoringPrompt, promptSourceContext, sessionMetadata } from "./context";
import { selectSessionContext, validatePartialSessionCapture } from "../../packages/protocol/src/session-context";
import { runAuthoringDiagnostic } from "./diagnostics";
import { boundedServiceFetch } from "../shared/deadline";
import { validateSourceAdvisory, SOURCE_ADVISORY_BYTES, type SourceAdvisory } from "../../packages/protocol/src/source-advisory";
import { hydrateAuthoringSource } from "./hydration";
import { modelResponseLifetime, modelResponseStream, readModelResponse, untilModelAbort } from "./model-response-stream";

import { modelCallObservationKeys, validateModelCallFact, type ModelCallFact } from '../shared/model-call';

export interface RunnerEnv {
  ATTEMPTS: DurableObjectNamespace<AttemptRunner>; AUTHORITY: Fetcher; OBJECTS: R2Bucket;
  RUNNER_SERVICE_TOKEN: string; MODEL_API_KEY?: string; MODEL_API_BASE_URL: string; MODEL_NAME: string; MODEL_PROVIDER_KIND: string;
  MODEL_MAXIMUM_CALL_COST: string; MODEL_OUTPUT_TOKEN_FIELD: string; MODEL_REASONING_EFFORT: string; AI?: Ai;
  AUTHORING_IMAGE_DIGEST: string; MAINTENANCE_MODE: string;
  NARSIL_CONTEXT_MODE?: "off" | "auto" | "always"; INTERLINKED_PREVIEW_MODE?: "off" | "shadow" | "feedback";
}
interface Assignment { scope: Scope; attempt: AttemptRecord }
interface BrokerProps { scope: Scope; attemptId: string; generation: string; remote: string }
interface ExecutionState { generation: string; lifecycle: string; outcome: string; admissions: string; deadline: number; capacityHeld: boolean; pid?: number; logsDigest?: string; commit?: string; capsule?: ContextCapsuleInput }
const equalToken = (token: string | null, expected: string): boolean => { const a = new TextEncoder().encode(token ?? ""); const b = new TextEncoder().encode(`Bearer ${expected}`); return Boolean(expected) && a.length === b.length && timingSafeEqual(a, b); };
const jsonHeaders = (env: RunnerEnv) => ({ authorization: `Bearer ${env.RUNNER_SERVICE_TOKEN}`, "content-type": "application/json" });

/** Identity is attached by the controller, never read from candidate request headers. */
export class BrokerGateway extends WorkerEntrypoint<RunnerEnv, BrokerProps> {
  async fetch(request: Request): Promise<Response> {
    type BrokerStage = "admission" | "git-proxy" | "route" | "request-parse" | "reservation" | "request-retention" | "model-dispatch" | "response-read" | "response-retention" | "response-shaping";
    let stage: BrokerStage = "admission";
    let providerStatus: number | null = null;
    let callId: string | null = null;
    const startedAt = Date.now();
    const logFailure = (error: unknown, termination: string | null = null) => console.log(JSON.stringify({ type: "broker-failure", callId, stage, providerStatus, elapsedMs: Date.now() - startedAt, termination, ...workersAiFailureDiagnostic(error) }));
    const failureResponse = (error: unknown) => errorResponse(stage === "model-dispatch" && !(error instanceof PlatformError) ? new PlatformError("MODEL_PROVIDER_UNAVAILABLE", 502) : error);
    try {
      requireValue(this.env.MAINTENANCE_MODE !== "true", "BROKER_FENCED", 503);
      const props = this.ctx.props; const target = new URL(request.url); const remote = validateRemote(props.remote);
      const controller = this.env.ATTEMPTS.getByName(`${props.scope.projectIncarnation}/${props.attemptId}/${props.generation}`);
      requireValue(await controller.canAdmit(props.generation), "BROKER_GENERATION_FENCED", 403);
      if (target.hostname === remote.hostname) {
        stage = "git-proxy";
        const write = target.pathname.endsWith("/git-receive-pack") || target.searchParams.get("service") === "git-receive-pack";
        const headers = new Headers(jsonHeaders(this.env));
        headers.set("x-controller-scope", encodeBase64(new TextEncoder().encode(canonicalize(props.scope)))); headers.set("x-controller-attempt", props.attemptId); headers.set("x-controller-generation", props.generation);
        headers.set("x-controller-operation", write ? "git-write" : "git-read"); headers.set("x-controller-method", request.method);
        headers.set("content-type", request.headers.get("content-type") ?? "application/octet-stream"); headers.set("git-protocol", request.headers.get("git-protocol") ?? "version=1");
        return this.env.AUTHORITY.fetch(`https://authority.internal/internal/runner/git?target=${encodeURIComponent(request.url)}`, { method: "POST", headers, body: request.method === "POST" ? request.body : undefined });
      }
      stage = "route";
      requireValue(target.hostname === "model.internal" && target.protocol === "http:" && target.pathname === "/v1/chat/completions" && !target.search && request.method === "POST", "DESTINATION_DENIED", 403);
      const route = modelRoute(this.env);
      const reasoningEffort = route === "workers-ai" ? workersAiReasoningEffort(this.env.MODEL_NAME) : undefined;
      stage = "request-parse";
      requireValue(/^sha256:[0-9a-f]{64}$/.test(this.env.AUTHORING_IMAGE_DIGEST), "MODEL_NOT_CONFIGURED", 409);
      const raw = await readBounded(request.body, 192 * 1024); const parsed = JSON.parse(getKernel().canonical_json(new TextDecoder().decode(raw))) as Record<string, unknown>;
      const { request: submitted, requestedStream: stream } = normalizeModelRequest(parsed, this.env.MODEL_NAME, this.env.MODEL_OUTPUT_TOKEN_FIELD, reasoningEffort);
      callId = crypto.randomUUID(); const actual = canonicalize(submitted);
      stage = "reservation";
      const reservation = await this.env.AUTHORITY.fetch("https://authority.internal/internal/runner/model-reserve", { method: "POST", headers: jsonHeaders(this.env), body: canonicalize({ scope: props.scope, attemptId: props.attemptId, generation: props.generation, callId, requestDigest: await digest({ providerKind: route, request: submitted }), maximumCost: this.env.MODEL_MAXIMUM_CALL_COST }) });
      if (!reservation.ok) { await reservation.body?.cancel(); requireValue(false, "MODEL_RESERVATION_DENIED", 409); }
      const admission = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(reservation.body, 16384))) as { admitted?: boolean };
      requireValue(admission.admitted === true, "MODEL_RESERVATION_DENIED", 409);
      stage = "request-retention";
      const modelObjects = new ObjectStore(this.env.OBJECTS); const retainedRequestDigest = await modelObjects.put(new TextEncoder().encode(actual));
      const journalModel = async (phase: ModelCallFact['phase'], observation: string) => {
        const observationDigest = await digestBytes(new TextEncoder().encode(observation));
        await controller.recordModelCall({ schemaVersion: 1, scope: props.scope, attemptId: props.attemptId,
          generation: props.generation, callId: callId!, phase, observationDigest }, observation);
      };
      await journalModel("DISPATCH", canonicalize({ scope: props.scope, attemptId: props.attemptId, generation: props.generation, callId, requestDigest: retainedRequestDigest, providerKind: route, requestedModel: this.env.MODEL_NAME, reasoningEffort: reasoningEffort ?? null, producer: "broker-observed", state: "MAY_HAVE_DISPATCHED", maximumReservedCost: this.env.MODEL_MAXIMUM_CALL_COST }));
      const lifetime = modelResponseLifetime(request.signal, modelDispatchTimeoutMs(route));
      const produce = async (signal: AbortSignal): Promise<Uint8Array> => {
        signal.throwIfAborted();
        requireValue(await controller.canAdmit(props.generation), 'BROKER_GENERATION_FENCED', 403); signal.throwIfAborted();
        let response: Response;
        stage = "model-dispatch";
        console.log(JSON.stringify({ type: "broker-model-dispatch", callId, providerKind: route, elapsedMs: Date.now() - startedAt }));
        if (route === "workers-ai") {
          response = await this.env.AI!.run(workersAiModel(this.env.MODEL_NAME), workersAiBindingInput(submitted), { returnRawResponse: true, signal });
        } else {
          const upstream = new URL(`${this.env.MODEL_API_BASE_URL.replace(/\/$/, "")}/chat/completions`);
          requireValue(upstream.protocol === "https:" && !upstream.username && !upstream.password && !upstream.search && !upstream.hash, "MODEL_ROUTE_UNCONFIGURED", 503);
          response = await fetch(upstream, { method: "POST", redirect: "manual", headers: { authorization: `Bearer ${this.env.MODEL_API_KEY}`, "content-type": "application/json" }, body: actual, signal });
        }
        stage = "response-read";
        if (signal.aborted) { void response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
        if (!response.ok) { providerStatus = response.status; void response.body?.cancel().catch(() => {}); requireValue(false, "MODEL_PROVIDER_UNAVAILABLE", 502); }
        const body = await readModelResponse(response.body, signal);
        const observed = route === "workers-ai" ? workersAiResponseIdentity(body, this.env.MODEL_NAME) : null;
        signal.throwIfAborted();
        stage = "response-retention";
        const responseDigest = await modelObjects.put(body);
        signal.throwIfAborted();
        await journalModel("RESPONSE", canonicalize({ scope: props.scope, attemptId: props.attemptId, generation: props.generation, callId, requestDigest: retainedRequestDigest, responseDigest, providerKind: route, requestedModel: this.env.MODEL_NAME, reportedModel: observed?.reportedModel ?? null, responseId: observed?.responseId ?? null, usage: observed?.usage ?? null, producer: "broker-observed", outcome: "RESPONSE", maximumReservedCost: this.env.MODEL_MAXIMUM_CALL_COST }));
        signal.throwIfAborted();
        stage = "response-shaping";
        console.log(JSON.stringify({ type: "broker-response-retained", callId, providerKind: route, elapsedMs: Date.now() - startedAt }));
        return body;
      };
      if (stream) {
        const task = modelResponseStream({ lifetime, produce, onFailure: logFailure });
        this.ctx.waitUntil(task.completion);
        return task.response;
      }
      try { return new Response((await untilModelAbort(() => produce(lifetime.signal), lifetime.signal)).slice().buffer, { headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
      finally { lifetime.dispose(); }
    } catch (error) {
      logFailure(error);
      return failureResponse(error);
    }
  }
}

export class AttemptRunner extends DurableObject<RunnerEnv> {
  private readonly container: Container;
  private readonly files: Files;
  constructor(ctx: DurableObjectState, env: RunnerEnv) {
    super(ctx, env); this.container = this.executionContainer(); this.files = new Files(this.container);
    ctx.blockConcurrencyWhile(async () => {
      await initializeKernel(); this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),assignment TEXT NOT NULL,execution TEXT NOT NULL); CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'PENDING');");
      const columns = this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(outbox)').toArray();
      if (!columns.some(column => column.name === 'kind')) this.ctx.storage.sql.exec("ALTER TABLE outbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'RUNTIME'");
      if (!columns.some(column => column.name === 'object_payload')) this.ctx.storage.sql.exec('ALTER TABLE outbox ADD COLUMN object_payload TEXT');
      if (this.container.running) await this.container.setInactivityTimeout(120000);
      if (this.ctx.storage.sql.exec("SELECT id FROM outbox WHERE state='PENDING' LIMIT 1").toArray().length) await this.ctx.storage.setAlarm(Date.now() + 100);
      const state = this.state(); if (state && state.lifecycle !== "RESERVED" && state.lifecycle !== "STOPPED") {
        this.ctx.storage.transactionSync(() => { state.lifecycle = "UNKNOWN"; state.admissions = "FENCED"; this.save(state); this.enqueueObservation(state); });
        await this.ctx.storage.setAlarm(Date.now() + 100);
      }
    });
  }
  /** Narrow native-effect seam for owned lifecycle conformance; production uses ctx.container. */
  protected executionContainer(): Container { requireValue(this.ctx.container, "CONTAINER_UNCONFIGURED", 503); return this.ctx.container; }
  /** Retains the real alarm operation while allowing owned scheduling barriers. */
  protected async armExecutionDeadline(deadline: number): Promise<void> { await this.ctx.storage.setAlarm(deadline); }
  private state(): ExecutionState | null { const row = this.ctx.storage.sql.exec<{ execution: string }>("SELECT execution FROM state WHERE id=1").toArray()[0]; return row ? JSON.parse(row.execution) as ExecutionState : null; }
  private assignment(): Assignment { const row = this.ctx.storage.sql.exec<{ assignment: string }>("SELECT assignment FROM state WHERE id=1").one(); return JSON.parse(row.assignment) as Assignment; }
  private save(state: ExecutionState): void { this.ctx.storage.sql.exec("UPDATE state SET execution=? WHERE id=1", canonicalize(state)); }
  async canAdmit(generation: string): Promise<boolean> {
    const state = this.state(); return this.env.MAINTENANCE_MODE !== "true" && state?.generation === generation && state.admissions === "OPEN" && ["START_MAY_HAVE_DISPATCHED", "RUNNING"].includes(state.lifecycle);
  }
  private transition(event: string, verified = false): ExecutionState {
    const state = this.state()!; const result = JSON.parse(getKernel().transition_execution(canonicalize({ generation: state.generation, eventGeneration: state.generation, lifecycle: state.lifecycle, outcome: state.outcome, admissions: state.admissions, event, verified }))) as ExecutionState & { accepted: boolean; reason: string };
    requireValue(result.accepted, result.reason, 409); const next = { ...state, lifecycle: result.lifecycle, outcome: result.outcome, admissions: result.admissions, capacityHeld: result.capacityHeld }; this.save(next); return next;
  }
  private enqueueObservation(state: ExecutionState): void {
    const assignment = this.assignment(); const eventId = crypto.randomUUID();
    const payload = { scope: assignment.scope, attemptId: assignment.attempt.id, generation: state.generation, lifecycle: state.lifecycle, outcome: state.outcome, verified: true, eventId, ...(state.logsDigest ? { logsDigest: state.logsDigest } : {}), ...(state.commit ? { sourceCommit: state.commit } : {}), ...(state.capsule ? { capsule: state.capsule } : {}) };
    this.ctx.storage.sql.exec("INSERT INTO outbox(id,payload) VALUES(?,?)", eventId, canonicalize(payload));
  }
  /** Controller identity is fixed by its provisioned assignment; accounting can finish after a stop. */
  async recordModelCall(fact: ModelCallFact, observation: string): Promise<{ state: 'MODEL_CALL_FACT_QUEUED' }> {
    validateModelCallFact(fact);
    requireValue(typeof observation === 'string' && new TextEncoder().encode(observation).length <= 16384, 'MODEL_CALL_OBSERVATION_INVALID', 400);
    const value = JSON.parse(getKernel().canonical_json(observation)) as Record<string, unknown>;
    requireValue(value && typeof value === 'object' && !Array.isArray(value) && canonicalize(value) === observation
      && Object.keys(value).sort().join(',') === modelCallObservationKeys(fact.phase).join(',')
      && await digestBytes(new TextEncoder().encode(observation)) === fact.observationDigest, 'MODEL_CALL_OBSERVATION_INVALID', 400);
    const assignment = this.assignment();
    requireValue(canonicalize(assignment.scope) === canonicalize(fact.scope) && assignment.attempt.id === fact.attemptId
      && assignment.attempt.generation === fact.generation && this.state()?.generation === fact.generation
      && value.callId === fact.callId && value.attemptId === fact.attemptId && value.generation === fact.generation
      && canonicalize(value.scope) === canonicalize(fact.scope), 'MODEL_CALL_CONTROLLER_MISMATCH', 409);
    const id = `model/${fact.callId}/${fact.phase}`, payload = canonicalize(fact);
    const prior = this.ctx.storage.sql.exec<{ payload: string; kind: string; object_payload: string }>('SELECT payload,kind,object_payload FROM outbox WHERE id=?', id).toArray()[0];
    if (prior) requireValue(prior.kind === 'MODEL' && prior.payload === payload && prior.object_payload === observation, 'MODEL_CALL_FACT_CONFLICT', 409);
    else {
      requireValue(this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM outbox WHERE kind='MODEL'").one().count < 8, 'MODEL_CALL_FACT_LIMIT', 409);
      this.ctx.storage.sql.exec("INSERT INTO outbox(id,payload,kind,object_payload) VALUES(?,?,'MODEL',?)", id, payload, observation);
    }
    await this.ctx.storage.setAlarm(Date.now() + 100);
    return { state: 'MODEL_CALL_FACT_QUEUED' };
  }
  private async flushObservations(): Promise<void> {
    const deadline = Date.now() + 2000;
    for (const row of this.ctx.storage.sql.exec<{ id: string; payload: string; kind: string; object_payload: string | null }>("SELECT id,payload,kind,object_payload FROM outbox WHERE state='PENDING' ORDER BY (kind='MODEL'),rowid LIMIT 8").toArray()) {
      const remaining = deadline - Date.now(); requireValue(remaining > 0, "RUNTIME_OBSERVATION_DEADLINE", 503);
      // Runtime stop/fence callbacks are always delivered before accounting.
      // A missing/corrupt model observation cannot strand confirmed lifecycle capacity.
      if (row.kind === 'MODEL') {
        const fact = JSON.parse(row.payload) as ModelCallFact; validateModelCallFact(fact);
        requireValue(row.object_payload !== null, 'MODEL_CALL_OBSERVATION_MISSING', 503);
        await new ObjectStore(this.env.OBJECTS, Math.min(5000, remaining)).put(new TextEncoder().encode(row.object_payload), fact.observationDigest);
      }
      const budget = deadline - Date.now(); requireValue(budget > 0, 'RUNTIME_OBSERVATION_DEADLINE', 503);
      const response = await boundedServiceFetch(this.env.AUTHORITY, row.kind === 'MODEL' ? 'https://authority.internal/internal/runner/model-call-fact' : 'https://authority.internal/internal/runner/observation', { method: 'POST', headers: jsonHeaders(this.env), body: row.payload }, budget);
      requireValue(response.ok, "RUNTIME_OBSERVATION_UNACKNOWLEDGED", 503);
      this.ctx.storage.sql.exec("UPDATE outbox SET state='DELIVERED' WHERE id=?", row.id);
    }
  }
  async provision(assignment: Assignment): Promise<unknown> {
    const prior = this.state(); if (prior) { requireValue(canonicalize(this.assignment()) === canonicalize(assignment), "GENERATION_ASSIGNMENT_CONFLICT", 409); return { state: prior.lifecycle }; }
    requireValue(assignment.attempt.source?.commit === assignment.attempt.workBase && assignment.attempt.remote, "VERIFIED_WORK_BASE_REQUIRED");
    const state: ExecutionState = { generation: assignment.attempt.generation, lifecycle: "RESERVED", outcome: "PENDING", admissions: "OPEN", deadline: 0, capacityHeld: true };
    this.ctx.storage.sql.exec("INSERT INTO state(id,assignment,execution) VALUES(1,?,?)", canonicalize(assignment), canonicalize(state)); return { state: "RESERVED" };
  }
  async start(): Promise<unknown> {
    const state = this.state(); requireValue(state, "ASSIGNMENT_UNAVAILABLE", 404); if (state.lifecycle !== "RESERVED") return { state: state.lifecycle };
    requireValue(this.env.MAINTENANCE_MODE !== "true", "EXECUTION_NOT_CONFIGURED", 409);
    modelRoute(this.env);
    const image = this.container.images.agent; requireValue(image?.endsWith(`@${this.env.AUTHORING_IMAGE_DIGEST}`), "AUTHORING_IMAGE_UNVERIFIED", 409);
    const assignment = this.assignment(); const props: BrokerProps = { scope: assignment.scope, attemptId: assignment.attempt.id, generation: assignment.attempt.generation, remote: assignment.attempt.remote! };
    const current = (lifecycle: string): ExecutionState => {
      const retained = this.state();
      requireValue(retained?.generation === state.generation && retained.lifecycle === lifecycle && retained.admissions === "OPEN" && retained.capacityHeld && (lifecycle === "RESERVED" || retained.deadline > Date.now()), "AUTHORING_GENERATION_FENCED", 409);
      return retained;
    };
    // The runner is a separate Worker entrypoint; the authority-generated globals
    // are shared by this repository-wide typecheck. Native factories are registered
    // by this Worker export and checked by the runner packaging/runtime gate.
    const factories = this.ctx.exports as unknown as { BrokerGateway: (options: { props: BrokerProps }) => Fetcher };
    const gateway = factories.BrokerGateway({ props });
    await this.container.interceptOutboundHttps(validateRemote(props.remote).hostname, gateway); current("RESERVED");
    await this.container.interceptOutboundHttp("model.internal", gateway); current("RESERVED");
    this.transition("DISPATCH_START"); const running = this.state()!; running.deadline = Date.now() + 600000; this.save(running); await this.armExecutionDeadline(running.deadline);
    // The alarm write yields. A concurrent stop or deadline must not be undone
    // by this continuation, and no await may separate this check from start.
    current("START_MAY_HAVE_DISPATCHED");
    // Give the pinned authoring CLI CPU headroom within its fixed preview deadline.
    this.container.start({ image, enableInternet: false, instance: { vcpu: 1, memoryMib: 3072, diskMb: 2000 } }); await this.container.setInactivityTimeout(120000);
    current("START_MAY_HAVE_DISPATCHED");
    this.ctx.waitUntil(this.execute(assignment).catch(async () => { if (this.state()?.lifecycle === "STOPPED") return; this.transition("RESPONSE_LOST"); await this.stop("execution-start-or-result-unknown"); }));
    return { state: "START_MAY_HAVE_DISPATCHED" };
  }
  private async capture(process: ExecProcess, maximumOutputBytes = 65536): Promise<{ stdout: Uint8Array; stderr: Uint8Array; exitCode: number; truncated: boolean }> {
    let truncated = false;
    const drain = async (stream: ReadableStream | null): Promise<Uint8Array> => {
      if (!stream) return new Uint8Array(); const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; const chunk = new Uint8Array(value); const remaining = Math.max(0, maximumOutputBytes - size); if (chunk.length > remaining) truncated = true; if (remaining) { const kept = chunk.subarray(0, remaining); chunks.push(kept); size += kept.length; } } } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
    };
    const [stdout, stderr, exitCode] = await Promise.all([drain(process.stdout), drain(process.stderr), process.exitCode]); return { stdout, stderr, exitCode, truncated };
  }
  private async command(argv: string[], cwd = "/workspace", maximumOutputBytes = 65536): Promise<Uint8Array> { const process = await this.container.exec(argv, { cwd, env: { GIT_SSL_CAINFO: "/etc/cloudflare/certs/cloudflare-containers-ca.crt", NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt" } }); const output = await this.capture(process, maximumOutputBytes); requireValue(output.exitCode === 0 && !output.truncated, "AUTHORING_COMMAND_FAILED", 409); return output.stdout; }
  private async execute(assignment: Assignment): Promise<void> {
    const attempt = assignment.attempt; const source = attempt.source!; const objects = new ObjectStore(this.env.OBJECTS);
    // New configurations pin explicit modes; absent legacy bindings stay off.
    const narsilMode = this.env.NARSIL_CONTEXT_MODE ?? "off", previewMode = this.env.INTERLINKED_PREVIEW_MODE ?? "off";
    requireValue(["off", "auto", "always"].includes(narsilMode) && ["off", "shadow", "feedback"].includes(previewMode), "AUTHORING_INTEGRATION_MODE_INVALID", 409);
    await this.command(["git", "clone", "--no-checkout", "--depth", "1", "--branch", "confidence-work", attempt.remote!, "/workspace"], "/");
    const actual = new TextDecoder().decode(await this.command(["git", "rev-parse", "HEAD"])).trim(); requireValue(actual === attempt.workBase, "WORK_BASE_MOVED", 409);
    await this.command(["git", "read-tree", attempt.workBase]);
    const filesBase64 = await hydrateAuthoringSource(source.manifest, objects, this.files, async (mode, paths) => {
      await this.command(["chmod", mode, "--", ...paths]);
    }, narsilMode !== "off");
    const allowedPaths = attempt.allowedPaths ?? []; requireValue(allowedPaths.length > 0, "ASSIGNMENT_PATHS_REQUIRED");
    const { editableSource: sourceContext, readOnlySource } = await promptSourceContext(attempt, source.manifest, (digest, maximumBytes) => objects.get(digest, maximumBytes));
    let sourceAdvisory: SourceAdvisory | null = null, sourceAdvisoryDigest: string | null = null;
    if (narsilMode !== "off") {
      const request = canonicalize({ sourceCommit: source.commit, sourceManifestDigest: source.manifestDigest, manifest: source.manifest, filesBase64, assignedPaths: allowedPaths,
        config: { enabled: true, includeSmallProjects: narsilMode === "always", binaryPath: "/opt/narsil/narsil-mcp", expectedVersion: "1.7.2" } });
      const process = await this.container.exec(["node", "/opt/confidence/narsil-context.mjs"], { cwd: "/opt/confidence", stdin: new Blob([request]).stream() });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const output = await Promise.race([this.capture(process, SOURCE_ADVISORY_BYTES + 1), new Promise<never>((_, reject) => { timer = setTimeout(() => { void Promise.resolve().then(() => process.kill(9)).catch(() => {}); reject(new Error("SOURCE_ADVISORY_DEADLINE")); }, 20000); })]);
        requireValue(output.exitCode === 0 && !output.truncated, "SOURCE_ADVISORY_COMMAND_FAILED", 409);
        sourceAdvisory = await validateSourceAdvisory(JSON.parse(getKernel().canonical_json(new TextDecoder("utf-8", { fatal: true }).decode(output.stdout))), {
          sourceCommit: source.commit, sourceManifestDigest: source.manifestDigest, manifest: source.manifest, assignedPaths: allowedPaths, readFile: contentDigest => objects.get(contentDigest, MAX_FILE_BYTES),
        });
        requireValue(sourceAdvisory.reason !== "TERMINATION_UNCONFIRMED", "NARSIL_TERMINATION_UNCONFIRMED", 409);
        sourceAdvisoryDigest = await objects.put(new TextEncoder().encode(canonicalize(sourceAdvisory)));
      } catch (error) { await this.stop("source-advisory-unconfirmed"); throw error; }
      finally { if (timer) clearTimeout(timer); }
      requireValue(await this.canAdmit(attempt.generation), "AUTHORING_GENERATION_FENCED", 409);
    }
    const checkpoint = async (committed = false) => {
      const entries = committed ? new TextDecoder("utf-8", { fatal: true }).decode(await this.command(["git", "ls-tree", "-r", "--full-tree", "-z", "HEAD"], "/workspace", MAX_CONTROL_BYTES)).split("\0").filter(Boolean).map(row => {
        const tab = row.indexOf("\t"); const [mode, type, oid] = row.slice(0, tab).split(" "); requireValue(tab > 0 && type === "blob" && /^[a-f0-9]{40}$/.test(oid) && ["100644", "100755"].includes(mode), "SOURCE_CHECKPOINT_PROFILE", 409); return { path: row.slice(tab + 1), mode };
      }) : source.manifest.entries.map(entry => ({ path: entry.path, mode: entry.mode }));
      requireValue(entries.length <= 2048, "SOURCE_CHECKPOINT_LIMIT", 413);
      const inventory: SourceManifest["entries"] = []; let total = 0;
      for (const entry of entries) {
        const response = await this.files.readFile(`/workspace/${entry.path}`); const data = await readBounded(response.body, MAX_FILE_BYTES); total += data.length; requireValue(total <= MAX_SOURCE_BYTES, "SOURCE_CHECKPOINT_LIMIT", 413);
        const actualMode = new TextDecoder().decode(await this.command(["stat", "-c", "%a", "--", entry.path])).trim(); requireValue(["644", "755"].includes(actualMode), "SOURCE_CHECKPOINT_PROFILE", 409);
        inventory.push({ path: entry.path, mode: actualMode === "755" ? "100755" : "100644", bytes: String(data.length), digest: await objects.put(data) });
      }
      inventory.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const manifest: SourceManifest = { schemaVersion: 1, pathProfile: "portable-ascii-v1", entries: inventory }; const check = JSON.parse(getKernel().validate_manifest(canonicalize(manifest))) as { valid: boolean; reason: string }; requireValue(check.valid, check.reason, 409);
      const manifestDigest = await objects.put(new TextEncoder().encode(canonicalize(manifest)));
      const commit = new TextDecoder().decode(await this.command(["git", "rev-parse", "HEAD"])).trim(); return { commit, inventoryDigest: manifestDigest };
    };
    const diagnostic = await runAuthoringDiagnostic({ generation: attempt.generation, allowedPaths, checkpoint, execute: async command => {
      const process = await this.container.exec(command.argv, { cwd: command.cwd });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { const result = await Promise.race([this.capture(process, command.maximumOutputBytes), new Promise<never>((_, reject) => { timer = setTimeout(() => { process.kill(9); reject(new Error("DIAGNOSTIC_DEADLINE")); }, command.timeoutMs); })]); if (!result.truncated) await objects.put(result.stdout); return result; }
      catch (error) { await this.stop("diagnostic-unconfirmed"); throw error; }
      finally { if (timer) clearTimeout(timer); }
    } });
    requireValue(await this.canAdmit(attempt.generation), "AUTHORING_GENERATION_FENCED", 409);
    const diagnosticDigest = await objects.put(new TextEncoder().encode(canonicalize(diagnostic)));
    const retainedConversation = attempt.contextReference ? selectSessionContext(await objects.get(attempt.contextReference.sessionDigest, MAX_CONTROL_BYTES), attempt.contextReference.sessionEntry) : null;
    if (retainedConversation) requireValue(retainedConversation.sessionId === attempt.contextReference!.sessionId, "CONTINUATION_SESSION_MISMATCH", 409);
    const prompt = authoringPrompt(attempt, source.manifestDigest, sourceContext, diagnostic, retainedConversation, sourceAdvisory, readOnlySource);
    const renderedContextDigest = await objects.put(new TextEncoder().encode(prompt));
    const rendered: ContextCapsuleInput = { id: `${attempt.id}/${attempt.generation}/rendered`, stage: "rendered", renderedContextDigest, diagnosticDigest, ...(sourceAdvisoryDigest ? { sourceAdvisoryDigest } : {}), sourceCommit: source.commit, sourceManifestDigest: source.manifestDigest, sessionDigest: null, sessionFormat: null, sessionId: null, selectedEntry: null, missingSessionTail: true, sessionReadError: null };
    await this.files.mkdir("/agent", { recursive: true }); await this.files.writeFile("/agent/config.json", canonicalize({ agentDir: "/agent", generation: attempt.generation, brokerUrl: "http://model.internal/v1", brokerToken: "intercepted-no-provider-credential", model: this.env.MODEL_NAME, allowedPaths, prompt,
      ...(previewMode !== "off" ? { interlinked: { mode: previewMode, cliPath: "/opt/interlinked/dist/index.js" } } : {}) }));
    const process = await this.container.exec(["node", "/opt/confidence/pi-child.mjs", "/agent/config.json"], { cwd: "/workspace", env: { NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt" } });
    let state!: ExecutionState;
    this.ctx.storage.transactionSync(() => { state = this.transition("START_OBSERVED", true); state.pid = process.pid; state.capsule = rendered; this.save(state); this.enqueueObservation(state); });
    await this.ctx.storage.setAlarm(Date.now() + 100);
    const output = await this.capture(process); const logsDigest = await objects.put(new TextEncoder().encode(canonicalize({ stdout: encodeBase64(output.stdout), stderr: encodeBase64(output.stderr), exitCode: output.exitCode, truncated: output.truncated, trustClass: "agent-reported" })));
    // Capturing output yields while deadline/revocation stop can complete. Never
    // write the pre-await RUNNING snapshot over a terminal generation.
    state = this.state()!; requireValue(state.lifecycle === "RUNNING" && state.admissions === "OPEN", "AUTHORING_GENERATION_FENCED", 409); state.logsDigest = logsDigest;
    let session: ContextCapsuleInput = { ...rendered, id: `${attempt.id}/${attempt.generation}/session`, stage: "session", sessionReadError: "SESSION_READ_UNAVAILABLE" };
    try {
      const response = await this.files.readFile("/agent/session.json"); const raw = await readBounded(response.body, MAX_CONTROL_BYTES); const metadata = sessionMetadata(raw); const sessionDigest = await objects.put(raw);
      const result = JSON.parse(getKernel().canonical_json(new TextDecoder("utf-8", { fatal: true }).decode(output.stdout))) as { session?: { digest?: string } };
      requireValue(result.session?.digest === sessionDigest, "SESSION_STDOUT_BINDING_MISMATCH", 409);
      session = { ...session, sessionDigest, sessionFormat: metadata.format, sessionId: metadata.sessionId, selectedEntry: metadata.selectedEntry, missingSessionTail: false, sessionReadError: null };
    } catch {
      // A failed proposal can still retain diagnostics; incomplete captures are never resumable.
      try {
        const response = await this.files.readFile("/agent/partial-session.json"), raw = await readBounded(response.body, MAX_CONTROL_BYTES);
        validatePartialSessionCapture(raw); session.partialSessionDigest = await objects.put(raw);
      } catch { /* An unavailable or malformed session remains an explicit missing tail. */ }
    }
    // A failed run retains its named immutable work base, rather than claiming its dirty filesystem is that Git tree.
    session.sourceCommit = source.commit; session.sourceManifestDigest = source.manifestDigest;
    state = this.state()!; requireValue(state.lifecycle === "RUNNING" && state.admissions === "OPEN", "AUTHORING_GENERATION_FENCED", 409); state.logsDigest = logsDigest; state.capsule = session; this.save(state);
    requireValue(output.exitCode === 0 && !output.truncated, "AGENT_DID_NOT_COMPLETE", 409);
    await this.command(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false", "add", "--", ...allowedPaths]);
    await this.command(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Confidence attempt", "-c", "user.email=attempt@confidence.invalid", "commit", "--allow-empty", "-m", `Attempt ${attempt.id}`]);
    const commit = new TextDecoder().decode(await this.command(["git", "rev-parse", "HEAD"])).trim(); await this.command(["git", "push", "origin", "HEAD:refs/heads/confidence-work"]);
    const committedSource = await checkpoint(true); requireValue(committedSource.commit === commit, "SOURCE_CHECKPOINT_MOVED", 409);
    const completed = this.transition("COMPLETION_OBSERVED", true); completed.commit = commit; completed.capsule = { ...session, sourceCommit: commit, sourceManifestDigest: committedSource.inventoryDigest }; completed.logsDigest = state.logsDigest; this.save(completed); await this.stop("completed");
  }
  async stop(reason = "cancelled"): Promise<unknown> {
    const state = this.state(); requireValue(state, "ASSIGNMENT_UNAVAILABLE", 404); if (state.lifecycle === "STOPPED") return { state: "STOPPED" };
    this.ctx.storage.transactionSync(() => { const requested = this.transition(reason === "deadline" ? "DEADLINE" : "CANCEL"); this.enqueueObservation(requested); });
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    // The local controller denies new broker calls immediately. Retain and try
    // the authority fence before destruction; an unavailable callback cannot
    // prevent whole-generation shutdown or release unobserved capacity.
    try { await this.flushObservations(); } catch { console.log(JSON.stringify({ type: "runner-observation-pending", generation: state.generation, phase: "shutdown" })); }
    await this.container.destroy(reason); requireValue(await this.container.inspect() === null, "TERMINATION_UNCONFIRMED", 503);
    let stopped!: ExecutionState;
    this.ctx.storage.transactionSync(() => {
      stopped = this.state()!; if (stopped.lifecycle === "STOPPED") return;
      stopped = this.transition("STOP_CONFIRMED", true); this.enqueueObservation(stopped);
    });
    await this.ctx.storage.setAlarm(Date.now() + 100); return { state: "STOPPED", sourceCommit: stopped.commit ?? null };
  }
  async alarm(): Promise<void> {
    if (this.ctx.storage.sql.exec("SELECT id FROM outbox WHERE state='PENDING' LIMIT 1").toArray().length) await this.ctx.storage.setAlarm(Date.now() + 100);
      const state = this.state(); if (state && state.lifecycle !== "RESERVED" && state.lifecycle !== "STOPPED" && (state.lifecycle === "UNKNOWN" || state.lifecycle === "STOP_REQUESTED" || state.deadline <= Date.now())) await this.stop(state.lifecycle === "UNKNOWN" ? "restart-unknown" : state.lifecycle === "STOP_REQUESTED" ? "stop-reconciliation" : "deadline");
    try { await this.flushObservations(); } catch { /* Alarm retains the same immutable callback identities. */ }
    if (this.ctx.storage.sql.exec("SELECT id FROM outbox WHERE state='PENDING' LIMIT 1").toArray().length) await this.ctx.storage.setAlarm(Date.now() + 5000);
    else { const current = this.state(); if (current && current.lifecycle !== "RESERVED" && current.lifecycle !== "STOPPED") await this.ctx.storage.setAlarm(Math.max(Date.now() + 100, current.deadline)); }
  }
}

export default {
  async fetch(request: Request, env: RunnerEnv): Promise<Response> {
    try {
      requireValue(equalToken(request.headers.get("authorization"), env.RUNNER_SERVICE_TOKEN), "AUTHENTICATION_FAILED", 401); await initializeKernel();
      const body = JSON.parse(getKernel().canonical_json(new TextDecoder().decode(await readBounded(request.body, MAX_CONTROL_BYTES)))) as Assignment & { attemptId: string; generation?: string };
      const id = body.attempt?.id ?? body.attemptId; const generation = body.attempt?.generation ?? body.generation ?? "1";
      const stub = env.ATTEMPTS.getByName(`${body.scope.projectIncarnation}/${id}/${generation}`);
      const path = new URL(request.url).pathname;
      if (path === "/internal/provision") return Response.json(await stub.provision(body), { status: 202 });
      if (path === "/internal/start") return Response.json(await stub.start(), { status: 202 });
      if (path === "/internal/stop") return Response.json(await stub.stop(), { status: 202 });
      return new Response("Not found", { status: 404 });
    } catch (error) { return errorResponse(error); }
  },
} satisfies ExportedHandler<RunnerEnv>;
