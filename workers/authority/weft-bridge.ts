// SPDX-License-Identifier: Apache-2.0
import { canonicalize, parseStrictJson, sha256 } from "../../packages/protocol/src/index";
import type { Scope } from "../../packages/protocol/src/types";
import type { WeftBinding, WeftSelection, WeftWorkspaceView } from "../../packages/protocol/src/weft";
import { PlatformError, readBounded, requireValue } from "../shared/errors";
import { withinDeadline } from "../shared/deadline";
import type { WeftSourceClient } from "./weft-source";
import { validateCanonicalRef } from "./artifacts";

export interface WeftEnvironment {
  WEFT?: Fetcher;
  WEFT_CONNECTIONS?: string;
  WEFT_SERVICE_TOKEN?: string;
}
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const oid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const root = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const boundedText = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= maximum;
const MAX_SERVICE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;

/** Deployment-owned mapping. Neither origin nor workspace can be supplied by a browser. */
export function configuredWeftBinding(configuration: string | undefined, scope: Scope): WeftBinding | null {
  requireValue(configuration === undefined || new TextEncoder().encode(configuration).length <= 64 * 1024, "WEFT_CONFIGURATION_INVALID", 503);
  let entries: unknown;
  try { entries = JSON.parse(configuration ?? "[]"); } catch { throw new PlatformError("WEFT_CONFIGURATION_INVALID", 503); }
  requireValue(Array.isArray(entries) && entries.length <= 32, "WEFT_CONFIGURATION_INVALID", 503);
  const matches: WeftBinding[] = [];
  for (const value of entries) {
    requireValue(record(value), "WEFT_CONFIGURATION_INVALID", 503);
    const item = value;
    requireValue(exactKeys(item, ["id", "scope", "workspaceId", "alternativeId", "sourceRepo", "sourceRepositoryId", "sourceRef", "sourceBase", "weftSourceRevision"])
      && identifier(item.id) && identifier(item.workspaceId) && (item.alternativeId === null || identifier(item.alternativeId))
      && record(item.scope) && exactKeys(item.scope, ["schemaVersion", "projectId", "projectIncarnation", "tenantId"]) && item.scope.schemaVersion === 1
      && identifier(item.scope.tenantId) && identifier(item.scope.projectId) && identifier(item.scope.projectIncarnation)
      && typeof item.sourceRepo === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(item.sourceRepo)
      && typeof item.sourceRepositoryId === "string" && item.sourceRepositoryId.length > 0 && item.sourceRepositoryId.length <= 160
      && typeof item.sourceRef === "string" && /^refs\/heads\/[A-Za-z0-9_][A-Za-z0-9_.\/-]{0,145}$/.test(item.sourceRef)
      && oid(item.sourceBase) && oid(item.weftSourceRevision), "WEFT_CONFIGURATION_INVALID", 503);
    try { validateCanonicalRef(item.sourceRef); } catch { throw new PlatformError("WEFT_CONFIGURATION_INVALID", 503); }
    if (canonicalize(item.scope) === canonicalize(scope)) matches.push({ id: item.id,
      scope: { schemaVersion: 1, tenantId: item.scope.tenantId, projectId: item.scope.projectId, projectIncarnation: item.scope.projectIncarnation },
      workspaceId: item.workspaceId, alternativeId: item.alternativeId, sourceRepo: item.sourceRepo,
      sourceRepositoryId: item.sourceRepositoryId, sourceRef: item.sourceRef, sourceBase: item.sourceBase, weftSourceRevision: item.weftSourceRevision });
  }
  requireValue(matches.length <= 1, "WEFT_CONFIGURATION_AMBIGUOUS", 503);
  return matches[0] ?? null;
}

export function validateWeftSelection(input: unknown, binding: WeftBinding): WeftSelection {
  requireValue(record(input), "WEFT_SELECTION_INVALID");
  const selected = input;
  const keys = ["schemaVersion", "bindingId", "revision", "root", "privacyGeneration", "expectedBase", ...(selected.context === undefined ? [] : ["context"])];
  requireValue(exactKeys(selected, keys) && selected.schemaVersion === 1
    && selected.bindingId === binding.id && natural(selected.revision)
    && root(selected.root) && natural(selected.privacyGeneration) && selected.privacyGeneration >= 1
    && selected.expectedBase === binding.sourceBase, "WEFT_SELECTION_INVALID", 409);
  let context: WeftSelection["context"];
  if (selected.context !== undefined) {
    requireValue(record(selected.context) && exactKeys(selected.context, ["note"]) && typeof selected.context.note === "string"
      && new TextEncoder().encode(selected.context.note).length <= 2048, "WEFT_CONTEXT_INVALID");
    try { canonicalize(selected.context); } catch { throw new PlatformError("WEFT_CONTEXT_INVALID"); }
    context = { note: selected.context.note };
  }
  return { schemaVersion: 1, bindingId: binding.id, revision: selected.revision, root: selected.root,
    privacyGeneration: selected.privacyGeneration, expectedBase: binding.sourceBase, ...(context ? { context } : {}) };
}

export async function verifyWeftProvenance(value: unknown, binding: WeftBinding, selected: Pick<WeftSelection, "revision" | "root" | "privacyGeneration">): Promise<void> {
  requireValue(record(value), "WEFT_PROVENANCE_INVALID", 409);
  const data = value;
  requireValue(data.schema === "weft.revision-provenance.v1" && data.workspaceId === binding.workspaceId && data.alternativeId === binding.alternativeId
    && data.revision === selected.revision && data.root === selected.root && data.privacyGeneration === selected.privacyGeneration,
  "WEFT_PROVENANCE_IDENTITY_MISMATCH", 409);
  requireValue(data.publicationMode === "external" && data.sourcePublicationAvailable === false && data.sourcesBindingPresent === false,
    "WEFT_CANONICAL_PUBLICATION_NOT_FENCED", 409);
  requireValue(data.sourceBaseStatus === "recorded" && data.sourceBaseAuthority === "external-owner", "WEFT_SOURCE_BASE_UNAVAILABLE", 409);
  const expected = { repo: binding.sourceRepo, repositoryId: binding.sourceRepositoryId, branch: binding.sourceRef.slice("refs/heads/".length), oid: binding.sourceBase };
  requireValue(record(data.sourceBase) && exactKeys(data.sourceBase, ["repo", "repositoryId", "branch", "oid"]) &&
    data.sourceBase.repo === expected.repo && data.sourceBase.repositoryId === expected.repositoryId &&
    data.sourceBase.branch === expected.branch && data.sourceBase.oid === expected.oid, "WEFT_SOURCE_BASE_MISMATCH", 409);
  const identity = (await sha256(`weft:source-binding:v1\n${canonicalize({ sourceBase: data.sourceBase, sourceBaseAuthority: data.sourceBaseAuthority })}`)).slice(7);
  requireValue(data.sourceBindingId === identity, "WEFT_SOURCE_BINDING_MISMATCH", 409);
}

/** Narrow local collaboration surface: no publication, policy, credentials or external actions. */
export function weftProxyPermission(method: string, path: string): "read" | "edit" {
  if (method === "GET" && (/^(sync|state|viewer|conflicts|export)$/.test(path)
    || /^sync\/revisions\/(0|[1-9][0-9]{0,15})(\/provenance)?$/.test(path)
    || /^revisions\/(0|[1-9][0-9]{0,15})$/.test(path)
    || /^(operations|conflicts|observations)\/[A-Za-z0-9_-]{1,128}$/.test(path))) return "read";
  if (method === "POST" && path === "sync-contents") return "read";
  if (method === "POST" && /^(prepare|authorize|complete|observe|context|checkpoint)$/.test(path)) return "edit";
  throw new PlatformError("WEFT_ROUTE_DENIED", 403);
}

/** Fixed service binding, bounded bytes and deadline, with no forwarded browser headers. */
export function weftClient(env: WeftEnvironment, binding: WeftBinding, credential = env.WEFT_SERVICE_TOKEN, timeoutMs = 15_000): WeftSourceClient {
  requireValue(env.WEFT && typeof credential === "string" && credential.length >= 32 && credential.length <= 4096 && !/[\r\n\0]/.test(credential), "WEFT_SERVICE_UNCONFIGURED", 503);
  const service = env.WEFT;
  const prefix = `/api/workspaces/${binding.workspaceId}/${binding.alternativeId ? `alternatives/${binding.alternativeId}/` : ""}`;
  return {
    async fetch(path: string, init: RequestInit = {}): Promise<Response> {
      requireValue(/^[A-Za-z0-9_/-]{1,240}$/.test(path) && !path.includes("..") && !path.startsWith("/"), "WEFT_ROUTE_DENIED", 403);
      const method = init.method ?? "GET";
      requireValue((method === "GET" || method === "POST") && (init.body === undefined || typeof init.body === "string" &&
        new TextEncoder().encode(init.body).length <= MAX_REQUEST_BYTES) && (method !== "GET" || init.body === undefined), "WEFT_REQUEST_INVALID", 413);
      requireValue(!init.signal?.aborted, "WEFT_SERVICE_CANCELLED", 503);
      const controller = new AbortController();
      const cancelled = () => controller.abort();
      init.signal?.addEventListener("abort", cancelled, { once: true });
      try {
        return await withinDeadline(async () => {
          const response = await service.fetch(`https://weft.internal${prefix}${path}`, { method, body: init.body,
            headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, signal: controller.signal, redirect: "manual" });
          if (controller.signal.aborted || response.status >= 300 && response.status < 400) {
            void response.body?.cancel().catch(() => { /* Best effort cleanup of an unusable upstream response. */ });
            throw new PlatformError(controller.signal.aborted ? "WEFT_SERVICE_CANCELLED" : "WEFT_REDIRECT_DENIED", 503);
          }
          const stream = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal: controller.signal }) ?? null;
          const body = await readBounded(stream, MAX_SERVICE_BYTES);
          requireValue(!controller.signal.aborted, "WEFT_SERVICE_CANCELLED", 503);
          return new Response([204, 205, 304].includes(response.status) ? null : body.slice().buffer,
            { status: response.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
        }, timeoutMs, "WEFT_SERVICE_UNAVAILABLE");
      } catch (error) {
        if (error instanceof PlatformError) throw error;
        // Binding errors may include credential-bearing request details; keep them outside application responses.
        throw new PlatformError(controller.signal.aborted ? "WEFT_SERVICE_CANCELLED" : "WEFT_SERVICE_UNAVAILABLE", 503);
      } finally { init.signal?.removeEventListener("abort", cancelled); controller.abort(); }
    },
  };
}

export async function weftJson(client: WeftSourceClient, path: string, input?: unknown): Promise<Record<string, unknown>> {
  const response = await client.fetch(path, input === undefined ? undefined : { method: "POST", body: canonicalize(input) });
  if (response.status === 408 || response.status === 429) {
    // Capacity/transport refusal has no terminal semantic outcome. Keep the saved handoff retryable.
    void response.body?.cancel().catch(() => { /* Disposal must not delay retry classification. */ });
    throw new PlatformError("WEFT_SERVICE_UNAVAILABLE", 503);
  }
  let value: unknown;
  try { value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(response.body, MAX_SERVICE_BYTES))); }
  catch (error) { if (error instanceof PlatformError) throw error; throw new PlatformError("WEFT_RESPONSE_INVALID", 502); }
  requireValue(record(value), "WEFT_RESPONSE_INVALID", 502);
  requireValue(response.ok, typeof value.error === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.error) ? `WEFT_${value.error}` : "WEFT_SERVICE_UNAVAILABLE", response.status >= 500 ? 503 : response.status);
  return value;
}

/** Only reported coordinator facts enter the UI. This is not replica disk acknowledgement. */
export function parseWeftSync(value: unknown): { head: NonNullable<WeftWorkspaceView["head"]>; conflicts: WeftWorkspaceView["conflicts"] } {
  requireValue(record(value) && value.schema === "weft.sync.v1" && record(value.head) && natural(value.head.revision) &&
    record(value.head.manifest) && root(value.head.manifest.root) && natural(value.privacyGeneration) && value.privacyGeneration >= 1 &&
    Array.isArray(value.conflicts) && value.conflicts.length <= 200, "WEFT_RESPONSE_INVALID", 502);
  const conflicts = value.conflicts.map((item: unknown) => {
    requireValue(record(item) && boundedText(item.id, 160) && boundedText(item.actor, 160) &&
      natural(item.sharedRevision) && natural(item.pathCount) && item.pathCount <= 2000, "WEFT_RESPONSE_INVALID", 502);
    return { id: item.id, actor: item.actor, sharedRevision: item.sharedRevision, pathCount: item.pathCount };
  });
  return { head: { revision: value.head.revision, root: value.head.manifest.root, privacyGeneration: value.privacyGeneration }, conflicts };
}

export function parseWeftActivity(value: unknown): WeftWorkspaceView["activity"] {
  requireValue(record(value) && Array.isArray(value.events) && value.events.length <= 30, "WEFT_RESPONSE_INVALID", 502);
  return value.events.map((item: unknown) => {
    requireValue(record(item) && boundedText(item.type, 128) && (item.revision === undefined || natural(item.revision)) &&
      (item.actor === undefined || boundedText(item.actor, 160)) && (item.operation === undefined || boundedText(item.operation, 2048)) &&
      (item.reason === undefined || boundedText(item.reason, 2048)), "WEFT_RESPONSE_INVALID", 502);
    return { kind: item.type, revision: item.revision ?? null, actor: item.actor ?? null,
      detail: item.operation ?? item.reason ?? "Recorded by the shared coordinator" };
  });
}
