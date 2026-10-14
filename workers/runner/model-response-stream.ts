// SPDX-License-Identifier: Apache-2.0
import { requireValue } from "../shared/errors";

export const MODEL_RESPONSE_BYTES = 512 * 1024;
export const MODEL_HEARTBEAT_MS = 10_000;
const encoder = new TextEncoder();
const heartbeat = encoder.encode(": model-pending\n\n");
const failure = encoder.encode('data: {"error":{"code":"MODEL_STREAM_FAILED","message":"MODEL_STREAM_FAILED"}}\n\n');
export type ModelTermination = "client-disconnected" | "consumer-cancelled" | "deadline" | null;

/** One cancellation scope covers dispatch, response consumption and retention. */
export function modelResponseLifetime(requestSignal: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  let termination: ModelTermination = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => { clearTimeout(timer); requestSignal.removeEventListener("abort", disconnected); };
  const abort = (reason: Exclude<ModelTermination, null>) => {
    if (controller.signal.aborted) return;
    termination = reason;
    dispose();
    controller.abort(new DOMException(reason === "deadline" ? "MODEL_DEADLINE_EXCEEDED" : "MODEL_REQUEST_ABORTED", reason === "deadline" ? "TimeoutError" : "AbortError"));
  };
  const disconnected = () => abort("client-disconnected");
  if (requestSignal.aborted) disconnected();
  else {
    requestSignal.addEventListener("abort", disconnected, { once: true });
    timer = setTimeout(() => abort("deadline"), timeoutMs);
  }
  return { signal: controller.signal, abort, dispose, get termination() { return termination; } };
}
export type ModelResponseLifetime = ReturnType<typeof modelResponseLifetime>;

/** Bound local waiting even when an upstream ignores cancellation. Late RPC
 * effects remain unknown; this never authorizes a retry or releases its cost. */
export async function untilModelAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancelled!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { cancelled = () => reject(signal.reason); });
  signal.addEventListener("abort", cancelled, { once: true });
  try {
    // The race observes late rejection; every effect after an await in the
    // producer must still check the same signal before proceeding.
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), aborted]);
  } finally { signal.removeEventListener("abort", cancelled); }
}

/** Cancel the reader explicitly as well as the dispatch signal on disconnect. */
export async function readModelResponse(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    // Cancellation is best effort: some response streams never settle their
    // cancel promise. Its rejection is observed, but cannot extend our bound.
    void reader.cancel("MODEL_REQUEST_ABORTED").catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await untilModelAbort(() => reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MODEL_RESPONSE_BYTES) { cancel(); requireValue(false, "SIZE_LIMIT", 413); }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** The only completion is a fully validated, retained provider response. */
export function retainedModelCompletion(body: Uint8Array): Uint8Array {
  requireValue(body.byteLength <= MODEL_RESPONSE_BYTES, "SIZE_LIMIT", 413);
  const result = JSON.parse(new TextDecoder().decode(body)) as { choices: { message: unknown; [key: string]: unknown }[]; [key: string]: unknown };
  const choices = result.choices.map(({ message, ...choice }) => ({ ...choice, delta: message }));
  const bytes = encoder.encode(`data: ${JSON.stringify({ ...result, object: "chat.completion.chunk", choices })}\n\ndata: [DONE]\n\n`);
  requireValue(bytes.byteLength <= MODEL_RESPONSE_BYTES * 2, "SIZE_LIMIT", 413);
  return bytes;
}

export function modelResponseStream(options: {
  lifetime: ModelResponseLifetime;
  produce: (signal: AbortSignal) => Promise<Uint8Array>;
  onFailure: (error: unknown, termination: ModelTermination) => void;
  heartbeatMs?: number;
}): { response: Response; completion: Promise<void> } {
  const { lifetime } = options;
  let open = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const finishFailure = () => {
    if (!open) return;
    open = false;
    // A standard OpenAI error event makes the pinned SDK fail, never accept an
    // empty successful turn. There is deliberately no completion or DONE here.
    controller.enqueue(failure);
    controller.close();
  };
  const aborted = () => { clearInterval(timer); finishFailure(); };
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      controller.enqueue(heartbeat);
      lifetime.signal.addEventListener("abort", aborted, { once: true });
      if (lifetime.signal.aborted) aborted();
      else timer = setInterval(() => {
        // Slow consumers never accumulate heartbeat packets. At most one
        // comment plus one bounded terminal packet can be queued.
        if (open && (controller.desiredSize ?? 0) > 0) controller.enqueue(heartbeat);
      }, options.heartbeatMs ?? MODEL_HEARTBEAT_MS);
    },
    cancel() { open = false; clearInterval(timer); lifetime.abort("consumer-cancelled"); },
  }, { highWaterMark: heartbeat.byteLength, size: chunk => chunk.byteLength });
  const completion = (async () => {
    try {
      lifetime.signal.throwIfAborted();
      const retained = await untilModelAbort(() => options.produce(lifetime.signal), lifetime.signal);
      lifetime.signal.throwIfAborted();
      const packet = retainedModelCompletion(retained);
      if (open) { controller.enqueue(packet); open = false; controller.close(); }
    } catch (error) {
      finishFailure();
      options.onFailure(error, lifetime.termination);
    } finally {
      clearInterval(timer);
      lifetime.signal.removeEventListener("abort", aborted);
      lifetime.dispose();
    }
  })();
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } }),
    completion,
  };
}
