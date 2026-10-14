// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { modelDispatchTimeoutMs, modelRoute, normalizeModelRequest, workersAiBindingInput, workersAiFailureDiagnostic, workersAiResponseIdentity, WORKERS_AI_CODING_MODEL, WORKERS_AI_LEGACY_CODING_MODEL, type ModelRouteEnvironment } from "./model-policy";
import { PlatformError } from "../shared/errors";
import { canonicalize } from "../../packages/protocol/src/index";

test("Workers AI failures emit bounded diagnostic categories without provider message bytes", () => {
  const billing = Object.assign(new Error("Workers Paid required; bearer secret"), { name: "InferenceUpstreamError", code: 5035, status: 403 });
  assert.deepEqual(workersAiFailureDiagnostic(billing), { name: "InferenceUpstreamError", code: "5035", status: 403, category: "billing-access" });
  const unsafe = { name: "Bearer secret", code: "sk-secret", status: 777, message: "request contains bearer secret" };
  const detail = workersAiFailureDiagnostic(unsafe);
  assert.deepEqual(detail, { name: "UnknownError", code: null, status: null, category: "unclassified" });
  assert.ok(!JSON.stringify(detail).includes("secret"));
  assert.deepEqual(workersAiFailureDiagnostic({ name: "SecretToken", code: 12345, status: 503, message: "secret" }), { name: "UnknownError", code: null, status: 503, category: "unclassified" });
  assert.deepEqual(workersAiFailureDiagnostic(new PlatformError("MODEL_RESERVATION_DENIED", 409)), { name: "Error", code: "MODEL_RESERVATION_DENIED", status: 409, category: "unclassified" });
});

test("broker policy rejections retain their finite code without being mislabeled provider access", () => {
  for (const code of ["MODEL_POLICY_DENIED", "MODEL_MESSAGES_DENIED", "MODEL_TEXT_ONLY", "MODEL_TOKEN_FIELDS_AMBIGUOUS"]) {
    const diagnostic = workersAiFailureDiagnostic(new PlatformError(code, 403, "Private reasoning canary: provider timed out"));
    assert.deepEqual(diagnostic, { name: "Error", code, status: 403, category: "broker-policy" });
    assert(!JSON.stringify(diagnostic).includes("canary"));
  }
  assert.deepEqual(workersAiFailureDiagnostic({ name: "Error", code: "PRIVATE_REASONING_CANARY", status: 403 }),
    { name: "Error", code: null, status: 403, category: "provider-access" });
});

test("pinned Pi completion request becomes one bounded nonstream provider request", () => {
  const result = normalizeModelRequest({ model: "owned-model", messages: [{ role: "system", content: "Host task" }, { role: "user", content: [{ type: "text", text: "Untrusted source" }] }], stream: true, stream_options: { include_usage: true }, max_completion_tokens: 8192, store: false }, "owned-model", "max_tokens");
  assert.equal(result.requestedStream, true);
  assert.equal(result.request.max_tokens, 4096);
  assert.equal(result.request.max_completion_tokens, undefined);
  assert.equal(result.request.stream_options, undefined);
  assert.equal(result.request.stream, false);
  assert.equal(result.request.store, false);
});

test("Pi assistant reasoning history is removed from a bounded continuation", () => {
  // Matches retained attempt 5b8443a9's turn lengths and metadata, without
  // copying its private prompt, model prose, or reasoning into this fixture.
  const earlierText = "p".repeat(1161);
  const earlierReasoning = "r".repeat(2097);
  const messages = [
    { role: "system", content: "Complete the host task." },
    { role: "user", content: [{ type: "text", text: "t".repeat(6367) }] },
    { role: "assistant", content: earlierText, reasoning_content: earlierReasoning },
    { role: "user", content: [{ type: "text", text: "c".repeat(648) }] },
  ];
  const result = normalizeModelRequest({ model: WORKERS_AI_LEGACY_CODING_MODEL, messages, stream: true, max_completion_tokens: 8192 }, WORKERS_AI_LEGACY_CODING_MODEL, "max_completion_tokens", "low");
  assert.equal(result.requestedStream, true);
  assert.deepEqual(result.request.messages, messages.map(({ reasoning_content: _reasoningContent, ...message }) => message));
  assert.equal(messages[2].reasoning_content, earlierReasoning);
  assert.equal(JSON.stringify(result.request).includes(earlierReasoning), false);
  assert.equal(JSON.stringify(workersAiBindingInput(result.request)).includes("reasoning_content"), false);
});

test("only a string reasoning_content on an assistant turn may be discarded", () => {
  const base = { model: WORKERS_AI_LEGACY_CODING_MODEL, messages: [{ role: "user", content: "Host task" }] };
  const check = (message: Record<string, unknown>) => normalizeModelRequest({ ...base, messages: [message] }, WORKERS_AI_LEGACY_CODING_MODEL, "max_completion_tokens", "low");
  for (const role of ["system", "developer", "user"]) {
    assert.throws(() => check({ role, content: "Text", reasoning_content: "untrusted" }), /MODEL_MESSAGES_DENIED/);
  }
  assert.throws(() => check({ role: "assistant", content: "Text", reasoning_content: { text: "untrusted" } }), /MODEL_MESSAGES_DENIED/);
  assert.throws(() => check({ role: "assistant", content: "Text", reasoning_content: "x".repeat(64 * 1024 + 1) }), /MODEL_MESSAGES_DENIED/);
  assert.throws(() => check({ role: "assistant", content: "Text", tool_calls: [] }), /MODEL_MESSAGES_DENIED/);
  assert.throws(() => check({ role: "assistant", content: "Text", reasoning_details: [] }), /MODEL_MESSAGES_DENIED/);
  assert.throws(() => check({ role: "assistant", content: [{ type: "image_url", image_url: { url: "https://owned.test/image.png" } }], reasoning_content: "model thinking" }), /MODEL_TEXT_ONLY/);
});

test("model broker rejects unsupported provider tools, media and conflicting token fields", () => {
  const input = { model: "owned-model", messages: [{ role: "user", content: "Text only" }] };
  assert.throws(() => normalizeModelRequest({ ...input, tools: [{ type: "web_search" }] }, "owned-model", "max_tokens"), /MODEL_POLICY_DENIED/);
  assert.throws(() => normalizeModelRequest({ ...input, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://owned.test/image.png" } }] }] }, "owned-model", "max_tokens"), /MODEL_TEXT_ONLY/);
  assert.throws(() => normalizeModelRequest({ ...input, max_tokens: 20, max_completion_tokens: 30 }, "owned-model", "max_tokens"), /MODEL_TOKEN_FIELDS_AMBIGUOUS/);
});

test("Workers AI route requires an allowed model-effort pair, binding, and no external key", () => {
  const worker = { MODEL_PROVIDER_KIND: "workers-ai", MODEL_NAME: WORKERS_AI_CODING_MODEL, MODEL_API_BASE_URL: "UNCONFIGURED", MODEL_OUTPUT_TOKEN_FIELD: "max_completion_tokens", MODEL_REASONING_EFFORT: "none", MODEL_MAXIMUM_CALL_COST: "100000", AI: { run: () => Promise.resolve() } } as ModelRouteEnvironment;
  assert.equal(modelRoute(worker), "workers-ai");
  assert.equal(modelRoute({ ...worker, MODEL_NAME: WORKERS_AI_LEGACY_CODING_MODEL, MODEL_REASONING_EFFORT: "low" }), "workers-ai");
  for (const changed of [
    { MODEL_NAME: "@cf/zai-org/glm-5.3-flash" }, { MODEL_NAME: WORKERS_AI_LEGACY_CODING_MODEL }, { MODEL_REASONING_EFFORT: "low" }, { MODEL_API_KEY: "unexpected" },
    { AI: undefined }, { MODEL_API_BASE_URL: "https://example.invalid/v1" }, { MODEL_OUTPUT_TOKEN_FIELD: "max_tokens" },
  ]) assert.throws(() => modelRoute({ ...worker, ...changed }), /MODEL_ROUTE_UNCONFIGURED/);
  const external = { ...worker, MODEL_PROVIDER_KIND: "openai-compatible", MODEL_NAME: "owned-model", MODEL_API_BASE_URL: "https://owned.invalid/v1", MODEL_API_KEY: "owned-only", MODEL_REASONING_EFFORT: "UNCONFIGURED", MODEL_OUTPUT_TOKEN_FIELD: "max_tokens", AI: undefined };
  assert.equal(modelRoute(external), "openai-compatible");
  assert.throws(() => modelRoute({ ...external, MODEL_API_KEY: undefined }), /MODEL_ROUTE_UNCONFIGURED/);
});

test("Workers AI request pins model-specific reasoning and supported parameters", () => {
  assert.equal(modelDispatchTimeoutMs("workers-ai"), 240000);
  assert.equal(modelDispatchTimeoutMs("openai-compatible"), 90000);
  const normalized = normalizeModelRequest({ model: WORKERS_AI_CODING_MODEL, messages: [{ role: "user", content: "Change a file" }], stream: true, max_tokens: 9000, temperature: 0.4, prompt_cache_key: "sdk-cache", store: false }, WORKERS_AI_CODING_MODEL, "max_completion_tokens", "none");
  assert.equal(normalized.requestedStream, true);
  assert.equal(normalized.request.reasoning_effort, "none");
  assert.equal(normalized.request.max_completion_tokens, 8192);
  assert.equal(normalized.request.prompt_cache_key, undefined);
  const input = workersAiBindingInput(normalized.request);
  assert.equal(input.reasoning_effort, "none"); assert.equal(input.temperature, 0.4);
  assert.equal(input.max_completion_tokens, 8192);
  assert.equal(input.model, undefined);
  assert.throws(() => workersAiBindingInput({ ...normalized.request, max_completion_tokens: 8193 }), /MODEL_ROUTE_UNCONFIGURED/);
  assert.throws(() => normalizeModelRequest({ model: WORKERS_AI_CODING_MODEL, messages: [{ role: "user", content: "x" }], temperature: "cold" }, WORKERS_AI_CODING_MODEL, "max_completion_tokens", "none"), /MODEL_POLICY_DENIED/);
  assert.throws(() => normalizeModelRequest({ model: WORKERS_AI_CODING_MODEL, messages: [{ role: "user", content: "x" }] }, WORKERS_AI_CODING_MODEL, "max_completion_tokens", "low"), /MODEL_ROUTE_UNCONFIGURED/);
  const legacy = normalizeModelRequest({ model: WORKERS_AI_LEGACY_CODING_MODEL, messages: [{ role: "user", content: "Change a file" }], max_tokens: 8192 }, WORKERS_AI_LEGACY_CODING_MODEL, "max_completion_tokens", "low");
  assert.equal(legacy.request.max_completion_tokens, 8192);
  assert.equal(workersAiBindingInput(legacy.request).reasoning_effort, "low");
});

test("Workers AI response retains reported usage and rejects model or byte-shape drift", () => {
  const response = { id: "chat-1", object: "chat.completion", created: 1, model: WORKERS_AI_CODING_MODEL, choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 22, completion_tokens: 48, total_tokens: 70, prompt_tokens_details: { cached_tokens: 4 }, neurons: 127.29090881347656 } };
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const observed = workersAiResponseIdentity(bytes(response), WORKERS_AI_CODING_MODEL);
  assert.deepEqual(observed, { reportedModel: WORKERS_AI_CODING_MODEL, responseId: "chat-1", usage: { prompt_tokens: 22, completion_tokens: 48, total_tokens: 70, prompt_tokens_details: { cached_tokens: 4 }, neurons_decimal: "127.29090881347656" } });
  assert.doesNotThrow(() => canonicalize({ usage: observed.usage }));
  assert.throws(() => workersAiResponseIdentity(bytes({ ...response, model: "other" }), WORKERS_AI_CODING_MODEL), /MODEL_RESPONSE_IDENTITY_MISMATCH/);
  assert.throws(() => workersAiResponseIdentity(bytes({ ...response, usage: { ...response.usage, completion_tokens: -1 } }), WORKERS_AI_CODING_MODEL), /MODEL_USAGE_INVALID/);
  assert.throws(() => workersAiResponseIdentity(bytes({ ...response, usage: { ...response.usage, neurons: -1 } }), WORKERS_AI_CODING_MODEL), /MODEL_USAGE_INVALID/);
  assert.throws(() => workersAiResponseIdentity(bytes({ ...response, choices: [{ message: { role: "assistant", content: null } }] }), WORKERS_AI_CODING_MODEL), /MODEL_RESPONSE_INVALID/);
});
