// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { configuredWeftBinding, parseWeftActivity, parseWeftSync, validateWeftSelection, weftClient, weftJson, weftProxyPermission, verifyWeftProvenance } from "./weft-bridge";
import { canonicalize, sha256 } from "../../packages/protocol/src/index";
import type { WeftBinding } from "../../packages/protocol/src/weft";
import { PlatformError } from "../shared/errors";

const scope = { schemaVersion: 1 as const, tenantId: "test", projectId: "project", projectIncarnation: "incarnation" };
const binding: WeftBinding = { id: "binding", scope, workspaceId: "workspace", alternativeId: null, sourceRepo: "source", sourceRepositoryId: "repo-id", sourceRef: "refs/heads/main", sourceBase: "a".repeat(40), weftSourceRevision: "b".repeat(40) };
const selected = { schemaVersion: 1 as const, bindingId: binding.id, revision: 3, root: "c".repeat(64), privacyGeneration: 1, expectedBase: binding.sourceBase };

test("server binding is project/incarnation scoped and excludes arbitrary destinations", () => {
  assert.deepEqual(configuredWeftBinding(JSON.stringify([binding]), scope), binding);
  assert.equal(configuredWeftBinding(JSON.stringify([binding]), { ...scope, projectId: "other" }), null);
  assert.equal(configuredWeftBinding(JSON.stringify([binding]), { ...scope, projectIncarnation: "new" }), null);
  assert.throws(() => configuredWeftBinding(JSON.stringify([{ ...binding, url: "https://attacker.invalid" }]), scope));
  assert.throws(() => configuredWeftBinding(JSON.stringify([binding, binding]), scope));
  for (const sourceRef of ["refs/heads/a..b", "refs/heads/a//b", "refs/heads/a.lock", "refs/heads/a."]) {
    assert.throws(() => configuredWeftBinding(JSON.stringify([{ ...binding, sourceRef }]), scope));
  }
  assert.throws(() => configuredWeftBinding(JSON.stringify([{ ...binding, scope: { ...scope, schemaVersion: 2 } }]), scope));
});

test("selection rejects changing workspace, filesystem identity, or release base", () => {
  assert.deepEqual(validateWeftSelection(selected, binding), selected);
  for (const patch of [{ bindingId: "other" }, { revision: -1 }, { revision: 1.5 }, { root: "latest" }, { privacyGeneration: 0 }, { expectedBase: "d".repeat(40) }, { actor: "owner" }]) {
    assert.throws(() => validateWeftSelection({ ...selected, ...patch }, binding));
  }
});

test("replica proxy denies administrative, publication, credential and external-effect routes", () => {
  assert.equal(weftProxyPermission("GET", "sync"), "read");
  assert.equal(weftProxyPermission("GET", "state"), "read");
  assert.equal(weftProxyPermission("GET", "export"), "read");
  assert.equal(weftProxyPermission("GET", "revisions/7"), "read");
  assert.equal(weftProxyPermission("POST", "sync-contents"), "read");
  assert.equal(weftProxyPermission("POST", "prepare"), "edit");
  assert.throws(() => weftProxyPermission("POST", "export"));
  assert.throws(() => weftProxyPermission("POST", "revisions/7"));
  assert.throws(() => weftProxyPermission("GET", "revisions/latest"));
  for (const route of ["invite", "revoke", "source", "source-access", "publication", "policy", "init", "effect", "effect-target", "watch", "../state", "state?token=x", "alternatives/other/prepare"]) {
    assert.throws(() => weftProxyPermission("POST", route));
  }
});

test("provenance binds the retained revision and rejects canonical publication authority", async () => {
  const sourceBase = { repo: binding.sourceRepo, repositoryId: binding.sourceRepositoryId, branch: "main", oid: binding.sourceBase };
  const sourceBaseAuthority = "external-owner";
  const sourceBindingId = (await sha256(`weft:source-binding:v1\n${canonicalize({ sourceBase, sourceBaseAuthority })}`)).slice(7);
  const provenance = { schema: "weft.revision-provenance.v1", workspaceId: binding.workspaceId, alternativeId: null, revision: selected.revision, root: selected.root, privacyGeneration: 1, sourceBase, sourceBaseAuthority, sourceBindingId, sourceBaseStatus: "recorded", publicationMode: "external", sourcePublicationAvailable: false, sourcesBindingPresent: false };
  await verifyWeftProvenance(provenance, binding, selected);
  for (const patch of [{ root: "d".repeat(64) }, { revision: 4 }, { privacyGeneration: 2 }, { publicationMode: "standalone" }, { sourcesBindingPresent: true }, { sourcePublicationAvailable: true }, { sourceBaseStatus: "unavailable" }, { sourceBindingId: "0".repeat(64) }, { sourceBase: { ...sourceBase, oid: "d".repeat(40) } }]) {
    await assert.rejects(verifyWeftProvenance({ ...provenance, ...patch }, binding, selected));
  }
  for (const sourceBase of [null, [], undefined, { ...provenance.sourceBase, extra: "unbound" }]) {
    await assert.rejects(verifyWeftProvenance({ ...provenance, sourceBase }, binding, selected), /WEFT_SOURCE_BASE_MISMATCH/);
  }
});

test("live parsing preserves actual accepted event types and rejects coerced or oversized fields", () => {
  const sync = { schema: "weft.sync.v1", head: { revision: 3, manifest: { root: selected.root } }, privacyGeneration: 1,
    conflicts: [{ id: "conflict-1", actor: "participant-1", sharedRevision: 2, pathCount: 1 }] };
  assert.deepEqual(parseWeftSync(sync), { head: { revision: 3, root: selected.root, privacyGeneration: 1 }, conflicts: sync.conflicts });
  assert.deepEqual(parseWeftActivity({ events: [{ type: "accepted", revision: 3, actor: "participant-1", operation: "op-1", at: 1 }] }),
    [{ kind: "accepted", revision: 3, actor: "participant-1", detail: "op-1" }]);
  assert.deepEqual(parseWeftActivity({ events: [{ type: "checkpoint-queued" }] }),
    [{ kind: "checkpoint-queued", revision: null, actor: null, detail: "Recorded by the shared coordinator" }]);
  for (const value of [{ ...sync, head: { revision: "3", manifest: { root: selected.root } } },
    { ...sync, conflicts: [null] }, { ...sync, conflicts: [{ ...sync.conflicts[0], pathCount: "1" }] },
    { ...sync, conflicts: Array.from({ length: 201 }, () => sync.conflicts[0]) }]) assert.throws(() => parseWeftSync(value), /WEFT_RESPONSE_INVALID/);
  for (const events of [[null], [{ type: "accepted", revision: "3" }], [{ type: "accepted", actor: {} }],
    [{ type: "accepted", reason: "x".repeat(2049) }], Array.from({ length: 31 }, () => ({ type: "accepted" }))]) {
    assert.throws(() => parseWeftActivity({ events }), /WEFT_RESPONSE_INVALID/);
  }
});

test("scoped service client uses fixed routing and credential, discards caller headers, and honors cancellation", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const token = "a".repeat(40);
  const service = { async fetch(url: string, init: RequestInit) { requests.push({ url, init }); return Response.json({ accepted: true }); } } as unknown as Fetcher;
  const client = weftClient({ WEFT: service, WEFT_SERVICE_TOKEN: token }, binding);
  const response = await client.fetch("sync", { headers: { authorization: "Bearer browser-credential", cookie: "private" } });
  assert.equal(response.status, 200);
  assert.equal(requests[0].url, "https://weft.internal/api/workspaces/workspace/sync");
  assert.equal(new Headers(requests[0].init.headers).get("authorization"), `Bearer ${token}`);
  assert.equal(new Headers(requests[0].init.headers).get("cookie"), null);
  assert.equal(requests[0].init.redirect, "manual");
  for (const path of ["https://attacker.invalid", "/sync", "../state", "sync?credential=x"]) await assert.rejects(client.fetch(path), /WEFT_ROUTE_DENIED/);
  await assert.rejects(client.fetch("prepare", { method: "POST", body: new Uint8Array([1]) }), /WEFT_REQUEST_INVALID/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(client.fetch("sync", { signal: abort.signal }), /WEFT_SERVICE_CANCELLED/);
  assert.equal(requests.length, 1, "cancelled calls must never reach the service");
});

test("cancelling a stalled service response disposes its body without waiting for the peer", async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let disposed!: () => void;
  const cancelled = new Promise<void>(resolve => { disposed = resolve; });
  const service = { async fetch() { return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("{")); started(); },
    cancel() { disposed(); },
  })); } } as unknown as Fetcher;
  const client = weftClient({ WEFT: service, WEFT_SERVICE_TOKEN: "a".repeat(40) }, binding);
  const abort = new AbortController();
  const pending = client.fetch("sync", { signal: abort.signal });
  const rejected = assert.rejects(pending, /WEFT_SERVICE_CANCELLED/);
  await ready; abort.abort(); await rejected; await cancelled;
});

test("temporary coordinator backpressure and upstream timeout remain retryable without trusting the response body", async () => {
  for (const status of [408, 429]) {
    const response = new Response("upstream may return a non-JSON overload body", { status });
    await assert.rejects(weftJson({ async fetch() { return response; } }, "sync"),
      (error: unknown) => error instanceof PlatformError && error.status === 503);
    assert.equal(response.bodyUsed, true, "discard the transient response body");
  }
});
