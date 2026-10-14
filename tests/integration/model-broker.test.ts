import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createModelBroker, type ModelObservation } from '../../services/model-broker.ts';
import { hashBytes } from '../../services/crypto.ts';

const glm = '@cf/zai-org/glm-5.3', deepseek = '@cf/deepseek-ai/deepseek-v4-flash-0731';
const cloudflare = `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/v1`;
const secret = 'owned-provider-secret-canary';
type Broker = Awaited<ReturnType<typeof createModelBroker>>;
function configure(t: TestContext, changes: Record<string, string | undefined> = {}) {
  const values = { OPENAI_API_KEY: secret, PI_MODEL: glm, PI_MODEL_BASE_URL: cloudflare,
    PI_MODEL_OUTPUT_TOKEN_FIELD: 'max_completion_tokens', PI_MODEL_REASONING_EFFORT: 'low', ...changes };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
}
function request(broker: Broker, body: unknown, authorization = `Bearer ${broker.token}`, path = '/chat/completions', method = 'POST'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${broker.url}${path}`, { method, agent: false, headers: { authorization, 'content-type': 'application/json' } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', bytes => body += bytes);
      res.once('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.once('error', reject); req.end(method === 'GET' ? undefined : JSON.stringify(body));
  });
}
const input = (model = glm, additions = {}) => ({ model, messages: [{ role: 'user', content: 'Reply OK' }], max_completion_tokens: 9000, ...additions });
function provider(t: TestContext) {
  const calls: { destination: string; body: Record<string, any>; signal: AbortSignal | null | undefined }[] = [], timeouts: number[] = [];
  const signal = new AbortController().signal;
  t.mock.method(AbortSignal, 'timeout', (duration: number) => { timeouts.push(duration); return signal; });
  t.mock.method(globalThis, 'fetch', async (destination: unknown, options: RequestInit) => {
    assert.deepEqual(options.headers, { authorization: `Bearer ${secret}`, 'content-type': 'application/json' });
    assert.equal(options.redirect, 'error'); assert.equal(options.signal, signal);
    const body = JSON.parse(String(options.body)); calls.push({ destination: String(destination), body, signal: options.signal });
    return Response.json({ id: 'owned-completion', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 } });
  });
  return { calls, timeouts };
}

for (const [model, effort] of [[glm, 'low'], [deepseek, 'none']] as const) {
  test(`local ${model} route preserves production output, deadline and continuation policy`, async t => {
    configure(t, { PI_MODEL: model, PI_MODEL_REASONING_EFFORT: effort });
    const { calls, timeouts } = provider(t), observations: ModelObservation[] = [];
    const broker = await createModelBroker(value => observations.push(value)); t.after(() => broker.close());
    const response = await request(broker, input(model, { stream: true, stream_options: { include_usage: true }, prompt_cache_key: 'sdk-key',
      messages: [{ role: 'user', content: 'Reply OK' }, { role: 'assistant', content: 'Earlier text', reasoning_content: 'private reasoning canary' }, { role: 'user', content: 'Continue' }] }));
    assert.equal(response.status, 200); assert.match(response.body, /data: \[DONE\]/);
    assert.equal(calls[0]!.destination, `${cloudflare}/chat/completions`);
    assert.equal(calls[0]!.body.max_completion_tokens, 8192); assert.equal(calls[0]!.body.max_tokens, undefined);
    assert.equal(calls[0]!.body.reasoning_effort, effort); assert.equal(calls[0]!.body.stream, false); assert.equal(calls[0]!.body.store, false);
    assert.equal(calls[0]!.body.stream_options, undefined); assert.equal(calls[0]!.body.prompt_cache_key, undefined);
    assert.deepEqual(calls[0]!.body.messages[1], { role: 'assistant', content: 'Earlier text' });
    assert.deepEqual(timeouts, [240000]); assert.equal(observations[0]!.requestDigest, hashBytes(JSON.stringify(calls[0]!.body)));
    assert.doesNotMatch(JSON.stringify(observations), /private reasoning canary|owned-provider-secret-canary/);
    assert.equal((await request(broker, input(model, { max_completion_tokens: 1200 }))).status, 200);
    assert.equal(calls[1]!.body.max_completion_tokens, 1200);
  });
}

test('expanded Cloudflare limits require exact endpoint and selected model; generic routes retain their budget', async t => {
  for (const [label, base, model, effort] of [
    ['generic', 'https://owned-model.test/v1', 'owned-model', 'high'],
    ['foreign host', 'https://api.cloudflare.com.owned.test/client/v4/accounts/' + 'a'.repeat(32) + '/ai/v1', glm, 'low'],
    ['wrong path', 'https://api.cloudflare.com/ai/v1', glm, 'low'],
    ['alternate port', cloudflare.replace('api.cloudflare.com', 'api.cloudflare.com:444'), glm, 'low'],
    ['unregistered model', cloudflare, '@cf/owned-unregistered', 'low'],
  ]) await t.test(label!, async child => {
    configure(child, { PI_MODEL_BASE_URL: base, PI_MODEL: model, PI_MODEL_REASONING_EFFORT: effort });
    const { calls, timeouts } = provider(child), broker = await createModelBroker(() => {}); child.after(() => broker.close());
    assert.equal((await request(broker, input(model))).status, 200);
    assert.equal(calls[0]!.body.max_completion_tokens, 4096); assert.deepEqual(timeouts, [90000]);
    assert.equal(calls[0]!.body.reasoning_effort, effort);
  });
});

test('selected Cloudflare routes reject missing or mismatched configuration before starting a broker', async t => {
  for (const changes of [
    { PI_MODEL_REASONING_EFFORT: undefined }, { PI_MODEL_REASONING_EFFORT: 'high' },
    { PI_MODEL_OUTPUT_TOKEN_FIELD: 'max_tokens' }, { PI_MODEL: deepseek, PI_MODEL_REASONING_EFFORT: 'low' },
  ]) await t.test(JSON.stringify(changes), async child => {
    configure(child, changes); const { calls } = provider(child);
    await assert.rejects(createModelBroker(() => {}), /matching completion-token field and reasoning effort/);
    assert.equal(calls.length, 0);
  });
});

test('authorization and the four-request limit still fence provider dispatch', async t => {
  configure(t); const { calls } = provider(t), broker = await createModelBroker(() => {}); t.after(() => broker.close());
  assert.equal((await request(broker, input(), 'Bearer wrong')).status, 403);
  assert.equal((await request(broker, input(), `Bearer ${broker.token}`, '/other')).status, 403);
  assert.equal((await request(broker, input(), `Bearer ${broker.token}`, '/chat/completions', 'GET')).status, 403);
  for (let index = 0; index < 4; index++) assert.equal((await request(broker, input())).status, 200);
  assert.equal((await request(broker, input())).status, 429); assert.equal(calls.length, 4);
});

test('malformed or oversized reasoning and ambiguous tokens cannot reach Cloudflare', async t => {
  configure(t); const { calls } = provider(t), broker = await createModelBroker(() => {}); t.after(() => broker.close());
  for (const body of [
    input(glm, { messages: [{ role: 'user', content: 'OK', reasoning_content: 'not assistant history' }] }),
    input(glm, { messages: [{ role: 'assistant', content: 'OK', reasoning_content: 'x'.repeat(65537) }] }),
    input(glm, { max_tokens: 100 }), input('outside-route'),
  ]) assert.equal((await request(broker, body)).status, 502);
  assert.equal(calls.length, 0);
});

test('Cloudflare dispatch aborts at the selected deadline without exposing provider errors', async t => {
  configure(t); let timeout = 0, calls = 0;
  t.mock.method(AbortSignal, 'timeout', (duration: number) => { timeout = duration; return AbortSignal.abort(new Error(secret)); });
  t.mock.method(globalThis, 'fetch', async (_destination: unknown, options: RequestInit) => { calls++; options.signal!.throwIfAborted(); throw new Error('Expected an aborted dispatch'); });
  const observations: ModelObservation[] = [], broker = await createModelBroker(value => observations.push(value)); t.after(() => broker.close());
  const response = await request(broker, input());
  assert.equal(response.status, 502); assert.equal(timeout, 240000); assert.equal(calls, 1);
  assert.doesNotMatch(response.body, /owned-provider-secret-canary/); assert.deepEqual(observations, []);
});
