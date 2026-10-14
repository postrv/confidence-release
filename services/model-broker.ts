import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { hashBytes } from './crypto.ts';
import { boundedResponse } from './http-bounds.ts';
import { modelDispatchTimeoutMs, normalizeModelRequest, WORKERS_AI_CODING_MODEL, WORKERS_AI_LEGACY_CODING_MODEL, workersAiReasoningEffort } from '../workers/runner/model-policy.ts';
export interface ModelObservation { requestDigest: string; responseDigest?: string; model: string; time: string; outcome: string; requestBytes: number; responseBytes?: number; durationMs?: number; finishReason?: string; assistantTextCharacters?: number; reasoningCharacters?: number; usage?: { promptTokens: number; completionTokens: number; totalTokens: number; neurons?: number }; }
export async function createModelBroker(onObservation: (observation: ModelObservation) => void): Promise<{ url: string; token: string; model: string; close: () => Promise<void> }> {
  const key = process.env.OPENAI_API_KEY, model = process.env.PI_MODEL, base = process.env.PI_MODEL_BASE_URL;
  if (!key || !model || !base) throw new Error('Pi requires explicit PI_MODEL, PI_MODEL_BASE_URL and host OPENAI_API_KEY');
  const outputField = process.env.PI_MODEL_OUTPUT_TOKEN_FIELD ?? 'max_tokens';
  if (outputField !== 'max_tokens' && outputField !== 'max_completion_tokens') throw new Error('Model output token field must be explicitly supported');
  const reasoningEffort = process.env.PI_MODEL_REASONING_EFFORT;
  if (reasoningEffort && !['none', 'low', 'high', 'max'].includes(reasoningEffort)) throw new Error('Model reasoning effort must be explicitly supported');
  const destination = new URL(base.replace(/\/$/, '') + '/chat/completions');
  if (destination.protocol !== 'https:' || destination.username || destination.password || destination.search || destination.hash) throw new Error('Model endpoint must be an explicit HTTPS API base');
  const workersAi = destination.hostname === 'api.cloudflare.com' && !destination.port
    && /^\/client\/v4\/accounts\/[a-f0-9]{32}\/ai\/v1\/chat\/completions$/.test(destination.pathname)
    && [WORKERS_AI_CODING_MODEL, WORKERS_AI_LEGACY_CODING_MODEL].includes(model);
  if (workersAi && (outputField !== 'max_completion_tokens' || reasoningEffort !== workersAiReasoningEffort(model))) throw new Error('Cloudflare model route requires the matching completion-token field and reasoning effort');
  if (reasoningEffort === 'none' && !workersAi) throw new Error('Model reasoning effort must be explicitly supported');
  const token = randomBytes(32).toString('hex'); let requests = 0, revoked = false;
  const server = http.createServer(async (req, res) => {
    try {
      if (revoked || req.method !== 'POST' || req.url !== '/v1/chat/completions' || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
      if (++requests > 4) { res.writeHead(429).end('Attempt model request budget exhausted'); return; }
      let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 192 * 1024) throw new Error('Model request exceeds reserved input'); }
      let body = JSON.parse(raw);
      if (workersAi) {
        // Share the production text-only recipe, including bounded assistant
        // reasoning removal, for an explicitly configured Workers AI endpoint.
        body = normalizeModelRequest(body, model, outputField, workersAiReasoningEffort(model)).request;
      } else {
        if (body.model !== model) throw new Error('Model outside reserved route');
        if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) throw new Error('Model output token fields are ambiguous');
        const requestedTokens = body.max_tokens ?? body.max_completion_tokens ?? 4096;
        if (!Number.isSafeInteger(requestedTokens) || requestedTokens <= 0) throw new Error('Positive integer model output reservation required');
        delete body.max_tokens; delete body.max_completion_tokens; body[outputField] = Math.min(requestedTokens, 4096);
        delete body.stream_options; body.stream = false;
        if (reasoningEffort) body.reasoning_effort = reasoningEffort;
      }
      const actual = JSON.stringify(body), start = new Date().toISOString(), startedMs = Date.now();
      const upstream = await fetch(destination, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: actual, signal: AbortSignal.timeout(modelDispatchTimeoutMs(workersAi ? 'workers-ai' : 'openai-compatible')) });
      const bytes = Buffer.from(await boundedResponse(upstream, 512 * 1024));
      let result: any;
      if (upstream.ok) try { result = JSON.parse(bytes.toString()); } catch { /* Preserve provider response; Pi reports malformed completion. */ }
      const usage = result?.usage;
      const choice = result?.choices?.[0], message = choice?.message;
      const completeUsage = usage && ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(name => Number.isSafeInteger(usage[name]) && usage[name] >= 0);
      onObservation({ requestDigest: hashBytes(actual), responseDigest: hashBytes(bytes), model, time: start, outcome: upstream.ok ? 'RESPONSE' : `HTTP_${upstream.status}`, requestBytes: Buffer.byteLength(actual), responseBytes: bytes.length, durationMs: Date.now() - startedMs,
        ...(typeof choice?.finish_reason === 'string' ? { finishReason: choice.finish_reason } : {}),
        ...(typeof message?.content === 'string' ? { assistantTextCharacters: message.content.length } : {}),
        ...(typeof message?.reasoning_content === 'string' ? { reasoningCharacters: message.reasoning_content.length } : {}),
        ...(completeUsage ? { usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens,
          ...(Number.isSafeInteger(usage.neurons) && usage.neurons >= 0 ? { neurons: usage.neurons } : {}) } } : {}) });
      if (!upstream.ok) { res.writeHead(502).end('Configured model provider rejected the request'); return; }
      // Pi's OpenAI-completions adapter requests SSE; emit the bounded full response
      // as one content/tool-call chunk without forwarding provider headers.
      if (JSON.parse(raw).stream) {
        result ??= JSON.parse(bytes.toString());
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunks = result.choices.map((choice: any) => ({ ...choice, delta: choice.message, message: undefined }));
        res.end(`data: ${JSON.stringify({ ...result, object: 'chat.completion.chunk', choices: chunks })}\n\ndata: [DONE]\n\n`);
      } else { res.writeHead(200, { 'content-type': 'application/json' }).end(bytes); }
    } catch (error) { res.writeHead(502).end('Model broker could not complete the configured request'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as any).port}/v1`, token, model, close: () => { revoked = true; return new Promise(resolve => server.close(() => resolve())); } };
}
