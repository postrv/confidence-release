// SPDX-License-Identifier: Apache-2.0
import { FULL_RELEASE_JOB_COUNT } from "../evaluator/recipes";
import { authenticate, guardMutation, type AuthConfig } from "../shared/auth";
import { errorResponse, PlatformError, readBounded, requireValue } from "../shared/errors";
import { MAX_CONTROL_BYTES } from "../shared/objects";
import { canonicalize, getKernel, verifyBundle } from "../../packages/protocol/src/index";
import { initializeKernel } from "../authority/kernel";
import { uiSnapshot } from "./adapter";
import { issueViewToken, priorViewCursor } from "./view-token";
import type { AuthorityRead } from "../authority/types";
import type { ViewCursor } from "../shared/view-cursor";
import { authorityResponse } from "./transport";
import { COLLABORATION_OPERATIONS, type CollaborationSession } from "../../packages/protocol/src/collaboration";
import { projectApiScope, projectManagementRoute } from "./projects";
import { isWeftReplicaRequest } from "./replica-auth";
import { agentHubRoute, humanHubRoute } from "./hub-routes";
import { modelCallPageQuery } from "./model-calls";

export interface ApplicationEnv extends AuthConfig {
  PROJECT_HUB_ENABLED?: string;
  COLLABORATION_ONLY?: string;
  AUTHORITY: Fetcher;
  ASSETS: Fetcher;
  APP_SERVICE_TOKEN: string;
  DEFAULT_PROJECT_ID: string;
  PI_ENABLED: string;
  CONDITIONAL_PUBLICATION_VERIFIED: string;
  MAINTENANCE_MODE: string;
  BOOTSTRAP_IDENTITY_ENABLED: string;
}

async function controlBody(request: Request, maximum: number): Promise<Record<string, unknown>> {
  const input = await readBounded(request.body, maximum);
  let value: unknown;
  try { value = JSON.parse(getKernel().canonical_json(new TextDecoder("utf-8", { fatal: true }).decode(input))); }
  catch { throw new PlatformError("INVALID_CONTROL_JSON", 400); }
  requireValue(value && typeof value === "object" && !Array.isArray(value), "CONTROL_OBJECT_REQUIRED");
  return value as Record<string, unknown>;
}

function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store"); headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Weft's local Client expects a flat error envelope. */
async function weftResponse(response: Response): Promise<Response> {
  if (response.ok) return privateResponse(response);
  const bytes = await readBounded(response.body, 16 * 1024);
  let code = "CONFIDENCE_REQUEST_FAILED";
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    const candidate = typeof body.error === "string" ? body.error : body.error?.code;
    if (typeof candidate === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(candidate)) code = candidate;
  } catch { /* Do not expose a backend error body to the local replica. */ }
  return privateResponse(Response.json({ error: code, message: code }, { status: response.status }));
}

/** Public application contains no Artifacts namespace, signing key or candidate execution binding. */
export default {
  async fetch(request: Request, env: ApplicationEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/v1/") && !url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
      const agentHub = await agentHubRoute(request, env);
      if (agentHub) return privateResponse(agentHub);
      if (url.pathname === "/api/session") {
        const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
        requireValue(url.origin === env.APP_ORIGIN && !url.search && (origin === null || origin === env.APP_ORIGIN)
          && (site === null || site === "same-origin" || site === "none"), "SESSION_IDENTITY_UNAVAILABLE", 404);
        requireValue(request.method === "GET", "METHOD_NOT_ALLOWED", 405);
        const bearer = request.headers.get("authorization");
        requireValue(bearer === null || bearer.startsWith("Bearer ") && !request.headers.has("cf-access-jwt-assertion"), "SESSION_CREDENTIALS_AMBIGUOUS", 401);
        const identity = await authenticate(request, env, { accessApplicationOnly: bearer === null });
        requireValue(identity.credentialClass === "human", "HUMAN_REQUIRED", 403);
        // Identity discovery grants no project membership and never reads authority state.
        const session: CollaborationSession = { principalId: identity.id, tenantId: identity.tenantId,
          credentialClass: identity.credentialClass, authentication: identity.authentication };
        return privateResponse(Response.json({ ...session, projectDiscussion: env.PROJECT_HUB_ENABLED === 'true',
          ...(env.COLLABORATION_ONLY === 'true' ? { deploymentProfile: 'collaboration-only' } : {}) }));
      }
      if (url.pathname === "/api/bootstrap-identity") {
        requireValue(env.MAINTENANCE_MODE === "true" && env.BOOTSTRAP_IDENTITY_ENABLED === "true"
          && url.origin === env.APP_ORIGIN && !url.search, "BOOTSTRAP_IDENTITY_UNAVAILABLE", 404);
        requireValue(request.method === "GET" && !request.headers.has("authorization")
          && request.headers.has("cf-access-jwt-assertion"), "BOOTSTRAP_ACCESS_ASSERTION_REQUIRED", 401);
        const bootstrapPrincipal = await authenticate(request, env, { accessApplicationOnly: true });
        requireValue(bootstrapPrincipal.credentialClass === "human", "BOOTSTRAP_HUMAN_REQUIRED", 403);
        return Response.json({ bootstrapSubject: bootstrapPrincipal.id }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      }
      const replicaRequest = isWeftReplicaRequest(request, env.APP_ORIGIN);
      const principal = await authenticate(request, env, { replicaOnly: replicaRequest }); await initializeKernel();
      const expectedPrincipal = request.headers.get("if-platform-principal");
      requireValue(expectedPrincipal === null || expectedPrincipal === principal.id, "SESSION_PRINCIPAL_CHANGED", 409);
      const expectedIncarnation = request.headers.get("if-platform-incarnation");
      requireValue(expectedIncarnation === null || /^[a-zA-Z0-9_-]{1,128}$/.test(expectedIncarnation), "INVALID_EXPECTED_INCARNATION");
      const humanHub = await humanHubRoute(request, env, principal);
      if (humanHub) return privateResponse(humanHub);
      const managed = await projectManagementRoute(request, env, principal);
      if (managed) return managed;
      if (url.pathname.startsWith("/api/")) {
        const scoped = projectApiScope(url.pathname, env.DEFAULT_PROJECT_ID);
        const apiPath = scoped.pathname;
        const caller = { principal, projectId: scoped.projectId };
        const forward = (path: string, body: unknown, timeoutMs = 10_000) => authorityResponse(env.AUTHORITY, `https://authority.internal${path}`, { method: "POST", headers: { authorization: `Bearer ${env.APP_SERVICE_TOKEN}`, "content-type": "application/json" }, body: canonicalize({ caller, ...body as Record<string, unknown> }) }, timeoutMs);
        if (apiPath === "/api/weft" || apiPath.startsWith("/api/weft/")) {
          requireValue(!url.search && url.origin === new URL(env.APP_ORIGIN).origin, "UNSUPPORTED_ROUTE", 404);
          if (apiPath === "/api/weft") {
            requireValue(request.method === "GET", "METHOD_NOT_ALLOWED", 405);
            return privateResponse(await forward("/internal/weft-workspace", {}));
          }
          const handoff = /^\/api\/weft\/handoffs\/([A-Za-z0-9_-]{1,128})$/.exec(apiPath);
          if (handoff) {
            requireValue(request.method === "GET", "METHOD_NOT_ALLOWED", 405);
            return privateResponse(await forward("/internal/weft-handoff", { requestId: handoff[1] }));
          }
          // Weft's Client appends this suffix to its configured Confidence
          // project URL. The workspace remains checked against server config.
          const proxy = /^\/api\/weft\/api\/workspaces\/([A-Za-z0-9_-]{1,128})\/(.+)$/.exec(apiPath);
          requireValue(proxy && ["GET", "POST"].includes(request.method), "UNSUPPORTED_ROUTE", 404);
          requireValue(env.AUTH_REPLICA_AUDIENCE === undefined || replicaRequest, "UNSUPPORTED_ROUTE", 404);
          let body: Record<string, unknown> | undefined;
          if (request.method === "POST") { guardMutation(request, principal, env); body = await controlBody(request, MAX_CONTROL_BYTES); }
          return weftResponse(await forward("/internal/weft-proxy", { proxy: { workspaceId: proxy[1], path: proxy[2], method: request.method, ...(body === undefined ? {} : { body }) } }, 70_000));
        }
        requireValue(apiPath !== "/api/session", "UNSUPPORTED_ROUTE", 404);
        if (apiPath === "/api/collaboration" || apiPath.startsWith("/api/collaboration/")) {
          requireValue(!url.search && url.origin === new URL(env.APP_ORIGIN).origin, "UNSUPPORTED_ROUTE", 404);
          if (apiPath === "/api/collaboration") {
            requireValue(request.method === "GET", "METHOD_NOT_ALLOWED", 405);
            return privateResponse(await forward("/internal/collaboration", {}));
          }
          const operation = apiPath.slice("/api/collaboration/".length);
          requireValue(operation === "inspect-invitation" || COLLABORATION_OPERATIONS.some(value => value === operation), "UNSUPPORTED_ROUTE", 404);
          requireValue(request.method === "POST", "METHOD_NOT_ALLOWED", 405);
          requireValue(principal.credentialClass === "human", "HUMAN_REQUIRED", 403);
          guardMutation(request, principal, env);
          requireValue(expectedPrincipal === principal.id, "EXPECTED_PRINCIPAL_REQUIRED");
          requireValue(expectedIncarnation, "EXPECTED_INCARNATION_REQUIRED");
          const id = request.headers.get("idempotency-key");
          requireValue(id && /^[a-zA-Z0-9_-]{1,128}$/.test(id), "IDEMPOTENCY_KEY_REQUIRED");
          const expectedRevision = request.headers.get("if-platform-revision");
          requireValue(expectedRevision && /^(0|[1-9][0-9]{0,19})$/.test(expectedRevision), "EXPECTED_REVISION_REQUIRED");
          if (operation === "accept-invitation" || operation === "inspect-invitation") requireValue(expectedRevision === "0", "ACCEPT_REVISION_REQUIRED");
          const body = await controlBody(request, 16 * 1024);
          // Recipient acceptance must not read a project snapshot before its
          // authority transaction validates the invitation and intended subject.
          return privateResponse(await forward(operation === "inspect-invitation" ? "/internal/inspect-invitation" : "/internal/collaboration-command", {
            command: { commandId: id, expectedRevision, expectedIncarnation, operation, body },
          }));
        }
        if (request.method === "GET" && apiPath === "/api/state") {
          requireValue([...url.searchParams.keys()].every(key => key === 'candidateId') && url.searchParams.getAll('candidateId').length <= 1, 'STATE_QUERY_INVALID');
          const candidateId = url.searchParams.get('candidateId') ?? undefined;
          requireValue(candidateId === undefined || /^[a-zA-Z0-9_-]{1,160}$/.test(candidateId), 'INVALID_SELECTED_CANDIDATE');
          const scope = { principalId: principal.id, tenantId: principal.tenantId, projectId: scoped.projectId,
            credentialClass: principal.credentialClass, pi: env.PI_ENABLED === "true",
            publication: env.CONDITIONAL_PUBLICATION_VERIFIED === "true", maintenance: env.MAINTENANCE_MODE === "true", ...(candidateId === undefined ? {} : { selectedCandidateId: candidateId }) };
          const prior = priorViewCursor(request.headers.get("if-platform-view"), scope);
          const response = await forward("/internal/conditional-snapshot", { priorViewCursor: prior, ...(candidateId === undefined ? {} : { candidateId }) });
          if (!response.ok) return response;
          const result = await response.json() as { unchanged: true; cursor: ViewCursor } | { unchanged: false; cursor: ViewCursor; snapshot: AuthorityRead };
          const viewToken = issueViewToken(scope, result.cursor);
          const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
          if (result.unchanged) return Response.json({ unchanged: true, viewToken }, { headers });
          return Response.json({ ...uiSnapshot(result.snapshot, { pi: scope.pi, publication: scope.publication, maintenance: scope.maintenance }),
            session: { principalId: principal.id, credentialClass: principal.credentialClass,
              ...(result.snapshot.callerPermissions ? { permissions: result.snapshot.callerPermissions } : {}) }, viewCursor: result.cursor, viewToken }, { headers });
        }
        const sourceMatch = /^\/api\/candidates\/([a-zA-Z0-9_-]+)\/source$/.exec(apiPath);
        if (request.method === "GET" && sourceMatch) {
          const version = url.searchParams.get("version"); requireValue(version === "candidate" || version === "base", "SOURCE_VERSION_REQUIRED");
          return forward("/internal/candidate-source", { candidateId: sourceMatch[1], version });
        }
        const exportMatch = /^\/api\/receipts\/([a-zA-Z0-9_-]+)\/export$/.exec(apiPath);
        if (request.method === "GET" && (exportMatch || apiPath === "/api/trust-config" || apiPath === "/api/checkpoint" || apiPath === "/api/checkpoint-attestation")) return forward("/internal/export", { exportKind: exportMatch ? "bundle" : apiPath === "/api/checkpoint-attestation" ? "checkpoint-attestation" : apiPath === "/api/checkpoint" ? "checkpoint" : "trust", ...(exportMatch ? { publicationId: exportMatch[1] } : {}) });
        let body: Record<string, unknown> = {}; let id: string | null = null; let expectedRevision: string | null = null;
        if (request.method !== "GET") {
          requireValue(request.method === "POST", "METHOD_NOT_ALLOWED", 405); guardMutation(request, principal, env);
          body = await controlBody(request, apiPath === "/api/verify" ? 8 * 1024 * 1024 : MAX_CONTROL_BYTES);
          if (apiPath !== "/api/verify") {
            id = request.headers.get("idempotency-key"); requireValue(id && /^[a-zA-Z0-9_-]{1,128}$/.test(id), "IDEMPOTENCY_KEY_REQUIRED");
            expectedRevision = request.headers.get("if-platform-revision"); requireValue(expectedRevision && /^(0|[1-9][0-9]{0,19})$/.test(expectedRevision), "EXPECTED_REVISION_REQUIRED");
            requireValue(["/api/demo", "/api/select", "/api/repair", "/api/review", "/api/approve", "/api/publish", "/api/reconcile"].includes(apiPath), "UNSUPPORTED_ROUTE", 404);
          }
        }
        const snapshotResponse = await forward("/internal/snapshot", {}); if (!snapshotResponse.ok) return snapshotResponse;
        const snapshot = await snapshotResponse.json() as AuthorityRead;
        if (request.method === "GET") {
          if (apiPath === "/api/events") {
            const since = Number(request.headers.get("last-event-id") ?? url.searchParams.get("since") ?? 0);
            const events = snapshot.events.filter(event => event.sequence > since).map(event => `id: ${event.sequence}\ndata: ${event.payload}\n\n`).join("");
            return new Response(`retry: 2500\n${events}: snapshot ${snapshot.sequence}\n\n`, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
          }
          if (apiPath === "/api/health") return Response.json({ ready: false, readiness: "UNVERIFIED", liveness: "REACHABLE", authoritySnapshot: "OBSERVED", adapter: "cloudflare-closed-pilot", projectId: snapshot.project.scope.projectId,
            gate: snapshot.project.gate, unobserved: ["evaluator", "projectionLag", "deadLetterBacklog", "providerSpend", "containerResourceReturn"] }, { headers: { "cache-control": "no-store" } });
          return new Response("Not found", { status: 404 });
        }
        if (apiPath === "/api/verify") return Response.json(verifyBundle(body.bundle, body.trustConfig, body.checkpoint ?? null));
        let operation: string; let commandBody: Record<string, unknown>;
        if (apiPath === "/api/demo") { requireValue(env.PI_ENABLED === "true", "PI_CONFIGURATION_REQUIRED", 409); operation = "launch-cohort"; commandBody = { mode: body.mode }; }
        else if (apiPath === "/api/select") {
          requireValue(Array.isArray(body.attemptIds) && body.attemptIds.length > 0 && body.attemptIds.length <= 4, "SELECTION_LIMIT");
          const submissions = body.attemptIds.map(attemptId => snapshot.submissions.find(item => item.attemptId === attemptId)); requireValue(submissions.every(Boolean), "SUBMISSIONS_PENDING", 409);
          operation = "materialize"; commandBody = { submissionIds: submissions.map(item => item!.id).sort(), evaluate: true };
        } else if (apiPath === "/api/repair") {
          const conflict = uiSnapshot(snapshot, { pi: true, publication: false }).conflicts.find(item => item.id === body.conflictId); requireValue(conflict?.candidateId, "CONFLICT_UNAVAILABLE", 404); operation = "start-repair"; commandBody = { candidateId: conflict.candidateId };
        } else if (apiPath === "/api/review") {
          const evaluation = snapshot.evaluations.find(item => item.eligible && snapshot.plans.some(plan => plan.digest === item.planDigest && plan.candidateId === body.candidateId && plan.jobs.length === FULL_RELEASE_JOB_COUNT && plan.jobs.every(job => job.required && job.evidenceClass === "protected-behavioural"))); requireValue(evaluation, "FULL_EVALUATION_REQUIRED", 409); operation = "prepare-review"; commandBody = { candidateId: body.candidateId, evaluationId: evaluation.id };
        } else if (apiPath === "/api/approve" || apiPath === "/api/publish") {
          const review = (snapshot.reviews as { id: string; proposalDigest?: string }[]).find(item => item.proposalDigest === body.proposalDigest); requireValue(review, "REVIEW_UNAVAILABLE", 404); operation = apiPath === "/api/approve" ? "approve-review" : "request-publication"; commandBody = { reviewId: review.id, proposalDigest: body.proposalDigest };
          requireValue(body.simulateLostResponse !== true, "REMOTE_FAULT_INJECTION_UNAVAILABLE", 409);
        } else if (apiPath === "/api/reconcile") { operation = "reconcile-publication"; commandBody = {}; }
        else return new Response("Not found", { status: 404 });
        const response = await forward("/internal/command", { command: { commandId: id, expectedRevision, ...(expectedIncarnation ? { expectedIncarnation } : {}), operation, body: commandBody } });
        const headers = new Headers(response.headers); headers.set("cache-control", "no-store"); headers.set("x-content-type-options", "nosniff");
        return new Response(response.body, { status: response.status, headers });
      }
      const match = /^\/v1\/projects\/([a-zA-Z0-9_-]{1,128})(?:\/(.*))?$/.exec(url.pathname);
      requireValue(match, "SCOPED_API_REQUIRED", 404);
      const caller = { principal, projectId: match[1]! };
      const suffix = match[2] ?? "";
      requireValue(suffix !== "model-calls" || request.method === "GET", "METHOD_NOT_ALLOWED", 405);
      requireValue(suffix !== "inspect-invitation" && !COLLABORATION_OPERATIONS.some(operation => operation === suffix), "COLLABORATION_ROUTE_REQUIRED", 404);
      let internalPath = "/internal/snapshot"; let payload: Record<string, unknown> = { caller };
      const contextRead = /^attempts\/([a-zA-Z0-9_-]{1,128})\/context$/.exec(suffix);
      const attemptStatus = /^attempts\/([a-zA-Z0-9_-]{1,128})$/.exec(suffix);
      if (request.method === "GET" && contextRead) {
        const evidenceDigests = url.searchParams.getAll("evidence"); requireValue(evidenceDigests.length <= 8 && evidenceDigests.every((id, index) => /^sha256:[0-9a-f]{64}$/.test(id) && (!index || evidenceDigests[index - 1]! < id)), "CONTEXT_REFERENCE_LIMIT");
        internalPath = "/internal/attempt-context"; payload = { caller, contextRequest: { attemptId: contextRead[1], generation: url.searchParams.get("generation"), evidenceDigests } };
      } else if (request.method === "GET" && suffix === "model-calls") {
        requireValue(principal.credentialClass === "human", "HUMAN_REQUIRED", 403);
        internalPath = "/internal/model-calls"; payload = { caller, ...modelCallPageQuery(url, expectedIncarnation) };
      } else if (request.method === "GET" && suffix === "operations") {
        requireValue(!url.search || url.searchParams.size === 1 && url.searchParams.has("jobKey") && /^[a-f0-9]{64}$/.test(url.searchParams.get("jobKey") ?? ""), "OPERATIONS_QUERY_INVALID");
        internalPath = "/internal/operations"; payload = { caller, ...(url.searchParams.has("jobKey") ? { jobKey: url.searchParams.get("jobKey") } : {}) };
      } else if (request.method === "GET" && (suffix === "" || suffix === "state" || attemptStatus)) {
        // Reads use a separate method at the authority and never initiate a side effect.
        if (suffix === "state") {
          requireValue([...url.searchParams.keys()].every(key => key === 'modelCalls' || key === 'candidateId') && url.searchParams.getAll('modelCalls').length <= 1 && url.searchParams.getAll('candidateId').length <= 1, 'STATE_QUERY_INVALID');
          if (url.searchParams.has('modelCalls')) requireValue(url.searchParams.get('modelCalls') === '1', 'MODEL_ROSTER_QUERY_INVALID');
          const candidateId = url.searchParams.get('candidateId') ?? undefined;
          requireValue(candidateId === undefined || /^[a-zA-Z0-9_-]{1,160}$/.test(candidateId), 'INVALID_SELECTED_CANDIDATE');
          payload = { caller, ...(url.searchParams.has('modelCalls') ? { includeModelCalls: true } : {}), ...(candidateId === undefined ? {} : { candidateId }) };
        }
      } else if (request.method === "POST") {
        guardMutation(request, principal, env);
        const body = await controlBody(request, MAX_CONTROL_BYTES);
        if (suffix === "enroll") { internalPath = "/internal/enroll"; payload = { caller, enrollment: body }; }
        else {
          const id = request.headers.get("idempotency-key"); requireValue(id && /^[a-zA-Z0-9_-]{1,128}$/.test(id), "IDEMPOTENCY_KEY_REQUIRED");
          const expectedRevision = request.headers.get("if-platform-revision"); requireValue(expectedRevision && /^(0|[1-9][0-9]{0,19})$/.test(expectedRevision), "EXPECTED_REVISION_REQUIRED");
          requireValue(/^[a-z-]{1,64}$/.test(suffix), "UNSUPPORTED_ROUTE", 404);
          if (suffix === "launch-cohort") requireValue(env.PI_ENABLED === "true", "PI_CONFIGURATION_REQUIRED", 409);
          internalPath = "/internal/command"; payload = { caller, command: { commandId: id, expectedRevision, ...(expectedIncarnation ? { expectedIncarnation } : {}), operation: suffix, body } };
        }
      } else return new Response("Method not allowed", { status: 405 });
      const response = await authorityResponse(env.AUTHORITY, `https://authority.internal${internalPath}`, { method: "POST", headers: { authorization: `Bearer ${env.APP_SERVICE_TOKEN}`, "content-type": "application/json" }, body: canonicalize(payload) });
      const headers = new Headers(response.headers); headers.set("cache-control", "no-store"); headers.set("x-content-type-options", "nosniff");
      if (attemptStatus && response.ok) { const read = await response.json() as AuthorityRead; const attempt = read.attempts.find(item => item.id === attemptStatus[1]); requireValue(attempt, "REFERENCE_UNAVAILABLE", 404); const runtime = read.runtime.filter(item => item.attemptId === attempt.id); return Response.json({ attempt, runtime: runtime.find(item => item.lifecycle === "STOPPED") ?? runtime.at(-1) ?? null, submission: read.submissions.find(item => item.attemptId === attempt.id) ?? null, revision: read.project.revision }, { headers }); }
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      const response = errorResponse(error);
      return /^\/api\/(?:projects\/[A-Za-z0-9_-]+\/)?weft\/api\/workspaces\//.test(new URL(request.url).pathname) ? weftResponse(response) : privateResponse(response);
    }
  },
} satisfies ExportedHandler<ApplicationEnv>;
