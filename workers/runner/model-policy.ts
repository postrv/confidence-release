// SPDX-License-Identifier: Apache-2.0
import type { ChatCompletionsInput, ChatCompletionMessageParam } from "@cloudflare/workers-types";
import { requireValue } from "../shared/errors";

export const WORKERS_AI_CODING_MODEL = "@cf/deepseek-ai/deepseek-v4-flash-0731";
export const WORKERS_AI_LEGACY_CODING_MODEL = "@cf/zai-org/glm-5.3";
export function workersAiModel(model: string): typeof WORKERS_AI_CODING_MODEL | typeof WORKERS_AI_LEGACY_CODING_MODEL {
  requireValue(model === WORKERS_AI_CODING_MODEL || model === WORKERS_AI_LEGACY_CODING_MODEL, "MODEL_ROUTE_UNCONFIGURED", 503);
  return model;
}
export function workersAiReasoningEffort(model: string): "none" | "low" {
  return workersAiModel(model) === WORKERS_AI_CODING_MODEL ? "none" : "low";
}
export const modelDispatchTimeoutMs = (route: "workers-ai" | "openai-compatible"): number => route === "workers-ai" ? 240000 : 90000;

const loggedErrorNames = new Set(["Error", "TypeError", "AbortError", "TimeoutError", "InferenceUpstreamError", "AiInternalError", "PlatformError"]);
const loggedProviderCodes = new Set(["5007", "5004", "3039", "3003", "5018", "5016", "3023", "3041", "5035", "5019", "5005", "3042", "3006", "3007", "3008", "3036", "3040"]);
const brokerPolicyCodes = new Set(["MODEL_POLICY_DENIED", "MODEL_MESSAGES_DENIED", "MODEL_TEXT_ONLY", "MODEL_TOKEN_FIELDS_AMBIGUOUS"]);
const loggedPlatformCodes = new Set([...brokerPolicyCodes, "BROKER_FENCED", "BROKER_GENERATION_FENCED", "DESTINATION_DENIED", "MODEL_NOT_CONFIGURED", "MODEL_ROUTE_UNCONFIGURED", "MODEL_RESERVATION_DENIED", "MODEL_PROVIDER_UNAVAILABLE", "MODEL_RESPONSE_INVALID", "MODEL_RESPONSE_IDENTITY_MISMATCH", "MODEL_USAGE_INVALID", "SIZE_LIMIT", "OBJECT_STORE_DEADLINE_EXCEEDED", "REQUIRED_OBJECT_MISSING", "OBJECT_DIGEST_MISMATCH"]);

/** Safe to emit in Worker logs: no provider message, request, or response bytes. */
export function workersAiFailureDiagnostic(error: unknown): { name: string; code: string | null; status: number | null; category: string } {
  const details = error && typeof error === "object" ? error as { name?: unknown; code?: unknown; status?: unknown; message?: unknown } : {};
  const name = typeof details.name === "string" && loggedErrorNames.has(details.name) ? details.name : "UnknownError";
  const rawCode = (typeof details.code === "number" && Number.isSafeInteger(details.code)) || typeof details.code === "string" ? String(details.code) : "";
  const code = loggedProviderCodes.has(rawCode) || loggedPlatformCodes.has(rawCode) ? rawCode : null;
  const status = typeof details.status === "number" && Number.isSafeInteger(details.status) && details.status >= 400 && details.status <= 599 ? details.status : null;
  const message = typeof details.message === "string" ? details.message : "";
  const category = code !== null && brokerPolicyCodes.has(code) ? "broker-policy"
    : code === "5035" || /workers paid|prepaid.*credit/i.test(message) ? "billing-access"
    : code === "3040" || /out of capacity|capacity temporarily exceeded/i.test(message) ? "provider-capacity"
    : code === "3007" || /timed? out|timeout/i.test(message) ? "provider-timeout"
    : code === "3008" || /abort/i.test(message) ? "provider-aborted"
    : status === 429 || /rate limit/i.test(message) ? "provider-rate-limit"
    : status === 401 || status === 403 || /not allowed|not authorized|forbidden/i.test(message) ? "provider-access"
    : status === 400 || /invalid (?:request|input)|unsupported parameter/i.test(message) ? "provider-request"
    : "unclassified";
  return { name, code, status, category };
}

export interface ModelRouteEnvironment {
  MODEL_PROVIDER_KIND: string; MODEL_NAME: string; MODEL_API_BASE_URL: string; MODEL_API_KEY?: string;
  MODEL_OUTPUT_TOKEN_FIELD: string; MODEL_REASONING_EFFORT: string; MODEL_MAXIMUM_CALL_COST: string;
  AI?: { run: unknown };
}

/** Model credentials and binding are mutually exclusive for the private pilot. */
export function modelRoute(env: ModelRouteEnvironment): "workers-ai" | "openai-compatible" {
  requireValue(/^[1-9][0-9]{0,17}$/.test(env.MODEL_MAXIMUM_CALL_COST)
    && BigInt(env.MODEL_MAXIMUM_CALL_COST) <= 100000n, "MODEL_ROUTE_UNCONFIGURED", 503);
  if (env.MODEL_PROVIDER_KIND === "workers-ai") {
    requireValue(env.MODEL_REASONING_EFFORT === workersAiReasoningEffort(env.MODEL_NAME) && env.MODEL_API_BASE_URL === "UNCONFIGURED"
      && !env.MODEL_API_KEY && env.MODEL_OUTPUT_TOKEN_FIELD === "max_completion_tokens"
      && typeof env.AI?.run === "function", "MODEL_ROUTE_UNCONFIGURED", 503);
    return "workers-ai";
  }
  requireValue(env.MODEL_PROVIDER_KIND === "openai-compatible" && env.MODEL_NAME && env.MODEL_NAME !== "UNCONFIGURED"
    && env.MODEL_API_KEY && env.MODEL_API_KEY !== "UNCONFIGURED" && !env.AI && env.MODEL_REASONING_EFFORT === "UNCONFIGURED"
    && ["max_tokens", "max_completion_tokens"].includes(env.MODEL_OUTPUT_TOKEN_FIELD), "MODEL_ROUTE_UNCONFIGURED", 503);
  requireValue(typeof env.MODEL_API_BASE_URL === "string" && URL.canParse(`${env.MODEL_API_BASE_URL.replace(/\/$/, "")}/chat/completions`), "MODEL_ROUTE_UNCONFIGURED", 503);
  const upstream = new URL(`${env.MODEL_API_BASE_URL.replace(/\/$/, "")}/chat/completions`);
  requireValue(upstream.protocol === "https:" && !upstream.username && !upstream.password && !upstream.search && !upstream.hash, "MODEL_ROUTE_UNCONFIGURED", 503);
  return "openai-compatible";
}

/** The registered authoring recipe supports text proposals without provider tools. */
export function normalizeModelRequest(value: Record<string, unknown>, model: string, outputField: string, reasoningEffort?: "low" | "none"): { request: Record<string, unknown>; requestedStream: boolean } {
  const allowed = new Set(["model", "messages", "stream", "stream_options", "store", "max_tokens", "max_completion_tokens", "temperature", "top_p", "presence_penalty", "frequency_penalty", "stop", "prompt_cache_key"]);
  requireValue(Object.keys(value).every(key => allowed.has(key)) && value.model === model, "MODEL_POLICY_DENIED", 403);
  requireValue(outputField === "max_tokens" || outputField === "max_completion_tokens", "MODEL_ROUTE_UNCONFIGURED", 503);
  requireValue(value.max_tokens === undefined || value.max_completion_tokens === undefined, "MODEL_TOKEN_FIELDS_AMBIGUOUS", 403);
  const tokens = value.max_tokens ?? value.max_completion_tokens ?? 4096;
  requireValue(Number.isSafeInteger(tokens) && Number(tokens) > 0 && (value.store === undefined || value.store === false), "MODEL_POLICY_DENIED", 403);
  for (const [key, minimum, maximum] of [["temperature", 0, 2], ["top_p", 0, 1], ["presence_penalty", -2, 2], ["frequency_penalty", -2, 2]] as const) {
    const parameter = value[key];
    requireValue(parameter === undefined || parameter === null || typeof parameter === "number" && Number.isFinite(parameter) && parameter >= minimum && parameter <= maximum, "MODEL_POLICY_DENIED", 403);
  }
  requireValue(value.stop === undefined || value.stop === null || typeof value.stop === "string" && value.stop.length <= 256
    || Array.isArray(value.stop) && value.stop.length <= 4 && value.stop.every(item => typeof item === "string" && item.length <= 256), "MODEL_POLICY_DENIED", 403);
  requireValue(value.prompt_cache_key === undefined || typeof value.prompt_cache_key === "string" && value.prompt_cache_key.length <= 128, "MODEL_POLICY_DENIED", 403);
  requireValue(Array.isArray(value.messages) && value.messages.length > 0 && value.messages.length <= 32, "MODEL_MESSAGES_DENIED", 403);
  const messages: Record<string, unknown>[] = [];
  for (const entry of value.messages) {
    requireValue(entry && typeof entry === "object" && !Array.isArray(entry), "MODEL_MESSAGES_DENIED", 403);
    const message = entry as Record<string, unknown>;
    requireValue(Object.keys(message).every(key => ["role", "content", "name"].includes(key) || key === "reasoning_content" && message.role === "assistant" && typeof message.reasoning_content === "string" && new TextEncoder().encode(message.reasoning_content).byteLength <= 64 * 1024)
      && ["system", "developer", "user", "assistant"].includes(String(message.role)), "MODEL_MESSAGES_DENIED", 403);
    requireValue(typeof message.content === "string" || Array.isArray(message.content) && message.content.every(part => part && typeof part === "object" && Object.keys(part).every(key => ["type", "text"].includes(key)) && part.type === "text" && typeof part.text === "string"), "MODEL_TEXT_ONLY", 403);
    // Pi SDK 1.0.2 replays a model's prior assistant thinking in this field.
    // It is not a proposal or an instruction: retain only the validated text
    // message when crossing the Pi-to-provider broker boundary.
    const { reasoning_content: _reasoningContent, ...textMessage } = message;
    messages.push(textMessage);
  }
  const request: Record<string, unknown> = { ...value, messages }; const requestedStream = request.stream === true;
  delete request.max_tokens; delete request.max_completion_tokens; delete request.stream_options;
  if (reasoningEffort) {
    requireValue(reasoningEffort === workersAiReasoningEffort(model), "MODEL_ROUTE_UNCONFIGURED", 503);
    delete request.prompt_cache_key; request.reasoning_effort = reasoningEffort;
  }
  // Internal reservation units are not a provider-dollar cap. The broker
  // bounds request bytes; Pi's context-window metadata is not a token fence.
  // Operators must review provider pricing separately before paid runs.
  const maximum = reasoningEffort && outputField === "max_completion_tokens" ? 8192 : 4096;
  request[outputField] = Math.min(Number(tokens), maximum); request.stream = false; request.store = false;
  return { request, requestedStream };
}

/** The model is passed as the first binding argument; only supported fields enter the second. */
export function workersAiBindingInput(request: Record<string, unknown>): Omit<ChatCompletionsInput, "reasoning_effort" | "chat_template_kwargs"> & { reasoning_effort: "none" | "low" } {
  const model = workersAiModel(String(request.model));
  const reasoningEffort = workersAiReasoningEffort(model);
  requireValue(request.reasoning_effort === reasoningEffort
    && Number.isSafeInteger(request.max_completion_tokens) && Number(request.max_completion_tokens) > 0 && Number(request.max_completion_tokens) <= 8192
    && request.store === false && request.stream === false, "MODEL_ROUTE_UNCONFIGURED", 503);
  return {
    messages: request.messages as ChatCompletionMessageParam[], max_completion_tokens: request.max_completion_tokens as number,
    reasoning_effort: reasoningEffort, stream: false, store: false,
    ...(request.temperature !== undefined ? { temperature: request.temperature as number | null } : {}),
    ...(request.top_p !== undefined ? { top_p: request.top_p as number | null } : {}),
    ...(request.presence_penalty !== undefined ? { presence_penalty: request.presence_penalty as number | null } : {}),
    ...(request.frequency_penalty !== undefined ? { frequency_penalty: request.frequency_penalty as number | null } : {}),
    ...(request.stop !== undefined ? { stop: request.stop as string | string[] | null } : {}),
  };
}

export interface WorkersAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  /** The provider reports fractional neurons; a decimal string fits the protocol's integer-only canonical JSON. */
  neurons_decimal?: string;
}

export function workersAiResponseIdentity(body: Uint8Array, model: string): { reportedModel: string; responseId: string; usage: WorkersAiUsage | null } {
  let result: unknown;
  try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { requireValue(false, "MODEL_RESPONSE_INVALID", 502); }
  requireValue(result && typeof result === "object" && !Array.isArray(result), "MODEL_RESPONSE_INVALID", 502);
  const value = result as Record<string, unknown>;
  requireValue(value.model === model && typeof value.id === "string" && value.id.length > 0
    && Array.isArray(value.choices) && value.choices.length === 1, "MODEL_RESPONSE_IDENTITY_MISMATCH", 502);
  const choice = value.choices[0] as Record<string, unknown>;
  requireValue(choice && typeof choice === "object" && !Array.isArray(choice)
    && choice.message && typeof choice.message === "object" && !Array.isArray(choice.message)
    && (choice.message as Record<string, unknown>).role === "assistant"
    && typeof (choice.message as Record<string, unknown>).content === "string", "MODEL_RESPONSE_INVALID", 502);
  if (value.usage === undefined || value.usage === null) return { reportedModel: value.model as string, responseId: value.id as string, usage: null };
  requireValue(value.usage && typeof value.usage === "object" && !Array.isArray(value.usage), "MODEL_USAGE_INVALID", 502);
  const usage = value.usage as Record<string, unknown>;
  requireValue(["prompt_tokens", "completion_tokens", "total_tokens"].every(key => Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0), "MODEL_USAGE_INVALID", 502);
  const summary: WorkersAiUsage = {
    prompt_tokens: usage.prompt_tokens as number,
    completion_tokens: usage.completion_tokens as number,
    total_tokens: usage.total_tokens as number,
  };
  if (usage.prompt_tokens_details !== undefined && usage.prompt_tokens_details !== null) {
    requireValue(typeof usage.prompt_tokens_details === "object" && !Array.isArray(usage.prompt_tokens_details), "MODEL_USAGE_INVALID", 502);
    const details = usage.prompt_tokens_details as Record<string, unknown>;
    if (details.cached_tokens !== undefined) {
      requireValue(Number.isSafeInteger(details.cached_tokens) && Number(details.cached_tokens) >= 0, "MODEL_USAGE_INVALID", 502);
      summary.prompt_tokens_details = { cached_tokens: details.cached_tokens as number };
    }
  }
  if (usage.neurons !== undefined && usage.neurons !== null) {
    requireValue(typeof usage.neurons === "number" && Number.isFinite(usage.neurons) && usage.neurons >= 0, "MODEL_USAGE_INVALID", 502);
    summary.neurons_decimal = String(usage.neurons);
  }
  return { reportedModel: value.model as string, responseId: value.id as string, usage: summary };
}
